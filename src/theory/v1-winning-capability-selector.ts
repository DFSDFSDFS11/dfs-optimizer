/**
 * V1-WinningCapability — hybrid variant fixing the structural issues identified
 * in V1-UpsideMax and V1-WinningValue.
 *
 * Fixes addressed:
 *   A. SMOOTH THRESHOLD — replaces binary cliff (V1-WinningValue) with sigmoid
 *      around the slate-derived winningThreshold. Lineups near the boundary
 *      get smooth interpolation, no cliff.
 *   B. HYBRID SCORING — keeps W_PROJ at REDUCED weight (0.5) alongside winning
 *      capability. Don't lose projection signal entirely.
 *   C. CORRELATION-ADJUSTED — uses t-copula sim joint p99 of the LINEUP'S score
 *      distribution across worlds, not sum of independent player p99 marginals.
 *      Correctly credits correlated stacks.
 *   E. LEVERAGE-WEIGHTED — winning capability multiplied by (1 - ownPct) inside
 *      the composite. Captures GPP payoff = uniqueness × winning probability.
 *      W_LEV term then dropped to avoid double-counting.
 *
 * EV = 0.5 × projPct                       (reduced W_PROJ — half of V1's 1.0)
 *    + W_WCAP × winningCapabilityPct        (slate-derived; smooth × leverage)
 *    + W_CMB × uniqPct                     (0.25, unchanged)
 *    + V1 structural priors (wStructure, wStackField, wGameOverload)
 */

import { Lineup, Player } from '../types';
import {
  TheoryV1Params,
  TheoryV1SelectionResult,
  ScoredTheoryLineup,
  scoreTheoryV1Candidates,
  selectFromScoredTheoryLineups,
} from './v1-selector';
import { generateWorlds } from '../v35/simulation';

export interface WinningCapabilityResult extends TheoryV1SelectionResult {
  anchorSize: number;
  jointP99Threshold: number;
  jointP99Mean: number;
  jointP99Std: number;
  winningWeight: number;
  smoothScale: number;
  winningCapabilities: number[];
}

const REDUCED_W_PROJ = 0.5;       // half of V1's 1.0 — preserves projection as a real signal
const NUM_WORLDS = 3000;          // for stable joint-p99 estimation (30 samples above p99)
const NU = 5;                     // t-copula degrees of freedom
const SEED = 12345;

function rankPercentile(values: number[]): number[] {
  const idx = values.map((v, i) => ({ v, i }));
  idx.sort((a, b) => a.v - b.v);
  const out = new Array<number>(values.length).fill(0);
  for (let r = 0; r < idx.length; r++) {
    out[idx[r].i] = values.length > 1 ? r / (values.length - 1) : 0;
  }
  return out;
}

function mean(a: number[]): number { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function stddev(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
}

function sigmoid(x: number): number {
  if (x >= 0) {
    const e = Math.exp(-x);
    return 1 / (1 + e);
  }
  const e = Math.exp(x);
  return e / (1 + e);
}

/**
 * Compute per-lineup joint p99 from t-copula sim of player scores.
 *
 * Critical: uses simulated correlated player scores (stack-correlated, pitcher
 * vs hitter anti-correlated) — not the sum of independent player p99 marginals.
 * This correctly credits stacks (whose joint upside > sum of marginal upsides)
 * and correctly discounts non-stacks (whose joint upside ≤ sum of marginals).
 */
function computeLineupJointP99s(candidates: Lineup[], players: Player[]): number[] {
  const sim = generateWorlds(players, NUM_WORLDS, NU, SEED);
  const playerIdx = new Map<string, number>();
  for (let i = 0; i < players.length; i++) playerIdx.set(players[i].id, i);

  const jointP99s = new Float64Array(candidates.length);
  // Reusable scratch buffer for per-lineup world scores.
  const buf = new Float64Array(NUM_WORLDS);
  const p99Idx = Math.floor(NUM_WORLDS * 0.99);   // 99th-percentile world index

  for (let c = 0; c < candidates.length; c++) {
    const lu = candidates[c];
    // Map lineup players to sim indices once.
    const idxs: number[] = [];
    for (const p of lu.players) {
      const i = playerIdx.get(p.id);
      if (i !== undefined) idxs.push(i);
    }
    // Sum across players per world.
    for (let w = 0; w < NUM_WORLDS; w++) {
      let s = 0;
      for (const i of idxs) s += sim.scores[i * NUM_WORLDS + w];
      buf[w] = s;
    }
    // Copy to JS array for sort.
    const arr = Array.from(buf);
    arr.sort((a, b) => a - b);
    jointP99s[c] = arr[p99Idx];
  }
  return Array.from(jointP99s);
}

export function selectWinningCapabilityPortfolio(
  candidates: Lineup[],
  players: Player[],
  targetCount: number,
  params: TheoryV1Params,
): WinningCapabilityResult {
  if (candidates.length === 0) {
    throw new Error('selectWinningCapabilityPortfolio: empty candidate pool');
  }

  // Step 1: Compute joint p99 from t-copula sim for every candidate.
  const candidateJointP99 = computeLineupJointP99s(candidates, players);

  // Step 2: Build anchor set (top-projection, same as UpsideMax/WinningValue).
  const projections = candidates.map(L => L.projection);
  const projMean = mean(projections);
  const projStd = stddev(projections);
  const cutoff = projMean + projStd;
  let anchorIdx = candidates.map((L, i) => i).filter(i => candidates[i].projection >= cutoff);
  if (anchorIdx.length < 5) {
    anchorIdx = candidates.map((L, i) => i)
      .sort((a, b) => candidates[b].projection - candidates[a].projection)
      .slice(0, Math.max(5, Math.floor(candidates.length * 0.10)));
  }

  // Step 3: Anchor joint p99 distribution (this is the CORRELATION-ADJUSTED
  // distribution, not the marginal sum). Threshold + scale derived from it.
  const anchorJointP99 = anchorIdx.map(i => candidateJointP99[i]).sort((a, b) => a - b);
  const jointP99Mean = mean(anchorJointP99);
  const jointP99Std = stddev(anchorJointP99);
  const jointP99Threshold = anchorJointP99[Math.floor(anchorJointP99.length * 0.25)] || 0;

  // Smooth scale = half of anchor std (transition zone). Lineups within
  // ±1.5σ of threshold get partial credit; outside get near-0 or near-1.
  const smoothScale = Math.max(1e-6, jointP99Std * 0.5);

  // Slate-derived weight (matches WinningValue pattern but base 0.5 since we
  // share the EV with projection at 0.5).
  const allJointP99 = candidateJointP99;
  const poolStd = stddev(allJointP99);
  const anchorCV = jointP99Mean > 0 ? jointP99Std / jointP99Mean : 0;
  const stdRatio = poolStd > 0 ? jointP99Std / poolStd : 0;
  const winningWeight = 0.5 * (1 + anchorCV * stdRatio * 0.5);

  // Step 4: Compute V1 baseline scoring (for projPct, uniqPct, ownPct, structural).
  const scored = scoreTheoryV1Candidates(candidates, params);

  // Step 5: Per-candidate winningCapability = sigmoid(distance from threshold) × leverage.
  //         Leverage = (1 - ownPct) absorbs W_LEV into the composite.
  const winningCapabilities = new Array<number>(candidates.length);
  for (let i = 0; i < candidates.length; i++) {
    const smooth = sigmoid((candidateJointP99[i] - jointP99Threshold) / smoothScale);
    const leverage = 1 - scored[i].ownPct;
    winningCapabilities[i] = smooth * leverage;
  }
  const wcPct = rankPercentile(winningCapabilities);

  // Step 6: Build EV. Reduced W_PROJ, no standalone W_LEV (absorbed), keep
  // W_CMB + V1 structural priors unchanged.
  for (let i = 0; i < scored.length; i++) {
    const s = scored[i];
    let ev = REDUCED_W_PROJ * s.projPct
      + winningWeight * wcPct[i]                   // smooth threshold × leverage
      + params.wCmb * s.uniqPct
      + params.wStructure * s.structurePct
      + params.wStackField * s.stackFieldPct
      - params.wGameOverload * s.gameOverloadPct;

    if (s.ppdPct >= 1 - params.ppdTopPct) ev *= (1 - params.ppdPenalty);
    s.ev = ev;
  }

  const result = selectFromScoredTheoryLineups(scored, candidates.length, targetCount, params);
  return {
    ...result,
    anchorSize: anchorIdx.length,
    jointP99Threshold,
    jointP99Mean,
    jointP99Std,
    winningWeight,
    smoothScale,
    winningCapabilities,
  };
}
