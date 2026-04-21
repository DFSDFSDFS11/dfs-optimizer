/**
 * V35 Optimizer — Sequential marginal payout maximization.
 *
 * Greedy algorithm: at each step, pick the candidate lineup that adds the most
 * expected payout to the portfolio, accounting for how it ranks against the field
 * and how it interacts with existing portfolio lineups.
 *
 * Critical optimizations:
 *   - Pre-compute ALL lineup scores across ALL worlds as Float32Array
 *   - Pre-sort field scores per world once
 *   - Binary search for rank lookup
 *   - Coarse-to-fine: 500 worlds for all candidates -> top 200 -> full 3000 worlds
 *   - Incremental portfolio tracking
 */

import { Lineup, Player } from '../types';
import { PayoutModel, findRank, getPayoutAtRank, buildPayoutModel } from './payout';
import { SimulationResult } from './simulation';
import { FieldSample } from './field-sampler';

// ============================================================
// PRE-COMPUTATION
// ============================================================

export interface PrecomputedData {
  /** candidateScores[c * numWorlds + w] = score of candidate c in world w */
  candidateScores: Float32Array;
  /** fieldSortedPerWorld[w] = Float64Array of field scores in world w, sorted descending */
  fieldSortedPerWorld: Float64Array[];
  numCandidates: number;
  numWorlds: number;
  payoutModel: PayoutModel;
}

/**
 * Pre-compute all lineup scores across all worlds and sort field scores per world.
 */
export function precompute(
  candidates: Lineup[],
  pool: Lineup[],         // Full SS pool (field is sampled from this)
  fieldSample: FieldSample,
  sim: SimulationResult,
  playerIndexMap: Map<string, number>,
  fieldSize: number = 8000,
  entryFee: number = 20,
): PrecomputedData {
  const numCandidates = candidates.length;
  const numWorlds = sim.numWorlds;

  console.log(`  Pre-computing ${numCandidates} candidates x ${numWorlds} worlds...`);

  // Score each candidate in each world
  const candidateScores = new Float32Array(numCandidates * numWorlds);
  for (let c = 0; c < numCandidates; c++) {
    const lu = candidates[c];
    for (let w = 0; w < numWorlds; w++) {
      let score = 0;
      for (const p of lu.players) {
        const idx = playerIndexMap.get(p.id);
        if (idx !== undefined) {
          score += sim.scores[idx * numWorlds + w];
        } else {
          score += p.projection; // Fallback
        }
      }
      candidateScores[c * numWorlds + w] = score;
    }
  }

  // Score each field lineup in each world and sort per world
  console.log(`  Pre-computing field scores (${fieldSample.size} entries x ${numWorlds} worlds)...`);
  const fieldSortedPerWorld: Float64Array[] = new Array(numWorlds);

  for (let w = 0; w < numWorlds; w++) {
    const fieldScores = new Float64Array(fieldSample.size);
    for (let f = 0; f < fieldSample.size; f++) {
      const poolIdx = fieldSample.indices[f];
      const lu = pool[poolIdx];
      let score = 0;
      for (const p of lu.players) {
        const idx = playerIndexMap.get(p.id);
        if (idx !== undefined) {
          score += sim.scores[idx * numWorlds + w];
        } else {
          score += p.projection;
        }
      }
      fieldScores[f] = score;
    }
    // Sort descending
    fieldScores.sort();
    // Reverse for descending
    for (let i = 0, j = fieldScores.length - 1; i < j; i++, j--) {
      const tmp = fieldScores[i];
      fieldScores[i] = fieldScores[j];
      fieldScores[j] = tmp;
    }
    fieldSortedPerWorld[w] = fieldScores;
  }

  const payoutModel = buildPayoutModel(fieldSize, entryFee);

  console.log(`  Pre-computation done.`);
  return { candidateScores, fieldSortedPerWorld, numCandidates, numWorlds, payoutModel };
}

// ============================================================
// MARGINAL PAYOUT COMPUTATION
// ============================================================

/**
 * Compute the marginal payout of adding a candidate to the portfolio.
 *
 * For each world:
 *   - Current best portfolio payout = sum of payouts of existing portfolio lineups
 *   - Adding candidate: if candidate ranks better than some existing lineups,
 *     compute the additional payout from the new lineup
 *
 * Optimization: We track the portfolio's per-world payouts incrementally.
 * The marginal payout of adding candidate c is:
 *   sum_w [payout(candidate_c, world_w)] / numWorlds
 * because each lineup's payout is independent in our model (no prize splitting within portfolio).
 *
 * Actually: each lineup competes independently against the field. The portfolio's
 * total payout is the sum of individual lineup payouts. So marginal = avg payout of the new lineup.
 * The interaction comes from: we want DIVERSE lineups (low correlation) so that
 * different lineups hit in different worlds, maximizing total expected payout.
 */
function computeMarginalPayout(
  candidateIdx: number,
  data: PrecomputedData,
  worldSubset: Int32Array | null, // null = use all worlds
): number {
  const { candidateScores, fieldSortedPerWorld, numWorlds, payoutModel } = data;
  const worlds = worldSubset || null;
  const nW = worlds ? worlds.length : numWorlds;

  let totalPayout = 0;
  for (let wi = 0; wi < nW; wi++) {
    const w = worlds ? worlds[wi] : wi;
    const score = candidateScores[candidateIdx * numWorlds + w];
    const rank = findRank(score, fieldSortedPerWorld[w]);
    totalPayout += getPayoutAtRank(rank, payoutModel);
  }

  return totalPayout / nW;
}

// ============================================================
// MAIN OPTIMIZER
// ============================================================

export interface V35OptimizerParams {
  maxExposure?: number;       // Default 0.40
  maxTeamStackPct?: number;   // Default 0.10
  targetCount?: number;       // Default 150
  coarseWorlds?: number;      // Default 500
  fineTopK?: number;          // Default 200
}

export interface V35Result {
  portfolio: Lineup[];
  totalExpectedPayout: number;
  selectionTimeMs: number;
}

/**
 * Run the sequential marginal payout maximization algorithm.
 */
export function optimize(
  candidates: Lineup[],
  data: PrecomputedData,
  params: V35OptimizerParams = {},
): V35Result {
  const {
    maxExposure = 0.40,
    maxTeamStackPct = 0.10,
    targetCount = 150,
    coarseWorlds = 500,
    fineTopK = 200,
  } = params;

  const startTime = Date.now();
  const numCandidates = data.numCandidates;
  const numWorlds = data.numWorlds;

  const maxPlayerCount = Math.ceil(maxExposure * targetCount);
  const maxTeamStackCount = Math.ceil(maxTeamStackPct * targetCount);

  // Build coarse world subset (evenly spaced)
  const coarseWorldIndices = new Int32Array(Math.min(coarseWorlds, numWorlds));
  const step = numWorlds / coarseWorldIndices.length;
  for (let i = 0; i < coarseWorldIndices.length; i++) {
    coarseWorldIndices[i] = Math.floor(i * step);
  }

  // Compute projection stats for ownership-gating filter
  const projections = candidates.map(c => c.projection).sort((a, b) => a - b);
  const medianProjection = projections[Math.floor(projections.length / 2)];
  const maxProjection = projections[projections.length - 1];

  // Compute anchor-relative ownership target
  const sortedByProj = [...candidates].sort((a, b) => b.projection - a.projection);
  const top50 = sortedByProj.slice(0, Math.min(50, candidates.length));
  const anchorOwn = top50.reduce((s, l) => s + l.players.reduce((s2, p) => s2 + (p.ownership || 0), 0) / l.players.length, 0) / top50.length;
  const targetAvgOwn = anchorOwn - 6.0; // empirical calibration: winners land 6pp below anchor
  console.log(`  Median projection: ${medianProjection.toFixed(1)}, anchor ownership: ${anchorOwn.toFixed(1)}%, target portfolio avg: ${targetAvgOwn.toFixed(1)}%`);
  console.log(`  Ownership ceiling: ${targetAvgOwn.toFixed(1)}% at median proj (${medianProjection.toFixed(1)}) → ${anchorOwn.toFixed(1)}% at max proj (${maxProjection.toFixed(1)})`);

  // Tracking
  const portfolio: Lineup[] = [];
  const selectedSet = new Set<number>();
  const playerExposure = new Map<string, number>();
  const teamStackCount = new Map<string, number>();
  let runningOwnSum = 0;

  console.log(`  V35 optimizer: ${numCandidates} candidates, ${targetCount} to select`);

  for (let step = 0; step < targetCount; step++) {
    // Phase 1: Coarse evaluation on all eligible candidates
    const coarseCandidates: { idx: number; payout: number }[] = [];

    for (let c = 0; c < numCandidates; c++) {
      if (selectedSet.has(c)) continue;

      // Check exposure constraints
      const lu = candidates[c];
      let eligible = true;
      for (const p of lu.players) {
        if ((playerExposure.get(p.id) || 0) >= maxPlayerCount) {
          eligible = false;
          break;
        }
      }
      if (!eligible) continue;

      // Check team stack constraint
      const teamCounts = new Map<string, number>();
      for (const p of lu.players) {
        if (!p.positions?.includes('P')) {
          teamCounts.set(p.team, (teamCounts.get(p.team) || 0) + 1);
        }
      }
      let stackOk = true;
      for (const [team, cnt] of teamCounts) {
        if (cnt >= 4 && (teamStackCount.get(team) || 0) >= maxTeamStackCount) {
          stackOk = false;
          break;
        }
      }
      if (!stackOk) continue;

      // Filter: ownership should scale with projection. A lineup near the top
      // of the pool can afford high ownership; a below-median lineup must be contrarian.
      // Linear scale: at maxProjection, allow up to anchorOwn; at medianProjection, allow targetAvgOwn.
      const candOwn = lu.players.reduce((s, p) => s + (p.ownership || 0), 0) / lu.players.length;
      const projFrac = Math.min(1, Math.max(0, (lu.projection - medianProjection) / (maxProjection - medianProjection)));
      const ownCeiling = targetAvgOwn + 3.0 + projFrac * (anchorOwn - targetAvgOwn);
      if (candOwn > ownCeiling) continue;

      let payout = computeMarginalPayout(c, data, coarseWorldIndices);

      // Anchor-relative ownership steering (soft, not hard filter)
      // After first 30 entries, gently steer portfolio avg ownership toward target
      if (step >= 30) {
        const currentAvg = step > 0 ? runningOwnSum / step : anchorOwn;
        const newAvg = (runningOwnSum + candOwn) / (step + 1);
        const currentDist = Math.abs(currentAvg - targetAvgOwn);
        const newDist = Math.abs(newAvg - targetAvgOwn);
        // Bonus if candidate moves avg closer to target, penalty if away
        if (newDist < currentDist) {
          payout *= 1.0 + (currentDist - newDist) * 0.02; // gentle bonus
        } else if (newDist > currentDist + 1.0) {
          payout *= 0.95; // mild penalty for drifting >1pp further from target
        }
      }

      coarseCandidates.push({ idx: c, payout });
    }

    if (coarseCandidates.length === 0) {
      console.log(`  Step ${step + 1}: no eligible candidates remaining`);
      break;
    }

    // Phase 2: Fine evaluation on top K candidates
    coarseCandidates.sort((a, b) => b.payout - a.payout);
    const topK = coarseCandidates.slice(0, Math.min(fineTopK, coarseCandidates.length));

    let bestIdx = -1;
    let bestPayout = -Infinity;

    for (const { idx } of topK) {
      const payout = computeMarginalPayout(idx, data, null); // All worlds
      if (payout > bestPayout) {
        bestPayout = payout;
        bestIdx = idx;
      }
    }

    if (bestIdx === -1) break;

    // Add to portfolio
    const selectedLu = candidates[bestIdx];
    portfolio.push(selectedLu);
    selectedSet.add(bestIdx);

    // Update exposure + ownership tracking
    for (const p of selectedLu.players) {
      playerExposure.set(p.id, (playerExposure.get(p.id) || 0) + 1);
    }
    runningOwnSum += selectedLu.players.reduce((s, p) => s + (p.ownership || 0), 0) / selectedLu.players.length;

    // Update team stack tracking
    const teamCounts = new Map<string, number>();
    for (const p of selectedLu.players) {
      if (!p.positions?.includes('P')) {
        teamCounts.set(p.team, (teamCounts.get(p.team) || 0) + 1);
      }
    }
    for (const [team, cnt] of teamCounts) {
      if (cnt >= 4) {
        teamStackCount.set(team, (teamStackCount.get(team) || 0) + 1);
      }
    }

    if ((step + 1) % 25 === 0 || step === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`    Step ${step + 1}/${targetCount}: selected lineup with EV=$${bestPayout.toFixed(2)}, ${coarseCandidates.length} eligible, ${elapsed}s elapsed`);
    }
  }

  const totalExpectedPayout = portfolio.reduce((sum, _lu, i) => {
    const idx = [...selectedSet][i];
    return sum + computeMarginalPayout(idx, data, null);
  }, 0);

  const selectionTimeMs = Date.now() - startTime;
  console.log(`  V35 selection done: ${portfolio.length} lineups in ${(selectionTimeMs / 1000).toFixed(1)}s`);

  return { portfolio, totalExpectedPayout, selectionTimeMs };
}
