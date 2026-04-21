/**
 * V24 Selector — Hunter U²ₗ + Covariance Constraint + Variance Floor.
 *
 * Hunter, Vielma & Zaman (MIT, 2016) "Picking Winners Using Integer Programming"
 *
 * Three mechanisms:
 *
 * 1. HUNTER U²ₗ MARGINAL GAIN (replaces E[max] marginal gain)
 *    ΔU²(c) = P(c wins) − Σ_{j∈portfolio} P(c AND j both win)
 *    Credit for winning worlds minus a penalty for EACH existing entry that also
 *    wins in the same world. The penalty grows with each overlapping entry, driving
 *    the selector toward contrarian builds that cover uncovered worlds.
 *
 * 2. COVARIANCE CONSTRAINT (replaces correlation constraint)
 *    Cov(i,j) ≤ δ_max where δ_max = ρ_target × σ_median². Catches high-variance
 *    pairs that move together in absolute terms — correlation misses these because
 *    it normalizes by σ.
 *
 * 3. VARIANCE FLOOR (new)
 *    Only consider candidates with variance in the top X% of the pool. Removes flat
 *    lineups that beat thresholds in many worlds but can never reach the boom scores
 *    needed to actually win a GPP.
 *
 * The contrarian mechanism is EMBEDDED in the threshold computation: when the field
 * is 49.5% Valdez, the top-1% threshold in "Valdez dominates" worlds is sky-high,
 * giving Valdez lineups few pWin credits. Non-Valdez lineups in "Valdez busts"
 * worlds face a cratered threshold and get full credit.
 */

import { Lineup } from '../types';
import {
  SlatePrecomputation,
  SelectorParams,
} from './algorithm7-selector';

// ============================================================
// PARAMS
// ============================================================

export interface V24Params {
  /** Payout tier percentiles for threshold computation. */
  tierPercentiles: number[];
  /** Payout-proportional weights per tier. */
  tierWeights: number[];
  /** Target ρ for covariance cap: δ_max = ρ_target × σ_median². */
  rhoTarget: number;
  /** Keep top X% of pool by variance. 0.7 = drop bottom 30%. */
  varianceTopFraction: number;
  /** Keep top X% of pool by projection. */
  projectionFloor: number;
  /**
   * Keep bottom X% of pool by avg lineup ownership (1.0 = no filter; 0.80 drops
   * chalkiest 20%). Empirically on MLB, top-ownership-quintile lineups hit
   * top-1% at ~0.05-0.80%, vs bottom quintile at ~1.6-4.1%. Effect-weighted
   * favors dropping the chalkiest tail.
   */
  ownershipKeepFraction: number;
  /** Max single-player exposure fraction. */
  maxExposure: number;
}

export const DEFAULT_V24_PARAMS: V24Params = {
  tierPercentiles: [0.001, 0.01, 0.05],
  tierWeights: [20, 5, 2],
  rhoTarget: 0.65,
  varianceTopFraction: 0.7,
  projectionFloor: 0.6,
  ownershipKeepFraction: 1.0,
  maxExposure: 0.25,
};

export function getV24SportDefaults(sport: string, contestType?: string): Partial<V24Params> {
  // Showdown overrides — tighter covariance (all same game), aggressive variance floor
  if (contestType === 'showdown') {
    return {
      rhoTarget: 0.50,           // tighter — all players from same game
      varianceTopFraction: 0.7,  // aggressive — many flat lineups in small pool
      projectionFloor: 1.0,      // no floor — small pool, Hunter handles quality
      tierWeights: [30, 5, 1],   // very top-heavy for showdown payouts
      maxExposure: 0.50,         // looser — only ~35 players to pick from
    };
  }

  switch (sport) {
    case 'nba':
      return {
        rhoTarget: 0.70,
        varianceTopFraction: 0.9,
        projectionFloor: 0.5,
        maxExposure: 0.40,
      };
    case 'mlb':
      // Calibrated from 5-slate backtest (2026-04-15): Hunter P2 failed 3/5
      // (winners had LOWER variance), projection mean Spearman +0.02 (noise),
      // contrarian wins 7-66× on small slates, ShipMyMoney target avgCorr=0.14.
      // See memory: mlb-calibration-findings-2026-04-15.md
      return {
        // MLB calibration (2026-04-15, 4-slate backtest):
        //   • varFloor REMOVED: validated — 50%+ of top-1% hits were below OLD threshold
        //   • projFloor REMOVED: MLB Spearman mean +0.02 (noise)
        //   • ρ_target 0.60→0.18: matches pro MLB avgCorr ≈0.14-0.20
        //   • ownership cap 0.80: V3 removal regressed 4-14 (contrarian slate); keeping the cap
        //     as a safety since U²ₗ greedy alone doesn't consistently preserve contrarian bias
        //     at N=150 on MLB mid-size fields
        rhoTarget: 0.18,
        varianceTopFraction: 1.0,
        projectionFloor: 1.0,
        ownershipKeepFraction: 0.80,
        maxExposure: 0.30,
      };
    case 'nfl':
      return {
        rhoTarget: 0.65,
        varianceTopFraction: 0.7,
        projectionFloor: 0.5,
        maxExposure: 0.30,
      };
    default:
      return {};
  }
}

export function buildV24Params(
  sport: string,
  overrides: Partial<V24Params> = {},
  contestType?: string,
): V24Params {
  return {
    ...DEFAULT_V24_PARAMS,
    ...getV24SportDefaults(sport, contestType),
    ...overrides,
  };
}

// ============================================================
// DIAGNOSTICS
// ============================================================

export interface V24Diagnostics {
  selectedCount: number;
  coverageByTier: { percentile: number; rate: number }[];
  avgPairwiseCorrelation: number;
  correlationHistogram: [number, number, number, number];
  avgSelectedProjection: number;
  avgPoolProjection: number;
  maxPlayerExposure: number;
  avgMarginalGain: number;
  firstPickGain: number;
  lastPickGain: number;
  deltaMax: number;
  deltaMaxRelaxations: number;
  poolAfterFilters: number;
  selectionTimeMs: number;
}

// ============================================================
// MAIN SELECTOR
// ============================================================

export function v24Select(
  precomp: SlatePrecomputation,
  params: SelectorParams,
  v24: V24Params,
): { selected: Lineup[]; diagnostics: V24Diagnostics } {
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
  const { tierPercentiles, tierWeights, rhoTarget, varianceTopFraction,
          projectionFloor, ownershipKeepFraction, maxExposure } = v24;
  const numTiers = tierPercentiles.length;

  // ─── PRE-FILTER: projection floor + variance floor + ownership ceiling ───
  const active = new Uint8Array(C);

  // Projection floor (keep top X% by projection)
  const projSorted = Array.from({ length: C }, (_, i) => candidateProjection[i])
    .sort((a, b) => a - b);
  const projThreshold = projSorted[Math.min(C - 1, Math.floor(C * (1 - projectionFloor)))];

  // Variance floor (keep top X% by variance; 1.0 disables)
  const varSorted = Array.from({ length: C }, (_, i) => candidateVariance[i])
    .sort((a, b) => a - b);
  const varThreshold = varSorted[Math.min(C - 1, Math.floor(C * (1 - varianceTopFraction)))];

  // Ownership ceiling (keep bottom X% by avg lineup ownership; 1.0 disables)
  // Lineup.ownership = avg of per-player ownership; lower = more contrarian.
  const ownSorted = candidatePool.map(l => l.ownership || 0).sort((a, b) => a - b);
  const ownCeiling = ownershipKeepFraction >= 1.0
    ? Infinity
    : ownSorted[Math.max(0, Math.min(C - 1, Math.floor(C * ownershipKeepFraction) - 1))];

  let poolAfterFilters = 0;
  for (let c = 0; c < C; c++) {
    const own = candidatePool[c].ownership || 0;
    if (
      candidateProjection[c] >= projThreshold &&
      candidateVariance[c] >= varThreshold &&
      own <= ownCeiling
    ) {
      active[c] = 1;
      poolAfterFilters++;
    }
  }

  console.log(
    `  [v24] proj floor: >=${projThreshold.toFixed(1)} | var floor: >=${varThreshold.toFixed(1)} | ` +
    `own ceil: <=${(ownCeiling === Infinity ? '∞' : ownCeiling.toFixed(1))} | ` +
    `${poolAfterFilters}/${C} candidates survived`,
  );

  // ─── COMPUTE TIER THRESHOLDS + HIT MATRICES ───
  const tierHits: Uint8Array[] = new Array(numTiers);
  for (let t = 0; t < numTiers; t++) {
    const pct = tierPercentiles[t];
    const hits = new Uint8Array(C * W);
    for (let w = 0; w < W; w++) {
      const sortedField = sortedFieldByWorld[w];
      const F = sortedField.length;
      const idx = Math.max(0, F - Math.max(1, Math.floor(F * pct)));
      const thresh = sortedField[Math.min(F - 1, idx)];
      for (let c = 0; c < C; c++) {
        if (candidateWorldScores[c * W + w] >= thresh) {
          hits[c * W + w] = 1;
        }
      }
    }
    tierHits[t] = hits;
  }

  // ─── COVARIANCE CONSTRAINT SETUP ───
  // Auto-calibrate δ_max = ρ_target × σ_median²
  const activeStdDevs: number[] = [];
  for (let c = 0; c < C; c++) {
    if (active[c]) activeStdDevs.push(Math.sqrt(candidateVariance[c]));
  }
  activeStdDevs.sort((a, b) => a - b);
  const sigmaMedian = activeStdDevs[Math.floor(activeStdDevs.length / 2)] || 1;
  let deltaMax = rhoTarget * sigmaMedian * sigmaMedian;
  let deltaMaxRelaxations = 0;

  console.log(
    `  [v24] δ_max=${deltaMax.toFixed(2)} (ρ_target=${rhoTarget}, σ_med=${sigmaMedian.toFixed(2)})`,
  );

  // ─── PRE-COMPUTE CENTERED SCORES FOR ALL CANDIDATES ───
  // Do this once instead of recomputing (scores[w] - mean) inline every iteration.
  // Memory: C × W × 4 bytes (e.g. 12000 × 2000 × 4 = 96 MB). Worth it for speed.
  const candidateCentered: Float32Array[] = new Array(C);
  for (let c = 0; c < C; c++) {
    const centered = new Float32Array(W);
    const mean = candidateMeanScore[c];
    const base = c * W;
    for (let w = 0; w < W; w++) {
      centered[w] = candidateWorldScores[base + w] - mean;
    }
    candidateCentered[c] = centered;
  }

  // ─── TRACKING STATE ───
  const portfolioHitCount: Uint16Array[] = Array.from(
    { length: numTiers }, () => new Uint16Array(W),
  );
  const selected: Lineup[] = [];
  const selectedCi: number[] = [];
  const marginalGains: number[] = [];
  const selectedCentered: Float32Array[] = [];
  let latestCentered: Float32Array | null = null;  // only check cov against latest pick
  const playerUsage = new Map<string, number>();
  const exposureCap = maxExposure > 0 && maxExposure < 1
    ? Math.max(1, Math.ceil(N * maxExposure)) : N;
  const candidatePlayerIds: string[][] = candidatePool.map(lu => lu.players.map(p => p.id));

  // ─── MAIN SELECTION LOOP ───
  for (let i = 0; i < N; i++) {
    let bestCi = -1;
    let bestGain = -Infinity;

    // After each pick, filter candidates by covariance against ONLY the
    // just-selected entry. Candidates already passed against all previous
    // entries — only the new one could cause a violation. O(C × W) not O(C × selected × W).
    if (latestCentered && deltaMax < Infinity) {
      for (let c = 0; c < C; c++) {
        if (!active[c]) continue;
        const cc = candidateCentered[c];
        let dot = 0;
        for (let w = 0; w < W; w++) {
          dot += cc[w] * latestCentered[w];
        }
        if (dot / Math.max(1, W - 1) > deltaMax) {
          active[c] = 0;
        }
      }
    }

    for (let c = 0; c < C; c++) {
      if (!active[c]) continue;

      // ─── Exposure check ───
      let expViolation = false;
      for (const pid of candidatePlayerIds[c]) {
        if ((playerUsage.get(pid) || 0) + 1 > exposureCap) {
          expViolation = true;
          break;
        }
      }
      if (expViolation) continue;

      // ─── Hunter U²ₗ marginal gain ───
      let totalGain = 0;
      const cBase = c * W;
      for (let t = 0; t < numTiers; t++) {
        const hits = tierHits[t];
        const counts = portfolioHitCount[t];
        const weight = tierWeights[t];
        let pWin = 0;
        let jointPenalty = 0;
        for (let w = 0; w < W; w++) {
          if (hits[cBase + w] === 1) {
            pWin++;
            jointPenalty += counts[w];
          }
        }
        totalGain += weight * (pWin - jointPenalty) / W;
      }

      if (totalGain > bestGain) {
        bestGain = totalGain;
        bestCi = c;
      }
    }

    // ─── Handle exhaustion ───
    if (bestCi === -1) {
      if (deltaMaxRelaxations < 20) {
        deltaMax *= 1.15;
        deltaMaxRelaxations++;
        console.warn(
          `  [v24] entry ${i + 1}: relaxing δ_max to ${deltaMax.toFixed(2)}`,
        );
        // Re-activate covariance-filtered candidates
        for (let c = 0; c < C; c++) {
          if (!active[c] && candidateProjection[c] >= projThreshold
              && candidateVariance[c] >= varThreshold
              && !selectedCi.includes(c)) {
            active[c] = 1;
          }
        }
        i--;
        continue;
      }
      if (deltaMax < Infinity) {
        // Disable covariance constraint — fill remaining by Hunter gain + exposure only
        deltaMax = Infinity;
        console.warn(`  [v24] entry ${i + 1}: disabling covariance constraint`);
        const selectedSet = new Set(selectedCi);
        for (let c = 0; c < C; c++) {
          if (!active[c] && candidateVariance[c] >= varThreshold
              && !selectedSet.has(c)) {
            active[c] = 1;
          }
        }
        i--;
        continue;
      }
      // Covariance already disabled and still no candidates — truly exhausted
      console.warn(`  [v24] entry ${i + 1}: pool fully exhausted`);
      break;
    }

    // ─── COMMIT ───
    selected.push(candidatePool[bestCi]);
    selectedCi.push(bestCi);
    marginalGains.push(bestGain);
    active[bestCi] = 0;

    // Track centered scores for covariance filtering
    latestCentered = candidateCentered[bestCi];
    selectedCentered.push(latestCentered);

    // Update portfolioHitCount
    const bBase = bestCi * W;
    for (let t = 0; t < numTiers; t++) {
      const hits = tierHits[t];
      const counts = portfolioHitCount[t];
      for (let w = 0; w < W; w++) {
        if (hits[bBase + w] === 1) counts[w]++;
      }
    }

    // Update player usage
    for (const pid of candidatePlayerIds[bestCi]) {
      playerUsage.set(pid, (playerUsage.get(pid) || 0) + 1);
    }

    // ─── LOGGING ───
    if ((i + 1) % 25 === 0 || i + 1 === N || i < 3) {
      let activeCount = 0;
      for (let c = 0; c < C; c++) if (active[c]) activeCount++;
      const coverages = portfolioHitCount.map(counts => {
        let covered = 0;
        for (let w = 0; w < W; w++) if (counts[w] > 0) covered++;
        return covered / W;
      });
      const covStr = coverages.map((cv, t) =>
        `top${(tierPercentiles[t] * 100).toFixed(1)}%=${(cv * 100).toFixed(1)}%`
      ).join(' ');
      console.log(
        `  [v24] ${(i + 1).toString().padStart(3)}/${N}  ` +
        `gain=${bestGain.toFixed(4)}  ${covStr}  active=${activeCount}`,
      );
    }
  }

  // ─── DIAGNOSTICS ───
  const diag = buildV24Diagnostics(
    selected, selectedCi, precomp, candidatePool, marginalGains,
    portfolioHitCount, tierPercentiles, playerUsage, deltaMax,
    deltaMaxRelaxations, poolAfterFilters, N, Date.now() - t0,
  );

  return { selected, diagnostics: diag };
}

// ============================================================
// DIAGNOSTICS
// ============================================================

function buildV24Diagnostics(
  selected: Lineup[],
  selectedCi: number[],
  precomp: SlatePrecomputation,
  candidatePool: Lineup[],
  marginalGains: number[],
  portfolioHitCount: Uint16Array[],
  tierPercentiles: number[],
  playerUsage: Map<string, number>,
  deltaMax: number,
  deltaMaxRelaxations: number,
  poolAfterFilters: number,
  N: number,
  selectionTimeMs: number,
): V24Diagnostics {
  const M = selected.length;
  const W = precomp.W;
  const { candidateWorldScores, candidateMeanScore, candidateVariance,
          candidateProjection } = precomp;

  // Coverage by tier
  const coverageByTier = tierPercentiles.map((pct, t) => {
    let covered = 0;
    const counts = portfolioHitCount[t];
    for (let w = 0; w < W; w++) if (counts[w] > 0) covered++;
    return { percentile: pct, rate: covered / W };
  });

  // Pairwise correlation (diagnostic)
  let sumCorr = 0, pairs = 0;
  const histo: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < M; i++) {
    const ci = selectedCi[i];
    const baseI = ci * W;
    const meanI = candidateMeanScore[ci];
    const normI = Math.sqrt(candidateVariance[ci] * Math.max(1, W - 1));
    if (normI < 1e-10) continue;
    for (let j = i + 1; j < M; j++) {
      const cj = selectedCi[j];
      const baseJ = cj * W;
      const meanJ = candidateMeanScore[cj];
      const normJ = Math.sqrt(candidateVariance[cj] * Math.max(1, W - 1));
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

  const expValues = Array.from(playerUsage.values()).sort((a, b) => b - a);
  const maxExposureCount = expValues[0] ?? 0;

  const avgSelectedProjection = M > 0
    ? selectedCi.reduce((s, ci) => s + candidateProjection[ci], 0) / M : 0;
  const avgPoolProjection = candidatePool.length > 0
    ? candidatePool.reduce((s, lu) => s + lu.projection, 0) / candidatePool.length : 0;

  return {
    selectedCount: M,
    coverageByTier,
    avgPairwiseCorrelation: pairs > 0 ? sumCorr / pairs : 0,
    correlationHistogram: histo,
    avgSelectedProjection,
    avgPoolProjection,
    maxPlayerExposure: N > 0 ? maxExposureCount / N : 0,
    avgMarginalGain: marginalGains.length > 0
      ? marginalGains.reduce((a, b) => a + b, 0) / marginalGains.length : 0,
    firstPickGain: marginalGains[0] ?? 0,
    lastPickGain: marginalGains[marginalGains.length - 1] ?? 0,
    deltaMax,
    deltaMaxRelaxations,
    poolAfterFilters,
    selectionTimeMs,
  };
}
