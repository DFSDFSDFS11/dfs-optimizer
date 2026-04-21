/**
 * V31 Selector — corrected math (threshold-aware + anchor σ_{δ,G} + tilted projections).
 *
 * Pipeline:
 *   1. precomputeSlate (existing)
 *   2. buildV31Context (three fixes)
 *   3. λ-sweep with 2D grid (lambdaVar × lambdaSigma)
 *   4. Evil twin hedging
 */

import * as fs from 'fs';
import { CLIOptions, ContestConfig, Lineup, Player, PlayerPool } from '../types';
import { parseCSVFile, buildPlayerPool, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';
import {
  precomputeSlate,
  defaultGamma,
  getSportDefaults,
  DEFAULT_SELECTOR_PARAMS,
  SelectorParams,
  SlatePrecomputation,
} from './algorithm7-selector';
import { buildV31Context, V31Context, v31Score } from './v31-objective';
import { applyEvilTwinHedging, DEFAULT_EVIL_TWIN_PARAMS } from './evil-twin';
import { loadOpponentModel } from '../opponent/calibration';
import { generateCalibratedField } from '../opponent/field-generator';
import { exportForDraftKings, exportDetailedLineups } from '../scoring';

// ============================================================
// λ GRID (2D: lambdaVar × lambdaSigma)
// ============================================================

interface LambdaPair { lambdaVar: number; lambdaSigma: number; entries: number; label: string }

function buildLambdaGrid(N: number, isSmallSlate: boolean): LambdaPair[] {
  if (isSmallSlate) {
    return [
      { lambdaVar: 0.2, lambdaSigma: 0.3, entries: Math.round(N * 0.15), label: 'mild' },
      { lambdaVar: 0.5, lambdaSigma: 0.8, entries: Math.round(N * 0.25), label: 'balanced' },
      { lambdaVar: 1.0, lambdaSigma: 1.5, entries: Math.round(N * 0.30), label: 'anti-chalk' },
      { lambdaVar: 1.5, lambdaSigma: 2.5, entries: Math.round(N * 0.30), label: 'contrarian' },
    ];
  }
  return [
    { lambdaVar: 0.2, lambdaSigma: 0.2, entries: Math.round(N * 0.08), label: 'mild' },
    { lambdaVar: 0.4, lambdaSigma: 0.5, entries: Math.round(N * 0.12), label: 'moderate' },
    { lambdaVar: 0.7, lambdaSigma: 1.0, entries: Math.round(N * 0.18), label: 'balanced' },
    { lambdaVar: 1.0, lambdaSigma: 1.5, entries: Math.round(N * 0.22), label: 'anti-chalk' },
    { lambdaVar: 1.5, lambdaSigma: 2.0, entries: Math.round(N * 0.20), label: 'contrarian' },
    { lambdaVar: 2.0, lambdaSigma: 3.0, entries: Math.round(N * 0.20), label: 'extreme' },
  ];
}

// ============================================================
// MAIN
// ============================================================

export async function runV31Select(options: CLIOptions): Promise<void> {
  console.log('================================================================');
  console.log('V31 SELECT — corrected math (threshold-aware + anchor + tilted)');
  console.log('================================================================');

  if (!options.input) { console.error('--input required'); process.exit(1); }
  if (!options.poolCsv) { console.error('--pool-csv required'); process.exit(1); }

  // 1. Parse
  const parseResult = parseCSVFile(options.input, options.sport, true);
  const config = getContestConfig(options.site, options.sport, parseResult.detectedContestType);
  const pool = buildPlayerPool(parseResult.players, parseResult.detectedContestType);

  // 2. Load pools
  const poolPaths = options.poolCsv.split(',').map(s => s.trim());
  let candidatePool: Lineup[] = [];
  const seen = new Set<string>();
  for (const pp of poolPaths) {
    if (!fs.existsSync(pp)) continue;
    const loaded = loadPoolFromCSV({ filePath: pp, config, playerMap: pool.byId });
    for (const l of loaded.lineups) { if (!seen.has(l.hash)) { seen.add(l.hash); candidatePool.push(l); } }
  }
  console.log(`  candidate pool: ${candidatePool.length}`);

  // MLB stack filter
  if (options.sport === 'mlb') {
    const before = candidatePool.length;
    candidatePool = candidatePool.filter(l => {
      const teams = new Map<string, number>();
      for (const p of l.players) if (!p.positions?.includes('P')) teams.set(p.team, (teams.get(p.team) || 0) + 1);
      let max = 0; for (const c of teams.values()) if (c > max) max = c;
      return max >= 4;
    });
    if (candidatePool.length < before) console.log(`  MLB stack filter: removed ${before - candidatePool.length}`);
  }

  // Game count
  const gameSet = new Set<string>();
  for (const p of pool.players) gameSet.add(p.gameInfo || `${p.team}_game`);
  const numGames = gameSet.size;
  const isSmallSlate = numGames <= 4;

  // 3. Field
  let fieldLineups: Lineup[];
  const opModelPath = options.opponentModel;
  if (opModelPath && fs.existsSync(opModelPath)) {
    const model = loadOpponentModel(opModelPath);
    fieldLineups = generateCalibratedField(pool.players, config, 8000, model);
    console.log(`  calibrated field: ${fieldLineups.length}`);
  } else {
    fieldLineups = candidatePool;
    console.log(`  field: using pool (no opponent model)`);
  }

  // 4. Precompute
  const selParams: SelectorParams = {
    ...DEFAULT_SELECTOR_PARAMS, ...getSportDefaults(options.sport),
    N: options.lineupCount, gamma: defaultGamma(config.rosterSize),
    numWorlds: options.worlds ?? 2000,
  };
  console.log(`\n  precomputing worlds (W=${selParams.numWorlds})…`);
  const t0 = Date.now();
  const precomp = precomputeSlate(candidatePool, fieldLineups, pool.players, selParams, options.sport);
  console.log(`  precompute: ${Date.now() - t0}ms (C=${precomp.C} F=${precomp.F})`);

  // 5. Build V31 context (three fixes)
  console.log(`\n  building V31 context…`);
  const ctx = buildV31Context(precomp, fieldLineups, pool.players);

  // 6. λ-sweep with V31 objective
  const N = options.lineupCount;
  const grid = buildLambdaGrid(N, isSmallSlate);
  // Fix rounding
  const totalAlloc = grid.reduce((s, g) => s + g.entries, 0);
  grid[grid.length - 1].entries += N - totalAlloc;

  console.log(`\n  V31 λ-sweep: ${grid.length} (lambdaVar, lambdaSigma) pairs, target=${N}`);

  const C = precomp.C;
  const selected: Lineup[] = [];
  const selectedHashes = new Set<string>();
  const playerCount = new Map<string, number>();
  const maxOverlap = isSmallSlate ? config.rosterSize - 2 : defaultGamma(config.rosterSize);
  const maxExposureCap = Math.ceil((isSmallSlate ? 0.50 : 0.30) * N);
  let overlapRelaxations = 0;
  let currentMaxOverlap = maxOverlap;

  for (const pair of grid) {
    const family: Lineup[] = [];

    // Score all candidates under this (lambdaVar, lambdaSigma)
    const scores = new Float64Array(C);
    for (let c = 0; c < C; c++) {
      scores[c] = v31Score(c, ctx, precomp, pair.lambdaVar, pair.lambdaSigma);
    }
    const sortedIdx = Array.from({ length: C }, (_, i) => i).sort((a, b) => scores[b] - scores[a]);

    for (let j = 0; j < pair.entries; j++) {
      let picked = false;
      for (const cIdx of sortedIdx) {
        const lu = precomp.candidatePool[cIdx];
        if (selectedHashes.has(lu.hash)) continue;
        // Exposure
        let expOk = true;
        for (const p of lu.players) if ((playerCount.get(p.id) || 0) >= maxExposureCap) { expOk = false; break; }
        if (!expOk) continue;
        // Overlap
        let overlapOk = true;
        const cIds = new Set(lu.players.map(p => p.id));
        for (const prev of selected) {
          let shared = 0;
          for (const p of prev.players) if (cIds.has(p.id)) shared++;
          if (shared > currentMaxOverlap) { overlapOk = false; break; }
        }
        if (!overlapOk) continue;

        selected.push(lu);
        family.push(lu);
        selectedHashes.add(lu.hash);
        for (const p of lu.players) playerCount.set(p.id, (playerCount.get(p.id) || 0) + 1);
        picked = true;
        break;
      }
      if (!picked) {
        currentMaxOverlap++;
        overlapRelaxations++;
        j--;
        if (currentMaxOverlap > config.rosterSize) {
          // Carry remainder to next pair
          if (grid.indexOf(pair) < grid.length - 1) grid[grid.indexOf(pair) + 1].entries += pair.entries - family.length;
          break;
        }
      }
    }
    const avgProj = family.length ? family.reduce((s, l) => s + l.projection, 0) / family.length : 0;
    const avgOwn = family.length ? family.reduce((s, l) => s + (l.ownership || 0), 0) / family.length : 0;
    console.log(`    ${pair.label.padEnd(12)} (λv=${pair.lambdaVar} λσ=${pair.lambdaSigma}): ${family.length} entries, proj=${avgProj.toFixed(1)}, own=${avgOwn.toFixed(1)}%`);
  }
  console.log(`  total selected: ${selected.length}/${N} (overlap relaxations: ${overlapRelaxations})`);

  // 7. Evil twin
  console.log(`\n  evil twin hedging…`);
  const twinResult = applyEvilTwinHedging(selected, precomp, DEFAULT_EVIL_TWIN_PARAMS);
  const finalPortfolio = twinResult.portfolio;

  // 8. Diagnostics
  let sumOwn = 0;
  for (const l of finalPortfolio) sumOwn += (l.ownership || 0);
  console.log(`  final portfolio: ${finalPortfolio.length} lineups, avgOwn=${(sumOwn / finalPortfolio.length).toFixed(1)}%`);

  // 9. Export
  exportForDraftKings(finalPortfolio, config, options.output);
  const detailPath = options.output.replace('.csv', '_detailed.csv');
  exportDetailedLineups(finalPortfolio, config, detailPath);

  console.log(`\n================================================================`);
  console.log(`DONE — ${finalPortfolio.length} lineups`);
  console.log(`  • DK upload: ${options.output}`);
  console.log(`  • Detail:    ${detailPath}`);
  console.log(`================================================================`);
}
