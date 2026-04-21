/**
 * V35 Backtest — Sequential Portfolio Construction via Marginal Payout Maximization.
 *
 * Runs V35 on 8 MLB slates, scores against actuals, computes payouts,
 * and compares to V32 and production selector baselines.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import {
  parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV,
  ContestActuals,
} from '../parser';
import { getContestConfig } from '../rules';
import { runV35 } from '../v35';

const DATA_DIR = 'C:/Users/colin/dfs opto';
const ENTRY_FEE = 20;
const TARGET_COUNT = 150;

const SLATES = [
  { slate: '4-6-26', proj: '4-6-26_projections.csv', actuals: 'dkactuals 4-6-26.csv', pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26', proj: '4-8-26projections.csv', actuals: '4-8-26actuals.csv', pool: '4-8-26sspool.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv', actuals: '4-12-26actuals.csv', pool: '4-12-26sspool.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv', actuals: '4-14-26actuals.csv', pool: '4-14-26sspool.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv', actuals: '4-15-26actuals.csv', pool: '4-15-26sspool.csv' },
  { slate: '4-17-26', proj: '4-17-26projections.csv', actuals: '4-17-26actuals.csv', pool: '4-17-26sspool.csv' },
  { slate: '4-18-26', proj: '4-18-26projections.csv', actuals: '4-18-26actuals.csv', pool: '4-18-26sspool.csv' },
  { slate: '4-19-26', proj: '4-19-26projections.csv', actuals: '4-19-26actuals.csv', pool: '4-19-26sspool.csv' },
];

function norm(n: string): string {
  return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
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
  t1: number;
  t5: number;
  cash: number;
  scored: number;
  totalPayout: number;
  stacks: number;
  avgOwn: number;
  avgProj: number;
  entries: number;
}

function scorePortfolio(
  portfolio: Lineup[],
  actuals: ContestActuals,
  actualByHash: Map<string, number>,
  payoutTable: Float64Array,
): Omit<SlateResult, 'slate' | 'entries'> {
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
      // Count co-winners for tie splitting
      let coWinners = 0;
      for (const e of actuals.entries) {
        if (Math.abs(e.actualPoints - a) <= 0.25) coWinners++;
      }
      coWinners = Math.max(0, coWinners - 1);
      totalPayout += payout / Math.sqrt(1 + coWinners * 0.5);
    }
  }

  // Compute stacks and averages
  const stackTeams = new Set<string>();
  let sOwn = 0, sProj = 0;
  for (const lu of portfolio) {
    sProj += lu.projection;
    sOwn += lu.players.reduce((s: number, p: Player) => s + (p.ownership || 0), 0) / lu.players.length;
    const tc = new Map<string, number>();
    for (const p of lu.players) {
      if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
    }
    for (const [t, c] of tc) if (c >= 4) stackTeams.add(t);
  }

  return {
    t1, t5, cash, scored, totalPayout,
    stacks: stackTeams.size,
    avgOwn: portfolio.length > 0 ? sOwn / portfolio.length : 0,
    avgProj: portfolio.length > 0 ? sProj / portfolio.length : 0,
  };
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log('=== V35 Backtest — Sequential Marginal Payout Maximization ===\n');

  const results: SlateResult[] = [];

  for (const s of SLATES) {
    const projPath = path.join(DATA_DIR, s.proj);
    const actualsPath = path.join(DATA_DIR, s.actuals);
    const poolPath = path.join(DATA_DIR, s.pool);

    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) {
      console.log(`Skipping ${s.slate}: missing files`);
      continue;
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`=== ${s.slate} ===`);
    console.log(`${'='.repeat(60)}`);

    // Parse projections
    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);

    // Parse actuals
    const actuals = parseContestActuals(actualsPath, config);
    const F = actuals.entries.length;

    // Build name and ID maps
    const nameMap = new Map<string, Player>();
    for (const p of pool.players) nameMap.set(norm(p.name), p);
    const idMap = new Map<string, Player>();
    for (const p of pool.players) idMap.set(p.id, p);

    // Build actual scores by hash
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
      const hash = pls.map(p => p.id).sort().join('|');
      actualByHash.set(hash, e.actualPoints);
    }

    // Load SS pool
    const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
    const candidates = loaded.lineups;

    console.log(`  Players: ${pool.players.length}, Pool: ${candidates.length}, Field: ${F}`);

    // Run V35
    const v35Result = await runV35({
      players: pool.players,
      candidates,
      pool: candidates, // Field sampled from same pool
      targetCount: TARGET_COUNT,
      numWorlds: 3000,
      fieldSize: Math.min(8000, F),
      entryFee: ENTRY_FEE,
      maxExposure: 0.40,
      maxTeamStackPct: 0.10,
      seed: 12345,
    });

    // Score against actuals
    const payoutTable = buildPayoutTable(F, ENTRY_FEE);
    const result = scorePortfolio(v35Result.portfolio, actuals, actualByHash, payoutTable);

    const slateResult: SlateResult = {
      slate: s.slate,
      entries: F,
      ...result,
    };
    results.push(slateResult);

    console.log(`\n=== ${s.slate} ===`);
    console.log(`  V35: t1=${result.t1} pay=$${result.totalPayout.toFixed(0)} stacks=${result.stacks} own=${result.avgOwn.toFixed(1)}% proj=${result.avgProj.toFixed(1)}`);
    console.log(`  Time: ${(v35Result.selectionTimeMs / 1000).toFixed(1)}s`);
  }

  // ============================================================
  // SUMMARY
  // ============================================================

  console.log(`\n${'='.repeat(60)}`);
  console.log('SUMMARY — V35 vs Baselines');
  console.log(`${'='.repeat(60)}\n`);

  // Per-slate table
  console.log('Per-Slate Results:');
  console.log(`${'Slate'.padEnd(10)} ${'t1'.padStart(4)} ${'Pay'.padStart(8)} ${'Stacks'.padStart(7)} ${'Own%'.padStart(6)} ${'Proj'.padStart(6)} ${'Scored'.padStart(7)}`);
  console.log('-'.repeat(52));

  let totalT1 = 0, totalPay = 0;
  for (const r of results) {
    totalT1 += r.t1;
    totalPay += r.totalPayout;
    console.log(
      `${r.slate.padEnd(10)} ${String(r.t1).padStart(4)} ${('$' + r.totalPayout.toFixed(0)).padStart(8)} ${String(r.stacks).padStart(7)} ${r.avgOwn.toFixed(1).padStart(6)} ${r.avgProj.toFixed(1).padStart(6)} ${(r.scored + '/' + TARGET_COUNT).padStart(7)}`,
    );
  }
  console.log('-'.repeat(52));
  console.log(
    `${'TOTAL'.padEnd(10)} ${String(totalT1).padStart(4)} ${('$' + totalPay.toFixed(0)).padStart(8)}`,
  );

  const totalFees = ENTRY_FEE * TARGET_COUNT * results.length;
  const roi = ((totalPay / totalFees) - 1) * 100;

  console.log(`\nEntry fees: $${ENTRY_FEE} x ${TARGET_COUNT} x ${results.length} slates = $${totalFees.toLocaleString()}`);
  console.log(`V35 ROI: ${roi.toFixed(1)}%`);

  // Comparison
  console.log('\n--- Comparison ---');
  console.log(`V32 baseline:   26 hits, $19,395 total payout`);
  console.log(`Production:     23 hits, $25,784 total payout`);
  console.log(`V35:            ${totalT1} hits, $${totalPay.toFixed(0)} total payout`);
  console.log(`V35 ROI: ${roi.toFixed(1)}% vs V32 ROI: ${(((19395 / totalFees) - 1) * 100).toFixed(1)}%`);
}

main().catch(err => {
  console.error('V35 backtest failed:', err);
  process.exit(1);
});
