/**
 * DFS Optimizer CLI - CSV Export
 *
 * Handles exporting lineups to CSV format compatible with SaberSim upload.
 */

import * as fs from 'fs';
import { stringify } from 'csv-stringify/sync';
import { ContestConfig, Lineup, ScoredLineup, SwapResult, LateSwapResult, LineupMetricsData } from '../types';

/**
 * Build position headers for SaberSim export.
 * Duplicate column names are kept as-is (SaberSim handles them).
 */
function buildPositionHeaders(positions: string[]): string[] {
  return positions.map(pos => pos);
}

/**
 * Export lineups to CSV file in SaberSim-compatible format.
 * ALWAYS exports exactly 5000 lineups (or all if fewer available).
 */
export function exportLineupsToCSV(
  lineups: Array<Lineup | ScoredLineup>,
  config: ContestConfig,
  outputPath: string
): void {
  console.log(`\nExporting ${lineups.length} lineups to ${outputPath}`);
  if (fs.existsSync(outputPath)) {
    console.log(`  (Overwriting existing file)`);
  }

  // Build header row
  const positionHeaders = buildPositionHeaders(config.positions.map(p => p.name));
  const headers = [
    ...positionHeaders,
    'Projection',
    'Salary',
    'Avg_Ownership',
  ];

  // Build data rows
  const rows: string[][] = [];

  for (const lineup of lineups) {
    const row: string[] = [];

    // Player IDs in position order
    for (const player of lineup.players) {
      row.push(player.id);
    }

    // Add stats
    row.push(lineup.projection.toFixed(2));
    row.push(lineup.salary.toString());
    // Calculate average ownership for export (more interpretable than product)
    const avgOwnership = lineup.players.reduce((s, p) => s + p.ownership, 0) / lineup.players.length;
    row.push(avgOwnership.toFixed(1));

    rows.push(row);
  }

  // Generate CSV
  const csvContent = stringify([headers, ...rows]);

  // Write to file
  fs.writeFileSync(outputPath, csvContent, 'utf-8');

  console.log(`Successfully exported ${lineups.length} lineups`);
}

/**
 * Export lineups in DraftKings bulk upload format
 */
export function exportForDraftKings(
  lineups: Array<Lineup | ScoredLineup>,
  config: ContestConfig,
  outputPath: string
): void {
  console.log(`\nExporting ${lineups.length} lineups for DraftKings upload`);

  // DK format: just player IDs in position order
  const headers = config.positions.map(p => p.name);
  const rows: string[][] = [];

  for (const lineup of lineups) {
    rows.push(lineup.players.map(p => p.id));
  }

  const csvContent = stringify([headers, ...rows]);
  fs.writeFileSync(outputPath, csvContent, 'utf-8');

  console.log(`Exported to ${outputPath}`);
}

/**
 * Export detailed lineups with player names and stats
 */
export function exportDetailedLineups(
  lineups: Array<Lineup | ScoredLineup>,
  config: ContestConfig,
  outputPath: string
): void {
  console.log(`\nExporting detailed lineup data to ${outputPath}`);

  // Build headers with player columns
  const headers: string[] = [];
  for (let i = 0; i < config.positions.length; i++) {
    const slot = config.positions[i].name;
    headers.push(`${slot}_ID`);
    headers.push(`${slot}_Name`);
    headers.push(`${slot}_Salary`);
    headers.push(`${slot}_Proj`);
  }
  headers.push('Total_Projection');
  headers.push('Total_Salary');
  headers.push('Avg_Ownership');
  headers.push('Ownership_Product');

  // Build rows
  const rows: string[][] = [];

  for (const lineup of lineups) {
    const row: string[] = [];

    for (const player of lineup.players) {
      row.push(player.id);
      row.push(player.name);
      row.push(player.salary.toString());
      row.push(player.projection.toFixed(2));
    }

    row.push(lineup.projection.toFixed(2));
    row.push(lineup.salary.toString());
    // Calculate average ownership as percentage (human-readable)
    const avgOwnership = lineup.players.reduce((sum, p) => sum + p.ownership, 0) / lineup.players.length;
    row.push(avgOwnership.toFixed(1));
    // Keep product ownership for advanced analysis (scientific notation)
    row.push(lineup.ownership.toExponential(4));

    rows.push(row);
  }

  const csvContent = stringify([headers, ...rows]);
  fs.writeFileSync(outputPath, csvContent, 'utf-8');

  console.log(`Exported detailed data to ${outputPath}`);
}

/**
 * Export player exposures
 */
export function exportExposures(
  exposures: Map<string, number>,
  players: Map<string, { name: string; team: string; salary: number; projection: number }>,
  outputPath: string
): void {
  console.log(`\nExporting player exposures to ${outputPath}`);

  const headers = ['Player_ID', 'Name', 'Team', 'Salary', 'Projection', 'Exposure'];
  const rows: string[][] = [];

  // Sort by exposure
  const sortedEntries = Array.from(exposures.entries())
    .sort((a, b) => b[1] - a[1]);

  for (const [playerId, exposure] of sortedEntries) {
    const player = players.get(playerId);
    if (player) {
      rows.push([
        playerId,
        player.name,
        player.team,
        player.salary.toString(),
        player.projection.toFixed(2),
        `${exposure.toFixed(2)}%`,
      ]);
    }
  }

  const csvContent = stringify([headers, ...rows]);
  fs.writeFileSync(outputPath, csvContent, 'utf-8');

  console.log(`Exported exposures for ${sortedEntries.length} players`);
}

/**
 * Export late swap results to DraftKings-ready CSV
 */
export function exportSwappedLineups(
  results: SwapResult[],
  config: ContestConfig,
  outputPath: string
): void {
  console.log(`\nExporting ${results.length} swapped lineups to ${outputPath}`);

  // DraftKings format: Entry ID, then player IDs in position order
  const headers = ['Entry ID', ...config.positions.map(p => p.name)];
  const rows: string[][] = [];

  for (const result of results) {
    const row: string[] = [result.entryId];
    for (const player of result.swappedPlayers) {
      row.push(player.id);
    }
    rows.push(row);
  }

  const csvContent = stringify([headers, ...rows]);
  fs.writeFileSync(outputPath, csvContent, 'utf-8');

  console.log(`Successfully exported ${results.length} swapped lineups`);
}

/**
 * Export detailed late swap report
 */
export function exportSwapReport(
  results: SwapResult[],
  config: ContestConfig,
  outputPath: string
): void {
  console.log(`\nExporting swap report to ${outputPath}`);

  const headers = [
    'Entry ID',
    'Original Projection',
    'New Projection',
    'Projection Gain',
    'Swaps Made',
    'Swap Details',
  ];
  const rows: string[][] = [];

  for (const result of results) {
    const swapDetails = result.swaps.length > 0
      ? result.swaps.map(s =>
          `${s.slotName}: ${s.fromPlayer.name} -> ${s.toPlayer.name} (+${s.projectionDelta.toFixed(1)})`
        ).join('; ')
      : 'No swaps';

    rows.push([
      result.entryId,
      result.originalProjection.toFixed(2),
      result.swappedProjection.toFixed(2),
      result.projectionGain.toFixed(2),
      result.swaps.length.toString(),
      swapDetails,
    ]);
  }

  const csvContent = stringify([headers, ...rows]);
  fs.writeFileSync(outputPath, csvContent, 'utf-8');

  console.log(`Exported swap report`);
}

/**
 * Export lineups with metrics for analysis
 * Creates a separate CSV with scoring breakdown for sorting/analysis
 * 
 * NOTE: Simplified to only include metrics that are actually calculated.
 */
export function exportLineupsWithMetrics(
  metricsData: LineupMetricsData[],
  config: ContestConfig,
  outputPath: string
): void {
  console.log(`\nExporting ${metricsData.length} lineups with metrics to ${outputPath}`);

  // Build headers - player names + actual metrics only
  const headers: string[] = [
    'Rank',
    // Player names for each position
    ...config.positions.map(p => `${p.name}_Name`),
    // Core stats
    'Projection',
    'Salary',
    'Ownership_Sum',
    // Lineup variance
    'Floor',
    'Ceiling',
    'Variance',
    // Relative value
    'Proj_Sacrifice',
    'Own_Reduction',
    'Relative_Value_Ratio',
    // Simulation results (when available)
    'P_First',              // P(1st place)
    'P_Top1Pct',            // P(Top 1%)
    'P_Top5Pct',            // P(Top 5%)
    'P_Top10Pct',           // P(Top 10%)
    'P_Cash',               // P(min cash)
    'Expected_Payout',      // E[$] per entry
    'Expected_ROI',         // E[ROI] percentage
    // Scores (0-1 scale)
    'Projection_Score',
    'Ownership_Score',
    'Leverage_Score',
    'Simulation_Score',
    'RelValue_Score',
    'Variance_Score',
    'Scarcity_Score',
    'ValueLeverage_Score',
    'GameStack_Score',
    'Total_Score',
    // Flags
    'Efficient_Frontier',
  ];

  const rows: string[][] = [];

  for (const data of metricsData) {
    const lineup = data.lineup;
    const row: string[] = [
      data.rank.toString(),
      // Player names
      ...lineup.players.map(p => p.name),
      // Core stats
      lineup.projection.toFixed(2),
      lineup.salary.toString(),
      data.ownershipSum.toFixed(1),
      // Variance
      data.lineupFloor.toFixed(1),
      data.lineupCeiling.toFixed(1),
      (data.lineupCeiling - data.lineupFloor).toFixed(1),
      // Relative value
      data.projectionSacrifice.toFixed(2),
      data.ownershipReduction.toFixed(1),
      data.relativeValueRatio.toFixed(4),
      // Simulation results
      ((data.pFirst || 0) * 100).toFixed(4),
      ((data.pTop1Pct || 0) * 100).toFixed(2),
      ((data.pTop5Pct || 0) * 100).toFixed(2),
      ((data.pTop10Pct || 0) * 100).toFixed(2),
      ((data.pCash || 0) * 100).toFixed(2),
      (data.expectedPayout || 0).toFixed(2),
      (data.expectedROI || 0).toFixed(1),
      // Scores
      data.projectionScore.toFixed(3),
      data.ownershipScore.toFixed(3),
      data.leverageScore.toFixed(3),
      data.simulationScore.toFixed(3),
      data.relativeValueScore.toFixed(3),
      data.varianceScore.toFixed(3),
      (data.scarcityScore ?? 0).toFixed(3),
      (data.valueLeverageScore ?? 0).toFixed(3),
      (data.gameStackScore ?? 0).toFixed(3),
      data.totalScore.toFixed(3),
      // Flags
      data.isEfficientFrontier ? 'YES' : '',
    ];

    rows.push(row);
  }

  const csvContent = stringify([headers, ...rows]);
  fs.writeFileSync(outputPath, csvContent, 'utf-8');

  console.log(`Successfully exported metrics for ${metricsData.length} lineups`);
}
