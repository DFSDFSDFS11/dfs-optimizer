/**
 * Production Pre-Slate — NBA Showdown (DraftKings).
 *
 * Showdown config:
 *   - 6-position roster (CPT + 5 UTIL). CPT gets 1.5x points & salary.
 *   - Auto-detected from CPT entries in projections.
 *   - minPrimaryStack=0 (no stacking concept in showdown)
 *   - lambda=0 (combo leverage stack keys don't apply)
 *   - maxOverlap=4 (6-roster; γ=5 would be too loose, 4 forces at least 2-player differentiation)
 *   - No corner cap, no ownership ceiling
 *
 * IMPORTANT: Production's architecture (MLB bins + NBA classic tested) was NOT
 * designed for showdown. This run is mathematically executable but architecturally
 * unvalidated. CPT-slot leverage, single-game correlation, and concentrated
 * ownership distributions may make bin allocation a poor fit.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';
import { exportForDraftKings, exportDetailedLineups } from '../scoring';
import { productionSelect } from '../selection/production-selector';

const DATA_DIR = 'C:/Users/colin/dfs opto';
const PROJ_FILE = 'nbashowdownproj.csv';
const POOL_FILES = ['nbashowdownpool.csv', 'nbashowdownpool2.csv'];
const TARGET_COUNT = 150;
const GAMMA = 4;

const OUTPUT_FILE = path.join(DATA_DIR, `production_nba_showdown_preslate_${TARGET_COUNT}.csv`);
const DETAILED_FILE = path.join(DATA_DIR, `production_nba_showdown_preslate_${TARGET_COUNT}_detailed.csv`);

async function main() {
  console.log('================================================================');
  console.log(`PRODUCTION NBA SHOWDOWN PRE-SLATE — γ=${GAMMA}, N=${TARGET_COUNT}`);
  console.log('================================================================\n');
  console.log('⚠ Architectural caveat: production was tuned for MLB Classic + NBA Classic.');
  console.log('  Showdown (6-roster, CPT multiplier, single-game correlation) is untested.\n');

  const projPath = path.join(DATA_DIR, PROJ_FILE);
  console.log(`Loading projections: ${projPath}`);
  const pr = parseCSVFile(projPath, 'nba', true);
  const config = getContestConfig('dk', 'nba', pr.detectedContestType);
  const pool = buildPlayerPool(pr.players, pr.detectedContestType);
  console.log(`  Contest: ${pr.detectedContestType}`);
  console.log(`  Roster size: ${config.rosterSize}`);
  console.log(`  Players parsed: ${pool.players.length}`);

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
    try {
      const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
      totalLoaded += loaded.lineups.length;
      for (const lu of loaded.lineups) {
        if (!mergedByHash.has(lu.hash)) mergedByHash.set(lu.hash, lu);
      }
      console.log(`  ${pf}: ${loaded.lineups.length} lineups (${loaded.unresolvedRows} unresolved)`);
    } catch (err) {
      console.log(`  ${pf}: parse failed — ${(err as Error).message.split('\n')[0]}`);
    }
  }

  const candidates = Array.from(mergedByHash.values());
  console.log(`\n  Merged pool: ${candidates.length} unique lineups (from ${totalLoaded} total)\n`);

  if (candidates.length === 0) {
    console.error('ERROR: No lineups loaded.');
    process.exit(1);
  }

  console.log(`Running production selector (showdown config: lambda=0, γ=${GAMMA}, minPrimaryStack=0)...`);
  const t1 = Date.now();
  const result = productionSelect(candidates, pool.players, {
    N: TARGET_COUNT,
    lambda: 0,
    maxOverlap: GAMMA,
    minPrimaryStack: 0,
    extremeCornerCap: false,
    useOwnershipCeiling: false,
  });
  console.log(`  Selected ${result.portfolio.length} lineups in ${((Date.now() - t1) / 1000).toFixed(1)}s`);

  // Portfolio stats
  console.log('\n================================================================');
  console.log('PORTFOLIO STATS');
  console.log('================================================================\n');

  console.log(`  Anchor own=${result.anchor.ownership.toFixed(1)}% proj=${result.anchor.projection.toFixed(1)}`);
  console.log(`  Target ownership: ${result.targetOwnership.toFixed(1)}%`);
  console.log(`  Actual avg ownership: ${result.actualAvgOwnership.toFixed(1)}% (delta ${(result.actualAvgOwnership - result.targetOwnership).toFixed(1)}pp)`);
  console.log(`  Actual avg projection: ${result.actualAvgProjection.toFixed(1)}`);

  let sumSal = 0;
  for (const lu of result.portfolio) sumSal += lu.salary;
  console.log(`  Avg salary: $${(sumSal / result.portfolio.length).toFixed(0)}`);

  const binLabels = ['chalk', 'core', 'value', 'contra', 'deep'];
  const binStr = binLabels.map(b => `${b}=${result.binFills.get(b) || 0}`).join(', ');
  console.log(`  Bin fills: ${binStr}`);

  // CPT distribution (unique to showdown)
  const cptCount = new Map<string, { name: string; team: string; own: number; proj: number; n: number }>();
  for (const lu of result.portfolio) {
    // In showdown, the CPT is the player with the highest-salary-and-projection duplicate
    // Parser tags it; easiest heuristic: CPT is the first player when positions array contains CPT
    for (const p of lu.players) {
      if (p.positions?.includes('CPT') || p.isCaptain) {
        const rec = cptCount.get(p.id) || { name: p.name, team: p.team, own: p.ownership || 0, proj: p.projection || 0, n: 0 };
        rec.n++;
        cptCount.set(p.id, rec);
        break;
      }
    }
  }
  if (cptCount.size > 0) {
    console.log(`\n  CPT distribution (${cptCount.size} unique captains):`);
    const sortedCPT = [...cptCount.values()].sort((a, b) => b.n - a.n);
    for (const c of sortedCPT) {
      console.log(`    ${c.name.padEnd(28)} ${c.team.padEnd(4)} ${(c.n / result.portfolio.length * 100).toFixed(1).padStart(5)}% (${c.n}/${result.portfolio.length})  own=${c.own.toFixed(1)}%  proj=${c.proj.toFixed(1)}`);
    }
  }

  // Overall player exposures
  const playerExp = new Map<string, { count: number; name: string; team: string; pos: string; own: number; proj: number }>();
  for (const lu of result.portfolio) {
    for (const p of lu.players) {
      const e = playerExp.get(p.id) || {
        count: 0, name: p.name, team: p.team, pos: p.positions?.[0] || '?',
        own: p.ownership || 0, proj: p.projection || 0,
      };
      e.count++;
      playerExp.set(p.id, e);
    }
  }
  const sortedExp = [...playerExp.values()].sort((a, b) => b.count - a.count);
  console.log(`\n  Top 20 player exposures (CPT+UTIL combined):`);
  for (const v of sortedExp.slice(0, 20)) {
    console.log(`    ${v.name.padEnd(28)} ${v.team.padEnd(4)} ${v.pos.padEnd(6)} ${((v.count / result.portfolio.length) * 100).toFixed(1).padStart(5)}% (${v.count}/${result.portfolio.length})  own=${v.own.toFixed(1)}%  proj=${v.proj.toFixed(1)}`);
  }
  console.log(`\n  Unique players across portfolio: ${playerExp.size}`);

  // Export
  exportForDraftKings(result.portfolio, config, OUTPUT_FILE);
  exportDetailedLineups(result.portfolio, config, DETAILED_FILE);

  console.log('\n================================================================');
  console.log('DONE');
  console.log('================================================================');
  console.log(`  DK upload:  ${OUTPUT_FILE}`);
  console.log(`  Detail:     ${DETAILED_FILE}`);
}

main().catch(err => {
  console.error('NBA showdown pre-slate failed:', err);
  process.exit(1);
});
