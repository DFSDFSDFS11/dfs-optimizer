/**
 * Parameter Sweep Harness for the Actuals Backtest
 *
 * Iterates over a grid of selector parameters, runs Mode 2 backtest across all
 * available historical slates for each combination, and reports the best params
 * by aggregate top-1% hit rate.
 *
 * The grid is defined inline below — edit it to focus on whichever axes you're
 * actively tuning. Greedy axis sweeps (lock best, sweep next) are far more
 * efficient than the full Cartesian product, so the default grid is intentionally
 * small (~24 configs × N slates).
 */

import * as fs from 'fs';
import * as path from 'path';
import { CLIOptions, Lineup, Player, SimMode } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, ContestEntry } from '../parser';
import { getContestConfig } from '../rules';
import { selectLineupsSimple } from '../selection/simple-selector';

interface SweepConfig {
  label: string;
  simMode: SimMode;
  simBlendWeight: number;
  crowdingAlphaMult: number;
}

interface SlateData {
  date: string;
  pool: Lineup[];
  players: Player[];
  numGames: number;
  salaryCap: number;
  thresholds: { top1: number; top5: number; top10: number };
  entryByHash: Map<string, ContestEntry>;
}

interface ConfigResult {
  config: SweepConfig;
  perSlate: Array<{ date: string; top1: number; top5: number; top10: number }>;
  agg: { top1: number; top5: number; top10: number };
}

// ============================================================
// SWEEP GRID — edit me to focus the sweep
// ============================================================

const SWEEP_GRID: SweepConfig[] = [
  // Baseline + sim toggle
  { label: 'baseline-no-sim',     simMode: 'none',    simBlendWeight: 0.00, crowdingAlphaMult: 1.0 },
  { label: 'baseline-with-sim',   simMode: 'uniform', simBlendWeight: 0.25, crowdingAlphaMult: 1.0 },

  // Vary sim blend weight
  { label: 'sim-blend-0.10',      simMode: 'uniform', simBlendWeight: 0.10, crowdingAlphaMult: 1.0 },
  { label: 'sim-blend-0.40',      simMode: 'uniform', simBlendWeight: 0.40, crowdingAlphaMult: 1.0 },
  { label: 'sim-blend-0.60',      simMode: 'uniform', simBlendWeight: 0.60, crowdingAlphaMult: 1.0 },

  // Vary crowding alpha (5-of-N overlap discount strength)
  { label: 'crowding-0.5x',       simMode: 'uniform', simBlendWeight: 0.25, crowdingAlphaMult: 0.5 },
  { label: 'crowding-2.0x',       simMode: 'uniform', simBlendWeight: 0.25, crowdingAlphaMult: 2.0 },
  { label: 'crowding-4.0x',       simMode: 'uniform', simBlendWeight: 0.25, crowdingAlphaMult: 4.0 },
];

// ============================================================
// HELPERS (largely mirrors actuals-backtest.ts)
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

function entriesToLineups(entries: ContestEntry[], nameMap: Map<string, Player>) {
  const lineups: Lineup[] = [];
  const seenHashes = new Set<string>();
  const entryByHash = new Map<string, ContestEntry>();

  for (const entry of entries) {
    const players: Player[] = [];
    let resolved = true;
    for (const name of entry.playerNames) {
      const p = nameMap.get(normalizeName(name));
      if (!p) { resolved = false; break; }
      players.push(p);
    }
    if (!resolved || players.length === 0) continue;

    const salary = players.reduce((s, p) => s + p.salary, 0);
    const projection = players.reduce((s, p) => s + p.projection, 0);
    const ownership = players.reduce((s, p) => s + (p.ownership || 0), 0) / players.length;
    const hash = players.map(p => p.id).sort().join('|');
    if (seenHashes.has(hash)) {
      const existing = entryByHash.get(hash)!;
      if (entry.rank < existing.rank) entryByHash.set(hash, entry);
      continue;
    }
    seenHashes.add(hash);
    lineups.push({ players, salary, projection, ownership, hash, constructionMethod: 'contest-field' });
    entryByHash.set(hash, entry);
  }
  return { lineups, entryByHash };
}

/**
 * Pre-load all slate data once so we don't re-parse projections + actuals for every config.
 */
function preloadSlates(options: CLIOptions): SlateData[] {
  const dir = options.dataDir || './historical_slates';
  if (!fs.existsSync(dir)) {
    console.error(`historical_slates directory not found: ${dir}`);
    return [];
  }
  const files = fs.readdirSync(dir);
  const projRe = /^(\d{4}-\d{2}-\d{2})_projections\.csv$/;

  const slates: SlateData[] = [];
  for (const f of files) {
    const m = f.match(projRe);
    if (!m) continue;
    const date = m[1];
    const actualsName = `${date}_actuals.csv`;
    if (!files.includes(actualsName)) continue;

    const projPath = path.join(dir, f);
    const actualsPath = path.join(dir, actualsName);

    try {
      const parseResult = parseCSVFile(projPath, options.sport, true);
      const config = getContestConfig(options.site, options.sport, parseResult.detectedContestType);
      const pool = buildPlayerPool(parseResult.players, parseResult.detectedContestType);
      const actuals = parseContestActuals(actualsPath, config);

      const nameMap = buildNameToPlayerMap(pool.players);
      const { lineups, entryByHash } = entriesToLineups(actuals.entries, nameMap);
      if (lineups.length < 100) continue;

      const sortedDescScores = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
      const n = sortedDescScores.length;
      const thresholds = {
        top1: sortedDescScores[Math.max(0, Math.floor(n * 0.01) - 1)] || 0,
        top5: sortedDescScores[Math.max(0, Math.floor(n * 0.05) - 1)] || 0,
        top10: sortedDescScores[Math.max(0, Math.floor(n * 0.10) - 1)] || 0,
      };

      const gameSet = new Set<string>();
      for (const p of pool.players) gameSet.add(p.gameInfo || `${p.team}_game`);

      slates.push({
        date,
        pool: lineups,
        players: pool.players,
        numGames: gameSet.size,
        salaryCap: config.salaryCap,
        thresholds,
        entryByHash,
      });
      console.log(`  Loaded slate ${date}: ${lineups.length} lineups, ${pool.players.length} players`);
    } catch (err) {
      console.error(`  Failed to load slate ${date}: ${(err as Error).message}`);
    }
  }
  return slates;
}

/**
 * Run the selector on a single slate with a specific param config.
 */
function runOneConfig(slate: SlateData, options: CLIOptions, config: SweepConfig) {
  const sel = selectLineupsSimple({
    lineups: slate.pool,
    targetCount: options.lineupCount,
    numGames: slate.numGames,
    salaryCap: slate.salaryCap,
    sport: options.sport,
    players: slate.players,
    contestSize: options.contestSize,
    fieldSamples: options.fieldSamples,
    simMode: config.simMode,
    simBlendWeight: config.simBlendWeight,
    crowdingAlphaMult: config.crowdingAlphaMult,
    quiet: true,  // suppress per-run noise
  });

  const hashes = sel.selected.map(l => l.hash);
  let top1 = 0, top5 = 0, top10 = 0;
  for (const h of hashes) {
    const entry = slate.entryByHash.get(h);
    if (!entry) continue;
    const a = entry.actualPoints;
    if (a >= slate.thresholds.top1) top1++;
    if (a >= slate.thresholds.top5) top5++;
    if (a >= slate.thresholds.top10) top10++;
  }
  const n = hashes.length || 1;
  return { top1: top1 / n, top5: top5 / n, top10: top10 / n };
}

// ============================================================
// MAIN
// ============================================================

export async function runActualsSweep(options: CLIOptions): Promise<void> {
  console.log('========================================');
  console.log('PARAMETER SWEEP — Actuals Backtest');
  console.log('========================================');

  console.log('Pre-loading slates...');
  const slates = preloadSlates(options);
  if (slates.length === 0) {
    console.error('No usable slates found.');
    process.exit(1);
  }
  console.log(`Loaded ${slates.length} slates`);
  console.log(`Sweeping ${SWEEP_GRID.length} configs across ${slates.length} slates = ${SWEEP_GRID.length * slates.length} runs`);

  const results: ConfigResult[] = [];

  for (const config of SWEEP_GRID) {
    console.log(`\n[${config.label}]`);
    const perSlate: ConfigResult['perSlate'] = [];
    let aggT1 = 0, aggT5 = 0, aggT10 = 0;

    for (const slate of slates) {
      const start = Date.now();
      const { top1, top5, top10 } = runOneConfig(slate, options, config);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      perSlate.push({ date: slate.date, top1, top5, top10 });
      aggT1 += top1;
      aggT5 += top5;
      aggT10 += top10;
      console.log(`  ${slate.date}: top1=${(top1 * 100).toFixed(2)}% top5=${(top5 * 100).toFixed(2)}% top10=${(top10 * 100).toFixed(2)}% (${elapsed}s)`);
    }

    results.push({
      config,
      perSlate,
      agg: {
        top1: aggT1 / slates.length,
        top5: aggT5 / slates.length,
        top10: aggT10 / slates.length,
      },
    });
  }

  // ----- Final report -----
  console.log('\n========================================');
  console.log('SWEEP RESULTS — sorted by aggregate top-1%');
  console.log('========================================');
  const sorted = [...results].sort((a, b) => b.agg.top1 - a.agg.top1);
  console.log(`\n${'Config'.padEnd(24)} ${'top1%'.padStart(8)} ${'top5%'.padStart(8)} ${'top10%'.padStart(9)}`);
  for (const r of sorted) {
    console.log(
      `${r.config.label.padEnd(24)} ${(r.agg.top1 * 100).toFixed(2).padStart(7)}% ${(r.agg.top5 * 100).toFixed(2).padStart(7)}% ${(r.agg.top10 * 100).toFixed(2).padStart(8)}%`,
    );
  }
  console.log('\nBest config: ' + sorted[0].config.label);
  console.log('========================================');
}
