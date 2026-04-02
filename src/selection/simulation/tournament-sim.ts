/**
 * DFS Optimizer CLI - Tournament Simulation
 *
 * Monte Carlo simulation of tournaments to evaluate lineup quality.
 * Simulates player outcomes, generates field lineups, and tracks finish positions.
 */

import { Lineup, ScoredLineup, Player, PlayerPercentiles, ContestConfig, ContestSize } from '../../types';
import { extractPrimaryCombo } from '../scoring/field-analysis';

// ============================================================
// SEEDED PRNG (for deterministic field generation)
// ============================================================

/**
 * Mulberry32 — fast, high-quality 32-bit PRNG.
 * Returns a function that produces uniform [0, 1) on each call.
 */
export function createSeededRandom(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Convert a "YYYY-MM-DD" date string to a numeric seed.
 */
export function dateSeed(dateStr: string): number {
  let hash = 0;
  for (let i = 0; i < dateStr.length; i++) {
    hash = ((hash << 5) - hash + dateStr.charCodeAt(i)) | 0;
  }
  return hash;
}

// ============================================================
// SIMULATION TYPES
// ============================================================

export interface SimulationConfig {
  numSimulations: number;      // Number of tournaments to simulate
  fieldSize: number;           // Size of competition field
  entryFee: number;            // Entry cost for ROI calculation
  payoutStructure: PayoutTier[];
  topNPositions?: number;      // Track P(finishing in top N) — e.g., 5000 for "top 5K"
}

export interface PayoutTier {
  maxPosition: number;         // Up to this position
  payout: number;              // Payout amount
}

export interface SimulationResult {
  lineupHash: string;
  avgFinishPosition: number;
  avgFinishPercentile: number;
  pFirst: number;              // P(1st place)
  pTop1Pct: number;            // P(top 1%)
  pTop5Pct: number;            // P(top 5%)
  pTop10Pct: number;           // P(top 10%)
  pCash: number;               // P(min cash)
  pTopN: number;               // P(finishing in top N positions) — configurable
  expectedPayout: number;
  expectedROI: number;
  winRate: number;             // % of simulations where this was best
  simulationScore: number;     // Overall 0-1 score
  finishPositionVector?: number[] | Float32Array;  // Per-sim finish positions for marginal portfolio analysis
  tier?: 'full' | 'quick' | 'ultra';  // Which simulation tier was used
}

export interface FieldLineup {
  playerIds: string[];
  salaries: number[];
  archetype: FieldArchetype;
}

// Original 3 archetypes + expanded archetypes
export type FieldArchetype =
  | 'chalk' | 'balanced' | 'contrarian'                    // Original 3
  | 'semiChalk' | 'stackChalk'                              // Chalk variants
  | 'leverageOptimizer' | 'ceilingOptimizer' | 'casual'    // New archetypes
  | 'sharpOptimizer'                                        // Sophisticated DFS pros
  | 'stackBuilder';                                         // Intentional game stackers

/**
 * Expanded field configuration: 7 archetypes modeling realistic GPP field.
 */
export interface ExpandedFieldConfig {
  // Chalk segment (55% total)
  pureChalk: number;           // Ownership-proportional (default: 0.30)
  semiChalk: number;           // Chalk with 1-2 low-owned pivots (default: 0.15)
  stackChalk: number;          // Chalk with deliberate game stacks (default: 0.10)

  // Optimizer segment (25% total)
  projectionOptimizer: number; // Pure projection greedy (default: 0.10)
  leverageOptimizer: number;   // Projection with moderate ownership penalty (default: 0.08)
  ceilingOptimizer: number;    // Projection + ceiling blend (default: 0.07)

  // Casual/contrarian segment (20% total)
  casual: number;              // Random with team/name bias + noise (default: 0.10)
  contrarian: number;          // Projection - heavy ownership penalty (default: 0.10)

  // Sharp segment
  sharpOptimizer: number;      // Sophisticated DFS pros (default: 0.08)

  // Stack segment
  stackBuilder: number;        // Intentional game stackers (default: 0.10)
}

const DEFAULT_EXPANDED_FIELD_CONFIG: ExpandedFieldConfig = {
  pureChalk: 0.25,           // was 0.20 — chalk is everywhere in 150K GPPs
  semiChalk: 0.14,           // was 0.12
  stackChalk: 0.09,          // was 0.08
  projectionOptimizer: 0.06, // was 0.10 — fewer pure optimizers in real field
  leverageOptimizer: 0.04,   // was 0.08
  ceilingOptimizer: 0.04,    // was 0.07
  casual: 0.14,              // was 0.07 — casuals are everywhere in large GPPs
  contrarian: 0.06,          // was 0.08
  sharpOptimizer: 0.08,      // was 0.10
  stackBuilder: 0.10,        // unchanged
};

// ============================================================
// MULTI-FIELD ENVIRONMENTS
// ============================================================

/**
 * A field environment represents a distinct contest composition.
 * By simulating against multiple environments, the portfolio hedges
 * against field model error — if one environment's archetype mix is
 * wrong, the others provide a safety net.
 */
export interface FieldEnvironment {
  name: string;
  fieldSize: number;               // Lineups to generate for this environment
  simsPerField: number;            // Sims to run against this environment
  config: ExpandedFieldConfig;     // Archetype ratios for this environment
  fieldPool?: FieldLineup[];       // Populated during field generation
}

/**
 * Default field environments for backwards compatibility (20max contest size).
 * Use getFieldEnvironments(contestSize) for contest-size-aware environments.
 */
export const FIELD_ENVIRONMENTS: FieldEnvironment[] = getFieldEnvironments('20max');

/**
 * Generate 5 diverse field environments adapted to contest size.
 *
 * Contest size fundamentally changes field composition:
 * - Single-entry: ~60% casual/chalk, ~15% sharp (recreational players dominate)
 * - 3max: ~45% chalk, ~25% sharp (moderate optimizer presence)
 * - 20max: ~35% chalk, ~35% sharp (heavy optimizer presence)
 * - 150max: ~20% chalk, ~50% sharp (dominated by sharp optimizers)
 *
 * Each environment tests a different field composition hypothesis.
 * The portfolio hedges across all 5 by selecting lineups that perform
 * well regardless of which environment materializes.
 */
export function getFieldEnvironments(contestSize: ContestSize = '20max'): FieldEnvironment[] {
  // Base archetype ratios per contest size
  // These represent the CENTER of the distribution — each environment
  // perturbs around this center to test different hypotheses
  const baseConfigs: Record<ContestSize, {
    chalk: number;     // pureChalk + semiChalk + stackChalk total
    optimizer: number; // projOptimizer + leverageOpt + ceilingOpt total
    casual: number;    // casual total
    contrarian: number;
    sharp: number;     // sharpOptimizer total
    stacker: number;   // stackBuilder total
  }> = {
    single: {
      chalk: 0.48,       // Recreational players build chalk lineups
      optimizer: 0.10,   // Few use optimizers in single-entry
      casual: 0.18,      // Many casual "my favorite players" entries
      contrarian: 0.06,
      sharp: 0.10,       // Some sharps still enter singles
      stacker: 0.08,     // Some casual players stack their favorite teams
    },
    '3max': {
      chalk: 0.38,
      optimizer: 0.16,
      casual: 0.10,
      contrarian: 0.08,
      sharp: 0.18,
      stacker: 0.10,
    },
    '20max': {
      chalk: 0.38,       // More chalk than previously modeled
      optimizer: 0.12,
      casual: 0.12,      // Casuals still present in 20max
      contrarian: 0.08,
      sharp: 0.18,       // Fewer sharps than we thought
      stacker: 0.12,
    },
    '150max': {
      chalk: 0.30,       // Even 150max has significant chalk
      optimizer: 0.14,
      casual: 0.08,      // Some casuals even in 150max
      contrarian: 0.08,
      sharp: 0.25,       // Reduced from 0.40 — field not as sharp as modeled
      stacker: 0.15,
    },
  };

  const base = baseConfigs[contestSize];

  // Decompose chalk into sub-archetypes (ratio is stable across sizes)
  const chalkDecomp = (total: number) => ({
    pureChalk: total * 0.50,
    semiChalk: total * 0.30,
    stackChalk: total * 0.20,
  });

  // Decompose optimizer into sub-archetypes
  const optDecomp = (total: number) => ({
    projectionOptimizer: total * 0.45,
    leverageOptimizer: total * 0.30,
    ceilingOptimizer: total * 0.25,
  });

  const makeConfig = (
    chalkMult: number, optMult: number, casualMult: number,
    contrMult: number, sharpMult: number, stackMult: number = 1.0
  ): ExpandedFieldConfig => {
    const chalk = chalkDecomp(base.chalk * chalkMult);
    const opt = optDecomp(base.optimizer * optMult);
    const casual = base.casual * casualMult;
    const contrarian = base.contrarian * contrMult;
    const sharp = base.sharp * sharpMult;
    const stacker = base.stacker * stackMult;

    // Normalize to sum to 1.0
    const total = chalk.pureChalk + chalk.semiChalk + chalk.stackChalk +
      opt.projectionOptimizer + opt.leverageOptimizer + opt.ceilingOptimizer +
      casual + contrarian + sharp + stacker;

    return {
      pureChalk: chalk.pureChalk / total,
      semiChalk: chalk.semiChalk / total,
      stackChalk: chalk.stackChalk / total,
      projectionOptimizer: opt.projectionOptimizer / total,
      leverageOptimizer: opt.leverageOptimizer / total,
      ceilingOptimizer: opt.ceilingOptimizer / total,
      casual: casual / total,
      contrarian: contrarian / total,
      sharpOptimizer: sharp / total,
      stackBuilder: stacker / total,
    };
  };

  // 3 most distinct environments × 1000 sims each = 3000 total sims/candidate.
  // Kept at 1000/env (not 1500) — testing showed more sims hurt performance,
  // likely because noise acts as exploration and helps find outlier winners.
  return [
    {
      name: 'casual-heavy',
      fieldSize: 8000,
      simsPerField: 1000,
      config: makeConfig(1.3, 0.7, 2.5, 0.6, 0.5, 0.8),
    },
    {
      name: 'standard',
      fieldSize: 8000,
      simsPerField: 1000,
      config: makeConfig(1.0, 1.0, 1.0, 1.0, 1.0, 1.0),
    },
    {
      name: 'sharp-heavy',
      fieldSize: 8000,
      simsPerField: 1000,
      config: makeConfig(0.6, 1.0, 0.4, 1.2, 1.8, 1.3),
    },
  ];
}

/**
 * Build a realistic DK GPP payout structure scaled to field size and entry fee.
 *
 * Modeled from actual DraftKings NBA GPP payout tables.
 * Key properties:
 *   - Extremely top-heavy (1st ≈ 29% of prize pool)
 *   - ~22% of field cashes (min cash ≈ 1.1× entry)
 *   - Smooth power-law decay between 1st and min cash
 *   - Total payouts ≈ 85% of gross (15% DK rake)
 */
export function buildGPPPayoutStructure(fieldSize: number, entryFee: number): PayoutTier[] {
  const prizePool = fieldSize * entryFee * 0.85;
  const cashLine = Math.ceil(fieldSize * 0.22);
  const minCash = Math.ceil(entryFee * 1.1);

  // Reference tiers: position as % of field, payout as % of prize pool per position
  // Derived from real DK GPPs (10K-entry $20 contests)
  const tiers: Array<{ posPct: number; poolPct: number }> = [
    { posPct: 0.0001, poolPct: 0.290 },     // 1st
    { posPct: 0.0002, poolPct: 0.070 },     // 2nd
    { posPct: 0.0003, poolPct: 0.044 },     // 3rd
    { posPct: 0.0005, poolPct: 0.024 },     // 4th-5th
    { posPct: 0.001,  poolPct: 0.0090 },    // ~top 0.1%
    { posPct: 0.0025, poolPct: 0.0030 },    // ~top 0.25%
    { posPct: 0.005,  poolPct: 0.0015 },    // ~top 0.5%
    { posPct: 0.01,   poolPct: 0.00060 },   // ~top 1%
    { posPct: 0.025,  poolPct: 0.00030 },   // ~top 2.5%
    { posPct: 0.05,   poolPct: 0.00021 },   // ~top 5%
    { posPct: 0.10,   poolPct: 0.00017 },   // ~top 10%
    { posPct: 0.15,   poolPct: 0.00014 },   // ~top 15%
  ];

  const result: PayoutTier[] = [];
  for (const t of tiers) {
    const pos = Math.max(result.length + 1, Math.ceil(fieldSize * t.posPct));
    const payout = Math.round(prizePool * t.poolPct);
    if (payout >= minCash) {
      result.push({ maxPosition: pos, payout });
    }
  }

  // Min cash tier
  result.push({ maxPosition: cashLine, payout: minCash });

  return result;
}

// Default: 10K field, $20 entry
const DEFAULT_PAYOUT_STRUCTURE: PayoutTier[] = buildGPPPayoutStructure(10000, 20);

// ============================================================
// PLAYER OUTCOME SIMULATION (WITH CORRELATION)
// ============================================================

/**
 * Correlation factors for a single simulation.
 * These factors model real-world correlation sources:
 *
 * 1. GAME FACTOR: High-scoring games boost ALL players in that game.
 *    - Captures pace, overtime potential, defensive breakdowns
 *    - Typical correlation: 0.3-0.5 between players in same game
 *
 * 2. TEAM FACTOR: When a team is "hot", their players correlate.
 *    - Captures game script, team-level execution, foul trouble
 *    - Typical correlation: 0.4-0.6 between teammates
 *
 * Without these factors, simulation treats Joel Embiid and Tyrese Maxey
 * as independent, which is wrong - they share the same game environment.
 */
export interface CorrelationFactors {
  gamePaceFactors: Map<string, number>;     // gameId -> symmetric pace factor (0.70 to 1.30)
  gameScriptFactors: Map<string, number>;   // gameId -> anti-symmetric script factor
  gameTeamSides: Map<string, { teamA: string; teamB: string }>; // which team is "A" vs "B"
  teamFactors: Map<string, number>;         // team -> independent execution factor (0.80 to 1.20)
  teamUsageShifts?: Map<string, Map<string, number>>; // team -> (playerId -> zero-sum usage shift)
}

/**
 * Generate correlation factors for one simulation run.
 *
 * NBA-specific: Correlation is meaningful because:
 * - Game environment drives shared variance (pace, OT, blowouts)
 * - Team-level correlation captures game script and execution runs
 * - Individual variance still dominates, but correlation adds realistic covariance
 *
 * Game factors: Normal distribution with std=0.15, mean=1.0
 *   - 68% of games between 0.85-1.15
 *   - Captures pace/OT effects and scoring environment
 *
 * Team factors: Normal distribution with std=0.10, mean=1.0
 *   - Meaningful team-level correlation for hot/cold streaks
 */
export function generateCorrelationFactors(
  allPlayers: Player[],
  stratifiedPaceZScores?: Map<string, number>,  // Optional pre-stratified Z-scores for game pace
  sport?: string  // Sport type for reliable MMA bout detection
): CorrelationFactors {
  // Extract unique games and teams
  const games = new Map<string, Set<string>>(); // gameId -> set of teams
  const teams = new Set<string>();

  for (const player of allPlayers) {
    const gameId = player.gameInfo || `${player.team}_game`;
    if (!games.has(gameId)) games.set(gameId, new Set());
    games.get(gameId)!.add(player.team);
    teams.add(player.team);
  }

  // Pace factors: symmetric, shared by both teams
  // Variance scales with game total (Vegas over/under):
  //   225 total → std=0.12 (baseline)
  //   240 total → std=0.128 (high-scoring games have MORE variance, more boom)
  //   210 total → std=0.112 (low-scoring games are more predictable)
  const gamePaceFactors = new Map<string, number>();
  for (const [gameId, gameTeams] of games) {
    // Find gameTotal for this game from any player in it
    let gameTotal = 225; // default
    for (const player of allPlayers) {
      const pGameId = player.gameInfo || `${player.team}_game`;
      if (pGameId === gameId && player.gameTotal && player.gameTotal > 0) {
        gameTotal = player.gameTotal;
        break;
      }
    }

    // Use lognormal so E[factor] = 1.0 exactly (avoids clamping bias)
    // Increased from 0.10 to 0.14 for more realistic intra-game correlation (~0.30-0.40).
    // Empirical NBA DFS correlation between same-game players is 0.35-0.50.
    // Higher pace volatility properly rewards game stacks in simulation.
    const paceStd = 0.14 * (gameTotal / 225);
    const z = stratifiedPaceZScores?.get(gameId) ?? boxMullerZ();
    gamePaceFactors.set(gameId, Math.exp(z * paceStd - paceStd * paceStd / 2));
  }

  // Script factors: anti-symmetric
  // Positive = favors teamA, Negative = favors teamB
  // Captures game flow, blowouts, garbage time
  // MMA bouts: much higher script std (0.30) because one fighter wins, other loses
  const gameScriptFactors = new Map<string, number>();
  const gameTeamSides = new Map<string, { teamA: string; teamB: string }>();
  for (const [gameId, gameTeams] of games) {
    const z = boxMullerZ();
    const teamArr = [...gameTeams];
    // Detect MMA bout: use explicit sport parameter when available, fall back to name heuristic
    const isMMABout = gameTeams.size === 2 && (
      sport === 'mma' || (!sport && teamArr.every(t => t.includes(' ')))
    );
    const scriptStd = isMMABout ? 0.30 : 0.08; // MMA: very strong anti-correlation
    gameScriptFactors.set(gameId, z * scriptStd);
    gameTeamSides.set(gameId, {
      teamA: teamArr[0] || '',
      teamB: teamArr[1] || teamArr[0] || ''
    });
  }

  // Team factors: independent execution (std=0.10, reduced from 0.14)
  // Usage shifts now handle within-team variance, so shared team factor is smaller
  // (it models shared defense/pace, not individual performance)
  // Use lognormal so E[factor] = 1.0 exactly (avoids clamping bias)
  const TEAM_STD = 0.10;
  const teamFactors = new Map<string, number>();
  for (const team of teams) {
    const z = boxMullerZ();
    teamFactors.set(team, Math.exp(z * TEAM_STD - TEAM_STD * TEAM_STD / 2));
  }

  // Usage redistribution: within each team, randomly shift usage share
  // Models the "one ball" constraint in NBA — if one player dominates usage,
  // teammates get fewer touches. Zero-sum across the team.
  const teamUsageShifts = new Map<string, Map<string, number>>();

  for (const [gameId, gameTeams] of games) {
    for (const teamName of gameTeams) {
      const teamPlayers = allPlayers.filter(p => p.team === teamName);
      if (teamPlayers.length < 2) continue;

      const shifts = new Map<string, number>();

      // Weight by salary^2 (proxy for usage rate) — stars dominate usage more aggressively
      // When Jokic has 40% usage, Murray's touches drop significantly
      const salaryWeights = teamPlayers.map(p => Math.pow(p.salary / 6000, 2.0));
      const totalWeight = salaryWeights.reduce((s, w) => s + w, 0);

      // Generate a zero-sum usage shift (mean = 0 across team)
      // σ=0.18 (up from 0.12): stronger anti-correlation between teammates.
      // In real NBA, when one player has a 40-pt game, their teammates often underperform
      // because possessions are finite (~100/game). This makes stacking teammates riskier.
      const rawShifts = teamPlayers.map(() => boxMullerZ() * 0.18);
      const meanShift = rawShifts.reduce((s, v) => s + v, 0) / rawShifts.length;

      // Zero-center and salary-weight the shifts
      // High-salary players get larger absolute shifts (they CAN dominate usage)
      for (let i = 0; i < teamPlayers.length; i++) {
        const salaryLoading = salaryWeights[i] / totalWeight * teamPlayers.length;
        const centeredShift = (rawShifts[i] - meanShift) * salaryLoading;
        shifts.set(teamPlayers[i].id, centeredShift);
      }

      teamUsageShifts.set(teamName, shifts);
    }
  }

  return { gamePaceFactors, gameScriptFactors, gameTeamSides, teamFactors, teamUsageShifts };
}

/**
 * Generate correlation factors for single-event sports (golf, NASCAR, MMA).
 *
 * In individual sports, there's no game/team structure, but shared environmental
 * variance still exists:
 * - Course conditions (wind, pin positions, weather) affect ALL players
 * - Individual variance beyond course conditions is player-specific
 *
 * Reuses CorrelationFactors structure for compatibility with samplePlayerOutcome():
 * - gamePaceFactor = course condition factor (lognormal std=0.10)
 * - gameScriptFactor = 0 (no asymmetric game script)
 * - teamFactor = per-player noise factor (lognormal std=0.06)
 */
export function generateCourseConditionFactors(
  allPlayers: Player[]
): CorrelationFactors {
  // Single "game" for all players — course condition
  const COURSE_STD = 0.10;
  const courseZ = boxMullerZ();
  const courseFactor = Math.exp(courseZ * COURSE_STD - COURSE_STD * COURSE_STD / 2);

  const gamePaceFactors = new Map<string, number>();
  const gameScriptFactors = new Map<string, number>();
  const gameTeamSides = new Map<string, { teamA: string; teamB: string }>();
  const teamFactors = new Map<string, number>();

  // All players share one "game" with the course condition factor
  const gameIds = new Set<string>();
  for (const player of allPlayers) {
    const gameId = player.gameInfo || `${player.team}_game`;
    if (!gameIds.has(gameId)) {
      gamePaceFactors.set(gameId, courseFactor);
      gameScriptFactors.set(gameId, 0); // No game script for individual sports
      gameTeamSides.set(gameId, { teamA: player.team, teamB: player.team });
      gameIds.add(gameId);
    }
  }

  // Per-player noise factor (each player is their own "team")
  const PLAYER_NOISE_STD = 0.06;
  const seenTeams = new Set<string>();
  for (const player of allPlayers) {
    if (!seenTeams.has(player.team)) {
      const z = boxMullerZ();
      teamFactors.set(player.team, Math.exp(z * PLAYER_NOISE_STD - PLAYER_NOISE_STD * PLAYER_NOISE_STD / 2));
      seenTeams.add(player.team);
    }
  }

  return { gamePaceFactors, gameScriptFactors, gameTeamSides, teamFactors };
}

/**
 * Box-Muller transform to generate a standard normal random variable.
 */
function boxMullerZ(): number {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Generate n stratified standard normal values.
 *
 * Divides [0,1] into n equal strata, draws one uniform sample per stratum,
 * then applies the inverse CDF (probit) to get stratified normals.
 * This guarantees coverage of both tails and halves variance for symmetric
 * statistics compared to pure random sampling — at zero compute cost.
 *
 * Uses rational approximation of the probit function (Abramowitz & Stegun).
 */
function stratifiedNormals(n: number): Float32Array {
  const result = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // Draw uniform from stratum i: U ~ [(i + rand()) / n]
    const u = (i + Math.random()) / n;
    result[i] = probitApprox(u);
  }
  // Shuffle to break ordering (Fisher-Yates)
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = result[i];
    result[i] = result[j];
    result[j] = tmp;
  }
  return result;
}

/**
 * Standard normal CDF approximation.
 * Uses rational approximation (Abramowitz & Stegun 26.2.17).
 * Accurate to ~7.5e-8 absolute error.
 */
function normalCDF(x: number): number {
  if (x >= 8) return 1;
  if (x <= -8) return 0;
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x);
  const t = 1 / (1 + 0.2316419 * z);
  const t2 = t * t;
  const t3 = t2 * t;
  const t4 = t3 * t;
  const t5 = t4 * t;
  const poly = 0.319381530 * t - 0.356563782 * t2 + 1.781477937 * t3
    - 1.821255978 * t4 + 1.330274429 * t5;
  const pdf = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  const cdf = 1 - pdf * poly;
  return sign < 0 ? 1 - cdf : cdf;
}

/**
 * Rational approximation of the probit function (inverse normal CDF).
 * Accurate to ~4.5e-4 absolute error across [0.0001, 0.9999].
 * Abramowitz & Stegun formula 26.2.23.
 */
function probitApprox(p: number): number {
  // Clamp to avoid log(0) or log(1)
  const pp = Math.max(1e-6, Math.min(1 - 1e-6, p));
  const sign = pp < 0.5 ? -1 : 1;
  const q = pp < 0.5 ? pp : 1 - pp;
  const t = Math.sqrt(-2 * Math.log(q));
  // Coefficients from A&S 26.2.23
  const c0 = 2.515517;
  const c1 = 0.802853;
  const c2 = 0.010328;
  const d1 = 1.432788;
  const d2 = 0.189269;
  const d3 = 0.001308;
  const z = t - (c0 + c1 * t + c2 * t * t) / (1 + d1 * t + d2 * t * t + d3 * t * t * t);
  return sign * z;
}

/**
 * Sample a player's outcome using their empirical distribution.
 *
 * When SaberSim percentile data is available (p25/p50/p75/p85/p95/p99),
 * uses piecewise-linear inverse CDF sampling — the most accurate method
 * since it uses the player's ACTUAL distribution shape rather than
 * assuming normal + skew. Each player has a unique boom/bust profile.
 *
 * Falls back to Box-Muller with skew when percentile data is missing.
 *
 * @param correlationFactors - Optional game/team correlation factors.
 *   When provided, the sampled outcome is scaled by:
 *   finalOutcome = baseOutcome * gameFactor * teamFactor
 *   This creates realistic correlation between teammates and same-game players.
 */
export function samplePlayerOutcome(
  player: Player,
  correlationFactors?: CorrelationFactors
): number {
  const projection = player.projection;
  if (projection <= 0) return 0;

  // DNP modeling: NBA players have ~5-15% chance of DNP-CD or <5 min (scoring 0-2 pts).
  // Current percentile sampling never generates true 0 because piecewise CDF floor is positive.
  // This creates systematic overestimation for DNP-risk players.
  const pcts = player.percentiles;
  if (pcts && pcts.p50 > 0) {
    if (pcts.p25 <= 0) {
      // High DNP risk: p25 is zero or negative
      if (Math.random() < 0.15) return 0;
    } else if (pcts.p25 / pcts.p50 < 0.15) {
      // Moderate DNP risk: p25 is very low relative to median
      if (Math.random() < 0.08) return 0;
    }
  }

  // Sample base outcome from player's distribution
  let baseOutcome: number;
  if (pcts && pcts.p50 > 0) {
    baseOutcome = sampleFromPercentiles(pcts);
  } else {
    baseOutcome = sampleFallback(player);
  }

  // Apply correlation factors if provided
  if (correlationFactors) {
    const gameId = player.gameInfo || `${player.team}_game`;
    const paceFactor = correlationFactors.gamePaceFactors.get(gameId) || 1.0;
    const scriptFactor = correlationFactors.gameScriptFactors.get(gameId) || 0.0;
    const sides = correlationFactors.gameTeamSides.get(gameId);
    const teamFactor = correlationFactors.teamFactors.get(player.team) || 1.0;

    // Script sign: +1 for teamA, -1 for teamB, 0 if sides unknown
    // When one team dominates, their players benefit while opponents suffer
    const scriptSign = sides ? (player.team === sides.teamA ? 1 : -1) : 0;
    const gameFactor = paceFactor + scriptSign * scriptFactor;

    // Multiplicative combination for meaningful correlation swings
    // Same-team: both get same script sign → positive correlation (~0.4)
    // Cross-team: opposite script signs → weakly positive correlation (~0.10)
    const combinedFactor = gameFactor * teamFactor;

    // Position/usage-aware correlation loading:
    // Stars (high salary) CREATE the game pace — higher correlation loading.
    // Bench players ride the wave with lower loading.
    // Continuous scale instead of binary threshold (works across all sports)
    const salaryRatio = player.salary / 8000;
    const gameLoading = 0.85 + 0.30 * Math.min(1, Math.max(0, (salaryRatio - 0.75) / 0.50));
    // $6K → 0.85, $8K → 1.00, $10K → 1.15

    // Minutes-adjusted: more minutes = tighter coupling to team outcome
    const minutesFactor = player.minutes
      ? Math.min(1.2, Math.max(0.7, player.minutes / 30))
      : 1.0;

    // Player-specific variance scaling: high-CV players amplify game swings more
    let playerVolatility = 1.0;
    if (player.percentiles && player.percentiles.p75 > 0 && player.percentiles.p25 > 0) {
      const iqr = player.percentiles.p75 - player.percentiles.p25;
      const sd = iqr / 1.35;
      const cv = sd / Math.max(1, projection);
      playerVolatility = Math.min(1.5, Math.max(0.5, cv / 0.30));
    }

    // Split game/team effect into ADDITIVE (creates correlation) + MULTIPLICATIVE (creates volatility)
    const deviation = baseOutcome - projection;
    const effectiveLoading = gameLoading * minutesFactor;

    // ADDITIVE: shared directional shift — creates actual correlation between same-game players
    // When game is high-pace (combinedFactor > 1), ALL players score higher
    // Proportional to projection so stars shift more than min-priced
    const sharedShift = (combinedFactor - 1.0) * projection * effectiveLoading * 0.7;

    // MULTIPLICATIVE: variance scaling — creates conditional boom/bust
    // High-pace games also have more extreme individual outcomes
    const varianceScale = 1.0 + (combinedFactor - 1.0) * effectiveLoading * 0.3;

    baseOutcome = (projection + sharedShift) + deviation * varianceScale * playerVolatility;

    // Usage-share anti-correlation: within-team zero-sum shift
    // When a teammate dominates usage, this player's outcome is adjusted
    // Models the "one ball" constraint — positive shift = more touches, negative = fewer
    if (correlationFactors.teamUsageShifts) {
      const teamShifts = correlationFactors.teamUsageShifts.get(player.team);
      if (teamShifts) {
        const usageShift = teamShifts.get(player.id) || 0;
        // Scale by projection (stars shift more in absolute terms)
        baseOutcome += usageShift * projection;
      }
    }
  }

  return Math.max(0, baseOutcome);
}

/**
 * Inverse CDF sampling from 6-point empirical distribution.
 *
 * Builds a piecewise-linear CDF from SaberSim's percentile data and
 * samples by drawing U ~ Uniform(0,1) and interpolating.
 *
 * CDF points:
 *   quantile: [0.00,  0.25, 0.50, 0.75, 0.85, 0.95, 0.99, 1.00 ]
 *   value:    [floor, p25,  p50,  p75,  p85,  p95,  p99,  tailExt]
 *
 * Floor: extrapolate below p25 using IQR (capped at 0)
 * Tail:  extrapolate above p99 using p95→p99 slope
 */
function sampleFromPercentiles(pcts: PlayerPercentiles): number {
  // Extrapolate tails from the data
  const iqr = pcts.p75 - pcts.p25;
  const floor = Math.max(0, pcts.p25 - iqr);                 // ~0th percentile
  const tailExtent = pcts.p99 + (pcts.p99 - pcts.p95);       // ~100th percentile

  // Fritsch-Carlson monotone cubic Hermite interpolation
  // Same 8 knot points as before, but smooth curvature eliminates artificial
  // probability mass at knot points in the p85-p99 boom zone.
  const Q = [0.00,  0.25,     0.50,     0.75,     0.85,     0.95,     0.99,     1.00];
  const V = [floor, pcts.p25, pcts.p50, pcts.p75, pcts.p85, pcts.p95, pcts.p99, tailExtent];
  const n = Q.length;

  // Step 1: Compute slopes between consecutive knot points
  const delta = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    const dq = Q[i + 1] - Q[i];
    delta[i] = dq > 0 ? (V[i + 1] - V[i]) / dq : 0;
  }

  // Step 2: Compute tangents at each knot using harmonic mean of adjacent deltas
  const m = new Array(n);
  m[0] = delta[0];
  m[n - 1] = delta[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (delta[i - 1] * delta[i] <= 0) {
      m[i] = 0; // Different signs or zero — flat tangent for monotonicity
    } else {
      // Harmonic mean of adjacent deltas
      m[i] = 2 * delta[i - 1] * delta[i] / (delta[i - 1] + delta[i]);
    }
  }

  // Step 3: Fritsch-Carlson monotonicity enforcement
  for (let i = 0; i < n - 1; i++) {
    if (delta[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
    } else {
      const alpha = m[i] / delta[i];
      const beta = m[i + 1] / delta[i];
      // Check if (alpha, beta) lies outside the monotonicity region
      const tau = alpha * alpha + beta * beta;
      if (tau > 9) {
        const s = 3 / Math.sqrt(tau);
        m[i] = s * alpha * delta[i];
        m[i + 1] = s * beta * delta[i];
      }
    }
  }

  // Step 4: Evaluate using Hermite basis functions
  const u = Math.random();

  for (let i = 0; i < n - 1; i++) {
    if (u <= Q[i + 1] || i === n - 2) {
      const h = Q[i + 1] - Q[i];
      if (h <= 0) return V[i];
      const t = (u - Q[i]) / h;
      const t2 = t * t;
      const t3 = t2 * t;

      // Hermite basis: h00, h10, h01, h11
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;

      return h00 * V[i] + h10 * h * m[i] + h01 * V[i + 1] + h11 * h * m[i + 1];
    }
  }

  return tailExtent;
}

/**
 * Pre-tabulate a CDF lookup table from percentile data.
 * Evaluates the full Fritsch-Carlson monotone cubic Hermite spline at 256 evenly-spaced
 * quantile points and stores the results in a Float32Array for O(1) sampling.
 * ~10× faster than re-evaluating the spline per sample.
 */
function buildCDFLookupTable(pcts: PlayerPercentiles): Float32Array {
  const TABLE_SIZE = 256;
  const table = new Float32Array(TABLE_SIZE);

  const iqr = pcts.p75 - pcts.p25;
  const floor = Math.max(0, pcts.p25 - iqr);
  const tailExtent = pcts.p99 + (pcts.p99 - pcts.p95);

  const Q = [0.00,  0.25,     0.50,     0.75,     0.85,     0.95,     0.99,     1.00];
  const V = [floor, pcts.p25, pcts.p50, pcts.p75, pcts.p85, pcts.p95, pcts.p99, tailExtent];
  const n = Q.length;

  const delta = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    const dq = Q[i + 1] - Q[i];
    delta[i] = dq > 0 ? (V[i + 1] - V[i]) / dq : 0;
  }

  const m = new Array(n);
  m[0] = delta[0];
  m[n - 1] = delta[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (delta[i - 1] * delta[i] <= 0) {
      m[i] = 0;
    } else {
      m[i] = 2 * delta[i - 1] * delta[i] / (delta[i - 1] + delta[i]);
    }
  }

  for (let i = 0; i < n - 1; i++) {
    if (delta[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
    } else {
      const alpha = m[i] / delta[i];
      const beta = m[i + 1] / delta[i];
      const tau = alpha * alpha + beta * beta;
      if (tau > 9) {
        const s = 3 / Math.sqrt(tau);
        m[i] = s * alpha * delta[i];
        m[i + 1] = s * beta * delta[i];
      }
    }
  }

  // Evaluate spline at TABLE_SIZE evenly-spaced quantile points
  for (let ti = 0; ti < TABLE_SIZE; ti++) {
    const u = ti / (TABLE_SIZE - 1);  // 0.0 to 1.0 inclusive
    let val = tailExtent;
    for (let i = 0; i < n - 1; i++) {
      if (u <= Q[i + 1] || i === n - 2) {
        const h = Q[i + 1] - Q[i];
        if (h <= 0) { val = V[i]; break; }
        const t = (u - Q[i]) / h;
        const t2 = t * t;
        const t3 = t2 * t;
        const h00 = 2 * t3 - 3 * t2 + 1;
        const h10 = t3 - 2 * t2 + t;
        const h01 = -2 * t3 + 3 * t2;
        const h11 = t3 - t2;
        val = h00 * V[i] + h10 * h * m[i] + h01 * V[i + 1] + h11 * h * m[i + 1];
        break;
      }
    }
    table[ti] = val;
  }

  return table;
}

/**
 * Sample from a pre-built CDF lookup table using linear interpolation.
 * ~5 FP ops vs ~50 for full spline evaluation.
 * @param u - Uniform random draw in [0, 1). Pass 1-u for antithetic variate.
 */
function sampleFromLookupTable(table: Float32Array, u: number): number {
  const idx = u * 255;    // TABLE_SIZE - 1
  const lo = idx | 0;     // floor via bitwise OR
  const hi = Math.min(lo + 1, 255);
  const frac = idx - lo;
  return table[lo] + (table[hi] - table[lo]) * frac;
}

/**
 * Fallback: Box-Muller normal with positive skew.
 * Used when percentile data is not available (e.g., backtester historical data).
 */
function sampleFallback(player: Player): number {
  const projection = player.projection;
  const ceiling = (player.ceiling && player.ceiling > 0)
    ? player.ceiling
    : projection * 1.15;

  // Use SaberSim stdDev if available (more accurate than ceiling-derived)
  // Fall back to deriving from ceiling (85th percentile, z ≈ 1.04)
  const baseStd = player.stdDev && player.stdDev > 0
    ? player.stdDev
    : Math.max(1, (ceiling - projection) / 1.04);

  // Box-Muller transform
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);

  // Slight positive skew (NBA scoring is right-skewed)
  const skewedZ = z >= 0 ? z * 1.15 : z * 0.9;

  return Math.max(0, projection + skewedZ * baseStd);
}

/**
 * Top-heavy simulation score: 40% P(1st), 30% P(top 1%), 20% expected ROI, 10% P(top 5%).
 * GPP payouts are extremely top-heavy (1st pays 100x min-cash), so we explicitly
 * target first-place finishes rather than expected ROI which washes out the tail.
 */
function calculateTopHeavySimScore(
  pFirst: number,
  pTop1Pct: number,
  pTop5Pct: number,
  expectedROI: number
): number {
  const pFirstScore = Math.pow(Math.min(1, pFirst * 5000), 0.5);   // continuous differentiation via sqrt
  const pTop1Score = Math.pow(Math.min(1, pTop1Pct * 50), 0.5);
  const pTop5Score = Math.pow(Math.min(1, pTop5Pct * 10), 0.5);
  const roiScore = Math.min(1, Math.max(0, (expectedROI + 50) / 250));

  return pFirstScore * 0.45 + pTop1Score * 0.30 + roiScore * 0.15 + pTop5Score * 0.10;
}

/**
 * Score a lineup with simulated player outcomes
 */
function scoreLineupSimulation(
  lineup: Lineup,
  playerOutcomes: Map<string, number>
): number {
  let total = 0;
  for (const player of lineup.players) {
    total += playerOutcomes.get(player.id) || player.projection;
  }
  return total;
}

/**
 * Score a field lineup (player IDs) with simulated outcomes
 */
function scoreFieldLineup(
  playerIds: string[],
  playerOutcomes: Map<string, number>,
  playerMap: Map<string, Player>
): number {
  let total = 0;
  for (const id of playerIds) {
    total += playerOutcomes.get(id) || playerMap.get(id)?.projection || 0;
  }
  return total;
}

/**
 * Score a field lineup using pre-indexed player outcomes (Float64Array).
 * ~3× faster than Map-based version due to direct array indexing.
 */
function scoreFieldLineupIndexed(
  playerIndices: Int32Array,
  outcomes: Float64Array,
  fallbacks: Float64Array
): number {
  let total = 0;
  for (let i = 0; i < playerIndices.length; i++) {
    const idx = playerIndices[i];
    total += idx >= 0 ? outcomes[idx] : fallbacks[i];
  }
  return total;
}

/**
 * Score a candidate lineup using pre-indexed player outcomes (Float64Array).
 */
function scoreLineupSimulationIndexed(
  playerIndices: Int32Array,
  outcomes: Float64Array,
  fallbacks: Float64Array
): number {
  let total = 0;
  for (let i = 0; i < playerIndices.length; i++) {
    const idx = playerIndices[i];
    total += idx >= 0 ? outcomes[idx] : fallbacks[i];
  }
  return total;
}

// ============================================================
// FIELD GENERATION
// ============================================================

/**
 * Archetype ratio configuration for field generation.
 * When calibration is poor, use recommended ratios from validateFieldCalibration().
 */
export interface ArchetypeRatios {
  chalk: number;      // 0.0-1.0, default 0.70
  balanced: number;   // 0.0-1.0, default 0.20
  contrarian: number; // 0.0-1.0, default 0.10
}

// Track previous sharp optimizer lineups for combo rejection
// Cleared at the start of each field generation batch
let previousSharpLineups: string[][] = [];

/**
 * Check if a 3-player combo appears in >5% of previous sharp lineups.
 * Returns the index of the weakest member to swap out, or -1 if no rejection needed.
 */
function checkSharpComboRejection(
  playerIds: string[],
  previousLineups: string[][],
  threshold: number = 0.05
): number {
  if (previousLineups.length < 20) return -1; // Not enough data to detect repeats

  const n = playerIds.length;
  let worstComboFreq = 0;
  let worstComboWeakestIdx = -1;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (let k = j + 1; k < n; k++) {
        const combo = new Set([playerIds[i], playerIds[j], playerIds[k]]);
        let comboCount = 0;
        for (const prevLineup of previousLineups) {
          let matches = 0;
          for (const pid of prevLineup) {
            if (combo.has(pid)) matches++;
          }
          if (matches >= 3) comboCount++;
        }
        const freq = comboCount / previousLineups.length;
        if (freq > threshold && freq > worstComboFreq) {
          worstComboFreq = freq;
          // Weakest member = lowest effective value (approximate by index — last player picked)
          worstComboWeakestIdx = k;
        }
      }
    }
  }

  return worstComboWeakestIdx;
}

/**
 * Generate a pool of synthetic field lineups based on ownership
 * Models what the competition is likely building
 *
 * Uses GREEDY OPTIMIZATION to model real field lineups.
 * Real DFS players use optimizers, not random sampling.
 *
 * Field composition (realistic GPP field):
 * - 70% chalk (greedy by projection * ownership_boost) - most players are chalk
 * - 20% balanced (greedy by projection) - some pure projection optimizers
 * - 10% contrarian (greedy by projection with ownership discount) - few contrarians
 *
 * @param ratios - Optional archetype ratios. Use validateFieldCalibration() recommendations
 *                 when calibration is poor to improve field accuracy.
 */
export function generateFieldPool(
  players: Player[],
  rosterSize: number,
  count: number,
  seed?: number,
  ratios?: ArchetypeRatios,
  expandedConfig?: ExpandedFieldConfig,
  ownershipScenarios?: Array<{ playerOwnerships: Map<string, number> }>,
  optimizerProxies?: FieldLineup[],
  salaryCap: number = 50000
): FieldLineup[] {
  const rng = seed !== undefined ? createSeededRandom(seed) : Math.random;
  const fieldLineups: FieldLineup[] = [];

  // Clear sharp lineup tracking for combo rejection
  previousSharpLineups = [];

  // Helper: check if a lineup overlaps too much with recent lineups
  const isTooSimilar = (lineup: FieldLineup, recentLineups: FieldLineup[]): boolean => {
    const overlapThreshold = Math.max(rosterSize - 1, Math.floor(rosterSize * 0.875));
    const playerSet = new Set(lineup.playerIds);
    const checkCount = Math.min(recentLineups.length, 10);
    for (let i = recentLineups.length - checkCount; i < recentLineups.length; i++) {
      let overlap = 0;
      for (const pid of recentLineups[i].playerIds) {
        if (playerSet.has(pid)) overlap++;
      }
      if (overlap >= overlapThreshold) return true;
    }
    return false;
  };

  // Helper: generate with dedup retries (expanded archetype support)
  const generateWithDedupExpanded = (
    archetype: FieldArchetype,
    iteration: number,
    recentLineups: FieldLineup[],
    playersToUse: Player[] = players,
    selectionBoosts?: Map<string, number>
  ): FieldLineup | null => {
    const maxRetries = 3;
    for (let retry = 0; retry <= maxRetries; retry++) {
      const lineup = generateExpandedFieldLineup(playersToUse, rosterSize, archetype, iteration + retry * 10000, rng, selectionBoosts, salaryCap);
      if (!lineup) return null;
      if (!isTooSimilar(lineup, recentLineups)) return lineup;
    }
    return generateExpandedFieldLineup(playersToUse, rosterSize, archetype, iteration + 99999, rng, selectionBoosts, salaryCap);
  };

  // Use expanded 9-archetype config if provided, otherwise fall back to defaults
  const expanded = expandedConfig || DEFAULT_EXPANDED_FIELD_CONFIG;

  // Build archetype schedule: array of [archetype, count] pairs
  // When optimizer proxies are provided, reduce generated sharpOptimizer count
  const proxyCount = optimizerProxies?.length || 0;
  const sharpGenCount = Math.max(0, Math.floor(count * expanded.sharpOptimizer) - proxyCount);

  const archetypeSchedule: Array<[FieldArchetype, number]> = [
    ['chalk', Math.floor(count * expanded.pureChalk)],
    ['semiChalk', Math.floor(count * expanded.semiChalk)],
    ['stackChalk', Math.floor(count * expanded.stackChalk)],
    ['balanced', Math.floor(count * expanded.projectionOptimizer)],
    ['leverageOptimizer', Math.floor(count * expanded.leverageOptimizer)],
    ['ceilingOptimizer', Math.floor(count * expanded.ceilingOptimizer)],
    ['casual', Math.floor(count * expanded.casual)],
    ['contrarian', Math.floor(count * expanded.contrarian)],
    ['sharpOptimizer', sharpGenCount],
    ['stackBuilder', Math.floor(count * expanded.stackBuilder)],
  ];

  // Assign remaining to chalk to ensure we hit count exactly
  const scheduled = archetypeSchedule.reduce((s, [, c]) => s + c, 0);
  archetypeSchedule[0][1] += count - scheduled;

  // === ITERATIVE PRE-CALIBRATION: measure positional dilution and compute boost factors ===
  // Position constraints cause structural under-exposure for players with limited slot eligibility
  // (e.g., a C-only player competes for fewer slots than a PG/SF/F/G/UTIL player).
  // Run multiple pilot rounds with chalk lineups, adjusting boost factors each round until
  // measured exposure converges to projected ownership within ~5%.
  const PILOT_SIZE = 400;
  const PILOT_ROUNDS = 8;
  const boostFactors = new Map<string, number>();

  if (rosterSize === 8) { // Position dilution only matters for position-aware generation
    // Initialize all boost factors to 1.0
    for (const player of players) {
      boostFactors.set(player.id, 1.0);
    }

    for (let round = 0; round < PILOT_ROUNDS; round++) {
      // Create pilot boost map from current boost factors (only factors > 1.01)
      const pilotBoosts = new Map<string, number>();
      for (const [id, boost] of boostFactors.entries()) {
        if (boost > 1.01) pilotBoosts.set(id, boost);
      }

      // Generate pilot lineups using a REPRESENTATIVE MIX of archetypes to capture
      // all sources of dilution (positional + effectiveValue penalties).
      // Approximate field composition: 30% chalk, 45% balanced-type, 15% contrarian, 10% casual
      // Contrarian doesn't get boost, so pilot must measure the combined effect.
      const pilotArchetypes: FieldArchetype[] = [];
      for (let j = 0; j < Math.floor(PILOT_SIZE * 0.30); j++) pilotArchetypes.push('chalk');
      for (let j = 0; j < Math.floor(PILOT_SIZE * 0.15); j++) pilotArchetypes.push('balanced');
      for (let j = 0; j < Math.floor(PILOT_SIZE * 0.12); j++) pilotArchetypes.push('sharpOptimizer');
      for (let j = 0; j < Math.floor(PILOT_SIZE * 0.10); j++) pilotArchetypes.push('leverageOptimizer');
      for (let j = 0; j < Math.floor(PILOT_SIZE * 0.08); j++) pilotArchetypes.push('ceilingOptimizer');
      for (let j = 0; j < Math.floor(PILOT_SIZE * 0.10); j++) pilotArchetypes.push('contrarian');
      for (let j = 0; j < Math.floor(PILOT_SIZE * 0.08); j++) pilotArchetypes.push('casual');
      for (let j = 0; j < Math.floor(PILOT_SIZE * 0.07); j++) pilotArchetypes.push('stackBuilder');
      // Fill remainder with chalk
      while (pilotArchetypes.length < PILOT_SIZE) pilotArchetypes.push('chalk');

      const pilotLineups: FieldLineup[] = [];
      const activePilotBoosts = pilotBoosts.size > 0 ? pilotBoosts : undefined;
      for (let i = 0; i < PILOT_SIZE; i++) {
        const arch = pilotArchetypes[i];
        // Only apply boost to non-contrarian archetypes (contrarian deliberately deviates)
        const archBoosts = arch === 'contrarian' ? undefined : activePilotBoosts;
        const lineup = generateExpandedFieldLineup(
          players, rosterSize, arch, round * PILOT_SIZE + i, rng, archBoosts, salaryCap
        );
        if (lineup) pilotLineups.push(lineup);
      }

      if (pilotLineups.length < 100) break;

      // Measure per-player exposure in pilot
      const pilotCounts = new Map<string, number>();
      for (const lineup of pilotLineups) {
        for (const pid of lineup.playerIds) {
          pilotCounts.set(pid, (pilotCounts.get(pid) || 0) + 1);
        }
      }

      // Update boost factors: multiply current boost by (target / measured)
      let maxGap = 0;
      for (const player of players) {
        if (player.ownership < 3) continue; // Skip very low ownership — noisy
        const pilotExposure = ((pilotCounts.get(player.id) || 0) / pilotLineups.length) * 100;
        if (pilotExposure < 0.5) continue; // Can't compute meaningful boost from near-zero

        const currentBoost = boostFactors.get(player.id) || 1.0;
        const ratio = player.ownership / pilotExposure;
        // Dampen adjustment to avoid oscillation: move 85% toward target
        const dampedRatio = 1.0 + (ratio - 1.0) * 0.85;
        const newBoost = currentBoost * dampedRatio;
        const clamped = Math.max(0.3, Math.min(8.0, newBoost));
        boostFactors.set(player.id, clamped);

        const gap = Math.abs(pilotExposure - player.ownership);
        if (player.ownership >= 5) maxGap = Math.max(maxGap, gap);
      }

      // If all significant players are within 3% of target, stop early
      if (round > 0 && maxGap < 3) break;
    }

    // Clean up: remove boost factors close to 1.0 (no meaningful dilution)
    for (const [id, boost] of boostFactors.entries()) {
      if (boost >= 0.95 && boost <= 1.05) boostFactors.delete(id);
    }

    // Log results
    if (boostFactors.size > 0) {
      const dilutedPlayers: Array<{ name: string; own: number; boost: number }> = [];
      for (const player of players) {
        const boost = boostFactors.get(player.id);
        if (boost && boost > 1.05) {
          dilutedPlayers.push({ name: player.name, own: player.ownership, boost });
        }
      }
      // Sort by boost descending
      dilutedPlayers.sort((a, b) => b.boost - a.boost);
      console.log(`    Pre-calibration (${PILOT_ROUNDS} rounds): ${dilutedPlayers.length} players need positional dilution boost`);
      for (const { name, own, boost } of dilutedPlayers.slice(0, 5)) {
        console.log(`      ${name}: ${own.toFixed(1)}% target, boost ${boost.toFixed(2)}x (effective weight: ${(own * boost).toFixed(1)})`);
      }
    }
  }

  // Boost factors only applied to non-contrarian archetypes via selectionBoosts parameter.
  // Contrarian archetypes deliberately deviate from ownership — no boost needed.
  const nonContrarianBoosts = boostFactors.size > 0 ? boostFactors : undefined;

  // If ownership scenarios provided, distribute field generation across them
  if (ownershipScenarios && ownershipScenarios.length > 0) {
    const numScenarios = ownershipScenarios.length;

    for (const [archetype, archetypeCount] of archetypeSchedule) {
      const isContrarian = archetype === 'contrarian';
      const boosts = isContrarian ? undefined : nonContrarianBoosts;
      const lineupsPerScenario = Math.floor(archetypeCount / numScenarios);
      let generated = 0;

      for (let si = 0; si < numScenarios; si++) {
        const scenario = ownershipScenarios[si];
        // Create temporary players with scenario ownerships (boost applied in selection weight, not here)
        const scenarioPlayers = players.map(p => ({
          ...p,
          ownership: scenario.playerOwnerships.get(p.id) ?? p.ownership,
        }));

        const scenarioCount = si < numScenarios - 1
          ? lineupsPerScenario
          : archetypeCount - generated; // Last scenario gets remainder

        for (let i = 0; i < scenarioCount; i++) {
          const lineup = generateWithDedupExpanded(
            archetype, si * 10000 + i, fieldLineups, scenarioPlayers, boosts
          );
          if (lineup) {
            fieldLineups.push(lineup);
            if (archetype === 'sharpOptimizer') previousSharpLineups.push(lineup.playerIds);
          }
          generated++;
        }
      }
    }
  } else {
    // Original path: generate all lineups with base ownership
    for (const [archetype, archetypeCount] of archetypeSchedule) {
      const isContrarian = archetype === 'contrarian';
      const boosts = isContrarian ? undefined : nonContrarianBoosts;
      for (let i = 0; i < archetypeCount; i++) {
        const lineup = generateWithDedupExpanded(
          archetype, i, fieldLineups, players, boosts
        );
        if (lineup) {
          fieldLineups.push(lineup);
          if (archetype === 'sharpOptimizer') previousSharpLineups.push(lineup.playerIds);
        }
      }
    }
  }

  // Append optimizer proxy lineups (replace formula-based sharpOptimizer)
  if (optimizerProxies && optimizerProxies.length > 0) {
    fieldLineups.push(...optimizerProxies);
  }

  // === POST-GENERATION CALIBRATION ===
  // Phase 1: Fix over-exposed players (regenerate lineups with adjusted weights)
  // Phase 2: Fix under-exposed players via targeted injection (swap into existing lineups)
  const MAX_CALIBRATION_PASSES = 3;

  // Build player lookup for injection
  const playerById = new Map<string, Player>();
  for (const p of players) playerById.set(p.id, p);

  for (let calPass = 0; calPass < MAX_CALIBRATION_PASSES; calPass++) {
    // Count per-player exposure
    const playerCounts = new Map<string, number>();
    for (const lineup of fieldLineups) {
      for (const pid of lineup.playerIds) {
        playerCounts.set(pid, (playerCounts.get(pid) || 0) + 1);
      }
    }

    const overExposed = new Set<string>();
    const underExposed = new Map<string, number>(); // playerId -> deficit (in lineups)
    const fieldSize = fieldLineups.length;
    for (const player of players) {
      const fieldExposure = ((playerCounts.get(player.id) || 0) / fieldSize) * 100;
      const maxAllowed = Math.max(player.ownership * 2, player.ownership + 10);
      if (fieldExposure > maxAllowed && player.ownership > 0) {
        overExposed.add(player.id);
      }
      // Under-exposed: players with >10% ownership and field exposure < 85% of projected ownership
      // Tighter threshold catches players like Bam at 39% vs 47% target
      if (player.ownership >= 10 && fieldExposure < player.ownership * 0.85) {
        const deficit = Math.round((player.ownership - fieldExposure) / 100 * fieldSize);
        underExposed.set(player.id, deficit);
      }
    }

    if (overExposed.size === 0 && underExposed.size === 0) break;

    // --- Phase 1: Replace lineups with over-exposed players ---
    if (overExposed.size > 0) {
      const lineupsToReplace: number[] = [];
      for (let i = 0; i < fieldLineups.length; i++) {
        const fl = fieldLineups[i];
        if (fl.archetype === 'chalk' || fl.archetype === 'semiChalk' || fl.archetype === 'casual') continue;
        if (optimizerProxies?.includes(fl)) continue;
        if (fl.playerIds.some(pid => overExposed.has(pid))) lineupsToReplace.push(i);
      }

      const maxReplacements = Math.ceil(lineupsToReplace.length * 0.30);
      for (let i = lineupsToReplace.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [lineupsToReplace[i], lineupsToReplace[j]] = [lineupsToReplace[j], lineupsToReplace[i]];
      }

      let replaced = 0;
      for (const idx of lineupsToReplace) {
        if (replaced >= maxReplacements) break;
        const oldLineup = fieldLineups[idx];
        const adjustedPlayers = players.map(p =>
          overExposed.has(p.id) ? { ...p, ownership: p.ownership * 0.3 } : p
        );
        const isContrarianReplacement = oldLineup.archetype === 'contrarian';
        const replacementBoosts = isContrarianReplacement ? undefined : nonContrarianBoosts;
        const replacement = generateExpandedFieldLineup(
          adjustedPlayers, rosterSize, oldLineup.archetype, 50000 + calPass * 10000 + replaced, rng, replacementBoosts, salaryCap
        );
        if (replacement && !replacement.playerIds.some(pid => overExposed.has(pid))) {
          fieldLineups[idx] = replacement;
          replaced++;
        }
      }
      if (replaced > 0) {
        console.log(`    Calibration pass ${calPass + 1}: ${overExposed.size} over-exposed, replaced ${replaced} lineups`);
      }
    }

    // --- Phase 2: Targeted injection for under-exposed players ---
    // Instead of regenerating entire lineups (which still face positional dilution),
    // directly inject under-exposed players into existing lineups by slot swap.
    if (underExposed.size > 0) {
      let totalInjected = 0;
      for (const [playerId, deficit] of underExposed.entries()) {
        const player = playerById.get(playerId);
        if (!player || deficit <= 0) continue;

        // Find lineups that DON'T have this player
        const candidates: number[] = [];
        for (let i = 0; i < fieldLineups.length; i++) {
          const fl = fieldLineups[i];
          if (fl.archetype === 'chalk' || fl.archetype === 'semiChalk') continue;
          if (optimizerProxies?.includes(fl)) continue;
          if (fl.playerIds.includes(playerId)) continue;
          // Don't inject into lineups that already have a player with the same name
          const hasSameName = fl.playerIds.some(pid => {
            const p = playerById.get(pid);
            return p && p.name === player.name && p.id !== player.id;
          });
          if (hasSameName) continue;
          candidates.push(i);
        }

        // Shuffle candidates
        for (let i = candidates.length - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
        }

        // Inject up to 50% of deficit per pass (to avoid over-correction)
        const targetInjections = Math.ceil(deficit * 0.50);
        let injected = 0;
        for (const idx of candidates) {
          if (injected >= targetInjections) break;
          const lineup = fieldLineups[idx];

          // Find a slot that the player can fill (position-eligible)
          // and whose current occupant has LOWER ownership (swap in higher-owned player)
          let bestSwapSlot = -1;
          let lowestOwnership = player.ownership;
          for (let s = 0; s < lineup.playerIds.length; s++) {
            const slotPlayer = playerById.get(lineup.playerIds[s]);
            if (!slotPlayer) continue;

            // Check position eligibility for position-aware generation
            if (rosterSize === 8) {
              const slot = DK_NBA_POSITION_SLOTS[s];
              if (!player.positions.some(pos => slot.eligible.includes(pos))) continue;
              // Verify the displaced player could go elsewhere or is lower-owned
              if (slotPlayer.ownership >= player.ownership) continue;
            }

            // Check salary: can we afford the swap?
            const currentTotal = lineup.salaries.reduce((a, b) => a + b, 0);
            const newTotal = currentTotal - slotPlayer.salary + player.salary;
            if (newTotal > salaryCap) continue;

            if (slotPlayer.ownership < lowestOwnership) {
              lowestOwnership = slotPlayer.ownership;
              bestSwapSlot = s;
            }
          }

          if (bestSwapSlot >= 0) {
            // Execute the swap
            lineup.playerIds[bestSwapSlot] = playerId;
            lineup.salaries[bestSwapSlot] = player.salary;
            injected++;
            totalInjected++;
          }
        }
      }
      if (totalInjected > 0) {
        console.log(`    Calibration pass ${calPass + 1}: ${underExposed.size} under-exposed, injected ${totalInjected} player swaps`);
      }
    }
  }

  return fieldLineups;
}

/**
 * Calibration result with actionable recommendations.
 */
export interface CalibrationResult {
  meanAbsError: number;
  maxAbsError: number;
  isPoor: boolean;
  recommendedChalkRatio: number;
  recommendedBalancedRatio: number;
  recommendedContrarianRatio: number;
}

/**
 * Validate that synthetic field player exposures match SaberSim ownership projections.
 *
 * Returns calibration stats and logs deviations.
 * A well-calibrated field should have mean absolute error < 5%.
 *
 * When calibration is poor (MAE > 5%), returns recommended archetype ratios
 * to improve calibration on regeneration.
 */
export function validateFieldCalibration(
  fieldLineups: FieldLineup[],
  allPlayers: Player[]
): CalibrationResult {
  if (fieldLineups.length === 0) {
    return {
      meanAbsError: 0,
      maxAbsError: 0,
      isPoor: false,
      recommendedChalkRatio: 0.70,
      recommendedBalancedRatio: 0.20,
      recommendedContrarianRatio: 0.10,
    };
  }

  // Count each player's appearances in the field
  const playerCounts = new Map<string, number>();
  for (const lineup of fieldLineups) {
    for (const pid of lineup.playerIds) {
      playerCounts.set(pid, (playerCounts.get(pid) || 0) + 1);
    }
  }

  // Compare field exposure to projected ownership
  const rosterSize = fieldLineups[0].playerIds.length;
  const fieldSize = fieldLineups.length;
  const deviations: Array<{ name: string; fieldPct: number; ownPct: number; diff: number }> = [];

  for (const player of allPlayers) {
    const count = playerCounts.get(player.id) || 0;
    // Field exposure: % of lineups containing this player
    // For an 8-man roster in a field where each lineup has 8 unique players,
    // a player with X% ownership should appear in X% of lineups (on average)
    const fieldPct = (count / fieldSize) * 100;
    const ownPct = player.ownership;

    deviations.push({
      name: player.name,
      fieldPct,
      ownPct,
      diff: fieldPct - ownPct,
    });
  }

  // Sort by absolute deviation
  deviations.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  const absErrors = deviations.map(d => Math.abs(d.diff));
  const meanAbsError = absErrors.reduce((s, e) => s + e, 0) / absErrors.length;
  const maxAbsError = absErrors[0] || 0;

  // Log calibration report
  console.log(`  Field calibration (field exposure vs projected ownership):`);
  console.log(`    Mean abs error: ${meanAbsError.toFixed(1)}%`);
  const topDeviations = deviations.slice(0, 5);
  for (const d of topDeviations) {
    const sign = d.diff > 0 ? '+' : '';
    console.log(`    ${d.name.padEnd(25)} field: ${d.fieldPct.toFixed(1)}% | proj: ${d.ownPct.toFixed(1)}% | ${sign}${d.diff.toFixed(1)}%`);
  }

  // Determine if calibration is poor and calculate recommended ratios
  const isPoor = meanAbsError > 5;

  // Calculate bias direction: positive = field over-exposing high-owned players (too much chalk)
  // negative = field under-exposing high-owned players (not enough chalk)
  const highOwnedPlayers = allPlayers.filter(p => p.ownership > 20);
  let biasSum = 0;
  for (const player of highOwnedPlayers) {
    const dev = deviations.find(d => d.name === player.name);
    if (dev) biasSum += dev.diff;
  }
  const avgBias = highOwnedPlayers.length > 0 ? biasSum / highOwnedPlayers.length : 0;

  // Default ratios
  let recommendedChalkRatio = 0.70;
  let recommendedBalancedRatio = 0.20;
  let recommendedContrarianRatio = 0.10;

  if (isPoor) {
    // Adjust ratios based on bias direction
    if (avgBias > 3) {
      // Field is OVER-exposing chalk players - reduce chalk, increase balanced/contrarian
      recommendedChalkRatio = 0.60;
      recommendedBalancedRatio = 0.25;
      recommendedContrarianRatio = 0.15;
    } else if (avgBias < -3) {
      // Field is UNDER-exposing chalk players - increase chalk
      recommendedChalkRatio = 0.80;
      recommendedBalancedRatio = 0.15;
      recommendedContrarianRatio = 0.05;
    } else {
      // Mixed bias - increase chalk slightly (most common fix)
      recommendedChalkRatio = 0.75;
      recommendedBalancedRatio = 0.18;
      recommendedContrarianRatio = 0.07;
    }
  }

  return {
    meanAbsError,
    maxAbsError,
    isPoor,
    recommendedChalkRatio,
    recommendedBalancedRatio,
    recommendedContrarianRatio,
  };
}

// DraftKings NBA Classic roster slots (position-aware field generation)
const DK_NBA_POSITION_SLOTS = [
  { name: 'PG', eligible: ['PG'] },
  { name: 'SG', eligible: ['SG'] },
  { name: 'SF', eligible: ['SF'] },
  { name: 'PF', eligible: ['PF'] },
  { name: 'C',  eligible: ['C'] },
  { name: 'G',  eligible: ['PG', 'SG'] },
  { name: 'F',  eligible: ['SF', 'PF'] },
  { name: 'UTIL', eligible: ['PG', 'SG', 'SF', 'PF', 'C'] },
];

/**
 * Generate a single field lineup using GREEDY OPTIMIZATION
 * This models what real DFS optimizers produce - not random sampling.
 * 
 * For DK NBA Classic (rosterSize=8), uses position-aware slot filling
 * to respect PG/SG/SF/PF/C/G/F/UTIL constraints.
 * For Showdown (rosterSize<=6), uses position-agnostic greedy selection.
 * 
 * @param players - Player pool
 * @param rosterSize - Number of roster slots
 * @param archetype - Type of field lineup to generate
 * @param iteration - Used for randomization seed to create variety
 */
function generateGreedyFieldLineup(
  players: Player[],
  rosterSize: number,
  archetype: 'chalk' | 'balanced' | 'contrarian',
  iteration: number,
  rng: () => number = Math.random,
  fieldSalaryCap: number = 50000
): FieldLineup | null {
  const salaryCap = fieldSalaryCap;
  
  // Calculate effective value for each player based on archetype
  const playersWithValue = players.map(p => {
    let effectiveValue: number;
    
    switch (archetype) {
      case 'chalk':
        // Chalk players favor high-owned studs
        // Weight = projection * (1 + ownership/100)
        effectiveValue = p.projection * (1 + p.ownership / 100);
        break;
      
      case 'balanced':
        // Balanced = pure projection value
        effectiveValue = p.projection;
        break;
      
      case 'contrarian':
        // Contrarian = projection with ownership discount
        // Penalize high ownership, boost low ownership
        const ownershipPenalty = (p.ownership / 100) * p.projection * 0.3;
        effectiveValue = p.projection - ownershipPenalty;
        break;
    }
    
    // Vary noise by archetype for field diversity
    let noiseRange: number;
    switch (archetype) {
      case 'chalk': noiseRange = 0.30; break;      // ±15% noise
      case 'balanced': noiseRange = 0.20; break;    // ±10% noise
      case 'contrarian': noiseRange = 0.40; break;  // ±20% noise
    }
    const noise = 1 + (rng() - 0.5) * noiseRange;
    effectiveValue *= noise;

    return { player: p, effectiveValue };
  });

  // ============================================================
  // POSITION-AWARE path for DK NBA Classic (rosterSize = 8)
  // ============================================================
  if (rosterSize === 8) {
    return generatePositionAwareFieldLineup(playersWithValue, archetype, rng, salaryCap);
  }

  // ============================================================
  // POSITION-AGNOSTIC path for Showdown / other formats
  // ============================================================

  const selected: string[] = [];
  const selectedSalaries: number[] = [];
  const used = new Set<string>();
  const usedOpponentsGreedy = new Set<string>(); // Track opponent names for MMA bout exclusion
  let usedSalary = 0;

  // Fill roster slots
  for (let slot = 0; slot < rosterSize; slot++) {
    const remainingSlots = rosterSize - selected.length - 1;
    const minSalaryNeeded = remainingSlots * 3000;

    const eligible = playersWithValue.filter(({ player }) =>
      !used.has(player.id) &&
      !used.has(player.name) &&
      !usedOpponentsGreedy.has(player.name) && // MMA: exclude fighters whose opponent is already selected
      usedSalary + player.salary + minSalaryNeeded <= salaryCap
    );

    if (eligible.length === 0) break;

    let pick: typeof eligible[0];
    if (archetype === 'chalk') {
      // Ownership-proportional sampling for chalk
      pick = weightedRandomPick(eligible, e => Math.max(0.5, e.player.ownership), rng);
    } else {
      // Greedy by effective value for balanced/contrarian
      eligible.sort((a, b) => b.effectiveValue - a.effectiveValue);
      const topN = archetype === 'contrarian' ? Math.min(3, eligible.length) : 1;
      pick = eligible[Math.floor(rng() * topN)];
    }

    selected.push(pick.player.id);
    selectedSalaries.push(pick.player.salary);
    used.add(pick.player.id);
    used.add(pick.player.name);
    if (pick.player.opponent) usedOpponentsGreedy.add(pick.player.opponent);
    usedSalary += pick.player.salary;
  }

  // If we couldn't fill the lineup, try again with less strict constraints
  if (selected.length < rosterSize) {
    // Fallback to pure salary-fitting
    const remaining = playersWithValue.filter(
      ({ player }) => !used.has(player.id) && !used.has(player.name) && !usedOpponentsGreedy.has(player.name)
    );

    remaining.sort((a, b) => a.player.salary - b.player.salary);

    for (const { player } of remaining) {
      if (selected.length >= rosterSize) break;
      if (usedSalary + player.salary > salaryCap) continue;

      selected.push(player.id);
      selectedSalaries.push(player.salary);
      used.add(player.id);
      used.add(player.name);
      usedSalary += player.salary;
    }
  }

  if (selected.length < rosterSize) return null;

  return { playerIds: selected, salaries: selectedSalaries, archetype };
}

/**
 * Weighted random selection: pick an item proportional to its weight.
 */
function weightedRandomPick<T>(items: T[], weightFn: (item: T) => number, rng: () => number = Math.random): T {
  const weights = items.map(weightFn);
  const total = weights.reduce((s, w) => s + w, 0);
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

/**
 * Position-aware field lineup generation for DK NBA Classic.
 *
 * Phase 1: Fill slots using archetype-appropriate selection:
 *   - Chalk (70% of field): ownership-proportional sampling.
 *     This ensures field player exposures match SaberSim ownership projections.
 *   - Balanced: greedy by projection (models pure projection optimizers)
 *   - Contrarian: greedy by effective value with top-3 randomization
 *
 * Phase 2: Swap improvement pass — tries upgrading each slot,
 *   producing lineups closer to what a real optimizer would output.
 */
function generatePositionAwareFieldLineup(
  playersWithValue: Array<{ player: Player; effectiveValue: number }>,
  archetype: 'chalk' | 'balanced' | 'contrarian',
  rng: () => number = Math.random,
  fieldSalaryCap: number = 50000
): FieldLineup | null {
  const salaryCap = fieldSalaryCap;
  const slots = DK_NBA_POSITION_SLOTS;

  // Randomize slot fill order (Fisher-Yates) for lineup diversity
  const fillOrder = Array.from({ length: slots.length }, (_, i) => i);
  for (let i = fillOrder.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [fillOrder[i], fillOrder[j]] = [fillOrder[j], fillOrder[i]];
  }

  // Track assignment per slot: slotIdx -> player info
  const assignments: Array<{ player: Player; effectiveValue: number } | null> =
    new Array(slots.length).fill(null);
  const usedIds = new Set<string>();
  const usedNames = new Set<string>();
  const usedOpponentsPosAwareOld = new Set<string>(); // Track opponent names for MMA bout exclusion
  let usedSalary = 0;

  // ── Phase 1: Fill slots with archetype-appropriate selection ──
  for (let i = 0; i < fillOrder.length; i++) {
    const slotIdx = fillOrder[i];
    const slot = slots[slotIdx];
    const unfilled = fillOrder.length - i - 1;

    const minSalaryForRemaining = unfilled * 3500;
    const maxSalary = salaryCap - usedSalary - minSalaryForRemaining;

    const eligible = playersWithValue.filter(({ player }) =>
      !usedIds.has(player.id) &&
      !usedNames.has(player.name) &&
      !usedOpponentsPosAwareOld.has(player.name) && // MMA: exclude fighters whose opponent is already selected
      player.positions.some(pos => slot.eligible.includes(pos)) &&
      player.salary <= maxSalary
    );

    if (eligible.length === 0) return null;

    let pick: typeof eligible[0];

    if (archetype === 'chalk') {
      // Ownership-proportional sampling: field exposure will match projected ownership.
      // SaberSim ownership = probability of appearing in a random field lineup,
      // so sampling by ownership directly recreates the real field distribution.
      pick = weightedRandomPick(eligible, e => Math.max(0.5, e.player.ownership), rng);
    } else if (archetype === 'balanced') {
      // Greedy by projection — models pure projection optimizers
      eligible.sort((a, b) => b.effectiveValue - a.effectiveValue);
      pick = eligible[0];
    } else {
      // Contrarian: top-3 randomization for diversity
      eligible.sort((a, b) => b.effectiveValue - a.effectiveValue);
      const topN = Math.min(3, eligible.length);
      pick = eligible[Math.floor(rng() * topN)];
    }

    assignments[slotIdx] = pick;
    usedIds.add(pick.player.id);
    usedNames.add(pick.player.name);
    if (pick.player.opponent) usedOpponentsPosAwareOld.add(pick.player.opponent);
    usedSalary += pick.player.salary;
  }

  // ── Phase 2: Swap improvement (balanced/contrarian only) ──
  // Skip for chalk: ownership-weighted Phase 1 must be preserved for calibration.
  // Chalk represents the average field player who selects by popularity, not
  // the optimizer user who maximizes projection. The swap pass would override
  // ownership-weighted picks with projection-maximized ones, destroying calibration.
  //
  // Balanced/contrarian DO get the swap pass since they model optimizer behavior.
  if (archetype !== 'chalk') {
    for (let pass = 0; pass < 2; pass++) {
      let anyImproved = false;

      for (let slotIdx = 0; slotIdx < slots.length; slotIdx++) {
        const current = assignments[slotIdx]!;
        const slot = slots[slotIdx];
        // Budget if we remove current player
        const budgetForSlot = salaryCap - (usedSalary - current.player.salary);

        let bestCandidate: typeof current | null = null;
        let bestValue = current.effectiveValue;

        for (const candidate of playersWithValue) {
          if (candidate.effectiveValue <= bestValue) continue; // quick reject
          if (usedIds.has(candidate.player.id)) continue;
          if (usedNames.has(candidate.player.name)) continue;
          // MMA opponent exclusion check for swap candidates
          if (usedOpponentsPosAwareOld.has(candidate.player.name) && candidate.player.name !== (current.player.opponent || '')) continue;
          if (!candidate.player.positions.some(pos => slot.eligible.includes(pos))) continue;
          if (candidate.player.salary > budgetForSlot) continue;

          bestCandidate = candidate;
          bestValue = candidate.effectiveValue;
        }

        if (bestCandidate) {
          usedSalary = usedSalary - current.player.salary + bestCandidate.player.salary;
          usedIds.delete(current.player.id);
          usedNames.delete(current.player.name);
          if (current.player.opponent) usedOpponentsPosAwareOld.delete(current.player.opponent);
          usedIds.add(bestCandidate.player.id);
          usedNames.add(bestCandidate.player.name);
          if (bestCandidate.player.opponent) usedOpponentsPosAwareOld.add(bestCandidate.player.opponent);
          assignments[slotIdx] = bestCandidate;
          anyImproved = true;
        }
      }

      if (!anyImproved) break;
    }
  }

  const playerIds = assignments.map(a => a!.player.id);
  const salaries = assignments.map(a => a!.player.salary);
  return { playerIds, salaries, archetype };
}

/**
 * Generate an expanded field lineup with any of the 7 archetype types.
 * Maps expanded archetypes to the greedy engine with appropriate value functions.
 */
function generateExpandedFieldLineup(
  players: Player[],
  rosterSize: number,
  archetype: FieldArchetype,
  iteration: number,
  rng: () => number = Math.random,
  selectionBoosts?: Map<string, number>,
  fieldSalaryCap: number = 50000
): FieldLineup | null {
  const salaryCap = fieldSalaryCap;

  // Apply projection perturbation for field lineups
  // Sport-specific noise: golf has much higher variance, casual players chase longshots
  const uniqueFieldGames = new Set(players.map(p => p.gameInfo || p.team)).size;
  const isSingleEventField = uniqueFieldGames <= 1;
  const noiseChance = isSingleEventField ? 0.50 : 0.40;   // 50% golf/individual, 40% team sports
  const noiseRange = isSingleEventField ? 0.30 : 0.15;     // ±15% golf/individual, ±7.5% team sports

  let effectivePlayers = players;
  if (rng() < noiseChance) {
    effectivePlayers = players.map(p => ({
      ...p,
      projection: p.projection * (1 + (rng() - 0.5) * noiseRange),
    }));
  }

  // Field projection correction: high-owned players get a boost (field believes in them)
  // Low-owned players get a discount (field is skeptical)
  // This models information asymmetry — field uses different projection sources
  if (archetype !== 'sharpOptimizer' && archetype !== 'leverageOptimizer') {
    const avgOwnership = effectivePlayers.reduce((s, p) => s + p.ownership, 0) / effectivePlayers.length;
    effectivePlayers = effectivePlayers.map(p => {
      // Ownership deviation from average: positive = field likes them more
      const ownDev = (p.ownership - avgOwnership) / 100;
      // Projection adjustment: ±5% at extremes
      const projAdj = 1 + ownDev * 0.05;
      return { ...p, projection: p.projection * Math.max(0.92, Math.min(1.08, projAdj)) };
    });
  }

  // Calculate effective value for each player based on expanded archetype
  const playersWithValue = effectivePlayers.map(p => {
    let effectiveValue: number;

    switch (archetype) {
      case 'chalk':
        // Pure chalk: ownership-proportional (calibration anchor)
        effectiveValue = p.projection * (1 + p.ownership / 100);
        break;

      case 'semiChalk':
        // Semi-chalk: chalk core with 1-2 low-owned pivots
        // High-owned get full value, mid-owned get discount, low-owned get slight boost
        if (p.ownership > 25) {
          effectiveValue = p.projection * (1 + p.ownership / 150);
        } else if (p.ownership < 10) {
          effectiveValue = p.projection * 1.05; // Slight boost to make pivots viable
        } else {
          effectiveValue = p.projection * 0.90; // Mid-owned discouraged
        }
        break;

      case 'stackChalk':
        // Stack-chalk: favor players from high game-total games
        // Players in high-scoring games get boost
        {
          const gameTotal = p.gameTotal || 225;
          const gameTotalBonus = Math.max(0.8, gameTotal / 225);
          effectiveValue = p.projection * (1 + p.ownership / 200) * gameTotalBonus;
        }
        break;

      case 'balanced':
        // Pure projection optimizer
        effectiveValue = p.projection;
        break;

      case 'leverageOptimizer':
        // Projection with moderate ownership penalty (models other optimizer users)
        {
          const ownPenalty = (p.ownership / 100) * p.projection * 0.4;
          effectiveValue = p.projection - ownPenalty;
        }
        break;

      case 'ceilingOptimizer':
        // Projection + ceiling blend (models ceiling-focused optimizers)
        {
          const ceil = p.ceiling || p.projection * 1.25;
          effectiveValue = p.projection * 0.60 + ceil * 0.40;
        }
        break;

      case 'casual':
        // Realistic casual: DK app projections (noisy) + salary/name anchoring + star factor
        // Casuals see DK app projections prominently — projection matters more than raw salary
        {
          // App projection: noisy version of true projection (70-130% of actual)
          const appProjection = p.projection * (0.70 + rng() * 0.60);

          // Salary anchoring: reduced from 0.5 exponent (casuals use app projections more now)
          const salaryBias = Math.pow(p.salary / 8000, 0.4);

          // Name recognition: high-owned = well-known = casuals amplify
          const nameBias = Math.pow(Math.max(1, p.ownership) / 20, 0.8);

          // Rebalanced: projection-heavy (casuals see DK app projections prominently)
          effectiveValue = appProjection * 0.40 + salaryBias * 12 * 0.30 + nameBias * 10 * 0.30;

          // Gradient "my guy": continuous boost proportional to star power
          // Stars get bigger boosts, not random binary spikes
          const starFactor = Math.min(1.0, (p.ownership / 100) * 0.7 + (p.salary / 10000) * 0.3);
          effectiveValue *= 1.0 + starFactor * 0.5 * rng(); // 1.0x-1.5x for stars

          // Rare gut pick: 4% chance of 2.0x (was 10%/2.5x)
          if (rng() < 0.04) effectiveValue *= 2.0;
        }
        break;

      case 'contrarian':
        // Contrarian: projection with heavy ownership discount + ceiling ratio gate
        // Real contrarians target high-ceiling fades, not low-ceiling trash
        {
          const ownershipPenalty = (p.ownership / 100) * p.projection * 0.45;

          // Ceiling ratio gate: contrarians target high-ceiling fades
          const ceil = p.ceiling || p.projection * 1.25;
          const ceil99 = p.ceiling99 || ceil * 1.15;
          const blendedCeil = ceil * 0.55 + ceil99 * 0.45;
          const ceilRatio = blendedCeil / Math.max(1, p.projection);

          // Below 1.25 ratio = 0.7x, above 1.45 = 1.2x, linear between
          const ceilMult = Math.max(0.7, Math.min(1.2, 0.7 + (ceilRatio - 1.25) * 2.5));

          effectiveValue = (p.projection - ownershipPenalty) * ceilMult;
        }
        break;

      case 'sharpOptimizer':
        // Sharp pros: leverage-adjusted projection with ceiling ratio boost + combo awareness
        // Core selection: top-8 candidates scored by projection * (1 - own * 0.15) * ceilingRatio
        // Sharp optimizers differentiate through better combos, not by fading chalk.
        {
          const ceil = p.ceiling || p.projection * 1.25;
          const ceilRatio = ceil / Math.max(1, p.projection);
          // Leverage-adjusted: penalize ownership moderately (real sharps penalize 20-30%)
          const leverageAdj = 1 - (p.ownership / 100) * 0.25;
          effectiveValue = p.projection * leverageAdj * ceilRatio;

          // Stack-aware boost: if player is in a high game-total game, small bonus
          // (sharps intentionally stack for correlated upside)
          const gameTotal = p.gameTotal || 225;
          if (gameTotal > 225) {
            effectiveValue *= 1 + (gameTotal - 225) / 500; // ~3% boost per 15 pts above 225
          }
        }
        break;

      case 'stackBuilder':
        // Stack-enforcing builder: pre-select target game and 3 players, fill rest via greedy.
        // Phase 1 picks the effectiveValue; actual stack enforcement happens post-construction
        // in generatePositionAwareFieldLineupExpanded via the stackBuilder special path.
        // Here we just compute game-weighted projection for the greedy fill step.
        {
          const gameTotal = p.gameTotal || 225;
          const gameTotalBonus = Math.pow(Math.max(0.85, gameTotal / 225), 1.5);
          const ownPenalty = (p.ownership / 100) * p.projection * 0.20;
          effectiveValue = (p.projection - ownPenalty) * gameTotalBonus;
        }
        break;

      default:
        effectiveValue = p.projection;
    }

    // Apply archetype-specific noise
    let noiseRange: number;
    switch (archetype) {
      case 'chalk': noiseRange = 0.30; break;
      case 'semiChalk': noiseRange = 0.25; break;
      case 'stackChalk': noiseRange = 0.25; break;
      case 'balanced': noiseRange = 0.20; break;
      case 'leverageOptimizer': noiseRange = 0.20; break;
      case 'ceilingOptimizer': noiseRange = 0.25; break;
      case 'casual': noiseRange = 0.50; break;  // Very noisy
      case 'contrarian': noiseRange = 0.40; break;
      case 'sharpOptimizer': noiseRange = 0.15; break;  // Low noise (sophisticated)
      case 'stackBuilder': noiseRange = 0.20; break;  // Moderate noise (intentional stacker)
      default: noiseRange = 0.25;
    }
    const noise = 1 + (rng() - 0.5) * noiseRange;
    effectiveValue *= noise;

    return { player: p, effectiveValue };
  });

  // Compute max effectiveValue for perturbation normalization
  const maxEV = Math.max(...playersWithValue.map(p => p.effectiveValue), 1);

  // Use position-aware path for DK NBA Classic, position-agnostic for others
  if (rosterSize === 8) {
    // Map expanded archetypes to selection behavior
    const selectionArchetype = getSelectionArchetype(archetype);
    return generatePositionAwareFieldLineupExpanded(playersWithValue, archetype, selectionArchetype, maxEV, rng, selectionBoosts, salaryCap);
  }

  // Position-agnostic path (showdown/other)
  const selected: string[] = [];
  const selectedSalaries: number[] = [];
  const used = new Set<string>();
  const usedOpponents = new Set<string>(); // Track opponent names for MMA bout exclusion
  let usedSalary = 0;

  for (let slot = 0; slot < rosterSize; slot++) {
    const remainingSlots = rosterSize - selected.length - 1;
    const minSalaryNeeded = remainingSlots * 3000;

    const eligible = playersWithValue.filter(({ player }) =>
      !used.has(player.id) &&
      !used.has(player.name) &&
      !usedOpponents.has(player.name) && // MMA: exclude fighters whose opponent is already selected
      usedSalary + player.salary + minSalaryNeeded <= salaryCap
    );

    if (eligible.length === 0) break;

    let pick: typeof eligible[0];
    const selectionArchetype = getSelectionArchetype(archetype);
    if (selectionArchetype === 'chalk' || selectionArchetype === 'casual') {
      pick = weightedRandomPick(eligible, e => {
        const baseOwn = Math.max(0.5, e.player.ownership);
        const boost = selectionBoosts?.get(e.player.id) || 1.0;
        return baseOwn * boost;
      }, rng);
    } else if (selectionArchetype === 'balanced') {
      // Ownership-anchored selection: ownership is PRIMARY weight, effectiveValue is ±20% perturbation.
      // selectionBoosts correct for positional dilution (structural under-exposure).
      pick = weightedRandomPick(eligible, e => {
        const boost = selectionBoosts?.get(e.player.id) || 1.0;
        const ownWeight = Math.max(0.5, e.player.ownership) * boost;
        const evRatio = e.effectiveValue / maxEV; // 0 to ~1
        const perturbation = 0.8 + evRatio * 0.4; // [0.8, 1.2]
        return Math.max(0.01, ownWeight * perturbation);
      }, rng);
    } else {
      // contrarian (~8% of field): inverse-ownership weighted — these ARE the field segment
      // that deviates from ownership. No boost applied (contrarian deliberately deviates).
      pick = weightedRandomPick(eligible, e => {
        const invOwn = 1.0 / Math.max(1, e.player.ownership);
        return Math.max(0.01, e.effectiveValue * invOwn * 100);
      }, rng);
    }

    selected.push(pick.player.id);
    selectedSalaries.push(pick.player.salary);
    used.add(pick.player.id);
    used.add(pick.player.name);
    if (pick.player.opponent) usedOpponents.add(pick.player.opponent);
    usedSalary += pick.player.salary;
  }

  if (selected.length < rosterSize) return null;

  // Swap improvement for sophisticated archetypes (others preserve stochastic diversity)
  const MAX_SWAP_PASSES = archetype === 'sharpOptimizer' ? 2
    : (archetype === 'leverageOptimizer' || archetype === 'ceilingOptimizer') ? 1
    : 0;
  for (let pass = 0; pass < MAX_SWAP_PASSES; pass++) {
    let anyImproved = false;
    for (let slot = 0; slot < rosterSize; slot++) {
      const currentId = selected[slot];
      const currentPlayer = playersWithValue.find(p => p.player.id === currentId);
      if (!currentPlayer) continue;

      const currentSalary = selectedSalaries[slot];
      const otherSalary = usedSalary - currentSalary;

      let bestSwap: typeof playersWithValue[0] | null = null;
      let bestValue = currentPlayer.effectiveValue;

      for (const candidate of playersWithValue) {
        if (used.has(candidate.player.id) && candidate.player.id !== currentId) continue;
        if (candidate.player.id === currentId) continue;
        if (used.has(candidate.player.name) && candidate.player.name !== currentPlayer.player.name) continue;
        // MMA opponent exclusion check for swap candidates
        if (usedOpponents.has(candidate.player.name) && candidate.player.name !== (currentPlayer.player.opponent || '')) continue;
        // Check salary feasibility
        if (otherSalary + candidate.player.salary > salaryCap) continue;
        if (candidate.effectiveValue > bestValue) {
          bestSwap = candidate;
          bestValue = candidate.effectiveValue;
        }
      }

      if (bestSwap) {
        // Execute swap
        used.delete(currentId);
        used.delete(currentPlayer.player.name);
        if (currentPlayer.player.opponent) usedOpponents.delete(currentPlayer.player.opponent);
        selected[slot] = bestSwap.player.id;
        selectedSalaries[slot] = bestSwap.player.salary;
        usedSalary = otherSalary + bestSwap.player.salary;
        used.add(bestSwap.player.id);
        used.add(bestSwap.player.name);
        if (bestSwap.player.opponent) usedOpponents.add(bestSwap.player.opponent);
        anyImproved = true;
      }
    }
    if (!anyImproved) break;
  }

  return { playerIds: selected, salaries: selectedSalaries, archetype };
}

/**
 * Map expanded archetype to selection behavior (chalk/balanced/contrarian/casual).
 */
function getSelectionArchetype(archetype: FieldArchetype): 'chalk' | 'balanced' | 'contrarian' | 'casual' {
  switch (archetype) {
    case 'chalk':
    case 'semiChalk':
    case 'stackChalk':
      return 'chalk';
    case 'balanced':
    case 'leverageOptimizer':
    case 'ceilingOptimizer':
    case 'sharpOptimizer':  // Sharp optimizers don't randomly sample — they optimize
      return 'balanced';
    case 'stackBuilder':  // Stack builders pick best available (like balanced) but with game-total-weighted values
      return 'balanced';
    case 'casual':
      return 'casual';
    case 'contrarian':
      return 'contrarian';
    default:
      return 'balanced';
  }
}

/**
 * Position-aware field lineup generation with expanded archetype support.
 */
function generatePositionAwareFieldLineupExpanded(
  playersWithValue: Array<{ player: Player; effectiveValue: number }>,
  archetype: FieldArchetype,
  selectionArchetype: 'chalk' | 'balanced' | 'contrarian' | 'casual',
  maxEV: number,
  rng: () => number = Math.random,
  selectionBoosts?: Map<string, number>,
  fieldSalaryCap: number = 50000
): FieldLineup | null {
  const salaryCap = fieldSalaryCap;
  const slots = DK_NBA_POSITION_SLOTS;

  // Randomize slot fill order for diversity
  const fillOrder = Array.from({ length: slots.length }, (_, i) => i);
  for (let i = fillOrder.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [fillOrder[i], fillOrder[j]] = [fillOrder[j], fillOrder[i]];
  }

  const assignments: Array<{ player: Player; effectiveValue: number } | null> =
    new Array(slots.length).fill(null);
  const usedIds = new Set<string>();
  const usedNames = new Set<string>();
  const usedOpponentsPosAware = new Set<string>(); // Track opponent names for MMA bout exclusion
  let usedSalary = 0;

  // Stack builder pre-selection: pick a target game and pre-assign 3 players from it
  const stackPreAssigned = new Set<number>(); // slot indices already assigned by stack pre-selection
  if (archetype === 'stackBuilder') {
    // Group players by game
    const gameGroups = new Map<string, Array<{ player: Player; effectiveValue: number }>>();
    for (const pv of playersWithValue) {
      const gameId = pv.player.gameInfo || `${pv.player.team}_game`;
      if (!gameGroups.has(gameId)) gameGroups.set(gameId, []);
      gameGroups.get(gameId)!.push(pv);
    }

    // Pick target game weighted by (gameTotal/225)^1.5 * numPlayers
    const gameWeights: Array<{ gameId: string; weight: number; players: typeof playersWithValue }> = [];
    for (const [gameId, gamePlayers] of gameGroups) {
      if (gamePlayers.length < 3) continue; // Need at least 3 players to stack
      const gameTotal = gamePlayers[0].player.gameTotal || 225;
      const weight = Math.pow(Math.max(0.85, gameTotal / 225), 1.5) * gamePlayers.length;
      gameWeights.push({ gameId, weight, players: gamePlayers });
    }

    if (gameWeights.length > 0) {
      // Weighted random game selection
      const totalWeight = gameWeights.reduce((s, g) => s + g.weight, 0);
      let r = rng() * totalWeight;
      let targetGame = gameWeights[0];
      for (const g of gameWeights) {
        r -= g.weight;
        if (r <= 0) { targetGame = g; break; }
      }

      // Variable stack depth: 2=25%, 3=40%, 4=25%, 5=10%
      const gamePool = [...targetGame.players];
      const depthRoll = rng();
      const stackDepth = depthRoll < 0.25 ? 2
        : depthRoll < 0.65 ? 3
        : depthRoll < 0.90 ? 4
        : Math.min(5, gamePool.length);

      // Split pool into primary team and opponent for bring-back
      const primaryTeam = gamePool[0]?.player.team;
      const primaryPool = gamePool.filter(pv => pv.player.team === primaryTeam);
      const opponentPool = gamePool.filter(pv => pv.player.team !== primaryTeam);

      // Ensure bring-back for depth >= 3 (60% chance for depth=2)
      const needsBringBack = stackDepth >= 3 || rng() < 0.60;
      const opponentCount = (needsBringBack && opponentPool.length > 0)
        ? Math.max(1, Math.min(Math.floor(stackDepth / 2), opponentPool.length))
        : 0;
      const primaryCount = Math.min(stackDepth - opponentCount, primaryPool.length);

      // Select from each pool via weighted random (projection-weighted pick logic)
      const preSelected: Array<{ player: Player; effectiveValue: number }> = [];
      const pickFromPool = (pool: typeof gamePool, count: number) => {
        const remaining = [...pool];
        for (let pick = 0; pick < count && remaining.length > 0; pick++) {
          const idx = weightedRandomPick(
            remaining.map((_, i) => i),
            i => Math.max(1, remaining[i].player.projection * (0.8 + rng() * 0.4)),
            rng
          );
          preSelected.push(remaining[idx]);
          remaining.splice(idx, 1);
        }
      };
      pickFromPool(primaryPool, primaryCount);
      pickFromPool(opponentPool, opponentCount);

      // Assign pre-selected players to compatible slots
      for (const ps of preSelected) {
        for (let si = 0; si < slots.length; si++) {
          if (stackPreAssigned.has(si)) continue;
          if (assignments[si] !== null) continue;
          if (ps.player.positions.some(pos => slots[si].eligible.includes(pos)) &&
              ps.player.salary <= salaryCap - usedSalary - (slots.length - stackPreAssigned.size - 1) * 3500) {
            assignments[si] = ps;
            usedIds.add(ps.player.id);
            usedNames.add(ps.player.name);
            if (ps.player.opponent) usedOpponentsPosAware.add(ps.player.opponent);
            usedSalary += ps.player.salary;
            stackPreAssigned.add(si);
            break;
          }
        }
      }
    }
  }

  // Phase 1: Fill slots (skip stack-preassigned slots)
  for (let i = 0; i < fillOrder.length; i++) {
    const slotIdx = fillOrder[i];
    if (stackPreAssigned.has(slotIdx)) continue; // Already filled by stack pre-selection

    const slot = slots[slotIdx];
    // Count remaining unfilled slots
    let unfilled = 0;
    for (let j = i + 1; j < fillOrder.length; j++) {
      if (!stackPreAssigned.has(fillOrder[j]) && !assignments[fillOrder[j]]) unfilled++;
    }
    const minSalaryForRemaining = unfilled * 3500;
    const maxSalary = salaryCap - usedSalary - minSalaryForRemaining;

    const eligible = playersWithValue.filter(({ player }) =>
      !usedIds.has(player.id) &&
      !usedNames.has(player.name) &&
      !usedOpponentsPosAware.has(player.name) && // MMA: exclude fighters whose opponent is already selected
      player.positions.some(pos => slot.eligible.includes(pos)) &&
      player.salary <= maxSalary
    );

    if (eligible.length === 0) return null;

    let pick: typeof eligible[0];
    if (selectionArchetype === 'chalk' || selectionArchetype === 'casual') {
      pick = weightedRandomPick(eligible, e => {
        const baseOwn = Math.max(0.5, e.player.ownership);
        const boost = selectionBoosts?.get(e.player.id) || 1.0;
        return baseOwn * boost;
      }, rng);
    } else if (selectionArchetype === 'balanced') {
      // Ownership-anchored selection: ownership is PRIMARY weight, effectiveValue is ±20% perturbation.
      // selectionBoosts correct for positional dilution (structural under-exposure).
      pick = weightedRandomPick(eligible, e => {
        const boost = selectionBoosts?.get(e.player.id) || 1.0;
        const ownWeight = Math.max(0.5, e.player.ownership) * boost;
        const evRatio = maxEV > 0 ? e.effectiveValue / maxEV : 0.5; // 0 to ~1
        const perturbation = 0.8 + evRatio * 0.4; // [0.8, 1.2]
        return Math.max(0.01, ownWeight * perturbation);
      }, rng);
    } else {
      // contrarian (~8% of field): inverse-ownership weighted — these ARE the field segment
      // that deviates from ownership. No boost applied.
      pick = weightedRandomPick(eligible, e => {
        const invOwn = 1.0 / Math.max(1, e.player.ownership);
        return Math.max(0.01, e.effectiveValue * invOwn * 100);
      }, rng);
    }

    assignments[slotIdx] = pick;
    usedIds.add(pick.player.id);
    usedNames.add(pick.player.name);
    if (pick.player.opponent) usedOpponentsPosAware.add(pick.player.opponent);
    usedSalary += pick.player.salary;
  }

  // Phase 2: Swap improvement (only for sharpOptimizer — other archetypes preserve stochastic diversity)
  if (selectionArchetype !== 'chalk' && selectionArchetype !== 'casual'
    && archetype === 'sharpOptimizer') {
    for (let pass = 0; pass < 2; pass++) {
      let anyImproved = false;
      for (let slotIdx = 0; slotIdx < slots.length; slotIdx++) {
        const current = assignments[slotIdx]!;
        const slot = slots[slotIdx];
        const budgetForSlot = salaryCap - (usedSalary - current.player.salary);

        let bestCandidate: typeof current | null = null;
        let bestValue = current.effectiveValue;

        for (const candidate of playersWithValue) {
          if (candidate.effectiveValue <= bestValue) continue;
          if (usedIds.has(candidate.player.id)) continue;
          if (usedNames.has(candidate.player.name)) continue;
          // MMA opponent exclusion check for swap candidates
          if (usedOpponentsPosAware.has(candidate.player.name) && candidate.player.name !== (current.player.opponent || '')) continue;
          if (!candidate.player.positions.some(pos => slot.eligible.includes(pos))) continue;
          if (candidate.player.salary > budgetForSlot) continue;

          bestCandidate = candidate;
          bestValue = candidate.effectiveValue;
        }

        if (bestCandidate) {
          usedSalary = usedSalary - current.player.salary + bestCandidate.player.salary;
          usedIds.delete(current.player.id);
          usedNames.delete(current.player.name);
          if (current.player.opponent) usedOpponentsPosAware.delete(current.player.opponent);
          usedIds.add(bestCandidate.player.id);
          usedNames.add(bestCandidate.player.name);
          if (bestCandidate.player.opponent) usedOpponentsPosAware.add(bestCandidate.player.opponent);
          assignments[slotIdx] = bestCandidate;
          anyImproved = true;
        }
      }
      if (!anyImproved) break;
    }
  }

  // Sharp optimizer: combo rejection against previous sharp lineups
  // If any 3-player combo appears in >5% of previous sharp lineups, swap weakest member
  if (archetype === 'sharpOptimizer' && previousSharpLineups.length >= 20) {
    const currentIds = assignments.map(a => a!.player.id);
    const rejectIdx = checkSharpComboRejection(currentIds, previousSharpLineups);
    if (rejectIdx >= 0 && rejectIdx < assignments.length) {
      const current = assignments[rejectIdx]!;
      const slot = DK_NBA_POSITION_SLOTS[rejectIdx];
      const budgetForSlot = salaryCap - (usedSalary - current.player.salary);

      // Find best replacement not already used
      const candidates = playersWithValue.filter(({ player }) =>
        !usedIds.has(player.id) &&
        !usedNames.has(player.name) &&
        player.positions.some(pos => slot.eligible.includes(pos)) &&
        player.salary <= budgetForSlot
      );
      if (candidates.length > 0) {
        // Pick from top-3 by effective value for diversity
        candidates.sort((a, b) => b.effectiveValue - a.effectiveValue);
        const pick = candidates[Math.min(Math.floor(rng() * 3), candidates.length - 1)];
        usedSalary = usedSalary - current.player.salary + pick.player.salary;
        usedIds.delete(current.player.id);
        usedNames.delete(current.player.name);
        usedIds.add(pick.player.id);
        usedNames.add(pick.player.name);
        assignments[rejectIdx] = pick;
      }
    }
  }

  // stackChalk: enforce 3+ from same game post-construction
  if (archetype === 'stackChalk') {
    // Count players per game in current lineup
    const gameCountsStack = new Map<string, number>();
    for (const a of assignments) {
      if (!a) continue;
      const gId = a.player.gameInfo || `${a.player.team}_game`;
      gameCountsStack.set(gId, (gameCountsStack.get(gId) || 0) + 1);
    }
    const maxGameStack = Math.max(0, ...[...gameCountsStack.values()]);

    // If no 3+ stack, try to swap one non-stack player for a same-game player
    if (maxGameStack < 3) {
      // Find the game with the most players (2)
      let bestGame = '';
      let bestCount = 0;
      for (const [gId, cnt] of gameCountsStack) {
        if (cnt > bestCount) { bestCount = cnt; bestGame = gId; }
      }

      if (bestCount >= 2 && bestGame) {
        // Find a slot NOT in bestGame to swap
        const usedIds = new Set(assignments.map(a => a?.player.id));
        for (let si = 0; si < assignments.length; si++) {
          const a = assignments[si];
          if (!a) continue;
          const aGame = a.player.gameInfo || `${a.player.team}_game`;
          if (aGame === bestGame) continue; // Don't swap stack players

          // Find a replacement from bestGame that fits this slot
          const slotEligible = slots[si].eligible;
          const candidates = playersWithValue.filter(pv =>
            !usedIds.has(pv.player.id) &&
            (pv.player.gameInfo || `${pv.player.team}_game`) === bestGame &&
            pv.player.positions.some(pos => slotEligible.includes(pos)) &&
            pv.player.salary <= a.player.salary + 500 // Allow small salary increase
          );
          if (candidates.length > 0) {
            // Pick highest projection candidate
            candidates.sort((a, b) => b.player.projection - a.player.projection);
            assignments[si] = candidates[0];
            break; // One swap is enough to get 3-stack
          }
        }
      }
    }
  }

  const playerIds = assignments.map(a => a!.player.id);
  const salaries = assignments.map(a => a!.player.salary);
  return { playerIds, salaries, archetype };
}

/**
 * Generate a single field lineup with specified archetype (LEGACY - for backward compatibility)
 */
function generateSingleFieldLineup(
  players: Player[],
  rosterSize: number,
  archetype: 'chalk' | 'balanced' | 'contrarian'
): FieldLineup | null {
  return generateGreedyFieldLineup(players, rosterSize, archetype, 0);
}

/**
 * Generate a synthetic field lineup and return its score
 * (Legacy function for backward compatibility)
 */
function generateFieldLineup(
  players: Player[],
  rosterSize: number
): number {
  let score = 0;
  const used = new Set<string>();

  for (let slot = 0; slot < rosterSize; slot++) {
    // Sample player proportional to ownership
    const eligible = players.filter(p => !used.has(p.id));
    if (eligible.length === 0) break;

    const totalOwn = eligible.reduce((s, p) => s + Math.max(1, p.ownership), 0);
    let r = Math.random() * totalOwn;

    for (const p of eligible) {
      r -= Math.max(1, p.ownership);
      if (r <= 0) {
        score += samplePlayerOutcome(p);
        used.add(p.id);
        break;
      }
    }
  }

  return score;
}

// ============================================================
// BINARY SEARCH FOR FINISH POSITION
// ============================================================

/**
 * Binary search for finish position in a descending-sorted array.
 * Returns 1-indexed position (1 = first place).
 *
 * For a candidate score, finds how many field scores are strictly greater.
 * O(log N) instead of O(N) linear scan — ~100x speedup for 10K field.
 */
function findFinishPosition(score: number, sortedFieldScores: Float64Array | number[]): number {
  let lo = 0;
  let hi = sortedFieldScores.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedFieldScores[mid] > score) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1; // 1-indexed position
}

// ============================================================
// TIERED SIMULATION
// ============================================================

/**
 * Tiered simulation configuration.
 * Tier 1: Full sim with finish vectors (for portfolio optimization)
 * Tier 2: Quick sim with payout tracking only
 * Tier 3: Ultra-quick sim with score only
 */
export interface TieredSimConfig {
  tier1Count: number;       // Top N get full sim (default: 5000)
  tier1Sims: number;        // Sims for tier 1 (default: 1000)
  tier2Count: number;       // Next N get quick sim (default: 15000)
  tier2Sims: number;        // Sims for tier 2 (default: 200)
  tier3Sims: number;        // Sims for remaining (default: 50)
  fieldSize: number;        // Contest field size
  entryFee: number;
  payoutStructure: PayoutTier[];
  sport?: string;           // Sport type for correlation model
}

const DEFAULT_TIERED_CONFIG: TieredSimConfig = {
  tier1Count: 15000,
  tier1Sims: 2000,
  tier2Count: 15000,
  tier2Sims: 200,
  tier3Sims: 50,
  fieldSize: 10000,
  entryFee: 20,
  payoutStructure: [],  // Set at runtime
};

/**
 * Run tiered tournament simulation on ALL candidates.
 *
 * Pre-generates and caches field outcomes per sim to avoid redundant work:
 * 1. For each sim: generate correlation factors → score ALL field lineups → sort
 * 2. Store sorted field scores per sim in a compact array
 * 3. For each candidate: score against pre-computed outcomes, binary-search rank
 *
 * Tier 1 (top 5K): Full 1000 sims, stores finish position vectors
 * Tier 2 (next 15K): Quick 200 sims, stores expectedPayout + score only
 * Tier 3 (remaining): Ultra-quick 50 sims, score only
 */
export function simulateTiered(
  candidates: Lineup[],
  allPlayers: Player[],
  fieldPool: FieldLineup[],
  config?: Partial<TieredSimConfig>
): Map<string, SimulationResult> {
  const cfg: TieredSimConfig = {
    ...DEFAULT_TIERED_CONFIG,
    ...config,
    payoutStructure: config?.payoutStructure || buildGPPPayoutStructure(
      config?.fieldSize || 10000,
      config?.entryFee || 20
    ),
  };

  const { tier1Count, tier1Sims, tier2Count, tier2Sims, tier3Sims, fieldSize, entryFee, payoutStructure } = cfg;
  const maxSims = tier1Sims; // Pre-compute this many sims (tier 2/3 use subset)

  console.log(`  Tiered simulation: ${candidates.length.toLocaleString()} candidates`);
  console.log(`    Tier 1: top ${tier1Count} × ${tier1Sims} sims (full vectors)`);
  console.log(`    Tier 2: next ${tier2Count} × ${tier2Sims} sims (payout only)`);
  console.log(`    Tier 3: remaining × ${tier3Sims} sims (score only)`);

  // Build player lookup
  const playerMap = new Map<string, Player>();
  for (const player of allPlayers) {
    playerMap.set(player.id, player);
  }

  const fieldSampleSize = fieldPool.length;
  const scaleFactor = fieldSize / fieldSampleSize;
  const startTime = Date.now();

  // === SIM-MAJOR STREAMING SIMULATION ===
  // For each simulation, generate player outcomes and field scores ONCE,
  // then score all applicable candidates. This avoids storing player outcomes
  // (~60MB) and sorted field scores (~320MB) across all sims.
  console.log(`  Running ${maxSims} simulations (streaming field+candidates, ${fieldSampleSize} field lineups)...`);

  const results = new Map<string, SimulationResult>();

  // Determine tier boundaries
  const tier1End = Math.min(tier1Count, candidates.length);
  const tier2End = Math.min(tier1Count + tier2Count, candidates.length);

  // Pre-allocate per-candidate accumulators (typed arrays for cache efficiency)
  const totalPositions = new Float64Array(candidates.length);
  const firstPlaceCounts = new Uint32Array(candidates.length);
  const top1PctCounts = new Uint32Array(candidates.length);
  const top5PctCounts = new Uint32Array(candidates.length);
  const top10PctCounts = new Uint32Array(candidates.length);
  const cashCounts = new Uint32Array(candidates.length);
  const totalPayouts = new Float64Array(candidates.length);

  // Finish vectors for tier1 candidates only (Float32Array saves ~120MB vs number[])
  const finishVectors: (Float32Array | null)[] = new Array(candidates.length);
  for (let ci = 0; ci < candidates.length; ci++) {
    finishVectors[ci] = ci < tier1End ? new Float32Array(tier1Sims) : null;
  }

  const top1PctCutoff = Math.ceil(fieldSize * 0.01);
  const top5PctCutoff = Math.ceil(fieldSize * 0.05);
  const top10PctCutoff = Math.ceil(fieldSize * 0.10);
  const cashCutoff = Math.ceil(fieldSize * 0.20);

  // Correlation model: game/team for multi-game sports, course condition for single-event sports
  const uniqueGames = new Set(allPlayers.map(p => p.gameInfo || p.team)).size;
  const isSingleEventSport = uniqueGames <= 1;
  if (isSingleEventSport) {
    console.log(`  [Correlation] Single-event sport detected — using course condition model (std=0.10/0.06)`);
  }

  // Sim-major loop: generate outcomes once per sim, score field + candidates, discard
  for (let sim = 0; sim < maxSims; sim++) {
    const correlationFactors = isSingleEventSport
      ? generateCourseConditionFactors(allPlayers)
      : generateCorrelationFactors(allPlayers, undefined, cfg.sport);

    // Generate player outcomes (used this sim only, then discarded)
    const playerOutcomes = new Map<string, number>();
    for (const player of allPlayers) {
      playerOutcomes.set(player.id, samplePlayerOutcome(player, correlationFactors));
    }

    // Score all field lineups and sort descending
    const fieldScores = new Float64Array(fieldSampleSize);
    for (let fi = 0; fi < fieldSampleSize; fi++) {
      fieldScores[fi] = scoreFieldLineup(fieldPool[fi].playerIds, playerOutcomes, playerMap);
    }
    fieldScores.sort(); // ascending
    for (let i = 0, j = fieldScores.length - 1; i < j; i++, j--) {
      const tmp = fieldScores[i];
      fieldScores[i] = fieldScores[j];
      fieldScores[j] = tmp;
    }

    // Determine which candidates need this sim:
    // sim < tier3Sims: all candidates
    // sim < tier2Sims: tier1 + tier2
    // sim < tier1Sims: tier1 only
    const candidateEnd = sim < tier3Sims ? candidates.length
                       : sim < tier2Sims ? tier2End
                       : tier1End;

    // Score applicable candidates against this sim's field
    for (let ci = 0; ci < candidateEnd; ci++) {
      const score = scoreLineupSimulation(candidates[ci], playerOutcomes);
      const rawPosition = findFinishPosition(score, fieldScores);
      // Use Math.round instead of Math.ceil to avoid turning position 1 into 2.
      // Math.ceil(1 * 1.25) = 2, which makes P(1st) always 0 — a critical bug.
      // Math.round(1 * 1.25) = 1, preserving 1st-place detection.
      const scaledPosition = scaleFactor > 1
        ? Math.max(1, Math.round(rawPosition * scaleFactor))
        : rawPosition;

      totalPositions[ci] += scaledPosition;
      if (finishVectors[ci]) finishVectors[ci]![sim] = scaledPosition;

      if (scaledPosition === 1) firstPlaceCounts[ci]++;
      if (scaledPosition <= top1PctCutoff) top1PctCounts[ci]++;
      if (scaledPosition <= top5PctCutoff) top5PctCounts[ci]++;
      if (scaledPosition <= top10PctCutoff) top10PctCounts[ci]++;
      if (scaledPosition <= cashCutoff) cashCounts[ci]++;

      let payout = 0;
      for (const tier of payoutStructure) {
        if (scaledPosition <= tier.maxPosition) {
          payout = tier.payout;
          break;
        }
      }
      totalPayouts[ci] += payout;
    }

    if ((sim + 1) % 200 === 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      console.log(`    ${sim + 1}/${maxSims} sims (${elapsed.toFixed(1)}s, scoring ${candidateEnd} candidates)`);
    }
  }

  // Build results from accumulators
  for (let ci = 0; ci < candidates.length; ci++) {
    const lineup = candidates[ci];
    const isTier1 = ci < tier1End;
    const isTier2 = ci < tier2End;
    const numSims = isTier1 ? tier1Sims : isTier2 ? tier2Sims : tier3Sims;

    const pFirst = firstPlaceCounts[ci] / numSims;
    const pTop1Pct = top1PctCounts[ci] / numSims;
    const pTop5Pct = top5PctCounts[ci] / numSims;
    const pTop10Pct = top10PctCounts[ci] / numSims;
    const pCash = cashCounts[ci] / numSims;
    const avgPosition = totalPositions[ci] / numSims;
    const expectedPayout = totalPayouts[ci] / numSims;
    const expectedROI = ((expectedPayout - entryFee) / entryFee) * 100;

    // Top-heavy scoring: explicitly targets first-place finishes for GPP
    const simulationScore = calculateTopHeavySimScore(pFirst, pTop1Pct, pTop5Pct, expectedROI);

    results.set(lineup.hash, {
      lineupHash: lineup.hash,
      avgFinishPosition: avgPosition,
      avgFinishPercentile: avgPosition / fieldSize,
      pFirst,
      pTop1Pct,
      pTop5Pct,
      pTop10Pct,
      pCash,
      pTopN: 0, // Not tracked in tiered sim
      expectedPayout,
      expectedROI,
      winRate: pFirst,
      simulationScore,
      finishPositionVector: finishVectors[ci] || undefined,
      tier: isTier1 ? 'full' : isTier2 ? 'quick' : 'ultra',
    });
  }

  const totalTime = (Date.now() - startTime) / 1000;
  console.log(`  Tiered simulation complete: ${totalTime.toFixed(1)}s total`);
  console.log(`    Tier 1 (vectors): ${tier1End} lineups`);
  console.log(`    Tier 2 (payout):  ${tier2End - tier1End} lineups`);
  console.log(`    Tier 3 (score):   ${candidates.length - tier2End} lineups`);

  return results;
}

// ============================================================
// UNIFORM SIMULATION (all candidates × equal depth)
// ============================================================

export interface UniformSimConfig {
  numSims: number;        // Default 2000
  fieldSize: number;      // Default 10000
  entryFee: number;       // Default 20
  payoutStructure: PayoutTier[];
  sport?: string;         // Sport type for correlation model (mma uses bout-level anti-correlation)
}

const DEFAULT_UNIFORM_CONFIG: UniformSimConfig = {
  numSims: 2000,
  fieldSize: 10000,
  entryFee: 20,
  payoutStructure: [],  // Set at runtime
};

/**
 * Run uniform tournament simulation on ALL candidates at equal depth.
 *
 * Unlike simulateTiered, every candidate gets the same number of sims
 * and every candidate gets a finish position vector. This eliminates
 * the noise differential between tiers.
 *
 * Uses pre-computed payout lookup array for ~10x faster payout resolution.
 */
export function simulateUniform(
  candidates: Lineup[],
  allPlayers: Player[],
  fieldPool: FieldLineup[],
  config?: Partial<UniformSimConfig>
): Map<string, SimulationResult> {
  const cfg: UniformSimConfig = {
    ...DEFAULT_UNIFORM_CONFIG,
    ...config,
    payoutStructure: config?.payoutStructure || buildGPPPayoutStructure(
      config?.fieldSize || 10000,
      config?.entryFee || 20
    ),
  };

  const { numSims, fieldSize, entryFee, payoutStructure } = cfg;

  console.log(`  Uniform simulation: ${candidates.length.toLocaleString()} candidates × ${numSims} sims`);

  // Build player lookup
  const playerMap = new Map<string, Player>();
  for (const player of allPlayers) {
    playerMap.set(player.id, player);
  }

  const fieldSampleSize = fieldPool.length;
  const scaleFactor = fieldSize / fieldSampleSize;
  const startTime = Date.now();

  // Pre-compute payout lookup array for O(1) payout resolution
  const payoutLookup = new Float32Array(fieldSize + 2);
  for (let pos = 1; pos <= fieldSize; pos++) {
    for (const tier of payoutStructure) {
      if (pos <= tier.maxPosition) {
        payoutLookup[pos] = tier.payout;
        break;
      }
    }
  }

  const results = new Map<string, SimulationResult>();

  // Pre-allocate per-candidate accumulators
  const totalPositions = new Float64Array(candidates.length);
  const firstPlaceCounts = new Uint32Array(candidates.length);
  const top1PctCounts = new Uint32Array(candidates.length);
  const top5PctCounts = new Uint32Array(candidates.length);
  const top10PctCounts = new Uint32Array(candidates.length);
  const cashCounts = new Uint32Array(candidates.length);
  const totalPayouts = new Float64Array(candidates.length);

  // ALL candidates get finish vectors (uniform depth)
  const finishVectors: Float32Array[] = new Array(candidates.length);
  for (let ci = 0; ci < candidates.length; ci++) {
    finishVectors[ci] = new Float32Array(numSims);
  }

  const top1PctCutoff = Math.ceil(fieldSize * 0.01);
  const top5PctCutoff = Math.ceil(fieldSize * 0.05);
  const top10PctCutoff = Math.ceil(fieldSize * 0.10);
  const cashCutoff = Math.ceil(fieldSize * 0.20);

  // Correlation model: game/team for multi-game sports, course condition for single-event sports
  const uniqueGames2 = new Set(allPlayers.map(p => p.gameInfo || p.team)).size;
  const isSingleEventSport2 = uniqueGames2 <= 1;
  if (isSingleEventSport2) {
    console.log(`  [Correlation] Single-event sport — using course condition model`);
  }

  console.log(`  Running ${numSims} simulations (streaming, ${fieldSampleSize} field lineups)...`);

  // Sim-major loop
  for (let sim = 0; sim < numSims; sim++) {
    const correlationFactors = isSingleEventSport2
      ? generateCourseConditionFactors(allPlayers)
      : generateCorrelationFactors(allPlayers, undefined, cfg.sport);

    // Generate player outcomes
    const playerOutcomes = new Map<string, number>();
    for (const player of allPlayers) {
      playerOutcomes.set(player.id, samplePlayerOutcome(player, correlationFactors));
    }

    // Score all field lineups and sort descending
    const fieldScores = new Float64Array(fieldSampleSize);
    for (let fi = 0; fi < fieldSampleSize; fi++) {
      fieldScores[fi] = scoreFieldLineup(fieldPool[fi].playerIds, playerOutcomes, playerMap);
    }
    fieldScores.sort(); // ascending
    for (let i = 0, j = fieldScores.length - 1; i < j; i++, j--) {
      const tmp = fieldScores[i];
      fieldScores[i] = fieldScores[j];
      fieldScores[j] = tmp;
    }

    // Score ALL candidates (uniform — no tier boundaries)
    for (let ci = 0; ci < candidates.length; ci++) {
      const score = scoreLineupSimulation(candidates[ci], playerOutcomes);
      const rawPosition = findFinishPosition(score, fieldScores);
      // Use Math.round instead of Math.ceil to avoid turning position 1 into 2.
      const scaledPosition = scaleFactor > 1
        ? Math.max(1, Math.round(rawPosition * scaleFactor))
        : rawPosition;

      totalPositions[ci] += scaledPosition;
      finishVectors[ci][sim] = scaledPosition;

      if (scaledPosition === 1) firstPlaceCounts[ci]++;
      if (scaledPosition <= top1PctCutoff) top1PctCounts[ci]++;
      if (scaledPosition <= top5PctCutoff) top5PctCounts[ci]++;
      if (scaledPosition <= top10PctCutoff) top10PctCounts[ci]++;
      if (scaledPosition <= cashCutoff) cashCounts[ci]++;

      // Use pre-computed payout lookup (O(1) vs O(tiers) per call)
      const clampedPos = Math.min(scaledPosition, fieldSize);
      totalPayouts[ci] += payoutLookup[clampedPos];
    }

    if ((sim + 1) % 200 === 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      console.log(`    ${sim + 1}/${numSims} sims (${elapsed.toFixed(1)}s)`);
    }
  }

  // Build results
  for (let ci = 0; ci < candidates.length; ci++) {
    const lineup = candidates[ci];
    const pFirst = firstPlaceCounts[ci] / numSims;
    const pTop1Pct = top1PctCounts[ci] / numSims;
    const pTop5Pct = top5PctCounts[ci] / numSims;
    const pTop10Pct = top10PctCounts[ci] / numSims;
    const pCash = cashCounts[ci] / numSims;
    const avgPosition = totalPositions[ci] / numSims;
    const expectedPayout = totalPayouts[ci] / numSims;
    const expectedROI = ((expectedPayout - entryFee) / entryFee) * 100;

    const simulationScore = calculateTopHeavySimScore(pFirst, pTop1Pct, pTop5Pct, expectedROI);

    results.set(lineup.hash, {
      lineupHash: lineup.hash,
      avgFinishPosition: avgPosition,
      avgFinishPercentile: avgPosition / fieldSize,
      pFirst,
      pTop1Pct,
      pTop5Pct,
      pTop10Pct,
      pCash,
      pTopN: 0,
      expectedPayout,
      expectedROI,
      winRate: pFirst,
      simulationScore,
      finishPositionVector: finishVectors[ci],
      tier: 'full',
    });
  }

  const totalTime = (Date.now() - startTime) / 1000;
  console.log(`  Uniform simulation complete: ${totalTime.toFixed(1)}s total`);
  console.log(`    All ${candidates.length} candidates: ${numSims} sims each, finish vectors stored`);

  return results;
}

// ============================================================
// MULTI-FIELD SIMULATION
// ============================================================

/**
 * Multi-field environment simulation.
 *
 * Runs simulation against multiple distinct field environments (e.g., casual-heavy,
 * sharp-heavy, optimizer-saturated) to hedge against field model error.
 *
 * Each environment has its own field pool and allocated number of sims.
 * Finish vectors are concatenated across environments, producing one contiguous
 * vector per candidate that's compatible with selectByPortfolioContribution().
 *
 * Performance: 5 × 400 sims × 8K field = 16M ops vs old 2000 × 20K = 40M → ~2.5x faster.
 */
export interface MultiFieldSimResult {
  results: Map<string, SimulationResult>;
  perEnvironment: Array<{
    name: string;
    avgROI: number;
    avgPayout: number;
    simCount: number;
  }>;
  gameStateMatrix?: Float32Array;  // Flattened numSims × numGames matrix of pace factors
  gameIds?: string[];              // Game IDs corresponding to columns
}

export function simulateMultiField(
  candidates: Lineup[],
  allPlayers: Player[],
  fieldEnvironments: FieldEnvironment[],
  config?: Partial<UniformSimConfig>
): MultiFieldSimResult {
  const cfg: UniformSimConfig = {
    ...DEFAULT_UNIFORM_CONFIG,
    ...config,
    payoutStructure: config?.payoutStructure || buildGPPPayoutStructure(
      config?.fieldSize || 10000,
      config?.entryFee || 20
    ),
  };

  const { fieldSize, entryFee, payoutStructure } = cfg;

  const totalSims = fieldEnvironments.reduce((s, env) => s + env.simsPerField, 0);
  console.log(`  Multi-field simulation: ${candidates.length.toLocaleString()} candidates × ${totalSims} sims (${fieldEnvironments.length} environments)`);

  // Build player lookup
  const playerMap = new Map<string, Player>();
  for (const player of allPlayers) {
    playerMap.set(player.id, player);
  }

  // Extract unique game IDs for stratified sampling
  const gameIds: string[] = [];
  const gameIdSet = new Set<string>();
  for (const player of allPlayers) {
    const gameId = player.gameInfo || `${player.team}_game`;
    if (!gameIdSet.has(gameId)) {
      gameIdSet.add(gameId);
      gameIds.push(gameId);
    }
  }

  // Build player index map for O(1) array-based outcome lookups
  const playerIndexMap = new Map<string, number>();
  const allPlayersList: Player[] = [];
  for (const player of allPlayers) {
    if (!playerIndexMap.has(player.id)) {
      playerIndexMap.set(player.id, allPlayersList.length);
      allPlayersList.push(player);
    }
  }
  const numPlayers = allPlayersList.length;

  // Pre-convert candidate lineup players to index arrays
  const candidateIndices: Int32Array[] = new Array(candidates.length);
  const candidateFallbacks: Float64Array[] = new Array(candidates.length);
  for (let ci = 0; ci < candidates.length; ci++) {
    const players = candidates[ci].players;
    const indices = new Int32Array(players.length);
    const fallbacks = new Float64Array(players.length);
    for (let pi = 0; pi < players.length; pi++) {
      const idx = playerIndexMap.get(players[pi].id);
      indices[pi] = idx !== undefined ? idx : -1;
      fallbacks[pi] = players[pi].projection;
    }
    candidateIndices[ci] = indices;
    candidateFallbacks[ci] = fallbacks;
  }

  // Pre-compute primary combo keys for all candidates (once, used for crowding discount)
  const candidatePrimaryComboKeys: string[] = new Array(candidates.length);
  for (let ci = 0; ci < candidates.length; ci++) {
    const pc = extractPrimaryCombo(candidates[ci], playerMap, cfg.sport);
    candidatePrimaryComboKeys[ci] = pc.comboKey;
  }

  // Per-world combo crowding weight: discount payouts when field lineups share your combo
  const CROWDING_WEIGHT = 0.002;

  // Reusable Float64Array for player outcomes (avoids Map allocation per sim)
  const playerOutcomesArray = new Float64Array(numPlayers);

  // Pre-build CDF lookup tables for players with percentile data
  // ~10× faster sampling: 5 FP ops (table lerp) vs ~50 (full spline)
  const playerLookupTables: (Float32Array | null)[] = new Array(numPlayers);
  for (let pi = 0; pi < numPlayers; pi++) {
    const pcts = allPlayersList[pi].percentiles;
    playerLookupTables[pi] = (pcts && pcts.p50 > 0) ? buildCDFLookupTable(pcts) : null;
  }

  // Pre-generate stratified Z-scores for game-pace factors per environment.
  // For each game, generate stratified normals across ALL sims in that environment.
  // This guarantees uniform coverage of high/low pace scenarios, reducing variance ~30%.
  const perEnvStratifiedZ = new Map<string, Map<string, Float32Array>>();
  for (const env of fieldEnvironments) {
    const envZMap = new Map<string, Float32Array>();
    for (const gId of gameIds) {
      envZMap.set(gId, stratifiedNormals(env.simsPerField));
    }
    perEnvStratifiedZ.set(env.name, envZMap);
  }

  const startTime = Date.now();

  // Pre-compute payout lookup array for O(1) payout resolution
  const payoutLookup = new Float32Array(fieldSize + 2);
  for (let pos = 1; pos <= fieldSize; pos++) {
    for (const tier of payoutStructure) {
      if (pos <= tier.maxPosition) {
        payoutLookup[pos] = tier.payout;
        break;
      }
    }
  }

  // Pre-allocate per-candidate accumulators (across all environments)
  // Using Float64Array for all counters to support importance sampling weights
  const totalPositions = new Float64Array(candidates.length);
  const firstPlaceCounts = new Float64Array(candidates.length);
  const top1PctCounts = new Float64Array(candidates.length);
  const top5PctCounts = new Float64Array(candidates.length);
  const top10PctCounts = new Float64Array(candidates.length);
  const cashCounts = new Float64Array(candidates.length);
  const totalPayouts = new Float64Array(candidates.length);

  // Allocate one contiguous finish vector per candidate across ALL environments
  const finishVectors: Float32Array[] = new Array(candidates.length);
  for (let ci = 0; ci < candidates.length; ci++) {
    finishVectors[ci] = new Float32Array(totalSims);
  }

  const top1PctCutoff = Math.ceil(fieldSize * 0.01);
  const top5PctCutoff = Math.ceil(fieldSize * 0.05);
  const top10PctCutoff = Math.ceil(fieldSize * 0.10);

  // Track total weight sum for proper importance sampling normalization.
  // Accumulators contain weighted sums, so we must divide by sum of weights (not sim count).
  let totalWeightSum = 0;
  const cashCutoff = Math.ceil(fieldSize * 0.20);

  // Correlation model detection
  const uniqueGames = new Set(allPlayers.map(p => p.gameInfo || p.team)).size;
  const isSingleEventSport = uniqueGames <= 1;

  // Track game pace factors for each sim — used for game-world-aware scenario clustering
  const numGames = gameIds.length;
  const gameStateMatrix = new Float32Array(totalSims * numGames);

  const perEnvironment: MultiFieldSimResult['perEnvironment'] = [];
  let globalSimOffset = 0;

  for (const env of fieldEnvironments) {
    const envField = env.fieldPool;
    if (!envField || envField.length === 0) {
      console.warn(`  [MultiField] Skipping environment ${env.name}: no field pool`);
      globalSimOffset += env.simsPerField;
      continue;
    }

    const envFieldSize = envField.length;
    const scaleFactor = fieldSize / envFieldSize;
    const envStartTime = Date.now();

    // Pre-convert field lineup player IDs to index arrays (once per environment)
    const fieldIndices: Int32Array[] = new Array(envFieldSize);
    const fieldFallbacks: Float64Array[] = new Array(envFieldSize);
    for (let fi = 0; fi < envFieldSize; fi++) {
      const ids = envField[fi].playerIds;
      const indices = new Int32Array(ids.length);
      const fallbacks = new Float64Array(ids.length);
      for (let pi = 0; pi < ids.length; pi++) {
        const idx = playerIndexMap.get(ids[pi]);
        indices[pi] = idx !== undefined ? idx : -1;
        fallbacks[pi] = playerMap.get(ids[pi])?.projection || 0;
      }
      fieldIndices[fi] = indices;
      fieldFallbacks[fi] = fallbacks;
    }

    // Pre-compute primary combo for each field lineup in this environment
    const fieldPrimaryComboKeys: string[] = new Array(envFieldSize);
    for (let fi = 0; fi < envFieldSize; fi++) {
      const pc = extractPrimaryCombo(envField[fi], playerMap, cfg.sport);
      fieldPrimaryComboKeys[fi] = pc.comboKey;
    }

    // Per-environment accumulators for stats
    let envTotalPayout = 0;
    let envSimCount = 0;

    console.log(`  Running ${env.simsPerField} sims against ${env.name} (${envFieldSize.toLocaleString()} field lineups)...`);

    // Get pre-generated stratified Z-scores for this environment
    const envZScores = perEnvStratifiedZ.get(env.name);

    // Per-game importance sampling: instead of forcing ALL games high-pace (which has
    // near-zero weight with many games), dedicate sims to each game individually.
    // 1st place happens when YOUR game stack booms, not when all games boom.
    // Layout: 700 normal sims + K games × floor(300/K) per-game importance sims
    const NORMAL_SIMS = Math.floor(env.simsPerField * 0.70);
    const importanceBudget = env.simsPerField - NORMAL_SIMS;
    const numImportanceGames = gameIds.length;
    const simsPerGame = numImportanceGames > 0 ? Math.floor(importanceBudget / numImportanceGames) : 0;

    // Pre-compute per-game importance weights
    // For each per-game IS sim: force that game's Z > 1.0, other games normal.
    // P(Z > 1.0) ≈ 0.159. Fraction of sims dedicated = simsPerGame / env.simsPerField.
    // Weight = P(Z > 1.0) / fraction = 0.159 / (simsPerGame/totalSims)
    const pHighPacePerGame = 1 - normalCDF(1.0); // ≈ 0.1587
    const importanceFraction = simsPerGame / env.simsPerField;
    const perGameImportanceWeight = importanceFraction > 0
      ? pHighPacePerGame / importanceFraction  // ~2.65 for 5-game slate
      : 1.0;
    const normalFraction = NORMAL_SIMS / env.simsPerField;
    const normalSimWeight = (1 - pHighPacePerGame) / normalFraction;

    // Build per-game importance sim ranges: [NORMAL_SIMS, NORMAL_SIMS + simsPerGame) = game 0, etc.
    const gameImportanceRanges: Array<{ gameIdx: number; startSim: number; endSim: number }> = [];
    let isOffset = NORMAL_SIMS;
    for (let gi = 0; gi < numImportanceGames; gi++) {
      const sims = gi < numImportanceGames - 1 ? simsPerGame : (env.simsPerField - isOffset);
      gameImportanceRanges.push({ gameIdx: gi, startSim: isOffset, endSim: isOffset + sims });
      isOffset += sims;
    }

    console.log(`    IS layout: ${NORMAL_SIMS} normal + ${numImportanceGames} games × ~${simsPerGame} per-game (weight=${perGameImportanceWeight.toFixed(2)})`);

    // Pre-allocate uniform draws array for antithetic variates
    const playerUniforms = new Float32Array(numPlayers);
    // Track which players got DNP on even sim (for antithetic pairing)
    const playerDNP = new Uint8Array(numPlayers);
    // Store correlation factors from even sim for reuse in odd sim (true antithetic variance reduction)
    let storedCorrelationFactors: CorrelationFactors | null = null;

    for (let sim = 0; sim < env.simsPerField; sim++) {
      // Determine importance sampling context for this sim
      const isNormalSim = sim < NORMAL_SIMS;
      let importanceGameIdx = -1; // Which game is boosted (-1 = none/normal)
      let simWeight: number;
      if (isNormalSim) {
        simWeight = normalSimWeight;
      } else {
        // Find which game this importance sim belongs to
        for (const range of gameImportanceRanges) {
          if (sim >= range.startSim && sim < range.endSim) {
            importanceGameIdx = range.gameIdx;
            break;
          }
        }
        // Use per-game weight (recalculate for last game which may have extra sims)
        const range = gameImportanceRanges.find(r => sim >= r.startSim && sim < r.endSim);
        const thisGameSims = range ? (range.endSim - range.startSim) : simsPerGame;
        const thisFraction = thisGameSims / env.simsPerField;
        simWeight = thisFraction > 0 ? pHighPacePerGame / thisFraction : perGameImportanceWeight;
      }
      totalWeightSum += simWeight;
      const isOddSim = (sim & 1) === 1;  // Antithetic: odd sims use 1-U from even sims

      // Build stratified pace Z-scores for this sim from pre-generated arrays
      let stratifiedPaceZ: Map<string, number> | undefined;
      if (envZScores && !isSingleEventSport) {
        stratifiedPaceZ = new Map<string, number>();
        for (const gId of gameIds) {
          const zArr = envZScores.get(gId);
          if (zArr) {
            let z = zArr[sim];
            // Per-game importance: force THIS game's Z > 1.0, others draw normally
            if (importanceGameIdx >= 0) {
              const thisGameId = gameIds[importanceGameIdx];
              if (gId === thisGameId) {
                z = 1.0 + Math.abs(z); // Guarantee Z > 1.0 for the targeted game
              }
              // Other games keep their normal stratified Z-scores
            }
            stratifiedPaceZ.set(gId, z);
          }
        }
      }

      // Antithetic variates: share game-level correlation factors between paired sims.
      // Even sim generates fresh factors, odd sim reuses them (only player-level varies).
      let correlationFactors: CorrelationFactors;
      if (isOddSim && sim > 0 && storedCorrelationFactors) {
        // Reuse correlation factors from previous (even) sim for true variance reduction
        correlationFactors = storedCorrelationFactors;
      } else {
        correlationFactors = isSingleEventSport
          ? generateCourseConditionFactors(allPlayers)
          : generateCorrelationFactors(allPlayers, stratifiedPaceZ, cfg.sport);
        storedCorrelationFactors = correlationFactors;
      }

      // Record game pace factors for scenario clustering
      const simIdx = globalSimOffset + sim;
      for (let gi = 0; gi < numGames; gi++) {
        const paceFactor = correlationFactors.gamePaceFactors.get(gameIds[gi]) || 1.0;
        gameStateMatrix[simIdx * numGames + gi] = paceFactor;
      }

      // Generate player outcomes into reusable Float64Array
      // Uses pre-built CDF lookup tables when available (~10× faster per sample)
      // Antithetic variates: even sims generate fresh U, odd sims use 1-U (~30% variance reduction)
      for (let pi = 0; pi < numPlayers; pi++) {
        const player = allPlayersList[pi];
        const lookupTable = playerLookupTables[pi];

        if (lookupTable) {
          // Fast path: use pre-tabulated CDF lookup
          const pcts = player.percentiles!;

          // DNP modeling (same logic as samplePlayerOutcome)
          // For antithetic pairs, if even sim had DNP, odd sim should NOT (and vice versa)
          if (!isOddSim) {
            playerDNP[pi] = 0;
            if (pcts.p25 <= 0) {
              if (Math.random() < 0.15) { playerOutcomesArray[pi] = 0; playerDNP[pi] = 1; continue; }
            } else if (pcts.p25 / pcts.p50 < 0.15) {
              if (Math.random() < 0.08) { playerOutcomesArray[pi] = 0; playerDNP[pi] = 1; continue; }
            }
          } else {
            // Antithetic: if even sim was DNP, odd sim plays with p50 outcome.
            // If even sim played, odd sim also plays (no independent re-roll).
            if (playerDNP[pi]) {
              // Even sim was DNP → odd sim plays with median outcome
              playerOutcomesArray[pi] = pcts.p50;
              continue;
            }
            // Even sim played → odd sim also plays (paired antithetic)
          }

          let u: number;
          if (!isOddSim) {
            u = Math.random();
            playerUniforms[pi] = u;
          } else {
            u = 1.0 - playerUniforms[pi];  // Antithetic: mirror the uniform draw
          }
          let baseOutcome = sampleFromLookupTable(lookupTable, u);

          // Apply correlation factors (inlined from samplePlayerOutcome)
          if (correlationFactors) {
            const gameId = player.gameInfo || `${player.team}_game`;
            const paceFactor = correlationFactors.gamePaceFactors.get(gameId) || 1.0;
            const scriptFactor = correlationFactors.gameScriptFactors.get(gameId) || 0.0;
            const sides = correlationFactors.gameTeamSides.get(gameId);
            const teamFactor = correlationFactors.teamFactors.get(player.team) || 1.0;
            const scriptSign = sides ? (player.team === sides.teamA ? 1 : -1) : 0;
            const gameFactor = paceFactor + scriptSign * scriptFactor;
            const combinedFactor = gameFactor * teamFactor;

            const salaryRatio = player.salary / 8000;
            const gameLoading = 0.85 + 0.30 * Math.min(1, Math.max(0, (salaryRatio - 0.75) / 0.50));
            const minutesFactor = player.minutes
              ? Math.min(1.2, Math.max(0.7, player.minutes / 30))
              : 1.0;

            let playerVolatility = 1.0;
            if (pcts.p75 > 0 && pcts.p25 > 0) {
              const iqr = pcts.p75 - pcts.p25;
              const sd = iqr / 1.35;
              const cv = sd / Math.max(1, player.projection);
              playerVolatility = Math.min(1.5, Math.max(0.5, cv / 0.30));
            }

            const deviation = baseOutcome - player.projection;
            const effectiveLoading = gameLoading * minutesFactor;
            const sharedShift = (combinedFactor - 1.0) * player.projection * effectiveLoading * 0.7;
            const varianceScale = 1.0 + (combinedFactor - 1.0) * effectiveLoading * 0.3;
            baseOutcome = (player.projection + sharedShift) + deviation * varianceScale * playerVolatility;
          }

          playerOutcomesArray[pi] = Math.max(0, baseOutcome);
        } else {
          // Slow path: full samplePlayerOutcome (no percentile data)
          playerOutcomesArray[pi] = samplePlayerOutcome(player, correlationFactors);
        }
      }

      // Ownership miscue scenarios (10% of sims): perturb outcomes based on ownership surprise
      // Models worlds where projected ownership was wrong — high-owned bust harder, low-owned boom harder
      const isOwnershipMiscueSim = sim % 10 === 0;
      if (isOwnershipMiscueSim) {
        for (let pi = 0; pi < numPlayers; pi++) {
          const player = allPlayersList[pi];
          const currentOutcome = playerOutcomesArray[pi];
          if (!currentOutcome) continue;

          const ownPct = player.ownership / 100;
          const surprise = (Math.random() - 0.5) * 2;  // -1 to 1

          if (ownPct > 0.20) {
            // High-owned: amplify the outcome swing (field conviction = larger variance)
            playerOutcomesArray[pi] = Math.max(0, currentOutcome * (1 + surprise * 0.15));
          } else if (ownPct < 0.08) {
            // Low-owned: occasionally boom (hidden upside the field missed)
            if (surprise > 0.3) {
              playerOutcomesArray[pi] = currentOutcome * (1 + surprise * 0.25);
            }
          }
        }
      }

      // Score all field lineups using indexed arrays
      const fieldScores = new Float64Array(envFieldSize);
      for (let fi = 0; fi < envFieldSize; fi++) {
        fieldScores[fi] = scoreFieldLineupIndexed(fieldIndices[fi], playerOutcomesArray, fieldFallbacks[fi]);
      }

      // --- Per-world combo crowding ---
      // Before sorting (which loses index mapping), find the top-5% score threshold
      // and build a map of combo → count for top-scoring field lineups.
      // This tells us: "when a combo booms in this world, how many field entries share it?"
      const crowdingTop5Cutoff = Math.ceil(envFieldSize * 0.05);
      // Find top-5% threshold via partial scan (cheaper than full sort for threshold only)
      let crowdingThreshold = 0;
      {
        // Quick nth-element approximation: sort a copy to find threshold
        const sortedCopy = new Float64Array(envFieldSize);
        sortedCopy.set(fieldScores);
        sortedCopy.sort();
        crowdingThreshold = sortedCopy[envFieldSize - crowdingTop5Cutoff];
      }

      // Build combo→count map for field lineups scoring in top 5%
      const worldComboCrowding = new Map<string, number>();
      for (let fi = 0; fi < envFieldSize; fi++) {
        if (fieldScores[fi] >= crowdingThreshold) {
          const ck = fieldPrimaryComboKeys[fi];
          if (ck) worldComboCrowding.set(ck, (worldComboCrowding.get(ck) || 0) + 1);
        }
      }

      // Now sort field scores descending for finish position binary search
      fieldScores.sort(); // ascending
      for (let i = 0, j = fieldScores.length - 1; i < j; i++, j--) {
        const tmp = fieldScores[i];
        fieldScores[i] = fieldScores[j];
        fieldScores[j] = tmp;
      }

      // Score ALL candidates with importance-weighted accumulators (indexed)
      for (let ci = 0; ci < candidates.length; ci++) {
        const score = scoreLineupSimulationIndexed(candidateIndices[ci], playerOutcomesArray, candidateFallbacks[ci]);
        const rawPosition = findFinishPosition(score, fieldScores);
        // Use Math.round instead of Math.ceil to avoid turning position 1 into 2.
        const scaledPosition = scaleFactor > 1
          ? Math.max(1, Math.round(rawPosition * scaleFactor))
          : rawPosition;

        totalPositions[ci] += scaledPosition * simWeight;
        finishVectors[ci][globalSimOffset + sim] = scaledPosition;

        if (scaledPosition === 1) firstPlaceCounts[ci] += simWeight;
        if (scaledPosition <= top1PctCutoff) top1PctCounts[ci] += simWeight;
        if (scaledPosition <= top5PctCutoff) top5PctCounts[ci] += simWeight;
        if (scaledPosition <= top10PctCutoff) top10PctCounts[ci] += simWeight;
        if (scaledPosition <= cashCutoff) cashCounts[ci] += simWeight;

        const clampedPos = Math.min(scaledPosition, fieldSize);
        const rawPayout = payoutLookup[clampedPos];

        // Combo crowding discount: when this candidate finishes top-5% AND shares
        // a primary combo with many field lineups that ALSO score top-5%, discount
        // the payout. This models prize splitting — when your combo booms, you're
        // competing with all field entries that have the same combo.
        let adjustedPayout = rawPayout;
        if (rawPayout > 0 && scaledPosition <= top5PctCutoff) {
          const comboKey = candidatePrimaryComboKeys[ci];
          const fieldComboCount = comboKey ? (worldComboCrowding.get(comboKey) || 0) : 0;
          if (fieldComboCount > 0) {
            const scaledCrowding = fieldComboCount * scaleFactor;
            adjustedPayout = rawPayout / (1 + scaledCrowding * CROWDING_WEIGHT);
          }
        }
        totalPayouts[ci] += adjustedPayout * simWeight;
      }

      envSimCount++;
    }

    // Compute per-environment stats
    let envAvgPayout = 0;
    for (let ci = 0; ci < candidates.length; ci++) {
      let envPayout = 0;
      for (let s = 0; s < env.simsPerField; s++) {
        const pos = finishVectors[ci][globalSimOffset + s];
        envPayout += payoutLookup[Math.min(pos, fieldSize)];
      }
      envAvgPayout += envPayout / env.simsPerField;
    }
    envAvgPayout /= candidates.length;
    const envAvgROI = ((envAvgPayout - entryFee) / entryFee) * 100;

    const envTime = (Date.now() - envStartTime) / 1000;
    console.log(`    ${env.name}: ${envTime.toFixed(1)}s, avg payout $${envAvgPayout.toFixed(2)}, avg ROI ${envAvgROI.toFixed(1)}%`);

    perEnvironment.push({
      name: env.name,
      avgROI: envAvgROI,
      avgPayout: envAvgPayout,
      simCount: envSimCount,
    });

    globalSimOffset += env.simsPerField;
  }

  // Build results from accumulated stats.
  // Use totalWeightSum (sum of importance sampling weights) instead of totalSims (raw count)
  // because accumulators contain weighted sums. Dividing by raw count inflates probabilities.
  const weightDivisor = totalWeightSum > 0 ? totalWeightSum : totalSims;
  const results = new Map<string, SimulationResult>();
  for (let ci = 0; ci < candidates.length; ci++) {
    const lineup = candidates[ci];
    const pFirst = firstPlaceCounts[ci] / weightDivisor;
    const pTop1Pct = top1PctCounts[ci] / weightDivisor;
    const pTop5Pct = top5PctCounts[ci] / weightDivisor;
    const pTop10Pct = top10PctCounts[ci] / weightDivisor;
    const pCash = cashCounts[ci] / weightDivisor;
    const avgPosition = totalPositions[ci] / weightDivisor;
    const expectedPayout = totalPayouts[ci] / weightDivisor;
    const expectedROI = ((expectedPayout - entryFee) / entryFee) * 100;

    const simulationScore = calculateTopHeavySimScore(pFirst, pTop1Pct, pTop5Pct, expectedROI);

    results.set(lineup.hash, {
      lineupHash: lineup.hash,
      avgFinishPosition: avgPosition,
      avgFinishPercentile: avgPosition / fieldSize,
      pFirst,
      pTop1Pct,
      pTop5Pct,
      pTop10Pct,
      pCash,
      pTopN: 0,
      expectedPayout,
      expectedROI,
      winRate: pFirst,
      simulationScore,
      finishPositionVector: finishVectors[ci],
      tier: 'full',
    });
  }

  const totalTime = (Date.now() - startTime) / 1000;
  console.log(`  Multi-field simulation complete: ${totalTime.toFixed(1)}s total`);
  console.log(`    ${candidates.length} candidates × ${totalSims} sims across ${fieldEnvironments.length} environments`);

  return { results, perEnvironment, gameStateMatrix, gameIds };
}

// ============================================================
// MAIN SIMULATION (Legacy - kept for backward compatibility)
// ============================================================

/**
 * Run tournament simulation for a set of lineups
 * Uses pre-generated field pool for more realistic competition modeling
 */
export function simulateTournaments(
  lineups: Lineup[],
  allPlayers: Player[],
  config: Partial<SimulationConfig> = {},
  fieldPool?: FieldLineup[]
): Map<string, SimulationResult> {
  const {
    numSimulations = 2000,      // Increased from 1000
    fieldSize = 10000,
    entryFee = 20,
    payoutStructure = DEFAULT_PAYOUT_STRUCTURE,
    topNPositions = 5000,
  } = config;

  const results = new Map<string, SimulationResult>();
  const rosterSize = lineups[0]?.players.length || 8;

  // Build player lookup map
  const playerMap = new Map<string, Player>();
  for (const player of allPlayers) {
    playerMap.set(player.id, player);
  }

  // Pre-generate field pool - use FULL field size for accuracy
  // No more scaling - generate as many lineups as the actual contest
  const fieldSampleSize = Math.min(10000, fieldSize);  // Increased from 500
  const field = fieldPool ?? (() => {
    console.log(`  Generating ${fieldSampleSize} field lineups...`);
    return generateFieldPool(allPlayers, rosterSize, fieldSampleSize);
  })();
  if (fieldPool) {
    console.log(`  Reusing pre-generated field pool (${fieldPool.length} lineups)`);
  }
  // Log field composition (supports both legacy and expanded archetypes)
  const archetypeCounts = new Map<string, number>();
  for (const fl of field) {
    archetypeCounts.set(fl.archetype, (archetypeCounts.get(fl.archetype) || 0) + 1);
  }
  const compositionStr = [...archetypeCounts.entries()]
    .map(([a, c]) => `${c} ${a}`)
    .join(', ');
  console.log(`  Field composition: ${compositionStr}`);

  // Validate field calibration and warn if poor
  const calibration = validateFieldCalibration(field, allPlayers);
  if (calibration.isPoor) {
    console.warn(`\n  ╔══════════════════════════════════════════════════════════════════╗`);
    console.warn(`  ║  WARNING: POOR FIELD CALIBRATION (MAE=${calibration.meanAbsError.toFixed(1)}%)                      ║`);
    console.warn(`  ╠══════════════════════════════════════════════════════════════════╣`);
    console.warn(`  ║  Simulation results may be unreliable!                           ║`);
    console.warn(`  ║  Field player exposures don't match projected ownership.         ║`);
    console.warn(`  ║                                                                  ║`);
    console.warn(`  ║  Recommended archetype ratios to improve calibration:            ║`);
    console.warn(`  ║    Chalk:      ${(calibration.recommendedChalkRatio * 100).toFixed(0)}% (current: 70%)                            ║`);
    console.warn(`  ║    Balanced:   ${(calibration.recommendedBalancedRatio * 100).toFixed(0)}% (current: 20%)                            ║`);
    console.warn(`  ║    Contrarian: ${(calibration.recommendedContrarianRatio * 100).toFixed(0)}% (current: 10%)                             ║`);
    console.warn(`  ╚══════════════════════════════════════════════════════════════════╝\n`);
  }

  // Initialize result tracking
  for (const lineup of lineups) {
    results.set(lineup.hash, {
      lineupHash: lineup.hash,
      avgFinishPosition: 0,
      avgFinishPercentile: 0,
      pFirst: 0,
      pTop1Pct: 0,
      pTop5Pct: 0,
      pTop10Pct: 0,
      pCash: 0,
      pTopN: 0,
      expectedPayout: 0,
      expectedROI: 0,
      winRate: 0,
      simulationScore: 0,
    });
  }

  // Track cumulative results
  const finishPositions = new Map<string, number[]>();
  const payouts = new Map<string, number[]>();
  const wins = new Map<string, number>();

  for (const lineup of lineups) {
    finishPositions.set(lineup.hash, []);
    payouts.set(lineup.hash, []);
    wins.set(lineup.hash, 0);
  }

  // Run simulations
  console.log(`  Running ${numSimulations} tournament simulations...`);
  console.log(`  (Using correlated player outcomes for realistic game modeling)`);
  const startTime = Date.now();

  // Correlation model: game/team for multi-game sports, course condition for single-event sports
  const uniqueGames3 = new Set(allPlayers.map(p => p.gameInfo || p.team)).size;
  const isSingleEventSport3 = uniqueGames3 <= 1;

  for (let sim = 0; sim < numSimulations; sim++) {
    // Generate correlation factors for this simulation
    const correlationFactors = isSingleEventSport3
      ? generateCourseConditionFactors(allPlayers)
      : generateCorrelationFactors(allPlayers);

    // Generate player outcomes using correlated sampling
    const playerOutcomes = new Map<string, number>();
    for (const player of allPlayers) {
      playerOutcomes.set(player.id, samplePlayerOutcome(player, correlationFactors));
    }

    // Score all our lineups
    const ourScores: Array<{ hash: string; score: number }> = [];
    for (const lineup of lineups) {
      const score = scoreLineupSimulation(lineup, playerOutcomes);
      ourScores.push({ hash: lineup.hash, score });
    }

    // Score field lineups
    const fieldScores: number[] = [];
    for (const fieldLineup of field) {
      const score = scoreFieldLineup(fieldLineup.playerIds, playerOutcomes, playerMap);
      fieldScores.push(score);
    }
    fieldScores.sort((a, b) => b - a);

    // Calculate finish position for each of our lineups
    for (const { hash, score } of ourScores) {
      // Binary search for finish position in sorted field scores
      const position = findFinishPosition(score, fieldScores);

      // Scale position to full field size (if field sample < actual field)
      // With 10K field lineups, scaling is minimal or none
      const scaleFactor = fieldSize / fieldSampleSize;
      const scaledPosition = scaleFactor > 1 
        ? Math.ceil(position * scaleFactor)
        : position;
      finishPositions.get(hash)!.push(scaledPosition);

      // Calculate payout
      let payout = 0;
      for (const tier of payoutStructure) {
        if (scaledPosition <= tier.maxPosition) {
          payout = tier.payout;
          break;
        }
      }
      payouts.get(hash)!.push(payout);

      // Track wins
      if (scaledPosition === 1) {
        wins.set(hash, (wins.get(hash) || 0) + 1);
      }
    }

    // Progress update
    if ((sim + 1) % 200 === 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = (sim + 1) / elapsed;
      console.log(`    ${sim + 1}/${numSimulations} sims (${rate.toFixed(0)}/sec)`);
    }
  }

  const totalTime = (Date.now() - startTime) / 1000;
  console.log(`  Simulation complete in ${totalTime.toFixed(1)}s`);

  // Calculate final results
  for (const lineup of lineups) {
    const positions = finishPositions.get(lineup.hash)!;
    const lineupPayouts = payouts.get(lineup.hash)!;
    const lineupWins = wins.get(lineup.hash) || 0;

    const avgPosition = positions.reduce((a, b) => a + b, 0) / positions.length;
    const avgPercentile = avgPosition / fieldSize;

    const pFirst = lineupWins / numSimulations;
    const pTop1Pct = positions.filter(p => p <= fieldSize * 0.01).length / numSimulations;
    const pTop5Pct = positions.filter(p => p <= fieldSize * 0.05).length / numSimulations;
    const pTop10Pct = positions.filter(p => p <= fieldSize * 0.10).length / numSimulations;
    const pCash = positions.filter(p => p <= fieldSize * 0.20).length / numSimulations;
    const pTopN = positions.filter(p => p <= topNPositions).length / numSimulations;

    const expectedPayout = lineupPayouts.reduce((a, b) => a + b, 0) / numSimulations;
    const expectedROI = ((expectedPayout - entryFee) / entryFee) * 100;

    // Top-heavy scoring: explicitly targets first-place finishes for GPP
    const simulationScore = calculateTopHeavySimScore(pFirst, pTop1Pct, pTop5Pct, expectedROI);

    results.set(lineup.hash, {
      lineupHash: lineup.hash,
      avgFinishPosition: avgPosition,
      avgFinishPercentile: avgPercentile,
      pFirst,
      pTop1Pct,
      pTop5Pct,
      pTop10Pct,
      pCash,
      pTopN,
      expectedPayout,
      expectedROI,
      winRate: pFirst,
      simulationScore,
      finishPositionVector: positions,
    });
  }

  return results;
}

/**
 * Quick simulation score for a single lineup.
 * Used during selection when full simulation is too slow.
 *
 * Compares against a proper field pool (2K lineups by default, position-aware,
 * salary-cap-respecting) across 200 Monte Carlo sims.
 *
 * FIELD SIZE CONSISTENCY (Issue #4):
 * - Default: 2K field (increased from 1K for better accuracy)
 * - Full sim: 10K field
 * - For best consistency, pass a pre-generated `fieldPool` parameter
 *   that matches the field pool used in full simulation
 *
 * When fieldPool is provided, the function uses that pool directly,
 * ensuring consistency with full simulation results.
 *
 * @param lineup - The lineup to score
 * @param allPlayers - All available players
 * @param numSims - Number of Monte Carlo simulations (default: 200)
 * @param fieldPool - Pre-generated field pool for consistency (recommended)
 * @param fieldSize - Field size to generate if no fieldPool provided (default: 2000)
 */
export function quickSimulationScore(
  lineup: Lineup,
  allPlayers: Player[],
  numSims: number = 200,
  fieldPool?: FieldLineup[],
  fieldSize: number = 2000
): number {
  const rosterSize = lineup.players.length;

  // Build player lookup once
  const playerMap = new Map<string, Player>();
  for (const player of allPlayers) {
    playerMap.set(player.id, player);
  }

  // Generate field pool once and reuse across all sims
  const field = fieldPool ?? generateFieldPool(allPlayers, rosterSize, fieldSize);
  const actualFieldSize = field.length;

  // Running counters
  let totalPosition = 0;
  let firstPlaceCount = 0;
  let top1PctCount = 0;
  let top5PctCount = 0;
  let top10PctCount = 0;

  const top1PctCutoff = Math.ceil(actualFieldSize * 0.01);
  const top5PctCutoff = Math.ceil(actualFieldSize * 0.05);
  const top10PctCutoff = Math.ceil(actualFieldSize * 0.10);

  // Correlation model: game/team for multi-game sports, course condition for single-event sports
  const uniqueGames4 = new Set(allPlayers.map(p => p.gameInfo || p.team)).size;
  const isSingleEventSport4 = uniqueGames4 <= 1;

  for (let sim = 0; sim < numSims; sim++) {
    // Generate correlation factors for this sim
    const correlationFactors = isSingleEventSport4
      ? generateCourseConditionFactors(allPlayers)
      : generateCorrelationFactors(allPlayers);

    // Generate player outcomes with correlation
    const playerOutcomes = new Map<string, number>();
    for (const player of allPlayers) {
      playerOutcomes.set(player.id, samplePlayerOutcome(player, correlationFactors));
    }

    // Score our lineup
    const ourScore = scoreLineupSimulation(lineup, playerOutcomes);

    // Score every field lineup and count how many beat us
    let betterCount = 0;
    for (const fieldLineup of field) {
      const fieldScore = scoreFieldLineup(fieldLineup.playerIds, playerOutcomes, playerMap);
      if (fieldScore > ourScore) betterCount++;
    }

    const position = betterCount + 1; // 1-indexed finish
    totalPosition += position;
    if (position === 1) firstPlaceCount++;
    if (position <= top1PctCutoff) top1PctCount++;
    if (position <= top5PctCutoff) top5PctCount++;
    if (position <= top10PctCutoff) top10PctCount++;
  }

  // Derive probabilities
  const pFirst = firstPlaceCount / numSims;
  const pTop1Pct = top1PctCount / numSims;
  const pTop5Pct = top5PctCount / numSims;
  const pTop10Pct = top10PctCount / numSims;
  const avgPercentile = 1 - (totalPosition / numSims / actualFieldSize); // 0-1, higher = better

  // ROI-based scoring (consistent with tiered simulation formula)
  // Estimate expected payout from finish probabilities and apply same ROI mapping
  const estimatedEntryFee = 20;
  const estimatedPrizePool = actualFieldSize * estimatedEntryFee * 0.85;
  const estimatedPayout =
    pFirst * estimatedPrizePool * 0.29 +
    (pTop1Pct - pFirst) * estimatedPrizePool * 0.001 +
    (pTop5Pct - pTop1Pct) * estimatedPrizePool * 0.0002 +
    (pTop10Pct - pTop5Pct) * estimatedPrizePool * 0.00015;
  const estimatedROI = ((estimatedPayout - estimatedEntryFee) / estimatedEntryFee) * 100;

  // Maps: -100% ROI → 0.0, 0% ROI → 0.2, +150% ROI → 0.5, +400% ROI → 1.0
  return Math.min(1, Math.max(0, (estimatedROI + 100) / 500));
}

// ============================================================
// PORTFOLIO-LEVEL SIMULATION
// ============================================================

export interface PortfolioSimResult {
  /** P(at least one lineup finishes 1st) */
  portfolioWinRate: number;
  /** P(at least one lineup finishes top 1%) */
  portfolioTop1PctRate: number;
  /** P(at least one lineup finishes top 5%) */
  portfolioTop5PctRate: number;
  /** Portfolio ROI: (avg total payout - total cost) / total cost */
  portfolioExpectedROI: number;
  /** Average best finish position across sims */
  avgBestFinish: number;
  /** Per-lineup: fraction of sims where this lineup was the portfolio's best finisher AND placed 1st */
  lineupMarginalWins: Map<string, number>;
  /** How many distinct lineups contributed at least one 1st-place finish */
  uniqueWinningLineups: number;
}

/**
 * Simulate an entire portfolio of lineups against a realistic field.
 *
 * Unlike per-lineup simulation, this answers portfolio-level questions:
 * - "How often does ANY of my lineups take 1st?"
 * - "Which lineups contribute unique wins?"
 * - "What's my total portfolio ROI?"
 *
 * Two lineups that both win in the same scenario are redundant —
 * this identifies which lineups add marginal value to the portfolio.
 */
export function simulatePortfolio(
  lineups: Lineup[],
  allPlayers: Player[],
  config: {
    numSimulations?: number;
    fieldSize?: number;
    entryFee?: number;
    payoutStructure?: PayoutTier[];
  } = {},
  fieldPool?: FieldLineup[]
): PortfolioSimResult {
  const {
    // Increased from 500 to 1000 for better statistical confidence
    // At 500 sims, a portfolio with 10% win rate has 95% CI of 7.4%-12.6% (too wide)
    // At 1000 sims, 95% CI narrows to ~8.1%-11.9%
    numSimulations = 1000,
    fieldSize = 10000,
    entryFee = 20,
    payoutStructure = DEFAULT_PAYOUT_STRUCTURE,
  } = config;

  const rosterSize = lineups[0]?.players.length || 8;

  // Build player lookup
  const playerMap = new Map<string, Player>();
  for (const player of allPlayers) {
    playerMap.set(player.id, player);
  }

  // Generate or reuse field pool
  const field = fieldPool ?? generateFieldPool(allPlayers, rosterSize, Math.min(10000, fieldSize));
  const actualFieldSize = field.length;

  console.log(`  Portfolio sim: ${lineups.length.toLocaleString()} lineups × ${numSimulations} sims vs ${actualFieldSize.toLocaleString()} field`);

  // Portfolio-level tracking
  let portfolioWins = 0;
  let portfolioTop1Pct = 0;
  let portfolioTop5Pct = 0;
  let totalPortfolioPayout = 0;
  let totalBestFinish = 0;
  const lineupWinCounts = new Map<string, number>();

  const top1PctCutoff = Math.ceil(actualFieldSize * 0.01);
  const top5PctCutoff = Math.ceil(actualFieldSize * 0.05);

  const startTime = Date.now();

  // Correlation model: game/team for multi-game sports, course condition for single-event sports
  const uniqueGames5 = new Set(allPlayers.map(p => p.gameInfo || p.team)).size;
  const isSingleEventSport5 = uniqueGames5 <= 1;

  for (let sim = 0; sim < numSimulations; sim++) {
    // Generate correlation factors for this sim
    const correlationFactors = isSingleEventSport5
      ? generateCourseConditionFactors(allPlayers)
      : generateCorrelationFactors(allPlayers);

    // Generate player outcomes with correlation
    const playerOutcomes = new Map<string, number>();
    for (const player of allPlayers) {
      playerOutcomes.set(player.id, samplePlayerOutcome(player, correlationFactors));
    }

    // Score all field lineups and sort descending
    const fieldScores = new Array<number>(field.length);
    for (let i = 0; i < field.length; i++) {
      fieldScores[i] = scoreFieldLineup(field[i].playerIds, playerOutcomes, playerMap);
    }
    fieldScores.sort((a, b) => b - a);

    // Score every lineup in our portfolio, find each one's finish position
    let bestPosition = Infinity;
    let bestHash = '';
    let simPayout = 0;

    for (const lineup of lineups) {
      const score = scoreLineupSimulation(lineup, playerOutcomes);

      // Binary search for finish position in sorted field scores
      let lo = 0;
      let hi = fieldScores.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (fieldScores[mid] > score) lo = mid + 1;
        else hi = mid;
      }
      const position = lo + 1;

      // Payout for this lineup entry
      let payout = 0;
      for (const tier of payoutStructure) {
        if (position <= tier.maxPosition) {
          payout = tier.payout;
          break;
        }
      }
      simPayout += payout;

      // Track best finish across portfolio
      if (position < bestPosition) {
        bestPosition = position;
        bestHash = lineup.hash;
      }
    }

    // Portfolio-level results for this sim
    totalBestFinish += bestPosition;
    totalPortfolioPayout += simPayout;

    if (bestPosition === 1) {
      portfolioWins++;
      // Credit the lineup that got 1st
      lineupWinCounts.set(bestHash, (lineupWinCounts.get(bestHash) || 0) + 1);
    }
    if (bestPosition <= top1PctCutoff) portfolioTop1Pct++;
    if (bestPosition <= top5PctCutoff) portfolioTop5Pct++;

    // Progress
    if ((sim + 1) % 100 === 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = ((sim + 1) / elapsed).toFixed(0);
      console.log(`    ${sim + 1}/${numSimulations} sims (${rate}/sec)`);
    }
  }

  const totalTime = (Date.now() - startTime) / 1000;

  // Portfolio metrics
  const costPerSim = lineups.length * entryFee;
  const avgPayout = totalPortfolioPayout / numSimulations;
  const portfolioROI = ((avgPayout - costPerSim) / costPerSim) * 100;

  // Per-lineup marginal win rates
  const marginalWins = new Map<string, number>();
  for (const [hash, count] of lineupWinCounts) {
    marginalWins.set(hash, count / numSimulations);
  }

  console.log(`  Portfolio simulation complete in ${totalTime.toFixed(1)}s`);

  return {
    portfolioWinRate: portfolioWins / numSimulations,
    portfolioTop1PctRate: portfolioTop1Pct / numSimulations,
    portfolioTop5PctRate: portfolioTop5Pct / numSimulations,
    portfolioExpectedROI: portfolioROI,
    avgBestFinish: totalBestFinish / numSimulations,
    lineupMarginalWins: marginalWins,
    uniqueWinningLineups: lineupWinCounts.size,
  };
}
