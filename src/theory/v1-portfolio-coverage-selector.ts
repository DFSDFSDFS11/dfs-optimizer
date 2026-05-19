/**
 * V1-PortfolioCoverage — greedy selection maximizing E[max(portfolio_score)]
 * across t-copula sim worlds.
 *
 * Core idea: in a GPP, only the BEST lineup of your N matters in any given
 * world. Scoring lineups INDEPENDENTLY then taking top-N selects lineups that
 * "hit in the same worlds" — concentrating outcome range. Greedy E[max]
 * selection actively chooses lineups that "win in different worlds", expanding
 * the portfolio's range of outcomes.
 *
 * Algorithm:
 *   1. Filter to top-K candidates by V1 EV (keeps quality floor)
 *   2. Greedy loop, repeated targetCount times:
 *      gain(c) = Σ_w max(0, worldScores[c, w] - maxWorld[w])
 *      pick = argmax(gain)
 *      maxWorld[w] = max(maxWorld[w], worldScores[pick, w])
 *      enforce per-player exposure cap
 *
 * This bypasses V1's selectFromScoredTheoryLineups (which uses band-fill on
 * static EV) because coverage gain depends on the CURRENT portfolio — it's an
 * iterative score that must be recomputed each pick.
 *
 * Constraints retained from V1:
 *   - exposureCapHitter (per-player max occurrence rate)
 *   - exposureCapPitcher (per-player max for pitchers, more permissive)
 */

import { Lineup, Player } from '../types';
import { isPitcher, TheoryV1Params, scoreTheoryV1Candidates } from './v1-selector';
import { LineupSimStats } from './v1-sim-stats';

export interface PortfolioCoverageResult {
  selected: Lineup[];
  diagnostics: {
    candidatesConsidered: number;
    targetCount: number;
    actualCount: number;
    meanGainTrajectory: number[];      // marginal gain per pick
    finalMaxWorldMean: number;          // mean of max_per_world after all picks
    finalMaxWorldStd: number;
  };
}

const PRE_FILTER_TOP_K = 1500;          // pre-filter by V1 EV before greedy

export function selectPortfolioCoveragePortfolio(
  candidates: Lineup[],
  _players: Player[],
  targetCount: number,
  params: TheoryV1Params,
  simStats: LineupSimStats,
): PortfolioCoverageResult {
  if (candidates.length === 0) throw new Error('selectPortfolioCoveragePortfolio: empty candidate pool');

  const scored = scoreTheoryV1Candidates(candidates, params);
  const W = simStats.nWorlds;
  const N = candidates.length;

  // Pre-filter to top-K by V1 EV. Keeps quality floor; rules out "high-σ noise"
  // candidates that have no chance of being a real GPP contender.
  const evIdx: number[] = [];
  for (let i = 0; i < N; i++) evIdx.push(i);
  evIdx.sort((a, b) => scored[b].ev - scored[a].ev);
  const K = Math.min(PRE_FILTER_TOP_K, N);
  const pool = evIdx.slice(0, K);

  // Per-player exposure caps
  const maxHitterCount = Math.max(1, Math.floor(targetCount * params.exposureCapHitter));
  const maxPitcherCount = Math.max(1, Math.floor(targetCount * params.exposureCapPitcher));
  const playerCount = new Map<string, number>();

  const picked = new Set<number>();
  const selected: Lineup[] = [];
  const maxWorld = new Float64Array(W);
  // Start maxWorld at 0 so gain on first pick = total Σ_w worldScores (drives
  // first pick to highest-mean lineup, which is sensible).
  maxWorld.fill(0);

  const gainTrajectory: number[] = [];

  while (selected.length < targetCount) {
    let bestGain = -Infinity;
    let bestIdx = -1;

    for (const i of pool) {
      if (picked.has(i)) continue;

      // Exposure cap precheck
      let blocked = false;
      for (const p of candidates[i].players) {
        const cnt = playerCount.get(p.id) || 0;
        const cap = isPitcher(p) ? maxPitcherCount : maxHitterCount;
        if (cnt >= cap) { blocked = true; break; }
      }
      if (blocked) continue;

      const base = i * W;
      let gain = 0;
      // Σ_w max(0, worldScores[c, w] - maxWorld[w])
      for (let w = 0; w < W; w++) {
        const diff = simStats.worldScores[base + w] - maxWorld[w];
        if (diff > 0) gain += diff;
      }

      if (gain > bestGain) { bestGain = gain; bestIdx = i; }
    }

    if (bestIdx < 0) break;        // no eligible candidate left

    picked.add(bestIdx);
    selected.push(candidates[bestIdx]);
    gainTrajectory.push(bestGain);

    // Update player exposure
    for (const p of candidates[bestIdx].players) {
      playerCount.set(p.id, (playerCount.get(p.id) || 0) + 1);
    }
    // Update maxWorld
    const base = bestIdx * W;
    for (let w = 0; w < W; w++) {
      const s = simStats.worldScores[base + w];
      if (s > maxWorld[w]) maxWorld[w] = s;
    }
  }

  // Diagnostics
  let mwSum = 0;
  for (let w = 0; w < W; w++) mwSum += maxWorld[w];
  const mwMean = mwSum / W;
  let mwVar = 0;
  for (let w = 0; w < W; w++) {
    const d = maxWorld[w] - mwMean;
    mwVar += d * d;
  }
  const mwStd = Math.sqrt(mwVar / W);

  return {
    selected,
    diagnostics: {
      candidatesConsidered: K,
      targetCount,
      actualCount: selected.length,
      meanGainTrajectory: gainTrajectory,
      finalMaxWorldMean: mwMean,
      finalMaxWorldStd: mwStd,
    },
  };
}
