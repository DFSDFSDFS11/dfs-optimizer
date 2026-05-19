/**
 * Atlas vs Stacks-BB vs Stacks-IC — 29-slate LOO three-way backtest.
 *
 * Atlas        — flat caps + GBM chalk penalty (current shipped).
 * Stacks-BB    — Atlas + bring-back floor 17%/8% (validated +6.37pp on prior backtest).
 * Stacks-IC    — Atlas + bring-back floor + IC-weighted composite score from factor research.
 *
 * IC composite (mean-IC weighted on 30 contests):
 *   + ceil85_sum     (IC 0.097)
 *   + proj_per_dollar (IC 0.082)
 *   + own_min        (IC 0.073, sign-stable 75%)
 *   + own_prod_log   (IC 0.086)
 *   - leverage_proj_own (IC -0.075, growing more negative)
 *
 * Per Theory of DFS Ch.4: projection + correlation + leverage. IC analysis empirically
 * grounded which factors are signal vs noise.
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
const OUT_JSON = path.join(DIR, 'atlas_vs_stacks_results.json');
const PRO_CONSENSUS_PATH = path.join(DIR, 'pro_consensus_slate_relative.json');
const MODEL_PATH = path.join(DIR, 'multi_combo_penalty_implementation', 'argus_gbm_v3_model.json');
const N = 150;
const FEE = 20;

// Atlas parameters (matches _argus_atlas_preslate.ts).
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

// Stacks params (Atlas + lineup-level shaping)
const STACKS_ANCHOR_HIT_CAP = 0.55;
const STACKS_ANCHOR_PIT_CAP = 0.70;
const STACKS_N_HIT_ANCHORS = 3;
const STACKS_N_PIT_ANCHORS = 1;
const STACKS_ANCHOR_BOOST = 5.0;
const STACKS_BRINGBACK_TARGET = 0.17;
const STACKS_BRINGBACK_2_TARGET = 0.08;
const STACKS_LEVERAGE_BOOST = 0;  // disabled — IC analysis showed negative IC
const STACKS_LEVERAGE_TOP_PCT = 0.40;
const STACKS_LEVERAGE_FLOOR = 0;

// IC-composite scoring weights (proportional to mean IC magnitudes from ic_summary.csv).
// These multiply z-scored factor values; the composite is then added to candEV.
const IC_W_CEIL85 = parseFloat(process.env.IC_W_CEIL85 || '0.097');
const IC_W_PROJ_PER_DOLLAR = parseFloat(process.env.IC_W_PROJ_PER_DOLLAR || '0.082');
const IC_W_OWN_PROD = parseFloat(process.env.IC_W_OWN_PROD || '0.086');
const IC_W_OWN_MIN = parseFloat(process.env.IC_W_OWN_MIN || '0.073');
const IC_W_LEVERAGE = parseFloat(process.env.IC_W_LEVERAGE || '-0.075');  // NEGATIVE — penalize high leverage
const IC_SCALE = parseFloat(process.env.IC_SCALE || '40');  // scale composite to be commensurate with EV ($)

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

const UNIVERSAL_METRICS = ['projRatioToOptimal', 'ceilingRatioToOptimal', 'avgPlayerOwnPctile', 'ownStdRatio', 'ownDeltaFromAnchor'] as const;

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

function poolChalkAnchorOwn(candidates: Lineup[]): number {
  const owns: number[] = [];
  for (const lu of candidates) {
    if (!lu.players.length) continue;
    let s = 0; for (const p of lu.players) s += (p.ownership || 0);
    owns.push(s / lu.players.length);
  }
  owns.sort((a, b) => b - a);
  const topN = Math.min(100, owns.length);
  if (topN === 0) return 0;
  let s = 0; for (let i = 0; i < topN; i++) s += owns[i];
  return s / topN;
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

// ===== GBM v3 inference =====

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

// ===== Atlas selector function =====

function findRank(score: number, sortedDesc: Float64Array): number {
  let lo = 0, hi = sortedDesc.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (sortedDesc[m] > score) lo = m + 1; else hi = m; }
  return lo;
}

interface AtlasInput {
  candidates: Lineup[];
  players: Player[];
  idMap: Map<string, Player>;
  projAux: ReturnType<typeof loadProjAux>;
  gbm2: GBMModel;
}

function selectAtlasPortfolio(input: AtlasInput): Lineup[] {
  const { candidates, players, idMap, projAux, gbm2 } = input;
  const P = candidates.length;

  // T-copula sim.
  const sim = generateWorlds(players, ATLAS_NUM_WORLDS, ATLAS_NU, ATLAS_SEED);
  const playerIdx = new Map<string, number>();
  for (let i = 0; i < players.length; i++) playerIdx.set(players[i].id, i);

  // Score candidates per world.
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

  // Uniform field sample + sort per world.
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

  // EV-vs-field per candidate.
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

  // GBM v3 combo prior (2-combo chalk score).
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
      Math.log(Math.max(SMALL, poolFreq)),
      Math.log(Math.max(SMALL, ownProd)),
      sameTeam ? 1 : 0,
      Math.log(Math.max(SMALL, projSum)),
      Math.log(Math.max(SMALL, salSum)),
      Math.log(Math.max(SMALL, gameTotalSum)),
      Math.log(Math.max(SMALL, saberTeamSum)),
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

  // Top-K pool by EV.
  const evRankIdx = Array.from({ length: P }, (_, i) => i).sort((a, b) => candEV[b] - candEV[a]);
  const greedyPool = new Int32Array(evRankIdx.slice(0, Math.min(ATLAS_TOP_K_GREEDY, P)));

  // Greedy selection.
  const selected: Lineup[] = [];
  const selectedSet = new Set<number>();
  const exposureCount = new Map<string, number>();
  const teamStackCount = new Map<string, number>();
  for (let step = 0; step < N; step++) {
    let bestIdx = -1; let bestScore = -Infinity;
    for (let gi = 0; gi < greedyPool.length; gi++) {
      const c = greedyPool[gi];
      if (selectedSet.has(c)) continue;
      const lu = candidates[c];
      let okExp = true;
      for (const p of lu.players) {
        const cap = isPitcher(p) ? ATLAS_EXPOSURE_CAP_PITCHER : ATLAS_EXPOSURE_CAP_HITTER;
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
      const score = candEV[c] - ATLAS_W_MULTI_BLEND * chalkRank[c];
      if (score > bestScore) { bestScore = score; bestIdx = c; }
    }
    if (bestIdx === -1) break;
    selected.push(candidates[bestIdx]);
    selectedSet.add(bestIdx);
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

// ===== Stacks selector (Atlas + bring-back + leverage floors) =====

function selectStacksPortfolio(input: AtlasInput): Lineup[] {
  const { candidates, players, idMap, projAux, gbm2 } = input;
  const P = candidates.length;

  // Reuse Atlas's sim + EV + chalk-score pipeline (identical to selectAtlasPortfolio up to the greedy).
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

  // === STACKS-SPECIFIC: anchor IDs ===
  const playerInPool = new Set<string>();
  for (const lu of candidates) for (const p of lu.players) playerInPool.add(p.id);
  const hitterCandidates = players.filter(p => !isPitcher(p) && playerInPool.has(p.id))
    .sort((a, b) => (b.projection || 0) - (a.projection || 0));
  const pitcherCandidates = players.filter(p => isPitcher(p) && playerInPool.has(p.id))
    .sort((a, b) => (b.projection || 0) - (a.projection || 0));
  const anchorIds = new Set<string>();
  for (const p of hitterCandidates.slice(0, STACKS_N_HIT_ANCHORS)) anchorIds.add(p.id);
  for (const p of pitcherCandidates.slice(0, STACKS_N_PIT_ANCHORS)) anchorIds.add(p.id);

  // === STACKS-SPECIFIC: bring-back precompute ===
  const candBringback = new Int8Array(P);
  const candPrimaryTeam = new Array<string>(P);
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
    candPrimaryTeam[c] = primary;
    let bb = 0;
    if (primary && teamOpp.has(primary)) bb = tc.get(teamOpp.get(primary)!) || 0;
    candBringback[c] = Math.min(bb, 4);
  }

  // === STACKS-SPECIFIC: leverage stacks ===
  const teamHitterAgg = new Map<string, { projs: number[]; owns: number[] }>();
  for (const p of players) {
    if (isPitcher(p)) continue;
    const t = (p.team || '').toUpperCase();
    if (!t) continue;
    if (!teamHitterAgg.has(t)) teamHitterAgg.set(t, { projs: [], owns: [] });
    const r = teamHitterAgg.get(t)!;
    r.projs.push(p.projection || 0);
    r.owns.push(p.ownership || 0);
  }
  const teamLev = new Map<string, number>();
  for (const [t, r] of teamHitterAgg) {
    r.projs.sort((a, b) => b - a); r.owns.sort((a, b) => b - a);
    const p5 = r.projs.slice(0, 5).reduce((s, x) => s + x, 0);
    const o5 = r.owns.slice(0, 5).reduce((s, x) => s + x, 0);
    teamLev.set(t, p5 / Math.max(1, o5));
  }
  const sortedTeams = [...teamLev.entries()].sort((a, b) => b[1] - a[1]);
  const nLevTeams = Math.max(1, Math.ceil(sortedTeams.length * STACKS_LEVERAGE_TOP_PCT));
  const leverageTeams = new Set<string>();
  for (let i = 0; i < nLevTeams; i++) leverageTeams.add(sortedTeams[i][0]);

  // === Greedy with floors ===
  const selected: Lineup[] = [];
  const selectedSet = new Set<number>();
  const exposureCount = new Map<string, number>();
  const teamStackCount = new Map<string, number>();
  let bb1Selected = 0, bb2Selected = 0, levSelected = 0;
  for (let step = 0; step < N; step++) {
    const requiredBB1 = Math.ceil(STACKS_BRINGBACK_TARGET * (step + 1));
    const requiredBB2 = Math.ceil(STACKS_BRINGBACK_2_TARGET * (step + 1));
    const requiredLev = Math.ceil(STACKS_LEVERAGE_FLOOR * (step + 1));
    const needBB1 = bb1Selected < requiredBB1;
    const needBB2 = bb2Selected < requiredBB2;
    const needLev = levSelected < requiredLev;

    let bestIdx = -1; let bestScore = -Infinity;
    for (let gi = 0; gi < greedyPool.length; gi++) {
      const c = greedyPool[gi];
      if (selectedSet.has(c)) continue;
      if (needBB2 && candBringback[c] < 2) continue;
      else if (needBB1 && !needBB2 && candBringback[c] < 1) continue;
      if (needLev && !leverageTeams.has(candPrimaryTeam[c])) continue;
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
      const levBonus = leverageTeams.has(candPrimaryTeam[c]) ? STACKS_LEVERAGE_BOOST : 0;
      const score = candEV[c] - ATLAS_W_MULTI_BLEND * chalkRank[c] + STACKS_ANCHOR_BOOST * nAnchors + levBonus;
      if (score > bestScore) { bestScore = score; bestIdx = c; }
    }
    if (bestIdx === -1) {
      // Floor retry without restrictions
      for (let gi = 0; gi < greedyPool.length; gi++) {
        const c = greedyPool[gi];
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
        const levBonus = leverageTeams.has(candPrimaryTeam[c]) ? STACKS_LEVERAGE_BOOST : 0;
        const score = candEV[c] - ATLAS_W_MULTI_BLEND * chalkRank[c] + STACKS_ANCHOR_BOOST * nAnchors + levBonus;
        if (score > bestScore) { bestScore = score; bestIdx = c; }
      }
      if (bestIdx === -1) break;
    }
    selected.push(candidates[bestIdx]);
    selectedSet.add(bestIdx);
    if (candBringback[bestIdx] >= 1) bb1Selected++;
    if (candBringback[bestIdx] >= 2) bb2Selected++;
    if (leverageTeams.has(candPrimaryTeam[bestIdx])) levSelected++;
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

// ===== Stacks-IC selector (Atlas + bring-back floor + IC composite score) =====

function selectStacksICPortfolio(input: AtlasInput): Lineup[] {
  const { candidates, players, idMap, projAux, gbm2 } = input;
  const P = candidates.length;

  // Atlas pipeline (sim + EV + chalk).
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

  // === STACKS: anchor IDs, bring-back ===
  const playerInPool = new Set<string>();
  for (const lu of candidates) for (const p of lu.players) playerInPool.add(p.id);
  const hitterCandidates = players.filter(p => !isPitcher(p) && playerInPool.has(p.id))
    .sort((a, b) => (b.projection || 0) - (a.projection || 0));
  const pitcherCandidates = players.filter(p => isPitcher(p) && playerInPool.has(p.id))
    .sort((a, b) => (b.projection || 0) - (a.projection || 0));
  const anchorIds = new Set<string>();
  for (const p of hitterCandidates.slice(0, STACKS_N_HIT_ANCHORS)) anchorIds.add(p.id);
  for (const p of pitcherCandidates.slice(0, STACKS_N_PIT_ANCHORS)) anchorIds.add(p.id);
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

  // === IC-COMPOSITE: precompute z-scored factor values per candidate ===
  // Factors: ceil85_sum, proj_per_dollar, own_prod_log, own_min, leverage_proj_own
  const fCeil85 = new Float32Array(P);
  const fProjPerDollar = new Float32Array(P);
  const fOwnProd = new Float32Array(P);
  const fOwnMin = new Float32Array(P);
  const fLeverage = new Float32Array(P);
  for (let c = 0; c < P; c++) {
    const lu = candidates[c];
    let ceil85 = 0, proj = 0, sal = 0, ownLog = 0, ownMin = 100, ownSum = 0;
    for (const p of lu.players) {
      // Approximate ceiling from std_dev (Atlas doesn't have direct ceil85; estimate proj * 1.5 + 0.85*std)
      const c85 = (p.projection || 0) * 1.5;  // crude approximation since pool doesn't carry percentiles
      ceil85 += c85;
      proj += p.projection || 0;
      sal += p.salary || 0;
      const o = p.ownership || 0;
      ownLog += Math.log(Math.max(0.001, o / 100));
      ownSum += o;
      if (o < ownMin) ownMin = o;
    }
    fCeil85[c] = ceil85;
    fProjPerDollar[c] = sal > 0 ? proj / (sal / 1000) : 0;
    fOwnProd[c] = ownLog;
    fOwnMin[c] = ownMin;
    fLeverage[c] = proj / Math.max(0.001, ownSum);
  }
  // z-score
  function zscore(arr: Float32Array): Float32Array {
    let s = 0, ss = 0;
    for (let i = 0; i < arr.length; i++) { s += arr[i]; ss += arr[i]*arr[i]; }
    const m = s / arr.length;
    const v = Math.max(1e-9, ss / arr.length - m*m);
    const sd = Math.sqrt(v);
    const out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) out[i] = (arr[i] - m) / sd;
    return out;
  }
  const zCeil85 = zscore(fCeil85);
  const zPPD = zscore(fProjPerDollar);
  const zOwnProd = zscore(fOwnProd);
  const zOwnMin = zscore(fOwnMin);
  const zLev = zscore(fLeverage);
  const icComposite = new Float32Array(P);
  for (let c = 0; c < P; c++) {
    icComposite[c] = IC_SCALE * (
      IC_W_CEIL85 * zCeil85[c]
      + IC_W_PROJ_PER_DOLLAR * zPPD[c]
      + IC_W_OWN_PROD * zOwnProd[c]
      + IC_W_OWN_MIN * zOwnMin[c]
      + IC_W_LEVERAGE * zLev[c]
    );
  }

  // === Greedy with bring-back floor + IC composite ===
  const selected: Lineup[] = [];
  const selectedSet = new Set<number>();
  const exposureCount = new Map<string, number>();
  const teamStackCount = new Map<string, number>();
  let bb1Selected = 0, bb2Selected = 0;
  for (let step = 0; step < N; step++) {
    const requiredBB1 = Math.ceil(STACKS_BRINGBACK_TARGET * (step + 1));
    const requiredBB2 = Math.ceil(STACKS_BRINGBACK_2_TARGET * (step + 1));
    const needBB1 = bb1Selected < requiredBB1;
    const needBB2 = bb2Selected < requiredBB2;
    let bestIdx = -1; let bestScore = -Infinity;
    for (let gi = 0; gi < greedyPool.length; gi++) {
      const c = greedyPool[gi];
      if (selectedSet.has(c)) continue;
      if (needBB2 && candBringback[c] < 2) continue;
      else if (needBB1 && !needBB2 && candBringback[c] < 1) continue;
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
      const score = candEV[c] - ATLAS_W_MULTI_BLEND * chalkRank[c] + STACKS_ANCHOR_BOOST * nAnchors + icComposite[c];
      if (score > bestScore) { bestScore = score; bestIdx = c; }
    }
    if (bestIdx === -1) break;
    selected.push(candidates[bestIdx]);
    selectedSet.add(bestIdx);
    if (candBringback[bestIdx] >= 1) bb1Selected++;
    if (candBringback[bestIdx] >= 2) bb2Selected++;
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

// ===== Evaluation metrics =====

interface SlateStats {
  optimalLineupProj: number;
  optimalLineupCeiling: number;
  chalkAnchorOwn: number;
  slateAvgPlayerOwn: number;
  ownPercentileByPlayerId: Map<string, number>;
}

function computeSlateStats(players: Player[], allLineups: Player[][]): SlateStats {
  let optProj = 0, optCeil = 0;
  const lineupOwnPairs: { meanOwn: number }[] = [];
  for (const lu of allLineups) {
    let p = 0, c = 0, o = 0;
    for (const pl of lu) { p += pl.projection || 0; c += (pl as any).ceiling || (pl.projection || 0) * 1.4; o += pl.ownership || 0; }
    if (p > optProj) optProj = p;
    if (c > optCeil) optCeil = c;
    lineupOwnPairs.push({ meanOwn: o / lu.length });
  }
  lineupOwnPairs.sort((a, b) => b.meanOwn - a.meanOwn);
  const topN = Math.min(100, lineupOwnPairs.length);
  const chalkAnchor = mean(lineupOwnPairs.slice(0, topN).map(x => x.meanOwn));
  const slateAvg = mean(players.map(p => p.ownership || 0));
  const ownPctile = new Map<string, number>();
  const sortedByOwn = [...players].sort((a, b) => (a.ownership || 0) - (b.ownership || 0));
  for (let i = 0; i < sortedByOwn.length; i++) {
    ownPctile.set(sortedByOwn[i].id, sortedByOwn.length > 1 ? i / (sortedByOwn.length - 1) : 0);
  }
  return { optimalLineupProj: optProj, optimalLineupCeiling: optCeil, chalkAnchorOwn: chalkAnchor, slateAvgPlayerOwn: slateAvg, ownPercentileByPlayerId: ownPctile };
}

interface UniversalMetrics {
  projRatioToOptimal: number;
  ceilingRatioToOptimal: number;
  avgPlayerOwnPctile: number;
  ownStdRatio: number;
  ownDeltaFromAnchor: number;
}

function computeUniversal(lineups: Player[][], stats: SlateStats): UniversalMetrics {
  if (!lineups.length) return { projRatioToOptimal: 0, ceilingRatioToOptimal: 0, avgPlayerOwnPctile: 0, ownStdRatio: 0, ownDeltaFromAnchor: 0 };
  const luProjs: number[] = [], luCeils: number[] = [], luOwns: number[] = [], luOwnStds: number[] = [], pctileSums: number[] = [];
  for (const players of lineups) {
    const owns = players.map(p => p.ownership || 0);
    luOwns.push(mean(owns));
    luProjs.push(players.reduce((s, p) => s + (p.projection || 0), 0));
    luCeils.push(players.reduce((s, p) => s + ((p as any).ceiling || (p.projection || 0) * 1.4), 0));
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
  console.log('================================================================');
  console.log('Atlas vs Stacks-BB vs Stacks-IC — 29-slate LOO three-way backtest');
  console.log('================================================================\n');

  // Load GBM v3 (one-time).
  if (!fs.existsSync(MODEL_PATH)) { console.error(`Missing GBM v3: ${MODEL_PATH}`); process.exit(1); }
  const gbmSaved = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf-8'));
  const gbm2: GBMModel = gbmSaved.models['2'];
  console.log(`Loaded GBM v3 model.\n`);

  // Pro consensus.
  const consensusRaw = JSON.parse(fs.readFileSync(PRO_CONSENSUS_PATH, 'utf-8'));
  const consBySlate: Record<string, Record<string, { mean: number; std: number }>> = {};
  for (const k of UNIVERSAL_METRICS) {
    for (const entry of (consensusRaw.metrics[k] || [])) {
      if (!consBySlate[entry.slate]) consBySlate[entry.slate] = {};
      consBySlate[entry.slate][k] = { mean: entry.mean, std: entry.std };
    }
  }
  function mahalanobis(m: UniversalMetrics, slate: string): number | null {
    const c = consBySlate[slate]; if (!c) return null;
    let sum = 0; let n = 0;
    for (const k of UNIVERSAL_METRICS) {
      const cc = c[k]; if (!cc || cc.std < 1e-9) continue;
      const d = ((m as any)[k] - cc.mean) / cc.std;
      sum += d * d; n++;
    }
    return n > 0 ? Math.sqrt(sum / n) : null;
  }

  interface Variant {
    size: number; roi: number; mahal: number | null; top1: number; top01: number;
    cost: number; payout: number; metrics: UniversalMetrics;
  }
  interface SlateRow {
    slate: string; candidates: number; poolAnchor: number; fieldAnchor: number;
    atlas: Variant; v2nr: Variant; ic: Variant;
  }
  const rows: SlateRow[] = [];

  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj), actualsPath = path.join(DIR, s.actuals), poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) { console.log(`  ${s.slate}: missing, skip`); continue; }
    const t0 = Date.now();
    try {
      const pr = parseCSVFile(projPath, 'mlb', true);
      const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
      const playerPool = buildPlayerPool(pr.players, pr.detectedContestType);
      const actuals = parseContestActuals(actualsPath, config);
      const idMap = new Map<string, Player>(); const nameMap = new Map<string, Player>();
      for (const p of playerPool.players) { idMap.set(p.id, p); nameMap.set(norm(p.name), p); }

      // Adj Own override — preslate parity.
      const projAux = loadProjAux(projPath);
      for (const p of playerPool.players) {
        const adj = projAux.adjOwn.get(p.id);
        if (adj !== undefined) p.ownership = adj;
      }

      const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
      const candidates: Lineup[] = Array.from(new Map<string, Lineup>(loaded.lineups.map(l => [l.hash, l])).values());
      if (candidates.length < 100) { console.log(`  ${s.slate}: P=${candidates.length} too small`); continue; }

      // Field for evaluation.
      const fieldLineups: Player[][] = [];
      for (const e of actuals.entries) {
        const pls: Player[] = []; let ok = true;
        for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
        if (ok) fieldLineups.push(pls);
      }
      const stats = computeSlateStats(playerPool.players, fieldLineups);
      const poolAnchor = poolChalkAnchorOwn(candidates);

      // === Atlas ===
      const atlasPortfolio = selectAtlasPortfolio({ candidates, players: playerPool.players, idMap, projAux, gbm2 });
      const atlasMetrics = computeUniversal(atlasPortfolio.map(lu => lu.players), stats);
      const atlasMahal = mahalanobis(atlasMetrics, s.slate);
      const atlasTourney = scoreTournament(atlasPortfolio, actuals);

      // === Stacks-BB ===
      const stacksPortfolio = selectStacksPortfolio({ candidates, players: playerPool.players, idMap, projAux, gbm2 });
      const stacksMetrics = computeUniversal(stacksPortfolio.map(lu => lu.players), stats);
      const stacksMahal = mahalanobis(stacksMetrics, s.slate);
      const stacksTourney = scoreTournament(stacksPortfolio, actuals);

      // === Stacks-IC ===
      const icPortfolio = selectStacksICPortfolio({ candidates, players: playerPool.players, idMap, projAux, gbm2 });
      const icMetrics = computeUniversal(icPortfolio.map(lu => lu.players), stats);
      const icMahal = mahalanobis(icMetrics, s.slate);
      const icTourney = scoreTournament(icPortfolio, actuals);

      rows.push({
        slate: s.slate, candidates: candidates.length, poolAnchor, fieldAnchor: stats.chalkAnchorOwn,
        atlas: { size: atlasPortfolio.length, roi: atlasTourney.roi, mahal: atlasMahal, top1: atlasTourney.top1, top01: atlasTourney.top01, cost: atlasTourney.cost, payout: atlasTourney.payout, metrics: atlasMetrics },
        v2nr:  { size: stacksPortfolio.length, roi: stacksTourney.roi, mahal: stacksMahal, top1: stacksTourney.top1, top01: stacksTourney.top01, cost: stacksTourney.cost, payout: stacksTourney.payout, metrics: stacksMetrics },
        ic:    { size: icPortfolio.length, roi: icTourney.roi, mahal: icMahal, top1: icTourney.top1, top01: icTourney.top01, cost: icTourney.cost, payout: icTourney.payout, metrics: icMetrics },
      });

      const ts = (Date.now() - t0) / 1000;
      console.log(
        `  ${s.slate.padEnd(15)} P=${candidates.length} | ` +
        `atlas:${atlasTourney.roi.toFixed(0).padStart(5)}%/t1=${atlasTourney.top1} | ` +
        `bb:${stacksTourney.roi.toFixed(0).padStart(5)}%/t1=${stacksTourney.top1} | ` +
        `ic:${icTourney.roi.toFixed(0).padStart(5)}%/t1=${icTourney.top1} | ${ts.toFixed(1)}s`,
      );
    } catch (e: any) {
      console.log(`  ${s.slate}: error — ${e?.message || e}`);
    }
  }

  // Aggregate.
  console.log('\n================================================================');
  console.log('AGGREGATE — leakage-free 29-slate');
  console.log('================================================================\n');

  function agg(pick: 'atlas' | 'v2nr' | 'ic') {
    const cost = rows.reduce((s, r) => s + r[pick].cost, 0);
    const pay = rows.reduce((s, r) => s + r[pick].payout, 0);
    const roi = cost > 0 ? (pay / cost - 1) * 100 : 0;
    const prof = rows.filter(r => r[pick].roi > 0).length;
    const top1 = rows.reduce((s, r) => s + r[pick].top1, 0);
    const top01 = rows.reduce((s, r) => s + r[pick].top01, 0);
    const dists = rows.map(r => r[pick].mahal).filter((d): d is number => d !== null);
    return { cost, pay, roi, prof, top1, top01, meanD: mean(dists), distsN: dists.length, dLt15: dists.filter(d => d < 1.5).length, dLt20: dists.filter(d => d < 2.0).length };
  }
  function loo(pick: 'atlas' | 'v2nr' | 'ic') {
    const tot = agg(pick);
    const out: { slate: string; roi: number }[] = [];
    let worst = Infinity, worstSlate = '';
    for (const r of rows) {
      const c2 = tot.cost - r[pick].cost;
      const p2 = tot.pay - r[pick].payout;
      const roi2 = c2 > 0 ? (p2 / c2 - 1) * 100 : 0;
      out.push({ slate: r.slate, roi: roi2 });
      if (roi2 < worst) { worst = roi2; worstSlate = r.slate; }
    }
    return { mean: mean(out.map(o => o.roi)), std: stddev(out.map(o => o.roi)), worst, worstSlate };
  }

  const aAgg = agg('atlas'), vAgg = agg('v2nr'), iAgg = agg('ic');
  const aLoo = loo('atlas'), vLoo = loo('v2nr'), iLoo = loo('ic');

  console.log('Metric                       Atlas         Stacks-BB         Stacks-IC');
  console.log('---------------------------------------------------------------------------');
  console.log(`Slates                       ${rows.length}              ${rows.length}              ${rows.length}`);
  console.log(`Total cost                   $${aAgg.cost.toLocaleString().padStart(8)}      $${vAgg.cost.toLocaleString().padStart(8)}      $${iAgg.cost.toLocaleString().padStart(8)}`);
  console.log(`Total payout                 $${aAgg.pay.toFixed(0).padStart(8)}      $${vAgg.pay.toFixed(0).padStart(8)}      $${iAgg.pay.toFixed(0).padStart(8)}`);
  console.log(`Full-sample ROI              ${aAgg.roi.toFixed(2).padStart(8)}%    ${vAgg.roi.toFixed(2).padStart(8)}%    ${iAgg.roi.toFixed(2).padStart(8)}%`);
  console.log(`Profitable                   ${aAgg.prof}/${rows.length}            ${vAgg.prof}/${rows.length}            ${iAgg.prof}/${rows.length}`);
  console.log(`Top-1% hits                  ${aAgg.top1.toString().padStart(8)}      ${vAgg.top1.toString().padStart(8)}      ${iAgg.top1.toString().padStart(8)}`);
  console.log(`Top-0.1% hits                ${aAgg.top01.toString().padStart(8)}      ${vAgg.top01.toString().padStart(8)}      ${iAgg.top01.toString().padStart(8)}`);
  console.log(`LOO mean ROI                 ${aLoo.mean.toFixed(2).padStart(8)}%    ${vLoo.mean.toFixed(2).padStart(8)}%    ${iLoo.mean.toFixed(2).padStart(8)}%`);
  console.log(`LOO std                      ${aLoo.std.toFixed(2).padStart(8)}%    ${vLoo.std.toFixed(2).padStart(8)}%    ${iLoo.std.toFixed(2).padStart(8)}%`);
  console.log(`LOO worst drop               ${aLoo.worst.toFixed(2).padStart(8)}%    ${vLoo.worst.toFixed(2).padStart(8)}%    ${iLoo.worst.toFixed(2).padStart(8)}%`);
  console.log(`Mean Mahalanobis             ${aAgg.meanD.toFixed(3).padStart(8)}     ${vAgg.meanD.toFixed(3).padStart(8)}     ${iAgg.meanD.toFixed(3).padStart(8)}    (target <1.5)`);
  console.log(`Slates d<1.5                 ${aAgg.dLt15}/${aAgg.distsN}           ${vAgg.dLt15}/${vAgg.distsN}           ${iAgg.dLt15}/${iAgg.distsN}`);
  console.log(`Slates d<2.0                 ${aAgg.dLt20}/${aAgg.distsN}          ${vAgg.dLt20}/${vAgg.distsN}          ${iAgg.dLt20}/${iAgg.distsN}`);

  console.log('\n--- 5-principle structural fidelity ---');
  console.log('Metric                       pro tgt    Atlas              Stacks-BB         Stacks-IC');
  for (const k of UNIVERSAL_METRICS) {
    const aVals = rows.map(r => (r.atlas.metrics as any)[k]);
    const vVals = rows.map(r => (r.v2nr.metrics as any)[k]);
    const iVals = rows.map(r => (r.ic.metrics as any)[k]);
    const aM = mean(aVals);
    const vM = mean(vVals);
    const iM = mean(iVals);
    const tgt = ({ projRatioToOptimal: 0.88, ceilingRatioToOptimal: 0.92, avgPlayerOwnPctile: 0.94, ownStdRatio: 7.1, ownDeltaFromAnchor: -7.2 } as any)[k];
    console.log(`  ${k.padEnd(28)} ${tgt.toString().padStart(7)} | ${aM.toFixed(3).padStart(8)} | ${vM.toFixed(3).padStart(8)} | ${iM.toFixed(3).padStart(8)}`);
  }

  fs.writeFileSync(OUT_JSON, JSON.stringify({ runDate: new Date().toISOString(), nSlates: rows.length, rows, atlas: { agg: aAgg, loo: aLoo }, stacksBB: { agg: vAgg, loo: vLoo }, stacksIC: { agg: iAgg, loo: iLoo } }, null, 2));
  console.log(`\nResults saved to ${OUT_JSON}`);

  // Gate decisions.
  console.log('\n================================================================');
  console.log('GATE DECISIONS');
  console.log('================================================================\n');
  for (const [label, a, l] of [['Atlas', aAgg, aLoo] as const, ['Stacks-BB', vAgg, vLoo] as const, ['Stacks-IC', iAgg, iLoo] as const]) {
    const g1 = a.roi >= 50, g2 = a.meanD < 1.5, g3 = l.mean > 0;
    console.log(`${label.padEnd(12)}  Gate1(ROI≥+50%)=${a.roi.toFixed(1)}% ${g1 ? 'PASS' : 'FAIL'}  |  Gate2(mahal<1.5)=${a.meanD.toFixed(3)} ${g2 ? 'PASS' : 'FAIL'}  |  Gate3(LOO>0)=${l.mean.toFixed(1)}% ${g3 ? 'PASS' : 'FAIL'}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
