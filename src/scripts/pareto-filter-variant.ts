/**
 * Pareto-Filter (V1-PF) variant test.
 *
 * Single-variant controlled test: does constraining V1's candidate pool to
 * Pareto-optimal lineups (on projection_sum vs ownership_sum trade-off) improve
 * V1's tournament outcomes?
 *
 * V1-PF = V1 (current = V1-NoCorr settings) + filter:
 *   - Compute (projection_sum, ownership_sum) for each candidate.
 *   - 2D Pareto frontier: lineup L on frontier iff no L' has proj(L') >= proj(L)
 *     AND own(L') <= own(L) with at least one strict inequality.
 *   - Pool restricted to frontier ONLY before V1's normal scoring runs.
 *   - No fallback if frontier under-fills below N=75.
 *
 * Outputs to C:/Users/colin/dfs opto/pareto_filter_test/
 *
 * Reference: methodology lock at pareto_filter_test/methodology.md (2026-05-03).
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player, ContestConfig } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals } from '../parser';
import { getContestConfig } from '../rules';
import { exportForDraftKings, exportDetailedLineups } from '../scoring';

const MLB_DIR = 'C:/Users/colin/dfs opto';
const OUT_DIR = 'C:/Users/colin/dfs opto/pareto_filter_test';
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
const PORTFOLIO_DIR = path.join(OUT_DIR, 'v1_pf_portfolios');
if (!fs.existsSync(PORTFOLIO_DIR)) fs.mkdirSync(PORTFOLIO_DIR, { recursive: true });

const N = 75;       // V1-PF target lineups (per methodology)
const N_V1 = 150;   // V1 baseline portfolio size from existing dump
const FEE = 20;
const BOOTSTRAP_SAMPLES = 10000;
const BOOTSTRAP_SEED = 42;

const V1_DUMP_PATH = path.join(MLB_DIR, 'theory_dfs_v2', 'v1_pros_lineup_dump.json');

// 16 dev slates per HOLDOUT_LOCK.md. Holdout slates NOT touched.
const DEV_SLATES = [
  { slate: '4-8-26',        proj: '4-8-26projections.csv',        actuals: '4-8-26actuals.csv',        pool: '4-8-26sspool.csv' },
  { slate: '4-12-26',       proj: '4-12-26projections.csv',       actuals: '4-12-26actuals.csv',       pool: '4-12-26sspool.csv' },
  { slate: '4-17-26',       proj: '4-17-26projections.csv',       actuals: '4-17-26actuals.csv',       pool: '4-17-26sspool.csv' },
  { slate: '4-18-26',       proj: '4-18-26projections.csv',       actuals: '4-18-26actuals.csv',       pool: '4-18-26sspool.csv' },
  { slate: '4-21-26',       proj: '4-21-26projections.csv',       actuals: '4-21-26actuals.csv',       pool: '4-21-26sspool.csv' },
  { slate: '4-22-26',       proj: '4-22-26projections.csv',       actuals: '4-22-26actuals.csv',       pool: '4-22-26sspool.csv' },
  { slate: '4-23-26',       proj: '4-23-26projections.csv',       actuals: '4-23-26actuals.csv',       pool: '4-23-26sspool.csv' },
  { slate: '4-24-26',       proj: '4-24-26projections.csv',       actuals: '4-24-26actuals.csv',       pool: '4-24-26sspool.csv' },
  { slate: '4-25-26',       proj: '4-25-26projections.csv',       actuals: '4-25-26actuals.csv',       pool: '4-25-26sspool.csv' },
  { slate: '4-25-26-early', proj: '4-25-26projectionsearly.csv',  actuals: '4-25-26actualsearly.csv',  pool: '4-25-26sspoolearly.csv' },
  { slate: '4-26-26',       proj: '4-26-26projections.csv',       actuals: '4-26-26actuals.csv',       pool: '4-26-26sspool.csv' },
  { slate: '4-27-26',       proj: '4-27-26projections.csv',       actuals: '4-27-26actuals.csv',       pool: '4-27-26sspool.csv' },
  { slate: '4-28-26',       proj: '4-28-26projections.csv',       actuals: '4-28-26actuals.csv',       pool: '4-28-26sspool.csv' },
  { slate: '4-29-26',       proj: '4-29-26projections.csv',       actuals: '4-29-26actuals.csv',       pool: '4-29-26sspool.csv' },
  { slate: '5-2-26-main',   proj: '5-2-26projectionsmain.csv',    actuals: '5-2-26actualsmain.csv',    pool: '5-2-26sspoolmain.csv' },
  { slate: '5-3-26',        proj: '5-3-26projections.csv',        actuals: '5-3-26actuals.csv',        pool: '5-3-26sspool.csv' },
];

// V1 (current production, V1-NoCorr settings) — copied verbatim from theory-of-dfs-v1-preslate.ts.
// All hyperparameters preserved per methodology.
const TODFS_V1 = {
  STACK_BONUS_PER_HITTER: 0,
  BRINGBACK_1: 0,
  BRINGBACK_2: 0,
  PITCHER_VS_HITTER_PENALTY: -0.10,
  MIN_PRIMARY_STACK: 4,
  W_PROJ: 1.0, W_LEV: 0.30, W_VAR: 0.15, W_CMB: 0.25,
  EXPOSURE_CAP_HITTER: 0.25, EXPOSURE_CAP_PITCHER: 0.55,
  TEAM_STACK_CAP: 0.20,
  BAND_HIGH_PCT: 0.20, BAND_MID_PCT: 0.60, BAND_LOW_PCT: 0.20,
  MAX_PAIRWISE_OVERLAP: 6,
  TRIPLE_FREQ_CAP: 5,
  PPD_LINEUP_PENALTY: 0.10, PPD_LINEUP_TOP_PCT: 0.10,
};

// ============================================================
// UTILS
// ============================================================
function isPitcher(p: Player): boolean { return (p.position || '').toUpperCase().includes('P'); }
function mean(a: number[]): number { if (!a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; }
function stddev(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a); let s = 0; for (const v of a) s += (v - m) ** 2; return Math.sqrt(s / a.length);
}
function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function rankPercentile(values: number[]): number[] {
  const idx = values.map((v, i) => ({ v, i }));
  idx.sort((a, b) => a.v - b.v);
  const out = new Array<number>(values.length);
  for (let r = 0; r < values.length; r++) out[idx[r].i] = values.length > 1 ? r / (values.length - 1) : 0;
  return out;
}

// Mulberry32 PRNG, deterministic with explicit seed for bootstrap reproducibility.
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return function() {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================
// PARETO FRONTIER (2D, projection_sum vs ownership_sum)
// ============================================================
/**
 * Standard 2D Pareto frontier sweep.
 *
 * A lineup L is Pareto-optimal iff no other lineup L' has:
 *   proj(L') >= proj(L) AND own(L') <= own(L)
 * with at least one strict inequality.
 *
 * Algorithm:
 *   1. Sort candidates by projection desc, then by ownership asc (ties).
 *   2. Track min_own_seen across iteration.
 *   3. A candidate is on the frontier iff its ownership < min_own_seen at
 *      the moment it is processed (strictly less than any prior candidate
 *      with >= projection).
 *   4. Equal-projection-equal-ownership clones are all retained when both
 *      tie at the minimum (downstream V1 dedupes via lineup hash anyway).
 *
 * Returns indices into the input array that are on the frontier.
 */
function computeParetoFrontier(projSums: Float64Array, ownSums: Float64Array): number[] {
  const N = projSums.length;
  if (N === 0) return [];
  const idx = new Array(N);
  for (let i = 0; i < N; i++) idx[i] = i;
  idx.sort((a, b) => {
    if (projSums[b] !== projSums[a]) return projSums[b] - projSums[a];
    return ownSums[a] - ownSums[b];
  });
  const frontier: number[] = [];
  let minOwn = Number.POSITIVE_INFINITY;
  let i = 0;
  while (i < N) {
    const p = projSums[idx[i]];
    let j = i;
    while (j < N && projSums[idx[j]] === p) j++;
    const groupLowOwn = ownSums[idx[i]];
    if (groupLowOwn < minOwn) {
      for (let k = i; k < j; k++) {
        if (ownSums[idx[k]] === groupLowOwn) frontier.push(idx[k]);
        else break;
      }
      minOwn = groupLowOwn;
    }
    i = j;
  }
  return frontier;
}

/**
 * Layered Pareto peeling. Compute strict frontier, remove from pool, repeat.
 * Stop when accumulated candidates >= targetCount, or layers >= maxLayers,
 * or all candidates exhausted. Returns indices in peeling order (layer 1 first).
 */
function computeParetoLayered(
  projSums: Float64Array,
  ownSums: Float64Array,
  targetCount: number,
  maxLayers: number = 20
): { indices: number[]; layers: number } {
  const N = projSums.length;
  if (N === 0) return { indices: [], layers: 0 };
  const remaining: boolean[] = new Array(N).fill(true);
  const result: number[] = [];
  let layers = 0;
  while (result.length < targetCount && layers < maxLayers) {
    const subProj = new Float64Array(N);
    const subOwn = new Float64Array(N);
    const subToOrig: number[] = [];
    for (let i = 0; i < N; i++) {
      if (remaining[i]) {
        subToOrig.push(i);
        subProj[subToOrig.length - 1] = projSums[i];
        subOwn[subToOrig.length - 1] = ownSums[i];
      }
    }
    if (subToOrig.length === 0) break;
    const subFrontier = computeParetoFrontier(subProj.slice(0, subToOrig.length), subOwn.slice(0, subToOrig.length));
    if (subFrontier.length === 0) break;
    for (const si of subFrontier) {
      const origIdx = subToOrig[si];
      result.push(origIdx);
      remaining[origIdx] = false;
    }
    layers++;
  }
  return { indices: result, layers };
}

// ============================================================
// SLATE LOAD + SCORE LINEUP (mirrors V1 theory-of-dfs-v1-preslate)
// ============================================================
interface ScoredLU {
  lu: Lineup; primarySize: number; primaryTeam: string; corrAdj: number; logOwn: number;
  uniqueness: number; ppd: number;
  proj: number; floor: number; ceiling: number; range: number; ev: number;
  projPct: number; ownPct: number; rangePct: number; ppdPct: number; uniqPct: number;
  projSum: number; ownSum: number;  // for Pareto + diagnostics
  bringBack: number;
  salaryTotal: number;
  geoMeanOwnHit: number;
}

interface SlateData {
  slate: string;
  candidates: Lineup[];
  players: Player[];
  actuals: ContestActuals;
  config: ContestConfig;
  numTeams: number;
}

async function loadSlate(s: typeof DEV_SLATES[0]): Promise<SlateData | null> {
  const proj = path.join(MLB_DIR, s.proj);
  const act = path.join(MLB_DIR, s.actuals);
  const pool = path.join(MLB_DIR, s.pool);
  if (![proj, act, pool].every(p => fs.existsSync(p))) {
    console.log(`  Skip ${s.slate}: missing files`);
    return null;
  }
  const pr = parseCSVFile(proj, 'mlb', true);
  const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
  const playerPool = buildPlayerPool(pr.players, pr.detectedContestType);
  const actuals = parseContestActuals(act, config);
  const idMap = new Map<string, Player>();
  for (const p of playerPool.players) idMap.set(p.id, p);
  const loaded = loadPoolFromCSV({ filePath: pool, config, playerMap: idMap });
  const teamsSeen = new Set<string>();
  for (const p of playerPool.players) {
    const t = (p.team || '').toUpperCase();
    if (t) teamsSeen.add(t);
  }
  return {
    slate: s.slate,
    candidates: loaded.lineups,
    players: playerPool.players,
    actuals, config,
    numTeams: teamsSeen.size,
  };
}

function buildPairTripleFreqs(candidates: Lineup[]): { pair: Map<string, number>; triple: Map<string, number> } {
  const pair = new Map<string, number>();
  const triple = new Map<string, number>();
  let totalW = 0;
  for (const lu of candidates) {
    const w = Math.max(0.1, lu.projection || 1) ** 2;
    totalW += w;
    const ids = lu.players.map(p => p.id).sort();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const k = ids[i] + '|' + ids[j];
        pair.set(k, (pair.get(k) || 0) + w);
      }
    }
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        for (let l = j + 1; l < ids.length; l++) {
          const k = ids[i] + '|' + ids[j] + '|' + ids[l];
          triple.set(k, (triple.get(k) || 0) + w);
        }
      }
    }
  }
  for (const k of pair.keys()) pair.set(k, pair.get(k)! / totalW);
  for (const k of triple.keys()) triple.set(k, triple.get(k)! / totalW);
  return { pair, triple };
}

function scoreLineup(lu: Lineup, pairFreqs: Map<string, number>, tripleFreqs: Map<string, number>): ScoredLU {
  let floor = 0, ceiling = 0;
  for (const p of lu.players) {
    if (p.percentiles) { floor += p.percentiles.p25 || p.projection * 0.85; ceiling += p.percentiles.p75 || p.projection * 1.15; }
    else { floor += p.projection * 0.85; ceiling += p.projection * 1.15; }
  }
  const teamHitters = new Map<string, number>();
  const pitchers: Player[] = [];
  let projSum = 0;
  let ownSum = 0;
  let salaryTotal = 0;
  let logOwnHit = 0;
  let nHit = 0;
  for (const p of lu.players) {
    projSum += p.projection || 0;
    ownSum += p.ownership || 0;
    salaryTotal += p.salary || 0;
    if (isPitcher(p)) pitchers.push(p);
    else {
      const t = (p.team || '').toUpperCase();
      if (t) teamHitters.set(t, (teamHitters.get(t) || 0) + 1);
      logOwnHit += Math.log(Math.max(0.1, p.ownership || 0.5));
      nHit++;
    }
  }
  const geoMeanOwnHit = nHit > 0 ? Math.exp(logOwnHit / nHit) : 0;
  let primaryTeam = '', primarySize = 0;
  for (const [t, c] of teamHitters) if (c > primarySize) { primarySize = c; primaryTeam = t; }
  let primaryOpp = '';
  for (const p of lu.players) if ((p.team || '').toUpperCase() === primaryTeam) { primaryOpp = (p.opponent || '').toUpperCase(); if (primaryOpp) break; }
  const bringBack = primaryOpp ? (teamHitters.get(primaryOpp) || 0) : 0;
  let pOppHitters = 0;
  for (const p of pitchers) { const o = (p.opponent || '').toUpperCase(); if (o) pOppHitters += teamHitters.get(o) || 0; }
  let corrAdj = 0;
  if (primarySize >= 3) corrAdj += TODFS_V1.STACK_BONUS_PER_HITTER * (primarySize - 2);
  if (bringBack === 1) corrAdj += TODFS_V1.BRINGBACK_1;
  else if (bringBack >= 2) corrAdj += TODFS_V1.BRINGBACK_2;
  corrAdj += TODFS_V1.PITCHER_VS_HITTER_PENALTY * pOppHitters;

  let uniqueness = 0;
  const players = lu.players;
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const k = [players[i].id, players[j].id].sort().join('|');
      const f = pairFreqs.get(k) || 1e-6;
      uniqueness += -Math.log(f);
    }
  }
  const tripFs: { key: string; f: number }[] = [];
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      for (let l = j + 1; l < players.length; l++) {
        const tk = [players[i].id, players[j].id, players[l].id].sort().join('|');
        tripFs.push({ key: tk, f: tripleFreqs.get(tk) || 1e-6 });
      }
    }
  }
  tripFs.sort((a, b) => b.f - a.f);
  for (const t of tripFs.slice(0, TODFS_V1.TRIPLE_FREQ_CAP)) uniqueness += -Math.log(t.f);

  let logOwn = 0;
  for (const p of lu.players) {
    if (isPitcher(p)) continue;
    logOwn += Math.log(Math.max(0.1, p.ownership || 0.5));
  }
  let ppd = 0;
  for (const p of lu.players) if (p.salary && p.projection) ppd += p.projection / (p.salary / 1000);

  return {
    lu, primarySize, primaryTeam, corrAdj, logOwn, uniqueness, ppd,
    proj: lu.projection, floor, ceiling, range: ceiling - floor,
    ev: 0, projPct: 0, ownPct: 0, rangePct: 0, ppdPct: 0, uniqPct: 0,
    projSum, ownSum, bringBack, salaryTotal, geoMeanOwnHit,
  };
}

interface BuildOpts {
  paretoFilter: boolean;
  targetN: number;
  // Returns frontier-filter diagnostic info when applied.
  diagnosticOut?: { frontierIdx?: number[]; preFilterCount?: number };
}

function buildPortfolio(sd: SlateData, opts: BuildOpts): { portfolio: Lineup[]; selectedScored: ScoredLU[]; allScored: ScoredLU[]; frontierIdxIntoAllScored: Set<number> } {
  const target = opts.targetN;

  // ============================================================
  // Score the FULL candidate pool (needed for frontier and for V1 selection).
  // ============================================================
  const { pair, triple } = buildPairTripleFreqs(sd.candidates);
  const allScored: ScoredLU[] = sd.candidates.map(lu => scoreLineup(lu, pair, triple));

  // ============================================================
  // PARETO FILTER — applied to candidate pool before V1 selection.
  // ============================================================
  let workingScored: ScoredLU[];
  let frontierIdxSet = new Set<number>();
  if (opts.paretoFilter) {
    const projSums = new Float64Array(allScored.length);
    const ownSums = new Float64Array(allScored.length);
    for (let i = 0; i < allScored.length; i++) {
      projSums[i] = allScored[i].projSum;
      ownSums[i] = allScored[i].ownSum;
    }
    // Relaxed: peel multiple Pareto layers until ~500 candidates accumulated
    // (enough margin for V1's exposure caps + overlap caps to fill 75 lineups).
    const layered = computeParetoLayered(projSums, ownSums, 500, 20);
    const frontier = layered.indices;
    frontierIdxSet = new Set(frontier);
    if (opts.diagnosticOut) {
      opts.diagnosticOut.frontierIdx = frontier.slice();
      opts.diagnosticOut.preFilterCount = allScored.length;
    }
    workingScored = frontier.map(i => allScored[i]);
    process.stderr.write(`    Pareto: ${frontier.length}/${allScored.length} on frontier `);
  } else {
    workingScored = allScored;
  }

  // ============================================================
  // V1 selection scoring on the (filtered or full) pool.
  // ============================================================
  const projAdj = workingScored.map(s => s.proj * (1 + s.corrAdj));
  const projPct = rankPercentile(projAdj);
  const ownPct = rankPercentile(workingScored.map(s => s.logOwn));
  const rangePct = rankPercentile(workingScored.map(s => s.range));
  const ppdPct = rankPercentile(workingScored.map(s => s.ppd));
  const uniqPct = rankPercentile(workingScored.map(s => s.uniqueness));
  for (let i = 0; i < workingScored.length; i++) {
    workingScored[i].projPct = projPct[i]; workingScored[i].ownPct = ownPct[i];
    workingScored[i].rangePct = rangePct[i]; workingScored[i].ppdPct = ppdPct[i];
    workingScored[i].uniqPct = uniqPct[i];
  }
  for (const s of workingScored) {
    let ev = TODFS_V1.W_PROJ * s.projPct
           + TODFS_V1.W_LEV * (1 - s.ownPct)
           + TODFS_V1.W_VAR * s.rangePct * 0.85
           + TODFS_V1.W_CMB * s.uniqPct;
    if (s.ppdPct >= 1 - TODFS_V1.PPD_LINEUP_TOP_PCT) ev *= (1 - TODFS_V1.PPD_LINEUP_PENALTY);
    s.ev = ev;
  }

  // Hard MIN_PRIMARY_STACK constraint.
  // NOTE: per methodology, V1-PF does NOT fall back to the unfiltered pool when
  // the frontier under-fills. Under-fill is acceptable and informative.
  let pool2 = workingScored.filter(s => s.primarySize >= TODFS_V1.MIN_PRIMARY_STACK);
  if (pool2.length < target) {
    if (!opts.paretoFilter) {
      pool2 = workingScored;  // V1 baseline: identical fallback to legacy V1.
    } else {
      // V1-PF: do NOT pad from non-frontier pool. Allow primarySize<4 only WITHIN frontier
      // (acceptable per methodology — under-fill rather than re-introduce dominated lineups).
      pool2 = workingScored;
    }
  }

  // Variance bands (20/60/20).
  const sortedHigh = [...pool2].sort((a, b) => (b.projPct + b.ownPct) - (a.projPct + a.ownPct));
  const sortedLow = [...pool2].sort((a, b) => ((1 - b.projPct) + (1 - b.ownPct)) - ((1 - a.projPct) + (1 - a.ownPct)));
  const HIGH_TARGET = Math.round(target * TODFS_V1.BAND_HIGH_PCT);
  const LOW_TARGET = Math.round(target * TODFS_V1.BAND_LOW_PCT);
  const MID_TARGET = target - HIGH_TARGET - LOW_TARGET;

  const selected: ScoredLU[] = [];
  const exposure = new Map<string, number>();
  const teamStackCount = new Map<string, number>();
  const seen = new Set<string>();
  function primaryStackTeamOf(s: ScoredLU): string {
    return s.primarySize >= 4 ? s.primaryTeam : '';
  }
  function passes(s: ScoredLU): boolean {
    if (seen.has(s.lu.hash)) return false;
    if (s.primarySize < TODFS_V1.MIN_PRIMARY_STACK) return false;
    for (const p of s.lu.players) {
      const cur = exposure.get(p.id) || 0;
      const cap = isPitcher(p) ? TODFS_V1.EXPOSURE_CAP_PITCHER : TODFS_V1.EXPOSURE_CAP_HITTER;
      if ((cur + 1) / target > cap) return false;
    }
    const stackTeam = primaryStackTeamOf(s);
    if (stackTeam) {
      const cur = teamStackCount.get(stackTeam) || 0;
      if ((cur + 1) / target > TODFS_V1.TEAM_STACK_CAP) return false;
    }
    const ids = new Set(s.lu.players.map(p => p.id));
    for (const sel of selected) {
      let ov = 0; for (const p of sel.lu.players) if (ids.has(p.id)) ov++;
      if (ov > TODFS_V1.MAX_PAIRWISE_OVERLAP) return false;
    }
    return true;
  }
  function add(s: ScoredLU) {
    selected.push(s); seen.add(s.lu.hash);
    for (const p of s.lu.players) exposure.set(p.id, (exposure.get(p.id) || 0) + 1);
    const stackTeam = primaryStackTeamOf(s);
    if (stackTeam) teamStackCount.set(stackTeam, (teamStackCount.get(stackTeam) || 0) + 1);
  }
  function fillBand(bandPool: ScoredLU[], targetCount: number) {
    const sorted = [...bandPool].sort((a, b) => b.ev - a.ev);
    let added = 0;
    for (const s of sorted) { if (added >= targetCount) break; if (passes(s)) { add(s); added++; } }
    if (added < targetCount) {
      const old = TODFS_V1.MAX_PAIRWISE_OVERLAP;
      (TODFS_V1 as any).MAX_PAIRWISE_OVERLAP = old + 1;
      for (const s of sorted) { if (added >= targetCount) break; if (passes(s)) { add(s); added++; } }
      (TODFS_V1 as any).MAX_PAIRWISE_OVERLAP = old;
    }
  }
  fillBand(sortedHigh.slice(0, Math.max(HIGH_TARGET * 5, 200)), HIGH_TARGET);
  fillBand(pool2, MID_TARGET);
  fillBand(sortedLow.slice(0, Math.max(LOW_TARGET * 5, 200)), LOW_TARGET);
  if (selected.length < target) {
    const sorted = [...pool2].sort((a, b) => b.ev - a.ev);
    for (const s of sorted) { if (selected.length >= target) break; if (passes(s)) add(s); }
  }
  if (selected.length < target) {
    // Last-resort: relax team-stack cap (matches V1 baseline behavior).
    const sorted = [...pool2].sort((a, b) => b.ev - a.ev);
    const oldCap = TODFS_V1.TEAM_STACK_CAP;
    (TODFS_V1 as any).TEAM_STACK_CAP = 1.0;
    for (const s of sorted) { if (selected.length >= target) break; if (passes(s)) add(s); }
    (TODFS_V1 as any).TEAM_STACK_CAP = oldCap;
  }
  return {
    portfolio: selected.slice(0, target).map(s => s.lu),
    selectedScored: selected.slice(0, target),
    allScored,
    frontierIdxIntoAllScored: frontierIdxSet,
  };
}

// ============================================================
// PROS-CONSENSUS-FREE STRUCTURAL METRICS
// ============================================================
interface ConstructionMetrics {
  slate: string;
  variant: string;
  numLineups: number;
  pctPrimary5plus: number;
  pctPrimary4: number;
  pctPrimary3: number;
  pctPrimaryOther: number;
  pctBringback1plus: number;
  pctBringback2plus: number;
  bandHpHo: number; bandHpLo: number; bandLpHo: number; bandLpLo: number;
  meanPairwiseJaccard: number;
  maxPairwiseJaccard: number;
  meanSalary: number;
  meanProjSum: number;
  meanOwnSum: number;
  meanGeoMeanOwnHit: number;
  numUniquePlayers: number;
}

function constructionMetrics(portfolio: Lineup[], slate: string, variant: string): ConstructionMetrics {
  if (portfolio.length === 0) {
    return {
      slate, variant, numLineups: 0,
      pctPrimary5plus: 0, pctPrimary4: 0, pctPrimary3: 0, pctPrimaryOther: 0,
      pctBringback1plus: 0, pctBringback2plus: 0,
      bandHpHo: 0, bandHpLo: 0, bandLpHo: 0, bandLpLo: 0,
      meanPairwiseJaccard: 0, maxPairwiseJaccard: 0,
      meanSalary: 0, meanProjSum: 0, meanOwnSum: 0, meanGeoMeanOwnHit: 0,
      numUniquePlayers: 0,
    };
  }
  let p5 = 0, p4 = 0, p3 = 0, pOther = 0, bb1 = 0, bb2 = 0;
  const projs = portfolio.map(lu => lu.projection);
  const geoOwns: number[] = [];
  const salaryTotals: number[] = [];
  const ownSums: number[] = [];
  const projSums: number[] = [];
  for (const lu of portfolio) {
    const teamHitterIds = new Map<string, string[]>();
    let salaryTotal = 0, ownSum = 0;
    let logOwnHit = 0, hitN = 0;
    for (const p of lu.players) {
      salaryTotal += p.salary || 0;
      ownSum += p.ownership || 0;
      if (isPitcher(p)) continue;
      const t = (p.team || '').toUpperCase();
      if (t) {
        if (!teamHitterIds.has(t)) teamHitterIds.set(t, []);
        teamHitterIds.get(t)!.push(p.id);
      }
      logOwnHit += Math.log(Math.max(0.1, p.ownership || 0.5));
      hitN++;
    }
    const geoMeanOwnHit = hitN > 0 ? Math.exp(logOwnHit / hitN) : 0;
    geoOwns.push(geoMeanOwnHit);
    salaryTotals.push(salaryTotal);
    ownSums.push(ownSum);
    projSums.push(lu.projection || 0);
    let primaryTeam = '', primarySize = 0;
    for (const [t, ids] of teamHitterIds) if (ids.length > primarySize) { primarySize = ids.length; primaryTeam = t; }
    if (primarySize >= 5) p5++;
    else if (primarySize === 4) p4++;
    else if (primarySize === 3) p3++;
    else pOther++;
    let primaryOpp = '';
    for (const p of lu.players) if ((p.team || '').toUpperCase() === primaryTeam) { primaryOpp = (p.opponent || '').toUpperCase(); if (primaryOpp) break; }
    const bringBack = primaryOpp ? (teamHitterIds.get(primaryOpp)?.length || 0) : 0;
    if (bringBack >= 1) bb1++;
    if (bringBack >= 2) bb2++;
  }

  // Band classification using the portfolio's own median (variant + slate local).
  const medProj = [...projs].sort((a, b) => a - b)[Math.floor(projs.length / 2)];
  const medOwn = [...geoOwns].sort((a, b) => a - b)[Math.floor(geoOwns.length / 2)];
  let hpHo = 0, hpLo = 0, lpHo = 0, lpLo = 0;
  for (let i = 0; i < portfolio.length; i++) {
    const hp = projs[i] >= medProj;
    const ho = geoOwns[i] >= medOwn;
    if (hp && ho) hpHo++;
    else if (hp && !ho) hpLo++;
    else if (!hp && ho) lpHo++;
    else lpLo++;
  }

  // Within-portfolio pairwise Jaccard (mean and max).
  const lineupIds = portfolio.map(lu => new Set(lu.players.map(p => p.id)));
  let jacSum = 0, pairs = 0, maxJac = 0;
  for (let i = 0; i < lineupIds.length; i++) {
    for (let j = i + 1; j < lineupIds.length; j++) {
      const a = lineupIds[i], b = lineupIds[j];
      let inter = 0;
      for (const id of a) if (b.has(id)) inter++;
      const uni = a.size + b.size - inter;
      const jac = uni > 0 ? inter / uni : 0;
      jacSum += jac;
      if (jac > maxJac) maxJac = jac;
      pairs++;
    }
  }

  const allIds = new Set<string>();
  for (const lu of portfolio) for (const p of lu.players) allIds.add(p.id);

  const total = portfolio.length;
  return {
    slate, variant, numLineups: total,
    pctPrimary5plus: p5 / total, pctPrimary4: p4 / total,
    pctPrimary3: p3 / total, pctPrimaryOther: pOther / total,
    pctBringback1plus: bb1 / total, pctBringback2plus: bb2 / total,
    bandHpHo: hpHo / total, bandHpLo: hpLo / total,
    bandLpHo: lpHo / total, bandLpLo: lpLo / total,
    meanPairwiseJaccard: pairs > 0 ? jacSum / pairs : 0,
    maxPairwiseJaccard: maxJac,
    meanSalary: mean(salaryTotals), meanProjSum: mean(projSums), meanOwnSum: mean(ownSums),
    meanGeoMeanOwnHit: mean(geoOwns),
    numUniquePlayers: allIds.size,
  };
}

// ============================================================
// TOURNAMENT METRICS
// ============================================================
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

interface TournamentMetrics {
  slate: string;
  variant: string;
  numLineups: number;
  numScored: number;
  top1Hits: number;
  top01Hits: number;
  top1Rate: number;
  top01Rate: number;
  meanFinishPctile: number;
  inverseBellRatio: number;
  totalPayout: number;
  fees: number;
  roi: number;
  fieldEntries: number;
}

interface TournamentLineupInput {
  playerNames: string[];           // raw names (need norm())
  actualPoints?: number;           // pre-computed (used for V1 dump path)
}

function computeTournamentFromActual(actualScores: number[], slate: string, variant: string, actuals: ContestActuals, numLineups: number): TournamentMetrics {
  const F = actuals.entries.length;
  const sortedActuals = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
  const top1T = sortedActuals[Math.max(0, Math.floor(F * 0.01) - 1)] || 0;
  const top01T = sortedActuals[Math.max(0, Math.floor(F * 0.001) - 1)] || 0;
  const payoutTable = buildPayoutTable(Math.max(F, 100));
  let totalPayout = 0, t1 = 0, t01 = 0;
  const finishPctiles: number[] = [];
  for (const actual of actualScores) {
    if (!Number.isFinite(actual)) continue;
    let lo = 0, hi = sortedActuals.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (sortedActuals[mid] >= actual) lo = mid + 1; else hi = mid; }
    const rank = Math.max(1, lo);
    finishPctiles.push(F > 1 ? 1 - (rank - 1) / (F - 1) : 0.5);
    if (actual >= top1T) t1++;
    if (actual >= top01T) t01++;
    const pay = rank <= payoutTable.length ? payoutTable[rank - 1] : 0;
    if (pay > 0) {
      let cw = 0;
      for (const e of actuals.entries) if (Math.abs(e.actualPoints - actual) <= 0.25) cw++;
      cw = Math.max(0, cw - 1);
      totalPayout += pay / Math.sqrt(1 + cw * 0.5);
    }
  }
  const numScored = finishPctiles.length;
  const fees = numLineups * FEE;
  const sortedFin = finishPctiles.slice().sort((a, b) => a - b);
  const q1 = sortedFin.length > 0 ? Math.floor(sortedFin.length * 0.2) : 0;
  const q4 = sortedFin.length > 0 ? Math.floor(sortedFin.length * 0.8) : 0;
  const m1 = Math.floor(sortedFin.length * 0.4);
  const m2 = Math.floor(sortedFin.length * 0.6);
  const botQuint = q1;
  const topQuint = sortedFin.length - q4;
  const midQuint = Math.max(1, m2 - m1);
  const inverseBellRatio = midQuint > 0 ? (botQuint + topQuint) / (2 * midQuint) : 0;
  return {
    slate, variant,
    numLineups, numScored,
    top1Hits: t1, top01Hits: t01,
    top1Rate: numLineups > 0 ? t1 / numLineups : 0,
    top01Rate: numLineups > 0 ? t01 / numLineups : 0,
    meanFinishPctile: finishPctiles.length > 0 ? mean(finishPctiles) : 0,
    inverseBellRatio,
    totalPayout, fees,
    roi: fees > 0 ? totalPayout / fees - 1 : 0,
    fieldEntries: F,
  };
}

function lineupActualPoints(lu: Lineup, actuals: ContestActuals): number | null {
  let actual = 0;
  for (const p of lu.players) {
    const r = actuals.playerActualsByName.get(norm(p.name));
    if (!r) return null;
    actual += r.fpts;
  }
  return actual;
}

// ============================================================
// V1 BASELINE LOAD FROM DUMP
// ============================================================
interface V1DumpLineup {
  pids: string[]; names: string[]; teams: string[]; positions: string[]; salaries: number[];
  owns: number[]; projection: number; actual: number; rank: number; finishPct: number;
  primaryTeam: string; primarySize: number; secondarySize: number; bringBack: number;
  numTeamsUsed: number; numGames: number; salaryTotal: number;
  geoMeanOwnHit: number; ownAvg: number;
}
interface V1DumpSlate { slate: string; numTeams: number; totalEntries: number; v1: V1DumpLineup[]; }

let V1_DUMP_CACHE: Map<string, V1DumpSlate> | null = null;
function loadV1Dump(): Map<string, V1DumpSlate> {
  if (V1_DUMP_CACHE) return V1_DUMP_CACHE;
  const raw: V1DumpSlate[] = JSON.parse(fs.readFileSync(V1_DUMP_PATH, 'utf-8'));
  const m = new Map<string, V1DumpSlate>();
  for (const s of raw) m.set(s.slate, s);
  V1_DUMP_CACHE = m;
  return m;
}

function v1DumpConstruction(slate: string): ConstructionMetrics | null {
  const dump = loadV1Dump().get(slate);
  if (!dump) return null;
  const lus = dump.v1;
  const projs = lus.map(l => l.projection);
  const geoOwns = lus.map(l => l.geoMeanOwnHit);
  const salaryTotals = lus.map(l => l.salaryTotal);
  const ownSums = lus.map(l => l.ownAvg * l.pids.length);
  let p5 = 0, p4 = 0, p3 = 0, pOther = 0, bb1 = 0, bb2 = 0;
  for (const l of lus) {
    if (l.primarySize >= 5) p5++;
    else if (l.primarySize === 4) p4++;
    else if (l.primarySize === 3) p3++;
    else pOther++;
    if (l.bringBack >= 1) bb1++;
    if (l.bringBack >= 2) bb2++;
  }
  const medProj = [...projs].sort((a, b) => a - b)[Math.floor(projs.length / 2)];
  const medOwn = [...geoOwns].sort((a, b) => a - b)[Math.floor(geoOwns.length / 2)];
  let hpHo = 0, hpLo = 0, lpHo = 0, lpLo = 0;
  for (let i = 0; i < lus.length; i++) {
    const hp = projs[i] >= medProj;
    const ho = geoOwns[i] >= medOwn;
    if (hp && ho) hpHo++;
    else if (hp && !ho) hpLo++;
    else if (!hp && ho) lpHo++;
    else lpLo++;
  }
  // Pairwise Jaccard.
  const idSets = lus.map(l => new Set(l.pids));
  let jacSum = 0, pairs = 0, maxJac = 0;
  for (let i = 0; i < idSets.length; i++) {
    for (let j = i + 1; j < idSets.length; j++) {
      let inter = 0;
      for (const id of idSets[i]) if (idSets[j].has(id)) inter++;
      const uni = idSets[i].size + idSets[j].size - inter;
      const jac = uni > 0 ? inter / uni : 0;
      jacSum += jac;
      if (jac > maxJac) maxJac = jac;
      pairs++;
    }
  }
  const allIds = new Set<string>();
  for (const l of lus) for (const id of l.pids) allIds.add(id);
  const total = lus.length;
  return {
    slate, variant: 'V1', numLineups: total,
    pctPrimary5plus: p5 / total, pctPrimary4: p4 / total,
    pctPrimary3: p3 / total, pctPrimaryOther: pOther / total,
    pctBringback1plus: bb1 / total, pctBringback2plus: bb2 / total,
    bandHpHo: hpHo / total, bandHpLo: hpLo / total,
    bandLpHo: lpHo / total, bandLpLo: lpLo / total,
    meanPairwiseJaccard: pairs > 0 ? jacSum / pairs : 0,
    maxPairwiseJaccard: maxJac,
    meanSalary: mean(salaryTotals), meanProjSum: mean(projs), meanOwnSum: mean(ownSums),
    meanGeoMeanOwnHit: mean(geoOwns),
    numUniquePlayers: allIds.size,
  };
}

function v1DumpTournament(slate: string, actuals: ContestActuals): TournamentMetrics | null {
  const dump = loadV1Dump().get(slate);
  if (!dump) return null;
  const lus = dump.v1;
  const actualScores = lus.map(l => l.actual).filter(v => Number.isFinite(v));
  return computeTournamentFromActual(actualScores, slate, 'V1', actuals, lus.length);
}

// V1 dump returns a hashable lineup signature (sorted PIDs) for diagnostic overlap.
function v1DumpSignatures(slate: string): Set<string> | null {
  const dump = loadV1Dump().get(slate);
  if (!dump) return null;
  const sigs = new Set<string>();
  for (const l of dump.v1) sigs.add(l.pids.slice().sort().join('|'));
  return sigs;
}

// V1 baseline lineups projected onto sd.candidates (so we can check Pareto-frontier
// membership of V1's actual selections).
function v1BaselineCandidateMatches(sd: SlateData, allScored: ScoredLU[], frontierSet: Set<number>): { v1Count: number; v1OnFrontier: number } {
  const sigs = v1DumpSignatures(sd.slate);
  if (!sigs) return { v1Count: 0, v1OnFrontier: 0 };
  // Map sd.candidates index by sorted PIDs.
  const sigToCand = new Map<string, number>();
  for (let i = 0; i < sd.candidates.length; i++) {
    const lu = sd.candidates[i];
    const sig = lu.players.map(p => p.id).sort().join('|');
    sigToCand.set(sig, i);
  }
  let total = 0, onFrontier = 0;
  for (const sig of sigs) {
    const idx = sigToCand.get(sig);
    if (idx === undefined) continue;
    total++;
    if (frontierSet.has(idx)) onFrontier++;
  }
  return { v1Count: total, v1OnFrontier: onFrontier };
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log('================================================================');
  console.log('PARETO-FILTER (V1-PF) VARIANT TEST');
  console.log('Single binary-constraint variant.');
  console.log('Pareto frontier on (projection_sum, ownership_sum). 16 dev slates.');
  console.log('================================================================\n');
  console.log(`Methodology lock: ${path.join(OUT_DIR, 'methodology.md')}`);
  console.log(`V1 baseline source: ${V1_DUMP_PATH} (N=${N_V1})`);
  console.log(`V1-PF target N: ${N}`);
  console.log('');

  const constructionRows: ConstructionMetrics[] = [];
  const tournamentRows: TournamentMetrics[] = [];
  const perSlateOutcomes: any[] = [];
  const frontierRows: any[] = [];
  const diagnosticRows: any[] = [];

  for (const s of DEV_SLATES) {
    process.stderr.write(`${s.slate}: loading ... `);
    const sd = await loadSlate(s);
    if (!sd) continue;
    process.stderr.write(`pool=${sd.candidates.length} ... `);

    // Build V1-PF (filtered) portfolio.
    const built = buildPortfolio(sd, { paretoFilter: true, targetN: N });
    const pfPortfolio = built.portfolio;
    const frontierSize = built.frontierIdxIntoAllScored.size;
    const underFill75 = frontierSize < N ? 1 : 0;
    const portfolioUnderFill = pfPortfolio.length < N ? 1 : 0;

    // V1 baseline: from dump (existing N=150 portfolio per slate).
    const v1Construction = v1DumpConstruction(sd.slate);
    const v1Tournament = v1DumpTournament(sd.slate, sd.actuals);
    if (!v1Construction || !v1Tournament) {
      console.log(`  WARN ${s.slate}: V1 dump missing for this slate, skipping`);
      continue;
    }

    // V1 baseline overlap with frontier (verification metric).
    const v1Overlap = v1BaselineCandidateMatches(sd, built.allScored, built.frontierIdxIntoAllScored);
    const v1FrontierFrac = v1Overlap.v1Count > 0 ? v1Overlap.v1OnFrontier / v1Overlap.v1Count : 0;

    frontierRows.push({
      slate: s.slate,
      candidate_pool_size: built.allScored.length,
      frontier_size: frontierSize,
      frontier_frac: built.allScored.length > 0 ? frontierSize / built.allScored.length : 0,
      under_fill_75: underFill75,
      pf_portfolio_size: pfPortfolio.length,
      portfolio_under_fill: portfolioUnderFill,
      v1_lineups_matched_in_candidates: v1Overlap.v1Count,
      v1_lineups_on_frontier: v1Overlap.v1OnFrontier,
      v1_frontier_overlap_pct: v1FrontierFrac,
    });

    // Save portfolio CSVs.
    const pfOut = path.join(PORTFOLIO_DIR, `${s.slate}_dk.csv`);
    const pfDetail = path.join(PORTFOLIO_DIR, `${s.slate}_detail.csv`);
    if (pfPortfolio.length > 0) {
      exportForDraftKings(pfPortfolio, sd.config, pfOut);
      exportDetailedLineups(pfPortfolio, sd.config, pfDetail);
    }

    // Construction metrics for V1-PF.
    const cmPF = constructionMetrics(pfPortfolio, sd.slate, 'V1-PF');
    constructionRows.push(v1Construction, cmPF);

    // Tournament metrics for V1-PF.
    const pfActuals = pfPortfolio.map(lu => lineupActualPoints(lu, sd.actuals)).filter((v): v is number => v !== null);
    const tmPF = computeTournamentFromActual(pfActuals, sd.slate, 'V1-PF', sd.actuals, pfPortfolio.length);
    tournamentRows.push(v1Tournament, tmPF);

    // Per-slate verdict.
    const v1Top1 = v1Tournament.top1Rate;
    const pfTop1 = tmPF.top1Rate;
    const v1Top01 = v1Tournament.top01Rate;
    const pfTop01 = tmPF.top01Rate;
    const classify = (varRate: number, baseRate: number): string => {
      if (baseRate === 0) {
        if (varRate > 0) return 'helped';
        return 'neutral';
      }
      const rel = varRate / baseRate;
      if (rel > 1.5) return 'helped';
      if (rel < 0.5) return 'hurt';
      return 'neutral';
    };
    const top1Verdict = classify(pfTop1, v1Top1);
    const top01Verdict = classify(pfTop01, v1Top01);

    perSlateOutcomes.push({
      slate: s.slate,
      v1_lineups: v1Tournament.numLineups,
      pf_lineups: tmPF.numLineups,
      v1_top1_hits: v1Tournament.top1Hits, v1_top1_rate: v1Top1,
      pf_top1_hits: tmPF.top1Hits, pf_top1_rate: pfTop1,
      top1_rate_ratio: v1Top1 > 0 ? pfTop1 / v1Top1 : (pfTop1 > 0 ? Infinity : 1),
      top1_verdict: top1Verdict,
      v1_top01_hits: v1Tournament.top01Hits, v1_top01_rate: v1Top01,
      pf_top01_hits: tmPF.top01Hits, pf_top01_rate: pfTop01,
      top01_rate_ratio: v1Top01 > 0 ? pfTop01 / v1Top01 : (pfTop01 > 0 ? Infinity : 1),
      top01_verdict: top01Verdict,
      v1_mean_finish: v1Tournament.meanFinishPctile,
      pf_mean_finish: tmPF.meanFinishPctile,
      v1_roi: v1Tournament.roi,
      pf_roi: tmPF.roi,
    });

    // Diagnostic: characterize PF-included-but-not-V1 (frontier wins) and V1-included-but-not-PF
    // (V1's dominated picks). Use lineup signatures.
    const v1Sigs = v1DumpSignatures(sd.slate)!;
    const pfSigs = new Set(pfPortfolio.map(lu => lu.players.map(p => p.id).sort().join('|')));
    let pfOnlyP5 = 0, pfOnlyP4 = 0, pfOnlyP3 = 0, pfOnlyOther = 0;
    let pfOnlyBb1 = 0, pfOnlyBb2 = 0;
    let pfOnlyProj = 0, pfOnlyOwn = 0, pfOnlyN = 0;
    for (const sig of pfSigs) {
      if (v1Sigs.has(sig)) continue;
      pfOnlyN++;
      // Find lineup details.
      const lu = pfPortfolio.find(p => p.players.map(pp => pp.id).sort().join('|') === sig);
      if (!lu) continue;
      const teamHitterIds = new Map<string, string[]>();
      for (const p of lu.players) {
        if (isPitcher(p)) continue;
        const t = (p.team || '').toUpperCase();
        if (t) {
          if (!teamHitterIds.has(t)) teamHitterIds.set(t, []);
          teamHitterIds.get(t)!.push(p.id);
        }
      }
      let primaryTeam = '', primarySize = 0;
      for (const [t, ids] of teamHitterIds) if (ids.length > primarySize) { primarySize = ids.length; primaryTeam = t; }
      if (primarySize >= 5) pfOnlyP5++;
      else if (primarySize === 4) pfOnlyP4++;
      else if (primarySize === 3) pfOnlyP3++;
      else pfOnlyOther++;
      let primaryOpp = '';
      for (const p of lu.players) if ((p.team || '').toUpperCase() === primaryTeam) { primaryOpp = (p.opponent || '').toUpperCase(); if (primaryOpp) break; }
      const bringBack = primaryOpp ? (teamHitterIds.get(primaryOpp)?.length || 0) : 0;
      if (bringBack >= 1) pfOnlyBb1++;
      if (bringBack >= 2) pfOnlyBb2++;
      pfOnlyProj += lu.projection;
      let ownSum = 0;
      for (const p of lu.players) ownSum += p.ownership || 0;
      pfOnlyOwn += ownSum;
    }

    let v1OnlyP5 = 0, v1OnlyP4 = 0, v1OnlyP3 = 0, v1OnlyOther = 0;
    let v1OnlyBb1 = 0, v1OnlyBb2 = 0;
    let v1OnlyProj = 0, v1OnlyOwn = 0, v1OnlyN = 0;
    let v1OnlyFrontier = 0, v1OnlyDominated = 0;
    const dump = loadV1Dump().get(sd.slate)!;
    // Map sig -> candidate index for frontier check.
    const sigToCandIdx = new Map<string, number>();
    for (let i = 0; i < sd.candidates.length; i++) {
      const sig = sd.candidates[i].players.map(p => p.id).sort().join('|');
      sigToCandIdx.set(sig, i);
    }
    for (const v1L of dump.v1) {
      const sig = v1L.pids.slice().sort().join('|');
      if (pfSigs.has(sig)) continue;
      v1OnlyN++;
      if (v1L.primarySize >= 5) v1OnlyP5++;
      else if (v1L.primarySize === 4) v1OnlyP4++;
      else if (v1L.primarySize === 3) v1OnlyP3++;
      else v1OnlyOther++;
      if (v1L.bringBack >= 1) v1OnlyBb1++;
      if (v1L.bringBack >= 2) v1OnlyBb2++;
      v1OnlyProj += v1L.projection;
      v1OnlyOwn += v1L.ownAvg * v1L.pids.length;
      const ci = sigToCandIdx.get(sig);
      if (ci !== undefined) {
        if (built.frontierIdxIntoAllScored.has(ci)) v1OnlyFrontier++;
        else v1OnlyDominated++;
      }
    }

    diagnosticRows.push({
      slate: s.slate,
      pf_only_lineups: pfOnlyN,
      pf_only_pct_p5plus: pfOnlyN > 0 ? pfOnlyP5 / pfOnlyN : 0,
      pf_only_pct_p4: pfOnlyN > 0 ? pfOnlyP4 / pfOnlyN : 0,
      pf_only_pct_bb1: pfOnlyN > 0 ? pfOnlyBb1 / pfOnlyN : 0,
      pf_only_mean_proj: pfOnlyN > 0 ? pfOnlyProj / pfOnlyN : 0,
      pf_only_mean_ownsum: pfOnlyN > 0 ? pfOnlyOwn / pfOnlyN : 0,
      v1_only_lineups: v1OnlyN,
      v1_only_pct_p5plus: v1OnlyN > 0 ? v1OnlyP5 / v1OnlyN : 0,
      v1_only_pct_p4: v1OnlyN > 0 ? v1OnlyP4 / v1OnlyN : 0,
      v1_only_pct_bb1: v1OnlyN > 0 ? v1OnlyBb1 / v1OnlyN : 0,
      v1_only_mean_proj: v1OnlyN > 0 ? v1OnlyProj / v1OnlyN : 0,
      v1_only_mean_ownsum: v1OnlyN > 0 ? v1OnlyOwn / v1OnlyN : 0,
      v1_only_on_frontier: v1OnlyFrontier,
      v1_only_dominated: v1OnlyDominated,
    });

    process.stderr.write(`v1_t1=${v1Tournament.top1Hits}/${v1Tournament.numLineups}=${(v1Top1*100).toFixed(2)}% pf_t1=${tmPF.top1Hits}/${tmPF.numLineups}=${(pfTop1*100).toFixed(2)}% [${top1Verdict}]\n`);
  }

  // ============================================================
  // CSV outputs.
  // ============================================================
  function writeCsv(filename: string, rows: any[], headerOrder?: string[]) {
    if (rows.length === 0) { fs.writeFileSync(path.join(OUT_DIR, filename), ''); return; }
    const headers = headerOrder || Object.keys(rows[0]);
    const lines = [headers.join(',')];
    for (const r of rows) {
      lines.push(headers.map(h => {
        const v = r[h];
        if (typeof v === 'number') return v.toFixed(6).replace(/\.?0+$/, '');
        return String(v ?? '');
      }).join(','));
    }
    fs.writeFileSync(path.join(OUT_DIR, filename), lines.join('\n') + '\n');
  }
  writeCsv('per_slate_frontier_size.csv', frontierRows);
  writeCsv('construction_comparison.csv', constructionRows);
  writeCsv('tournament_comparison.csv', tournamentRows);
  writeCsv('per_slate_outcomes.csv', perSlateOutcomes);
  writeCsv('filtered_lineup_diagnostics.csv', diagnosticRows);

  // ============================================================
  // Bootstrap CIs over slates (deterministic seed).
  // ============================================================
  const v1Slates = tournamentRows.filter(r => r.variant === 'V1');
  const pfSlates = tournamentRows.filter(r => r.variant === 'V1-PF');

  function aggRate(rows: TournamentMetrics[], pctile: 'top1' | 'top01'): { rate: number; hits: number; lineups: number } {
    let hits = 0, lineups = 0;
    for (const r of rows) {
      hits += pctile === 'top1' ? r.top1Hits : r.top01Hits;
      lineups += r.numLineups;
    }
    return { rate: lineups > 0 ? hits / lineups : 0, hits, lineups };
  }

  function bootstrap(rows: TournamentMetrics[], pctile: 'top1' | 'top01', samples: number, seed: number): { lift: number; lo: number; hi: number; rate: number; rateLo: number; rateHi: number } {
    const expectedRate = pctile === 'top1' ? 0.01 : 0.001;
    const rng = mulberry32(seed);
    const liftSamples: number[] = new Array(samples);
    const rateSamples: number[] = new Array(samples);
    for (let s = 0; s < samples; s++) {
      let hits = 0, lineups = 0;
      for (let i = 0; i < rows.length; i++) {
        const idx = Math.floor(rng() * rows.length);
        const r = rows[idx];
        hits += pctile === 'top1' ? r.top1Hits : r.top01Hits;
        lineups += r.numLineups;
      }
      const rate = lineups > 0 ? hits / lineups : 0;
      rateSamples[s] = rate;
      liftSamples[s] = lineups > 0 ? rate / expectedRate : 0;
    }
    liftSamples.sort((a, b) => a - b);
    rateSamples.sort((a, b) => a - b);
    return {
      lift: liftSamples[Math.floor(samples / 2)],
      lo: liftSamples[Math.floor(samples * 0.025)],
      hi: liftSamples[Math.floor(samples * 0.975)],
      rate: rateSamples[Math.floor(samples / 2)],
      rateLo: rateSamples[Math.floor(samples * 0.025)],
      rateHi: rateSamples[Math.floor(samples * 0.975)],
    };
  }

  const v1Top1 = aggRate(v1Slates, 'top1');
  const pfTop1 = aggRate(pfSlates, 'top1');
  const v1Top01 = aggRate(v1Slates, 'top01');
  const pfTop01 = aggRate(pfSlates, 'top01');
  const v1Top1Boot = bootstrap(v1Slates, 'top1', BOOTSTRAP_SAMPLES, BOOTSTRAP_SEED);
  const pfTop1Boot = bootstrap(pfSlates, 'top1', BOOTSTRAP_SAMPLES, BOOTSTRAP_SEED + 1);
  const v1Top01Boot = bootstrap(v1Slates, 'top01', BOOTSTRAP_SAMPLES, BOOTSTRAP_SEED + 2);
  const pfTop01Boot = bootstrap(pfSlates, 'top01', BOOTSTRAP_SAMPLES, BOOTSTRAP_SEED + 3);

  const v1ROI = v1Slates.reduce((s, r) => s + r.totalPayout, 0) / Math.max(1, v1Slates.reduce((s, r) => s + r.fees, 0)) - 1;
  const pfROI = pfSlates.reduce((s, r) => s + r.totalPayout, 0) / Math.max(1, pfSlates.reduce((s, r) => s + r.fees, 0)) - 1;

  // Per-slate breakdown.
  let h1 = 0, hu1 = 0, n1 = 0, h01 = 0, hu01 = 0, n01 = 0;
  for (const a of perSlateOutcomes) {
    if (a.top1_verdict === 'helped') h1++;
    else if (a.top1_verdict === 'hurt') hu1++;
    else n1++;
    if (a.top01_verdict === 'helped') h01++;
    else if (a.top01_verdict === 'hurt') hu01++;
    else n01++;
  }

  // Verification aggregates.
  const meanFrontierSize = mean(frontierRows.map((r: any) => r.frontier_size));
  const meanFrontierFrac = mean(frontierRows.map((r: any) => r.frontier_frac));
  const meanV1Overlap = mean(frontierRows.map((r: any) => r.v1_frontier_overlap_pct));
  const underFillSlates = frontierRows.filter((r: any) => r.under_fill_75 === 1).length;
  const portfolioUnderFillSlates = frontierRows.filter((r: any) => r.portfolio_under_fill === 1).length;

  // Construction summary.
  const v1Cons = constructionRows.filter(r => r.variant === 'V1');
  const pfCons = constructionRows.filter(r => r.variant === 'V1-PF');

  // ============================================================
  // PRINT SUMMARY.
  // ============================================================
  console.log('\n================================================================');
  console.log('SUMMARY');
  console.log('================================================================');
  console.log(`Methodology lock: ${path.join(OUT_DIR, 'methodology.md')}`);
  console.log(`Slates evaluated: ${v1Slates.length} dev slates (holdout sealed)`);
  console.log('');
  console.log('VERIFICATION:');
  console.log(`  Mean frontier size: ${meanFrontierSize.toFixed(1)} lineups (mean frac of pool: ${(meanFrontierFrac*100).toFixed(2)}%)`);
  console.log(`  Slates with frontier < ${N}: ${underFillSlates}/${frontierRows.length}`);
  console.log(`  Slates with V1-PF portfolio < ${N}: ${portfolioUnderFillSlates}/${frontierRows.length}`);
  console.log(`  Mean V1 baseline lineups already on frontier: ${(meanV1Overlap*100).toFixed(2)}%`);
  console.log('');
  console.log('CONSTRUCTION (V1 vs V1-PF means):');
  console.log(`  Stack 5+:        V1 ${(mean(v1Cons.map(r=>r.pctPrimary5plus))*100).toFixed(1)}%   V1-PF ${(mean(pfCons.map(r=>r.pctPrimary5plus))*100).toFixed(1)}%`);
  console.log(`  Stack =4:        V1 ${(mean(v1Cons.map(r=>r.pctPrimary4))*100).toFixed(1)}%   V1-PF ${(mean(pfCons.map(r=>r.pctPrimary4))*100).toFixed(1)}%`);
  console.log(`  Bringback >=1:   V1 ${(mean(v1Cons.map(r=>r.pctBringback1plus))*100).toFixed(1)}%   V1-PF ${(mean(pfCons.map(r=>r.pctBringback1plus))*100).toFixed(1)}%`);
  console.log(`  HP/HO band:      V1 ${(mean(v1Cons.map(r=>r.bandHpHo))*100).toFixed(1)}%   V1-PF ${(mean(pfCons.map(r=>r.bandHpHo))*100).toFixed(1)}%`);
  console.log(`  HP/LO band:      V1 ${(mean(v1Cons.map(r=>r.bandHpLo))*100).toFixed(1)}%   V1-PF ${(mean(pfCons.map(r=>r.bandHpLo))*100).toFixed(1)}%`);
  console.log(`  LP/HO band:      V1 ${(mean(v1Cons.map(r=>r.bandLpHo))*100).toFixed(1)}%   V1-PF ${(mean(pfCons.map(r=>r.bandLpHo))*100).toFixed(1)}%`);
  console.log(`  LP/LO band:      V1 ${(mean(v1Cons.map(r=>r.bandLpLo))*100).toFixed(1)}%   V1-PF ${(mean(pfCons.map(r=>r.bandLpLo))*100).toFixed(1)}%`);
  console.log(`  Mean salary:     V1 ${mean(v1Cons.map(r=>r.meanSalary)).toFixed(0)}   V1-PF ${mean(pfCons.map(r=>r.meanSalary)).toFixed(0)}`);
  console.log(`  Mean projSum:    V1 ${mean(v1Cons.map(r=>r.meanProjSum)).toFixed(2)}   V1-PF ${mean(pfCons.map(r=>r.meanProjSum)).toFixed(2)}`);
  console.log(`  Mean ownSum:     V1 ${mean(v1Cons.map(r=>r.meanOwnSum)).toFixed(1)}   V1-PF ${mean(pfCons.map(r=>r.meanOwnSum)).toFixed(1)}`);
  console.log(`  Mean Jaccard:    V1 ${mean(v1Cons.map(r=>r.meanPairwiseJaccard)).toFixed(4)}   V1-PF ${mean(pfCons.map(r=>r.meanPairwiseJaccard)).toFixed(4)}`);
  console.log(`  Max Jaccard:     V1 ${mean(v1Cons.map(r=>r.maxPairwiseJaccard)).toFixed(4)}   V1-PF ${mean(pfCons.map(r=>r.maxPairwiseJaccard)).toFixed(4)}`);
  console.log('');
  console.log('TOURNAMENT (16 dev slates):');
  console.log(`  V1     top-1×: ${v1Top1Boot.lift.toFixed(3)} (95% CI [${v1Top1Boot.lo.toFixed(3)}, ${v1Top1Boot.hi.toFixed(3)}])  rate=${(v1Top1.rate*100).toFixed(3)}%  hits=${v1Top1.hits}/${v1Top1.lineups}`);
  console.log(`  V1-PF  top-1×: ${pfTop1Boot.lift.toFixed(3)} (95% CI [${pfTop1Boot.lo.toFixed(3)}, ${pfTop1Boot.hi.toFixed(3)}])  rate=${(pfTop1.rate*100).toFixed(3)}%  hits=${pfTop1.hits}/${pfTop1.lineups}`);
  console.log(`  V1     top-0.1×: ${v1Top01Boot.lift.toFixed(3)} (95% CI [${v1Top01Boot.lo.toFixed(3)}, ${v1Top01Boot.hi.toFixed(3)}])  rate=${(v1Top01.rate*100).toFixed(3)}%  hits=${v1Top01.hits}`);
  console.log(`  V1-PF  top-0.1×: ${pfTop01Boot.lift.toFixed(3)} (95% CI [${pfTop01Boot.lo.toFixed(3)}, ${pfTop01Boot.hi.toFixed(3)}])  rate=${(pfTop01.rate*100).toFixed(3)}%  hits=${pfTop01.hits}`);
  console.log(`  V1     ROI: ${(v1ROI*100).toFixed(1)}%`);
  console.log(`  V1-PF  ROI: ${(pfROI*100).toFixed(1)}%`);
  console.log('');
  console.log(`PER-SLATE TOP-1% (V1-PF vs V1): helped=${h1} hurt=${hu1} neutral=${n1}`);
  console.log(`PER-SLATE TOP-0.1%: helped=${h01} hurt=${hu01} neutral=${n01}`);
  console.log('');

  // Diagnostic summary.
  const meanV1OnlyDominated = mean(diagnosticRows.map((r: any) => r.v1_only_dominated));
  const meanV1OnlyFrontier = mean(diagnosticRows.map((r: any) => r.v1_only_on_frontier));
  console.log('DIAGNOSTIC (V1 lineups V1-PF rejected):');
  console.log(`  Mean V1-only dominated: ${meanV1OnlyDominated.toFixed(1)} lineups/slate`);
  console.log(`  Mean V1-only on frontier (rejected for other reasons): ${meanV1OnlyFrontier.toFixed(1)} lineups/slate`);
  console.log('');

  // Aggregate JSON.
  const aggregate = {
    methodology_locked_at: '2026-05-03',
    methodology_path: path.join(OUT_DIR, 'methodology.md'),
    bootstrap_seed: BOOTSTRAP_SEED,
    bootstrap_samples: BOOTSTRAP_SAMPLES,
    num_dev_slates: v1Slates.length,
    holdout_sealed: true,
    pre_registered_pareto: '2D on (projection_sum, ownership_sum) only',
    single_variant: true,
    v1_baseline_n: N_V1,
    v1_pf_target_n: N,
    verification: {
      mean_frontier_size: meanFrontierSize,
      mean_frontier_frac_of_pool: meanFrontierFrac,
      under_fill_75_count: underFillSlates,
      portfolio_under_fill_count: portfolioUnderFillSlates,
      mean_v1_baseline_on_frontier_pct: meanV1Overlap,
    },
    construction: {
      v1: {
        pctP5plus: mean(v1Cons.map(r => r.pctPrimary5plus)),
        pctP4: mean(v1Cons.map(r => r.pctPrimary4)),
        pctBb1: mean(v1Cons.map(r => r.pctBringback1plus)),
        pctBb2: mean(v1Cons.map(r => r.pctBringback2plus)),
        bandHpHo: mean(v1Cons.map(r => r.bandHpHo)),
        bandHpLo: mean(v1Cons.map(r => r.bandHpLo)),
        bandLpHo: mean(v1Cons.map(r => r.bandLpHo)),
        bandLpLo: mean(v1Cons.map(r => r.bandLpLo)),
        meanSalary: mean(v1Cons.map(r => r.meanSalary)),
        meanProjSum: mean(v1Cons.map(r => r.meanProjSum)),
        meanOwnSum: mean(v1Cons.map(r => r.meanOwnSum)),
        meanGeoMeanOwnHit: mean(v1Cons.map(r => r.meanGeoMeanOwnHit)),
        meanJaccard: mean(v1Cons.map(r => r.meanPairwiseJaccard)),
        maxJaccard: mean(v1Cons.map(r => r.maxPairwiseJaccard)),
      },
      pf: {
        pctP5plus: mean(pfCons.map(r => r.pctPrimary5plus)),
        pctP4: mean(pfCons.map(r => r.pctPrimary4)),
        pctBb1: mean(pfCons.map(r => r.pctBringback1plus)),
        pctBb2: mean(pfCons.map(r => r.pctBringback2plus)),
        bandHpHo: mean(pfCons.map(r => r.bandHpHo)),
        bandHpLo: mean(pfCons.map(r => r.bandHpLo)),
        bandLpHo: mean(pfCons.map(r => r.bandLpHo)),
        bandLpLo: mean(pfCons.map(r => r.bandLpLo)),
        meanSalary: mean(pfCons.map(r => r.meanSalary)),
        meanProjSum: mean(pfCons.map(r => r.meanProjSum)),
        meanOwnSum: mean(pfCons.map(r => r.meanOwnSum)),
        meanGeoMeanOwnHit: mean(pfCons.map(r => r.meanGeoMeanOwnHit)),
        meanJaccard: mean(pfCons.map(r => r.meanPairwiseJaccard)),
        maxJaccard: mean(pfCons.map(r => r.maxPairwiseJaccard)),
      },
    },
    tournament: {
      v1: { top1_lift: v1Top1Boot.lift, top1_ci: [v1Top1Boot.lo, v1Top1Boot.hi], top1_rate: v1Top1.rate, top1_hits: v1Top1.hits, top1_lineups: v1Top1.lineups, top01_lift: v1Top01Boot.lift, top01_ci: [v1Top01Boot.lo, v1Top01Boot.hi], top01_rate: v1Top01.rate, top01_hits: v1Top01.hits, roi: v1ROI },
      pf: { top1_lift: pfTop1Boot.lift, top1_ci: [pfTop1Boot.lo, pfTop1Boot.hi], top1_rate: pfTop1.rate, top1_hits: pfTop1.hits, top1_lineups: pfTop1.lineups, top01_lift: pfTop01Boot.lift, top01_ci: [pfTop01Boot.lo, pfTop01Boot.hi], top01_rate: pfTop01.rate, top01_hits: pfTop01.hits, roi: pfROI },
    },
    per_slate: {
      top1: { helped: h1, hurt: hu1, neutral: n1 },
      top01: { helped: h01, hurt: hu01, neutral: n01 },
    },
    diagnostic: {
      mean_v1_only_dominated: meanV1OnlyDominated,
      mean_v1_only_on_frontier: meanV1OnlyFrontier,
    },
  };
  fs.writeFileSync(path.join(OUT_DIR, 'aggregate.json'), JSON.stringify(aggregate, null, 2));
  console.log(`\nAggregate saved: ${path.join(OUT_DIR, 'aggregate.json')}`);
  console.log('Per-slate frontier CSV: per_slate_frontier_size.csv');
  console.log('Construction CSV: construction_comparison.csv');
  console.log('Tournament CSV: tournament_comparison.csv');
  console.log('Per-slate outcomes CSV: per_slate_outcomes.csv');
  console.log('Diagnostic CSV: filtered_lineup_diagnostics.csv');
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });
