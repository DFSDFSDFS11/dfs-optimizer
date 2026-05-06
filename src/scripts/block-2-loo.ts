/**
 * Block 2 LOO validation: run per-slate diagnostic on key configs,
 * then LOO to check whether the +$5151 edge is slate-concentrated.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals } from '../parser';
import { getContestConfig } from '../rules';
import { DEFAULT_PRODUCTION_CONFIG } from '../selection/production-selector';
import { precomputeComboFrequencies, comboBonus } from '../selection/combo-leverage';
import { generateWorlds } from '../v35/simulation';
import { computeAnchor } from '../selection/anchor-relative';

const DIR = 'C:/Users/colin/dfs opto';
const FEE = 20;
const N = 150;
const LAMBDA = 0.05;
const GAMMA = 7;
const NUM_WORLDS = 1000;
const SEED = 12345;

const SLATES = [
  { slate: '4-6-26', proj: '4-6-26_projections.csv', actuals: 'dkactuals 4-6-26.csv', pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26', proj: '4-8-26projections.csv', actuals: '4-8-26actuals.csv', pool: '4-8-26sspool.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv', actuals: '4-12-26actuals.csv', pool: '4-12-26sspool.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv', actuals: '4-14-26actuals.csv', pool: '4-14-26sspool.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv', actuals: '4-15-26actuals.csv', pool: '4-15-26sspool.csv' },
  { slate: '4-17-26', proj: '4-17-26projections.csv', actuals: '4-17-26actuals.csv', pool: '4-17-26sspool.csv' },
  { slate: '4-18-26', proj: '4-18-26projections.csv', actuals: '4-18-26actuals.csv', pool: '4-18-26sspool.csv' },
  { slate: '4-19-26', proj: '4-19-26projections.csv', actuals: '4-19-26actuals.csv', pool: '4-19-26sspool.csv' },
  { slate: '4-20-26', proj: '4-20-26projections.csv', actuals: '4-20-26actuals.csv', pool: '4-20-26sspool.csv' },
  { slate: '4-21-26', proj: '4-21-26projections.csv', actuals: '4-21-26actuals.csv', pool: '4-21-26sspool.csv' },
];

const OWNERSHIP_BINS = [
  { label: 'chalk',  deltaLo: -2,  deltaHi: 99,  fraction: 0.10 },
  { label: 'core',   deltaLo: -5,  deltaHi: -2,  fraction: 0.30 },
  { label: 'value',  deltaLo: -8,  deltaHi: -5,  fraction: 0.35 },
  { label: 'contra', deltaLo: -12, deltaHi: -8,  fraction: 0.20 },
  { label: 'deep',   deltaLo: -20, deltaHi: -12, fraction: 0.05 },
];

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }

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
      for (const p of lu.players) {
        const r = actuals.playerActualsByName.get(norm(p.name));
        if (!r) { miss = true; break; }
        t += r.fpts;
      }
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

interface ExtConfig { nu: number; muAbs: number; muRel: number; muProp: number; k: number; }

function runExtendedSelect(candidates: Lineup[], poolPlayers: Player[], comboFreq: Map<string, number>, ceilingByHash: Map<string, number>, cfg: ExtConfig): Lineup[] {
  const stackPool = candidates.filter(lu => {
    const tc = new Map<string, number>();
    for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
    let max = 0; for (const c of tc.values()) if (c > max) max = c;
    return max >= 4;
  });
  const anchor = computeAnchor(stackPool, 50);
  const meta = stackPool.map(lu => {
    const own = lu.players.reduce((s, p) => s + (p.ownership || 0), 0) / lu.players.length;
    const hash = lu.players.map(p => p.id).sort().join('|');
    const ceiling = ceilingByHash.get(hash) ?? lu.projection;
    const cb = comboBonus(lu, comboFreq);
    const pidSet = new Set(lu.players.map(p => p.id));
    const counts = new Map<string, number>();
    for (const p of lu.players) if (!p.positions?.includes('P')) counts.set(p.team, (counts.get(p.team) || 0) + 1);
    let pt: string | null = null, mx = 0;
    for (const [t, c] of counts) if (c > mx) { mx = c; pt = t; }
    return { lu, own, proj: lu.projection, ceiling, cb, pidSet, primaryTeam: mx >= 4 ? pt : null };
  });
  const binned = new Map<string, typeof meta>();
  for (const b of OWNERSHIP_BINS) binned.set(b.label, []);
  for (const e of meta) {
    const delta = e.own - anchor.ownership;
    for (const b of OWNERSHIP_BINS) {
      if (delta >= b.deltaLo && delta < b.deltaHi) { binned.get(b.label)!.push(e); break; }
    }
  }
  const binTargetOwn = new Map<string, number>();
  for (const [label, entries] of binned) {
    if (entries.length > 0) binTargetOwn.set(label, entries.reduce((s, e) => s + e.own, 0) / entries.length);
  }
  for (const [label, entries] of binned) {
    const bt = binTargetOwn.get(label) ?? anchor.ownership;
    entries.sort((a, b) => {
      const sa = a.proj + cfg.nu * (a.ceiling - a.proj) - cfg.muAbs * a.own
        - cfg.muRel * Math.max(0, a.own - bt) - cfg.muProp * Math.max(0, a.own - a.ceiling / cfg.k) + LAMBDA * a.cb;
      const sb = b.proj + cfg.nu * (b.ceiling - b.proj) - cfg.muAbs * b.own
        - cfg.muRel * Math.max(0, b.own - bt) - cfg.muProp * Math.max(0, b.own - b.ceiling / cfg.k) + LAMBDA * b.cb;
      return sb - sa;
    });
  }
  const allocations = new Map<string, number>();
  let tot = 0;
  for (const b of OWNERSHIP_BINS) { const c = Math.round(b.fraction * N); allocations.set(b.label, c); tot += c; }
  if (tot !== N) { const largest = OWNERSHIP_BINS.reduce((a, b) => a.fraction > b.fraction ? a : b); allocations.set(largest.label, allocations.get(largest.label)! + (N - tot)); }
  const selected: Lineup[] = [];
  const selectedHashes = new Set<string>();
  const pidSets: Set<string>[] = [];
  const playerCount = new Map<string, number>();
  const teamStackCount = new Map<string, number>();
  const maxPerTeam = Math.max(1, Math.floor(N * DEFAULT_PRODUCTION_CONFIG.teamCapPct));
  const expCap = Math.ceil(DEFAULT_PRODUCTION_CONFIG.maxExposure * N);
  const canAdd = (e: typeof meta[0]) => {
    if (selectedHashes.has(e.lu.hash)) return false;
    for (const p of e.lu.players) if ((playerCount.get(p.id) || 0) >= expCap) return false;
    if (e.primaryTeam && (teamStackCount.get(e.primaryTeam) || 0) >= maxPerTeam) return false;
    for (const sel of pidSets) {
      let shared = 0;
      for (const id of e.pidSet) if (sel.has(id)) { shared++; if (shared > GAMMA) return false; }
    }
    return true;
  };
  const add = (e: typeof meta[0]) => {
    selected.push(e.lu);
    selectedHashes.add(e.lu.hash);
    pidSets.push(e.pidSet);
    for (const p of e.lu.players) playerCount.set(p.id, (playerCount.get(p.id) || 0) + 1);
    if (e.primaryTeam) teamStackCount.set(e.primaryTeam, (teamStackCount.get(e.primaryTeam) || 0) + 1);
  };
  for (const label of ['core', 'value', 'chalk', 'contra', 'deep']) {
    const target = allocations.get(label) || 0;
    const cands = binned.get(label) || [];
    let filled = 0;
    for (const c of cands) {
      if (filled >= target) break;
      if (!canAdd(c)) continue;
      add(c); filled++;
    }
  }
  if (selected.length < N) {
    const all = [...meta].sort((a, b) => {
      const sa = a.proj + cfg.nu * (a.ceiling - a.proj) + LAMBDA * a.cb;
      const sb = b.proj + cfg.nu * (b.ceiling - b.proj) + LAMBDA * b.cb;
      return sb - sa;
    });
    for (const c of all) { if (selected.length >= N) break; if (!canAdd(c)) continue; add(c); }
  }
  return selected;
}

async function main() {
  // Precompute all slate data
  type SlateData = { slate: string; actuals: ContestActuals; actualByHash: Map<string, number>; candidates: Lineup[]; poolPlayers: Player[]; comboFreq: Map<string, number>; ceilingByHash: Map<string, number>; payoutTable: Float64Array; };
  const slateData: SlateData[] = [];
  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj);
    const actualsPath = path.join(DIR, s.actuals);
    const poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) continue;
    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
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
      for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
      if (!ok) continue;
      actualByHash.set(pls.map(p => p.id).sort().join('|'), e.actualPoints);
    }
    const comboFreq = precomputeComboFrequencies(loaded.lineups, 3);
    const payoutTable = buildPayoutTable(F);
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
      const p90 = sortedScores[Math.floor(NUM_WORLDS * 0.9)];
      const hash = lu.players.map(p => p.id).sort().join('|');
      ceilingByHash.set(hash, p90);
    }
    console.log(`  ${s.slate}: ${loaded.lineups.length} lineups`);
    slateData.push({ slate: s.slate, actuals, actualByHash, candidates: loaded.lineups, poolPlayers: pool.players, comboFreq, ceilingByHash, payoutTable });
  }

  function runAll(cfg: ExtConfig): { total: number; perSlate: Array<{ slate: string; pay: number; t1: number }> } {
    const perSlate: Array<{ slate: string; pay: number; t1: number }> = [];
    let total = 0;
    for (const sd of slateData) {
      const portfolio = runExtendedSelect(sd.candidates, sd.poolPlayers, sd.comboFreq, sd.ceilingByHash, cfg);
      const sc = scorePortfolio(portfolio, sd.actuals, sd.actualByHash, sd.payoutTable);
      perSlate.push({ slate: sd.slate, pay: sc.totalPayout, t1: sc.t1 });
      total += sc.totalPayout;
    }
    return { total, perSlate };
  }

  // Per-slate breakdown for baseline, ν=0.5 only, ν=0.5 + μ_abs=0.3
  const configs: Array<{ label: string; cfg: ExtConfig }> = [
    { label: 'baseline (ν=0)', cfg: { nu: 0, muAbs: 0, muRel: 0, muProp: 0, k: 10 } },
    { label: 'ν=0.5', cfg: { nu: 0.5, muAbs: 0, muRel: 0, muProp: 0, k: 10 } },
    { label: 'ν=0.5 μ_abs=0.3', cfg: { nu: 0.5, muAbs: 0.3, muRel: 0, muProp: 0, k: 10 } },
  ];
  const results = configs.map(c => ({ ...c, ...runAll(c.cfg) }));

  console.log('\n=== Per-slate breakdown ===\n');
  console.log('Slate     | ' + results.map(r => r.label.padEnd(16)).join(' | '));
  for (let i = 0; i < slateData.length; i++) {
    let row = slateData[i].slate.padEnd(9) + ' | ';
    row += results.map(r => `$${r.perSlate[i].pay.toFixed(0).padStart(6)} (t1=${r.perSlate[i].t1})`.padEnd(16)).join(' | ');
    console.log(row);
  }
  console.log('\nTotals:');
  for (const r of results) console.log(`  ${r.label.padEnd(22)}: $${r.total.toFixed(0)}`);

  // LOO on winning config
  console.log('\n=== LOO on ν=0.5 μ_abs=0.3 ===\n');
  const configGrid: Array<{ nu: number; muAbs: number }> = [];
  for (const nu of [0, 0.3, 0.5, 0.7, 1.0]) for (const muAbs of [0, 0.1, 0.3, 0.5]) configGrid.push({ nu, muAbs });
  // Build matrix: gridResults[configIdx][slateIdx] = pay
  const grid: number[][] = [];
  for (const g of configGrid) {
    const r = runAll({ nu: g.nu, muAbs: g.muAbs, muRel: 0, muProp: 0, k: 10 });
    grid.push(r.perSlate.map(ps => ps.pay));
  }
  let looTotal = 0, baselineLoo = 0;
  const pickCounts = new Map<string, number>();
  for (let si = 0; si < slateData.length; si++) {
    let bestIdx = 0, bestSum = -Infinity;
    for (let ci = 0; ci < configGrid.length; ci++) {
      let sum = 0;
      for (let sj = 0; sj < slateData.length; sj++) if (sj !== si) sum += grid[ci][sj];
      if (sum > bestSum) { bestSum = sum; bestIdx = ci; }
    }
    const chosen = configGrid[bestIdx];
    const key = `ν=${chosen.nu} μ=${chosen.muAbs}`;
    pickCounts.set(key, (pickCounts.get(key) || 0) + 1);
    const held = grid[bestIdx][si];
    const base = grid[0][si]; // baseline (nu=0,muAbs=0)
    looTotal += held; baselineLoo += base;
    console.log(`  held=${slateData[si].slate}  chose ${key}  payout=$${held.toFixed(0)} (baseline $${base.toFixed(0)})`);
  }
  console.log(`\n  LOO total: $${looTotal.toFixed(0)}`);
  console.log(`  Baseline on same folds: $${baselineLoo.toFixed(0)}`);
  console.log(`  LOO Δ: ${looTotal - baselineLoo >= 0 ? '+' : ''}$${(looTotal - baselineLoo).toFixed(0)}`);
  console.log(`\n  Pick distribution:`);
  for (const [k, n] of [...pickCounts.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${k}: ${n}/${slateData.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
