/**
 * Block 3 — Architecture sweeps: bin caps, chalk-avoidance, multi-criteria no-bins.
 *
 * Phase 3A: Per-bin team cap sweep (uses existing selector, no sim needed)
 * Phase 3B: Chalk-avoidance two-stage anchor
 * Phase 3C: Multi-criteria no-bins (reuses Block 2 ceiling precompute; expensive)
 *
 * Each phase runs, reports full-sample winner + LOO. Skip 3C if 3A or 3B win clean.
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
function mean(arr: number[] | Float64Array): number { if (!arr.length) return 0; let s = 0; for (let i = 0; i < arr.length; i++) s += arr[i]; return s / arr.length; }

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

interface SlateData {
  slate: string; actuals: ContestActuals; actualByHash: Map<string, number>;
  candidates: Lineup[]; poolPlayers: Player[]; comboFreq: Map<string, number>;
  ceilingByHash: Map<string, number>; payoutTable: Float64Array;
}

async function loadAllSlates(): Promise<SlateData[]> {
  const out: SlateData[] = [];
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
    out.push({ slate: s.slate, actuals, actualByHash, candidates: loaded.lineups, poolPlayers: pool.players, comboFreq, ceilingByHash, payoutTable });
  }
  return out;
}

// ================================================================
// PHASE 3A: Per-bin team cap sweep (uses productionSelect with additional per-bin logic)
// Since productionSelect uses single team cap, approximate by running with different overall caps
// and checking structural results. For simplicity, focus on chalk-light (reduce chalk allocation).
// ================================================================
const OWNERSHIP_BINS_BASE = [
  { label: 'chalk',  deltaLo: -2,  deltaHi: 99,  fraction: 0.10 },
  { label: 'core',   deltaLo: -5,  deltaHi: -2,  fraction: 0.30 },
  { label: 'value',  deltaLo: -8,  deltaHi: -5,  fraction: 0.35 },
  { label: 'contra', deltaLo: -12, deltaHi: -8,  fraction: 0.20 },
  { label: 'deep',   deltaLo: -20, deltaHi: -12, fraction: 0.05 },
];

interface BinConfig { chalk: number; core: number; value: number; contra: number; deep: number; }
interface SelectCfg { bins?: BinConfig; chalkAvoidPct?: number; noChalk?: boolean; nuCeiling?: number; muAbs?: number; }

function runBinVariant(sd: SlateData, cfg: SelectCfg): Lineup[] {
  const stackPool = sd.candidates.filter(lu => {
    const tc = new Map<string, number>();
    for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
    let max = 0; for (const c of tc.values()) if (c > max) max = c;
    return max >= 4;
  });
  const anchor = computeAnchor(stackPool, 50);
  const maxerCentroid = (() => {
    const byOwn = [...stackPool].sort((a, b) => {
      const oa = a.players.reduce((s, p) => s + (p.ownership || 0), 0) / a.players.length;
      const ob = b.players.reduce((s, p) => s + (p.ownership || 0), 0) / b.players.length;
      return ob - oa;
    }).slice(0, Math.min(50, stackPool.length));
    return mean(byOwn.map(lu => mean(lu.players.map(p => p.ownership || 0))));
  })();

  const meta = stackPool.map(lu => {
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

  // Apply chalk avoidance if set
  let filtered = meta;
  if (cfg.chalkAvoidPct !== undefined) {
    filtered = meta.filter(e => e.own <= maxerCentroid - cfg.chalkAvoidPct!);
  }

  // Determine bin structure
  const bins = cfg.bins ?? { chalk: 0.10, core: 0.30, value: 0.35, contra: 0.20, deep: 0.05 };
  const binDefs = [...OWNERSHIP_BINS_BASE];
  if (cfg.noChalk) {
    binDefs[0].fraction = 0;
    // Redistribute chalk allocation to others proportionally
    const factor = 1 / (1 - 0.10);
    for (let i = 1; i < binDefs.length; i++) binDefs[i].fraction = binDefs[i].fraction * factor;
  } else {
    binDefs[0].fraction = bins.chalk;
    binDefs[1].fraction = bins.core;
    binDefs[2].fraction = bins.value;
    binDefs[3].fraction = bins.contra;
    binDefs[4].fraction = bins.deep;
  }

  const binned = new Map<string, typeof meta>();
  for (const b of binDefs) binned.set(b.label, []);
  for (const e of filtered) {
    const delta = e.own - anchor.ownership;
    for (const b of binDefs) {
      if (delta >= b.deltaLo && delta < b.deltaHi) { binned.get(b.label)!.push(e); break; }
    }
  }

  const nuC = cfg.nuCeiling ?? 0;
  const muA = cfg.muAbs ?? 0;
  for (const [, entries] of binned) {
    entries.sort((a, b) => {
      const sa = a.proj + nuC * (a.ceiling - a.proj) - muA * a.own + LAMBDA * a.cb;
      const sb = b.proj + nuC * (b.ceiling - b.proj) - muA * b.own + LAMBDA * b.cb;
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
    const all = [...filtered].sort((a, b) => {
      const sa = a.proj + nuC * (a.ceiling - a.proj) - muA * a.own + LAMBDA * a.cb;
      const sb = b.proj + nuC * (b.ceiling - b.proj) - muA * b.own + LAMBDA * b.cb;
      return sb - sa;
    });
    for (const c of all) { if (selected.length >= N) break; if (!canAdd(c)) continue; add(c); }
  }
  return selected;
}

function runConfigAllSlates(slateData: SlateData[], cfg: SelectCfg): { total: number; t1: number; perSlate: { slate: string; pay: number; t1: number }[] } {
  const perSlate: { slate: string; pay: number; t1: number }[] = [];
  let total = 0, t1Sum = 0;
  for (const sd of slateData) {
    const portfolio = runBinVariant(sd, cfg);
    const sc = scorePortfolio(portfolio, sd.actuals, sd.actualByHash, sd.payoutTable);
    perSlate.push({ slate: sd.slate, pay: sc.totalPayout, t1: sc.t1 });
    total += sc.totalPayout; t1Sum += sc.t1;
  }
  return { total, t1: t1Sum, perSlate };
}

async function main() {
  console.log('================================================================');
  console.log('BLOCK 3 — Architecture sweeps');
  console.log('================================================================\n');
  console.log('Loading slates + generating sim ceilings...');
  const slateData = await loadAllSlates();
  console.log(`Loaded ${slateData.length} slates.\n`);

  const baseline = runConfigAllSlates(slateData, {});
  console.log(`Baseline (5-bin shipped): $${baseline.total.toFixed(0)} t1=${baseline.t1}\n`);

  // ========================================================================
  // PHASE 3A: Allocation sweep (redistribute chalk slots)
  // ========================================================================
  console.log('=== PHASE 3A: Bin allocation sweep ===\n');
  const allocConfigs: Array<{ label: string; bins: BinConfig }> = [
    { label: 'A1 baseline     10/30/35/20/05', bins: { chalk: 0.10, core: 0.30, value: 0.35, contra: 0.20, deep: 0.05 } },
    { label: 'A2 chalk-light  05/30/38/22/05', bins: { chalk: 0.05, core: 0.30, value: 0.38, contra: 0.22, deep: 0.05 } },
    { label: 'A3 no-chalk     00/30/40/25/05', bins: { chalk: 0.00, core: 0.30, value: 0.40, contra: 0.25, deep: 0.05 } },
    { label: 'A4 value-heavy  05/25/45/20/05', bins: { chalk: 0.05, core: 0.25, value: 0.45, contra: 0.20, deep: 0.05 } },
    { label: 'A5 contra-more  05/25/35/25/10', bins: { chalk: 0.05, core: 0.25, value: 0.35, contra: 0.25, deep: 0.10 } },
    { label: 'A6 deep-more    05/25/35/20/15', bins: { chalk: 0.05, core: 0.25, value: 0.35, contra: 0.20, deep: 0.15 } },
  ];
  for (const ac of allocConfigs) {
    const r = runConfigAllSlates(slateData, { bins: ac.bins });
    console.log(`  ${ac.label}: $${r.total.toFixed(0)} t1=${r.t1} Δ=${(r.total - baseline.total >= 0 ? '+' : '') + (r.total - baseline.total).toFixed(0)}`);
  }

  // ========================================================================
  // PHASE 3B: Chalk-avoidance threshold
  // ========================================================================
  console.log('\n=== PHASE 3B: Chalk-avoidance floor X ===\n');
  for (const X of [0, 2, 3, 4, 5, 6]) {
    const r = runConfigAllSlates(slateData, { chalkAvoidPct: X === 0 ? undefined : X });
    console.log(`  X=${X}pp: $${r.total.toFixed(0)} t1=${r.t1} Δ=${(r.total - baseline.total >= 0 ? '+' : '') + (r.total - baseline.total).toFixed(0)}`);
  }

  // ========================================================================
  // PHASE 3C: Multi-criteria NO-BINS
  // ========================================================================
  console.log('\n=== PHASE 3C: Multi-criteria no-bins selector ===\n');
  const multiCriteriaConfigs: Array<{ label: string; wProj: number; wCeiling: number; wOwn: number }> = [
    { label: 'M1 projection-only', wProj: 1.0, wCeiling: 0, wOwn: 0 },
    { label: 'M2 balanced', wProj: 0.40, wCeiling: 0.25, wOwn: 0.30 },
    { label: 'M3 ceiling-heavy', wProj: 0.30, wCeiling: 0.45, wOwn: 0.25 },
    { label: 'M4 user-suggested', wProj: 0.40, wCeiling: 0.25, wOwn: 0.35 },
    { label: 'M5 ownership-heavy', wProj: 0.35, wCeiling: 0.20, wOwn: 0.45 },
  ];

  function runMultiCriteria(slateData: SlateData[], w: { wProj: number; wCeiling: number; wOwn: number }): { total: number; t1: number } {
    let total = 0, t1Sum = 0;
    for (const sd of slateData) {
      const stackPool = sd.candidates.filter(lu => {
        const tc = new Map<string, number>();
        for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
        let max = 0; for (const c of tc.values()) if (c > max) max = c;
        return max >= 4;
      });
      // Normalize to [0,1]
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
      const nProj = normalize(projs);
      const nCeiling = normalize(ceilings);
      const nOwn = normalize(owns);

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
      const sc = scorePortfolio(selected, sd.actuals, sd.actualByHash, sd.payoutTable);
      total += sc.totalPayout; t1Sum += sc.t1;
    }
    return { total, t1: t1Sum };
  }

  for (const mc of multiCriteriaConfigs) {
    const r = runMultiCriteria(slateData, mc);
    console.log(`  ${mc.label.padEnd(22)}: $${r.total.toFixed(0)} t1=${r.t1} Δ=${(r.total - baseline.total >= 0 ? '+' : '') + (r.total - baseline.total).toFixed(0)}`);
  }

  console.log('\n\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
