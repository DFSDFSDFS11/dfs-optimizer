/**
 * Algorithm 7 Selector — Haugh-Singal × Liu et al.
 *
 * Picks N lineups from a candidate pool by combining:
 *   1. Haugh-Singal (Columbia, 2021) — λ-sweep mean-variance objective with the
 *      σ_{δ,G} covariance penalty (principled replacement for ownership penalty);
 *      Algorithm 7 greedy with γ=C-3 hard overlap constraint and no backtracking.
 *   2. Liu, Liu, Teo (NUS, 2023) — moment-based diversification: maximize the
 *      variance of differences between selected entries; invest more compute in
 *      the first ~30 entries (the diversification "foundation").
 *
 * Pipeline:
 *   precomputeSlate(...)  ─ simulate W worlds, score players + candidates + field,
 *                            compute σ_{δ,G} per player
 *   algorithm7Select(...) ─ greedy selection with λ-sweep + γ overlap + early-entry
 *                            diversification boost; marginal reward = sum of
 *                            new top-K finishes the candidate adds to the portfolio
 *
 * The "field" used for thresholds and σ_{δ,G} should be the actual contest entries
 * when available (Mode 2 backtest) or the candidate pool itself (Mode 1 live).
 *
 * All hot loops use Float32Array. Memory budget for typical MLB classic with
 * W=2000, P=200, F=8000, C=10000:
 *   playerWorldScores:    ~1.6 MB    (P × W × 4)
 *   candidateWorldScores: ~80  MB    (C × W × 4)
 *   fieldWorldScores:     ~64  MB    (F × W × 4)
 *   threshold arrays:     ~24  KB    (3 × W × 4)
 */

import { Lineup, Player, Sport } from '../types';
import {
  generateCorrelationFactors,
  samplePlayerOutcome,
  setSimSportConfig,
} from './simulation/tournament-sim';

// ============================================================
// PARAMS
// ============================================================

export interface SelectorParams {
  /** Number of lineups to select (e.g. 150). */
  N: number;
  /** Number of MC worlds to simulate (e.g. 2000-3000). */
  numWorlds: number;
  /**
   * Hard γ overlap constraint: no two selected lineups may share more than
   * `gamma` players. Haugh-Singal Theorem 1 recommends γ = C − 3 where C is
   * the roster size (so 5 for NBA-8, 7 for MLB-10, 6 for NFL-9).
   */
  gamma: number;
  /**
   * λ values to sweep when generating candidates per iteration. λ=0 picks
   * the highest-projection feasible lineup; large λ favours high-variance,
   * low-ownership lineups. The λ that maximises marginal portfolio reward
   * wins for each iteration.
   */
  lambdaGrid: number[];
  /** Number of "early" entries that get the full λ grid + diversification boost. */
  earlyEntryCount: number;
  /** Multiplier on marginal reward for early entries (Liu et al. diversification boost). */
  earlyDiversifyBoost: number;
  /**
   * Sub-sample size of the field used for threshold computation and the
   * σ_{δ,G} covariance vector. Memory ∝ fieldSampleSize × numWorlds.
   */
  fieldSampleSize: number;
  /** Hard cap on the candidate pool (top N by projection are kept). */
  candidatePoolSize: number;
  /**
   * Top-K threshold percentiles used for the marginal reward signal.
   * The reward sums weighted hits across these tiers per world.
   */
  rewardThresholds: { top01: number; top1: number; top5: number };
  /** Weights applied to each tier when computing marginal reward. */
  rewardWeights: { top01: number; top1: number; top5: number };
  /**
   * Percentile used to compute σ_{δ,G} (the covariance penalty). The H-S paper
   * targets the top payout tier; we default to top 1% which is the GPP cash line.
   */
  covTargetPercentile: number;
  /**
   * Hard cap on the fraction of selected lineups any single player may appear in.
   * γ alone caps PAIRWISE overlap but lets one player creep into ~70-100% of
   * entries on chalk slates. This explicit cap directly enforces Liu et al.'s
   * diversification result. Set to 0 or ≥1 to disable.
   */
  maxPlayerExposure: number;
  /**
   * Marginal reward function:
   *   'tiered'      — discretized weighted sum of top-K hit indicators with
   *                    split-pot cannibalization (the original implementation).
   *   'log_payout'  — Kelly-style log-utility on a continuous rank-based DK
   *                    payout curve. Each candidate's per-world payout is
   *                    payoutCurve(rank, fieldSize); the marginal reward is
   *                    Σ_w log1p(newPayout / (1 + portfolioPayout[w])).
   *                    Naturally values worlds where the portfolio is currently
   *                    empty over worlds where it is already winning, which is
   *                    structurally what GPP diversification looks like in DFS.
   */
  marginalRewardMode: 'tiered' | 'log_payout';
  /**
   * Power-law exponent for the rank-based payout curve when marginalRewardMode
   * is 'log_payout'. payout(rank) ∝ rank^-α. Higher α = more top-heavy curve.
   * 1.0 ≈ classic 1/rank decay (matches large-field DK GPPs roughly).
   */
  payoutCurveExponent: number;
  /**
   * Top fraction of the field that earns any payout in 'log_payout' mode.
   * Below this rank, payout = 0. DK GPPs typically pay top ~20%.
   */
  payoutCutoffFraction: number;
  /**
   * World simulator backend:
   *   'rich'    — uses tournament-sim.ts samplePlayerOutcome (Fritsch-Carlson
   *                CDF + game/team factors + salary loading + minute loading +
   *                usage redistribution; many tuned post-CDF knobs).
   *   'minimal' — clean inline sampler: percentile inverse-CDF base draw plus
   *                a single per-team and per-game multiplicative shock per
   *                world. Skips salary/minutes/usage manipulation. Useful as
   *                an A/B baseline to isolate σ_{δ,G} signal from sampler noise.
   */
  simulatorMode: 'rich' | 'minimal';
  /**
   * Per-team multiplicative shock std-dev for the minimal simulator.
   * Models intra-team correlation: when a team's offense fires, all of its
   * players' outcomes shift up together. Lognormal with this std (~0.10
   * is empirically reasonable for NBA).
   */
  teamShockStd: number;
  /**
   * Per-game multiplicative shock std-dev for the minimal simulator.
   * Models game pace correlation: a high-pace game lifts both teams' players.
   */
  gameShockStd: number;
  /** Optional seed for deterministic field/world generation (reserved). */
  seed?: number;
}

export const DEFAULT_SELECTOR_PARAMS: Omit<SelectorParams, 'N' | 'gamma'> = {
  numWorlds: 2000,
  lambdaGrid: [0, 0.1, 0.25, 0.5, 1.0, 2.0],
  earlyEntryCount: 30,
  earlyDiversifyBoost: 1.5,
  fieldSampleSize: 8000,
  candidatePoolSize: 12000,
  rewardThresholds: { top01: 0.001, top1: 0.01, top5: 0.05 },
  rewardWeights: { top01: 20, top1: 3, top5: 1 },
  covTargetPercentile: 0.01,
  maxPlayerExposure: 0.25,
  marginalRewardMode: 'tiered',
  payoutCurveExponent: 1.0,
  payoutCutoffFraction: 0.20,
  simulatorMode: 'rich',
  teamShockStd: 0.10,
  gameShockStd: 0.12,
};

/**
 * Sport-aware default for the γ overlap constraint (= rosterSize − 3).
 */
export function defaultGamma(rosterSize: number): number {
  return Math.max(1, rosterSize - 3);
}

/**
 * Sport-aware overrides for SelectorParams. Empirically calibrated:
 *
 * - **NBA** is a projection-accuracy contest with tight floors and almost no
 *   stacking edge. Diversification trades away the chalk advantage. Disable
 *   the exposure cap, narrow the λ grid toward 0, drop the early-entry boost,
 *   and use a flatter reward (less weight on top-0.1% so the engine doesn't
 *   over-chase the right tail).
 *
 * - **MLB / NFL** reward stacking and high variance. Use the spec defaults:
 *   tight exposure cap, wide λ grid, top-0.1% emphasized.
 *
 * - **MMA / NASCAR / Golf** are between the two — narrower λ than MLB, looser
 *   exposure cap than MLB, no early boost.
 */
export function getSportDefaults(sport: string): Partial<SelectorParams> {
  switch (sport) {
    case 'nba':
      // Calibrated by elite-sweep across 17 historical NBA slates and verified
      // against the log_payout A/B test. Tiered reward wins on top-1% (1.78x)
      // by a meaningful margin over log_payout (1.57x), even though log_payout
      // is slightly better on top-5%/top-10%/avg metrics. The bottleneck on
      // NBA is upstream of selection — σ_{δ,G} picks the wrong contrarians
      // because the simulator's tail variance is generic across players, not
      // slate-specific. Until that's fixed, tiered gives the best top-1% lift.
      // After A/B testing minimal vs rich and sweeping payout curve params,
      // tiered_rich remains the best single config at 1.78x lift across 17
      // historical NBA slates. The minimal simulator and log_payout reward
      // both produce competitive but slightly worse aggregates, though they
      // win on disjoint slates — so the next meaningful gain is an ensemble,
      // not another single-config tweak.
      return {
        maxPlayerExposure: 0.40,
        lambdaGrid: [0, 0.05, 0.1, 0.2],
        earlyDiversifyBoost: 1.0,
        earlyEntryCount: 0,
        rewardWeights: { top01: 20, top1: 5, top5: 2 },
        marginalRewardMode: 'tiered',
        simulatorMode: 'rich',
      };
    case 'mlb':
      return {
        maxPlayerExposure: 0.25,
        lambdaGrid: [0, 0.1, 0.25, 0.5, 1.0, 2.0],
        earlyDiversifyBoost: 1.5,
        earlyEntryCount: 30,
        rewardWeights: { top01: 20, top1: 3, top5: 1 },
      };
    case 'nfl':
      return {
        maxPlayerExposure: 0.30,
        lambdaGrid: [0, 0.1, 0.25, 0.5, 1.0, 2.0],
        earlyDiversifyBoost: 1.5,
        earlyEntryCount: 30,
        rewardWeights: { top01: 20, top1: 3, top5: 1 },
      };
    case 'mma':
    case 'nascar':
    case 'golf':
      return {
        maxPlayerExposure: 0.40,
        lambdaGrid: [0, 0.1, 0.25, 0.5],
        earlyDiversifyBoost: 1.2,
        earlyEntryCount: 20,
        rewardWeights: { top01: 15, top1: 4, top5: 1 },
      };
    default:
      return {};
  }
}

// ============================================================
// PRECOMPUTATION
// ============================================================

export interface SlatePrecomputation {
  W: number;                              // worlds
  P: number;                              // players
  C: number;                              // candidates kept after pre-filter
  F: number;                              // field sample size

  /** Float32 [P × W] flat: player world scores. */
  playerWorldScores: Float32Array;
  /** Float32 [C × W] flat: candidate lineup world scores. */
  candidateWorldScores: Float32Array;
  /** Float32 [F × W] flat: field lineup world scores. */
  fieldWorldScores: Float32Array;

  /** Per-candidate empirical mean across worlds. */
  candidateMeanScore: Float64Array;       // [C]
  /** Per-candidate empirical variance across worlds. */
  candidateVariance: Float64Array;        // [C]
  /** Per-candidate sum of σ_{δ,G}[player] (the H-S crowding penalty). */
  candidateCovPenalty: Float64Array;      // [C]
  /** Per-candidate static projection (sum of player projections). */
  candidateProjection: Float64Array;      // [C]

  /** Per-player empirical mean. */
  playerMeans: Float64Array;              // [P]
  /** σ_{δ,G}[p] = Cov(playerScore_p, threshold) — the principled crowding penalty. */
  playerCovWithThreshold: Float64Array;   // [P]

  /** Top-0.1% / top-1% / top-5% thresholds per world. */
  thresh01: Float32Array;                 // [W]
  thresh1: Float32Array;                  // [W]
  thresh5: Float32Array;                  // [W]

  /**
   * Per-candidate per-world payout under the rank-based DK payout curve.
   * Only populated when marginalRewardMode === 'log_payout'. Indexed [c × W + w].
   * Memory: C × W × 4 bytes (e.g. 12000 × 2000 × 4 ≈ 96 MB).
   */
  candidatePayoutPerWorld?: Float32Array;
  /**
   * Per-world ASCENDING-sorted field scores. Always populated (cheap) so that
   * recomputePayoutCurve() can swap in a new payout-curve config without
   * re-running the entire precomputation.
   */
  sortedFieldByWorld: Float32Array[];

  /** The candidate pool (after pre-filter), aligned with the [C × W] arrays. */
  candidatePool: Lineup[];
  /** The field sample, aligned with the [F × W] arrays. */
  fieldSample: Lineup[];
  /** Player ID → row in playerWorldScores. */
  indexMap: Map<string, number>;

  /**
   * Auto-computed multiplier on (variance − 2·covPenalty) so that at λ=1 the
   * variance term is on equal footing with the projection term. Without this
   * scaling, λ=0 dominates because projection magnitude (~250) dwarfs the
   * raw variance term (~50) and no λ in a normal grid can rebalance.
   *
   *   lambdaScale = mean(candidateProjection) / max(eps, |mean(candidateVariance − 2·candidateCovPenalty)|)
   */
  lambdaScale: number;
  /**
   * Whether the field sample was held-out from the candidate pool. When true,
   * thresholds and σ_{δ,G} are leakage-free.
   */
  fieldHeldOut: boolean;
}

/**
 * Build the slate precomputation: simulate W worlds, score every player,
 * project the candidate and field lineups into world space, and compute
 * thresholds + the σ_{δ,G} covariance vector.
 *
 * DETERMINISM: the underlying world simulator (samplePlayerOutcome /
 * generateCorrelationFactors in tournament-sim.ts) uses Math.random()
 * directly without accepting a seed. To make precompute reproducible across
 * runs, we save-replace-restore Math.random with a Mulberry32 PRNG seeded
 * from params.seed for the duration of the world simulation. Outside the
 * try/finally Math.random is unchanged.
 */
export function precomputeSlate(
  pool: Lineup[],
  field: Lineup[],
  players: Player[],
  params: SelectorParams,
  sport: Sport,
): SlatePrecomputation {
  const seed = (params.seed ?? 1337) >>> 0;
  const savedRandom = Math.random;
  Math.random = makeMulberry32(seed);
  try {
    return precomputeSlateInner(pool, field, players, params, sport);
  } finally {
    Math.random = savedRandom;
  }
}

/** Mulberry32 — fast 32-bit PRNG, identical formula used in tournament-sim. */
function makeMulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================
// MINIMAL SIMULATOR (clean inline path)
// ============================================================
//
// Goal: produce the per-(player × world) score matrix using nothing but
// the SaberSim percentiles + a single per-team and per-game multiplicative
// shock per world. No salary loading, no minutes loading, no usage shifts,
// no extra variance scaling. The point is to expose the slate-specific
// per-player tail variance directly so σ_{δ,G} sees a clean signal.
//
// Per world w:
//   gameShock[g] = lognormal(0, gameShockStd)        // shared by both teams
//   teamShock[t] = lognormal(0, teamShockStd)        // independent per team
// Per (player, world):
//   base = inverseCDF(player.percentiles, uniform)
//   score = max(0, base * teamShock[player.team] * gameShock[player.gameId])
//
// The base draw IS the slate-specific player tail (different players have
// different percentile shapes). Multiplying by team/game shocks adds the
// correlation structure without distorting the per-player tail.

function boxMullerStandardNormal(): number {
  // Math.random is overridden by makeMulberry32 by the caller.
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Lognormal random variable with mean ≈ 1 and stddev `std`. Subtracts the
 * mean correction so the multiplicative factor doesn't add a systematic bias.
 *   X = exp(Z·std − std²/2)   ⇒   E[X] = 1
 */
function lognormalUnitMean(std: number): number {
  if (std <= 0) return 1;
  return Math.exp(boxMullerStandardNormal() * std - 0.5 * std * std);
}

/**
 * Inverse CDF for a player using the SaberSim percentile knots.
 * Linear interpolation on the 8 knot points used elsewhere in the project.
 * If percentiles aren't available, falls back to projection ± stdDev (or
 * a derived stdDev from ceiling).
 */
function inverseCdfFromPercentiles(player: Player, u: number): number {
  const pcts = player.percentiles;
  if (!pcts || pcts.p50 <= 0) {
    // Fallback: normal-ish from projection + derived std
    const std = (player.stdDev && player.stdDev > 0)
      ? player.stdDev
      : Math.max(1, ((player.ceiling || player.projection * 1.15) - player.projection) / 1.04);
    // Inverse normal via Box-Muller-ish but seeded by u: not strictly inverse,
    // but for the fallback path the player has missing percentile data anyway.
    // Use a quick rational approximation.
    const z = inverseNormalApprox(u);
    return Math.max(0, player.projection + z * std);
  }

  // Knot points (quantiles, values). Tail extents extrapolated linearly.
  const iqr = pcts.p75 - pcts.p25;
  const floor = Math.max(0, pcts.p25 - iqr);
  const tailExtent = pcts.p99 + (pcts.p99 - pcts.p95) * 1.0; // modest fatten
  const Q = [0.00,  0.25,    0.50,    0.75,    0.85,    0.95,    0.99,    1.00];
  const V = [floor, pcts.p25, pcts.p50, pcts.p75, pcts.p85, pcts.p95, pcts.p99, tailExtent];

  // Find segment with binary search (Q is monotone)
  let lo = 0, hi = Q.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >>> 1;
    if (Q[mid] <= u) lo = mid;
    else hi = mid;
  }
  const span = Q[hi] - Q[lo];
  const t = span > 0 ? (u - Q[lo]) / span : 0;
  return Math.max(0, V[lo] + t * (V[hi] - V[lo]));
}

/** Acklam's rational approximation to the inverse normal CDF (good enough for sims). */
function inverseNormalApprox(p: number): number {
  if (p <= 0) return -8;
  if (p >= 1) return 8;
  // Coefficients for the rational approximation
  const a = [-3.969683028665376e+01,  2.209460984245205e+02,
             -2.759285104469687e+02,  1.383577518672690e+02,
             -3.066479806614716e+01,  2.506628277459239e+00];
  const b = [-5.447609879822406e+01,  1.615858368580409e+02,
             -1.556989798598866e+02,  6.680131188771972e+01,
             -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01,
             -2.400758277161838e+00, -2.549732539343734e+00,
              4.374664141464968e+00,  2.938163982698783e+00];
  const d = [7.784695709041462e-03,  3.224671290700398e-01,
             2.445134137142996e+00,  3.754408661907416e+00];
  const plow = 0.02425;
  const phigh = 1 - plow;
  let q: number, r: number;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
           ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  } else if (p <= phigh) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q /
           (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
            ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
}

/**
 * Fill the [P × W] world score matrix in place using the minimal simulator.
 * Caller is responsible for having installed a deterministic Math.random.
 */
function fillWorldsMinimal(
  out: Float32Array,
  players: Player[],
  W: number,
  params: SelectorParams,
  _sport: string,
): void {
  const P = players.length;

  // Map team / game to compact integer indices for fast lookup
  const teamIndex = new Map<string, number>();
  const gameIndex = new Map<string, number>();
  const playerTeamIdx = new Int32Array(P);
  const playerGameIdx = new Int32Array(P);
  for (let p = 0; p < P; p++) {
    const team = players[p].team || '';
    const game = players[p].gameInfo || `${team}_game`;
    if (!teamIndex.has(team)) teamIndex.set(team, teamIndex.size);
    if (!gameIndex.has(game)) gameIndex.set(game, gameIndex.size);
    playerTeamIdx[p] = teamIndex.get(team)!;
    playerGameIdx[p] = gameIndex.get(game)!;
  }
  const numTeams = teamIndex.size;
  const numGames = gameIndex.size;

  const teamShock = new Float64Array(numTeams);
  const gameShock = new Float64Array(numGames);

  for (let w = 0; w < W; w++) {
    // Sample one shock per team and per game for this world
    for (let t = 0; t < numTeams; t++) {
      teamShock[t] = lognormalUnitMean(params.teamShockStd);
    }
    for (let g = 0; g < numGames; g++) {
      gameShock[g] = lognormalUnitMean(params.gameShockStd);
    }
    // Per-player draw
    for (let p = 0; p < P; p++) {
      const u = Math.random();
      const base = inverseCdfFromPercentiles(players[p], u);
      const score = base * teamShock[playerTeamIdx[p]] * gameShock[playerGameIdx[p]];
      out[p * W + w] = score > 0 ? score : 0;
    }
  }
  // Pitcher coupling is applied in the shared post-processing pass
  // (applyPitcherCoupling) called after both sim paths in precomputeSlateInner.
}

// ============================================================
// PITCHER-OPPOSING-OFFENSE COUPLING (MLB)
// ============================================================

/**
 * Post-process the playerWorldScores matrix to add anti-correlation between
 * starting pitchers and the opposing team's hitters. When a pitcher draws
 * below expectation, opposing hitters are boosted; when a pitcher dominates,
 * opposing hitters are suppressed.
 *
 * This models the real-world causal link: the runs hitters score ARE the
 * earned runs the pitcher allows. Without this coupling the sim treats them
 * as independent, making "pitcher blows up" worlds look unexciting because
 * opposing hitters have average scores.
 *
 * COUPLING_STRENGTH=0.25: a pitcher at 50% of expected → opposing hitters
 * boosted by ~12.5%. A pitcher at 200% of expected → hitters suppressed ~12.5%.
 */
const PITCHER_COUPLING_STRENGTH = 0.25;

function applyPitcherCoupling(
  out: Float32Array,
  players: Player[],
  W: number,
  sport: Sport,
  indexMap: Map<string, number>,
): void {
  if (sport !== 'mlb') return;
  const P = players.length;

  // Identify pitchers and build team/game indices
  const teamIndex = new Map<string, number>();
  const gameIndex = new Map<string, number>();
  const playerTeamIdx = new Int32Array(P);
  const playerGameIdx = new Int32Array(P);
  for (let p = 0; p < P; p++) {
    const team = players[p].team || '';
    const game = players[p].gameInfo || `${team}_game`;
    if (!teamIndex.has(team)) teamIndex.set(team, teamIndex.size);
    if (!gameIndex.has(game)) gameIndex.set(game, gameIndex.size);
    playerTeamIdx[p] = teamIndex.get(team)!;
    playerGameIdx[p] = gameIndex.get(game)!;
  }

  // Find the highest-projected starting pitcher per (game, team)
  interface GPInfo { teamIdx: number; oppTeamIdx: number; playerIdx: number; expected: number }
  const bestByKey = new Map<string, { pIdx: number; proj: number }>();
  for (let p = 0; p < P; p++) {
    if (players[p].position !== 'P' && players[p].position !== 'SP') continue;
    const key = `${playerGameIdx[p]}_${playerTeamIdx[p]}`;
    const cur = bestByKey.get(key);
    if (!cur || players[p].projection > cur.proj) {
      bestByKey.set(key, { pIdx: p, proj: players[p].projection });
    }
  }
  // Build list with opposing team
  const gamePitchers: GPInfo[] = [];
  for (const [key, info] of bestByKey) {
    const [gStr, tStr] = key.split('_');
    const gIdx = parseInt(gStr), tIdx = parseInt(tStr);
    let oppTIdx = -1;
    for (let p = 0; p < P; p++) {
      if (playerGameIdx[p] === gIdx && playerTeamIdx[p] !== tIdx) {
        oppTIdx = playerTeamIdx[p]; break;
      }
    }
    if (oppTIdx >= 0) {
      gamePitchers.push({ teamIdx: tIdx, oppTeamIdx: oppTIdx, playerIdx: info.pIdx, expected: info.proj });
    }
  }
  if (gamePitchers.length === 0) return;

  // Identify hitters
  const isHitter = new Uint8Array(P);
  for (let p = 0; p < P; p++) {
    if (players[p].position !== 'P' && players[p].position !== 'SP') isHitter[p] = 1;
  }

  // Apply coupling per world
  for (let w = 0; w < W; w++) {
    for (const gp of gamePitchers) {
      const pitcherScore = out[gp.playerIdx * W + w];
      if (gp.expected <= 0) continue;
      const perfRatio = pitcherScore / gp.expected;
      const rawInverse = 1 / Math.max(0.1, perfRatio);
      const boost = 1 + PITCHER_COUPLING_STRENGTH * (rawInverse - 1);
      const clamped = Math.max(0.7, Math.min(2.0, boost));
      for (let p = 0; p < P; p++) {
        if (isHitter[p] && playerTeamIdx[p] === gp.oppTeamIdx) {
          out[p * W + w] *= clamped;
        }
      }
    }
  }
}

function precomputeSlateInner(
  pool: Lineup[],
  field: Lineup[],
  players: Player[],
  params: SelectorParams,
  sport: Sport,
): SlatePrecomputation {
  const W = params.numWorlds;
  const P = players.length;

  // ----- Player index map -----
  const indexMap = new Map<string, number>();
  for (let i = 0; i < P; i++) indexMap.set(players[i].id, i);

  // ----- Pre-filter the candidate pool by projection (top candidatePoolSize) -----
  // Stable sort with hash tiebreaker so two runs over the same input produce
  // the exact same candidate set even when many lineups have identical proj.
  const sortedPool = [...pool].sort((a, b) => {
    const dp = b.projection - a.projection;
    if (dp !== 0) return dp;
    return a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0;
  });
  const candidatePool = sortedPool.slice(0, Math.min(pool.length, params.candidatePoolSize));
  const C = candidatePool.length;

  // ----- Sample the field for thresholds + σ_{δ,G}, holding out the candidate pool -----
  // When the candidate pool and the field are drawn from the same source (Mode 2),
  // we exclude candidate hashes from the field sample so the threshold a candidate
  // is being compared against is not partly composed of itself. Eliminates leakage.
  // Lowered fallback threshold to 500 — a held-out set of 500-2000 leftover entries
  // is still vastly preferable to using the full field (which leaks the candidate
  // pool back into its own threshold computation).
  const candidateHashes = new Set(candidatePool.map(l => l.hash));
  const heldOutField = field.filter(l => !candidateHashes.has(l.hash));
  const fieldHeldOut = heldOutField.length >= 500;
  const fieldSource = fieldHeldOut ? heldOutField : field;
  const fieldSample = sampleLineups(fieldSource, params.fieldSampleSize, params.seed ?? 1337);
  const F = fieldSample.length;

  // ----- Simulate W worlds: per-world correlation shocks + per-player draw -----
  setSimSportConfig(sport);
  const playerWorldScores = new Float32Array(P * W);
  if (params.simulatorMode === 'minimal') {
    fillWorldsMinimal(playerWorldScores, players, W, params, sport);
  } else {
    for (let w = 0; w < W; w++) {
      const cf = generateCorrelationFactors(players, undefined, sport);
      for (let p = 0; p < P; p++) {
        playerWorldScores[p * W + w] = samplePlayerOutcome(players[p], cf);
      }
    }
  }

  // ----- Pitcher-opposing-offense coupling (MLB only, DISABLED) -----
  // Tested at COUPLING_STRENGTH 0.25 and 0.50 — both HURT MLB backtest
  // (1.52%→0.67% on 3-28, 3.55%→0.00% on 4-6-26). The multiplicative
  // hack over-biases toward opposing stacks that don't win proportionally.
  // The right fix is modeling pitcher-offense coupling in the correlation
  // factors of tournament-sim.ts, not a post-hoc multiplier. Keeping the
  // function for future experimentation but not calling it.
  // applyPitcherCoupling(playerWorldScores, players, W, sport, indexMap);

  // ----- Score the field across all worlds -----
  const fieldPlayerIndices: number[][] = fieldSample.map(lu => {
    const idxs: number[] = [];
    for (const pl of lu.players) {
      const i = indexMap.get(pl.id);
      if (i !== undefined) idxs.push(i);
    }
    return idxs;
  });

  const fieldWorldScores = new Float32Array(F * W);
  for (let f = 0; f < F; f++) {
    const idxs = fieldPlayerIndices[f];
    const base = f * W;
    for (let w = 0; w < W; w++) {
      let s = 0;
      for (let k = 0; k < idxs.length; k++) {
        s += playerWorldScores[idxs[k] * W + w];
      }
      fieldWorldScores[base + w] = s;
    }
  }

  // ----- Score the candidate pool across all worlds -----
  const candidatePlayerIndices: number[][] = candidatePool.map(lu => {
    const idxs: number[] = [];
    for (const pl of lu.players) {
      const i = indexMap.get(pl.id);
      if (i !== undefined) idxs.push(i);
    }
    return idxs;
  });

  const candidateWorldScores = new Float32Array(C * W);
  for (let c = 0; c < C; c++) {
    const idxs = candidatePlayerIndices[c];
    const base = c * W;
    for (let w = 0; w < W; w++) {
      let s = 0;
      for (let k = 0; k < idxs.length; k++) {
        s += playerWorldScores[idxs[k] * W + w];
      }
      candidateWorldScores[base + w] = s;
    }
  }

  // ----- Per-world thresholds at top-0.1%, top-1%, top-5% of the field -----
  // Also stash the per-world ASCENDING-SORTED field scores when log_payout mode
  // is active, since we need them for rank-based payout lookups.
  const thresh01 = new Float32Array(W);
  const thresh1 = new Float32Array(W);
  const thresh5 = new Float32Array(W);
  const rank01 = Math.max(1, Math.floor(F * params.rewardThresholds.top01));
  const rank1 = Math.max(1, Math.floor(F * params.rewardThresholds.top1));
  const rank5 = Math.max(1, Math.floor(F * params.rewardThresholds.top5));

  const wantPayoutTable = params.marginalRewardMode === 'log_payout';
  // Always compute & store the sorted field per world. This makes the
  // payout curve cheaply re-computable for parameter sweeps without
  // re-running the world simulation.
  const sortedFieldByWorld: Float32Array[] = new Array(W);

  for (let w = 0; w < W; w++) {
    const col = new Float32Array(F);
    for (let f = 0; f < F; f++) col[f] = fieldWorldScores[f * W + w];
    col.sort();
    thresh01[w] = col[F - rank01];
    thresh1[w] = col[F - rank1];
    thresh5[w] = col[F - rank5];
    sortedFieldByWorld[w] = col;
  }

  // ----- σ_{δ,G}: Cov(playerScore_p, threshold_at_target_percentile) per player -----
  const targetThresh = params.covTargetPercentile <= params.rewardThresholds.top01
    ? thresh01
    : params.covTargetPercentile <= params.rewardThresholds.top1
      ? thresh1
      : thresh5;

  let meanThresh = 0;
  for (let w = 0; w < W; w++) meanThresh += targetThresh[w];
  meanThresh /= W;

  const playerMeans = new Float64Array(P);
  const playerCovWithThreshold = new Float64Array(P);
  for (let p = 0; p < P; p++) {
    let mean = 0;
    for (let w = 0; w < W; w++) mean += playerWorldScores[p * W + w];
    mean /= W;
    playerMeans[p] = mean;

    let cov = 0;
    for (let w = 0; w < W; w++) {
      const dp = playerWorldScores[p * W + w] - mean;
      const dt = targetThresh[w] - meanThresh;
      cov += dp * dt;
    }
    playerCovWithThreshold[p] = cov / Math.max(1, W - 1);
  }

  // ----- Per-candidate aggregates: projection, mean, variance, covPenalty -----
  const candidateProjection = new Float64Array(C);
  const candidateMeanScore = new Float64Array(C);
  const candidateVariance = new Float64Array(C);
  const candidateCovPenalty = new Float64Array(C);

  for (let c = 0; c < C; c++) {
    const idxs = candidatePlayerIndices[c];

    // Projection — use the slate's pre-contest projections (sum across players)
    let proj = 0;
    for (const i of idxs) proj += players[i].projection;
    candidateProjection[c] = proj;

    // covPenalty — sum of σ_{δ,G} for the lineup's players
    let cov = 0;
    for (const i of idxs) cov += playerCovWithThreshold[i];
    candidateCovPenalty[c] = cov;

    // Empirical mean & variance from world scores
    const base = c * W;
    let m = 0;
    for (let w = 0; w < W; w++) m += candidateWorldScores[base + w];
    m /= W;
    candidateMeanScore[c] = m;

    let v = 0;
    for (let w = 0; w < W; w++) {
      const d = candidateWorldScores[base + w] - m;
      v += d * d;
    }
    candidateVariance[c] = v / Math.max(1, W - 1);
  }

  // ----- log_payout mode: compute per-(candidate × world) payout from rank curve -----
  // For each world w:
  //   1. The field is already sorted ascending (sortedFieldByWorld[w])
  //   2. For each candidate c, binary-search candidate's score → its rank in the
  //      field (1 = best). rank = F - (insertion index of cs in sortedFieldByWorld[w]).
  //   3. payout = K / rank^α for rank ≤ payoutCutoffFraction × F, else 0.
  //
  // K is chosen so that the BEST possible payout (rank=1) ≈ 10000 in arbitrary units.
  // The absolute scale is irrelevant for greedy selection — only the SHAPE matters
  // because log_utility cares about ratios.
  let candidatePayoutPerWorld: Float32Array | undefined;
  if (wantPayoutTable) {
    candidatePayoutPerWorld = new Float32Array(C * W);
    const alpha = params.payoutCurveExponent;
    const cutoffRank = Math.max(1, Math.floor(F * params.payoutCutoffFraction));
    const K = 10000;

    for (let w = 0; w < W; w++) {
      const sortedField = sortedFieldByWorld[w];
      for (let c = 0; c < C; c++) {
        const cs = candidateWorldScores[c * W + w];
        // Binary search: number of field entries strictly worse than cs
        let lo = 0, hi = F;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (sortedField[mid] <= cs) lo = mid + 1;
          else hi = mid;
        }
        // lo = count of field entries with score ≤ cs
        // rank in the combined (candidate inserted into field) = F - lo + 1
        // (number of field entries strictly better than cs, plus 1 for cs itself)
        const rank = F - lo + 1;
        if (rank > cutoffRank) {
          candidatePayoutPerWorld[c * W + w] = 0;
        } else {
          candidatePayoutPerWorld[c * W + w] = K / Math.pow(rank, alpha);
        }
      }
    }
  }

  // ----- λ auto-scale: equalize variance term and projection term at λ=1 -----
  // Compute mean projection and the absolute mean of the (variance − 2·covPenalty)
  // term across the candidate pool. The scale is meanProj / |meanVarTerm|, applied
  // multiplicatively to the variance term in the H-S objective. This is sport- and
  // slate-agnostic — the same lambda grid can now meaningfully sweep across MLB
  // (small score scale) and NBA (large score scale).
  let sumProj = 0;
  let sumVarTerm = 0;
  for (let c = 0; c < C; c++) {
    sumProj += candidateProjection[c];
    sumVarTerm += (candidateVariance[c] - 2 * candidateCovPenalty[c]);
  }
  const meanProj = C > 0 ? sumProj / C : 1;
  const meanVarTerm = C > 0 ? sumVarTerm / C : 1;
  const lambdaScale = meanProj / Math.max(1e-6, Math.abs(meanVarTerm));

  return {
    W, P, C, F,
    playerWorldScores,
    candidateWorldScores,
    fieldWorldScores,
    candidateMeanScore,
    candidateVariance,
    candidateCovPenalty,
    candidateProjection,
    playerMeans,
    playerCovWithThreshold,
    thresh01,
    thresh1,
    thresh5,
    candidatePayoutPerWorld,
    sortedFieldByWorld,
    candidatePool,
    fieldSample,
    indexMap,
    lambdaScale,
    fieldHeldOut,
  };
}

// ============================================================
// PAYOUT CURVE REBUILD (for parameter sweeps)
// ============================================================

/**
 * Recompute the per-(candidate × world) payout array on a cached precomputation
 * with new payout-curve parameters. This is the cheap way to sweep payout
 * params without re-running the slow world simulation.
 *
 * Returns a NEW SlatePrecomputation object that shares all heavy arrays with
 * the input but has a fresh `candidatePayoutPerWorld`.
 */
export function recomputePayoutCurve(
  precomp: SlatePrecomputation,
  payoutCurveExponent: number,
  payoutCutoffFraction: number,
): SlatePrecomputation {
  const { W, C, F, candidateWorldScores, sortedFieldByWorld } = precomp;
  const out = new Float32Array(C * W);
  const cutoffRank = Math.max(1, Math.floor(F * payoutCutoffFraction));
  const K = 10000;

  for (let w = 0; w < W; w++) {
    const sortedField = sortedFieldByWorld[w];
    for (let c = 0; c < C; c++) {
      const cs = candidateWorldScores[c * W + w];
      // Binary search: count of field entries with score ≤ cs
      let lo = 0, hi = F;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (sortedField[mid] <= cs) lo = mid + 1;
        else hi = mid;
      }
      const rank = F - lo + 1;
      out[c * W + w] = rank > cutoffRank ? 0 : K / Math.pow(rank, payoutCurveExponent);
    }
  }

  return { ...precomp, candidatePayoutPerWorld: out };
}

// ============================================================
// SELECTION
// ============================================================

export interface SelectionDiagnostics {
  selectedCount: number;
  /** Avg projection of selected vs avg projection of (filtered) candidate pool. */
  avgSelectedProjection: number;
  avgPoolProjection: number;
  /** Avg ownership of selected vs avg ownership of pool. */
  avgSelectedOwnership: number;
  avgPoolOwnership: number;
  /** Liu et al. portfolio diversity score (mean pairwise Var(z_i − z_j)). */
  portfolioDiversityScore: number;
  /** Top player exposure across selected lineups (max). */
  maxPlayerExposure: number;
  /** How many times we had to relax γ to keep filling. */
  gammaRelaxations: number;
  /** How many times we had to relax the exposure cap to keep filling. */
  exposureRelaxations: number;
  /** λ value distribution: how many entries used each λ. */
  lambdaUsage: Map<number, number>;
  /** Per-pick λ value, in selection order (parallel to selected[]). */
  pickedLambdas: number[];
  /** Average marginal reward at each entry index (debug). */
  marginalRewardCurve: number[];
  /** Auto-computed λ scale (proj/varTerm). Useful for debugging the λ grid. */
  lambdaScale: number;
  /** Whether the field sample was held out from the candidate pool. */
  fieldHeldOut: boolean;
}

/**
 * Algorithm 7 greedy selection: at each step, generate one candidate per λ,
 * then pick the λ-candidate that maximizes marginal portfolio reward (with
 * an early-entry diversification boost). γ overlap is enforced as a hard
 * filter on remaining candidates after each pick.
 */
export function algorithm7Select(
  precomp: SlatePrecomputation,
  params: SelectorParams,
): { selected: Lineup[]; diagnostics: SelectionDiagnostics } {
  const {
    W, C,
    candidateWorldScores,
    candidateProjection,
    candidateVariance,
    candidateCovPenalty,
    thresh01, thresh1, thresh5,
    candidatePayoutPerWorld,
    candidatePool,
    lambdaScale,
  } = precomp;

  const useLogPayout = params.marginalRewardMode === 'log_payout' && !!candidatePayoutPerWorld;

  // active[c] = true if candidate c is still eligible (γ + exposure cap)
  const active = new Uint8Array(C).fill(1);

  // For γ-overlap checks, store each candidate's player ID set.
  const candidateIdSets: Set<string>[] = candidatePool.map(lu => new Set(lu.players.map(p => p.id)));

  // ---- Per-tier portfolio HIT COUNTS per world (tiered mode, split-pot) ----
  const portfolioCount01 = new Uint16Array(W);
  const portfolioCount1 = new Uint16Array(W);
  const portfolioCount5 = new Uint16Array(W);

  // ---- Per-world running total payout (log_payout mode) ----
  // This is the sum of selected lineups' rank-based payouts in each world.
  // The marginal reward of adding candidate c is the log-utility increment:
  //     Σ_w log1p(newPayout_c[w] / (1 + portfolioPayoutPerWorld[w]))
  // which naturally values worlds where the portfolio is currently empty over
  // worlds where it's already winning (Kelly diversification).
  const portfolioPayoutPerWorld = useLogPayout ? new Float32Array(W) : new Float32Array(0);

  // ---- Per-player exposure counts for the explicit cap ----
  const exposureCounts = new Map<string, number>();
  let exposureCap = params.maxPlayerExposure > 0 && params.maxPlayerExposure < 1
    ? Math.max(1, Math.ceil(params.N * params.maxPlayerExposure))
    : params.N;

  const selected: Lineup[] = [];
  const lambdaUsage = new Map<number, number>();
  const pickedLambdas: number[] = [];
  const marginalRewardCurve: number[] = [];
  let gammaRelaxations = 0;
  let exposureRelaxations = 0;
  let gamma = params.gamma;

  const lambdaGrid = params.lambdaGrid.slice();

  for (let i = 0; i < params.N; i++) {
    const isEarly = i < params.earlyEntryCount;
    const activeLambdas = isEarly ? lambdaGrid : lambdaGrid.filter((_, idx) => idx % 2 === 0);

    // ---- For each λ, find the candidate maximizing the H-S objective ----
    // Objective: w'μ + λ · lambdaScale · (w'Σw − 2 w'σ_{δ,G})
    // The lambdaScale rescaling makes λ=1 mean "variance term ≈ projection
    // term in magnitude" so the grid sweeps a meaningful tradeoff range.
    const perLambdaBest: Array<{ ci: number; lambda: number; objective: number }> = [];
    for (const lambda of activeLambdas) {
      const effective = lambda * lambdaScale;
      let bestCi = -1;
      let bestObj = -Infinity;
      for (let c = 0; c < C; c++) {
        if (!active[c]) continue;
        const obj = candidateProjection[c]
          + effective * (candidateVariance[c] - 2 * candidateCovPenalty[c]);
        if (obj > bestObj) {
          bestObj = obj;
          bestCi = c;
        }
      }
      if (bestCi >= 0) {
        perLambdaBest.push({ ci: bestCi, lambda, objective: bestObj });
      }
    }

    if (perLambdaBest.length === 0) {
      // Pool exhausted. Try (a) relaxing γ first (still cheap), then
      // (b) bumping the exposure cap by ~5% of N. Stop only when both
      // levers are at max.
      const rosterSize = candidatePool[0]?.players.length ?? gamma + 1;
      let relaxed = false;
      if (gamma < rosterSize - 1) {
        gamma++;
        gammaRelaxations++;
        relaxed = true;
      } else if (exposureCap < params.N) {
        // Bump cap by 5% of N (min +1) so the next iteration has fresh slack.
        exposureCap = Math.min(params.N, exposureCap + Math.max(1, Math.ceil(params.N * 0.05)));
        exposureRelaxations++;
        relaxed = true;
      }
      if (!relaxed) break;

      // Refilter the entire pool with the relaxed constraints.
      for (let c = 0; c < C; c++) {
        if (overflowsExposureCap(candidatePool[c], exposureCounts, exposureCap, 0)) {
          active[c] = 0;
          continue;
        }
        let ok = true;
        for (const sel of selected) {
          if (countOverlap(candidateIdSets[c], sel) > gamma) { ok = false; break; }
        }
        active[c] = ok ? 1 : 0;
      }
      i--;
      continue;
    }

    // ---- Compute marginal reward for each λ-best candidate ----
    let bestPick = perLambdaBest[0];
    let bestReward = -Infinity;
    const earlyMul = isEarly ? params.earlyDiversifyBoost : 1.0;

    for (const cand of perLambdaBest) {
      const reward = useLogPayout
        ? computeLogPayoutMarginalReward(
            cand.ci, candidatePayoutPerWorld!, portfolioPayoutPerWorld, W,
          )
        : computeSplitPotMarginalReward(
            cand.ci, candidateWorldScores,
            portfolioCount01, portfolioCount1, portfolioCount5,
            thresh01, thresh1, thresh5, W, params.rewardWeights,
          );
      const adj = reward * earlyMul;
      if (adj > bestReward) {
        bestReward = adj;
        bestPick = cand;
      }
    }

    // ---- Commit the pick ----
    const pickedCi = bestPick.ci;
    const pickedLineup = candidatePool[pickedCi];
    selected.push(pickedLineup);
    pickedLambdas.push(bestPick.lambda);
    marginalRewardCurve.push(bestReward / Math.max(1, earlyMul));
    lambdaUsage.set(bestPick.lambda, (lambdaUsage.get(bestPick.lambda) ?? 0) + 1);

    // Update per-tier portfolio counts (for next iteration's split-pot reward)
    const base = pickedCi * W;
    for (let w = 0; w < W; w++) {
      const s = candidateWorldScores[base + w];
      if (s > thresh01[w]) portfolioCount01[w]++;
      if (s > thresh1[w]) portfolioCount1[w]++;
      if (s > thresh5[w]) portfolioCount5[w]++;
    }
    // Update per-world portfolio payout running total (log_payout mode)
    if (useLogPayout) {
      for (let w = 0; w < W; w++) {
        portfolioPayoutPerWorld[w] += candidatePayoutPerWorld![base + w];
      }
    }

    // Update exposure counts
    for (const p of pickedLineup.players) {
      exposureCounts.set(p.id, (exposureCounts.get(p.id) ?? 0) + 1);
    }

    // Drop the picked candidate, anything sharing > γ players, anything
    // containing a player that is now at the exposure cap.
    active[pickedCi] = 0;
    for (let c = 0; c < C; c++) {
      if (!active[c]) continue;
      // γ overlap test
      if (countOverlap(candidateIdSets[c], pickedLineup) > gamma) {
        active[c] = 0;
        continue;
      }
      // Exposure cap test (only against players whose count just changed)
      if (overflowsExposureCap(candidatePool[c], exposureCounts, exposureCap, 0)) {
        active[c] = 0;
      }
    }

    if ((i + 1) % 25 === 0 || i + 1 === params.N) {
      const remaining = countActive(active);
      console.log(
        `  [alg7] selected ${i + 1}/${params.N}  active=${remaining}  λ*=${bestPick.lambda}  ` +
        `marginalReward=${(bestReward / earlyMul).toFixed(3)}`,
      );
    }
  }

  return {
    selected,
    diagnostics: buildDiagnostics(
      selected, candidatePool, precomp,
      lambdaUsage, pickedLambdas, marginalRewardCurve,
      gammaRelaxations, exposureRelaxations,
    ),
  };
}

/**
 * True if adding `lu` would push any of its players past the exposure cap.
 * `slack` is an extra buffer (used during γ relaxation when many slots remain).
 */
function overflowsExposureCap(
  lu: Lineup,
  counts: Map<string, number>,
  cap: number,
  slack: number,
): boolean {
  for (const p of lu.players) {
    const c = counts.get(p.id) ?? 0;
    if (c >= cap + slack) return true;
  }
  return false;
}

// ============================================================
// MARGINAL REWARD
// ============================================================

/**
 * Split-pot marginal reward (the GPP-correct version).
 *
 * Each entry contributes its OWN expected payout — every entry that lands in
 * a payout tier earns from that tier independently. The cannibalization comes
 * from the prize being SHARED among entries hitting the same tier in the
 * same world: if N portfolio entries already beat threshold_K[w], the next
 * entry to also beat it adds 1/(N+1) of the per-hit weight (the marginal
 * fractional share it would receive if added to the bucket).
 *
 *   reward(c) = (1/W) Σ_w Σ_tier  weight_tier · I(cs_c > thresh_tier[w]) · 1/(n_tier[w] + 1)
 *
 * Properties:
 *   - First entry in any world/tier gets full credit (1/1 = 1).
 *   - Each subsequent entry covering the same world/tier earns less
 *     (1/2, 1/3, ...) — cannibalization is built in.
 *   - A high-projection chalk lineup that hits top-1% in 80% of worlds gets
 *     diminishing returns as the portfolio grows; an uncorrelated boom
 *     lineup that hits top-0.1% in worlds where nothing else does still
 *     earns the full 1/1 weight.
 *
 * This replaces the old winner-take-all "is candidate the new best" model,
 * which was structurally incapable of valuing diversification because it
 * only counted worlds where no portfolio entry had yet hit the threshold.
 */
/**
 * Log-utility marginal reward (Kelly-style, for marginalRewardMode='log_payout').
 *
 * Each candidate has a per-world payout from the rank-based DK payout curve.
 * The marginal reward of adding it to the portfolio is the LOG-UTILITY increment:
 *
 *   ΔU(c) = (1/W) Σ_w  log(1 + portfolio[w] + new[w]) − log(1 + portfolio[w])
 *         = (1/W) Σ_w  log1p(new[w] / (1 + portfolio[w]))
 *
 * Why log:
 *   - In a world where the portfolio currently wins NOTHING (portfolio[w] = 0),
 *     adding $X gives log1p(X) — large for any positive X.
 *   - In a world where the portfolio already wins big (portfolio[w] = 10000),
 *     adding $X gives log1p(X/10001) ≈ X/10001 — tiny.
 *
 * This is the formal Kelly diversification insight: marginal value of an entry
 * is huge in worlds the portfolio doesn't yet cover, and small in worlds it
 * already wins. High-projection chalk lineups that bunch up in the same worlds
 * lose the marginal-reward race naturally to high-variance contrarian plays
 * that cover *new* worlds — exactly the structural fix the papers describe.
 */
function computeLogPayoutMarginalReward(
  ci: number,
  candidatePayoutPerWorld: Float32Array,
  portfolioPayoutPerWorld: Float32Array,
  W: number,
): number {
  const base = ci * W;
  let acc = 0;
  for (let w = 0; w < W; w++) {
    const newPayout = candidatePayoutPerWorld[base + w];
    if (newPayout <= 0) continue;
    // log1p(x) = log(1+x), numerically stable for small x
    acc += Math.log1p(newPayout / (1 + portfolioPayoutPerWorld[w]));
  }
  return acc / W;
}

function computeSplitPotMarginalReward(
  ci: number,
  candidateWorldScores: Float32Array,
  portfolioCount01: Uint16Array,
  portfolioCount1: Uint16Array,
  portfolioCount5: Uint16Array,
  thresh01: Float32Array,
  thresh1: Float32Array,
  thresh5: Float32Array,
  W: number,
  weights: { top01: number; top1: number; top5: number },
): number {
  const base = ci * W;
  let acc = 0;
  for (let w = 0; w < W; w++) {
    const cs = candidateWorldScores[base + w];
    if (cs > thresh01[w]) acc += weights.top01 / (portfolioCount01[w] + 1);
    if (cs > thresh1[w])  acc += weights.top1  / (portfolioCount1[w]  + 1);
    if (cs > thresh5[w])  acc += weights.top5  / (portfolioCount5[w]  + 1);
  }
  return acc / W;
}

// ============================================================
// HELPERS
// ============================================================

function countOverlap(idSet: Set<string>, other: Lineup): number {
  let n = 0;
  for (const p of other.players) {
    if (idSet.has(p.id)) n++;
  }
  return n;
}

function countActive(active: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < active.length; i++) if (active[i]) n++;
  return n;
}

function sampleLineups(arr: Lineup[], k: number, seed: number): Lineup[] {
  if (arr.length <= k) return arr.slice();
  // Deterministic LCG shuffle (only first k positions)
  let s = (seed >>> 0) || 1;
  const rng = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  const out = arr.slice();
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rng() * (out.length - i));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out.slice(0, k);
}

// ============================================================
// LIU ET AL. — DIVERSITY DIAGNOSTIC
// ============================================================

/**
 * Liu et al. Equation 14 — average pairwise Var(z_i − z_j) across the portfolio.
 * Higher = more diversified (entries cover different worlds).
 */
export function computePortfolioDiversityScore(
  selectedWorldScores: Float32Array,  // [N × W] flat
  N: number,
  W: number,
): number {
  if (N < 2) return 0;
  // Pre-compute per-entry mean and variance
  const means = new Float64Array(N);
  const vars_ = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let m = 0;
    for (let w = 0; w < W; w++) m += selectedWorldScores[i * W + w];
    m /= W;
    means[i] = m;
    let v = 0;
    for (let w = 0; w < W; w++) {
      const d = selectedWorldScores[i * W + w] - m;
      v += d * d;
    }
    vars_[i] = v / Math.max(1, W - 1);
  }
  // Mean pairwise Var(z_i − z_j) = Var(z_i) + Var(z_j) − 2 Cov(z_i, z_j)
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      let cov = 0;
      for (let w = 0; w < W; w++) {
        cov += (selectedWorldScores[i * W + w] - means[i]) *
               (selectedWorldScores[j * W + w] - means[j]);
      }
      cov /= Math.max(1, W - 1);
      total += vars_[i] + vars_[j] - 2 * cov;
      pairs++;
    }
  }
  return pairs > 0 ? total / pairs : 0;
}

// ============================================================
// DIAGNOSTICS
// ============================================================

function buildDiagnostics(
  selected: Lineup[],
  candidatePool: Lineup[],
  precomp: SlatePrecomputation,
  lambdaUsage: Map<number, number>,
  pickedLambdas: number[],
  marginalRewardCurve: number[],
  gammaRelaxations: number,
  exposureRelaxations: number,
): SelectionDiagnostics {
  const N = selected.length;
  const W = precomp.W;

  // Build a flat [N × W] world-score matrix for the selected lineups so we can
  // compute the Liu et al. diversity score.
  const selectedWorldScores = new Float32Array(N * W);
  // Map selected back to candidatePool indices via hash
  const hashToCi = new Map<string, number>();
  for (let c = 0; c < candidatePool.length; c++) {
    hashToCi.set(candidatePool[c].hash, c);
  }
  for (let i = 0; i < N; i++) {
    const ci = hashToCi.get(selected[i].hash);
    if (ci === undefined) continue;
    const base = ci * W;
    for (let w = 0; w < W; w++) {
      selectedWorldScores[i * W + w] = precomp.candidateWorldScores[base + w];
    }
  }

  const portfolioDiversityScore = computePortfolioDiversityScore(selectedWorldScores, N, W);

  // Avg projection / ownership
  const avgSelectedProjection = N > 0
    ? selected.reduce((s, lu) => s + lu.projection, 0) / N
    : 0;
  const avgPoolProjection = candidatePool.length > 0
    ? candidatePool.reduce((s, lu) => s + lu.projection, 0) / candidatePool.length
    : 0;
  const avgSelectedOwnership = N > 0
    ? selected.reduce((s, lu) => s + lu.ownership, 0) / N
    : 0;
  const avgPoolOwnership = candidatePool.length > 0
    ? candidatePool.reduce((s, lu) => s + lu.ownership, 0) / candidatePool.length
    : 0;

  // Player exposure
  const exposureCounts = new Map<string, number>();
  for (const lu of selected) {
    for (const p of lu.players) {
      exposureCounts.set(p.id, (exposureCounts.get(p.id) ?? 0) + 1);
    }
  }
  let maxExposureCount = 0;
  for (const v of exposureCounts.values()) if (v > maxExposureCount) maxExposureCount = v;
  const maxPlayerExposure = N > 0 ? maxExposureCount / N : 0;

  return {
    selectedCount: N,
    avgSelectedProjection,
    avgPoolProjection,
    avgSelectedOwnership,
    avgPoolOwnership,
    portfolioDiversityScore,
    maxPlayerExposure,
    gammaRelaxations,
    exposureRelaxations,
    lambdaUsage,
    pickedLambdas,
    marginalRewardCurve,
    lambdaScale: precomp.lambdaScale,
    fieldHeldOut: precomp.fieldHeldOut,
  };
}
