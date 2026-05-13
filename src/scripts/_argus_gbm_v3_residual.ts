/**
 * GBM v3: predict the LOG-RESIDUAL relative to pool count.
 *
 * Problem with v1/v2: trained to predict log(actual_freq) directly. Squared-loss
 * objective optimizes the body of the distribution; chalk-tail predictions get
 * pulled toward the mean. Result: 87-91% relative error on chalk combos.
 *
 * v3 fix: target = log(actual_freq / pool_freq_smoothed) — i.e., learn the
 * multiplicative correction to pool's prediction. At inference:
 *   final_pred = pool_freq * exp(GBM_residual_pred)
 *
 * This makes pool the strong prior. When the GBM is uncertain (predicts ~0),
 * the result is pool (which we know wins on chalk). The GBM only deviates from
 * pool when it has real signal (e.g., independence-vs-stack correction in cases
 * where pool is biased).
 *
 * Compares pool-only / GBM v2 (saved) / GBM v3 on chalk combos across all 27
 * slates LOO.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as csvParse } from 'csv-parse/sync';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';

const DIR = 'C:/Users/colin/dfs opto';
const OUT_JSON = path.join(DIR, 'multi_combo_penalty_implementation', 'argus_gbm_v3_model.json');
const OUT_CSV = path.join(DIR, 'multi_combo_penalty_implementation', 'verification', 'gbm_v3_chalk_loo.csv');

const SLATES = [
  // 16 dev slates.
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
  // 11 added slates.
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

const MIN_ACTUAL = 2;
const SMALL = 1e-9;
const TRAIN_CAP = 100_000;
const PER_SLATE_CAP = 30_000;
const TOP_N_CHALK = 10;

const FEATURE_NAMES = [
  'log_pool', 'log_own', 'sameTeam', 'log_proj', 'log_sal',
  'log_gameTotalSum', 'log_saberTeamSum', 'ownPctileSum', 'projPctileSum',
  'salaryEff', 'numUniqueTeams'
] as const;

const GBM = { N_TREES: 200, MAX_DEPTH: 5, LEARNING_RATE: 0.05, MIN_LEAF: 200, N_BINS: 32, L2_LAMBDA: 1.0 };

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function median(arr: number[]): number { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }
function mean(a: number[]): number { if (!a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; }
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

interface ComboTrainRecord {
  predFreq: number; ownProduct: number; actualFreq: number; actualCount: number; sameTeam: boolean;
  projSum: number; salSum: number;
  gameTotalSum: number; saberTeamSum: number;
  ownPctileSum: number; projPctileSum: number;
  salaryEff: number; numUniqueTeams: number;
}
interface SlateData { slate: string; poolSize: number; fieldSize: number; recordsBySize: Record<number, ComboTrainRecord[]>; }

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

  let loaded;
  try { loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap }); }
  catch (e) { return null; }
  const poolLineups = Array.from(new Map(loaded.lineups.map(l => [l.hash, l])).values());

  const entryIds: string[][] = [];
  for (const e of actuals.entries) {
    const ids: string[] = []; let ok = true;
    for (const nm of e.playerNames) { const pl = nameMap.get(norm(nm)); if (!pl) { ok = false; break; } ids.push(pl.id); }
    if (ok) entryIds.push(ids.sort());
  }
  const F = entryIds.length, P = poolLineups.length;
  if (F < 100 || P < 100) return null;

  const poolCount: Record<number, Map<string, number>> = { 2: new Map(), 3: new Map(), 4: new Map(), 5: new Map() };
  for (const lu of poolLineups) {
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

  const recordsBySize: Record<number, ComboTrainRecord[]> = { 2: [], 3: [], 4: [], 5: [] };
  for (const size of [2, 3, 4, 5] as const) {
    const candKeys: { k: string; c: number }[] = [];
    for (const [k, c] of actualCount[size]) if (c >= MIN_ACTUAL) candKeys.push({ k, c });
    // Stratified sample: keep top-1000 chalk + stride sample the rest.
    candKeys.sort((a, b) => b.c - a.c);
    const KEEP_TOP = 2000;
    const keepCount = Math.min(candKeys.length, PER_SLATE_CAP);
    const subset: { k: string; c: number }[] = [];
    if (candKeys.length <= keepCount) {
      for (const x of candKeys) subset.push(x);
    } else {
      // Always keep the top KEEP_TOP chalk combos.
      for (let i = 0; i < Math.min(KEEP_TOP, candKeys.length); i++) subset.push(candKeys[i]);
      // Stride-sample the remainder.
      const remain = candKeys.slice(KEEP_TOP);
      const need = keepCount - subset.length;
      if (need > 0 && remain.length > 0) {
        const stride = remain.length / need;
        for (let i = 0; i < need; i++) subset.push(remain[Math.floor(i * stride)]);
      }
    }
    for (const { k, c } of subset) {
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
      recordsBySize[size].push({
        predFreq: (poolCount[size].get(k) || 0) / P,
        ownProduct: ownProd, actualFreq: c / F, actualCount: c,
        sameTeam: maxTeamCount === ids.length,
        projSum, salSum, gameTotalSum, saberTeamSum, ownPctileSum, projPctileSum,
        salaryEff: salSum > 0 ? projSum / (salSum / 1000) : 0,
        numUniqueTeams: teamCounts.size,
      });
    }
  }
  return { slate: s.slate, poolSize: P, fieldSize: F, recordsBySize };
}

function featurize(r: ComboTrainRecord): number[] {
  return [
    Math.log(r.predFreq + SMALL), Math.log(r.ownProduct + SMALL),
    r.sameTeam ? 1 : 0,
    Math.log(Math.max(SMALL, r.projSum)), Math.log(Math.max(SMALL, r.salSum)),
    Math.log(Math.max(SMALL, r.gameTotalSum)), Math.log(Math.max(SMALL, r.saberTeamSum)),
    r.ownPctileSum, r.projPctileSum, r.salaryEff, r.numUniqueTeams,
  ];
}
function subsample<T>(arr: T[], cap: number): T[] {
  if (arr.length <= cap) return arr;
  const stride = arr.length / cap;
  const out: T[] = []; for (let i = 0; i < cap; i++) out.push(arr[Math.floor(i * stride)]);
  return out;
}

// GBM (same as v2).
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
      const v = X[i][f]; let lo = 0, hi = dedup.length - 1;
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
    if (hist.binEdges[split.feature][b] < split.threshold) leftIdx[li++] = idx; else rightIdx[ri++] = idx;
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

async function main() {
  console.log('=== GBM v3 (residual-target: predict log(actual/pool)) ===');
  console.log(`Hyperparams: ${GBM.N_TREES} trees, depth=${GBM.MAX_DEPTH}, lr=${GBM.LEARNING_RATE}\n`);

  const slates: SlateData[] = [];
  for (const s of SLATES) {
    process.stdout.write(s.slate.padEnd(15) + ' ');
    try {
      const sd = await loadSlate(s);
      if (sd) { slates.push(sd); console.log(`F=${sd.fieldSize} P=${sd.poolSize}`); }
      else console.log('skip');
    } catch (e) { console.log('skip (' + (e as Error).message.slice(0, 50) + ')'); }
  }
  console.log(`\n${slates.length} slates loaded.\n`);

  // LOO chalk-prediction comparison: pool-only / GBM v2 (direct target) / GBM v3 (residual target).
  console.log('================================================================');
  console.log('LOO CHALK PREDICTION — top-' + TOP_N_CHALK + ' chalk combos per slate per size');
  console.log('================================================================');

  interface ChalkRec { actualPct: number; poolPct: number; v2_pct: number; v3_pct: number; }
  const looChalk: Record<number, ChalkRec[]> = { 2: [], 3: [], 4: [], 5: [] };

  for (const size of [2, 3, 4, 5] as const) {
    process.stdout.write(`Size ${size} LOO`);
    for (let i = 0; i < slates.length; i++) {
      process.stdout.write('.');
      const heldOut = slates[i];
      const train = slates.filter((_, j) => j !== i);
      const trainAll = train.flatMap(s => s.recordsBySize[size]); if (!trainAll.length) continue;
      const trainSub = subsample(trainAll, TRAIN_CAP);

      const X = trainSub.map(featurize);
      const y_v2 = trainSub.map(r => Math.log(r.actualFreq + SMALL));               // direct target
      const y_v3 = trainSub.map(r => {
        const poolSmoothed = Math.max(r.predFreq, 0.5 / heldOut.poolSize);
        return Math.log(r.actualFreq / poolSmoothed + SMALL);
      });

      const m_v2 = trainGBM(X, y_v2);
      const m_v3 = trainGBM(X, y_v3);

      // Chalk records on held-out slate.
      const heldRecs = heldOut.recordsBySize[size]; if (!heldRecs.length) continue;
      const sortedByActual = [...heldRecs].sort((a, b) => b.actualCount - a.actualCount).slice(0, TOP_N_CHALK);

      for (const r of sortedByActual) {
        const x = featurize(r);
        const v2_log = predictGBM(m_v2, x);
        const v3_residual = predictGBM(m_v3, x);
        const poolSmoothed = Math.max(r.predFreq, 0.5 / heldOut.poolSize);
        const v3_freq = Math.max(0, poolSmoothed * Math.exp(v3_residual));
        const v2_freq = Math.max(0, Math.exp(v2_log) - SMALL);
        looChalk[size].push({
          actualPct: r.actualFreq * 100,
          poolPct: r.predFreq * 100,
          v2_pct: v2_freq * 100,
          v3_pct: v3_freq * 100,
        });
      }
    }
    console.log('');
  }
  console.log('');

  console.log('================================================================');
  console.log('CHALK PREDICTION ACCURACY — pool / GBM v2 / GBM v3-residual');
  console.log('================================================================');
  console.log('size | n   | actual% med | pool med  | v2 med    | v3 med    | pool relErr | v2 relErr | v3 relErr | wins (vs pool)');
  for (const size of [2, 3, 4, 5]) {
    const rs = looChalk[size]; if (!rs.length) continue;
    const acts = rs.map(r => r.actualPct).sort((a, b) => a - b);
    const pools = rs.map(r => r.poolPct).sort((a, b) => a - b);
    const v2s = rs.map(r => r.v2_pct).sort((a, b) => a - b);
    const v3s = rs.map(r => r.v3_pct).sort((a, b) => a - b);
    const poolErr = rs.map(r => r.actualPct > 0 ? Math.abs(r.poolPct - r.actualPct) / r.actualPct : 0).sort((a, b) => a - b);
    const v2Err = rs.map(r => r.actualPct > 0 ? Math.abs(r.v2_pct - r.actualPct) / r.actualPct : 0).sort((a, b) => a - b);
    const v3Err = rs.map(r => r.actualPct > 0 ? Math.abs(r.v3_pct - r.actualPct) / r.actualPct : 0).sort((a, b) => a - b);
    const v2Wins = rs.filter(r => Math.abs(r.v2_pct - r.actualPct) < Math.abs(r.poolPct - r.actualPct)).length;
    const v3Wins = rs.filter(r => Math.abs(r.v3_pct - r.actualPct) < Math.abs(r.poolPct - r.actualPct)).length;
    console.log(`  ${size}  | ${String(rs.length).padStart(3)} | ${acts[Math.floor(acts.length / 2)].toFixed(2).padStart(10)}% | ${pools[Math.floor(pools.length / 2)].toFixed(2).padStart(8)}% | ${v2s[Math.floor(v2s.length / 2)].toFixed(2).padStart(8)}% | ${v3s[Math.floor(v3s.length / 2)].toFixed(2).padStart(8)}% | ${(poolErr[Math.floor(poolErr.length / 2)] * 100).toFixed(0).padStart(9)}% | ${(v2Err[Math.floor(v2Err.length / 2)] * 100).toFixed(0).padStart(7)}% | ${(v3Err[Math.floor(v3Err.length / 2)] * 100).toFixed(0).padStart(7)}% | v2:${v2Wins}/${rs.length} v3:${v3Wins}/${rs.length}`);
  }

  // Save final v3 model trained on all slates.
  console.log('\nFitting v3 final on all slates...');
  const finalModels: Record<number, GBMModel> = {};
  for (const size of [2, 3, 4, 5] as const) {
    const all = slates.flatMap(s => s.recordsBySize[size]); if (!all.length) continue;
    // Use median pool size for residual smoothing baseline at fit time (per-slate at predict).
    const sub = subsample(all, TRAIN_CAP);
    const X = sub.map(featurize);
    const y = sub.map(r => Math.log(r.actualFreq / Math.max(r.predFreq, 1e-4) + SMALL));
    finalModels[size] = trainGBM(X, y);
    console.log(`  size ${size}: ${finalModels[size].trees.length} trees, n_train=${sub.length}`);
  }
  if (!fs.existsSync(path.dirname(OUT_JSON))) fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify({
    generated_at: new Date().toISOString(), n_slates: slates.length,
    feature_names: FEATURE_NAMES, hyperparams: GBM, models: finalModels,
    target: 'log(actual_freq / max(pool_freq, 1/(2P)))',
    inference: 'final_pred = max(pool_freq, 1/(2P)) * exp(model_pred)',
  }, null, 2));
  console.log(`Saved v3 model to ${OUT_JSON}`);

  // CSV.
  const lines = ['size,actual_pct,pool_pct,v2_pct,v3_pct'];
  for (const size of [2, 3, 4, 5]) for (const r of looChalk[size]) {
    lines.push([size, r.actualPct.toFixed(4), r.poolPct.toFixed(4), r.v2_pct.toFixed(4), r.v3_pct.toFixed(4)].join(','));
  }
  if (!fs.existsSync(path.dirname(OUT_CSV))) fs.mkdirSync(path.dirname(OUT_CSV), { recursive: true });
  fs.writeFileSync(OUT_CSV, lines.join('\n'));
  console.log(`Saved chalk LOO eval to ${OUT_CSV}`);
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
