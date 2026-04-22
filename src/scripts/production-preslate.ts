/**
 * Production Pre-Slate — run the production selector on tonight's MLB pools.
 *
 * Config: λ=0.05 (validated 2026-04-21), γ disabled (maxOverlap=10), N=150.
 * Reads mlbdkprojpre.csv + sspool{1,2,3}pre.csv from DATA_DIR.
 * Merges/dedupes pools by lineup hash, precomputes combo frequencies, runs selection,
 * exports DK upload CSV + detailed CSV.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';
import { exportForDraftKings, exportDetailedLineups } from '../scoring';
import { productionSelect } from '../selection/production-selector';
import { precomputeComboFrequencies } from '../selection/combo-leverage';

const DATA_DIR = 'C:/Users/colin/dfs opto';
const PROJ_FILE = 'mlbdkprojpre.csv';
const POOL_FILES = ['sspool1pre.csv', 'sspool2pre.csv', 'sspool3pre.csv'];
const TARGET_COUNT = 150;
const LAMBDA = 0.05;
const GAMMA = 7;

const OUTPUT_FILE = path.join(DATA_DIR, `production_mlb_preslate_${TARGET_COUNT}.csv`);
const DETAILED_FILE = path.join(DATA_DIR, `production_mlb_preslate_${TARGET_COUNT}_detailed.csv`);

async function main() {
  console.log('================================================================');
  console.log(`PRODUCTION PRE-SLATE — λ=${LAMBDA}, γ=${GAMMA}, N=${TARGET_COUNT}`);
  console.log('================================================================\n');

  // 1. Load projections
  const projPath = path.join(DATA_DIR, PROJ_FILE);
  console.log(`Loading projections: ${projPath}`);
  const pr = parseCSVFile(projPath, 'mlb', true);
  const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
  const pool = buildPlayerPool(pr.players, pr.detectedContestType);
  console.log(`  Players parsed: ${pool.players.length}`);

  // 2. Load and merge SS pool CSVs
  const idMap = new Map<string, Player>();
  for (const p of pool.players) idMap.set(p.id, p);

  const mergedByHash = new Map<string, Lineup>();
  let totalLoaded = 0;

  for (const pf of POOL_FILES) {
    const poolPath = path.join(DATA_DIR, pf);
    if (!fs.existsSync(poolPath)) {
      console.log(`  Skipping ${pf}: not found`);
      continue;
    }
    const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
    totalLoaded += loaded.lineups.length;
    for (const lu of loaded.lineups) {
      if (!mergedByHash.has(lu.hash)) mergedByHash.set(lu.hash, lu);
    }
    console.log(`  ${pf}: ${loaded.lineups.length} lineups (${loaded.unresolvedRows} unresolved)`);
  }

  const candidates = Array.from(mergedByHash.values());
  console.log(`\n  Merged pool: ${candidates.length} unique lineups (from ${totalLoaded} total)\n`);

  if (candidates.length === 0) {
    console.error('ERROR: No lineups loaded.');
    process.exit(1);
  }

  // 3. Precompute combo frequencies from the merged pool
  console.log('Precomputing combo frequencies (projection^3 weighted)...');
  const t0 = Date.now();
  const comboFreq = precomputeComboFrequencies(candidates, 3);
  console.log(`  ${comboFreq.size} unique combo keys in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // 4. Run production selector
  console.log(`\nRunning production selector...`);
  const t1 = Date.now();
  const result = productionSelect(candidates, pool.players, {
    N: TARGET_COUNT,
    lambda: LAMBDA,
    comboFreq,
    maxOverlap: 7, // Hunter γ — matches nerdytenor's empirical max across 8 slates
    teamCapPct: 0.15, // 4-game slate — 15% cap
    ownershipCeilingBuffer: 3.0, // V35 proportional ownership filter
  });
  console.log(`  Selected ${result.portfolio.length} lineups in ${((Date.now() - t1) / 1000).toFixed(1)}s`);

  // 5. Portfolio stats
  console.log('\n================================================================');
  console.log('PORTFOLIO STATS');
  console.log('================================================================\n');

  console.log(`  Anchor own=${result.anchor.ownership.toFixed(1)}% proj=${result.anchor.projection.toFixed(1)}`);
  console.log(`  Target ownership: ${result.targetOwnership.toFixed(1)}%`);
  if (result.ownershipCeiling) {
    console.log(`  Ownership ceiling filter: ${result.ownershipCeiling.filtered} lineups pruned (medianCeiling=${result.ownershipCeiling.medianCeiling.toFixed(1)}% → maxCeiling=${result.ownershipCeiling.maxCeiling.toFixed(1)}%)`);
  }
  console.log(`  Actual avg ownership: ${result.actualAvgOwnership.toFixed(1)}% (delta ${(result.actualAvgOwnership - result.targetOwnership).toFixed(1)}pp)`);
  console.log(`  Actual avg projection: ${result.actualAvgProjection.toFixed(1)}`);

  let sumSal = 0;
  for (const lu of result.portfolio) sumSal += lu.salary;
  console.log(`  Avg salary: $${(sumSal / result.portfolio.length).toFixed(0)}`);

  // Bin fills
  const binLabels = ['chalk', 'core', 'value', 'contra', 'deep'];
  const binStr = binLabels.map(b => `${b}=${result.binFills.get(b) || 0}`).join(', ');
  console.log(`  Bin fills: ${binStr}`);

  // Player exposures
  const playerExp = new Map<string, { count: number; name: string; team: string; own: number }>();
  for (const lu of result.portfolio) {
    for (const p of lu.players) {
      const e = playerExp.get(p.id) || { count: 0, name: p.name, team: p.team, own: p.ownership || 0 };
      e.count++;
      playerExp.set(p.id, e);
    }
  }
  const sortedExp = [...playerExp.entries()].sort((a, b) => b[1].count - a[1].count);
  console.log(`\n  Top 20 player exposures:`);
  for (const [, v] of sortedExp.slice(0, 20)) {
    console.log(`    ${v.name.padEnd(25)} ${v.team.padEnd(5)} ${((v.count / result.portfolio.length) * 100).toFixed(1).padStart(5)}% (${v.count}/${result.portfolio.length})  own=${v.own.toFixed(1)}%`);
  }

  // Team stacks
  const stackCounts = [...result.teamStackCounts.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`\n  Team stacks (4+ hitters):`);
  for (const [team, count] of stackCounts) {
    console.log(`    ${team.padEnd(5)} ${count} lineups (${((count / result.portfolio.length) * 100).toFixed(1)}%)`);
  }
  console.log(`  Unique stacked teams: ${stackCounts.length}`);
  console.log(`  Unique players: ${playerExp.size}`);

  // 6. Export
  exportForDraftKings(result.portfolio, config, OUTPUT_FILE);
  exportDetailedLineups(result.portfolio, config, DETAILED_FILE);

  console.log('\n================================================================');
  console.log('DONE');
  console.log('================================================================');
  console.log(`  DK upload:  ${OUTPUT_FILE}`);
  console.log(`  Detail:     ${DETAILED_FILE}`);
}

main().catch(err => {
  console.error('Pre-slate failed:', err);
  process.exit(1);
});
