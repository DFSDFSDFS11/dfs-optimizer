/**
 * Evil Twin Hedging — Liu et al. Section 5.3.
 *
 * For the highest-marginal-gain entries in a portfolio, construct an
 * anti-correlated "twin" that covers the opposite game script. The twin
 * is found from the candidate pool by minimizing world-score correlation
 * with the primary, subject to swap-count and projection constraints.
 *
 * After twin construction, the lowest-marginal-gain primaries are REPLACED
 * with twins (portfolio size stays fixed).
 */

import { Lineup } from '../types';
import { SlatePrecomputation } from './algorithm7-selector';
import { pearsonRow, scoreLineups, computeMeanAndVar } from '../analysis/sim/sim-core';

// ============================================================
// TYPES
// ============================================================

export interface EvilTwinParams {
  twinFraction: number;           // 0.25 = replace 25% of portfolio with twins
  minAntiCorrelation: number;     // max acceptable ρ for twin (e.g. 0.10 = ρ < 0.10)
  minProjectionRatio: number;     // 0.80 = twin projection ≥ 80% of primary
  maxPlayersSwapped: number;      // 4 = differ by at most 4 players
}

export const DEFAULT_EVIL_TWIN_PARAMS: EvilTwinParams = {
  twinFraction: 0.25,
  minAntiCorrelation: 0.15,   // accept twin with ρ < 0.15 (below portfolio avg ~0.21)
  minProjectionRatio: 0.70,
  maxPlayersSwapped: 8,       // MLB-10 can swap up to 8 (keep only 2 from primary)
};

export interface TwinPair {
  primaryIdx: number;
  twinIdx: number;               // index into candidate pool
  correlation: number;
  playersSwapped: number;
  primaryProjection: number;
  twinProjection: number;
}

export interface EvilTwinDiagnostics {
  targetTwinCount: number;
  actualTwinCount: number;
  twinPairs: TwinPair[];
  avgCorrelationBefore: number;
  avgCorrelationAfter: number;
  negativePairFractionBefore: number;
  negativePairFractionAfter: number;
}

// ============================================================
// MAIN
// ============================================================

export function applyEvilTwinHedging(
  portfolio: Lineup[],
  precomp: SlatePrecomputation,
  params: EvilTwinParams,
  marginalGains?: number[],     // per-entry marginal gain from prior selection (optional)
): { portfolio: Lineup[]; diagnostics: EvilTwinDiagnostics } {
  const N = portfolio.length;
  const W = precomp.W;
  const targetTwinCount = Math.floor(N * params.twinFraction);

  // Score portfolio entries across worlds
  const portfolioScores = scoreLineups(portfolio, precomp);
  const { means: pMeans } = computeMeanAndVar(portfolioScores, N, W);

  // Score the full candidate pool
  const C = precomp.C;
  const candScores = precomp.candidateWorldScores;
  const candMeans = precomp.candidateMeanScore;

  // Build hash→candIdx for pool
  const hashToCand = new Map<string, number>();
  for (let c = 0; c < C; c++) hashToCand.set(precomp.candidatePool[c].hash, c);

  // Rank portfolio entries by marginal gain (highest = most valuable = construct twin for these)
  const gains = marginalGains || portfolio.map(() => 1);
  const ranked = portfolio.map((lu, i) => ({ lu, i, gain: gains[i] }))
    .sort((a, b) => b.gain - a.gain);

  // Pre-compute avg correlation BEFORE twinning (sample 300 pairs)
  const { avgCorr: avgCorrBefore, negFrac: negFracBefore } = samplePairStats(portfolioScores, N, W, pMeans);

  // Find twins for top entries
  const twinPairs: TwinPair[] = [];
  const usedTwinHashes = new Set<string>();
  const portfolioHashes = new Set(portfolio.map(l => l.hash));

  for (const { lu, i } of ranked) {
    if (twinPairs.length >= targetTwinCount) break;

    const primaryProj = lu.projection;
    const primaryIds = new Set(lu.players.map(p => p.id));

    let bestCandIdx = -1;
    let bestCorr = params.minAntiCorrelation; // ceiling — only accept ρ below this

    for (let c = 0; c < C; c++) {
      const cand = precomp.candidatePool[c];
      if (portfolioHashes.has(cand.hash)) continue;
      if (usedTwinHashes.has(cand.hash)) continue;

      // Projection constraint
      if (cand.projection < primaryProj * params.minProjectionRatio) continue;

      // Swap-count constraint
      let shared = 0;
      for (const p of cand.players) if (primaryIds.has(p.id)) shared++;
      const swapped = lu.players.length - shared;
      if (swapped > params.maxPlayersSwapped) continue;
      if (swapped < 2) continue;  // must differ by at least 2

      // Compute correlation between primary[i] and candidate[c]
      // primary scores: portfolioScores[i*W..i*W+W]
      // candidate scores: candScores[c*W..c*W+W]
      let num = 0, dA = 0, dB = 0;
      const oi = i * W;
      const oc = c * W;
      const mA = pMeans[i], mB = candMeans[c];
      for (let w = 0; w < W; w++) {
        const a = portfolioScores[oi + w] - mA;
        const b = candScores[oc + w] - mB;
        num += a * b; dA += a * a; dB += b * b;
      }
      const denom = Math.sqrt(dA * dB);
      const corr = denom > 1e-12 ? num / denom : 0;

      if (corr < bestCorr) {
        bestCorr = corr;
        bestCandIdx = c;
      }
    }

    if (bestCandIdx < 0) continue;

    const twin = precomp.candidatePool[bestCandIdx];
    const swapped = lu.players.length - lu.players.filter(p => twin.players.some(t => t.id === p.id)).length;

    twinPairs.push({
      primaryIdx: i,
      twinIdx: bestCandIdx,
      correlation: bestCorr,
      playersSwapped: swapped,
      primaryProjection: primaryProj,
      twinProjection: twin.projection,
    });
    usedTwinHashes.add(twin.hash);
  }

  // Replace lowest-gain entries with twins
  const result = [...portfolio];
  const replaced = new Set<number>();

  // Sort by lowest gain to find replacement targets
  const lowestGain = [...ranked].reverse();
  let replacementIdx = 0;

  for (const pair of twinPairs) {
    // Find next unreplaced lowest-gain entry (not a primary we're twinning)
    while (replacementIdx < lowestGain.length) {
      const target = lowestGain[replacementIdx].i;
      if (!replaced.has(target) && !twinPairs.some(p => p.primaryIdx === target)) {
        result[target] = precomp.candidatePool[pair.twinIdx];
        replaced.add(target);
        replacementIdx++;
        break;
      }
      replacementIdx++;
    }
  }

  // Compute post-twinning correlation stats
  const afterScores = scoreLineups(result, precomp);
  const { means: afterMeans } = computeMeanAndVar(afterScores, result.length, W);
  const { avgCorr: avgCorrAfter, negFrac: negFracAfter } = samplePairStats(afterScores, result.length, W, afterMeans);

  console.log(`  evil twin: ${twinPairs.length}/${targetTwinCount} twins created`);
  console.log(`    avg pairwise corr: ${avgCorrBefore.toFixed(3)} → ${avgCorrAfter.toFixed(3)}`);
  console.log(`    negative pair %:   ${(negFracBefore * 100).toFixed(1)}% → ${(negFracAfter * 100).toFixed(1)}%`);
  if (twinPairs.length > 0) {
    const avgTwinCorr = twinPairs.reduce((s, p) => s + p.correlation, 0) / twinPairs.length;
    console.log(`    avg twin ρ:        ${avgTwinCorr.toFixed(3)}`);
  }

  return {
    portfolio: result,
    diagnostics: {
      targetTwinCount,
      actualTwinCount: twinPairs.length,
      twinPairs,
      avgCorrelationBefore: avgCorrBefore,
      avgCorrelationAfter: avgCorrAfter,
      negativePairFractionBefore: negFracBefore,
      negativePairFractionAfter: negFracAfter,
    },
  };
}

// ============================================================
// HELPERS
// ============================================================

function samplePairStats(
  scores: Float32Array,
  N: number,
  W: number,
  means: Float64Array,
): { avgCorr: number; negFrac: number } {
  const maxPairs = 300;
  let seed = 31;
  const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };
  let sumCorr = 0, negCount = 0, count = 0;
  for (let p = 0; p < maxPairs && N >= 2; p++) {
    const i = Math.floor(rng() * N);
    let j = Math.floor(rng() * (N - 1));
    if (j >= i) j++;
    const corr = pearsonRow(scores, i, j, W, means[i], means[j]);
    sumCorr += corr;
    if (corr < 0) negCount++;
    count++;
  }
  return {
    avgCorr: count > 0 ? sumCorr / count : 0,
    negFrac: count > 0 ? negCount / count : 0,
  };
}
