/**
 * V31 Objective — Three research-grounded corrections to the BQP.
 *
 * Fix 1: Threshold-aware variance  → Var(R_w - G(r')) not just Var(R_w)
 * Fix 2: Complete σ_{δ,G}         → anchor cascading correlations
 * Fix 3: Tilted projections        → E[s_j | top-1%] not E[s_j]
 *
 * All operate on existing precomp arrays — no new simulation needed.
 */

import { Lineup, Player } from '../types';
import { SlatePrecomputation } from './algorithm7-selector';

// ============================================================
// FIX 1: THRESHOLD-AWARE VARIANCE
// ============================================================

export interface ThresholdMoments {
  perWorld: Float32Array;   // threshold score in each world [W]
  mean: number;
  variance: number;
}

export function computeThresholdMoments(precomp: SlatePrecomputation, percentile: number = 0.01): ThresholdMoments {
  const W = precomp.W;
  const perWorld = percentile <= 0.01 ? precomp.thresh1 : precomp.thresh5;
  let sum = 0;
  for (let w = 0; w < W; w++) sum += perWorld[w];
  const mean = sum / W;
  let ss = 0;
  for (let w = 0; w < W; w++) { const d = perWorld[w] - mean; ss += d * d; }
  const variance = W > 1 ? ss / (W - 1) : 0;
  return { perWorld, mean, variance };
}

export function computeCandidateCovWithThreshold(
  precomp: SlatePrecomputation,
  threshMoments: ThresholdMoments,
): Float64Array {
  const { W, C, candidateWorldScores, candidateMeanScore } = precomp;
  const covs = new Float64Array(C);
  for (let c = 0; c < C; c++) {
    let sum = 0;
    const cm = candidateMeanScore[c];
    for (let w = 0; w < W; w++) {
      sum += (candidateWorldScores[c * W + w] - cm) * (threshMoments.perWorld[w] - threshMoments.mean);
    }
    covs[c] = W > 1 ? sum / (W - 1) : 0;
  }
  return covs;
}

export function computeGapVariance(
  candidateVariance: number,
  thresholdVariance: number,
  covWithThreshold: number,
): number {
  return Math.max(0, candidateVariance + thresholdVariance - 2 * covWithThreshold);
}

// ============================================================
// FIX 2: COMPLETE σ_{δ,G} WITH ANCHOR COMPONENT
// ============================================================

export interface AnchorAnalysis {
  anchorWeights: Map<string, number>;
  clusterStrength: Map<string, Map<string, number>>;  // P(B in lineup | A in lineup)
}

export function computeAnchorAnalysis(
  fieldLineups: Lineup[],
  players: Player[],
): AnchorAnalysis {
  const N = fieldLineups.length;
  if (N === 0) return { anchorWeights: new Map(), clusterStrength: new Map() };

  // Count per-player appearances and pair co-occurrences
  const playerCount = new Map<string, number>();
  const pairCount = new Map<string, number>();
  for (const l of fieldLineups) {
    const ids = l.players.map(p => p.id);
    for (const id of ids) playerCount.set(id, (playerCount.get(id) || 0) + 1);
    for (let a = 0; a < ids.length; a++) {
      for (let b = a + 1; b < ids.length; b++) {
        const key = ids[a] < ids[b] ? `${ids[a]}|${ids[b]}` : `${ids[b]}|${ids[a]}`;
        pairCount.set(key, (pairCount.get(key) || 0) + 1);
      }
    }
  }

  const anchorWeights = new Map<string, number>();
  const clusterStrength = new Map<string, Map<string, number>>();

  for (const p of players) {
    const countA = playerCount.get(p.id) || 0;
    if (countA < 5) continue;

    const cluster = new Map<string, number>();
    let totalCondProb = 0;
    let pairN = 0;
    for (const q of players) {
      if (p.id === q.id) continue;
      const key = p.id < q.id ? `${p.id}|${q.id}` : `${q.id}|${p.id}`;
      const both = pairCount.get(key) || 0;
      const condProb = both / countA;  // P(q | p)
      if (condProb > 0.05) {
        cluster.set(q.id, condProb);
        totalCondProb += condProb;
        pairN++;
      }
    }
    clusterStrength.set(p.id, cluster);
    anchorWeights.set(p.id, pairN > 0 ? (totalCondProb / pairN) * (countA / N) : 0);
  }

  return { anchorWeights, clusterStrength };
}

export function computeCompleteSigmaThreshold(
  precomp: SlatePrecomputation,
  anchorAnalysis: AnchorAnalysis,
): Float64Array {
  const C = precomp.C;
  const basePenalty = precomp.candidateCovPenalty;
  const completePenalty = new Float64Array(C);

  for (let c = 0; c < C; c++) {
    let anchorBoost = 0;
    for (const p of precomp.candidatePool[c].players) {
      const aw = anchorAnalysis.anchorWeights.get(p.id) || 0;
      const cluster = anchorAnalysis.clusterStrength.get(p.id);
      if (!cluster || aw < 0.01) continue;
      // Boost proportional to how many of THIS lineup's other players
      // are in the anchor's correlation cluster
      let clusterOverlap = 0;
      for (const q of precomp.candidatePool[c].players) {
        if (q.id === p.id) continue;
        const condProb = cluster.get(q.id) || 0;
        clusterOverlap += condProb;
      }
      anchorBoost += aw * clusterOverlap;
    }
    completePenalty[c] = basePenalty[c] + anchorBoost;
  }

  return completePenalty;
}

// ============================================================
// FIX 3: TILTED PROJECTIONS
// ============================================================

export function computeTiltedProjections(
  precomp: SlatePrecomputation,
  topFraction: number = 0.01,
): Float64Array {
  const { W, P, playerWorldScores } = precomp;
  const tilted = new Float64Array(P);
  const topCount = Math.max(1, Math.floor(W * topFraction));

  for (let p = 0; p < P; p++) {
    // Extract this player's scores across all worlds
    const scores = new Float64Array(W);
    for (let w = 0; w < W; w++) scores[w] = playerWorldScores[p * W + w];
    // Sort descending, take top fraction
    scores.sort();  // ascending
    let sum = 0;
    for (let i = W - topCount; i < W; i++) sum += scores[i];
    tilted[p] = sum / topCount;
  }

  return tilted;
}

export function computeCandidateTiltedProjection(
  precomp: SlatePrecomputation,
  tiltedPlayerProj: Float64Array,
): Float64Array {
  const C = precomp.C;
  const tiltedCandProj = new Float64Array(C);

  for (let c = 0; c < C; c++) {
    let sum = 0;
    for (const p of precomp.candidatePool[c].players) {
      const pIdx = precomp.indexMap.get(p.id);
      if (pIdx !== undefined) sum += tiltedPlayerProj[pIdx];
    }
    tiltedCandProj[c] = sum;
  }

  return tiltedCandProj;
}

// ============================================================
// COMBINED V31 SCORING
// ============================================================

export interface V31Context {
  threshMoments: ThresholdMoments;
  candCovWithThresh: Float64Array;   // [C] Cov(candidate, threshold)
  completeSigma: Float64Array;       // [C] complete σ_{δ,G} with anchor
  tiltedProj: Float64Array;          // [C] tilted candidate projections
}

export function buildV31Context(
  precomp: SlatePrecomputation,
  fieldLineups: Lineup[],
  players: Player[],
): V31Context {
  console.log(`  v31 fix 1: computing threshold moments…`);
  const threshMoments = computeThresholdMoments(precomp, 0.01);
  const candCovWithThresh = computeCandidateCovWithThreshold(precomp, threshMoments);

  console.log(`  v31 fix 2: computing anchor analysis (${fieldLineups.length} field lineups)…`);
  const anchorAnalysis = computeAnchorAnalysis(fieldLineups, players);
  const completeSigma = computeCompleteSigmaThreshold(precomp, anchorAnalysis);

  console.log(`  v31 fix 3: computing tilted projections (top 1% of ${precomp.W} worlds)…`);
  const tiltedPlayerProj = computeTiltedProjections(precomp, 0.01);
  const tiltedProj = computeCandidateTiltedProjection(precomp, tiltedPlayerProj);

  // Diagnostic: compare raw vs tilted projection for top candidates
  const topByRaw = [...Array(Math.min(5, precomp.C)).keys()]
    .sort((a, b) => precomp.candidateProjection[b] - precomp.candidateProjection[a]);
  console.log(`    raw vs tilted projection (top 5 by raw):`);
  for (const c of topByRaw) {
    console.log(`      raw=${precomp.candidateProjection[c].toFixed(1)} tilted=${tiltedProj[c].toFixed(1)} (${((tiltedProj[c] / precomp.candidateProjection[c] - 1) * 100).toFixed(0)}% boost)`);
  }

  // Diagnostic: compare base vs complete σ_{δ,G}
  let baseMean = 0, compMean = 0;
  for (let c = 0; c < precomp.C; c++) { baseMean += precomp.candidateCovPenalty[c]; compMean += completeSigma[c]; }
  baseMean /= precomp.C; compMean /= precomp.C;
  console.log(`    σ_{δ,G}: base avg=${baseMean.toFixed(2)} → complete avg=${compMean.toFixed(2)} (${((compMean / baseMean - 1) * 100).toFixed(0)}% increase)`);

  // Diagnostic: threshold variance
  console.log(`    threshold: mean=${threshMoments.mean.toFixed(1)} var=${threshMoments.variance.toFixed(1)} sd=${Math.sqrt(threshMoments.variance).toFixed(1)}`);

  return { threshMoments, candCovWithThresh, completeSigma, tiltedProj };
}

/**
 * V31 per-candidate score for a given (lambdaVar, lambdaSigma) pair.
 *
 *   score = tiltedProj[c]
 *         - lambdaVar × √(Var(R_c) + Var(G) - 2·Cov(R_c, G))
 *         - lambdaSigma × completeSigma[c]
 */
export function v31Score(
  c: number,
  ctx: V31Context,
  precomp: SlatePrecomputation,
  lambdaVar: number,
  lambdaSigma: number,
): number {
  const gapVar = computeGapVariance(
    precomp.candidateVariance[c],
    ctx.threshMoments.variance,
    ctx.candCovWithThresh[c],
  );
  return ctx.tiltedProj[c]
    - lambdaVar * Math.sqrt(gapVar)
    - lambdaSigma * ctx.completeSigma[c];
}
