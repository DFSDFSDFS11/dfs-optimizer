/**
 * Config B (λ=0.20 + extremeCornerCap) — cash rate across 11 MLB slates.
 *
 * Cash = lineup ranks in top 22% of field (actual DK cash line).
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

const DIR = 'C:/Users/colin/dfs opto';
const N = 150;
const FEE = 20;

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

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }

function scoreLineup(lu: Lineup, actuals: ContestActuals, actualByHash: Map<string, number>): number | null {
  const h = lu.players.map(p => p.id).sort().join('|');
  const fa = actualByHash.get(h);
  if (fa !== undefined) return fa;
  let t = 0;
  for (const p of lu.players) { const r = actuals.playerActualsByName.get(norm(p.name)); if (!r) return null; t += r.fpts; }
  return t;
}

async function main() {
  console.log('Config B cash rate across 11 MLB slates\n');
  console.log('Config: λ=0.20, extremeCornerCap=true, γ=7, default bins\n');

  let totalLineups = 0, totalCash = 0, totalT10 = 0, totalT5 = 0, totalT1 = 0, totalT01 = 0;
  let totalRecentLineups = 0, totalRecentCash = 0, totalRecentT1 = 0;

  console.log('Slate      | Field  | Cash%  | Top-10% | Top-5% | Top-1% | Top-0.1% | Cash line | Portfolio hits cash line');
  console.log('-'.repeat(120));

  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj); const actualsPath = path.join(DIR, s.actuals); const poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) continue;
    try {
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
      // Cash line = 22% of field (standard DK GPP)
      const cashLineRank = Math.floor(F * 0.22);
      const cashThresh = sorted[cashLineRank - 1] || 0;
      const t10Thresh = sorted[Math.max(0, Math.floor(F * 0.10) - 1)] || 0;
      const t5Thresh = sorted[Math.max(0, Math.floor(F * 0.05) - 1)] || 0;
      const t1Thresh = sorted[Math.max(0, Math.floor(F * 0.01) - 1)] || 0;
      const t01Thresh = sorted[Math.max(0, Math.floor(F * 0.001) - 1)] || 0;

      const actualByHash = new Map<string, number>();
      for (const e of actuals.entries) {
        const pls: Player[] = []; let ok = true;
        for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
        if (!ok) continue;
        actualByHash.set(pls.map(p => p.id).sort().join('|'), e.actualPoints);
      }

      const result = productionSelect(loaded.lineups, pool.players, {
        N, lambda: 0.20, comboFreq, maxOverlap: 7, extremeCornerCap: true,
      });

      let cash = 0, t10 = 0, t5 = 0, t1 = 0, t01 = 0, scored = 0;
      for (const lu of result.portfolio) {
        const a = scoreLineup(lu, actuals, actualByHash);
        if (a === null) continue;
        scored++;
        if (a >= cashThresh) cash++;
        if (a >= t10Thresh) t10++;
        if (a >= t5Thresh) t5++;
        if (a >= t1Thresh) t1++;
        if (a >= t01Thresh) t01++;
      }
      const cashPct = (cash / scored * 100).toFixed(1);
      const t10Pct = (t10 / scored * 100).toFixed(1);
      const t5Pct = (t5 / scored * 100).toFixed(1);
      const t1Pct = (t1 / scored * 100).toFixed(1);
      const t01Pct = (t01 / scored * 100).toFixed(1);
      console.log(`${s.slate.padEnd(10)} | ${F.toString().padStart(6)} | ${cashPct.padStart(4)}% | ${t10Pct.padStart(5)}% | ${t5Pct.padStart(4)}% | ${t1Pct.padStart(4)}% | ${t01Pct.padStart(6)}% | ${cashThresh.toFixed(1).padStart(8)} | ${cash}/${scored}`);

      totalLineups += scored; totalCash += cash; totalT10 += t10; totalT5 += t5; totalT1 += t1; totalT01 += t01;
      if (RECENT.has(s.slate)) { totalRecentLineups += scored; totalRecentCash += cash; totalRecentT1 += t1; }
    } catch (e: any) { console.log(`  ${s.slate}: ERROR ${e.message}`); }
  }

  console.log('-'.repeat(120));
  console.log(`\nAGGREGATE (all 11 slates):`);
  console.log(`  Total lineups scored: ${totalLineups}`);
  console.log(`  Cash (top 22%):    ${totalCash} (${(totalCash / totalLineups * 100).toFixed(1)}%)  — field-wide baseline is 22%`);
  console.log(`  Top-10%:           ${totalT10} (${(totalT10 / totalLineups * 100).toFixed(1)}%)`);
  console.log(`  Top-5%:            ${totalT5} (${(totalT5 / totalLineups * 100).toFixed(1)}%)`);
  console.log(`  Top-1%:            ${totalT1} (${(totalT1 / totalLineups * 100).toFixed(1)}%)  — field baseline is 1%`);
  console.log(`  Top-0.1%:          ${totalT01} (${(totalT01 / totalLineups * 100).toFixed(1)}%)  — field baseline is 0.1%`);
  console.log(`\nRECENT 5 SLATES:`);
  console.log(`  Lineups scored: ${totalRecentLineups}`);
  console.log(`  Cash:           ${totalRecentCash} (${(totalRecentCash / totalRecentLineups * 100).toFixed(1)}%)`);
  console.log(`  Top-1%:         ${totalRecentT1} (${(totalRecentT1 / totalRecentLineups * 100).toFixed(1)}%)`);
  console.log(`\nROI math: GPP payouts are right-tail-heavy — cash % alone doesn't predict ROI.`);
  console.log(`  Config B's +65% full-sample ROI comes from top-1% hits paying big, not high cash rate.`);
}

main().catch(e => { console.error(e); process.exit(1); });
