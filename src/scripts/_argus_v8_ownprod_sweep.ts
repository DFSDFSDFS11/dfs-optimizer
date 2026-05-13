/**
 * Argus-v6 LOO validation: GBM-v2-predicted field freqs replace pool-count.
 *
 * GBM v2 = 11 features (log_pool, log_own, sameTeam, log_proj, log_sal,
 * log_gameTotalSum, log_saberTeamSum, ownPctileSum, projPctileSum,
 * salaryEff, numUniqueTeams) + deeper trees (depth 6, 300 trees, lr 0.03).
 *
 * For each held-out slate i:
 *   1. Train GBM v2 on the other 15 slates.
 *   2. For every combo in slate i's candidate pool, predict freq via GBM v2.
 *   3. Run Argus selection with GBM v2 predictions as field-freq input.
 *   4. Score Mahalanobis to pro consensus + real DK GPP payout ROI.
 *
 * Compare Argus-v6 vs Argus-v4 (pool-count) on same held-out slates.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as csvParse } from 'csv-parse/sync';
import { Lineup, Player } from '../types';
import {
  parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV,
  ContestActuals, ContestEntry,
} from '../parser';
import { getContestConfig } from '../rules';

const DIR = 'C:/Users/colin/dfs opto';
const OUT_DIR = path.join(DIR, 'multi_combo_penalty_implementation');
const N = 150;
const FEE = 20;
const SMALL = 1e-9;

const SLATES = [
  // Original 16 dev slates.
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
  // Holdout-or-extra slates added 2026-05-08.
  // 4-11-26 sspool is corrupted (projections file content) — skip.
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
  // Added 2026-05-08: 3 more slates with valid pool files.
  { slate: '4-6-26',         proj: '4-6-26_projections.csv',        actuals: 'dkactuals 4-6-26.csv',      pool: 'sspool4-6-26.csv' },
  { slate: '5-5-26-night',   proj: '5-5-26projections.csv',         actuals: '5-5-26actualsnight.csv',    pool: '5-5-26sspoolnight.csv' },
  { slate: '5-6-26',         proj: '5-6-26projections.csv',         actuals: '5-6-26actuals.csv',         pool: '5-6-26sspool.csv' },
];

const ARGUS = {
  STACK_BONUS_PER_HITTER: 0, BRINGBACK_1: 0, BRINGBACK_2: 0,
  PITCHER_VS_HITTER_PENALTY: -0.10, MIN_PRIMARY_STACK: 4,
  W_PROJ: 1.0, W_LEV: 0.30, W_VAR: 0.15, W_CMB: 0.25, W_MULTI: 0.20,
  EXPOSURE_CAP_HITTER: 0.25, EXPOSURE_CAP_PITCHER: 0.45, TEAM_STACK_CAP: 0.20,
  BAND_HIGH_PCT: 0.20, BAND_LOW_PCT: 0.20, MAX_PAIRWISE_OVERLAP: 6,
  TRIPLE_FREQ_CAP: 5,
  PPD_LINEUP_PENALTY: 0.10, PPD_LINEUP_TOP_PCT: 0.10,
  TOP_K: 5, LOG_EPSILON: 1e-12,
};

const GBM = { N_TREES: 300, MAX_DEPTH: 6, LEARNING_RATE: 0.03, MIN_LEAF: 200, N_BINS: 32, L2_LAMBDA: 1.0 };
const TRAIN_CAP = 100_000;
const PER_SLATE_CAP = 30_000;  // memory cap per (slate, size) — keeps total memory linear in slate count
const MIN_ACTUAL = 2;
const FEATURE_NAMES = [
  'log_pool', 'log_own', 'sameTeam', 'log_proj', 'log_sal',
  'log_gameTotalSum', 'log_saberTeamSum', 'ownPctileSum', 'projPctileSum',
  'salaryEff', 'numUniqueTeams'
] as const;
const N_FEATURES = FEATURE_NAMES.length;

const UNIVERSAL_METRICS = ['projRatioToOptimal', 'ceilingRatioToOptimal', 'avgPlayerOwnPctile', 'ownStdRatio', 'ownDeltaFromAnchor'] as const;

// ===== utilities =====

function isPitcher(p: Player): boolean { return (p.position || '').toUpperCase().includes('P'); }
function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function extractUser(entryName: string): string { return (entryName || '').replace(/\s*\([^)]*\)\s*$/, '').trim(); }
function mean(a: number[]): number { if (!a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; }
function stddev(a: number[]): number { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); }
function median(arr: number[]): number { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }
function rankPercentile(values: number[]): number[] {
  const idx = values.map((v, i) => ({ v, i }));
  idx.sort((a, b) => a.v - b.v);
  const out = new Array<number>(values.length);
  for (let r = 0; r < values.length; r++) out[idx[r].i] = values.length > 1 ? r / (values.length - 1) : 0;
  return out;
}
function loadAdjOwn(p: string): Map<string, number> {
  if (!fs.existsSync(p)) return new Map();
  const records = csvParse(fs.readFileSync(p, 'utf-8'), { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
  const out = new Map<string, number>();
  for (const r of records) {
    const id = (r['DFS ID'] || r['ID'] || '').trim(); if (!id) continue;
    const v = parseFloat((r['Adj Own'] || '').replace(/[%,]/g, ''));
    if (!Number.isNaN(v)) out.set(id, Math.max(0, v));
  }
  return out;
}
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
function withinSlatePercentile(values: Map<string, number>): Map<string, number> {
  const arr: { id: string; v: number }[] = [];
  for (const [id, v] of values) arr.push({ id, v });
  arr.sort((a, b) => a.v - b.v);
  const out = new Map<string, number>();
  for (let i = 0; i < arr.length; i++) out.set(arr[i].id, arr.length > 1 ? i / (arr.length - 1) : 0);
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

// ===== GBM =====

interface TreeNode { feature?: number; threshold?: number; left?: TreeNode; right?: TreeNode; leafValue?: number; }
interface Histogram { binEdges: number[][]; X_bin: Uint8Array; }
interface GBMModel { trees: TreeNode[]; basePred: number; learningRate: number; }

function buildHistogram(X: number[][], nBins: number): Histogram {
  const n = X.length, k = X[0].length;
  const binEdges: number[][] = []; const X_bin = new Uint8Array(n * k);
  for (let f = 0; f < k; f++) {
    const col: number[] = []; for (let i = 0; i < n; i++) col.push(X[i][f]);
    const sorted = [...col].sort((a, b) => a - b);
    const edges: number[] = [];
    for (let b = 0; b <= nBins; b++) edges.push(sorted[Math.min(sorted.length - 1, Math.floor(b * sorted.length / nBins))]);
    const dedup = Array.from(new Set(edges)).sort((a, b) => a - b);
    binEdges.push(dedup);
    for (let i = 0; i < n; i++) {
      const v = X[i][f];
      let lo = 0, hi = dedup.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >>> 1; if (dedup[mid] <= v) lo = mid; else hi = mid - 1; }
      X_bin[i * k + f] = Math.min(255, lo);
    }
  }
  return { binEdges, X_bin };
}

interface SplitResult { feature: number; threshold: number; gain: number; leftCount: number; rightCount: number; }
function findBestSplit(hist: Histogram, residuals: Float64Array, indices: Uint32Array, lambda: number, minLeaf: number): SplitResult | null {
  const k = hist.binEdges.length, n = indices.length;
  let totalSum = 0; for (let i = 0; i < n; i++) totalSum += residuals[indices[i]];
  let best: SplitResult | null = null;
  for (let f = 0; f < k; f++) {
    const nBins = hist.binEdges[f].length; if (nBins < 2) continue;
    const binSum = new Float64Array(nBins); const binCount = new Uint32Array(nBins);
    for (let i = 0; i < n; i++) { const idx = indices[i]; const b = hist.X_bin[idx * k + f]; binSum[b] += residuals[idx]; binCount[b]++; }
    let leftSum = 0, leftCount = 0;
    for (let b = 0; b < nBins - 1; b++) {
      leftSum += binSum[b]; leftCount += binCount[b];
      const rightSum = totalSum - leftSum; const rightCount = n - leftCount;
      if (leftCount < minLeaf || rightCount < minLeaf) continue;
      const gain = (leftSum * leftSum) / (leftCount + lambda)
                 + (rightSum * rightSum) / (rightCount + lambda)
                 - (totalSum * totalSum) / (n + lambda);
      if (!best || gain > best.gain) best = { feature: f, threshold: hist.binEdges[f][b + 1], gain, leftCount, rightCount };
    }
  }
  return best;
}
function buildTree(hist: Histogram, residuals: Float64Array, indices: Uint32Array, depth: number, maxDepth: number, lambda: number, minLeaf: number): TreeNode {
  if (depth >= maxDepth || indices.length < 2 * minLeaf) {
    let s = 0; for (let i = 0; i < indices.length; i++) s += residuals[indices[i]];
    return { leafValue: s / (indices.length + lambda) };
  }
  const split = findBestSplit(hist, residuals, indices, lambda, minLeaf);
  if (!split || split.gain <= 0) {
    let s = 0; for (let i = 0; i < indices.length; i++) s += residuals[indices[i]];
    return { leafValue: s / (indices.length + lambda) };
  }
  const leftIdx = new Uint32Array(split.leftCount); const rightIdx = new Uint32Array(split.rightCount);
  let li = 0, ri = 0;
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i]; const b = hist.X_bin[idx * hist.binEdges.length + split.feature];
    if (hist.binEdges[split.feature][b] < split.threshold) leftIdx[li++] = idx;
    else rightIdx[ri++] = idx;
  }
  return {
    feature: split.feature, threshold: split.threshold,
    left: buildTree(hist, residuals, leftIdx, depth + 1, maxDepth, lambda, minLeaf),
    right: buildTree(hist, residuals, rightIdx, depth + 1, maxDepth, lambda, minLeaf),
  };
}
function predictTree(tree: TreeNode, x: number[]): number {
  let n: TreeNode = tree;
  while (n.feature !== undefined) { if (x[n.feature] < n.threshold!) n = n.left!; else n = n.right!; }
  return n.leafValue || 0;
}
function trainGBM(X: number[][], y: number[]): GBMModel {
  const n = X.length;
  const hist = buildHistogram(X, GBM.N_BINS);
  const basePred = mean(y);
  const preds = new Float64Array(n).fill(basePred);
  const residuals = new Float64Array(n);
  for (let i = 0; i < n; i++) residuals[i] = y[i] - basePred;
  const trees: TreeNode[] = [];
  const allIdx = new Uint32Array(n); for (let i = 0; i < n; i++) allIdx[i] = i;
  for (let t = 0; t < GBM.N_TREES; t++) {
    const tree = buildTree(hist, residuals, allIdx, 0, GBM.MAX_DEPTH, GBM.L2_LAMBDA, GBM.MIN_LEAF);
    for (let i = 0; i < n; i++) {
      const inc = GBM.LEARNING_RATE * predictTree(tree, X[i]);
      preds[i] += inc; residuals[i] = y[i] - preds[i];
    }
    trees.push(tree);
  }
  return { trees, basePred, learningRate: GBM.LEARNING_RATE };
}
function predictGBM(model: GBMModel, x: number[]): number {
  let p = model.basePred;
  for (const tree of model.trees) p += model.learningRate * predictTree(tree, x);
  return p;
}

// ===== combo data =====

interface ComboTrainRecord {
  predFreq: number; ownProduct: number; actualFreq: number; sameTeam: boolean;
  projSum: number; salSum: number;
  gameTotalSum: number; saberTeamSum: number;
  ownPctileSum: number; projPctileSum: number;
  salaryEff: number; numUniqueTeams: number;
}
interface SlateData {
  slate: string;
  poolSize: number;
  fieldSize: number;
  candidates: Lineup[];
  players: Player[];
  config: any;
  actuals: ContestActuals;
  nameMap: Map<string, Player>;
  fieldEntriesByUser: Map<string, ContestEntry[]>;
  fieldLineups: Player[][];
  // For training the GBM (records from THIS slate's actuals).
  trainBySize: Record<number, ComboTrainRecord[]>;
  // Per-combo features for predict-time on candidate pool combos (computed from candidates).
  poolCount: Record<number, Map<string, number>>;
  ownDecById: Map<string, number>;
  projById: Map<string, number>;
  salById: Map<string, number>;
  teamById: Map<string, string>;
  gameTotalById: Map<string, number>;
  saberTeamById: Map<string, number>;
  ownPctileById: Map<string, number>;
  projPctileById: Map<string, number>;
}

async function loadSlate(s: typeof SLATES[0]): Promise<SlateData | null> {
  const projPath = path.join(DIR, s.proj), actualsPath = path.join(DIR, s.actuals), poolPath = path.join(DIR, s.pool);
  if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) return null;
  const pr = parseCSVFile(projPath, 'mlb', true);
  const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
  const pool = buildPlayerPool(pr.players, pr.detectedContestType);
  const actuals = parseContestActuals(actualsPath, config);
  const projData = loadProjFile(projPath);
  const idMap = new Map<string, Player>(); const nameMap = new Map<string, Player>();
  const teamById = new Map<string, string>(); const ownDecById = new Map<string, number>();
  const projById = new Map<string, number>(); const salById = new Map<string, number>();
  const gameTotalById = new Map<string, number>(); const saberTeamById = new Map<string, number>();
  for (const p of pool.players) {
    idMap.set(p.id, p); nameMap.set(norm(p.name), p);
    teamById.set(p.id, (p.team || '').toUpperCase());
    const adj = projData.adjOwn.get(p.id);
    ownDecById.set(p.id, Math.max(0, (adj !== undefined ? adj : (p.ownership || 0)) / 100));
    projById.set(p.id, p.projection || 0);
    salById.set(p.id, p.salary || 0);
    gameTotalById.set(p.id, projData.saberTotal.get(p.id) || 0);
    saberTeamById.set(p.id, projData.saberTeam.get(p.id) || 0);
  }
  const ownPctileById = withinSlatePercentile(ownDecById);
  const projPctileById = withinSlatePercentile(projById);
  const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
  const candidates = Array.from(new Map(loaded.lineups.map(l => [l.hash, l])).values());

  const fieldEntriesByUser = new Map<string, ContestEntry[]>();
  const entryIds: string[][] = [];
  const fieldLineups: Player[][] = [];
  for (const e of actuals.entries) {
    const ids: string[] = []; const pls: Player[] = []; let ok = true;
    for (const nm of e.playerNames) {
      const pl = nameMap.get(norm(nm)); if (!pl) { ok = false; break; }
      ids.push(pl.id); pls.push(pl);
    }
    if (ok) {
      entryIds.push(ids.sort());
      fieldLineups.push(pls);
      const u = extractUser(e.entryName);
      if (!fieldEntriesByUser.has(u)) fieldEntriesByUser.set(u, []);
      fieldEntriesByUser.get(u)!.push(e);
    }
  }
  const F = entryIds.length, P = candidates.length;
  if (F < 100 || P < 100) return null;

  // Pool counts (for pool-only baseline + GBM training feature).
  const poolCount: Record<number, Map<string, number>> = { 2: new Map(), 3: new Map(), 4: new Map(), 5: new Map() };
  for (const lu of candidates) {
    const ids = lu.players.map(p => p.id).sort(); const n = ids.length;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      poolCount[2].set(ids[i] + '|' + ids[j], (poolCount[2].get(ids[i] + '|' + ids[j]) || 0) + 1);
      for (let l = j + 1; l < n; l++) {
        const k3 = ids[i] + '|' + ids[j] + '|' + ids[l];
        poolCount[3].set(k3, (poolCount[3].get(k3) || 0) + 1);
        for (let m = l + 1; m < n; m++) {
          const k4 = ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m];
          poolCount[4].set(k4, (poolCount[4].get(k4) || 0) + 1);
          for (let q = m + 1; q < n; q++) {
            const k5 = ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m] + '|' + ids[q];
            poolCount[5].set(k5, (poolCount[5].get(k5) || 0) + 1);
          }
        }
      }
    }
  }

  // Actual counts (training labels).
  const actualCount: Record<number, Map<string, number>> = { 2: new Map(), 3: new Map(), 4: new Map(), 5: new Map() };
  for (const ids of entryIds) {
    const n = ids.length;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      actualCount[2].set(ids[i] + '|' + ids[j], (actualCount[2].get(ids[i] + '|' + ids[j]) || 0) + 1);
      for (let l = j + 1; l < n; l++) {
        const k3 = ids[i] + '|' + ids[j] + '|' + ids[l];
        actualCount[3].set(k3, (actualCount[3].get(k3) || 0) + 1);
        for (let m = l + 1; m < n; m++) {
          const k4 = ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m];
          actualCount[4].set(k4, (actualCount[4].get(k4) || 0) + 1);
          for (let q = m + 1; q < n; q++) {
            const k5 = ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m] + '|' + ids[q];
            actualCount[5].set(k5, (actualCount[5].get(k5) || 0) + 1);
          }
        }
      }
    }
  }

  const trainBySize: Record<number, ComboTrainRecord[]> = { 2: [], 3: [], 4: [], 5: [] };
  for (const size of [2, 3, 4, 5] as const) {
    // Collect candidate keys (sorted by actual count desc, take top PER_SLATE_CAP)
    // — keeps highest-signal records and bounds memory. Uniformly sample within ties.
    const candKeys: { k: string; c: number }[] = [];
    for (const [k, c] of actualCount[size]) if (c >= MIN_ACTUAL) candKeys.push({ k, c });
    if (candKeys.length > PER_SLATE_CAP) {
      // Stride sample to preserve actual-count distribution.
      candKeys.sort((a, b) => b.c - a.c);
      const stride = candKeys.length / PER_SLATE_CAP;
      const subset: { k: string; c: number }[] = [];
      for (let i = 0; i < PER_SLATE_CAP; i++) subset.push(candKeys[Math.floor(i * stride)]);
      candKeys.length = 0; for (const x of subset) candKeys.push(x);
    }
    for (const { k, c } of candKeys) {
      const ids = k.split('|');
      let ownProd = 1, projSum = 0, salSum = 0, gameTotalSum = 0, saberTeamSum = 0;
      let ownPctileSum = 0, projPctileSum = 0;
      const teamCounts = new Map<string, number>();
      for (const id of ids) {
        ownProd *= (ownDecById.get(id) || 0);
        projSum += projById.get(id) || 0;
        salSum += salById.get(id) || 0;
        gameTotalSum += gameTotalById.get(id) || 0;
        saberTeamSum += saberTeamById.get(id) || 0;
        ownPctileSum += ownPctileById.get(id) || 0;
        projPctileSum += projPctileById.get(id) || 0;
        const t = teamById.get(id) || '?';
        teamCounts.set(t, (teamCounts.get(t) || 0) + 1);
      }
      let maxTeamCount = 0; for (const v of teamCounts.values()) if (v > maxTeamCount) maxTeamCount = v;
      trainBySize[size].push({
        predFreq: (poolCount[size].get(k) || 0) / P,
        ownProduct: ownProd, actualFreq: c / F,
        sameTeam: maxTeamCount === ids.length,
        projSum, salSum, gameTotalSum, saberTeamSum, ownPctileSum, projPctileSum,
        salaryEff: salSum > 0 ? projSum / (salSum / 1000) : 0,
        numUniqueTeams: teamCounts.size,
      });
    }
  }

  return {
    slate: s.slate, poolSize: P, fieldSize: F, candidates,
    players: pool.players, config, actuals, nameMap, fieldEntriesByUser,
    fieldLineups, trainBySize, poolCount, ownDecById, projById, salById, teamById,
    gameTotalById, saberTeamById, ownPctileById, projPctileById,
  };
}

function featurize(r: ComboTrainRecord): number[] {
  return [
    Math.log(r.predFreq + SMALL),
    Math.log(r.ownProduct + SMALL),
    r.sameTeam ? 1 : 0,
    Math.log(Math.max(SMALL, r.projSum)),
    Math.log(Math.max(SMALL, r.salSum)),
    Math.log(Math.max(SMALL, r.gameTotalSum)),
    Math.log(Math.max(SMALL, r.saberTeamSum)),
    r.ownPctileSum,
    r.projPctileSum,
    r.salaryEff,
    r.numUniqueTeams,
  ];
}
function featurizeRaw(
  predFreq: number, ownProduct: number, sameTeam: boolean,
  projSum: number, salSum: number,
  gameTotalSum: number, saberTeamSum: number,
  ownPctileSum: number, projPctileSum: number,
  salaryEff: number, numUniqueTeams: number
): number[] {
  return [
    Math.log(predFreq + SMALL),
    Math.log(ownProduct + SMALL),
    sameTeam ? 1 : 0,
    Math.log(Math.max(SMALL, projSum)),
    Math.log(Math.max(SMALL, salSum)),
    Math.log(Math.max(SMALL, gameTotalSum)),
    Math.log(Math.max(SMALL, saberTeamSum)),
    ownPctileSum,
    projPctileSum,
    salaryEff,
    numUniqueTeams,
  ];
}
function subsample<T>(arr: T[], cap: number): T[] {
  if (arr.length <= cap) return arr;
  const stride = arr.length / cap;
  const out: T[] = []; for (let i = 0; i < cap; i++) out.push(arr[Math.floor(i * stride)]);
  return out;
}

// ===== Argus selection =====

interface ScoredLineup {
  lu: Lineup; primarySize: number; corrAdj: number; logOwn: number; logOwnAll: number;
  uniqueness: number; multi_penalty: number; ppd: number;
  proj: number; range: number; ceiling: number; ev: number;
  projPct: number; ownPct: number; rangePct: number; ceilingPct: number; ppdPct: number;
  uniqPct: number; multiPct: number;
}

interface FieldFreqs {
  pair: Map<string, number>;
  trip: Map<string, number>;
  quad: Map<string, number>;
  quint: Map<string, number>;
  missingFreq: number;
}

function selectArgus(slate: SlateData, fieldFreqs: FieldFreqs, wMulti: number = ARGUS.W_MULTI, wOwnProd: number = 0, wLevCeil: number = 0): ScoredLineup[] {
  const candidates = slate.candidates;
  // V1's pair/triple proj-weighted freqs (preserved combo uniqueness term).
  const v1Pair = new Map<string, number>(); const v1Trip = new Map<string, number>();
  let totalW = 0;
  for (const lu of candidates) {
    const w = Math.max(0.1, lu.projection || 1) ** 2; totalW += w;
    const ids = lu.players.map(p => p.id).sort();
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      v1Pair.set(ids[i] + '|' + ids[j], (v1Pair.get(ids[i] + '|' + ids[j]) || 0) + w);
      for (let l = j + 1; l < ids.length; l++) {
        const k = ids[i] + '|' + ids[j] + '|' + ids[l];
        v1Trip.set(k, (v1Trip.get(k) || 0) + w);
      }
    }
  }
  for (const k of v1Pair.keys()) v1Pair.set(k, v1Pair.get(k)! / totalW);
  for (const k of v1Trip.keys()) v1Trip.set(k, v1Trip.get(k)! / totalW);

  // Per-size median for chalk-ratio rescaling.
  function mapMedian(m: Map<string, number>): number {
    if (m.size === 0) return 1;
    const arr: number[] = []; for (const v of m.values()) arr.push(v);
    arr.sort((a, b) => a - b); return arr[Math.floor(arr.length / 2)] || 1;
  }
  const med2 = mapMedian(fieldFreqs.pair), med3 = mapMedian(fieldFreqs.trip),
        med4 = mapMedian(fieldFreqs.quad), med5 = mapMedian(fieldFreqs.quint);

  const scored: ScoredLineup[] = [];
  for (const lu of candidates) {
    let floor = 0, ceiling = 0;
    for (const p of lu.players) {
      if (p.percentiles) { floor += p.percentiles.p25 || p.projection * 0.85; ceiling += p.percentiles.p75 || p.projection * 1.15; }
      else { floor += p.projection * 0.85; ceiling += p.projection * 1.15; }
    }
    const teamHitters = new Map<string, number>(); const pitchers: Player[] = [];
    for (const p of lu.players) {
      if (isPitcher(p)) pitchers.push(p);
      else { const t = (p.team || '').toUpperCase(); if (t) teamHitters.set(t, (teamHitters.get(t) || 0) + 1); }
    }
    let primarySize = 0; for (const c of teamHitters.values()) if (c > primarySize) primarySize = c;
    let pOpp = 0; for (const p of pitchers) { const o = (p.opponent || '').toUpperCase(); if (o) pOpp += teamHitters.get(o) || 0; }
    const corrAdj = ARGUS.PITCHER_VS_HITTER_PENALTY * pOpp;

    let uniqueness = 0;
    const players = lu.players;
    for (let i = 0; i < players.length; i++) for (let j = i + 1; j < players.length; j++) {
      const k = [players[i].id, players[j].id].sort().join('|');
      uniqueness += -Math.log(v1Pair.get(k) || 1e-6);
    }
    const tripFs: number[] = [];
    for (let i = 0; i < players.length; i++) for (let j = i + 1; j < players.length; j++) for (let l = j + 1; l < players.length; l++) {
      const tk = [players[i].id, players[j].id, players[l].id].sort().join('|');
      tripFs.push(v1Trip.get(tk) || 1e-6);
    }
    tripFs.sort((a, b) => b - a);
    for (const f of tripFs.slice(0, ARGUS.TRIPLE_FREQ_CAP)) uniqueness += -Math.log(f);

    const ids = players.map(p => p.id).sort();
    const slots: { f: number; r: number }[] = [];
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const f2 = fieldFreqs.pair.get(ids[i] + '|' + ids[j]) ?? fieldFreqs.missingFreq;
      slots.push({ f: f2, r: f2 / med2 });
      for (let l = j + 1; l < ids.length; l++) {
        const f3 = fieldFreqs.trip.get(ids[i] + '|' + ids[j] + '|' + ids[l]) ?? fieldFreqs.missingFreq;
        slots.push({ f: f3, r: f3 / med3 });
        for (let m = l + 1; m < ids.length; m++) {
          const f4 = fieldFreqs.quad.get(ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m]) ?? fieldFreqs.missingFreq;
          slots.push({ f: f4, r: f4 / med4 });
          for (let q = m + 1; q < ids.length; q++) {
            const f5 = fieldFreqs.quint.get(ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m] + '|' + ids[q]) ?? fieldFreqs.missingFreq;
            slots.push({ f: f5, r: f5 / med5 });
          }
        }
      }
    }
    slots.sort((a, b) => b.r - a.r);
    let prodR = 1; for (const s of slots.slice(0, ARGUS.TOP_K)) prodR *= s.r;
    const multi_penalty = -Math.log(prodR + ARGUS.LOG_EPSILON);

    let logOwn = 0;
    for (const p of lu.players) { if (isPitcher(p)) continue; logOwn += Math.log(Math.max(0.1, p.ownership || 0.5)); }
    // logOwnAll: all 10 players for direct ownership-product subtraction.
    let logOwnAll = 0;
    for (const p of lu.players) logOwnAll += Math.log(Math.max(0.1, p.ownership || 0.5));
    let ppd = 0;
    for (const p of lu.players) if (p.salary && p.projection) ppd += p.projection / (p.salary / 1000);

    scored.push({ lu, primarySize, corrAdj, logOwn, logOwnAll, uniqueness, multi_penalty, ppd,
      proj: lu.projection, range: ceiling - floor, ceiling, ev: 0,
      projPct: 0, ownPct: 0, rangePct: 0, ceilingPct: 0, ppdPct: 0, uniqPct: 0, multiPct: 0 });
  }

  const projAdj = scored.map(s => s.proj * (1 + s.corrAdj));
  const projPct = rankPercentile(projAdj);
  const ownPct = rankPercentile(scored.map(s => s.logOwn));
  const rangePct = rankPercentile(scored.map(s => s.range));
  const ceilingPct = rankPercentile(scored.map(s => s.ceiling));
  const ppdPct = rankPercentile(scored.map(s => s.ppd));
  const uniqPct = rankPercentile(scored.map(s => s.uniqueness));
  const multiPct = rankPercentile(scored.map(s => s.multi_penalty));
  // Compute z-score normalization for direct ownership-product subtraction.
  const allLogOwnAll = scored.map(s => s.logOwnAll);
  const meanLogOwnAll = allLogOwnAll.reduce((s, x) => s + x, 0) / Math.max(1, allLogOwnAll.length);
  const varLogOwnAll = allLogOwnAll.reduce((s, x) => s + (x - meanLogOwnAll) ** 2, 0) / Math.max(1, allLogOwnAll.length);
  const stdLogOwnAll = Math.sqrt(varLogOwnAll) || 1;
  for (let i = 0; i < scored.length; i++) {
    scored[i].projPct = projPct[i]; scored[i].ownPct = ownPct[i];
    scored[i].rangePct = rangePct[i]; scored[i].ceilingPct = ceilingPct[i]; scored[i].ppdPct = ppdPct[i];
    scored[i].uniqPct = uniqPct[i]; scored[i].multiPct = multiPct[i];
    let ev = ARGUS.W_PROJ * projPct[i] + ARGUS.W_LEV * (1 - ownPct[i]) + ARGUS.W_VAR * rangePct[i] * 0.85
           + ARGUS.W_CMB * uniqPct[i] + wMulti * multiPct[i];
    if (wLevCeil > 0) ev += wLevCeil * (1 - ownPct[i]) * ceilingPct[i];
    if (wOwnProd > 0) {
      const zChalk = (scored[i].logOwnAll - meanLogOwnAll) / stdLogOwnAll;
      ev -= wOwnProd * zChalk;
    }
    if (ppdPct[i] >= 1 - ARGUS.PPD_LINEUP_TOP_PCT) ev *= (1 - ARGUS.PPD_LINEUP_PENALTY);
    scored[i].ev = ev;
  }

  // Greedy fill.
  let pool2 = scored.filter(s => s.primarySize >= ARGUS.MIN_PRIMARY_STACK);
  if (pool2.length < N) pool2 = scored;
  const sortedHigh = [...pool2].sort((a, b) => (b.projPct + b.ownPct) - (a.projPct + a.ownPct));
  const sortedLow = [...pool2].sort((a, b) => ((1 - b.projPct) + (1 - b.ownPct)) - ((1 - a.projPct) + (1 - a.ownPct)));
  const HIGH = Math.round(N * ARGUS.BAND_HIGH_PCT);
  const LOW = Math.round(N * ARGUS.BAND_LOW_PCT);
  const MID = N - HIGH - LOW;
  const sel: ScoredLineup[] = []; const exposure = new Map<string, number>(); const teamCount = new Map<string, number>(); const seen = new Set<string>();
  function primaryStackTeamOf(s: ScoredLineup): string {
    const tc = new Map<string, number>();
    for (const p of s.lu.players) {
      if (isPitcher(p)) continue; const t = (p.team || '').toUpperCase();
      if (t) tc.set(t, (tc.get(t) || 0) + 1);
    }
    let pri = '', max = 0; for (const [t, c] of tc) if (c > max) { max = c; pri = t; }
    return max >= 4 ? pri : '';
  }
  function passes(s: ScoredLineup, maxOv: number): boolean {
    if (seen.has(s.lu.hash)) return false;
    if (s.primarySize < ARGUS.MIN_PRIMARY_STACK) return false;
    for (const p of s.lu.players) {
      const cur = exposure.get(p.id) || 0;
      const cap = isPitcher(p) ? ARGUS.EXPOSURE_CAP_PITCHER : ARGUS.EXPOSURE_CAP_HITTER;
      if ((cur + 1) / N > cap) return false;
    }
    const st = primaryStackTeamOf(s);
    if (st && (((teamCount.get(st) || 0) + 1) / N > ARGUS.TEAM_STACK_CAP)) return false;
    const ids = new Set(s.lu.players.map(p => p.id));
    for (const x of sel) {
      let ov = 0; for (const p of x.lu.players) if (ids.has(p.id)) ov++;
      if (ov > maxOv) return false;
    }
    return true;
  }
  function add(s: ScoredLineup) {
    sel.push(s); seen.add(s.lu.hash);
    for (const p of s.lu.players) exposure.set(p.id, (exposure.get(p.id) || 0) + 1);
    const st = primaryStackTeamOf(s); if (st) teamCount.set(st, (teamCount.get(st) || 0) + 1);
  }
  function fill(bp: ScoredLineup[], target: number) {
    const sorted = [...bp].sort((a, b) => b.ev - a.ev);
    let added = 0;
    for (const s of sorted) { if (added >= target) break; if (passes(s, ARGUS.MAX_PAIRWISE_OVERLAP)) { add(s); added++; } }
    if (added < target) for (const s of sorted) { if (added >= target) break; if (passes(s, ARGUS.MAX_PAIRWISE_OVERLAP + 1)) { add(s); added++; } }
  }
  fill(sortedHigh.slice(0, Math.max(HIGH * 5, 200)), HIGH);
  fill(pool2, MID);
  fill(sortedLow.slice(0, Math.max(LOW * 5, 200)), LOW);
  if (sel.length < N) {
    const sorted = [...pool2].sort((a, b) => b.ev - a.ev);
    for (const s of sorted) { if (sel.length >= N) break; if (passes(s, ARGUS.MAX_PAIRWISE_OVERLAP + 1)) add(s); }
  }
  return sel.slice(0, N);
}

// ===== Build field freqs from pool counts (v4 baseline). =====
function buildFieldFreqsPool(slate: SlateData): FieldFreqs {
  const P = slate.poolSize;
  const pair = new Map<string, number>(); const trip = new Map<string, number>(); const quad = new Map<string, number>(); const quint = new Map<string, number>();
  for (const [k, c] of slate.poolCount[2]) pair.set(k, c / P);
  for (const [k, c] of slate.poolCount[3]) trip.set(k, c / P);
  for (const [k, c] of slate.poolCount[4]) quad.set(k, c / P);
  for (const [k, c] of slate.poolCount[5]) quint.set(k, c / P);
  return { pair, trip, quad, quint, missingFreq: 0.5 / P };
}

// ===== Build field freqs from GBM. =====
function buildFieldFreqsGBM(slate: SlateData, gbmModels: Record<number, GBMModel>): FieldFreqs {
  const P = slate.poolSize;
  const pair = new Map<string, number>(); const trip = new Map<string, number>(); const quad = new Map<string, number>(); const quint = new Map<string, number>();
  function predictForCombo(size: number, key: string): number {
    const ids = key.split('|');
    let ownProd = 1, projSum = 0, salSum = 0;
    let gameTotalSum = 0, saberTeamSum = 0;
    let ownPctileSum = 0, projPctileSum = 0;
    const teamCounts = new Map<string, number>();
    for (const id of ids) {
      ownProd *= (slate.ownDecById.get(id) || 0);
      projSum += slate.projById.get(id) || 0;
      salSum += slate.salById.get(id) || 0;
      gameTotalSum += slate.gameTotalById.get(id) || 0;
      saberTeamSum += slate.saberTeamById.get(id) || 0;
      ownPctileSum += slate.ownPctileById.get(id) || 0;
      projPctileSum += slate.projPctileById.get(id) || 0;
      const t = slate.teamById.get(id) || '?';
      teamCounts.set(t, (teamCounts.get(t) || 0) + 1);
    }
    let maxTeam = 0; for (const v of teamCounts.values()) if (v > maxTeam) maxTeam = v;
    const sameTeam = maxTeam === ids.length;
    const poolFreq = (slate.poolCount[size].get(key) || 0) / P;
    const salaryEff = salSum > 0 ? projSum / (salSum / 1000) : 0;
    const x = featurizeRaw(poolFreq, ownProd, sameTeam, projSum, salSum,
      gameTotalSum, saberTeamSum, ownPctileSum, projPctileSum, salaryEff, teamCounts.size);
    return Math.max(0, Math.exp(predictGBM(gbmModels[size], x)) - SMALL);
  }
  for (const [k, _] of slate.poolCount[2]) pair.set(k, predictForCombo(2, k));
  for (const [k, _] of slate.poolCount[3]) trip.set(k, predictForCombo(3, k));
  for (const [k, _] of slate.poolCount[4]) quad.set(k, predictForCombo(4, k));
  for (const [k, _] of slate.poolCount[5]) quint.set(k, predictForCombo(5, k));
  return { pair, trip, quad, quint, missingFreq: 0.5 / P };
}

// ===== Mahalanobis / ROI scoring =====

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

function computeMahalanobis(slate: SlateData, ourMetrics: UniversalMetrics, slateStats: SlateStats): number | null {
  // Build pro consensus from all 150-entry pros on this slate.
  const proPortfolioMetrics: UniversalMetrics[] = [];
  for (const [u, ents] of slate.fieldEntriesByUser) {
    if (ents.length !== 150) continue;
    const proLus: Player[][] = [];
    for (const e of ents) {
      const pls: Player[] = []; let ok = true;
      for (const nm of e.playerNames) { const p = slate.nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
      if (ok) proLus.push(pls);
    }
    if (proLus.length >= 100) proPortfolioMetrics.push(computeUniversal(proLus, slateStats));
  }
  if (proPortfolioMetrics.length < 3) return null;
  const cons: any = {};
  for (const k of UNIVERSAL_METRICS) {
    const vals = proPortfolioMetrics.map(m => m[k]);
    cons[k] = { mean: mean(vals), std: stddev(vals) };
  }
  let sum = 0; let n = 0;
  for (const k of UNIVERSAL_METRICS) {
    if (cons[k].std < 1e-9) continue;
    const d = ((ourMetrics as any)[k] - cons[k].mean) / cons[k].std;
    sum += d * d; n++;
  }
  return n > 0 ? Math.sqrt(sum / n) : null;
}

function scorePayout(portfolio: Lineup[], slate: SlateData): { totalPayout: number; t1: number; meanActual: number; maxActual: number; } {
  const F = slate.actuals.entries.length;
  const sortedPts = slate.actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
  const top1T = sortedPts[Math.max(0, Math.floor(F * 0.01) - 1)] || 0;
  const payoutTable = buildPayoutTable(F);
  let total = 0, t1 = 0; const acts: number[] = [];
  for (const lu of portfolio) {
    let a = 0; let miss = false;
    for (const p of lu.players) {
      const r = slate.actuals.playerActualsByName.get(norm(p.name));
      if (!r) { miss = true; break; }
      a += r.fpts;
    }
    if (miss) continue;
    acts.push(a);
    if (a >= top1T) t1++;
    let lo = 0, hi = sortedPts.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (sortedPts[mid] >= a) lo = mid + 1; else hi = mid; }
    const rank = Math.max(1, lo);
    const payout = rank <= payoutTable.length ? payoutTable[rank - 1] : 0;
    if (payout > 0) {
      let coWin = 0;
      for (const e of slate.actuals.entries) if (Math.abs(e.actualPoints - a) <= 0.25) coWin++;
      coWin = Math.max(0, coWin - 1);
      total += payout / Math.sqrt(1 + coWin * 0.5);
    }
  }
  return { totalPayout: total, t1, meanActual: mean(acts), maxActual: acts.length ? Math.max(...acts) : 0 };
}

// Sweep: W_OWN_PROD already shown unhelpful, so fix it at 0 and sweep
// (W_MULTI, W_LEV_CEIL) instead. Keeps the grid manageable.
const W_MULTI_VALUES = [0.10, 0.20, 0.30];
const W_LEV_CEIL_VALUES = [0.0, 0.20, 0.40];
const SWEEP_KEYS: { wm: number; wlc: number; key: string }[] = [];
for (const wm of W_MULTI_VALUES) for (const wlc of W_LEV_CEIL_VALUES) {
  SWEEP_KEYS.push({ wm, wlc, key: `wm${wm.toFixed(2)}_wlc${wlc.toFixed(2)}` });
}

interface OptInfo {
  topActualProj: number;       // mean projection of top-1% actual lineups
  topActualOwn: number;        // mean ownership of top-1% actual lineups
  optimalProj: number;         // single highest projection in candidate pool
}

interface SlateResult {
  slate: string; F: number; P: number;
  v4_pay: number; v4_roi: number; v4_t1: number;
  v4_mahal: number | null; v4_meanOwn: number; v4_meanProj: number;
  sweep: Record<string, { mahal: number | null; pay: number; meanOwn: number; meanProj: number; t1: number; }>;
  optInfo: OptInfo;
}

function computeOptimalLineupStats(slate: SlateData): OptInfo {
  // Top-1% of contest entries by actual points → average their proj/own.
  const F = slate.actuals.entries.length;
  const sorted = [...slate.actuals.entries].sort((a, b) => b.actualPoints - a.actualPoints);
  const top1Cut = Math.max(1, Math.floor(F * 0.01));
  const top1 = sorted.slice(0, top1Cut);
  let projSum = 0, ownSum = 0, n = 0;
  for (const e of top1) {
    let lupProj = 0, lupOwn = 0; let valid = true;
    for (const nm of e.playerNames) {
      const pl = slate.nameMap.get(norm(nm));
      if (!pl) { valid = false; break; }
      lupProj += pl.projection || 0;
      lupOwn += pl.ownership || 0;
    }
    if (valid && e.playerNames.length > 0) {
      projSum += lupProj;
      ownSum += lupOwn / e.playerNames.length;
      n++;
    }
  }
  // Optimal lineup proj from candidate pool.
  let optimalProj = 0;
  for (const lu of slate.candidates) if (lu.projection > optimalProj) optimalProj = lu.projection;
  return {
    topActualProj: n > 0 ? projSum / n : 0,
    topActualOwn: n > 0 ? ownSum / n : 0,
    optimalProj,
  };
}

function buildFieldFreqsGBMv7(slate: SlateData, gbmModels: Record<number, GBMModel>): FieldFreqs {
  // v7: GBM trained on residual log(actual / pool); inference = pool * exp(GBM_pred).
  const P = slate.poolSize;
  const pair = new Map<string, number>(); const trip = new Map<string, number>(); const quad = new Map<string, number>(); const quint = new Map<string, number>();
  function predictForCombo(size: number, key: string): number {
    const ids = key.split('|');
    let ownProd = 1, projSum = 0, salSum = 0, gameTotalSum = 0, saberTeamSum = 0;
    let ownPctileSum = 0, projPctileSum = 0;
    const teamCounts = new Map<string, number>();
    for (const id of ids) {
      ownProd *= (slate.ownDecById.get(id) || 0);
      projSum += slate.projById.get(id) || 0;
      salSum += slate.salById.get(id) || 0;
      gameTotalSum += slate.gameTotalById.get(id) || 0;
      saberTeamSum += slate.saberTeamById.get(id) || 0;
      ownPctileSum += slate.ownPctileById.get(id) || 0;
      projPctileSum += slate.projPctileById.get(id) || 0;
      const t = slate.teamById.get(id) || '?';
      teamCounts.set(t, (teamCounts.get(t) || 0) + 1);
    }
    let maxTeam = 0; for (const v of teamCounts.values()) if (v > maxTeam) maxTeam = v;
    const sameTeam = maxTeam === ids.length;
    const poolFreq = (slate.poolCount[size].get(key) || 0) / P;
    const salaryEff = salSum > 0 ? projSum / (salSum / 1000) : 0;
    const x = featurizeRaw(poolFreq, ownProd, sameTeam, projSum, salSum,
      gameTotalSum, saberTeamSum, ownPctileSum, projPctileSum, salaryEff, teamCounts.size);
    const residualLog = predictGBM(gbmModels[size], x);
    const poolSmoothed = Math.max(poolFreq, 1e-4);
    return Math.max(0, poolSmoothed * Math.exp(residualLog) - SMALL);
  }
  for (const [k, _] of slate.poolCount[2]) pair.set(k, predictForCombo(2, k));
  for (const [k, _] of slate.poolCount[3]) trip.set(k, predictForCombo(3, k));
  for (const [k, _] of slate.poolCount[4]) quad.set(k, predictForCombo(4, k));
  for (const [k, _] of slate.poolCount[5]) quint.set(k, predictForCombo(5, k));
  return { pair, trip, quad, quint, missingFreq: 0.5 / P };
}

async function main() {
  console.log('=== Argus-v7 (GBM v3 RESIDUAL field model + W_MULTI sweep) LOO, all slates ===');
  console.log(`W_MULTI × W_LEV_CEIL sweep: ${SWEEP_KEYS.length} combos\n`);

  console.log('Loading slates...');
  const slates: SlateData[] = [];
  for (const s of SLATES) {
    process.stdout.write(s.slate.padEnd(15) + ' ');
    try {
      const sd = await loadSlate(s);
      if (sd) {
        slates.push(sd);
        console.log(`F=${sd.fieldSize} P=${sd.poolSize}`);
      } else {
        console.log('skip (load returned null)');
      }
    } catch (e) {
      console.log('skip (' + (e as Error).message.slice(0, 60) + ')');
    }
  }
  console.log(`${slates.length} slates loaded.\n`);

  const results: SlateResult[] = [];
  for (let i = 0; i < slates.length; i++) {
    const heldOut = slates[i];
    const train = slates.filter((_, j) => j !== i);
    const cost = N * FEE;

    process.stdout.write(`[${(i + 1).toString().padStart(2)}/${slates.length}] ${heldOut.slate.padEnd(15)} `);
    const t0 = Date.now();

    // Train GBM v3 (residual target: log(actual / pool)) per size.
    const gbmModels: Record<number, GBMModel> = {};
    for (const size of [2, 3, 4, 5] as const) {
      const all = train.flatMap(s => s.trainBySize[size]);
      if (all.length < 100) continue;
      const sub = subsample(all, TRAIN_CAP);
      const X = sub.map(featurize);
      // Residual target: log(actual / max(pool, 1/(2P_train)))
      const y = sub.map(r => {
        const poolSmoothed = Math.max(r.predFreq, 1e-4);
        return Math.log(r.actualFreq / poolSmoothed + SMALL);
      });
      gbmModels[size] = trainGBM(X, y);
    }

    // Build field freqs both ways. v7 uses GBM-residual: final = pool * exp(GBM).
    const ffPool = buildFieldFreqsPool(heldOut);
    const ffGBMv7 = buildFieldFreqsGBMv7(heldOut, gbmModels);

    // Compute slate stats + optimal lineup once.
    const slateStats = computeSlateStats(heldOut.players, heldOut.fieldLineups);
    const optInfo = computeOptimalLineupStats(heldOut);

    // v4 baseline (pool, W_MULTI=0.20).
    const v4Sel = selectArgus(heldOut, ffPool, 0.20);
    const v4M = computeUniversal(v4Sel.map(s => s.lu.players), slateStats);
    const v4Mahal = computeMahalanobis(heldOut, v4M, slateStats);
    const v4Pay = scorePayout(v4Sel.map(s => s.lu), heldOut);
    const v4MeanOwn = mean(v4Sel.map(s => s.lu.ownership));
    const v4MeanProj = mean(v4Sel.map(s => s.lu.projection));

    // v8 sweep over (W_MULTI, W_LEV_CEIL) pairs.
    const sweep: Record<string, { mahal: number | null; pay: number; meanOwn: number; meanProj: number; t1: number; }> = {};
    for (const sk of SWEEP_KEYS) {
      const sel = selectArgus(heldOut, ffGBMv7, sk.wm, 0, sk.wlc);
      const m = computeUniversal(sel.map(s => s.lu.players), slateStats);
      const mahal = computeMahalanobis(heldOut, m, slateStats);
      const pay = scorePayout(sel.map(s => s.lu), heldOut);
      sweep[sk.key] = {
        mahal, pay: pay.totalPayout, t1: pay.t1,
        meanOwn: mean(sel.map(s => s.lu.ownership)),
        meanProj: mean(sel.map(s => s.lu.projection)),
      };
    }

    results.push({
      slate: heldOut.slate, F: heldOut.fieldSize, P: heldOut.poolSize,
      v4_pay: v4Pay.totalPayout,
      v4_roi: (v4Pay.totalPayout / cost - 1) * 100,
      v4_t1: v4Pay.t1, v4_mahal: v4Mahal,
      v4_meanOwn: v4MeanOwn, v4_meanProj: v4MeanProj,
      sweep, optInfo,
    });
    console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s | v4 ROI=${((v4Pay.totalPayout / cost - 1) * 100).toFixed(0).padStart(5)}% mahal=${v4Mahal?.toFixed(2).padStart(5) || ' n/a'} | best v8: ${(() => {
      let bestKey = ''; let bestPay = -Infinity;
      for (const sk of SWEEP_KEYS) if (sweep[sk.key].pay > bestPay) { bestPay = sweep[sk.key].pay; bestKey = sk.key; }
      const bestRoi = ((bestPay / cost - 1) * 100).toFixed(0);
      return `${bestKey} ROI=${bestRoi.padStart(5)}%`;
    })()}`);
  }

  // Aggregate.
  const cost = N * FEE * results.length;
  const v4Pay = results.reduce((s, r) => s + r.v4_pay, 0);
  const v4Mahal = results.map(r => r.v4_mahal).filter((x): x is number => x !== null);
  const v4ROI = (v4Pay / cost - 1) * 100;

  console.log('\n================================================================');
  console.log('AGGREGATE — Argus-v4 (pool) vs Argus-v8 (W_MULTI × W_LEV_CEIL sweep)');
  console.log('================================================================');
  console.log(`Slates: ${results.length}, total cost: $${cost}\n`);

  // 2D grid: rows = W_MULTI, cols = W_LEV_CEIL. Cell = aggregate ROI %.
  console.log('AGGREGATE ROI (%) — rows=W_MULTI, cols=W_LEV_CEIL');
  let hdr = '          ';
  for (const wlc of W_LEV_CEIL_VALUES) hdr += `   wlc=${wlc.toFixed(2)}`;
  console.log(hdr);
  for (const wm of W_MULTI_VALUES) {
    let line = `wm=${wm.toFixed(2)} `;
    for (const wlc of W_LEV_CEIL_VALUES) {
      const key = `wm${wm.toFixed(2)}_wlc${wlc.toFixed(2)}`;
      const pay = results.reduce((s, r) => s + (r.sweep[key]?.pay || 0), 0);
      const roi = (pay / cost - 1) * 100;
      line += `  ${roi.toFixed(1).padStart(7)}%`;
    }
    console.log(line);
  }
  console.log(`v4 pool:  ${v4ROI.toFixed(2)}%`);

  console.log('\nMAHAL MEDIAN — rows=W_MULTI, cols=W_LEV_CEIL');
  hdr = '          ';
  for (const wlc of W_LEV_CEIL_VALUES) hdr += `   wlc=${wlc.toFixed(2)}`;
  console.log(hdr);
  for (const wm of W_MULTI_VALUES) {
    let line = `wm=${wm.toFixed(2)} `;
    for (const wlc of W_LEV_CEIL_VALUES) {
      const key = `wm${wm.toFixed(2)}_wlc${wlc.toFixed(2)}`;
      const ms = results.map(r => r.sweep[key]?.mahal).filter((x): x is number => x !== null && x !== undefined);
      line += `   ${median(ms).toFixed(3).padStart(7)}`;
    }
    console.log(line);
  }
  console.log(`v4 pool:  ${median(v4Mahal).toFixed(3)}`);

  console.log('\nMEAN OWN% — rows=W_MULTI, cols=W_LEV_CEIL');
  hdr = '          ';
  for (const wlc of W_LEV_CEIL_VALUES) hdr += `   wlc=${wlc.toFixed(2)}`;
  console.log(hdr);
  for (const wm of W_MULTI_VALUES) {
    let line = `wm=${wm.toFixed(2)} `;
    for (const wlc of W_LEV_CEIL_VALUES) {
      const key = `wm${wm.toFixed(2)}_wlc${wlc.toFixed(2)}`;
      const v = mean(results.map(r => r.sweep[key]?.meanOwn || 0));
      line += `  ${v.toFixed(2).padStart(7)}%`;
    }
    console.log(line);
  }
  console.log(`v4 pool:  ${mean(results.map(r => r.v4_meanOwn)).toFixed(2)}%`);

  console.log('\nMEAN PROJ — rows=W_MULTI, cols=W_LEV_CEIL');
  hdr = '          ';
  for (const wlc of W_LEV_CEIL_VALUES) hdr += `   wlc=${wlc.toFixed(2)}`;
  console.log(hdr);
  for (const wm of W_MULTI_VALUES) {
    let line = `wm=${wm.toFixed(2)} `;
    for (const wlc of W_LEV_CEIL_VALUES) {
      const key = `wm${wm.toFixed(2)}_wlc${wlc.toFixed(2)}`;
      const v = mean(results.map(r => r.sweep[key]?.meanProj || 0));
      line += `  ${v.toFixed(2).padStart(7)} `;
    }
    console.log(line);
  }
  console.log(`v4 pool:  ${mean(results.map(r => r.v4_meanProj)).toFixed(2)}`);

  // Save CSV with all combos.
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const headers = ['slate', 'F', 'P', 'top1_proj', 'top1_own',
    'v4_pay', 'v4_roi', 'v4_mahal', 'v4_meanOwn', 'v4_meanProj'];
  for (const sk of SWEEP_KEYS) {
    headers.push(`${sk.key}_pay`, `${sk.key}_roi`, `${sk.key}_mahal`, `${sk.key}_meanOwn`, `${sk.key}_meanProj`);
  }
  const csvLines = [headers.join(',')];
  for (const r of results) {
    const cols: any[] = [r.slate, r.F, r.P, r.optInfo.topActualProj.toFixed(2), r.optInfo.topActualOwn.toFixed(2),
      r.v4_pay.toFixed(2), r.v4_roi.toFixed(2), r.v4_mahal ?? '', r.v4_meanOwn.toFixed(2), r.v4_meanProj.toFixed(2)];
    for (const sk of SWEEP_KEYS) {
      const sw = r.sweep[sk.key];
      cols.push(sw.pay.toFixed(2), ((sw.pay / (N * FEE) - 1) * 100).toFixed(2),
        sw.mahal ?? '', sw.meanOwn.toFixed(2), sw.meanProj.toFixed(2));
    }
    csvLines.push(cols.join(','));
  }
  fs.writeFileSync(path.join(OUT_DIR, 'argus_v8_ownprod_sweep.csv'), csvLines.join('\n'));
  console.log(`\nSaved per-slate results to ${path.join(OUT_DIR, 'argus_v8_ownprod_sweep.csv')}`);
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
