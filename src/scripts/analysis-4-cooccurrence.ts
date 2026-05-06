/**
 * Analysis 4 — Player co-occurrence patterns within pro vs Hermes lineups.
 *
 * For each lineup we observe co-occurrence of player pairs.
 * For each pro / Hermes-A: count pairs across all lineups in all slates.
 * Identify pairs pros use frequently that Hermes doesn't (or vice versa).
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
  { slate: '4-23-26', proj: '4-23-26projections.csv', actuals: '4-23-26actuals.csv',   pool: '4-23-26sspool.csv' },
  { slate: '4-24-26', proj: '4-24-26projections.csv', actuals: '4-24-26actuals.csv',   pool: '4-24-26sspool.csv' },
  { slate: '4-25-26', proj: '4-25-26projections.csv', actuals: '4-25-26actuals.csv',   pool: '4-25-26sspool.csv' },
  { slate: '4-25-26-early', proj: '4-25-26projectionsearly.csv', actuals: '4-25-26actualsearly.csv', pool: '4-25-26sspoolearly.csv' },
  { slate: '4-26-26', proj: '4-26-26projections.csv', actuals: '4-26-26actuals.csv',   pool: '4-26-26sspool.csv' },
  { slate: '4-27-26', proj: '4-27-26projections.csv', actuals: '4-27-26actuals.csv',   pool: '4-27-26sspool.csv' },
  { slate: '4-28-26', proj: '4-28-26projections.csv', actuals: '4-28-26actuals.csv',   pool: '4-28-26sspool.csv' },
];

const PROS = [
  { label: 'nerdytenor', tokens: ['nerdytenor'] },
  { label: 'zroth', tokens: ['zroth', 'zroth2'] },
  { label: 'youdacao', tokens: ['youdacao'] },
  { label: 'shipmymoney', tokens: ['shipmymoney'] },
  { label: 'shaidyadvice', tokens: ['shaidyadvice'] },
  { label: 'bgreseth', tokens: ['bgreseth'] },
  { label: 'needlunchmoney', tokens: ['needlunchmoney'] },
];

const HERMES_A = {
  lambda: 0.58, gamma: 5, tc: 0.26, mps: 4, me: 0.21, mep: 0.41, corner: true,
  comboPower: 4, fl: 0.00,
  bins: { chalk: 0.50, core: 0.30, value: 0.20, contra: 0.00, deep: 0.00 },
};

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function mean(a: number[]): number { if (!a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; }

function extractPro(actuals: ContestActuals, nameMap: Map<string, Player>, tokens: string[]): Player[][] {
  const out: Player[][] = [];
  for (const e of actuals.entries) {
    const en = (e.entryName || '').toLowerCase();
    if (!tokens.some(t => en.includes(t))) continue;
    const pls: Player[] = []; let ok = true;
    for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
    if (ok) out.push(pls);
  }
  return out;
}

function pairKey(a: string, b: string): string { return a < b ? a + '|' + b : b + '|' + a; }

async function main() {
  console.log('=== ANALYSIS 4: Player co-occurrence patterns ===\n');

  // Per-slate pair counts
  const proPairsAggSlate: Map<string, Map<string, number>> = new Map();   // slate -> pair -> rate (% of pro lineups)
  const hermesPairsAggSlate: Map<string, Map<string, number>> = new Map();
  const playerNameById: Map<string, string> = new Map();

  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj), actualsPath = path.join(DIR, s.actuals), poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) continue;
    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);
    const idMap = new Map<string, Player>(); const nameMap = new Map<string, Player>();
    for (const p of pool.players) { idMap.set(p.id, p); nameMap.set(norm(p.name), p); playerNameById.set(p.id, p.name); }
    const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });

    const allPro: Player[][] = [];
    for (const p of PROS) allPro.push(...extractPro(actuals, nameMap, p.tokens));
    if (allPro.length < 100) continue;

    // Key by player NAME (cross-slate stable) instead of player ID (slate-specific).
    const proPairCounts = new Map<string, number>();
    for (const lu of allPro) {
      const names = lu.map(p => norm(p.name));
      for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
        const k = pairKey(names[i], names[j]);
        proPairCounts.set(k, (proPairCounts.get(k) || 0) + 1);
      }
    }
    const proRates = new Map<string, number>();
    for (const [k, c] of proPairCounts) proRates.set(k, c / allPro.length * 100);
    proPairsAggSlate.set(s.slate, proRates);

    // Hermes
    const comboFreq = precomputeComboFrequencies(loaded.lineups, HERMES_A.comboPower);
    const result = productionSelect(loaded.lineups, pool.players, {
      N, lambda: HERMES_A.lambda, comboFreq, maxOverlap: HERMES_A.gamma,
      teamCapPct: HERMES_A.tc, minPrimaryStack: HERMES_A.mps,
      maxExposure: HERMES_A.me, maxExposurePitcher: HERMES_A.mep,
      extremeCornerCap: HERMES_A.corner, projectionFloorPct: HERMES_A.fl,
      binAllocation: HERMES_A.bins,
    });
    const hPairCounts = new Map<string, number>();
    for (const lu of result.portfolio) {
      const names = lu.players.map(p => norm(p.name));
      for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
        const k = pairKey(names[i], names[j]);
        hPairCounts.set(k, (hPairCounts.get(k) || 0) + 1);
      }
    }
    const hRates = new Map<string, number>();
    for (const [k, c] of hPairCounts) hRates.set(k, c / result.portfolio.length * 100);
    hermesPairsAggSlate.set(s.slate, hRates);
    // Track player names by their stable key
    for (const p of pool.players) playerNameById.set(norm(p.name), p.name);
  }

  // Aggregate: across slates, find pairs pros use frequently
  // For each pair (id1, id2), find slates where pair was used by both pros AND Hermes — track pro_rate vs hermes_rate
  const allPairs = new Map<string, { proSum: number; hSum: number; count: number; firstName: string; secondName: string }>();
  for (const [slate, proRates] of proPairsAggSlate) {
    const hRates = hermesPairsAggSlate.get(slate); if (!hRates) continue;
    for (const [k, pRate] of proRates) {
      const [n1k, n2k] = k.split('|');
      const n1 = playerNameById.get(n1k) || n1k;
      const n2 = playerNameById.get(n2k) || n2k;
      if (!allPairs.has(k)) allPairs.set(k, { proSum: 0, hSum: 0, count: 0, firstName: n1, secondName: n2 });
      const agg = allPairs.get(k)!;
      agg.proSum += pRate;
      agg.hSum += (hRates.get(k) || 0);
      agg.count++;
    }
  }

  // Compute avg rates, then find top divergences
  const results = [...allPairs.entries()].map(([k, a]) => ({
    pair: a.firstName + ' + ' + a.secondName,
    avgProRate: a.proSum / a.count,
    avgHRate: a.hSum / a.count,
    nSlates: a.count,
    delta: (a.proSum - a.hSum) / a.count,
  })).filter(r => r.nSlates >= 2 && r.avgProRate >= 5);

  // Pairs pros use that Hermes underuses
  console.log('=== TOP 25 PAIRS PROS USE THAT HERMES UNDER-USES ===\n');
  const proHeavy = [...results].sort((a, b) => b.delta - a.delta).slice(0, 25);
  console.log('pair                                                  slates  proRate%  hermesRate%  delta');
  for (const r of proHeavy) {
    console.log('  ' + r.pair.padEnd(50) + '  ' + r.nSlates.toString().padStart(4) + '   ' + r.avgProRate.toFixed(1).padStart(7) + '%  ' + r.avgHRate.toFixed(1).padStart(8) + '%   +' + r.delta.toFixed(1));
  }

  // Pairs Hermes uses that pros don't
  console.log('\n=== TOP 15 PAIRS HERMES OVER-USES VS PROS ===\n');
  const hermesHeavy = [...results].filter(r => r.avgHRate >= 5).sort((a, b) => a.delta - b.delta).slice(0, 15);
  for (const r of hermesHeavy) {
    console.log('  ' + r.pair.padEnd(50) + '  ' + r.nSlates.toString().padStart(4) + '   ' + r.avgProRate.toFixed(1).padStart(7) + '%  ' + r.avgHRate.toFixed(1).padStart(8) + '%   ' + r.delta.toFixed(1));
  }

  console.log('\n=== AGGREGATE STATS ===');
  console.log('  Total pairs analyzed: ' + results.length);
  console.log('  Pairs pros use ≥10% (across slates): ' + results.filter(r => r.avgProRate >= 10).length);
  console.log('  Pairs Hermes matches within 3pp: ' + results.filter(r => Math.abs(r.delta) <= 3).length);
  console.log('  Pairs Hermes under-uses by ≥10pp: ' + results.filter(r => r.delta >= 10).length);
  console.log('  Pairs Hermes over-uses by ≥10pp: ' + results.filter(r => r.delta <= -10).length);
}

main().catch(e => { console.error(e); process.exit(1); });
