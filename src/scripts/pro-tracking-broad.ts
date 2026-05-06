/**
 * Broad pro-tracking — search across 92K configs to find the best pro-tracker.
 *
 * Strategy: sample ~3K configs strategically (top-N by full/OOS/disp/rp3 + random)
 * to maximize coverage. For each, run on 18 slates and compute Pearson |r| with
 * nerdytenor + zroth across 9 portfolio metrics. Report top trackers.
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
const V18_JSON = path.join(DIR, 'mlb_megabin3_sweep_v18.json');
const OUT_JSON = path.join(DIR, 'pro_tracking_broad.json');
const N = 150;

const SLATES = [
  { slate: '4-6-26', proj: '4-6-26_projections.csv', actuals: 'dkactuals 4-6-26.csv', pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26', proj: '4-8-26projections.csv', actuals: '4-8-26actuals.csv', pool: '4-8-26sspool.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv', actuals: '4-12-26actuals.csv', pool: '4-12-26sspool.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv', actuals: '4-14-26actuals.csv', pool: '4-14-26sspool.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv', actuals: '4-15-26actuals.csv', pool: '4-15-26sspool.csv' },
  { slate: '4-17-26', proj: '4-17-26projections.csv', actuals: '4-17-26actuals.csv', pool: '4-17-26sspool.csv' },
  { slate: '4-18-26', proj: '4-18-26projections.csv', actuals: '4-18-26actuals.csv', pool: '4-18-26sspool.csv' },
  { slate: '4-19-26', proj: '4-19-26projections.csv', actuals: '4-19-26actuals.csv', pool: '4-19-26sspool.csv' },
  { slate: '4-20-26', proj: '4-20-26projections.csv', actuals: '4-20-26actuals.csv', pool: '4-20-26sspool.csv' },
  { slate: '4-21-26', proj: '4-21-26projections.csv', actuals: '4-21-26actuals.csv', pool: '4-21-26sspool.csv' },
  { slate: '4-22-26', proj: '4-22-26projections.csv', actuals: '4-22-26actuals.csv', pool: '4-22-26sspool.csv' },
  { slate: '4-23-26', proj: '4-23-26projections.csv', actuals: '4-23-26actuals.csv', pool: '4-23-26sspool.csv' },
  { slate: '4-24-26', proj: '4-24-26projections.csv', actuals: '4-24-26actuals.csv', pool: '4-24-26sspool.csv' },
  { slate: '4-25-26', proj: '4-25-26projections.csv', actuals: '4-25-26actuals.csv', pool: '4-25-26sspool.csv' },
  { slate: '4-25-26-early', proj: '4-25-26projectionsearly.csv', actuals: '4-25-26actualsearly.csv', pool: '4-25-26sspoolearly.csv' },
  { slate: '4-26-26', proj: '4-26-26projections.csv', actuals: '4-26-26actuals.csv', pool: '4-26-26sspool.csv' },
  { slate: '4-27-26', proj: '4-27-26projections.csv', actuals: '4-27-26actuals.csv', pool: '4-27-26sspool.csv' },
  { slate: '4-28-26', proj: '4-28-26projections.csv', actuals: '4-28-26actuals.csv', pool: '4-28-26sspool.csv' },
];

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function mean(a: number[]): number { if (!a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; }
function stddev(a: number[]): number { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); }
function pearson(xs: number[], ys: number[]): number {
  const n = xs.length; if (n < 2) return 0;
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; num += dx * dy; dx2 += dx * dx; dy2 += dy * dy; }
  const den = Math.sqrt(dx2 * dy2);
  return den === 0 ? 0 : num / den;
}

interface PortfolioMetrics {
  meanOwn: number; meanProj: number; meanCeiling: number;
  ownStdWithinLineup: number;
  meanPairwiseOverlap: number; maxPairwiseOverlap: number;
  nonFourStackPct: number; uniqueTeams: number; maxTeamExposure: number;
}
const METRIC_KEYS = ['meanOwn', 'meanProj', 'meanCeiling', 'ownStdWithinLineup', 'meanPairwiseOverlap', 'maxPairwiseOverlap', 'nonFourStackPct', 'uniqueTeams', 'maxTeamExposure'] as const;

function computeMetrics(lineups: Player[][]): PortfolioMetrics {
  if (!lineups.length) return { meanOwn: 0, meanProj: 0, meanCeiling: 0, ownStdWithinLineup: 0, meanPairwiseOverlap: 0, maxPairwiseOverlap: 0, nonFourStackPct: 0, uniqueTeams: 0, maxTeamExposure: 0 };
  const luOwns: number[] = [], luProjs: number[] = [], luCeils: number[] = [], luOwnStds: number[] = [];
  let nonFour = 0;
  const teamExp = new Map<string, number>();
  const allStackTeams = new Set<string>();
  const pidSets: Set<string>[] = [];
  for (const players of lineups) {
    const owns = players.map(p => p.ownership || 0);
    luOwns.push(mean(owns));
    luProjs.push(players.reduce((s, p) => s + (p.projection || 0), 0));
    luCeils.push(players.reduce((s, p) => s + ((p as any).ceiling || (p.projection || 0) * 1.4), 0));
    luOwnStds.push(stddev(owns));
    const counts = new Map<string, number>();
    for (const p of players) if (!p.positions?.includes('P')) counts.set(p.team, (counts.get(p.team) || 0) + 1);
    let maxCount = 0, maxTeam: string | null = null;
    for (const [t, c] of counts) { if (c > maxCount) { maxCount = c; maxTeam = t; } if (c >= 4) allStackTeams.add(t); }
    if (maxCount < 4) nonFour++;
    if (maxTeam && maxCount >= 4) teamExp.set(maxTeam, (teamExp.get(maxTeam) || 0) + 1);
    pidSets.push(new Set(players.map(p => p.id)));
  }
  let maxOvl = 0, sumOvl = 0, pairs = 0;
  for (let i = 0; i < pidSets.length; i++) for (let j = i + 1; j < pidSets.length; j++) {
    let o = 0; for (const id of pidSets[i]) if (pidSets[j].has(id)) o++;
    if (o > maxOvl) maxOvl = o;
    sumOvl += o; pairs++;
  }
  return {
    meanOwn: mean(luOwns), meanProj: mean(luProjs), meanCeiling: mean(luCeils),
    ownStdWithinLineup: mean(luOwnStds),
    meanPairwiseOverlap: pairs > 0 ? sumOvl / pairs : 0,
    maxPairwiseOverlap: maxOvl,
    nonFourStackPct: nonFour / lineups.length * 100,
    uniqueTeams: allStackTeams.size,
    maxTeamExposure: teamExp.size > 0 ? Math.max(...teamExp.values()) / lineups.length * 100 : 0,
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
  actuals: ContestActuals;
  nameMap: Map<string, Player>;
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
  return {
    slate: s.slate, candidates: loaded.lineups, players: pool.players,
    comboFreq: precomputeComboFrequencies(loaded.lineups, 3),
    comboFreq1: precomputeComboFrequencies(loaded.lineups, 1),
    comboFreq2: precomputeComboFrequencies(loaded.lineups, 2),
    comboFreq4: precomputeComboFrequencies(loaded.lineups, 4),
    actuals, nameMap,
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

function extractPro(actuals: ContestActuals, nameMap: Map<string, Player>, proTokens: string[]): Player[][] {
  const out: Player[][] = [];
  for (const e of actuals.entries) {
    const en = (e.entryName || '').toLowerCase();
    if (!proTokens.some(t => en.includes(t))) continue;
    const pls: Player[] = []; let ok = true;
    for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
    if (ok) out.push(pls);
  }
  return out;
}

async function main() {
  console.log('================================================================');
  console.log('BROAD PRO TRACKING — sample top 3K configs across metrics');
  console.log('================================================================\n');

  console.log('Loading v17 + v18 configs...');
  const v17 = JSON.parse(fs.readFileSync(V17_JSON, 'utf-8')) as any[];
  const v18 = JSON.parse(fs.readFileSync(V18_JSON, 'utf-8')) as any[];
  console.log('  v17: ' + v17.length + ' configs (full 92K)');
  console.log('  v18: ' + v18.length + ' configs (top 2K with 4-28)\n');

  // Build by-id v18 lookup for newer fields
  const v18ById = new Map<string, any>();
  for (const r of v18) v18ById.set(r.id, r);

  // Strategic sample from v17:
  const sampled = new Map<string, any>();
  // 1. Top 800 by full17 ROI
  [...v17].sort((a, b) => (b.fullPayV17 || b.fullPay) - (a.fullPayV17 || a.fullPay)).slice(0, 800).forEach(r => sampled.set(r.id, r));
  // 2. Top 800 by OOS5 (oosPay)
  [...v17].sort((a, b) => (b.oosPay || 0) - (a.oosPay || 0)).slice(0, 800).forEach(r => sampled.set(r.id, r));
  // 3. Top 800 by dispersion
  [...v17].sort((a, b) => (b.meanIqrFrac || 0) - (a.meanIqrFrac || 0)).slice(0, 800).forEach(r => sampled.set(r.id, r));
  // 4. Top 800 by 3-way rp
  const rFull = new Map(), rOos = new Map(), rDisp = new Map();
  [...v17].sort((a, b) => (b.fullPayV17 || b.fullPay) - (a.fullPayV17 || a.fullPay)).forEach((r, i) => rFull.set(r.id, i + 1));
  [...v17].sort((a, b) => (b.oosPay || 0) - (a.oosPay || 0)).forEach((r, i) => rOos.set(r.id, i + 1));
  [...v17].sort((a, b) => (b.meanIqrFrac || 0) - (a.meanIqrFrac || 0)).forEach((r, i) => rDisp.set(r.id, i + 1));
  [...v17].map(r => ({ ...r, rp3: rFull.get(r.id) + rOos.get(r.id) + rDisp.get(r.id) })).sort((a, b) => a.rp3 - b.rp3).slice(0, 800).forEach(r => sampled.set(r.id, r));
  // 5. Random 600 from rest
  const rest = v17.filter(r => !sampled.has(r.id));
  for (let i = 0; i < 600 && rest.length > 0; i++) {
    const idx = Math.floor(Math.random() * rest.length);
    sampled.set(rest[idx].id, rest[idx]);
    rest.splice(idx, 1);
  }
  const configs = [...sampled.values()];
  console.log('Sampled configs (deduped): ' + configs.length + '\n');

  console.log('Loading ' + SLATES.length + ' slates...');
  const cache: SlateData[] = [];
  for (const s of SLATES) {
    try { const sd = await loadSlate(s); if (sd) { cache.push(sd); } } catch (e: any) { console.log('  skip ' + s.slate + ': ' + e.message); }
  }
  console.log(cache.length + ' slates loaded.\n');

  // Compute pro metrics per slate
  const proMetrics: Record<string, Map<string, PortfolioMetrics>> = { nerdytenor: new Map(), zroth: new Map() };
  for (const sd of cache) {
    const nerdy = extractPro(sd.actuals, sd.nameMap, ['nerdytenor']);
    const zroth = extractPro(sd.actuals, sd.nameMap, ['zroth', 'zroth2']);
    if (nerdy.length > 0) proMetrics.nerdytenor.set(sd.slate, computeMetrics(nerdy));
    if (zroth.length > 0) proMetrics.zroth.set(sd.slate, computeMetrics(zroth));
  }
  const nerdySlates = [...proMetrics.nerdytenor.keys()];
  const zrothSlates = [...proMetrics.zroth.keys()];
  console.log('Nerdy slates: ' + nerdySlates.length + ', Zroth slates: ' + zrothSlates.length + '\n');

  console.log('Evaluating ' + configs.length + ' configs × ' + cache.length + ' slates...');
  const t_start = Date.now();
  const results: Array<{ id: string; cfg: any; trackNerdy: number; trackZroth: number; trackBoth: number; perMetric: { meanOwn: number; meanProj: number; ownStdWithinLineup: number; meanPairwiseOverlap: number; maxPairwiseOverlap: number; uniqueTeams: number; maxTeamExposure: number } }> = [];
  for (let i = 0; i < configs.length; i++) {
    const c = configs[i];
    const perSlateMetrics: Map<string, PortfolioMetrics> = new Map();
    for (const sd of cache) {
      try {
        const result = productionSelect(sd.candidates, sd.players, buildRunCfg(c.cfg, sd));
        const lineups: Player[][] = result.portfolio.map(lu => lu.players);
        perSlateMetrics.set(sd.slate, computeMetrics(lineups));
      } catch {}
    }

    // Nerdy correlation
    const nerdyRs: number[] = [];
    for (const m of METRIC_KEYS) {
      const xs = nerdySlates.filter(s => perSlateMetrics.has(s)).map(s => (proMetrics.nerdytenor.get(s) as any)[m]);
      const ys = nerdySlates.filter(s => perSlateMetrics.has(s)).map(s => (perSlateMetrics.get(s) as any)[m]);
      if (xs.length >= 3) nerdyRs.push(pearson(xs, ys));
    }
    const trackNerdy = mean(nerdyRs.map(r => Math.abs(r)));

    // Zroth correlation
    const zrothRs: number[] = [];
    for (const m of METRIC_KEYS) {
      const xs = zrothSlates.filter(s => perSlateMetrics.has(s)).map(s => (proMetrics.zroth.get(s) as any)[m]);
      const ys = zrothSlates.filter(s => perSlateMetrics.has(s)).map(s => (perSlateMetrics.get(s) as any)[m]);
      if (xs.length >= 3) zrothRs.push(pearson(xs, ys));
    }
    const trackZroth = mean(zrothRs.map(r => Math.abs(r)));

    const trackBoth = (trackNerdy + trackZroth) / 2;

    // Save per-metric pearson for the BOTH-track later
    const pmObj: any = {};
    for (let mi = 0; mi < METRIC_KEYS.length; mi++) {
      const k = METRIC_KEYS[mi];
      const xn = nerdySlates.filter(s => perSlateMetrics.has(s)).map(s => (proMetrics.nerdytenor.get(s) as any)[k]);
      const yn = nerdySlates.filter(s => perSlateMetrics.has(s)).map(s => (perSlateMetrics.get(s) as any)[k]);
      pmObj[k] = xn.length >= 3 ? pearson(xn, yn) : 0;
    }
    results.push({ id: c.id, cfg: c.cfg, trackNerdy, trackZroth, trackBoth, perMetric: pmObj });

    if ((i + 1) % 100 === 0) {
      const elapsed = (Date.now() - t_start) / 60;
      const rate = (i + 1) / elapsed * 60;
      const remain = (configs.length - i - 1) / rate * 60;
      console.log('  [' + (i + 1) + '/' + configs.length + ' ' + ((i + 1) / configs.length * 100).toFixed(0) + '%, ' + (elapsed / 60).toFixed(1) + 'm, ETA ' + remain.toFixed(0) + 'm]');
    }
  }

  console.log('\nDone in ' + ((Date.now() - t_start) / 60000).toFixed(1) + ' min. Saving...');
  fs.writeFileSync(OUT_JSON, JSON.stringify(results, null, 0));

  // Reports
  const fmt = (r: any, scoreLabel: string) => {
    const v17r = v17.find(x => x.id === r.id);
    const v18r = v18ById.get(r.id);
    const fROI18 = v18r ? ((v18r.fullPayV18 / (18 * 150 * 20) - 1) * 100).toFixed(0) + '%' : 'n/a';
    const oROI = v17r ? ((v17r.oosPay / (5 * 150 * 20) - 1) * 100).toFixed(0) + '%' : 'n/a';
    const disp = v17r ? (v17r.meanIqrFrac * 100).toFixed(1) + '%' : 'n/a';
    return r.id.padEnd(50) + ' | ' + scoreLabel + '=' + (r as any)[scoreLabel].toFixed(3) + ' | nerdy=' + r.trackNerdy.toFixed(3) + ' zroth=' + r.trackZroth.toFixed(3) + ' | full18=' + fROI18 + ' OOS5=' + oROI + ' disp=' + disp;
  };

  console.log('\n=== TOP 25 BY NERDY TRACKING ===');
  [...results].sort((a, b) => b.trackNerdy - a.trackNerdy).slice(0, 25).forEach(r => console.log('  ' + fmt(r, 'trackNerdy')));

  console.log('\n=== TOP 25 BY ZROTH TRACKING ===');
  [...results].sort((a, b) => b.trackZroth - a.trackZroth).slice(0, 25).forEach(r => console.log('  ' + fmt(r, 'trackZroth')));

  console.log('\n=== TOP 25 BY COMBINED TRACKING (avg of nerdy + zroth) ===');
  [...results].sort((a, b) => b.trackBoth - a.trackBoth).slice(0, 25).forEach(r => console.log('  ' + fmt(r, 'trackBoth')));

  // Cerberus comparison
  const cerberus = results.find(r => r.id === 'C:chimera-nbr|1428');
  if (cerberus) {
    const rNerdy = [...results].sort((a, b) => b.trackNerdy - a.trackNerdy).findIndex(r => r.id === cerberus.id) + 1;
    const rZroth = [...results].sort((a, b) => b.trackZroth - a.trackZroth).findIndex(r => r.id === cerberus.id) + 1;
    const rBoth = [...results].sort((a, b) => b.trackBoth - a.trackBoth).findIndex(r => r.id === cerberus.id) + 1;
    console.log('\n=== CERBERUS (|1428) RANKS ===');
    console.log('  nerdy: #' + rNerdy + ' of ' + results.length + ' (|r|=' + cerberus.trackNerdy.toFixed(3) + ')');
    console.log('  zroth: #' + rZroth + ' of ' + results.length + ' (|r|=' + cerberus.trackZroth.toFixed(3) + ')');
    console.log('  combined: #' + rBoth + ' of ' + results.length + ' (|r|=' + cerberus.trackBoth.toFixed(3) + ')');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
