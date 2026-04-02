/**
 * DFS Optimizer CLI - NBA Showdown Entry Point
 *
 * Dedicated command for DraftKings NBA Showdown contests.
 * Forces showdown mode (1 CPT + 5 FLEX, $50K cap).
 *
 * Usage:
 *   node dist/run-showdown.js --input ./showdown.csv --output ./showdown_lineups.csv
 */

import * as path from 'path';
import { Command } from 'commander';
import { parseCSVFile, buildPlayerPool } from './parser';
import { getContestConfig } from './rules';
import { optimizeLineups } from './optimizer';
import { selectLineups } from './selection';
import { exportLineupsToCSV } from './scoring';

// ============================================================
// CLI ARGUMENTS
// ============================================================

function parseShowdownArgs() {
  const program = new Command();

  program
    .name('dfs-showdown')
    .description('DraftKings NBA Showdown optimizer (1 CPT + 5 FLEX)')
    .version('1.0.0')
    .requiredOption('-i, --input <file>', 'Input CSV file (SaberSim showdown export)')
    .option('-o, --output <file>', 'Output CSV file', './showdown_lineups.csv')
    .option('--pool <size>', 'Pool size to generate', '20000')
    .option('--target <count>', 'Number of lineups to select', '5000')
    .option('--max-exposure <pct>', 'Max player exposure (0-1)', '0.5')
    .parse(process.argv);

  const opts = program.opts();

  const poolSize = parseInt(opts.pool, 10);
  if (isNaN(poolSize) || poolSize < 500) {
    console.error('Pool size must be at least 500');
    process.exit(1);
  }

  const targetCount = parseInt(opts.target, 10);
  if (isNaN(targetCount) || targetCount < 10) {
    console.error('Target count must be at least 10');
    process.exit(1);
  }

  const maxExposure = parseFloat(opts.maxExposure);
  if (isNaN(maxExposure) || maxExposure <= 0 || maxExposure > 1) {
    console.error('Max exposure must be between 0 and 1');
    process.exit(1);
  }

  return {
    input: path.resolve(opts.input),
    output: path.resolve(opts.output),
    poolSize,
    targetCount,
    maxExposure,
  };
}

// ============================================================
// MAIN
// ============================================================

async function main(): Promise<void> {
  const startTime = Date.now();

  try {
    const args = parseShowdownArgs();

    console.log('========================================');
    console.log('DFS OPTIMIZER - NBA SHOWDOWN');
    console.log('========================================');
    console.log(`  Input:       ${args.input}`);
    console.log(`  Output:      ${args.output}`);
    console.log(`  Pool Size:   ${args.poolSize.toLocaleString()}`);
    console.log(`  Target:      ${args.targetCount.toLocaleString()} lineups`);
    console.log(`  Format:      1 CPT + 5 FLEX | $50,000 cap`);
    console.log('');

    // ============================================================
    // PHASE 0: PARSE CSV
    // ============================================================
    console.log('========================================');
    console.log('PHASE 0: Loading Player Data');
    console.log('========================================');

    const parseResult = parseCSVFile(args.input, 'nba');

    // Warn if auto-detection disagrees, but force showdown regardless
    if (parseResult.detectedContestType !== 'showdown') {
      console.warn(`WARNING: CSV auto-detected as '${parseResult.detectedContestType}', forcing showdown mode.`);
      console.warn('Make sure your CSV has CPT/FLEX entries (or duplicate player entries with 1.5x salary).');
    }

    // Force showdown config
    const config = getContestConfig('dk', 'nba', 'showdown');
    console.log(`Contest: ${config.name}`);
    console.log(`Roster: ${config.positions.map(p => p.name).join(', ')}`);
    console.log(`Salary Cap: $${config.salaryCap.toLocaleString()}`);
    console.log(`Teams: ${parseResult.teams.join(' vs ')}`);
    console.log('');

    // Build player pool (force showdown contest type for position parsing)
    const pool = buildPlayerPool(parseResult.players, 'showdown');

    // Separate CPT and FLEX players for reporting
    const cptPlayers = pool.players.filter(p => p.isCaptain);
    const flexPlayers = pool.players.filter(p => !p.isCaptain);

    console.log(`\nPlayer pool summary:`);
    console.log(`  CPT entries:  ${cptPlayers.length} players`);
    console.log(`  FLEX entries: ${flexPlayers.length} players`);
    console.log(`  Total:        ${pool.players.length} entries`);

    // Top CPT projections (captain value — who to captain?)
    const topCPT = [...cptPlayers].sort((a, b) => b.projection - a.projection).slice(0, 5);
    console.log(`\nTop 5 CPT projections (1.5x applied):`);
    for (const p of topCPT) {
      console.log(`  ${p.name.padEnd(25)} $${p.salary.toString().padStart(6)}  ${p.projection.toFixed(1).padStart(6)} pts  ${p.ownership.toFixed(1)}%`);
    }

    // Top FLEX projections
    const topFLEX = [...flexPlayers].sort((a, b) => b.projection - a.projection).slice(0, 5);
    console.log(`\nTop 5 FLEX projections:`);
    for (const p of topFLEX) {
      console.log(`  ${p.name.padEnd(25)} $${p.salary.toString().padStart(6)}  ${p.projection.toFixed(1).padStart(6)} pts  ${p.ownership.toFixed(1)}%`);
    }

    // ============================================================
    // PHASE 1: POOL GENERATION
    // ============================================================
    console.log('\n========================================');
    console.log('PHASE 1: Pool Generation (Branch & Bound)');
    console.log('========================================');

    const optimizationResult = optimizeLineups({
      config,
      pool,
      poolSize: args.poolSize,
    });

    if (optimizationResult.lineups.length === 0) {
      console.error('\nERROR: No valid lineups generated!');
      console.error('Check that your CSV has CPT and FLEX entries with valid projections.');
      process.exit(1);
    }

    // Print optimal lineup
    console.log('\n--- HIGHEST PROJECTION LINEUP ---');
    const optimal = optimizationResult.optimalLineup;
    for (let i = 0; i < optimal.players.length; i++) {
      const slot = config.positions[i].name;
      const p = optimal.players[i];
      const cptTag = p.isCaptain ? ' (1.5x)' : '';
      console.log(`  ${slot.padEnd(5)} ${p.name.padEnd(25)} $${p.salary.toString().padStart(6)} ${p.projection.toFixed(1).padStart(6)} pts${cptTag}`);
    }
    console.log(`  ${'─'.repeat(55)}`);
    console.log(`  ${'TOTAL'.padEnd(5)} ${''.padEnd(25)} $${optimal.salary.toString().padStart(6)} ${optimal.projection.toFixed(1).padStart(6)} pts`);
    console.log('');

    // ============================================================
    // PHASE 2: GAME THEORY SELECTION
    // ============================================================
    console.log('========================================');
    console.log('PHASE 2: Game Theory Selection');
    console.log('========================================');

    const selectionResult = selectLineups({
      lineups: optimizationResult.lineups,
      targetCount: args.targetCount,
      maxExposure: args.maxExposure,
      projectionWeight: 0.4,
      leverageWeight: 0.25,
      ownershipWeight: 0.15,
      diversityWeight: 0.2,
    });

    if (selectionResult.selected.length === 0) {
      console.error('\nERROR: No lineups selected!');
      process.exit(1);
    }

    // ============================================================
    // SHOWDOWN EXPOSURE REPORTING
    // ============================================================

    // Combined CPT+FLEX exposures by player name
    console.log('\n--- TOP PLAYER EXPOSURES (Combined CPT+FLEX) ---');
    const combinedExposures = new Map<string, { total: number; asCaptain: number; name: string }>();

    for (const [playerId, exposure] of selectionResult.exposures) {
      const player = pool.byId.get(playerId);
      if (player) {
        const existing = combinedExposures.get(player.name) || { total: 0, asCaptain: 0, name: player.name };
        existing.total += exposure;
        if (player.isCaptain) {
          existing.asCaptain += exposure;
        }
        combinedExposures.set(player.name, existing);
      }
    }

    const sortedCombined = Array.from(combinedExposures.values())
      .sort((a, b) => b.total - a.total)
      .slice(0, 12);

    for (const { name, total, asCaptain } of sortedCombined) {
      const cptPct = asCaptain > 0 ? ` (${asCaptain.toFixed(1)}% as CPT)` : '';
      console.log(`  ${name.padEnd(25)} ${total.toFixed(1).padStart(5)}%${cptPct}`);
    }

    // Captain distribution
    console.log('\n--- CAPTAIN DISTRIBUTION ---');
    const captainExposures = Array.from(combinedExposures.values())
      .filter(e => e.asCaptain > 0)
      .sort((a, b) => b.asCaptain - a.asCaptain)
      .slice(0, 10);

    let captainTotal = 0;
    for (const { name, asCaptain } of captainExposures) {
      console.log(`  ${name.padEnd(25)} ${asCaptain.toFixed(1).padStart(5)}%`);
      captainTotal += asCaptain;
    }
    if (captainTotal < 99) {
      console.log(`  ${'(others)'.padEnd(25)} ${(100 - captainTotal).toFixed(1).padStart(5)}%`);
    }

    // ============================================================
    // PHASE 3: EXPORT
    // ============================================================
    console.log('\n========================================');
    console.log('PHASE 3: Export');
    console.log('========================================');

    exportLineupsToCSV(selectionResult.selected, config, args.output);

    // Final summary
    const endTime = Date.now();
    const avgProj = selectionResult.selected.reduce((s, l) => s + l.projection, 0) / selectionResult.selected.length;

    console.log('\n========================================');
    console.log('SHOWDOWN SUMMARY');
    console.log('========================================');
    console.log(`  Lineups Exported: ${selectionResult.selected.length.toLocaleString()}`);
    console.log(`  Max Projection:   ${selectionResult.selected[0].projection.toFixed(2)}`);
    console.log(`  Avg Projection:   ${avgProj.toFixed(2)}`);
    console.log(`  Total Time:       ${((endTime - startTime) / 1000).toFixed(1)}s`);
    console.log('========================================\n');

    console.log(`Output file: ${args.output}`);
    console.log('\nDone! Your showdown lineups are ready.\n');

  } catch (error) {
    console.error('\n========================================');
    console.error('ERROR');
    console.error('========================================');
    if (error instanceof Error) {
      console.error(error.message);
      if (process.env.DEBUG) {
        console.error(error.stack);
      }
    } else {
      console.error(error);
    }
    process.exit(1);
  }
}

main();
