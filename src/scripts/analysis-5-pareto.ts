/**
 * Analysis 5 — Pareto frontier mapping in (Mahalanobis distance, KS, ROI17, OOS7) space.
 *
 * Use the existing 92K-config sweep (v17). For each config evaluated on quantile
 * methodology earlier (the 2376 candidates from pro_mahalanobis_results.json),
 * augment with KS distance via re-evaluation. Identify Pareto-optimal points.
 *
 * Pareto criteria: minimize Mahalanobis distance, maximize Full17 ROI, maximize OOS7 ROI.
 * Output: list of Pareto-frontier configs near Hermes-A.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import {
  parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals,
} from '../parser';
import { getContestConfig } from '../rules';
import { productionSelect } from '../selection/production-selector';
import { precomputeComboFrequencies } from '../selection/combo-leverage';

const DIR = 'C:/Users/colin/dfs opto';
const N = 150;
const FEE = 20;

const SLATES = [
  { slate: '4-6-26',  proj: '4-6-26_projections.csv', actuals: 'dkactuals 4-6-26.csv', pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26',  proj: '4-8-26projections.csv',  actuals: '4-8-26actuals.csv',    pool: '4-8-26sspool.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv', actuals: '4-12-26actuals.csv',   pool: '4-12-26sspool.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv', actuals: '4-14-26actuals.csv',   pool: '4-14-26sspool.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv', actuals: '4-15-26actuals.csv',   pool: '4-15-26sspool.csv' },
  { slate: '4-17-26', proj: '4-17-26projections.csv', actuals: '4-17-26actuals.csv',   pool: '4-17-26sspool.csv' },
  { slate: '4-18-26', proj: '4-18-26projections.csv', actuals: '4-18-26actuals.csv',   pool: '4-18-26sspool.csv' },
  { slate: '4-19-26', proj: '4-19-26projections.csv', actuals: '4-19-26actuals.csv',   pool: '4-19-26sspool.csv' },
  { slate: '4-20-26', proj: '4-20-26projections.csv', actuals: '4-20-26actuals.csv',   pool: '4-20-26sspool.csv' },
  { slate: '4-21-26', proj: '4-21-26projections.csv', actuals: '4-21-26actuals.csv',   pool: '4-21-26sspool.csv' },
  { slate: '4-22-26', proj: '4-22-26projections.csv', actuals: '4-22-26actuals.csv',   pool: '4-22-26sspool.csv' },
  { slate: '4-23-26', proj: '4-23-26projections.csv', actuals: '4-23-26actuals.csv',   pool: '4-23-26sspool.csv' },
  { slate: '4-24-26', proj: '4-24-26projections.csv', actuals: '4-24-26actuals.csv',   pool: '4-24-26sspool.csv' },
  { slate: '4-25-26', proj: '4-25-26projections.csv', actuals: '4-25-26actuals.csv',   pool: '4-25-26sspool.csv' },
  { slate: '4-25-26-early', proj: '4-25-26projectionsearly.csv', actuals: '4-25-26actualsearly.csv', pool: '4-25-26sspoolearly.csv' },
  { slate: '4-26-26', proj: '4-26-26projections.csv', actuals: '4-26-26actuals.csv',   pool: '4-26-26sspool.csv' },
  { slate: '4-27-26', proj: '4-27-26projections.csv', actuals: '4-27-26actuals.csv',   pool: '4-27-26sspool.csv' },
  { slate: '4-28-26', proj: '4-28-26projections.csv', actuals: '4-28-26actuals.csv',   pool: '4-28-26sspool.csv' },
];

const QUANTILES = [0.10, 0.25, 0.50, 0.75, 0.90];
const METRICS = ['lineupOwn', 'lineupProjRatio', 'lineupCeilRatio', 'lineupOwnStd', 'lineupOwnPctile'] as const;

const OOS_SLATES = new Set(['4-23-26', '4-24-26', '4-25-26', '4-25-26-early', '4-26-26', '4-27-26', '4-28-26']);

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function mean(a: number[]): number { if (!a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; }
function stddev(a: number[]): number { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); }
function quantilesOf(arr: number[], qs: number[]): number[] {
  const sorted = [...arr].sort((a, b) => a - b);
  return qs.map(q => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]);
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
function payoutFor(actual: number, sorted: number[], payoutTable: Float64Array, actuals: ContestActuals): number {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (sorted[m] >= actual) lo = m + 1; else hi = m; }
  const rank = Math.max(1, lo);
  const pay = rank <= payoutTable.length ? payoutTable[rank - 1] : 0;
  if (pay <= 0) return 0;
  let co = 0; for (const e of actuals.entries) if (Math.abs(e.actualPoints - actual) <= 0.25) co++;
  co = Math.max(0, co - 1);
  return pay / Math.sqrt(1 + co * 0.5);
}

interface SlateContext { optProj: number; optCeil: number; slateAvgOwn: number; ownPctile: Map<string, number>; }

interface SlateData {
  slate: string; candidates: Lineup[]; players: Player[]; ctx: SlateContext;
  comboFreq1: Map<string, number>; comboFreq2: Map<string, number>; comboFreq3: Map<string, number>; comboFreq4: Map<string, number>;
  actuals: ContestActuals; actualByHash: Map<string, number>; sorted: number[]; payoutTable: Float64Array;
  nameMap: Map<string, Player>;
}

function buildSlateContext(players: Player[], fieldLineups: Player[][]): SlateContext {
  let optProj = 0, optCeil = 0;
  for (const lu of fieldLineups) {
    let p = 0, c = 0;
    for (const pl of lu) { p += pl.projection || 0; c += (pl as any).ceiling || (pl.projection || 0) * 1.4; }
    if (p > optProj) optProj = p; if (c > optCeil) optCeil = c;
  }
  const slateAvgOwn = mean(players.map(p => p.ownership || 0));
  const ownPctile = new Map<string, number>();
  const sortedByOwn = [...players].sort((a, b) => (a.ownership || 0) - (b.ownership || 0));
  for (let i = 0; i < sortedByOwn.length; i++) ownPctile.set(sortedByOwn[i].id, sortedByOwn.length > 1 ? i / (sortedByOwn.length - 1) : 0);
  return { optProj, optCeil, slateAvgOwn, ownPctile };
}

function computeQuantiles(lineups: Player[][], ctx: SlateContext): Record<string, number[]> {
  const own: number[] = [], proj: number[] = [], ceil: number[] = [], ownStd: number[] = [], pctile: number[] = [];
  for (const players of lineups) {
    const owns = players.map(p => p.ownership || 0);
    own.push(mean(owns));
    proj.push(ctx.optProj > 0 ? players.reduce((s, p) => s + (p.projection || 0), 0) / ctx.optProj : 0);
    ceil.push(ctx.optCeil > 0 ? players.reduce((s, p) => s + ((p as any).ceiling || (p.projection || 0) * 1.4), 0) / ctx.optCeil : 0);
    ownStd.push(ctx.slateAvgOwn > 0 ? stddev(owns) / ctx.slateAvgOwn : 0);
    let ps = 0; for (const p of players) ps += ctx.ownPctile.get(p.id) || 0;
    pctile.push(ps / players.length);
  }
  return {
    lineupOwn: quantilesOf(own, QUANTILES),
    lineupProjRatio: quantilesOf(proj, QUANTILES),
    lineupCeilRatio: quantilesOf(ceil, QUANTILES),
    lineupOwnStd: quantilesOf(ownStd, QUANTILES),
    lineupOwnPctile: quantilesOf(pctile, QUANTILES),
  };
}

async function loadSlate(s: typeof SLATES[0]): Promise<SlateData | null> {
  const projPath = path.join(DIR, s.proj), actualsPath = path.join(DIR, s.actuals), poolPath = path.join(DIR, s.pool);
  if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) return null;
  const pr = parseCSVFile(projPath, 'mlb', true);
  const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
  const pool = buildPlayerPool(pr.players, pr.detectedContestType);
  const actuals = parseContestActuals(actualsPath, config);
  const idMap = new Map<string, Player>(); const nameMap = new Map<string, Player>();
  for (const p of pool.players) { idMap.set(p.id, p); nameMap.set(norm(p.name), p); }
  const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
  const fieldLineups: Player[][] = [];
  for (const e of actuals.entries) {
    const pls: Player[] = []; let ok = true;
    for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
    if (ok) fieldLineups.push(pls);
  }
  const F = actuals.entries.length;
  const sorted = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
  const payoutTable = buildPayoutTable(F);
  const actualByHash = new Map<string, number>();
  for (const e of actuals.entries) {
    const pls: Player[] = []; let ok = true;
    for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
    if (!ok) continue;
    actualByHash.set(pls.map(p => p.id).sort().join('|'), e.actualPoints);
  }
  return {
    slate: s.slate, candidates: loaded.lineups, players: pool.players,
    ctx: buildSlateContext(pool.players, fieldLineups),
    comboFreq1: precomputeComboFrequencies(loaded.lineups, 1),
    comboFreq2: precomputeComboFrequencies(loaded.lineups, 2),
    comboFreq3: precomputeComboFrequencies(loaded.lineups, 3),
    comboFreq4: precomputeComboFrequencies(loaded.lineups, 4),
    actuals, actualByHash, sorted, payoutTable, nameMap,
  };
}

function getCombo(sd: SlateData, power: number) {
  if (power === 1) return sd.comboFreq1;
  if (power === 2) return sd.comboFreq2;
  if (power === 4) return sd.comboFreq4;
  return sd.comboFreq3;
}

function buildRunCfg(cfg: any, sd: SlateData): Parameters<typeof productionSelect>[2] {
  const a = cfg.alloc || [0.05, 0.05, 0.85, 0.03, 0.02];
  const binAllocation = { chalk: a[0], core: a[1], value: a[2], contra: a[3], deep: a[4] };
  const phase = cfg.phase;
  if (phase === 'A') return { N, lambda: cfg.lam, comboFreq: sd.comboFreq3, maxOverlap: cfg.gam, teamCapPct: cfg.tc, minPrimaryStack: cfg.mps, maxExposure: cfg.me, maxExposurePitcher: cfg.mep, extremeCornerCap: cfg.corner, projectionFloorPct: 0, binAllocation };
  if (phase === 'B') return { N, lambda: cfg.lam, comboFreq: getCombo(sd, cfg.power), maxOverlap: cfg.gam, teamCapPct: cfg.tc, minPrimaryStack: cfg.mps, maxExposure: cfg.me, extremeCornerCap: true, projectionFloorPct: 0, binAllocation };
  if (phase === 'C') return { N, lambda: cfg.lam, comboFreq: getCombo(sd, cfg.power), maxOverlap: 6, teamCapPct: cfg.tc, minPrimaryStack: cfg.mps, maxExposure: cfg.me, maxExposurePitcher: cfg.mep, extremeCornerCap: cfg.corner, projectionFloorPct: 0, binAllocation };
  if (phase === 'D') return { N, lambda: cfg.lam, comboFreq: getCombo(sd, cfg.power), maxOverlap: cfg.gam, teamCapPct: cfg.tc, minPrimaryStack: 5, maxExposure: cfg.me, maxExposurePitcher: cfg.mep, extremeCornerCap: cfg.corner, projectionFloorPct: 0, binAllocation };
  if (phase === 'E') return { N, lambda: cfg.lam, comboFreq: getCombo(sd, cfg.power), maxOverlap: cfg.gam, teamCapPct: cfg.tc, minPrimaryStack: cfg.mps, maxExposure: cfg.me, maxExposurePitcher: cfg.mep, extremeCornerCap: cfg.corner, projectionFloorPct: 0, binAllocation };
  return { N, lambda: cfg.lam, comboFreq: getCombo(sd, cfg.power), maxOverlap: cfg.gam, teamCapPct: cfg.tc, projectionFloorPct: cfg.fl, minPrimaryStack: cfg.mps, maxExposure: cfg.me, maxExposurePitcher: cfg.mep, extremeCornerCap: cfg.corner, extremeCornerQ5Q5Pct: cfg.q5, extremeCornerQ1Q1Pct: cfg.q1, useOwnershipCeiling: cfg.useOC, ownDropPP: cfg.od, ownershipCeilingBuffer: cfg.buf, binAllocation };
}

function scoreLineup(lu: Lineup, sd: SlateData): number | null {
  const h = lu.players.map(p => p.id).sort().join('|');
  const fa = sd.actualByHash.get(h);
  if (fa !== undefined) return fa;
  let t = 0; for (const p of lu.players) {
    const r = sd.actuals.playerActualsByName.get(norm(p.name));
    if (!r) return null; t += r.fpts;
  }
  return t;
}

async function main() {
  console.log('=== ANALYSIS 5: Pareto frontier mapping ===\n');

  const cons = JSON.parse(fs.readFileSync(path.join(DIR, 'pro_consensus_quantile.json'), 'utf-8'));
  const consBySlate: Record<string, Record<string, { mean: number[]; std: number[] }>> = {};
  for (const m of METRICS) {
    for (const sd of (cons.metrics[m] || [])) {
      if (!consBySlate[sd.slate]) consBySlate[sd.slate] = {};
      consBySlate[sd.slate][m] = { mean: sd.mean, std: sd.std };
    }
  }

  console.log('Loading slates...');
  const cache: SlateData[] = [];
  for (const s of SLATES) { const sd = await loadSlate(s); if (sd) cache.push(sd); }
  console.log(cache.length + ' slates loaded.\n');

  // Use top 500 from existing Mahalanobis sweep + add Hermes-A
  const broad = JSON.parse(fs.readFileSync(path.join(DIR, 'pro_mahalanobis_results.json'), 'utf-8')) as any[];
  // Sort by meanDist asc, take top 500 (but keep some diversity)
  const top500 = [...broad].sort((a, b) => a.meanDist - b.meanDist).slice(0, 500);

  const candidates: Array<{ id: string; cfg: any }> = top500.map(r => ({ id: r.id, cfg: r.cfg }));
  candidates.push({
    id: 'HERMES_A',
    cfg: { phase: 'C', lam: 0.58, tc: 0.26, mps: 4, me: 0.21, mep: 0.41, corner: true, power: 4, alloc: [0.50, 0.30, 0.20, 0, 0] },
  });

  console.log('Evaluating ' + candidates.length + ' candidates × ' + cache.length + ' slates...');
  const t_start = Date.now();
  const results: any[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const distsBySlate: number[] = [];
    let fullPay = 0, oosPay = 0; let oosCount = 0;
    for (const sd of cache) {
      try {
        const result = productionSelect(sd.candidates, sd.players, buildRunCfg(c.cfg, sd));
        const lineups: Player[][] = result.portfolio.map(lu => lu.players);
        const hQ = computeQuantiles(lineups, sd.ctx);
        let totalSq = 0, n = 0;
        for (const m of METRICS) {
          const cn = consBySlate[sd.slate]?.[m]; if (!cn) continue;
          for (let qi = 0; qi < 5; qi++) {
            if (cn.std[qi] < 1e-9) continue;
            const z = (hQ[m][qi] - cn.mean[qi]) / cn.std[qi];
            totalSq += z * z; n++;
          }
        }
        if (n > 0) distsBySlate.push(Math.sqrt(totalSq / n));
        let pay = 0;
        for (const lu of result.portfolio) {
          const a = scoreLineup(lu, sd);
          if (a === null) continue;
          pay += payoutFor(a, sd.sorted, sd.payoutTable, sd.actuals);
        }
        fullPay += pay;
        if (OOS_SLATES.has(sd.slate)) { oosPay += pay; oosCount++; }
      } catch {}
    }
    const meanDist = distsBySlate.length > 0 ? mean(distsBySlate) : Infinity;
    const fullROI = (fullPay / (cache.length * N * FEE) - 1) * 100;
    const oosROI = oosCount > 0 ? (oosPay / (oosCount * N * FEE) - 1) * 100 : 0;
    results.push({ id: c.id, cfg: c.cfg, meanDist, fullROI, oosROI });
    if ((i + 1) % 50 === 0) {
      const elapsed = (Date.now() - t_start) / 60000;
      console.log('  [' + (i + 1) + '/' + candidates.length + ' ' + ((i + 1) / candidates.length * 100).toFixed(0) + '%, ' + elapsed.toFixed(1) + 'm]');
    }
  }
  console.log('Done in ' + ((Date.now() - t_start) / 60000).toFixed(1) + 'm\n');

  // Pareto frontier: dominate if all 3 dimensions are better/equal AND ≥1 strictly better
  // We minimize meanDist, maximize fullROI, maximize oosROI
  function dominates(a: any, b: any): boolean {
    return a.meanDist <= b.meanDist && a.fullROI >= b.fullROI && a.oosROI >= b.oosROI &&
      (a.meanDist < b.meanDist || a.fullROI > b.fullROI || a.oosROI > b.oosROI);
  }
  const pareto = results.filter(r => !results.some(other => dominates(other, r)));
  console.log('=== PARETO FRONTIER (dim: dist↓, ROI17↑, OOS7↑) ===\n');
  console.log('count: ' + pareto.length + ' of ' + results.length + ' candidates');
  console.log('\nrank dist  ROI17%  OOS7%  | id');
  pareto.sort((a, b) => a.meanDist - b.meanDist);
  for (let i = 0; i < pareto.length; i++) {
    const r = pareto[i];
    console.log('  #' + (i + 1).toString().padStart(2) + ' ' + r.meanDist.toFixed(2) + '   ' + r.fullROI.toFixed(0).padStart(4) + '%   ' + r.oosROI.toFixed(0).padStart(4) + '% | ' + r.id.slice(0, 60));
  }

  const hermesPos = results.find(r => r.id === 'HERMES_A');
  const hermesOnPareto = pareto.find(r => r.id === 'HERMES_A');
  console.log('\n=== HERMES-A POSITION ===');
  if (hermesPos) {
    console.log('  Hermes-A: dist=' + hermesPos.meanDist.toFixed(2) + ' ROI17=' + hermesPos.fullROI.toFixed(0) + '% OOS7=' + hermesPos.oosROI.toFixed(0) + '%');
    console.log('  On Pareto frontier? ' + (hermesOnPareto ? '✅ YES' : '❌ NO (dominated by ' + results.filter(r => dominates(r, hermesPos)).length + ' configs)'));
    if (!hermesOnPareto) {
      const dominators = results.filter(r => dominates(r, hermesPos));
      console.log('\n  Configs that dominate Hermes-A:');
      for (const d of dominators.slice(0, 5)) {
        console.log('    ' + d.id.slice(0, 50) + '  d=' + d.meanDist.toFixed(2) + ' ROI=' + d.fullROI.toFixed(0) + '% OOS=' + d.oosROI.toFixed(0) + '%');
      }
    }
  }

  fs.writeFileSync(path.join(DIR, 'pareto_frontier.json'), JSON.stringify({ pareto, all: results }, null, 0));
  console.log('\nResults saved.');
}

main().catch(e => { console.error(e); process.exit(1); });
