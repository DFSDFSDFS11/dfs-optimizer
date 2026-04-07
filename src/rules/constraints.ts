/**
 * DFS Optimizer CLI - Constraint System
 *
 * Implements all lineup validation rules and constraint checking
 * for optimization pruning and final lineup validation.
 */

import { ContestConfig, Player, PlayerPool, PositionSlot } from '../types';

// ============================================================
// LINEUP VALIDATION
// ============================================================

/**
 * Validate a complete lineup against contest rules.
 * This is the final check before accepting a lineup.
 */
export function validateLineup(
  players: Player[],
  config: ContestConfig
): { valid: boolean; error?: string } {
  // Check roster size
  if (players.length !== config.rosterSize) {
    return {
      valid: false,
      error: `Lineup has ${players.length} players, need exactly ${config.rosterSize}`,
    };
  }

  // Check for duplicate players (by name for showdown)
  const names = players.map(p => p.name);
  const uniqueNames = new Set(names);
  if (uniqueNames.size !== players.length) {
    return {
      valid: false,
      error: 'Lineup contains duplicate players',
    };
  }

  // Calculate total salary
  const totalSalary = players.reduce((sum, p) => sum + p.salary, 0);

  // Check salary cap - NEVER exceed
  if (totalSalary > config.salaryCap) {
    return {
      valid: false,
      error: `Salary $${totalSalary} exceeds cap of $${config.salaryCap}`,
    };
  }

  // Check salary minimum
  if (totalSalary < config.salaryMin) {
    return {
      valid: false,
      error: `Salary $${totalSalary} below minimum of $${config.salaryMin}`,
    };
  }

  // Check max players per team (DraftKings/FanDuel rule)
  // Skip players with empty team (MMA, golf, NASCAR use player names as teams)
  if (config.maxPlayersPerTeam) {
    const teamCounts = new Map<string, number>();
    for (const player of players) {
      if (!player.team) continue;
      const count = (teamCounts.get(player.team) || 0) + 1;
      teamCounts.set(player.team, count);
      if (count > config.maxPlayersPerTeam) {
        return {
          valid: false,
          error: `Too many players from ${player.team} (max ${config.maxPlayersPerTeam})`,
        };
      }
    }
  }

  // Check minimum games requirement (DraftKings rule - must use players from at least 2 games)
  if (config.minGames && config.minGames > 1) {
    const games = new Set<string>();
    for (const player of players) {
      // Use gameInfo if available, otherwise derive from team
      // gameInfo format is typically "TEAM1@TEAM2" or "TEAM1vsTEAM2"
      if (player.gameInfo) {
        games.add(player.gameInfo);
      } else {
        // Fallback: treat each team as being in a unique game
        // This is imperfect but prevents single-team lineups
        games.add(player.team);
      }
    }
    if (games.size < config.minGames) {
      return {
        valid: false,
        error: `Lineup uses players from only ${games.size} game(s), need at least ${config.minGames}`,
      };
    }
  }

  // MMA opponent exclusion: fighters in the same bout cannot be in the same lineup
  if (config.sport === 'mma') {
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        if (players[i].opponent && players[i].opponent === players[j].name) {
          return {
            valid: false,
            error: `${players[i].name} and ${players[j].name} are opponents in the same bout`,
          };
        }
        if (players[j].opponent && players[j].opponent === players[i].name) {
          return {
            valid: false,
            error: `${players[i].name} and ${players[j].name} are opponents in the same bout`,
          };
        }
      }
    }
  }

  // MLB constraints: batter vs opposing pitcher, min 4-man batter stack
  if (config.sport === 'mlb') {
    const pitchers = players.filter(p => p.positions.includes('P'));
    const batters = players.filter(p => !p.positions.includes('P'));

    // Detect number of games from player game info
    const mlbGames = new Set<string>();
    for (const p of players) {
      if (p.gameInfo) mlbGames.add(p.gameInfo);
    }
    const slateGames = mlbGames.size || 99; // default to large if unknown

    // 2-game slates: allow up to 2 batters vs opposing pitcher (bring-back captures game total,
    // and the limited player pool makes strict avoidance impractical)
    // 3+ game slates: NO batters vs opposing pitcher (enough games to avoid it)
    const maxBattersVsPitcher = slateGames <= 2 ? 2 : 0;

    for (const pitcher of pitchers) {
      const battersVsPitcher = batters.filter(b => b.team === pitcher.opponent);
      if (battersVsPitcher.length > maxBattersVsPitcher) {
        return {
          valid: false,
          error: `${battersVsPitcher.length} batters vs pitcher ${pitcher.name} (max ${maxBattersVsPitcher} on ${slateGames}-game slate)`,
        };
      }
    }

    // Min 4-man batter stack from same team
    const batterTeamCounts = new Map<string, number>();
    for (const b of batters) {
      batterTeamCounts.set(b.team, (batterTeamCounts.get(b.team) || 0) + 1);
    }
    const maxBatterStack = Math.max(...batterTeamCounts.values(), 0);
    if (maxBatterStack < 4) {
      return {
        valid: false,
        error: `Largest batter stack is ${maxBatterStack} (min 4 required)`,
      };
    }
  }

  // Check position eligibility for each slot
  for (let i = 0; i < config.positions.length; i++) {
    const slot = config.positions[i];
    const player = players[i];

    if (!isEligibleForSlot(player, slot)) {
      return {
        valid: false,
        error: `${player.name} (${player.positions.join('/')}) not eligible for ${slot.name} slot`,
      };
    }
  }

  // For showdown, verify CPT is in CPT slot and not duplicated
  if (config.contestType === 'showdown') {
    const cptSlot = config.positions.find(p => p.isCaptain);
    if (cptSlot) {
      const cptIndex = config.positions.indexOf(cptSlot);
      const cptPlayer = players[cptIndex];

      if (!cptPlayer.isCaptain) {
        return {
          valid: false,
          error: 'Captain slot must contain a CPT player entry',
        };
      }

      // Check that CPT player name doesn't appear in FLEX
      const flexPlayers = players.filter((_, idx) => idx !== cptIndex);
      if (flexPlayers.some(f => f.name === cptPlayer.name)) {
        return {
          valid: false,
          error: `${cptPlayer.name} cannot be both Captain and FLEX`,
        };
      }
    }
  }

  return { valid: true };
}

/**
 * Check if a player is eligible for a position slot
 */
export function isEligibleForSlot(player: Player, slot: PositionSlot): boolean {
  // For showdown CPT slot, must be a CPT entry
  if (slot.isCaptain) {
    return player.isCaptain === true;
  }

  // For showdown FLEX slots (no eligible positions defined), must NOT be a CPT entry
  // But for classic FLEX (has eligible positions), must check position eligibility
  if (slot.name.startsWith('FLEX') || slot.name.startsWith('UTIL')) {
    // Showdown FLEX/UTIL has no position restrictions (any non-CPT player)
    if (slot.eligible.length === 0 || (slot.eligible.length === 1 && slot.eligible[0] === 'FLEX')) {
      return player.isCaptain !== true;
    }
    // Classic FLEX must match eligible positions (RB/WR/TE)
    return player.positions.some(pos => slot.eligible.includes(pos));
  }

  // For standard slots, check position eligibility
  return player.positions.some(pos => slot.eligible.includes(pos));
}

// ============================================================
// ELIGIBILITY MATRIX
// ============================================================

/**
 * Build eligibility matrix for fast lookup during optimization.
 * Matrix[slotIndex][playerIndex] = true if player can fill slot.
 */
export function buildEligibilityMatrix(
  pool: PlayerPool,
  config: ContestConfig
): boolean[][] {
  const matrix: boolean[][] = [];

  for (const slot of config.positions) {
    const slotEligibility: boolean[] = [];
    for (const player of pool.players) {
      slotEligibility.push(isEligibleForSlot(player, slot));
    }
    matrix.push(slotEligibility);
  }

  return matrix;
}

/**
 * Get all players eligible for a specific slot
 */
export function getEligiblePlayers(pool: PlayerPool, slot: PositionSlot): Player[] {
  return pool.players.filter(p => isEligibleForSlot(p, slot));
}

// ============================================================
// PRUNING BOUNDS
// ============================================================

/**
 * Calculate upper bound on projection for remaining slots.
 * Used for branch-and-bound pruning.
 */
export function calculateProjectionUpperBound(
  config: ContestConfig,
  pool: PlayerPool,
  usedPlayers: Set<string>,
  currentSlot: number,
  remainingSalary: number,
  eligibilityMatrix: boolean[][]
): number {
  let upperBound = 0;
  const tempUsed = new Set(usedPlayers);
  let tempSalary = remainingSalary;

  // For each remaining slot, find best available player
  for (let i = currentSlot; i < config.positions.length; i++) {
    let bestProj = 0;
    let bestPlayer: Player | null = null;

    for (let j = 0; j < pool.players.length; j++) {
      const player = pool.players[j];

      // Skip if not eligible for this slot
      if (!eligibilityMatrix[i][j]) continue;

      // Skip if already used
      if (tempUsed.has(player.name)) continue;

      // Skip if would exceed remaining salary
      if (player.salary > tempSalary) continue;

      if (player.projection > bestProj) {
        bestProj = player.projection;
        bestPlayer = player;
      }
    }

    if (bestPlayer) {
      upperBound += bestProj;
      tempUsed.add(bestPlayer.name);
      tempSalary -= bestPlayer.salary;
    }
  }

  return upperBound;
}

/**
 * Calculate minimum salary needed to fill remaining slots
 */
export function calculateMinSalaryNeeded(
  config: ContestConfig,
  pool: PlayerPool,
  usedPlayers: Set<string>,
  currentSlot: number,
  eligibilityMatrix: boolean[][]
): number {
  let minNeeded = 0;
  const tempUsed = new Set(usedPlayers);

  for (let i = currentSlot; i < config.positions.length; i++) {
    let minSalary = Infinity;
    let minPlayer: Player | null = null;

    for (let j = 0; j < pool.players.length; j++) {
      const player = pool.players[j];

      if (!eligibilityMatrix[i][j]) continue;
      if (tempUsed.has(player.name)) continue;

      if (player.salary < minSalary) {
        minSalary = player.salary;
        minPlayer = player;
      }
    }

    if (minPlayer) {
      minNeeded += minSalary;
      tempUsed.add(minPlayer.name);
    } else {
      return Infinity; // Cannot fill remaining slots
    }
  }

  return minNeeded;
}

/**
 * Check if lineup can still meet salary minimum
 */
export function canMeetSalaryMinimum(
  currentSalary: number,
  remainingSlots: number,
  maxSalaryPerSlot: number,
  salaryMin: number
): boolean {
  const maxPossible = currentSalary + remainingSlots * maxSalaryPerSlot;
  return maxPossible >= salaryMin;
}

// ============================================================
// SALARY CALCULATIONS
// ============================================================

/**
 * Calculate total salary for a set of players
 */
export function calculateTotalSalary(players: Player[]): number {
  return players.reduce((sum, p) => sum + p.salary, 0);
}

/**
 * Calculate total projection for a set of players
 */
export function calculateTotalProjection(players: Player[]): number {
  return players.reduce((sum, p) => sum + p.projection, 0);
}

/**
 * Calculate ownership product for a lineup
 */
export function calculateOwnership(players: Player[]): number {
  return players.reduce((prod, p) => {
    const own = p.ownership / 100;
    return prod * (own > 0 ? own : 0.01);
  }, 1);
}

// ============================================================
// BITMAP-BASED BOUNDS (optimized for B&B hot loop)
// ============================================================

/**
 * Maps player names to all pool indices sharing that name.
 * Handles showdown where CPT/FLEX entries share a name but have different indices.
 */
export interface PlayerNameMap {
  nameToIndices: Map<string, number[]>;
  playerCount: number;
}

export function buildPlayerNameMap(pool: PlayerPool): PlayerNameMap {
  const nameToIndices = new Map<string, number[]>();
  for (let i = 0; i < pool.players.length; i++) {
    const name = pool.players[i].name;
    const arr = nameToIndices.get(name);
    if (arr) {
      arr.push(i);
    } else {
      nameToIndices.set(name, [i]);
    }
  }
  return { nameToIndices, playerCount: pool.players.length };
}

/**
 * Pre-sorted eligible player indices per slot.
 * byProjDesc[slot] = indices sorted by projection descending (for upper bound)
 * bySalaryAsc[slot] = indices sorted by salary ascending (for min salary)
 */
export function buildSortedEligiblePerSlot(
  pool: PlayerPool,
  config: ContestConfig,
  eligibilityMatrix: boolean[][]
): { byProjDesc: number[][]; bySalaryAsc: number[][] } {
  const byProjDesc: number[][] = [];
  const bySalaryAsc: number[][] = [];

  for (let slot = 0; slot < config.positions.length; slot++) {
    const eligible: number[] = [];
    for (let j = 0; j < pool.players.length; j++) {
      if (eligibilityMatrix[slot][j]) eligible.push(j);
    }
    byProjDesc.push(
      [...eligible].sort((a, b) => pool.players[b].projection - pool.players[a].projection)
    );
    bySalaryAsc.push(
      [...eligible].sort((a, b) => pool.players[a].salary - pool.players[b].salary)
    );
  }

  return { byProjDesc, bySalaryAsc };
}

/**
 * Bitmap-based upper bound on projection for remaining slots.
 * Replaces calculateProjectionUpperBound — zero allocation per call.
 *
 * positionOrder[startDepth..] gives the remaining unfilled slot indices.
 * Uses a small tempUsed array (max rosterSize entries) for the greedy relaxation.
 */
export function upperBoundBitmap(
  pool: PlayerPool,
  usedBitmap: Uint8Array,
  remainingSalary: number,
  byProjDesc: number[][],
  nameMap: PlayerNameMap,
  positionOrder: number[],
  remainingSlotsLen: number,
  startDepth: number
): number {
  let upperBound = 0;
  let tempSalary = remainingSalary;
  const tempUsedIndices: number[] = [];

  for (let ri = 0; ri < remainingSlotsLen; ri++) {
    const slot = positionOrder[startDepth + ri];
    const sorted = byProjDesc[slot];
    for (let k = 0; k < sorted.length; k++) {
      const j = sorted[k];
      if (usedBitmap[j]) continue;
      if (tempUsedIndices.includes(j)) continue;
      const player = pool.players[j];
      if (player.salary > tempSalary) continue;

      upperBound += player.projection;
      tempSalary -= player.salary;
      const indices = nameMap.nameToIndices.get(player.name)!;
      for (let m = 0; m < indices.length; m++) {
        tempUsedIndices.push(indices[m]);
      }
      break;
    }
  }

  return upperBound;
}

/**
 * Bitmap-based minimum salary needed for remaining slots.
 * Replaces calculateMinSalaryNeeded — zero allocation per call.
 *
 * positionOrder[startDepth..] gives the remaining unfilled slot indices.
 */
export function minSalaryBitmap(
  pool: PlayerPool,
  usedBitmap: Uint8Array,
  bySalaryAsc: number[][],
  nameMap: PlayerNameMap,
  positionOrder: number[],
  remainingSlotsLen: number,
  startDepth: number
): number {
  let minNeeded = 0;
  const tempUsedIndices: number[] = [];

  for (let ri = 0; ri < remainingSlotsLen; ri++) {
    const slot = positionOrder[startDepth + ri];
    const sorted = bySalaryAsc[slot];
    let found = false;
    for (let k = 0; k < sorted.length; k++) {
      const j = sorted[k];
      if (usedBitmap[j]) continue;
      if (tempUsedIndices.includes(j)) continue;

      const player = pool.players[j];
      minNeeded += player.salary;
      const indices = nameMap.nameToIndices.get(player.name)!;
      for (let m = 0; m < indices.length; m++) {
        tempUsedIndices.push(indices[m]);
      }
      found = true;
      break;
    }
    if (!found) return Infinity;
  }

  return minNeeded;
}
