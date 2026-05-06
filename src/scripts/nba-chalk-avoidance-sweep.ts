/**
 * NBA No-Chalk-Bin + Global Chalk-Avoidance Floor Sweep
 *
 * Config: remove chalk bin allocation (0%), redistribute chalk's 10% across
 * core/value/contra/deep proportionally. Apply a hard global filter:
 *   reject any lineup whose ownership > (maxer_centroid_ownership - X pp)
 * where maxer_centroid = mean ownership of top-50 pool lineups by ownership.
 *
 * Sweep X ∈ {0, 2, 3, 5, 7, 10, 15} across 12 NBA slates.
 * Report full-sample + LOO + per-slate for winners.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals } from '../parser';
import { getContestConfig } from '../rules';
import { productionSelect, DEFAULT_PRODUCTION_CONFIG } from '../selection/production-selector';
import { computeAnchor } from '../selection/anchor-relative';

const DIR = 'C:/Users/colin/Projects/dfs-optimizer/historical_slates';
const FEE = 20;
const N = 150;
const GAMMA = 6;
const PROJ_FLOOR_PCT = 0.85; // reject any lineup whose projection < 85% of the pool's top (optimal) projection

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

const OWNERSHIP_BINS_BASE = [
  { label: 'chalk',  deltaLo: -2,  deltaHi: 99 },
  { label: 'core',   deltaLo: -5,  deltaHi: -2 },
  { label: 'value',  deltaLo: -8,  deltaHi: -5 },
  { label: 'contra', deltaLo: -12, deltaHi: -8 },
  { label: 'deep',   deltaLo: -20, deltaHi: -12 },
];

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function mean(arr: number[]): number { if (!arr.length) return 0; let s = 0; for (let i = 0; i < arr.length; i++) s += arr[i]; return s / arr.length; }

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
  let t1 = 0, totalPayout = 0;
  for (const lu of portfolio) {
    const h = lu.players.map(p => p.id).sort().join('|');
    let a: number | null = actualByHash.get(h) ?? null;
    if (a === null) {
      let t = 0, miss = false;
      for (const p of lu.players) { const r = actuals.playerActualsByName.get(norm(p.name)); if (!r) { miss = true; break; } t += r.fpts; }
      if (!miss) a = t;
    }
    if (a === null) continue;
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const m = (lo + hi) >>> 1; if (sorted[m] >= a) lo = m + 1; else hi = m; }
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

interface SD {
  slate: string; actuals: ContestActuals; actualByHash: Map<string, number>;
  candidates: Lineup[]; poolPlayers: Player[]; payoutTable: Float64Array;
}

// No-chalk bin + chalk-avoidance floor + 85% projection floor from optimal
function runNoChalkWithAvoidance(sd: SD, X: number): Lineup[] {
  // Compute maxer centroid (top 50 by ownership)
  const byOwn = [...sd.candidates].sort((a, b) => {
    const oa = a.players.reduce((s, p) => s + (p.ownership || 0), 0) / a.players.length;
    const ob = b.players.reduce((s, p) => s + (p.ownership || 0), 0) / b.players.length;
    return ob - oa;
  }).slice(0, Math.min(50, sd.candidates.length));
  const maxerCentroid = mean(byOwn.map(lu => mean(lu.players.map(p => p.ownership || 0))));

  // Optimal = max projection in pool
  const optimalProj = sd.candidates.reduce((m, lu) => lu.projection > m ? lu.projection : m, 0);
  const projFloor = PROJ_FLOOR_PCT * optimalProj;

  // Filter: lineup ownership ≤ (maxer - X) AND projection ≥ 85% of optimal
  const filtered = sd.candidates.filter(lu => {
    const o = lu.players.reduce((s, p) => s + (p.ownership || 0), 0) / lu.players.length;
    return o <= maxerCentroid - X && lu.projection >= projFloor;
  });

  if (filtered.length === 0) return [];

  const anchor = computeAnchor(filtered, 50);
  const allMeta = filtered.map(lu => {
    const own = lu.players.reduce((s, p) => s + (p.ownership || 0), 0) / lu.players.length;
    const pidSet = new Set(lu.players.map(p => p.id));
    return { lu, own, proj: lu.projection, pidSet };
  });

  const binned = new Map<string, typeof allMeta>();
  for (const b of OWNERSHIP_BINS_BASE) binned.set(b.label, []);
  for (const e of allMeta) {
    const delta = e.own - anchor.ownership;
    for (const b of OWNERSHIP_BINS_BASE) {
      if (delta >= b.deltaLo && delta < b.deltaHi) { binned.get(b.label)!.push(e); break; }
    }
  }
  for (const [, entries] of binned) entries.sort((a, b) => b.proj - a.proj);

  // No-chalk allocation: redistribute 10% across core/value/contra/deep proportionally
  // Original: 10/30/35/20/5. Redistribute chalk's 10% → 0/33.3/38.9/22.2/5.6
  const fractions = [0, 0.333, 0.389, 0.222, 0.056];
  const allocations = new Map<string, number>();
  let tot = 0;
  for (let i = 0; i < OWNERSHIP_BINS_BASE.length; i++) {
    const c = Math.round(fractions[i] * N);
    allocations.set(OWNERSHIP_BINS_BASE[i].label, c);
    tot += c;
  }
  if (tot !== N) {
    allocations.set('value', allocations.get('value')! + (N - tot));
  }

  const selected: Lineup[] = [];
  const selectedHashes = new Set<string>();
  const pidSets: Set<string>[] = [];
  const playerCount = new Map<string, number>();
  const expCap = Math.ceil(DEFAULT_PRODUCTION_CONFIG.maxExposure * N);
  const canAdd = (e: typeof allMeta[0]) => {
    if (selectedHashes.has(e.lu.hash)) return false;
    for (const p of e.lu.players) if ((playerCount.get(p.id) || 0) >= expCap) return false;
    for (const sel of pidSets) { let shared = 0; for (const id of e.pidSet) if (sel.has(id)) { shared++; if (shared > GAMMA) return false; } }
    return true;
  };
  const add = (e: typeof allMeta[0]) => {
    selected.push(e.lu); selectedHashes.add(e.lu.hash); pidSets.push(e.pidSet);
    for (const p of e.lu.players) playerCount.set(p.id, (playerCount.get(p.id) || 0) + 1);
  };

  for (const label of ['core', 'value', 'chalk', 'contra', 'deep']) {
    const target = allocations.get(label) || 0;
    const cands = binned.get(label) || [];
    let filled = 0;
    for (const c of cands) { if (filled >= target) break; if (!canAdd(c)) continue; add(c); filled++; }
  }
  if (selected.length < N) {
    const all = [...allMeta].sort((a, b) => b.proj - a.proj);
    for (const c of all) { if (selected.length >= N) break; if (!canAdd(c)) continue; add(c); }
  }
  return selected;
}

async function main() {
  console.log('Loading 12 NBA slates...');
  const slateData: SD[] = [];
  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj);
    const actualsPath = path.join(DIR, s.actuals);
    const poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) continue;
    try {
      const pr = parseCSVFile(projPath, 'nba', true);
      const config = getContestConfig('dk', 'nba', pr.detectedContestType);
      const pool = buildPlayerPool(pr.players, pr.detectedContestType);
      const actuals = parseContestActuals(actualsPath, config);
      const nameMap = new Map<string, Player>();
      for (const p of pool.players) nameMap.set(norm(p.name), p);
      const idMap = new Map<string, Player>();
      for (const p of pool.players) idMap.set(p.id, p);
      const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
      const actualByHash = new Map<string, number>();
      for (const e of actuals.entries) {
        const pls: Player[] = [];
        let ok = true;
        for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
        if (!ok) continue;
        actualByHash.set(pls.map(p => p.id).sort().join('|'), e.actualPoints);
      }
      slateData.push({ slate: s.slate, actuals, actualByHash, candidates: loaded.lineups, poolPlayers: pool.players, payoutTable: buildPayoutTable(actuals.entries.length) });
    } catch (err) {
      console.log(`  ${s.slate}: ERROR`);
    }
  }
  console.log(`Loaded ${slateData.length} slates.\n`);

  // Baseline: NBA shipped production config
  const baselinePerSlate = slateData.map(sd => {
    const r = productionSelect(sd.candidates, sd.poolPlayers, { N, lambda: 0, maxOverlap: GAMMA, minPrimaryStack: 0 });
    return scorePortfolio(r.portfolio, sd.actuals, sd.actualByHash, sd.payoutTable);
  });
  const baselineTotal = baselinePerSlate.reduce((s, x) => s + x.totalPayout, 0);
  const baselineHits = baselinePerSlate.reduce((s, x) => s + x.t1, 0);
  console.log(`BASELINE (full bins, no filter): $${baselineTotal.toFixed(0)}  t1=${baselineHits}\n`);

  const Xs = [0, 2, 3, 5, 7, 10, 15];
  console.log('=== Sweep: no-chalk-bin + chalk-avoidance X (pp below maxer centroid) ===\n');
  console.log('X (pp) | Total    | t1 | Δ baseline | min pool | notes');

  const grid: { X: number; perSlate: { slate: string; pay: number; t1: number; poolSize: number }[]; total: number; hits: number }[] = [];
  for (const X of Xs) {
    const perSlate: { slate: string; pay: number; t1: number; poolSize: number }[] = [];
    let total = 0, hits = 0;
    for (const sd of slateData) {
      // Compute filtered pool size for diagnostic
      const byOwn = [...sd.candidates].sort((a, b) => {
        const oa = a.players.reduce((s, p) => s + (p.ownership || 0), 0) / a.players.length;
        const ob = b.players.reduce((s, p) => s + (p.ownership || 0), 0) / b.players.length;
        return ob - oa;
      }).slice(0, Math.min(50, sd.candidates.length));
      const maxerCentroid = mean(byOwn.map(lu => mean(lu.players.map(p => p.ownership || 0))));
      const optimalProj = sd.candidates.reduce((m, lu) => lu.projection > m ? lu.projection : m, 0);
      const projFloor = PROJ_FLOOR_PCT * optimalProj;
      const poolSize = sd.candidates.filter(lu => {
        const o = lu.players.reduce((s, p) => s + (p.ownership || 0), 0) / lu.players.length;
        return o <= maxerCentroid - X && lu.projection >= projFloor;
      }).length;
      const portfolio = runNoChalkWithAvoidance(sd, X);
      const sc = scorePortfolio(portfolio, sd.actuals, sd.actualByHash, sd.payoutTable);
      perSlate.push({ slate: sd.slate, pay: sc.totalPayout, t1: sc.t1, poolSize });
      total += sc.totalPayout; hits += sc.t1;
    }
    grid.push({ X, perSlate, total, hits });
    const minPool = Math.min(...perSlate.map(p => p.poolSize));
    const dPay = total - baselineTotal;
    console.log(`  X=${X.toString().padStart(2)}  | $${total.toFixed(0).padStart(7)} | ${hits.toString().padStart(2)} | ${dPay >= 0 ? '+' : ''}$${dPay.toFixed(0).padStart(7)} | ${minPool.toString().padStart(3)} | ${minPool < 50 ? 'pool too thin' : ''}`);
  }

  // Per-slate for top 3 Xs
  const topGrid = [...grid].sort((a, b) => b.total - a.total).slice(0, 3);
  console.log('\n=== Per-slate: top 3 X values ===\n');
  console.log('Slate      | baseline      | ' + topGrid.map(g => `X=${g.X}`.padStart(15)).join(' | '));
  for (let si = 0; si < slateData.length; si++) {
    let row = slateData[si].slate.padEnd(11) + '| $' + baselinePerSlate[si].totalPayout.toFixed(0).padStart(7) + ' (t1=' + baselinePerSlate[si].t1 + ') | ';
    row += topGrid.map(g => `$${g.perSlate[si].pay.toFixed(0).padStart(6)} (t1=${g.perSlate[si].t1})`.padStart(15)).join(' | ');
    console.log(row);
  }

  // LOO
  console.log('\n=== LOO on the 7 X values ===\n');
  let looTotal = 0, looBase = 0;
  const picks = new Map<number, number>();
  for (let si = 0; si < slateData.length; si++) {
    let bestIdx = 0, bestSum = -Infinity;
    for (let ci = 0; ci < grid.length; ci++) {
      let sum = 0;
      for (let sj = 0; sj < slateData.length; sj++) if (sj !== si) sum += grid[ci].perSlate[sj].pay;
      if (sum > bestSum) { bestSum = sum; bestIdx = ci; }
    }
    const chosen = grid[bestIdx].X;
    picks.set(chosen, (picks.get(chosen) || 0) + 1);
    const held = grid[bestIdx].perSlate[si].pay;
    const base = baselinePerSlate[si].totalPayout;
    looTotal += held; looBase += base;
    console.log(`  ${slateData[si].slate}: chose X=${chosen}, held=$${held.toFixed(0)}, baseline=$${base.toFixed(0)}`);
  }
  console.log(`\n  LOO total: $${looTotal.toFixed(0)} vs baseline $${looBase.toFixed(0)} (Δ ${looTotal - looBase >= 0 ? '+' : ''}$${(looTotal - looBase).toFixed(0)})`);
  console.log(`  Pick distribution:`);
  for (const [X, n] of [...picks.entries()].sort((a, b) => b[1] - a[1])) console.log(`    X=${X}: ${n}/${slateData.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
