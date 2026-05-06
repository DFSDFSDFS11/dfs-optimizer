/**
 * Backtest: extreme-corner cap.
 *
 * Compares shipped config (λ=0.05, γ=7) with and without extreme-corner cap
 * on Q5-proj/Q5-own and Q1-proj/Q1-own cells.
 *
 * Reports per-slate payout and 2D cell distribution.
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

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }

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

function scorePortfolio(portfolio: Lineup[], actuals: ContestActuals, actualByHash: Map<string, number>, payoutTable: Float64Array) {
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

function cornerCellCounts(portfolio: Lineup[], pool: Lineup[]): { q5q5: number; q1q1: number } {
  const poolProj = pool.map(lu => lu.projection).sort((a, b) => a - b);
  const poolOwn = pool.map(lu => lu.players.reduce((s, p) => s + (p.ownership || 0), 0) / lu.players.length).sort((a, b) => a - b);
  const n = poolProj.length;
  const p80 = poolProj[Math.floor(n * 0.8)];
  const p20 = poolProj[Math.floor(n * 0.2)];
  const o80 = poolOwn[Math.floor(n * 0.8)];
  const o20 = poolOwn[Math.floor(n * 0.2)];
  let q5q5 = 0, q1q1 = 0;
  for (const lu of portfolio) {
    const own = lu.players.reduce((s, p) => s + (p.ownership || 0), 0) / lu.players.length;
    if (lu.projection >= p80 && own >= o80) q5q5++;
    if (lu.projection < p20 && own < o20) q1q1++;
  }
  return { q5q5, q1q1 };
}

async function main() {
  console.log('================================================================');
  console.log('EXTREME-CORNER CAP BACKTEST');
  console.log('================================================================');
  console.log(`  Baseline: λ=${LAMBDA}, γ=${GAMMA}, no corner cap`);
  console.log(`  Capped:   same + Q5Q5 cap 25%, Q1Q1 cap 5%\n`);

  type Row = {
    slate: string;
    baseT1: number; basePay: number; baseQ5Q5: number; baseQ1Q1: number;
    capT1: number; capPay: number; capQ5Q5: number; capQ1Q1: number;
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
    const comboFreq = precomputeComboFrequencies(loaded.lineups, 3);
    const payoutTable = buildPayoutTable(F);

    const base = productionSelect(loaded.lineups, pool.players, {
      N, lambda: LAMBDA, comboFreq, maxOverlap: GAMMA,
    });
    const capped = productionSelect(loaded.lineups, pool.players, {
      N, lambda: LAMBDA, comboFreq, maxOverlap: GAMMA,
      extremeCornerCap: true, extremeCornerQ5Q5Pct: 0.25, extremeCornerQ1Q1Pct: 0.05,
    });
    const baseScored = scorePortfolio(base.portfolio, actuals, actualByHash, payoutTable);
    const capScored = scorePortfolio(capped.portfolio, actuals, actualByHash, payoutTable);
    const baseCells = cornerCellCounts(base.portfolio, loaded.lineups);
    const capCells = cornerCellCounts(capped.portfolio, loaded.lineups);

    rows.push({
      slate: s.slate,
      baseT1: baseScored.t1, basePay: baseScored.totalPayout, baseQ5Q5: baseCells.q5q5, baseQ1Q1: baseCells.q1q1,
      capT1: capScored.t1, capPay: capScored.totalPayout, capQ5Q5: capCells.q5q5, capQ1Q1: capCells.q1q1,
    });

    const d = capScored.totalPayout - baseScored.totalPayout;
    console.log(`${s.slate}: F=${F}`);
    console.log(`  baseline: t1=${baseScored.t1.toString().padStart(2)} pay=$${baseScored.totalPayout.toFixed(0).padStart(6)} Q5Q5=${baseCells.q5q5.toString().padStart(2)} Q1Q1=${baseCells.q1q1.toString().padStart(2)}`);
    console.log(`  capped:   t1=${capScored.t1.toString().padStart(2)} pay=$${capScored.totalPayout.toFixed(0).padStart(6)} Q5Q5=${capCells.q5q5.toString().padStart(2)} Q1Q1=${capCells.q1q1.toString().padStart(2)}  Δ=${d >= 0 ? '+$' : '-$'}${Math.abs(d).toFixed(0)}`);
  }

  console.log('\n================================================================');
  console.log('SUMMARY');
  console.log('================================================================\n');
  let baseT = 0, capT = 0, baseT1 = 0, capT1 = 0, baseQ5Q5 = 0, capQ5Q5 = 0, baseQ1Q1 = 0, capQ1Q1 = 0;
  for (const r of rows) {
    baseT += r.basePay; capT += r.capPay;
    baseT1 += r.baseT1; capT1 += r.capT1;
    baseQ5Q5 += r.baseQ5Q5; capQ5Q5 += r.capQ5Q5;
    baseQ1Q1 += r.baseQ1Q1; capQ1Q1 += r.capQ1Q1;
  }
  const fees = FEE * N * rows.length;
  const n = rows.length;
  console.log(`baseline:  $${baseT.toFixed(0)}  t1=${baseT1}  ROI=${((baseT / fees - 1) * 100).toFixed(1)}%  avgQ5Q5=${(baseQ5Q5 / n).toFixed(1)} avgQ1Q1=${(baseQ1Q1 / n).toFixed(1)}`);
  console.log(`capped:    $${capT.toFixed(0)}  t1=${capT1}  ROI=${((capT / fees - 1) * 100).toFixed(1)}%  avgQ5Q5=${(capQ5Q5 / n).toFixed(1)} avgQ1Q1=${(capQ1Q1 / n).toFixed(1)}`);
  console.log(`Δ:         ${capT >= baseT ? '+$' : '-$'}${Math.abs(capT - baseT).toFixed(0)}  (${capT1 - baseT1} hits)`);
  console.log(`\nnerdy targets: Q5Q5≈37/150 (24.8%), Q1Q1≈6/150 (4.3%)`);
}

main().catch(e => { console.error(e); process.exit(1); });
