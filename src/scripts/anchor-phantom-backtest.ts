/**
 * Anchor-Phantom Hunter — the anchor (what the field plays) is a weighted
 * phantom entry. Hunter marginal gain picks lineups that differentiate from
 * the phantom + each other. No bins. No regions. Pure differentiation.
 *
 * phantom_weight = estimated field entries near the anchor (~fieldSize × 0.30)
 * gain(c) = Σ_w [hit(c,w) / (1 + phantom_hits(w) × phantom_weight_frac + portfolio_hits(w))]
 *
 * The phantom represents "what 30% of the field is playing." Candidates that
 * win in the SAME worlds as the phantom get crushed. Candidates that win in
 * DIFFERENT worlds get boosted.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals } from '../parser';
import { getContestConfig } from '../rules';
import { computeAnchor } from '../selection/anchor-relative';

const DIR = 'C:/Users/colin/dfs opto';
const FEE = 20;
const NUM_WORLDS = 2000;
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

// ============================================================
// SIMPLE WORLD SIM
// ============================================================

function simulateWorlds(players: Player[], W: number, seed: number = 42): { playerScores: Float32Array; playerIndex: Map<string, number> } {
  const P = players.length;
  const playerIndex = new Map<string, number>();
  players.forEach((p, i) => playerIndex.set(p.id, i));
  const playerScores = new Float32Array(P * W);
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
    for (let w = 0; w < W; w++) {
      const u = rng(); let val = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        if (u >= pts[i].q && u < pts[i + 1].q) {
          val = pts[i].v + ((u - pts[i].q) / (pts[i + 1].q - pts[i].q)) * (pts[i + 1].v - pts[i].v);
          break;
        }
      }
      playerScores[p * W + w] = val;
    }
  }
  return { playerScores, playerIndex };
}

function scoreLineup(lu: Lineup, playerScores: Float32Array, playerIndex: Map<string, number>, W: number): Float32Array {
  const scores = new Float32Array(W);
  for (const p of lu.players) {
    const idx = playerIndex.get(p.id);
    if (idx === undefined) continue;
    for (let w = 0; w < W; w++) scores[w] += playerScores[idx * W + w];
  }
  return scores;
}

// ============================================================
// PHANTOM ANCHOR SELECTOR
// ============================================================

function phantomHunterSelect(
  pool: Lineup[],
  players: Player[],
  fieldSize: number,
  N: number,
): Lineup[] {
  const maxPerTeam = Math.floor(N * 0.10);
  const expCap = Math.ceil(0.40 * N);
  const W = NUM_WORLDS;

  // Simulate worlds
  const { playerScores, playerIndex } = simulateWorlds(players, W);

  // Score all pool lineups
  console.log(`    scoring ${pool.length} lineups across ${W} worlds…`);
  const poolScores = pool.map(lu => scoreLineup(lu, playerScores, playerIndex, W));

  // Compute per-world thresholds from pool
  const topRank = Math.max(1, Math.floor(pool.length * 0.01));
  const thresholds = new Float32Array(W);
  const col = new Float64Array(pool.length);
  for (let w = 0; w < W; w++) {
    for (let i = 0; i < pool.length; i++) col[i] = poolScores[i][w];
    col.sort();
    thresholds[w] = col[pool.length - topRank];
  }

  // Pre-compute hits
  const hits: Uint8Array[] = pool.map((_, i) => {
    const h = new Uint8Array(W);
    for (let w = 0; w < W; w++) if (poolScores[i][w] >= thresholds[w]) h[w] = 1;
    return h;
  });

  // Build phantom: the anchor (top-100 pool centroid) scored across worlds.
  // The phantom represents the ~30% of the field that plays anchor-adjacent lineups.
  const anchor = computeAnchor(pool, 100);
  // Find the pool lineup closest to anchor as the phantom representative
  let bestPhantomIdx = 0, bestPhantomDist = Infinity;
  for (let i = 0; i < pool.length; i++) {
    const own = pool[i].players.reduce((s, p) => s + (p.ownership || 0), 0) / pool[i].players.length;
    const dist = Math.abs(pool[i].projection - anchor.projection) + Math.abs(own - anchor.ownership) * 5;
    if (dist < bestPhantomDist) { bestPhantomDist = dist; bestPhantomIdx = i; }
  }

  // Phantom weight: how many field entries are similar to the anchor
  // Estimate: 30% of field plays anchor-adjacent lineups
  const phantomWeight = fieldSize * 0.30;

  // The phantom's hit vector
  const phantomHits = hits[bestPhantomIdx];

  // Pre-compute phantom's per-world contribution to the denominator
  const phantomDenom = new Float32Array(W);
  for (let w = 0; w < W; w++) {
    phantomDenom[w] = phantomHits[w] * (phantomWeight / fieldSize);
  }

  console.log(`    phantom: pool lineup #${bestPhantomIdx} proj=${pool[bestPhantomIdx].projection.toFixed(1)} weight=${phantomWeight.toFixed(0)}`);

  // Greedy selection
  const selected: Lineup[] = [];
  const selectedHashes = new Set<string>();
  const playerCount = new Map<string, number>();
  const teamStackCount = new Map<string, number>();
  const portfolioHitsPerWorld = new Float32Array(W);

  for (let step = 0; step < N; step++) {
    let bestIdx = -1;
    let bestGain = -Infinity;

    for (let i = 0; i < pool.length; i++) {
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

      // Marginal gain: for each world this candidate hits,
      // gain += 1 / (1 + phantom_contribution + portfolio_contribution)
      let gain = 0;
      for (let w = 0; w < W; w++) {
        if (!hits[i][w]) continue;
        gain += 1 / (1 + phantomDenom[w] * fieldSize + portfolioHitsPerWorld[w]);
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

    if ((step + 1) % 25 === 0 || step === 0) {
      let cov = 0; for (let w = 0; w < W; w++) if (portfolioHitsPerWorld[w] > 0) cov++;
      const scenario = getScenario(lu);
      console.log(`    [phantom] ${step+1}/${N} gain=${bestGain.toFixed(6)} scenario=${scenario} cov=${(cov/W*100).toFixed(1)}%`);
    }
  }

  return selected;
}

function getScenario(lu: Lineup): string {
  const tc = new Map<string, number>();
  for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
  let best = '', bestC = 0;
  for (const [t, c] of tc) if (c > bestC) { bestC = c; best = t; }
  return best;
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
// MAIN
// ============================================================

async function main() {
  const pct = (v: number) => `${(v*100).toFixed(2)}%`;
  let md = `# Anchor-Phantom Hunter — No Bins, Pure Differentiation (${SLATES.length} slates)\n\n`;
  md += `Phantom = top-100 anchor, weighted at 30% of field.\n`;
  md += `Hunter marginal gain: pick lineups that win in worlds the phantom DOESN'T.\n\n`;
  md += `| Slate | F | PH t1 | PH pay | Stacks | Own | Proj |\n`;
  md += `|---|---:|---:|---:|---:|---:|---:|\n`;

  let totalPay = 0, totalT1 = 0, n = 0;

  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj), actualsPath = path.join(DIR, s.actuals), poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) continue;
    console.log(`\n=== ${s.slate} ===`);
    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);
    const nameMap = new Map<string, Player>(); for (const p of pool.players) nameMap.set(norm(p.name), p);
    const idMap = new Map<string, Player>(); for (const p of pool.players) idMap.set(p.id, p);
    const F = actuals.entries.length;
    const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
    const payoutTable = buildPayoutTable(F);
    const actualByHash = new Map<string, number>();
    for (const e of actuals.entries) { const pls: Player[] = []; let ok = true; for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); } if (!ok) continue; actualByHash.set(pls.map(p => p.id).sort().join('|'), e.actualPoints); }

    const portfolio = phantomHunterSelect(loaded.lineups, pool.players, F, 150);
    const result = scorePortfolio(portfolio, actuals, actualByHash, payoutTable);
    console.log(`  PH: t1=${result.t1} pay=$${result.totalPayout.toFixed(0)} stacks=${result.stacks} own=${result.avgOwn.toFixed(1)}% proj=${result.avgProj.toFixed(1)}`);

    totalPay += result.totalPayout; totalT1 += result.t1; n++;
    md += `| ${s.slate} | ${F.toLocaleString()} | ${result.t1} (${pct(result.scored>0?result.t1/result.scored:0)}) | $${result.totalPayout.toFixed(0)} | ${result.stacks} | ${result.avgOwn.toFixed(1)}% | ${result.avgProj.toFixed(1)} |\n`;
  }

  const totalFees = FEE * 150 * n;
  md += `| **TOTAL** | | **${totalT1}** | **$${totalPay.toFixed(0)}** | | | |\n\n`;
  md += `**Phantom Hunter ROI: ${((totalPay/totalFees-1)*100).toFixed(1)}%**\n\n`;
  md += `| Selector | Hits | Payout | ROI |\n|---|---:|---:|---:|\n`;
  md += `| Phantom Hunter | ${totalT1} | $${totalPay.toFixed(0)} | ${((totalPay/totalFees-1)*100).toFixed(1)}% |\n`;
  md += `| V32 regions | 25 | $19,014 | −9.5% |\n`;
  md += `| Anchor-relative (10% cap) | 17 | $18,410 | −12.3% |\n`;

  // Per-slate analysis: how did it do on contrarian slates specifically?
  md += `\n## Contrarian Slate Performance\n`;
  md += `4-8 (MIA boom, 6K entries): ${totalT1 > 0 ? 'see above' : 'evaluated above'}\n`;
  md += `4-14 (contrarian outcome, 16K): see above\n`;

  fs.writeFileSync(path.join(DIR, 'phantom_hunter_backtest.md'), md);
  console.log(`\n✓ Report: ${path.join(DIR, 'phantom_hunter_backtest.md')}`);
}
main();
