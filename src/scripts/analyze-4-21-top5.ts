/**
 * 4-21 post-mortem: what would SaberSim have picked as top-5 from our 150, and how did those 5 actually perform?
 *
 * Reconstructs what we shipped on 4-21 (λ=0.05, γ=7), then ranks by sim ROI
 * for Large Slate | 10k-50k (SS's likely recommendation column), takes the
 * top 5, and scores each against actuals + their full contest-bracket sim ROI.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';
import { productionSelect } from '../selection/production-selector';
import { precomputeComboFrequencies } from '../selection/combo-leverage';

const DIR = 'C:/Users/colin/dfs opto';
const FEE = 20;
const N = 150;
const LAMBDA = 0.05;
const GAMMA = 7;

const ROI_COLS = [
  'Large Slate | 100-1k', 'Large Slate | 1k-10k', 'Large Slate | 10k-50k', 'Large Slate | 50k+',
  'Small Slate | 100-1k', 'Small Slate | 1k-10k', 'Small Slate | 10k-50k', 'Small Slate | 50k+',
];
const RANK_BY = 'Large Slate | 10k-50k'; // SS's typical ranking for main GPP

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }

function parsePoolROIs(filePath: string, rosterSize: number): Map<string, Map<string, number>> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const records: string[][] = parse(content, { columns: false, skip_empty_lines: true, relax_column_count: true, trim: true });
  const headers = records[0];
  const colIdx = new Map<string, number>();
  for (const c of ROI_COLS) {
    const i = headers.findIndex(h => h.trim() === c);
    if (i !== -1) colIdx.set(c, i);
  }
  const map = new Map<string, Map<string, number>>();
  for (let r = 1; r < records.length; r++) {
    const row = records[r];
    const ids: string[] = [];
    for (let i = 0; i < rosterSize; i++) if (row[i]) ids.push(row[i]);
    if (ids.length !== rosterSize) continue;
    const hash = [...ids].sort().join('|');
    const m = new Map<string, number>();
    for (const [c, i] of colIdx) {
      const v = parseFloat(row[i]);
      if (!isNaN(v)) m.set(c, v);
    }
    map.set(hash, m);
  }
  return map;
}

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

async function main() {
  const slate = '4-21-26';
  const projPath = path.join(DIR, '4-21-26projections.csv');
  const actualsPath = path.join(DIR, '4-21-26actuals.csv');
  const poolPath = path.join(DIR, '4-21-26sspool.csv');

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
    for (const nm of e.playerNames) {
      const p = nameMap.get(norm(nm));
      if (!p) { ok = false; break; }
      pls.push(p);
    }
    if (!ok) continue;
    actualByHash.set(pls.map(p => p.id).sort().join('|'), e.actualPoints);
  }

  const roiByHash = parsePoolROIs(poolPath, config.rosterSize);
  const comboFreq = precomputeComboFrequencies(loaded.lineups, 3);
  const result = productionSelect(loaded.lineups, pool.players, {
    N, lambda: LAMBDA, comboFreq, maxOverlap: GAMMA,
  });

  const payoutTable = buildPayoutTable(F);
  const sortedActuals = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
  const top1T = sortedActuals[Math.max(0, Math.floor(F * 0.01) - 1)];

  // Compute per-lineup: hash, sim ROI for main bracket, actual points, rank, payout
  type LineupAnalysis = {
    lu: Lineup; rankByROI: number; roiMain: number; roiAll: Map<string, number>;
    actual: number | null; rank: number | null; payout: number;
  };
  const analyzed: LineupAnalysis[] = result.portfolio.map(lu => {
    const hash = lu.players.map(p => p.id).sort().join('|');
    const roiMap = roiByHash.get(hash) || new Map();
    const roiMain = roiMap.get(RANK_BY) ?? -Infinity;
    let actualScore: number | null = actualByHash.get(hash) ?? null;
    if (actualScore === null) {
      let t = 0, miss = false;
      for (const p of lu.players) {
        const r = actuals.playerActualsByName.get(norm(p.name));
        if (!r) { miss = true; break; }
        t += r.fpts;
      }
      if (!miss) actualScore = t;
    }
    let rank: number | null = null, payout = 0;
    if (actualScore !== null) {
      // Binary search
      let lo = 0, hi = sortedActuals.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (sortedActuals[mid] >= actualScore) lo = mid + 1; else hi = mid;
      }
      rank = Math.max(1, lo);
      if (rank <= payoutTable.length) payout = payoutTable[rank - 1];
    }
    return { lu, rankByROI: 0, roiMain, roiAll: roiMap, actual: actualScore, rank, payout };
  });

  // Rank by sim ROI main
  analyzed.sort((a, b) => b.roiMain - a.roiMain);
  analyzed.forEach((a, i) => { a.rankByROI = i + 1; });

  // Pool-wide sim ROI distribution
  const allROIs = [...roiByHash.values()].map(m => m.get(RANK_BY)).filter((v): v is number => v !== undefined).sort((a, b) => a - b);
  const p10 = allROIs[Math.floor(allROIs.length * 0.1)];
  const p50 = allROIs[Math.floor(allROIs.length * 0.5)];
  const p90 = allROIs[Math.floor(allROIs.length * 0.9)];
  const maxROI = allROIs[allROIs.length - 1];

  console.log('================================================================');
  console.log(`4-21 POST-MORTEM: top-5 by SaberSim sim ROI (ranked on "${RANK_BY}")`);
  console.log('================================================================\n');
  console.log(`Field size: ${F.toLocaleString()}, top-1% threshold: ${top1T.toFixed(2)} pts`);
  console.log(`Pool ROI dist (all 5228 pool lineups): p10=${p10.toFixed(2)}  p50=${p50.toFixed(2)}  p90=${p90.toFixed(2)}  max=${maxROI.toFixed(2)}`);
  console.log(`Remember: sim ROI 100 = break-even. Below 100 = negative absolute ROI.`);
  console.log(`Rake forces almost the entire pool below 100 on this slate.\n`);

  console.log('================================================================');
  console.log('SaberSim would have picked these 5 as "best":');
  console.log('================================================================\n');
  for (let i = 0; i < 5; i++) {
    const a = analyzed[i];
    console.log(`\n#${i + 1}  sim ROI (main)=${a.roiMain.toFixed(2)}  proj=${a.lu.projection.toFixed(1)}  actual=${a.actual?.toFixed(2) ?? 'n/a'} pts  rank=${a.rank ?? 'n/a'}  payout=$${a.payout.toFixed(2)}`);
    const otherBrackets = ROI_COLS.filter(c => c !== RANK_BY).map(c => `${c.split('|')[1].trim()}=${a.roiAll.get(c)?.toFixed(1) ?? '—'}`).join('  ');
    console.log(`   sim ROI across brackets: ${otherBrackets}`);
    console.log(`   Players:`);
    for (const p of a.lu.players) {
      const playerActual = actuals.playerActualsByName.get(norm(p.name));
      const fpts = playerActual ? playerActual.fpts.toFixed(1) : '?';
      console.log(`     ${(p.positions?.[0] || '?').padEnd(3)} ${p.name.padEnd(25)} ${p.team.padEnd(4)} own=${(p.ownership || 0).toFixed(1).padStart(5)}%  proj=${p.projection.toFixed(1).padStart(5)}  actual=${fpts.padStart(5)}`);
    }
  }

  // Summary
  const top5 = analyzed.slice(0, 5);
  const feesTop5 = FEE * 5;
  const payoutsTop5 = top5.reduce((s, a) => s + a.payout, 0);
  const netTop5 = payoutsTop5 - feesTop5;
  const negativeCount = top5.filter(a => a.payout < FEE).length;
  const cashedCount = top5.filter(a => a.payout >= FEE).length;

  console.log('\n================================================================');
  console.log('SUMMARY — 5 entries at $20 each on 4-21');
  console.log('================================================================');
  console.log(`Fees paid: $${feesTop5}`);
  console.log(`Payouts: $${payoutsTop5.toFixed(2)}`);
  console.log(`Net: ${netTop5 >= 0 ? '+' : ''}$${netTop5.toFixed(2)}`);
  console.log(`Lineups with negative ROI (payout < $20 entry fee): ${negativeCount}/5`);
  console.log(`Lineups cashed: ${cashedCount}/5`);
  console.log();
  console.log('Full 150-lineup portfolio performance:');
  const totalPay = analyzed.reduce((s, a) => s + a.payout, 0);
  const totalFees = FEE * N;
  const hits = analyzed.filter(a => a.actual !== null && a.actual >= top1T).length;
  console.log(`  Total payout: $${totalPay.toFixed(0)}  top-1% hits: ${hits}  net: ${(totalPay - totalFees >= 0 ? '+' : '') + (totalPay - totalFees).toFixed(0)}`);
  console.log();
  console.log('Top-5 vs Full-150 ROI:');
  console.log(`  Top-5 by sim ROI:  ${((payoutsTop5 / feesTop5 - 1) * 100).toFixed(1)}%`);
  console.log(`  Full 150 lineups:  ${((totalPay / totalFees - 1) * 100).toFixed(1)}%`);
}

main().catch(e => { console.error(e); process.exit(1); });
