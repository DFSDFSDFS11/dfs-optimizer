/**
 * DFS Optimizer CLI - Type Definitions
 *
 * Core type definitions for the optimizer including players, lineups,
 * contest configurations, and algorithm parameters.
 */

// ============================================================
// SITE AND CONTEST TYPES
// ============================================================

export type DFSSite = 'dk' | 'fd';
export type Sport = 'nba' | 'nfl' | 'mlb' | 'mma' | 'nascar' | 'golf';
export type ContestType = 'classic' | 'showdown';

/**
 * Complete contest configuration defining all rules and constraints
 */
export interface ContestConfig {
  site: DFSSite;
  sport: Sport;
  contestType: ContestType;
  salaryCap: number;
  salaryMin: number;
  rosterSize: number;
  positions: PositionSlot[];
  name: string;
  maxPlayersPerTeam?: number;  // DK/FD limit to 4 players per team
  minGames?: number;           // Minimum number of different games required (DK requires 2)
}

/**
 * A position slot in a lineup with eligible positions
 */
export interface PositionSlot {
  name: string;           // Display name (PG, G, UTIL, CPT, etc.)
  eligible: string[];     // Positions that can fill this slot
  isCaptain?: boolean;    // For showdown captain slot
}

// ============================================================
// PLAYER TYPES
// ============================================================

/**
 * SaberSim percentile distribution data.
 * 6 points on each player's outcome CDF for empirical sampling.
 */
export interface PlayerPercentiles {
  p25: number;
  p50: number;
  p75: number;
  p85: number;
  p95: number;
  p99: number;
}

/**
 * Raw player data as parsed from CSV
 */
export interface RawPlayer {
  id: string;
  name: string;
  position: string;
  team: string;
  salary: number;
  projection: number;
  ownership: number;
  ceiling: number;        // 85th percentile outcome (upside)
  ceiling99: number;      // 99th percentile outcome (boom ceiling for GPP)
  gameTotal: number;      // Vegas game total (scoring environment)
  stdDev?: number;         // Standard deviation of projection
  minutes?: number;        // Projected minutes
  teamTotal?: number;      // Team implied total from Vegas
  gameInfo?: string;      // Game identifier (e.g., "LAL@DEN") for minGames constraint
  opponent?: string;      // Opponent team for game identification
  isCaptain?: boolean;
  percentiles?: PlayerPercentiles;  // Full distribution from SaberSim
}

/**
 * Processed player ready for optimization
 */
export interface Player extends RawPlayer {
  index: number;          // Unique index for bit operations
  positions: string[];    // Parsed position array
  value: number;          // Points per $1000 salary
}

/**
 * Player pool with lookup maps
 */
export interface PlayerPool {
  players: Player[];
  byId: Map<string, Player>;
  byPosition: Map<string, Player[]>;
  byTeam: Map<string, Player[]>;
}

// ============================================================
// LINEUP TYPES
// ============================================================

/**
 * A complete DFS lineup
 */
export interface Lineup {
  players: Player[];
  salary: number;
  projection: number;
  ownership: number;
  hash: string;
  constructionMethod?: string;  // 'projection' | 'field-mimic' | 'leverage' | 'balanced' | 'contrarian' | 'game-stack'
}

/**
 * Lineup with selection scores
 */
export interface ScoredLineup extends Lineup {
  rank: number;
  projectionScore: number;      // 0-1 normalized projection
  leverageScore: number;        // 0-1 uniqueness vs field
  ownershipScore: number;       // 0-1 (lower ownership = higher score)
  diversityScore: number;       // 0-1 uniqueness vs selected
  totalScore: number;           // Combined overall score
  overallRank: number;          // Rank by total score
  ceilingScore?: number;        // 0-1 lineup boom potential (stored for archetype sorting)
  // Blended sim+heuristic scoring fields
  simROI?: number;              // 0-1 normalized expected ROI across all environments
  simUpside?: number;           // P(top 5%) — GPP-relevant upside
  simBoomBust?: number;          // ratio of top-5% finishes to dead-zone finishes (GPP-aligned)
  simFirst?: number;            // 0-1 normalized P(1st place) — primary GPP metric
  heuristicScore?: number;      // Pre-blend totalScore preserved for portfolio greedy
  chalkPenaltyPct?: number;     // Chalk combo penalty (0-0.50), applied post-sim as multiplier
  uniqueCoreBonusPct?: number;  // Unique core bonus (0-0.25), applied post-sim as multiplier
  fieldOverlapSeverity?: number;   // 0-1 how field-like this lineup is
  fieldMaxOverlap?: number;        // max players shared with any field lineup
  fieldNearDupRate?: number;       // fraction of field within rosterSize-2 overlap
  relativeValueScore2?: number;    // 0-1 relative value vs optimal (for pre-filter quotas)
  projectionEdgeScore2?: number;   // 0-1 our proj vs field-implied (for pre-filter quotas)
  varianceScore?: number;          // 0-1 boom potential (for archetype scoring & pre-filter)
}

// ============================================================
// OPTIMIZATION TYPES
// ============================================================

/**
 * Parameters for optimization phase
 */
export interface OptimizationParams {
  config: ContestConfig;
  pool: PlayerPool;
  poolSize: number;
  minSalary?: number;
  backtestFast?: boolean;
}

/**
 * Result of optimization phase
 */
export interface OptimizationResult {
  lineups: Lineup[];
  maxProjection: number;
  optimalLineup: Lineup;
  generationTimeMs: number;
  evaluatedCount: number;
}

// ============================================================
// SELECTION TYPES
// ============================================================

/**
 * Parameters for selection phase
 */
export interface SelectionParams {
  lineups: Lineup[];
  targetCount: number;
  maxExposure: number;
  projectionWeight: number;
  leverageWeight: number;
  ownershipWeight: number;
  diversityWeight: number;
  maxPlayersPerTeam?: number;  // FanDuel: 4, DraftKings: unlimited
  salaryCap?: number;          // Contest salary cap (DK: 50000, FD: 60000)
  numGames?: number;           // Number of distinct games on slate
  simMode?: SimMode;           // 'uniform' (default) or 'tiered' (legacy)
  contestSize?: ContestSize;   // Contest size for field composition (default '20max')
  sport?: string;              // Sport type (nba, nfl, mma, golf, nascar) for correlation model
  skipChalkPenalty?: boolean;   // A/B test: skip chalk penalty multiplier
  selectionConfig?: SelectionConfig;  // Override selection parameters for sweep testing
}

/**
 * Configurable selection parameters for parameter sweeps.
 * All fields optional — when absent, selector uses its defaults.
 */
export interface SelectionConfig {
  projFloorPct?: number;       // Override projection floor (e.g. 0.90)
  ownMarginBoost?: number;     // Added to base Pareto ownership margin
  maxExposure?: number;        // Override exposure cap (e.g. 0.75)
  diversityBase?: number;      // Override diversity base threshold
  diversityFreePass?: number;  // Override free-pass ratio
}

/**
 * Metrics data for a single lineup (for detailed export)
 * 
 * NOTE: Only includes metrics that are actually calculated.
 * Removed 100+ theoretical metrics that were never implemented.
 */
export interface LineupMetricsData {
  lineup: Lineup | ScoredLineup;
  rank: number;
  
  // Core scores (always calculated)
  projectionScore: number;
  ownershipScore: number;
  leverageScore: number;
  totalScore: number;
  
  // Relative value metrics
  relativeValueRatio: number;
  relativeValueScore: number;
  
  // Variance/ceiling metrics
  varianceScore: number;
  lineupFloor: number;
  lineupCeiling: number;
  
  // Additional scoring metrics
  scarcityScore: number;         // Position scarcity optimization score
  valueLeverageScore: number;    // Hidden value plays score
  gameStackScore: number;        // Game stacking correlation score
  simulationScore: number;       // Monte Carlo simulation score
  
  // Ownership analysis
  ownershipSum: number;
  projectionSacrifice: number;
  ownershipReduction: number;
  
  // Efficient frontier
  isEfficientFrontier: boolean;
  
  // Simulation results (from tournament-sim.ts when available)
  pFirst?: number;               // P(1st place)
  pTop1Pct?: number;             // P(Top 1%)
  pTop5Pct?: number;             // P(Top 5%)
  pTop10Pct?: number;            // P(Top 10%)
  pCash?: number;                // P(min cash)
  expectedPayout?: number;       // E[$] per entry
  expectedROI?: number;          // E[ROI] percentage
}

/**
 * Result of selection phase
 */
export interface SelectionResult {
  selected: ScoredLineup[];
  exposures: Map<string, number>;
  avgProjection: number;
  avgOwnership: number;
  metricsData?: LineupMetricsData[];  // Optional metrics for detailed export
}

// ============================================================
// CLI TYPES
// ============================================================

/**
 * CLI configuration options
 */
export type SimMode = 'uniform' | 'tiered' | 'none';

/**
 * Contest size classification for field modeling.
 * Different contest sizes have fundamentally different field compositions:
 * - single: Single-entry → more casual players, fewer optimizers
 * - 3max: Small multi-entry → moderate optimizer presence
 * - 20max: Large multi-entry → heavy optimizer/sharp presence (40%+)
 * - 150max: Mass multi-entry → dominated by sharp optimizers
 */
export type ContestSize = 'single' | '3max' | '20max' | '150max';

export interface CLIOptions {
  input: string;
  output: string;
  site: DFSSite;
  sport: Sport;
  contest: ContestType;
  poolSize: number;
  maxExposure: number;
  minSalary?: number;
  lineupCount: number;          // Number of lineups to select and export (default 1500)
  simMode: SimMode;             // Simulation mode: 'uniform' (all equal depth) or 'tiered' (legacy)
  contestSize: ContestSize;     // Contest size for field composition modeling (default '20max')
  // Late swap options
  lateSwap: boolean;
  entries?: string;
  // Calibration options
  calibrate: boolean;
  dataDir?: string;
  // Backtest & scraper options
  backtest: boolean;
  fastOptimize: boolean;
  cachePool: boolean;
  fromCache: boolean;
  simpleSelect: boolean;
  noChalk: boolean;
  sweepSelect: boolean;
  sweepCount: number;
  sweepFormula: boolean;
  sweepFormulaCount: number;
  backtestFast: boolean;
  scrape: boolean;
  scrapeDays: number;
  extractData: boolean;
  fieldSamples: number;           // Number of field ensemble samples (3-5, default 3)
  // Pool CSV loader: skip pool gen, load lineups from a pre-built CSV
  poolCsv?: string;
  // Standalone scoring + actuals-backtest modes
  scoreActualsLineups?: string;   // Path to lineup CSV to score against actuals
  actualsCsv?: string;            // Path to DK contest actuals CSV
  backtestActuals?: boolean;      // Mode 2: use actual contest field as the pool
  sweepActuals?: boolean;         // Sweep selector params using actuals-backtest
  proNames?: string[];            // Pro usernames to benchmark
}

// ============================================================
// EDGE-BOOSTED GENERATION TYPES
// ============================================================

export interface PlayerEdgeInfo {
  edgeScore: number;     // 0-1 normalized, higher = more edge
  coreCount: number;     // How many differentiated cores this player appears in
  avgGap: number;        // Average frequencyGap across cores
  gameId: string;        // Game identifier for rotation grouping
}

export interface PlayerEdgeScores {
  players: Map<string, PlayerEdgeInfo>;
  gameGroups: Map<string, string[]>;  // gameId → player IDs with edge
  topEdgePlayerIds: string[];         // Top 20 edge players by score
}

export interface EdgeBoostedParams {
  config: ContestConfig;
  pool: PlayerPool;
  edgeScores: PlayerEdgeScores;
  iterations: number;          // Default 25
  lineupsPerIteration: number; // Default 500
  existingHashes: Set<string>;
  minSalary?: number;
}

// ============================================================
// ANALYSIS TYPES
// ============================================================

/**
 * Player combination for tracking correlation
 */
export interface PlayerCombo {
  playerIds: string[];
  count: number;
  frequency: number;
}

/**
 * Pool analysis results
 */
export interface PoolAnalysis {
  totalLineups: number;
  maxProjection: number;
  avgProjection: number;
  minProjection: number;
  playerExposures: Map<string, number>;
  topCombos: PlayerCombo[];
}

// ============================================================
// LATE SWAP TYPES
// ============================================================

/**
 * Player lock status for late swap
 */
export type LockStatus = 'locked' | 'swappable';

/**
 * DraftKings entry parsed from export
 */
export interface DKEntry {
  entryId: string;
  contestName: string;
  contestId: string;
  playerIds: string[];
}

/**
 * Player with lock status for late swap
 */
export interface PlayerWithLock extends Player {
  lockStatus: LockStatus;
  statusReason?: string;  // e.g., 'Confirmed', 'Q', 'GTD'
}

/**
 * Detail of a single swap
 */
export interface SwapDetail {
  slotIndex: number;
  slotName: string;
  fromPlayer: Player;
  toPlayer: Player;
  projectionDelta: number;
  salaryDelta: number;
}

/**
 * Result of optimizing a single entry
 */
export interface SwapResult {
  entryId: string;
  contestName: string;
  originalPlayers: Player[];
  originalProjection: number;
  originalSalary: number;
  swappedPlayers: Player[];
  swappedProjection: number;
  swappedSalary: number;
  swaps: SwapDetail[];
  projectionGain: number;
  leverageScore: number;
}

/**
 * Parameters for late swap optimization
 */
export interface LateSwapParams {
  entries: DKEntry[];
  pool: PlayerPool;
  config: ContestConfig;
  lockStatus: Map<string, LockStatus>;
}

/**
 * Locked skeleton: group of entries sharing identical locked player sets.
 * By grouping entries, we generate candidates once per skeleton instead of per entry.
 */
export interface LockedSkeleton {
  hash: string;                   // Hash of sorted slot:playerId pairs (e.g., "0:12345|2:67890")
  lockedPlayers: Player[];
  lockedSlots: number[];
  swappableSlots: number[];
  lockedSalary: number;
  remainingCap: number;
  lockedPlayerIds: Set<string>;
  entryIndices: number[];         // Which entries share this skeleton
}

/**
 * Result of late swap optimization
 */
export interface LateSwapResult {
  results: SwapResult[];
  entriesImproved: number;
  avgProjectionGain: number;
  swapExposures: Map<string, number>;  // How often each player was swapped in
  candidatesGenerated: number;
  fieldSize: number;
  simulationRun: boolean;
}
