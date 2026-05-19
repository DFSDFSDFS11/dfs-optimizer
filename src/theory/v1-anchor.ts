/**
 * Slate-derived anchor reference for V1-UpsideMax and V1-WinningValue.
 *
 * Per the pre-registered architectural spec, every parameter (anchor cutoff,
 * winning threshold, slate-derived weights) is computed from the candidate
 * pool's own structure. No hardcoded thresholds or anchors.
 */

import { Lineup, Player } from '../types';

export interface AnchorReference {
  anchorSet: Lineup[];
  winningThreshold: number;
  anchorMean: number;
  anchorStd: number;
  poolMean: number;
  poolStd: number;
  upsideWeight: number;
  winningWeight: number;
}

function p99Sum(lu: Lineup): number {
  let s = 0;
  for (const p of lu.players) {
    const v = (p.percentiles?.p99 ?? 0);
    s += v;
  }
  return s;
}

function p25Sum(lu: Lineup): number {
  let s = 0;
  for (const p of lu.players) {
    const v = (p.percentiles?.p25 ?? 0);
    s += v;
  }
  return s;
}

/**
 * Compute slate-derived anchor reference per the V1-UpsideMax / V1-WinningValue spec.
 *
 * - anchorSet: lineups with projection >= mean + 1 std
 * - winningThreshold: 25th percentile of anchor p99 sums
 * - upsideWeight: 0.20 * (1 + anchorCV * stdRatio)   (UpsideMax)
 * - winningWeight: 1.0 * (1 + anchorCV * stdRatio * 0.5)  (WinningValue)
 */
export function computeAnchorReference(candidatePool: Lineup[]): AnchorReference {
  if (candidatePool.length === 0) {
    return {
      anchorSet: [],
      winningThreshold: 0,
      anchorMean: 0,
      anchorStd: 0,
      poolMean: 0,
      poolStd: 0,
      upsideWeight: 0.20,
      winningWeight: 1.0,
    };
  }

  const projections = candidatePool.map(L => L.projection);
  const meanProj = projections.reduce((a, b) => a + b, 0) / projections.length;
  const projVar = projections.reduce((acc, p) => acc + (p - meanProj) ** 2, 0) / projections.length;
  const projStd = Math.sqrt(projVar);
  const projCutoff = meanProj + projStd;

  let anchorSet = candidatePool.filter(L => L.projection >= projCutoff);
  // Fallback: if std=0 or anchor is empty, take top-decile by projection.
  if (anchorSet.length < 5) {
    const sortedByProj = [...candidatePool].sort((a, b) => b.projection - a.projection);
    const k = Math.max(5, Math.floor(candidatePool.length * 0.10));
    anchorSet = sortedByProj.slice(0, k);
  }

  // Anchor p99 distribution
  const anchorP99 = anchorSet.map(p99Sum).sort((a, b) => a - b);
  const anchorMean = anchorP99.reduce((a, b) => a + b, 0) / anchorP99.length;
  const anchorVar = anchorP99.reduce((acc, x) => acc + (x - anchorMean) ** 2, 0) / anchorP99.length;
  const anchorStd = Math.sqrt(anchorVar);
  const winningThreshold = anchorP99[Math.floor(anchorP99.length * 0.25)] || 0;

  // Pool p99 distribution
  const poolP99 = candidatePool.map(p99Sum);
  const poolMean = poolP99.reduce((a, b) => a + b, 0) / poolP99.length;
  const poolVar = poolP99.reduce((acc, x) => acc + (x - poolMean) ** 2, 0) / poolP99.length;
  const poolStd = Math.sqrt(poolVar);

  const anchorCV = anchorMean > 0 ? anchorStd / anchorMean : 0;
  const stdRatio = poolStd > 0 ? anchorStd / poolStd : 0;

  // V1-UpsideMax weight: 0.20 base * (1 + anchorCV * stdRatio)
  const upsideWeight = 0.20 * (1 + anchorCV * stdRatio);

  // V1-WinningValue weight: 1.0 base * (1 + anchorCV * stdRatio * 0.5)
  // Base 1.0 because this replaces W_PROJ's dominant role.
  const winningWeight = 1.0 * (1 + anchorCV * stdRatio * 0.5);

  return {
    anchorSet,
    winningThreshold,
    anchorMean,
    anchorStd,
    poolMean,
    poolStd,
    upsideWeight,
    winningWeight,
  };
}

/**
 * Per-lineup upside score for V1-UpsideMax.
 *
 * If lineup's p99 sum < winningThreshold, returns 0 (can't win).
 * Otherwise returns (p99_sum - threshold) / anchorMean (normalized excess).
 */
export function computeUpsideScore(
  lineup: Lineup,
  winningThreshold: number,
  anchorMean: number,
): number {
  const s = p99Sum(lineup);
  if (s < winningThreshold) return 0;
  if (anchorMean <= 0) return 0;
  return (s - winningThreshold) / anchorMean;
}

/**
 * Per-lineup winning value for V1-WinningValue.
 *
 * Filters non-winning-capable lineups (score = 0). Survivors scored by
 * upsideExcess * projection (composite of upside and raw scoring power).
 */
export function computeWinningValue(
  lineup: Lineup,
  winningThreshold: number,
  anchorMean: number,
): number {
  const s = p99Sum(lineup);
  if (s < winningThreshold) return 0;
  if (anchorMean <= 0) return 0;
  const upsideExcess = (s - winningThreshold) / anchorMean;
  return upsideExcess * lineup.projection;
}

export { p99Sum, p25Sum };
