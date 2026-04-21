/**
 * V30 Selector — Full research-grounded GPP portfolio construction.
 *
 * Pipeline:
 *   1. (Optional) Load calibrated opponent model → generate synthetic field
 *   2. precomputeSlate → world scores, thresholds, σ_{δ,G}
 *   3. λ-sweep portfolio construction (Haugh-Singal Algorithm 7)
 *   4. Evil twin hedging (Liu et al. Section 5.3)
 *   5. Diagnostics + export
 */

import * as fs from 'fs';
import { CLIOptions, ContestConfig, Lineup, Player, PlayerPool, Sport } from '../types';
import { parseCSVFile, buildPlayerPool, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';
import {
  precomputeSlate,
  defaultGamma,
  getSportDefaults,
  DEFAULT_SELECTOR_PARAMS,
  SelectorParams,
  SlatePrecomputation,
} from './algorithm7-selector';
import { lambdaSweepSelect, LambdaSweepParams } from './lambda-sweep';
import { applyEvilTwinHedging, DEFAULT_EVIL_TWIN_PARAMS, EvilTwinParams } from './evil-twin';
import { loadOpponentModel, OpponentModelParams } from '../opponent/calibration';
import { generateCalibratedField } from '../opponent/field-generator';
import { exportForDraftKings, exportDetailedLineups } from '../scoring';

// ============================================================
// MAIN
// ============================================================

export async function runV30Select(options: CLIOptions): Promise<void> {
  console.log('================================================================');
  console.log('V30 SELECT — λ-sweep + evil twin');
  console.log('================================================================');

  if (!options.input) { console.error('--input required'); process.exit(1); }
  if (!options.poolCsv) { console.error('--pool-csv required'); process.exit(1); }

  // 1. Parse projections
  const parseResult = parseCSVFile(options.input, options.sport, true);
  const config = getContestConfig(options.site, options.sport, parseResult.detectedContestType);
  const pool = buildPlayerPool(parseResult.players, parseResult.detectedContestType);
  console.log(`  players: ${pool.players.length}`);

  // 2. Load pool CSVs (comma-separated)
  const poolPaths = options.poolCsv.split(',').map(s => s.trim());
  let candidatePool: Lineup[] = [];
  const seen = new Set<string>();
  for (const pp of poolPaths) {
    if (!fs.existsSync(pp)) { console.warn(`  pool not found: ${pp}`); continue; }
    const loaded = loadPoolFromCSV({ filePath: pp, config, playerMap: pool.byId });
    for (const l of loaded.lineups) {
      if (!seen.has(l.hash)) { seen.add(l.hash); candidatePool.push(l); }
    }
  }
  console.log(`  candidate pool: ${candidatePool.length} unique lineups`);

  // MLB stack filter
  if (options.sport === 'mlb') {
    const before = candidatePool.length;
    candidatePool = candidatePool.filter(l => {
      const teams = new Map<string, number>();
      for (const p of l.players) {
        if (!p.positions?.includes('P')) teams.set(p.team, (teams.get(p.team) || 0) + 1);
      }
      let max = 0; for (const c of teams.values()) if (c > max) max = c;
      return max >= 4;
    });
    if (candidatePool.length < before) console.log(`  MLB stack filter: ${before - candidatePool.length} removed`);
  }

  // Count games early (needed for small-slate detection)
  const gameSet = new Set<string>();
  for (const p of pool.players) gameSet.add(p.gameInfo || `${p.team}_game`);
  const numGames = gameSet.size;

  // 2b. Ownership pre-filter for MLB (drop chalkiest 10-20%)
  if (options.sport === 'mlb') {
    const ownValues = candidatePool.map(l => l.ownership || 0).sort((a, b) => a - b);
    const keepFrac = numGames <= 4 ? 0.90 : 0.80;  // relax on small slates
    const ownCeiling = ownValues[Math.max(0, Math.floor(ownValues.length * keepFrac) - 1)] || Infinity;
    const before = candidatePool.length;
    candidatePool = candidatePool.filter(l => (l.ownership || 0) <= ownCeiling);
    console.log(`  MLB ownership filter: dropped ${before - candidatePool.length} chalkiest lineups (ceil=${ownCeiling.toFixed(1)}%), pool=${candidatePool.length}`);
  }

  // 3. Build field (calibrated model or use pool as field)
  let fieldLineups: Lineup[];
  const opponentModelPath = (options as any).opponentModel as string | undefined;
  if (opponentModelPath && fs.existsSync(opponentModelPath)) {
    console.log(`  loading opponent model: ${opponentModelPath}`);
    const model = loadOpponentModel(opponentModelPath);
    fieldLineups = generateCalibratedField(pool.players, config, 8000, model);
    console.log(`  synthetic field: ${fieldLineups.length} lineups`);
  } else {
    fieldLineups = candidatePool;
    console.log(`  field: using candidate pool (no opponent model)`);
  }

  // 4. Precompute worlds

  const selParams: SelectorParams = {
    ...DEFAULT_SELECTOR_PARAMS,
    ...getSportDefaults(options.sport),
    N: options.lineupCount,
    gamma: defaultGamma(config.rosterSize),
    numWorlds: (options as any).worlds ?? 2000,
  };

  console.log(`\n  precomputing worlds (W=${selParams.numWorlds})…`);
  const t0 = Date.now();
  const precomp = precomputeSlate(candidatePool, fieldLineups, pool.players, selParams, options.sport);
  console.log(`  precompute: ${Date.now() - t0}ms (C=${precomp.C} F=${precomp.F})`);

  // 5. λ-sweep selection
  const N = options.lineupCount;
  // Detect small slates and use fewer λ families (less pool fragmentation)
  const isSmallSlate = numGames <= 4;
  const lambdaGrid = isSmallSlate ? [0.3, 0.8, 1.5, 2.5] : [0.3, 0.6, 1.0, 1.5, 2.2, 3.0];
  const frac = isSmallSlate ? [0.20, 0.30, 0.30, 0.20] : [0.10, 0.13, 0.17, 0.20, 0.20, 0.20];
  const entriesPerLambda = frac.map(f => Math.round(f * N));
  // Fix rounding to match N exactly
  const diff = N - entriesPerLambda.reduce((a, b) => a + b, 0);
  entriesPerLambda[entriesPerLambda.length - 1] += diff;

  console.log(`\n  λ-sweep: grid=[${lambdaGrid.join(',')}] entries=[${entriesPerLambda.join(',')}]`);

  const maxOverlap = isSmallSlate
    ? config.rosterSize - 2    // relax: differ by ≥2 on small slates (was ≥3)
    : defaultGamma(config.rosterSize);
  const maxExp = isSmallSlate ? 0.50 : (options.sport === 'mlb' ? 0.30 : 0.40);

  const sweepResult = lambdaSweepSelect(precomp, {
    lambdaGrid,
    entriesPerLambda,
    maxOverlap,
    maxExposure: maxExp,
  });

  console.log(`  λ-sweep: ${sweepResult.selected.length}/${N} entries selected in ${sweepResult.diagnostics.selectionTimeMs}ms`);

  // 6. Evil twin hedging
  console.log(`\n  applying evil twin hedging (fraction=${DEFAULT_EVIL_TWIN_PARAMS.twinFraction})…`);
  const twinResult = applyEvilTwinHedging(
    sweepResult.selected,
    precomp,
    DEFAULT_EVIL_TWIN_PARAMS,
  );

  const finalPortfolio = twinResult.portfolio;

  // 7. Export
  const outPath = options.output;
  exportForDraftKings(finalPortfolio, config, outPath);
  const detailPath = outPath.replace('.csv', '_detailed.csv');
  exportDetailedLineups(finalPortfolio, config, detailPath);

  console.log(`\n================================================================`);
  console.log(`DONE — ${finalPortfolio.length} lineups written to:`);
  console.log(`  • DK upload: ${outPath}`);
  console.log(`  • Detail:    ${detailPath}`);
  console.log(`================================================================`);
}
