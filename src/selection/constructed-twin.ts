/**
 * Constructed Evil Twin — Liu et al. Section 5.3 (full implementation).
 *
 * Instead of searching the pool for low-correlation lineups, CONSTRUCTS twins
 * by flipping the primary stack to the opposing team with pitcher inversion.
 *
 * Two-layer anti-correlation:
 *   1. Game-factor flip: primary stacks team A → twin stacks team B (opponent)
 *   2. Pitcher inversion: twin uses a pitcher from a DIFFERENT game than primary,
 *      OR uses the opposing pitcher from the primary's stack game
 *
 * Portfolio-aware: each twin is scored against ALL previously constructed twins
 * to prevent twin-to-twin clustering.
 *
 * Replaces the pool-search evil-twin.ts for V32+.
 */

import { Lineup, Player, ContestConfig } from '../types';
import { SlatePrecomputation } from './algorithm7-selector';
import { scoreLineups, computeMeanAndVar, pearsonRow } from '../analysis/sim/sim-core';

// ============================================================
// TYPES
// ============================================================

export interface ConstructedTwinParams {
  twinFraction: number;           // 0.25-0.40
  minProjectionRatio: number;     // twin proj ≥ X% of primary
  maxCorrelationCeiling: number;  // reject twins with ρ > this vs primary
}

export const DEFAULT_CONSTRUCTED_TWIN_PARAMS: ConstructedTwinParams = {
  twinFraction: 0.30,
  minProjectionRatio: 0.70,
  maxCorrelationCeiling: 0.10,
};

export interface ConstructedTwinDiagnostics {
  targetCount: number;
  actualCount: number;
  avgTwinCorrelation: number;
  avgTwinProjectionRatio: number;
  avgCorrelationBefore: number;
  avgCorrelationAfter: number;
  negativePairFractionBefore: number;
  negativePairFractionAfter: number;
  twinGameFlips: number;          // how many twins flipped the stack game
  twinPitcherInversions: number;  // how many swapped to opposing pitcher
}

// ============================================================
// MAIN
// ============================================================

export function applyConstructedTwins(
  portfolio: Lineup[],
  allPlayers: Player[],
  precomp: SlatePrecomputation,
  config: ContestConfig,
  params: ConstructedTwinParams = DEFAULT_CONSTRUCTED_TWIN_PARAMS,
): { portfolio: Lineup[]; diagnostics: ConstructedTwinDiagnostics } {
  const N = portfolio.length;
  const W = precomp.W;
  const targetCount = Math.floor(N * params.twinFraction);

  // Score portfolio across worlds
  const portfolioScores = scoreLineups(portfolio, precomp);
  const { means: pMeans } = computeMeanAndVar(portfolioScores, N, W);

  // Pre-compute avg correlation BEFORE
  const { avgCorr: corrBefore, negFrac: negBefore } = sampleCorr(portfolioScores, N, W, pMeans);

  // Group players by team and position
  const playersByTeam = new Map<string, Player[]>();
  const pitchers: Player[] = [];
  for (const p of allPlayers) {
    if (!playersByTeam.has(p.team)) playersByTeam.set(p.team, []);
    playersByTeam.get(p.team)!.push(p);
    if (p.positions?.includes('P') && p.projection > 5) pitchers.push(p);
  }

  // Sort portfolio entries by a proxy for "marginal gain" — use projection as tiebreaker
  // (actual marginal gains aren't passed in; projection × variance is a reasonable proxy)
  const rankedIdx = Array.from({ length: N }, (_, i) => i)
    .sort((a, b) => portfolio[b].projection - portfolio[a].projection);

  const twins: Array<{ primaryIdx: number; twin: Lineup; corrWithPrimary: number; gameFlip: boolean; pitcherInv: boolean }> = [];
  const twinScoresAll: Float32Array[] = []; // for portfolio-aware scoring
  const twinMeansAll: number[] = [];
  const usedTwinHashes = new Set<string>();

  for (const pIdx of rankedIdx) {
    if (twins.length >= targetCount) break;
    const primary = portfolio[pIdx];

    // Identify primary's stack team (largest non-pitcher group)
    const teamCounts = new Map<string, number>();
    let primaryPitcher: Player | null = null;
    for (const p of primary.players) {
      if (p.positions?.includes('P')) { primaryPitcher = p; continue; }
      teamCounts.set(p.team, (teamCounts.get(p.team) || 0) + 1);
    }
    let stackTeam = '', stackDepth = 0;
    for (const [t, c] of teamCounts) if (c > stackDepth) { stackDepth = c; stackTeam = t; }
    if (stackDepth < 3 || !stackTeam) continue;

    // Find opposing team
    const stackPlayerSample = primary.players.find(p => p.team === stackTeam);
    const oppTeam = stackPlayerSample?.opponent;
    if (!oppTeam) continue;

    // Construct twin candidates by flipping stack to oppTeam
    const oppPlayers = playersByTeam.get(oppTeam)?.filter(p => !p.positions?.includes('P')) || [];
    if (oppPlayers.length < 3) continue;

    // Try multiple twin constructions and pick best
    const candidates = constructTwinCandidates(
      primary, stackTeam, oppTeam, oppPlayers, primaryPitcher, pitchers,
      playersByTeam, config, allPlayers, params,
    );

    // Score each candidate: anti-correlation with primary + diversity from existing twins
    let bestTwin: Lineup | null = null;
    let bestScore = -Infinity;
    let bestCorr = 1;
    let bestGameFlip = false;
    let bestPitcherInv = false;

    for (const { twin, gameFlip, pitcherInv } of candidates) {
      if (usedTwinHashes.has(twin.hash)) continue;
      // Check portfolio doesn't already have this lineup
      if (portfolio.some(l => l.hash === twin.hash)) continue;

      // Score twin across worlds
      const twinScores = scoreLineups([twin], precomp);
      const { means: tMeans } = computeMeanAndVar(twinScores, 1, W);

      // Correlation with primary (inline Pearson)
      let num = 0, dA = 0, dB = 0;
      for (let w = 0; w < W; w++) {
        const a = portfolioScores[pIdx * W + w] - pMeans[pIdx];
        const b = twinScores[w] - tMeans[0];
        num += a * b; dA += a * a; dB += b * b;
      }
      const denom = Math.sqrt(dA * dB);
      const corr = denom > 1e-12 ? num / denom : 0;

      if (corr > params.maxCorrelationCeiling) continue;

      // Portfolio-aware: penalize correlation with existing twins
      let maxTwinCorr = 0;
      for (let t = 0; t < twinScoresAll.length; t++) {
        let tn = 0, tdA = 0, tdB = 0;
        for (let w = 0; w < W; w++) {
          const a = twinScores[w] - tMeans[0];
          const b = twinScoresAll[t][w] - twinMeansAll[t];
          tn += a * b; tdA += a * a; tdB += b * b;
        }
        const td = Math.sqrt(tdA * tdB);
        const tc = td > 1e-12 ? tn / td : 0;
        if (tc > maxTwinCorr) maxTwinCorr = tc;
      }

      // Combined score: anti-corr with primary (weight 1.0) - twin-twin corr (weight 0.5)
      const score = -corr - 0.5 * maxTwinCorr;

      if (score > bestScore) {
        bestScore = score;
        bestTwin = twin;
        bestCorr = corr;
        bestGameFlip = gameFlip;
        bestPitcherInv = pitcherInv;
      }
    }

    if (!bestTwin) continue;

    // Score and cache twin world scores for future portfolio-awareness
    const finalTwinScores = scoreLineups([bestTwin], precomp);
    const { means: ftMeans } = computeMeanAndVar(finalTwinScores, 1, W);
    twinScoresAll.push(finalTwinScores);
    twinMeansAll.push(ftMeans[0]);
    usedTwinHashes.add(bestTwin.hash);

    twins.push({
      primaryIdx: pIdx,
      twin: bestTwin,
      corrWithPrimary: bestCorr,
      gameFlip: bestGameFlip,
      pitcherInv: bestPitcherInv,
    });
  }

  // Replace lowest-projection entries with constructed twins
  const result = [...portfolio];
  const replaced = new Set<number>();
  const primaryIndices = new Set(twins.map(t => t.primaryIdx));

  // Sort by lowest projection to find replacement targets
  const lowestProj = Array.from({ length: N }, (_, i) => i)
    .sort((a, b) => portfolio[a].projection - portfolio[b].projection);

  let replaceIdx = 0;
  for (const twin of twins) {
    while (replaceIdx < lowestProj.length) {
      const target = lowestProj[replaceIdx];
      if (!replaced.has(target) && !primaryIndices.has(target)) {
        result[target] = twin.twin;
        replaced.add(target);
        replaceIdx++;
        break;
      }
      replaceIdx++;
    }
  }

  // Post-twinning correlation
  const afterScores = scoreLineups(result, precomp);
  const { means: afterMeans } = computeMeanAndVar(afterScores, result.length, W);
  const { avgCorr: corrAfter, negFrac: negAfter } = sampleCorr(afterScores, result.length, W, afterMeans);

  const avgTwinCorr = twins.length > 0
    ? twins.reduce((s, t) => s + t.corrWithPrimary, 0) / twins.length : 0;
  const avgTwinProjRatio = twins.length > 0
    ? twins.reduce((s, t) => s + t.twin.projection / portfolio[t.primaryIdx].projection, 0) / twins.length : 0;

  console.log(`  constructed twins: ${twins.length}/${targetCount}`);
  console.log(`    avg twin ρ with primary: ${avgTwinCorr.toFixed(3)} (target: < 0)`);
  console.log(`    game flips: ${twins.filter(t => t.gameFlip).length}  pitcher inversions: ${twins.filter(t => t.pitcherInv).length}`);
  console.log(`    avg pairwise corr: ${corrBefore.toFixed(3)} → ${corrAfter.toFixed(3)}`);
  console.log(`    negative pair %:   ${(negBefore * 100).toFixed(1)}% → ${(negAfter * 100).toFixed(1)}%`);

  return {
    portfolio: result,
    diagnostics: {
      targetCount,
      actualCount: twins.length,
      avgTwinCorrelation: avgTwinCorr,
      avgTwinProjectionRatio: avgTwinProjRatio,
      avgCorrelationBefore: corrBefore,
      avgCorrelationAfter: corrAfter,
      negativePairFractionBefore: negBefore,
      negativePairFractionAfter: negAfter,
      twinGameFlips: twins.filter(t => t.gameFlip).length,
      twinPitcherInversions: twins.filter(t => t.pitcherInv).length,
    },
  };
}

// ============================================================
// TWIN CONSTRUCTION
// ============================================================

function constructTwinCandidates(
  primary: Lineup,
  stackTeam: string,
  oppTeam: string,
  oppPlayers: Player[],
  primaryPitcher: Player | null,
  allPitchers: Player[],
  playersByTeam: Map<string, Player[]>,
  config: ContestConfig,
  allPlayers: Player[],
  params: ConstructedTwinParams,
): Array<{ twin: Lineup; gameFlip: boolean; pitcherInv: boolean }> {
  const results: Array<{ twin: Lineup; gameFlip: boolean; pitcherInv: boolean }> = [];
  const salaryCap = config.salaryCap;
  const rosterSize = config.rosterSize;

  // Sort opposing batters by projection desc
  const oppSorted = [...oppPlayers].sort((a, b) => b.projection - a.projection);

  // Pick 4-5 opposing batters (top by projection, fill different positions)
  const usedPositions = new Set<string>();
  const twinBatters: Player[] = [];
  for (const p of oppSorted) {
    if (twinBatters.length >= 5) break;
    twinBatters.push(p);
  }
  if (twinBatters.length < 3) return results;

  // Bring-back: 1 player from the PRIMARY stack team (least correlated with stack)
  // Use the lowest-projected primary-team batter as bring-back (typically bottom of order)
  const primaryTeamBatters = primary.players
    .filter(p => p.team === stackTeam && !p.positions?.includes('P'))
    .sort((a, b) => a.projection - b.projection);
  const bringBack = primaryTeamBatters[0] || null;

  // Pitcher options for the twin:
  // Option A: keep primary's pitcher (neutral — no pitcher inversion)
  // Option B: use opposing team's pitcher (pitcher inversion — creates 2nd anti-correlation layer)
  // Option C: use a pitcher from a completely different game
  const pitcherCandidates: Array<{ pitcher: Player; isPitcherInversion: boolean }> = [];

  // Option A: keep primary pitcher
  if (primaryPitcher) {
    pitcherCandidates.push({ pitcher: primaryPitcher, isPitcherInversion: false });
  }

  // Option B: opposing pitcher from stack game (stack team's pitcher)
  const stackTeamPitchers = allPitchers.filter(p => p.team === stackTeam);
  for (const sp of stackTeamPitchers) {
    pitcherCandidates.push({ pitcher: sp, isPitcherInversion: true });
  }

  // Option C: pitcher from different game entirely
  const otherGamePitchers = allPitchers.filter(p =>
    p.team !== stackTeam && p.team !== oppTeam &&
    p.id !== primaryPitcher?.id
  ).sort((a, b) => b.projection - a.projection).slice(0, 3);
  for (const op of otherGamePitchers) {
    pitcherCandidates.push({ pitcher: op, isPitcherInversion: false });
  }

  // For each pitcher option, try to build a valid twin
  for (const { pitcher, isPitcherInversion } of pitcherCandidates) {
    // Build twin roster: pitcher + opposing batters + bring-back + fill
    const twinPlayers: Player[] = [pitcher];
    const usedIds = new Set<string>([pitcher.id]);

    // Add opposing batters (up to 4-5)
    const targetBatters = Math.min(4, twinBatters.length);
    for (let i = 0; i < targetBatters && i < twinBatters.length; i++) {
      if (usedIds.has(twinBatters[i].id)) continue;
      twinPlayers.push(twinBatters[i]);
      usedIds.add(twinBatters[i].id);
    }

    // Add bring-back if available and not already used
    if (bringBack && !usedIds.has(bringBack.id)) {
      twinPlayers.push(bringBack);
      usedIds.add(bringBack.id);
    }

    // Fill remaining slots from other teams (sorted by projection)
    const remaining = rosterSize - twinPlayers.length;
    if (remaining > 0) {
      const fillers = allPlayers
        .filter(p => !usedIds.has(p.id) && !p.positions?.includes('P') && p.projection > 3)
        .sort((a, b) => b.projection - a.projection);

      let salaryUsed = twinPlayers.reduce((s, p) => s + p.salary, 0);
      for (const f of fillers) {
        if (twinPlayers.length >= rosterSize) break;
        if (salaryUsed + f.salary > salaryCap - (rosterSize - twinPlayers.length - 1) * 3500) continue;
        twinPlayers.push(f);
        usedIds.add(f.id);
        salaryUsed += f.salary;
      }
    }

    if (twinPlayers.length < rosterSize) continue;

    // Check salary cap
    const totalSalary = twinPlayers.reduce((s, p) => s + p.salary, 0);
    if (totalSalary > salaryCap) continue;

    // Check projection minimum
    const twinProj = twinPlayers.reduce((s, p) => s + p.projection, 0);
    if (twinProj < primary.projection * params.minProjectionRatio) continue;

    // Assign players to valid DK position slots
    const slotted = assignPositionSlots(twinPlayers, config);
    if (!slotted) continue; // couldn't fit players into valid slots

    const twinOwn = slotted.reduce((s, p) => s + (p.ownership || 0), 0) / slotted.length;
    const hash = slotted.map(p => p.id).sort().join('|');

    results.push({
      twin: { players: slotted, salary: totalSalary, projection: twinProj, ownership: twinOwn, hash },
      gameFlip: true,
      pitcherInv: isPitcherInversion,
    });
  }

  return results;
}

// ============================================================
// HELPERS
// ============================================================

function sampleCorr(
  scores: Float32Array, N: number, W: number, means: Float64Array,
): { avgCorr: number; negFrac: number } {
  let sum = 0, neg = 0, count = 0;
  let seed = 31;
  const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };
  for (let p = 0; p < 300 && N >= 2; p++) {
    const i = Math.floor(rng() * N);
    let j = Math.floor(rng() * (N - 1)); if (j >= i) j++;
    const corr = pearsonRow(scores, i, j, W, means[i], means[j]);
    sum += corr; if (corr < 0) neg++; count++;
  }
  return { avgCorr: count > 0 ? sum / count : 0, negFrac: count > 0 ? neg / count : 0 };
}

/**
 * Assign players to valid DK position slots via greedy matching.
 * Each slot has eligible positions (e.g., slot "G" accepts PG, SG).
 * Each player has positions (e.g., ["SS", "OF"]).
 * Returns players in slot order, or null if no valid assignment exists.
 */
function assignPositionSlots(players: Player[], config: ContestConfig): Player[] | null {
  const slots = config.positions;
  const n = slots.length;
  if (players.length < n) return null;

  // Try to assign greedily: most constrained slots first (fewest eligible players)
  const slotEligible: Array<{ slotIdx: number; eligible: Player[] }> = [];
  const available = new Set(players.map(p => p.id));

  for (let i = 0; i < n; i++) {
    const eligiblePositions = new Set(slots[i].eligible.map(e => e.toUpperCase()));
    const eligible = players.filter(p => {
      const playerPositions = (p.positions || p.position.split('/')).map(pos => pos.toUpperCase());
      return playerPositions.some(pos => eligiblePositions.has(pos));
    });
    slotEligible.push({ slotIdx: i, eligible });
  }

  // Sort by number of eligible players (most constrained first)
  slotEligible.sort((a, b) => a.eligible.length - b.eligible.length);

  const assigned: (Player | null)[] = new Array(n).fill(null);
  const usedIds = new Set<string>();

  function backtrack(idx: number): boolean {
    if (idx >= n) return true;
    const { slotIdx, eligible } = slotEligible[idx];
    for (const player of eligible) {
      if (usedIds.has(player.id)) continue;
      assigned[slotIdx] = player;
      usedIds.add(player.id);
      if (backtrack(idx + 1)) return true;
      usedIds.delete(player.id);
      assigned[slotIdx] = null;
    }
    return false;
  }

  if (!backtrack(0)) return null;
  return assigned as Player[];
}
