/**
 * Production (λ=0.05) head-to-head vs nerdytenor across 9 MLB slates.
 *
 * nerdytenor enters 150 entries per slate. For each slate we:
 *   - Run production selector (λ=0.05, γ disabled) → our 150 lineups
 *   - Filter actuals entries to entryName starting with "nerdytenor" → their 150 entries
 *   - Score both with the same payout table (power-law α=1.15, 22% cash line, $20 fee)
 *   - Report per-slate and total head-to-head.
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

function scoreByHashes(
  portfolio: Lineup[],
  actuals: ContestActuals,
  actualByHash: Map<string, number>,
  payoutTable: Float64Array,
  sortedDesc: number[],
  top1T: number,
) {
  let t1 = 0, scored = 0, totalPayout = 0, sumScore = 0;
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
    scored++;
    sumScore += a;
    let lo = 0, hi = sortedDesc.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sortedDesc[mid] >= a) lo = mid + 1; else hi = mid;
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
  return { t1, scored, totalPayout, avgScore: scored > 0 ? sumScore / scored : 0 };
}

/**
 * Score nerdytenor's entries directly from the actuals (already have actualPoints per entry).
 */
function scoreNerdytenor(
  actuals: ContestActuals,
  payoutTable: Float64Array,
  sortedDesc: number[],
  top1T: number,
) {
  const nerdyEntries = actuals.entries.filter(e => e.entryName.toLowerCase().includes('nerdytenor'));
  let t1 = 0, totalPayout = 0, sumScore = 0;
  for (const e of nerdyEntries) {
    const a = e.actualPoints;
    sumScore += a;
    let lo = 0, hi = sortedDesc.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sortedDesc[mid] >= a) lo = mid + 1; else hi = mid;
    }
    const rank = Math.max(1, lo);
    if (a >= top1T) t1++;
    const payout = rank <= payoutTable.length ? payoutTable[rank - 1] : 0;
    if (payout > 0) {
      let coWin = 0;
      for (const other of actuals.entries) if (Math.abs(other.actualPoints - a) <= 0.25) coWin++;
      coWin = Math.max(0, coWin - 1);
      totalPayout += payout / Math.sqrt(1 + coWin * 0.5);
    }
  }
  return { entries: nerdyEntries.length, t1, totalPayout, avgScore: nerdyEntries.length > 0 ? sumScore / nerdyEntries.length : 0 };
}

async function main() {
  console.log('================================================================');
  console.log(`PRODUCTION (λ=${LAMBDA}) vs nerdytenor — 9 MLB slates`);
  console.log('================================================================\n');

  type Row = {
    slate: string; F: number;
    prodT1: number; prodPay: number; prodAvgScore: number;
    nerdyEntries: number; nerdyT1: number; nerdyPay: number; nerdyAvgScore: number;
  };
  const rows: Row[] = [];

  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj);
    const actualsPath = path.join(DIR, s.actuals);
    const poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) {
      console.log(`  SKIP ${s.slate}`);
      continue;
    }

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
    const sortedDesc = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
    const top1T = sortedDesc[Math.max(0, Math.floor(F * 0.01) - 1)] || 0;

    const prodResult = productionSelect(loaded.lineups, pool.players, {
      N, lambda: LAMBDA, comboFreq, maxOverlap: 10,
    });
    const prod = scoreByHashes(prodResult.portfolio, actuals, actualByHash, payoutTable, sortedDesc, top1T);
    const nerdy = scoreNerdytenor(actuals, payoutTable, sortedDesc, top1T);

    rows.push({
      slate: s.slate, F,
      prodT1: prod.t1, prodPay: prod.totalPayout, prodAvgScore: prod.avgScore,
      nerdyEntries: nerdy.entries, nerdyT1: nerdy.t1, nerdyPay: nerdy.totalPayout, nerdyAvgScore: nerdy.avgScore,
    });

    console.log(`${s.slate}: F=${F}, top1%=${top1T.toFixed(1)}pts`);
    console.log(`  Production: t1=${prod.t1}  pay=$${prod.totalPayout.toFixed(0).padStart(6)}  avgScore=${prod.avgScore.toFixed(1)}`);
    console.log(`  nerdytenor: t1=${nerdy.t1}  pay=$${nerdy.totalPayout.toFixed(0).padStart(6)}  avgScore=${nerdy.avgScore.toFixed(1)}  (entries=${nerdy.entries})`);
    const delta = prod.totalPayout - nerdy.totalPayout;
    console.log(`  Δ: ${delta >= 0 ? '+' : ''}$${delta.toFixed(0)} (${delta >= 0 ? 'Production' : 'nerdytenor'} wins)`);
  }

  // SUMMARY TABLE
  console.log('\n================================================================');
  console.log('HEAD-TO-HEAD SUMMARY');
  console.log('================================================================\n');
  console.log('Slate      |     F |  Prod t1 |   Prod Pay | Nerdy ent | Nerdy t1 | Nerdy Pay |    Δ   | Winner');
  console.log('-'.repeat(105));
  let totalProd = 0, totalNerdy = 0, totalProdT1 = 0, totalNerdyT1 = 0, prodWins = 0, nerdyWins = 0;
  for (const r of rows) {
    const delta = r.prodPay - r.nerdyPay;
    const winner = delta > 0 ? 'Prod' : (delta < 0 ? 'Nerdy' : 'tie');
    if (delta > 0) prodWins++; else if (delta < 0) nerdyWins++;
    totalProd += r.prodPay;
    totalNerdy += r.nerdyPay;
    totalProdT1 += r.prodT1;
    totalNerdyT1 += r.nerdyT1;
    console.log(
      `${r.slate.padEnd(10)} | ${String(r.F).padStart(5)} | ${String(r.prodT1).padStart(8)} | $${r.prodPay.toFixed(0).padStart(9)} | ${String(r.nerdyEntries).padStart(9)} | ${String(r.nerdyT1).padStart(8)} | $${r.nerdyPay.toFixed(0).padStart(8)} | ${(delta >= 0 ? '+$' : '-$') + Math.abs(delta).toFixed(0).padStart(5)} | ${winner}`,
    );
  }
  console.log('-'.repeat(105));
  const deltaTotal = totalProd - totalNerdy;
  console.log(
    `${'TOTAL'.padEnd(10)} |       | ${String(totalProdT1).padStart(8)} | $${totalProd.toFixed(0).padStart(9)} |           | ${String(totalNerdyT1).padStart(8)} | $${totalNerdy.toFixed(0).padStart(8)} | ${(deltaTotal >= 0 ? '+$' : '-$') + Math.abs(deltaTotal).toFixed(0)}  | ${deltaTotal >= 0 ? 'Production' : 'nerdytenor'}`,
  );

  const totalFees = FEE * N * rows.length;
  console.log(`\nFees: $${totalFees.toLocaleString()}`);
  console.log(`Production ROI: ${((totalProd / totalFees - 1) * 100).toFixed(1)}%`);
  console.log(`nerdytenor ROI: ${((totalNerdy / totalFees - 1) * 100).toFixed(1)}%`);
  console.log(`Head-to-head slate wins: Production ${prodWins} / nerdytenor ${nerdyWins} / tie ${rows.length - prodWins - nerdyWins}`);
}

main().catch(e => { console.error(e); process.exit(1); });
