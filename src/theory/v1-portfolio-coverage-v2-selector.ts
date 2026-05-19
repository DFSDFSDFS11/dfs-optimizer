/**
 * V1-PortfolioCoverage-v2 — fixes the underfill bug + adds ownership regularizer.
 *
 * Changes from v1:
 *   1. UNDERFILL FIX: preFilterTopK raised from 1500 → 3000. After the greedy
 *      coverage loop exhausts (cap-eligible candidates left empty), fall back
 *      to V1-EV ranking ignoring exposure caps until targetCount lineups filled.
 *   2. OWNERSHIP REGULARIZER: hybrid score combines coverage gain with movement
 *      toward target ownDelta (default −7.2pp, the pro-consensus value).
 *      Implementation: each step uses rank-percentile of coverage gain blended
 *      with rank-percentile of "movement toward target ownDelta".
 *
 * The v1 architecture (greedy E[max(portfolio_score across worlds)]) is
 * preserved. v2 only changes the candidate pool size + tiebreaker + fallback.
 *
 * Requires chalkAnchorOwn from caller (mean ownership of top-chalkiest field
 * lineups). For validation, this is computed from actual field lineups; for
 * production, it can be approximated by SaberSim pool's top-projected lineups.
 */

import { Lineup, Player } from '../types';
import { isPitcher, TheoryV1Params, scoreTheoryV1Candidates } from './v1-selector';
import { LineupSimStats } from './v1-sim-stats';

export interface PortfolioCoverageV2Options {
  /** Mean ownership of top-100 chalkiest field lineups. If absent, ownership regularizer is disabled. */
  chalkAnchorOwn?: number;
  /** Target ownDelta = (mean lineup ownership of portfolio) − chalkAnchorOwn. Default −7.2. */
  targetOwnDelta?: number;
  /** Weight of ownership-regularizer term in greedy hybrid score, [0, 1]. Default 0.20. */
  ownDeltaWeight?: number;
  /** Pre-filter candidate pool size by V1 EV. Default 3000. */
  preFilterTopK?: number;
  /** If true, fill remaining slots with V1-EV ranking (no caps) when greedy exhausted. Default true. */
  fallbackToV1: boolean;
}

const DEFAULT_TARGET_OWN_DELTA = -7.2;
const DEFAULT_OWN_DELTA_WEIGHT = 0.20;
const DEFAULT_PRE_FILTER_TOP_K = 3000;

export interface PortfolioCoverageV2Result {
  selected: Lineup[];
  diagnostics: {
    candidatesConsidered: number;
    targetCount: number;
    actualCount: number;
    greedyPicks: number;            // # picks made by greedy loop
    fallbackPicks: number;          // # picks made by V1-EV fallback
    finalOwnDelta: number;          // portfolio's ownDelta at end
    targetOwnDelta: number;
    ownDeltaWeight: number;
    finalMaxWorldMean: number;
    finalMaxWorldStd: number;
  };
}

function lineupMeanOwn(lu: Lineup): number {
  if (!lu.players.length) return 0;
  let s = 0;
  for (const p of lu.players) s += (p.ownership || 0);
  return s / lu.players.length;
}

function rankPctArr(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  const idx: number[] = [];
  for (let i = 0; i < n; i++) idx.push(i);
  idx.sort((a, b) => values[a] - values[b]);
  const out = new Array<number>(n);
  for (let r = 0; r < n; r++) out[idx[r]] = n > 1 ? r / (n - 1) : 0;
  return out;
}

export function selectPortfolioCoverageV2Portfolio(
  candidates: Lineup[],
  _players: Player[],
  targetCount: number,
  params: TheoryV1Params,
  simStats: LineupSimStats,
  options: PortfolioCoverageV2Options = { fallbackToV1: true },
): PortfolioCoverageV2Result {
  if (candidates.length === 0) throw new Error('selectPortfolioCoverageV2Portfolio: empty candidate pool');

  const chalkAnchorOwn = options.chalkAnchorOwn;
  const targetOwnDelta = options.targetOwnDelta ?? DEFAULT_TARGET_OWN_DELTA;
  const ownDeltaWeight = options.ownDeltaWeight ?? DEFAULT_OWN_DELTA_WEIGHT;
  const preFilterTopK = options.preFilterTopK ?? DEFAULT_PRE_FILTER_TOP_K;
  const fallbackToV1 = options.fallbackToV1 !== false;
  const useOwnRegularizer = chalkAnchorOwn !== undefined && ownDeltaWeight > 0;

  const scored = scoreTheoryV1Candidates(candidates, params);
  const W = simStats.nWorlds;
  const N = candidates.length;

  // Pre-filter: top-K by V1 EV. Larger K than v1 (3000 vs 1500) so greedy has
  // more options when caps start binding.
  const evIdx: number[] = [];
  for (let i = 0; i < N; i++) evIdx.push(i);
  evIdx.sort((a, b) => scored[b].ev - scored[a].ev);
  const K = Math.min(preFilterTopK, N);
  const pool = evIdx.slice(0, K);

  // Pre-compute lineup mean ownership for ownership regularizer.
  const luOwn = new Float64Array(N);
  for (let i = 0; i < N; i++) luOwn[i] = lineupMeanOwn(candidates[i]);

  const maxHitterCount = Math.max(1, Math.floor(targetCount * params.exposureCapHitter));
  const maxPitcherCount = Math.max(1, Math.floor(targetCount * params.exposureCapPitcher));
  const playerCount = new Map<string, number>();

  const picked = new Set<number>();
  const selected: Lineup[] = [];
  const maxWorld = new Float64Array(W);
  maxWorld.fill(0);

  // Running sum of mean-ownership of picked lineups (for ownDelta tracking).
  let runningOwnSum = 0;

  let greedyPicks = 0;
  let fallbackPicks = 0;

  // ===== Greedy coverage loop =====
  while (selected.length < targetCount) {
    // First pass: collect eligible candidates + their coverage gains
    const eligibleIdx: number[] = [];
    const coverageGains: number[] = [];
    const ownDeltaMovements: number[] = [];

    const curN = selected.length;
    const curMeanOwn = curN > 0 ? runningOwnSum / curN : 0;
    const curOwnDelta = useOwnRegularizer ? (curMeanOwn - chalkAnchorOwn!) : 0;

    for (const i of pool) {
      if (picked.has(i)) continue;

      // Exposure cap check
      let blocked = false;
      for (const p of candidates[i].players) {
        const cnt = playerCount.get(p.id) || 0;
        const cap = isPitcher(p) ? maxPitcherCount : maxHitterCount;
        if (cnt >= cap) { blocked = true; break; }
      }
      if (blocked) continue;

      // Coverage gain
      const base = i * W;
      let cgain = 0;
      for (let w = 0; w < W; w++) {
        const diff = simStats.worldScores[base + w] - maxWorld[w];
        if (diff > 0) cgain += diff;
      }

      // Ownership-regularizer "movement gain" — positive if pick moves ownDelta
      // closer to target, negative if away.
      let ownGain = 0;
      if (useOwnRegularizer) {
        const newMeanOwn = (runningOwnSum + luOwn[i]) / (curN + 1);
        const newOwnDelta = newMeanOwn - chalkAnchorOwn!;
        const oldDist = Math.abs(curOwnDelta - targetOwnDelta);
        const newDist = Math.abs(newOwnDelta - targetOwnDelta);
        ownGain = oldDist - newDist;          // positive = improvement
      }

      eligibleIdx.push(i);
      coverageGains.push(cgain);
      ownDeltaMovements.push(ownGain);
    }

    if (eligibleIdx.length === 0) break;     // greedy exhausted, drop to fallback

    // Convert both to rank-percentile [0, 1] across eligible candidates.
    const covPct = rankPctArr(coverageGains);
    const ownPct = useOwnRegularizer ? rankPctArr(ownDeltaMovements) : null;

    // Hybrid score
    let bestScore = -Infinity;
    let bestLocal = -1;
    for (let j = 0; j < eligibleIdx.length; j++) {
      const cv = covPct[j];
      const ov = ownPct ? ownPct[j] : 0;
      const hybrid = useOwnRegularizer
        ? (1 - ownDeltaWeight) * cv + ownDeltaWeight * ov
        : cv;
      if (hybrid > bestScore) { bestScore = hybrid; bestLocal = j; }
    }
    if (bestLocal < 0) break;

    const bestIdx = eligibleIdx[bestLocal];
    picked.add(bestIdx);
    selected.push(candidates[bestIdx]);
    greedyPicks++;

    runningOwnSum += luOwn[bestIdx];

    for (const p of candidates[bestIdx].players) {
      playerCount.set(p.id, (playerCount.get(p.id) || 0) + 1);
    }
    const base = bestIdx * W;
    for (let w = 0; w < W; w++) {
      const s = simStats.worldScores[base + w];
      if (s > maxWorld[w]) maxWorld[w] = s;
    }
  }

  // ===== V1-EV fallback for unfilled slots =====
  // When greedy hits a wall (caps exhausted), don't underfill — pick remaining
  // slots from V1-EV ranking among all NON-picked candidates, ignoring caps.
  // This guarantees we always reach targetCount. Coverage gain isn't used here,
  // so these picks don't add to greedy diagnostics' coverage signal — they're
  // structural quality-floor filler.
  if (fallbackToV1 && selected.length < targetCount) {
    // Iterate full evIdx (not just pool) sorted by V1 EV
    for (const i of evIdx) {
      if (selected.length >= targetCount) break;
      if (picked.has(i)) continue;
      picked.add(i);
      selected.push(candidates[i]);
      runningOwnSum += luOwn[i];
      fallbackPicks++;
      const base = i * W;
      for (let w = 0; w < W; w++) {
        const s = simStats.worldScores[base + w];
        if (s > maxWorld[w]) maxWorld[w] = s;
      }
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

  const finalMeanOwn = selected.length > 0 ? runningOwnSum / selected.length : 0;
  const finalOwnDelta = useOwnRegularizer ? finalMeanOwn - chalkAnchorOwn! : 0;

  return {
    selected,
    diagnostics: {
      candidatesConsidered: K,
      targetCount,
      actualCount: selected.length,
      greedyPicks,
      fallbackPicks,
      finalOwnDelta,
      targetOwnDelta,
      ownDeltaWeight,
      finalMaxWorldMean: mwMean,
      finalMaxWorldStd: mwStd,
    },
  };
}
