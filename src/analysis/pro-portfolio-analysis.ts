/**
 * Pro Portfolio Reverse-Engineering Analysis
 *
 * Compares pro portfolios against our selector and random baselines across
 * multiple dimensions: actuals performance, projection/variance, correlation
 * structure, world coverage, and player exposure leverage.
 */

import { Lineup, Player } from '../types';
import { SlatePrecomputation } from '../selection/algorithm7-selector';

// ============================================================
// TYPES
// ============================================================

interface PortfolioMetrics {
  label: string;
  entryCount: number;

  // A. Performance (actuals)
  top1PctRate: number;
  top5PctRate: number;
  avgActual: number;
  bestActual: number;
  bestRank: number;

  // B. Projection & Variance
  avgProjection: number;
  avgVariance: number;
  avgStdDev: number;

  // C. Correlation Structure
  avgPairwiseCorr: number;
  negativePairFrac: number;
  avgVarDiff: number;  // Liu Eq 14: avg Var(z_i - z_j)

  // D. World Coverage
  coverageTop01: number;  // fraction of worlds with >= 1 entry beating top-0.1%
  coverageTop1: number;
  coverageTop5: number;

  // E. Exposure
  maxExposure: number;
  maxExposurePlayer: string;
  uniquePlayers: number;

  // F. Top player exposures with leverage
  topExposures: Array<{
    name: string;
    proExposure: number;
    fieldOwnership: number;
    leverage: number;
  }>;
}

// ============================================================
// MAIN ENTRY POINT
// ============================================================

export async function analyzeProPortfolios(
  proEntries: Map<string, Lineup[]>,
  selectorEntries: Lineup[],
  allFieldLineups: Lineup[],
  precomp: SlatePrecomputation,
  players: Player[],
  actualByHash: Map<string, number>,
  contestSize: number,
): Promise<void> {
  console.log(`\n${'='.repeat(72)}`);
  console.log(`PRO PORTFOLIO ANALYSIS — ${contestSize.toLocaleString()} contest entries`);
  console.log(`${'='.repeat(72)}`);

  // Build lookup: hash -> candidate index for world scoring
  const hashToCandIdx = new Map<string, number>();
  for (let i = 0; i < precomp.candidatePool.length; i++) {
    hashToCandIdx.set(precomp.candidatePool[i].hash, i);
  }

  // Build field ownership map (player ID -> fraction of field lineups containing them)
  const fieldOwnershipMap = buildFieldOwnership(allFieldLineups);

  // Compute actual-score thresholds from field
  const allActualScores = Array.from(actualByHash.values()).sort((a, b) => b - a);
  const F = allActualScores.length;
  const thresholds = {
    top1: allActualScores[Math.max(0, Math.floor(F * 0.01) - 1)] || 0,
    top5: allActualScores[Math.max(0, Math.floor(F * 0.05) - 1)] || 0,
  };

  // Compute metrics for each portfolio
  const portfolios: PortfolioMetrics[] = [];

  // Pro portfolios
  for (const [name, lineups] of proEntries) {
    if (lineups.length < 5) continue;
    const metrics = computePortfolioMetrics(
      name, lineups, precomp, hashToCandIdx, actualByHash,
      thresholds, allActualScores, fieldOwnershipMap,
    );
    portfolios.push(metrics);
  }

  // Our selector
  if (selectorEntries.length > 0) {
    const metrics = computePortfolioMetrics(
      'our V24', selectorEntries, precomp, hashToCandIdx, actualByHash,
      thresholds, allActualScores, fieldOwnershipMap,
    );
    portfolios.push(metrics);
  }

  // Random baseline (20 samples of 150)
  const randomMetrics = computeRandomBaseline(
    allFieldLineups, precomp, hashToCandIdx, actualByHash,
    thresholds, allActualScores, fieldOwnershipMap,
    Math.min(150, selectorEntries.length || 150), 20,
  );
  portfolios.push(randomMetrics);

  // Print comparison table
  printComparisonTable(portfolios, contestSize);

  // Print top exposures for each pro
  for (const m of portfolios) {
    if (m.label === 'random' || m.topExposures.length === 0) continue;
    printExposureTable(m);
  }
}

// ============================================================
// CORE METRIC COMPUTATION
// ============================================================

function computePortfolioMetrics(
  label: string,
  lineups: Lineup[],
  precomp: SlatePrecomputation,
  hashToCandIdx: Map<string, number>,
  actualByHash: Map<string, number>,
  thresholds: { top1: number; top5: number },
  sortedDescScores: number[],
  fieldOwnershipMap: Map<string, number>,
): PortfolioMetrics {
  const N = lineups.length;
  const W = precomp.W;

  // ---- A. Performance from actuals ----
  let top1 = 0, top5 = 0, sumActual = 0, bestActual = -Infinity, bestRank = sortedDescScores.length;
  let scoredCount = 0;
  for (const lu of lineups) {
    const actual = actualByHash.get(lu.hash);
    if (actual === undefined) continue;
    scoredCount++;
    sumActual += actual;
    if (actual > bestActual) {
      bestActual = actual;
      bestRank = findRank(actual, sortedDescScores);
    }
    if (actual >= thresholds.top1) top1++;
    if (actual >= thresholds.top5) top5++;
  }

  // ---- Get world scores for each lineup ----
  const worldScores = getWorldScoresForLineups(lineups, precomp, hashToCandIdx);

  // ---- B. Projection & Variance ----
  let sumProj = 0, sumVar = 0;
  for (let i = 0; i < N; i++) {
    sumProj += lineups[i].projection;
    // Compute variance across worlds for this lineup
    const scores = worldScores[i];
    if (scores) {
      let mean = 0;
      for (let w = 0; w < W; w++) mean += scores[w];
      mean /= W;
      let variance = 0;
      for (let w = 0; w < W; w++) {
        const d = scores[w] - mean;
        variance += d * d;
      }
      variance /= (W - 1);
      sumVar += variance;
    }
  }

  // ---- C. Correlation Structure ----
  const { avgCorr, negativeFrac, avgVarDiff } = computeCorrelationMetrics(worldScores, W);

  // ---- D. World Coverage ----
  const { cov01, cov1, cov5 } = computeWorldCoverage(worldScores, precomp);

  // ---- E. Exposure ----
  const exposureMap = new Map<string, number>();
  for (const lu of lineups) {
    for (const p of lu.players) {
      exposureMap.set(p.id, (exposureMap.get(p.id) || 0) + 1);
    }
  }
  let maxExp = 0, maxExpPlayer = '';
  for (const [id, count] of exposureMap) {
    const frac = count / N;
    if (frac > maxExp) {
      maxExp = frac;
      maxExpPlayer = id;
    }
  }
  // Resolve player name
  const maxExpPlayerName = lineups.flatMap(l => l.players).find(p => p.id === maxExpPlayer)?.name || maxExpPlayer;

  // ---- F. Top exposures with leverage ----
  const topExposures: PortfolioMetrics['topExposures'] = [];
  const sortedExposures = Array.from(exposureMap.entries())
    .map(([id, count]) => ({ id, frac: count / N }))
    .sort((a, b) => b.frac - a.frac)
    .slice(0, 10);

  for (const { id, frac } of sortedExposures) {
    const player = lineups.flatMap(l => l.players).find(p => p.id === id);
    const fieldOwn = fieldOwnershipMap.get(id) || 0;
    topExposures.push({
      name: player?.name || id,
      proExposure: frac,
      fieldOwnership: fieldOwn,
      leverage: fieldOwn > 0 ? fieldOwn / frac : 0,
    });
  }

  return {
    label,
    entryCount: N,
    top1PctRate: scoredCount > 0 ? top1 / scoredCount : 0,
    top5PctRate: scoredCount > 0 ? top5 / scoredCount : 0,
    avgActual: scoredCount > 0 ? sumActual / scoredCount : 0,
    bestActual: bestActual === -Infinity ? 0 : bestActual,
    bestRank,
    avgProjection: sumProj / N,
    avgVariance: sumVar / N,
    avgStdDev: Math.sqrt(sumVar / N),
    avgPairwiseCorr: avgCorr,
    negativePairFrac: negativeFrac,
    avgVarDiff,
    coverageTop01: cov01,
    coverageTop1: cov1,
    coverageTop5: cov5,
    maxExposure: maxExp,
    maxExposurePlayer: maxExpPlayerName,
    uniquePlayers: exposureMap.size,
    topExposures,
  };
}

// ============================================================
// WORLD SCORES
// ============================================================

/**
 * Get world scores for a set of lineups. Uses precomp candidateWorldScores
 * when available, otherwise sums player-level world scores.
 */
function getWorldScoresForLineups(
  lineups: Lineup[],
  precomp: SlatePrecomputation,
  hashToCandIdx: Map<string, number>,
): (Float32Array | null)[] {
  const W = precomp.W;
  const result: (Float32Array | null)[] = [];

  for (const lu of lineups) {
    const candIdx = hashToCandIdx.get(lu.hash);
    if (candIdx !== undefined) {
      // Fast path: use precomputed candidate scores
      const scores = new Float32Array(W);
      const offset = candIdx * W;
      for (let w = 0; w < W; w++) {
        scores[w] = precomp.candidateWorldScores[offset + w];
      }
      result.push(scores);
    } else {
      // Slow path: sum player-level world scores
      const scores = new Float32Array(W);
      let allFound = true;
      for (const p of lu.players) {
        const pIdx = precomp.indexMap.get(p.id);
        if (pIdx === undefined) { allFound = false; break; }
        const pOffset = pIdx * W;
        for (let w = 0; w < W; w++) {
          scores[w] += precomp.playerWorldScores[pOffset + w];
        }
      }
      result.push(allFound ? scores : null);
    }
  }

  return result;
}

// ============================================================
// CORRELATION METRICS
// ============================================================

function computeCorrelationMetrics(
  worldScores: (Float32Array | null)[],
  W: number,
): { avgCorr: number; negativeFrac: number; avgVarDiff: number } {
  // Filter to entries that have valid world scores
  const valid = worldScores.filter((s): s is Float32Array => s !== null);
  const N = valid.length;

  if (N < 2) return { avgCorr: 0, negativeFrac: 0, avgVarDiff: 0 };

  // Precompute means and norms for Pearson correlation
  const means = new Float64Array(N);
  const norms = new Float64Array(N);  // sqrt(sum((x - mean)^2))
  for (let i = 0; i < N; i++) {
    let sum = 0;
    for (let w = 0; w < W; w++) sum += valid[i][w];
    means[i] = sum / W;

    let ss = 0;
    for (let w = 0; w < W; w++) {
      const d = valid[i][w] - means[i];
      ss += d * d;
    }
    norms[i] = Math.sqrt(ss);
  }

  // Sample pairs (cap at 500 for speed)
  const maxPairs = 500;
  const totalPairs = N * (N - 1) / 2;
  const sampleAll = totalPairs <= maxPairs;

  let sumCorr = 0, negCount = 0, sumVarDiff = 0, pairCount = 0;

  if (sampleAll) {
    // Enumerate all pairs
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const { corr, varDiff } = pairMetrics(valid[i], valid[j], means[i], means[j], norms[i], norms[j], W);
        sumCorr += corr;
        if (corr < 0) negCount++;
        sumVarDiff += varDiff;
        pairCount++;
      }
    }
  } else {
    // Random sampling
    let seed = 42;
    const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };
    for (let p = 0; p < maxPairs; p++) {
      const i = Math.floor(rng() * N);
      let j = Math.floor(rng() * (N - 1));
      if (j >= i) j++;
      const { corr, varDiff } = pairMetrics(valid[i], valid[j], means[i], means[j], norms[i], norms[j], W);
      sumCorr += corr;
      if (corr < 0) negCount++;
      sumVarDiff += varDiff;
      pairCount++;
    }
  }

  return {
    avgCorr: pairCount > 0 ? sumCorr / pairCount : 0,
    negativeFrac: pairCount > 0 ? negCount / pairCount : 0,
    avgVarDiff: pairCount > 0 ? sumVarDiff / pairCount : 0,
  };
}

function pairMetrics(
  a: Float32Array, b: Float32Array,
  meanA: number, meanB: number,
  normA: number, normB: number,
  W: number,
): { corr: number; varDiff: number } {
  let dotProd = 0;
  let sumDiffSq = 0;
  for (let w = 0; w < W; w++) {
    dotProd += (a[w] - meanA) * (b[w] - meanB);
    const diff = a[w] - b[w];
    sumDiffSq += diff * diff;
  }
  const denom = normA * normB;
  const corr = denom > 1e-12 ? dotProd / denom : 0;
  // Liu Eq 14: Var(z_i - z_j) — sample variance of pointwise differences
  const meanDiff = (a.reduce((s, v, w) => s + v - b[w], 0)) / W;
  const varDiff = sumDiffSq / W - meanDiff * meanDiff;
  return { corr, varDiff };
}

// ============================================================
// WORLD COVERAGE
// ============================================================

function computeWorldCoverage(
  worldScores: (Float32Array | null)[],
  precomp: SlatePrecomputation,
): { cov01: number; cov1: number; cov5: number } {
  const W = precomp.W;
  const valid = worldScores.filter((s): s is Float32Array => s !== null);

  if (valid.length === 0) return { cov01: 0, cov1: 0, cov5: 0 };

  // Compute per-world thresholds from sortedFieldByWorld (ascending order)
  // For top-X%: threshold = field score at rank floor(F * (1 - X/100))
  const covered01 = new Uint8Array(W);
  const covered1 = new Uint8Array(W);
  const covered5 = new Uint8Array(W);

  for (let w = 0; w < W; w++) {
    const sorted = precomp.sortedFieldByWorld[w];
    if (!sorted || sorted.length === 0) continue;
    const Fw = sorted.length;
    const t01 = sorted[Math.max(0, Math.floor(Fw * 0.999))] || 0;
    const t1 = sorted[Math.max(0, Math.floor(Fw * 0.99))] || 0;
    const t5 = sorted[Math.max(0, Math.floor(Fw * 0.95))] || 0;

    for (const scores of valid) {
      if (covered01[w] && covered1[w] && covered5[w]) break;
      if (!covered01[w] && scores[w] >= t01) covered01[w] = 1;
      if (!covered1[w] && scores[w] >= t1) covered1[w] = 1;
      if (!covered5[w] && scores[w] >= t5) covered5[w] = 1;
    }
  }

  let sum01 = 0, sum1 = 0, sum5 = 0;
  for (let w = 0; w < W; w++) {
    sum01 += covered01[w];
    sum1 += covered1[w];
    sum5 += covered5[w];
  }

  return {
    cov01: sum01 / W,
    cov1: sum1 / W,
    cov5: sum5 / W,
  };
}

// ============================================================
// FIELD OWNERSHIP
// ============================================================

function buildFieldOwnership(fieldLineups: Lineup[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const lu of fieldLineups) {
    for (const p of lu.players) {
      counts.set(p.id, (counts.get(p.id) || 0) + 1);
    }
  }
  const N = fieldLineups.length;
  const result = new Map<string, number>();
  for (const [id, count] of counts) {
    result.set(id, count / N);
  }
  return result;
}

// ============================================================
// RANDOM BASELINE
// ============================================================

function computeRandomBaseline(
  allFieldLineups: Lineup[],
  precomp: SlatePrecomputation,
  hashToCandIdx: Map<string, number>,
  actualByHash: Map<string, number>,
  thresholds: { top1: number; top5: number },
  sortedDescScores: number[],
  fieldOwnershipMap: Map<string, number>,
  sampleSize: number,
  numSamples: number,
): PortfolioMetrics {
  const accumulator: Omit<PortfolioMetrics, 'label' | 'entryCount' | 'topExposures' | 'maxExposurePlayer'> = {
    top1PctRate: 0, top5PctRate: 0, avgActual: 0, bestActual: 0, bestRank: 0,
    avgProjection: 0, avgVariance: 0, avgStdDev: 0,
    avgPairwiseCorr: 0, negativePairFrac: 0, avgVarDiff: 0,
    coverageTop01: 0, coverageTop1: 0, coverageTop5: 0,
    maxExposure: 0, uniquePlayers: 0,
  };

  let seed = 12345;
  const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };

  for (let s = 0; s < numSamples; s++) {
    // Shuffle and take sampleSize
    const indices = Array.from({ length: allFieldLineups.length }, (_, i) => i);
    const n = Math.min(sampleSize, indices.length);
    for (let i = 0; i < n; i++) {
      const j = i + Math.floor(rng() * (indices.length - i));
      const tmp = indices[i]; indices[i] = indices[j]; indices[j] = tmp;
    }
    const sample = indices.slice(0, n).map(i => allFieldLineups[i]);

    const m = computePortfolioMetrics(
      'random', sample, precomp, hashToCandIdx, actualByHash,
      thresholds, sortedDescScores, fieldOwnershipMap,
    );

    accumulator.top1PctRate += m.top1PctRate;
    accumulator.top5PctRate += m.top5PctRate;
    accumulator.avgActual += m.avgActual;
    accumulator.bestActual += m.bestActual;
    accumulator.bestRank += m.bestRank;
    accumulator.avgProjection += m.avgProjection;
    accumulator.avgVariance += m.avgVariance;
    accumulator.avgStdDev += m.avgStdDev;
    accumulator.avgPairwiseCorr += m.avgPairwiseCorr;
    accumulator.negativePairFrac += m.negativePairFrac;
    accumulator.avgVarDiff += m.avgVarDiff;
    accumulator.coverageTop01 += m.coverageTop01;
    accumulator.coverageTop1 += m.coverageTop1;
    accumulator.coverageTop5 += m.coverageTop5;
    accumulator.maxExposure += m.maxExposure;
    accumulator.uniquePlayers += m.uniquePlayers;
  }

  // Average
  const div = numSamples;
  return {
    label: 'random',
    entryCount: sampleSize,
    top1PctRate: accumulator.top1PctRate / div,
    top5PctRate: accumulator.top5PctRate / div,
    avgActual: accumulator.avgActual / div,
    bestActual: accumulator.bestActual / div,
    bestRank: Math.round(accumulator.bestRank / div),
    avgProjection: accumulator.avgProjection / div,
    avgVariance: accumulator.avgVariance / div,
    avgStdDev: accumulator.avgStdDev / div,
    avgPairwiseCorr: accumulator.avgPairwiseCorr / div,
    negativePairFrac: accumulator.negativePairFrac / div,
    avgVarDiff: accumulator.avgVarDiff / div,
    coverageTop01: accumulator.coverageTop01 / div,
    coverageTop1: accumulator.coverageTop1 / div,
    coverageTop5: accumulator.coverageTop5 / div,
    maxExposure: accumulator.maxExposure / div,
    maxExposurePlayer: '(avg)',
    uniquePlayers: Math.round(accumulator.uniquePlayers / div),
    topExposures: [],
  };
}

// ============================================================
// HELPERS
// ============================================================

function findRank(score: number, sortedDesc: number[]): number {
  let lo = 0, hi = sortedDesc.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedDesc[mid] >= score) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(1, lo);
}

// ============================================================
// OUTPUT FORMATTING
// ============================================================

function printComparisonTable(portfolios: PortfolioMetrics[], contestSize: number): void {
  if (portfolios.length === 0) return;

  // Column widths
  const labelW = 22;
  const colW = 12;

  const cols = portfolios.map(p => p.label);
  const colHeaders = cols.map(c => c.padStart(colW));

  // Border helpers
  const topBorder = `+${'-'.repeat(labelW)}+${cols.map(() => '-'.repeat(colW)).join('+')}+`;
  const midBorder = `+${'-'.repeat(labelW)}+${cols.map(() => '-'.repeat(colW)).join('+')}+`;
  const botBorder = `+${'-'.repeat(labelW)}+${cols.map(() => '-'.repeat(colW)).join('+')}+`;

  const row = (label: string, values: string[]) => {
    const paddedLabel = ` ${label}`.padEnd(labelW);
    const paddedVals = values.map((v, i) => v.padStart(colW));
    return `|${paddedLabel}|${paddedVals.join('|')}|`;
  };

  const entryRow = row('Entries', portfolios.map(p => String(p.entryCount)));

  console.log('');
  console.log(topBorder);
  console.log(row('Metric', colHeaders));
  console.log(midBorder);
  console.log(entryRow);
  console.log(midBorder);

  // Performance
  console.log(row('Top 1% rate', portfolios.map(p => `${(p.top1PctRate * 100).toFixed(2)}%`)));
  console.log(row('Top 5% rate', portfolios.map(p => `${(p.top5PctRate * 100).toFixed(2)}%`)));
  console.log(row('Avg actual', portfolios.map(p => p.avgActual.toFixed(1))));
  console.log(row('Best actual', portfolios.map(p => p.bestActual.toFixed(1))));
  console.log(row('Best rank', portfolios.map(p => String(p.bestRank))));
  console.log(midBorder);

  // Projection & Variance
  console.log(row('Avg projection', portfolios.map(p => p.avgProjection.toFixed(1))));
  console.log(row('Avg variance', portfolios.map(p => p.avgVariance.toFixed(1))));
  console.log(row('Avg std dev', portfolios.map(p => p.avgStdDev.toFixed(1))));
  console.log(midBorder);

  // Correlation
  console.log(row('Avg pairwise corr', portfolios.map(p => p.avgPairwiseCorr.toFixed(3))));
  console.log(row('Negative pair %', portfolios.map(p => `${(p.negativePairFrac * 100).toFixed(1)}%`)));
  console.log(row('Avg Var(z_i-z_j)', portfolios.map(p => p.avgVarDiff.toFixed(1))));
  console.log(midBorder);

  // World Coverage
  console.log(row('Coverage (top 0.1%)', portfolios.map(p => `${(p.coverageTop01 * 100).toFixed(1)}%`)));
  console.log(row('Coverage (top 1%)', portfolios.map(p => `${(p.coverageTop1 * 100).toFixed(1)}%`)));
  console.log(row('Coverage (top 5%)', portfolios.map(p => `${(p.coverageTop5 * 100).toFixed(1)}%`)));
  console.log(midBorder);

  // Exposure
  console.log(row('Max exposure', portfolios.map(p => `${(p.maxExposure * 100).toFixed(1)}%`)));
  console.log(row('Unique players', portfolios.map(p => String(p.uniquePlayers))));
  console.log(botBorder);
}

function printExposureTable(m: PortfolioMetrics): void {
  if (m.topExposures.length === 0) return;

  console.log(`\nTOP PLAYER EXPOSURES — ${m.label} (${m.entryCount} entries)`);

  const nameW = 24;
  const colW = 10;

  const topBorder = `+${'-'.repeat(nameW)}+${'-'.repeat(colW)}+${'-'.repeat(colW)}+${'-'.repeat(colW)}+`;

  const row = (name: string, proP: string, fieldP: string, lev: string) => {
    return `| ${name.padEnd(nameW - 1)}| ${proP.padStart(colW - 2)} | ${fieldP.padStart(colW - 2)} | ${lev.padStart(colW - 2)} |`;
  };

  console.log(topBorder);
  console.log(row('Player', 'Pro %', 'Field %', 'Leverage'));
  console.log(topBorder);

  for (const exp of m.topExposures.slice(0, 8)) {
    const name = exp.name.length > nameW - 2 ? exp.name.slice(0, nameW - 4) + '..' : exp.name;
    console.log(row(
      name,
      `${(exp.proExposure * 100).toFixed(1)}%`,
      `${(exp.fieldOwnership * 100).toFixed(1)}%`,
      exp.leverage > 0 ? `${exp.leverage.toFixed(2)}x` : 'n/a',
    ));
  }
  console.log(topBorder);
}
