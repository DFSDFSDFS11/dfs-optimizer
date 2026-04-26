/**
 * Direct head-to-head: Hydra (current shipped) vs the V2 sweep's top validated winners.
 * On 13 MLB slates (11 in-sample + 2 OOS).
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
  { slate: '4-23-26', proj: '4-23-26projections.csv', actuals: '4-23-26actuals.csv',   pool: '4-23-26sspool.csv' },
  { slate: '4-24-26', proj: '4-24-26projections.csv', actuals: '4-24-26actuals.csv',   pool: '4-24-26sspool.csv' },
];
const OOS = new Set(['4-23-26', '4-24-26']);

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

interface Variant {
  id: string;
  cfg: (cf: Map<string, number>) => Parameters<typeof productionSelect>[2];
}

const VARIANTS: Variant[] = [
  { id: 'Hydra (shipped)',
    cfg: (cf) => ({ N, lambda: 0.20, comboFreq: cf, maxOverlap: 6, teamCapPct: 0.20, extremeCornerCap: true,
      binAllocation: { chalk: 0.07, core: 0.07, value: 0.58, contra: 0.12, deep: 0.16 } }) },
  { id: 'Kraken (prior)',
    cfg: (cf) => ({ N, lambda: 0.38, comboFreq: cf, maxOverlap: 6, teamCapPct: 0.21, extremeCornerCap: false,
      binAllocation: { chalk: 0.16, core: 0.13, value: 0.55, contra: 0.13, deep: 0.02 } }) },
  { id: 'Apex (older)',
    cfg: (cf) => ({ N, lambda: 0.20, comboFreq: cf, maxOverlap: 7, teamCapPct: 0.15, extremeCornerCap: true }) },
  { id: 'V2 #13 — value-extreme λ=0.14 tc=0.22',
    cfg: (cf) => ({ N, lambda: 0.14, comboFreq: cf, maxOverlap: 6, teamCapPct: 0.22, extremeCornerCap: false,
      binAllocation: { chalk: 0.05, core: 0.05, value: 0.85, contra: 0.03, deep: 0.02 } }) },
  { id: 'V2 #19 — value-extreme λ=0.10 tc=0.27',
    cfg: (cf) => ({ N, lambda: 0.10, comboFreq: cf, maxOverlap: 6, teamCapPct: 0.27, extremeCornerCap: false,
      binAllocation: { chalk: 0.05, core: 0.05, value: 0.85, contra: 0.03, deep: 0.02 } }) },
  { id: 'V2 #1 — pure-chalk (full winner)',
    cfg: (cf) => ({ N, lambda: 0.21, comboFreq: cf, maxOverlap: 6, teamCapPct: 0.18, extremeCornerCap: false,
      maxExposure: 0.17, maxExposurePitcher: 0.6, minPrimaryStack: 3,
      binAllocation: { chalk: 0.50, core: 0.30, value: 0.20, contra: 0, deep: 0 } }) },
];

async function main() {
  console.log('Hydra vs V2 winners — head-to-head on 13 slates\n');

  interface Row { id: string; slate: string; pay: number; t1: number }
  const rows: Row[] = [];

  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj); const actualsPath = path.join(DIR, s.actuals); const poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) continue;
    try {
      const pr = parseCSVFile(projPath, 'mlb', true);
      const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
      const pool = buildPlayerPool(pr.players, pr.detectedContestType);
      const actuals = parseContestActuals(actualsPath, config);
      const idMap = new Map<string, Player>(); const nameMap = new Map<string, Player>();
      for (const p of pool.players) { idMap.set(p.id, p); nameMap.set(norm(p.name), p); }
      const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
      const cf = precomputeComboFrequencies(loaded.lineups, 3);
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
      for (const v of VARIANTS) {
        const result = productionSelect(loaded.lineups, pool.players, v.cfg(cf));
        let pay = 0, t1 = 0;
        for (const lu of result.portfolio) {
          const a = scoreLineup(lu, actuals, actualByHash); if (a === null) continue;
          pay += payoutFor(a, sorted, payoutTable, actuals);
          if (a >= top1T) t1++;
        }
        rows.push({ id: v.id, slate: s.slate, pay, t1 });
      }
    } catch (e: any) { console.log(`${s.slate}: ${e.message}`); }
  }

  console.log('Variant'.padEnd(45) + ' | Full     | OOS      | min-LOO  | t1 | Profit');
  console.log('-'.repeat(105));
  for (const v of VARIANTS) {
    const r = rows.filter(x => x.id === v.id);
    let full = 0, oos = 0, t1 = 0, profitable = 0;
    for (const x of r) { full += x.pay; t1 += x.t1; if (x.pay > FEE * N) profitable++; if (OOS.has(x.slate)) oos += x.pay; }
    const pays = r.map(x => x.pay);
    const loos = pays.map((_, i) => { let s = 0, cnt = 0; for (let j = 0; j < pays.length; j++) if (j !== i) { s += pays[j]; cnt++; } return cnt ? s / cnt : 0; });
    const minLoo = loos.length ? Math.min(...loos) : 0;
    console.log(`${v.id.padEnd(45)} | $${full.toFixed(0).padStart(6)} | $${oos.toFixed(0).padStart(6)} | $${minLoo.toFixed(0).padStart(6)} | ${t1.toString().padStart(2)} | ${profitable}/${r.length}`);
  }

  console.log('\n=== Per-slate ===\n');
  const slatesL = [...new Set(rows.map(r => r.slate))].sort();
  let hdr = 'Slate    |';
  for (const v of VARIANTS) hdr += ' ' + v.id.split(' ')[0].padStart(13) + ' |';
  console.log(hdr);
  for (const sl of slatesL) {
    let line = (OOS.has(sl) ? '*' : ' ') + sl.padEnd(8) + '|';
    for (const v of VARIANTS) {
      const r = rows.find(x => x.id === v.id && x.slate === sl);
      line += ' $' + (r?.pay || 0).toFixed(0).padStart(12) + ' |';
    }
    console.log(line);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
