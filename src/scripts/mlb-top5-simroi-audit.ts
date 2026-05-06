/**
 * The real-money question: does SaberSim's post-contest sim-ROI sub-selection
 * systematically beat or lose against our full 150 on actual payouts?
 *
 * Pipeline:
 *   1. Run prod-shipped + prod-λ0.20 to get 150 lineups each.
 *   2. For each 150, rank by SaberSim's sim-ROI from the pool CSV.
 *   3. Compare actual payouts of: top-5 by sim-ROI  vs  150 mean-per-lineup  vs  pool top-5 by sim-ROI
 *   4. Report per-slate and aggregate.
 *
 * Contest column: "Large Slate | 10k-50k" (matches audit-sim-roi.ts default).
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
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
const TOP_K = 5;
const FEE = 20;
const ROI_COL = 'Large Slate | 10k-50k';

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

function parsePoolROI(filePath: string, rosterSize: number, roiCol: string): Map<string, number> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const records: string[][] = parse(content, {
    columns: false, skip_empty_lines: true, relax_column_count: true, trim: true,
  });
  if (records.length < 2) return new Map();
  const headers = records[0];
  const roiIdx = headers.findIndex(h => h.trim() === roiCol);
  if (roiIdx === -1) return new Map();
  const hashMap = new Map<string, number>();
  for (let r = 1; r < records.length; r++) {
    const row = records[r];
    const ids: string[] = [];
    for (let i = 0; i < rosterSize; i++) if (row[i]) ids.push(row[i]);
    if (ids.length !== rosterSize) continue;
    const hash = [...ids].sort().join('|');
    const v = parseFloat(row[roiIdx]);
    if (!isNaN(v)) hashMap.set(hash, v);
  }
  return hashMap;
}

function scoreLineup(
  lu: Lineup,
  actuals: ContestActuals,
  actualByHash: Map<string, number>,
): number | null {
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

function payoutFor(
  actual: number,
  sortedScores: number[],
  payoutTable: Float64Array,
  actuals: ContestActuals,
): number {
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

interface LineupResult {
  hash: string;
  actual: number | null;
  payout: number;
  simROI: number | null;
}

interface SlateRow {
  slate: string;
  configName: string;
  full150: { pay: number; mean: number; t1: number; scored: number; entryCost: number };
  top5BySim: { pay: number; t1: number; scored: number; entryCost: number; lineups: number[] /* sim ROIs */ };
  poolTop5BySim: { pay: number; t1: number; scored: number; entryCost: number };
  randomBaseline5: { pay: number; t1: number };           // deterministic: top 5 by PROJECTION from our 150
}

async function evaluateConfig(
  configName: string,
  runSelect: (pool: Lineup[], players: Player[], comboFreq: Map<string, number>) => Lineup[],
): Promise<SlateRow[]> {
  const rows: SlateRow[] = [];

  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj);
    const actualsPath = path.join(DIR, s.actuals);
    const poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) continue;
    let pr, config, pool, actuals, loaded, actualByHash, idMap, nameMap, comboFreq, F, sorted, payoutTable, top1Thresh, roiByHash;
    try {
      pr = parseCSVFile(projPath, 'mlb', true);
      config = getContestConfig('dk', 'mlb', pr.detectedContestType);
      pool = buildPlayerPool(pr.players, pr.detectedContestType);
      actuals = parseContestActuals(actualsPath, config);
      idMap = new Map<string, Player>();
      nameMap = new Map<string, Player>();
      for (const p of pool.players) { idMap.set(p.id, p); nameMap.set(norm(p.name), p); }
      loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
      comboFreq = precomputeComboFrequencies(loaded.lineups, 3);
      F = actuals.entries.length;
      sorted = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
      payoutTable = buildPayoutTable(F);
      top1Thresh = sorted[Math.max(0, Math.floor(F * 0.01) - 1)] || 0;
      actualByHash = new Map<string, number>();
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
      roiByHash = parsePoolROI(poolPath, config.rosterSize, ROI_COL);
    } catch (e: any) {
      console.log(`  ${s.slate}: LOAD ERROR — ${e.message || String(e)}`);
      continue;
    }
    if (roiByHash.size === 0) {
      console.log(`  ${s.slate}: no ROI column (${ROI_COL})`);
      continue;
    }

    // 1. Run our selector
    const portfolio = runSelect(loaded.lineups, pool.players, comboFreq);

    // 2. Score every lineup + attach sim ROI
    const results: LineupResult[] = [];
    for (const lu of portfolio) {
      const h = lu.players.map(p => p.id).sort().join('|');
      const actual = scoreLineup(lu, actuals, actualByHash);
      const pay = actual !== null ? payoutFor(actual, sorted, payoutTable, actuals) : 0;
      const simROI = roiByHash.get(h) ?? null;
      results.push({ hash: h, actual, payout: pay, simROI });
    }

    // 3. Compute metrics
    const scored = results.filter(r => r.actual !== null);
    const full150Pay = scored.reduce((a, r) => a + r.payout, 0);
    const full150T1 = scored.filter(r => (r.actual ?? 0) >= top1Thresh).length;

    // top-5 by sim ROI (only among lineups WITH simROI data)
    const simRanked = results.filter(r => r.simROI !== null)
      .sort((a, b) => (b.simROI ?? 0) - (a.simROI ?? 0));
    const top5 = simRanked.slice(0, TOP_K);
    const top5Scored = top5.filter(r => r.actual !== null);
    const top5Pay = top5Scored.reduce((a, r) => a + r.payout, 0);
    const top5T1 = top5Scored.filter(r => (r.actual ?? 0) >= top1Thresh).length;

    // Pool top-5 by sim ROI (absolute best of the 5000-lineup sspool, not from our 150)
    const poolRanked = [...roiByHash.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 200); // take top-200 for safety — we'll filter to those with actuals
    let poolTop5Pay = 0, poolTop5T1 = 0, poolTop5Scored = 0, taken = 0;
    const candidatesByHash = new Map<string, Lineup>();
    for (const lu of loaded.lineups) candidatesByHash.set(lu.players.map(p => p.id).sort().join('|'), lu);
    for (const [hash, _] of poolRanked) {
      if (taken >= TOP_K) break;
      const lu = candidatesByHash.get(hash);
      if (!lu) continue;
      const actual = scoreLineup(lu, actuals, actualByHash);
      if (actual === null) continue;
      poolTop5Pay += payoutFor(actual, sorted, payoutTable, actuals);
      if (actual >= top1Thresh) poolTop5T1++;
      poolTop5Scored++;
      taken++;
    }

    // Baseline: top-5 by projection from our 150 (what old workflow was)
    const projRanked = [...results].filter(r => r.actual !== null).slice(0, 0);
    const byProj: { lu: Lineup; r: LineupResult }[] = [];
    for (let i = 0; i < portfolio.length; i++) {
      if (results[i].actual !== null) byProj.push({ lu: portfolio[i], r: results[i] });
    }
    byProj.sort((a, b) => b.lu.projection - a.lu.projection);
    const proj5 = byProj.slice(0, TOP_K);
    const proj5Pay = proj5.reduce((a, x) => a + x.r.payout, 0);
    const proj5T1 = proj5.filter(x => (x.r.actual ?? 0) >= top1Thresh).length;

    rows.push({
      slate: s.slate,
      configName,
      full150: { pay: full150Pay, mean: full150Pay / scored.length, t1: full150T1, scored: scored.length, entryCost: FEE * scored.length },
      top5BySim: { pay: top5Pay, t1: top5T1, scored: top5Scored.length, entryCost: FEE * top5Scored.length, lineups: top5.map(r => r.simROI || 0) },
      poolTop5BySim: { pay: poolTop5Pay, t1: poolTop5T1, scored: poolTop5Scored, entryCost: FEE * poolTop5Scored },
      randomBaseline5: { pay: proj5Pay, t1: proj5T1 },
    });
  }

  return rows;
}

async function main() {
  console.log('================================================================');
  console.log(`MLB Top-5 sim-ROI sub-selection audit — does picking 5 out of 150 by SaberSim sim-ROI help or hurt?`);
  console.log('================================================================\n');

  const configs: { name: string; run: (pool: Lineup[], players: Player[], cf: Map<string, number>) => Lineup[] }[] = [
    {
      name: 'prod-shipped (λ=0.05)',
      run: (pool, players, cf) => productionSelect(pool, players, { N, lambda: 0.05, comboFreq: cf, maxOverlap: 7 }).portfolio,
    },
    {
      name: 'prod-λ0.20',
      run: (pool, players, cf) => productionSelect(pool, players, { N, lambda: 0.20, comboFreq: cf, maxOverlap: 7 }).portfolio,
    },
  ];

  for (const c of configs) {
    console.log(`\n\n===== ${c.name} =====\n`);
    const rows = await evaluateConfig(c.name, c.run);

    console.log('Slate      | 150-total | 150-mean/lu | 5-by-simROI | 5-by-proj | pool-top5 |');
    console.log('-'.repeat(95));
    let sum150 = 0, sum5Sim = 0, sum5Proj = 0, sumPoolTop = 0;
    let t1_150 = 0, t1_5Sim = 0, t1_5Proj = 0, t1_pool = 0;
    let scoredSum = 0, simScoredSum = 0;
    for (const r of rows) {
      console.log(
        `${r.slate.padEnd(10)} | $${r.full150.pay.toFixed(0).padStart(8)} | $${r.full150.mean.toFixed(1).padStart(9)} | $${r.top5BySim.pay.toFixed(0).padStart(10)} | $${r.randomBaseline5.pay.toFixed(0).padStart(8)} | $${r.poolTop5BySim.pay.toFixed(0).padStart(8)} |`
      );
      sum150 += r.full150.pay; sum5Sim += r.top5BySim.pay; sum5Proj += r.randomBaseline5.pay; sumPoolTop += r.poolTop5BySim.pay;
      t1_150 += r.full150.t1; t1_5Sim += r.top5BySim.t1; t1_5Proj += r.randomBaseline5.t1; t1_pool += r.poolTop5BySim.t1;
      scoredSum += r.full150.scored; simScoredSum += r.top5BySim.scored;
    }
    console.log('-'.repeat(95));
    console.log(`TOTAL      | $${sum150.toFixed(0).padStart(8)} |            | $${sum5Sim.toFixed(0).padStart(10)} | $${sum5Proj.toFixed(0).padStart(8)} | $${sumPoolTop.toFixed(0).padStart(8)} |`);
    console.log(`t1 hits    | ${t1_150.toString().padStart(8)}  |            |  ${t1_5Sim.toString().padStart(8)}  |  ${t1_5Proj.toString().padStart(6)}  |  ${t1_pool.toString().padStart(6)}  |`);
    console.log();

    const cost150 = FEE * scoredSum;
    const cost5 = FEE * simScoredSum;
    console.log(`  Full 150: $${sum150.toFixed(0)} payout on $${cost150.toFixed(0)} fees → ROI = ${((sum150 / cost150 - 1) * 100).toFixed(1)}%`);
    console.log(`  Top-5 by simROI: $${sum5Sim.toFixed(0)} payout on $${cost5.toFixed(0)} fees → ROI = ${cost5 > 0 ? ((sum5Sim / cost5 - 1) * 100).toFixed(1) : '—'}%`);
    console.log(`  Top-5 by proj:   $${sum5Proj.toFixed(0)} payout on $${FEE * TOP_K * rows.length}  fees → ROI = ${((sum5Proj / (FEE * TOP_K * rows.length) - 1) * 100).toFixed(1)}%`);
    console.log(`  Pool top-5 by simROI (absolute best from 5000 pool): $${sumPoolTop.toFixed(0)} → ROI = ${((sumPoolTop / (FEE * TOP_K * rows.length) - 1) * 100).toFixed(1)}%`);

    const meanPerLineup150 = sum150 / scoredSum;
    const meanPerLineup5Sim = cost5 > 0 ? sum5Sim / simScoredSum : 0;
    const edge = meanPerLineup5Sim - meanPerLineup150;
    console.log(`\n  Mean payout / lineup — Full 150: $${meanPerLineup150.toFixed(2)}, Top-5 by simROI: $${meanPerLineup5Sim.toFixed(2)}`);
    console.log(`  → sim-ROI sub-selection ${edge >= 0 ? 'HELPS' : 'HURTS'} by $${edge.toFixed(2)}/lineup`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
