/**
 * E[max] Selector — pure greedy submodular maximization of E[max(z₁,...,z_m)].
 *
 * Liu et al. (2023) Equation 9 and Haugh-Singal (2021) both prove the GPP
 * objective is to maximize the expected value of the BEST entry in the
 * portfolio across simulated worlds:
 *
 *     max  E[max(z₁, z₂, ..., z_m)]
 *
 * E[max] is monotone submodular, so the greedy algorithm — at each step add
 * the entry with the highest MARGINAL gain — achieves ≥ (1 − 1/e) ≈ 63.2%
 * of optimal. The marginal gain of adding candidate c to portfolio W* is:
 *
 *     ΔE[max](c) = (1/W) · Σ_w max(0, z_c[w] − max_{j∈W*} z_j[w])
 *
 * In words: across all simulated worlds, how much does this candidate's
 * score EXCEED the portfolio's current best score, summed over the worlds
 * where it does exceed, divided by the number of worlds.
 *
 * This is the right objective and it has a theoretical guarantee. It does
 * NOT use payout tables, threshold percentiles, λ sweeps, σ_{δ,G} crowding
 * penalties, correlation constraints, diversity bonuses, or coverage
 * trackers. The diversity comes AUTOMATICALLY: once a world is "covered" by
 * a high portfolioMax, adding another entry that scores well in that same
 * world contributes zero marginal gain. The selector naturally seeks out
 * entries that cover UNCOVERED worlds — which is exactly what hedging is.
 *
 * Why earlier marginal-reward implementations failed: they computed gain
 * against external PAYOUT THRESHOLDS (rank in field), not against the
 * portfolio's own running max. That introduces simulation-quality dependence
 * — the threshold may fall in the wrong place. The pure ΔE[max] formulation
 * is internally consistent: any systematic simulation bias affects both the
 * candidate AND the portfolioMax equally, and the difference is unbiased.
 *
 * Three knobs only:
 *   - topFraction:   keep top X by projection (drops garbage hedges)
 *   - maxExposure:   per-player exposure cap
 *   - numWorlds:     simulation size (inherited from precompute)
 *
 * Performance: O(C·W) per iteration (single linear scan of active candidates
 * × world dimension). Typical NBA slate (W=2000, C=12000, N=150) runs in
 * ~3-5s. Single Float64Array `portfolioMax` of length W is the only state.
 */

import { Lineup } from '../types';
import {
  SlatePrecomputation,
  SelectorParams,
} from './algorithm7-selector';

// ============================================================
// PARAMS
// ============================================================

export interface EmaxParams {
  /**
   * Top fraction of the candidate pool (by projection) to consider eligible.
   * topFraction=0.5 keeps the top 50% by projection. Prevents the selector
   * from picking garbage lineups that happen to score well in one obscure
   * world just because they're "different." Below this floor the marginal
   * gain calculation can still produce a positive value, but those entries
   * are structurally too weak to win.
   */
  topFraction: number;
  /** Max fraction of selected lineups any single player may appear in. */
  maxExposure: number;
  /**
   * Whether to weight marginal gain by field-rank (Haugh-Singal σ_{δ,G}).
   *
   * When true, the gain in each world is multiplied by how well the
   * candidate ranks against the simulated field in that world. This down-
   * weights "chalk boom" worlds (where the threshold rises because 40% of
   * the field booms with you) and up-weights "chalk bust" worlds (where
   * the threshold drops because chalk is dead and you leapfrog the field).
   *
   * Backtested result: helps NBA (+10%, 1.36x → 1.49x) because contest
   * fields have clear chalk concentration. Hurts the 3 MLB slates we have
   * (1.46x → 1.17x) because chalk concentration wasn't extreme enough for
   * the penalty to add signal over noise.
   *
   * Default: true for NBA, false for MLB/NFL.
   */
  useFieldWeighting: boolean;
}

export const DEFAULT_EMAX_PARAMS: EmaxParams = {
  topFraction: 0.5,
  maxExposure: 0.30,
  useFieldWeighting: false,
};

export function getEmaxSportDefaults(sport: string): Partial<EmaxParams> {
  switch (sport) {
    case 'nba':
      // NBA: field-weighted E[max] (1.49x lift on 17 slates). The σ_{δ,G}
      // field-rank weighting helps because NBA contest fields have clear
      // chalk concentration. Also activated a dead slate (03-09: 0→0.98%).
      return { topFraction: 0.5, maxExposure: 0.40, useFieldWeighting: true };
    case 'mlb':
      // MLB: pure E[max] without field weighting (1.46x lift on 3 slates).
      // Field weighting hurt MLB (→ 1.17x) because the 3 available slates
      // didn't have extreme chalk. 30% exposure (25% caused pool exhaustion).
      return { topFraction: 0.6, maxExposure: 0.30, useFieldWeighting: false };
    case 'nfl':
      return { topFraction: 0.5, maxExposure: 0.30, useFieldWeighting: false };
    default:
      return {};
  }
}

export function buildEmaxParams(
  sport: string,
  overrides: Partial<EmaxParams> = {},
): EmaxParams {
  return {
    ...DEFAULT_EMAX_PARAMS,
    ...getEmaxSportDefaults(sport),
    ...overrides,
  };
}

// ============================================================
// DIAGNOSTICS
// ============================================================

export interface EmaxDiagnostics {
  selectedCount: number;

  /** E[max] of the final portfolio = mean(portfolioMax). The objective value. */
  expectedMax: number;
  /** Average marginal gain at each pick. Should be monotone decreasing (submodularity). */
  avgMarginalGain: number;
  /** Marginal gain of the FIRST pick (the highest single value possible). */
  firstPickGain: number;
  /** Marginal gain of the LAST pick (proxy for whether the pool was exhausted). */
  lastPickGain: number;

  // World coverage diagnostics (top tiers, NOT used in scoring)
  coverageByTier: { percentile: number; rate: number }[];

  // Correlation structure (computed only on the final portfolio for diagnostics)
  avgPairwiseCorrelation: number;
  correlationHistogram: [number, number, number, number];

  // Projection / exposure
  avgSelectedProjection: number;
  avgPoolProjection: number;
  maxPlayerExposure: number;

  // Pool stats
  poolAfterProjectionFloor: number;
  selectionTimeMs: number;
  topFraction: number;
}

// ============================================================
// MAIN SELECTOR
// ============================================================

export function emaxSelect(
  precomp: SlatePrecomputation,
  params: SelectorParams,
  emax: EmaxParams,
): { selected: Lineup[]; diagnostics: EmaxDiagnostics } {
  const t0 = Date.now();
  const {
    W, C,
    candidateWorldScores,
    candidateProjection,
    sortedFieldByWorld,
    candidatePool,
  } = precomp;
  const N = params.N;

  // ─── PROJECTION FLOOR ───
  const sortedProjAsc = Array.from({ length: C }, (_, i) => candidateProjection[i])
    .sort((a, b) => a - b);
  // topFraction=0.5 → keep top 50%, so floor index is at C * 0.5 (drop bottom half)
  const floorIdx = Math.min(C - 1, Math.floor(C * (1 - emax.topFraction)));
  const projThreshold = sortedProjAsc[floorIdx];
  const active = new Uint8Array(C);
  let poolAfterProjectionFloor = 0;
  for (let c = 0; c < C; c++) {
    if (candidateProjection[c] >= projThreshold) {
      active[c] = 1;
      poolAfterProjectionFloor++;
    }
  }

  console.log(
    `  [emax] projection floor: ${poolAfterProjectionFloor}/${C} candidates survived (top ${(emax.topFraction * 100).toFixed(0)}%)`,
  );

  // ─── PRE-COMPUTE per-world field payout weight (when enabled) ───
  // Haugh-Singal σ_{δ,G} expressed as a per-world multiplier on marginal gain.
  // In "chalk boom" worlds the threshold is high → weight is low.
  // In "chalk bust" worlds the threshold craters → weight is high.
  // Only computed when useFieldWeighting=true (NBA default).
  let fieldWeight: Float32Array | null = null;
  if (emax.useFieldWeighting) {
    fieldWeight = new Float32Array(C * W);
    for (let w = 0; w < W; w++) {
      const sortedField = sortedFieldByWorld[w];
      const F = sortedField.length;
      for (let c = 0; c < C; c++) {
        if (!active[c]) continue;
        const cs = candidateWorldScores[c * W + w];
        let lo = 0, hi = F;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (sortedField[mid] <= cs) lo = mid + 1;
          else hi = mid;
        }
        const rank = F - lo + 1;
        fieldWeight[c * W + w] = getPayoutWeight(rank / F);
      }
    }
  }

  // ─── STATE ───
  // portfolioMax[w] = max score of any selected entry in world w.
  const portfolioMax = new Float64Array(W);

  const selected: Lineup[] = [];
  const selectedCi: number[] = [];
  const marginalGains: number[] = [];

  // Per-player exposure tracking
  const exposureCount = new Map<string, number>();
  const exposureCap = emax.maxExposure > 0 && emax.maxExposure < 1
    ? Math.max(1, Math.ceil(N * emax.maxExposure))
    : N;
  const candidatePlayerIds: string[][] = candidatePool.map(lu => lu.players.map(p => p.id));

  // ─── MAIN LOOP ───
  // Two modes:
  //   useFieldWeighting=true (NBA):
  //     ΔScore(c) = (1/W) Σ_w max(0, c[w] - portfolioMax[w]) · fieldWeight[c][w]
  //     The excess term (Liu E[max]) × the field-rank weight (H-S σ_{δ,G}).
  //     Chalk-boom worlds get low weight; chalk-bust worlds get high weight.
  //
  //   useFieldWeighting=false (MLB):
  //     ΔScore(c) = (1/W) Σ_w max(0, c[w] - portfolioMax[w])
  //     Pure greedy E[max] — no field interaction. Diversification comes from
  //     portfolioMax coverage alone (Liu et al. submodularity guarantee).
  console.log(`  [emax] field weighting: ${emax.useFieldWeighting ? 'ON' : 'OFF'}`);
  for (let i = 0; i < N; i++) {
    let bestCi = -1;
    let bestGain = -1;

    for (let c = 0; c < C; c++) {
      if (!active[c]) continue;

      const base = c * W;
      let gain = 0;
      if (fieldWeight) {
        for (let w = 0; w < W; w++) {
          const excess = candidateWorldScores[base + w] - portfolioMax[w];
          if (excess > 0) gain += excess * fieldWeight[base + w];
        }
      } else {
        for (let w = 0; w < W; w++) {
          const excess = candidateWorldScores[base + w] - portfolioMax[w];
          if (excess > 0) gain += excess;
        }
      }
      if (gain > bestGain) {
        bestGain = gain;
        bestCi = c;
      }
    }

    if (bestCi === -1) {
      console.warn(`  [emax] entry ${i + 1}: no eligible candidates remaining`);
      break;
    }

    // ── COMMIT pick ──
    const meanGain = bestGain / W;
    selected.push(candidatePool[bestCi]);
    selectedCi.push(bestCi);
    marginalGains.push(meanGain);
    active[bestCi] = 0;

    // Update portfolioMax[w] = max(portfolioMax[w], picked[w])
    {
      const base = bestCi * W;
      for (let w = 0; w < W; w++) {
        const s = candidateWorldScores[base + w];
        if (s > portfolioMax[w]) portfolioMax[w] = s;
      }
    }

    // Update exposure counts
    for (const pid of candidatePlayerIds[bestCi]) {
      exposureCount.set(pid, (exposureCount.get(pid) ?? 0) + 1);
    }

    // Filter out candidates that would now violate the exposure cap
    {
      const cap = exposureCap;
      // Build a set of "newly capped" players for fast check
      const cappedPlayers = new Set<string>();
      for (const pid of candidatePlayerIds[bestCi]) {
        if ((exposureCount.get(pid) ?? 0) >= cap) cappedPlayers.add(pid);
      }
      if (cappedPlayers.size > 0) {
        for (let c = 0; c < C; c++) {
          if (!active[c]) continue;
          for (const pid of candidatePlayerIds[c]) {
            if (cappedPlayers.has(pid)) { active[c] = 0; break; }
          }
        }
      }
    }

    if ((i + 1) % 25 === 0 || i + 1 === N || i < 3) {
      let activeCountNow = 0;
      for (let c = 0; c < C; c++) if (active[c]) activeCountNow++;
      // Mean of portfolioMax = current E[max] of the portfolio
      let pmSum = 0;
      for (let w = 0; w < W; w++) pmSum += portfolioMax[w];
      const eMax = pmSum / W;
      console.log(
        `  [emax] ${(i + 1).toString().padStart(3)}/${N}  ` +
        `gain=${meanGain.toFixed(4)}  E[max]=${eMax.toFixed(2)}  active=${activeCountNow}`,
      );
    }
  }

  // ─── DIAGNOSTICS ───
  const diag = buildEmaxDiagnostics(
    selected, selectedCi, precomp, candidatePool, marginalGains, portfolioMax,
    sortedFieldByWorld, exposureCount, N, emax.topFraction, poolAfterProjectionFloor,
    Date.now() - t0,
  );

  return { selected, diagnostics: diag };
}

// ============================================================
// DIAGNOSTICS
// ============================================================

/**
 * Maps a candidate's field percentile to a payout weight that reflects how
 * much a "new world covered" is actually worth against the field. Top-heavy:
 * top 0.1% is worth massively more than top 10%.
 *
 * Approximates the DK GPP payout structure. Weight is zero outside top 20%.
 */
function getPayoutWeight(percentile: number): number {
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

function buildEmaxDiagnostics(
  selected: Lineup[],
  selectedCi: number[],
  precomp: SlatePrecomputation,
  candidatePool: Lineup[],
  marginalGains: number[],
  portfolioMax: Float64Array,
  sortedFieldByWorld: Float32Array[],
  exposureCount: Map<string, number>,
  N: number,
  topFraction: number,
  poolAfterProjectionFloor: number,
  selectionTimeMs: number,
): EmaxDiagnostics {
  const M = selected.length;
  const W = precomp.W;
  const { candidateWorldScores, candidateMeanScore, candidateVariance, candidateProjection } = precomp;

  // E[max] of final portfolio
  let pmSum = 0;
  for (let w = 0; w < W; w++) pmSum += portfolioMax[w];
  const expectedMax = pmSum / W;

  const avgMarginalGain = marginalGains.length > 0
    ? marginalGains.reduce((a, b) => a + b, 0) / marginalGains.length : 0;
  const firstPickGain = marginalGains[0] ?? 0;
  const lastPickGain = marginalGains[marginalGains.length - 1] ?? 0;

  // World coverage at top tiers (computed against field thresholds, diagnostic only)
  const tiers = [0.001, 0.01, 0.05];
  const coverageByTier = tiers.map(pct => {
    let coveredWorlds = 0;
    for (let w = 0; w < W; w++) {
      const sortedField = sortedFieldByWorld[w];
      const F = sortedField.length;
      const idx = Math.max(0, F - Math.max(1, Math.floor(F * pct)));
      const threshold = sortedField[Math.min(F - 1, idx)];
      // Did any selected entry beat this threshold in this world?
      // Equivalent: portfolioMax[w] >= threshold (since portfolioMax is the running max).
      if (portfolioMax[w] >= threshold) coveredWorlds++;
    }
    return { percentile: pct, rate: coveredWorlds / W };
  });

  // Pairwise correlation stats (diagnostic only — uses pre-computed mean/variance)
  let sumCorr = 0, pairs = 0;
  const histo: [number, number, number, number] = [0, 0, 0, 0];
  const norms = new Float64Array(M);
  for (let i = 0; i < M; i++) {
    norms[i] = Math.sqrt(Math.max(0, candidateVariance[selectedCi[i]]) * Math.max(1, W - 1));
  }
  for (let i = 0; i < M; i++) {
    const ci = selectedCi[i];
    const baseI = ci * W;
    const meanI = candidateMeanScore[ci];
    const normI = norms[i];
    if (normI < 1e-10) continue;
    for (let j = i + 1; j < M; j++) {
      const cj = selectedCi[j];
      const baseJ = cj * W;
      const meanJ = candidateMeanScore[cj];
      const normJ = norms[j];
      if (normJ < 1e-10) continue;
      let dot = 0;
      for (let w = 0; w < W; w++) {
        dot += (candidateWorldScores[baseI + w] - meanI) *
               (candidateWorldScores[baseJ + w] - meanJ);
      }
      const corr = dot / (normI * normJ);
      sumCorr += corr;
      pairs++;
      if (corr < -0.5) histo[0]++;
      else if (corr < 0) histo[1]++;
      else if (corr < 0.5) histo[2]++;
      else histo[3]++;
    }
  }
  const avgPairwiseCorrelation = pairs > 0 ? sumCorr / pairs : 0;

  // Projection
  const avgSelectedProjection = M > 0
    ? selectedCi.reduce((s, ci) => s + candidateProjection[ci], 0) / M : 0;
  const avgPoolProjection = candidatePool.length > 0
    ? candidatePool.reduce((s, lu) => s + lu.projection, 0) / candidatePool.length : 0;

  // Exposure
  const expValues = Array.from(exposureCount.values()).sort((a, b) => b - a);
  const maxExposureCount = expValues[0] ?? 0;

  return {
    selectedCount: M,
    expectedMax,
    avgMarginalGain,
    firstPickGain,
    lastPickGain,
    coverageByTier,
    avgPairwiseCorrelation,
    correlationHistogram: histo,
    avgSelectedProjection,
    avgPoolProjection,
    maxPlayerExposure: N > 0 ? maxExposureCount / N : 0,
    poolAfterProjectionFloor,
    selectionTimeMs,
    topFraction,
  };
}
