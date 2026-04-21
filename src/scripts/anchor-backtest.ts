/**
 * Anchor-Relative Backtest — leave-one-out across 7 slates.
 * Builds winner + maxer distributions from 6 slates, applies to held-out slate.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals } from '../parser';
import { getContestConfig } from '../rules';
import {
  computeAnchor, buildWinnerDistribution, buildMaxerDistribution,
  computeAnchorTargets, anchorRelativeSelect,
} from '../selection/anchor-relative';

const PROJ_BINS = [-30, -20, -15, -10, -7, -4, -1, 3];
const OWN_BINS = [-12, -8, -5, -3, -1, 1, 3, 6];

const DIR = 'C:/Users/colin/dfs opto';
const FEE = 20;
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
function norm(n: string): string { return (n||'').toLowerCase().replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim(); }

function buildPayoutTable(F: number): Float64Array {
  const pool = F * FEE * 0.88; const cashLine = Math.floor(F * 0.22);
  const raw = new Float64Array(cashLine); let rawSum = 0;
  for (let r = 0; r < cashLine; r++) { raw[r] = Math.pow(r + 1, -1.15); rawSum += raw[r]; }
  const table = new Float64Array(F); const minCash = FEE * 1.2;
  for (let r = 0; r < cashLine; r++) table[r] = Math.max(minCash, (raw[r] / rawSum) * pool);
  let tSum = 0; for (let r = 0; r < cashLine; r++) tSum += table[r];
  const scale = pool / tSum; for (let r = 0; r < cashLine; r++) table[r] *= scale;
  return table;
}

function scorePortfolio(portfolio: Lineup[], actuals: ContestActuals, actualByHash: Map<string, number>, payoutTable: Float64Array) {
  const F = actuals.entries.length;
  const sorted = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
  const top1T = sorted[Math.max(0, Math.floor(F * 0.01) - 1)] || 0;
  let t1 = 0, scored = 0, totalPayout = 0;
  for (const lu of portfolio) {
    const fa = actualByHash.get(lu.hash); let a: number | null = fa !== undefined ? fa : null;
    if (a === null) { let t = 0, miss = false; for (const p of lu.players) { const r = actuals.playerActualsByName.get(norm(p.name)); if (!r) { miss = true; break; } t += r.fpts; } if (!miss) a = t; }
    if (a === null) continue; scored++;
    let lo = 0, hi = sorted.length; while (lo < hi) { const mid = (lo + hi) >>> 1; if (sorted[mid] >= a) lo = mid + 1; else hi = mid; }
    const rank = Math.max(1, lo);
    if (a >= top1T) t1++;
    const payout = rank <= payoutTable.length ? payoutTable[rank - 1] : 0;
    if (payout > 0) { let coWin = 0; for (const e of actuals.entries) if (Math.abs(e.actualPoints - a) <= 0.25) coWin++; coWin = Math.max(0, coWin - 1); totalPayout += payout / Math.sqrt(1 + coWin * 0.5); }
  }
  const stackTeams = new Set<string>(); let sOwn = 0, sProj = 0;
  for (const lu of portfolio) { sOwn += lu.players.reduce((s: number, p: Player) => s + (p.ownership || 0), 0) / lu.players.length; sProj += lu.projection; const tc = new Map<string, number>(); for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1); for (const [t, c] of tc) if (c >= 4) stackTeams.add(t); }
  return { t1, scored, totalPayout, stacks: stackTeams.size, avgOwn: portfolio.length > 0 ? sOwn / portfolio.length : 0, avgProj: portfolio.length > 0 ? sProj / portfolio.length : 0 };
}

async function main() {
  const pct = (v: number) => `${(v*100).toFixed(2)}%`;

  // Pre-load all slates
  interface SlateInfo { slate: string; actuals: ContestActuals; nameMap: Map<string, Player>; pool: Lineup[]; players: Player[]; config: any }
  const slateData: SlateInfo[] = [];
  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj), actualsPath = path.join(DIR, s.actuals), poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) continue;
    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);
    const nameMap = new Map<string, Player>(); for (const p of pool.players) nameMap.set(norm(p.name), p);
    const idMap = new Map<string, Player>(); for (const p of pool.players) idMap.set(p.id, p);
    const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
    slateData.push({ slate: s.slate, actuals, nameMap, pool: loaded.lineups, players: pool.players, config });
  }

  let md = `# Anchor-Relative Backtest — 70% Winners + 30% Maxers (${slateData.length} slates)\n\n`;
  md += `| Slate | F | AR t1 | AR pay | AR stacks | AR own | AR proj | Anchor proj |\n`;
  md += `|---|---:|---:|---:|---:|---:|---:|---:|\n`;

  let totalPay = 0, totalT1 = 0, n = 0;

  for (let i = 0; i < slateData.length; i++) {
    const held = slateData[i];
    console.log(`\n=== ${held.slate} ===`);

    // Build distributions from OTHER slates
    const training = slateData.filter((_, j) => j !== i).map(sd => ({
      actuals: sd.actuals, nameMap: sd.nameMap, pool: sd.pool,
    }));
    const winnerDist = buildWinnerDistribution(training);
    const maxerDist = buildMaxerDistribution(training);
    console.log(`  winner dist: ${winnerDist.totalEntries} entries, ${winnerDist.bins.size} bins`);
    console.log(`  maxer dist: ${maxerDist.totalEntries} entries, ${maxerDist.bins.size} bins`);

    // Compute anchor for held-out slate
    const anchor = computeAnchor(held.pool);
    console.log(`  anchor: proj=${anchor.projection.toFixed(1)} own=${anchor.ownership.toFixed(1)}%`);

    // Compute targets
    const targets = computeAnchorTargets(winnerDist, maxerDist, anchor, 150, 0.85);
    const totalAlloc = [...targets.allocations.values()].reduce((a, b) => a + b, 0);
    console.log(`  ${targets.allocations.size} target bins, ${totalAlloc} total allocated`);
    // Show top bins by allocation
    const topBins = [...targets.allocations.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    for (const [k, count] of topBins) {
      const [pIdx, oIdx] = k.split('_').map(Number);
      const pLo = PROJ_BINS[pIdx] || -30, pHi = PROJ_BINS[pIdx + 1] || 999;
      const oLo = OWN_BINS[oIdx] || -12, oHi = OWN_BINS[oIdx + 1] || 999;
      console.log(`    bin projΔ[${pLo},${pHi}) ownΔ[${oLo},${oHi}): ${count} entries`);
    }

    // Select
    const maxPerTeam = Math.floor(150 * 0.10);
    const portfolio = anchorRelativeSelect(held.pool, targets, 150, 0.40, maxPerTeam);

    // Team coverage enforcement (same as V32)
    const covTeams = new Map<string, number>();
    for (const lu of portfolio) {
      const tc = new Map<string, number>();
      for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
      for (const [t, c] of tc) if (c >= 4) covTeams.set(t, (covTeams.get(t) || 0) + 1);
    }
    const allTeams = new Set<string>();
    for (const p of held.players) if (p.team) allTeams.add(p.team);
    const minPerTeam = Math.max(3, Math.floor(150 / allTeams.size * 0.6));
    const portfolioHashes = new Set(portfolio.map(l => l.hash));
    const portfolioPlayerCount = new Map<string, number>();
    for (const lu of portfolio) for (const p of lu.players) portfolioPlayerCount.set(p.id, (portfolioPlayerCount.get(p.id) || 0) + 1);
    const expCapTC = Math.ceil(0.40 * 150);

    for (const team of allTeams) {
      if ((covTeams.get(team) || 0) >= minPerTeam) continue;
      const teamCands = held.pool.filter(lu => {
        const tc = new Map<string, number>();
        for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
        return (tc.get(team) || 0) >= 4;
      });
      if (teamCands.length < 5) continue;
      const sorted2 = teamCands.sort((a, b) => b.projection - a.projection);
      const needed = minPerTeam - (covTeams.get(team) || 0);
      let added = 0;
      for (const lu of sorted2) {
        if (added >= needed) break;
        if (portfolioHashes.has(lu.hash)) continue;
        let expOk = true;
        for (const p of lu.players) if ((portfolioPlayerCount.get(p.id) || 0) >= expCapTC) { expOk = false; break; }
        if (!expOk) continue;
        if (portfolio.length >= 150) {
          const wIdx = portfolio.reduce((best, lu2, idx) => lu2.projection < portfolio[best].projection ? idx : best, 0);
          const rem = portfolio[wIdx];
          for (const p of rem.players) { const c = portfolioPlayerCount.get(p.id) || 0; if (c > 0) portfolioPlayerCount.set(p.id, c - 1); }
          portfolioHashes.delete(rem.hash);
          portfolio[wIdx] = lu;
        } else {
          portfolio.push(lu);
        }
        portfolioHashes.add(lu.hash);
        for (const p of lu.players) portfolioPlayerCount.set(p.id, (portfolioPlayerCount.get(p.id) || 0) + 1);
        added++;
      }
    }

    // Score
    const F = held.actuals.entries.length;
    const payoutTable = buildPayoutTable(F);
    const actualByHash = new Map<string, number>();
    for (const e of held.actuals.entries) {
      const pls: Player[] = []; let ok = true;
      for (const nm of e.playerNames) { const p = held.nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
      if (!ok) continue;
      actualByHash.set(pls.map(p => p.id).sort().join('|'), e.actualPoints);
    }
    const result = scorePortfolio(portfolio, held.actuals, actualByHash, payoutTable);

    console.log(`  AR: t1=${result.t1} pay=$${result.totalPayout.toFixed(0)} stacks=${result.stacks} own=${result.avgOwn.toFixed(1)}% proj=${result.avgProj.toFixed(1)}`);

    totalPay += result.totalPayout; totalT1 += result.t1; n++;
    md += `| ${held.slate} | ${F.toLocaleString()} | ${result.t1} (${pct(result.scored>0?result.t1/result.scored:0)}) | $${result.totalPayout.toFixed(0)} | ${result.stacks} | ${result.avgOwn.toFixed(1)}% | ${result.avgProj.toFixed(1)} | ${anchor.projection.toFixed(1)} |\n`;
  }

  const totalFees = FEE * 150 * n;
  md += `| **TOTAL** | | **${totalT1}** | **$${totalPay.toFixed(0)}** | | | | |\n\n`;
  md += `**Anchor-Relative ROI: ${((totalPay/totalFees-1)*100).toFixed(1)}%**\n\n`;
  md += `Baselines:\n`;
  md += `- V32 regions: $19,014, −9.5% ROI, 25 hits\n`;
  md += `- Parimutuel EV: $7,433, −64.6% ROI\n`;
  md += `- Distribution match: $5,580, −73.4% ROI\n`;

  fs.writeFileSync(path.join(DIR, 'anchor_relative_backtest.md'), md);
  console.log(`\n✓ Report: ${path.join(DIR, 'anchor_relative_backtest.md')}`);
}
main();
