/**
 * NBA Ceiling/Projection-Focused Backtest
 *
 * NBA is a projection-accuracy contest (chalk wins). Tests whether removing
 * contra/deep bins and concentrating on chalk/core/value improves payout.
 *
 * Also sweeps ceiling weighting (ν) within-bin to favor ceiling-high lineups.
 *
 * Config held constant: minPrimaryStack=0, λ=0 (NBA), γ=6, maxExposure=40%, teamCap=10%.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals } from '../parser';
import { getContestConfig } from '../rules';
import { productionSelect, DEFAULT_PRODUCTION_CONFIG } from '../selection/production-selector';
import { generateWorlds } from '../v35/simulation';
import { computeAnchor } from '../selection/anchor-relative';

const DIR = 'C:/Users/colin/Projects/dfs-optimizer/historical_slates';
const FEE = 20;
const N = 150;
const GAMMA = 6;
const NUM_WORLDS = 1000;
const SEED = 12345;

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
  candidates: Lineup[]; poolPlayers: Player[]; ceilingByHash: Map<string, number>; payoutTable: Float64Array;
}

function runNBA(sd: SD, opts: { bins: { chalk: number; core: number; value: number; contra: number; deep: number }; nu?: number }): Lineup[] {
  // NBA: no primary stack filter, λ=0, γ=6
  const allMeta = sd.candidates.map(lu => {
    const own = lu.players.reduce((s, p) => s + (p.ownership || 0), 0) / lu.players.length;
    const hash = lu.players.map(p => p.id).sort().join('|');
    const ceiling = sd.ceilingByHash.get(hash) ?? lu.projection;
    const pidSet = new Set(lu.players.map(p => p.id));
    // NBA has no 4+ team stacks; primaryTeam is always null
    return { lu, own, proj: lu.projection, ceiling, pidSet };
  });

  const anchor = computeAnchor(sd.candidates, 50);
  const binned = new Map<string, typeof allMeta>();
  for (const b of OWNERSHIP_BINS_BASE) binned.set(b.label, []);
  for (const e of allMeta) {
    const delta = e.own - anchor.ownership;
    for (const b of OWNERSHIP_BINS_BASE) {
      if (delta >= b.deltaLo && delta < b.deltaHi) { binned.get(b.label)!.push(e); break; }
    }
  }

  const nu = opts.nu ?? 0;
  for (const [, entries] of binned) {
    entries.sort((a, b) => {
      const sa = a.proj + nu * (a.ceiling - a.proj);
      const sb = b.proj + nu * (b.ceiling - b.proj);
      return sb - sa;
    });
  }

  const fractions = [opts.bins.chalk, opts.bins.core, opts.bins.value, opts.bins.contra, opts.bins.deep];
  const allocations = new Map<string, number>();
  let tot = 0;
  for (let i = 0; i < OWNERSHIP_BINS_BASE.length; i++) {
    const c = Math.round(fractions[i] * N);
    allocations.set(OWNERSHIP_BINS_BASE[i].label, c);
    tot += c;
  }
  if (tot !== N) {
    let largestIdx = 0;
    for (let i = 1; i < 5; i++) if (fractions[i] > fractions[largestIdx]) largestIdx = i;
    const label = OWNERSHIP_BINS_BASE[largestIdx].label;
    allocations.set(label, allocations.get(label)! + (N - tot));
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
    const all = [...allMeta].sort((a, b) => {
      const sa = a.proj + nu * (a.ceiling - a.proj);
      const sb = b.proj + nu * (b.ceiling - b.proj);
      return sb - sa;
    });
    for (const c of all) { if (selected.length >= N) break; if (!canAdd(c)) continue; add(c); }
  }
  return selected;
}

async function main() {
  console.log('Loading NBA slates + ceilings...');
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
      const payoutTable = buildPayoutTable(actuals.entries.length);
      const sim = generateWorlds(pool.players, NUM_WORLDS, 5, SEED);
      const playerIdx = new Map<string, number>();
      for (let i = 0; i < pool.players.length; i++) playerIdx.set(pool.players[i].id, i);
      const ceilingByHash = new Map<string, number>();
      for (const lu of loaded.lineups) {
        const indices: number[] = [];
        for (const p of lu.players) { const idx = playerIdx.get(p.id); if (idx !== undefined) indices.push(idx); }
        const scores = new Float64Array(NUM_WORLDS);
        for (let w = 0; w < NUM_WORLDS; w++) { let sum = 0; for (const pi of indices) sum += sim.scores[pi * NUM_WORLDS + w]; scores[w] = sum; }
        const sortedScores = [...scores].sort((a, b) => a - b);
        ceilingByHash.set(lu.players.map(p => p.id).sort().join('|'), sortedScores[Math.floor(NUM_WORLDS * 0.9)]);
      }
      console.log(`  ${s.slate}: ${loaded.lineups.length} lineups`);
      slateData.push({ slate: s.slate, actuals, actualByHash, candidates: loaded.lineups, poolPlayers: pool.players, ceilingByHash, payoutTable });
    } catch (err) {
      console.log(`  ${s.slate}: ERROR ${(err as Error).message}`);
    }
  }

  console.log(`\nLoaded ${slateData.length} slates.\n`);

  // Baseline NBA (shipped defaults)
  const baselinePerSlate = slateData.map(sd => {
    const r = productionSelect(sd.candidates, sd.poolPlayers, { N, lambda: 0, maxOverlap: GAMMA, minPrimaryStack: 0 });
    return scorePortfolio(r.portfolio, sd.actuals, sd.actualByHash, sd.payoutTable);
  });
  const baselineTotal = baselinePerSlate.reduce((s, x) => s + x.totalPayout, 0);
  const baselineHits = baselinePerSlate.reduce((s, x) => s + x.t1, 0);

  console.log(`BASELINE NBA (10/30/35/20/5): $${baselineTotal.toFixed(0)}  t1=${baselineHits}  ROI=${((baselineTotal / (FEE * N * slateData.length) - 1) * 100).toFixed(1)}%\n`);

  // Configs to sweep
  type Cfg = { label: string; bins: { chalk: number; core: number; value: number; contra: number; deep: number }; nu?: number };
  const CONFIGS: Cfg[] = [
    { label: 'A baseline             10/30/35/20/05', bins: { chalk: 0.10, core: 0.30, value: 0.35, contra: 0.20, deep: 0.05 } },
    { label: 'B no-contra-deep       10/40/50/00/00', bins: { chalk: 0.10, core: 0.40, value: 0.50, contra: 0, deep: 0 } },
    { label: 'C chalk-heavy no-deep  20/40/30/10/00', bins: { chalk: 0.20, core: 0.40, value: 0.30, contra: 0.10, deep: 0 } },
    { label: 'D pure-chalk           30/40/30/00/00', bins: { chalk: 0.30, core: 0.40, value: 0.30, contra: 0, deep: 0 } },
    { label: 'E chalk-only no-con-de 15/45/40/00/00', bins: { chalk: 0.15, core: 0.45, value: 0.40, contra: 0, deep: 0 } },
    { label: 'F ceiling ν=0.3 bins ABCD B shape', bins: { chalk: 0.10, core: 0.40, value: 0.50, contra: 0, deep: 0 }, nu: 0.3 },
    { label: 'G ceiling ν=0.5 bins ABCD B shape', bins: { chalk: 0.10, core: 0.40, value: 0.50, contra: 0, deep: 0 }, nu: 0.5 },
    { label: 'H ceiling ν=0.5 chalk-heavy',        bins: { chalk: 0.20, core: 0.40, value: 0.30, contra: 0.10, deep: 0 }, nu: 0.5 },
  ];

  console.log('=== Full-sample results ===\n');
  const grid: { label: string; perSlate: { slate: string; pay: number; t1: number }[]; total: number; hits: number }[] = [];
  for (const c of CONFIGS) {
    const perSlate: { slate: string; pay: number; t1: number }[] = [];
    let total = 0, hits = 0;
    for (const sd of slateData) {
      const portfolio = runNBA(sd, { bins: c.bins, nu: c.nu });
      const sc = scorePortfolio(portfolio, sd.actuals, sd.actualByHash, sd.payoutTable);
      perSlate.push({ slate: sd.slate, pay: sc.totalPayout, t1: sc.t1 });
      total += sc.totalPayout; hits += sc.t1;
    }
    grid.push({ label: c.label, perSlate, total, hits });
    const dPay = total - baselineTotal;
    console.log(`  ${c.label.padEnd(40)} $${total.toFixed(0).padStart(7)} t1=${hits.toString().padStart(3)} Δ=${dPay >= 0 ? '+' : ''}$${dPay.toFixed(0)}`);
  }

  // Per-slate breakdown for top 3
  const sorted = [...grid].sort((a, b) => b.total - a.total);
  console.log('\n=== Per-slate breakdown: top 3 configs ===\n');
  console.log('Slate      | ' + sorted.slice(0, 3).map(c => c.label.slice(2, 25).padStart(20)).join(' | '));
  for (let si = 0; si < slateData.length; si++) {
    let row = slateData[si].slate.padEnd(11) + '| ';
    row += sorted.slice(0, 3).map(c => `$${c.perSlate[si].pay.toFixed(0).padStart(6)} (t1=${c.perSlate[si].t1})`.padStart(20)).join(' | ');
    console.log(row);
  }

  // LOO on top config
  console.log('\n=== LOO on top config across all sweep variants ===\n');
  let looTotal = 0, looBase = 0;
  const picks = new Map<string, number>();
  for (let si = 0; si < slateData.length; si++) {
    let bestIdx = 0, bestSum = -Infinity;
    for (let ci = 0; ci < grid.length; ci++) {
      let sum = 0;
      for (let sj = 0; sj < slateData.length; sj++) if (sj !== si) sum += grid[ci].perSlate[sj].pay;
      if (sum > bestSum) { bestSum = sum; bestIdx = ci; }
    }
    const chosen = grid[bestIdx].label;
    picks.set(chosen, (picks.get(chosen) || 0) + 1);
    const held = grid[bestIdx].perSlate[si].pay;
    const base = baselinePerSlate[si].totalPayout;
    looTotal += held; looBase += base;
    console.log(`  ${slateData[si].slate}: chose ${chosen.slice(0, 25)}, held=$${held.toFixed(0)}, baseline=$${base.toFixed(0)}`);
  }
  console.log(`\n  LOO total: $${looTotal.toFixed(0)} vs baseline $${looBase.toFixed(0)} (Δ ${looTotal - looBase >= 0 ? '+' : ''}$${(looTotal - looBase).toFixed(0)})`);
  console.log(`\n  Pick distribution:`);
  for (const [k, n] of [...picks.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${k.slice(0, 30)}: ${n}/${slateData.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
