/**
 * λ sweep under extended combo leverage (3+ stacks + dualStack) + WIDE filter.
 *
 * The extended combo scheme emits more keys per lineup for split patterns
 * (3-3 gets 15 keys vs 4-stack's 9). That increases the magnitude of
 * comboBonus per lineup, which means λ=0.05 applies more within-bin weight
 * than it did in the old scheme. This sweep looks for the recalibrated λ.
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
const GAMMA = 7;

const LAMBDAS = [0, 0.005, 0.01, 0.02, 0.03, 0.05];

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

function nonFourStackPct(portfolio: Lineup[]): number {
  let non4 = 0;
  for (const lu of portfolio) {
    const c = teamCounts(lu.players);
    if ((c[0] || 0) < 4) non4++;
  }
  return portfolio.length ? non4 / portfolio.length * 100 : 0;
}

async function main() {
  console.log('================================================================');
  console.log('EXTENDED COMBO + WIDE FILTER — λ sweep recalibration');
  console.log('================================================================');
  console.log(`  λ grid: ${LAMBDAS.join(', ')}, γ=${GAMMA}, nerdy non-4 target=21.5%\n`);

  const grid: Array<{ lambda: number; total: number; t1: number; avgNon4: number }> = [];

  for (const lambda of LAMBDAS) {
    let total = 0, t1sum = 0, non4Sum = 0, nSlates = 0;
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
      const widePool = loaded.lineups.filter(wideFilter);
      const comboFreq = precomputeComboFrequencies(widePool, 3);
      const result = productionSelect(widePool, pool.players, {
        N, lambda, comboFreq, maxOverlap: GAMMA, minPrimaryStack: 0,
      });
      const scored = scorePortfolio(result.portfolio, actuals, actualByHash, buildPayoutTable(F));
      total += scored.totalPayout;
      t1sum += scored.t1;
      non4Sum += nonFourStackPct(result.portfolio);
      nSlates++;
    }
    const avgNon4 = non4Sum / nSlates;
    grid.push({ lambda, total, t1: t1sum, avgNon4 });
    console.log(`λ=${lambda.toFixed(3).padStart(5)}  total=$${total.toFixed(0).padStart(6)}  t1=${t1sum.toString().padStart(3)}  ROI=${((total / (FEE * N * nSlates) - 1) * 100).toFixed(1).padStart(6)}%  avg non-4%=${avgNon4.toFixed(1).padStart(5)}%`);
  }

  console.log('\nSummary:');
  let best = grid[0];
  for (const g of grid) if (g.total > best.total) best = g;
  console.log(`  Winner: λ=${best.lambda} at $${best.total.toFixed(0)} (ROI ${((best.total / (FEE * N * SLATES.length) - 1) * 100).toFixed(1)}%, non-4=${best.avgNon4.toFixed(1)}%)`);
  console.log(`  Prior shipped baseline (old combo, 4+ filter, λ=0.05): $31,412 (approx — different combo scheme)`);
  console.log(`  Nerdy non-4 target: 21.5%`);
}

main().catch(e => { console.error(e); process.exit(1); });
