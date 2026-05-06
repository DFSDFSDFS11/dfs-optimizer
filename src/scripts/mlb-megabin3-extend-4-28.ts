/**
 * MLB Megabin V3 — Extend with 4-28-26 slate.
 * Loads v17 JSON, picks top 2K by fullPayV17, evaluates on 4-28 slate, ranks.
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

const DIR = 'C:/Users/colin/dfs opto';
const IN_JSON = path.join(DIR, 'mlb_megabin3_sweep_v17.json');
const OUT_JSON = path.join(DIR, 'mlb_megabin3_sweep_v18.json');
const OUT_MD = path.join(DIR, 'mlb_megabin3_sweep_v18.md');
const FEE = 20;
const N = 150;
const TOP_K = 2000;

const NEW_SLATE = {
  slate: '4-28-26',
  proj: '4-28-26projections.csv',
  actuals: '4-28-26actuals.csv',
  pool: '4-28-26sspool.csv',
};

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

async function loadSlate(s: { slate: string; proj: string; actuals: string; pool: string }): Promise<SlateData | null> {
  const projPath = path.join(DIR, s.proj); const actualsPath = path.join(DIR, s.actuals); const poolPath = path.join(DIR, s.pool);
  if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) return null;
  const pr = parseCSVFile(projPath, 'mlb', true);
  const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
  const pool = buildPlayerPool(pr.players, pr.detectedContestType);
  const actuals = parseContestActuals(actualsPath, config);
  const idMap = new Map<string, Player>(); const nameMap = new Map<string, Player>();
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

function buildRunCfg(cfg: any, sd: SlateData): Parameters<typeof productionSelect>[2] {
  const a = cfg.alloc || [0.05, 0.05, 0.85, 0.03, 0.02];
  const binAllocation = { chalk: a[0], core: a[1], value: a[2], contra: a[3], deep: a[4] };
  const phase = cfg.phase;
  if (phase === 'A') return { N, lambda: cfg.lam, comboFreq: sd.comboFreq, maxOverlap: cfg.gam, teamCapPct: cfg.tc, minPrimaryStack: cfg.mps, maxExposure: cfg.me, maxExposurePitcher: cfg.mep, extremeCornerCap: cfg.corner, projectionFloorPct: 0, binAllocation };
  if (phase === 'B') return { N, lambda: cfg.lam, comboFreq: getCombo(sd, cfg.power), maxOverlap: cfg.gam, teamCapPct: cfg.tc, minPrimaryStack: cfg.mps, maxExposure: cfg.me, extremeCornerCap: true, projectionFloorPct: 0, binAllocation };
  if (phase === 'C') return { N, lambda: cfg.lam, comboFreq: getCombo(sd, cfg.power), maxOverlap: 6, teamCapPct: cfg.tc, minPrimaryStack: cfg.mps, maxExposure: cfg.me, maxExposurePitcher: cfg.mep, extremeCornerCap: cfg.corner, projectionFloorPct: 0, binAllocation };
  if (phase === 'D') return { N, lambda: cfg.lam, comboFreq: getCombo(sd, cfg.power), maxOverlap: cfg.gam, teamCapPct: cfg.tc, minPrimaryStack: 5, maxExposure: cfg.me, maxExposurePitcher: cfg.mep, extremeCornerCap: cfg.corner, projectionFloorPct: 0, binAllocation };
  if (phase === 'E') return { N, lambda: cfg.lam, comboFreq: getCombo(sd, cfg.power), maxOverlap: cfg.gam, teamCapPct: cfg.tc, minPrimaryStack: cfg.mps, maxExposure: cfg.me, maxExposurePitcher: cfg.mep, extremeCornerCap: cfg.corner, projectionFloorPct: 0, binAllocation };
  return { N, lambda: cfg.lam, comboFreq: getCombo(sd, cfg.power), maxOverlap: cfg.gam, teamCapPct: cfg.tc, projectionFloorPct: cfg.fl, minPrimaryStack: cfg.mps, maxExposure: cfg.me, maxExposurePitcher: cfg.mep, extremeCornerCap: cfg.corner, extremeCornerQ5Q5Pct: cfg.q5, extremeCornerQ1Q1Pct: cfg.q1, useOwnershipCeiling: cfg.useOC, ownDropPP: cfg.od, ownershipCeilingBuffer: cfg.buf, binAllocation };
}

async function main() {
  console.log('================================================================');
  console.log('MLB MEGABIN V3 — Extend top ' + TOP_K + ' configs with new slate ' + NEW_SLATE.slate);
  console.log('================================================================\n');

  console.log('Loading new slate ' + NEW_SLATE.slate + '...');
  const sd = await loadSlate(NEW_SLATE);
  if (!sd) { console.error('Failed to load slate'); process.exit(1); }
  console.log('  slate loaded: F=' + sd.F + ' candidates=' + sd.candidates.length + ' players=' + sd.players.length);

  console.log('\nLoading v17 saved configs from ' + IN_JSON + '...');
  const all = JSON.parse(fs.readFileSync(IN_JSON, 'utf-8')) as any[];
  console.log('  loaded ' + all.length + ' configs');
  all.sort((a, b) => (b.fullPayV17 || b.fullPay || 0) - (a.fullPayV17 || a.fullPay || 0));
  const top = all.slice(0, TOP_K);
  console.log('  selected top ' + top.length + ' by fullPayV17\n');

  const t_start = Date.now();
  for (let i = 0; i < top.length; i++) {
    const r = top[i];
    let slatePay = 0, slateT1 = 0;
    let iqrFracNew = 0;
    try {
      const runCfg = buildRunCfg(r.cfg, sd);
      const result = productionSelect(sd.candidates, sd.players, runCfg);
      const ranks: number[] = [];
      for (const lu of result.portfolio) {
        const a = scoreLineup(lu, sd.actuals, sd.actualByHash); if (a === null) continue;
        slatePay += payoutFor(a, sd.sorted, sd.payoutTable, sd.actuals);
        if (a >= sd.top1Thresh) slateT1++;
        ranks.push(rankOf(a, sd.sorted));
      }
      if (ranks.length >= 30) {
        ranks.sort((a, b) => a - b);
        const q1 = ranks[Math.floor(ranks.length * 0.25)];
        const q3 = ranks[Math.floor(ranks.length * 0.75)];
        iqrFracNew = (q3 - q1) / sd.F;
      }
    } catch {}

    if (!Array.isArray(r.perSlate)) r.perSlate = [];
    r.perSlate = r.perSlate.filter((p: any) => p.slate !== NEW_SLATE.slate);
    r.perSlate.push({ slate: NEW_SLATE.slate, pay: slatePay, t1: slateT1 });
    r.newSlate2Pay = slatePay;
    r.newSlate2T1 = slateT1;
    r.newSlate2Iqr = iqrFracNew;
    // V18 = V17 + new slate
    r.fullPayV18 = (r.fullPayV17 || 0) + slatePay;

    if ((i + 1) % 200 === 0) {
      const elapsed = (Date.now() - t_start) / 1000;
      console.log('  [' + (i + 1) + '/' + top.length + ' ' + ((i + 1) / top.length * 100).toFixed(0) + '%, ' + elapsed.toFixed(0) + 's]');
    }
  }

  console.log('\nDone. ' + top.length + ' configs in ' + ((Date.now() - t_start) / 1000).toFixed(0) + 's.');
  fs.writeFileSync(OUT_JSON, JSON.stringify(top, null, 0));
  console.log('Saved ' + OUT_JSON);

  // Analysis
  const FEES_FULL = 18 * N * FEE;
  const FEES_OOS7 = 7 * N * FEE;  // 5 prior OOS + 4-27 + 4-28
  const fmt = (r: any) => {
    const fROI = ((r.fullPayV18 / FEES_FULL - 1) * 100).toFixed(1);
    const oos7 = (r.oosPay || 0) + (r.newSlatePay || 0) + r.newSlate2Pay;
    const oROI = ((oos7 / FEES_OOS7 - 1) * 100).toFixed(1);
    return r.id.padEnd(50)
      + ' | full18=$' + r.fullPayV18.toFixed(0).padStart(6)
      + ' fROI=' + fROI.padStart(6) + '%'
      + ' | new=$' + r.newSlate2Pay.toFixed(0).padStart(5)
      + ' | OOS7=$' + oos7.toFixed(0).padStart(6)
      + ' oROI=' + oROI.padStart(6) + '%'
      + ' | disp=' + (r.meanIqrFrac * 100).toFixed(1) + '%';
  };

  console.log('\n=== TOP 25 BY ' + NEW_SLATE.slate + ' PAY (new slate only) ===\n');
  [...top].sort((a, b) => b.newSlate2Pay - a.newSlate2Pay).slice(0, 25).forEach(r => console.log('  ' + fmt(r)));

  console.log('\n=== TOP 25 BY FULL18 ROI ===\n');
  [...top].sort((a, b) => b.fullPayV18 - a.fullPayV18).slice(0, 25).forEach(r => console.log('  ' + fmt(r)));

  console.log('\n=== TOP 25 BY OOS7 (5 prior + 4-27 + 4-28) ===\n');
  [...top].sort((a, b) => ((b.oosPay + b.newSlatePay + b.newSlate2Pay)) - ((a.oosPay + a.newSlatePay + a.newSlate2Pay))).slice(0, 25).forEach(r => console.log('  ' + fmt(r)));

  // 3-way rank-product
  const rFull = new Map<string, number>(), rOos = new Map<string, number>(), rDisp = new Map<string, number>();
  [...top].sort((a, b) => b.fullPayV18 - a.fullPayV18).forEach((r, i) => rFull.set(r.id, i + 1));
  [...top].sort((a, b) => ((b.oosPay + b.newSlatePay + b.newSlate2Pay)) - ((a.oosPay + a.newSlatePay + a.newSlate2Pay))).forEach((r, i) => rOos.set(r.id, i + 1));
  [...top].sort((a, b) => b.meanIqrFrac - a.meanIqrFrac).forEach((r, i) => rDisp.set(r.id, i + 1));
  console.log('\n=== TOP 25 BY 3-WAY RANK-PRODUCT (full18 + OOS7 + disp) ===\n');
  [...top].map(r => ({ ...r, rp3: rFull.get(r.id)! + rOos.get(r.id)! + rDisp.get(r.id)! }))
    .sort((a, b) => a.rp3 - b.rp3).slice(0, 25)
    .forEach(r => console.log('  rp3=' + r.rp3.toString().padStart(4) + ' (#f' + rFull.get(r.id) + ' #o' + rOos.get(r.id) + ' #d' + rDisp.get(r.id) + ') | ' + fmt(r)));

  // Markdown
  let md = '# MLB Megabin V3 — Top 2K extended with ' + NEW_SLATE.slate + '\n\n';
  md += 'Top ' + top.length + ' configs (by V17 ROI) evaluated on ' + NEW_SLATE.slate + ' (F=' + sd.F + ').\n\n';
  fs.writeFileSync(OUT_MD, md);
  console.log('\nMD: ' + OUT_MD);
}

main().catch(e => { console.error(e); process.exit(1); });
