/**
 * NBA V35 Backtest — Sequential Portfolio Construction via Marginal Payout Maximization
 *
 * Tests V35 (t-copula simulation + greedy marginal payout optimization) on NBA slates.
 * Uses Mode 2: every contest entry becomes a candidate lineup.
 * Compares against algorithm7 baseline (mean top-1% = 1.26%).
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import {
  parseCSVFile,
  buildPlayerPool,
  parseContestActuals,
  ContestActuals,
} from '../parser';
import { getContestConfig } from '../rules';
import { runV35 } from '../v35';

const HIST = 'C:/Users/colin/Projects/dfs-optimizer/historical_slates';
const TARGET_COUNT = 150;
const ENTRY_FEE = 20;

function norm(n: string): string {
  return (n || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ============================================================
// PAYOUT MODEL
// ============================================================

function buildPayoutTable(F: number, fee: number = 20): Float64Array {
  const pool = F * fee * 0.88;
  const cashLine = Math.floor(F * 0.22);
  const raw = new Float64Array(cashLine);
  let rawSum = 0;
  for (let r = 0; r < cashLine; r++) { raw[r] = Math.pow(r + 1, -1.15); rawSum += raw[r]; }
  const table = new Float64Array(F);
  const minCash = fee * 1.2;
  for (let r = 0; r < cashLine; r++) table[r] = Math.max(minCash, (raw[r] / rawSum) * pool);
  let tSum = 0;
  for (let r = 0; r < cashLine; r++) tSum += table[r];
  const scale = pool / tSum;
  for (let r = 0; r < cashLine; r++) table[r] *= scale;
  return table;
}

// ============================================================
// SCORING
// ============================================================

interface SlateResult {
  slate: string;
  entries: number;
  t1: number;
  t5: number;
  cash: number;
  scored: number;
  totalPayout: number;
  avgOwn: number;
  avgProj: number;
  timeMs: number;
}

function scorePortfolio(
  portfolio: Lineup[],
  actuals: ContestActuals,
  actualByHash: Map<string, number>,
  payoutTable: Float64Array,
): { t1: number; t5: number; cash: number; scored: number; totalPayout: number; avgOwn: number; avgProj: number } {
  const F = actuals.entries.length;
  const sortedScores = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
  const top1T = sortedScores[Math.max(0, Math.floor(F * 0.01) - 1)] || 0;
  const top5T = sortedScores[Math.max(0, Math.floor(F * 0.05) - 1)] || 0;
  const cashT = sortedScores[Math.max(0, Math.floor(F * 0.22) - 1)] || 0;

  let t1 = 0, t5 = 0, cash = 0, scored = 0, totalPayout = 0;

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

    // Find rank via binary search on sorted scores
    let lo = 0, hi = sortedScores.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sortedScores[mid] >= a) lo = mid + 1;
      else hi = mid;
    }
    const rank = Math.max(1, lo);

    if (a >= top1T) t1++;
    if (a >= top5T) t5++;
    if (a >= cashT) cash++;

    const payout = rank <= payoutTable.length ? payoutTable[rank - 1] : 0;
    if (payout > 0) {
      let coWinners = 0;
      for (const e of actuals.entries) {
        if (Math.abs(e.actualPoints - a) <= 0.25) coWinners++;
      }
      coWinners = Math.max(0, coWinners - 1);
      totalPayout += payout / Math.sqrt(1 + coWinners * 0.5);
    }
  }

  // Compute averages
  let sOwn = 0, sProj = 0;
  for (const lu of portfolio) {
    sProj += lu.projection;
    sOwn += lu.players.reduce((s: number, p: Player) => s + (p.ownership || 0), 0) / lu.players.length;
  }

  return {
    t1, t5, cash, scored, totalPayout,
    avgOwn: portfolio.length > 0 ? sOwn / portfolio.length : 0,
    avgProj: portfolio.length > 0 ? sProj / portfolio.length : 0,
  };
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log('=== NBA V35 Backtest — Sequential Marginal Payout Maximization ===\n');

  // Discover NBA slates
  const files = fs.readdirSync(HIST);
  const projRe = /^(\d{4}-\d{2}-\d{2})(?:_dk(?:_night)?)?_projections\.csv$/;
  const slates: Array<{ date: string; proj: string; actuals: string }> = [];
  for (const f of files) {
    const m = f.match(projRe);
    if (!m) continue;
    const date = m[1];
    const isDkNight = f.includes('_dk_night_');
    const isDk = f.includes('_dk_');
    const base = isDkNight ? `${date}_dk_night` : isDk ? `${date}_dk` : date;
    const af = `${base}_actuals.csv`;
    if (files.includes(af))
      slates.push({
        date: base,
        proj: path.join(HIST, f),
        actuals: path.join(HIST, af),
      });
  }
  slates.sort((a, b) => a.date.localeCompare(b.date));
  console.log(`Found ${slates.length} NBA slates\n`);

  const results: SlateResult[] = [];

  for (const s of slates) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`=== ${s.date} ===`);
    console.log(`${'='.repeat(60)}`);

    // Parse projections
    const pr = parseCSVFile(s.proj, 'nba', true);
    const config = getContestConfig('dk', 'nba', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);

    // Parse actuals
    const actuals = parseContestActuals(s.actuals, config);
    const F = actuals.entries.length;

    // Build name lookup from player pool
    const nameMap = new Map<string, Player>();
    for (const p of pool.players) nameMap.set(norm(p.name), p);

    // Build candidate lineups from contest entries (Mode 2)
    const fieldLineups: Lineup[] = [];
    const actualByHash = new Map<string, number>();
    const seenH = new Set<string>();
    for (const e of actuals.entries) {
      const pls: Player[] = [];
      let ok = true;
      for (const nm of e.playerNames) {
        const p = nameMap.get(norm(nm));
        if (!p) { ok = false; break; }
        pls.push(p);
      }
      if (!ok) continue;
      const hash = pls.map(p => p.id).sort().join('|');
      if (seenH.has(hash)) continue;
      seenH.add(hash);
      const sal = pls.reduce((sm, p) => sm + p.salary, 0);
      const proj = pls.reduce((sm, p) => sm + p.projection, 0);
      const own = pls.reduce((sm, p) => sm + (p.ownership || 0), 0) / pls.length;
      fieldLineups.push({ players: pls, salary: sal, projection: proj, ownership: own, hash });
      actualByHash.set(hash, e.actualPoints);
    }

    if (fieldLineups.length < 100) {
      console.log('  Skip (field too small)');
      continue;
    }

    console.log(`  Players: ${pool.players.length}, Candidates: ${fieldLineups.length}, Field: ${F}`);

    // Run V35
    const t0 = Date.now();
    const v35Result = await runV35({
      players: pool.players,
      candidates: fieldLineups,
      pool: fieldLineups,
      targetCount: TARGET_COUNT,
      numWorlds: 3000,
      fieldSize: Math.min(8000, F),
      entryFee: ENTRY_FEE,
      maxExposure: 0.40,
      maxTeamStackPct: 0.25,
      seed: 12345,
    });
    const elapsed = Date.now() - t0;

    // Score against actuals
    const payoutTable = buildPayoutTable(F, ENTRY_FEE);
    const result = scorePortfolio(v35Result.portfolio, actuals, actualByHash, payoutTable);

    const slateResult: SlateResult = {
      slate: s.date,
      entries: F,
      timeMs: elapsed,
      ...result,
    };
    results.push(slateResult);

    const t1Rate = result.scored > 0 ? (result.t1 / result.scored * 100).toFixed(2) : '0.00';
    console.log(`  V35: t1=${result.t1}/${result.scored} (${t1Rate}%) t5=${result.t5} cash=${result.cash} pay=$${result.totalPayout.toFixed(0)}`);
    console.log(`  AvgOwn=${result.avgOwn.toFixed(1)}% AvgProj=${result.avgProj.toFixed(1)} Time=${(elapsed / 1000).toFixed(1)}s`);
  }

  // ============================================================
  // SUMMARY TABLE
  // ============================================================

  console.log(`\n${'='.repeat(70)}`);
  console.log('   NBA V35 BACKTEST RESULTS');
  console.log(`${'='.repeat(70)}\n`);

  const hdr = `${'Slate'.padEnd(18)} ${'Entries'.padStart(7)} ${'t1'.padStart(4)} ${'t1%'.padStart(7)} ${'t5'.padStart(4)} ${'Cash'.padStart(5)} ${'Payout'.padStart(8)} ${'Own%'.padStart(6)} ${'Proj'.padStart(6)} ${'Time'.padStart(6)}`;
  console.log(hdr);
  console.log('-'.repeat(hdr.length));

  let totalT1 = 0, totalT5 = 0, totalCash = 0, totalPay = 0, totalScored = 0;
  let t1RateSum = 0, t5RateSum = 0, cashRateSum = 0;

  for (const r of results) {
    totalT1 += r.t1;
    totalT5 += r.t5;
    totalCash += r.cash;
    totalPay += r.totalPayout;
    totalScored += r.scored;

    const t1Rate = r.scored > 0 ? r.t1 / r.scored : 0;
    const t5Rate = r.scored > 0 ? r.t5 / r.scored : 0;
    const cashRate = r.scored > 0 ? r.cash / r.scored : 0;
    t1RateSum += t1Rate;
    t5RateSum += t5Rate;
    cashRateSum += cashRate;

    console.log(
      `${r.slate.padEnd(18)} ${String(r.entries).padStart(7)} ${String(r.t1).padStart(4)} ${(t1Rate * 100).toFixed(2).padStart(6)}% ${String(r.t5).padStart(4)} ${String(r.cash).padStart(5)} ${('$' + r.totalPayout.toFixed(0)).padStart(8)} ${r.avgOwn.toFixed(1).padStart(6)} ${r.avgProj.toFixed(1).padStart(6)} ${(r.timeMs / 1000).toFixed(1).padStart(5)}s`
    );
  }

  console.log('-'.repeat(hdr.length));

  const n = results.length;
  const meanT1 = n > 0 ? t1RateSum / n : 0;
  const meanT5 = n > 0 ? t5RateSum / n : 0;
  const meanCash = n > 0 ? cashRateSum / n : 0;

  console.log(
    `${'TOTAL'.padEnd(18)} ${''.padStart(7)} ${String(totalT1).padStart(4)} ${(meanT1 * 100).toFixed(2).padStart(6)}% ${String(totalT5).padStart(4)} ${String(totalCash).padStart(5)} ${('$' + totalPay.toFixed(0)).padStart(8)}`
  );

  const totalFees = ENTRY_FEE * TARGET_COUNT * n;
  const roi = totalFees > 0 ? ((totalPay / totalFees) - 1) * 100 : 0;

  console.log(`\nEntry fees: $${ENTRY_FEE} x ${TARGET_COUNT} x ${n} slates = $${totalFees.toLocaleString()}`);
  console.log(`V35 total payout: $${totalPay.toFixed(0)}`);
  console.log(`V35 ROI: ${roi.toFixed(1)}%`);

  console.log('\n--- Mean Hit Rates ---');
  console.log(`  Mean top-1%: ${(meanT1 * 100).toFixed(2)}%`);
  console.log(`  Mean top-5%: ${(meanT5 * 100).toFixed(2)}%`);
  console.log(`  Mean cash:   ${(meanCash * 100).toFixed(2)}%`);

  console.log('\n--- Comparison vs algorithm7 Baseline ---');
  console.log(`  algorithm7:  1.26% mean top-1% (baseline)`);
  console.log(`  V35:         ${(meanT1 * 100).toFixed(2)}% mean top-1%`);
  const diff = (meanT1 * 100) - 1.26;
  console.log(`  Difference:  ${diff >= 0 ? '+' : ''}${diff.toFixed(2)} pp`);
  console.log(`  Multiplier:  ${(meanT1 * 100 / 1.26).toFixed(2)}x`);

  console.log('\nDone.');
}

main().catch(err => {
  console.error('NBA V35 backtest failed:', err);
  process.exit(1);
});
