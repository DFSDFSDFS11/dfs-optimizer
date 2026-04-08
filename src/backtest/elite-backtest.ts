/**
 * ELITE BACKTEST — Algorithm 7 selector against the actual DK contest field.
 *
 * Two operating modes:
 *   1. CONTEST-FIELD POOL  (default, the "Mode 2" backtest):
 *        Candidate pool = every contest entry joined to projections.
 *        Field for σ_{δ,G}/thresholds = same contest entries.
 *        This is the cleanest possible test of selection signal — the pool
 *        contains every winner and every dud, and the only variable is which
 *        150 we pick using only pre-contest information.
 *
 *   2. SS-POOL POOL  (--pool-csv supplied):
 *        Candidate pool = SaberSim lineup pool joined to projections.
 *        Field for σ_{δ,G}/thresholds = the actual contest entries (so the
 *        crowding penalty still uses real-world ownership).
 *        Selected lineups are scored against actuals by summing per-player
 *        actuals from the contest standings.
 *
 * Output benchmarks per slate:
 *   • Our selector  – the 150 picks from Algorithm 7
 *   • Random        – 150 randomly drawn from the same candidate pool, avg of 50 samples
 *   • Optimal       – 150 best by ACTUAL score in the candidate pool (theoretical ceiling)
 *   • Pros          – every entry posted by each named pro user
 */

import * as fs from 'fs';
import * as path from 'path';
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
  parseContestActuals,
  ContestEntry,
  ContestActuals,
  loadPoolFromCSV,
} from '../parser';
import { getContestConfig } from '../rules';
import {
  algorithm7Select,
  precomputeSlate,
  defaultGamma,
  getSportDefaults,
  DEFAULT_SELECTOR_PARAMS,
  SelectorParams,
  SelectionDiagnostics,
} from '../selection/algorithm7-selector';

// ============================================================
// TYPES
// ============================================================

interface SlateInputs {
  date: string;
  projectionsPath: string;
  actualsPath: string;
  poolCsvPath?: string;       // SS pool (optional — Mode 1)
  contestSize?: number;       // for display only
}

interface BenchmarkResult {
  top1Pct: number;            // 0-1 hit rate
  top5Pct: number;
  top10Pct: number;
  avgActual: number;
  bestActual: number;
  bestRank: number;
  scoredCount: number;
}

interface LambdaHitBucket {
  picks: number;
  t1: number;
  t5: number;
  t10: number;
}

interface SlateResult {
  slate: string;
  contestSize: number;
  candidatePoolSize: number;  // size after projection-join (Mode 2) or SS pool join (Mode 1)
  fieldSampleSize: number;
  selectedCount: number;
  mode: 'contest-field' | 'ss-pool';
  selector: BenchmarkResult;
  random: BenchmarkResult;
  optimal: BenchmarkResult;
  pros: Array<{ name: string; entries: number } & BenchmarkResult>;
  diagnostics: SelectionDiagnostics;
  lambdaHits: Map<number, LambdaHitBucket>;
}

// ============================================================
// HELPERS — name normalization & joins (mirrors actuals-backtest)
// ============================================================

function normalizeName(name: string): string {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildNameToPlayerMap(players: Player[]): Map<string, Player> {
  const map = new Map<string, Player>();
  for (const p of players) map.set(normalizeName(p.name), p);
  return map;
}

function buildIdToPlayerMap(players: Player[]): Map<string, Player> {
  const map = new Map<string, Player>();
  for (const p of players) map.set(p.id, p);
  return map;
}

/**
 * Convert each contest entry into a Lineup by joining its player names against
 * the projection map. Drops entries where any player can't be matched.
 *
 * Returns the joined lineups, a hash → ContestEntry map (best-ranked entry
 * for each unique lineup), and a hash → actualPoints map.
 */
function entriesToLineups(
  entries: ContestEntry[],
  nameMap: Map<string, Player>,
): {
  lineups: Lineup[];
  entryByHash: Map<string, ContestEntry>;
  actualByHash: Map<string, number>;
  dropped: number;
} {
  const lineups: Lineup[] = [];
  const entryByHash = new Map<string, ContestEntry>();
  const actualByHash = new Map<string, number>();
  let dropped = 0;

  for (const entry of entries) {
    const players: Player[] = [];
    let resolved = true;

    for (const name of entry.playerNames) {
      const player = nameMap.get(normalizeName(name));
      if (!player) { resolved = false; break; }
      players.push(player);
    }

    if (!resolved || players.length === 0) {
      dropped++;
      continue;
    }

    const salary = players.reduce((s, p) => s + p.salary, 0);
    const projection = players.reduce((s, p) => s + p.projection, 0);
    const ownership = players.reduce((s, p) => s + (p.ownership || 0), 0) / players.length;
    const hash = players.map(p => p.id).sort().join('|');

    if (!entryByHash.has(hash)) {
      entryByHash.set(hash, entry);
      actualByHash.set(hash, entry.actualPoints);
      lineups.push({
        players,
        salary,
        projection,
        ownership,
        hash,
        constructionMethod: 'contest-field',
      });
    } else {
      // Keep the best-ranked entry as the canonical match for actuals reporting.
      const existing = entryByHash.get(hash)!;
      if (entry.rank < existing.rank) {
        entryByHash.set(hash, entry);
        actualByHash.set(hash, entry.actualPoints);
      }
    }
  }

  return { lineups, entryByHash, actualByHash, dropped };
}

/**
 * Score a lineup against actuals by summing per-player FPTS from the contest
 * standings player table. Used in Mode 1 when the selected lineup may not
 * exist as an entry in the contest.
 */
function scoreLineupBySumOfPlayerActuals(
  lu: Lineup,
  actuals: ContestActuals,
): { total: number; missing: number } {
  let total = 0;
  let missing = 0;
  for (const p of lu.players) {
    const found = actuals.playerActualsByName.get(normalizeName(p.name));
    if (found) total += found.fpts;
    else missing++;
  }
  return { total, missing };
}

// ============================================================
// MAIN ENTRY POINT
// ============================================================

export async function runEliteBacktest(options: CLIOptions): Promise<void> {
  console.log('================================================================');
  console.log('ELITE BACKTEST — Algorithm 7 (Haugh-Singal × Liu et al.)');
  console.log('================================================================');

  const slates = collectSlates(options);
  if (slates.length === 0) {
    console.error('No slates found.');
    console.error('  • Single slate: --input <projections> --actuals <contest_csv> [--pool-csv <ss_pool>]');
    console.error('  • Multi slate:  --data <historical_slates_dir>');
    process.exit(1);
  }

  const allResults: SlateResult[] = [];
  for (const slate of slates) {
    console.log(`\n----------------------------------------------------------------`);
    console.log(`Slate ${slate.date}`);
    console.log(`  projections: ${slate.projectionsPath}`);
    console.log(`  actuals:     ${slate.actualsPath}`);
    if (slate.poolCsvPath) console.log(`  ss-pool:     ${slate.poolCsvPath}`);
    console.log(`----------------------------------------------------------------`);

    try {
      const result = await runOneSlate(slate, options);
      if (result) {
        allResults.push(result);
        printSlateReport(result);
      }
    } catch (err) {
      console.error(`  Error on slate ${slate.date}: ${(err as Error).message}`);
    }
  }

  if (allResults.length > 1) {
    printAggregateReport(allResults);
  }
}

// ============================================================
// SLATE DISCOVERY
// ============================================================

function collectSlates(options: CLIOptions): SlateInputs[] {
  // Single-slate mode: --input + --actuals (and optional --pool-csv)
  if (options.input && options.actualsCsv) {
    const date = (path.basename(options.input).match(/(\d[\d\-_]+)/)?.[1]) || 'single';
    return [{
      date,
      projectionsPath: options.input,
      actualsPath: options.actualsCsv,
      poolCsvPath: options.poolCsv,
    }];
  }

  // Multi-slate mode: scan dataDir for *_projections.csv with matching *_actuals.csv
  const dir = options.dataDir || './historical_slates';
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir);
  const slates: SlateInputs[] = [];

  // Two naming patterns supported:
  //   YYYY-MM-DD_projections.csv  +  YYYY-MM-DD_actuals.csv
  //   YYYY-MM-DD_dk_projections.csv + YYYY-MM-DD_dk_actuals.csv
  const projRe = /^(\d{4}-\d{2}-\d{2})(?:_dk)?_projections\.csv$/;
  for (const f of files) {
    const m = f.match(projRe);
    if (!m) continue;
    const date = m[1];
    const isDk = f.includes('_dk_');
    const actualsName = isDk ? `${date}_dk_actuals.csv` : `${date}_actuals.csv`;
    if (files.includes(actualsName)) {
      slates.push({
        date,
        projectionsPath: path.join(dir, f),
        actualsPath: path.join(dir, actualsName),
      });
    }
  }
  return slates.sort((a, b) => a.date.localeCompare(b.date));
}

// ============================================================
// SINGLE SLATE
// ============================================================

async function runOneSlate(
  slate: SlateInputs,
  options: CLIOptions,
): Promise<SlateResult | null> {
  // 1. Load projections
  const parseResult = parseCSVFile(slate.projectionsPath, options.sport, true);
  const config: ContestConfig = getContestConfig(options.site, options.sport, parseResult.detectedContestType);
  const pool: PlayerPool = buildPlayerPool(parseResult.players, parseResult.detectedContestType);

  // 2. Parse actuals
  const actuals: ContestActuals = parseContestActuals(slate.actualsPath, config);

  console.log(`  players in projections : ${pool.players.length}`);
  console.log(`  contest entries        : ${actuals.entries.length}`);
  console.log(`  player actuals rows    : ${actuals.playerActualsByName.size}`);

  // 3. Build the field (always = contest entries joined to projections)
  const nameMap = buildNameToPlayerMap(pool.players);
  const {
    lineups: fieldLineups,
    entryByHash,
    actualByHash,
    dropped,
  } = entriesToLineups(actuals.entries, nameMap);
  console.log(`  joined contest field   : ${fieldLineups.length} unique lineups (dropped ${dropped} unresolved)`);

  if (fieldLineups.length < 100) {
    console.error('  field too small after join — projections likely don\'t match actuals slate');
    return null;
  }

  // 4. Build the candidate pool
  let candidatePool: Lineup[];
  let mode: 'contest-field' | 'ss-pool';
  if (slate.poolCsvPath && fs.existsSync(slate.poolCsvPath)) {
    // Mode 1: load SS pool (or any pool CSV) and join against player IDs
    const idMap = buildIdToPlayerMap(pool.players);
    const loaded = loadPoolFromCSV({
      filePath: slate.poolCsvPath,
      config,
      playerMap: idMap,
    });
    candidatePool = loaded.lineups;
    mode = 'ss-pool';
    console.log(`  ss-pool candidates     : ${candidatePool.length}`);
  } else {
    candidatePool = fieldLineups;
    mode = 'contest-field';
    console.log(`  candidate pool         : contest field (${candidatePool.length})`);
  }

  if (candidatePool.length < options.lineupCount) {
    console.warn(`  ⚠ candidate pool (${candidatePool.length}) is smaller than target (${options.lineupCount})`);
  }

  // 5. Selector parameters — start from spec defaults, layer sport-specific overrides
  const params: SelectorParams = {
    ...DEFAULT_SELECTOR_PARAMS,
    ...getSportDefaults(options.sport),
    N: options.lineupCount,
    gamma: defaultGamma(config.rosterSize),
  };
  console.log(
    `  selector params        : N=${params.N} γ=${params.gamma} W=${params.numWorlds} ` +
    `λ-grid=[${params.lambdaGrid.join(',')}] earlyBoost=${params.earlyDiversifyBoost}x×${params.earlyEntryCount} ` +
    `maxExp=${(params.maxPlayerExposure * 100).toFixed(0)}% rewardW=[${params.rewardWeights.top01}/${params.rewardWeights.top1}/${params.rewardWeights.top5}]`,
  );

  // 6. Pre-compute (worlds, threshold vector, σ_{δ,G})
  const t0 = Date.now();
  const precomp = precomputeSlate(candidatePool, fieldLineups, pool.players, params, options.sport);
  const tPrecomp = Date.now() - t0;
  console.log(`  precompute             : ${tPrecomp} ms (W=${precomp.W} P=${precomp.P} C=${precomp.C} F=${precomp.F})`);

  // 7. Select 150 lineups
  const t1 = Date.now();
  const { selected, diagnostics } = algorithm7Select(precomp, params);
  const tSelect = Date.now() - t1;
  console.log(`  algorithm 7 select     : ${tSelect} ms → ${selected.length} lineups`);

  // 8. Score selected against actuals
  const sortedDescScores = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
  const F = sortedDescScores.length;
  const thresholds = {
    top1: sortedDescScores[Math.max(0, Math.floor(F * 0.01) - 1)] || 0,
    top5: sortedDescScores[Math.max(0, Math.floor(F * 0.05) - 1)] || 0,
    top10: sortedDescScores[Math.max(0, Math.floor(F * 0.10) - 1)] || 0,
  };

  const selectorBench = scoreLineupsAgainstActuals(
    selected, mode, entryByHash, actualByHash, actuals, thresholds, sortedDescScores,
  );

  // 8b. λ-bucketed top-1% / top-5% hit attribution
  // For each pick, look up its actual points and bucket the hit by which λ
  // value was used to pick it. This tells us whether λ=0 (projection-only)
  // is doing the work or whether the variance-seeking λ>0 picks are paying off.
  const lambdaHits: Map<number, { picks: number; t1: number; t5: number; t10: number }> = new Map();
  for (let i = 0; i < selected.length; i++) {
    const lu = selected[i];
    const lam = diagnostics.pickedLambdas[i] ?? -1;
    const bucket = lambdaHits.get(lam) ?? { picks: 0, t1: 0, t5: 0, t10: 0 };
    bucket.picks++;
    let actual: number | undefined;
    if (mode === 'contest-field') {
      actual = actualByHash.get(lu.hash);
    } else {
      const r = scoreLineupBySumOfPlayerActuals(lu, actuals);
      if (r.missing === 0) actual = r.total;
    }
    if (actual !== undefined) {
      if (actual >= thresholds.top1) bucket.t1++;
      if (actual >= thresholds.top5) bucket.t5++;
      if (actual >= thresholds.top10) bucket.t10++;
    }
    lambdaHits.set(lam, bucket);
  }

  // 9. Random benchmark — average of 50 samples drawn from the candidate pool
  const RANDOM_SAMPLES = 50;
  const randSum = newEmptyBench();
  const allHashes = candidatePool.map(l => l.hash);
  const allLineupsByHash = new Map(candidatePool.map(l => [l.hash, l]));
  for (let s = 0; s < RANDOM_SAMPLES; s++) {
    const sampleLineups = shuffleAndTakeHashes(allHashes, options.lineupCount, s * 9181 + 1)
      .map(h => allLineupsByHash.get(h)!).filter(Boolean);
    const r = scoreLineupsAgainstActuals(
      sampleLineups, mode, entryByHash, actualByHash, actuals, thresholds, sortedDescScores,
    );
    randSum.top1Pct += r.top1Pct;
    randSum.top5Pct += r.top5Pct;
    randSum.top10Pct += r.top10Pct;
    randSum.avgActual += r.avgActual;
    randSum.bestActual += r.bestActual;
    randSum.bestRank += r.bestRank;
    randSum.scoredCount += r.scoredCount;
  }
  const randomBench: BenchmarkResult = {
    top1Pct: randSum.top1Pct / RANDOM_SAMPLES,
    top5Pct: randSum.top5Pct / RANDOM_SAMPLES,
    top10Pct: randSum.top10Pct / RANDOM_SAMPLES,
    avgActual: randSum.avgActual / RANDOM_SAMPLES,
    bestActual: randSum.bestActual / RANDOM_SAMPLES,
    bestRank: randSum.bestRank / RANDOM_SAMPLES,
    scoredCount: Math.round(randSum.scoredCount / RANDOM_SAMPLES),
  };

  // 10. Optimal benchmark — top 150 of the candidate pool by ACTUAL score
  const candidateActuals: Array<{ lu: Lineup; actual: number }> = candidatePool.map(lu => {
    let actual: number;
    if (mode === 'contest-field') {
      actual = actualByHash.get(lu.hash) ?? -Infinity;
    } else {
      actual = scoreLineupBySumOfPlayerActuals(lu, actuals).total;
    }
    return { lu, actual };
  });
  candidateActuals.sort((a, b) => b.actual - a.actual);
  const optimalLineups = candidateActuals.slice(0, options.lineupCount).map(x => x.lu);
  const optimalBench = scoreLineupsAgainstActuals(
    optimalLineups, mode, entryByHash, actualByHash, actuals, thresholds, sortedDescScores,
  );

  // 11. Pro benchmarks (computed against ALL pro entries directly from the actuals)
  const proResults: Array<{ name: string; entries: number } & BenchmarkResult> = [];
  for (const proName of options.proNames || []) {
    const proEntries = actuals.entries.filter(e =>
      (e.entryName || '').toLowerCase().includes(proName.toLowerCase()),
    );
    if (proEntries.length < 5) continue;
    let top1 = 0, top5 = 0, top10 = 0, sumA = 0, bestA = 0;
    let bestR = sortedDescScores.length;
    for (const pe of proEntries) {
      const a = pe.actualPoints;
      sumA += a;
      if (a > bestA) { bestA = a; bestR = pe.rank; }
      if (a >= thresholds.top1) top1++;
      if (a >= thresholds.top5) top5++;
      if (a >= thresholds.top10) top10++;
    }
    proResults.push({
      name: proName,
      entries: proEntries.length,
      top1Pct: top1 / proEntries.length,
      top5Pct: top5 / proEntries.length,
      top10Pct: top10 / proEntries.length,
      avgActual: sumA / proEntries.length,
      bestActual: bestA,
      bestRank: bestR,
      scoredCount: proEntries.length,
    });
  }

  return {
    slate: slate.date,
    contestSize: actuals.entries.length,
    candidatePoolSize: candidatePool.length,
    fieldSampleSize: precomp.F,
    selectedCount: selected.length,
    mode,
    selector: selectorBench,
    random: randomBench,
    optimal: optimalBench,
    pros: proResults,
    diagnostics,
    lambdaHits,
  };
}

// ============================================================
// SCORING AGAINST ACTUALS
// ============================================================

function scoreLineupsAgainstActuals(
  lineups: Lineup[],
  mode: 'contest-field' | 'ss-pool',
  entryByHash: Map<string, ContestEntry>,
  actualByHash: Map<string, number>,
  actuals: ContestActuals,
  thresholds: { top1: number; top5: number; top10: number },
  sortedDescScores: number[],
): BenchmarkResult {
  let top1 = 0, top5 = 0, top10 = 0;
  let sumActual = 0;
  let bestActual = -Infinity;
  let bestRank = sortedDescScores.length;
  let scored = 0;

  for (const lu of lineups) {
    let actual: number;
    let rank: number;

    if (mode === 'contest-field') {
      const a = actualByHash.get(lu.hash);
      if (a === undefined) continue;
      actual = a;
      const e = entryByHash.get(lu.hash);
      rank = e?.rank ?? findRankForScore(actual, sortedDescScores);
    } else {
      // ss-pool: lineup may not exist in the contest — sum per-player FPTS
      const { total, missing } = scoreLineupBySumOfPlayerActuals(lu, actuals);
      if (missing > 0) continue;
      actual = total;
      rank = findRankForScore(actual, sortedDescScores);
    }

    scored++;
    sumActual += actual;
    if (actual > bestActual) { bestActual = actual; bestRank = rank; }
    if (actual >= thresholds.top1) top1++;
    if (actual >= thresholds.top5) top5++;
    if (actual >= thresholds.top10) top10++;
  }

  return {
    top1Pct: scored > 0 ? top1 / scored : 0,
    top5Pct: scored > 0 ? top5 / scored : 0,
    top10Pct: scored > 0 ? top10 / scored : 0,
    avgActual: scored > 0 ? sumActual / scored : 0,
    bestActual: bestActual === -Infinity ? 0 : bestActual,
    bestRank,
    scoredCount: scored,
  };
}

function findRankForScore(score: number, sortedDesc: number[]): number {
  // Binary search for the first index where sortedDesc[i] < score
  let lo = 0, hi = sortedDesc.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedDesc[mid] >= score) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(1, lo);
}

function shuffleAndTakeHashes(arr: string[], k: number, seed: number): string[] {
  const out = arr.slice();
  let s = (seed >>> 0) || 1;
  const rng = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  const n = Math.min(k, out.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng() * (out.length - i));
    const tmp = out[i]; out[i] = out[j]; out[j] = tmp;
  }
  return out.slice(0, n);
}

function newEmptyBench(): BenchmarkResult {
  return {
    top1Pct: 0,
    top5Pct: 0,
    top10Pct: 0,
    avgActual: 0,
    bestActual: 0,
    bestRank: 0,
    scoredCount: 0,
  };
}

// ============================================================
// REPORTING
// ============================================================

function printSlateReport(r: SlateResult): void {
  const fmt = (b: BenchmarkResult, label: string) => {
    console.log(
      `  ${label.padEnd(18)} ` +
      `top1=${(b.top1Pct * 100).toFixed(2).padStart(5)}%  ` +
      `top5=${(b.top5Pct * 100).toFixed(2).padStart(5)}%  ` +
      `top10=${(b.top10Pct * 100).toFixed(2).padStart(5)}%  ` +
      `avg=${b.avgActual.toFixed(1).padStart(6)}  ` +
      `best=${b.bestActual.toFixed(1).padStart(6)} (rank ${b.bestRank})`,
    );
  };

  console.log(`\n=== Slate ${r.slate} (${r.mode} mode) ===`);
  console.log(
    `Contest entries: ${r.contestSize.toLocaleString()}  ` +
    `pool: ${r.candidatePoolSize.toLocaleString()}  ` +
    `field-sample: ${r.fieldSampleSize.toLocaleString()}  ` +
    `selected: ${r.selectedCount}`,
  );
  fmt(r.selector, 'Algorithm 7:');
  fmt(r.random, 'Random (avg 50):');
  fmt(r.optimal, 'Optimal (ceiling):');
  for (const pro of r.pros) {
    fmt(pro, `Pro ${pro.name} (${pro.entries}):`);
  }

  // Lift
  const lift1 = r.random.top1Pct > 0 ? r.selector.top1Pct / r.random.top1Pct : 0;
  const lift5 = r.random.top5Pct > 0 ? r.selector.top5Pct / r.random.top5Pct : 0;
  const ceil1 = r.optimal.top1Pct > 0 ? r.selector.top1Pct / r.optimal.top1Pct : 0;
  console.log(
    `Lift over random: top1 ${lift1.toFixed(2)}x  top5 ${lift5.toFixed(2)}x  | reaching ${(ceil1 * 100).toFixed(0)}% of optimal top1`,
  );

  // Diagnostics
  const d = r.diagnostics;
  console.log(
    `Diagnostics: ` +
    `proj=${d.avgSelectedProjection.toFixed(1)} (pool ${d.avgPoolProjection.toFixed(1)})  ` +
    `divScore=${d.portfolioDiversityScore.toFixed(1)}  ` +
    `maxExp=${(d.maxPlayerExposure * 100).toFixed(1)}%  ` +
    `γ-relax=${d.gammaRelaxations}  ` +
    `exp-relax=${d.exposureRelaxations}  ` +
    `λScale=${d.lambdaScale.toFixed(2)}  ` +
    `heldOut=${d.fieldHeldOut ? 'yes' : 'no'}`,
  );
  const lambdaStr = Array.from(d.lambdaUsage.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([l, n]) => `λ${l}:${n}`)
    .join(' ');
  console.log(`λ usage: ${lambdaStr}`);

  // Hit attribution by λ — answers "are the variance picks (λ>0) actually
  // contributing to top-1% / top-5% rates, or is it all coming from λ=0?"
  const sortedHits = Array.from(r.lambdaHits.entries()).sort((a, b) => a[0] - b[0]);
  if (sortedHits.length > 0) {
    const parts = sortedHits.map(([lam, b]) => {
      const t1Pct = b.picks > 0 ? (b.t1 / b.picks * 100).toFixed(1) : '0.0';
      return `λ${lam}: ${b.t1}/${b.picks} top1 (${t1Pct}%)`;
    });
    console.log(`Hit attribution: ${parts.join(' | ')}`);
  }
}

function printAggregateReport(results: SlateResult[]): void {
  console.log('\n================================================================');
  console.log('AGGREGATE — All Slates');
  console.log('================================================================');

  const agg = (key: 'selector' | 'random' | 'optimal') => {
    const sum = { top1: 0, top5: 0, top10: 0, avg: 0, count: 0 };
    for (const r of results) {
      sum.top1 += r[key].top1Pct;
      sum.top5 += r[key].top5Pct;
      sum.top10 += r[key].top10Pct;
      sum.avg += r[key].avgActual;
      sum.count++;
    }
    return {
      top1: sum.top1 / sum.count,
      top5: sum.top5 / sum.count,
      top10: sum.top10 / sum.count,
      avg: sum.avg / sum.count,
    };
  };

  const sel = agg('selector');
  const rnd = agg('random');
  const opt = agg('optimal');

  console.log(`\nSlates: ${results.length}`);
  console.log(`\n┌──────────────────┬──────────────┬──────────────┬──────────────┐`);
  console.log(`│      Metric      │ Algorithm 7  │  Random avg  │ Optimal max  │`);
  console.log(`├──────────────────┼──────────────┼──────────────┼──────────────┤`);
  console.log(`│ Top  1% rate     │ ${(sel.top1 * 100).toFixed(2).padStart(11)}% │ ${(rnd.top1 * 100).toFixed(2).padStart(11)}% │ ${(opt.top1 * 100).toFixed(2).padStart(11)}% │`);
  console.log(`│ Top  5% rate     │ ${(sel.top5 * 100).toFixed(2).padStart(11)}% │ ${(rnd.top5 * 100).toFixed(2).padStart(11)}% │ ${(opt.top5 * 100).toFixed(2).padStart(11)}% │`);
  console.log(`│ Top 10% rate     │ ${(sel.top10 * 100).toFixed(2).padStart(11)}% │ ${(rnd.top10 * 100).toFixed(2).padStart(11)}% │ ${(opt.top10 * 100).toFixed(2).padStart(11)}% │`);
  console.log(`│ Avg actual       │ ${sel.avg.toFixed(2).padStart(12)} │ ${rnd.avg.toFixed(2).padStart(12)} │ ${opt.avg.toFixed(2).padStart(12)} │`);
  console.log(`└──────────────────┴──────────────┴──────────────┴──────────────┘`);

  const lift1 = rnd.top1 > 0 ? sel.top1 / rnd.top1 : 0;
  const lift5 = rnd.top5 > 0 ? sel.top5 / rnd.top5 : 0;
  const ceil1 = opt.top1 > 0 ? sel.top1 / opt.top1 : 0;
  console.log(`\nLift over random: top1 ${lift1.toFixed(2)}x  top5 ${lift5.toFixed(2)}x`);
  console.log(`Reaching ${(ceil1 * 100).toFixed(0)}% of theoretical top1 ceiling`);
  console.log('================================================================');
}
