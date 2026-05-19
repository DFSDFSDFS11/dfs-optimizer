/**
 * Shared t-copula sim statistics for V1-StdDevMax / V1-SigmaResidual /
 * V1-CVaR / V1-SimEnsemble / V1-PortfolioCoverage variants.
 *
 * Computes ALL per-lineup distributional stats from a SINGLE sim invocation:
 *   mean, std, p99, p95, p25, CVaR_95, skew, full per-world score matrix.
 *
 * Sharing the sim across variants is critical: the t-copula world generation
 * is by far the dominant compute cost. All consuming variants get identical
 * seeds/draws so their structural comparisons are apples-to-apples.
 */

import { Lineup, Player } from '../types';
import { generateWorlds } from '../v35/simulation';

export interface LineupSimStats {
  /** Per-lineup, per-world score. Row-major: worldScores[c * nWorlds + w]. */
  worldScores: Float64Array;
  mean: Float64Array;
  std: Float64Array;
  p99: Float64Array;
  p95: Float64Array;
  p25: Float64Array;
  /** E[score | score >= p95] — CVaR at 95% level (tail conditional expectation). */
  cvar95: Float64Array;
  /** Standardized 3rd moment (Pearson's). Positive = right skew = lottery profile. */
  skew: Float64Array;
  nWorlds: number;
}

export const SIM_NUM_WORLDS = 3000;
export const SIM_NU = 5;
export const SIM_SEED = 12345;

export function computeLineupSimStats(
  candidates: Lineup[],
  players: Player[],
): LineupSimStats {
  const W = SIM_NUM_WORLDS;
  const N = candidates.length;
  const sim = generateWorlds(players, W, SIM_NU, SIM_SEED);

  const playerIdx = new Map<string, number>();
  for (let i = 0; i < players.length; i++) playerIdx.set(players[i].id, i);

  const worldScores = new Float64Array(N * W);
  const mean = new Float64Array(N);
  const std = new Float64Array(N);
  const p99 = new Float64Array(N);
  const p95 = new Float64Array(N);
  const p25 = new Float64Array(N);
  const cvar95 = new Float64Array(N);
  const skew = new Float64Array(N);

  const p99Idx = Math.floor(W * 0.99);
  const p95Idx = Math.floor(W * 0.95);
  const p25Idx = Math.floor(W * 0.25);

  const buf = new Float64Array(W);

  for (let c = 0; c < N; c++) {
    const lu = candidates[c];
    const idxs: number[] = [];
    for (const p of lu.players) {
      const i = playerIdx.get(p.id);
      if (i !== undefined) idxs.push(i);
    }

    // Per-world score = sum of player simulated scores in that world
    let sum = 0;
    for (let w = 0; w < W; w++) {
      let s = 0;
      for (const i of idxs) s += sim.scores[i * W + w];
      buf[w] = s;
      worldScores[c * W + w] = s;
      sum += s;
    }
    const m = sum / W;
    mean[c] = m;

    // Variance + skew (single pass over buf)
    let varSum = 0;
    let skewSum = 0;
    for (let w = 0; w < W; w++) {
      const d = buf[w] - m;
      varSum += d * d;
      skewSum += d * d * d;
    }
    const variance = varSum / W;
    const sigma = Math.sqrt(variance);
    std[c] = sigma;
    skew[c] = sigma > 0 ? (skewSum / W) / (sigma * sigma * sigma) : 0;

    // Sort for quantiles + CVaR
    const arr = Array.from(buf);
    arr.sort((a, b) => a - b);
    p99[c] = arr[p99Idx];
    p95[c] = arr[p95Idx];
    p25[c] = arr[p25Idx];

    // CVaR_95 = mean of worlds with score >= p95
    let tail = 0;
    let tailCount = 0;
    for (let k = p95Idx; k < W; k++) {
      tail += arr[k];
      tailCount++;
    }
    cvar95[c] = tailCount > 0 ? tail / tailCount : arr[W - 1];
  }

  return { worldScores, mean, std, p99, p95, p25, cvar95, skew, nWorlds: W };
}

/**
 * Residualize y on x via simple linear regression: returns y - (alpha + beta*x).
 * Used to decorrelate sim stats (sigma, p99, etc.) from projection mean so they
 * become independent signals.
 */
export function residualize(y: Float64Array, x: Float64Array): Float64Array {
  const n = y.length;
  if (n === 0) return new Float64Array(0);
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; }
  const mx = sx / n, my = sy / n;
  let cov = 0, vx = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    cov += dx * dy;
    vx += dx * dx;
  }
  const beta = vx > 0 ? cov / vx : 0;
  const alpha = my - beta * mx;
  const res = new Float64Array(n);
  for (let i = 0; i < n; i++) res[i] = y[i] - (alpha + beta * x[i]);
  return res;
}

/** Rank-percentile [0, 1]. Equal values get average rank. */
export function rankPercentileFA(values: Float64Array | number[]): number[] {
  const n = values.length;
  const idx: number[] = [];
  for (let i = 0; i < n; i++) idx.push(i);
  idx.sort((a, b) => (values[a] as number) - (values[b] as number));
  const out = new Array<number>(n);
  for (let r = 0; r < n; r++) {
    out[idx[r]] = n > 1 ? r / (n - 1) : 0;
  }
  return out;
}

/**
 * Slate-derived scaling weight per UpsideMax pattern:
 *   weight = base * (1 + anchorCV * stdRatio * scaleFactor)
 *
 * anchorCV = std/mean of anchor subset of `values`
 * stdRatio = anchor std / pool std
 *
 * Anchor = top-projection lineups (mean + 1 std cutoff, fallback top-decile).
 */
export function computeSlateDerivedWeight(
  values: Float64Array,
  candidates: Lineup[],
  base: number,
  scaleFactor: number = 1.0,
): { weight: number; anchorMean: number; anchorStd: number; poolStd: number } {
  const n = candidates.length;
  if (n === 0) return { weight: base, anchorMean: 0, anchorStd: 0, poolStd: 0 };

  const projections = candidates.map(L => L.projection);
  const projMean = projections.reduce((a, b) => a + b, 0) / n;
  const projVar = projections.reduce((s, p) => s + (p - projMean) ** 2, 0) / n;
  const projStd = Math.sqrt(projVar);
  const cutoff = projMean + projStd;

  let anchorIdx = candidates.map((_, i) => i).filter(i => candidates[i].projection >= cutoff);
  if (anchorIdx.length < 5) {
    anchorIdx = candidates.map((_, i) => i)
      .sort((a, b) => candidates[b].projection - candidates[a].projection)
      .slice(0, Math.max(5, Math.floor(n * 0.10)));
  }

  const anchorVals = anchorIdx.map(i => values[i]);
  const aMean = anchorVals.reduce((a, b) => a + b, 0) / anchorVals.length;
  const aVar = anchorVals.reduce((s, v) => s + (v - aMean) ** 2, 0) / anchorVals.length;
  const aStd = Math.sqrt(aVar);

  let pMean = 0;
  for (let i = 0; i < n; i++) pMean += values[i];
  pMean /= n;
  let pVar = 0;
  for (let i = 0; i < n; i++) pVar += (values[i] - pMean) ** 2;
  pVar /= n;
  const pStd = Math.sqrt(pVar);

  const anchorCV = aMean !== 0 ? Math.abs(aStd / aMean) : 0;
  const stdRatio = pStd > 0 ? aStd / pStd : 0;

  return {
    weight: base * (1 + anchorCV * stdRatio * scaleFactor),
    anchorMean: aMean,
    anchorStd: aStd,
    poolStd: pStd,
  };
}
