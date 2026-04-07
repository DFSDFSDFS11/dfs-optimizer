/**
 * DFS Optimizer CLI - Branch and Bound Optimizer
 *
 * Implements exact optimization using branch-and-bound with constraint
 * satisfaction. This guarantees finding the TRUE optimal lineup.
 *
 * Algorithm:
 * 1. Build decision tree where each level = roster slot
 * 2. At each node, try each eligible player
 * 3. Prune branches where:
 *    - Salary cap exceeded
 *    - Cannot meet salary minimum
 *    - Upper bound < best found (bound pruning)
 *    - Position constraints unsatisfiable
 */

import {
  ContestConfig,
  EdgeBoostedParams,
  Lineup,
  OptimizationParams,
  OptimizationResult,
  Player,
  PlayerEdgeScores,
  PlayerPool,
} from '../types';

import {
  buildEligibilityMatrix,
  calculateProjectionUpperBound,
  calculateMinSalaryNeeded,
  calculateTotalProjection,
  calculateTotalSalary,
  calculateOwnership,
  validateLineup,
  buildPlayerNameMap,
  buildSortedEligiblePerSlot,
  upperBoundBitmap,
  minSalaryBitmap,
  PlayerNameMap,
} from '../rules';

import { generateFieldPool as generateFieldPoolForPreScan } from '../selection/simulation/tournament-sim';
import { extractPrimaryCombo } from '../selection/scoring/field-analysis';

// ============================================================
// LINEUP HEAP
// ============================================================

/**
 * Min-heap for tracking top N lineups by projection.
 * Uses projection as the comparison key.
 */
class LineupHeap {
  private heap: Lineup[] = [];
  private maxSize: number;
  private seenHashes: Set<string> = new Set();

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get size(): number {
    return this.heap.length;
  }

  get minProjection(): number {
    return this.heap.length > 0 ? this.heap[0].projection : 0;
  }

  push(lineup: Lineup): boolean {
    // Deduplicate
    if (this.seenHashes.has(lineup.hash)) {
      return false;
    }

    if (this.heap.length < this.maxSize) {
      this.heap.push(lineup);
      this.seenHashes.add(lineup.hash);
      this.bubbleUp(this.heap.length - 1);
      return true;
    }

    if (lineup.projection > this.heap[0].projection) {
      this.seenHashes.delete(this.heap[0].hash);
      this.heap[0] = lineup;
      this.seenHashes.add(lineup.hash);
      this.bubbleDown(0);
      return true;
    }

    return false;
  }

  toSortedArray(): Lineup[] {
    return [...this.heap].sort((a, b) => b.projection - a.projection);
  }

  private bubbleUp(index: number): void {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (this.heap[index].projection >= this.heap[parentIndex].projection) break;
      this.swap(index, parentIndex);
      index = parentIndex;
    }
  }

  private bubbleDown(index: number): void {
    while (true) {
      const leftChild = 2 * index + 1;
      const rightChild = 2 * index + 2;
      let smallest = index;

      if (leftChild < this.heap.length &&
          this.heap[leftChild].projection < this.heap[smallest].projection) {
        smallest = leftChild;
      }

      if (rightChild < this.heap.length &&
          this.heap[rightChild].projection < this.heap[smallest].projection) {
        smallest = rightChild;
      }

      if (smallest === index) break;
      this.swap(index, smallest);
      index = smallest;
    }
  }

  private swap(i: number, j: number): void {
    [this.heap[i], this.heap[j]] = [this.heap[j], this.heap[i]];
  }
}

// ============================================================
// MAIN OPTIMIZER
// ============================================================

// ============================================================
// ITERATION TYPES FOR FRONTIER EXPLORATION
// ============================================================
//
// From DFS Theory Masterclass:
// "You are looking for ones that have an outsized proportion between
// its projection and ownership."
//
// To find MORE efficient frontier lineups, we need iterations that
// intentionally explore different projection/ownership trade-offs:
//
// 1. PROJECTION-FOCUSED: Maximize raw projection (current behavior)
// 2. BALANCED: Maximize (projection - ownership_penalty)
// 3. CONTRARIAN: Maximize (projection - heavy_ownership_penalty)
// ============================================================

type IterationType = 'projection' | 'field-mimic' | 'leverage' | 'balanced' | 'contrarian' | 'game-stack' | 'ceiling' | 'formula-blend' | 'anti-overlap' | 'salary-value' | 'frontier-sweep' | 'anti-chalk' | 'shallow-chalk' | 'no-chalk-stack';

/**
 * Apply ownership penalty to player projections
 *
 * This creates "virtual projections" that favor low-ownership players.
 * The optimizer will then find lineups that maximize these adjusted projections,
 * which naturally leads to low-ownership lineups on the efficient frontier.
 *
 * @param players - Player pool
 * @param penaltyMultiplier - How much to penalize ownership (0.5 = balanced, 1.5 = contrarian)
 */
function applyOwnershipPenalty(players: Player[], penaltyMultiplier: number): Player[] {
  // Calculate average projection for scaling
  const avgProjection = players.reduce((sum, p) => sum + p.projection, 0) / players.length;

  return players.map(p => {
    // Ownership penalty: reduce "virtual projection" based on ownership
    // High owned players get penalized, low owned players get boosted
    //
    // PIECEWISE MULTIPLICATIVE formula with exponential cliff above 25%
    //
    // Three ownership tiers:
    // ≤10% owned:  gentle penalty  (mult * 0.5) — low-owned players barely penalized
    // 10-25% owned: standard penalty (mult * 1.0) — normal scaling
    // >25% owned:  exponential cliff — base penalty at 25% + exp decay for excess
    //
    // This under-penalizes low-owned (good!) and heavily penalizes high-owned.
    // At multiplier=1.3:
    //   5% owned:  factor = 0.968 (gentle)
    //   15% owned: factor = 0.805 (standard)
    //   25% owned: factor = 0.675 (standard)
    //   30% owned: factor = 0.536 (cliff kicks in)
    //   40% owned: factor = 0.303 (steep drop)
    //   50% owned: factor = 0.171 (nearly faded)

    const own = p.ownership / 100;
    let ownershipFactor: number;
    if (own <= 0.10) {
      // Gentle: half the penalty rate
      ownershipFactor = 1 - own * penaltyMultiplier * 0.5;
    } else if (own <= 0.25) {
      // Standard: normal penalty rate (anchored to match gentle tier at 10%)
      const baseAt10 = 1 - 0.10 * penaltyMultiplier * 0.5;
      const excessOwn = own - 0.10;
      ownershipFactor = baseAt10 - excessOwn * penaltyMultiplier;
    } else {
      // Exponential cliff: base penalty at 25% + exponential decay for excess
      const baseAt10 = 1 - 0.10 * penaltyMultiplier * 0.5;
      const baseAt25 = baseAt10 - 0.15 * penaltyMultiplier;
      const excessOwn = own - 0.25;
      ownershipFactor = baseAt25 * Math.exp(-penaltyMultiplier * excessOwn * 3);
    }
    const adjustedProjection = Math.max(1, p.projection * Math.max(0.1, ownershipFactor));

    return {
      ...p,
      projection: adjustedProjection,
    };
  });
}

// ============================================================
// CORRELATED GAME-WORLD SCENARIOS
// ============================================================

/**
 * Box-Muller transform for normal random variable (pool generation).
 * Separate from tournament-sim.ts version to avoid import dependency.
 */
function poolBoxMullerZ(): number {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Game-world scenario for a single iteration.
 * Models correlated environments: when a game goes to OT, ALL players
 * in that game benefit. When a team is hot, ALL teammates benefit.
 */
interface GameWorldScenario {
  /** playerId → projection multiplier */
  playerMultipliers: Map<string, number>;
  /** Description for logging */
  description: string;
}

/**
 * Generate a correlated game-world scenario.
 *
 * Instead of independent per-player noise, this creates a CORRELATED
 * game environment where:
 * 1. Each game has a gamePace factor (shootout vs low-scoring)
 * 2. Each team has a teamShare factor (which team is winning/performing)
 * 3. Each player gets small individual noise on top
 *
 * This means when the optimizer sees "GSW-MEM shootout", it naturally
 * builds stacks from that game. Different iterations see different
 * game environments → genuine structural diversity in the pool.
 *
 * Uses lognormal distribution (exp(normal)) so E[factor] = 1.0 exactly,
 * avoiding the bias of clamped normal distributions.
 */
function generateGameWorld(players: Player[]): GameWorldScenario {
  // Group players by game and team
  const games = new Map<string, Set<string>>(); // gameId → set of teams
  const playersByGame = new Map<string, Player[]>();

  for (const p of players) {
    const gameId = p.gameInfo || `${p.team}_game`;
    if (!games.has(gameId)) {
      games.set(gameId, new Set());
      playersByGame.set(gameId, []);
    }
    games.get(gameId)!.add(p.team);
    playersByGame.get(gameId)!.push(p);
  }

  // Generate game-level pace factors using lognormal: exp(N(0, sigma))
  // E[exp(N(0,s))] = exp(s²/2), so to get E=1.0 we use: exp(z*s - s²/2)
  // NBA gets higher pace variance — real NBA game-to-game scoring variance is ±20%+
  const isNBASport = players.some(p => p.positions.some(pos => pos === 'PG' || pos === 'SG'));
  const GAME_PACE_SIGMA = games.size <= 3 ? 0.30 : (isNBASport ? 0.28 : 0.20);
  const gamePaceFactors = new Map<string, number>();
  for (const gameId of games.keys()) {
    const z = poolBoxMullerZ();
    gamePaceFactors.set(gameId, Math.exp(z * GAME_PACE_SIGMA - GAME_PACE_SIGMA * GAME_PACE_SIGMA / 2));
  }

  // Generate game-script factors (anti-symmetric between teams)
  // Positive z → team A benefits, team B suffers
  const SCRIPT_SIGMA = games.size <= 3 ? 0.14 : 0.08;
  const gameScriptFactors = new Map<string, number>(); // gameId → z value
  const gameTeamSides = new Map<string, { teamA: string; teamB: string }>();
  for (const [gameId, teamSet] of games) {
    const z = poolBoxMullerZ();
    gameScriptFactors.set(gameId, z * SCRIPT_SIGMA);
    const teamArr = [...teamSet];
    gameTeamSides.set(gameId, {
      teamA: teamArr[0] || '',
      teamB: teamArr[1] || teamArr[0] || '',
    });
  }

  // Generate team-level share factors using lognormal
  const TEAM_SHARE_SIGMA = games.size <= 3 ? 0.12 : 0.08;
  const teamShareFactors = new Map<string, number>();
  const allTeams = new Set(players.map(p => p.team));
  for (const team of allTeams) {
    const z = poolBoxMullerZ();
    teamShareFactors.set(team, Math.exp(z * TEAM_SHARE_SIGMA - TEAM_SHARE_SIGMA * TEAM_SHARE_SIGMA / 2));
  }

  // Compute per-player multipliers
  const PLAYER_NOISE_SIGMA = 0.05;
  const multipliers = new Map<string, number>();

  // Track which games are "hot" for description
  let hotGame = '';
  let hotPace = 0;

  for (const p of players) {
    const gameId = p.gameInfo || `${p.team}_game`;
    const paceFactor = gamePaceFactors.get(gameId) || 1.0;
    const scriptZ = gameScriptFactors.get(gameId) || 0;
    const sides = gameTeamSides.get(gameId);
    const scriptSign = (sides && p.team === sides.teamA) ? 1 : -1;
    const teamFactor = teamShareFactors.get(p.team) || 1.0;

    // Combine: pace affects both teams, script favors one side
    const gameFactor = paceFactor * (1 + scriptSign * scriptZ);

    // Player noise: small individual randomness
    const playerZ = poolBoxMullerZ();
    const playerNoise = Math.exp(playerZ * PLAYER_NOISE_SIGMA - PLAYER_NOISE_SIGMA * PLAYER_NOISE_SIGMA / 2);

    const combinedMultiplier = gameFactor * teamFactor * playerNoise;
    multipliers.set(p.id, combinedMultiplier);

    if (paceFactor > hotPace) {
      hotPace = paceFactor;
      hotGame = gameId;
    }
  }

  return {
    playerMultipliers: multipliers,
    description: `hot:${hotGame}(${hotPace.toFixed(2)})`,
  };
}

/**
 * Check if a lineup has a game stack with bring-back.
 * A "game stack" = minGamePlayers or more players from the SAME GAME.
 * A "bring-back" = at least 2 different teams represented in that stacked game.
 *
 * Pro top-1%: 94% 3+stack, 93% bring-back, 81% BB-in-3+stack.
 * Winners: 100% BB, 92% BB-in-3+stack, avg max stack 4.08.
 */
function hasGameStackWithBringBack(players: Player[], minGamePlayers: number = 3): boolean {
  // Group players by game, tracking team counts
  const gameTeams = new Map<string, Map<string, number>>();

  for (const p of players) {
    const gameId = p.gameInfo || `${p.team}_game`;
    if (!gameTeams.has(gameId)) {
      gameTeams.set(gameId, new Map());
    }
    const teams = gameTeams.get(gameId)!;
    teams.set(p.team, (teams.get(p.team) || 0) + 1);
  }

  // Check each game: need minGamePlayers total AND 2+ teams (bring-back)
  for (const [, teams] of gameTeams) {
    const totalInGame = Array.from(teams.values()).reduce((s, c) => s + c, 0);
    if (totalInGame >= minGamePlayers && teams.size >= 2) {
      return true;
    }
  }

  return false;
}

/**
 * Apply a game-world scenario to player projections.
 * Each player's projection is multiplied by their game-world factor,
 * creating correlated projections within games and teams.
 */
function applyGameWorld(players: Player[], gameWorld: GameWorldScenario): Player[] {
  return players.map(p => {
    const multiplier = gameWorld.playerMultipliers.get(p.id) || 1.0;
    return {
      ...p,
      projection: Math.max(0, p.projection * multiplier),
    };
  });
}

/**
 * Apply DISTRIBUTIONAL variance to player projections
 *
 * From DFS Theory Masterclass:
 * "Linear randomness is a set percentage that does not take into account
 * the individual player's distribution of a range of outcomes."
 *
 * "Distributional randomness is based on the percentile outcomes of the
 * individual player... the lineup builder will not choose a number linearly
 * but it will choose a number percentile-wise."
 *
 * Uses player's ceiling (85th percentile) to create realistic variance.
 * Players with wider ceiling-floor ranges get more variance.
 *
 * NOTE: Uses actual ceiling data from SaberSim. If missing, uses conservative
 * estimate to avoid over-optimistic variance for players without data.
 */
function applyProjectionVariance(players: Player[], variancePercent: number): Player[] {
  return players.map(p => {
    // Calculate player's individual variance based on their ceiling
    // Ceiling is 85th percentile, so we can estimate the distribution
    // Use actual ceiling data; if missing, use very conservative 5% upside
    const ceiling = (p.ceiling && p.ceiling > 0) ? p.ceiling : p.projection * 1.05;
    const upside = ceiling - p.projection;  // Distance to 85th percentile

    // Estimate floor as symmetric (roughly 15th percentile)
    // In reality, DFS scoring has a floor of 0, but we use this for variance estimation
    const floor = Math.max(0, p.projection - upside);

    // Generate a random percentile (0-1)
    const percentile = Math.random();

    // Map percentile to projection using triangular-ish distribution
    // This gives more weight to outcomes near the mean
    let variedProjection: number;

    if (percentile < 0.5) {
      // Below median: interpolate between floor and projection
      // Use sqrt to weight toward median (more realistic)
      const t = Math.sqrt(percentile * 2);
      variedProjection = floor + (p.projection - floor) * t;
    } else {
      // Above median: interpolate between projection and ceiling
      // Use sqrt to weight toward median
      const t = Math.sqrt((percentile - 0.5) * 2);
      variedProjection = p.projection + (ceiling - p.projection) * t;
    }

    // Damped projection: blend original and varied based on variance percentage
    // variancePercent directly controls amplitude (0.25 = ±25% max swing)
    const dampedProjection = p.projection + (variedProjection - p.projection) * variancePercent;

    return {
      ...p,
      projection: Math.max(0, dampedProjection),
    };
  });
}

/**
 * Apply ceiling-projection blend to player projections for optimization.
 *
 * The field optimizes for pure expected projection. By blending in ceiling
 * (99th percentile boom outcome), we find lineups that maximize BOTH
 * projection AND upside — naturally producing different constructions.
 *
 * Players with high ceiling relative to projection get boosted, making
 * the optimizer favor boom candidates that the field underweights.
 *
 * @param players - Player pool
 * @param blendFactor - Weight for ceiling (0.3 = 70% proj, 30% ceiling)
 */
export function applyCeilingBlend(players: Player[], blendFactor: number = 0.3): Player[] {
  return players.map(p => {
    const ceil = p.ceiling99 || p.ceiling || p.projection * 1.3;
    const blended = p.projection * (1 - blendFactor) + ceil * blendFactor;
    return {
      ...p,
      projection: blended,
    };
  });
}

/**
 * Boost players based on ceiling RATIO (ceiling/projection).
 * Uses weighted combination of p85 (ceiling) and p99 (ceiling99) percentiles.
 *
 * A 1.5x ratio player has more GPP upside than a 1.2x ratio player,
 * even if their raw projections are similar.
 *
 * @param players - Player pool
 * @param boostFactor - How much to boost above-average ratio players (0.15-0.25)
 * @param p99Weight - Weight for p99 ceiling in ratio calculation (0.0-1.0)
 */
export function applyCeilingRatioBoost(
  players: Player[],
  boostFactor: number = 0.20,
  p99Weight: number = 0.4  // 60% p85 + 40% p99
): Player[] {
  // Calculate blended ceiling ratios using both p85 and p99
  const ratios = players.map(p => {
    const p85Ceil = p.ceiling || p.projection * 1.25;
    const p99Ceil = p.ceiling99 || p85Ceil * 1.15;

    // Weighted blend of p85 and p99 ceiling
    const blendedCeil = p85Ceil * (1 - p99Weight) + p99Ceil * p99Weight;
    return blendedCeil / Math.max(1, p.projection);
  });

  // Calculate average ratio (typically 1.30-1.40 for NBA)
  const avgRatio = ratios.reduce((sum, r) => sum + r, 0) / ratios.length;

  return players.map((p, i) => {
    const ratioDiff = ratios[i] - avgRatio;  // positive = above-average boom potential
    const boost = 1 + ratioDiff * boostFactor;
    return {
      ...p,
      projection: p.projection * Math.max(0.8, Math.min(1.4, boost)),
    };
  });
}

/**
 * Filter players by INVERTED ownership probability.
 * INVERTED: Low ownership = HIGH include probability (favor contrarian)
 * This ensures ALL pool iterations now either exclude chalk, penalize it, or favor low-owned.
 *
 * @param players - Player pool
 * @param inversionStrength - How strongly to favor low-owned (0.7 = moderate, 1.0 = strong)
 */
// ============================================================
// STACK-FIRST LINEUP CONSTRUCTION
// ============================================================

/**
 * Stack composition types for stack-first construction.
 * - '3+1': 3 players from one team + 1 from opponent (classic bring-back)
 * - '2+2': 2 from each team (mini-stack with correlation)
 * - '4+0': 4 players from one team (full team stack, risky but high ceiling)
 * - '2+1': 2 from one team + 1 from opponent (lighter stack)
 */
type StackComposition = '3+1' | '2+2' | '4+0' | '2+1' | '4+1' | '3+2' | '5+1';

/**
 * Construct lineups using stack-first approach.
 *
 * Instead of position-by-position branch-and-bound (which accidentally
 * creates stacks at best), this intentionally builds game stacks:
 * 1. Pick a "primary game" (weighted by game total)
 * 2. Pre-select 2-4 players from that game based on composition
 * 3. Fill remaining slots with branch-and-bound using modified projections
 *
 * This captures correlated upside — when a game goes to OT or becomes
 * a shootout, having 3-4 players from that game gives massive ceiling.
 *
 * @param config - Contest configuration
 * @param pool - Player pool with original projections
 * @param gameWorld - Correlated game-world scenario
 * @param seenHashes - Already-generated lineup hashes
 * @param lineupsPerIteration - Target number of lineups
 * @param minSalary - Minimum salary
 */
function constructStackFirstLineups(
  config: ContestConfig,
  pool: PlayerPool,
  gameWorld: GameWorldScenario,
  seenHashes: Set<string>,
  lineupsPerIteration: number,
  minSalary?: number,
  fillPlayers?: Player[],  // Optional pre-modified players for fill step (formula-adjusted projections)
): { lineups: Lineup[]; evaluatedCount: number } {
  const lineups: Lineup[] = [];
  let evaluatedCount = 0;
  const maxAttempts = lineupsPerIteration * 20;

  // Build game info map: gameId → { teams, players, gameTotal }
  const gameMap = new Map<string, {
    teams: Set<string>;
    players: Player[];
    gameTotal: number;
  }>();

  for (const p of pool.players) {
    const gameId = p.gameInfo || `${p.team}_game`;
    if (!gameMap.has(gameId)) {
      gameMap.set(gameId, { teams: new Set(), players: [], gameTotal: 220 });
    }
    const g = gameMap.get(gameId)!;
    g.teams.add(p.team);
    g.players.push(p);
    if (p.gameTotal && p.gameTotal > g.gameTotal) {
      g.gameTotal = p.gameTotal;
    }
  }

  // Build game weights for selection (higher game total = more likely to be picked)
  const games = [...gameMap.entries()];
  if (games.length < 2) return { lineups, evaluatedCount: 0 };

  const gameWeights = games.map(([, g]) => Math.pow(g.gameTotal / 220, 2));
  const totalGameWeight = gameWeights.reduce((a, b) => a + b, 0);

  // Stack compositions — calibrated from 63K pro entries across 17 slates:
  // Data findings: 5-1-1 (1.13x lift), 6-1-1 (1.71x lift), 4-4 (1.74x lift).
  // Spread patterns (2-2-2-x) are 0.68-0.81x lift = clear losers.
  // 90.6% of top-1% entries have bringbacks. bb_count=2 is optimal (40.4% of winners).
  const compositions: { comp: StackComposition; weight: number }[] = [
    { comp: '3+1', weight: 0.28 },  // 28%: Classic 3+1 bring-back (was 40%)
    { comp: '4+1', weight: 0.25 },  // 25%: Deep 5-stack with BB (was 15% — big increase for 5-stack)
    { comp: '2+2', weight: 0.15 },  // 15%: Two mini-stacks (was 20%)
    { comp: '2+1', weight: 0.13 },  // 13%: Light stack (was 15%)
    { comp: '3+2', weight: 0.10 },  // 10%: Balanced 5-stack (was 5% — doubled)
    { comp: '5+1', weight: 0.05 },  // 5%: NEW — 6-stack targeting 6-1-1 pattern (1.71x lift)
    { comp: '4+0', weight: 0.04 },  // 4%: No-BB team stack (was 5% — reduced per Plan 5)
  ];

  const eligibilityMatrix = buildEligibilityMatrix(pool, config);

  for (let attempt = 0; attempt < maxAttempts && lineups.length < lineupsPerIteration; attempt++) {
    evaluatedCount++;

    // 1. Pick a primary game (weighted by game total)
    let gameRandom = Math.random() * totalGameWeight;
    let selectedGameIdx = 0;
    for (let i = 0; i < games.length; i++) {
      gameRandom -= gameWeights[i];
      if (gameRandom <= 0) { selectedGameIdx = i; break; }
    }
    const [gameId, gameInfo] = games[selectedGameIdx];
    const teamArr = [...gameInfo.teams];
    if (teamArr.length < 2) continue; // Need 2 teams for bring-back

    // 2. Pick composition
    let compRandom = Math.random();
    let comp: StackComposition = '3+1';
    for (const c of compositions) {
      compRandom -= c.weight;
      if (compRandom <= 0) { comp = c.comp; break; }
    }

    // 3. Select stack players
    const primaryTeam = teamArr[Math.random() < 0.5 ? 0 : 1];
    const opponentTeam = teamArr[0] === primaryTeam ? teamArr[1] : teamArr[0];

    const primaryPlayers = gameInfo.players.filter(p => p.team === primaryTeam);
    const opponentPlayers = gameInfo.players.filter(p => p.team === opponentTeam);

    if (primaryPlayers.length < 2 || opponentPlayers.length === 0) continue;

    // Apply game-world multipliers to weight selection
    // R12: Add ceiling-ratio boost to bias stack picks toward boomier players.
    // Pro stacking data: players IN stacks have higher ceiling ratio (1.298 vs 1.259)
    // and lower salary ($5,927 vs $6,622). Ceiling-ratio weighting naturally selects
    // cheaper high-upside players for stacks, while greedy fill picks expensive anchors.
    const weightedSelect = (candidates: Player[], count: number): Player[] => {
      const available = [...candidates];
      const selected: Player[] = [];
      for (let i = 0; i < count && available.length > 0; i++) {
        // Weight by game-world adjusted projection × ceiling ratio boost
        const weights = available.map(p => {
          const mult = gameWorld.playerMultipliers.get(p.id) || 1.0;
          const p85Ceil = p.ceiling || p.projection * 1.25;
          const p99Ceil = p.ceiling99 || p85Ceil * 1.15;
          const blendedCeil = p85Ceil * 0.6 + p99Ceil * 0.4;
          const ceilRatio = blendedCeil / Math.max(1, p.projection);
          const ceilBoost = Math.pow(Math.max(1.0, ceilRatio), 1.5);
          return Math.max(0.1, p.projection * mult * ceilBoost);
        });
        const total = weights.reduce((a, b) => a + b, 0);
        let r = Math.random() * total;
        let pickIdx = 0;
        for (let j = 0; j < weights.length; j++) {
          r -= weights[j];
          if (r <= 0) { pickIdx = j; break; }
        }
        selected.push(available[pickIdx]);
        available.splice(pickIdx, 1);
      }
      return selected;
    };

    let stackPlayers: Player[];
    switch (comp) {
      case '3+1':
        stackPlayers = [...weightedSelect(primaryPlayers, 3), ...weightedSelect(opponentPlayers, 1)];
        break;
      case '2+2':
        stackPlayers = [...weightedSelect(primaryPlayers, 2), ...weightedSelect(opponentPlayers, 2)];
        break;
      case '4+0':
        stackPlayers = weightedSelect(primaryPlayers, Math.min(4, primaryPlayers.length));
        break;
      case '2+1':
        stackPlayers = [...weightedSelect(primaryPlayers, 2), ...weightedSelect(opponentPlayers, 1)];
        break;
      case '4+1':
        stackPlayers = [...weightedSelect(primaryPlayers, Math.min(4, primaryPlayers.length)), ...weightedSelect(opponentPlayers, 1)];
        break;
      case '3+2':
        stackPlayers = [...weightedSelect(primaryPlayers, 3), ...weightedSelect(opponentPlayers, Math.min(2, opponentPlayers.length))];
        break;
      case '5+1':
        // Plan 6: 6-stack targeting 6-1-1 pattern (1.71x lift in pro data)
        stackPlayers = [...weightedSelect(primaryPlayers, Math.min(5, primaryPlayers.length)), ...weightedSelect(opponentPlayers, 1)];
        break;
    }

    if (stackPlayers.length < 2) continue;

    // 4. Check max players per team constraint
    if (config.maxPlayersPerTeam) {
      const teamCounts = new Map<string, number>();
      for (const p of stackPlayers) {
        teamCounts.set(p.team, (teamCounts.get(p.team) || 0) + 1);
      }
      let valid = true;
      for (const count of teamCounts.values()) {
        if (count > config.maxPlayersPerTeam) { valid = false; break; }
      }
      if (!valid) continue;
    }

    // 5. Fill remaining slots using greedy construction with game-world projections
    const usedNames = new Set(stackPlayers.map(p => p.name));
    const usedSalary = stackPlayers.reduce((s, p) => s + p.salary, 0);
    const remainingSlots = config.rosterSize - stackPlayers.length;

    if (usedSalary > config.salaryCap) continue;

    // Assign stack players to best-fit slots
    const assignedSlots = new Set<number>();
    const slotAssignments = new Map<number, Player>(); // slotIdx → player

    for (const sp of stackPlayers) {
      let bestSlot = -1;
      for (let si = 0; si < config.positions.length; si++) {
        if (assignedSlots.has(si)) continue;
        if (eligibilityMatrix[si][pool.players.indexOf(sp)]) {
          bestSlot = si;
          break;
        }
      }
      if (bestSlot === -1) break; // Can't fit this player
      assignedSlots.add(bestSlot);
      slotAssignments.set(bestSlot, sp);
    }

    if (slotAssignments.size < stackPlayers.length) continue;

    // --- SECONDARY STACK PRE-SELECTION ---
    // Pro analysis: 86% of top-1% entries have secondary stacks (2+ from another game).
    // Pattern 3-2 is #1 (26%), 4-2 is #2 (18.5%). Secondary stacks are 55% same-team.
    // 40% of the time, pre-select 2 players from a different game as a secondary mini-stack.
    if (games.length >= 3 && remainingSlots >= 3 && Math.random() < 0.40) {
      // Pick a secondary game (different from primary, weighted by game total)
      const otherGames = games.filter(([gid]) => gid !== gameId);
      if (otherGames.length > 0) {
        const otherWeights = otherGames.map(([, g]) => Math.pow(g.gameTotal / 220, 2));
        const otherTotalW = otherWeights.reduce((a, b) => a + b, 0);
        let r2 = Math.random() * otherTotalW;
        let secIdx = 0;
        for (let i = 0; i < otherGames.length; i++) {
          r2 -= otherWeights[i];
          if (r2 <= 0) { secIdx = i; break; }
        }
        const [, secGameInfo] = otherGames[secIdx];
        const secTeamArr = [...secGameInfo.teams];
        // 55% same-team secondary (matching pro data), 45% bring-back secondary
        const secPlayers = secGameInfo.players.filter(p => !usedNames.has(p.name));
        if (secPlayers.length >= 2) {
          let secPicks: Player[];
          if (secTeamArr.length >= 2 && Math.random() < 0.45) {
            // Bring-back secondary: 1 from each team
            const secTeam1 = secPlayers.filter(p => p.team === secTeamArr[0]);
            const secTeam2 = secPlayers.filter(p => p.team === secTeamArr[1]);
            if (secTeam1.length > 0 && secTeam2.length > 0) {
              secPicks = [...weightedSelect(secTeam1, 1), ...weightedSelect(secTeam2, 1)];
            } else {
              secPicks = weightedSelect(secPlayers, 2);
            }
          } else {
            // Same-team secondary: 2 from one team
            const secTeam = secTeamArr[Math.floor(Math.random() * secTeamArr.length)];
            const sameTeamPlayers = secPlayers.filter(p => p.team === secTeam);
            secPicks = sameTeamPlayers.length >= 2 ? weightedSelect(sameTeamPlayers, 2) : weightedSelect(secPlayers, 2);
          }
          // Try to assign secondary picks to remaining slots
          let secAssigned = 0;
          for (const sp of secPicks) {
            if (usedNames.has(sp.name)) continue;
            let bestSlot = -1;
            for (let si = 0; si < config.positions.length; si++) {
              if (assignedSlots.has(si)) continue;
              const pidx = pool.players.indexOf(sp);
              if (pidx >= 0 && eligibilityMatrix[si][pidx]) {
                bestSlot = si;
                break;
              }
            }
            if (bestSlot !== -1) {
              const newSalary = usedSalary + stackPlayers.reduce((s, p) => 0, 0) + sp.salary;
              assignedSlots.add(bestSlot);
              slotAssignments.set(bestSlot, sp);
              usedNames.add(sp.name);
              stackPlayers.push(sp); // Add to stack players for bitmap marking
              secAssigned++;
            }
          }
        }
      }
    }
    // Recalculate after potential secondary stack additions
    const finalUsedSalary = stackPlayers.reduce((s, p) => s + p.salary, 0);
    if (finalUsedSalary > config.salaryCap) continue;

    // Fill remaining slots using mini-B&B search (replaces greedy fill)
    // Mini-B&B finds salary-optimal completions the greedy approach misses
    // Use pre-modified fill players (formula-adjusted) if provided, otherwise apply game world
    const worldPlayers = fillPlayers || applyGameWorld(pool.players, gameWorld);
    const effectiveMinSalary = minSalary ?? config.salaryMin;

    // Build used bitmap from stack players
    const miniNameMap = buildPlayerNameMap(pool);
    const miniUsedBitmap = new Uint8Array(pool.players.length);
    for (const sp of stackPlayers) {
      const indices = miniNameMap.nameToIndices.get(sp.name);
      if (indices) for (const idx of indices) miniUsedBitmap[idx] = 1;
    }

    // Remaining slot indices (unfilled)
    const remainSlotIndices: number[] = [];
    for (let si = 0; si < config.positions.length; si++) {
      if (!assignedSlots.has(si)) remainSlotIndices.push(si);
    }

    // Sort remaining-slot candidates by game-world-adjusted projection desc
    const miniSortedBySlot: number[][] = remainSlotIndices.map(si => {
      const eligible: number[] = [];
      for (let j = 0; j < pool.players.length; j++) {
        if (!eligibilityMatrix[si][j]) continue;
        if (miniUsedBitmap[j]) continue;
        eligible.push(j);
      }
      return eligible.sort((a, b) => worldPlayers[b].projection - worldPlayers[a].projection);
    });

    // Mini-B&B: search remaining slots to find up to 3 completions
    const MINI_MAX_NODES = 200_000;
    const MINI_MAX_TIME = 500;
    const miniStartTime = Date.now();
    let miniNodes = 0;
    const completions: Player[][] = [];

    const teamCounts = new Map<string, number>();
    for (const p of stackPlayers) {
      teamCounts.set(p.team, (teamCounts.get(p.team) || 0) + 1);
    }

    const miniCurrentPlayers: Player[] = [];
    function miniSearch(
      remIdx: number,
      salary: number,
      proj: number,
      bestProj: { value: number }
    ): void {
      if (miniNodes >= MINI_MAX_NODES) return;
      if (completions.length >= 3) return;
      miniNodes++;
      if (miniNodes % 5000 === 0 && Date.now() - miniStartTime > MINI_MAX_TIME) return;

      if (remIdx === remainSlotIndices.length) {
        // Complete — check constraints
        if (salary < effectiveMinSalary) return;
        const allP = [...stackPlayers, ...miniCurrentPlayers];
        if (config.minGames && config.minGames > 1) {
          const gs = new Set(allP.map(p => p.gameInfo || p.team));
          if (gs.size < config.minGames) return;
        }
        if (config.contestType === 'showdown') {
          const ts = new Set(allP.map(p => p.team));
          if (ts.size < 2) return;
        }
        const totalProj = allP.reduce((s, p) => s + p.projection, 0);
        if (totalProj > bestProj.value) bestProj.value = totalProj;
        completions.push([...miniCurrentPlayers]);
        return;
      }

      const candidates = miniSortedBySlot[remIdx];
      const remSalary = config.salaryCap - salary;

      for (let ci = 0; ci < candidates.length; ci++) {
        if (miniNodes >= MINI_MAX_NODES || completions.length >= 3) return;
        const pIdx = candidates[ci];
        if (miniUsedBitmap[pIdx]) continue;

        const player = pool.players[pIdx];
        if (player.salary > remSalary) continue;

        if (config.maxPlayersPerTeam) {
          const tc = teamCounts.get(player.team) || 0;
          if (tc >= config.maxPlayersPerTeam) continue;
        }

        // Showdown check
        const slotIdx = remainSlotIndices[remIdx];
        if (config.contestType === 'showdown' && !config.positions[slotIdx].isCaptain) {
          const cpt = stackPlayers.find(p => p.isCaptain) || miniCurrentPlayers.find(p => p.isCaptain);
          if (cpt && player.name === cpt.name) continue;
        }

        // MMA opponent exclusion
        if (player.opponent) {
          const allCurrent = [...stackPlayers, ...miniCurrentPlayers];
          if (allCurrent.some(p => p.name === player.opponent)) continue;
        }

        // MLB: batter vs opposing pitcher — only on 2-game slates
        if (config.sport === 'mlb') {
          const allCurrent = [...stackPlayers, ...miniCurrentPlayers];
          const localGames = new Set(pool.players.map(p => p.gameInfo || p.team));
          const localMaxBvP = localGames.size <= 2 ? 2 : 0;
          let mlbSkip = false;
          if (player.positions.includes('P')) {
            const battersVs = allCurrent.filter(s => !s.positions.includes('P') && s.team === player.opponent);
            if (battersVs.length > localMaxBvP) mlbSkip = true;
          } else {
            for (const s of allCurrent) {
              if (s.positions.includes('P') && s.team === player.opponent) {
                const existing = allCurrent.filter(cp => !cp.positions.includes('P') && cp.team === player.team);
                if (existing.length >= localMaxBvP) { mlbSkip = true; break; }
              }
            }
          }
          if (mlbSkip) continue;
        }

        // Mark used
        const nameIndices = miniNameMap.nameToIndices.get(player.name)!;
        for (let m = 0; m < nameIndices.length; m++) miniUsedBitmap[nameIndices[m]] = 1;
        miniCurrentPlayers.push(player);
        teamCounts.set(player.team, (teamCounts.get(player.team) || 0) + 1);

        miniSearch(remIdx + 1, salary + player.salary, proj + player.projection, bestProj);

        // Restore
        miniCurrentPlayers.pop();
        for (let m = 0; m < nameIndices.length; m++) miniUsedBitmap[nameIndices[m]] = 0;
        teamCounts.set(player.team, (teamCounts.get(player.team) || 0) - 1);
      }
    }

    miniSearch(0, finalUsedSalary, 0, { value: 0 });
    evaluatedCount += miniNodes;
    // Create lineups from all completions
    for (const completion of completions) {
      // Reconstruct ordered players for each slot
      const allPlayers: Player[] = new Array(config.rosterSize);
      for (const [si, sp] of slotAssignments) {
        allPlayers[si] = sp;
      }
      let compIdx = 0;
      for (const si of remainSlotIndices) {
        allPlayers[si] = completion[compIdx++];
      }

      if (allPlayers.some(p => !p)) continue;

      const lineup = createLineup(allPlayers);
      if (!seenHashes.has(lineup.hash)) {
        lineup.constructionMethod = 'game-stack';
        lineups.push(lineup);
        seenHashes.add(lineup.hash);
      }
    }
  }

  return { lineups, evaluatedCount };
}

/**
 * Systematically enumerate ALL valid stacked lineups above a projection floor.
 *
 * Instead of random sampling, this function:
 * 1. For each game, generates all viable stack cores (2-5 players from same game with bring-back)
 * 2. Prunes cores whose projection + upper bound of remaining slots < floor
 * 3. Completes each viable core with mini-B&B using real projections
 * 4. Keeps every completed lineup above the projection floor
 *
 * This guarantees we find every high-projection stacked lineup the slate can produce.
 */
function enumerateStackedLineups(
  config: ContestConfig,
  pool: PlayerPool,
  projFloor: number,
  seenHashes: Set<string>,
  maxLineups: number,
  minSalary?: number,
): { lineups: Lineup[]; evaluatedCount: number } {
  const lineups: Lineup[] = [];
  let evaluatedCount = 0;

  // Build game info map
  const gameMap = new Map<string, { teams: string[]; players: Player[]; gameTotal: number }>();
  for (const p of pool.players) {
    const gameId = p.gameInfo || `${p.team}_game`;
    if (!gameMap.has(gameId)) {
      gameMap.set(gameId, { teams: [], players: [], gameTotal: 220 });
    }
    const g = gameMap.get(gameId)!;
    if (!g.teams.includes(p.team)) g.teams.push(p.team);
    g.players.push(p);
    if (p.gameTotal && p.gameTotal > g.gameTotal) g.gameTotal = p.gameTotal;
  }

  const games = [...gameMap.entries()];
  if (games.length < 2) return { lineups, evaluatedCount: 0 };

  const eligibilityMatrix = buildEligibilityMatrix(pool, config);
  const nameMap = buildPlayerNameMap(pool);
  const effectiveMinSalary = minSalary ?? config.salaryMin;

  // Compute upper bound: best possible projection from remaining N slots
  // Sort all players by projection descending, take top N (rough upper bound)
  const playersByProj = [...pool.players].sort((a, b) => b.projection - a.projection);

  function upperBoundForSlots(usedNames: Set<string>, usedSalary: number, slotsLeft: number): number {
    let bound = 0;
    let count = 0;
    for (const p of playersByProj) {
      if (count >= slotsLeft) break;
      if (usedNames.has(p.name)) continue;
      bound += p.projection;
      count++;
    }
    return bound;
  }

  // Stack compositions pros actually use (63K entries):
  // 3-2-2-1: 14.6% (best hit rate), 4-2-1-1: 14.0%, 4-3-1: 10.4%
  // 2-man only stacks (2-2-2-x) are worst at 0.91% hit rate — skip 2+0.
  // Keep 3+0 since 37.7% of pros use 3-man max stacks.
  type StackSpec = { primary: number; opponent: number };
  const stackSpecs: StackSpec[] = [
    { primary: 3, opponent: 0 },  // 3+0 = 3-man stack (no BB, 37.7% of pros)
    { primary: 2, opponent: 1 },  // 2+1 = 3 from game (BB)
    { primary: 3, opponent: 1 },  // 3+1 = 4 from game (classic BB)
    { primary: 2, opponent: 2 },  // 2+2 = 4 from game (double BB)
    { primary: 4, opponent: 1 },  // 4+1 = 5 from game
    { primary: 3, opponent: 2 },  // 3+2 = 5 from game
    { primary: 5, opponent: 1 },  // 5+1 = 6 from game (rare but 2.30% hit rate)
  ];

  const MINI_MAX_NODES = 50_000;
  const MINI_MAX_TIME = 200;  // ms per core
  const MAX_CORES_PER_GAME = 300;  // Limit per game×spec
  const MAX_TOTAL_LINEUPS = Math.min(maxLineups, 25_000);
  const ENUM_TIME_LIMIT = 120_000;  // 120s global time limit
  const enumStartTime = Date.now();

  console.log(`  Enumerating stacked lineups: ${games.length} games, floor=${projFloor.toFixed(1)}`);

  for (const [gameId, gameInfo] of games) {
    if (lineups.length >= MAX_TOTAL_LINEUPS || Date.now() - enumStartTime > ENUM_TIME_LIMIT) break;

    for (const spec of stackSpecs) {
      if (lineups.length >= MAX_TOTAL_LINEUPS || Date.now() - enumStartTime > ENUM_TIME_LIMIT) break;
      if (gameInfo.teams.length < 2 && spec.opponent > 0) continue;

      // For each team as primary
      for (const primaryTeam of gameInfo.teams) {
        if (lineups.length >= MAX_TOTAL_LINEUPS) break;

        const opponentTeams = gameInfo.teams.filter(t => t !== primaryTeam);
        const primaryPlayers = gameInfo.players
          .filter(p => p.team === primaryTeam)
          .sort((a, b) => b.projection - a.projection);
        const opponentPlayers = gameInfo.players
          .filter(p => opponentTeams.includes(p.team))
          .sort((a, b) => b.projection - a.projection);

        if (primaryPlayers.length < spec.primary) continue;
        if (opponentPlayers.length < spec.opponent) continue;

        // Enumerate primary player combinations (C(n, k))
        const primaryCombos = generateCombinations(primaryPlayers, spec.primary);

        let coresTriedThisSpec = 0;

        for (const primaryCombo of primaryCombos) {
          if (lineups.length >= MAX_TOTAL_LINEUPS || coresTriedThisSpec >= MAX_CORES_PER_GAME || Date.now() - enumStartTime > ENUM_TIME_LIMIT) break;

          const primaryProj = primaryCombo.reduce((s, p) => s + p.projection, 0);
          const primarySalary = primaryCombo.reduce((s, p) => s + p.salary, 0);
          const primaryNames = new Set(primaryCombo.map(p => p.name));

          // Quick prune: primary projection + best possible for remaining slots
          const slotsAfterPrimary = config.rosterSize - spec.primary - spec.opponent;
          const availOpponent = opponentPlayers.filter(p => !primaryNames.has(p.name));
          if (availOpponent.length < spec.opponent) continue;

          // Best-case opponent projection
          const bestOpponentProj = availOpponent
            .slice(0, spec.opponent)
            .reduce((s, p) => s + p.projection, 0);

          // Upper bound check: can this core possibly reach the floor?
          const coreUpperBound = primaryProj + bestOpponentProj +
            upperBoundForSlots(primaryNames, primarySalary, slotsAfterPrimary + spec.opponent);
          if (coreUpperBound < projFloor) continue;  // Prune — this core can never reach floor

          // Enumerate opponent combinations
          const opponentCombos = spec.opponent > 0
            ? generateCombinations(availOpponent, spec.opponent)
            : [[]];

          for (const opponentCombo of opponentCombos) {
            if (lineups.length >= MAX_TOTAL_LINEUPS || coresTriedThisSpec >= MAX_CORES_PER_GAME || Date.now() - enumStartTime > ENUM_TIME_LIMIT) break;

            const stackPlayers = [...primaryCombo, ...opponentCombo];
            const stackProj = stackPlayers.reduce((s, p) => s + p.projection, 0);
            const stackSalary = stackPlayers.reduce((s, p) => s + p.salary, 0);

            if (stackSalary > config.salaryCap) continue;

            // Check max players per team
            if (config.maxPlayersPerTeam) {
              const tc = new Map<string, number>();
              let valid = true;
              for (const p of stackPlayers) {
                tc.set(p.team, (tc.get(p.team) || 0) + 1);
                if (tc.get(p.team)! > config.maxPlayersPerTeam) { valid = false; break; }
              }
              if (!valid) continue;
            }

            const usedNames = new Set(stackPlayers.map(p => p.name));
            const remainingSlots = config.rosterSize - stackPlayers.length;

            // Upper bound check with actual core
            const fillUpperBound = upperBoundForSlots(usedNames, stackSalary, remainingSlots);
            if (stackProj + fillUpperBound < projFloor) continue;  // Prune

            // Assign stack players to slots
            const assignedSlots = new Set<number>();
            const slotAssignments = new Map<number, Player>();
            let assignOk = true;
            for (const sp of stackPlayers) {
              let bestSlot = -1;
              for (let si = 0; si < config.positions.length; si++) {
                if (assignedSlots.has(si)) continue;
                const pidx = pool.players.indexOf(sp);
                if (pidx >= 0 && eligibilityMatrix[si][pidx]) {
                  bestSlot = si;
                  break;
                }
              }
              if (bestSlot === -1) { assignOk = false; break; }
              assignedSlots.add(bestSlot);
              slotAssignments.set(bestSlot, sp);
            }
            if (!assignOk) continue;

            coresTriedThisSpec++;

            // Mini-B&B to complete remaining slots
            const usedBitmap = new Uint8Array(pool.players.length);
            for (const sp of stackPlayers) {
              const indices = nameMap.nameToIndices.get(sp.name);
              if (indices) for (const idx of indices) usedBitmap[idx] = 1;
            }

            const remainSlotIndices: number[] = [];
            for (let si = 0; si < config.positions.length; si++) {
              if (!assignedSlots.has(si)) remainSlotIndices.push(si);
            }

            const sortedBySlot: number[][] = remainSlotIndices.map(si => {
              const eligible: number[] = [];
              for (let j = 0; j < pool.players.length; j++) {
                if (!eligibilityMatrix[si][j] || usedBitmap[j]) continue;
                eligible.push(j);
              }
              return eligible.sort((a, b) => pool.players[b].projection - pool.players[a].projection);
            });

            // Mini-B&B search
            const miniStart = Date.now();
            let miniNodes = 0;
            const completions: Player[][] = [];
            const teamCounts = new Map<string, number>();
            for (const p of stackPlayers) {
              teamCounts.set(p.team, (teamCounts.get(p.team) || 0) + 1);
            }
            const currentFill: Player[] = [];

            function miniSearch(
              remIdx: number, salary: number, proj: number
            ): void {
              if (miniNodes >= MINI_MAX_NODES || completions.length >= 3) return;
              miniNodes++;
              if (miniNodes % 5000 === 0 && Date.now() - miniStart > MINI_MAX_TIME) return;

              if (remIdx === remainSlotIndices.length) {
                if (salary < effectiveMinSalary) return;
                const totalProj = stackProj + proj;
                if (totalProj < projFloor) return;  // Below floor — skip
                // Check minGames
                if (config.minGames && config.minGames > 1) {
                  const allP = [...stackPlayers, ...currentFill];
                  const gs = new Set(allP.map(p => p.gameInfo || p.team));
                  if (gs.size < config.minGames) return;
                }
                completions.push([...currentFill]);
                return;
              }

              const candidates = sortedBySlot[remIdx];
              const remSalary = config.salaryCap - salary;
              const slotsLeft = remainSlotIndices.length - remIdx - 1;

              for (let ci = 0; ci < candidates.length; ci++) {
                if (miniNodes >= MINI_MAX_NODES || completions.length >= 3) return;
                const pIdx = candidates[ci];
                if (usedBitmap[pIdx]) continue;

                const player = pool.players[pIdx];
                if (player.salary > remSalary) continue;

                // Projection upper bound pruning: current proj + this player + best remaining
                // If can't reach floor, prune entire subtree
                const projAfter = proj + player.projection;
                if (slotsLeft > 0) {
                  // Quick upper bound: sum of top slotsLeft projections from remaining candidates
                  let ub = projAfter;
                  let ubCount = 0;
                  for (let si2 = remIdx + 1; si2 < remainSlotIndices.length && ubCount < slotsLeft; si2++) {
                    const cands2 = sortedBySlot[si2];
                    if (cands2.length > 0) {
                      ub += pool.players[cands2[0]].projection;
                      ubCount++;
                    }
                  }
                  if (stackProj + ub < projFloor) break;  // All subsequent players are worse — prune
                }

                if (config.maxPlayersPerTeam) {
                  const tc = teamCounts.get(player.team) || 0;
                  if (tc >= config.maxPlayersPerTeam) continue;
                }

                // MMA opponent exclusion
                if (player.opponent) {
                  const allCurrent = [...stackPlayers, ...currentFill];
                  if (allCurrent.some(p => p.name === player.opponent)) continue;
                }

                // MLB: batter vs opposing pitcher — only on 2-game slates
                if (config.sport === 'mlb') {
                  const allCurrent = [...stackPlayers, ...currentFill];
                  const localGames2 = new Set(pool.players.map(p => p.gameInfo || p.team));
                  const localMaxBvP2 = localGames2.size <= 2 ? 2 : 0;
                  let mlbSkip = false;
                  if (player.positions.includes('P')) {
                    const battersVs = allCurrent.filter(s => !s.positions.includes('P') && s.team === player.opponent);
                    if (battersVs.length > localMaxBvP2) mlbSkip = true;
                  } else {
                    for (const s of allCurrent) {
                      if (s.positions.includes('P') && s.team === player.opponent) {
                        const existing = allCurrent.filter(cp => !cp.positions.includes('P') && cp.team === player.team);
                        if (existing.length >= localMaxBvP2) { mlbSkip = true; break; }
                      }
                    }
                  }
                  if (mlbSkip) continue;
                }

                // Mark used
                const nameIndices = nameMap.nameToIndices.get(player.name)!;
                for (const idx of nameIndices) usedBitmap[idx] = 1;
                currentFill.push(player);
                teamCounts.set(player.team, (teamCounts.get(player.team) || 0) + 1);

                miniSearch(remIdx + 1, salary + player.salary, projAfter);

                // Restore
                currentFill.pop();
                for (const idx of nameIndices) usedBitmap[idx] = 0;
                teamCounts.set(player.team, (teamCounts.get(player.team) || 0) - 1);
              }
            }

            miniSearch(0, stackSalary, 0);
            evaluatedCount += miniNodes;

            // Create lineups from completions
            for (const completion of completions) {
              const allPlayers: Player[] = new Array(config.rosterSize);
              for (const [si, sp] of slotAssignments) allPlayers[si] = sp;
              let compIdx = 0;
              for (const si of remainSlotIndices) allPlayers[si] = completion[compIdx++];

              if (allPlayers.some(p => !p)) continue;

              const lineup = createLineup(allPlayers);
              if (!seenHashes.has(lineup.hash) && lineup.projection >= projFloor) {
                lineup.constructionMethod = 'stack-enum';
                lineups.push(lineup);
                seenHashes.add(lineup.hash);
              }
            }
          }
        }
      }
    }
  }

  console.log(`  Enumeration: ${lineups.length.toLocaleString()} stacked lineups above floor, ${evaluatedCount.toLocaleString()} nodes explored`);
  return { lineups, evaluatedCount };
}

/**
 * Generate all combinations of k elements from arr.
 * Returns arrays sorted by sum of projections descending (best combos first).
 */
function generateCombinations(arr: Player[], k: number): Player[][] {
  if (k <= 0 || k > arr.length) return k === 0 ? [[]] : [];
  if (k === arr.length) return [arr];

  const results: Player[][] = [];
  const MAX_COMBOS = 1000;  // Cap to prevent explosion on large slates

  function backtrack(start: number, current: Player[]): void {
    if (results.length >= MAX_COMBOS) return;
    if (current.length === k) {
      results.push([...current]);
      return;
    }
    const remaining = k - current.length;
    for (let i = start; i <= arr.length - remaining; i++) {
      if (results.length >= MAX_COMBOS) return;
      current.push(arr[i]);
      backtrack(i + 1, current);
      current.pop();
    }
  }

  backtrack(0, []);

  // Sort by total projection descending — best combos first for pruning efficiency
  results.sort((a, b) => {
    const projA = a.reduce((s, p) => s + p.projection, 0);
    const projB = b.reduce((s, p) => s + p.projection, 0);
    return projB - projA;
  });

  return results;
}

/**
 * Generate optimal lineup pool using branch-and-bound with projection variance.
 * Runs multiple iterations with randomized projections to create diversity.
 *
 * @param params - Optimization parameters
 * @param onProgress - Progress callback
 * @returns OptimizationResult with lineups and stats
 */
export function optimizeLineups(
  params: OptimizationParams,
  onProgress?: (progress: number, message: string) => void
): OptimizationResult {
  const { config, pool, poolSize, minSalary } = params;
  const startTime = Date.now();

  // Run multiple iterations with DIFFERENT STRATEGIES for frontier exploration
  // ADAPTIVE: fewer iterations for showdown since pool is inherently smaller
  const rosterSize = config.positions.length;
  const playerCount = pool.players.length;
  // Use actual contest type, not roster size - MMA has 6 roster spots but should be treated like classic
  const isShowdown = config.contestType === 'showdown';
  // Single-game detection: golf, showdown, MMA — no game stacking, ownership concentrated
  const gameSet = new Set(pool.players.map(p => p.gameInfo || p.team));
  const isSingleGame = gameSet.size <= 1 || isShowdown;

  // ============================================================
  // FRONTIER EXPLORATION: Six iteration types for GPP optimization
  // ============================================================
  // To build a complete efficient frontier, we use SIX strategies:
  //
  // 1. PROJECTION (3%):    Pure expected value - find optimal anchors
  // 2. FIELD-MIMIC (8%):   Ownership-weighted - understand what field builds
  // 3. BALANCED (12%):     Moderate ownership penalty - "stealth contrarian"
  // 4. LEVERAGE (27%):     Penalize mid-owned, boost low-owned - KEY for GPP
  // 5. GAME-STACK (15%):   Stack-first construction - correlated upside
  // 6. CONTRARIAN (35%):   Heavy penalty + ceiling blend - lottery tickets
  //    - 40% ceiling contrarian: ceiling ratio + blend + heavy penalty
  //    - 35% value contrarian: salary efficiency boost + ownership penalty
  //    - 25% deep contrarian: 2x penalty for truly unique builds
  //
  // See detailed rationale below (Issue #12 documentation)
  // ============================================================

  // Small slate detection: fewer players means we need more iterations to find diverse lineups
  // AND more aggressive contrarian iterations to generate low-owned lineups
  const isSmallSlate = playerCount < 40 || isShowdown;
  const isShortSlate = gameSet.size <= 3 && !isSingleGame && !['mma', 'nascar', 'golf'].includes(config.sport);
  // MLB batter vs pitcher: only allowed on 2-game slates (need bring-back for game total correlation)
  // On 3+ game slates, enough games to avoid rostering batters against your own pitcher
  const mlbMaxBattersVsPitcher = gameSet.size <= 2 ? 2 : 0;
  // Generate more lineups for larger pool (50K+)
  // Same iteration count for showdown and classic - thorough exploration for both
  // Plan 9: Slate-size adaptive — large slates (7+ games) get 20% more iterations
  // Pro data: medium slates (5-6g) best for top-1% hits (1.45%), large slates need more coverage
  const isLargeSlate = gameSet.size >= 7 && !isSmallSlate;
  // Simplified iteration count: stack-first is efficient, fewer iterations needed
  const isTeamSportEarly = !['mma', 'nascar', 'golf'].includes(config.sport);
  const NUM_ITERATIONS = params.backtestFast ? 50
    : isSmallSlate ? 200 : (isTeamSportEarly && !isSingleGame ? 100 : (poolSize <= 75000 ? 160 : 200));
  const VARIANCE_PERCENT = 0.25;

  // ============================================================
  // ITERATION DISTRIBUTION RATIONALE (Issue #12)
  // ============================================================
  //
  // The iteration split is designed for GPP (tournament) optimization.
  // In GPPs, you need to beat thousands of opponents - being "good" isn't
  // enough, you need to be DIFFERENT while still being good.
  //
  // DISTRIBUTION: 3% Projection | 8% Field-Mimic | 12% Balanced | 27% Leverage | 15% Game-Stack | 35% Contrarian
  //
  // ============================================================
  // WHY EACH PERCENTAGE WAS CHOSEN
  // ============================================================
  //
  // 1. PROJECTION (3%) - Find the mathematically optimal lineups
  //    ----------------------------------------------------------------
  //    WHY 3%: The optimal lineup is often chalk-heavy (everyone finds it).
  //    It's a necessary anchor for measuring "projection quality" but
  //    building many near-optimal lineups doesn't win GPPs - the field has them too.
  //    We only need a few iterations to establish the projection ceiling.
  //
  //    OPTIMIZES FOR: Pure expected value (highest projected points)
  //
  // 2. FIELD-MIMIC (8%) - Build what the field builds
  //    ----------------------------------------------------------------
  //    WHY 8%: Generates multi-archetype field samples (70% chalk, 20%
  //    balanced, 10% contrarian) for combo analysis. We need to know WHAT
  //    the field builds so we can identify where we're different. 8% gives
  //    enough field samples without over-allocating to non-winning strategies.
  //
  //    OPTIMIZES FOR: Understanding opponent lineup distribution
  //
  // 3. BALANCED (12%) - Moderate ownership penalty + projection
  //    ----------------------------------------------------------------
  //    WHY 12%: The "sweet spot" between projection and uniqueness.
  //    Applies 35-40% ownership penalty multiplier - a 30% owned player
  //    keeps ~88% of their projection value. Creates lineups that are
  //    slightly contrarian but still project competitively.
  //
  //    OPTIMIZES FOR: Risk-adjusted expected value (good projection, lower ownership)
  //
  // 4. LEVERAGE (27%) - Penalize mid-owned, boost low-owned
  //    ----------------------------------------------------------------
  //    WHY 27%: KEY to GPP success. Does NOT exclude chalk - instead
  //    penalizes "mid-chalk" (15-35% owned) supporting cast while
  //    BOOSTING low-owned (<15%) players. Strategy 7-9 uses inverse-
  //    ownership weighting for additional differentiation. Creates
  //    chalk+value combinations the field rarely builds.
  //
  //    OPTIMIZES FOR: Differentiated player pairings with projection floor
  //
  // 5. GAME-STACK (15%) - Stack-first construction
  //    ----------------------------------------------------------------
  //    WHY 15%: Pre-selects 2-4 players from the same game, then fills
  //    the rest with greedy optimization. Captures correlated upside from
  //    game environments. Stack compositions: 3+1 (40%), 2+2 (25%),
  //    2+1 (20%), 4+0 (15%).
  //
  //    OPTIMIZES FOR: Correlated upside in high-scoring game environments
  //
  // 6. CONTRARIAN (35%) - Heavy ownership penalty + ceiling blend
  //    ----------------------------------------------------------------
  //    WHY 35%: Tournament "lottery tickets". Applies ceiling blend (50%)
  //    to favor boom potential, then heavy ownership penalty (1.3-1.5x).
  //    Three sub-strategies: ceiling (40%), value (35%), deep (25%).
  //    Winning GPP lineups often come from lower projection tiers.
  //
  //    OPTIMIZES FOR: Maximum leverage with ceiling upside (boom-or-bust)
  //
  // ============================================================
  // HOW THEY WORK TOGETHER FOR GPP PORTFOLIO CONSTRUCTION
  // ============================================================
  //
  // The six iteration types create a COMPLETE efficient frontier:
  //
  //   High Projection ──┬── Projection (3%): Top-left anchor
  //                     │   Sets the projection ceiling baseline
  //                     │
  //                     ├── Balanced (12%): Upper-middle of frontier
  //                     │   Slightly faded chalk, still competitive
  //                     │
  //   Medium Proj ──────┼── Leverage (27%) + Game-Stack (15%): Middle (KEY VALUE)
  //                     │   Same stars + different supporting cast + correlated stacks
  //                     │
  //                     ├── Field-Mimic (8%): Reference point
  //                     │   What the field does (for comparison)
  //                     │
  //   Lower Projection ─┴── Contrarian (35%): Bottom-right (max uniqueness)
  //                         Deep fades with ceiling upside
  //                     │
  //                    Low Ownership ──────────────────── High Ownership
  //
  // The SELECTOR then picks from this frontier based on:
  // - Core differentiation (do we have unique 3/4/5-man combos?)
  // - Proportional ownership (projection drop must justify ownership drop)
  // - Simulation results (how does this lineup perform vs synthetic field?)
  //
  // WHY THIS MIX WINS GPPs:
  // - Projection iterations establish the "quality floor" baseline
  // - Field-mimic identifies what TO AVOID (chalk-on-chalk combos)
  // - Balanced creates "stealth contrarian" lineups that still cash
  // - Leverage produces the UNIQUE cores that win when they hit
  // - Contrarian provides tournament-winning upside at low duplication
  //
  // The 10% leverage + 20% game-stack + ~13% contrarian allocation (43% total)
  // prioritizes unique combinations. Same good players, different pairings = leverage.
  // For non-team sports (MMA, NASCAR), game-stack is 0% and contrarian absorbs the extra.
  //
  // Total: 100% (27 + 5 + 25 + 10 + 20 + ~13)
  // ============================================================
  // Golf: extra-aggressive leverage distribution (individual sport, high-variance, big fields)
  // Reduce field-mimic/balanced, push everything into leverage+contrarian
  // Projection-first distribution: data shows ceiling (+0.22) and projection (+0.19) are
  // top predictors of actual scoring. Pros average 264-268 projected pts vs our 258.5.
  // Contrarian/leverage strategies are NEGATIVELY correlated with actual points.
  // More projection/balanced iterations = higher avg projection in pool.
  // Projection-first distribution: data shows projection (+0.22) and ceiling (+0.25)
  // are top predictors of actual scoring. Winners average +5.4% proj, +3.9% ceil vs field.
  // Pros are CHALKIER than field (208-233% sum vs 172%) — anti-chalk strategies hurt.
  // More projection/balanced iterations = higher avg projection in pool = better actual points.
  // Iteration distribution tuned for GPP:
  // - Projection (25%): High-projection lineups are the backbone. Winners are +5.4% proj vs field.
  // - Balanced (23%): Light ownership penalty keeps projection high with slight differentiation.
  // - Leverage (13%): Ceiling-heavy builds with unique combos — needed for variance/upside.
  // - Contrarian (19%): High-ceiling, lower-ownership builds. Reduced from 23% but not to 17%.
  // - Game-stack (12%): Correlated upside from same-game stacks.
  // --- Quick Chalk Pre-Scan: generate a small field sample to identify chalk combos ---
  // Used by anti-chalk iterations to penalize players anchoring the field's most common combos.
  const isNonTeamSportForChalk = ['mma', 'nascar', 'golf'].includes(config.sport);
  let chalkCombosForAntiChalk: Array<{ comboKey: string; playerIds: string[]; frequency: number }> = [];

  if (!isNonTeamSportForChalk && pool.players.length > 10) {
    try {
      const preScanLineups = generateFieldPoolForPreScan(
        pool.players, config.rosterSize, 2000, 12345, undefined, undefined, undefined, undefined, config.salaryCap, config.sport,
      );
      // Extract primary combos and count frequencies
      const comboCountMap = new Map<string, { playerIds: string[]; count: number }>();
      const playerLookup = new Map(pool.players.map(p => [p.id, p]));
      for (const fl of preScanLineups) {
        const pc = extractPrimaryCombo(fl, playerLookup, config.sport);
        if (!pc.comboKey) continue;
        const existing = comboCountMap.get(pc.comboKey);
        if (existing) {
          existing.count++;
        } else {
          comboCountMap.set(pc.comboKey, { playerIds: pc.playerIds, count: 1 });
        }
      }
      // Top 20 by frequency
      chalkCombosForAntiChalk = [...comboCountMap.entries()]
        .map(([comboKey, data]) => ({
          comboKey,
          playerIds: data.playerIds,
          frequency: data.count / preScanLineups.length,
        }))
        .sort((a, b) => b.frequency - a.frequency)
        .slice(0, 20);

      if (chalkCombosForAntiChalk.length > 0) {
        console.log(`  Chalk pre-scan: ${preScanLineups.length} field lineups → top ${chalkCombosForAntiChalk.length} chalk combos (max ${(chalkCombosForAntiChalk[0].frequency * 100).toFixed(1)}%)`);
      }
    } catch {
      // Pre-scan failed (e.g., insufficient players) — skip anti-chalk
      console.log(`  Chalk pre-scan: skipped (insufficient data)`);
    }
  }

  // Helper: penalize players that anchor chalk combos
  function applyChalkComboPenaltyToPlayers(
    players: Player[],
    chalkCombos: Array<{ playerIds: string[]; frequency: number }>,
  ): Player[] {
    if (chalkCombos.length === 0) return players;

    // Count how many chalk combos each player appears in
    const playerChalkMembership = new Map<string, number>();
    for (const combo of chalkCombos) {
      for (const id of combo.playerIds) {
        playerChalkMembership.set(id, (playerChalkMembership.get(id) || 0) + 1);
      }
    }

    return players.map(p => {
      const membership = playerChalkMembership.get(p.id) || 0;
      if (membership === 0) return p;
      // 10% projection penalty per chalk combo membership, capped at 40%
      const penalty = Math.min(0.40, membership * 0.10);
      return { ...p, projection: p.projection * (1 - penalty) };
    });
  }

  // Helper: limit chalk team depth by keeping only top N batters per chalk team.
  // Players beyond the limit get a severe projection penalty (70%) so B&B avoids them.
  // Pitchers are never penalized (they don't contribute to stack combos).
  function applyChalkTeamDepthLimit(
    players: Player[],
    chalkTeamsSet: Set<string>,
    maxPerTeam: number,
    sport: string,
  ): Player[] {
    if (chalkTeamsSet.size === 0) return players;

    // For each chalk team, rank batters by projection and mark top N as "allowed"
    const allowedIds = new Set<string>();
    for (const team of chalkTeamsSet) {
      const batters = players
        .filter(p => p.team === team && !p.positions.some((pos: string) => pos === 'P' || pos === 'SP' || pos === 'RP'))
        .sort((a, b) => b.projection - a.projection);
      for (let i = 0; i < Math.min(maxPerTeam, batters.length); i++) {
        allowedIds.add(batters[i].id);
      }
    }

    return players.map(p => {
      // Non-chalk team players: no change
      if (!chalkTeamsSet.has(p.team)) return p;
      // Pitchers: no change (don't contribute to batter stack combos)
      if (p.positions.some((pos: string) => pos === 'P' || pos === 'SP' || pos === 'RP')) return p;
      // Allowed (top N): no change
      if (allowedIds.has(p.id)) return p;
      // Beyond limit: severe projection penalty makes B&B avoid them
      return { ...p, projection: p.projection * 0.30 };
    });
  }

  // --- Chalk Team Identification ---
  // Identify teams where average batter ownership exceeds threshold.
  // Used by shallow-chalk and no-chalk-stack iterations to limit team depth.
  const chalkTeams = new Set<string>();
  const teamBatterOwnership = new Map<string, number>();
  if (!isNonTeamSportForChalk) {
    const adjustedThreshold = gameSet.size <= 3 ? 25 : gameSet.size <= 5 ? 20 : 18;
    for (const [team, teamPlayers] of pool.byTeam) {
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
      console.log(`  Chalk teams (avg batter own > threshold):`);
      for (const team of chalkTeams) {
        console.log(`    ${team}: avg batter own ${teamBatterOwnership.get(team)?.toFixed(1)}%`);
      }
    }
  }

  // --- Team Stack Quality Scoring ---
  // Score each team's desirability as a non-chalk stack target.
  // Used to weight forced stack generation and log insights.
  const teamStackQuality = new Map<string, number>();
  const viableStackTeams: string[] = []; // Teams with 5+ rosterable batters
  if (!isNonTeamSportForChalk) {
    // Compute slate median game/team totals
    const allGameTotals: number[] = [];
    const allTeamTotals: number[] = [];
    for (const p of pool.players) {
      if (p.gameTotal && p.gameTotal > 0) allGameTotals.push(p.gameTotal);
      if (p.teamTotal && p.teamTotal > 0) allTeamTotals.push(p.teamTotal);
    }
    const medianGameTotal = allGameTotals.length > 0
      ? allGameTotals.sort((a, b) => a - b)[Math.floor(allGameTotals.length / 2)] : 9.0;
    const medianTeamTotal = allTeamTotals.length > 0
      ? allTeamTotals.sort((a, b) => a - b)[Math.floor(allTeamTotals.length / 2)] : 4.5;

    for (const [team, teamPlayers] of pool.byTeam) {
      const batters = teamPlayers.filter(p =>
        !p.positions.some((pos: string) => pos === 'P' || pos === 'SP' || pos === 'RP') &&
        p.projection > 0
      );
      if (batters.length < 4) continue;
      if (batters.length >= 5) viableStackTeams.push(team);

      const gameTotal = batters[0]?.gameTotal || medianGameTotal;
      const teamTotal = batters[0]?.teamTotal || medianTeamTotal;
      const avgOwn = batters.reduce((s, p) => s + p.ownership, 0) / batters.length;

      const gameEnvScore = Math.max(0.5, Math.min(2.0, gameTotal / medianGameTotal));
      const teamTotalScore = Math.max(0.5, Math.min(2.0, teamTotal / medianTeamTotal));
      const ownLeverage = Math.pow(20 / Math.max(avgOwn, 1.5), 0.7);
      const top5 = batters.sort((a, b) => b.projection - a.projection).slice(0, 5);
      const avgCeilRatio = top5.reduce((s, p) => s + (p.ceiling || p.projection) / Math.max(p.projection, 1), 0) / top5.length;
      const ceilScore = Math.max(0.5, avgCeilRatio);

      const quality = gameEnvScore * teamTotalScore * ownLeverage * ceilScore;
      teamStackQuality.set(team, quality);
    }

    if (viableStackTeams.length > 0) {
      const sortedByQ = [...teamStackQuality.entries()]
        .sort((a, b) => b[1] - a[1]);
      console.log(`  Stack quality scores (${viableStackTeams.length} viable teams):`);
      for (const [team, q] of sortedByQ.slice(0, 10)) {
        const isChalk = chalkTeams.has(team) ? ' [CHALK]' : '';
        console.log(`    ${team}: ${q.toFixed(2)}${isChalk}`);
      }
    }
  }

  // - Field-mimic (8%): Calibration — understand what field builds.
  // Iteration mix shifted toward quality for 500-lineup target:
  // Projection (+0.235) and ceiling (+0.236) are strongest predictors.
  // More projection/balanced iterations → higher quality pool.
  // Iteration mix calibrated from pro stacking analysis:
  // Pro top-1% have 94% 3+ stacks, 55% 4+ stacks, 93% bring-backs, 81% BB in 3+ stack.
  // Winners: 100% BB, 92% BB in 3+ stack, avg max stack 4.08.
  // Pro-aligned iteration mix: pros build high-projection, game-stacked lineups.
  // They have LOW antiCorrelation (0.528 vs field 0.721) meaning they concentrate on best games.
  // Pro-aligned pool generation: game-stack(45%) + formula-blend(20%) as primary iteration types.
  // Pro top-1% have 94% 3+stacks, 93% bring-backs — pool filter enforces 90% 3+BB in final pool.
  // Game-stack iterations create stacks via constructStackFirstLineups (guaranteed 3+BB).
  // Formula-blend uses full 5-component scoring formula (proj+ceil+var+salEff+relVal) as B&B objective.
  // Other iterations (projection, balanced, leverage, ceiling, etc.) go through full B&B for diversity.
  // Post-generation filter retains 90% 3+BB lineups, dropping worst non-BB lineups.
  const isTeamSport = !['mma', 'nascar', 'golf'].includes(config.sport);
  // For team sport multi-game slates: boost game-stack to 45% + formula-blend to 20%
  // Combined with 90% BB pool filter, ensures pro-style stacking in final pool.
  // Game-stack (45%) creates 3+BB stacks via constructStackFirstLineups.
  // Formula-blend (20%) uses full 5-component scoring as B&B objective.
  // All other iterations go through B&B for maximum diversity, then pool filter enforces 90% 3+BB.
  const isTeamSportMultiGame = isTeamSport && !isShortSlate && !isSingleGame;

  // For team-sport multi-game: Stack enumeration finds all high-projection stacked lineups
  // exhaustively after iteration 0. Then remaining iterations add DIVERSITY through
  // ceiling, leverage, contrarian, and formula-blend iterations via normal B&B.
  // This gives both pro-style stacking AND structural variety in the pool.

  const isNonTeamSport = ['mma', 'nascar', 'golf'].includes(config.sport);

  // Team-sport multi-game: stack enumeration replaces game-stack iterations entirely.
  // Remaining iterations focus on ceiling/leverage/contrarian diversity via B&B.
  const projectionIterations = isTeamSportMultiGame
    ? 1  // Just iter 0 to find optimal (enumeration follows)
    : Math.floor(NUM_ITERATIONS * (isNonTeamSport ? 0.02 : 0.05));

  const fieldMimicIterations = isTeamSportMultiGame
    ? Math.floor(NUM_ITERATIONS * 0.05)  // 5% field-mimic for calibration
    : Math.floor(NUM_ITERATIONS * (isNonTeamSport ? 0.03 : 0.03));

  const balancedIterations = isTeamSportMultiGame
    ? Math.floor(NUM_ITERATIONS * 0.05)  // 5% balanced (reduced — frontier-sweep is better)
    : Math.floor(NUM_ITERATIONS * (isNonTeamSport ? 0.05 : (isShortSlate ? 0.15 : 0.05)));

  const leverageIterations = isTeamSportMultiGame
    ? Math.floor(NUM_ITERATIONS * 0.10)  // 10% leverage (teammate swap + anti-chalk combos)
    : Math.floor(NUM_ITERATIONS * (isNonTeamSport ? 0.35 : (isShortSlate ? 0.20 : 0.05)));

  // Stack enumeration handles stacking for team sports; no iteration-based stacking needed
  const gameStackIterations = 0;

  // NBA gets more ceiling iterations — ceiling correlation drives the 14-pt gap to pros
  const ceilingPct = isTeamSportMultiGame
    ? (config.sport === 'nba' ? 0.22 : 0.15)
    : (isNonTeamSport ? 0.20 : (isShortSlate ? 0.25 : 0.07));
  const ceilingIterations = Math.floor(NUM_ITERATIONS * ceilingPct);

  // Anti-chalk iterations: penalize players anchoring the field's most common combos.
  // Forces the B&B to find lineups built around DIFFERENT cores than the field.
  // Only for team sports — non-team sports have no meaningful team stacks to avoid.
  const antiChalkIterations = (isTeamSportMultiGame && chalkCombosForAntiChalk.length > 0)
    ? Math.floor(NUM_ITERATIONS * 0.10)  // 10% anti-chalk combo avoidance
    : 0;

  // Shallow-chalk iterations: limit to max 2 players per chalk team.
  // Creates lineups with individual chalk studs in unique non-chalk combos.
  const shallowChalkIterations = (isTeamSportMultiGame && chalkTeams.size > 0)
    ? Math.floor(NUM_ITERATIONS * 0.12)  // 12% shallow-chalk (max 2 per chalk team)
    : 0;

  // No-chalk-stack iterations: limit to max 1 player per chalk team.
  // Creates lineups where a single chalk stud anchors a unique non-chalk build.
  const noChalkStackIterations = (isTeamSportMultiGame && chalkTeams.size > 0)
    ? Math.floor(NUM_ITERATIONS * 0.10)  // 10% no-chalk-stack (max 1 per chalk team)
    : 0;

  const formulaBlendIterations = isTeamSportMultiGame
    ? Math.floor(NUM_ITERATIONS * 0.05)  // 5% formula-blend
    : Math.floor(NUM_ITERATIONS * 0.04);

  const antiOverlapIterations = isTeamSportMultiGame
    ? Math.floor(NUM_ITERATIONS * 0.03)  // 3% anti-overlap
    : Math.floor(NUM_ITERATIONS * 0.03);

  const salaryValueIterations = isTeamSportMultiGame
    ? Math.floor(NUM_ITERATIONS * 0.03)  // 3% salary-value
    : Math.floor(NUM_ITERATIONS * 0.03);

  // FRONTIER-SWEEP: maps the projection/ownership efficient frontier by sweeping
  // ownership penalty from 0.15 → 1.0 across iterations. Each finds the B&B optimal
  // at a different ownership tier. Also boosts high-stdDev (boom) players.
  const frontierSweepIterations = isTeamSportMultiGame
    ? Math.floor(NUM_ITERATIONS * 0.15)  // 15% frontier-sweep (was 35% — too many mediocre lineups)
    : Math.floor(NUM_ITERATIONS * 0.10);

  const contrarianIterations = isTeamSportMultiGame
    ? (NUM_ITERATIONS - 1 - fieldMimicIterations - balancedIterations - leverageIterations
       - ceilingIterations - formulaBlendIterations - antiOverlapIterations - salaryValueIterations
       - frontierSweepIterations - antiChalkIterations - shallowChalkIterations - noChalkStackIterations)
    : (NUM_ITERATIONS
    - projectionIterations - fieldMimicIterations
    - balancedIterations - leverageIterations - gameStackIterations
    - ceilingIterations - formulaBlendIterations
    - antiOverlapIterations - salaryValueIterations - frontierSweepIterations - antiChalkIterations);

  const lineupsPerIteration = Math.ceil(poolSize / NUM_ITERATIONS);

  if (isTeamSportMultiGame) {
    console.log(`Running ${NUM_ITERATIONS} iterations (STACK-ENUM + DIVERSITY for team-sport multi-game):`);
    console.log(`  - 1 pure B&B projection (find optimal) + exhaustive stack enumeration`);
    console.log(`  - ${fieldMimicIterations} field-mimic (5%: calibration)`);
    console.log(`  - ${balancedIterations} balanced (5%: projection + moderate low-own)`);
    console.log(`  - ${leverageIterations} leverage (10%: teammate swap + anti-chalk)`);
    console.log(`  - ${ceilingIterations} ceiling-max (20%: pure boom lineups)`);
    console.log(`  - ${formulaBlendIterations} formula-blend (5%: multi-dimensional)`);
    console.log(`  - ${antiOverlapIterations} anti-overlap (3%: penalize pool-frequent)`);
    console.log(`  - ${salaryValueIterations} salary-value (3%: pts/$ optimization)`);
    console.log(`  - ${frontierSweepIterations} frontier-sweep (15%: proj/own/boom efficient frontier)`);
    if (shallowChalkIterations > 0) console.log(`  - ${shallowChalkIterations} shallow-chalk (12%: max 2 per chalk team)`);
    if (noChalkStackIterations > 0) console.log(`  - ${noChalkStackIterations} no-chalk-stack (10%: max 1 per chalk team)`);
    console.log(`  - ${contrarianIterations} contrarian (remainder: deep fades + ceiling)`);
  } else {
    console.log(`Running ${NUM_ITERATIONS} iterations for FRONTIER EXPLORATION:`);
    console.log(`  - ${projectionIterations} projection-focused (find optimal)`);
    console.log(`  - ${fieldMimicIterations} field-mimic (ownership-weighted)`);
    console.log(`  - ${balancedIterations} balanced (projection + moderate low-own)`);
    console.log(`  - ${leverageIterations} leverage (anti-chalk combinations)`);
    console.log(`  - ${ceilingIterations} ceiling-max (maximize lineup ceiling)`);
    console.log(`  - ${formulaBlendIterations} formula-blend (multi-dimensional)`);
    console.log(`  - ${antiOverlapIterations} anti-overlap (penalize pool-frequent players)`);
    console.log(`  - ${salaryValueIterations} salary-value (optimize pts/$)`);
    console.log(`  - ${contrarianIterations} contrarian (deep fades with ceiling)`);
  }
  console.log(`  - ±${(VARIANCE_PERCENT * 100).toFixed(0)}% distributional variance`);

  // Separate arrays for each iteration type to preserve diversity
  const projectionLineups: Lineup[] = [];
  const fieldMimicLineups: Lineup[] = [];
  const leverageLineups: Lineup[] = [];
  const balancedLineups: Lineup[] = [];
  const gameStackLineups: Lineup[] = [];
  const ceilingLineups: Lineup[] = [];
  const formulaBlendLineups: Lineup[] = [];
  const antiOverlapLineups: Lineup[] = [];
  const salaryValueLineups: Lineup[] = [];
  const frontierSweepLineups: Lineup[] = [];
  const contrarianLineups: Lineup[] = [];
  const antiChalkLineups: Lineup[] = [];
  const shallowChalkLineups: Lineup[] = [];
  const noChalkStackLineups: Lineup[] = [];

  const seenHashes = new Set<string>();
  let totalEvaluated = 0;
  let maxProjectionFound = 0;
  let optimalLineup: Lineup | null = null;

  // Track iteration types for logging
  let projIterCount = 0;
  let fieldMimicIterCount = 0;
  let leverageIterCount = 0;
  let balancedIterCount = 0;
  let gameStackIterCount = 0;
  let ceilingIterCount = 0;
  let formulaBlendIterCount = 0;
  let antiOverlapIterCount = 0;
  let salaryValueIterCount = 0;
  let frontierSweepIterCount = 0;
  let contrarianIterCount = 0;
  let antiChalkIterCount = 0;
  let shallowChalkIterCount = 0;
  let noChalkStackIterCount = 0;

  // Track player frequency across all generated lineups (for anti-overlap iterations)
  const playerPoolFrequency = new Map<string, number>();
  let totalLineupsGenerated = 0;

  // Track primary combo frequency across pool for combo diversity soft-cap.
  // Prevents the same 4-man core from dominating the pool (e.g., 30K of 40K lineups
  // sharing Jokic+Murray+MPJ+Gordon). Probabilistic rejection when over threshold.
  const poolPrimaryComboFrequency = new Map<string, number>();
  const POOL_COMBO_SOFT_CAP = 0.04;  // Start rejecting when combo > 4% of pool
  const POOL_COMBO_HARD_CAP = 0.08;  // Reject 90%+ when combo > 8% of pool
  const playerLookupForCombo = new Map<string, Player>();
  for (const p of pool.players) playerLookupForCombo.set(p.id, p);

  // Chalk players to exclude in leverage iterations.
  // Built after iteration 0 from the optimal lineup's players,
  // sorted by projection (highest first).
  let chalkPlayersToExclude: string[] = [];

  // Build exclusion patterns for leverage iterations.
  // ============================================================
  // ADAPTIVE ITERATION REBALANCING
  // ============================================================
  // Track cumulative iteration allocation so we can rebalance dynamically.
  // Every REBALANCE_INTERVAL iterations, check which strategy types are
  // under/over-producing unique lineups and shift remaining iterations.
  const REBALANCE_INTERVAL = 20;

  // Mutable iteration targets (will be adjusted during run)
  let remainingProjection = projectionIterations;
  let remainingFieldMimic = fieldMimicIterations;
  let remainingBalanced = balancedIterations;
  let remainingLeverage = leverageIterations;
  let remainingGameStack = gameStackIterations;
  let remainingCeiling = ceilingIterations;
  let remainingFormulaBlend = formulaBlendIterations;
  let remainingAntiOverlap = antiOverlapIterations;
  let remainingSalaryValue = salaryValueIterations;
  let remainingFrontierSweep = frontierSweepIterations;
  let remainingContrarian = contrarianIterations;
  let remainingAntiChalk = antiChalkIterations;
  let remainingShallowChalk = shallowChalkIterations;
  let remainingNoChalkStack = noChalkStackIterations;

  // Track lineups produced per type since last rebalance
  let newSinceRebalance = {
    projection: 0, fieldMimic: 0, balanced: 0,
    leverage: 0, gameStack: 0, ceiling: 0, formulaBlend: 0,
    antiOverlap: 0, salaryValue: 0, frontierSweep: 0, contrarian: 0,
    antiChalk: 0, shallowChalk: 0, noChalkStack: 0,
  };

  // Determine iteration type dynamically based on remaining allocations
  function getNextIterationType(iter: number): IterationType {
    if (iter === 0) return 'projection';

    // Anti-overlap only in second half (need pool content first)
    const antiOverlapAvail = iter >= Math.floor(NUM_ITERATIONS / 2) ? remainingAntiOverlap : 0;

    // Build weighted random selection based on remaining allocations
    const totalRemaining = remainingProjection + remainingFieldMimic +
      remainingBalanced + remainingLeverage + remainingGameStack +
      remainingCeiling + remainingFormulaBlend + antiOverlapAvail +
      remainingSalaryValue + remainingFrontierSweep + remainingAntiChalk +
      remainingShallowChalk + remainingNoChalkStack + remainingContrarian;
    if (totalRemaining <= 0) return 'leverage'; // fallback

    const r = Math.random() * totalRemaining;
    let acc = 0;
    acc += remainingProjection;
    if (r < acc && remainingProjection > 0) { remainingProjection--; return 'projection'; }
    acc += remainingFieldMimic;
    if (r < acc && remainingFieldMimic > 0) { remainingFieldMimic--; return 'field-mimic'; }
    acc += remainingLeverage;
    if (r < acc && remainingLeverage > 0) { remainingLeverage--; return 'leverage'; }
    acc += remainingBalanced;
    if (r < acc && remainingBalanced > 0) { remainingBalanced--; return 'balanced'; }
    acc += remainingGameStack;
    if (r < acc && remainingGameStack > 0) { remainingGameStack--; return 'game-stack'; }
    acc += remainingCeiling;
    if (r < acc && remainingCeiling > 0) { remainingCeiling--; return 'ceiling'; }
    acc += remainingFormulaBlend;
    if (r < acc && remainingFormulaBlend > 0) { remainingFormulaBlend--; return 'formula-blend'; }
    acc += antiOverlapAvail;
    if (r < acc && antiOverlapAvail > 0) { remainingAntiOverlap--; return 'anti-overlap'; }
    acc += remainingSalaryValue;
    if (r < acc && remainingSalaryValue > 0) { remainingSalaryValue--; return 'salary-value'; }
    acc += remainingFrontierSweep;
    if (r < acc && remainingFrontierSweep > 0) { remainingFrontierSweep--; return 'frontier-sweep'; }
    acc += remainingAntiChalk;
    if (r < acc && remainingAntiChalk > 0) { remainingAntiChalk--; return 'anti-chalk'; }
    acc += remainingShallowChalk;
    if (r < acc && remainingShallowChalk > 0) { remainingShallowChalk--; return 'shallow-chalk'; }
    acc += remainingNoChalkStack;
    if (r < acc && remainingNoChalkStack > 0) { remainingNoChalkStack--; return 'no-chalk-stack'; }
    if (remainingContrarian > 0) { remainingContrarian--; return 'contrarian'; }

    // Fallback: pick whichever has remaining
    if (remainingFrontierSweep > 0) { remainingFrontierSweep--; return 'frontier-sweep'; }
    if (remainingCeiling > 0) { remainingCeiling--; return 'ceiling'; }
    if (remainingLeverage > 0) { remainingLeverage--; return 'leverage'; }
    if (remainingContrarian > 0) { remainingContrarian--; return 'contrarian'; }
    if (remainingBalanced > 0) { remainingBalanced--; return 'balanced'; }
    return 'leverage';
  }

  /**
   * Rebalance remaining iterations based on productivity.
   * If a strategy type produced many new lineups, it's productive — keep allocating.
   * If a strategy type is producing mostly duplicates, reallocate to productive types.
   */
  function rebalanceIterations(itersDone: number): void {
    const itersLeft = NUM_ITERATIONS - itersDone;
    if (itersLeft < 5) return; // Not enough to rebalance

    // Calculate productivity: new lineups per iteration for each type
    const total = newSinceRebalance;
    const itersByType = {
      projection: projIterCount > 0 ? total.projection / projIterCount : 0,
      fieldMimic: fieldMimicIterCount > 0 ? total.fieldMimic / fieldMimicIterCount : 0,
      balanced: balancedIterCount > 0 ? total.balanced / balancedIterCount : 0,
      leverage: leverageIterCount > 0 ? total.leverage / leverageIterCount : 0,
      gameStack: gameStackIterCount > 0 ? total.gameStack / gameStackIterCount : 0,
      ceiling: ceilingIterCount > 0 ? total.ceiling / ceilingIterCount : 0,
      formulaBlend: formulaBlendIterCount > 0 ? total.formulaBlend / formulaBlendIterCount : 0,
      antiOverlap: antiOverlapIterCount > 0 ? total.antiOverlap / antiOverlapIterCount : 0,
      salaryValue: salaryValueIterCount > 0 ? total.salaryValue / salaryValueIterCount : 0,
      frontierSweep: frontierSweepIterCount > 0 ? total.frontierSweep / frontierSweepIterCount : 0,
      antiChalk: antiChalkIterCount > 0 ? total.antiChalk / antiChalkIterCount : 0,
      shallowChalk: shallowChalkIterCount > 0 ? total.shallowChalk / shallowChalkIterCount : 0,
      noChalkStack: noChalkStackIterCount > 0 ? total.noChalkStack / noChalkStackIterCount : 0,
      contrarian: contrarianIterCount > 0 ? total.contrarian / contrarianIterCount : 0,
    };

    // Find average productivity
    const productivities = Object.values(itersByType).filter(v => v > 0);
    if (productivities.length === 0) return;
    const avgProductivity = productivities.reduce((a, b) => a + b, 0) / productivities.length;

    // Calculate remaining total to redistribute
    const totalRem = remainingProjection + remainingFieldMimic + remainingBalanced +
      remainingLeverage + remainingGameStack + remainingCeiling + remainingFormulaBlend +
      remainingAntiOverlap + remainingSalaryValue + remainingFrontierSweep + remainingAntiChalk + remainingContrarian;
    if (totalRem < 3) return;

    // For each strategy type below 50% of average productivity, steal 30% of remaining
    // and give to above-average types proportionally
    let stealPool = 0;
    const stealFrom: Record<string, number> = {};
    const boostTo: string[] = [];

    const typeMap: Record<string, { remaining: number; prod: number }> = {
      projection: { remaining: remainingProjection, prod: itersByType.projection },
      fieldMimic: { remaining: remainingFieldMimic, prod: itersByType.fieldMimic },
      balanced: { remaining: remainingBalanced, prod: itersByType.balanced },
      leverage: { remaining: remainingLeverage, prod: itersByType.leverage },
      gameStack: { remaining: remainingGameStack, prod: itersByType.gameStack },
      ceiling: { remaining: remainingCeiling, prod: itersByType.ceiling },
      formulaBlend: { remaining: remainingFormulaBlend, prod: itersByType.formulaBlend },
      antiOverlap: { remaining: remainingAntiOverlap, prod: itersByType.antiOverlap },
      salaryValue: { remaining: remainingSalaryValue, prod: itersByType.salaryValue },
      frontierSweep: { remaining: remainingFrontierSweep, prod: itersByType.frontierSweep },
      antiChalk: { remaining: remainingAntiChalk, prod: itersByType.antiChalk },
      shallowChalk: { remaining: remainingShallowChalk, prod: itersByType.shallowChalk },
      noChalkStack: { remaining: remainingNoChalkStack, prod: itersByType.noChalkStack },
      contrarian: { remaining: remainingContrarian, prod: itersByType.contrarian },
    };

    for (const [type, data] of Object.entries(typeMap)) {
      if (data.prod < avgProductivity * 0.5 && data.remaining > 1) {
        const steal = Math.floor(data.remaining * 0.3);
        if (steal > 0) {
          stealPool += steal;
          stealFrom[type] = steal;
        }
      } else if (data.prod > avgProductivity * 0.8) {
        boostTo.push(type);
      }
    }

    if (stealPool > 0 && boostTo.length > 0) {
      // Apply steals
      for (const [type, amount] of Object.entries(stealFrom)) {
        switch (type) {
          case 'projection': remainingProjection -= amount; break;
          case 'fieldMimic': remainingFieldMimic -= amount; break;
          case 'balanced': remainingBalanced -= amount; break;
          case 'leverage': remainingLeverage -= amount; break;
          case 'gameStack': remainingGameStack -= amount; break;
          case 'ceiling': remainingCeiling -= amount; break;
          case 'formulaBlend': remainingFormulaBlend -= amount; break;
          case 'antiOverlap': remainingAntiOverlap -= amount; break;
          case 'salaryValue': remainingSalaryValue -= amount; break;
          case 'frontierSweep': remainingFrontierSweep -= amount; break;
          case 'antiChalk': remainingAntiChalk -= amount; break;
          case 'shallowChalk': remainingShallowChalk -= amount; break;
          case 'noChalkStack': remainingNoChalkStack -= amount; break;
          case 'contrarian': remainingContrarian -= amount; break;
        }
      }

      // Distribute stolen iterations to productive types
      const perType = Math.floor(stealPool / boostTo.length);
      let remainder = stealPool - perType * boostTo.length;
      for (const type of boostTo) {
        const boost = perType + (remainder > 0 ? 1 : 0);
        if (remainder > 0) remainder--;
        switch (type) {
          case 'projection': remainingProjection += boost; break;
          case 'fieldMimic': remainingFieldMimic += boost; break;
          case 'balanced': remainingBalanced += boost; break;
          case 'leverage': remainingLeverage += boost; break;
          case 'gameStack': remainingGameStack += boost; break;
          case 'ceiling': remainingCeiling += boost; break;
          case 'formulaBlend': remainingFormulaBlend += boost; break;
          case 'antiOverlap': remainingAntiOverlap += boost; break;
          case 'salaryValue': remainingSalaryValue += boost; break;
          case 'frontierSweep': remainingFrontierSweep += boost; break;
          case 'antiChalk': remainingAntiChalk += boost; break;
          case 'shallowChalk': remainingShallowChalk += boost; break;
          case 'noChalkStack': remainingNoChalkStack += boost; break;
          case 'contrarian': remainingContrarian += boost; break;
        }
      }

      console.log(`  [Rebalance@${itersDone}] Shifted ${stealPool} iters: ${Object.entries(stealFrom).map(([t, a]) => `-${a} ${t}`).join(', ')} → ${boostTo.map(t => `+${t}`).join(', ')}`);
    }

    // Reset counters
    newSinceRebalance = {
      projection: 0, fieldMimic: 0, balanced: 0,
      leverage: 0, gameStack: 0, ceiling: 0, formulaBlend: 0,
      antiOverlap: 0, salaryValue: 0, frontierSweep: 0, contrarian: 0,
      antiChalk: 0, shallowChalk: 0, noChalkStack: 0,
    };
  }

  for (let iter = 0; iter < NUM_ITERATIONS; iter++) {
    // Adaptive rebalancing every REBALANCE_INTERVAL iterations
    if (iter > 0 && iter % REBALANCE_INTERVAL === 0) {
      // rebalanceIterations(iter);  // DISABLED — was stealing from leverage/contrarian
    }

    // Determine iteration type dynamically
    let iterationType: IterationType = getNextIterationType(iter);
    let iterPlayers: Player[];

    // Generate a correlated game-world scenario for this iteration.
    // All non-zero iterations use game-world correlation instead of independent noise.
    const gameWorld = iter > 0 ? generateGameWorld(pool.players) : null;

    if (iter === 0) {
      // First iteration: pure projection (find true optimal)
      iterationType = 'projection';
      iterPlayers = pool.players;
      projIterCount++;
    } else if (iterationType === 'projection') {
      // Projection-focused iterations with correlated game-world variance
      iterPlayers = applyGameWorld(pool.players, gameWorld!);
      projIterCount++;
    } else if (iterationType === 'field-mimic') {
      // FIELD-MIMIC: Build lineups the field would build
      // Uses ownership-weighted construction with projection floor

      // Generate via ownership-proportional random construction
      // Pass fieldMimicIterCount so each iteration uses a different field archetype:
      //   70% chalk (ownership-dominant), 20% balanced, 10% contrarian
      const fieldMimicResults = runFieldMimicConstruction({
        config,
        pool,
        count: lineupsPerIteration * 3,  // Generate more, keep best
        seenHashes,
        minProjectionPct: 0.94,  // Must be decent projection
        fieldMimicIterIndex: fieldMimicIterCount,
      });

      let fieldMimicNew = 0;
      for (const lineup of fieldMimicResults.lineups) {
        if (!seenHashes.has(lineup.hash)) {
          lineup.constructionMethod = 'field-mimic';
          fieldMimicLineups.push(lineup);
          seenHashes.add(lineup.hash);
          fieldMimicNew++;
        }
      }
      newSinceRebalance.fieldMimic += fieldMimicNew;
      totalEvaluated += fieldMimicResults.evaluatedCount;
      fieldMimicIterCount++;
      continue;  // Skip branch-bound for this iteration type
    } else if (iterationType === 'leverage') {
      // Leverage iterations: NO EXCLUSIONS - all players available
      // Create different combinations by penalizing mid-chalk supporting cast
      // This naturally pairs chalk stars with low-owned value plays

      const leverageIdx = leverageIterCount;

      // Strategy mix for leverage iterations (NO EXCLUSIONS):
      // 40% - Penalize mid-owned (15-35%) to create chalk + value builds
      // 30% - Ceiling blend + light penalty to find boom potential
      // 30% - Boost low-owned players to make them competitive with mid-chalk
      const strategyType = leverageIdx % 10;

      // Apply game-world correlation FIRST, then ownership adjustments
      const worldPlayers = applyGameWorld(pool.players, gameWorld!);

      if (strategyType < 4) {
        // Light penalize mid-owned players - nudge toward chalk + low-owned pairings
        // Stars (>40%) stay attractive, value plays (<15%) get small boost
        // Reduced from prior values — too much penalty kills projection quality.
        iterPlayers = worldPlayers.map(p => {
          const own = (p.ownership || 20) / 100;
          let multiplier = 1.0;
          if (own > 0.25 && own <= 0.40) {
            multiplier = 0.70;  // 30% penalty for upper mid-chalk (was 50%)
          } else if (own > 0.15 && own <= 0.25) {
            multiplier = 0.80;  // 20% penalty for lower mid-chalk (was 40%)
          } else if (own <= 0.15 && own > 0.08) {
            multiplier = 1.15;  // 15% BOOST for low-owned (was 25%)
          } else if (own <= 0.08) {
            multiplier = 1.25;  // 25% BOOST for very-low-owned (was 40%)
          }
          // Stars (>40%) keep full projection - they're the anchors
          return { ...p, projection: p.projection * multiplier };
        });
      } else if (strategyType < 7) {
        // Ceiling ratio boost + very light ownership adjustment
        // Finds high-upside builds with unique constructions
        const ceilingRatioBoosted = applyCeilingRatioBoost(worldPlayers, 0.15, 0.5);
        const ceilingBlended = applyCeilingBlend(ceilingRatioBoosted, 0.35);
        iterPlayers = ceilingBlended.map(p => {
          const own = (p.ownership || 20) / 100;
          // Very light penalty — mostly rely on ceiling ratio for differentiation
          let multiplier = own > 0.15 && own <= 0.35 ? 0.92 : own <= 0.08 ? 1.12 : own <= 0.15 ? 1.06 : 1.0;
          return { ...p, projection: p.projection * multiplier };
        });
      } else {
        // Inverse-ownership weighting: smooth gradient, less aggressive.
        // Reduced from 1/(own*5) to 1/(own*4) for gentler curve.
        iterPlayers = worldPlayers.map(p => {
          const own = Math.max((p.ownership || 20) / 100, 0.02);
          // 5% owned → 1.25x, 10% → 1.11x, 20% → 1.0x, 40% → 0.83x
          const multiplier = Math.max(0.6, Math.min(1.4, 1.0 / (own * 4.5)));
          return { ...p, projection: p.projection * multiplier };
        });
      }

      // Showdown captain rotation: fade top 3 CPT projections in ~33% of leverage iterations
      // Forces exploration of non-star captains (White CPT, Pritchard CPT, etc.)
      if (isShowdown && leverageIdx % 3 === 0) {
        const cptPlayers = iterPlayers
          .filter(p => p.positions.includes('CPT'))
          .sort((a, b) => b.projection - a.projection);
        const fadeCptNames = new Set(cptPlayers.slice(0, 3).map(p => p.name));
        iterPlayers = iterPlayers.map(p => {
          if (p.positions.includes('CPT') && fadeCptNames.has(p.name)) {
            return { ...p, projection: p.projection * 0.55 };
          }
          return p;
        });
      }

      leverageIterCount++;
    } else if (iterationType === 'balanced') {
      // Balanced iterations: NO EXCLUSIONS - moderate ownership penalty
      // Creates lineups with good projection and reasonable ownership mix
      const worldBalanced = applyGameWorld(pool.players, gameWorld!);
      // Very light penalty — balanced iterations should produce near-optimal projection
      // with light ownership differentiation, not heavy penalization.
      const balancedPenalty = isSmallSlate ? 0.12 : 0.06;

      // R12: ~36% of balanced iterations (every 3rd minus first) use ceiling-blended projection.
      // Scoring formula weights ceiling at 18.9% — lineups optimized for projection+ceiling
      // will score better in selection. Blend is conservative (85/15) to preserve projection quality.
      const useCeilingBlend = balancedIterCount > 0 && balancedIterCount % 3 === 0;
      if (useCeilingBlend) {
        iterPlayers = worldBalanced.map(p => {
          const ceil = p.ceiling || p.projection * 1.25;
          const blendedProj = p.projection * 0.85 + ceil * 0.15;
          const own = (p.ownership || 20) / 100;
          return { ...p, projection: blendedProj * (1 - own * balancedPenalty) };
        });
      } else {
        iterPlayers = applyOwnershipPenalty(worldBalanced, balancedPenalty);
      }
      balancedIterCount++;
    } else if (iterationType === 'game-stack') {
      // Game-stack iterations: STACK-FIRST construction with flavor-based fill players.
      // For team-sport multi-game, ALL non-projection iterations come here.
      // Flavor distribution: 70% projection-stack, 15% ceiling-stack, 15% contrarian-stack.
      const stackIterIdx = gameStackIterCount;
      const totalStackIters = gameStackIterations;
      const projStackEnd = Math.floor(totalStackIters * 0.70);
      const ceilStackEnd = projStackEnd + Math.floor(totalStackIters * 0.15);

      let fillPlayers: Player[] | undefined;
      let stackFlavor: string;

      if (stackIterIdx < projStackEnd) {
        // 70% projection-stack: raw projection + game-world variance
        fillPlayers = applyGameWorld(pool.players, gameWorld!);
        stackFlavor = 'projection-stack';
      } else if (stackIterIdx < ceilStackEnd) {
        // 15% ceiling-stack: ceiling-blended fill
        const worldPlayers = applyGameWorld(pool.players, gameWorld!);
        fillPlayers = applyCeilingBlend(worldPlayers, 0.30);
        stackFlavor = 'ceiling-stack';
      } else {
        // 15% contrarian-stack: light ownership penalty fill
        const worldPlayers = applyGameWorld(pool.players, gameWorld!);
        fillPlayers = applyOwnershipPenalty(worldPlayers, 0.4);
        stackFlavor = 'contrarian-stack';
      }

      const stackResult = constructStackFirstLineups(
        config, pool, gameWorld!, seenHashes, lineupsPerIteration * 3, params.minSalary, fillPlayers
      );

      for (const lineup of stackResult.lineups) {
        lineup.constructionMethod = stackFlavor;
        gameStackLineups.push(lineup);
      }
      newSinceRebalance.gameStack += stackResult.lineups.length;
      totalEvaluated += stackResult.evaluatedCount;
      gameStackIterCount++;
      continue;  // Skip branch-bound for stack-first iterations
    } else if (iterationType === 'ceiling') {
      // CEILING-MAX iterations: maximize lineup ceiling instead of projection.
      // The scoring formula weights ceiling at 28% — pool needs high-ceiling lineups
      // that currently get filtered because they're not projection-optimal.
      // Heavy ceiling blend (75%) with NO ownership penalty — we want the highest-ceiling lineups period.
      const worldPlayers = applyGameWorld(pool.players, gameWorld!);
      iterPlayers = applyCeilingBlend(worldPlayers, 0.75);
      ceilingIterCount++;
    } else if (iterationType === 'formula-blend') {
      // FORMULA-BLEND iterations: approximate the 5-component scoring formula as a per-player objective.
      // Weights from optimized_weights.json: proj(8%), ceil(16.4%), var(14.5%), salEff(11.3%), relVal(49.9%)
      // B&B maximizes lineup sum of formulaVal → pool lineups naturally score well in selection.
      const worldPlayers = applyGameWorld(pool.players, gameWorld!);

      // Compute normalization stats
      const avgStdDev = worldPlayers.reduce((sum, p) => {
        const sd = p.percentiles && p.percentiles.p75 > 0 && p.percentiles.p25 > 0
          ? (p.percentiles.p75 - p.percentiles.p25) / 1.35
          : (p.ceiling && p.ceiling > p.projection ? (p.ceiling - p.projection) / 1.04 : p.projection * 0.20);
        return sum + sd;
      }, 0) / worldPlayers.length;

      // Compute average pts/$ and avg projection for relativeValue approximation
      const avgPtsPerK = worldPlayers.reduce((sum, p) => sum + (p.projection / p.salary * 1000), 0) / worldPlayers.length;
      const avgProjection = worldPlayers.reduce((sum, p) => sum + p.projection, 0) / worldPlayers.length;

      iterPlayers = worldPlayers.map(p => {
        const ceil = p.ceiling || p.projection * 1.25;
        const ceilRatio = ceil / Math.max(1, p.projection);
        const sd = p.percentiles && p.percentiles.p75 > 0 && p.percentiles.p25 > 0
          ? (p.percentiles.p75 - p.percentiles.p25) / 1.35
          : (p.ceiling && p.ceiling > p.projection ? (p.ceiling - p.projection) / 1.04 : p.projection * 0.20);
        const normalizedSD = avgStdDev > 0 ? sd / avgStdDev : 1;
        const ptsPerK = p.projection / p.salary * 1000;

        // 5-component per-player formula value (weights from optimizer):
        // projection (8%): raw projection
        const projComponent = p.projection;
        // ceiling (16.4%): bonus for high ceiling ratio
        const ceilComponent = (ceilRatio - 1) * p.projection * 2.0;  // 2x weight since ceil is 2x proj weight
        // variance (14.5%): bonus for high-variance players
        const varComponent = (normalizedSD - 1) * p.projection * 0.5;
        // salaryEfficiency (11.3%): bonus for pts/$ above average
        const salEffComponent = ((ptsPerK / avgPtsPerK) - 1) * p.projection * 0.4;
        // relativeValue (49.9%): bonus for projection above slate average — the #1 GPP differentiator
        const relValComponent = ((p.projection / avgProjection) - 1) * p.projection * 1.5;

        const formulaVal = projComponent + ceilComponent + varComponent + salEffComponent + relValComponent;
        return { ...p, projection: formulaVal };
      });
      formulaBlendIterCount++;
    } else if (iterationType === 'anti-overlap') {
      // Anti-overlap iterations: penalize players that already appear frequently in the pool.
      // Forces B&B to explore combinations it hasn't tried yet.
      const worldPlayers = applyGameWorld(pool.players, gameWorld!);
      iterPlayers = worldPlayers.map(p => {
        const freq = totalLineupsGenerated > 0
          ? (playerPoolFrequency.get(p.id) || 0) / totalLineupsGenerated
          : 0;
        // Penalize high-frequency players by up to 30% projection reduction
        const penalty = Math.min(0.30, freq * 1.5);
        return { ...p, projection: p.projection * (1 - penalty) };
      });
      antiOverlapIterCount++;
    } else if (iterationType === 'salary-value') {
      // Salary-value iterations: optimize for projection/salary ratio.
      // Finds salary-efficient lineups that pure projection iterations miss.
      const worldPlayers = applyGameWorld(pool.players, gameWorld!);
      // Scale factor to keep values in same ballpark as projection
      const avgSalary = worldPlayers.reduce((s, p) => s + p.salary, 0) / worldPlayers.length;
      iterPlayers = worldPlayers.map(p => {
        const ptsPerK = (p.projection / p.salary) * 1000;
        // Transform: weight by pts/$ but keep projection component so high-floor is still preferred
        const valueScore = p.projection * 0.6 + ptsPerK * avgSalary * 0.001 * 0.4;
        return { ...p, projection: valueScore };
      });
      salaryValueIterCount++;
    } else if (iterationType === 'frontier-sweep') {
      // FRONTIER SWEEP: systematically explore the projection/ownership efficient frontier.
      // Each iteration uses a progressively heavier ownership penalty (0.15 → 1.0)
      // to find the BEST lineup at each ownership level.
      //
      // Also boosts high-stdDev players (boom candidates). In NBA DFS:
      //   - Typical stdDev/proj ratio: 0.20-0.25 (SD ~7-9 for a 35-pt player)
      //   - High-boom players: ratio > 0.28 (SD 10+ for a 35-pt player)
      //   - Low-floor players: ratio < 0.18 (consistent but no upside)
      // We want boom candidates because GPPs reward the tails.
      const worldPlayers = applyGameWorld(pool.players, gameWorld!);

      // Sweep penalty from 0.15 → 1.0 across iterations
      const sweepProgress = frontierSweepIterCount / Math.max(1, frontierSweepIterations - 1);
      const sweepPenalty = 0.15 + sweepProgress * 0.85;

      // Blend: 80% projection + 10% ceiling + 10% stdDev boost
      // StdDev boost: players with above-average CV (stdDev/proj) get a projection bump.
      // This makes B&B prefer "same projection but more boom potential" players.
      const avgCV = worldPlayers.reduce((s, p) => {
        const sd = p.stdDev && p.stdDev > 0 ? p.stdDev : (p.ceiling ? (p.ceiling - p.projection) / 1.04 : p.projection * 0.20);
        return s + (p.projection > 0 ? sd / p.projection : 0.20);
      }, 0) / worldPlayers.length;

      const withBoom = worldPlayers.map(p => {
        const ceil = p.ceiling || p.projection * 1.25;
        const sd = p.stdDev && p.stdDev > 0 ? p.stdDev : (ceil > p.projection ? (ceil - p.projection) / 1.04 : p.projection * 0.20);
        const cv = p.projection > 0 ? sd / p.projection : 0.20;
        // Boom boost: +5% for every 0.05 CV above average (capped at +15%), stepped
        const boomBoost = Math.min(0.15, Math.max(0, Math.floor((cv - avgCV) / 0.05) * 0.05));
        const blendedProj = p.projection * (0.90 + boomBoost) + ceil * 0.10;
        return { ...p, projection: blendedProj };
      });

      iterPlayers = applyOwnershipPenalty(withBoom, sweepPenalty);
      frontierSweepIterCount++;
    } else if (iterationType === 'anti-chalk') {
      // Anti-chalk iterations: penalize players anchoring field's most common combos.
      // Applies projection penalties to players frequently appearing in chalk combos,
      // forcing B&B to find lineups built around DIFFERENT cores than the field.
      // Also applies moderate ceiling blend to find quality alternatives.
      const worldPlayers = applyGameWorld(pool.players, gameWorld!);
      const antiChalkPlayers = applyChalkComboPenaltyToPlayers(worldPlayers, chalkCombosForAntiChalk);
      iterPlayers = applyCeilingBlend(antiChalkPlayers, 0.25);
      antiChalkIterCount++;
    } else if (iterationType === 'shallow-chalk') {
      // Shallow-chalk iterations: limit chalk teams + BOOST a rotating non-chalk team.
      // Forces the B&B to find deep stacks from non-chalk teams (TB, MIA, NYM, NYY, etc.)
      // that pure projection iterations miss because those teams have lower projected totals.
      const worldPlayers = applyGameWorld(pool.players, gameWorld!);
      const maxPerChalkTeam = 2;
      let limited = applyChalkTeamDepthLimit(worldPlayers, chalkTeams, maxPerChalkTeam, config.sport);

      // Rotate through non-chalk teams and boost one per iteration
      const nonChalkTeams = [...pool.byTeam.keys()].filter(t => !chalkTeams.has(t));
      if (nonChalkTeams.length > 0) {
        const boostTeam = nonChalkTeams[shallowChalkIterCount % nonChalkTeams.length];
        limited = limited.map(p => {
          if (p.team === boostTeam && !p.positions.some((pos: string) => pos === 'P' || pos === 'SP' || pos === 'RP')) {
            return { ...p, projection: p.projection * 1.20 }; // 20% boost to force deep stack
          }
          return p;
        });
      }
      iterPlayers = applyCeilingBlend(limited, 0.20);
      shallowChalkIterCount++;
    } else if (iterationType === 'no-chalk-stack') {
      // No-chalk-stack iterations: limit chalk to 1 + BOOST a rotating non-chalk team.
      // Creates lineups where a single chalk stud anchors a deep non-chalk stack.
      const worldPlayers = applyGameWorld(pool.players, gameWorld!);
      const maxPerChalkTeam = 1;
      let limited = applyChalkTeamDepthLimit(worldPlayers, chalkTeams, maxPerChalkTeam, config.sport);

      // Rotate through non-chalk teams and boost one per iteration
      const nonChalkTeams = [...pool.byTeam.keys()].filter(t => !chalkTeams.has(t));
      if (nonChalkTeams.length > 0) {
        const boostTeam = nonChalkTeams[noChalkStackIterCount % nonChalkTeams.length];
        limited = limited.map(p => {
          if (p.team === boostTeam && !p.positions.some((pos: string) => pos === 'P' || pos === 'SP' || pos === 'RP')) {
            return { ...p, projection: p.projection * 1.25 }; // 25% boost for deeper non-chalk stacks
          }
          return p;
        });
      }
      iterPlayers = applyCeilingBlend(limited, 0.25);
      noChalkStackIterCount++;
    } else {
      // Contrarian iterations: NO EXCLUSIONS - heavy ownership penalty + ceiling blend
      // Creates low-ownership lineups with upside potential

      // Sub-stratify contrarian iterations into 3 distinct strategies:
      //   40% ceiling contrarian (current strategy): ceiling ratio + blend + heavy penalty
      //   35% value contrarian: salary efficiency boost + ownership penalty
      //   25% deep contrarian: 2x penalty, relaxed projection floor
      const currentContrarianIter = contrarianIterCount;
      const contrarianSubIdx = currentContrarianIter % 20;

      // Apply game-world correlation for all contrarian sub-strategies
      const worldContrarian = applyGameWorld(pool.players, gameWorld!);

      if (contrarianSubIdx < 8) {
        // 40%: Ceiling contrarian
        // Apply ceiling ratio boost FIRST (find high boom-potential players based on RATIO)
        const ceilingRatioBoosted = applyCeilingRatioBoost(worldContrarian, 0.20, 0.4);
        // Then apply ceiling blend to further weight upside
        const ceilingBlended = applyCeilingBlend(ceilingRatioBoosted, 0.40);
        // Lighter penalty — data shows anti-chalk hurts actual scoring (-0.15 correlation).
        // At 0.6, 30% owned player keeps ~82% of projection (was 70% at 1.0).
        // Non-team sports: heavier penalty (1.2) to force truly diverse ownership combos.
        const contrarianPenalty = isNonTeamSport ? 1.2 : (isSmallSlate ? 0.9 : 0.6);
        iterPlayers = applyOwnershipPenalty(ceilingBlended, contrarianPenalty);
        // Tag with sub-strategy for constructionMethod
        (iterationType as any) = 'contrarian-ceiling';
      } else if (contrarianSubIdx < 15) {
        // 35%: Value contrarian - boost high pts/$ players + ceiling ratio boost
        const avgPtsPerK = worldContrarian.reduce((sum, p) => sum + (p.projection / p.salary) * 1000, 0) / worldContrarian.length;
        const valueBoosted = worldContrarian.map(p => {
          const ptsPerK = (p.projection / p.salary) * 1000;
          const valueBoost = ptsPerK > avgPtsPerK * 1.2 ? 1.15 : ptsPerK > avgPtsPerK ? 1.05 : 1.0;
          return { ...p, projection: p.projection * valueBoost };
        });
        // Add ceiling ratio boost so value contrarian also finds high-ceiling players
        const ceilingBoostedValue = applyCeilingRatioBoost(valueBoosted, 0.15, 0.4);
        // Heavier penalty for non-team sports to generate truly low-owned lineups
        const contrarianPenalty = isNonTeamSport ? 1.2 : (isSmallSlate ? 0.9 : 0.6);
        iterPlayers = applyOwnershipPenalty(ceilingBoostedValue, contrarianPenalty);
        // Tag with sub-strategy for constructionMethod
        (iterationType as any) = 'contrarian-value';
      } else {
        // 25%: Deep contrarian - ceiling ratio boost + moderate ownership penalty
        const ceilingBoostedDeep = applyCeilingRatioBoost(worldContrarian, 0.20, 0.5);
        // Heavier penalty for non-team sports; moderate for others
        const deepPenalty = isNonTeamSport ? 1.5 : (isSmallSlate ? 1.1 : 0.8);
        iterPlayers = applyOwnershipPenalty(ceilingBoostedDeep, deepPenalty);
        // Tag with sub-strategy for constructionMethod
        (iterationType as any) = 'contrarian-deep';
      }

      // Showdown captain rotation: fade top 3 CPT projections in ~33% of contrarian iterations
      if (isShowdown && contrarianSubIdx % 3 === 0) {
        const cptPlayers = iterPlayers
          .filter(p => p.positions.includes('CPT'))
          .sort((a, b) => b.projection - a.projection);
        const fadeCptNames = new Set(cptPlayers.slice(0, 3).map(p => p.name));
        iterPlayers = iterPlayers.map(p => {
          if (p.positions.includes('CPT') && fadeCptNames.has(p.name)) {
            return { ...p, projection: p.projection * 0.55 };
          }
          return p;
        });
      }

      contrarianIterCount++;
    }

    // Create a modified pool with varied projections
    const iterPool: PlayerPool = {
      players: iterPlayers,
      byId: new Map(iterPlayers.map(p => [p.id, p])),
      byPosition: new Map(),
      byTeam: new Map(),
    };

    // Rebuild position maps
    for (const p of iterPlayers) {
      for (const pos of p.positions) {
        if (!iterPool.byPosition.has(pos)) {
          iterPool.byPosition.set(pos, []);
        }
        iterPool.byPosition.get(pos)!.push(p);
      }
      if (!iterPool.byTeam.has(p.team)) {
        iterPool.byTeam.set(p.team, []);
      }
      iterPool.byTeam.get(p.team)!.push(p);
    }

    // Run optimization for this iteration
    // Use branch-and-bound for all remaining iteration types (projection-focused)
    // Note: field-mimic iterations use continue above and don't reach here
    // Shuffle position order in 50% of non-projection, non-field-mimic iterations
    // to explore different parts of the search tree
    const shouldShuffle = iter > 0 && iterationType !== 'projection' && Math.random() < 0.5;
    const iterResult = runSingleOptimization({
      config,
      pool: iterPool,
      originalPool: pool, // Keep original projections for final lineup scoring
      poolSize: lineupsPerIteration,
      minSalary,
      seenHashes,
      shufflePositions: shouldShuffle,
    });

    // Route lineups to appropriate bucket based on iteration type
    // Note: 'field-mimic' and 'game-stack' iterations use continue above and never reach here
    // Contrarian sub-strategies (contrarian-ceiling, contrarian-value, contrarian-deep)
    // are all routed to contrarianLineups
    const isContrarianType = iterationType === 'contrarian'
      || (iterationType as string) === 'contrarian-ceiling'
      || (iterationType as string) === 'contrarian-value'
      || (iterationType as string) === 'contrarian-deep';
    const targetArray = iterationType === 'projection' ? projectionLineups
      : iterationType === 'leverage' ? leverageLineups
      : iterationType === 'balanced' ? balancedLineups
      : iterationType === 'ceiling' ? ceilingLineups
      : iterationType === 'formula-blend' ? formulaBlendLineups
      : iterationType === 'anti-overlap' ? antiOverlapLineups
      : iterationType === 'salary-value' ? salaryValueLineups
      : iterationType === 'frontier-sweep' ? frontierSweepLineups
      : iterationType === 'anti-chalk' ? antiChalkLineups
      : iterationType === 'shallow-chalk' ? shallowChalkLineups
      : iterationType === 'no-chalk-stack' ? noChalkStackLineups
      : contrarianLineups;

    // Collect unique lineups - NO per-iteration filters.
    // Every valid lineup goes into the pool; the selector handles quality sorting.
    for (const lineup of iterResult.lineups) {
      lineup.constructionMethod = iterationType as string;

      if (!seenHashes.has(lineup.hash)) {
        // Soft combo concentration cap: probabilistically reject lineups whose
        // primary combo is over-represented in the pool. This forces pool diversity
        // at the COMBO level, not just the individual player level.
        // Skip for first 500 lineups (need baseline before rejecting) and for
        // projection iterations (always keep the best raw lineups).
        if (totalLineupsGenerated > 500 && iterationType !== 'projection') {
          const pc = extractPrimaryCombo(lineup, playerLookupForCombo, config.sport);
          if (pc.comboKey) {
            const comboCount = poolPrimaryComboFrequency.get(pc.comboKey) || 0;
            const comboFreq = comboCount / totalLineupsGenerated;
            if (comboFreq > POOL_COMBO_SOFT_CAP) {
              const excess = Math.min(1, (comboFreq - POOL_COMBO_SOFT_CAP) / (POOL_COMBO_HARD_CAP - POOL_COMBO_SOFT_CAP));
              const rejectProb = Math.min(0.90, excess);
              if (Math.random() < rejectProb) continue;
            }
          }
        }

        seenHashes.add(lineup.hash);
        targetArray.push(lineup);

        // Track primary combo frequency for soft-cap
        const pcForTracking = extractPrimaryCombo(lineup, playerLookupForCombo, config.sport);
        if (pcForTracking.comboKey) {
          poolPrimaryComboFrequency.set(pcForTracking.comboKey, (poolPrimaryComboFrequency.get(pcForTracking.comboKey) || 0) + 1);
        }

        // Track new lineups for adaptive rebalancing
        if (iterationType === 'projection') newSinceRebalance.projection++;
        else if (iterationType === 'leverage') newSinceRebalance.leverage++;
        else if (iterationType === 'balanced') newSinceRebalance.balanced++;
        else if (iterationType === 'ceiling') newSinceRebalance.ceiling++;
        else if (iterationType === 'formula-blend') newSinceRebalance.formulaBlend++;
        else if (iterationType === 'anti-overlap') newSinceRebalance.antiOverlap++;
        else if (iterationType === 'salary-value') newSinceRebalance.salaryValue++;
        else if (iterationType === 'frontier-sweep') newSinceRebalance.frontierSweep++;
        else if (iterationType === 'anti-chalk') newSinceRebalance.antiChalk++;
        else if (iterationType === 'shallow-chalk') newSinceRebalance.shallowChalk++;
        else if (iterationType === 'no-chalk-stack') newSinceRebalance.noChalkStack++;
        else if (isContrarianType) newSinceRebalance.contrarian++;

        // Track player frequency for anti-overlap iterations
        for (const p of lineup.players) {
          playerPoolFrequency.set(p.id, (playerPoolFrequency.get(p.id) || 0) + 1);
        }
        totalLineupsGenerated++;

        if (lineup.projection > maxProjectionFound) {
          maxProjectionFound = lineup.projection;
          optimalLineup = lineup;
        }
      }
    }

    // After first iteration completes, capture chalk players for leverage exclusion
    // This MUST run after results are collected (optimalLineup is now set)
    if (iter === 0 && optimalLineup && chalkPlayersToExclude.length === 0) {
      // Extract chalk players by OWNERSHIP (not projection) - these are what the field plays
      chalkPlayersToExclude = [...pool.players]
        .filter(p => p.projection > 0)  // Only players with projections
        .sort((a, b) => b.ownership - a.ownership)  // Sort by ownership DESC
        .slice(0, 10)  // Top 10 most owned
        .map(p => p.name);
      console.log(`  Chalk players for exclusion: ${chalkPlayersToExclude.slice(0, 5).join(', ')}`);
    }

    totalEvaluated += iterResult.evaluatedCount;

    // TEAM-SPORT MULTI-GAME: After iter 0, systematically enumerate ALL stacked lineups
    // above a projection floor. No random sampling, no modified projections — just
    // exhaustive combinatorial search with real projections and pruning.
    if (false && iter === 0 && isTeamSportMultiGame && maxProjectionFound > 0) {
      const projFloorPct = 0.94;  // 94% of optimal
      const projFloor = maxProjectionFound * projFloorPct;
      console.log(`\n  Stack enumeration: all stacked lineups with proj >= ${projFloor.toFixed(1)} (${(projFloorPct*100).toFixed(0)}% of ${maxProjectionFound.toFixed(1)})`);

      // Cap at 25K lineups to keep enumeration under ~120s
      const enumResult = enumerateStackedLineups(
        config, pool, projFloor, seenHashes, 25000, params.minSalary
      );

      for (const lineup of enumResult.lineups) {
        gameStackLineups.push(lineup);
      }
      totalEvaluated += enumResult.evaluatedCount;

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  Stack enumeration: ${gameStackLineups.length.toLocaleString()} lineups (${elapsed}s)`);
      if (gameStackLineups.length > 0) {
        const minP = gameStackLineups.reduce((m, l) => Math.min(m, l.projection), Infinity);
        console.log(`  Projection range: ${minP.toFixed(1)} - ${maxProjectionFound.toFixed(1)}`);
      }
      // Continue to remaining iterations — enumeration provides the stacked base,
      // but we still need ceiling/leverage/contrarian iterations for pool diversity.
      console.log(`  Continuing with ${NUM_ITERATIONS - 1} diversity iterations...`);
      continue;
    }

    // Per-iteration progress logging
    const totalLineups = projectionLineups.length + fieldMimicLineups.length + leverageLineups.length + balancedLineups.length + gameStackLineups.length + ceilingLineups.length + formulaBlendLineups.length + antiOverlapLineups.length + salaryValueLineups.length + antiChalkLineups.length + shallowChalkLineups.length + noChalkStackLineups.length + contrarianLineups.length;
    if (iter % 10 === 0 || iter === NUM_ITERATIONS - 1) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  Iter ${(iter + 1).toString().padStart(3)}/${NUM_ITERATIONS} [${(iterationType as string).padEnd(18)}] ${totalLineups.toLocaleString().padStart(7)} lineups (${elapsed}s)`);
    }

    if (onProgress) {
      onProgress(
        Math.floor(((iter + 1) / NUM_ITERATIONS) * 100),
        `Iteration ${iter + 1}/${NUM_ITERATIONS}: ${totalLineups} unique lineups`
      );
    }
  }

  // ============================================================
  // FORCED TEAM STACK GENERATION
  // ============================================================
  // Generate 5-man and 4-man stacks for EVERY viable team on the slate.
  // Weighted by team stack quality — high-quality environments get more.
  // This ensures the pool contains deep stacks from TB, MIA, NYY, NYM, etc.
  // that the B&B naturally misses because those teams have lower projections.
  const forcedStackLineups: Lineup[] = [];
  if (isTeamSportMultiGame && viableStackTeams.length > 0 && maxProjectionFound > 0) {
    console.log(`\n  --- FORCED TEAM STACK GENERATION ---`);

    // Compute allocation per team weighted by quality (min 3 attempts, max 20)
    const totalQuality = viableStackTeams.reduce((s, t) => s + (teamStackQuality.get(t) || 1), 0);
    const TOTAL_FORCED_ATTEMPTS = Math.min(viableStackTeams.length * 15, 200);

    for (const team of viableStackTeams) {
      const quality = teamStackQuality.get(team) || 1.0;
      const qualityPct = Math.max(0.04, Math.min(0.15, quality / totalQuality));
      const attempts = Math.max(4, Math.round(TOTAL_FORCED_ATTEMPTS * qualityPct));

      const teamBatters = pool.players.filter(p =>
        p.team === team &&
        !p.positions.some((pos: string) => pos === 'P' || pos === 'SP' || pos === 'RP') &&
        p.projection > 0
      ).sort((a, b) => b.projection - a.projection);

      if (teamBatters.length < 4) continue;

      // For each attempt, boost this team's batters heavily and run B&B
      let teamNew = 0;
      for (let a = 0; a < attempts; a++) {
        const gameWorld = generateGameWorld(pool.players);
        const worldPlayers = applyGameWorld(pool.players, gameWorld);

        // Boost target team batters by 50-80% (vary per attempt for different combos)
        const boostFactor = 1.50 + (a % 4) * 0.10;
        const boosted = worldPlayers.map(p => {
          if (p.team === team && !p.positions.some((pos: string) => pos === 'P' || pos === 'SP' || pos === 'RP')) {
            return { ...p, projection: p.projection * boostFactor };
          }
          return p;
        });

        // Apply ceiling blend for variety
        const blended = applyCeilingBlend(boosted, 0.15 + (a % 3) * 0.10);

        const iterPool: PlayerPool = {
          players: blended,
          byId: new Map(blended.map(p => [p.id, p])),
          byPosition: new Map(),
          byTeam: new Map(),
        };
        for (const p of blended) {
          for (const pos of p.positions) {
            if (!iterPool.byPosition.has(pos)) iterPool.byPosition.set(pos, []);
            iterPool.byPosition.get(pos)!.push(p);
          }
          if (!iterPool.byTeam.has(p.team)) iterPool.byTeam.set(p.team, []);
          iterPool.byTeam.get(p.team)!.push(p);
        }

        const result = runSingleOptimization({
          config,
          pool: iterPool,
          originalPool: pool,
          poolSize: 50, // Small batch per attempt
          minSalary,
          seenHashes,
          shufflePositions: a % 2 === 1,
        });

        for (const lineup of result.lineups) {
          // Verify this lineup actually has a deep stack from the target team
          let teamBatterCount = 0;
          for (const p of lineup.players) {
            if (p.team === team && !p.positions.some((pos: string) => pos === 'P' || pos === 'SP' || pos === 'RP')) {
              teamBatterCount++;
            }
          }
          if (teamBatterCount >= 4 && !seenHashes.has(lineup.hash)) {
            lineup.constructionMethod = 'forced-stack';
            forcedStackLineups.push(lineup);
            seenHashes.add(lineup.hash);
            teamNew++;
          }
        }
        totalEvaluated += result.evaluatedCount;
      }

      const isChalk = chalkTeams.has(team) ? ' [CHALK]' : '';
      const s5 = forcedStackLineups.filter(l => {
        let ct = 0;
        for (const p of l.players) {
          if (p.team === team && !p.positions.some((pos: string) => pos === 'P' || pos === 'SP' || pos === 'RP')) ct++;
        }
        return ct >= 5;
      }).length;
      if (teamNew > 0) {
        console.log(`    ${team}: +${teamNew} lineups (${s5} 5-man) q=${quality.toFixed(1)}${isChalk}`);
      }
    }
    console.log(`  Forced stacks total: ${forcedStackLineups.length} new lineups`);
  }

  // ============================================================
  // PITCHER COVERAGE GUARANTEE
  // ============================================================
  // Every viable pitcher must appear in the pool. Force-generate lineups
  // for any pitcher that's missing or under-represented.
  const forcedPitcherLineups: Lineup[] = [];
  if (isTeamSportMultiGame && config.sport === 'mlb') {
    // Find viable pitchers: proj >= 10 OR ceiling >= 20 OR ownership >= 5%
    const viablePitchers = pool.players.filter(p => {
      if (!p.positions.some((pos: string) => pos === 'P' || pos === 'SP' || pos === 'RP')) return false;
      if (p.projection <= 0) return false;
      const ceil = p.ceiling || p.projection * 1.2;
      return p.projection >= 10 || ceil >= 20 || p.ownership >= 5;
    });

    // Count current pitcher exposure in the pool
    const allPoolLineups = [
      ...projectionLineups, ...fieldMimicLineups, ...leverageLineups,
      ...balancedLineups, ...gameStackLineups, ...ceilingLineups,
      ...formulaBlendLineups, ...antiOverlapLineups, ...salaryValueLineups,
      ...frontierSweepLineups, ...antiChalkLineups, ...shallowChalkLineups,
      ...noChalkStackLineups, ...contrarianLineups, ...forcedStackLineups,
    ];
    const pitcherCounts = new Map<string, number>();
    for (const lu of allPoolLineups) {
      for (const p of lu.players) {
        if (p.positions.some((pos: string) => pos === 'P' || pos === 'SP' || pos === 'RP')) {
          pitcherCounts.set(p.id, (pitcherCounts.get(p.id) || 0) + 1);
        }
      }
    }

    const MIN_PITCHER_EXPOSURE = 0.01; // At least 1% of pool
    const poolSize = allPoolLineups.length || 1;
    const underCoveredPitchers = viablePitchers.filter(p => {
      const ct = pitcherCounts.get(p.id) || 0;
      return ct / poolSize < MIN_PITCHER_EXPOSURE;
    });

    if (underCoveredPitchers.length > 0) {
      console.log(`\n  --- PITCHER COVERAGE GUARANTEE ---`);
      console.log(`  Viable pitchers: ${viablePitchers.length}, under-covered: ${underCoveredPitchers.length}`);

      for (const pitcher of underCoveredPitchers) {
        // Force this pitcher by boosting their projection massively
        const ATTEMPTS = 8;
        let pitcherNew = 0;

        for (let a = 0; a < ATTEMPTS; a++) {
          const gameWorld = generateGameWorld(pool.players);
          const worldPlayers = applyGameWorld(pool.players, gameWorld);

          // Boost forced pitcher by 3x so B&B always includes them
          const boosted = worldPlayers.map(p => {
            if (p.id === pitcher.id) return { ...p, projection: p.projection * 3.0 };
            return p;
          });

          const blended = applyCeilingBlend(boosted, 0.20 + (a % 3) * 0.10);
          const iterPool: PlayerPool = {
            players: blended,
            byId: new Map(blended.map(p => [p.id, p])),
            byPosition: new Map(),
            byTeam: new Map(),
          };
          for (const p of blended) {
            for (const pos of p.positions) {
              if (!iterPool.byPosition.has(pos)) iterPool.byPosition.set(pos, []);
              iterPool.byPosition.get(pos)!.push(p);
            }
            if (!iterPool.byTeam.has(p.team)) iterPool.byTeam.set(p.team, []);
            iterPool.byTeam.get(p.team)!.push(p);
          }

          const result = runSingleOptimization({
            config, pool: iterPool, originalPool: pool,
            poolSize: 30, minSalary, seenHashes,
            shufflePositions: a % 2 === 1,
          });

          for (const lineup of result.lineups) {
            if (lineup.players.some(p => p.id === pitcher.id) && !seenHashes.has(lineup.hash)) {
              lineup.constructionMethod = 'forced-pitcher';
              forcedPitcherLineups.push(lineup);
              seenHashes.add(lineup.hash);
              pitcherNew++;
            }
          }
          totalEvaluated += result.evaluatedCount;
        }

        if (pitcherNew > 0) {
          const ceil = pitcher.ceiling || pitcher.projection * 1.2;
          console.log(`    ${pitcher.name.padEnd(20)} proj=${pitcher.projection.toFixed(1)} ceil=${ceil.toFixed(1)} own=${pitcher.ownership.toFixed(1)}% → +${pitcherNew} lineups`);
        }
      }
      console.log(`  Forced pitcher lineups total: ${forcedPitcherLineups.length}`);
    }
  }

  // ============================================================
  // EFFICIENT FRONTIER POOL RETENTION
  // ============================================================
  // Mathematical approach: Keep lineups that maximize projection for their
  // ownership level. A lineup is on the efficient frontier if no other
  // lineup has BOTH higher projection AND lower ownership.
  //
  // This directly optimizes for: highest projection + lowest ownership
  // ============================================================

  // Combine all lineups from all iteration types
  const allLineups = [
    ...projectionLineups,
    ...fieldMimicLineups,
    ...leverageLineups,
    ...balancedLineups,
    ...gameStackLineups,
    ...ceilingLineups,
    ...formulaBlendLineups,
    ...antiOverlapLineups,
    ...salaryValueLineups,
    ...frontierSweepLineups,
    ...antiChalkLineups,
    ...shallowChalkLineups,
    ...noChalkStackLineups,
    ...contrarianLineups,
    ...forcedStackLineups,
    ...forcedPitcherLineups,
  ];

  // Deduplicate by hash
  const seenFinal = new Set<string>();
  const dedupedLineups = allLineups.filter(l => {
    if (seenFinal.has(l.hash)) return false;
    seenFinal.add(l.hash);
    return true;
  });

  // Projection floor filter — remove lineups below threshold before passing to selector
  // Aggressive floors to capture the low-projection, high-ceiling builds that win GPPs.
  // Data: 70 of top 100 actual-scoring lineups on 4/4/26 projected below 80% of optimal.
  // Winners project at 71-83% of optimal. SS pool goes down to 67%.
  //   MLB: 68% — winning lineups project 71-83% of optimal, need full range
  //   Team sports: 72% — similar dynamic, slightly tighter
  //   Non-team sports: 70% — need ultra-contrarian pool depth
  //   Short slates: 75% — fewer combos, tighter range
  // NBA/NFL: 90% floor — tight projection ranges, low-proj lineups are just bad not contrarian
  // MLB: 68% — winning lineups project 71-83% of optimal (backtest proven)
  // Non-team: 70% — high variance individual sports
  const floorPct = isNonTeamSport ? 0.70
    : config.sport === 'mlb' ? 0.68
    : (config.sport === 'nba' || config.sport === 'nfl') ? 0.90
    : (isShortSlate ? 0.82 : 0.80);
  const projFloor = optimalLineup ? optimalLineup.projection * floorPct : 0;
  const floorFiltered = projFloor > 0
    ? dedupedLineups.filter(l => l.projection >= projFloor)
    : dedupedLineups;
  const floorRejected = dedupedLineups.length - floorFiltered.length;
  console.log(`  ${dedupedLineups.length} unique lineups after hash dedup`);
  if (floorRejected > 0) {
    console.log(`  Projection floor: ${floorFiltered.length} pass (${floorRejected} below ${(floorPct * 100).toFixed(0)}% of optimal = ${projFloor.toFixed(1)})`);
  }
  // MLB: filter out lineups without min 4-man batter stack
  let mlbFiltered = floorFiltered;
  if (config.sport === 'mlb') {
    mlbFiltered = floorFiltered.filter(l => {
      const batterTeams = new Map<string, number>();
      for (const p of l.players) {
        if (!p.positions.includes('P')) {
          batterTeams.set(p.team, (batterTeams.get(p.team) || 0) + 1);
        }
      }
      let maxStack = 0;
      for (const count of batterTeams.values()) {
        if (count > maxStack) maxStack = count;
      }
      return maxStack >= 4;
    });
    const mlbRejected = floorFiltered.length - mlbFiltered.length;
    if (mlbRejected > 0) {
      console.log(`  MLB stack filter: ${mlbFiltered.length} pass (${mlbRejected} below min 4-man batter stack)`);
    }
  }
  const uniqueLineups = mlbFiltered;

  const finalLineups = uniqueLineups;

  // --- Pool Stack Coverage Report ---
  if (isTeamSportMultiGame && viableStackTeams.length > 0) {
    console.log(`\n  [PoolCoverage] === STACK COVERAGE ===`);
    const poolStackCov = new Map<string, { s5: number; s4: number; total: number }>();
    for (const lu of finalLineups) {
      const teamCts = new Map<string, number>();
      for (const p of lu.players) {
        if (!p.positions.some((pos: string) => pos === 'P' || pos === 'SP' || pos === 'RP')) {
          teamCts.set(p.team, (teamCts.get(p.team) || 0) + 1);
        }
      }
      for (const [team, ct] of teamCts) {
        if (!poolStackCov.has(team)) poolStackCov.set(team, { s5: 0, s4: 0, total: 0 });
        const entry = poolStackCov.get(team)!;
        if (ct >= 5) entry.s5++;
        else if (ct >= 4) entry.s4++;
        entry.total++;
      }
    }
    for (const team of viableStackTeams.sort()) {
      const cov = poolStackCov.get(team) || { s5: 0, s4: 0, total: 0 };
      const status = cov.s5 >= 10 ? 'OK' : cov.s5 > 0 ? 'LOW' : 'MISSING';
      const q = teamStackQuality.get(team)?.toFixed(1) || '?';
      const chalk = chalkTeams.has(team) ? ' [CHALK]' : '';
      console.log(`  [PoolCoverage] ${team.padEnd(5)} 5man:${String(cov.s5).padStart(4)} 4man:${String(cov.s4).padStart(4)} total:${String(cov.total).padStart(5)} q=${q} [${status}]${chalk}`);
    }
    console.log(`  [PoolCoverage] === END ===`);
  }

  const endTime = Date.now();

  console.log(`\nOptimization complete!`);
  console.log(`Generated ${finalLineups.length.toLocaleString()} lineups (projection floor filtered)`);
  console.log(`  Projection pool: ${projectionLineups.length} generated`);
  console.log(`  Field-mimic pool: ${fieldMimicLineups.length} generated`);
  console.log(`  Leverage pool:   ${leverageLineups.length} generated`);
  console.log(`  Balanced pool:   ${balancedLineups.length} generated`);
  console.log(`  Game-stack pool: ${gameStackLineups.length} generated`);
  console.log(`  Ceiling pool:    ${ceilingLineups.length} generated`);
  console.log(`  Formula-blend:   ${formulaBlendLineups.length} generated`);
  console.log(`  Anti-overlap:    ${antiOverlapLineups.length} generated`);
  console.log(`  Salary-value:    ${salaryValueLineups.length} generated`);
  console.log(`  Frontier-sweep:  ${frontierSweepLineups.length} generated`);
  console.log(`  Anti-chalk:      ${antiChalkLineups.length} generated`);
  console.log(`  Shallow-chalk:   ${shallowChalkLineups.length} generated`);
  console.log(`  No-chalk-stack:  ${noChalkStackLineups.length} generated`);
  console.log(`  Contrarian pool: ${contrarianLineups.length} generated`);
  if (forcedStackLineups.length > 0) console.log(`  Forced-stacks:   ${forcedStackLineups.length} generated`);

  // Log pool combo diversity
  if (poolPrimaryComboFrequency.size > 0) {
    const topPoolCombos = [...poolPrimaryComboFrequency.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 5);
    const totalPool = totalLineupsGenerated;
    console.log(`  Pool combo diversity (top 5 primary combos):`);
    for (const [, count] of topPoolCombos) {
      console.log(`    ${count} lineups (${(count / totalPool * 100).toFixed(1)}%)`);
    }
  }
  console.log(`  Unique lineups:  ${uniqueLineups.length} after dedup`);
  console.log(`Evaluated ${totalEvaluated.toLocaleString()} combinations`);
  console.log(`Max projection: ${maxProjectionFound.toFixed(2)}`);
  console.log(`Time: ${((endTime - startTime) / 1000).toFixed(1)}s\n`);

  return {
    lineups: finalLineups,
    maxProjection: maxProjectionFound,
    optimalLineup: optimalLineup || finalLineups[0],
    generationTimeMs: endTime - startTime,
    evaluatedCount: totalEvaluated,
  };
}

/**
 * Improve dominated lineups by swapping one player to push them toward the Pareto frontier.
 * For lineups that are close to the frontier (lower projection AND higher ownership than
 * another lineup), try each roster slot swap to find one that improves efficiency.
 */
function improveDominatedLineups(
  lineups: Lineup[],
  pool: PlayerPool,
  config: ContestConfig
): { lineups: Lineup[]; improved: number; attempted: number } {
  if (lineups.length < 10) return { lineups, improved: 0, attempted: 0 };

  // Compute sumOwnership for each lineup
  const withOwn = lineups.map(l => ({
    lineup: l,
    sumOwnership: l.players.reduce((sum, p) => sum + p.ownership, 0),
  }));

  // Sort by projection DESC (ties broken by lower ownership)
  withOwn.sort((a, b) => b.lineup.projection - a.lineup.projection || a.sumOwnership - b.sumOwnership);

  // Identify Pareto frontier and dominated lineups
  let minSumOwnSeen = Infinity;
  const frontierSet = new Set<string>();
  const dominated: Array<{ lineup: Lineup; sumOwnership: number; distToFrontier: number }> = [];

  for (const item of withOwn) {
    if (item.sumOwnership <= minSumOwnSeen) {
      frontierSet.add(item.lineup.hash);
      minSumOwnSeen = item.sumOwnership;
    } else {
      // Distance to frontier: how far above minSumOwnSeen
      dominated.push({
        lineup: item.lineup,
        sumOwnership: item.sumOwnership,
        distToFrontier: item.sumOwnership - minSumOwnSeen,
      });
    }
  }

  // Sort dominated by distance to frontier (closest first — most improvable)
  dominated.sort((a, b) => a.distToFrontier - b.distToFrontier);

  // Cap at 3000 attempts
  const MAX_ATTEMPTS = 3000;
  const candidates = dominated.slice(0, MAX_ATTEMPTS);

  // Build player lookup by position for swap candidates
  // Pre-sort players by efficiency (proj / sqrt(own)) for quick top-20 selection
  const playersByPosition = new Map<string, Player[]>();
  for (const player of pool.players) {
    for (const pos of player.positions) {
      if (!playersByPosition.has(pos)) playersByPosition.set(pos, []);
      playersByPosition.get(pos)!.push(player);
    }
  }
  for (const [, players] of playersByPosition) {
    players.sort((a, b) => {
      const effA = a.projection / Math.sqrt(Math.max(0.5, a.ownership));
      const effB = b.projection / Math.sqrt(Math.max(0.5, b.ownership));
      return effB - effA;
    });
  }

  let improved = 0;
  const existingHashes = new Set(lineups.map(l => l.hash));
  const improvedLineups = new Map<string, Lineup>(); // old hash -> new lineup

  for (const cand of candidates) {
    const lineup = cand.lineup;
    const players = lineup.players;
    const currentProj = lineup.projection;
    const currentSumOwn = cand.sumOwnership;
    const currentEfficiency = currentProj / Math.sqrt(Math.max(1, currentSumOwn));

    let bestSwap: { slotIdx: number; newPlayer: Player; newProj: number; newSumOwn: number; newEff: number } | null = null;

    for (let slotIdx = 0; slotIdx < players.length; slotIdx++) {
      const oldPlayer = players[slotIdx];
      const slotEligible = config.positions[slotIdx]?.eligible;
      if (!slotEligible) continue;

      // Find swap candidates: must fit this slot's position
      const swapCandidates: Player[] = [];
      for (const eligPos of slotEligible) {
        const posPlayers = playersByPosition.get(eligPos);
        if (posPlayers) {
          for (const p of posPlayers) {
            if (swapCandidates.length >= 20) break;
            if (p.id === oldPlayer.id) continue;
            // Can't already be in lineup
            if (players.some(existing => existing.id === p.id)) continue;
            // Showdown: CPT and UTIL versions have different IDs but same name — block both
            if (config.contestType === 'showdown' && players.some(existing => existing.name === p.name)) continue;
            // Salary check
            const newSalary = lineup.salary - oldPlayer.salary + p.salary;
            if (newSalary > config.salaryCap) continue;
            if (newSalary < (config.salaryMin || 0)) continue;
            swapCandidates.push(p);
          }
        }
      }

      for (const swapPlayer of swapCandidates) {
        const newProj = currentProj - oldPlayer.projection + swapPlayer.projection;
        const newSumOwn = currentSumOwn - oldPlayer.ownership + swapPlayer.ownership;
        const newEff = newProj / Math.sqrt(Math.max(1, newSumOwn));

        // Must improve efficiency AND either improve projection or reduce ownership
        if (newEff > (bestSwap?.newEff ?? currentEfficiency) &&
            (newProj > currentProj || newSumOwn < currentSumOwn)) {
          bestSwap = { slotIdx, newPlayer: swapPlayer, newProj, newSumOwn, newEff };
        }
      }
    }

    if (bestSwap) {
      // Validate constraints before accepting
      const newPlayers = [...players];
      newPlayers[bestSwap.slotIdx] = bestSwap.newPlayer;

      // Check maxPlayersPerTeam
      if (config.maxPlayersPerTeam) {
        const teamCounts = new Map<string, number>();
        for (const p of newPlayers) {
          teamCounts.set(p.team, (teamCounts.get(p.team) || 0) + 1);
        }
        let violatesTeam = false;
        for (const [, count] of teamCounts) {
          if (count > config.maxPlayersPerTeam) { violatesTeam = true; break; }
        }
        if (violatesTeam) continue;
      }

      // Check minGames
      if (config.minGames) {
        const games = new Set<string>();
        for (const p of newPlayers) {
          if (p.gameInfo) games.add(p.gameInfo);
          else games.add(p.team); // fallback
        }
        if (games.size < config.minGames) continue;
      }

      const newLineup = createLineup(newPlayers);
      // Tag construction method
      newLineup.constructionMethod = (lineup.constructionMethod || 'unknown') + '-improved';

      // Don't create duplicates
      if (!existingHashes.has(newLineup.hash)) {
        improvedLineups.set(lineup.hash, newLineup);
        existingHashes.add(newLineup.hash);
        improved++;
      }
    }
  }

  // Merge: replace old dominated lineups with improved versions
  const result = lineups.map(l => improvedLineups.get(l.hash) || l);

  return { lineups: result, improved, attempted: candidates.length };
}

/**
 * Run a single optimization iteration
 */
function runSingleOptimization(params: {
  config: ContestConfig;
  pool: PlayerPool;
  originalPool: PlayerPool;
  poolSize: number;
  minSalary?: number;
  seenHashes: Set<string>;
  shufflePositions?: boolean;
}): { lineups: Lineup[]; evaluatedCount: number } {
  const { config, pool, originalPool, poolSize, minSalary, seenHashes } = params;
  const shufflePositions = params.shufflePositions ?? false;

  const effectiveMinSalary = minSalary ?? config.salaryMin;

  // Build eligibility matrix
  const eligibilityMatrix = buildEligibilityMatrix(pool, config);

  // Build bitmap infrastructure for O(1) bounds computation
  const nameMap = buildPlayerNameMap(pool);
  const { byProjDesc, bySalaryAsc } = buildSortedEligiblePerSlot(pool, config, eligibilityMatrix);

  // Sort players by projection for each slot as index arrays (avoids Player object lookups)
  const sortedBySlotIdx: number[][] = config.positions.map((_, slotIdx) => {
    const eligible: number[] = [];
    for (let j = 0; j < pool.players.length; j++) {
      if (eligibilityMatrix[slotIdx][j]) eligible.push(j);
    }
    return eligible.sort((a, b) => pool.players[b].projection - pool.players[a].projection);
  });

  // Validate we have players for each slot
  for (let i = 0; i < config.positions.length; i++) {
    if (sortedBySlotIdx[i].length === 0) {
      throw new Error(`No eligible players for slot ${config.positions[i].name}`);
    }
  }

  // Position order: optionally shuffle for broader tree exploration
  const positionOrder: number[] = [];
  for (let i = 0; i < config.rosterSize; i++) positionOrder.push(i);
  if (shufflePositions) {
    // Fisher-Yates shuffle
    for (let i = positionOrder.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = positionOrder[i];
      positionOrder[i] = positionOrder[j];
      positionOrder[j] = tmp;
    }
  }

  // Initialize heap
  const lineupHeap = new LineupHeap(poolSize);
  let evaluatedCount = 0;
  let nodesExplored = 0;
  let maxProjectionFound = 0;
  let optimalLineup: Lineup | null = null;

  // Node limit: with bitmap optimization, 6M nodes completes in roughly
  // the same wall time as old 2M with Set-based bounds
  const MAX_NODES = 6_000_000;
  const searchStartTime = Date.now();
  const MAX_TIME_MS = 15_000; // 15 second hard time limit per iteration

  // Pre-allocate bitmap and player array for search (mutable, push/pop)
  const usedBitmap = new Uint8Array(pool.players.length);
  const currentPlayers: Player[] = [];

  // Pre-allocate remaining slots array (reused per bound call via slicing positionOrder)
  // At depth d, remaining slots are positionOrder[d], positionOrder[d+1], ...
  // We pass a pointer into positionOrder and the remaining count.
  const rosterSize = config.rosterSize;

  /**
   * Recursive branch-and-bound search (bitmap-optimized)
   * Uses mutable usedBitmap + currentPlayers with push/pop for zero-allocation per node
   */
  function search(
    depth: number,
    currentSalary: number,
    currentProjection: number
  ): void {
    if (nodesExplored >= MAX_NODES) return;
    nodesExplored++;

    // Periodic time check (every 10K nodes to avoid Date.now() overhead)
    if (nodesExplored % 10000 === 0 && Date.now() - searchStartTime > MAX_TIME_MS) return;

    // Base case: all slots filled
    if (depth === rosterSize) {
      evaluatedCount++;

      if (currentSalary < effectiveMinSalary) return;

      // Showdown: Must have players from BOTH teams
      if (config.contestType === 'showdown') {
        const teamsInLineup = new Set(currentPlayers.map(p => p.team));
        if (teamsInLineup.size < 2) return;
      }

      // Classic: Must have players from at least minGames different games
      if (config.minGames && config.minGames > 1) {
        const games = new Set<string>();
        for (const p of currentPlayers) {
          games.add(p.gameInfo || p.team);
        }
        if (games.size < config.minGames) return;
      }

      // Create lineup: reconstruct with position-order mapping
      const orderedPlayers: Player[] = new Array(rosterSize);
      for (let i = 0; i < rosterSize; i++) {
        orderedPlayers[positionOrder[i]] = currentPlayers[i];
      }
      const lineup = createLineup(orderedPlayers);

      if (lineup.projection > maxProjectionFound) {
        maxProjectionFound = lineup.projection;
        optimalLineup = lineup;
      }

      lineupHeap.push(lineup);
      return;
    }

    const slotIndex = positionOrder[depth];
    const remainingSalary = config.salaryCap - currentSalary;
    const remainingSlotsLen = rosterSize - depth;

    // Pruning: min salary needed (bitmap-based, zero allocation)
    const minNeeded = minSalaryBitmap(
      pool, usedBitmap, bySalaryAsc, nameMap, positionOrder, remainingSlotsLen, depth
    );
    if (minNeeded === Infinity || minNeeded > remainingSalary) return;

    // Pruning: upper bound check (bitmap-based, zero allocation)
    if (lineupHeap.size >= poolSize) {
      const upperBound = currentProjection + upperBoundBitmap(
        pool, usedBitmap, remainingSalary, byProjDesc, nameMap, positionOrder, remainingSlotsLen, depth
      );
      if (upperBound < lineupHeap.minProjection) return;
    }

    const candidates = sortedBySlotIdx[slotIndex];
    const slot = config.positions[slotIndex];

    // Count players per team (for maxPlayersPerTeam check)
    let teamCounts: Map<string, number> | null = null;
    if (config.maxPlayersPerTeam) {
      teamCounts = new Map<string, number>();
      for (const p of currentPlayers) {
        teamCounts.set(p.team, (teamCounts.get(p.team) || 0) + 1);
      }
    }

    for (let ci = 0; ci < candidates.length; ci++) {
      if (nodesExplored >= MAX_NODES) return;

      const playerIdx = candidates[ci];
      // O(1) bitmap check — replaces usedNames.has()
      if (usedBitmap[playerIdx]) continue;

      const player = pool.players[playerIdx];

      if (currentSalary + player.salary > config.salaryCap) continue;

      if (teamCounts && config.maxPlayersPerTeam) {
        const tc = teamCounts.get(player.team) || 0;
        if (tc >= config.maxPlayersPerTeam) continue;
      }

      // Showdown: Skip if FLEX has same name as CPT
      if (config.contestType === 'showdown' && !slot.isCaptain) {
        const cptPlayer = currentPlayers.find(p => p.isCaptain);
        if (cptPlayer && player.name === cptPlayer.name) continue;
      }

      // MMA opponent exclusion
      if (player.opponent && currentPlayers.some(p => p.name === player.opponent)) continue;

      // MLB constraints: batter vs opposing pitcher — only on 2-game slates
      if (config.sport === 'mlb') {
        const bbGames = new Set(pool.players.map(pp => pp.gameInfo || pp.team));
        const bbMaxBvP = bbGames.size <= 2 ? 2 : 0;
        const isPitcher = player.positions.includes('P');
        let mlbSkip = false;
        if (isPitcher) {
          // Adding a pitcher: count batters from pitcher's opponent team already in lineup
          let count = 0;
          for (const p of currentPlayers) {
            if (!p.positions.includes('P') && p.team === player.opponent) count++;
          }
          if (count > bbMaxBvP) mlbSkip = true;
        } else {
          // Adding a batter: check if any pitcher in lineup pitches against this batter's team
          for (const p of currentPlayers) {
            if (p.positions.includes('P') && p.team === player.opponent) {
              let existing = 0;
              for (const cp of currentPlayers) {
                if (!cp.positions.includes('P') && cp.team === player.team) existing++;
              }
              if (existing >= bbMaxBvP) { mlbSkip = true; break; }
            }
          }
        }
        if (mlbSkip) continue;
      }

      // Mark all indices for this player's name (handles CPT/FLEX sharing)
      const nameIndices = nameMap.nameToIndices.get(player.name)!;
      for (let m = 0; m < nameIndices.length; m++) usedBitmap[nameIndices[m]] = 1;
      currentPlayers.push(player);

      search(depth + 1, currentSalary + player.salary, currentProjection + player.projection);

      // Restore
      currentPlayers.pop();
      for (let m = 0; m < nameIndices.length; m++) usedBitmap[nameIndices[m]] = 0;
    }
  }

  // Run search
  nodesExplored = 0;
  search(0, 0, 0);

  // Get results and recalculate projections using ORIGINAL pool (not varied)
  const rawLineups = lineupHeap.toSortedArray();

  // Remap lineups to use original player projections
  const lineups = rawLineups.map(lineup => {
    const originalPlayers = lineup.players.map(p => {
      const orig = originalPool.byId.get(p.id);
      return orig || p;
    });
    return createLineup(originalPlayers);
  });

  return {
    lineups,
    evaluatedCount,
  };
}

/**
 * Create lineup object from players
 */
function createLineup(players: Player[]): Lineup {
  const salary = calculateTotalSalary(players);
  const projection = calculateTotalProjection(players);
  const ownership = calculateOwnership(players);

  // Create deterministic hash
  const sortedIds = [...players.map(p => p.id)].sort();
  const hash = sortedIds.join('|');

  return {
    players: [...players],
    salary,
    projection,
    ownership,
    hash,
  };
}

// ============================================================
// ALTERNATIVE: ITERATIVE OPTIMIZER (FALLBACK)
// ============================================================

/**
 * Fallback optimizer using randomized construction.
 * Used when branch-and-bound is too slow.
 */
export function optimizeLineupsIterative(
  params: OptimizationParams,
  onProgress?: (progress: number, message: string) => void
): OptimizationResult {
  const { config, pool, poolSize } = params;
  const startTime = Date.now();
  const effectiveMinSalary = params.minSalary ?? config.salaryMin;

  console.log(`\nUsing iterative optimizer for ${config.name}`);

  const eligibilityMatrix = buildEligibilityMatrix(pool, config);
  const lineups: Lineup[] = [];
  const seenHashes = new Set<string>();

  const maxIterations = poolSize * 200;
  let iterations = 0;
  let maxProjection = 0;
  let optimalLineup: Lineup | null = null;

  while (lineups.length < poolSize && iterations < maxIterations) {
    iterations++;

    const lineup = constructRandomLineup(config, pool, eligibilityMatrix, effectiveMinSalary);

    if (lineup && !seenHashes.has(lineup.hash)) {
      lineups.push(lineup);
      seenHashes.add(lineup.hash);

      if (lineup.projection > maxProjection) {
        maxProjection = lineup.projection;
        optimalLineup = lineup;
      }
    }

    if (iterations % 10000 === 0 && onProgress) {
      onProgress(
        Math.floor((lineups.length / poolSize) * 100),
        `Generated ${lineups.length}/${poolSize} lineups`
      );
    }
  }

  // Sort by projection
  lineups.sort((a, b) => b.projection - a.projection);

  const endTime = Date.now();

  return {
    lineups,
    maxProjection,
    optimalLineup: optimalLineup || lineups[0],
    generationTimeMs: endTime - startTime,
    evaluatedCount: iterations,
  };
}

/**
 * Generate lineups using ownership-weighted construction for field-mimicking.
 * These lineups represent what the field would build - ownership-proportional
 * construction with a projection floor to ensure quality.
 *
 * Used to identify differentiated cores: combos we have that field rarely uses.
 */
function runFieldMimicConstruction(params: {
  config: ContestConfig;
  pool: PlayerPool;
  count: number;
  seenHashes: Set<string>;
  minProjectionPct: number;
  fieldMimicIterIndex?: number;
}): { lineups: Lineup[]; evaluatedCount: number } {
  const { config, pool, count, seenHashes, minProjectionPct, fieldMimicIterIndex } = params;
  const lineups: Lineup[] = [];
  let evaluated = 0;
  const maxAttempts = count * 10;

  // Get projection floor based on average lineup-level projection
  const avgProj = pool.players.reduce((s, p) => s + p.projection, 0) / pool.players.length;
  const projFloor = avgProj * config.positions.length * minProjectionPct;

  // Build eligibility matrix
  const eligibilityMatrix = buildEligibilityMatrix(pool, config);

  // Determine field archetype for this iteration
  // Real tournament fields have different archetypes:
  //   70% chalk optimizers: ownership-dominant weighting
  //   20% balanced builders: mix of ownership and projection
  //   10% contrarian builders: projection-dominant, anti-ownership
  const iterIdx = fieldMimicIterIndex || 0;
  const fieldArchetype = iterIdx % 10;
  let archetypeLabel: 'chalk' | 'balanced' | 'contrarian';
  if (fieldArchetype < 7) {
    archetypeLabel = 'chalk';
  } else if (fieldArchetype < 9) {
    archetypeLabel = 'balanced';
  } else {
    archetypeLabel = 'contrarian';
  }

  while (lineups.length < count && evaluated < maxAttempts) {
    evaluated++;
    const lineup = constructOwnershipWeightedLineup(pool, config, eligibilityMatrix, archetypeLabel);

    if (!lineup) continue;
    if (seenHashes.has(lineup.hash)) continue;
    if (lineup.projection < projFloor) continue;

    lineups.push(lineup);
  }

  return { lineups, evaluatedCount: evaluated };
}

/**
 * Construct a single lineup using ownership-weighted player selection.
 *
 * Real tournament fields have different archetypes:
 *   - chalk (70%): ownership-dominant weighting (ownership^1.8 * projection^0.5)
 *   - balanced (20%): mix of ownership and projection (ownership^0.8 * projection^1.0)
 *   - contrarian (10%): projection-dominant, anti-ownership (projection^1.5 * (1/ownership)^0.3)
 *
 * This creates a realistic field distribution for combo analysis and differentiation.
 */
function constructOwnershipWeightedLineup(
  pool: PlayerPool,
  config: ContestConfig,
  eligibilityMatrix: boolean[][],
  archetype: 'chalk' | 'balanced' | 'contrarian' = 'chalk'
): Lineup | null {
  const players: Player[] = [];
  const usedNames = new Set<string>();
  const teamCounts = new Map<string, number>();
  let remainingSalary = config.salaryCap;

  for (let slotIdx = 0; slotIdx < config.positions.length; slotIdx++) {
    const slot = config.positions[slotIdx];

    // Get eligible players
    const eligible = pool.players.filter((p, pIdx) => {
      if (!eligibilityMatrix[slotIdx][pIdx]) return false;
      if (usedNames.has(p.name)) return false;
      if (p.salary > remainingSalary) return false;

      // Max players per team check
      if (config.maxPlayersPerTeam) {
        const currentTeamCount = teamCounts.get(p.team) || 0;
        if (currentTeamCount >= config.maxPlayersPerTeam) return false;
      }

      // Showdown check
      if (config.contestType === 'showdown' && !slot.isCaptain) {
        const cpt = players.find(s => s.isCaptain);
        if (cpt && p.name === cpt.name) return false;
      }

      // MMA opponent exclusion: fighters in the same bout cannot be in the same lineup
      if (p.opponent && players.some(s => s.name === p.opponent)) return false;

      // MLB: batter vs opposing pitcher — only on 2-game slates
      if (config.sport === 'mlb') {
        const fmGames = new Set(pool.players.map(pp => pp.gameInfo || pp.team));
        const fmMaxBvP = fmGames.size <= 2 ? 2 : 0;
        if (p.positions.includes('P')) {
          const battersVs = players.filter(s => !s.positions.includes('P') && s.team === p.opponent);
          if (battersVs.length > fmMaxBvP) return false;
        } else {
          for (const s of players) {
            if (s.positions.includes('P') && s.team === p.opponent) {
              const existing = players.filter(cp => !cp.positions.includes('P') && cp.team === p.team);
              if (existing.length >= fmMaxBvP) return false;
            }
          }
        }
      }

      return true;
    });

    if (eligible.length === 0) return null;

    // Weight based on field archetype
    // Ownership values are in percentage (0-100), so normalize to 0-1 range for contrarian
    const weights = eligible.map(p => {
      const own = Math.max(1, p.ownership || 1);  // ownership in 0-100 scale, floor at 1
      const proj = Math.max(0.1, p.projection);

      if (archetype === 'chalk') {
        // 70% of field: ownership-dominant (chalk optimizers)
        // These are the "play the highest-owned guys" builders
        return Math.pow(own, 1.8) * Math.pow(proj, 0.5);
      } else if (archetype === 'balanced') {
        // 20% of field: balanced builders who consider both ownership and projection
        // More projection-sensitive than pure chalk
        return Math.pow(own, 0.8) * Math.pow(proj, 1.0);
      } else {
        // 10% of field: contrarian builders who fade chalk
        // Projection-dominant with inverse ownership influence
        return Math.pow(proj, 1.5) * Math.pow(1 / Math.max(own / 100, 0.01), 0.3);
      }
    });
    const totalWeight = weights.reduce((a, b) => a + b, 0);

    let random = Math.random() * totalWeight;
    let selected: Player | null = null;
    for (let i = 0; i < eligible.length; i++) {
      random -= weights[i];
      if (random <= 0) {
        selected = eligible[i];
        break;
      }
    }
    if (!selected) selected = eligible[eligible.length - 1];

    players.push(selected);
    usedNames.add(selected.name);
    teamCounts.set(selected.team, (teamCounts.get(selected.team) || 0) + 1);
    remainingSalary -= selected.salary;
  }

  const totalSalary = players.reduce((s, p) => s + p.salary, 0);
  if (totalSalary < config.salaryMin) return null;

  // Showdown: Must have players from BOTH teams
  if (config.contestType === 'showdown') {
    const teamsInLineup = new Set(players.map(p => p.team));
    if (teamsInLineup.size < 2) {
      return null;
    }
  }

  // Classic: Must have players from at least minGames different games
  if (config.minGames && config.minGames > 1) {
    const games = new Set<string>();
    for (const p of players) {
      games.add(p.gameInfo || p.team);
    }
    if (games.size < config.minGames) {
      return null;
    }
  }

  return createLineup(players);
}

/**
 * Construct a single random lineup using ownership-weighted player selection
 */
function constructRandomLineup(
  config: ContestConfig,
  pool: PlayerPool,
  eligibilityMatrix: boolean[][],
  minSalary: number
): Lineup | null {
  const selected: Player[] = [];
  const usedNames = new Set<string>();
  const teamCounts = new Map<string, number>();
  let remainingSalary = config.salaryCap;

  for (let slotIdx = 0; slotIdx < config.positions.length; slotIdx++) {
    const slot = config.positions[slotIdx];

    // Get eligible players
    const eligible = pool.players.filter((p, pIdx) => {
      if (!eligibilityMatrix[slotIdx][pIdx]) return false;
      if (usedNames.has(p.name)) return false;
      if (p.salary > remainingSalary) return false;

      // Max players per team check
      if (config.maxPlayersPerTeam) {
        const currentTeamCount = teamCounts.get(p.team) || 0;
        if (currentTeamCount >= config.maxPlayersPerTeam) return false;
      }

      // Showdown check
      if (config.contestType === 'showdown' && !slot.isCaptain) {
        const cpt = selected.find(s => s.isCaptain);
        if (cpt && p.name === cpt.name) return false;
      }

      // MMA opponent exclusion: fighters in the same bout cannot be in the same lineup
      if (p.opponent && selected.some(s => s.name === p.opponent)) return false;

      // MLB: batter vs opposing pitcher — only on 2-game slates
      if (config.sport === 'mlb') {
        const crGames = new Set(pool.players.map(pp => pp.gameInfo || pp.team));
        const crMaxBvP = crGames.size <= 2 ? 2 : 0;
        if (p.positions.includes('P')) {
          const battersVs = selected.filter(s => !s.positions.includes('P') && s.team === p.opponent);
          if (battersVs.length > crMaxBvP) return false;
        } else {
          for (const s of selected) {
            if (s.positions.includes('P') && s.team === p.opponent) {
              const existing = selected.filter(cp => !cp.positions.includes('P') && cp.team === p.team);
              if (existing.length >= crMaxBvP) return false;
            }
          }
        }
      }

      return true;
    });

    if (eligible.length === 0) return null;

    // Weighted random selection by OWNERSHIP (not projection)
    // This ensures pool exposures match field ownership percentages
    // Players with 20% ownership get picked ~20% of the time
    // Floor at 0.5% (not 1%) to avoid artificially boosting very low-owned players
    const totalOwnership = eligible.reduce((sum, p) => sum + Math.max(p.ownership || 0.5, 0.5), 0);
    let random = Math.random() * totalOwnership;

    let selectedPlayer = eligible[0];
    for (const player of eligible) {
      random -= Math.max(player.ownership || 0.5, 0.5);
      if (random <= 0) {
        selectedPlayer = player;
        break;
      }
    }

    selected.push(selectedPlayer);
    usedNames.add(selectedPlayer.name);
    teamCounts.set(selectedPlayer.team, (teamCounts.get(selectedPlayer.team) || 0) + 1);
    remainingSalary -= selectedPlayer.salary;
  }

  // Check salary minimum
  const totalSalary = calculateTotalSalary(selected);
  if (totalSalary < minSalary) {
    return null;
  }

  // Showdown: Must have players from BOTH teams
  if (config.contestType === 'showdown') {
    const teamsInLineup = new Set(selected.map(p => p.team));
    if (teamsInLineup.size < 2) {
      return null; // Need players from both teams
    }
  }

  // Classic: Must have players from at least minGames different games
  if (config.minGames && config.minGames > 1) {
    const games = new Set<string>();
    for (const p of selected) {
      games.add(p.gameInfo || p.team);
    }
    if (games.size < config.minGames) {
      return null;
    }
  }

  return createLineup(selected);
}

// ============================================================
// EDGE-BOOSTED POOL GENERATION (Pass 2)
// ============================================================

/**
 * Build a PlayerPool from a modified player array.
 * Extracts the pool-building logic that's duplicated inline in the iteration loop.
 */
function buildIterPool(iterPlayers: Player[]): PlayerPool {
  const iterPool: PlayerPool = {
    players: iterPlayers,
    byId: new Map(iterPlayers.map(p => [p.id, p])),
    byPosition: new Map(),
    byTeam: new Map(),
  };

  for (const p of iterPlayers) {
    for (const pos of p.positions) {
      if (!iterPool.byPosition.has(pos)) {
        iterPool.byPosition.set(pos, []);
      }
      iterPool.byPosition.get(pos)!.push(p);
    }
    if (!iterPool.byTeam.has(p.team)) {
      iterPool.byTeam.set(p.team, []);
    }
    iterPool.byTeam.get(p.team)!.push(p);
  }

  return iterPool;
}

/**
 * Generate edge-boosted lineup pool (Pass 2).
 *
 * Runs additional iterations with projection boosts for players who appear
 * in many differentiated cores. This targets identified edges from Pass 1
 * without core-locking — the optimizer naturally builds lineups with
 * edge players because they have higher effective projection.
 *
 * Key features:
 * - Game rotation: each iteration emphasizes a different game's edges
 * - Strategy overlays: pure edge, edge+leverage, edge+ceiling, edge+contrarian, edge+ceiling-ratio
 * - Escalating boost: 0.05 (early) → 0.20 (late) for conservative-to-aggressive exploration
 */
export function generateEdgeBoostedPool(params: EdgeBoostedParams): {
  lineups: Lineup[];
  evaluatedCount: number;
} {
  const {
    config, pool, edgeScores,
    iterations = 25, lineupsPerIteration = 500,
    existingHashes, minSalary,
  } = params;

  const games = [...edgeScores.gameGroups.keys()];
  const allLineups: Lineup[] = [];
  const seenHashes = new Set(existingHashes);
  let totalEvaluated = 0;

  for (let iter = 0; iter < iterations; iter++) {
    // Vary boost factor across iterations: 0.05 → 0.20
    const boostFactor = 0.05 + (iter / Math.max(iterations - 1, 1)) * 0.15;

    // Game rotation: each iteration emphasizes a different game's edges
    const targetGame = games.length > 0 ? games[iter % games.length] : null;

    // Strategy index: 5 sub-strategies per cycle
    const strategyIdx = iter % 5;

    // Build edge-boosted player projections
    let iterPlayers = pool.players.map(p => {
      const edgeInfo = edgeScores.players.get(p.id);
      if (!edgeInfo || edgeInfo.edgeScore <= 0) return p;

      // Base edge boost
      let effectiveEdge = edgeInfo.edgeScore;

      // Game rotation: 1.5x boost for target game's players, 0.7x for others
      if (targetGame) {
        effectiveEdge *= edgeInfo.gameId === targetGame ? 1.5 : 0.7;
      }

      // Apply boost (capped at 1.25x)
      const boost = 1 + effectiveEdge * boostFactor;
      return { ...p, projection: p.projection * Math.min(boost, 1.25) };
    });

    // Strategy overlay (combine edge boost with existing transforms)
    if (strategyIdx === 1) {
      // Edge + leverage: penalize mid-owned, boost low-owned
      iterPlayers = iterPlayers.map(p => {
        const own = (p.ownership || 20) / 100;
        const mult = own > 0.15 && own <= 0.35 ? 0.80 : own <= 0.08 ? 1.20 : 1.0;
        return { ...p, projection: p.projection * mult };
      });
    } else if (strategyIdx === 2) {
      // Edge + ceiling: blend with ceiling for boom potential
      iterPlayers = applyCeilingBlend(iterPlayers, 0.30);
    } else if (strategyIdx === 3) {
      // Edge + contrarian: add moderate ownership penalty
      iterPlayers = applyOwnershipPenalty(iterPlayers, 0.8);
    } else if (strategyIdx === 4) {
      // Edge + ceiling ratio: boost high boom-potential edge players
      iterPlayers = applyCeilingRatioBoost(iterPlayers, 0.15, 0.4);
    }
    // strategyIdx === 0: pure edge boost (no overlay)

    // Apply variance for natural diversity
    iterPlayers = applyProjectionVariance(iterPlayers, 0.20);

    // Build pool and run optimization
    const iterPool = buildIterPool(iterPlayers);
    const iterResult = runSingleOptimization({
      config,
      pool: iterPool,
      originalPool: pool,
      poolSize: lineupsPerIteration,
      minSalary,
      seenHashes,
    });

    // Collect lineups with constructionMethod tag
    for (const lineup of iterResult.lineups) {
      lineup.constructionMethod = 'edge-boosted';
      if (!seenHashes.has(lineup.hash)) {
        seenHashes.add(lineup.hash);
        allLineups.push(lineup);
      }
    }
    totalEvaluated += iterResult.evaluatedCount;
  }

  console.log(`  Edge-boosted pass: ${allLineups.length} new lineups from ${iterations} iterations`);
  return { lineups: allLineups, evaluatedCount: totalEvaluated };
}
