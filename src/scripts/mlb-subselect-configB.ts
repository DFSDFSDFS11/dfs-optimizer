/**
 * Test 5-of-150 sub-selection strategies on Config B's portfolios (λ=0.20 + corner).
 * Focus on RECENT 5 slates — where user is bleeding.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import { Lineup, Player } from '../types';
import {
  parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals,
} from '../parser';
import { getContestConfig } from '../rules';
import { productionSelect } from '../selection/production-selector';
import { precomputeComboFrequencies } from '../selection/combo-leverage';

const DIR = 'C:/Users/colin/dfs opto';
const N = 150; const K = 5; const FEE = 20;
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

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
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
function parsePoolROI(filePath: string, rosterSize: number, roiCol: string): Map<string, number> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const records: string[][] = parse(content, { columns: false, skip_empty_lines: true, relax_column_count: true, trim: true });
  if (records.length < 2) return new Map();
  const headers = records[0];
  const roiIdx = headers.findIndex(h => h.trim() === roiCol);
  if (roiIdx === -1) return new Map();
  const hashMap = new Map<string, number>();
  for (let r = 1; r < records.length; r++) {
    const row = records[r]; const ids: string[] = [];
    for (let i = 0; i < rosterSize; i++) if (row[i]) ids.push(row[i]);
    if (ids.length !== rosterSize) continue;
    const hash = [...ids].sort().join('|');
    const v = parseFloat(row[roiIdx]); if (!isNaN(v)) hashMap.set(hash, v);
  }
  return hashMap;
}
function primaryStackTeam(lu: Lineup): string {
  const counts = new Map<string, number>();
  for (const p of lu.players) if (!p.positions?.includes('P')) counts.set(p.team, (counts.get(p.team) || 0) + 1);
  let best = '', max = 0; for (const [t, c] of counts) if (c > max) { max = c; best = t; }
  return best;
}
function lineupCeiling(lu: Lineup): number {
  let s = 0;
  for (const p of lu.players) { const pct = (p as any).percentiles; s += pct && pct['95'] ? pct['95'] : (p.projection * 1.2); }
  return s;
}
function scoreLineup(lu: Lineup, actuals: ContestActuals, actualByHash: Map<string, number>): number | null {
  const h = lu.players.map(p => p.id).sort().join('|'); const fa = actualByHash.get(h);
  if (fa !== undefined) return fa;
  let t = 0; for (const p of lu.players) { const r = actuals.playerActualsByName.get(norm(p.name)); if (!r) return null; t += r.fpts; }
  return t;
}
function payoutFor(actual: number, sortedScores: number[], payoutTable: Float64Array, actuals: ContestActuals): number {
  let lo = 0, hi = sortedScores.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (sortedScores[m] >= actual) lo = m + 1; else hi = m; }
  const rank = Math.max(1, lo);
  const pay = rank <= payoutTable.length ? payoutTable[rank - 1] : 0;
  if (pay <= 0) return 0;
  let co = 0; for (const e of actuals.entries) if (Math.abs(e.actualPoints - actual) <= 0.25) co++;
  co = Math.max(0, co - 1);
  return pay / Math.sqrt(1 + co * 0.5);
}

function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

interface Strategy { name: string; select: (portfolio: Lineup[], simROI: Map<string, number>, anchorOwn: number) => Lineup[] }

const STRATEGIES: Strategy[] = [
  { name: 'simROI-top5', select: (pf, roi) => [...pf].sort((a, b) => (roi.get(b.players.map(p => p.id).sort().join('|')) ?? -Infinity) - (roi.get(a.players.map(p => p.id).sort().join('|')) ?? -Infinity)).slice(0, K) },
  { name: 'random-5(seed=42)', select: (pf) => { const rng = seededRandom(42); const arr = [...pf]; for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr.slice(0, K); } },
  { name: 'random-5(seed=1)', select: (pf) => { const rng = seededRandom(1); const arr = [...pf]; for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr.slice(0, K); } },
  { name: 'random-5(seed=7)', select: (pf) => { const rng = seededRandom(7); const arr = [...pf]; for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr.slice(0, K); } },
  { name: 'ceiling-top5', select: (pf) => [...pf].sort((a, b) => lineupCeiling(b) - lineupCeiling(a)).slice(0, K) },
  { name: 'projection-top5', select: (pf) => [...pf].sort((a, b) => b.projection - a.projection).slice(0, K) },
  { name: 'stack-team-diverse5', select: (pf) => {
    const byTeam = new Map<string, Lineup[]>();
    for (const lu of pf) { const t = primaryStackTeam(lu); if (!byTeam.has(t)) byTeam.set(t, []); byTeam.get(t)!.push(lu); }
    const teamOrder = [...byTeam.entries()]
      .map(([t, lus]) => ({ t, best: lus.sort((a, b) => lineupCeiling(b) - lineupCeiling(a))[0] }))
      .sort((a, b) => lineupCeiling(b.best) - lineupCeiling(a.best)).slice(0, K);
    return teamOrder.map(x => x.best);
  }},
  { name: 'max-dispersion-ceiling-greedy', select: (pf) => {
    const sorted = [...pf].sort((a, b) => lineupCeiling(b) - lineupCeiling(a));
    const selected = [sorted[0]];
    while (selected.length < K && selected.length < sorted.length) {
      let bestIdx = -1, bestScore = -Infinity;
      for (let i = 1; i < sorted.length; i++) {
        if (selected.includes(sorted[i])) continue;
        const pidSet = new Set(sorted[i].players.map(p => p.id));
        let maxOv = 0;
        for (const s of selected) { let ov = 0; for (const p of s.players) if (pidSet.has(p.id)) ov++; if (ov > maxOv) maxOv = ov; }
        const score = lineupCeiling(sorted[i]) - maxOv * 5;   // tunable penalty per overlap
        if (score > bestScore) { bestScore = score; bestIdx = i; }
      }
      if (bestIdx >= 0) selected.push(sorted[bestIdx]); else break;
    }
    return selected;
  }},
  { name: '1-per-bin-by-ceiling', select: (pf, _roi, anchorOwn) => {
    // 1 chalk (own > anchor-2), 1 core (anchor-5..-2), 1 value (-8..-5), 1 contra (-12..-8), 1 deep (<-12)
    const bins: Lineup[][] = [[], [], [], [], []];
    for (const lu of pf) {
      const own = lu.players.reduce((s, p) => s + (p.ownership || 0), 0) / lu.players.length;
      const d = own - anchorOwn;
      if (d >= -2) bins[0].push(lu);
      else if (d >= -5) bins[1].push(lu);
      else if (d >= -8) bins[2].push(lu);
      else if (d >= -12) bins[3].push(lu);
      else bins[4].push(lu);
    }
    for (const b of bins) b.sort((a, b) => lineupCeiling(b) - lineupCeiling(a));
    const picks: Lineup[] = [];
    for (const b of bins) if (b.length > 0) picks.push(b[0]);
    // If bins are empty, fill from highest-ceiling remainders
    if (picks.length < K) {
      const remaining = pf.filter(lu => !picks.includes(lu)).sort((a, b) => lineupCeiling(b) - lineupCeiling(a));
      while (picks.length < K && remaining.length > 0) picks.push(remaining.shift()!);
    }
    return picks.slice(0, K);
  }},
];

async function main() {
  console.log('================================================================');
  console.log(`MLB Sub-selection — 5 of 150 from Config B (λ=0.20 + corner)`);
  console.log('================================================================\n');

  interface Row { strat: string; slate: string; pay: number; t1: number }
  const rows: Row[] = [];

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
      const payoutTable = buildPayoutTable(F);
      const top1Thresh = sorted[Math.max(0, Math.floor(F * 0.01) - 1)] || 0;
      const actualByHash = new Map<string, number>();
      for (const e of actuals.entries) {
        const pls: Player[] = []; let ok = true;
        for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
        if (!ok) continue;
        actualByHash.set(pls.map(p => p.id).sort().join('|'), e.actualPoints);
      }
      const simROI = parsePoolROI(poolPath, config.rosterSize, ROI_COL);

      // Config B portfolio
      const result = productionSelect(loaded.lineups, pool.players, { N, lambda: 0.20, comboFreq, maxOverlap: 7, extremeCornerCap: true });
      const portfolio = result.portfolio;
      const anchorOwn = result.anchor.ownership;

      for (const st of STRATEGIES) {
        const sel = st.select(portfolio, simROI, anchorOwn);
        let pay = 0, t1 = 0;
        for (const lu of sel) {
          const a = scoreLineup(lu, actuals, actualByHash);
          if (a === null) continue;
          pay += payoutFor(a, sorted, payoutTable, actuals);
          if (a >= top1Thresh) t1++;
        }
        rows.push({ strat: st.name, slate: s.slate, pay, t1 });
      }
    } catch (e: any) { console.log(`  ${s.slate}: ERROR ${e.message}`); }
  }

  // Aggregate
  interface Summary { strat: string; full: number; recent: number; nonRecent: number; t1: number; recentT1: number; slates: number; recentSlates: number }
  const summaries: Summary[] = [];
  for (const st of STRATEGIES) {
    const r = rows.filter(x => x.strat === st.name);
    let full = 0, recent = 0, nonRecent = 0, t1 = 0, recentT1 = 0, slates = 0, recentSlates = 0;
    for (const x of r) {
      full += x.pay; t1 += x.t1; slates++;
      if (RECENT.has(x.slate)) { recent += x.pay; recentT1 += x.t1; recentSlates++; }
      else nonRecent += x.pay;
    }
    summaries.push({ strat: st.name, full, recent, nonRecent, t1, recentT1, slates, recentSlates });
  }

  console.log('=== Full-sample ===\n');
  console.log('Strategy                        | Total    | Mean/5  | Cost    | ROI      | Top-1%');
  console.log('-'.repeat(95));
  const bySum = [...summaries].sort((a, b) => b.full - a.full);
  for (const s of bySum) {
    const cost = FEE * K * s.slates;
    const roi = cost ? ((s.full / cost - 1) * 100).toFixed(1) + '%' : '—';
    console.log(`  ${s.strat.padEnd(32)} | $${s.full.toFixed(0).padStart(6)} | $${(s.full / Math.max(1, s.slates)).toFixed(0).padStart(5)} | $${cost.toFixed(0).padStart(5)} | ${roi.padStart(7)} | ${s.t1}`);
  }

  console.log('\n=== Recent 5 slates ===\n');
  const byRecent = [...summaries].sort((a, b) => b.recent - a.recent);
  for (const s of byRecent) {
    const cost = FEE * K * s.recentSlates;
    const roi = cost ? ((s.recent / cost - 1) * 100).toFixed(1) + '%' : '—';
    console.log(`  ${s.strat.padEnd(32)} | $${s.recent.toFixed(0).padStart(6)} | mean $${(s.recent / Math.max(1, s.recentSlates)).toFixed(0).padStart(5)} | cost $${cost.toFixed(0).padStart(5)} | ROI ${roi.padStart(7)} | t1=${s.recentT1}`);
  }

  console.log('\n=== Non-recent 6 slates (stability check) ===\n');
  const byNR = [...summaries].sort((a, b) => b.nonRecent - a.nonRecent);
  for (const s of byNR) {
    const slatesCount = s.slates - s.recentSlates;
    const cost = FEE * K * slatesCount;
    const roi = cost ? ((s.nonRecent / cost - 1) * 100).toFixed(1) + '%' : '—';
    console.log(`  ${s.strat.padEnd(32)} | $${s.nonRecent.toFixed(0).padStart(6)} | mean $${(s.nonRecent / Math.max(1, slatesCount)).toFixed(0).padStart(5)} | ROI ${roi.padStart(7)}`);
  }

  // Per-slate for recent slates
  console.log('\n=== Per-slate RECENT payouts (ranked strategies) ===\n');
  const topStrats = byRecent.slice(0, 5).map(s => s.strat);
  let hdr = 'Slate     |';
  for (const st of topStrats) hdr += ` ${st.padEnd(22)} |`;
  console.log(hdr);
  console.log('-'.repeat(hdr.length));
  for (const slate of [...RECENT].sort()) {
    let line = `${slate} |`;
    for (const st of topStrats) {
      const r = rows.find(x => x.strat === st && x.slate === slate);
      line += ` $${(r?.pay || 0).toFixed(0).padStart(20)} |`;
    }
    console.log(line);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
