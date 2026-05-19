/**
 * PortfolioCoverage vs Argus-Atlas — 29-slate validation gate.
 *
 * Validates whether V1-PortfolioCoverage (greedy E[max-coverage] over t-copula
 * worlds) can compete with the shipped MLB selector Argus-Atlas.
 *
 * Method (per `feedback-validation-methodology.md` 4-gate framework):
 *   Gate 1 — Backtest ROI in Atlas's range (+75% LOO over 29 slates)
 *   Gate 2 — Mahalanobis distance vs 7-pro consensus < 1.5 (Atlas: 0.703)
 *   Gate 3 — LOO consistency (drop one slate, mean ROI stays positive)
 *   Gate 4 — 5-principle structural fidelity (CV<0.10 metrics match pro values)
 *
 * Pro consensus has 18 slates of data; we compute Mahalanobis on those,
 * ROI/LOO on all loadable slates (target 29).
 *
 * Atlas reference (from memory, mlb-argus-atlas-config-2026-05-10):
 *   29-slate LOO ROI: +75.05%
 *   Mahalanobis d: 0.703
 *   7/29 profitable
 *
 * Output: console table + portfolio_coverage_vs_atlas_results.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, loadPoolFromCSV, parseContestActuals } from '../parser';
import { getContestConfig } from '../rules';
import { THEORY_V1_NOCORR_PARAMS } from '../theory/v1-selector';
import { computeLineupSimStats } from '../theory/v1-sim-stats';
import { selectPortfolioCoveragePortfolio } from '../theory/v1-portfolio-coverage-selector';

const DIR = 'C:/Users/colin/dfs opto';
const OUT_JSON = path.join(DIR, 'portfolio_coverage_vs_atlas_results.json');
const PRO_CONSENSUS_PATH = path.join(DIR, 'pro_consensus_slate_relative.json');
const N = 150;
const FEE = 20;

// Atlas's published 29-slate validation set (per _argus_v9_research.ts).
const SLATES = [
  { slate: '4-6-26',         proj: '4-6-26_projections.csv',        actuals: 'dkactuals 4-6-26.csv',      pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26',         proj: '4-8-26projections.csv',         actuals: '4-8-26actuals.csv',         pool: '4-8-26sspool.csv' },
  { slate: '4-12-26',        proj: '4-12-26projections.csv',        actuals: '4-12-26actuals.csv',        pool: '4-12-26sspool.csv' },
  { slate: '4-14-26',        proj: '4-14-26projections.csv',        actuals: '4-14-26actuals.csv',        pool: '4-14-26sspool.csv' },
  { slate: '4-15-26',        proj: '4-15-26projections.csv',        actuals: '4-15-26actuals.csv',        pool: '4-15-26sspool.csv' },
  { slate: '4-17-26',        proj: '4-17-26projections.csv',        actuals: '4-17-26actuals.csv',        pool: '4-17-26sspool.csv' },
  { slate: '4-18-26',        proj: '4-18-26projections.csv',        actuals: '4-18-26actuals.csv',        pool: '4-18-26sspool.csv' },
  { slate: '4-19-26',        proj: '4-19-26projections.csv',        actuals: '4-19-26actuals.csv',        pool: '4-19-26sspool.csv' },
  { slate: '4-20-26',        proj: '4-20-26projections.csv',        actuals: '4-20-26actuals.csv',        pool: '4-20-26sspool.csv' },
  { slate: '4-21-26',        proj: '4-21-26projections.csv',        actuals: '4-21-26actuals.csv',        pool: '4-21-26sspool.csv' },
  { slate: '4-22-26',        proj: '4-22-26projections.csv',        actuals: '4-22-26actuals.csv',        pool: '4-22-26sspool.csv' },
  { slate: '4-23-26',        proj: '4-23-26projections.csv',        actuals: '4-23-26actuals.csv',        pool: '4-23-26sspool.csv' },
  { slate: '4-24-26',        proj: '4-24-26projections.csv',        actuals: '4-24-26actuals.csv',        pool: '4-24-26sspool.csv' },
  { slate: '4-25-26',        proj: '4-25-26projections.csv',        actuals: '4-25-26actuals.csv',        pool: '4-25-26sspool.csv' },
  { slate: '4-25-26-early',  proj: '4-25-26projectionsearly.csv',   actuals: '4-25-26actualsearly.csv',   pool: '4-25-26sspoolearly.csv' },
  { slate: '4-26-26',        proj: '4-26-26projections.csv',        actuals: '4-26-26actuals.csv',        pool: '4-26-26sspool.csv' },
  { slate: '4-27-26',        proj: '4-27-26projections.csv',        actuals: '4-27-26actuals.csv',        pool: '4-27-26sspool.csv' },
  { slate: '4-28-26',        proj: '4-28-26projections.csv',        actuals: '4-28-26actuals.csv',        pool: '4-28-26sspool.csv' },
  { slate: '4-29-26',        proj: '4-29-26projections.csv',        actuals: '4-29-26actuals.csv',        pool: '4-29-26sspool.csv' },
  { slate: '5-1-26',         proj: '5-1-26projections.csv',         actuals: '5-1-26actuals.csv',         pool: '5-1-26sspool.csv' },
  { slate: '5-2-26',         proj: '5-2-26projections.csv',         actuals: '5-2-26actuals.csv',         pool: '5-2-26sspool.csv' },
  { slate: '5-2-26-main',    proj: '5-2-26projectionsmain.csv',     actuals: '5-2-26actualsmain.csv',     pool: '5-2-26sspoolmain.csv' },
  { slate: '5-2-26-night',   proj: '5-2-26projectionsnight.csv',    actuals: '5-2-26actualsnight.csv',    pool: '5-2-26sspoolnight.csv' },
  { slate: '5-3-26',         proj: '5-3-26projections.csv',         actuals: '5-3-26actuals.csv',         pool: '5-3-26sspool.csv' },
  { slate: '5-3-26-late',    proj: '5-3-26projectionslate.csv',     actuals: '5-3-26actualslate.csv',     pool: '5-3-26sspoollate.csv' },
  { slate: '5-4-26',         proj: '5-4-26projections.csv',         actuals: '5-4-26actuals.csv',         pool: '5-4-26sspool.csv' },
  { slate: '5-4-26-late',    proj: '5-4-26projectionslate.csv',     actuals: '5-4-26actualslate.csv',     pool: '5-4-26sspoollate.csv' },
  { slate: '5-5-26',         proj: '5-5-26projections.csv',         actuals: '5-5-26actuals.csv',         pool: '5-5-26sspool.csv' },
  { slate: '5-6-26',         proj: '5-6-26projections.csv',         actuals: '5-6-26actuals.csv',         pool: '5-6-26sspool.csv' },
];

const UNIVERSAL_METRICS = ['projRatioToOptimal', 'ceilingRatioToOptimal', 'avgPlayerOwnPctile', 'ownStdRatio', 'ownDeltaFromAnchor'] as const;
type MetricKey = typeof UNIVERSAL_METRICS[number];

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function mean(a: number[]): number { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function stddev(a: number[]): number { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); }

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

interface SlateStats {
  optimalLineupProj: number;
  optimalLineupCeiling: number;
  chalkAnchorOwn: number;
  slateAvgPlayerOwn: number;
  ownPercentileByPlayerId: Map<string, number>;
}

function computeSlateStats(players: Player[], allLineups: Player[][]): SlateStats {
  let optProj = 0, optCeil = 0;
  const lineupOwnPairs: { meanOwn: number }[] = [];
  for (const lu of allLineups) {
    let p = 0, c = 0, o = 0;
    for (const pl of lu) {
      p += pl.projection || 0;
      c += (pl as any).ceiling || (pl.projection || 0) * 1.4;
      o += pl.ownership || 0;
    }
    if (p > optProj) optProj = p;
    if (c > optCeil) optCeil = c;
    lineupOwnPairs.push({ meanOwn: o / lu.length });
  }
  lineupOwnPairs.sort((a, b) => b.meanOwn - a.meanOwn);
  const topN = Math.min(100, lineupOwnPairs.length);
  const chalkAnchor = mean(lineupOwnPairs.slice(0, topN).map(x => x.meanOwn));
  const slateAvg = mean(players.map(p => p.ownership || 0));
  const ownPctile = new Map<string, number>();
  const sortedByOwn = [...players].sort((a, b) => (a.ownership || 0) - (b.ownership || 0));
  for (let i = 0; i < sortedByOwn.length; i++) {
    ownPctile.set(sortedByOwn[i].id, sortedByOwn.length > 1 ? i / (sortedByOwn.length - 1) : 0);
  }
  return {
    optimalLineupProj: optProj,
    optimalLineupCeiling: optCeil,
    chalkAnchorOwn: chalkAnchor,
    slateAvgPlayerOwn: slateAvg,
    ownPercentileByPlayerId: ownPctile,
  };
}

interface UniversalMetrics {
  projRatioToOptimal: number;
  ceilingRatioToOptimal: number;
  avgPlayerOwnPctile: number;
  ownStdRatio: number;
  ownDeltaFromAnchor: number;
}

function computeUniversal(lineups: Player[][], stats: SlateStats): UniversalMetrics {
  if (!lineups.length) return { projRatioToOptimal: 0, ceilingRatioToOptimal: 0, avgPlayerOwnPctile: 0, ownStdRatio: 0, ownDeltaFromAnchor: 0 };
  const luProjs: number[] = [], luCeils: number[] = [], luOwns: number[] = [], luOwnStds: number[] = [], pctileSums: number[] = [];
  for (const players of lineups) {
    const owns = players.map(p => p.ownership || 0);
    luOwns.push(mean(owns));
    luProjs.push(players.reduce((s, p) => s + (p.projection || 0), 0));
    luCeils.push(players.reduce((s, p) => s + ((p as any).ceiling || (p.projection || 0) * 1.4), 0));
    luOwnStds.push(stddev(owns));
    let pSum = 0; for (const p of players) pSum += stats.ownPercentileByPlayerId.get(p.id) || 0;
    pctileSums.push(pSum / players.length);
  }
  return {
    projRatioToOptimal: stats.optimalLineupProj > 0 ? mean(luProjs) / stats.optimalLineupProj : 0,
    ceilingRatioToOptimal: stats.optimalLineupCeiling > 0 ? mean(luCeils) / stats.optimalLineupCeiling : 0,
    avgPlayerOwnPctile: mean(pctileSums),
    ownStdRatio: stats.slateAvgPlayerOwn > 0 ? mean(luOwnStds) / stats.slateAvgPlayerOwn : 0,
    ownDeltaFromAnchor: mean(luOwns) - stats.chalkAnchorOwn,
  };
}

function scoreTournament(portfolio: Lineup[], actuals: any): { cost: number; payout: number; roi: number; top1: number; top01: number; maxScore: number; meanScore: number } {
  if (portfolio.length === 0) return { cost: 0, payout: 0, roi: 0, top1: 0, top01: 0, maxScore: 0, meanScore: 0 };
  const cost = portfolio.length * FEE;

  // Field scores: sorted descending from actuals entries
  const entryScores: number[] = [];
  for (const e of actuals.entries) entryScores.push(e.actualPoints);
  entryScores.sort((a, b) => b - a);
  const F = entryScores.length + portfolio.length;
  const payoutTable = buildPayoutTable(F);

  // Per-player score lookup from playerActualsByName
  const playerActualsByName: Map<string, any> = actuals.playerActualsByName;
  const ourScores: number[] = [];
  for (const lu of portfolio) {
    let s = 0;
    for (const p of lu.players) {
      const pa = playerActualsByName.get(norm(p.name));
      if (pa && typeof pa.fpts === 'number') s += pa.fpts;
    }
    ourScores.push(s);
  }

  // Insert our scores into descending sorted field; rank by # of strictly-greater field scores.
  let payout = 0, top1 = 0, top01 = 0;
  let maxScore = 0;
  for (const s of ourScores) {
    if (s > maxScore) maxScore = s;
    let lo = 0, hi = entryScores.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (entryScores[m] > s) lo = m + 1; else hi = m; }
    const rank = lo;
    if (rank < payoutTable.length) payout += payoutTable[rank];
    if (rank < F * 0.01) top1++;
    if (rank < F * 0.001) top01++;
  }

  return {
    cost, payout,
    roi: cost > 0 ? (payout / cost - 1) * 100 : 0,
    top1, top01, maxScore,
    meanScore: mean(ourScores),
  };
}

async function main() {
  console.log('================================================================');
  console.log('PortfolioCoverage vs Argus-Atlas — 29-slate validation gate');
  console.log('================================================================\n');

  // Load pro consensus per-slate stats
  const consensusRaw = JSON.parse(fs.readFileSync(PRO_CONSENSUS_PATH, 'utf-8'));
  const consBySlate: Record<string, Record<string, { mean: number; std: number }>> = {};
  for (const k of UNIVERSAL_METRICS) {
    for (const entry of (consensusRaw.metrics[k] || [])) {
      if (!consBySlate[entry.slate]) consBySlate[entry.slate] = {};
      consBySlate[entry.slate][k] = { mean: entry.mean, std: entry.std };
    }
  }
  console.log(`Pro consensus loaded: ${Object.keys(consBySlate).length} slates have consensus data.\n`);

  function mahalanobis(m: UniversalMetrics, slate: string): number | null {
    const c = consBySlate[slate]; if (!c) return null;
    let sum = 0; let n = 0;
    for (const k of UNIVERSAL_METRICS) {
      const cc = c[k]; if (!cc || cc.std < 1e-9) continue;
      const d = ((m as any)[k] - cc.mean) / cc.std;
      sum += d * d; n++;
    }
    return n > 0 ? Math.sqrt(sum / n) : null;
  }

  interface SlateResult {
    slate: string;
    candidates: number;
    actualLineups: number;
    portfolioSize: number;
    cost: number;
    payout: number;
    roi: number;
    top1: number;
    top01: number;
    maxScore: number;
    meanScore: number;
    mahalanobis: number | null;
    metrics: UniversalMetrics;
    finalMaxWorldMean: number;
    finalMaxWorldStd: number;
    durationSec: number;
  }

  const results: SlateResult[] = [];

  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj), actualsPath = path.join(DIR, s.actuals), poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) {
      console.log(`  ${s.slate}: missing files, skip`);
      continue;
    }
    const t0 = Date.now();
    try {
      const pr = parseCSVFile(projPath, 'mlb', true);
      const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
      const playerPool = buildPlayerPool(pr.players, pr.detectedContestType);
      const actuals = parseContestActuals(actualsPath, config);

      const idMap = new Map<string, Player>(); const nameMap = new Map<string, Player>();
      for (const p of playerPool.players) { idMap.set(p.id, p); nameMap.set(norm(p.name), p); }

      const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
      const candidates: Lineup[] = Array.from(new Map<string, Lineup>(loaded.lineups.map(l => [l.hash, l])).values());
      if (candidates.length < 100) { console.log(`  ${s.slate}: P=${candidates.length} too small, skip`); continue; }

      // Build actual field lineups for slate stats
      const fieldLineups: Player[][] = [];
      for (const e of actuals.entries) {
        const pls: Player[] = []; let ok = true;
        for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
        if (ok) fieldLineups.push(pls);
      }
      const stats = computeSlateStats(playerPool.players, fieldLineups);

      // Run PortfolioCoverage (shared sim)
      const simStats = computeLineupSimStats(candidates, playerPool.players);
      const covResult = selectPortfolioCoveragePortfolio(
        candidates, playerPool.players, N, THEORY_V1_NOCORR_PARAMS, simStats,
      );

      const lineups: Player[][] = covResult.selected.map(lu => lu.players);
      const m = computeUniversal(lineups, stats);
      const dist = mahalanobis(m, s.slate);
      const tourney = scoreTournament(covResult.selected, actuals);

      const ts = (Date.now() - t0) / 1000;
      results.push({
        slate: s.slate,
        candidates: candidates.length,
        actualLineups: fieldLineups.length,
        portfolioSize: covResult.selected.length,
        cost: tourney.cost,
        payout: tourney.payout,
        roi: tourney.roi,
        top1: tourney.top1,
        top01: tourney.top01,
        maxScore: tourney.maxScore,
        meanScore: tourney.meanScore,
        mahalanobis: dist,
        metrics: m,
        finalMaxWorldMean: covResult.diagnostics.finalMaxWorldMean,
        finalMaxWorldStd: covResult.diagnostics.finalMaxWorldStd,
        durationSec: ts,
      });

      console.log(`  ${s.slate.padEnd(15)} P=${candidates.length} | port=${covResult.selected.length} | ROI=${tourney.roi.toFixed(1).padStart(7)}% | mahal=${dist?.toFixed(2) || 'n/a'} | top1=${tourney.top1} top0.1=${tourney.top01} | ${ts.toFixed(1)}s`);
    } catch (e: any) {
      console.log(`  ${s.slate}: error — ${e?.message || e}`);
    }
  }

  // ===== Aggregates =====
  console.log('\n================================================================');
  console.log('AGGREGATE — full-sample');
  console.log('================================================================\n');

  const totalCost = results.reduce((s, r) => s + r.cost, 0);
  const totalPay = results.reduce((s, r) => s + r.payout, 0);
  const aggROI = totalCost > 0 ? (totalPay / totalCost - 1) * 100 : 0;
  const profitable = results.filter(r => r.roi > 0).length;
  const totalTop1 = results.reduce((s, r) => s + r.top1, 0);
  const totalTop01 = results.reduce((s, r) => s + r.top01, 0);

  console.log(`Slates run:       ${results.length} / ${SLATES.length}`);
  console.log(`Total cost:       $${totalCost.toLocaleString()}`);
  console.log(`Total payout:     $${totalPay.toFixed(0).padStart(10)}`);
  console.log(`Full-sample ROI:  ${aggROI.toFixed(2)}%`);
  console.log(`Profitable:       ${profitable}/${results.length}`);
  console.log(`Top-1% hits:      ${totalTop1}`);
  console.log(`Top-0.1% hits:    ${totalTop01}`);

  // ===== LOO ROI distribution =====
  console.log('\n--- LOO ROI sensitivity (drop one slate at a time) ---');
  const looROIs: { slate: string; roiWithout: number; payoutWithout: number }[] = [];
  for (const r of results) {
    const cost2 = totalCost - r.cost;
    const pay2 = totalPay - r.payout;
    const roi2 = cost2 > 0 ? (pay2 / cost2 - 1) * 100 : 0;
    looROIs.push({ slate: r.slate, roiWithout: roi2, payoutWithout: pay2 });
  }
  looROIs.sort((a, b) => a.roiWithout - b.roiWithout);
  console.log('  Worst LOO (drop biggest winner):');
  for (const lo of looROIs.slice(0, 3)) console.log(`    drop ${lo.slate.padEnd(15)} ROI=${lo.roiWithout.toFixed(2)}%`);
  console.log('  Best LOO (drop biggest loser):');
  for (const lo of looROIs.slice(-3).reverse()) console.log(`    drop ${lo.slate.padEnd(15)} ROI=${lo.roiWithout.toFixed(2)}%`);
  const looMean = mean(looROIs.map(l => l.roiWithout));
  const looStd = stddev(looROIs.map(l => l.roiWithout));
  console.log(`  LOO mean: ${looMean.toFixed(2)}%  LOO std: ${looStd.toFixed(2)}%`);

  // ===== Mahalanobis aggregate =====
  console.log('\n--- Mahalanobis vs 7-pro consensus ---');
  const dists = results.map(r => r.mahalanobis).filter((d): d is number => d !== null);
  if (dists.length > 0) {
    const meanD = mean(dists);
    const dLt15 = dists.filter(d => d < 1.5).length;
    const dLt20 = dists.filter(d => d < 2.0).length;
    console.log(`  Slates with consensus data:  ${dists.length}`);
    console.log(`  Mean Mahalanobis distance:   ${meanD.toFixed(3)}    (target < 1.5; Atlas baseline 0.703)`);
    console.log(`  Slates with d<1.5:           ${dLt15}/${dists.length}`);
    console.log(`  Slates with d<2.0:           ${dLt20}/${dists.length}`);
  }

  // ===== 5-principle compliance =====
  console.log('\n--- 5-principle structural fidelity (vs pro consensus) ---');
  console.log('  Pro consensus reference (per memory):');
  console.log('    projRatioToOptimal ≈ 0.88');
  console.log('    ceilingRatioToOptimal ≈ 0.92');
  console.log('    avgPlayerOwnPctile ≈ 0.94');
  console.log('    ownStdRatio ≈ 7.1');
  console.log('    ownDeltaFromAnchor ≈ −7.2');
  console.log('');
  for (const k of UNIVERSAL_METRICS) {
    const vals = results.map(r => (r.metrics as any)[k]);
    const m = mean(vals); const s = stddev(vals); const cv = m !== 0 ? Math.abs(s / m) : 0;
    console.log(`    ${k.padEnd(28)} mean=${m.toFixed(3).padStart(8)}  std=${s.toFixed(3).padStart(7)}  CV=${cv.toFixed(3)}`);
  }

  // ===== Per-slate detail =====
  console.log('\n--- Per-slate detail ---');
  console.log('slate           cands  port  ROI%      mahal  top1  top0.1  projR  ceilR  ownP  ownSR  ownDA');
  for (const r of results) {
    const m = r.metrics;
    console.log(
      `  ${r.slate.padEnd(15)} ${r.candidates.toString().padStart(4)} ${r.portfolioSize.toString().padStart(5)}  ${r.roi.toFixed(1).padStart(7)} ${(r.mahalanobis?.toFixed(2) || 'n/a').padStart(6)}   ${r.top1.toString().padStart(2)}   ${r.top01.toString().padStart(3)}   ${m.projRatioToOptimal.toFixed(2)}   ${m.ceilingRatioToOptimal.toFixed(2)}   ${m.avgPlayerOwnPctile.toFixed(2)}   ${m.ownStdRatio.toFixed(2)}   ${m.ownDeltaFromAnchor.toFixed(2)}`,
    );
  }

  // ===== Save =====
  fs.writeFileSync(OUT_JSON, JSON.stringify({
    runDate: new Date().toISOString(),
    nSlates: results.length,
    aggregateROI: aggROI,
    profitable,
    totalCost, totalPay,
    looMean, looStd, looROIs,
    meanMahalanobis: dists.length > 0 ? mean(dists) : null,
    dLt15: dists.filter(d => d < 1.5).length,
    dLt20: dists.filter(d => d < 2.0).length,
    results,
    atlasReference: {
      looROI: 75.05,
      mahalanobis: 0.703,
      profitable: '7/29',
      source: 'memory: mlb-argus-atlas-config-2026-05-10',
    },
  }, null, 2));
  console.log(`\nResults saved to ${OUT_JSON}`);

  // ===== Gate decision =====
  console.log('\n================================================================');
  console.log('GATE DECISION');
  console.log('================================================================\n');
  const gate1 = aggROI >= 50;  // Atlas at +75; lenient bar of +50 to qualify as "in range"
  const gate2 = dists.length > 0 && mean(dists) < 1.5;
  const gate3 = looMean > 0;
  // gate 4 depends on per-metric closeness; report only
  console.log(`Gate 1 — Backtest ROI ≥ +50%  (Atlas +75.05%):     ${aggROI.toFixed(2)}%   ${gate1 ? 'PASS' : 'FAIL'}`);
  console.log(`Gate 2 — Mean Mahalanobis < 1.5  (Atlas 0.703):    ${dists.length > 0 ? mean(dists).toFixed(3) : 'n/a'}   ${gate2 ? 'PASS' : 'FAIL'}`);
  console.log(`Gate 3 — LOO mean ROI > 0:                          ${looMean.toFixed(2)}%   ${gate3 ? 'PASS' : 'FAIL'}`);
  console.log(`Gate 4 — Structural fidelity vs 5 pro principles:   (see metric table above)`);

  console.log('\nDecision:');
  if (gate1 && gate2 && gate3) {
    console.log('  PASS all 3 hard gates. PortfolioCoverage qualifies for parallel deployment investigation.');
    console.log('  → Build v2 with underfill fix + LOO confirmation.');
  } else {
    console.log('  FAIL one or more hard gates. PortfolioCoverage does NOT clearly outperform Argus-Atlas.');
    console.log('  → Do NOT build v2 yet. Reassess approach.');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
