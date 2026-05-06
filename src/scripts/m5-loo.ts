/**
 * M5 (multi-criteria no-bins, ownership-heavy) LOO validation.
 * Full-sample win was +$42,493. Per-slate showed +$56K on 4-6, −$25K on 4-18.
 * LOO across the 5 weight configs from Block 3.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals } from '../parser';
import { getContestConfig } from '../rules';
import { DEFAULT_PRODUCTION_CONFIG, productionSelect } from '../selection/production-selector';
import { precomputeComboFrequencies, comboBonus } from '../selection/combo-leverage';
import { generateWorlds } from '../v35/simulation';

const DIR = 'C:/Users/colin/dfs opto';
const FEE = 20, N = 150, LAMBDA = 0.05, GAMMA = 7, NUM_WORLDS = 1000, SEED = 12345;

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
function mean(arr: number[]): number { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; }

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

function scorePortfolio(portfolio: Lineup[], actuals: ContestActuals, actualByHash: Map<string, number>, payoutTable: Float64Array): number {
  const F = actuals.entries.length;
  const sorted = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
  let totalPayout = 0;
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
    const payout = rank <= payoutTable.length ? payoutTable[rank - 1] : 0;
    if (payout > 0) {
      let coWin = 0;
      for (const e of actuals.entries) if (Math.abs(e.actualPoints - a) <= 0.25) coWin++;
      coWin = Math.max(0, coWin - 1);
      totalPayout += payout / Math.sqrt(1 + coWin * 0.5);
    }
  }
  return totalPayout;
}

function runM5(candidates: Lineup[], comboFreq: Map<string, number>, ceilingByHash: Map<string, number>, w: { wProj: number; wCeiling: number; wOwn: number }): Lineup[] {
  const stackPool = candidates.filter(lu => {
    const tc = new Map<string, number>();
    for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
    let max = 0; for (const c of tc.values()) if (c > max) max = c;
    return max >= 4;
  });
  const projs = stackPool.map(lu => lu.projection);
  const owns = stackPool.map(lu => lu.players.reduce((s, p) => s + (p.ownership || 0), 0) / lu.players.length);
  const ceilings = stackPool.map(lu => ceilingByHash.get(lu.players.map(p => p.id).sort().join('|')) ?? lu.projection);
  const normalize = (arr: number[]) => { const mn = Math.min(...arr), mx = Math.max(...arr); return arr.map(v => mx > mn ? (v - mn) / (mx - mn) : 0); };
  const nProj = normalize(projs), nCeiling = normalize(ceilings), nOwn = normalize(owns);

  const scored = stackPool.map((lu, i) => {
    const cb = comboBonus(lu, comboFreq);
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
  console.log('Loading slates + precomputing ceilings...');
  type SD = { slate: string; actuals: ContestActuals; actualByHash: Map<string, number>; candidates: Lineup[]; poolPlayers: Player[]; comboFreq: Map<string, number>; ceilingByHash: Map<string, number>; payoutTable: Float64Array };
  const slateData: SD[] = [];
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
    console.log(`  ${s.slate}`);
    slateData.push({ slate: s.slate, actuals, actualByHash, candidates: loaded.lineups, poolPlayers: pool.players, comboFreq, ceilingByHash, payoutTable });
  }

  const configs = [
    { label: 'M1 proj-only', w: { wProj: 1.0, wCeiling: 0, wOwn: 0 } },
    { label: 'M2 balanced', w: { wProj: 0.40, wCeiling: 0.25, wOwn: 0.30 } },
    { label: 'M3 ceiling-heavy', w: { wProj: 0.30, wCeiling: 0.45, wOwn: 0.25 } },
    { label: 'M4 user', w: { wProj: 0.40, wCeiling: 0.25, wOwn: 0.35 } },
    { label: 'M5 own-heavy', w: { wProj: 0.35, wCeiling: 0.20, wOwn: 0.45 } },
  ];

  // Grid: configs × slates → payout
  console.log('\nRunning M1-M5 on all slates...');
  const grid: number[][] = [];
  for (const c of configs) {
    const row: number[] = [];
    for (const sd of slateData) {
      const p = runM5(sd.candidates, sd.comboFreq, sd.ceilingByHash, c.w);
      row.push(scorePortfolio(p, sd.actuals, sd.actualByHash, sd.payoutTable));
    }
    grid.push(row);
  }

  // Also baseline
  const baselinePerSlate = slateData.map(sd => {
    const r = productionSelect(sd.candidates, sd.poolPlayers, { N, lambda: LAMBDA, comboFreq: sd.comboFreq, maxOverlap: GAMMA });
    return scorePortfolio(r.portfolio, sd.actuals, sd.actualByHash, sd.payoutTable);
  });
  const baselineTotal = baselinePerSlate.reduce((s, v) => s + v, 0);

  // Report full-sample and per-slate for each config
  console.log('\n=== Per-slate payouts ===');
  console.log('Slate     | baseline  | ' + configs.map(c => c.label.padStart(15)).join(' | '));
  for (let si = 0; si < slateData.length; si++) {
    let row = slateData[si].slate.padEnd(10) + '| $' + baselinePerSlate[si].toFixed(0).padStart(7) + ' | ';
    row += configs.map((_, ci) => ('$' + grid[ci][si].toFixed(0)).padStart(15)).join(' | ');
    console.log(row);
  }
  console.log('TOTAL     | $' + baselineTotal.toFixed(0).padStart(7) + ' | ' +
    configs.map((_, ci) => ('$' + grid[ci].reduce((s, v) => s + v, 0).toFixed(0)).padStart(15)).join(' | '));

  // LOO on M1-M5 grid
  console.log('\n=== LOO on M1-M5 ===\n');
  let looTotal = 0, looBase = 0;
  const picks = new Map<string, number>();
  for (let si = 0; si < slateData.length; si++) {
    let bestCi = 0, bestSum = -Infinity;
    for (let ci = 0; ci < configs.length; ci++) {
      let sum = 0; for (let sj = 0; sj < slateData.length; sj++) if (sj !== si) sum += grid[ci][sj];
      if (sum > bestSum) { bestSum = sum; bestCi = ci; }
    }
    const chosen = configs[bestCi].label;
    picks.set(chosen, (picks.get(chosen) || 0) + 1);
    const held = grid[bestCi][si];
    const base = baselinePerSlate[si];
    looTotal += held; looBase += base;
    console.log(`  ${slateData[si].slate}: chose ${chosen}, held=$${held.toFixed(0)}, baseline=$${base.toFixed(0)}`);
  }
  console.log(`\n  LOO total: $${looTotal.toFixed(0)} vs baseline $${looBase.toFixed(0)} (Δ ${(looTotal - looBase >= 0 ? '+' : '')}$${(looTotal - looBase).toFixed(0)})`);
  console.log(`  Pick distribution:`);
  for (const [k, n] of picks) console.log(`    ${k}: ${n}/${slateData.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
