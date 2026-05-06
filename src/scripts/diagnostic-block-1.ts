/**
 * Block 1 Diagnostics — three gate-checks for the downstream experiment plan.
 *
 *   (A) Chalk-bin payout contribution: for production's current shipped config across
 *       10 slates, how much of payout / top-1% hits come from chalk bin specifically?
 *       Gates whether chalk-avoidance architecture is worth testing.
 *
 *   (B) Projection-vs-ceiling correlation: across pool lineups on typical slate,
 *       what's the Pearson correlation between projection and simulated p90 ceiling?
 *       If >0.95, ceiling sweeps are dead on arrival.
 *
 *   (C) Variance / correlation calibration against actuals: per-player standardized
 *       residuals from 10 slates of actuals. Are SaberSim's percentile stddevs
 *       well-calibrated? What's empirical teammate correlation vs t-copula's +0.12?
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals } from '../parser';
import { getContestConfig } from '../rules';
import { productionSelect } from '../selection/production-selector';
import { precomputeComboFrequencies } from '../selection/combo-leverage';
import { generateWorlds } from '../v35/simulation';

const DIR = 'C:/Users/colin/dfs opto';
const FEE = 20;
const N = 150;
const LAMBDA = 0.05;
const GAMMA = 7;
const NUM_WORLDS = 1000;
const SEED = 12345;

const SLATES = [
  { slate: '4-6-26', proj: '4-6-26_projections.csv', actuals: 'dkactuals 4-6-26.csv', pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26', proj: '4-8-26projections.csv', actuals: '4-8-26actuals.csv', pool: '4-8-26sspool.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv', actuals: '4-12-26actuals.csv', pool: '4-12-26sspool.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv', actuals: '4-14-26actuals.csv', pool: '4-14-26sspool.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv', actuals: '4-15-26actuals.csv', pool: '4-15-26sspool.csv' },
  { slate: '4-17-26', proj: '4-17-26projections.csv', actuals: '4-17-26actuals.csv', pool: '4-17-26sspool.csv' },
  { slate: '4-18-26', proj: '4-18-26projections.csv', actuals: '4-18-26actuals.csv', pool: '4-18-26sspool.csv' },
  { slate: '4-19-26', proj: '4-19-26projections.csv', actuals: '4-19-26actuals.csv', pool: '4-19-26sspool.csv' },
  { slate: '4-20-26', proj: '4-20-26projections.csv', actuals: '4-20-26actuals.csv', pool: '4-20-26sspool.csv' },
  { slate: '4-21-26', proj: '4-21-26projections.csv', actuals: '4-21-26actuals.csv', pool: '4-21-26sspool.csv' },
];

// Same bin structure as production-selector.ts
const OWNERSHIP_BINS = [
  { label: 'chalk',  deltaLo: -2,  deltaHi: 99 },
  { label: 'core',   deltaLo: -5,  deltaHi: -2 },
  { label: 'value',  deltaLo: -8,  deltaHi: -5 },
  { label: 'contra', deltaLo: -12, deltaHi: -8 },
  { label: 'deep',   deltaLo: -20, deltaHi: -12 },
];

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function mean(arr: number[] | Float64Array): number { if (!arr.length) return 0; let s = 0; for (let i = 0; i < arr.length; i++) s += arr[i]; return s / arr.length; }
function std(arr: number[] | Float64Array): number { if (arr.length < 2) return 0; const m = mean(arr); let s = 0; for (let i = 0; i < arr.length; i++) s += (arr[i] - m) ** 2; return Math.sqrt(s / arr.length); }
function pearson(xs: number[], ys: number[]): number {
  const n = xs.length; if (n < 2) return 0;
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; num += dx * dy; dx2 += dx * dx; dy2 += dy * dy; }
  return num / (Math.sqrt(dx2 * dy2) || 1);
}
function percentile(arr: number[], p: number): number { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.max(0, Math.min(s.length - 1, Math.floor(p * s.length)))]; }

function buildPayoutTable(F: number): Float64Array {
  const pool = F * FEE * 0.88;
  const cashLine = Math.floor(F * 0.22);
  const raw = new Float64Array(cashLine);
  let rawSum = 0;
  for (let r = 0; r < cashLine; r++) { raw[r] = Math.pow(r + 1, -1.15); rawSum += raw[r]; }
  const table = new Float64Array(F);
  const minCash = FEE * 1.2;
  for (let r = 0; r < cashLine; r++) table[r] = Math.max(minCash, (raw[r] / rawSum) * pool);
  let tSum = 0;
  for (let r = 0; r < cashLine; r++) tSum += table[r];
  const scale = pool / tSum;
  for (let r = 0; r < cashLine; r++) table[r] *= scale;
  return table;
}

function scoreLineup(lu: Lineup, actuals: ContestActuals, actualByHash: Map<string, number>, sortedDesc: number[], top1T: number, payoutTable: Float64Array) {
  const hash = lu.players.map(p => p.id).sort().join('|');
  let a: number | null = actualByHash.get(hash) ?? null;
  if (a === null) {
    let t = 0, miss = false;
    for (const p of lu.players) {
      const r = actuals.playerActualsByName.get(norm(p.name));
      if (!r) { miss = true; break; }
      t += r.fpts;
    }
    if (!miss) a = t;
  }
  if (a === null) return { payout: 0, isT1: false };
  let lo = 0, hi = sortedDesc.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (sortedDesc[m] >= a) lo = m + 1; else hi = m; }
  const rank = Math.max(1, lo);
  const isT1 = a >= top1T;
  let payout = rank <= payoutTable.length ? payoutTable[rank - 1] : 0;
  if (payout > 0) {
    let coWin = 0;
    for (const e of actuals.entries) if (Math.abs(e.actualPoints - a) <= 0.25) coWin++;
    coWin = Math.max(0, coWin - 1);
    payout /= Math.sqrt(1 + coWin * 0.5);
  }
  return { payout, isT1 };
}

function computeAnchorOwnership(pool: Lineup[], topK = 50): number {
  const sorted = [...pool].sort((a, b) => b.projection - a.projection).slice(0, Math.min(topK, pool.length));
  return mean(sorted.map(lu => mean(lu.players.map(p => p.ownership || 0))));
}

function assignBin(ownership: number, anchorOwn: number): string | null {
  const delta = ownership - anchorOwn;
  for (const b of OWNERSHIP_BINS) if (delta >= b.deltaLo && delta < b.deltaHi) return b.label;
  return null;
}

async function main() {
  console.log('================================================================');
  console.log('BLOCK 1 DIAGNOSTICS — gates for downstream experiment plan');
  console.log('================================================================\n');

  // (A) Chalk bin contribution aggregators
  const binPayouts = new Map<string, number>();
  const binHits = new Map<string, number>();
  const binLineupCounts = new Map<string, number>();

  // (B) Projection-ceiling correlations per slate
  const perSlateProjCeilingCorr: { slate: string; corr: number; poolSize: number }[] = [];

  // (C) Residual aggregators
  const allStdResiduals: number[] = [];
  const teammateCorrSamples: number[] = [];
  const oppCorrSamples: number[] = [];
  const pitcherVsOppCorrSamples: number[] = [];

  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj);
    const actualsPath = path.join(DIR, s.actuals);
    const poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) continue;

    console.log(`\n=== ${s.slate} ===`);
    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);
    const F = actuals.entries.length;
    const nameMap = new Map<string, Player>();
    for (const p of pool.players) nameMap.set(norm(p.name), p);
    const idMap = new Map<string, Player>();
    for (const p of pool.players) idMap.set(p.id, p);
    const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
    const actualByHash = new Map<string, number>();
    for (const e of actuals.entries) {
      const pls: Player[] = [];
      let ok = true;
      for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
      if (!ok) continue;
      actualByHash.set(pls.map(p => p.id).sort().join('|'), e.actualPoints);
    }
    const comboFreq = precomputeComboFrequencies(loaded.lineups, 3);
    const payoutTable = buildPayoutTable(F);
    const sortedDesc = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
    const top1T = sortedDesc[Math.max(0, Math.floor(F * 0.01) - 1)] || 0;

    // (A) Run production with shipped config, partition hits by bin
    const result = productionSelect(loaded.lineups, pool.players, { N, lambda: LAMBDA, comboFreq, maxOverlap: GAMMA });
    const anchorOwn = computeAnchorOwnership(loaded.lineups, 50);
    for (const lu of result.portfolio) {
      const luOwn = mean(lu.players.map(p => p.ownership || 0));
      const bin = assignBin(luOwn, anchorOwn) ?? 'unbinned';
      binLineupCounts.set(bin, (binLineupCounts.get(bin) || 0) + 1);
      const sc = scoreLineup(lu, actuals, actualByHash, sortedDesc, top1T, payoutTable);
      binPayouts.set(bin, (binPayouts.get(bin) || 0) + sc.payout);
      if (sc.isT1) binHits.set(bin, (binHits.get(bin) || 0) + 1);
    }

    // (B) Generate scenarios, compute ceiling for each pool lineup
    console.log(`  Generating ${NUM_WORLDS} scenarios for ${pool.players.length} players...`);
    const sim = generateWorlds(pool.players, NUM_WORLDS, 5, SEED);
    const playerIdx = new Map<string, number>();
    for (let i = 0; i < pool.players.length; i++) playerIdx.set(pool.players[i].id, i);

    // Sample up to 1500 pool lineups for correlation (compute cost)
    const sample = loaded.lineups.slice(0, Math.min(1500, loaded.lineups.length));
    const projs: number[] = [];
    const ceilings: number[] = [];
    for (const lu of sample) {
      const indices: number[] = [];
      for (const p of lu.players) { const idx = playerIdx.get(p.id); if (idx !== undefined) indices.push(idx); }
      const scores = new Float64Array(NUM_WORLDS);
      for (let w = 0; w < NUM_WORLDS; w++) { let sum = 0; for (const pi of indices) sum += sim.scores[pi * NUM_WORLDS + w]; scores[w] = sum; }
      const sortedScores = [...scores].sort((a, b) => a - b);
      const p90 = sortedScores[Math.floor(NUM_WORLDS * 0.9)];
      projs.push(lu.projection);
      ceilings.push(p90);
    }
    const corr = pearson(projs, ceilings);
    perSlateProjCeilingCorr.push({ slate: s.slate, corr, poolSize: sample.length });
    console.log(`  (B) proj-ceiling corr: ${corr.toFixed(3)} over ${sample.length} lineups`);

    // (C) Per-player residual analysis: for every player with actual fpts AND projection+stddev, compute (actual - projection) / stddev
    // Estimate player stddev from SaberSim percentiles: σ ≈ (p75 - p25) / 1.35 (interquartile approximation)
    for (const [normName, playerActual] of actuals.playerActualsByName) {
      const proj = pool.players.find(p => norm(p.name) === normName);
      if (!proj || !proj.percentiles) continue;
      const p25 = proj.percentiles.p25, p75 = proj.percentiles.p75;
      if (p25 === undefined || p75 === undefined || p75 <= p25) continue;
      const sigma = (p75 - p25) / 1.35;
      if (sigma <= 0) continue;
      const residual = (playerActual.fpts - (proj.projection || 0)) / sigma;
      if (isFinite(residual) && Math.abs(residual) < 10) allStdResiduals.push(residual);
    }

    // (C cont.) Empirical teammate correlation: for teams with ≥3 players with actuals, compute pairwise correlation of (actual - projection)
    const teamPlayers = new Map<string, { name: string; resid: number; opp?: string }[]>();
    for (const p of pool.players) {
      if (p.positions?.includes('P')) continue;
      const pa = actuals.playerActualsByName.get(norm(p.name));
      if (!pa || !p.percentiles) continue;
      const sigma = ((p.percentiles.p75 ?? 0) - (p.percentiles.p25 ?? 0)) / 1.35;
      if (sigma <= 0) continue;
      const resid = (pa.fpts - (p.projection || 0)) / sigma;
      if (!isFinite(resid)) continue;
      if (!teamPlayers.has(p.team)) teamPlayers.set(p.team, []);
      teamPlayers.get(p.team)!.push({ name: p.name, resid, opp: p.opponent });
    }
    // Pairwise within same team
    for (const [, plist] of teamPlayers) {
      for (let i = 0; i < plist.length; i++) for (let j = i + 1; j < plist.length; j++) {
        // For single pair, correlation is 1 or -1 — not useful. Instead: we aggregate as covariance-like samples
        // Use the PRODUCT of standardized residuals as a correlation proxy (expected 0 if independent, +1 if perfectly correlated)
        teammateCorrSamples.push(plist[i].resid * plist[j].resid);
      }
    }
    // Opposing (same game, different team)
    for (const [teamA, plistA] of teamPlayers) {
      for (const p of plistA) {
        if (!p.opp) continue;
        const plistB = teamPlayers.get(p.opp);
        if (!plistB) continue;
        for (const p2 of plistB) oppCorrSamples.push(p.resid * p2.resid);
      }
    }
    // Pitcher vs opposing batters
    for (const p of pool.players) {
      if (!p.positions?.includes('P')) continue;
      const pa = actuals.playerActualsByName.get(norm(p.name));
      if (!pa || !p.percentiles) continue;
      const sigmaP = ((p.percentiles.p75 ?? 0) - (p.percentiles.p25 ?? 0)) / 1.35;
      if (sigmaP <= 0) continue;
      const residP = (pa.fpts - (p.projection || 0)) / sigmaP;
      if (!isFinite(residP) || !p.opponent) continue;
      const oppBatters = teamPlayers.get(p.opponent);
      if (!oppBatters) continue;
      for (const b of oppBatters) pitcherVsOppCorrSamples.push(residP * b.resid);
    }
  }

  // ============================================================
  // REPORT
  // ============================================================
  console.log('\n\n================================================================');
  console.log('DIAGNOSTIC RESULTS');
  console.log('================================================================');

  // (A) Chalk bin contribution
  console.log('\n--- (A) Chalk-bin payout contribution (across 10 slates, production shipped config) ---');
  console.log('Bin       | Lineups | Top-1% hits | Total payout | $/lineup | $/slate');
  let grandPay = 0, grandHits = 0, grandLineups = 0;
  for (const b of ['chalk', 'core', 'value', 'contra', 'deep', 'unbinned']) {
    const lc = binLineupCounts.get(b) || 0;
    const h = binHits.get(b) || 0;
    const p = binPayouts.get(b) || 0;
    grandLineups += lc; grandHits += h; grandPay += p;
    if (lc > 0) console.log(`  ${b.padEnd(8)} | ${lc.toString().padStart(7)} | ${h.toString().padStart(11)} | $${p.toFixed(0).padStart(11)} | $${(p / lc).toFixed(1).padStart(7)} | $${(p / SLATES.length).toFixed(0).padStart(6)}`);
  }
  console.log(`  TOTAL    | ${grandLineups} | ${grandHits} | $${grandPay.toFixed(0)} | $${(grandPay / grandLineups).toFixed(1)} | $${(grandPay / SLATES.length).toFixed(0)}`);
  const chalkPct = (binPayouts.get('chalk') || 0) / Math.max(1, grandPay) * 100;
  console.log(`\n  CHALK share of total payout: ${chalkPct.toFixed(1)}%`);
  const chalkPerSlate = (binPayouts.get('chalk') || 0) / SLATES.length;
  let chalkInterp = '';
  if (chalkPerSlate < 500) chalkInterp = 'CHEAP to eliminate — chalk contributes little';
  else if (chalkPerSlate < 2000) chalkInterp = 'MODERATE cost — chalk-avoidance needs to earn its keep';
  else chalkInterp = 'EXPENSIVE to eliminate — chalk is structurally important';
  console.log(`  Interpretation: ${chalkInterp}`);

  // (B) Projection-ceiling correlation
  console.log('\n--- (B) Projection-vs-ceiling (simulated p90) correlation per slate ---');
  console.log('Slate     | Pool sample | Pearson r');
  for (const x of perSlateProjCeilingCorr) console.log(`  ${x.slate.padEnd(9)} | ${x.poolSize.toString().padStart(11)} | ${x.corr.toFixed(3)}`);
  const avgCorr = mean(perSlateProjCeilingCorr.map(x => x.corr));
  console.log(`\n  CROSS-SLATE avg: ${avgCorr.toFixed(3)}`);
  let corrInterp = '';
  if (avgCorr >= 0.95) corrInterp = 'DEAD ON ARRIVAL — ceiling is redundant with projection';
  else if (avgCorr >= 0.85) corrInterp = 'MARGINAL — ceiling adds weak independent signal';
  else if (avgCorr >= 0.70) corrInterp = 'WORTH TESTING — ceiling is meaningfully orthogonal';
  else corrInterp = 'STRONG SIGNAL — ceiling is substantially independent of projection';
  console.log(`  Interpretation: ${corrInterp}`);

  // (C) Variance calibration
  console.log('\n--- (C) Per-player residual calibration ---');
  console.log(`  Samples: ${allStdResiduals.length} player-slate residuals`);
  const residMean = mean(allStdResiduals), residStd = std(allStdResiduals);
  console.log(`  Residual mean (should ≈ 0): ${residMean.toFixed(3)}`);
  console.log(`  Residual stddev (should ≈ 1 if σ well-calibrated): ${residStd.toFixed(3)}`);
  const p99 = percentile(allStdResiduals.filter(x => x > 0), 0.99);
  const tailFrac = allStdResiduals.filter(x => Math.abs(x) > 1.64).length / allStdResiduals.length * 100;
  console.log(`  |residual| > 1.64 (outside p90 symmetric): ${tailFrac.toFixed(1)}% (expected 10% for normal)`);
  let sigmaInterp = '';
  if (residStd > 1.15) sigmaInterp = 'SaberSim variances TOO NARROW by ~' + ((residStd - 1) * 100).toFixed(0) + '%';
  else if (residStd < 0.85) sigmaInterp = 'SaberSim variances TOO WIDE by ~' + ((1 - residStd) * 100).toFixed(0) + '%';
  else sigmaInterp = 'SaberSim variances well-calibrated (±15%)';
  console.log(`  Interpretation: ${sigmaInterp}`);

  console.log('\n--- (C cont.) Empirical correlation vs t-copula assumptions ---');
  console.log(`  Teammate pair residual product (proxy for correlation): ${mean(teammateCorrSamples).toFixed(3)} (t-copula assumes +0.12, samples=${teammateCorrSamples.length})`);
  console.log(`  Opposing team residual product: ${mean(oppCorrSamples).toFixed(3)} (t-copula assumes -0.05, samples=${oppCorrSamples.length})`);
  console.log(`  Pitcher vs opposing batter: ${mean(pitcherVsOppCorrSamples).toFixed(3)} (t-copula assumes -0.25, samples=${pitcherVsOppCorrSamples.length})`);

  // ============================================================
  // RECOMMENDATIONS
  // ============================================================
  console.log('\n\n================================================================');
  console.log('GATES FOR DOWNSTREAM EXPERIMENTS');
  console.log('================================================================');
  console.log(`\n- Chalk-avoidance architecture test: ${chalkPerSlate < 1500 ? 'WORTH RUNNING' : 'HIGH-RISK — chalk is expensive'}`);
  console.log(`- Ceiling-based scoring (ν sweep): ${avgCorr < 0.95 ? 'WORTH RUNNING' : 'SKIP — ceiling ≈ projection'}`);
  console.log(`- Variance recalibration: ${Math.abs(residStd - 1) > 0.15 ? 'WORTH APPLYING' : 'variances OK — no recalibration needed'}`);
}

main().catch(e => { console.error(e); process.exit(1); });
