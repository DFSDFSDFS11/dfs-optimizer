/**
 * Hermes per-quantile breakdown: identifies WHICH part of the lineup distribution
 * Hermes diverges from pros on. Diagnoses whether Hermes is tighter (concentrated
 * around mean), wider, or shape-shifted.
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
const QLABELS = ['p10', 'p25', 'p50', 'p75', 'p90'];
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

const HERMES_V1 = {
  lambda: 0.58, gamma: 6, tc: 0.20, mps: 4, me: 0.21, mep: 0.45, corner: true,
  comboPower: 4, fl: 0.00,
  bins: { chalk: 0.50, core: 0.30, value: 0.20, contra: 0.00, deep: 0.00 },  // fall-through reliance
};
const HERMES_V2 = {
  lambda: 0.58, gamma: 6, tc: 0.20, mps: 4, me: 0.21, mep: 0.45, corner: true,
  comboPower: 4, fl: 0.00,
  bins: { chalk: 0.00, core: 0.15, value: 0.75, contra: 0.10, deep: 0.00 },  // explicit value-target
};
const HERMES = HERMES_V1;  // testing V1 to compare distribution vs V2

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function mean(a: number[]): number { if (!a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; }
function stddev(a: number[]): number { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); }
function quantiles(arr: number[], qs: number[]): number[] {
  const sorted = [...arr].sort((a, b) => a - b);
  return qs.map(q => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]);
}

interface SlateContext {
  optProj: number; optCeil: number; slateAvgOwn: number; ownPctile: Map<string, number>;
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

function computeLineupQuantiles(lineups: Player[][], ctx: SlateContext): Record<string, number[]> {
  const ownArr: number[] = [], projRatioArr: number[] = [], ceilRatioArr: number[] = [], ownStdArr: number[] = [], pctileArr: number[] = [];
  for (const players of lineups) {
    const owns = players.map(p => p.ownership || 0);
    ownArr.push(mean(owns));
    projRatioArr.push(ctx.optProj > 0 ? players.reduce((s, p) => s + (p.projection || 0), 0) / ctx.optProj : 0);
    ceilRatioArr.push(ctx.optCeil > 0 ? players.reduce((s, p) => s + ((p as any).ceiling || (p.projection || 0) * 1.4), 0) / ctx.optCeil : 0);
    ownStdArr.push(ctx.slateAvgOwn > 0 ? stddev(owns) / ctx.slateAvgOwn : 0);
    let ps = 0; for (const p of players) ps += ctx.ownPctile.get(p.id) || 0;
    pctileArr.push(ps / players.length);
  }
  return {
    lineupOwn: quantiles(ownArr, QUANTILES),
    lineupProjRatio: quantiles(projRatioArr, QUANTILES),
    lineupCeilRatio: quantiles(ceilRatioArr, QUANTILES),
    lineupOwnStd: quantiles(ownStdArr, QUANTILES),
    lineupOwnPctile: quantiles(pctileArr, QUANTILES),
  };
}

async function main() {
  console.log('================================================================');
  console.log('HERMES per-quantile breakdown vs pro consensus');
  console.log('================================================================\n');

  const cons = JSON.parse(fs.readFileSync(path.join(DIR, 'pro_consensus_quantile.json'), 'utf-8'));
  const consBySlate: Record<string, Record<string, { mean: number[]; std: number[] }>> = {};
  for (const m of METRICS) {
    for (const sd of (cons.metrics[m] || [])) {
      if (!consBySlate[sd.slate]) consBySlate[sd.slate] = {};
      consBySlate[sd.slate][m] = { mean: sd.mean, std: sd.std };
    }
  }

  // Compute Hermes quantiles per slate
  const hermesQ: Record<string, Record<string, number[]>> = {};
  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj), actualsPath = path.join(DIR, s.actuals), poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) continue;
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
    const ctx = buildSlateContext(pool.players, fieldLineups);
    const comboFreq = precomputeComboFrequencies(loaded.lineups, HERMES.comboPower);
    const result = productionSelect(loaded.lineups, pool.players, {
      N, lambda: HERMES.lambda, comboFreq, maxOverlap: HERMES.gamma,
      teamCapPct: HERMES.tc, minPrimaryStack: HERMES.mps,
      maxExposure: HERMES.me, maxExposurePitcher: HERMES.mep,
      extremeCornerCap: HERMES.corner, projectionFloorPct: HERMES.fl,
      binAllocation: HERMES.bins,
    });
    hermesQ[s.slate] = computeLineupQuantiles(result.portfolio.map(lu => lu.players), ctx);
  }

  // Avg consensus vs avg Hermes per quantile per metric
  console.log('=== AVERAGED ACROSS 18 SLATES — Consensus vs Hermes by quantile ===\n');
  for (const m of METRICS) {
    const consMeans = [0, 0, 0, 0, 0]; const consStds = [0, 0, 0, 0, 0]; const hMeans = [0, 0, 0, 0, 0]; let n = 0;
    for (const sl of Object.keys(consBySlate)) {
      if (!hermesQ[sl] || !consBySlate[sl][m]) continue;
      for (let qi = 0; qi < 5; qi++) {
        consMeans[qi] += consBySlate[sl][m].mean[qi];
        consStds[qi] += consBySlate[sl][m].std[qi];
        hMeans[qi] += hermesQ[sl][m][qi];
      }
      n++;
    }
    for (let qi = 0; qi < 5; qi++) { consMeans[qi] /= n; consStds[qi] /= n; hMeans[qi] /= n; }
    console.log(m + ':');
    console.log('  ' + ['', ...QLABELS].map(l => l.padStart(11)).join('  '));
    console.log('  ' + 'Pros'.padStart(11) + '  ' + consMeans.map(v => v.toFixed(3).padStart(11)).join('  '));
    console.log('  ' + 'Hermes'.padStart(11) + '  ' + hMeans.map(v => v.toFixed(3).padStart(11)).join('  '));
    console.log('  ' + 'Δ (H-P)'.padStart(11) + '  ' + hMeans.map((v, i) => (v - consMeans[i]).toFixed(3).padStart(11)).join('  '));
    console.log('  ' + 'σ-units'.padStart(11) + '  ' + hMeans.map((v, i) => consStds[i] > 0 ? ((v - consMeans[i]) / consStds[i]).toFixed(2).padStart(11) : '-'.padStart(11)).join('  '));
    // Spread comparison
    const consSpread = consMeans[4] - consMeans[0];
    const hSpread = hMeans[4] - hMeans[0];
    console.log('  Spread (p90-p10): pros=' + consSpread.toFixed(3) + '  hermes=' + hSpread.toFixed(3) + '  Δ=' + (hSpread - consSpread).toFixed(3) + ' (negative = Hermes more concentrated)');
    console.log();
  }

  // Show worst slate breakdown (4-25-early which had 10.45σ on pctile)
  console.log('\n=== WORST SLATE BREAKDOWN: 4-25-26-early (lineupOwnPctile σ=10.45) ===');
  const sl = '4-25-26-early';
  if (hermesQ[sl] && consBySlate[sl]) {
    for (const m of METRICS) {
      const c = consBySlate[sl][m]; if (!c) continue;
      console.log(m + ':');
      console.log('  ' + 'Pros'.padStart(8) + '  ' + c.mean.map(v => v.toFixed(3).padStart(9)).join('  '));
      console.log('  ' + 'PStd'.padStart(8) + '  ' + c.std.map(v => v.toFixed(3).padStart(9)).join('  '));
      console.log('  ' + 'Hermes'.padStart(8) + '  ' + hermesQ[sl][m].map(v => v.toFixed(3).padStart(9)).join('  '));
      console.log('  ' + 'σ-units'.padStart(8) + '  ' + hermesQ[sl][m].map((v, i) => c.std[i] > 0 ? ((v - c.mean[i]) / c.std[i]).toFixed(1).padStart(9) : '-'.padStart(9)).join('  '));
      console.log();
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
