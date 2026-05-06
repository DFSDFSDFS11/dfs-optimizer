/**
 * Backtest: stricter proportional ownership filter.
 *
 * Under the NEW symmetric linear formula, cap scales across full projection range:
 *   cap(proj) = targetAvgOwn + buffer + slope * (proj - median)
 * where slope = (anchor - targetAvgOwn) / (max - median) = ownDropPP per unit proj above median.
 *
 * Three configs across 9 slates (all with λ=0.05, γ=7):
 *   A. BASELINE: no ownership ceiling (buffer=0 disabled)
 *   B. V35 BUFFER=3: cap at max = anchor + 3, at median = anchor - 3, at min = anchor - 9
 *   C. STRICT BUFFER=0: cap at max = anchor, at median = anchor - 6, at min = anchor - 12
 *   D. STRICT BUFFER=-3: cap at max = anchor - 3, at median = anchor - 9, at min = anchor - 15
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

const CONFIGS = [
  { label: 'A baseline (no filter)', buffer: 0, enabled: false },
  { label: 'B V35 buffer=3', buffer: 3, enabled: true },
  { label: 'C strict buffer=0', buffer: 0, enabled: true },
  { label: 'D strict buffer=-3', buffer: -3, enabled: true },
];

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

async function main() {
  console.log('================================================================');
  console.log('STRICTER PROPORTIONAL OWNERSHIP FILTER BACKTEST');
  console.log('================================================================');
  console.log(`  λ=${LAMBDA}, γ=${GAMMA}, N=${N}\n`);
  console.log(`  New filter: symmetric linear slope — cap falls below median for below-median projection.`);
  console.log(`  At buffer=3: cap ∈ [anchor-9, anchor+3]`);
  console.log(`  At buffer=0: cap ∈ [anchor-12, anchor]`);
  console.log(`  At buffer=-3: cap ∈ [anchor-15, anchor-3]\n`);

  type Row = {
    slate: string;
    results: Array<{ label: string; t1: number; pay: number; sizeActual: number; filtered: number; minCap: number; medCap: number; maxCap: number }>;
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

    const results: Row['results'] = [];
    for (const c of CONFIGS) {
      const result = productionSelect(loaded.lineups, pool.players, {
        N, lambda: LAMBDA, comboFreq, maxOverlap: GAMMA,
        useOwnershipCeiling: c.enabled,
        ownershipCeilingBuffer: c.buffer,
      });
      const scored = scorePortfolio(result.portfolio, actuals, actualByHash, payoutTable);
      results.push({
        label: c.label,
        t1: scored.t1,
        pay: scored.totalPayout,
        sizeActual: result.portfolio.length,
        filtered: result.ownershipCeiling?.filtered ?? 0,
        minCap: result.ownershipCeiling?.minCeiling ?? 0,
        medCap: result.ownershipCeiling?.medianCeiling ?? 0,
        maxCap: result.ownershipCeiling?.maxCeiling ?? 0,
      });
    }
    rows.push({ slate: s.slate, results });

    console.log(`${s.slate}: F=${F}`);
    for (const r of results) {
      console.log(`  ${r.label.padEnd(26)} t1=${r.t1.toString().padStart(2)} pay=$${r.pay.toFixed(0).padStart(6)} size=${r.sizeActual} filtered=${r.filtered}  caps: min=${r.minCap.toFixed(1)}% med=${r.medCap.toFixed(1)}% max=${r.maxCap.toFixed(1)}%`);
    }
  }

  // SUMMARY
  console.log('\n================================================================');
  console.log('SUMMARY');
  console.log('================================================================\n');
  for (let ci = 0; ci < CONFIGS.length; ci++) {
    let total = 0, t1sum = 0;
    for (const r of rows) {
      total += r.results[ci].pay;
      t1sum += r.results[ci].t1;
    }
    const fees = FEE * N * rows.length;
    const roi = ((total / fees - 1) * 100).toFixed(1);
    const d = ci > 0 ? total - rows.reduce((s, r) => s + r.results[0].pay, 0) : 0;
    console.log(`${CONFIGS[ci].label.padEnd(26)} total=$${total.toFixed(0).padStart(6)} t1=${t1sum.toString().padStart(3)} ROI=${roi.padStart(6)}%  Δ vs baseline=${ci === 0 ? 'n/a' : (d >= 0 ? '+$' : '-$') + Math.abs(d).toFixed(0)}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
