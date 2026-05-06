/**
 * Audit: where do our selected lineups fall in SaberSim's ROI distribution?
 *
 * SaberSim's sim ROI is in "multiplier × 100" scale. 100 = break-even.
 * Due to ~12% rake, most of the pool sits around 85-95 (negative after rake).
 * The meaningful metric isn't "below 100" — it's **percentile rank within the pool**.
 *
 * If our selected lineups' median percentile is 50%, we're ignoring the sim ROI signal.
 * If above 50%, we're tilting toward high-ROI lineups.
 * If below 50%, we're actively picking worse-than-random.
 *
 * This audit reports:
 *   - Pool ROI distribution (p10, p25, p50, p75, p90, max) for "Large Slate | 10k-50k"
 *   - Our selected portfolio's ROI distribution
 *   - Our median rank within pool (as a percentile)
 *   - Count of our lineups in the top-10% pool ROI vs bottom-10%
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';
import { productionSelect } from '../selection/production-selector';
import { precomputeComboFrequencies } from '../selection/combo-leverage';

const DIR = 'C:/Users/colin/dfs opto';
const N = 150;
const LAMBDA = 0.05;
const GAMMA = 7;
const ROI_COL = 'Large Slate | 10k-50k'; // our typical contest size

const SLATES = [
  { slate: '4-6-26', proj: '4-6-26_projections.csv', pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26', proj: '4-8-26projections.csv', pool: '4-8-26sspool.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv', pool: '4-12-26sspool.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv', pool: '4-14-26sspool.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv', pool: '4-15-26sspool.csv' },
  { slate: '4-17-26', proj: '4-17-26projections.csv', pool: '4-17-26sspool.csv' },
  { slate: '4-18-26', proj: '4-18-26projections.csv', pool: '4-18-26sspool.csv' },
  { slate: '4-19-26', proj: '4-19-26projections.csv', pool: '4-19-26sspool.csv' },
  { slate: '4-20-26', proj: '4-20-26projections.csv', pool: '4-20-26sspool.csv' },
  { slate: '4-21-26', proj: '4-21-26projections.csv', pool: '4-21-26sspool.csv' },
];

function parsePoolROI(filePath: string, rosterSize: number, roiCol: string): Map<string, number> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const records: string[][] = parse(content, {
    columns: false, skip_empty_lines: true, relax_column_count: true, trim: true,
  });
  if (records.length < 2) return new Map();
  const headers = records[0];
  const roiIdx = headers.findIndex(h => h.trim() === roiCol);
  if (roiIdx === -1) return new Map();

  const hashMap = new Map<string, number>();
  for (let r = 1; r < records.length; r++) {
    const row = records[r];
    const ids: string[] = [];
    for (let i = 0; i < rosterSize; i++) if (row[i]) ids.push(row[i]);
    if (ids.length !== rosterSize) continue;
    const hash = [...ids].sort().join('|');
    const v = parseFloat(row[roiIdx]);
    if (!isNaN(v)) hashMap.set(hash, v);
  }
  return hashMap;
}

function hashLineup(lu: Lineup): string {
  return lu.players.map(p => p.id).sort().join('|');
}

function percentileRank(v: number, sortedAsc: number[]): number {
  let lo = 0, hi = sortedAsc.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedAsc[mid] < v) lo = mid + 1; else hi = mid;
  }
  return sortedAsc.length ? lo / sortedAsc.length : 0;
}

function pct(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.max(0, Math.min(s.length - 1, Math.floor(s.length * p)))];
}

async function main() {
  console.log('================================================================');
  console.log(`SIM-ROI AUDIT (rank-based) — contest: ${ROI_COL}`);
  console.log('================================================================\n');
  console.log('SaberSim ROI is multiplier×100. 100 = break-even, 88 = -12% ROI (typical rake).');
  console.log('Meaningful question: within each slate\'s pool, where do our lineups rank?\n');

  console.log('Slate      | Pool size | Pool ROI dist (p10/p50/p90/max)      | Our median ROI | Our median rank% | Top-10% hits | Bot-10% hits | Above-pool-median% |');
  console.log('-'.repeat(175));

  let totalAbovePoolMedian = 0;
  let totalLineups = 0;
  let totalTopDecile = 0;
  let totalBotDecile = 0;
  const rankShares: number[] = [];

  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj);
    const poolPath = path.join(DIR, s.pool);
    if (![projPath, poolPath].every(p => fs.existsSync(p))) continue;

    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const idMap = new Map<string, Player>();
    for (const p of pool.players) idMap.set(p.id, p);
    const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
    const comboFreq = precomputeComboFrequencies(loaded.lineups, 3);
    const result = productionSelect(loaded.lineups, pool.players, {
      N, lambda: LAMBDA, comboFreq, maxOverlap: GAMMA,
    });

    const roiByHash = parsePoolROI(poolPath, config.rosterSize, ROI_COL);
    if (roiByHash.size === 0) {
      console.log(`${s.slate.padEnd(10)} | (no ROI column data)`);
      continue;
    }

    const poolROIs = [...roiByHash.values()];
    const poolSorted = [...poolROIs].sort((a, b) => a - b);
    const p10Pool = poolSorted[Math.floor(poolSorted.length * 0.1)];
    const p90Pool = poolSorted[Math.floor(poolSorted.length * 0.9)];
    const medPool = poolSorted[Math.floor(poolSorted.length * 0.5)];

    // Our selected lineups' ROIs
    const ourROIs: number[] = [];
    const ourRanks: number[] = [];
    for (const lu of result.portfolio) {
      const roi = roiByHash.get(hashLineup(lu));
      if (roi === undefined) continue;
      ourROIs.push(roi);
      ourRanks.push(percentileRank(roi, poolSorted));
    }
    if (ourROIs.length === 0) continue;

    const ourMed = pct(ourROIs, 0.5);
    const ourMedianRank = pct(ourRanks, 0.5);

    let aboveMed = 0, topDecile = 0, botDecile = 0;
    for (const roi of ourROIs) {
      if (roi > medPool) aboveMed++;
      if (roi >= p90Pool) topDecile++;
      if (roi <= p10Pool) botDecile++;
    }

    totalAbovePoolMedian += aboveMed;
    totalLineups += ourROIs.length;
    totalTopDecile += topDecile;
    totalBotDecile += botDecile;
    for (const r of ourRanks) rankShares.push(r);

    const distStr = `${p10Pool.toFixed(1)}/${medPool.toFixed(1)}/${p90Pool.toFixed(1)}/${poolSorted[poolSorted.length - 1].toFixed(1)}`;
    const abovePctStr = `${(aboveMed / ourROIs.length * 100).toFixed(0)}%`;
    console.log(`${s.slate.padEnd(10)} | ${roiByHash.size.toString().padStart(9)} | ${distStr.padEnd(36)} | ${ourMed.toFixed(2).padStart(14)} | ${(ourMedianRank * 100).toFixed(1).padStart(15)}% | ${topDecile.toString().padStart(12)} | ${botDecile.toString().padStart(12)} | ${abovePctStr.padStart(18)} |`);
  }

  console.log('\nCross-slate summary:');
  console.log(`  Our lineups scored: ${totalLineups}`);
  console.log(`  Overall median rank in pool: ${(pct(rankShares, 0.5) * 100).toFixed(1)}% (50% = pool median, higher = better-than-random)`);
  console.log(`  Our lineups above pool-median ROI: ${totalAbovePoolMedian} / ${totalLineups} = ${(totalAbovePoolMedian / totalLineups * 100).toFixed(1)}%`);
  console.log(`  Our lineups in pool top-10%: ${totalTopDecile} / ${totalLineups} = ${(totalTopDecile / totalLineups * 100).toFixed(1)}% (expected ~10% if random)`);
  console.log(`  Our lineups in pool bottom-10%: ${totalBotDecile} / ${totalLineups} = ${(totalBotDecile / totalLineups * 100).toFixed(1)}% (expected ~10% if random)`);
}

main().catch(e => { console.error(e); process.exit(1); });
