/**
 * DFS Optimizer CLI - Command Line Interface
 *
 * Handles argument parsing and orchestrates the optimization pipeline.
 */

import { Command } from 'commander';
import * as path from 'path';
import { CLIOptions, DFSSite, Sport, ContestType, SimMode, ContestSize } from '../types';

/**
 * Parse command line arguments
 */
export function parseArguments(): CLIOptions {
  const program = new Command();

  program
    .name('dfs-optimizer')
    .description('Professional DFS lineup optimizer with game theory selection')
    .version('1.0.0')
    .option('-i, --input <file>', 'Input CSV file (SaberSim export)')
    .option('-o, --output <file>', 'Output CSV file', './exported_lineups_5000.csv')
    .option('-s, --site <site>', 'DFS site (dk, fd)', 'dk')
    .option('-p, --sport <sport>', 'Sport (nba, nfl, mlb, mma, nascar, golf)', 'nba')
    .option('-c, --contest <type>', 'Contest type (classic, showdown)', 'classic')
    .option('--pool <size>', 'Pool size to generate', '25000')
    .option('--max-exposure <pct>', 'Max player exposure (0-1)', '0.5')
    .option('--min-salary <amount>', 'Minimum salary to use')
    .option('--count <number>', 'Number of lineups to select and export', '1500')
    .option('--late-swap', 'Enable late swap mode (place DK entries in ./lateswap/entries.csv)')
    .option('--entries <file>', 'DraftKings entries CSV file', './lateswap/entries.csv')
    .option('--sim-mode <mode>', 'Simulation mode: uniform (all equal depth), tiered (legacy), or none (skip sim)', 'uniform')
    .option('--contest-size <size>', 'Contest size for field modeling: single, 3max, 20max, 150max', '20max')
    .option('--skip-sim', 'Skip tournament simulation (fastest mode)')
    .option('--calibrate', 'Run formula calibration on historical data')
    .option('--backtest', 'Run full backtest with auto-tuning on historical data')
    .option('--fast-optimize', 'Run fast formula optimizer on cached component scores')
    .option('--cache-pool', 'Cache generated pool to disk during backtest')
    .option('--from-cache', 'Load cached pool instead of regenerating during backtest')
    .option('--simple-select', 'Use simple formula-based selection (no sim/diversity/chalk penalty)')
    .option('--no-chalk', 'Skip chalk penalty in selector (A/B test)')
    .option('--sweep-select', 'Run selection parameter sweep on cached pools')
    .option('--sweep-count <n>', 'Number of LHS configs to test in sweep', '100')
    .option('--sweep-formula', 'Run fast formula weight sweep on cached pools (1M combos)')
    .option('--sweep-formula-count <n>', 'Number of weight combos to test in formula sweep', '1000000')
    .option('--backtest-fast', 'Use reduced iterations (80) and pool size (50K) for faster backtesting')
    .option('--extract-data', 'Extract pro entries, combos, and field stats to CSV')
    .option('--data <dir>', 'Directory with historical slate data for calibration', './historical_slates')
    .option('--field-samples <number>', 'Number of field ensemble samples for combo leverage (3-5)', '3')
    .option('--pool-csv <file>', 'Use a pre-built lineup pool CSV (e.g. SaberSim export) instead of generating our own')
    .option('--score-actuals <file>', 'Standalone mode: score a lineup CSV against a DK contest actuals CSV')
    .option('--actuals <file>', 'DK contest actuals CSV (used by --score-actuals and --backtest-actuals)')
    .option('--backtest-actuals', 'Mode 2 backtest: use the actual contest field as the pool, run selector, score against actuals')
    .option('--pro-names <list>', 'Comma-separated list of pro usernames to benchmark in backtest-actuals mode')
    .option('--sweep-actuals', 'Sweep selector parameters across multiple slates using actuals backtest')
    .option('--elite-backtest', 'Algorithm 7 (Haugh-Singal × Liu et al.) backtest. Uses --pool-csv as candidate pool when supplied (Mode 1), otherwise the contest field (Mode 2).')
    .option('--elite-sweep', 'Sweep Algorithm 7 selector parameters across all slates and report the best config by top-1% lift.')
    .option('--elite-live', 'Game-day Algorithm 7 selection from one or more SS pool CSVs (no actuals). Requires --input, --pool-csv (comma-separated for multiple), and --output.')
    .parse(process.argv);

  const opts = program.opts();

  // Validate site
  const site = opts.site.toLowerCase() as DFSSite;
  if (!['dk', 'fd'].includes(site)) {
    console.error(`Invalid site: ${opts.site}. Must be 'dk' or 'fd'`);
    process.exit(1);
  }

  // Validate sport
  const sport = opts.sport.toLowerCase() as Sport;
  if (!['nba', 'nfl', 'mlb', 'mma', 'nascar', 'golf'].includes(sport)) {
    console.error(`Invalid sport: ${opts.sport}. Must be 'nba', 'nfl', 'mlb', 'mma', 'nascar', or 'golf'`);
    process.exit(1);
  }

  // Validate contest type
  const contest = opts.contest.toLowerCase() as ContestType;
  if (!['classic', 'showdown'].includes(contest)) {
    console.error(`Invalid contest type: ${opts.contest}. Must be 'classic' or 'showdown'`);
    process.exit(1);
  }

  // NFL supports both classic and showdown
  if (sport === 'nfl' && contest !== 'showdown' && contest !== 'classic') {
    console.warn('NFL supports classic and showdown formats');
  }

  // Validate sim mode (--no-sim flag overrides --sim-mode)
  const simMode = opts.skipSim ? 'none' as SimMode : (opts.simMode || 'uniform').toLowerCase() as SimMode;
  if (!['uniform', 'tiered', 'none'].includes(simMode)) {
    console.error(`Invalid sim mode: ${opts.simMode}. Must be 'uniform', 'tiered', or 'none'`);
    process.exit(1);
  }

  // Validate contest size
  const contestSize = (opts.contestSize || '20max').toLowerCase() as ContestSize;
  if (!['single', '3max', '20max', '150max'].includes(contestSize)) {
    console.error(`Invalid contest size: ${opts.contestSize}. Must be 'single', '3max', '20max', or '150max'`);
    process.exit(1);
  }

  // Parse numeric options
  const poolSize = parseInt(opts.pool, 10);
  if (isNaN(poolSize) || poolSize < 1000) {
    console.error('Pool size must be at least 1000');
    process.exit(1);
  }

  const maxExposure = parseFloat(opts.maxExposure);
  if (isNaN(maxExposure) || maxExposure <= 0 || maxExposure > 1) {
    console.error('Max exposure must be between 0 and 1');
    process.exit(1);
  }

  let minSalary: number | undefined;
  if (opts.minSalary) {
    minSalary = parseInt(opts.minSalary, 10);
    if (isNaN(minSalary)) {
      console.error('Invalid minimum salary');
      process.exit(1);
    }
  }

  const lineupCount = parseInt(opts.count, 10);
  if (isNaN(lineupCount) || lineupCount < 100) {
    console.error('Lineup count must be at least 100');
    process.exit(1);
  }

  // Calibration/backtest options (check early)
  const calibrate = !!opts.calibrate;
  const backtest = !!opts.backtest;
  const fastOptimize = !!opts.fastOptimize;
  const cachePool = !!opts.cachePool;
  const fromCache = !!opts.fromCache;
  const simpleSelect = opts.simpleSelect === undefined ? true : !!opts.simpleSelect;
  const noChalk = !!opts.noChalk;
  const sweepSelect = !!opts.sweepSelect;
  const sweepCount = parseInt(opts.sweepCount || '100', 10);
  const sweepFormula = !!opts.sweepFormula;
  const sweepFormulaCount = parseInt(opts.sweepFormulaCount || '1000000', 10);
  const dataDir = opts.data ? path.resolve(opts.data) : path.resolve('./historical_slates');

  const backtestFast = !!opts.backtestFast;
  const extractData = !!opts.extractData;
  const fieldSamples = Math.max(3, Math.min(5, parseInt(opts.fieldSamples || '3', 10)));

  // New: pool CSV loader and actuals modes
  const poolCsv = opts.poolCsv ? path.resolve(opts.poolCsv) : undefined;
  const scoreActualsLineups = opts.scoreActuals ? path.resolve(opts.scoreActuals) : undefined;
  const actualsCsv = opts.actuals ? path.resolve(opts.actuals) : undefined;
  const backtestActuals = !!opts.backtestActuals;
  const sweepActuals = !!opts.sweepActuals;
  const eliteBacktest = !!opts.eliteBacktest;
  const eliteSweep = !!opts.eliteSweep;
  const eliteLive = !!opts.eliteLive;
  const proNames: string[] = opts.proNames
    ? opts.proNames.split(',').map((s: string) => s.trim()).filter((s: string) => s.length > 0)
    : [];

  // Input is required unless in calibration/backtest/optimize/sweep/extract/score mode
  // (Elite backtest in multi-slate mode reads from --data instead of --input.)
  const requiresNoInput = calibrate || backtest || fastOptimize || sweepSelect || sweepFormula
    || extractData || !!scoreActualsLineups || (eliteBacktest && !opts.input) || (eliteSweep && !opts.input);
  if (!requiresNoInput && !opts.input) {
    console.error('Error: required option \'-i, --input <file>\' not specified');
    process.exit(1);
  }

  // Resolve paths
  const inputPath = opts.input ? path.resolve(opts.input) : '';
  // Default output path changes for late swap mode
  const lateSwapMode = !!opts.lateSwap;
  const defaultOutput = lateSwapMode ? './lateswap/swapped_lineups.csv' : './exported_lineups_5000.csv';
  const outputPath = path.resolve(opts.output === './exported_lineups_5000.csv' && lateSwapMode ? defaultOutput : opts.output);

  // Late swap options
  const lateSwap = !!opts.lateSwap;
  const entriesPath = opts.entries ? path.resolve(opts.entries) : undefined;

  // Validate late swap requirements
  if (lateSwap) {
    const fs = require('fs');
    if (!entriesPath || !fs.existsSync(entriesPath)) {
      console.error('\n========================================');
      console.error('LATE SWAP MODE');
      console.error('========================================');
      console.error(`\nEntries file not found: ${entriesPath || 'not specified'}`);
      console.error('\nTo use late swap:');
      console.error('  1. Export your entries from DraftKings (My Contests > Export Entries)');
      console.error('  2. Save the file as: lateswap/entries.csv');
      console.error('  3. Update sabersim.csv with latest projections');
      console.error('  4. Run: node dist/run.js --late-swap --input ./sabersim.csv\n');
      process.exit(1);
    }
  }

  return {
    input: inputPath,
    output: outputPath,
    site,
    sport,
    contest,
    poolSize,
    maxExposure,
    minSalary,
    lineupCount,
    simMode,
    contestSize,
    lateSwap,
    entries: entriesPath,
    calibrate,
    backtest,
    fastOptimize,
    cachePool,
    fromCache,
    simpleSelect,
    noChalk,
    sweepSelect,
    sweepCount,
    sweepFormula,
    sweepFormulaCount,
    backtestFast,
    scrape: false,
    scrapeDays: 0,
    extractData,
    dataDir,
    fieldSamples,
    poolCsv,
    scoreActualsLineups,
    actualsCsv,
    backtestActuals,
    sweepActuals,
    eliteBacktest,
    eliteSweep,
    eliteLive,
    proNames,
  };
}

/**
 * Print configuration summary
 */
export function printConfig(options: CLIOptions): void {
  console.log('\n========================================');
  console.log('DFS Optimizer CLI');
  console.log('========================================\n');
  console.log('Configuration:');
  console.log(`  Site:           ${options.site.toUpperCase()}`);
  console.log(`  Sport:          ${options.sport.toUpperCase()}`);
  console.log(`  Contest:        ${options.contest}`);
  console.log(`  Input:          ${options.input}`);
  console.log(`  Output:         ${options.output}`);
  console.log(`  Pool Size:      ${options.poolSize.toLocaleString()}`);
  console.log(`  Lineup Count:   ${options.lineupCount.toLocaleString()}`);
  console.log(`  Max Exposure:   ${(options.maxExposure * 100).toFixed(0)}%`);
  console.log(`  Sim Mode:       ${options.simMode}`);
  console.log(`  Contest Size:   ${options.contestSize}`);
  if (options.minSalary) {
    console.log(`  Min Salary:     $${options.minSalary.toLocaleString()}`);
  }
  console.log('');
}

/**
 * Print final summary
 */
export function printSummary(
  selected: number,
  maxProj: number,
  avgProj: number,
  timeMs: number
): void {
  console.log('\n========================================');
  console.log('FINAL SUMMARY');
  console.log('========================================');
  console.log(`  Lineups Exported: ${selected.toLocaleString()}`);
  console.log(`  Max Projection:   ${maxProj.toFixed(2)}`);
  console.log(`  Avg Projection:   ${avgProj.toFixed(2)}`);
  console.log(`  Total Time:       ${(timeMs / 1000).toFixed(1)}s`);
  console.log('========================================\n');
}
