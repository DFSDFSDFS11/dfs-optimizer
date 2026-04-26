/**
 * MLB Mega Bin Sweep V2 — 75K configs across 13 slates (11 in-sample + 2 OOS).
 *
 * NEW dimensions vs original 67k sweep:
 *   - Combo bonus power variations (1, 2, 2.5, 3, 3.5, 4, 5)
 *   - Extended λ range (0 to 1.0)
 *   - Bin "type" variations: 3-bin, 4-bin, 5-bin, 7-bin emulations via binAllocation
 *   - Barbell / pure-chalk / pure-deep bin patterns
 *   - Finer corner-cap percentage grid
 *   - MinPrimaryStack variations (2, 3, 4, 5)
 *   - maxExposure + maxExposurePitcher joint sweep
 *   - Ownership ceiling + ownDropPP variations
 *
 * Hydra baseline: λ=0.20, γ=6, tc=0.20, corner=true, bins 7/7/58/12/16.
 * Validated 13-slate full estimated; we'll find new winners that beat it.
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
const OUT_JSON = path.join(DIR, 'mlb_megabin2_sweep.json');
const OUT_MD = path.join(DIR, 'mlb_megabin2_sweep.md');
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
];
const RECENT = new Set(['4-20-26', '4-21-26', '4-22-26', '4-23-26', '4-24-26']);
const OOS = new Set(['4-23-26', '4-24-26']);

// Hydra reference (current shipped)
const HYDRA_FULL13 = 0; // we'll estimate from sweep results since we need to compute Hydra's actual perf with new slates
const HYDRA_TARGET = 50000; // approximate threshold to beat

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

interface SlateData {
  slate: string;
  candidates: Lineup[];
  players: Player[];
  comboFreq: Map<string, number>;       // power=3 (default)
  comboFreq1: Map<string, number>;      // power=1
  comboFreq2: Map<string, number>;      // power=2
  comboFreq4: Map<string, number>;      // power=4
  comboFreq5: Map<string, number>;      // power=5
  actuals: ContestActuals;
  actualByHash: Map<string, number>;
  sorted: number[];
  top1Thresh: number;
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
  const payoutTable = buildPayoutTable(F);
  const actualByHash = new Map<string, number>();
  for (const e of actuals.entries) {
    const pls: Player[] = []; let ok = true;
    for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
    if (!ok) continue;
    actualByHash.set(pls.map(p => p.id).sort().join('|'), e.actualPoints);
  }
  // Pre-compute combo frequency maps at multiple powers
  const comboFreq = precomputeComboFrequencies(loaded.lineups, 3);
  const comboFreq1 = precomputeComboFrequencies(loaded.lineups, 1);
  const comboFreq2 = precomputeComboFrequencies(loaded.lineups, 2);
  const comboFreq4 = precomputeComboFrequencies(loaded.lineups, 4);
  const comboFreq5 = precomputeComboFrequencies(loaded.lineups, 5);
  const anchor = computeAnchor(loaded.lineups, 50);
  return {
    slate: s.slate, candidates: loaded.lineups, players: pool.players,
    comboFreq, comboFreq1, comboFreq2, comboFreq4, comboFreq5,
    actuals, actualByHash, sorted, top1Thresh, payoutTable, F, anchor,
  };
}

interface ConfigResult {
  id: string;
  phase: string;
  cfg: any;
  fullPay: number;
  recentPay: number;
  oosPay: number;
  minLoo: number;
  t1: number;
  profitable: number;
  perSlate: { slate: string; pay: number; t1: number }[];
}

function runAndScore(sd: SlateData, cfg: Parameters<typeof productionSelect>[2]): { pay: number; t1: number } {
  const result = productionSelect(sd.candidates, sd.players, cfg);
  let pay = 0, t1 = 0;
  for (const lu of result.portfolio) {
    const a = scoreLineup(lu, sd.actuals, sd.actualByHash); if (a === null) continue;
    pay += payoutFor(a, sd.sorted, sd.payoutTable, sd.actuals);
    if (a >= sd.top1Thresh) t1++;
  }
  return { pay, t1 };
}

function evaluateConfig(id: string, phase: string, cfgMeta: any, runCfgFactory: (sd: SlateData) => Parameters<typeof productionSelect>[2], cache: SlateData[]): ConfigResult {
  const perSlate: { slate: string; pay: number; t1: number }[] = [];
  let fullPay = 0, recentPay = 0, oosPay = 0, t1 = 0, profitable = 0;
  for (const sd of cache) {
    const r = runAndScore(sd, runCfgFactory(sd));
    perSlate.push({ slate: sd.slate, pay: r.pay, t1: r.t1 });
    fullPay += r.pay; t1 += r.t1;
    if (r.pay > FEE * N) profitable++;
    if (RECENT.has(sd.slate)) recentPay += r.pay;
    if (OOS.has(sd.slate)) oosPay += r.pay;
  }
  const pays = perSlate.map(x => x.pay);
  const loos = pays.map((_, i) => { let s = 0, cnt = 0; for (let j = 0; j < pays.length; j++) if (j !== i) { s += pays[j]; cnt++; } return cnt ? s / cnt : 0; });
  const minLoo = Math.min(...loos);
  return { id, phase, cfg: cfgMeta, fullPay, recentPay, oosPay, minLoo, t1, profitable, perSlate };
}

// Random simplex point on N-1 simplex with each coord >= minEach
function randomSimplexPoint(dim: number, minEach: number = 0): number[] {
  let remaining = 1 - dim * minEach;
  if (remaining < 0) { const v = 1 / dim; return new Array(dim).fill(v); }
  const breaks = [0, ...Array.from({ length: dim - 1 }, () => Math.random()).sort(), 1];
  return breaks.slice(1).map((b, i) => minEach + (b - breaks[i]) * remaining);
}

// "Bin type" patterns — emulate different bin structures via binAllocation
function getBinPattern(): { name: string; alloc: [number, number, number, number, number] } {
  const r = Math.random();
  if (r < 0.10) return { name: '3bin', alloc: [0.33, 0, 0.34, 0, 0.33] };
  if (r < 0.20) return { name: '4bin-cvc', alloc: [0.25, 0, 0.50, 0.25, 0] };
  if (r < 0.30) return { name: 'barbell', alloc: [0.40, 0.05, 0.10, 0.05, 0.40] };
  if (r < 0.40) return { name: 'pure-chalk', alloc: [0.50, 0.30, 0.20, 0, 0] };
  if (r < 0.50) return { name: 'pure-deep', alloc: [0, 0, 0.20, 0.30, 0.50] };
  if (r < 0.60) return { name: 'value-extreme', alloc: [0.05, 0.05, 0.85, 0.03, 0.02] };
  if (r < 0.70) return { name: 'inverted-hydra-spike', alloc: [0.30, 0.05, 0.30, 0.05, 0.30] };
  if (r < 0.80) return { name: 'core-heavy', alloc: [0.10, 0.50, 0.30, 0.05, 0.05] };
  // Random simplex
  const a = randomSimplexPoint(5, 0.02);
  return { name: 'random5', alloc: [a[0], a[1], a[2], a[3], a[4]] };
}

async function main() {
  console.log('================================================================');
  console.log('MLB MEGABIN V2 — 75K configs across 13 slates with new dimensions');
  console.log('================================================================\n');

  const t_start = Date.now();
  const BUDGET_MS = 4.5 * 60 * 60 * 1000; // 4.5 hours
  const TARGET_CONFIGS = 75000;

  console.log('Loading 13 slates with multi-power combo frequencies...');
  const cache: SlateData[] = [];
  for (const s of SLATES) {
    try { const c = await loadSlate(s); if (c) cache.push(c); } catch (e: any) { console.log(`  skip ${s.slate}: ${e.message}`); }
  }
  console.log(`${cache.length} slates loaded.\n`);

  const results: ConfigResult[] = [];
  let bestByFull: ConfigResult | null = null;
  let bestByOos: ConfigResult | null = null;
  let bestByLoo: ConfigResult | null = null;

  const tryConfig = (id: string, phase: string, cfgMeta: any, factory: (sd: SlateData) => Parameters<typeof productionSelect>[2]) => {
    if (results.length >= TARGET_CONFIGS) return false;
    const r = evaluateConfig(id, phase, cfgMeta, factory, cache);
    results.push(r);
    if (!bestByFull || r.fullPay > bestByFull.fullPay) bestByFull = r;
    if (!bestByOos || r.oosPay > bestByOos.oosPay) bestByOos = r;
    if (!bestByLoo || r.minLoo > bestByLoo.minLoo) bestByLoo = r;
    if (results.length % 100 === 0) {
      const elapsedMin = (Date.now() - t_start) / 60000;
      const rate = results.length / elapsedMin;
      const remainingMin = (TARGET_CONFIGS - results.length) / rate;
      console.log(`  [${results.length}/${TARGET_CONFIGS} ${(results.length/TARGET_CONFIGS*100).toFixed(1)}%, ${elapsedMin.toFixed(1)}m, ETA ${remainingMin.toFixed(0)}m] best full=$${bestByFull.fullPay.toFixed(0)} OOS=$${bestByOos.oosPay.toFixed(0)} minLoo=$${bestByLoo.minLoo.toFixed(0)}`);
    }
    if (results.length % 1000 === 0) {
      // Compact persist — don't store perSlate to save space
      const compact = results.map(r => ({
        id: r.id, phase: r.phase, cfg: r.cfg,
        fullPay: r.fullPay, recentPay: r.recentPay, oosPay: r.oosPay, minLoo: r.minLoo,
        t1: r.t1, profitable: r.profitable,
      }));
      fs.writeFileSync(OUT_JSON, JSON.stringify(compact, null, 0));
    }
    return true;
  };

  const timeOut = () => Date.now() - t_start > BUDGET_MS || results.length >= TARGET_CONFIGS;

  const getCombo = (sd: SlateData, power: number) => {
    if (power === 1) return sd.comboFreq1;
    if (power === 2) return sd.comboFreq2;
    if (power === 4) return sd.comboFreq4;
    if (power === 5) return sd.comboFreq5;
    return sd.comboFreq;
  };

  // ==========================================================================
  // PHASE A — Combo bonus power variations
  // ==========================================================================
  console.log('\n=== PHASE A: Combo bonus power variations ===\n');
  for (const power of [1, 2, 3, 4, 5]) {
    for (const lam of [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 0.75, 1.0]) {
      for (let i = 0; i < 50 && !timeOut(); i++) {
        const pat = getBinPattern();
        const id = `A:p${power}|lam${lam}|${pat.name}|${i}`;
        tryConfig(id, 'A', { power, lam, pattern: pat.name, alloc: pat.alloc },
          (sd) => ({
            N, lambda: lam, comboFreq: getCombo(sd, power), maxOverlap: 6, teamCapPct: 0.20,
            extremeCornerCap: true, projectionFloorPct: 0,
            binAllocation: { chalk: pat.alloc[0], core: pat.alloc[1], value: pat.alloc[2], contra: pat.alloc[3], deep: pat.alloc[4] },
          }),
        );
      }
    }
    if (timeOut()) break;
  }

  // ==========================================================================
  // PHASE B — Bin pattern + λ × γ grid (emulating different bin types)
  // ==========================================================================
  console.log('\n=== PHASE B: Bin patterns × λ × γ ===\n');
  for (let i = 0; i < 12000 && !timeOut(); i++) {
    const pat = getBinPattern();
    const lam = Math.random() * 0.6;
    const gam = 4 + Math.floor(Math.random() * 5); // 4-8
    const tc = 0.10 + Math.random() * 0.18;
    const corner = Math.random() < 0.7;
    const id = `B:${pat.name}|lam${lam.toFixed(2)}|gam${gam}|tc${tc.toFixed(2)}|c${corner ? 1 : 0}|${i}`;
    tryConfig(id, 'B', { pattern: pat.name, lam, gam, tc, corner, alloc: pat.alloc },
      (sd) => ({
        N, lambda: lam, comboFreq: sd.comboFreq, maxOverlap: gam, teamCapPct: tc,
        extremeCornerCap: corner, projectionFloorPct: 0,
        binAllocation: { chalk: pat.alloc[0], core: pat.alloc[1], value: pat.alloc[2], contra: pat.alloc[3], deep: pat.alloc[4] },
      }),
    );
  }

  // ==========================================================================
  // PHASE C — Projection floor refinement
  // ==========================================================================
  console.log('\n=== PHASE C: Projection floor refinement ===\n');
  for (const fl of [0, 0.70, 0.75, 0.78, 0.80, 0.82, 0.84, 0.85, 0.86, 0.88, 0.90, 0.92]) {
    for (let i = 0; i < 200 && !timeOut(); i++) {
      const pat = getBinPattern();
      const lam = Math.random() * 0.4;
      const tc = 0.15 + Math.random() * 0.10;
      const corner = Math.random() < 0.7;
      const id = `C:fl${fl}|${pat.name}|lam${lam.toFixed(2)}|${i}`;
      tryConfig(id, 'C', { fl, pattern: pat.name, lam, tc, corner, alloc: pat.alloc },
        (sd) => ({
          N, lambda: lam, comboFreq: sd.comboFreq, maxOverlap: 6, teamCapPct: tc,
          extremeCornerCap: corner, projectionFloorPct: fl,
          binAllocation: { chalk: pat.alloc[0], core: pat.alloc[1], value: pat.alloc[2], contra: pat.alloc[3], deep: pat.alloc[4] },
        }),
      );
    }
  }

  // ==========================================================================
  // PHASE D — Corner cap percentage refinement
  // ==========================================================================
  console.log('\n=== PHASE D: Extreme-corner percentage refinement ===\n');
  for (const q5 of [0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.50]) {
    for (const q1 of [0.01, 0.02, 0.05, 0.08, 0.10, 0.15]) {
      for (let i = 0; i < 30 && !timeOut(); i++) {
        const pat = getBinPattern();
        const lam = Math.random() * 0.4;
        const id = `D:q5${q5}|q1${q1}|${pat.name}|${i}`;
        tryConfig(id, 'D', { q5, q1, pattern: pat.name, alloc: pat.alloc, lam },
          (sd) => ({
            N, lambda: lam, comboFreq: sd.comboFreq, maxOverlap: 6, teamCapPct: 0.20,
            extremeCornerCap: true, extremeCornerQ5Q5Pct: q5, extremeCornerQ1Q1Pct: q1,
            projectionFloorPct: 0,
            binAllocation: { chalk: pat.alloc[0], core: pat.alloc[1], value: pat.alloc[2], contra: pat.alloc[3], deep: pat.alloc[4] },
          }),
        );
      }
    }
  }

  // ==========================================================================
  // PHASE E — minPrimaryStack variations + maxExposure
  // ==========================================================================
  console.log('\n=== PHASE E: minPrimaryStack × maxExposure × maxExposurePitcher ===\n');
  for (const mps of [2, 3, 4, 5]) {
    for (const me of [0.20, 0.30, 0.40, 0.50]) {
      for (const mep of [0.30, 0.40, 0.50, 0.70]) {
        for (let i = 0; i < 30 && !timeOut(); i++) {
          const pat = getBinPattern();
          const lam = Math.random() * 0.4;
          const id = `E:mps${mps}|me${me}|mep${mep}|${pat.name}|${i}`;
          tryConfig(id, 'E', { mps, me, mep, pattern: pat.name, alloc: pat.alloc, lam },
            (sd) => ({
              N, lambda: lam, comboFreq: sd.comboFreq, maxOverlap: 6, teamCapPct: 0.20,
              minPrimaryStack: mps, maxExposure: me, maxExposurePitcher: mep,
              extremeCornerCap: true, projectionFloorPct: 0,
              binAllocation: { chalk: pat.alloc[0], core: pat.alloc[1], value: pat.alloc[2], contra: pat.alloc[3], deep: pat.alloc[4] },
            }),
          );
        }
      }
    }
  }

  // ==========================================================================
  // PHASE F — Ownership ceiling buffer + ownDropPP
  // ==========================================================================
  console.log('\n=== PHASE F: Ownership ceiling + ownDropPP ===\n');
  for (const od of [3, 4, 5, 6, 7, 8, 10]) {
    for (const buf of [-3, -1, 0, 1, 3, 5, 8]) {
      for (let i = 0; i < 25 && !timeOut(); i++) {
        const pat = getBinPattern();
        const lam = Math.random() * 0.4;
        const id = `F:od${od}|buf${buf}|${pat.name}|${i}`;
        tryConfig(id, 'F', { od, buf, pattern: pat.name, alloc: pat.alloc, lam },
          (sd) => ({
            N, lambda: lam, comboFreq: sd.comboFreq, maxOverlap: 6, teamCapPct: 0.20,
            ownDropPP: od, ownershipCeilingBuffer: buf, useOwnershipCeiling: true,
            extremeCornerCap: true, projectionFloorPct: 0,
            binAllocation: { chalk: pat.alloc[0], core: pat.alloc[1], value: pat.alloc[2], contra: pat.alloc[3], deep: pat.alloc[4] },
          }),
        );
      }
    }
  }

  // ==========================================================================
  // PHASE G — Continuous random fill
  // ==========================================================================
  console.log('\n=== PHASE G: Continuous random fill ===\n');
  while (!timeOut()) {
    const pat = getBinPattern();
    const power = Math.random() < 0.5 ? 3 : ([1, 2, 4, 5][Math.floor(Math.random() * 4)]);
    const lam = Math.random() * 0.8;
    const gam = 4 + Math.floor(Math.random() * 5);
    const fl = Math.random() < 0.5 ? 0 : (0.70 + Math.random() * 0.22);
    const tc = 0.06 + Math.random() * 0.20;
    const corner = Math.random() < 0.7;
    const q5 = 0.05 + Math.random() * 0.40;
    const q1 = 0.01 + Math.random() * 0.15;
    const me = 0.15 + Math.random() * 0.40;
    const mep = 0.30 + Math.random() * 0.50;
    const mps = [2, 3, 4, 5][Math.floor(Math.random() * 4)];
    const useOC = Math.random() < 0.20;
    const od = useOC ? 3 + Math.random() * 7 : 6;
    const buf = useOC ? -3 + Math.random() * 8 : 0;
    const id = `G:${pat.name}|p${power}|l${lam.toFixed(2)}|g${gam}|fl${fl.toFixed(2)}|tc${tc.toFixed(2)}|c${corner ? 1 : 0}|mps${mps}|me${me.toFixed(2)}|mep${mep.toFixed(2)}|oc${useOC ? 1 : 0}`;
    tryConfig(id, 'G', { power, lam, gam, fl, tc, corner, q5, q1, me, mep, mps, useOC, od, buf, pattern: pat.name, alloc: pat.alloc },
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
    id: r.id, phase: r.phase, cfg: r.cfg,
    fullPay: r.fullPay, recentPay: r.recentPay, oosPay: r.oosPay, minLoo: r.minLoo,
    t1: r.t1, profitable: r.profitable,
    perSlate: r.perSlate,
  }));
  fs.writeFileSync(OUT_JSON, JSON.stringify(compact, null, 0));

  // ==========================================================================
  // ANALYSIS
  // ==========================================================================
  console.log('\n\n================================================================');
  console.log(`SWEEP COMPLETE — ${results.length} configs evaluated in ${((Date.now() - t_start) / 60000).toFixed(1)} min`);
  console.log('================================================================\n');

  const byFull = [...results].sort((a, b) => b.fullPay - a.fullPay);
  const byOos = [...results].sort((a, b) => b.oosPay - a.oosPay);
  const byLoo = [...results].sort((a, b) => b.minLoo - a.minLoo);

  console.log('=== TOP 25 BY FULL ===\n');
  for (let i = 0; i < 25; i++) {
    const r = byFull[i];
    console.log(`  ${(i + 1).toString().padStart(2)} ${r.phase} full=$${r.fullPay.toFixed(0).padStart(6)} OOS=$${r.oosPay.toFixed(0).padStart(5)} recent=$${r.recentPay.toFixed(0).padStart(6)} minLoo=$${r.minLoo.toFixed(0).padStart(5)} prof=${r.profitable}/${r.perSlate.length}  ${r.id.slice(0, 60)}`);
  }

  console.log('\n=== TOP 25 BY OOS ===\n');
  for (let i = 0; i < 25; i++) {
    const r = byOos[i];
    console.log(`  ${(i + 1).toString().padStart(2)} ${r.phase} OOS=$${r.oosPay.toFixed(0).padStart(5)} full=$${r.fullPay.toFixed(0).padStart(6)} minLoo=$${r.minLoo.toFixed(0).padStart(5)}  ${r.id.slice(0, 60)}`);
  }

  console.log('\n=== TOP 25 BY MIN-LOO ===\n');
  for (let i = 0; i < 25; i++) {
    const r = byLoo[i];
    console.log(`  ${(i + 1).toString().padStart(2)} ${r.phase} minLoo=$${r.minLoo.toFixed(0).padStart(5)} full=$${r.fullPay.toFixed(0).padStart(6)} OOS=$${r.oosPay.toFixed(0).padStart(5)}  ${r.id.slice(0, 60)}`);
  }

  // Triple winners (top in each metric)
  const tripleQual = results.filter(r => {
    const fullRank = byFull.findIndex(x => x.id === r.id);
    const oosRank = byOos.findIndex(x => x.id === r.id);
    const looRank = byLoo.findIndex(x => x.id === r.id);
    return fullRank < 100 && oosRank < 100 && looRank < 100;
  });
  console.log(`\nConfigs ranked top-100 on ALL THREE metrics: ${tripleQual.length}`);
  if (tripleQual.length > 0) {
    console.log('\nTop 10 of triple-qual sorted by sum-of-ranks:');
    const tripleRanked = tripleQual.map(r => {
      const fr = byFull.findIndex(x => x.id === r.id);
      const or = byOos.findIndex(x => x.id === r.id);
      const lr = byLoo.findIndex(x => x.id === r.id);
      return { r, sumRank: fr + or + lr, fr, or, lr };
    }).sort((a, b) => a.sumRank - b.sumRank).slice(0, 10);
    for (const t of tripleRanked) {
      console.log(`  rank-sum=${t.sumRank} (full#${t.fr+1}, OOS#${t.or+1}, LOO#${t.lr+1}) full=$${t.r.fullPay.toFixed(0)} OOS=$${t.r.oosPay.toFixed(0)} minLoo=$${t.r.minLoo.toFixed(0)}  ${t.r.id.slice(0, 70)}`);
    }
  }

  // Phase distribution of top-100 by full
  const phaseDist: Record<string, number> = {};
  for (const r of byFull.slice(0, 100)) phaseDist[r.phase] = (phaseDist[r.phase] || 0) + 1;
  console.log('\nTop 100 by full — phase distribution:');
  for (const [p, n] of Object.entries(phaseDist)) console.log(`  ${p}: ${n}`);

  // Bin pattern distribution of top-100 by full
  const patDist: Record<string, number> = {};
  for (const r of byFull.slice(0, 100)) {
    const pat = r.cfg?.pattern || 'unknown';
    patDist[pat] = (patDist[pat] || 0) + 1;
  }
  console.log('\nTop 100 by full — bin pattern distribution:');
  for (const [p, n] of Object.entries(patDist)) console.log(`  ${p}: ${n}`);

  console.log(`\nJSON: ${OUT_JSON}`);

  // Markdown
  let md = `# MLB Megabin V2 Sweep Results\n\n`;
  md += `**${results.length} configs** evaluated across 13 slates (11 in-sample + 2 OOS).\n\n`;
  md += `## Top 25 by 13-slate full\n\n`;
  md += `| Rank | Phase | Full | OOS | Recent | min-LOO | Profit | id |\n|---:|---|---:|---:|---:|---:|---:|---|\n`;
  for (let i = 0; i < 25; i++) {
    const r = byFull[i];
    md += `| ${i + 1} | ${r.phase} | $${r.fullPay.toFixed(0)} | $${r.oosPay.toFixed(0)} | $${r.recentPay.toFixed(0)} | $${r.minLoo.toFixed(0)} | ${r.profitable}/${r.perSlate.length} | \`${r.id.slice(0, 60)}\` |\n`;
  }
  md += `\n## Triple-qualified (top-100 on full + OOS + min-LOO): ${tripleQual.length}\n\n`;
  md += `## Phase distribution of top-100 by full\n\n`;
  for (const [p, n] of Object.entries(phaseDist)) md += `- ${p}: ${n}\n`;
  fs.writeFileSync(OUT_MD, md);
  console.log(`MD: ${OUT_MD}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
