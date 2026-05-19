/**
 * Pro consensus player-level vs our selectors.
 *
 * Loads pro_deep_analysis.json + runs Atlas + v2-no-reg per slate.
 * For each slate identifies pro-consensus players (mean pro exposure >= 30%).
 * Computes our selector's exposure to those same players.
 * Reports gap: "pros use X at 60%, we use at 10%" — slate by slate, aggregated.
 *
 * Goal: find the systematic player-level gap (if any) between us and pros.
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
const PRO_DEEP_PATH = path.join(DIR, 'pro_deep_analysis.json');
const MODEL_PATH = path.join(DIR, 'multi_combo_penalty_implementation', 'argus_gbm_v3_model.json');
const OUT_JSON = path.join(DIR, 'pro_consensus_vs_ours.json');

const N = 150;
const NUM_WORLDS = 1500;
const NU = 5;
const SEED = 12345;
const FIELD_SIZE = 8000;
const ATLAS_W_MULTI = 10;
const ATLAS_TOP_K_GREEDY = 1500;
const HITTER_CAP = 0.25;
const PITCHER_CAP = 0.45;
const TEAM_CAP = 0.20;
const SMALL = 1e-9;

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function mean(a: number[]): number { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function median(a: number[]): number { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }
function loadProjAux(p: string): { adjOwn: Map<string, number>; saberTotal: Map<string, number>; saberTeam: Map<string, number> } {
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
function buildPayoutTable(F: number): Float64Array {
  const FEE = 20; const pool = F * FEE * 0.88; const cashLine = Math.floor(F * 0.22);
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
function predictTree(t: TreeNode, x: number[]): number { let n: TreeNode = t; while (n.feature !== undefined) { if (x[n.feature] < n.threshold!) n = n.left!; else n = n.right!; } return n.leafValue || 0; }
function predictGBM(m: GBMModel, x: number[]): number { let p = m.basePred; for (const tree of m.trees) p += m.learningRate * predictTree(tree, x); return p; }
function findRank(s: number, sortedDesc: Float64Array): number { let lo = 0, hi = sortedDesc.length; while (lo < hi) { const m = (lo + hi) >>> 1; if (sortedDesc[m] > s) lo = m + 1; else hi = m; } return lo; }

function selectAtlas(candidates: Lineup[], players: Player[], idMap: Map<string, Player>, projAux: ReturnType<typeof loadProjAux>, gbm2: GBMModel): Lineup[] {
  const P = candidates.length;
  const sim = generateWorlds(players, NUM_WORLDS, NU, SEED);
  const playerIdx = new Map<string, number>();
  for (let i = 0; i < players.length; i++) playerIdx.set(players[i].id, i);
  const candScores = new Float32Array(P * NUM_WORLDS);
  for (let c = 0; c < P; c++) {
    const idxs: number[] = [];
    for (const p of candidates[c].players) { const i = playerIdx.get(p.id); if (i !== undefined) idxs.push(i); }
    for (let w = 0; w < NUM_WORLDS; w++) { let s = 0; for (const i of idxs) s += sim.scores[i * NUM_WORLDS + w]; candScores[c * NUM_WORLDS + w] = s; }
  }
  let rngS = SEED * 7 + 1;
  const rng = () => { rngS = (rngS * 1664525 + 1013904223) >>> 0; return rngS / 0x100000000; };
  const fieldIdx = new Int32Array(FIELD_SIZE);
  for (let f = 0; f < FIELD_SIZE; f++) fieldIdx[f] = Math.floor(rng() * P);
  const fSorted: Float64Array[] = new Array(NUM_WORLDS);
  for (let w = 0; w < NUM_WORLDS; w++) {
    const fs2 = new Float64Array(FIELD_SIZE);
    for (let f = 0; f < FIELD_SIZE; f++) fs2[f] = candScores[fieldIdx[f] * NUM_WORLDS + w];
    fs2.sort(); for (let i = 0, j = fs2.length - 1; i < j; i++, j--) { const t = fs2[i]; fs2[i] = fs2[j]; fs2[j] = t; }
    fSorted[w] = fs2;
  }
  const payTable = buildPayoutTable(FIELD_SIZE);
  const candEV = new Float64Array(P);
  for (let c = 0; c < P; c++) {
    let t = 0;
    for (let w = 0; w < NUM_WORLDS; w++) { const r = findRank(candScores[c * NUM_WORLDS + w], fSorted[w]); if (r < payTable.length) t += payTable[r]; }
    candEV[c] = t / NUM_WORLDS;
  }
  const pairCount = new Map<string, number>();
  for (const lu of candidates) { const ids = lu.players.map(p => p.id).sort(); for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) pairCount.set(ids[i] + '|' + ids[j], (pairCount.get(ids[i] + '|' + ids[j]) || 0) + 1); }
  const comboFeat = (ids: string[], pf: number): number[] => {
    let ownProd = 1, projSum = 0, salSum = 0, gtSum = 0, stSum = 0;
    const tc = new Map<string, number>();
    for (const id of ids) {
      const pl = idMap.get(id); if (!pl) continue;
      ownProd *= ((pl.ownership || 0) / 100); projSum += pl.projection || 0; salSum += pl.salary || 0;
      gtSum += projAux.saberTotal.get(id) || 0; stSum += projAux.saberTeam.get(id) || 0;
      const t = (pl.team || '').toUpperCase(); tc.set(t, (tc.get(t) || 0) + 1);
    }
    let maxT = 0; for (const v of tc.values()) if (v > maxT) maxT = v;
    const same = maxT === ids.length;
    const se = salSum > 0 ? projSum / (salSum / 1000) : 0;
    return [Math.log(Math.max(SMALL, pf)), Math.log(Math.max(SMALL, ownProd)), same ? 1 : 0, Math.log(Math.max(SMALL, projSum)), Math.log(Math.max(SMALL, salSum)), Math.log(Math.max(SMALL, gtSum)), Math.log(Math.max(SMALL, stSum)), 0, 0, se, tc.size];
  };
  const chalk = new Float32Array(P);
  for (let c = 0; c < P; c++) {
    const ids = candidates[c].players.map(p => p.id).sort();
    let s = 0, n = 0;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const k = ids[i] + '|' + ids[j]; const pf = (pairCount.get(k) || 0) / P;
      s += predictGBM(gbm2, comboFeat([ids[i], ids[j]], pf)); n++;
    }
    chalk[c] = n > 0 ? s / n : 0;
  }
  const chalkRank = new Float64Array(P);
  { const idx = Array.from({ length: P }, (_, i) => i).sort((a, b) => chalk[a] - chalk[b]); for (let r = 0; r < P; r++) chalkRank[idx[r]] = P > 1 ? r / (P - 1) : 0; }
  const atlasScore = new Float64Array(P);
  for (let c = 0; c < P; c++) atlasScore[c] = candEV[c] - ATLAS_W_MULTI * chalkRank[c];
  const rank = Array.from({ length: P }, (_, i) => i).sort((a, b) => atlasScore[b] - atlasScore[a]);
  const pool = new Int32Array(rank.slice(0, Math.min(ATLAS_TOP_K_GREEDY, P)));
  const sel: Lineup[] = []; const selSet = new Set<number>();
  const exp = new Map<string, number>(); const tsc = new Map<string, number>();
  for (let step = 0; step < N; step++) {
    let bi = -1, bs = -Infinity;
    for (let gi = 0; gi < pool.length; gi++) {
      const c = pool[gi];
      if (selSet.has(c)) continue;
      let ok = true;
      for (const p of candidates[c].players) {
        const cap = isPitcher(p) ? PITCHER_CAP : HITTER_CAP;
        if ((exp.get(p.id) || 0) >= Math.ceil(cap * N)) { ok = false; break; }
      }
      if (!ok) continue;
      const tc = new Map<string, number>();
      for (const p of candidates[c].players) { if (isPitcher(p)) continue; const t = (p.team || '').toUpperCase(); tc.set(t, (tc.get(t) || 0) + 1); }
      let so = true;
      for (const [t, cnt] of tc) if (cnt >= 4 && (tsc.get(t) || 0) >= Math.ceil(TEAM_CAP * N)) { so = false; break; }
      if (!so) continue;
      if (atlasScore[c] > bs) { bs = atlasScore[c]; bi = c; }
    }
    if (bi === -1) break;
    sel.push(candidates[bi]); selSet.add(bi);
    for (const p of candidates[bi].players) exp.set(p.id, (exp.get(p.id) || 0) + 1);
    const tc = new Map<string, number>();
    for (const p of candidates[bi].players) { if (isPitcher(p)) continue; const t = (p.team || '').toUpperCase(); tc.set(t, (tc.get(t) || 0) + 1); }
    for (const [t, cnt] of tc) if (cnt >= 4) tsc.set(t, (tsc.get(t) || 0) + 1);
  }
  return sel;
}

async function main() {
  console.log('================================================================');
  console.log('Pro consensus vs Our selectors — player-level gap analysis');
  console.log('================================================================\n');

  if (!fs.existsSync(PRO_DEEP_PATH)) { console.error(`Missing ${PRO_DEEP_PATH}`); process.exit(1); }
  const proDeep = JSON.parse(fs.readFileSync(PRO_DEEP_PATH, 'utf-8'));
  console.log(`Loaded ${proDeep.length} slates of pro consensus data.\n`);

  const gbmSaved = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf-8'));
  const gbm2: GBMModel = gbmSaved.models['2'];

  // Aggregate analysis across slates.
  interface PlayerGap {
    name: string;
    slate: string;
    proMeanPct: number;
    atlasPct: number;
    v2nrPct: number;
    proAtlasGap: number;       // proMeanPct − atlasPct (positive = pros use more)
    proV2nrGap: number;
    pos: string;
    own: number;
    proj: number;
  }
  const allGaps: PlayerGap[] = [];

  for (const sr of proDeep) {
    const slate = sr.slate;
    const consensusPlays = sr.consensusPlays || [];   // players with mean pro exposure >= 30%
    if (consensusPlays.length === 0) continue;

    // Locate slate files.
    const slateRec = require('./athena-backtest').SLATES?.find?.((s: any) => s.slate === slate);  // try import — fallback below
    // Workaround: hardcode the slate-to-file mapping.
    const slateFiles: Record<string, { proj: string; actuals: string; pool: string }> = {
      '4-6-26':         { proj: '4-6-26_projections.csv',        actuals: 'dkactuals 4-6-26.csv',      pool: 'sspool4-6-26.csv' },
      '4-8-26':         { proj: '4-8-26projections.csv',         actuals: '4-8-26actuals.csv',         pool: '4-8-26sspool.csv' },
      '4-12-26':        { proj: '4-12-26projections.csv',        actuals: '4-12-26actuals.csv',        pool: '4-12-26sspool.csv' },
      '4-14-26':        { proj: '4-14-26projections.csv',        actuals: '4-14-26actuals.csv',        pool: '4-14-26sspool.csv' },
      '4-15-26':        { proj: '4-15-26projections.csv',        actuals: '4-15-26actuals.csv',        pool: '4-15-26sspool.csv' },
      '4-17-26':        { proj: '4-17-26projections.csv',        actuals: '4-17-26actuals.csv',        pool: '4-17-26sspool.csv' },
      '4-18-26':        { proj: '4-18-26projections.csv',        actuals: '4-18-26actuals.csv',        pool: '4-18-26sspool.csv' },
      '4-19-26':        { proj: '4-19-26projections.csv',        actuals: '4-19-26actuals.csv',        pool: '4-19-26sspool.csv' },
      '4-20-26':        { proj: '4-20-26projections.csv',        actuals: '4-20-26actuals.csv',        pool: '4-20-26sspool.csv' },
      '4-21-26':        { proj: '4-21-26projections.csv',        actuals: '4-21-26actuals.csv',        pool: '4-21-26sspool.csv' },
      '4-22-26':        { proj: '4-22-26projections.csv',        actuals: '4-22-26actuals.csv',        pool: '4-22-26sspool.csv' },
      '4-23-26':        { proj: '4-23-26projections.csv',        actuals: '4-23-26actuals.csv',        pool: '4-23-26sspool.csv' },
      '4-24-26':        { proj: '4-24-26projections.csv',        actuals: '4-24-26actuals.csv',        pool: '4-24-26sspool.csv' },
      '4-25-26':        { proj: '4-25-26projections.csv',        actuals: '4-25-26actuals.csv',        pool: '4-25-26sspool.csv' },
      '4-25-26-early':  { proj: '4-25-26projectionsearly.csv',   actuals: '4-25-26actualsearly.csv',   pool: '4-25-26sspoolearly.csv' },
      '4-26-26':        { proj: '4-26-26projections.csv',        actuals: '4-26-26actuals.csv',        pool: '4-26-26sspool.csv' },
      '4-27-26':        { proj: '4-27-26projections.csv',        actuals: '4-27-26actuals.csv',        pool: '4-27-26sspool.csv' },
      '4-28-26':        { proj: '4-28-26projections.csv',        actuals: '4-28-26actuals.csv',        pool: '4-28-26sspool.csv' },
      '4-29-26':        { proj: '4-29-26projections.csv',        actuals: '4-29-26actuals.csv',        pool: '4-29-26sspool.csv' },
      '5-1-26':         { proj: '5-1-26projections.csv',         actuals: '5-1-26actuals.csv',         pool: '5-1-26sspool.csv' },
      '5-2-26':         { proj: '5-2-26projections.csv',         actuals: '5-2-26actuals.csv',         pool: '5-2-26sspool.csv' },
      '5-2-26-main':    { proj: '5-2-26projectionsmain.csv',     actuals: '5-2-26actualsmain.csv',     pool: '5-2-26sspoolmain.csv' },
      '5-2-26-night':   { proj: '5-2-26projectionsnight.csv',    actuals: '5-2-26actualsnight.csv',    pool: '5-2-26sspoolnight.csv' },
      '5-3-26':         { proj: '5-3-26projections.csv',         actuals: '5-3-26actuals.csv',         pool: '5-3-26sspool.csv' },
      '5-3-26-late':    { proj: '5-3-26projectionslate.csv',     actuals: '5-3-26actualslate.csv',     pool: '5-3-26sspoollate.csv' },
      '5-4-26':         { proj: '5-4-26projections.csv',         actuals: '5-4-26actuals.csv',         pool: '5-4-26sspool.csv' },
      '5-4-26-late':    { proj: '5-4-26projectionslate.csv',     actuals: '5-4-26actualslate.csv',     pool: '5-4-26sspoollate.csv' },
      '5-5-26':         { proj: '5-5-26projections.csv',         actuals: '5-5-26actuals.csv',         pool: '5-5-26sspool.csv' },
      '5-6-26':         { proj: '5-6-26projections.csv',         actuals: '5-6-26actuals.csv',         pool: '5-6-26sspool.csv' },
    };
    const sf = slateFiles[slate];
    if (!sf) continue;

    const projPath = path.join(DIR, sf.proj), poolPath = path.join(DIR, sf.pool);
    if (!fs.existsSync(projPath) || !fs.existsSync(poolPath)) continue;
    try {
      const pr = parseCSVFile(projPath, 'mlb', true);
      const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
      const pool = buildPlayerPool(pr.players, pr.detectedContestType);
      const idMap = new Map<string, Player>(); for (const p of pool.players) idMap.set(p.id, p);
      const projAux = loadProjAux(projPath);
      for (const p of pool.players) { const adj = projAux.adjOwn.get(p.id); if (adj !== undefined) p.ownership = adj; }
      const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
      const candidates: Lineup[] = Array.from(new Map<string, Lineup>(loaded.lineups.map(l => [l.hash, l])).values());
      if (candidates.length < 100) continue;

      const atlasPort = selectAtlas(candidates, pool.players, idMap, projAux, gbm2);
      const simStats = computeLineupSimStats(candidates, pool.players);
      const v2 = selectPortfolioCoverageV2Portfolio(candidates, pool.players, N, THEORY_V1_NOCORR_PARAMS, simStats, { fallbackToV1: true });

      const atlasExp = new Map<string, number>();
      for (const lu of atlasPort) for (const p of lu.players) atlasExp.set(p.id, (atlasExp.get(p.id) || 0) + 1);
      const v2Exp = new Map<string, number>();
      for (const lu of v2.selected) for (const p of lu.players) v2Exp.set(p.id, (v2Exp.get(p.id) || 0) + 1);

      let consensusCovered = 0;
      for (const cp of consensusPlays) {
        const id = cp.playerId;
        const aPct = (atlasExp.get(id) || 0) / atlasPort.length;
        const vPct = (v2Exp.get(id) || 0) / v2.selected.length;
        allGaps.push({
          name: cp.name, slate, proMeanPct: cp.meanPct, atlasPct: aPct, v2nrPct: vPct,
          proAtlasGap: cp.meanPct - aPct, proV2nrGap: cp.meanPct - vPct,
          pos: cp.pos, own: cp.own, proj: cp.proj,
        });
        if (aPct >= 0.20 || vPct >= 0.20) consensusCovered++;
      }
      console.log(`  ${slate.padEnd(15)} consensus=${consensusPlays.length}  covered>=20% by either=${consensusCovered}`);
    } catch (e: any) {
      console.log(`  ${slate}: error — ${e?.message || e}`);
    }
  }

  // Aggregate gaps.
  console.log('\n================================================================');
  console.log(`AGGREGATE — ${allGaps.length} pro-consensus player-slates`);
  console.log('================================================================\n');

  console.log(`Mean pro consensus exposure: ${(mean(allGaps.map(g => g.proMeanPct)) * 100).toFixed(1)}%`);
  console.log(`Mean Atlas exposure on consensus players: ${(mean(allGaps.map(g => g.atlasPct)) * 100).toFixed(1)}%`);
  console.log(`Mean v2-no-reg exposure on consensus players: ${(mean(allGaps.map(g => g.v2nrPct)) * 100).toFixed(1)}%`);
  console.log(`Mean Atlas gap (pro − Atlas): ${(mean(allGaps.map(g => g.proAtlasGap)) * 100).toFixed(1)}pp`);
  console.log(`Mean v2-no-reg gap (pro − v2nr): ${(mean(allGaps.map(g => g.proV2nrGap)) * 100).toFixed(1)}pp`);

  // Largest gaps (where pros use heavily but we don't).
  console.log('\n--- Top 30 largest player-slate gaps (pros use, Atlas skips) ---');
  const sortedAtlas = [...allGaps].sort((a, b) => b.proAtlasGap - a.proAtlasGap).slice(0, 30);
  console.log(`${'Slate'.padEnd(15)} ${'Player'.padEnd(28)} ${'Pos'.padEnd(4)} pro%  atlas%  gap%  own%   proj`);
  for (const g of sortedAtlas) {
    console.log(`${g.slate.padEnd(15)} ${g.name.padEnd(28)} ${g.pos.padEnd(4)} ${(g.proMeanPct * 100).toFixed(0).padStart(3)}%   ${(g.atlasPct * 100).toFixed(0).padStart(3)}%   ${(g.proAtlasGap * 100).toFixed(0).padStart(3)}%   ${g.own.toFixed(0).padStart(3)}%   ${g.proj.toFixed(1)}`);
  }

  console.log('\n--- Top 30 largest player-slate gaps (pros use, v2-no-reg skips) ---');
  const sortedV2 = [...allGaps].sort((a, b) => b.proV2nrGap - a.proV2nrGap).slice(0, 30);
  for (const g of sortedV2) {
    console.log(`${g.slate.padEnd(15)} ${g.name.padEnd(28)} ${g.pos.padEnd(4)} ${(g.proMeanPct * 100).toFixed(0).padStart(3)}%   ${(g.v2nrPct * 100).toFixed(0).padStart(3)}%   ${(g.proV2nrGap * 100).toFixed(0).padStart(3)}%   ${g.own.toFixed(0).padStart(3)}%   ${g.proj.toFixed(1)}`);
  }

  // Position analysis: which positions have biggest gaps?
  console.log('\n--- Gap by position ---');
  const byPos = new Map<string, { count: number; sumGap: number }>();
  for (const g of allGaps) {
    const pos = g.pos || 'UNK';
    const r = byPos.get(pos); if (r) { r.count++; r.sumGap += g.proAtlasGap; } else byPos.set(pos, { count: 1, sumGap: g.proAtlasGap });
  }
  console.log(`${'Pos'.padEnd(6)} count  avgGapToAtlas%`);
  for (const [pos, r] of [...byPos.entries()].sort((a, b) => b[1].sumGap / b[1].count - a[1].sumGap / a[1].count)) {
    console.log(`${pos.padEnd(6)} ${r.count.toString().padStart(4)}    ${(r.sumGap / r.count * 100).toFixed(1)}%`);
  }

  fs.writeFileSync(OUT_JSON, JSON.stringify(allGaps, null, 2));
  console.log(`\nFull data saved to ${OUT_JSON}`);
}

main().catch(e => { console.error(e); process.exit(1); });
