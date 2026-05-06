/**
 * Isolated test: does adding a projectionFloorPct=0.85 to NBA production cost anything vs baseline?
 * No other changes — same bins, same γ, same λ.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals } from '../parser';
import { getContestConfig } from '../rules';
import { productionSelect } from '../selection/production-selector';

const DIR = 'C:/Users/colin/Projects/dfs-optimizer/historical_slates';
const FEE = 20;
const N = 150;
const GAMMA = 6;

const SLATES = [
  { slate: '2026-01-16', proj: '2026-01-16_projections.csv', actuals: '2026-01-16_actuals.csv', pool: '_backtest_2026-01-16.csv' },
  { slate: '2026-01-17', proj: '2026-01-17_projections.csv', actuals: '2026-01-17_actuals.csv', pool: '_backtest_2026-01-17.csv' },
  { slate: '2026-01-18', proj: '2026-01-18_projections.csv', actuals: '2026-01-18_actuals.csv', pool: '_backtest_2026-01-18.csv' },
  { slate: '2026-01-19', proj: '2026-01-19_projections.csv', actuals: '2026-01-19_actuals.csv', pool: '_backtest_2026-01-19.csv' },
  { slate: '2026-01-20', proj: '2026-01-20_projections.csv', actuals: '2026-01-20_actuals.csv', pool: '_backtest_2026-01-20.csv' },
  { slate: '2026-02-25', proj: '2026-02-25_projections.csv', actuals: '2026-02-25_actuals.csv', pool: '_backtest_2026-02-25.csv' },
  { slate: '2026-02-26', proj: '2026-02-26_projections.csv', actuals: '2026-02-26_actuals.csv', pool: '_backtest_2026-02-26.csv' },
  { slate: '2026-02-27', proj: '2026-02-27_projections.csv', actuals: '2026-02-27_actuals.csv', pool: '_backtest_2026-02-27.csv' },
  { slate: '2026-02-28', proj: '2026-02-28_projections.csv', actuals: '2026-02-28_actuals.csv', pool: '_backtest_2026-02-28.csv' },
  { slate: '2026-03-03', proj: '2026-03-03_projections.csv', actuals: '2026-03-03_actuals.csv', pool: '_backtest_2026-03-03.csv' },
  { slate: '2026-03-05', proj: '2026-03-05_dk_projections.csv', actuals: '2026-03-05_dk_actuals.csv', pool: '_backtest_2026-03-05_dk.csv' },
  { slate: '2026-03-06', proj: '2026-03-06_dk_projections.csv', actuals: '2026-03-06_dk_actuals.csv', pool: '_backtest_2026-03-06_dk.csv' },
];

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }

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

function score(portfolio: Lineup[], actuals: ContestActuals, actualByHash: Map<string, number>, payoutTable: Float64Array) {
  const F = actuals.entries.length;
  const sorted = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
  const top1T = sorted[Math.max(0, Math.floor(F * 0.01) - 1)] || 0;
  let t1 = 0, tot = 0;
  for (const lu of portfolio) {
    const h = lu.players.map(p => p.id).sort().join('|');
    let a: number | null = actualByHash.get(h) ?? null;
    if (a === null) {
      let t = 0, miss = false;
      for (const p of lu.players) { const r = actuals.playerActualsByName.get(norm(p.name)); if (!r) { miss = true; break; } t += r.fpts; }
      if (!miss) a = t;
    }
    if (a === null) continue;
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const m = (lo + hi) >>> 1; if (sorted[m] >= a) lo = m + 1; else hi = m; }
    const rank = Math.max(1, lo);
    if (a >= top1T) t1++;
    const pay = rank <= payoutTable.length ? payoutTable[rank - 1] : 0;
    if (pay > 0) {
      let co = 0; for (const e of actuals.entries) if (Math.abs(e.actualPoints - a) <= 0.25) co++;
      co = Math.max(0, co - 1);
      tot += pay / Math.sqrt(1 + co * 0.5);
    }
  }
  return { t1, tot };
}

async function main() {
  console.log('Loading 12 NBA slates...\n');
  const sds: { slate: string; actuals: ContestActuals; actualByHash: Map<string, number>; candidates: Lineup[]; players: Player[]; pay: Float64Array }[] = [];
  for (const s of SLATES) {
    const pp = path.join(DIR, s.proj), ap = path.join(DIR, s.actuals), bp = path.join(DIR, s.pool);
    if (![pp, ap, bp].every(p => fs.existsSync(p))) continue;
    try {
      const pr = parseCSVFile(pp, 'nba', true);
      const cfg = getContestConfig('dk', 'nba', pr.detectedContestType);
      const pool = buildPlayerPool(pr.players, pr.detectedContestType);
      const actuals = parseContestActuals(ap, cfg);
      const nameMap = new Map<string, Player>(); for (const p of pool.players) nameMap.set(norm(p.name), p);
      const idMap = new Map<string, Player>(); for (const p of pool.players) idMap.set(p.id, p);
      const loaded = loadPoolFromCSV({ filePath: bp, config: cfg, playerMap: idMap });
      const hashMap = new Map<string, number>();
      for (const e of actuals.entries) {
        const pls: Player[] = []; let ok = true;
        for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
        if (!ok) continue;
        hashMap.set(pls.map(p => p.id).sort().join('|'), e.actualPoints);
      }
      sds.push({ slate: s.slate, actuals, actualByHash: hashMap, candidates: loaded.lineups, players: pool.players, pay: buildPayoutTable(actuals.entries.length) });
    } catch {}
  }
  console.log(`\nLoaded ${sds.length} slates.\n`);

  const results: { slate: string; base: number; baseT1: number; floor: number; floorT1: number; pctDropped: number }[] = [];
  for (const sd of sds) {
    const baseR = productionSelect(sd.candidates, sd.players, { N, lambda: 0, maxOverlap: GAMMA, minPrimaryStack: 0, projectionFloorPct: 0 });
    const floorR = productionSelect(sd.candidates, sd.players, { N, lambda: 0, maxOverlap: GAMMA, minPrimaryStack: 0, projectionFloorPct: 0.85 });
    const baseS = score(baseR.portfolio, sd.actuals, sd.actualByHash, sd.pay);
    const floorS = score(floorR.portfolio, sd.actuals, sd.actualByHash, sd.pay);

    const optimalProj = sd.candidates.reduce((m, lu) => lu.projection > m ? lu.projection : m, 0);
    const kept = sd.candidates.filter(lu => lu.projection >= 0.85 * optimalProj).length;
    const pctDropped = 100 * (1 - kept / sd.candidates.length);
    results.push({ slate: sd.slate, base: baseS.tot, baseT1: baseS.t1, floor: floorS.tot, floorT1: floorS.t1, pctDropped });
  }

  console.log('Slate      | baseline          | 85% floor         | Δ         | % dropped');
  console.log('-----------|-------------------|-------------------|-----------|----------');
  let totalBase = 0, totalFloor = 0, tBaseT1 = 0, tFloorT1 = 0;
  for (const r of results) {
    const d = r.floor - r.base;
    console.log(`${r.slate} | $${r.base.toFixed(0).padStart(7)} (t1=${r.baseT1.toString().padStart(2)}) | $${r.floor.toFixed(0).padStart(7)} (t1=${r.floorT1.toString().padStart(2)}) | ${d >= 0 ? '+' : ''}$${d.toFixed(0).padStart(6)} | ${r.pctDropped.toFixed(1).padStart(4)}%`);
    totalBase += r.base; totalFloor += r.floor; tBaseT1 += r.baseT1; tFloorT1 += r.floorT1;
  }
  console.log('-----------|-------------------|-------------------|-----------|----------');
  const dT = totalFloor - totalBase;
  console.log(`TOTAL      | $${totalBase.toFixed(0).padStart(7)} (t1=${tBaseT1.toString().padStart(2)}) | $${totalFloor.toFixed(0).padStart(7)} (t1=${tFloorT1.toString().padStart(2)}) | ${dT >= 0 ? '+' : ''}$${dT.toFixed(0).padStart(6)}`);
  console.log(`\nPer-slate: ${results.filter(r => r.floor > r.base).length} wins, ${results.filter(r => r.floor < r.base).length} losses, ${results.filter(r => r.floor === r.base).length} ties`);
}

main().catch(e => { console.error(e); process.exit(1); });
