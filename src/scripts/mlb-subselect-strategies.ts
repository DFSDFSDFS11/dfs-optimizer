/**
 * MLB Sub-selection Strategies — which 5 lineups out of 150 do we actually submit?
 *
 * User's bleeding mechanism: SaberSim's sim-ROI sub-selection picks 36× worse than random
 * on recent slates. Find a better strategy.
 *
 * Strategies tested (all pick 5 from our 150):
 *   1. simROI top-5 (current workflow — the BAD baseline)
 *   2. Random 5 (expected value reference)
 *   3. Ceiling top-5 (highest p99 ceiling)
 *   4. Diversity greedy (maximize team/player diversity)
 *   5. 1-per-bin (1 chalk, 1 core, 1 value, 1 contra, 1 deep — bin spread)
 *   6. Max-projection top-5
 *   7. Variance top-5 (highest within-lineup stdev)
 *   8. Stack-team diversity (5 different primary stack teams)
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import { Lineup, Player } from '../types';
import {
  parseCSVFile,
  buildPlayerPool,
  parseContestActuals,
  loadPoolFromCSV,
  ContestActuals,
} from '../parser';
import { getContestConfig } from '../rules';
import { productionSelect } from '../selection/production-selector';
import { precomputeComboFrequencies } from '../selection/combo-leverage';

const DIR = 'C:/Users/colin/dfs opto';
const N = 150;
const K = 5;
const FEE = 20;
const ROI_COL = 'Large Slate | 10k-50k';

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

function norm(n: string): string {
  return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
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

function primaryStackTeam(lu: Lineup): string {
  const counts = new Map<string, number>();
  for (const p of lu.players) {
    if (!p.positions?.includes('P')) counts.set(p.team, (counts.get(p.team) || 0) + 1);
  }
  let best = '', max = 0;
  for (const [t, c] of counts) if (c > max) { max = c; best = t; }
  return best;
}

function lineupCeiling(lu: Lineup): number {
  let s = 0;
  for (const p of lu.players) {
    const pct = (p as any).percentiles;
    s += pct && pct['95'] ? pct['95'] : (p.projection * 1.2);
  }
  return s;
}

function lineupVariance(lu: Lineup): number {
  let s = 0;
  for (const p of lu.players) {
    const pct = (p as any).percentiles;
    const hi = pct && pct['95'] ? pct['95'] : p.projection * 1.2;
    const lo = pct && pct['25'] ? pct['25'] : p.projection * 0.8;
    s += (hi - lo);
  }
  return s;
}

function scoreLineup(lu: Lineup, actuals: ContestActuals, actualByHash: Map<string, number>): number | null {
  const h = lu.players.map(p => p.id).sort().join('|');
  const fa = actualByHash.get(h);
  if (fa !== undefined) return fa;
  let t = 0;
  for (const p of lu.players) {
    const r = actuals.playerActualsByName.get(norm(p.name));
    if (!r) return null;
    t += r.fpts;
  }
  return t;
}

function payoutFor(actual: number, sortedScores: number[], payoutTable: Float64Array, actuals: ContestActuals): number {
  let lo = 0, hi = sortedScores.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (sortedScores[m] >= actual) lo = m + 1; else hi = m; }
  const rank = Math.max(1, lo);
  const pay = rank <= payoutTable.length ? payoutTable[rank - 1] : 0;
  if (pay <= 0) return 0;
  let co = 0;
  for (const e of actuals.entries) if (Math.abs(e.actualPoints - actual) <= 0.25) co++;
  co = Math.max(0, co - 1);
  return pay / Math.sqrt(1 + co * 0.5);
}

// ============================================================
// SUB-SELECTION STRATEGIES
// ============================================================

type Strategy = {
  name: string;
  select: (portfolio: Lineup[], ctx: { simROI: Map<string, number>; anchorOwn: number }) => Lineup[];
};

function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STRATEGIES: Strategy[] = [
  {
    name: 'simROI-top5 (current)',
    select: (portfolio, ctx) => {
      return [...portfolio].sort((a, b) => {
        const ra = ctx.simROI.get(a.players.map(p => p.id).sort().join('|')) ?? -Infinity;
        const rb = ctx.simROI.get(b.players.map(p => p.id).sort().join('|')) ?? -Infinity;
        return rb - ra;
      }).slice(0, K);
    },
  },
  {
    name: 'random-5 (seed=42)',
    select: (portfolio) => {
      const rng = seededRandom(42);
      const arr = [...portfolio];
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr.slice(0, K);
    },
  },
  {
    name: 'ceiling-top5',
    select: (portfolio) => [...portfolio].sort((a, b) => lineupCeiling(b) - lineupCeiling(a)).slice(0, K),
  },
  {
    name: 'projection-top5',
    select: (portfolio) => [...portfolio].sort((a, b) => b.projection - a.projection).slice(0, K),
  },
  {
    name: 'variance-top5',
    select: (portfolio) => [...portfolio].sort((a, b) => lineupVariance(b) - lineupVariance(a)).slice(0, K),
  },
  {
    name: 'stack-team-diverse5',
    select: (portfolio) => {
      const byTeam = new Map<string, Lineup[]>();
      for (const lu of portfolio) {
        const t = primaryStackTeam(lu);
        if (!byTeam.has(t)) byTeam.set(t, []);
        byTeam.get(t)!.push(lu);
      }
      // sort each team bucket by ceiling, then take 1 from top-5 teams
      const teamOrder = [...byTeam.entries()]
        .map(([t, lus]) => ({ t, best: lus.sort((a, b) => lineupCeiling(b) - lineupCeiling(a))[0], avgCeiling: lus.reduce((s, x) => s + lineupCeiling(x), 0) / lus.length }))
        .sort((a, b) => lineupCeiling(b.best) - lineupCeiling(a.best))
        .slice(0, K);
      return teamOrder.map(x => x.best);
    },
  },
  {
    name: 'diversity-greedy (min-overlap)',
    select: (portfolio) => {
      const sorted = [...portfolio].sort((a, b) => lineupCeiling(b) - lineupCeiling(a));
      const selected: Lineup[] = [sorted[0]];
      while (selected.length < K && selected.length < sorted.length) {
        let bestCand = -1, bestScore = -Infinity;
        for (let i = 1; i < sorted.length; i++) {
          if (selected.includes(sorted[i])) continue;
          const pidSet = new Set(sorted[i].players.map(p => p.id));
          let maxOverlap = 0;
          for (const s of selected) {
            let ov = 0;
            for (const p of s.players) if (pidSet.has(p.id)) ov++;
            if (ov > maxOverlap) maxOverlap = ov;
          }
          const score = lineupCeiling(sorted[i]) - maxOverlap * 3; // penalty per overlap
          if (score > bestScore) { bestScore = score; bestCand = i; }
        }
        if (bestCand >= 0) selected.push(sorted[bestCand]);
        else break;
      }
      return selected;
    },
  },
  {
    name: 'low-own-top5',
    select: (portfolio) => [...portfolio].sort((a, b) => {
      const oa = a.players.reduce((s, p) => s + (p.ownership || 0), 0) / a.players.length;
      const ob = b.players.reduce((s, p) => s + (p.ownership || 0), 0) / b.players.length;
      return oa - ob;
    }).slice(0, K),
  },
  {
    name: 'rel-value-top5',
    select: (portfolio) => [...portfolio].sort((a, b) => {
      const oa = a.players.reduce((s, p) => s + (p.ownership || 0), 0) / a.players.length;
      const ob = b.players.reduce((s, p) => s + (p.ownership || 0), 0) / b.players.length;
      // Relative value = projection / ownership  (higher is better)
      const rva = a.projection / Math.max(1, oa);
      const rvb = b.projection / Math.max(1, ob);
      return rvb - rva;
    }).slice(0, K),
  },
];

async function main() {
  console.log('================================================================');
  console.log(`MLB SUB-SELECTION STRATEGY TEST — picking 5 out of 150`);
  console.log('================================================================\n');

  const strategyTotals = new Map<string, { total: number; recent: number; t1: number; recentT1: number; hits: Map<string, number> }>();
  for (const st of STRATEGIES) {
    strategyTotals.set(st.name, { total: 0, recent: 0, t1: 0, recentT1: 0, hits: new Map() });
  }

  const LAMBDA_CONFIGS = [
    { name: 'prod-shipped', lambda: 0.05 },
    { name: 'prod-λ0.20',    lambda: 0.20 },
  ];

  for (const cfg of LAMBDA_CONFIGS) {
    console.log(`\n\n===== Base selector: ${cfg.name} (λ=${cfg.lambda}) =====\n`);
    const perSlate: { slate: string; full150Pay: number; strategies: Map<string, { pay: number; t1: number }> }[] = [];

    for (const s of SLATES) {
      const projPath = path.join(DIR, s.proj);
      const actualsPath = path.join(DIR, s.actuals);
      const poolPath = path.join(DIR, s.pool);
      if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) continue;
      try {
        const pr = parseCSVFile(projPath, 'mlb', true);
        const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
        const pool = buildPlayerPool(pr.players, pr.detectedContestType);
        const actuals = parseContestActuals(actualsPath, config);
        const idMap = new Map<string, Player>();
        const nameMap = new Map<string, Player>();
        for (const p of pool.players) { idMap.set(p.id, p); nameMap.set(norm(p.name), p); }
        const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
        const comboFreq = precomputeComboFrequencies(loaded.lineups, 3);
        const F = actuals.entries.length;
        const sorted = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
        const payoutTable = buildPayoutTable(F);
        const top1Thresh = sorted[Math.max(0, Math.floor(F * 0.01) - 1)] || 0;
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

        const simROI = parsePoolROI(poolPath, config.rosterSize, ROI_COL);
        const result = productionSelect(loaded.lineups, pool.players, {
          N, lambda: cfg.lambda, comboFreq, maxOverlap: 7,
        });
        const portfolio = result.portfolio;
        const anchorOwn = result.anchor.ownership;

        // Full 150 payout
        let full150 = 0;
        for (const lu of portfolio) {
          const a = scoreLineup(lu, actuals, actualByHash);
          if (a === null) continue;
          full150 += payoutFor(a, sorted, payoutTable, actuals);
        }

        const stratResults = new Map<string, { pay: number; t1: number }>();
        for (const st of STRATEGIES) {
          const sel = st.select(portfolio, { simROI, anchorOwn });
          let pay = 0, t1 = 0;
          for (const lu of sel) {
            const a = scoreLineup(lu, actuals, actualByHash);
            if (a === null) continue;
            pay += payoutFor(a, sorted, payoutTable, actuals);
            if (a >= top1Thresh) t1++;
          }
          stratResults.set(st.name, { pay, t1 });
          const tot = strategyTotals.get(st.name)!;
          // Only accumulate under the active config name to keep totals separate
          const key = `${cfg.name}:${st.name}`;
          if (!tot.hits.has(key)) tot.hits.set(key, 0);
          tot.hits.set(key, (tot.hits.get(key) || 0) + pay);
        }

        perSlate.push({ slate: s.slate, full150Pay: full150, strategies: stratResults });
      } catch (e: any) {
        console.log(`  ${s.slate}: ERROR ${e.message}`);
      }
    }

    // Per-strategy totals across all slates
    console.log('Strategy                         | Total     | Mean/slate | Recent 5  | ROI   | Top-1%');
    console.log('-'.repeat(95));

    const byStrategy: { name: string; total: number; recent: number; t1: number; slates: number; recentSlates: number; recentT1: number }[] = [];
    for (const st of STRATEGIES) {
      let total = 0, recent = 0, t1 = 0, slates = 0, recentSlates = 0, recentT1 = 0;
      for (const p of perSlate) {
        const r = p.strategies.get(st.name);
        if (!r) continue;
        total += r.pay; t1 += r.t1; slates++;
        if (RECENT.has(p.slate)) { recent += r.pay; recentT1 += r.t1; recentSlates++; }
      }
      byStrategy.push({ name: st.name, total, recent, t1, slates, recentSlates, recentT1 });
    }
    byStrategy.sort((a, b) => b.total - a.total);
    for (const b of byStrategy) {
      const cost = FEE * K * b.slates;
      const roi = cost > 0 ? ((b.total / cost - 1) * 100).toFixed(0) + '%' : '—';
      console.log(`  ${b.name.padEnd(30)} | $${b.total.toFixed(0).padStart(7)} | $${(b.total / Math.max(1, b.slates)).toFixed(0).padStart(9)} | $${b.recent.toFixed(0).padStart(7)} | ${roi.padStart(5)} | ${b.t1}`);
    }

    // Per-slate breakdown for top 3 strategies
    console.log('\nPer-slate payouts (top 4 strategies + simROI baseline):');
    const top3 = byStrategy.slice(0, 4);
    const simROIentry = byStrategy.find(b => b.name === 'simROI-top5 (current)');
    const showStrats = [...top3];
    if (simROIentry && !top3.some(t => t.name === simROIentry.name)) showStrats.push(simROIentry);
    console.log('Slate      | 150   | ' + showStrats.map(s => s.name.slice(0, 16).padEnd(16)).join(' | '));
    console.log('-'.repeat(100));
    for (const p of perSlate) {
      const recentMark = RECENT.has(p.slate) ? '*' : ' ';
      let row = `${p.slate}${recentMark} | $${p.full150Pay.toFixed(0).padStart(5)}`;
      for (const s of showStrats) {
        const r = p.strategies.get(s.name);
        row += ` | $${(r?.pay || 0).toFixed(0).padStart(14)}`;
      }
      console.log(row);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
