/**
 * Fast Formula Optimizer v2
 *
 * Simplified to 5 positively-correlated components based on 12-slate analysis:
 *   projection +0.24, ceiling +0.24, variance +0.09, salEff +0.06, relVal +0.04
 *
 * Removed (negative predictors): leverage -0.06, antiCorr -0.15, ownership -0.19, projEdge -0.19
 *
 * Features:
 *   - Per-component correlation analysis (percentile, points, top-1% concentration)
 *   - Correlation-informed Dirichlet priors (higher alpha for higher correlation)
 *   - Constrained search: proj+ceil >= 40% (pro profile demands high projection)
 *   - Fixed pick percentile at 1% to match real usage
 *
 * Usage:
 *   node dist/run.js --fast-optimize --sport nba --site dk
 */

import * as fs from 'fs';
import * as path from 'path';
import { Sport, DFSSite } from '../types';
import { OptimizedWeights } from '../selection/selector';
import {
  findSlates,
  processSlate,
  ScoredEntry,
} from './backtester';

// ============================================================
// TYPES
// ============================================================

interface FormulaParams {
  weights: number[];  // 5 weights summing to 1.0: [proj, ceil, var, salEff, relVal]
  projGateThresh: number;
  ceilGateThresh: number;
  pickPctile: number;
  gameStackMult: number;  // Multiplier for game stack score (default 1.0)
}

interface EvalResult {
  params: FormulaParams;
  totalTop1: number;
  totalSelected: number;
  top1Rate: number;
  perSlate: Array<{ date: string; top1: number; selected: number; total: number }>;
}

interface CachedSlate {
  date: string;
  entries: CachedEntry[];
  totalEntries: number;
}

interface CachedEntry {
  proj: number;
  ceil: number;
  variance: number;
  salEff: number;
  relVal: number;
  // Keep all 10 for correlation analysis
  own: number;
  lev: number;
  anti: number;
  projEdge: number;
  gameStack: number;
  // Actual result
  actualPercentile: number;
  points: number;
}

// Weight indices for the 5-component formula
const W_PROJ = 0;
const W_CEIL = 1;
const W_VAR = 2;
const W_SALEFF = 3;
const W_RELVAL = 4;
const NUM_WEIGHTS = 5;

const WEIGHT_NAMES = ['proj', 'ceil', 'var', 'salEff', 'relVal'];

// All 10 component names for correlation analysis
const ALL_COMPONENT_NAMES = [
  'proj', 'ceil', 'variance', 'salEff', 'relVal',
  'own', 'lev', 'anti', 'projEdge', 'gameStack',
];

// ============================================================
// MATH HELPERS
// ============================================================

function gammaRandom(alpha: number): number {
  if (alpha < 1) {
    return gammaRandom(alpha + 1) * Math.pow(Math.random(), 1 / alpha);
  }
  const d = alpha - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x: number, v: number;
    do {
      x = randn();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function randn(): number {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function sampleDirichlet(alphas: number[]): number[] {
  const samples = alphas.map(a => gammaRandom(a));
  const sum = samples.reduce((s, v) => s + v, 0);
  return samples.map(s => s / sum);
}

function pearsonCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 3) return 0;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i]; sumY += y[i]; sumXY += x[i] * y[i];
    sumX2 += x[i] * x[i]; sumY2 += y[i] * y[i];
  }
  const denom = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  return denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
}

// ============================================================
// PARAMETER GENERATION
// ============================================================

const PROJ_GATE_OPTIONS = [0.35, 0.40, 0.45, 0.50, 0.55, 0.60];
const CEIL_GATE_OPTIONS = [0.25, 0.30, 0.35, 0.40, 0.45, 0.50];
const PICK_PCTILE_OPTIONS = [0.003, 0.005, 0.0075, 0.01, 0.015, 0.02];

// Correlation-informed Dirichlet alphas:
//   proj +0.24 → alpha=5, ceil +0.24 → alpha=5, var +0.09 → alpha=2,
//   salEff +0.06 → alpha=1.5, relVal +0.04 → alpha=1.5
const BASE_ALPHAS = [5, 5, 2, 1.5, 1.5];

function randomParams(): FormulaParams {
  let weights: number[];

  // 70% of samples use correlation-informed priors
  // 30% use flat priors for exploration
  if (Math.random() < 0.70) {
    weights = sampleDirichlet(BASE_ALPHAS);
  } else {
    weights = sampleDirichlet(new Array(NUM_WEIGHTS).fill(2));
  }

  // Enforce minimum: proj+ceil >= 40% (pro profile demands high projection+ceiling)
  const projCeilSum = weights[W_PROJ] + weights[W_CEIL];
  if (projCeilSum < 0.40) {
    const boost = (0.40 - projCeilSum) / 2;
    weights[W_PROJ] += boost;
    weights[W_CEIL] += boost;
    const wSum = weights.reduce((s, v) => s + v, 0);
    for (let i = 0; i < weights.length; i++) weights[i] /= wSum;
  }

  return {
    weights,
    projGateThresh: PROJ_GATE_OPTIONS[Math.floor(Math.random() * PROJ_GATE_OPTIONS.length)],
    ceilGateThresh: CEIL_GATE_OPTIONS[Math.floor(Math.random() * CEIL_GATE_OPTIONS.length)],
    pickPctile: PICK_PCTILE_OPTIONS[Math.floor(Math.random() * PICK_PCTILE_OPTIONS.length)],
    gameStackMult: 0.5 + Math.random() * 1.5,
  };
}

function perturbParams(base: FormulaParams, scale: number = 0.05): FormulaParams {
  const weights = base.weights.map(w => Math.max(0.001, w + randn() * scale));
  const wSum = weights.reduce((s, v) => s + v, 0);
  for (let i = 0; i < weights.length; i++) weights[i] /= wSum;

  // Enforce proj+ceil >= 40%
  const projCeilSum = weights[W_PROJ] + weights[W_CEIL];
  if (projCeilSum < 0.40) {
    const boost = (0.40 - projCeilSum) / 2;
    weights[W_PROJ] += boost;
    weights[W_CEIL] += boost;
    const ws = weights.reduce((s, v) => s + v, 0);
    for (let i = 0; i < weights.length; i++) weights[i] /= ws;
  }

  let projGateThresh = base.projGateThresh;
  let ceilGateThresh = base.ceilGateThresh;
  if (Math.random() < 0.3) projGateThresh = PROJ_GATE_OPTIONS[Math.floor(Math.random() * PROJ_GATE_OPTIONS.length)];
  if (Math.random() < 0.3) ceilGateThresh = CEIL_GATE_OPTIONS[Math.floor(Math.random() * CEIL_GATE_OPTIONS.length)];

  let pickPctile = base.pickPctile;
  if (Math.random() < 0.2) pickPctile = PICK_PCTILE_OPTIONS[Math.floor(Math.random() * PICK_PCTILE_OPTIONS.length)];

  let gameStackMult = Math.max(0, Math.min(2.5, base.gameStackMult + randn() * scale * 0.5));

  return { weights, projGateThresh, ceilGateThresh, pickPctile, gameStackMult };
}

// ============================================================
// FAST EVALUATION
// ============================================================

function evaluateFast(slates: CachedSlate[], params: FormulaParams): EvalResult {
  const w = params.weights;
  const perSlate: EvalResult['perSlate'] = [];
  let totalTop1 = 0;
  let totalSelected = 0;

  for (const slate of slates) {
    const n = slate.entries.length;
    const pickCount = Math.max(1, Math.floor(n * params.pickPctile));
    const scores = new Float64Array(n);

    for (let i = 0; i < n; i++) {
      const e = slate.entries[i];

      // 5-component weighted sum
      const baseScore =
        e.proj * w[W_PROJ] +
        e.ceil * w[W_CEIL] +
        e.variance * w[W_VAR] +
        e.salEff * w[W_SALEFF] +
        e.relVal * w[W_RELVAL];

      // Quality gate
      const projGate = Math.min(1, e.proj / params.projGateThresh);
      const ceilGate = Math.min(1, e.ceil / params.ceilGateThresh);

      scores[i] = baseScore * Math.sqrt(projGate * ceilGate) * (1 + e.gameStack * params.gameStackMult);
    }

    // Partial sort to find top pickCount
    const indices = new Uint32Array(n);
    for (let i = 0; i < n; i++) indices[i] = i;
    partialSort(indices, scores, 0, n - 1, pickCount);

    let slateTop1 = 0;
    for (let i = 0; i < pickCount; i++) {
      if (slate.entries[indices[i]].actualPercentile >= 99.0) slateTop1++;
    }

    totalTop1 += slateTop1;
    totalSelected += pickCount;
    perSlate.push({ date: slate.date, top1: slateTop1, selected: pickCount, total: n });
  }

  return {
    params,
    totalTop1,
    totalSelected,
    top1Rate: totalSelected > 0 ? totalTop1 / totalSelected : 0,
    perSlate,
  };
}

function partialSort(indices: Uint32Array, scores: Float64Array, lo: number, hi: number, k: number): void {
  if (lo >= hi || k <= 0) return;
  if (k <= 10) {
    for (let i = 0; i < k && lo + i <= hi; i++) {
      let bestIdx = lo + i;
      for (let j = lo + i + 1; j <= hi; j++) {
        if (scores[indices[j]] > scores[indices[bestIdx]]) bestIdx = j;
      }
      const tmp = indices[lo + i]; indices[lo + i] = indices[bestIdx]; indices[bestIdx] = tmp;
    }
    return;
  }
  const pivotIdx = lo + Math.floor(Math.random() * (hi - lo + 1));
  const pivotScore = scores[indices[pivotIdx]];
  let tmp = indices[pivotIdx]; indices[pivotIdx] = indices[hi]; indices[hi] = tmp;
  let storeIdx = lo;
  for (let i = lo; i < hi; i++) {
    if (scores[indices[i]] > pivotScore) {
      tmp = indices[i]; indices[i] = indices[storeIdx]; indices[storeIdx] = tmp; storeIdx++;
    }
  }
  tmp = indices[storeIdx]; indices[storeIdx] = indices[hi]; indices[hi] = tmp;
  const leftCount = storeIdx - lo + 1;
  if (k < leftCount) partialSort(indices, scores, lo, storeIdx - 1, k);
  else if (k > leftCount) partialSort(indices, scores, storeIdx + 1, hi, k - leftCount);
}

// ============================================================
// CORRELATION ANALYSIS
// ============================================================

function analyzeComponentCorrelations(slates: CachedSlate[]): void {
  // Flatten all entries
  const all: CachedEntry[] = [];
  for (const sl of slates) for (const e of sl.entries) all.push(e);
  const n = all.length;

  const componentGetters: Array<{ name: string; get: (e: CachedEntry) => number }> = [
    { name: 'projection', get: e => e.proj },
    { name: 'ceiling', get: e => e.ceil },
    { name: 'variance', get: e => e.variance },
    { name: 'salaryEff', get: e => e.salEff },
    { name: 'relValue', get: e => e.relVal },
    { name: 'ownership', get: e => e.own },
    { name: 'leverage', get: e => e.lev },
    { name: 'antiCorr', get: e => e.anti },
    { name: 'projEdge', get: e => e.projEdge },
    { name: 'gameStack', get: e => e.gameStack },
  ];

  const percentiles = all.map(e => e.actualPercentile);
  const points = all.map(e => e.points);

  // Find top 1% entries
  const top1Entries = all.filter(e => e.actualPercentile >= 99.0);
  const top1Count = top1Entries.length;

  console.log(`\n--- Component Correlation Analysis (${n.toLocaleString()} entries, ${top1Count} top-1%) ---`);
  console.log(`  ${'Component'.padEnd(14)} ${'Corr w/'.padStart(8)} ${'Corr w/'.padStart(8)} ${'Top1% avg'.padStart(10)} ${'Field avg'.padStart(10)} ${'Top1%/Field'.padStart(11)} ${'Verdict'.padStart(8)}`);
  console.log(`  ${''.padEnd(14)} ${'Finish'.padStart(8)} ${'Points'.padStart(8)} ${'(score)'.padStart(10)} ${'(score)'.padStart(10)} ${'(ratio)'.padStart(11)}`);
  console.log(`  ${'─'.repeat(75)}`);

  const results: Array<{ name: string; corrFinish: number; corrPoints: number; top1Avg: number; fieldAvg: number; ratio: number }> = [];

  for (const comp of componentGetters) {
    const values = all.map(comp.get);
    const corrFinish = pearsonCorrelation(values, percentiles);
    const corrPoints = pearsonCorrelation(values, points);

    const fieldAvg = values.reduce((s, v) => s + v, 0) / n;
    const top1Avg = top1Entries.reduce((s, e) => s + comp.get(e), 0) / top1Count;
    const ratio = fieldAvg > 0 ? top1Avg / fieldAvg : 0;

    results.push({ name: comp.name, corrFinish, corrPoints, top1Avg, fieldAvg, ratio });

    const verdict = corrFinish > 0.05 ? 'KEEP' : corrFinish < -0.05 ? 'DROP' : 'weak';
    const sign1 = corrFinish >= 0 ? '+' : '';
    const sign2 = corrPoints >= 0 ? '+' : '';

    console.log(`  ${comp.name.padEnd(14)} ${(sign1 + corrFinish.toFixed(4)).padStart(8)} ${(sign2 + corrPoints.toFixed(4)).padStart(8)} ${top1Avg.toFixed(3).padStart(10)} ${fieldAvg.toFixed(3).padStart(10)} ${ratio.toFixed(3).padStart(11)} ${verdict.padStart(8)}`);
  }

  // Summary recommendation
  console.log(`\n  Summary:`);
  const kept = results.filter(r => r.corrFinish > 0.03).sort((a, b) => b.corrFinish - a.corrFinish);
  const dropped = results.filter(r => r.corrFinish <= 0.03).sort((a, b) => a.corrFinish - b.corrFinish);
  console.log(`    KEEP (positive correlation): ${kept.map(r => `${r.name}(${r.corrFinish >= 0 ? '+' : ''}${r.corrFinish.toFixed(3)})`).join(', ')}`);
  console.log(`    DROP (zero/negative):        ${dropped.map(r => `${r.name}(${r.corrFinish >= 0 ? '+' : ''}${r.corrFinish.toFixed(3)})`).join(', ')}`);

  // Pro-style comparison
  console.log(`\n  Top 1% profile vs field (ratio > 1.0 = top-1% have MORE of this):`);
  for (const r of results.sort((a, b) => b.ratio - a.ratio)) {
    const bar = r.ratio >= 1.0 ? '█'.repeat(Math.min(20, Math.floor((r.ratio - 1) * 100))) : '';
    console.log(`    ${r.name.padEnd(14)} ${r.ratio.toFixed(3)} ${bar}`);
  }
}

// ============================================================
// CROSS-VALIDATION
// ============================================================

function crossValidate(slates: CachedSlate[], params: FormulaParams): {
  avgTop1Rate: number;
  minTop1Rate: number;
  maxTop1Rate: number;
  cvScores: number[];
} {
  const cvScores: number[] = [];
  for (let i = 0; i < slates.length; i++) {
    const result = evaluateFast([slates[i]], params);
    cvScores.push(result.top1Rate);
  }
  return {
    avgTop1Rate: cvScores.reduce((s, v) => s + v, 0) / cvScores.length,
    minTop1Rate: Math.min(...cvScores),
    maxTop1Rate: Math.max(...cvScores),
    cvScores,
  };
}

// ============================================================
// MAIN OPTIMIZER
// ============================================================

export async function runFastFormulaOptimizer(
  dataDir: string,
  sport: Sport = 'nba',
  _site: DFSSite = 'dk',
): Promise<void> {
  const startTime = Date.now();

  console.log('========================================');
  console.log('FAST FORMULA OPTIMIZER v2');
  console.log('(5-component simplified formula)');
  console.log('========================================');
  console.log(`Data dir: ${dataDir}`);

  // Step 1: Load and score all slates
  console.log('\n--- Phase 0: Loading & Scoring Slates ---');
  const slateFiles = findSlates(dataDir);
  console.log(`Found ${slateFiles.length} slates`);

  const cachedSlates: CachedSlate[] = [];

  for (const slateFile of slateFiles) {
    const result = await processSlate(dataDir, slateFile);
    if (!result) continue;

    const entries: CachedEntry[] = [];
    for (const se of result.scoredEntries) {
      if (!se.lineup) continue;
      entries.push({
        proj: se.components.projectionScore,
        ceil: se.components.ceilingScore,
        variance: se.components.varianceScore,
        salEff: se.components.salaryEfficiencyScore,
        relVal: se.components.relativeValueScore,
        own: se.components.ownershipScore,
        lev: se.components.leverageScore,
        anti: se.components.antiCorrelationScore,
        projEdge: se.components.projectionEdgeScore,
        gameStack: se.components.gameStackScore,
        actualPercentile: se.actualPercentile,
        points: se.entry.points,
      });
    }

    cachedSlates.push({
      date: result.date,
      entries,
      totalEntries: result.totalEntries,
    });

    console.log(`  ${result.date}: ${entries.length} scored entries (${result.totalEntries} total)`);
  }

  if (cachedSlates.length === 0) {
    console.error('No slates loaded!');
    return;
  }

  const totalEntries = cachedSlates.reduce((s, sl) => s + sl.entries.length, 0);
  console.log(`\nTotal: ${cachedSlates.length} slates, ${totalEntries.toLocaleString()} scored entries`);

  // Step 2: Correlation analysis
  analyzeComponentCorrelations(cachedSlates);

  // Step 3: Baseline with current weights
  console.log('\n--- Baseline ---');
  const currentWeightsPath = path.join(dataDir, 'optimized_weights.json');
  let cw: OptimizedWeights | null = null;
  if (fs.existsSync(currentWeightsPath)) {
    cw = JSON.parse(fs.readFileSync(currentWeightsPath, 'utf-8'));
  }

  // Construct baseline from current weights, normalized to 5 components
  const rawBaseline = cw ? [
    cw.projectionScore || 0.35,
    cw.ceilingScore || 0.30,
    cw.varianceScore || 0.10,
    cw.salaryEfficiencyScore || 0.10,
    cw.relativeValueScore || 0.10,
  ] : [0.35, 0.30, 0.10, 0.15, 0.10];
  const bSum = rawBaseline.reduce((s, v) => s + v, 0);
  const baselineWeights = rawBaseline.map(w => w / bSum);

  const baselineParams: FormulaParams = {
    weights: baselineWeights,
    projGateThresh: 0.50,
    ceilGateThresh: 0.40,
    pickPctile: 0.01,
    gameStackMult: 1.0,
  };

  const baseline = evaluateFast(cachedSlates, baselineParams);
  console.log(`  Baseline top-1%: ${(baseline.top1Rate * 100).toFixed(2)}% (${baseline.totalTop1}/${baseline.totalSelected})`);
  console.log(`  Weights: ${baselineWeights.map((w, i) => `${WEIGHT_NAMES[i]}=${w.toFixed(3)}`).join(' ')}`);
  for (const s of baseline.perSlate) {
    console.log(`    ${s.date}: ${s.top1}/${s.selected} top-1% hits (${s.total} total)`);
  }

  // Step 4: Phase 1 — Random search (500K configs)
  const PHASE1_COUNT = 500000;
  console.log(`\n--- Phase 1: Random Search (${PHASE1_COUNT.toLocaleString()} configs) ---`);
  console.log(`  Dirichlet priors: proj=5 ceil=5 var=2 salEff=1.5 relVal=1.5`);
  console.log(`  Constraint: proj+ceil >= 40%`);
  console.log(`  Includes gameStackMult parameter [0.5, 2.0]`);

  const phase1Start = Date.now();
  const results: EvalResult[] = [];

  for (let i = 0; i < PHASE1_COUNT; i++) {
    const params = randomParams();
    const result = evaluateFast(cachedSlates, params);
    results.push(result);

    if ((i + 1) % 50000 === 0) {
      const best = results.reduce((a, b) => a.top1Rate > b.top1Rate ? a : b);
      const elapsed = (Date.now() - phase1Start) / 1000;
      const rate = (i + 1) / elapsed;
      const eta = ((PHASE1_COUNT - i - 1) / rate).toFixed(0);
      console.log(`  ${(i + 1).toLocaleString()} tested (${elapsed.toFixed(1)}s, ${rate.toFixed(0)}/s, ETA ${eta}s) — best: ${(best.top1Rate * 100).toFixed(2)}% (${best.totalTop1}/${best.totalSelected})`);
    }
  }

  results.sort((a, b) => b.top1Rate - a.top1Rate);
  const phase1Time = ((Date.now() - phase1Start) / 1000).toFixed(1);
  console.log(`  Phase 1 complete in ${phase1Time}s`);
  console.log(`  Top 5:`);
  for (let i = 0; i < Math.min(5, results.length); i++) {
    const r = results[i];
    const wStr = r.params.weights.map((w, j) => `${WEIGHT_NAMES[j]}=${w.toFixed(3)}`).join(' ');
    console.log(`    #${i + 1}: ${(r.top1Rate * 100).toFixed(2)}% (${r.totalTop1}/${r.totalSelected}) — ${wStr} gates=${r.params.projGateThresh}/${r.params.ceilGateThresh} pick=${r.params.pickPctile} gsm=${r.params.gameStackMult.toFixed(2)}`);
  }

  // Step 5: Phase 2 — 3-stage hill climbing (185K evals total)
  console.log(`\n--- Phase 2: 3-Stage Hill Climbing ---`);
  const hillStart = Date.now();
  let hillResults: EvalResult[] = [...results.slice(0, 500)];

  // Stage 2a: top 500 × 200 perturbations, scale=0.08
  console.log(`  Stage 2a: top 500 × 200 perturbations (scale=0.08)`);
  const stage2aStart = Date.now();
  for (const base of hillResults.slice(0, 500)) {
    for (let j = 0; j < 200; j++) {
      const perturbed = perturbParams(base.params, 0.08);
      const result = evaluateFast(cachedSlates, perturbed);
      hillResults.push(result);
    }
  }
  hillResults.sort((a, b) => b.top1Rate - a.top1Rate);
  console.log(`    ${hillResults.length.toLocaleString()} total (${((Date.now() - stage2aStart) / 1000).toFixed(1)}s) — best: ${(hillResults[0].top1Rate * 100).toFixed(2)}%`);

  // Stage 2b: top 200 × 300 perturbations, scale=0.04
  console.log(`  Stage 2b: top 200 × 300 perturbations (scale=0.04)`);
  const stage2bStart = Date.now();
  const stage2bBases = hillResults.slice(0, 200);
  for (const base of stage2bBases) {
    for (let j = 0; j < 300; j++) {
      const perturbed = perturbParams(base.params, 0.04);
      const result = evaluateFast(cachedSlates, perturbed);
      hillResults.push(result);
    }
  }
  hillResults.sort((a, b) => b.top1Rate - a.top1Rate);
  console.log(`    ${hillResults.length.toLocaleString()} total (${((Date.now() - stage2bStart) / 1000).toFixed(1)}s) — best: ${(hillResults[0].top1Rate * 100).toFixed(2)}%`);

  // Stage 2c: top 50 × 500 perturbations, scale=0.015
  console.log(`  Stage 2c: top 50 × 500 perturbations (scale=0.015)`);
  const stage2cStart = Date.now();
  const stage2cBases = hillResults.slice(0, 50);
  for (const base of stage2cBases) {
    for (let j = 0; j < 500; j++) {
      const perturbed = perturbParams(base.params, 0.015);
      const result = evaluateFast(cachedSlates, perturbed);
      hillResults.push(result);
    }
  }
  hillResults.sort((a, b) => b.top1Rate - a.top1Rate);
  const hillTime = ((Date.now() - hillStart) / 1000).toFixed(1);
  console.log(`    ${hillResults.length.toLocaleString()} total (${((Date.now() - stage2cStart) / 1000).toFixed(1)}s) — best: ${(hillResults[0].top1Rate * 100).toFixed(2)}%`);
  console.log(`  Hill climbing complete in ${hillTime}s`);
  console.log(`  Top 5 after refinement:`);
  for (let i = 0; i < Math.min(5, hillResults.length); i++) {
    const r = hillResults[i];
    const wStr = r.params.weights.map((w, j) => `${WEIGHT_NAMES[j]}=${w.toFixed(3)}`).join(' ');
    console.log(`    #${i + 1}: ${(r.top1Rate * 100).toFixed(2)}% (${r.totalTop1}/${r.totalSelected}) — ${wStr} gates=${r.params.projGateThresh}/${r.params.ceilGateThresh} pick=${r.params.pickPctile} gsm=${r.params.gameStackMult.toFixed(2)}`);
  }

  // Rename for downstream code
  const phase2Results = hillResults;

  // Step 6: Phase 3 — Cross-validation
  const PHASE3_TOP = 50;
  console.log(`\n--- Phase 3: Cross-Validation (top ${PHASE3_TOP}, leave-one-out) ---`);

  const cvResults: Array<{ result: EvalResult; cv: ReturnType<typeof crossValidate> }> = [];
  for (let i = 0; i < Math.min(PHASE3_TOP, phase2Results.length); i++) {
    const cv = crossValidate(cachedSlates, phase2Results[i].params);
    cvResults.push({ result: phase2Results[i], cv });
  }

  cvResults.sort((a, b) => b.cv.avgTop1Rate - a.cv.avgTop1Rate);

  console.log(`\n  Top 10 by CV score:`);
  console.log(`  ${'#'.padStart(3)} ${'Raw%'.padStart(7)} ${'CV-Avg'.padStart(7)} ${'CV-Min'.padStart(7)} ${'Hits'.padStart(6)}  Weights`);
  console.log(`  ${'─'.repeat(85)}`);
  for (let i = 0; i < Math.min(10, cvResults.length); i++) {
    const { result, cv } = cvResults[i];
    const wStr = result.params.weights.map((w, j) => `${WEIGHT_NAMES[j]}=${w.toFixed(3)}`).join(' ');
    const slateCounts = result.perSlate.filter(s => s.top1 > 0).length;
    console.log(`  ${(i + 1).toString().padStart(3)} ${(result.top1Rate * 100).toFixed(2).padStart(7)} ${(cv.avgTop1Rate * 100).toFixed(2).padStart(7)} ${(cv.minTop1Rate * 100).toFixed(2).padStart(7)} ${(slateCounts + '/' + result.perSlate.length).padStart(6)}  ${wStr}`);
  }

  // Best config
  const best = cvResults[0];
  console.log(`\n--- Best Configuration ---`);
  console.log(`  Raw top-1%: ${(best.result.top1Rate * 100).toFixed(2)}% (${best.result.totalTop1}/${best.result.totalSelected})`);
  console.log(`  CV average: ${(best.cv.avgTop1Rate * 100).toFixed(2)}%`);
  console.log(`  CV range:   ${(best.cv.minTop1Rate * 100).toFixed(2)}% - ${(best.cv.maxTop1Rate * 100).toFixed(2)}%`);

  console.log(`\n  Weights:`);
  for (let i = 0; i < NUM_WEIGHTS; i++) {
    console.log(`    ${WEIGHT_NAMES[i].padEnd(10)}: ${best.result.params.weights[i].toFixed(4)}`);
  }
  console.log(`\n  Quality Gates: proj=${best.result.params.projGateThresh} ceil=${best.result.params.ceilGateThresh}`);
  console.log(`  Pick percentile: ${best.result.params.pickPctile}`);
  console.log(`  Game stack mult: ${best.result.params.gameStackMult.toFixed(3)}`);

  console.log(`\n  Per-slate breakdown:`);
  for (const s of best.result.perSlate) {
    const rate = s.selected > 0 ? (s.top1 / s.selected * 100).toFixed(2) : '0.00';
    console.log(`    ${s.date}: ${s.top1}/${s.selected} top-1% (${rate}%) — ${s.total} total`);
  }

  // Compare with baseline
  console.log(`\n--- Comparison vs Baseline ---`);
  console.log(`  Baseline: ${(baseline.top1Rate * 100).toFixed(2)}% (${baseline.totalTop1}/${baseline.totalSelected})`);
  console.log(`  Best:     ${(best.result.top1Rate * 100).toFixed(2)}% (${best.result.totalTop1}/${best.result.totalSelected})`);
  const improvement = best.result.top1Rate - baseline.top1Rate;
  console.log(`  Change:   ${improvement >= 0 ? '+' : ''}${(improvement * 100).toFixed(2)}pp`);

  // Save
  const bestWeights: OptimizedWeights = {
    projectionScore: best.result.params.weights[W_PROJ],
    ownershipScore: 0,
    uniquenessScore: 0,
    varianceScore: best.result.params.weights[W_VAR],
    relativeValueScore: best.result.params.weights[W_RELVAL],
    ceilingScore: best.result.params.weights[W_CEIL],
    salaryEfficiencyScore: best.result.params.weights[W_SALEFF],
    projectionEdgeScore: 0,
    ceilingRatioScore: 0,
    gameEnvironmentScore: 0,
    simulationScore: 0,
  };

  const outPath = path.join(dataDir, 'optimized_weights.json');
  fs.writeFileSync(outPath, JSON.stringify(bestWeights, null, 2) + '\n');
  console.log(`\n  Saved weights to ${outPath}`);

  const fullConfigPath = path.join(dataDir, 'optimizer_best_config.json');
  fs.writeFileSync(fullConfigPath, JSON.stringify({
    version: 3,
    formula: '5-component (proj, ceil, var, salEff, relVal) × quality gate × (1 + gameStack × gsm)',
    weights: bestWeights,
    projGateThreshold: best.result.params.projGateThresh,
    ceilGateThreshold: best.result.params.ceilGateThresh,
    pickPercentile: best.result.params.pickPctile,
    gameStackMult: best.result.params.gameStackMult,
    metrics: {
      rawTop1Rate: best.result.top1Rate,
      cvAvgTop1Rate: best.cv.avgTop1Rate,
      cvMinTop1Rate: best.cv.minTop1Rate,
      totalTop1: best.result.totalTop1,
      totalSelected: best.result.totalSelected,
    },
    droppedComponents: {
      ownership: 'negative predictor (-0.19 corr with finish)',
      leverage: 'negative predictor (-0.06)',
      antiCorrelation: 'negative predictor (-0.15)',
      projectionEdge: 'negative predictor (-0.19)',
    },
  }, null, 2) + '\n');
  console.log(`  Saved full config to ${fullConfigPath}`);

  // Save top-50 configs for analysis
  const topConfigsPath = path.join(dataDir, 'optimizer_top_configs.json');
  const topConfigsData = cvResults.slice(0, 50).map((cr, idx) => ({
    rank: idx + 1,
    rawTop1Rate: cr.result.top1Rate,
    cvAvgTop1Rate: cr.cv.avgTop1Rate,
    cvMinTop1Rate: cr.cv.minTop1Rate,
    weights: Object.fromEntries(cr.result.params.weights.map((w, j) => [WEIGHT_NAMES[j], w])),
    projGateThresh: cr.result.params.projGateThresh,
    ceilGateThresh: cr.result.params.ceilGateThresh,
    pickPctile: cr.result.params.pickPctile,
    gameStackMult: cr.result.params.gameStackMult,
    perSlate: cr.result.perSlate.map(s => ({ date: s.date, top1: s.top1, selected: s.selected })),
  }));
  fs.writeFileSync(topConfigsPath, JSON.stringify(topConfigsData, null, 2) + '\n');
  console.log(`  Saved top 50 configs to ${topConfigsPath}`);

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  const totalEvals = PHASE1_COUNT + 500 * 200 + 200 * 300 + 50 * 500 + 500;
  console.log(`\nTotal time: ${totalTime}s (${totalEvals.toLocaleString()} evaluations)`);
}
