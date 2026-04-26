/**
 * Chimera Pre-Slate — supersedes Phoenix (shipped 2026-04-26).
 *
 * CHIMERA: dispersion-aware top winner from the rank-dispersion analysis.
 * Phoenix had +248.5% ROI but was rank #141 of 200 on dispersion (clumping —
 * 150 lineups all finishing in similar rank windows). Chimera produces both
 * higher ROI (+278.9%) AND smoother rank distribution (#15 of 200).
 *
 * Config: λ=0.62, γ=6, teamCap=0.24, corner=ON, bins 5/5/85/3/2 (same as Phoenix),
 *         minPrimaryStack=5, maxExposure=0.16, maxExposurePitcher=0.41,
 *         combo power=2 (vs Phoenix's 3).
 *
 * Why Chimera differs from Phoenix:
 *   - λ: 0.14 → 0.62 (4× combo leverage push toward rare 5-stack constructions)
 *   - corner: OFF → ON (caps Q5×Q5 chalk corner + Q1×Q1 junk corner)
 *   - mps: 3 → 5 (FORCED 5-player primary stack — biggest dispersion driver)
 *   - me: 0.20 → 0.16 (tighter hitter cap)
 *   - combo power: 3 → 2 (different combo frequency weighting)
 *   - Bin allocation unchanged (5/5/85/3/2 value-extreme)
 *
 * Direct head-to-head on 15 MLB slates:
 *   Phoenix  | full15 $156,817 | ROI +248.5% | IQR/F 47.9% (rank #141)
 *   Chimera  | full15 $170,510 | ROI +278.9% | IQR/F 50.1% (rank #15)
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
const TARGET_COUNT = 150;

// ============ CHIMERA CONFIG ============
// Named preset: dispersion-aware multi-mechanism winner.
// Top of "Smooth Winners" analysis — best combined ROI rank × dispersion rank.
// Beats Phoenix on both ROI (+278.9% vs +248.5%) AND rank dispersion (#15 vs #141).
const CHIMERA_LAMBDA   = 0.62;
const CHIMERA_GAMMA    = 6;
const CHIMERA_TEAM_CAP = 0.24;
const CHIMERA_CORNER   = true;
const CHIMERA_MIN_STACK = 5;        // FORCED 5-player primary stack — key dispersion driver
const CHIMERA_MAX_EXPOSURE = 0.16;  // tighter hitter cap (24 lineups max per hitter at N=150)
const CHIMERA_MAX_EXPOSURE_P = 0.41; // pitcher cap
const CHIMERA_COMBO_POWER = 2;      // combo frequency weighting (vs default 3)
const CHIMERA_BINS = { chalk: 0.05, core: 0.05, value: 0.85, contra: 0.03, deep: 0.02 };
// =========================================

const LAMBDA = CHIMERA_LAMBDA;
const GAMMA = CHIMERA_GAMMA;

const OUTPUT_FILE = path.join(DATA_DIR, `production_mlb_preslate_${TARGET_COUNT}.csv`);
const DETAILED_FILE = path.join(DATA_DIR, `production_mlb_preslate_${TARGET_COUNT}_detailed.csv`);

async function main() {
  console.log('================================================================');
  console.log(`CHIMERA PRE-SLATE — λ=${LAMBDA}, γ=${GAMMA}, teamCap=${CHIMERA_TEAM_CAP}, cornerCap=${CHIMERA_CORNER}, mps=${CHIMERA_MIN_STACK}, N=${TARGET_COUNT}`);
  console.log(`  Bins: ${JSON.stringify(CHIMERA_BINS)}  comboPower=${CHIMERA_COMBO_POWER}  me=${CHIMERA_MAX_EXPOSURE} mep=${CHIMERA_MAX_EXPOSURE_P}`);
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

  // Manual player exclusions (injury/news). Set to empty array for normal runs.
  const ZERO_PROJ_PLAYERS: string[] = [];
  if (ZERO_PROJ_PLAYERS.length > 0) {
    const zeroSet = new Set(ZERO_PROJ_PLAYERS.map(n => n.toLowerCase().trim()));
    const before = candidates.length;
    candidates = candidates.filter(lu => !lu.players.some(p => zeroSet.has(p.name.toLowerCase().trim())));
    for (const p of pool.players) {
      if (zeroSet.has(p.name.toLowerCase().trim())) {
        p.projection = 0;
        p.ownership = 0;
      }
    }
    console.log(`  Excluded ${before - candidates.length} lineups containing: ${ZERO_PROJ_PLAYERS.join(', ')}`);
    console.log(`  Pool after exclusions: ${candidates.length} lineups\n`);
  }


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

  // 3. Precompute combo frequencies from the merged pool (Chimera uses power=2)
  console.log(`Precomputing combo frequencies (projection^${CHIMERA_COMBO_POWER} weighted)...`);
  const t0 = Date.now();
  const comboFreq = precomputeComboFrequencies(candidates, CHIMERA_COMBO_POWER);
  console.log(`  ${comboFreq.size} unique combo keys in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // 4. Run production selector
  console.log(`\nRunning production selector...`);
  const t1 = Date.now();
  const result = productionSelect(candidates, pool.players, {
    N: TARGET_COUNT,
    lambda: LAMBDA,
    comboFreq,
    maxOverlap: GAMMA, // Chimera γ=6
    teamCapPct: CHIMERA_TEAM_CAP, // 0.24 — slightly higher than Phoenix
    minPrimaryStack: CHIMERA_MIN_STACK, // 5 — FORCED 5-player primary stack (dispersion driver)
    maxExposure: CHIMERA_MAX_EXPOSURE, // 0.16 hitter cap (24 lineups max per hitter)
    maxExposurePitcher: CHIMERA_MAX_EXPOSURE_P, // 0.41 pitcher cap
    useOwnershipCeiling: false,
    extremeCornerCap: CHIMERA_CORNER, // Chimera: corner cap ON
    binAllocation: CHIMERA_BINS, // 5/5/85/3/2 — value-extreme (same as Phoenix)
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
