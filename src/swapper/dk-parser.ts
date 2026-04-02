/**
 * DraftKings Entries Parser
 *
 * Parses DraftKings CSV export of entries for late swap optimization.
 */

import * as fs from 'fs';
import { DKEntry, ContestConfig } from '../types';

/**
 * Parse DraftKings entries export CSV
 *
 * Expected format:
 * Entry ID,Contest Name,Contest ID,Entry Fee,PG,SG,SF,PF,C,G,F,UTIL
 * or for showdown:
 * Entry ID,Contest Name,Contest ID,Entry Fee,CPT,FLEX,FLEX,FLEX,FLEX,FLEX
 */
export function parseDraftKingsEntries(
  filePath: string,
  config: ContestConfig
): DKEntry[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n');

  if (lines.length < 2) {
    throw new Error('DraftKings entries file is empty or has no data rows');
  }

  const headers = parseCSVLine(lines[0]);

  // Find column indices
  const entryIdIdx = findColumn(headers, ['Entry ID', 'EntryId', 'entry_id']);
  const contestNameIdx = findColumn(headers, ['Contest Name', 'ContestName', 'contest_name']);
  const contestIdIdx = findColumn(headers, ['Contest ID', 'ContestId', 'contest_id']);

  if (entryIdIdx === -1) {
    throw new Error('Could not find Entry ID column in DraftKings export');
  }

  // Find position columns based on config
  // First, find where player IDs start (after metadata columns)
  const metadataKeywords = ['entry', 'contest', 'fee', 'name', 'id'];
  let firstPositionIdx = -1;

  // Helper to check if header exactly matches a position name
  const isPositionHeader = (header: string): boolean => {
    const h = header.trim().toUpperCase();
    return config.positions.some(pos => {
      const posName = pos.name.toUpperCase();
      // Must be exact match or match followed by number (e.g., "FLEX1")
      return h === posName || h.match(new RegExp(`^${posName}\\d*$`));
    });
  };

  for (let i = 0; i < headers.length; i++) {
    if (isPositionHeader(headers[i])) {
      firstPositionIdx = i;
      break;
    }
  }

  // If no position headers found, look for first non-metadata column
  if (firstPositionIdx === -1) {
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i].toLowerCase();
      if (!metadataKeywords.some(m => h.includes(m))) {
        firstPositionIdx = i;
        break;
      }
    }
  }

  // Find position column indices
  const positionIndices: number[] = [];
  for (let i = 0; i < config.positions.length; i++) {
    const pos = config.positions[i];
    const posName = pos.name.toUpperCase();

    // Try to find by exact name match first
    let idx = headers.findIndex((h, hi) =>
      hi >= firstPositionIdx &&
      !positionIndices.includes(hi) &&
      h.trim().toUpperCase() === posName
    );

    // If not found, try with numbered suffix (FLEX1, FLEX2, etc)
    if (idx === -1) {
      idx = headers.findIndex((h, hi) =>
        hi >= firstPositionIdx &&
        !positionIndices.includes(hi) &&
        h.trim().toUpperCase().match(new RegExp(`^${posName}\\d*$`))
      );
    }

    // If still not found by name, use sequential position
    if (idx === -1 && firstPositionIdx !== -1) {
      idx = firstPositionIdx + i;
    }

    positionIndices.push(idx);
  }

  const entries: DKEntry[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values = parseCSVLine(line);

    const entryId = values[entryIdIdx] || `entry_${i}`;
    const contestName = contestNameIdx !== -1 ? values[contestNameIdx] || '' : '';
    const contestId = contestIdIdx !== -1 ? values[contestIdIdx] || '' : '';

    // Extract player IDs from position columns
    // DraftKings format can be either:
    // - Just ID: "41567074"
    // - Name with ID: "Jamal Murray (41567074)"
    // - Name with ID and LOCKED: "Jamal Murray (41567074) (LOCKED)"
    const playerIds: string[] = [];
    for (const idx of positionIndices) {
      if (idx >= 0 && idx < values.length) {
        const cellValue = values[idx]?.trim();
        if (cellValue) {
          const playerId = extractPlayerId(cellValue);
          if (playerId) {
            playerIds.push(playerId);
          }
        }
      }
    }

    if (playerIds.length !== config.positions.length) {
      // Skip silently - these are likely empty rows or instruction rows in DK export
      continue;
    }

    entries.push({
      entryId,
      contestName,
      contestId,
      playerIds,
    });
  }

  console.log(`Parsed ${entries.length} entries from DraftKings export`);
  return entries;
}

/**
 * Find column index by possible names
 */
function findColumn(headers: string[], possibleNames: string[]): number {
  for (const name of possibleNames) {
    const idx = headers.findIndex(h =>
      h.toLowerCase().replace(/[^a-z0-9]/g, '') === name.toLowerCase().replace(/[^a-z0-9]/g, '')
    );
    if (idx !== -1) return idx;
  }
  return -1;
}

/**
 * Extract player ID from various DraftKings formats:
 * - "41567074" -> "41567074"
 * - "Jamal Murray (41567074)" -> "41567074"
 * - "Jamal Murray (41567074) (LOCKED)" -> "41567074"
 */
function extractPlayerId(value: string): string | null {
  if (!value || value.trim() === '') return null;

  // Try to find ID in parentheses (e.g., "Player Name (12345678)")
  const idMatch = value.match(/\((\d{7,10})\)/);
  if (idMatch) {
    return idMatch[1];
  }

  // If no parentheses, check if the whole value is just a numeric ID
  const trimmed = value.trim();
  if (/^\d{7,10}$/.test(trimmed)) {
    return trimmed;
  }

  return null;
}

/**
 * Parse a CSV line handling quoted values
 */
function parseCSVLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  values.push(current.trim());
  return values;
}
