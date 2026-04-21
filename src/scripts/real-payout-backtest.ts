/**
 * Real Payout Backtest — uses actual V32 selector code + V33 discounted module,
 * scores against real contest actuals, computes payouts from actual rank positions.
 *
 * Payout model: DK GPP power-law calibrated to contest size.
 * - Total pool = entries × fee × 0.88
 * - Cash line = top 22%
 * - Payout at rank r: pool × C × r^(-1.15), normalized so sum ≈ pool
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import {
  parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV,
  ContestActuals, ContestEntry,
} from '../parser';
import { getContestConfig } from '../rules';
import {
  DEFAULT_SELECTOR_PARAMS, SelectorParams, defaultGamma, getSportDefaults, precomputeSlate,
  SlatePrecomputation,
} from '../selection/algorithm7-selector';
import { v33DiscountedSelect } from '../selection/v33-discounted';
import { generateBlendedField } from '../opponent/field-generator';
import { loadRegionMap, computeRegionTargets } from '../analysis/region-map';

const DATA_DIR = 'C:/Users/colin/dfs opto';
const ENTRY_FEE = 20;
const SLATES = [
  { slate: '4-6-26', proj: '4-6-26_projections.csv', actuals: 'dkactuals 4-6-26.csv', pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26', proj: '4-8-26projections.csv', actuals: '4-8-26actuals.csv', pool: '4-8-26sspool.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv', actuals: '4-12-26actuals.csv', pool: '4-12-26sspool.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv', actuals: '4-14-26actuals.csv', pool: '4-14-26sspool.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv', actuals: '4-15-26actuals.csv', pool: '4-15-26sspool.csv' },
  { slate: '4-17-26', proj: '4-17-26projections.csv', actuals: '4-17-26actuals.csv', pool: '4-17-26sspool.csv' },
  { slate: '4-18-26', proj: '4-18-26projections.csv', actuals: '4-18-26actuals.csv', pool: '4-18-26sspool.csv' },
  { slate: '4-19-26', proj: '4-19-26projections.csv', actuals: '4-19-26actuals.csv', pool: '4-19-26sspool.csv' },
];

function norm(n: string): string { return (n||'').toLowerCase().replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim(); }
function findBin(v: number, bins: number[]): number { for (let i = bins.length-1; i >= 0; i--) if (v >= bins[i]) return i; return 0; }

// ============================================================
// DK PAYOUT MODEL — power-law calibrated to real DK GPP structures
// ============================================================

function buildPayoutTable(totalEntries: number, entryFee: number): Float64Array {
  const pool = totalEntries * entryFee * 0.88;
  const cashLine = Math.floor(totalEntries * 0.22);
  const alpha = 1.15;

  // Compute raw payouts: payout(r) = r^(-alpha)
  const raw = new Float64Array(cashLine);
  let rawSum = 0;
  for (let r = 0; r < cashLine; r++) {
    raw[r] = Math.pow(r + 1, -alpha);
    rawSum += raw[r];
  }

  // Normalize so sum = pool, with minimum cash = entryFee * 1.2
  const minCash = entryFee * 1.2;
  const table = new Float64Array(totalEntries);
  for (let r = 0; r < cashLine; r++) {
    table[r] = Math.max(minCash, (raw[r] / rawSum) * pool);
  }
  // Re-normalize after min-cash floor
  let tableSum = 0;
  for (let r = 0; r < cashLine; r++) tableSum += table[r];
  const scale = pool / tableSum;
  for (let r = 0; r < cashLine; r++) table[r] *= scale;

  return table;
}

function getPayoutAtRank(rank: number, payoutTable: Float64Array): number {
  if (rank < 1 || rank > payoutTable.length) return 0;
  return payoutTable[rank - 1];
}

// ============================================================
// ACTUAL V32 SELECTION (matches v32-selector.ts production code path)
// ============================================================

function runV32Selection(
  precomp: SlatePrecomputation,
  regionMap: any,
  candidatePool: Lineup[],
  N: number,
  numGames: number,
): Lineup[] {
  const isSmallSlate = numGames <= 4;

  // Pool coordinates
  const poolCoords = candidatePool.map(l => ({
    projection: l.projection,
    ownership: l.players.reduce((s: number, p: Player) => s + (p.ownership || 0), 0) / l.players.length,
  }));

  // Feasibility filter
  const poolDist = new Map<string, number>();
  for (const c of poolCoords) {
    const pB = findBin(c.projection, regionMap.projBins);
    const oB = findBin(c.ownership, regionMap.ownBins);
    poolDist.set(`${pB}_${oB}`, (poolDist.get(`${pB}_${oB}`) || 0) + 1);
  }
  const feasCells = new Map<string, any>(regionMap.cells);
  for (const [k] of feasCells) if ((poolDist.get(k as string) || 0) < 5) feasCells.delete(k);

  // Dynamic centroid
  const poolProjSorted = poolCoords.map(c => c.projection).sort((a, b) => a - b);
  const poolP75 = poolProjSorted[Math.floor(poolProjSorted.length * 0.75)];
  const projShift = poolP75 - regionMap.top1Centroid.projection;
  const adjustedCentroid = {
    projection: regionMap.top1Centroid.projection + projShift,
    ownership: regionMap.top1Centroid.ownership,
  };

  // Proximity-weighted allocation
  const weightedCells = new Map<string, any>();
  for (const [key, cell] of feasCells) {
    const midP = (cell.projRange[0] + cell.projRange[1]) / 2;
    const midO = (cell.ownRange[0] + cell.ownRange[1]) / 2;
    const dist = Math.sqrt(Math.pow((midP - adjustedCentroid.projection) / 10, 2) + Math.pow((midO - adjustedCentroid.ownership) / 5, 2));
    const pw = 1 / (1 + dist);
    weightedCells.set(key, { ...cell, top1Lift: cell.top1Lift * pw * pw });
  }
  const targets = computeRegionTargets({ ...regionMap, cells: weightedCells }, N, 'weighted_lift', 0.1);

  const candCoords = Array.from({ length: precomp.C }, (_, c) => ({
    idx: c,
    projection: precomp.candidatePool[c].projection,
    ownership: precomp.candidatePool[c].players.reduce((s: number, p: Player) => s + (p.ownership || 0), 0) / precomp.candidatePool[c].players.length,
  }));

  const selected: Lineup[] = [];
  const selectedHashes = new Set<string>();
  const playerCount = new Map<string, number>();
  const teamStackCount = new Map<string, number>();
  const maxPerTeam = Math.floor(N * 0.25);
  const maxExpCap = Math.ceil((isSmallSlate ? 0.50 : 0.35) * N);
  const lambdaVar = numGames >= 8 ? 0.30 : numGames >= 6 ? 0.25 : numGames >= 4 ? 0.10 : 0.05;
  const lambdaSigma = numGames >= 8 ? 0.30 : numGames >= 6 ? 0.22 : numGames >= 4 ? 0.05 : 0.03;

  // Sort allocations by centroid proximity
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
    for (const cand of rc) {
      if (filled >= tc) break;
      const lu = precomp.candidatePool[cand.idx]; if (selectedHashes.has(lu.hash)) continue;
      let expOk = true; for (const p of lu.players) if ((playerCount.get(p.id) || 0) >= maxExpCap) { expOk = false; break; } if (!expOk) continue;
      const ltc = new Map<string, number>(); for (const p of lu.players) if (!p.positions?.includes('P')) ltc.set(p.team, (ltc.get(p.team) || 0) + 1);
      let tOk = true; for (const [t, cnt] of ltc) if (cnt >= 4 && (teamStackCount.get(t) || 0) >= maxPerTeam) { tOk = false; break; } if (!tOk) continue;
      selected.push(lu); selectedHashes.add(lu.hash);
      for (const p of lu.players) playerCount.set(p.id, (playerCount.get(p.id) || 0) + 1);
      for (const [t, cnt] of ltc) if (cnt >= 4) teamStackCount.set(t, (teamStackCount.get(t) || 0) + 1);
      filled++;
    }
  }

  // Team coverage enforcement
  const coveredTeams = new Map<string, number>();
  for (const lu of selected) {
    const tc = new Map<string, number>(); for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
    for (const [t, c] of tc) if (c >= 4) coveredTeams.set(t, (coveredTeams.get(t) || 0) + 1);
  }
  const allTeams = new Set<string>();
  for (const c of candCoords) for (const p of precomp.candidatePool[c.idx].players) if (p.team) allTeams.add(p.team);
  const minPerTeam = Math.max(3, Math.floor(N / allTeams.size * 0.6));
  for (const team of allTeams) {
    if ((coveredTeams.get(team) || 0) >= minPerTeam) continue;
    const teamCands = candCoords.filter(c => {
      const lu = precomp.candidatePool[c.idx]; const tc = new Map<string, number>();
      for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
      return (tc.get(team) || 0) >= 4;
    });
    if (teamCands.length < 5) continue;
    const sorted2 = teamCands.map(c => ({ ...c, score: precomp.candidateProjection[c.idx] })).sort((a, b) => b.score - a.score);
    const needed = minPerTeam - (coveredTeams.get(team) || 0);
    let added = 0;
    for (const cand of sorted2) {
      if (added >= needed) break;
      const lu = precomp.candidatePool[cand.idx]; if (selectedHashes.has(lu.hash)) continue;
      let expOk = true; for (const p of lu.players) if ((playerCount.get(p.id) || 0) >= maxExpCap) { expOk = false; break; } if (!expOk) continue;
      if (selected.length >= N) {
        const wIdx = selected.reduce((best, lu2, idx) => lu2.projection < selected[best].projection ? idx : best, 0);
        const removed = selected[wIdx];
        for (const p of removed.players) { const c = playerCount.get(p.id) || 0; if (c > 0) playerCount.set(p.id, c - 1); }
        selectedHashes.delete(removed.hash); selected[wIdx] = lu;
      } else { selected.push(lu); }
      selectedHashes.add(lu.hash);
      for (const p of lu.players) playerCount.set(p.id, (playerCount.get(p.id) || 0) + 1);
      added++;
    }
  }

  // Fill remainder
  if (selected.length < N) {
    const all = candCoords.map(c => ({ ...c, score: precomp.candidateProjection[c.idx] })).sort((a, b) => b.score - a.score);
    for (const c of all) { if (selected.length >= N) break; const lu = precomp.candidatePool[c.idx]; if (selectedHashes.has(lu.hash)) continue;
      let ok = true; for (const p of lu.players) if ((playerCount.get(p.id) || 0) >= maxExpCap) { ok = false; break; } if (!ok) continue;
      selected.push(lu); selectedHashes.add(lu.hash); for (const p of lu.players) playerCount.set(p.id, (playerCount.get(p.id) || 0) + 1);
    }
  }

  return selected;
}

// ============================================================
// SCORING
// ============================================================

interface ScoredResult {
  t1: number; t5: number; cash: number; scored: number;
  totalPayout: number;
  perHit: Array<{ rank: number; score: number; payout: number; coWinners: number }>;
  stacks: number;
  avgOwn: number;
  avgProj: number;
}

function scorePortfolio(
  portfolio: Lineup[],
  actuals: ContestActuals,
  actualByHash: Map<string, number>,
  payoutTable: Float64Array,
): ScoredResult {
  const F = actuals.entries.length;
  const sortedScores = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
  const top1T = sortedScores[Math.max(0, Math.floor(F * 0.01) - 1)] || 0;
  const top5T = sortedScores[Math.max(0, Math.floor(F * 0.05) - 1)] || 0;
  const cashT = sortedScores[Math.max(0, Math.floor(F * 0.22) - 1)] || 0;

  let t1 = 0, t5 = 0, cash = 0, scored = 0, totalPayout = 0;
  const perHit: ScoredResult['perHit'] = [];

  for (const lu of portfolio) {
    const fa = actualByHash.get(lu.hash);
    let a: number | null = fa !== undefined ? fa : null;
    if (a === null) {
      let t = 0, miss = false;
      for (const p of lu.players) { const r = actuals.playerActualsByName.get(norm(p.name)); if (!r) { miss = true; break; } t += r.fpts; }
      if (!miss) a = t;
    }
    if (a === null) continue;
    scored++;

    // Find rank via binary search on sorted scores
    let lo = 0, hi = sortedScores.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (sortedScores[mid] >= a) lo = mid + 1; else hi = mid; }
    const rank = Math.max(1, lo);

    if (a >= top1T) t1++;
    if (a >= top5T) t5++;
    if (a >= cashT) cash++;

    // Payout at this rank
    const payout = getPayoutAtRank(rank, payoutTable);
    if (payout > 0) {
      // Count entries at same score for splitting estimate
      let coWinners = 0;
      for (const e of actuals.entries) {
        if (Math.abs(e.actualPoints - a) <= 0.25) coWinners++;
      }
      coWinners = Math.max(0, coWinners - 1);

      // DK splits ties: sum of prizes at tied ranks, divided evenly
      // Approximate: payout / sqrt(1 + coWinners) — partial split
      const splitPayout = payout / Math.sqrt(1 + coWinners * 0.5);
      totalPayout += splitPayout;

      if (a >= top1T) {
        perHit.push({ rank, score: a, payout: splitPayout, coWinners });
      }
    }
  }

  const stackTeams = new Set<string>();
  let sOwn = 0, sProj = 0;
  for (const lu of portfolio) {
    sProj += lu.projection;
    sOwn += lu.players.reduce((s: number, p: Player) => s + (p.ownership || 0), 0) / lu.players.length;
    const tc = new Map<string, number>(); for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
    for (const [t, c] of tc) if (c >= 4) stackTeams.add(t);
  }

  return {
    t1, t5, cash, scored, totalPayout, perHit,
    stacks: stackTeams.size,
    avgOwn: portfolio.length > 0 ? sOwn / portfolio.length : 0,
    avgProj: portfolio.length > 0 ? sProj / portfolio.length : 0,
  };
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  const regionMap = loadRegionMap('C:/Users/colin/dfs opto/region-map-mlb-dk.json');
  const pct = (v: number) => `${(v*100).toFixed(2)}%`;

  let md = `# Real Payout Backtest — V32 vs V33 Discounted (7 slates)\n\n`;
  md += `Uses actual V32 selector code path (dynamic centroid + region targeting + team coverage).\n`;
  md += `Payouts: power-law model calibrated to DK GPP structure (α=1.15, 22% cash).\n\n`;
  md += `| Slate | Entries | V32 t1 | V32 pay | V33d t1 | V33d pay | V33d coWin | V33d stacks |\n`;
  md += `|---|---:|---:|---:|---:|---:|---:|---:|\n`;

  let v32PaySum = 0, v33dPaySum = 0, v32T1Sum = 0, v33dT1Sum = 0, n = 0;

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
    const payoutTable = buildPayoutTable(F, ENTRY_FEE);

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

    const gameSet = new Set<string>();
    for (const p of pool.players) gameSet.add(p.gameInfo || `${p.team}_game`);
    const numGames = gameSet.size;

    const selParams: SelectorParams = { ...DEFAULT_SELECTOR_PARAMS, ...getSportDefaults('mlb'), N: 150, gamma: defaultGamma(config.rosterSize), numWorlds: 1500 };
    console.log(`  precompute (pool=${loaded.lineups.length}, field=${blendedField.length})…`);
    const precomp = precomputeSlate(loaded.lineups, blendedField, pool.players, selParams, 'mlb');

    // V32
    console.log(`  V32…`);
    const v32Portfolio = runV32Selection(precomp, regionMap, loaded.lineups, 150, numGames);
    const v32Result = scorePortfolio(v32Portfolio, actuals, actualByHash, payoutTable);

    // V33 discounted
    console.log(`  V33 discounted…`);
    const v33dPortfolio = v33DiscountedSelect(precomp, 150, {
      maxExposure: 0.40, maxPerTeam: Math.floor(150 * 0.25), fieldForDuplication: blendedField,
    });
    const v33dResult = scorePortfolio(v33dPortfolio, actuals, actualByHash, payoutTable);

    const avgCoWin = v33dResult.perHit.length > 0
      ? v33dResult.perHit.reduce((s, h) => s + h.coWinners, 0) / v33dResult.perHit.length : 0;

    console.log(`  V32: t1=${v32Result.t1} pay=$${v32Result.totalPayout.toFixed(0)} proj=${v32Result.avgProj.toFixed(1)} own=${v32Result.avgOwn.toFixed(1)}%`);
    console.log(`  V33d: t1=${v33dResult.t1} pay=$${v33dResult.totalPayout.toFixed(0)} coWin=${avgCoWin.toFixed(1)} stacks=${v33dResult.stacks}`);

    v32PaySum += v32Result.totalPayout; v33dPaySum += v33dResult.totalPayout;
    v32T1Sum += v32Result.t1; v33dT1Sum += v33dResult.t1; n++;

    md += `| ${s.slate} | ${F.toLocaleString()} | ${v32Result.t1} (${pct(v32Result.scored>0?v32Result.t1/v32Result.scored:0)}) | $${v32Result.totalPayout.toFixed(0)} | ${v33dResult.t1} (${pct(v33dResult.scored>0?v33dResult.t1/v33dResult.scored:0)}) | $${v33dResult.totalPayout.toFixed(0)} | ${avgCoWin.toFixed(1)} | ${v33dResult.stacks} |\n`;
  }

  const totalFees = ENTRY_FEE * 150 * n;
  md += `| **TOTAL** | | **${v32T1Sum}** | **$${v32PaySum.toFixed(0)}** | **${v33dT1Sum}** | **$${v33dPaySum.toFixed(0)}** | | |\n\n`;
  md += `Entry fees: $${ENTRY_FEE} × 150 × ${n} slates = $${totalFees.toLocaleString()}\n\n`;
  md += `| Selector | Total Payout | ROI |\n|---|---:|---:|\n`;
  md += `| **V32 (regions)** | **$${v32PaySum.toFixed(0)}** | **${((v32PaySum/totalFees-1)*100).toFixed(1)}%** |\n`;
  md += `| V33 (discounted) | $${v33dPaySum.toFixed(0)} | ${((v33dPaySum/totalFees-1)*100).toFixed(1)}% |\n`;

  fs.writeFileSync(path.join(DATA_DIR, 'real_payout_backtest.md'), md);
  console.log(`\n✓ Report: ${path.join(DATA_DIR, 'real_payout_backtest.md')}`);
}

main();
