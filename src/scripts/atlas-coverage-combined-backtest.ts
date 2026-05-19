/**
 * Atlas + Coverage combined selector — 29-slate 3-way head-to-head.
 *
 * Two-stage selector that combines Atlas's "beat the field" edge with
 * v2-no-reg's "cover unique winning worlds" edge:
 *
 *   STAGE 1 (Atlas pre-filter):
 *     - T-copula sim (1500 worlds, ν=5)
 *     - Uniform field sample (8000)
 *     - EV-vs-field per candidate (Haugh-Singal payout rank)
 *     - GBM v3 2-combo chalk score → chalkRank
 *     - atlasScore[c] = candEV[c] − W_MULTI×chalkRank[c]
 *     - Pre-filter: top-1000 by atlasScore
 *
 *   STAGE 2 (v2-no-reg coverage greedy on top-1000):
 *     - Reuses per-world candScores from stage 1's sim (no second sim)
 *     - Greedy E[max(portfolio score across worlds)]
 *     - Exposure caps + team-stack cap (same as Atlas)
 *     - atlasScore fallback for unfilled slots
 *
 * Compared head-to-head against Atlas-alone and v2-no-reg-alone on the same
 * 29 slates with identical leakage-free inputs.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as csvParse } from 'csv-parse/sync';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, loadPoolFromCSV, parseContestActuals } from '../parser';
import { getContestConfig } from '../rules';
import { generateWorlds } from '../v35/simulation';
import { THEORY_V1_NOCORR_PARAMS, isPitcher } from '../theory/v1-selector';
import { computeLineupSimStats } from '../theory/v1-sim-stats';
import { selectPortfolioCoverageV2Portfolio } from '../theory/v1-portfolio-coverage-v2-selector';

const DIR = 'C:/Users/colin/dfs opto';
const OUT_JSON = path.join(DIR, 'atlas_coverage_combined_k2500_results.json');
const PRO_CONSENSUS_PATH = path.join(DIR, 'pro_consensus_slate_relative.json');
const MODEL_PATH = path.join(DIR, 'multi_combo_penalty_implementation', 'argus_gbm_v3_model.json');
const N = 150;
const FEE = 20;

const NUM_WORLDS = 1500;
const NU = 5;
const SEED = 12345;
const FIELD_SIZE = 8000;
const W_MULTI_BLEND = 10;
const COMBINED_PRE_FILTER_K = 2500;       // ← user-specified (was 1000)
const ATLAS_TOP_K_GREEDY = 1500;
const EXPOSURE_CAP_HITTER = 0.25;
const EXPOSURE_CAP_PITCHER = 0.45;
const TEAM_STACK_CAP = 0.20;
const SMALL = 1e-9;

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
interface GBMModel { trees: TreeNode[]; basePred: number; learningRate: number; }
function predictTree(tree: TreeNode, x: number[]): number { let n: TreeNode = tree; while (n.feature !== undefined) { if (x[n.feature] < n.threshold!) n = n.left!; else n = n.right!; } return n.leafValue || 0; }
function predictGBM(model: GBMModel, x: number[]): number { let p = model.basePred; for (const tree of model.trees) p += model.learningRate * predictTree(tree, x); return p; }

function findRank(score: number, sortedDesc: Float64Array): number {
  let lo = 0, hi = sortedDesc.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (sortedDesc[m] > score) lo = m + 1; else hi = m; }
  return lo;
}

// ===== Atlas core (returns per-candidate atlasScore + candScores matrix) =====

interface AtlasComputed {
  candScores: Float32Array;     // [P × NUM_WORLDS] row-major
  candEV: Float64Array;
  chalkRank: Float64Array;
  atlasScore: Float64Array;     // candEV − W_MULTI×chalkRank
  atlasRankIdx: number[];       // candidates sorted by atlasScore desc
}

function computeAtlasArtifacts(candidates: Lineup[], players: Player[], idMap: Map<string, Player>, projAux: ReturnType<typeof loadProjAux>, gbm2: GBMModel): AtlasComputed {
  const P = candidates.length;
  const sim = generateWorlds(players, NUM_WORLDS, NU, SEED);
  const playerIdx = new Map<string, number>();
  for (let i = 0; i < players.length; i++) playerIdx.set(players[i].id, i);

  const candScores = new Float32Array(P * NUM_WORLDS);
  for (let c = 0; c < P; c++) {
    const lu = candidates[c];
    const idxs: number[] = [];
    for (const p of lu.players) { const i = playerIdx.get(p.id); if (i !== undefined) idxs.push(i); }
    for (let w = 0; w < NUM_WORLDS; w++) {
      let s = 0;
      for (const i of idxs) s += sim.scores[i * NUM_WORLDS + w];
      candScores[c * NUM_WORLDS + w] = s;
    }
  }

  // Uniform field sample + sorted-per-world.
  let rngS = SEED * 7 + 1;
  const rng = (): number => { rngS = (rngS * 1664525 + 1013904223) >>> 0; return rngS / 0x100000000; };
  const fieldIndices = new Int32Array(FIELD_SIZE);
  for (let f = 0; f < FIELD_SIZE; f++) fieldIndices[f] = Math.floor(rng() * P);
  const fieldSortedPerWorld: Float64Array[] = new Array(NUM_WORLDS);
  for (let w = 0; w < NUM_WORLDS; w++) {
    const fs2 = new Float64Array(FIELD_SIZE);
    for (let f = 0; f < FIELD_SIZE; f++) fs2[f] = candScores[fieldIndices[f] * NUM_WORLDS + w];
    fs2.sort();
    for (let i = 0, j = fs2.length - 1; i < j; i++, j--) { const tmp = fs2[i]; fs2[i] = fs2[j]; fs2[j] = tmp; }
    fieldSortedPerWorld[w] = fs2;
  }
  const payTable = buildPayoutTable(FIELD_SIZE);

  // EV-vs-field.
  const candEV = new Float64Array(P);
  for (let c = 0; c < P; c++) {
    let total = 0;
    for (let w = 0; w < NUM_WORLDS; w++) {
      const score = candScores[c * NUM_WORLDS + w];
      const rank = findRank(score, fieldSortedPerWorld[w]);
      if (rank < payTable.length) total += payTable[rank];
    }
    candEV[c] = total / NUM_WORLDS;
  }

  // GBM combo prior.
  const pairCount = new Map<string, number>();
  for (const lu of candidates) {
    const ids = lu.players.map(p => p.id).sort();
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      pairCount.set(ids[i] + '|' + ids[j], (pairCount.get(ids[i] + '|' + ids[j]) || 0) + 1);
    }
  }
  const comboFeatures = (ids: string[], poolFreq: number): number[] => {
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
    return [Math.log(Math.max(SMALL, poolFreq)), Math.log(Math.max(SMALL, ownProd)), sameTeam ? 1 : 0, Math.log(Math.max(SMALL, projSum)), Math.log(Math.max(SMALL, salSum)), Math.log(Math.max(SMALL, gameTotalSum)), Math.log(Math.max(SMALL, saberTeamSum)), 0, 0, salaryEff, teamCounts.size];
  };
  const chalkScore = new Float32Array(P);
  for (let c = 0; c < P; c++) {
    const ids = candidates[c].players.map(p => p.id).sort();
    let s = 0, n = 0;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const k = ids[i] + '|' + ids[j];
      const poolFreq = (pairCount.get(k) || 0) / P;
      s += predictGBM(gbm2, comboFeatures([ids[i], ids[j]], poolFreq)); n++;
    }
    chalkScore[c] = n > 0 ? s / n : 0;
  }
  const chalkRank = new Float64Array(P);
  {
    const idx = Array.from({ length: P }, (_, i) => i).sort((a, b) => chalkScore[a] - chalkScore[b]);
    for (let r = 0; r < P; r++) chalkRank[idx[r]] = P > 1 ? r / (P - 1) : 0;
  }

  // Atlas score.
  const atlasScore = new Float64Array(P);
  for (let c = 0; c < P; c++) atlasScore[c] = candEV[c] - W_MULTI_BLEND * chalkRank[c];

  const atlasRankIdx = Array.from({ length: P }, (_, i) => i).sort((a, b) => atlasScore[b] - atlasScore[a]);
  return { candScores, candEV, chalkRank, atlasScore, atlasRankIdx };
}

// ===== Atlas-only selector (uses precomputed artifacts) =====

function selectAtlas(candidates: Lineup[], artifacts: AtlasComputed): Lineup[] {
  const greedyPool = new Int32Array(artifacts.atlasRankIdx.slice(0, Math.min(ATLAS_TOP_K_GREEDY, candidates.length)));
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
        const cap = isPitcher(p) ? EXPOSURE_CAP_PITCHER : EXPOSURE_CAP_HITTER;
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
        if (cnt >= 4 && (teamStackCount.get(t) || 0) >= Math.ceil(TEAM_STACK_CAP * N)) { stackOk = false; break; }
      }
      if (!stackOk) continue;
      if (artifacts.atlasScore[c] > bestScore) { bestScore = artifacts.atlasScore[c]; bestIdx = c; }
    }
    if (bestIdx === -1) break;
    selected.push(candidates[bestIdx]);
    selectedSet.add(bestIdx);
    const lu = candidates[bestIdx];
    for (const p of lu.players) exposureCount.set(p.id, (exposureCount.get(p.id) || 0) + 1);
    const tc = new Map<string, number>();
    for (const p of lu.players) {
      if (isPitcher(p)) continue;
      const t = (p.team || '').toUpperCase();
      tc.set(t, (tc.get(t) || 0) + 1);
    }
    for (const [t, cnt] of tc) if (cnt >= 4) teamStackCount.set(t, (teamStackCount.get(t) || 0) + 1);
  }
  return selected;
}

// ===== Combined Atlas → Coverage greedy =====

function selectCombined(candidates: Lineup[], artifacts: AtlasComputed): Lineup[] {
  const P = candidates.length;
  // Stage 1: pre-filter top-K by atlasScore.
  const preFilter = new Int32Array(artifacts.atlasRankIdx.slice(0, Math.min(COMBINED_PRE_FILTER_K, P)));

  // Stage 2: greedy E[max coverage] over candScores.
  const selected: Lineup[] = [];
  const selectedSet = new Set<number>();
  const exposureCount = new Map<string, number>();
  const teamStackCount = new Map<string, number>();
  const maxWorld = new Float64Array(NUM_WORLDS);
  maxWorld.fill(0);

  for (let step = 0; step < N; step++) {
    let bestIdx = -1; let bestGain = -Infinity;
    for (let gi = 0; gi < preFilter.length; gi++) {
      const c = preFilter[gi];
      if (selectedSet.has(c)) continue;
      const lu = candidates[c];
      // Exposure caps
      let okExp = true;
      for (const p of lu.players) {
        const cap = isPitcher(p) ? EXPOSURE_CAP_PITCHER : EXPOSURE_CAP_HITTER;
        const cnt = exposureCount.get(p.id) || 0;
        if (cnt >= Math.ceil(cap * N)) { okExp = false; break; }
      }
      if (!okExp) continue;
      // Team-stack cap
      const teamCounts = new Map<string, number>();
      for (const p of lu.players) {
        if (isPitcher(p)) continue;
        const t = (p.team || '').toUpperCase();
        teamCounts.set(t, (teamCounts.get(t) || 0) + 1);
      }
      let stackOk = true;
      for (const [t, cnt] of teamCounts) {
        if (cnt >= 4 && (teamStackCount.get(t) || 0) >= Math.ceil(TEAM_STACK_CAP * N)) { stackOk = false; break; }
      }
      if (!stackOk) continue;
      // Coverage gain
      const base = c * NUM_WORLDS;
      let gain = 0;
      for (let w = 0; w < NUM_WORLDS; w++) {
        const diff = artifacts.candScores[base + w] - maxWorld[w];
        if (diff > 0) gain += diff;
      }
      if (gain > bestGain) { bestGain = gain; bestIdx = c; }
    }
    if (bestIdx === -1) break;
    selected.push(candidates[bestIdx]);
    selectedSet.add(bestIdx);
    const lu = candidates[bestIdx];
    for (const p of lu.players) exposureCount.set(p.id, (exposureCount.get(p.id) || 0) + 1);
    const tc = new Map<string, number>();
    for (const p of lu.players) {
      if (isPitcher(p)) continue;
      const t = (p.team || '').toUpperCase();
      tc.set(t, (tc.get(t) || 0) + 1);
    }
    for (const [t, cnt] of tc) if (cnt >= 4) teamStackCount.set(t, (teamStackCount.get(t) || 0) + 1);
    const base = bestIdx * NUM_WORLDS;
    for (let w = 0; w < NUM_WORLDS; w++) {
      const s = artifacts.candScores[base + w];
      if (s > maxWorld[w]) maxWorld[w] = s;
    }
  }

  // Fallback: fill remaining slots by atlasScore ranking (ignore caps).
  if (selected.length < N) {
    for (const c of artifacts.atlasRankIdx) {
      if (selected.length >= N) break;
      if (selectedSet.has(c)) continue;
      selected.push(candidates[c]);
      selectedSet.add(c);
    }
  }
  return selected;
}

// ===== Evaluation metrics + scoring =====

interface SlateStats { optimalLineupProj: number; optimalLineupCeiling: number; chalkAnchorOwn: number; slateAvgPlayerOwn: number; ownPercentileByPlayerId: Map<string, number>; }
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
  for (let i = 0; i < sortedByOwn.length; i++) ownPctile.set(sortedByOwn[i].id, sortedByOwn.length > 1 ? i / (sortedByOwn.length - 1) : 0);
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
  console.log('Atlas + Coverage Combined — 29-slate 3-way head-to-head');
  console.log('================================================================');
  console.log(`Stage 1 pre-filter K=${COMBINED_PRE_FILTER_K} by atlasScore (candEV − ${W_MULTI_BLEND}×chalkRank)`);
  console.log(`Stage 2 greedy E[max(portfolio score across worlds)]\n`);

  if (!fs.existsSync(MODEL_PATH)) { console.error(`Missing GBM v3: ${MODEL_PATH}`); process.exit(1); }
  const gbmSaved = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf-8'));
  const gbm2: GBMModel = gbmSaved.models['2'];
  console.log(`Loaded GBM v3 model.\n`);

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
    slate: string; candidates: number;
    atlas: Variant; v2nr: Variant; combined: Variant;
  }
  const rows: SlateRow[] = [];

  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj), actualsPath = path.join(DIR, s.actuals), poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) { console.log(`  ${s.slate}: missing`); continue; }
    const t0 = Date.now();
    try {
      const pr = parseCSVFile(projPath, 'mlb', true);
      const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
      const playerPool = buildPlayerPool(pr.players, pr.detectedContestType);
      const actuals = parseContestActuals(actualsPath, config);
      const idMap = new Map<string, Player>(); const nameMap = new Map<string, Player>();
      for (const p of playerPool.players) { idMap.set(p.id, p); nameMap.set(norm(p.name), p); }

      // Adj Own override.
      const projAux = loadProjAux(projPath);
      for (const p of playerPool.players) {
        const adj = projAux.adjOwn.get(p.id);
        if (adj !== undefined) p.ownership = adj;
      }

      const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
      const candidates: Lineup[] = Array.from(new Map<string, Lineup>(loaded.lineups.map(l => [l.hash, l])).values());
      if (candidates.length < 100) { console.log(`  ${s.slate}: P=${candidates.length} too small`); continue; }

      // Field for evaluation only.
      const fieldLineups: Player[][] = [];
      for (const e of actuals.entries) {
        const pls: Player[] = []; let ok = true;
        for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
        if (ok) fieldLineups.push(pls);
      }
      const stats = computeSlateStats(playerPool.players, fieldLineups);

      // === Compute Atlas artifacts ONCE (sim + candScores + EV + chalk) ===
      const atlasArtifacts = computeAtlasArtifacts(candidates, playerPool.players, idMap, projAux, gbm2);

      // === Atlas-alone ===
      const atlasPort = selectAtlas(candidates, atlasArtifacts);
      const atlasMetrics = computeUniversal(atlasPort.map(lu => lu.players), stats);
      const atlasMahal = mahalanobis(atlasMetrics, s.slate);
      const atlasT = scoreTournament(atlasPort, actuals);

      // === v2-no-reg (uses its own v1-sim-stats with 3000 worlds) ===
      const simStats = computeLineupSimStats(candidates, playerPool.players);
      const v2 = selectPortfolioCoverageV2Portfolio(candidates, playerPool.players, N, THEORY_V1_NOCORR_PARAMS, simStats, { fallbackToV1: true });
      const v2Metrics = computeUniversal(v2.selected.map(lu => lu.players), stats);
      const v2Mahal = mahalanobis(v2Metrics, s.slate);
      const v2T = scoreTournament(v2.selected, actuals);

      // === Combined (reuses Atlas's sim) ===
      const combPort = selectCombined(candidates, atlasArtifacts);
      const combMetrics = computeUniversal(combPort.map(lu => lu.players), stats);
      const combMahal = mahalanobis(combMetrics, s.slate);
      const combT = scoreTournament(combPort, actuals);

      rows.push({
        slate: s.slate, candidates: candidates.length,
        atlas:    { size: atlasPort.length,  roi: atlasT.roi, mahal: atlasMahal, top1: atlasT.top1, top01: atlasT.top01, cost: atlasT.cost, payout: atlasT.payout, metrics: atlasMetrics },
        v2nr:     { size: v2.selected.length, roi: v2T.roi,    mahal: v2Mahal,    top1: v2T.top1,    top01: v2T.top01,    cost: v2T.cost,    payout: v2T.payout,    metrics: v2Metrics },
        combined: { size: combPort.length,   roi: combT.roi,  mahal: combMahal,  top1: combT.top1,  top01: combT.top01,  cost: combT.cost,  payout: combT.payout,  metrics: combMetrics },
      });

      const ts = (Date.now() - t0) / 1000;
      console.log(
        `  ${s.slate.padEnd(15)} P=${candidates.length} | ` +
        `atlas: ROI=${atlasT.roi.toFixed(0).padStart(5)}% mahal=${atlasMahal?.toFixed(2) || ' n/a'} top1=${atlasT.top1} | ` +
        `v2nr: ROI=${v2T.roi.toFixed(0).padStart(5)}% mahal=${v2Mahal?.toFixed(2) || ' n/a'} top1=${v2T.top1} | ` +
        `comb: ROI=${combT.roi.toFixed(0).padStart(5)}% mahal=${combMahal?.toFixed(2) || ' n/a'} top1=${combT.top1} | ${ts.toFixed(1)}s`,
      );
    } catch (e: any) {
      console.log(`  ${s.slate}: error — ${e?.message || e}`);
    }
  }

  console.log('\n================================================================');
  console.log('AGGREGATE — leakage-free 29-slate');
  console.log('================================================================\n');

  function agg(pick: 'atlas' | 'v2nr' | 'combined') {
    const cost = rows.reduce((s, r) => s + r[pick].cost, 0);
    const pay = rows.reduce((s, r) => s + r[pick].payout, 0);
    const roi = cost > 0 ? (pay / cost - 1) * 100 : 0;
    const prof = rows.filter(r => r[pick].roi > 0).length;
    const top1 = rows.reduce((s, r) => s + r[pick].top1, 0);
    const top01 = rows.reduce((s, r) => s + r[pick].top01, 0);
    const dists = rows.map(r => r[pick].mahal).filter((d): d is number => d !== null);
    return { cost, pay, roi, prof, top1, top01, meanD: mean(dists), distsN: dists.length, dLt15: dists.filter(d => d < 1.5).length, dLt20: dists.filter(d => d < 2.0).length };
  }
  function loo(pick: 'atlas' | 'v2nr' | 'combined') {
    const tot = agg(pick);
    let worst = Infinity, worstSlate = '';
    const out: number[] = [];
    for (const r of rows) {
      const c2 = tot.cost - r[pick].cost;
      const p2 = tot.pay - r[pick].payout;
      const roi2 = c2 > 0 ? (p2 / c2 - 1) * 100 : 0;
      out.push(roi2);
      if (roi2 < worst) { worst = roi2; worstSlate = r.slate; }
    }
    return { mean: mean(out), std: stddev(out), worst, worstSlate };
  }
  const aAgg = agg('atlas'), vAgg = agg('v2nr'), cAgg = agg('combined');
  const aLoo = loo('atlas'), vLoo = loo('v2nr'), cLoo = loo('combined');

  console.log('Metric                     Atlas              v2-no-reg          Combined (K=1000)');
  console.log('-----------------------------------------------------------------------------------');
  console.log(`Slates                     ${rows.length}                  ${rows.length}                  ${rows.length}`);
  console.log(`Total payout               $${aAgg.pay.toFixed(0).padStart(8)}          $${vAgg.pay.toFixed(0).padStart(8)}          $${cAgg.pay.toFixed(0).padStart(8)}`);
  console.log(`Full-sample ROI            ${aAgg.roi.toFixed(2).padStart(8)}%         ${vAgg.roi.toFixed(2).padStart(8)}%         ${cAgg.roi.toFixed(2).padStart(8)}%`);
  console.log(`Profitable                 ${aAgg.prof}/${rows.length}                ${vAgg.prof}/${rows.length}                ${cAgg.prof}/${rows.length}`);
  console.log(`Top-1% hits                ${aAgg.top1.toString().padStart(8)}          ${vAgg.top1.toString().padStart(8)}          ${cAgg.top1.toString().padStart(8)}`);
  console.log(`Top-0.1% hits              ${aAgg.top01.toString().padStart(8)}          ${vAgg.top01.toString().padStart(8)}          ${cAgg.top01.toString().padStart(8)}`);
  console.log(`LOO mean ROI               ${aLoo.mean.toFixed(2).padStart(8)}%         ${vLoo.mean.toFixed(2).padStart(8)}%         ${cLoo.mean.toFixed(2).padStart(8)}%`);
  console.log(`LOO std                    ${aLoo.std.toFixed(2).padStart(8)}%         ${vLoo.std.toFixed(2).padStart(8)}%         ${cLoo.std.toFixed(2).padStart(8)}%`);
  console.log(`LOO worst-drop             ${aLoo.worst.toFixed(2).padStart(8)}%         ${vLoo.worst.toFixed(2).padStart(8)}%         ${cLoo.worst.toFixed(2).padStart(8)}%`);
  console.log(`LOO worst slate            ${aLoo.worstSlate.padEnd(14)}     ${vLoo.worstSlate.padEnd(14)}     ${cLoo.worstSlate}`);
  console.log(`Mean Mahalanobis           ${aAgg.meanD.toFixed(3).padStart(8)}          ${vAgg.meanD.toFixed(3).padStart(8)}          ${cAgg.meanD.toFixed(3).padStart(8)}   (<1.5)`);
  console.log(`Slates d<1.5               ${aAgg.dLt15}/${aAgg.distsN}               ${vAgg.dLt15}/${vAgg.distsN}               ${cAgg.dLt15}/${cAgg.distsN}`);
  console.log(`Slates d<2.0               ${aAgg.dLt20}/${aAgg.distsN}              ${vAgg.dLt20}/${vAgg.distsN}              ${cAgg.dLt20}/${cAgg.distsN}`);

  console.log('\n--- 5-principle structural fidelity ---');
  console.log('Metric                       pro target     Atlas               v2-no-reg           Combined');
  for (const k of UNIVERSAL_METRICS) {
    const aVals = rows.map(r => (r.atlas.metrics as any)[k]);
    const vVals = rows.map(r => (r.v2nr.metrics as any)[k]);
    const cVals = rows.map(r => (r.combined.metrics as any)[k]);
    const aM = mean(aVals), aS = stddev(aVals), aCV = aM !== 0 ? Math.abs(aS / aM) : 0;
    const vM = mean(vVals), vS = stddev(vVals), vCV = vM !== 0 ? Math.abs(vS / vM) : 0;
    const cM = mean(cVals), cS = stddev(cVals), cCV = cM !== 0 ? Math.abs(cS / cM) : 0;
    const tgt = ({ projRatioToOptimal: 0.88, ceilingRatioToOptimal: 0.92, avgPlayerOwnPctile: 0.94, ownStdRatio: 7.1, ownDeltaFromAnchor: -7.2 } as any)[k];
    console.log(`  ${k.padEnd(28)} ${tgt.toString().padStart(8)}  | ${aM.toFixed(3).padStart(8)} (CV ${aCV.toFixed(3)})  | ${vM.toFixed(3).padStart(8)} (CV ${vCV.toFixed(3)})  | ${cM.toFixed(3).padStart(8)} (CV ${cCV.toFixed(3)})`);
  }

  fs.writeFileSync(OUT_JSON, JSON.stringify({ runDate: new Date().toISOString(), nSlates: rows.length, rows, atlas: { agg: aAgg, loo: aLoo }, v2nr: { agg: vAgg, loo: vLoo }, combined: { agg: cAgg, loo: cLoo } }, null, 2));
  console.log(`\nResults saved to ${OUT_JSON}`);

  console.log('\n================================================================');
  console.log('GATE DECISIONS');
  console.log('================================================================');
  for (const [label, a, l] of [['Atlas', aAgg, aLoo] as const, ['v2-no-reg', vAgg, vLoo] as const, ['Combined', cAgg, cLoo] as const]) {
    const g1 = a.roi >= 50, g2 = a.meanD < 1.5, g3 = l.mean > 0;
    console.log(`${label.padEnd(12)} ROI=${a.roi.toFixed(1).padStart(7)}% ${g1 ? 'PASS' : 'FAIL'}  |  mahal=${a.meanD.toFixed(3)} ${g2 ? 'PASS' : 'FAIL'}  |  LOO=${l.mean.toFixed(1)}% ${g3 ? 'PASS' : 'FAIL'}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
