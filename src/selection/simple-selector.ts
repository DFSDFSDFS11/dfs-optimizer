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

function computeGameStackScore(lineup: Lineup, numGames: number): number {
  // Pro data (63K entries, 17 slates) — top-1% hit rates by construction:
  //   3-2-2-1: 1.55% (best common),  6-1-1: 2.30% (best overall, rare)
  //   5-1-1-1: 1.53%,  4-3-1: 1.44%,  4-2-1-1: 1.36%,  5-2-1: 1.36%
  //   3-2-1-1-1: 1.25%,  3-3-2: 1.07%,  2-2-2-1-1: 0.91% (worst)
  //
  // Key insight: 3-man primary + multiple secondary stacks (3-2-2) is the sweet spot.
  // Multi-stack > single big stack. Bring-back helps but isn't required.

  let gameTotalSum = 0;
  let gameTotalCount = 0;
  for (const p of lineup.players) {
    if (p.gameTotal && p.gameTotal > 0) {
      gameTotalSum += p.gameTotal;
      gameTotalCount++;
    }
  }
  const slateAvgGameTotal = gameTotalCount > 0 ? gameTotalSum / gameTotalCount : 225;

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
  const stackSizes: number[] = []; // track all stack group sizes

  for (const [, group] of gameGroups) {
    const gameTotalScaler = group.gameTotal / slateAvgGameTotal;
    if (group.count > maxStackSize) maxStackSize = group.count;
    const hasBB = group.teams.size >= 2;

    if (group.count >= 6) {
      // 6+ stack: 2.30% hit rate (1.71x lift) — best single-stack pattern
      stackBonus += 0.20 * gameTotalScaler;
      if (hasBB) stackBonus += 0.08 * gameTotalScaler;
    } else if (group.count >= 5) {
      // 5-stack: 1.36-1.53% hit rate
      stackBonus += 0.14 * gameTotalScaler;
      if (hasBB) stackBonus += 0.06 * gameTotalScaler;
    } else if (group.count >= 4) {
      // 4-stack: 1.36-1.44% — equal to 3-stack, not better
      stackBonus += 0.10 * gameTotalScaler;
      if (hasBB) stackBonus += 0.05 * gameTotalScaler;
    } else if (group.count >= 3) {
      // 3-stack: 1.25-1.55% — best when combined with secondary stacks
      stackBonus += 0.10 * gameTotalScaler;
      if (hasBB) stackBonus += 0.04 * gameTotalScaler;
    } else if (group.count === 2) {
      // 2-man mini-stack: small correlation bonus
      stackBonus += 0.03 * gameTotalScaler;
      if (hasBB) stackBonus += 0.02 * gameTotalScaler;
    }

    if (group.count >= 2) stackSizes.push(group.count);
  }

  // === MULTI-STACK BONUS (THE key differentiator in pro data) ===
  // 3-2-2-1 pattern: 1.55% hit rate (best common pattern)
  // Multi-stack lineups outperform single-stack by ~50%
  stackSizes.sort((a, b) => b - a); // descending
  const numStackGroups = stackSizes.length;

  if (numStackGroups >= 3) {
    // Triple stack (e.g., 3-2-2, 2-2-2): strongest signal
    stackBonus += 0.12;
  } else if (numStackGroups >= 2) {
    // Double stack (e.g., 4-2, 3-3, 5-2): solid construction
    stackBonus += 0.07;
  }

  // Penalty for spread-out lineups (no 3+ stack, just 2-man pairs or singles)
  if (maxStackSize <= 2 && numGames > 2) {
    stackBonus -= 0.06; // 2-2-2-1-1: 0.91% hit rate (worst pattern)
  }

  // Penalty for isolated big stack with no secondary (e.g., 4-1-1-1-1)
  if (numStackGroups <= 1 && maxStackSize >= 3 && numGames >= 4) {
    stackBonus -= 0.04;
  }

  const slateScaler = numGames <= 3 ? 0.80 : numGames <= 4 ? 0.90 : numGames <= 6 ? 1.00 : 1.10;
  return Math.max(-0.05, Math.min(0.70, stackBonus * slateScaler));
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

  // Pro data (63K entries, 854 top-1%): construction patterns matter.
  // 3-2-2-1: 1.55% (best common), 6-1-1: 2.30% (best rare), 2-2-2-1-1: 0.91% (worst)
  // Key: 3-man stack is as good as 4-man. Multi-stack >> single big stack.

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

  // Single-game or 2-game slates: construction doesn't differentiate as much
  if (numGames <= 2) return 1.0;

  let multiplier = 1.0;

  // === PRIMARY STACK ===
  // 3-stack and 4-stack have equal hit rates (~1.35-1.55%).
  // 5+ stack has slightly higher hit rate when combined with secondary.
  if (maxStackSize >= 5) {
    multiplier *= 1.15;  // 5+ stack: strong correlation upside
  } else if (maxStackSize >= 3) {
    multiplier *= 1.10;  // 3 or 4 stack: equally good in pro data
  } else if (maxStackSize === 2) {
    multiplier *= 0.85;  // 2-man only stacks: 0.91% hit rate (underperforms)
  } else {
    multiplier *= 0.60;  // No stacking at all
  }

  // === BRING-BACK BONUS (not required, but helpful) ===
  // 90.6% of top-1% have BB vs 86.6% of all pros — small edge
  if (hasBringBack) {
    multiplier *= 1.05;  // Modest bonus — BB helps but isn't mandatory
  }

  // === MULTI-STACK (THE biggest differentiator) ===
  // 3-2-2-1: 1.55% vs 3-2-1-1-1: 1.25% — multi-stack is ~25% better
  if (stackGroupCount >= 3) {
    multiplier *= 1.20;  // Triple stack: elite (3+2+2, 2+2+2)
  } else if (stackGroupCount >= 2) {
    multiplier *= 1.10;  // Double stack: good (4+2, 3+3, 5+2)
  } else if (numGames >= 4) {
    // No secondary stack on 4+ game slate
    multiplier *= 0.75;
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
): number {
  // 5-component additive score (proven formula that achieved 1.42% top-1%)
  // NO ownership in the additive score — backtests show ownership is a negative predictor (-0.24)
  const additiveScore = (
    projectionScore * (weights.projectionScore || 0.20) +
    ceilingScore * (weights.ceilingScore || 0.20) +
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
 * Relaxed threshold 20%: individual player exposure is less important than
 * COMBO diversity. Pros overlap with field on individuals — they differentiate
 * at the combo level. This just prevents extreme concentration (>50%).
 *
 * Behavior:
 *   20% exposure → 1.00 (no penalty)
 *   30% exposure → 0.83
 *   40% exposure → 0.50
 *   50% exposure → 0.24
 *   60% exposure → 0.10
 */
function playerExposureFactor(exposure: number): number {
  // Original thresholds from 1.42% baseline: 15%→1.0, 30%→0.74, 40%→0.40, 50%→0.17
  if (exposure <= 0.15) return 1.0;
  const x = exposure - 0.15;
  const penalty = x * x * 15 + x * x * x * x * 200;
  return 1 / (1 + penalty);
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

  // Player exposure (geometric mean)
  let playerProduct = 1.0;
  for (const p of players) {
    const exposure = (playerCounts.get(p.id) || 0) / selectedCount;
    playerProduct *= playerExposureFactor(exposure);
  }
  const playerDiversity = Math.pow(playerProduct, 1 / n);

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

  // Original 1.42% baseline formula: multiplicative blend of player + pair diversity.
  // The triple/quad/quint components caused over-diversification that hurt performance
  // by forcing low-quality lineups into the portfolio. The max-overlap penalty (below)
  // already handles near-duplicates, so deep combo diversity is redundant.
  //
  // Geometric blend: playerDiversity^0.60 × pairDiversity^0.40
  // This ensures BOTH player AND pair diversity must be decent — one can't compensate.
  const rosterSize = lineup.players.length;
  if (rosterSize <= 6) {
    // Small roster: pair diversity matters more (fewer unique pair combos)
    return Math.pow(playerDiversity, 0.40) * Math.pow(pairDiversity, 0.60);
  }
  return Math.pow(playerDiversity, 0.60) * Math.pow(pairDiversity, 0.40);
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
  const { lineups, targetCount, numGames, salaryCap } = params;
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

  // --- Step 2: Hard projection floor — no lineup below this ever reaches output ---
  const projFloorPct = isNonTeamSport ? 0.85 : (numGames <= 3 ? 0.92 : 0.94);
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

    const gameStackScore = computeGameStackScore(l, numGames);

    // Construction quality: multiplier for proper stacking patterns
    const constructionMult = computeConstructionMultiplier(l, numGames, params.sport);

    const formulaScore = computeFormulaScore(
      projectionScore, ceilingScore, varianceScore,
      salaryEfficiencyScore, relValue.relativeValueScore,
      gameStackScore, weights,
      l.salary, cap,
      constructionMult,
      candidatePrimaryComboFreqs[i],
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

  // --- Step 4: Pre-compute candidate ID sets for speed ---
  const candidateIdSets: Set<string>[] = new Array(sortedCandidates.length);
  for (let i = 0; i < sortedCandidates.length; i++) {
    candidateIdSets[i] = new Set(sortedCandidates[i].lineup.players.map(p => p.id));
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

  // --- Step 5: Greedy selection with diversity ---
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


  for (let round = 0; round < sortedCandidates.length && selected.length < targetCount; round++) {
    // For first FREE_PASS_PICKS, just take the top formula scores (no diversity needed yet)
    if (selected.length < FREE_PASS_PICKS) {
      const c = sortedCandidates[round];
      if (selectedHashes.has(c.lineup.hash)) continue;

      selectedHashes.add(c.lineup.hash);
      selected.push(toScoredLineup(c, selected.length + 1));
      selectedPlayerSets.push(candidateIdSets[round]);
      updateCounts(c.lineup, playerCounts, pairCounts, primaryComboCounts, candidatePrimaryComboKeys[round]);
      continue;
    }

    // Scan top candidates, pick best adjusted score
    let bestIdx = -1;
    let bestAdjScore = -Infinity;

    const scanEnd = Math.min(sortedCandidates.length, round + SCAN_WINDOW);
    for (let i = round; i < scanEnd; i++) {
      const c = sortedCandidates[i];
      if (selectedHashes.has(c.lineup.hash)) continue;

      const diversity = calculateDiversityMultiplier(
        c.lineup, playerCounts, pairCounts,
        selected.length,
      );

      // Max-overlap penalty: check last 50 selected lineups for player overlap.
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

      // Portfolio combo concentration penalty: prevent our own portfolio from
      // being combo-concentrated around the same primary combos
      let comboPenalty = 1.0;
      if (selected.length >= 20 && ensemble) {
        const pcKey = candidatePrimaryComboKeys[i];
        if (pcKey) {
          const portfolioComboFreq = (primaryComboCounts.get(pcKey) || 0) / selected.length;
          if (portfolioComboFreq > 0.05) {
            const cx = portfolioComboFreq - 0.05;
            comboPenalty = 1 / (1 + cx * cx * 400 + cx * cx * cx * cx * 8000);
          }
        }
      }

      // Correlation cluster bonus: lineups touching more games = more leverage
      let correlationBonus = 1.0;
      if (selected.length >= 20 && numGames > 2 && !isNonTeamSport) {
        const candGames = new Set(c.lineup.players.map(p => (p as any).gameInfo || (p as any).team || ''));
        const coverageRatio = candGames.size / Math.max(1, numGames);
        correlationBonus = 1 + 0.15 * coverageRatio;
      }

      const adjScore = c.formulaScore * diversity * overlapPenalty * comboPenalty * correlationBonus;

      if (adjScore > bestAdjScore) {
        bestAdjScore = adjScore;
        bestIdx = i;
      }
    }

    if (bestIdx < 0) break;

    const picked = sortedCandidates[bestIdx];
    selectedHashes.add(picked.lineup.hash);
    selected.push(toScoredLineup(picked, selected.length + 1));
    selectedPlayerSets.push(candidateIdSets[bestIdx]);
    updateCounts(picked.lineup, playerCounts, pairCounts, primaryComboCounts, candidatePrimaryComboKeys[bestIdx]);

    // Swap picked, its combo keys, and its ID set to current position
    [sortedCandidates[round], sortedCandidates[bestIdx]] = [sortedCandidates[bestIdx], sortedCandidates[round]];
    [comboKeysCache[round], comboKeysCache[bestIdx]] = [comboKeysCache[bestIdx], comboKeysCache[round]];
    [candidateIdSets[round], candidateIdSets[bestIdx]] = [candidateIdSets[bestIdx], candidateIdSets[round]];
    // Also swap primary combo keys to keep aligned
    if (candidatePrimaryComboKeys.length > 0) {
      [candidatePrimaryComboKeys[round], candidatePrimaryComboKeys[bestIdx]] = [candidatePrimaryComboKeys[bestIdx], candidatePrimaryComboKeys[round]];
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
    const stackCount = selected.filter(l => hasStackWithBringBack(l, 3)).length;
    console.log(`  Stack composition: ${stackCount}/${selected.length} (${(stackCount/selected.length*100).toFixed(0)}%) have 3+BB`);
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
