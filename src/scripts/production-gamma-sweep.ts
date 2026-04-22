/**
 * Production γ Sweep — tune pairwise lineup overlap constraint.
 *
 * Locks λ=0.05 (validated in previous sweep). Sweeps γ ∈ {10 (unlimited), 8, 7, 6, 5, 4}
 * across 9 slates. γ is max shared players between any two selected lineups.
 *
 * Guard: γ=10 + λ=0.05 MUST equal $28,330 (the λ=0.05 baseline).
 * Includes LOO cross-validation at the end.
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
const LAMBDA = 0.05;
const BASELINE_TOTAL = 28330; // λ=0.05, γ=unlimited across 9 slates

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

const GAMMAS = [10, 8, 7, 6, 5, 4];
const GAMMA_LABELS: Record<number, string> = { 10: '∞', 8: '8', 7: '7', 6: '6', 5: '5', 4: '4' };

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
      for (const e of actuals.entries) if (Math.abs(e.actualPoints - a) <= 0.25) coWin++;
      coWin = Math.max(0, coWin - 1);
      totalPayout += payout / Math.sqrt(1 + coWin * 0.5);
    }
  }
  return { t1, scored, totalPayout };
}

function maxPairwiseOverlap(portfolio: Lineup[]): number {
  // Compute the observed max overlap between any two lineups (diagnostic).
  const sets = portfolio.map(lu => new Set(lu.players.map(p => p.id)));
  let maxO = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      let overlap = 0;
      for (const id of sets[i]) if (sets[j].has(id)) overlap++;
      if (overlap > maxO) maxO = overlap;
    }
  }
  return maxO;
}

async function main() {
  console.log('================================================================');
  console.log(`PRODUCTION γ SWEEP — λ=${LAMBDA} locked, 9 MLB slates × ${GAMMAS.length} γ values`);
  console.log('================================================================');
  console.log(`  γ grid: ${GAMMAS.map(g => GAMMA_LABELS[g]).join(', ')}`);
  console.log();

  type SlateRow = { slate: string; F: number; entries: number; pay: number; t1: number; maxOvl: number };
  const grid: SlateRow[][] = GAMMAS.map(() => []);

  for (let si = 0; si < SLATES.length; si++) {
    const s = SLATES[si];
    const projPath = path.join(DIR, s.proj);
    const actualsPath = path.join(DIR, s.actuals);
    const poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) {
      console.log(`  SKIP ${s.slate} — missing files`);
      for (let gi = 0; gi < GAMMAS.length; gi++) {
        grid[gi].push({ slate: s.slate, F: 0, entries: 0, pay: 0, t1: 0, maxOvl: 0 });
      }
      continue;
    }

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

    const comboFreq = precomputeComboFrequencies(loaded.lineups, 3);
    const payoutTable = buildPayoutTable(F);

    console.log(`\n${s.slate}: pool=${loaded.lineups.length}, field=${F}`);

    for (let gi = 0; gi < GAMMAS.length; gi++) {
      const gamma = GAMMAS[gi];
      const t0 = Date.now();
      const result = productionSelect(loaded.lineups, pool.players, {
        N, lambda: LAMBDA, comboFreq, maxOverlap: gamma,
      });
      const scored = scorePortfolio(result.portfolio, actuals, actualByHash, payoutTable);
      const observedMax = maxPairwiseOverlap(result.portfolio);
      grid[gi].push({
        slate: s.slate, F, entries: result.portfolio.length,
        pay: scored.totalPayout, t1: scored.t1, maxOvl: observedMax,
      });
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  γ=${GAMMA_LABELS[gamma].padStart(2)}: size=${result.portfolio.length} t1=${scored.t1} pay=$${scored.totalPayout.toFixed(0).padStart(5)} obsMaxOverlap=${observedMax} (${dt}s)`);
    }
  }

  // ============================================================
  // SUMMARY
  // ============================================================
  console.log('\n================================================================');
  console.log(`SUMMARY — total payout by γ across 9 slates (λ=${LAMBDA} locked)`);
  console.log('================================================================\n');

  let hdr = 'Slate      |';
  for (const g of GAMMAS) hdr += ` γ=${GAMMA_LABELS[g].padStart(2)} |`;
  console.log(hdr);
  console.log('-'.repeat(hdr.length));

  for (let si = 0; si < SLATES.length; si++) {
    let row = `${SLATES[si].slate.padEnd(10)} |`;
    for (let gi = 0; gi < GAMMAS.length; gi++) {
      row += ` $${grid[gi][si].pay.toFixed(0).padStart(4)} |`;
    }
    console.log(row);
  }

  console.log('-'.repeat(hdr.length));
  const totals: number[] = [];
  const hits: number[] = [];
  let totalRow = 'TOTAL      |';
  for (let gi = 0; gi < GAMMAS.length; gi++) {
    const total = grid[gi].reduce((s, r) => s + r.pay, 0);
    const hit = grid[gi].reduce((s, r) => s + r.t1, 0);
    totals.push(total);
    hits.push(hit);
    totalRow += ` $${total.toFixed(0).padStart(4)} |`;
  }
  console.log(totalRow);

  let hitRow = 'Top1% hits |';
  for (const h of hits) hitRow += ` ${String(h).padStart(6)} |`;
  console.log(hitRow);

  const totalFees = FEE * N * SLATES.length;
  let roiRow = 'ROI        |';
  for (const t of totals) roiRow += ` ${(((t / totalFees - 1) * 100).toFixed(1) + '%').padStart(6)} |`;
  console.log(roiRow);

  let deltaRow = 'Δ vs γ=∞   |';
  for (const t of totals) {
    const d = t - totals[0];
    deltaRow += ` ${(d >= 0 ? '+$' : '-$') + Math.abs(d).toFixed(0).padStart(3)} |`;
  }
  console.log(deltaRow);

  console.log(`\nBaseline guard: γ=∞+λ=${LAMBDA} total = $${totals[0].toFixed(0)}, expected $${BASELINE_TOTAL}`);
  if (Math.abs(totals[0] - BASELINE_TOTAL) > 1) {
    console.log(`  ⚠  DRIFT DETECTED — regression of $${(totals[0] - BASELINE_TOTAL).toFixed(0)} vs baseline.`);
  } else {
    console.log(`  ✓ γ=∞ matches λ=0.05 baseline exactly.`);
  }

  let bestGi = 0;
  for (let gi = 1; gi < GAMMAS.length; gi++) if (totals[gi] > totals[bestGi]) bestGi = gi;
  console.log(`\nWinner: γ=${GAMMA_LABELS[GAMMAS[bestGi]]} at $${totals[bestGi].toFixed(0)} (Δ vs γ=∞ = ${totals[bestGi] - totals[0] >= 0 ? '+' : ''}$${(totals[bestGi] - totals[0]).toFixed(0)})`);

  // ============================================================
  // LOO CV
  // ============================================================
  console.log('\n================================================================');
  console.log('LEAVE-ONE-OUT CROSS-VALIDATION');
  console.log('================================================================\n');

  console.log('Held-out | Best γ from other 8  | LOO payout at γ* | γ=∞ payout | Δ');
  console.log('-'.repeat(80));

  let looTotal = 0;
  let looBaseline = 0;
  const pickCounts = new Map<number, number>();
  for (let si = 0; si < SLATES.length; si++) {
    let bestGiLoo = 0;
    let bestSum = -Infinity;
    for (let gi = 0; gi < GAMMAS.length; gi++) {
      let sum = 0;
      for (let sj = 0; sj < SLATES.length; sj++) if (sj !== si) sum += grid[gi][sj].pay;
      if (sum > bestSum) { bestSum = sum; bestGiLoo = gi; }
    }
    const chosen = GAMMAS[bestGiLoo];
    const heldOut = grid[bestGiLoo][si].pay;
    const baseline = grid[0][si].pay;
    looTotal += heldOut;
    looBaseline += baseline;
    pickCounts.set(chosen, (pickCounts.get(chosen) || 0) + 1);
    const d = heldOut - baseline;
    console.log(
      `${SLATES[si].slate.padEnd(8)} | γ=${GAMMA_LABELS[chosen].padStart(2)} (other-8 $${bestSum.toFixed(0).padStart(5)}) | $${heldOut.toFixed(0).padStart(7)} | $${baseline.toFixed(0).padStart(7)} | ${(d >= 0 ? '+$' : '-$') + Math.abs(d).toFixed(0)}`,
    );
  }

  console.log('-'.repeat(80));
  console.log(`LOO TOTAL:          $${looTotal.toFixed(0)} (sum of held-out payouts)`);
  console.log(`γ=∞ BASELINE TOTAL: $${looBaseline.toFixed(0)}`);
  console.log(`LOO Δ vs baseline:  ${looTotal - looBaseline >= 0 ? '+' : ''}$${(looTotal - looBaseline).toFixed(0)}`);
  console.log(`LOO ROI:            ${((looTotal / (FEE * N * SLATES.length) - 1) * 100).toFixed(1)}%`);

  console.log(`\nγ pick distribution across 9 LOO folds:`);
  const sortedPicks = [...pickCounts.entries()].sort((a, b) => b[0] - a[0]);
  for (const [g, n] of sortedPicks) console.log(`  γ=${GAMMA_LABELS[g]}: chosen ${n}/${SLATES.length} times`);

  console.log('\nInterpretation:');
  if (looTotal - looBaseline > 500) {
    console.log('  ✓ LOO beats baseline by $500+ — pairwise diversity signal generalizes.');
  } else if (looTotal - looBaseline > 0) {
    console.log('  ~ LOO beats baseline slightly — marginal signal, likely within noise at n=9.');
  } else {
    console.log('  ✗ LOO does NOT beat baseline — γ sweep winner is overfit.');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
