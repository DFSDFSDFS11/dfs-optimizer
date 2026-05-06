/**
 * Block 2 — Phased forward selection on ceiling + ownership within-bin scoring.
 *
 * Base: production shipped (λ=0.05, γ=7, 5-bin allocation, projection sort).
 * Modify: within-bin score formula to
 *   score = projection + ν*(ceiling - projection) - μ_abs*own - μ_rel*max(0, own - binTargetOwn)
 *           - μ_prop*max(0, own - ceiling/k) + λ*combo
 *
 * Phase 1 (ν only): sweep ν ∈ {0, 0.3, 0.5, 0.7, 1.0, 1.5}, all μ = 0.
 * Phase 2 (+ μ_abs): hold best ν, sweep μ_abs.
 * Phase 3 (+ μ_rel): hold best (ν, μ_abs), sweep μ_rel.
 * Phase 4 (+ μ_prop, k): hold best prior, sweep grid.
 *
 * Stop at any phase with no >$500 improvement. Baseline guard: ν=0 all-μ=0
 * reproduces $31,886 (10-slate).
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

/**
 * Custom selector: production's bin system + within-bin extended scoring.
 * score(lu) = proj + nu*(ceiling - proj) - muAbs*own - muRel*max(0, own - binTargetOwn)
 *             - muProp*max(0, own - ceiling/k) + lambda*combo
 */
interface ExtConfig {
  nu: number;
  muAbs: number;
  muRel: number;
  muProp: number;
  k: number;
}

function runExtendedSelect(
  candidates: Lineup[],
  poolPlayers: Player[],
  comboFreq: Map<string, number>,
  ceilingByHash: Map<string, number>,
  cfg: ExtConfig,
): Lineup[] {
  // Stack filter (match production default)
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
    const ceiling = ceilingByHash.get(hash) ?? lu.projection; // fallback to proj if no ceiling
    const cb = comboBonus(lu, comboFreq);
    const pidSet = new Set(lu.players.map(p => p.id));
    const counts = new Map<string, number>();
    for (const p of lu.players) if (!p.positions?.includes('P')) counts.set(p.team, (counts.get(p.team) || 0) + 1);
    let pt: string | null = null, mx = 0;
    for (const [t, c] of counts) if (c > mx) { mx = c; pt = t; }
    const primaryTeam = mx >= 4 ? pt : null;
    return { lu, own, proj: lu.projection, ceiling, cb, pidSet, primaryTeam };
  });

  // Bin assignment
  const binned = new Map<string, typeof meta>();
  for (const b of OWNERSHIP_BINS) binned.set(b.label, []);
  for (const e of meta) {
    const delta = e.own - anchor.ownership;
    for (const b of OWNERSHIP_BINS) {
      if (delta >= b.deltaLo && delta < b.deltaHi) { binned.get(b.label)!.push(e); break; }
    }
  }

  // Compute per-bin target ownership (mean of lineups in that bin)
  const binTargetOwn = new Map<string, number>();
  for (const [label, entries] of binned) {
    if (entries.length > 0) {
      binTargetOwn.set(label, entries.reduce((s, e) => s + e.own, 0) / entries.length);
    }
  }

  // Within-bin extended scoring
  for (const [label, entries] of binned) {
    const bt = binTargetOwn.get(label) ?? anchor.ownership;
    entries.sort((a, b) => {
      const scoreA = a.proj + cfg.nu * (a.ceiling - a.proj) - cfg.muAbs * a.own
        - cfg.muRel * Math.max(0, a.own - bt)
        - cfg.muProp * Math.max(0, a.own - a.ceiling / cfg.k)
        + LAMBDA * a.cb;
      const scoreB = b.proj + cfg.nu * (b.ceiling - b.proj) - cfg.muAbs * b.own
        - cfg.muRel * Math.max(0, b.own - bt)
        - cfg.muProp * Math.max(0, b.own - b.ceiling / cfg.k)
        + LAMBDA * b.cb;
      return scoreB - scoreA;
    });
  }

  // Bin allocation (production default 10/30/35/20/5)
  const allocations = new Map<string, number>();
  let totalAlloc = 0;
  for (const b of OWNERSHIP_BINS) { const c = Math.round(b.fraction * N); allocations.set(b.label, c); totalAlloc += c; }
  if (totalAlloc !== N) {
    const largest = OWNERSHIP_BINS.reduce((a, b) => a.fraction > b.fraction ? a : b);
    allocations.set(largest.label, allocations.get(largest.label)! + (N - totalAlloc));
  }

  // Greedy selection with γ=7 + team cap
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

  const fillOrder = ['core', 'value', 'chalk', 'contra', 'deep'];
  for (const label of fillOrder) {
    const target = allocations.get(label) || 0;
    const cands = binned.get(label) || [];
    let filled = 0;
    for (const c of cands) {
      if (filled >= target) break;
      if (!canAdd(c)) continue;
      add(c); filled++;
    }
  }
  // Remainder fill
  if (selected.length < N) {
    const all = [...meta].sort((a, b) => {
      const sa = a.proj + cfg.nu * (a.ceiling - a.proj) + LAMBDA * a.cb;
      const sb = b.proj + cfg.nu * (b.ceiling - b.proj) + LAMBDA * b.cb;
      return sb - sa;
    });
    for (const c of all) {
      if (selected.length >= N) break;
      if (!canAdd(c)) continue;
      add(c);
    }
  }
  return selected;
}

async function main() {
  console.log('================================================================');
  console.log('BLOCK 2 — Phased ceiling + ownership scoring sweep');
  console.log('================================================================\n');

  // Precompute per-slate: ceilings, comboFreq, actuals scorer
  type SlateData = {
    slate: string; actuals: ContestActuals; actualByHash: Map<string, number>;
    candidates: Lineup[]; poolPlayers: Player[]; comboFreq: Map<string, number>;
    ceilingByHash: Map<string, number>; payoutTable: Float64Array;
  };
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

    // Compute ceiling for each pool lineup via simulation
    console.log(`  ${s.slate}: generating sim + ceilings for ${loaded.lineups.length} lineups`);
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
    slateData.push({ slate: s.slate, actuals, actualByHash, candidates: loaded.lineups, poolPlayers: pool.players, comboFreq, ceilingByHash, payoutTable });
  }

  function runConfig(cfg: ExtConfig): { total: number; t1: number; perSlate: Array<{ slate: string; pay: number; t1: number }> } {
    const perSlate: Array<{ slate: string; pay: number; t1: number }> = [];
    let total = 0, t1Sum = 0;
    for (const sd of slateData) {
      const portfolio = runExtendedSelect(sd.candidates, sd.poolPlayers, sd.comboFreq, sd.ceilingByHash, cfg);
      const sc = scorePortfolio(portfolio, sd.actuals, sd.actualByHash, sd.payoutTable);
      perSlate.push({ slate: sd.slate, pay: sc.totalPayout, t1: sc.t1 });
      total += sc.totalPayout; t1Sum += sc.t1;
    }
    return { total, t1: t1Sum, perSlate };
  }

  // ==========================================================
  // PHASE 1: ν sweep (ceiling term only)
  // ==========================================================
  console.log('\n=== PHASE 1: ceiling term only (ν sweep) ===\n');
  const NUS = [0, 0.3, 0.5, 0.7, 1.0, 1.5];
  const phase1Results: Array<{ nu: number; total: number; t1: number }> = [];
  for (const nu of NUS) {
    const r = runConfig({ nu, muAbs: 0, muRel: 0, muProp: 0, k: 10 });
    phase1Results.push({ nu, total: r.total, t1: r.t1 });
    console.log(`  ν=${nu.toFixed(2)}: total=$${r.total.toFixed(0)} t1=${r.t1} ROI=${((r.total / (FEE * N * SLATES.length) - 1) * 100).toFixed(1)}%`);
  }
  const p1Baseline = phase1Results[0].total;
  console.log(`\n  Baseline guard (ν=0): $${p1Baseline.toFixed(0)} (expected $31,886)`);
  const p1Best = [...phase1Results].sort((a, b) => b.total - a.total)[0];
  console.log(`  Phase 1 winner: ν=${p1Best.nu} at $${p1Best.total.toFixed(0)} (Δ baseline: ${p1Best.total >= p1Baseline ? '+' : ''}$${(p1Best.total - p1Baseline).toFixed(0)})`);

  if (p1Best.total - p1Baseline < 500 || p1Best.nu === 0) {
    console.log('\n  PHASE 1 DOES NOT PASS — ceiling term alone does not improve by $500+. STOPPING.');
    return;
  }

  // ==========================================================
  // PHASE 2: + μ_abs (absolute ownership penalty)
  // ==========================================================
  console.log(`\n=== PHASE 2: hold ν=${p1Best.nu}, sweep μ_abs ===\n`);
  const MUABS = [0, 0.1, 0.3, 0.5, 1.0];
  const phase2Results: Array<{ muAbs: number; total: number; t1: number }> = [];
  for (const muAbs of MUABS) {
    const r = runConfig({ nu: p1Best.nu, muAbs, muRel: 0, muProp: 0, k: 10 });
    phase2Results.push({ muAbs, total: r.total, t1: r.t1 });
    console.log(`  μ_abs=${muAbs.toFixed(2)}: total=$${r.total.toFixed(0)} t1=${r.t1}`);
  }
  const p2Best = [...phase2Results].sort((a, b) => b.total - a.total)[0];
  const p2Improve = p2Best.total - p1Best.total;
  console.log(`\n  Phase 2 winner: μ_abs=${p2Best.muAbs} at $${p2Best.total.toFixed(0)} (Δ phase 1: ${p2Improve >= 0 ? '+' : ''}$${p2Improve.toFixed(0)})`);
  if (p2Improve < 300) {
    console.log('\n  PHASE 2 does not improve by $300+. Stopping forward selection.');
    return;
  }

  // ==========================================================
  // PHASE 3: + μ_rel (relative to bin target)
  // ==========================================================
  console.log(`\n=== PHASE 3: hold ν=${p1Best.nu}, μ_abs=${p2Best.muAbs}, sweep μ_rel ===\n`);
  const MUREL = [0, 0.2, 0.5, 1.0];
  const phase3Results: Array<{ muRel: number; total: number; t1: number }> = [];
  for (const muRel of MUREL) {
    const r = runConfig({ nu: p1Best.nu, muAbs: p2Best.muAbs, muRel, muProp: 0, k: 10 });
    phase3Results.push({ muRel, total: r.total, t1: r.t1 });
    console.log(`  μ_rel=${muRel.toFixed(2)}: total=$${r.total.toFixed(0)} t1=${r.t1}`);
  }
  const p3Best = [...phase3Results].sort((a, b) => b.total - a.total)[0];
  const p3Improve = p3Best.total - p2Best.total;
  console.log(`\n  Phase 3 winner: μ_rel=${p3Best.muRel} at $${p3Best.total.toFixed(0)} (Δ phase 2: ${p3Improve >= 0 ? '+' : ''}$${p3Improve.toFixed(0)})`);
  if (p3Improve < 300) {
    console.log('\n  PHASE 3 does not improve. Stopping.');
    return;
  }

  // ==========================================================
  // PHASE 4: + μ_prop × k grid
  // ==========================================================
  console.log(`\n=== PHASE 4: hold prior, sweep μ_prop × k ===\n`);
  const MUPROP = [0, 0.2, 0.5, 1.0];
  const KS = [8, 10, 12, 15];
  const phase4Results: Array<{ muProp: number; k: number; total: number }> = [];
  for (const muProp of MUPROP) {
    for (const k of KS) {
      const r = runConfig({ nu: p1Best.nu, muAbs: p2Best.muAbs, muRel: p3Best.muRel, muProp, k });
      phase4Results.push({ muProp, k, total: r.total });
      console.log(`  μ_prop=${muProp} k=${k}: $${r.total.toFixed(0)}`);
    }
  }
  const p4Best = [...phase4Results].sort((a, b) => b.total - a.total)[0];
  console.log(`\n  Phase 4 winner: μ_prop=${p4Best.muProp} k=${p4Best.k} at $${p4Best.total.toFixed(0)}`);

  console.log(`\n\n================================================================`);
  console.log(`FINAL WINNER: ν=${p1Best.nu} μ_abs=${p2Best.muAbs} μ_rel=${p3Best.muRel} μ_prop=${p4Best.muProp} k=${p4Best.k}`);
  console.log(`Total: $${p4Best.total.toFixed(0)} vs baseline $${p1Baseline.toFixed(0)} (Δ ${(p4Best.total - p1Baseline >= 0 ? '+' : '')}$${(p4Best.total - p1Baseline).toFixed(0)})`);
}

// Post-run analysis: per-slate breakdown + LOO
async function loo() {
  // No-op placeholder for future
}

main().catch(e => { console.error(e); process.exit(1); });
