/**
 * HERMES validation — sanity-check the synthesized parametric config from the
 * d<1.3 cluster modal/median values. Run on all 17 slates, verify:
 *   - ROI in +50% to +150% range (cluster expectation)
 *   - Bin fills match 50/30/20/0/0 target
 *   - Mahalanobis distance lands in d<1.3 zone
 *   - avgPlayerOwnPctile near pros' 0.94
 *   - Per-slate structural metrics match consensus
 *
 * Hermes config (synthesized from cluster, NOT from any single sweep config):
 *   λ=0.58, γ=6, tc=0.20, mps=4, me=0.21, mep=0.45, corner=ON
 *   comboPower=4, fl=0.00, bins=[0.50, 0.30, 0.20, 0.00, 0.00]
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
const N = 150;
const FEE = 20;

const HERMES = {
  lambda: 0.58,
  gamma: 6,
  tc: 0.20,
  mps: 4,
  me: 0.21,
  mep: 0.45,
  corner: true,
  comboPower: 4,
  fl: 0.00,
  bins: { chalk: 0.50, core: 0.30, value: 0.20, contra: 0.00, deep: 0.00 },
};

const SLATES = [
  { slate: '4-6-26',  proj: '4-6-26_projections.csv', actuals: 'dkactuals 4-6-26.csv', pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26',  proj: '4-8-26projections.csv',  actuals: '4-8-26actuals.csv',    pool: '4-8-26sspool.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv', actuals: '4-12-26actuals.csv',   pool: '4-12-26sspool.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv', actuals: '4-14-26actuals.csv',   pool: '4-14-26sspool.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv', actuals: '4-15-26actuals.csv',   pool: '4-15-26sspool.csv' },
  { slate: '4-17-26', proj: '4-17-26projections.csv', actuals: '4-17-26actuals.csv',   pool: '4-17-26sspool.csv' },
  { slate: '4-18-26', proj: '4-18-26projections.csv', actuals: '4-18-26actuals.csv',   pool: '4-18-26sspool.csv' },
  { slate: '4-19-26', proj: '4-19-26projections.csv', actuals: '4-19-26actuals.csv',   pool: '4-19-26sspool.csv' },
  { slate: '4-20-26', proj: '4-20-26projections.csv', actuals: '4-20-26actuals.csv',   pool: '4-20-26sspool.csv' },
  { slate: '4-21-26', proj: '4-21-26projections.csv', actuals: '4-21-26actuals.csv',   pool: '4-21-26sspool.csv' },
  { slate: '4-22-26', proj: '4-22-26projections.csv', actuals: '4-22-26actuals.csv',   pool: '4-22-26sspool.csv' },
  { slate: '4-23-26', proj: '4-23-26projections.csv', actuals: '4-23-26actuals.csv',   pool: '4-23-26sspool.csv' },
  { slate: '4-24-26', proj: '4-24-26projections.csv', actuals: '4-24-26actuals.csv',   pool: '4-24-26sspool.csv' },
  { slate: '4-25-26', proj: '4-25-26projections.csv', actuals: '4-25-26actuals.csv',   pool: '4-25-26sspool.csv' },
  { slate: '4-25-26-early', proj: '4-25-26projectionsearly.csv', actuals: '4-25-26actualsearly.csv', pool: '4-25-26sspoolearly.csv' },
  { slate: '4-26-26', proj: '4-26-26projections.csv', actuals: '4-26-26actuals.csv', pool: '4-26-26sspool.csv' },
  { slate: '4-27-26', proj: '4-27-26projections.csv', actuals: '4-27-26actuals.csv', pool: '4-27-26sspool.csv' },
  { slate: '4-28-26', proj: '4-28-26projections.csv', actuals: '4-28-26actuals.csv', pool: '4-28-26sspool.csv' },
];

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function mean(a: number[]): number { if (!a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; }
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

async function main() {
  console.log('================================================================');
  console.log('HERMES VALIDATION');
  console.log('  λ=' + HERMES.lambda + ' γ=' + HERMES.gamma + ' tc=' + HERMES.tc + ' mps=' + HERMES.mps);
  console.log('  bins=' + JSON.stringify(HERMES.bins) + ' comboPower=' + HERMES.comboPower);
  console.log('  corner=' + HERMES.corner + ' fl=' + HERMES.fl);
  console.log('================================================================\n');

  // Load consensus
  const consensus = JSON.parse(fs.readFileSync(path.join(DIR, 'pro_consensus_slate_relative.json'), 'utf-8'));
  const consBySlate: Record<string, Record<string, { mean: number; std: number }>> = {};
  for (const k of ['projRatioToOptimal', 'ceilingRatioToOptimal', 'avgPlayerOwnPctile', 'ownStdRatio', 'ownDeltaFromAnchor']) {
    for (const entry of (consensus.metrics[k] || [])) {
      if (!consBySlate[entry.slate]) consBySlate[entry.slate] = {};
      consBySlate[entry.slate][k] = { mean: entry.mean, std: entry.std };
    }
  }

  console.log('Slate         | ROI    | binFills(C/Co/V/Ct/D) | meanProj | meanOwn | ownPctile | dist | passes?');
  let totalWin = 0, totalFee = 0;
  let totalDist = 0, distCount = 0;
  const allBinFills: { chalk: number; core: number; value: number; contra: number; deep: number }[] = [];
  const allOwnPctiles: number[] = [];

  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj), actualsPath = path.join(DIR, s.actuals), poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) continue;
    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);
    const idMap = new Map<string, Player>(); const nameMap = new Map<string, Player>();
    for (const p of pool.players) { idMap.set(p.id, p); nameMap.set(norm(p.name), p); }
    const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
    const comboFreq = precomputeComboFrequencies(loaded.lineups, HERMES.comboPower);
    const F = actuals.entries.length;
    const sorted = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
    const payoutTable = buildPayoutTable(F);
    const actualByHash = new Map<string, number>();
    for (const e of actuals.entries) {
      const pls: Player[] = []; let ok = true;
      for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
      if (!ok) continue;
      actualByHash.set(pls.map(p => p.id).sort().join('|'), e.actualPoints);
    }

    const result = productionSelect(loaded.lineups, pool.players, {
      N, lambda: HERMES.lambda, comboFreq, maxOverlap: HERMES.gamma,
      teamCapPct: HERMES.tc, minPrimaryStack: HERMES.mps,
      maxExposure: HERMES.me, maxExposurePitcher: HERMES.mep,
      extremeCornerCap: HERMES.corner, projectionFloorPct: HERMES.fl,
      binAllocation: HERMES.bins,
    });
    const lineups = result.portfolio;

    // Score (with per-player fallback for synthetic lineups not in field)
    let pay = 0;
    for (const lu of lineups) {
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
      pay += payoutFor(a, sorted, payoutTable, actuals);
    }
    totalWin += pay;
    totalFee += FEE * N;
    const roi = ((pay / (FEE * N)) - 1) * 100;

    // Bin fills
    const binFills = { chalk: 0, core: 0, value: 0, contra: 0, deep: 0 };
    for (const [b, c] of result.binFills) (binFills as any)[b] = c;
    allBinFills.push(binFills);

    // Slate-relative metrics
    // Compute optimal proj/ceiling, chalk anchor from field
    const fieldLineupsResolved: Player[][] = [];
    for (const e of actuals.entries) {
      const pls: Player[] = []; let ok = true;
      for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
      if (ok) fieldLineupsResolved.push(pls);
    }
    let optProj = 0, optCeil = 0;
    const lineupOwn: number[] = [];
    for (const lu of fieldLineupsResolved) {
      let p = 0, c = 0, o = 0;
      for (const pl of lu) {
        p += pl.projection || 0;
        c += (pl as any).ceiling || (pl.projection || 0) * 1.4;
        o += pl.ownership || 0;
      }
      if (p > optProj) optProj = p;
      if (c > optCeil) optCeil = c;
      lineupOwn.push(o / lu.length);
    }
    lineupOwn.sort((a, b) => b - a);
    const chalkAnchor = mean(lineupOwn.slice(0, Math.min(100, lineupOwn.length)));
    const slateAvgOwn = mean(pool.players.map(p => p.ownership || 0));
    const ownPctileById = new Map<string, number>();
    const sortedByOwn = [...pool.players].sort((a, b) => (a.ownership || 0) - (b.ownership || 0));
    for (let i = 0; i < sortedByOwn.length; i++) ownPctileById.set(sortedByOwn[i].id, sortedByOwn.length > 1 ? i / (sortedByOwn.length - 1) : 0);

    // Hermes lineups metrics
    const hProjs: number[] = [], hCeils: number[] = [], hOwns: number[] = [], hOwnStds: number[] = [], hPctiles: number[] = [];
    for (const lu of lineups) {
      const pl = lu.players;
      const owns = pl.map(p => p.ownership || 0);
      hOwns.push(mean(owns));
      hProjs.push(pl.reduce((s, p) => s + (p.projection || 0), 0));
      hCeils.push(pl.reduce((s, p) => s + ((p as any).ceiling || (p.projection || 0) * 1.4), 0));
      hOwnStds.push(stddev(owns));
      let ps = 0; for (const p of pl) ps += ownPctileById.get(p.id) || 0;
      hPctiles.push(ps / pl.length);
    }
    const m = {
      projRatioToOptimal: optProj > 0 ? mean(hProjs) / optProj : 0,
      ceilingRatioToOptimal: optCeil > 0 ? mean(hCeils) / optCeil : 0,
      avgPlayerOwnPctile: mean(hPctiles),
      ownStdRatio: slateAvgOwn > 0 ? mean(hOwnStds) / slateAvgOwn : 0,
      ownDeltaFromAnchor: mean(hOwns) - chalkAnchor,
    };
    allOwnPctiles.push(m.avgPlayerOwnPctile);

    const cons = consBySlate[s.slate];
    let dist = 0; let nm2 = 0;
    if (cons) {
      for (const k of ['projRatioToOptimal', 'ceilingRatioToOptimal', 'avgPlayerOwnPctile', 'ownStdRatio', 'ownDeltaFromAnchor'] as const) {
        const c = cons[k]; if (!c || c.std < 1e-9) continue;
        const d = ((m as any)[k] - c.mean) / c.std;
        dist += d * d; nm2++;
      }
      if (nm2 > 0) { dist = Math.sqrt(dist / nm2); totalDist += dist; distCount++; }
    }

    const binStr = `${binFills.chalk}/${binFills.core}/${binFills.value}/${binFills.contra}/${binFills.deep}`;
    const passes = lineups.length === N && dist < 1.5 && Math.abs(m.avgPlayerOwnPctile - 0.94) < 0.10 ? '✅' : (dist < 2.0 ? '🟡' : '❌');
    console.log('  ' + s.slate.padEnd(15) + (roi.toFixed(0) + '%').padStart(6) + '  | ' + binStr.padEnd(20) + ' | ' + mean(hProjs).toFixed(1).padStart(7) + '  | ' + mean(hOwns).toFixed(2).padStart(6) + '% | ' + m.avgPlayerOwnPctile.toFixed(3).padStart(7) + '  | ' + dist.toFixed(2).padStart(4) + ' | ' + passes);
  }

  console.log();
  console.log('================================================================');
  console.log('HERMES SUMMARY');
  console.log('================================================================');
  console.log('  Total winnings: $' + totalWin.toFixed(0));
  console.log('  Total fees:     $' + totalFee.toFixed(0));
  console.log('  ROI:            ' + ((totalWin / totalFee - 1) * 100).toFixed(1) + '%');
  console.log('  Mean Mahalanobis dist: ' + (totalDist / distCount).toFixed(2) + '  (cluster zone is d<1.5)');
  console.log();
  console.log('  Avg bin fills (target 75/45/30/0/0 at N=150):');
  const meanBins = {
    chalk: mean(allBinFills.map(b => b.chalk)),
    core: mean(allBinFills.map(b => b.core)),
    value: mean(allBinFills.map(b => b.value)),
    contra: mean(allBinFills.map(b => b.contra)),
    deep: mean(allBinFills.map(b => b.deep)),
  };
  console.log('    chalk=' + meanBins.chalk.toFixed(0) + '  core=' + meanBins.core.toFixed(0) + '  value=' + meanBins.value.toFixed(0) + '  contra=' + meanBins.contra.toFixed(0) + '  deep=' + meanBins.deep.toFixed(0));
  console.log('  Avg ownership percentile: ' + mean(allOwnPctiles).toFixed(3) + '  (pros: 0.935)');
  console.log();
  console.log('  GATES:');
  const roi = (totalWin / totalFee - 1) * 100;
  console.log('    ROI in [+50%, +150%] cluster range: ' + (roi >= 50 && roi <= 150 ? '✅ ' + roi.toFixed(0) + '%' : '⚠️  ' + roi.toFixed(0) + '% (out of expected range)'));
  console.log('    Mean dist < 1.5: ' + ((totalDist / distCount) < 1.5 ? '✅' : '❌') + ' (' + (totalDist / distCount).toFixed(2) + ')');
  console.log('    Avg ownership pctile within 0.10 of pros (0.94): ' + (Math.abs(mean(allOwnPctiles) - 0.94) < 0.10 ? '✅' : '❌') + ' (' + mean(allOwnPctiles).toFixed(3) + ')');
}

main().catch(e => { console.error(e); process.exit(1); });
