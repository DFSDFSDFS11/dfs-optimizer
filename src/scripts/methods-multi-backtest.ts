/**
 * Methods-Multi backtest — 29-slate LOO across 6 variants that ADD structure (no individual-lineup filters).
 *
 * Operating principle from failed attempts: ADD portfolio-level structure WITHOUT restricting
 * individual-lineup selection. Bring-back floor was the only winning intervention because it
 * adds a portfolio constraint, not an individual-lineup filter.
 *
 * Variants tested (all share Atlas's EV + chalk-penalty greedy pipeline):
 *   1. Atlas baseline
 *   2. Stacks-BB17  (validated winner: bring-back ≥1 at 17%, ≥2 at 8%)
 *   3. Stacks-BB25  (HIGHER bring-back: ≥1 at 25%, ≥2 at 12%, ≥3 at 5%)
 *   4. Stacks-BBM3  (multi-layer: ≥1 at 17%, ≥2 at 8%, ≥3 at 4%)
 *   5. Stacks-GAME  (BB + game-stack-from-top-game floor: 25% of lineups contain 4+ from highest-game-total game)
 *   6. Stacks-DEV   (BB + dev_sum_under positive bias: greedy score += $W per under-owned player)
 *   7. Stacks-MAX   (BB + game-stack floor + dev_sum_under bias — all ADDITIVE)
 *
 * Per Theory of DFS Ch.8: optimize at LINEUP/PORTFOLIO level, not individual-lineup metric filtering.
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
const OUT_JSON = path.join(DIR, 'methods_multi_results.json');
const PRO_CONSENSUS_PATH = path.join(DIR, 'pro_consensus_slate_relative.json');
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
  gbm2: GBMModel;
  candEV: Float64Array;
  chalkRank: Float64Array;
  greedyPool: Int32Array;
  anchorIds: Set<string>;
  candBringback: Int8Array;
  candPrimaryTeam: string[];
  candTopGameStack: Int8Array;
  candDevSumUnder: Float32Array;
  topGameTeams: Set<string>;
  candDevNOver: Float32Array;
  candHProjMean: Float32Array;
  candSaberGameMean: Float32Array;
  candCeilOverOwn: Float32Array;
  candDevSum: Float32Array;
}

function computeShared(input: { candidates: Lineup[]; players: Player[]; idMap: Map<string, Player>; projAux: ReturnType<typeof loadProjAux>; gbm2: GBMModel }): SharedInput {
  const { candidates, players, idMap, projAux, gbm2 } = input;
  const P = candidates.length;
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

  // Anchor IDs
  const playerInPool = new Set<string>();
  for (const lu of candidates) for (const p of lu.players) playerInPool.add(p.id);
  const hitterCandidates = players.filter(p => !isPitcher(p) && playerInPool.has(p.id))
    .sort((a, b) => (b.projection || 0) - (a.projection || 0));
  const pitcherCandidates = players.filter(p => isPitcher(p) && playerInPool.has(p.id))
    .sort((a, b) => (b.projection || 0) - (a.projection || 0));
  const anchorIds = new Set<string>();
  for (const p of hitterCandidates.slice(0, STACKS_N_HIT_ANCHORS)) anchorIds.add(p.id);
  for (const p of pitcherCandidates.slice(0, STACKS_N_PIT_ANCHORS)) anchorIds.add(p.id);

  // Per-candidate primary team + bring-back count
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

  // Top game total identification: find the game with highest saber_game_total
  // Build team→saber_game_total map (each team has the same game total as its opp)
  const teamGameTotal = new Map<string, number>();
  for (const p of players) {
    const t = (p.team || '').toUpperCase(); if (!t) continue;
    const sgt = projAux.saberTotal.get(p.id) || 0;
    if (sgt > 0 && !teamGameTotal.has(t)) teamGameTotal.set(t, sgt);
  }
  // Identify the top-1 game (group teams by their opp, take the pair with highest total)
  const seenGames = new Set<string>();
  const games: { teams: [string, string]; total: number }[] = [];
  for (const p of players) {
    const t = (p.team || '').toUpperCase();
    const o = (p.opponent || '').toUpperCase();
    if (!t || !o) continue;
    const key = [t, o].sort().join('|');
    if (seenGames.has(key)) continue;
    seenGames.add(key);
    const total = teamGameTotal.get(t) || teamGameTotal.get(o) || 0;
    games.push({ teams: [t, o], total });
  }
  games.sort((a, b) => b.total - a.total);
  const topGameTeams = new Set<string>();
  if (games.length > 0) { topGameTeams.add(games[0].teams[0]); topGameTeams.add(games[0].teams[1]); }

  // Per-candidate: count of hitters from top-game teams
  const candTopGameStack = new Int8Array(P);
  for (let c = 0; c < P; c++) {
    const lu = candidates[c];
    let n = 0;
    for (const p of lu.players) {
      if (isPitcher(p)) continue;
      if (topGameTeams.has((p.team || '').toUpperCase())) n++;
    }
    candTopGameStack[c] = Math.min(n, 8);
  }

  // Per-candidate dev_sum_under: compute Adj-Own-implied own deviation, sum negatives
  // Implied own from projection rank (per position)
  // Simplified: implied_own ∝ proj^1.5, scaled per position
  const positions = ['P', 'C', '1B', '2B', '3B', 'SS', 'OF'];
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
  const candDevSumUnder = new Float32Array(P);
  // === PRO-IC factors: dev_n_over (+0.114), h_proj_mean (+0.098), saber_game_mean (+0.085), ceil_x_own_inverse (-0.065) ===
  const candDevNOver = new Float32Array(P);
  const candHProjMean = new Float32Array(P);
  const candSaberGameMean = new Float32Array(P);
  const candCeilOverOwn = new Float32Array(P);
  const candDevSum = new Float32Array(P);
  for (let c = 0; c < P; c++) {
    const lu = candidates[c];
    let sumUnder = 0, sumDev = 0, nOver = 0;
    let hProjSum = 0, hCount = 0;
    let gameSum = 0;
    let ceilSum = 0, ownSum = 0;
    for (const p of lu.players) {
      const adj = projAux.adjOwn.get(p.id);
      const own = (adj !== undefined) ? adj : (p.ownership || 0);
      const imp = impliedOwn.get(p.id) || own;
      const dev = own - imp;
      sumDev += dev;
      if (dev < 0) sumUnder += dev;
      if (dev > 5) nOver++;  // over-owned > 5pp threshold (matches pro-IC factor definition)
      if (!isPitcher(p)) {
        hProjSum += p.projection || 0;
        hCount++;
      }
      const sgt = projAux.saberTotal.get(p.id) || 0;
      gameSum += sgt;
      ceilSum += (p.projection || 0) * 1.5;  // proxy for ceil_85 since pool doesn't carry it
      ownSum += own;
    }
    candDevSumUnder[c] = sumUnder;
    candDevSum[c] = sumDev;
    candDevNOver[c] = nOver;
    candHProjMean[c] = hCount > 0 ? hProjSum / hCount : 0;
    candSaberGameMean[c] = gameSum / lu.players.length;
    candCeilOverOwn[c] = ceilSum / Math.max(0.001, ownSum);
  }

  return {
    candidates, players, idMap, projAux, gbm2,
    candEV, chalkRank, greedyPool, anchorIds,
    candBringback, candPrimaryTeam,
    candTopGameStack, candDevSumUnder, topGameTeams,
    candDevNOver, candHProjMean, candSaberGameMean, candCeilOverOwn, candDevSum,
  };
}

interface VariantConfig {
  name: string;
  bb1Target: number;
  bb2Target: number;
  bb3Target: number;
  gameStackFloor: number;
  gameStackMinHitters: number;
  devSumUnderBias: number;
  // Pro-IC weights (from pro_ic_analysis.py on 15,660 pro lineups)
  wDevNOver: number;       // pro IC +0.114 (#1 signal)
  wHProjMean: number;      // pro IC +0.098
  wSaberGameMean: number;  // pro IC +0.085
  wCeilOverOwn: number;    // pro IC -0.065 (NEGATIVE — penalize high ratio)
  wDevSum: number;         // pro IC +0.092
}

function selectVariant(shared: SharedInput, config: VariantConfig): Lineup[] {
  const { candidates, candEV, chalkRank, greedyPool, anchorIds, candBringback, candPrimaryTeam, candTopGameStack, candDevSumUnder } = shared;
  const selected: Lineup[] = [];
  const selectedSet = new Set<number>();
  const exposureCount = new Map<string, number>();
  const teamStackCount = new Map<string, number>();
  let bb1Selected = 0, bb2Selected = 0, bb3Selected = 0, gameStackSelected = 0;

  for (let step = 0; step < N; step++) {
    const requiredBB1 = Math.ceil(config.bb1Target * (step + 1));
    const requiredBB2 = Math.ceil(config.bb2Target * (step + 1));
    const requiredBB3 = Math.ceil(config.bb3Target * (step + 1));
    const requiredGameStack = Math.ceil(config.gameStackFloor * (step + 1));
    const needBB1 = bb1Selected < requiredBB1;
    const needBB2 = bb2Selected < requiredBB2;
    const needBB3 = bb3Selected < requiredBB3;
    const needGameStack = gameStackSelected < requiredGameStack;

    let bestIdx = -1; let bestScore = -Infinity;
    for (let gi = 0; gi < greedyPool.length; gi++) {
      const c = greedyPool[gi];
      if (selectedSet.has(c)) continue;
      // Apply floors in priority order: BB3 > BB2 > BB1 > GameStack
      if (needBB3 && candBringback[c] < 3) continue;
      else if (needBB2 && !needBB3 && candBringback[c] < 2) continue;
      else if (needBB1 && !needBB2 && !needBB3 && candBringback[c] < 1) continue;
      else if (needGameStack && !needBB1 && !needBB2 && !needBB3 && candTopGameStack[c] < config.gameStackMinHitters) continue;

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
      // dev_sum_under is negative; multiply by -devSumUnderBias to make it a positive bonus
      const devBonus = -config.devSumUnderBias * candDevSumUnder[c];
      const proIcBonus = config.wDevNOver * shared.candDevNOver[c]
                       + config.wHProjMean * shared.candHProjMean[c]
                       + config.wSaberGameMean * shared.candSaberGameMean[c]
                       + config.wCeilOverOwn * shared.candCeilOverOwn[c]
                       + config.wDevSum * shared.candDevSum[c];
      const score = candEV[c] - ATLAS_W_MULTI_BLEND * chalkRank[c] + STACKS_ANCHOR_BOOST * nAnchors + devBonus + proIcBonus;
      if (score > bestScore) { bestScore = score; bestIdx = c; }
    }
    if (bestIdx === -1) {
      // Fallback retry without floors
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
        const devBonus = -config.devSumUnderBias * candDevSumUnder[c];
        const proIcBonus = config.wDevNOver * shared.candDevNOver[c]
                       + config.wHProjMean * shared.candHProjMean[c]
                       + config.wSaberGameMean * shared.candSaberGameMean[c]
                       + config.wCeilOverOwn * shared.candCeilOverOwn[c]
                       + config.wDevSum * shared.candDevSum[c];
      const score = candEV[c] - ATLAS_W_MULTI_BLEND * chalkRank[c] + STACKS_ANCHOR_BOOST * nAnchors + devBonus + proIcBonus;
        if (score > bestScore) { bestScore = score; bestIdx = c; }
      }
      if (bestIdx === -1) break;
    }
    selected.push(candidates[bestIdx]);
    selectedSet.add(bestIdx);
    if (candBringback[bestIdx] >= 1) bb1Selected++;
    if (candBringback[bestIdx] >= 2) bb2Selected++;
    if (candBringback[bestIdx] >= 3) bb3Selected++;
    if (candTopGameStack[bestIdx] >= config.gameStackMinHitters) gameStackSelected++;
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

// === Evaluation ===

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
  console.log('============================================================');
  console.log('Methods-Multi backtest — 7 variants on 29 slates');
  console.log('============================================================\n');

  const gbmSaved = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf-8'));
  const gbm2: GBMModel = gbmSaved.models['2'];

  // Phase 4 ensemble V1: 4 cluster reps from pipeline_selected_factors.json (pipeline ran 2026-05-17):
  //   Cluster 1: pos_proj_zscore_sum  (late IC +0.149) — projection-vs-position-mean
  //   Cluster 2: proj_min             (late IC +0.124) — avoid punts
  //   Cluster 3: own_bot3_sum         (late IC +0.144) — chalk concentration in bottom-3
  //   Cluster 4: proj_vs_slate_p50    (late IC +0.129) — relative projection
  // We use existing wDevNOver/wHProjMean/wSaberGameMean/wCeilOverOwn/wDevSum slots but reassign meaning:
  //   wDevNOver       -> cluster3 own_bot3_sum proxy via dev_n_over correlation
  //   wHProjMean      -> cluster4 proj_vs_slate_p50 proxy (h_proj_mean is in same cluster)
  //   wSaberGameMean  -> cluster1 saber-game (correlated with high-projection)
  //   wCeilOverOwn    -> repurposed as negative cluster (already tested neg-IC)
  //   wDevSum         -> cluster3 chalk-deviation (positive IC alignment)
  // For PROPER Phase 4, test BB25 + IC-weighted ensemble at multiple scales.

  const bb25Base = { bb1Target: 0.25, bb2Target: 0.12, bb3Target: 0.05, gameStackFloor: 0, gameStackMinHitters: 4, devSumUnderBias: 0 };
  const proIcZero = { wDevNOver: 0, wHProjMean: 0, wSaberGameMean: 0, wCeilOverOwn: 0, wDevSum: 0 };

  // Equal-weight scaling at multiple magnitudes
  const ENS_W = 5.0;  // baseline ensemble weight (per cluster representative)

  const VARIANTS: VariantConfig[] = [
    { name: 'Atlas',        bb1Target: 0, bb2Target: 0, bb3Target: 0, gameStackFloor: 0, gameStackMinHitters: 4, devSumUnderBias: 0, ...proIcZero },
    { name: 'BB25',         ...bb25Base, ...proIcZero },
    // Single-cluster bias on BB25 baseline (Phase 4 step 1)
    { name: 'BB25+C1',      ...bb25Base, ...proIcZero, wHProjMean: 0.149 * ENS_W },              // cluster 1 proxy (h_proj_mean as cluster member)
    { name: 'BB25+C2',      ...bb25Base, ...proIcZero, wSaberGameMean: 0.085 * ENS_W },          // cluster 2 saber-game proxy
    { name: 'BB25+C3',      ...bb25Base, ...proIcZero, wDevNOver: 0.114 * ENS_W },               // cluster 3 chalk proxy
    { name: 'BB25+C4',      ...bb25Base, ...proIcZero, wDevSum: 0.092 * ENS_W },                 // cluster 4 deviation
    // Phase 4 equal-weight 4-cluster ensemble
    { name: 'BB25+ENS_EQ',  ...bb25Base,
      wHProjMean: 0.149 * ENS_W,
      wSaberGameMean: 0.085 * ENS_W,
      wDevNOver: 0.114 * ENS_W,
      wCeilOverOwn: 0,
      wDevSum: 0.092 * ENS_W,
    },
    // Phase 4 IC-weighted ensemble at small scale
    { name: 'BB25+ENS_S',   ...bb25Base,
      wHProjMean: 0.149 * 2,
      wSaberGameMean: 0.085 * 2,
      wDevNOver: 0.114 * 2,
      wCeilOverOwn: 0,
      wDevSum: 0.092 * 2,
    },
    // Phase 4 IC-weighted ensemble at large scale
    { name: 'BB25+ENS_L',   ...bb25Base,
      wHProjMean: 0.149 * 10,
      wSaberGameMean: 0.085 * 10,
      wDevNOver: 0.114 * 10,
      wCeilOverOwn: 0,
      wDevSum: 0.092 * 10,
    },
  ];

  const allRows: any[] = [];
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
      const projAux = loadProjAux(projPath);
      for (const p of playerPool.players) {
        const adj = projAux.adjOwn.get(p.id);
        if (adj !== undefined) p.ownership = adj;
      }
      const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
      const candidates: Lineup[] = Array.from(new Map<string, Lineup>(loaded.lineups.map(l => [l.hash, l])).values());
      if (candidates.length < 100) { console.log(`  ${s.slate}: P=${candidates.length} too small`); continue; }
      const fieldLineups: Player[][] = [];
      for (const e of actuals.entries) {
        const pls: Player[] = []; let ok = true;
        for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
        if (ok) fieldLineups.push(pls);
      }
      const stats = computeSlateStats(playerPool.players, fieldLineups);

      // Compute shared structures ONCE
      const shared = computeShared({ candidates, players: playerPool.players, idMap, projAux, gbm2 });

      const variantResults: Record<string, any> = {};
      for (const v of VARIANTS) {
        const portfolio = selectVariant(shared, v);
        const m = computeUniversal(portfolio.map(lu => lu.players), stats);
        const tour = scoreTournament(portfolio, actuals);
        variantResults[v.name] = { size: portfolio.length, roi: tour.roi, top1: tour.top1, top01: tour.top01, cost: tour.cost, payout: tour.payout, metrics: m };
      }
      allRows.push({ slate: s.slate, candidates: candidates.length, variants: variantResults });
      const ts = (Date.now() - t0) / 1000;
      const summary = VARIANTS.map(v => `${v.name}:${variantResults[v.name].roi.toFixed(0).padStart(5)}%/t1=${variantResults[v.name].top1}`).join(' | ');
      console.log(`  ${s.slate.padEnd(15)} P=${candidates.length} | ${summary} | ${ts.toFixed(1)}s`);
    } catch (e: any) {
      console.log(`  ${s.slate}: error — ${e?.message || e}`);
    }
  }

  // Aggregate
  console.log('\n============================================================');
  console.log('AGGREGATE — 29-slate full-sample');
  console.log('============================================================\n');
  console.log(`${'Variant'.padEnd(8)} ${'ROI%'.padStart(8)} ${'Profitable'.padStart(11)} ${'top1'.padStart(6)} ${'top01'.padStart(6)} ${'cost'.padStart(8)} ${'payout'.padStart(10)}`);
  for (const v of VARIANTS) {
    const cost = allRows.reduce((s, r) => s + (r.variants[v.name]?.cost || 0), 0);
    const pay = allRows.reduce((s, r) => s + (r.variants[v.name]?.payout || 0), 0);
    const roi = cost > 0 ? (pay / cost - 1) * 100 : 0;
    const prof = allRows.filter(r => (r.variants[v.name]?.roi || 0) > 0).length;
    const top1 = allRows.reduce((s, r) => s + (r.variants[v.name]?.top1 || 0), 0);
    const top01 = allRows.reduce((s, r) => s + (r.variants[v.name]?.top01 || 0), 0);
    console.log(`${v.name.padEnd(8)} ${roi.toFixed(2).padStart(7)}% ${prof.toString().padStart(7)}/${allRows.length}  ${top1.toString().padStart(6)} ${top01.toString().padStart(6)} $${cost.toLocaleString().padStart(7)} $${pay.toFixed(0).padStart(9)}`);
  }

  fs.writeFileSync(OUT_JSON, JSON.stringify({ runDate: new Date().toISOString(), nSlates: allRows.length, rows: allRows, variants: VARIANTS }, null, 2));
  console.log(`\nResults saved to ${OUT_JSON}`);
}

main().catch(e => { console.error(e); process.exit(1); });
