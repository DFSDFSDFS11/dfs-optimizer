/**
 * Production selector backtest on NBA (DraftKings Classic).
 *
 * Production was MLB-tuned, but ownership binning + γ overlap + bin allocation
 * are sport-agnostic. This probes whether the core framework generalizes to NBA
 * with the MLB stack filter disabled.
 *
 * NBA adjustments:
 *   - minPrimaryStack=0 (NBA has no 4+ team stack concept)
 *   - lambda=0 (combo leverage's stack/pstack keys don't fire in NBA)
 *   - maxOverlap=6 (8-player roster; γ=7 would be nearly inactive)
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals } from '../parser';
import { getContestConfig } from '../rules';
import { productionSelect } from '../selection/production-selector';

const DIR = 'C:/Users/colin/Projects/dfs-optimizer/historical_slates';
const FEE = 20;
const N = 150;
const GAMMA = 6;

const SLATES = [
  { slate: '2026-01-16', proj: '2026-01-16_projections.csv', actuals: '2026-01-16_actuals.csv', pool: '_backtest_2026-01-16.csv' },
  { slate: '2026-01-17', proj: '2026-01-17_projections.csv', actuals: '2026-01-17_actuals.csv', pool: '_backtest_2026-01-17.csv' },
  { slate: '2026-01-18', proj: '2026-01-18_projections.csv', actuals: '2026-01-18_actuals.csv', pool: '_backtest_2026-01-18.csv' },
  { slate: '2026-01-19', proj: '2026-01-19_projections.csv', actuals: '2026-01-19_actuals.csv', pool: '_backtest_2026-01-19.csv' },
  { slate: '2026-01-20', proj: '2026-01-20_projections.csv', actuals: '2026-01-20_actuals.csv', pool: '_backtest_2026-01-20.csv' },
  { slate: '2026-02-25', proj: '2026-02-25_projections.csv', actuals: '2026-02-25_actuals.csv', pool: '_backtest_2026-02-25.csv' },
  { slate: '2026-02-26', proj: '2026-02-26_projections.csv', actuals: '2026-02-26_actuals.csv', pool: '_backtest_2026-02-26.csv' },
  { slate: '2026-02-27', proj: '2026-02-27_projections.csv', actuals: '2026-02-27_actuals.csv', pool: '_backtest_2026-02-27.csv' },
  { slate: '2026-02-28', proj: '2026-02-28_projections.csv', actuals: '2026-02-28_actuals.csv', pool: '_backtest_2026-02-28.csv' },
  { slate: '2026-03-03', proj: '2026-03-03_projections.csv', actuals: '2026-03-03_actuals.csv', pool: '_backtest_2026-03-03.csv' },
  { slate: '2026-03-05', proj: '2026-03-05_dk_projections.csv', actuals: '2026-03-05_dk_actuals.csv', pool: '_backtest_2026-03-05_dk.csv' },
  { slate: '2026-03-06', proj: '2026-03-06_dk_projections.csv', actuals: '2026-03-06_dk_actuals.csv', pool: '_backtest_2026-03-06_dk.csv' },
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
  let t1 = 0, totalPayout = 0, scored = 0;
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

async function main() {
  console.log('================================================================');
  console.log(`PRODUCTION NBA BACKTEST — γ=${GAMMA}, minPrimaryStack=0, N=${N}`);
  console.log('================================================================\n');

  type Row = {
    slate: string; F: number; poolSize: number;
    t1: number; pay: number; scored: number; size: number;
    capT1: number; capPay: number;
  };
  const rows: Row[] = [];

  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj);
    const actualsPath = path.join(DIR, s.actuals);
    const poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) {
      console.log(`SKIP ${s.slate}`);
      continue;
    }

    try {
      const pr = parseCSVFile(projPath, 'nba', true);
      const config = getContestConfig('dk', 'nba', pr.detectedContestType);
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

      // Base production for NBA
      const base = productionSelect(loaded.lineups, pool.players, {
        N, lambda: 0, maxOverlap: GAMMA, minPrimaryStack: 0,
      });
      const baseScored = scorePortfolio(base.portfolio, actuals, actualByHash, payoutTable);

      // With corner cap
      const capped = productionSelect(loaded.lineups, pool.players, {
        N, lambda: 0, maxOverlap: GAMMA, minPrimaryStack: 0,
        extremeCornerCap: true, extremeCornerQ5Q5Pct: 0.25, extremeCornerQ1Q1Pct: 0.05,
      });
      const capScored = scorePortfolio(capped.portfolio, actuals, actualByHash, payoutTable);

      rows.push({
        slate: s.slate, F, poolSize: loaded.lineups.length,
        t1: baseScored.t1, pay: baseScored.totalPayout, scored: baseScored.scored, size: base.portfolio.length,
        capT1: capScored.t1, capPay: capScored.totalPayout,
      });

      console.log(`${s.slate}: F=${F.toLocaleString().padStart(7)} pool=${loaded.lineups.length.toString().padStart(4)} size=${base.portfolio.length.toString().padStart(3)}`);
      console.log(`  base:     t1=${baseScored.t1.toString().padStart(2)} pay=$${baseScored.totalPayout.toFixed(0).padStart(6)} scored=${baseScored.scored}/${N}`);
      console.log(`  w/ cap:   t1=${capScored.t1.toString().padStart(2)} pay=$${capScored.totalPayout.toFixed(0).padStart(6)} Δ=${(capScored.totalPayout - baseScored.totalPayout >= 0 ? '+$' : '-$') + Math.abs(capScored.totalPayout - baseScored.totalPayout).toFixed(0)}`);
    } catch (err) {
      console.log(`ERROR ${s.slate}: ${(err as Error).message}`);
    }
  }

  console.log('\n================================================================');
  console.log('SUMMARY');
  console.log('================================================================\n');
  let totalPay = 0, totalT1 = 0, totalCapPay = 0, totalCapT1 = 0;
  for (const r of rows) {
    totalPay += r.pay; totalT1 += r.t1;
    totalCapPay += r.capPay; totalCapT1 += r.capT1;
  }
  const fees = FEE * N * rows.length;
  console.log(`Slates scored: ${rows.length}`);
  console.log(`Fees: $${fees.toLocaleString()}\n`);
  console.log(`Base:       $${totalPay.toFixed(0)}  t1=${totalT1}  ROI=${((totalPay / fees - 1) * 100).toFixed(1)}%`);
  console.log(`w/corner:   $${totalCapPay.toFixed(0)}  t1=${totalCapT1}  ROI=${((totalCapPay / fees - 1) * 100).toFixed(1)}%  Δ=${totalCapPay >= totalPay ? '+$' : '-$'}${Math.abs(totalCapPay - totalPay).toFixed(0)}`);

  // Table
  console.log('\nPer-slate:');
  console.log('Slate        |     F | Pool | t1 | base Pay | w/cap Pay |    Δ');
  console.log('-------------|-------|------|----|---------:|----------:|------:');
  for (const r of rows) {
    const d = r.capPay - r.pay;
    console.log(`${r.slate.padEnd(12)} | ${r.F.toLocaleString().padStart(5)} | ${r.poolSize.toString().padStart(4)} | ${r.t1.toString().padStart(2)} | $${r.pay.toFixed(0).padStart(7)} | $${r.capPay.toFixed(0).padStart(8)} | ${(d >= 0 ? '+$' : '-$') + Math.abs(d).toFixed(0)}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
