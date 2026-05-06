/**
 * Diversity Mechanism Sweep — compare alternative diversity architectures.
 *
 * Holds all other params fixed (λ=0.05, γ=7, team cap 10%, projection-based scoring).
 * Varies only the diversity mechanism that drives lineup selection.
 *
 * Configs:
 *   1. BASELINE    — 5 ownership bins with hard allocation (current shipped)
 *   2. PURE        — pure projection greedy, team cap + exposure only (no γ, no bins)
 *   3. SOFT_OWN_μ  — soft ownership penalty in global sort; μ ∈ {0.5, 1.0, 2.0, 5.0}
 *   4. E_MAX       — sequential Liu-Teo E[max] via V35 t-copula
 *   5. GEN_LAYER   — SKIPPED (requires ILP multi-objective pool generation)
 *   6. PAIRWISE    — γ=7 + team cap only, no bins, no ownership targeting
 *   7. HYBRID      — production bins + within-bin soft ownership penalty (μ=1.0)
 *
 * Output: markdown report.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals } from '../parser';
import { getContestConfig } from '../rules';
import { productionSelect } from '../selection/production-selector';
import { precomputeComboFrequencies, comboBonus } from '../selection/combo-leverage';
import { generateWorlds } from '../v35/simulation';

const DIR = 'C:/Users/colin/dfs opto';
const FEE = 20;
const N = 150;
const LAMBDA = 0.05;
const GAMMA = 7;
const TEAM_CAP = 0.10;
const MAX_EXPOSURE = 0.40;
const SEED = 12345;
const NUM_WORLDS = 1000; // Reduced from 3000 for E[max] perf

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
];

function norm(n: string): string {
  return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function mean(arr: number[]): number { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; }
function stddev(arr: number[]): number {
  if (arr.length <= 1) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
}

// =====================================================================
// Scoring
// =====================================================================
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
    const fa = actualByHash.get(lu.hash);
    let a: number | null = fa !== undefined ? fa : null;
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
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sorted[mid] >= a) lo = mid + 1; else hi = mid;
    }
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

// =====================================================================
// Structural metrics
// =====================================================================
interface PortfolioMetrics {
  meanProj: number;
  meanOwn: number;
  withinLineupOwnStd: number;
  maxPairwiseOverlap: number;
  meanPairwiseOverlap: number;
  uniqueTeams: number;
  maxTeamExposure: number;
  nonFourStackPct: number;
}

function teamCounts(players: Player[]): number[] {
  const c = new Map<string, number>();
  for (const p of players) {
    if (p.positions?.includes('P')) continue;
    c.set(p.team, (c.get(p.team) || 0) + 1);
  }
  return [...c.values()].sort((a, b) => b - a);
}

function computeMetrics(portfolio: Lineup[]): PortfolioMetrics {
  if (portfolio.length === 0) return {
    meanProj: 0, meanOwn: 0, withinLineupOwnStd: 0, maxPairwiseOverlap: 0, meanPairwiseOverlap: 0,
    uniqueTeams: 0, maxTeamExposure: 0, nonFourStackPct: 0,
  };

  const luProj: number[] = [];
  const luOwn: number[] = [];
  const luOwnStds: number[] = [];
  let nonFour = 0;
  const teamCount = new Map<string, number>();
  const pidSets = portfolio.map(lu => new Set(lu.players.map(p => p.id)));

  for (const lu of portfolio) {
    luProj.push(lu.projection);
    const owns = lu.players.map(p => p.ownership || 0);
    luOwn.push(mean(owns));
    luOwnStds.push(stddev(owns));
    const tc = teamCounts(lu.players);
    if ((tc[0] || 0) < 4) nonFour++;
    // Track primary stack team exposure
    const counts = new Map<string, number>();
    for (const p of lu.players) {
      if (p.positions?.includes('P')) continue;
      counts.set(p.team, (counts.get(p.team) || 0) + 1);
    }
    let maxT: string | null = null, maxC = 0;
    for (const [t, c] of counts) if (c > maxC) { maxC = c; maxT = t; }
    if (maxT && maxC >= 4) teamCount.set(maxT, (teamCount.get(maxT) || 0) + 1);
  }

  let maxOvl = 0, sumOvl = 0, pairs = 0;
  for (let i = 0; i < pidSets.length; i++) {
    for (let j = i + 1; j < pidSets.length; j++) {
      let o = 0;
      for (const id of pidSets[i]) if (pidSets[j].has(id)) o++;
      if (o > maxOvl) maxOvl = o;
      sumOvl += o; pairs++;
    }
  }

  return {
    meanProj: mean(luProj),
    meanOwn: mean(luOwn),
    withinLineupOwnStd: mean(luOwnStds),
    maxPairwiseOverlap: maxOvl,
    meanPairwiseOverlap: pairs > 0 ? sumOvl / pairs : 0,
    uniqueTeams: teamCount.size,
    maxTeamExposure: teamCount.size > 0 ? Math.max(...teamCount.values()) / portfolio.length * 100 : 0,
    nonFourStackPct: portfolio.length > 0 ? nonFour / portfolio.length * 100 : 0,
  };
}

// =====================================================================
// Selector helpers (shared by configs 2, 3, 6, 7)
// =====================================================================
function getPrimaryStackTeam(lu: Lineup): string | null {
  const counts = new Map<string, number>();
  for (const p of lu.players) {
    if (p.positions?.includes('P')) continue;
    counts.set(p.team, (counts.get(p.team) || 0) + 1);
  }
  let maxT: string | null = null, maxC = 0;
  for (const [t, c] of counts) if (c > maxC) { maxC = c; maxT = t; }
  return maxC >= 4 ? maxT : null;
}

interface CandidateMeta {
  lu: Lineup;
  comboBonus: number;
  primaryTeam: string | null;
  pidSet: Set<string>;
  own: number;
}

function prepCandidates(candidates: Lineup[], comboFreq: Map<string, number>): CandidateMeta[] {
  return candidates.map(lu => ({
    lu,
    comboBonus: comboBonus(lu, comboFreq),
    primaryTeam: getPrimaryStackTeam(lu),
    pidSet: new Set(lu.players.map(p => p.id)),
    own: lu.players.reduce((s, p) => s + (p.ownership || 0), 0) / lu.players.length,
  }));
}

function makeCanAdd(
  state: { selectedHashes: Set<string>; playerCount: Map<string, number>; teamCount: Map<string, number>; pidSets: Set<string>[] },
  maxOverlap: number,
  useGamma: boolean,
) {
  const expCap = Math.ceil(MAX_EXPOSURE * N);
  const maxPerTeam = Math.max(1, Math.floor(N * TEAM_CAP));
  return (c: CandidateMeta): boolean => {
    if (state.selectedHashes.has(c.lu.hash)) return false;
    for (const p of c.lu.players) {
      if ((state.playerCount.get(p.id) || 0) >= expCap) return false;
    }
    if (c.primaryTeam && (state.teamCount.get(c.primaryTeam) || 0) >= maxPerTeam) return false;
    if (useGamma) {
      for (const sel of state.pidSets) {
        let shared = 0;
        for (const id of c.pidSet) {
          if (sel.has(id)) { shared++; if (shared > maxOverlap) return false; }
        }
      }
    }
    return true;
  };
}

function makeAddLineup(
  state: { selected: Lineup[]; selectedHashes: Set<string>; playerCount: Map<string, number>; teamCount: Map<string, number>; pidSets: Set<string>[] },
) {
  return (c: CandidateMeta): void => {
    state.selected.push(c.lu);
    state.selectedHashes.add(c.lu.hash);
    state.pidSets.push(c.pidSet);
    for (const p of c.lu.players) state.playerCount.set(p.id, (state.playerCount.get(p.id) || 0) + 1);
    if (c.primaryTeam) state.teamCount.set(c.primaryTeam, (state.teamCount.get(c.primaryTeam) || 0) + 1);
  };
}

// =====================================================================
// Config 2: Pure projection (no γ, no bins, team cap + exposure only)
// =====================================================================
function selectPure(candidates: Lineup[], comboFreq: Map<string, number>): Lineup[] {
  const meta = prepCandidates(candidates, comboFreq);
  meta.sort((a, b) => (b.lu.projection + LAMBDA * b.comboBonus) - (a.lu.projection + LAMBDA * a.comboBonus));
  const state = { selected: [] as Lineup[], selectedHashes: new Set<string>(), playerCount: new Map<string, number>(), teamCount: new Map<string, number>(), pidSets: [] as Set<string>[] };
  const canAdd = makeCanAdd(state, 10, false);
  const addLineup = makeAddLineup(state);
  for (const c of meta) {
    if (state.selected.length >= N) break;
    if (!canAdd(c)) continue;
    addLineup(c);
  }
  return state.selected;
}

// =====================================================================
// Config 6: Pairwise only (γ=7 + team cap, no bins)
// =====================================================================
function selectPairwiseOnly(candidates: Lineup[], comboFreq: Map<string, number>): Lineup[] {
  const meta = prepCandidates(candidates, comboFreq);
  meta.sort((a, b) => (b.lu.projection + LAMBDA * b.comboBonus) - (a.lu.projection + LAMBDA * a.comboBonus));
  const state = { selected: [] as Lineup[], selectedHashes: new Set<string>(), playerCount: new Map<string, number>(), teamCount: new Map<string, number>(), pidSets: [] as Set<string>[] };
  const canAdd = makeCanAdd(state, GAMMA, true);
  const addLineup = makeAddLineup(state);
  for (const c of meta) {
    if (state.selected.length >= N) break;
    if (!canAdd(c)) continue;
    addLineup(c);
  }
  return state.selected;
}

// =====================================================================
// Config 3: Soft ownership penalty at μ
// =====================================================================
function selectSoftOwnership(candidates: Lineup[], comboFreq: Map<string, number>, mu: number): Lineup[] {
  const meta = prepCandidates(candidates, comboFreq);
  const state = { selected: [] as Lineup[], selectedHashes: new Set<string>(), playerCount: new Map<string, number>(), teamCount: new Map<string, number>(), pidSets: [] as Set<string>[] };
  const canAdd = makeCanAdd(state, GAMMA, true);
  const addLineup = makeAddLineup(state);
  const selectedOwns: number[] = [];

  while (state.selected.length < N) {
    let bestIdx = -1, bestScore = -Infinity;
    for (let i = 0; i < meta.length; i++) {
      const c = meta[i];
      if (!canAdd(c)) continue;
      // penalty = fraction of selected within ±2pp ownership
      let near = 0;
      for (const ow of selectedOwns) if (Math.abs(ow - c.own) <= 2.0) near++;
      const penalty = selectedOwns.length > 0 ? near / selectedOwns.length : 0;
      const score = c.lu.projection + LAMBDA * c.comboBonus - mu * penalty;
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }
    if (bestIdx < 0) break; // no eligible candidates
    addLineup(meta[bestIdx]);
    selectedOwns.push(meta[bestIdx].own);
  }
  return state.selected;
}

// =====================================================================
// Config 7: Hybrid — production bins + within-bin soft ownership penalty
// =====================================================================
const OWNERSHIP_BINS = [
  { label: 'chalk',  deltaLo: -2,  deltaHi: 99,  fraction: 0.10 },
  { label: 'core',   deltaLo: -5,  deltaHi: -2,  fraction: 0.30 },
  { label: 'value',  deltaLo: -8,  deltaHi: -5,  fraction: 0.35 },
  { label: 'contra', deltaLo: -12, deltaHi: -8,  fraction: 0.20 },
  { label: 'deep',   deltaLo: -20, deltaHi: -12, fraction: 0.05 },
];

function computeAnchorOwn(candidates: Lineup[]): number {
  const sorted = [...candidates].sort((a, b) => b.projection - a.projection);
  const top50 = sorted.slice(0, Math.min(50, sorted.length));
  let sum = 0;
  for (const lu of top50) sum += lu.players.reduce((s, p) => s + (p.ownership || 0), 0) / lu.players.length;
  return sum / top50.length;
}

function selectHybrid(candidates: Lineup[], pool: Player[], comboFreq: Map<string, number>, mu: number): Lineup[] {
  const stackPool = candidates.filter(lu => {
    const tc = teamCounts(lu.players);
    return (tc[0] || 0) >= 4;
  });
  const meta = prepCandidates(stackPool, comboFreq);
  const anchor = computeAnchorOwn(stackPool);
  const binned = new Map<string, CandidateMeta[]>();
  for (const b of OWNERSHIP_BINS) binned.set(b.label, []);
  for (const c of meta) {
    const delta = c.own - anchor;
    for (const b of OWNERSHIP_BINS) {
      if (delta >= b.deltaLo && delta < b.deltaHi) { binned.get(b.label)!.push(c); break; }
    }
  }
  const allocs = new Map<string, number>();
  let tot = 0;
  for (const b of OWNERSHIP_BINS) { const n = Math.round(b.fraction * N); allocs.set(b.label, n); tot += n; }
  if (tot !== N) {
    const largest = OWNERSHIP_BINS.reduce((a, b) => a.fraction > b.fraction ? a : b);
    allocs.set(largest.label, allocs.get(largest.label)! + (N - tot));
  }

  const state = { selected: [] as Lineup[], selectedHashes: new Set<string>(), playerCount: new Map<string, number>(), teamCount: new Map<string, number>(), pidSets: [] as Set<string>[] };
  const canAdd = makeCanAdd(state, GAMMA, true);
  const addLineup = makeAddLineup(state);

  const fillOrder = ['core', 'value', 'chalk', 'contra', 'deep'];
  for (const binLabel of fillOrder) {
    const target = allocs.get(binLabel) || 0;
    const cands = binned.get(binLabel) || [];
    const selectedInBin: number[] = [];
    let filled = 0;
    while (filled < target) {
      let bestIdx = -1, bestScore = -Infinity;
      for (let i = 0; i < cands.length; i++) {
        const c = cands[i];
        if (!canAdd(c)) continue;
        if (state.selectedHashes.has(c.lu.hash)) continue;
        let near = 0;
        for (const ow of selectedInBin) if (Math.abs(ow - c.own) <= 2.0) near++;
        const penalty = selectedInBin.length > 0 ? near / selectedInBin.length : 0;
        const score = c.lu.projection + LAMBDA * c.comboBonus - mu * penalty;
        if (score > bestScore) { bestScore = score; bestIdx = i; }
      }
      if (bestIdx < 0) break;
      addLineup(cands[bestIdx]);
      selectedInBin.push(cands[bestIdx].own);
      filled++;
    }
  }
  // Fallback remainder fill (any bin, by projection)
  if (state.selected.length < N) {
    const remSorted = [...meta].sort((a, b) => (b.lu.projection + LAMBDA * b.comboBonus) - (a.lu.projection + LAMBDA * a.comboBonus));
    for (const c of remSorted) {
      if (state.selected.length >= N) break;
      if (!canAdd(c)) continue;
      addLineup(c);
    }
  }
  return state.selected;
}

// =====================================================================
// Config 4: Sequential E[max] via V35 t-copula
// =====================================================================
function selectSequentialEmax(candidates: Lineup[], players: Player[], comboFreq: Map<string, number>): Lineup[] {
  const stackPool = candidates.filter(lu => {
    const tc = teamCounts(lu.players);
    return (tc[0] || 0) >= 4;
  });
  const meta = prepCandidates(stackPool, comboFreq);

  // Generate scenarios once
  const sim = generateWorlds(players, NUM_WORLDS, 5, SEED);
  const playerIdx = new Map<string, number>();
  for (let i = 0; i < players.length; i++) playerIdx.set(players[i].id, i);

  // Precompute lineup scores: Float64Array[lineupIdx][world]
  const lineupScores: Float64Array[] = meta.map(c => {
    const indices: number[] = [];
    for (const p of c.lu.players) {
      const idx = playerIdx.get(p.id);
      if (idx !== undefined) indices.push(idx);
    }
    const arr = new Float64Array(NUM_WORLDS);
    for (let w = 0; w < NUM_WORLDS; w++) {
      let s = 0;
      for (const pi of indices) s += sim.scores[pi * NUM_WORLDS + w];
      arr[w] = s;
    }
    return arr;
  });

  const state = { selected: [] as Lineup[], selectedHashes: new Set<string>(), playerCount: new Map<string, number>(), teamCount: new Map<string, number>(), pidSets: [] as Set<string>[] };
  const canAdd = makeCanAdd(state, GAMMA, true);
  const addLineup = makeAddLineup(state);

  const currentMax = new Float64Array(NUM_WORLDS);
  for (let w = 0; w < NUM_WORLDS; w++) currentMax[w] = -Infinity;

  while (state.selected.length < N) {
    let bestIdx = -1, bestDelta = -Infinity;
    for (let i = 0; i < meta.length; i++) {
      if (!canAdd(meta[i])) continue;
      const scores = lineupScores[i];
      let delta = 0;
      for (let w = 0; w < NUM_WORLDS; w++) {
        if (scores[w] > currentMax[w]) delta += scores[w] - currentMax[w];
      }
      if (delta > bestDelta) { bestDelta = delta; bestIdx = i; }
    }
    if (bestIdx < 0) break;
    addLineup(meta[bestIdx]);
    const scores = lineupScores[bestIdx];
    for (let w = 0; w < NUM_WORLDS; w++) if (scores[w] > currentMax[w]) currentMax[w] = scores[w];
  }
  return state.selected;
}

// =====================================================================
// Nerdy target metrics
// =====================================================================
const NERDY_TARGETS: PortfolioMetrics = {
  meanProj: 101.26,
  meanOwn: 13.08,
  withinLineupOwnStd: 10.66,
  maxPairwiseOverlap: 7.38,
  meanPairwiseOverlap: 1.52,
  uniqueTeams: 18, // approx
  maxTeamExposure: 14.58,
  nonFourStackPct: 21.5,
};

// Normalized Euclidean distance to nerdy (each dimension scaled by rough range)
function structuralDistance(m: PortfolioMetrics): number {
  const scales = { meanProj: 5, meanOwn: 5, withinLineupOwnStd: 2, maxPairwiseOverlap: 2, meanPairwiseOverlap: 0.5, uniqueTeams: 5, maxTeamExposure: 5, nonFourStackPct: 10 };
  const dp = ((m.meanProj - NERDY_TARGETS.meanProj) / scales.meanProj) ** 2;
  const dow = ((m.meanOwn - NERDY_TARGETS.meanOwn) / scales.meanOwn) ** 2;
  const dstd = ((m.withinLineupOwnStd - NERDY_TARGETS.withinLineupOwnStd) / scales.withinLineupOwnStd) ** 2;
  const dmax = ((m.maxPairwiseOverlap - NERDY_TARGETS.maxPairwiseOverlap) / scales.maxPairwiseOverlap) ** 2;
  const dmean = ((m.meanPairwiseOverlap - NERDY_TARGETS.meanPairwiseOverlap) / scales.meanPairwiseOverlap) ** 2;
  const dut = ((m.uniqueTeams - NERDY_TARGETS.uniqueTeams) / scales.uniqueTeams) ** 2;
  const dte = ((m.maxTeamExposure - NERDY_TARGETS.maxTeamExposure) / scales.maxTeamExposure) ** 2;
  const dnf = ((m.nonFourStackPct - NERDY_TARGETS.nonFourStackPct) / scales.nonFourStackPct) ** 2;
  return Math.sqrt(dp + dow + dstd + dmax + dmean + dut + dte + dnf);
}

// =====================================================================
// Main
// =====================================================================
interface ConfigResult {
  label: string;
  perSlate: Array<{ slate: string; pay: number; t1: number; size: number }>;
  totalPay: number;
  totalT1: number;
  avgMetrics: PortfolioMetrics;
  distanceToNerdy: number;
}

async function main() {
  const configs = [
    { label: 'C1 baseline (5-bin)', kind: 'baseline' as const },
    { label: 'C2 pure projection', kind: 'pure' as const },
    { label: 'C3 soft-own μ=0.5', kind: 'soft' as const, mu: 0.5 },
    { label: 'C3 soft-own μ=1.0', kind: 'soft' as const, mu: 1.0 },
    { label: 'C3 soft-own μ=2.0', kind: 'soft' as const, mu: 2.0 },
    { label: 'C3 soft-own μ=5.0', kind: 'soft' as const, mu: 5.0 },
    { label: 'C4 sequential E[max]', kind: 'emax' as const },
    { label: 'C6 pairwise only', kind: 'pairwise' as const },
    { label: 'C7 hybrid bins+soft μ=1', kind: 'hybrid' as const, mu: 1.0 },
  ];

  const results: ConfigResult[] = configs.map(c => ({
    label: c.label,
    perSlate: [],
    totalPay: 0,
    totalT1: 0,
    avgMetrics: { meanProj: 0, meanOwn: 0, withinLineupOwnStd: 0, maxPairwiseOverlap: 0, meanPairwiseOverlap: 0, uniqueTeams: 0, maxTeamExposure: 0, nonFourStackPct: 0 },
    distanceToNerdy: 0,
  }));

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
      for (const nm of e.playerNames) {
        const p = nameMap.get(norm(nm));
        if (!p) { ok = false; break; }
        pls.push(p);
      }
      if (!ok) continue;
      actualByHash.set(pls.map(p => p.id).sort().join('|'), e.actualPoints);
    }
    const comboFreq = precomputeComboFrequencies(loaded.lineups, 3);
    const payoutTable = buildPayoutTable(F);

    console.log(`\n=== ${s.slate} ===`);

    for (let ci = 0; ci < configs.length; ci++) {
      const c = configs[ci];
      const t0 = Date.now();
      let portfolio: Lineup[] = [];
      try {
        if (c.kind === 'baseline') {
          portfolio = productionSelect(loaded.lineups, pool.players, {
            N, lambda: LAMBDA, comboFreq, maxOverlap: GAMMA,
          }).portfolio;
        } else if (c.kind === 'pure') {
          portfolio = selectPure(loaded.lineups, comboFreq);
        } else if (c.kind === 'pairwise') {
          portfolio = selectPairwiseOnly(loaded.lineups, comboFreq);
        } else if (c.kind === 'soft') {
          portfolio = selectSoftOwnership(loaded.lineups, comboFreq, c.mu!);
        } else if (c.kind === 'hybrid') {
          portfolio = selectHybrid(loaded.lineups, pool.players, comboFreq, c.mu!);
        } else if (c.kind === 'emax') {
          portfolio = selectSequentialEmax(loaded.lineups, pool.players, comboFreq);
        }
      } catch (err) {
        console.log(`  ${c.label}: ERROR ${(err as Error).message}`);
        continue;
      }
      const scored = scorePortfolio(portfolio, actuals, actualByHash, payoutTable);
      const metrics = computeMetrics(portfolio);
      results[ci].perSlate.push({ slate: s.slate, pay: scored.totalPayout, t1: scored.t1, size: portfolio.length });
      results[ci].totalPay += scored.totalPayout;
      results[ci].totalT1 += scored.t1;
      // Accumulate metrics for averaging at end
      const acc = results[ci].avgMetrics;
      acc.meanProj += metrics.meanProj;
      acc.meanOwn += metrics.meanOwn;
      acc.withinLineupOwnStd += metrics.withinLineupOwnStd;
      acc.maxPairwiseOverlap += metrics.maxPairwiseOverlap;
      acc.meanPairwiseOverlap += metrics.meanPairwiseOverlap;
      acc.uniqueTeams += metrics.uniqueTeams;
      acc.maxTeamExposure += metrics.maxTeamExposure;
      acc.nonFourStackPct += metrics.nonFourStackPct;

      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  ${c.label.padEnd(26)} size=${portfolio.length.toString().padStart(3)} t1=${scored.t1.toString().padStart(2)} pay=$${scored.totalPayout.toFixed(0).padStart(6)} (${dt}s)`);
    }
  }

  // Finalize averages
  for (const r of results) {
    const n = r.perSlate.length;
    if (n === 0) continue;
    r.avgMetrics.meanProj /= n;
    r.avgMetrics.meanOwn /= n;
    r.avgMetrics.withinLineupOwnStd /= n;
    r.avgMetrics.maxPairwiseOverlap /= n;
    r.avgMetrics.meanPairwiseOverlap /= n;
    r.avgMetrics.uniqueTeams /= n;
    r.avgMetrics.maxTeamExposure /= n;
    r.avgMetrics.nonFourStackPct /= n;
    r.distanceToNerdy = structuralDistance(r.avgMetrics);
  }

  // Write report
  const out: string[] = [];
  out.push('# Diversity Mechanism Sweep — 9 Slates\n');
  out.push(`Generated ${new Date().toISOString()}\n`);
  out.push(`Fixed: λ=${LAMBDA}, γ=${GAMMA}, team cap ${TEAM_CAP * 100}%, max exposure ${MAX_EXPOSURE * 100}%, N=${N}, seed=${SEED}\n`);
  out.push(`Fees per config: $${FEE * N * SLATES.length} ($${FEE} × ${N} × ${SLATES.length} slates)\n`);

  const baseline = results[0];
  out.push(`## Executive Summary\n`);
  const topByPay = [...results].sort((a, b) => b.totalPay - a.totalPay);
  const topByDist = [...results].sort((a, b) => a.distanceToNerdy - b.distanceToNerdy);
  out.push(`- **Highest payout:** ${topByPay[0].label} — $${topByPay[0].totalPay.toFixed(0)}, ROI ${((topByPay[0].totalPay / (FEE * N * SLATES.length) - 1) * 100).toFixed(1)}%`);
  out.push(`- **Closest to nerdytenor structurally:** ${topByDist[0].label} (distance=${topByDist[0].distanceToNerdy.toFixed(2)})`);
  out.push(`- **Baseline (C1):** $${baseline.totalPay.toFixed(0)}, ROI ${((baseline.totalPay / (FEE * N * SLATES.length) - 1) * 100).toFixed(1)}%, distance=${baseline.distanceToNerdy.toFixed(2)}\n`);

  // Results table
  out.push(`## Results Table\n`);
  out.push('| Config | Total Pay | t1 | ROI | Δ vs C1 | meanProj | meanOwn | ownStd | maxOvl | meanOvl | uniqTeams | maxTeam% | non4% | dist→nerdy |');
  out.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of results) {
    const fees = FEE * N * SLATES.length;
    const roi = (r.totalPay / fees - 1) * 100;
    const delta = r.totalPay - baseline.totalPay;
    const m = r.avgMetrics;
    out.push(`| ${r.label} | $${r.totalPay.toFixed(0)} | ${r.totalT1} | ${roi.toFixed(1)}% | ${delta >= 0 ? '+' : ''}$${delta.toFixed(0)} | ${m.meanProj.toFixed(1)} | ${m.meanOwn.toFixed(1)}% | ${m.withinLineupOwnStd.toFixed(2)} | ${m.maxPairwiseOverlap.toFixed(1)} | ${m.meanPairwiseOverlap.toFixed(2)} | ${m.uniqueTeams.toFixed(1)} | ${m.maxTeamExposure.toFixed(1)}% | ${m.nonFourStackPct.toFixed(1)}% | ${r.distanceToNerdy.toFixed(2)} |`);
  }
  out.push(`| *NERDY target* | — | — | — | — | ${NERDY_TARGETS.meanProj.toFixed(1)} | ${NERDY_TARGETS.meanOwn.toFixed(1)}% | ${NERDY_TARGETS.withinLineupOwnStd.toFixed(2)} | ${NERDY_TARGETS.maxPairwiseOverlap.toFixed(1)} | ${NERDY_TARGETS.meanPairwiseOverlap.toFixed(2)} | ${NERDY_TARGETS.uniqueTeams.toFixed(1)} | ${NERDY_TARGETS.maxTeamExposure.toFixed(1)}% | ${NERDY_TARGETS.nonFourStackPct.toFixed(1)}% | — |`);
  out.push('');

  // Per-slate for top 3 by payout
  out.push(`## Per-Slate Breakdowns for Top 3 by Payout\n`);
  for (let i = 0; i < 3 && i < topByPay.length; i++) {
    const r = topByPay[i];
    out.push(`### ${i + 1}. ${r.label}: $${r.totalPay.toFixed(0)} total\n`);
    out.push('| Slate | size | t1 | pay |');
    out.push('|---|---:|---:|---:|');
    for (const ps of r.perSlate) {
      out.push(`| ${ps.slate} | ${ps.size} | ${ps.t1} | $${ps.pay.toFixed(0)} |`);
    }
    out.push('');
  }

  // Structural comparison
  out.push(`## Structural Distance to nerdytenor\n`);
  out.push('Lower distance = closer structural profile. Scales per dimension roughly equal.\n');
  out.push('| Config | Distance |');
  out.push('|---|---:|');
  for (const r of topByDist) {
    out.push(`| ${r.label} | ${r.distanceToNerdy.toFixed(2)} |`);
  }
  out.push('');

  // Recommendation
  out.push(`## Recommendation\n`);
  const c1 = baseline;
  const bestPayGap = topByPay[0].totalPay - c1.totalPay;
  const bestDistGap = c1.distanceToNerdy - topByDist[0].distanceToNerdy;
  out.push(`Baseline (C1) payout: $${c1.totalPay.toFixed(0)}. Best alternative (${topByPay[0].label}) payout: $${topByPay[0].totalPay.toFixed(0)}, delta ${bestPayGap >= 0 ? '+' : ''}$${bestPayGap.toFixed(0)}.\n`);
  out.push(`Structurally closest to nerdytenor: ${topByDist[0].label} (distance ${topByDist[0].distanceToNerdy.toFixed(2)} vs C1's ${c1.distanceToNerdy.toFixed(2)}).\n`);
  if (bestPayGap > 1000 && topByPay[0].label !== c1.label) {
    out.push(`**${topByPay[0].label} warrants further investigation** — its payout exceeds C1 by $${bestPayGap.toFixed(0)}. Recommend running LOO and checking for slate concentration before any deployment decision.\n`);
  } else {
    out.push(`No alternative meaningfully outperforms C1 on payout. Baseline bin-based diversity mechanism is defensible as shipped.\n`);
  }

  out.push(`## Implementation Notes\n`);
  out.push(`- Config 5 (generation-layer ILP) SKIPPED: no ILP multi-objective pool generation infrastructure in repo.`);
  out.push(`- Config 4 (E[max]) used ${NUM_WORLDS} simulation worlds instead of 3000 for tractability on 5000-lineup pools × 150 selections.`);
  out.push(`- All configs share identical RNG seed, payout table, scoring, and actuals. Comparison is apples-to-apples.`);
  out.push(`- Structural distance uses normalized Euclidean across 8 dimensions with equal weight; scales chosen to roughly balance contribution magnitude.`);

  const reportPath = path.join(DIR, 'diversity_sweep_report.md');
  fs.writeFileSync(reportPath, out.join('\n'));
  console.log(`\nReport written: ${reportPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
