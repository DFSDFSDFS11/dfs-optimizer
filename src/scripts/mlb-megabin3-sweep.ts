/**
 * MLB Mega Bin Sweep V3 — 100K configs on full 16-slate set with INTEGRATED
 * dispersion metrics (no separate analysis pass needed).
 *
 * NEW dimensions vs V2:
 *   - minPrimaryStack 4/5 (DK MLB rule: max 5-hitter primary stack)
 *   - γ stricter range: 3, 4, 5 (force lineup uniqueness)
 *   - Extreme λ range up to 2.0
 *   - Tighter maxExposure 0.08-0.20
 *   - Tighter teamCap variations
 *   - Joint constraint variations
 *
 * Per-config metrics computed and stored:
 *   - full16, recentPay, t1, profitable
 *   - meanIqrFrac (rank dispersion)
 *   - meanPctTop25, meanPctMid50, meanPctBot25
 *   - cashRate, t1Rate
 *   - stdAcrossSlates (consistency)
 *   - worstSlatePay (downside floor)
 *
 * Outputs JSON + MD. Total runtime budget: 7 hours.
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
import { computeAnchor } from '../selection/anchor-relative';

const DIR = 'C:/Users/colin/dfs opto';
const OUT_JSON = path.join(DIR, 'mlb_megabin3_sweep.json');
const OUT_MD = path.join(DIR, 'mlb_megabin3_sweep.md');
const FEE = 20;
const N = 150;

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
];
const RECENT = new Set(['4-22-26', '4-23-26', '4-24-26', '4-25-26', '4-25-26-early', '4-26-26']);
const OOS = new Set(['4-23-26', '4-24-26', '4-25-26', '4-25-26-early', '4-26-26']);

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
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
function scoreLineup(lu: Lineup, actuals: ContestActuals, actualByHash: Map<string, number>): number | null {
  const h = lu.players.map(p => p.id).sort().join('|'); const fa = actualByHash.get(h);
  if (fa !== undefined) return fa;
  let t = 0; for (const p of lu.players) { const r = actuals.playerActualsByName.get(norm(p.name)); if (!r) return null; t += r.fpts; }
  return t;
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
function rankOf(actual: number, sortedDesc: number[]): number {
  let lo = 0, hi = sortedDesc.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (sortedDesc[m] >= actual) lo = m + 1; else hi = m; }
  return Math.max(1, lo);
}

interface SlateData {
  slate: string;
  candidates: Lineup[];
  players: Player[];
  comboFreq: Map<string, number>;
  comboFreq1: Map<string, number>;
  comboFreq2: Map<string, number>;
  comboFreq4: Map<string, number>;
  actuals: ContestActuals;
  actualByHash: Map<string, number>;
  sorted: number[];
  top1Thresh: number;
  cashThresh: number;
  payoutTable: Float64Array;
  F: number;
  anchor: ReturnType<typeof computeAnchor>;
}

async function loadSlate(s: typeof SLATES[0]): Promise<SlateData | null> {
  const projPath = path.join(DIR, s.proj); const actualsPath = path.join(DIR, s.actuals); const poolPath = path.join(DIR, s.pool);
  if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) return null;
  const pr = parseCSVFile(projPath, 'mlb', true);
  const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
  const pool = buildPlayerPool(pr.players, pr.detectedContestType);
  const actuals = parseContestActuals(actualsPath, config);
  const idMap = new Map<string, Player>(); const nameMap = new Map<string, Player>();
  for (const p of pool.players) { idMap.set(p.id, p); nameMap.set(norm(p.name), p); }
  const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
  const F = actuals.entries.length;
  const sorted = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
  const top1Thresh = sorted[Math.max(0, Math.floor(F * 0.01) - 1)] || 0;
  const cashThresh = sorted[Math.max(0, Math.floor(F * 0.22) - 1)] || 0;
  const payoutTable = buildPayoutTable(F);
  const actualByHash = new Map<string, number>();
  for (const e of actuals.entries) {
    const pls: Player[] = []; let ok = true;
    for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
    if (!ok) continue;
    actualByHash.set(pls.map(p => p.id).sort().join('|'), e.actualPoints);
  }
  const comboFreq = precomputeComboFrequencies(loaded.lineups, 3);
  const comboFreq1 = precomputeComboFrequencies(loaded.lineups, 1);
  const comboFreq2 = precomputeComboFrequencies(loaded.lineups, 2);
  const comboFreq4 = precomputeComboFrequencies(loaded.lineups, 4);
  const anchor = computeAnchor(loaded.lineups, 50);
  return { slate: s.slate, candidates: loaded.lineups, players: pool.players, comboFreq, comboFreq1, comboFreq2, comboFreq4, actuals, actualByHash, sorted, top1Thresh, cashThresh, payoutTable, F, anchor };
}

const getCombo = (sd: SlateData, power?: number) => {
  if (power === 1) return sd.comboFreq1;
  if (power === 2) return sd.comboFreq2;
  if (power === 4) return sd.comboFreq4;
  return sd.comboFreq;
};

interface ConfigResult {
  id: string;
  cfg: any;
  fullPay: number;
  recentPay: number;
  oosPay: number;
  t1: number;
  cash: number;
  scored: number;
  profitable: number;
  meanIqrFrac: number;
  meanPctTop25: number;
  meanPctMid50: number;
  meanPctBot25: number;
  stdAcrossSlates: number;
  worstSlate: number;
  perSlate: { slate: string; pay: number; t1: number }[];
}

function evaluateConfig(id: string, cfg: any, runCfgFactory: (sd: SlateData) => Parameters<typeof productionSelect>[2], cache: SlateData[]): ConfigResult {
  const perSlate: { slate: string; pay: number; t1: number }[] = [];
  let fullPay = 0, recentPay = 0, oosPay = 0, t1 = 0, cash = 0, scored = 0, profitable = 0;
  let sumIqrFrac = 0, sumTop25 = 0, sumMid50 = 0, sumBot25 = 0;
  let nValidSlates = 0;

  for (const sd of cache) {
    let result;
    try {
      result = productionSelect(sd.candidates, sd.players, runCfgFactory(sd));
    } catch {
      perSlate.push({ slate: sd.slate, pay: 0, t1: 0 });
      continue;
    }
    let slatePay = 0, slateT1 = 0, slateCash = 0, slateScored = 0;
    const ranks: number[] = [];
    for (const lu of result.portfolio) {
      const a = scoreLineup(lu, sd.actuals, sd.actualByHash); if (a === null) continue;
      slateScored++;
      slatePay += payoutFor(a, sd.sorted, sd.payoutTable, sd.actuals);
      if (a >= sd.top1Thresh) slateT1++;
      if (a >= sd.cashThresh) slateCash++;
      ranks.push(rankOf(a, sd.sorted));
    }
    perSlate.push({ slate: sd.slate, pay: slatePay, t1: slateT1 });
    fullPay += slatePay; t1 += slateT1; cash += slateCash; scored += slateScored;
    if (slatePay > FEE * N) profitable++;
    if (RECENT.has(sd.slate)) recentPay += slatePay;
    if (OOS.has(sd.slate)) oosPay += slatePay;
    if (ranks.length >= 30) {
      ranks.sort((a, b) => a - b);
      const F = sd.F;
      const q1 = ranks[Math.floor(ranks.length * 0.25)];
      const q3 = ranks[Math.floor(ranks.length * 0.75)];
      const iqr = q3 - q1;
      const top25Thresh = F * 0.25;
      const mid75Thresh = F * 0.75;
      let topCnt = 0, midCnt = 0, botCnt = 0;
      for (const r of ranks) {
        if (r <= top25Thresh) topCnt++;
        else if (r <= mid75Thresh) midCnt++;
        else botCnt++;
      }
      sumIqrFrac += iqr / F;
      sumTop25 += topCnt / ranks.length;
      sumMid50 += midCnt / ranks.length;
      sumBot25 += botCnt / ranks.length;
      nValidSlates++;
    }
  }
  const pays = perSlate.map(x => x.pay);
  const meanPay = pays.reduce((a, b) => a + b, 0) / pays.length;
  const stdAcrossSlates = Math.sqrt(pays.reduce((a, p) => a + (p - meanPay) ** 2, 0) / pays.length);
  const worstSlate = Math.min(...pays);
  return {
    id, cfg, fullPay, recentPay, oosPay, t1, cash, scored, profitable,
    meanIqrFrac: nValidSlates ? sumIqrFrac / nValidSlates : 0,
    meanPctTop25: nValidSlates ? sumTop25 / nValidSlates : 0,
    meanPctMid50: nValidSlates ? sumMid50 / nValidSlates : 0,
    meanPctBot25: nValidSlates ? sumBot25 / nValidSlates : 0,
    stdAcrossSlates, worstSlate, perSlate,
  };
}

function randomSimplexPoint(dim: number, minEach: number = 0): number[] {
  let remaining = 1 - dim * minEach;
  if (remaining < 0) { const v = 1 / dim; return new Array(dim).fill(v); }
  const breaks = [0, ...Array.from({ length: dim - 1 }, () => Math.random()).sort(), 1];
  return breaks.slice(1).map((b, i) => minEach + (b - breaks[i]) * remaining);
}

function getBinPattern(): { name: string; alloc: [number, number, number, number, number] } {
  const r = Math.random();
  if (r < 0.06) return { name: 'value-extreme', alloc: [0.05, 0.05, 0.85, 0.03, 0.02] };
  if (r < 0.12) return { name: 'value-very-extreme', alloc: [0.02, 0.02, 0.92, 0.02, 0.02] };
  if (r < 0.18) return { name: '4bin-cvc', alloc: [0.25, 0, 0.50, 0.25, 0] };
  if (r < 0.24) return { name: 'core-heavy', alloc: [0.10, 0.50, 0.30, 0.05, 0.05] };
  if (r < 0.30) return { name: 'pure-chalk', alloc: [0.50, 0.30, 0.20, 0, 0] };
  if (r < 0.34) return { name: 'pure-deep', alloc: [0, 0, 0.20, 0.30, 0.50] };
  if (r < 0.38) return { name: '3bin', alloc: [0.33, 0, 0.34, 0, 0.33] };
  if (r < 0.42) return { name: 'barbell', alloc: [0.40, 0.05, 0.10, 0.05, 0.40] };
  if (r < 0.46) return { name: 'inverted-spike', alloc: [0.30, 0.05, 0.30, 0.05, 0.30] };
  // Random
  const a = randomSimplexPoint(5, 0.02);
  return { name: 'random5', alloc: [a[0], a[1], a[2], a[3], a[4]] };
}

async function main() {
  console.log('================================================================');
  console.log('MLB MEGABIN V3 — 100K configs across 16 slates with new dimensions');
  console.log('================================================================\n');

  const t_start = Date.now();
  const BUDGET_MS = 24 * 60 * 60 * 1000; // 24 hours
  const TARGET_CONFIGS = 100000;

  console.log('Loading 16 slates...');
  const cache: SlateData[] = [];
  for (const s of SLATES) {
    try { const c = await loadSlate(s); if (c) cache.push(c); } catch (e: any) { console.log(`  skip ${s.slate}: ${e.message}`); }
  }
  console.log(`${cache.length} slates loaded.\n`);

  const results: ConfigResult[] = [];
  let bestByFull: ConfigResult | null = null;
  let bestByDispersion: ConfigResult | null = null;
  let bestByCombined: ConfigResult | null = null;

  // Resume support: load existing saved configs
  const skipCounts: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 };
  if (fs.existsSync(OUT_JSON)) {
    try {
      const saved = JSON.parse(fs.readFileSync(OUT_JSON, 'utf-8')) as any[];
      for (const r of saved) {
        const cr: ConfigResult = {
          id: r.id, cfg: r.cfg,
          fullPay: r.fullPay, recentPay: r.recentPay, oosPay: r.oosPay,
          t1: r.t1, cash: r.cash, scored: r.scored, profitable: r.profitable,
          meanIqrFrac: r.meanIqrFrac, meanPctTop25: r.meanPctTop25,
          meanPctMid50: r.meanPctMid50, meanPctBot25: r.meanPctBot25,
          stdAcrossSlates: r.stdAcrossSlates, worstSlate: r.worstSlate,
          perSlate: r.perSlate || [],
        };
        results.push(cr);
        if (!bestByFull || cr.fullPay > bestByFull.fullPay) bestByFull = cr;
        if (!bestByDispersion || cr.meanIqrFrac > bestByDispersion.meanIqrFrac) bestByDispersion = cr;
        const combined = cr.fullPay * cr.meanIqrFrac;
        if (!bestByCombined || combined > (bestByCombined.fullPay * bestByCombined.meanIqrFrac)) bestByCombined = cr;
        const ph = r.cfg?.phase;
        if (ph && skipCounts[ph] !== undefined) skipCounts[ph]++;
      }
      console.log(`RESUME: loaded ${saved.length} prior configs.`);
      console.log(`  per-phase skip: A=${skipCounts.A} B=${skipCounts.B} C=${skipCounts.C} D=${skipCounts.D} E=${skipCounts.E} F=${skipCounts.F}`);
      if (bestByFull) console.log(`  best so far: full=$${bestByFull.fullPay.toFixed(0)} disp=${(bestByDispersion!.meanIqrFrac*100).toFixed(1)}%`);
    } catch (e: any) {
      console.log(`  RESUME failed (${e.message}); starting fresh.`);
    }
  }

  const tryConfig = (id: string, cfgMeta: any, factory: (sd: SlateData) => Parameters<typeof productionSelect>[2]) => {
    if (results.length >= TARGET_CONFIGS) return false;
    const r = evaluateConfig(id, cfgMeta, factory, cache);
    results.push(r);
    if (!bestByFull || r.fullPay > bestByFull.fullPay) bestByFull = r;
    if (!bestByDispersion || r.meanIqrFrac > bestByDispersion.meanIqrFrac) bestByDispersion = r;
    // Combined: ROI rank * dispersion rank — track current best by combined score
    const combined = r.fullPay * r.meanIqrFrac;
    if (!bestByCombined || combined > (bestByCombined.fullPay * bestByCombined.meanIqrFrac)) bestByCombined = r;

    if (results.length % 200 === 0) {
      const elapsedMin = (Date.now() - t_start) / 60000;
      const rate = results.length / elapsedMin;
      const remainingMin = (TARGET_CONFIGS - results.length) / rate;
      console.log(`  [${results.length}/${TARGET_CONFIGS} ${(results.length/TARGET_CONFIGS*100).toFixed(1)}%, ${elapsedMin.toFixed(1)}m, ETA ${remainingMin.toFixed(0)}m] best full=$${bestByFull.fullPay.toFixed(0)} disp=${(bestByDispersion.meanIqrFrac*100).toFixed(1)}% combo-best full=$${bestByCombined.fullPay.toFixed(0)} disp=${(bestByCombined.meanIqrFrac*100).toFixed(1)}%`);
    }
    if (results.length % 1000 === 0) {
      const compact = results.map(r => ({
        id: r.id, cfg: r.cfg, fullPay: r.fullPay, recentPay: r.recentPay, oosPay: r.oosPay,
        t1: r.t1, cash: r.cash, scored: r.scored, profitable: r.profitable,
        meanIqrFrac: r.meanIqrFrac, meanPctTop25: r.meanPctTop25, meanPctMid50: r.meanPctMid50, meanPctBot25: r.meanPctBot25,
        stdAcrossSlates: r.stdAcrossSlates, worstSlate: r.worstSlate,
      }));
      fs.writeFileSync(OUT_JSON, JSON.stringify(compact, null, 0));
    }
    return true;
  };

  const timeOut = () => Date.now() - t_start > BUDGET_MS || results.length >= TARGET_CONFIGS;

  // ==========================================================================
  // PHASE A — DISPERSION-FOCUSED: max-stack + tight γ + tight maxExposure
  // (DK MLB cap: max 5-hitter primary stack)
  // ==========================================================================
  console.log('\n=== PHASE A: Dispersion-focused (mps 4-5, γ 3-5, tight me) ===\n');
  let skipA = skipCounts.A;
  for (const mps of [4, 5]) {
    for (const gam of [3, 4, 5]) {
      for (const me of [0.08, 0.12, 0.16, 0.20]) {
        for (let i = 0; i < 60 && !timeOut(); i++) {
          if (skipA > 0) { skipA--; continue; }
          const pat = getBinPattern();
          const lam = Math.random() * 1.0;
          const tc = 0.10 + Math.random() * 0.20;
          const corner = Math.random() < 0.6;
          const mep = 0.30 + Math.random() * 0.40;
          const id = `A:mps${mps}|g${gam}|me${me}|${pat.name}|${i}`;
          tryConfig(id, { phase: 'A', mps, gam, me, mep, lam, tc, corner, pattern: pat.name, alloc: pat.alloc },
            (sd) => ({
              N, lambda: lam, comboFreq: sd.comboFreq, maxOverlap: gam, teamCapPct: tc,
              minPrimaryStack: mps, maxExposure: me, maxExposurePitcher: mep,
              extremeCornerCap: corner, projectionFloorPct: 0,
              binAllocation: { chalk: pat.alloc[0], core: pat.alloc[1], value: pat.alloc[2], contra: pat.alloc[3], deep: pat.alloc[4] },
            }),
          );
        }
      }
    }
  }

  // ==========================================================================
  // PHASE B — Extreme λ exploration (1.0 to 2.0)
  // ==========================================================================
  console.log('\n=== PHASE B: Extreme λ (1.0 to 2.0) ===\n');
  let skipB = skipCounts.B;
  for (const lam of [0.7, 0.85, 1.0, 1.2, 1.5, 1.75, 2.0]) {
    for (let i = 0; i < 200 && !timeOut(); i++) {
      if (skipB > 0) { skipB--; continue; }
      const pat = getBinPattern();
      const power = [1, 2, 3, 4][Math.floor(Math.random() * 4)];
      const gam = 4 + Math.floor(Math.random() * 4);
      const tc = 0.12 + Math.random() * 0.15;
      const mps = [3, 4, 5][Math.floor(Math.random() * 3)];
      const me = 0.10 + Math.random() * 0.15;
      const id = `B:lam${lam}|p${power}|${pat.name}|${i}`;
      tryConfig(id, { phase: 'B', lam, power, gam, tc, mps, me, pattern: pat.name, alloc: pat.alloc },
        (sd) => ({
          N, lambda: lam, comboFreq: getCombo(sd, power), maxOverlap: gam, teamCapPct: tc,
          minPrimaryStack: mps, maxExposure: me,
          extremeCornerCap: true, projectionFloorPct: 0,
          binAllocation: { chalk: pat.alloc[0], core: pat.alloc[1], value: pat.alloc[2], contra: pat.alloc[3], deep: pat.alloc[4] },
        }),
      );
    }
  }

  // ==========================================================================
  // PHASE C — Chimera neighborhood refinement (small perturbations)
  // ==========================================================================
  console.log('\n=== PHASE C: Chimera neighborhood ===\n');
  let skipC = skipCounts.C;
  for (let i = 0; i < 5000 && !timeOut(); i++) {
    if (skipC > 0) { skipC--; continue; }
    const lam = 0.40 + Math.random() * 0.50;       // 0.40-0.90
    const tc = 0.18 + Math.random() * 0.10;         // 0.18-0.28
    const mps = [4, 5][Math.floor(Math.random() * 2)];
    const me = 0.10 + Math.random() * 0.10;
    const mep = 0.30 + Math.random() * 0.20;
    const corner = Math.random() < 0.7;
    const power = [1, 2, 3][Math.floor(Math.random() * 3)];
    // Value-heavy bins
    const valueShare = 0.70 + Math.random() * 0.25;
    const remShare = 1 - valueShare;
    const a = randomSimplexPoint(4, 0.005).map(x => x * remShare);
    const alloc = [a[0], a[1], valueShare, a[2], a[3]];
    const id = `C:chimera-nbr|${i}`;
    tryConfig(id, { phase: 'C', lam, tc, mps, me, mep, corner, power, alloc },
      (sd) => ({
        N, lambda: lam, comboFreq: getCombo(sd, power), maxOverlap: 6, teamCapPct: tc,
        minPrimaryStack: mps, maxExposure: me, maxExposurePitcher: mep,
        extremeCornerCap: corner, projectionFloorPct: 0,
        binAllocation: { chalk: alloc[0], core: alloc[1], value: alloc[2], contra: alloc[3], deep: alloc[4] },
      }),
    );
  }

  // ==========================================================================
  // PHASE D — Tighter team caps (mps=5 forces 5-stacks; tight tc spreads them)
  // ==========================================================================
  console.log('\n=== PHASE D: Tight team caps (mps=5 + tc 0.08-0.18) ===\n');
  let skipD = skipCounts.D;
  for (const tc of [0.08, 0.10, 0.12, 0.14, 0.16, 0.18]) {
    for (let i = 0; i < 500 && !timeOut(); i++) {
      if (skipD > 0) { skipD--; continue; }
      const lam = Math.random() * 1.2;
      const gam = 4 + Math.floor(Math.random() * 3);
      const me = 0.10 + Math.random() * 0.15;
      const mep = 0.30 + Math.random() * 0.30;
      const pat = getBinPattern();
      const corner = Math.random() < 0.6;
      const power = [1, 2, 3][Math.floor(Math.random() * 3)];
      const id = `D:tc${tc}|${pat.name}|${i}`;
      tryConfig(id, { phase: 'D', mps: 5, lam, gam, tc, me, mep, corner, power, pattern: pat.name, alloc: pat.alloc },
        (sd) => ({
          N, lambda: lam, comboFreq: getCombo(sd, power), maxOverlap: gam, teamCapPct: tc,
          minPrimaryStack: 5, maxExposure: me, maxExposurePitcher: mep,
          extremeCornerCap: corner, projectionFloorPct: 0,
          binAllocation: { chalk: pat.alloc[0], core: pat.alloc[1], value: pat.alloc[2], contra: pat.alloc[3], deep: pat.alloc[4] },
        }),
      );
    }
  }

  // ==========================================================================
  // PHASE E — Stricter γ exploration (γ=3, 4 with various combos)
  // ==========================================================================
  console.log('\n=== PHASE E: Stricter γ (3, 4) ===\n');
  let skipE = skipCounts.E;
  for (const gam of [3, 4]) {
    for (let i = 0; i < 2000 && !timeOut(); i++) {
      if (skipE > 0) { skipE--; continue; }
      const pat = getBinPattern();
      const lam = Math.random() * 1.0;
      const tc = 0.12 + Math.random() * 0.18;
      const mps = [3, 4, 5][Math.floor(Math.random() * 3)];
      const me = 0.12 + Math.random() * 0.18;
      const mep = 0.30 + Math.random() * 0.30;
      const corner = Math.random() < 0.65;
      const power = [1, 2, 3][Math.floor(Math.random() * 3)];
      const id = `E:g${gam}|${pat.name}|${i}`;
      tryConfig(id, { phase: 'E', gam, lam, tc, mps, me, mep, corner, power, pattern: pat.name, alloc: pat.alloc },
        (sd) => ({
          N, lambda: lam, comboFreq: getCombo(sd, power), maxOverlap: gam, teamCapPct: tc,
          minPrimaryStack: mps, maxExposure: me, maxExposurePitcher: mep,
          extremeCornerCap: corner, projectionFloorPct: 0,
          binAllocation: { chalk: pat.alloc[0], core: pat.alloc[1], value: pat.alloc[2], contra: pat.alloc[3], deep: pat.alloc[4] },
        }),
      );
    }
  }

  // ==========================================================================
  // PHASE F — Continuous random fill with all extreme dimensions
  // ==========================================================================
  console.log('\n=== PHASE F: Continuous random fill ===\n');
  while (!timeOut()) {
    const pat = getBinPattern();
    const power = [1, 2, 3, 4][Math.floor(Math.random() * 4)];
    const lam = Math.random() * 1.5;
    const gam = 3 + Math.floor(Math.random() * 6); // 3-8
    const fl = Math.random() < 0.4 ? 0 : (0.70 + Math.random() * 0.22);
    const tc = 0.10 + Math.random() * 0.20;
    const corner = Math.random() < 0.6;
    const q5 = 0.10 + Math.random() * 0.40;
    const q1 = 0.02 + Math.random() * 0.15;
    const me = 0.08 + Math.random() * 0.30;
    const mep = 0.30 + Math.random() * 0.50;
    const mps = [2, 3, 4, 5][Math.floor(Math.random() * 4)];
    const useOC = Math.random() < 0.15;
    const od = 3 + Math.random() * 7;
    const buf = -3 + Math.random() * 8;
    const id = `F:${pat.name}|p${power}|l${lam.toFixed(2)}|g${gam}|fl${fl.toFixed(2)}|tc${tc.toFixed(2)}|c${corner ? 1 : 0}|mps${mps}|me${me.toFixed(2)}|mep${mep.toFixed(2)}`;
    tryConfig(id, { phase: 'F', power, lam, gam, fl, tc, corner, q5, q1, me, mep, mps, useOC, od, buf, pattern: pat.name, alloc: pat.alloc },
      (sd) => ({
        N, lambda: lam, comboFreq: getCombo(sd, power), maxOverlap: gam, teamCapPct: tc,
        projectionFloorPct: fl, minPrimaryStack: mps,
        maxExposure: me, maxExposurePitcher: mep,
        extremeCornerCap: corner, extremeCornerQ5Q5Pct: q5, extremeCornerQ1Q1Pct: q1,
        useOwnershipCeiling: useOC,
        ownDropPP: od, ownershipCeilingBuffer: buf,
        binAllocation: { chalk: pat.alloc[0], core: pat.alloc[1], value: pat.alloc[2], contra: pat.alloc[3], deep: pat.alloc[4] },
      }),
    );
  }

  // Final persist
  const compact = results.map(r => ({
    id: r.id, cfg: r.cfg, fullPay: r.fullPay, recentPay: r.recentPay, oosPay: r.oosPay,
    t1: r.t1, cash: r.cash, scored: r.scored, profitable: r.profitable,
    meanIqrFrac: r.meanIqrFrac, meanPctTop25: r.meanPctTop25, meanPctMid50: r.meanPctMid50, meanPctBot25: r.meanPctBot25,
    stdAcrossSlates: r.stdAcrossSlates, worstSlate: r.worstSlate,
    perSlate: r.perSlate,
  }));
  fs.writeFileSync(OUT_JSON, JSON.stringify(compact, null, 0));

  // Analysis
  console.log('\n\n================================================================');
  console.log(`SWEEP COMPLETE — ${results.length} configs in ${((Date.now() - t_start) / 60000).toFixed(1)} min`);
  console.log('================================================================\n');

  const fees = cache.length * 150 * 20;
  const byFull = [...results].sort((a, b) => b.fullPay - a.fullPay);
  const byDisp = [...results].sort((a, b) => b.meanIqrFrac - a.meanIqrFrac);
  // Combined: rank-product — lower is better
  const fullRank = new Map<string, number>(); const dispRank = new Map<string, number>();
  for (let i = 0; i < byFull.length; i++) fullRank.set(byFull[i].id, i + 1);
  for (let i = 0; i < byDisp.length; i++) dispRank.set(byDisp[i].id, i + 1);
  const byCombined = results.map(r => ({ ...r, comb: fullRank.get(r.id)! + dispRank.get(r.id)! })).sort((a, b) => a.comb - b.comb);

  console.log('=== TOP 25 BY FULL ===\n');
  for (let i = 0; i < 25; i++) {
    const r = byFull[i];
    const roi = ((r.fullPay / fees - 1) * 100).toFixed(1);
    console.log(`  ${(i+1).toString().padStart(2)} | full=$${r.fullPay.toFixed(0).padStart(6)} | ROI=${roi}% | OOS=$${r.oosPay.toFixed(0)} | IQR/F=${(r.meanIqrFrac*100).toFixed(1)}% | profit=${r.profitable}/${cache.length} | ${r.id.slice(0, 60)}`);
  }

  console.log('\n=== TOP 25 BY DISPERSION ===\n');
  for (let i = 0; i < 25; i++) {
    const r = byDisp[i];
    const roi = ((r.fullPay / fees - 1) * 100).toFixed(1);
    console.log(`  ${(i+1).toString().padStart(2)} | IQR/F=${(r.meanIqrFrac*100).toFixed(1)}% | full=$${r.fullPay.toFixed(0).padStart(6)} | ROI=${roi}% | top25=${(r.meanPctTop25*100).toFixed(1)}% bot25=${(r.meanPctBot25*100).toFixed(1)}% | ${r.id.slice(0, 60)}`);
  }

  console.log('\n=== TOP 25 SMOOTH WINNERS (rank-product) ===\n');
  for (let i = 0; i < 25; i++) {
    const r = byCombined[i];
    const roi = ((r.fullPay / fees - 1) * 100).toFixed(1);
    console.log(`  ${(i+1).toString().padStart(2)} | comb=${r.comb} | full#${fullRank.get(r.id)} disp#${dispRank.get(r.id)} | ROI=${roi}% | IQR/F=${(r.meanIqrFrac*100).toFixed(1)}% | ${r.id.slice(0, 60)}`);
  }

  // Markdown
  let md = `# MLB Megabin V3 — 100K Sweep with Dispersion Metrics\n\n`;
  md += `**${results.length} configs** evaluated across 16 slates with integrated dispersion metrics.\n\n`;
  md += `Total fees: $${fees.toLocaleString()}\n\n`;
  md += `## Top 25 by Full ROI\n\n`;
  md += `| Rank | Full | OOS | ROI | IQR/F | Profit | id |\n|---:|---:|---:|---:|---:|---:|---|\n`;
  for (let i = 0; i < 25; i++) {
    const r = byFull[i]; const roi = ((r.fullPay / fees - 1) * 100).toFixed(1);
    md += `| ${i+1} | $${r.fullPay.toFixed(0)} | $${r.oosPay.toFixed(0)} | ${roi}% | ${(r.meanIqrFrac*100).toFixed(1)}% | ${r.profitable}/${cache.length} | \`${r.id.slice(0, 50)}\` |\n`;
  }
  md += `\n## Top 25 by Dispersion (IQR/F)\n\n`;
  md += `| Rank | IQR/F | Full | ROI | top25/bot25 | id |\n|---:|---:|---:|---:|---|---|\n`;
  for (let i = 0; i < 25; i++) {
    const r = byDisp[i]; const roi = ((r.fullPay / fees - 1) * 100).toFixed(1);
    md += `| ${i+1} | ${(r.meanIqrFrac*100).toFixed(1)}% | $${r.fullPay.toFixed(0)} | ${roi}% | ${(r.meanPctTop25*100).toFixed(1)}/${(r.meanPctBot25*100).toFixed(1)}% | \`${r.id.slice(0, 50)}\` |\n`;
  }
  md += `\n## Top 25 Smooth Winners (combined rank)\n\n`;
  md += `| Rank | full# | disp# | Full | ROI | IQR/F | id |\n|---:|---:|---:|---:|---:|---:|---|\n`;
  for (let i = 0; i < 25; i++) {
    const r = byCombined[i]; const roi = ((r.fullPay / fees - 1) * 100).toFixed(1);
    md += `| ${i+1} | #${fullRank.get(r.id)} | #${dispRank.get(r.id)} | $${r.fullPay.toFixed(0)} | ${roi}% | ${(r.meanIqrFrac*100).toFixed(1)}% | \`${r.id.slice(0, 50)}\` |\n`;
  }

  fs.writeFileSync(OUT_MD, md);
  console.log(`\nJSON: ${OUT_JSON}`);
  console.log(`MD:   ${OUT_MD}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
