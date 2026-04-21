/**
 * ELITE LIVE — Game-day Algorithm 7 selection from SaberSim pool(s).
 *
 * Live mode (no actuals): given a SaberSim player projections CSV and one or
 * more SaberSim lineup pool CSVs, run the calibrated Algorithm 7 selector and
 * write the chosen N lineups in DraftKings bulk-upload format.
 *
 * Multiple --pool-csv inputs are merged and deduped by hash before selection,
 * so you can stitch together two 10K SS exports into a 20K candidate pool.
 *
 * The σ_{δ,G} threshold computation uses the SS pool itself as the field
 * (since the actual contest field isn't known pre-lock). The sport defaults
 * from getSportDefaults() drive λ-grid, exposure cap, etc.
 */

import * as fs from 'fs';
import {
  CLIOptions,
  ContestConfig,
  Lineup,
  Player,
  PlayerPool,
} from '../types';
import {
  parseCSVFile,
  buildPlayerPool,
  loadPoolFromCSV,
} from '../parser';
import { getContestConfig } from '../rules';
import { exportForDraftKings, exportDetailedLineups } from '../scoring';
import {
  algorithm7Select,
  precomputeSlate,
  defaultGamma,
  getSportDefaults,
  DEFAULT_SELECTOR_PARAMS,
  SelectorParams,
} from '../selection/algorithm7-selector';
import {
  hedgingSelect,
  buildHedgingParams,
} from '../selection/hedging-selector';
import {
  emaxSelect,
  buildEmaxParams,
} from '../selection/emax-selector';
import {
  v24Select,
  buildV24Params,
} from '../selection/v24-selector';
import { augmentPool } from '../optimizer/pool-augmentation';

// ============================================================
// MAIN
// ============================================================

export async function runEliteLive(options: CLIOptions): Promise<void> {
  console.log('================================================================');
  console.log('ELITE LIVE — Algorithm 7 selection (game-day)');
  console.log('================================================================');

  if (!options.input) {
    console.error('Error: --input <projections-csv> is required for live mode');
    process.exit(1);
  }
  if (!options.poolCsv) {
    console.error('Error: --pool-csv <ss-pool-csv> is required for live mode');
    console.error('       Multiple pools can be passed comma-separated, e.g.');
    console.error('       --pool-csv "C:/path/sspool1.csv,C:/path/sspool2.csv"');
    process.exit(1);
  }

  // 1. Load projections
  console.log(`\nLoading projections: ${options.input}`);
  const parseResult = parseCSVFile(options.input, options.sport, true);
  const config: ContestConfig = getContestConfig(options.site, options.sport, parseResult.detectedContestType);
  const pool: PlayerPool = buildPlayerPool(parseResult.players, parseResult.detectedContestType);
  console.log(`  players parsed: ${pool.players.length}`);

  // 2. Load and merge SS pool CSVs (comma-separated paths)
  const poolPaths = options.poolCsv.split(',').map(p => p.trim()).filter(p => p.length > 0);
  console.log(`\nLoading ${poolPaths.length} SS pool file(s)…`);

  const idMap = new Map<string, Player>();
  for (const p of pool.players) idMap.set(p.id, p);

  const mergedByHash = new Map<string, Lineup>();
  let totalLoaded = 0;
  for (const ppath of poolPaths) {
    if (!fs.existsSync(ppath)) {
      console.error(`  ✗ pool file not found: ${ppath}`);
      process.exit(1);
    }
    const loaded = loadPoolFromCSV({
      filePath: ppath,
      config,
      playerMap: idMap,
    });
    totalLoaded += loaded.lineups.length;
    for (const lu of loaded.lineups) {
      if (!mergedByHash.has(lu.hash)) mergedByHash.set(lu.hash, lu);
    }
  }
  let candidatePool = Array.from(mergedByHash.values());
  console.log(
    `  merged candidate pool: ${candidatePool.length} unique lineups ` +
    `(from ${totalLoaded} loaded across ${poolPaths.length} file(s))`,
  );

  if (candidatePool.length < options.lineupCount) {
    console.warn(
      `  ⚠ candidate pool (${candidatePool.length}) is smaller than target (${options.lineupCount}). ` +
      `Selector will fill what it can.`,
    );
  }

  // 2b. Pool augmentation (if --augment-pool)
  if (options.augmentPool) {
    const augResult = augmentPool(candidatePool, pool.players, config, options.sport);
    candidatePool = augResult.augmented;
  }

  // 3. Build selector params (sport-aware defaults)
  const params: SelectorParams = {
    ...DEFAULT_SELECTOR_PARAMS,
    ...getSportDefaults(options.sport),
    N: options.lineupCount,
    gamma: defaultGamma(config.rosterSize),
    // Allow the candidate pool size to grow if the merged pool is large
    candidatePoolSize: Math.max(DEFAULT_SELECTOR_PARAMS.candidatePoolSize, candidatePool.length),
  };
  console.log(
    `\nselector params: N=${params.N} γ=${params.gamma} W=${params.numWorlds} ` +
    `λ-grid=[${params.lambdaGrid.join(',')}] maxExp=${(params.maxPlayerExposure * 100).toFixed(0)}% ` +
    `rewardW=[${params.rewardWeights.top01}/${params.rewardWeights.top1}/${params.rewardWeights.top5}]  ` +
    `earlyBoost=${params.earlyDiversifyBoost}x×${params.earlyEntryCount}`,
  );

  // 4. Precompute. In live mode the field for σ_{δ,G} = the SS pool itself.
  // The held-out filtering inside precomputeSlate will fall through to using
  // the full pool when the held-out set is too small (which is OK for live).
  console.log('\nPrecomputing worlds + thresholds + σ_{δ,G}…');
  const t0 = Date.now();
  const precomp = precomputeSlate(candidatePool, candidatePool, pool.players, params, options.sport);
  console.log(
    `  precompute: ${Date.now() - t0} ms ` +
    `(W=${precomp.W} P=${precomp.P} C=${precomp.C} F=${precomp.F}  λScale=${precomp.lambdaScale.toFixed(2)})`,
  );

  // 5. Select — branch on --selector
  const mode = options.selectorMode ?? 'algorithm7';
  const t1 = Date.now();
  let selected: Lineup[];
  if (mode === 'v24') {
    const v24Params = buildV24Params(options.sport, {
      ...(options.projectionFloor !== undefined ? { projectionFloor: 1 - options.projectionFloor } : {}),
      ...(options.hedgeMaxExposure !== undefined ? { maxExposure: options.hedgeMaxExposure } : {}),
      ...(options.rhoMax !== undefined ? { rhoTarget: options.rhoMax } : {}),
    }, options.contest);
    console.log(
      `\nv24 params: ρ_target=${v24Params.rhoTarget} varFloor=top${(v24Params.varianceTopFraction * 100).toFixed(0)}% ` +
      `projFloor=top${(v24Params.projectionFloor * 100).toFixed(0)}% maxExp=${(v24Params.maxExposure * 100).toFixed(0)}%`,
    );
    console.log('\nRunning V24 selection (Hunter U²ₗ)…');
    const r = v24Select(precomp, params, v24Params);
    selected = r.selected;
    const d = r.diagnostics;
    console.log(`  select: ${Date.now() - t1} ms → ${selected.length} lineups`);
    console.log(
      `\nDiagnostics: proj=${d.avgSelectedProjection.toFixed(1)} (pool ${d.avgPoolProjection.toFixed(1)})  ` +
      `maxExp=${(d.maxPlayerExposure * 100).toFixed(1)}%  ` +
      `δ_max=${d.deltaMax.toFixed(1)}  δ-relax=${d.deltaMaxRelaxations}  pool=${d.poolAfterFilters}`,
    );
    console.log(
      `Correlation: avg=${d.avgPairwiseCorrelation.toFixed(3)}  ` +
      `histo[<−.5,−.5..0,0..5,>.5]=[${d.correlationHistogram.join(',')}]`,
    );
    const covStr = d.coverageByTier
      .map(c => `top${(c.percentile * 100).toFixed(1)}%=${(c.rate * 100).toFixed(1)}%`)
      .join('  ');
    console.log(`World coverage: ${covStr}`);
  } else if (mode === 'emax') {
    const overrides: Partial<{ topFraction: number; maxExposure: number }> = {};
    if (options.projectionFloor !== undefined) overrides.topFraction = 1 - options.projectionFloor;
    if (options.hedgeMaxExposure !== undefined) overrides.maxExposure = options.hedgeMaxExposure;
    const emaxParams = buildEmaxParams(options.sport, overrides);
    console.log(
      `\nemax params: topFraction=${(emaxParams.topFraction * 100).toFixed(0)}% ` +
      `maxExp=${(emaxParams.maxExposure * 100).toFixed(0)}%`,
    );
    console.log('\nRunning E[max] greedy selection (Liu Eq. 9)…');
    const r = emaxSelect(precomp, params, emaxParams);
    selected = r.selected;
    const d = r.diagnostics;
    console.log(`  select: ${Date.now() - t1} ms → ${selected.length} lineups`);
    console.log(
      `\nDiagnostics: proj=${d.avgSelectedProjection.toFixed(1)} (pool ${d.avgPoolProjection.toFixed(1)})  ` +
      `E[max]=${d.expectedMax.toFixed(2)}  ` +
      `firstGain=${d.firstPickGain.toFixed(3)}  lastGain=${d.lastPickGain.toFixed(4)}  ` +
      `maxExp=${(d.maxPlayerExposure * 100).toFixed(1)}%  ` +
      `pool=${d.poolAfterProjectionFloor}`,
    );
    console.log(
      `Correlation: avg=${d.avgPairwiseCorrelation.toFixed(3)}  ` +
      `histo[<−.5,−.5..0,0..5,>.5]=[${d.correlationHistogram.join(',')}]`,
    );
    const covStr = d.coverageByTier
      .map(c => `top${(c.percentile * 100).toFixed(1)}%=${(c.rate * 100).toFixed(1)}%`)
      .join('  ');
    console.log(`World coverage: ${covStr}`);
  } else if (mode === 'hedging') {
    const hedgingParams = buildHedgingParams(options.sport, {
      ...(options.rhoMax !== undefined ? { rhoMax: options.rhoMax } : {}),
      ...(options.alpha !== undefined ? { alpha: options.alpha } : {}),
      ...(options.projectionFloor !== undefined ? { projectionFloor: options.projectionFloor } : {}),
      ...(options.hedgeMaxExposure !== undefined ? { maxExposure: options.hedgeMaxExposure } : {}),
    });
    console.log(
      `\nhedging params: ρ_max=${hedgingParams.rhoMax} α=${hedgingParams.alpha} ` +
      `projFloor=top ${((1 - hedgingParams.projectionFloor) * 100).toFixed(0)}% ` +
      `maxExp=${(hedgingParams.maxExposure * 100).toFixed(0)}%`,
    );
    console.log('\nRunning hedging selection (Liu et al. Theorem 4)…');
    const r = hedgingSelect(precomp, params, hedgingParams);
    selected = r.selected;
    const d = r.diagnostics;
    console.log(`  select: ${Date.now() - t1} ms → ${selected.length} lineups`);
    console.log(
      `\nDiagnostics: ` +
      `proj=${d.avgSelectedProjection.toFixed(1)} (pool ${d.avgPoolProjection.toFixed(1)})  ` +
      `divScore=${d.portfolioDiversityScore.toFixed(1)}  ` +
      `maxExp=${(d.maxPlayerExposure * 100).toFixed(1)}%  ` +
      `ρ-relax=${d.rhoRelaxations}  ρ_max=${d.rhoMaxFinal.toFixed(2)}  ` +
      `selectMs=${d.selectionTimeMs}`,
    );
    console.log(
      `Correlation: avg=${d.avgPairwiseCorrelation.toFixed(3)}  ` +
      `min=${d.minPairwiseCorrelation.toFixed(3)}  max=${d.maxPairwiseCorrelation.toFixed(3)}  ` +
      `histo[<−.5,−.5..0,0..5,>.5]=[${d.correlationHistogram.join(',')}]`,
    );
    const covStr = d.coverageByTier
      .map(c => `top${(c.percentile * 100).toFixed(1)}%=${(c.rate * 100).toFixed(1)}%`)
      .join('  ');
    console.log(`World coverage: ${covStr}`);
  } else {
    console.log('\nRunning Algorithm 7 selection…');
    const r = algorithm7Select(precomp, params);
    selected = r.selected;
    const diagnostics = r.diagnostics;
    console.log(`  select: ${Date.now() - t1} ms → ${selected.length} lineups`);
    console.log(
      `\nDiagnostics: ` +
      `proj=${diagnostics.avgSelectedProjection.toFixed(1)} (pool ${diagnostics.avgPoolProjection.toFixed(1)})  ` +
      `divScore=${diagnostics.portfolioDiversityScore.toFixed(1)}  ` +
      `maxExp=${(diagnostics.maxPlayerExposure * 100).toFixed(1)}%  ` +
      `γ-relax=${diagnostics.gammaRelaxations}  ` +
      `exp-relax=${diagnostics.exposureRelaxations}`,
    );
    const lambdaStr = Array.from(diagnostics.lambdaUsage.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([l, n]) => `λ${l}:${n}`)
      .join(' ');
    console.log(`λ usage: ${lambdaStr}`);
  }

  // 7. Export — DK upload format + (optional) detailed sidecar
  const dkPath = options.output;
  exportForDraftKings(selected, config, dkPath);

  // Detailed sidecar with player names + projections for review
  const detailedPath = dkPath.replace(/\.csv$/i, '_detailed.csv');
  if (detailedPath !== dkPath) {
    exportDetailedLineups(selected, config, detailedPath);
  }

  console.log('\n================================================================');
  console.log(`DONE — ${selected.length} lineups written to:`);
  console.log(`  • DK upload: ${dkPath}`);
  console.log(`  • Detail:    ${detailedPath}`);
  console.log('================================================================');
}
