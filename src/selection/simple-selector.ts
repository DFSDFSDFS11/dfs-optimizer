/**
 * DFS Optimizer CLI - Simple Formula-Based Selector
 *
 * Scores every lineup with the 5-component formula + quality gate + game stack,
 * then greedily selects with a natural diversity multiplier baked into the score.
 *
 * No ownership scenarios, no archetype targeting, no proportional filter,
 * no hard exposure caps. Exposure control is achieved entirely through the
 * diversity multiplier that smoothly decays as players/pairs become
 * over-represented in the selected portfolio.
 */

import {
  Lineup,
  ScoredLineup,
  SelectionResult,
  Player,
  ContestSize,
} from '../types';

import {
  normalizeProjectionScore,
  calculateVarianceScore,
  calculateRelativeValue,
  calculateOwnershipSum,
} from './scoring/lineup-scorer';

import { OptimizedWeights, loadOptimizedWeights } from './selector';
import { analyzeFieldCombos, analyzeDeepCombos, FieldComboAnalysis, DeepComboAnalysis, DifferentiatedCore, extractPrimaryCombo } from './scoring/field-analysis';
import { generateFieldPool } from './simulation/tournament-sim';
import { generateFieldEnsemble, FieldEnsemble } from './field-ensemble';

// ============================================================
// MC COMBO CROWDING DISCOUNT
// ============================================================
// When a lineup's combo overlaps heavily with the field, its wins
// get split with many entries. The crowding discount estimates this
// splitting and penalizes chalk combos mathematically, so the greedy
// loop naturally creates a barbell without forced tier quotas.

const CROWDING_ALPHA: Record<string, number> = {
  mlb: 0.6,     // MLB stacking makes combos highly correlated
  nfl: 0.5,
  nba: 0.15,    // NBA has concentrated ownership (fewer players) → higher crowding scores naturally
  mma: 0.2,
  nascar: 0.2,
  golf: 0.2,
};

// Weights for combining frequency signals into crowdingScore
const CROWDING_PRIMARY_WEIGHT = 500;   // Primary combo freq (stack core — most important)
const CROWDING_QUAD_WEIGHT = 200;      // Average 4-player combo frequency
const CROWDING_TRIPLE_WEIGHT = 50;     // Average 3-player combo frequency

// ============================================================
// TYPES
// ============================================================

interface ScoredCandidate {
  lineup: Lineup;
  formulaScore: number;    // Static formula score (doesn't change)
  projectionScore: number;
  ceilingScore: number;
  varianceScore: number;
  salaryEfficiencyScore: number;
  relativeValueScore: number;
  gameStackScore: number;
  ownershipSum: number;    // Sum of player ownerships — for Pareto efficiency
}

export interface SimpleSelectParams {
  lineups: Lineup[];
  targetCount: number;
  numGames: number;
  salaryCap?: number;
  weights?: OptimizedWeights;
  sport?: string;
  players?: Player[];  // Full player pool for field generation
  contestSize?: ContestSize;  // For field ensemble composition weights
  fieldSamples?: number;      // Number of field ensemble samples (3-5, default 3)
}

// ============================================================
// GAME STACK SCORE (same formula as backtester/selector)
// ============================================================

function computeGameStackScore(lineup: Lineup, numGames: number, sport?: string): number {
  // Pro data (63K entries, 17 slates) — top-1% hit rates by construction:
  //   3-2-2-1: 1.55% (best common),  6-1-1: 2.30% (best overall, rare)
  //   5-1-1-1: 1.53%,  4-3-1: 1.44%,  4-2-1-1: 1.36%,  5-2-1: 1.36%
  //   3-2-1-1-1: 1.25%,  3-3-2: 1.07%,  2-2-2-1-1: 0.91% (worst)

  let gameTotalSum = 0;
  let gameTotalCount = 0;
  for (const p of lineup.players) {
    if (p.gameTotal && p.gameTotal > 0) {
      gameTotalSum += p.gameTotal;
      gameTotalCount++;
    }
  }
  const slateAvgGameTotal = gameTotalCount > 0 ? gameTotalSum / gameTotalCount : 225;

  // --- MLB-specific: count same-TEAM batters (not same-game players) ---
  // MLB correlation is driven by same-team batters in the same lineup spot.
  // Pitchers don't correlate with batters. Opposing batters anti-correlate.
  if (sport === 'mlb') {
    return computeMLBStackScore(lineup, numGames, slateAvgGameTotal);
  }

  const gameGroups = new Map<string, { teams: Set<string>; count: number; gameTotal: number }>();
  for (const player of lineup.players) {
    const gameId = player.gameInfo || `${player.team}_game`;
    const group = gameGroups.get(gameId) || { teams: new Set(), count: 0, gameTotal: player.gameTotal || slateAvgGameTotal };
    group.teams.add(player.team);
    group.count++;
    gameGroups.set(gameId, group);
  }

  let stackBonus = 0;
  let maxStackSize = 0;
  const stackSizes: number[] = [];

  for (const [, group] of gameGroups) {
    const gameTotalScaler = group.gameTotal / slateAvgGameTotal;
    if (group.count > maxStackSize) maxStackSize = group.count;
    const hasBB = group.teams.size >= 2;

    if (group.count >= 4) {
      stackBonus += 0.05 * gameTotalScaler;
      if (hasBB) stackBonus += 0.03 * gameTotalScaler;
    } else if (group.count >= 3) {
      stackBonus += 0.04 * gameTotalScaler;
      if (hasBB) stackBonus += 0.02 * gameTotalScaler;
    } else if (group.count === 2) {
      stackBonus += 0.01 * gameTotalScaler;
    }

    if (group.count >= 2) stackSizes.push(group.count);
  }

  stackSizes.sort((a, b) => b - a);
  if (stackSizes.length >= 3) {
    stackBonus += 0.05;
  } else if (stackSizes.length >= 2) {
    stackBonus += 0.03;
  }

  const slateScaler = numGames <= 3 ? 0.80 : numGames <= 4 ? 0.90 : numGames <= 6 ? 1.00 : 1.10;
  return Math.max(0, Math.min(0.30, stackBonus * slateScaler));
}

/**
 * MLB-specific stack scoring based on same-team BATTER stacks.
 *
 * MLB correlation is about batters on the same team in the same lineup:
 *   - Same-team batters share game script, lineup protection, rally correlation
 *   - 4-man batter stack is the minimum for GPP viability
 *   - 5-man batter stack has significantly higher correlation (more shared ABs)
 *   - Bring-back (opposing batter) captures game total correlation
 *   - Pitchers are independent — they don't stack with batters
 */
function computeMLBStackScore(lineup: Lineup, numGames: number, slateAvgGameTotal: number): number {
  // Count same-team batters (exclude pitchers)
  const teamBatters = new Map<string, { count: number; gameTotal: number }>();
  const pitcherTeams = new Set<string>();

  for (const player of lineup.players) {
    if (player.positions.includes('P')) {
      pitcherTeams.add(player.team);
      continue;
    }
    const existing = teamBatters.get(player.team) || { count: 0, gameTotal: player.gameTotal || slateAvgGameTotal };
    existing.count++;
    teamBatters.set(player.team, existing);
  }

  // Find primary batter stack
  let maxBatterStack = 0;
  let primaryTeam = '';
  let primaryGameTotal = slateAvgGameTotal;
  for (const [team, info] of teamBatters) {
    if (info.count > maxBatterStack) {
      maxBatterStack = info.count;
      primaryTeam = team;
      primaryGameTotal = info.gameTotal;
    }
  }

  const gameTotalScaler = primaryGameTotal / slateAvgGameTotal;
  let stackBonus = 0;

  // 4-man batter stack: baseline for MLB GPP
  if (maxBatterStack >= 4) {
    stackBonus += 0.06 * gameTotalScaler;
  }

  // 5-man batter stack: significantly better correlation
  // More shared ABs, more rally upside, tighter outcome coupling
  if (maxBatterStack >= 5) {
    stackBonus += 0.08 * gameTotalScaler; // Big bonus on top of 4-man
  }

  // 6+ man batter stack: rare but maximum correlation
  if (maxBatterStack >= 6) {
    stackBonus += 0.05 * gameTotalScaler;
  }

  // Bring-back bonus: batter from opposing team captures game total correlation
  // Check if we have a batter whose team is the opponent of our primary stack
  let hasBringBack = false;
  for (const [team, info] of teamBatters) {
    if (team !== primaryTeam && info.count >= 1) {
      // Check if this team's batters are opponents of primary stack
      // (they share the same game — opposing team means correlated game total)
      for (const player of lineup.players) {
        if (player.team === primaryTeam && player.opponent === team) {
          hasBringBack = true;
          break;
        }
      }
      if (hasBringBack) break;
    }
  }

  if (hasBringBack) {
    stackBonus += 0.04 * gameTotalScaler;
  }

  // Secondary stack bonus (batters from a second team)
  const secondaryStacks = [...teamBatters.entries()]
    .filter(([team]) => team !== primaryTeam)
    .sort((a, b) => b[1].count - a[1].count);

  if (secondaryStacks.length > 0 && secondaryStacks[0][1].count >= 2) {
    stackBonus += 0.03; // Secondary 2-man batter stack
  }

  const slateScaler = numGames <= 3 ? 0.85 : numGames <= 5 ? 0.95 : 1.00;
  return Math.max(0, Math.min(0.35, stackBonus * slateScaler));
}

// ============================================================
// STACK WITH BRING-BACK CHECK
// ============================================================

/**
 * Returns true if the lineup has at least `minPlayers` from the same game
 * AND those players span 2+ teams (i.e., a bring-back / correlation stack).
 */
function hasStackWithBringBack(lineup: Lineup, minPlayers: number = 3): boolean {
  const gameGroups = new Map<string, { teams: Set<string>; count: number }>();
  for (const player of lineup.players) {
    const gameId = player.gameInfo || `${player.team}_game`;
    const group = gameGroups.get(gameId) || { teams: new Set(), count: 0 };
    group.teams.add(player.team);
    group.count++;
    gameGroups.set(gameId, group);
  }
  for (const [, group] of gameGroups) {
    if (group.count >= minPlayers && group.teams.size >= 2) return true;
  }
  return false;
}

// ============================================================
// CONSTRUCTION QUALITY MULTIPLIER
// ============================================================
// Pro data (63K entries, 17 slates): winning lineup constructions follow
// specific patterns. This multiplier is so large that only near-perfect
// projection+ownership lineups can compete without the right construction.
//
// Pro top-1% construction profile:
//   94% have 3+ primary stack, 93% have bring-back, 86% have secondary stack
//   55% of secondaries are same-team, avg secondary salary $5,797
//
// Without proper construction: multiplier = 0.40-0.60 (massive penalty)
// With perfect construction: multiplier = 1.20-1.50 (significant bonus)

export function computeConstructionMultiplier(lineup: Lineup, numGames: number, sport?: string): number {
  // Non-team sports (MMA/NASCAR/golf): no stacking concept, return 1.0
  if (sport && ['mma', 'nascar', 'golf'].includes(sport)) return 1.0;

  // MLB-specific: construction is about same-team BATTER stacks
  if (sport === 'mlb') {
    return computeMLBConstructionMultiplier(lineup, numGames);
  }

  // NFL/NBA: game-level stacking
  const gameGroups = new Map<string, { teams: Set<string>; count: number }>();
  for (const player of lineup.players) {
    const gameId = player.gameInfo || `${player.team}_game`;
    const group = gameGroups.get(gameId) || { teams: new Set(), count: 0 };
    group.teams.add(player.team);
    group.count++;
    gameGroups.set(gameId, group);
  }

  let maxStackSize = 0;
  let hasBringBack = false;
  let stackGroupCount = 0;

  for (const [, group] of gameGroups) {
    if (group.count > maxStackSize) maxStackSize = group.count;
    if (group.count >= 2 && group.teams.size >= 2) hasBringBack = true;
    if (group.count >= 2) stackGroupCount++;
  }

  if (numGames <= 2) return 1.0;

  let multiplier = 1.0;
  if (maxStackSize >= 3) multiplier *= 1.05;
  if (hasBringBack) multiplier *= 1.03;
  if (stackGroupCount >= 2) multiplier *= 1.05;

  return multiplier;
}

/**
 * MLB construction multiplier based on same-team batter stacks.
 *
 * 4-man batter stack = minimum viable GPP construction
 * 5-man batter stack = significantly better (more correlated outcomes)
 * Bring-back = captures game total correlation
 * <4 batters from same team = severe penalty (pool filter already blocks these,
 *   but this catches edge cases in edge-boosted generation)
 */
function computeMLBConstructionMultiplier(lineup: Lineup, numGames: number): number {
  if (numGames <= 1) return 1.0;

  const teamBatters = new Map<string, number>();
  for (const player of lineup.players) {
    if (player.positions.includes('P')) continue;
    teamBatters.set(player.team, (teamBatters.get(player.team) || 0) + 1);
  }

  let maxBatterStack = 0;
  for (const count of teamBatters.values()) {
    if (count > maxBatterStack) maxBatterStack = count;
  }

  let multiplier = 1.0;

  // Below 4-man batter stack: significant penalty (shouldn't be in pool but safety net)
  if (maxBatterStack < 4) {
    multiplier *= 0.60;
    return multiplier;
  }

  // 4-man batter stack: baseline GPP construction
  multiplier *= 1.08;

  // 5-man batter stack: strong correlation bonus
  if (maxBatterStack >= 5) {
    multiplier *= 1.12;
  }

  // 6+ man batter stack: maximum correlation
  if (maxBatterStack >= 6) {
    multiplier *= 1.06;
  }

  // Bring-back detection
  const primaryTeam = [...teamBatters.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (primaryTeam) {
    let hasBringBack = false;
    for (const player of lineup.players) {
      if (player.positions.includes('P')) continue;
      if (player.team !== primaryTeam) {
        // Check if opposing batter shares a game with primary stack
        for (const p2 of lineup.players) {
          if (p2.team === primaryTeam && !p2.positions.includes('P') && p2.opponent === player.team) {
            hasBringBack = true;
            break;
          }
        }
        if (hasBringBack) break;
      }
    }
    if (hasBringBack) multiplier *= 1.05;
  }

  return multiplier;
}

// ============================================================
// FORMULA SCORING (matches backtester/selector exactly)
// ============================================================

function computeFormulaScore(
  projectionScore: number,
  ceilingScore: number,
  varianceScore: number,
  salaryEfficiencyScore: number,
  relativeValueScore: number,
  gameStackScore: number,
  weights: OptimizedWeights,
  salary: number,
  salaryCap: number,
  constructionMultiplier: number,
  fieldComboFreq: number = 0,
  sport?: string,
): number {
  // NBA ceiling amplifier: pros' 14-pt avg actual advantage comes from selecting
  // lineups whose players boom TOGETHER. Boosting ceiling weight pushes the selector
  // toward high-ceiling correlated builds — the same lineups that score 290+ when
  // the game script goes right.
  const ceilingAmplifier = sport === 'nba' ? 1.3 : sport === 'nfl' ? 1.15 : 1.0;
  const effectiveCeilingScore = ceilingScore * ceilingAmplifier;

  // 5-component additive score (proven formula that achieved 1.42% top-1%)
  // NO ownership in the additive score — backtests show ownership is a negative predictor (-0.24)
  const additiveScore = (
    projectionScore * (weights.projectionScore || 0.20) +
    effectiveCeilingScore * (weights.ceilingScore || 0.20) +
    varianceScore * (weights.varianceScore || 0.20) +
    salaryEfficiencyScore * (weights.salaryEfficiencyScore || 0.10) +
    relativeValueScore * (weights.relativeValueScore || 0.30)
  );

  // Quality gate (thresholds from formula sweep)
  const projGateThresh = weights.projGateThreshold || 0.50;
  const ceilGateThresh = weights.ceilGateThreshold || 0.40;
  const projGate = Math.min(1, projectionScore / projGateThresh);
  const ceilGate = Math.min(1, ceilingScore / ceilGateThresh);
  const qualityGate = Math.sqrt(projGate * ceilGate);

  // Salary floor penalty — winners avg $49,898 salary (only $102 remaining).
  const salaryFloorGate = salary >= (salaryCap - 500) ? 1.0
    : salary >= (salaryCap - 1000) ? 0.92
    : salary >= (salaryCap - 2000) ? 0.75
    : 0.5;

  // Ceiling-weighted combo crowding: common combo + high ceiling = MAX crowding risk.
  // When a chalk combo booms, ALL field lineups with that combo boom together — you split.
  // A high-ceiling lineup with a common combo is MORE crowded in boom worlds than a
  // low-ceiling lineup with the same combo, because ceilings correlate with the worlds
  // where you actually finish in the money.
  //
  // Base discount at 10% field freq: 1/(1+0.10*3.0) = 0.77 (23% penalty)
  // With ceiling weighting at ceilingScore=0.9: effective freq = 0.10*0.9 = 0.09
  //   → 1/(1+0.09*3.0) = 0.79 — still heavy penalty (high ceiling + common combo = bad)
  // With ceiling weighting at ceilingScore=0.3: effective freq = 0.10*0.3 = 0.03
  //   → 1/(1+0.03*3.0) = 0.92 — lighter penalty (low ceiling + common combo = less risk)
  const COMBO_LEVERAGE_WEIGHT = 3.0;
  const ceilingWeight = Math.max(0.3, Math.min(1.0, ceilingScore));
  const effectiveComboFreq = fieldComboFreq * ceilingWeight;
  const comboLeverageDiscount = effectiveComboFreq > 0
    ? 1 / (1 + effectiveComboFreq * COMBO_LEVERAGE_WEIGHT)
    : 1.0;

  // Core formula: additive × quality gate × game stack × construction × salary floor × combo leverage
  return additiveScore * qualityGate * salaryFloorGate * (1 + gameStackScore) * constructionMultiplier * comboLeverageDiscount;
}

// ============================================================
// DIVERSITY MULTIPLIER (replaces hard exposure caps)
// ============================================================

/**
 * Smooth decay factor for a single player's exposure level.
 * Returns 1.0 when exposure is low, decays toward 0 as exposure increases.
 *
 * POSITION-SPECIFIC: Batters have a tighter cap than pitchers.
 * - Batters: start decay at 7%, wall at 20%. On a 1500-lineup portfolio,
 *   20% = 300 lineups per batter. Going higher concentrates too much risk.
 *   Backtest showed 30% Raleigh (scored 0), 26% Raley (scored 0), 23% Carroll (scored 2).
 * - Pitchers: start decay at 12%, wall at 35%. Fewer viable pitchers per slate
 *   (12-15 vs 50+ batters), and every lineup needs 2 — so higher exposure is natural.
 *
 * Batter behavior:
 *   8% exposure → 1.00, 15% → 0.70, 20% → 0.30, 25% → 0.05, 28%+ → ~0.01
 * Pitcher behavior:
 *   12% exposure → 1.00, 20% → 0.65, 28% → 0.18, 35% → 0.03
 */
function playerExposureFactor(exposure: number, isPitcher: boolean = false): number {
  if (isPitcher) {
    // Pitchers: gentler curve, higher ceiling
    if (exposure <= 0.12) return 1.0;
    const x = exposure - 0.12;
    const penalty = x * x * 30 + x * x * x * x * 1000;
    return 1 / (1 + penalty);
  } else {
    // Batters: 25% effective cap — balances diversification (avg/cash rate) with
    // tail upside (best lineups need some concentration). Backtest showed 20% was
    // too tight (raised avg +1.9 but killed best lineup from 149→131).
    if (exposure <= 0.08) return 1.0;
    const x = exposure - 0.08;
    const penalty = x * x * 55 + x * x * x * x * 2500;
    return 1 / (1 + penalty);
  }
}

/**
 * Smooth decay factor for a pair's co-occurrence frequency.
 * Relaxed from 6% to 10%: pro portfolios naturally have common pairs
 * from game stacking (3+ players from same game creates many pairs).
 *
 * Behavior:
 *   10% pair freq → 1.00
 *   15% pair freq → 0.72
 *   20% pair freq → 0.38
 *   25% pair freq → 0.16
 */
function pairExposureFactor(freq: number): number {
  // Original threshold from 1.42% baseline: 8% pair freq start
  if (freq <= 0.08) return 1.0;
  const x = freq - 0.08;
  const penalty = x * x * 40 + x * x * x * x * 1000;
  return 1 / (1 + penalty);
}


/**
 * Field combo leverage score: measures how rare a lineup's 3-man and 4-man
 * combos are relative to SYNTHETIC FIELD lineups (not our own pool).
 *
 * Uses field combo frequencies from `analyzeFieldCombos()` which models
 * actual opponent behavior using 10 archetypes with position-calibrated
 * ownership weighting.
 *
 * Returns 0-1 score where 1 = maximally unique vs field.
 */
function computeFieldComboLeverageScore(
  lineup: Lineup,
  comboKeys: LineupComboKeys,
  fieldCombos: FieldComboAnalysis,
): number {
  const n = lineup.players.length;
  if (n < 3) return 0.5;

  // Average 3-man combo frequency in FIELD (not pool)
  // avgTripleFreq 0% → 1.0 (field never builds this), 5%+ → 0.0
  let tripleFreqSum = 0;
  for (const key of comboKeys.tripleKeys) {
    tripleFreqSum += fieldCombos.triples.get(key) || 0;
  }
  const avgTripleFreq = comboKeys.tripleKeys.length > 0
    ? tripleFreqSum / comboKeys.tripleKeys.length : 0;
  const tripleRarity = Math.max(0, Math.min(1, 1 - avgTripleFreq / 0.05));

  // Average 4-man combo frequency in FIELD
  // avgQuadFreq 0% → 1.0, 2%+ → 0.0 (quads are rarer, tighter threshold)
  let quadFreqSum = 0;
  for (const key of comboKeys.quadKeys) {
    quadFreqSum += fieldCombos.quads.get(key) || 0;
  }
  const avgQuadFreq = comboKeys.quadKeys.length > 0
    ? quadFreqSum / comboKeys.quadKeys.length : 0;
  const quadRarity = Math.max(0, Math.min(1, 1 - avgQuadFreq / 0.02));

  return tripleRarity * 0.40 + quadRarity * 0.60;
}

/**
 * Differentiated core bonus: rewards lineups containing player combos
 * that appear in our pool but rarely in the field. Uses `analyzeDeepCombos()`
 * output to identify structural GPP edges at the 3/4/5-man level.
 *
 * Returns 0-1 score where 1 = lineup contains a maximally differentiated core.
 */
function computeDifferentiatedCoreBonus(
  comboKeys: LineupComboKeys,
  coreLookup3: Map<string, number>,
  coreLookup4: Map<string, number>,
  coreLookup5: Map<string, number>,
): number {
  // Find best matching core at each depth
  let best3 = 0;
  for (const key of comboKeys.tripleKeys) {
    const score = coreLookup3.get(key);
    if (score !== undefined && score > best3) best3 = score;
  }

  let best4 = 0;
  for (const key of comboKeys.quadKeys) {
    const score = coreLookup4.get(key);
    if (score !== undefined && score > best4) best4 = score;
  }

  let best5 = 0;
  for (const key of comboKeys.quintKeys) {
    const score = coreLookup5.get(key);
    if (score !== undefined && score > best5) best5 = score;
  }

  // Weight: 5-man (50%) >> 4-man (35%) >> 3-man (15%)
  // A unique 5-man core = 62.5% of lineup is different from field
  return best3 * 0.15 + best4 * 0.35 + best5 * 0.50;
}

/**
 * Calculate diversity multiplier for a candidate lineup given current portfolio state.
 * Combines per-player exposure decay and pair frequency decay into a single
 * multiplicative factor (0 to 1).
 *
 * Uses geometric mean so the penalty is fair across different roster sizes.
 */
// Pre-computed combo keys for a lineup (cached to avoid re-generating)
interface LineupComboKeys {
  tripleKeys: string[];
  quadKeys: string[];
  quintKeys: string[];
}

function precomputeComboKeys(lineup: Lineup): LineupComboKeys {
  const sortedIds = lineup.players.map(p => p.id).sort();
  const n = sortedIds.length;
  const tripleKeys: string[] = [];
  const quadKeys: string[] = [];
  const quintKeys: string[] = [];

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (let k = j + 1; k < n; k++) {
        tripleKeys.push(sortedIds[i] + '|' + sortedIds[j] + '|' + sortedIds[k]);
        for (let l = k + 1; l < n; l++) {
          quadKeys.push(sortedIds[i] + '|' + sortedIds[j] + '|' + sortedIds[k] + '|' + sortedIds[l]);
          // Quint combos (5-man): C(6,5)=6 for MMA, C(8,5)=56 for NBA
          // Only generate for small rosters (≤8) to avoid combinatorial explosion
          if (n <= 8) {
            for (let m = l + 1; m < n; m++) {
              quintKeys.push(sortedIds[i] + '|' + sortedIds[j] + '|' + sortedIds[k] + '|' + sortedIds[l] + '|' + sortedIds[m]);
            }
          }
        }
      }
    }
  }
  return { tripleKeys, quadKeys, quintKeys };
}

function calculateDiversityMultiplier(
  lineup: Lineup,
  playerCounts: Map<string, number>,
  pairCounts: Map<string, number>,
  selectedCount: number,
): number {
  // Start diversity early — combo overlap builds fast even with 8-player rosters
  if (selectedCount < 3) return 1.0;

  const players = lineup.players;
  const n = players.length;

  // Player exposure (geometric mean) — position-specific decay
  let playerProduct = 1.0;
  let worstBatterExposure = 0;
  let worstPitcherExposure = 0;
  for (const p of players) {
    const exposure = (playerCounts.get(p.id) || 0) / selectedCount;
    const isPitcher = p.positions.some((pos: string) => pos === 'P' || pos === 'SP' || pos === 'RP');
    playerProduct *= playerExposureFactor(exposure, isPitcher);
    if (isPitcher) {
      if (exposure > worstPitcherExposure) worstPitcherExposure = exposure;
    } else {
      if (exposure > worstBatterExposure) worstBatterExposure = exposure;
    }
  }
  const playerDiversity = Math.pow(playerProduct, 1 / n);

  // Worst-player exposure penalty — position-specific thresholds.
  // Batters: hard wall at 25%. Balances diversification with tail upside.
  // 20% was too tight (killed best lineup 149→131). 30% was too loose (Raleigh 30%, scored 0).
  // Pitchers: wall at 30% (fewer options, need 2 per lineup).
  let worstPlayerPenalty = 1.0;
  if (worstBatterExposure > 0.25) {
    const over = worstBatterExposure - 0.25;
    // 27% → 0.55, 30% → 0.12, 33% → 0.03
    worstPlayerPenalty *= 1 / (1 + over * over * 300 + over * over * over * over * 8000);
  }
  if (worstPitcherExposure > 0.30) {
    const over = worstPitcherExposure - 0.30;
    worstPlayerPenalty *= 1 / (1 + over * over * 200 + over * over * over * over * 5000);
  }

  // Pair exposure (geometric mean)
  let pairProduct = 1.0;
  let pairCount = 0;
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const key = players[i].id < players[j].id
        ? `${players[i].id}|${players[j].id}`
        : `${players[j].id}|${players[i].id}`;
      const freq = (pairCounts.get(key) || 0) / selectedCount;
      pairProduct *= pairExposureFactor(freq);
      pairCount++;
    }
  }
  const pairDiversity = pairCount > 0 ? Math.pow(pairProduct, 1 / pairCount) : 1.0;

  // Blend: player diversity × pair diversity × worst-player penalty
  const rosterSize = lineup.players.length;
  const baseDiversity = rosterSize <= 6
    ? Math.pow(playerDiversity, 0.40) * Math.pow(pairDiversity, 0.60)
    : Math.pow(playerDiversity, 0.60) * Math.pow(pairDiversity, 0.40);

  return baseDiversity * worstPlayerPenalty;
}

// ============================================================
// MAIN SELECTION FUNCTION
// ============================================================

/**
 * Simple formula-based selection.
 *
 * 1. Score every lineup with the 5-component formula
 * 2. Sort by formula score descending
 * 3. Greedy selection: pick the lineup with highest (formulaScore × diversityMultiplier)
 * 4. Update player/pair counts and repeat
 */
export function selectLineupsSimple(params: SimpleSelectParams): SelectionResult {
  const { lineups, numGames, salaryCap } = params;
  // Short slates (2-3 games) have fewer unique combos — cap lineup count
  // to avoid exhausting diversity and getting stuck
  const maxForSlate = numGames <= 2 ? 150 : numGames <= 3 ? 300 : params.targetCount;
  const targetCount = Math.min(params.targetCount, maxForSlate);
  if (targetCount < params.targetCount) {
    console.log(`\n  Short slate (${numGames} games): capping lineups at ${targetCount} (requested ${params.targetCount})`);
  }
  const weights = { ...(params.weights || loadOptimizedWeights()) };
  const cap = salaryCap || 50000;

  // For non-team sports: boost ceiling/variance weights, zero out gameEnvironment
  const isNonTeamSport = params.sport && ['mma', 'nascar', 'golf'].includes(params.sport);
  if (isNonTeamSport) {
    weights.gameEnvironmentScore = 0;
    weights.varianceScore = Math.max(weights.varianceScore || 0, 0.10);
    weights.ceilingRatioScore = Math.max(weights.ceilingRatioScore || 0, 0.05);
  }

  if (lineups.length === 0) {
    return { selected: [], exposures: new Map(), avgProjection: 0, avgOwnership: 0 };
  }

  console.log(`\n  Simple selector: ${lineups.length.toLocaleString()} candidates, target ${targetCount}`);

  // --- Step 0.5: Identify chalk teams for depth quota enforcement ---
  const chalkTeams = new Set<string>();
  const teamBatterOwnership = new Map<string, number>();
  const CHALK_DEEP_HEDGE_PCT = 0.10;   // 10% of portfolio for 4-5 man chalk stacks
  const CHALK_PARTIAL_PCT = 0.08;      // 8% of portfolio for 3-man chalk combos

  if (!isNonTeamSport && params.players && params.players.length > 0) {
    const adjustedThreshold = numGames <= 3 ? 25 : numGames <= 5 ? 20 : 18;
    const teamPlayersMap = new Map<string, Player[]>();
    for (const p of params.players) {
      if (!teamPlayersMap.has(p.team)) teamPlayersMap.set(p.team, []);
      teamPlayersMap.get(p.team)!.push(p);
    }
    for (const [team, teamPlayers] of teamPlayersMap) {
      const batters = teamPlayers.filter(p =>
        !p.positions.some((pos: string) => pos === 'P' || pos === 'SP' || pos === 'RP') &&
        p.projection > 0
      );
      if (batters.length < 3) continue;
      const avgOwn = batters.reduce((s, p) => s + p.ownership, 0) / batters.length;
      teamBatterOwnership.set(team, avgOwn);
      if (avgOwn >= adjustedThreshold) {
        chalkTeams.add(team);
      }
    }
    if (chalkTeams.size > 0) {
      console.log(`\n  [ChalkAvoid] Chalk teams (avg batter own > ${numGames <= 3 ? 25 : numGames <= 5 ? 20 : 18}%):`);
      for (const team of chalkTeams) {
        console.log(`  [ChalkAvoid]   ${team}: avg batter own ${teamBatterOwnership.get(team)?.toFixed(1)}%`);
      }
      console.log(`  [ChalkAvoid] Allocation: ${(CHALK_DEEP_HEDGE_PCT*100).toFixed(0)}% per chalk team hedge (4-5 man), ${(CHALK_PARTIAL_PCT*100).toFixed(0)}% partial (3-man)`);
    }
  }

  // Chalk depth tracking for portfolio selection
  const chalkHedgeCounts = new Map<string, number>();  // 4-5 man stacks per chalk team
  const chalkPartialCounts = new Map<string, number>(); // 3-man combos per chalk team
  for (const team of chalkTeams) {
    chalkHedgeCounts.set(team, 0);
    chalkPartialCounts.set(team, 0);
  }

  // --- Step 1: Compute pool-level stats ---
  let minProj = Infinity, maxProj = -Infinity;
  let optIdx = 0;
  for (let i = 0; i < lineups.length; i++) {
    const p = lineups[i].projection;
    if (p < minProj) minProj = p;
    if (p > maxProj) { maxProj = p; optIdx = i; }
  }
  const optimalProjection = maxProj;
  const optimalOwnership = calculateOwnershipSum(lineups[optIdx]);

  // --- Step 2: Projection floor — aggressive to capture winning low-proj builds ---
  // Data: 70 of top 100 actual-scoring SS lineups projected below 80% of optimal.
  // Winners project at 71-83% of optimal. Must allow full range for GPP upside.
  // NBA/NFL: 90% — tight ranges, low-proj NBA lineups are just bad
  // MLB: 68% — winners project 71-83% of optimal
  const projFloorPct = isNonTeamSport ? 0.70
    : params.sport === 'mlb' ? 0.68
    : (params.sport === 'nba' || params.sport === 'nfl') ? 0.90
    : (numGames <= 3 ? 0.82 : 0.80);
  const projFloor = optimalProjection * projFloorPct;

  // --- Step 2.55: Generate field ensemble for combo leverage ---
  const playerMap = new Map<string, Player>();
  if (params.players) {
    for (const p of params.players) playerMap.set(p.id, p);
  }
  const rosterSize = lineups[0]?.players.length || 8;

  let ensemble: FieldEnsemble | null = null;
  if (params.players && params.players.length > 0) {
    console.log(`\n  --- FIELD ENSEMBLE GENERATION ---`);
    ensemble = generateFieldEnsemble(
      params.players, rosterSize,
      params.contestSize || '20max',
      params.fieldSamples || 3,
      salaryCap || 50000,
      params.sport,
    );
  }

  // Apply projection floor — relax by up to 4% for lineups with rare primary combos
  const RARE_COMBO_THRESHOLD = 0.02;
  const MAX_FLOOR_RELAXATION = 0.04;

  const validLineups = lineups.filter(l => {
    if (l.projection >= projFloor) return true;
    if (!ensemble) return false;
    // Rare-combo lineups get a relaxed floor
    const pc = extractPrimaryCombo(l, playerMap, params.sport);
    const fieldFreq = ensemble.combinedPrimaryCombos.get(pc.comboKey) || 0;
    if (fieldFreq >= RARE_COMBO_THRESHOLD) return false;
    const comboRarity = 1 - fieldFreq / RARE_COMBO_THRESHOLD;
    const effectiveFloor = projFloor * (1 - MAX_FLOOR_RELAXATION * comboRarity);
    return l.projection >= effectiveFloor;
  });

  const filteredCount = lineups.length - validLineups.length;
  console.log(`  Projection floor: ${(projFloorPct * 100).toFixed(0)}% of optimal (${projFloor.toFixed(1)}), filtered ${filteredCount} lineups`);

  // --- Step 2.5: Pre-compute combo keys + ceiling/variance for valid lineups ---
  const validCeilingCache: number[] = new Array(validLineups.length);
  const validVarianceCache: number[] = new Array(validLineups.length);
  let validMinCeil = Infinity, validMaxCeil = -Infinity;
  for (let i = 0; i < validLineups.length; i++) {
    const vd = calculateVarianceScore(validLineups[i]);
    validCeilingCache[i] = vd.ceiling;
    validVarianceCache[i] = vd.score;
    if (vd.ceiling < validMinCeil) validMinCeil = vd.ceiling;
    if (vd.ceiling > validMaxCeil) validMaxCeil = vd.ceiling;
  }
  const validCeilingRange = validMaxCeil - validMinCeil;

  const lineupComboKeys: LineupComboKeys[] = new Array(validLineups.length);
  for (let i = 0; i < validLineups.length; i++) {
    lineupComboKeys[i] = precomputeComboKeys(validLineups[i]);
  }

  // --- Step 2.55b: Pre-compute primary combo field frequency per candidate ---
  const candidatePrimaryComboFreqs = new Float64Array(validLineups.length);
  const candidatePrimaryComboKeys: string[] = new Array(validLineups.length);
  if (ensemble) {
    for (let i = 0; i < validLineups.length; i++) {
      const pc = extractPrimaryCombo(validLineups[i], playerMap, params.sport);
      candidatePrimaryComboKeys[i] = pc.comboKey;
      candidatePrimaryComboFreqs[i] = ensemble.combinedPrimaryCombos.get(pc.comboKey) || 0;
    }
  }

  // --- Step 2.6: Score all lineups ---
  const candidates: ScoredCandidate[] = new Array(validLineups.length);
  for (let i = 0; i < validLineups.length; i++) {
    const l = validLineups[i];
    const projectionScore = normalizeProjectionScore(l.projection, minProj, maxProj);
    const ceilingScore = validCeilingRange > 0
      ? Math.max(0, Math.min(1, (validCeilingCache[i] - validMinCeil) / validCeilingRange))
      : 0.5;
    const varianceScore = validVarianceCache[i];
    const relValue = calculateRelativeValue(l, optimalProjection, optimalOwnership);

    const salaryLeft = cap - l.salary;
    const x = Math.min(1, salaryLeft / 1800);
    const salaryEfficiencyScore = Math.max(0.1, 1 - x * x);

    const gameStackScore = computeGameStackScore(l, numGames, params.sport);

    // Construction quality: multiplier for proper stacking patterns
    const constructionMult = computeConstructionMultiplier(l, numGames, params.sport);

    const formulaScore = computeFormulaScore(
      projectionScore, ceilingScore, varianceScore,
      salaryEfficiencyScore, relValue.relativeValueScore,
      gameStackScore, weights,
      l.salary, cap,
      constructionMult,
      candidatePrimaryComboFreqs[i],
      params.sport,
    );

    const ownershipSum = l.players.reduce((s, p) => s + (p.ownership || 0), 0);
    candidates[i] = {
      lineup: l,
      formulaScore,
      projectionScore,
      ceilingScore,
      varianceScore,
      salaryEfficiencyScore,
      relativeValueScore: relValue.relativeValueScore,
      gameStackScore,
      ownershipSum,
    };
  }

  // --- Step 2.7: Sort by formula score, keep top candidates ---
  // No ownership-biased Pareto filter — the formula already balances projection, ceiling, etc.
  // Cap at 20K to prevent OOM from combo key caches on large pools.
  candidates.sort((a, b) => b.formulaScore - a.formulaScore);
  const MAX_CANDIDATES = 20000;
  const sortedCandidates = candidates.length > MAX_CANDIDATES
    ? candidates.slice(0, MAX_CANDIDATES)
    : candidates;

  if (candidates.length > MAX_CANDIDATES) {
    console.log(`  Candidate pool: ${candidates.length.toLocaleString()} → top ${sortedCandidates.length.toLocaleString()} by formula score`);
  } else {
    console.log(`  Candidate pool: ${sortedCandidates.length.toLocaleString()} lineups`);
  }
  console.log(`  Formula scores: top=${sortedCandidates[0].formulaScore.toFixed(4)}, median=${sortedCandidates[Math.floor(sortedCandidates.length / 2)].formulaScore.toFixed(4)}, bottom=${sortedCandidates[sortedCandidates.length - 1].formulaScore.toFixed(4)}`);

  // --- Step 3: Build combo keys cache aligned with sorted candidates ---
  const comboKeysCache: LineupComboKeys[] = new Array(sortedCandidates.length);
  for (let i = 0; i < sortedCandidates.length; i++) {
    comboKeysCache[i] = precomputeComboKeys(sortedCandidates[i].lineup);
  }

  // --- Step 3.5: Pre-compute max quad field frequency per candidate ---
  // Used for combo-uniqueness tiebreaking: among candidates with similar adjusted
  // scores, prefer the one whose worst (highest) quad combo freq in the field is lowest.
  const candidateMaxQuadFreqs = new Float64Array(sortedCandidates.length);
  if (ensemble) {
    for (let i = 0; i < sortedCandidates.length; i++) {
      let maxQuadFreq = 0;
      for (const key of comboKeysCache[i].quadKeys) {
        const freq = ensemble.combinedQuads.get(key) || 0;
        if (freq > maxQuadFreq) maxQuadFreq = freq;
      }
      candidateMaxQuadFreqs[i] = maxQuadFreq;
    }
  }

  // --- Step 3.6: Pre-compute crowding scores per sorted candidate ---
  // Built on sortedCandidates index space (fixes index mismatch with candidatePrimaryComboKeys)
  const sortedPrimaryComboKeys: string[] = new Array(sortedCandidates.length);
  const sortedPrimaryComboFreqs = new Float64Array(sortedCandidates.length);
  const candidateCrowdingScores = new Float64Array(sortedCandidates.length);

  const crowdingAlpha = CROWDING_ALPHA[params.sport || ''] ?? 0.4;

  if (ensemble) {
    for (let i = 0; i < sortedCandidates.length; i++) {
      // Rebuild primary combo on correct (sorted) index
      const pc = extractPrimaryCombo(sortedCandidates[i].lineup, playerMap, params.sport);
      sortedPrimaryComboKeys[i] = pc.comboKey;
      sortedPrimaryComboFreqs[i] = ensemble.combinedPrimaryCombos.get(pc.comboKey) || 0;

      // Average triple frequency
      const tripleKeys = comboKeysCache[i].tripleKeys;
      let tripleSum = 0;
      for (const key of tripleKeys) {
        tripleSum += ensemble.combinedTriples.get(key) || 0;
      }
      const avgTripleFreq = tripleKeys.length > 0 ? tripleSum / tripleKeys.length : 0;

      // Average quad frequency (reuse candidateMaxQuadFreqs as proxy — already computed)
      // For a more accurate average, compute from all quads
      const quadKeys = comboKeysCache[i].quadKeys;
      let quadSum = 0;
      for (const key of quadKeys) {
        quadSum += ensemble.combinedQuads.get(key) || 0;
      }
      const avgQuadFreq = quadKeys.length > 0 ? quadSum / quadKeys.length : 0;

      // Composite crowding score
      const primaryFreq = sortedPrimaryComboFreqs[i];
      candidateCrowdingScores[i] = primaryFreq * CROWDING_PRIMARY_WEIGHT
        + avgQuadFreq * CROWDING_QUAD_WEIGHT
        + avgTripleFreq * CROWDING_TRIPLE_WEIGHT;
    }

    // Log crowding score distribution for the pool
    const poolScores = [...candidateCrowdingScores].sort((a, b) => a - b);
    const pn = poolScores.length;
    if (pn > 0) {
      console.log(`  Crowding scores (alpha=${crowdingAlpha}): p10=${poolScores[Math.floor(pn*0.1)].toFixed(2)}, median=${poolScores[Math.floor(pn*0.5)].toFixed(2)}, p90=${poolScores[Math.floor(pn*0.9)].toFixed(2)}`);
      const heavyPenalty = poolScores.filter(s => 1/(1+crowdingAlpha*s) < 0.5).length;
      console.log(`  Pool lineups with >50% crowding penalty: ${heavyPenalty}/${pn} (${(heavyPenalty/pn*100).toFixed(0)}%)`);
    }
  }

  // --- Step 4: Pre-compute candidate ID sets for speed ---
  const candidateIdSets: Set<string>[] = new Array(sortedCandidates.length);
  for (let i = 0; i < sortedCandidates.length; i++) {
    candidateIdSets[i] = new Set(sortedCandidates[i].lineup.players.map(p => p.id));
  }

  // --- Step 4.1: Pre-compute chalk depth per candidate ---
  // For each candidate, compute max number of batters from any single chalk team.
  // Used for chalk depth quota enforcement and tiebreaking.
  const candidateMaxChalkDepth = new Uint8Array(sortedCandidates.length);
  const candidateMaxChalkTeam: string[] = new Array(sortedCandidates.length).fill('');
  if (chalkTeams.size > 0) {
    for (let i = 0; i < sortedCandidates.length; i++) {
      const lu = sortedCandidates[i].lineup;
      let maxDepth = 0;
      let maxTeam = '';
      const chalkCounts = new Map<string, number>();
      for (const p of lu.players) {
        if (chalkTeams.has(p.team)) {
          // For MLB, only count batters (not pitchers)
          if (params.sport === 'mlb' && p.positions.some((pos: string) => pos === 'P' || pos === 'SP' || pos === 'RP')) continue;
          const ct = (chalkCounts.get(p.team) || 0) + 1;
          chalkCounts.set(p.team, ct);
          if (ct > maxDepth) {
            maxDepth = ct;
            maxTeam = p.team;
          }
        }
      }
      candidateMaxChalkDepth[i] = maxDepth;
      candidateMaxChalkTeam[i] = maxTeam;
    }
  }

  // --- Step 4.5: Ensure absolute optimal (cash-game) lineup is first ---
  // The highest raw projection lineup should ALWAYS be in the portfolio.
  // It's the lineup you'd play in a cash game — and if the chalk hits, you want it.
  // Find it and move it to position 0.
  let optimalIdx = 0;
  for (let i = 1; i < sortedCandidates.length; i++) {
    if (sortedCandidates[i].lineup.projection > sortedCandidates[optimalIdx].lineup.projection) {
      optimalIdx = i;
    }
  }
  if (optimalIdx !== 0) {
    [sortedCandidates[0], sortedCandidates[optimalIdx]] = [sortedCandidates[optimalIdx], sortedCandidates[0]];
    [comboKeysCache[0], comboKeysCache[optimalIdx]] = [comboKeysCache[optimalIdx], comboKeysCache[0]];
    [candidateIdSets[0], candidateIdSets[optimalIdx]] = [candidateIdSets[optimalIdx], candidateIdSets[0]];
  }
  console.log(`  Optimal lineup: ${sortedCandidates[0].lineup.projection.toFixed(1)} pts, own ${sortedCandidates[0].ownershipSum.toFixed(0)}% (always selected as #1)`);

  // --- Step 5: Greedy selection with diversity + BARBELL ALLOCATION ---
  const selected: ScoredLineup[] = [];
  const playerCounts = new Map<string, number>();
  const pairCounts = new Map<string, number>();
  const primaryComboCounts = new Map<string, number>();  // Portfolio combo concentration
  const selectedHashes = new Set<string>();

  const SCAN_WINDOW = Math.min(sortedCandidates.length, 5000);
  const FREE_PASS_PICKS = 10;

  // Track selected lineup player sets for max-overlap penalty
  const selectedPlayerSets: Set<string>[] = [];
  const portfolioRosterSize = validLineups[0]?.players.length || lineups[0]?.players.length || 8;
  const overlapThreshold = portfolioRosterSize - 2;

  // --- BARBELL ALLOCATION QUOTAS ---
  // Sport-specific tier ranges:
  // NBA/NFL: 90% floor, tight range — no junk lineups, quality throughout
  // MLB: 68% floor, wide range — winners project at 71-83% of optimal
  const isNBAorNFL = params.sport === 'nba' || params.sport === 'nfl';
  const BARBELL_QUOTAS: { [key: string]: { projRange: [number, number]; targetPct: number; label: string } } = isNBAorNFL ? {
    high:  { projRange: [0.97, 1.01], targetPct: 0.30, label: 'high-proj' },
    mid:   { projRange: [0.94, 0.97], targetPct: 0.35, label: 'mid-proj' },
    low:   { projRange: [0.91, 0.94], targetPct: 0.25, label: 'low-proj contrarian' },
    ultra: { projRange: [0.88, 0.91], targetPct: 0.08, label: 'ultra-contrarian' },
    floor: { projRange: [0.00, 0.88], targetPct: 0.02, label: 'extreme lottery' },
  } : {
    high:  { projRange: [0.93, 1.01], targetPct: 0.20, label: 'high-proj' },
    mid:   { projRange: [0.86, 0.93], targetPct: 0.20, label: 'mid-proj' },
    low:   { projRange: [0.79, 0.86], targetPct: 0.30, label: 'low-proj contrarian' },
    ultra: { projRange: [0.72, 0.79], targetPct: 0.20, label: 'ultra-contrarian' },
    floor: { projRange: [0.00, 0.72], targetPct: 0.10, label: 'extreme lottery' },
  };

  const tierCounts = new Map<string, number>();
  for (const key of Object.keys(BARBELL_QUOTAS)) tierCounts.set(key, 0);

  function getProjectionTier(projection: number): string {
    const pct = projection / optimalProjection;
    for (const [key, quota] of Object.entries(BARBELL_QUOTAS)) {
      if (pct >= quota.projRange[0] && pct < quota.projRange[1]) return key;
    }
    return 'floor';
  }

  // Count available candidates per tier for diagnostics (kept for logging)
  const tierAvailable = new Map<string, number>();
  for (const c of sortedCandidates) {
    const tier = getProjectionTier(c.lineup.projection);
    tierAvailable.set(tier, (tierAvailable.get(tier) || 0) + 1);
  }

  console.log(`\n  --- POOL TIER INVENTORY ---`);
  for (const [key, quota] of Object.entries(BARBELL_QUOTAS)) {
    const avail = tierAvailable.get(key) || 0;
    console.log(`  ${quota.label.padEnd(22)} available: ${String(avail).padStart(5)}`);
  }

  // Ownership tracking for spread enforcement
  const OWN_BUCKETS = [
    { label: '0-5%', min: 0, max: 5 },
    { label: '5-8%', min: 5, max: 8 },
    { label: '8-12%', min: 8, max: 12 },
    { label: '12-16%', min: 12, max: 16 },
    { label: '16-20%', min: 16, max: 20 },
    { label: '20%+', min: 20, max: 999 },
  ];
  const ownBucketCounts = new Map<string, number>();
  for (const b of OWN_BUCKETS) ownBucketCounts.set(b.label, 0);

  function getOwnBucket(lineup: Lineup): string {
    const avgOwn = lineup.players.reduce((s, p) => s + (p.ownership || 0), 0) / lineup.players.length;
    for (const b of OWN_BUCKETS) {
      if (avgOwn >= b.min && avgOwn < b.max) return b.label;
    }
    return '20%+';
  }

  // ============================================================
  // GLOBAL SELECTION WITH CROWDING DISCOUNT
  // ============================================================
  // Instead of tier-rotation, scan ALL candidates globally.
  // The crowding discount naturally creates a barbell:
  //   - Chalk combos get heavy discount → only the very best survive
  //   - Contrarian combos get full value → they dominate later picks
  //   - The greedy loop alternates between the two as marginal EV shifts

  function pickBestCandidate(): number {
    const scored: { idx: number; adjScore: number; maxQuadFreq: number; chalkDepth: number }[] = [];
    // Scan a large window — need to reach low-projection contrarian candidates
    // that have the best crowding-adjusted scores, but capped for speed
    const GLOBAL_SCAN = Math.min(sortedCandidates.length, 8000);

    for (let i = 0; i < GLOBAL_SCAN; i++) {
      const c = sortedCandidates[i];
      if (selectedHashes.has(c.lineup.hash)) continue;

      // Chalk depth quota enforcement (KEPT — structural guard)
      if (chalkTeams.size > 0) {
        const depth = candidateMaxChalkDepth[i];
        const team = candidateMaxChalkTeam[i];
        if (depth >= 4 && team) {
          const hedgeCount = chalkHedgeCounts.get(team) || 0;
          const hedgeMax = Math.ceil(targetCount * CHALK_DEEP_HEDGE_PCT);
          if (hedgeCount >= hedgeMax) continue;
        } else if (depth === 3 && team) {
          const partialCount = chalkPartialCounts.get(team) || 0;
          const partialMax = Math.ceil(targetCount * CHALK_PARTIAL_PCT);
          if (partialCount >= partialMax) continue;
        }
      }

      const diversity = calculateDiversityMultiplier(
        c.lineup, playerCounts, pairCounts, selected.length,
      );

      // Overlap penalty (KEPT)
      let overlapPenalty = 1.0;
      if (selectedPlayerSets.length >= 3) {
        const candIds = candidateIdSets[i];
        let maxOverlap = 0;
        const startIdx = Math.max(0, selectedPlayerSets.length - 50);
        for (let s = selectedPlayerSets.length - 1; s >= startIdx; s--) {
          let overlap = 0;
          for (const id of selectedPlayerSets[s]) {
            if (candIds.has(id)) overlap++;
          }
          if (overlap > maxOverlap) maxOverlap = overlap;
          if (maxOverlap >= overlapThreshold) break;
        }
        if (maxOverlap >= overlapThreshold) {
          overlapPenalty = maxOverlap >= overlapThreshold + 1 ? 0.02 : 0.10;
        } else if (maxOverlap >= overlapThreshold - 1) {
          overlapPenalty = 0.50;
        }
      }

      // Portfolio combo concentration penalty (KEPT — distinct from field crowding)
      // Prevents the same stack core from dominating our own portfolio
      let comboPenalty = 1.0;
      if (selected.length >= 20) {
        const pcKey = sortedPrimaryComboKeys[i];
        if (pcKey) {
          const portfolioComboFreq = (primaryComboCounts.get(pcKey) || 0) / selected.length;
          if (portfolioComboFreq > 0.04) {
            const cx = portfolioComboFreq - 0.04;
            comboPenalty = 1 / (1 + cx * cx * 500 + cx * cx * cx * cx * 10000);
          }
        }
      }

      // Correlation bonus (KEPT)
      let correlationBonus = 1.0;
      if (selected.length >= 20 && numGames > 2 && !isNonTeamSport) {
        const candGames = new Set(c.lineup.players.map(p => (p as any).gameInfo || (p as any).team || ''));
        const coverageRatio = candGames.size / Math.max(1, numGames);
        correlationBonus = 1 + 0.15 * coverageRatio;
      }

      // NEW: Crowding discount — the core MC-driven penalty
      const crowdingScore = candidateCrowdingScores[i];
      const crowdingDiscount = crowdingScore > 0
        ? 1 / (1 + crowdingAlpha * crowdingScore)
        : 1.0;

      const adjScore = c.formulaScore * diversity * overlapPenalty * comboPenalty * correlationBonus * crowdingDiscount;
      scored.push({ idx: i, adjScore, maxQuadFreq: candidateMaxQuadFreqs[i], chalkDepth: candidateMaxChalkDepth[i] });
    }

    if (scored.length === 0) return -1;

    // Find best adj score
    let bestAdjScore = -Infinity;
    for (const s of scored) {
      if (s.adjScore > bestAdjScore) bestAdjScore = s.adjScore;
    }

    // Combo uniqueness tiebreaker: within 15% of best, prefer rarest combos
    const tolerance = 0.15;
    const threshold = bestAdjScore * (1 - tolerance);

    let bestIdx = -1;
    let bestBlendedScore = -Infinity;

    for (const s of scored) {
      if (s.adjScore < threshold) continue;

      const comboRarityBonus = 1 + Math.max(0, 1 - s.maxQuadFreq / 0.05);
      const chalkDepthBonus = chalkTeams.size > 0
        ? 1 + Math.max(0, 0.05 * (3 - s.chalkDepth))
        : 1.0;
      const blended = s.adjScore * comboRarityBonus * chalkDepthBonus;

      if (blended > bestBlendedScore) {
        bestBlendedScore = blended;
        bestIdx = s.idx;
      }
    }

    return bestIdx;
  }

  // --- MAIN SELECTION LOOP ---
  // Phase 1: Free pass (top 10 by formula score)
  // Phase 2: Global selection with crowding discount (no tier rotation)
  for (let pick = 0; pick < targetCount; pick++) {
    let bestIdx = -1;

    if (selected.length < FREE_PASS_PICKS) {
      // Free pass: scan global top candidates (KEPT)
      for (let i = 0; i < sortedCandidates.length && bestIdx < 0; i++) {
        if (!selectedHashes.has(sortedCandidates[i].lineup.hash)) bestIdx = i;
      }
    } else {
      // Global pick: crowding discount naturally creates barbell
      bestIdx = pickBestCandidate();
    }

    if (bestIdx < 0) break;

    const picked = sortedCandidates[bestIdx];
    selectedHashes.add(picked.lineup.hash);
    selected.push(toScoredLineup(picked, selected.length));
    selectedPlayerSets.push(candidateIdSets[bestIdx]);
    updateCounts(picked.lineup, playerCounts, pairCounts, primaryComboCounts, sortedPrimaryComboKeys[bestIdx]);

    // Track chalk depth quotas (KEPT)
    if (chalkTeams.size > 0) {
      const depth = candidateMaxChalkDepth[bestIdx];
      const team = candidateMaxChalkTeam[bestIdx];
      if (depth >= 4 && team) {
        chalkHedgeCounts.set(team, (chalkHedgeCounts.get(team) || 0) + 1);
      } else if (depth === 3 && team) {
        chalkPartialCounts.set(team, (chalkPartialCounts.get(team) || 0) + 1);
      }
    }

    // Track barbell tier + ownership bucket (LOGGING ONLY — no enforcement)
    const pickedTier = getProjectionTier(picked.lineup.projection);
    tierCounts.set(pickedTier, (tierCounts.get(pickedTier) || 0) + 1);
    const pickedBucket = getOwnBucket(picked.lineup);
    ownBucketCounts.set(pickedBucket, (ownBucketCounts.get(pickedBucket) || 0) + 1);

    // Log progress every 100 picks with natural tier distribution
    if (selected.length % 100 === 0) {
      const tierSummary = Object.entries(BARBELL_QUOTAS)
        .map(([key, q]) => `${q.label.split(' ')[0]}:${tierCounts.get(key)||0}`)
        .join(' | ');
      console.log(`  [Crowding] Pick ${selected.length}: ${tierSummary}`);
    }
  }

  // --- Step 5.5: Post-selection combo differentiation check ---
  if (ensemble && selected.length > 20) {
    const FIELD_QUAD_THRESHOLD = 0.03;
    const FIELD_TRIPLE_THRESHOLD = 0.08;
    let totalReplacements = 0;
    const MAX_REPLACEMENTS = Math.ceil(selected.length * 0.15);

    for (let iter = 0; iter < 3 && totalReplacements < MAX_REPLACEMENTS; iter++) {
      let flagged = 0;
      for (let si = FREE_PASS_PICKS; si < selected.length && totalReplacements < MAX_REPLACEMENTS; si++) {
        const keys = precomputeComboKeys(selected[si]);

        // Check 4-man combos against field ensemble
        let maxQuadFreq = 0;
        for (const key of keys.quadKeys) {
          const freq = ensemble.combinedQuads.get(key) || 0;
          if (freq > maxQuadFreq) maxQuadFreq = freq;
        }

        // Check 3-man combos against field ensemble
        let maxTripleFreq = 0;
        for (const key of keys.tripleKeys) {
          const freq = ensemble.combinedTriples.get(key) || 0;
          if (freq > maxTripleFreq) maxTripleFreq = freq;
        }

        if (maxQuadFreq > FIELD_QUAD_THRESHOLD || maxTripleFreq > FIELD_TRIPLE_THRESHOLD) {
          flagged++;
          // Find replacement with lower field overlap and >= 80% formula score
          const minScore = selected[si].totalScore * 0.80;
          for (const c of sortedCandidates) {
            if (selectedHashes.has(c.lineup.hash)) continue;
            if (c.formulaScore < minScore) continue;

            const cKeys = precomputeComboKeys(c.lineup);
            let cMaxQuad = 0;
            for (const key of cKeys.quadKeys) {
              const freq = ensemble.combinedQuads.get(key) || 0;
              if (freq > cMaxQuad) cMaxQuad = freq;
            }
            if (cMaxQuad > FIELD_QUAD_THRESHOLD) continue;

            let cMaxTriple = 0;
            for (const key of cKeys.tripleKeys) {
              const freq = ensemble.combinedTriples.get(key) || 0;
              if (freq > cMaxTriple) cMaxTriple = freq;
            }
            if (cMaxTriple > FIELD_TRIPLE_THRESHOLD) continue;

            // Found valid replacement
            selectedHashes.delete(selected[si].hash);
            selectedHashes.add(c.lineup.hash);
            selected[si] = toScoredLineup(c, si + 1);
            totalReplacements++;
            break;
          }
        }
      }

      if (flagged === 0) break;
      console.log(`  Differentiation pass ${iter + 1}: ${flagged} flagged, ${totalReplacements} total replaced`);
    }
  }

  // --- Step 5.7: Per-tier combo uniqueness diagnostics ---
  if (ensemble && selected.length > 0) {
    const TIER_COMBO_TARGETS: { [key: string]: number } = {
      high: 0.06,   // No quad > 6% field
      mid: 0.04,    // No quad > 4% field
      low: 0.02,    // No quad > 2% field
      ultra: 0.01,  // No quad > 1% field
      floor: 0.01,  // No quad > 1% field
    };

    console.log(`\n  --- COMBO UNIQUENESS BY TIER ---`);
    for (const [key, quota] of Object.entries(BARBELL_QUOTAS)) {
      const tierLineups = selected.filter(l => {
        const pct = l.projection / optimalProjection;
        return pct >= quota.projRange[0] && pct < quota.projRange[1];
      });
      if (tierLineups.length === 0) continue;

      const targetMaxFreq = TIER_COMBO_TARGETS[key] || 0.04;
      let passingCount = 0;
      let totalMaxFreq = 0;

      for (const lu of tierLineups) {
        const keys = precomputeComboKeys(lu);
        let maxQuadFreq = 0;
        for (const k of keys.quadKeys) {
          const freq = ensemble.combinedQuads.get(k) || 0;
          if (freq > maxQuadFreq) maxQuadFreq = freq;
        }
        if (maxQuadFreq <= targetMaxFreq) passingCount++;
        totalMaxFreq += maxQuadFreq;
      }

      const n = tierLineups.length;
      const avgProj = tierLineups.reduce((s, l) => s + l.projection, 0) / n;
      const avgOwn = tierLineups.reduce((s, l) => s + l.players.reduce((ps, p) => ps + (p.ownership || 0), 0) / l.players.length, 0) / n;
      console.log(
        `  ${quota.label.padEnd(22)} ${String(n).padStart(3)} lu | ` +
        `pass (<${(targetMaxFreq*100).toFixed(0)}%): ${String(passingCount).padStart(3)}/${n} (${(passingCount/n*100).toFixed(0)}%) | ` +
        `avg max quad: ${(totalMaxFreq/n*100).toFixed(2)}% | ` +
        `avg proj: ${avgProj.toFixed(1)} | avg own: ${avgOwn.toFixed(1)}%`
      );
    }
  }

  // --- Step 5.75: Barbell shape + ownership spread diagnostics ---
  console.log(`\n  --- BARBELL PORTFOLIO SHAPE ---`);
  for (const [key, quota] of Object.entries(BARBELL_QUOTAS)) {
    const actual = tierCounts.get(key) || 0;
    const target = Math.ceil(targetCount * quota.targetPct);
    const pct = selected.length > 0 ? (actual / selected.length * 100).toFixed(0) : '0';
    const status = actual >= target * 0.9 ? 'OK' : actual >= target * 0.5 ? 'PARTIAL' : 'SHORT';
    console.log(`  ${quota.label.padEnd(22)} ${String(actual).padStart(4)}/${String(target).padStart(4)} (${pct}% of portfolio) [${status}]`);
  }

  console.log(`\n  --- OWNERSHIP SPREAD ---`);
  for (const b of OWN_BUCKETS) {
    const ct = ownBucketCounts.get(b.label) || 0;
    const pct = selected.length > 0 ? (ct / selected.length * 100).toFixed(0) : '0';
    console.log(`  ${b.label.padEnd(10)} avg own: ${String(ct).padStart(4)} lineups (${pct}%)`);
  }

  // --- Step 6: Compute exposures ---
  const finalPlayerCounts = new Map<string, number>();
  for (const lineup of selected) {
    for (const player of lineup.players) {
      finalPlayerCounts.set(player.id, (finalPlayerCounts.get(player.id) || 0) + 1);
    }
  }

  const exposures = new Map<string, number>();
  for (const [playerId, count] of finalPlayerCounts) {
    exposures.set(playerId, (count / selected.length) * 100);
  }

  const avgProjection = selected.length > 0
    ? selected.reduce((s, l) => s + l.projection, 0) / selected.length
    : 0;
  const avgOwnership = selected.length > 0
    ? selected.reduce((s, l) => s + calculateOwnershipSum(l), 0) / selected.length
    : 0;

  // Log results
  console.log(`  Selected: ${selected.length} lineups`);
  console.log(`  Avg projection: ${avgProjection.toFixed(1)}`);
  // Compute avg geoMean ownership across portfolio
  const avgGeoMeanOwn = selected.length > 0
    ? selected.reduce((s, l) => s + computeGeoMeanOwnership(l), 0) / selected.length : 0;
  console.log(`  Avg geoMean ownership: ${avgGeoMeanOwn.toFixed(1)}%`);

  // Stack composition logging
  const isNonTeamSport2 = params.sport && ['mma', 'nascar', 'golf'].includes(params.sport);
  if (!isNonTeamSport2 && numGames > 1) {
    if (params.sport === 'mlb') {
      // MLB: report same-team batter stack sizes (not game-level)
      const stack4 = selected.filter(l => {
        const tb = new Map<string, number>();
        for (const p of l.players) { if (!p.positions.includes('P')) tb.set(p.team, (tb.get(p.team) || 0) + 1); }
        return Math.max(...tb.values(), 0) >= 4;
      }).length;
      const stack5 = selected.filter(l => {
        const tb = new Map<string, number>();
        for (const p of l.players) { if (!p.positions.includes('P')) tb.set(p.team, (tb.get(p.team) || 0) + 1); }
        return Math.max(...tb.values(), 0) >= 5;
      }).length;
      const bbCount = selected.filter(l => hasStackWithBringBack(l, 4)).length;
      console.log(`  MLB stacks: ${stack4}/${selected.length} have 4+ batters, ${stack5} have 5+ batters, ${bbCount} have bring-back`);
    } else {
      const stackCount = selected.filter(l => hasStackWithBringBack(l, 3)).length;
      console.log(`  Stack composition: ${stackCount}/${selected.length} (${(stackCount/selected.length*100).toFixed(0)}%) have 3+BB`);
    }
  }

  // Show top exposures
  const sortedExposures = Array.from(exposures.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  console.log(`  Top exposures:`);
  for (const [playerId, exp] of sortedExposures) {
    const player = selected[0]?.players.find(p => p.id === playerId) ||
      selected.find(l => l.players.some(p => p.id === playerId))?.players.find(p => p.id === playerId);
    const name = player?.name || playerId;
    console.log(`    ${name.padEnd(25)} ${exp.toFixed(1)}%`);
  }

  // --- Step 7: Combo leverage metrics ---
  if (ensemble && selected.length > 0) {
    let uniqueCount = 0;
    let maxFieldComboFreq = 0;
    let maxPortfolioComboFreq = 0;

    for (const l of selected) {
      const pc = extractPrimaryCombo(l, playerMap, params.sport);
      const fieldFreq = ensemble.combinedPrimaryCombos.get(pc.comboKey) || 0;
      const portfolioFreq = (primaryComboCounts.get(pc.comboKey) || 0) / selected.length;

      if (fieldFreq < 0.03) uniqueCount++;
      if (fieldFreq > maxFieldComboFreq) maxFieldComboFreq = fieldFreq;
      if (portfolioFreq > maxPortfolioComboFreq) maxPortfolioComboFreq = portfolioFreq;
    }

    console.log(`\n  --- COMBO LEVERAGE METRICS ---`);
    console.log(`  Combo-unique lineups (primary <3% field): ${uniqueCount}/${selected.length} (${(uniqueCount / selected.length * 100).toFixed(0)}%)`);
    console.log(`  Worst field combo overlap: ${(maxFieldComboFreq * 100).toFixed(1)}%`);
    console.log(`  Worst portfolio combo concentration: ${(maxPortfolioComboFreq * 100).toFixed(1)}%`);
    console.log(`  Chalk primary combos in ensemble: ${ensemble.chalkPrimaryCombos.length}`);
  }

  // --- Step 7.5: Chalk depth report ---
  if (chalkTeams.size > 0 && selected.length > 0) {
    console.log(`\n  [ChalkDepth] === CHALK DEPTH REPORT ===`);
    console.log(`  [ChalkDepth] Total lineups: ${selected.length}`);

    for (const team of chalkTeams) {
      const depthDist = [0, 0, 0, 0, 0, 0, 0]; // index = num players from this team

      for (const lu of selected) {
        let ct = 0;
        for (const p of lu.players) {
          if (p.team === team) {
            // For MLB, only count batters
            if (params.sport === 'mlb' && p.positions.some((pos: string) => pos === 'P' || pos === 'SP' || pos === 'RP')) continue;
            ct++;
          }
        }
        depthDist[Math.min(ct, 6)]++;
      }

      const avgOwn = teamBatterOwnership.get(team)?.toFixed(1) || '?';
      console.log(`  [ChalkDepth] ${team} (avg batter own: ${avgOwn}%):`);
      console.log(`  [ChalkDepth]   0 players: ${depthDist[0]} (${(depthDist[0]/selected.length*100).toFixed(0)}%)`);
      console.log(`  [ChalkDepth]   1 player:  ${depthDist[1]} (${(depthDist[1]/selected.length*100).toFixed(0)}%)`);
      console.log(`  [ChalkDepth]   2 players: ${depthDist[2]} (${(depthDist[2]/selected.length*100).toFixed(0)}%)`);
      console.log(`  [ChalkDepth]   3 players: ${depthDist[3]} (${(depthDist[3]/selected.length*100).toFixed(0)}%) — capped at ${(CHALK_PARTIAL_PCT*100).toFixed(0)}%`);
      console.log(`  [ChalkDepth]   4+ players: ${depthDist.slice(4).reduce((s,v)=>s+v,0)} (${(depthDist.slice(4).reduce((s,v)=>s+v,0)/selected.length*100).toFixed(0)}%) — capped at ${(CHALK_DEEP_HEDGE_PCT*100).toFixed(0)}%`);
    }

    // Overall chalk exposure summary
    const shallowOrNone = selected.filter(lu => {
      for (const team of chalkTeams) {
        let ct = 0;
        for (const p of lu.players) {
          if (p.team === team) {
            if (params.sport === 'mlb' && p.positions.some((pos: string) => pos === 'P' || pos === 'SP' || pos === 'RP')) continue;
            ct++;
          }
        }
        if (ct >= 3) return false;
      }
      return true;
    }).length;
    console.log(`\n  [ChalkDepth] Lineups with shallow chalk (0-2 per chalk team): ${shallowOrNone} (${(shallowOrNone/selected.length*100).toFixed(0)}%)`);
    console.log(`  [ChalkDepth] === END REPORT ===`);
  }

  return { selected, exposures, avgProjection, avgOwnership };
}

// ============================================================
// HELPERS
// ============================================================

function computeGeoMeanOwnership(lineup: Lineup): number {
  let product = 1;
  for (const p of lineup.players) {
    product *= Math.max(0.1, p.ownership) / 100;
  }
  return Math.pow(product, 1 / lineup.players.length) * 100;
}

function toScoredLineup(c: ScoredCandidate, rank: number): ScoredLineup {
  return {
    ...c.lineup,
    totalScore: c.formulaScore,
    projectionScore: c.projectionScore,
    ownershipScore: 0,
    leverageScore: 0,
    diversityScore: 1,
    rank,
    overallRank: rank,
    ceilingScore: c.ceilingScore,
    varianceScore: c.varianceScore,
  };
}

function updateCounts(
  lineup: Lineup,
  playerCounts: Map<string, number>,
  pairCounts: Map<string, number>,
  primaryComboCounts?: Map<string, number>,
  primaryComboKey?: string,
): void {
  const players = lineup.players;

  for (const p of players) {
    playerCounts.set(p.id, (playerCounts.get(p.id) || 0) + 1);
  }
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const key = players[i].id < players[j].id
        ? `${players[i].id}|${players[j].id}`
        : `${players[j].id}|${players[i].id}`;
      pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
    }
  }

  // Track primary combo concentration in our portfolio
  if (primaryComboCounts && primaryComboKey) {
    primaryComboCounts.set(primaryComboKey, (primaryComboCounts.get(primaryComboKey) || 0) + 1);
  }
}
