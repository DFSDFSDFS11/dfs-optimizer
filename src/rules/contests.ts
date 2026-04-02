/**
 * DFS Optimizer CLI - Contest Rules
 *
 * Defines the official rules for each supported contest type including
 * salary caps, roster construction, and position eligibility.
 */

import { ContestConfig, DFSSite, Sport, ContestType } from '../types';

// ============================================================
// DRAFTKINGS NBA CLASSIC
// ============================================================

/**
 * DraftKings NBA Classic Rules
 *
 * - 8 players: PG, SG, SF, PF, C, G, F, UTIL
 * - $50,000 salary cap
 * - G slot accepts PG or SG
 * - F slot accepts SF or PF
 * - UTIL slot accepts any position
 */
export const DK_NBA_CLASSIC: ContestConfig = {
  site: 'dk',
  sport: 'nba',
  contestType: 'classic',
  salaryCap: 50000,
  salaryMin: 48000,
  rosterSize: 8,
  name: 'DraftKings NBA Classic',
  maxPlayersPerTeam: 4,  // DraftKings limits to 4 players from same team
  minGames: 2,           // Must use players from at least 2 different games
  positions: [
    { name: 'PG', eligible: ['PG'] },
    { name: 'SG', eligible: ['SG'] },
    { name: 'SF', eligible: ['SF'] },
    { name: 'PF', eligible: ['PF'] },
    { name: 'C', eligible: ['C'] },
    { name: 'G', eligible: ['PG', 'SG'] },
    { name: 'F', eligible: ['SF', 'PF'] },
    { name: 'UTIL', eligible: ['PG', 'SG', 'SF', 'PF', 'C'] },
  ],
};

// ============================================================
// DRAFTKINGS NFL CLASSIC
// ============================================================

/**
 * DraftKings NFL Classic Rules
 *
 * - 9 players: QB, RB, RB, WR, WR, WR, TE, FLEX, DST
 * - $50,000 salary cap
 * - FLEX can be RB, WR, or TE
 */
export const DK_NFL_CLASSIC: ContestConfig = {
  site: 'dk',
  sport: 'nfl',
  contestType: 'classic',
  salaryCap: 50000,
  salaryMin: 49000,
  rosterSize: 9,
  name: 'DraftKings NFL Classic',
  positions: [
    { name: 'QB', eligible: ['QB'] },
    { name: 'RB', eligible: ['RB'] },
    { name: 'RB', eligible: ['RB'] },
    { name: 'WR', eligible: ['WR'] },
    { name: 'WR', eligible: ['WR'] },
    { name: 'WR', eligible: ['WR'] },
    { name: 'TE', eligible: ['TE'] },
    { name: 'FLEX', eligible: ['RB', 'WR', 'TE'] },
    { name: 'DST', eligible: ['DST', 'DEF', 'D'] },
  ],
};

// ============================================================
// DRAFTKINGS NBA SHOWDOWN
// ============================================================

/**
 * DraftKings NBA Showdown Rules
 *
 * - 6 players: 1 CPT/MVP + 5 FLEX/UTIL
 * - $50,000 salary cap
 * - Captain/MVP: 1.5x salary AND 1.5x projection (already in CSV)
 * - Same player CANNOT appear as both CPT and FLEX
 * - Must have players from BOTH teams
 * - Captain and FLEX are separate player entries in CSV
 */
export const DK_NBA_SHOWDOWN: ContestConfig = {
  site: 'dk',
  sport: 'nba',
  contestType: 'showdown',
  salaryCap: 50000,
  salaryMin: 0, // No minimum for showdown
  rosterSize: 6,
  name: 'DraftKings NBA Showdown',
  positions: [
    { name: 'CPT', eligible: ['CPT'], isCaptain: true },
    { name: 'UTIL', eligible: ['FLEX'] },
    { name: 'UTIL', eligible: ['FLEX'] },
    { name: 'UTIL', eligible: ['FLEX'] },
    { name: 'UTIL', eligible: ['FLEX'] },
    { name: 'UTIL', eligible: ['FLEX'] },
  ],
};

// ============================================================
// DRAFTKINGS NFL SHOWDOWN
// ============================================================

/**
 * DraftKings NFL Showdown Rules
 *
 * - 6 players: 1 CPT + 5 FLEX
 * - $50,000 salary cap
 * - Captain: 1.5x salary AND 1.5x projection
 * - Same player CANNOT appear as both CPT and FLEX
 * - Captain and FLEX are separate player entries in CSV
 */
export const DK_NFL_SHOWDOWN: ContestConfig = {
  site: 'dk',
  sport: 'nfl',
  contestType: 'showdown',
  salaryCap: 50000,
  salaryMin: 0, // No minimum for showdown
  rosterSize: 6,
  name: 'DraftKings NFL Showdown',
  positions: [
    { name: 'CPT', eligible: ['CPT'], isCaptain: true },
    { name: 'FLEX', eligible: ['FLEX'] },
    { name: 'FLEX', eligible: ['FLEX'] },
    { name: 'FLEX', eligible: ['FLEX'] },
    { name: 'FLEX', eligible: ['FLEX'] },
    { name: 'FLEX', eligible: ['FLEX'] },
  ],
};

// ============================================================
// DRAFTKINGS MMA
// ============================================================

/**
 * DraftKings MMA Rules
 *
 * - 6 fighters: F, F, F, F, F, F
 * - $50,000 salary cap
 * - All positions are Fighter (F)
 * - Each fighter is their own "team"
 */
export const DK_MMA_CLASSIC: ContestConfig = {
  site: 'dk',
  sport: 'mma',
  contestType: 'classic',
  salaryCap: 50000,
  salaryMin: 0, // No minimum for MMA
  rosterSize: 6,
  name: 'DraftKings MMA',
  positions: [
    { name: 'F', eligible: ['F'] },
    { name: 'F', eligible: ['F'] },
    { name: 'F', eligible: ['F'] },
    { name: 'F', eligible: ['F'] },
    { name: 'F', eligible: ['F'] },
    { name: 'F', eligible: ['F'] },
  ],
};

// ============================================================
// DRAFTKINGS NASCAR
// ============================================================

/**
 * DraftKings NASCAR Rules
 *
 * - 6 drivers: D, D, D, D, D, D
 * - $50,000 salary cap
 * - All positions are Driver (D)
 * - No team constraints (individual sport)
 */
export const DK_NASCAR_CLASSIC: ContestConfig = {
  site: 'dk',
  sport: 'nascar',
  contestType: 'classic',
  salaryCap: 50000,
  salaryMin: 0,
  rosterSize: 6,
  name: 'DraftKings NASCAR',
  positions: [
    { name: 'D', eligible: ['D'] },
    { name: 'D', eligible: ['D'] },
    { name: 'D', eligible: ['D'] },
    { name: 'D', eligible: ['D'] },
    { name: 'D', eligible: ['D'] },
    { name: 'D', eligible: ['D'] },
  ],
};

// ============================================================
// DRAFTKINGS GOLF
// ============================================================

/**
 * DraftKings Golf (PGA) Classic Rules
 *
 * - 6 golfers: G, G, G, G, G, G
 * - $50,000 salary cap
 * - All positions are Golfer (G)
 * - No team constraints (individual sport)
 */
export const DK_GOLF_CLASSIC: ContestConfig = {
  site: 'dk',
  sport: 'golf',
  contestType: 'classic',
  salaryCap: 50000,
  salaryMin: 0,
  rosterSize: 6,
  name: 'DraftKings Golf',
  positions: [
    { name: 'G', eligible: ['G'] },
    { name: 'G', eligible: ['G'] },
    { name: 'G', eligible: ['G'] },
    { name: 'G', eligible: ['G'] },
    { name: 'G', eligible: ['G'] },
    { name: 'G', eligible: ['G'] },
  ],
};

// ============================================================
// FANDUEL NBA
// ============================================================

/**
 * FanDuel NBA Rules
 *
 * - 9 players: PG, PG, SG, SG, SF, SF, PF, PF, C
 * - $60,000 salary cap
 * - Each position slot requires exact position match
 * - MAX 4 PLAYERS PER TEAM (FanDuel rule)
 */
export const FD_NBA_CLASSIC: ContestConfig = {
  site: 'fd',
  sport: 'nba',
  contestType: 'classic',
  salaryCap: 60000,
  salaryMin: 57000,
  rosterSize: 9,
  name: 'FanDuel NBA',
  maxPlayersPerTeam: 4,  // FanDuel enforces max 4 from same team
  positions: [
    { name: 'PG', eligible: ['PG'] },
    { name: 'PG', eligible: ['PG'] },
    { name: 'SG', eligible: ['SG'] },
    { name: 'SG', eligible: ['SG'] },
    { name: 'SF', eligible: ['SF'] },
    { name: 'SF', eligible: ['SF'] },
    { name: 'PF', eligible: ['PF'] },
    { name: 'PF', eligible: ['PF'] },
    { name: 'C', eligible: ['C'] },
  ],
};

// ============================================================
// FANDUEL NFL CLASSIC
// ============================================================

/**
 * FanDuel NFL Classic Rules
 *
 * - 9 players: QB, RB, RB, WR, WR, WR, TE, FLEX, DEF
 * - $60,000 salary cap
 * - FLEX can be RB, WR, or TE
 */
export const FD_NFL_CLASSIC: ContestConfig = {
  site: 'fd',
  sport: 'nfl',
  contestType: 'classic',
  salaryCap: 60000,
  salaryMin: 58000,
  rosterSize: 9,
  name: 'FanDuel NFL Classic',
  positions: [
    { name: 'QB', eligible: ['QB'] },
    { name: 'RB', eligible: ['RB'] },
    { name: 'RB', eligible: ['RB'] },
    { name: 'WR', eligible: ['WR'] },
    { name: 'WR', eligible: ['WR'] },
    { name: 'WR', eligible: ['WR'] },
    { name: 'TE', eligible: ['TE'] },
    { name: 'FLEX', eligible: ['RB', 'WR', 'TE'] },
    { name: 'DEF', eligible: ['DST', 'DEF', 'D'] },
  ],
};

// ============================================================
// CONFIGURATION LOOKUP
// ============================================================

/**
 * Get contest configuration for given parameters
 */
export function getContestConfig(
  site: DFSSite,
  sport: Sport,
  contestType: ContestType
): ContestConfig {
  // DraftKings NBA Classic
  if (site === 'dk' && sport === 'nba' && contestType === 'classic') {
    return DK_NBA_CLASSIC;
  }

  // DraftKings NBA Showdown
  if (site === 'dk' && sport === 'nba' && contestType === 'showdown') {
    return DK_NBA_SHOWDOWN;
  }

  // DraftKings NFL Classic
  if (site === 'dk' && sport === 'nfl' && contestType === 'classic') {
    return DK_NFL_CLASSIC;
  }

  // DraftKings NFL Showdown
  if (site === 'dk' && sport === 'nfl' && contestType === 'showdown') {
    return DK_NFL_SHOWDOWN;
  }

  // FanDuel NBA
  if (site === 'fd' && sport === 'nba' && contestType === 'classic') {
    return FD_NBA_CLASSIC;
  }

  // FanDuel NFL Classic
  if (site === 'fd' && sport === 'nfl' && contestType === 'classic') {
    return FD_NFL_CLASSIC;
  }

  // DraftKings MMA
  if (site === 'dk' && sport === 'mma') {
    return DK_MMA_CLASSIC;
  }

  // DraftKings NASCAR
  if (site === 'dk' && sport === 'nascar') {
    return DK_NASCAR_CLASSIC;
  }

  // DraftKings Golf
  if (site === 'dk' && sport === 'golf') {
    return DK_GOLF_CLASSIC;
  }

  // Default to DK NBA Classic
  console.warn(`Unknown contest configuration: ${site}/${sport}/${contestType}, defaulting to DK NBA Classic`);
  return DK_NBA_CLASSIC;
}

/**
 * Validate a contest configuration
 */
export function validateConfig(config: ContestConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (config.salaryCap <= 0) {
    errors.push('Salary cap must be positive');
  }

  if (config.rosterSize <= 0) {
    errors.push('Roster size must be positive');
  }

  if (config.positions.length !== config.rosterSize) {
    errors.push(`Position count (${config.positions.length}) must match roster size (${config.rosterSize})`);
  }

  if (config.salaryMin > config.salaryCap) {
    errors.push('Salary minimum cannot exceed salary cap');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
