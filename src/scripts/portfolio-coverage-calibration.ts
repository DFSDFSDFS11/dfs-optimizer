/**
 * PortfolioCoverage v2 calibration test — 29-slate, 3-way, leakage-free.
 *
 * The leakage-free 29-slate validation revealed v2 at target ownDelta=−7.2
 * against the POOL proxy lands at ownDelta=−10.2 against the actual FIELD,
 * because pool top-100 averages ~2.8pp below field top-100 chalk anchor.
 * Result: Mahalanobis fails (2.37 vs target <1.5).
 *
 * This script tests two fixes:
 *
 *   1. v2-no-reg — drop the regularizer entirely (chalkAnchorOwn undefined).
 *      Tests whether pure greedy coverage + underfill fix is enough.
 *
 *   2. v2.1-calibrated — target ownDelta = −4.4 against pool proxy. Calibration:
 *      target_pool = target_field + meanPoolFieldGap = −7.2 + 2.8 = −4.4.
 *      Should land at ownDelta ≈ −7.2 against actual field.
 *
 * All variants use:
 *   - Adj Own override applied PRE selection (preslate parity)
 *   - chalkAnchorOwn from pool top-100 (preslate parity; selector input)
 *   - stats.chalkAnchorOwn from field top-100 used ONLY for evaluation metrics
 *
 * Reports: ROI, LOO sensitivity, Mahalanobis, finalOwnDelta vs field, 5-principle table.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as csvParse } from 'csv-parse/sync';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, loadPoolFromCSV, parseContestActuals } from '../parser';
import { getContestConfig } from '../rules';
import { THEORY_V1_NOCORR_PARAMS } from '../theory/v1-selector';
import { computeLineupSimStats } from '../theory/v1-sim-stats';
import { selectPortfolioCoverageV2Portfolio } from '../theory/v1-portfolio-coverage-v2-selector';

const DIR = 'C:/Users/colin/dfs opto';
const OUT_JSON = path.join(DIR, 'portfolio_coverage_calibration_results.json');
const PRO_CONSENSUS_PATH = path.join(DIR, 'pro_consensus_slate_relative.json');
const N = 150;
const FEE = 20;

// Calibrated target: pool proxy is ~2.8pp below actual field; targeting -4.4 vs
// pool should land ~-7.2 vs field (matching pro consensus).
const TARGET_OWN_DELTA_CALIBRATED = -4.4;

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

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function mean(a: number[]): number { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function stddev(a: number[]): number { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); }

function loadAdjOwn(projPath: string): Map<string, number> {
  const out = new Map<string, number>();
  if (!fs.existsSync(projPath)) return out;
  const records = csvParse(fs.readFileSync(projPath, 'utf-8'), { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
  for (const r of records) {
    const id = (r['DFS ID'] || r['ID'] || '').trim(); if (!id) continue;
    const adj = parseFloat((r['Adj Own'] || '').replace(/[%,]/g, ''));
    if (!Number.isNaN(adj)) out.set(id, Math.max(0, adj));
  }
  return out;
}

function poolChalkAnchorOwn(candidates: Lineup[]): number {
  const owns: number[] = [];
  for (const lu of candidates) {
    if (!lu.players.length) continue;
    let s = 0; for (const p of lu.players) s += (p.ownership || 0);
    owns.push(s / lu.players.length);
  }
  owns.sort((a, b) => b - a);
  const topN = Math.min(100, owns.length);
  if (topN === 0) return 0;
  let s = 0; for (let i = 0; i < topN; i++) s += owns[i];
  return s / topN;
}

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
    for (const pl of lu) { p += pl.projection || 0; c += (pl as any).ceiling || (pl.projection || 0) * 1.4; o += pl.ownership || 0; }
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
  return { optimalLineupProj: optProj, optimalLineupCeiling: optCeil, chalkAnchorOwn: chalkAnchor, slateAvgPlayerOwn: slateAvg, ownPercentileByPlayerId: ownPctile };
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

function scoreTournament(portfolio: Lineup[], actuals: any): { cost: number; payout: number; roi: number; top1: number; top01: number } {
  if (portfolio.length === 0) return { cost: 0, payout: 0, roi: 0, top1: 0, top01: 0 };
  const cost = portfolio.length * FEE;
  const entryScores: number[] = [];
  for (const e of actuals.entries) entryScores.push(e.actualPoints);
  entryScores.sort((a, b) => b - a);
  const F = entryScores.length + portfolio.length;
  const payoutTable = buildPayoutTable(F);
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
  let payout = 0, top1 = 0, top01 = 0;
  for (const s of ourScores) {
    let lo = 0, hi = entryScores.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (entryScores[m] > s) lo = m + 1; else hi = m; }
    const rank = lo;
    if (rank < payoutTable.length) payout += payoutTable[rank];
    if (rank < F * 0.01) top1++;
    if (rank < F * 0.001) top01++;
  }
  return { cost, payout, roi: cost > 0 ? (payout / cost - 1) * 100 : 0, top1, top01 };
}

async function main() {
  console.log('================================================================');
  console.log('PortfolioCoverage v2 calibration test — 29-slate, leakage-free');
  console.log('================================================================');
  console.log(`Variants: v2-no-reg (regularizer OFF), v2.1-calibrated (target ownDelta=${TARGET_OWN_DELTA_CALIBRATED} vs pool)\n`);

  const consensusRaw = JSON.parse(fs.readFileSync(PRO_CONSENSUS_PATH, 'utf-8'));
  const consBySlate: Record<string, Record<string, { mean: number; std: number }>> = {};
  for (const k of UNIVERSAL_METRICS) {
    for (const entry of (consensusRaw.metrics[k] || [])) {
      if (!consBySlate[entry.slate]) consBySlate[entry.slate] = {};
      consBySlate[entry.slate][k] = { mean: entry.mean, std: entry.std };
    }
  }
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

  interface Variant {
    port: number; roi: number; mahal: number | null; top1: number; top01: number;
    cost: number; payout: number; metrics: UniversalMetrics;
    greedy: number; fallback: number; finalOwnDelta: number;
  }
  interface SlateRow {
    slate: string; candidates: number; poolAnchor: number; fieldAnchor: number;
    v2NoReg: Variant; v2Cal: Variant;
  }
  const rows: SlateRow[] = [];

  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj), actualsPath = path.join(DIR, s.actuals), poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) { console.log(`  ${s.slate}: missing, skip`); continue; }
    const t0 = Date.now();
    try {
      const pr = parseCSVFile(projPath, 'mlb', true);
      const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
      const playerPool = buildPlayerPool(pr.players, pr.detectedContestType);
      const actuals = parseContestActuals(actualsPath, config);
      const idMap = new Map<string, Player>(); const nameMap = new Map<string, Player>();
      for (const p of playerPool.players) { idMap.set(p.id, p); nameMap.set(norm(p.name), p); }

      // Adj Own override — preslate parity
      const adjOwnMap = loadAdjOwn(projPath);
      for (const p of playerPool.players) {
        const adj = adjOwnMap.get(p.id);
        if (adj !== undefined) p.ownership = adj;
      }

      const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
      const candidates: Lineup[] = Array.from(new Map<string, Lineup>(loaded.lineups.map(l => [l.hash, l])).values());
      if (candidates.length < 100) { console.log(`  ${s.slate}: P=${candidates.length} too small`); continue; }

      // Field for evaluation
      const fieldLineups: Player[][] = [];
      for (const e of actuals.entries) {
        const pls: Player[] = []; let ok = true;
        for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
        if (ok) fieldLineups.push(pls);
      }
      const stats = computeSlateStats(playerPool.players, fieldLineups);

      // Selector input: pool top-100 anchor
      const poolAnchor = poolChalkAnchorOwn(candidates);
      const simStats = computeLineupSimStats(candidates, playerPool.players);

      const runVariant = (opts: { chalkAnchorOwn?: number; targetOwnDelta?: number }): Variant => {
        const r = selectPortfolioCoverageV2Portfolio(
          candidates, playerPool.players, N, THEORY_V1_NOCORR_PARAMS, simStats,
          { ...opts, fallbackToV1: true },
        );
        const metrics = computeUniversal(r.selected.map(lu => lu.players), stats);
        const t = scoreTournament(r.selected, actuals);
        return {
          port: r.selected.length, roi: t.roi, mahal: mahalanobis(metrics, s.slate),
          top1: t.top1, top01: t.top01, cost: t.cost, payout: t.payout, metrics,
          greedy: r.diagnostics.greedyPicks, fallback: r.diagnostics.fallbackPicks,
          finalOwnDelta: r.diagnostics.finalOwnDelta,
        };
      };

      const v2NoReg = runVariant({});                                                                // no chalkAnchorOwn = reg off
      const v2Cal = runVariant({ chalkAnchorOwn: poolAnchor, targetOwnDelta: TARGET_OWN_DELTA_CALIBRATED });

      rows.push({
        slate: s.slate, candidates: candidates.length,
        poolAnchor, fieldAnchor: stats.chalkAnchorOwn,
        v2NoReg, v2Cal,
      });

      const ts = (Date.now() - t0) / 1000;
      console.log(
        `  ${s.slate.padEnd(15)} P=${candidates.length} chalk(pool/field)=${poolAnchor.toFixed(1)}/${stats.chalkAnchorOwn.toFixed(1)} | ` +
        `noReg: ROI=${v2NoReg.roi.toFixed(0).padStart(5)}% mahal=${v2NoReg.mahal?.toFixed(2) || ' n/a'} ownΔ(eval)=${v2NoReg.metrics.ownDeltaFromAnchor.toFixed(1)} | ` +
        `cal(-4.4): ROI=${v2Cal.roi.toFixed(0).padStart(5)}% mahal=${v2Cal.mahal?.toFixed(2) || ' n/a'} ownΔ(eval)=${v2Cal.metrics.ownDeltaFromAnchor.toFixed(1)} | ${ts.toFixed(1)}s`,
      );
    } catch (e: any) {
      console.log(`  ${s.slate}: error — ${e?.message || e}`);
    }
  }

  // Aggregate
  console.log('\n================================================================');
  console.log('AGGREGATE — leakage-free');
  console.log('================================================================\n');

  function agg(pick: 'v2NoReg' | 'v2Cal') {
    const cost = rows.reduce((s, r) => s + r[pick].cost, 0);
    const pay = rows.reduce((s, r) => s + r[pick].payout, 0);
    const roi = cost > 0 ? (pay / cost - 1) * 100 : 0;
    const prof = rows.filter(r => r[pick].roi > 0).length;
    const top1 = rows.reduce((s, r) => s + r[pick].top1, 0);
    const top01 = rows.reduce((s, r) => s + r[pick].top01, 0);
    const dists = rows.map(r => r[pick].mahal).filter((d): d is number => d !== null);
    return { cost, pay, roi, prof, top1, top01, meanD: mean(dists), distsN: dists.length, dLt15: dists.filter(d => d < 1.5).length, dLt20: dists.filter(d => d < 2.0).length };
  }
  function loo(pick: 'v2NoReg' | 'v2Cal') {
    const tot = agg(pick);
    const out: { slate: string; roi: number }[] = [];
    let worst = Infinity, worstSlate = '';
    for (const r of rows) {
      const c2 = tot.cost - r[pick].cost;
      const p2 = tot.pay - r[pick].payout;
      const roi2 = c2 > 0 ? (p2 / c2 - 1) * 100 : 0;
      out.push({ slate: r.slate, roi: roi2 });
      if (roi2 < worst) { worst = roi2; worstSlate = r.slate; }
    }
    return { mean: mean(out.map(o => o.roi)), std: stddev(out.map(o => o.roi)), worst, worstSlate };
  }

  const nrAgg = agg('v2NoReg'), calAgg = agg('v2Cal');
  const nrLoo = loo('v2NoReg'), calLoo = loo('v2Cal');

  console.log('Metric                     v2-no-reg          v2.1-calibrated');
  console.log('---------------------------------------------------------------');
  console.log(`Slates                     ${rows.length}                  ${rows.length}`);
  console.log(`Total payout               $${nrAgg.pay.toFixed(0).padStart(9)}         $${calAgg.pay.toFixed(0).padStart(9)}`);
  console.log(`Full-sample ROI            ${nrAgg.roi.toFixed(2).padStart(9)}%        ${calAgg.roi.toFixed(2).padStart(9)}%`);
  console.log(`Profitable                 ${nrAgg.prof}/${rows.length}                ${calAgg.prof}/${rows.length}`);
  console.log(`Top-1% hits                ${nrAgg.top1.toString().padStart(9)}         ${calAgg.top1.toString().padStart(9)}`);
  console.log(`Top-0.1% hits              ${nrAgg.top01.toString().padStart(9)}         ${calAgg.top01.toString().padStart(9)}`);
  console.log(`LOO mean ROI               ${nrLoo.mean.toFixed(2).padStart(9)}%        ${calLoo.mean.toFixed(2).padStart(9)}%`);
  console.log(`LOO std                    ${nrLoo.std.toFixed(2).padStart(9)}%        ${calLoo.std.toFixed(2).padStart(9)}%`);
  console.log(`LOO worst drop             ${nrLoo.worst.toFixed(2).padStart(9)}%        ${calLoo.worst.toFixed(2).padStart(9)}%`);
  console.log(`LOO worst slate            ${nrLoo.worstSlate.padEnd(15)}    ${calLoo.worstSlate}`);
  console.log(`Mean Mahalanobis           ${nrAgg.meanD.toFixed(3).padStart(9)}         ${calAgg.meanD.toFixed(3).padStart(9)}      (Atlas 0.703; target <1.5)`);
  console.log(`Slates d<1.5               ${nrAgg.dLt15}/${nrAgg.distsN}              ${calAgg.dLt15}/${calAgg.distsN}`);
  console.log(`Slates d<2.0               ${nrAgg.dLt20}/${nrAgg.distsN}              ${calAgg.dLt20}/${calAgg.distsN}`);

  console.log('\n--- 5-principle structural fidelity ---');
  console.log('Metric                       pro target     v2-no-reg          v2.1-calibrated');
  for (const k of UNIVERSAL_METRICS) {
    const nrVals = rows.map(r => (r.v2NoReg.metrics as any)[k]);
    const calVals = rows.map(r => (r.v2Cal.metrics as any)[k]);
    const nrM = mean(nrVals), nrS = stddev(nrVals), nrCV = nrM !== 0 ? Math.abs(nrS / nrM) : 0;
    const calM = mean(calVals), calS = stddev(calVals), calCV = calM !== 0 ? Math.abs(calS / calM) : 0;
    const tgt = ({ projRatioToOptimal: 0.88, ceilingRatioToOptimal: 0.92, avgPlayerOwnPctile: 0.94, ownStdRatio: 7.1, ownDeltaFromAnchor: -7.2 } as any)[k];
    console.log(`  ${k.padEnd(28)} ${tgt.toString().padStart(8)}  | ${nrM.toFixed(3).padStart(8)} (CV ${nrCV.toFixed(3)})  | ${calM.toFixed(3).padStart(8)} (CV ${calCV.toFixed(3)})`);
  }

  // Avg pool/field gap
  const poolFieldGap = mean(rows.map(r => r.fieldAnchor - r.poolAnchor));
  console.log(`\nMean pool→field anchor gap: ${poolFieldGap.toFixed(2)}pp  (calibration assumption was 2.8)`);

  fs.writeFileSync(OUT_JSON, JSON.stringify({ runDate: new Date().toISOString(), nSlates: rows.length, rows, v2NoReg: { agg: nrAgg, loo: nrLoo }, v2Cal: { agg: calAgg, loo: calLoo } }, null, 2));
  console.log(`\nResults saved to ${OUT_JSON}`);

  // Gate decision
  console.log('\n================================================================');
  console.log('GATE DECISIONS');
  console.log('================================================================\n');
  for (const [label, a, l] of [['v2-no-reg', nrAgg, nrLoo] as const, ['v2.1-calibrated', calAgg, calLoo] as const]) {
    const g1 = a.roi >= 50, g2 = a.meanD < 1.5, g3 = l.mean > 0;
    console.log(`${label}:  Gate1(ROI≥+50%)=${a.roi.toFixed(1)}% ${g1 ? 'PASS' : 'FAIL'}  |  Gate2(mahal<1.5)=${a.meanD.toFixed(3)} ${g2 ? 'PASS' : 'FAIL'}  |  Gate3(LOO>0)=${l.mean.toFixed(1)}% ${g3 ? 'PASS' : 'FAIL'}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
