/**
 * Calibrated Anchor Backtest — target ownership = top-50 anchor ownership - 6pp.
 * Within that ownership band, pick by projection. 15% team max. 8 slates.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals } from '../parser';
import { getContestConfig } from '../rules';
import { computeAnchor } from '../selection/anchor-relative';

const DIR = 'C:/Users/colin/dfs opto';
const FEE = 20;
const OWN_DROP = 6.0; // pp below anchor
const OWN_BAND = 4.0; // ±pp around target
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

function calibratedSelect(pool: Lineup[], players: Player[], N: number): Lineup[] {
  const maxPerTeam = Math.floor(N * 0.15);
  const expCap = Math.ceil(0.40 * N);

  // Compute anchor ownership from top-50 pool lineups
  const anchor = computeAnchor(pool, 50);
  const targetAvgOwn = anchor.ownership - OWN_DROP;

  console.log(`    anchor own=${anchor.ownership.toFixed(1)}% target avg=${targetAvgOwn.toFixed(1)}%`);

  // Compute each lineup's ownership
  const poolWithOwn = pool.map((lu, i) => ({
    lu, i,
    own: lu.players.reduce((s, p) => s + (p.ownership || 0), 0) / lu.players.length,
    proj: lu.projection,
  }));

  // Sort ALL by projection (best first)
  const sorted = [...poolWithOwn].sort((a, b) => b.proj - a.proj);

  const selected: Lineup[] = [];
  const selectedHashes = new Set<string>();
  const playerCount = new Map<string, number>();
  const teamStackCount = new Map<string, number>();
  let runningOwnSum = 0;

  const tryAdd = (cand: typeof sorted[0]): boolean => {
    const lu = cand.lu;
    if (selectedHashes.has(lu.hash)) return false;
    let expOk = true;
    for (const p of lu.players) if ((playerCount.get(p.id) || 0) >= expCap) { expOk = false; break; }
    if (!expOk) return false;
    const tc = new Map<string, number>();
    for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
    let teamOk = true;
    for (const [t, cnt] of tc) if (cnt >= 4 && (teamStackCount.get(t) || 0) >= maxPerTeam) { teamOk = false; break; }
    if (!teamOk) return false;

    // Check: would adding this lineup push portfolio avg ownership too far from target?
    const newAvg = (runningOwnSum + cand.own) / (selected.length + 1);
    const remainingSlots = N - selected.length - 1;
    // Can we still reach target with remaining slots?
    // If current avg is too high, we need low-own lineups later (they exist)
    // If current avg is too low, we need high-own lineups later (they exist)
    // Only reject if it's IMPOSSIBLE to reach target:
    // Reject chalk if avg would be > target + 3pp AND we're past 50% filled
    // Reject contrarian if avg would be < target - 5pp AND we're past 50% filled
    if (selected.length > N * 0.5) {
      if (newAvg > targetAvgOwn + 3.0 && cand.own > targetAvgOwn + 5.0) return false;
      if (newAvg < targetAvgOwn - 5.0 && cand.own < targetAvgOwn - 8.0) return false;
    }

    selected.push(lu);
    selectedHashes.add(lu.hash);
    runningOwnSum += cand.own;
    for (const p of lu.players) playerCount.set(p.id, (playerCount.get(p.id) || 0) + 1);
    for (const [t, cnt] of tc) if (cnt >= 4) teamStackCount.set(t, (teamStackCount.get(t) || 0) + 1);
    return true;
  };

  // Greedy: pick highest projection that keeps avg ownership near target
  for (const c of sorted) { if (selected.length >= N) break; tryAdd(c); }

  // Team coverage enforcement
  const allTeams = new Set<string>(); for (const p of players) if (p.team) allTeams.add(p.team);
  const minPerTeam = Math.max(3, Math.floor(N / allTeams.size * 0.6));
  const covTeams = new Map<string, number>();
  for (const lu of selected) { const tc = new Map<string, number>(); for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1); for (const [t, c] of tc) if (c >= 4) covTeams.set(t, (covTeams.get(t) || 0) + 1); }

  for (const team of allTeams) {
    if ((covTeams.get(team) || 0) >= minPerTeam) continue;
    const teamCands = poolWithOwn.filter(c => {
      const tc = new Map<string, number>(); for (const p of c.lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
      return (tc.get(team) || 0) >= 4;
    }).sort((a, b) => b.proj - a.proj);
    if (teamCands.length < 5) continue;
    const needed = minPerTeam - (covTeams.get(team) || 0);
    let added = 0;
    for (const cand of teamCands) {
      if (added >= needed) break;
      if (selectedHashes.has(cand.lu.hash)) continue;
      let expOk = true; for (const p of cand.lu.players) if ((playerCount.get(p.id) || 0) >= expCap) { expOk = false; break; } if (!expOk) continue;
      if (selected.length >= N) {
        const wIdx = selected.reduce((best, lu2, idx) => lu2.projection < selected[best].projection ? idx : best, 0);
        const rem = selected[wIdx]; for (const p of rem.players) { const c2 = playerCount.get(p.id) || 0; if (c2 > 0) playerCount.set(p.id, c2 - 1); }
        selectedHashes.delete(rem.hash); selected[wIdx] = cand.lu;
      } else selected.push(cand.lu);
      selectedHashes.add(cand.lu.hash); for (const p of cand.lu.players) playerCount.set(p.id, (playerCount.get(p.id) || 0) + 1);
      added++;
    }
  }

  return selected;
}

async function main() {
  const pct = (v: number) => `${(v*100).toFixed(2)}%`;
  let md = `# Calibrated Anchor — Own = Top50 - 6pp, 15% team cap (${SLATES.length} slates)\n\n`;
  md += `| Slate | F | t1 | pay | stacks | own | proj | anchorOwn | targetOwn |\n`;
  md += `|---|---:|---:|---:|---:|---:|---:|---:|---:|\n`;

  let totalPay = 0, totalT1 = 0, n = 0;

  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj), actualsPath = path.join(DIR, s.actuals), poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) continue;
    console.log(`\n=== ${s.slate} ===`);
    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);
    const nameMap = new Map<string, Player>(); for (const p of pool.players) nameMap.set(norm(p.name), p);
    const idMap = new Map<string, Player>(); for (const p of pool.players) idMap.set(p.id, p);
    const F = actuals.entries.length;
    const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
    const payoutTable = buildPayoutTable(F);
    const actualByHash = new Map<string, number>();
    for (const e of actuals.entries) { const pls: Player[] = []; let ok = true; for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); } if (!ok) continue; actualByHash.set(pls.map(p => p.id).sort().join('|'), e.actualPoints); }

    const anchor = computeAnchor(loaded.lineups, 50);
    const portfolio = calibratedSelect(loaded.lineups, pool.players, 150);
    const result = scorePortfolio(portfolio, actuals, actualByHash, payoutTable);

    console.log(`  t1=${result.t1} pay=$${result.totalPayout.toFixed(0)} stacks=${result.stacks} own=${result.avgOwn.toFixed(1)}% proj=${result.avgProj.toFixed(1)}`);
    totalPay += result.totalPayout; totalT1 += result.t1; n++;
    md += `| ${s.slate} | ${F.toLocaleString()} | ${result.t1} (${pct(result.scored>0?result.t1/result.scored:0)}) | $${result.totalPayout.toFixed(0)} | ${result.stacks} | ${result.avgOwn.toFixed(1)}% | ${result.avgProj.toFixed(1)} | ${anchor.ownership.toFixed(1)}% | ${(anchor.ownership - OWN_DROP).toFixed(1)}% |\n`;
  }

  const totalFees = FEE * 150 * n;
  md += `| **TOTAL** | | **${totalT1}** | **$${totalPay.toFixed(0)}** | | | | | |\n\n`;
  md += `**ROI: ${((totalPay/totalFees-1)*100).toFixed(1)}%**\n\n`;
  md += `| Selector | Hits | Payout | ROI |\n|---|---:|---:|---:|\n`;
  md += `| **Calibrated Anchor (own-6pp, 15% team)** | **${totalT1}** | **$${totalPay.toFixed(0)}** | **${((totalPay/totalFees-1)*100).toFixed(1)}%** |\n`;
  md += `| V32 regions (8 slates) | 26 | $19,395 | −19.2% |\n`;
  md += `| Anchor-relative 10% cap (7 slates) | 17 | $18,410 | −12.3% |\n`;

  fs.writeFileSync(path.join(DIR, 'calibrated_anchor_backtest.md'), md);
  console.log(`\n✓ Report: ${path.join(DIR, 'calibrated_anchor_backtest.md')}`);
}
main();
