/**
 * DFS Optimizer CLI - CSV Parser
 *
 * Handles parsing of SaberSim CSV exports into Player objects.
 * Supports multiple column naming conventions.
 * Auto-detects showdown vs classic based on file content.
 */

import * as fs from 'fs';
import { parse } from 'csv-parse/sync';
import { Player, PlayerPool, PlayerPercentiles, RawPlayer, Sport, ContestType, LockStatus } from '../types';

// ============================================================
// CONTEST TYPE DETECTION
// ============================================================

export interface ParseResult {
  players: RawPlayer[];
  detectedContestType: ContestType;
  teams: string[];
}

/**
 * Detect if a CSV is showdown or classic based on content
 * Showdown detection methods:
 * 1. Position column has CPT/MVP entries
 * 2. Duplicate player names with different salaries (CPT = 1.5x salary)
 */
function detectContestType(
  records: Record<string, string>[],
  posCol: string,
  nameCol: string,
  salaryCol: string
): ContestType {
  // Method 1: Check for CPT/MVP in position column
  for (const row of records) {
    const position = row[posCol]?.toString().toUpperCase() || '';
    if (position.includes('CPT') || position.includes('MVP') || position.includes('CAPTAIN')) {
      return 'showdown';
    }
  }

  // Method 2: Check for duplicate players with different salaries (showdown format)
  // In showdown, each player appears twice - once as CPT (1.5x salary) and once as FLEX
  const playerSalaries = new Map<string, number[]>();
  for (const row of records) {
    const name = row[nameCol]?.toString().trim();
    const salary = parseFloat(row[salaryCol]?.toString().replace(/[$,]/g, '') || '0');
    if (name && salary > 0) {
      if (!playerSalaries.has(name)) {
        playerSalaries.set(name, []);
      }
      playerSalaries.get(name)!.push(salary);
    }
  }

  // Count players with exactly 2 different salaries where one is ~1.5x the other
  let duplicateCount = 0;
  for (const [name, salaries] of playerSalaries) {
    if (salaries.length === 2) {
      const [s1, s2] = salaries.sort((a, b) => a - b);
      const ratio = s2 / s1;
      // CPT salary is 1.5x FLEX salary (allow some tolerance)
      if (ratio >= 1.4 && ratio <= 1.6) {
        duplicateCount++;
      }
    }
  }

  // If most players have duplicate entries with 1.5x salary ratio, it's showdown
  const totalUniquePlayers = playerSalaries.size;
  if (duplicateCount > 0 && duplicateCount >= totalUniquePlayers * 0.5) {
    return 'showdown';
  }

  return 'classic';
}

// ============================================================
// COLUMN MAPPINGS
// ============================================================

/**
 * Maps various column name formats to internal field names.
 * SaberSim and other tools use different naming conventions.
 */
const COLUMN_MAPPINGS: Record<string, string[]> = {
  id: ['DFS ID', 'ID', 'Player ID', 'PlayerId', 'id', 'DFS Id', 'player_id', 'partner_id'],
  name: ['Name', 'Player', 'Player Name', 'name', 'Nickname'],
  position: ['Roster Position', 'Position', 'Pos', 'pos', 'position'],
  team: ['Team', 'TeamAbbrev', 'team', 'Tm'],
  salary: ['Salary', 'salary', 'Sal', 'DK Salary', 'FD Salary'],
  projection: ['My Proj', 'SS Proj', 'Projection', 'Proj', 'projection', 'Fpts', 'fpts', 'AvgPointsPerGame'],
  ownership: ['My Own', 'Adj Own', 'Own', 'Ownership', 'ownership', 'Own%', 'pOwn', 'proj_own'],
  ceiling: ['dk_85_percentile', 'dk_95_percentile', 'Ceiling', 'ceiling', 'ceil', '85th', '95th'],
  ceiling99: ['dk_99_percentile', '99th'],
  gameTotal: ['Saber Total', 'Game Total', 'Total', 'Vegas Total', 'O/U'],
  status: ['Status', 'status', 'Game Status', 'Player Status', 'Injury Status'],
  game: ['Game', 'game', 'Matchup', 'Game Info', 'GameInfo'],
  opponent: ['Opponent', 'Opp', 'opp', 'Vs', 'vs', 'OpponentAbbrev'],
  stdDev: ['dk_std', 'std', 'StdDev', 'Std Dev', 'Standard Deviation', 'Stdev'],
  minutes: ['Min', 'Minutes', 'minutes', 'Mins', 'MP', 'Projected Minutes'],
  teamTotal: ['Team Total', 'Implied Total', 'Implied Team Total', 'Tm Total', 'Team Implied', 'Team Imp Total'],
};

/**
 * Find actual column name in CSV headers
 */
function findColumn(headers: string[], fieldName: string): string | null {
  const possibleNames = COLUMN_MAPPINGS[fieldName];
  if (!possibleNames) return null;

  // Try exact match first
  for (const name of possibleNames) {
    if (headers.includes(name)) return name;
  }

  // Try case-insensitive match
  const lowerHeaders = headers.map(h => h.toLowerCase().trim());
  for (const name of possibleNames) {
    const idx = lowerHeaders.indexOf(name.toLowerCase());
    if (idx !== -1) return headers[idx];
  }

  return null;
}

// ============================================================
// CSV PARSING
// ============================================================

/**
 * Parse a CSV file and return raw player data with auto-detection
 * @param includeZeroProjection - If true, include players with 0 projection (for late swap)
 */
export function parseCSVFile(filePath: string, sport: Sport, includeZeroProjection: boolean = false): ParseResult {
  // Read file
  if (!fs.existsSync(filePath)) {
    throw new Error(`Input file not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');

  // Parse CSV
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  if (records.length === 0) {
    throw new Error('CSV file is empty or has no valid rows');
  }

  // Get headers from first record
  const headers = Object.keys(records[0]);

  // Find column mappings
  const idCol = findColumn(headers, 'id');
  const nameCol = findColumn(headers, 'name');
  const posCol = findColumn(headers, 'position');
  const teamCol = findColumn(headers, 'team');
  const salaryCol = findColumn(headers, 'salary');
  const projCol = findColumn(headers, 'projection');
  const ownCol = findColumn(headers, 'ownership');
  const ceilingCol = findColumn(headers, 'ceiling');
  const ceiling99Col = findColumn(headers, 'ceiling99');
  const gameTotalCol = findColumn(headers, 'gameTotal');
  const gameCol = findColumn(headers, 'game');
  const opponentCol = findColumn(headers, 'opponent');
  const stdDevCol = findColumn(headers, 'stdDev');
  const minutesCol = findColumn(headers, 'minutes');
  const teamTotalCol = findColumn(headers, 'teamTotal');

  // SaberSim full percentile distribution columns (6 points on each player's CDF)
  const p25Col = headers.find(h => h === 'dk_25_percentile') || null;
  const p50Col = headers.find(h => h === 'dk_50_percentile') || null;
  const p75Col = headers.find(h => h === 'dk_75_percentile') || null;
  const p85Col = headers.find(h => h === 'dk_85_percentile') || null;
  const p95Col = headers.find(h => h === 'dk_95_percentile') || null;
  const p99Col = headers.find(h => h === 'dk_99_percentile') || null;
  const hasPercentiles = !!(p25Col && p50Col && p75Col && p85Col && p95Col && p99Col);

  // Validate required columns
  const missing: string[] = [];
  if (!idCol) missing.push('ID');
  if (!nameCol) missing.push('Name');
  if (!posCol) missing.push('Position');
  if (!salaryCol) missing.push('Salary');
  if (!projCol) missing.push('Projection');

  if (missing.length > 0) {
    throw new Error(`Missing required CSV columns: ${missing.join(', ')}\nFound columns: ${headers.join(', ')}`);
  }

  // Auto-detect contest type
  const detectedContestType = detectContestType(records, posCol!, nameCol!, salaryCol!);

  // For showdown detection via duplicate players, build a map of player name -> max salary
  // The higher salary version is CPT (1.5x), lower is FLEX
  const playerMaxSalary = new Map<string, number>();
  if (detectedContestType === 'showdown') {
    for (const row of records) {
      const name = row[nameCol!]?.toString().trim();
      const salary = parseNumber(row[salaryCol!]);
      if (name && salary > 0) {
        const current = playerMaxSalary.get(name) || 0;
        if (salary > current) {
          playerMaxSalary.set(name, salary);
        }
      }
    }
  }

  // Parse players
  const players: RawPlayer[] = [];
  const teamsSet = new Set<string>();
  const gamesSet = new Set<string>();

  for (const row of records) {
    const id = row[idCol!]?.toString().trim();
    const name = row[nameCol!]?.toString().trim();
    const position = row[posCol!]?.toString().trim();
    const team = teamCol ? row[teamCol]?.toString().trim() : '';
    const salary = parseNumber(row[salaryCol!]);
    const projection = parseNumber(row[projCol!]);
    const ownership = ownCol ? parseNumber(row[ownCol]) : 20;
    const rawCeiling = ceilingCol ? parseNumber(row[ceilingCol]) : projection * 1.3;
    const ceiling = Math.max(projection, rawCeiling); // ceiling must be >= projection (data integrity)
    const ceiling99 = ceiling99Col ? parseNumber(row[ceiling99Col]) : ceiling * 1.15;
    const gameTotal = gameTotalCol ? parseNumber(row[gameTotalCol]) : 220;
    const stdDev = stdDevCol ? parseNumber(row[stdDevCol]) : 0;
    const minutes = minutesCol ? parseNumber(row[minutesCol]) : 0;
    const teamTotal = teamTotalCol ? parseNumber(row[teamTotalCol]) : 0;

    // Extract game info for minGames constraint (DraftKings rule)
    let gameInfo: string | undefined;
    let opponent: string | undefined;
    if (gameCol) {
      // Game column exists (e.g., "LAL@DEN" or "LAL vs DEN")
      gameInfo = row[gameCol]?.toString().trim();
    }
    if (opponentCol) {
      opponent = row[opponentCol]?.toString().trim();
    }
    // If no explicit game column but we have team + opponent, construct game info
    if (!gameInfo && team && opponent) {
      // Create a normalized game identifier (alphabetically sorted to ensure consistency)
      const teams = [team, opponent].sort();
      gameInfo = `${teams[0]}@${teams[1]}`;
    }

    // Skip invalid rows
    if (!id || !name || !position || salary <= 0) {
      continue;
    }

    // Skip players with 0 projection (likely out) unless includeZeroProjection is set
    if (projection <= 0 && !includeZeroProjection) {
      continue;
    }

    // Track teams
    if (team) {
      teamsSet.add(team);
    }

    // Track games for minGames validation
    if (gameInfo) {
      gamesSet.add(gameInfo);
    }

    // Determine if this is a CPT/MVP entry for showdown
    const posUpper = position.toUpperCase();
    let isCaptain = posUpper.includes('CPT') || posUpper.includes('MVP') || posUpper.includes('CAPTAIN');

    // For showdown with duplicate players: higher salary = CPT
    if (detectedContestType === 'showdown' && !isCaptain) {
      const maxSalary = playerMaxSalary.get(name) || 0;
      if (salary === maxSalary && maxSalary > 0) {
        isCaptain = true;
      }
    }

    // For showdown, override position to CPT or FLEX
    let effectivePosition = position;
    if (detectedContestType === 'showdown') {
      effectivePosition = isCaptain ? 'CPT' : 'FLEX';
    }

    // Parse full percentile distribution if available
    let percentiles: PlayerPercentiles | undefined;
    if (hasPercentiles) {
      const p25 = parseNumber(row[p25Col!]);
      const p50 = parseNumber(row[p50Col!]);
      const p75 = parseNumber(row[p75Col!]);
      const p85 = parseNumber(row[p85Col!]);
      const p95 = parseNumber(row[p95Col!]);
      const p99 = parseNumber(row[p99Col!]);

      // Validate percentiles are monotonically increasing
      if (p25 && p50 && p75 && p85 && p95 && p99) {
        if (p25 > p50 || p50 > p75 || p75 > p85 || p85 > p95 || p95 > p99) {
          console.warn(`  Warning: Non-monotonic percentiles for ${name} (p25=${p25}, p50=${p50}, p75=${p75}, p85=${p85}, p95=${p95}, p99=${p99})`);
        }
      } else if (p25 && p50 && p75 && (p25 > p50 || p50 > p75)) {
        console.warn(`  Warning: Inverted percentiles for ${name} (p25=${p25}, p50=${p50}, p75=${p75})`);
      }

      percentiles = {
        p25,
        p50,
        p75,
        p85,
        p95,
        p99,
      };
    }

    players.push({
      id,
      name,
      position: effectivePosition,
      team,
      salary,
      projection,
      ownership: normalizeOwnership(ownership),
      ceiling,
      ceiling99,
      gameTotal,
      stdDev,
      minutes,
      teamTotal,
      gameInfo,
      opponent,
      isCaptain,
      percentiles,
    });
  }

  if (players.length === 0) {
    throw new Error('No valid players found in CSV');
  }

  // CSV Import Validation Summary
  const missingOwnership = ownCol ? 0 : players.length;
  const missingCeiling = ceilingCol ? 0 : players.length;
  const missingPercentiles = players.filter(p => !p.percentiles?.p25 && !p.percentiles?.p50).length;

  if (missingOwnership > 0 || missingCeiling > 0) {
    console.log(`\n--- CSV IMPORT VALIDATION ---`);
    if (missingOwnership > 0) {
      console.log(`  Using default ownership (20%) for all ${players.length} players - ownership column not found`);
    }
    if (missingCeiling > 0) {
      console.log(`  Using default ceiling (proj × 1.3) for all ${players.length} players - ceiling column not found`);
    }
    if (missingPercentiles > 0) {
      console.log(`  Using Box-Muller distribution for ${missingPercentiles} players without percentile data`);
    }
  }

  const teams = [...teamsSet];
  const games = [...gamesSet];
  console.log(`Parsed ${players.length} players from CSV`);
  console.log(`Auto-detected contest type: ${detectedContestType.toUpperCase()}`);
  if (hasPercentiles) {
    console.log(`Percentile data: 6-point CDF loaded (p25/p50/p75/p85/p95/p99)`);
  }
  console.log(`Teams: ${teams.join(', ')}`);
  if (games.length > 0) {
    console.log(`Games: ${games.length} games detected (${games.slice(0, 5).join(', ')}${games.length > 5 ? '...' : ''})`);
  } else {
    console.log(`Games: No explicit game column found - will derive games from teams`);
  }

  return { players, detectedContestType, teams };
}

/**
 * Parse a number from string, handling currency/percentage formats
 */
function parseNumber(value: string | number | undefined | null): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'number') return value;

  // Remove currency symbols, commas, percentage signs
  const cleaned = value.toString()
    .replace(/[$,]/g, '')
    .replace(/%/g, '')
    .trim();

  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

/**
 * Normalize ownership to 0-100 scale.
 * SaberSim reports ownership as percentages (32.1 = 32.1%, 0.71 = 0.71%).
 * Values below 1.0 are sub-1% ownership, NOT decimal fractions.
 */
function normalizeOwnership(ownership: number): number {
  return Math.min(Math.max(0, ownership), 100);
}

// ============================================================
// PLAYER POOL CONSTRUCTION
// ============================================================

/**
 * Build player pool from raw player data
 * Keeps ORIGINAL projections to match SaberSim exactly
 * Ceiling and gameTotal stored for use in selection phase
 */
export function buildPlayerPool(rawPlayers: RawPlayer[], contestType: ContestType = 'classic'): PlayerPool {
  const players: Player[] = [];
  const byId = new Map<string, Player>();
  const byPosition = new Map<string, Player[]>();
  const byTeam = new Map<string, Player[]>();

  const isShowdown = contestType === 'showdown';

  // Calculate average game total for reference
  const avgGameTotal = rawPlayers.reduce((sum, p) => sum + p.gameTotal, 0) / rawPlayers.length;
  console.log(`\nBuilding player pool...`);
  console.log(`  Average game total: ${avgGameTotal.toFixed(1)}`);

  for (let i = 0; i < rawPlayers.length; i++) {
    const raw = rawPlayers[i];

    // Parse positions
    const positions = parsePositions(raw.position, raw.isCaptain, isShowdown);

    // Keep ORIGINAL projection to match SaberSim
    // Ceiling and gameTotal are stored on player for selection phase
    const value = raw.salary > 0 ? (raw.projection / raw.salary) * 1000 : 0;

    const player: Player = {
      ...raw,
      // projection stays as original (raw.projection)
      index: i,
      positions,
      value,
    };

    players.push(player);
    byId.set(player.id, player);

    // Index by position
    for (const pos of positions) {
      const existing = byPosition.get(pos) || [];
      existing.push(player);
      byPosition.set(pos, existing);
    }

    // Index by team
    if (player.team) {
      const existing = byTeam.get(player.team) || [];
      existing.push(player);
      byTeam.set(player.team, existing);
    }
  }

  // Show top projections (original, matching SaberSim)
  const sorted = [...players].sort((a, b) => b.projection - a.projection);
  console.log(`  Top 3 projections (matching SaberSim):`);
  for (let i = 0; i < Math.min(3, sorted.length); i++) {
    const p = sorted[i];
    console.log(`    ${p.name}: ${p.projection.toFixed(1)} pts (ceiling: ${p.ceiling.toFixed(1)})`);
  }

  return { players, byId, byPosition, byTeam };
}

/**
 * Parse position string into array
 */
function parsePositions(positionStr: string, isCaptain?: boolean, isShowdown?: boolean): string[] {
  const posUpper = positionStr.toUpperCase();

  // Handle showdown positions (CPT/MVP and FLEX/UTIL)
  if (posUpper.includes('CPT') || posUpper.includes('MVP') || posUpper.includes('CAPTAIN')) {
    return ['CPT'];
  }
  // In showdown, non-CPT entries are FLEX
  if (isShowdown && (posUpper.includes('FLEX') || posUpper.includes('UTIL') || !posUpper.includes('CPT'))) {
    // Check if it's explicitly FLEX or just a regular position in showdown
    if (posUpper.includes('FLEX') || posUpper.includes('UTIL')) {
      return ['FLEX'];
    }
    // Regular position in showdown file = FLEX eligible
    return ['FLEX'];
  }

  // Split on common delimiters for classic
  const positions = positionStr
    .split(/[\/,\s]+/)
    .map(p => p.trim().toUpperCase())
    .filter(p => p.length > 0);

  // Normalize positions
  return positions.map(normalizePosition);
}

/**
 * Normalize position code
 */
function normalizePosition(pos: string): string {
  const mappings: Record<string, string> = {
    'POINT GUARD': 'PG',
    'SHOOTING GUARD': 'SG',
    'SMALL FORWARD': 'SF',
    'POWER FORWARD': 'PF',
    'CENTER': 'C',
    'GUARD': 'G',
    'FORWARD': 'F',
    'GOLFER': 'G',
    'UTILITY': 'UTIL',
    'CAPTAIN': 'CPT',
    'SP': 'P',   // Starting pitcher → P (DK MLB uses 'P' for all pitchers)
    'RP': 'P',   // Relief pitcher → P
  };

  return mappings[pos] || pos;
}

// ============================================================
// LOCK STATUS DETECTION FOR LATE SWAP
// ============================================================

/**
 * Parse lock status from CSV for late swap functionality.
 * Players with empty status or 'Confirmed' are considered locked (game started).
 * Players with Q, P, GTD, O, D, etc. are swappable (game hasn't started).
 *
 * Returns a map of player ID -> lock status
 */
export function parseLockStatus(filePath: string): Map<string, LockStatus> {
  const content = fs.readFileSync(filePath, 'utf-8');

  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  if (records.length === 0) {
    throw new Error('CSV file is empty');
  }

  const headers = Object.keys(records[0]);
  const idCol = findColumn(headers, 'id');
  const statusCol = findColumn(headers, 'status');
  const nameCol = findColumn(headers, 'name');

  if (!idCol) {
    throw new Error('Could not find ID column in CSV');
  }

  const lockStatusMap = new Map<string, LockStatus>();
  let lockedCount = 0;
  let swappableCount = 0;

  for (const row of records) {
    const id = row[idCol]?.toString().trim();
    if (!id) continue;

    // Get status value (if status column exists)
    const statusValue = statusCol ? row[statusCol]?.toString().trim().toUpperCase() : '';

    // Determine lock status:
    // - Empty status or 'CONFIRMED' = game has started, player is LOCKED
    // - Q (Questionable), P (Probable), GTD (Game-Time Decision), O (Out), D (Doubtful) = game hasn't started, SWAPPABLE
    // - Any other status = assume swappable (game hasn't started)
    let lockStatus: LockStatus;

    if (!statusValue || statusValue === '' || statusValue === 'CONFIRMED' || statusValue === 'LOCKED') {
      lockStatus = 'locked';
      lockedCount++;
    } else {
      // Q, P, GTD, O, D, or any other status means game hasn't started
      lockStatus = 'swappable';
      swappableCount++;
    }

    lockStatusMap.set(id, lockStatus);
  }

  console.log(`Lock status parsed: ${lockedCount} locked, ${swappableCount} swappable`);
  return lockStatusMap;
}

/**
 * Check if a player is locked based on their status
 */
export function isPlayerLocked(status: string | undefined | null): boolean {
  if (!status || status.trim() === '') return true;  // No status = locked
  const upper = status.toUpperCase().trim();
  return upper === 'CONFIRMED' || upper === 'LOCKED';
}
