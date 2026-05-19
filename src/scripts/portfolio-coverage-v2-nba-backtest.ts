/**
 * PortfolioCoverage-v2 NBA backtest — 12-slate comparison vs Pegasus.
 *
 * Tests whether the MLB-validated v2 architecture (greedy E[max-coverage]
 * over t-copula worlds + ownDelta regularizer) generalizes to NBA.
 *
 * NBA-specific adjustments:
 *   - minPrimaryStack = 0 (NBA has no 4+ stack concept)
 *   - exposureCapHitter = exposureCapPitcher (V1's isPitcher false-positives
 *     on PG/PF since position string contains 'P'; equal caps neutralize)
 *   - chalkAnchorOwn computed from actual field top-100 (same as MLB)
 *
 * 3-way comparison:
 *   1. Pegasus baseline — productionSelect with NBA-tuned cfg
 *   2. v2-no-reg — pure greedy coverage (chalkAnchorOwn undefined)
 *   3. v2-with-reg — coverage + ownDelta regularizer toward −7.2 (MLB target;
 *      may not be optimal for NBA but tests sport transferability)
 *
 * Important caveat (per memory `nba-backtest-data-quality-2026-04-28.md`):
 * the 12-slate NBA set is lottery-driven (2026-03-03 dominates). Results are
 * descriptive only.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals } from '../parser';
import { getContestConfig } from '../rules';
import { productionSelect } from '../selection/production-selector';
import { THEORY_V1_NOCORR_PARAMS, cloneTheoryParams } from '../theory/v1-selector';
import { computeLineupSimStats } from '../theory/v1-sim-stats';
import { selectPortfolioCoverageV2Portfolio } from '../theory/v1-portfolio-coverage-v2-selector';

const DIR = 'C:/Users/colin/Projects/dfs-optimizer/historical_slates';
const OUT_JSON = 'C:/Users/colin/dfs opto/portfolio_coverage_v2_nba_results.json';
const FEE = 20;
const N = 150;
const GAMMA = 6;
const TARGET_OWN_DELTA = -7.2;

const SLATES = [
  { slate: '2026-01-16', proj: '2026-01-16_projections.csv', actuals: '2026-01-16_actuals.csv', pool: '_backtest_2026-01-16.csv' },
  { slate: '2026-01-17', proj: '2026-01-17_projections.csv', actuals: '2026-01-17_actuals.csv', pool: '_backtest_2026-01-17.csv' },
  { slate: '2026-01-18', proj: '2026-01-18_projections.csv', actuals: '2026-01-18_actuals.csv', pool: '_backtest_2026-01-18.csv' },
  { slate: '2026-01-19', proj: '2026-01-19_projections.csv', actuals: '2026-01-19_actuals.csv', pool: '_backtest_2026-01-19.csv' },
  { slate: '2026-01-20', proj: '2026-01-20_projections.csv', actuals: '2026-01-20_actuals.csv', pool: '_backtest_2026-01-20.csv' },
  { slate: '2026-02-25', proj: '2026-02-25_projections.csv', actuals: '2026-02-25_actuals.csv', pool: '_backtest_2026-02-25.csv' },
  { slate: '2026-02-26', proj: '2026-02-26_projections.csv', actuals: '2026-02-26_actuals.csv', pool: '_backtest_2026-02-26.csv' },
  { slate: '2026-02-27', proj: '2026-02-27_projections.csv', actuals: '2026-02-27_actuals.csv', pool: '_backtest_2026-02-27.csv' },
  { slate: '2026-02-28', proj: '2026-02-28_projections.csv', actuals: '2026-02-28_actuals.csv', pool: '_backtest_2026-02-28.csv' },
  { slate: '2026-03-03', proj: '2026-03-03_projections.csv', actuals: '2026-03-03_actuals.csv', pool: '_backtest_2026-03-03.csv' },
  { slate: '2026-03-05', proj: '2026-03-05_dk_projections.csv', actuals: '2026-03-05_dk_actuals.csv', pool: '_backtest_2026-03-05_dk.csv' },
  { slate: '2026-03-06', proj: '2026-03-06_dk_projections.csv', actuals: '2026-03-06_dk_actuals.csv', pool: '_backtest_2026-03-06_dk.csv' },
];

// NBA-safe V1 params — equal exposure caps to neutralize isPitcher false-positives on PG/PF.
const NBA_V1_PARAMS = cloneTheoryParams(THEORY_V1_NOCORR_PARAMS, {
  minPrimaryStack: 0,
  exposureCapHitter: 0.30,
  exposureCapPitcher: 0.30,
  teamStackCap: 1.0,                // no team cap (no real stacking)
});

function norm(n: string): string {
  return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function mean(a: number[]): number { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function stddev(a: number[]): number { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); }
function lineupMeanOwn(lu: Lineup): number {
  if (!lu.players.length) return 0;
  let s = 0;
  for (const p of lu.players) s += (p.ownership || 0);
  return s / lu.players.length;
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

function scorePortfolio(portfolio: Lineup[], actuals: ContestActuals, actualByHash: Map<string, number>, payoutTable: Float64Array) {
  const F = actuals.entries.length;
  const sorted = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
  const top1T = sorted[Math.max(0, Math.floor(F * 0.01) - 1)] || 0;
  let t1 = 0, totalPayout = 0, scored = 0;
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

function computeChalkAnchorOwn(fieldLineups: Player[][]): number {
  const owns = fieldLineups.map(pls => {
    let s = 0; for (const p of pls) s += (p.ownership || 0);
    return s / Math.max(1, pls.length);
  });
  owns.sort((a, b) => b - a);
  const topN = Math.min(100, owns.length);
  return mean(owns.slice(0, topN));
}

async function main() {
  console.log('================================================================');
  console.log('PortfolioCoverage-v2 NBA backtest — 12 slates');
  console.log('================================================================\n');
  console.log(`Variants: Pegasus baseline (productionSelect, γ=${GAMMA}, mps=0)`);
  console.log(`          v2-no-reg (pure greedy coverage)`);
  console.log(`          v2-with-reg (coverage + ownDelta toward ${TARGET_OWN_DELTA})\n`);

  type Row = {
    slate: string;
    F: number;
    poolSize: number;
    chalkAnchorOwn: number;
    pegasus: { size: number; pay: number; t1: number; scored: number; meanOwn: number };
    v2NoReg: { size: number; pay: number; t1: number; scored: number; meanOwn: number; greedy: number; fallback: number };
    v2WithReg: { size: number; pay: number; t1: number; scored: number; meanOwn: number; greedy: number; fallback: number; finalOwnDelta: number };
  };
  const rows: Row[] = [];

  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj);
    const actualsPath = path.join(DIR, s.actuals);
    const poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) { console.log(`SKIP ${s.slate}`); continue; }
    const t0 = Date.now();
    try {
      const pr = parseCSVFile(projPath, 'nba', true);
      const config = getContestConfig('dk', 'nba', pr.detectedContestType);
      const pool = buildPlayerPool(pr.players, pr.detectedContestType);
      const actuals = parseContestActuals(actualsPath, config);
      const F = actuals.entries.length;
      const nameMap = new Map<string, Player>();
      for (const p of pool.players) nameMap.set(norm(p.name), p);
      const idMap = new Map<string, Player>();
      for (const p of pool.players) idMap.set(p.id, p);
      const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
      const candidates: Lineup[] = Array.from(new Map<string, Lineup>(loaded.lineups.map(l => [l.hash, l])).values());
      if (candidates.length < 100) { console.log(`  ${s.slate}: P=${candidates.length} too small, skip`); continue; }

      // Build field lineups for chalk anchor + actualByHash
      const fieldLineups: Player[][] = [];
      const actualByHash = new Map<string, number>();
      for (const e of actuals.entries) {
        const pls: Player[] = []; let ok = true;
        for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
        if (!ok) continue;
        fieldLineups.push(pls);
        actualByHash.set(pls.map(p => p.id).sort().join('|'), e.actualPoints);
      }
      const chalkAnchorOwn = computeChalkAnchorOwn(fieldLineups);
      const payoutTable = buildPayoutTable(F);

      // === 1. Pegasus baseline ===
      const peg = productionSelect(candidates, pool.players, {
        N, lambda: 0, maxOverlap: GAMMA, minPrimaryStack: 0,
        extremeCornerCap: true, extremeCornerQ5Q5Pct: 0.25, extremeCornerQ1Q1Pct: 0.05,
      });
      const pegScored = scorePortfolio(peg.portfolio, actuals, actualByHash, payoutTable);
      const pegOwn = mean(peg.portfolio.map(lineupMeanOwn));

      // === 2 & 3. v2 variants — share one sim ===
      const simStats = computeLineupSimStats(candidates, pool.players);

      const v2NoReg = selectPortfolioCoverageV2Portfolio(
        candidates, pool.players, N, NBA_V1_PARAMS, simStats,
        { fallbackToV1: true },                   // no chalkAnchorOwn = regularizer off
      );
      const v2NoRegScored = scorePortfolio(v2NoReg.selected, actuals, actualByHash, payoutTable);
      const v2NoRegOwn = mean(v2NoReg.selected.map(lineupMeanOwn));

      const v2WithReg = selectPortfolioCoverageV2Portfolio(
        candidates, pool.players, N, NBA_V1_PARAMS, simStats,
        { chalkAnchorOwn, targetOwnDelta: TARGET_OWN_DELTA, ownDeltaWeight: 0.20, fallbackToV1: true },
      );
      const v2WithRegScored = scorePortfolio(v2WithReg.selected, actuals, actualByHash, payoutTable);
      const v2WithRegOwn = mean(v2WithReg.selected.map(lineupMeanOwn));

      rows.push({
        slate: s.slate, F, poolSize: candidates.length, chalkAnchorOwn,
        pegasus: { size: peg.portfolio.length, pay: pegScored.totalPayout, t1: pegScored.t1, scored: pegScored.scored, meanOwn: pegOwn },
        v2NoReg: { size: v2NoReg.selected.length, pay: v2NoRegScored.totalPayout, t1: v2NoRegScored.t1, scored: v2NoRegScored.scored, meanOwn: v2NoRegOwn, greedy: v2NoReg.diagnostics.greedyPicks, fallback: v2NoReg.diagnostics.fallbackPicks },
        v2WithReg: { size: v2WithReg.selected.length, pay: v2WithRegScored.totalPayout, t1: v2WithRegScored.t1, scored: v2WithRegScored.scored, meanOwn: v2WithRegOwn, greedy: v2WithReg.diagnostics.greedyPicks, fallback: v2WithReg.diagnostics.fallbackPicks, finalOwnDelta: v2WithReg.diagnostics.finalOwnDelta },
      });

      const ts = ((Date.now() - t0) / 1000).toFixed(1);
      const pegROI = (pegScored.totalPayout / (FEE * N) - 1) * 100;
      const v2nrROI = (v2NoRegScored.totalPayout / (FEE * N) - 1) * 100;
      const v2wrROI = (v2WithRegScored.totalPayout / (FEE * N) - 1) * 100;
      console.log(
        `${s.slate} F=${F.toLocaleString().padStart(6)} P=${candidates.length.toString().padStart(4)} chalk=${chalkAnchorOwn.toFixed(1)}% | ` +
        `peg ROI=${pegROI.toFixed(0).padStart(5)}% t1=${pegScored.t1.toString().padStart(2)} | ` +
        `v2nr ROI=${v2nrROI.toFixed(0).padStart(5)}% t1=${v2NoRegScored.t1.toString().padStart(2)} grd=${v2NoReg.diagnostics.greedyPicks} fb=${v2NoReg.diagnostics.fallbackPicks} | ` +
        `v2wr ROI=${v2wrROI.toFixed(0).padStart(5)}% t1=${v2WithRegScored.t1.toString().padStart(2)} ownD=${v2WithReg.diagnostics.finalOwnDelta.toFixed(1)} | ${ts}s`,
      );
    } catch (err: any) {
      console.log(`ERROR ${s.slate}: ${err.message}`);
    }
  }

  // ===== Aggregate =====
  console.log('\n================================================================');
  console.log('AGGREGATE');
  console.log('================================================================\n');

  const fees = FEE * N * rows.length;
  const sumP = (k: 'pegasus' | 'v2NoReg' | 'v2WithReg') => rows.reduce((s, r) => s + r[k].pay, 0);
  const sumT1 = (k: 'pegasus' | 'v2NoReg' | 'v2WithReg') => rows.reduce((s, r) => s + r[k].t1, 0);
  const profitable = (k: 'pegasus' | 'v2NoReg' | 'v2WithReg') => rows.filter(r => r[k].pay > FEE * N).length;

  const pegPay = sumP('pegasus'), v2nrPay = sumP('v2NoReg'), v2wrPay = sumP('v2WithReg');
  console.log(`Slates: ${rows.length}    Fees: $${fees.toLocaleString()}\n`);
  console.log('Variant            | Payout       | ROI       | Profitable | top1% hits | Mean own%');
  console.log('-----------------------------------------------------------------------------------');
  console.log(`Pegasus baseline   | $${pegPay.toFixed(0).padStart(8)}  | ${((pegPay / fees - 1) * 100).toFixed(2).padStart(7)}% | ${profitable('pegasus')}/${rows.length}        | ${sumT1('pegasus').toString().padStart(2)}         | ${mean(rows.map(r => r.pegasus.meanOwn)).toFixed(2)}`);
  console.log(`v2 (no regulariz)  | $${v2nrPay.toFixed(0).padStart(8)}  | ${((v2nrPay / fees - 1) * 100).toFixed(2).padStart(7)}% | ${profitable('v2NoReg')}/${rows.length}        | ${sumT1('v2NoReg').toString().padStart(2)}         | ${mean(rows.map(r => r.v2NoReg.meanOwn)).toFixed(2)}`);
  console.log(`v2 (ownΔ reg)      | $${v2wrPay.toFixed(0).padStart(8)}  | ${((v2wrPay / fees - 1) * 100).toFixed(2).padStart(7)}% | ${profitable('v2WithReg')}/${rows.length}        | ${sumT1('v2WithReg').toString().padStart(2)}         | ${mean(rows.map(r => r.v2WithReg.meanOwn)).toFixed(2)}`);

  // LOO sensitivity
  console.log('\n--- LOO ROI sensitivity (drop one slate) ---');
  function loo(rows: Row[], pick: 'pegasus' | 'v2NoReg' | 'v2WithReg') {
    const totalPay = sumP(pick);
    const slateCost = FEE * N;
    const out: { slate: string; roi: number }[] = [];
    for (const r of rows) {
      const c2 = fees - slateCost;
      const p2 = totalPay - r[pick].pay;
      out.push({ slate: r.slate, roi: c2 > 0 ? (p2 / c2 - 1) * 100 : 0 });
    }
    out.sort((a, b) => a.roi - b.roi);
    return { mean: mean(out.map(o => o.roi)), worst: out[0], best: out[out.length - 1] };
  }
  for (const v of ['pegasus', 'v2NoReg', 'v2WithReg'] as const) {
    const l = loo(rows, v);
    console.log(`  ${v.padEnd(20)} LOO mean=${l.mean.toFixed(2)}%  worst-drop ${l.worst.slate}=${l.worst.roi.toFixed(2)}%  best-drop ${l.best.slate}=${l.best.roi.toFixed(2)}%`);
  }

  // Per-slate detail
  console.log('\n--- Per-slate detail ---');
  console.log('Slate        |     F | Pool | chalk | peg ROI | v2nr ROI | v2wr ROI | v2wr ownΔ');
  console.log('-------------|-------|------|-------|---------|----------|----------|----------');
  for (const r of rows) {
    const pegROI = (r.pegasus.pay / (FEE * N) - 1) * 100;
    const v2nrROI = (r.v2NoReg.pay / (FEE * N) - 1) * 100;
    const v2wrROI = (r.v2WithReg.pay / (FEE * N) - 1) * 100;
    console.log(`${r.slate.padEnd(12)} | ${r.F.toLocaleString().padStart(5)} | ${r.poolSize.toString().padStart(4)} | ${r.chalkAnchorOwn.toFixed(1).padStart(5)}% | ${pegROI.toFixed(0).padStart(6)}% | ${v2nrROI.toFixed(0).padStart(7)}% | ${v2wrROI.toFixed(0).padStart(7)}% | ${r.v2WithReg.finalOwnDelta.toFixed(1).padStart(7)}`);
  }

  fs.writeFileSync(OUT_JSON, JSON.stringify({ runDate: new Date().toISOString(), nSlates: rows.length, fees, rows }, null, 2));
  console.log(`\nResults saved to ${OUT_JSON}`);
}

main().catch(e => { console.error(e); process.exit(1); });
