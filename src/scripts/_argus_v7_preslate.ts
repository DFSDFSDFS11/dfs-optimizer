/**
 * Argus-v7 preslate: applies the saved v3-residual GBM model as the field
 * model for today's slate, then runs Argus selection.
 *
 * Loads argus_gbm_v3_model.json (trained on all 27 dev/holdout slates) and
 * uses it to predict combo frequencies for the live slate, replacing the
 * pool-count field model. Result is plugged into Argus's median-rescaled
 * multi-combo penalty.
 *
 * Env vars:
 *   ARGUS_PROJ_FILE     — projections (default mlbdkprojpre.csv)
 *   ARGUS_POOL_FILES    — pool CSVs (default sspool1pre.csv,sspool2pre.csv)
 *   ARGUS_TARGET_COUNT  — N lineups (default 150)
 *   ARGUS_W_MULTI       — combo penalty weight (default 0.40 for v7 test)
 *   ARGUS_HITTER_CAP    — hitter exposure cap (default 0.25)
 *   ARGUS_PITCHER_CAP   — pitcher exposure cap (default 0.45)
 *   ARGUS_TEAM_CAP      — team-stack cap (default 0.20)
 *   ARGUS_OUTPUT_TAG    — output filename suffix
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as csvParse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';
import { exportForDraftKings, exportDetailedLineups } from '../scoring';

const DIR = 'C:/Users/colin/dfs opto';
const MODEL_PATH = path.join(DIR, 'multi_combo_penalty_implementation', 'argus_gbm_v3_model.json');
const SMALL = 1e-9;

const PROJ_FILE = process.env.ARGUS_PROJ_FILE || 'mlbdkprojpre.csv';
const POOL_FILES = (process.env.ARGUS_POOL_FILES || 'sspool1pre.csv,sspool2pre.csv').split(',').map(s => s.trim()).filter(Boolean);
const N = process.env.ARGUS_TARGET_COUNT ? parseInt(process.env.ARGUS_TARGET_COUNT, 10) : 150;
const OUTPUT_TAG = process.env.ARGUS_OUTPUT_TAG || 'v7';

const ARGUS = {
  STACK_BONUS_PER_HITTER: 0, BRINGBACK_1: 0, BRINGBACK_2: 0,
  PITCHER_VS_HITTER_PENALTY: -0.10, MIN_PRIMARY_STACK: 4,
  W_PROJ: 1.0,
  W_LEV: process.env.ARGUS_W_LEV ? parseFloat(process.env.ARGUS_W_LEV) : 0.30,
  // Direct ownership-product penalty: subtract W_OWN_PROD × (logOwnAll - mean_logOwnAll).
  // logOwnAll is sum of log(player ownerships) across all 10 players.
  // Higher chalk → larger logOwnAll → bigger subtraction. Default off (0); 0.05–0.20 is reasonable.
  W_OWN_PROD: process.env.ARGUS_W_OWN_PROD ? parseFloat(process.env.ARGUS_W_OWN_PROD) : 0.0,
  // Leverage × Ceiling interaction: bonus when LOW ownership AND HIGH ceiling.
  // Term = W_LEV_CEIL × (1 − ownPct) × ceilingPct. Both rank-based [0,1].
  // Default 0; 0.20–0.40 emphasizes "low-own / high-ceiling" plays.
  W_LEV_CEIL: process.env.ARGUS_W_LEV_CEIL ? parseFloat(process.env.ARGUS_W_LEV_CEIL) : 0.0,
  W_VAR: 0.15, W_CMB: 0.25,
  W_MULTI: process.env.ARGUS_W_MULTI ? parseFloat(process.env.ARGUS_W_MULTI) : 0.40,
  EXPOSURE_CAP_HITTER: process.env.ARGUS_HITTER_CAP ? parseFloat(process.env.ARGUS_HITTER_CAP) : 0.25,
  EXPOSURE_CAP_PITCHER: process.env.ARGUS_PITCHER_CAP ? parseFloat(process.env.ARGUS_PITCHER_CAP) : 0.45,
  TEAM_STACK_CAP: process.env.ARGUS_TEAM_CAP ? parseFloat(process.env.ARGUS_TEAM_CAP) : 0.20,
  BAND_HIGH_PCT: 0.20, BAND_LOW_PCT: 0.20, MAX_PAIRWISE_OVERLAP: 6,
  TRIPLE_FREQ_CAP: 5,
  PPD_LINEUP_PENALTY: 0.10, PPD_LINEUP_TOP_PCT: 0.10,
  TOP_K: 5, LOG_EPSILON: 1e-12,
};

function isPitcher(p: Player): boolean { return (p.position || '').toUpperCase().includes('P'); }
function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function mean(a: number[]): number { if (!a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; }
function rankPercentile(values: number[]): number[] {
  const idx = values.map((v, i) => ({ v, i }));
  idx.sort((a, b) => a.v - b.v);
  const out = new Array<number>(values.length);
  for (let r = 0; r < values.length; r++) out[idx[r].i] = values.length > 1 ? r / (values.length - 1) : 0;
  return out;
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
function withinSlatePercentile(values: Map<string, number>): Map<string, number> {
  const arr: { id: string; v: number }[] = [];
  for (const [id, v] of values) arr.push({ id, v });
  arr.sort((a, b) => a.v - b.v);
  const out = new Map<string, number>();
  for (let i = 0; i < arr.length; i++) out.set(arr[i].id, arr.length > 1 ? i / (arr.length - 1) : 0);
  return out;
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

async function main() {
  console.log('================================================================');
  console.log('ARGUS-v7 PRE-SLATE  (v3-residual GBM field model, W_MULTI=' + ARGUS.W_MULTI + ')');
  console.log('================================================================');
  console.log('Pool model REPLACED by v3-residual GBM (89% chalk-prediction wins).');
  console.log(`Caps: hitter=${ARGUS.EXPOSURE_CAP_HITTER} pitcher=${ARGUS.EXPOSURE_CAP_PITCHER} team=${ARGUS.TEAM_STACK_CAP}\n`);

  // Load saved GBM v3 model.
  if (!fs.existsSync(MODEL_PATH)) { console.error('Missing model: ' + MODEL_PATH); process.exit(1); }
  const modelData = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf-8'));
  const gbmModels: Record<number, GBMModel> = modelData.models;
  console.log('Loaded GBM v3 model. Sizes: ' + Object.keys(gbmModels).join(','));

  // Load slate.
  const projPath = path.join(DIR, PROJ_FILE);
  const pr = parseCSVFile(projPath, 'mlb', true);
  const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
  const pool = buildPlayerPool(pr.players, pr.detectedContestType);
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

  const merged = new Map<string, Lineup>();
  let total = 0;
  for (const pf of POOL_FILES) {
    const pp = path.join(DIR, pf);
    if (!fs.existsSync(pp)) { console.log('Skip ' + pf + ': not found'); continue; }
    const loaded = loadPoolFromCSV({ filePath: pp, config, playerMap: idMap });
    total += loaded.lineups.length;
    for (const lu of loaded.lineups) if (!merged.has(lu.hash)) merged.set(lu.hash, lu);
    console.log(`  ${pf}: ${loaded.lineups.length} lineups (${loaded.unresolvedRows} unresolved)`);
  }
  let candidates = Array.from(merged.values());
  console.log(`Merged: ${candidates.length} unique lineups (from ${total})`);

  // Pareto-layer assignment: layer 1 = frontier, layer 2 = frontier after
  // removing layer 1, etc. Uses soft tolerance: A dominates B iff
  // A.proj >= B.proj + EPS_PROJ AND A.own <= B.own - EPS_OWN.
  // Defaults: EPS_PROJ=1.0, EPS_OWN=0.5. Set both to 0 for strict.
  // Layer info is later used as a small EV bonus (closer to frontier = better).
  const paretoLayerByHash = new Map<string, number>();
  if (process.env.ARGUS_PARETO === '1' || process.env.ARGUS_PARETO === 'true') {
    const epsProj = process.env.ARGUS_PARETO_EPS_PROJ ? parseFloat(process.env.ARGUS_PARETO_EPS_PROJ) : 1.0;
    const epsOwn = process.env.ARGUS_PARETO_EPS_OWN ? parseFloat(process.env.ARGUS_PARETO_EPS_OWN) : 0.5;
    const maxLayer = process.env.ARGUS_PARETO_MAX_LAYER ? parseInt(process.env.ARGUS_PARETO_MAX_LAYER, 10) : 5;

    const before = candidates.length;
    let remaining = [...candidates];
    let layer = 1;
    const layerCounts: number[] = [];
    while (remaining.length > 0 && layer <= 50) {
      // Find all lineups in `remaining` not dominated by any other in `remaining` (soft).
      const sorted = [...remaining].sort((a, b) => b.projection - a.projection);
      const layerLineups: Lineup[] = [];
      const stillRemaining: Lineup[] = [];
      // For each candidate c: dominated iff exists d with d.proj >= c.proj+epsProj AND d.own <= c.own-epsOwn.
      // Walk sorted desc-by-proj. Track "qualifying d's so far" (those with proj >= c.proj+epsProj).
      // We need d.proj >= c.proj+epsProj — i.e., d's already seen with proj sufficiently higher.
      // Maintain a list of (proj, own) sorted by proj desc. For c, find min own among d.proj >= c.proj+epsProj.
      const projOwnSoFar: { proj: number; own: number }[] = [];
      // Process sorted (high proj first). For each c, projOwnSoFar contains all earlier (higher-proj) candidates.
      // Filter to those with proj >= c.proj+epsProj. Take min own.
      for (const c of sorted) {
        let minOwnQualifying = Infinity;
        for (const d of projOwnSoFar) {
          if (d.proj >= c.projection + epsProj && d.own <= c.ownership - epsOwn && d.own < minOwnQualifying) {
            minOwnQualifying = d.own;
          }
        }
        // c dominated iff minOwnQualifying is finite (some d satisfied both conditions).
        if (minOwnQualifying === Infinity) {
          layerLineups.push(c);
        } else {
          stillRemaining.push(c);
        }
        projOwnSoFar.push({ proj: c.projection, own: c.ownership });
      }
      for (const c of layerLineups) paretoLayerByHash.set(c.hash, layer);
      layerCounts.push(layerLineups.length);
      remaining = stillRemaining;
      layer++;
    }
    // Anything left after maxLayer iterations gets layer = current.
    for (const c of remaining) paretoLayerByHash.set(c.hash, layer);

    // Filter: drop candidates beyond maxLayer.
    const kept = candidates.filter(c => (paretoLayerByHash.get(c.hash) ?? 999) <= maxLayer);
    console.log(`Pareto layers (soft, ε_proj=${epsProj}, ε_own=${epsOwn}):`);
    layerCounts.slice(0, Math.min(maxLayer, layerCounts.length)).forEach((cnt, i) => {
      console.log(`  layer ${i + 1}: ${cnt} lineups`);
    });
    console.log(`  beyond layer ${maxLayer}: ${candidates.length - kept.length} dropped`);
    console.log(`Kept: ${before} → ${kept.length} lineups`);
    candidates = kept;
  }
  console.log('');
  const P = candidates.length;

  // V1's pair/triple proj-weighted freqs (preserved combo uniqueness term).
  const v1Pair = new Map<string, number>(); const v1Trip = new Map<string, number>();
  let totalW = 0;
  for (const lu of candidates) {
    const w = Math.max(0.1, lu.projection || 1) ** 2; totalW += w;
    const ids = lu.players.map(p => p.id).sort();
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      v1Pair.set(ids[i] + '|' + ids[j], (v1Pair.get(ids[i] + '|' + ids[j]) || 0) + w);
      for (let l = j + 1; l < ids.length; l++) {
        const k = ids[i] + '|' + ids[j] + '|' + ids[l];
        v1Trip.set(k, (v1Trip.get(k) || 0) + w);
      }
    }
  }
  for (const k of v1Pair.keys()) v1Pair.set(k, v1Pair.get(k)! / totalW);
  for (const k of v1Trip.keys()) v1Trip.set(k, v1Trip.get(k)! / totalW);

  // Pool counts (input feature for GBM v3 + baseline).
  const poolCount: Record<number, Map<string, number>> = { 2: new Map(), 3: new Map(), 4: new Map(), 5: new Map() };
  for (const lu of candidates) {
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

  // GBM v3 field freqs (residual: final = pool * exp(GBM)).
  console.log('Predicting field freqs with v3-residual GBM (sizes 2-5)...');
  const t0 = Date.now();
  const fcPair = new Map<string, number>(); const fcTrip = new Map<string, number>();
  const fcQuad = new Map<string, number>(); const fcQuint = new Map<string, number>();
  function predictForCombo(size: number, key: string): number {
    const ids = key.split('|');
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
    let maxTeam = 0; for (const v of teamCounts.values()) if (v > maxTeam) maxTeam = v;
    const sameTeam = maxTeam === ids.length;
    const poolFreq = (poolCount[size].get(key) || 0) / P;
    const salaryEff = salSum > 0 ? projSum / (salSum / 1000) : 0;
    const x = [
      Math.log(poolFreq + SMALL),
      Math.log(ownProd + SMALL),
      sameTeam ? 1 : 0,
      Math.log(Math.max(SMALL, projSum)),
      Math.log(Math.max(SMALL, salSum)),
      Math.log(Math.max(SMALL, gameTotalSum)),
      Math.log(Math.max(SMALL, saberTeamSum)),
      ownPctileSum, projPctileSum, salaryEff, teamCounts.size,
    ];
    const residualLog = predictGBM(gbmModels[size], x);
    const poolSmoothed = Math.max(poolFreq, 1e-4);
    return Math.max(0, poolSmoothed * Math.exp(residualLog) - SMALL);
  }
  for (const [k, _] of poolCount[2]) fcPair.set(k, predictForCombo(2, k));
  for (const [k, _] of poolCount[3]) fcTrip.set(k, predictForCombo(3, k));
  for (const [k, _] of poolCount[4]) fcQuad.set(k, predictForCombo(4, k));
  for (const [k, _] of poolCount[5]) fcQuint.set(k, predictForCombo(5, k));
  console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  const missingFreq = 0.5 / P;

  function mapMedian(m: Map<string, number>): number {
    if (m.size === 0) return 1; const arr: number[] = []; for (const v of m.values()) arr.push(v);
    arr.sort((a, b) => a - b); return arr[Math.floor(arr.length / 2)] || 1;
  }
  const med2 = mapMedian(fcPair), med3 = mapMedian(fcTrip), med4 = mapMedian(fcQuad), med5 = mapMedian(fcQuint);

  // Score each candidate.
  console.log('Scoring (v7 = v4 base + v3-residual field freqs)...');
  interface S {
    lu: Lineup; primarySize: number; primaryTeam: string; corrAdj: number; logOwn: number; logOwnAll: number;
    uniqueness: number; multiPenalty: number; topConcentration: number; ppd: number;
    proj: number; floor: number; ceiling: number; range: number;
    ev: number; projPct: number; ownPct: number; rangePct: number; ppdPct: number;
    uniqPct: number; multiPct: number;
  }
  const scored: S[] = [];
  for (const lu of candidates) {
    let floor = 0, ceiling = 0;
    for (const p of lu.players) {
      if (p.percentiles) { floor += p.percentiles.p25 || p.projection * 0.85; ceiling += p.percentiles.p75 || p.projection * 1.15; }
      else { floor += p.projection * 0.85; ceiling += p.projection * 1.15; }
    }
    const teamHitters = new Map<string, number>(); const pitchers: Player[] = [];
    for (const p of lu.players) {
      if (isPitcher(p)) pitchers.push(p);
      else { const t = (p.team || '').toUpperCase(); if (t) teamHitters.set(t, (teamHitters.get(t) || 0) + 1); }
    }
    let primaryTeam = '', primarySize = 0;
    for (const [t, c] of teamHitters) if (c > primarySize) { primarySize = c; primaryTeam = t; }
    let pOpp = 0;
    for (const p of pitchers) { const o = (p.opponent || '').toUpperCase(); if (o) pOpp += teamHitters.get(o) || 0; }
    const corrAdj = ARGUS.PITCHER_VS_HITTER_PENALTY * pOpp;

    let uniqueness = 0;
    const players = lu.players;
    for (let i = 0; i < players.length; i++) for (let j = i + 1; j < players.length; j++) {
      const k = [players[i].id, players[j].id].sort().join('|');
      uniqueness += -Math.log(v1Pair.get(k) || 1e-6);
    }
    const tripFs: number[] = [];
    for (let i = 0; i < players.length; i++) for (let j = i + 1; j < players.length; j++) for (let l = j + 1; l < players.length; l++) {
      const tk = [players[i].id, players[j].id, players[l].id].sort().join('|');
      tripFs.push(v1Trip.get(tk) || 1e-6);
    }
    tripFs.sort((a, b) => b - a);
    for (const f of tripFs.slice(0, ARGUS.TRIPLE_FREQ_CAP)) uniqueness += -Math.log(f);

    const ids = players.map(p => p.id).sort();
    const slots: { f: number; r: number }[] = [];
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const f2 = fcPair.get(ids[i] + '|' + ids[j]) ?? missingFreq;
      slots.push({ f: f2, r: f2 / med2 });
      for (let l = j + 1; l < ids.length; l++) {
        const f3 = fcTrip.get(ids[i] + '|' + ids[j] + '|' + ids[l]) ?? missingFreq;
        slots.push({ f: f3, r: f3 / med3 });
        for (let m = l + 1; m < ids.length; m++) {
          const f4 = fcQuad.get(ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m]) ?? missingFreq;
          slots.push({ f: f4, r: f4 / med4 });
          for (let q = m + 1; q < ids.length; q++) {
            const f5 = fcQuint.get(ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m] + '|' + ids[q]) ?? missingFreq;
            slots.push({ f: f5, r: f5 / med5 });
          }
        }
      }
    }
    slots.sort((a, b) => b.r - a.r);
    let prodR = 1, prodF = 1; for (const s of slots.slice(0, ARGUS.TOP_K)) { prodR *= s.r; prodF *= s.f; }
    const multiPenalty = -Math.log(prodR + ARGUS.LOG_EPSILON);

    let logOwn = 0;
    for (const p of lu.players) { if (isPitcher(p)) continue; logOwn += Math.log(Math.max(0.1, p.ownership || 0.5)); }
    // logOwnAll: sum of log(ownership) over ALL 10 players (pitchers included).
    // Used for direct ownership-product subtraction (see W_OWN_PROD below).
    let logOwnAll = 0;
    for (const p of lu.players) logOwnAll += Math.log(Math.max(0.1, p.ownership || 0.5));
    let ppd = 0;
    for (const p of lu.players) if (p.salary && p.projection) ppd += p.projection / (p.salary / 1000);

    scored.push({
      lu, primarySize, primaryTeam, corrAdj, logOwn, logOwnAll, uniqueness, multiPenalty,
      topConcentration: prodF, ppd,
      proj: lu.projection, floor, ceiling, range: ceiling - floor,
      ev: 0, projPct: 0, ownPct: 0, rangePct: 0, ppdPct: 0, uniqPct: 0, multiPct: 0,
    });
  }
  const projAdj = scored.map(s => s.proj * (1 + s.corrAdj));
  const projPct = rankPercentile(projAdj);
  const ownPct = rankPercentile(scored.map(s => s.logOwn));
  const rangePct = rankPercentile(scored.map(s => s.range));
  const ceilingPct = rankPercentile(scored.map(s => s.ceiling));  // for leverage×ceiling interaction
  const ppdPct = rankPercentile(scored.map(s => s.ppd));
  const uniqPct = rankPercentile(scored.map(s => s.uniqueness));
  const multiPct = rankPercentile(scored.map(s => s.multiPenalty));
  // Pareto-layer bonus: lineups closer to the frontier get a small EV bonus.
  // Default W_PARETO_BONUS = 0.05 per layer drop (so layer-1 gets +0.05 vs layer-2).
  const wParetoBonus = process.env.ARGUS_PARETO_LAYER_BONUS ? parseFloat(process.env.ARGUS_PARETO_LAYER_BONUS) : 0.05;
  // Direct ownership-product subtraction: penalize chalky lineups linearly with
  // logOwnAll. We subtract a NORMALIZED version: (s.logOwnAll - meanLogOwnAll) /
  // |stdLogOwnAll|, so the penalty is roughly z-score scale (-3..+3) times W_OWN_PROD.
  // This makes the penalty interpretable (W_OWN_PROD = 0.10 ≈ 0.1 EV per stddev of chalk).
  const allLogOwnAll = scored.map(s => s.logOwnAll);
  const meanLogOwnAll = allLogOwnAll.reduce((s, x) => s + x, 0) / Math.max(1, allLogOwnAll.length);
  const varLogOwnAll = allLogOwnAll.reduce((s, x) => s + (x - meanLogOwnAll) ** 2, 0) / Math.max(1, allLogOwnAll.length);
  const stdLogOwnAll = Math.sqrt(varLogOwnAll) || 1;
  for (let i = 0; i < scored.length; i++) {
    scored[i].projPct = projPct[i]; scored[i].ownPct = ownPct[i];
    scored[i].rangePct = rangePct[i]; scored[i].ppdPct = ppdPct[i];
    scored[i].uniqPct = uniqPct[i]; scored[i].multiPct = multiPct[i];
    let ev = ARGUS.W_PROJ * projPct[i] + ARGUS.W_LEV * (1 - ownPct[i]) + ARGUS.W_VAR * rangePct[i] * 0.85
           + ARGUS.W_CMB * uniqPct[i] + ARGUS.W_MULTI * multiPct[i];
    // Leverage × ceiling interaction: bonus only when LOW ownership AND HIGH ceiling co-occur.
    if (ARGUS.W_LEV_CEIL > 0) {
      ev += ARGUS.W_LEV_CEIL * (1 - ownPct[i]) * ceilingPct[i];
    }
    // Direct ownership-product subtraction (positive z = chalkier = penalize).
    if (ARGUS.W_OWN_PROD > 0) {
      const zChalk = (scored[i].logOwnAll - meanLogOwnAll) / stdLogOwnAll;
      ev -= ARGUS.W_OWN_PROD * zChalk;
    }
    // Pareto-layer bonus (only applied if layers were computed).
    if (paretoLayerByHash.size > 0) {
      const layer = paretoLayerByHash.get(scored[i].lu.hash) ?? 999;
      ev += wParetoBonus * Math.max(0, 5 - layer);  // layer 1 → +4×bonus, layer 5 → 0
    }
    if (ppdPct[i] >= 1 - ARGUS.PPD_LINEUP_TOP_PCT) ev *= (1 - ARGUS.PPD_LINEUP_PENALTY);
    scored[i].ev = ev;
  }

  // Greedy fill.
  let pool2 = scored.filter(s => s.primarySize >= ARGUS.MIN_PRIMARY_STACK);
  if (pool2.length < N) pool2 = scored;
  const sortedHigh = [...pool2].sort((a, b) => (b.projPct + b.ownPct) - (a.projPct + a.ownPct));
  const sortedLow = [...pool2].sort((a, b) => ((1 - b.projPct) + (1 - b.ownPct)) - ((1 - a.projPct) + (1 - a.ownPct)));
  const HIGH = Math.round(N * ARGUS.BAND_HIGH_PCT);
  const LOW = Math.round(N * ARGUS.BAND_LOW_PCT);
  const MID = N - HIGH - LOW;
  const sel: S[] = []; const exposure = new Map<string, number>(); const teamCount = new Map<string, number>(); const seen = new Set<string>();
  function primaryStackTeamOf(s: S): string {
    const tc = new Map<string, number>();
    for (const p of s.lu.players) {
      if (isPitcher(p)) continue; const t = (p.team || '').toUpperCase();
      if (t) tc.set(t, (tc.get(t) || 0) + 1);
    }
    let pri = '', max = 0; for (const [t, c] of tc) if (c > max) { max = c; pri = t; }
    return max >= 4 ? pri : '';
  }
  function passes(s: S, maxOv: number): boolean {
    if (seen.has(s.lu.hash)) return false;
    if (s.primarySize < ARGUS.MIN_PRIMARY_STACK) return false;
    for (const p of s.lu.players) {
      const cur = exposure.get(p.id) || 0;
      const cap = isPitcher(p) ? ARGUS.EXPOSURE_CAP_PITCHER : ARGUS.EXPOSURE_CAP_HITTER;
      if ((cur + 1) / N > cap) return false;
    }
    const st = primaryStackTeamOf(s);
    if (st && (((teamCount.get(st) || 0) + 1) / N > ARGUS.TEAM_STACK_CAP)) return false;
    const ids = new Set(s.lu.players.map(p => p.id));
    for (const x of sel) {
      let ov = 0; for (const p of x.lu.players) if (ids.has(p.id)) ov++;
      if (ov > maxOv) return false;
    }
    return true;
  }
  function add(s: S) {
    sel.push(s); seen.add(s.lu.hash);
    for (const p of s.lu.players) exposure.set(p.id, (exposure.get(p.id) || 0) + 1);
    const st = primaryStackTeamOf(s); if (st) teamCount.set(st, (teamCount.get(st) || 0) + 1);
  }
  function fill(bp: S[], target: number) {
    const sorted = [...bp].sort((a, b) => b.ev - a.ev);
    let added = 0;
    for (const s of sorted) { if (added >= target) break; if (passes(s, ARGUS.MAX_PAIRWISE_OVERLAP)) { add(s); added++; } }
    if (added < target) for (const s of sorted) { if (added >= target) break; if (passes(s, ARGUS.MAX_PAIRWISE_OVERLAP + 1)) { add(s); added++; } }
  }
  fill(sortedHigh.slice(0, Math.max(HIGH * 5, 200)), HIGH);
  fill(pool2, MID);
  fill(sortedLow.slice(0, Math.max(LOW * 5, 200)), LOW);
  if (sel.length < N) {
    const sorted = [...pool2].sort((a, b) => b.ev - a.ev);
    for (const s of sorted) { if (sel.length >= N) break; if (passes(s, ARGUS.MAX_PAIRWISE_OVERLAP + 1)) add(s); }
  }
  const portfolio = sel.slice(0, N).map(s => s.lu);

  console.log('================================================================');
  console.log('PORTFOLIO STATS — Argus-v7 (v3-residual GBM, W=' + ARGUS.W_MULTI + ')');
  console.log('================================================================');
  console.log('  Lineups: ' + portfolio.length + '/' + N);
  console.log('  Avg projection: ' + mean(portfolio.map(lu => lu.projection)).toFixed(1));
  console.log('  Avg ownership:  ' + mean(portfolio.map(lu => lu.ownership)).toFixed(1) + '%');
  console.log('  Avg salary:     $' + (portfolio.reduce((s, lu) => s + lu.salary, 0) / portfolio.length).toFixed(0));

  // Stack distribution.
  const stackCounts = new Map<string, number>();
  for (const lu of portfolio) {
    const teams = new Map<string, number>();
    for (const p of lu.players) { if (isPitcher(p)) continue; const t = (p.team || '').toUpperCase(); if (t) teams.set(t, (teams.get(t) || 0) + 1); }
    let primary = '', primarySize = 0;
    for (const [t, c] of teams) if (c > primarySize) { primarySize = c; primary = t; }
    if (primarySize >= 4 && primary) stackCounts.set(primary, (stackCounts.get(primary) || 0) + 1);
  }
  const sortedStacks = [...stackCounts.entries()].sort((a, b) => b[1] - a[1]);
  console.log('\n  Team stacks (4+ hitters):');
  for (const [t, c] of sortedStacks) {
    console.log(`    ${t.padEnd(5)} ${c.toString().padStart(3)} lineups (${(c / portfolio.length * 100).toFixed(0)}%)`);
  }

  // Top exposures.
  const playerExp = new Map<string, { count: number; name: string; team: string; own: number; proj: number }>();
  for (const lu of portfolio) for (const p of lu.players) {
    const e = playerExp.get(p.id) || { count: 0, name: p.name, team: p.team || '', own: p.ownership || 0, proj: p.projection || 0 };
    e.count++; playerExp.set(p.id, e);
  }
  const sortedExp = [...playerExp.entries()].sort((a, b) => b[1].count - a[1].count);
  console.log('\n  Top 15 player exposures:');
  for (const [, v] of sortedExp.slice(0, 15)) {
    console.log(`    ${v.name.padEnd(25)} ${v.team.padEnd(5)} ${(v.count / portfolio.length * 100).toFixed(1).padStart(5)}% (${v.count}/${portfolio.length})  own=${v.own.toFixed(1)}%  proj=${v.proj.toFixed(1)}`);
  }
  console.log('\n  Unique players: ' + playerExp.size);

  // Export.
  const tag = OUTPUT_TAG ? '_' + OUTPUT_TAG : '';
  const OUT = path.join(DIR, 'theory_dfs_argus_v7_preslate_' + N + tag + '.csv');
  const DETAIL = path.join(DIR, 'theory_dfs_argus_v7_preslate_' + N + tag + '_detailed.csv');
  exportForDraftKings(portfolio, config, OUT);
  exportDetailedLineups(portfolio, config, DETAIL);
  console.log('\n================================================================');
  console.log('DONE — Argus-v7 preslate');
  console.log('================================================================');
  console.log('  DK upload:  ' + OUT);
  console.log('  Detail:     ' + DETAIL);
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
