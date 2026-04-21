/**
 * V35 Pre-Slate — Run V35 sequential payout optimizer on live pools.
 *
 * Usage: npx ts-node src/scripts/v35-preslate.ts
 *
 * Reads mlbdkprojpre.csv + sspool{1,2,3}pre.csv from DATA_DIR,
 * merges/dedupes pools, runs V35 pipeline, exports DK-upload CSV.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';
import { exportForDraftKings, exportDetailedLineups } from '../scoring';
import { runV35 } from '../v35';

const DATA_DIR = 'C:/Users/colin/dfs opto';
const PROJ_FILE = 'mlbdkprojpre.csv';
const POOL_FILES = ['sspool1pre.csv', 'sspool2pre.csv'];
const TARGET_COUNT = 150;
const ENTRY_FEE = 20;
const OUTPUT_FILE = path.join(DATA_DIR, `v35_mlb_preslate_${TARGET_COUNT}.csv`);
const DETAILED_FILE = path.join(DATA_DIR, `v35_mlb_preslate_${TARGET_COUNT}_detailed.csv`);

async function main() {
  console.log('================================================================');
  console.log('V35 PRE-SLATE — Sequential Marginal Payout Optimization');
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
    console.error('ERROR: No lineups loaded. Check pool files.');
    process.exit(1);
  }

  // 3. Run V35 pipeline
  const result = await runV35({
    players: pool.players,
    candidates,
    pool: candidates,
    targetCount: TARGET_COUNT,
    numWorlds: 3000,
    fieldSize: 8000,
    entryFee: ENTRY_FEE,
    maxExposure: 0.40,
    maxTeamStackPct: 0.10,
    seed: 12345,
  });

  const portfolio = result.portfolio;
  console.log(`\n  Selected ${portfolio.length} lineups in ${(result.selectionTimeMs / 1000).toFixed(1)}s\n`);

  // 4. Portfolio stats
  console.log('================================================================');
  console.log('PORTFOLIO STATS');
  console.log('================================================================\n');

  // Average ownership & projection
  let sumOwn = 0, sumProj = 0, sumSal = 0;
  for (const lu of portfolio) {
    sumProj += lu.projection;
    sumSal += lu.salary;
    sumOwn += lu.players.reduce((s, p) => s + (p.ownership || 0), 0) / lu.players.length;
  }
  console.log(`  Avg Projection: ${(sumProj / portfolio.length).toFixed(1)}`);
  console.log(`  Avg Ownership:  ${(sumOwn / portfolio.length).toFixed(1)}%`);
  console.log(`  Avg Salary:     $${(sumSal / portfolio.length).toFixed(0)}`);

  // Player exposure
  const playerExp = new Map<string, { count: number; name: string; team: string; own: number }>();
  for (const lu of portfolio) {
    for (const p of lu.players) {
      const e = playerExp.get(p.id) || { count: 0, name: p.name, team: p.team, own: p.ownership || 0 };
      e.count++;
      playerExp.set(p.id, e);
    }
  }
  const sortedExp = [...playerExp.entries()].sort((a, b) => b[1].count - a[1].count);
  console.log(`\n  Top Player Exposures:`);
  for (const [, v] of sortedExp.slice(0, 20)) {
    console.log(`    ${v.name.padEnd(25)} ${v.team.padEnd(5)} ${((v.count / portfolio.length) * 100).toFixed(1).padStart(5)}% (${v.count}/${portfolio.length})  own=${v.own.toFixed(1)}%`);
  }

  // Team stacks
  const teamStackMap = new Map<string, number>();
  for (const lu of portfolio) {
    const tc = new Map<string, number>();
    for (const p of lu.players) {
      if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
    }
    for (const [t, c] of tc) {
      if (c >= 4) teamStackMap.set(t, (teamStackMap.get(t) || 0) + 1);
    }
  }
  const sortedStacks = [...teamStackMap.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`\n  Team Stacks (4+ batters):`);
  for (const [team, count] of sortedStacks) {
    console.log(`    ${team.padEnd(5)} ${count} lineups (${((count / portfolio.length) * 100).toFixed(1)}%)`);
  }
  console.log(`  Total unique teams stacked: ${sortedStacks.length}`);

  // Unique players
  console.log(`\n  Unique players used: ${playerExp.size}`);

  // 5. Export
  exportForDraftKings(portfolio, config, OUTPUT_FILE);
  exportDetailedLineups(portfolio, config, DETAILED_FILE);

  console.log(`\n================================================================`);
  console.log(`DONE — ${portfolio.length} lineups written to:`);
  console.log(`  DK upload: ${OUTPUT_FILE}`);
  console.log(`  Detail:    ${DETAILED_FILE}`);
  console.log(`================================================================`);
}

main().catch(err => {
  console.error('V35 pre-slate failed:', err);
  process.exit(1);
});
