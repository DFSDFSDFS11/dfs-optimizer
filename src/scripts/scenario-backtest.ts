/**
 * Scenario Scoring Backtest — V32 vs Scenario-weighted selection.
 * Both use SS pool → select → score vs actuals with payout computation.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals } from '../parser';
import { getContestConfig } from '../rules';
import { DEFAULT_SELECTOR_PARAMS, SelectorParams, defaultGamma, getSportDefaults, precomputeSlate, SlatePrecomputation } from '../selection/algorithm7-selector';
import { computeScenarioCoverage, computeScenarioScores, scenarioGreedySelect } from '../selection/scenario-scoring';
import { generateBlendedField } from '../opponent/field-generator';
import { loadRegionMap, computeRegionTargets } from '../analysis/region-map';

const DIR = 'C:/Users/colin/dfs opto';
const FEE = 20;
const SLATES = [
  { slate: '4-6-26', proj: '4-6-26_projections.csv', actuals: 'dkactuals 4-6-26.csv', pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26', proj: '4-8-26projections.csv', actuals: '4-8-26actuals.csv', pool: '4-8-26sspool.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv', actuals: '4-12-26actuals.csv', pool: '4-12-26sspool.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv', actuals: '4-14-26actuals.csv', pool: '4-14-26sspool.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv', actuals: '4-15-26actuals.csv', pool: '4-15-26sspool.csv' },
  { slate: '4-17-26', proj: '4-17-26projections.csv', actuals: '4-17-26actuals.csv', pool: '4-17-26sspool.csv' },
  { slate: '4-18-26', proj: '4-18-26projections.csv', actuals: '4-18-26actuals.csv', pool: '4-18-26sspool.csv' },
];

function norm(n: string): string { return (n||'').toLowerCase().replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim(); }
function findBin(v: number, bins: number[]): number { for (let i = bins.length-1; i >= 0; i--) if (v >= bins[i]) return i; return 0; }

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

function scorePortfolio(portfolio: Lineup[], actuals: ContestActuals, actualByHash: Map<string, number>, payoutTable: Float64Array) {
  const F = actuals.entries.length;
  const sorted = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
  const top1T = sorted[Math.max(0, Math.floor(F * 0.01) - 1)] || 0;
  let t1 = 0, scored = 0, totalPayout = 0;
  for (const lu of portfolio) {
    const fa = actualByHash.get(lu.hash); let a: number | null = fa !== undefined ? fa : null;
    if (a === null) { let t = 0, miss = false; for (const p of lu.players) { const r = actuals.playerActualsByName.get(norm(p.name)); if (!r) { miss = true; break; } t += r.fpts; } if (!miss) a = t; }
    if (a === null) continue; scored++;
    let lo = 0, hi = sorted.length; while (lo < hi) { const mid = (lo + hi) >>> 1; if (sorted[mid] >= a) lo = mid + 1; else hi = mid; }
    const rank = Math.max(1, lo);
    if (a >= top1T) t1++;
    const payout = rank <= payoutTable.length ? payoutTable[rank - 1] : 0;
    if (payout > 0) { let coWin = 0; for (const e of actuals.entries) if (Math.abs(e.actualPoints - a) <= 0.25) coWin++; coWin = Math.max(0, coWin - 1); totalPayout += payout / Math.sqrt(1 + coWin * 0.5); }
  }
  const stackTeams = new Set<string>();
  let sOwn = 0;
  for (const lu of portfolio) { sOwn += lu.players.reduce((s: number, p: Player) => s + (p.ownership || 0), 0) / lu.players.length; const tc = new Map<string, number>(); for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1); for (const [t, c] of tc) if (c >= 4) stackTeams.add(t); }
  return { t1, scored, totalPayout, stacks: stackTeams.size, avgOwn: portfolio.length > 0 ? sOwn / portfolio.length : 0 };
}

// V32 selection (same code as real-payout-backtest)
function runV32(precomp: SlatePrecomputation, regionMap: any, poolLineups: Lineup[], numGames: number): Lineup[] {
  const isSmallSlate = numGames <= 4;
  const poolCoords = poolLineups.map(l => ({ projection: l.projection, ownership: l.players.reduce((s: number, p: Player) => s + (p.ownership || 0), 0) / l.players.length }));
  const poolDist = new Map<string, number>(); for (const c of poolCoords) { const pB = findBin(c.projection, regionMap.projBins); const oB = findBin(c.ownership, regionMap.ownBins); poolDist.set(`${pB}_${oB}`, (poolDist.get(`${pB}_${oB}`) || 0) + 1); }
  const feasCells = new Map<string, any>(regionMap.cells); for (const [k] of feasCells) if ((poolDist.get(k as string) || 0) < 5) feasCells.delete(k);
  const poolProjSorted = poolCoords.map(c => c.projection).sort((a, b) => a - b);
  const adjCent = { projection: regionMap.top1Centroid.projection + (poolProjSorted[Math.floor(poolProjSorted.length * 0.75)] - regionMap.top1Centroid.projection), ownership: regionMap.top1Centroid.ownership };
  const wCells = new Map<string, any>(); for (const [key, cell] of feasCells) { const d = Math.sqrt(Math.pow(((cell.projRange[0]+cell.projRange[1])/2 - adjCent.projection)/10, 2) + Math.pow(((cell.ownRange[0]+cell.ownRange[1])/2 - adjCent.ownership)/5, 2)); wCells.set(key, { ...cell, top1Lift: cell.top1Lift / (1+d) / (1+d) }); }
  const targets = computeRegionTargets({ ...regionMap, cells: wCells }, 150, 'weighted_lift', 0.1);
  const candCoords = Array.from({ length: precomp.C }, (_, c) => ({ idx: c, projection: precomp.candidatePool[c].projection, ownership: precomp.candidatePool[c].players.reduce((s: number, p: Player) => s + (p.ownership || 0), 0) / precomp.candidatePool[c].players.length }));
  const sel: Lineup[] = []; const selH = new Set<string>(); const selExp = new Map<string, number>(); const tsc = new Map<string, number>();
  const expCap = Math.ceil((isSmallSlate ? 0.50 : 0.35) * 150); const maxPT = Math.floor(150 * 0.25);
  const sortedAlloc = [...targets.allocations.entries()].sort((a, b) => { const ca = regionMap.cells.get(a[0]) as any, cb = regionMap.cells.get(b[0]) as any; const dA = ca ? Math.abs((ca.projRange[0]+ca.projRange[1])/2 - adjCent.projection)/10 + Math.abs((ca.ownRange[0]+ca.ownRange[1])/2 - adjCent.ownership)/5 : 99; const dB = cb ? Math.abs((cb.projRange[0]+cb.projRange[1])/2 - adjCent.projection)/10 + Math.abs((cb.ownRange[0]+cb.ownRange[1])/2 - adjCent.ownership)/5 : 99; return dA - dB; });
  for (const [key, tc] of sortedAlloc) { const cell = regionMap.cells.get(key) as any; if (!cell) continue; const rc = candCoords.filter(c => c.projection >= cell.projRange[0] && c.projection < cell.projRange[1] && c.ownership >= cell.ownRange[0] && c.ownership < cell.ownRange[1]).sort((a, b) => precomp.candidateProjection[b.idx] - precomp.candidateProjection[a.idx]); let f = 0; for (const cand of rc) { if (f >= tc) break; const lu = precomp.candidatePool[cand.idx]; if (selH.has(lu.hash)) continue; let ok = true; for (const p of lu.players) if ((selExp.get(p.id) || 0) >= expCap) { ok = false; break; } if (!ok) continue; const ltc = new Map<string, number>(); for (const p of lu.players) if (!p.positions?.includes('P')) ltc.set(p.team, (ltc.get(p.team) || 0) + 1); let tOk = true; for (const [t, cnt] of ltc) if (cnt >= 4 && (tsc.get(t) || 0) >= maxPT) { tOk = false; break; } if (!tOk) continue; sel.push(lu); selH.add(lu.hash); for (const p of lu.players) selExp.set(p.id, (selExp.get(p.id) || 0) + 1); for (const [t, cnt] of ltc) if (cnt >= 4) tsc.set(t, (tsc.get(t) || 0) + 1); f++; } }
  // Team coverage
  const covTeams = new Map<string, number>(); for (const lu of sel) { const tc = new Map<string, number>(); for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1); for (const [t, c] of tc) if (c >= 4) covTeams.set(t, (covTeams.get(t) || 0) + 1); }
  const allT = new Set<string>(); for (const c of candCoords) for (const p of precomp.candidatePool[c.idx].players) if (p.team) allT.add(p.team);
  const minPT = Math.max(3, Math.floor(150 / allT.size * 0.6));
  for (const team of allT) { if ((covTeams.get(team) || 0) >= minPT) continue; const tc2 = candCoords.filter(c => { const lu = precomp.candidatePool[c.idx]; const tc = new Map<string, number>(); for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1); return (tc.get(team) || 0) >= 4; }); if (tc2.length < 5) continue; const s2 = tc2.sort((a, b) => precomp.candidateProjection[b.idx] - precomp.candidateProjection[a.idx]); const needed = minPT - (covTeams.get(team) || 0); let added = 0; for (const cand of s2) { if (added >= needed) break; const lu = precomp.candidatePool[cand.idx]; if (selH.has(lu.hash)) continue; let ok = true; for (const p of lu.players) if ((selExp.get(p.id) || 0) >= expCap) { ok = false; break; } if (!ok) continue; if (sel.length >= 150) { const wIdx = sel.reduce((best, lu2, idx) => lu2.projection < sel[best].projection ? idx : best, 0); const rem = sel[wIdx]; for (const p of rem.players) { const c = selExp.get(p.id) || 0; if (c > 0) selExp.set(p.id, c - 1); } selH.delete(rem.hash); sel[wIdx] = lu; } else sel.push(lu); selH.add(lu.hash); for (const p of lu.players) selExp.set(p.id, (selExp.get(p.id) || 0) + 1); added++; } }
  // Fill
  if (sel.length < 150) { const all = candCoords.sort((a, b) => precomp.candidateProjection[b.idx] - precomp.candidateProjection[a.idx]); for (const c of all) { if (sel.length >= 150) break; const lu = precomp.candidatePool[c.idx]; if (selH.has(lu.hash)) continue; let ok = true; for (const p of lu.players) if ((selExp.get(p.id) || 0) >= expCap) { ok = false; break; } if (!ok) continue; sel.push(lu); selH.add(lu.hash); for (const p of lu.players) selExp.set(p.id, (selExp.get(p.id) || 0) + 1); } }
  return sel;
}

async function main() {
  const regionMap = loadRegionMap(path.join(DIR, 'region-map-mlb-dk.json'));
  const pct = (v: number) => `${(v*100).toFixed(2)}%`;
  let md = `# Scenario Scoring Backtest — V32 vs Scenario-Weighted (7 slates)\n\n`;
  md += `| Slate | F | V32 t1 | V32 pay | Scen t1 | Scen pay | Scen stacks | Scen own |\n`;
  md += `|---|---:|---:|---:|---:|---:|---:|---:|\n`;

  let v32PaySum = 0, scenPaySum = 0, v32T1Sum = 0, scenT1Sum = 0, n = 0;

  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj), actualsPath = path.join(DIR, s.actuals), poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) continue;
    console.log(`\n=== ${s.slate} ===`);
    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);
    const nameMap = new Map<string, Player>(); for (const p of pool.players) nameMap.set(norm(p.name), p);
    const idMap = new Map<string, Player>(); for (const p of pool.players) idMap.set(p.id, p);
    const F = actuals.entries.length; const payoutTable = buildPayoutTable(F);
    const fieldLineups: Lineup[] = []; const seenH = new Set<string>(); const actualByHash = new Map<string, number>();
    for (const e of actuals.entries) { const pls: Player[] = []; let ok = true; for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); } if (!ok) continue; const hash = pls.map(p => p.id).sort().join('|'); if (seenH.has(hash)) continue; seenH.add(hash); fieldLineups.push({ players: pls, salary: pls.reduce((sm, p) => sm + p.salary, 0), projection: pls.reduce((sm, p) => sm + p.projection, 0), ownership: pls.reduce((sm, p) => sm + (p.ownership || 0), 0) / pls.length, hash }); actualByHash.set(hash, e.actualPoints); }
    const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
    const gameSet = new Set<string>(); for (const p of pool.players) gameSet.add(p.gameInfo || `${p.team}_game`);
    const numGames = gameSet.size;
    const blendedField = generateBlendedField(loaded.lineups, pool.players, config, Math.min(8000, F), 0.20);
    const selParams: SelectorParams = { ...DEFAULT_SELECTOR_PARAMS, ...getSportDefaults('mlb'), N: 150, gamma: defaultGamma(config.rosterSize), numWorlds: 1500 };
    const precomp = precomputeSlate(loaded.lineups, blendedField, pool.players, selParams, 'mlb');

    // V32
    console.log(`  V32…`);
    const v32 = runV32(precomp, regionMap, loaded.lineups, numGames);
    const v32R = scorePortfolio(v32, actuals, actualByHash, payoutTable);

    // Scenario-weighted
    console.log(`  Scenario…`);
    const scenCov = computeScenarioCoverage(blendedField);
    const scenScores = computeScenarioScores(precomp, scenCov);
    const scenPortfolio = scenarioGreedySelect(precomp, scenScores, blendedField, 150, 0.40, Math.floor(150 * 0.25));
    const scenR = scorePortfolio(scenPortfolio, actuals, actualByHash, payoutTable);

    console.log(`  V32: t1=${v32R.t1} pay=$${v32R.totalPayout.toFixed(0)} stacks=${v32R.stacks}`);
    console.log(`  Scen: t1=${scenR.t1} pay=$${scenR.totalPayout.toFixed(0)} stacks=${scenR.stacks} own=${scenR.avgOwn.toFixed(1)}%`);

    v32PaySum += v32R.totalPayout; scenPaySum += scenR.totalPayout;
    v32T1Sum += v32R.t1; scenT1Sum += scenR.t1; n++;
    md += `| ${s.slate} | ${F.toLocaleString()} | ${v32R.t1} | $${v32R.totalPayout.toFixed(0)} | ${scenR.t1} | $${scenR.totalPayout.toFixed(0)} | ${scenR.stacks} | ${scenR.avgOwn.toFixed(1)}% |\n`;
  }

  const totalFees = FEE * 150 * n;
  md += `| **TOTAL** | | **${v32T1Sum}** | **$${v32PaySum.toFixed(0)}** | **${scenT1Sum}** | **$${scenPaySum.toFixed(0)}** | | |\n\n`;
  md += `| Selector | Payout | ROI |\n|---|---:|---:|\n`;
  md += `| **V32 regions** | **$${v32PaySum.toFixed(0)}** | **${((v32PaySum/totalFees-1)*100).toFixed(1)}%** |\n`;
  md += `| Scenario-weighted | $${scenPaySum.toFixed(0)} | ${((scenPaySum/totalFees-1)*100).toFixed(1)}% |\n`;

  fs.writeFileSync(path.join(DIR, 'scenario_backtest.md'), md);
  console.log(`\n✓ Report: ${path.join(DIR, 'scenario_backtest.md')}`);
}
main();
