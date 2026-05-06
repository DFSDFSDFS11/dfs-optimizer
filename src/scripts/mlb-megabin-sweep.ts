/**
 * MLB Mega Bin Sweep — 3-4 hour autonomous search for anything that beats Apex.
 *
 * Apex baseline: λ=0.20, γ=7, extremeCornerCap=true, bins 10/30/35/20/5.
 *   Full: $54,869  Recent: $43,347  min-LOO: $2,951  Profitable: 5/11
 *
 * Phases (each 30-45 min):
 *   1. Ownership-bin-allocation simplex (random sample 5-tuples on 4-simplex)
 *   2. Bin count variations (3/4/5/6/7 bin schemes)
 *   3. Bin boundary variations (ownership delta cutoffs)
 *   4. Multi-knob random search (λ, γ, cornerQ5/Q1 %, teamCap, projFloor)
 *   5. Alternative bin dimensions (ceiling-floor ratio, salary, pitcher-tier)
 *   6. Bin fill-order variations
 *
 * Writes JSON incrementally. Tracks best-so-far by full, recent, min-LOO.
 * At end: final comparison + ship recommendation.
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
const OUT_JSON = path.join(DIR, 'mlb_megabin_sweep.json');
const OUT_MD = path.join(DIR, 'mlb_megabin_sweep.md');
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
];
const RECENT = new Set(['4-18-26', '4-19-26', '4-20-26', '4-21-26', '4-22-26']);

// Apex reference
const APEX_FULL = 54869;
const APEX_RECENT = 43347;
const APEX_MINLOO = 2951;

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }

function buildPayoutTable(F: number): Float64Array {
  const pool = F * FEE * 0.88; const cashLine = Math.floor(F * 0.22);
  const raw = new Float64Array(cashLine); let rawSum = 0;
  for (let r = 0; r < cashLine; r++) { raw[r] = Math.pow(r + 1, -1.15); rawSum += raw[r]; }
  const table = new Float64Array(F); const minCash = FEE * 1.2;
  for (let r = 0; r < cashLine; r++) table[r] = Math.max(minCash, (raw[r] / rawSum) * pool);
  let tSum = 0; for (let r = 0; r < cashLine; r++) tSum += table[r];
  const scale = pool / tSum;
  for (let r = 0; r < cashLine; r++) table[r] *= scale;
  return table;
}

function scoreLineup(lu: Lineup, actuals: ContestActuals, actualByHash: Map<string, number>): number | null {
  const h = lu.players.map(p => p.id).sort().join('|');
  const fa = actualByHash.get(h);
  if (fa !== undefined) return fa;
  let t = 0;
  for (const p of lu.players) { const r = actuals.playerActualsByName.get(norm(p.name)); if (!r) return null; t += r.fpts; }
  return t;
}

function payoutFor(actual: number, sorted: number[], payoutTable: Float64Array, actuals: ContestActuals): number {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (sorted[m] >= actual) lo = m + 1; else hi = m; }
  const rank = Math.max(1, lo);
  const pay = rank <= payoutTable.length ? payoutTable[rank - 1] : 0;
  if (pay <= 0) return 0;
  let co = 0;
  for (const e of actuals.entries) if (Math.abs(e.actualPoints - actual) <= 0.25) co++;
  co = Math.max(0, co - 1);
  return pay / Math.sqrt(1 + co * 0.5);
}

interface SlateData {
  slate: string;
  candidates: Lineup[];
  players: Player[];
  comboFreq: Map<string, number>;
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
  const comboFreq = precomputeComboFrequencies(loaded.lineups, 3);
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
  const anchor = computeAnchor(loaded.lineups, 50);
  return { slate: s.slate, candidates: loaded.lineups, players: pool.players, comboFreq, actuals, actualByHash, sorted, top1Thresh, payoutTable, F, anchor };
}

interface RunResult { pay: number; t1: number }
function runAndScore(sd: SlateData, cfg: Parameters<typeof productionSelect>[2]): RunResult {
  const result = productionSelect(sd.candidates, sd.players, cfg);
  let pay = 0, t1 = 0;
  for (const lu of result.portfolio) {
    const a = scoreLineup(lu, sd.actuals, sd.actualByHash);
    if (a === null) continue;
    pay += payoutFor(a, sd.sorted, sd.payoutTable, sd.actuals);
    if (a >= sd.top1Thresh) t1++;
  }
  return { pay, t1 };
}

interface ConfigResult {
  id: string;
  phase: string;
  cfg: any;
  fullPay: number;
  recentPay: number;
  minLoo: number;
  t1: number;
  profitable: number;
  perSlate: { slate: string; pay: number; t1: number }[];
}

function evaluateConfig(id: string, phase: string, cfg: any, runCfg: Parameters<typeof productionSelect>[2], cache: SlateData[]): ConfigResult {
  const perSlate: { slate: string; pay: number; t1: number }[] = [];
  let fullPay = 0, recentPay = 0, t1 = 0, profitable = 0;
  for (const sd of cache) {
    const r = runAndScore(sd, runCfg);
    perSlate.push({ slate: sd.slate, pay: r.pay, t1: r.t1 });
    fullPay += r.pay; t1 += r.t1;
    if (r.pay > FEE * N) profitable++;
    if (RECENT.has(sd.slate)) recentPay += r.pay;
  }
  const pays = perSlate.map(x => x.pay);
  const loos = pays.map((_, i) => { let s = 0, cnt = 0; for (let j = 0; j < pays.length; j++) if (j !== i) { s += pays[j]; cnt++; } return cnt ? s / cnt : 0; });
  const minLoo = Math.min(...loos);
  return { id, phase, cfg, fullPay, recentPay, minLoo, t1, profitable, perSlate };
}

// =============================================================================
// RANDOM SIMPLEX SAMPLING
// =============================================================================

function randomSimplexPoint(dim: number, minEach: number = 0): number[] {
  // Uniform random point on the (dim-1)-simplex with each coord >= minEach
  let remaining = 1 - dim * minEach;
  if (remaining < 0) { const v = 1 / dim; return new Array(dim).fill(v); }
  // Break remaining into dim pieces using random breakpoints
  const breaks = [0, ...Array.from({ length: dim - 1 }, () => Math.random()).sort(), 1];
  return breaks.slice(1).map((b, i) => minEach + (b - breaks[i]) * remaining);
}

// =============================================================================
// PHASES
// =============================================================================

async function main() {
  console.log('================================================================');
  console.log('MLB MEGA BIN SWEEP — autonomous 3-4 hour search vs Apex');
  console.log('================================================================\n');
  console.log(`Apex baseline: Full $${APEX_FULL}  Recent $${APEX_RECENT}  min-LOO $${APEX_MINLOO}\n`);

  const t_start = Date.now();
  const BUDGET_MS = 3.5 * 60 * 60 * 1000; // 3.5 hours

  console.log('Loading 11 slates...');
  const cache: SlateData[] = [];
  for (const s of SLATES) {
    try { const c = await loadSlate(s); if (c) cache.push(c); } catch (e: any) { console.log(`  skip ${s.slate}: ${e.message}`); }
  }
  console.log(`${cache.length} slates loaded.\n`);

  const results: ConfigResult[] = [];
  let bestByFull: ConfigResult | null = null;
  let bestByRecent: ConfigResult | null = null;
  let bestByLoo: ConfigResult | null = null;
  let triplePointers: ConfigResult[] = []; // beats Apex on all three

  const tryConfig = (id: string, phase: string, cfgMeta: any, runCfg: Parameters<typeof productionSelect>[2]) => {
    const r = evaluateConfig(id, phase, cfgMeta, runCfg, cache);
    results.push(r);
    if (!bestByFull || r.fullPay > bestByFull.fullPay) bestByFull = r;
    if (!bestByRecent || r.recentPay > bestByRecent.recentPay) bestByRecent = r;
    if (!bestByLoo || r.minLoo > bestByLoo.minLoo) bestByLoo = r;
    if (r.fullPay > APEX_FULL && r.recentPay > APEX_RECENT && r.minLoo > APEX_MINLOO) triplePointers.push(r);

    // Incremental progress log
    if (results.length % 50 === 0) {
      const elapsedMin = (Date.now() - t_start) / 60000;
      console.log(`  [${results.length} configs, ${elapsedMin.toFixed(1)} min] best full=$${bestByFull.fullPay.toFixed(0)} recent=$${bestByRecent.recentPay.toFixed(0)} min-LOO=$${bestByLoo.minLoo.toFixed(0)} triple=${triplePointers.length}`);
    }
    // Persist every 100 configs
    if (results.length % 100 === 0) fs.writeFileSync(OUT_JSON, JSON.stringify({ results, triplePointers }, null, 2));
  };

  const timeOut = () => Date.now() - t_start > BUDGET_MS;

  // ==========================================================================
  // PHASE 1 — Ownership bin allocation simplex sampling (5-bin default structure)
  // Apex parameters held fixed: λ=0.20, γ=7, corner=true.
  // 2000 random simplex points sampled.
  // ==========================================================================
  console.log('\n=== PHASE 1: 5-bin allocation simplex (2000 random tuples) ===\n');
  for (let i = 0; i < 2000 && !timeOut(); i++) {
    const alloc = randomSimplexPoint(5, 0.02); // at least 2% per bin
    const id = `P1:${alloc.map(v => v.toFixed(2)).join('/')}`;
    tryConfig(id, 'P1', { alloc }, {
      N, lambda: 0.20, maxOverlap: 7, extremeCornerCap: true,
      binAllocation: { chalk: alloc[0], core: alloc[1], value: alloc[2], contra: alloc[3], deep: alloc[4] },
    });
  }

  // ==========================================================================
  // PHASE 2 — Multi-knob random search on Apex neighborhood
  // Random sample: λ ∈ [0.05, 0.40], γ ∈ [4, 10], projFloor ∈ {0, 0.85, 0.90}, corner on/off,
  // bin alloc from simplex, teamCap ∈ [0.08, 0.20], own-drop ∈ [3, 10].
  // 2000 configs.
  // ==========================================================================
  console.log('\n=== PHASE 2: Multi-knob random search (2000 configs) ===\n');
  const lambdaSet = [0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40];
  const gammaSet = [5, 6, 7, 8, 10];
  const floorSet = [0, 0.85, 0.90];
  const teamCapSet = [0.08, 0.10, 0.12, 0.15, 0.18, 0.20];
  for (let i = 0; i < 2000 && !timeOut(); i++) {
    const lam = lambdaSet[Math.floor(Math.random() * lambdaSet.length)];
    const gam = gammaSet[Math.floor(Math.random() * gammaSet.length)];
    const fl = floorSet[Math.floor(Math.random() * floorSet.length)];
    const tc = teamCapSet[Math.floor(Math.random() * teamCapSet.length)];
    const corner = Math.random() < 0.75; // 75% corner on (it's a validated winner)
    const alloc = randomSimplexPoint(5, 0.02);
    const id = `P2:lam${lam}|gam${gam}|fl${fl}|tc${tc.toFixed(2)}|c${corner ? 1 : 0}|${alloc.map(v => v.toFixed(2)).join('/')}`;
    tryConfig(id, 'P2', { lam, gam, fl, tc, corner, alloc }, {
      N, lambda: lam, maxOverlap: gam, teamCapPct: tc, projectionFloorPct: fl,
      extremeCornerCap: corner,
      binAllocation: { chalk: alloc[0], core: alloc[1], value: alloc[2], contra: alloc[3], deep: alloc[4] },
    });
  }

  // ==========================================================================
  // PHASE 3 — Extreme corner % sweep (how much to cap Q5/Q5 and Q1/Q1)
  // Apex uses 25/5. Test ranges.
  // ==========================================================================
  console.log('\n=== PHASE 3: Extreme-corner percentage sweep ===\n');
  const q5Set = [0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.50];
  const q1Set = [0.02, 0.05, 0.08, 0.10, 0.15, 0.20];
  for (const q5 of q5Set) for (const q1 of q1Set) {
    if (timeOut()) break;
    const id = `P3:q5${q5}|q1${q1}`;
    tryConfig(id, 'P3', { q5, q1 }, {
      N, lambda: 0.20, maxOverlap: 7, extremeCornerCap: true,
      extremeCornerQ5Q5Pct: q5, extremeCornerQ1Q1Pct: q1,
    });
  }

  // ==========================================================================
  // PHASE 4 — Own-drop PP variations (anchor - Xpp target)
  // Test with useOwnershipCeiling on (since default useOwnershipCeiling=false makes ownDrop dead code).
  // ==========================================================================
  console.log('\n=== PHASE 4: Ownership ceiling filter variations ===\n');
  for (const od of [3, 4, 5, 6, 7, 8, 10]) {
    for (const buf of [-3, -1, 0, 1, 3, 5]) {
      if (timeOut()) break;
      const id = `P4:od${od}|buf${buf}`;
      tryConfig(id, 'P4', { od, buf }, {
        N, lambda: 0.20, maxOverlap: 7, extremeCornerCap: true,
        ownDropPP: od, ownershipCeilingBuffer: buf, useOwnershipCeiling: true,
      });
    }
  }

  // ==========================================================================
  // PHASE 5 — Focused refinement around best Phase 1+2 configs
  // Take top 20 from prior phases, perturb each 50x with small random walks.
  // ==========================================================================
  console.log('\n=== PHASE 5: Local refinement around Phase 1-2 winners ===\n');
  const phase12 = results.filter(r => r.phase === 'P1' || r.phase === 'P2')
    .sort((a, b) => b.fullPay - a.fullPay).slice(0, 20);
  for (const winner of phase12) {
    if (timeOut()) break;
    for (let i = 0; i < 50 && !timeOut(); i++) {
      // Perturb allocation
      const base: number[] = winner.cfg.alloc || [0.10, 0.30, 0.35, 0.20, 0.05];
      const perturbed = base.map(v => Math.max(0.01, v + (Math.random() - 0.5) * 0.06));
      const sum = perturbed.reduce((a, b) => a + b, 0);
      const alloc = perturbed.map(v => v / sum);
      const lam = winner.cfg.lam ?? 0.20;
      const lamPerturbed = Math.max(0.01, Math.min(0.50, lam + (Math.random() - 0.5) * 0.10));
      const id = `P5:${winner.id.slice(0, 30)}|pert${i}`;
      tryConfig(id, 'P5', { base: winner.id, alloc, lam: lamPerturbed }, {
        N, lambda: lamPerturbed, maxOverlap: winner.cfg.gam ?? 7,
        teamCapPct: winner.cfg.tc ?? 0.10,
        extremeCornerCap: winner.cfg.corner ?? true,
        projectionFloorPct: winner.cfg.fl ?? 0,
        binAllocation: { chalk: alloc[0], core: alloc[1], value: alloc[2], contra: alloc[3], deep: alloc[4] },
      });
    }
  }

  // ==========================================================================
  // PHASE 6 — Pure ownership bin allocation grid-sweep at finer resolution
  // Constrained simplex: chalk and deep bounded tighter, core/value/contra wider.
  // ==========================================================================
  console.log('\n=== PHASE 6: Constrained-simplex 5-bin grid (2000 samples) ===\n');
  for (let i = 0; i < 2000 && !timeOut(); i++) {
    // Constrain: chalk ∈ [0.05, 0.25], deep ∈ [0.00, 0.15], others [0.05, 0.60]
    const chalk = 0.05 + Math.random() * 0.20;
    const deep = Math.random() * 0.15;
    const rem = 1 - chalk - deep;
    const pts = randomSimplexPoint(3, 0.05);
    const core = pts[0] * rem;
    const value = pts[1] * rem;
    const contra = pts[2] * rem;
    const alloc = [chalk, core, value, contra, deep];
    const id = `P6:${alloc.map(v => v.toFixed(2)).join('/')}`;
    tryConfig(id, 'P6', { alloc }, {
      N, lambda: 0.20, maxOverlap: 7, extremeCornerCap: true,
      binAllocation: { chalk, core, value, contra, deep },
    });
  }

  // ==========================================================================
  // PHASE 7 — Gamma + Corner + Floor joint sweep
  // Exhaustive over a small grid.
  // ==========================================================================
  console.log('\n=== PHASE 7: γ × corner × floor joint sweep ===\n');
  for (const gam of [5, 6, 7, 8, 9, 10]) {
    for (const fl of [0, 0.80, 0.85, 0.88, 0.90, 0.92, 0.94]) {
      for (const corner of [true, false]) {
        if (timeOut()) break;
        const id = `P7:gam${gam}|fl${fl}|c${corner ? 1 : 0}`;
        tryConfig(id, 'P7', { gam, fl, corner }, {
          N, lambda: 0.20, maxOverlap: gam, extremeCornerCap: corner, projectionFloorPct: fl,
        });
      }
    }
  }

  // ==========================================================================
  // PHASE 8 — Lambda × team-cap grid
  // ==========================================================================
  console.log('\n=== PHASE 8: λ × team-cap grid ===\n');
  for (const lam of [0.00, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50]) {
    for (const tc of [0.06, 0.08, 0.10, 0.12, 0.15, 0.18, 0.20, 0.25]) {
      if (timeOut()) break;
      const id = `P8:lam${lam}|tc${tc}`;
      tryConfig(id, 'P8', { lam, tc }, {
        N, lambda: lam, maxOverlap: 7, teamCapPct: tc, extremeCornerCap: true,
      });
    }
  }

  // ==========================================================================
  // PHASE 9 — Continuous random fill
  // Fill remaining time budget with fully random multi-knob configs.
  // ==========================================================================
  console.log('\n=== PHASE 9: Continuous random fill until budget exhausts ===\n');
  while (!timeOut()) {
    const lam = Math.random() * 0.50;
    const gam = 4 + Math.floor(Math.random() * 7); // 4-10
    const fl = Math.random() < 0.5 ? 0 : (0.80 + Math.random() * 0.12);
    const tc = 0.06 + Math.random() * 0.16;
    const corner = Math.random() < 0.75;
    const q5 = 0.10 + Math.random() * 0.35;
    const q1 = 0.02 + Math.random() * 0.15;
    const alloc = randomSimplexPoint(5, 0.02);
    const id = `P9:${lam.toFixed(3)}|${gam}|${fl.toFixed(2)}|${tc.toFixed(2)}|${corner ? 'c' : 'n'}|${alloc.map(v => v.toFixed(2)).join('/')}`;
    tryConfig(id, 'P9', { lam, gam, fl, tc, corner, q5, q1, alloc }, {
      N, lambda: lam, maxOverlap: gam, teamCapPct: tc, projectionFloorPct: fl,
      extremeCornerCap: corner, extremeCornerQ5Q5Pct: q5, extremeCornerQ1Q1Pct: q1,
      binAllocation: { chalk: alloc[0], core: alloc[1], value: alloc[2], contra: alloc[3], deep: alloc[4] },
    });
  }

  // Final persist
  fs.writeFileSync(OUT_JSON, JSON.stringify({ results, triplePointers }, null, 2));

  // ==========================================================================
  // ANALYSIS
  // ==========================================================================
  console.log('\n\n================================================================');
  console.log(`SWEEP COMPLETE — ${results.length} configs evaluated in ${((Date.now() - t_start) / 60000).toFixed(1)} min`);
  console.log('================================================================\n');

  console.log(`Configs that beat Apex on:`);
  const beatFull = results.filter(r => r.fullPay > APEX_FULL);
  const beatRecent = results.filter(r => r.recentPay > APEX_RECENT);
  const beatLoo = results.filter(r => r.minLoo > APEX_MINLOO);
  console.log(`  Full-sample payout ($${APEX_FULL}):      ${beatFull.length}`);
  console.log(`  Recent-5 payout ($${APEX_RECENT}):       ${beatRecent.length}`);
  console.log(`  min-LOO ($${APEX_MINLOO}):               ${beatLoo.length}`);
  console.log(`  TRIPLE (all three beats Apex):       ${triplePointers.length}`);

  console.log('\n=== TOP 15 BY FULL ===\n');
  const byFull = [...results].sort((a, b) => b.fullPay - a.fullPay).slice(0, 15);
  for (const r of byFull) {
    console.log(`  ${r.phase} full=$${r.fullPay.toFixed(0).padStart(6)} recent=$${r.recentPay.toFixed(0).padStart(6)} minLoo=$${r.minLoo.toFixed(0).padStart(5)} profit=${r.profitable}/11  ${r.id.slice(0, 60)}`);
  }

  console.log('\n=== TOP 15 BY RECENT ===\n');
  const byRecent = [...results].sort((a, b) => b.recentPay - a.recentPay).slice(0, 15);
  for (const r of byRecent) {
    console.log(`  ${r.phase} recent=$${r.recentPay.toFixed(0).padStart(6)} full=$${r.fullPay.toFixed(0).padStart(6)} minLoo=$${r.minLoo.toFixed(0).padStart(5)} profit=${r.profitable}/11  ${r.id.slice(0, 60)}`);
  }

  console.log('\n=== TOP 15 BY min-LOO (most robust) ===\n');
  const byLoo = [...results].sort((a, b) => b.minLoo - a.minLoo).slice(0, 15);
  for (const r of byLoo) {
    console.log(`  ${r.phase} minLoo=$${r.minLoo.toFixed(0).padStart(5)} full=$${r.fullPay.toFixed(0).padStart(6)} recent=$${r.recentPay.toFixed(0).padStart(6)} profit=${r.profitable}/11  ${r.id.slice(0, 60)}`);
  }

  if (triplePointers.length > 0) {
    console.log('\n=== TRIPLE WINNERS (beat Apex on full + recent + min-LOO) ===\n');
    const tp = [...triplePointers].sort((a, b) => b.fullPay - a.fullPay);
    for (const r of tp.slice(0, 25)) {
      console.log(`  ${r.phase} full=$${r.fullPay} recent=$${r.recentPay} minLoo=$${r.minLoo.toFixed(0)} profit=${r.profitable}/11`);
      console.log(`    cfg: ${JSON.stringify(r.cfg).slice(0, 150)}`);
    }
  }

  // Markdown summary
  let md = `# MLB Mega Bin Sweep Results\n\n`;
  md += `**${results.length} configs** evaluated in ${((Date.now() - t_start) / 60000).toFixed(1)} min.\n\n`;
  md += `## vs Apex baseline (full $${APEX_FULL}, recent $${APEX_RECENT}, min-LOO $${APEX_MINLOO}):\n\n`;
  md += `- Beat full: **${beatFull.length}** (${(beatFull.length / results.length * 100).toFixed(1)}%)\n`;
  md += `- Beat recent: **${beatRecent.length}** (${(beatRecent.length / results.length * 100).toFixed(1)}%)\n`;
  md += `- Beat min-LOO: **${beatLoo.length}** (${(beatLoo.length / results.length * 100).toFixed(1)}%)\n`;
  md += `- **Triple winners: ${triplePointers.length}**\n\n`;
  md += `## Top 25 by full-sample\n\n`;
  md += `| Rank | Phase | Full | Recent | min-LOO | Profit | id |\n|---:|---|---:|---:|---:|---:|---|\n`;
  for (let i = 0; i < Math.min(25, byFull.length); i++) {
    const r = byFull[i];
    md += `| ${i + 1} | ${r.phase} | $${r.fullPay.toFixed(0)} | $${r.recentPay.toFixed(0)} | $${r.minLoo.toFixed(0)} | ${r.profitable}/11 | \`${r.id.slice(0, 70)}\` |\n`;
  }
  if (triplePointers.length > 0) {
    md += `\n## Triple winners (beat Apex on all 3 metrics)\n\n`;
    const tpSorted = [...triplePointers].sort((a, b) => b.fullPay - a.fullPay);
    md += `| Rank | Full | Recent | min-LOO | Profit | cfg |\n|---:|---:|---:|---:|---:|---|\n`;
    for (let i = 0; i < Math.min(30, tpSorted.length); i++) {
      const r = tpSorted[i];
      md += `| ${i + 1} | $${r.fullPay.toFixed(0)} | $${r.recentPay.toFixed(0)} | $${r.minLoo.toFixed(0)} | ${r.profitable}/11 | ${JSON.stringify(r.cfg).slice(0, 120)} |\n`;
    }
  }
  fs.writeFileSync(OUT_MD, md);
  console.log(`\nJSON: ${OUT_JSON}`);
  console.log(`MD:   ${OUT_MD}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
