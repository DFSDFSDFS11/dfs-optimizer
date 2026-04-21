/**
 * Production Selector Backtest — 8 MLB slates.
 *
 * Tests the clean production selector architecture:
 *   - Anchor-relative coordinates (top-50 centroid)
 *   - Ownership targeting at anchor - 6pp via bin allocation
 *   - 10% team stack cap
 *   - Raw projection within bins
 *   - Team coverage enforcement
 *
 * Baseline: V32 $19,395 on 8 slates.
 * Payout model: power-law alpha=1.15, 22% cash line, $20 entry fee.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals } from '../parser';
import { getContestConfig } from '../rules';
import { productionSelect, DEFAULT_PRODUCTION_CONFIG, ProductionConfig } from '../selection/production-selector';

const DIR = 'C:/Users/colin/dfs opto';
const FEE = 20;
const N = 150;

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
// PAYOUT MODEL — same as all other backtests
// ============================================================

function buildPayoutTable(F: number): Float64Array {
  const pool = F * FEE * 0.88;
  const cashLine = Math.floor(F * 0.22);
  const raw = new Float64Array(cashLine);
  let rawSum = 0;
  for (let r = 0; r < cashLine; r++) {
    raw[r] = Math.pow(r + 1, -1.15);
    rawSum += raw[r];
  }
  const table = new Float64Array(F);
  const minCash = FEE * 1.2;
  for (let r = 0; r < cashLine; r++) {
    table[r] = Math.max(minCash, (raw[r] / rawSum) * pool);
  }
  let tSum = 0;
  for (let r = 0; r < cashLine; r++) tSum += table[r];
  const scale = pool / tSum;
  for (let r = 0; r < cashLine; r++) table[r] *= scale;
  return table;
}

// ============================================================
// SCORING — identical to other backtests
// ============================================================

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

    // Rank via binary search
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

  // Portfolio stats
  const stackTeams = new Set<string>();
  let sOwn = 0, sProj = 0;
  for (const lu of portfolio) {
    sOwn += lu.players.reduce((s: number, p: Player) => s + (p.ownership || 0), 0) / lu.players.length;
    sProj += lu.projection;
    const tc = new Map<string, number>();
    for (const p of lu.players) {
      if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
    }
    for (const [t, c] of tc) if (c >= 4) stackTeams.add(t);
  }

  return {
    t1,
    scored,
    totalPayout,
    stacks: stackTeams.size,
    avgOwn: portfolio.length > 0 ? sOwn / portfolio.length : 0,
    avgProj: portfolio.length > 0 ? sProj / portfolio.length : 0,
  };
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

  console.log('================================================================');
  console.log('PRODUCTION SELECTOR BACKTEST — 8 MLB slates');
  console.log('================================================================');
  console.log(`  Own target: anchor - ${DEFAULT_PRODUCTION_CONFIG.ownDropPP}pp`);
  console.log(`  Team cap: ${(DEFAULT_PRODUCTION_CONFIG.teamCapPct * 100).toFixed(0)}%`);
  console.log(`  Max exposure: ${(DEFAULT_PRODUCTION_CONFIG.maxExposure * 100).toFixed(0)}%`);
  console.log(`  Anchor top-K: ${DEFAULT_PRODUCTION_CONFIG.anchorTopK}`);
  console.log();

  let totalPay = 0, totalT1 = 0, totalScored = 0, n = 0;

  const results: Array<{
    slate: string; F: number; t1: number; pay: number; stacks: number;
    avgOwn: number; avgProj: number; anchorOwn: number; targetOwn: number;
    actualAvgOwn: number; scored: number;
    binFills: Map<string, number>;
  }> = [];

  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj);
    const actualsPath = path.join(DIR, s.actuals);
    const poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) {
      console.log(`  SKIP ${s.slate} — missing files`);
      continue;
    }

    console.log(`\n=== ${s.slate} ===`);

    // Parse
    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);
    const nameMap = new Map<string, Player>();
    for (const p of pool.players) nameMap.set(norm(p.name), p);
    const idMap = new Map<string, Player>();
    for (const p of pool.players) idMap.set(p.id, p);

    const F = actuals.entries.length;
    const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });

    // Build actual score lookup
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

    // Run production selector
    const result = productionSelect(loaded.lineups, pool.players, { N });

    console.log(`  anchor: own=${result.anchor.ownership.toFixed(1)}% proj=${result.anchor.projection.toFixed(1)}`);
    console.log(`  target own: ${result.targetOwnership.toFixed(1)}%`);
    console.log(`  actual avg own: ${result.actualAvgOwnership.toFixed(1)}% (delta: ${(result.actualAvgOwnership - result.targetOwnership).toFixed(1)}pp)`);
    console.log(`  actual avg proj: ${result.actualAvgProjection.toFixed(1)}`);
    console.log(`  portfolio size: ${result.portfolio.length}`);

    // Bin fills
    const binLabels = ['chalk', 'core', 'value', 'contra', 'deep'];
    const binStr = binLabels.map(b => `${b}=${result.binFills.get(b) || 0}`).join(', ');
    console.log(`  bin fills: ${binStr}`);

    // Team stacks
    const teamStr = [...result.teamStackCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([t, c]) => `${t}:${c}`)
      .join(', ');
    console.log(`  top stacks: ${teamStr}`);

    // Score
    const payoutTable = buildPayoutTable(F);
    const scored = scorePortfolio(result.portfolio, actuals, actualByHash, payoutTable);

    console.log(`  t1: ${scored.t1} (${pct(scored.scored > 0 ? scored.t1 / scored.scored : 0)})`);
    console.log(`  payout: $${scored.totalPayout.toFixed(0)}`);
    console.log(`  stacks covered: ${scored.stacks}`);

    totalPay += scored.totalPayout;
    totalT1 += scored.t1;
    totalScored += scored.scored;
    n++;

    results.push({
      slate: s.slate, F, t1: scored.t1, pay: scored.totalPayout,
      stacks: scored.stacks, avgOwn: scored.avgOwn, avgProj: scored.avgProj,
      anchorOwn: result.anchor.ownership, targetOwn: result.targetOwnership,
      actualAvgOwn: result.actualAvgOwnership, scored: scored.scored,
      binFills: result.binFills,
    });
  }

  // Summary
  const totalFees = FEE * N * n;
  const roi = ((totalPay / totalFees - 1) * 100).toFixed(1);

  console.log('\n================================================================');
  console.log('RESULTS SUMMARY');
  console.log('================================================================');
  console.log();

  // Table header
  console.log('Slate      |     F | t1  |    Pay | Stks | Own%  | Proj  | AncOwn | TgtOwn');
  console.log('-----------|-------|-----|--------|------|-------|-------|--------|-------');
  for (const r of results) {
    const t1Pct = r.scored > 0 ? (r.t1 / r.scored * 100).toFixed(1) : '0.0';
    console.log(
      `${r.slate.padEnd(10)} | ${String(r.F).padStart(5)} | ${String(r.t1).padStart(3)} | $${r.pay.toFixed(0).padStart(5)} | ${String(r.stacks).padStart(4)} | ${r.avgOwn.toFixed(1).padStart(5)} | ${r.avgProj.toFixed(1).padStart(5)} | ${r.anchorOwn.toFixed(1).padStart(6)} | ${r.targetOwn.toFixed(1).padStart(5)}`
    );
  }

  console.log();
  console.log(`TOTAL: ${totalT1} top-1% hits, $${totalPay.toFixed(0)} payout`);
  console.log(`Fees:  $${totalFees.toLocaleString()} (${n} slates x ${N} entries x $${FEE})`);
  console.log(`ROI:   ${roi}%`);
  console.log();
  console.log('--- COMPARISON ---');
  console.log(`  V32 baseline (8 slates):  $19,395`);
  console.log(`  Production selector:      $${totalPay.toFixed(0)}`);
  console.log(`  Delta:                    $${(totalPay - 19395).toFixed(0)} (${totalPay > 19395 ? 'BETTER' : 'WORSE'})`);

  // Write report
  let md = `# Production Selector Backtest — 8 MLB Slates\n\n`;
  md += `Architecture: anchor-relative + bin allocation (own=${DEFAULT_PRODUCTION_CONFIG.ownDropPP}pp drop) + ${(DEFAULT_PRODUCTION_CONFIG.teamCapPct * 100).toFixed(0)}% team cap + raw projection within bins\n\n`;
  md += `| Slate | F | t1 | Pay | Stacks | Own | Proj | AnchorOwn | TargetOwn |\n`;
  md += `|---|---:|---:|---:|---:|---:|---:|---:|---:|\n`;
  for (const r of results) {
    md += `| ${r.slate} | ${r.F.toLocaleString()} | ${r.t1} (${pct(r.scored > 0 ? r.t1 / r.scored : 0)}) | $${r.pay.toFixed(0)} | ${r.stacks} | ${r.avgOwn.toFixed(1)}% | ${r.avgProj.toFixed(1)} | ${r.anchorOwn.toFixed(1)}% | ${r.targetOwn.toFixed(1)}% |\n`;
  }
  md += `| **TOTAL** | | **${totalT1}** | **$${totalPay.toFixed(0)}** | | | | | |\n\n`;
  md += `Entry fees: $${FEE} x ${N} x ${n} = $${totalFees.toLocaleString()}\n`;
  md += `**Production ROI: ${roi}%**\n\n`;
  md += `## Comparison\n\n`;
  md += `| Selector | Payout | ROI |\n|---|---:|---:|\n`;
  md += `| **Production (anchor-6pp, 10% cap)** | **$${totalPay.toFixed(0)}** | **${roi}%** |\n`;
  md += `| V32 regions (baseline) | $19,395 | -19.2% |\n`;
  md += `| Anchor-relative 10% cap (7 slates) | $18,410 | -12.3% |\n`;
  md += `| Calibrated anchor 15% cap | varies | varies |\n`;

  const reportPath = path.join(DIR, 'production_backtest.md');
  fs.writeFileSync(reportPath, md);
  console.log(`\nReport: ${reportPath}`);
}

main();
