/**
 * Phase 2: Production Gap + Mahalanobis-weighted sweep against pro consensus.
 *
 * Uses 5 universal slate-relative metrics (per phase-1 diagnostic):
 *   - projRatioToOptimal   CV 0.018
 *   - ceilingRatioToOptimal CV 0.012
 *   - avgPlayerOwnPctile   CV 0.009
 *   - ownStdRatio          CV 0.058
 *   - ownDeltaFromAnchor   CV 0.142
 *
 * Distance per slate: sqrt(sum_i ((config_i - consensus_mean_i) / consensus_std_i)^2)
 * Composite distance: mean across slates. Lower = closer to consensus.
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
const V17_JSON = path.join(DIR, 'mlb_megabin3_sweep_v17.json');
const OUT_JSON = path.join(DIR, 'pro_mahalanobis_results.json');
const N = 150;

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

const UNIVERSAL_METRICS = ['projRatioToOptimal', 'ceilingRatioToOptimal', 'avgPlayerOwnPctile', 'ownStdRatio', 'ownDeltaFromAnchor'] as const;

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function mean(a: number[]): number { if (!a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; }
function stddev(a: number[]): number { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); }

interface SlateStats {
  optimalLineupProj: number;
  optimalLineupCeiling: number;
  chalkAnchorOwn: number;
  slateAvgPlayerOwn: number;
  ownPercentileByPlayerId: Map<string, number>;
}

function computeSlateStats(players: Player[], allLineups: Player[][]): SlateStats {
  let optProj = 0, optCeil = 0;
  const lineupOwnPairs: { meanOwn: number }[] = [];
  for (const lu of allLineups) {
    let p = 0, c = 0, o = 0;
    for (const pl of lu) {
      p += pl.projection || 0;
      c += (pl as any).ceiling || (pl.projection || 0) * 1.4;
      o += pl.ownership || 0;
    }
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
  for (let i = 0; i < sortedByOwn.length; i++) {
    ownPctile.set(sortedByOwn[i].id, sortedByOwn.length > 1 ? i / (sortedByOwn.length - 1) : 0);
  }
  return {
    optimalLineupProj: optProj,
    optimalLineupCeiling: optCeil,
    chalkAnchorOwn: chalkAnchor,
    slateAvgPlayerOwn: slateAvg,
    ownPercentileByPlayerId: ownPctile,
  };
}

interface UniversalMetrics {
  projRatioToOptimal: number;
  ceilingRatioToOptimal: number;
  avgPlayerOwnPctile: number;
  ownStdRatio: number;
  ownDeltaFromAnchor: number;
}

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

interface SlateData {
  slate: string;
  candidates: Lineup[];
  players: Player[];
  comboFreq: Map<string, number>;
  comboFreq1: Map<string, number>;
  comboFreq2: Map<string, number>;
  comboFreq4: Map<string, number>;
  stats: SlateStats;
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
  // Build all field lineups for chalk computation
  const fieldLineups: Player[][] = [];
  for (const e of actuals.entries) {
    const pls: Player[] = []; let ok = true;
    for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
    if (ok) fieldLineups.push(pls);
  }
  const stats = computeSlateStats(pool.players, fieldLineups);
  return {
    slate: s.slate, candidates: loaded.lineups, players: pool.players,
    comboFreq: precomputeComboFrequencies(loaded.lineups, 3),
    comboFreq1: precomputeComboFrequencies(loaded.lineups, 1),
    comboFreq2: precomputeComboFrequencies(loaded.lineups, 2),
    comboFreq4: precomputeComboFrequencies(loaded.lineups, 4),
    stats,
  };
}

const getCombo = (sd: SlateData, power?: number) => {
  if (power === 1) return sd.comboFreq1;
  if (power === 2) return sd.comboFreq2;
  if (power === 4) return sd.comboFreq4;
  return sd.comboFreq;
};

function buildRunCfg(cfg: any, sd: SlateData): Parameters<typeof productionSelect>[2] {
  const a = cfg.alloc || [0.05, 0.05, 0.85, 0.03, 0.02];
  const binAllocation = { chalk: a[0], core: a[1], value: a[2], contra: a[3], deep: a[4] };
  const phase = cfg.phase;
  if (phase === 'A') return { N, lambda: cfg.lam, comboFreq: sd.comboFreq, maxOverlap: cfg.gam, teamCapPct: cfg.tc, minPrimaryStack: cfg.mps, maxExposure: cfg.me, maxExposurePitcher: cfg.mep, extremeCornerCap: cfg.corner, projectionFloorPct: 0, binAllocation };
  if (phase === 'B') return { N, lambda: cfg.lam, comboFreq: getCombo(sd, cfg.power), maxOverlap: cfg.gam, teamCapPct: cfg.tc, minPrimaryStack: cfg.mps, maxExposure: cfg.me, extremeCornerCap: true, projectionFloorPct: 0, binAllocation };
  if (phase === 'C') return { N, lambda: cfg.lam, comboFreq: getCombo(sd, cfg.power), maxOverlap: 6, teamCapPct: cfg.tc, minPrimaryStack: cfg.mps, maxExposure: cfg.me, maxExposurePitcher: cfg.mep, extremeCornerCap: cfg.corner, projectionFloorPct: 0, binAllocation };
  if (phase === 'D') return { N, lambda: cfg.lam, comboFreq: getCombo(sd, cfg.power), maxOverlap: cfg.gam, teamCapPct: cfg.tc, minPrimaryStack: 5, maxExposure: cfg.me, maxExposurePitcher: cfg.mep, extremeCornerCap: cfg.corner, projectionFloorPct: 0, binAllocation };
  if (phase === 'E') return { N, lambda: cfg.lam, comboFreq: getCombo(sd, cfg.power), maxOverlap: cfg.gam, teamCapPct: cfg.tc, minPrimaryStack: cfg.mps, maxExposure: cfg.me, maxExposurePitcher: cfg.mep, extremeCornerCap: cfg.corner, projectionFloorPct: 0, binAllocation };
  return { N, lambda: cfg.lam, comboFreq: getCombo(sd, cfg.power), maxOverlap: cfg.gam, teamCapPct: cfg.tc, projectionFloorPct: cfg.fl, minPrimaryStack: cfg.mps, maxExposure: cfg.me, maxExposurePitcher: cfg.mep, extremeCornerCap: cfg.corner, extremeCornerQ5Q5Pct: cfg.q5, extremeCornerQ1Q1Pct: cfg.q1, useOwnershipCeiling: cfg.useOC, ownDropPP: cfg.od, ownershipCeilingBuffer: cfg.buf, binAllocation };
}

const SHIPPED_CHIMERA = { id: 'SHIPPED_CHIMERA', cfg: { phase: 'C', lam: 0.62, tc: 0.24, mps: 5, me: 0.16, mep: 0.41, corner: true, power: 2, alloc: [0.05, 0.05, 0.85, 0.03, 0.02] }};

async function main() {
  console.log('================================================================');
  console.log('PHASE 2: Production gap + Mahalanobis sweep vs pro consensus');
  console.log('================================================================\n');

  const consensus = JSON.parse(fs.readFileSync(path.join(DIR, 'pro_consensus_slate_relative.json'), 'utf-8'));
  // Build per-slate consensus lookup
  const consBySlate: Record<string, Record<string, { mean: number; std: number }>> = {};
  for (const k of UNIVERSAL_METRICS) {
    for (const entry of (consensus.metrics[k] || [])) {
      if (!consBySlate[entry.slate]) consBySlate[entry.slate] = {};
      consBySlate[entry.slate][k] = { mean: entry.mean, std: entry.std };
    }
  }

  console.log('Loading slates...');
  const cache: SlateData[] = [];
  for (const s of SLATES) {
    try { const sd = await loadSlate(s); if (sd) cache.push(sd); } catch (e: any) { console.log('  skip ' + s.slate + ': ' + e.message); }
  }
  console.log(cache.length + ' slates loaded.\n');

  // Mahalanobis distance per slate, averaged
  function mahalanobis(metrics: UniversalMetrics, slate: string): number | null {
    const cons = consBySlate[slate]; if (!cons) return null;
    let sum = 0; let n = 0;
    for (const k of UNIVERSAL_METRICS) {
      const c = cons[k]; if (!c || c.std < 1e-9) continue;
      const d = ((metrics as any)[k] - c.mean) / c.std;
      sum += d * d; n++;
    }
    return n > 0 ? Math.sqrt(sum / n) : null;
  }

  // ============ Production gap analysis ============
  console.log('================================================================');
  console.log('PRODUCTION GAP — Cerberus vs pro consensus per slate');
  console.log('================================================================\n');

  // Load Cerberus from v17 JSON to use real cfg
  const v17 = JSON.parse(fs.readFileSync(V17_JSON, 'utf-8')) as any[];
  const cerberus = v17.find(r => r.id === 'C:chimera-nbr|1428');

  console.log('slate         | proj-Δ      ceil-Δ      ownPctile-Δ  ownStd-Δ    ownDelta-Δ   | mahalanobis');
  const cerbDistsBySlate: Record<string, number> = {};
  for (const sd of cache) {
    const result = productionSelect(sd.candidates, sd.players, buildRunCfg(cerberus.cfg, sd));
    const lineups: Player[][] = result.portfolio.map(lu => lu.players);
    const m = computeUniversal(lineups, sd.stats);
    const cons = consBySlate[sd.slate]; if (!cons) continue;
    const dist = mahalanobis(m, sd.slate);
    cerbDistsBySlate[sd.slate] = dist || 0;
    let row = sd.slate.padEnd(14) + '| ';
    for (const k of UNIVERSAL_METRICS) {
      const c = cons[k];
      if (!c) { row += '       n/a    '; continue; }
      const delta = (m as any)[k] - c.mean;
      const sigmas = c.std > 0 ? delta / c.std : 0;
      row += ((delta > 0 ? '+' : '') + delta.toFixed(2) + 'σ' + sigmas.toFixed(1)).padStart(12);
    }
    row += ' | ' + (dist?.toFixed(2) || 'n/a');
    console.log(row);
  }
  const meanCerbDist = mean(Object.values(cerbDistsBySlate));
  console.log('\nCerberus mean Mahalanobis distance: ' + meanCerbDist.toFixed(2) + ' (lower = closer to consensus)');

  // ============ Same for shipped Chimera ============
  console.log('\n================================================================');
  console.log('SHIPPED CHIMERA per-slate distance');
  console.log('================================================================\n');
  const chimDistsBySlate: Record<string, number> = {};
  for (const sd of cache) {
    const result = productionSelect(sd.candidates, sd.players, buildRunCfg(SHIPPED_CHIMERA.cfg, sd));
    const lineups: Player[][] = result.portfolio.map(lu => lu.players);
    const m = computeUniversal(lineups, sd.stats);
    const dist = mahalanobis(m, sd.slate);
    chimDistsBySlate[sd.slate] = dist || 0;
  }
  const meanChimDist = mean(Object.values(chimDistsBySlate));
  console.log('Shipped Chimera mean Mahalanobis distance: ' + meanChimDist.toFixed(2));

  // ============ Mahalanobis sweep across configs ============
  console.log('\n================================================================');
  console.log('MAHALANOBIS SWEEP across top configs from 92K');
  console.log('================================================================\n');

  // Strategic sample
  const sampled = new Map<string, any>();
  [...v17].sort((a, b) => (b.fullPayV17 || b.fullPay) - (a.fullPayV17 || a.fullPay)).slice(0, 700).forEach(r => sampled.set(r.id, r));
  [...v17].sort((a, b) => (b.oosPay || 0) - (a.oosPay || 0)).slice(0, 700).forEach(r => sampled.set(r.id, r));
  [...v17].sort((a, b) => (b.meanIqrFrac || 0) - (a.meanIqrFrac || 0)).slice(0, 700).forEach(r => sampled.set(r.id, r));
  // Add some random for coverage
  const rest = v17.filter(r => !sampled.has(r.id));
  for (let i = 0; i < 500 && rest.length > 0; i++) {
    const idx = Math.floor(Math.random() * rest.length);
    sampled.set(rest[idx].id, rest[idx]); rest.splice(idx, 1);
  }
  const configs = [...sampled.values()];
  console.log('Sampled configs: ' + configs.length);

  const t_start = Date.now();
  const results: any[] = [];
  for (let i = 0; i < configs.length; i++) {
    const c = configs[i];
    const distsBySlate: Record<string, number> = {};
    let okSlates = 0;
    for (const sd of cache) {
      try {
        const result = productionSelect(sd.candidates, sd.players, buildRunCfg(c.cfg, sd));
        const lineups: Player[][] = result.portfolio.map(lu => lu.players);
        const m = computeUniversal(lineups, sd.stats);
        const dist = mahalanobis(m, sd.slate);
        if (dist !== null) { distsBySlate[sd.slate] = dist; okSlates++; }
      } catch {}
    }
    if (okSlates < 10) continue;
    const meanDist = mean(Object.values(distsBySlate));
    const fullPay17 = (c.fullPay || 0) + (c.newSlatePay || 0);
    const fullROI17 = (fullPay17 / (17 * N * 20) - 1) * 100;
    results.push({
      id: c.id, cfg: c.cfg,
      meanDist, distsBySlate,
      fullPay: c.fullPay, oosPay: c.oosPay, newSlatePay: c.newSlatePay,
      fullPay17, fullROI17,
      meanIqrFrac: c.meanIqrFrac,
    });
    if ((i + 1) % 100 === 0) {
      const elapsed = (Date.now() - t_start) / 60000;
      const rate = (i + 1) / elapsed;
      const remain = (configs.length - i - 1) / rate;
      console.log('  [' + (i + 1) + '/' + configs.length + ' ' + ((i + 1) / configs.length * 100).toFixed(0) + '%, ' + elapsed.toFixed(1) + 'm, ETA ' + remain.toFixed(0) + 'm]');
    }
  }
  fs.writeFileSync(OUT_JSON, JSON.stringify(results, null, 0));

  console.log('\nDone. ' + results.length + ' configs evaluated in ' + ((Date.now() - t_start) / 60000).toFixed(1) + 'm');

  // ============ Reports ============
  console.log('\n=== TOP 25 BY MAHALANOBIS-CLOSEST TO CONSENSUS ===');
  console.log('rank dist | full17 ROI | OOS5 ROI | disp | id');
  const byDist = [...results].sort((a, b) => a.meanDist - b.meanDist).slice(0, 25);
  for (const r of byDist) {
    const oosROI5 = (r.oosPay / (5 * N * 20) - 1) * 100;
    console.log('  d=' + r.meanDist.toFixed(2) + ' | ROI17=' + r.fullROI17.toFixed(0).padStart(5) + '% | OOS5=' + oosROI5.toFixed(0).padStart(5) + '% | disp=' + (r.meanIqrFrac * 100).toFixed(1) + '% | ' + r.id.slice(0, 50));
  }

  console.log('\n=== TOP 15 BY ROI WITHIN MAHALANOBIS-CLOSEST 100 (closest to consensus AND winning) ===');
  const top100Closest = [...results].sort((a, b) => a.meanDist - b.meanDist).slice(0, 100);
  console.log('  closest-100 mean dist: ' + mean(top100Closest.map(r => r.meanDist)).toFixed(2));
  console.log('  closest-100 mean ROI17: ' + mean(top100Closest.map(r => r.fullROI17)).toFixed(1) + '%');
  console.log('  closest-100 profitable count: ' + top100Closest.filter(r => r.fullPay17 > 17 * N * 20).length + '/100');
  const byROIInClosest = [...top100Closest].sort((a, b) => b.fullROI17 - a.fullROI17).slice(0, 15);
  console.log('rank | ROI17 | dist | OOS5 ROI | disp | id');
  for (const r of byROIInClosest) {
    const oosROI5 = (r.oosPay / (5 * N * 20) - 1) * 100;
    console.log('  ROI=' + r.fullROI17.toFixed(0).padStart(5) + '% | d=' + r.meanDist.toFixed(2) + ' | OOS5=' + oosROI5.toFixed(0).padStart(5) + '% | disp=' + (r.meanIqrFrac * 100).toFixed(1) + '% | ' + r.id.slice(0, 50));
  }

  // Cerberus rank in distance
  const cerbInResults = results.find(r => r.id === 'C:chimera-nbr|1428');
  if (cerbInResults) {
    const rank = [...results].sort((a, b) => a.meanDist - b.meanDist).findIndex(r => r.id === cerbInResults.id) + 1;
    console.log('\n=== CERBERUS RANK BY MAHALANOBIS DISTANCE ===');
    console.log('  Rank: #' + rank + ' of ' + results.length);
    console.log('  Distance: ' + cerbInResults.meanDist.toFixed(2));
    console.log('  Full17 ROI: ' + cerbInResults.fullROI17.toFixed(1) + '%');
  }

  // Distance vs ROI relationship
  console.log('\n=== DISTANCE × ROI RELATIONSHIP ===');
  const buckets = [
    { label: 'closest 5% (d<' + (([...results].map(r => r.meanDist).sort((a, b) => a - b))[Math.floor(results.length * 0.05)] || 0).toFixed(2) + ')', filter: (r: any) => r.meanDist <= ([...results].map(x => x.meanDist).sort((a, b) => a - b))[Math.floor(results.length * 0.05)] },
    { label: 'closest 10%', filter: (r: any) => r.meanDist <= ([...results].map(x => x.meanDist).sort((a, b) => a - b))[Math.floor(results.length * 0.10)] },
    { label: 'closest 25%', filter: (r: any) => r.meanDist <= ([...results].map(x => x.meanDist).sort((a, b) => a - b))[Math.floor(results.length * 0.25)] },
    { label: 'middle 50%', filter: (r: any) => { const ds = [...results].map(x => x.meanDist).sort((a, b) => a - b); return r.meanDist > ds[Math.floor(results.length * 0.25)] && r.meanDist <= ds[Math.floor(results.length * 0.75)]; } },
    { label: 'farthest 25%', filter: (r: any) => r.meanDist > ([...results].map(x => x.meanDist).sort((a, b) => a - b))[Math.floor(results.length * 0.75)] },
  ];
  for (const b of buckets) {
    const sub = results.filter(b.filter);
    if (!sub.length) continue;
    const avgROI = mean(sub.map(r => r.fullROI17));
    const profCount = sub.filter(r => r.fullPay17 > 17 * N * 20).length;
    console.log('  ' + b.label.padEnd(36) + ' n=' + sub.length.toString().padStart(4) + ' meanROI=' + avgROI.toFixed(1).padStart(7) + '% prof=' + (profCount / sub.length * 100).toFixed(0) + '%');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
