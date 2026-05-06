/**
 * Hydra-MMA Pre-Slate — DraftKings MMA (6-fighter roster).
 *
 * MMA-tuned Hydra adaptation:
 *   - λ=0.20 combo leverage (same as MLB Hydra; combo keys may have less effect on MMA)
 *   - γ=4 overlap (6-fighter roster, roster-2 follows Hunter convention)
 *   - minPrimaryStack=0 (MMA has no stacking)
 *   - teamCap effectively disabled (each fighter unique to their fight)
 *   - extremeCornerCap=true (still useful for chalky-favorite corner)
 *   - binAllocation: Hydra defaults 7/7/58/12/16 (chalk-light, deep-rebuilt)
 *   - projectionFloorPct=0 (no floor — MMA has high variance per fighter)
 *
 * Reads mmaprojpre.csv + mmapool{1,2}.csv from DATA_DIR.
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
const PROJ_FILE = 'mmaprojpre.csv';
const POOL_FILES = ['mmapool1.csv', 'mmapool2.csv'];
const TARGET_COUNT = 150;

// ============ HYDRA-MMA CONFIG ============
const HYDRA_LAMBDA   = 0.20;
const HYDRA_GAMMA    = 4;     // 6-fighter roster: γ=4 (Hunter convention rosterSize-2)
const HYDRA_TEAM_CAP = 0.50;  // disabled — MMA has no stacking
const HYDRA_CORNER   = true;
const HYDRA_BINS     = { chalk: 0.07, core: 0.07, value: 0.58, contra: 0.12, deep: 0.16 };
// ===========================================

const OUTPUT_FILE = path.join(DATA_DIR, `production_mma_preslate_${TARGET_COUNT}.csv`);
const DETAILED_FILE = path.join(DATA_DIR, `production_mma_preslate_${TARGET_COUNT}_detailed.csv`);

async function main() {
  console.log('================================================================');
  console.log(`HYDRA-MMA PRE-SLATE — λ=${HYDRA_LAMBDA}, γ=${HYDRA_GAMMA}, corner=${HYDRA_CORNER}, N=${TARGET_COUNT}`);
  console.log(`  Bins: ${JSON.stringify(HYDRA_BINS)}`);
  console.log('================================================================\n');

  const projPath = path.join(DATA_DIR, PROJ_FILE);
  console.log(`Loading projections: ${projPath}`);
  const pr = parseCSVFile(projPath, 'mma', true);
  const config = getContestConfig('dk', 'mma', pr.detectedContestType);
  const pool = buildPlayerPool(pr.players, pr.detectedContestType);
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

  console.log('Precomputing combo frequencies (projection^3 weighted)...');
  const cfStart = Date.now();
  const comboFreq = precomputeComboFrequencies(candidates, 3);
  console.log(`  ${comboFreq.size} unique combo keys in ${((Date.now() - cfStart) / 1000).toFixed(1)}s`);

  console.log(`\nRunning Hydra-MMA selector...`);
  const t1 = Date.now();
  const result = productionSelect(candidates, pool.players, {
    N: TARGET_COUNT,
    lambda: HYDRA_LAMBDA,
    comboFreq,
    maxOverlap: HYDRA_GAMMA,
    teamCapPct: HYDRA_TEAM_CAP,
    minPrimaryStack: 0,
    extremeCornerCap: HYDRA_CORNER,
    binAllocation: HYDRA_BINS,
  });
  console.log(`  Selected ${result.portfolio.length} lineups in ${((Date.now() - t1) / 1000).toFixed(1)}s`);

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
  console.log(`  Bin fills: ${binLabels.map(b => `${b}=${result.binFills.get(b) || 0}`).join(', ')}`);

  // Fighter exposures
  const playerExp = new Map<string, { count: number; name: string; team: string; own: number; proj: number; salary: number }>();
  for (const lu of result.portfolio) {
    for (const p of lu.players) {
      const e = playerExp.get(p.id) || {
        count: 0, name: p.name, team: p.team || '?',
        own: p.ownership || 0, proj: p.projection || 0, salary: p.salary || 0,
      };
      e.count++;
      playerExp.set(p.id, e);
    }
  }
  const sortedExp = [...playerExp.values()].sort((a, b) => b.count - a.count);
  console.log(`\n  Top 20 fighter exposures:`);
  for (const v of sortedExp.slice(0, 20)) {
    console.log(`    ${v.name.padEnd(28)} ${v.team.padEnd(5)} ${((v.count / result.portfolio.length) * 100).toFixed(1).padStart(5)}% (${v.count}/${result.portfolio.length})  own=${v.own.toFixed(1)}%  proj=${v.proj.toFixed(1)}  $${v.salary}`);
  }
  console.log(`\n  Unique fighters: ${playerExp.size}`);

  exportForDraftKings(result.portfolio, config, OUTPUT_FILE);
  exportDetailedLineups(result.portfolio, config, DETAILED_FILE);

  console.log('\n================================================================');
  console.log('DONE');
  console.log('================================================================');
  console.log(`  DK upload:  ${OUTPUT_FILE}`);
  console.log(`  Detail:     ${DETAILED_FILE}`);
}

main().catch(err => {
  console.error('MMA pre-slate failed:', err);
  process.exit(1);
});
