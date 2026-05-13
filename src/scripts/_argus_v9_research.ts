/**
 * Argus-v9 research selector — 29-slate LOO backtest.
 *
 * Wires research items #1 (t-copula), #2 (var-concentration), #3 (EV-vs-field
 * via Haugh-Singal), #4 (pairwise ρ soft penalty), #7 (empirical CDF marginals
 * = gamma-like skew) into Argus selection, with GBM v3 used as field weighting
 * model.
 *
 * Per slate: load → sim (t-copula, ν=5) → score candidates × worlds → build
 * GBM-weighted field → compute EV-vs-field per candidate → greedy with ρ-soft-cap
 * + variance concentration on top-30 → output 150 lineups → score real payout.
 *
 * Aggregate output: slate-by-slate + total ROI grid.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as csvParse } from 'csv-parse/sync';
import { Lineup, Player } from '../types';
import {
  parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV,
  ContestActuals,
} from '../parser';
import { getContestConfig } from '../rules';
import { generateWorlds } from '../v35/simulation';

const DIR = 'C:/Users/colin/dfs opto';
const OUT_DIR = path.join(DIR, 'multi_combo_penalty_implementation');
const MODEL_PATH = path.join(OUT_DIR, 'argus_gbm_v3_model.json');
const N = 150;
const FEE = 20;
const SMALL = 1e-9;
const NUM_WORLDS = 1500;       // T-copula sim worlds
const NU = 5;                  // T-copula degrees of freedom
const FIELD_SIZE = 8000;       // Synthetic opponent field size
const RHO_TARGET = 0.18;
const RHO_PENALTY_LAMBDA = process.env.ARGUS_RHO_LAMBDA ? parseFloat(process.env.ARGUS_RHO_LAMBDA) : 50;
const W_MULTI_BLEND = process.env.ARGUS_W_MULTI_BLEND ? parseFloat(process.env.ARGUS_W_MULTI_BLEND) : 10;
const MAHAL_TARGET_PRO = true;
const MAHAL_PENALTY_LAMBDA = process.env.ARGUS_MAHAL_LAMBDA ? parseFloat(process.env.ARGUS_MAHAL_LAMBDA) : 5;
const MAHAL_TARGET_D = 1.3;
const W_VAR_REWARD = process.env.ARGUS_W_VAR_REWARD ? parseFloat(process.env.ARGUS_W_VAR_REWARD) : 0;  // v9-C default 0
const FIELD_MODE = process.env.ARGUS_FIELD_MODE || 'gbm';  // 'gbm' | 'uniform'
const EV_MODE = process.env.ARGUS_EV_MODE || 'sim';        // 'sim' | 'proj'
const RUN_TAG = process.env.ARGUS_RUN_TAG || 'v9c';
const PROS = [
  { label: 'nerdytenor', tokens: ['nerdytenor'] },
  { label: 'zroth', tokens: ['zroth', 'zroth2'] },
  { label: 'youdacao', tokens: ['youdacao'] },
  { label: 'shipmymoney', tokens: ['shipmymoney'] },
  { label: 'shaidyadvice', tokens: ['shaidyadvice'] },
  { label: 'bgreseth', tokens: ['bgreseth'] },
  { label: 'needlunchmoney', tokens: ['needlunchmoney'] },
];
const VAR_CONC_TIER1 = 30;     // #2 — first N picks favor variance freely
const SEED_BASE = 12345;

const SLATES = [
  { slate: '4-8-26',         proj: '4-8-26projections.csv',         actuals: '4-8-26actuals.csv',         pool: '4-8-26sspool.csv' },
  { slate: '4-12-26',        proj: '4-12-26projections.csv',        actuals: '4-12-26actuals.csv',        pool: '4-12-26sspool.csv' },
  { slate: '4-17-26',        proj: '4-17-26projections.csv',        actuals: '4-17-26actuals.csv',        pool: '4-17-26sspool.csv' },
  { slate: '4-18-26',        proj: '4-18-26projections.csv',        actuals: '4-18-26actuals.csv',        pool: '4-18-26sspool.csv' },
  { slate: '4-21-26',        proj: '4-21-26projections.csv',        actuals: '4-21-26actuals.csv',        pool: '4-21-26sspool.csv' },
  { slate: '4-22-26',        proj: '4-22-26projections.csv',        actuals: '4-22-26actuals.csv',        pool: '4-22-26sspool.csv' },
  { slate: '4-23-26',        proj: '4-23-26projections.csv',        actuals: '4-23-26actuals.csv',        pool: '4-23-26sspool.csv' },
  { slate: '4-24-26',        proj: '4-24-26projections.csv',        actuals: '4-24-26actuals.csv',        pool: '4-24-26sspool.csv' },
  { slate: '4-25-26',        proj: '4-25-26projections.csv',        actuals: '4-25-26actuals.csv',        pool: '4-25-26sspool.csv' },
  { slate: '4-25-26-early',  proj: '4-25-26projectionsearly.csv',   actuals: '4-25-26actualsearly.csv',   pool: '4-25-26sspoolearly.csv' },
  { slate: '4-26-26',        proj: '4-26-26projections.csv',        actuals: '4-26-26actuals.csv',        pool: '4-26-26sspool.csv' },
  { slate: '4-27-26',        proj: '4-27-26projections.csv',        actuals: '4-27-26actuals.csv',        pool: '4-27-26sspool.csv' },
  { slate: '4-28-26',        proj: '4-28-26projections.csv',        actuals: '4-28-26actuals.csv',        pool: '4-28-26sspool.csv' },
  { slate: '4-29-26',        proj: '4-29-26projections.csv',        actuals: '4-29-26actuals.csv',        pool: '4-29-26sspool.csv' },
  { slate: '5-2-26-main',    proj: '5-2-26projectionsmain.csv',     actuals: '5-2-26actualsmain.csv',     pool: '5-2-26sspoolmain.csv' },
  { slate: '5-3-26',         proj: '5-3-26projections.csv',         actuals: '5-3-26actuals.csv',         pool: '5-3-26sspool.csv' },
  { slate: '4-14-26',        proj: '4-14-26projections.csv',        actuals: '4-14-26actuals.csv',        pool: '4-14-26sspool.csv' },
  { slate: '4-15-26',        proj: '4-15-26projections.csv',        actuals: '4-15-26actuals.csv',        pool: '4-15-26sspool.csv' },
  { slate: '4-19-26',        proj: '4-19-26projections.csv',        actuals: '4-19-26actuals.csv',        pool: '4-19-26sspool.csv' },
  { slate: '4-20-26',        proj: '4-20-26projections.csv',        actuals: '4-20-26actuals.csv',        pool: '4-20-26sspool.csv' },
  { slate: '5-1-26',         proj: '5-1-26projections.csv',         actuals: '5-1-26actuals.csv',         pool: '5-1-26sspool.csv' },
  { slate: '5-2-26',         proj: '5-2-26projections.csv',         actuals: '5-2-26actuals.csv',         pool: '5-2-26sspool.csv' },
  { slate: '5-2-26-night',   proj: '5-2-26projectionsnight.csv',    actuals: '5-2-26actualsnight.csv',    pool: '5-2-26sspoolnight.csv' },
  { slate: '5-3-26-late',    proj: '5-3-26projectionslate.csv',     actuals: '5-3-26actualslate.csv',     pool: '5-3-26sspoollate.csv' },
  { slate: '5-4-26',         proj: '5-4-26projections.csv',         actuals: '5-4-26actuals.csv',         pool: '5-4-26sspool.csv' },
  { slate: '5-4-26-late',    proj: '5-4-26projectionslate.csv',     actuals: '5-4-26actualslate.csv',     pool: '5-4-26sspoollate.csv' },
  { slate: '5-5-26',         proj: '5-5-26projections.csv',         actuals: '5-5-26actuals.csv',         pool: '5-5-26sspool.csv' },
  { slate: '4-6-26',         proj: '4-6-26_projections.csv',        actuals: 'dkactuals 4-6-26.csv',      pool: 'sspool4-6-26.csv' },
  { slate: '5-6-26',         proj: '5-6-26projections.csv',         actuals: '5-6-26actuals.csv',         pool: '5-6-26sspool.csv' },
  // Added 2026-05-11: new slates (5-9-26 sspool is corrupt — same projections-file dup as 4-11-26).
  { slate: '5-8-26',         proj: '5-8-26projections.csv',         actuals: '5-8-26actuals.csv',         pool: '5-8-26sspool.csv' },
  { slate: '5-10-26',        proj: '5-10-26projections.csv',        actuals: '5-10-26actuals.csv',        pool: '5-10-26sspool.csv' },
  { slate: '5-10-26-late',   proj: '5-10-26projectionslate.csv',    actuals: '5-10-26actualslate.csv',    pool: '5-10-26sspoollate.csv' },
];

const TOP_K_GREEDY = 1000;     // Only consider top-K by raw EV per greedy step (5x speedup)

const ARGUS_W_MULTI = 0.0;     // POC: pure research-item EV. Set >0 to blend combo prior.

// ===== utilities =====

function isPitcher(p: Player): boolean { return (p.position || '').toUpperCase().includes('P'); }
function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function extractUser(entryName: string): string { return (entryName || '').replace(/\s*\([^)]*\)\s*$/, '').trim(); }
function mean(a: number[]): number { if (!a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; }
function stddev(a: number[]): number { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); }
function median(arr: number[]): number { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }

function loadProjFile(p: string): { adjOwn: Map<string, number>; saberTotal: Map<string, number>; saberTeam: Map<string, number>; } {
  const out = { adjOwn: new Map<string, number>(), saberTotal: new Map<string, number>(), saberTeam: new Map<string, number>() };
  if (!fs.existsSync(p)) return out;
  const records = csvParse(fs.readFileSync(p, 'utf-8'), { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
  for (const r of records) {
    const id = (r['DFS ID'] || r['ID'] || '').trim(); if (!id) continue;
    const adj = parseFloat((r['Adj Own'] || '').replace(/[%,]/g, ''));
    if (!Number.isNaN(adj)) out.adjOwn.set(id, Math.max(0, adj));
    const st = parseFloat((r['Saber Total'] || '').replace(/[%,]/g, ''));
    if (!Number.isNaN(st)) out.saberTotal.set(id, st);
    const sm = parseFloat((r['Saber Team'] || '').replace(/[%,]/g, ''));
    if (!Number.isNaN(sm)) out.saberTeam.set(id, sm);
  }
  return out;
}

function buildPayoutTable(F: number): Float64Array {
  const pool = F * FEE * 0.88; const cashLine = Math.floor(F * 0.22);
  const raw = new Float64Array(cashLine); let rawSum = 0;
  for (let r = 0; r < cashLine; r++) { raw[r] = Math.pow(r + 1, -1.15); rawSum += raw[r]; }
  const table = new Float64Array(F); const minCash = FEE * 1.2;
  for (let r = 0; r < cashLine; r++) table[r] = Math.max(minCash, (raw[r] / rawSum) * pool);
  let tSum = 0; for (let r = 0; r < cashLine; r++) tSum += table[r];
  const scale = pool / tSum; for (let r = 0; r < cashLine; r++) table[r] *= scale;
  return table;
}

// ===== GBM v3 inference (load saved model) =====

interface TreeNode { feature?: number; threshold?: number; left?: TreeNode; right?: TreeNode; leafValue?: number; }
interface GBMModel { trees: TreeNode[]; basePred: number; learningRate: number; }
interface GBMv3Saved { models: { [size: string]: GBMModel } }

function predictTree(tree: TreeNode, x: number[]): number {
  let n: TreeNode = tree;
  while (n.feature !== undefined) { if (x[n.feature] < n.threshold!) n = n.left!; else n = n.right!; }
  return n.leafValue || 0;
}
function predictGBM(model: GBMModel, x: number[]): number {
  let p = model.basePred;
  for (const tree of model.trees) p += model.learningRate * predictTree(tree, x);
  return p;
}

// ===== correlation between lineup score vectors =====

function pearson(a: Float32Array, b: Float32Array, n: number): number {
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    cov += da * db; va += da * da; vb += db * db;
  }
  const denom = Math.sqrt(va * vb);
  if (denom < 1e-12) return 0;
  return cov / denom;
}

// ===== payout schedule and rank lookup =====

function findRank(score: number, sortedDesc: Float64Array): number {
  // Binary search: number of field entries with score > query (i.e. its rank, 0-indexed).
  let lo = 0, hi = sortedDesc.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedDesc[mid] > score) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// ===== universal metrics + Mahalanobis =====

interface SlateStats {
  optimalLineupProj: number; optimalLineupCeiling: number;
  chalkAnchorOwn: number; slateAvgPlayerOwn: number;
  ownPercentileByPlayerId: Map<string, number>;
}
function computeSlateStats(players: Player[], allFieldLineups: Player[][]): SlateStats {
  let optProj = 0, optCeil = 0;
  const lineupOwnPairs: { meanOwn: number }[] = [];
  for (const lu of allFieldLineups) {
    let p = 0, c = 0, o = 0;
    for (const pl of lu) {
      p += pl.projection || 0;
      c += (pl as any).percentiles?.p75 || (pl.projection || 0) * 1.15;
      o += pl.ownership || 0;
    }
    if (p > optProj) optProj = p;
    if (c > optCeil) optCeil = c;
    lineupOwnPairs.push({ meanOwn: o / lu.length });
  }
  lineupOwnPairs.sort((a, b) => b.meanOwn - a.meanOwn);
  const topN = Math.min(100, lineupOwnPairs.length);
  const chalkAnchor = topN > 0 ? mean(lineupOwnPairs.slice(0, topN).map(x => x.meanOwn)) : 0;
  const slateAvg = mean(players.map(p => p.ownership || 0));
  const ownPctile = new Map<string, number>();
  const sortedByOwn = [...players].sort((a, b) => (a.ownership || 0) - (b.ownership || 0));
  for (let i = 0; i < sortedByOwn.length; i++) {
    ownPctile.set(sortedByOwn[i].id, sortedByOwn.length > 1 ? i / (sortedByOwn.length - 1) : 0);
  }
  return { optimalLineupProj: optProj, optimalLineupCeiling: optCeil, chalkAnchorOwn: chalkAnchor, slateAvgPlayerOwn: slateAvg, ownPercentileByPlayerId: ownPctile };
}

interface UniversalMetrics { projRatioToOptimal: number; ceilingRatioToOptimal: number; avgPlayerOwnPctile: number; ownStdRatio: number; ownDeltaFromAnchor: number; }
function computeUniversal(lineups: Player[][], stats: SlateStats): UniversalMetrics {
  if (!lineups.length) return { projRatioToOptimal: 0, ceilingRatioToOptimal: 0, avgPlayerOwnPctile: 0, ownStdRatio: 0, ownDeltaFromAnchor: 0 };
  const luProjs: number[] = [], luCeils: number[] = [], luOwns: number[] = [], luOwnStds: number[] = [], pctileSums: number[] = [];
  for (const players of lineups) {
    const owns = players.map(p => p.ownership || 0);
    luOwns.push(mean(owns));
    luProjs.push(players.reduce((s, p) => s + (p.projection || 0), 0));
    luCeils.push(players.reduce((s, p) => s + ((p as any).percentiles?.p75 || (p.projection || 0) * 1.15), 0));
    luOwnStds.push(stddev(owns));
    let pSum = 0; for (const p of players) pSum += stats.ownPercentileByPlayerId.get(p.id) || 0;
    pctileSums.push(pSum / players.length);
  }
  return {
    projRatioToOptimal: stats.optimalLineupProj > 0 ? mean(luProjs) / stats.optimalLineupProj : 0,
    ceilingRatioToOptimal: stats.optimalLineupCeiling > 0 ? mean(luCeils) / stats.optimalLineupCeiling : 0,
    avgPlayerOwnPctile: mean(pctileSums),
    ownStdRatio: stats.slateAvgPlayerOwn > 0 ? mean(luOwnStds) / stats.slateAvgPlayerOwn : 0,
    ownDeltaFromAnchor: mean(luOwns) - stats.chalkAnchorOwn,
  };
}

// Mahalanobis to pro-consensus (5 universal metrics)
const PRO_CONSENSUS = {
  mean: { projRatioToOptimal: 0.88, ceilingRatioToOptimal: 0.92, avgPlayerOwnPctile: 0.94, ownStdRatio: 7.1, ownDeltaFromAnchor: -7.2 },
  std:  { projRatioToOptimal: 0.088, ceilingRatioToOptimal: 0.092, avgPlayerOwnPctile: 0.094, ownStdRatio: 0.71, ownDeltaFromAnchor: 0.72 },
};
function mahalanobisToPros(m: UniversalMetrics): number {
  const keys: (keyof UniversalMetrics)[] = ['projRatioToOptimal', 'ceilingRatioToOptimal', 'avgPlayerOwnPctile', 'ownStdRatio', 'ownDeltaFromAnchor'];
  let s2 = 0;
  for (const k of keys) {
    const dz = (m[k] - PRO_CONSENSUS.mean[k]) / PRO_CONSENSUS.std[k];
    s2 += dz * dz;
  }
  return Math.sqrt(s2 / keys.length);
}

// ===== payout against actual contest =====

function scorePayout(selected: Lineup[], actualsObj: ContestActuals): { totalPayout: number; t1: number; topRank: number; meanActual: number; maxActual: number; } {
  const F = actualsObj.entries.length;
  const sortedPts = actualsObj.entries.map(e => e.actualPoints).sort((a, b) => b - a);
  const top1T = sortedPts[Math.max(0, Math.floor(F * 0.01) - 1)] || 0;
  const payTable = buildPayoutTable(F);
  let total = 0; let t1 = 0; const acts: number[] = []; let topRank = F;
  for (const lu of selected) {
    let pts = 0; let miss = false;
    for (const p of lu.players) {
      const r = actualsObj.playerActualsByName.get(norm(p.name));
      if (!r) { miss = true; break; }
      pts += r.fpts;
    }
    if (miss) continue;
    acts.push(pts);
    if (pts >= top1T) t1++;
    let lo = 0, hi = sortedPts.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (sortedPts[mid] >= pts) lo = mid + 1; else hi = mid; }
    const rank = Math.max(1, lo);
    if (rank < topRank) topRank = rank;
    if (rank <= payTable.length) {
      const payout = payTable[rank - 1];
      let coWin = 0;
      for (const e of actualsObj.entries) if (Math.abs(e.actualPoints - pts) <= 0.25) coWin++;
      coWin = Math.max(0, coWin - 1);
      total += payout / Math.sqrt(1 + coWin * 0.5);
    }
  }
  return { totalPayout: total, t1, topRank, meanActual: mean(acts), maxActual: acts.length ? Math.max(...acts) : 0 };
}

// ===== main =====

interface SlateResult {
  slate: string;
  P: number; F: number;
  selected: number;
  avgProj: number; avgOwn: number;
  avgRho: number; maxRho: number;
  mahal: number;
  payout: number; t1: number; topRank: number; cost: number; roi: number;
  meanActual: number; maxActual: number;
}

async function runSlate(s: typeof SLATES[0], gbmSaved: GBMv3Saved): Promise<SlateResult | null> {
  const projPath = path.join(DIR, s.proj);
  const actualsPath = path.join(DIR, s.actuals);
  const poolPath = path.join(DIR, s.pool);
  if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) {
    console.log(`  ${s.slate}: missing files, skip`);
    return null;
  }
  const pr = parseCSVFile(projPath, 'mlb', true);
  const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
  const pool = buildPlayerPool(pr.players, pr.detectedContestType);
  const actuals = parseContestActuals(actualsPath, config);
  const projData = loadProjFile(projPath);

  const idMap = new Map<string, Player>(); const nameMap = new Map<string, Player>();
  for (const p of pool.players) {
    idMap.set(p.id, p); nameMap.set(norm(p.name), p);
    const adj = projData.adjOwn.get(p.id);
    p.ownership = (adj !== undefined ? adj : (p.ownership || 0));
  }
  const players = pool.players;

  // Pool of candidate lineups.
  let loaded;
  try {
    loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
  } catch (e: any) {
    console.log(`  ${s.slate}: pool load failed (${e?.message || e}), skip`);
    return null;
  }
  const candidates = Array.from(new Map(loaded.lineups.map(l => [l.hash, l])).values());
  const P = candidates.length;
  if (P < 100 || actuals.entries.length < 100) {
    console.log(`  ${s.slate}: P=${P} F=${actuals.entries.length} too small, skip`);
    return null;
  }

  // Score each actual entry by summing player actualPoints (from projections file's "Actual" col).
  // The parser populates p.actualPoints if the projection CSV has actual columns.
  // For payout, we need entry actual scores.
  const fieldLineups: Player[][] = [];
  for (const e of actuals.entries) {
    const pls: Player[] = [];
    let ok = true;
    for (const nm of e.playerNames) {
      const pl = nameMap.get(norm(nm)); if (!pl) { ok = false; break; }
      pls.push(pl);
    }
    if (ok) fieldLineups.push(pls);
  }
  const F = fieldLineups.length;

  // ===== PRO TARGET: median-pro universal metrics for this slate =====
  // For each pro on this slate, compute their universal-metric vector; take median across pros.
  const slateStats = computeSlateStats(players, fieldLineups);
  let proMedianMetrics: UniversalMetrics | null = null;
  if (MAHAL_TARGET_PRO) {
    const proMetrics: UniversalMetrics[] = [];
    const byUser = new Map<string, typeof actuals.entries>();
    for (const e of actuals.entries) {
      const u = extractUser(e.entryName);
      const arr = byUser.get(u); if (arr) arr.push(e); else byUser.set(u, [e]);
    }
    for (const pro of PROS) {
      let matched: typeof actuals.entries = [];
      for (const [u, ents] of byUser) {
        if (pro.tokens.some(t => u.toLowerCase().includes(t))) matched = matched.concat(ents);
      }
      if (matched.length < 100) continue;
      const proLus: Player[][] = [];
      for (const e of matched.slice(0, 150)) {
        const pls: Player[] = []; let ok = true;
        for (const nm of e.playerNames) { const pl = nameMap.get(norm(nm)); if (!pl) { ok = false; break; } pls.push(pl); }
        if (ok) proLus.push(pls);
      }
      if (proLus.length < 100) continue;
      proMetrics.push(computeUniversal(proLus, slateStats));
    }
    if (proMetrics.length >= 3) {
      // Take median across pros.
      const med = (k: keyof UniversalMetrics) => median(proMetrics.map(m => m[k]));
      proMedianMetrics = {
        projRatioToOptimal: med('projRatioToOptimal'),
        ceilingRatioToOptimal: med('ceilingRatioToOptimal'),
        avgPlayerOwnPctile: med('avgPlayerOwnPctile'),
        ownStdRatio: med('ownStdRatio'),
        ownDeltaFromAnchor: med('ownDeltaFromAnchor'),
      };
    }
  }

  // ===== STEP 1: T-copula sim =====
  const t1 = Date.now();
  const sim = generateWorlds(players, NUM_WORLDS, NU, SEED_BASE);

  // Build player index map for fast lookup.
  const playerIdx = new Map<string, number>();
  for (let i = 0; i < players.length; i++) playerIdx.set(players[i].id, i);

  // ===== STEP 2: Score every candidate × world =====
  const t2 = Date.now();
  const candScores = new Float32Array(P * NUM_WORLDS);
  for (let c = 0; c < P; c++) {
    const lu = candidates[c];
    const idxs: number[] = [];
    for (const p of lu.players) {
      const i = playerIdx.get(p.id);
      if (i !== undefined) idxs.push(i);
    }
    for (let w = 0; w < NUM_WORLDS; w++) {
      let s = 0;
      for (const i of idxs) s += sim.scores[i * NUM_WORLDS + w];
      candScores[c * NUM_WORLDS + w] = s;
    }
  }

  // ===== STEP 3: Build field — sample FIELD_SIZE from candidate pool, GBM-weighted =====
  const t3 = Date.now();

  // Compute per-candidate "chalkiness score" via GBM v3 prediction on its top combos.
  // Simplified: for each lineup, sum log(GBM-predicted-freq) across all 2-3 combos.
  function computeFeatures(ids: string[], poolFreq: number): number[] {
    let ownProd = 1, projSum = 0, salSum = 0, gameTotalSum = 0, saberTeamSum = 0;
    let ownPctileSum = 0, projPctileSum = 0;
    const teamCounts = new Map<string, number>();
    for (const id of ids) {
      const pl = idMap.get(id); if (!pl) continue;
      ownProd *= ((pl.ownership || 0) / 100);
      projSum += pl.projection || 0;
      salSum += pl.salary || 0;
      gameTotalSum += projData.saberTotal.get(id) || 0;
      saberTeamSum += projData.saberTeam.get(id) || 0;
      const t = (pl.team || '').toUpperCase();
      teamCounts.set(t, (teamCounts.get(t) || 0) + 1);
    }
    let maxTeam = 0; for (const v of teamCounts.values()) if (v > maxTeam) maxTeam = v;
    const sameTeam = maxTeam === ids.length;
    const salaryEff = salSum > 0 ? projSum / (salSum / 1000) : 0;
    return [
      Math.log(Math.max(SMALL, poolFreq)),
      Math.log(Math.max(SMALL, ownProd)),
      sameTeam ? 1 : 0,
      Math.log(Math.max(SMALL, projSum)),
      Math.log(Math.max(SMALL, salSum)),
      Math.log(Math.max(SMALL, gameTotalSum)),
      Math.log(Math.max(SMALL, saberTeamSum)),
      ownPctileSum,
      projPctileSum,
      salaryEff,
      teamCounts.size,
    ];
  }

  // Pool-2 frequency lookup (for feature 0 at predict time).
  const pairCount = new Map<string, number>();
  for (const lu of candidates) {
    const ids = lu.players.map(p => p.id).sort();
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const k = ids[i] + '|' + ids[j];
      pairCount.set(k, (pairCount.get(k) || 0) + 1);
    }
  }

  // Per-lineup chalkiness score: sum log GBM-predicted residual on its 2-pair combos.
  const chalkScore = new Float32Array(P);
  const gbm2 = (gbmSaved.models as any)['2'];
  for (let c = 0; c < P; c++) {
    const ids = candidates[c].players.map(p => p.id).sort();
    let s = 0; let n = 0;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const k = ids[i] + '|' + ids[j];
      const poolFreq = (pairCount.get(k) || 0) / P;
      const x = computeFeatures([ids[i], ids[j]], poolFreq);
      s += predictGBM(gbm2, x); n++;
    }
    chalkScore[c] = n > 0 ? s / n : 0;
  }

  // Build field — gbm-weighted (chalk-aware, default) or uniform (ablation).
  const weights = new Float64Array(P);
  if (FIELD_MODE === 'gbm') {
    let wMax = -Infinity;
    for (let c = 0; c < P; c++) if (chalkScore[c] > wMax) wMax = chalkScore[c];
    let wSum = 0;
    for (let c = 0; c < P; c++) { weights[c] = Math.exp(chalkScore[c] - wMax); wSum += weights[c]; }
    for (let c = 0; c < P; c++) weights[c] /= wSum;
  } else {
    // uniform
    for (let c = 0; c < P; c++) weights[c] = 1 / P;
  }
  const cum = new Float64Array(P);
  let acc = 0;
  for (let c = 0; c < P; c++) { acc += weights[c]; cum[c] = acc; }
  // Sample FIELD_SIZE indices.
  let rngS = SEED_BASE * 7 + 1;
  function rng(): number { rngS = (rngS * 1664525 + 1013904223) >>> 0; return rngS / 0x100000000; }
  const fieldIndices = new Int32Array(FIELD_SIZE);
  for (let f = 0; f < FIELD_SIZE; f++) {
    const u = rng();
    let lo = 0, hi = P - 1;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (cum[mid] < u) lo = mid + 1; else hi = mid; }
    fieldIndices[f] = lo;
  }

  // Field score per world: sum of sampled candidates' scores per world, sorted desc.
  const fieldSortedPerWorld: Float64Array[] = new Array(NUM_WORLDS);
  for (let w = 0; w < NUM_WORLDS; w++) {
    const fs2 = new Float64Array(FIELD_SIZE);
    for (let f = 0; f < FIELD_SIZE; f++) fs2[f] = candScores[fieldIndices[f] * NUM_WORLDS + w];
    fs2.sort();
    // Reverse to descending.
    for (let i = 0, j = fs2.length - 1; i < j; i++, j--) {
      const tmp = fs2[i]; fs2[i] = fs2[j]; fs2[j] = tmp;
    }
    fieldSortedPerWorld[w] = fs2;
  }
  const payTable = buildPayoutTable(FIELD_SIZE);

  // ===== STEP 4: Per-candidate EV — sim (vs field) or proj (raw projection) =====
  const t4 = Date.now();
  const candEV = new Float64Array(P);
  if (EV_MODE === 'sim') {
    for (let c = 0; c < P; c++) {
      let total = 0;
      for (let w = 0; w < NUM_WORLDS; w++) {
        const score = candScores[c * NUM_WORLDS + w];
        const rank = findRank(score, fieldSortedPerWorld[w]);
        if (rank < payTable.length) total += payTable[rank];
      }
      candEV[c] = total / NUM_WORLDS;
    }
  } else {
    // Projection-EV ablation: scale projection so range is comparable to sim EV (~$0-100).
    let maxProj = 0; for (let c = 0; c < P; c++) if (candidates[c].projection > maxProj) maxProj = candidates[c].projection;
    for (let c = 0; c < P; c++) candEV[c] = (candidates[c].projection / Math.max(1, maxProj)) * 100;
  }

  // Top-K candidates by EV (greedy considers only these for speed).
  const evRankIdx = Array.from({ length: P }, (_, i) => i).sort((a, b) => candEV[b] - candEV[a]);
  const greedyPool = new Int32Array(evRankIdx.slice(0, Math.min(TOP_K_GREEDY, P)));

  // v9-B: chalk-rank percentile (Argus combo-prior). Higher = chalkier lineup.
  // chalkScore was computed in step 3 — higher = predicted to be more represented in field.
  const chalkRank = new Float64Array(P);
  {
    const idx = Array.from({ length: P }, (_, i) => i).sort((a, b) => chalkScore[a] - chalkScore[b]);
    for (let r = 0; r < P; r++) chalkRank[idx[r]] = P > 1 ? r / (P - 1) : 0;
  }

  // v9-C: pre-compute each candidate's contributions to the 5 universal metrics.
  // Maintain running portfolio sums so we can compute marginal Mahalanobis cheaply.
  const candProjLU = new Float32Array(P);
  const candCeilLU = new Float32Array(P);
  const candOwnLU = new Float32Array(P);
  const candOwnStdLU = new Float32Array(P);
  const candPctileSumLU = new Float32Array(P);
  for (let c = 0; c < P; c++) {
    const pls = candidates[c].players;
    const owns = pls.map(p => p.ownership || 0);
    candProjLU[c] = pls.reduce((s, p) => s + (p.projection || 0), 0);
    candCeilLU[c] = pls.reduce((s, p) => s + ((p as any).percentiles?.p75 || (p.projection || 0) * 1.15), 0);
    candOwnLU[c] = owns.length > 0 ? owns.reduce((s, v) => s + v, 0) / owns.length : 0;
    const m = candOwnLU[c];
    candOwnStdLU[c] = owns.length > 1 ? Math.sqrt(owns.reduce((s, v) => s + (v - m) ** 2, 0) / owns.length) : 0;
    let psum = 0;
    for (const p of pls) psum += slateStats.ownPercentileByPlayerId.get(p.id) || 0;
    candPctileSumLU[c] = pls.length > 0 ? psum / pls.length : 0;
  }

  // ===== STEP 5: Greedy selection with ρ-cap and variance concentration =====
  const t5 = Date.now();

  // Pre-compute candidate variance (across worlds) for #2 var concentration.
  const candVar = new Float64Array(P);
  for (let c = 0; c < P; c++) {
    let s = 0, s2 = 0;
    for (let w = 0; w < NUM_WORLDS; w++) {
      const v = candScores[c * NUM_WORLDS + w]; s += v; s2 += v * v;
    }
    const m = s / NUM_WORLDS;
    candVar[c] = (s2 / NUM_WORLDS) - m * m;
  }
  // Variance percentile.
  const varRank = new Float64Array(P);
  {
    const idx = Array.from({ length: P }, (_, i) => i).sort((a, b) => candVar[a] - candVar[b]);
    for (let r = 0; r < P; r++) varRank[idx[r]] = P > 1 ? r / (P - 1) : 0;
  }

  // Selection state.
  const selected: number[] = [];
  const selectedSet = new Set<number>();
  const exposureCount = new Map<string, number>();
  const teamStackCount = new Map<string, number>();
  const MAX_EXPOSURE_PCT = 0.40;
  const MAX_PITCHER_EXP = 0.45;
  const MAX_TEAM_STACK_PCT = 0.20;

  // Running portfolio sums (v9-C — for marginal Mahalanobis to median pro).
  let runProj = 0, runCeil = 0, runOwn = 0, runOwnStd = 0, runPctileSum = 0;

  // Helper to compute Mahalanobis given current running + candidate's contribution.
  function marginalMahal(c: number, nNew: number): number {
    if (!proMedianMetrics) return 0;
    const nP = nNew;
    const projRatio = (runProj + candProjLU[c]) / nP / (slateStats.optimalLineupProj || 1);
    const ceilRatio = (runCeil + candCeilLU[c]) / nP / (slateStats.optimalLineupCeiling || 1);
    const pctileSum = (runPctileSum + candPctileSumLU[c]) / nP;
    const ownStd = (runOwnStd + candOwnStdLU[c]) / nP / (slateStats.slateAvgPlayerOwn || 1);
    const ownDelta = (runOwn + candOwnLU[c]) / nP - slateStats.chalkAnchorOwn;
    let d2 = 0;
    d2 += ((projRatio - proMedianMetrics.projRatioToOptimal) / 0.088) ** 2;
    d2 += ((ceilRatio - proMedianMetrics.ceilingRatioToOptimal) / 0.092) ** 2;
    d2 += ((pctileSum - proMedianMetrics.avgPlayerOwnPctile) / 0.094) ** 2;
    d2 += ((ownStd - proMedianMetrics.ownStdRatio) / 0.71) ** 2;
    d2 += ((ownDelta - proMedianMetrics.ownDeltaFromAnchor) / 0.72) ** 2;
    return Math.sqrt(d2 / 5);
  }

  // Helper: ρ between candidate and a selected lineup (using full NUM_WORLDS).
  const candVec = (c: number) => {
    const off = c * NUM_WORLDS;
    return candScores.subarray(off, off + NUM_WORLDS);
  };

  for (let step = 0; step < N; step++) {
    let bestIdx = -1; let bestScore = -Infinity;

    // v9-C: var concentration DROPPED — pros build uniform portfolios (deconstruction #2).

    for (let gi = 0; gi < greedyPool.length; gi++) {
      const c = greedyPool[gi];
      if (selectedSet.has(c)) continue;

      // Hard caps.
      const lu = candidates[c];
      let okExp = true;
      for (const p of lu.players) {
        const cap = isPitcher(p) ? MAX_PITCHER_EXP : MAX_EXPOSURE_PCT;
        const cnt = exposureCount.get(p.id) || 0;
        if (cnt >= Math.ceil(cap * N)) { okExp = false; break; }
      }
      if (!okExp) continue;

      // Team stack cap.
      const teamCounts = new Map<string, number>();
      for (const p of lu.players) {
        if (isPitcher(p)) continue;
        const t = (p.team || '').toUpperCase();
        teamCounts.set(t, (teamCounts.get(t) || 0) + 1);
      }
      let stackOk = true;
      for (const [t, cnt] of teamCounts) {
        if (cnt >= 4 && (teamStackCount.get(t) || 0) >= Math.ceil(MAX_TEAM_STACK_PCT * N)) { stackOk = false; break; }
      }
      if (!stackOk) continue;

      // ρ as a SOFT penalty: avg ρ to already-selected, penalize excess above RHO_TARGET.
      let rhoSum2 = 0;
      const cVec = candVec(c);
      for (const sIdx of selected) rhoSum2 += pearson(cVec, candVec(sIdx), NUM_WORLDS);
      const avgRho = selected.length > 0 ? rhoSum2 / selected.length : 0;
      const rhoExcess = Math.max(0, avgRho - RHO_TARGET);

      // v9-C: marginal Mahalanobis to MEDIAN pro after adding this candidate.
      let mahalPenalty = 0;
      if (proMedianMetrics) {
        const newMahal = marginalMahal(c, selected.length + 1);
        mahalPenalty = MAHAL_PENALTY_LAMBDA * Math.max(0, newMahal - MAHAL_TARGET_D);
      }

      // Compose score: EV-vs-field − ρ penalty − chalk penalty − Mahal penalty + variance reward.
      const score = candEV[c]
        - RHO_PENALTY_LAMBDA * rhoExcess
        - W_MULTI_BLEND * chalkRank[c]
        - mahalPenalty
        + W_VAR_REWARD * varRank[c];
      if (score > bestScore) { bestScore = score; bestIdx = c; }
    }

    if (bestIdx === -1) { console.log(`  step ${step + 1}: no eligible candidate (ρ-cap or exposure)`); break; }

    selected.push(bestIdx);
    selectedSet.add(bestIdx);
    const lu = candidates[bestIdx];
    runProj += candProjLU[bestIdx]; runCeil += candCeilLU[bestIdx];
    runOwn += candOwnLU[bestIdx]; runOwnStd += candOwnStdLU[bestIdx];
    runPctileSum += candPctileSumLU[bestIdx];
    for (const p of lu.players) exposureCount.set(p.id, (exposureCount.get(p.id) || 0) + 1);
    const teamCounts = new Map<string, number>();
    for (const p of lu.players) {
      if (isPitcher(p)) continue;
      const t = (p.team || '').toUpperCase();
      teamCounts.set(t, (teamCounts.get(t) || 0) + 1);
    }
    for (const [t, cnt] of teamCounts) if (cnt >= 4) teamStackCount.set(t, (teamStackCount.get(t) || 0) + 1);

  }

  // ===== STEP 6: Diagnostics =====
  const selLineups = selected.map(c => candidates[c]);
  const selPlayers = selLineups.map(l => l.players);

  // Avg pairwise ρ.
  let rhoSum = 0, rhoCount = 0; let rhoMax = -Infinity;
  for (let i = 0; i < selected.length; i++) for (let j = i + 1; j < selected.length; j++) {
    const r = pearson(candVec(selected[i]), candVec(selected[j]), NUM_WORLDS);
    rhoSum += r; rhoCount++; if (r > rhoMax) rhoMax = r;
  }
  const rhoAvg = rhoCount ? rhoSum / rhoCount : 0;

  const um = computeUniversal(selPlayers, slateStats);
  const mahal = proMedianMetrics
    ? Math.sqrt([
        ((um.projRatioToOptimal - proMedianMetrics.projRatioToOptimal) / 0.088) ** 2,
        ((um.ceilingRatioToOptimal - proMedianMetrics.ceilingRatioToOptimal) / 0.092) ** 2,
        ((um.avgPlayerOwnPctile - proMedianMetrics.avgPlayerOwnPctile) / 0.094) ** 2,
        ((um.ownStdRatio - proMedianMetrics.ownStdRatio) / 0.71) ** 2,
        ((um.ownDeltaFromAnchor - proMedianMetrics.ownDeltaFromAnchor) / 0.72) ** 2,
      ].reduce((s, v) => s + v, 0) / 5)
    : mahalanobisToPros(um);

  const avgProj = mean(selLineups.map(l => l.projection));
  const avgOwn = mean(selLineups.map(l => l.players.reduce((s, p) => s + (p.ownership || 0), 0) / l.players.length));
  const avgVar = mean(selected.map(c => candVar[c]));
  const portfolioEV = mean(selected.map(c => candEV[c]));

  // Real-payout backtest using the actual contest entries.
  const realPayout = scorePayout(selLineups, actuals);

  const cost = selected.length * FEE;
  const roi = cost > 0 ? ((realPayout.totalPayout / cost) - 1) * 100 : 0;

  const totalSec = ((Date.now() - t1) / 1000).toFixed(0);
  console.log(`  ${s.slate.padEnd(15)} P=${P} F=${F} sel=${selected.length} | sim ${((Date.now() - t1) / 1000).toFixed(0)}s greedy ${((Date.now() - t5) / 1000).toFixed(0)}s | EV=$${portfolioEV.toFixed(0)} ρ=${rhoAvg.toFixed(2)} mahal=${mahal.toFixed(2)} | pay=$${realPayout.totalPayout.toFixed(0)} t1=${realPayout.t1} ROI=${roi.toFixed(0)}% (${totalSec}s total)`);

  // Save per-slate selected lineups (player names) for downstream analysis.
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const dumpPath = path.join(OUT_DIR, `argus_${RUN_TAG}_lineups_${s.slate}.csv`);
  const dumpLines = ['rank,proj,own,ev,variance,players'];
  for (let i = 0; i < selected.length; i++) {
    const c = selected[i];
    const lu = candidates[c];
    const own = lu.players.reduce((s, p) => s + (p.ownership || 0), 0) / lu.players.length;
    dumpLines.push([i + 1, lu.projection.toFixed(2), own.toFixed(2), candEV[c].toFixed(2), candVar[c].toFixed(1), `"${lu.players.map(p => p.name).join('|')}"`].join(','));
  }
  fs.writeFileSync(dumpPath, dumpLines.join('\n'));

  return {
    slate: s.slate,
    P, F, selected: selected.length,
    avgProj, avgOwn, avgRho: rhoAvg, maxRho: rhoMax,
    mahal,
    payout: realPayout.totalPayout, t1: realPayout.t1, topRank: realPayout.topRank,
    cost, roi,
    meanActual: realPayout.meanActual, maxActual: realPayout.maxActual,
  };
}

async function main() {
  console.log('================================================================');
  console.log('Argus-v9 RESEARCH SELECTOR — 29-slate LOO backtest');
  console.log('================================================================');
  console.log(`[${RUN_TAG}] EV=${EV_MODE} field=${FIELD_MODE} | ρ_λ=${RHO_PENALTY_LAMBDA} | combo_W=${W_MULTI_BLEND} | mahal_λ=${MAHAL_PENALTY_LAMBDA} | var_W=${W_VAR_REWARD}`);
  console.log(`Sim: ${NUM_WORLDS} worlds, field=${FIELD_SIZE}, target=${N}, top-K greedy=${TOP_K_GREEDY}\n`);

  if (!fs.existsSync(MODEL_PATH)) { console.error(`Missing GBM v3: ${MODEL_PATH}`); process.exit(1); }
  const gbmSaved: GBMv3Saved = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf-8'));
  console.log(`Loaded GBM v3: sizes ${Object.keys(gbmSaved.models).join(',')}\n`);

  const results: SlateResult[] = [];
  for (let i = 0; i < SLATES.length; i++) {
    console.log(`[${i + 1}/${SLATES.length}] ${SLATES[i].slate}`);
    const r = await runSlate(SLATES[i], gbmSaved);
    if (r) results.push(r);
  }

  // Aggregate.
  console.log('\n================================================================');
  console.log('AGGREGATE — Argus-v9 across all slates');
  console.log('================================================================');
  const totalCost = results.reduce((s, r) => s + r.cost, 0);
  const totalPay = results.reduce((s, r) => s + r.payout, 0);
  const aggROI = totalCost > 0 ? ((totalPay / totalCost) - 1) * 100 : 0;
  const profitable = results.filter(r => r.roi > 0).length;
  const meanMahal = mean(results.map(r => r.mahal));
  const meanRho = mean(results.map(r => r.avgRho));

  console.log(`Slates: ${results.length}`);
  console.log(`Total cost:   $${totalCost}`);
  console.log(`Total payout: $${totalPay.toFixed(0)}`);
  console.log(`Aggregate ROI: ${aggROI.toFixed(2)}%`);
  console.log(`Profitable slates: ${profitable}/${results.length}`);
  console.log(`Median Mahalanobis: ${median(results.map(r => r.mahal)).toFixed(3)}`);
  console.log(`Mean avg-ρ: ${meanRho.toFixed(3)}`);

  // Per-slate table.
  console.log('\nPer-slate breakdown:');
  console.log('slate            P    F      sel  EV    avgρ  mahal  payout   t1  ROI%');
  for (const r of results) {
    console.log(`${r.slate.padEnd(15)} ${String(r.P).padStart(4)} ${String(r.F).padStart(6)} ${String(r.selected).padStart(4)}  ${r.avgProj.toFixed(0).padStart(3)}  ${r.avgRho.toFixed(2)}  ${r.mahal.toFixed(2)}  $${r.payout.toFixed(0).padStart(7)} ${String(r.t1).padStart(3)}  ${r.roi.toFixed(0).padStart(5)}`);
  }

  // Save CSV.
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `argus_${RUN_TAG}_29slate_loo.csv`);
  const headers = ['slate', 'P', 'F', 'selected', 'avgProj', 'avgOwn', 'avgRho', 'maxRho', 'mahal', 'payout', 't1', 'topRank', 'cost', 'roi', 'meanActual', 'maxActual'];
  const lines = [headers.join(',')];
  for (const r of results) {
    lines.push([r.slate, r.P, r.F, r.selected, r.avgProj.toFixed(2), r.avgOwn.toFixed(2), r.avgRho.toFixed(3), r.maxRho.toFixed(3), r.mahal.toFixed(3), r.payout.toFixed(2), r.t1, r.topRank, r.cost, r.roi.toFixed(2), r.meanActual.toFixed(2), r.maxActual.toFixed(2)].join(','));
  }
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`\nSaved: ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
