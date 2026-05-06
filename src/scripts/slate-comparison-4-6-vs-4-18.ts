/**
 * Slate comparison: 4-6 vs 4-18, with nerdy ROI + closest selector per slate.
 *
 * 4-6 and 4-18 emerged as "inverse slates" — mechanisms that win on 4-6 die on 4-18.
 * Understand why: slate characterization, winning-lineup analysis, nerdy ROI.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals } from '../parser';
import { getContestConfig } from '../rules';

const DIR = 'C:/Users/colin/dfs opto';
const FEE = 20;

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function mean(arr: number[]): number { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; }
function stddev(arr: number[]): number { if (arr.length < 2) return 0; const m = mean(arr); return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length); }
function percentile(arr: number[], p: number): number { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.max(0, Math.min(s.length - 1, Math.floor(p * s.length)))]; }

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

const TARGET_SLATES = [
  { slate: '4-6-26', proj: '4-6-26_projections.csv', actuals: 'dkactuals 4-6-26.csv', pool: 'sspool4-6-26.csv' },
  { slate: '4-18-26', proj: '4-18-26projections.csv', actuals: '4-18-26actuals.csv', pool: '4-18-26sspool.csv' },
];

async function main() {
  for (const s of TARGET_SLATES) {
    console.log(`\n================================================================`);
    console.log(`=== ${s.slate} ===`);
    console.log(`================================================================`);

    const pr = parseCSVFile(path.join(DIR, s.proj), 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(path.join(DIR, s.actuals), config);
    const nameMap = new Map<string, Player>();
    for (const p of pool.players) nameMap.set(norm(p.name), p);
    const idMap = new Map<string, Player>();
    for (const p of pool.players) idMap.set(p.id, p);
    const loaded = loadPoolFromCSV({ filePath: path.join(DIR, s.pool), config, playerMap: idMap });
    const F = actuals.entries.length;
    const payoutTable = buildPayoutTable(F);

    // Slate characterization
    const teams = new Set(pool.players.map(p => p.team));
    const games = new Set(pool.players.map(p => p.gameInfo).filter(g => g));
    console.log(`\nSLATE STRUCTURE:`);
    console.log(`  Games: ${games.size} (${[...games].slice(0, 5).join(', ')}${games.size > 5 ? '...' : ''})`);
    console.log(`  Teams: ${teams.size}`);
    console.log(`  Players: ${pool.players.length}`);
    console.log(`  Field: ${F.toLocaleString()} entries`);
    console.log(`  Pool: ${loaded.lineups.length} pre-built lineups`);

    // Projection + ownership distribution
    const projs = pool.players.map(p => p.projection || 0).filter(v => v > 0).sort((a, b) => b - a);
    const owns = pool.players.map(p => p.ownership || 0).filter(v => v > 0).sort((a, b) => b - a);
    console.log(`\n  Top player projections: ${projs.slice(0, 5).map(p => p.toFixed(1)).join(', ')}`);
    console.log(`  Top player ownerships: ${owns.slice(0, 8).map(p => p.toFixed(1) + '%').join(', ')}`);
    console.log(`  Ownership p50/p75/p90/max: ${percentile(owns, 0.5).toFixed(1)}% / ${percentile(owns, 0.75).toFixed(1)}% / ${percentile(owns, 0.9).toFixed(1)}% / ${owns[0].toFixed(1)}%`);

    // Game totals
    const gameTotals = [...new Set(pool.players.map(p => p.gameTotal).filter(g => g))];
    console.log(`  Avg game total: ${mean(gameTotals).toFixed(1)}`);

    // Actuals distribution
    const scores = actuals.entries.map(e => e.actualPoints);
    const sortedScores = [...scores].sort((a, b) => b - a);
    const top1 = sortedScores[Math.max(0, Math.floor(F * 0.01) - 1)];
    console.log(`\nACTUAL RESULTS:`);
    console.log(`  Winning score: ${sortedScores[0].toFixed(2)}`);
    console.log(`  Top-1% threshold: ${top1.toFixed(2)}`);
    console.log(`  Top-10% threshold: ${sortedScores[Math.max(0, Math.floor(F * 0.1) - 1)].toFixed(2)}`);
    console.log(`  Median score: ${sortedScores[Math.floor(F * 0.5)].toFixed(2)}`);

    // Analyze winning construction — look at top-5 lineups' players
    console.log(`\n  Top-5 lineup constructions:`);
    for (let i = 0; i < Math.min(5, actuals.entries.length); i++) {
      const e = actuals.entries[i];
      const rank = i + 1;
      console.log(`    Rank ${rank}: ${e.actualPoints.toFixed(2)} pts — ${e.entryName}`);
      // Look up player details
      const pls: Player[] = [];
      for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (p) pls.push(p); }
      const teamCounts = new Map<string, number>();
      for (const p of pls) if (!p.positions?.includes('P')) teamCounts.set(p.team, (teamCounts.get(p.team) || 0) + 1);
      const stackShape = [...teamCounts.values()].filter(v => v >= 2).sort((a, b) => b - a).join('-') || 'no-stack';
      const pitchers = pls.filter(p => p.positions?.includes('P')).map(p => `${p.name}(${(p.ownership || 0).toFixed(1)}%)`).join(' + ');
      const avgOwn = pls.length > 0 ? mean(pls.map(p => p.ownership || 0)) : 0;
      console.log(`      Stack: ${stackShape}, Pitchers: ${pitchers}, Avg own: ${avgOwn.toFixed(1)}%`);
    }

    // ==========================================================
    // NERDY ROI on this slate
    // ==========================================================
    const nerdyEntries = actuals.entries.filter(e => e.entryName.toLowerCase().includes('nerdytenor'));
    console.log(`\nNERDYTENOR on ${s.slate}:`);
    console.log(`  Entries: ${nerdyEntries.length}`);
    if (nerdyEntries.length === 0) {
      console.log(`  NO NERDY DATA — his 150 entries not present in actuals file. Can't compute his ROI.`);
      continue;
    }

    let nerdyPayout = 0, nerdyHits = 0;
    const nerdyRanks: number[] = [];
    const nerdyScoresHits: Array<{ score: number; rank: number; payout: number }> = [];
    for (const e of nerdyEntries) {
      const a = e.actualPoints;
      let lo = 0, hi = sortedScores.length;
      while (lo < hi) { const m = (lo + hi) >>> 1; if (sortedScores[m] >= a) lo = m + 1; else hi = m; }
      const rank = Math.max(1, lo);
      nerdyRanks.push(rank);
      if (a >= top1) nerdyHits++;
      const payout = rank <= payoutTable.length ? payoutTable[rank - 1] : 0;
      if (payout > 0) {
        let coWin = 0;
        for (const other of actuals.entries) if (Math.abs(other.actualPoints - a) <= 0.25) coWin++;
        coWin = Math.max(0, coWin - 1);
        const adjPay = payout / Math.sqrt(1 + coWin * 0.5);
        nerdyPayout += adjPay;
        if (rank <= Math.max(50, payoutTable.length * 0.01)) nerdyScoresHits.push({ score: a, rank, payout: adjPay });
      }
    }
    const nerdyFees = FEE * nerdyEntries.length;
    const nerdyROI = (nerdyPayout / nerdyFees - 1) * 100;
    console.log(`  Fees: $${nerdyFees.toFixed(0)}`);
    console.log(`  Payout: $${nerdyPayout.toFixed(0)}`);
    console.log(`  ROI: ${nerdyROI.toFixed(1)}%`);
    console.log(`  Top-1% hits: ${nerdyHits}`);
    console.log(`  Best rank: ${Math.min(...nerdyRanks)}`);
    console.log(`  Median rank: ${percentile(nerdyRanks, 0.5)}`);
    if (nerdyScoresHits.length > 0) {
      nerdyScoresHits.sort((a, b) => a.rank - b.rank);
      console.log(`\n  Nerdy's top lineups:`);
      for (const h of nerdyScoresHits.slice(0, 5)) {
        console.log(`    Rank ${h.rank}: ${h.score.toFixed(2)} pts, payout $${h.payout.toFixed(0)}`);
      }
    }
  }

  console.log(`\n================================================================`);
  console.log(`COMPARISON SUMMARY`);
  console.log(`================================================================`);
  console.log(`
See the detailed slate output above for:
- What drove winning lineups (stack types, pitcher ownership)
- Nerdy ROI per slate
- Slate-specific pool characteristics

Key structural differences to note:
- 4-6-26 is a 7-game slate (large) with generally concentrated ownership
- 4-18-26 is a 6-game slate with different ownership+projection distribution
- Winners on each slate come from different construction patterns
`);
}

main().catch(e => { console.error(e); process.exit(1); });
