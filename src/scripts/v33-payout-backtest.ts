/**
 * V33 Duplication-Discounted U²ₗ + Payout-Based Backtest.
 *
 * Compares V32 (regions), V33-pure (U²ₗ no discount), V33-discounted (U²ₗ + dup discount)
 * on both top-1% hit rate AND actual payout (accounting for co-winners splitting prizes).
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import {
  parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals, ContestEntry,
} from '../parser';
import { getContestConfig } from '../rules';
import {
  DEFAULT_SELECTOR_PARAMS, SelectorParams, defaultGamma, getSportDefaults, precomputeSlate,
  SlatePrecomputation,
} from '../selection/algorithm7-selector';
import { generateBlendedField } from '../opponent/field-generator';
import { loadRegionMap, computeRegionTargets } from '../analysis/region-map';

const DATA_DIR = 'C:/Users/colin/dfs opto';
const SLATES = [
  { slate: '4-6-26', proj: '4-6-26_projections.csv', actuals: 'dkactuals 4-6-26.csv', pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26', proj: '4-8-26projections.csv', actuals: '4-8-26actuals.csv', pool: '4-8-26sspool.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv', actuals: '4-12-26actuals.csv', pool: '4-12-26sspool.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv', actuals: '4-14-26actuals.csv', pool: '4-14-26sspool.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv', actuals: '4-15-26actuals.csv', pool: '4-15-26sspool.csv' },
  { slate: '4-17-26', proj: '4-17-26projections.csv', actuals: '4-17-26actuals.csv', pool: '4-17-26sspool.csv' },
  { slate: '4-18-26', proj: '4-18-26projections.csv', actuals: '4-18-26actuals.csv', pool: '4-18-26sspool.csv' },
];

function norm(n: string): string { return (n||'').toLowerCase().replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim(); }
function findBin(v: number, bins: number[]): number { for (let i = bins.length-1; i >= 0; i--) if (v >= bins[i]) return i; return 0; }

// ============================================================
// APPROXIMATE DK GPP PRIZE STRUCTURE
// ============================================================

function approximatePayout(rank: number, totalEntries: number, entryFee: number): number {
  const prizePool = totalEntries * entryFee * 0.88; // DK takes ~12%
  const cashLine = Math.floor(totalEntries * 0.22);
  if (rank > cashLine) return 0;

  // Top-heavy GPP approximation
  const frac = rank / totalEntries;
  if (frac <= 0.00005) return prizePool * 0.08;      // 1st place ~8% of pool
  if (frac <= 0.0001) return prizePool * 0.04;       // 2nd
  if (frac <= 0.0005) return prizePool * 0.005;      // top 0.05%
  if (frac <= 0.001) return prizePool * 0.002;       // top 0.1%
  if (frac <= 0.005) return prizePool * 0.0004;      // top 0.5%
  if (frac <= 0.01) return prizePool * 0.0002;       // top 1%
  if (frac <= 0.05) return prizePool * 0.00005;      // top 5%
  if (frac <= 0.10) return prizePool * 0.00003;      // top 10%
  return entryFee * 1.2;                              // min cash ~1.2x entry
}

// ============================================================
// DUPLICATION COUNTING
// ============================================================

function countCoWinners(
  ourScore: number,
  allEntries: ContestEntry[],
  tolerance: number = 0.5,
): number {
  let count = 0;
  for (const e of allEntries) {
    if (Math.abs(e.actualPoints - ourScore) <= tolerance) count++;
  }
  return Math.max(0, count - 1); // subtract self
}

function computeFieldDuplicates(
  candidate: Lineup,
  field: Lineup[],
  minOverlapFrac: number = 0.80,
): number {
  const cIds = new Set(candidate.players.map(p => p.id));
  const rosterSize = candidate.players.length;
  let dups = 0;
  for (const f of field) {
    let overlap = 0;
    for (const p of f.players) if (cIds.has(p.id)) overlap++;
    const frac = overlap / rosterSize;
    if (frac >= 1.0) dups += 1.0;
    else if (frac >= 0.9) dups += 0.5;
    else if (frac >= minOverlapFrac) dups += 0.15;
  }
  return dups;
}

// ============================================================
// V33 DISCOUNTED U²ₗ SELECTOR
// ============================================================

function selectV33Discounted(
  precomp: SlatePrecomputation,
  field: Lineup[],
  N: number,
  maxExposure: number,
  maxPerTeam: number,
): Lineup[] {
  const { W, C, candidateWorldScores, candidatePool } = precomp;
  const thresh1 = precomp.thresh1;

  // Pre-compute hits
  const hits = new Uint8Array(C * W);
  for (let c = 0; c < C; c++) {
    for (let w = 0; w < W; w++) {
      if (candidateWorldScores[c * W + w] >= thresh1[w]) hits[c * W + w] = 1;
    }
  }

  // Pre-compute duplication discount per candidate (expensive, do once)
  console.log(`    computing duplication discounts for ${C} candidates against ${field.length} field…`);
  const discounts = new Float64Array(C);
  // Sample field for speed (use first 3000)
  const fieldSample = field.slice(0, 3000);
  for (let c = 0; c < C; c++) {
    const dups = computeFieldDuplicates(candidatePool[c], fieldSample, 0.80);
    // Scale by full field / sample ratio
    const scaledDups = dups * (field.length / fieldSample.length);
    discounts[c] = 1 / (1 + scaledDups);
  }

  const selected: Lineup[] = [];
  const selectedHashes = new Set<string>();
  const playerCount = new Map<string, number>();
  const teamStackCount = new Map<string, number>();
  const covered = new Uint8Array(W);
  const expCap = Math.ceil(maxExposure * N);

  for (let step = 0; step < N; step++) {
    let bestIdx = -1;
    let bestGain = -Infinity;

    for (let c = 0; c < C; c++) {
      const lu = candidatePool[c];
      if (selectedHashes.has(lu.hash)) continue;

      let expOk = true;
      for (const p of lu.players) if ((playerCount.get(p.id) || 0) >= expCap) { expOk = false; break; }
      if (!expOk) continue;

      const tc = new Map<string, number>();
      for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
      let teamOk = true;
      for (const [t, cnt] of tc) if (cnt >= 4 && (teamStackCount.get(t) || 0) >= maxPerTeam) { teamOk = false; break; }
      if (!teamOk) continue;

      // Marginal gain × duplication discount
      let rawGain = 0;
      for (let w = 0; w < W; w++) {
        if (!covered[w] && hits[c * W + w]) rawGain++;
      }
      const gain = rawGain * discounts[c];

      if (gain > bestGain) { bestGain = gain; bestIdx = c; }
    }

    if (bestIdx < 0) break;

    const lu = candidatePool[bestIdx];
    selected.push(lu);
    selectedHashes.add(lu.hash);
    for (const p of lu.players) playerCount.set(p.id, (playerCount.get(p.id) || 0) + 1);
    const tc2 = new Map<string, number>();
    for (const p of lu.players) if (!p.positions?.includes('P')) tc2.set(p.team, (tc2.get(p.team) || 0) + 1);
    for (const [t, cnt] of tc2) if (cnt >= 4) teamStackCount.set(t, (teamStackCount.get(t) || 0) + 1);
    for (let w = 0; w < W; w++) { if (hits[bestIdx * W + w]) covered[w] = 1; }

    if ((step + 1) % 50 === 0) {
      let cov = 0; for (let w = 0; w < W; w++) cov += covered[w];
      console.log(`    [V33d] ${step+1}/${N} gain=${bestGain.toFixed(1)} cov=${(cov/W*100).toFixed(1)}% disc=${discounts[bestIdx].toFixed(3)}`);
    }
  }

  return selected;
}

// ============================================================
// V32 SELECTOR (simplified, no V31 scoring — pure projection within regions)
// ============================================================

function selectV32(
  precomp: SlatePrecomputation,
  regionMap: any,
  pool: { players: Player[] },
  candidatePool: Lineup[],
  N: number,
): Lineup[] {
  const poolCoords = candidatePool.map(l => ({
    projection: l.projection,
    ownership: l.players.reduce((s: number, p: Player) => s + (p.ownership || 0), 0) / l.players.length,
  }));
  const poolDist = new Map<string, number>();
  for (const c of poolCoords) { const pB = findBin(c.projection, regionMap.projBins); const oB = findBin(c.ownership, regionMap.ownBins); poolDist.set(`${pB}_${oB}`, (poolDist.get(`${pB}_${oB}`) || 0) + 1); }
  const feasCells = new Map<string, any>(regionMap.cells);
  for (const [k] of feasCells) if ((poolDist.get(k as string) || 0) < 5) feasCells.delete(k);

  const poolProjSorted = poolCoords.map(c => c.projection).sort((a, b) => a - b);
  const poolP75 = poolProjSorted[Math.floor(poolProjSorted.length * 0.75)];
  const adjustedCentroid = { projection: regionMap.top1Centroid.projection + (poolP75 - regionMap.top1Centroid.projection), ownership: regionMap.top1Centroid.ownership };

  const weightedCells = new Map<string, any>();
  for (const [key, cell] of feasCells) {
    const dist = Math.sqrt(Math.pow(((cell.projRange[0]+cell.projRange[1])/2 - adjustedCentroid.projection)/10, 2) + Math.pow(((cell.ownRange[0]+cell.ownRange[1])/2 - adjustedCentroid.ownership)/5, 2));
    weightedCells.set(key, { ...cell, top1Lift: cell.top1Lift / (1 + dist) / (1 + dist) });
  }
  const targets = computeRegionTargets({ ...regionMap, cells: weightedCells }, N, 'weighted_lift', 0.1);

  const candCoords = Array.from({ length: precomp.C }, (_, c) => ({ idx: c, projection: precomp.candidatePool[c].projection, ownership: precomp.candidatePool[c].players.reduce((s: number, p: Player) => s + (p.ownership || 0), 0) / precomp.candidatePool[c].players.length }));
  const sel: Lineup[] = []; const selH = new Set<string>(); const selExp = new Map<string, number>();
  const expCap = Math.ceil(0.40 * N); const maxPerTeam = Math.floor(N * 0.25);
  const teamSC = new Map<string, number>();

  const sortedAlloc = [...targets.allocations.entries()].sort((a, b) => {
    const ca = regionMap.cells.get(a[0]), cb = regionMap.cells.get(b[0]);
    const dA = ca ? Math.abs((ca.projRange[0]+ca.projRange[1])/2 - adjustedCentroid.projection)/10 + Math.abs((ca.ownRange[0]+ca.ownRange[1])/2 - adjustedCentroid.ownership)/5 : 99;
    const dB = cb ? Math.abs((cb.projRange[0]+cb.projRange[1])/2 - adjustedCentroid.projection)/10 + Math.abs((cb.ownRange[0]+cb.ownRange[1])/2 - adjustedCentroid.ownership)/5 : 99;
    return dA - dB;
  });

  for (const [key, tc] of sortedAlloc) {
    const cell = regionMap.cells.get(key); if (!cell) continue;
    const rc = candCoords.filter(c => c.projection >= cell.projRange[0] && c.projection < cell.projRange[1] && c.ownership >= cell.ownRange[0] && c.ownership < cell.ownRange[1])
      .map(c => ({ ...c, score: precomp.candidateProjection[c.idx] })).sort((a, b) => b.score - a.score);
    let filled = 0;
    for (const cand of rc) { if (filled >= tc) break; const lu = precomp.candidatePool[cand.idx]; if (selH.has(lu.hash)) continue;
      let ok = true; for (const p of lu.players) if ((selExp.get(p.id) || 0) >= expCap) { ok = false; break; } if (!ok) continue;
      const ltc = new Map<string, number>(); for (const p of lu.players) if (!p.positions?.includes('P')) ltc.set(p.team, (ltc.get(p.team) || 0) + 1);
      let tOk = true; for (const [t, cnt] of ltc) if (cnt >= 4 && (teamSC.get(t) || 0) >= maxPerTeam) { tOk = false; break; } if (!tOk) continue;
      sel.push(lu); selH.add(lu.hash); for (const p of lu.players) selExp.set(p.id, (selExp.get(p.id) || 0) + 1);
      for (const [t, cnt] of ltc) if (cnt >= 4) teamSC.set(t, (teamSC.get(t) || 0) + 1); filled++;
    }
  }
  if (sel.length < N) {
    const all = candCoords.map(c => ({ ...c, score: precomp.candidateProjection[c.idx] })).sort((a, b) => b.score - a.score);
    for (const c of all) { if (sel.length >= N) break; const lu = precomp.candidatePool[c.idx]; if (selH.has(lu.hash)) continue;
      let ok = true; for (const p of lu.players) if ((selExp.get(p.id) || 0) >= expCap) { ok = false; break; } if (!ok) continue;
      sel.push(lu); selH.add(lu.hash); for (const p of lu.players) selExp.set(p.id, (selExp.get(p.id) || 0) + 1);
    }
  }
  return sel;
}

// ============================================================
// SCORE + PAYOUT
// ============================================================

interface PortfolioResult {
  label: string;
  t1: number; scored: number; top1Rate: number;
  totalPayout: number; avgPayoutPerHit: number;
  avgCoWinners: number;
  stacks: number;
}

function scoreWithPayouts(
  portfolio: Lineup[],
  actuals: ContestActuals,
  actualByHash: Map<string, number>,
  entryFee: number,
): PortfolioResult & { label: string } {
  const F = actuals.entries.length;
  const sorted = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
  const top1 = sorted[Math.max(0, Math.floor(F * 0.01) - 1)] || 0;

  let t1 = 0, scored = 0, totalPayout = 0, sumCoWinners = 0, hitCount = 0;

  for (const lu of portfolio) {
    const fa = actualByHash.get(lu.hash); let a: number | null = fa !== undefined ? fa : null;
    if (a === null) { let t = 0, miss = false; for (const p of lu.players) { const r = actuals.playerActualsByName.get(norm(p.name)); if (!r) { miss = true; break; } t += r.fpts; } if (!miss) a = t; }
    if (a === null) continue;
    scored++;

    // Find rank
    let rank = F;
    for (let i = 0; i < sorted.length; i++) { if (sorted[i] <= a) { rank = i + 1; break; } }

    if (a >= top1) t1++;

    // Payout
    const basePayout = approximatePayout(rank, F, entryFee);
    if (basePayout > 0) {
      const coWinners = countCoWinners(a, actuals.entries, 0.5);
      const actualPayout = basePayout / (1 + coWinners * 0.3); // partial split (not full — different lineups at same score have different exact payouts)
      totalPayout += actualPayout;
      if (a >= top1) { sumCoWinners += coWinners; hitCount++; }
    }
  }

  const stackTeams = new Set<string>();
  for (const lu of portfolio) {
    const tc = new Map<string, number>(); for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
    for (const [t, c] of tc) if (c >= 4) stackTeams.add(t);
  }

  return {
    label: '', t1, scored, top1Rate: scored > 0 ? t1 / scored : 0,
    totalPayout, avgPayoutPerHit: hitCount > 0 ? totalPayout / hitCount : 0,
    avgCoWinners: hitCount > 0 ? sumCoWinners / hitCount : 0,
    stacks: stackTeams.size,
  };
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  const regionMap = loadRegionMap('C:/Users/colin/dfs opto/region-map-mlb-dk.json');
  const pct = (v: number) => `${(v*100).toFixed(2)}%`;
  const entryFee = 20;

  let md = `# V33 Payout Backtest — Hit Rate vs Actual Payout\n\n`;
  md += `| Slate | Entries | | V32 t1 | V32 payout | V33d t1 | V33d payout | V33d coWin | V33d stacks |\n`;
  md += `|---|---:|---|---:|---:|---:|---:|---:|---:|\n`;

  let v32PayoutSum = 0, v33dPayoutSum = 0, v32T1Sum = 0, v33dT1Sum = 0, n = 0;

  for (const s of SLATES) {
    const projPath = path.join(DATA_DIR, s.proj);
    const actualsPath = path.join(DATA_DIR, s.actuals);
    const poolPath = path.join(DATA_DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) continue;

    console.log(`\n=== ${s.slate} ===`);
    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);
    const nameMap = new Map<string, Player>(); for (const p of pool.players) nameMap.set(norm(p.name), p);
    const idMap = new Map<string, Player>(); for (const p of pool.players) idMap.set(p.id, p);

    const F = actuals.entries.length;
    const fieldLineups: Lineup[] = []; const seenH = new Set<string>(); const actualByHash = new Map<string, number>();
    for (const e of actuals.entries) { const pls: Player[] = []; let ok = true;
      for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
      if (!ok) continue; const hash = pls.map(p => p.id).sort().join('|');
      if (seenH.has(hash)) continue; seenH.add(hash);
      fieldLineups.push({ players: pls, salary: pls.reduce((sm, p) => sm + p.salary, 0), projection: pls.reduce((sm, p) => sm + p.projection, 0), ownership: pls.reduce((sm, p) => sm + (p.ownership || 0), 0) / pls.length, hash });
      actualByHash.set(hash, e.actualPoints);
    }

    const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
    const blendedField = generateBlendedField(loaded.lineups, pool.players, config, Math.min(8000, F), 0.20);
    const selParams: SelectorParams = { ...DEFAULT_SELECTOR_PARAMS, ...getSportDefaults('mlb'), N: 150, gamma: defaultGamma(config.rosterSize), numWorlds: 1500 };
    const precomp = precomputeSlate(loaded.lineups, blendedField, pool.players, selParams, 'mlb');

    // V32
    console.log(`  V32 (regions)…`);
    const v32Portfolio = selectV32(precomp, regionMap, pool, loaded.lineups, 150);
    const v32Result = scoreWithPayouts(v32Portfolio, actuals, actualByHash, entryFee);

    // V33 discounted
    console.log(`  V33 discounted…`);
    const maxPerTeam = Math.floor(150 * 0.25);
    const v33dPortfolio = selectV33Discounted(precomp, blendedField, 150, 0.40, maxPerTeam);
    const v33dResult = scoreWithPayouts(v33dPortfolio, actuals, actualByHash, entryFee);

    console.log(`  V32: t1=${v32Result.t1} payout=$${v32Result.totalPayout.toFixed(0)}`);
    console.log(`  V33d: t1=${v33dResult.t1} payout=$${v33dResult.totalPayout.toFixed(0)} coWin=${v33dResult.avgCoWinners.toFixed(1)} stacks=${v33dResult.stacks}`);

    v32PayoutSum += v32Result.totalPayout; v33dPayoutSum += v33dResult.totalPayout;
    v32T1Sum += v32Result.t1; v33dT1Sum += v33dResult.t1; n++;

    md += `| ${s.slate} | ${F.toLocaleString()} | | ${v32Result.t1} (${pct(v32Result.top1Rate)}) | $${v32Result.totalPayout.toFixed(0)} | ${v33dResult.t1} (${pct(v33dResult.top1Rate)}) | $${v33dResult.totalPayout.toFixed(0)} | ${v33dResult.avgCoWinners.toFixed(1)} | ${v33dResult.stacks} |\n`;
  }

  md += `| **TOTAL** | | | **${v32T1Sum}** | **$${v32PayoutSum.toFixed(0)}** | **${v33dT1Sum}** | **$${v33dPayoutSum.toFixed(0)}** | | |\n\n`;
  md += `Entry fees per slate: $${entryFee} × 150 = $${entryFee * 150}\n`;
  md += `Total entry fees (${n} slates): $${entryFee * 150 * n}\n\n`;
  md += `**V32 ROI: ${((v32PayoutSum / (entryFee * 150 * n) - 1) * 100).toFixed(1)}%**\n`;
  md += `**V33d ROI: ${((v33dPayoutSum / (entryFee * 150 * n) - 1) * 100).toFixed(1)}%**\n`;

  fs.writeFileSync(path.join(DATA_DIR, 'v33_payout_backtest.md'), md);
  console.log(`\n✓ Report: ${path.join(DATA_DIR, 'v33_payout_backtest.md')}`);
}

main();
