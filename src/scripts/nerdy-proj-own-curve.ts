/**
 * Nerdytenor Projection-vs-Ownership Curve Measurement
 *
 * For each of nerdy's 1,200 lineups (8 slates × 150) compute two percentiles:
 *   - Projection percentile rank within that slate's SS pool
 *   - Avg ownership percentile rank within that slate's SS pool
 *
 * Aggregate across slates. Report:
 *   - Overall Pearson correlation
 *   - Correlation by projection quintile (tests whether diagonal is tighter at extremes)
 *   - 2D histogram of (proj_q, own_q) cells
 *   - Bottom-quintile sanity check: pct of lowest-proj nerdy lineups that are above median ownership
 *
 * Same measurement for production's shipped portfolio for comparison.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';
import { productionSelect } from '../selection/production-selector';
import { precomputeComboFrequencies } from '../selection/combo-leverage';

const DIR = 'C:/Users/colin/dfs opto';
const N = 150;
const LAMBDA = 0.05;
const GAMMA = 7;

const SLATES = [
  { slate: '4-6-26', proj: '4-6-26_projections.csv', actuals: 'dkactuals 4-6-26.csv', pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26', proj: '4-8-26projections.csv', actuals: '4-8-26actuals.csv', pool: '4-8-26sspool.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv', actuals: '4-12-26actuals.csv', pool: '4-12-26sspool.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv', actuals: '4-14-26actuals.csv', pool: '4-14-26sspool.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv', actuals: '4-15-26actuals.csv', pool: '4-15-26sspool.csv' },
  { slate: '4-17-26', proj: '4-17-26projections.csv', actuals: '4-17-26actuals.csv', pool: '4-17-26sspool.csv' },
  { slate: '4-19-26', proj: '4-19-26projections.csv', actuals: '4-19-26actuals.csv', pool: '4-19-26sspool.csv' },
  { slate: '4-20-26', proj: '4-20-26projections.csv', actuals: '4-20-26actuals.csv', pool: '4-20-26sspool.csv' },
];

function norm(n: string): string {
  return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function lineupProj(players: Player[]): number {
  return players.reduce((s, p) => s + (p.projection || 0), 0);
}

function lineupOwn(players: Player[]): number {
  return players.reduce((s, p) => s + (p.ownership || 0), 0) / players.length;
}

/** Map a value to percentile [0,1] given a sorted array (ascending). */
function percentileOf(v: number, sortedAsc: number[]): number {
  if (sortedAsc.length === 0) return 0;
  // Binary search for first index where sortedAsc[i] >= v
  let lo = 0, hi = sortedAsc.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedAsc[mid] < v) lo = mid + 1; else hi = mid;
  }
  // lo = number of pool lineups strictly below v
  return lo / sortedAsc.length;
}

function pearson(xs: number[], ys: number[]): number {
  if (xs.length !== ys.length || xs.length < 2) return 0;
  const n = xs.length;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
  }
  return num / (Math.sqrt(dx2 * dy2) || 1);
}

function resolveLineup(playerNames: string[], nameMap: Map<string, Player>): Player[] | null {
  const pls: Player[] = [];
  for (const nm of playerNames) {
    const p = nameMap.get(norm(nm));
    if (!p) return null;
    pls.push(p);
  }
  return pls;
}

async function main() {
  const out: string[] = [];
  out.push('# Nerdytenor Projection-vs-Ownership Curve\n');
  out.push(`Generated ${new Date().toISOString()}\n`);
  out.push('For each lineup, compute projection percentile rank and avg-ownership percentile rank within that slate\'s SS pool distribution.\n');

  const nerdyProjPct: number[] = [];
  const nerdyOwnPct: number[] = [];
  const prodProjPct: number[] = [];
  const prodOwnPct: number[] = [];

  const perSlate: Array<{
    slate: string;
    nerdyN: number; prodN: number;
    nerdyCorr: number; prodCorr: number;
  }> = [];

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
    const idMap = new Map<string, Player>();
    for (const p of pool.players) idMap.set(p.id, p);

    const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });

    // Build sorted arrays for percentile lookup
    const poolProjs = loaded.lineups.map(lu => lineupProj(lu.players)).sort((a, b) => a - b);
    const poolOwns = loaded.lineups.map(lu => lineupOwn(lu.players)).sort((a, b) => a - b);

    // Nerdy
    const nerdyEntries = actuals.entries.filter(e => e.entryName.toLowerCase().includes('nerdytenor'));
    const slateNerdyProjPct: number[] = [];
    const slateNerdyOwnPct: number[] = [];
    for (const e of nerdyEntries) {
      const pls = resolveLineup(e.playerNames, nameMap);
      if (!pls) continue;
      const pj = lineupProj(pls);
      const ow = lineupOwn(pls);
      slateNerdyProjPct.push(percentileOf(pj, poolProjs));
      slateNerdyOwnPct.push(percentileOf(ow, poolOwns));
    }
    nerdyProjPct.push(...slateNerdyProjPct);
    nerdyOwnPct.push(...slateNerdyOwnPct);

    // Production
    const comboFreq = precomputeComboFrequencies(loaded.lineups, 3);
    const prodResult = productionSelect(loaded.lineups, pool.players, {
      N, lambda: LAMBDA, comboFreq, maxOverlap: GAMMA,
    });
    const slateProdProjPct: number[] = [];
    const slateProdOwnPct: number[] = [];
    for (const lu of prodResult.portfolio) {
      slateProdProjPct.push(percentileOf(lineupProj(lu.players), poolProjs));
      slateProdOwnPct.push(percentileOf(lineupOwn(lu.players), poolOwns));
    }
    prodProjPct.push(...slateProdProjPct);
    prodOwnPct.push(...slateProdOwnPct);

    perSlate.push({
      slate: s.slate,
      nerdyN: slateNerdyProjPct.length,
      prodN: slateProdProjPct.length,
      nerdyCorr: pearson(slateNerdyProjPct, slateNerdyOwnPct),
      prodCorr: pearson(slateProdProjPct, slateProdOwnPct),
    });
  }

  // ============================================================
  // Per-slate correlations
  // ============================================================
  console.log('\n=== Per-slate Pearson correlation (projection%, ownership%) ===\n');
  console.log('Slate      | nerdy n | nerdy corr | prod n | prod corr');
  console.log('-----------|---------|------------|--------|----------');
  for (const s of perSlate) {
    console.log(`${s.slate.padEnd(10)} | ${String(s.nerdyN).padStart(7)} | ${s.nerdyCorr.toFixed(3).padStart(10)} | ${String(s.prodN).padStart(6)} | ${s.prodCorr.toFixed(3).padStart(9)}`);
  }

  // ============================================================
  // Pooled correlation across all 1,200 nerdy lineups
  // ============================================================
  const overallNerdy = pearson(nerdyProjPct, nerdyOwnPct);
  const overallProd = pearson(prodProjPct, prodOwnPct);
  console.log('\n=== Pooled correlation across all slates ===\n');
  console.log(`Nerdy  (n=${nerdyProjPct.length}): r = ${overallNerdy.toFixed(3)}`);
  console.log(`Prod   (n=${prodProjPct.length}): r = ${overallProd.toFixed(3)}`);

  // ============================================================
  // Correlation within each projection quintile
  // ============================================================
  function corrByQuintile(projPct: number[], ownPct: number[], label: string) {
    console.log(`\n--- ${label}: correlation by projection quintile ---`);
    console.log('Quintile          | count | proj range | own mean | own min | own max | corr within');
    console.log('------------------|-------|------------|----------|---------|---------|-------------');
    const qs = [
      { band: 'Q1 (0-20%)', lo: 0.0, hi: 0.2 },
      { band: 'Q2 (20-40%)', lo: 0.2, hi: 0.4 },
      { band: 'Q3 (40-60%)', lo: 0.4, hi: 0.6 },
      { band: 'Q4 (60-80%)', lo: 0.6, hi: 0.8 },
      { band: 'Q5 (80-100%)', lo: 0.8, hi: 1.0 },
    ];
    for (const q of qs) {
      const idxs: number[] = [];
      for (let i = 0; i < projPct.length; i++) {
        if (projPct[i] >= q.lo && projPct[i] < q.hi) idxs.push(i);
      }
      if (q.hi === 1.0) {
        for (let i = 0; i < projPct.length; i++) if (projPct[i] === 1.0) idxs.push(i);
      }
      if (idxs.length < 2) {
        console.log(`${q.band.padEnd(17)} | ${String(idxs.length).padStart(5)} | (too few)`);
        continue;
      }
      const pxs = idxs.map(i => projPct[i]);
      const pys = idxs.map(i => ownPct[i]);
      const r = pearson(pxs, pys);
      const mn = Math.min(...pys), mx = Math.max(...pys);
      const avg = pys.reduce((s, v) => s + v, 0) / pys.length;
      console.log(`${q.band.padEnd(17)} | ${String(idxs.length).padStart(5)} | [${q.lo.toFixed(2)},${q.hi.toFixed(2)}] | ${avg.toFixed(3).padStart(8)} | ${mn.toFixed(3).padStart(7)} | ${mx.toFixed(3).padStart(7)} | ${r.toFixed(3).padStart(11)}`);
    }
  }
  corrByQuintile(nerdyProjPct, nerdyOwnPct, 'Nerdytenor');
  corrByQuintile(prodProjPct, prodOwnPct, 'Production');

  // ============================================================
  // 2D histogram: projection quintile × ownership quintile
  // ============================================================
  function hist2D(projPct: number[], ownPct: number[], label: string) {
    const H = [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]];
    for (let i = 0; i < projPct.length; i++) {
      const pi = Math.min(4, Math.floor(projPct[i] * 5));
      const oi = Math.min(4, Math.floor(ownPct[i] * 5));
      H[oi][pi]++;
    }
    const n = projPct.length;
    console.log(`\n--- ${label}: 2D histogram — rows=ownership quintile (top row=Q5 highest), cols=projection quintile (right=Q5 highest) ---\n`);
    console.log('         proj Q1    proj Q2    proj Q3    proj Q4    proj Q5');
    for (let o = 4; o >= 0; o--) {
      const row = [`own Q${o + 1}:`];
      for (let p = 0; p < 5; p++) {
        const cellPct = n ? (H[o][p] / n * 100).toFixed(1) : '0.0';
        row.push(`${(H[o][p] + '(' + cellPct + '%)').padStart(11)}`);
      }
      console.log(row.join(' '));
    }
  }
  hist2D(nerdyProjPct, nerdyOwnPct, 'Nerdytenor');
  hist2D(prodProjPct, prodOwnPct, 'Production');

  // ============================================================
  // Extreme-quintile analysis: low-proj + above-median own = "dominated" by pool
  // ============================================================
  function dominatedPct(projPct: number[], ownPct: number[]) {
    let bottomProj_aboveMedianOwn = 0;
    let bottomProj_total = 0;
    let topProj_belowMedianOwn = 0;
    let topProj_total = 0;
    for (let i = 0; i < projPct.length; i++) {
      if (projPct[i] < 0.2) {
        bottomProj_total++;
        if (ownPct[i] > 0.5) bottomProj_aboveMedianOwn++;
      }
      if (projPct[i] >= 0.8) {
        topProj_total++;
        if (ownPct[i] < 0.5) topProj_belowMedianOwn++;
      }
    }
    return {
      bottomProjAboveMedianOwn: bottomProj_total ? bottomProj_aboveMedianOwn / bottomProj_total * 100 : 0,
      bottomProjTotal: bottomProj_total,
      topProjBelowMedianOwn: topProj_total ? topProj_belowMedianOwn / topProj_total * 100 : 0,
      topProjTotal: topProj_total,
    };
  }

  const nd = dominatedPct(nerdyProjPct, nerdyOwnPct);
  const pd = dominatedPct(prodProjPct, prodOwnPct);
  console.log('\n=== Extreme-quintile analysis ===');
  console.log('"Dominated" = low-proj (Q1) lineup with above-median ownership — theoretically bad');
  console.log(`Nerdytenor: ${nd.bottomProjAboveMedianOwn.toFixed(1)}% of Q1-proj lineups have above-median ownership (${nd.bottomProjTotal} total Q1 lineups)`);
  console.log(`Production: ${pd.bottomProjAboveMedianOwn.toFixed(1)}% of Q1-proj lineups have above-median ownership (${pd.bottomProjTotal} total Q1 lineups)`);
  console.log();
  console.log('"Leverage spot" = high-proj (Q5) lineup with below-median ownership — theoretically good');
  console.log(`Nerdytenor: ${nd.topProjBelowMedianOwn.toFixed(1)}% of Q5-proj lineups have below-median ownership (${nd.topProjTotal} total Q5 lineups)`);
  console.log(`Production: ${pd.topProjBelowMedianOwn.toFixed(1)}% of Q5-proj lineups have below-median ownership (${pd.topProjTotal} total Q5 lineups)`);
}

main().catch(e => { console.error(e); process.exit(1); });
