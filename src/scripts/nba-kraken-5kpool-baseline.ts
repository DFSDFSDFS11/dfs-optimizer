/**
 * Run shipped Kraken-NBA on the same 5K-sampled actuals pools used in
 * nba-megabin-5k-pool.ts. Produces apples-to-apples comparison.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import {
  parseCSVFile, buildPlayerPool, parseContestActuals, ContestActuals,
} from '../parser';
import { getContestConfig } from '../rules';
import { productionSelect } from '../selection/production-selector';
import { precomputeComboFrequencies } from '../selection/combo-leverage';

const HIST_DIR = 'C:/Users/colin/Projects/dfs-optimizer/historical_slates';
const FEE = 20;
const N = 150;
const POOL_SAMPLE_SIZE = 5000;

const NBA_SLATES = [
  { slate: '2026-01-16', proj: '2026-01-16_projections.csv', actuals: '2026-01-16_actuals.csv' },
  { slate: '2026-01-17', proj: '2026-01-17_projections.csv', actuals: '2026-01-17_actuals.csv' },
  { slate: '2026-01-18', proj: '2026-01-18_projections.csv', actuals: '2026-01-18_actuals.csv' },
  { slate: '2026-01-19', proj: '2026-01-19_projections.csv', actuals: '2026-01-19_actuals.csv' },
  { slate: '2026-01-20', proj: '2026-01-20_projections.csv', actuals: '2026-01-20_actuals.csv' },
  { slate: '2026-02-25', proj: '2026-02-25_projections.csv', actuals: '2026-02-25_actuals.csv' },
  { slate: '2026-02-26', proj: '2026-02-26_projections.csv', actuals: '2026-02-26_actuals.csv' },
  { slate: '2026-02-27', proj: '2026-02-27_projections.csv', actuals: '2026-02-27_actuals.csv' },
  { slate: '2026-02-28', proj: '2026-02-28_projections.csv', actuals: '2026-02-28_actuals.csv' },
  { slate: '2026-03-03', proj: '2026-03-03_projections.csv', actuals: '2026-03-03_actuals.csv' },
  { slate: '2026-03-05', proj: '2026-03-05_dk_projections.csv', actuals: '2026-03-05_dk_actuals.csv' },
  { slate: '2026-03-06', proj: '2026-03-06_dk_projections.csv', actuals: '2026-03-06_dk_actuals.csv' },
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

async function main() {
  // Use a fixed seed-style behavior: same Math.random sequence as the megabin run was unpredictable.
  // For reproducibility we just run once and report.
  console.log('Shipped Kraken-NBA on 5K-sampled actuals pools (12 NBA slates)\n');

  let total = 0;
  const rows: { slate: string; F: number; pay: number; profitable: boolean; pool: number }[] = [];

  for (const s of NBA_SLATES) {
    const projPath = path.join(HIST_DIR, s.proj);
    const actualsPath = path.join(HIST_DIR, s.actuals);
    if (!fs.existsSync(projPath) || !fs.existsSync(actualsPath)) {
      console.log(s.slate + ': MISSING'); continue;
    }
    const pr = parseCSVFile(projPath, 'nba', true);
    const config = getContestConfig('dk', 'nba', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);
    const idMap = new Map<string, Player>();
    const nameMap = new Map<string, Player>();
    for (const p of pool.players) { idMap.set(p.id, p); nameMap.set(norm(p.name), p); }

    // Build candidates from actuals (same logic as 5K-pool sweep)
    const seen = new Set<string>();
    const all: Lineup[] = [];
    for (const e of actuals.entries) {
      const players: Player[] = [];
      let ok = true;
      for (const nm of e.playerNames) {
        const p = nameMap.get(norm(nm));
        if (!p) { ok = false; break; }
        players.push(p);
      }
      if (!ok || players.length !== config.rosterSize) continue;
      const h = players.map(p => p.id).sort().join('|');
      if (seen.has(h)) continue;
      seen.add(h);
      const salary = players.reduce((s, p) => s + p.salary, 0);
      if (salary > config.salaryCap) continue;
      const projection = players.reduce((s, p) => s + (p.projection || 0), 0);
      const ownership = players.reduce((s, p) => s + (p.ownership || 0), 0);
      all.push({ players, salary, projection, ownership, hash: h });
    }

    let candidates: Lineup[];
    if (all.length <= POOL_SAMPLE_SIZE) candidates = all;
    else {
      candidates = all.slice(0, POOL_SAMPLE_SIZE);
      for (let i = POOL_SAMPLE_SIZE; i < all.length; i++) {
        const j = Math.floor(Math.random() * (i + 1));
        if (j < POOL_SAMPLE_SIZE) candidates[j] = all[i];
      }
    }

    const F = actuals.entries.length;
    const sorted = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
    const payoutTable = buildPayoutTable(F);
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

    const comboFreq = precomputeComboFrequencies(candidates, 3);

    // Shipped Kraken-NBA params
    const result = productionSelect(candidates, pool.players, {
      N, lambda: 0.38, comboFreq, maxOverlap: 6, teamCapPct: 0.21,
      minPrimaryStack: 0, maxExposure: 0.30, projectionFloorPct: 0.85,
      extremeCornerCap: false,
      binAllocation: { chalk: 0.25, core: 0.15, value: 0.55, contra: 0.05, deep: 0 },
    });

    let pay = 0;
    for (const lu of result.portfolio) {
      const h = lu.players.map(p => p.id).sort().join('|');
      const a = actualByHash.get(h);
      if (a === undefined) continue;
      pay += payoutFor(a, sorted, payoutTable, actuals);
    }
    const profitable = pay > FEE * N;
    rows.push({ slate: s.slate, F, pay, profitable, pool: candidates.length });
    total += pay;
    console.log(s.slate + ' F=' + F + ' pool=' + candidates.length + ' pay=$' + pay.toFixed(0) + ' (' + (profitable ? 'PROFIT' : 'loss') + ')');
  }

  console.log('\n================================================================');
  console.log('Total: $' + total.toFixed(0));
  const fees = NBA_SLATES.length * FEE * N;
  console.log('Fees:  $' + fees.toFixed(0));
  console.log('ROI:   ' + ((total / fees - 1) * 100).toFixed(1) + '%');
  console.log('Profitable slates: ' + rows.filter(r => r.profitable).length + '/' + rows.length);
}

main().catch(e => { console.error(e); process.exit(1); });
