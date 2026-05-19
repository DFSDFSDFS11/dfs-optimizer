/**
 * Portfolio stats: Argus-Atlas vs each named pro, with ceiling=p99 (not p75).
 *
 * For each portfolio (pro's 150 entries or Argus's 150 selected):
 *   - meanProj per lineup (sum across 10 players)
 *   - meanCeiling per lineup using p99
 *   - meanOwn per lineup (avg of player ownership pct)
 *   - within-lineup std of player ownership (the actual ownStdRatio numerator)
 *   - across-portfolio std of {lineup proj, lineup ceiling, lineup own, actual pts}
 *
 * Reads Argus from saved CSV files for v9e_32slate runs.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestEntry } from '../parser';
import { getContestConfig } from '../rules';

const DIR = 'C:/Users/colin/dfs opto';
const OUT_DIR = path.join(DIR, 'multi_combo_penalty_implementation');

const SLATES = [
  '4-8-26','4-12-26','4-14-26','4-15-26','4-17-26','4-18-26','4-19-26','4-20-26','4-21-26','4-22-26',
  '4-23-26','4-24-26','4-25-26','4-25-26-early','4-26-26','4-27-26','4-28-26','4-29-26',
  '5-1-26','5-2-26','5-2-26-main','5-3-26','5-3-26-late','5-4-26','5-4-26-late','5-5-26','5-6-26',
  '4-6-26',
  '5-8-26','5-10-26','5-10-26-late',  // new
];

const SLATE_FILES: Record<string, { proj: string; actuals: string }> = {
  '4-6-26': { proj: '4-6-26_projections.csv', actuals: 'dkactuals 4-6-26.csv' },
  '4-8-26': { proj: '4-8-26projections.csv', actuals: '4-8-26actuals.csv' },
  '4-12-26': { proj: '4-12-26projections.csv', actuals: '4-12-26actuals.csv' },
  '4-14-26': { proj: '4-14-26projections.csv', actuals: '4-14-26actuals.csv' },
  '4-15-26': { proj: '4-15-26projections.csv', actuals: '4-15-26actuals.csv' },
  '4-17-26': { proj: '4-17-26projections.csv', actuals: '4-17-26actuals.csv' },
  '4-18-26': { proj: '4-18-26projections.csv', actuals: '4-18-26actuals.csv' },
  '4-19-26': { proj: '4-19-26projections.csv', actuals: '4-19-26actuals.csv' },
  '4-20-26': { proj: '4-20-26projections.csv', actuals: '4-20-26actuals.csv' },
  '4-21-26': { proj: '4-21-26projections.csv', actuals: '4-21-26actuals.csv' },
  '4-22-26': { proj: '4-22-26projections.csv', actuals: '4-22-26actuals.csv' },
  '4-23-26': { proj: '4-23-26projections.csv', actuals: '4-23-26actuals.csv' },
  '4-24-26': { proj: '4-24-26projections.csv', actuals: '4-24-26actuals.csv' },
  '4-25-26': { proj: '4-25-26projections.csv', actuals: '4-25-26actuals.csv' },
  '4-25-26-early': { proj: '4-25-26projectionsearly.csv', actuals: '4-25-26actualsearly.csv' },
  '4-26-26': { proj: '4-26-26projections.csv', actuals: '4-26-26actuals.csv' },
  '4-27-26': { proj: '4-27-26projections.csv', actuals: '4-27-26actuals.csv' },
  '4-28-26': { proj: '4-28-26projections.csv', actuals: '4-28-26actuals.csv' },
  '4-29-26': { proj: '4-29-26projections.csv', actuals: '4-29-26actuals.csv' },
  '5-1-26': { proj: '5-1-26projections.csv', actuals: '5-1-26actuals.csv' },
  '5-2-26': { proj: '5-2-26projections.csv', actuals: '5-2-26actuals.csv' },
  '5-2-26-main': { proj: '5-2-26projectionsmain.csv', actuals: '5-2-26actualsmain.csv' },
  '5-3-26': { proj: '5-3-26projections.csv', actuals: '5-3-26actuals.csv' },
  '5-3-26-late': { proj: '5-3-26projectionslate.csv', actuals: '5-3-26actualslate.csv' },
  '5-4-26': { proj: '5-4-26projections.csv', actuals: '5-4-26actuals.csv' },
  '5-4-26-late': { proj: '5-4-26projectionslate.csv', actuals: '5-4-26actualslate.csv' },
  '5-5-26': { proj: '5-5-26projections.csv', actuals: '5-5-26actuals.csv' },
  '5-6-26': { proj: '5-6-26projections.csv', actuals: '5-6-26actuals.csv' },
  '5-8-26': { proj: '5-8-26projections.csv', actuals: '5-8-26actuals.csv' },
  '5-10-26': { proj: '5-10-26projections.csv', actuals: '5-10-26actuals.csv' },
  '5-10-26-late': { proj: '5-10-26projectionslate.csv', actuals: '5-10-26actualslate.csv' },
};

const PROS = [
  { label: 'nerdytenor', tokens: ['nerdytenor'] },
  { label: 'zroth', tokens: ['zroth', 'zroth2'] },
  { label: 'youdacao', tokens: ['youdacao'] },
  { label: 'shipmymoney', tokens: ['shipmymoney'] },
  { label: 'shaidyadvice', tokens: ['shaidyadvice'] },
  { label: 'bgreseth', tokens: ['bgreseth'] },
  { label: 'needlunchmoney', tokens: ['needlunchmoney'] },
];

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function extractUser(e: string): string { return (e || '').replace(/\s*\([^)]*\)\s*$/, '').trim(); }
function mean(a: number[]): number { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function stddev(a: number[]): number { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); }

function lineupStats(lineup: Player[]) {
  const owns = lineup.map(p => p.ownership || 0);
  return {
    proj: lineup.reduce((s, p) => s + (p.projection || 0), 0),
    ceiling99: lineup.reduce((s, p) => s + ((p as any).percentiles?.p99 || (p.projection || 0) * 1.35), 0),
    meanOwn: mean(owns),
    stdOwnWithin: stddev(owns),
  };
}

function rollup(lineups: Player[][], actuals: number[]) {
  const stats = lineups.map(lineupStats);
  return {
    n: lineups.length,
    avgProj: mean(stats.map(s => s.proj)),
    avgCeil99: mean(stats.map(s => s.ceiling99)),
    avgOwn: mean(stats.map(s => s.meanOwn)),
    avgStdOwnWithin: mean(stats.map(s => s.stdOwnWithin)),
    stdLineupProj: stddev(stats.map(s => s.proj)),
    stdLineupCeil99: stddev(stats.map(s => s.ceiling99)),
    stdLineupOwn: stddev(stats.map(s => s.meanOwn)),
    stdActual: stddev(actuals),
    meanActual: mean(actuals),
  };
}

async function main() {
  // Per-portfolio per-slate stats; aggregate across all slates.
  const groups: Record<string, ReturnType<typeof rollup>[]> = {};
  for (const lbl of [...PROS.map(p => p.label), 'argus-atlas']) groups[lbl] = [];

  for (const slate of SLATES) {
    const f = SLATE_FILES[slate];
    if (!f) continue;
    const projPath = path.join(DIR, f.proj);
    const actualsPath = path.join(DIR, f.actuals);
    if (!fs.existsSync(projPath) || !fs.existsSync(actualsPath)) continue;
    const pr = parseCSVFile(projPath, 'mlb', true);
    const cfg = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actualsObj = parseContestActuals(actualsPath, cfg);
    const nameMap = new Map<string, Player>();
    for (const p of pool.players) nameMap.set(norm(p.name), p);

    // Pros
    const byUser = new Map<string, ContestEntry[]>();
    for (const e of actualsObj.entries) {
      const u = extractUser(e.entryName);
      const arr = byUser.get(u); if (arr) arr.push(e); else byUser.set(u, [e]);
    }
    for (const pro of PROS) {
      let matched: ContestEntry[] = [];
      for (const [u, ents] of byUser) {
        if (pro.tokens.some(t => u.toLowerCase().includes(t))) matched = matched.concat(ents);
      }
      if (matched.length < 100) continue;
      const lus: Player[][] = []; const acts: number[] = [];
      for (const e of matched.slice(0, 150)) {
        const pls: Player[] = []; let ok = true;
        for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
        if (ok) { lus.push(pls); acts.push(e.actualPoints); }
      }
      if (lus.length >= 100) groups[pro.label].push(rollup(lus, acts));
    }

    // Argus from saved CSV (v9e_32slate run; falls back to v9c or other tags)
    const candidates = [
      `argus_v9e_32slate_lineups_${slate}.csv`,
      `argus_v9e_lineups_${slate}.csv`,
      `argus_v9c_lineups_${slate}.csv`,
    ];
    let argusFile: string | null = null;
    for (const cf of candidates) {
      if (fs.existsSync(path.join(OUT_DIR, cf))) { argusFile = path.join(OUT_DIR, cf); break; }
    }
    if (!argusFile) continue;
    const lines = fs.readFileSync(argusFile, 'utf-8').split('\n').slice(1).filter(l => l.trim());
    const lus: Player[][] = []; const acts: number[] = [];
    for (const line of lines) {
      const m = line.match(/"([^"]+)"/);
      if (!m) continue;
      const names = m[1].split('|');
      const pls: Player[] = []; let ok = true;
      for (const nm of names) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
      if (!ok) continue;
      lus.push(pls);
      let pts = 0;
      for (const p of pls) {
        const a = actualsObj.playerActualsByName.get(norm(p.name));
        pts += a?.fpts || 0;
      }
      acts.push(pts);
    }
    if (lus.length >= 100) groups['argus-atlas'].push(rollup(lus, acts));
  }

  // Aggregate
  console.log('Portfolio stats — averaged across slates (ceiling uses p99)\n');
  const header = `${'label'.padEnd(16)}  slates  avgProj  avgCeil99  avgOwn%  stdOwn-within  stdLU-proj  stdLU-ceil99  stdLU-own  stdActual  meanActual`;
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const [lbl, arr] of Object.entries(groups)) {
    if (!arr.length) continue;
    const a = arr;
    const f = (k: keyof typeof a[0]) => mean(a.map(x => x[k] as number));
    console.log(
      `${lbl.padEnd(16)}  ${String(a.length).padStart(6)} `
      + `${f('avgProj').toFixed(1).padStart(8)} `
      + `${f('avgCeil99').toFixed(1).padStart(10)} `
      + `${f('avgOwn').toFixed(2).padStart(8)} `
      + `${f('avgStdOwnWithin').toFixed(2).padStart(14)} `
      + `${f('stdLineupProj').toFixed(2).padStart(11)} `
      + `${f('stdLineupCeil99').toFixed(2).padStart(13)} `
      + `${f('stdLineupOwn').toFixed(2).padStart(10)} `
      + `${f('stdActual').toFixed(2).padStart(10)} `
      + `${f('meanActual').toFixed(1).padStart(11)}`
    );
  }
}

main().catch(e => { console.error(e); process.exit(1); });
