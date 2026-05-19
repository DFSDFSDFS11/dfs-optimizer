/**
 * Pegasus-NBA Pre-Slate — DraftKings Classic. Supersedes Kraken-NBA (2026-04-28).
 *
 * Pegasus is the broad-edge NBA winner from the 5K-pool sweep — wins on profitable
 * count + median slate pay across all slates simultaneously. Where Kraken's prior
 * "edge" was a single-slate (2026-03-03) lottery from the narrow 500-pool, Pegasus
 * shows real distributed signal: 6/12 profitable slates with $3,478 median pay
 * (vs Kraken's 1/12, ~$200 median).
 *
 * Config:
 *   - λ=0.05 (very low covariance penalty — almost pure value-chasing)
 *   - γ=5 overlap (tighter than Kraken's 6)
 *   - teamCapPct=0.16 (cosmetic on NBA but tighter)
 *   - minPrimaryStack=2 (sensible NBA mini-stack — 2-player team coupling)
 *   - extremeCornerCap=true (re-enabled — sweep showed value)
 *   - maxExposure=0.21 (tighter than Kraken's 0.30)
 *   - binAllocation 13.7/18.9/6.0/15.2/46.3 (deep-heavy spread, not chalk-extreme)
 *   - projectionFloorPct=0.85 (NBA safety rail mandate — overrides sweep's 0.76)
 *
 * Head-to-head on 12 NBA slates with 5K-sampled actuals pools:
 *   Kraken-NBA  | $12,932  | -64.1% ROI | 1/12 profitable slates
 *   Pegasus-NBA | $65,190  | +81.1% ROI | 6/12 profitable slates
 *   Differential: +145pp ROI, +5 profitable slates, +17× median pay.
 *
 * Caveat: 12 slates < 30-slate ship threshold per parameter-decision-hierarchy memo.
 * Pool measurement is contest-actuals, not production MC pool — differential is
 * apples-to-apples but absolute may not transfer.
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
const PROJ_FILE = 'nbaprojpre.csv';
const POOL_FILES = ['ssnbapool.csv', 'ssnbapool2.csv'];
const TARGET_COUNT = process.env.NBA_TARGET_COUNT ? parseInt(process.env.NBA_TARGET_COUNT, 10) : 50;

// ============ PEGASUS-NBA CONFIG ============
// 5K-pool sweep winner: most profitable slates (6/12) + best median slate pay.
// Beats Kraken-NBA by +145pp ROI on the same 12 slates / 5K-sampled actuals pools.
const PEGASUS_NBA_LAMBDA    = 0.05;
const PEGASUS_NBA_GAMMA     = 5;
const PEGASUS_NBA_TEAM_CAP  = 0.16;       // tighter; cosmetic on NBA
const PEGASUS_NBA_MIN_STACK = 2;          // NBA mini-stack — 2-player team coupling
const PEGASUS_NBA_MAX_EXPOSURE = process.env.NBA_MAX_EXPOSURE ? parseFloat(process.env.NBA_MAX_EXPOSURE) : 0.35;
const PEGASUS_NBA_CORNER    = true;
const PEGASUS_NBA_PROJ_FLOOR = 0.76;      // sweep value — 0.85 mandate breaks bin fill given deep-heavy allocation
const PEGASUS_NBA_COMBO_POWER = 2;
// Production-pool-adjusted bins: original sweep had 14/19/6/15/46 but production MC
// pools have very few "deep" (bottom-quintile projection) candidates on small NBA slates.
// Redistribute deep → value while keeping the contrarian-spread spirit.
const PEGASUS_NBA_BINS = { chalk: 0.14, core: 0.19, value: 0.30, contra: 0.15, deep: 0.22 };
// =============================================

const GAMMA = PEGASUS_NBA_GAMMA;

const OUTPUT_FILE = path.join(DATA_DIR, `production_nba_preslate_${TARGET_COUNT}.csv`);
const DETAILED_FILE = path.join(DATA_DIR, `production_nba_preslate_${TARGET_COUNT}_detailed.csv`);

async function main() {
  console.log('================================================================');
  console.log(`PEGASUS-NBA PRE-SLATE — λ=${PEGASUS_NBA_LAMBDA}, γ=${GAMMA}, floor=${PEGASUS_NBA_PROJ_FLOOR}, mps=${PEGASUS_NBA_MIN_STACK}, N=${TARGET_COUNT}`);
  console.log(`  Bins: ${JSON.stringify(PEGASUS_NBA_BINS)}  comboPower=${PEGASUS_NBA_COMBO_POWER}  me=${PEGASUS_NBA_MAX_EXPOSURE}  corner=${PEGASUS_NBA_CORNER}`);
  console.log('================================================================\n');

  const projPath = path.join(DATA_DIR, PROJ_FILE);
  console.log(`Loading projections: ${projPath}`);
  const pr = parseCSVFile(projPath, 'nba', true);
  const config = getContestConfig('dk', 'nba', pr.detectedContestType);
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

  // Precompute combo frequencies for combo-leverage scoring (λ > 0)
  console.log(`Precomputing combo frequencies (projection^${PEGASUS_NBA_COMBO_POWER} weighted)...`);
  const cfStart = Date.now();
  const comboFreq = precomputeComboFrequencies(candidates, PEGASUS_NBA_COMBO_POWER);
  console.log(`  ${comboFreq.size} unique combo keys in ${((Date.now() - cfStart) / 1000).toFixed(1)}s`);

  console.log(`\nRunning Pegasus-NBA selector...`);
  const t1 = Date.now();
  const result = productionSelect(candidates, pool.players, {
    N: TARGET_COUNT,
    lambda: PEGASUS_NBA_LAMBDA,
    comboFreq,
    maxOverlap: GAMMA,
    teamCapPct: PEGASUS_NBA_TEAM_CAP,
    maxExposure: PEGASUS_NBA_MAX_EXPOSURE,
    minPrimaryStack: PEGASUS_NBA_MIN_STACK,
    extremeCornerCap: PEGASUS_NBA_CORNER,
    projectionFloorPct: PEGASUS_NBA_PROJ_FLOOR,
    binAllocation: PEGASUS_NBA_BINS,
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

  // Player exposures
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
  console.log(`\n  Top 20 player exposures:`);
  for (const v of sortedExp.slice(0, 20)) {
    console.log(`    ${v.name.padEnd(25)} ${v.team.padEnd(5)} ${v.pos.padEnd(4)} ${((v.count / result.portfolio.length) * 100).toFixed(1).padStart(5)}% (${v.count}/${result.portfolio.length})  own=${v.own.toFixed(1)}%  proj=${v.proj.toFixed(1)}`);
  }
  console.log(`\n  Unique players: ${playerExp.size}`);

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
  console.error('NBA pre-slate failed:', err);
  process.exit(1);
});
