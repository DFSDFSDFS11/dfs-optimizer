/**
 * Step 2: Local parametric search around the validated reference config:
 *   F:pure-chalk|p4|l0.58|g5|fl0.00|tc0.26|c1|mps4|me0.21|mep0.41
 *
 * Vary λ, γ, tc, me, mep, comboPower in small grid (~125 configs).
 * Keep archetype fixed: pure-chalk bins [50/30/20/0/0], mps=4, corner=ON, fl=0.
 * Rank by quantile Mahalanobis distance. Then full validation gate-check on top 5.
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
const QUANTILES = [0.10, 0.25, 0.50, 0.75, 0.90];
const METRICS = ['lineupOwn', 'lineupProjRatio', 'lineupCeilRatio', 'lineupOwnStd', 'lineupOwnPctile'] as const;

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
  { slate: '4-26-26', proj: '4-26-26projections.csv', actuals: '4-26-26actuals.csv',   pool: '4-26-26sspool.csv' },
  { slate: '4-27-26', proj: '4-27-26projections.csv', actuals: '4-27-26actuals.csv',   pool: '4-27-26sspool.csv' },
  { slate: '4-28-26', proj: '4-28-26projections.csv', actuals: '4-28-26actuals.csv',   pool: '4-28-26sspool.csv' },
];

const RECENT = new Set(['4-22-26', '4-23-26', '4-24-26', '4-25-26', '4-25-26-early', '4-26-26', '4-27-26', '4-28-26']);
const OOS = new Set(['4-23-26', '4-24-26', '4-25-26', '4-25-26-early', '4-26-26', '4-27-26', '4-28-26']);

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

interface SlateData {
  slate: string; candidates: Lineup[]; players: Player[]; ctx: SlateContext;
  comboFreq1: Map<string, number>; comboFreq2: Map<string, number>; comboFreq3: Map<string, number>; comboFreq4: Map<string, number>;
  actuals: ContestActuals; actualByHash: Map<string, number>; sorted: number[]; payoutTable: Float64Array; F: number;
  nameMap: Map<string, Player>;
}

async function loadSlate(s: typeof SLATES[0]): Promise<SlateData | null> {
  const projPath = path.join(DIR, s.proj), actualsPath = path.join(DIR, s.actuals), poolPath = path.join(DIR, s.pool);
  if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) return null;
  const pr = parseCSVFile(projPath, 'mlb', true);
  const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
  const pool = buildPlayerPool(pr.players, pr.detectedContestType);
  const actuals = parseContestActuals(actualsPath, config);
  const idMap = new Map<string, Player>(); const nameMap = new Map<string, Player>();
  for (const p of pool.players) { idMap.set(p.id, p); nameMap.set(norm(p.name), p); }
  const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
  const fieldLineups: Player[][] = [];
  for (const e of actuals.entries) {
    const pls: Player[] = []; let ok = true;
    for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
    if (ok) fieldLineups.push(pls);
  }
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
  return {
    slate: s.slate, candidates: loaded.lineups, players: pool.players,
    ctx: buildSlateContext(pool.players, fieldLineups),
    comboFreq1: precomputeComboFrequencies(loaded.lineups, 1),
    comboFreq2: precomputeComboFrequencies(loaded.lineups, 2),
    comboFreq3: precomputeComboFrequencies(loaded.lineups, 3),
    comboFreq4: precomputeComboFrequencies(loaded.lineups, 4),
    actuals, actualByHash, sorted, payoutTable, F, nameMap,
  };
}

function getCombo(sd: SlateData, power: number) {
  if (power === 1) return sd.comboFreq1;
  if (power === 2) return sd.comboFreq2;
  if (power === 4) return sd.comboFreq4;
  return sd.comboFreq3;
}

function scoreLineup(lu: Lineup, sd: SlateData): number | null {
  const h = lu.players.map(p => p.id).sort().join('|');
  const fa = sd.actualByHash.get(h);
  if (fa !== undefined) return fa;
  let t = 0; for (const p of lu.players) {
    const r = sd.actuals.playerActualsByName.get(norm(p.name));
    if (!r) return null; t += r.fpts;
  }
  return t;
}

interface CfgRow {
  id: string;
  cfg: { lambda: number; gamma: number; tc: number; mps: number; me: number; mep: number; comboPower: number; corner: boolean; fl: number; bins: any };
  meanDist: number;
  meanKsAvg: number;
  fullPay17: number;
  fullROI17: number;
  oosPay7: number;
  oosROI7: number;
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

async function main() {
  console.log('=== STEP 2: LOCAL SEARCH around F:pure-chalk|p4|l0.58|g5|tc0.26|mps4|me0.21|mep0.41 ===\n');

  const cons = JSON.parse(fs.readFileSync(path.join(DIR, 'pro_consensus_quantile.json'), 'utf-8'));
  const consBySlate: Record<string, Record<string, { mean: number[]; std: number[] }>> = {};
  for (const m of METRICS) {
    for (const sd of (cons.metrics[m] || [])) {
      if (!consBySlate[sd.slate]) consBySlate[sd.slate] = {};
      consBySlate[sd.slate][m] = { mean: sd.mean, std: sd.std };
    }
  }

  console.log('Loading slates...');
  const cache: SlateData[] = [];
  for (const s of SLATES) { const sd = await loadSlate(s); if (sd) cache.push(sd); }
  console.log(cache.length + ' slates loaded.\n');

  // Pro raw values per slate (pooled, for KS)
  const PROS_LIST = [['nerdytenor'], ['zroth', 'zroth2'], ['youdacao'], ['shipmymoney'], ['shaidyadvice'], ['bgreseth'], ['needlunchmoney']];
  const proRawBySlate = new Map<string, Record<string, number[]>>();
  for (const sd of cache) {
    const allPro: Player[][] = [];
    for (const tokens of PROS_LIST) {
      for (const e of sd.actuals.entries) {
        const en = (e.entryName || '').toLowerCase();
        if (!tokens.some(t => en.includes(t))) continue;
        const pls: Player[] = []; let ok = true;
        for (const nm of e.playerNames) { const p = sd.nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
        if (ok) allPro.push(pls);
      }
    }
    if (allPro.length < 100) continue;
    const own: number[] = [], proj: number[] = [], ceil: number[] = [], ownStd: number[] = [], pctile: number[] = [];
    for (const players of allPro) {
      const owns = players.map(p => p.ownership || 0);
      own.push(mean(owns));
      proj.push(sd.ctx.optProj > 0 ? players.reduce((s, p) => s + (p.projection || 0), 0) / sd.ctx.optProj : 0);
      ceil.push(sd.ctx.optCeil > 0 ? players.reduce((s, p) => s + ((p as any).ceiling || (p.projection || 0) * 1.4), 0) / sd.ctx.optCeil : 0);
      ownStd.push(sd.ctx.slateAvgOwn > 0 ? stddev(owns) / sd.ctx.slateAvgOwn : 0);
      let ps = 0; for (const p of players) ps += sd.ctx.ownPctile.get(p.id) || 0;
      pctile.push(ps / players.length);
    }
    proRawBySlate.set(sd.slate, { lineupOwn: own, lineupProjRatio: proj, lineupCeilRatio: ceil, lineupOwnStd: ownStd, lineupOwnPctile: pctile });
  }

  // Generate local-search grid (all combos around reference)
  const lambdas = [0.46, 0.52, 0.58, 0.64, 0.70];        // ±20% around 0.58
  const gammas = [4, 5, 6];                                // 5 ± 1 (γ is integer)
  const tcs = [0.21, 0.235, 0.26, 0.285, 0.31];           // ±20% around 0.26
  const mes = [0.17, 0.21, 0.25];                          // 0.21 ± 0.04
  const meps = [0.33, 0.41, 0.49];                         // 0.41 ± 0.08
  const powers = [3, 4];                                    // 4 and 3 nearby

  // Build all combos
  const grid: any[] = [];
  for (const lambda of lambdas) for (const gamma of gammas) for (const tc of tcs) for (const me of mes) for (const mep of meps) for (const comboPower of powers) {
    grid.push({
      lambda, gamma, tc, me, mep, comboPower,
      mps: 4, corner: true, fl: 0.00,
      bins: { chalk: 0.50, core: 0.30, value: 0.20, contra: 0.00, deep: 0.00 },
    });
  }
  console.log('Grid size: ' + grid.length + ' configs');

  const t_start = Date.now();
  const results: CfgRow[] = [];
  for (let i = 0; i < grid.length; i++) {
    const cfg = grid[i];
    const distsBySlate: number[] = []; const ksBySlate: number[] = [];
    let fullPay17 = 0, oosPay7 = 0;
    let oosCount = 0;
    for (const sd of cache) {
      try {
        const result = productionSelect(sd.candidates, sd.players, {
          N, lambda: cfg.lambda, comboFreq: getCombo(sd, cfg.comboPower), maxOverlap: cfg.gamma,
          teamCapPct: cfg.tc, minPrimaryStack: cfg.mps,
          maxExposure: cfg.me, maxExposurePitcher: cfg.mep,
          extremeCornerCap: cfg.corner, projectionFloorPct: cfg.fl,
          binAllocation: cfg.bins,
        });
        const lineups: Player[][] = result.portfolio.map(lu => lu.players);
        const hQ = computeQuantiles(lineups, sd.ctx);
        let totalSq = 0, n = 0;
        for (const m of METRICS) {
          const cn = consBySlate[sd.slate]?.[m]; if (!cn) continue;
          for (let qi = 0; qi < 5; qi++) {
            if (cn.std[qi] < 1e-9) continue;
            const z = (hQ[m][qi] - cn.mean[qi]) / cn.std[qi];
            totalSq += z * z; n++;
          }
        }
        if (n > 0) distsBySlate.push(Math.sqrt(totalSq / n));

        // KS
        const proRaw = proRawBySlate.get(sd.slate);
        if (proRaw) {
          const own: number[] = [], proj: number[] = [], ceil: number[] = [], ownStd: number[] = [], pctile: number[] = [];
          for (const players of lineups) {
            const owns = players.map(p => p.ownership || 0);
            own.push(mean(owns));
            proj.push(sd.ctx.optProj > 0 ? players.reduce((s, p) => s + (p.projection || 0), 0) / sd.ctx.optProj : 0);
            ceil.push(sd.ctx.optCeil > 0 ? players.reduce((s, p) => s + ((p as any).ceiling || (p.projection || 0) * 1.4), 0) / sd.ctx.optCeil : 0);
            ownStd.push(sd.ctx.slateAvgOwn > 0 ? stddev(owns) / sd.ctx.slateAvgOwn : 0);
            let ps = 0; for (const p of players) ps += sd.ctx.ownPctile.get(p.id) || 0;
            pctile.push(ps / players.length);
          }
          const ks = (
            ksDistance(own, proRaw.lineupOwn) + ksDistance(proj, proRaw.lineupProjRatio) +
            ksDistance(ceil, proRaw.lineupCeilRatio) + ksDistance(ownStd, proRaw.lineupOwnStd) +
            ksDistance(pctile, proRaw.lineupOwnPctile)
          ) / 5;
          ksBySlate.push(ks);
        }

        // Score for ROI
        let pay = 0;
        for (const lu of result.portfolio) {
          const a = scoreLineup(lu, sd);
          if (a === null) continue;
          pay += payoutFor(a, sd.sorted, sd.payoutTable, sd.actuals);
        }
        fullPay17 += pay;
        if (OOS.has(sd.slate)) { oosPay7 += pay; oosCount++; }
      } catch {}
    }
    const meanDist = distsBySlate.length > 0 ? mean(distsBySlate) : Infinity;
    const meanKsAvg = ksBySlate.length > 0 ? mean(ksBySlate) : Infinity;
    const fullROI17 = (fullPay17 / (cache.length * N * FEE) - 1) * 100;
    const oosROI7 = oosCount > 0 ? (oosPay7 / (oosCount * N * FEE) - 1) * 100 : 0;
    results.push({
      id: 'L:l' + cfg.lambda + '|g' + cfg.gamma + '|tc' + cfg.tc + '|me' + cfg.me + '|mep' + cfg.mep + '|p' + cfg.comboPower,
      cfg, meanDist, meanKsAvg, fullPay17, fullROI17, oosPay7, oosROI7,
    });

    if ((i + 1) % 100 === 0) {
      const elapsed = (Date.now() - t_start) / 60000;
      const rate = (i + 1) / elapsed;
      const remain = (grid.length - i - 1) / rate;
      console.log('  [' + (i + 1) + '/' + grid.length + ' ' + ((i + 1) / grid.length * 100).toFixed(0) + '%, ' + elapsed.toFixed(1) + 'm, ETA ' + remain.toFixed(0) + 'm]');
    }
  }

  console.log('\nDone in ' + ((Date.now() - t_start) / 60000).toFixed(1) + ' min.\n');

  // Reference for comparison: actual sweep config
  const REFERENCE = { meanDist: 1.46, meanKsAvg: 0.188, fullROI17: 136, oosROI7: 186, label: 'F:pure-chalk|p4|l0.58|g5|tc0.26|mps4|me0.21|mep0.41' };
  console.log('Reference (sweep config): d=' + REFERENCE.meanDist + ' ks=' + REFERENCE.meanKsAvg + ' ROI17=' + REFERENCE.fullROI17 + '% OOS5=' + REFERENCE.oosROI7 + '%\n');

  console.log('=== TOP 15 BY MAHALANOBIS DISTANCE ===');
  const byDist = [...results].sort((a, b) => a.meanDist - b.meanDist).slice(0, 15);
  for (const r of byDist) {
    console.log('  d=' + r.meanDist.toFixed(3) + ' ks=' + r.meanKsAvg.toFixed(3) + ' ROI17=' + r.fullROI17.toFixed(0).padStart(4) + '% OOS7=' + r.oosROI7.toFixed(0).padStart(4) + '% | ' + r.id);
  }

  console.log('\n=== TOP 15 BY KS DISTANCE ===');
  const byKs = [...results].sort((a, b) => a.meanKsAvg - b.meanKsAvg).slice(0, 15);
  for (const r of byKs) {
    console.log('  ks=' + r.meanKsAvg.toFixed(3) + ' d=' + r.meanDist.toFixed(3) + ' ROI17=' + r.fullROI17.toFixed(0).padStart(4) + '% OOS7=' + r.oosROI7.toFixed(0).padStart(4) + '% | ' + r.id);
  }

  console.log('\n=== TOP 15 BY DUAL GATE: dist < 1.45 AND ROI17 ≥ 50% ===');
  const dual = results.filter(r => r.meanDist < 1.45 && r.fullROI17 >= 50 && r.fullROI17 <= 250).sort((a, b) => a.meanDist - b.meanDist);
  console.log('  count: ' + dual.length);
  for (const r of dual.slice(0, 15)) {
    console.log('  d=' + r.meanDist.toFixed(3) + ' ks=' + r.meanKsAvg.toFixed(3) + ' ROI17=' + r.fullROI17.toFixed(0).padStart(4) + '% OOS7=' + r.oosROI7.toFixed(0).padStart(4) + '% | ' + r.id);
  }

  // Save winner
  const winner = dual.length > 0 ? dual[0] : byDist[0];
  console.log('\n=== STEP 2 WINNER ===');
  console.log('  id: ' + winner.id);
  console.log('  cfg: λ=' + winner.cfg.lambda + ' γ=' + winner.cfg.gamma + ' tc=' + winner.cfg.tc + ' mps=' + winner.cfg.mps + ' me=' + winner.cfg.me + ' mep=' + winner.cfg.mep + ' power=' + winner.cfg.comboPower + ' corner=' + winner.cfg.corner);
  console.log('  Mahalanobis dist: ' + winner.meanDist.toFixed(3) + ' (vs reference 1.46, vs Hermes V1 1.50)');
  console.log('  KS distance:      ' + winner.meanKsAvg.toFixed(3) + ' (vs reference 0.188, vs Hermes V1 0.186)');
  console.log('  Full17 ROI:       ' + winner.fullROI17.toFixed(1) + '%');
  console.log('  OOS7 ROI:         ' + winner.oosROI7.toFixed(1) + '%');

  fs.writeFileSync(path.join(DIR, 'hermes_local_search.json'), JSON.stringify(results, null, 0));
  console.log('\nResults saved to hermes_local_search.json');
}

main().catch(e => { console.error(e); process.exit(1); });
