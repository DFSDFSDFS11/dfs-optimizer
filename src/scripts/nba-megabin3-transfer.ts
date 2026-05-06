/**
 * NBA Megabin Transfer — runs top 50K MLB configs (by full17 ROI) on 12 NBA backtest slates
 * with NBA-specific overrides: minPrimaryStack=0, extremeCornerCap=false, projectionFloorPct
 * preserved from MLB sweep (max with 0 — i.e., not forced to 0.85 in backtest exploration).
 *
 * Budget: 7 hours. Saves every 500 configs to nba_megabin_transfer.json.
 * Pitcher-specific params (mep) are inert on NBA (no pitchers).
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
import { computeAnchor } from '../selection/anchor-relative';

const HIST_DIR = 'C:/Users/colin/Projects/dfs-optimizer/historical_slates';
const OUT_DIR = 'C:/Users/colin/dfs opto';
const IN_JSON = path.join(OUT_DIR, 'mlb_megabin3_sweep_v17.json');
const OUT_JSON = path.join(OUT_DIR, 'nba_megabin_transfer.json');
const OUT_MD = path.join(OUT_DIR, 'nba_megabin_transfer.md');
const FEE = 20;
const N = 150;
const TOP_K_CONFIGS = 50000;
const BUDGET_MS = 7 * 60 * 60 * 1000;

const NBA_SLATES = [
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
  const pool = F * FEE * 0.88; const cashLine = Math.floor(F * 0.22);
  const raw = new Float64Array(cashLine); let rawSum = 0;
  for (let r = 0; r < cashLine; r++) { raw[r] = Math.pow(r + 1, -1.15); rawSum += raw[r]; }
  const table = new Float64Array(F); const minCash = FEE * 1.2;
  for (let r = 0; r < cashLine; r++) table[r] = Math.max(minCash, (raw[r] / rawSum) * pool);
  let tSum = 0; for (let r = 0; r < cashLine; r++) tSum += table[r];
  const scale = pool / tSum; for (let r = 0; r < cashLine; r++) table[r] *= scale;
  return table;
}
function scoreLineup(lu: Lineup, actuals: ContestActuals, actualByHash: Map<string, number>): number | null {
  const h = lu.players.map(p => p.id).sort().join('|'); const fa = actualByHash.get(h);
  if (fa !== undefined) return fa;
  let t = 0; for (const p of lu.players) { const r = actuals.playerActualsByName.get(norm(p.name)); if (!r) return null; t += r.fpts; }
  return t;
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

async function loadSlate(s: typeof NBA_SLATES[0]): Promise<SlateData | null> {
  const projPath = path.join(HIST_DIR, s.proj);
  const actualsPath = path.join(HIST_DIR, s.actuals);
  const poolPath = path.join(HIST_DIR, s.pool);
  if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) return null;
  const pr = parseCSVFile(projPath, 'nba', true);
  const config = getContestConfig('dk', 'nba', pr.detectedContestType);
  const pool = buildPlayerPool(pr.players, pr.detectedContestType);
  const actuals = parseContestActuals(actualsPath, config);
  const idMap = new Map<string, Player>();
  const nameMap = new Map<string, Player>();
  for (const p of pool.players) { idMap.set(p.id, p); nameMap.set(norm(p.name), p); }
  const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
  const F = actuals.entries.length;
  const sorted = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
  const top1Thresh = sorted[Math.max(0, Math.floor(F * 0.01) - 1)] || 0;
  const cashThresh = sorted[Math.max(0, Math.floor(F * 0.22) - 1)] || 0;
  const payoutTable = buildPayoutTable(F);
  const actualByHash = new Map<string, number>();
  for (const e of actuals.entries) {
    const pls: Player[] = []; let ok = true;
    for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
    if (!ok) continue;
    actualByHash.set(pls.map(p => p.id).sort().join('|'), e.actualPoints);
  }
  const comboFreq = precomputeComboFrequencies(loaded.lineups, 3);
  const comboFreq1 = precomputeComboFrequencies(loaded.lineups, 1);
  const comboFreq2 = precomputeComboFrequencies(loaded.lineups, 2);
  const comboFreq4 = precomputeComboFrequencies(loaded.lineups, 4);
  const anchor = computeAnchor(loaded.lineups, 50);
  return { slate: s.slate, candidates: loaded.lineups, players: pool.players, comboFreq, comboFreq1, comboFreq2, comboFreq4, actuals, actualByHash, sorted, top1Thresh, cashThresh, payoutTable, F, anchor };
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
  // NBA-adapted γ: cap at 6 (8-player roster, γ>=8 is no-op)
  const gam = cfg.gam || 6;
  const power = cfg.power ?? 2;
  // Preserve projection floor from MLB sweep (Phase F has fl, others have 0)
  const floor = (cfg.fl !== undefined) ? cfg.fl : 0;
  return {
    N,
    lambda: cfg.lam,
    comboFreq: getCombo(sd, power),
    maxOverlap: gam,
    teamCapPct: cfg.tc,
    minPrimaryStack: 0,        // OVERRIDE: NBA has no stacking
    maxExposure: cfg.me,
    maxExposurePitcher: cfg.mep || 0.5,  // inert on NBA, but provide a value
    extremeCornerCap: false,   // OVERRIDE: MLB-only feature
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
        const a = scoreLineup(lu, sd.actuals, sd.actualByHash); if (a === null) continue;
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
  console.log('NBA MEGABIN TRANSFER — top ' + TOP_K_CONFIGS + ' MLB configs evaluated on NBA backtest');
  console.log('================================================================\n');

  const t_start = Date.now();
  const FEES_PER_SLATE = N * FEE;

  console.log('Loading MLB configs from ' + IN_JSON + '...');
  const all = JSON.parse(fs.readFileSync(IN_JSON, 'utf-8')) as any[];
  console.log('  loaded ' + all.length + ' MLB configs');
  // Sort by full17 (preferred) or fallback to fullPay
  all.sort((a, b) => (b.fullPayV17 || b.fullPay || 0) - (a.fullPayV17 || a.fullPay || 0));
  const topConfigs = all.slice(0, TOP_K_CONFIGS).map(r => ({ id: r.id, cfg: r.cfg, mlbFullPay: r.fullPayV17 || r.fullPay }));
  console.log('  selected top ' + topConfigs.length + ' by full17/full ROI\n');

  // Resume support
  let resumeIdx = 0;
  let results: ConfigResult[] = [];
  if (fs.existsSync(OUT_JSON)) {
    try {
      const saved = JSON.parse(fs.readFileSync(OUT_JSON, 'utf-8')) as any[];
      const seenIds = new Set(saved.map(r => r.id));
      results = saved;
      // Find resume point in topConfigs (configs may be in different order)
      const seenSet = new Set(saved.map(r => r.id));
      const remaining = topConfigs.filter(c => !seenSet.has(c.id));
      console.log('RESUME: ' + saved.length + ' results loaded, ' + remaining.length + ' remaining');
      // Replace topConfigs list with the remaining ones
      topConfigs.length = 0;
      topConfigs.push(...remaining);
      resumeIdx = saved.length;
    } catch (e: any) {
      console.log('  RESUME failed (' + e.message + '), starting fresh');
      results = [];
    }
  }

  console.log('Loading ' + NBA_SLATES.length + ' NBA slates...');
  const cache: SlateData[] = [];
  for (const s of NBA_SLATES) {
    try {
      const c = await loadSlate(s);
      if (c) {
        cache.push(c);
        console.log('  ' + s.slate + ' loaded F=' + c.F + ' candidates=' + c.candidates.length + ' players=' + c.players.length);
      } else {
        console.log('  ' + s.slate + ' SKIP (missing files)');
      }
    } catch (e: any) {
      console.log('  ' + s.slate + ' ERROR: ' + e.message);
    }
  }
  console.log(cache.length + ' slates loaded.\n');
  if (cache.length === 0) { console.error('No slates loaded, abort'); process.exit(1); }

  const TOTAL_TARGET = resumeIdx + topConfigs.length;
  console.log('Beginning evaluation. Budget: ' + (BUDGET_MS / 3600000).toFixed(1) + 'h. Total target: ' + TOTAL_TARGET + ' configs.\n');

  let nFail = 0;
  for (let i = 0; i < topConfigs.length; i++) {
    if (Date.now() - t_start > BUDGET_MS) {
      console.log('\nBUDGET HIT after ' + (i + resumeIdx) + ' configs');
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

    if (results.length % 200 === 0) {
      const elapsedMin = (Date.now() - t_start) / 60000;
      const rate = (i + 1) / elapsedMin;
      const remainingMin = (topConfigs.length - (i + 1)) / rate;
      // Find current best by full ROI
      const best = results.reduce((b: ConfigResult, x) => x.fullPay > b.fullPay ? x : b, results[0]);
      const bestROI = ((best.fullPay / (FEES_PER_SLATE * cache.length) - 1) * 100).toFixed(1);
      console.log('  [' + results.length + '/' + TOTAL_TARGET + ' ' + (results.length / TOTAL_TARGET * 100).toFixed(1) + '%, ' + elapsedMin.toFixed(1) + 'm, ETA ' + remainingMin.toFixed(0) + 'm] best=$' + best.fullPay.toFixed(0) + ' (' + bestROI + '%) fail=' + nFail);
    }
    if (results.length % 500 === 0) {
      const compact = results.map(r => ({ id: r.id, cfg: r.cfg, fullPay: r.fullPay, t1: r.t1, scored: r.scored, profitable: r.profitable, meanIqrFrac: r.meanIqrFrac, worstSlate: r.worstSlate, perSlate: r.perSlate }));
      fs.writeFileSync(OUT_JSON, JSON.stringify(compact, null, 0));
    }
  }

  // Final save
  fs.writeFileSync(OUT_JSON, JSON.stringify(results, null, 0));
  console.log('\nSaved ' + results.length + ' results to ' + OUT_JSON);

  // Analysis
  const FEES_FULL = cache.length * FEES_PER_SLATE;
  console.log('\n================================================================');
  console.log('NBA TRANSFER COMPLETE — ' + results.length + ' configs in ' + ((Date.now() - t_start) / 60000).toFixed(1) + ' min');
  console.log('NBA fees: $' + FEES_FULL.toLocaleString() + ' (' + cache.length + ' slates)');
  console.log('================================================================\n');

  const byFull = [...results].sort((a, b) => b.fullPay - a.fullPay);
  console.log('=== TOP 25 BY NBA FULL ROI ===');
  for (let i = 0; i < Math.min(25, byFull.length); i++) {
    const r = byFull[i];
    const roi = ((r.fullPay / FEES_FULL - 1) * 100).toFixed(1);
    console.log('  ' + (i + 1).toString().padStart(2) + ' | full=$' + r.fullPay.toFixed(0).padStart(7) + ' | ROI=' + roi.padStart(6) + '% | disp=' + (r.meanIqrFrac * 100).toFixed(1) + '% | profit=' + r.profitable + '/' + cache.length + ' | worst=$' + r.worstSlate.toFixed(0) + ' | ' + r.id.slice(0, 55));
  }

  console.log('\n=== TOP 25 BY DISPERSION ===');
  const byDisp = [...results].sort((a, b) => b.meanIqrFrac - a.meanIqrFrac);
  for (let i = 0; i < Math.min(25, byDisp.length); i++) {
    const r = byDisp[i];
    const roi = ((r.fullPay / FEES_FULL - 1) * 100).toFixed(1);
    console.log('  ' + (i + 1).toString().padStart(2) + ' | disp=' + (r.meanIqrFrac * 100).toFixed(1) + '% | full=$' + r.fullPay.toFixed(0).padStart(7) + ' | ROI=' + roi.padStart(6) + '% | profit=' + r.profitable + '/' + cache.length + ' | ' + r.id.slice(0, 55));
  }

  // Smooth (rank-product full + disp)
  const rFull = new Map<string, number>(), rDisp = new Map<string, number>();
  byFull.forEach((r, i) => rFull.set(r.id, i + 1));
  byDisp.forEach((r, i) => rDisp.set(r.id, i + 1));
  const bySmooth = results.map(r => ({ ...r, comb: rFull.get(r.id)! + rDisp.get(r.id)! })).sort((a, b) => a.comb - b.comb);
  console.log('\n=== TOP 25 SMOOTH WINNERS (full + disp rank-product) ===');
  for (let i = 0; i < Math.min(25, bySmooth.length); i++) {
    const r = bySmooth[i];
    const roi = ((r.fullPay / FEES_FULL - 1) * 100).toFixed(1);
    console.log('  ' + (i + 1).toString().padStart(2) + ' | rp=' + r.comb.toString().padStart(5) + ' | full#' + rFull.get(r.id)! + ' disp#' + rDisp.get(r.id)! + ' | ROI=' + roi.padStart(6) + '% | disp=' + (r.meanIqrFrac * 100).toFixed(1) + '% | ' + r.id.slice(0, 55));
  }

  // Markdown
  let md = '# NBA Megabin Transfer\n\n';
  md += '**' + results.length + ' MLB configs** evaluated on **' + cache.length + ' NBA backtest slates** (' + NBA_SLATES.slice(0, cache.length).map(s => s.slate).join(', ') + ').\n\n';
  md += 'Total fees: $' + FEES_FULL.toLocaleString() + '\n\n';
  md += 'NBA overrides: `minPrimaryStack=0, extremeCornerCap=false, γ-cap=6, projectionFloorPct preserved from MLB sweep`.\n\n';
  md += '## Top 25 by NBA Full ROI\n\n';
  md += '| Rank | Config | Full | ROI | disp | profit |\n|---:|---|---:|---:|---:|---:|\n';
  for (let i = 0; i < Math.min(25, byFull.length); i++) {
    const r = byFull[i];
    const roi = ((r.fullPay / FEES_FULL - 1) * 100).toFixed(1);
    md += '| ' + (i + 1) + ' | `' + r.id.slice(0, 55) + '` | $' + r.fullPay.toFixed(0) + ' | ' + roi + '% | ' + (r.meanIqrFrac * 100).toFixed(1) + '% | ' + r.profitable + '/' + cache.length + ' |\n';
  }
  md += '\n## Top 25 Smooth Winners (full + disp rank-product)\n\n';
  md += '| Rank | rp | Config | ROI | disp | profit |\n|---:|---:|---|---:|---:|---:|\n';
  for (let i = 0; i < Math.min(25, bySmooth.length); i++) {
    const r = bySmooth[i];
    const roi = ((r.fullPay / FEES_FULL - 1) * 100).toFixed(1);
    md += '| ' + (i + 1) + ' | ' + r.comb + ' | `' + r.id.slice(0, 55) + '` | ' + roi + '% | ' + (r.meanIqrFrac * 100).toFixed(1) + '% | ' + r.profitable + '/' + cache.length + ' |\n';
  }
  fs.writeFileSync(OUT_MD, md);
  console.log('\nJSON: ' + OUT_JSON);
  console.log('MD:   ' + OUT_MD);
}

main().catch(e => { console.error(e); process.exit(1); });
