/**
 * Hybrid Backtest — anchor-relative regions + V32 simulation scoring.
 *
 * Anchor-relative: computes regions via relative coordinates (auto-adapts to slate)
 * V32 scoring: within regions, uses blended field precomp + raw projection ranking
 * Team coverage: 10% max per team (the parameter that closed the gap)
 * Leave-one-out across 7 slates.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals } from '../parser';
import { getContestConfig } from '../rules';
import { DEFAULT_SELECTOR_PARAMS, SelectorParams, defaultGamma, getSportDefaults, precomputeSlate, SlatePrecomputation } from '../selection/algorithm7-selector';
import { generateBlendedField } from '../opponent/field-generator';
import {
  computeAnchor, buildWinnerDistribution, buildMaxerDistribution,
  computeAnchorTargets, SlateAnchor,
} from '../selection/anchor-relative';

const DIR = 'C:/Users/colin/dfs opto';
const FEE = 20;
const PROJ_BINS = [-30, -20, -15, -10, -7, -4, -1, 3];
const OWN_BINS = [-12, -8, -5, -3, -1, 1, 3, 6];

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

function binKey(projDelta: number, ownDelta: number): string {
  let pBin = 0;
  for (let i = PROJ_BINS.length - 1; i >= 0; i--) if (projDelta >= PROJ_BINS[i]) { pBin = i; break; }
  let oBin = 0;
  for (let i = OWN_BINS.length - 1; i >= 0; i--) if (ownDelta >= OWN_BINS[i]) { oBin = i; break; }
  return `${pBin}_${oBin}`;
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

function scorePortfolio(portfolio: Lineup[], actuals: ContestActuals, actualByHash: Map<string, number>, payoutTable: Float64Array) {
  const F = actuals.entries.length;
  const sorted = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
  const top1T = sorted[Math.max(0, Math.floor(F * 0.01) - 1)] || 0;
  let t1 = 0, scored = 0, totalPayout = 0;
  for (const lu of portfolio) {
    const fa = actualByHash.get(lu.hash); let a: number | null = fa !== undefined ? fa : null;
    if (a === null) { let t = 0, miss = false; for (const p of lu.players) { const r = actuals.playerActualsByName.get(norm(p.name)); if (!r) { miss = true; break; } t += r.fpts; } if (!miss) a = t; }
    if (a === null) continue; scored++;
    let lo = 0, hi = sorted.length; while (lo < hi) { const mid = (lo + hi) >>> 1; if (sorted[mid] >= a) lo = mid + 1; else hi = mid; }
    const rank = Math.max(1, lo);
    if (a >= top1T) t1++;
    const payout = rank <= payoutTable.length ? payoutTable[rank - 1] : 0;
    if (payout > 0) { let coWin = 0; for (const e of actuals.entries) if (Math.abs(e.actualPoints - a) <= 0.25) coWin++; coWin = Math.max(0, coWin - 1); totalPayout += payout / Math.sqrt(1 + coWin * 0.5); }
  }
  const stackTeams = new Set<string>(); let sOwn = 0, sProj = 0;
  for (const lu of portfolio) { sOwn += lu.players.reduce((s: number, p: Player) => s + (p.ownership || 0), 0) / lu.players.length; sProj += lu.projection; const tc = new Map<string, number>(); for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1); for (const [t, c] of tc) if (c >= 4) stackTeams.add(t); }
  return { t1, scored, totalPayout, stacks: stackTeams.size, avgOwn: portfolio.length > 0 ? sOwn / portfolio.length : 0, avgProj: portfolio.length > 0 ? sProj / portfolio.length : 0 };
}

/**
 * Hybrid selector: anchor-relative bins + V32's precomp-based projection ranking within bins.
 */
function hybridSelect(
  precomp: SlatePrecomputation,
  poolLineups: Lineup[],
  targets: Map<string, number>,
  anchor: SlateAnchor,
  allPlayers: Player[],
  N: number,
): Lineup[] {
  const maxPerTeam = Math.floor(N * 0.10);
  const expCap = Math.ceil(0.40 * N);

  // Pre-compute each candidate's relative bin
  const candInfo = Array.from({ length: precomp.C }, (_, c) => {
    const lu = precomp.candidatePool[c];
    const own = lu.players.reduce((s: number, p: Player) => s + (p.ownership || 0), 0) / lu.players.length;
    const projDelta = lu.projection - anchor.projection;
    const ownDelta = own - anchor.ownership;
    return { idx: c, bin: binKey(projDelta, ownDelta), projection: precomp.candidateProjection[c] };
  });

  const selected: Lineup[] = [];
  const selectedHashes = new Set<string>();
  const playerCount = new Map<string, number>();
  const teamStackCount = new Map<string, number>();

  // Sort allocations by target size (fill biggest targets first)
  const sortedAlloc = [...targets.entries()].sort((a, b) => b[1] - a[1]);

  for (const [targetBin, targetCount] of sortedAlloc) {
    // Find candidates in this bin, sorted by precomp projection (V32's within-region ranking)
    const binCands = candInfo
      .filter(c => c.bin === targetBin)
      .sort((a, b) => b.projection - a.projection);

    let filled = 0;
    for (const cand of binCands) {
      if (filled >= targetCount) break;
      const lu = precomp.candidatePool[cand.idx];
      if (selectedHashes.has(lu.hash)) continue;

      // Exposure
      let expOk = true;
      for (const p of lu.players) if ((playerCount.get(p.id) || 0) >= expCap) { expOk = false; break; }
      if (!expOk) continue;

      // Team stack cap
      const tc = new Map<string, number>();
      for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
      let teamOk = true;
      for (const [t, cnt] of tc) if (cnt >= 4 && (teamStackCount.get(t) || 0) >= maxPerTeam) { teamOk = false; break; }
      if (!teamOk) continue;

      selected.push(lu);
      selectedHashes.add(lu.hash);
      for (const p of lu.players) playerCount.set(p.id, (playerCount.get(p.id) || 0) + 1);
      for (const [t, cnt] of tc) if (cnt >= 4) teamStackCount.set(t, (teamStackCount.get(t) || 0) + 1);
      filled++;
    }
  }

  // Team coverage enforcement
  const covTeams = new Map<string, number>();
  for (const lu of selected) {
    const tc = new Map<string, number>(); for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
    for (const [t, c] of tc) if (c >= 4) covTeams.set(t, (covTeams.get(t) || 0) + 1);
  }
  const allTeams = new Set<string>(); for (const p of allPlayers) if (p.team) allTeams.add(p.team);
  const minPerTeam = Math.max(3, Math.floor(N / allTeams.size * 0.6));
  for (const team of allTeams) {
    if ((covTeams.get(team) || 0) >= minPerTeam) continue;
    const teamCands = candInfo.filter(c => {
      const lu = precomp.candidatePool[c.idx]; const tc = new Map<string, number>();
      for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
      return (tc.get(team) || 0) >= 4;
    }).sort((a, b) => b.projection - a.projection);
    if (teamCands.length < 5) continue;
    const needed = minPerTeam - (covTeams.get(team) || 0);
    let added = 0;
    for (const cand of teamCands) {
      if (added >= needed) break;
      const lu = precomp.candidatePool[cand.idx];
      if (selectedHashes.has(lu.hash)) continue;
      let expOk = true; for (const p of lu.players) if ((playerCount.get(p.id) || 0) >= expCap) { expOk = false; break; } if (!expOk) continue;
      if (selected.length >= N) {
        const wIdx = selected.reduce((best, lu2, idx) => lu2.projection < selected[best].projection ? idx : best, 0);
        const rem = selected[wIdx]; for (const p of rem.players) { const c = playerCount.get(p.id) || 0; if (c > 0) playerCount.set(p.id, c - 1); }
        selectedHashes.delete(rem.hash); selected[wIdx] = lu;
      } else selected.push(lu);
      selectedHashes.add(lu.hash); for (const p of lu.players) playerCount.set(p.id, (playerCount.get(p.id) || 0) + 1);
      added++;
    }
  }

  // Fill remainder by projection
  if (selected.length < N) {
    const all2 = candInfo.sort((a, b) => b.projection - a.projection);
    for (const c of all2) { if (selected.length >= N) break; const lu = precomp.candidatePool[c.idx]; if (selectedHashes.has(lu.hash)) continue;
      let ok = true; for (const p of lu.players) if ((playerCount.get(p.id) || 0) >= expCap) { ok = false; break; } if (!ok) continue;
      selected.push(lu); selectedHashes.add(lu.hash); for (const p of lu.players) playerCount.set(p.id, (playerCount.get(p.id) || 0) + 1);
    }
  }

  return selected;
}

async function main() {
  const pct = (v: number) => `${(v*100).toFixed(2)}%`;

  interface SlateInfo { slate: string; actuals: ContestActuals; nameMap: Map<string, Player>; pool: Lineup[]; players: Player[]; config: any }
  const slateData: SlateInfo[] = [];
  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj), actualsPath = path.join(DIR, s.actuals), poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) continue;
    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);
    const nameMap = new Map<string, Player>(); for (const p of pool.players) nameMap.set(norm(p.name), p);
    const idMap = new Map<string, Player>(); for (const p of pool.players) idMap.set(p.id, p);
    const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
    slateData.push({ slate: s.slate, actuals, nameMap, pool: loaded.lineups, players: pool.players, config });
  }

  let md = `# Hybrid Backtest — Anchor-Relative Regions + V32 Sim Scoring (${slateData.length} slates)\n\n`;
  md += `| Slate | F | Hybrid t1 | Hybrid pay | Stacks | Own | Proj |\n`;
  md += `|---|---:|---:|---:|---:|---:|---:|\n`;

  let totalPay = 0, totalT1 = 0, n = 0;

  for (let i = 0; i < slateData.length; i++) {
    const held = slateData[i];
    console.log(`\n=== ${held.slate} ===`);

    // Build anchor-relative distributions from other slates
    const training = slateData.filter((_, j) => j !== i).map(sd => ({ actuals: sd.actuals, nameMap: sd.nameMap, pool: sd.pool }));
    const winnerDist = buildWinnerDistribution(training);
    const maxerDist = buildMaxerDistribution(training);

    // Compute anchor for held-out slate
    const anchor = computeAnchor(held.pool);
    console.log(`  anchor: proj=${anchor.projection.toFixed(1)} own=${anchor.ownership.toFixed(1)}%`);

    // Compute anchor-relative targets (85% winner, 15% maxer)
    const targets = computeAnchorTargets(winnerDist, maxerDist, anchor, 150, 0.85);

    // V32's precomp with blended field
    const F = held.actuals.entries.length;
    const blendedField = generateBlendedField(held.pool, held.players, held.config, Math.min(8000, F), 0.20);
    const selParams: SelectorParams = { ...DEFAULT_SELECTOR_PARAMS, ...getSportDefaults('mlb'), N: 150, gamma: defaultGamma(held.config.rosterSize), numWorlds: 1500 };
    const precomp = precomputeSlate(held.pool, blendedField, held.players, selParams, 'mlb');

    // Hybrid selection
    const portfolio = hybridSelect(precomp, held.pool, targets.allocations, anchor, held.players, 150);

    // Score
    const payoutTable = buildPayoutTable(F);
    const actualByHash = new Map<string, number>();
    for (const e of held.actuals.entries) {
      const pls: Player[] = []; let ok = true;
      for (const nm of e.playerNames) { const p = held.nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
      if (!ok) continue;
      actualByHash.set(pls.map(p => p.id).sort().join('|'), e.actualPoints);
    }
    const result = scorePortfolio(portfolio, held.actuals, actualByHash, payoutTable);
    console.log(`  Hybrid: t1=${result.t1} pay=$${result.totalPayout.toFixed(0)} stacks=${result.stacks} own=${result.avgOwn.toFixed(1)}% proj=${result.avgProj.toFixed(1)}`);

    totalPay += result.totalPayout; totalT1 += result.t1; n++;
    md += `| ${held.slate} | ${F.toLocaleString()} | ${result.t1} (${pct(result.scored>0?result.t1/result.scored:0)}) | $${result.totalPayout.toFixed(0)} | ${result.stacks} | ${result.avgOwn.toFixed(1)}% | ${result.avgProj.toFixed(1)} |\n`;
  }

  const totalFees = FEE * 150 * n;
  md += `| **TOTAL** | | **${totalT1}** | **$${totalPay.toFixed(0)}** | | | |\n\n`;
  md += `**Hybrid ROI: ${((totalPay/totalFees-1)*100).toFixed(1)}%**\n\n`;
  md += `| Selector | Hits | Payout | ROI |\n|---|---:|---:|---:|\n`;
  md += `| **Hybrid (AR + V32 sim)** | **${totalT1}** | **$${totalPay.toFixed(0)}** | **${((totalPay/totalFees-1)*100).toFixed(1)}%** |\n`;
  md += `| V32 regions | 25 | $19,014 | −9.5% |\n`;
  md += `| Anchor-relative (10% cap) | 17 | $18,410 | −12.3% |\n`;

  fs.writeFileSync(path.join(DIR, 'hybrid_backtest.md'), md);
  console.log(`\n✓ Report: ${path.join(DIR, 'hybrid_backtest.md')}`);
}
main();
