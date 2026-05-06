/**
 * Relaxed stack filter backtest + nerdytenor non-4-stack composition audit.
 *
 * Step 1: audit nerdy's non-4-stack lineups — classify team compositions (3-3, 3-2, 2-2-2, etc)
 *         to verify filter matches pro's actual distribution.
 * Step 2: run 9-slate backtest comparing:
 *         - BASELINE: current production stack filter (max >= 4)
 *         - RELAXED: (max >= 4) OR (top1 + top2 >= 6 AND top2 >= 3)   [3-3 and 4-3 allowed]
 *         - WIDE:    (max >= 4) OR (top1 >= 3 AND top2 >= 2)          [also 3-2 allowed]
 *
 * Reports per-slate payout, composition of resulting portfolio.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals } from '../parser';
import { getContestConfig } from '../rules';
import { productionSelect, ProductionConfig } from '../selection/production-selector';
import { precomputeComboFrequencies } from '../selection/combo-leverage';

const DIR = 'C:/Users/colin/dfs opto';
const FEE = 20;
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
  { slate: '4-18-26', proj: '4-18-26projections.csv', actuals: '4-18-26actuals.csv', pool: '4-18-26sspool.csv' },
  { slate: '4-19-26', proj: '4-19-26projections.csv', actuals: '4-19-26actuals.csv', pool: '4-19-26sspool.csv' },
  { slate: '4-20-26', proj: '4-20-26projections.csv', actuals: '4-20-26actuals.csv', pool: '4-20-26sspool.csv' },
];

function norm(n: string): string {
  return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function teamCounts(players: Player[]): number[] {
  const counts = new Map<string, number>();
  for (const p of players) {
    if (p.positions?.includes('P')) continue;
    counts.set(p.team, (counts.get(p.team) || 0) + 1);
  }
  return [...counts.values()].sort((a, b) => b - a);
}

function shapeOf(players: Player[]): string {
  // e.g. [3,3,1,1] → "3-3"; [3,2,1,1,1,1] → "3-2"; [4,3,1] → "4-3"; [5,3] → "5-3"
  const c = teamCounts(players).filter(n => n >= 2);
  return c.length > 0 ? c.join('-') : 'no-stack';
}

function primaryTop2(players: Player[]): { top1: number; top2: number } {
  const c = teamCounts(players);
  return { top1: c[0] || 0, top2: c[1] || 0 };
}

function stackFilter(kind: 'baseline' | 'relaxed' | 'wide') {
  return (lu: Lineup): boolean => {
    const { top1, top2 } = primaryTop2(lu.players);
    if (kind === 'baseline') return top1 >= 4;
    if (kind === 'relaxed') return top1 >= 4 || (top1 >= 3 && top2 >= 3);
    if (kind === 'wide') return top1 >= 4 || (top1 >= 3 && top2 >= 2);
    return false;
  };
}

function buildPayoutTable(F: number): Float64Array {
  const pool = F * FEE * 0.88;
  const cashLine = Math.floor(F * 0.22);
  const raw = new Float64Array(cashLine);
  let rawSum = 0;
  for (let r = 0; r < cashLine; r++) { raw[r] = Math.pow(r + 1, -1.15); rawSum += raw[r]; }
  const table = new Float64Array(F);
  const minCash = FEE * 1.2;
  for (let r = 0; r < cashLine; r++) table[r] = Math.max(minCash, (raw[r] / rawSum) * pool);
  let tSum = 0;
  for (let r = 0; r < cashLine; r++) tSum += table[r];
  const scale = pool / tSum;
  for (let r = 0; r < cashLine; r++) table[r] *= scale;
  return table;
}

function scorePortfolio(
  portfolio: Lineup[],
  actuals: ContestActuals,
  actualByHash: Map<string, number>,
  payoutTable: Float64Array,
) {
  const F = actuals.entries.length;
  const sorted = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
  const top1T = sorted[Math.max(0, Math.floor(F * 0.01) - 1)] || 0;
  let t1 = 0, totalPayout = 0;
  const hitScores: number[] = [];
  for (const lu of portfolio) {
    const fa = actualByHash.get(lu.hash);
    let a: number | null = fa !== undefined ? fa : null;
    if (a === null) {
      let t = 0, miss = false;
      for (const p of lu.players) {
        const r = actuals.playerActualsByName.get(norm(p.name));
        if (!r) { miss = true; break; }
        t += r.fpts;
      }
      if (!miss) a = t;
    }
    if (a === null) continue;
    let lo = 0, hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sorted[mid] >= a) lo = mid + 1; else hi = mid;
    }
    const rank = Math.max(1, lo);
    if (a >= top1T) { t1++; hitScores.push(a); }
    const payout = rank <= payoutTable.length ? payoutTable[rank - 1] : 0;
    if (payout > 0) {
      let coWin = 0;
      for (const e of actuals.entries) if (Math.abs(e.actualPoints - a) <= 0.25) coWin++;
      coWin = Math.max(0, coWin - 1);
      totalPayout += payout / Math.sqrt(1 + coWin * 0.5);
    }
  }
  return { t1, totalPayout, hitScores };
}

async function main() {
  console.log('================================================================');
  console.log('STEP 1: Nerdytenor non-4-stack composition audit');
  console.log('================================================================\n');

  const shapeCounts = new Map<string, number>();
  let totalNerdy = 0;
  let non4Count = 0;

  for (const s of SLATES) {
    const actualsPath = path.join(DIR, s.actuals);
    const projPath = path.join(DIR, s.proj);
    if (!fs.existsSync(actualsPath) || !fs.existsSync(projPath)) continue;

    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);
    const nameMap = new Map<string, Player>();
    for (const p of pool.players) nameMap.set(norm(p.name), p);

    const nerdyEntries = actuals.entries.filter(e => e.entryName.toLowerCase().includes('nerdytenor'));
    for (const e of nerdyEntries) {
      const pls: Player[] = [];
      let ok = true;
      for (const nm of e.playerNames) {
        const p = nameMap.get(norm(nm));
        if (!p) { ok = false; break; }
        pls.push(p);
      }
      if (!ok) continue;
      totalNerdy++;
      const { top1 } = primaryTop2(pls);
      if (top1 < 4) {
        non4Count++;
        const shape = shapeOf(pls);
        shapeCounts.set(shape, (shapeCounts.get(shape) || 0) + 1);
      }
    }
  }

  console.log(`Total nerdy lineups: ${totalNerdy}`);
  console.log(`Non-4-stack lineups: ${non4Count} (${(non4Count / totalNerdy * 100).toFixed(1)}%)\n`);
  console.log('Non-4-stack shape distribution (sorted by frequency):');
  const sortedShapes = [...shapeCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [shape, n] of sortedShapes) {
    const pctOfAll = n / totalNerdy * 100;
    const pctOfNon4 = n / non4Count * 100;
    console.log(`  ${shape.padEnd(12)} ${n.toString().padStart(3)} (${pctOfAll.toFixed(2)}% of all, ${pctOfNon4.toFixed(1)}% of non-4)`);
  }

  console.log('\nFilter compatibility:');
  const relaxedHits = sortedShapes.filter(([shape]) => {
    const parts = shape.split('-').map(Number);
    return (parts[0] >= 3 && parts[1] >= 3);
  });
  const wideHits = sortedShapes.filter(([shape]) => {
    const parts = shape.split('-').map(Number);
    return (parts[0] >= 3 && parts[1] >= 2);
  });
  const relaxedN = relaxedHits.reduce((s, [, n]) => s + n, 0);
  const wideN = wideHits.reduce((s, [, n]) => s + n, 0);
  console.log(`  RELAXED (top1>=3 & top2>=3): captures ${relaxedN}/${non4Count} = ${(relaxedN / non4Count * 100).toFixed(1)}% of nerdy's non-4 lineups`);
  console.log(`  WIDE    (top1>=3 & top2>=2): captures ${wideN}/${non4Count} = ${(wideN / non4Count * 100).toFixed(1)}% of nerdy's non-4 lineups`);

  console.log('\n================================================================');
  console.log('STEP 2: 9-slate backtest — baseline vs RELAXED vs WIDE');
  console.log('================================================================\n');

  type Row = {
    slate: string; F: number;
    base: { poolSize: number; t1: number; pay: number; pct4: number; pctSplit: number; sizeActual: number };
    relax: { poolSize: number; t1: number; pay: number; pct4: number; pctSplit: number; sizeActual: number };
    wide: { poolSize: number; t1: number; pay: number; pct4: number; pctSplit: number; sizeActual: number };
  };
  const rows: Row[] = [];

  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj);
    const actualsPath = path.join(DIR, s.actuals);
    const poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) continue;

    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);
    const F = actuals.entries.length;
    const nameMap = new Map<string, Player>();
    for (const p of pool.players) nameMap.set(norm(p.name), p);
    const idMap = new Map<string, Player>();
    for (const p of pool.players) idMap.set(p.id, p);
    const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
    const actualByHash = new Map<string, number>();
    for (const e of actuals.entries) {
      const pls: Player[] = [];
      let ok = true;
      for (const nm of e.playerNames) {
        const p = nameMap.get(norm(nm));
        if (!p) { ok = false; break; }
        pls.push(p);
      }
      if (!ok) continue;
      actualByHash.set(pls.map(p => p.id).sort().join('|'), e.actualPoints);
    }

    const payoutTable = buildPayoutTable(F);

    function runWithFilter(kind: 'baseline' | 'relaxed' | 'wide') {
      const filtered = loaded.lineups.filter(stackFilter(kind));
      const comboFreq = precomputeComboFrequencies(filtered, 3);
      // Temporarily skip the internal ≥4 filter by pre-filtering with our own filter.
      // productionSelect still runs its own ≥4 filter — we need to relax that too.
      // Use overrideStackFilter by passing pre-filtered candidates AND setting a flag.
      // Actually, productionSelect has its own `stackPool = pool.filter(max>=4)` — that's the gate.
      // Workaround: pass our pre-filtered lineups as the pool. Production's internal filter will
      // re-apply max>=4 if kind != baseline, but since our filter is already a superset of that,
      // we need production's internal filter to accept 3-3 too. Let's bypass by using a
      // modified selector… simplest: return filtered lineups' result of our own greedy if needed.
      //
      // Cleanest: pass filtered to productionSelect. Its internal stackPool filter will then
      // further filter to max>=4, EXCLUDING 3-3 lineups. That defeats the experiment for
      // relaxed/wide modes.
      //
      // For this backtest we need productionSelect to honor the external filter, not re-apply
      // its own. Use a custom min stack size option. Add it as a config param.
      const result = productionSelect(filtered, pool.players, {
        N, lambda: LAMBDA, comboFreq, maxOverlap: GAMMA, minPrimaryStack: kind === 'baseline' ? 4 : 0,
      } as any);
      const scored = scorePortfolio(result.portfolio, actuals, actualByHash, payoutTable);

      // Composition of resulting portfolio
      let n4plus = 0, nSplit = 0;
      for (const lu of result.portfolio) {
        const { top1, top2 } = primaryTop2(lu.players);
        if (top1 >= 4) n4plus++;
        else if (top1 >= 3 && top2 >= 2) nSplit++;
      }
      return {
        poolSize: filtered.length,
        t1: scored.t1,
        pay: scored.totalPayout,
        pct4: result.portfolio.length ? n4plus / result.portfolio.length * 100 : 0,
        pctSplit: result.portfolio.length ? nSplit / result.portfolio.length * 100 : 0,
        sizeActual: result.portfolio.length,
      };
    }

    const base = runWithFilter('baseline');
    const relax = runWithFilter('relaxed');
    const wide = runWithFilter('wide');
    rows.push({ slate: s.slate, F, base, relax, wide });

    console.log(`${s.slate}: F=${F}`);
    console.log(`  baseline  pool=${base.poolSize} t1=${base.t1} pay=$${base.pay.toFixed(0)} 4+=${base.pct4.toFixed(0)}% split=${base.pctSplit.toFixed(0)}%`);
    console.log(`  relaxed   pool=${relax.poolSize} t1=${relax.t1} pay=$${relax.pay.toFixed(0)} 4+=${relax.pct4.toFixed(0)}% split=${relax.pctSplit.toFixed(0)}%`);
    console.log(`  wide      pool=${wide.poolSize} t1=${wide.t1} pay=$${wide.pay.toFixed(0)} 4+=${wide.pct4.toFixed(0)}% split=${wide.pctSplit.toFixed(0)}%`);
  }

  // SUMMARY
  console.log('\n================================================================');
  console.log('SUMMARY — Total payout by filter');
  console.log('================================================================\n');
  let baseT = 0, relaxT = 0, wideT = 0;
  let baseT1 = 0, relaxT1 = 0, wideT1 = 0;
  for (const r of rows) {
    baseT += r.base.pay; relaxT += r.relax.pay; wideT += r.wide.pay;
    baseT1 += r.base.t1; relaxT1 += r.relax.t1; wideT1 += r.wide.t1;
  }
  const fees = FEE * N * rows.length;
  console.log(`baseline:  $${baseT.toFixed(0)}  (t1=${baseT1})  ROI=${((baseT / fees - 1) * 100).toFixed(1)}%`);
  console.log(`relaxed:   $${relaxT.toFixed(0)}  (t1=${relaxT1})  ROI=${((relaxT / fees - 1) * 100).toFixed(1)}%  Δ=${relaxT >= baseT ? '+' : ''}$${(relaxT - baseT).toFixed(0)}`);
  console.log(`wide:      $${wideT.toFixed(0)}  (t1=${wideT1})  ROI=${((wideT / fees - 1) * 100).toFixed(1)}%  Δ=${wideT >= baseT ? '+' : ''}$${(wideT - baseT).toFixed(0)}`);

  // Composition target check: nerdy's non-4-stack pct is 21.5%
  const avgPctSplitRelax = rows.reduce((s, r) => s + r.relax.pctSplit, 0) / rows.length;
  const avgPctSplitWide = rows.reduce((s, r) => s + r.wide.pctSplit, 0) / rows.length;
  console.log(`\nPortfolio shape (avg pct split across slates):`);
  console.log(`  nerdytenor target: 21.5% non-4-stack`);
  console.log(`  relaxed result:    ${avgPctSplitRelax.toFixed(1)}% non-4 (3-2+ splits)`);
  console.log(`  wide result:       ${avgPctSplitWide.toFixed(1)}% non-4`);
}

main().catch(e => { console.error(e); process.exit(1); });
