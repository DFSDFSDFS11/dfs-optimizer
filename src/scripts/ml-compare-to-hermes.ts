/**
 * Stage 5/6: For each held-out slate:
 *   1. Read ML predictions (holdout_predictions.csv)
 *   2. Build ML portfolio via greedy + constraints
 *   3. Build Hermes-A portfolio
 *   4. Compute structural metrics for both (Mahalanobis, KS, archetype mix)
 *   5. Score both vs actuals — ROI
 *
 * Output: stage6_comparison.json + appended to report.md
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import {
  parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals,
} from '../parser';
import { getContestConfig } from '../rules';
import { productionSelect } from '../selection/production-selector';
import { precomputeComboFrequencies } from '../selection/combo-leverage';

const DIR = 'C:/Users/colin/dfs opto';
const ML_DIR = 'C:/Users/colin/Projects/dfs-optimizer/ml_lineup_classifier';
const N = 150;
const FEE = 20;
const QUANTILES = [0.10, 0.25, 0.50, 0.75, 0.90];
const METRICS = ['lineupOwn', 'lineupProjRatio', 'lineupCeilRatio', 'lineupOwnStd', 'lineupOwnPctile'] as const;

const HELD_OUT_SLATES = [
  { slate: '4-8-26',  proj: '4-8-26projections.csv',  actuals: '4-8-26actuals.csv',    pool: '4-8-26sspool.csv' },
  { slate: '4-21-26', proj: '4-21-26projections.csv', actuals: '4-21-26actuals.csv',   pool: '4-21-26sspool.csv' },
  { slate: '4-19-26', proj: '4-19-26projections.csv', actuals: '4-19-26actuals.csv',   pool: '4-19-26sspool.csv' },
  { slate: '4-24-26', proj: '4-24-26projections.csv', actuals: '4-24-26actuals.csv',   pool: '4-24-26sspool.csv' },
];

const HERMES_A = {
  lambda: 0.58, gamma: 5, tc: 0.26, mps: 4, me: 0.21, mep: 0.41, corner: true,
  comboPower: 4, fl: 0.00,
  bins: { chalk: 0.50, core: 0.30, value: 0.20, contra: 0.00, deep: 0.00 },
};

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function mean(a: number[]): number { if (!a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; }
function stddev(a: number[]): number { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); }
function quantilesOf(arr: number[], qs: number[]): number[] {
  const sorted = [...arr].sort((a, b) => a - b);
  return qs.map(q => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]);
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
function payoutFor(actual: number, sorted: number[], payoutTable: Float64Array, actuals: ContestActuals): number {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (sorted[m] >= actual) lo = m + 1; else hi = m; }
  const rank = Math.max(1, lo);
  const pay = rank <= payoutTable.length ? payoutTable[rank - 1] : 0;
  if (pay <= 0) return 0;
  let co = 0; for (const e of actuals.entries) if (Math.abs(e.actualPoints - actual) <= 0.25) co++;
  co = Math.max(0, co - 1);
  return pay / Math.sqrt(1 + co * 0.5);
}

interface SlateContext { optProj: number; optCeil: number; slateAvgOwn: number; ownPctile: Map<string, number>; }
function buildSlateContext(players: Player[], fieldLineups: Player[][]): SlateContext {
  let optProj = 0, optCeil = 0;
  for (const lu of fieldLineups) {
    let p = 0, c = 0;
    for (const pl of lu) { p += pl.projection || 0; c += (pl as any).ceiling || (pl.projection || 0) * 1.4; }
    if (p > optProj) optProj = p; if (c > optCeil) optCeil = c;
  }
  const slateAvgOwn = mean(players.map(p => p.ownership || 0));
  const ownPctile = new Map<string, number>();
  const sortedByOwn = [...players].sort((a, b) => (a.ownership || 0) - (b.ownership || 0));
  for (let i = 0; i < sortedByOwn.length; i++) ownPctile.set(sortedByOwn[i].id, sortedByOwn.length > 1 ? i / (sortedByOwn.length - 1) : 0);
  return { optProj, optCeil, slateAvgOwn, ownPctile };
}

function computeQuantiles(lineups: Player[][], ctx: SlateContext): Record<string, number[]> {
  const own: number[] = [], proj: number[] = [], ceil: number[] = [], ownStd: number[] = [], pctile: number[] = [];
  for (const players of lineups) {
    const owns = players.map(p => p.ownership || 0);
    own.push(mean(owns));
    proj.push(ctx.optProj > 0 ? players.reduce((s, p) => s + (p.projection || 0), 0) / ctx.optProj : 0);
    ceil.push(ctx.optCeil > 0 ? players.reduce((s, p) => s + ((p as any).ceiling || (p.projection || 0) * 1.4), 0) / ctx.optCeil : 0);
    ownStd.push(ctx.slateAvgOwn > 0 ? stddev(owns) / ctx.slateAvgOwn : 0);
    let ps = 0; for (const p of players) ps += ctx.ownPctile.get(p.id) || 0;
    pctile.push(ps / players.length);
  }
  return {
    lineupOwn: quantilesOf(own, QUANTILES),
    lineupProjRatio: quantilesOf(proj, QUANTILES),
    lineupCeilRatio: quantilesOf(ceil, QUANTILES),
    lineupOwnStd: quantilesOf(ownStd, QUANTILES),
    lineupOwnPctile: quantilesOf(pctile, QUANTILES),
  };
}

function ksDistance(a: number[], b: number[]): number {
  const sa = [...a].sort((x, y) => x - y); const sb = [...b].sort((x, y) => x - y);
  let maxD = 0, ai = 0, bi = 0;
  while (ai < sa.length && bi < sb.length) {
    const cdfA = (ai + 1) / sa.length, cdfB = (bi + 1) / sb.length;
    if (Math.abs(cdfA - cdfB) > maxD) maxD = Math.abs(cdfA - cdfB);
    if (sa[ai] < sb[bi]) ai++; else if (sa[ai] > sb[bi]) bi++; else { ai++; bi++; }
  }
  return maxD;
}

function getPrimaryTeam(players: Player[]): string | null {
  const counts = new Map<string, number>();
  for (const p of players) {
    if (p.positions?.includes('P')) continue;
    counts.set(p.team, (counts.get(p.team) || 0) + 1);
  }
  if (!counts.size) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

interface ScoredLineup {
  hash: string; lu: Lineup; score: number; primary: string | null; pidSet: Set<string>;
  hitterIds: Set<string>; pitcherIds: Set<string>;
}

function buildPortfolio(scored: ScoredLineup[], gamma = 5, teamCap = 0.26, maxExpHitter = 0.21, maxExpPitcher = 0.41): Lineup[] {
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const selected: Lineup[] = [];
  const selectedSets: Set<string>[] = [];
  const playerCount = new Map<string, number>();
  const teamCount = new Map<string, number>();
  const maxPerTeam = Math.max(1, Math.floor(N * teamCap));
  const capH = Math.ceil(maxExpHitter * N);
  const capP = Math.ceil(maxExpPitcher * N);
  const used = new Set<string>();

  function tryAdd(s: ScoredLineup, gammaLocal: number): boolean {
    if (selected.length >= N) return false;
    if (used.has(s.hash)) return false;
    for (const pid of s.hitterIds) if ((playerCount.get(pid) || 0) >= capH) return false;
    for (const pid of s.pitcherIds) if ((playerCount.get(pid) || 0) >= capP) return false;
    if (s.primary && (teamCount.get(s.primary) || 0) >= maxPerTeam) return false;
    for (const prev of selectedSets) {
      let inter = 0;
      for (const id of s.pidSet) if (prev.has(id)) { inter++; if (inter > gammaLocal) return false; }
    }
    selected.push(s.lu); selectedSets.push(s.pidSet); used.add(s.hash);
    for (const pid of s.pidSet) playerCount.set(pid, (playerCount.get(pid) || 0) + 1);
    if (s.primary) teamCount.set(s.primary, (teamCount.get(s.primary) || 0) + 1);
    return true;
  }

  for (const s of sorted) {
    if (selected.length >= N) break;
    tryAdd(s, gamma);
  }
  // Relax gamma if short
  for (const gRelax of [6, 7, 8]) {
    if (selected.length >= N) break;
    for (const s of sorted) {
      if (selected.length >= N) break;
      tryAdd(s, gRelax);
    }
  }
  return selected;
}

async function main() {
  const REPORT_LINES: string[] = [];
  const log = (m: string = '') => { console.log(m); REPORT_LINES.push(m); };

  log('# Stage 5/6 — ML Portfolio vs Hermes-A on Held-Out Slates');
  log('');

  // Load ML predictions
  if (!fs.existsSync(path.join(ML_DIR, 'holdout_predictions.csv'))) {
    log('ERROR: holdout_predictions.csv not found. Run run_pipeline.py first.');
    process.exit(1);
  }
  const predLines = fs.readFileSync(path.join(ML_DIR, 'holdout_predictions.csv'), 'utf-8').split(/\r?\n/);
  const predHeader = predLines[0].split(',');
  const predIdx = predHeader.indexOf('pred');
  const slateIdx = predHeader.indexOf('slate');
  const hashIdx = predHeader.indexOf('lineup_hash');
  const labelIdx = predHeader.indexOf('label');
  const predBySlate = new Map<string, Map<string, { pred: number; label: number }>>();
  for (let i = 1; i < predLines.length; i++) {
    if (!predLines[i]) continue;
    const c = predLines[i].split(',');
    const sl = c[slateIdx]; const h = c[hashIdx]; const p = parseFloat(c[predIdx]); const lb = parseInt(c[labelIdx]);
    if (!predBySlate.has(sl)) predBySlate.set(sl, new Map());
    predBySlate.get(sl)!.set(h, { pred: p, label: lb });
  }

  // Load consensus for Mahalanobis
  const cons = JSON.parse(fs.readFileSync(path.join(DIR, 'pro_consensus_quantile.json'), 'utf-8'));
  const consBySlate: Record<string, Record<string, { mean: number[]; std: number[] }>> = {};
  for (const m of METRICS) for (const sd of (cons.metrics[m] || [])) {
    if (!consBySlate[sd.slate]) consBySlate[sd.slate] = {};
    consBySlate[sd.slate][m] = { mean: sd.mean, std: sd.std };
  }

  const compResults: any[] = [];

  for (const s of HELD_OUT_SLATES) {
    const projPath = path.join(DIR, s.proj), actualsPath = path.join(DIR, s.actuals), poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) {
      log(`Skipping ${s.slate} (missing files)`);
      continue;
    }
    log(`### ${s.slate}`);
    log('');

    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);
    const idMap = new Map<string, Player>(); const nameMap = new Map<string, Player>();
    for (const p of pool.players) { idMap.set(p.id, p); nameMap.set(norm(p.name), p); }
    const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });

    // Field lineups for context
    const fieldLineups: Player[][] = [];
    for (const e of actuals.entries) {
      const pls: Player[] = []; let ok = true;
      for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
      if (ok) fieldLineups.push(pls);
    }
    const ctx = buildSlateContext(pool.players, fieldLineups);

    // Score lineups by ML model. We have predictions only for the lineups exported (top-5K + pros).
    // Score every lineup in pool: lookup hash → if present in pred, use pred; else 0.
    const slatePreds = predBySlate.get(s.slate);
    if (!slatePreds) { log(`No predictions for ${s.slate}`); continue; }
    const scored: ScoredLineup[] = [];
    for (const lu of loaded.lineups) {
      const pred = slatePreds.get(lu.hash);
      const score = pred ? pred.pred : 0;
      const primary = getPrimaryTeam(lu.players);
      const pidSet = new Set(lu.players.map(p => p.id));
      const hitterIds = new Set<string>(); const pitcherIds = new Set<string>();
      for (const p of lu.players) {
        if (p.positions?.includes('P')) pitcherIds.add(p.id);
        else hitterIds.add(p.id);
      }
      scored.push({ hash: lu.hash, lu, score, primary, pidSet, hitterIds, pitcherIds });
    }

    // ML portfolio
    const mlPortfolio = buildPortfolio(scored);
    log(`  ML portfolio size: ${mlPortfolio.length}`);

    // Hermes-A portfolio
    const comboFreq = precomputeComboFrequencies(loaded.lineups, HERMES_A.comboPower);
    const hermesResult = productionSelect(loaded.lineups, pool.players, {
      N, lambda: HERMES_A.lambda, comboFreq, maxOverlap: HERMES_A.gamma,
      teamCapPct: HERMES_A.tc, minPrimaryStack: HERMES_A.mps,
      maxExposure: HERMES_A.me, maxExposurePitcher: HERMES_A.mep,
      extremeCornerCap: HERMES_A.corner, projectionFloorPct: HERMES_A.fl,
      binAllocation: HERMES_A.bins,
    });
    const hPortfolio = hermesResult.portfolio;
    log(`  Hermes-A portfolio size: ${hPortfolio.length}`);

    // Quantile metrics
    const mlQ = computeQuantiles(mlPortfolio.map(lu => lu.players), ctx);
    const hQ = computeQuantiles(hPortfolio.map(lu => lu.players), ctx);
    const cn = consBySlate[s.slate];
    const computeDist = (q: Record<string, number[]>): number => {
      let sumSq = 0, n = 0;
      for (const m of METRICS) {
        const c = cn?.[m]; if (!c) continue;
        for (let qi = 0; qi < 5; qi++) {
          if (c.std[qi] < 1e-9) continue;
          const z = (q[m][qi] - c.mean[qi]) / c.std[qi];
          sumSq += z * z; n++;
        }
      }
      return n > 0 ? Math.sqrt(sumSq / n) : 0;
    };
    const mlDist = computeDist(mlQ);
    const hDist = computeDist(hQ);

    // KS distance vs pros (pool all pros for this slate)
    const PROS = [['nerdytenor'], ['zroth', 'zroth2'], ['youdacao'], ['shipmymoney'], ['shaidyadvice'], ['bgreseth'], ['needlunchmoney']];
    const allPro: Player[][] = [];
    for (const tokens of PROS) {
      for (const e of actuals.entries) {
        const en = (e.entryName || '').toLowerCase();
        if (!tokens.some(t => en.includes(t))) continue;
        const pls: Player[] = []; let ok = true;
        for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
        if (ok) allPro.push(pls);
      }
    }
    function rawValues(lineups: Player[][]): Record<string, number[]> {
      const own: number[] = [], proj: number[] = [], ceil: number[] = [], ownStd: number[] = [], pctile: number[] = [];
      for (const players of lineups) {
        const owns = players.map(p => p.ownership || 0);
        own.push(mean(owns));
        proj.push(ctx.optProj > 0 ? players.reduce((s, p) => s + (p.projection || 0), 0) / ctx.optProj : 0);
        ceil.push(ctx.optCeil > 0 ? players.reduce((s, p) => s + ((p as any).ceiling || (p.projection || 0) * 1.4), 0) / ctx.optCeil : 0);
        ownStd.push(ctx.slateAvgOwn > 0 ? stddev(owns) / ctx.slateAvgOwn : 0);
        let ps = 0; for (const p of players) ps += ctx.ownPctile.get(p.id) || 0;
        pctile.push(ps / players.length);
      }
      return { lineupOwn: own, lineupProjRatio: proj, lineupCeilRatio: ceil, lineupOwnStd: ownStd, lineupOwnPctile: pctile };
    }
    const proRaw = rawValues(allPro);
    const mlRaw = rawValues(mlPortfolio.map(lu => lu.players));
    const hRaw = rawValues(hPortfolio.map(lu => lu.players));
    const mlKs = (
      ksDistance(mlRaw.lineupOwn, proRaw.lineupOwn) + ksDistance(mlRaw.lineupProjRatio, proRaw.lineupProjRatio) +
      ksDistance(mlRaw.lineupCeilRatio, proRaw.lineupCeilRatio) + ksDistance(mlRaw.lineupOwnStd, proRaw.lineupOwnStd) +
      ksDistance(mlRaw.lineupOwnPctile, proRaw.lineupOwnPctile)
    ) / 5;
    const hKs = (
      ksDistance(hRaw.lineupOwn, proRaw.lineupOwn) + ksDistance(hRaw.lineupProjRatio, proRaw.lineupProjRatio) +
      ksDistance(hRaw.lineupCeilRatio, proRaw.lineupCeilRatio) + ksDistance(hRaw.lineupOwnStd, proRaw.lineupOwnStd) +
      ksDistance(hRaw.lineupOwnPctile, proRaw.lineupOwnPctile)
    ) / 5;

    // ROI: score against actuals
    const F = actuals.entries.length;
    const sortedDesc = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
    const payoutTable = buildPayoutTable(F);
    const actualByHash = new Map<string, number>();
    for (const e of actuals.entries) {
      const pls: Player[] = []; let ok = true;
      for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
      if (!ok) continue;
      actualByHash.set(pls.map(p => p.id).sort().join('|'), e.actualPoints);
    }
    function score(portfolio: Lineup[]): number {
      let total = 0;
      for (const lu of portfolio) {
        const h = lu.players.map(p => p.id).sort().join('|');
        let a = actualByHash.get(h);
        if (a === undefined) {
          let t = 0; let ok = true;
          for (const p of lu.players) {
            const r = actuals.playerActualsByName.get(norm(p.name));
            if (!r) { ok = false; break; }
            t += r.fpts;
          }
          if (!ok) continue;
          a = t;
        }
        total += payoutFor(a, sortedDesc, payoutTable, actuals);
      }
      return total;
    }
    const mlPay = score(mlPortfolio);
    const hPay = score(hPortfolio);
    const fee = N * FEE;
    const mlROI = (mlPay / fee - 1) * 100;
    const hROI = (hPay / fee - 1) * 100;

    log('');
    log('| Metric | ML | Hermes-A | Winner |');
    log('|---|---|---|---|');
    log(`| Mahalanobis distance | ${mlDist.toFixed(2)} | ${hDist.toFixed(2)} | ${mlDist < hDist ? 'ML' : 'Hermes-A'} |`);
    log(`| KS distance | ${mlKs.toFixed(3)} | ${hKs.toFixed(3)} | ${mlKs < hKs ? 'ML' : 'Hermes-A'} |`);
    log(`| ROI | ${mlROI.toFixed(0)}% | ${hROI.toFixed(0)}% | ${mlPay > hPay ? 'ML' : 'Hermes-A'} |`);
    log(`| Payout | $${mlPay.toFixed(0)} | $${hPay.toFixed(0)} |  |`);
    log('');

    compResults.push({
      slate: s.slate,
      mlDist, hDist, mlKs, hKs, mlPay, hPay, mlROI, hROI,
      mlSize: mlPortfolio.length, hSize: hPortfolio.length,
    });
  }

  // Aggregate
  log('');
  log('## Stage 6 Aggregate Comparison');
  log('');
  const mlDistWins = compResults.filter(r => r.mlDist < r.hDist).length;
  const mlROIWins = compResults.filter(r => r.mlROI > r.hROI).length;
  const totalMLPay = compResults.reduce((s, r) => s + r.mlPay, 0);
  const totalHPay = compResults.reduce((s, r) => s + r.hPay, 0);
  const totalFees = compResults.length * N * FEE;
  log(`Held-out slates evaluated: ${compResults.length}`);
  log(`ML beats Hermes on Mahalanobis: ${mlDistWins}/${compResults.length}`);
  log(`ML beats Hermes on ROI: ${mlROIWins}/${compResults.length}`);
  log(`ML total: $${totalMLPay.toFixed(0)} (ROI ${((totalMLPay / totalFees - 1) * 100).toFixed(1)}%)`);
  log(`Hermes-A total: $${totalHPay.toFixed(0)} (ROI ${((totalHPay / totalFees - 1) * 100).toFixed(1)}%)`);
  log('');
  log(`ML payout / Hermes payout ratio: ${(totalMLPay / Math.max(1, totalHPay) * 100).toFixed(1)}%`);
  log('');

  // Final ship/no-ship decision
  log('## Stage 7: Ship Decision');
  log('');
  const gateMahal = mlDistWins >= 3;
  const gatePay = totalMLPay >= 0.8 * totalHPay;
  log(`Gate: ML Mahalanobis better on ≥3 of 4 held-out slates: ${gateMahal ? '✅' : '❌'} (${mlDistWins}/4)`);
  log(`Gate: ML payout ≥ 80% of Hermes-A payout: ${gatePay ? '✅' : '❌'}  (${(totalMLPay / Math.max(1, totalHPay) * 100).toFixed(1)}%)`);
  log('');
  log('(Stages 1-4 gates checked in run_pipeline.py)');
  log('');

  fs.writeFileSync(path.join(ML_DIR, 'stage6_comparison.json'), JSON.stringify(compResults, null, 2));
  // Append to report
  const reportPath = path.join(ML_DIR, 'report.md');
  let existing = '';
  try { existing = fs.readFileSync(reportPath, 'utf-8'); } catch {}
  fs.writeFileSync(reportPath, existing + '\n\n---\n\n' + REPORT_LINES.join('\n'));
  console.log('\nStage 6 complete. Report appended to ' + reportPath);
}

main().catch(e => { console.error(e); process.exit(1); });
