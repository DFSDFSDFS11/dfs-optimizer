/**
 * 4-18-26 Mechanism Verification — λ=0 vs λ=0.05.
 *
 * Questions:
 *   1. How many lineups are shared between the two portfolios, and how many swapped?
 *   2. For the swapped lineups: are the λ=0.05 versions lower-combo-frequency (rarer)
 *      than the λ=0 versions they replaced? (If yes, mechanism worked as designed.)
 *   3. For the 11 top-1% hits in each portfolio: what ranks did they land?
 *      Did λ=0.05 cluster hits into higher payout tiers, or spread them?
 *   4. Summary stats: actual scores of hits, mean combo bonus of hits vs non-hits.
 *
 * If (2) says "yes, rarer" AND (3) says "higher ranks" → mechanism validated.
 * If (2) says "not meaningfully rarer" → $2,454 was coincidence with something else.
 */

import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals } from '../parser';
import { getContestConfig } from '../rules';
import { productionSelect } from '../selection/production-selector';
import { precomputeComboFrequencies, comboBonus, comboKeysForLineup } from '../selection/combo-leverage';

const DIR = 'C:/Users/colin/dfs opto';
const FEE = 20;

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

function getLineupActualScore(
  lu: Lineup,
  actualByHash: Map<string, number>,
  actuals: ContestActuals,
): number | null {
  const fa = actualByHash.get(lu.hash);
  if (fa !== undefined) return fa;
  let t = 0;
  for (const p of lu.players) {
    const r = actuals.playerActualsByName.get(norm(p.name));
    if (!r) return null;
    t += r.fpts;
  }
  return t;
}

function rankOf(score: number, sortedDescScores: number[]): number {
  let lo = 0, hi = sortedDescScores.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedDescScores[mid] >= score) lo = mid + 1; else hi = mid;
  }
  return Math.max(1, lo);
}

function primaryStack(lu: Lineup): string | null {
  const counts = new Map<string, number>();
  for (const p of lu.players) {
    if (!p.positions?.includes('P')) counts.set(p.team, (counts.get(p.team) || 0) + 1);
  }
  let maxT: string | null = null, maxC = 0;
  for (const [t, c] of counts) if (c > maxC) { maxC = c; maxT = t; }
  return maxC >= 4 ? maxT : null;
}

async function main() {
  console.log('=== 4-18-26 Mechanism Verification — λ=0 vs λ=0.05 ===\n');

  const projPath = path.join(DIR, '4-18-26projections.csv');
  const actualsPath = path.join(DIR, '4-18-26actuals.csv');
  const poolPath = path.join(DIR, '4-18-26sspool.csv');

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
  const sortedActuals = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
  const top1Thresh = sortedActuals[Math.max(0, Math.floor(F * 0.01) - 1)];

  console.log(`Field size: ${F}, top-1% threshold: ${top1Thresh.toFixed(2)} pts`);
  console.log(`Pool: ${loaded.lineups.length} lineups, ${comboFreq.size} unique combo keys\n`);

  // Run both configs
  const r0 = productionSelect(loaded.lineups, pool.players, { N: 150, lambda: 0, comboFreq });
  const r5 = productionSelect(loaded.lineups, pool.players, { N: 150, lambda: 0.05, comboFreq });

  const hashes0 = new Set(r0.portfolio.map(l => l.hash));
  const hashes5 = new Set(r5.portfolio.map(l => l.hash));

  const shared: Lineup[] = r0.portfolio.filter(l => hashes5.has(l.hash));
  const only0: Lineup[] = r0.portfolio.filter(l => !hashes5.has(l.hash));
  const only5: Lineup[] = r5.portfolio.filter(l => !hashes0.has(l.hash));

  console.log('=== PORTFOLIO OVERLAP ===');
  console.log(`  Shared:          ${shared.length} / 150`);
  console.log(`  Only in λ=0:     ${only0.length}`);
  console.log(`  Only in λ=0.05:  ${only5.length}`);

  // Combo bonus distribution — shared vs only-0 vs only-5
  const cb = (lu: Lineup) => comboBonus(lu, comboFreq);
  const mean = (arr: number[]) => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
  const median = (arr: number[]) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  console.log('\n=== COMBO BONUS (higher = rarer construction) ===');
  const sharedCb = shared.map(cb);
  const only0Cb = only0.map(cb);
  const only5Cb = only5.map(cb);
  console.log(`  Shared lineups:       mean=${mean(sharedCb).toFixed(2)}  median=${median(sharedCb).toFixed(2)}  (n=${shared.length})`);
  console.log(`  Only in λ=0 (dropped):mean=${mean(only0Cb).toFixed(2)}  median=${median(only0Cb).toFixed(2)}  (n=${only0.length})`);
  console.log(`  Only in λ=0.05 (new): mean=${mean(only5Cb).toFixed(2)}  median=${median(only5Cb).toFixed(2)}  (n=${only5.length})`);
  console.log(`  Delta (new - dropped): ${(mean(only5Cb) - mean(only0Cb)).toFixed(2)} points of log-rarity`);

  // Score each portfolio's lineups
  function analyzePortfolio(label: string, portfolio: Lineup[]) {
    const hits: Array<{ lu: Lineup; score: number; rank: number; payout: number; cb: number }> = [];
    let totalPay = 0;
    for (const lu of portfolio) {
      const s = getLineupActualScore(lu, actualByHash, actuals);
      if (s === null) continue;
      const rank = rankOf(s, sortedActuals);
      const payout = rank <= payoutTable.length ? payoutTable[rank - 1] : 0;
      if (payout > 0) {
        let coWin = 0;
        for (const e of actuals.entries) if (Math.abs(e.actualPoints - s) <= 0.25) coWin++;
        coWin = Math.max(0, coWin - 1);
        totalPay += payout / Math.sqrt(1 + coWin * 0.5);
      }
      if (s >= top1Thresh) hits.push({ lu, score: s, rank, payout, cb: cb(lu) });
    }
    hits.sort((a, b) => a.rank - b.rank);
    console.log(`\n=== ${label} — TOP-1% HITS (${hits.length}) ===`);
    console.log(`  Total portfolio payout: $${totalPay.toFixed(0)}`);
    console.log(`  Score | Rank | Payout | ComboBonus | Stack | Own%`);
    for (const h of hits) {
      const own = h.lu.players.reduce((s, p) => s + (p.ownership || 0), 0) / h.lu.players.length;
      const stk = primaryStack(h.lu) || '—';
      console.log(`  ${h.score.toFixed(2).padStart(6)} | ${String(h.rank).padStart(4)} | $${h.payout.toFixed(0).padStart(5)} | ${h.cb.toFixed(1).padStart(6)} | ${stk.padStart(4)} | ${own.toFixed(1)}%`);
    }
    // Rank distribution buckets
    const top05 = hits.filter(h => h.rank <= Math.floor(F * 0.005)).length;
    const top01 = hits.filter(h => h.rank <= Math.floor(F * 0.001)).length;
    console.log(`  Rank tiers: top-0.1%=${top01}, top-0.5%=${top05}, top-1%=${hits.length}`);
    return { hits, totalPay };
  }

  const p0 = analyzePortfolio('λ=0', r0.portfolio);
  const p5 = analyzePortfolio('λ=0.05', r5.portfolio);

  // Compare hits set
  const hitHashes0 = new Set(p0.hits.map(h => h.lu.hash));
  const hitHashes5 = new Set(p5.hits.map(h => h.lu.hash));
  const hitShared = p0.hits.filter(h => hitHashes5.has(h.lu.hash));
  const hitOnly0 = p0.hits.filter(h => !hitHashes5.has(h.lu.hash));
  const hitOnly5 = p5.hits.filter(h => !hitHashes0.has(h.lu.hash));

  console.log('\n=== HIT OVERLAP ===');
  console.log(`  Shared hits:            ${hitShared.length}`);
  console.log(`  Hits only in λ=0:       ${hitOnly0.length}  avg score=${mean(hitOnly0.map(h => h.score)).toFixed(2)}  avg rank=${mean(hitOnly0.map(h => h.rank)).toFixed(0)}  avg combo=${mean(hitOnly0.map(h => h.cb)).toFixed(1)}`);
  console.log(`  Hits only in λ=0.05:    ${hitOnly5.length}  avg score=${mean(hitOnly5.map(h => h.score)).toFixed(2)}  avg rank=${mean(hitOnly5.map(h => h.rank)).toFixed(0)}  avg combo=${mean(hitOnly5.map(h => h.cb)).toFixed(1)}`);

  console.log('\n=== VERDICT ===');
  const rarer = mean(only5Cb) > mean(only0Cb);
  const higherRanked = mean(hitOnly5.map(h => h.rank)) < mean(hitOnly0.map(h => h.rank)) || hitOnly5.length > hitOnly0.length;
  if (rarer) {
    console.log(`  ✓ λ=0.05 swapped in lineups with ${(mean(only5Cb) - mean(only0Cb)).toFixed(2)} more log-rarity than what it dropped. Mechanism active.`);
  } else {
    console.log(`  ✗ λ=0.05's new lineups are NOT meaningfully rarer than dropped ones. Mechanism suspect.`);
  }
  console.log(`  λ=0 payout:    $${p0.totalPay.toFixed(0)}`);
  console.log(`  λ=0.05 payout: $${p5.totalPay.toFixed(0)}`);
  console.log(`  Delta: +$${(p5.totalPay - p0.totalPay).toFixed(0)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
