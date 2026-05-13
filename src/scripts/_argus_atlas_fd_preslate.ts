/**
 * Argus-Atlas pre-slate (production scoring path for tonight's slate).
 *
 * Architecture matches the 29-slate LOO winner (mlb-argus-atlas-config-2026-05-10):
 *   - T-copula sim (ν=5, 1500 worlds) with empirical-CDF marginals
 *   - EV-vs-field via Haugh-Singal payout-ranking, UNIFORM field sampling
 *   - GBM v3 combo prior (W=10) — chalk-pattern penalty
 *   - NO ρ-penalty, NO Mahal-penalty (dormant per ablation)
 *
 * Env vars:
 *   ARGUS_PROJ_FILE     default mlbdkprojpre.csv
 *   ARGUS_POOL_FILES    default sspool1pre.csv,sspool2pre.csv,sspool3pre.csv
 *   ARGUS_TARGET_COUNT  default 150
 *   ARGUS_OUTPUT_TAG    default 'atlas'
 *   ARGUS_W_MULTI_BLEND default 10
 *   ARGUS_NUM_WORLDS    default 1500
 *   ARGUS_FIELD_SIZE    default 8000
 *   ARGUS_HITTER_CAP    default 0.25
 *   ARGUS_PITCHER_CAP   default 0.45
 *   ARGUS_TEAM_CAP      default 0.20
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as csvParse } from 'csv-parse/sync';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';
import { exportForDraftKings, exportDetailedLineups } from '../scoring';
import { generateWorlds } from '../v35/simulation';

const DIR = 'C:/Users/colin/dfs opto';
const MODEL_PATH = path.join(DIR, 'multi_combo_penalty_implementation', 'argus_gbm_v3_model.json');
const PROJ_FILE = process.env.ARGUS_PROJ_FILE || 'fdmlbproj.csv';
const POOL_FILES = (process.env.ARGUS_POOL_FILES || 'mlbfdpool1.csv,mlbfdpool2.csv').split(',').map(s => s.trim()).filter(Boolean);
const N = process.env.ARGUS_TARGET_COUNT ? parseInt(process.env.ARGUS_TARGET_COUNT, 10) : 150;
const TAG = process.env.ARGUS_OUTPUT_TAG || 'atlas_fd';
// Teams to exclude (e.g., already-locked games). Lineups containing any of these teams' players are dropped.
const EXCLUDE_TEAMS = (process.env.ARGUS_EXCLUDE_TEAMS || 'TOR,TB').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const W_MULTI_BLEND = process.env.ARGUS_W_MULTI_BLEND ? parseFloat(process.env.ARGUS_W_MULTI_BLEND) : 10;
const NUM_WORLDS = process.env.ARGUS_NUM_WORLDS ? parseInt(process.env.ARGUS_NUM_WORLDS, 10) : 1500;
const FIELD_SIZE = process.env.ARGUS_FIELD_SIZE ? parseInt(process.env.ARGUS_FIELD_SIZE, 10) : 8000;
const NU = 5;
const SEED_BASE = 12345;
const FEE = 20;
const SMALL = 1e-9;
const TOP_K_GREEDY = 1500;

const EXPOSURE_CAP_HITTER = process.env.ARGUS_HITTER_CAP ? parseFloat(process.env.ARGUS_HITTER_CAP) : 0.25;
const EXPOSURE_CAP_PITCHER = process.env.ARGUS_PITCHER_CAP ? parseFloat(process.env.ARGUS_PITCHER_CAP) : 0.45;
const TEAM_STACK_CAP = process.env.ARGUS_TEAM_CAP ? parseFloat(process.env.ARGUS_TEAM_CAP) : 0.20;

function isPitcher(p: Player): boolean { return (p.position || '').toUpperCase().includes('P'); }
function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function mean(a: number[]): number { if (!a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; }
function median(arr: number[]): number { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }

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
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (sortedDesc[mid] > score) lo = mid + 1; else hi = mid; }
  return lo;
}

async function main() {
  console.log('================================================================');
  console.log('ARGUS-ATLAS pre-slate — FANDUEL MLB (t-copula + uniform-field + GBM combo prior)');
  console.log('================================================================');
  console.log(`Target N=${N}, sim=${NUM_WORLDS} worlds (ν=${NU}), field=${FIELD_SIZE}, W_MULTI=${W_MULTI_BLEND}`);
  console.log(`Caps: hitter=${EXPOSURE_CAP_HITTER} pitcher=${EXPOSURE_CAP_PITCHER} team=${TEAM_STACK_CAP}\n`);

  // GBM v3.
  if (!fs.existsSync(MODEL_PATH)) { console.error(`Missing GBM v3: ${MODEL_PATH}`); process.exit(1); }
  const gbmSaved = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf-8'));
  const gbm2: GBMModel = gbmSaved.models['2'];
  console.log(`Loaded GBM v3 (sizes ${Object.keys(gbmSaved.models).join(',')}).\n`);

  // Slate + pool loading.
  const projPath = path.join(DIR, PROJ_FILE);
  if (!fs.existsSync(projPath)) { console.error(`Missing projections: ${projPath}`); process.exit(1); }
  const pr = parseCSVFile(projPath, 'mlb', true);
  const config = getContestConfig('fd', 'mlb', 'classic');
  const pool = buildPlayerPool(pr.players, pr.detectedContestType);
  const projData = loadProjFile(projPath);
  const idMap = new Map<string, Player>();
  for (const p of pool.players) {
    idMap.set(p.id, p);
    const adj = projData.adjOwn.get(p.id);
    p.ownership = (adj !== undefined ? adj : (p.ownership || 0));
  }
  const players = pool.players;
  console.log(`Slate: ${players.length} players`);

  // Merge all candidate pools.
  const merged = new Map<string, Lineup>();
  let total = 0;
  for (const pf of POOL_FILES) {
    const pp = path.join(DIR, pf);
    if (!fs.existsSync(pp)) { console.log(`  Skip ${pf}: not found`); continue; }
    const loaded = loadPoolFromCSV({ filePath: pp, config, playerMap: idMap });
    total += loaded.lineups.length;
    for (const lu of loaded.lineups) if (!merged.has(lu.hash)) merged.set(lu.hash, lu);
    console.log(`  ${pf}: ${loaded.lineups.length} lineups`);
  }
  let candidates = Array.from(merged.values());
  console.log(`Merged: ${candidates.length} unique lineups (from ${total})`);
  if (EXCLUDE_TEAMS.length > 0) {
    const before = candidates.length;
    const excludeSet = new Set(EXCLUDE_TEAMS);
    candidates = candidates.filter(lu => !lu.players.some(p => excludeSet.has((p.team || '').toUpperCase())));
    console.log(`  filtered ${before - candidates.length} lineups containing excluded teams [${EXCLUDE_TEAMS.join(',')}]`);
  }
  const P = candidates.length;
  console.log(`Final candidates: ${P}\n`);

  // T-copula sim.
  console.log(`[1/5] T-copula sim (${players.length} players × ${NUM_WORLDS} worlds, ν=${NU})...`);
  const t1 = Date.now();
  const sim = generateWorlds(players, NUM_WORLDS, NU, SEED_BASE);
  console.log(`  done in ${((Date.now() - t1) / 1000).toFixed(1)}s`);

  // Score candidates per world.
  const playerIdx = new Map<string, number>();
  for (let i = 0; i < players.length; i++) playerIdx.set(players[i].id, i);
  console.log(`\n[2/5] Score ${P} candidates × ${NUM_WORLDS} worlds...`);
  const t2 = Date.now();
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
  console.log(`  done in ${((Date.now() - t2) / 1000).toFixed(1)}s`);

  // Uniform field sample.
  console.log(`\n[3/5] Build UNIFORM field of ${FIELD_SIZE} from pool...`);
  const t3 = Date.now();
  let rngS = SEED_BASE * 7 + 1;
  function rng(): number { rngS = (rngS * 1664525 + 1013904223) >>> 0; return rngS / 0x100000000; }
  const fieldIndices = new Int32Array(FIELD_SIZE);
  for (let f = 0; f < FIELD_SIZE; f++) fieldIndices[f] = Math.floor(rng() * P);
  // Score field per world, sorted descending.
  const fieldSortedPerWorld: Float64Array[] = new Array(NUM_WORLDS);
  for (let w = 0; w < NUM_WORLDS; w++) {
    const fs2 = new Float64Array(FIELD_SIZE);
    for (let f = 0; f < FIELD_SIZE; f++) fs2[f] = candScores[fieldIndices[f] * NUM_WORLDS + w];
    fs2.sort();
    for (let i = 0, j = fs2.length - 1; i < j; i++, j--) { const tmp = fs2[i]; fs2[i] = fs2[j]; fs2[j] = tmp; }
    fieldSortedPerWorld[w] = fs2;
  }
  const payTable = buildPayoutTable(FIELD_SIZE);
  console.log(`  done in ${((Date.now() - t3) / 1000).toFixed(1)}s`);

  // EV-vs-field per candidate.
  console.log(`\n[4/5] EV-vs-field per candidate...`);
  const t4 = Date.now();
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
  console.log(`  done in ${((Date.now() - t4) / 1000).toFixed(1)}s | EV: max=$${Math.max(...candEV).toFixed(2)} median=$${median(Array.from(candEV)).toFixed(2)}`);

  // GBM v3 combo prior (chalk rank per candidate, computed on 2-combos).
  const pairCount = new Map<string, number>();
  for (const lu of candidates) {
    const ids = lu.players.map(p => p.id).sort();
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const k = ids[i] + '|' + ids[j];
      pairCount.set(k, (pairCount.get(k) || 0) + 1);
    }
  }
  function comboFeatures(ids: string[], poolFreq: number): number[] {
    let ownProd = 1, projSum = 0, salSum = 0, gameTotalSum = 0, saberTeamSum = 0;
    let ownPctileSum = 0, projPctileSum = 0;
    const teamCounts = new Map<string, number>();
    for (const id of ids) {
      const pl = idMap.get(id); if (!pl) continue;
      ownProd *= ((pl.ownership || 0) / 100);
      projSum += pl.projection || 0;
      salSum += pl.salary || 0;
      gameTotalSum += projData.saberTotal.get(id) || 0;
      saberTeamSum += projData.saberTeam.get(id) || 0;
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
      ownPctileSum, projPctileSum, salaryEff, teamCounts.size,
    ];
  }
  console.log(`\n[5/5] Greedy with combo prior W=${W_MULTI_BLEND}...`);
  const t5 = Date.now();
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

  // Top-K candidates by EV for greedy.
  const evRankIdx = Array.from({ length: P }, (_, i) => i).sort((a, b) => candEV[b] - candEV[a]);
  const greedyPool = new Int32Array(evRankIdx.slice(0, Math.min(TOP_K_GREEDY, P)));

  // Greedy selection.
  const selected: number[] = [];
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
      const score = candEV[c] - W_MULTI_BLEND * chalkRank[c];
      if (score > bestScore) { bestScore = score; bestIdx = c; }
    }
    if (bestIdx === -1) { console.log(`  step ${step + 1}: no eligible candidate`); break; }
    selected.push(bestIdx);
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
  console.log(`  selected ${selected.length}/${N} in ${((Date.now() - t5) / 1000).toFixed(1)}s`);

  // Portfolio summary.
  const selLineups = selected.map(c => candidates[c]);
  const avgProj = mean(selLineups.map(l => l.projection));
  const avgOwn = mean(selLineups.map(l => l.players.reduce((s, p) => s + (p.ownership || 0), 0) / l.players.length));
  const avgSal = mean(selLineups.map(l => l.players.reduce((s, p) => s + (p.salary || 0), 0)));
  const portfolioEV = mean(selected.map(c => candEV[c]));
  console.log('\n================================================================');
  console.log('PORTFOLIO STATS — Argus-Atlas');
  console.log('================================================================');
  console.log(`  Lineups: ${selected.length}/${N}`);
  console.log(`  Avg projection: ${avgProj.toFixed(1)}`);
  console.log(`  Avg ownership:  ${avgOwn.toFixed(2)}%`);
  console.log(`  Avg salary:     $${avgSal.toFixed(0)}`);
  console.log(`  Expected payout per lineup: $${portfolioEV.toFixed(2)}`);

  // Team stack counts.
  const stackSummary = new Map<string, number>();
  for (const lu of selLineups) {
    const tc = new Map<string, number>();
    for (const p of lu.players) {
      if (isPitcher(p)) continue;
      const t = (p.team || '').toUpperCase();
      tc.set(t, (tc.get(t) || 0) + 1);
    }
    for (const [t, c] of tc) if (c >= 4) stackSummary.set(t, (stackSummary.get(t) || 0) + 1);
  }
  console.log(`\n  Team stacks (4+ hitters):`);
  const sortedStacks = [...stackSummary.entries()].sort((a, b) => b[1] - a[1]);
  for (const [t, c] of sortedStacks) console.log(`    ${t.padEnd(6)} ${String(c).padStart(3)} lineups (${((c / selected.length) * 100).toFixed(0)}%)`);

  // Top 15 player exposures.
  const expByPlayer = new Map<string, { name: string; team: string; own: number; proj: number; count: number }>();
  for (const lu of selLineups) {
    for (const p of lu.players) {
      const k = p.id;
      const r = expByPlayer.get(k);
      if (r) r.count++; else expByPlayer.set(k, { name: p.name, team: p.team || '', own: p.ownership || 0, proj: p.projection || 0, count: 1 });
    }
  }
  console.log(`\n  Top 15 player exposures:`);
  const sortedExp = [...expByPlayer.values()].sort((a, b) => b.count - a.count).slice(0, 15);
  for (const r of sortedExp) console.log(`    ${r.name.padEnd(26)} ${r.team.padEnd(4)} ${((r.count / selected.length) * 100).toFixed(1).padStart(5)}% (${r.count}/${selected.length})  own=${r.own.toFixed(1)}%  proj=${r.proj.toFixed(1)}`);
  console.log(`\n  Unique players: ${expByPlayer.size}`);

  // Export.
  const tagSuffix = TAG ? `_${TAG}` : '';
  const outDk = path.join(DIR, `theory_dfs_argus_atlas_fd_preslate_${selected.length}${tagSuffix}.csv`);
  const outDetail = path.join(DIR, `theory_dfs_argus_atlas_fd_preslate_${selected.length}${tagSuffix}_detailed.csv`);
  exportForDraftKings(selLineups, config, outDk);
  exportDetailedLineups(selLineups, config, outDetail);
  console.log(`\n================================================================`);
  console.log(`DONE — Argus-Atlas preslate`);
  console.log(`================================================================`);
  console.log(`  DK upload:  ${outDk}`);
  console.log(`  Detail:     ${outDetail}`);
}

main().catch(e => { console.error(e); process.exit(1); });
