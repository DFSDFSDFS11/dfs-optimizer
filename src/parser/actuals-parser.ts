/**
 * DraftKings Contest Actuals Parser
 *
 * Parses a downloaded DK contest standings CSV into:
 *   1. ContestEntry[] — every entry with its players, points, rank, and username
 *   2. PlayerActuals — map of player name → actual fantasy points
 *
 * The DK actuals CSV has TWO tables glued side by side:
 *   Left table  (cols A-F): Rank, EntryId, EntryName, TimeRemaining, Points, Lineup
 *   Right table (cols H-K): Player, Roster Position, %Drafted, FPTS
 *
 * The Lineup column is a space-separated string like "C Bam Adebayo F Norman Powell ...".
 * Parsing it requires the contest config so we know which tokens are position names.
 */

import * as fs from 'fs';
import { parse } from 'csv-parse/sync';
import { ContestConfig } from '../types';

export interface ContestEntry {
  rank: number;
  entryId: string;
  entryName: string;        // Username — pros are identified by this
  actualPoints: number;
  /** Player names parsed from the Lineup column, in roster order. */
  playerNames: string[];
  /** Player IDs after joining to the projection map (filled in by enrichEntry). */
  playerIds?: string[];
  /** Cached actual points per player, after joining (filled in by enrichEntry). */
  playerActuals?: number[];
}

export interface PlayerActual {
  name: string;
  position: string;
  drafted: number;          // 0-1 ownership %
  fpts: number;             // Actual fantasy points
}

export interface ContestActuals {
  entries: ContestEntry[];
  /** name (lowercased + stripped) → actual fantasy points */
  playerActualsByName: Map<string, PlayerActual>;
  /** Total entries in the contest (used for percentile thresholds). */
  totalEntries: number;
}

/**
 * Normalize a player name for matching: lowercase, collapse whitespace, strip punctuation.
 * Mirrors what we do elsewhere when joining names across data sources.
 */
function normalizeName(name: string): string {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse the Lineup column ("C Bam Adebayo F Norman Powell ...") into player names.
 *
 * We walk left-to-right, treating each known position token as a delimiter, and collect
 * the words between consecutive position tokens as a player name.
 */
function parseLineupString(lineup: string, positionNames: Set<string>): string[] {
  const tokens = (lineup || '').trim().split(/\s+/);
  const players: string[] = [];
  let current: string[] = [];
  let started = false;

  for (const token of tokens) {
    if (positionNames.has(token.toUpperCase())) {
      if (started && current.length > 0) {
        players.push(current.join(' '));
      }
      current = [];
      started = true;
    } else if (started) {
      current.push(token);
    }
  }
  if (current.length > 0) players.push(current.join(' '));

  return players;
}

/**
 * Parse a DK contest standings CSV.
 */
export function parseContestActuals(filePath: string, config: ContestConfig): ContestActuals {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Actuals CSV not found: ${filePath}`);
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  const records: string[][] = parse(content, {
    columns: false,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
    bom: true,
  });

  if (records.length < 2) {
    throw new Error('Actuals CSV is empty or has no data rows');
  }

  const headers = records[0];

  // Locate the left-side columns
  const findCol = (...names: string[]) => {
    for (const name of names) {
      const idx = headers.findIndex(h => h.trim().toLowerCase() === name.toLowerCase());
      if (idx >= 0) return idx;
    }
    return -1;
  };

  const rankIdx = findCol('Rank', 'rank');
  const entryIdIdx = findCol('EntryId', 'Entry ID', 'entry_id');
  const entryNameIdx = findCol('EntryName', 'Entry Name', 'entry_name');
  const pointsIdx = findCol('Points', 'points');
  const lineupIdx = findCol('Lineup', 'lineup');

  // Locate the right-side columns
  const playerColIdx = findCol('Player', 'player');
  const positionColIdx = findCol('Roster Position', 'Position', 'roster_position');
  const draftedColIdx = findCol('%Drafted', '% Drafted', 'drafted');
  const fptsColIdx = findCol('FPTS', 'fpts', 'Points', 'points');

  if (entryIdIdx === -1 || lineupIdx === -1 || pointsIdx === -1) {
    throw new Error(
      `Actuals CSV missing required left-side columns. Found: ${headers.join(', ')}`,
    );
  }

  // Build the position name set for parsing the Lineup column
  const positionNameSet = new Set<string>();
  for (const pos of config.positions) {
    positionNameSet.add(pos.name.toUpperCase());
    // Also include eligible position aliases (e.g., "F" for "PF/SF")
    for (const eligible of pos.eligible || []) {
      positionNameSet.add(eligible.toUpperCase());
    }
  }
  // Add common DK aliases that may not appear in our config
  for (const extra of ['G', 'F', 'UTIL', 'CPT', 'FLEX', 'MVP', 'SP', 'RP']) {
    positionNameSet.add(extra);
  }

  const entries: ContestEntry[] = [];
  const playerActualsByName = new Map<string, PlayerActual>();

  for (let r = 1; r < records.length; r++) {
    const row = records[r];

    // ---- LEFT TABLE: parse this entry ----
    const entryId = row[entryIdIdx];
    if (entryId && /^\d+$/.test(entryId)) {
      const rank = rankIdx >= 0 ? parseInt(row[rankIdx], 10) : entries.length + 1;
      const entryName = entryNameIdx >= 0 ? row[entryNameIdx] : '';
      const actualPoints = parseFloat(row[pointsIdx]) || 0;
      const lineup = row[lineupIdx] || '';
      const playerNames = parseLineupString(lineup, positionNameSet);

      entries.push({
        rank,
        entryId,
        entryName,
        actualPoints,
        playerNames,
      });
    }

    // ---- RIGHT TABLE: parse the player actuals (one row per player) ----
    if (playerColIdx >= 0 && fptsColIdx >= 0 && row[playerColIdx]) {
      const playerName = row[playerColIdx].trim();
      if (playerName && playerName.toLowerCase() !== 'player') {
        const fptsRaw = row[fptsColIdx];
        const fpts = parseFloat(fptsRaw);
        if (!isNaN(fpts)) {
          const draftedRaw = draftedColIdx >= 0 ? row[draftedColIdx] : '0';
          const drafted = parseFloat(String(draftedRaw).replace('%', '')) / 100;
          playerActualsByName.set(normalizeName(playerName), {
            name: playerName,
            position: positionColIdx >= 0 ? row[positionColIdx] : '',
            drafted: isNaN(drafted) ? 0 : drafted,
            fpts,
          });
        }
      }
    }
  }

  return {
    entries,
    playerActualsByName,
    totalEntries: entries.length,
  };
}

/**
 * Compute the actual fantasy points of an arbitrary lineup by joining its players
 * to the contest player actuals via name.
 *
 * Returns null if any player can't be matched (which usually means the player wasn't
 * in the contest's roster or the name normalization failed).
 */
export function scoreLineupAgainstActuals(
  playerNames: string[],
  actuals: ContestActuals,
): { total: number; missing: string[] } {
  let total = 0;
  const missing: string[] = [];
  for (const name of playerNames) {
    const norm = normalizeName(name);
    const found = actuals.playerActualsByName.get(norm);
    if (found) {
      total += found.fpts;
    } else {
      missing.push(name);
    }
  }
  return { total, missing };
}

/**
 * Convenience: build a lookup table of percentile thresholds in the contest's actual
 * scores. Used for hit-rate computation.
 */
export function buildPercentileThresholds(entries: ContestEntry[]): {
  top1Pct: number;
  top5Pct: number;
  top10Pct: number;
  top20Pct: number;
  totalEntries: number;
} {
  const sorted = [...entries].sort((a, b) => b.actualPoints - a.actualPoints);
  const n = sorted.length;
  return {
    top1Pct: sorted[Math.max(0, Math.floor(n * 0.01) - 1)]?.actualPoints || 0,
    top5Pct: sorted[Math.max(0, Math.floor(n * 0.05) - 1)]?.actualPoints || 0,
    top10Pct: sorted[Math.max(0, Math.floor(n * 0.10) - 1)]?.actualPoints || 0,
    top20Pct: sorted[Math.max(0, Math.floor(n * 0.20) - 1)]?.actualPoints || 0,
    totalEntries: n,
  };
}

/**
 * Find the rank of a given score in a sorted (descending) list of actual scores.
 * Returns 1-indexed rank (1 = best).
 */
export function findRankForScore(score: number, sortedDesc: number[]): number {
  // Binary search for the first index where sortedDesc[i] < score
  let lo = 0;
  let hi = sortedDesc.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedDesc[mid] >= score) lo = mid + 1;
    else hi = mid;
  }
  return lo; // 1-indexed rank = lo (number of entries strictly better, plus 1, minus 1)
}
