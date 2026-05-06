/**
 * Quantile-distance ranking of candidate configs vs pro consensus.
 * Re-evaluates top candidates from prior analyses using the quantile-based
 * Mahalanobis distance. Identifies whether Hermes V1 (synthesis) is the closest
 * config to pros, or if specific sweep configs beat it.
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

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function mean(a: number[]): number { if (!a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; }
function stddev(a: number[]): number { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); }
function quantilesOf(arr: number[], qs: number[]): number[] {
  const sorted = [...arr].sort((a, b) => a - b);
  return qs.map(q => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]);
}

interface SlateContext { optProj: number; optCeil: number; slateAvgOwn: number; ownPctile: Map<string, number>; }
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

interface SlateData {
  slate: string; candidates: Lineup[]; players: Player[]; ctx: SlateContext;
  comboFreq1: Map<string, number>; comboFreq2: Map<string, number>; comboFreq3: Map<string, number>; comboFreq4: Map<string, number>;
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
  return {
    slate: s.slate, candidates: loaded.lineups, players: pool.players,
    ctx: buildSlateContext(pool.players, fieldLineups),
    comboFreq1: precomputeComboFrequencies(loaded.lineups, 1),
    comboFreq2: precomputeComboFrequencies(loaded.lineups, 2),
    comboFreq3: precomputeComboFrequencies(loaded.lineups, 3),
    comboFreq4: precomputeComboFrequencies(loaded.lineups, 4),
  };
}

function getCombo(sd: SlateData, power?: number) {
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

async function main() {
  console.log('=== Quantile-distance ranking of candidate configs ===\n');

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

  // Candidates: Hermes V1 + V2 + d<1.3 cluster + top by full ROI + top by combined-ROI-OOS
  const v17 = JSON.parse(fs.readFileSync(path.join(DIR, 'mlb_megabin3_sweep_v17.json'), 'utf-8')) as any[];
  const idMap = new Map(v17.map(r => [r.id, r]));

  const candidates: Array<{ id: string; cfg: any; label: string }> = [
    { id: 'HERMES_V1', label: 'Hermes V1 (synthesis)', cfg: { phase: 'C', lam: 0.58, tc: 0.20, mps: 4, me: 0.21, mep: 0.45, corner: true, power: 4, alloc: [0.50, 0.30, 0.20, 0, 0] } },
    { id: 'HERMES_V2', label: 'Hermes V2 (value-target)', cfg: { phase: 'C', lam: 0.58, tc: 0.20, mps: 4, me: 0.21, mep: 0.45, corner: true, power: 4, alloc: [0, 0.15, 0.75, 0.10, 0] } },
    { id: 'CERBERUS', label: 'Cerberus (pulled)', cfg: { phase: 'C', lam: 0.421, tc: 0.192, mps: 5, me: 0.16, mep: 0.483, corner: true, power: 1, alloc: [0.047, 0.006, 0.873, 0.048, 0.026] } },
    { id: 'SHIPPED_CHIMERA', label: 'Chimera (predecessor)', cfg: { phase: 'C', lam: 0.62, tc: 0.24, mps: 5, me: 0.16, mep: 0.41, corner: true, power: 2, alloc: [0.05, 0.05, 0.85, 0.03, 0.02] } },
  ];

  // Add ALL 10 d<1.3 cluster configs by id
  const clusterIds = [
    'F:pure-chalk|p3|l1.38|g6|fl0.00|tc0.16|c1|mps3|me0.24|mep0.48',
    'F:barbell|p2|l0.55|g5|fl0.00|tc0.24|c1|mps3|me0.21|mep0.50',
    'F:pure-chalk|p4|l0.58|g5|fl0.00|tc0.26|c1|mps4|me0.21|mep0.41',
    'F:random5|p4|l0.39|g5|fl0.83|tc0.17|c1|mps2|me0.15|mep0.54',
    'F:pure-chalk|p1|l1.35|g5|fl0.00|tc0.15|c1|mps4|me0.19|mep0.63',
    'F:random5|p4|l1.04|g8|fl0.00|tc0.15|c1|mps4|me0.36|mep0.51',
    'F:pure-chalk|p1|l1.24|g5|fl0.80|tc0.24|c1|mps5|me0.22|mep0.50',
    'F:pure-chalk|p1|l1.31|g5|fl0.83|tc0.19|c1|mps5|me0.21|mep0.46',
    'B:lam0.7|p4|random5|184',
    'F:pure-chalk|p4|l0.30|g6|fl0.79|tc0.18|c1|mps4|me0.22|mep0.47',
  ];
  for (const id of clusterIds) {
    const r = idMap.get(id); if (!r) continue;
    candidates.push({ id, label: id.slice(0, 50), cfg: r.cfg });
  }

  // Need pro raw values for KS computation
  console.log('Loading pro lineup raw values for KS computation...');
  const PROS_LIST = [
    { tokens: ['nerdytenor'] }, { tokens: ['zroth', 'zroth2'] }, { tokens: ['youdacao'] },
    { tokens: ['shipmymoney'] }, { tokens: ['shaidyadvice'] }, { tokens: ['bgreseth'] }, { tokens: ['needlunchmoney'] },
  ];
  const proRawBySlate = new Map<string, Record<string, number[]>>();
  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj), actualsPath = path.join(DIR, s.actuals), poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) continue;
    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);
    const nameMap = new Map<string, Player>();
    for (const p of pool.players) nameMap.set(norm(p.name), p);
    const fieldLineups: Player[][] = [];
    for (const e of actuals.entries) {
      const pls: Player[] = []; let ok = true;
      for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
      if (ok) fieldLineups.push(pls);
    }
    const ctx = buildSlateContext(pool.players, fieldLineups);
    const allPro: Player[][] = [];
    for (const p of PROS_LIST) {
      for (const e of actuals.entries) {
        const en = (e.entryName || '').toLowerCase();
        if (!p.tokens.some((t: string) => en.includes(t))) continue;
        const pls: Player[] = []; let ok = true;
        for (const nm of e.playerNames) { const pl = nameMap.get(norm(nm)); if (!pl) { ok = false; break; } pls.push(pl); }
        if (ok) allPro.push(pls);
      }
    }
    if (allPro.length < 100) continue;
    const own: number[] = [], proj: number[] = [], ceil: number[] = [], ownStd: number[] = [], pctile: number[] = [];
    for (const players of allPro) {
      const owns = players.map(p => p.ownership || 0);
      own.push(mean(owns));
      proj.push(ctx.optProj > 0 ? players.reduce((s, p) => s + (p.projection || 0), 0) / ctx.optProj : 0);
      ceil.push(ctx.optCeil > 0 ? players.reduce((s, p) => s + ((p as any).ceiling || (p.projection || 0) * 1.4), 0) / ctx.optCeil : 0);
      ownStd.push(ctx.slateAvgOwn > 0 ? stddev(owns) / ctx.slateAvgOwn : 0);
      let ps = 0; for (const p of players) ps += ctx.ownPctile.get(p.id) || 0;
      pctile.push(ps / players.length);
    }
    proRawBySlate.set(s.slate, { lineupOwn: own, lineupProjRatio: proj, lineupCeilRatio: ceil, lineupOwnStd: ownStd, lineupOwnPctile: pctile });
  }

  function ksDistance(a: number[], b: number[]): number {
    const sa = [...a].sort((x, y) => x - y); const sb = [...b].sort((x, y) => x - y);
    let maxD = 0, ai = 0, bi = 0;
    while (ai < sa.length && bi < sb.length) {
      const cdfA = (ai + 1) / sa.length, cdfB = (bi + 1) / sb.length;
      if (Math.abs(cdfA - cdfB) > maxD) maxD = Math.abs(cdfA - cdfB);
      if (sa[ai] < sb[bi]) ai++; else if (sa[ai] > sb[bi]) bi++; else { ai++; bi++; }
    }
    return maxD;
  }

  console.log('Evaluating ' + candidates.length + ' candidates × ' + cache.length + ' slates...\n');

  const results: Array<{ id: string; label: string; meanDist: number; meanKs: number; fullROI17?: number; oos5ROI?: number }> = [];
  for (const c of candidates) {
    const distsBySlate: number[] = []; const ksBySlate: number[] = [];
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

        // KS distance (pool all metrics' raw values from this run vs pros)
        const proRaw = proRawBySlate.get(sd.slate);
        if (proRaw) {
          const own: number[] = [], proj: number[] = [], ceil: number[] = [], ownStd: number[] = [], pctile: number[] = [];
          for (const players of lineups) {
            const owns = players.map(p => p.ownership || 0);
            own.push(mean(owns));
            proj.push(sd.ctx.optProj > 0 ? players.reduce((s, p) => s + (p.projection || 0), 0) / sd.ctx.optProj : 0);
            ceil.push(sd.ctx.optCeil > 0 ? players.reduce((s, p) => s + ((p as any).ceiling || (p.projection || 0) * 1.4), 0) / sd.ctx.optCeil : 0);
            ownStd.push(sd.ctx.slateAvgOwn > 0 ? stddev(owns) / sd.ctx.slateAvgOwn : 0);
            let ps = 0; for (const p of players) ps += sd.ctx.ownPctile.get(p.id) || 0;
            pctile.push(ps / players.length);
          }
          const ks = (
            ksDistance(own, proRaw.lineupOwn) + ksDistance(proj, proRaw.lineupProjRatio) +
            ksDistance(ceil, proRaw.lineupCeilRatio) + ksDistance(ownStd, proRaw.lineupOwnStd) +
            ksDistance(pctile, proRaw.lineupOwnPctile)
          ) / 5;
          ksBySlate.push(ks);
        }
      } catch {}
    }
    const meanDist = distsBySlate.length > 0 ? mean(distsBySlate) : Infinity;
    const meanKs = ksBySlate.length > 0 ? mean(ksBySlate) : Infinity;
    const sweepRow = idMap.get(c.id);
    results.push({
      id: c.id, label: c.label, meanDist, meanKs,
      fullROI17: sweepRow ? ((sweepRow.fullPay + (sweepRow.newSlatePay || 0)) / (17 * 150 * 20) - 1) * 100 : undefined,
      oos5ROI: sweepRow && sweepRow.oosPay ? (sweepRow.oosPay / (5 * 150 * 20) - 1) * 100 : undefined,
    });
  }

  // Sort by mean distance
  results.sort((a, b) => a.meanDist - b.meanDist);
  console.log('=== RANKING (sorted by quantile Mahalanobis) ===\n');
  console.log('rank d_mahal  ks      | label                                              | full17 ROI | OOS5 ROI');
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const fROI = r.fullROI17 !== undefined ? r.fullROI17.toFixed(0).padStart(4) + '%' : '   - ';
    const oROI = r.oos5ROI !== undefined ? r.oos5ROI.toFixed(0).padStart(4) + '%' : '   - ';
    console.log('  #' + (i + 1).toString().padStart(2) + ' d=' + r.meanDist.toFixed(2) + ' ks=' + r.meanKs.toFixed(3) + ' | ' + r.label.slice(0, 50).padEnd(50) + ' | ' + fROI + '      | ' + oROI);
  }

  // Sort by KS for cross-check
  console.log('\n=== RANKING (sorted by KS distance) ===\n');
  const byKs = [...results].sort((a, b) => a.meanKs - b.meanKs);
  for (let i = 0; i < byKs.length; i++) {
    const r = byKs[i];
    const fROI = r.fullROI17 !== undefined ? r.fullROI17.toFixed(0).padStart(4) + '%' : '   - ';
    const oROI = r.oos5ROI !== undefined ? r.oos5ROI.toFixed(0).padStart(4) + '%' : '   - ';
    console.log('  #' + (i + 1).toString().padStart(2) + ' ks=' + r.meanKs.toFixed(3) + ' d=' + r.meanDist.toFixed(2) + ' | ' + r.label.slice(0, 50).padEnd(50) + ' | ' + fROI + '      | ' + oROI);
  }

  // Find configs that pass BOTH ROI gate (>50%) AND distance gates
  console.log('\n=== CANDIDATES PASSING DUAL GATES (ROI ≥ 50% AND ROI ≤ 200%) ===\n');
  const dualPass = results.filter(r => r.fullROI17 !== undefined && r.fullROI17 >= 50 && r.fullROI17 <= 200);
  dualPass.sort((a, b) => a.meanDist - b.meanDist);
  console.log('rank d_mahal  ks      | label                                              | full17 ROI | OOS5 ROI');
  for (let i = 0; i < dualPass.length; i++) {
    const r = dualPass[i];
    const fROI = r.fullROI17!.toFixed(0).padStart(4) + '%';
    const oROI = r.oos5ROI !== undefined ? r.oos5ROI.toFixed(0).padStart(4) + '%' : '   - ';
    console.log('  #' + (i + 1).toString().padStart(2) + ' d=' + r.meanDist.toFixed(2) + ' ks=' + r.meanKs.toFixed(3) + ' | ' + r.label.slice(0, 50).padEnd(50) + ' | ' + fROI + '      | ' + oROI);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
