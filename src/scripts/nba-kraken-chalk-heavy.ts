/**
 * NBA Kraken variants — chalk 15% + value 70% thesis.
 * Keep Kraken: λ=0.38, γ=6, teamCap=0.21, corner=false, minStack=0.
 * Vary bin allocation around chalk ~15%, value ~70%.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import {
  parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals,
} from '../parser';
import { getContestConfig } from '../rules';
import { productionSelect } from '../selection/production-selector';
import { precomputeComboFrequencies } from '../selection/combo-leverage';

const DIR = 'C:/Users/colin/Projects/dfs-optimizer/historical_slates';
const N = 150;
const FEE = 20;

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

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function buildPayoutTable(F: number): Float64Array {
  const pool = F * FEE * 0.88; const cashLine = Math.floor(F * 0.22);
  const raw = new Float64Array(cashLine); let rawSum = 0;
  for (let r = 0; r < cashLine; r++) { raw[r] = Math.pow(r + 1, -1.15); rawSum += raw[r]; }
  const table = new Float64Array(F); const minCash = FEE * 1.2;
  for (let r = 0; r < cashLine; r++) table[r] = Math.max(minCash, (raw[r] / rawSum) * pool);
  let tSum = 0; for (let r = 0; r < cashLine; r++) tSum += table[r];
  const scale = pool / tSum; for (let r = 0; r < cashLine; r++) table[r] *= scale;
  return table;
}
function scoreLineup(lu: Lineup, actuals: ContestActuals, actualByHash: Map<string, number>): number | null {
  const h = lu.players.map(p => p.id).sort().join('|'); const fa = actualByHash.get(h);
  if (fa !== undefined) return fa;
  let t = 0; for (const p of lu.players) { const r = actuals.playerActualsByName.get(norm(p.name)); if (!r) return null; t += r.fpts; }
  return t;
}
function payoutFor(actual: number, sorted: number[], payoutTable: Float64Array, actuals: ContestActuals): number {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (sorted[m] >= actual) lo = m + 1; else hi = m; }
  const rank = Math.max(1, lo);
  const pay = rank <= payoutTable.length ? payoutTable[rank - 1] : 0;
  if (pay <= 0) return 0;
  let co = 0; for (const e of actuals.entries) if (Math.abs(e.actualPoints - actual) <= 0.25) co++;
  co = Math.max(0, co - 1);
  return pay / Math.sqrt(1 + co * 0.5);
}
function scorePortfolio(portfolio: Lineup[], actuals: ContestActuals, actualByHash: Map<string, number>, sorted: number[], payoutTable: Float64Array, top1T: number, cashT: number) {
  let pay = 0, t1 = 0, cash = 0, scored = 0;
  for (const lu of portfolio) {
    const a = scoreLineup(lu, actuals, actualByHash); if (a === null) continue;
    scored++; pay += payoutFor(a, sorted, payoutTable, actuals);
    if (a >= top1T) t1++; if (a >= cashT) cash++;
  }
  return { pay, t1, cash, scored };
}

interface Variant { id: string; bins: { chalk: number; core: number; value: number; contra: number; deep: number } }
const VARIANTS: Variant[] = [
  { id: 'NBA-shipped (no Kraken)', bins: null as any },  // special case
  { id: 'Kraken-base         (16/13/55/13/02)', bins: { chalk: 0.16, core: 0.13, value: 0.55, contra: 0.13, deep: 0.02 } },
  // User's request: chalk 15, value 70 — distribute remaining 15% over core/contra/deep
  { id: 'Kraken-NBA:15/10/70/05/00',  bins: { chalk: 0.15, core: 0.10, value: 0.70, contra: 0.05, deep: 0.00 } },
  { id: 'Kraken-NBA:15/07/70/07/01',  bins: { chalk: 0.15, core: 0.07, value: 0.70, contra: 0.07, deep: 0.01 } },
  { id: 'Kraken-NBA:15/05/70/08/02',  bins: { chalk: 0.15, core: 0.05, value: 0.70, contra: 0.08, deep: 0.02 } },
  { id: 'Kraken-NBA:15/08/70/05/02',  bins: { chalk: 0.15, core: 0.08, value: 0.70, contra: 0.05, deep: 0.02 } },
  { id: 'Kraken-NBA:15/05/70/10/00',  bins: { chalk: 0.15, core: 0.05, value: 0.70, contra: 0.10, deep: 0.00 } },
  { id: 'Kraken-NBA:15/00/70/10/05',  bins: { chalk: 0.15, core: 0.00, value: 0.70, contra: 0.10, deep: 0.05 } },
  // Variations on chalk-value ratio — maybe more chalk helps NBA even more
  { id: 'Kraken-NBA:20/05/70/05/00',  bins: { chalk: 0.20, core: 0.05, value: 0.70, contra: 0.05, deep: 0.00 } },
  { id: 'Kraken-NBA:10/10/75/05/00',  bins: { chalk: 0.10, core: 0.10, value: 0.75, contra: 0.05, deep: 0.00 } },
  { id: 'Kraken-NBA:20/10/65/05/00',  bins: { chalk: 0.20, core: 0.10, value: 0.65, contra: 0.05, deep: 0.00 } },
  { id: 'Kraken-NBA:25/05/65/05/00',  bins: { chalk: 0.25, core: 0.05, value: 0.65, contra: 0.05, deep: 0.00 } },
  { id: 'Kraken-NBA:25/15/55/05/00',  bins: { chalk: 0.25, core: 0.15, value: 0.55, contra: 0.05, deep: 0.00 } },
];

async function main() {
  console.log('================================================================');
  console.log('NBA KRAKEN CHALK-VALUE-HEAVY VARIANTS');
  console.log('================================================================\n');

  interface Row { id: string; slate: string; pay: number; t1: number; cash: number; scored: number }
  const rows: Row[] = [];

  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj); const actualsPath = path.join(DIR, s.actuals); const poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) continue;
    try {
      const pr = parseCSVFile(projPath, 'nba', true);
      const config = getContestConfig('dk', 'nba', pr.detectedContestType);
      const pool = buildPlayerPool(pr.players, pr.detectedContestType);
      const actuals = parseContestActuals(actualsPath, config);
      const idMap = new Map<string, Player>(); const nameMap = new Map<string, Player>();
      for (const p of pool.players) { idMap.set(p.id, p); nameMap.set(norm(p.name), p); }
      const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
      const comboFreq = precomputeComboFrequencies(loaded.lineups, 3);
      const F = actuals.entries.length;
      const sorted = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
      const top1T = sorted[Math.max(0, Math.floor(F * 0.01) - 1)] || 0;
      const cashT = sorted[Math.max(0, Math.floor(F * 0.22) - 1)] || 0;
      const payoutTable = buildPayoutTable(F);
      const actualByHash = new Map<string, number>();
      for (const e of actuals.entries) {
        const pls: Player[] = []; let ok = true;
        for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
        if (!ok) continue;
        actualByHash.set(pls.map(p => p.id).sort().join('|'), e.actualPoints);
      }

      for (const v of VARIANTS) {
        const cfg: Parameters<typeof productionSelect>[2] = v.bins === null
          ? { N, lambda: 0, maxOverlap: 6, minPrimaryStack: 0, projectionFloorPct: 0.85 }
          : {
              N, lambda: 0.38, comboFreq, maxOverlap: 6, teamCapPct: 0.21,
              minPrimaryStack: 0, extremeCornerCap: false,
              projectionFloorPct: 0.85,
              binAllocation: v.bins,
            };
        const result = productionSelect(loaded.lineups, pool.players, cfg);
        const sc = scorePortfolio(result.portfolio, actuals, actualByHash, sorted, payoutTable, top1T, cashT);
        rows.push({ id: v.id, slate: s.slate, pay: sc.pay, t1: sc.t1, cash: sc.cash, scored: sc.scored });
      }
    } catch (e: any) { console.log(`${s.slate}: ERROR ${e.message}`); }
  }

  interface Summary { id: string; total: number; t1: number; cash: number; scored: number; minLoo: number; profitable: number; totalExcl03: number }
  const summaries: Summary[] = [];
  for (const v of VARIANTS) {
    const r = rows.filter(x => x.id === v.id);
    let total = 0, t1 = 0, cash = 0, scored = 0, profitable = 0, totalExcl03 = 0;
    for (const x of r) {
      total += x.pay; t1 += x.t1; cash += x.cash; scored += x.scored;
      if (x.pay > FEE * N) profitable++;
      if (x.slate !== '2026-03-03') totalExcl03 += x.pay;
    }
    const pays = r.map(x => x.pay);
    const loos = pays.map((_, i) => { let s = 0, cnt = 0; for (let j = 0; j < pays.length; j++) if (j !== i) { s += pays[j]; cnt++; } return cnt ? s / cnt : 0; });
    const minLoo = loos.length ? Math.min(...loos) : 0;
    summaries.push({ id: v.id, total, t1, cash, scored, minLoo, profitable, totalExcl03 });
  }

  summaries.sort((a, b) => b.total - a.total);

  console.log('=== RANKED BY FULL-SAMPLE (12 slates) ===\n');
  console.log('Rank | Config                                      | Total    | Excl-03-03 | min-LOO | Cash% | Profit');
  console.log('-'.repeat(115));
  for (let i = 0; i < summaries.length; i++) {
    const s = summaries[i];
    const cashPct = s.scored ? (s.cash / s.scored * 100).toFixed(1) : '0.0';
    console.log(`  ${(i + 1).toString().padStart(2)} | ${s.id.padEnd(43)} | $${s.total.toFixed(0).padStart(6)} | $${s.totalExcl03.toFixed(0).padStart(8)} | $${s.minLoo.toFixed(0).padStart(5)} | ${cashPct.padStart(4)}% | ${s.profitable}/12`);
  }

  console.log('\n=== RANKED BY EXCL-03-03 (removes the outlier slate) ===\n');
  const byExcl = [...summaries].sort((a, b) => b.totalExcl03 - a.totalExcl03);
  console.log('Rank | Config                                      | Excl-03-03 | Total    | min-LOO | Profit');
  console.log('-'.repeat(110));
  for (let i = 0; i < byExcl.length; i++) {
    const s = byExcl[i];
    console.log(`  ${(i + 1).toString().padStart(2)} | ${s.id.padEnd(43)} | $${s.totalExcl03.toFixed(0).padStart(8)} | $${s.total.toFixed(0).padStart(6)} | $${s.minLoo.toFixed(0).padStart(5)} | ${s.profitable}/12`);
  }

  // Per-slate for top 5
  console.log('\n=== PER-SLATE (top 5 by full-sample) ===\n');
  const top5 = summaries.slice(0, 5);
  const slatesSet = [...new Set(rows.map(r => r.slate))].sort();
  let hdr = 'Config'.padEnd(45) + ' |';
  for (const sl of slatesSet) hdr += ' ' + sl.slice(5).padStart(5) + ' |';
  console.log(hdr);
  console.log('-'.repeat(hdr.length));
  for (const s of top5) {
    let line = s.id.padEnd(45) + ' |';
    for (const sl of slatesSet) {
      const r = rows.find(x => x.id === s.id && x.slate === sl);
      line += ' $' + (r?.pay || 0).toFixed(0).padStart(5) + ' |';
    }
    console.log(line);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
