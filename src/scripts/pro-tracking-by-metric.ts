/**
 * Pro Tracking by Metric — for each scoring metric (full18, OOS7, dispersion, rp3),
 * pick the top config from v18 sweep, run on every slate, and compute Pearson r
 * across slates between our portfolio metrics and (nerdytenor / zroth) 150-maxer
 * actual portfolios.
 *
 * Output: per-metric × per-pro tracking score (avg |r| across 9 portfolio metrics).
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
const V18_JSON = path.join(DIR, 'mlb_megabin3_sweep_v18.json');
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
  meanOwn: number;
  meanProj: number;
  meanCeiling: number;
  ownStdWithinLineup: number;
  meanPairwiseOverlap: number;
  maxPairwiseOverlap: number;
  nonFourStackPct: number;
  uniqueTeams: number;
  maxTeamExposure: number;
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
  console.log('PRO TRACKING BY METRIC — nerdy + zroth vs our top configs across slates');
  console.log('================================================================\n');

  console.log('Loading v18 sweep top configs...');
  const v18 = JSON.parse(fs.readFileSync(V18_JSON, 'utf-8')) as any[];

  // Identify top config per metric
  const topByFull = [...v18].sort((a, b) => b.fullPayV18 - a.fullPayV18)[0];
  const topByOos = [...v18].sort((a, b) => ((b.oosPay + b.newSlatePay + b.newSlate2Pay)) - ((a.oosPay + a.newSlatePay + a.newSlate2Pay)))[0];
  const topByDisp = [...v18].sort((a, b) => b.meanIqrFrac - a.meanIqrFrac)[0];
  // 3-way rp3 (full18 + OOS7 + disp)
  const rFull = new Map<string, number>(), rOos = new Map<string, number>(), rDisp = new Map<string, number>();
  [...v18].sort((a, b) => b.fullPayV18 - a.fullPayV18).forEach((r, i) => rFull.set(r.id, i + 1));
  [...v18].sort((a, b) => ((b.oosPay + b.newSlatePay + b.newSlate2Pay)) - ((a.oosPay + a.newSlatePay + a.newSlate2Pay))).forEach((r, i) => rOos.set(r.id, i + 1));
  [...v18].sort((a, b) => b.meanIqrFrac - a.meanIqrFrac).forEach((r, i) => rDisp.set(r.id, i + 1));
  const topByRp3 = [...v18].map(r => ({ ...r, rp3: rFull.get(r.id)! + rOos.get(r.id)! + rDisp.get(r.id)! })).sort((a, b) => a.rp3 - b.rp3)[0];
  // |2475 (rp2 winner — full+OOS without dispersion)
  const topByRp2 = [...v18].map(r => ({ ...r, rp2: rFull.get(r.id)! + rOos.get(r.id)! })).sort((a, b) => a.rp2 - b.rp2)[0];

  // Shipped Chimera config (for comparison)
  const SHIPPED_CHIMERA = {
    id: 'SHIPPED_CHIMERA',
    cfg: { phase: 'C', lam: 0.62, tc: 0.24, mps: 5, me: 0.16, mep: 0.41, corner: true, power: 2,
           alloc: [0.05, 0.05, 0.85, 0.03, 0.02] }
  };

  const selectors = [
    { label: 'Cerberus (rp3 #1, disp #1)', cfg: topByRp3, source: topByRp3.id },
    { label: '|3826 (full18 #1, mps=4)', cfg: topByFull, source: topByFull.id },
    { label: 'OOS7 #1', cfg: topByOos, source: topByOos.id },
    { label: '|2475 (rp2 winner — full+OOS)', cfg: topByRp2, source: topByRp2.id },
    { label: 'Shipped Chimera (benchmark)', cfg: SHIPPED_CHIMERA, source: 'SHIPPED' },
  ];

  console.log('Selectors to test:');
  for (const s of selectors) console.log('  ' + s.label.padEnd(35) + ' — ' + s.source);

  console.log('\nLoading ' + SLATES.length + ' slates...');
  const cache: SlateData[] = [];
  for (const s of SLATES) {
    try {
      const sd = await loadSlate(s);
      if (sd) {
        cache.push(sd);
        console.log('  ' + s.slate + ' loaded.');
      }
    } catch (e: any) { console.log('  skip ' + s.slate + ': ' + e.message); }
  }
  console.log(cache.length + ' slates loaded.\n');

  // For each slate, extract pro portfolios + compute per-selector portfolios + metrics
  const proMetrics: Record<string, Map<string, PortfolioMetrics>> = { nerdytenor: new Map(), zroth: new Map() };
  const selMetrics: Map<string, Map<string, PortfolioMetrics>> = new Map();
  for (const s of selectors) selMetrics.set(s.label, new Map());

  for (const sd of cache) {
    const nerdyLineups = extractPro(sd.actuals, sd.nameMap, ['nerdytenor']);
    const zrothLineups = extractPro(sd.actuals, sd.nameMap, ['zroth', 'zroth2']);
    if (nerdyLineups.length > 0) proMetrics.nerdytenor.set(sd.slate, computeMetrics(nerdyLineups));
    if (zrothLineups.length > 0) proMetrics.zroth.set(sd.slate, computeMetrics(zrothLineups));
    console.log('  ' + sd.slate + ': nerdy=' + nerdyLineups.length + ' zroth=' + zrothLineups.length);

    for (const s of selectors) {
      try {
        const result = productionSelect(sd.candidates, sd.players, buildRunCfg(s.cfg.cfg, sd));
        const lineups: Player[][] = result.portfolio.map(lu => lu.players);
        selMetrics.get(s.label)!.set(sd.slate, computeMetrics(lineups));
      } catch {}
    }
  }

  // For each pro × each selector, compute Pearson r per metric, then composite |r| avg
  for (const proName of ['nerdytenor', 'zroth'] as const) {
    const slatesWithPro = [...proMetrics[proName].keys()];
    if (slatesWithPro.length < 3) {
      console.log('\n=== ' + proName.toUpperCase() + ' — only ' + slatesWithPro.length + ' slates available, skipping ===');
      continue;
    }
    console.log('\n================================================================');
    console.log(proName.toUpperCase() + ' tracking — ' + slatesWithPro.length + ' slates');
    console.log('================================================================\n');

    const rows: { sel: string; rs: number[]; comp: number }[] = [];
    for (const s of selectors) {
      const rs: number[] = [];
      for (const m of METRIC_KEYS) {
        const proSeries = slatesWithPro.map(sl => (proMetrics[proName].get(sl) as any)[m]);
        const selSeries = slatesWithPro.map(sl => {
          const v = selMetrics.get(s.label)!.get(sl); return v ? (v as any)[m] : NaN;
        });
        const valid = proSeries.map((p, i) => [p, selSeries[i]]).filter(([_, q]) => !isNaN(q));
        if (valid.length < 3) { rs.push(0); continue; }
        rs.push(pearson(valid.map(v => v[0]), valid.map(v => v[1])));
      }
      const comp = mean(rs.map(r => Math.abs(r)));
      rows.push({ sel: s.label, rs, comp });
    }

    console.log('Metric'.padEnd(28) + selectors.map(s => s.label.slice(0, 16).padStart(18)).join('') + '');
    for (let i = 0; i < METRIC_KEYS.length; i++) {
      const k = METRIC_KEYS[i];
      let row = k.padEnd(28);
      for (const r of rows) row += r.rs[i].toFixed(3).padStart(18);
      console.log(row);
    }
    console.log('-'.repeat(28 + 18 * selectors.length));
    let compRow = 'composite |r|'.padEnd(28);
    for (const r of rows) compRow += r.comp.toFixed(3).padStart(18);
    console.log(compRow);

    // Rank
    console.log('\n--- Ranked by composite |r| (higher = tracks ' + proName + ' more closely) ---');
    [...rows].sort((a, b) => b.comp - a.comp).forEach((r, i) => {
      console.log('  #' + (i + 1) + ' ' + r.sel.padEnd(35) + ' composite |r| = ' + r.comp.toFixed(3));
    });
  }
}

main().catch(e => { console.error(e); process.exit(1); });
