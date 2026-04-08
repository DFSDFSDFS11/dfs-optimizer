/**
 * ELITE SWEEP — Parameter sweep for the Algorithm 7 selector.
 *
 * For each slate, precompute exactly ONCE (the expensive step), then run
 * algorithm7Select for every parameter combination in a small grid. Score
 * each (config, slate) pair against actuals. Aggregate top-1% / top-5% /
 * lift-over-random across all slates per config and print the ranked best.
 *
 * Sweepable params (the ones that DON'T affect precompute):
 *   - maxPlayerExposure
 *   - lambdaGrid (preset shapes)
 *   - rewardWeights (top01 emphasis)
 *   - earlyDiversifyBoost
 *   - earlyEntryCount
 *
 * Non-sweepable here (would force re-precompute):
 *   - numWorlds, fieldSampleSize, candidatePoolSize
 *   - rewardThresholds, covTargetPercentile
 *
 * Run on the same data sources as elite-backtest:
 *   • Single slate: --input <projections> --actuals <contest_csv> [--pool-csv]
 *   • Multi slate:  --data <historical_slates_dir>
 */

import * as fs from 'fs';
import * as path from 'path';
import { CLIOptions, ContestConfig, Lineup, Player, PlayerPool } from '../types';
import {
  parseCSVFile,
  buildPlayerPool,
  parseContestActuals,
  ContestEntry,
  ContestActuals,
  loadPoolFromCSV,
} from '../parser';
import { getContestConfig } from '../rules';
import {
  algorithm7Select,
  precomputeSlate,
  recomputePayoutCurve,
  defaultGamma,
  getSportDefaults,
  DEFAULT_SELECTOR_PARAMS,
  SelectorParams,
  SlatePrecomputation,
} from '../selection/algorithm7-selector';

// ============================================================
// CONFIG GRID
// ============================================================

interface SweepConfig {
  id: string;
  maxPlayerExposure: number;
  lambdaGrid: number[];
  rewardWeights: { top01: number; top1: number; top5: number };
  earlyDiversifyBoost: number;
  earlyEntryCount: number;
  marginalRewardMode: 'tiered' | 'log_payout';
  payoutCurveExponent: number;
  payoutCutoffFraction: number;
  simulatorMode: 'rich' | 'minimal';
}

const LAMBDA_SHAPES: Record<string, number[]> = {
  flat:    [0],
  narrow:  [0, 0.05, 0.1, 0.2],
  spec:    [0, 0.1, 0.25, 0.5, 1.0, 2.0],
  high:    [0.25, 0.5, 1.0, 2.0],
};

/**
 * Build the cartesian sweep grid. The grid is FOCUSED — not exhaustive — to
 * test the specific hypotheses we care about right now:
 *   • Does the payout curve shape (exponent, cutoff) matter under log_payout?
 *   • Does the minimal simulator find configs that beat rich on aggregate?
 *   • Is tiered still the best reward mode after retuning?
 *
 * Configs anchor at exp=0.40, narrow λ — the calibrated NBA defaults — and
 * sweep the new dimensions around that center. ~22 configs total.
 */
function buildSweepGrid(): SweepConfig[] {
  const grid: SweepConfig[] = [];

  // Anchor params (held constant)
  const ANCHOR = {
    maxPlayerExposure: 0.40,
    lambdaGrid: LAMBDA_SHAPES.narrow,
    earlyDiversifyBoost: 1.0,
    earlyEntryCount: 0,
  };

  // 1. Tiered baseline under both simulators (the current production configs)
  for (const sim of ['rich', 'minimal'] as const) {
    grid.push({
      id: `tiered_${sim}`,
      ...ANCHOR,
      rewardWeights: { top01: 20, top1: 5, top5: 2 },
      marginalRewardMode: 'tiered',
      payoutCurveExponent: 1.0,
      payoutCutoffFraction: 0.20,
      simulatorMode: sim,
    });
  }

  // 2. log_payout sweep × payout curve params × both simulators
  const exponents = [0.7, 1.0, 1.3, 1.6];
  const cutoffs = [0.10, 0.20, 0.30];
  for (const sim of ['rich', 'minimal'] as const) {
    for (const exponent of exponents) {
      for (const cutoff of cutoffs) {
        grid.push({
          id: `lp_${sim}_α${exponent}_c${cutoff}`,
          ...ANCHOR,
          rewardWeights: { top01: 20, top1: 5, top5: 2 },
          marginalRewardMode: 'log_payout',
          payoutCurveExponent: exponent,
          payoutCutoffFraction: cutoff,
          simulatorMode: sim,
        });
      }
    }
  }

  return grid;
}

// ============================================================
// AGGREGATE TYPES
// ============================================================

interface ConfigAggregate {
  config: SweepConfig;
  slates: number;
  avgTop1: number;
  avgTop5: number;
  avgTop10: number;
  avgActual: number;
  avgLift1: number;
  avgLift5: number;
  perSlateTop1: number[];
  // Distribution stats across slates (computed from perSlateTop1)
  medianTop1: number;
  stdTop1: number;
  minTop1: number;
  maxTop1: number;
}

// ============================================================
// HELPERS — copied / adapted from elite-backtest
// ============================================================

function normalizeName(name: string): string {
  return (name || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildNameToPlayerMap(players: Player[]): Map<string, Player> {
  const m = new Map<string, Player>();
  for (const p of players) m.set(normalizeName(p.name), p);
  return m;
}

function buildIdToPlayerMap(players: Player[]): Map<string, Player> {
  const m = new Map<string, Player>();
  for (const p of players) m.set(p.id, p);
  return m;
}

function entriesToLineups(
  entries: ContestEntry[],
  nameMap: Map<string, Player>,
): {
  lineups: Lineup[];
  entryByHash: Map<string, ContestEntry>;
  actualByHash: Map<string, number>;
} {
  const lineups: Lineup[] = [];
  const entryByHash = new Map<string, ContestEntry>();
  const actualByHash = new Map<string, number>();

  for (const entry of entries) {
    const players: Player[] = [];
    let resolved = true;
    for (const name of entry.playerNames) {
      const player = nameMap.get(normalizeName(name));
      if (!player) { resolved = false; break; }
      players.push(player);
    }
    if (!resolved || players.length === 0) continue;

    const salary = players.reduce((s, p) => s + p.salary, 0);
    const projection = players.reduce((s, p) => s + p.projection, 0);
    const ownership = players.reduce((s, p) => s + (p.ownership || 0), 0) / players.length;
    const hash = players.map(p => p.id).sort().join('|');

    if (!entryByHash.has(hash)) {
      entryByHash.set(hash, entry);
      actualByHash.set(hash, entry.actualPoints);
      lineups.push({ players, salary, projection, ownership, hash, constructionMethod: 'contest-field' });
    } else {
      const existing = entryByHash.get(hash)!;
      if (entry.rank < existing.rank) {
        entryByHash.set(hash, entry);
        actualByHash.set(hash, entry.actualPoints);
      }
    }
  }
  return { lineups, entryByHash, actualByHash };
}

function scoreLineupBySumOfPlayerActuals(lu: Lineup, actuals: ContestActuals): { total: number; missing: number } {
  let total = 0, missing = 0;
  for (const p of lu.players) {
    const found = actuals.playerActualsByName.get(normalizeName(p.name));
    if (found) total += found.fpts;
    else missing++;
  }
  return { total, missing };
}

interface SlateCache {
  date: string;
  config: ContestConfig;
  pool: PlayerPool;
  actuals: ContestActuals;
  candidatePool: Lineup[];
  fieldLineups: Lineup[];
  entryByHash: Map<string, ContestEntry>;
  actualByHash: Map<string, number>;
  /**
   * Cached precomputations indexed by simulator mode. The expensive part is
   * the world simulation, which depends on simulatorMode but NOT on the
   * payout curve / reward mode. So we cache one precomp per (slate, sim) and
   * swap the payout curve in via recomputePayoutCurve when needed.
   */
  precompByMode: Map<'rich' | 'minimal', SlatePrecomputation>;
  sortedDescScores: number[];
  thresholds: { top1: number; top5: number; top10: number };
  randomTop1: number;
  randomTop5: number;
  randomTop10: number;
  randomAvg: number;
  mode: 'contest-field' | 'ss-pool';
}

interface SlateInputs {
  date: string;
  projectionsPath: string;
  actualsPath: string;
  poolCsvPath?: string;
}

function collectSlates(options: CLIOptions): SlateInputs[] {
  if (options.input && options.actualsCsv) {
    const date = (path.basename(options.input).match(/(\d[\d\-_]+)/)?.[1]) || 'single';
    return [{ date, projectionsPath: options.input, actualsPath: options.actualsCsv, poolCsvPath: options.poolCsv }];
  }
  const dir = options.dataDir || './historical_slates';
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir);
  const slates: SlateInputs[] = [];
  const projRe = /^(\d{4}-\d{2}-\d{2})(?:_dk)?_projections\.csv$/;
  for (const f of files) {
    const m = f.match(projRe);
    if (!m) continue;
    const date = m[1];
    const isDk = f.includes('_dk_');
    const actualsName = isDk ? `${date}_dk_actuals.csv` : `${date}_actuals.csv`;
    if (files.includes(actualsName)) {
      slates.push({ date, projectionsPath: path.join(dir, f), actualsPath: path.join(dir, actualsName) });
    }
  }
  return slates.sort((a, b) => a.date.localeCompare(b.date));
}

// ============================================================
// PER-SLATE LOAD + PRECOMPUTE (ONCE)
// ============================================================

async function loadAndPrecompute(
  slate: SlateInputs,
  options: CLIOptions,
  baseParams: SelectorParams,
): Promise<SlateCache | null> {
  const parseResult = parseCSVFile(slate.projectionsPath, options.sport, true);
  const config = getContestConfig(options.site, options.sport, parseResult.detectedContestType);
  const pool = buildPlayerPool(parseResult.players, parseResult.detectedContestType);
  const actuals = parseContestActuals(slate.actualsPath, config);

  const nameMap = buildNameToPlayerMap(pool.players);
  const { lineups: fieldLineups, entryByHash, actualByHash } = entriesToLineups(actuals.entries, nameMap);
  if (fieldLineups.length < 100) return null;

  // Candidate pool: SS pool if --pool-csv given, else the contest field
  let candidatePool: Lineup[];
  let mode: 'contest-field' | 'ss-pool';
  if (slate.poolCsvPath && fs.existsSync(slate.poolCsvPath)) {
    const idMap = buildIdToPlayerMap(pool.players);
    const loaded = loadPoolFromCSV({ filePath: slate.poolCsvPath, config, playerMap: idMap });
    candidatePool = loaded.lineups;
    mode = 'ss-pool';
  } else {
    candidatePool = fieldLineups;
    mode = 'contest-field';
  }

  // Build one precomp per simulator mode (the expensive step). Each precomp
  // includes sortedFieldByWorld so the payout curve can be swapped per config.
  const precompByMode = new Map<'rich' | 'minimal', SlatePrecomputation>();
  for (const sim of ['rich', 'minimal'] as const) {
    const params: SelectorParams = { ...baseParams, simulatorMode: sim };
    precompByMode.set(sim, precomputeSlate(candidatePool, fieldLineups, pool.players, params, options.sport));
  }

  // Pre-compute thresholds + random benchmark ONCE per slate (config-independent)
  const sortedDescScores = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
  const F = sortedDescScores.length;
  const thresholds = {
    top1: sortedDescScores[Math.max(0, Math.floor(F * 0.01) - 1)] || 0,
    top5: sortedDescScores[Math.max(0, Math.floor(F * 0.05) - 1)] || 0,
    top10: sortedDescScores[Math.max(0, Math.floor(F * 0.10) - 1)] || 0,
  };

  const { top1: rTop1, top5: rTop5, top10: rTop10, avg: rAvg } =
    computeRandomBenchmark(candidatePool, mode, entryByHash, actualByHash, actuals, thresholds, options.lineupCount, 50);

  return {
    date: slate.date,
    config,
    pool,
    actuals,
    candidatePool,
    fieldLineups,
    entryByHash,
    actualByHash,
    precompByMode,
    sortedDescScores,
    thresholds,
    randomTop1: rTop1,
    randomTop5: rTop5,
    randomTop10: rTop10,
    randomAvg: rAvg,
    mode,
  };
}

function computeRandomBenchmark(
  candidatePool: Lineup[],
  mode: 'contest-field' | 'ss-pool',
  entryByHash: Map<string, ContestEntry>,
  actualByHash: Map<string, number>,
  actuals: ContestActuals,
  thresholds: { top1: number; top5: number; top10: number },
  N: number,
  samples: number,
): { top1: number; top5: number; top10: number; avg: number } {
  let acc1 = 0, acc5 = 0, acc10 = 0, accAvg = 0;
  const allHashes = candidatePool.map(l => l.hash);
  const byHash = new Map(candidatePool.map(l => [l.hash, l]));
  for (let s = 0; s < samples; s++) {
    let seed = (s * 9181 + 1) >>> 0;
    const out = allHashes.slice();
    const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };
    const k = Math.min(N, out.length);
    for (let i = 0; i < k; i++) {
      const j = i + Math.floor(rng() * (out.length - i));
      const tmp = out[i]; out[i] = out[j]; out[j] = tmp;
    }
    let t1 = 0, t5 = 0, t10 = 0, sum = 0, scored = 0;
    for (let i = 0; i < k; i++) {
      const lu = byHash.get(out[i])!;
      let actual: number;
      if (mode === 'contest-field') {
        const a = actualByHash.get(lu.hash);
        if (a === undefined) continue;
        actual = a;
      } else {
        const r = scoreLineupBySumOfPlayerActuals(lu, actuals);
        if (r.missing > 0) continue;
        actual = r.total;
      }
      scored++;
      sum += actual;
      if (actual >= thresholds.top1) t1++;
      if (actual >= thresholds.top5) t5++;
      if (actual >= thresholds.top10) t10++;
    }
    if (scored > 0) {
      acc1 += t1 / scored;
      acc5 += t5 / scored;
      acc10 += t10 / scored;
      accAvg += sum / scored;
    }
  }
  return { top1: acc1 / samples, top5: acc5 / samples, top10: acc10 / samples, avg: accAvg / samples };
}

// ============================================================
// PER-CONFIG SCORING
// ============================================================

interface ConfigSlateResult {
  top1: number;
  top5: number;
  top10: number;
  avgActual: number;
  selected: number;
}

function evaluateConfigOnSlate(
  cache: SlateCache,
  baseParams: SelectorParams,
  cfg: SweepConfig,
): ConfigSlateResult {
  // Build per-config params (gamma + N from baseParams; sweep dimensions from cfg)
  const params: SelectorParams = {
    ...baseParams,
    maxPlayerExposure: cfg.maxPlayerExposure,
    lambdaGrid: cfg.lambdaGrid,
    rewardWeights: cfg.rewardWeights,
    earlyDiversifyBoost: cfg.earlyDiversifyBoost,
    earlyEntryCount: cfg.earlyEntryCount,
    marginalRewardMode: cfg.marginalRewardMode,
    payoutCurveExponent: cfg.payoutCurveExponent,
    payoutCutoffFraction: cfg.payoutCutoffFraction,
    simulatorMode: cfg.simulatorMode,
  };

  // Pick the cached precomputation for this simulator mode, then swap in the
  // payout curve for this config (cheap — only O(C·W·log F) ops).
  const basePrecomp = cache.precompByMode.get(cfg.simulatorMode)!;
  const precomp = cfg.marginalRewardMode === 'log_payout'
    ? recomputePayoutCurve(basePrecomp, cfg.payoutCurveExponent, cfg.payoutCutoffFraction)
    : basePrecomp;

  const { selected } = algorithm7Select(precomp, params);

  // Score against actuals
  let t1 = 0, t5 = 0, t10 = 0, sum = 0, scored = 0;
  for (const lu of selected) {
    let actual: number;
    if (cache.mode === 'contest-field') {
      const a = cache.actualByHash.get(lu.hash);
      if (a === undefined) continue;
      actual = a;
    } else {
      const r = scoreLineupBySumOfPlayerActuals(lu, cache.actuals);
      if (r.missing > 0) continue;
      actual = r.total;
    }
    scored++;
    sum += actual;
    if (actual >= cache.thresholds.top1) t1++;
    if (actual >= cache.thresholds.top5) t5++;
    if (actual >= cache.thresholds.top10) t10++;
  }

  return {
    top1: scored > 0 ? t1 / scored : 0,
    top5: scored > 0 ? t5 / scored : 0,
    top10: scored > 0 ? t10 / scored : 0,
    avgActual: scored > 0 ? sum / scored : 0,
    selected: scored,
  };
}

// ============================================================
// MAIN
// ============================================================

export async function runEliteSweep(options: CLIOptions): Promise<void> {
  console.log('================================================================');
  console.log('ELITE SWEEP — Algorithm 7 parameter calibration');
  console.log('================================================================');

  const slates = collectSlates(options);
  if (slates.length === 0) {
    console.error('No slates found.');
    process.exit(1);
  }
  console.log(`Slates discovered: ${slates.length}`);

  // Base params (these are NOT swept; they affect precompute)
  const baseParams: SelectorParams = {
    ...DEFAULT_SELECTOR_PARAMS,
    ...getSportDefaults(options.sport),
    N: options.lineupCount,
    gamma: 5,  // placeholder, replaced per slate after we know rosterSize
  };

  // 1. Load + precompute every slate (the expensive step, done once)
  console.log('\n--- Loading + precomputing slates ---');
  const caches: SlateCache[] = [];
  let randomAggT1 = 0, randomAggT5 = 0, randomAggT10 = 0, randomAggAvg = 0;
  for (const s of slates) {
    const t0 = Date.now();
    const cache = await loadAndPrecompute(s, options, baseParams);
    if (!cache) {
      console.warn(`  ${s.date}: skipped (insufficient data)`);
      continue;
    }
    // Replace gamma in baseParams per-slate-roster on the *precomp call only*;
    // each config uses its own gamma derived from rosterSize at evaluation time.
    baseParams.gamma = defaultGamma(cache.config.rosterSize);
    caches.push(cache);
    const t = Date.now() - t0;
    const richP = cache.precompByMode.get('rich')!;
    console.log(`  ${s.date}: pool=${cache.candidatePool.length} field=${richP.F} (${t} ms — both sims)`);
    randomAggT1 += cache.randomTop1;
    randomAggT5 += cache.randomTop5;
    randomAggT10 += cache.randomTop10;
    randomAggAvg += cache.randomAvg;
  }
  if (caches.length === 0) {
    console.error('No usable slates after precompute.');
    process.exit(1);
  }
  randomAggT1 /= caches.length;
  randomAggT5 /= caches.length;
  randomAggT10 /= caches.length;
  randomAggAvg /= caches.length;
  console.log(
    `\nRandom baseline (avg of 50 samples per slate, mean across ${caches.length} slates):  ` +
    `top1=${(randomAggT1 * 100).toFixed(2)}%  top5=${(randomAggT5 * 100).toFixed(2)}%  ` +
    `top10=${(randomAggT10 * 100).toFixed(2)}%  avg=${randomAggAvg.toFixed(1)}`,
  );

  // 2. Sweep the grid
  const grid = buildSweepGrid();
  console.log(`\n--- Sweeping ${grid.length} configurations × ${caches.length} slates ---`);
  const results: ConfigAggregate[] = [];

  for (let gi = 0; gi < grid.length; gi++) {
    const cfg = grid[gi];
    const t0 = Date.now();
    let sumT1 = 0, sumT5 = 0, sumT10 = 0, sumAvg = 0;
    const perSlateTop1: number[] = [];
    for (const cache of caches) {
      // Each slate uses its own gamma derived from rosterSize, layered into the per-config params
      const slateBase: SelectorParams = { ...baseParams, gamma: defaultGamma(cache.config.rosterSize) };
      const r = evaluateConfigOnSlate(cache, slateBase, cfg);
      sumT1 += r.top1;
      sumT5 += r.top5;
      sumT10 += r.top10;
      sumAvg += r.avgActual;
      perSlateTop1.push(r.top1);
    }
    const n = caches.length;
    // Distribution stats across slates
    const sortedTop1 = perSlateTop1.slice().sort((a, b) => a - b);
    const median = sortedTop1.length % 2 === 1
      ? sortedTop1[(sortedTop1.length - 1) >> 1]
      : 0.5 * (sortedTop1[sortedTop1.length / 2 - 1] + sortedTop1[sortedTop1.length / 2]);
    const mean = sumT1 / n;
    let varAcc = 0;
    for (const v of perSlateTop1) varAcc += (v - mean) * (v - mean);
    const std = Math.sqrt(varAcc / Math.max(1, n - 1));
    const minV = sortedTop1[0] ?? 0;
    const maxV = sortedTop1[sortedTop1.length - 1] ?? 0;

    const agg: ConfigAggregate = {
      config: cfg,
      slates: n,
      avgTop1: mean,
      avgTop5: sumT5 / n,
      avgTop10: sumT10 / n,
      avgActual: sumAvg / n,
      avgLift1: randomAggT1 > 0 ? mean / randomAggT1 : 0,
      avgLift5: randomAggT5 > 0 ? (sumT5 / n) / randomAggT5 : 0,
      perSlateTop1,
      medianTop1: median,
      stdTop1: std,
      minTop1: minV,
      maxTop1: maxV,
    };
    results.push(agg);
    const dt = Date.now() - t0;
    console.log(
      `  [${(gi + 1).toString().padStart(2)}/${grid.length}] ${cfg.id.padEnd(36)}  ` +
      `top1=${(agg.avgTop1 * 100).toFixed(2)}%  lift=${agg.avgLift1.toFixed(2)}x  ` +
      `top5=${(agg.avgTop5 * 100).toFixed(2)}%  avg=${agg.avgActual.toFixed(1)}  (${dt} ms)`,
    );
  }

  // 3. Rank and report
  results.sort((a, b) => b.avgLift1 - a.avgLift1);
  console.log('\n================================================================');
  console.log('TOP 10 CONFIGS BY top-1% LIFT (mean across slates)');
  console.log('================================================================');
  console.log(
    `${'rk'.padEnd(3)} ${'config'.padEnd(36)} ${'mean'.padStart(6)} ${'med'.padStart(6)} ` +
    `${'std'.padStart(6)} ${'min'.padStart(6)} ${'max'.padStart(6)} ${'lift'.padStart(6)} ` +
    `${'top5%'.padStart(7)} ${'top10%'.padStart(7)} ${'avgPts'.padStart(8)}`,
  );
  for (let i = 0; i < Math.min(10, results.length); i++) {
    const r = results[i];
    console.log(
      `${(i + 1).toString().padEnd(3)} ${r.config.id.padEnd(36)} ` +
      `${(r.avgTop1 * 100).toFixed(2).padStart(5)}% ` +
      `${(r.medianTop1 * 100).toFixed(2).padStart(5)}% ` +
      `${(r.stdTop1 * 100).toFixed(2).padStart(5)}% ` +
      `${(r.minTop1 * 100).toFixed(2).padStart(5)}% ` +
      `${(r.maxTop1 * 100).toFixed(2).padStart(5)}% ` +
      `${r.avgLift1.toFixed(2).padStart(5)}x ` +
      `${(r.avgTop5 * 100).toFixed(2).padStart(6)}% ` +
      `${(r.avgTop10 * 100).toFixed(2).padStart(6)}% ` +
      `${r.avgActual.toFixed(1).padStart(8)}`,
    );
  }

  // 4. Per-slate top-1% array for the top-3 configs (variance diagnostic)
  console.log('\n--- Per-slate top-1% rates for top-3 configs ---');
  console.log('(0.00 = no top-1% hits on that slate; 1.00 = every selected lineup hit top-1%)');
  for (let i = 0; i < Math.min(3, results.length); i++) {
    const r = results[i];
    const rates = r.perSlateTop1.map(v => (v * 100).toFixed(1).padStart(5)).join(' ');
    console.log(`  #${i + 1} ${r.config.id.padEnd(36)} : [${rates}]`);
  }

  // 5. Highlight the best by EACH metric
  const byTop5 = results.slice().sort((a, b) => b.avgTop5 - a.avgTop5)[0];
  const byTop10 = results.slice().sort((a, b) => b.avgTop10 - a.avgTop10)[0];
  const byAvg = results.slice().sort((a, b) => b.avgActual - a.avgActual)[0];
  console.log('\nBest by top-5%:  ' + byTop5.config.id + `  (top5=${(byTop5.avgTop5 * 100).toFixed(2)}%)`);
  console.log('Best by top-10%: ' + byTop10.config.id + `  (top10=${(byTop10.avgTop10 * 100).toFixed(2)}%)`);
  console.log('Best by avg:     ' + byAvg.config.id + `  (avg=${byAvg.avgActual.toFixed(1)})`);
  console.log('================================================================');
}
