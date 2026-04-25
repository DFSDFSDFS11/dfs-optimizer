/**
 * Kraken out-of-sample validation: re-run on 13 MLB slates (added 4-23, 4-24
 * which were NOT part of the megabin sweep).
 *
 * Compares: shipped (λ=0.05), Apex (λ=0.20+corner), Kraken (current shipped),
 * plus a few Kraken neighbors as sanity checks.
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

const DIR = 'C:/Users/colin/dfs opto';
const N = 150;
const FEE = 20;

const SLATES = [
  { slate: '4-6-26',  proj: '4-6-26_projections.csv', actuals: 'dkactuals 4-6-26.csv', pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26',  proj: '4-8-26projections.csv',  actuals: '4-8-26actuals.csv',    pool: '4-8-26sspool.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv', actuals: '4-12-26actuals.csv',   pool: '4-12-26sspool.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv', actuals: '4-14-26actuals.csv',   pool: '4-14-26sspool.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv', actuals: '4-15-26actuals.csv',   pool: '4-15-26sspool.csv' },
  { slate: '4-17-26', proj: '4-17-26projections.csv', actuals: '4-17-26actuals.csv',   pool: '4-17-26sspool.csv' },
  { slate: '4-18-26', proj: '4-18-26projections.csv', actuals: '4-18-26actuals.csv',   pool: '4-18-26sspool.csv' },
  { slate: '4-19-26', proj: '4-19-26projections.csv', actuals: '4-19-26actuals.csv',   pool: '4-19-26sspool.csv' },
  { slate: '4-20-26', proj: '4-20-26projections.csv', actuals: '4-20-26actuals.csv',   pool: '4-20-26sspool.csv' },
  { slate: '4-21-26', proj: '4-21-26projections.csv', actuals: '4-21-26actuals.csv',   pool: '4-21-26sspool.csv' },
  { slate: '4-22-26', proj: '4-22-26projections.csv', actuals: '4-22-26actuals.csv',   pool: '4-22-26sspool.csv' },
  // OUT-OF-SAMPLE (added 2026-04-25)
  { slate: '4-23-26', proj: '4-23-26projections.csv', actuals: '4-23-26actuals.csv',   pool: '4-23-26sspool.csv' },
  { slate: '4-24-26', proj: '4-24-26projections.csv', actuals: '4-24-26actuals.csv',   pool: '4-24-26sspool.csv' },
];
const OOS = new Set(['4-23-26', '4-24-26']);
const RECENT = new Set(['4-20-26', '4-21-26', '4-22-26', '4-23-26', '4-24-26']);

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
function scorePortfolio(portfolio: Lineup[], actuals: ContestActuals, actualByHash: Map<string, number>, sorted: number[], payoutTable: Float64Array, top1T: number) {
  let pay = 0, t1 = 0, scored = 0;
  for (const lu of portfolio) {
    const a = scoreLineup(lu, actuals, actualByHash); if (a === null) continue;
    scored++; pay += payoutFor(a, sorted, payoutTable, actuals);
    if (a >= top1T) t1++;
  }
  return { pay, t1, scored };
}

interface Variant {
  id: string;
  cfg: (comboFreq: Map<string, number>) => Parameters<typeof productionSelect>[2];
}

const VARIANTS: Variant[] = [
  { id: 'OLD-shipped (λ=0.05, γ=10off, default bins)',
    cfg: (cf) => ({ N, lambda: 0.05, comboFreq: cf, maxOverlap: 10 }) },
  { id: 'Apex (λ=0.20, γ=7, corner ON, default bins)',
    cfg: (cf) => ({ N, lambda: 0.20, comboFreq: cf, maxOverlap: 7, extremeCornerCap: true }) },
  { id: 'Kraken (λ=0.38, γ=6, tc=0.21, value-heavy)',
    cfg: (cf) => ({ N, lambda: 0.38, comboFreq: cf, maxOverlap: 6, teamCapPct: 0.21,
      extremeCornerCap: false,
      binAllocation: { chalk: 0.16, core: 0.13, value: 0.55, contra: 0.13, deep: 0.02 } }) },
  { id: 'Kraken-tc15 (Kraken with safer 15% team cap)',
    cfg: (cf) => ({ N, lambda: 0.38, comboFreq: cf, maxOverlap: 6, teamCapPct: 0.15,
      extremeCornerCap: false,
      binAllocation: { chalk: 0.16, core: 0.13, value: 0.55, contra: 0.13, deep: 0.02 } }) },
  { id: 'Kraken-γ7 (Kraken with γ=7)',
    cfg: (cf) => ({ N, lambda: 0.38, comboFreq: cf, maxOverlap: 7, teamCapPct: 0.21,
      extremeCornerCap: false,
      binAllocation: { chalk: 0.16, core: 0.13, value: 0.55, contra: 0.13, deep: 0.02 } }) },
];

async function main() {
  console.log('================================================================');
  console.log('KRAKEN OUT-OF-SAMPLE VALIDATION — 13 MLB slates');
  console.log('  In-sample (1-11): 4-6 through 4-22');
  console.log('  OUT-OF-SAMPLE (12-13): 4-23, 4-24 — never seen by Kraken sweep');
  console.log('================================================================\n');

  interface Row { id: string; slate: string; pay: number; t1: number; scored: number }
  const rows: Row[] = [];
  let oosCount = 0, totalCount = 0;

  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj); const actualsPath = path.join(DIR, s.actuals); const poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) { console.log(`skip ${s.slate} (missing files)`); continue; }
    try {
      const pr = parseCSVFile(projPath, 'mlb', true);
      const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
      const pool = buildPlayerPool(pr.players, pr.detectedContestType);
      const actuals = parseContestActuals(actualsPath, config);
      const idMap = new Map<string, Player>(); const nameMap = new Map<string, Player>();
      for (const p of pool.players) { idMap.set(p.id, p); nameMap.set(norm(p.name), p); }
      const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
      const comboFreq = precomputeComboFrequencies(loaded.lineups, 3);
      const F = actuals.entries.length;
      const sorted = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
      const top1T = sorted[Math.max(0, Math.floor(F * 0.01) - 1)] || 0;
      const payoutTable = buildPayoutTable(F);
      const actualByHash = new Map<string, number>();
      for (const e of actuals.entries) {
        const pls: Player[] = []; let ok = true;
        for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
        if (!ok) continue;
        actualByHash.set(pls.map(p => p.id).sort().join('|'), e.actualPoints);
      }
      totalCount++;
      if (OOS.has(s.slate)) oosCount++;

      for (const v of VARIANTS) {
        const result = productionSelect(loaded.lineups, pool.players, v.cfg(comboFreq));
        const sc = scorePortfolio(result.portfolio, actuals, actualByHash, sorted, payoutTable, top1T);
        rows.push({ id: v.id, slate: s.slate, pay: sc.pay, t1: sc.t1, scored: sc.scored });
      }
    } catch (e: any) { console.log(`${s.slate}: ERROR ${e.message}`); }
  }

  console.log(`\n${totalCount} slates loaded (${oosCount} out-of-sample).\n`);

  interface Summary { id: string; full: number; insample: number; oos: number; recent: number; minLoo: number; profitable: number; t1: number; oosT1: number }
  const summaries: Summary[] = [];
  for (const v of VARIANTS) {
    const r = rows.filter(x => x.id === v.id);
    let full = 0, insample = 0, oos = 0, recent = 0, profitable = 0, t1 = 0, oosT1 = 0;
    for (const x of r) {
      full += x.pay; t1 += x.t1;
      if (x.pay > FEE * N) profitable++;
      if (OOS.has(x.slate)) { oos += x.pay; oosT1 += x.t1; }
      else insample += x.pay;
      if (RECENT.has(x.slate)) recent += x.pay;
    }
    const pays = r.map(x => x.pay);
    const loos = pays.map((_, i) => { let s = 0, cnt = 0; for (let j = 0; j < pays.length; j++) if (j !== i) { s += pays[j]; cnt++; } return cnt ? s / cnt : 0; });
    const minLoo = loos.length ? Math.min(...loos) : 0;
    summaries.push({ id: v.id, full, insample, oos, recent, minLoo, profitable, t1, oosT1 });
  }

  summaries.sort((a, b) => b.full - a.full);

  console.log('=== FULL-SAMPLE (13 slates including OOS) ===\n');
  console.log('Rank | Variant                                              | Full     | In-sample (11) | OOS (2)  | Recent 5 | min-LOO | Profit | t1');
  console.log('-'.repeat(135));
  for (let i = 0; i < summaries.length; i++) {
    const s = summaries[i];
    console.log(`  ${(i + 1).toString().padStart(2)} | ${s.id.padEnd(53)} | $${s.full.toFixed(0).padStart(6)} | $${s.insample.toFixed(0).padStart(8)}      | $${s.oos.toFixed(0).padStart(5)} | $${s.recent.toFixed(0).padStart(6)} | $${s.minLoo.toFixed(0).padStart(5)} | ${s.profitable}/${rows.filter(x => x.id === s.id).length} | ${s.t1}`);
  }

  console.log('\n=== OUT-OF-SAMPLE ONLY (4-23, 4-24) — does Kraken hold? ===\n');
  const byOos = [...summaries].sort((a, b) => b.oos - a.oos);
  for (const s of byOos) {
    console.log(`  ${s.id.padEnd(53)} | OOS $${s.oos.toFixed(0).padStart(5)} | t1=${s.oosT1}`);
  }

  // Per-slate detail for OOS
  console.log('\n=== PER-SLATE (OOS only) ===\n');
  console.log('Variant                                              | 4-23-26 | 4-24-26');
  for (const s of summaries) {
    const r23 = rows.find(x => x.id === s.id && x.slate === '4-23-26');
    const r24 = rows.find(x => x.id === s.id && x.slate === '4-24-26');
    console.log(`  ${s.id.padEnd(53)} | $${(r23?.pay || 0).toFixed(0).padStart(5)} | $${(r24?.pay || 0).toFixed(0).padStart(5)}`);
  }

  // Honest comparison: Kraken vs OLD-shipped on OOS only
  const krakenOos = summaries.find(s => s.id.includes('Kraken (λ='))?.oos || 0;
  const apexOos = summaries.find(s => s.id.includes('Apex'))?.oos || 0;
  const oldOos = summaries.find(s => s.id.includes('OLD-shipped'))?.oos || 0;
  console.log('\n=== OOS PAIRWISE DELTAS ===');
  console.log(`  Kraken vs OLD-shipped: ${krakenOos - oldOos >= 0 ? '+' : ''}$${(krakenOos - oldOos).toFixed(0)}`);
  console.log(`  Kraken vs Apex:        ${krakenOos - apexOos >= 0 ? '+' : ''}$${(krakenOos - apexOos).toFixed(0)}`);
  console.log(`  Apex vs OLD-shipped:   ${apexOos - oldOos >= 0 ? '+' : ''}$${(apexOos - oldOos).toFixed(0)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
