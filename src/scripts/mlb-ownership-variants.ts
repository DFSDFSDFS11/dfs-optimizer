/**
 * MLB Ownership-Penalty Variants — test lighter and heavier ownership penalties
 * on top of prod-λ0.20 (the current standout) and prod-shipped.
 *
 * Two knobs:
 *   ownDropPP: target ownership = anchor - ownDropPP.  Smaller = lighter penalty.
 *   binAllocation: distribution across 5 ownership bins. Shift right = lighter penalty.
 *
 * Baseline: ownDropPP=6, binAllocation=10/30/35/20/5 (default).
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import {
  parseCSVFile,
  buildPlayerPool,
  parseContestActuals,
  loadPoolFromCSV,
  ContestActuals,
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

const RECENT = new Set(['4-18-26', '4-19-26', '4-20-26', '4-21-26', '4-22-26']);

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

function scoreLineup(lu: Lineup, actuals: ContestActuals, actualByHash: Map<string, number>): number | null {
  const h = lu.players.map(p => p.id).sort().join('|');
  const fa = actualByHash.get(h);
  if (fa !== undefined) return fa;
  let t = 0;
  for (const p of lu.players) {
    const r = actuals.playerActualsByName.get(norm(p.name));
    if (!r) return null;
    t += r.fpts;
  }
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

function scorePortfolio(portfolio: Lineup[], actuals: ContestActuals, actualByHash: Map<string, number>, sorted: number[], payoutTable: Float64Array, top1Thresh: number) {
  let pay = 0, t1 = 0;
  for (const lu of portfolio) {
    const a = scoreLineup(lu, actuals, actualByHash);
    if (a === null) continue;
    pay += payoutFor(a, sorted, payoutTable, actuals);
    if (a >= top1Thresh) t1++;
  }
  return { pay, t1 };
}

interface Variant {
  id: string;
  desc: string;
  cfg: Parameters<typeof productionSelect>[2];
}

const BASE_λ = 0.20;

const VARIANTS: Variant[] = [
  { id: 'baseline(λ.20)',        desc: 'ownDrop=6, bins 10/30/35/20/5 (current λ=0.20 baseline)',
    cfg: { lambda: BASE_λ, maxOverlap: 7 } },
  { id: 'ownDrop3(λ.20)',         desc: 'ownDrop=3 (lighter penalty)',
    cfg: { lambda: BASE_λ, maxOverlap: 7, ownDropPP: 3 } },
  { id: 'ownDrop4(λ.20)',         desc: 'ownDrop=4 (lighter)',
    cfg: { lambda: BASE_λ, maxOverlap: 7, ownDropPP: 4 } },
  { id: 'ownDrop8(λ.20)',         desc: 'ownDrop=8 (heavier)',
    cfg: { lambda: BASE_λ, maxOverlap: 7, ownDropPP: 8 } },
  { id: 'binChalkHeavy(λ.20)',   desc: 'bins 20/40/25/10/5 (chalk-heavy, lighter penalty)',
    cfg: { lambda: BASE_λ, maxOverlap: 7, binAllocation: { chalk: 0.20, core: 0.40, value: 0.25, contra: 0.10, deep: 0.05 } } },
  { id: 'binCoreHeavy(λ.20)',    desc: 'bins 10/45/30/10/5 (core-heavy, moderate)',
    cfg: { lambda: BASE_λ, maxOverlap: 7, binAllocation: { chalk: 0.10, core: 0.45, value: 0.30, contra: 0.10, deep: 0.05 } } },
  { id: 'binModerate(λ.20)',     desc: 'bins 15/35/30/15/5 (balanced, slightly lighter)',
    cfg: { lambda: BASE_λ, maxOverlap: 7, binAllocation: { chalk: 0.15, core: 0.35, value: 0.30, contra: 0.15, deep: 0.05 } } },
  { id: 'ownDrop3+chalkHeavy',    desc: 'ownDrop=3 + bins 20/40/25/10/5 (combined lighter)',
    cfg: { lambda: BASE_λ, maxOverlap: 7, ownDropPP: 3, binAllocation: { chalk: 0.20, core: 0.40, value: 0.25, contra: 0.10, deep: 0.05 } } },
  { id: 'ownDrop4+moderate',      desc: 'ownDrop=4 + bins 15/35/30/15/5 (gentle shift)',
    cfg: { lambda: BASE_λ, maxOverlap: 7, ownDropPP: 4, binAllocation: { chalk: 0.15, core: 0.35, value: 0.30, contra: 0.15, deep: 0.05 } } },
];

async function main() {
  console.log('================================================================');
  console.log(`MLB OWNERSHIP-LIGHTER VARIANTS — all with λ=${BASE_λ}, γ=7`);
  console.log('================================================================\n');

  interface Row { slate: string; variant: string; pay: number; t1: number }
  const rows: Row[] = [];

  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj);
    const actualsPath = path.join(DIR, s.actuals);
    const poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) { console.log(`  skip ${s.slate} (missing)`); continue; }
    try {
      const pr = parseCSVFile(projPath, 'mlb', true);
      const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
      const pool = buildPlayerPool(pr.players, pr.detectedContestType);
      const actuals = parseContestActuals(actualsPath, config);
      const idMap = new Map<string, Player>();
      const nameMap = new Map<string, Player>();
      for (const p of pool.players) { idMap.set(p.id, p); nameMap.set(norm(p.name), p); }
      const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
      const comboFreq = precomputeComboFrequencies(loaded.lineups, 3);
      const F = actuals.entries.length;
      const sorted = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
      const payoutTable = buildPayoutTable(F);
      const top1Thresh = sorted[Math.max(0, Math.floor(F * 0.01) - 1)] || 0;
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

      for (const v of VARIANTS) {
        const result = productionSelect(loaded.lineups, pool.players, { N, ...v.cfg, comboFreq });
        const sc = scorePortfolio(result.portfolio, actuals, actualByHash, sorted, payoutTable, top1Thresh);
        rows.push({ slate: s.slate, variant: v.id, pay: sc.pay, t1: sc.t1 });
      }
    } catch (e: any) {
      console.log(`  ${s.slate}: LOAD ERR ${e.message}`);
    }
  }

  // Aggregate
  interface Summary { variant: string; full: number; fullT1: number; recent: number; recentT1: number; slates: number; recentSlates: number; profitable: number; }
  const summaries: Summary[] = [];
  for (const v of VARIANTS) {
    const vRows = rows.filter(r => r.variant === v.id);
    let full = 0, fullT1 = 0, recent = 0, recentT1 = 0, slates = 0, recentSlates = 0, profitable = 0;
    for (const r of vRows) {
      full += r.pay; fullT1 += r.t1; slates++;
      if (r.pay > FEE * N) profitable++;
      if (RECENT.has(r.slate)) { recent += r.pay; recentT1 += r.t1; recentSlates++; }
    }
    summaries.push({ variant: v.id, full, fullT1, recent, recentT1, slates, recentSlates, profitable });
  }
  summaries.sort((a, b) => b.full - a.full);

  console.log('\n===== FULL-SAMPLE =====\n');
  console.log('Rank | Variant                 | Full Pay  | Full ROI  | Recent   | Recent ROI | t1 | Profitable');
  console.log('-----|-------------------------|-----------|-----------|----------|------------|----|----------');
  for (let i = 0; i < summaries.length; i++) {
    const s = summaries[i];
    const cost = FEE * N * s.slates;
    const recentCost = FEE * N * s.recentSlates;
    const roi = cost > 0 ? ((s.full / cost - 1) * 100).toFixed(1) : '—';
    const recentROI = recentCost > 0 ? ((s.recent / recentCost - 1) * 100).toFixed(1) : '—';
    console.log(
      `  ${(i + 1).toString().padStart(2)} | ${s.variant.padEnd(23)} | $${s.full.toFixed(0).padStart(7)} | ${roi.padStart(6)}% | $${s.recent.toFixed(0).padStart(6)} | ${recentROI.padStart(7)}% | ${s.fullT1.toString().padStart(2)} | ${s.profitable}/${s.slates}`
    );
  }

  // Recent-sorted
  console.log('\n===== RECENT-SLATES RANKING =====\n');
  const recentSorted = [...summaries].sort((a, b) => b.recent - a.recent);
  console.log('Rank | Variant                 | Recent Pay | Recent ROI | t1');
  console.log('-----|-------------------------|------------|------------|----');
  for (let i = 0; i < recentSorted.length; i++) {
    const s = recentSorted[i];
    const cost = FEE * N * s.recentSlates;
    const roi = cost > 0 ? ((s.recent / cost - 1) * 100).toFixed(1) : '—';
    console.log(`  ${(i + 1).toString().padStart(2)} | ${s.variant.padEnd(23)} | $${s.recent.toFixed(0).padStart(8)} | ${roi.padStart(8)}% | ${s.recentT1}`);
  }

  // Per-slate heatmap
  console.log('\n===== PER-SLATE PAYOUT =====\n');
  const slatesList = [...new Set(rows.map(r => r.slate))].sort();
  let header = 'Variant                   |';
  for (const sl of slatesList) header += ` ${sl.padStart(9)} |`;
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const v of VARIANTS) {
    let line = v.id.padEnd(26) + '|';
    for (const sl of slatesList) {
      const r = rows.find(x => x.variant === v.id && x.slate === sl);
      line += ` $${(r?.pay || 0).toFixed(0).padStart(7)} |`;
    }
    console.log(line);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
