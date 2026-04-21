/**
 * DFS Optimizer CLI - Main Entry Point
 *
 * Orchestrates the full optimization pipeline:
 * 1. Parse CLI arguments
 * 2. Load and parse CSV file (auto-detects showdown vs classic)
 * 3. Generate lineup pool (Phase 1)
 * 4. Apply game theory selection (Phase 2)
 * 5. Export lineups to CSV
 */

import { parseArguments, printConfig, printSummary } from './cli';
import { parseCSVFile, buildPlayerPool, parseLockStatus, loadPoolFromCSV } from './parser';
import { getContestConfig } from './rules';
import { optimizeLineups, generateEdgeBoostedPool } from './optimizer';
import { selectLineupsSimple } from './selection/simple-selector';
import { computePlayerEdgeScores } from './selection/scoring/field-analysis';
import { exportLineupsToCSV, exportSwappedLineups, exportSwapReport, exportLineupsWithMetrics, scoreLineupCsvAgainstActuals, printScoreReport } from './scoring';
import { parseContestActuals } from './parser';
import { parseDraftKingsEntries, optimizeLateSwaps } from './swapper';
import { runCalibration, runBacktest, runFastFormulaOptimizer, runSelectionSweep } from './calibration';
import { runFormulaSweep } from './calibration/formula-sweep';
import { runDataExtraction } from './calibration/data-extractor';
import { Player } from './types';

// ============================================================
// MAIN EXECUTION
// ============================================================

async function main(): Promise<void> {
  const startTime = Date.now();

  try {
    // Parse CLI arguments
    const options = parseArguments();

    // Check for calibration mode
    if (options.calibrate) {
      await runCalibration(
        options.dataDir || './historical_slates',
        options.site,
        options.sport
      );
      return;
    }

    // Check for backtest mode
    if (options.backtest) {
      await runBacktest(
        options.dataDir || './historical_slates',
        options.sport,
        options.site,
        { cachePool: options.cachePool, fromCache: options.fromCache, simpleSelect: options.simpleSelect, noChalk: options.noChalk, backtestFast: options.backtestFast },
      );
      return;
    }

    // Check for selection parameter sweep mode
    if (options.sweepSelect) {
      await runSelectionSweep(
        options.dataDir || './historical_slates',
        options.sport,
        options.site,
        options.sweepCount || 100
      );
      return;
    }

    // Check for data extraction mode
    if (options.extractData) {
      await runDataExtraction(
        options.dataDir || './historical_slates',
        options.sport,
        options.site,
      );
      return;
    }

    // Check for formula weight sweep mode
    if (options.sweepFormula) {
      await runFormulaSweep(
        options.dataDir || './historical_slates',
        options.sport,
        options.site,
        options.sweepFormulaCount || 1000000
      );
      return;
    }

    // Check for fast formula optimizer mode
    if (options.fastOptimize) {
      await runFastFormulaOptimizer(
        options.dataDir || './historical_slates',
        options.sport,
        options.site
      );
      return;
    }

    // Check for late swap mode
    if (options.lateSwap) {
      await runLateSwap(options, startTime);
      return;
    }

    // Check for standalone scoring mode (--score-actuals)
    if (options.scoreActualsLineups) {
      await runScoreActuals(options);
      return;
    }

    // Check for Mode 2 backtest (--backtest-actuals)
    if (options.backtestActuals) {
      await runBacktestActuals(options);
      return;
    }

    // Check for Algorithm 7 elite backtest (--elite-backtest)
    if (options.eliteBacktest) {
      const { runEliteBacktest } = await import('./backtest/elite-backtest');
      await runEliteBacktest(options);
      return;
    }

    // Check for Algorithm 7 parameter sweep (--elite-sweep)
    if (options.eliteSweep) {
      const { runEliteSweep } = await import('./backtest/elite-sweep');
      await runEliteSweep(options);
      return;
    }

    // Check for Algorithm 7 live mode (--elite-live)
    if (options.eliteLive) {
      const { runEliteLive } = await import('./backtest/elite-live');
      await runEliteLive(options);
      return;
    }

    // Check for Backtest Intelligence modes (--analyze-slate / --analyze-all)
    if (options.analyzeSlateMode || options.analyzeAllMode) {
      await runAnalyzeMode(options);
      return;
    }

    // Check for Full-Analysis modes (--full-analysis / --full-calibrate)
    if (options.fullAnalysisMode || options.fullCalibrateMode) {
      await runFullAnalysisMode(options);
      return;
    }

    // Build region map
    if (options.buildRegionMapMode) {
      await runBuildRegionMap(options);
      return;
    }

    // V32 selector (region-targeted)
    if (options.v32SelectMode) {
      const { runV32Select } = await import('./selection/v32-selector');
      await runV32Select(options);
      return;
    }

    // V31 selector (corrected math)
    if (options.v31SelectMode) {
      const { runV31Select } = await import('./selection/v31-selector');
      await runV31Select(options);
      return;
    }

    // V30 selector (λ-sweep + evil twin)
    if (options.v30SelectMode) {
      const { runV30Select } = await import('./selection/v30-selector');
      await runV30Select(options);
      return;
    }

    // Calibrate opponent model
    if (options.calibrateOpponentMode) {
      await runCalibrateOpponent(options);
      return;
    }

    // Check for parameter sweep (--sweep-actuals)
    if (options.sweepActuals) {
      const { runActualsSweep } = await import('./backtest/sweep-actuals');
      await runActualsSweep(options);
      return;
    }

    // Parse CSV file (auto-detects contest type)
    console.log('========================================');
    console.log('PHASE 0: Loading Player Data');
    console.log('========================================');
    const parseResult = parseCSVFile(options.input, options.sport);

    // Use auto-detected contest type (override CLI if different)
    const contestType = parseResult.detectedContestType;
    if (contestType !== options.contest) {
      console.log(`Note: Using detected contest type (${contestType}) instead of CLI option (${options.contest})`);
    }

    // Update options with detected contest type for display
    const effectiveOptions = { ...options, contest: contestType };
    printConfig(effectiveOptions);

    // Get contest configuration based on detected type
    const config = getContestConfig(options.site, options.sport, contestType);
    console.log(`Contest: ${config.name}`);
    console.log(`Roster: ${config.positions.map(p => p.name).join(', ')}`);
    console.log(`Salary Cap: $${config.salaryCap.toLocaleString()}`);
    if (contestType === 'showdown') {
      console.log(`Teams: ${parseResult.teams.join(' vs ')} (must use players from BOTH teams)`);
    }
    console.log('');

    // Build player pool
    const pool = buildPlayerPool(parseResult.players, contestType);

    // Adaptive pool size based on slate characteristics
    // - Showdown: 6 players, limited combos → cap at 20k
    // - Small slates need MORE lineups to find proportionally diverse ones
    // - Full slates: use requested pool size
    let effectivePoolSize = options.poolSize;
    if (contestType === 'showdown') {
      effectivePoolSize = Math.min(options.poolSize, 20000);
    } else if (pool.players.length < 35) {
      // Small slate (MMA) - need MORE lineups to find diversity, not fewer
      effectivePoolSize = Math.min(options.poolSize, 75000);
      console.log(`\n  Small slate detected (${pool.players.length} players) - using ${effectivePoolSize.toLocaleString()} pool for diversity`);
    } else {
      // Detect short MLB/team-sport slates (2-3 games) and bump pool size
      // so we get more pitcher and stack diversity in the candidate pool.
      const gameSet = new Set<string>();
      for (const p of pool.players) gameSet.add(p.gameInfo || `${p.team}_game`);
      if (gameSet.size <= 2) {
        effectivePoolSize = Math.max(options.poolSize, 60000);
        console.log(`\n  2-game slate detected (${gameSet.size} games) - using ${effectivePoolSize.toLocaleString()} pool for diversity`);
      } else if (gameSet.size === 3) {
        effectivePoolSize = Math.max(options.poolSize, 40000);
        console.log(`\n  3-game slate detected - using ${effectivePoolSize.toLocaleString()} pool for diversity`);
      }
    }

    // Print player pool summary
    console.log(`\nPlayer pool summary:`);
    for (const [pos, players] of pool.byPosition) {
      console.log(`  ${pos}: ${players.length} players`);
    }

    // Find top projected players
    const topPlayers = [...pool.players].sort((a, b) => b.projection - a.projection).slice(0, 5);
    console.log(`\nTop 5 projected players:`);
    for (const p of topPlayers) {
      console.log(`  ${p.name} (${p.positions.join('/')}) - $${p.salary} - ${p.projection.toFixed(1)} pts - ${p.ownership.toFixed(1)}%`);
    }

    // ========================================================
    // POOL CSV MODE: skip phases 1/1.5/1.75 entirely
    // ========================================================
    let mergedLineups: import('./types').Lineup[];

    if (options.poolCsv) {
      console.log('\n========================================');
      console.log('PHASE 1: Pool CSV Load (skipping our pool generation)');
      console.log('========================================');

      const poolResult = loadPoolFromCSV({
        filePath: options.poolCsv,
        config,
        playerMap: pool.byId,
      });

      if (poolResult.lineups.length === 0) {
        console.error('\nERROR: No valid lineups loaded from pool CSV!');
        console.error('Common causes: player IDs in pool CSV don\'t match the projection file,');
        console.error('or position columns are missing from the pool CSV.');
        process.exit(1);
      }

      mergedLineups = poolResult.lineups;

      // MLB: filter for min 4-man batter stack (same as our pool gen does)
      if (options.sport === 'mlb') {
        const before = mergedLineups.length;
        mergedLineups = mergedLineups.filter(l => {
          const batterTeams = new Map<string, number>();
          for (const p of l.players) {
            if (!p.positions.includes('P')) {
              batterTeams.set(p.team, (batterTeams.get(p.team) || 0) + 1);
            }
          }
          let maxStack = 0;
          for (const c of batterTeams.values()) if (c > maxStack) maxStack = c;
          return maxStack >= 4;
        });
        const rejected = before - mergedLineups.length;
        if (rejected > 0) {
          console.log(`  MLB stack filter: removed ${rejected} lineups without 4+ batter stack`);
        }
      }

      console.log(`Pool loaded from CSV: ${mergedLineups.length.toLocaleString()} lineups`);

      // Skip phase 1.5/1.75 — we trust the externally-built pool to be diverse.
      // Jump straight to phase 2 by reusing the existing flow below.
      // (the rest of the function uses `mergedLineups` so we just need to skip
      // the optimization/edge phases)
    } else {
    // Phase 1: Optimization
    console.log('\n========================================');
    console.log('PHASE 1: Pool Generation (Branch & Bound)');
    console.log('========================================');

    const optimizationResult = optimizeLineups({
      config,
      pool,
      poolSize: effectivePoolSize,
      minSalary: options.minSalary,
    });

    if (optimizationResult.lineups.length === 0) {
      console.error('\nERROR: No valid lineups generated!');
      console.error('Check that your CSV has enough players with valid projections.');
      process.exit(1);
    }

    // Print optimal lineup (highest projection found in pool)
    console.log('\n--- HIGHEST PROJECTION LINEUP (from pool) ---');
    const optimal = optimizationResult.optimalLineup;
    for (let i = 0; i < optimal.players.length; i++) {
      const slot = config.positions[i].name;
      const p = optimal.players[i];
      console.log(`  ${slot.padEnd(5)} ${p.name.padEnd(25)} $${p.salary.toString().padStart(6)} ${p.projection.toFixed(1).padStart(5)} pts`);
    }
    console.log(`  ${'─'.repeat(50)}`);
    console.log(`  ${'TOTAL'.padEnd(5)} ${''.padEnd(25)} $${optimal.salary.toString().padStart(6)} ${optimal.projection.toFixed(1).padStart(5)} pts`);
    console.log('');

    // Phase 1.5: Compute edge scores from initial pool
    console.log('\n========================================');
    console.log('PHASE 1.5: Edge Analysis');
    console.log('========================================');

    const allPlayers: Player[] = [];
    const seenPlayerIds = new Set<string>();
    for (const lineup of optimizationResult.lineups) {
      for (const player of lineup.players) {
        if (!seenPlayerIds.has(player.id)) {
          seenPlayerIds.add(player.id);
          allPlayers.push(player);
        }
      }
    }

    const rosterSize = config.positions.length;
    const edgeScores = computePlayerEdgeScores(
      optimizationResult.lineups,
      allPlayers,
      rosterSize
    );

    console.log(`Edge players found: ${edgeScores.players.size}`);
    console.log(`Game groups: ${edgeScores.gameGroups.size}`);
    console.log(`Top edge: ${edgeScores.topEdgePlayerIds.slice(0, 5).map(id => {
      const p = pool.byId.get(id);
      const info = edgeScores.players.get(id);
      return `${p?.name} (${(info?.edgeScore || 0).toFixed(2)})`;
    }).join(', ')}`);

    // Phase 1.75: Edge-boosted generation
    console.log('\n========================================');
    console.log('PHASE 1.75: Edge-Boosted Generation');
    console.log('========================================');

    const existingHashes = new Set(optimizationResult.lineups.map(l => l.hash));
    const edgeBoostedResult = generateEdgeBoostedPool({
      config,
      pool,
      edgeScores,
      iterations: 25,
      lineupsPerIteration: 500,
      existingHashes,
      minSalary: options.minSalary,
    });

    // Merge pools
    mergedLineups = [...optimizationResult.lineups, ...edgeBoostedResult.lineups];

    // MLB: filter merged pool for min 4-man batter stack
    if (options.sport === 'mlb') {
      const beforeCount = mergedLineups.length;
      mergedLineups = mergedLineups.filter(l => {
        const batterTeams = new Map<string, number>();
        for (const p of l.players) {
          if (!p.positions.includes('P')) {
            batterTeams.set(p.team, (batterTeams.get(p.team) || 0) + 1);
          }
        }
        let maxStack = 0;
        for (const count of batterTeams.values()) {
          if (count > maxStack) maxStack = count;
        }
        return maxStack >= 4;
      });
      const rejected = beforeCount - mergedLineups.length;
      if (rejected > 0) console.log(`  MLB stack filter (merged): removed ${rejected} lineups without 4+ batter stack`);
    }

    console.log(`Merged pool: ${mergedLineups.length.toLocaleString()} lineups (${optimizationResult.lineups.length.toLocaleString()} pass 1 + ${edgeBoostedResult.lineups.length.toLocaleString()} edge-boosted)`);
    } // end of else (non-poolCsv path)

    // Phase 2: Selection
    console.log('\n========================================');
    console.log('PHASE 2: Game Theory Selection');
    console.log('========================================');

    const TARGET_LINEUPS = options.lineupCount;

    // Count distinct games for slate size detection
    const gameSet = new Set<string>();
    for (const p of pool.players) {
      const gameId = p.gameInfo || `${p.team}_game`;
      gameSet.add(gameId);
    }
    const numGames = gameSet.size;

    const selectionResult = selectLineupsSimple({
      lineups: mergedLineups,
      targetCount: TARGET_LINEUPS,
      numGames,
      salaryCap: config.salaryCap,
      sport: options.sport,
      players: pool.players,
      contestSize: options.contestSize,
      fieldSamples: options.fieldSamples,
      simMode: options.simMode,
    });

    if (selectionResult.selected.length === 0) {
      console.error('\nERROR: No lineups selected!');
      process.exit(1);
    }

    // Print top exposures
    // For showdown: combine CPT/FLEX exposures by player name
    if (contestType === 'showdown') {
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
        .slice(0, 10);

      for (const { name, total, asCaptain } of sortedCombined) {
        const cptPct = asCaptain > 0 ? ` (${asCaptain.toFixed(1)}% as CPT)` : '';
        console.log(`  ${name.padEnd(25)} ${total.toFixed(1).padStart(5)}%${cptPct}`);
      }

      // Also show captain distribution
      console.log('\n--- CAPTAIN DISTRIBUTION ---');
      const captainExposures = Array.from(combinedExposures.values())
        .filter(e => e.asCaptain > 0)
        .sort((a, b) => b.asCaptain - a.asCaptain)
        .slice(0, 8);

      for (const { name, asCaptain } of captainExposures) {
        console.log(`  ${name.padEnd(25)} ${asCaptain.toFixed(1).padStart(5)}%`);
      }
    } else {
      console.log('\n--- TOP PLAYER EXPOSURES ---');
      const sortedExposures = Array.from(selectionResult.exposures.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

      for (const [playerId, exposure] of sortedExposures) {
        const player = pool.byId.get(playerId);
        if (player) {
          console.log(`  ${player.name.padEnd(25)} ${exposure.toFixed(1).padStart(5)}%`);
        }
      }
    }

    // Export to CSV
    console.log('\n========================================');
    console.log('PHASE 3: Export');
    console.log('========================================');

    // Export SaberSim-compatible CSV (for upload)
    exportLineupsToCSV(selectionResult.selected, config, options.output);

    // Final summary
    const endTime = Date.now();
    printSummary(
      selectionResult.selected.length,
      selectionResult.selected[0].projection,
      selectionResult.avgProjection,
      endTime - startTime
    );

    console.log(`Output file: ${options.output}`);
    console.log('\nDone! Your lineups are ready for SaberSim upload.\n');

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

// ============================================================
// LATE SWAP MODE
// ============================================================

async function runLateSwap(options: import('./types').CLIOptions, startTime: number): Promise<void> {
  console.log('========================================');
  console.log('LATE SWAP MODE');
  console.log('========================================');
  console.log(`Entries file: ${options.entries}`);
  console.log(`Projections file: ${options.input}`);
  console.log(`Output file: ${options.output}`);
  console.log('');

  // Parse updated projections (include 0-projection players for late swap)
  console.log('Loading updated projections...');
  const parseResult = parseCSVFile(options.input, options.sport, true);  // includeZeroProjection = true
  const contestType = parseResult.detectedContestType;

  // Get contest configuration
  const config = getContestConfig(options.site, options.sport, contestType);
  console.log(`Contest: ${config.name}`);
  console.log(`Roster: ${config.positions.map(p => p.name).join(', ')}`);

  // Build player pool
  const pool = buildPlayerPool(parseResult.players, contestType);
  console.log(`Player pool: ${pool.players.length} players`);

  // Parse lock status from projections file
  console.log('\nParsing lock status...');
  const lockStatus = parseLockStatus(options.input);

  // Parse DraftKings entries
  console.log('\nLoading DraftKings entries...');
  const entries = parseDraftKingsEntries(options.entries!, config);

  // Count distinct games for slate size detection
  const gameSet = new Set<string>();
  for (const p of pool.players) {
    const gameId = p.gameInfo || `${p.team}_game`;
    gameSet.add(gameId);
  }
  const numGames = gameSet.size;
  console.log(`Games on slate: ${numGames}`);

  // Run late swap optimization (full pipeline)
  const swapResult = optimizeLateSwaps(entries, pool, config, lockStatus, numGames);

  // Export results
  console.log('\n========================================');
  console.log('EXPORT');
  console.log('========================================');

  // Export swapped lineups (DraftKings-ready)
  exportSwappedLineups(swapResult.results, config, options.output);

  // Also export a detailed report
  const reportPath = options.output.replace('.csv', '_report.csv');
  exportSwapReport(swapResult.results, config, reportPath);

  // Final summary
  const endTime = Date.now();
  console.log('\n========================================');
  console.log('LATE SWAP COMPLETE');
  console.log('========================================');
  console.log(`  Entries processed: ${swapResult.results.length}`);
  console.log(`  Entries improved:  ${swapResult.entriesImproved}`);
  console.log(`  Avg projection gain: +${swapResult.avgProjectionGain.toFixed(2)} pts`);
  console.log(`  Candidates generated: ${swapResult.candidatesGenerated}`);
  console.log(`  Field size: ${swapResult.fieldSize}`);
  console.log(`  Simulation run: ${swapResult.simulationRun}`);
  console.log(`  Total time: ${((endTime - startTime) / 1000).toFixed(1)}s`);
  console.log('========================================\n');

  console.log(`Swapped lineups: ${options.output}`);
  console.log(`Swap report: ${reportPath}`);
  console.log('\nDone! Upload your swapped lineups to DraftKings.\n');
}

// ============================================================
// STANDALONE: SCORE A LINEUP CSV AGAINST CONTEST ACTUALS
// ============================================================

async function runScoreActuals(options: import('./types').CLIOptions): Promise<void> {
  console.log('========================================');
  console.log('SCORE LINEUPS vs ACTUALS');
  console.log('========================================');
  if (!options.actualsCsv) {
    console.error('Error: --score-actuals requires --actuals <file>');
    process.exit(1);
  }
  if (!options.input) {
    console.error('Error: --score-actuals requires --input <projections-file> for player ID/name mapping');
    process.exit(1);
  }

  console.log(`Lineups CSV:    ${options.scoreActualsLineups}`);
  console.log(`Actuals CSV:    ${options.actualsCsv}`);
  console.log(`Projections:    ${options.input}`);

  // Load projections to get the player ID → name map
  const parseResult = parseCSVFile(options.input, options.sport, true);
  const config = getContestConfig(options.site, options.sport, parseResult.detectedContestType);
  const pool = buildPlayerPool(parseResult.players, parseResult.detectedContestType);

  // Parse the contest actuals
  const actuals = parseContestActuals(options.actualsCsv, config);
  console.log(`Loaded ${actuals.entries.length} contest entries and ${actuals.playerActualsByName.size} player actuals`);

  // Score the lineup CSV
  const report = scoreLineupCsvAgainstActuals({
    lineupCsvPath: options.scoreActualsLineups!,
    actuals,
    config,
    playerMap: pool.byId,
  });

  printScoreReport(report, 'Submitted lineups');
}

// ============================================================
// MODE 2 BACKTEST: USE ACTUAL CONTEST FIELD AS THE POOL
// ============================================================

async function runBacktestActuals(options: import('./types').CLIOptions): Promise<void> {
  // Implementation in src/backtest/actuals-backtest.ts to keep run.ts manageable.
  const { runActualsBacktest } = await import('./backtest/actuals-backtest');
  await runActualsBacktest(options);
}

// ============================================================
// BACKTEST INTELLIGENCE MODE (--analyze-slate / --analyze-all)
// ============================================================

async function runAnalyzeMode(options: import('./types').CLIOptions): Promise<void> {
  const { analyzeSlate, analyzeAllSlates, generateCalibrationReport, discoverSlates } = await import('./analysis');
  const path = await import('path');

  console.log('========================================');
  console.log('BACKTEST INTELLIGENCE');
  console.log('========================================');

  const outDir = options.analysisOut || options.dataDir || './historical_slates';
  const minProEntries = options.minProEntries ?? 100;

  if (options.analyzeAllMode) {
    const dataDir = options.dataDir || './historical_slates';
    console.log(`Scanning ${dataDir} for slate pairs…`);
    const { perSlate, crossSlate } = await analyzeAllSlates(dataDir, options.site, options.sport, { minProEntries });
    if (perSlate.length === 0) {
      console.error('No slates produced results.');
      process.exit(1);
    }
    const { markdownPath, jsonPath } = generateCalibrationReport({
      outDir,
      sport: options.sport,
      perSlate,
      crossSlate,
    });
    console.log(`\n✓ Analyzed ${perSlate.length} slates`);
    console.log(`  Markdown: ${markdownPath}`);
    console.log(`  JSON:     ${jsonPath}`);
    return;
  }

  // Single-slate mode
  if (!options.input) {
    console.error('Error: --analyze-slate requires --input <projections-csv>');
    process.exit(1);
  }
  if (!options.actualsCsv) {
    console.error('Error: --analyze-slate requires --actuals <dk-contest-csv>');
    process.exit(1);
  }

  const baseIn = path.basename(options.input);
  const slateName =
    baseIn.match(/^(\d{4}-\d{2}-\d{2}(?:_dk(?:_night)?)?)_projections\.csv$/)?.[1]
    || baseIn.match(/^(\d{1,2}-\d{1,2}-\d{2,4})[-_]?.*projections\.csv$/i)?.[1]
    || 'slate';
  const inputs = {
    slate: slateName,
    projectionsPath: options.input,
    actualsPath: options.actualsCsv,
    poolCsvPath: options.poolCsv,
  };

  console.log(`Slate: ${slateName}`);
  console.log(`  projections: ${inputs.projectionsPath}`);
  console.log(`  actuals:     ${inputs.actualsPath}`);
  if (inputs.poolCsvPath) console.log(`  pool:        ${inputs.poolCsvPath}`);

  const result = await analyzeSlate(inputs, options.site, options.sport, { minProEntries });
  if (!result) {
    console.error('Analysis produced no result.');
    process.exit(1);
  }

  const { markdownPath, jsonPath } = generateCalibrationReport({
    outDir,
    sport: options.sport,
    perSlate: [result],
  });
  console.log(`\n✓ Analysis complete`);
  console.log(`  Markdown: ${markdownPath}`);
  console.log(`  JSON:     ${jsonPath}`);
}

// ============================================================
// BUILD REGION MAP
// ============================================================

async function runBuildRegionMap(options: import('./types').CLIOptions): Promise<void> {
  const { buildRegionMap, saveRegionMap, printRegionMap } = await import('./analysis/region-map');
  const { parseCSVFile, buildPlayerPool, parseContestActuals } = await import('./parser');
  const { getContestConfig } = await import('./rules');
  const { discoverSlates } = await import('./analysis');
  const path = await import('path');

  console.log('========================================');
  console.log('BUILD REGION MAP');
  console.log('========================================');

  const dataDir = options.dataDir || './historical_slates';
  const slateInputs = discoverSlates(dataDir);
  console.log(`Found ${slateInputs.length} slates in ${dataDir}`);

  const slateData: Array<{ entries: any[]; playerByName: Map<string, any>; totalEntries: number }> = [];
  for (const s of slateInputs) {
    try {
      const pr = parseCSVFile(s.projectionsPath, options.sport, true);
      const cfg = getContestConfig(options.site, options.sport, pr.detectedContestType);
      const pool = buildPlayerPool(pr.players, pr.detectedContestType);
      const actuals = parseContestActuals(s.actualsPath, cfg);
      const playerByName = new Map<string, any>();
      for (const p of pool.players) {
        playerByName.set(p.name.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(), p);
      }
      slateData.push({ entries: actuals.entries, playerByName, totalEntries: actuals.entries.length });
      console.log(`  loaded ${s.slate}: ${actuals.entries.length} entries`);
    } catch (err) {
      console.warn(`  skip ${s.slate}: ${(err as Error).message}`);
    }
  }

  if (slateData.length === 0) { console.error('No slates loaded.'); process.exit(1); }

  // Sport-specific bins
  const projBins = options.sport === 'nba'
    ? [200, 220, 235, 245, 255, 265, 275, 285, 300]
    : [70, 80, 85, 90, 95, 100, 105, 110, 120];
  const ownBins = options.sport === 'nba'
    ? [0, 10, 15, 18, 21, 24, 28, 35, 50]
    : [0, 5, 8, 12, 16, 20, 25, 35, 60];

  const regionMap = buildRegionMap(slateData, projBins, ownBins);
  printRegionMap(regionMap);

  const outDir = options.analysisOut || dataDir;
  const outPath = path.join(outDir, `region-map-${options.sport}-${options.site}.json`);
  saveRegionMap(regionMap, outPath);
  console.log(`\nRegion map saved to ${outPath}`);
}

// ============================================================
// CALIBRATE OPPONENT MODEL
// ============================================================

async function runCalibrateOpponent(options: import('./types').CLIOptions): Promise<void> {
  const opponentMod = await import('./opponent/calibration');
  const { parseCSVFile, buildPlayerPool, parseContestActuals } = await import('./parser');
  const { getContestConfig } = await import('./rules');
  const { discoverSlates } = await import('./analysis');
  const path = await import('path');

  console.log('========================================');
  console.log('CALIBRATE OPPONENT MODEL');
  console.log('========================================');

  const dataDir = options.dataDir || './historical_slates';
  const slateInputs = discoverSlates(dataDir);
  console.log(`Found ${slateInputs.length} slates in ${dataDir}`);

  const calSlates: import('./opponent/calibration').CalibrationSlate[] = [];
  for (const s of slateInputs) {
    try {
      const pr = parseCSVFile(s.projectionsPath, options.sport, true);
      const cfg = getContestConfig(options.site, options.sport, pr.detectedContestType);
      const pool = buildPlayerPool(pr.players, pr.detectedContestType);
      const actuals = parseContestActuals(s.actualsPath, cfg);
      calSlates.push({ slate: s.slate, players: pool.players, config: cfg, actuals });
    } catch (err) {
      console.warn(`  skip ${s.slate}: ${(err as Error).message}`);
    }
  }
  if (calSlates.length === 0) { console.error('No slates loaded.'); process.exit(1); }

  const model = opponentMod.calibrateOpponentModel(calSlates, options.sport);
  const outDir = options.analysisOut || dataDir;
  const outPath = path.join(outDir, `opponent-${options.sport}-${options.site}.json`);
  opponentMod.saveOpponentModel(model, outPath);
}

// ============================================================
// FULL-ANALYSIS MODE (--full-analysis / --full-calibrate)
// ============================================================

async function runFullAnalysisMode(options: import('./types').CLIOptions): Promise<void> {
  const { runFullAnalysis, runFullCalibration } = await import('./analysis/sim');
  const { writeFullReport } = await import('./analysis/sim/report');
  const path = await import('path');

  console.log('========================================');
  console.log('FULL ANALYSIS (sim-backed)');
  console.log('========================================');

  const outDir = options.analysisOut || options.dataDir || './historical_slates';
  const minProEntries = options.minProEntries ?? 100;
  const numWorlds = options.worlds ?? 2000;

  if (options.fullCalibrateMode) {
    const dataDir = options.dataDir || './historical_slates';
    console.log(`Scanning ${dataDir}  |  worlds=${numWorlds}  |  minProEntries=${minProEntries}`);
    const { perSlate, crossSlate } = await runFullCalibration(dataDir, options.site, options.sport, { minProEntries, numWorlds });
    if (perSlate.length === 0) { console.error('No slates produced results.'); process.exit(1); }
    const { markdownPath, jsonPath } = writeFullReport({
      outDir, sport: options.sport, perSlate, crossSlate,
    });
    console.log(`\n✓ Analyzed ${perSlate.length} slates`);
    console.log(`  Markdown: ${markdownPath}`);
    console.log(`  JSON:     ${jsonPath}`);
    return;
  }

  if (!options.input) { console.error('--full-analysis requires --input'); process.exit(1); }
  if (!options.actualsCsv) { console.error('--full-analysis requires --actuals'); process.exit(1); }
  const baseIn = path.basename(options.input);
  const slateName =
    baseIn.match(/^(\d{4}-\d{2}-\d{2}(?:_dk(?:_night)?)?)_projections\.csv$/)?.[1]
    || baseIn.match(/^(\d{1,2}-\d{1,2}-\d{2,4})[-_]?.*projections\.csv$/i)?.[1]
    || 'slate';
  const inputs = {
    slate: slateName,
    projectionsPath: options.input,
    actualsPath: options.actualsCsv,
    poolCsvPath: options.poolCsv,
  };
  console.log(`Slate: ${slateName}  |  worlds=${numWorlds}`);
  const result = await runFullAnalysis(inputs, options.site, options.sport, { minProEntries, numWorlds });
  if (!result) { console.error('Analysis produced no result.'); process.exit(1); }
  const { markdownPath, jsonPath } = writeFullReport({
    outDir, sport: options.sport, perSlate: [result],
  });
  console.log(`\n✓ Done`);
  console.log(`  Markdown: ${markdownPath}`);
  console.log(`  JSON:     ${jsonPath}`);
}

// Run
main();
