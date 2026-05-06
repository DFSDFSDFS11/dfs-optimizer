/**
 * Hermes Pre-Slate — supersedes Cerberus (2026-04-29).
 *
 * HERMES is the parametric synthesis of the d<1.3 Mahalanobis-cluster from 92K-config
 * sweep evaluated against 7-pro slate-relative consensus across 18 slates. NOT a single
 * sweep config — synthesized from cluster modal/median values to avoid config-level
 * overfitting within an otherwise validated archetype.
 *
 * Config: λ=0.58, γ=6, tc=0.20, mps=4, me=0.21, mep=0.45, corner=ON, comboPower=4,
 *         fl=0, bins=[chalk 0.50, core 0.30, value 0.20, contra 0, deep 0]
 *
 * Validation hierarchy (all four gates passed):
 *   1. Multi-pro slate-relative consensus tracking — d=1.24 (top 0.4% closest to pros)
 *   2. 17-slate backtest ROI — +60.0% (within [+50%, +150%] cluster range)
 *   3. LOO within d<1.3 cluster — +60.5%, d<1.4 cluster +22.8% (matches nerdy's +21.6%)
 *   4. Avg ownership percentile — 0.934 (pros: 0.935 — exact match)
 *
 * Why this differs from Cerberus (and is the OPPOSITE direction):
 *   - bins: value-extreme [4.7/0.6/87.3/4.8/2.6] → pure-chalk [50/30/20/0/0]
 *   - λ: 0.421 → 0.58
 *   - mps: 5 (forced 5-stack) → 4 (cluster modal)
 *   - tc: 0.192 → 0.20
 *   - comboPower: 1 → 4
 *
 * The CHALK-CENTRIC direction was counterintuitive but validated: pros target ~88% of
 * optimal projection with avgPlayerOwnPctile=0.94, both pulling toward chalk. Cerberus's
 * value-extreme allocation was structurally OPPOSITE from pro consensus (d=2.33).
 *
 * Cerberus was overfit. Triple confirmation:
 *   - LOO -39.5% on Cerberus archetype (top 50 by full ROI)
 *   - Mahalanobis rank #1131 of 2376 (mid-pack tracking)
 *   - +283% backtest in the noise-overfit zone
 *
 * Deployment plan:
 *   - Ship Hermes 2026-04-29
 *   - Run REDUCED ENTRY SIZE (75 lineups instead of 150) for first 10 live slates
 *   - Expected live ROI range: +15% to +35% (matching pros' realistic edge)
 *   - Scale to full 150 after 10 slates of confirmation
 *   - Reassess at slate 28 (17 + 10 forward)
 *
 * Reads mlbdkprojpre.csv + sspool{1,2,3}pre.csv from DATA_DIR.
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
const MIN_SIM_ROI_PERCENTILE = 0;  // Disabled for Hermes — validation was on unfiltered pool. Filter removes chalky lineups, breaks consensus alignment.
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
const TARGET_COUNT = 75;

// ============ HERMES CONFIG ============
// Parametric synthesis of d<1.3 Mahalanobis-cluster vs 7-pro slate-relative consensus.
// Validated by: multi-pro tracking + backtest ROI + LOO within consensus-aligned subset.
// 17-slate backtest: +60.0% ROI, distance 1.24, ownership pctile 0.934 (matches pros 0.935).
// HERMES-A — actual sweep config (cluster best, not synthesis)
// F:pure-chalk|p4|l0.58|g5|fl0.00|tc0.26|c1|mps4|me0.21|mep0.41
// Mahalanobis d=1.46, KS=0.188, Full17 ROI +136%, OOS5 ROI +186% (matched in/out)
// Beats V1 (synthesis) on distance AND ROI. Step 2 local search confirmed:
// going further from this point loses ROI even when distance improves.
const CERBERUS_LAMBDA   = 0.58;
const CERBERUS_GAMMA    = 5;          // was 6 (V1 synthesis)
const CERBERUS_TEAM_CAP = 0.35;       // 2-game slate override (was 0.26 for main)
const CERBERUS_CORNER   = true;
const CERBERUS_MIN_STACK = 3;         // 2-game slate override (was 4 for main)
const CERBERUS_MAX_EXPOSURE = 0.21;
const CERBERUS_MAX_EXPOSURE_P = 1.00; // 2-game slate override (was 0.41 for main)
const CERBERUS_COMBO_POWER = 4;
const CERBERUS_BINS = { chalk: 0.50, core: 0.30, value: 0.20, contra: 0.00, deep: 0.00 };
// pure-chalk allocation matches pros' chalk-centric construction (avgPlayerOwnPctile 0.94)
// =========================================

const LAMBDA = CERBERUS_LAMBDA;
const GAMMA = CERBERUS_GAMMA;

const OUTPUT_FILE = path.join(DATA_DIR, `production_mlb_preslate_${TARGET_COUNT}.csv`);
const DETAILED_FILE = path.join(DATA_DIR, `production_mlb_preslate_${TARGET_COUNT}_detailed.csv`);

async function main() {
  console.log('================================================================');
  console.log(`HERMES PRE-SLATE — λ=${LAMBDA}, γ=${GAMMA}, teamCap=${CERBERUS_TEAM_CAP}, cornerCap=${CERBERUS_CORNER}, mps=${CERBERUS_MIN_STACK}, N=${TARGET_COUNT}`);
  console.log(`  Bins: ${JSON.stringify(CERBERUS_BINS)}  comboPower=${CERBERUS_COMBO_POWER}  me=${CERBERUS_MAX_EXPOSURE} mep=${CERBERUS_MAX_EXPOSURE_P}`);
  console.log('  ⚠️  REDUCED ENTRY SIZE — run 75 entries (half) for first 10 live slates per Hermes deployment plan.');
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

  // Team-level exclusions (postponed games / weather / etc.)
  const EXCLUDED_TEAMS: string[] = [];
  if (EXCLUDED_TEAMS.length > 0) {
    const teamSet = new Set(EXCLUDED_TEAMS.map(t => t.toUpperCase()));
    const before = candidates.length;
    candidates = candidates.filter(lu => !lu.players.some(p => teamSet.has((p.team || '').toUpperCase())));
    for (const p of pool.players) {
      if (teamSet.has((p.team || '').toUpperCase())) {
        p.projection = 0;
        p.ownership = 0;
      }
    }
    console.log(`  Excluded ${before - candidates.length} lineups containing players from teams: ${EXCLUDED_TEAMS.join(', ')}`);
    console.log(`  Pool after team exclusions: ${candidates.length} lineups\n`);
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

  // 3. Precompute combo frequencies from the merged pool (Cerberus uses power=1)
  console.log(`Precomputing combo frequencies (projection^${CERBERUS_COMBO_POWER} weighted)...`);
  const t0 = Date.now();
  const comboFreq = precomputeComboFrequencies(candidates, CERBERUS_COMBO_POWER);
  console.log(`  ${comboFreq.size} unique combo keys in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // 4. Run production selector
  console.log(`\nRunning production selector...`);
  const t1 = Date.now();
  const result = productionSelect(candidates, pool.players, {
    N: TARGET_COUNT,
    lambda: LAMBDA,
    comboFreq,
    maxOverlap: GAMMA,
    teamCapPct: CERBERUS_TEAM_CAP,
    minPrimaryStack: CERBERUS_MIN_STACK,
    maxExposure: CERBERUS_MAX_EXPOSURE,
    maxExposurePitcher: CERBERUS_MAX_EXPOSURE_P,
    useOwnershipCeiling: false,
    extremeCornerCap: CERBERUS_CORNER,
    binAllocation: CERBERUS_BINS,
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
