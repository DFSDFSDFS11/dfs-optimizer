/**
 * MLB Comprehensive Selector Sweep — 12 slates, all runnable selectors.
 *
 * Goal: Colin has been bleeding on MLB for the last 4-5 slates. Find out if
 * any selector beats current production on recent slates + full-sample.
 *
 * Scope: tier-1 pure selectors + production parametric variants + precomp-based
 * architectures (algorithm7, v24, v33, v34, emax, hedging, parimutuel, scenario,
 * lambdaSweep). Shared precomp per slate to save time.
 *
 * Output: JSON (one row per selector × slate) + markdown summary.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import {
  parseCSVFile,
  buildPlayerPool,
  parseContestActuals,
  loadPoolFromCSV,
  ContestActuals,
} from '../parser';
import { getContestConfig } from '../rules';

// Pure / wrapper selectors
import {
  productionSelect,
  DEFAULT_PRODUCTION_CONFIG,
} from '../selection/production-selector';
import { precomputeComboFrequencies } from '../selection/combo-leverage';

// Precomp-based selectors
import {
  DEFAULT_SELECTOR_PARAMS,
  SelectorParams,
  defaultGamma,
  getSportDefaults,
  precomputeSlate,
  algorithm7Select,
} from '../selection/algorithm7-selector';
import { v24Select, buildV24Params } from '../selection/v24-selector';
import { v33DiscountedSelect } from '../selection/v33-discounted';
import { v34Select } from '../selection/v34-selector';
import { emaxSelect, buildEmaxParams } from '../selection/emax-selector';
import { hedgingSelect, buildHedgingParams } from '../selection/hedging-selector';
import {
  buildParimutuelPrecomp,
  parimutuelGreedySelect,
} from '../selection/parimutuel-ev';
import {
  computeScenarioCoverage,
  computeScenarioScores,
  scenarioGreedySelect,
} from '../selection/scenario-scoring';
import {
  lambdaSweepSelect,
  LambdaSweepParams,
} from '../selection/lambda-sweep';

const DIR = 'C:/Users/colin/dfs opto';
const OUT_JSON = path.join(DIR, 'mlb_comprehensive_sweep.json');
const OUT_MD = path.join(DIR, 'mlb_comprehensive_sweep.md');
const FEE = 20;
const N = 150;

const SLATES = [
  { slate: '4-6-26',  proj: '4-6-26_projections.csv', actuals: 'dkactuals 4-6-26.csv', pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26',  proj: '4-8-26projections.csv',  actuals: '4-8-26actuals.csv',    pool: '4-8-26sspool.csv' },
  { slate: '4-11-26', proj: '4-11-26projections.csv', actuals: '4-11-26actuals.csv',   pool: '4-11-26sspool.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv', actuals: '4-12-26actuals.csv',   pool: '4-12-26sspool.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv', actuals: '4-14-26actuals.csv',   pool: '4-14-26sspool.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv', actuals: '4-15-26actuals.csv',   pool: '4-15-26sspool.csv' },
  { slate: '4-17-26', proj: '4-17-26projections.csv', actuals: '4-17-26actuals.csv',   pool: '4-17-26sspool.csv' },
  { slate: '4-18-26', proj: '4-18-26projections.csv', actuals: '4-18-26actuals.csv',   pool: '4-18-26sspool.csv' },
  { slate: '4-19-26', proj: '4-19-26projections.csv', actuals: '4-19-26actuals.csv',   pool: '4-19-26sspool.csv' },
  { slate: '4-20-26', proj: '4-20-26projections.csv', actuals: '4-20-26actuals.csv',   pool: '4-20-26sspool.csv' },
  { slate: '4-21-26', proj: '4-21-26projections.csv', actuals: '4-21-26actuals.csv',   pool: '4-21-26sspool.csv' },
  { slate: '4-22-26', proj: '4-22-26projections.csv', actuals: '4-22-26actuals.csv',   pool: '4-22-26sspool.csv' },
];

// Last 5 slates for focused recent-slate analysis
const RECENT_SLATES = new Set(['4-18-26', '4-19-26', '4-20-26', '4-21-26', '4-22-26']);

function norm(n: string): string {
  return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildPayoutTable(F: number): Float64Array {
  const pool = F * FEE * 0.88;
  const cashLine = Math.floor(F * 0.22);
  const raw = new Float64Array(cashLine);
  let rawSum = 0;
  for (let r = 0; r < cashLine; r++) { raw[r] = Math.pow(r + 1, -1.15); rawSum += raw[r]; }
  const table = new Float64Array(F);
  const minCash = FEE * 1.2;
  for (let r = 0; r < cashLine; r++) table[r] = Math.max(minCash, (raw[r] / rawSum) * pool);
  let tSum = 0;
  for (let r = 0; r < cashLine; r++) tSum += table[r];
  const scale = pool / tSum;
  for (let r = 0; r < cashLine; r++) table[r] *= scale;
  return table;
}

function scorePortfolio(
  portfolio: Lineup[],
  actuals: ContestActuals,
  actualByHash: Map<string, number>,
  payoutTable: Float64Array,
  sortedScores: number[],
  top1Thresh: number,
) {
  let t1 = 0, totalPayout = 0, scored = 0;
  for (const lu of portfolio) {
    const h = lu.players.map(p => p.id).sort().join('|');
    let a: number | null = actualByHash.get(h) ?? null;
    if (a === null) {
      let t = 0, miss = false;
      for (const p of lu.players) {
        const r = actuals.playerActualsByName.get(norm(p.name));
        if (!r) { miss = true; break; }
        t += r.fpts;
      }
      if (!miss) a = t;
    }
    if (a === null) continue;
    scored++;
    let lo = 0, hi = sortedScores.length;
    while (lo < hi) { const m = (lo + hi) >>> 1; if (sortedScores[m] >= a) lo = m + 1; else hi = m; }
    const rank = Math.max(1, lo);
    if (a >= top1Thresh) t1++;
    const pay = rank <= payoutTable.length ? payoutTable[rank - 1] : 0;
    if (pay > 0) {
      let co = 0;
      for (const e of actuals.entries) if (Math.abs(e.actualPoints - a) <= 0.25) co++;
      co = Math.max(0, co - 1);
      totalPayout += pay / Math.sqrt(1 + co * 0.5);
    }
  }
  return { t1, totalPayout, scored };
}

interface SlateData {
  slate: string;
  F: number;
  actuals: ContestActuals;
  actualByHash: Map<string, number>;
  payoutTable: Float64Array;
  sorted: number[];
  top1Thresh: number;
  pool: Lineup[];                 // SaberSim pool (sspool) — used by production-family
  players: Player[];
  fieldLineups: Lineup[];         // actual contest entries for precomp Mode 2
  selParams: SelectorParams;
  precomp: ReturnType<typeof precomputeSlate>;
  comboFreq: Map<string, number>;
}

async function loadSlate(s: typeof SLATES[0]): Promise<SlateData | null> {
  const projPath = path.join(DIR, s.proj);
  const actualsPath = path.join(DIR, s.actuals);
  const poolPath = path.join(DIR, s.pool);
  if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) return null;

  const pr = parseCSVFile(projPath, 'mlb', true);
  const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
  const pool = buildPlayerPool(pr.players, pr.detectedContestType);
  const actuals = parseContestActuals(actualsPath, config);
  const nameMap = new Map<string, Player>();
  for (const p of pool.players) nameMap.set(norm(p.name), p);
  const idMap = new Map<string, Player>();
  for (const p of pool.players) idMap.set(p.id, p);
  const F = actuals.entries.length;
  const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });

  // Actual-score lookup by lineup hash
  const actualByHash = new Map<string, number>();
  for (const e of actuals.entries) {
    const pls: Player[] = [];
    let ok = true;
    for (const nm of e.playerNames) {
      const p = nameMap.get(norm(nm));
      if (!p) { ok = false; break; }
      pls.push(p);
    }
    if (!ok) continue;
    actualByHash.set(pls.map(p => p.id).sort().join('|'), e.actualPoints);
  }

  // Build field lineups (actual entries) for precomp Mode 2
  const fieldLineups: Lineup[] = [];
  const seenH = new Set<string>();
  for (const e of actuals.entries) {
    const pls: Player[] = [];
    let ok = true;
    for (const nm of e.playerNames) {
      const p = nameMap.get(norm(nm));
      if (!p) { ok = false; break; }
      pls.push(p);
    }
    if (!ok) continue;
    const hash = pls.map(p => p.id).sort().join('|');
    if (seenH.has(hash)) continue;
    seenH.add(hash);
    const sal = pls.reduce((s, p) => s + p.salary, 0);
    const proj = pls.reduce((s, p) => s + p.projection, 0);
    const own = pls.reduce((s, p) => s + (p.ownership || 0), 0) / pls.length;
    fieldLineups.push({ players: pls, salary: sal, projection: proj, ownership: own, hash });
  }

  const sorted = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
  const top1Thresh = sorted[Math.max(0, Math.floor(F * 0.01) - 1)] || 0;
  const payoutTable = buildPayoutTable(F);

  const selParams: SelectorParams = {
    ...DEFAULT_SELECTOR_PARAMS,
    ...getSportDefaults('mlb'),
    N,
    gamma: defaultGamma(config.rosterSize),
    numWorlds: 1500,
  };

  console.log(`  precomp (pool=${loaded.lineups.length} field=${fieldLineups.length})...`);
  const precomp = precomputeSlate(loaded.lineups, fieldLineups.length >= 100 ? fieldLineups : loaded.lineups, pool.players, selParams, 'mlb');
  const comboFreq = precomputeComboFrequencies(loaded.lineups, 3);

  return {
    slate: s.slate, F, actuals, actualByHash, payoutTable, sorted, top1Thresh,
    pool: loaded.lineups, players: pool.players, fieldLineups,
    selParams, precomp, comboFreq,
  };
}

// ============================================================
// SELECTOR REGISTRY — each returns Lineup[] given SlateData
// ============================================================

interface SelectorEntry {
  id: string;
  family: string;
  desc: string;
  run: (sd: SlateData) => Lineup[];
}

const REGISTRY: SelectorEntry[] = [
  // ---- Production family ----
  {
    id: 'prod-shipped', family: 'production', desc: 'λ=0.05, γ=7, minPrimaryStack=4 (current MLB shipped)',
    run: (sd) => productionSelect(sd.pool, sd.players, { N, lambda: 0.05, comboFreq: sd.comboFreq, maxOverlap: 7 }).portfolio,
  },
  {
    id: 'prod-baseline', family: 'production', desc: 'λ=0, γ=off (10), minPrimaryStack=4',
    run: (sd) => productionSelect(sd.pool, sd.players, { N, lambda: 0, maxOverlap: 10 }).portfolio,
  },
  {
    id: 'prod-γ6', family: 'production', desc: 'λ=0.05, γ=6 (tighter overlap)',
    run: (sd) => productionSelect(sd.pool, sd.players, { N, lambda: 0.05, comboFreq: sd.comboFreq, maxOverlap: 6 }).portfolio,
  },
  {
    id: 'prod-γ8', family: 'production', desc: 'λ=0.05, γ=8 (looser overlap)',
    run: (sd) => productionSelect(sd.pool, sd.players, { N, lambda: 0.05, comboFreq: sd.comboFreq, maxOverlap: 8 }).portfolio,
  },
  {
    id: 'prod-γoff', family: 'production', desc: 'λ=0.05, γ=10 (overlap off)',
    run: (sd) => productionSelect(sd.pool, sd.players, { N, lambda: 0.05, comboFreq: sd.comboFreq, maxOverlap: 10 }).portfolio,
  },
  {
    id: 'prod-λ0', family: 'production', desc: 'λ=0, γ=7 (no combo leverage)',
    run: (sd) => productionSelect(sd.pool, sd.players, { N, lambda: 0, maxOverlap: 7 }).portfolio,
  },
  {
    id: 'prod-λ0.10', family: 'production', desc: 'λ=0.10, γ=7 (stronger combo leverage)',
    run: (sd) => productionSelect(sd.pool, sd.players, { N, lambda: 0.10, comboFreq: sd.comboFreq, maxOverlap: 7 }).portfolio,
  },
  {
    id: 'prod-λ0.20', family: 'production', desc: 'λ=0.20, γ=7',
    run: (sd) => productionSelect(sd.pool, sd.players, { N, lambda: 0.20, comboFreq: sd.comboFreq, maxOverlap: 7 }).portfolio,
  },
  {
    id: 'prod-projFloor94', family: 'production', desc: 'shipped + 94% proj floor',
    run: (sd) => productionSelect(sd.pool, sd.players, { N, lambda: 0.05, comboFreq: sd.comboFreq, maxOverlap: 7, projectionFloorPct: 0.94 }).portfolio,
  },
  {
    id: 'prod-projFloor90', family: 'production', desc: 'shipped + 90% proj floor',
    run: (sd) => productionSelect(sd.pool, sd.players, { N, lambda: 0.05, comboFreq: sd.comboFreq, maxOverlap: 7, projectionFloorPct: 0.90 }).portfolio,
  },
  {
    id: 'prod-noChalk', family: 'production', desc: 'redistribute chalk bin → 0/33.3/38.9/22.2/5.6',
    run: (sd) => productionSelect(sd.pool, sd.players, {
      N, lambda: 0.05, comboFreq: sd.comboFreq, maxOverlap: 7,
      binAllocation: { chalk: 0, core: 0.333, value: 0.389, contra: 0.222, deep: 0.056 },
    }).portfolio,
  },
  {
    id: 'prod-teamCap15', family: 'production', desc: 'shipped + 15% team cap (4-game style)',
    run: (sd) => productionSelect(sd.pool, sd.players, { N, lambda: 0.05, comboFreq: sd.comboFreq, maxOverlap: 7, teamCapPct: 0.15 }).portfolio,
  },
  {
    id: 'prod-extremeCorner', family: 'production', desc: 'shipped + extreme-corner cap',
    run: (sd) => productionSelect(sd.pool, sd.players, { N, lambda: 0.05, comboFreq: sd.comboFreq, maxOverlap: 7, extremeCornerCap: true }).portfolio,
  },

  // ---- Precomp-based architectures ----
  {
    id: 'algorithm7', family: 'precomp', desc: 'Haugh-Singal × Liu (σ_{δ,G} + λ-sweep + γ overlap)',
    run: (sd) => algorithm7Select(sd.precomp, sd.selParams).selected,
  },
  {
    id: 'v24', family: 'precomp', desc: 'Hunter U² (inclusion-exclusion, multi-tier)',
    run: (sd) => v24Select(sd.precomp, sd.selParams, buildV24Params('mlb')).selected,
  },
  {
    id: 'v33-discounted', family: 'precomp', desc: 'V33 duplicate-discounted (Haugh-Singal variant)',
    run: (sd) => v33DiscountedSelect(sd.precomp, N, {
      maxExposure: DEFAULT_PRODUCTION_CONFIG.maxExposure,
      maxPerTeam: Math.ceil(DEFAULT_PRODUCTION_CONFIG.teamCapPct * N),
      fieldForDuplication: sd.fieldLineups.length >= 100 ? sd.fieldLineups : sd.pool,
    }),
  },
  {
    id: 'v34-construction', family: 'precomp', desc: 'V34 construction-dupes penalty',
    run: (sd) => v34Select(
      sd.precomp,
      sd.fieldLineups.length >= 100 ? sd.fieldLineups : sd.pool,
      N,
      DEFAULT_PRODUCTION_CONFIG.maxExposure,
      Math.ceil(DEFAULT_PRODUCTION_CONFIG.teamCapPct * N),
    ),
  },
  {
    id: 'emax', family: 'precomp', desc: 'Liu-Teo E[max] sequential optimization',
    run: (sd) => emaxSelect(sd.precomp, sd.selParams, buildEmaxParams('mlb')).selected,
  },
  {
    id: 'hedging', family: 'precomp', desc: 'Hedging selector (variance floor + covariance)',
    run: (sd) => hedgingSelect(sd.precomp, sd.selParams, buildHedgingParams('mlb')).selected,
  },
  {
    id: 'parimutuel', family: 'precomp', desc: 'Parimutuel EV (marginal expected-value greedy)',
    run: (sd) => {
      const ppc = buildParimutuelPrecomp(sd.precomp, sd.fieldLineups.length >= 100 ? sd.fieldLineups : sd.pool, sd.F, FEE);
      return parimutuelGreedySelect(
        sd.precomp, ppc, N,
        DEFAULT_PRODUCTION_CONFIG.maxExposure,
        Math.ceil(DEFAULT_PRODUCTION_CONFIG.teamCapPct * N),
        sd.F, FEE,
      );
    },
  },
  {
    id: 'scenario-greedy', family: 'precomp', desc: 'Scenario coverage (stack-scenario hit frequency)',
    run: (sd) => {
      const field = sd.fieldLineups.length >= 100 ? sd.fieldLineups : sd.pool;
      const cov = computeScenarioCoverage(field);
      const scores = computeScenarioScores(sd.precomp, cov);
      return scenarioGreedySelect(
        sd.precomp, scores, field, N,
        DEFAULT_PRODUCTION_CONFIG.maxExposure,
        Math.ceil(DEFAULT_PRODUCTION_CONFIG.teamCapPct * N),
      );
    },
  },
  {
    id: 'lambdaSweep', family: 'precomp', desc: 'Pure λ-sweep Haugh-Singal (stratified λ buckets)',
    run: (sd) => {
      const p: LambdaSweepParams = {
        lambdaGrid: [0.3, 0.6, 1.0, 1.5, 2.2, 3.0],
        entriesPerLambda: [15, 20, 25, 30, 30, 30],
        maxOverlap: sd.selParams.gamma,
        maxExposure: DEFAULT_PRODUCTION_CONFIG.maxExposure,
      };
      return lambdaSweepSelect(sd.precomp, p).selected;
    },
  },
];

// ============================================================
// MAIN
// ============================================================

interface RunResult {
  selector: string;
  family: string;
  slate: string;
  t1: number;
  payout: number;
  scored: number;
  runtimeMs: number;
  error?: string;
}

async function main() {
  console.log('================================================================');
  console.log(`MLB COMPREHENSIVE SELECTOR SWEEP — ${REGISTRY.length} selectors × ${SLATES.length} slates`);
  console.log('================================================================\n');

  const allResults: RunResult[] = [];

  for (let si = 0; si < SLATES.length; si++) {
    const s = SLATES[si];
    console.log(`\n[${si + 1}/${SLATES.length}] === ${s.slate} ===`);
    let sd: SlateData | null = null;
    try {
      sd = await loadSlate(s);
    } catch (e: any) {
      console.log(`  SKIP — load error: ${e.message || String(e)}`);
      continue;
    }
    if (!sd) { console.log('  SKIP — missing files'); continue; }

    for (const entry of REGISTRY) {
      const t0 = Date.now();
      let portfolio: Lineup[] = [];
      let err: string | undefined;
      try {
        portfolio = entry.run(sd);
      } catch (e: any) {
        err = e.message || String(e);
      }
      const dt = Date.now() - t0;
      let t1 = 0, payout = 0, scored = 0;
      if (!err && portfolio.length > 0) {
        const r = scorePortfolio(portfolio, sd.actuals, sd.actualByHash, sd.payoutTable, sd.sorted, sd.top1Thresh);
        t1 = r.t1; payout = r.totalPayout; scored = r.scored;
      }
      const rr: RunResult = {
        selector: entry.id, family: entry.family, slate: s.slate,
        t1, payout, scored, runtimeMs: dt, error: err,
      };
      allResults.push(rr);
      const statusStr = err ? `ERR: ${err.slice(0, 40)}` : `t1=${t1} pay=$${payout.toFixed(0).padStart(6)} scored=${scored}`;
      console.log(`  ${entry.id.padEnd(20)} ${statusStr}  [${(dt / 1000).toFixed(1)}s]`);
    }

    // Persist progress per slate
    fs.writeFileSync(OUT_JSON, JSON.stringify(allResults, null, 2));
  }

  // ============================================================
  // SUMMARY ANALYSIS
  // ============================================================

  const bySelector = new Map<string, RunResult[]>();
  for (const r of allResults) {
    if (!bySelector.has(r.selector)) bySelector.set(r.selector, []);
    bySelector.get(r.selector)!.push(r);
  }

  interface Summary {
    selector: string;
    family: string;
    desc: string;
    totalPay: number;
    totalT1: number;
    nSlates: number;
    meanPay: number;
    medianPay: number;
    stdPay: number;
    recentPay: number;    // sum for RECENT_SLATES
    recentT1: number;
    recentN: number;
    profitableSlates: number;
    totalRuntimeMs: number;
    errors: number;
  }

  const summaries: Summary[] = [];
  for (const entry of REGISTRY) {
    const rs = bySelector.get(entry.id) || [];
    const pays = rs.filter(r => !r.error).map(r => r.payout);
    const totalPay = pays.reduce((a, b) => a + b, 0);
    const totalT1 = rs.reduce((a, r) => a + r.t1, 0);
    const errCount = rs.filter(r => r.error).length;
    const nSlates = rs.length - errCount;
    const sortedP = [...pays].sort((a, b) => a - b);
    const median = sortedP.length ? sortedP[Math.floor(sortedP.length / 2)] : 0;
    const mean = nSlates ? totalPay / nSlates : 0;
    const variance = nSlates ? pays.reduce((a, p) => a + (p - mean) ** 2, 0) / nSlates : 0;
    const std = Math.sqrt(variance);
    const recent = rs.filter(r => RECENT_SLATES.has(r.slate) && !r.error);
    const recentPay = recent.reduce((a, r) => a + r.payout, 0);
    const recentT1 = recent.reduce((a, r) => a + r.t1, 0);
    const profitable = rs.filter(r => !r.error && r.payout > FEE * N).length;
    const totalRuntime = rs.reduce((a, r) => a + r.runtimeMs, 0);
    summaries.push({
      selector: entry.id, family: entry.family, desc: entry.desc,
      totalPay, totalT1, nSlates, meanPay: mean, medianPay: median, stdPay: std,
      recentPay, recentT1, recentN: recent.length,
      profitableSlates: profitable, totalRuntimeMs: totalRuntime, errors: errCount,
    });
  }

  // Sort by total payout desc
  summaries.sort((a, b) => b.totalPay - a.totalPay);

  // ============================================================
  // PRINT SUMMARY
  // ============================================================
  console.log('\n\n================================================================');
  console.log('FULL-SAMPLE RANKING (all 12 slates)');
  console.log('================================================================\n');
  console.log('Rank | Selector              | Family     | Total    | Mean/slate | Median  | Profit? | t1  | Errors');
  console.log('-----|-----------------------|------------|----------|------------|---------|---------|-----|-------');
  for (let i = 0; i < summaries.length; i++) {
    const s = summaries[i];
    console.log(
      `  ${(i + 1).toString().padStart(2)} | ${s.selector.padEnd(21)} | ${s.family.padEnd(10)} | $${s.totalPay.toFixed(0).padStart(7)} | $${s.meanPay.toFixed(0).padStart(9)} | $${s.medianPay.toFixed(0).padStart(6)} | ${s.profitableSlates.toString().padStart(2)}/${s.nSlates.toString().padEnd(2)}   | ${s.totalT1.toString().padStart(3)} | ${s.errors}`
    );
  }

  console.log('\n\n================================================================');
  console.log(`RECENT-SLATES RANKING (last 5: ${[...RECENT_SLATES].sort().join(', ')})`);
  console.log('================================================================\n');
  const recentSummaries = [...summaries].sort((a, b) => b.recentPay - a.recentPay);
  console.log('Rank | Selector              | RecentPay | t1 | vs shipped');
  console.log('-----|-----------------------|-----------|----|----------');
  const shippedRecent = summaries.find(s => s.selector === 'prod-shipped')?.recentPay ?? 0;
  for (let i = 0; i < recentSummaries.length; i++) {
    const s = recentSummaries[i];
    const d = s.recentPay - shippedRecent;
    console.log(
      `  ${(i + 1).toString().padStart(2)} | ${s.selector.padEnd(21)} | $${s.recentPay.toFixed(0).padStart(7)} | ${s.recentT1.toString().padStart(2)} | ${d >= 0 ? '+' : ''}$${d.toFixed(0)}`
    );
  }

  // Per-slate heatmap (markdown)
  let md = `# MLB Comprehensive Selector Sweep\n\n`;
  md += `12 MLB slates × ${REGISTRY.length} selectors. Shared precomp per slate.\n\n`;
  md += `## Full-sample ranking\n\n`;
  md += `| Rank | Selector | Family | Total | Mean | Median | Profit slates | t1 | Errors |\n`;
  md += `|---:|---|---|---:|---:|---:|---:|---:|---:|\n`;
  for (let i = 0; i < summaries.length; i++) {
    const s = summaries[i];
    md += `| ${i + 1} | \`${s.selector}\` | ${s.family} | $${s.totalPay.toFixed(0)} | $${s.meanPay.toFixed(0)} | $${s.medianPay.toFixed(0)} | ${s.profitableSlates}/${s.nSlates} | ${s.totalT1} | ${s.errors} |\n`;
  }

  md += `\n## Recent slates (${[...RECENT_SLATES].sort().join(', ')})\n\n`;
  md += `| Rank | Selector | Recent Pay | t1 | vs shipped |\n`;
  md += `|---:|---|---:|---:|---:|\n`;
  for (let i = 0; i < recentSummaries.length; i++) {
    const s = recentSummaries[i];
    const d = s.recentPay - shippedRecent;
    md += `| ${i + 1} | \`${s.selector}\` | $${s.recentPay.toFixed(0)} | ${s.recentT1} | ${d >= 0 ? '+' : ''}$${d.toFixed(0)} |\n`;
  }

  // Per-slate heatmap
  md += `\n## Per-slate heatmap (payout per selector per slate)\n\n`;
  md += `| Selector |`;
  for (const s of SLATES) md += ` ${s.slate} |`;
  md += ` TOTAL |\n`;
  md += `|---|`;
  for (const _ of SLATES) md += `---:|`;
  md += `---:|\n`;
  for (const entry of summaries) {
    const row = bySelector.get(entry.selector) || [];
    md += `| \`${entry.selector}\` |`;
    for (const s of SLATES) {
      const r = row.find(x => x.slate === s.slate);
      md += ` ${r && !r.error ? '$' + r.payout.toFixed(0) : '—'} |`;
    }
    md += ` **$${entry.totalPay.toFixed(0)}** |\n`;
  }

  fs.writeFileSync(OUT_MD, md);
  console.log(`\n\nJSON:     ${OUT_JSON}`);
  console.log(`Markdown: ${OUT_MD}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
