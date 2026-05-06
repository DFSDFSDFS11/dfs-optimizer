/**
 * Per-slate structural tracking vs youdacao (pro, millions won).
 *
 * Same 6 mechanism variants as nerdy comparison:
 *   baseline, ν=0.5 μ_abs=0.3, chalk-avoid X=3, chalk-avoid X=6, A5 contra-heavy,
 *   M5 ownership-heavy (no bins).
 *
 * Compute:
 *   - Per-slate 9 portfolio metrics for youdacao and each mechanism
 *   - Pearson correlation across slates for each metric
 *   - Composite tracking score
 *   - Youdacao's ROI per slate (direct from actuals)
 *   - Head-to-head on each slate: prod vs youdacao payout
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
const PRO_NAME = 'youdacao';

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
  { slate: '4-22-26', proj: '4-22-26projections.csv', actuals: '4-22-26actuals.csv', pool: '4-22-26sspool.csv' },
];

const OWNERSHIP_BINS_BASE = [
  { label: 'chalk',  deltaLo: -2,  deltaHi: 99,  fraction: 0.10 },
  { label: 'core',   deltaLo: -5,  deltaHi: -2,  fraction: 0.30 },
  { label: 'value',  deltaLo: -8,  deltaHi: -5,  fraction: 0.35 },
  { label: 'contra', deltaLo: -12, deltaHi: -8,  fraction: 0.20 },
  { label: 'deep',   deltaLo: -20, deltaHi: -12, fraction: 0.05 },
];

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function mean(arr: number[]): number { if (!arr.length) return 0; let s = 0; for (let i = 0; i < arr.length; i++) s += arr[i]; return s / arr.length; }
function stddev(arr: number[]): number { if (arr.length < 2) return 0; const m = mean(arr); return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length); }
function pearson(xs: number[], ys: number[]): number {
  const n = xs.length; if (n < 2) return 0;
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; num += dx * dy; dx2 += dx * dx; dy2 += dy * dy; }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? NaN : num / denom;
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
  ceilingByHash: Map<string, number>; nameMap: Map<string, Player>; payoutTable: Float64Array;
}

interface PortfolioMetrics {
  meanOwn: number; meanProj: number; meanCeiling: number;
  ownStdWithinLineup: number;
  meanPairwiseOverlap: number; maxPairwiseOverlap: number;
  nonFourStackPct: number; uniqueTeams: number; maxTeamExposure: number;
}

function computeMetrics(lineups: Player[][], ceilingByHash: Map<string, number>): PortfolioMetrics {
  if (lineups.length === 0) return { meanOwn: 0, meanProj: 0, meanCeiling: 0, ownStdWithinLineup: 0, meanPairwiseOverlap: 0, maxPairwiseOverlap: 0, nonFourStackPct: 0, uniqueTeams: 0, maxTeamExposure: 0 };
  const luOwns: number[] = [], luProjs: number[] = [], luCeils: number[] = [], luOwnStds: number[] = [];
  let nonFour = 0;
  const teamExp = new Map<string, number>();
  const allStackTeams = new Set<string>();
  const pidSets: Set<string>[] = [];
  for (const players of lineups) {
    const owns = players.map(p => p.ownership || 0);
    luOwns.push(mean(owns));
    luProjs.push(players.reduce((s, p) => s + (p.projection || 0), 0));
    luOwnStds.push(stddev(owns));
    const hash = players.map(p => p.id).sort().join('|');
    const ceil = ceilingByHash.get(hash);
    if (ceil !== undefined) luCeils.push(ceil);
    const counts = new Map<string, number>();
    for (const p of players) if (!p.positions?.includes('P')) counts.set(p.team, (counts.get(p.team) || 0) + 1);
    let maxCount = 0, maxTeam: string | null = null;
    for (const [t, c] of counts) { if (c > maxCount) { maxCount = c; maxTeam = t; } if (c >= 4) allStackTeams.add(t); }
    if (maxCount < 4) nonFour++;
    if (maxTeam && maxCount >= 4) teamExp.set(maxTeam, (teamExp.get(maxTeam) || 0) + 1);
    pidSets.push(new Set(players.map(p => p.id)));
  }
  let maxOvl = 0, sumOvl = 0, pairs = 0;
  for (let i = 0; i < pidSets.length; i++) for (let j = i + 1; j < pidSets.length; j++) {
    let o = 0; for (const id of pidSets[i]) if (pidSets[j].has(id)) o++;
    if (o > maxOvl) maxOvl = o; sumOvl += o; pairs++;
  }
  return {
    meanOwn: mean(luOwns), meanProj: mean(luProjs),
    meanCeiling: luCeils.length > 0 ? mean(luCeils) : 0,
    ownStdWithinLineup: mean(luOwnStds),
    meanPairwiseOverlap: pairs > 0 ? sumOvl / pairs : 0,
    maxPairwiseOverlap: maxOvl,
    nonFourStackPct: lineups.length > 0 ? nonFour / lineups.length * 100 : 0,
    uniqueTeams: allStackTeams.size,
    maxTeamExposure: teamExp.size > 0 ? Math.max(...teamExp.values()) / lineups.length * 100 : 0,
  };
}

function runBaseline(sd: SlateData): Player[][] {
  const r = productionSelect(sd.candidates, sd.poolPlayers, { N, lambda: LAMBDA, comboFreq: sd.comboFreq, maxOverlap: GAMMA });
  return r.portfolio.map(lu => lu.players);
}

function runBinVariant(sd: SlateData, opts: { bins?: { chalk: number; core: number; value: number; contra: number; deep: number }; chalkAvoidX?: number; nu?: number; muAbs?: number }): Player[][] {
  const stackPool = sd.candidates.filter(lu => {
    const tc = new Map<string, number>();
    for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
    let max = 0; for (const c of tc.values()) if (c > max) max = c;
    return max >= 4;
  });
  const anchor = computeAnchor(stackPool, 50);
  let filtered = stackPool;
  if (opts.chalkAvoidX !== undefined) {
    const byOwn = [...stackPool].sort((a, b) => {
      const oa = a.players.reduce((s, p) => s + (p.ownership || 0), 0) / a.players.length;
      const ob = b.players.reduce((s, p) => s + (p.ownership || 0), 0) / b.players.length;
      return ob - oa;
    }).slice(0, Math.min(50, stackPool.length));
    const maxerCentroid = mean(byOwn.map(lu => mean(lu.players.map(p => p.ownership || 0))));
    filtered = stackPool.filter(lu => {
      const o = lu.players.reduce((s, p) => s + (p.ownership || 0), 0) / lu.players.length;
      return o <= maxerCentroid - opts.chalkAvoidX!;
    });
  }
  const meta = filtered.map(lu => {
    const own = lu.players.reduce((s, p) => s + (p.ownership || 0), 0) / lu.players.length;
    const hash = lu.players.map(p => p.id).sort().join('|');
    const ceiling = sd.ceilingByHash.get(hash) ?? lu.projection;
    const cb = comboBonus(lu, sd.comboFreq);
    const pidSet = new Set(lu.players.map(p => p.id));
    const counts = new Map<string, number>();
    for (const p of lu.players) if (!p.positions?.includes('P')) counts.set(p.team, (counts.get(p.team) || 0) + 1);
    let pt: string | null = null, mx = 0;
    for (const [t, c] of counts) if (c > mx) { mx = c; pt = t; }
    return { lu, own, proj: lu.projection, ceiling, cb, pidSet, primaryTeam: mx >= 4 ? pt : null };
  });
  const bins = opts.bins ?? { chalk: 0.10, core: 0.30, value: 0.35, contra: 0.20, deep: 0.05 };
  const binDefs = OWNERSHIP_BINS_BASE.map((b, i) => ({ ...b, fraction: [bins.chalk, bins.core, bins.value, bins.contra, bins.deep][i] }));
  const binned = new Map<string, typeof meta>();
  for (const b of binDefs) binned.set(b.label, []);
  for (const e of meta) {
    const delta = e.own - anchor.ownership;
    for (const b of binDefs) if (delta >= b.deltaLo && delta < b.deltaHi) { binned.get(b.label)!.push(e); break; }
  }
  const nu = opts.nu ?? 0, muAbs = opts.muAbs ?? 0;
  for (const [, entries] of binned) {
    entries.sort((a, b) => {
      const sa = a.proj + nu * (a.ceiling - a.proj) - muAbs * a.own + LAMBDA * a.cb;
      const sb = b.proj + nu * (b.ceiling - b.proj) - muAbs * b.own + LAMBDA * b.cb;
      return sb - sa;
    });
  }
  const allocations = new Map<string, number>();
  let tot = 0;
  for (const b of binDefs) { const c = Math.round(b.fraction * N); allocations.set(b.label, c); tot += c; }
  if (tot !== N) { const largest = binDefs.reduce((a, b) => a.fraction > b.fraction ? a : b); allocations.set(largest.label, allocations.get(largest.label)! + (N - tot)); }
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
    const all = [...meta].sort((a, b) => {
      const sa = a.proj + nu * (a.ceiling - a.proj) - muAbs * a.own + LAMBDA * a.cb;
      const sb = b.proj + nu * (b.ceiling - b.proj) - muAbs * b.own + LAMBDA * b.cb;
      return sb - sa;
    });
    for (const c of all) { if (selected.length >= N) break; if (!canAdd(c)) continue; add(c); }
  }
  return selected.map(lu => lu.players);
}

function runMultiCriteriaNoBins(sd: SlateData, w: { wProj: number; wCeiling: number; wOwn: number }): Player[][] {
  const stackPool = sd.candidates.filter(lu => {
    const tc = new Map<string, number>();
    for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
    let max = 0; for (const c of tc.values()) if (c > max) max = c;
    return max >= 4;
  });
  const projs = stackPool.map(lu => lu.projection);
  const owns = stackPool.map(lu => lu.players.reduce((s, p) => s + (p.ownership || 0), 0) / lu.players.length);
  const ceilings = stackPool.map(lu => sd.ceilingByHash.get(lu.players.map(p => p.id).sort().join('|')) ?? lu.projection);
  const normalize = (arr: number[]) => { const mn = Math.min(...arr), mx = Math.max(...arr); return arr.map(v => mx > mn ? (v - mn) / (mx - mn) : 0); };
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
  return selected.map(lu => lu.players);
}

async function main() {
  console.log(`Target pro: ${PRO_NAME}\n`);
  console.log('Loading slates + precomputing ceilings...');
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
    slateData.push({ slate: s.slate, actuals, actualByHash, candidates: loaded.lineups, poolPlayers: pool.players, comboFreq, ceilingByHash, nameMap, payoutTable });
    console.log(`  ${s.slate}`);
  }

  // Extract pro portfolios per slate
  const proBySlate: Map<string, Player[][]> = new Map();
  const proROIBySlate: Map<string, { fees: number; payout: number; roi: number; hits: number; bestRank: number; medianRank: number; entries: number }> = new Map();
  for (const sd of slateData) {
    const proEntries = sd.actuals.entries.filter(e => e.entryName.toLowerCase().includes(PRO_NAME));
    const proLus: Player[][] = [];
    const ranks: number[] = [];
    let payoutTotal = 0, hits = 0;
    const sortedScores = sd.actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
    const F = sd.actuals.entries.length;
    const top1 = sortedScores[Math.max(0, Math.floor(F * 0.01) - 1)];
    for (const e of proEntries) {
      const pls: Player[] = [];
      let ok = true;
      for (const nm of e.playerNames) { const p = sd.nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
      if (ok) proLus.push(pls);
      let lo = 0, hi = sortedScores.length;
      while (lo < hi) { const m = (lo + hi) >>> 1; if (sortedScores[m] >= e.actualPoints) lo = m + 1; else hi = m; }
      const rank = Math.max(1, lo);
      ranks.push(rank);
      if (e.actualPoints >= top1) hits++;
      const payout = rank <= sd.payoutTable.length ? sd.payoutTable[rank - 1] : 0;
      if (payout > 0) {
        let coWin = 0;
        for (const other of sd.actuals.entries) if (Math.abs(other.actualPoints - e.actualPoints) <= 0.25) coWin++;
        coWin = Math.max(0, coWin - 1);
        payoutTotal += payout / Math.sqrt(1 + coWin * 0.5);
      }
    }
    if (proLus.length > 0) proBySlate.set(sd.slate, proLus);
    const fees = FEE * proEntries.length;
    proROIBySlate.set(sd.slate, {
      fees, payout: payoutTotal,
      roi: fees > 0 ? (payoutTotal / fees - 1) * 100 : 0,
      hits, bestRank: ranks.length > 0 ? Math.min(...ranks) : 0,
      medianRank: ranks.length > 0 ? [...ranks].sort((a, b) => a - b)[Math.floor(ranks.length / 2)] : 0,
      entries: proEntries.length,
    });
  }

  console.log(`\n${PRO_NAME} portfolios: ${[...proBySlate.keys()].join(', ')}`);
  console.log(`\n=== ${PRO_NAME.toUpperCase()} PER-SLATE ROI ===`);
  console.log('Slate     | Entries | Fees   | Payout    | ROI      | Hits | BestRank | MedRank');
  let totalFees = 0, totalPay = 0, totalHits = 0;
  for (const [s, r] of proROIBySlate) {
    console.log(`${s.padEnd(10)}| ${r.entries.toString().padStart(7)} | $${r.fees.toFixed(0).padStart(5)} | $${r.payout.toFixed(0).padStart(8)} | ${r.roi.toFixed(1).padStart(7)}% | ${r.hits.toString().padStart(4)} | ${r.bestRank.toString().padStart(8)} | ${r.medianRank.toString().padStart(7)}`);
    totalFees += r.fees; totalPay += r.payout; totalHits += r.hits;
  }
  const totalROI = totalFees > 0 ? (totalPay / totalFees - 1) * 100 : 0;
  console.log(`TOTAL     |         | $${totalFees.toFixed(0).padStart(5)} | $${totalPay.toFixed(0).padStart(8)} | ${totalROI.toFixed(1)}% | ${totalHits}`);

  // Head-to-head: production baseline per-slate vs pro
  console.log(`\n=== PRODUCTION vs ${PRO_NAME.toUpperCase()} HEAD-TO-HEAD (baseline config) ===`);
  let prodTotal = 0, prodHits = 0;
  console.log('Slate     | Prod $     | Prod hits | Pro $      | Pro hits  | Winner');
  for (const sd of slateData) {
    if (!proBySlate.has(sd.slate)) continue;
    const r = productionSelect(sd.candidates, sd.poolPlayers, { N, lambda: LAMBDA, comboFreq: sd.comboFreq, maxOverlap: GAMMA });
    const sc = scorePortfolio(r.portfolio, sd.actuals, sd.actualByHash, sd.payoutTable);
    const pro = proROIBySlate.get(sd.slate)!;
    prodTotal += sc.totalPayout; prodHits += sc.t1;
    const winner = sc.totalPayout > pro.payout ? 'PROD' : (pro.payout > sc.totalPayout ? PRO_NAME.toUpperCase() : 'tie');
    console.log(`${sd.slate.padEnd(10)}| $${sc.totalPayout.toFixed(0).padStart(9)} | ${sc.t1.toString().padStart(9)} | $${pro.payout.toFixed(0).padStart(9)} | ${pro.hits.toString().padStart(9)} | ${winner}`);
  }
  console.log(`TOTAL     | $${prodTotal.toFixed(0).padStart(9)} | ${prodHits.toString().padStart(9)} | $${totalPay.toFixed(0).padStart(9)} | ${totalHits.toString().padStart(9)}`);

  // Mechanisms for structural tracking
  interface Mechanism { label: string; run: (sd: SlateData) => Player[][]; }
  const mechanisms: Mechanism[] = [
    { label: 'baseline', run: (sd) => runBaseline(sd) },
    { label: 'ν=0.5 μ_abs=0.3', run: (sd) => runBinVariant(sd, { nu: 0.5, muAbs: 0.3 }) },
    { label: 'chalk-avoid X=3', run: (sd) => runBinVariant(sd, { chalkAvoidX: 3 }) },
    { label: 'chalk-avoid X=6', run: (sd) => runBinVariant(sd, { chalkAvoidX: 6 }) },
    { label: 'A5 contra-heavy', run: (sd) => runBinVariant(sd, { bins: { chalk: 0.05, core: 0.25, value: 0.35, contra: 0.25, deep: 0.10 } }) },
    { label: 'M5 own-heavy', run: (sd) => runMultiCriteriaNoBins(sd, { wProj: 0.35, wCeiling: 0.20, wOwn: 0.45 }) },
  ];
  const METRIC_KEYS = ['meanOwn', 'meanProj', 'meanCeiling', 'ownStdWithinLineup', 'meanPairwiseOverlap', 'maxPairwiseOverlap', 'nonFourStackPct', 'uniqueTeams', 'maxTeamExposure'] as const;

  const mechMetrics: Map<string, Map<string, PortfolioMetrics>> = new Map();
  const proMetrics: Map<string, PortfolioMetrics> = new Map();
  for (const m of mechanisms) mechMetrics.set(m.label, new Map());

  console.log('\n\n=== Per-slate metric comparison (pro vs each mechanism) ===');
  for (const sd of slateData) {
    if (!proBySlate.has(sd.slate)) continue;
    const pm = computeMetrics(proBySlate.get(sd.slate)!, sd.ceilingByHash);
    proMetrics.set(sd.slate, pm);
    for (const m of mechanisms) {
      const portfolio = m.run(sd);
      mechMetrics.get(m.label)!.set(sd.slate, computeMetrics(portfolio, sd.ceilingByHash));
    }
  }

  console.log('\n=== PER-SLATE CORRELATION WITH ' + PRO_NAME.toUpperCase() + ' (Pearson r across slates) ===\n');
  console.log('Metric                    | ' + mechanisms.map(m => m.label.padStart(20)).join(' | '));
  const slatesWithPro = [...proBySlate.keys()];
  const trackingScores: Map<string, number[]> = new Map();
  for (const m of mechanisms) trackingScores.set(m.label, []);
  for (const metric of METRIC_KEYS) {
    const proValues: number[] = slatesWithPro.map(s => (proMetrics.get(s) as any)[metric]);
    let row = metric.padEnd(25) + ' | ';
    for (const m of mechanisms) {
      const mechValues = slatesWithPro.map(s => (mechMetrics.get(m.label)!.get(s) as any)[metric]);
      const r = pearson(mechValues, proValues);
      if (!isNaN(r)) trackingScores.get(m.label)!.push(Math.abs(r));
      row += (isNaN(r) ? '  (const)' : r.toFixed(3)).padStart(20) + ' | ';
    }
    console.log(row);
  }

  console.log('\n--- Composite tracking score (avg |r| across non-constant metrics) ---\n');
  const composite: Array<{ label: string; score: number }> = [];
  for (const m of mechanisms) {
    const ts = trackingScores.get(m.label)!;
    composite.push({ label: m.label, score: ts.length > 0 ? mean(ts) : 0 });
  }
  composite.sort((a, b) => b.score - a.score);
  for (const c of composite) console.log(`  ${c.label.padEnd(25)}: ${c.score.toFixed(3)}`);

  // Deep-dive on top tracker
  const top = composite[0];
  console.log(`\n\n--- DEEP DIVE: top tracker = ${top.label} — per slate ---\n`);
  console.log('Slate     | ' + METRIC_KEYS.map(m => m.padStart(11)).join(' | '));
  for (const s of slatesWithPro) {
    const p = proMetrics.get(s)!;
    const t = mechMetrics.get(top.label)!.get(s)!;
    console.log(`${s.padEnd(10)}| PRO  : ${METRIC_KEYS.map(m => ((p as any)[m]).toFixed(1).padStart(11)).join(' | ')}`);
    console.log(`          | ${top.label.slice(0, 6)}: ${METRIC_KEYS.map(m => ((t as any)[m]).toFixed(1).padStart(11)).join(' | ')}`);
  }

  // Net ROI comparison — important summary
  console.log('\n\n================================================================');
  console.log(`${PRO_NAME.toUpperCase()} OVERALL ROI: ${totalROI.toFixed(1)}% on ${totalFees / FEE} entries across ${[...proBySlate.keys()].length} slates`);
  console.log(`PRODUCTION BASELINE ROI on same slates: ${((prodTotal / (FEE * N * [...proBySlate.keys()].length)) - 1) * 100}%`);
  console.log('================================================================');
}

main().catch(e => { console.error(e); process.exit(1); });
