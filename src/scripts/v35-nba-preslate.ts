/**
 * V35 NBA Pre-Slate — Run V35 sequential payout optimizer on NBA live pools.
 *
 * Usage: npx ts-node src/scripts/v35-nba-preslate.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';
import { exportForDraftKings, exportDetailedLineups } from '../scoring';
import { runV35 } from '../v35';

const DATA_DIR = 'C:/Users/colin/dfs opto';
const PROJ_FILE = 'nbaprojpre.csv';
const POOL_FILES = ['ssnbapool.csv', 'ssnbapool2.csv'];
const TARGET_COUNT = 100;
const ENTRY_FEE = 20;
const OUTPUT_FILE = path.join(DATA_DIR, `v35_nba_preslate_${TARGET_COUNT}.csv`);
const DETAILED_FILE = path.join(DATA_DIR, `v35_nba_preslate_${TARGET_COUNT}_detailed.csv`);

async function main() {
  console.log('================================================================');
  console.log('V35 NBA PRE-SLATE — Sequential Marginal Payout Optimization');
  console.log('================================================================\n');

  // 1. Load projections
  const projPath = path.join(DATA_DIR, PROJ_FILE);
  console.log(`Loading projections: ${projPath}`);
  const pr = parseCSVFile(projPath, 'nba', true);
  const config = getContestConfig('dk', 'nba', pr.detectedContestType);
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
    maxTeamStackPct: 0.25, // NBA doesn't stack like MLB, keep loose
    seed: 12345,
  });

  const portfolio = result.portfolio;
  console.log(`\n  Selected ${portfolio.length} lineups in ${(result.selectionTimeMs / 1000).toFixed(1)}s\n`);

  // 4. Portfolio stats
  console.log('================================================================');
  console.log('PORTFOLIO STATS');
  console.log('================================================================\n');

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
  const playerExp = new Map<string, { count: number; name: string; team: string; own: number; proj: number }>();
  for (const lu of portfolio) {
    for (const p of lu.players) {
      const e = playerExp.get(p.id) || { count: 0, name: p.name, team: p.team, own: p.ownership || 0, proj: p.projection };
      e.count++;
      playerExp.set(p.id, e);
    }
  }
  const sortedExp = [...playerExp.entries()].sort((a, b) => b[1].count - a[1].count);
  console.log(`\n  Top Player Exposures:`);
  for (const [, v] of sortedExp.slice(0, 25)) {
    console.log(`    ${v.name.padEnd(25)} ${v.team.padEnd(5)} ${((v.count / portfolio.length) * 100).toFixed(1).padStart(5)}% (${v.count}/${portfolio.length})  own=${v.own.toFixed(1)}%  proj=${v.proj.toFixed(1)}`);
  }

  // Team exposure
  const teamExp = new Map<string, number>();
  for (const lu of portfolio) {
    const teams = new Set(lu.players.map(p => p.team));
    for (const t of teams) teamExp.set(t, (teamExp.get(t) || 0) + 1);
  }
  const sortedTeams = [...teamExp.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`\n  Team Exposure:`);
  for (const [team, count] of sortedTeams) {
    console.log(`    ${team.padEnd(5)} ${count} lineups (${((count / portfolio.length) * 100).toFixed(1)}%)`);
  }

  // Ownership distribution check
  const rows: { proj: number; own: number }[] = [];
  for (const lu of portfolio) {
    rows.push({
      proj: lu.projection,
      own: lu.players.reduce((s, p) => s + (p.ownership || 0), 0) / lu.players.length,
    });
  }
  console.log(`\n  Proj/Own Distribution:`);
  const brackets: [number, number][] = [[0, 240], [240, 260], [260, 280], [280, 300], [300, 400]];
  for (const [lo, hi] of brackets) {
    const b = rows.filter(r => r.proj >= lo && r.proj < hi);
    if (b.length === 0) continue;
    const avgO = b.reduce((s, r) => s + r.own, 0) / b.length;
    console.log(`    proj ${lo}-${hi}: ${b.length} lineups, avg own=${avgO.toFixed(1)}%`);
  }

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
  console.error('V35 NBA pre-slate failed:', err);
  process.exit(1);
});
