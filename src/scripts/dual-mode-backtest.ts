/**
 * Dual-Mode Backtest — measures Value of Information from opponent model.
 *
 * Mode A (Synthetic): V32 selection using synthetic field (production mode)
 * Mode B (Actual): V32 selection using real contest entries as field
 *
 * The gap between Mode A and Mode B = how much fixing the opponent model is worth.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import {
  parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV,
  ContestActuals, ContestEntry,
} from '../parser';
import { getContestConfig } from '../rules';
import {
  DEFAULT_SELECTOR_PARAMS, SelectorParams, defaultGamma, getSportDefaults, precomputeSlate,
} from '../selection/algorithm7-selector';
import { buildV31Context, v31Score } from '../selection/v31-objective';
import { applyConstructedTwins, DEFAULT_CONSTRUCTED_TWIN_PARAMS } from '../selection/constructed-twin';
import { loadRegionMap, computeRegionTargets } from '../analysis/region-map';
import { loadOpponentModel } from '../opponent/calibration';
import { generateCalibratedField, generateBlendedField } from '../opponent/field-generator';

const DATA_DIR = 'C:/Users/colin/dfs opto';
const SLATES = [
  { slate: '4-6-26',  proj: '4-6-26_projections.csv',  actuals: 'dkactuals 4-6-26.csv',    pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26',  proj: '4-8-26projections.csv',   actuals: '4-8-26actuals.csv',       pool: '4-8-26sspool.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv',  actuals: '4-12-26actuals.csv',      pool: '4-12-26sspool.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv',  actuals: '4-14-26actuals.csv',      pool: '4-14-26sspool.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv',  actuals: '4-15-26actuals.csv',      pool: '4-15-26sspool.csv' },
  { slate: '4-17-26', proj: '4-17-26projections.csv',  actuals: '4-17-26actuals.csv',      pool: '4-17-26sspool.csv' },
  { slate: '4-18-26', proj: '4-18-26projections.csv',  actuals: '4-18-26actuals.csv',      pool: '4-18-26sspool.csv' },
];

function norm(n: string): string { return (n||'').toLowerCase().replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim(); }
function findBin(value: number, bins: number[]): number { for (let i = bins.length-1; i >= 0; i--) if (value >= bins[i]) return i; return 0; }

function runV32Selection(
  poolLineups: Lineup[],
  fieldLineups: Lineup[],
  players: Player[],
  config: any,
  regionMap: any,
  selParams: SelectorParams,
): Lineup[] {
  const precomp = precomputeSlate(poolLineups, fieldLineups, players, selParams, 'mlb');
  const ctx = buildV31Context(precomp, fieldLineups, players);

  // Region targeting with feasibility filter
  const poolCoords = poolLineups.map(l => ({
    projection: l.projection,
    ownership: l.players.reduce((s: number, p: Player) => s + (p.ownership || 0), 0) / l.players.length,
  }));
  const poolDist = new Map<string, number>();
  for (const c of poolCoords) {
    const pB = findBin(c.projection, regionMap.projBins);
    const oB = findBin(c.ownership, regionMap.ownBins);
    poolDist.set(`${pB}_${oB}`, (poolDist.get(`${pB}_${oB}`) || 0) + 1);
  }
  const feasCells = new Map<string, any>(regionMap.cells);
  for (const [k] of feasCells) if ((poolDist.get(k as string) || 0) < 5) feasCells.delete(k);
  const targets = computeRegionTargets({ ...regionMap, cells: feasCells }, 150, 'weighted_lift', 1.0);

  const candCoords = Array.from({ length: precomp.C }, (_, c) => ({
    idx: c,
    projection: precomp.candidatePool[c].projection,
    ownership: precomp.candidatePool[c].players.reduce((s: number, p: Player) => s + (p.ownership || 0), 0) / precomp.candidatePool[c].players.length,
  }));

  const selected: Lineup[] = [];
  const selH = new Set<string>();
  const selExp = new Map<string, number>();
  const expCap = Math.ceil(0.40 * 150);

  const sortedAlloc = [...targets.allocations.entries()].sort((a, b) => {
    const ca = regionMap.cells.get(a[0]), cb = regionMap.cells.get(b[0]);
    const dA = ca ? Math.abs((ca.projRange[0]+ca.projRange[1])/2-regionMap.top1Centroid.projection)/10+Math.abs((ca.ownRange[0]+ca.ownRange[1])/2-regionMap.top1Centroid.ownership)/5 : 99;
    const dB = cb ? Math.abs((cb.projRange[0]+cb.projRange[1])/2-regionMap.top1Centroid.projection)/10+Math.abs((cb.ownRange[0]+cb.ownRange[1])/2-regionMap.top1Centroid.ownership)/5 : 99;
    return dA - dB;
  });

  for (const [key, tc] of sortedAlloc) {
    const cell = regionMap.cells.get(key); if (!cell) continue;
    const rc = candCoords.filter(c => c.projection >= cell.projRange[0] && c.projection < cell.projRange[1] && c.ownership >= cell.ownRange[0] && c.ownership < cell.ownRange[1])
      .map(c => ({ ...c, score: v31Score(c.idx, ctx, precomp, 0.3, 0.3) })).sort((a, b) => b.score - a.score);
    let filled = 0;
    for (const cand of rc) {
      if (filled >= tc) break;
      const lu = precomp.candidatePool[cand.idx]; if (selH.has(lu.hash)) continue;
      let ok = true; for (const p of lu.players) if ((selExp.get(p.id) || 0) >= expCap) { ok = false; break; } if (!ok) continue;
      selected.push(lu); selH.add(lu.hash);
      for (const p of lu.players) selExp.set(p.id, (selExp.get(p.id) || 0) + 1);
      filled++;
    }
  }
  if (selected.length < 150) {
    const all = candCoords.map(c => ({ ...c, score: v31Score(c.idx, ctx, precomp, 0.3, 0.3) })).sort((a, b) => b.score - a.score);
    for (const c of all) {
      if (selected.length >= 150) break;
      const lu = precomp.candidatePool[c.idx]; if (selH.has(lu.hash)) continue;
      let ok = true; for (const p of lu.players) if ((selExp.get(p.id) || 0) >= expCap) { ok = false; break; } if (!ok) continue;
      selected.push(lu); selH.add(lu.hash);
      for (const p of lu.players) selExp.set(p.id, (selExp.get(p.id) || 0) + 1);
    }
  }

  const twin = applyConstructedTwins(selected, players, precomp, config);
  return twin.portfolio;
}

function scorePortfolio(
  portfolio: Lineup[],
  actualByHash: Map<string, number>,
  actuals: ContestActuals,
  thresholds: { top1: number; top5: number; cash: number },
): { t1: number; t5: number; cash: number; scored: number; avgActual: number } {
  let t1 = 0, t5 = 0, cash = 0, scored = 0, sumAct = 0;
  for (const lu of portfolio) {
    const fa = actualByHash.get(lu.hash);
    let a: number | null = fa !== undefined ? fa : null;
    if (a === null) {
      let t = 0, miss = false;
      for (const p of lu.players) { const r = actuals.playerActualsByName.get(norm(p.name)); if (!r) { miss = true; break; } t += r.fpts; }
      if (!miss) a = t;
    }
    if (a === null) continue;
    scored++; sumAct += a;
    if (a >= thresholds.top1) t1++;
    if (a >= thresholds.top5) t5++;
    if (a >= thresholds.cash) cash++;
  }
  return { t1, t5, cash, scored, avgActual: scored > 0 ? sumAct / scored : 0 };
}

async function main() {
  const regionMap = loadRegionMap('C:/Users/colin/dfs opto/region-map-mlb-dk.json');
  let opponentModel: any = null;
  try { opponentModel = loadOpponentModel('C:/Users/colin/dfs opto/opponent-mlb-dk.json'); } catch {}

  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

  let md = `# Dual-Mode Backtest — Value of Information\n\n`;
  md += `**Mode A (Synthetic):** V32 with synthetic/pool-based field\n`;
  md += `**Mode B (Actual):** V32 with real contest entries as field\n\n`;
  md += `| Slate | Entries | Synth t1 | **Actual t1** | Gap | Synth cash | Actual cash | Cash gap |\n`;
  md += `|---|---:|---:|---:|---:|---:|---:|---:|\n`;

  let synthT1Sum = 0, actualT1Sum = 0, synthCashSum = 0, actualCashSum = 0, n = 0;

  for (const s of SLATES) {
    const projPath = path.join(DATA_DIR, s.proj);
    const actualsPath = path.join(DATA_DIR, s.actuals);
    const poolPath = path.join(DATA_DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) { console.log(`skip ${s.slate}`); continue; }

    console.log(`\n=== ${s.slate} ===`);
    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);
    const nameMap = new Map<string, Player>(); for (const p of pool.players) nameMap.set(norm(p.name), p);
    const idMap = new Map<string, Player>(); for (const p of pool.players) idMap.set(p.id, p);

    const F = actuals.entries.length;
    const sorted = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
    const tAt = (f: number) => sorted[Math.max(0, Math.floor(F * f) - 1)] || 0;
    const thresholds = { top1: tAt(0.01), top5: tAt(0.05), cash: tAt(0.20) };

    // Build actual field lineups
    const fieldLineups: Lineup[] = []; const seenH = new Set<string>(); const actualByHash = new Map<string, number>();
    for (const e of actuals.entries) {
      const pls: Player[] = []; let ok = true;
      for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
      if (!ok) continue;
      const hash = pls.map(p => p.id).sort().join('|');
      if (seenH.has(hash)) continue; seenH.add(hash);
      fieldLineups.push({ players: pls, salary: pls.reduce((sm, p) => sm + p.salary, 0), projection: pls.reduce((sm, p) => sm + p.projection, 0), ownership: pls.reduce((sm, p) => sm + (p.ownership || 0), 0) / pls.length, hash });
      actualByHash.set(hash, e.actualPoints);
    }
    if (fieldLineups.length < 100) { console.log('  field too small'); continue; }

    const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
    const poolLineups = loaded.lineups;

    const selParams: SelectorParams = { ...DEFAULT_SELECTOR_PARAMS, ...getSportDefaults('mlb'), N: 150, gamma: defaultGamma(config.rosterSize), numWorlds: 1500 };

    // MODE A: Blended field (80% SS pool + 20% casual)
    console.log(`  Mode A (blended 80/20)…`);
    const synthField = generateBlendedField(
      poolLineups, pool.players, config,
      Math.min(8000, F), 0.20,
    );
    const synthPortfolio = runV32Selection(poolLineups, synthField, pool.players, config, regionMap, selParams);
    const synthResult = scorePortfolio(synthPortfolio, actualByHash, actuals, thresholds);

    // MODE B: Actual field
    console.log(`  Mode B (actual field)…`);
    const actualPortfolio = runV32Selection(poolLineups, fieldLineups, pool.players, config, regionMap, selParams);
    const actualResult = scorePortfolio(actualPortfolio, actualByHash, actuals, thresholds);

    const t1Gap = (actualResult.scored > 0 ? actualResult.t1 / actualResult.scored : 0) - (synthResult.scored > 0 ? synthResult.t1 / synthResult.scored : 0);
    const cashGap = (actualResult.scored > 0 ? actualResult.cash / actualResult.scored : 0) - (synthResult.scored > 0 ? synthResult.cash / synthResult.scored : 0);

    console.log(`    Synth: t1=${synthResult.t1}/${synthResult.scored}  Actual: t1=${actualResult.t1}/${actualResult.scored}  Gap: ${(t1Gap * 100).toFixed(2)}pp`);

    synthT1Sum += synthResult.scored > 0 ? synthResult.t1 / synthResult.scored : 0;
    actualT1Sum += actualResult.scored > 0 ? actualResult.t1 / actualResult.scored : 0;
    synthCashSum += synthResult.scored > 0 ? synthResult.cash / synthResult.scored : 0;
    actualCashSum += actualResult.scored > 0 ? actualResult.cash / actualResult.scored : 0;
    n++;

    const arrow = t1Gap > 0.005 ? '🔺' : t1Gap < -0.005 ? '🔻' : '—';
    md += `| ${s.slate} | ${F.toLocaleString()} | ${pct(synthResult.scored > 0 ? synthResult.t1/synthResult.scored : 0)} (${synthResult.t1}) | **${pct(actualResult.scored > 0 ? actualResult.t1/actualResult.scored : 0)} (${actualResult.t1})** | ${arrow} ${(t1Gap*100).toFixed(2)}pp | ${pct(synthResult.scored > 0 ? synthResult.cash/synthResult.scored : 0)} | ${pct(actualResult.scored > 0 ? actualResult.cash/actualResult.scored : 0)} | ${(cashGap*100).toFixed(1)}pp |\n`;
  }

  md += `| **MEAN** | | **${pct(synthT1Sum/n)}** | **${pct(actualT1Sum/n)}** | **${((actualT1Sum-synthT1Sum)/n*100).toFixed(2)}pp** | **${pct(synthCashSum/n)}** | **${pct(actualCashSum/n)}** | **${((actualCashSum-synthCashSum)/n*100).toFixed(1)}pp** |\n\n`;

  const meanGap = (actualT1Sum - synthT1Sum) / n;
  md += `## Value of Information\n\n`;
  md += `**Mean top-1% gap: ${(meanGap * 100).toFixed(2)}pp**\n\n`;
  if (meanGap >= 0.015) {
    md += `**LARGE gap (≥1.5pp).** Opponent model is THE bottleneck. Calibration is the highest-ROI improvement available. Expected: close 70-90% of remaining gap to skijmb.\n`;
  } else if (meanGap >= 0.005) {
    md += `**MODERATE gap (0.5-1.5pp).** Opponent model matters but isn't the only bottleneck. Calibration would help but other factors (player selection, projection quality) also contribute.\n`;
  } else {
    md += `**SMALL gap (<0.5pp).** Opponent model is adequate. Gap to pros is from other sources (projection quality, information advantages). Don't invest in calibration.\n`;
  }

  const outPath = path.join(DATA_DIR, 'dual_mode_backtest.md');
  fs.writeFileSync(outPath, md);
  console.log(`\n✓ Report: ${outPath}`);
}

main();
