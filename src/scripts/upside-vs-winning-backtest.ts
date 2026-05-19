/**
 * V1-UpsideMax vs V1-WinningValue backtest harness.
 *
 * Per pre-registered spec — runs both new variants AND V1-NoCorr baseline on the
 * 16-slate development set, producing:
 *   - per-slate portfolios for each variant under upside_vs_winning_backtest/portfolios/
 *   - slate_derived_parameters.csv (anchor/thresholds/weights per slate)
 *   - structural_comparison.csv (per-slate per-variant portfolio metrics)
 *   - test_case_analysis.csv (Type A vs Type B selection counts)
 *   - tournament_metrics.csv (descriptive ROI / top1× / top0.1× per variant)
 *   - cross_variant_divergence.csv (lineup-set Jaccard between variants)
 *
 * Methodology discipline (per spec):
 *   - No iteration on weights / thresholds during run
 *   - Tournament metrics descriptive only, not deployment-deciding
 *   - 16 dev slates only; holdouts sealed
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, loadPoolFromCSV, parseContestActuals } from '../parser';
import { getContestConfig } from '../rules';
import {
  THEORY_V1_NOCORR_PARAMS,
  selectTheoryV1Portfolio,
  TheoryV1Params,
} from '../theory/v1-selector';
import { selectUpsideMaxPortfolio } from '../theory/v1-upside-max-selector';
import { selectWinningValuePortfolio } from '../theory/v1-winning-value-selector';
import { selectWinningCapabilityPortfolio } from '../theory/v1-winning-capability-selector';
import { selectStdDevMaxPortfolio } from '../theory/v1-stddev-max-selector';
import { selectSigmaResidualPortfolio } from '../theory/v1-sigma-residual-selector';
import { selectCVaRPortfolio } from '../theory/v1-cvar-selector';
import { selectSimEnsemblePortfolio } from '../theory/v1-sim-ensemble-selector';
import { selectPortfolioCoveragePortfolio } from '../theory/v1-portfolio-coverage-selector';
import { computeLineupSimStats } from '../theory/v1-sim-stats';
import { computeAnchorReference, p99Sum, p25Sum } from '../theory/v1-anchor';

const DATA_DIR = 'C:/Users/colin/dfs opto';
const OUT_DIR = path.join(DATA_DIR, 'upside_vs_winning_backtest');
const PORTFOLIOS_DIR = path.join(OUT_DIR, 'portfolios');
for (const d of [
  OUT_DIR,
  PORTFOLIOS_DIR,
  path.join(PORTFOLIOS_DIR, 'v1_nocorr'),
  path.join(PORTFOLIOS_DIR, 'v1_upside_max'),
  path.join(PORTFOLIOS_DIR, 'v1_winning_value'),
  path.join(PORTFOLIOS_DIR, 'v1_winning_capability'),
  path.join(PORTFOLIOS_DIR, 'v1_stddev_max'),
  path.join(PORTFOLIOS_DIR, 'v1_sigma_residual'),
  path.join(PORTFOLIOS_DIR, 'v1_cvar'),
  path.join(PORTFOLIOS_DIR, 'v1_sim_ensemble'),
  path.join(PORTFOLIOS_DIR, 'v1_portfolio_coverage'),
]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

const TARGET_COUNT = 150;
const FEE = 20;

interface SlateSpec {
  slate: string;
  proj: string;
  actuals: string;
  pool: string;
}

const DEV_SLATES: SlateSpec[] = [
  { slate: '4-8-26',         proj: '4-8-26projections.csv',         actuals: '4-8-26actuals.csv',         pool: '4-8-26sspool.csv' },
  { slate: '4-12-26',        proj: '4-12-26projections.csv',        actuals: '4-12-26actuals.csv',        pool: '4-12-26sspool.csv' },
  { slate: '4-17-26',        proj: '4-17-26projections.csv',        actuals: '4-17-26actuals.csv',        pool: '4-17-26sspool.csv' },
  { slate: '4-18-26',        proj: '4-18-26projections.csv',        actuals: '4-18-26actuals.csv',        pool: '4-18-26sspool.csv' },
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
  { slate: '5-2-26-main',    proj: '5-2-26projectionsmain.csv',     actuals: '5-2-26actualsmain.csv',     pool: '5-2-26sspoolmain.csv' },
  { slate: '5-3-26',         proj: '5-3-26projections.csv',         actuals: '5-3-26actuals.csv',         pool: '5-3-26sspool.csv' },
];

function norm(n: string): string {
  return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function mean(a: number[]): number { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function stddev(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
}

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
  for (let r = 0; r < cashLine; r++) table[r] = Math.max(minCash, (raw[r] / rawSum) * pool);
  let tSum = 0;
  for (let r = 0; r < cashLine; r++) tSum += table[r];
  const scale = pool / tSum;
  for (let r = 0; r < cashLine; r++) table[r] *= scale;
  return table;
}

interface PortfolioMetrics {
  variant: string;
  slate: string;
  n: number;
  meanProj: number;
  meanP99: number;
  meanP25: number;
  meanOwn: number;
  meanSalary: number;
  uniquePlayers: number;
  stackSizeDist: string;    // "5+3=42 5+2+1=28 ..."
  meanJaccard: number;      // mean pairwise intra-portfolio Jaccard
  puntCount: number;        // lineups with 3+ players under $4K
}

function lineupOwnership(lu: Lineup): number {
  return lu.players.reduce((s, p) => s + (p.ownership || 0), 0);
}

function lineupSalary(lu: Lineup): number {
  return lu.players.reduce((s, p) => s + (p.salary || 0), 0);
}

function puntCount(lu: Lineup): number {
  let c = 0;
  for (const p of lu.players) if ((p.salary || 0) < 4000) c++;
  return c;
}

function stackShape(lu: Lineup): string {
  const teams = new Map<string, number>();
  for (const p of lu.players) {
    if ((p.position || '').toUpperCase().includes('P')) continue;
    const t = (p.team || '').toUpperCase();
    teams.set(t, (teams.get(t) || 0) + 1);
  }
  return [...teams.values()].sort((a, b) => b - a).join('+');
}

function meanIntraJaccard(portfolio: Lineup[], sampleSize: number = 500): number {
  if (portfolio.length < 2) return 0;
  const n = portfolio.length;
  const pairs: [number, number][] = [];
  // Sample pairs deterministically (round-robin).
  if (n * (n - 1) / 2 <= sampleSize) {
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pairs.push([i, j]);
  } else {
    // Deterministic stride sampling.
    let count = 0;
    for (let i = 0; i < n && count < sampleSize; i++) {
      for (let j = i + 1; j < n && count < sampleSize; j++) {
        pairs.push([i, j]);
        count++;
      }
    }
  }
  let sum = 0;
  for (const [i, j] of pairs) {
    const a = new Set(portfolio[i].players.map(p => p.id));
    const b = new Set(portfolio[j].players.map(p => p.id));
    let inter = 0;
    for (const id of a) if (b.has(id)) inter++;
    const union = a.size + b.size - inter;
    sum += union > 0 ? inter / union : 0;
  }
  return sum / pairs.length;
}

function computeMetrics(variant: string, slate: string, portfolio: Lineup[]): PortfolioMetrics {
  const allPlayers = new Set<string>();
  for (const lu of portfolio) for (const p of lu.players) allPlayers.add(p.id);
  const shapeCounts: Record<string, number> = {};
  let puntCt = 0;
  for (const lu of portfolio) {
    const sh = stackShape(lu);
    shapeCounts[sh] = (shapeCounts[sh] || 0) + 1;
    if (puntCount(lu) >= 3) puntCt++;
  }
  const topShapes = Object.entries(shapeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');

  return {
    variant,
    slate,
    n: portfolio.length,
    meanProj: mean(portfolio.map(L => L.projection)),
    meanP99: mean(portfolio.map(p99Sum)),
    meanP25: mean(portfolio.map(p25Sum)),
    meanOwn: mean(portfolio.map(lineupOwnership)),
    meanSalary: mean(portfolio.map(lineupSalary)),
    uniquePlayers: allPlayers.size,
    stackSizeDist: topShapes,
    meanJaccard: meanIntraJaccard(portfolio),
    puntCount: puntCt,
  };
}

interface TypeCounts {
  variant: string;
  slate: string;
  typeA_pool: number;
  typeB_pool: number;
  typeA_selected: number;
  typeB_selected: number;
}

function classifyTypeA(lu: Lineup, projMean: number, projStd: number, winningThreshold: number, ownMedian: number): boolean {
  const proj = lu.projection;
  const p99 = p99Sum(lu);
  const own = lineupOwnership(lu);
  return proj > projMean + 0.5 * projStd && p99 < winningThreshold && own > ownMedian;
}

function classifyTypeB(lu: Lineup, projMean: number, winningThreshold: number, ownMedian: number): boolean {
  const proj = lu.projection;
  const p99 = p99Sum(lu);
  const own = lineupOwnership(lu);
  return proj < projMean && p99 > winningThreshold && own < ownMedian;
}

function computeTypeCounts(
  variant: string,
  slate: string,
  candidates: Lineup[],
  portfolio: Lineup[],
  projMean: number,
  projStd: number,
  winningThreshold: number,
  ownMedian: number,
): TypeCounts {
  const portfolioHashes = new Set(portfolio.map(L => L.hash));
  let aPool = 0, bPool = 0, aSel = 0, bSel = 0;
  for (const lu of candidates) {
    if (classifyTypeA(lu, projMean, projStd, winningThreshold, ownMedian)) {
      aPool++;
      if (portfolioHashes.has(lu.hash)) aSel++;
    }
    if (classifyTypeB(lu, projMean, winningThreshold, ownMedian)) {
      bPool++;
      if (portfolioHashes.has(lu.hash)) bSel++;
    }
  }
  return { variant, slate, typeA_pool: aPool, typeB_pool: bPool, typeA_selected: aSel, typeB_selected: bSel };
}

interface TournamentMetrics {
  variant: string;
  slate: string;
  fieldSize: number;
  payout: number;
  cost: number;
  roi: number;
  meanActual: number;
  maxActual: number;
  top1Hits: number;
  top1Threshold: number;
  topOnePerThousand: number;  // top-0.1% lift
}

function scoreTournament(
  variant: string,
  slate: string,
  portfolio: Lineup[],
  actualsObj: any,
): TournamentMetrics {
  const F = actualsObj.entries.length;
  const sortedPts = actualsObj.entries.map((e: any) => e.actualPoints).sort((a: number, b: number) => b - a);
  const top1T = sortedPts[Math.max(0, Math.floor(F * 0.01) - 1)] || 0;
  const top01T = sortedPts[Math.max(0, Math.floor(F * 0.001) - 1)] || 0;
  const payTable = buildPayoutTable(F);

  let total = 0;
  let t1 = 0;
  let t01 = 0;
  const acts: number[] = [];
  for (const lu of portfolio) {
    let pts = 0;
    let miss = false;
    for (const p of lu.players) {
      const r = actualsObj.playerActualsByName.get(norm(p.name));
      if (!r) { miss = true; break; }
      pts += r.fpts;
    }
    if (miss) continue;
    acts.push(pts);
    if (pts >= top1T) t1++;
    if (pts >= top01T) t01++;
    let lo = 0, hi = sortedPts.length;
    while (lo < hi) { const m = (lo + hi) >>> 1; if (sortedPts[m] >= pts) lo = m + 1; else hi = m; }
    const rank = Math.max(1, lo);
    if (rank <= payTable.length) total += payTable[rank - 1];
  }

  const cost = portfolio.length * FEE;
  return {
    variant, slate, fieldSize: F,
    payout: total, cost, roi: cost > 0 ? (total / cost - 1) * 100 : 0,
    meanActual: mean(acts),
    maxActual: acts.length ? Math.max(...acts) : 0,
    top1Hits: t1,
    top1Threshold: top1T,
    topOnePerThousand: t01,
  };
}

function writePortfolioCsv(variant: string, slate: string, portfolio: Lineup[]): void {
  const dir = path.join(PORTFOLIOS_DIR, variant);
  const f = path.join(dir, `${slate}.csv`);
  const lines = ['rank,projection,ownership,salary,players'];
  for (let i = 0; i < portfolio.length; i++) {
    const lu = portfolio[i];
    const own = lineupOwnership(lu);
    const sal = lineupSalary(lu);
    const ply = lu.players.map(p => p.name).join('|');
    lines.push(`${i + 1},${lu.projection.toFixed(2)},${own.toFixed(2)},${sal},"${ply}"`);
  }
  fs.writeFileSync(f, lines.join('\n'));
}

async function main(): Promise<void> {
  console.log('='.repeat(72));
  console.log('V1-UpsideMax vs V1-WinningValue — 16-slate dev backtest');
  console.log('='.repeat(72));
  console.log(`Target N=${TARGET_COUNT}, output: ${OUT_DIR}\n`);

  const slateParams: any[] = [];
  const allMetrics: PortfolioMetrics[] = [];
  const allTypes: TypeCounts[] = [];
  const allTourney: TournamentMetrics[] = [];
  const allCrossPairs: any[] = [];

  for (const s of DEV_SLATES) {
    const projPath = path.join(DATA_DIR, s.proj);
    const actualsPath = path.join(DATA_DIR, s.actuals);
    const poolPath = path.join(DATA_DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) {
      console.log(`  ${s.slate}: missing files, skip`);
      continue;
    }

    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const playerPool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);

    const idMap = new Map<string, Player>();
    for (const p of playerPool.players) idMap.set(p.id, p);

    let loaded;
    try {
      loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
    } catch (e: any) {
      console.log(`  ${s.slate}: pool load failed (${e?.message || e}), skip`);
      continue;
    }
    const candidates: Lineup[] = Array.from(new Map<string, Lineup>(loaded.lineups.map(l => [l.hash, l])).values());
    if (candidates.length < 100) {
      console.log(`  ${s.slate}: P=${candidates.length} too small, skip`);
      continue;
    }

    // Slate-derived anchor (logged for each slate)
    const anchor = computeAnchorReference(candidates);
    const projs = candidates.map(L => L.projection);
    const projMean = mean(projs);
    const projStd = stddev(projs);
    const owns = candidates.map(lineupOwnership);
    const ownsSorted = [...owns].sort((a, b) => a - b);
    const ownMedian = ownsSorted[Math.floor(ownsSorted.length / 2)] || 0;

    slateParams.push({
      slate: s.slate,
      poolSize: candidates.length,
      projMean: +projMean.toFixed(2),
      projStd: +projStd.toFixed(2),
      anchorSize: anchor.anchorSet.length,
      winningThreshold: +anchor.winningThreshold.toFixed(2),
      anchorMean: +anchor.anchorMean.toFixed(2),
      anchorStd: +anchor.anchorStd.toFixed(2),
      poolMean: +anchor.poolMean.toFixed(2),
      poolStd: +anchor.poolStd.toFixed(2),
      upsideWeight: +anchor.upsideWeight.toFixed(4),
      winningWeight: +anchor.winningWeight.toFixed(4),
      ownMedian: +ownMedian.toFixed(2),
    });

    // Compute SHARED t-copula sim stats ONCE per slate; reused across the 5
    // sim-consuming variants (StdDevMax, SigmaResidual, CVaR, SimEnsemble,
    // PortfolioCoverage). WinningCapability has its own legacy sim path —
    // structurally equivalent but recomputed.
    const t0 = Date.now();
    const simStats = computeLineupSimStats(candidates, playerPool.players);

    const nocorrResult = selectTheoryV1Portfolio(candidates, TARGET_COUNT, THEORY_V1_NOCORR_PARAMS);
    const upsideMaxResult = selectUpsideMaxPortfolio(candidates, TARGET_COUNT, THEORY_V1_NOCORR_PARAMS);
    const winningValueResult = selectWinningValuePortfolio(candidates, TARGET_COUNT, THEORY_V1_NOCORR_PARAMS);
    const winningCapResult = selectWinningCapabilityPortfolio(candidates, playerPool.players, TARGET_COUNT, THEORY_V1_NOCORR_PARAMS);
    const stdDevMaxResult = selectStdDevMaxPortfolio(candidates, playerPool.players, TARGET_COUNT, THEORY_V1_NOCORR_PARAMS, simStats);
    const sigResResult = selectSigmaResidualPortfolio(candidates, playerPool.players, TARGET_COUNT, THEORY_V1_NOCORR_PARAMS, simStats);
    const cvarResult = selectCVaRPortfolio(candidates, playerPool.players, TARGET_COUNT, THEORY_V1_NOCORR_PARAMS, simStats);
    const ensResult = selectSimEnsemblePortfolio(candidates, playerPool.players, TARGET_COUNT, THEORY_V1_NOCORR_PARAMS, simStats);
    const covResult = selectPortfolioCoveragePortfolio(candidates, playerPool.players, TARGET_COUNT, THEORY_V1_NOCORR_PARAMS, simStats);

    const variantPorts: Array<[string, Lineup[]]> = [
      ['v1_nocorr', nocorrResult.portfolio],
      ['v1_upside_max', upsideMaxResult.portfolio],
      ['v1_winning_value', winningValueResult.portfolio],
      ['v1_winning_capability', winningCapResult.portfolio],
      ['v1_stddev_max', stdDevMaxResult.portfolio],
      ['v1_sigma_residual', sigResResult.portfolio],
      ['v1_cvar', cvarResult.portfolio],
      ['v1_sim_ensemble', ensResult.portfolio],
      ['v1_portfolio_coverage', covResult.selected],
    ];

    for (const [name, port] of variantPorts) {
      writePortfolioCsv(name, s.slate, port);
      allMetrics.push(computeMetrics(name, s.slate, port));
      allTypes.push(computeTypeCounts(name, s.slate, candidates, port, projMean, projStd, anchor.winningThreshold, ownMedian));
      allTourney.push(scoreTournament(name, s.slate, port, actuals));
    }

    // Cross-variant divergence (pairs). Focus pairs: each new variant vs nocorr
    // and vs winning_value (the validated structural shift baseline).
    const sets: Record<string, Set<string>> = {};
    for (const [name, port] of variantPorts) sets[name] = new Set(port.map(L => L.hash));
    const jaccard = (a: Set<string>, b: Set<string>): number => {
      let inter = 0;
      for (const x of a) if (b.has(x)) inter++;
      const union = a.size + b.size - inter;
      return union > 0 ? inter / union : 0;
    };

    const pairRow: any = { slate: s.slate };
    const pairs: Array<[string, string]> = [
      ['v1_nocorr', 'v1_upside_max'],
      ['v1_nocorr', 'v1_winning_value'],
      ['v1_nocorr', 'v1_winning_capability'],
      ['v1_nocorr', 'v1_stddev_max'],
      ['v1_nocorr', 'v1_sigma_residual'],
      ['v1_nocorr', 'v1_cvar'],
      ['v1_nocorr', 'v1_sim_ensemble'],
      ['v1_nocorr', 'v1_portfolio_coverage'],
      ['v1_winning_value', 'v1_stddev_max'],
      ['v1_winning_value', 'v1_sigma_residual'],
      ['v1_winning_value', 'v1_cvar'],
      ['v1_winning_value', 'v1_sim_ensemble'],
      ['v1_winning_value', 'v1_portfolio_coverage'],
      ['v1_stddev_max', 'v1_sigma_residual'],
      ['v1_stddev_max', 'v1_portfolio_coverage'],
      ['v1_sigma_residual', 'v1_portfolio_coverage'],
      ['v1_cvar', 'v1_sim_ensemble'],
    ];
    for (const [a, b] of pairs) {
      const key = `${a.replace('v1_', '')}__${b.replace('v1_', '')}`;
      pairRow[key] = +jaccard(sets[a], sets[b]).toFixed(3);
    }
    pairRow.filteredOutByWinning = winningValueResult.filteredOutCount;
    pairRow.wcap_threshold = +winningCapResult.jointP99Threshold.toFixed(2);
    pairRow.wcap_weight = +winningCapResult.winningWeight.toFixed(4);
    pairRow.stddev_weight = +stdDevMaxResult.stdDevWeight.toFixed(4);
    pairRow.sigres_weight = +sigResResult.sigResWeight.toFixed(4);
    pairRow.cvar_weight = +cvarResult.cvarWeight.toFixed(4);
    pairRow.ens_weight = +ensResult.ensembleWeight.toFixed(4);
    pairRow.cov_maxWorldMean = +covResult.diagnostics.finalMaxWorldMean.toFixed(2);
    pairRow.cov_maxWorldStd = +covResult.diagnostics.finalMaxWorldStd.toFixed(2);
    allCrossPairs.push(pairRow);

    const ts = ((Date.now() - t0) / 1000).toFixed(1);
    const lastTourney = allTourney.slice(-9);
    const roiStr = lastTourney.map((t, i) => `${variantPorts[i][0].replace('v1_', '')}=${t.roi.toFixed(0)}%`).join('  ');
    console.log(`  ${s.slate.padEnd(15)} P=${candidates.length} | ${roiStr} | ${ts}s`);
  }

  // ===== Write outputs =====

  // Slate-derived parameters
  writeCsv(path.join(OUT_DIR, 'slate_derived_parameters.csv'), slateParams);

  // Structural comparison
  writeCsv(path.join(OUT_DIR, 'structural_comparison.csv'), allMetrics);

  // Test case
  writeCsv(path.join(OUT_DIR, 'test_case_analysis.csv'), allTypes);

  // Tournament metrics
  writeCsv(path.join(OUT_DIR, 'tournament_metrics.csv'), allTourney);

  // Cross-variant divergence
  writeCsv(path.join(OUT_DIR, 'cross_variant_divergence.csv'), allCrossPairs);

  // Aggregate summary
  const variants = [
    'v1_nocorr', 'v1_upside_max', 'v1_winning_value', 'v1_winning_capability',
    'v1_stddev_max', 'v1_sigma_residual', 'v1_cvar', 'v1_sim_ensemble', 'v1_portfolio_coverage',
  ];
  console.log('\n' + '='.repeat(72));
  console.log('AGGREGATE — 16-slate descriptive comparison');
  console.log('='.repeat(72));
  console.log('\n--- Tournament metrics (DESCRIPTIVE ONLY, not deployment-deciding) ---');
  for (const v of variants) {
    const rows = allTourney.filter(r => r.variant === v);
    const totalCost = rows.reduce((s, r) => s + r.cost, 0);
    const totalPay = rows.reduce((s, r) => s + r.payout, 0);
    const roi = totalCost > 0 ? (totalPay / totalCost - 1) * 100 : 0;
    const profit = rows.filter(r => r.roi > 0).length;
    const t1Sum = rows.reduce((s, r) => s + r.top1Hits, 0);
    const t01Sum = rows.reduce((s, r) => s + r.topOnePerThousand, 0);
    console.log(`  ${v.padEnd(20)} cost=$${totalCost.toLocaleString()} payout=$${totalPay.toFixed(0).padStart(8)} ROI=${roi.toFixed(2)}%  profitable=${profit}/${rows.length}  top1Hits=${t1Sum}  top0.1Hits=${t01Sum}`);
  }
  console.log('\n--- Structural means (avg across 16 slates) ---');
  for (const v of variants) {
    const rows = allMetrics.filter(r => r.variant === v);
    console.log(`  ${v.padEnd(20)} meanProj=${mean(rows.map(r => r.meanProj)).toFixed(1)}  meanP99=${mean(rows.map(r => r.meanP99)).toFixed(1)}  meanP25=${mean(rows.map(r => r.meanP25)).toFixed(1)}  meanOwn=${mean(rows.map(r => r.meanOwn)).toFixed(2)}  meanJaccard=${mean(rows.map(r => r.meanJaccard)).toFixed(3)}  uniquePly_avg=${mean(rows.map(r => r.uniquePlayers)).toFixed(0)}`);
  }
  console.log('\n--- Type A vs Type B selection (avg per slate) ---');
  for (const v of variants) {
    const rows = allTypes.filter(r => r.variant === v);
    console.log(`  ${v.padEnd(20)} avg_typeA_selected=${mean(rows.map(r => r.typeA_selected)).toFixed(1)}  avg_typeB_selected=${mean(rows.map(r => r.typeB_selected)).toFixed(1)}  TypeB/A ratio=${(mean(rows.map(r => r.typeB_selected)) / Math.max(1, mean(rows.map(r => r.typeA_selected)))).toFixed(2)}`);
  }
  console.log('\n--- Cross-variant Jaccard (avg) ---');
  const jaccardKeys = Object.keys(allCrossPairs[0] || {}).filter(k => k.includes('__'));
  for (const k of jaccardKeys) {
    console.log(`  ${k.padEnd(48)} ${mean(allCrossPairs.map(r => r[k] || 0)).toFixed(3)}`);
  }
  console.log(`\n--- Slate-derived weights (avg) ---`);
  for (const k of ['wcap_weight', 'stddev_weight', 'sigres_weight', 'cvar_weight', 'ens_weight']) {
    console.log(`  ${k.padEnd(20)} ${mean(allCrossPairs.map(r => r[k] || 0)).toFixed(4)}`);
  }
  console.log(`  cov_maxWorldMean     ${mean(allCrossPairs.map(r => r.cov_maxWorldMean || 0)).toFixed(2)}`);
  console.log(`  cov_maxWorldStd      ${mean(allCrossPairs.map(r => r.cov_maxWorldStd || 0)).toFixed(2)}`);
  console.log(`\nOutputs saved to ${OUT_DIR}`);
}

function writeCsv(p: string, rows: any[]): void {
  if (!rows.length) {
    fs.writeFileSync(p, '');
    return;
  }
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(headers.map(h => {
      const v = r[h];
      if (typeof v === 'string' && (v.includes(',') || v.includes('"'))) {
        return `"${v.replace(/"/g, '""')}"`;
      }
      return String(v);
    }).join(','));
  }
  fs.writeFileSync(p, lines.join('\n'));
}

main().catch(e => { console.error(e); process.exit(1); });
