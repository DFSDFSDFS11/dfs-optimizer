/**
 * Mode 2 Backtest: Selector vs Actual Contest Field
 *
 * The cleanest possible test of selection logic. The contest field — every lineup
 * anyone played that day — IS the pool. We pick our 150 lineups using only
 * pre-contest information (projections, ownership, ceiling), then reveal actuals
 * and measure hit rates against the field.
 *
 * Compares against three benchmarks:
 *   1. RANDOM 150 — averaged over many samples; ~1% top-1% expected
 *   2. PRO 150 — picks from a named pro's actual entries (e.g. zroth2, bgreseth)
 *   3. OPTIMAL 150 — top 150 by ACTUAL score (theoretical ceiling, ~100% top-1%)
 *
 * If the selector substantially beats random, the selection logic has signal.
 * If it approaches the optimal ceiling, the selector is near-perfect for this pool shape.
 */

import * as fs from 'fs';
import * as path from 'path';
import { CLIOptions, Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, ContestEntry, ContestActuals } from '../parser';
import { getContestConfig } from '../rules';
import { selectLineupsSimple } from '../selection/simple-selector';

// ============================================================
// TYPES
// ============================================================

export interface BacktestSlate {
  date: string;
  projectionsPath: string;
  actualsPath: string;
}

export interface BacktestResult {
  slate: string;
  contestSize: number;
  poolSize: number;             // Number of unique entries that joined cleanly to projections
  selectedCount: number;

  selector: BenchmarkResult;
  random: BenchmarkResult;      // Averaged over N samples
  optimal: BenchmarkResult;     // Top 150 by actual score
  pros: Array<{ name: string; entries: number } & BenchmarkResult>;
}

export interface BenchmarkResult {
  top1Pct: number;              // 0-1 hit rate
  top5Pct: number;
  top10Pct: number;
  avgActual: number;
  bestActual: number;
  bestRank: number;
}

// ============================================================
// HELPERS
// ============================================================

function normalizeName(name: string): string {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build a (normalized name → Player) lookup from a player pool.
 * This is what we use to join contest entries (which have player names) to projections.
 */
function buildNameToPlayerMap(players: Player[]): Map<string, Player> {
  const map = new Map<string, Player>();
  for (const p of players) {
    map.set(normalizeName(p.name), p);
  }
  return map;
}

/**
 * Convert each contest entry into a Lineup by joining its player names against
 * the projection pool. Drops entries where any player can't be matched.
 */
function entriesToLineups(
  entries: ContestEntry[],
  nameMap: Map<string, Player>,
): { lineups: Lineup[]; entryByHash: Map<string, ContestEntry>; dropped: number } {
  const lineups: Lineup[] = [];
  const seenHashes = new Set<string>();
  const entryByHash = new Map<string, ContestEntry>();
  let dropped = 0;

  for (const entry of entries) {
    const players: Player[] = [];
    let resolved = true;

    for (const name of entry.playerNames) {
      const norm = normalizeName(name);
      const player = nameMap.get(norm);
      if (!player) {
        resolved = false;
        break;
      }
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

    if (!seenHashes.has(hash)) {
      seenHashes.add(hash);
      lineups.push({
        players,
        salary,
        projection,
        ownership,
        hash,
        constructionMethod: 'contest-field',
      });
      // The first entry for a given lineup hash is the canonical one for actuals scoring.
      // (Multiple entries may have the exact same lineup; we keep the best-ranked one.)
      entryByHash.set(hash, entry);
    } else {
      // Keep the best-ranked entry for this lineup so we report its actual finish
      const existing = entryByHash.get(hash)!;
      if (entry.rank < existing.rank) entryByHash.set(hash, entry);
    }
  }

  return { lineups, entryByHash, dropped };
}

/**
 * Compute hit rates for a list of lineup hashes against the actuals.
 */
function scoreSelection(
  selectedHashes: string[],
  entryByHash: Map<string, ContestEntry>,
  thresholds: { top1: number; top5: number; top10: number },
  sortedDescScores: number[],
): BenchmarkResult {
  let top1 = 0;
  let top5 = 0;
  let top10 = 0;
  let sumActual = 0;
  let bestActual = 0;
  let bestRank = sortedDescScores.length;

  for (const hash of selectedHashes) {
    const entry = entryByHash.get(hash);
    if (!entry) continue;
    const actual = entry.actualPoints;
    sumActual += actual;
    if (actual > bestActual) {
      bestActual = actual;
      bestRank = entry.rank;
    }
    if (actual >= thresholds.top1) top1++;
    if (actual >= thresholds.top5) top5++;
    if (actual >= thresholds.top10) top10++;
  }

  const n = selectedHashes.length;
  return {
    top1Pct: n > 0 ? top1 / n : 0,
    top5Pct: n > 0 ? top5 / n : 0,
    top10Pct: n > 0 ? top10 / n : 0,
    avgActual: n > 0 ? sumActual / n : 0,
    bestActual,
    bestRank,
  };
}

function shuffleAndTake<T>(arr: T[], k: number, rng: () => number): T[] {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, k);
}

/** Deterministic LCG so the random benchmark is reproducible across runs. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// ============================================================
// MAIN BACKTEST
// ============================================================

export async function runActualsBacktest(options: CLIOptions): Promise<void> {
  console.log('========================================');
  console.log('MODE 2 BACKTEST: Selector vs Contest Field');
  console.log('========================================');

  const slates = collectSlates(options);
  if (slates.length === 0) {
    console.error('No slates found. Use --input + --actuals for a single slate, or --data <dir> for multi-slate.');
    process.exit(1);
  }

  const allResults: BacktestResult[] = [];

  for (const slate of slates) {
    console.log(`\n----------------------------------------`);
    console.log(`Slate: ${slate.date}`);
    console.log(`  Projections: ${slate.projectionsPath}`);
    console.log(`  Actuals:     ${slate.actualsPath}`);
    console.log(`----------------------------------------`);

    const result = await runOneSlate(slate, options);
    if (result) {
      allResults.push(result);
      printSlateReport(result);
    }
  }

  if (allResults.length > 1) {
    printAggregateReport(allResults);
  }
}

/**
 * Discover slates to backtest. Three modes:
 *  1. --input + --actuals  → single slate
 *  2. --data <dir>          → all slates in the historical_slates directory
 */
function collectSlates(options: CLIOptions): BacktestSlate[] {
  if (options.input && options.actualsCsv) {
    const date = path.basename(options.input).replace(/[^0-9-]/g, '').slice(0, 10) || 'single';
    return [{ date, projectionsPath: options.input, actualsPath: options.actualsCsv }];
  }

  const dir = options.dataDir || './historical_slates';
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir);
  const slates: BacktestSlate[] = [];
  const projRe = /^(\d{4}-\d{2}-\d{2})_projections\.csv$/;
  for (const f of files) {
    const m = f.match(projRe);
    if (!m) continue;
    const date = m[1];
    const actualsName = `${date}_actuals.csv`;
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

async function runOneSlate(
  slate: BacktestSlate,
  options: CLIOptions,
): Promise<BacktestResult | null> {
  // 1. Load projections
  const parseResult = parseCSVFile(slate.projectionsPath, options.sport, true);
  const config = getContestConfig(options.site, options.sport, parseResult.detectedContestType);
  const pool = buildPlayerPool(parseResult.players, parseResult.detectedContestType);

  // 2. Load actuals (entries + per-player FPTS)
  let actuals: ContestActuals;
  try {
    actuals = parseContestActuals(slate.actualsPath, config);
  } catch (err) {
    console.error(`  Failed to parse actuals: ${(err as Error).message}`);
    return null;
  }

  console.log(`  Players in projections: ${pool.players.length}`);
  console.log(`  Contest entries:        ${actuals.entries.length}`);
  console.log(`  Player actuals rows:    ${actuals.playerActualsByName.size}`);

  // 3. Join entries to projections by player name → build a Lineup pool
  const nameMap = buildNameToPlayerMap(pool.players);
  const { lineups: poolLineups, entryByHash, dropped } = entriesToLineups(
    actuals.entries,
    nameMap,
  );
  console.log(`  Joined pool size: ${poolLineups.length} unique lineups (dropped ${dropped} unresolved)`);

  if (poolLineups.length < 100) {
    console.error('  Pool too small after join — projections likely don\'t match actuals slate');
    return null;
  }

  // 4. Compute percentile thresholds from the FULL contest field (not just joined entries)
  const sortedDescScores = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
  const n = sortedDescScores.length;
  const thresholds = {
    top1: sortedDescScores[Math.max(0, Math.floor(n * 0.01) - 1)] || 0,
    top5: sortedDescScores[Math.max(0, Math.floor(n * 0.05) - 1)] || 0,
    top10: sortedDescScores[Math.max(0, Math.floor(n * 0.10) - 1)] || 0,
  };
  console.log(`  Thresholds: top1=${thresholds.top1.toFixed(1)} top5=${thresholds.top5.toFixed(1)} top10=${thresholds.top10.toFixed(1)}`);

  // 5. Count distinct games for the selector
  const gameSet = new Set<string>();
  for (const p of pool.players) gameSet.add(p.gameInfo || `${p.team}_game`);
  const numGames = gameSet.size;

  // 6. Run the selector on the contest field
  const targetCount = options.lineupCount;
  console.log(`  Running selector: target ${targetCount} from pool of ${poolLineups.length}`);

  const selection = selectLineupsSimple({
    lineups: poolLineups,
    targetCount,
    numGames,
    salaryCap: config.salaryCap,
    sport: options.sport,
    players: pool.players,
    contestSize: options.contestSize,
    fieldSamples: options.fieldSamples,
    simMode: options.simMode,
  });

  const selectedHashes = selection.selected.map(l => l.hash);
  console.log(`  Selected ${selectedHashes.length} lineups`);

  // 7. Score selector picks against actuals
  const selectorBench = scoreSelection(selectedHashes, entryByHash, thresholds, sortedDescScores);

  // 8. RANDOM benchmark — average over 50 samples
  const RANDOM_SAMPLES = 50;
  let randSum = {
    top1Pct: 0,
    top5Pct: 0,
    top10Pct: 0,
    avgActual: 0,
    bestActual: 0,
    bestRank: 0,
  };
  const allHashes = poolLineups.map(l => l.hash);
  for (let s = 0; s < RANDOM_SAMPLES; s++) {
    const rng = makeRng(s * 9181 + 1);
    const sampleHashes = shuffleAndTake(allHashes, targetCount, rng);
    const r = scoreSelection(sampleHashes, entryByHash, thresholds, sortedDescScores);
    randSum.top1Pct += r.top1Pct;
    randSum.top5Pct += r.top5Pct;
    randSum.top10Pct += r.top10Pct;
    randSum.avgActual += r.avgActual;
    randSum.bestActual += r.bestActual;
    randSum.bestRank += r.bestRank;
  }
  const randomBench: BenchmarkResult = {
    top1Pct: randSum.top1Pct / RANDOM_SAMPLES,
    top5Pct: randSum.top5Pct / RANDOM_SAMPLES,
    top10Pct: randSum.top10Pct / RANDOM_SAMPLES,
    avgActual: randSum.avgActual / RANDOM_SAMPLES,
    bestActual: randSum.bestActual / RANDOM_SAMPLES,
    bestRank: randSum.bestRank / RANDOM_SAMPLES,
  };

  // 9. OPTIMAL benchmark — top 150 by actual score (using ALL pool entries, not just joined)
  const sortedByActual = [...poolLineups].sort((a, b) => {
    const ea = entryByHash.get(a.hash);
    const eb = entryByHash.get(b.hash);
    return (eb?.actualPoints || 0) - (ea?.actualPoints || 0);
  });
  const optimalHashes = sortedByActual.slice(0, targetCount).map(l => l.hash);
  const optimalBench = scoreSelection(optimalHashes, entryByHash, thresholds, sortedDescScores);

  // 10. PRO benchmarks
  const proResults: Array<{ name: string; entries: number } & BenchmarkResult> = [];
  for (const proName of options.proNames || []) {
    const proEntries = actuals.entries.filter(e =>
      (e.entryName || '').toLowerCase().includes(proName.toLowerCase()),
    );
    if (proEntries.length < 5) continue;
    // For each pro entry, find its hash if it's in our joined pool — otherwise score directly
    let top1 = 0;
    let top5 = 0;
    let top10 = 0;
    let sumA = 0;
    let bestA = 0;
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
    });
  }

  return {
    slate: slate.date,
    contestSize: actuals.entries.length,
    poolSize: poolLineups.length,
    selectedCount: selectedHashes.length,
    selector: selectorBench,
    random: randomBench,
    optimal: optimalBench,
    pros: proResults,
  };
}

// ============================================================
// REPORTING
// ============================================================

function printSlateReport(r: BacktestResult): void {
  const fmt = (b: BenchmarkResult, label: string) => {
    console.log(`  ${label.padEnd(14)} top1=${(b.top1Pct * 100).toFixed(2)}% top5=${(b.top5Pct * 100).toFixed(2)}% top10=${(b.top10Pct * 100).toFixed(2)}% avg=${b.avgActual.toFixed(1)} best=${b.bestActual.toFixed(1)} (rank ${b.bestRank})`);
  };

  console.log(`\n  === Slate ${r.slate} ===`);
  console.log(`  Contest entries: ${r.contestSize.toLocaleString()}, joined pool: ${r.poolSize.toLocaleString()}, selected: ${r.selectedCount}`);
  fmt(r.selector, 'Our selector:');
  fmt(r.random,   'Random avg:');
  fmt(r.optimal,  'Optimal max:');
  for (const pro of r.pros) {
    fmt(pro, `Pro ${pro.name} (${pro.entries}):`);
  }

  // Lift over random — the headline metric
  const lift1 = r.random.top1Pct > 0 ? r.selector.top1Pct / r.random.top1Pct : 0;
  const lift5 = r.random.top5Pct > 0 ? r.selector.top5Pct / r.random.top5Pct : 0;
  const ceil1 = r.optimal.top1Pct > 0 ? r.selector.top1Pct / r.optimal.top1Pct : 0;
  console.log(`  Lift over random: top1 ${lift1.toFixed(2)}x, top5 ${lift5.toFixed(2)}x | reaching ${(ceil1 * 100).toFixed(0)}% of optimal top1`);
}

function printAggregateReport(results: BacktestResult[]): void {
  console.log('\n========================================');
  console.log('AGGREGATE — All Slates');
  console.log('========================================');

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
  console.log(`│      Metric      │ Our Selector │  Random avg  │ Optimal max  │`);
  console.log(`├──────────────────┼──────────────┼──────────────┼──────────────┤`);
  console.log(`│ Top 1% rate      │ ${(sel.top1 * 100).toFixed(2).padStart(11)}% │ ${(rnd.top1 * 100).toFixed(2).padStart(11)}% │ ${(opt.top1 * 100).toFixed(2).padStart(11)}% │`);
  console.log(`│ Top 5% rate      │ ${(sel.top5 * 100).toFixed(2).padStart(11)}% │ ${(rnd.top5 * 100).toFixed(2).padStart(11)}% │ ${(opt.top5 * 100).toFixed(2).padStart(11)}% │`);
  console.log(`│ Top 10% rate     │ ${(sel.top10 * 100).toFixed(2).padStart(11)}% │ ${(rnd.top10 * 100).toFixed(2).padStart(11)}% │ ${(opt.top10 * 100).toFixed(2).padStart(11)}% │`);
  console.log(`│ Avg actual       │ ${sel.avg.toFixed(2).padStart(12)} │ ${rnd.avg.toFixed(2).padStart(12)} │ ${opt.avg.toFixed(2).padStart(12)} │`);
  console.log(`└──────────────────┴──────────────┴──────────────┴──────────────┘`);

  const lift1 = rnd.top1 > 0 ? sel.top1 / rnd.top1 : 0;
  const lift5 = rnd.top5 > 0 ? sel.top5 / rnd.top5 : 0;
  const ceil1 = opt.top1 > 0 ? sel.top1 / opt.top1 : 0;
  console.log(`\nLift over random: top1 ${lift1.toFixed(2)}x, top5 ${lift5.toFixed(2)}x`);
  console.log(`Reaching ${(ceil1 * 100).toFixed(0)}% of theoretical top1 ceiling`);
  console.log('========================================');
}
