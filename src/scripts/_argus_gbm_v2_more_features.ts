/**
 * GBM v2: more features + deeper trees.
 *
 * Adds to the v1 feature set (log_pool, log_own, sameTeam, log_proj, log_sal):
 *   - log_gameTotalSum:        sum of Saber game Total (game-environment proxy)
 *   - log_saberTeamSum:        sum of Saber Team (team-implied-runs proxy)
 *   - own_pctile_sum:          sum of within-slate Adj Own percentile (where in
 *                              the ownership distribution this combo's players sit)
 *   - proj_pctile_sum:         sum of within-slate projection percentile
 *   - salaryEfficiency:        projSum / salSum (points per $1k salary)
 *   - numUniqueTeams:          # distinct teams represented in combo
 *
 * Deeper model: depth 6 (was 4), 300 trees (was 150), lr 0.03 (was 0.05).
 *
 * LOO compares v2 vs v1 GBM vs pool baseline.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as csvParse } from 'csv-parse/sync';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';

const DIR = 'C:/Users/colin/dfs opto';
const OUT_JSON = path.join(DIR, 'multi_combo_penalty_implementation', 'argus_gbm_v2_model.json');
const OUT_CSV = path.join(DIR, 'multi_combo_penalty_implementation', 'verification', 'gbm_v2_loo.csv');

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
const TRAIN_CAP = 100_000;

const FEATURE_NAMES_V1 = ['log_pool', 'log_own', 'sameTeam', 'log_proj', 'log_sal'] as const;
const FEATURE_NAMES_V2 = [
  'log_pool', 'log_own', 'sameTeam', 'log_proj', 'log_sal',
  'log_gameTotalSum', 'log_saberTeamSum', 'ownPctileSum', 'projPctileSum', 'salaryEff', 'numUniqueTeams'
] as const;

const GBM_V1 = { N_TREES: 150, MAX_DEPTH: 4, LEARNING_RATE: 0.05, MIN_LEAF: 200, N_BINS: 32, L2_LAMBDA: 1.0 };
const GBM_V2 = { N_TREES: 300, MAX_DEPTH: 6, LEARNING_RATE: 0.03, MIN_LEAF: 200, N_BINS: 32, L2_LAMBDA: 1.0 };

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

interface ComboTrainRecord {
  predFreq: number; ownProduct: number; actualFreq: number; sameTeam: boolean;
  projSum: number; salSum: number;
  gameTotalSum: number; saberTeamSum: number;
  ownPctileSum: number; projPctileSum: number;
  salaryEff: number; numUniqueTeams: number;
}
interface SlateData { slate: string; poolSize: number; fieldSize: number; recordsBySize: Record<number, ComboTrainRecord[]>; }

function withinSlatePercentile(values: Map<string, number>): Map<string, number> {
  // Returns percentile in [0,1] per id, based on sorted values across all ids.
  const arr: { id: string; v: number }[] = [];
  for (const [id, v] of values) arr.push({ id, v });
  arr.sort((a, b) => a.v - b.v);
  const out = new Map<string, number>();
  for (let i = 0; i < arr.length; i++) {
    out.set(arr[i].id, arr.length > 1 ? i / (arr.length - 1) : 0);
  }
  return out;
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
  // Within-slate percentiles for ownership and projection.
  const ownPctileById = withinSlatePercentile(ownDecById);
  const projPctileById = withinSlatePercentile(projById);

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

  const recordsBySize: Record<number, ComboTrainRecord[]> = { 2: [], 3: [], 4: [], 5: [] };
  for (const size of [2, 3, 4, 5] as const) {
    for (const [k, c] of actualCount[size]) {
      if (c < MIN_ACTUAL) continue;
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
        ownProduct: ownProd, actualFreq: c / F, sameTeam: maxTeamCount === ids.length,
        projSum, salSum,
        gameTotalSum, saberTeamSum, ownPctileSum, projPctileSum,
        salaryEff: salSum > 0 ? projSum / (salSum / 1000) : 0,
        numUniqueTeams: teamCounts.size,
      });
    }
  }
  return { slate: s.slate, poolSize: P, fieldSize: F, recordsBySize };
}

function featurizeV1(r: ComboTrainRecord): number[] {
  return [
    Math.log(r.predFreq + SMALL), Math.log(r.ownProduct + SMALL),
    r.sameTeam ? 1 : 0,
    Math.log(Math.max(SMALL, r.projSum)), Math.log(Math.max(SMALL, r.salSum)),
  ];
}
function featurizeV2(r: ComboTrainRecord): number[] {
  return [
    Math.log(r.predFreq + SMALL), Math.log(r.ownProduct + SMALL),
    r.sameTeam ? 1 : 0,
    Math.log(Math.max(SMALL, r.projSum)), Math.log(Math.max(SMALL, r.salSum)),
    Math.log(Math.max(SMALL, r.gameTotalSum)), Math.log(Math.max(SMALL, r.saberTeamSum)),
    r.ownPctileSum, r.projPctileSum,
    r.salaryEff, r.numUniqueTeams,
  ];
}
function subsample<T>(arr: T[], cap: number): T[] {
  if (arr.length <= cap) return arr;
  const stride = arr.length / cap;
  const out: T[] = []; for (let i = 0; i < cap; i++) out.push(arr[Math.floor(i * stride)]);
  return out;
}

// ===== GBM (same as before) =====
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
function trainGBM(X: number[][], y: number[], cfg: typeof GBM_V1): GBMModel {
  const n = X.length;
  const hist = buildHistogram(X, cfg.N_BINS);
  const basePred = mean(y);
  const preds = new Float64Array(n).fill(basePred);
  const residuals = new Float64Array(n);
  for (let i = 0; i < n; i++) residuals[i] = y[i] - basePred;
  const trees: TreeNode[] = [];
  const allIdx = new Uint32Array(n); for (let i = 0; i < n; i++) allIdx[i] = i;
  for (let t = 0; t < cfg.N_TREES; t++) {
    const tree = buildTree(hist, residuals, allIdx, 0, cfg.MAX_DEPTH, cfg.L2_LAMBDA, cfg.MIN_LEAF);
    for (let i = 0; i < n; i++) {
      const inc = cfg.LEARNING_RATE * predictTree(tree, X[i]);
      preds[i] += inc; residuals[i] = y[i] - preds[i];
    }
    trees.push(tree);
  }
  return { trees, basePred, learningRate: cfg.LEARNING_RATE };
}
function predictGBM(model: GBMModel, x: number[]): number {
  let p = model.basePred;
  for (const tree of model.trees) p += model.learningRate * predictTree(tree, x);
  return p;
}

interface ModelEval { pearson_log: number; median_relErr: number; median_absErr_pct: number; }
function evalModel(records: ComboTrainRecord[], predictFn: (r: ComboTrainRecord) => number): ModelEval {
  if (!records.length) return { pearson_log: 0, median_relErr: 0, median_absErr_pct: 0 };
  const pred: number[] = [], act: number[] = [];
  const relErrs: number[] = []; const absErrs: number[] = [];
  for (const r of records) {
    const p = Math.max(0, predictFn(r));
    pred.push(Math.log(p + SMALL));
    act.push(Math.log(r.actualFreq + SMALL));
    const aPct = r.actualFreq * 100; const pPct = p * 100;
    relErrs.push(aPct > 0 ? Math.abs(pPct - aPct) / aPct : 0);
    absErrs.push(Math.abs(pPct - aPct));
  }
  return { pearson_log: pearson(pred, act), median_relErr: median(relErrs), median_absErr_pct: median(absErrs) };
}

async function main() {
  console.log('=== GBM v2 (more features + deeper trees) — LOO across 16 dev slates ===\n');
  console.log(`v1 hyperparams: ${GBM_V1.N_TREES}T depth=${GBM_V1.MAX_DEPTH} lr=${GBM_V1.LEARNING_RATE} (5 features)`);
  console.log(`v2 hyperparams: ${GBM_V2.N_TREES}T depth=${GBM_V2.MAX_DEPTH} lr=${GBM_V2.LEARNING_RATE} (${FEATURE_NAMES_V2.length} features)\n`);

  const slates: SlateData[] = [];
  for (const s of SLATES) {
    process.stdout.write(s.slate.padEnd(15) + ' ');
    const sd = await loadSlate(s);
    if (sd) { slates.push(sd); console.log(`F=${sd.fieldSize} P=${sd.poolSize}`); }
    else { console.log('skip'); }
  }
  console.log(`\n${slates.length} slates loaded.\n`);

  console.log('================================================================');
  console.log('LOO VALIDATION');
  console.log('================================================================');
  console.log('size | model    | mean Pearson | median relErr | median absErr%');

  interface LooCell { pearson_log: number; median_relErr: number; median_absErr_pct: number }
  const loo: Record<number, Record<string, LooCell[]>> = { 2: {}, 3: {}, 4: {}, 5: {} };

  for (const size of [2, 3, 4, 5] as const) {
    loo[size]['pool'] = []; loo[size]['gbm_v1'] = []; loo[size]['gbm_v2'] = [];
    process.stdout.write(`\nSize ${size} LOO`);
    for (let i = 0; i < slates.length; i++) {
      process.stdout.write('.');
      const heldOut = slates[i];
      const train = slates.filter((_, j) => j !== i);
      const trainAll = train.flatMap(s => s.recordsBySize[size]);
      if (trainAll.length < 100) continue;
      const trainSub = subsample(trainAll, TRAIN_CAP);
      const y = trainSub.map(r => Math.log(r.actualFreq + SMALL));

      const X1 = trainSub.map(featurizeV1);
      const X2 = trainSub.map(featurizeV2);
      const m1 = trainGBM(X1, y, GBM_V1);
      const m2 = trainGBM(X2, y, GBM_V2);

      const heldRecs = heldOut.recordsBySize[size]; if (!heldRecs.length) continue;

      loo[size]['pool'].push(evalModel(heldRecs, r => r.predFreq > 0 ? r.predFreq : 0.5 / heldOut.poolSize));
      loo[size]['gbm_v1'].push(evalModel(heldRecs, r => Math.exp(predictGBM(m1, featurizeV1(r))) - SMALL));
      loo[size]['gbm_v2'].push(evalModel(heldRecs, r => Math.exp(predictGBM(m2, featurizeV2(r))) - SMALL));
    }
    console.log('');
  }
  console.log('\n');

  for (const size of [2, 3, 4, 5]) {
    for (const model of ['pool', 'gbm_v1', 'gbm_v2']) {
      const rs = loo[size][model]; if (!rs.length) continue;
      const mP = mean(rs.map(r => r.pearson_log));
      const mR = mean(rs.map(r => r.median_relErr));
      const mA = mean(rs.map(r => r.median_absErr_pct));
      console.log(`  ${size}  | ${model.padEnd(8)} | ${mP.toFixed(3).padStart(11)} | ${(mR * 100).toFixed(0).padStart(11)}% | ${mA.toFixed(3).padStart(13)}%`);
    }
    console.log('');
  }

  // Per-slate v2 vs v1 wins.
  console.log('Per-slate GBM-v2 vs GBM-v1:');
  for (const size of [2, 3, 4, 5]) {
    const v1 = loo[size]['gbm_v1']; const v2 = loo[size]['gbm_v2'];
    if (!v1.length) continue;
    const winP = v2.filter((r, i) => r.pearson_log > v1[i].pearson_log).length;
    const winR = v2.filter((r, i) => r.median_relErr < v1[i].median_relErr).length;
    const winA = v2.filter((r, i) => r.median_absErr_pct < v1[i].median_absErr_pct).length;
    console.log(`  size ${size}: Pearson ${winP}/${v1.length} | relErr ${winR}/${v1.length} | absErr ${winA}/${v1.length}`);
  }

  // Save final v2 fit on all slates.
  console.log('\nFitting v2 final on all slates...');
  const finalModels: Record<number, GBMModel> = {};
  for (const size of [2, 3, 4, 5] as const) {
    const all = slates.flatMap(s => s.recordsBySize[size]);
    if (all.length < 100) continue;
    const sub = subsample(all, TRAIN_CAP);
    const X = sub.map(featurizeV2); const y = sub.map(r => Math.log(r.actualFreq + SMALL));
    finalModels[size] = trainGBM(X, y, GBM_V2);
    console.log(`  size ${size}: ${finalModels[size].trees.length} trees, n_train=${sub.length}`);
  }

  if (!fs.existsSync(path.dirname(OUT_JSON))) fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify({
    generated_at: new Date().toISOString(), n_slates: slates.length,
    feature_names: FEATURE_NAMES_V2, hyperparams: GBM_V2, models: finalModels,
  }, null, 2));
  console.log(`Saved v2 model to ${OUT_JSON}`);

  if (!fs.existsSync(path.dirname(OUT_CSV))) fs.mkdirSync(path.dirname(OUT_CSV), { recursive: true });
  const lines = ['size,model,slate_idx,pearson_log,median_relErr,median_absErr_pct'];
  for (const size of [2, 3, 4, 5]) for (const model of ['pool', 'gbm_v1', 'gbm_v2']) {
    loo[size][model].forEach((r, i) => {
      lines.push([size, model, i, r.pearson_log.toFixed(4), r.median_relErr.toFixed(4), r.median_absErr_pct.toFixed(4)].join(','));
    });
  }
  fs.writeFileSync(OUT_CSV, lines.join('\n'));
  console.log(`Saved LOO eval to ${OUT_CSV}`);
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
