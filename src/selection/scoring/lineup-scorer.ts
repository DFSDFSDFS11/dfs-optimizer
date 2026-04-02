/**
 * DFS Optimizer CLI - Lineup Scorer
 *
 * Core scoring functions for lineup evaluation.
 * Calculates projection, ownership, leverage, and diversity scores.
 */

import { Lineup, ScoredLineup, Player } from '../../types';

// ============================================================
// CORE SCORING FUNCTIONS
// ============================================================

/**
 * Calculate ownership sum for a lineup
 */
export function calculateOwnershipSum(lineup: Lineup | ScoredLineup): number {
  return lineup.players.reduce((sum, p) => sum + p.ownership, 0);
}

/**
 * Calculate geometric mean ownership for a lineup.
 * Uses product of ownerships (as decimals) raised to 1/n, then scaled back to %.
 *
 * This properly captures the "field probability" of a lineup structure:
 * - All 25% players: geoMean = 25%
 * - Mix of 50% + 5% players (same avg): geoMean ≈ 16% — correctly seen as more unique
 *
 * Chalk + contrarian structures get LOWER geoMean than all-mid-chalk at the same
 * arithmetic average. This prevents mid-chalk traps from being treated the same as
 * differentiated builds.
 */
export function calculateGeometricMeanOwnership(lineup: Lineup | ScoredLineup): number {
  const n = lineup.players.length;
  if (n === 0) return 0;
  const productOwn = lineup.players.reduce(
    (prod, p) => prod * Math.max((p.ownership || 1) / 100, 0.005), 1
  );
  return Math.pow(productOwn, 1 / n) * 100;
}

/**
 * Calculate ownership score (lower ownership = higher score)
 * Uses GEOMETRIC MEAN ownership so chalk+contrarian structures score better
 * than all-mid-chalk at the same average ownership.
 * Normalized to 0-1 range.
 */
export function calculateOwnershipScore(lineup: Lineup): number {
  // GeoMean: rewards chalk+contrarian structure (low product)
  const geoMeanOwn = calculateGeometricMeanOwnership(lineup);
  const linearGeo = Math.max(0, Math.min(1, 1 - (geoMeanOwn / 100)));
  const geoScore = linearGeo * linearGeo;

  // Sum: penalizes total chalk load (high sum ownership)
  const n = lineup.players.length || 8;
  const sumOwn = calculateOwnershipSum(lineup);
  const avgOwn = sumOwn / n;
  const linearSum = Math.max(0, Math.min(1, 1 - (avgOwn / 100)));
  const sumScore = linearSum * linearSum;

  return geoScore * 0.70 + sumScore * 0.30;
}

/**
 * Normalize projection score to 0-1 range
 */
export function normalizeProjectionScore(
  projection: number,
  minProjection: number,
  maxProjection: number
): number {
  const range = maxProjection - minProjection;
  if (range <= 0) return 0.5;
  const linear = (projection - minProjection) / range;
  // Mildly convex: x^1.3 amplifies gaps between near-optimal and mid-range lineups
  // (ownership uses x^2; this is conservative by comparison)
  return Math.pow(linear, 1.3);
}

/**
 * Calculate variance score for a lineup using lineup-level standard deviation.
 *
 * Why lineup SD instead of per-player boom ratios?
 *   Per-player boom ratios (p85/proj, p99/proj) are nearly identical across
 *   all NBA players (~1.20 and ~1.50). Averaging 8 of them produces scores
 *   with only 0.011 usable range — zero discrimination. Central limit theorem
 *   destroys the signal.
 *
 * Lineup SD measures how much the lineup's TOTAL SCORE can swing:
 *   1. Estimate each player's individual SD from IQR (p75 - p25) / 1.35
 *   2. Sum variances (SD²) assuming independence
 *   3. Lineup SD = sqrt(total variance)
 *
 * This creates real differentiation because the salary cap forces trade-offs:
 * star-heavy lineups (high per-player SD) vs value lineups (low per-player SD)
 * produce meaningfully different lineup SDs.
 *
 * For GPPs, higher variance = more chances to land in the right tail = better.
 *
 * Return signature preserved: { floor, ceiling, score }
 * floor/ceiling still populated for metrics/ceiling normalization.
 */
export function calculateVarianceScore(lineup: Lineup): {
  floor: number;
  ceiling: number;
  score: number;
} {
  let floor = 0;
  let ceiling = 0;
  let totalVariance = 0;
  const playerInfo: Array<{ sd: number; gameId: string; team: string }> = [];

  for (const player of lineup.players) {
    const proj = player.projection;

    // Floor: use p25 if available, else 60% of projection
    if (player.percentiles && player.percentiles.p25 > 0) {
      floor += player.percentiles.p25;
    } else {
      floor += proj * 0.6;
    }

    // Ceiling: use p85 if available, else fallback
    if (player.ceiling && player.ceiling > 0) {
      ceiling += player.ceiling;
    } else {
      ceiling += proj * 1.1;
    }

    // Player standard deviation — use SaberSim's stdDev if available (most accurate),
    // then IQR method, then ceiling-derived, then 20% fallback.
    // SaberSim stdDev accounts for minutes uncertainty, matchup, and pace.
    let sd: number;
    if (player.stdDev && player.stdDev > 0) {
      // Direct from SaberSim projection model — most accurate
      sd = player.stdDev;
    } else if (player.percentiles && player.percentiles.p75 > 0 && player.percentiles.p25 > 0) {
      // IQR method: SD ≈ IQR / 1.35 (robust for non-normal distributions)
      const iqr = player.percentiles.p75 - player.percentiles.p25;
      sd = iqr / 1.35;
    } else if (player.ceiling && player.ceiling > 0 && proj > 0) {
      // Fallback: ceiling (p85) is ~1.04 SD above mean for normal-like distributions
      sd = (player.ceiling - proj) / 1.04;
    } else {
      // Last resort: assume SD = 20% of projection
      sd = proj * 0.20;
    }
    totalVariance += sd * sd;
    playerInfo.push({
      sd,
      gameId: player.gameInfo || `${player.team}_game`,
      team: player.team,
    });
  }

  // Add covariance terms for correlated players (same-game)
  // The simulation uses game/team correlation factors that produce ~0.30-0.40 teammate correlation.
  // Without this, a 3-stack with individual SD=8 each has true SD of 18.6 under rho=0.4
  // vs the independent estimate of 13.9 — a 34% undercount.
  for (let i = 0; i < playerInfo.length; i++) {
    for (let j = i + 1; j < playerInfo.length; j++) {
      if (playerInfo[i].gameId === playerInfo[j].gameId) {
        // Same-team: rho ~0.40 (game pace + team execution alignment)
        // Same-game opponents: rho ~0.15 (shared pace, opposed script)
        const rho = playerInfo[i].team === playerInfo[j].team ? 0.40 : 0.15;
        totalVariance += 2 * playerInfo[i].sd * playerInfo[j].sd * rho;
      }
    }
  }

  // Lineup SD with correlated player outcomes for same-game players
  const lineupSD = Math.sqrt(Math.max(0, totalVariance));
  const n = lineup.players.length;

  // Normalize to 0-1, scaling by roster size so showdown/classic/NFL are comparable.
  // sqrt(N) * 12 is roughly the max expected lineup SD (all high-variance starters).
  const score = n > 0 ? Math.min(1, Math.max(0, lineupSD / (Math.sqrt(n) * 12))) : 0;

  return { floor, ceiling, score };
}

/**
 * Calculate diversity score vs selected lineups
 * Higher = more different from already selected
 */
export function calculateDiversityScore(
  lineup: Lineup,
  selectedCombos: Map<string, number>,
  selectedCores: Map<string, number>,
  selectedCount: number,
  playerExposureCounts?: Map<string, number>
): number {
  if (selectedCount === 0) return 1;

  // Check 2-player combo overlap
  let comboOverlap = 0;
  let comboCount = 0;
  const players = lineup.players;

  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const key = [players[i].id, players[j].id].sort().join('|');
      const usageCount = selectedCombos.get(key) || 0;
      comboOverlap += usageCount / selectedCount;
      comboCount++;
    }
  }

  const avgComboOverlap = comboCount > 0 ? comboOverlap / comboCount : 0;

  // Check core overlap (top 3 salary players)
  const sortedBySalary = [...players].sort((a, b) => b.salary - a.salary);
  const coreKey = sortedBySalary.slice(0, 3).map(p => p.id).sort().join('|');
  const coreUsage = selectedCores.get(coreKey) || 0;
  const coreOverlap = coreUsage / selectedCount;

  // Check individual player concentration (NEW)
  // Penalize lineups that stack already-overexposed players
  let playerConcentrationPenalty = 0;
  let maxPlayerExposure = 0;
  if (playerExposureCounts && selectedCount > 50) {
    let highExposureCount = 0;
    for (const player of players) {
      const currentExposure = (playerExposureCounts.get(player.id) || 0) / selectedCount;
      maxPlayerExposure = Math.max(maxPlayerExposure, currentExposure);
      // Start penalizing at 25% exposure, ramp up aggressively
      if (currentExposure > 0.25) {
        highExposureCount++;
        // Quadratic penalty - gets much stronger as exposure increases
        const overExposure = currentExposure - 0.25;
        playerConcentrationPenalty += overExposure * overExposure * 8;
      }
    }
    // Extra penalty for having multiple high-exposure players
    if (highExposureCount >= 3) {
      playerConcentrationPenalty += 0.25;
    } else if (highExposureCount >= 2) {
      playerConcentrationPenalty += 0.12;
    }
  }

  // Combined diversity (lower overlap = higher diversity)
  // Weight: 45% combo overlap, 30% core overlap, 25% player concentration
  let diversityScore = 1 - (avgComboOverlap * 0.45 + coreOverlap * 0.30 + playerConcentrationPenalty * 0.25);

  // HARD PENALTY: If any player is above 35% exposure, multiply score by decay factor
  // This makes it progressively harder to add lineups with overexposed players
  if (maxPlayerExposure > 0.35) {
    const overExposure = maxPlayerExposure - 0.35;
    // At 40%: multiply by 0.80, at 50%: multiply by 0.40, at 60%: multiply by 0.00
    const decayFactor = Math.max(0.05, 1 - overExposure * 4);
    diversityScore *= decayFactor;
  }

  return Math.max(0, Math.min(1, diversityScore));
}

/**
 * Add lineup to selected and update tracking maps
 */
export function addLineupToSelected(
  lineup: ScoredLineup,
  selected: ScoredLineup[],
  selectedHashes: Set<string>,
  playerExposureCounts: Map<string, number>,
  selectedCombos: Map<string, number>,
  selectedCores: Map<string, number>,
  archetypeCounts: { stars: number; balanced: number; value: number }
): void {
  selected.push(lineup);
  selectedHashes.add(lineup.hash);

  // Update player exposures
  for (const player of lineup.players) {
    playerExposureCounts.set(
      player.id,
      (playerExposureCounts.get(player.id) || 0) + 1
    );
  }

  // Update 2-player combos
  const players = lineup.players;
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const key = [players[i].id, players[j].id].sort().join('|');
      selectedCombos.set(key, (selectedCombos.get(key) || 0) + 1);
    }
  }

  // Update core usage
  const sortedBySalary = [...players].sort((a, b) => b.salary - a.salary);
  const coreKey = sortedBySalary.slice(0, 3).map(p => p.id).sort().join('|');
  selectedCores.set(coreKey, (selectedCores.get(coreKey) || 0) + 1);

  // Track archetype
  const archetype = classifyLineupArchetype(lineup);
  if (archetype === 'stars-scrubs' || archetype === 'anchor-punt') {
    archetypeCounts.stars++;
  } else if (archetype === 'value-heavy') {
    archetypeCounts.value++;
  } else {
    archetypeCounts.balanced++;
  }
}

/**
 * Classify lineup archetype based on salary distribution
 */
export type LineupArchetype = 'stars-scrubs' | 'balanced' | 'value-heavy' | 'anchor-punt';

export function classifyLineupArchetype(lineup: Lineup): LineupArchetype {
  const salaries = lineup.players.map(p => p.salary).sort((a, b) => b - a);
  const totalSalary = lineup.salary;

  // Guard: need at least 3 players for archetype classification
  if (salaries.length < 3 || totalSalary <= 0) {
    return 'balanced';
  }

  const topPlayerPct = salaries[0] / totalSalary;
  const topThreePct = (salaries[0] + salaries[1] + salaries[2]) / totalSalary;
  const bottomThreePct = (
    salaries[salaries.length - 1] +
    salaries[salaries.length - 2] +
    salaries[salaries.length - 3]
  ) / totalSalary;

  if (topThreePct > 0.52 && bottomThreePct < 0.18) {
    return 'stars-scrubs';
  }
  if (topThreePct < 0.45 && bottomThreePct > 0.22) {
    return 'value-heavy';
  }
  if (topPlayerPct > 0.22 && bottomThreePct < 0.16) {
    return 'anchor-punt';
  }
  return 'balanced';
}

// ============================================================
// RELATIVE VALUE SCORING (DFS Theory Masterclass)
// ============================================================

/**
 * Calculate relative value metrics
 * 
 * From DFS Theory: "You are looking for ones that have an outsized
 * proportion between its projection and ownership."
 */
export function calculateRelativeValue(
  lineup: Lineup,
  optimalProjection: number,
  optimalOwnership: number
): {
  projectionSacrifice: number;
  ownershipReduction: number;
  relativeValueRatio: number;
  relativeValueScore: number;
} {
  const ownershipSum = calculateOwnershipSum(lineup);

  // How much projection we're giving up vs optimal
  const projectionSacrifice = optimalProjection - lineup.projection;

  // How much ownership we're saving vs optimal
  const ownershipReduction = optimalOwnership - ownershipSum;

  // Relative value: ownership % saved per projection % sacrificed
  // Both normalized to their respective scales so the ratio is dimensionless.
  // A ratio of 5 means "for every 1% of projection sacrificed, we save 5% of ownership."
  const projSacrificePct = optimalProjection > 0 ? projectionSacrifice / optimalProjection : 0;
  const ownReductionPct = optimalOwnership > 0 ? ownershipReduction / optimalOwnership : 0;

  const relativeValueRatio = projSacrificePct > 0.001
    ? ownReductionPct / projSacrificePct
    : ownReductionPct > 0 ? 10 : 0;

  // Normalize to 0-1 score (ratio of 8+ = perfect trade-off)
  const relativeValueScore = Math.min(1, Math.max(0, relativeValueRatio / 8));

  return {
    projectionSacrifice,
    ownershipReduction,
    relativeValueRatio,
    relativeValueScore,
  };
}

// ============================================================
// CEILING RATIO SCORE
// ============================================================

/**
 * Calculate ceiling ratio score for a lineup.
 *
 * Pro winners have ceiling ratio 1.298 vs field 1.259.
 * Uses blended ceiling (60% p85 + 40% p99) / projection to capture
 * boom potential as a RATIO, not raw value.
 *
 * Fixed normalization: (avgRatio - 1.35) / 0.25, clamped [0, 1].
 * Stable across slates (no pool-relative scaling).
 */
export function calculateCeilingRatioScore(lineup: Lineup): number {
  let ratioSum = 0;
  let count = 0;
  for (const p of lineup.players) {
    const proj = p.projection;
    if (proj <= 0) continue;
    const p85 = p.ceiling && p.ceiling > 0 ? p.ceiling : proj * 1.25;
    const p99 = (p.percentiles && p.percentiles.p99 > 0) ? p.percentiles.p99 : p85 * 1.15;
    const blendedCeil = p85 * 0.6 + p99 * 0.4;
    ratioSum += blendedCeil / proj;
    count++;
  }
  if (count === 0) return 0;
  const avgRatio = ratioSum / count;
  return Math.max(0, Math.min(1, (avgRatio - 1.35) / 0.25));
}

// ============================================================
// GAME ENVIRONMENT SCORE
// ============================================================

/**
 * Calculate game environment score for a lineup.
 *
 * High-total games produce more DFS points. This is nearly orthogonal
 * to existing metrics (corr 0.176 with projection).
 *
 * Formula: (avgGameTotal - 200) / 50, clamped [0, 1].
 */
export function calculateGameEnvironmentScore(lineup: Lineup): number {
  let totalSum = 0;
  let count = 0;
  for (const p of lineup.players) {
    if (p.gameTotal && p.gameTotal > 0) {
      totalSum += p.gameTotal;
      count++;
    }
  }
  if (count === 0) return 0; // No game total data — contributes nothing
  const avgGameTotal = totalSum / count;
  return Math.max(0, Math.min(1, (avgGameTotal - 200) / 50));
}

// ============================================================
// EFFICIENT FRONTIER (Pareto Optimal)
// ============================================================

/**
 * Mark lineups on the efficient frontier
 * A lineup is on the frontier if no other lineup has both
 * higher projection AND lower ownership
 */
export function markEfficientFrontier(
  lineups: Array<{ lineup: Lineup; ownership: number }>
): Set<string> {
  // Sort by projection descending
  const sorted = [...lineups].sort((a, b) => b.lineup.projection - a.lineup.projection);
  const frontier = new Set<string>();

  let minOwnershipSeen = Infinity;

  for (const { lineup, ownership } of sorted) {
    // This lineup is on frontier if its ownership <= minimum seen
    // (since we're going down in projection, lower ownership = frontier)
    if (ownership <= minOwnershipSeen) {
      frontier.add(lineup.hash);
      minOwnershipSeen = ownership;
    }
  }

  return frontier;
}

// ============================================================
// BASELINE METRICS
// ============================================================

export interface BaselineMetrics {
  optimalProjection: number;
  optimalOwnership: number;
  avgProjection: number;
  avgOwnership: number;
  slateEfficiency: number;
}

/**
 * Calculate baseline metrics for comparison
 */
export function calculateBaselineMetrics(sortedLineups: Lineup[]): BaselineMetrics {
  if (sortedLineups.length === 0) {
    return {
      optimalProjection: 0,
      optimalOwnership: 0,
      avgProjection: 0,
      avgOwnership: 0,
      slateEfficiency: 0.5,
    };
  }

  const optimal = sortedLineups[0];
  const optimalProjection = optimal.projection;
  const optimalOwnership = calculateOwnershipSum(optimal);

  // Calculate averages
  let totalProjection = 0;
  let totalOwnership = 0;

  for (const lineup of sortedLineups) {
    totalProjection += lineup.projection;
    totalOwnership += calculateOwnershipSum(lineup);
  }

  const avgProjection = totalProjection / sortedLineups.length;
  const avgOwnership = totalOwnership / sortedLineups.length;

  // Slate efficiency: how correlated is projection with ownership
  // High efficiency = hard to find edge (projected players are owned)
  // Low efficiency = easier to find contrarian value
  const optimalNormalized = optimalOwnership / (optimal.players.length * 100);
  const slateEfficiency = Math.min(1, optimalNormalized);

  return {
    optimalProjection,
    optimalOwnership,
    avgProjection,
    avgOwnership,
    slateEfficiency,
  };
}
