/**
 * Block 3 LOO — per-slate breakdown + LOO on the two big full-sample winners:
 * X=6pp chalk-avoidance and M5 ownership-heavy no-bins.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals } from '../parser';
import { getContestConfig } from '../rules';
import { productionSelect, DEFAULT_PRODUCTION_CONFIG } from '../selection/production-selector';
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

interface SlateData {
  slate: string; actuals: ContestActuals; actualByHash: Map<string, number>;
  candidates: Lineup[]; poolPlayers: Player[]; comboFreq: Map<string, number>;
  ceilingByHash: Map<string, number>; payoutTable: Float64Array;
}

const OWNERSHIP_BINS_BASE = [
  { label: 'chalk',  deltaLo: -2,  deltaHi: 99,  fraction: 0.10 },
  { label: 'core',   deltaLo: -5,  deltaHi: -2,  fraction: 0.30 },
  { label: 'value',  deltaLo: -8,  deltaHi: -5,  fraction: 0.35 },
  { label: 'contra', deltaLo: -12, deltaHi: -8,  fraction: 0.20 },
  { label: 'deep',   deltaLo: -20, deltaHi: -12, fraction: 0.05 },
];

function runChalkAvoidBin(sd: SlateData, X: number): Lineup[] {
  const stackPool = sd.candidates.filter(lu => {
    const tc = new Map<string, number>();
    for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
    let max = 0; for (const c of tc.values()) if (c > max) max = c;
    return max >= 4;
  });
  const anchor = computeAnchor(stackPool, 50);
  const byOwn = [...stackPool].sort((a, b) => {
    const oa = a.players.reduce((s, p) => s + (p.ownership || 0), 0) / a.players.length;
    const ob = b.players.reduce((s, p) => s + (p.ownership || 0), 0) / b.players.length;
    return ob - oa;
  }).slice(0, Math.min(50, stackPool.length));
  const maxerCentroid = mean(byOwn.map(lu => mean(lu.players.map(p => p.ownership || 0))));

  const meta = stackPool.map(lu => {
    const own = lu.players.reduce((s, p) => s + (p.ownership || 0), 0) / lu.players.length;
    const cb = comboBonus(lu, sd.comboFreq);
    const pidSet = new Set(lu.players.map(p => p.id));
    const counts = new Map<string, number>();
    for (const p of lu.players) if (!p.positions?.includes('P')) counts.set(p.team, (counts.get(p.team) || 0) + 1);
    let pt: string | null = null, mx = 0;
    for (const [t, c] of counts) if (c > mx) { mx = c; pt = t; }
    return { lu, own, proj: lu.projection, cb, pidSet, primaryTeam: mx >= 4 ? pt : null };
  });

  const filtered = meta.filter(e => e.own <= maxerCentroid - X);

  const binned = new Map<string, typeof meta>();
  for (const b of OWNERSHIP_BINS_BASE) binned.set(b.label, []);
  for (const e of filtered) {
    const delta = e.own - anchor.ownership;
    for (const b of OWNERSHIP_BINS_BASE) {
      if (delta >= b.deltaLo && delta < b.deltaHi) { binned.get(b.label)!.push(e); break; }
    }
  }
  for (const [, entries] of binned) entries.sort((a, b) => (b.proj + LAMBDA * b.cb) - (a.proj + LAMBDA * a.cb));

  const allocations = new Map<string, number>();
  let tot = 0;
  for (const b of OWNERSHIP_BINS_BASE) { const c = Math.round(b.fraction * N); allocations.set(b.label, c); tot += c; }
  if (tot !== N) { const largest = OWNERSHIP_BINS_BASE.reduce((a, b) => a.fraction > b.fraction ? a : b); allocations.set(largest.label, allocations.get(largest.label)! + (N - tot)); }

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
    for (const sel of pidSets) { let shared = 0; for (const id of e.pidSet) if (sel.has(id)) { shared++; if (shared > GAMMA) return false; } }
    return true;
  };
  const add = (e: typeof meta[0]) => {
    selected.push(e.lu); selectedHashes.add(e.lu.hash); pidSets.push(e.pidSet);
    for (const p of e.lu.players) playerCount.set(p.id, (playerCount.get(p.id) || 0) + 1);
    if (e.primaryTeam) teamStackCount.set(e.primaryTeam, (teamStackCount.get(e.primaryTeam) || 0) + 1);
  };
  for (const label of ['core', 'value', 'chalk', 'contra', 'deep']) {
    const target = allocations.get(label) || 0;
    const cands = binned.get(label) || [];
    let filled = 0;
    for (const c of cands) { if (filled >= target) break; if (!canAdd(c)) continue; add(c); filled++; }
  }
  if (selected.length < N) {
    const all = [...filtered].sort((a, b) => (b.proj + LAMBDA * b.cb) - (a.proj + LAMBDA * a.cb));
    for (const c of all) { if (selected.length >= N) break; if (!canAdd(c)) continue; add(c); }
  }
  return selected;
}

function runMultiCriteria(sd: SlateData, w: { wProj: number; wCeiling: number; wOwn: number }): Lineup[] {
  const stackPool = sd.candidates.filter(lu => {
    const tc = new Map<string, number>();
    for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
    let max = 0; for (const c of tc.values()) if (c > max) max = c;
    return max >= 4;
  });
  const projs = stackPool.map(lu => lu.projection);
  const owns = stackPool.map(lu => lu.players.reduce((s, p) => s + (p.ownership || 0), 0) / lu.players.length);
  const ceilings = stackPool.map(lu => {
    const hash = lu.players.map(p => p.id).sort().join('|');
    return sd.ceilingByHash.get(hash) ?? lu.projection;
  });
  const normalize = (arr: number[]) => {
    const mn = Math.min(...arr), mx = Math.max(...arr);
    return arr.map(v => mx > mn ? (v - mn) / (mx - mn) : 0);
  };
  const nProj = normalize(projs), nCeiling = normalize(ceilings), nOwn = normalize(owns);

  const scored = stackPool.map((lu, i) => {
    const cb = comboBonus(lu, sd.comboFreq);
    const pidSet = new Set(lu.players.map(p => p.id));
    const counts = new Map<string, number>();
    for (const p of lu.players) if (!p.positions?.includes('P')) counts.set(p.team, (counts.get(p.team) || 0) + 1);
    let pt: string | null = null, mx = 0;
    for (const [t, c] of counts) if (c > mx) { mx = c; pt = t; }
    const score = w.wProj * nProj[i] + w.wCeiling * (nCeiling[i] - nProj[i]) - w.wOwn * nOwn[i] + LAMBDA * cb / 50;
    return { lu, pidSet, primaryTeam: mx >= 4 ? pt : null, score };
  });
  scored.sort((a, b) => b.score - a.score);

  const selected: Lineup[] = [];
  const selectedHashes = new Set<string>();
  const pidSets: Set<string>[] = [];
  const playerCount = new Map<string, number>();
  const teamStackCount = new Map<string, number>();
  const maxPerTeam = Math.max(1, Math.floor(N * DEFAULT_PRODUCTION_CONFIG.teamCapPct));
  const expCap = Math.ceil(DEFAULT_PRODUCTION_CONFIG.maxExposure * N);
  for (const e of scored) {
    if (selected.length >= N) break;
    if (selectedHashes.has(e.lu.hash)) continue;
    let expOK = true;
    for (const p of e.lu.players) if ((playerCount.get(p.id) || 0) >= expCap) { expOK = false; break; }
    if (!expOK) continue;
    if (e.primaryTeam && (teamStackCount.get(e.primaryTeam) || 0) >= maxPerTeam) continue;
    let ovOK = true;
    for (const sel of pidSets) { let shared = 0; for (const id of e.pidSet) if (sel.has(id)) { shared++; if (shared > GAMMA) { ovOK = false; break; } } if (!ovOK) break; }
    if (!ovOK) continue;
    selected.push(e.lu); selectedHashes.add(e.lu.hash); pidSets.push(e.pidSet);
    for (const p of e.lu.players) playerCount.set(p.id, (playerCount.get(p.id) || 0) + 1);
    if (e.primaryTeam) teamStackCount.set(e.primaryTeam, (teamStackCount.get(e.primaryTeam) || 0) + 1);
  }
  return selected;
}

async function main() {
  console.log('Loading slates + ceilings...');
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
      ceilingByHash.set(lu.players.map(p => p.id).sort().join('|'), sortedScores[Math.floor(NUM_WORLDS * 0.9)]);
    }
    console.log(`  ${s.slate}: ${loaded.lineups.length} lineups`);
    slateData.push({ slate: s.slate, actuals, actualByHash, candidates: loaded.lineups, poolPlayers: pool.players, comboFreq, ceilingByHash, payoutTable });
  }

  console.log('\n=== Per-slate breakdown: shipped vs X=6pp vs M5 ownership-heavy ===\n');
  const baselineBySlate = slateData.map(sd => {
    const r = productionSelect(sd.candidates, sd.poolPlayers, { N, lambda: LAMBDA, comboFreq: sd.comboFreq, maxOverlap: GAMMA });
    return scorePortfolio(r.portfolio, sd.actuals, sd.actualByHash, sd.payoutTable);
  });
  const x6BySlate = slateData.map(sd => {
    const p = runChalkAvoidBin(sd, 6);
    return { ...scorePortfolio(p, sd.actuals, sd.actualByHash, sd.payoutTable), size: p.length };
  });
  const m5BySlate = slateData.map(sd => {
    const p = runMultiCriteria(sd, { wProj: 0.35, wCeiling: 0.20, wOwn: 0.45 });
    return { ...scorePortfolio(p, sd.actuals, sd.actualByHash, sd.payoutTable), size: p.length };
  });

  console.log('Slate     | Baseline         | X=6pp chalk-avoid    | M5 no-bins own-heavy');
  for (let i = 0; i < slateData.length; i++) {
    console.log(`${slateData[i].slate.padEnd(10)}| $${baselineBySlate[i].totalPayout.toFixed(0).padStart(6)} (t1=${baselineBySlate[i].t1})   | $${x6BySlate[i].totalPayout.toFixed(0).padStart(6)} (t1=${x6BySlate[i].t1}, n=${x6BySlate[i].size})   | $${m5BySlate[i].totalPayout.toFixed(0).padStart(6)} (t1=${m5BySlate[i].t1}, n=${m5BySlate[i].size})`);
  }
  const btot = baselineBySlate.reduce((s, x) => s + x.totalPayout, 0);
  const xtot = x6BySlate.reduce((s, x) => s + x.totalPayout, 0);
  const mtot = m5BySlate.reduce((s, x) => s + x.totalPayout, 0);
  console.log(`TOTAL     | $${btot.toFixed(0)}            | $${xtot.toFixed(0)} (+$${(xtot-btot).toFixed(0)})      | $${mtot.toFixed(0)} (+$${(mtot-btot).toFixed(0)})`);

  // Quick LOO on X=6pp vs a sweep of X ∈ {0,2,3,4,5,6}
  console.log('\n=== LOO on X=6pp (held against X ∈ {0,2,3,4,5,6}) ===\n');
  const XGRID = [0, 2, 3, 4, 5, 6];
  const xgrid = XGRID.map(X => slateData.map(sd => {
    if (X === 0) {
      const r = productionSelect(sd.candidates, sd.poolPlayers, { N, lambda: LAMBDA, comboFreq: sd.comboFreq, maxOverlap: GAMMA });
      return scorePortfolio(r.portfolio, sd.actuals, sd.actualByHash, sd.payoutTable).totalPayout;
    } else {
      const p = runChalkAvoidBin(sd, X);
      return scorePortfolio(p, sd.actuals, sd.actualByHash, sd.payoutTable).totalPayout;
    }
  }));
  let looTot = 0, looBase = 0;
  const picks = new Map<number, number>();
  for (let si = 0; si < slateData.length; si++) {
    let bestX = 0, bestSum = -Infinity;
    for (let xi = 0; xi < XGRID.length; xi++) {
      let sum = 0; for (let sj = 0; sj < slateData.length; sj++) if (sj !== si) sum += xgrid[xi][sj];
      if (sum > bestSum) { bestSum = sum; bestX = XGRID[xi]; }
    }
    picks.set(bestX, (picks.get(bestX) || 0) + 1);
    const held = xgrid[XGRID.indexOf(bestX)][si];
    const base = xgrid[0][si];
    looTot += held; looBase += base;
    console.log(`  ${slateData[si].slate}: chose X=${bestX}, held=$${held.toFixed(0)}, baseline=$${base.toFixed(0)}`);
  }
  console.log(`\n  LOO total: $${looTot.toFixed(0)} vs baseline $${looBase.toFixed(0)} (Δ ${(looTot-looBase >= 0 ? '+' : '')}$${(looTot-looBase).toFixed(0)})`);
  console.log(`  Pick distribution:`); for (const [x, n] of picks) console.log(`    X=${x}: ${n}/${slateData.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
