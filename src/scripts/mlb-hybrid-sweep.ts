/**
 * MLB Hybrid Selector Sweep
 *
 * ONE unified score combining the best signals from the top-5 selectors:
 *   score = α·proj_z + β·combo_z + γ·top01Cov_z + δ·pariEV_z
 *
 * where _z = z-score within candidate pool (scale normalization). These map to:
 *   α = projection (baseline)
 *   β = prod-λ0.20's combo leverage
 *   γ = emax's top-1% coverage signal
 *   δ = parimutuel's expected payout per world
 *
 * Applied inside production's bin architecture (10/30/35/20/5), γ=7 overlap,
 * 10% team cap. Sweeps (α, β, γ, δ) on the simplex to find weights that beat
 * every individual top-5 selector.
 *
 * Per-slate we compute precomp ONCE. Each weight combo is then a cheap
 * re-scoring + re-greedy. Sweep size stays reasonable.
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
const OUT_JSON = path.join(DIR, 'mlb_hybrid_sweep.json');
const OUT_MD = path.join(DIR, 'mlb_hybrid_sweep.md');
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

// ============================================================
// SLATE LOAD + PRECOMP
// ============================================================

interface SlateCache {
  slate: string;
  pool: Lineup[];
  candidatePool: Lineup[];       // pool aligned with precomp rows
  players: Player[];
  actuals: ContestActuals;
  actualByHash: Map<string, number>;
  sorted: number[];
  top1Thresh: number;
  payoutTable: Float64Array;
  F: number;
  anchor: ReturnType<typeof computeAnchor>;
  comboFreq: Map<string, number>;
  // Per-candidate signals (aligned with candidatePool):
  projection: Float64Array;
  combo: Float64Array;
  top01Cov: Float64Array;
  pariEV: Float64Array;
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
    for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
    if (!ok) continue;
    actualByHash.set(pls.map(p => p.id).sort().join('|'), e.actualPoints);
  }

  // Build field for precomp (actual contest entries)
  const fieldLineups: Lineup[] = [];
  const seenH = new Set<string>();
  for (const e of actuals.entries) {
    const pls: Player[] = [];
    let ok = true;
    for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
    if (!ok) continue;
    const hash = pls.map(p => p.id).sort().join('|');
    if (seenH.has(hash)) continue;
    seenH.add(hash);
    const sal = pls.reduce((sm, p) => sm + p.salary, 0);
    const proj = pls.reduce((sm, p) => sm + p.projection, 0);
    const own = pls.reduce((sm, p) => sm + (p.ownership || 0), 0) / pls.length;
    fieldLineups.push({ players: pls, salary: sal, projection: proj, ownership: own, hash });
  }

  // Precomp with log_payout mode so candidatePayoutPerWorld is populated
  const selParams: SelectorParams = {
    ...DEFAULT_SELECTOR_PARAMS,
    ...getSportDefaults('mlb'),
    N,
    gamma: defaultGamma(config.rosterSize),
    numWorlds: 1500,
    marginalRewardMode: 'log_payout' as any,
  };
  const precomp = precomputeSlate(loaded.lineups, fieldLineups.length >= 100 ? fieldLineups : loaded.lineups, pool.players, selParams, 'mlb');

  // Build per-candidate signals
  const C = precomp.C;
  const W = precomp.W;
  const projection = new Float64Array(C);
  const combo = new Float64Array(C);
  const top01Cov = new Float64Array(C);
  const pariEV = new Float64Array(C);
  const ownership = new Float64Array(C);
  const primaryTeam: string[] = new Array(C);
  const pidSets: Set<string>[] = new Array(C);

  // Compute top-0.1% (thresh01) — using emax's notion. We use thresh1 (top-1%) as "coverage" metric.
  for (let c = 0; c < C; c++) {
    const lu = precomp.candidatePool[c];
    projection[c] = lu.projection;
    combo[c] = comboBonus(lu, comboFreq);
    // top-1% hit coverage = fraction of worlds where candidate is above thresh1
    let hits = 0;
    const base = c * W;
    for (let w = 0; w < W; w++) {
      if (precomp.candidateWorldScores[base + w] >= precomp.thresh1[w]) hits++;
    }
    top01Cov[c] = hits / W;
    // Parimutuel EV = mean payout across worlds
    let evSum = 0;
    if (precomp.candidatePayoutPerWorld) {
      for (let w = 0; w < W; w++) evSum += precomp.candidatePayoutPerWorld[base + w];
      pariEV[c] = evSum / W;
    }
    // Ownership + primary team
    let ownSum = 0;
    for (const p of lu.players) ownSum += p.ownership || 0;
    ownership[c] = ownSum / lu.players.length;
    const teamCount = new Map<string, number>();
    for (const p of lu.players) {
      if (!p.positions?.includes('P')) teamCount.set(p.team, (teamCount.get(p.team) || 0) + 1);
    }
    let bt = '', bc = 0;
    for (const [t, n] of teamCount) if (n > bc) { bt = t; bc = n; }
    primaryTeam[c] = bt;
    pidSets[c] = new Set(lu.players.map(p => p.id));
  }

  const anchor = computeAnchor(loaded.lineups, 50);

  return {
    slate: s.slate, pool: loaded.lineups, candidatePool: precomp.candidatePool, players: pool.players,
    actuals, actualByHash, sorted, top1Thresh, payoutTable, F, anchor, comboFreq,
    projection, combo, top01Cov, pariEV, ownership, primaryTeam, pidSets,
  };
}

// ============================================================
// HYBRID SELECTOR
// ============================================================

interface HybridWeights {
  alpha: number;  // projection
  beta: number;   // combo bonus
  gamma: number;  // top-01 coverage
  delta: number;  // parimutuel EV
}

interface HybridConfig {
  weights: HybridWeights;
  projFloorPct: number;       // 0 = off; 0.9 = 90% of optimal
  maxOverlap: number;         // γ=7 default
  teamCapPct: number;         // 0.10 default
  maxExposure: number;        // 0.40 default
  // Bin allocation (10/30/35/20/5 default)
  binFractions: [number, number, number, number, number];
  ownDropPP: number;          // anchor - Xpp target
}

const DEFAULT_HYBRID: HybridConfig = {
  weights: { alpha: 1.0, beta: 0.0, gamma: 0.0, delta: 0.0 }, // starts as pure projection
  projFloorPct: 0,
  maxOverlap: 7,
  teamCapPct: 0.10,
  maxExposure: 0.40,
  binFractions: [0.10, 0.30, 0.35, 0.20, 0.05],
  ownDropPP: 6.0,
};

const OWN_BINS = [
  { label: 'chalk',  deltaLo: -2,  deltaHi: 99 },
  { label: 'core',   deltaLo: -5,  deltaHi: -2 },
  { label: 'value',  deltaLo: -8,  deltaHi: -5 },
  { label: 'contra', deltaLo: -12, deltaHi: -8 },
  { label: 'deep',   deltaLo: -20, deltaHi: -12 },
];

function zscore(arr: Float64Array): Float64Array {
  let mean = 0;
  for (let i = 0; i < arr.length; i++) mean += arr[i];
  mean /= arr.length;
  let v = 0;
  for (let i = 0; i < arr.length; i++) v += (arr[i] - mean) ** 2;
  const std = Math.sqrt(v / arr.length);
  const z = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i++) z[i] = std > 0 ? (arr[i] - mean) / std : 0;
  return z;
}

function runHybrid(sd: SlateCache, cfg: HybridConfig): Lineup[] {
  const C = sd.candidatePool.length;
  const { alpha, beta, gamma, delta } = cfg.weights;

  // Z-score each signal
  const zProj = zscore(sd.projection);
  const zCombo = zscore(sd.combo);
  const zTop01 = zscore(sd.top01Cov);
  const zPariEV = zscore(sd.pariEV);

  // Combined score
  const score = new Float64Array(C);
  for (let c = 0; c < C; c++) {
    score[c] = alpha * zProj[c] + beta * zCombo[c] + gamma * zTop01[c] + delta * zPariEV[c];
  }

  // Apply projection floor filter
  const optimalProj = sd.candidatePool.reduce((m, lu) => lu.projection > m ? lu.projection : m, 0);
  const floor = cfg.projFloorPct * optimalProj;

  // Build metadata array
  type Meta = { c: number; lu: Lineup; own: number; proj: number; score: number; primaryTeam: string; pidSet: Set<string> };
  const metas: Meta[] = [];
  for (let c = 0; c < C; c++) {
    if (cfg.projFloorPct > 0 && sd.projection[c] < floor) continue;
    metas.push({
      c, lu: sd.candidatePool[c], own: sd.ownership[c], proj: sd.projection[c],
      score: score[c], primaryTeam: sd.primaryTeam[c], pidSet: sd.pidSets[c],
    });
  }

  // Bin allocation (anchor-relative)
  const anchor = sd.anchor;
  const binned: Meta[][] = [[], [], [], [], []];
  for (const m of metas) {
    const delta = m.own - anchor.ownership;
    for (let b = 0; b < OWN_BINS.length; b++) {
      if (delta >= OWN_BINS[b].deltaLo && delta < OWN_BINS[b].deltaHi) { binned[b].push(m); break; }
    }
  }
  for (const bin of binned) bin.sort((a, b) => b.score - a.score);

  // Targets
  const tot = cfg.binFractions.reduce((a, b) => a + b, 0);
  const targets = cfg.binFractions.map(f => Math.round(f / tot * N));
  const tSum = targets.reduce((a, b) => a + b, 0);
  if (tSum !== N) targets[2] += N - tSum; // put remainder in value

  // Greedy select with constraints
  const selected: Lineup[] = [];
  const selectedPidSets: Set<string>[] = [];
  const playerCount = new Map<string, number>();
  const teamCount = new Map<string, number>();
  const teamCapN = Math.ceil(cfg.teamCapPct * N);
  const expCap = Math.ceil(cfg.maxExposure * N);

  const canAdd = (m: Meta): boolean => {
    for (const p of m.lu.players) if ((playerCount.get(p.id) || 0) >= expCap) return false;
    if ((teamCount.get(m.primaryTeam) || 0) >= teamCapN) return false;
    if (cfg.maxOverlap < 10) {
      for (const s of selectedPidSets) {
        let ov = 0;
        for (const id of m.pidSet) if (s.has(id)) { ov++; if (ov > cfg.maxOverlap) return false; }
      }
    }
    return true;
  };
  const add = (m: Meta) => {
    selected.push(m.lu);
    selectedPidSets.push(m.pidSet);
    for (const p of m.lu.players) playerCount.set(p.id, (playerCount.get(p.id) || 0) + 1);
    teamCount.set(m.primaryTeam, (teamCount.get(m.primaryTeam) || 0) + 1);
  };

  // Fill bins in core→value→chalk→contra→deep order
  const fillOrder = [1, 2, 0, 3, 4];
  for (const bi of fillOrder) {
    const target = targets[bi];
    const cands = binned[bi];
    let filled = 0;
    for (const c of cands) {
      if (filled >= target) break;
      if (!canAdd(c)) continue;
      add(c); filled++;
    }
  }

  // Fill remainder by score
  if (selected.length < N) {
    const all = [...metas].sort((a, b) => b.score - a.score);
    for (const m of all) {
      if (selected.length >= N) break;
      if (selectedPidSets.some(s => s === m.pidSet)) continue;
      if (!canAdd(m)) continue;
      add(m);
    }
  }

  return selected;
}

// ============================================================
// MAIN SWEEP
// ============================================================

interface Combo {
  id: string;
  cfg: HybridConfig;
}

function makeCombos(): Combo[] {
  const combos: Combo[] = [];
  // Structured sweep — 4-knob simplex + projection floor variants
  // Weight grid: alpha, beta, gamma, delta each in {0, 0.25, 0.5, 1.0, 2.0}
  // Not exhaustive — 5^4 = 625 way too much. Do a Latin-cube-ish subset.
  const weightSets: HybridWeights[] = [
    // Pure baselines
    { alpha: 1.0, beta: 0.0, gamma: 0.0, delta: 0.0 },    // baseline (proj only)
    { alpha: 0.0, beta: 1.0, gamma: 0.0, delta: 0.0 },
    { alpha: 0.0, beta: 0.0, gamma: 1.0, delta: 0.0 },
    { alpha: 0.0, beta: 0.0, gamma: 0.0, delta: 1.0 },

    // Two-way blends
    { alpha: 1.0, beta: 0.5, gamma: 0.0, delta: 0.0 },    // proj + combo
    { alpha: 1.0, beta: 1.0, gamma: 0.0, delta: 0.0 },
    { alpha: 1.0, beta: 0.0, gamma: 0.5, delta: 0.0 },    // proj + emax
    { alpha: 1.0, beta: 0.0, gamma: 1.0, delta: 0.0 },
    { alpha: 1.0, beta: 0.0, gamma: 0.0, delta: 0.5 },    // proj + pari
    { alpha: 1.0, beta: 0.0, gamma: 0.0, delta: 1.0 },

    // Three-way: proj + combo + emax
    { alpha: 1.0, beta: 0.5, gamma: 0.5, delta: 0.0 },
    { alpha: 1.0, beta: 1.0, gamma: 0.5, delta: 0.0 },
    { alpha: 1.0, beta: 0.5, gamma: 1.0, delta: 0.0 },
    { alpha: 1.0, beta: 1.0, gamma: 1.0, delta: 0.0 },

    // Three-way: proj + combo + pari
    { alpha: 1.0, beta: 0.5, gamma: 0.0, delta: 0.5 },
    { alpha: 1.0, beta: 1.0, gamma: 0.0, delta: 0.5 },
    { alpha: 1.0, beta: 0.5, gamma: 0.0, delta: 1.0 },

    // Three-way: proj + emax + pari
    { alpha: 1.0, beta: 0.0, gamma: 0.5, delta: 0.5 },
    { alpha: 1.0, beta: 0.0, gamma: 1.0, delta: 0.5 },
    { alpha: 1.0, beta: 0.0, gamma: 0.5, delta: 1.0 },

    // FULL four-way blends — the "combine everything" variants
    { alpha: 1.0, beta: 0.25, gamma: 0.25, delta: 0.25 },
    { alpha: 1.0, beta: 0.5,  gamma: 0.5,  delta: 0.5 },
    { alpha: 1.0, beta: 1.0,  gamma: 1.0,  delta: 1.0 },
    { alpha: 1.0, beta: 1.0,  gamma: 0.5,  delta: 0.5 },
    { alpha: 1.0, beta: 0.5,  gamma: 1.0,  delta: 0.5 },
    { alpha: 1.0, beta: 0.5,  gamma: 0.5,  delta: 1.0 },
    { alpha: 2.0, beta: 1.0,  gamma: 1.0,  delta: 1.0 },   // projection-dominant
    { alpha: 0.5, beta: 1.0,  gamma: 1.0,  delta: 1.0 },   // signals-dominant
  ];

  const floors = [0, 0.85, 0.90];
  for (const w of weightSets) {
    for (const f of floors) {
      const wid = `α${w.alpha}β${w.beta}γ${w.gamma}δ${w.delta}`;
      combos.push({
        id: `${wid}|floor${f}`,
        cfg: { ...DEFAULT_HYBRID, weights: w, projFloorPct: f },
      });
    }
  }
  return combos;
}

async function main() {
  console.log('================================================================');
  console.log(`MLB HYBRID SWEEP — unified score combining top-selector signals`);
  console.log('================================================================\n');

  const combos = makeCombos();
  console.log(`Configs: ${combos.length}\n`);

  const cache: SlateCache[] = [];
  for (const s of SLATES) {
    console.log(`Loading + precomping ${s.slate}...`);
    try {
      const c = await loadSlate(s);
      if (c) cache.push(c);
    } catch (e: any) {
      console.log(`  skip ${s.slate}: ${e.message || String(e)}`);
    }
  }
  console.log(`\nLoaded ${cache.length} slates with precomp.\n`);

  interface Row { combo: string; slate: string; pay: number; t1: number }
  const rows: Row[] = [];

  for (const combo of combos) {
    for (const sd of cache) {
      const portfolio = runHybrid(sd, combo.cfg);
      const s = scorePortfolio(portfolio, sd.actuals, sd.actualByHash, sd.sorted, sd.payoutTable, sd.top1Thresh);
      rows.push({ combo: combo.id, slate: sd.slate, pay: s.pay, t1: s.t1 });
    }
  }

  fs.writeFileSync(OUT_JSON, JSON.stringify(rows, null, 2));

  // Aggregate
  interface Summary { combo: string; full: number; fullT1: number; recent: number; recentT1: number; slates: number; recentSlates: number; profitable: number; minLoo: number; deltaVsShipped: number }
  const BASELINE = '$33,231'; // shipped for reference

  const summaries: Summary[] = [];
  for (const combo of combos) {
    const r = rows.filter(x => x.combo === combo.id);
    let full = 0, fullT1 = 0, recent = 0, recentT1 = 0, recentSlates = 0, profitable = 0;
    const pays = r.map(x => x.pay);
    for (const x of r) {
      full += x.pay; fullT1 += x.t1;
      if (x.pay > FEE * N) profitable++;
      if (RECENT.has(x.slate)) { recent += x.pay; recentT1 += x.t1; recentSlates++; }
    }
    // LOO
    const total = pays.reduce((a, b) => a + b, 0);
    const loos = pays.map((_, i) => { let s = 0, cnt = 0; for (let j = 0; j < pays.length; j++) if (j !== i) { s += pays[j]; cnt++; } return cnt > 0 ? s / cnt : 0; });
    const minLoo = loos.length ? Math.min(...loos) : 0;
    summaries.push({
      combo: combo.id, full, fullT1, recent, recentT1,
      slates: r.length, recentSlates, profitable, minLoo,
      deltaVsShipped: full - 33231,
    });
  }

  summaries.sort((a, b) => b.full - a.full);

  console.log('\n================ TOP 15 BY FULL-SAMPLE ================\n');
  console.log('Rank | Combo                                      | Full     | Recent   | min-LOO | Profit | Δ vs shipped');
  console.log('-'.repeat(110));
  for (let i = 0; i < Math.min(15, summaries.length); i++) {
    const s = summaries[i];
    console.log(`  ${(i + 1).toString().padStart(2)} | ${s.combo.padEnd(42)} | $${s.full.toFixed(0).padStart(6)} | $${s.recent.toFixed(0).padStart(6)} | $${s.minLoo.toFixed(0).padStart(5)} | ${s.profitable}/${s.slates} | ${s.deltaVsShipped >= 0 ? '+' : ''}$${s.deltaVsShipped.toFixed(0)}`);
  }

  console.log('\n================ TOP 10 BY RECENT ================\n');
  const recentSorted = [...summaries].sort((a, b) => b.recent - a.recent);
  for (let i = 0; i < Math.min(10, recentSorted.length); i++) {
    const s = recentSorted[i];
    console.log(`  ${(i + 1).toString().padStart(2)} | ${s.combo.padEnd(42)} | recent $${s.recent.toFixed(0).padStart(6)} full $${s.full.toFixed(0).padStart(6)}`);
  }

  console.log('\n================ TOP 10 BY min-LOO (most robust) ================\n');
  const looSorted = [...summaries].sort((a, b) => b.minLoo - a.minLoo);
  for (let i = 0; i < Math.min(10, looSorted.length); i++) {
    const s = looSorted[i];
    console.log(`  ${(i + 1).toString().padStart(2)} | ${s.combo.padEnd(42)} | min-LOO $${s.minLoo.toFixed(0).padStart(4)} full $${s.full.toFixed(0).padStart(6)} recent $${s.recent.toFixed(0).padStart(6)}`);
  }

  // Write markdown
  let md = `# MLB Hybrid Sweep Results\n\n`;
  md += `Unified score: \`α·proj_z + β·combo_z + γ·top01Cov_z + δ·pariEV_z\`\n\n`;
  md += `Production framework (bins 10/30/35/20/5, γ=7 overlap, 10% team cap, default ownership bins). ${combos.length} configs × ${cache.length} slates.\n\n`;
  md += `## Top 20 by full-sample payout\n\n`;
  md += `| Rank | Combo | Full | Recent | min-LOO | Profitable | Δ vs shipped |\n|---:|---|---:|---:|---:|---:|---:|\n`;
  for (let i = 0; i < Math.min(20, summaries.length); i++) {
    const s = summaries[i];
    md += `| ${i + 1} | \`${s.combo}\` | $${s.full.toFixed(0)} | $${s.recent.toFixed(0)} | $${s.minLoo.toFixed(0)} | ${s.profitable}/${s.slates} | ${s.deltaVsShipped >= 0 ? '+' : ''}$${s.deltaVsShipped.toFixed(0)} |\n`;
  }
  md += `\n## Top 10 by recent 5 slates\n\n`;
  md += `| Rank | Combo | Recent | Full |\n|---:|---|---:|---:|\n`;
  for (let i = 0; i < Math.min(10, recentSorted.length); i++) {
    const s = recentSorted[i];
    md += `| ${i + 1} | \`${s.combo}\` | $${s.recent.toFixed(0)} | $${s.full.toFixed(0)} |\n`;
  }
  md += `\n## Top 10 by min-LOO (robustness)\n\n`;
  md += `| Rank | Combo | min-LOO | Full | Recent |\n|---:|---|---:|---:|---:|\n`;
  for (let i = 0; i < Math.min(10, looSorted.length); i++) {
    const s = looSorted[i];
    md += `| ${i + 1} | \`${s.combo}\` | $${s.minLoo.toFixed(0)} | $${s.full.toFixed(0)} | $${s.recent.toFixed(0)} |\n`;
  }

  fs.writeFileSync(OUT_MD, md);
  console.log(`\nJSON: ${OUT_JSON}`);
  console.log(`MD:   ${OUT_MD}`);
}

main().catch(e => { console.error(e); process.exit(1); });
