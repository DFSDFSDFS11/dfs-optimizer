/**
 * PureIC backtest — tests REPLACING Atlas's candEV foundation with pure IC-weighted scoring.
 *
 * Architecture comparison:
 *   OLD:  score = candEV - W*chalkRank + bonuses
 *   NEW:  score = sum(IC_i * factor_i_zscored)  -- NO candEV at all
 *
 * Tests 6 variants:
 *   1. Atlas (baseline reference)
 *   2. BB25 (current production)
 *   3. PureIC-Cluster (single rep from each of 4 IC clusters, IC-weighted)
 *   4. PureIC-All (all top-12 IC factors, IC-weighted)
 *   5. PureIC-Cluster + BB25 floors
 *   6. PureIC-All + BB25 floors
 *
 * IC weights from Phase 3 (late IC = recent slates):
 *   pos_proj_zscore_sum +0.149  (cluster 1)
 *   dev_sum_under       +0.146
 *   own_bot3_sum        +0.144  (cluster 3)
 *   h_proj_mean         +0.142
 *   pair_freq_sum       +0.136
 *   dev_sum             +0.132
 *   proj_mean           +0.129  (cluster 4)
 *   proj_per_dollar     +0.124
 *   proj_min            +0.124  (cluster 2)
 *   h_ceil85_sum        +0.121
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as csvParse } from 'csv-parse/sync';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, loadPoolFromCSV, parseContestActuals } from '../parser';
import { getContestConfig } from '../rules';
import { generateWorlds } from '../v35/simulation';
import { isPitcher } from '../theory/v1-selector';

const DIR = 'C:/Users/colin/dfs opto';
const OUT_JSON = path.join(DIR, 'pureic_results.json');
const MODEL_PATH = path.join(DIR, 'multi_combo_penalty_implementation', 'argus_gbm_v3_model.json');
const N = 150;
const FEE = 20;

const ATLAS_NUM_WORLDS = 1500;
const ATLAS_NU = 5;
const ATLAS_SEED = 12345;
const ATLAS_FIELD_SIZE = 8000;
const ATLAS_W_MULTI_BLEND = 10;
const ATLAS_TOP_K_GREEDY = 1500;
const ATLAS_EXPOSURE_CAP_HITTER = 0.25;
const ATLAS_EXPOSURE_CAP_PITCHER = 0.45;
const ATLAS_TEAM_STACK_CAP = 0.20;
const SMALL = 1e-9;

const STACKS_ANCHOR_HIT_CAP = 0.55;
const STACKS_ANCHOR_PIT_CAP = 0.70;
const STACKS_N_HIT_ANCHORS = 3;
const STACKS_N_PIT_ANCHORS = 1;
const STACKS_ANCHOR_BOOST = 5.0;
const BB25_TARGET = 0.25;
const BB25_2_TARGET = 0.12;
const BB25_3_TARGET = 0.05;

const SLATES = [
  { slate: '4-6-26',         proj: '4-6-26_projections.csv',        actuals: 'dkactuals 4-6-26.csv',      pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26',         proj: '4-8-26projections.csv',         actuals: '4-8-26actuals.csv',         pool: '4-8-26sspool.csv' },
  { slate: '4-12-26',        proj: '4-12-26projections.csv',        actuals: '4-12-26actuals.csv',        pool: '4-12-26sspool.csv' },
  { slate: '4-14-26',        proj: '4-14-26projections.csv',        actuals: '4-14-26actuals.csv',        pool: '4-14-26sspool.csv' },
  { slate: '4-15-26',        proj: '4-15-26projections.csv',        actuals: '4-15-26actuals.csv',        pool: '4-15-26sspool.csv' },
  { slate: '4-17-26',        proj: '4-17-26projections.csv',        actuals: '4-17-26actuals.csv',        pool: '4-17-26sspool.csv' },
  { slate: '4-18-26',        proj: '4-18-26projections.csv',        actuals: '4-18-26actuals.csv',        pool: '4-18-26sspool.csv' },
  { slate: '4-19-26',        proj: '4-19-26projections.csv',        actuals: '4-19-26actuals.csv',        pool: '4-19-26sspool.csv' },
  { slate: '4-20-26',        proj: '4-20-26projections.csv',        actuals: '4-20-26actuals.csv',        pool: '4-20-26sspool.csv' },
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
  { slate: '5-1-26',         proj: '5-1-26projections.csv',         actuals: '5-1-26actuals.csv',         pool: '5-1-26sspool.csv' },
  { slate: '5-2-26',         proj: '5-2-26projections.csv',         actuals: '5-2-26actuals.csv',         pool: '5-2-26sspool.csv' },
  { slate: '5-2-26-main',    proj: '5-2-26projectionsmain.csv',     actuals: '5-2-26actualsmain.csv',     pool: '5-2-26sspoolmain.csv' },
  { slate: '5-2-26-night',   proj: '5-2-26projectionsnight.csv',    actuals: '5-2-26actualsnight.csv',    pool: '5-2-26sspoolnight.csv' },
  { slate: '5-3-26',         proj: '5-3-26projections.csv',         actuals: '5-3-26actuals.csv',         pool: '5-3-26sspool.csv' },
  { slate: '5-3-26-late',    proj: '5-3-26projectionslate.csv',     actuals: '5-3-26actualslate.csv',     pool: '5-3-26sspoollate.csv' },
  { slate: '5-4-26',         proj: '5-4-26projections.csv',         actuals: '5-4-26actuals.csv',         pool: '5-4-26sspool.csv' },
  { slate: '5-4-26-late',    proj: '5-4-26projectionslate.csv',     actuals: '5-4-26actualslate.csv',     pool: '5-4-26sspoollate.csv' },
  { slate: '5-5-26',         proj: '5-5-26projections.csv',         actuals: '5-5-26actuals.csv',         pool: '5-5-26sspool.csv' },
  { slate: '5-6-26',         proj: '5-6-26projections.csv',         actuals: '5-6-26actuals.csv',         pool: '5-6-26sspool.csv' },
];

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function mean(a: number[]): number { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function stddev(a: number[]): number { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); }

function loadProjAux(projPath: string): { adjOwn: Map<string, number>; saberTotal: Map<string, number>; saberTeam: Map<string, number> } {
  const out = { adjOwn: new Map<string, number>(), saberTotal: new Map<string, number>(), saberTeam: new Map<string, number>() };
  if (!fs.existsSync(projPath)) return out;
  const records = csvParse(fs.readFileSync(projPath, 'utf-8'), { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
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

interface TreeNode { feature?: number; threshold?: number; left?: TreeNode; right?: TreeNode; leafValue?: number; }
interface GBMModel { trees: TreeNode[]; basePred: number; learningRate: number; }
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
function findRank(score: number, sortedDesc: Float64Array): number {
  let lo = 0, hi = sortedDesc.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (sortedDesc[m] > score) lo = m + 1; else hi = m; }
  return lo;
}

interface SharedInput {
  candidates: Lineup[];
  players: Player[];
  idMap: Map<string, Player>;
  projAux: ReturnType<typeof loadProjAux>;
  candEV: Float64Array;
  chalkRank: Float64Array;
  greedyPool: Int32Array;
  anchorIds: Set<string>;
  candBringback: Int8Array;
  // Pre-computed IC factors per candidate (z-scored)
  zPosProjZScoreSum: Float32Array;
  zDevSumUnder: Float32Array;
  zOwnBot3Sum: Float32Array;
  zHProjMean: Float32Array;
  zProjMean: Float32Array;
  zProjMin: Float32Array;
  zProjPerDollar: Float32Array;
  zHCeil85Sum: Float32Array;
  zDevSum: Float32Array;
  // Score-only EV-replacement: pure IC composite
  scoreIC4: Float32Array;   // 4 cluster reps, IC-weighted
  scoreICAll: Float32Array; // all top-9, IC-weighted
}

function computeShared(input: { candidates: Lineup[]; players: Player[]; idMap: Map<string, Player>; projAux: ReturnType<typeof loadProjAux>; gbm2: GBMModel }): SharedInput {
  const { candidates, players, idMap, projAux, gbm2 } = input;
  const P = candidates.length;

  // === Atlas pipeline ===
  const sim = generateWorlds(players, ATLAS_NUM_WORLDS, ATLAS_NU, ATLAS_SEED);
  const playerIdx = new Map<string, number>();
  for (let i = 0; i < players.length; i++) playerIdx.set(players[i].id, i);
  const candScores = new Float32Array(P * ATLAS_NUM_WORLDS);
  for (let c = 0; c < P; c++) {
    const lu = candidates[c];
    const idxs: number[] = [];
    for (const p of lu.players) { const i = playerIdx.get(p.id); if (i !== undefined) idxs.push(i); }
    for (let w = 0; w < ATLAS_NUM_WORLDS; w++) {
      let s = 0;
      for (const i of idxs) s += sim.scores[i * ATLAS_NUM_WORLDS + w];
      candScores[c * ATLAS_NUM_WORLDS + w] = s;
    }
  }
  let rngS = ATLAS_SEED * 7 + 1;
  function rng(): number { rngS = (rngS * 1664525 + 1013904223) >>> 0; return rngS / 0x100000000; }
  const fieldIndices = new Int32Array(ATLAS_FIELD_SIZE);
  for (let f = 0; f < ATLAS_FIELD_SIZE; f++) fieldIndices[f] = Math.floor(rng() * P);
  const fieldSortedPerWorld: Float64Array[] = new Array(ATLAS_NUM_WORLDS);
  for (let w = 0; w < ATLAS_NUM_WORLDS; w++) {
    const fs2 = new Float64Array(ATLAS_FIELD_SIZE);
    for (let f = 0; f < ATLAS_FIELD_SIZE; f++) fs2[f] = candScores[fieldIndices[f] * ATLAS_NUM_WORLDS + w];
    fs2.sort();
    for (let i = 0, j = fs2.length - 1; i < j; i++, j--) { const tmp = fs2[i]; fs2[i] = fs2[j]; fs2[j] = tmp; }
    fieldSortedPerWorld[w] = fs2;
  }
  const payTable = buildPayoutTable(ATLAS_FIELD_SIZE);
  const candEV = new Float64Array(P);
  for (let c = 0; c < P; c++) {
    let total = 0;
    for (let w = 0; w < ATLAS_NUM_WORLDS; w++) {
      const score = candScores[c * ATLAS_NUM_WORLDS + w];
      const rank = findRank(score, fieldSortedPerWorld[w]);
      if (rank < payTable.length) total += payTable[rank];
    }
    candEV[c] = total / ATLAS_NUM_WORLDS;
  }
  // GBM chalk score
  const pairCount = new Map<string, number>();
  for (const lu of candidates) {
    const ids = lu.players.map(p => p.id).sort();
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      pairCount.set(ids[i] + '|' + ids[j], (pairCount.get(ids[i] + '|' + ids[j]) || 0) + 1);
    }
  }
  function comboFeatures(ids: string[], poolFreq: number): number[] {
    let ownProd = 1, projSum = 0, salSum = 0, gameTotalSum = 0, saberTeamSum = 0;
    const teamCounts = new Map<string, number>();
    for (const id of ids) {
      const pl = idMap.get(id); if (!pl) continue;
      ownProd *= ((pl.ownership || 0) / 100);
      projSum += pl.projection || 0;
      salSum += pl.salary || 0;
      gameTotalSum += projAux.saberTotal.get(id) || 0;
      saberTeamSum += projAux.saberTeam.get(id) || 0;
      const t = (pl.team || '').toUpperCase();
      teamCounts.set(t, (teamCounts.get(t) || 0) + 1);
    }
    let maxTeam = 0; for (const v of teamCounts.values()) if (v > maxTeam) maxTeam = v;
    const sameTeam = maxTeam === ids.length;
    const salaryEff = salSum > 0 ? projSum / (salSum / 1000) : 0;
    return [
      Math.log(Math.max(SMALL, poolFreq)), Math.log(Math.max(SMALL, ownProd)),
      sameTeam ? 1 : 0,
      Math.log(Math.max(SMALL, projSum)), Math.log(Math.max(SMALL, salSum)),
      Math.log(Math.max(SMALL, gameTotalSum)), Math.log(Math.max(SMALL, saberTeamSum)),
      0, 0, salaryEff, teamCounts.size,
    ];
  }
  const chalkScore = new Float32Array(P);
  for (let c = 0; c < P; c++) {
    const ids = candidates[c].players.map(p => p.id).sort();
    let s = 0, n = 0;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const k = ids[i] + '|' + ids[j];
      const poolFreq = (pairCount.get(k) || 0) / P;
      const x = comboFeatures([ids[i], ids[j]], poolFreq);
      s += predictGBM(gbm2, x); n++;
    }
    chalkScore[c] = n > 0 ? s / n : 0;
  }
  const chalkRank = new Float64Array(P);
  {
    const idx = Array.from({ length: P }, (_, i) => i).sort((a, b) => chalkScore[a] - chalkScore[b]);
    for (let r = 0; r < P; r++) chalkRank[idx[r]] = P > 1 ? r / (P - 1) : 0;
  }
  const evRankIdx = Array.from({ length: P }, (_, i) => i).sort((a, b) => candEV[b] - candEV[a]);
  const greedyPool = new Int32Array(evRankIdx.slice(0, Math.min(ATLAS_TOP_K_GREEDY, P)));

  // Anchor IDs
  const playerInPool = new Set<string>();
  for (const lu of candidates) for (const p of lu.players) playerInPool.add(p.id);
  const hitterCandidates = players.filter(p => !isPitcher(p) && playerInPool.has(p.id)).sort((a, b) => (b.projection || 0) - (a.projection || 0));
  const pitcherCandidates = players.filter(p => isPitcher(p) && playerInPool.has(p.id)).sort((a, b) => (b.projection || 0) - (a.projection || 0));
  const anchorIds = new Set<string>();
  for (const p of hitterCandidates.slice(0, STACKS_N_HIT_ANCHORS)) anchorIds.add(p.id);
  for (const p of pitcherCandidates.slice(0, STACKS_N_PIT_ANCHORS)) anchorIds.add(p.id);

  // Bring-back
  const candBringback = new Int8Array(P);
  for (let c = 0; c < P; c++) {
    const lu = candidates[c];
    const tc = new Map<string, number>();
    const teamOpp = new Map<string, string>();
    for (const p of lu.players) {
      if (isPitcher(p)) continue;
      const t = (p.team || '').toUpperCase(); if (!t) continue;
      tc.set(t, (tc.get(t) || 0) + 1);
      if (p.opponent) teamOpp.set(t, p.opponent.toUpperCase());
    }
    let primary = '', primaryCount = 0;
    for (const [t, cnt] of tc) if (cnt > primaryCount) { primaryCount = cnt; primary = t; }
    let bb = 0;
    if (primary && teamOpp.has(primary)) bb = tc.get(teamOpp.get(primary)!) || 0;
    candBringback[c] = Math.min(bb, 4);
  }

  // === Per-position stats for pos_proj_zscore_sum ===
  const posProjStats = new Map<string, { mean: number; std: number }>();
  const positions = ['P', 'C', '1B', '2B', '3B', 'SS', 'OF'];
  for (const pos of positions) {
    const projs = players.filter(p => (p.position || '').split('/')[0] === pos && playerInPool.has(p.id)).map(p => p.projection || 0);
    if (projs.length > 0) {
      const m = projs.reduce((s, v) => s + v, 0) / projs.length;
      const v = projs.reduce((s, x) => s + (x - m) ** 2, 0) / projs.length;
      posProjStats.set(pos, { mean: m, std: Math.sqrt(v) });
    }
  }

  // === Implied own per player (for dev_sum_under) ===
  const impliedOwn = new Map<string, number>();
  for (const pos of positions) {
    const posPlayers = players.filter(p => (p.position || '').split('/')[0] === pos && playerInPool.has(p.id));
    const demands = posPlayers.map(p => Math.pow(Math.max(0.01, p.projection || 0), 1.5));
    const total = demands.reduce((s, x) => s + x, 0);
    const slotTotal = pos === 'P' ? 200 : pos === 'OF' ? 300 : 100;
    posPlayers.forEach((p, i) => {
      impliedOwn.set(p.id, total > 0 ? (demands[i] / total) * slotTotal : 0);
    });
  }

  // === Slate proj median for proj_vs_slate_p50 ===
  const allProjs = players.filter(p => playerInPool.has(p.id)).map(p => p.projection || 0).sort((a, b) => a - b);
  const slateP50 = allProjs.length > 0 ? allProjs[Math.floor(allProjs.length / 2)] : 0;

  // === Compute raw factors per candidate ===
  const rawPosProjZScoreSum = new Float32Array(P);
  const rawDevSumUnder = new Float32Array(P);
  const rawOwnBot3Sum = new Float32Array(P);
  const rawHProjMean = new Float32Array(P);
  const rawProjMean = new Float32Array(P);
  const rawProjMin = new Float32Array(P);
  const rawProjPerDollar = new Float32Array(P);
  const rawHCeil85Sum = new Float32Array(P);
  const rawDevSum = new Float32Array(P);

  for (let c = 0; c < P; c++) {
    const lu = candidates[c];
    let zSum = 0;
    let projSum = 0;
    let salSum = 0;
    let hProjSum = 0, hCount = 0;
    let hCeilSum = 0;
    let projMin = Infinity;
    const owns: number[] = [];
    let devSum = 0, devSumUnder = 0;
    for (const p of lu.players) {
      const proj = p.projection || 0;
      projSum += proj;
      salSum += p.salary || 0;
      projMin = Math.min(projMin, proj);
      const pos = (p.position || '').split('/')[0];
      const stat = posProjStats.get(pos);
      if (stat && stat.std > 0.001) zSum += (proj - stat.mean) / stat.std;
      if (!isPitcher(p)) {
        hProjSum += proj;
        hCount++;
        hCeilSum += proj * 1.5;  // approximate ceil_85
      }
      const adj = projAux.adjOwn.get(p.id);
      const own = (adj !== undefined) ? adj : (p.ownership || 0);
      owns.push(own);
      const imp = impliedOwn.get(p.id) || own;
      const dev = own - imp;
      devSum += dev;
      if (dev < 0) devSumUnder += dev;
    }
    const ownsSorted = owns.slice().sort((a, b) => a - b);
    rawPosProjZScoreSum[c] = zSum;
    rawDevSumUnder[c] = devSumUnder;
    rawOwnBot3Sum[c] = (ownsSorted[0] || 0) + (ownsSorted[1] || 0) + (ownsSorted[2] || 0);
    rawHProjMean[c] = hCount > 0 ? hProjSum / hCount : 0;
    rawProjMean[c] = projSum / lu.players.length;
    rawProjMin[c] = isFinite(projMin) ? projMin : 0;
    rawProjPerDollar[c] = salSum > 0 ? projSum / (salSum / 1000) : 0;
    rawHCeil85Sum[c] = hCeilSum;
    rawDevSum[c] = devSum;
  }

  // z-score each factor
  function zscore(arr: Float32Array): Float32Array {
    let s = 0, ss = 0;
    for (let i = 0; i < arr.length; i++) { s += arr[i]; ss += arr[i] * arr[i]; }
    const m = s / arr.length;
    const sd = Math.sqrt(Math.max(1e-9, ss / arr.length - m * m));
    const out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) out[i] = (arr[i] - m) / sd;
    return out;
  }
  const zPosProjZScoreSum = zscore(rawPosProjZScoreSum);
  const zDevSumUnder = zscore(rawDevSumUnder);
  const zOwnBot3Sum = zscore(rawOwnBot3Sum);
  const zHProjMean = zscore(rawHProjMean);
  const zProjMean = zscore(rawProjMean);
  const zProjMin = zscore(rawProjMin);
  const zProjPerDollar = zscore(rawProjPerDollar);
  const zHCeil85Sum = zscore(rawHCeil85Sum);
  const zDevSum = zscore(rawDevSum);

  // IC-weighted composite scores (REPLACING candEV)
  // 4 cluster reps: pos_proj_zscore_sum (C1), proj_min (C2), own_bot3_sum (C3), proj_mean=proj_vs_slate_p50 (C4)
  const scoreIC4 = new Float32Array(P);
  const scoreICAll = new Float32Array(P);
  for (let c = 0; c < P; c++) {
    scoreIC4[c] = 0.149 * zPosProjZScoreSum[c]
                + 0.124 * zProjMin[c]
                + 0.144 * zOwnBot3Sum[c]
                + 0.129 * zProjMean[c];
    scoreICAll[c] = 0.149 * zPosProjZScoreSum[c]
                  + 0.146 * zDevSumUnder[c]
                  + 0.144 * zOwnBot3Sum[c]
                  + 0.142 * zHProjMean[c]
                  + 0.132 * zDevSum[c]
                  + 0.129 * zProjMean[c]
                  + 0.124 * zProjPerDollar[c]
                  + 0.124 * zProjMin[c]
                  + 0.121 * zHCeil85Sum[c];
  }

  return {
    candidates, players, idMap, projAux,
    candEV, chalkRank, greedyPool, anchorIds, candBringback,
    zPosProjZScoreSum, zDevSumUnder, zOwnBot3Sum, zHProjMean,
    zProjMean, zProjMin, zProjPerDollar, zHCeil85Sum, zDevSum,
    scoreIC4, scoreICAll,
  };
}

interface VariantConfig {
  name: string;
  scoreSource: 'atlas' | 'ic4' | 'icAll';
  bbActive: boolean;  // use BB25 floors
}

function selectVariant(shared: SharedInput, config: VariantConfig): Lineup[] {
  const { candidates, candEV, chalkRank, greedyPool, anchorIds, candBringback, scoreIC4, scoreICAll } = shared;
  const selected: Lineup[] = [];
  const selectedSet = new Set<number>();
  const exposureCount = new Map<string, number>();
  const teamStackCount = new Map<string, number>();
  let bb1Selected = 0, bb2Selected = 0, bb3Selected = 0;

  // For ICAll/IC4 we DON'T restrict to top-K by candEV. We use ALL candidates as the greedy pool.
  // This is the architectural test: pure IC selection, no EV pre-filter.
  const useFullPool = config.scoreSource !== 'atlas';
  const pool = useFullPool
    ? new Int32Array(Array.from({ length: candidates.length }, (_, i) => i))
    : greedyPool;

  for (let step = 0; step < N; step++) {
    const requiredBB1 = config.bbActive ? Math.ceil(BB25_TARGET * (step + 1)) : 0;
    const requiredBB2 = config.bbActive ? Math.ceil(BB25_2_TARGET * (step + 1)) : 0;
    const requiredBB3 = config.bbActive ? Math.ceil(BB25_3_TARGET * (step + 1)) : 0;
    const needBB1 = config.bbActive && bb1Selected < requiredBB1;
    const needBB2 = config.bbActive && bb2Selected < requiredBB2;
    const needBB3 = config.bbActive && bb3Selected < requiredBB3;

    let bestIdx = -1; let bestScore = -Infinity;
    for (let gi = 0; gi < pool.length; gi++) {
      const c = pool[gi];
      if (selectedSet.has(c)) continue;
      if (needBB3 && candBringback[c] < 3) continue;
      else if (needBB2 && !needBB3 && candBringback[c] < 2) continue;
      else if (needBB1 && !needBB2 && !needBB3 && candBringback[c] < 1) continue;
      const lu = candidates[c];
      let okExp = true;
      for (const p of lu.players) {
        const isAnchor = anchorIds.has(p.id);
        const cap = isPitcher(p)
          ? (isAnchor ? STACKS_ANCHOR_PIT_CAP : ATLAS_EXPOSURE_CAP_PITCHER)
          : (isAnchor ? STACKS_ANCHOR_HIT_CAP : ATLAS_EXPOSURE_CAP_HITTER);
        const cnt = exposureCount.get(p.id) || 0;
        if (cnt >= Math.ceil(cap * N)) { okExp = false; break; }
      }
      if (!okExp) continue;
      const teamCounts = new Map<string, number>();
      for (const p of lu.players) {
        if (isPitcher(p)) continue;
        const t = (p.team || '').toUpperCase();
        teamCounts.set(t, (teamCounts.get(t) || 0) + 1);
      }
      let stackOk = true;
      for (const [t, cnt] of teamCounts) {
        if (cnt >= 4 && (teamStackCount.get(t) || 0) >= Math.ceil(ATLAS_TEAM_STACK_CAP * N)) { stackOk = false; break; }
      }
      if (!stackOk) continue;
      let nAnchors = 0;
      for (const p of lu.players) if (anchorIds.has(p.id)) nAnchors++;

      let score: number;
      if (config.scoreSource === 'atlas') {
        score = candEV[c] - ATLAS_W_MULTI_BLEND * chalkRank[c] + STACKS_ANCHOR_BOOST * nAnchors;
      } else if (config.scoreSource === 'ic4') {
        score = scoreIC4[c];  // pure IC composite, no EV
      } else {
        score = scoreICAll[c];  // all top-9 IC factors
      }
      if (score > bestScore) { bestScore = score; bestIdx = c; }
    }
    if (bestIdx === -1) {
      // fallback: ignore BB floors
      for (let gi = 0; gi < pool.length; gi++) {
        const c = pool[gi];
        if (selectedSet.has(c)) continue;
        const lu = candidates[c];
        let okExp = true;
        for (const p of lu.players) {
          const isAnchor = anchorIds.has(p.id);
          const cap = isPitcher(p)
            ? (isAnchor ? STACKS_ANCHOR_PIT_CAP : ATLAS_EXPOSURE_CAP_PITCHER)
            : (isAnchor ? STACKS_ANCHOR_HIT_CAP : ATLAS_EXPOSURE_CAP_HITTER);
          const cnt = exposureCount.get(p.id) || 0;
          if (cnt >= Math.ceil(cap * N)) { okExp = false; break; }
        }
        if (!okExp) continue;
        const teamCounts = new Map<string, number>();
        for (const p of lu.players) {
          if (isPitcher(p)) continue;
          const t = (p.team || '').toUpperCase();
          teamCounts.set(t, (teamCounts.get(t) || 0) + 1);
        }
        let stackOk = true;
        for (const [t, cnt] of teamCounts) {
          if (cnt >= 4 && (teamStackCount.get(t) || 0) >= Math.ceil(ATLAS_TEAM_STACK_CAP * N)) { stackOk = false; break; }
        }
        if (!stackOk) continue;
        let nAnchors = 0;
        for (const p of lu.players) if (anchorIds.has(p.id)) nAnchors++;
        let score: number;
        if (config.scoreSource === 'atlas') {
          score = candEV[c] - ATLAS_W_MULTI_BLEND * chalkRank[c] + STACKS_ANCHOR_BOOST * nAnchors;
        } else if (config.scoreSource === 'ic4') {
          score = scoreIC4[c];
        } else {
          score = scoreICAll[c];
        }
        if (score > bestScore) { bestScore = score; bestIdx = c; }
      }
      if (bestIdx === -1) break;
    }
    selected.push(candidates[bestIdx]);
    selectedSet.add(bestIdx);
    if (candBringback[bestIdx] >= 1) bb1Selected++;
    if (candBringback[bestIdx] >= 2) bb2Selected++;
    if (candBringback[bestIdx] >= 3) bb3Selected++;
    const lu = candidates[bestIdx];
    for (const p of lu.players) exposureCount.set(p.id, (exposureCount.get(p.id) || 0) + 1);
    const teamCounts = new Map<string, number>();
    for (const p of lu.players) {
      if (isPitcher(p)) continue;
      const t = (p.team || '').toUpperCase();
      teamCounts.set(t, (teamCounts.get(t) || 0) + 1);
    }
    for (const [t, cnt] of teamCounts) if (cnt >= 4) teamStackCount.set(t, (teamStackCount.get(t) || 0) + 1);
  }
  return selected;
}

function scoreTournament(portfolio: Lineup[], actuals: any): { cost: number; payout: number; roi: number; top1: number; top01: number } {
  if (portfolio.length === 0) return { cost: 0, payout: 0, roi: 0, top1: 0, top01: 0 };
  const cost = portfolio.length * FEE;
  const entryScores: number[] = [];
  for (const e of actuals.entries) entryScores.push(e.actualPoints);
  entryScores.sort((a, b) => b - a);
  const F = entryScores.length + portfolio.length;
  const payoutTable = buildPayoutTable(F);
  const playerActualsByName: Map<string, any> = actuals.playerActualsByName;
  const ourScores: number[] = [];
  for (const lu of portfolio) {
    let s = 0;
    for (const p of lu.players) {
      const pa = playerActualsByName.get(norm(p.name));
      if (pa && typeof pa.fpts === 'number') s += pa.fpts;
    }
    ourScores.push(s);
  }
  let payout = 0, top1 = 0, top01 = 0;
  for (const s of ourScores) {
    let lo = 0, hi = entryScores.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (entryScores[m] > s) lo = m + 1; else hi = m; }
    const rank = lo;
    if (rank < payoutTable.length) payout += payoutTable[rank];
    if (rank < F * 0.01) top1++;
    if (rank < F * 0.001) top01++;
  }
  return { cost, payout, roi: cost > 0 ? (payout / cost - 1) * 100 : 0, top1, top01 };
}

async function main() {
  console.log('=== PureIC backtest: REPLACE Atlas candEV foundation with IC-weighted score ===\n');
  const gbmSaved = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf-8'));
  const gbm2: GBMModel = gbmSaved.models['2'];

  const VARIANTS: VariantConfig[] = [
    { name: 'Atlas',           scoreSource: 'atlas', bbActive: false },
    { name: 'BB25',            scoreSource: 'atlas', bbActive: true },
    { name: 'PureIC4',         scoreSource: 'ic4',   bbActive: false },  // 4 cluster reps, no BB, no EV
    { name: 'PureIC4+BB25',    scoreSource: 'ic4',   bbActive: true },   // 4 cluster reps + BB25 floors
    { name: 'PureICAll',       scoreSource: 'icAll', bbActive: false },  // all 9 top IC, no BB
    { name: 'PureICAll+BB25',  scoreSource: 'icAll', bbActive: true },   // all 9 top IC + BB25
  ];

  const allRows: any[] = [];
  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj), actualsPath = path.join(DIR, s.actuals), poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) continue;
    const t0 = Date.now();
    try {
      const pr = parseCSVFile(projPath, 'mlb', true);
      const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
      const playerPool = buildPlayerPool(pr.players, pr.detectedContestType);
      const actuals = parseContestActuals(actualsPath, config);
      const idMap = new Map<string, Player>(); const nameMap = new Map<string, Player>();
      for (const p of playerPool.players) { idMap.set(p.id, p); nameMap.set(norm(p.name), p); }
      const projAux = loadProjAux(projPath);
      for (const p of playerPool.players) {
        const adj = projAux.adjOwn.get(p.id);
        if (adj !== undefined) p.ownership = adj;
      }
      const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
      const candidates: Lineup[] = Array.from(new Map<string, Lineup>(loaded.lineups.map(l => [l.hash, l])).values());
      if (candidates.length < 100) continue;
      const shared = computeShared({ candidates, players: playerPool.players, idMap, projAux, gbm2 });

      const variantResults: Record<string, any> = {};
      for (const v of VARIANTS) {
        const portfolio = selectVariant(shared, v);
        const tour = scoreTournament(portfolio, actuals);
        variantResults[v.name] = { size: portfolio.length, roi: tour.roi, top1: tour.top1, top01: tour.top01, cost: tour.cost, payout: tour.payout };
      }
      allRows.push({ slate: s.slate, candidates: candidates.length, variants: variantResults });
      const ts = (Date.now() - t0) / 1000;
      const summary = VARIANTS.map(v => `${v.name}:${variantResults[v.name].roi.toFixed(0).padStart(5)}%`).join(' | ');
      console.log(`  ${s.slate.padEnd(15)} P=${candidates.length} | ${summary} | ${ts.toFixed(1)}s`);
    } catch (e: any) {
      console.log(`  ${s.slate}: error — ${e?.message || e}`);
    }
  }

  // Aggregate
  console.log('\n=== AGGREGATE ===');
  console.log(`${'Variant'.padEnd(18)} ${'ROI%'.padStart(8)} ${'Profit'.padStart(7)} ${'top1'.padStart(6)} ${'top01'.padStart(6)} ${'cost'.padStart(9)} ${'payout'.padStart(10)}`);
  for (const v of VARIANTS) {
    const cost = allRows.reduce((s, r) => s + (r.variants[v.name]?.cost || 0), 0);
    const pay = allRows.reduce((s, r) => s + (r.variants[v.name]?.payout || 0), 0);
    const roi = cost > 0 ? (pay / cost - 1) * 100 : 0;
    const prof = allRows.filter(r => (r.variants[v.name]?.roi || 0) > 0).length;
    const top1 = allRows.reduce((s, r) => s + (r.variants[v.name]?.top1 || 0), 0);
    const top01 = allRows.reduce((s, r) => s + (r.variants[v.name]?.top01 || 0), 0);
    console.log(`${v.name.padEnd(18)} ${roi.toFixed(2).padStart(7)}% ${prof.toString().padStart(3)}/${allRows.length}  ${top1.toString().padStart(6)} ${top01.toString().padStart(6)} $${cost.toLocaleString().padStart(8)} $${pay.toFixed(0).padStart(9)}`);
  }
  fs.writeFileSync(OUT_JSON, JSON.stringify({ runDate: new Date().toISOString(), rows: allRows, variants: VARIANTS }, null, 2));
  console.log(`\nSaved ${OUT_JSON}`);
}

main().catch(e => { console.error(e); process.exit(1); });
