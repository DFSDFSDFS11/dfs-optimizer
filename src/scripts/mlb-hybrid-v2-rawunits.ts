/**
 * MLB Hybrid V2 — RAW-UNIT hybrid (not z-scored).
 *
 * Starting point: score = projection + λc·comboBonus (= prod-λ0.20 at λc=0.20).
 * Extensions:
 *   + λe·(top01Coverage * 100)    (emax-style top-1% hit signal, scaled)
 *   + λp·(pariEV * 1000)           (parimutuel EV, scaled to ~projection magnitude)
 *
 * Pre-computed scaling factors:
 *   projection:     ~100 per lineup
 *   comboBonus:     ~0-5 per lineup
 *   top01Coverage:  0-0.05 (fraction of worlds in top-1%) → ×100 to ~0-5
 *   pariEV:         ~$0.01-0.03 per world → ×1000 to ~10-30
 *
 * Sweep fine grid around the prod-λ0.20 point + optional corner cap + floor.
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
import {
  DEFAULT_SELECTOR_PARAMS,
  SelectorParams,
  defaultGamma,
  getSportDefaults,
  precomputeSlate,
} from '../selection/algorithm7-selector';
import { precomputeComboFrequencies, comboBonus } from '../selection/combo-leverage';
import { computeAnchor } from '../selection/anchor-relative';

const DIR = 'C:/Users/colin/dfs opto';
const OUT_JSON = path.join(DIR, 'mlb_hybrid_v2.json');
const OUT_MD = path.join(DIR, 'mlb_hybrid_v2.md');
const FEE = 20;
const N = 150;

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

interface SlateCache {
  slate: string;
  candidatePool: Lineup[];
  players: Player[];
  actuals: ContestActuals;
  actualByHash: Map<string, number>;
  sorted: number[];
  top1Thresh: number;
  payoutTable: Float64Array;
  F: number;
  anchor: ReturnType<typeof computeAnchor>;
  // Raw signals
  projection: Float64Array;
  combo: Float64Array;
  top01Cov: Float64Array;       // 0-1 fraction
  pariEV: Float64Array;         // raw EV per world
  ownership: Float64Array;
  primaryTeam: string[];
  pidSets: Set<string>[];
}

async function loadSlate(s: typeof SLATES[0]): Promise<SlateCache | null> {
  const projPath = path.join(DIR, s.proj);
  const actualsPath = path.join(DIR, s.actuals);
  const poolPath = path.join(DIR, s.pool);
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
  const payoutTable = buildPayoutTable(F);
  const top1Thresh = sorted[Math.max(0, Math.floor(F * 0.01) - 1)] || 0;
  const actualByHash = new Map<string, number>();
  for (const e of actuals.entries) {
    const pls: Player[] = []; let ok = true;
    for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
    if (!ok) continue;
    actualByHash.set(pls.map(p => p.id).sort().join('|'), e.actualPoints);
  }
  const fieldLineups: Lineup[] = [];
  const seenH = new Set<string>();
  for (const e of actuals.entries) {
    const pls: Player[] = []; let ok = true;
    for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
    if (!ok) continue;
    const hash = pls.map(p => p.id).sort().join('|');
    if (seenH.has(hash)) continue;
    seenH.add(hash);
    const sal = pls.reduce((s, p) => s + p.salary, 0);
    const proj = pls.reduce((s, p) => s + p.projection, 0);
    const own = pls.reduce((s, p) => s + (p.ownership || 0), 0) / pls.length;
    fieldLineups.push({ players: pls, salary: sal, projection: proj, ownership: own, hash });
  }
  const selParams: SelectorParams = {
    ...DEFAULT_SELECTOR_PARAMS, ...getSportDefaults('mlb'),
    N, gamma: defaultGamma(config.rosterSize), numWorlds: 1500,
    marginalRewardMode: 'log_payout' as any,
  };
  const precomp = precomputeSlate(loaded.lineups, fieldLineups.length >= 100 ? fieldLineups : loaded.lineups, pool.players, selParams, 'mlb');

  const C = precomp.C; const W = precomp.W;
  const projection = new Float64Array(C);
  const combo = new Float64Array(C);
  const top01Cov = new Float64Array(C);
  const pariEV = new Float64Array(C);
  const ownership = new Float64Array(C);
  const primaryTeam: string[] = new Array(C);
  const pidSets: Set<string>[] = new Array(C);
  for (let c = 0; c < C; c++) {
    const lu = precomp.candidatePool[c];
    projection[c] = lu.projection;
    combo[c] = comboBonus(lu, comboFreq);
    const base = c * W;
    let hits = 0;
    for (let w = 0; w < W; w++) if (precomp.candidateWorldScores[base + w] >= precomp.thresh1[w]) hits++;
    top01Cov[c] = hits / W;
    let evSum = 0;
    if (precomp.candidatePayoutPerWorld) {
      for (let w = 0; w < W; w++) evSum += precomp.candidatePayoutPerWorld[base + w];
      pariEV[c] = evSum / W;
    }
    let ownSum = 0; for (const p of lu.players) ownSum += p.ownership || 0;
    ownership[c] = ownSum / lu.players.length;
    const tc = new Map<string, number>();
    for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
    let bt = '', bn = 0; for (const [t, n] of tc) if (n > bn) { bt = t; bn = n; }
    primaryTeam[c] = bt;
    pidSets[c] = new Set(lu.players.map(p => p.id));
  }
  const anchor = computeAnchor(loaded.lineups, 50);
  return {
    slate: s.slate, candidatePool: precomp.candidatePool, players: pool.players,
    actuals, actualByHash, sorted, top1Thresh, payoutTable, F, anchor,
    projection, combo, top01Cov, pariEV, ownership, primaryTeam, pidSets,
  };
}

// ============================================================
// HYBRID V2 RUNNER
// ============================================================

interface HybridWeights { lambdaCombo: number; lambdaEmax: number; lambdaPari: number; }
interface HybridConfig {
  w: HybridWeights;
  projFloorPct: number;
  extremeCornerCap: boolean;
  maxOverlap: number;
}

const OWN_BINS = [
  { label: 'chalk',  deltaLo: -2,  deltaHi: 99 },
  { label: 'core',   deltaLo: -5,  deltaHi: -2 },
  { label: 'value',  deltaLo: -8,  deltaHi: -5 },
  { label: 'contra', deltaLo: -12, deltaHi: -8 },
  { label: 'deep',   deltaLo: -20, deltaHi: -12 },
];
const BIN_FRACTIONS: [number, number, number, number, number] = [0.10, 0.30, 0.35, 0.20, 0.05];
const TEAM_CAP_PCT = 0.10;
const MAX_EXPOSURE = 0.40;

function runHybrid(sd: SlateCache, cfg: HybridConfig): Lineup[] {
  const C = sd.candidatePool.length;
  const { lambdaCombo, lambdaEmax, lambdaPari } = cfg.w;

  // RAW-UNIT score (match prod-λ0.20 exact when λe=λp=0):
  // score = projection + lambdaCombo * comboBonus + lambdaEmax * (top01Cov * 100) + lambdaPari * (pariEV * 1000)
  const score = new Float64Array(C);
  for (let c = 0; c < C; c++) {
    score[c] = sd.projection[c]
      + lambdaCombo * sd.combo[c]
      + lambdaEmax * sd.top01Cov[c] * 100
      + lambdaPari * sd.pariEV[c] * 1000;
  }

  // Projection floor
  const optimalProj = sd.candidatePool.reduce((m, lu) => lu.projection > m ? lu.projection : m, 0);
  const floor = cfg.projFloorPct * optimalProj;

  type Meta = { c: number; lu: Lineup; own: number; proj: number; score: number; primaryTeam: string; pidSet: Set<string>; projQ: number; ownQ: number };

  // Pool-wide quintiles for extreme-corner cap
  let projQThresh: [number, number, number, number] = [0, 0, 0, 0];
  let ownQThresh: [number, number, number, number] = [0, 0, 0, 0];
  if (cfg.extremeCornerCap) {
    const p = [...sd.projection].sort((a, b) => a - b);
    const o = [...sd.ownership].sort((a, b) => a - b);
    const n = p.length;
    projQThresh = [p[Math.floor(n * 0.2)], p[Math.floor(n * 0.4)], p[Math.floor(n * 0.6)], p[Math.floor(n * 0.8)]];
    ownQThresh = [o[Math.floor(n * 0.2)], o[Math.floor(n * 0.4)], o[Math.floor(n * 0.6)], o[Math.floor(n * 0.8)]];
  }
  const projQ = (p: number) => p >= projQThresh[3] ? 4 : p >= projQThresh[2] ? 3 : p >= projQThresh[1] ? 2 : p >= projQThresh[0] ? 1 : 0;
  const ownQ = (o: number) => o >= ownQThresh[3] ? 4 : o >= ownQThresh[2] ? 3 : o >= ownQThresh[1] ? 2 : o >= ownQThresh[0] ? 1 : 0;

  const metas: Meta[] = [];
  for (let c = 0; c < C; c++) {
    if (cfg.projFloorPct > 0 && sd.projection[c] < floor) continue;
    metas.push({
      c, lu: sd.candidatePool[c], own: sd.ownership[c], proj: sd.projection[c],
      score: score[c], primaryTeam: sd.primaryTeam[c], pidSet: sd.pidSets[c],
      projQ: cfg.extremeCornerCap ? projQ(sd.projection[c]) : 0,
      ownQ: cfg.extremeCornerCap ? ownQ(sd.ownership[c]) : 0,
    });
  }

  // Bin allocation
  const binned: Meta[][] = [[], [], [], [], []];
  for (const m of metas) {
    const delta = m.own - sd.anchor.ownership;
    for (let b = 0; b < OWN_BINS.length; b++) {
      if (delta >= OWN_BINS[b].deltaLo && delta < OWN_BINS[b].deltaHi) { binned[b].push(m); break; }
    }
  }
  for (const bin of binned) bin.sort((a, b) => b.score - a.score);

  const targets = BIN_FRACTIONS.map(f => Math.round(f * N));
  const tSum = targets.reduce((a, b) => a + b, 0);
  if (tSum !== N) targets[2] += N - tSum;

  const selected: Lineup[] = [];
  const selectedPidSets: Set<string>[] = [];
  const playerCount = new Map<string, number>();
  const teamCount = new Map<string, number>();
  let q5q5Used = 0, q1q1Used = 0;
  const q5q5Cap = Math.ceil(0.25 * N);
  const q1q1Cap = Math.ceil(0.05 * N);
  const teamCapN = Math.ceil(TEAM_CAP_PCT * N);
  const expCap = Math.ceil(MAX_EXPOSURE * N);

  const canAdd = (m: Meta): boolean => {
    for (const p of m.lu.players) if ((playerCount.get(p.id) || 0) >= expCap) return false;
    if ((teamCount.get(m.primaryTeam) || 0) >= teamCapN) return false;
    if (cfg.maxOverlap < 10) {
      for (const s of selectedPidSets) {
        let ov = 0;
        for (const id of m.pidSet) if (s.has(id)) { ov++; if (ov > cfg.maxOverlap) return false; }
      }
    }
    if (cfg.extremeCornerCap) {
      if (m.projQ === 4 && m.ownQ === 4 && q5q5Used >= q5q5Cap) return false;
      if (m.projQ === 0 && m.ownQ === 0 && q1q1Used >= q1q1Cap) return false;
    }
    return true;
  };
  const add = (m: Meta) => {
    selected.push(m.lu);
    selectedPidSets.push(m.pidSet);
    for (const p of m.lu.players) playerCount.set(p.id, (playerCount.get(p.id) || 0) + 1);
    teamCount.set(m.primaryTeam, (teamCount.get(m.primaryTeam) || 0) + 1);
    if (cfg.extremeCornerCap) {
      if (m.projQ === 4 && m.ownQ === 4) q5q5Used++;
      if (m.projQ === 0 && m.ownQ === 0) q1q1Used++;
    }
  };

  for (const bi of [1, 2, 0, 3, 4]) {
    const target = targets[bi];
    const cands = binned[bi];
    let filled = 0;
    for (const c of cands) { if (filled >= target) break; if (!canAdd(c)) continue; add(c); filled++; }
  }
  if (selected.length < N) {
    const all = [...metas].sort((a, b) => b.score - a.score);
    for (const m of all) { if (selected.length >= N) break; if (selectedPidSets.includes(m.pidSet)) continue; if (!canAdd(m)) continue; add(m); }
  }
  return selected;
}

// ============================================================
// MAIN
// ============================================================

interface Combo { id: string; cfg: HybridConfig; }

function makeCombos(): Combo[] {
  const combos: Combo[] = [];
  // λc sweep (finer grid near 0.20):
  const lcGrid = [0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40];
  const leGrid = [0, 0.25, 0.5, 1.0, 2.0, 4.0];     // emax signal in 0-~5 after ×100
  const lpGrid = [0, 0.25, 0.5, 1.0, 2.0];          // pari signal in 0-~30 after ×1000
  const floors = [0, 0.90];
  const corners = [false, true];

  for (const lc of lcGrid) {
    for (const le of leGrid) {
      for (const lp of lpGrid) {
        for (const f of floors) {
          for (const corner of corners) {
            // Skip pure projection × corner × floor variants with no extensions if lc=0.05 already covered
            const id = `λc${lc}|λe${le}|λp${lp}|floor${f}${corner ? '|corner' : ''}`;
            combos.push({ id, cfg: { w: { lambdaCombo: lc, lambdaEmax: le, lambdaPari: lp }, projFloorPct: f, extremeCornerCap: corner, maxOverlap: 7 } });
          }
        }
      }
    }
  }
  return combos;
}

async function main() {
  console.log('================================================================');
  console.log(`MLB HYBRID V2 — RAW-UNIT sweep; base = projection + 0.20·combo (prod-λ0.20)`);
  console.log('================================================================\n');

  const combos = makeCombos();
  console.log(`Configs: ${combos.length}\n`);

  const cache: SlateCache[] = [];
  for (const s of SLATES) {
    console.log(`Loading+precomp ${s.slate}...`);
    try { const c = await loadSlate(s); if (c) cache.push(c); }
    catch (e: any) { console.log(`  skip: ${e.message}`); }
  }
  console.log(`\n${cache.length} slates loaded.\n`);

  interface Row { combo: string; slate: string; pay: number; t1: number }
  const rows: Row[] = [];
  let done = 0;
  for (const combo of combos) {
    for (const sd of cache) {
      const pf = runHybrid(sd, combo.cfg);
      const s = scorePortfolio(pf, sd.actuals, sd.actualByHash, sd.sorted, sd.payoutTable, sd.top1Thresh);
      rows.push({ combo: combo.id, slate: sd.slate, pay: s.pay, t1: s.t1 });
    }
    done++;
    if (done % 50 === 0) console.log(`  processed ${done}/${combos.length}`);
  }
  fs.writeFileSync(OUT_JSON, JSON.stringify(rows, null, 2));

  interface Summary { combo: string; full: number; t1: number; recent: number; recentT1: number; minLoo: number; profitable: number; slates: number }
  const summaries: Summary[] = [];
  for (const combo of combos) {
    const r = rows.filter(x => x.combo === combo.id);
    const pays = r.map(x => x.pay);
    let full = 0, t1 = 0, recent = 0, recentT1 = 0, profitable = 0;
    for (const x of r) {
      full += x.pay; t1 += x.t1;
      if (x.pay > FEE * N) profitable++;
      if (RECENT.has(x.slate)) { recent += x.pay; recentT1 += x.t1; }
    }
    const loos = pays.map((_, i) => { let s = 0, cnt = 0; for (let j = 0; j < pays.length; j++) if (j !== i) { s += pays[j]; cnt++; } return cnt > 0 ? s / cnt : 0; });
    const minLoo = loos.length ? Math.min(...loos) : 0;
    summaries.push({ combo: combo.id, full, t1, recent, recentT1, minLoo, profitable, slates: r.length });
  }

  summaries.sort((a, b) => b.full - a.full);

  const SHIPPED_FULL = 33231;
  const LAMBDA020_FULL = 47864;
  const LAMBDA020_RECENT = 42235;

  console.log('\n================ TOP 25 BY FULL-SAMPLE ================\n');
  console.log('Rank | Combo                                               | Full     | Recent   | min-LOO | Profit | vs λ0.20');
  console.log('-'.repeat(125));
  for (let i = 0; i < Math.min(25, summaries.length); i++) {
    const s = summaries[i];
    const dλ = s.full - LAMBDA020_FULL;
    console.log(`  ${(i + 1).toString().padStart(2)} | ${s.combo.padEnd(52)} | $${s.full.toFixed(0).padStart(6)} | $${s.recent.toFixed(0).padStart(6)} | $${s.minLoo.toFixed(0).padStart(5)} | ${s.profitable}/${s.slates} | ${dλ >= 0 ? '+' : ''}$${dλ.toFixed(0)}`);
  }

  // Did anything beat prod-λ0.20?
  const beats = summaries.filter(s => s.full > LAMBDA020_FULL);
  console.log(`\nConfigs beating prod-λ0.20 ($${LAMBDA020_FULL}) on full-sample: ${beats.length}`);
  const beatsRecent = summaries.filter(s => s.recent > LAMBDA020_RECENT);
  console.log(`Configs beating prod-λ0.20 recent ($${LAMBDA020_RECENT}): ${beatsRecent.length}`);
  const beatsBoth = summaries.filter(s => s.full > LAMBDA020_FULL && s.recent > LAMBDA020_RECENT);
  console.log(`Configs beating both: ${beatsBoth.length}`);

  if (beats.length > 0) {
    console.log('\n  All beating full-sample:');
    for (const s of beats.slice(0, 20)) {
      console.log(`    ${s.combo.padEnd(52)} full $${s.full.toFixed(0)}  recent $${s.recent.toFixed(0)}  min-LOO $${s.minLoo.toFixed(0)}`);
    }
  }

  console.log('\n================ TOP 15 BY RECENT ================\n');
  const bR = [...summaries].sort((a, b) => b.recent - a.recent);
  for (let i = 0; i < 15; i++) {
    const s = bR[i];
    console.log(`  ${(i + 1).toString().padStart(2)} | ${s.combo.padEnd(52)} | recent $${s.recent.toFixed(0).padStart(6)} | full $${s.full.toFixed(0).padStart(6)} | min-LOO $${s.minLoo.toFixed(0).padStart(4)}`);
  }

  console.log('\n================ TOP 15 BY min-LOO ================\n');
  const bL = [...summaries].sort((a, b) => b.minLoo - a.minLoo);
  for (let i = 0; i < 15; i++) {
    const s = bL[i];
    console.log(`  ${(i + 1).toString().padStart(2)} | ${s.combo.padEnd(52)} | min-LOO $${s.minLoo.toFixed(0).padStart(4)} | full $${s.full.toFixed(0).padStart(6)} | recent $${s.recent.toFixed(0).padStart(6)}`);
  }

  // Markdown
  let md = `# MLB Hybrid V2 — Raw Unit Sweep\n\n`;
  md += `Score = projection + λ_c·comboBonus + λ_e·(top01Cov×100) + λ_p·(pariEV×1000)\n\n`;
  md += `Baseline reference: prod-λ0.20 = λc=0.20, λe=0, λp=0, no floor, no corner → $${LAMBDA020_FULL} full / $${LAMBDA020_RECENT} recent.\n\n`;
  md += `## Top 25 by full-sample\n\n`;
  md += `| Rank | Combo | Full | Recent | min-LOO | Profit | Δ λ0.20 |\n|---:|---|---:|---:|---:|---:|---:|\n`;
  for (let i = 0; i < Math.min(25, summaries.length); i++) {
    const s = summaries[i];
    md += `| ${i + 1} | \`${s.combo}\` | $${s.full.toFixed(0)} | $${s.recent.toFixed(0)} | $${s.minLoo.toFixed(0)} | ${s.profitable}/${s.slates} | ${s.full - LAMBDA020_FULL >= 0 ? '+' : ''}$${(s.full - LAMBDA020_FULL).toFixed(0)} |\n`;
  }
  md += `\nConfigs beating prod-λ0.20 full-sample ($${LAMBDA020_FULL}): **${beats.length}**\n`;
  md += `Configs beating prod-λ0.20 recent ($${LAMBDA020_RECENT}): **${beatsRecent.length}**\n`;
  md += `Configs beating both: **${beatsBoth.length}**\n`;

  fs.writeFileSync(OUT_MD, md);
  console.log(`\nJSON: ${OUT_JSON}`);
  console.log(`MD:   ${OUT_MD}`);
}

main().catch(e => { console.error(e); process.exit(1); });
