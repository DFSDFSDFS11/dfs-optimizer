/**
 * Standalone Actuals Scorer
 *
 * Takes a lineup CSV (in our exported format) and a DK contest actuals CSV.
 * For each lineup, computes its actual fantasy points by joining each player's
 * ID against the contest actuals (via the projection map for the slate).
 *
 * Reports:
 *   - Hit rates: top 1%, top 5%, top 10%, top 20%
 *   - Best actual score and its hypothetical contest rank
 *   - Avg actual score
 *   - Number of unmatched players (data quality check)
 */

import * as fs from 'fs';
import { parse } from 'csv-parse/sync';
import { ContestConfig, Player } from '../types';
import {
  ContestActuals,
  buildPercentileThresholds,
  findRankForScore,
} from '../parser/actuals-parser';

export interface ScoreActualsParams {
  lineupCsvPath: string;
  actuals: ContestActuals;
  config: ContestConfig;
  /** Map of player ID → Player. Used to translate IDs in lineup CSV to names for actuals lookup. */
  playerMap: Map<string, Player>;
}

export interface ScoreActualsReport {
  totalLineups: number;
  matchedLineups: number;
  unmatchedPlayers: Set<string>;
  scores: number[];
  avgActual: number;
  bestActual: number;
  bestRank: number;
  worstActual: number;
  hits: {
    top1Pct: number;
    top5Pct: number;
    top10Pct: number;
    top20Pct: number;
  };
  rates: {
    top1Pct: number;
    top5Pct: number;
    top10Pct: number;
    top20Pct: number;
  };
  thresholds: {
    top1Pct: number;
    top5Pct: number;
    top10Pct: number;
    top20Pct: number;
    totalEntries: number;
  };
}

/**
 * Score every lineup in `lineupCsvPath` against the contest actuals.
 */
export function scoreLineupCsvAgainstActuals(params: ScoreActualsParams): ScoreActualsReport {
  const { lineupCsvPath, actuals, config, playerMap } = params;

  if (!fs.existsSync(lineupCsvPath)) {
    throw new Error(`Lineup CSV not found: ${lineupCsvPath}`);
  }

  const content = fs.readFileSync(lineupCsvPath, 'utf-8');
  const records: string[][] = parse(content, {
    columns: false,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
    bom: true,
  });

  if (records.length < 2) {
    throw new Error('Lineup CSV is empty or has no data rows');
  }

  const headers = records[0];

  // Find position columns (same logic as pool-csv-loader)
  const positionNames = config.positions.map(p => p.name.toUpperCase());
  const positionIndices: number[] = [];
  const used = new Set<number>();
  for (const posName of positionNames) {
    let found = -1;
    for (let i = 0; i < headers.length; i++) {
      if (used.has(i)) continue;
      const h = headers[i].trim().toUpperCase();
      if (h === posName || h.match(new RegExp(`^${posName}\\d*$`))) {
        found = i;
        break;
      }
    }
    if (found === -1) {
      throw new Error(
        `Lineup CSV missing position column ${posName}. Headers: ${headers.join(', ')}`,
      );
    }
    positionIndices.push(found);
    used.add(found);
  }

  // Normalize a player name the same way the actuals parser does
  const normalizeName = (name: string) =>
    (name || '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  // Helper: extract a player ID from "Name (123456)" or raw "123456" cells
  const extractId = (cell: string): string | null => {
    if (!cell) return null;
    const trimmed = cell.trim();
    const m = trimmed.match(/\((\d{4,})\)\s*$/);
    if (m) return m[1];
    if (/^\d{4,}$/.test(trimmed)) return trimmed;
    return null;
  };

  const scores: number[] = [];
  const unmatchedPlayers = new Set<string>();
  let matchedLineups = 0;

  for (let r = 1; r < records.length; r++) {
    const row = records[r];
    let total = 0;
    let allMatched = true;

    for (const ci of positionIndices) {
      const cell = row[ci] || '';
      const id = extractId(cell);
      if (!id) {
        allMatched = false;
        break;
      }
      const player = playerMap.get(id);
      if (!player) {
        allMatched = false;
        unmatchedPlayers.add(id);
        break;
      }
      const norm = normalizeName(player.name);
      const actual = actuals.playerActualsByName.get(norm);
      if (!actual) {
        allMatched = false;
        unmatchedPlayers.add(player.name);
        break;
      }
      total += actual.fpts;
    }

    if (allMatched) {
      scores.push(total);
      matchedLineups++;
    }
  }

  // Build percentile thresholds from the contest field
  const thresholds = buildPercentileThresholds(actuals.entries);

  let top1 = 0;
  let top5 = 0;
  let top10 = 0;
  let top20 = 0;
  for (const s of scores) {
    if (s >= thresholds.top1Pct) top1++;
    if (s >= thresholds.top5Pct) top5++;
    if (s >= thresholds.top10Pct) top10++;
    if (s >= thresholds.top20Pct) top20++;
  }

  const sortedDesc = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
  const bestActual = scores.length > 0 ? Math.max(...scores) : 0;
  const worstActual = scores.length > 0 ? Math.min(...scores) : 0;
  const avgActual = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const bestRank = bestActual > 0 ? Math.max(1, findRankForScore(bestActual, sortedDesc)) : 0;

  return {
    totalLineups: records.length - 1,
    matchedLineups,
    unmatchedPlayers,
    scores,
    avgActual,
    bestActual,
    bestRank,
    worstActual,
    hits: { top1Pct: top1, top5Pct: top5, top10Pct: top10, top20Pct: top20 },
    rates: {
      top1Pct: scores.length > 0 ? top1 / scores.length : 0,
      top5Pct: scores.length > 0 ? top5 / scores.length : 0,
      top10Pct: scores.length > 0 ? top10 / scores.length : 0,
      top20Pct: scores.length > 0 ? top20 / scores.length : 0,
    },
    thresholds,
  };
}

/**
 * Pretty-print a scoring report to the console.
 */
export function printScoreReport(report: ScoreActualsReport, label: string = 'Lineups'): void {
  console.log('\n========================================');
  console.log(`SCORE REPORT — ${label}`);
  console.log('========================================');
  console.log(`Total lineups in CSV:    ${report.totalLineups}`);
  console.log(`Matched (all players found): ${report.matchedLineups}`);
  if (report.unmatchedPlayers.size > 0) {
    console.log(`Unmatched players: ${report.unmatchedPlayers.size}`);
    const sample = Array.from(report.unmatchedPlayers).slice(0, 5);
    console.log(`  Sample: ${sample.join(', ')}`);
  }

  console.log('\n--- CONTEST FIELD ---');
  console.log(`Total entries:          ${report.thresholds.totalEntries}`);
  console.log(`Top 1% threshold:       ${report.thresholds.top1Pct.toFixed(2)} pts`);
  console.log(`Top 5% threshold:       ${report.thresholds.top5Pct.toFixed(2)} pts`);
  console.log(`Top 10% threshold:      ${report.thresholds.top10Pct.toFixed(2)} pts`);
  console.log(`Top 20% threshold:      ${report.thresholds.top20Pct.toFixed(2)} pts`);

  console.log('\n--- OUR LINEUPS ---');
  console.log(`Avg actual:             ${report.avgActual.toFixed(2)} pts`);
  console.log(`Best actual:            ${report.bestActual.toFixed(2)} pts (rank ~${report.bestRank})`);
  console.log(`Worst actual:           ${report.worstActual.toFixed(2)} pts`);

  console.log('\n--- HIT RATES ---');
  console.log(`Top 1%:  ${report.hits.top1Pct}/${report.matchedLineups} = ${(report.rates.top1Pct * 100).toFixed(2)}%`);
  console.log(`Top 5%:  ${report.hits.top5Pct}/${report.matchedLineups} = ${(report.rates.top5Pct * 100).toFixed(2)}%`);
  console.log(`Top 10%: ${report.hits.top10Pct}/${report.matchedLineups} = ${(report.rates.top10Pct * 100).toFixed(2)}%`);
  console.log(`Top 20%: ${report.hits.top20Pct}/${report.matchedLineups} = ${(report.rates.top20Pct * 100).toFixed(2)}%`);

  // Compare against expected random rates as a sanity check
  console.log('\n--- LIFT OVER RANDOM ---');
  const lift1 = report.rates.top1Pct / 0.01;
  const lift5 = report.rates.top5Pct / 0.05;
  const lift10 = report.rates.top10Pct / 0.10;
  console.log(`Top 1% lift:   ${lift1.toFixed(2)}x random (1.00% expected)`);
  console.log(`Top 5% lift:   ${lift5.toFixed(2)}x random (5.00% expected)`);
  console.log(`Top 10% lift:  ${lift10.toFixed(2)}x random (10.00% expected)`);
  console.log('========================================');
}
