/**
 * NBA Megabin Transfer V2 — uses 5K candidates per slate sampled from the actuals
 * field (real contest entries) instead of the narrow 500-lineup _backtest_*.csv pools.
 *
 * Goal: address the data-quality issue from the 500-pool run where ALL configs
 * pulled from the same narrow set, causing single-slate lottery dominance.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import {
  parseCSVFile, buildPlayerPool, parseContestActuals, ContestActuals,
} from '../parser';
import { getContestConfig } from '../rules';
import { productionSelect } from '../selection/production-selector';
import { precomputeComboFrequencies } from '../selection/combo-leverage';
import { computeAnchor } from '../selection/anchor-relative';

const HIST_DIR = 'C:/Users/colin/Projects/dfs-optimizer/historical_slates';
const OUT_DIR = 'C:/Users/colin/dfs opto';
const IN_JSON = path.join(OUT_DIR, 'mlb_megabin3_sweep_v17.json');
const OUT_JSON = path.join(OUT_DIR, 'nba_megabin_5kpool.json');
const OUT_MD = path.join(OUT_DIR, 'nba_megabin_5kpool.md');
const FEE = 20;
const N = 150;
const TOP_K_CONFIGS = 10000;        // smaller subset given 10x slower per-config evaluation
const POOL_SAMPLE_SIZE = 5000;
const BUDGET_MS = 6 * 60 * 60 * 1000;

const NBA_SLATES = [
  { slate: '2026-01-16', proj: '2026-01-16_projections.csv', actuals: '2026-01-16_actuals.csv' },
  { slate: '2026-01-17', proj: '2026-01-17_projections.csv', actuals: '2026-01-17_actuals.csv' },
  { slate: '2026-01-18', proj: '2026-01-18_projections.csv', actuals: '2026-01-18_actuals.csv' },
  { slate: '2026-01-19', proj: '2026-01-19_projections.csv', actuals: '2026-01-19_actuals.csv' },
  { slate: '2026-01-20', proj: '2026-01-20_projections.csv', actuals: '2026-01-20_actuals.csv' },
  { slate: '2026-02-25', proj: '2026-02-25_projections.csv', actuals: '2026-02-25_actuals.csv' },
  { slate: '2026-02-26', proj: '2026-02-26_projections.csv', actuals: '2026-02-26_actuals.csv' },
  { slate: '2026-02-27', proj: '2026-02-27_projections.csv', actuals: '2026-02-27_actuals.csv' },
  { slate: '2026-02-28', proj: '2026-02-28_projections.csv', actuals: '2026-02-28_actuals.csv' },
  { slate: '2026-03-03', proj: '2026-03-03_projections.csv', actuals: '2026-03-03_actuals.csv' },
  { slate: '2026-03-05', proj: '2026-03-05_dk_projections.csv', actuals: '2026-03-05_dk_actuals.csv' },
  { slate: '2026-03-06', proj: '2026-03-06_dk_projections.csv', actuals: '2026-03-06_dk_actuals.csv' },
];

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
function scoreLineup(lu: Lineup, actualByHash: Map<string, number>): number | null {
  const h = lu.players.map(p => p.id).sort().join('|');
  const fa = actualByHash.get(h);
  return fa !== undefined ? fa : null;
}
function payoutFor(actual: number, sorted: number[], payoutTable: Float64Array, actuals: ContestActuals): number {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (sorted[m] >= actual) lo = m + 1; else hi = m; }
  const rank = Math.max(1, lo);
  const pay = rank <= payoutTable.length ? payoutTable[rank - 1] : 0;
  if (pay <= 0) return 0;
  let co = 0; for (const e of actuals.entries) if (Math.abs(e.actualPoints - actual) <= 0.25) co++;
  co = Math.max(0, co - 1);
  return pay / Math.sqrt(1 + co * 0.5);
}
function rankOf(actual: number, sortedDesc: number[]): number {
  let lo = 0, hi = sortedDesc.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (sortedDesc[m] >= actual) lo = m + 1; else hi = m; }
  return Math.max(1, lo);
}

interface SlateData {
  slate: string;
  candidates: Lineup[];
  players: Player[];
  comboFreq: Map<string, number>;
  comboFreq1: Map<string, number>;
  comboFreq2: Map<string, number>;
  comboFreq4: Map<string, number>;
  actuals: ContestActuals;
  actualByHash: Map<string, number>;
  sorted: number[];
  top1Thresh: number;
  cashThresh: number;
  payoutTable: Float64Array;
  F: number;
  anchor: ReturnType<typeof computeAnchor>;
}

async function loadSlateWithActualsPool(s: typeof NBA_SLATES[0]): Promise<SlateData | null> {
  const projPath = path.join(HIST_DIR, s.proj);
  const actualsPath = path.join(HIST_DIR, s.actuals);
  if (![projPath, actualsPath].every(p => fs.existsSync(p))) return null;
  const pr = parseCSVFile(projPath, 'nba', true);
  const config = getContestConfig('dk', 'nba', pr.detectedContestType);
  const pool = buildPlayerPool(pr.players, pr.detectedContestType);
  const actuals = parseContestActuals(actualsPath, config);
  const idMap = new Map<string, Player>();
  const nameMap = new Map<string, Player>();
  for (const p of pool.players) { idMap.set(p.id, p); nameMap.set(norm(p.name), p); }

  // Build candidate pool from actuals entries (deduped by player set)
  const seenHashes = new Set<string>();
  const allCandidates: Lineup[] = [];
  for (const e of actuals.entries) {
    const players: Player[] = [];
    let ok = true;
    for (const nm of e.playerNames) {
      const p = nameMap.get(norm(nm));
      if (!p) { ok = false; break; }
      players.push(p);
    }
    if (!ok || players.length !== config.rosterSize) continue;
    const h = players.map(p => p.id).sort().join('|');
    if (seenHashes.has(h)) continue;
    seenHashes.add(h);
    const salary = players.reduce((sum, p) => sum + p.salary, 0);
    if (salary > config.salaryCap) continue;
    const projection = players.reduce((sum, p) => sum + (p.projection || 0), 0);
    const ownership = players.reduce((sum, p) => sum + (p.ownership || 0), 0);
    allCandidates.push({ players, salary, projection, ownership, hash: h });
  }

  // Sample POOL_SAMPLE_SIZE from candidates (or use all if fewer)
  let sampled: Lineup[];
  if (allCandidates.length <= POOL_SAMPLE_SIZE) {
    sampled = allCandidates;
  } else {
    // Reservoir sample
    sampled = allCandidates.slice(0, POOL_SAMPLE_SIZE);
    for (let i = POOL_SAMPLE_SIZE; i < allCandidates.length; i++) {
      const j = Math.floor(Math.random() * (i + 1));
      if (j < POOL_SAMPLE_SIZE) sampled[j] = allCandidates[i];
    }
  }

  const F = actuals.entries.length;
  const sorted = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
  const top1Thresh = sorted[Math.max(0, Math.floor(F * 0.01) - 1)] || 0;
  const cashThresh = sorted[Math.max(0, Math.floor(F * 0.22) - 1)] || 0;
  const payoutTable = buildPayoutTable(F);
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

  const comboFreq = precomputeComboFrequencies(sampled, 3);
  const comboFreq1 = precomputeComboFrequencies(sampled, 1);
  const comboFreq2 = precomputeComboFrequencies(sampled, 2);
  const comboFreq4 = precomputeComboFrequencies(sampled, 4);
  const anchor = computeAnchor(sampled, 50);

  console.log('  ' + s.slate + ': built ' + allCandidates.length + ' candidates from actuals, sampled to ' + sampled.length + '. F=' + F);
  return { slate: s.slate, candidates: sampled, players: pool.players, comboFreq, comboFreq1, comboFreq2, comboFreq4, actuals, actualByHash, sorted, top1Thresh, cashThresh, payoutTable, F, anchor };
}

const getCombo = (sd: SlateData, power?: number) => {
  if (power === 1) return sd.comboFreq1;
  if (power === 2) return sd.comboFreq2;
  if (power === 4) return sd.comboFreq4;
  return sd.comboFreq;
};

function buildNbaCfg(cfg: any, sd: SlateData): Parameters<typeof productionSelect>[2] {
  const a = cfg.alloc || [0.05, 0.05, 0.85, 0.03, 0.02];
  const binAllocation = { chalk: a[0], core: a[1], value: a[2], contra: a[3], deep: a[4] };
  const gam = cfg.gam || 6;
  const power = cfg.power ?? 2;
  const floor = (cfg.fl !== undefined) ? cfg.fl : 0;
  return {
    N,
    lambda: cfg.lam,
    comboFreq: getCombo(sd, power),
    maxOverlap: gam,
    teamCapPct: cfg.tc,
    minPrimaryStack: 0,
    maxExposure: cfg.me,
    maxExposurePitcher: cfg.mep || 0.5,
    extremeCornerCap: false,
    projectionFloorPct: floor,
    binAllocation,
  };
}

interface ConfigResult {
  id: string;
  cfg: any;
  fullPay: number;
  t1: number;
  scored: number;
  profitable: number;
  meanIqrFrac: number;
  worstSlate: number;
  perSlate: { slate: string; pay: number; t1: number }[];
}

function evaluateConfig(id: string, cfg: any, cache: SlateData[]): ConfigResult {
  const perSlate: { slate: string; pay: number; t1: number }[] = [];
  let fullPay = 0, t1 = 0, scored = 0, profitable = 0;
  let sumIqrFrac = 0, nValidSlates = 0;
  for (const sd of cache) {
    let slatePay = 0, slateT1 = 0;
    const ranks: number[] = [];
    try {
      const result = productionSelect(sd.candidates, sd.players, buildNbaCfg(cfg, sd));
      for (const lu of result.portfolio) {
        const a = scoreLineup(lu, sd.actualByHash); if (a === null) continue;
        scored++;
        slatePay += payoutFor(a, sd.sorted, sd.payoutTable, sd.actuals);
        if (a >= sd.top1Thresh) slateT1++;
        ranks.push(rankOf(a, sd.sorted));
      }
    } catch {}
    perSlate.push({ slate: sd.slate, pay: slatePay, t1: slateT1 });
    fullPay += slatePay;
    t1 += slateT1;
    if (slatePay > FEE * N) profitable++;
    if (ranks.length >= 30) {
      ranks.sort((a, b) => a - b);
      const q1 = ranks[Math.floor(ranks.length * 0.25)];
      const q3 = ranks[Math.floor(ranks.length * 0.75)];
      sumIqrFrac += (q3 - q1) / sd.F;
      nValidSlates++;
    }
  }
  const worstSlate = perSlate.length ? Math.min(...perSlate.map(p => p.pay)) : 0;
  return { id, cfg, fullPay, t1, scored, profitable, meanIqrFrac: nValidSlates ? sumIqrFrac / nValidSlates : 0, worstSlate, perSlate };
}

async function main() {
  console.log('================================================================');
  console.log('NBA MEGABIN 5K-POOL — top ' + TOP_K_CONFIGS + ' MLB configs on actuals-sampled NBA pools');
  console.log('================================================================\n');

  const t_start = Date.now();
  const FEES_PER_SLATE = N * FEE;

  console.log('Loading MLB configs from ' + IN_JSON + '...');
  const all = JSON.parse(fs.readFileSync(IN_JSON, 'utf-8')) as any[];
  console.log('  loaded ' + all.length + ' MLB configs');
  all.sort((a, b) => (b.fullPayV17 || b.fullPay || 0) - (a.fullPayV17 || a.fullPay || 0));
  const topConfigs = all.slice(0, TOP_K_CONFIGS).map(r => ({ id: r.id, cfg: r.cfg }));
  console.log('  selected top ' + topConfigs.length + ' by full17 ROI\n');

  // Resume support
  let results: ConfigResult[] = [];
  if (fs.existsSync(OUT_JSON)) {
    try {
      const saved = JSON.parse(fs.readFileSync(OUT_JSON, 'utf-8')) as ConfigResult[];
      results = saved;
      const seenIds = new Set(saved.map(r => r.id));
      const remaining = topConfigs.filter(c => !seenIds.has(c.id));
      console.log('RESUME: ' + saved.length + ' results loaded, ' + remaining.length + ' remaining\n');
      topConfigs.length = 0;
      topConfigs.push(...remaining);
    } catch (e: any) {
      console.log('  RESUME failed (' + e.message + '), starting fresh\n');
      results = [];
    }
  }

  console.log('Loading ' + NBA_SLATES.length + ' NBA slates with 5K-sampled actuals pools...');
  const cache: SlateData[] = [];
  for (const s of NBA_SLATES) {
    try {
      const c = await loadSlateWithActualsPool(s);
      if (c) cache.push(c);
    } catch (e: any) {
      console.log('  ' + s.slate + ' ERROR: ' + e.message);
    }
  }
  console.log(cache.length + ' slates loaded.\n');
  if (cache.length === 0) { console.error('No slates loaded'); process.exit(1); }

  console.log('Beginning evaluation. Budget: ' + (BUDGET_MS / 3600000).toFixed(1) + 'h. Target: ' + topConfigs.length + ' new configs.\n');

  let nFail = 0;
  for (let i = 0; i < topConfigs.length; i++) {
    if (Date.now() - t_start > BUDGET_MS) {
      console.log('\nBUDGET HIT after ' + i + ' new configs');
      break;
    }
    const c = topConfigs[i];
    let r: ConfigResult;
    try {
      r = evaluateConfig(c.id, c.cfg, cache);
    } catch (e) {
      nFail++;
      r = { id: c.id, cfg: c.cfg, fullPay: 0, t1: 0, scored: 0, profitable: 0, meanIqrFrac: 0, worstSlate: 0, perSlate: [] };
    }
    results.push(r);

    if (results.length % 100 === 0) {
      const elapsedMin = (Date.now() - t_start) / 60000;
      const rate = (i + 1) / elapsedMin;
      const remainingMin = (topConfigs.length - (i + 1)) / rate;
      const best = results.reduce((b: ConfigResult, x) => x.fullPay > b.fullPay ? x : b, results[0]);
      const bestROI = ((best.fullPay / (FEES_PER_SLATE * cache.length) - 1) * 100).toFixed(1);
      console.log('  [' + results.length + '/' + (results.length + topConfigs.length - i - 1) + ' done, ' + elapsedMin.toFixed(1) + 'm, ETA ' + remainingMin.toFixed(0) + 'm] best=$' + best.fullPay.toFixed(0) + ' (' + bestROI + '%) prof=' + best.profitable + '/' + cache.length);
    }
    if (results.length % 250 === 0) {
      fs.writeFileSync(OUT_JSON, JSON.stringify(results, null, 0));
    }
  }

  fs.writeFileSync(OUT_JSON, JSON.stringify(results, null, 0));
  console.log('\nSaved ' + results.length + ' results.');

  // Analysis
  const FEES_FULL = cache.length * FEES_PER_SLATE;
  console.log('\n================================================================');
  console.log('NBA 5K-POOL COMPLETE — ' + results.length + ' configs in ' + ((Date.now() - t_start) / 60000).toFixed(1) + ' min');
  console.log('Fees: $' + FEES_FULL.toLocaleString() + ' (' + cache.length + ' slates)');
  console.log('================================================================\n');

  const byFull = [...results].sort((a, b) => b.fullPay - a.fullPay);
  console.log('=== TOP 25 BY FULL ROI ===');
  for (let i = 0; i < Math.min(25, byFull.length); i++) {
    const r = byFull[i];
    const roi = ((r.fullPay / FEES_FULL - 1) * 100).toFixed(1);
    console.log('  ' + (i + 1).toString().padStart(2) + ' | full=$' + r.fullPay.toFixed(0).padStart(7) + ' | ROI=' + roi.padStart(7) + '% | prof=' + r.profitable + '/' + cache.length + ' | disp=' + (r.meanIqrFrac * 100).toFixed(1) + '% | worst=$' + r.worstSlate.toFixed(0) + ' | ' + r.id.slice(0, 50));
  }

  console.log('\n=== TOP 15 BY PROFITABLE COUNT (consistency) ===');
  const byProf = [...results].sort((a, b) => b.profitable - a.profitable || b.fullPay - a.fullPay);
  for (let i = 0; i < Math.min(15, byProf.length); i++) {
    const r = byProf[i];
    const roi = ((r.fullPay / FEES_FULL - 1) * 100).toFixed(1);
    console.log('  ' + (i + 1).toString().padStart(2) + ' | prof=' + r.profitable + '/' + cache.length + ' | ROI=' + roi.padStart(7) + '% | full=$' + r.fullPay.toFixed(0).padStart(7) + ' | ' + r.id.slice(0, 50));
  }

  // Per-slate concentration check (replicate the lottery analysis from before)
  console.log('\n=== PER-SLATE AGGREGATE (50K config sample if available) ===');
  const slatePays: Record<string, { total: number; max: number; count: number; profitable: number }> = {};
  for (const r of results) {
    for (const s of r.perSlate || []) {
      if (!slatePays[s.slate]) slatePays[s.slate] = { total: 0, max: 0, count: 0, profitable: 0 };
      slatePays[s.slate].total += s.pay;
      slatePays[s.slate].count++;
      if (s.pay > slatePays[s.slate].max) slatePays[s.slate].max = s.pay;
      if (s.pay > FEE * N) slatePays[s.slate].profitable++;
    }
  }
  console.log('  slate           avgPay   maxPay   profRate');
  for (const s of Object.keys(slatePays).sort()) {
    const v = slatePays[s];
    const avg = (v.total / v.count).toFixed(0);
    const profPct = (v.profitable / v.count * 100).toFixed(1);
    console.log('  ' + s.padEnd(14) + '$' + avg.padStart(7) + '  $' + v.max.toFixed(0).padStart(7) + '   ' + profPct + '%');
  }

  // Save MD summary
  let md = '# NBA Megabin 5K-Pool Sweep\n\n';
  md += '**' + results.length + ' MLB configs** evaluated on **' + cache.length + ' NBA slates** with 5K-sampled actuals pools (replaces narrow 500-pool issue).\n\n';
  md += 'Total fees: $' + FEES_FULL.toLocaleString() + '\n\n';
  md += '## Top 25 by Full ROI\n\n';
  md += '| Rank | Config | Full | ROI | profit | disp |\n|---:|---|---:|---:|---:|---:|\n';
  for (let i = 0; i < Math.min(25, byFull.length); i++) {
    const r = byFull[i];
    const roi = ((r.fullPay / FEES_FULL - 1) * 100).toFixed(1);
    md += '| ' + (i + 1) + ' | `' + r.id.slice(0, 50) + '` | $' + r.fullPay.toFixed(0) + ' | ' + roi + '% | ' + r.profitable + '/' + cache.length + ' | ' + (r.meanIqrFrac * 100).toFixed(1) + '% |\n';
  }
  md += '\n## Top 15 by Profitable Count\n\n';
  md += '| Rank | Config | profit | ROI | full |\n|---:|---|---:|---:|---:|\n';
  for (let i = 0; i < Math.min(15, byProf.length); i++) {
    const r = byProf[i];
    const roi = ((r.fullPay / FEES_FULL - 1) * 100).toFixed(1);
    md += '| ' + (i + 1) + ' | `' + r.id.slice(0, 50) + '` | ' + r.profitable + '/' + cache.length + ' | ' + roi + '% | $' + r.fullPay.toFixed(0) + ' |\n';
  }
  fs.writeFileSync(OUT_MD, md);
  console.log('\nJSON: ' + OUT_JSON);
  console.log('MD:   ' + OUT_MD);
}

main().catch(e => { console.error(e); process.exit(1); });
