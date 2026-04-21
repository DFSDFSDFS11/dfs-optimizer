/**
 * Hedging Selector — Liu et al. Theorem 4 aligned portfolio construction.
 *
 * The GPP objective is E[max(z_1,...,z_m)] — the expected score of the BEST
 * entry in the portfolio, not the sum. Liu et al. (2023) Proposition 4 gives
 * the m=2 closed form:
 *
 *     E[max(z₁,z₂)] ∝ √( Var(z₁) + Var(z₂) − 2·Cov(z₁,z₂) )
 *                   = √ Var(z₁ − z₂)
 *
 * The expected max is driven by the STANDARD DEVIATION OF THE DIFFERENCE
 * between entries. Each entry needs high individual variance and low (ideally
 * negative) covariance with every other entry.
 *
 * For m>2 this generalizes to: at each step, pick the candidate that
 * maximizes Σ_{j ∈ portfolio} Var(z_c − z_j). This is the primary selection
 * signal. Marginal payout reward is a weak secondary signal that we blend in
 * with weight α because payout simulations are noisier than the correlation
 * structure they're built on.
 *
 * Score(c, portfolio W*) = α · (rawPayout[c] / medPayout)
 *                        + (1 − α) · (Σ Var(z_c − z_j) / M) / medVarDiff
 *
 * Subject to:
 *   - Projection floor: candidate projection >= pctile of pool
 *     (drops lineups that are structurally too weak to win even if hedged).
 *   - Correlation constraint: |Corr(c, j)| < ρ_max for all j ∈ portfolio.
 *   - Exposure cap: no single player exceeds maxExposure fraction of entries.
 *
 * Entry 1 is pure projection (Liu Theorem 4 says entry 1 picks the highest
 * mean). Each subsequent entry maximizes variance-of-difference while keeping
 * the high-confidence projection core implied by the projection floor.
 *
 * Sport-specific blend α:
 *   NBA α=0.7  — projection dominates, hedging is noise-chasing
 *   MLB α=0.3  — stacks create genuine anti-correlation, hedging dominates
 *   NFL α=0.4  — moderate hedging value
 *
 * Reuses the existing SlatePrecomputation (candidateWorldScores Float32Array,
 * sortedFieldByWorld, candidateMeanScore, candidateVariance) so a single
 * precompute serves both Algorithm 7 and the hedging selector — switch via
 * the `--selector` CLI flag.
 */

import { Lineup } from '../types';
import {
  SlatePrecomputation,
  SelectorParams,
} from './algorithm7-selector';

// ============================================================
// PARAMS
// ============================================================

export interface HedgingParams {
  /** Max correlation allowed between any two selected entries. */
  rhoMax: number;
  /** Step by which ρ_max is relaxed when no candidate satisfies the constraint. */
  rhoRelaxStep: number;
  /** Hard cap on relaxed ρ_max — beyond this, give up and stop filling. */
  rhoMaxCeiling: number;
  /**
   * Blend between independent payout and variance-of-difference:
   *   score = α · (rawPayout/medPayout) + (1-α) · (varDiff/medVarDiff)
   * α=0  → pure Liu-style variance-of-difference (hedging-dominant)
   * α=1  → pure independent payout (projection-dominant)
   */
  alpha: number;
  /**
   * Projection floor percentile: only consider candidates whose projection
   * is in the top (1 − projectionFloor) fraction of the pool. e.g.
   * projectionFloor=0.60 means "drop the bottom 60%, keep top 40% by projection".
   * Prevents garbage lineups from being selected just because they're
   * anti-correlated with the portfolio.
   */
  projectionFloor: number;
  /** Max fraction of selected lineups any single player may appear in. */
  maxExposure: number;
}

export const DEFAULT_HEDGING_PARAMS: HedgingParams = {
  rhoMax: 0.65,
  rhoRelaxStep: 0.05,
  rhoMaxCeiling: 0.95,
  alpha: 0.5,
  projectionFloor: 0.50,
  maxExposure: 0.30,
};

export function getHedgingSportDefaults(sport: string): Partial<HedgingParams> {
  switch (sport) {
    case 'nba':
      // NBA is projection-accuracy dominant: the hedging selector is NOT
      // recommended for NBA — prefer --selector algorithm7 (1.78x baseline
      // on 17 historical slates). Best hedging config for NBA is α=0.9 with
      // projection floor at top 30%, reaching ~1.31x — still below alg7.
      return {
        rhoMax: 0.80,
        alpha: 0.9,
        projectionFloor: 0.70,
        maxExposure: 0.40,
      };
    case 'mlb':
      // MLB rewards aggressive hedging — keep top 60% of pool, hedging-dominant.
      return {
        rhoMax: 0.60,
        alpha: 0.3,
        projectionFloor: 0.40,
        maxExposure: 0.25,
      };
    case 'nfl':
      return {
        rhoMax: 0.65,
        alpha: 0.4,
        projectionFloor: 0.50,
        maxExposure: 0.30,
      };
    default:
      return {};
  }
}

// ============================================================
// DIAGNOSTICS
// ============================================================

export interface HedgingDiagnostics {
  selectedCount: number;

  // Correlation structure
  avgPairwiseCorrelation: number;
  maxPairwiseCorrelation: number;
  minPairwiseCorrelation: number;
  /** Histogram bins: [-1,-0.5), [-0.5,0), [0,0.5), [0.5,1] */
  correlationHistogram: [number, number, number, number];

  // World coverage by tier (percentile → coverage rate)
  coverageByTier: { percentile: number; rate: number }[];

  // Player exposure
  maxPlayerExposure: number;
  exposureP95: number;

  // Projection vs diversity
  avgSelectedProjection: number;
  avgPoolProjection: number;
  portfolioDiversityScore: number;

  // Calibration
  alpha: number;
  medPayoutNorm: number;
  medVarDiffNorm: number;
  rhoMaxFinal: number;
  rhoRelaxations: number;
  selectionTimeMs: number;
  /** Number of candidates that survived the projection floor. */
  poolAfterProjectionFloor: number;
}

// ============================================================
// MAIN SELECTOR
// ============================================================

export function hedgingSelect(
  precomp: SlatePrecomputation,
  params: SelectorParams,
  hedging: HedgingParams,
): { selected: Lineup[]; diagnostics: HedgingDiagnostics } {
  const t0 = Date.now();
  const {
    W, C,
    candidateWorldScores,
    candidateMeanScore,
    candidateVariance,
    candidateProjection,
    sortedFieldByWorld,
    candidatePool,
  } = precomp;
  const N = params.N;
  const rosterSize = candidatePool[0]?.players.length ?? 8;

  // ─── PRE-COMPUTE per-candidate norms (for fast Pearson correlation) ───
  // norm[c] = sqrt(Σ_w (s_cw - mean_c)^2) = sqrt((W-1) * variance_c)
  const candidateNorms = new Float64Array(C);
  for (let c = 0; c < C; c++) {
    candidateNorms[c] = Math.sqrt(Math.max(0, candidateVariance[c]) * Math.max(1, W - 1));
  }

  // ─── PROJECTION FLOOR PRE-FILTER ───
  // Drop the bottom `projectionFloor` fraction of the candidate pool by
  // projection. Liu et al. Theorem 4 requires the "high-confidence core" to
  // be preserved; a sub-median candidate doesn't belong in any GPP portfolio
  // even if it hedges perfectly with the existing entries.
  const projFloorMask = new Uint8Array(C);
  {
    const sortedProj = Array.from({ length: C }, (_, i) => candidateProjection[i])
      .sort((a, b) => a - b);
    const floorIdx = Math.min(C - 1, Math.floor(C * hedging.projectionFloor));
    const floorProj = sortedProj[floorIdx];
    for (let c = 0; c < C; c++) {
      projFloorMask[c] = candidateProjection[c] >= floorProj ? 1 : 0;
    }
  }
  let poolAfterProjectionFloor = 0;
  for (let c = 0; c < C; c++) if (projFloorMask[c]) poolAfterProjectionFloor++;

  // ─── PRE-COMPUTE per-candidate independent expected payout ───
  // rawPayout[c] = (1/W) Σ_w payout(rank(c, w))
  // Independent of portfolio state — computed ONCE. This is the "sum of
  // per-entry payouts" term (each entry earns its own payout regardless of
  // the rest of the portfolio) from the combined H-S × Liu objective.
  const rawPayout = new Float64Array(C);
  for (let c = 0; c < C; c++) {
    if (!projFloorMask[c]) continue;
    const base = c * W;
    let totalPayout = 0;
    for (let w = 0; w < W; w++) {
      const cs = candidateWorldScores[base + w];
      const sortedField = sortedFieldByWorld[w];
      const F = sortedField.length;
      // Binary search: count of field entries with score ≤ cs
      let lo = 0, hi = F;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (sortedField[mid] <= cs) lo = mid + 1;
        else hi = mid;
      }
      const rank = F - lo + 1;
      totalPayout += getPayoutForRank(rank, F);
    }
    rawPayout[c] = totalPayout / W;
  }

  // ─── COVERAGE TRACKING (diagnostic only — NOT in scoring) ───
  // Liu Theorem 4 doesn't need coverage explicitly; the variance-of-difference
  // objective captures it implicitly. But we still track top 0.1/1/5% world
  // coverage for diagnostics.
  const diagnosticTiers = [
    { percentile: 0.001 },
    { percentile: 0.01 },
    { percentile: 0.05 },
  ];
  const numTiers = diagnosticTiers.length;
  const tierHits: Uint8Array[] = new Array(numTiers);
  for (let t = 0; t < numTiers; t++) {
    const pct = diagnosticTiers[t].percentile;
    const thresh = new Float32Array(W);
    for (let w = 0; w < W; w++) {
      const sortedField = sortedFieldByWorld[w];
      const F = sortedField.length;
      const idx = Math.max(0, F - Math.max(1, Math.floor(F * pct)));
      thresh[w] = sortedField[Math.min(F - 1, idx)];
    }
    const hits = new Uint8Array(C * W);
    for (let c = 0; c < C; c++) {
      const base = c * W;
      for (let w = 0; w < W; w++) {
        if (candidateWorldScores[base + w] >= thresh[w]) hits[base + w] = 1;
      }
    }
    tierHits[t] = hits;
  }

  // ─── INITIALIZE selection state ───
  const selected: Lineup[] = [];
  const selectedCi: number[] = [];
  const selectedVars: number[] = [];

  // Per-tier coverage bitsets for diagnostics only
  const coveredByTier: Uint8Array[] = new Array(numTiers);
  for (let t = 0; t < numTiers; t++) coveredByTier[t] = new Uint8Array(W);
  const coveredCounts = new Int32Array(numTiers);

  // Per-candidate sumCov — running sum of cov(c, s) across selected entries s.
  //   varDiffBonus(c) = var(c) + avg(var(s)) − 2 · sumCov(c) / M
  // This IS the Liu et al. Eq. 14 term, and it's the PRIMARY selection signal.
  const sumCov = new Float64Array(C);

  // Active candidate set — projection floor applied upfront
  const active = new Uint8Array(C);
  for (let c = 0; c < C; c++) active[c] = projFloorMask[c];

  // Per-player exposure tracking
  const exposureCount = new Map<string, number>();
  const exposureCap = hedging.maxExposure > 0 && hedging.maxExposure < 1
    ? Math.max(1, Math.ceil(N * hedging.maxExposure))
    : N;

  // Precompute per-candidate player ID lists for exposure check
  const candidatePlayerIds: string[][] = candidatePool.map(lu => lu.players.map(p => p.id));

  // ─── SAMPLE-BASED NORMALIZATION CONSTANTS ───
  // Compute medPayout and medVarDiff from a 200-candidate sample drawn from
  // the projection-floor-filtered pool. The score blend is:
  //   score(c) = α · (rawPayout[c] / medPayout)
  //            + (1 − α) · (varDiff(c)  / medVarDiff)
  // Normalizing both terms to O(1) lets α directly control the blend between
  // independent-payout and hedging regardless of scale.
  // medVarDiff is computed against a "reference entry" — the highest-projection
  // candidate — since we don't have a portfolio yet when calibrating.
  const activeIndices: number[] = [];
  for (let c = 0; c < C; c++) if (active[c]) activeIndices.push(c);
  const activeCount = activeIndices.length;
  const refCi = activeIndices.reduce(
    (best, c) => candidateProjection[c] > candidateProjection[best] ? c : best,
    activeIndices[0] ?? 0,
  );
  const refMean = candidateMeanScore[refCi];
  const refBase = refCi * W;

  const sampleSize = Math.min(200, activeCount);
  const samplePayouts: number[] = [];
  const sampleVarDiffs: number[] = [];
  for (let s = 0; s < sampleSize; s++) {
    const c = activeIndices[Math.floor((s * activeCount) / sampleSize)];
    samplePayouts.push(rawPayout[c]);
    // Var(z_c − z_ref) = Var(z_c) + Var(z_ref) − 2·Cov(z_c, z_ref)
    const baseC = c * W;
    const meanC = candidateMeanScore[c];
    let dot = 0;
    for (let w = 0; w < W; w++) {
      dot += (candidateWorldScores[baseC + w] - meanC) *
             (candidateWorldScores[refBase + w] - refMean);
    }
    const cov = dot / Math.max(1, W - 1);
    const varDiff = candidateVariance[c] + candidateVariance[refCi] - 2 * cov;
    sampleVarDiffs.push(Math.max(0, varDiff));
  }
  const medPayoutNorm = median(samplePayouts.filter(r => r > 0)) || 1;
  const medVarDiffNorm = median(sampleVarDiffs.filter(v => v > 0)) || 1;

  console.log(
    `  [hedging] projection floor: ${poolAfterProjectionFloor}/${C} candidates survived (top ${((1 - hedging.projectionFloor) * 100).toFixed(0)}%)`,
  );
  console.log(
    `  [hedging] α=${hedging.alpha.toFixed(2)}  medPayout=${medPayoutNorm.toFixed(3)}  medVarDiff=${medVarDiffNorm.toFixed(1)}`,
  );

  let rhoMaxCurrent = hedging.rhoMax;
  let rhoRelaxations = 0;

  // ─── MAIN SELECTION LOOP ───
  // Liu Theorem 4 direct implementation:
  //   Entry 1: pure maximum projection (λ=0 / H-S Proposition 4.1 base case).
  //   Entry i>=2: maximize α·normPayout + (1−α)·normVarDiff, where
  //     normPayout  = rawPayout[c] / medPayout  (static, pre-computed)
  //     normVarDiff = varDiff(c)   / medVarDiff (depends on portfolio state)
  //     varDiff(c)  = var(c) + avg(var_selected) − 2·sumCov[c]/M  (Liu Eq. 14)
  // The correlation constraint (ρ_max), exposure cap, and projection floor
  // are enforced by the `active` filter.
  for (let i = 0; i < N; i++) {
    let bestCi = -1;
    let bestScore = -Infinity;
    let bestPayout = 0;
    let bestVarDiff = 0;

    const M = selected.length;
    const avgVarSelected = M > 0 ? selectedVars.reduce((a, b) => a + b, 0) / M : 0;

    if (M === 0) {
      // Entry 1: highest projection among active candidates.
      let bProj = -Infinity;
      for (let c = 0; c < C; c++) {
        if (!active[c]) continue;
        if (candidateProjection[c] > bProj) {
          bProj = candidateProjection[c];
          bestCi = c;
        }
      }
      if (bestCi >= 0) {
        bestPayout = rawPayout[bestCi];
        bestVarDiff = candidateVariance[bestCi];
      }
    } else {
      // Entries 2..N: maximize the α-blended score.
      for (let c = 0; c < C; c++) {
        if (!active[c]) continue;
        const varDiff = candidateVariance[c] + avgVarSelected - 2 * (sumCov[c] / M);
        const normP = rawPayout[c] / medPayoutNorm;
        const normV = Math.max(0, varDiff) / medVarDiffNorm;
        const score = hedging.alpha * normP + (1 - hedging.alpha) * normV;
        if (score > bestScore) {
          bestScore = score;
          bestCi = c;
          bestPayout = rawPayout[c];
          bestVarDiff = varDiff;
        }
      }
    }

    if (bestCi === -1) {
      // No active candidates. Try relaxing ρ_max.
      if (rhoMaxCurrent < hedging.rhoMaxCeiling) {
        rhoMaxCurrent = Math.min(hedging.rhoMaxCeiling, rhoMaxCurrent + hedging.rhoRelaxStep);
        rhoRelaxations++;
        console.warn(
          `  [hedging] entry ${i + 1}: relaxing ρ_max → ${rhoMaxCurrent.toFixed(2)}`,
        );
        // Re-filter from scratch using the relaxed bound
        refilterByCorrelation(
          active, selectedCi, candidateWorldScores, candidateMeanScore,
          candidateNorms, W, rhoMaxCurrent, exposureCount, candidatePlayerIds, exposureCap,
        );
        i--;
        continue;
      }
      console.warn(`  [hedging] entry ${i + 1}: pool exhausted at ρ_max=${rhoMaxCurrent.toFixed(2)}`);
      break;
    }

    // ── COMMIT pick ──
    selected.push(candidatePool[bestCi]);
    selectedCi.push(bestCi);
    selectedVars.push(candidateVariance[bestCi]);
    active[bestCi] = 0;

    // Update tier coverage bitsets (diagnostic only)
    for (let t = 0; t < numTiers; t++) {
      const hits = tierHits[t];
      const cov = coveredByTier[t];
      const base = bestCi * W;
      for (let w = 0; w < W; w++) {
        if (hits[base + w] === 1 && cov[w] === 0) {
          cov[w] = 1;
          coveredCounts[t]++;
        }
      }
    }

    // Update exposure counts
    for (const pid of candidatePlayerIds[bestCi]) {
      exposureCount.set(pid, (exposureCount.get(pid) ?? 0) + 1);
    }

    // ── Incrementally update sumCov[c] for ALL candidates ──
    // sumCov[c] += cov(c, bestCi) where cov = (1/(W-1)) Σ (s_cw - mean_c)(s_bw - mean_b)
    {
      const baseB = bestCi * W;
      const meanB = candidateMeanScore[bestCi];
      for (let c = 0; c < C; c++) {
        const baseC = c * W;
        const meanC = candidateMeanScore[c];
        let dot = 0;
        for (let w = 0; w < W; w++) {
          dot += (candidateWorldScores[baseC + w] - meanC) *
                 (candidateWorldScores[baseB + w] - meanB);
        }
        sumCov[c] += dot / Math.max(1, W - 1);
      }
    }

    // ── FILTER active candidates against the new pick ──
    // Constraint 1: correlation > ρ_max  →  drop
    // Constraint 2: player overlap ≥ rosterSize - 1 → drop (anti-duplicate)
    // Constraint 3: would push some player over exposure cap → drop
    {
      const baseB = bestCi * W;
      const meanB = candidateMeanScore[bestCi];
      const normB = candidateNorms[bestCi];
      const bestPlayerSet = new Set(candidatePlayerIds[bestCi]);
      for (let c = 0; c < C; c++) {
        if (!active[c]) continue;

        // Correlation
        if (normB > 1e-10) {
          const baseC = c * W;
          const meanC = candidateMeanScore[c];
          const normC = candidateNorms[c];
          if (normC > 1e-10) {
            let dot = 0;
            for (let w = 0; w < W; w++) {
              dot += (candidateWorldScores[baseC + w] - meanC) *
                     (candidateWorldScores[baseB + w] - meanB);
            }
            const corr = dot / (normC * normB);
            if (corr > rhoMaxCurrent) { active[c] = 0; continue; }
          }
        }

        // Anti-duplicate: too many shared players
        let shared = 0;
        for (const pid of candidatePlayerIds[c]) {
          if (bestPlayerSet.has(pid)) shared++;
        }
        if (shared >= rosterSize - 1) { active[c] = 0; continue; }

        // Exposure cap
        let wouldExceed = false;
        for (const pid of candidatePlayerIds[c]) {
          if ((exposureCount.get(pid) ?? 0) + 1 > exposureCap) {
            wouldExceed = true;
            break;
          }
        }
        if (wouldExceed) { active[c] = 0; continue; }
      }
    }

    if ((i + 1) % 25 === 0 || i + 1 === N || i < 3) {
      let activeCountNow = 0;
      for (let c = 0; c < C; c++) if (active[c]) activeCountNow++;
      const top1Cov = coveredCounts[1] / W;
      console.log(
        `  [hedging] ${(i + 1).toString().padStart(3)}/${N}  ` +
        `payout=${bestPayout.toFixed(3)}  varDiff=${bestVarDiff.toFixed(1)}  ` +
        `top1cov=${(top1Cov * 100).toFixed(1)}%  ` +
        `active=${activeCountNow}`,
      );
    }
  }

  // ─── BUILD DIAGNOSTICS ───
  const diag = buildHedgingDiagnostics(
    selected, selectedCi, precomp, candidatePool,
    candidateNorms, hedging.alpha, medPayoutNorm, medVarDiffNorm,
    rhoMaxCurrent, rhoRelaxations, coveredCounts, diagnosticTiers,
    exposureCount, N, Date.now() - t0, poolAfterProjectionFloor,
  );

  return { selected, diagnostics: diag };
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Tiered DK GPP payout curve. Inputs are 1-indexed rank and total field size.
 */
function getPayoutForRank(rank: number, totalEntries: number): number {
  const percentile = rank / totalEntries;
  if (percentile <= 0.0001) return 10000;
  if (percentile <= 0.001)  return 1000;
  if (percentile <= 0.005)  return 200;
  if (percentile <= 0.01)   return 100;
  if (percentile <= 0.02)   return 50;
  if (percentile <= 0.05)   return 20;
  if (percentile <= 0.10)   return 10;
  if (percentile <= 0.20)   return 5;
  return 0;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = xs.slice().sort((a, b) => a - b);
  const m = sorted.length >>> 1;
  return sorted.length % 2 === 0 ? (sorted[m - 1] + sorted[m]) / 2 : sorted[m];
}

/**
 * Recompute the active set after relaxing ρ_max — used when the previous
 * iteration exhausted candidates. Re-checks correlation against EVERY selected
 * entry, plus the exposure cap.
 */
function refilterByCorrelation(
  active: Uint8Array,
  selectedCi: number[],
  candidateWorldScores: Float32Array,
  candidateMeanScore: Float64Array,
  candidateNorms: Float64Array,
  W: number,
  rhoMax: number,
  exposureCount: Map<string, number>,
  candidatePlayerIds: string[][],
  exposureCap: number,
): void {
  const C = active.length;
  // Reset active to "alive" for all candidates not already selected
  const selectedSet = new Set(selectedCi);
  for (let c = 0; c < C; c++) active[c] = selectedSet.has(c) ? 0 : 1;

  for (let c = 0; c < C; c++) {
    if (!active[c]) continue;
    const baseC = c * W;
    const meanC = candidateMeanScore[c];
    const normC = candidateNorms[c];
    if (normC < 1e-10) { active[c] = 0; continue; }

    let killed = false;
    for (const sci of selectedCi) {
      const baseS = sci * W;
      const meanS = candidateMeanScore[sci];
      const normS = candidateNorms[sci];
      if (normS < 1e-10) continue;
      let dot = 0;
      for (let w = 0; w < W; w++) {
        dot += (candidateWorldScores[baseC + w] - meanC) *
               (candidateWorldScores[baseS + w] - meanS);
      }
      const corr = dot / (normC * normS);
      if (corr > rhoMax) { killed = true; break; }
    }
    if (killed) { active[c] = 0; continue; }

    // Exposure
    for (const pid of candidatePlayerIds[c]) {
      if ((exposureCount.get(pid) ?? 0) + 1 > exposureCap) { killed = true; break; }
    }
    if (killed) active[c] = 0;
  }
}

function buildHedgingDiagnostics(
  selected: Lineup[],
  selectedCi: number[],
  precomp: SlatePrecomputation,
  candidatePool: Lineup[],
  candidateNorms: Float64Array,
  alpha: number,
  medPayoutNorm: number,
  medVarDiffNorm: number,
  rhoMaxFinal: number,
  rhoRelaxations: number,
  coveredCounts: Int32Array,
  coverageTiers: { percentile: number }[],
  exposureCount: Map<string, number>,
  N: number,
  selectionTimeMs: number,
  poolAfterProjectionFloor: number,
): HedgingDiagnostics {
  const M = selected.length;
  const W = precomp.W;
  const { candidateWorldScores, candidateMeanScore, candidateProjection } = precomp;

  // Pairwise correlation stats
  let sumCorr = 0, maxCorr = -Infinity, minCorr = Infinity, pairs = 0;
  const histo: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < M; i++) {
    const ci = selectedCi[i];
    const baseI = ci * W;
    const meanI = candidateMeanScore[ci];
    const normI = candidateNorms[ci];
    if (normI < 1e-10) continue;
    for (let j = i + 1; j < M; j++) {
      const cj = selectedCi[j];
      const baseJ = cj * W;
      const meanJ = candidateMeanScore[cj];
      const normJ = candidateNorms[cj];
      if (normJ < 1e-10) continue;
      let dot = 0;
      for (let w = 0; w < W; w++) {
        dot += (candidateWorldScores[baseI + w] - meanI) *
               (candidateWorldScores[baseJ + w] - meanJ);
      }
      const corr = dot / (normI * normJ);
      sumCorr += corr;
      if (corr > maxCorr) maxCorr = corr;
      if (corr < minCorr) minCorr = corr;
      pairs++;
      if (corr < -0.5) histo[0]++;
      else if (corr < 0) histo[1]++;
      else if (corr < 0.5) histo[2]++;
      else histo[3]++;
    }
  }
  const avgCorr = pairs > 0 ? sumCorr / pairs : 0;

  // Coverage by tier
  const coverageByTier = coverageTiers.map((t, i) => ({
    percentile: t.percentile,
    rate: coveredCounts[i] / W,
  }));

  // Exposure stats
  const expValues = Array.from(exposureCount.values()).sort((a, b) => b - a);
  const maxExposureCount = expValues[0] ?? 0;
  const p95Idx = Math.max(0, Math.floor(expValues.length * 0.05));
  const p95Count = expValues[p95Idx] ?? 0;

  // Projection
  const avgSelectedProjection = M > 0
    ? selectedCi.reduce((s, ci) => s + candidateProjection[ci], 0) / M : 0;
  const avgPoolProjection = candidatePool.length > 0
    ? candidatePool.reduce((s, lu) => s + lu.projection, 0) / candidatePool.length : 0;

  // Liu et al. portfolio diversity score (mean Var(z_i - z_j))
  let totalVarDiff = 0;
  for (let i = 0; i < M; i++) {
    const ci = selectedCi[i];
    const baseI = ci * W;
    const meanI = candidateMeanScore[ci];
    const varI = precomp.candidateVariance[ci];
    for (let j = i + 1; j < M; j++) {
      const cj = selectedCi[j];
      const baseJ = cj * W;
      const meanJ = candidateMeanScore[cj];
      const varJ = precomp.candidateVariance[cj];
      let cov = 0;
      for (let w = 0; w < W; w++) {
        cov += (candidateWorldScores[baseI + w] - meanI) *
               (candidateWorldScores[baseJ + w] - meanJ);
      }
      cov /= Math.max(1, W - 1);
      totalVarDiff += varI + varJ - 2 * cov;
    }
  }
  const portfolioDiversityScore = pairs > 0 ? totalVarDiff / pairs : 0;

  return {
    selectedCount: M,
    avgPairwiseCorrelation: avgCorr,
    maxPairwiseCorrelation: maxCorr === -Infinity ? 0 : maxCorr,
    minPairwiseCorrelation: minCorr === Infinity ? 0 : minCorr,
    correlationHistogram: histo,
    coverageByTier,
    maxPlayerExposure: N > 0 ? maxExposureCount / N : 0,
    exposureP95: N > 0 ? p95Count / N : 0,
    avgSelectedProjection,
    avgPoolProjection,
    portfolioDiversityScore,
    alpha,
    medPayoutNorm,
    medVarDiffNorm,
    rhoMaxFinal,
    rhoRelaxations,
    selectionTimeMs,
    poolAfterProjectionFloor,
  };
}

/**
 * Build a HedgingParams object from sport defaults and an optional override.
 */
export function buildHedgingParams(
  sport: string,
  overrides: Partial<HedgingParams> = {},
): HedgingParams {
  return {
    ...DEFAULT_HEDGING_PARAMS,
    ...getHedgingSportDefaults(sport),
    ...overrides,
  };
}
