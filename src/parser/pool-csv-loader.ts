/**
 * Pool CSV Loader
 *
 * Loads a pre-built lineup pool from CSV (e.g., SaberSim export, DraftKings entries CSV)
 * and converts it into the optimizer's `Lineup[]` format by joining player IDs against
 * the projection map.
 *
 * This lets the selector run on a externally-generated pool, skipping our pool generation
 * phases entirely. Useful when:
 *  - Trusting SaberSim's correlation-aware pool over our branch-and-bound
 *  - Re-running selection on a previously exported lineup set
 *  - Backtesting selection logic against actual contest fields (Mode 2)
 *
 * Supported input formats (auto-detected by header inspection):
 *  - SaberSim lineup export: position columns (P, P, C, 1B, ...) with raw player IDs
 *  - SaberSim "Name (ID)" format: position columns containing "Player Name (123456)"
 *  - DraftKings entries CSV: Entry ID, Contest Name, ..., position columns
 */

import * as fs from 'fs';
import { parse } from 'csv-parse/sync';
import { Lineup, Player, ContestConfig } from '../types';

export interface LoadPoolParams {
  filePath: string;
  config: ContestConfig;
  /** Map of DFS player ID → Player object (must match the IDs used in the pool CSV). */
  playerMap: Map<string, Player>;
  /** Drop lineups whose players can't all be resolved against playerMap. Default: true. */
  dropUnresolved?: boolean;
}

export interface LoadPoolResult {
  lineups: Lineup[];
  totalRowsParsed: number;
  unresolvedRows: number;
  invalidRows: number;
  format: 'sabersim' | 'dk-entries' | 'name-id' | 'unknown';
}

/**
 * Extract player ID from a cell that may be a raw ID, "Name (ID)" format, or just a name.
 * Returns null if no plausible ID can be extracted.
 */
function extractPlayerId(cell: string): string | null {
  if (!cell) return null;
  const trimmed = cell.trim();
  if (!trimmed) return null;

  // "Name (123456)" format — extract the parenthesized number
  const parenMatch = trimmed.match(/\((\d{4,})\)\s*$/);
  if (parenMatch) return parenMatch[1];

  // Pure numeric ID
  if (/^\d{4,}$/.test(trimmed)) return trimmed;

  // Couldn't extract — return null and let the caller drop or warn
  return null;
}

/**
 * Find the indices of position columns in the header row, based on the contest config.
 * Handles repeated positions (e.g., "P, P, C, 1B, ..." for MLB).
 */
function findPositionColumnIndices(
  headers: string[],
  config: ContestConfig,
): number[] {
  const positionNames = config.positions.map(p => p.name.toUpperCase());
  const indices: number[] = [];
  const usedSourceIndices = new Set<number>();

  // For each position slot in the config, find the next matching column
  for (const posName of positionNames) {
    let found = -1;
    for (let i = 0; i < headers.length; i++) {
      if (usedSourceIndices.has(i)) continue;
      const h = headers[i].trim().toUpperCase();
      // Match exact or with trailing digit (e.g., "OF1", "OF2")
      if (h === posName || h.match(new RegExp(`^${posName}\\d*$`))) {
        found = i;
        break;
      }
    }
    if (found === -1) return []; // Couldn't map all positions — caller will error
    indices.push(found);
    usedSourceIndices.add(found);
  }

  return indices;
}

/**
 * Detect the format of the pool CSV based on its headers.
 */
function detectFormat(headers: string[]): LoadPoolResult['format'] {
  const hasEntryId = headers.some(h => /entry\s*id/i.test(h));
  const hasContest = headers.some(h => /contest\s*name/i.test(h));
  if (hasEntryId && hasContest) return 'dk-entries';

  const hasNameId = headers.some(h => /name\s*\+\s*id/i.test(h));
  if (hasNameId) return 'name-id';

  // Default: assume SaberSim style with bare position columns
  return 'sabersim';
}

/**
 * Load lineups from a pool CSV file and join player IDs against the projection map.
 */
export function loadPoolFromCSV(params: LoadPoolParams): LoadPoolResult {
  const { filePath, config, playerMap, dropUnresolved = true } = params;

  if (!fs.existsSync(filePath)) {
    throw new Error(`Pool CSV file not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const records: string[][] = parse(content, {
    columns: false,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  });

  if (records.length < 2) {
    throw new Error('Pool CSV is empty or has no data rows');
  }

  const headers = records[0];
  const format = detectFormat(headers);

  const positionIndices = findPositionColumnIndices(headers, config);
  if (positionIndices.length !== config.positions.length) {
    throw new Error(
      `Pool CSV missing required position columns. Expected ${config.positions.length} ` +
      `positions (${config.positions.map(p => p.name).join(', ')}). ` +
      `Found headers: ${headers.join(', ')}`,
    );
  }

  console.log(`Loading pool from ${filePath}`);
  console.log(`  Format: ${format}`);
  console.log(`  Position columns: ${positionIndices.map(i => headers[i]).join(', ')}`);
  console.log(`  Data rows: ${records.length - 1}`);

  const lineups: Lineup[] = [];
  const seenHashes = new Set<string>();
  let unresolvedRows = 0;
  let invalidRows = 0;

  for (let r = 1; r < records.length; r++) {
    const row = records[r];
    const players: Player[] = [];
    let resolved = true;

    for (const ci of positionIndices) {
      const cell = row[ci] || '';
      const playerId = extractPlayerId(cell);
      if (!playerId) {
        resolved = false;
        break;
      }
      const player = playerMap.get(playerId);
      if (!player) {
        resolved = false;
        break;
      }
      players.push(player);
    }

    if (!resolved) {
      unresolvedRows++;
      if (dropUnresolved) continue;
    }

    if (players.length !== config.positions.length) {
      invalidRows++;
      continue;
    }

    // Compute lineup-level stats from the joined player projections
    const salary = players.reduce((s, p) => s + p.salary, 0);
    const projection = players.reduce((s, p) => s + p.projection, 0);
    const ownership = players.reduce((s, p) => s + (p.ownership || 0), 0) / players.length;

    // Hash from sorted player IDs (deterministic dedup key)
    const hash = players.map(p => p.id).sort().join('|');
    if (seenHashes.has(hash)) continue;
    seenHashes.add(hash);

    lineups.push({
      players,
      salary,
      projection,
      ownership,
      hash,
      constructionMethod: 'pool-csv',
    });
  }

  console.log(`  Loaded ${lineups.length} unique lineups`);
  if (unresolvedRows > 0) {
    console.log(`  Skipped ${unresolvedRows} rows with unresolved players (not in projection map)`);
  }
  if (invalidRows > 0) {
    console.log(`  Skipped ${invalidRows} rows with wrong roster size`);
  }

  return {
    lineups,
    totalRowsParsed: records.length - 1,
    unresolvedRows,
    invalidRows,
    format,
  };
}
