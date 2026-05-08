/**
 * Gradient-boosted regression tree (GBRT) model for combo-frequency prediction.
 *
 * Same features as the OLS multi-feature model (log_pool, log_own, sameTeam,
 * log_proj, log_sal) but fit with shallow trees + boosting to capture
 * non-linear interactions OLS misses.
 *
 * Implementation: histogram-based regression GBM, depth=4, lr=0.05,
 * 200 trees per (size, fold). Pure TS, no external ML deps.
 *
 * LOO-validated against pool-only and OLS multi-feature models.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as csvParse } from 'csv-parse/sync';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';

const DIR = 'C:/Users/colin/dfs opto';
const OUT_JSON = path.join(DIR, 'multi_combo_penalty_implementation', 'argus_gbm_model.json');
const OUT_CSV = path.join(DIR, 'multi_combo_penalty_implementation', 'verification', 'gbm_loo.csv');

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
];

const MIN_ACTUAL = 2;
const SMALL = 1e-9;
const TRAIN_CAP = 100_000;          // smaller for tree fitting speed
const FEATURE_NAMES = ['log_pool', 'log_own', 'sameTeam', 'log_proj', 'log_sal'] as const;
const N_FEATURES = FEATURE_NAMES.length;

const GBM = {
  N_TREES: 150,
  MAX_DEPTH: 4,
  LEARNING_RATE: 0.05,
  MIN_LEAF: 200,
  N_BINS: 32,                 // histogram bins per feature
  L2_LAMBDA: 1.0,
};

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function median(arr: number[]): number { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }
function mean(a: number[]): number { if (!a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; }
function pearson(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length); if (n < 2) return 0;
  const mx = mean(x), my = mean(y);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = x[i] - mx, b = y[i] - my; num += a * b; dx += a * a; dy += b * b; }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
}
function loadAdjOwn(p: string): Map<string, number> {
  if (!fs.existsSync(p)) return new Map();
  const records = csvParse(fs.readFileSync(p, 'utf-8'), { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
  const out = new Map<string, number>();
  for (const r of records) {
    const id = (r['DFS ID'] || r['ID'] || '').trim();
    if (!id) continue;
    const v = parseFloat((r['Adj Own'] || '').replace(/[%,]/g, ''));
    if (!Number.isNaN(v)) out.set(id, Math.max(0, v));
  }
  return out;
}

interface ComboRecord {
  predFreq: number; ownProduct: number; actualFreq: number;
  sameTeam: boolean; projSum: number; salSum: number;
}
interface SlateData { slate: string; poolSize: number; fieldSize: number; recordsBySize: Record<number, ComboRecord[]>; }

async function loadSlate(s: typeof SLATES[0]): Promise<SlateData | null> {
  const projPath = path.join(DIR, s.proj), actualsPath = path.join(DIR, s.actuals), poolPath = path.join(DIR, s.pool);
  if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) return null;
  const pr = parseCSVFile(projPath, 'mlb', true);
  const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
  const pool = buildPlayerPool(pr.players, pr.detectedContestType);
  const actuals = parseContestActuals(actualsPath, config);
  const adjOwnById = loadAdjOwn(projPath);
  const idMap = new Map<string, Player>(); const nameMap = new Map<string, Player>();
  const teamById = new Map<string, string>(); const ownDecById = new Map<string, number>();
  const projById = new Map<string, number>(); const salById = new Map<string, number>();
  for (const p of pool.players) {
    idMap.set(p.id, p); nameMap.set(norm(p.name), p);
    teamById.set(p.id, (p.team || '').toUpperCase());
    const adj = adjOwnById.get(p.id);
    ownDecById.set(p.id, Math.max(0, (adj !== undefined ? adj : (p.ownership || 0)) / 100));
    projById.set(p.id, p.projection || 0);
    salById.set(p.id, p.salary || 0);
  }
  const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
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
  const recordsBySize: Record<number, ComboRecord[]> = { 2: [], 3: [], 4: [], 5: [] };
  for (const size of [2, 3, 4, 5] as const) {
    for (const [k, c] of actualCount[size]) {
      if (c < MIN_ACTUAL) continue;
      const ids = k.split('|');
      let projSum = 0, salSum = 0; let ownProd = 1;
      const teamCounts = new Map<string, number>();
      for (const id of ids) {
        ownProd *= (ownDecById.get(id) || 0);
        projSum += projById.get(id) || 0;
        salSum += salById.get(id) || 0;
        const t = teamById.get(id) || '?';
        teamCounts.set(t, (teamCounts.get(t) || 0) + 1);
      }
      let maxTeamCount = 0;
      for (const v of teamCounts.values()) if (v > maxTeamCount) maxTeamCount = v;
      recordsBySize[size].push({
        predFreq: (poolCount[size].get(k) || 0) / P,
        ownProduct: ownProd, actualFreq: c / F,
        sameTeam: maxTeamCount === ids.length, projSum, salSum,
      });
    }
  }
  return { slate: s.slate, poolSize: P, fieldSize: F, recordsBySize };
}

function featurize(r: ComboRecord): number[] {
  return [
    Math.log(r.predFreq + SMALL),
    Math.log(r.ownProduct + SMALL),
    r.sameTeam ? 1 : 0,
    Math.log(Math.max(SMALL, r.projSum)),
    Math.log(Math.max(SMALL, r.salSum)),
  ];
}

function subsample<T>(arr: T[], cap: number): T[] {
  if (arr.length <= cap) return arr;
  const stride = arr.length / cap;
  const out: T[] = [];
  for (let i = 0; i < cap; i++) out.push(arr[Math.floor(i * stride)]);
  return out;
}

// ===== Histogram-based GBRT =====

interface TreeNode {
  feature?: number;
  threshold?: number;       // bin threshold (in original feature space)
  left?: TreeNode;
  right?: TreeNode;
  leafValue?: number;
}

interface Histogram {
  binEdges: number[][];     // [feature][edge_idx] — N_BINS+1 edges per feature
  X_bin: Uint8Array;        // [n × n_features] bin index
}

function buildHistogram(X: number[][], nBins: number): Histogram {
  const n = X.length, k = X[0].length;
  const binEdges: number[][] = [];
  const X_bin = new Uint8Array(n * k);
  for (let f = 0; f < k; f++) {
    const col: number[] = []; for (let i = 0; i < n; i++) col.push(X[i][f]);
    const sorted = [...col].sort((a, b) => a - b);
    // Quantile bin edges so each bin has ~equal samples (avoids degenerate splits on heavy-tailed features).
    const edges: number[] = [];
    for (let b = 0; b <= nBins; b++) {
      const idx = Math.min(sorted.length - 1, Math.floor(b * sorted.length / nBins));
      edges.push(sorted[idx]);
    }
    // Dedupe edges (binary features collapse).
    const dedup = Array.from(new Set(edges)).sort((a, b) => a - b);
    binEdges.push(dedup);
    // Bin assignments.
    for (let i = 0; i < n; i++) {
      const v = X[i][f];
      // Binary search for last edge ≤ v.
      let lo = 0, hi = dedup.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1;
        if (dedup[mid] <= v) lo = mid; else hi = mid - 1;
      }
      X_bin[i * k + f] = Math.min(255, lo);
    }
  }
  return { binEdges, X_bin };
}

interface SplitResult { feature: number; threshold: number; gain: number; leftSum: number; leftCount: number; rightSum: number; rightCount: number }

function findBestSplit(
  hist: Histogram, residuals: Float64Array, indices: Uint32Array, lambda: number, minLeaf: number
): SplitResult | null {
  const k = hist.binEdges.length;
  const n = indices.length;
  let totalSum = 0;
  for (let i = 0; i < n; i++) totalSum += residuals[indices[i]];
  const totalCount = n;

  let best: SplitResult | null = null;

  for (let f = 0; f < k; f++) {
    const nBins = hist.binEdges[f].length;
    if (nBins < 2) continue;
    const binSum = new Float64Array(nBins);
    const binCount = new Uint32Array(nBins);
    for (let i = 0; i < n; i++) {
      const idx = indices[i];
      const b = hist.X_bin[idx * k + f];
      binSum[b] += residuals[idx];
      binCount[b]++;
    }
    // Splitting at bin b means left = bins 0..b, right = bins b+1..nBins-1.
    // Threshold for `v < threshold ⟺ bin ≤ b` is binEdges[b+1].
    let leftSum = 0, leftCount = 0;
    for (let b = 0; b < nBins - 1; b++) {
      leftSum += binSum[b]; leftCount += binCount[b];
      const rightSum = totalSum - leftSum;
      const rightCount = totalCount - leftCount;
      if (leftCount < minLeaf || rightCount < minLeaf) continue;
      const gain = (leftSum * leftSum) / (leftCount + lambda)
                 + (rightSum * rightSum) / (rightCount + lambda)
                 - (totalSum * totalSum) / (totalCount + lambda);
      if (!best || gain > best.gain) {
        best = {
          feature: f, threshold: hist.binEdges[f][b + 1],
          gain, leftSum, leftCount, rightSum, rightCount,
        };
      }
    }
  }
  return best;
}

function buildTree(
  hist: Histogram, residuals: Float64Array, indices: Uint32Array,
  depth: number, maxDepth: number, lambda: number, minLeaf: number
): TreeNode {
  if (depth >= maxDepth || indices.length < 2 * minLeaf) {
    let s = 0; for (let i = 0; i < indices.length; i++) s += residuals[indices[i]];
    const leafValue = s / (indices.length + lambda);
    return { leafValue };
  }
  const split = findBestSplit(hist, residuals, indices, lambda, minLeaf);
  if (!split || split.gain <= 0) {
    let s = 0; for (let i = 0; i < indices.length; i++) s += residuals[indices[i]];
    const leafValue = s / (indices.length + lambda);
    return { leafValue };
  }
  // Partition. With threshold = binEdges[splitBin+1], use strict `<` to put
  // rows with bin ≤ splitBin to the left.
  const leftIdx = new Uint32Array(split.leftCount);
  const rightIdx = new Uint32Array(split.rightCount);
  let li = 0, ri = 0;
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i];
    const b = hist.X_bin[idx * hist.binEdges.length + split.feature];
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
  while (n.feature !== undefined) {
    if (x[n.feature] < n.threshold!) n = n.left!; else n = n.right!;
  }
  return n.leafValue || 0;
}

interface GBMModel { trees: TreeNode[]; basePred: number; learningRate: number; }

function trainGBM(X: number[][], y: number[]): GBMModel {
  const n = X.length;
  // Build histograms once (constant across boosting rounds).
  const hist = buildHistogram(X, GBM.N_BINS);
  const basePred = mean(y);
  const preds = new Float64Array(n).fill(basePred);
  const residuals = new Float64Array(n);
  for (let i = 0; i < n; i++) residuals[i] = y[i] - basePred;

  const trees: TreeNode[] = [];
  const allIdx = new Uint32Array(n); for (let i = 0; i < n; i++) allIdx[i] = i;

  for (let t = 0; t < GBM.N_TREES; t++) {
    const tree = buildTree(hist, residuals, allIdx, 0, GBM.MAX_DEPTH, GBM.L2_LAMBDA, GBM.MIN_LEAF);
    // Update predictions and residuals.
    for (let i = 0; i < n; i++) {
      const inc = GBM.LEARNING_RATE * predictTree(tree, X[i]);
      preds[i] += inc;
      residuals[i] = y[i] - preds[i];
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

interface ModelEval { pearson_log: number; median_relErr: number; median_absErr_pct: number; }
function evalModel(records: ComboRecord[], predictFn: (r: ComboRecord) => number): ModelEval {
  if (!records.length) return { pearson_log: 0, median_relErr: 0, median_absErr_pct: 0 };
  const pred: number[] = [], act: number[] = [];
  const relErrs: number[] = []; const absErrs: number[] = [];
  for (const r of records) {
    const p = Math.max(0, predictFn(r));
    pred.push(Math.log(p + SMALL));
    act.push(Math.log(r.actualFreq + SMALL));
    const aPct = r.actualFreq * 100;
    const pPct = p * 100;
    relErrs.push(aPct > 0 ? Math.abs(pPct - aPct) / aPct : 0);
    absErrs.push(Math.abs(pPct - aPct));
  }
  return { pearson_log: pearson(pred, act), median_relErr: median(relErrs), median_absErr_pct: median(absErrs) };
}

async function main() {
  console.log('=== GBM combo-frequency model — LOO across 16 dev slates ===');
  console.log(`Hyperparams: ${GBM.N_TREES} trees, depth=${GBM.MAX_DEPTH}, lr=${GBM.LEARNING_RATE}, minLeaf=${GBM.MIN_LEAF}, bins=${GBM.N_BINS}, λ=${GBM.L2_LAMBDA}\n`);

  const slates: SlateData[] = [];
  for (const s of SLATES) {
    process.stdout.write(s.slate.padEnd(15) + ' ');
    const sd = await loadSlate(s);
    if (sd) {
      slates.push(sd);
      console.log(`F=${sd.fieldSize} P=${sd.poolSize}`);
    } else { console.log('skip'); }
  }
  console.log(`\n${slates.length} slates loaded.\n`);

  console.log('================================================================');
  console.log('LOO VALIDATION — pool / OLS multi / GBM');
  console.log('================================================================');
  console.log('size | model | mean Pearson | median relErr | median absErr%');

  interface LooCell { pearson_log: number; median_relErr: number; median_absErr_pct: number }
  const looResults: Record<number, Record<string, LooCell[]>> = { 2: {}, 3: {}, 4: {}, 5: {} };

  for (const size of [2, 3, 4, 5] as const) {
    looResults[size]['pool'] = []; looResults[size]['gbm'] = [];
    process.stdout.write(`\nSize ${size} LOO`);
    for (let i = 0; i < slates.length; i++) {
      process.stdout.write('.');
      const heldOut = slates[i];
      const train = slates.filter((_, j) => j !== i);
      const trainAll = train.flatMap(s => s.recordsBySize[size]);
      if (trainAll.length < 100) continue;
      const trainSub = subsample(trainAll, TRAIN_CAP);
      const X = trainSub.map(featurize); const y = trainSub.map(r => Math.log(r.actualFreq + SMALL));
      const model = trainGBM(X, y);

      const heldRecs = heldOut.recordsBySize[size];
      if (!heldRecs.length) continue;

      const poolE = evalModel(heldRecs, r => r.predFreq > 0 ? r.predFreq : 0.5 / heldOut.poolSize);
      const gbmE = evalModel(heldRecs, r => Math.exp(predictGBM(model, featurize(r))) - SMALL);
      looResults[size]['pool'].push(poolE);
      looResults[size]['gbm'].push(gbmE);
    }
    console.log('');
  }

  console.log('\n');
  for (const size of [2, 3, 4, 5]) {
    for (const model of ['pool', 'gbm']) {
      const rs = looResults[size][model]; if (!rs.length) continue;
      const mP = mean(rs.map(r => r.pearson_log));
      const mR = mean(rs.map(r => r.median_relErr));
      const mA = mean(rs.map(r => r.median_absErr_pct));
      const cell = `  ${size}  | ${model.padEnd(5)} | ${mP.toFixed(3).padStart(11)} | ${(mR * 100).toFixed(0).padStart(11)}% | ${mA.toFixed(3).padStart(13)}%`;
      console.log(cell);
    }
    console.log('');
  }

  // GBM wins per slate.
  console.log('\nPer-slate GBM-vs-pool wins:');
  for (const size of [2, 3, 4, 5]) {
    const pool = looResults[size]['pool']; const gbm = looResults[size]['gbm'];
    if (!pool.length) continue;
    const winPearson = gbm.filter((g, i) => g.pearson_log > pool[i].pearson_log).length;
    const winRelErr  = gbm.filter((g, i) => g.median_relErr < pool[i].median_relErr).length;
    const winAbsErr  = gbm.filter((g, i) => g.median_absErr_pct < pool[i].median_absErr_pct).length;
    console.log(`  size ${size}: Pearson ${winPearson}/${pool.length}  relErr ${winRelErr}/${pool.length}  absErr ${winAbsErr}/${pool.length}`);
  }

  // Final model trained on all slates per size — save.
  console.log('\nFinal fit on all slates...');
  const finalModels: Record<number, GBMModel> = {};
  for (const size of [2, 3, 4, 5] as const) {
    const all = slates.flatMap(s => s.recordsBySize[size]);
    if (all.length < 100) continue;
    const sub = subsample(all, TRAIN_CAP);
    const X = sub.map(featurize); const y = sub.map(r => Math.log(r.actualFreq + SMALL));
    finalModels[size] = trainGBM(X, y);
    console.log(`  size ${size}: ${finalModels[size].trees.length} trees, train n=${sub.length}`);
  }

  if (!fs.existsSync(path.dirname(OUT_JSON))) fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify({
    generated_at: new Date().toISOString(),
    n_slates: slates.length,
    feature_names: FEATURE_NAMES,
    hyperparams: GBM,
    models: finalModels,
  }, null, 2));
  console.log(`Saved GBM model to ${OUT_JSON}`);

  if (!fs.existsSync(path.dirname(OUT_CSV))) fs.mkdirSync(path.dirname(OUT_CSV), { recursive: true });
  const lines = ['size,model,slate_idx,pearson_log,median_relErr,median_absErr_pct'];
  for (const size of [2, 3, 4, 5]) for (const model of ['pool', 'gbm']) {
    looResults[size][model].forEach((r, i) => {
      lines.push([size, model, i, r.pearson_log.toFixed(4), r.median_relErr.toFixed(4), r.median_absErr_pct.toFixed(4)].join(','));
    });
  }
  fs.writeFileSync(OUT_CSV, lines.join('\n'));
  console.log(`Saved LOO eval to ${OUT_CSV}`);
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
