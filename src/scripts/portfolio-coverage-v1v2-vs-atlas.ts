/**
 * PortfolioCoverage v1 vs v2 — 29-slate side-by-side validation.
 *
 * Re-runs v1 alongside v2 (with underfill fix + ownDelta regularizer toward
 * pro target −7.2) on Atlas's 29-slate validation set. Both share one t-copula
 * sim per slate. Reports gate-by-gate comparison.
 *
 * Output:
 *   - Console table: per-slate v1 vs v2 (ROI, Mahal, portfolio size)
 *   - portfolio_coverage_v1v2_results.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as csvParse } from 'csv-parse/sync';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, loadPoolFromCSV, parseContestActuals } from '../parser';
import { getContestConfig } from '../rules';
import { THEORY_V1_NOCORR_PARAMS } from '../theory/v1-selector';
import { computeLineupSimStats } from '../theory/v1-sim-stats';
import { selectPortfolioCoveragePortfolio } from '../theory/v1-portfolio-coverage-selector';
import { selectPortfolioCoverageV2Portfolio } from '../theory/v1-portfolio-coverage-v2-selector';

/**
 * Mirror preslate's `Adj Own` override. Selector inputs must use preslate-realistic
 * ownership (Adj Own projection), NOT actual contest ownership from actuals. The
 * latter would be temporal leakage: validating a selector with information it
 * can't have at preslate time.
 */
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

/** Selector-input chalk anchor: top-100 highest-mean-own POOL lineups (preslate proxy). */
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

const DIR = 'C:/Users/colin/dfs opto';
const OUT_JSON = path.join(DIR, 'portfolio_coverage_v1v2_results.json');
const PRO_CONSENSUS_PATH = path.join(DIR, 'pro_consensus_slate_relative.json');
const N = 150;
const FEE = 20;

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

function scoreTournament(portfolio: Lineup[], actuals: any): { cost: number; payout: number; roi: number; top1: number; top01: number; maxScore: number } {
  if (portfolio.length === 0) return { cost: 0, payout: 0, roi: 0, top1: 0, top01: 0, maxScore: 0 };
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
  let payout = 0, top1 = 0, top01 = 0, maxScore = 0;
  for (const s of ourScores) {
    if (s > maxScore) maxScore = s;
    let lo = 0, hi = entryScores.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (entryScores[m] > s) lo = m + 1; else hi = m; }
    const rank = lo;
    if (rank < payoutTable.length) payout += payoutTable[rank];
    if (rank < F * 0.01) top1++;
    if (rank < F * 0.001) top01++;
  }
  return { cost, payout, roi: cost > 0 ? (payout / cost - 1) * 100 : 0, top1, top01, maxScore };
}

async function main() {
  console.log('================================================================');
  console.log('PortfolioCoverage v1 vs v2 — 29-slate side-by-side');
  console.log('================================================================\n');

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

  interface SlateRow {
    slate: string;
    candidates: number;
    chalkAnchorOwn: number;
    v1: { port: number; roi: number; mahal: number | null; top1: number; top01: number; cost: number; payout: number; metrics: UniversalMetrics };
    v2: { port: number; roi: number; mahal: number | null; top1: number; top01: number; cost: number; payout: number; metrics: UniversalMetrics; greedy: number; fallback: number; finalOwnDelta: number };
  }

  const rows: SlateRow[] = [];

  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj), actualsPath = path.join(DIR, s.actuals), poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) { console.log(`  ${s.slate}: missing files, skip`); continue; }
    const t0 = Date.now();
    try {
      const pr = parseCSVFile(projPath, 'mlb', true);
      const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
      const playerPool = buildPlayerPool(pr.players, pr.detectedContestType);
      const actuals = parseContestActuals(actualsPath, config);
      const idMap = new Map<string, Player>(); const nameMap = new Map<string, Player>();
      for (const p of playerPool.players) { idMap.set(p.id, p); nameMap.set(norm(p.name), p); }

      // PRESLATE-PARITY: apply Adj Own override exactly as preslate does. Selector
      // inputs must use the same ownership signal the preslate pipeline produces.
      // Doing this BEFORE loadPoolFromCSV so lineup-level ownership computations
      // (within selector + sim-stats) all see the override value.
      const adjOwnMap = loadAdjOwn(projPath);
      for (const p of playerPool.players) {
        const adj = adjOwnMap.get(p.id);
        if (adj !== undefined) p.ownership = adj;
      }

      const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
      const candidates: Lineup[] = Array.from(new Map<string, Lineup>(loaded.lineups.map(l => [l.hash, l])).values());
      if (candidates.length < 100) { console.log(`  ${s.slate}: P=${candidates.length} too small, skip`); continue; }

      // Build field lineups — used ONLY for evaluation (Mahalanobis 5-principle
      // metrics), NEVER as selector input. Evaluation against the actual contest
      // field is the ground truth we measure against.
      const fieldLineups: Player[][] = [];
      for (const e of actuals.entries) {
        const pls: Player[] = []; let ok = true;
        for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
        if (ok) fieldLineups.push(pls);
      }
      const stats = computeSlateStats(playerPool.players, fieldLineups);

      // SELECTOR-INPUT chalk anchor: pool top-100 proxy, mirroring preslate.
      // We do NOT pass stats.chalkAnchorOwn (which is field-based) into the
      // selector — that would be temporal leakage.
      const selectorChalkAnchorOwn = poolChalkAnchorOwn(candidates);

      // Shared sim
      const simStats = computeLineupSimStats(candidates, playerPool.players);

      // v1 — no ownership input (no regularizer)
      const v1 = selectPortfolioCoveragePortfolio(candidates, playerPool.players, N, THEORY_V1_NOCORR_PARAMS, simStats);
      const v1Lineups = v1.selected.map(lu => lu.players);
      const v1Metrics = computeUniversal(v1Lineups, stats);    // evaluation vs field — OK
      const v1Mahal = mahalanobis(v1Metrics, s.slate);
      const v1Tourney = scoreTournament(v1.selected, actuals);

      // v2 — chalkAnchorOwn from POOL proxy (preslate-realistic input)
      const v2 = selectPortfolioCoverageV2Portfolio(
        candidates, playerPool.players, N, THEORY_V1_NOCORR_PARAMS, simStats,
        { chalkAnchorOwn: selectorChalkAnchorOwn, fallbackToV1: true },
      );
      const v2Lineups = v2.selected.map(lu => lu.players);
      const v2Metrics = computeUniversal(v2Lineups, stats);    // evaluation vs field — OK
      const v2Mahal = mahalanobis(v2Metrics, s.slate);
      const v2Tourney = scoreTournament(v2.selected, actuals);

      rows.push({
        slate: s.slate,
        candidates: candidates.length,
        chalkAnchorOwn: selectorChalkAnchorOwn,    // preslate-realistic (pool top-100)
        // NOTE: stats.chalkAnchorOwn (field) is also recorded below for diagnostic.
        v1: {
          port: v1.selected.length, roi: v1Tourney.roi, mahal: v1Mahal,
          top1: v1Tourney.top1, top01: v1Tourney.top01,
          cost: v1Tourney.cost, payout: v1Tourney.payout, metrics: v1Metrics,
        },
        v2: {
          port: v2.selected.length, roi: v2Tourney.roi, mahal: v2Mahal,
          top1: v2Tourney.top1, top01: v2Tourney.top01,
          cost: v2Tourney.cost, payout: v2Tourney.payout, metrics: v2Metrics,
          greedy: v2.diagnostics.greedyPicks, fallback: v2.diagnostics.fallbackPicks,
          finalOwnDelta: v2.diagnostics.finalOwnDelta,
        },
      });

      const ts = (Date.now() - t0) / 1000;
      console.log(
        `  ${s.slate.padEnd(15)} P=${candidates.length} chalk(pool/field)=${selectorChalkAnchorOwn.toFixed(1)}/${stats.chalkAnchorOwn.toFixed(1)} | v1: port=${v1.selected.length} ROI=${v1Tourney.roi.toFixed(0).padStart(5)}% mahal=${v1Mahal?.toFixed(2) || ' n/a'} | v2: port=${v2.selected.length} ROI=${v2Tourney.roi.toFixed(0).padStart(5)}% mahal=${v2Mahal?.toFixed(2) || ' n/a'} grd=${v2.diagnostics.greedyPicks} fb=${v2.diagnostics.fallbackPicks} ownD=${v2.diagnostics.finalOwnDelta.toFixed(1)} | ${ts.toFixed(1)}s`,
      );
    } catch (e: any) {
      console.log(`  ${s.slate}: error — ${e?.message || e}`);
    }
  }

  // ===== Aggregates =====
  console.log('\n================================================================');
  console.log('AGGREGATE');
  console.log('================================================================\n');

  function aggregate(rows: SlateRow[], pick: 'v1' | 'v2') {
    const cost = rows.reduce((s, r) => s + r[pick].cost, 0);
    const pay = rows.reduce((s, r) => s + r[pick].payout, 0);
    const roi = cost > 0 ? (pay / cost - 1) * 100 : 0;
    const prof = rows.filter(r => r[pick].roi > 0).length;
    const top1 = rows.reduce((s, r) => s + r[pick].top1, 0);
    const top01 = rows.reduce((s, r) => s + r[pick].top01, 0);
    const dists = rows.map(r => r[pick].mahal).filter((d): d is number => d !== null);
    const meanD = mean(dists);
    const dLt15 = dists.filter(d => d < 1.5).length;
    const dLt20 = dists.filter(d => d < 2.0).length;
    return { cost, pay, roi, prof, top1, top01, meanD, dLt15, dLt20, distsN: dists.length };
  }

  function looROIs(rows: SlateRow[], pick: 'v1' | 'v2'): { mean: number; std: number; worst: number; worstSlate: string } {
    const tot = aggregate(rows, pick);
    const out: number[] = [];
    let worst = Infinity, worstSlate = '';
    for (const r of rows) {
      const c2 = tot.cost - r[pick].cost;
      const p2 = tot.pay - r[pick].payout;
      const roi2 = c2 > 0 ? (p2 / c2 - 1) * 100 : 0;
      out.push(roi2);
      if (roi2 < worst) { worst = roi2; worstSlate = r.slate; }
    }
    return { mean: mean(out), std: stddev(out), worst, worstSlate };
  }

  const v1Agg = aggregate(rows, 'v1');
  const v2Agg = aggregate(rows, 'v2');
  const v1Loo = looROIs(rows, 'v1');
  const v2Loo = looROIs(rows, 'v2');

  console.log('Metric                       v1                v2');
  console.log('-----------------------------------------------------------');
  console.log(`Slates run                  ${rows.length}                ${rows.length}`);
  console.log(`Total cost                  $${v1Agg.cost.toLocaleString().padStart(8)}        $${v2Agg.cost.toLocaleString().padStart(8)}`);
  console.log(`Total payout                $${v1Agg.pay.toFixed(0).padStart(8)}        $${v2Agg.pay.toFixed(0).padStart(8)}`);
  console.log(`Full-sample ROI             ${v1Agg.roi.toFixed(2).padStart(8)}%       ${v2Agg.roi.toFixed(2).padStart(8)}%`);
  console.log(`Profitable slates           ${v1Agg.prof}/${rows.length}             ${v2Agg.prof}/${rows.length}`);
  console.log(`Top-1% hits                 ${v1Agg.top1.toString().padStart(8)}        ${v2Agg.top1.toString().padStart(8)}`);
  console.log(`Top-0.1% hits               ${v1Agg.top01.toString().padStart(8)}        ${v2Agg.top01.toString().padStart(8)}`);
  console.log(`LOO mean ROI                ${v1Loo.mean.toFixed(2).padStart(8)}%       ${v2Loo.mean.toFixed(2).padStart(8)}%`);
  console.log(`LOO std                     ${v1Loo.std.toFixed(2).padStart(8)}%       ${v2Loo.std.toFixed(2).padStart(8)}%`);
  console.log(`LOO worst drop              ${v1Loo.worst.toFixed(2).padStart(8)}%       ${v2Loo.worst.toFixed(2).padStart(8)}%`);
  console.log(`LOO worst slate             ${v1Loo.worstSlate.padEnd(14)}    ${v2Loo.worstSlate}`);
  console.log(`Mean Mahalanobis (d)        ${v1Agg.meanD.toFixed(3).padStart(8)}        ${v2Agg.meanD.toFixed(3).padStart(8)}      (Atlas 0.703; target <1.5)`);
  console.log(`Slates with d<1.5           ${v1Agg.dLt15}/${v1Agg.distsN}             ${v2Agg.dLt15}/${v2Agg.distsN}`);
  console.log(`Slates with d<2.0           ${v1Agg.dLt20}/${v1Agg.distsN}             ${v2Agg.dLt20}/${v2Agg.distsN}`);

  // Portfolio fill comparison
  const v1Underfilled = rows.filter(r => r.v1.port < N).length;
  const v2Underfilled = rows.filter(r => r.v2.port < N).length;
  const v1AvgPort = mean(rows.map(r => r.v1.port));
  const v2AvgPort = mean(rows.map(r => r.v2.port));
  console.log(`Underfilled slates          ${v1Underfilled}/${rows.length}            ${v2Underfilled}/${rows.length}`);
  console.log(`Avg portfolio size          ${v1AvgPort.toFixed(1).padStart(8)}        ${v2AvgPort.toFixed(1).padStart(8)}`);
  const v2TotalFallback = rows.reduce((s, r) => s + r.v2.fallback, 0);
  console.log(`v2 fallback picks total     n/a              ${v2TotalFallback}`);
  console.log(`v2 mean finalOwnDelta       n/a              ${mean(rows.map(r => r.v2.finalOwnDelta)).toFixed(2)}    (target −7.2; chalk anchor varies)`);

  // 5-principle table
  console.log('\n--- 5-principle structural fidelity ---');
  console.log('Metric                       pro target     v1              v2');
  for (const k of UNIVERSAL_METRICS) {
    const v1Vals = rows.map(r => (r.v1.metrics as any)[k]);
    const v2Vals = rows.map(r => (r.v2.metrics as any)[k]);
    const v1m = mean(v1Vals), v1s = stddev(v1Vals), v1cv = v1m !== 0 ? Math.abs(v1s / v1m) : 0;
    const v2m = mean(v2Vals), v2s = stddev(v2Vals), v2cv = v2m !== 0 ? Math.abs(v2s / v2m) : 0;
    const tgt = ({ projRatioToOptimal: 0.88, ceilingRatioToOptimal: 0.92, avgPlayerOwnPctile: 0.94, ownStdRatio: 7.1, ownDeltaFromAnchor: -7.2 } as any)[k];
    console.log(`  ${k.padEnd(28)} ${tgt.toString().padStart(8)}  | ${v1m.toFixed(3).padStart(7)} (CV ${v1cv.toFixed(3)})  | ${v2m.toFixed(3).padStart(7)} (CV ${v2cv.toFixed(3)})`);
  }

  fs.writeFileSync(OUT_JSON, JSON.stringify({
    runDate: new Date().toISOString(),
    v1: { agg: v1Agg, loo: v1Loo, underfilled: v1Underfilled, avgPort: v1AvgPort },
    v2: { agg: v2Agg, loo: v2Loo, underfilled: v2Underfilled, avgPort: v2AvgPort, fallbackPicks: v2TotalFallback },
    rows,
  }, null, 2));
  console.log(`\nResults saved to ${OUT_JSON}`);

  // Gate decision for v2
  console.log('\n================================================================');
  console.log('GATE DECISION — v2');
  console.log('================================================================');
  const v2Gate1 = v2Agg.roi >= 50;
  const v2Gate2 = v2Agg.meanD < 1.5;
  const v2Gate3 = v2Loo.mean > 0;
  console.log(`Gate 1 — Backtest ROI ≥ +50%  (Atlas +75.05%):     ${v2Agg.roi.toFixed(2)}%   ${v2Gate1 ? 'PASS' : 'FAIL'}`);
  console.log(`Gate 2 — Mean Mahalanobis < 1.5  (Atlas 0.703):    ${v2Agg.meanD.toFixed(3)}   ${v2Gate2 ? 'PASS' : 'FAIL'}`);
  console.log(`Gate 3 — LOO mean ROI > 0:                          ${v2Loo.mean.toFixed(2)}%   ${v2Gate3 ? 'PASS' : 'FAIL'}`);
  console.log(`Gate 4 — see 5-principle table above`);
  if (v2Gate1 && v2Gate2 && v2Gate3) {
    console.log('\n  v2 PASS all 3 hard gates. Ready for parallel-deployment investigation.');
  } else {
    console.log('\n  v2 FAIL one or more hard gates.');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
