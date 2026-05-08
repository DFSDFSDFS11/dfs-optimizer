/**
 * Multi-feature combo-frequency model.
 *
 * Per combo size, fit a log-linear regression:
 *   log(actual_freq + ε) = β₀
 *                       + β₁ · log(pool_freq + ε)        // SS pool count signal
 *                       + β₂ · log(own_product + ε)      // ownership independence signal
 *                       + β₃ · sameTeam                  // same-team indicator
 *                       + β₄ · log(proj_sum)             // projection signal
 *                       + β₅ · log(sal_sum)              // salary signal
 *                       + β₆ · maxTeamCount              // stack indicator (ints)
 *                       + β₇ · numPitchers
 *
 * Solved by ordinary least squares on each (size). Per-slate fit yields a
 * single feature-weight vector per size, applied at predict time.
 *
 * Compares 3 models:
 *   - pool-only        (Argus-v4 current)
 *   - own-product only (independence; v1-v3)
 *   - multi-feature    (new)
 *
 * LOO-validated across 16 dev slates.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as csvParse } from 'csv-parse/sync';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';

const DIR = 'C:/Users/colin/dfs opto';
const OUT_JSON = path.join(DIR, 'multi_combo_penalty_implementation', 'argus_multifeature_model.json');
const OUT_CSV = path.join(DIR, 'multi_combo_penalty_implementation', 'verification', 'multifeature_loo.csv');

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

const FEATURE_NAMES = ['log_pool', 'log_own', 'sameTeam', 'log_proj', 'log_sal'] as const;
type FeatureVec = number[];

/** Subsample for OLS to avoid OOM on size 4/5 (≥2M records). */
const TRAIN_CAP = 200_000;
function subsample<T>(arr: T[], cap: number, seed = 17): T[] {
  if (arr.length <= cap) return arr;
  // Deterministic stride sample so LOO folds align.
  const stride = arr.length / cap;
  const out: T[] = [];
  for (let i = 0; i < cap; i++) out.push(arr[Math.floor(i * stride)]);
  return out;
}

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
  predFreq: number;     // pool count / pool size
  ownProduct: number;   // Π own (decimal)
  actualFreq: number;   // contest count / field size
  sameTeam: boolean;
  projSum: number;
  salSum: number;
  maxTeamCount: number;
  numPitchers: number;
}

interface SlateData {
  slate: string;
  poolSize: number;
  fieldSize: number;
  recordsBySize: Record<number, ComboRecord[]>;
}

async function loadSlate(s: typeof SLATES[0]): Promise<SlateData | null> {
  const projPath = path.join(DIR, s.proj), actualsPath = path.join(DIR, s.actuals), poolPath = path.join(DIR, s.pool);
  if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) return null;
  const pr = parseCSVFile(projPath, 'mlb', true);
  const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
  const pool = buildPlayerPool(pr.players, pr.detectedContestType);
  const actuals = parseContestActuals(actualsPath, config);
  const adjOwnById = loadAdjOwn(projPath);
  const idMap = new Map<string, Player>(); const nameMap = new Map<string, Player>();
  const teamById = new Map<string, string>();
  const ownDecById = new Map<string, number>();
  const projById = new Map<string, number>();
  const salById = new Map<string, number>();
  const isPitcherById = new Map<string, boolean>();
  for (const p of pool.players) {
    idMap.set(p.id, p);
    nameMap.set(norm(p.name), p);
    teamById.set(p.id, (p.team || '').toUpperCase());
    const adj = adjOwnById.get(p.id);
    ownDecById.set(p.id, Math.max(0, (adj !== undefined ? adj : (p.ownership || 0)) / 100));
    projById.set(p.id, p.projection || 0);
    salById.set(p.id, p.salary || 0);
    isPitcherById.set(p.id, (p.position || '').toUpperCase().includes('P'));
  }
  const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
  const poolLineups = Array.from(new Map(loaded.lineups.map(l => [l.hash, l])).values());

  const entryIds: string[][] = [];
  for (const e of actuals.entries) {
    const ids: string[] = []; let ok = true;
    for (const nm of e.playerNames) { const pl = nameMap.get(norm(nm)); if (!pl) { ok = false; break; } ids.push(pl.id); }
    if (ok) entryIds.push(ids.sort());
  }
  const F = entryIds.length;
  const P = poolLineups.length;
  if (F < 100 || P < 100) return null;

  const poolCount: Record<number, Map<string, number>> = { 2: new Map(), 3: new Map(), 4: new Map(), 5: new Map() };
  for (const lu of poolLineups) {
    const ids = lu.players.map(p => p.id).sort();
    const n = ids.length;
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
      let projSum = 0, salSum = 0;
      let numPitchers = 0;
      const teamCounts = new Map<string, number>();
      let ownProd = 1;
      for (const id of ids) {
        ownProd *= (ownDecById.get(id) || 0);
        projSum += projById.get(id) || 0;
        salSum += salById.get(id) || 0;
        if (isPitcherById.get(id)) numPitchers++;
        const t = teamById.get(id) || '?';
        teamCounts.set(t, (teamCounts.get(t) || 0) + 1);
      }
      let maxTeamCount = 0;
      for (const v of teamCounts.values()) if (v > maxTeamCount) maxTeamCount = v;
      const sameTeam = maxTeamCount === ids.length;
      recordsBySize[size].push({
        predFreq: (poolCount[size].get(k) || 0) / P,
        ownProduct: ownProd,
        actualFreq: c / F,
        sameTeam, projSum, salSum, maxTeamCount, numPitchers,
      });
    }
  }
  return { slate: s.slate, poolSize: P, fieldSize: F, recordsBySize };
}

function featurize(r: ComboRecord): FeatureVec {
  return [
    Math.log(r.predFreq + SMALL),
    Math.log(r.ownProduct + SMALL),
    r.sameTeam ? 1 : 0,
    Math.log(Math.max(SMALL, r.projSum)),
    Math.log(Math.max(SMALL, r.salSum)),
  ];
}

/**
 * Solve OLS β = (XᵀX)⁻¹ Xᵀy via Gauss-Jordan elimination on small (k+1)×(k+1)
 * normal equations. With ≤ 7 features this is trivial.
 */
function solveOLS(X: FeatureVec[], y: number[]): { intercept: number; coefs: number[] } {
  if (X.length < 10) return { intercept: 0, coefs: X[0]?.map(() => 0) || [] };
  const k = X[0].length;
  // Augmented design with leading 1 for intercept.
  const Xa = X.map(row => [1, ...row]);
  // Build normal equations XᵀX (size k+1 × k+1) and Xᵀy (size k+1).
  const A: number[][] = [];
  for (let i = 0; i <= k; i++) { A.push(new Array(k + 1 + 1).fill(0)); }
  for (let i = 0; i <= k; i++) {
    for (let j = 0; j <= k; j++) {
      let s = 0;
      for (let n = 0; n < Xa.length; n++) s += Xa[n][i] * Xa[n][j];
      A[i][j] = s;
    }
    let s = 0;
    for (let n = 0; n < Xa.length; n++) s += Xa[n][i] * y[n];
    A[i][k + 1] = s;
  }
  // Gauss-Jordan with partial pivoting.
  for (let col = 0; col <= k; col++) {
    let piv = col; for (let r = col + 1; r <= k; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-12) continue;
    if (piv !== col) { const tmp = A[col]; A[col] = A[piv]; A[piv] = tmp; }
    const div = A[col][col];
    for (let j = 0; j <= k + 1; j++) A[col][j] /= div;
    for (let r = 0; r <= k; r++) {
      if (r === col) continue;
      const f = A[r][col];
      for (let j = 0; j <= k + 1; j++) A[r][j] -= f * A[col][j];
    }
  }
  const beta = A.map(row => row[k + 1]);
  return { intercept: beta[0], coefs: beta.slice(1) };
}

function predict(beta: { intercept: number; coefs: number[] }, x: FeatureVec): number {
  let dot = beta.intercept;
  for (let i = 0; i < x.length; i++) dot += beta.coefs[i] * x[i];
  return Math.exp(dot) - SMALL;
}

interface ModelEval {
  pearson_log: number;
  median_relErr: number;
  median_absErr_pct: number;
}
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
  console.log('=== Multi-feature combo-frequency model (LOO across 16 dev slates) ===\n');

  const slates: SlateData[] = [];
  for (const s of SLATES) {
    process.stdout.write(s.slate.padEnd(15) + ' ');
    const sd = await loadSlate(s);
    if (sd) {
      slates.push(sd);
      console.log(`F=${sd.fieldSize} P=${sd.poolSize} s2=${sd.recordsBySize[2].length}`);
    } else {
      console.log('skip');
    }
  }
  console.log(`\n${slates.length} slates loaded.\n`);

  // --- Final fit on ALL slates (this is what we'd ship) ---
  const finalCoefs: Record<number, { intercept: number; coefs: number[] }> = {};
  console.log('================================================================');
  console.log('FINAL MULTI-FEATURE COEFFICIENTS (fit on all 16 slates)');
  console.log('================================================================');
  console.log('size | intercept | ' + FEATURE_NAMES.join(' | '));
  for (const size of [2, 3, 4, 5] as const) {
    const all = slates.flatMap(s => s.recordsBySize[size]);
    if (all.length < 100) continue;
    const sub = subsample(all, TRAIN_CAP);
    const X = sub.map(featurize); const y = sub.map(r => Math.log(r.actualFreq + SMALL));
    const beta = solveOLS(X, y);
    finalCoefs[size] = beta;
    console.log(`  ${size}  | ${beta.intercept.toFixed(3).padStart(8)} | ` + beta.coefs.map(c => c.toFixed(3).padStart(8)).join(' | ') + `  (n_train=${sub.length})`);
  }
  console.log('');

  // --- LOO ---
  console.log('================================================================');
  console.log('LOO VALIDATION — pool-only vs own-only vs multi-feature');
  console.log('================================================================');
  console.log('size | model         | mean Pearson | median relErr | median absErr%');

  interface LooCell { pearson_log: number; median_relErr: number; median_absErr_pct: number }
  const looResults: Record<number, Record<string, LooCell[]>> = { 2: {}, 3: {}, 4: {}, 5: {} };

  for (const size of [2, 3, 4, 5] as const) {
    looResults[size]['pool'] = []; looResults[size]['own'] = []; looResults[size]['multi'] = [];
    for (let i = 0; i < slates.length; i++) {
      const heldOut = slates[i];
      const train = slates.filter((_, j) => j !== i);
      const trainAll = train.flatMap(s => s.recordsBySize[size]);
      if (trainAll.length < 100) continue;
      const trainSub = subsample(trainAll, TRAIN_CAP);
      const X = trainSub.map(featurize); const y = trainSub.map(r => Math.log(r.actualFreq + SMALL));
      const beta = solveOLS(X, y);

      const heldRecs = heldOut.recordsBySize[size];
      if (!heldRecs.length) continue;

      // Pool-only baseline.
      const poolEval = evalModel(heldRecs, r => r.predFreq > 0 ? r.predFreq : 0.5 / heldOut.poolSize);
      // Own-product baseline.
      const ownEval = evalModel(heldRecs, r => r.ownProduct);
      // Multi-feature.
      const multiEval = evalModel(heldRecs, r => predict(beta, featurize(r)));

      looResults[size]['pool'].push(poolEval);
      looResults[size]['own'].push(ownEval);
      looResults[size]['multi'].push(multiEval);
    }
  }

  for (const size of [2, 3, 4, 5]) {
    for (const model of ['pool', 'own', 'multi']) {
      const rs = looResults[size][model]; if (!rs.length) continue;
      const meanP = rs.reduce((s, r) => s + r.pearson_log, 0) / rs.length;
      const meanRE = rs.reduce((s, r) => s + r.median_relErr, 0) / rs.length;
      const meanAE = rs.reduce((s, r) => s + r.median_absErr_pct, 0) / rs.length;
      console.log(`  ${size}  | ${model.padEnd(13)} | ${meanP.toFixed(3).padStart(11)} | ${(meanRE * 100).toFixed(0).padStart(11)}% | ${meanAE.toFixed(3).padStart(13)}%`);
    }
    console.log('');
  }

  // Per-feature ablation to see which features carry the signal.
  console.log('================================================================');
  console.log('FEATURE ABLATION — drop one feature at a time, measure size-4 LOO Pearson');
  console.log('================================================================');
  for (let dropIdx = -1; dropIdx < FEATURE_NAMES.length; dropIdx++) {
    const dropName = dropIdx === -1 ? 'NONE (full)' : FEATURE_NAMES[dropIdx];
    const ps: number[] = []; const res: number[] = [];
    for (let i = 0; i < slates.length; i++) {
      const heldOut = slates[i];
      const train = slates.filter((_, j) => j !== i);
      const trainAll = train.flatMap(s => s.recordsBySize[4]);
      if (trainAll.length < 100) continue;
      const trainSub = subsample(trainAll, TRAIN_CAP);
      const featurizeDrop = (r: ComboRecord): FeatureVec => {
        const full = featurize(r);
        if (dropIdx === -1) return full;
        return full.filter((_, idx) => idx !== dropIdx);
      };
      const X = trainSub.map(featurizeDrop); const y = trainSub.map(r => Math.log(r.actualFreq + SMALL));
      const beta = solveOLS(X, y);
      const heldRecs = heldOut.recordsBySize[4];
      if (!heldRecs.length) continue;
      const e = evalModel(heldRecs, r => predict(beta, featurizeDrop(r)));
      ps.push(e.pearson_log); res.push(e.median_relErr);
    }
    if (ps.length) {
      console.log(`  drop ${dropName.padEnd(20)} | mean Pearson ${mean(ps).toFixed(3)} | median relErr ${(mean(res) * 100).toFixed(0)}%`);
    }
  }

  // Save final model.
  if (!fs.existsSync(path.dirname(OUT_JSON))) fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify({
    generated_at: new Date().toISOString(),
    n_slates: slates.length,
    feature_names: FEATURE_NAMES,
    coefs_by_size: finalCoefs,
    notes: 'log_pred = intercept + Σ coefs[i] * features[i]. Apply: pred = exp(log_pred) - 1e-9.'
  }, null, 2));
  console.log(`\nSaved model to ${OUT_JSON}`);

  // CSV
  if (!fs.existsSync(path.dirname(OUT_CSV))) fs.mkdirSync(path.dirname(OUT_CSV), { recursive: true });
  const lines = ['size,model,slate_idx,pearson_log,median_relErr,median_absErr_pct'];
  for (const size of [2, 3, 4, 5]) for (const model of ['pool', 'own', 'multi']) {
    looResults[size][model].forEach((r, i) => {
      lines.push([size, model, i, r.pearson_log.toFixed(4), r.median_relErr.toFixed(4), r.median_absErr_pct.toFixed(4)].join(','));
    });
  }
  fs.writeFileSync(OUT_CSV, lines.join('\n'));
  console.log(`Saved LOO eval to ${OUT_CSV}`);
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
