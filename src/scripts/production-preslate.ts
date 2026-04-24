/**
 * Kraken Pre-Slate — run the Kraken selector on tonight's MLB pools.
 *
 * KRAKEN (shipped 2026-04-24): concentrated GPP attack. λ=0.38 combo leverage
 * + γ=6 tight overlap + teamCap=0.21 high-concentration + value-heavy bins
 * (55% value, 13% chalk/core/contra, 2% deep).
 *
 * Validated via 67,900-config megabin sweep on 11 MLB slates. 3,100+ configs
 * beat Apex on all three metrics (full + recent + min-LOO); winners converge
 * on this exact archetype.
 *
 *   Full-sample: $149,215 (+172% vs Apex $54,869)
 *   Recent 5:    $62,921  (+$19,574 vs Apex)
 *   min-LOO:     $7,959   (2.65× $3K break-even, best ever tested)
 *
 * Caveat: 95% of full-sample from 4 slates (4-6, 4-14, 4-18, 4-21). Structural
 * convergence across 2,000+ configs says "concentrate harder when projections
 * identify correct team explosions." Risk: if projections miss the team, high
 * concentration hurts — 7 of 11 backtest slates returned below break-even.
 *
 * Reads mlbdkprojpre.csv + sspool{1,2,3}pre.csv from DATA_DIR.
 * Merges/dedupes pools by lineup hash, precomputes combo frequencies, runs selection,
 * exports DK upload CSV + detailed CSV.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';
import { exportForDraftKings, exportDetailedLineups } from '../scoring';
import { productionSelect } from '../selection/production-selector';
import { precomputeComboFrequencies } from '../selection/combo-leverage';

// Sim-ROI filter: reject lineups below this percentile of pool sim ROI for target contest.
// 0.0 = disabled (accept all). 0.5 = reject bottom half. 0.75 = top quartile only.
const MIN_SIM_ROI_PERCENTILE = 0.5;
const SIM_ROI_CONTEST = 'Small Slate | 10k-50k'; // 2-game slate → Small Slate bracket

function parsePoolSimROI(filePath: string, rosterSize: number, roiCol: string): Map<string, number> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const records: string[][] = parse(content, { columns: false, skip_empty_lines: true, relax_column_count: true, trim: true });
  if (records.length < 2) return new Map();
  const headers = records[0];
  const idx = headers.findIndex(h => h.trim() === roiCol);
  if (idx === -1) return new Map();
  const hashMap = new Map<string, number>();
  for (let r = 1; r < records.length; r++) {
    const row = records[r];
    const ids: string[] = [];
    for (let i = 0; i < rosterSize; i++) if (row[i]) ids.push(row[i]);
    if (ids.length !== rosterSize) continue;
    const hash = [...ids].sort().join('|');
    const v = parseFloat(row[idx]);
    if (!isNaN(v)) hashMap.set(hash, v);
  }
  return hashMap;
}

function lineupHash(lu: Lineup): string {
  return lu.players.map(p => p.id).sort().join('|');
}

const DATA_DIR = 'C:/Users/colin/dfs opto';
const PROJ_FILE = 'mlbdkprojpre.csv';
const POOL_FILES = ['sspool1pre.csv', 'sspool2pre.csv', 'sspool3pre.csv'];
const TARGET_COUNT = 45;

// ============ KRAKEN CONFIG ============
// Named preset: concentrated GPP attack (deep-rising predator).
// Top-winner from 67,900-config megabin sweep — structural archetype of
// 3,100+ configs that beat Apex on all three metrics.
const KRAKEN_LAMBDA = 0.38;
const KRAKEN_GAMMA = 6;
const KRAKEN_TEAM_CAP = 0.21;
const KRAKEN_CORNER = false;
const KRAKEN_BINS = { chalk: 0.16, core: 0.13, value: 0.55, contra: 0.13, deep: 0.02 };
// ========================================

const LAMBDA = KRAKEN_LAMBDA;
const GAMMA = KRAKEN_GAMMA;

const OUTPUT_FILE = path.join(DATA_DIR, `production_mlb_preslate_${TARGET_COUNT}.csv`);
const DETAILED_FILE = path.join(DATA_DIR, `production_mlb_preslate_${TARGET_COUNT}_detailed.csv`);

async function main() {
  console.log('================================================================');
  console.log(`KRAKEN PRE-SLATE — λ=${LAMBDA}, γ=${GAMMA}, teamCap=${KRAKEN_TEAM_CAP}, cornerCap=${KRAKEN_CORNER}, N=${TARGET_COUNT}`);
  console.log('  Bins: ' + JSON.stringify(KRAKEN_BINS));
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

  let candidates = Array.from(mergedByHash.values());
  console.log(`\n  Merged pool: ${candidates.length} unique lineups (from ${totalLoaded} total)\n`);

  if (candidates.length === 0) {
    console.error('ERROR: No lineups loaded.');
    process.exit(1);
  }

  // 2b. Sim-ROI filter — reject bottom (1 - MIN_SIM_ROI_PERCENTILE) of pool by sim ROI for target contest
  if (MIN_SIM_ROI_PERCENTILE > 0) {
    console.log(`\nApplying sim-ROI filter: contest="${SIM_ROI_CONTEST}", keep top ${((1 - MIN_SIM_ROI_PERCENTILE) * 100).toFixed(0)}% by sim ROI...`);
    // Merge sim ROI from all source pool files (each pool has its own sim ROI column)
    const roiByHash = new Map<string, number>();
    for (const pf of POOL_FILES) {
      const poolPath = path.join(DATA_DIR, pf);
      if (!fs.existsSync(poolPath)) continue;
      const roi = parsePoolSimROI(poolPath, config.rosterSize, SIM_ROI_CONTEST);
      for (const [h, v] of roi) if (!roiByHash.has(h)) roiByHash.set(h, v);
    }
    if (roiByHash.size === 0) {
      console.log(`  ⚠ Sim ROI column "${SIM_ROI_CONTEST}" not found in pool files — skipping filter.`);
    } else {
      console.log(`  ROI map entries: ${roiByHash.size}  |  merged pool: ${candidates.length}`);
      // Diagnostic: count lineups in merged pool with vs without ROI data
      let covered = 0;
      for (const lu of candidates) if (roiByHash.has(lineupHash(lu))) covered++;
      console.log(`  Pool coverage: ${covered}/${candidates.length} lineups have ROI data (${(covered / candidates.length * 100).toFixed(1)}%)`);

      // Use ROI distribution ONLY over covered lineups (lineups in merged pool WITH ROI data)
      const coveredROIs: number[] = [];
      for (const lu of candidates) {
        const r = roiByHash.get(lineupHash(lu));
        if (r !== undefined) coveredROIs.push(r);
      }
      coveredROIs.sort((a, b) => a - b);
      const threshold = coveredROIs[Math.floor(coveredROIs.length * MIN_SIM_ROI_PERCENTILE)];
      console.log(`  Covered ROI dist: p10=${coveredROIs[Math.floor(coveredROIs.length * 0.1)].toFixed(2)}  p25=${coveredROIs[Math.floor(coveredROIs.length * 0.25)].toFixed(2)}  p50=${coveredROIs[Math.floor(coveredROIs.length * 0.5)].toFixed(2)}  p75=${coveredROIs[Math.floor(coveredROIs.length * 0.75)].toFixed(2)}  p90=${coveredROIs[Math.floor(coveredROIs.length * 0.9)].toFixed(2)}  max=${coveredROIs[coveredROIs.length - 1].toFixed(2)}`);
      console.log(`  Threshold at p${(MIN_SIM_ROI_PERCENTILE * 100).toFixed(0)}: ${threshold.toFixed(2)}`);
      const before = candidates.length;
      // Keep lineups with ROI data above threshold. Lineups without ROI data: keep (don't penalize for missing data).
      candidates = candidates.filter(lu => {
        const r = roiByHash.get(lineupHash(lu));
        return r === undefined || r >= threshold;
      });
      console.log(`  Filtered pool: ${before} → ${candidates.length} lineups (${((candidates.length / before) * 100).toFixed(1)}%)`);
    }
  }

  if (candidates.length === 0) {
    console.error('ERROR: Pool empty after sim-ROI filter. Loosen MIN_SIM_ROI_PERCENTILE.');
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
    maxOverlap: GAMMA, // Kraken γ=6
    teamCapPct: KRAKEN_TEAM_CAP, // 0.21 — high concentration (32 lineups max per primary-stack team)
    minPrimaryStack: 3, // allow 3-stacks in pool
    maxExposurePitcher: 0.40, // 40% pitcher cap
    useOwnershipCeiling: false,
    extremeCornerCap: KRAKEN_CORNER, // Kraken: corner cap OFF (top-winner config)
    binAllocation: KRAKEN_BINS, // 16/13/55/13/2 — value-heavy
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
