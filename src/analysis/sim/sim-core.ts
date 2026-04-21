/**
 * Shared simulation utilities for full-analysis modules.
 *
 * These helpers project any set of Lineups into per-world score arrays using
 * the playerWorldScores from an existing SlatePrecomputation. Downstream
 * modules (lineup profiles, portfolio metrics, pool-as-portfolio) all operate
 * on those scored-lineup arrays.
 */

import { Lineup, Player, Sport } from '../../types';
import { SlatePrecomputation } from '../../selection/algorithm7-selector';

// ============================================================
// LINEUP → WORLD SCORES
// ============================================================

/** Score every lineup across all W worlds using precomp.playerWorldScores. */
export function scoreLineups(
  lineups: Lineup[],
  precomp: SlatePrecomputation,
): Float32Array {
  const W = precomp.W;
  const N = lineups.length;
  const out = new Float32Array(N * W);
  for (let i = 0; i < N; i++) {
    const offset = i * W;
    for (const p of lineups[i].players) {
      const pi = precomp.indexMap.get(p.id);
      if (pi === undefined) continue;
      const po = pi * W;
      for (let w = 0; w < W; w++) out[offset + w] += precomp.playerWorldScores[po + w];
    }
  }
  return out;
}

// ============================================================
// MEAN / VAR / PERCENTILES
// ============================================================

export function computeMeanAndVar(
  scores: Float32Array,
  N: number,
  W: number,
): { means: Float64Array; vars: Float64Array } {
  const means = new Float64Array(N);
  const vars_ = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let sum = 0;
    for (let w = 0; w < W; w++) sum += scores[i * W + w];
    const mean = sum / W;
    means[i] = mean;
    let ss = 0;
    for (let w = 0; w < W; w++) {
      const d = scores[i * W + w] - mean;
      ss += d * d;
    }
    vars_[i] = W > 1 ? ss / (W - 1) : 0;
  }
  return { means, vars: vars_ };
}

export function percentileOfRow(
  scores: Float32Array,
  row: number,
  W: number,
  pct: number,
): number {
  const tmp = new Float64Array(W);
  for (let w = 0; w < W; w++) tmp[w] = scores[row * W + w];
  tmp.sort();
  const idx = Math.max(0, Math.min(W - 1, Math.floor(W * pct)));
  return tmp[idx];
}

// ============================================================
// PAIRWISE CORRELATION (subset-friendly)
// ============================================================

export function pearsonRow(
  scores: Float32Array,
  i: number,
  j: number,
  W: number,
  meanI: number,
  meanJ: number,
): number {
  let num = 0, dI = 0, dJ = 0;
  const oi = i * W, oj = j * W;
  for (let w = 0; w < W; w++) {
    const a = scores[oi + w] - meanI;
    const b = scores[oj + w] - meanJ;
    num += a * b;
    dI += a * a;
    dJ += b * b;
  }
  const denom = Math.sqrt(dI * dJ);
  return denom > 1e-12 ? num / denom : 0;
}

export function covRow(
  scores: Float32Array,
  i: number,
  j: number,
  W: number,
  meanI: number,
  meanJ: number,
): number {
  let num = 0;
  const oi = i * W, oj = j * W;
  for (let w = 0; w < W; w++) {
    num += (scores[oi + w] - meanI) * (scores[oj + w] - meanJ);
  }
  return W > 1 ? num / (W - 1) : 0;
}

export function varDiffRow(
  scores: Float32Array,
  i: number,
  j: number,
  W: number,
): number {
  // Var(z_i - z_j) — Liu Eq 14
  let sum = 0, sumSq = 0;
  const oi = i * W, oj = j * W;
  for (let w = 0; w < W; w++) {
    const d = scores[oi + w] - scores[oj + w];
    sum += d;
    sumSq += d * d;
  }
  const mean = sum / W;
  return W > 1 ? (sumSq / W - mean * mean) * W / (W - 1) : 0;
}

// ============================================================
// PLAYER-LEVEL CORRELATION (within-lineup pair counts)
// ============================================================

/** Pearson ρ between two players' world scores. */
export function playerPairCorrelation(
  playerWorldScores: Float32Array,
  pIdxA: number,
  pIdxB: number,
  W: number,
): number {
  const oa = pIdxA * W, ob = pIdxB * W;
  let sa = 0, sb = 0;
  for (let w = 0; w < W; w++) { sa += playerWorldScores[oa + w]; sb += playerWorldScores[ob + w]; }
  const ma = sa / W, mb = sb / W;
  let num = 0, dA = 0, dB = 0;
  for (let w = 0; w < W; w++) {
    const da = playerWorldScores[oa + w] - ma;
    const db = playerWorldScores[ob + w] - mb;
    num += da * db; dA += da * da; dB += db * db;
  }
  const denom = Math.sqrt(dA * dB);
  return denom > 1e-12 ? num / denom : 0;
}

// ============================================================
// FIELD PERCENTILE THRESHOLDS
// ============================================================

/** Return per-world threshold arrays at multiple percentiles using field scores. */
export function fieldThresholdsMulti(
  fieldWorldScores: Float32Array,
  F: number,
  W: number,
  percentiles: number[],   // e.g. [0.999, 0.99, 0.95, 0.90]
): Float32Array[] {
  const results: Float32Array[] = percentiles.map(() => new Float32Array(W));
  const tmp = new Float64Array(F);
  for (let w = 0; w < W; w++) {
    for (let f = 0; f < F; f++) tmp[f] = fieldWorldScores[f * W + w];
    tmp.sort();
    for (let p = 0; p < percentiles.length; p++) {
      const idx = Math.max(0, Math.min(F - 1, Math.floor(F * percentiles[p])));
      results[p][w] = tmp[idx];
    }
  }
  return results;
}

// ============================================================
// HELPERS
// ============================================================

export function spearmanCorrelation(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length < 2) return 0;
  const n = x.length;
  const rx = toRanks(x);
  const ry = toRanks(y);
  let dSq = 0;
  for (let i = 0; i < n; i++) {
    const d = rx[i] - ry[i];
    dSq += d * d;
  }
  return 1 - (6 * dSq) / (n * (n * n - 1));
}

function toRanks(arr: number[]): number[] {
  const idx = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array(arr.length);
  for (let r = 0; r < idx.length; r++) ranks[idx[r].i] = r + 1;
  return ranks;
}

/**
 * Cohen's d-style effect size between two populations given means + pooled stdev.
 */
export function effectSize(topMean: number, fieldMean: number, fieldStd: number): number {
  if (fieldStd <= 0) return 0;
  return (topMean - fieldMean) / fieldStd;
}

export type { Player, Lineup, Sport };
