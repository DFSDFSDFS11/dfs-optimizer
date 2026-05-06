/**
 * Backtest: sameStackMaxOverlap=6 vs shipped baseline (γ=7 only).
 *
 * Both configs use λ=0.05. Runs on 9 slates. Reports per-slate payout delta.
 * Guard: baseline total should equal prior production+λ=0.05+γ=7 backtest result.
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
  let t1 = 0, scored = 0, totalPayout = 0;
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
  return { t1, scored, totalPayout };
}

function countSameStackMaxOverlap(portfolio: Lineup[]): { max: number; mean: number; n: number } {
  const groups = new Map<string, number[]>(); // team → indices into pidSets
  const pidSets = portfolio.map(lu => new Set(lu.players.map(p => p.id)));
  const primaryTeams = portfolio.map(lu => {
    const counts = new Map<string, number>();
    for (const p of lu.players) if (!p.positions?.includes('P')) counts.set(p.team, (counts.get(p.team) || 0) + 1);
    let mT: string | null = null, mN = 0;
    for (const [t, n] of counts) if (n > mN) { mN = n; mT = t; }
    return mN >= 4 ? mT : null;
  });
  for (let i = 0; i < portfolio.length; i++) {
    const t = primaryTeams[i];
    if (!t) continue;
    let arr = groups.get(t);
    if (!arr) { arr = []; groups.set(t, arr); }
    arr.push(i);
  }
  let maxO = 0, sum = 0, pairs = 0;
  for (const [, idxs] of groups) {
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        let o = 0;
        for (const id of pidSets[idxs[a]]) if (pidSets[idxs[b]].has(id)) o++;
        if (o > maxO) maxO = o;
        sum += o; pairs++;
      }
    }
  }
  return { max: maxO, mean: pairs > 0 ? sum / pairs : 0, n: pairs };
}

async function main() {
  console.log('================================================================');
  console.log(`SAME-STACK MAX-OVERLAP BACKTEST — λ=${LAMBDA}, γ=${GAMMA}`);
  console.log(`Comparing: baseline (sameStack=10) vs sameStack=6`);
  console.log('================================================================\n');

  type Row = {
    slate: string; F: number;
    baseT1: number; basePay: number; baseSameMax: number; baseSameMean: number;
    newT1: number; newPay: number; newSameMax: number; newSameMean: number;
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

    // Baseline: γ=7 only (sameStack disabled)
    const base = productionSelect(loaded.lineups, pool.players, {
      N, lambda: LAMBDA, comboFreq, maxOverlap: GAMMA, sameStackMaxOverlap: 10,
    });
    // New: γ=7 + sameStack=6
    const ssNew = productionSelect(loaded.lineups, pool.players, {
      N, lambda: LAMBDA, comboFreq, maxOverlap: GAMMA, sameStackMaxOverlap: 6,
    });

    const baseScore = scorePortfolio(base.portfolio, actuals, actualByHash, payoutTable);
    const newScore = scorePortfolio(ssNew.portfolio, actuals, actualByHash, payoutTable);

    const baseSS = countSameStackMaxOverlap(base.portfolio);
    const newSS = countSameStackMaxOverlap(ssNew.portfolio);

    rows.push({
      slate: s.slate, F,
      baseT1: baseScore.t1, basePay: baseScore.totalPayout,
      baseSameMax: baseSS.max, baseSameMean: baseSS.mean,
      newT1: newScore.t1, newPay: newScore.totalPayout,
      newSameMax: newSS.max, newSameMean: newSS.mean,
    });

    console.log(`${s.slate}:`);
    console.log(`  baseline (ss=10):   t1=${baseScore.t1.toString().padStart(2)} pay=$${baseScore.totalPayout.toFixed(0).padStart(6)} sameMax=${baseSS.max} sameMean=${baseSS.mean.toFixed(2)} size=${base.portfolio.length}`);
    console.log(`  sameStack=6:        t1=${newScore.t1.toString().padStart(2)} pay=$${newScore.totalPayout.toFixed(0).padStart(6)} sameMax=${newSS.max} sameMean=${newSS.mean.toFixed(2)} size=${ssNew.portfolio.length}`);
    console.log(`  Δ: ${(newScore.totalPayout - baseScore.totalPayout >= 0 ? '+$' : '-$') + Math.abs(newScore.totalPayout - baseScore.totalPayout).toFixed(0)}`);
  }

  // SUMMARY
  console.log('\n================================================================');
  console.log('SUMMARY');
  console.log('================================================================\n');
  console.log('Slate      |    F  | base t1 | base pay | base ssMax/Mean | new t1 | new pay | new ssMax/Mean |     Δ');
  console.log('-'.repeat(120));
  let baseT = 0, newT = 0, baseT1 = 0, newT1 = 0;
  for (const r of rows) {
    const d = r.newPay - r.basePay;
    baseT += r.basePay; newT += r.newPay;
    baseT1 += r.baseT1; newT1 += r.newT1;
    console.log(`${r.slate.padEnd(10)} | ${String(r.F).padStart(5)} | ${String(r.baseT1).padStart(7)} | $${r.basePay.toFixed(0).padStart(7)} | ${String(r.baseSameMax).padStart(3)}/${r.baseSameMean.toFixed(2).padStart(5)}       | ${String(r.newT1).padStart(6)} | $${r.newPay.toFixed(0).padStart(6)} | ${String(r.newSameMax).padStart(3)}/${r.newSameMean.toFixed(2).padStart(5)}      | ${(d >= 0 ? '+$' : '-$') + Math.abs(d).toFixed(0).padStart(5)}`);
  }
  console.log('-'.repeat(120));
  console.log(`TOTAL     |       | ${String(baseT1).padStart(7)} | $${baseT.toFixed(0).padStart(7)} |                 | ${String(newT1).padStart(6)} | $${newT.toFixed(0).padStart(6)} |                | ${(newT - baseT >= 0 ? '+$' : '-$') + Math.abs(newT - baseT).toFixed(0)}`);
  const fees = FEE * N * rows.length;
  console.log(`\nFees: $${fees.toLocaleString()}`);
  console.log(`Baseline ROI: ${((baseT / fees - 1) * 100).toFixed(1)}%  (sameStackMean avg=${(rows.reduce((s, r) => s + r.baseSameMean, 0) / rows.length).toFixed(2)})`);
  console.log(`sameStack=6 ROI: ${((newT / fees - 1) * 100).toFixed(1)}%  (sameStackMean avg=${(rows.reduce((s, r) => s + r.newSameMean, 0) / rows.length).toFixed(2)})`);
}

main().catch(e => { console.error(e); process.exit(1); });
