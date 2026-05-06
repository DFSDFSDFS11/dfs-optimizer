/**
 * Phase 2-lite + Phase 3: KS-distance per-metric distribution comparison +
 * slate-conditional clustering.
 *
 * Phase 2-lite: Kolmogorov-Smirnov distance between Hermes lineup distributions
 *  and pooled-pro lineup distributions per metric, per slate. KS-distance ranges
 *  0 (identical) to 1 (no overlap). Captures shape divergence in a single number.
 *
 * Phase 3: cluster slates by features (size, F, chalk, optimal proj). For each
 *  slate, compute Hermes V1 quantile-Mahalanobis distance. Identify which slate
 *  characteristics predict high distance.
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
const METRICS = ['lineupOwn', 'lineupProjRatio', 'lineupCeilRatio', 'lineupOwnStd', 'lineupOwnPctile'] as const;
const QUANTILES = [0.10, 0.25, 0.50, 0.75, 0.90];

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
  bins: { chalk: 0.50, core: 0.30, value: 0.20, contra: 0.00, deep: 0.00 },
};

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function mean(a: number[]): number { if (!a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; }
function stddev(a: number[]): number { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); }
function quantilesOf(arr: number[], qs: number[]): number[] {
  const sorted = [...arr].sort((a, b) => a - b);
  return qs.map(q => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]);
}
function pearson(xs: number[], ys: number[]): number {
  const n = xs.length; if (n < 2) return 0;
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; num += dx * dy; dx2 += dx * dx; dy2 += dy * dy; }
  const den = Math.sqrt(dx2 * dy2);
  return den === 0 ? 0 : num / den;
}

// KS-distance: max |F_a(x) - F_b(x)| over all x. Returns 0 (identical) to 1 (disjoint).
function ksDistance(a: number[], b: number[]): number {
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  let maxD = 0, ai = 0, bi = 0;
  while (ai < sa.length && bi < sb.length) {
    const cdfA = (ai + 1) / sa.length;
    const cdfB = (bi + 1) / sb.length;
    const d = Math.abs(cdfA - cdfB);
    if (d > maxD) maxD = d;
    if (sa[ai] < sb[bi]) ai++;
    else if (sa[ai] > sb[bi]) bi++;
    else { ai++; bi++; }
  }
  return maxD;
}

interface SlateContext {
  optProj: number; optCeil: number; slateAvgOwn: number; chalkAnchor: number;
  ownPctile: Map<string, number>;
}

function buildSlateContext(players: Player[], fieldLineups: Player[][]): SlateContext {
  let optProj = 0, optCeil = 0;
  const lineupOwns: number[] = [];
  for (const lu of fieldLineups) {
    let p = 0, c = 0, o = 0;
    for (const pl of lu) {
      p += pl.projection || 0;
      c += (pl as any).ceiling || (pl.projection || 0) * 1.4;
      o += pl.ownership || 0;
    }
    if (p > optProj) optProj = p;
    if (c > optCeil) optCeil = c;
    lineupOwns.push(o / lu.length);
  }
  lineupOwns.sort((a, b) => b - a);
  const chalkAnchor = mean(lineupOwns.slice(0, Math.min(100, lineupOwns.length)));
  const slateAvgOwn = mean(players.map(p => p.ownership || 0));
  const ownPctile = new Map<string, number>();
  const sortedByOwn = [...players].sort((a, b) => (a.ownership || 0) - (b.ownership || 0));
  for (let i = 0; i < sortedByOwn.length; i++) ownPctile.set(sortedByOwn[i].id, sortedByOwn.length > 1 ? i / (sortedByOwn.length - 1) : 0);
  return { optProj, optCeil, slateAvgOwn, chalkAnchor, ownPctile };
}

// Per-lineup raw values (not aggregated)
function computeLineupRawValues(lineups: Player[][], ctx: SlateContext): Record<string, number[]> {
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
  return { lineupOwn: own, lineupProjRatio: proj, lineupCeilRatio: ceil, lineupOwnStd: ownStd, lineupOwnPctile: pctile };
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
  console.log('PHASE 2-lite + PHASE 3: KS distance + slate clustering');
  console.log('================================================================\n');

  // Per-slate features + Hermes/pros raw values + KS distances + Mahalanobis
  const slateRows: Array<{
    slate: string; nTeams: number; F: number; optProj: number; chalkAnchor: number;
    poolSize: number; slateAvgOwn: number;
    ksOwn: number; ksProj: number; ksCeil: number; ksOwnStd: number; ksPctile: number; ksAvg: number;
    mahalDist: number;
  }> = [];

  // Load consensus for Mahalanobis
  const cons = JSON.parse(fs.readFileSync(path.join(DIR, 'pro_consensus_quantile.json'), 'utf-8'));
  const consBySlate: Record<string, Record<string, { mean: number[]; std: number[] }>> = {};
  for (const m of METRICS) {
    for (const sd of (cons.metrics[m] || [])) {
      if (!consBySlate[sd.slate]) consBySlate[sd.slate] = {};
      consBySlate[sd.slate][m] = { mean: sd.mean, std: sd.std };
    }
  }

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
    const teams = new Set(pool.players.map(p => p.team));

    // Pool all pro lineups for this slate
    const allProLineups: Player[][] = [];
    for (const p of PROS) allProLineups.push(...extractPro(actuals, nameMap, p.tokens));
    if (allProLineups.length < 100) continue;
    const proRaw = computeLineupRawValues(allProLineups, ctx);

    // Hermes
    const comboFreq = precomputeComboFrequencies(loaded.lineups, HERMES.comboPower);
    const result = productionSelect(loaded.lineups, pool.players, {
      N, lambda: HERMES.lambda, comboFreq, maxOverlap: HERMES.gamma,
      teamCapPct: HERMES.tc, minPrimaryStack: HERMES.mps,
      maxExposure: HERMES.me, maxExposurePitcher: HERMES.mep,
      extremeCornerCap: HERMES.corner, projectionFloorPct: HERMES.fl,
      binAllocation: HERMES.bins,
    });
    const hLineups: Player[][] = result.portfolio.map(lu => lu.players);
    const hRaw = computeLineupRawValues(hLineups, ctx);

    // KS distances per metric
    const ksOwn = ksDistance(hRaw.lineupOwn, proRaw.lineupOwn);
    const ksProj = ksDistance(hRaw.lineupProjRatio, proRaw.lineupProjRatio);
    const ksCeil = ksDistance(hRaw.lineupCeilRatio, proRaw.lineupCeilRatio);
    const ksOwnStd = ksDistance(hRaw.lineupOwnStd, proRaw.lineupOwnStd);
    const ksPctile = ksDistance(hRaw.lineupOwnPctile, proRaw.lineupOwnPctile);
    const ksAvg = (ksOwn + ksProj + ksCeil + ksOwnStd + ksPctile) / 5;

    // Mahalanobis on quantiles (recompute Hermes quantiles)
    const hQ = {
      lineupOwn: quantilesOf(hRaw.lineupOwn, QUANTILES),
      lineupProjRatio: quantilesOf(hRaw.lineupProjRatio, QUANTILES),
      lineupCeilRatio: quantilesOf(hRaw.lineupCeilRatio, QUANTILES),
      lineupOwnStd: quantilesOf(hRaw.lineupOwnStd, QUANTILES),
      lineupOwnPctile: quantilesOf(hRaw.lineupOwnPctile, QUANTILES),
    };
    let totalSq = 0, n = 0;
    for (const m of METRICS) {
      const c = consBySlate[s.slate]?.[m]; if (!c) continue;
      for (let qi = 0; qi < 5; qi++) {
        if (c.std[qi] < 1e-9) continue;
        const z = ((hQ as any)[m][qi] - c.mean[qi]) / c.std[qi];
        totalSq += z * z; n++;
      }
    }
    const mahalDist = n > 0 ? Math.sqrt(totalSq / n) : 0;

    slateRows.push({
      slate: s.slate, nTeams: teams.size, F: actuals.entries.length, optProj: ctx.optProj,
      chalkAnchor: ctx.chalkAnchor, poolSize: loaded.lineups.length, slateAvgOwn: ctx.slateAvgOwn,
      ksOwn, ksProj, ksCeil, ksOwnStd, ksPctile, ksAvg, mahalDist,
    });
  }

  // Print main table
  console.log('=== PER-SLATE METRICS ===\n');
  console.log('slate           teams  F      optProj  chalkA%  poolSz  ksAvg  mahal');
  for (const r of slateRows) {
    console.log('  ' + r.slate.padEnd(15) + r.nTeams.toString().padStart(5) + ' ' + r.F.toString().padStart(6) + ' ' + r.optProj.toFixed(0).padStart(7) + '  ' + r.chalkAnchor.toFixed(1).padStart(6) + '  ' + r.poolSize.toString().padStart(6) + '  ' + r.ksAvg.toFixed(3) + '  ' + r.mahalDist.toFixed(2));
  }

  // Phase 3: correlate slate features with Hermes distance
  console.log('\n=== PHASE 3: feature × Hermes-distance correlation ===');
  const features: Record<string, number[]> = {
    nTeams: slateRows.map(r => r.nTeams),
    F: slateRows.map(r => r.F),
    logF: slateRows.map(r => Math.log(r.F)),
    optProj: slateRows.map(r => r.optProj),
    chalkAnchor: slateRows.map(r => r.chalkAnchor),
    poolSize: slateRows.map(r => r.poolSize),
    slateAvgOwn: slateRows.map(r => r.slateAvgOwn),
  };
  const targets: Record<string, number[]> = {
    ksAvg: slateRows.map(r => r.ksAvg),
    mahalDist: slateRows.map(r => r.mahalDist),
  };
  console.log('feature        | r(ksAvg)   r(mahal)');
  for (const [fname, fvals] of Object.entries(features)) {
    const rks = pearson(fvals, targets.ksAvg);
    const rm = pearson(fvals, targets.mahalDist);
    console.log('  ' + fname.padEnd(14) + '|  ' + rks.toFixed(3).padStart(7) + '   ' + rm.toFixed(3).padStart(7));
  }

  // Slate clusters: small (≤14 teams) / medium / large
  console.log('\n=== SIMPLE CLUSTER ANALYSIS (by team count) ===');
  const clusters = [
    { label: 'small (≤14 teams)', filter: (r: any) => r.nTeams <= 14 },
    { label: 'mid (16-20 teams)', filter: (r: any) => r.nTeams >= 16 && r.nTeams <= 20 },
    { label: 'large (>20 teams)', filter: (r: any) => r.nTeams > 20 },
  ];
  for (const c of clusters) {
    const sub = slateRows.filter(c.filter);
    if (!sub.length) { console.log('  ' + c.label + ': 0 slates'); continue; }
    const meanKs = mean(sub.map(r => r.ksAvg));
    const meanMahal = mean(sub.map(r => r.mahalDist));
    const meanF = mean(sub.map(r => r.F));
    const meanChalk = mean(sub.map(r => r.chalkAnchor));
    console.log('  ' + c.label.padEnd(20) + ' n=' + sub.length + '  meanKsAvg=' + meanKs.toFixed(3) + '  meanMahal=' + meanMahal.toFixed(2) + '  avgF=' + meanF.toFixed(0) + '  chalkA=' + meanChalk.toFixed(1) + '%');
  }

  // KS-distance gates
  console.log('\n=== PHASE 2-lite KS GATES ===');
  console.log('Mean KS-distance across 5 metrics × ' + slateRows.length + ' slates:');
  for (const m of ['ksOwn', 'ksProj', 'ksCeil', 'ksOwnStd', 'ksPctile'] as const) {
    const vals = slateRows.map(r => (r as any)[m]);
    console.log('  ' + m.padEnd(12) + 'mean=' + mean(vals).toFixed(3) + '  max=' + Math.max(...vals).toFixed(3) + '  min=' + Math.min(...vals).toFixed(3));
  }
  const overallKs = mean(slateRows.map(r => r.ksAvg));
  console.log('\n  OVERALL meanKsAvg = ' + overallKs.toFixed(3));
  console.log('  Gate: ksAvg < 0.20 (pros vs Hermes distributions broadly overlap)? ' + (overallKs < 0.20 ? '✅ PASS' : '❌ FAIL'));
  console.log('  Gate: ksAvg < 0.30? ' + (overallKs < 0.30 ? '✅ PASS' : '❌ FAIL'));
}

main().catch(e => { console.error(e); process.exit(1); });
