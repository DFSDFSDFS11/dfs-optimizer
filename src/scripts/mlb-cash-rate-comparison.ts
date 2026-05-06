/**
 * Cash-rate comparison across selectors + tweaks to raise Config B's cash rate.
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
];

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }

function buildPayoutTable(F: number): Float64Array {
  const pool = F * FEE * 0.88; const cashLine = Math.floor(F * 0.22);
  const raw = new Float64Array(cashLine); let rawSum = 0;
  for (let r = 0; r < cashLine; r++) { raw[r] = Math.pow(r + 1, -1.15); rawSum += raw[r]; }
  const table = new Float64Array(F); const minCash = FEE * 1.2;
  for (let r = 0; r < cashLine; r++) table[r] = Math.max(minCash, (raw[r] / rawSum) * pool);
  let tSum = 0; for (let r = 0; r < cashLine; r++) tSum += table[r];
  const scale = pool / tSum;
  for (let r = 0; r < cashLine; r++) table[r] *= scale;
  return table;
}

function scoreLineup(lu: Lineup, actuals: ContestActuals, actualByHash: Map<string, number>): number | null {
  const h = lu.players.map(p => p.id).sort().join('|');
  const fa = actualByHash.get(h);
  if (fa !== undefined) return fa;
  let t = 0;
  for (const p of lu.players) { const r = actuals.playerActualsByName.get(norm(p.name)); if (!r) return null; t += r.fpts; }
  return t;
}

function payoutFor(actual: number, sortedScores: number[], payoutTable: Float64Array, actuals: ContestActuals): number {
  let lo = 0, hi = sortedScores.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (sortedScores[m] >= actual) lo = m + 1; else hi = m; }
  const rank = Math.max(1, lo);
  const pay = rank <= payoutTable.length ? payoutTable[rank - 1] : 0;
  if (pay <= 0) return 0;
  let co = 0;
  for (const e of actuals.entries) if (Math.abs(e.actualPoints - actual) <= 0.25) co++;
  co = Math.max(0, co - 1);
  return pay / Math.sqrt(1 + co * 0.5);
}

interface SlateData {
  slate: string;
  candidates: Lineup[];
  players: Player[];
  comboFreq: Map<string, number>;
  actuals: ContestActuals;
  actualByHash: Map<string, number>;
  sorted: number[];
  cashThresh: number;
  payoutTable: Float64Array;
  F: number;
}

async function loadSlate(s: typeof SLATES[0]): Promise<SlateData | null> {
  const projPath = path.join(DIR, s.proj); const actualsPath = path.join(DIR, s.actuals); const poolPath = path.join(DIR, s.pool);
  if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) return null;
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
  const cashThresh = sorted[Math.floor(F * 0.22) - 1] || 0;
  const payoutTable = buildPayoutTable(F);
  const actualByHash = new Map<string, number>();
  for (const e of actuals.entries) {
    const pls: Player[] = []; let ok = true;
    for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
    if (!ok) continue;
    actualByHash.set(pls.map(p => p.id).sort().join('|'), e.actualPoints);
  }
  return {
    slate: s.slate, candidates: loaded.lineups, players: pool.players, comboFreq,
    actuals, actualByHash, sorted, cashThresh, payoutTable, F,
  };
}

interface Result { portfolio: Lineup[] }
type Variant = { id: string; run: (sd: SlateData) => Result };

const VARIANTS: Variant[] = [
  { id: 'Config-B (current shipped)',
    run: (sd) => productionSelect(sd.candidates, sd.players, { N, lambda: 0.20, comboFreq: sd.comboFreq, maxOverlap: 7, extremeCornerCap: true }) as any,
  },
  // PROJECTION-focused variants (should lift cash rate)
  { id: 'B + projFloor 0.90',
    run: (sd) => productionSelect(sd.candidates, sd.players, { N, lambda: 0.20, comboFreq: sd.comboFreq, maxOverlap: 7, extremeCornerCap: true, projectionFloorPct: 0.90 }) as any,
  },
  { id: 'B + projFloor 0.92',
    run: (sd) => productionSelect(sd.candidates, sd.players, { N, lambda: 0.20, comboFreq: sd.comboFreq, maxOverlap: 7, extremeCornerCap: true, projectionFloorPct: 0.92 }) as any,
  },
  { id: 'B + projFloor 0.94',
    run: (sd) => productionSelect(sd.candidates, sd.players, { N, lambda: 0.20, comboFreq: sd.comboFreq, maxOverlap: 7, extremeCornerCap: true, projectionFloorPct: 0.94 }) as any,
  },
  // Less contrarian bin shifts
  { id: 'B + bins 15/35/30/15/5 (moderate)',
    run: (sd) => productionSelect(sd.candidates, sd.players, { N, lambda: 0.20, comboFreq: sd.comboFreq, maxOverlap: 7, extremeCornerCap: true,
      binAllocation: { chalk: 0.15, core: 0.35, value: 0.30, contra: 0.15, deep: 0.05 } }) as any,
  },
  { id: 'B + bins 15/40/30/10/5 (core-heavy)',
    run: (sd) => productionSelect(sd.candidates, sd.players, { N, lambda: 0.20, comboFreq: sd.comboFreq, maxOverlap: 7, extremeCornerCap: true,
      binAllocation: { chalk: 0.15, core: 0.40, value: 0.30, contra: 0.10, deep: 0.05 } }) as any,
  },
  { id: 'B + bins 20/35/30/10/5 (chalk-heavy)',
    run: (sd) => productionSelect(sd.candidates, sd.players, { N, lambda: 0.20, comboFreq: sd.comboFreq, maxOverlap: 7, extremeCornerCap: true,
      binAllocation: { chalk: 0.20, core: 0.35, value: 0.30, contra: 0.10, deep: 0.05 } }) as any,
  },
  // Lower combo leverage (simpler = less GPP weird)
  { id: 'B with λ=0.10 (less combo push)',
    run: (sd) => productionSelect(sd.candidates, sd.players, { N, lambda: 0.10, comboFreq: sd.comboFreq, maxOverlap: 7, extremeCornerCap: true }) as any,
  },
  // Baselines for comparison (no corner, various λ)
  { id: 'prod-shipped (λ=0.05, no corner)',
    run: (sd) => productionSelect(sd.candidates, sd.players, { N, lambda: 0.05, comboFreq: sd.comboFreq, maxOverlap: 7 }) as any,
  },
  { id: 'prod-λ0.20 (no corner)',
    run: (sd) => productionSelect(sd.candidates, sd.players, { N, lambda: 0.20, comboFreq: sd.comboFreq, maxOverlap: 7 }) as any,
  },
  { id: 'pure projection (λ=0)',
    run: (sd) => productionSelect(sd.candidates, sd.players, { N, lambda: 0, maxOverlap: 7 }) as any,
  },
  // Most cash-rate-favorable theoretical setup
  { id: 'Cash-max: λ=0, projFloor 0.94, chalk-heavy',
    run: (sd) => productionSelect(sd.candidates, sd.players, { N, lambda: 0, maxOverlap: 7, projectionFloorPct: 0.94,
      binAllocation: { chalk: 0.25, core: 0.40, value: 0.25, contra: 0.08, deep: 0.02 } }) as any,
  },
];

async function main() {
  console.log('================================================================');
  console.log('MLB CASH-RATE COMPARISON — variants tested against Config B');
  console.log('================================================================\n');

  const cache: SlateData[] = [];
  for (const s of SLATES) {
    console.log(`Loading ${s.slate}...`);
    try { const c = await loadSlate(s); if (c) cache.push(c); } catch (e: any) { console.log(`  skip: ${e.message}`); }
  }
  console.log(`${cache.length} slates loaded.\n`);

  interface Summary { variant: string; lineups: number; cash: number; t10: number; t5: number; t1: number; totalPay: number; profitable: number }
  const summaries: Summary[] = [];

  for (const v of VARIANTS) {
    let lineups = 0, cash = 0, t10 = 0, t5 = 0, t1 = 0, totalPay = 0, profitable = 0;
    for (const sd of cache) {
      const result = v.run(sd);
      const t10T = sd.sorted[Math.max(0, Math.floor(sd.F * 0.10) - 1)] || 0;
      const t5T = sd.sorted[Math.max(0, Math.floor(sd.F * 0.05) - 1)] || 0;
      const t1T = sd.sorted[Math.max(0, Math.floor(sd.F * 0.01) - 1)] || 0;
      let slatePay = 0;
      for (const lu of result.portfolio) {
        const a = scoreLineup(lu, sd.actuals, sd.actualByHash);
        if (a === null) continue;
        lineups++;
        if (a >= sd.cashThresh) cash++;
        if (a >= t10T) t10++;
        if (a >= t5T) t5++;
        if (a >= t1T) t1++;
        const p = payoutFor(a, sd.sorted, sd.payoutTable, sd.actuals);
        slatePay += p; totalPay += p;
      }
      if (slatePay > FEE * N) profitable++;
    }
    summaries.push({ variant: v.id, lineups, cash, t10, t5, t1, totalPay, profitable });
  }

  // Sort by cash rate
  summaries.sort((a, b) => (b.cash / b.lineups) - (a.cash / a.lineups));

  console.log('\nRanked by CASH RATE:\n');
  console.log('Rank | Variant                                          | Cash%  | Top-10% | Top-5% | Top-1% | Payout  | Profit');
  console.log('-'.repeat(125));
  for (let i = 0; i < summaries.length; i++) {
    const s = summaries[i];
    const cashPct = (s.cash / s.lineups * 100).toFixed(1);
    const t10Pct = (s.t10 / s.lineups * 100).toFixed(1);
    const t5Pct = (s.t5 / s.lineups * 100).toFixed(1);
    const t1Pct = (s.t1 / s.lineups * 100).toFixed(1);
    console.log(`  ${(i + 1).toString().padStart(2)} | ${s.variant.padEnd(48)} | ${cashPct.padStart(4)}% | ${t10Pct.padStart(5)}% | ${t5Pct.padStart(4)}% | ${t1Pct.padStart(4)}% | $${s.totalPay.toFixed(0).padStart(6)} | ${s.profitable}/${cache.length}`);
  }

  console.log('\n\nRanked by PAYOUT (ROI reference):\n');
  const byPay = [...summaries].sort((a, b) => b.totalPay - a.totalPay);
  for (let i = 0; i < byPay.length; i++) {
    const s = byPay[i];
    const cashPct = (s.cash / s.lineups * 100).toFixed(1);
    console.log(`  ${(i + 1).toString().padStart(2)} | ${s.variant.padEnd(48)} | Pay $${s.totalPay.toFixed(0).padStart(6)} | Cash ${cashPct.padStart(4)}% | Top-1% ${((s.t1 / s.lineups) * 100).toFixed(1)}% | Profit ${s.profitable}/${cache.length}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
