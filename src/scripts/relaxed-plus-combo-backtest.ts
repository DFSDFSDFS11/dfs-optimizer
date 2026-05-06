/**
 * Backtest: WIDE stack filter + extended combo leverage (3+ stacks + dualStack keys).
 *
 * Compares three configs across 9 slates:
 *   A. BASELINE: current shipped config (minPrimaryStack=4, original combo keys 4+)
 *      -- expected to match prior baseline since combo-leverage.ts ALREADY changed.
 *   B. WIDE_ONLY: minPrimaryStack=0 + external WIDE filter (top1≥4 OR top1≥3&top2≥2)
 *                  PLUS extended combo leverage (automatic — module was edited)
 *   C. BASELINE with extended combo (retain 4+ filter, run new combo keys)
 *      -- diagnostic: does the new combo scheme change what gets picked on 4+-only pool?
 *
 * Reports shape distribution vs nerdy's 21.5% non-4-stack target.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals } from '../parser';
import { getContestConfig } from '../rules';
import { productionSelect } from '../selection/production-selector';
import { precomputeComboFrequencies } from '../selection/combo-leverage';

const DIR = 'C:/Users/colin/dfs opto';
const FEE = 20;
const N = 150;
const LAMBDA = 0.05;
const GAMMA = 7;

const SLATES = [
  { slate: '4-6-26', proj: '4-6-26_projections.csv', actuals: 'dkactuals 4-6-26.csv', pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26', proj: '4-8-26projections.csv', actuals: '4-8-26actuals.csv', pool: '4-8-26sspool.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv', actuals: '4-12-26actuals.csv', pool: '4-12-26sspool.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv', actuals: '4-14-26actuals.csv', pool: '4-14-26sspool.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv', actuals: '4-15-26actuals.csv', pool: '4-15-26sspool.csv' },
  { slate: '4-17-26', proj: '4-17-26projections.csv', actuals: '4-17-26actuals.csv', pool: '4-17-26sspool.csv' },
  { slate: '4-18-26', proj: '4-18-26projections.csv', actuals: '4-18-26actuals.csv', pool: '4-18-26sspool.csv' },
  { slate: '4-19-26', proj: '4-19-26projections.csv', actuals: '4-19-26actuals.csv', pool: '4-19-26sspool.csv' },
  { slate: '4-20-26', proj: '4-20-26projections.csv', actuals: '4-20-26actuals.csv', pool: '4-20-26sspool.csv' },
];

function norm(n: string): string {
  return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function teamCounts(players: Player[]): number[] {
  const counts = new Map<string, number>();
  for (const p of players) {
    if (p.positions?.includes('P')) continue;
    counts.set(p.team, (counts.get(p.team) || 0) + 1);
  }
  return [...counts.values()].sort((a, b) => b - a);
}

function shapeOf(players: Player[]): string {
  const c = teamCounts(players).filter(n => n >= 2);
  return c.length > 0 ? c.join('-') : 'no-stack';
}

function wideFilter(lu: Lineup): boolean {
  const c = teamCounts(lu.players);
  const top1 = c[0] || 0, top2 = c[1] || 0;
  return top1 >= 4 || (top1 >= 3 && top2 >= 2);
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
) {
  const F = actuals.entries.length;
  const sorted = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
  const top1T = sorted[Math.max(0, Math.floor(F * 0.01) - 1)] || 0;
  let t1 = 0, totalPayout = 0;
  for (const lu of portfolio) {
    const fa = actualByHash.get(lu.hash);
    let a: number | null = fa !== undefined ? fa : null;
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
    let lo = 0, hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sorted[mid] >= a) lo = mid + 1; else hi = mid;
    }
    const rank = Math.max(1, lo);
    if (a >= top1T) t1++;
    const payout = rank <= payoutTable.length ? payoutTable[rank - 1] : 0;
    if (payout > 0) {
      let coWin = 0;
      for (const e of actuals.entries) if (Math.abs(e.actualPoints - a) <= 0.25) coWin++;
      coWin = Math.max(0, coWin - 1);
      totalPayout += payout / Math.sqrt(1 + coWin * 0.5);
    }
  }
  return { t1, totalPayout };
}

function shapeDistribution(portfolio: Lineup[]): { pct4Plus: number; pctNon4: number; topShapes: Array<[string, number]> } {
  let n4 = 0, nNon4 = 0;
  const shapeCounts = new Map<string, number>();
  for (const lu of portfolio) {
    const c = teamCounts(lu.players);
    const top1 = c[0] || 0;
    if (top1 >= 4) n4++; else nNon4++;
    const shape = shapeOf(lu.players);
    shapeCounts.set(shape, (shapeCounts.get(shape) || 0) + 1);
  }
  const topShapes = [...shapeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  return {
    pct4Plus: portfolio.length ? n4 / portfolio.length * 100 : 0,
    pctNon4: portfolio.length ? nNon4 / portfolio.length * 100 : 0,
    topShapes,
  };
}

async function main() {
  console.log('================================================================');
  console.log('WIDE FILTER + EXTENDED COMBO LEVERAGE BACKTEST');
  console.log('================================================================');
  console.log(`  λ=${LAMBDA}, γ=${GAMMA}, N=${N}, nerdy non-4 target=21.5%\n`);

  type Row = {
    slate: string;
    baseT1: number; basePay: number; baseShape: ReturnType<typeof shapeDistribution>;
    wideT1: number; widePay: number; wideShape: ReturnType<typeof shapeDistribution>;
  };
  const rows: Row[] = [];

  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj);
    const actualsPath = path.join(DIR, s.actuals);
    const poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) continue;

    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);
    const F = actuals.entries.length;
    const nameMap = new Map<string, Player>();
    for (const p of pool.players) nameMap.set(norm(p.name), p);
    const idMap = new Map<string, Player>();
    for (const p of pool.players) idMap.set(p.id, p);
    const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
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
    const payoutTable = buildPayoutTable(F);

    // CONFIG A: baseline = minPrimaryStack=4, extended combo keys (combo-leverage.ts module was edited)
    //           this acts as the "new combo system applied to old filter" reference
    const baseComboFreq = precomputeComboFrequencies(loaded.lineups, 3);
    const baseResult = productionSelect(loaded.lineups, pool.players, {
      N, lambda: LAMBDA, comboFreq: baseComboFreq, maxOverlap: GAMMA, minPrimaryStack: 4,
    });
    const baseScored = scorePortfolio(baseResult.portfolio, actuals, actualByHash, payoutTable);
    const baseShape = shapeDistribution(baseResult.portfolio);

    // CONFIG B: WIDE filter + extended combo
    const widePool = loaded.lineups.filter(wideFilter);
    const wideComboFreq = precomputeComboFrequencies(widePool, 3);
    const wideResult = productionSelect(widePool, pool.players, {
      N, lambda: LAMBDA, comboFreq: wideComboFreq, maxOverlap: GAMMA, minPrimaryStack: 0,
    });
    const wideScored = scorePortfolio(wideResult.portfolio, actuals, actualByHash, payoutTable);
    const wideShape = shapeDistribution(wideResult.portfolio);

    rows.push({
      slate: s.slate,
      baseT1: baseScored.t1, basePay: baseScored.totalPayout, baseShape,
      wideT1: wideScored.t1, widePay: wideScored.totalPayout, wideShape,
    });

    console.log(`${s.slate}: F=${F}`);
    console.log(`  BASELINE (4+filter, extended combo):`);
    console.log(`    t1=${baseScored.t1} pay=$${baseScored.totalPayout.toFixed(0).padStart(6)} shape: 4+=${baseShape.pct4Plus.toFixed(0)}% non-4=${baseShape.pctNon4.toFixed(0)}%`);
    console.log(`    top shapes: ${baseShape.topShapes.map(([s, n]) => `${s}=${n}`).join('  ')}`);
    console.log(`  WIDE+extended combo:`);
    console.log(`    t1=${wideScored.t1} pay=$${wideScored.totalPayout.toFixed(0).padStart(6)} shape: 4+=${wideShape.pct4Plus.toFixed(0)}% non-4=${wideShape.pctNon4.toFixed(0)}%`);
    console.log(`    top shapes: ${wideShape.topShapes.map(([s, n]) => `${s}=${n}`).join('  ')}`);
    const d = wideScored.totalPayout - baseScored.totalPayout;
    console.log(`  Δ pay: ${d >= 0 ? '+$' : '-$'}${Math.abs(d).toFixed(0)}  Δ t1: ${wideScored.t1 - baseScored.t1}`);
  }

  // SUMMARY
  console.log('\n================================================================');
  console.log('SUMMARY');
  console.log('================================================================\n');

  let baseT = 0, wideT = 0, baseT1 = 0, wideT1 = 0;
  let basePct = 0, widePct = 0;
  for (const r of rows) {
    baseT += r.basePay; wideT += r.widePay;
    baseT1 += r.baseT1; wideT1 += r.wideT1;
    basePct += r.baseShape.pctNon4;
    widePct += r.wideShape.pctNon4;
  }
  const fees = FEE * N * rows.length;
  const nSlates = rows.length;
  console.log(`BASELINE (4+ filter):         $${baseT.toFixed(0)}  t1=${baseT1}  ROI=${((baseT / fees - 1) * 100).toFixed(1)}%  avg non-4=${(basePct / nSlates).toFixed(1)}%`);
  console.log(`WIDE + extended combo:        $${wideT.toFixed(0)}  t1=${wideT1}  ROI=${((wideT / fees - 1) * 100).toFixed(1)}%  avg non-4=${(widePct / nSlates).toFixed(1)}%`);
  console.log(`Δ:                            ${wideT >= baseT ? '+$' : '-$'}${Math.abs(wideT - baseT).toFixed(0)}  (${wideT1 - baseT1} hits)`);
  console.log(`Nerdy target non-4%:          21.5%`);
  console.log(`Shape convergence:            ${Math.abs(widePct / nSlates - 21.5).toFixed(1)}pp from target (prior RELAXED result: ~16.5pp gap)`);
}

main().catch(e => { console.error(e); process.exit(1); });
