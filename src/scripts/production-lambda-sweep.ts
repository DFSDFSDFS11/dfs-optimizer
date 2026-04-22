/**
 * Production λ Sweep — tune combo leverage weight across 9 MLB slates.
 *
 * For each slate, parse projections/pool/actuals once, precompute combo frequencies,
 * then run productionSelect for each λ and score against actuals. Amortizes parsing.
 *
 * λ=0 result MUST equal the 9-slate baseline ($25,799). Guard at the end.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals } from '../parser';
import { getContestConfig } from '../rules';
import { productionSelect } from '../selection/production-selector';
import { precomputeComboFrequencies } from '../selection/combo-leverage';

const DIR = 'C:/Users/colin/dfs opto';
const FEE = 20;
const N = 150;
const BASELINE_TOTAL = 25799; // From production-backtest.js run on 2026-04-21, 9 slates

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

const LAMBDAS = [0, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5];

function norm(n: string): string {
  return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
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
  let t1 = 0, scored = 0, totalPayout = 0;

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
    scored++;

    let lo = 0, hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sorted[mid] >= a) lo = mid + 1; else hi = mid;
    }
    const rank = Math.max(1, lo);
    if (a >= top1T) t1++;

    const payout = rank <= payoutTable.length ? payoutTable[rank - 1] : 0;
    if (payout > 0) {
      let coWin = 0;
      for (const e of actuals.entries) {
        if (Math.abs(e.actualPoints - a) <= 0.25) coWin++;
      }
      coWin = Math.max(0, coWin - 1);
      totalPayout += payout / Math.sqrt(1 + coWin * 0.5);
    }
  }
  return { t1, scored, totalPayout };
}

async function main() {
  console.log('================================================================');
  console.log(`PRODUCTION λ SWEEP — 9 MLB slates × ${LAMBDAS.length} λ values`);
  console.log('================================================================');
  console.log(`  λ grid: ${LAMBDAS.join(', ')}`);
  console.log();

  // Results indexed as [slateIdx][lambdaIdx]
  type SlateRow = { slate: string; F: number; entries: number; pay: number; t1: number; scored: number; avgProj: number; avgOwn: number; comboBonusMean: number };
  const grid: SlateRow[][] = LAMBDAS.map(() => []);

  for (let si = 0; si < SLATES.length; si++) {
    const s = SLATES[si];
    const projPath = path.join(DIR, s.proj);
    const actualsPath = path.join(DIR, s.actuals);
    const poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) {
      console.log(`  SKIP ${s.slate} — missing files`);
      for (let li = 0; li < LAMBDAS.length; li++) {
        grid[li].push({ slate: s.slate, F: 0, entries: 0, pay: 0, t1: 0, scored: 0, avgProj: 0, avgOwn: 0, comboBonusMean: 0 });
      }
      continue;
    }

    // Parse once per slate
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

    // Precompute combo frequencies ONCE per slate (shared across all λ values)
    const comboFreq = precomputeComboFrequencies(loaded.lineups, 3);
    const payoutTable = buildPayoutTable(F);

    console.log(`\n${s.slate}: pool=${loaded.lineups.length}, field=${F}, comboKeys=${comboFreq.size}`);

    for (let li = 0; li < LAMBDAS.length; li++) {
      const lambda = LAMBDAS[li];
      const result = productionSelect(loaded.lineups, pool.players, { N, lambda, comboFreq });
      const scored = scorePortfolio(result.portfolio, actuals, actualByHash, payoutTable);
      const avgProj = result.portfolio.reduce((s: number, lu: Lineup) => s + lu.projection, 0) / Math.max(1, result.portfolio.length);
      const avgOwn = result.actualAvgOwnership;
      grid[li].push({
        slate: s.slate, F, entries: result.portfolio.length,
        pay: scored.totalPayout, t1: scored.t1, scored: scored.scored,
        avgProj, avgOwn, comboBonusMean: 0,
      });
      console.log(`  λ=${lambda.toFixed(2)}: size=${result.portfolio.length} t1=${scored.t1} pay=$${scored.totalPayout.toFixed(0)} avgProj=${avgProj.toFixed(1)} avgOwn=${avgOwn.toFixed(1)}%`);
    }
  }

  // ============================================================
  // SUMMARY
  // ============================================================
  console.log('\n================================================================');
  console.log('SUMMARY — total payout by λ across 9 slates');
  console.log('================================================================\n');

  // Header
  let hdr = 'Slate      |';
  for (const lam of LAMBDAS) hdr += ` λ=${lam.toFixed(2).padStart(4)} |`;
  console.log(hdr);
  console.log('-'.repeat(hdr.length));

  for (let si = 0; si < SLATES.length; si++) {
    let row = `${SLATES[si].slate.padEnd(10)} |`;
    for (let li = 0; li < LAMBDAS.length; li++) {
      row += ` $${grid[li][si].pay.toFixed(0).padStart(5)} |`;
    }
    console.log(row);
  }

  console.log('-'.repeat(hdr.length));
  let totalRow = 'TOTAL      |';
  const totals: number[] = [];
  const hits: number[] = [];
  for (let li = 0; li < LAMBDAS.length; li++) {
    const total = grid[li].reduce((s, r) => s + r.pay, 0);
    const hit = grid[li].reduce((s, r) => s + r.t1, 0);
    totals.push(total);
    hits.push(hit);
    totalRow += ` $${total.toFixed(0).padStart(5)} |`;
  }
  console.log(totalRow);

  let hitRow = 'Top1% hits |';
  for (const h of hits) hitRow += ` ${String(h).padStart(7)} |`;
  console.log(hitRow);

  const totalFees = FEE * N * SLATES.length;
  let roiRow = 'ROI        |';
  for (const t of totals) {
    const roi = ((t / totalFees - 1) * 100).toFixed(1) + '%';
    roiRow += ` ${roi.padStart(7)} |`;
  }
  console.log(roiRow);

  // Delta vs λ=0
  let deltaRow = 'Δ vs λ=0   |';
  for (const t of totals) {
    const d = t - totals[0];
    deltaRow += ` ${(d >= 0 ? '+$' : '-$') + Math.abs(d).toFixed(0).padStart(4)} |`;
  }
  console.log(deltaRow);

  // Baseline guard
  console.log(`\nBaseline guard: λ=0 total = $${totals[0].toFixed(0)}, expected $${BASELINE_TOTAL}`);
  if (Math.abs(totals[0] - BASELINE_TOTAL) > 1) {
    console.log(`  ⚠  DRIFT DETECTED — λ=0 differs from baseline by $${(totals[0] - BASELINE_TOTAL).toFixed(0)}`);
    console.log(`  This means the lambda wiring regressed something. Investigate before trusting sweep.`);
  } else {
    console.log(`  ✓ λ=0 matches baseline exactly — sweep is trustworthy.`);
  }

  // Pick winner
  let bestLi = 0;
  for (let li = 1; li < LAMBDAS.length; li++) if (totals[li] > totals[bestLi]) bestLi = li;
  console.log(`\nWinner: λ=${LAMBDAS[bestLi]} at $${totals[bestLi].toFixed(0)} (Δ vs λ=0 = ${totals[bestLi] - totals[0] >= 0 ? '+' : ''}$${(totals[bestLi] - totals[0]).toFixed(0)})`);

  // ============================================================
  // LEAVE-ONE-OUT CROSS-VALIDATION
  // ============================================================
  //
  // For each slate i: pick λ* = argmax total_payout(λ, slates ≠ i), then score slate i at λ*.
  // Sum held-out payouts. If LOO total ≫ baseline, combo leverage generalizes.
  // If LOO total ≈ baseline or worse, signal is overfit (e.g. to 4-18 alone).
  console.log('\n================================================================');
  console.log('LEAVE-ONE-OUT CROSS-VALIDATION');
  console.log('================================================================\n');

  console.log('Held-out | Best λ from other 8 | LOO payout at that λ | λ=0 payout | Δ');
  console.log('-'.repeat(80));

  let looTotal = 0;
  let looBaseline = 0;
  const lambdaPickCounts = new Map<number, number>();
  for (let si = 0; si < SLATES.length; si++) {
    // For each λ, compute the total across all slates EXCEPT si
    let bestLambdaIdx = 0;
    let bestOtherSum = -Infinity;
    for (let li = 0; li < LAMBDAS.length; li++) {
      let sum = 0;
      for (let sj = 0; sj < SLATES.length; sj++) {
        if (sj === si) continue;
        sum += grid[li][sj].pay;
      }
      if (sum > bestOtherSum) { bestOtherSum = sum; bestLambdaIdx = li; }
    }
    const chosenLambda = LAMBDAS[bestLambdaIdx];
    const heldOutPayout = grid[bestLambdaIdx][si].pay;
    const baselinePayout = grid[0][si].pay; // λ=0 on same slate
    looTotal += heldOutPayout;
    looBaseline += baselinePayout;
    lambdaPickCounts.set(chosenLambda, (lambdaPickCounts.get(chosenLambda) || 0) + 1);
    const delta = heldOutPayout - baselinePayout;
    console.log(
      `${SLATES[si].slate.padEnd(8)} | λ=${chosenLambda.toFixed(2).padStart(4)} (other-8 total $${bestOtherSum.toFixed(0)}) | $${heldOutPayout.toFixed(0).padStart(7)} | $${baselinePayout.toFixed(0).padStart(7)} | ${(delta >= 0 ? '+$' : '-$') + Math.abs(delta).toFixed(0)}`,
    );
  }

  console.log('-'.repeat(80));
  console.log(`LOO TOTAL:           $${looTotal.toFixed(0)} (sum of held-out payouts)`);
  console.log(`λ=0 BASELINE TOTAL:  $${looBaseline.toFixed(0)}`);
  console.log(`LOO Δ vs baseline:   ${looTotal - looBaseline >= 0 ? '+' : ''}$${(looTotal - looBaseline).toFixed(0)}`);

  const looFees = FEE * N * SLATES.length;
  console.log(`LOO ROI:             ${((looTotal / looFees - 1) * 100).toFixed(1)}%`);

  console.log(`\nλ pick distribution across 9 LOO folds:`);
  const sortedPicks = [...lambdaPickCounts.entries()].sort((a, b) => a[0] - b[0]);
  for (const [lam, n] of sortedPicks) console.log(`  λ=${lam.toFixed(2)}: chosen ${n}/${SLATES.length} times`);

  console.log('\nInterpretation:');
  if (looTotal - looBaseline > 500) {
    console.log('  ✓ LOO beats baseline by $500+ — combo leverage signal generalizes.');
  } else if (looTotal - looBaseline > 0) {
    console.log('  ~ LOO beats baseline slightly — marginal signal, likely within noise at n=9.');
  } else {
    console.log('  ✗ LOO does NOT beat baseline — sweep winner was overfit to specific slates.');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
