/**
 * Portfolio Std Analysis — measure two distinct std dimensions for each pro
 * across all 22 slates, compared to field-random and SS-pool-top-150.
 *
 * Std-A (intra-lineup variance):    avg of per-lineup (ceiling - floor)
 * Std-B (inter-lineup proj spread): std of {lineup projection} across portfolio
 * Std-B-own (inter-lineup own spread): std of {lineup avg ownership}
 * Std-B-actual (outcome spread):     std of {lineup actual pts}
 *
 * Outputs Markdown table: per pro × per slate + aggregate means.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import {
  parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestEntry,
} from '../parser';
import { getContestConfig } from '../rules';

const DIR = 'C:/Users/colin/dfs opto';
const OUT_DIR = path.join(DIR, 'multi_combo_penalty_implementation');

const SLATES = [
  { slate: '4-6-26',  proj: '4-6-26_projections.csv', actuals: 'dkactuals 4-6-26.csv',     pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26',  proj: '4-8-26projections.csv',  actuals: '4-8-26actuals.csv',        pool: '4-8-26sspool.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv', actuals: '4-12-26actuals.csv',       pool: '4-12-26sspool.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv', actuals: '4-14-26actuals.csv',       pool: '4-14-26sspool.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv', actuals: '4-15-26actuals.csv',       pool: '4-15-26sspool.csv' },
  { slate: '4-17-26', proj: '4-17-26projections.csv', actuals: '4-17-26actuals.csv',       pool: '4-17-26sspool.csv' },
  { slate: '4-18-26', proj: '4-18-26projections.csv', actuals: '4-18-26actuals.csv',       pool: '4-18-26sspool.csv' },
  { slate: '4-19-26', proj: '4-19-26projections.csv', actuals: '4-19-26actuals.csv',       pool: '4-19-26sspool.csv' },
  { slate: '4-20-26', proj: '4-20-26projections.csv', actuals: '4-20-26actuals.csv',       pool: '4-20-26sspool.csv' },
  { slate: '4-21-26', proj: '4-21-26projections.csv', actuals: '4-21-26actuals.csv',       pool: '4-21-26sspool.csv' },
  { slate: '4-22-26', proj: '4-22-26projections.csv', actuals: '4-22-26actuals.csv',       pool: '4-22-26sspool.csv' },
  { slate: '4-23-26', proj: '4-23-26projections.csv', actuals: '4-23-26actuals.csv',       pool: '4-23-26sspool.csv' },
  { slate: '4-24-26', proj: '4-24-26projections.csv', actuals: '4-24-26actuals.csv',       pool: '4-24-26sspool.csv' },
  { slate: '4-25-26', proj: '4-25-26projections.csv', actuals: '4-25-26actuals.csv',       pool: '4-25-26sspool.csv' },
  { slate: '4-25-26-early', proj: '4-25-26projectionsearly.csv', actuals: '4-25-26actualsearly.csv', pool: '4-25-26sspoolearly.csv' },
  { slate: '4-26-26', proj: '4-26-26projections.csv', actuals: '4-26-26actuals.csv',       pool: '4-26-26sspool.csv' },
  { slate: '4-27-26', proj: '4-27-26projections.csv', actuals: '4-27-26actuals.csv',       pool: '4-27-26sspool.csv' },
  { slate: '4-28-26', proj: '4-28-26projections.csv', actuals: '4-28-26actuals.csv',       pool: '4-28-26sspool.csv' },
  { slate: '4-29-26', proj: '4-29-26projections.csv', actuals: '4-29-26actuals.csv',       pool: '4-29-26sspool.csv' },
  { slate: '5-3-26',  proj: '5-3-26projections.csv',  actuals: '5-3-26actuals.csv',        pool: '5-3-26sspool.csv' },
  { slate: '5-5-26',  proj: '5-5-26projections.csv',  actuals: '5-5-26actuals.csv',        pool: '5-5-26sspool.csv' },
  { slate: '5-6-26',  proj: '5-6-26projections.csv',  actuals: '5-6-26actuals.csv',        pool: '5-6-26sspool.csv' },
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

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function extractUser(entryName: string): string { return (entryName || '').replace(/\s*\([^)]*\)\s*$/, '').trim(); }
function mean(a: number[]): number { if (!a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; }
function stddev(a: number[]): number { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); }

interface PortfolioStats {
  label: string;
  slate: string;
  n_lineups: number;
  // Std-A: intra-lineup variance proxy (avg of per-lineup ceiling - floor).
  stdA_range: number;
  // Std-A alternative: average projection of the lineups themselves
  meanProj: number;
  meanCeil: number;
  meanOwn: number;
  meanActual: number;
  // Std-B: portfolio-level spread.
  stdB_proj: number;
  stdB_ceil: number;
  stdB_own: number;
  stdB_actual: number;
  // CV (coefficient of variation): std / mean.
  cv_proj: number;
  cv_actual: number;
}

function computeStats(label: string, slate: string, lineups: Player[][], actualPts: number[]): PortfolioStats {
  const lineupProj: number[] = [];
  const lineupCeil: number[] = [];
  const lineupFloor: number[] = [];
  const lineupOwn: number[] = [];
  const lineupRange: number[] = [];
  for (const lu of lineups) {
    let proj = 0, ceil = 0, floor = 0, own = 0;
    for (const p of lu) {
      proj += p.projection || 0;
      ceil += (p as any).percentiles?.p75 || (p.projection || 0) * 1.15;
      floor += (p as any).percentiles?.p25 || (p.projection || 0) * 0.85;
      own += p.ownership || 0;
    }
    lineupProj.push(proj);
    lineupCeil.push(ceil);
    lineupFloor.push(floor);
    lineupOwn.push(own / lu.length);
    lineupRange.push(ceil - floor);
  }
  const mProj = mean(lineupProj);
  const mCeil = mean(lineupCeil);
  const mOwn = mean(lineupOwn);
  const mAct = mean(actualPts);
  return {
    label, slate, n_lineups: lineups.length,
    stdA_range: mean(lineupRange),  // intra-lineup variance proxy
    meanProj: mProj,
    meanCeil: mCeil,
    meanOwn: mOwn,
    meanActual: mAct,
    stdB_proj: stddev(lineupProj),
    stdB_ceil: stddev(lineupCeil),
    stdB_own: stddev(lineupOwn),
    stdB_actual: stddev(actualPts),
    cv_proj: mProj > 0 ? stddev(lineupProj) / mProj : 0,
    cv_actual: mAct > 0 ? stddev(actualPts) / mAct : 0,
  };
}

async function main() {
  console.log('================================================================');
  console.log('PORTFOLIO STD ANALYSIS — Std-A (intra-lineup) + Std-B (inter-lineup)');
  console.log('================================================================\n');

  const allStats: PortfolioStats[] = [];

  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj);
    const actualsPath = path.join(DIR, s.actuals);
    const poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) continue;

    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);
    const nameMap = new Map<string, Player>();
    for (const p of pool.players) nameMap.set(norm(p.name), p);

    // Group entries by user.
    const byUser = new Map<string, ContestEntry[]>();
    for (const e of actuals.entries) {
      const u = extractUser(e.entryName);
      const arr = byUser.get(u); if (arr) arr.push(e); else byUser.set(u, [e]);
    }

    for (const pro of PROS) {
      let matched: ContestEntry[] = [];
      for (const [u, ents] of byUser) {
        if (pro.tokens.some(t => u.toLowerCase().includes(t))) matched = matched.concat(ents);
      }
      if (matched.length < 100) continue;
      const lineups: Player[][] = [];
      const actualPts: number[] = [];
      for (const e of matched.slice(0, 150)) {
        const pls: Player[] = []; let ok = true;
        for (const nm of e.playerNames) { const pl = nameMap.get(norm(nm)); if (!pl) { ok = false; break; } pls.push(pl); }
        if (ok) { lineups.push(pls); actualPts.push(e.actualPoints); }
      }
      if (lineups.length < 100) continue;
      allStats.push(computeStats(pro.label, s.slate, lineups, actualPts));
    }

    // Field-random baseline: sample 150 random entries.
    const allOK: { lu: Player[]; pts: number }[] = [];
    for (const e of actuals.entries) {
      const pls: Player[] = []; let ok = true;
      for (const nm of e.playerNames) { const pl = nameMap.get(norm(nm)); if (!pl) { ok = false; break; } pls.push(pl); }
      if (ok) allOK.push({ lu: pls, pts: e.actualPoints });
    }
    if (allOK.length >= 150) {
      const shuffled = allOK.slice().sort(() => Math.random() - 0.5).slice(0, 150);
      const lus = shuffled.map(x => x.lu);
      const pts = shuffled.map(x => x.pts);
      allStats.push(computeStats('field-random', s.slate, lus, pts));
    }

    // Argus-v9-C — load saved lineups for this slate.
    const v9cPath = path.join(OUT_DIR, `argus_v9c_lineups_${s.slate}.csv`);
    if (fs.existsSync(v9cPath)) {
      try {
        const lines = fs.readFileSync(v9cPath, 'utf-8').split('\n').slice(1).filter(l => l.trim());
        const v9cLus: Player[][] = [];
        const v9cPts: number[] = [];
        for (const line of lines) {
          // CSV format: rank,proj,own,ev,variance,"players"
          const match = line.match(/"([^"]+)"/);
          if (!match) continue;
          const playerNames = match[1].split('|');
          const pls: Player[] = []; let ok = true;
          for (const nm of playerNames) { const pl = nameMap.get(norm(nm)); if (!pl) { ok = false; break; } pls.push(pl); }
          if (!ok) continue;
          v9cLus.push(pls);
          let pts = 0;
          for (const p of pls) {
            const a = actuals.playerActualsByName.get(norm(p.name));
            pts += a?.fpts || 0;
          }
          v9cPts.push(pts);
        }
        if (v9cLus.length >= 100) allStats.push(computeStats('argus-v9c', s.slate, v9cLus, v9cPts));
      } catch (e) { /* ignore */ }
    }

    // SS-pool top-150 by projection (naive optimizer).
    const ssLoaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: new Map(pool.players.map(p => [p.id, p])) });
    const ssLineups = Array.from(new Map(ssLoaded.lineups.map(l => [l.hash, l])).values());
    const top150ByProj = [...ssLineups].sort((a, b) => b.projection - a.projection).slice(0, 150);
    if (top150ByProj.length >= 100) {
      const lus = top150ByProj.map(l => l.players);
      // Compute actual pts by joining player names to actuals.
      const pts = lus.map(lu => {
        let p = 0;
        for (const player of lu) {
          const a = actuals.playerActualsByName.get(norm(player.name));
          p += a?.fpts || 0;
        }
        return p;
      });
      allStats.push(computeStats('ss-top150-proj', s.slate, lus, pts));
    }

    console.log(`${s.slate.padEnd(15)} done — ${allStats.filter(x => x.slate === s.slate).length} portfolios`);
  }

  // Aggregate per label.
  const labels = Array.from(new Set(allStats.map(x => x.label)));
  const lines: string[] = [];
  lines.push('# Portfolio Std Analysis');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Slates: ${SLATES.length} | Pros: ${PROS.length}\n`);

  lines.push('## Aggregate per-label means across slates\n');
  lines.push('|       label        | n  | stdA_range | meanProj | stdB_proj | CV_proj | meanCeil | stdB_ceil | stdB_own | meanOwn | stdB_actual | meanActual | CV_actual |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const lbl of labels) {
    const rows = allStats.filter(x => x.label === lbl);
    if (!rows.length) continue;
    const stdA = mean(rows.map(r => r.stdA_range));
    const mProj = mean(rows.map(r => r.meanProj));
    const sProj = mean(rows.map(r => r.stdB_proj));
    const cvProj = mean(rows.map(r => r.cv_proj));
    const mCeil = mean(rows.map(r => r.meanCeil));
    const sCeil = mean(rows.map(r => r.stdB_ceil));
    const sOwn = mean(rows.map(r => r.stdB_own));
    const mOwn = mean(rows.map(r => r.meanOwn));
    const sActual = mean(rows.map(r => r.stdB_actual));
    const mAct = mean(rows.map(r => r.meanActual));
    const cvAct = mean(rows.map(r => r.cv_actual));
    lines.push(`| ${lbl.padEnd(18)} | ${rows.length} | ${stdA.toFixed(2)} | ${mProj.toFixed(1)} | ${sProj.toFixed(2)} | ${cvProj.toFixed(4)} | ${mCeil.toFixed(1)} | ${sCeil.toFixed(2)} | ${sOwn.toFixed(2)} | ${mOwn.toFixed(2)} | ${sActual.toFixed(2)} | ${mAct.toFixed(1)} | ${cvAct.toFixed(4)} |`);
  }

  // Console summary.
  console.log('\n========== AGGREGATE ==========');
  console.log('label              stdA_range  meanProj  stdB_proj  stdB_own  stdB_actual');
  for (const lbl of labels) {
    const rows = allStats.filter(x => x.label === lbl);
    if (!rows.length) continue;
    console.log(`${lbl.padEnd(18)} ${mean(rows.map(r => r.stdA_range)).toFixed(2).padStart(9)} ${mean(rows.map(r => r.meanProj)).toFixed(1).padStart(8)} ${mean(rows.map(r => r.stdB_proj)).toFixed(2).padStart(9)} ${mean(rows.map(r => r.stdB_own)).toFixed(2).padStart(8)} ${mean(rows.map(r => r.stdB_actual)).toFixed(2).padStart(10)}`);
  }

  // Save full report.
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, 'portfolio_std_analysis.md');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`\nSaved: ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
