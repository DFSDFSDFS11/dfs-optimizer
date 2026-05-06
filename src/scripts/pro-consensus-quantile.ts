/**
 * Phase 1: Distribution-based consensus signature.
 *
 * Replace each scalar slate-relative metric with a 5-element quantile vector
 * (p10, p25, p50, p75, p90) computed across each pro's 150 lineups per slate.
 *
 * Then:
 *   1. Build per-slate consensus = mean+std of each quantile across pros
 *   2. Compute Hermes's quantile vectors per slate via productionSelect
 *   3. Compute Mahalanobis distance against the enriched signature
 *   4. Compare to the scalar Hermes distance (d=1.24)
 *
 * If Hermes still shows d<1.3, validation is more robust.
 * If distance increases significantly, scalar version was missing distribution shape.
 *
 * Metrics (now per-lineup distributions, not portfolio aggregates):
 *   - lineupOwn:        per-lineup mean ownership of 10 players (5-vec quantiles)
 *   - lineupProjRatio:  per-lineup total projection / max field lineup projection
 *   - lineupCeilRatio:  per-lineup total ceiling / max field lineup ceiling
 *   - lineupOwnStd:     per-lineup intra-lineup ownership stddev / slate avg own
 *   - lineupOwnPctile:  per-lineup avg player ownership-percentile-rank
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
const QUANTILES = [0.10, 0.25, 0.50, 0.75, 0.90];
const METRICS = ['lineupOwn', 'lineupProjRatio', 'lineupCeilRatio', 'lineupOwnStd', 'lineupOwnPctile'] as const;

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

const PROS = [
  { label: 'nerdytenor', tokens: ['nerdytenor'] },
  { label: 'zroth', tokens: ['zroth', 'zroth2'] },
  { label: 'youdacao', tokens: ['youdacao'] },
  { label: 'shipmymoney', tokens: ['shipmymoney'] },
  { label: 'shaidyadvice', tokens: ['shaidyadvice'] },
  { label: 'bgreseth', tokens: ['bgreseth'] },
  { label: 'needlunchmoney', tokens: ['needlunchmoney'] },
];

const HERMES = {
  lambda: 0.58, gamma: 6, tc: 0.20, mps: 4, me: 0.21, mep: 0.45, corner: true,
  comboPower: 4, fl: 0.00,
  bins: { chalk: 0.00, core: 0.15, value: 0.75, contra: 0.10, deep: 0.00 },
};

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function mean(a: number[]): number { if (!a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; }
function stddev(a: number[]): number { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); }
function quantiles(arr: number[], qs: number[]): number[] {
  const sorted = [...arr].sort((a, b) => a - b);
  return qs.map(q => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]);
}

interface SlateContext {
  optProj: number;
  optCeil: number;
  slateAvgOwn: number;
  ownPctile: Map<string, number>;
}

function buildSlateContext(players: Player[], fieldLineups: Player[][]): SlateContext {
  let optProj = 0, optCeil = 0;
  for (const lu of fieldLineups) {
    let p = 0, c = 0;
    for (const pl of lu) {
      p += pl.projection || 0;
      c += (pl as any).ceiling || (pl.projection || 0) * 1.4;
    }
    if (p > optProj) optProj = p;
    if (c > optCeil) optCeil = c;
  }
  const slateAvgOwn = mean(players.map(p => p.ownership || 0));
  const ownPctile = new Map<string, number>();
  const sortedByOwn = [...players].sort((a, b) => (a.ownership || 0) - (b.ownership || 0));
  for (let i = 0; i < sortedByOwn.length; i++) {
    ownPctile.set(sortedByOwn[i].id, sortedByOwn.length > 1 ? i / (sortedByOwn.length - 1) : 0);
  }
  return { optProj, optCeil, slateAvgOwn, ownPctile };
}

// Compute per-lineup distributions for a portfolio. Returns 5 quantile vectors.
function computeLineupDistributions(lineups: Player[][], ctx: SlateContext): Record<string, number[]> {
  const ownArr: number[] = [], projRatioArr: number[] = [], ceilRatioArr: number[] = [], ownStdArr: number[] = [], pctileArr: number[] = [];
  for (const players of lineups) {
    const owns = players.map(p => p.ownership || 0);
    const lineupMeanOwn = mean(owns);
    const lineupProj = players.reduce((s, p) => s + (p.projection || 0), 0);
    const lineupCeil = players.reduce((s, p) => s + ((p as any).ceiling || (p.projection || 0) * 1.4), 0);
    const lineupOwnStd = stddev(owns);
    let pSum = 0;
    for (const p of players) pSum += ctx.ownPctile.get(p.id) || 0;
    const lineupPctile = pSum / players.length;

    ownArr.push(lineupMeanOwn);
    projRatioArr.push(ctx.optProj > 0 ? lineupProj / ctx.optProj : 0);
    ceilRatioArr.push(ctx.optCeil > 0 ? lineupCeil / ctx.optCeil : 0);
    ownStdArr.push(ctx.slateAvgOwn > 0 ? lineupOwnStd / ctx.slateAvgOwn : 0);
    pctileArr.push(lineupPctile);
  }
  return {
    lineupOwn: quantiles(ownArr, QUANTILES),
    lineupProjRatio: quantiles(projRatioArr, QUANTILES),
    lineupCeilRatio: quantiles(ceilRatioArr, QUANTILES),
    lineupOwnStd: quantiles(ownStdArr, QUANTILES),
    lineupOwnPctile: quantiles(pctileArr, QUANTILES),
  };
}

function extractPro(actuals: ContestActuals, nameMap: Map<string, Player>, tokens: string[]): Player[][] {
  const out: Player[][] = [];
  for (const e of actuals.entries) {
    const en = (e.entryName || '').toLowerCase();
    if (!tokens.some(t => en.includes(t))) continue;
    const pls: Player[] = []; let ok = true;
    for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
    if (ok) out.push(pls);
  }
  return out;
}

async function main() {
  console.log('================================================================');
  console.log('PHASE 1: Distribution-based consensus + Hermes re-validation');
  console.log('  5 metrics × 5 quantiles = 25-feature signature per slate');
  console.log('================================================================\n');

  // For each slate: compute slate context, extract pros, compute pro per-lineup distributions
  // Also: compute Hermes's per-lineup distributions
  const slateProQuantiles: Map<string, Map<string, Record<string, number[]>>> = new Map();
  const slateHermesQuantiles: Map<string, Record<string, number[]>> = new Map();
  const proCoverage: Record<string, number> = {};
  for (const p of PROS) proCoverage[p.label] = 0;

  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj), actualsPath = path.join(DIR, s.actuals), poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) { console.log('  ' + s.slate + ': MISSING'); continue; }
    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);
    const idMap = new Map<string, Player>(); const nameMap = new Map<string, Player>();
    for (const p of pool.players) { idMap.set(p.id, p); nameMap.set(norm(p.name), p); }
    const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });

    // Build field lineups for ctx
    const fieldLineups: Player[][] = [];
    for (const e of actuals.entries) {
      const pls: Player[] = []; let ok = true;
      for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
      if (ok) fieldLineups.push(pls);
    }
    const ctx = buildSlateContext(pool.players, fieldLineups);

    // Pro quantiles
    const proMap = new Map<string, Record<string, number[]>>();
    const counts: string[] = [];
    for (const p of PROS) {
      const lus = extractPro(actuals, nameMap, p.tokens);
      counts.push(p.label.slice(0, 8) + '=' + lus.length);
      if (lus.length >= 30) {
        proMap.set(p.label, computeLineupDistributions(lus, ctx));
        proCoverage[p.label]++;
      }
    }
    slateProQuantiles.set(s.slate, proMap);

    // Hermes quantiles
    const comboFreq = precomputeComboFrequencies(loaded.lineups, HERMES.comboPower);
    const result = productionSelect(loaded.lineups, pool.players, {
      N, lambda: HERMES.lambda, comboFreq, maxOverlap: HERMES.gamma,
      teamCapPct: HERMES.tc, minPrimaryStack: HERMES.mps,
      maxExposure: HERMES.me, maxExposurePitcher: HERMES.mep,
      extremeCornerCap: HERMES.corner, projectionFloorPct: HERMES.fl,
      binAllocation: HERMES.bins,
    });
    const hLineups: Player[][] = result.portfolio.map(lu => lu.players);
    slateHermesQuantiles.set(s.slate, computeLineupDistributions(hLineups, ctx));
    console.log('  ' + s.slate.padEnd(15) + ' field=' + fieldLineups.length + ' hermes=' + hLineups.length + ' | ' + counts.join(' '));
  }

  console.log('\nPro coverage:');
  for (const p of PROS) console.log('  ' + p.label.padEnd(18) + ' ' + proCoverage[p.label] + ' slates');
  const validPros = PROS.filter(p => proCoverage[p.label] >= 8);

  // For each (slate, metric, quantile-index): consensus = mean of pros' quantile values, std = stddev across pros
  // Mahalanobis distance for Hermes: sum over (slate, metric, quantile) of ((hermes_q - cons_mean) / cons_std)^2
  console.log('\n================================================================');
  console.log('CONSENSUS — per-slate per-metric quantile means (sanity check)');
  console.log('================================================================');
  for (const m of METRICS) {
    console.log('\n' + m + ':');
    console.log('  slate           | p10        p25        p50        p75        p90      (mean ± std across pros)');
    for (const sl of SLATES.map(s => s.slate)) {
      const pm = slateProQuantiles.get(sl); if (!pm) continue;
      const proVecs: number[][] = [];
      for (const p of validPros) {
        const v = pm.get(p.label); if (v) proVecs.push(v[m]);
      }
      if (proVecs.length < 3) continue;
      let row = '  ' + sl.padEnd(15) + ' | ';
      for (let qi = 0; qi < QUANTILES.length; qi++) {
        const vals = proVecs.map(v => v[qi]);
        const mu = mean(vals), sd = stddev(vals);
        row += (mu.toFixed(3) + '±' + sd.toFixed(3)).padStart(13);
      }
      console.log(row);
    }
  }

  // Hermes Mahalanobis distance against quantile consensus
  console.log('\n================================================================');
  console.log('HERMES vs DISTRIBUTION-BASED CONSENSUS');
  console.log('================================================================\n');
  const slateDists: { slate: string; dist: number; perMetric: Record<string, number> }[] = [];
  for (const sl of SLATES.map(s => s.slate)) {
    const pm = slateProQuantiles.get(sl); if (!pm) continue;
    const hQ = slateHermesQuantiles.get(sl); if (!hQ) continue;
    let totalSq = 0, n = 0;
    const perMetric: Record<string, number> = {};
    for (const m of METRICS) {
      const proVecs: number[][] = [];
      for (const p of validPros) {
        const v = pm.get(p.label); if (v) proVecs.push(v[m]);
      }
      if (proVecs.length < 3) continue;
      let metricSq = 0, metricN = 0;
      for (let qi = 0; qi < QUANTILES.length; qi++) {
        const vals = proVecs.map(v => v[qi]);
        const mu = mean(vals), sd = stddev(vals);
        if (sd < 1e-9) continue;
        const z = (hQ[m][qi] - mu) / sd;
        metricSq += z * z; metricN++;
        totalSq += z * z; n++;
      }
      perMetric[m] = metricN > 0 ? Math.sqrt(metricSq / metricN) : 0;
    }
    const slDist = n > 0 ? Math.sqrt(totalSq / n) : 0;
    slateDists.push({ slate: sl, dist: slDist, perMetric });
  }

  console.log('Slate           | own     proj    ceil    ownStd  pctile  | overall');
  for (const r of slateDists) {
    let row = '  ' + r.slate.padEnd(15) + ' | ';
    for (const m of METRICS) row += (r.perMetric[m] || 0).toFixed(2).padStart(7);
    row += '  | ' + r.dist.toFixed(2);
    console.log(row);
  }
  const meanDist = mean(slateDists.map(r => r.dist));
  console.log('\nHERMES MEAN MAHALANOBIS DISTANCE (quantile-based): ' + meanDist.toFixed(2));
  console.log('  (scalar-based was 1.24)');
  console.log('\nGate: dist < 1.5 (cluster zone)? ' + (meanDist < 1.5 ? '✅ PASS' : '❌ FAIL'));
  console.log('Gate: dist < 1.3 (top cluster)?  ' + (meanDist < 1.3 ? '✅ PASS' : '❌ FAIL'));

  // Per-metric mean distance summary
  console.log('\nPer-metric mean Hermes distance across slates:');
  for (const m of METRICS) {
    const vals = slateDists.map(r => r.perMetric[m] || 0);
    console.log('  ' + m.padEnd(20) + ' mean=' + mean(vals).toFixed(2) + ' max=' + Math.max(...vals).toFixed(2));
  }

  // Save consensus
  const consensus: any = { metrics: {}, pros: validPros.map(p => p.label) };
  for (const m of METRICS) {
    consensus.metrics[m] = [];
    for (const sl of SLATES.map(s => s.slate)) {
      const pm = slateProQuantiles.get(sl); if (!pm) continue;
      const proVecs: number[][] = [];
      for (const p of validPros) {
        const v = pm.get(p.label); if (v) proVecs.push(v[m]);
      }
      if (proVecs.length < 3) continue;
      const meanVec: number[] = [], stdVec: number[] = [];
      for (let qi = 0; qi < QUANTILES.length; qi++) {
        const vals = proVecs.map(v => v[qi]);
        meanVec.push(mean(vals)); stdVec.push(stddev(vals));
      }
      consensus.metrics[m].push({ slate: sl, mean: meanVec, std: stdVec });
    }
  }
  fs.writeFileSync(path.join(DIR, 'pro_consensus_quantile.json'), JSON.stringify(consensus, null, 0));
  console.log('\nQuantile consensus saved.');
}

main().catch(e => { console.error(e); process.exit(1); });
