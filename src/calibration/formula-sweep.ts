/**
 * DFS Optimizer CLI - Fast Formula Weight Sweep
 *
 * Pre-computes all component scores in Structure-of-Arrays layout,
 * then tests millions of weight combinations with an optimized greedy selector.
 *
 * Performance optimizations vs naive approach (~100x speedup):
 *   - SoA Float64Arrays for cache-friendly scoring loop
 *   - Quickselect (O(N)) instead of full sort (O(N log N))
 *   - Numeric player indices + Uint16Array counts (no Map/string hashing)
 *   - Pre-allocated work buffers (zero allocation in hot loop)
 *
 * Usage: node dist/run.js --sweep-formula [--sweep-formula-count 1000000]
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Sport, DFSSite } from '../types';
import { parseCSVFile, buildPlayerPool } from '../parser/csv-parser';
import {
  normalizeProjectionScore,
  calculateVarianceScore,
  calculateRelativeValue,
  calculateOwnershipSum,
  calculateCeilingRatioScore,
  calculateGameEnvironmentScore,
} from '../selection/scoring/lineup-scorer';
import { findSlates, loadProjections, loadActuals } from './backtester';

// ============================================================
// OPTIMIZED SLATE DATA (Structure-of-Arrays layout)
// ============================================================

interface OptSlate {
  date: string;
  N: number;
  rosterSize: number;
  maxPlayerIdx: number;

  // Component scores (SoA — contiguous Float64Arrays for cache-friendly access)
  proj: Float64Array;
  ceil: Float64Array;
  vari: Float64Array;
  sal: Float64Array;
  rel: Float64Array;
  stack: Float64Array;
  ceilRatio: Float64Array;
  gameEnv: Float64Array;

  // Selection data
  matched: Uint8Array;
  actual: Float64Array;

  // Player indices: flat array, rosterSize entries per lineup
  // lineup i's players are at pidx[i*rosterSize .. i*rosterSize + rosterSize - 1]
  pidx: Uint16Array;

  // Contest ranking (sorted descending)
  contest: Float64Array;
}

// ============================================================
// GAME STACK SCORE (same formula as everywhere else)
// ============================================================

function computeGameStackScore(lineup: Lineup, numGames: number): number {
  // Synced with simple-selector.ts — pro data driven stack scoring
  let gameTotalSum = 0;
  let gameTotalCount = 0;
  for (const p of lineup.players) {
    if (p.gameTotal && p.gameTotal > 0) {
      gameTotalSum += p.gameTotal;
      gameTotalCount++;
    }
  }
  const slateAvgGameTotal = gameTotalCount > 0 ? gameTotalSum / gameTotalCount : 225;

  const gameGroups = new Map<string, { teams: Set<string>; count: number; gameTotal: number }>();
  for (const player of lineup.players) {
    const gameId = player.gameInfo || `${player.team}_game`;
    const group = gameGroups.get(gameId) || { teams: new Set(), count: 0, gameTotal: player.gameTotal || slateAvgGameTotal };
    group.teams.add(player.team);
    group.count++;
    gameGroups.set(gameId, group);
  }

  let stackBonus = 0;
  let maxStackSize = 0;
  const stackSizes: number[] = [];

  for (const [, group] of gameGroups) {
    const gameTotalScaler = group.gameTotal / slateAvgGameTotal;
    if (group.count > maxStackSize) maxStackSize = group.count;
    const hasBB = group.teams.size >= 2;

    if (group.count >= 6) {
      stackBonus += 0.20 * gameTotalScaler;
      if (hasBB) stackBonus += 0.08 * gameTotalScaler;
    } else if (group.count >= 5) {
      stackBonus += 0.14 * gameTotalScaler;
      if (hasBB) stackBonus += 0.06 * gameTotalScaler;
    } else if (group.count >= 4) {
      stackBonus += 0.10 * gameTotalScaler;
      if (hasBB) stackBonus += 0.05 * gameTotalScaler;
    } else if (group.count >= 3) {
      stackBonus += 0.10 * gameTotalScaler;
      if (hasBB) stackBonus += 0.04 * gameTotalScaler;
    } else if (group.count === 2) {
      stackBonus += 0.03 * gameTotalScaler;
      if (hasBB) stackBonus += 0.02 * gameTotalScaler;
    }
    if (group.count >= 2) stackSizes.push(group.count);
  }

  stackSizes.sort((a, b) => b - a);
  if (stackSizes.length >= 3) stackBonus += 0.12;
  else if (stackSizes.length >= 2) stackBonus += 0.07;
  if (maxStackSize <= 2 && numGames > 2) stackBonus -= 0.06;
  if (stackSizes.length <= 1 && maxStackSize >= 3 && numGames >= 4) stackBonus -= 0.04;

  const slateScaler = numGames <= 3 ? 0.80 : numGames <= 4 ? 0.90 : numGames <= 6 ? 1.00 : 1.10;
  return Math.max(-0.05, Math.min(0.70, stackBonus * slateScaler));
}

// ============================================================
// LOAD AND PRE-COMPUTE (SoA layout)
// ============================================================

function loadSlateData(dataDir: string, sport: Sport, site: DFSSite): OptSlate[] {
  const discoveredSlates = findSlates(dataDir);
  if (discoveredSlates.length === 0) {
    console.error('No slates found in ' + dataDir);
    return [];
  }

  const slates: OptSlate[] = [];

  for (const slate of discoveredSlates) {
    const poolCachePath = path.join(dataDir, 'cached_pools', `${slate.date}_pool.json`);
    if (!fs.existsSync(poolCachePath)) {
      console.log(`  Skipping ${slate.date} — no cached pool`);
      continue;
    }

    const cached = JSON.parse(fs.readFileSync(poolCachePath, 'utf-8'));
    const lineups: Lineup[] = cached.lineups;
    if (lineups.length === 0) continue;

    // Load projections for pool stats
    const projPath = path.join(dataDir, slate.projFile);
    let parseResult;
    try {
      parseResult = parseCSVFile(projPath, sport);
    } catch {
      console.log(`  Skipping ${slate.date} — failed to parse projections`);
      continue;
    }
    const pool = buildPlayerPool(parseResult.players, parseResult.detectedContestType);

    // Count games
    const gameSet = new Set<string>();
    for (const p of pool.players) {
      if (p.gameInfo) gameSet.add(p.gameInfo);
      else if (p.team) gameSet.add(p.team);
    }
    const numGames = gameSet.size > 0
      ? (pool.players[0]?.gameInfo ? gameSet.size : Math.ceil(gameSet.size / 2))
      : 5;

    // Load actuals
    const actualsById = new Map<string, number>();
    const actualsByName = new Map<string, number>();
    const playerData = loadProjections(dataDir, slate.projFile);
    for (const [nameLower, pd] of playerData) {
      if (pd.actual > 0) {
        actualsById.set(pd.id, pd.actual);
        actualsByName.set(nameLower, pd.actual);
      }
    }

    // Load contest entries
    const contestEntries = loadActuals(dataDir, slate.actualsFile);
    if (contestEntries.length < 100) continue;

    // Pre-compute component scores
    const N = lineups.length;
    const rosterSize = lineups[0].players.length;

    // Find projection range
    let minProj = Infinity, maxProj = -Infinity;
    for (let i = 0; i < N; i++) {
      if (lineups[i].projection < minProj) minProj = lineups[i].projection;
      if (lineups[i].projection > maxProj) maxProj = lineups[i].projection;
    }

    // Find optimal lineup for relative value
    let optIdx = 0;
    for (let i = 1; i < N; i++) {
      if (lineups[i].projection > lineups[optIdx].projection) optIdx = i;
    }
    const optimalProjection = maxProj;
    const optimalOwnership = calculateOwnershipSum(lineups[optIdx]);

    // Ceiling range
    let poolMinCeil = Infinity, poolMaxCeil = -Infinity;
    const ceilValues = new Float64Array(N);
    const varValues = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const vd = calculateVarianceScore(lineups[i]);
      ceilValues[i] = vd.ceiling;
      varValues[i] = vd.score;
      if (vd.ceiling < poolMinCeil) poolMinCeil = vd.ceiling;
      if (vd.ceiling > poolMaxCeil) poolMaxCeil = vd.ceiling;
    }
    const ceilingRange = poolMaxCeil - poolMinCeil;

    // Build player ID → dense numeric index mapping
    const playerIdToIdx = new Map<string, number>();
    let nextIdx = 0;
    for (const lineup of lineups) {
      for (const p of lineup.players) {
        if (!playerIdToIdx.has(p.id)) {
          playerIdToIdx.set(p.id, nextIdx++);
        }
      }
    }
    const maxPlayerIdx = nextIdx;

    // Allocate SoA arrays
    const projArr = new Float64Array(N);
    const ceilArr = new Float64Array(N);
    const variArr = new Float64Array(N);
    const salArr = new Float64Array(N);
    const relArr = new Float64Array(N);
    const stackArr = new Float64Array(N);
    const ceilRatioArr = new Float64Array(N);
    const gameEnvArr = new Float64Array(N);
    const matchedArr = new Uint8Array(N);
    const actualArr = new Float64Array(N);
    const pidxArr = new Uint16Array(N * rosterSize);

    for (let i = 0; i < N; i++) {
      const l = lineups[i];
      const projScore = normalizeProjectionScore(l.projection, minProj, maxProj);
      const ceilScore = ceilingRange > 0
        ? Math.max(0, Math.min(1, (ceilValues[i] - poolMinCeil) / ceilingRange))
        : 0.5;
      const relValue = calculateRelativeValue(l, optimalProjection, optimalOwnership);

      const salaryLeft = 50000 - l.salary;
      const x = Math.min(1, salaryLeft / 1800);

      projArr[i] = projScore;
      ceilArr[i] = ceilScore;
      variArr[i] = varValues[i];
      salArr[i] = Math.max(0.1, 1 - x * x);
      relArr[i] = relValue.relativeValueScore;
      stackArr[i] = computeGameStackScore(l, numGames);
      ceilRatioArr[i] = calculateCeilingRatioScore(l);
      gameEnvArr[i] = calculateGameEnvironmentScore(l);

      // Compute actual points and player indices
      let actualPoints = 0;
      let allMatched = 1;
      const base = i * rosterSize;
      for (let j = 0; j < rosterSize; j++) {
        const p = l.players[j];
        pidxArr[base + j] = playerIdToIdx.get(p.id)!;
        const actual = actualsById.get(p.id) ?? actualsByName.get(p.name.toLowerCase());
        if (actual !== undefined) {
          actualPoints += actual;
        } else {
          allMatched = 0;
        }
      }
      matchedArr[i] = allMatched;
      actualArr[i] = actualPoints;
    }

    // Contest points as typed array (sorted descending)
    const contestPts = Float64Array.from(
      contestEntries.map(e => e.points).sort((a, b) => b - a)
    );

    console.log(`  ${slate.date}: ${N} lineups, ${contestPts.length} contest entries, ${numGames} games, ${maxPlayerIdx} unique players`);

    slates.push({
      date: slate.date,
      N,
      rosterSize,
      maxPlayerIdx,
      proj: projArr,
      ceil: ceilArr,
      vari: variArr,
      sal: salArr,
      rel: relArr,
      stack: stackArr,
      ceilRatio: ceilRatioArr,
      gameEnv: gameEnvArr,
      matched: matchedArr,
      actual: actualArr,
      pidx: pidxArr,
      contest: contestPts,
    });
  }

  return slates;
}

// ============================================================
// QUICKSELECT: partition top K elements to front of array
// ============================================================

/**
 * Rearranges workIdx[left..right] so that the K indices with the
 * highest scores are in workIdx[left..left+K-1] (unordered).
 * Uses Hoare's quickselect with median-of-3 pivot.
 */
function quickSelectTopK(
  workIdx: number[],
  scores: Float64Array,
  left: number,
  right: number,
  K: number,
): void {
  while (left < right) {
    // Median-of-3 pivot selection
    const mid = (left + right) >>> 1;
    const sL = scores[workIdx[left]], sM = scores[workIdx[mid]], sR = scores[workIdx[right]];
    let pivotPos: number;
    if ((sL >= sM) === (sL <= sR)) pivotPos = left;
    else if ((sM >= sL) === (sM <= sR)) pivotPos = mid;
    else pivotPos = right;

    // Move pivot to end
    let tmp = workIdx[pivotPos];
    workIdx[pivotPos] = workIdx[right];
    workIdx[right] = tmp;
    const pivotScore = scores[tmp];

    // Partition: elements with score > pivotScore go to left side
    // Elements equal to pivot are distributed to keep balance
    let store = left;
    for (let i = left; i < right; i++) {
      if (scores[workIdx[i]] > pivotScore) {
        tmp = workIdx[i];
        workIdx[i] = workIdx[store];
        workIdx[store] = tmp;
        store++;
      }
    }
    // Move pivot to final position
    tmp = workIdx[store];
    workIdx[store] = workIdx[right];
    workIdx[right] = tmp;

    // store is the rank of the pivot element (0-indexed from left)
    const rank = store - left;
    if (rank === K - 1) return; // pivot is exactly at K boundary
    if (rank >= K) {
      right = store - 1; // top K are all in left partition
    } else {
      left = store + 1; // need more from right partition
    }
  }
}

// ============================================================
// IN-PLACE SORT OF RANGE (avoids allocation)
// ============================================================

/**
 * Sort workIdx[start..start+len-1] by workScores descending, in-place.
 * Uses insertion sort for small ranges, otherwise a simple in-place merge sort.
 * For len=3000, this is ~0.2ms — faster than .slice() + .sort() which allocates.
 */
function sortRange(arr: number[], scores: Float64Array, start: number, len: number): void {
  // For the sizes we use (3000), V8's Array.sort is efficient if we
  // avoid allocation. We sort a contiguous subrange in-place using
  // a custom insertion sort for small partitions and quicksort otherwise.
  if (len <= 32) {
    // Insertion sort
    for (let i = start + 1; i < start + len; i++) {
      const key = arr[i];
      const keyScore = scores[key];
      let j = i - 1;
      while (j >= start && scores[arr[j]] < keyScore) {
        arr[j + 1] = arr[j];
        j--;
      }
      arr[j + 1] = key;
    }
    return;
  }
  // Quicksort (in-place, descending by score)
  quickSortDesc(arr, scores, start, start + len - 1);
}

function quickSortDesc(arr: number[], scores: Float64Array, lo: number, hi: number): void {
  while (lo < hi) {
    if (hi - lo < 32) {
      // Insertion sort for small partitions
      for (let i = lo + 1; i <= hi; i++) {
        const key = arr[i];
        const keyScore = scores[key];
        let j = i - 1;
        while (j >= lo && scores[arr[j]] < keyScore) {
          arr[j + 1] = arr[j];
          j--;
        }
        arr[j + 1] = key;
      }
      return;
    }
    // Median-of-3 pivot
    const mid = (lo + hi) >>> 1;
    const sL = scores[arr[lo]], sM = scores[arr[mid]], sH = scores[arr[hi]];
    let pivotPos: number;
    if ((sL >= sM) === (sL <= sH)) pivotPos = lo;
    else if ((sM >= sL) === (sM <= sH)) pivotPos = mid;
    else pivotPos = hi;
    // Move pivot to end
    let tmp = arr[pivotPos]; arr[pivotPos] = arr[hi]; arr[hi] = tmp;
    const pivotScore = scores[tmp];
    // Partition
    let store = lo;
    for (let i = lo; i < hi; i++) {
      if (scores[arr[i]] > pivotScore) {
        tmp = arr[i]; arr[i] = arr[store]; arr[store] = tmp;
        store++;
      }
    }
    tmp = arr[store]; arr[store] = arr[hi]; arr[hi] = tmp;
    // Recurse on smaller partition, iterate on larger (tail call optimization)
    if (store - lo < hi - store) {
      quickSortDesc(arr, scores, lo, store - 1);
      lo = store + 1;
    } else {
      quickSortDesc(arr, scores, store + 1, hi);
      hi = store - 1;
    }
  }
}

// ============================================================
// BINARY SEARCH FOR RANK (typed array version)
// ============================================================

function binarySearchRank(contest: Float64Array, pts: number): number {
  let lo = 0, hi = contest.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (contest[mid] > pts) lo = mid + 1;
    else hi = mid - 1;
  }
  return lo + 1;
}

// ============================================================
// PRE-ALLOCATED WORK BUFFERS
// ============================================================

// Allocated once, reused across all evaluateWeights calls
let workScores: Float64Array;
let workIdx: number[];
let workCounts: Uint16Array;
let workInitialized = false;

function ensureWorkBuffers(maxN: number, maxPlayerIdx: number): void {
  if (workInitialized && workScores.length >= maxN && workCounts.length >= maxPlayerIdx) return;
  workScores = new Float64Array(maxN);
  workIdx = new Array(maxN);
  for (let i = 0; i < maxN; i++) workIdx[i] = i;
  workCounts = new Uint16Array(maxPlayerIdx);
  workInitialized = true;
}

// ============================================================
// FAST EVALUATION
// ============================================================

interface WeightConfig {
  proj: number;
  ceil: number;
  variance: number;
  salEff: number;
  relVal: number;
  ceilRatio: number;
  gameEnv: number;
  projGateThresh: number;
  ceilGateThresh: number;
}

function evaluateWeights(
  slates: OptSlate[],
  w: WeightConfig,
  targetCount: number,
  maxExposure: number,
): { top1: number; top5: number; top10: number; selected: number } {
  let totalTop1 = 0;
  let totalTop5 = 0;
  let totalTop10 = 0;
  let totalSelected = 0;

  const wp = w.proj, wc = w.ceil, wv = w.variance, ws = w.salEff, wr = w.relVal;
  const wcr = w.ceilRatio, wge = w.gameEnv;
  const pgt = w.projGateThresh, cgt = w.ceilGateThresh;

  for (const s of slates) {
    const N = s.N;
    if (N === 0) continue;

    const projA = s.proj, ceilA = s.ceil, variA = s.vari, salA = s.sal, relA = s.rel, stackA = s.stack;
    const crA = s.ceilRatio, geA = s.gameEnv;

    // 1. Score all lineups (tight loop over contiguous typed arrays)
    for (let i = 0; i < N; i++) {
      const p = projA[i], c = ceilA[i];
      const additive = p * wp + c * wc + variA[i] * wv + salA[i] * ws + relA[i] * wr + crA[i] * wcr + geA[i] * wge;
      const pg = p < pgt ? p / pgt : 1;
      const cg = c < cgt ? c / cgt : 1;
      workScores[i] = additive * Math.sqrt(pg * cg) * (1 + stackA[i]);
      workIdx[i] = i;
    }

    // 2. Quickselect top K candidates, then sort only those K in-place
    const K = Math.min(N, Math.max(3000, targetCount * 6));
    if (N > K) {
      quickSelectTopK(workIdx, workScores, 0, N - 1, K);
    }
    const topK = K < N ? K : N;
    // Sort workIdx[0..topK-1] in-place by score descending
    // Use a temporary sub-view approach: sort the first topK elements
    sortRange(workIdx, workScores, 0, topK);

    // 3. Greedy select with exposure cap using numeric indices
    workCounts.fill(0, 0, s.maxPlayerIdx);
    let slateSelected = 0;
    const roster = s.rosterSize;
    const pidx = s.pidx;
    const matched = s.matched;
    const actualPts = s.actual;
    const contest = s.contest;
    const contestLen = contest.length;

    for (let k = 0; k < topK && slateSelected < targetCount; k++) {
      const idx = workIdx[k];
      if (!matched[idx]) continue;

      // Exposure check
      let ok = true;
      if (slateSelected >= 10) {
        const threshold = slateSelected * maxExposure;
        const base = idx * roster;
        for (let j = 0; j < roster; j++) {
          if (workCounts[pidx[base + j]] >= threshold) { ok = false; break; }
        }
      }
      if (!ok) continue;

      // Select this lineup
      slateSelected++;
      const base = idx * roster;
      for (let j = 0; j < roster; j++) {
        workCounts[pidx[base + j]]++;
      }

      // Rank against contest
      const pts = actualPts[idx];
      const rank = binarySearchRank(contest, pts);
      const percentile = (1 - (rank - 1) / contestLen) * 100;
      if (percentile >= 99) totalTop1++;
      if (percentile >= 95) totalTop5++;
      if (percentile >= 90) totalTop10++;
    }

    totalSelected += slateSelected;
  }

  return { top1: totalTop1, top5: totalTop5, top10: totalTop10, selected: totalSelected };
}

// ============================================================
// WEIGHT SAMPLING
// ============================================================

function randomDirichletWeights(
  ranges: Array<{ min: number; max: number }>,
): number[] {
  const raw = ranges.map(r => r.min + Math.random() * (r.max - r.min));
  const sum = raw.reduce((s, v) => s + v, 0);
  return raw.map(v => v / sum);
}

// ============================================================
// MAIN SWEEP FUNCTION
// ============================================================

export async function runFormulaSweep(
  dataDir: string,
  sport: Sport,
  site: DFSSite,
  numCombos: number = 1_000_000,
): Promise<void> {
  console.log('\n========================================');
  console.log('FORMULA WEIGHT SWEEP');
  console.log(`Testing ${numCombos.toLocaleString()} weight combinations`);
  console.log('========================================\n');

  // Load and pre-compute all slate data
  console.log('Loading and pre-computing slate data...');
  const slates = loadSlateData(dataDir, sport, site);
  if (slates.length === 0) {
    console.error('No slates loaded');
    return;
  }

  const totalLineups = slates.reduce((s, sl) => s + sl.N, 0);
  console.log(`\nLoaded ${slates.length} slates, ${totalLineups.toLocaleString()} total lineups\n`);

  // Initialize work buffers
  const maxN = Math.max(...slates.map(s => s.N));
  const maxPIdx = Math.max(...slates.map(s => s.maxPlayerIdx));
  ensureWorkBuffers(maxN, maxPIdx + 1);

  // Evaluate baseline
  const currentWeights: WeightConfig = {
    proj: 0.085, ceil: 0.124, variance: 0.226, salEff: 0.096, relVal: 0.469,
    ceilRatio: 0.00, gameEnv: 0.00,
    projGateThresh: 0.564, ceilGateThresh: 0.515,
  };

  const TARGET_COUNT = 500;
  const MAX_EXPOSURE = 0.40;
  // Minimum total selections across all slates to consider a result valid
  // Prevents inflated rates from tiny samples (e.g., 5/131 = 3.82% is noise)
  const MIN_SELECTED = slates.length * Math.floor(TARGET_COUNT * 0.70); // ~4200 for 12 slates

  const baseline = evaluateWeights(slates, currentWeights, TARGET_COUNT, MAX_EXPOSURE);
  const baselineRate = baseline.selected > 0 ? baseline.top1 / baseline.selected * 100 : 0;
  console.log(`BASELINE (current weights): ${baseline.top1}/${baseline.selected} = ${baselineRate.toFixed(2)}% top-1%`);
  console.log(`  proj=${currentWeights.proj} ceil=${currentWeights.ceil} var=${currentWeights.variance} sal=${currentWeights.salEff} rel=${currentWeights.relVal} ceilR=${currentWeights.ceilRatio} gEnv=${currentWeights.gameEnv}`);
  console.log(`  Top5%: ${baseline.top5}/${baseline.selected} = ${(baseline.top5/baseline.selected*100).toFixed(2)}%`);
  console.log(`  Min valid selections: ${MIN_SELECTED}`);
  console.log('');

  // Weight ranges (7 dimensions)
  const weightRanges = [
    { min: 0.05, max: 0.60 },   // projection
    { min: 0.05, max: 0.60 },   // ceiling
    { min: 0.00, max: 0.25 },   // variance
    { min: 0.00, max: 0.35 },   // salaryEfficiency
    { min: 0.00, max: 0.50 },   // relativeValue
    { min: 0.00, max: 0.30 },   // ceilingRatio
    { min: 0.00, max: 0.20 },   // gameEnvironment
  ];

  const projGateRange = { min: 0.25, max: 0.70 };
  const ceilGateRange = { min: 0.20, max: 0.60 };
  const exposureOptions = [0.35, 0.40, 0.45, 0.50, 0.55];

  // Track top results
  const topResults: Array<{
    weights: WeightConfig;
    exposure: number;
    top1: number;
    top5: number;
    top10: number;
    selected: number;
    rate: number;
  }> = [];

  const startTime = Date.now();
  let combosEvaluated = 0;
  let bestRate = baselineRate;

  // Phase 1: Random exploration (70%)
  const phase1Count = Math.floor(numCombos * 0.70);
  console.log(`Phase 1: Random exploration (${phase1Count.toLocaleString()} combos)...`);

  for (let i = 0; i < phase1Count; i++) {
    const rawWeights = randomDirichletWeights(weightRanges);
    const exposure = exposureOptions[Math.floor(Math.random() * exposureOptions.length)];

    const weights: WeightConfig = {
      proj: rawWeights[0],
      ceil: rawWeights[1],
      variance: rawWeights[2],
      salEff: rawWeights[3],
      relVal: rawWeights[4],
      ceilRatio: rawWeights[5],
      gameEnv: rawWeights[6],
      projGateThresh: projGateRange.min + Math.random() * (projGateRange.max - projGateRange.min),
      ceilGateThresh: ceilGateRange.min + Math.random() * (ceilGateRange.max - ceilGateRange.min),
    };

    const result = evaluateWeights(slates, weights, TARGET_COUNT, exposure);
    combosEvaluated++;

    const rate = result.selected > 0 ? result.top1 / result.selected * 100 : 0;

    // Only track results with enough selections to be statistically meaningful
    if (result.selected >= MIN_SELECTED) {
      if (rate > bestRate * 0.90 || rate >= 1.5) {
        topResults.push({ weights, exposure, ...result, rate });
        topResults.sort((a, b) => b.rate - a.rate);
        if (topResults.length > 100) topResults.length = 100;
      }

      if (rate > bestRate) {
        bestRate = rate;
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`  [${combosEvaluated.toLocaleString()}] NEW BEST: ${result.top1}/${result.selected} = ${rate.toFixed(2)}% top-1% (${elapsed}s)`);
        console.log(`    proj=${weights.proj.toFixed(3)} ceil=${weights.ceil.toFixed(3)} var=${weights.variance.toFixed(3)} sal=${weights.salEff.toFixed(3)} rel=${weights.relVal.toFixed(3)} ceilR=${weights.ceilRatio.toFixed(3)} gEnv=${weights.gameEnv.toFixed(3)} pGate=${weights.projGateThresh.toFixed(3)} cGate=${weights.ceilGateThresh.toFixed(3)} exp=${exposure}`);
      }
    }

    // Progress updates
    if (combosEvaluated % 10000 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const rate2 = combosEvaluated / ((Date.now() - startTime) / 1000);
      console.log(`  Progress: ${combosEvaluated.toLocaleString()} combos, ${elapsed}s, ${rate2.toFixed(0)} combos/s, best ${bestRate.toFixed(2)}%`);
    }
  }

  // Phase 2: Hill climb around top results (30%)
  const phase2Count = Math.floor(numCombos * 0.30);
  console.log(`\nPhase 2: Hill climbing around top ${Math.min(topResults.length, 20)} results (${phase2Count.toLocaleString()} combos)...`);

  const topSeeds = topResults.slice(0, 20);
  const perturbationsPerSeed = Math.floor(phase2Count / Math.max(1, topSeeds.length));

  for (const seed of topSeeds) {
    for (let j = 0; j < perturbationsPerSeed; j++) {
      const perturbScale = 0.10 * (1 - j / perturbationsPerSeed);
      const rawWeights = [seed.weights.proj, seed.weights.ceil, seed.weights.variance, seed.weights.salEff, seed.weights.relVal, seed.weights.ceilRatio, seed.weights.gameEnv];
      for (let k = 0; k < 7; k++) {
        const range = weightRanges[k].max - weightRanges[k].min;
        rawWeights[k] += (Math.random() * 2 - 1) * range * perturbScale;
        rawWeights[k] = Math.max(weightRanges[k].min, Math.min(weightRanges[k].max, rawWeights[k]));
      }
      const sum = rawWeights.reduce((s, v) => s + v, 0);
      for (let k = 0; k < 7; k++) rawWeights[k] /= sum;

      const weights: WeightConfig = {
        proj: rawWeights[0],
        ceil: rawWeights[1],
        variance: rawWeights[2],
        salEff: rawWeights[3],
        relVal: rawWeights[4],
        ceilRatio: rawWeights[5],
        gameEnv: rawWeights[6],
        projGateThresh: Math.max(0.25, Math.min(0.70, seed.weights.projGateThresh + (Math.random() * 2 - 1) * 0.05)),
        ceilGateThresh: Math.max(0.20, Math.min(0.60, seed.weights.ceilGateThresh + (Math.random() * 2 - 1) * 0.05)),
      };

      const exposure = Math.max(0.30, Math.min(0.60,
        seed.exposure + (Math.random() < 0.3 ? (Math.random() < 0.5 ? 0.05 : -0.05) : 0)));

      const result = evaluateWeights(slates, weights, TARGET_COUNT, exposure);
      combosEvaluated++;

      const rate = result.selected > 0 ? result.top1 / result.selected * 100 : 0;

      if (result.selected >= MIN_SELECTED) {
        if (rate > bestRate * 0.90 || rate >= 1.5) {
          topResults.push({ weights, exposure, ...result, rate });
          topResults.sort((a, b) => b.rate - a.rate);
          if (topResults.length > 100) topResults.length = 100;
        }

        if (rate > bestRate) {
          bestRate = rate;
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log(`  [${combosEvaluated.toLocaleString()}] NEW BEST: ${result.top1}/${result.selected} = ${rate.toFixed(2)}% top-1% (${elapsed}s)`);
          console.log(`    proj=${weights.proj.toFixed(3)} ceil=${weights.ceil.toFixed(3)} var=${weights.variance.toFixed(3)} sal=${weights.salEff.toFixed(3)} rel=${weights.relVal.toFixed(3)} ceilR=${weights.ceilRatio.toFixed(3)} gEnv=${weights.gameEnv.toFixed(3)} pGate=${weights.projGateThresh.toFixed(3)} cGate=${weights.ceilGateThresh.toFixed(3)} exp=${exposure}`);
        }
      }

      if (combosEvaluated % 10000 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const rate2 = combosEvaluated / ((Date.now() - startTime) / 1000);
        console.log(`  Progress: ${combosEvaluated.toLocaleString()} combos, ${elapsed}s, ${rate2.toFixed(0)} combos/s, best ${bestRate.toFixed(2)}%`);
      }
    }
  }

  // Final report
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n========================================`);
  console.log(`SWEEP COMPLETE`);
  console.log(`========================================`);
  console.log(`Combos tested: ${combosEvaluated.toLocaleString()}`);
  console.log(`Time: ${totalTime}s (${(combosEvaluated / ((Date.now() - startTime) / 1000)).toFixed(0)} combos/s)`);
  console.log(`\nBASELINE: ${baseline.top1}/${baseline.selected} = ${baselineRate.toFixed(2)}% top-1%`);
  console.log(`\nTOP 20 WEIGHT COMBINATIONS:`);
  console.log(`${'Rank'.padStart(4)} ${'Top1%'.padStart(7)} ${'Top1'.padStart(5)} ${'Sel'.padStart(5)} ${'Top5%'.padStart(7)} ${'proj'.padStart(6)} ${'ceil'.padStart(6)} ${'var'.padStart(6)} ${'sal'.padStart(6)} ${'rel'.padStart(6)} ${'ceilR'.padStart(6)} ${'gEnv'.padStart(6)} ${'pGate'.padStart(6)} ${'cGate'.padStart(6)} ${'exp'.padStart(5)}`);
  console.log(`${'─'.repeat(99)}`);

  for (let i = 0; i < Math.min(20, topResults.length); i++) {
    const r = topResults[i];
    console.log(
      `${(i + 1).toString().padStart(4)} ` +
      `${r.rate.toFixed(2).padStart(6)}% ` +
      `${r.top1.toString().padStart(5)} ` +
      `${r.selected.toString().padStart(5)} ` +
      `${(r.top5 / r.selected * 100).toFixed(2).padStart(6)}% ` +
      `${r.weights.proj.toFixed(3).padStart(6)} ` +
      `${r.weights.ceil.toFixed(3).padStart(6)} ` +
      `${r.weights.variance.toFixed(3).padStart(6)} ` +
      `${r.weights.salEff.toFixed(3).padStart(6)} ` +
      `${r.weights.relVal.toFixed(3).padStart(6)} ` +
      `${r.weights.ceilRatio.toFixed(3).padStart(6)} ` +
      `${r.weights.gameEnv.toFixed(3).padStart(6)} ` +
      `${r.weights.projGateThresh.toFixed(3).padStart(6)} ` +
      `${r.weights.ceilGateThresh.toFixed(3).padStart(6)} ` +
      `${r.exposure.toFixed(2).padStart(5)}`
    );
  }

  // Save best weights
  if (topResults.length > 0) {
    const best = topResults[0];
    const bestWeightsPath = path.join(dataDir, 'sweep_best_weights.json');
    const bestWeights = {
      projectionScore: best.weights.proj,
      ceilingScore: best.weights.ceil,
      varianceScore: best.weights.variance,
      salaryEfficiencyScore: best.weights.salEff,
      relativeValueScore: best.weights.relVal,
      ceilingRatioScore: best.weights.ceilRatio,
      gameEnvironmentScore: best.weights.gameEnv,
      ownershipScore: 0,
      uniquenessScore: 0,
      projectionEdgeScore: 0,
      simulationScore: 0,
      projGateThreshold: best.weights.projGateThresh,
      ceilGateThreshold: best.weights.ceilGateThresh,
      maxExposure: best.exposure,
      sweepRate: best.rate,
      sweepTop1: best.top1,
      sweepSelected: best.selected,
    };
    fs.writeFileSync(bestWeightsPath, JSON.stringify(bestWeights, null, 2));
    console.log(`\nBest weights saved to: ${bestWeightsPath}`);
  }
}
