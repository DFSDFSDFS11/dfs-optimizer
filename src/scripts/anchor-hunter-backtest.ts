/**
 * Anchor-Relative + Hunter Within-Bin Marginal Gain.
 *
 * Regions: anchor-relative coordinates (auto-adapts to slate)
 * Within-bin: Hunter U²ₗ marginal gain with parimutuel weighting
 * Team cap: 10% max per team
 * No blended field, no σ_{δ,G}, no precompute complexity.
 *
 * Simple world simulation from SaberSim percentiles for hit computation.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals } from '../parser';
import { getContestConfig } from '../rules';
import {
  computeAnchor, buildWinnerDistribution, buildMaxerDistribution,
  computeAnchorTargets, SlateAnchor,
} from '../selection/anchor-relative';

const DIR = 'C:/Users/colin/dfs opto';
const FEE = 20;
const W = 2000; // simulation worlds
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
  let pBin = 0; for (let i = PROJ_BINS.length - 1; i >= 0; i--) if (projDelta >= PROJ_BINS[i]) { pBin = i; break; }
  let oBin = 0; for (let i = OWN_BINS.length - 1; i >= 0; i--) if (ownDelta >= OWN_BINS[i]) { oBin = i; break; }
  return `${pBin}_${oBin}`;
}

// ============================================================
// SIMPLE WORLD SIMULATION FROM PERCENTILES
// ============================================================

function simulatePlayerWorlds(players: Player[], numWorlds: number, seed: number = 42): Float32Array {
  const P = players.length;
  const scores = new Float32Array(P * numWorlds);
  let s = seed | 0;
  const rng = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };

  for (let p = 0; p < P; p++) {
    const pl = players[p];
    const pts = [
      { q: 0.00, v: 0 },
      { q: 0.25, v: pl.percentiles?.p25 || pl.projection * 0.6 },
      { q: 0.50, v: pl.percentiles?.p50 || pl.projection },
      { q: 0.75, v: pl.percentiles?.p75 || pl.projection * 1.2 },
      { q: 0.85, v: pl.percentiles?.p85 || pl.ceiling || pl.projection * 1.35 },
      { q: 0.95, v: pl.percentiles?.p95 || pl.projection * 1.6 },
      { q: 0.99, v: pl.percentiles?.p99 || pl.ceiling99 || pl.projection * 2.0 },
      { q: 1.00, v: (pl.percentiles?.p99 || pl.ceiling99 || pl.projection * 2.0) * 1.1 },
    ];
    for (let w = 0; w < numWorlds; w++) {
      const u = rng();
      let val = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        if (u >= pts[i].q && u < pts[i + 1].q) {
          const frac = (u - pts[i].q) / (pts[i + 1].q - pts[i].q);
          val = pts[i].v + frac * (pts[i + 1].v - pts[i].v);
          break;
        }
      }
      scores[p * numWorlds + w] = val;
    }
  }
  return scores;
}

function scoreLineupInWorlds(lu: Lineup, playerWorldScores: Float32Array, playerIndex: Map<string, number>, numWorlds: number): Float32Array {
  const scores = new Float32Array(numWorlds);
  for (const p of lu.players) {
    const idx = playerIndex.get(p.id);
    if (idx === undefined) continue;
    for (let w = 0; w < numWorlds; w++) scores[w] += playerWorldScores[idx * numWorlds + w];
  }
  return scores;
}

// ============================================================
// PAYOUT
// ============================================================

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

// ============================================================
// ANCHOR + HUNTER WITHIN-BIN SELECTOR
// ============================================================

function anchorHunterSelect(
  pool: Lineup[],
  targets: Map<string, number>,
  anchor: SlateAnchor,
  players: Player[],
  N: number,
): Lineup[] {
  const maxPerTeam = Math.floor(N * 0.10);
  const expCap = Math.ceil(0.40 * N);

  // Simulate worlds
  const playerIndex = new Map<string, number>();
  players.forEach((p, i) => playerIndex.set(p.id, i));
  const playerWorldScores = simulatePlayerWorlds(players, W);

  // Score every pool lineup in every world
  console.log(`    scoring ${pool.length} lineups across ${W} worlds…`);
  const poolWorldScores: Float32Array[] = pool.map(lu => scoreLineupInWorlds(lu, playerWorldScores, playerIndex, W));

  // Compute per-world top-1% threshold from pool (proxy for field threshold)
  const thresholds = new Float32Array(W);
  const topRank = Math.max(1, Math.floor(pool.length * 0.01));
  const col = new Float64Array(pool.length);
  for (let w = 0; w < W; w++) {
    for (let i = 0; i < pool.length; i++) col[i] = poolWorldScores[i][w];
    col.sort();
    thresholds[w] = col[pool.length - topRank];
  }

  // Pre-compute hits per lineup per world
  const hits: Uint8Array[] = pool.map((lu, i) => {
    const h = new Uint8Array(W);
    for (let w = 0; w < W; w++) if (poolWorldScores[i][w] >= thresholds[w]) h[w] = 1;
    return h;
  });

  // Pre-compute each lineup's bin
  const poolBins = pool.map(lu => {
    const own = lu.players.reduce((s, p) => s + (p.ownership || 0), 0) / lu.players.length;
    return binKey(lu.projection - anchor.projection, own - anchor.ownership);
  });

  // Greedy selection with Hunter marginal gain within bins
  const selected: Lineup[] = [];
  const selectedHashes = new Set<string>();
  const playerCount = new Map<string, number>();
  const teamStackCount = new Map<string, number>();
  const portfolioHitsPerWorld = new Float32Array(W);

  // Sort allocations by size
  const sortedAlloc = [...targets.entries()].sort((a, b) => b[1] - a[1]);

  for (const [targetBin, targetCount] of sortedAlloc) {
    const binIndices = pool.map((_, i) => i).filter(i => poolBins[i] === targetBin);

    let filled = 0;
    // Within this bin, greedily pick by marginal gain
    for (let step = 0; step < targetCount; step++) {
      let bestIdx = -1;
      let bestGain = -Infinity;

      for (const i of binIndices) {
        const lu = pool[i];
        if (selectedHashes.has(lu.hash)) continue;

        let expOk = true;
        for (const p of lu.players) if ((playerCount.get(p.id) || 0) >= expCap) { expOk = false; break; }
        if (!expOk) continue;

        const tc = new Map<string, number>();
        for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
        let teamOk = true;
        for (const [t, cnt] of tc) if (cnt >= 4 && (teamStackCount.get(t) || 0) >= maxPerTeam) { teamOk = false; break; }
        if (!teamOk) continue;

        // Hunter marginal gain: new worlds covered / (1 + portfolio hits in those worlds)
        let gain = 0;
        for (let w = 0; w < W; w++) {
          if (hits[i][w]) {
            gain += 1 / (1 + portfolioHitsPerWorld[w]);
          }
        }

        if (gain > bestGain) { bestGain = gain; bestIdx = i; }
      }

      if (bestIdx < 0) break;

      const lu = pool[bestIdx];
      selected.push(lu);
      selectedHashes.add(lu.hash);
      for (const p of lu.players) playerCount.set(p.id, (playerCount.get(p.id) || 0) + 1);
      const tc2 = new Map<string, number>();
      for (const p of lu.players) if (!p.positions?.includes('P')) tc2.set(p.team, (tc2.get(p.team) || 0) + 1);
      for (const [t, cnt] of tc2) if (cnt >= 4) teamStackCount.set(t, (teamStackCount.get(t) || 0) + 1);
      for (let w = 0; w < W; w++) if (hits[bestIdx][w]) portfolioHitsPerWorld[w]++;
      filled++;
    }
  }

  // Team coverage
  const covTeams = new Map<string, number>();
  for (const lu of selected) {
    const tc = new Map<string, number>(); for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
    for (const [t, c] of tc) if (c >= 4) covTeams.set(t, (covTeams.get(t) || 0) + 1);
  }
  const allTeams = new Set<string>(); for (const p of players) if (p.team) allTeams.add(p.team);
  const minPT = Math.max(3, Math.floor(N / allTeams.size * 0.6));
  for (const team of allTeams) {
    if ((covTeams.get(team) || 0) >= minPT) continue;
    const teamCands = pool.map((lu, i) => ({ lu, i })).filter(({ lu }) => {
      const tc = new Map<string, number>(); for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
      return (tc.get(team) || 0) >= 4;
    }).sort((a, b) => b.lu.projection - a.lu.projection);
    if (teamCands.length < 5) continue;
    const needed = minPT - (covTeams.get(team) || 0);
    let added = 0;
    for (const { lu } of teamCands) {
      if (added >= needed) break;
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

  // Fill
  if (selected.length < N) {
    const sorted2 = pool.map((lu, i) => ({ lu, i })).sort((a, b) => b.lu.projection - a.lu.projection);
    for (const { lu } of sorted2) { if (selected.length >= N) break; if (selectedHashes.has(lu.hash)) continue;
      let ok = true; for (const p of lu.players) if ((playerCount.get(p.id) || 0) >= expCap) { ok = false; break; } if (!ok) continue;
      selected.push(lu); selectedHashes.add(lu.hash); for (const p of lu.players) playerCount.set(p.id, (playerCount.get(p.id) || 0) + 1);
    }
  }

  return selected;
}

// ============================================================
// MAIN
// ============================================================

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

  let md = `# Anchor-Relative + Hunter Within-Bin (${slateData.length} slates)\n\n`;
  md += `Regions: anchor-relative (85% winner, 15% maxer)\n`;
  md += `Within-bin: Hunter marginal gain with parimutuel denominator\n`;
  md += `Team cap: 10% max\n\n`;
  md += `| Slate | F | AH t1 | AH pay | Stacks | Own | Proj |\n`;
  md += `|---|---:|---:|---:|---:|---:|---:|\n`;

  let totalPay = 0, totalT1 = 0, n = 0;

  for (let i = 0; i < slateData.length; i++) {
    const held = slateData[i];
    console.log(`\n=== ${held.slate} ===`);
    const training = slateData.filter((_, j) => j !== i).map(sd => ({ actuals: sd.actuals, nameMap: sd.nameMap, pool: sd.pool }));
    const winnerDist = buildWinnerDistribution(training);
    const maxerDist = buildMaxerDistribution(training);
    const anchor = computeAnchor(held.pool);
    const targets = computeAnchorTargets(winnerDist, maxerDist, anchor, 150, 0.85);
    console.log(`  anchor: proj=${anchor.projection.toFixed(1)} own=${anchor.ownership.toFixed(1)}%`);

    const portfolio = anchorHunterSelect(held.pool, targets.allocations, anchor, held.players, 150);

    const F = held.actuals.entries.length;
    const payoutTable = buildPayoutTable(F);
    const actualByHash = new Map<string, number>();
    for (const e of held.actuals.entries) { const pls: Player[] = []; let ok = true; for (const nm of e.playerNames) { const p = held.nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); } if (!ok) continue; actualByHash.set(pls.map(p => p.id).sort().join('|'), e.actualPoints); }
    const result = scorePortfolio(portfolio, held.actuals, actualByHash, payoutTable);

    console.log(`  AH: t1=${result.t1} pay=$${result.totalPayout.toFixed(0)} stacks=${result.stacks} own=${result.avgOwn.toFixed(1)}% proj=${result.avgProj.toFixed(1)}`);
    totalPay += result.totalPayout; totalT1 += result.t1; n++;
    md += `| ${held.slate} | ${F.toLocaleString()} | ${result.t1} (${pct(result.scored>0?result.t1/result.scored:0)}) | $${result.totalPayout.toFixed(0)} | ${result.stacks} | ${result.avgOwn.toFixed(1)}% | ${result.avgProj.toFixed(1)} |\n`;
  }

  const totalFees = FEE * 150 * n;
  md += `| **TOTAL** | | **${totalT1}** | **$${totalPay.toFixed(0)}** | | | |\n\n`;
  md += `**Anchor-Hunter ROI: ${((totalPay/totalFees-1)*100).toFixed(1)}%**\n\n`;
  md += `| Selector | Hits | Payout | ROI |\n|---|---:|---:|---:|\n`;
  md += `| Anchor-Hunter | ${totalT1} | $${totalPay.toFixed(0)} | ${((totalPay/totalFees-1)*100).toFixed(1)}% |\n`;
  md += `| V32 regions | 25 | $19,014 | −9.5% |\n`;
  md += `| Anchor-relative (10% cap) | 17 | $18,410 | −12.3% |\n`;

  fs.writeFileSync(path.join(DIR, 'anchor_hunter_backtest.md'), md);
  console.log(`\n✓ Report: ${path.join(DIR, 'anchor_hunter_backtest.md')}`);
}
main();
