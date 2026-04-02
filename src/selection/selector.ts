/**
 * DFS Optimizer CLI - Game Theory Selector (Refactored)
 *
 * GPP selection strategy:
 * 1. ALWAYS include #1 max projection lineup first
 * 2. Lower projection MUST mean lower ownership (contrarian trade-off)
 * 3. Fade chalk combos (what field is building)
 * 4. NO hard exposure limits - let optimal players run naturally
 * 5. Unique constructions vs both field AND our portfolio
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  Lineup,
  ScoredLineup,
  SelectionParams,
  SelectionResult,
  Player,
  LineupMetricsData,
} from '../types';

// ============================================================
// WEIGHT LOADING FROM BACKTESTER
// ============================================================

/**
 * Weights for the NBA GPP scoring formula.
 * These map 1:1 to the components in calculateTotalScore.
 * The backtester optimizes these via gradient descent against actual contest results.
 */
export interface OptimizedWeights {
  projectionScore: number;
  ownershipScore: number;  // POSITIVE weight: low ownership = high score = better
  uniquenessScore: number; // Consolidated: leverageScore + antiCorrelation + ownershipRobustness
  varianceScore: number;
  relativeValueScore: number;
  ceilingScore: number;
  salaryEfficiencyScore: number;
  simulationScore: number;  // Weight for simulation-based win%/top1% metrics
  projectionEdgeScore: number;  // Our proj vs field-implied proj
  ceilingRatioScore: number;    // Blended ceiling ratio (boom potential as ratio)
  gameEnvironmentScore: number; // High-total game environments
  // Quality gate thresholds (from formula sweep)
  projGateThreshold?: number;   // Default 0.50 — projection score below this gets penalized
  ceilGateThreshold?: number;   // Default 0.40 — ceiling score below this gets penalized
  maxExposure?: number;         // Default 0.50 — max player exposure for hard-cap selectors
  // Legacy fields — kept for backwards compatibility when loading old weights files
  leverageScore?: number;
  antiCorrelationScore?: number;
  ownershipRobustnessScore?: number;
}

const DEFAULT_WEIGHTS: OptimizedWeights = {
  // === BASE SCORING WEIGHTS (sum to 1.0) ===
  // Optimized via 500K formula sweep on 12-slate backtest (242K entries).
  // Best result: 1.85% top-1% (84/4536).
  // relativeValue is #1 weight — dominant GPP differentiator for top-1% finishes.
  projectionScore: 0.085,        // Projection quality
  ownershipScore: 0.00,          // Not used in formula
  uniquenessScore: 0.00,         // Not used in formula
  projectionEdgeScore: 0.00,     // Not used in formula
  ceilingRatioScore: 0.00,       // Not used in formula (available for sweep)
  gameEnvironmentScore: 0.00,    // Not used in formula (available for sweep)
  ceilingScore: 0.124,           // Boom potential
  varianceScore: 0.226,          // Upside variance — much higher than expected
  salaryEfficiencyScore: 0.096,  // Cap utilization
  relativeValueScore: 0.469,     // #1 GPP differentiator

  // === QUALITY GATE THRESHOLDS (from formula sweep) ===
  projGateThreshold: 0.564,      // More lenient than old 0.50
  ceilGateThreshold: 0.515,      // More lenient than old 0.40

  // === SIMULATION ENABLE FLAG (separate — NOT in the 1.0 sum) ===
  simulationScore: 0.00,
};

let loadedWeights: OptimizedWeights | null = null;

/**
 * Reset cached weights so next call to loadOptimizedWeights re-reads from disk.
 * Call this after the backtester writes new weights.
 */
export function resetWeightsCache(): void {
  loadedWeights = null;
}

/**
 * Load optimized weights from backtester output
 * Falls back to defaults if file doesn't exist
 */
export function loadOptimizedWeights(): OptimizedWeights {
  if (loadedWeights) return loadedWeights;

  const weightsPath = path.join(process.cwd(), 'historical_slates', 'optimized_weights.json');
  
  try {
    if (fs.existsSync(weightsPath)) {
      const data = fs.readFileSync(weightsPath, 'utf-8');
      const parsed = JSON.parse(data) as OptimizedWeights;
      // Migrate legacy format: if old file has leverageScore but no uniquenessScore,
      // consolidate the 3 dimensions into uniquenessScore
      if (parsed.uniquenessScore === undefined && parsed.leverageScore !== undefined) {
        parsed.uniquenessScore = (parsed.leverageScore || 0) +
                                 (parsed.antiCorrelationScore || 0) +
                                 (parsed.ownershipRobustnessScore || 0);
        console.log(`[Weights] Migrated legacy weights: uniquenessScore=${parsed.uniquenessScore.toFixed(3)}`);
      }
      loadedWeights = parsed;
      console.log(`[Weights] Loaded optimized weights from ${weightsPath}`);
      return loadedWeights;
    }
  } catch (err) {
    console.warn(`[Weights] Failed to load weights: ${err}. Using defaults.`);
  }

  console.log(`[Weights] Using default weights (no optimized_weights.json found)`);
  loadedWeights = DEFAULT_WEIGHTS;
  return loadedWeights;
}
/**
 * Adapt scoring weights based on slate characteristics.
 * Different slates have fundamentally different dynamics:
 * - Small slates: ownership matters less (forced into similar players), ceiling matters more
 * - High-variance slates: ceiling weight increases
 * - Concentrated ownership: leverage weight increases (differentiation is key)
 * - Flat ownership: projection weight increases (field is already diverse)
 */
export function adaptWeightsToSlate(
  weights: OptimizedWeights,
  allPlayers: Player[],
  numGames: number
): OptimizedWeights {
  // === Compute slate features ===

  // Ownership HHI (Herfindahl-Hirschman Index) — measures concentration
  const totalOwnership = allPlayers.reduce((s, p) => s + Math.max(1, p.ownership), 0);
  let hhi = 0;
  for (const p of allPlayers) {
    const share = Math.max(1, p.ownership) / totalOwnership;
    hhi += share * share;
  }

  // Average ceiling ratio
  let ceilingRatioSum = 0;
  let ceilingCount = 0;
  for (const p of allPlayers) {
    if (p.projection > 0) {
      const ceil = p.ceiling || p.projection * 1.25;
      ceilingRatioSum += ceil / p.projection;
      ceilingCount++;
    }
  }
  const avgCeilingRatio = ceilingCount > 0 ? ceilingRatioSum / ceilingCount : 1.25;

  // === Compute multipliers ===
  const projMult = 1.0 + 0.15 * (avgCeilingRatio < 1.20 ? 1 : 0);
  const ownMult = 1.0 + 0.25 * Math.max(0, (4 - numGames) / 4);
  const levMult = 1.0 + 0.25 * Math.min(1, Math.max(0, (hhi - 0.01) / 0.03));
  const ceilMult = 1.0 + 0.10 * Math.max(0, (avgCeilingRatio - 1.20) / 0.10);

  // === Apply multipliers ===
  const adjusted: OptimizedWeights = {
    projectionScore: weights.projectionScore * projMult,
    ownershipScore: weights.ownershipScore * ownMult,
    ceilingScore: weights.ceilingScore * ceilMult,
    uniquenessScore: (weights.uniquenessScore ?? 0) * levMult,  // leverage multiplier applies to consolidated uniqueness
    varianceScore: weights.varianceScore,
    relativeValueScore: weights.relativeValueScore,
    salaryEfficiencyScore: weights.salaryEfficiencyScore,
    simulationScore: weights.simulationScore,
    projectionEdgeScore: weights.projectionEdgeScore,
    ceilingRatioScore: weights.ceilingRatioScore ?? 0,
    gameEnvironmentScore: weights.gameEnvironmentScore ?? 0,
  };

  // === Renormalize non-sim weights to sum to 1.0 ===
  // simulationScore is applied separately in Phase 3.5 — exclude from normalization
  const simWeight = adjusted.simulationScore;
  const nonSimKeys = (Object.keys(adjusted) as (keyof OptimizedWeights)[]).filter(
    k => k !== 'simulationScore' && k !== 'leverageScore' && k !== 'antiCorrelationScore' && k !== 'ownershipRobustnessScore'
  );
  const nonSimTotal = nonSimKeys.reduce((s, k) => s + (adjusted[k] || 0), 0);
  if (nonSimTotal > 0) {
    for (const key of nonSimKeys) {
      (adjusted as any)[key] = (adjusted[key] || 0) / nonSimTotal;
    }
  }
  adjusted.simulationScore = simWeight;  // restore untouched

  return adjusted;
}

import {
  calculateOwnershipSum,
  calculateOwnershipScore,
  calculateGeometricMeanOwnership,
  normalizeProjectionScore,
  calculateVarianceScore,
  calculateRelativeValue,
  markEfficientFrontier,
  calculateBaselineMetrics,
  calculateCeilingRatioScore,
  calculateGameEnvironmentScore,
} from './scoring/lineup-scorer';
import {
  analyzeFieldCombos,
  buildFieldOverlapIndex,
  calculateFieldOverlapScore,
  calculateFieldAntiCorrelation,
  calculateFieldOverlapMetrics,
  FieldComboAnalysis,
  FieldOverlapIndex,
  analyzeDeepCombos,
  DeepComboAnalysis,
  analyzeProjectionEdge,
  calculateLineupProjectionEdgeScore,
  ProjectionEdgeAnalysis,
  generateOwnershipScenarios,
  calculateOwnershipRobustness,
  OwnershipScenario,
  calculateConditionalOwnership,
  calculateCorrelatedCeilingScore,
  analyzeJustifiedOwnership,
  calculateJustifiedOwnershipFactor,
  JustifiedOwnershipAnalysis,
} from './scoring/field-analysis';
import { generateFieldPool, validateFieldCalibration, simulateTournaments, simulateTiered, simulateUniform, simulateMultiField, SimulationResult, buildGPPPayoutStructure, PayoutTier, FieldLineup, FieldEnvironment, FIELD_ENVIRONMENTS, getFieldEnvironments } from './simulation/tournament-sim';

// ============================================================
// CONFIGURATION
// ============================================================

const CONFIG = {
  // Selection targets
  ELITE_MAX: 5000,

  // Exposure limits - Failsafe only (primary control is field-relative)
  // Field-relative caps do the real work. This is just a failsafe
  // to prevent extreme edge cases where a player might exceed 55%.
  MAX_EXPOSURE: 0.55,      // Failsafe hard cap - rarely hit with field-relative caps
};

// ============================================================
// ARCHETYPE CLASSIFICATION
// ============================================================

type LineupArchetype = 'chalk' | 'balanced' | 'leverage' | 'contrarian';

/**
 * Adaptive thresholds for archetype classification.
 * Computed from pool's geometric-mean ownership distribution so each
 * archetype always gets ~25% of the pool regardless of slate size.
 */
interface ArchetypeThresholds {
  chalkMin: number;      // >= this → chalk
  balancedMin: number;   // >= this → balanced
  leverageMin: number;   // >= this → leverage
  // below leverageMin → contrarian
}

/**
 * Compute adaptive archetype thresholds from the pool's actual
 * geometric-mean ownership distribution.
 *
 * Uses percentiles (80th / 50th / 20th) so each archetype gets ~25%
 * of the pool. On small slates where ALL players have high ownership,
 * thresholds shift up automatically instead of putting 75% in chalk.
 */
function computeAdaptiveThresholds(pool: ScoredLineup[]): ArchetypeThresholds {
  const geoMeans = pool.map(l => calculateGeometricMeanOwnership(l));
  geoMeans.sort((a, b) => a - b);

  const n = geoMeans.length;
  const p80 = geoMeans[Math.floor(n * 0.80)];
  const p50 = geoMeans[Math.floor(n * 0.50)];
  const p20 = geoMeans[Math.floor(n * 0.20)];

  return {
    chalkMin: p80,
    balancedMin: p50,
    leverageMin: p20,
  };
}

/**
 * Classify a lineup into one of 4 archetypes based on geometric mean ownership.
 * - chalk: Top 20% ownership → covers "chalk hits" scenarios
 * - balanced: 50th-80th pct → mix of chalk anchors + unique pieces
 * - leverage: 20th-50th pct → mostly unique constructions with a star or two
 * - contrarian: Bottom 20% → deep contrarian, covers "chalk busts" scenarios
 *
 * When thresholds are provided (from computeAdaptiveThresholds), classification
 * adapts to the pool's actual distribution. Falls back to hardcoded values if not.
 */
function classifyArchetype(lineup: ScoredLineup, thresholds?: ArchetypeThresholds): LineupArchetype {
  const geoMeanOwn = calculateGeometricMeanOwnership(lineup);
  const t = thresholds || { chalkMin: 18, balancedMin: 12, leverageMin: 7 };
  if (geoMeanOwn >= t.chalkMin) return 'chalk';
  if (geoMeanOwn >= t.balancedMin) return 'balanced';
  if (geoMeanOwn >= t.leverageMin) return 'leverage';
  return 'contrarian';
}

/**
 * Score a lineup specifically for a given archetype.
 * Used in greedy selection so each archetype competes on its own terms
 * instead of raw totalScore (which favors chalk).
 */
function getArchetypeSpecificScore(lineup: ScoredLineup, archetype: LineupArchetype): number {
  switch (archetype) {
    case 'chalk':
      return lineup.projectionScore * 0.60 + lineup.totalScore * 0.40;
    case 'balanced':
      return lineup.projectionScore * 0.45 + lineup.totalScore * 0.40 + lineup.ownershipScore * 0.15;
    case 'leverage':
      return lineup.projectionScore * 0.35 + (lineup.ceilingScore || 0.5) * 0.20 +
             lineup.totalScore * 0.30 + (lineup.leverageScore || 0.5) * 0.10 +
             lineup.ownershipScore * 0.05;
    case 'contrarian':
      return (lineup.ceilingScore || 0.5) * 0.30 + lineup.projectionScore * 0.30 +
             (lineup.varianceScore || 0) * 0.10 + lineup.totalScore * 0.25 +
             lineup.ownershipScore * 0.05;
    default:
      return lineup.totalScore;
  }
}

/**
 * Sort lineups within an archetype by what makes that archetype good.
 * - Chalk: projection-heavy (best expected value chalk lineup)
 * - Balanced: equal projection + differentiation
 * - Leverage: differentiation-heavy
 * - Contrarian: ceiling + leverage (most upside when chalk fails)
 */
function sortByArchetype(lineups: ScoredLineup[], archetype: LineupArchetype): void {
  lineups.sort((a, b) => getArchetypeSpecificScore(b, archetype) - getArchetypeSpecificScore(a, archetype));
}

// Archetype allocation targets
// 15% chalk: hedge for "all chalk hits" scenario
// 30% balanced: covers "mixed outcomes"
// 25% leverage: unique constructions
// 20% contrarian: covers "chalk busts" with ceiling upside
const ARCHETYPE_TARGETS: Record<LineupArchetype, number> = {
  chalk: 0.25,
  balanced: 0.35,
  leverage: 0.20,
  contrarian: 0.20,
};

/**
 * Compute dynamic archetype targets based on field concentration and slate size.
 *
 * Optimal archetype allocation depends on the field:
 * - Concentrated ownership (HHI high): Field is predictable → more leverage/contrarian
 * - Flat ownership (HHI low): Field is diverse → more chalk/balanced is fine
 * - Small slates: Fewer differentiation paths → more balanced, less extreme contrarian
 */
function computeDynamicArchetypeTargets(
  allPlayers: Player[],
  numGames: number
): Record<LineupArchetype, number> {
  // Compute ownership HHI
  const totalOwnership = allPlayers.reduce((s, p) => s + Math.max(1, p.ownership), 0);
  let hhi = 0;
  for (const p of allPlayers) {
    const share = Math.max(1, p.ownership) / totalOwnership;
    hhi += share * share;
  }

  // Start from static ARCHETYPE_TARGETS (not hardcoded)
  let chalk = ARCHETYPE_TARGETS.chalk;
  let balanced = ARCHETYPE_TARGETS.balanced;
  let leverage = ARCHETYPE_TARGETS.leverage;
  let contrarian = ARCHETYPE_TARGETS.contrarian;

  // Adjust for ownership concentration
  // HHI > 0.03 = concentrated → shift toward leverage/contrarian
  // HHI < 0.015 = flat → shift toward chalk/balanced
  if (hhi > 0.03) {
    const shift = Math.min(0.08, (hhi - 0.03) * 4);
    chalk -= shift / 2;
    balanced -= shift / 2;
    leverage += shift * 0.6;
    contrarian += shift * 0.4;
  } else if (hhi < 0.015) {
    const shift = Math.min(0.06, (0.015 - hhi) * 4);
    chalk += shift * 0.4;
    balanced += shift * 0.6;
    leverage -= shift / 2;
    contrarian -= shift / 2;
  }

  // Small slate adjustment: more balanced, less extreme
  if (numGames <= 3) {
    const smallShift = 0.05 * (4 - numGames) / 4;
    chalk -= smallShift;
    contrarian -= smallShift;
    balanced += smallShift;
    leverage += smallShift;
  }

  // Clamp all to [0.02, 0.50] and renormalize (chalk floor lowered to 2%)
  chalk = Math.max(0.02, Math.min(0.50, chalk));
  balanced = Math.max(0.05, Math.min(0.50, balanced));
  leverage = Math.max(0.05, Math.min(0.50, leverage));
  contrarian = Math.max(0.05, Math.min(0.50, contrarian));
  const total = chalk + balanced + leverage + contrarian;

  return {
    chalk: chalk / total,
    balanced: balanced / total,
    leverage: leverage / total,
    contrarian: contrarian / total,
  };
}

// ============================================================
// PRE-SELECTION PARETO FILTER
// ============================================================

/** Adaptive ownership margin for Pareto filtering based on slate size.
 * Short slates have concentrated ownership — wider margin keeps more of the pool alive. */
function getOwnMargin(numGames: number, boost: number = 0): number {
  let base: number;
  if (numGames <= 2) base = 20.0;
  else if (numGames <= 3) base = 16.0;
  else if (numGames <= 5) base = 13.0;
  else base = 10.0;
  return base + boost;
}

/**
 * Remove lineups that are strictly dominated on both projection and geometric mean ownership,
 * with a soft margin so near-frontier lineups survive.
 *
 * Uses geometric mean ownership (not sum) — this is the correct metric for lineup probability
 * because product ownership represents the field's probability of building that exact lineup.
 * Sum ownership was too aggressive on slates with dominant projections (e.g., Jokic at 62.1).
 *
 * Algorithm: O(n log n) sort-and-scan.
 * 1. Sort by projection DESC (ties broken by lower geoMean ownership)
 * 2. Scan top-to-bottom, tracking minGeoMeanSeen
 * 3. Lineup SURVIVES if: geoMeanOwn <= minGeoMeanSeen + OWN_MARGIN
 * 4. Update minGeoMeanSeen = min(minGeoMeanSeen, this lineup's geoMeanOwn)
 */
function paretoFilterPool<T extends { projection: number; players: Array<{ ownership: number }> }>(lineups: T[], numGames: number = 8, ownMarginBoost: number = 0): T[] {
  if (lineups.length < 2) return lineups;

  const withOwn = lineups.map(l => {
    // Geometric mean ownership: nth root of product of ownerships
    const n = l.players.length;
    const logSum = l.players.reduce((sum, p) => sum + Math.log(Math.max(0.5, p.ownership)), 0);
    const geoMeanOwn = Math.exp(logSum / n);
    return { lineup: l, geoMeanOwn };
  });

  // Sort by projection DESC, ties broken by lower ownership
  withOwn.sort((a, b) => b.lineup.projection - a.lineup.projection || a.geoMeanOwn - b.geoMeanOwn);

  const ownMargin = getOwnMargin(numGames, ownMarginBoost);
  let minGeoMeanSeen = Infinity;
  const surviving: T[] = [];

  for (const item of withOwn) {
    if (item.geoMeanOwn <= minGeoMeanSeen + ownMargin) {
      surviving.push(item.lineup);
    }
    minGeoMeanSeen = Math.min(minGeoMeanSeen, item.geoMeanOwn);
  }

  return surviving;
}

// ============================================================
// MAIN SELECTION FUNCTION
// ============================================================

/**
 * Select lineups from pool using game theory principles.
 * Returns portfolio optimized for GPP success.
 */
export function selectLineups(
  params: SelectionParams,
  onProgress?: (progress: number, message: string) => void
): SelectionResult {
  const { lineups, targetCount } = params;
  const salaryCap = params.salaryCap || 50000;
  const numGames = params.numGames || 5;
  const contestSize = params.contestSize || '20max';
  const sport = params.sport;
  const skipChalkPenalty = params.skipChalkPenalty || false;
  const selConfig = params.selectionConfig;

  console.log(`\n========================================`);
  console.log(`GPP GAME THEORY SELECTION`);
  console.log(`========================================`);
  console.log(`Pool size: ${lineups.length.toLocaleString()}`);
  console.log(`Target: ${targetCount.toLocaleString()} lineups`);
  console.log(`Salary cap: $${salaryCap.toLocaleString()}`);
  console.log(`Games on slate: ${numGames}`);

  if (lineups.length === 0) {
    return createEmptyResult();
  }

  // Sort by projection descending
  let sortedLineups = [...lineups].sort((a, b) => b.projection - a.projection);

  // Pre-selection Pareto filter: remove lineups dominated by both lower projection AND higher ownership
  const preFilterCount = sortedLineups.length;
  sortedLineups = paretoFilterPool(sortedLineups, numGames, selConfig?.ownMarginBoost || 0);
  const paretoRemoved = preFilterCount - sortedLineups.length;
  console.log(`Pareto filter: ${preFilterCount.toLocaleString()} → ${sortedLineups.length.toLocaleString()} (removed ${paretoRemoved.toLocaleString()} dominated)`);

  // Projection floor: remove lineups below threshold of optimal.
  // Non-team sports (NASCAR, golf, MMA) need lower floor because player projections
  // are more concentrated — the top 2-3 dominate, so "contrarian" lineups that skip
  // them have inherently lower projection but can still win GPPs.
  // Adaptive: when one player dominates projections (e.g., Luka 59.8 vs next 48.7),
  // the floor must lower to accommodate lineups without that player.
  const isNonTeamSport = sport && ['nascar', 'golf', 'mma'].includes(sport);

  // Detect projection concentration from top lineups
  const playerMaxProj = new Map<string, number>();
  for (const lineup of sortedLineups.slice(0, Math.min(100, sortedLineups.length))) {
    for (const p of lineup.players) {
      if (!playerMaxProj.has(p.id) || p.projection > playerMaxProj.get(p.id)!)
        playerMaxProj.set(p.id, p.projection);
    }
  }
  const sortedPlayerProjs = [...playerMaxProj.values()].sort((a, b) => b - a);
  const projGap = (sortedPlayerProjs[0] || 0) - (sortedPlayerProjs[1] || 0);
  const rosterSizeForGap = sortedLineups[0]?.players.length || 8;
  const gapPenalty = Math.max(0, (projGap - 5) / rosterSizeForGap) * 0.5;

  let baseProjFloor: number;
  if (isNonTeamSport) baseProjFloor = 0.85;
  else if (numGames <= 3) baseProjFloor = 0.90;
  else baseProjFloor = 0.94;

  const PROJ_FLOOR_PCT = selConfig?.projFloorPct ?? Math.max(0.85, baseProjFloor - gapPenalty);
  if (gapPenalty > 0.01) {
    console.log(`  Projection gap: ${projGap.toFixed(1)} pts → floor adjusted ${(baseProjFloor * 100).toFixed(0)}% → ${(PROJ_FLOOR_PCT * 100).toFixed(1)}%`);
  }
  const projFloorValue = sortedLineups[0].projection * PROJ_FLOOR_PCT;
  const preFloorCount = sortedLineups.length;
  sortedLineups = sortedLineups.filter(l => l.projection >= projFloorValue);
  const floorRemoved = preFloorCount - sortedLineups.length;
  if (floorRemoved > 0) {
    console.log(`Projection floor (${(PROJ_FLOOR_PCT * 100).toFixed(0)}%): removed ${floorRemoved.toLocaleString()} lineups below ${projFloorValue.toFixed(1)} pts`);
  }

  if (sortedLineups.length < targetCount * 3) {
    console.log(`  WARNING: Pool (${sortedLineups.length}) < 3x target (${targetCount * 3}). Concentrated slate — relaxing filters.`);
  }

  const maxProj = sortedLineups[0].projection;
  const minProj = sortedLineups[sortedLineups.length - 1].projection;
  const projRange = maxProj - minProj || 1;

  // Constrained pool detection: when candidates < 3x target, relax ownership/diversity filters.
  // The projection floor already guarantees quality — aggressive ownership filtering
  // just starves the selection when the candidate pool is small.
  const constrainedPool = sortedLineups.length < targetCount * 3;
  if (constrainedPool) {
    console.log(`*** CONSTRAINED POOL (${sortedLineups.length} candidates for ${targetCount} target) — relaxing ownership/diversity filters ***`);
  }

  console.log(`Projection range: ${minProj.toFixed(1)} - ${maxProj.toFixed(1)}`);

  // ============================================================
  // PHASE 1: BASELINE ANALYSIS
  // ============================================================
  console.log(`\n--- BASELINE ANALYSIS ---`);
  const baseline = calculateBaselineMetrics(sortedLineups);
  console.log(`Optimal: ${baseline.optimalProjection.toFixed(1)} pts / ${baseline.optimalOwnership.toFixed(1)}% ownership`);

  // Mark efficient frontier
  const lineupsWithOwnership = sortedLineups.map(l => ({
    lineup: l,
    ownership: calculateOwnershipSum(l),
  }));
  const efficientFrontier = markEfficientFrontier(lineupsWithOwnership);
  console.log(`Efficient frontier: ${efficientFrontier.size} lineups`);

  // Detect showdown mode
  const isShowdown = lineups[0]?.players?.some(p => p.isCaptain === true) || false;
  // Single-game detection: golf, showdown, MMA — ownership inherently concentrated
  const isSingleGame = numGames <= 1 || isShowdown;
  if (isShowdown) {
    console.log(`*** SHOWDOWN MODE ***`);
  }
  if (isSingleGame && !isShowdown) {
    console.log(`*** SINGLE-GAME SLATE (${numGames} games) — relaxed ownership filters ***`);
  }
  // Short slate: 2-3 games, concentrated ownership, need relaxed diversity/exposure
  const isShortSlate = numGames <= 3 && !isSingleGame;
  if (isShortSlate) {
    console.log(`*** SHORT SLATE (${numGames} games) — adaptive exposure/diversity ***`);
  }

  // Collect all unique players for field generation and simulation
  const allPlayers: Player[] = [];
  const seenPlayers = new Set<string>();
  for (const lineup of lineups) {
    for (const player of lineup.players) {
      if (!seenPlayers.has(player.id)) {
        seenPlayers.add(player.id);
        allPlayers.push(player);
      }
    }
  }

  const rosterSize = lineups[0]?.players.length || 8;

  // ============================================================
  // OWNERSHIP UNCERTAINTY ANALYSIS (moved before field generation)
  // ============================================================
  console.log(`\n--- OWNERSHIP UNCERTAINTY ---`);
  const ownershipScenarios = generateOwnershipScenarios(allPlayers, 20);

  // Build baseline ownership map
  const baselineOwnership = new Map<string, number>();
  for (const p of allPlayers) {
    baselineOwnership.set(p.id, p.ownership);
  }

  // Log scenario distribution for top 5 players
  const topByOwn = [...allPlayers].sort((a, b) => b.ownership - a.ownership).slice(0, 5);
  console.log(`  Generated ${ownershipScenarios.length} ownership scenarios`);
  for (const p of topByOwn) {
    const scenarioOwns = ownershipScenarios.map(s => s.playerOwnerships.get(p.id) || p.ownership);
    const minOwn = Math.min(...scenarioOwns);
    const maxOwn = Math.max(...scenarioOwns);
    const avgOwn = scenarioOwns.reduce((s, v) => s + v, 0) / scenarioOwns.length;
    console.log(`    ${p.name.split(' ').pop()?.padEnd(15) || ''} base: ${p.ownership.toFixed(1)}%  range: ${minOwn.toFixed(1)}-${maxOwn.toFixed(1)}%  avg: ${avgOwn.toFixed(1)}%`);
  }

  // ============================================================
  // PHASE 2: FIELD ANALYSIS (Scenario-Diversified Synthetic Field)
  // ============================================================
  console.log(`\n--- FIELD ANALYSIS ---`);

  // Generate synthetic field lineups distributed across ownership scenarios.
  // Each scenario perturbs player ownerships, so the field captures uncertainty
  // in ownership projections. This makes field-based metrics (combo frequencies,
  // leverage scores, simulation) robust to ownership shifts.
  const simMode = params.simMode || 'uniform';

  // Build contest-size-aware field environments
  const contestFieldEnvs = getFieldEnvironments(contestSize);
  console.log(`  Contest size: ${contestSize} → field environments adjusted`);

  // Build optimizer proxy lineups for sharpOptimizer field archetype
  // Our own pool's top-projection lineups are the best proxy for what
  // other SaberSim optimizer users would build
  let optimizerProxies: FieldLineup[] | undefined;
  const totalFieldSize = simMode === 'uniform'
    ? contestFieldEnvs.reduce((s, e) => s + e.fieldSize, 0)
    : 20000;
  if (simMode === 'uniform' || simMode === 'tiered') {
    const proxyCount = Math.floor(totalFieldSize * 0.12);
    const proxiesPerStrategy = Math.floor(proxyCount / 4);

    // Strategy 1: Top projection (chalk optimizers)
    const projSorted = [...sortedLineups].sort((a, b) => b.projection - a.projection);
    const projProxies = projSorted.slice(0, proxiesPerStrategy);

    // Strategy 2: Best efficiency (projection / sqrt(sumOwnership)) — leverage optimizers
    const effSorted = [...sortedLineups].sort((a, b) => {
      const effA = a.projection / Math.sqrt(a.players.reduce((s, p) => s + p.ownership, 0) || 1);
      const effB = b.projection / Math.sqrt(b.players.reduce((s, p) => s + p.ownership, 0) || 1);
      return effB - effA;
    });
    const effProxies = effSorted.slice(0, proxiesPerStrategy);

    // Strategy 3: Highest ceiling — ceiling optimizers
    const ceilSorted = [...sortedLineups].sort((a, b) => {
      const ceilA = a.players.reduce((s, p) => s + (p.ceiling || p.projection * 1.25), 0);
      const ceilB = b.players.reduce((s, p) => s + (p.ceiling || p.projection * 1.25), 0);
      return ceilB - ceilA;
    });
    const ceilProxies = ceilSorted.slice(0, proxiesPerStrategy);

    // Strategy 4: Game stackers — lineups with 3+ from same game
    const stackProxies = sortedLineups
      .filter(l => {
        const gameCounts = new Map<string, number>();
        for (const p of l.players) {
          const gid = p.gameInfo || `${p.team}_game`;
          gameCounts.set(gid, (gameCounts.get(gid) || 0) + 1);
        }
        return [...gameCounts.values()].some(c => c >= 3);
      })
      .sort((a, b) => b.projection - a.projection)
      .slice(0, proxyCount - proxiesPerStrategy * 3);

    // Deduplicate by hash
    const proxyHashes = new Set<string>();
    optimizerProxies = [];
    for (const proxy of [...projProxies, ...effProxies, ...ceilProxies, ...stackProxies]) {
      if (!proxyHashes.has(proxy.hash)) {
        proxyHashes.add(proxy.hash);
        optimizerProxies.push({
          playerIds: proxy.players.map(p => p.id),
          salaries: proxy.players.map(p => p.salary),
          archetype: 'sharpOptimizer' as const,
        });
      }
    }
    console.log(`  Optimizer proxies: ${optimizerProxies.length} lineups (stratified: proj=${projProxies.length}, eff=${effProxies.length}, ceil=${ceilProxies.length}, stack=${stackProxies.length})`);
  }

  // Multi-field environments for uniform mode; single field for tiered/none
  const fieldEnvironments: FieldEnvironment[] = [];
  let syntheticField: FieldLineup[];

  if (simMode === 'uniform') {
    // Generate 5 diverse field environments (8K each, 40K total)
    console.log(`\n--- MULTI-FIELD GENERATION (${contestFieldEnvs.length} environments, contest: ${contestSize}) ---`);
    const proxiesPerEnv = optimizerProxies
      ? Math.floor(optimizerProxies.length / contestFieldEnvs.length)
      : 0;

    for (let ei = 0; ei < contestFieldEnvs.length; ei++) {
      const envTemplate = contestFieldEnvs[ei];
      // Split optimizer proxies evenly across environments
      const envProxies = optimizerProxies
        ? optimizerProxies.slice(ei * proxiesPerEnv, (ei + 1) * proxiesPerEnv)
        : undefined;

      console.log(`  Generating ${envTemplate.fieldSize} field lineups for ${envTemplate.name}...`);
      const envField = generateFieldPool(
        allPlayers, rosterSize, envTemplate.fieldSize,
        undefined, undefined, envTemplate.config, ownershipScenarios, envProxies, salaryCap
      );

      const env: FieldEnvironment = {
        ...envTemplate,
        fieldPool: envField,
      };
      fieldEnvironments.push(env);

      // Log per-environment composition
      const envArchCounts = new Map<string, number>();
      for (const fl of envField) {
        envArchCounts.set(fl.archetype, (envArchCounts.get(fl.archetype) || 0) + 1);
      }
      console.log(`    ${envTemplate.name}: ${envField.length} lineups — ${[...envArchCounts.entries()].map(([a, c]) => `${c} ${a}`).join(', ')}`);

      // Validate per-environment calibration
      validateFieldCalibration(envField, allPlayers);
    }

    // Merge all environment fields into one for heuristic analysis
    syntheticField = [];
    for (const env of fieldEnvironments) {
      if (env.fieldPool) syntheticField.push(...env.fieldPool);
    }
    console.log(`  Merged field: ${syntheticField.length.toLocaleString()} total lineups across ${fieldEnvironments.length} environments`);

    // Validate merged field calibration
    console.log(`  Merged field calibration:`);
    validateFieldCalibration(syntheticField, allPlayers);

  } else {
    // Tiered/none mode: single 20K field (original behavior)
    const FIELD_SAMPLE_SIZE = 20000;
    console.log(`  Generating ${FIELD_SAMPLE_SIZE} synthetic field lineups across ${ownershipScenarios.length} ownership scenarios...`);
    syntheticField = generateFieldPool(
      allPlayers, rosterSize, FIELD_SAMPLE_SIZE,
      undefined, undefined, undefined, ownershipScenarios, optimizerProxies, salaryCap
    );
  }

  // Log field composition (supports expanded archetypes)
  const fieldArchCounts = new Map<string, number>();
  for (const fl of syntheticField) {
    fieldArchCounts.set(fl.archetype, (fieldArchCounts.get(fl.archetype) || 0) + 1);
  }
  console.log(`  Field composition: ${[...fieldArchCounts.entries()].map(([a, c]) => `${c} ${a}`).join(', ')}`);

  // Validate that field exposures match ownership projections
  if (simMode !== 'uniform') {
    validateFieldCalibration(syntheticField, allPlayers);
  }

  const fieldCombos = analyzeFieldCombos(syntheticField, isShowdown);
  console.log(`Unique 3-player combos in field: ${fieldCombos.triples.size.toLocaleString()}`);
  console.log(`Chalk pairs detected: ${fieldCombos.chalkPairs.size}`);

  // Build field overlap index for direct leverage scoring
  const overlapIndex = buildFieldOverlapIndex(syntheticField, rosterSize);
  console.log(`Field overlap index: ${overlapIndex.playerFieldIndices.size} players tracked across ${overlapIndex.fieldSize} field lineups`);

  // Max ceiling across all players (for boom-weighted leverage normalization)
  // Uses ceiling99 (p99) to match the leverage function's boom weighting
  const maxCeiling = allPlayers.reduce((max, p) => {
    const ceil = p.ceiling99 || p.ceiling || p.projection * 1.3;
    return ceil > max ? ceil : max;
  }, 0);

  // ============================================================
  // DEEP COMBO ANALYSIS
  // ============================================================
  // Analyze 3/4/5-man combos on FULL pool to identify differentiated cores
  console.log(`\n--- DEEP COMBO ANALYSIS ---`);
  const deepComboAnalysis = analyzeDeepCombos(
    sortedLineups,
    syntheticField,
    allPlayers,
    numGames
  );

  // ============================================================
  // PROJECTION EDGE ANALYSIS
  // ============================================================
  // Justified ownership analysis: distinguish justified chalk from unjustified
  const justifiedOwnershipAnalysis = analyzeJustifiedOwnership(allPlayers);

  // Detect where our projection differs from field's implied projection
  console.log(`\n--- PROJECTION EDGE ANALYSIS ---`);
  const projectionEdgeAnalysis = analyzeProjectionEdge(allPlayers);
  console.log(`  Projection edge: avg ${(projectionEdgeAnalysis.avgEdge * 100).toFixed(1)}%`);
  console.log(`    Top edge players: ${projectionEdgeAnalysis.topEdgePlayers.slice(0, 5).map(id =>
    projectionEdgeAnalysis.players.get(id)?.name || id
  ).join(', ')}`)

  // ============================================================
  // SLATE-ADAPTIVE WEIGHT ADJUSTMENT
  // ============================================================
  const baseWeights = loadOptimizedWeights();
  const adaptedWeights = adaptWeightsToSlate(baseWeights, allPlayers, numGames);
  console.log(`\n--- SLATE-ADAPTIVE WEIGHTS ---`);
  console.log(`  Slate: ${numGames} games, ${allPlayers.length} players`);
  console.log(`  Adjusted: proj=${adaptedWeights.projectionScore.toFixed(3)} own=${adaptedWeights.ownershipScore.toFixed(3)} ceil=${adaptedWeights.ceilingScore.toFixed(3)} uniq=${(adaptedWeights.uniquenessScore || 0.25).toFixed(3)}`);

  // ============================================================
  // PHASE 3: SCORE ALL LINEUPS
  // ============================================================
  console.log(`\n--- SCORING LINEUPS ---`);
  const scoredLineups = scoreAllLineups(
    sortedLineups,
    baseline,
    fieldCombos,
    overlapIndex,
    maxCeiling,
    efficientFrontier,
    minProj,
    maxProj,
    deepComboAnalysis,
    projectionEdgeAnalysis,
    salaryCap,
    numGames,
    adaptedWeights,
    ownershipScenarios,
    baselineOwnership,
    justifiedOwnershipAnalysis
  );

  // ============================================================
  // PHASE 3.5: TOURNAMENT SIMULATION
  // ============================================================
  // Hoisted: finish vectors, payout structure, and game state for marginal contribution (Phase 4)
  const simFinishVectors = new Map<string, number[] | Float32Array>();
  const simPayoutStructure = buildGPPPayoutStructure(10000, 20);
  // (simGameStateMatrix and simGameIds were used by removed selectByPortfolioContribution)

  if (simMode === 'none') {
    // ============================================================
    // NO-SIM MODE: Skip simulation entirely, use heuristic scores only
    // ============================================================
    console.log(`\n--- SKIPPING TOURNAMENT SIMULATION (--no-sim) ---`);
    console.log(`  Using heuristic scores for ${scoredLineups.length.toLocaleString()} lineups`);

    // Apply chalk/unique penalties even without simulation (Bug 1 fix)
    for (const lineup of scoredLineups) {
      const chalkMult = skipChalkPenalty ? 1 : (1 - (lineup.chalkPenaltyPct || 0));
      lineup.totalScore *= chalkMult * (1 + (lineup.uniqueCoreBonusPct || 0));
    }

  } else if (simMode === 'uniform') {
    // ============================================================
    // UNIFORM MODE: Pre-filter → Equal-depth simulation → Pure marginal contribution
    // ============================================================

    // === SIMULATION WEIGHT ===
    // SIM=0.0: Pure heuristic mode. GPP EV ratio formula handles quality/ownership tradeoff.
    const SIM_WEIGHT_FRACTION = 0.0;

    if (SIM_WEIGHT_FRACTION > 0) {
    // Phase 3.25: Pre-filter to top 14K with archetype quotas
    console.log(`\n--- PRE-FILTER FOR SIMULATION ---`);
    const simCandidates = preFilterForSimulation(scoredLineups, 16000);
    console.log(`  Pre-filtered: ${scoredLineups.length.toLocaleString()} → ${simCandidates.length.toLocaleString()} candidates`);
    // Phase 3.5: Multi-field simulation — ALL candidates × 2000 sims across 5 environments
    console.log(`\n--- MULTI-FIELD TOURNAMENT SIMULATION ---`);
    const multiFieldResult = simulateMultiField(
      simCandidates,
      allPlayers,
      fieldEnvironments,
      {
        fieldSize: 10000,
        entryFee: 20,
        payoutStructure: simPayoutStructure,
        sport,
      }
    );
    const simResults = multiFieldResult.results;
    // gameStateMatrix and gameIds available on multiFieldResult if needed

    // Log per-environment breakdown
    console.log(`  Per-environment ROI breakdown:`);
    for (const envResult of multiFieldResult.perEnvironment) {
      console.log(`    ${envResult.name}: avg ROI ${envResult.avgROI.toFixed(1)}%, avg payout $${envResult.avgPayout.toFixed(2)}`);
    }
    const SIM_FIRST_WEIGHT = 0.12;        // P(1st) — reduced: too noisy at 3K sims (avg 0.3 counts/lineup)
    const SIM_UPSIDE_WEIGHT = 0.22;       // P(top 1%) — more reliable with ~30 counts/lineup at Stage 1
    const SIM_BOOMBUST_WEIGHT = 0.05;     // Boom-or-bust ratio
    const SIM_ROI_WEIGHT = 0.21;          // Expected payout — continuous metric, always reliable

    let simAttached = 0;
    let minROI = Infinity;
    let maxROI = -Infinity;

    for (const lineup of simCandidates) {
      const simResult = simResults.get(lineup.hash);
      if (simResult) {
        minROI = Math.min(minROI, simResult.expectedROI);
        maxROI = Math.max(maxROI, simResult.expectedROI);
      }
    }

    const roiRange = maxROI - minROI || 1;

    for (const lineup of simCandidates) {
      const simResult = simResults.get(lineup.hash);
      if (simResult) {
        // Preserve original heuristic score
        const heuristicScore = lineup.totalScore;
        lineup.heuristicScore = heuristicScore;

        // Compute 3 simulation dimensions
        const simROI = Math.max(0, Math.min(1, (simResult.expectedROI - minROI) / roiRange));
        const simUpside = simResult.pTop1Pct; // P(top 1%) — raw value, normalized later across candidates
        // simBoomBust: ratio of top finishes to dead-zone (40th-60th pctile) finishes
        // High = lineup either booms (top 5%) or busts — avoids mediocre dead zone
        // This is GPP-aligned: you WANT boom-or-bust, not consistent mediocrity
        let simBoomBust = 0.5; // default
        if (simResult.finishPositionVector) {
          const fv = simResult.finishPositionVector;
          const n = fv.length;
          const fieldSize = 10000; // standard field size for percentile calc
          let topCount = 0;
          let deadZoneCount = 0;
          for (let i = 0; i < n; i++) {
            const pctile = fv[i] / fieldSize;
            if (pctile <= 0.05) topCount++;           // top 5%
            if (pctile >= 0.40 && pctile <= 0.60) deadZoneCount++;  // dead zone
          }
          const pTop5 = topCount / n;
          const pMedian = Math.max(0.01, deadZoneCount / n); // floor to avoid div/0
          simBoomBust = pTop5 / pMedian; // raw ratio — will be normalized across candidates
        }

        // Store sim dimensions on lineup for debugging/export
        lineup.simROI = simROI;
        lineup.simUpside = simUpside;
        lineup.simBoomBust = simBoomBust;
        lineup.simFirst = simResult.pFirst;

        // Blended score: heuristic already penalizes ownership via convex ownershipScore
        // Note: simFirst is normalized to 0-1 across candidates in the post-normalization pass below.
        // The raw pFirst value here is just stored for normalization — no pre-scaling needed.
        const simPart = simROI * SIM_ROI_WEIGHT + simUpside * SIM_UPSIDE_WEIGHT + simBoomBust * SIM_BOOMBUST_WEIGHT + simResult.pFirst * SIM_FIRST_WEIGHT;
        const rawBlended = heuristicScore * (1 - SIM_WEIGHT_FRACTION) + simPart;
        // Post-sim chalk/unique adjustments: full multiplicative impact on blended score
        const chalkMult = skipChalkPenalty ? 1 : (1 - (lineup.chalkPenaltyPct || 0));
        const uniqueMult = 1 + (lineup.uniqueCoreBonusPct || 0);
        lineup.totalScore = rawBlended * chalkMult * uniqueMult;
        simAttached++;

        // ALL candidates have finish vectors in uniform mode
        if (simResult.finishPositionVector) {
          simFinishVectors.set(lineup.hash, simResult.finishPositionVector);
        }
      }
    }

    // Normalize simBoomBust, simUpside, simFirst to 0-1 across candidates
    // Without normalization, raw pTop1Pct (0.01-0.05) and pFirst (0.0001-0.001)
    // are dwarfed by already-normalized simROI (0-1), making their weights dead.
    let minBoomBust = Infinity, maxBoomBust = -Infinity;
    let minUpside = Infinity, maxUpside = -Infinity;
    let minFirst = Infinity, maxFirst = -Infinity;
    for (const lineup of simCandidates) {
      if (lineup.simBoomBust !== undefined) {
        minBoomBust = Math.min(minBoomBust, lineup.simBoomBust);
        maxBoomBust = Math.max(maxBoomBust, lineup.simBoomBust);
      }
      if (lineup.simUpside !== undefined) {
        minUpside = Math.min(minUpside, lineup.simUpside);
        maxUpside = Math.max(maxUpside, lineup.simUpside);
      }
      if (lineup.simFirst !== undefined) {
        minFirst = Math.min(minFirst, lineup.simFirst);
        maxFirst = Math.max(maxFirst, lineup.simFirst);
      }
    }
    const boomBustRange = maxBoomBust - minBoomBust || 1;
    const upsideRange = maxUpside - minUpside || 1;
    const firstRange = maxFirst - minFirst || 1;

    for (const lineup of simCandidates) {
      if (lineup.simBoomBust !== undefined && lineup.heuristicScore !== undefined) {
        const normalizedBB = (lineup.simBoomBust - minBoomBust) / boomBustRange;
        const normalizedUpside = lineup.simUpside !== undefined
          ? (lineup.simUpside - minUpside) / upsideRange : 0;
        const normalizedFirst = lineup.simFirst !== undefined
          ? (lineup.simFirst - minFirst) / firstRange : 0;
        lineup.simBoomBust = normalizedBB;
        lineup.simUpside = normalizedUpside;
        lineup.simFirst = normalizedFirst;
        const simPart = (lineup.simROI || 0) * SIM_ROI_WEIGHT +
                        normalizedUpside * SIM_UPSIDE_WEIGHT +
                        normalizedBB * SIM_BOOMBUST_WEIGHT +
                        normalizedFirst * SIM_FIRST_WEIGHT;
        const rawBlended = lineup.heuristicScore * (1 - SIM_WEIGHT_FRACTION) + simPart;
        // Post-sim chalk/unique adjustments
        const chalkMult2 = skipChalkPenalty ? 1 : (1 - (lineup.chalkPenaltyPct || 0));
        const uniqueMult2 = 1 + (lineup.uniqueCoreBonusPct || 0);
        lineup.totalScore = rawBlended * chalkMult2 * uniqueMult2;
      }
    }

    // Re-sort by blended score
    simCandidates.sort((a, b) => {
      const diff = b.totalScore - a.totalScore;
      if (Math.abs(diff) < 1e-10) {
        return (b.heuristicScore || 0) - (a.heuristicScore || 0);
      }
      return diff;
    });

    console.log(`  Blended score: ${((1 - SIM_WEIGHT_FRACTION) * 100).toFixed(0)}% heuristic + ${(SIM_WEIGHT_FRACTION * 100).toFixed(0)}% sim (first=${SIM_FIRST_WEIGHT}, upside=${SIM_UPSIDE_WEIGHT}, boomBust=${SIM_BOOMBUST_WEIGHT}, roi=${SIM_ROI_WEIGHT})`);
    console.log(`  Simulation attached to ${simAttached} lineups`);
    console.log(`  Finish vectors stored: ${simFinishVectors.size} (all candidates)`);

    // === STAGE 2: Deep simulation for top candidates ===
    // Run ~16K additional sims for top 500 candidates to get reliable tail estimates.
    // Testing showed 750 candidates hurt performance vs 500 (dilutes deep sim benefit).
    const STAGE2_TOP_N = Math.min(500, Math.floor(simCandidates.length * 0.10));
    const STAGE2_SIMS_PER_ENV = 5333; // 5333 * 3 environments ≈ 16000 additional sims

    if (STAGE2_TOP_N >= 100) {
      // Take top candidates by blended score
      const stage2Candidates = simCandidates.slice(0, STAGE2_TOP_N);
      console.log(`\n--- STAGE 2: DEEP SIMULATION (top ${STAGE2_TOP_N} candidates × ${STAGE2_SIMS_PER_ENV * fieldEnvironments.length} sims) ---`);

      // Build deep-sim environments with more sims per field
      const deepEnvs: FieldEnvironment[] = fieldEnvironments.map(env => ({
        ...env,
        simsPerField: STAGE2_SIMS_PER_ENV,
      }));

      const deepResult = simulateMultiField(
        stage2Candidates,
        allPlayers,
        deepEnvs,
        {
          fieldSize: 10000,
          entryFee: 20,
          payoutStructure: simPayoutStructure,
          sport,
        }
      );

      // Merge stage-1 and stage-2 results: weight stage-2 more heavily (4:1)
      // because it has 4x the sims and covers the same candidates
      const STAGE1_WEIGHT = 0.2;
      const STAGE2_WEIGHT = 0.8;
      const stage2TotalSims = STAGE2_SIMS_PER_ENV * fieldEnvironments.length;
      const stage1TotalSims = fieldEnvironments.reduce((s, e) => s + e.simsPerField, 0);

      let stage2Upgraded = 0;
      for (const lineup of stage2Candidates) {
        const s1 = simResults.get(lineup.hash);
        const s2 = deepResult.results.get(lineup.hash);
        if (!s1 || !s2) continue;

        // Weighted average of sim metrics
        const mergedROI = s1.expectedROI * STAGE1_WEIGHT + s2.expectedROI * STAGE2_WEIGHT;
        const mergedPFirst = s1.pFirst * STAGE1_WEIGHT + s2.pFirst * STAGE2_WEIGHT;
        const mergedPTop1 = s1.pTop1Pct * STAGE1_WEIGHT + s2.pTop1Pct * STAGE2_WEIGHT;
        const mergedPTop5 = s1.pTop5Pct * STAGE1_WEIGHT + s2.pTop5Pct * STAGE2_WEIGHT;
        const mergedPayout = s1.expectedPayout * STAGE1_WEIGHT + s2.expectedPayout * STAGE2_WEIGHT;

        // Update stage-1 results with merged values
        s1.expectedROI = mergedROI;
        s1.pFirst = mergedPFirst;
        s1.pTop1Pct = mergedPTop1;
        s1.pTop5Pct = mergedPTop5;
        s1.expectedPayout = mergedPayout;
        s1.simulationScore = Math.min(1, Math.max(0, (mergedROI + 100) / 500));

        // Concatenate stage-2 finish vectors with stage-1 for higher-precision portfolio construction.
        // Stage-2 candidates get 10K vectors (2K stage-1 + 8K stage-2), others keep 2K.
        // Portfolio greedy uses weight-averaged marginal: 30% from shared 2K + 70% from extra 8K.
        const s2FinishVec = s2.finishPositionVector;
        if (s2FinishVec) {
          const s1Vec = simFinishVectors.get(lineup.hash);
          if (s1Vec) {
            const s1Len = s1Vec.length;
            const s2Len = s2FinishVec.length;
            const combined = new Float32Array(s1Len + s2Len);
            if (s1Vec instanceof Float32Array) {
              combined.set(s1Vec);
            } else {
              for (let vi = 0; vi < s1Len; vi++) combined[vi] = s1Vec[vi];
            }
            if (s2FinishVec instanceof Float32Array) {
              combined.set(s2FinishVec, s1Len);
            } else {
              for (let vi = 0; vi < s2Len; vi++) combined[s1Len + vi] = s2FinishVec[vi];
            }
            simFinishVectors.set(lineup.hash, combined);
          }
        }

        // Update sim dimensions with merged values for later re-blend
        lineup.simROI = mergedROI; // store raw — will re-normalize below
        lineup.simUpside = mergedPTop1;
        lineup.simFirst = mergedPFirst;
        lineup.simBoomBust = lineup.simBoomBust || 0.5;
        stage2Upgraded++;
      }

      // Bug 3 fix: recompute ROI range from merged values (stage-1 range may not cover merged)
      let minROI2 = Infinity, maxROI2 = -Infinity;
      for (const lineup of stage2Candidates) {
        const s1 = simResults.get(lineup.hash);
        if (s1) {
          minROI2 = Math.min(minROI2, s1.expectedROI);
          maxROI2 = Math.max(maxROI2, s1.expectedROI);
        }
      }
      const roiRange2 = maxROI2 - minROI2 || 1;
      for (const lineup of stage2Candidates) {
        const s1 = simResults.get(lineup.hash);
        if (s1) {
          lineup.simROI = Math.max(0, Math.min(1, (s1.expectedROI - minROI2) / roiRange2));
        }
      }

      // Re-normalize boomBust, simUpside, simFirst across ALL candidates
      // (stage-2 candidates have new merged values that need re-normalization)
      let minBB2 = Infinity, maxBB2 = -Infinity;
      let minUp2 = Infinity, maxUp2 = -Infinity;
      let minF2 = Infinity, maxF2 = -Infinity;
      for (const lineup of simCandidates) {
        if (lineup.simBoomBust !== undefined) {
          minBB2 = Math.min(minBB2, lineup.simBoomBust);
          maxBB2 = Math.max(maxBB2, lineup.simBoomBust);
        }
        if (lineup.simUpside !== undefined) {
          minUp2 = Math.min(minUp2, lineup.simUpside);
          maxUp2 = Math.max(maxUp2, lineup.simUpside);
        }
        if (lineup.simFirst !== undefined) {
          minF2 = Math.min(minF2, lineup.simFirst);
          maxF2 = Math.max(maxF2, lineup.simFirst);
        }
      }
      const bbRange2 = maxBB2 - minBB2 || 1;
      const upRange2 = maxUp2 - minUp2 || 1;
      const fRange2 = maxF2 - minF2 || 1;
      for (const lineup of simCandidates) {
        if (lineup.simBoomBust !== undefined && lineup.heuristicScore !== undefined) {
          const normalizedBB = (lineup.simBoomBust - minBB2) / bbRange2;
          const normalizedUpside = lineup.simUpside !== undefined
            ? (lineup.simUpside - minUp2) / upRange2 : 0;
          const normalizedFirst = lineup.simFirst !== undefined
            ? (lineup.simFirst - minF2) / fRange2 : 0;
          lineup.simBoomBust = normalizedBB;
          lineup.simUpside = normalizedUpside;
          lineup.simFirst = normalizedFirst;
          // Both stage-1 and stage-2 use same 50/50 blend (stage-2 has better sim estimates)
          const isStage2 = deepResult.results.has(lineup.hash);
          const weight = SIM_WEIGHT_FRACTION;
          // Post-sim chalk/unique adjustments
          const chalkMult3 = skipChalkPenalty ? 1 : (1 - (lineup.chalkPenaltyPct || 0));
          const uniqueMult3 = 1 + (lineup.uniqueCoreBonusPct || 0);
          if (isStage2) {
            // Stage-2: pFirst-dominant with reliable tail estimates from 16K sims
            const simPart2 = (lineup.simROI || 0) * 0.12 +
                            normalizedUpside * 0.15 +
                            normalizedBB * 0.05 +
                            normalizedFirst * 0.23;
            const rawBlended2 = lineup.heuristicScore * (1 - weight) + simPart2;
            lineup.totalScore = rawBlended2 * chalkMult3 * uniqueMult3;
          } else {
            // Stage-1: use original weights
            const simPart2 = (lineup.simROI || 0) * SIM_ROI_WEIGHT +
                            normalizedUpside * SIM_UPSIDE_WEIGHT +
                            normalizedBB * SIM_BOOMBUST_WEIGHT +
                            normalizedFirst * SIM_FIRST_WEIGHT;
            const rawBlended2 = lineup.heuristicScore * (1 - weight) + simPart2;
            lineup.totalScore = rawBlended2 * chalkMult3 * uniqueMult3;
          }
        }
      }

      // Re-sort
      simCandidates.sort((a, b) => {
        const diff = b.totalScore - a.totalScore;
        if (Math.abs(diff) < 1e-10) return (b.heuristicScore || 0) - (a.heuristicScore || 0);
        return diff;
      });

      console.log(`  Stage 2 complete: ${stage2Upgraded} candidates upgraded with ${stage1TotalSims + stage2TotalSims} total sims`);

      // Keep original game state matrix for portfolio clustering (consistent with stage-1 finish vectors)
    }

    // Use simCandidates as the pool for Phase 4
    scoredLineups.length = 0;
    scoredLineups.push(...simCandidates);

    } else {
      // === PURE HEURISTIC MODE (no simulation) ===
      // GPP EV ratio formula handles quality/ownership tradeoff directly.
      // Just apply chalk/unique multipliers to the full scored pool.
      console.log(`\n--- PURE HEURISTIC MODE (simulation disabled) ---`);
      for (const lineup of scoredLineups) {
        lineup.heuristicScore = lineup.totalScore;
        const chalkMultH = skipChalkPenalty ? 1 : (1 - (lineup.chalkPenaltyPct || 0));
        const uniqueMultH = 1 + (lineup.uniqueCoreBonusPct || 0);
        lineup.totalScore = lineup.totalScore * chalkMultH * uniqueMultH;
      }
      scoredLineups.sort((a, b) => b.totalScore - a.totalScore);
      console.log(`  ${scoredLineups.length} candidates scored with pure heuristic`);
    }

  } else {
    // ============================================================
    // TIERED MODE (legacy): Tiered simulation → 70/30 blend
    // ============================================================
    if (adaptedWeights.simulationScore > 0) {
      console.log(`\n--- TIERED TOURNAMENT SIMULATION ---`);

      const simResults = simulateTiered(
        scoredLineups,
        allPlayers,
        syntheticField,
        {
          tier1Count: 15000,
          tier1Sims: 2000,
          tier2Count: 15000,
          tier2Sims: 200,
          tier3Sims: 50,
          fieldSize: 10000,
          entryFee: 20,
          payoutStructure: simPayoutStructure,
          sport,
        }
      );

      let simAttached = 0;
      let minPayout = Infinity;
      let maxPayout = -Infinity;

      for (const lineup of scoredLineups) {
        const simResult = simResults.get(lineup.hash);
        if (simResult) {
          minPayout = Math.min(minPayout, simResult.expectedPayout);
          maxPayout = Math.max(maxPayout, simResult.expectedPayout);
        }
      }

      const payoutRange = maxPayout - minPayout || 1;

      for (const lineup of scoredLineups) {
        const simResult = simResults.get(lineup.hash);
        if (simResult) {
          const normalizedChipEquity = (simResult.expectedPayout - minPayout) / payoutRange;

          // Legacy: 70% simulation + 30% heuristic blend
          const heuristicScore = lineup.totalScore;
          lineup.totalScore = normalizedChipEquity * 0.70 + heuristicScore * 0.30;
          simAttached++;

          if (simResult.finishPositionVector) {
            simFinishVectors.set(lineup.hash, simResult.finishPositionVector);
          }
        }
      }

      // Apply chalk/unique penalties in tiered mode too (Bug 1 fix)
      for (const lineup of scoredLineups) {
        const chalkMultT = skipChalkPenalty ? 1 : (1 - (lineup.chalkPenaltyPct || 0));
        lineup.totalScore *= chalkMultT * (1 + (lineup.uniqueCoreBonusPct || 0));
      }

      scoredLineups.sort((a, b) => b.totalScore - a.totalScore);

      let tier1 = 0, tier2 = 0, tier3 = 0;
      for (const result of simResults.values()) {
        if (result.tier === 'full') tier1++;
        else if (result.tier === 'quick') tier2++;
        else tier3++;
      }
      console.log(`  Simulation attached to ${simAttached} lineups`);
      console.log(`  Tier distribution: ${tier1} full, ${tier2} quick, ${tier3} ultra`);
      console.log(`  Finish vectors stored: ${simFinishVectors.size} (for portfolio optimization)`);
    }
  }

  // ============================================================
  // PHASE 4: PORTFOLIO-OPTIMIZED SELECTION
  // ============================================================
  console.log(`\n--- PORTFOLIO-OPTIMIZED SELECTION ---`);

  // Team limit filter first (DraftKings max 4 per team)
  const maxPlayersPerTeam = params.maxPlayersPerTeam;
  let eligibleLineups = scoredLineups;
  if (maxPlayersPerTeam) {
    const beforeCount = eligibleLineups.length;
    eligibleLineups = scoredLineups.filter(lineup => {
      const teamCounts = new Map<string, number>();
      for (const player of lineup.players) {
        const count = (teamCounts.get(player.team) || 0) + 1;
        if (count > maxPlayersPerTeam) return false;
        teamCounts.set(player.team, count);
      }
      return true;
    });
    console.log(`Team filter: ${beforeCount - eligibleLineups.length} lineups removed (>${maxPlayersPerTeam} from same team)`);
  }

  // Compute field exposure from synthetic field
  const fieldExposureCounts = new Map<string, number>();
  for (const fieldLineup of syntheticField) {
    for (const playerId of fieldLineup.playerIds) {
      fieldExposureCounts.set(playerId, (fieldExposureCounts.get(playerId) || 0) + 1);
    }
  }
  const fieldOwnership = new Map<string, number>();
  for (const [playerId, count] of fieldExposureCounts) {
    fieldOwnership.set(playerId, count / syntheticField.length);
  }

  // Log top field exposures
  const topFieldExp = [...fieldOwnership.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  console.log(`Field exposures: ${topFieldExp.map(([id, exp]) => {
    const p = allPlayers.find(p => p.id === id);
    return `${p?.name?.split(' ').pop() || id}: ${(exp * 100).toFixed(1)}%`;
  }).join(', ')}`);

  const actualTarget = Math.min(CONFIG.ELITE_MAX, targetCount, eligibleLineups.length);
  const minRequired = Math.min(2500, actualTarget);

  let selected: ScoredLineup[] = [];

  if (simMode === 'none') {
    // ============================================================
    // NO-SIM: Heuristic diversity selection (no simulation data)
    // ============================================================
    console.log(`\n  Heuristic diversity selection (target: ${actualTarget})`);
    selected = selectWithDiversity(
      eligibleLineups,
      actualTarget,
      minRequired,
      baseline,
      allPlayers,
      onProgress,
      fieldOwnership,
      numGames,
      undefined,  // no finish vectors
      undefined,  // no payout structure
      fieldCombos.pairs,
      deepComboAnalysis,
      isShowdown,
      isSingleGame,
      constrainedPool,
      sport,
      fieldCombos.triples,
      fieldCombos.quads,
      fieldCombos.quints,
      isShortSlate,
      selConfig
    );
    console.log(`  Diversity selection: ${selected.length} lineups selected`);

  } else if (simMode === 'uniform') {
    // ============================================================
    // UNIFORM: Sim-scored diversity selection (sim scores already blended into totalScore)
    // Portfolio greedy was too slow (O(target × candidates × sims)); the Pareto filter
    // + per-step Pareto check in selectWithDiversity achieve the same quality faster.
    // ============================================================
    console.log(`\n  Sim-scored diversity selection (target: ${actualTarget})`);
    selected = selectWithDiversity(
      eligibleLineups,
      actualTarget,
      minRequired,
      baseline,
      allPlayers,
      onProgress,
      fieldOwnership,
      numGames,
      simFinishVectors,
      simPayoutStructure,
      fieldCombos.pairs,
      deepComboAnalysis,
      isShowdown,
      isSingleGame,
      constrainedPool,
      sport,
      fieldCombos.triples,
      fieldCombos.quads,
      fieldCombos.quints,
      isShortSlate,
      selConfig
    );
    console.log(`  Diversity selection: ${selected.length} lineups selected`);

  } else {
    // ============================================================
    // TIERED (legacy): Now uses same diversity selection path
    // ============================================================
    console.log(`\n  Tiered diversity selection (target: ${actualTarget})`);
    selected = selectWithDiversity(
      eligibleLineups,
      actualTarget,
      minRequired,
      baseline,
      allPlayers,
      onProgress,
      fieldOwnership,
      numGames,
      simFinishVectors,
      simPayoutStructure,
      fieldCombos.pairs,
      deepComboAnalysis,
      isShowdown,
      isSingleGame,
      constrainedPool,
      sport,
      fieldCombos.triples,
      fieldCombos.quads,
      fieldCombos.quints,
      isShortSlate,
      selConfig
    );
    console.log(`  Diversity selection: ${selected.length} lineups selected`);
  }

  // ============================================================
  // PHASE 4.5: UNIVERSAL PARETO SWEEP
  // ============================================================
  // Final sweep across ALL selection modes to remove dominated lineups
  // (lower projection AND higher ownership than another selected lineup)
  {
    const preSweepCount = selected.length;
    const withOwn = selected.map(l => {
      const n = l.players.length;
      const logSum = l.players.reduce((sum: number, p: any) => sum + Math.log(Math.max(0.5, p.ownership)), 0);
      const geoMeanOwn = Math.exp(logSum / n);
      return { lineup: l, geoMeanOwn };
    });
    // Sort by projection descending
    withOwn.sort((a, b) => b.lineup.projection - a.lineup.projection);

    let minGeoMeanSeen = Infinity;
    const surviving: ScoredLineup[] = [];
    for (const item of withOwn) {
      if (item.geoMeanOwn <= minGeoMeanSeen + getOwnMargin(numGames)) {
        surviving.push(item.lineup);
      }
      minGeoMeanSeen = Math.min(minGeoMeanSeen, item.geoMeanOwn);
    }

    const sweepRemoved = preSweepCount - surviving.length;
    console.log(`\n  Universal Pareto sweep: removed ${sweepRemoved} dominated lineups (${surviving.length} remain)`);
    selected = surviving;
  }

  // ============================================================
  // PHASE 5: BUILD RESULT
  // ============================================================
  const exposures = calculateExposures(selected);
  const avgProjection = selected.reduce((sum, l) => sum + l.projection, 0) / selected.length;
  const avgOwnership = selected.reduce((sum, l) => sum + l.ownershipScore, 0) / selected.length;

  // Build metrics data for export
  const metricsData = buildMetricsData(selected, scoredLineups, efficientFrontier);

  // Calculate portfolio diversity stats
  const uniquePlayers = new Set<string>();
  const uniquePairs = new Set<string>();
  const uniqueTriples = new Set<string>();
  for (const lineup of selected) {
    const ids = lineup.players.map(p => p.id).sort();
    for (let i = 0; i < ids.length; i++) {
      uniquePlayers.add(ids[i]);
      for (let j = i + 1; j < ids.length; j++) {
        uniquePairs.add(`${ids[i]}|${ids[j]}`);
        for (let k = j + 1; k < ids.length; k++) {
          uniqueTriples.add(`${ids[i]}|${ids[j]}|${ids[k]}`);
        }
      }
    }
  }

  // Lineup-level ownership comparison: portfolio vs top-N optimal lineups
  const portfolioGeoMeans = selected.map(l => calculateGeometricMeanOwnership(l));
  const portfolioAvgGeoMean = portfolioGeoMeans.reduce((s, v) => s + v, 0) / portfolioGeoMeans.length;
  const topNCount = Math.min(selected.length, scoredLineups.length);
  const topNByProj = [...scoredLineups].sort((a, b) => b.projection - a.projection).slice(0, topNCount);
  const topNGeoMeans = topNByProj.map(l => calculateGeometricMeanOwnership(l));
  const topNAvgGeoMean = topNGeoMeans.reduce((s, v) => s + v, 0) / topNGeoMeans.length;

  console.log(`\n--- SELECTION COMPLETE ---`);
  console.log(`Selected: ${selected.length} lineups`);
  console.log(`Avg projection: ${avgProjection.toFixed(2)}`);
  console.log(`Avg geoMean ownership:  portfolio ${portfolioAvgGeoMean.toFixed(2)}%  vs  top ${topNCount} by proj ${topNAvgGeoMean.toFixed(2)}%  (${((1 - portfolioAvgGeoMean / topNAvgGeoMean) * 100).toFixed(1)}% lower)`);
  console.log(`Unique players: ${uniquePlayers.size}`);
  console.log(`Unique 2-player combos: ${uniquePairs.size.toLocaleString()}`);
  console.log(`Unique 3-player combos: ${uniqueTriples.size.toLocaleString()}`);

  // Log top player exposures in final portfolio
  console.log(`\n--- PORTFOLIO EXPOSURES ---`);
  const topExp = [...exposures.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  for (const [playerId, exp] of topExp) {
    const player = allPlayers.find(p => p.id === playerId);
    const name = player?.name || playerId;
    const projOwn = player?.ownership || 0;
    console.log(`  ${name.padEnd(25)} ${exp.toFixed(1).padStart(5)}% (field: ${projOwn.toFixed(1)}%)`);
  }

  // Log top sim-scoring lineups (best GPP candidates by simulation performance)
  const simSorted = [...selected].filter(l => l.simUpside !== undefined).sort((a, b) => {
    // Sort by totalScore (blended sim+heuristic) descending
    return (b.totalScore || 0) - (a.totalScore || 0);
  });
  if (simSorted.length > 0) {
    console.log(`\n--- TOP 10 SIM LINEUPS (best blended score) ---`);
    for (let i = 0; i < Math.min(10, simSorted.length); i++) {
      const l = simSorted[i];
      const players = l.players.map(p => {
        const last = p.name?.split(' ').pop() || p.id;
        return last;
      }).join(', ');
      console.log(`  #${(i + 1).toString().padStart(2)} | Score: ${(l.totalScore || 0).toFixed(4)} | Proj: ${l.projection.toFixed(1)} | ROI: ${((l.simROI || 0) * 100).toFixed(0)}% | Upside: ${((l.simUpside || 0) * 100).toFixed(1)}% | BB: ${((l.simBoomBust || 0) * 100).toFixed(0)}%`);
      console.log(`       ${players}`);
    }
  }

  return {
    selected,
    exposures,
    avgProjection,
    avgOwnership,
    metricsData,
  };
}

// ============================================================
// SCORING FUNCTIONS
// ============================================================

export function scoreAllLineups(
  lineups: Lineup[],
  baseline: ReturnType<typeof calculateBaselineMetrics>,
  fieldCombos: FieldComboAnalysis,
  overlapIndex: FieldOverlapIndex,
  maxCeiling: number,
  efficientFrontier: Set<string>,
  minProj: number,
  maxProj: number,
  deepComboAnalysis: DeepComboAnalysis | null = null,
  projectionEdgeAnalysis: ProjectionEdgeAnalysis | null = null,
  salaryCap: number = 50000,
  numGames: number = 5,
  weights?: OptimizedWeights,
  ownershipScenarios?: OwnershipScenario[],
  baselineOwnership?: Map<string, number>,
  justifiedOwnershipAnalysis?: JustifiedOwnershipAnalysis
): ScoredLineup[] {
  // Pre-pass: find ceiling sum range across all lineups for proper normalization
  let poolMinCeiling = Infinity;
  let poolMaxCeiling = -Infinity;
  for (const lineup of lineups) {
    const vd = calculateVarianceScore(lineup);
    if (vd.ceiling < poolMinCeiling) poolMinCeiling = vd.ceiling;
    if (vd.ceiling > poolMaxCeiling) poolMaxCeiling = vd.ceiling;
  }
  const ceilingRange = poolMaxCeiling - poolMinCeiling;

  return lineups.map((lineup, index) => {
    // Core scores
    const projectionScore = normalizeProjectionScore(lineup.projection, minProj, maxProj);
    const rawOwnershipScore = calculateOwnershipScore(lineup);
    // Justified ownership adjustment: reduce penalty for lineups where chalk is projection-justified
    const justifiedFactor = justifiedOwnershipAnalysis
      ? calculateJustifiedOwnershipFactor(lineup, justifiedOwnershipAnalysis)
      : 1.0;
    // Blend: justified chalk gets partial penalty reduction (factor ranges 0.80-1.0)
    // ownershipScore is inverted (low ownership = high score), so we reduce the PENALTY part
    const ownershipScore = 1.0 - (1.0 - rawOwnershipScore) * justifiedFactor;
    const varianceData = calculateVarianceScore(lineup);

    // Field overlap leverage: ceiling-weighted contrarian + combo uniqueness
    // Captures both quality differentiation (boom potential in non-chalk players)
    // AND structural differentiation (unique player combinations vs field).
    const leverageScore = calculateFieldOverlapScore(lineup, overlapIndex, maxCeiling, fieldCombos.pairs);

    // Ceiling score: LINEUP-LEVEL boom potential
    // Combines range-based normalization with a p99 boom ratio bonus.
    // We evaluate the LINEUP's total boom, not individual player ceilings,
    // because a lineup with one huge boomer + cheap filler can still win.
    const baseCeilingScore = ceilingRange > 0
      ? Math.max(0, Math.min(1, (varianceData.ceiling - poolMinCeiling) / ceilingRange))
      : 0.5;

    // Lineup-level boom ratio: sum(p99) / sum(projection)
    // Higher ratio = more explosive lineup when things break right
    // A lineup that can 1.7x its projection is much more dangerous than 1.5x
    const lineupP99 = lineup.players.reduce((s, p) =>
      s + (p.ceiling99 || (p.ceiling || p.projection * 1.25) * 1.15), 0);
    const lineupBoomRatio = lineupP99 / Math.max(1, lineup.projection);

    // Normalize boom ratio: 1.55x = 0.0, 1.75x+ = 1.0 (typical NBA range)
    const boomBonus = Math.max(0, Math.min(1, (lineupBoomRatio - 1.55) / 0.20));

    // Correlated ceiling: game stacks with high-ceiling players have multiplicative upside
    // Independent ceiling scoring misses the fact that a LAL 3-stack where each player
    // has 1.4x ceiling ratio has a combined correlated ceiling much higher than 3 independent players
    const correlatedCeiling = calculateCorrelatedCeilingScore(lineup);

    // Blend: 35% range-based ceiling + 25% boom ratio + 40% correlated ceiling
    // Higher correlated weight aligns heuristic with sim's correlated upside model
    const ceilingScore = baseCeilingScore * 0.35 + boomBonus * 0.25 + correlatedCeiling * 0.40;

    // Salary efficiency: smooth quadratic decay for wasted salary
    // Small amounts left ($0-300) barely matter, past ~3.6% of cap drops off sharply
    const salaryLeft = salaryCap - lineup.salary;
    const salaryWasteThreshold = salaryCap * 0.036; // $1800 for $50K cap, $2160 for $60K
    const x = Math.min(1, salaryLeft / salaryWasteThreshold); // 0 = perfect, 1 = threshold+ wasted
    const salaryEfficiencyScore = Math.max(0.1, 1 - x * x);

    // Relative value
    const relativeValue = calculateRelativeValue(
      lineup,
      baseline.optimalProjection,
      baseline.optimalOwnership
    );

    // Anti-correlation: structural uniqueness vs field (how few field lineups share 4+ players)
    const antiCorrelationScore = calculateFieldAntiCorrelation(lineup, overlapIndex);

    // Full overlap metrics: severity, max overlap, near-duplicate rate
    const overlapMetrics = calculateFieldOverlapMetrics(lineup, overlapIndex);

    // Projection edge: our projection vs field-implied projection
    // Rewards lineups with players where we have an edge over field expectations
    const projectionEdgeScore = projectionEdgeAnalysis
      ? calculateLineupProjectionEdgeScore(lineup, projectionEdgeAnalysis)
      : 0.5;

    // Game stacking score: correlated upside from same-game players
    // 3+ players from same game = correlated boom potential
    // Bring-back bonus: players from BOTH sides of a game (pace/OT correlation)
    const gameStackScore = calculateGameStackScore(lineup, numGames);

    // Ownership robustness: how robust is this lineup's leverage across ownership scenarios
    const ownershipRobustnessScore = (ownershipScenarios && baselineOwnership)
      ? calculateOwnershipRobustness(lineup, ownershipScenarios, baselineOwnership)
      : 0.5;

    // Calculate geoMean ownership for scoring
    const geoMeanOwn = calculateGeometricMeanOwnership(lineup);

    // Ceiling ratio: boom potential as ratio (pro winners: 1.298 vs field 1.259)
    const ceilingRatioScoreVal = calculateCeilingRatioScore(lineup);

    // Game environment: high-total games produce more DFS points
    const gameEnvironmentScoreVal = calculateGameEnvironmentScore(lineup);

    // Calculate BASE total score using additive data-driven weights
    const baseScore = calculateTotalScore(
      projectionScore,
      ownershipScore,
      leverageScore,
      varianceData.score,
      relativeValue.relativeValueScore,
      ceilingScore,
      salaryEfficiencyScore,
      antiCorrelationScore,
      projectionEdgeScore,
      ownershipRobustnessScore,
      weights,
      geoMeanOwn,
      ceilingRatioScoreVal,
      gameEnvironmentScoreVal,
    );

    // CHALK PENALTY: Applied as a MULTIPLIER to the entire lineup score
    // Up to 15% reduction for lineups with common field combos
    const chalkPenaltyPct = calculateChalkPenalty(lineup, deepComboAnalysis, numGames, fieldCombos.pairs);

    // UNIQUE CORE BONUS: Reward lineups with rare 4/5-man cores
    // Up to 15% boost for lineups with differentiated combos
    const uniqueCoreBonusPct = calculateUniqueCoreBonusPct(lineup, deepComboAnalysis, numGames);

    // Penalize lineups that closely resemble field lineups
    // overlapSeverity of 0.5 → 6% penalty, 1.0 → 12% penalty
    const overlapPenalty = overlapMetrics.overlapSeverity * 0.12;

    // Game stack is structural (pre-sim); chalk/unique are combo-level (post-sim)
    const totalScore = baseScore * (1 + gameStackScore) * (1 - overlapPenalty);

    return {
      ...lineup,
      rank: index + 1,
      projectionScore,
      ownershipScore,
      leverageScore,
      diversityScore: 0, // Calculated during selection
      totalScore,
      overallRank: 0, // Set later
      ceilingScore, // Stored for archetype sorting
      chalkPenaltyPct,       // Applied post-sim as multiplicative adjustment
      uniqueCoreBonusPct,    // Applied post-sim as multiplicative adjustment
      fieldOverlapSeverity: overlapMetrics.overlapSeverity,
      fieldMaxOverlap: overlapMetrics.maxOverlap,
      fieldNearDupRate: overlapMetrics.nearDuplicateRate,
      relativeValueScore2: relativeValue.relativeValueScore,   // For pre-filter quotas
      projectionEdgeScore2: projectionEdgeScore,               // For pre-filter quotas
      varianceScore: varianceData.score,                       // For archetype scoring & pre-filter
    } as ScoredLineup;
  });
}

function calculateTotalScore(
  projectionScore: number,
  _ownershipScore: number,
  _leverageScore: number,
  varianceScore: number,
  relativeValueScore: number,
  ceilingScore: number = 0.5,
  salaryEfficiencyScore: number = 1.0,
  _antiCorrelationScore: number = 0.5,
  _projectionEdgeScore: number = 0.5,
  _ownershipRobustnessScore: number = 0.5,
  weights?: OptimizedWeights,
  _geoMeanOwn: number = 20,
  ceilingRatioScore: number = 0.5,
  gameEnvironmentScore: number = 0.5,
): number {
  // Optimized via coordinate descent on 12-slate backtest (242K entries).
  // Balances actual-points correlation AND GPP win differentiation.
  // relativeValue: -0.089 actual-pts corr BUT +10.2% winner diff (#1 differentiator).
  // Game stack applied multiplicatively in caller (not here).

  const w = weights || DEFAULT_WEIGHTS;

  // 7-component additive score (sweep-optimized weights)
  const baseScore = (
    projectionScore * (w.projectionScore || 0.085) +
    ceilingScore * (w.ceilingScore || 0.124) +
    varianceScore * (w.varianceScore || 0.226) +
    salaryEfficiencyScore * (w.salaryEfficiencyScore || 0.096) +
    relativeValueScore * (w.relativeValueScore || 0.469) +
    ceilingRatioScore * (w.ceilingRatioScore || 0) +
    gameEnvironmentScore * (w.gameEnvironmentScore || 0)
  );

  // Quality gate: projection and ceiling are non-negotiable
  // Thresholds from formula sweep (default to legacy values if not set)
  const projGateThresh = w.projGateThreshold || 0.50;
  const ceilGateThresh = w.ceilGateThreshold || 0.40;
  const projGate = Math.min(1, projectionScore / projGateThresh);
  const ceilGate = Math.min(1, ceilingScore / ceilGateThresh);
  const qualityGate = Math.sqrt(projGate * ceilGate);

  return baseScore * qualityGate;
}

/**
 * Calculate CHALK PENALTY as a percentage reduction for the entire lineup.
 *
 * If a lineup contains common 3/4/5-man combos (high frequency in BOTH pool AND field),
 * its ENTIRE score is reduced by this percentage.
 *
 * This makes chalk-heavy lineups compete at a disadvantage:
 * - A 300pt lineup with 20% chalk penalty scores like a 240pt lineup
 * - But if projection is high enough, it can still make the elite pool
 *
 * Penalty scales with combo size (deeper chalk = worse):
 * - 3-man chalk: Up to 8% penalty per combo (easy to differentiate - swap 1 player)
 * - 4-man chalk: Up to 12% penalty per combo (half lineup is chalk)
 * - 5-man chalk: Up to 15% penalty per combo (5/8 players locked in chalk)
 *
 * Maximum total penalty: 25% (applied post-sim as full multiplicative reduction)
 */
function calculateChalkPenalty(
  lineup: Lineup,
  deepAnalysis: DeepComboAnalysis | null,
  numGames: number = 5,
  fieldPairFreqs?: Map<string, number>
): number {
  // Scale penalty caps by slate size: small slates → reduced penalties, large slates → amplified
  const penaltyScaler = numGames <= 2 ? 0.60 : numGames <= 3 ? 0.75
    : numGames <= 5 ? 1.00 : Math.min(1.30, numGames / 5);

  const sortedIds = lineup.players.map(p => p.id).sort();
  const lineupIdSet = new Set(sortedIds);
  let totalPenalty = 0;

  // 2-man chalk penalty: penalize lineups built from the field's most common player pairs.
  // These are the building blocks of field overlap — even if a lineup avoids 3-man chalk cores,
  // having multiple common pairs means it's structurally similar to what the field is playing.
  // Up to 5% per pair, capped at 10% total from pairs alone.
  if (fieldPairFreqs) {
    let pairPenalty = 0;
    for (let i = 0; i < sortedIds.length; i++) {
      for (let j = i + 1; j < sortedIds.length; j++) {
        const pairKey = `${sortedIds[i]}|${sortedIds[j]}`;
        const fieldFreq = fieldPairFreqs.get(pairKey) || 0;
        if (fieldFreq > 0.03) {
          pairPenalty += Math.min(0.05 * penaltyScaler, fieldFreq * 0.15 * penaltyScaler);
        }
      }
    }
    totalPenalty += Math.min(0.10 * penaltyScaler, pairPenalty);
  }

  if (!deepAnalysis) {
    return Math.min(0.18 * penaltyScaler, totalPenalty);
  }

  // 3-man chalk penalty: up to 6% per combo
  if (deepAnalysis.universallyCommonCores3) {
    for (const core of deepAnalysis.universallyCommonCores3) {
      const hasCore = core.playerIds.every(id => lineupIdSet.has(id));
      if (hasCore) {
        const fieldFreq = core.fieldFrequency;
        const cw = core.correlationWeight || 1.0;
        totalPenalty += Math.min(0.06 * cw * penaltyScaler, fieldFreq * 1.2 * cw);
      }
    }
  }

  // 4-man chalk penalty: up to 10% per combo
  if (deepAnalysis.universallyCommonCores4) {
    for (const core of deepAnalysis.universallyCommonCores4) {
      const hasCore = core.playerIds.every(id => lineupIdSet.has(id));
      if (hasCore) {
        const fieldFreq = core.fieldFrequency;
        const cw = core.correlationWeight || 1.0;
        totalPenalty += Math.min(0.10 * cw * penaltyScaler, fieldFreq * 2.5 * cw);
      }
    }
  }

  // 5-man chalk penalty: up to 12% per combo
  if (deepAnalysis.universallyCommonCores5) {
    for (const core of deepAnalysis.universallyCommonCores5) {
      const hasCore = core.playerIds.every(id => lineupIdSet.has(id));
      if (hasCore) {
        const fieldFreq = core.fieldFrequency;
        const cw = core.correlationWeight || 1.0;
        totalPenalty += Math.min(0.12 * cw * penaltyScaler, fieldFreq * 5.0 * cw);
      }
    }
  }

  // Cap total penalty at 15%
  return Math.min(0.15 * penaltyScaler, totalPenalty);
}

/**
 * Calculate unique core bonus for lineups with differentiated 4/5-man cores.
 *
 * Rewards lineups that contain rare player combinations where our pool has
 * significantly higher frequency than the field. These represent our structural
 * edge — combinations the field isn't building but we are.
 *
 * - 4-man cores with >1% frequency gap: up to +8% bonus per core
 * - 5-man cores with >0.5% frequency gap: up to +12% bonus per core
 * - Total cap: +25% (applied post-sim as full multiplicative boost)
 */
function calculateUniqueCoreBonusPct(
  lineup: Lineup,
  deepAnalysis: DeepComboAnalysis | null,
  numGames: number = 5
): number {
  if (!deepAnalysis) return 0;

  // Scale bonus caps by slate size: small slates → reduced bonuses, large slates → amplified
  const bonusScaler = numGames <= 2 ? 0.70 : numGames <= 3 ? 0.85
    : numGames <= 5 ? 1.00 : Math.min(1.20, numGames / 5);

  const lineupIds = new Set(lineup.players.map(p => p.id));
  let totalBonus = 0;

  // 4-man unique cores: up to +12% per core
  if (deepAnalysis.cores4) {
    for (const core of deepAnalysis.cores4) {
      const hasCore = core.playerIds.every(id => lineupIds.has(id));
      if (hasCore && core.frequencyGap > 0.008) {
        const gapExcess = core.frequencyGap - 0.008;
        const cw = core.correlationWeight || 1.0;
        totalBonus += Math.min(0.12 * cw * bonusScaler, gapExcess * 1.5 * cw);
      }
    }
  }

  // 5-man unique cores: up to +18% per core
  if (deepAnalysis.cores5) {
    for (const core of deepAnalysis.cores5) {
      const hasCore = core.playerIds.every(id => lineupIds.has(id));
      if (hasCore && core.frequencyGap > 0.003) {
        const gapExcess = core.frequencyGap - 0.003;
        const cw = core.correlationWeight || 1.0;
        totalBonus += Math.min(0.18 * cw * bonusScaler, gapExcess * 3.0 * cw);
      }
    }
  }

  // E4: Cross-combo interaction bonus — reward lineups with multiple non-overlapping
  // differentiated cores that rarely co-occur in the field
  if (deepAnalysis.coreInteractions && deepAnalysis.coreInteractions.size > 0) {
    // Collect all differentiated cores present in this lineup
    const presentCores: { key: string; ids: Set<string> }[] = [];

    const allCores = [
      ...(deepAnalysis.cores3 || []),
      ...(deepAnalysis.cores4 || []),
      ...(deepAnalysis.cores5 || []),
    ];

    for (const core of allCores) {
      if (core.playerIds.every(id => lineupIds.has(id)) && core.frequencyGap > 0) {
        presentCores.push({
          key: core.playerIds.join('|'),
          ids: new Set(core.playerIds),
        });
      }
    }

    // Find best interaction bonus across non-overlapping core pairs
    let bestInteractionBonus = 0;
    for (let a = 0; a < presentCores.length; a++) {
      for (let b = a + 1; b < presentCores.length; b++) {
        // Check non-overlapping
        let overlaps = false;
        for (const id of presentCores[b].ids) {
          if (presentCores[a].ids.has(id)) { overlaps = true; break; }
        }
        if (overlaps) continue;

        // Look up co-occurrence frequency (check both orderings)
        const key1 = `${presentCores[a].key}||${presentCores[b].key}`;
        const key2 = `${presentCores[b].key}||${presentCores[a].key}`;
        const coFreq = deepAnalysis.coreInteractions.get(key1)
          ?? deepAnalysis.coreInteractions.get(key2)
          ?? undefined;

        if (coFreq !== undefined) {
          let bonus = 0;
          if (coFreq < 0.001) bonus = 0.10;       // Field almost never builds this structure
          else if (coFreq < 0.003) bonus = 0.07;
          else if (coFreq < 0.005) bonus = 0.04;

          if (bonus > bestInteractionBonus) {
            bestInteractionBonus = bonus;
          }
        }
      }
    }

    totalBonus += bestInteractionBonus * bonusScaler;
  }

  // Cap total bonus at 15%
  return Math.min(0.15 * bonusScaler, totalBonus);
}

// ============================================================
// GAME STACKING SCORE
// ============================================================

/**
 * Calculate game stacking bonus for correlated upside.
 *
 * In NBA DFS, players from the same game correlate because:
 * - High-scoring games boost ALL players (pace, OT potential)
 * - A "bring-back" (players from both sides) captures game environment upside
 *
 * Returns 0-0.15 bonus multiplier:
 * - 3+ from same game: base bonus
 * - Bring-back (both sides represented): additional bonus
 * - Scales down for small slates (where stacking is inevitable)
 */
function calculateGameStackScore(lineup: Lineup, numGames: number): number {
  // Calibrated from deep pro stacking analysis (12 slates, 44K+ pro lineups):
  //
  // Pro top-1% rates: 94% have 3+ stack, 55% have 4+, 93% have bring-backs.
  // Winners: 100% BB, 92% BB in 3+ stack, avg max stack 4.08.
  //
  // Key insight: bring-backs are CRITICAL. 81% of pro top-1% have BB in their primary 3+ stack.
  // Pro winning structures: 3-2-2-1 BB(2+1) 14%, 4-2-1-1 BB(3+1) 10%, 5-2-1 BB(4+1) 5%.
  // Players in stacks: lower salary ($5927 vs $6622), higher ceiling ratio (1.298 vs 1.259).
  //
  // Bonuses increased from previous values to properly reward stacking:
  // - 3-stack base: 0.05 → 0.08 (stacking IS predictive: +0.13 avg correlation across slates)
  // - 3-stack BB: 0.03 → 0.06 (BB in 3+ stack: 81% pro top-1% vs 66% field)
  // - 4+ stack base: 0.08 → 0.12
  // - 4+ stack BB: 0.04 → 0.07
  // Max bonus raised to 0.25 (was 0.18) — stacking is worth more than previously calibrated.

  // Compute average game total across lineup players for relative scaling
  let gameTotalSum = 0;
  let gameTotalCount = 0;
  for (const p of lineup.players) {
    if (p.gameTotal && p.gameTotal > 0) {
      gameTotalSum += p.gameTotal;
      gameTotalCount++;
    }
  }
  const slateAvgGameTotal = gameTotalCount > 0 ? gameTotalSum / gameTotalCount : 225;

  // Group players by game
  const gameGroups = new Map<string, { teams: Set<string>; count: number; gameTotal: number }>();
  for (const player of lineup.players) {
    const gameId = player.gameInfo || `${player.team}_game`;
    const group = gameGroups.get(gameId) || { teams: new Set(), count: 0, gameTotal: player.gameTotal || slateAvgGameTotal };
    group.teams.add(player.team);
    group.count++;
    gameGroups.set(gameId, group);
  }

  let stackBonus = 0;

  for (const [, group] of gameGroups) {
    // Scale bonus by game total relative to slate average
    const gameTotalScaler = group.gameTotal / slateAvgGameTotal;

    if (group.count >= 5) {
      stackBonus += 0.08 * gameTotalScaler;
      if (group.teams.size >= 2) {
        stackBonus += 0.25 * gameTotalScaler; // BB is king — 93% of pro top-1%
      }
    } else if (group.count >= 4) {
      stackBonus += 0.06 * gameTotalScaler;
      if (group.teams.size >= 2) {
        stackBonus += 0.22 * gameTotalScaler;
      }
    } else if (group.count >= 3) {
      // 3+BB is the dominant pro pattern (71% of winning stacks)
      stackBonus += 0.04 * gameTotalScaler;
      if (group.teams.size >= 2) {
        stackBonus += 0.20 * gameTotalScaler; // 3+BB = best structure
      }
    }
  }

  // Slate scaling: larger slates → stacking is rarer and more differentiating
  // Small slates (3-4 games): stacking is nearly universal (99% of pros), less differentiating
  // Medium slates (5-6 games): stacking separates pros from field
  // Large slates (7-8 games): stacking is most differentiating (83% pro vs 74% field)
  const slateScaler = numGames <= 3 ? 0.80 : numGames <= 4 ? 0.90 : numGames <= 6 ? 1.00 : 1.10;

  const maxStackBonus = 0.50;
  return Math.min(maxStackBonus, stackBonus * slateScaler);
}


// ============================================================
// PRE-ALLOCATION HELPERS
// ============================================================

/** Count players per game in a lineup, tracking which teams are represented */
function getLineupGameBreakdown(lineup: ScoredLineup): Map<string, { count: number; teams: Set<string> }> {
  const games = new Map<string, { count: number; teams: Set<string> }>();
  for (const player of lineup.players) {
    const gameId = player.gameInfo || `${player.team}_game`;
    const entry = games.get(gameId) || { count: 0, teams: new Set<string>() };
    entry.count++;
    entry.teams.add(player.team);
    games.set(gameId, entry);
  }
  return games;
}

/** Get the primary game a lineup stacks (3+ players), or null if no stack */
function getLineupPrimaryGame(lineup: ScoredLineup): string | null {
  const games = getLineupGameBreakdown(lineup);
  let bestGame: string | null = null;
  let bestCount = 0;
  for (const [gameId, info] of games) {
    if (info.count > bestCount) { bestCount = info.count; bestGame = gameId; }
  }
  return bestCount >= 3 ? bestGame : null;
}

/** Check if lineup has 3+ players from a specific game */
function isGameStack(lineup: ScoredLineup, targetGameId: string): boolean {
  const games = getLineupGameBreakdown(lineup);
  const entry = games.get(targetGameId);
  return entry !== undefined && entry.count >= 3;
}

/** Check if lineup has a bring-back (both teams) in a specific game stack */
function hasBringBack(lineup: ScoredLineup, targetGameId: string): boolean {
  const games = getLineupGameBreakdown(lineup);
  const entry = games.get(targetGameId);
  return entry !== undefined && entry.count >= 3 && entry.teams.size >= 2;
}

type SalaryStructure = 'stars-and-scrubs' | 'balanced' | 'mid-range';

function classifySalaryStructure(lineup: ScoredLineup): SalaryStructure {
  const salaries = lineup.players.map(p => p.salary).sort((a, b) => b - a);
  const n = salaries.length;

  // Stars-and-scrubs: top 2 avg salary > $10000 AND bottom 3 avg < $4800
  const top2Avg = (salaries[0] + salaries[1]) / 2;
  const bottom3Avg = (salaries[n - 1] + salaries[n - 2] + salaries[n - 3]) / 3;
  if (top2Avg >= 10000 && bottom3Avg <= 4800) return 'stars-and-scrubs';

  // Balanced: salary std dev < $1500 (relatively flat distribution)
  const mean = lineup.salary / n;
  const variance = lineup.players.reduce((sum, p) => sum + Math.pow(p.salary - mean, 2), 0) / n;
  if (Math.sqrt(variance) < 1500) return 'balanced';

  return 'mid-range';
}

/**
 * Calculate product ownership (probability field builds this exact lineup).
 * This is the product of all player ownerships as decimals.
 * Example: 6 players with 40%, 30%, 25%, 20%, 15%, 10% = 0.00009 = 0.009%
 */
function calculateProductOwnership(lineup: Lineup | ScoredLineup): number {
  let product = 1;
  for (const player of lineup.players) {
    // Convert percentage to decimal, clamp to avoid 0
    const own = Math.max(player.ownership / 100, 0.001);
    product *= own;
  }
  return product;
}

// ============================================================
// PRE-FILTER FOR SIMULATION (Uniform mode)
// ============================================================

/**
 * Pre-filter scored lineups to a manageable set for uniform simulation.
 * Uses archetype quotas to ensure every lineup type gets simulated,
 * not just the heuristic favorites.
 */
function preFilterForSimulation(
  scoredLineups: ScoredLineup[],
  targetCandidates: number = 10000
): ScoredLineup[] {
  // Adaptive target size based on pool
  const adaptiveTarget = Math.max(8000, Math.min(12000, Math.floor(scoredLineups.length * 0.50)));
  const target = Math.min(adaptiveTarget, targetCandidates);

  const seen = new Set<string>();
  const result: ScoredLineup[] = [];

  const addUnique = (lineup: ScoredLineup): boolean => {
    if (seen.has(lineup.hash)) return false;
    seen.add(lineup.hash);
    result.push(lineup);
    return true;
  };

  // Pre-compute variance scores for sorting (avoid recomputation in sort)
  const varianceScoreCache = new Map<string, number>();
  for (const lineup of scoredLineups) {
    const vd = calculateVarianceScore(lineup);
    varianceScoreCache.set(lineup.hash, vd.score);
  }

  // Quota allocation — ensures every lineup archetype gets simulated.
  // relativeValue is #1 top-1% differentiator (+9.8% vs field) and projEdge identifies
  // lineups where our projection beats field expectations — both critical for GPP.
  // Pre-filter quotas aligned with WINNER PROFILE (not just weight optimization):
  // relativeValue: +10.2% winner diff (#1 differentiator) — needs strong quota
  // gameStack: +9.4% winner diff — stacked lineups win GPPs
  // projection: +6.0% winner diff — still important but was over-allocated at 38%
  // ceiling: +4.5% winner diff — captured via projCeiling blend
  // Reduced projection dominance; boosted relativeValue and gameStack quotas.
  const quotas: Array<{ fraction: number; sortFn: (a: ScoredLineup, b: ScoredLineup) => number; label: string }> = [
    { fraction: 0.08, sortFn: (a, b) => b.totalScore - a.totalScore, label: 'totalScore' },
    { fraction: 0.25, sortFn: (a, b) => (b.projectionScore || 0) - (a.projectionScore || 0), label: 'projectionScore' },
    { fraction: 0.14, sortFn: (a, b) => {
      const aScore = (a.projectionScore || 0) * 0.50 + (a.ceilingScore || 0) * 0.40 + (a.varianceScore || 0) * 0.10;
      const bScore = (b.projectionScore || 0) * 0.50 + (b.ceilingScore || 0) * 0.40 + (b.varianceScore || 0) * 0.10;
      return bScore - aScore;
    }, label: 'projCeiling' },
    { fraction: 0.06, sortFn: (a, b) => b.salary - a.salary, label: 'salaryEfficiency' },
    { fraction: 0.13, sortFn: (a, b) => (b.relativeValueScore2 || 0) - (a.relativeValueScore2 || 0), label: 'relativeValue' },
    { fraction: 0.12, sortFn: (a, b) => {
      const aGs = a.constructionMethod === 'game-stack' ? 1 : 0;
      const bGs = b.constructionMethod === 'game-stack' ? 1 : 0;
      if (bGs !== aGs) return bGs - aGs;
      return b.totalScore - a.totalScore;
    }, label: 'gameStack' },
    { fraction: 0.08, sortFn: (a, b) => {
      const aComboLev = (a.uniqueCoreBonusPct || 0) - (a.chalkPenaltyPct || 0);
      const bComboLev = (b.uniqueCoreBonusPct || 0) - (b.chalkPenaltyPct || 0);
      if (Math.abs(bComboLev - aComboLev) > 0.001) return bComboLev - aComboLev;
      return b.totalScore - a.totalScore;
    }, label: 'comboLeverage' },
    { fraction: 0.06, sortFn: (a, b) => (varianceScoreCache.get(b.hash) || 0) - (varianceScoreCache.get(a.hash) || 0), label: 'varianceScore' },
  ];

  // Fill each quota
  for (const { fraction, sortFn, label } of quotas) {
    const quota = Math.ceil(target * fraction);
    const sorted = [...scoredLineups].sort(sortFn);
    let added = 0;
    for (const lineup of sorted) {
      if (added >= quota) break;
      if (addUnique(lineup)) added++;
    }
  }

  // Fill remaining with construction method diversity (game-stack, contrarian subtypes)
  const remaining = target - result.length;
  if (remaining > 0) {
    // Group by constructionMethod, pick top from each
    const byMethod = new Map<string, ScoredLineup[]>();
    for (const lineup of scoredLineups) {
      const method = lineup.constructionMethod || 'unknown';
      if (!byMethod.has(method)) byMethod.set(method, []);
      byMethod.get(method)!.push(lineup);
    }

    const methods = [...byMethod.keys()];
    let methodIdx = 0;
    let added = 0;
    let stale = 0;
    while (added < remaining && stale < methods.length * 2) {
      const method = methods[methodIdx % methods.length];
      const pool = byMethod.get(method)!;
      let found = false;
      for (const lineup of pool) {
        if (addUnique(lineup)) {
          added++;
          found = true;
          break;
        }
      }
      if (!found) stale++;
      else stale = 0;
      methodIdx++;
    }
  }

  console.log(`  Adaptive target: ${target} (pool ${scoredLineups.length.toLocaleString()})`);
  return result;
}

// ============================================================
// PAYOUT LOOKUP
// ============================================================

/** Look up payout for a given finish position using the payout structure */
function lookupPayout(position: number, payoutStructure: PayoutTier[]): number {
  for (const tier of payoutStructure) {
    if (position <= tier.maxPosition) {
      return tier.payout;
    }
  }
  return 0;
}

// ============================================================
// DIVERSITY-AWARE SELECTION
// ============================================================
// Selects lineups ensuring portfolio diversity while maintaining quality.
// Integrates soft proportional ownership filter during selection.

function selectWithDiversity(
  pool: ScoredLineup[],
  targetCount: number,
  minRequired: number,
  baseline: ReturnType<typeof calculateBaselineMetrics>,
  allPlayers: Player[],
  onProgress?: (progress: number, message: string) => void,
  fieldOwnership?: Map<string, number>,
  numGames: number = 5,
  simFinishVectors?: Map<string, number[] | Float32Array>,
  simPayoutStructure?: PayoutTier[],
  fieldPairFreqs?: Map<string, number>,
  deepComboAnalysis?: DeepComboAnalysis | null,
  isShowdown: boolean = false,
  isSingleGame: boolean = false,
  constrainedPool: boolean = false,
  sport?: string,
  fieldTripleFreqs?: Map<string, number>,
  fieldQuadFreqs?: Map<string, number>,
  fieldQuintFreqs?: Map<string, number>,
  isShortSlate: boolean = false,
  selConfig?: import('../types').SelectionConfig,
): ScoredLineup[] {
  // === R9: DIVERSITY-GATED GREEDY SELECTION ===
  // Sort by totalScore, select greedily with quartic diversity gating.
  // R7 showed this approach works best (59 hits vs R8's 43 with field-relative caps).
  // Slightly lower thresholds than R7 (0.25 vs 0.30) to avoid over-diversifying.

  const selected: ScoredLineup[] = [];
  const selectedHashes = new Set<string>();
  const playerCounts = new Map<string, number>();
  const pairCounts = new Map<string, number>();
  const tripleCounts = new Map<string, number>();
  const quadCounts = new Map<string, number>();
  const quintCounts = new Map<string, number>();

  // Helper to update all combo tracking maps for a selected lineup
  function trackLineup(lineup: ScoredLineup): void {
    const ids = lineup.players.map(p => p.id).sort();
    for (const p of lineup.players) {
      playerCounts.set(p.id, (playerCounts.get(p.id) || 0) + 1);
    }
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const pairKey = `${ids[i]}|${ids[j]}`;
        pairCounts.set(pairKey, (pairCounts.get(pairKey) || 0) + 1);
        for (let k = j + 1; k < ids.length; k++) {
          const tripleKey = `${ids[i]}|${ids[j]}|${ids[k]}`;
          tripleCounts.set(tripleKey, (tripleCounts.get(tripleKey) || 0) + 1);
          for (let l = k + 1; l < ids.length; l++) {
            const quadKey = `${ids[i]}|${ids[j]}|${ids[k]}|${ids[l]}`;
            quadCounts.set(quadKey, (quadCounts.get(quadKey) || 0) + 1);
            for (let m = l + 1; m < ids.length; m++) {
              const quintKey = `${ids[i]}|${ids[j]}|${ids[k]}|${ids[l]}|${ids[m]}`;
              quintCounts.set(quintKey, (quintCounts.get(quintKey) || 0) + 1);
            }
          }
        }
      }
    }
  }

  // Sort pool by GPP EV (totalScore)
  const sorted = [...pool].sort((a, b) => b.totalScore - a.totalScore);

  console.log(`  Pool size: ${sorted.length}, target: ${targetCount}`);
  if (sorted.length > 0) {
    console.log(`  Top GPP EV: ${sorted[0].totalScore.toFixed(4)}, proj: ${sorted[0].projection.toFixed(1)}`);
    console.log(`  Median GPP EV: ${sorted[Math.floor(sorted.length / 2)].totalScore.toFixed(4)}`);
  }

  // Pool-size-aware diversity: small pools already lack variety, lower the bar.
  // Graduated ramp: high-scoring lineups (early picks) get through more easily,
  // full gate by 50% fill. Reaches full baseThreshold by 50% so final portfolio
  // still has strong diversity enforcement.
  const baseThreshold = selConfig?.diversityBase ?? (sorted.length < 15000 ? 0.20 : 0.25);
  const freePassRatio = selConfig?.diversityFreePass ?? (sorted.length < 15000 ? 0.10
    : sorted.length < 30000 ? 0.08 : 0.06);

  function getMinDiversity(fillRatio: number): number {
    if (fillRatio < freePassRatio) return 0.0;
    if (fillRatio < 0.50) {
      // Graduated ramp: 50% → 100% of baseThreshold as portfolio fills.
      const rampProgress = (fillRatio - freePassRatio) / (0.50 - freePassRatio);
      const rampFactor = 0.50 + 0.50 * rampProgress;
      return baseThreshold * rampFactor;
    }
    if (fillRatio < 0.85) return baseThreshold * 0.40;
    return 0.03;
  }

  let skippedDiversity = 0;
  let skippedExposure = 0;

  // Adaptive exposure cap based on pool-to-target ratio.
  // Concentrated slates (small pool relative to target) need higher cap to avoid cascade failure.
  // Only enforced after 20 lineups (need enough data for meaningful exposure).
  const poolToTargetRatio = sorted.length / targetCount;
  const MAX_PLAYER_EXPOSURE = selConfig?.maxExposure ??
    (poolToTargetRatio < 2 ? 0.85 : poolToTargetRatio < 5 ? 0.75 : 0.65);
  function wouldExceedExposureCap(lineup: ScoredLineup): boolean {
    if (selected.length < 20) return false;
    return lineup.players.some(p => {
      const currentCount = playerCounts.get(p.id) || 0;
      return (currentCount + 1) / (selected.length + 1) > MAX_PLAYER_EXPOSURE;
    });
  }

  // Pass 1: diversity-gated greedy selection
  for (const lineup of sorted) {
    if (selected.length >= targetCount) break;
    if (selectedHashes.has(lineup.hash)) continue;
    if (wouldExceedExposureCap(lineup)) { skippedExposure++; continue; }

    const fillRatio = selected.length / targetCount;
    const minDiv = getMinDiversity(fillRatio);

    if (selected.length > 0 && minDiv > 0) {
      const diversity = calculatePortfolioDiversity(
        lineup, playerCounts, pairCounts, tripleCounts, quadCounts, quintCounts,
        selected.length, fieldOwnership, fieldPairFreqs, isShowdown, isSingleGame,
        fieldTripleFreqs, fieldQuadFreqs, fieldQuintFreqs, isShortSlate
      );
      if (diversity < minDiv) { skippedDiversity++; continue; }
    }

    // Accept lineup
    selected.push(lineup);
    selectedHashes.add(lineup.hash);
    trackLineup(lineup);

    if (onProgress && selected.length % 50 === 0) {
      onProgress(selected.length / targetCount, `Selected ${selected.length}/${targetCount}`);
    }
  }

  // Pass 2: very relaxed diversity (0.03)
  if (selected.length < targetCount) {
    console.log(`  Pass 2: relaxed diversity — ${selected.length}/${targetCount} so far`);
    for (const lineup of sorted) {
      if (selected.length >= targetCount) break;
      if (selectedHashes.has(lineup.hash)) continue;
      if (wouldExceedExposureCap(lineup)) { skippedExposure++; continue; }
      const diversity = selected.length > 0
        ? calculatePortfolioDiversity(
            lineup, playerCounts, pairCounts, tripleCounts, quadCounts, quintCounts,
            selected.length, fieldOwnership, fieldPairFreqs, isShowdown, isSingleGame,
            fieldTripleFreqs, fieldQuadFreqs, fieldQuintFreqs, isShortSlate
          )
        : 1;
      if (diversity < 0.01) continue;
      selected.push(lineup);
      selectedHashes.add(lineup.hash);
      trackLineup(lineup);
    }
  }

  // Pass 3: accept anything to hit target (exposure cap still enforced)
  if (selected.length < targetCount) {
    console.log(`  Pass 3: no diversity gate — ${selected.length}/${targetCount} so far`);
    for (const lineup of sorted) {
      if (selected.length >= targetCount) break;
      if (selectedHashes.has(lineup.hash)) continue;
      if (wouldExceedExposureCap(lineup)) { skippedExposure++; continue; }
      selected.push(lineup);
      selectedHashes.add(lineup.hash);
      trackLineup(lineup);
    }
  }

  // Log selection stats
  console.log(`  Selection stats:`);
  console.log(`    Total selected: ${selected.length}`);
  console.log(`    Skipped (low diversity): ${skippedDiversity}`);
  if (skippedExposure > 0) {
    console.log(`    Skipped (exposure cap ${(MAX_PLAYER_EXPOSURE * 100).toFixed(0)}%): ${skippedExposure}`);
  }

  // Log final exposure distribution
  const finalExposures: { id: string; name: string; exp: number }[] = [];
  for (const [playerId, count] of playerCounts) {
    const player = allPlayers.find(p => p.id === playerId);
    finalExposures.push({ id: playerId, name: player?.name || playerId, exp: count / selected.length });
  }
  finalExposures.sort((a, b) => b.exp - a.exp);

  const maxExp = finalExposures[0]?.exp || 0;
  const top5AvgExp = finalExposures.slice(0, 5).reduce((s, e) => s + e.exp, 0) / Math.min(5, finalExposures.length);
  console.log(`  Max exposure: ${(maxExp * 100).toFixed(1)}%`);
  console.log(`  Top 5 avg exposure: ${(top5AvgExp * 100).toFixed(1)}%`);
  console.log(`  Unique players: ${playerCounts.size}`);

  // Top 10 exposures with field comparison
  for (const e of finalExposures.slice(0, 10)) {
    const fieldExp = fieldOwnership?.get(e.id) || 0;
    console.log(`    ${e.name.padEnd(25)} ${(e.exp * 100).toFixed(1).padStart(5)}% (field: ${(fieldExp * 100).toFixed(1)}%)`);
  }

  return selected;
}

/**
 * Calculate how diverse a lineup is relative to current portfolio.
 * Returns 0-1 where 1 = completely unique, 0 = identical to existing.
 *
 * Uses aggressive quartic (x^4) penalty curves that grow VERY fast at high exposures.
 * No hard caps - instead, penalties make high exposure progressively harder but never impossible.
 *
 * Exposure → Penalty Points → Approx Diversity Impact
 * 20%     → 0               → 1.0 (no penalty)
 * 25%     → 0.25            → 0.97
 * 30%     → 2.1             → 0.75
 * 40%     → 21.5            → 0.30 (significant)
 * 50%     → 76.6            → 0.05 (nearly blocked)
 * 60%     → 214             → ~0 (effectively blocked)
 */
function calculatePortfolioDiversity(
  lineup: Lineup,
  playerCounts: Map<string, number>,
  pairCounts: Map<string, number>,
  tripleCounts: Map<string, number>,
  quadCounts: Map<string, number>,
  quintCounts: Map<string, number>,
  portfolioSize: number,
  fieldPlayerOwnership?: Map<string, number>,
  fieldPairFreqs?: Map<string, number>,
  isShowdown: boolean = false,
  isSingleGame: boolean = false,
  fieldTripleFreqs?: Map<string, number>,
  fieldQuadFreqs?: Map<string, number>,
  fieldQuintFreqs?: Map<string, number>,
  isShortSlate: boolean = false,
): number {
  if (portfolioSize === 0) return 1;  // First lineup is always diverse

  const ids = lineup.players.map(p => p.id).sort();
  const rosterSize = ids.length;

  // === PLAYER-LEVEL DIVERSITY (SOFT, FIELD-RELATIVE) ===
  // Very soft penalty — stars should never be blocked. Only penalize extreme
  // over-concentration (>2x field exposure). Leverage comes from combo diversity,
  // not from fading individual players.
  // Player-level: soft cap around 65-70%. We WANT the players, just in different combos.
  // Don't let combo penalties effectively fade good players.
  // Short slates: lower multiplier so penalties kick in sooner on concentrated players.
  // Murray at 55% field → penaltyStart = max(0.20, 0.55 × 1.20) = 0.66 (was 0.99 with 1.80).
  const FIELD_RELATIVE_PLAYER_MULT = isShortSlate ? 1.20 : 1.80;
  const DEFAULT_FIELD_EXPOSURE = 0.08;     // Fallback if player not in field map
  let playerOverlapScore = 0;

  for (const id of ids) {
    const count = playerCounts.get(id) || 0;
    const exposure = count / portfolioSize;

    // Soft threshold: allow players up to ~1.8x field exposure before penalty
    const fieldExp = fieldPlayerOwnership ? (fieldPlayerOwnership.get(id) || DEFAULT_FIELD_EXPOSURE) : DEFAULT_FIELD_EXPOSURE;
    const penaltyStart = Math.max(0.20, fieldExp * FIELD_RELATIVE_PLAYER_MULT);

    if (exposure > penaltyStart) {
      const x = exposure - penaltyStart;
      // Moderate player penalty — pros are chalkier than field, don't fight chalk.
      // Winners are +5.4% projection with only -2.2% ownership.
      playerOverlapScore += Math.pow(x, 3) * 15;
      playerOverlapScore += Math.pow(x, 2) * 6;
      playerOverlapScore += x * 1.0;
    }
  }

  const playerDiversity = Math.max(0, 1 - playerOverlapScore / rosterSize);

  // === PAIR-LEVEL DIVERSITY (FIELD-RELATIVE) ===
  // This is the PRIMARY differentiation mechanism. Penalize pair combos the field builds.
  // Reward unique combos the field doesn't have (low fieldPairFreq → high threshold tolerance).
  // Pairs with high field frequency are "chalk combos" — penalize these heavily in our portfolio.
  // Pairs with low field frequency are leverage — allow higher portfolio concentration.
  const DEFAULT_FIELD_PAIR_FREQ = 0.005;  // Fallback for pairs not in field
  let pairOverlapScore = 0;
  let pairCount = 0;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const key = `${ids[i]}|${ids[j]}`;
      const count = pairCounts.get(key) || 0;
      const freq = count / portfolioSize;

      // Field-relative threshold: chalk combos (high field freq) get penalized sooner,
      // unique combos (low field freq) get more room to grow.
      const fieldPairFreq = fieldPairFreqs ? (fieldPairFreqs.get(key) || DEFAULT_FIELD_PAIR_FREQ) : DEFAULT_FIELD_PAIR_FREQ;
      // High field freq → lower threshold (penalize sooner); low field freq → higher threshold (more room)
      const pairThreshold = fieldPairFreq > 0.05
        ? Math.max(0.03, fieldPairFreq * 0.8)     // Chalk pair: just below field freq — be different
        : Math.max(0.06, fieldPairFreq * 3.0);    // Unique pair: allow 6% concentration on OUR combos

      if (freq > pairThreshold) {
        const x = freq - pairThreshold;
        // FIELD-RELATIVE: Moderate penalty on chalk combos, let unique combos run free.
        // Reduced from 8x/3x — pros play chalk combos and win. Don't over-penalize.
        const penaltyScale = fieldPairFreq > 0.05 ? 3.0
          : fieldPairFreq > 0.02 ? 1.5
          : 0.2;
        pairOverlapScore += Math.pow(x, 4) * 60 * penaltyScale;
        pairOverlapScore += Math.pow(x, 3) * 12 * penaltyScale;
        pairOverlapScore += Math.pow(x, 2) * 4 * penaltyScale;
      }
      pairCount++;
    }
  }
  const pairDiversity = Math.max(0, 1 - pairOverlapScore / Math.max(1, pairCount / 8));

  // === TRIPLE-LEVEL DIVERSITY (FIELD-RELATIVE) ===
  // Use actual field triple frequencies when available, else estimate from pair freqs.
  // Chalk triples the field stacks → heavy penalty. Unique triples → let them ride.
  let tripleOverlapScore = 0;
  let tripleCount = 0;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      for (let k = j + 1; k < ids.length; k++) {
        const key = `${ids[i]}|${ids[j]}|${ids[k]}`;
        const count = tripleCounts.get(key) || 0;
        const freq = count / portfolioSize;

        // Use actual field triple freq if available, else estimate from pair freqs
        let fieldTripleFreq = 0.002;  // default: rare
        if (fieldTripleFreqs && fieldTripleFreqs.has(key)) {
          fieldTripleFreq = fieldTripleFreqs.get(key)!;
        } else if (fieldPairFreqs) {
          const pf1 = fieldPairFreqs.get(`${ids[i]}|${ids[j]}`) || 0.005;
          const pf2 = fieldPairFreqs.get(`${ids[i]}|${ids[k]}`) || 0.005;
          const pf3 = fieldPairFreqs.get(`${ids[j]}|${ids[k]}`) || 0.005;
          fieldTripleFreq = Math.pow(pf1 * pf2 * pf3, 1/3);  // geometric mean fallback
        }

        // Field-relative threshold and penalty — relaxed to allow chalk triples
        const tripleThreshold = fieldTripleFreq > 0.04 ? 0.08 : 0.15;
        const triplePenaltyScale = fieldTripleFreq > 0.04 ? 3.0
          : fieldTripleFreq > 0.015 ? 1.5
          : 0.2;

        if (freq > tripleThreshold) {
          const x = freq - tripleThreshold;
          tripleOverlapScore += Math.pow(x, 4) * 80 * triplePenaltyScale;
          tripleOverlapScore += Math.pow(x, 3) * 16 * triplePenaltyScale;
          tripleOverlapScore += Math.pow(x, 2) * 4 * triplePenaltyScale;
        }
        tripleCount++;
      }
    }
  }

  const tripleDiversity = Math.max(0, 1 - tripleOverlapScore / Math.max(1, tripleCount / 15));

  // === QUAD-LEVEL DIVERSITY (FIELD-RELATIVE) ===
  // Use actual field quad frequencies when available. Chalk 4-man combos → heavy penalty.
  let quadOverlapScore = 0;
  let quadCount = 0;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      for (let k = j + 1; k < ids.length; k++) {
        for (let l = k + 1; l < ids.length; l++) {
          const key = `${ids[i]}|${ids[j]}|${ids[k]}|${ids[l]}`;
          const count = quadCounts.get(key) || 0;
          const freq = count / portfolioSize;

          // Use actual field quad freq if available, else estimate from pair freqs
          let fieldQuadFreq = 0.001;
          if (fieldQuadFreqs && fieldQuadFreqs.has(key)) {
            fieldQuadFreq = fieldQuadFreqs.get(key)!;
          } else if (fieldPairFreqs) {
            const pairs = [
              fieldPairFreqs.get(`${ids[i]}|${ids[j]}`) || 0.005,
              fieldPairFreqs.get(`${ids[i]}|${ids[k]}`) || 0.005,
              fieldPairFreqs.get(`${ids[i]}|${ids[l]}`) || 0.005,
              fieldPairFreqs.get(`${ids[j]}|${ids[k]}`) || 0.005,
              fieldPairFreqs.get(`${ids[j]}|${ids[l]}`) || 0.005,
              fieldPairFreqs.get(`${ids[k]}|${ids[l]}`) || 0.005,
            ];
            fieldQuadFreq = Math.pow(pairs.reduce((a, b) => a * b, 1), 1/6);
          }

          const quadThreshold = fieldQuadFreq > 0.03 ? 0.06 : 0.12;
          const quadPenaltyScale = fieldQuadFreq > 0.03 ? 3.0
            : fieldQuadFreq > 0.01 ? 1.5
            : 0.2;

          if (freq > quadThreshold) {
            const x = freq - quadThreshold;
            quadOverlapScore += Math.pow(x, 4) * 120 * quadPenaltyScale;
            quadOverlapScore += Math.pow(x, 3) * 25 * quadPenaltyScale;
            quadOverlapScore += Math.pow(x, 2) * 6 * quadPenaltyScale;
          }
          quadCount++;
        }
      }
    }
  }
  const quadDiversity = Math.max(0, 1 - quadOverlapScore / Math.max(1, quadCount / 20));

  // === QUINT-LEVEL DIVERSITY (FIELD-RELATIVE) ===
  // Use actual field quint frequencies when available. Chalk 5-man combos → heavy penalty.
  let quintOverlapScore = 0;
  let quintCount = 0;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      for (let k = j + 1; k < ids.length; k++) {
        for (let l = k + 1; l < ids.length; l++) {
          for (let m = l + 1; m < ids.length; m++) {
            const key = `${ids[i]}|${ids[j]}|${ids[k]}|${ids[l]}|${ids[m]}`;
            const count = quintCounts.get(key) || 0;
            const freq = count / portfolioSize;

            // Use actual field quint freq if available, else estimate from pair freqs
            let fieldQuintFreq = 0.0005;
            if (fieldQuintFreqs && fieldQuintFreqs.has(key)) {
              fieldQuintFreq = fieldQuintFreqs.get(key)!;
            } else if (fieldPairFreqs) {
              const quintIds = [ids[i], ids[j], ids[k], ids[l], ids[m]];
              let pairProduct = 1;
              let pairN = 0;
              for (let pi = 0; pi < quintIds.length; pi++) {
                for (let pj = pi + 1; pj < quintIds.length; pj++) {
                  pairProduct *= (fieldPairFreqs.get(`${quintIds[pi]}|${quintIds[pj]}`) || 0.005);
                  pairN++;
                }
              }
              fieldQuintFreq = Math.pow(pairProduct, 1 / pairN);
            }

            const quintThreshold = fieldQuintFreq > 0.025 ? 0.05 : 0.10;
            const quintPenaltyScale = fieldQuintFreq > 0.025 ? 3.0
              : fieldQuintFreq > 0.01 ? 1.5
              : 0.2;

            if (freq > quintThreshold) {
              const x = freq - quintThreshold;
              quintOverlapScore += Math.pow(x, 4) * 200 * quintPenaltyScale;
              quintOverlapScore += Math.pow(x, 3) * 40 * quintPenaltyScale;
              quintOverlapScore += Math.pow(x, 2) * 8 * quintPenaltyScale;
            }
            quintCount++;
          }
        }
      }
    }
  }
  const quintDiversity = Math.max(0, 1 - quintOverlapScore / Math.max(1, quintCount / 25));

  // Combined diversity score
  if (isShowdown) {
    // Showdown: captain IS the leverage. Higher player weight penalizes captain over-exposure
    // more aggressively, forcing spread across different captains.
    return playerDiversity * 0.30 + pairDiversity * 0.30 + tripleDiversity * 0.20 + quadDiversity * 0.15 + quintDiversity * 0.05;
  }
  if (isSingleGame) {
    // Single-game classic (golf, MMA): no captain, but player-level diversity matters more
    // since there's no game-stacking leverage. Boost player weight to spread exposure.
    return playerDiversity * 0.20 + pairDiversity * 0.25 + tripleDiversity * 0.25 + quadDiversity * 0.20 + quintDiversity * 0.10;
  }
  if (isShortSlate) {
    // Short slate (2-3 games): with only 42 players, combo diversity can't differentiate much —
    // player-level exposure is what matters. 25% player weight (vs 10% multi-game) to prevent
    // 91% Murray-type concentration.
    return playerDiversity * 0.25 + pairDiversity * 0.25 + tripleDiversity * 0.25 + quadDiversity * 0.15 + quintDiversity * 0.10;
  }
  // Multi-game classic: combo-heavy — leverage comes from unique player COMBINATIONS, not from fading individual stars.
  // Stars should run freely; the pair/triple/quad penalties force different supporting casts.
  return playerDiversity * 0.10 + pairDiversity * 0.25 + tripleDiversity * 0.25 + quadDiversity * 0.25 + quintDiversity * 0.15;
}

// ============================================================
// RESULT BUILDING
// ============================================================

function calculateExposures(selected: ScoredLineup[]): Map<string, number> {
  const counts = new Map<string, number>();
  
  for (const lineup of selected) {
    for (const player of lineup.players) {
      counts.set(player.id, (counts.get(player.id) || 0) + 1);
    }
  }

  const exposures = new Map<string, number>();
  for (const [id, count] of counts) {
    exposures.set(id, (count / selected.length) * 100);
  }

  return exposures;
}

function buildMetricsData(
  selected: ScoredLineup[],
  allScored: ScoredLineup[],
  efficientFrontier: Set<string>
): LineupMetricsData[] {
  const scoreMap = new Map<string, ScoredLineup>();
  for (const lineup of allScored) {
    scoreMap.set(lineup.hash, lineup);
  }

  return selected.map((lineup, index) => {
    const scored = scoreMap.get(lineup.hash) || lineup;
    const varianceData = calculateVarianceScore(lineup);
    const ownershipSum = calculateOwnershipSum(lineup);

    return {
      lineup: scored,
      rank: index + 1,
      projectionScore: scored.projectionScore,
      ownershipScore: scored.ownershipScore,
      leverageScore: scored.leverageScore,
      simulationScore: 0.5, // Would come from simulation
      relativeValueRatio: 0,
      relativeValueScore: 0,
      varianceScore: varianceData.score,
      scarcityScore: 0.5,
      valueLeverageScore: 0,
      gameStackScore: 0.5,
      lineupFloor: varianceData.floor,
      lineupCeiling: varianceData.ceiling,
      isEfficientFrontier: efficientFrontier.has(lineup.hash),
      totalScore: scored.totalScore,
      ownershipSum,
      projectionSacrifice: 0,
      ownershipReduction: 0,
    };
  });
}

// ============================================================
// SCORING PIPELINE FOR LATE SWAP
// ============================================================
// Runs Phases 1-3.5 of the pregame pipeline on any set of lineups.
// Used by the late swap optimizer to score candidate lineups with
// the full 10-component scoring + simulation + field analysis.

export interface SwapScoringResult {
  scoredLineups: ScoredLineup[];
  syntheticField: FieldLineup[];
  deepComboAnalysis: DeepComboAnalysis;
  simFinishVectors: Map<string, number[] | Float32Array>;
  simPayoutStructure: PayoutTier[];
  fieldOwnership: Map<string, number>;
  baseline: ReturnType<typeof calculateBaselineMetrics>;
}

export function scoreLineupsForSwap(
  lineups: Lineup[],
  allPlayers: Player[],
  numGames: number,
  salaryCap: number,
  rosterSizeOverride?: number,
  sport?: string
): SwapScoringResult {
  console.log(`\n--- LATE SWAP SCORING PIPELINE ---`);
  console.log(`Candidates: ${lineups.length.toLocaleString()}`);
  console.log(`Players: ${allPlayers.length}, Games: ${numGames}`);

  if (lineups.length === 0) {
    return {
      scoredLineups: [],
      syntheticField: [],
      deepComboAnalysis: { pairs: new Map(), triples: new Map(), quads: new Map(), quints: new Map(), sexts: new Map(), septs: new Map(), cores3: [], cores4: [], cores5: [], fieldHeavyCores3: [], universallyCommonCores3: [], universallyCommonCores4: [], universallyCommonCores5: [], universallyCommonCores6: [], universallyCommonCores7: [], coreInteractions: new Map(), differentiatedCores: [] },
      simFinishVectors: new Map(),
      simPayoutStructure: buildGPPPayoutStructure(10000, 20),
      fieldOwnership: new Map(),
      baseline: calculateBaselineMetrics(lineups),
    };
  }

  // Sort by projection descending
  const sortedLineups = [...lineups].sort((a, b) => b.projection - a.projection);
  const maxProj = sortedLineups[0].projection;
  const minProj = sortedLineups[sortedLineups.length - 1].projection;

  console.log(`Projection range: ${minProj.toFixed(1)} - ${maxProj.toFixed(1)}`);

  // Phase 1: Baseline analysis
  console.log(`\n--- BASELINE ANALYSIS ---`);
  const baseline = calculateBaselineMetrics(sortedLineups);
  console.log(`Optimal: ${baseline.optimalProjection.toFixed(1)} pts / ${baseline.optimalOwnership.toFixed(1)}% ownership`);

  // Efficient frontier
  const lineupsWithOwnership = sortedLineups.map(l => ({
    lineup: l,
    ownership: calculateOwnershipSum(l),
  }));
  const efficientFrontier = markEfficientFrontier(lineupsWithOwnership);
  console.log(`Efficient frontier: ${efficientFrontier.size} lineups`);

  // Improvement #14: Use rosterSizeOverride if provided (e.g., from config.rosterSize)
  const rosterSize = rosterSizeOverride || lineups[0]?.players.length || 8;

  // Ownership scenarios
  console.log(`\n--- OWNERSHIP UNCERTAINTY ---`);
  const ownershipScenarios = generateOwnershipScenarios(allPlayers, 20);
  const baselineOwnership = new Map<string, number>();
  for (const p of allPlayers) {
    baselineOwnership.set(p.id, p.ownership);
  }
  console.log(`  Generated ${ownershipScenarios.length} ownership scenarios`);

  // Phase 2: Field generation (scenario-diversified)
  console.log(`\n--- FIELD ANALYSIS ---`);
  const FIELD_SAMPLE_SIZE = 20000;
  console.log(`  Generating ${FIELD_SAMPLE_SIZE} synthetic field lineups...`);
  const syntheticField = generateFieldPool(
    allPlayers, rosterSize, FIELD_SAMPLE_SIZE,
    undefined, undefined, undefined, ownershipScenarios, undefined, salaryCap
  );

  const fieldArchCounts = new Map<string, number>();
  for (const fl of syntheticField) {
    fieldArchCounts.set(fl.archetype, (fieldArchCounts.get(fl.archetype) || 0) + 1);
  }
  console.log(`  Field composition: ${[...fieldArchCounts.entries()].map(([a, c]) => `${c} ${a}`).join(', ')}`);

  validateFieldCalibration(syntheticField, allPlayers);

  const fieldCombos = analyzeFieldCombos(syntheticField, false);
  console.log(`Unique 3-player combos in field: ${fieldCombos.triples.size.toLocaleString()}`);

  const overlapIndex = buildFieldOverlapIndex(syntheticField, rosterSize);
  console.log(`Field overlap index: ${overlapIndex.playerFieldIndices.size} players tracked`);

  const maxCeiling = allPlayers.reduce((max, p) => {
    const ceil = p.ceiling99 || p.ceiling || p.projection * 1.3;
    return ceil > max ? ceil : max;
  }, 0);

  // Field ownership
  const fieldExposureCounts = new Map<string, number>();
  for (const fieldLineup of syntheticField) {
    for (const playerId of fieldLineup.playerIds) {
      fieldExposureCounts.set(playerId, (fieldExposureCounts.get(playerId) || 0) + 1);
    }
  }
  const fieldOwnership = new Map<string, number>();
  for (const [playerId, count] of fieldExposureCounts) {
    fieldOwnership.set(playerId, count / syntheticField.length);
  }

  // Deep combo analysis
  console.log(`\n--- DEEP COMBO ANALYSIS ---`);
  const deepComboAnalysis = analyzeDeepCombos(
    sortedLineups,
    syntheticField,
    allPlayers,
    numGames
  );

  // Projection edge analysis
  console.log(`\n--- PROJECTION EDGE ANALYSIS ---`);
  const projectionEdgeAnalysis = analyzeProjectionEdge(allPlayers);
  console.log(`  Projection edge: avg ${(projectionEdgeAnalysis.avgEdge * 100).toFixed(1)}%`);

  // Justified ownership analysis
  const justifiedOwnershipAnalysis = analyzeJustifiedOwnership(allPlayers);

  // Slate-adaptive weights
  const baseWeights = loadOptimizedWeights();
  const adaptedWeights = adaptWeightsToSlate(baseWeights, allPlayers, numGames);
  console.log(`\n--- SLATE-ADAPTIVE WEIGHTS ---`);
  console.log(`  Adjusted: proj=${adaptedWeights.projectionScore.toFixed(3)} own=${adaptedWeights.ownershipScore.toFixed(3)} ceil=${adaptedWeights.ceilingScore.toFixed(3)} uniq=${(adaptedWeights.uniquenessScore || 0.25).toFixed(3)}`);

  // Phase 3: Score all lineups
  console.log(`\n--- SCORING LINEUPS ---`);
  const scoredLineups = scoreAllLineups(
    sortedLineups,
    baseline,
    fieldCombos,
    overlapIndex,
    maxCeiling,
    efficientFrontier,
    minProj,
    maxProj,
    deepComboAnalysis,
    projectionEdgeAnalysis,
    salaryCap,
    numGames,
    adaptedWeights,
    ownershipScenarios,
    baselineOwnership,
    justifiedOwnershipAnalysis
  );

  // Phase 3.5: Tiered tournament simulation
  const simFinishVectors = new Map<string, number[] | Float32Array>();
  const simPayoutStructure = buildGPPPayoutStructure(10000, 20);

  if (adaptedWeights.simulationScore > 0) {
    console.log(`\n--- TIERED TOURNAMENT SIMULATION ---`);

    const simResults = simulateTiered(
      scoredLineups,
      allPlayers,
      syntheticField,
      {
        tier1Count: Math.min(5000, scoredLineups.length),
        tier1Sims: 1000,
        tier2Count: Math.min(15000, Math.max(0, scoredLineups.length - 5000)),
        tier2Sims: 200,
        tier3Sims: 50,
        fieldSize: 10000,
        entryFee: 20,
        payoutStructure: simPayoutStructure,
        sport,
      }
    );

    let simAttached = 0;
    let minPayout = Infinity;
    let maxPayout = -Infinity;

    for (const lineup of scoredLineups) {
      const simResult = simResults.get(lineup.hash);
      if (simResult) {
        minPayout = Math.min(minPayout, simResult.expectedPayout);
        maxPayout = Math.max(maxPayout, simResult.expectedPayout);
      }
    }

    const payoutRange = maxPayout - minPayout || 1;

    for (const lineup of scoredLineups) {
      const simResult = simResults.get(lineup.hash);
      if (simResult) {
        const normalizedChipEquity = (simResult.expectedPayout - minPayout) / payoutRange;

        // Simulation-dominated scoring: 70% sim + 30% heuristic
        const heuristicScore = lineup.totalScore;
        lineup.totalScore = normalizedChipEquity * 0.70 + heuristicScore * 0.30;
        simAttached++;

        if (simResult.finishPositionVector) {
          simFinishVectors.set(lineup.hash, simResult.finishPositionVector);
        }
      }
    }

    scoredLineups.sort((a, b) => b.totalScore - a.totalScore);

    let tier1 = 0, tier2 = 0, tier3 = 0;
    for (const result of simResults.values()) {
      if (result.tier === 'full') tier1++;
      else if (result.tier === 'quick') tier2++;
      else tier3++;
    }
    console.log(`  Simulation attached to ${simAttached} lineups`);
    console.log(`  Tier distribution: ${tier1} full, ${tier2} quick, ${tier3} ultra`);
    console.log(`  Finish vectors stored: ${simFinishVectors.size}`);
  }

  return {
    scoredLineups,
    syntheticField,
    deepComboAnalysis,
    simFinishVectors,
    simPayoutStructure,
    fieldOwnership,
    baseline,
  };
}

function createEmptyResult(): SelectionResult {
  return {
    selected: [],
    exposures: new Map(),
    avgProjection: 0,
    avgOwnership: 0,
    metricsData: [],
  };
}
