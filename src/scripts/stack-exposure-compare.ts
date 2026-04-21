/**
 * Quick comparison: V32 vs Scenario team stack exposure + ownership per slate.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals } from '../parser';
import { getContestConfig } from '../rules';
import { DEFAULT_SELECTOR_PARAMS, SelectorParams, defaultGamma, getSportDefaults, precomputeSlate } from '../selection/algorithm7-selector';
import { computeScenarioCoverage, computeScenarioScores, scenarioGreedySelect } from '../selection/scenario-scoring';
import { generateBlendedField } from '../opponent/field-generator';
import { loadRegionMap, computeRegionTargets } from '../analysis/region-map';

const DIR = 'C:/Users/colin/dfs opto';
const norm = (n: string) => (n||'').toLowerCase().replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim();
const findBin = (v: number, bins: number[]) => { for (let i = bins.length-1; i >= 0; i--) if (v >= bins[i]) return i; return 0; };

const SLATES = [
  { slate: '4-6-26', proj: '4-6-26_projections.csv', actuals: 'dkactuals 4-6-26.csv', pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26', proj: '4-8-26projections.csv', actuals: '4-8-26actuals.csv', pool: '4-8-26sspool.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv', actuals: '4-14-26actuals.csv', pool: '4-14-26sspool.csv' },
  { slate: '4-18-26', proj: '4-18-26projections.csv', actuals: '4-18-26actuals.csv', pool: '4-18-26sspool.csv' },
];

async function main() {
  const regionMap = loadRegionMap(path.join(DIR, 'region-map-mlb-dk.json'));

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
    const F = actuals.entries.length;
    const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
    const gameSet = new Set<string>(); for (const p of pool.players) gameSet.add(p.gameInfo || `${p.team}_game`);
    const numGames = gameSet.size;
    const isSmallSlate = numGames <= 4;
    const blendedField = generateBlendedField(loaded.lineups, pool.players, config, Math.min(8000, F), 0.20);
    const selParams: SelectorParams = { ...DEFAULT_SELECTOR_PARAMS, ...getSportDefaults('mlb'), N: 150, gamma: defaultGamma(config.rosterSize), numWorlds: 1500 };
    const precomp = precomputeSlate(loaded.lineups, blendedField, pool.players, selParams, 'mlb');

    // V32
    const poolCoords = loaded.lineups.map(l => ({ projection: l.projection, ownership: l.players.reduce((s: number, p: Player) => s + (p.ownership || 0), 0) / l.players.length }));
    const poolDist = new Map<string, number>(); for (const c of poolCoords) { const pB = findBin(c.projection, regionMap.projBins); const oB = findBin(c.ownership, regionMap.ownBins); poolDist.set(`${pB}_${oB}`, (poolDist.get(`${pB}_${oB}`) || 0) + 1); }
    const feasCells = new Map<string, any>(regionMap.cells); for (const [k] of feasCells) if ((poolDist.get(k as string) || 0) < 5) feasCells.delete(k);
    const pps = poolCoords.map(c => c.projection).sort((a, b) => a - b);
    const adjCent = { projection: regionMap.top1Centroid.projection + (pps[Math.floor(pps.length * 0.75)] - regionMap.top1Centroid.projection), ownership: regionMap.top1Centroid.ownership };
    const wCells = new Map<string, any>(); for (const [key, cell] of feasCells) { const d = Math.sqrt(Math.pow(((cell.projRange[0]+cell.projRange[1])/2-adjCent.projection)/10, 2) + Math.pow(((cell.ownRange[0]+cell.ownRange[1])/2-adjCent.ownership)/5, 2)); wCells.set(key, { ...cell, top1Lift: cell.top1Lift / (1+d) / (1+d) }); }
    const targets = computeRegionTargets({ ...regionMap, cells: wCells }, 150, 'weighted_lift', 0.1);
    const candCoords = Array.from({ length: precomp.C }, (_, c) => ({ idx: c, projection: precomp.candidatePool[c].projection, ownership: precomp.candidatePool[c].players.reduce((s: number, p: Player) => s + (p.ownership || 0), 0) / precomp.candidatePool[c].players.length }));
    const v32Sel: Lineup[] = []; const v32H = new Set<string>(); const v32Exp = new Map<string, number>(); const v32tsc = new Map<string, number>();
    const expCap = Math.ceil((isSmallSlate ? 0.50 : 0.35) * 150); const maxPT = Math.floor(150 * 0.25);
    const sortedAlloc = [...targets.allocations.entries()].sort((a, b) => { const ca = regionMap.cells.get(a[0]) as any, cb = regionMap.cells.get(b[0]) as any; const dA = ca ? Math.abs((ca.projRange[0]+ca.projRange[1])/2 - adjCent.projection)/10 + Math.abs((ca.ownRange[0]+ca.ownRange[1])/2 - adjCent.ownership)/5 : 99; const dB = cb ? Math.abs((cb.projRange[0]+cb.projRange[1])/2 - adjCent.projection)/10 + Math.abs((cb.ownRange[0]+cb.ownRange[1])/2 - adjCent.ownership)/5 : 99; return dA - dB; });
    for (const [key, tc] of sortedAlloc) { const cell = regionMap.cells.get(key) as any; if (!cell) continue; const rc = candCoords.filter(c => c.projection >= cell.projRange[0] && c.projection < cell.projRange[1] && c.ownership >= cell.ownRange[0] && c.ownership < cell.ownRange[1]).sort((a, b) => precomp.candidateProjection[b.idx] - precomp.candidateProjection[a.idx]); let f = 0; for (const cand of rc) { if (f >= tc) break; const lu = precomp.candidatePool[cand.idx]; if (v32H.has(lu.hash)) continue; let ok = true; for (const p of lu.players) if ((v32Exp.get(p.id) || 0) >= expCap) { ok = false; break; } if (!ok) continue; const ltc = new Map<string, number>(); for (const p of lu.players) if (!p.positions?.includes('P')) ltc.set(p.team, (ltc.get(p.team) || 0) + 1); let tOk = true; for (const [t, cnt] of ltc) if (cnt >= 4 && (v32tsc.get(t) || 0) >= maxPT) { tOk = false; break; } if (!tOk) continue; v32Sel.push(lu); v32H.add(lu.hash); for (const p of lu.players) v32Exp.set(p.id, (v32Exp.get(p.id) || 0) + 1); for (const [t, cnt] of ltc) if (cnt >= 4) v32tsc.set(t, (v32tsc.get(t) || 0) + 1); f++; } }

    // Scenario
    const scenCov = computeScenarioCoverage(blendedField);
    const scenScores = computeScenarioScores(precomp, scenCov);
    const scenSel = scenarioGreedySelect(precomp, scenScores, blendedField, 150, 0.40, maxPT);

    // Field stacks
    const fieldStacks = new Map<string, number>();
    for (const e of actuals.entries) { const pls: Player[] = []; let ok = true; for (const n of e.playerNames) { const p = nameMap.get(norm(n)); if (!p) { ok = false; break; } pls.push(p); } if (!ok) continue; const tc = new Map<string, number>(); for (const p of pls) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1); for (const [t, c] of tc) if (c >= 4) fieldStacks.set(t, (fieldStacks.get(t) || 0) + 1); }

    // Stats
    const getStacks = (portfolio: Lineup[]) => { const ts = new Map<string, number>(); let sOwn = 0, sProj = 0; for (const lu of portfolio) { sOwn += lu.players.reduce((s: number, p: Player) => s + (p.ownership || 0), 0) / lu.players.length; sProj += lu.projection; const tc = new Map<string, number>(); for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1); for (const [t, c] of tc) if (c >= 4) ts.set(t, (ts.get(t) || 0) + 1); } return { ts, avgOwn: sOwn / portfolio.length, avgProj: sProj / portfolio.length, N: portfolio.length }; };

    const v32S = getStacks(v32Sel), scenS = getStacks(scenSel);
    console.log(`  AvgOwn:  V32=${v32S.avgOwn.toFixed(1)}%  Scen=${scenS.avgOwn.toFixed(1)}%`);
    console.log(`  AvgProj: V32=${v32S.avgProj.toFixed(1)}  Scen=${scenS.avgProj.toFixed(1)}`);
    console.log('');
    console.log('  ' + 'Team'.padEnd(6) + 'V32%'.padStart(7) + '  Scen%'.padStart(7) + '  Field%'.padStart(8) + '  Scen/Field');

    const allTeams = new Set([...v32S.ts.keys(), ...scenS.ts.keys(), ...fieldStacks.keys()]);
    const rows: any[] = [];
    for (const t of allTeams) {
      const v32Pct = (v32S.ts.get(t) || 0) / v32S.N * 100;
      const scenPct = (scenS.ts.get(t) || 0) / scenS.N * 100;
      const fieldPct = (fieldStacks.get(t) || 0) / F * 100;
      const edge = fieldPct > 0.1 ? (scenPct / fieldPct).toFixed(1) + 'x' : 'n/a';
      rows.push({ t, v32Pct, scenPct, fieldPct, edge });
    }
    rows.sort((a: any, b: any) => b.scenPct - a.scenPct);
    for (const r of rows) {
      if (r.v32Pct < 0.5 && r.scenPct < 0.5) continue;
      console.log('  ' + r.t.padEnd(6) + r.v32Pct.toFixed(1).padStart(6) + '%  ' + r.scenPct.toFixed(1).padStart(6) + '%  ' + r.fieldPct.toFixed(1).padStart(7) + '%  ' + r.edge);
    }
  }
}
main();
