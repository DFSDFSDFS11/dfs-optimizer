/**
 * Out-of-sample chalk-combo prediction accuracy on the 11 NEW holdout slates.
 *
 * Loads the GBM v2 model trained on the original 16 dev slates and applies
 * it to the 11 new slates (4-14, 4-15, 4-19, 4-20, 5-1, 5-2, 5-2-night,
 * 5-3-late, 5-4, 5-4-late, 5-5). True OOS test.
 *
 * For each slate:
 *   - Take top-N highest-actual combos per size (the chalk that matters)
 *   - Compare predicted (pool baseline + GBM v2) to actual
 *   - Report median |relative error|, median absolute error
 *
 * Then aggregate across slates.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as csvParse } from 'csv-parse/sync';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';

const DIR = 'C:/Users/colin/dfs opto';
const MODEL_PATH = path.join(DIR, 'multi_combo_penalty_implementation', 'argus_gbm_v2_model.json');
const SMALL = 1e-9;
const TOP_N_CHALK = 10;  // top-N combos per size by actual frequency

const HOLDOUT_SLATES = [
  { slate: '4-14-26',     proj: '4-14-26projections.csv',     actuals: '4-14-26actuals.csv',     pool: '4-14-26sspool.csv' },
  { slate: '4-15-26',     proj: '4-15-26projections.csv',     actuals: '4-15-26actuals.csv',     pool: '4-15-26sspool.csv' },
  { slate: '4-19-26',     proj: '4-19-26projections.csv',     actuals: '4-19-26actuals.csv',     pool: '4-19-26sspool.csv' },
  { slate: '4-20-26',     proj: '4-20-26projections.csv',     actuals: '4-20-26actuals.csv',     pool: '4-20-26sspool.csv' },
  { slate: '5-1-26',      proj: '5-1-26projections.csv',      actuals: '5-1-26actuals.csv',      pool: '5-1-26sspool.csv' },
  { slate: '5-2-26',      proj: '5-2-26projections.csv',      actuals: '5-2-26actuals.csv',      pool: '5-2-26sspool.csv' },
  { slate: '5-2-26-night', proj: '5-2-26projectionsnight.csv', actuals: '5-2-26actualsnight.csv', pool: '5-2-26sspoolnight.csv' },
  { slate: '5-3-26-late', proj: '5-3-26projectionslate.csv',  actuals: '5-3-26actualslate.csv',  pool: '5-3-26sspoollate.csv' },
  { slate: '5-4-26',      proj: '5-4-26projections.csv',      actuals: '5-4-26actuals.csv',      pool: '5-4-26sspool.csv' },
  { slate: '5-4-26-late', proj: '5-4-26projectionslate.csv',  actuals: '5-4-26actualslate.csv',  pool: '5-4-26sspoollate.csv' },
  { slate: '5-5-26',      proj: '5-5-26projections.csv',      actuals: '5-5-26actuals.csv',      pool: '5-5-26sspool.csv' },
];

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function median(arr: number[]): number { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }
function mean(a: number[]): number { if (!a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; }
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

interface ChalkRecord { combo: string; actualPct: number; poolPredPct: number; gbmPredPct: number; }
interface SlateOut { slate: string; F: number; P: number; bySize: Record<number, ChalkRecord[]>; }

async function main() {
  console.log('=== OOS chalk-combo prediction accuracy: 11 holdout slates ===');
  console.log('Model: argus_gbm_v2_model.json (trained on 16 dev slates only)');
  console.log(`Top-${TOP_N_CHALK} highest-actual-% combos per (slate, size)\n`);

  const modelData = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf-8'));
  const gbmModels: Record<number, GBMModel> = modelData.models;
  console.log('Loaded model. Sizes available: ' + Object.keys(gbmModels).join(','));
  console.log('');

  const slateOuts: SlateOut[] = [];
  for (const s of HOLDOUT_SLATES) {
    process.stdout.write(s.slate.padEnd(15) + ' ');
    const projPath = path.join(DIR, s.proj), actualsPath = path.join(DIR, s.actuals), poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) { console.log('MISSING FILES'); continue; }
    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);
    const projData = loadProjFile(projPath);

    const idMap = new Map<string, Player>(); const nameMap = new Map<string, Player>();
    const ownDecById = new Map<string, number>(); const projById = new Map<string, number>();
    const salById = new Map<string, number>(); const teamById = new Map<string, string>();
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

    let loaded;
    try { loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap }); }
    catch (e) { console.log('SSPOOL_BAD: ' + (e as Error).message.slice(0, 50)); continue; }
    const poolLineups = Array.from(new Map(loaded.lineups.map(l => [l.hash, l])).values());

    const entryIds: string[][] = [];
    for (const e of actuals.entries) {
      const ids: string[] = []; let ok = true;
      for (const nm of e.playerNames) { const pl = nameMap.get(norm(nm)); if (!pl) { ok = false; break; } ids.push(pl.id); }
      if (ok) entryIds.push(ids.sort());
    }
    const F = entryIds.length, P = poolLineups.length;
    if (F < 100 || P < 100) { console.log(`F=${F} P=${P} too small`); continue; }

    // Pool counts.
    const poolCount: Record<number, Map<string, number>> = { 2: new Map(), 3: new Map(), 4: new Map(), 5: new Map() };
    for (const lu of poolLineups) {
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
    // Actual counts.
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

    // For each size, take top-N chalk by actual count, compute predictions.
    const out: SlateOut = { slate: s.slate, F, P, bySize: {} };
    for (const size of [2, 3, 4, 5] as const) {
      const sortedActual = [...actualCount[size]].sort((a, b) => b[1] - a[1]).slice(0, TOP_N_CHALK);
      const recs: ChalkRecord[] = [];
      for (const [k, c] of sortedActual) {
        const ids = k.split('|');
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
        const poolFreq = (poolCount[size].get(k) || 0) / P;
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
        const gbmPred = Math.max(0, Math.exp(predictGBM(gbmModels[size], x)) - SMALL);
        recs.push({ combo: k, actualPct: c / F * 100, poolPredPct: poolFreq * 100, gbmPredPct: gbmPred * 100 });
      }
      out.bySize[size] = recs;
    }
    slateOuts.push(out);
    console.log(`F=${F} P=${P} ✓`);
  }
  console.log(`\n${slateOuts.length} slates processed.\n`);

  // Per-size aggregate accuracy.
  console.log('================================================================');
  console.log(`AGGREGATE — top-${TOP_N_CHALK} chalk combos per slate, ${slateOuts.length} slates`);
  console.log('================================================================');
  console.log('size | n_combos | median actual% | pool med pred% | GBM med pred% | pool med relErr | GBM med relErr | pool wins | GBM wins');
  for (const size of [2, 3, 4, 5]) {
    const all: ChalkRecord[] = []; for (const s of slateOuts) for (const r of s.bySize[size] || []) all.push(r);
    if (!all.length) continue;
    const actuals = all.map(r => r.actualPct).sort((a, b) => a - b);
    const poolPreds = all.map(r => r.poolPredPct).sort((a, b) => a - b);
    const gbmPreds = all.map(r => r.gbmPredPct).sort((a, b) => a - b);
    const poolRelErr = all.map(r => r.actualPct > 0 ? Math.abs(r.poolPredPct - r.actualPct) / r.actualPct : 0).sort((a, b) => a - b);
    const gbmRelErr = all.map(r => r.actualPct > 0 ? Math.abs(r.gbmPredPct - r.actualPct) / r.actualPct : 0).sort((a, b) => a - b);
    const gbmWins = all.filter(r => Math.abs(r.gbmPredPct - r.actualPct) < Math.abs(r.poolPredPct - r.actualPct)).length;
    console.log(`  ${size}  | ${String(all.length).padStart(7)} | ${actuals[Math.floor(actuals.length / 2)].toFixed(2).padStart(13)}% | ${poolPreds[Math.floor(poolPreds.length / 2)].toFixed(2).padStart(13)}% | ${gbmPreds[Math.floor(gbmPreds.length / 2)].toFixed(2).padStart(12)}% | ${(poolRelErr[Math.floor(poolRelErr.length / 2)] * 100).toFixed(0).padStart(13)}% | ${(gbmRelErr[Math.floor(gbmRelErr.length / 2)] * 100).toFixed(0).padStart(12)}% | ${(all.length - gbmWins).toString().padStart(7)} | ${gbmWins.toString().padStart(7)}`);
  }

  // Per-slate breakdown.
  console.log('\n================================================================');
  console.log('PER-SLATE — size-4 chalk (top-10 by actual%)');
  console.log('================================================================');
  console.log('slate          | size | median actual% | pool med pred% | GBM med pred% | pool relErr | GBM relErr');
  for (const s of slateOuts) {
    for (const size of [2, 3, 4, 5]) {
      const recs = s.bySize[size]; if (!recs || !recs.length) continue;
      const acts = recs.map(r => r.actualPct).sort((a, b) => a - b);
      const polls = recs.map(r => r.poolPredPct).sort((a, b) => a - b);
      const gbms = recs.map(r => r.gbmPredPct).sort((a, b) => a - b);
      const pRel = recs.map(r => r.actualPct > 0 ? Math.abs(r.poolPredPct - r.actualPct) / r.actualPct : 0).sort((a, b) => a - b);
      const gRel = recs.map(r => r.actualPct > 0 ? Math.abs(r.gbmPredPct - r.actualPct) / r.actualPct : 0).sort((a, b) => a - b);
      if (size !== 4) continue;  // only show size-4 detail to keep readable
      console.log(`${s.slate.padEnd(14)} | ${size}    | ${acts[Math.floor(acts.length / 2)].toFixed(2).padStart(13)}% | ${polls[Math.floor(polls.length / 2)].toFixed(2).padStart(13)}% | ${gbms[Math.floor(gbms.length / 2)].toFixed(2).padStart(12)}% | ${(pRel[Math.floor(pRel.length / 2)] * 100).toFixed(0).padStart(9)}% | ${(gRel[Math.floor(gRel.length / 2)] * 100).toFixed(0).padStart(8)}%`);
    }
  }
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
