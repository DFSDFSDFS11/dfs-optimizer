/**
 * λ_sigma sweep: does higher σ_{δ,G} weighting produce natural team diversity
 * without the team coverage heuristic?
 *
 * Test: λ_sigma = 0.30 (current), 0.40, 0.45 — all with team coverage OFF,
 * blended field, on all 7 historical slates.
 *
 * Measure: unique stacks, team coverage of opposing-pitcher stacks, top-1% rate.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals } from '../parser';
import { getContestConfig } from '../rules';
import { DEFAULT_SELECTOR_PARAMS, SelectorParams, defaultGamma, getSportDefaults, precomputeSlate } from '../selection/algorithm7-selector';
import { buildV31Context, v31Score } from '../selection/v31-objective';
import { loadRegionMap, computeRegionTargets } from '../analysis/region-map';
import { generateBlendedField } from '../opponent/field-generator';

const DATA_DIR = 'C:/Users/colin/dfs opto';
const SLATES = [
  { slate: '4-6-26', proj: '4-6-26_projections.csv', actuals: 'dkactuals 4-6-26.csv', pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26', proj: '4-8-26projections.csv', actuals: '4-8-26actuals.csv', pool: '4-8-26sspool.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv', actuals: '4-12-26actuals.csv', pool: '4-12-26sspool.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv', actuals: '4-14-26actuals.csv', pool: '4-14-26sspool.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv', actuals: '4-15-26actuals.csv', pool: '4-15-26sspool.csv' },
  { slate: '4-17-26', proj: '4-17-26projections.csv', actuals: '4-17-26actuals.csv', pool: '4-17-26sspool.csv' },
  { slate: '4-18-26', proj: '4-18-26projections.csv', actuals: '4-18-26actuals.csv', pool: '4-18-26sspool.csv' },
];
const LAMBDA_SIGMA_VALUES = [0.30, 0.40, 0.45];
const LAMBDA_VAR = 0.3;

function norm(n: string): string { return (n||'').toLowerCase().replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim(); }
function findBin(v: number, bins: number[]): number { for (let i = bins.length-1; i >= 0; i--) if (v >= bins[i]) return i; return 0; }

function runV32NoTeamCov(
  poolLineups: Lineup[], allPlayers: Player[], config: any,
  regionMap: any, N: number, lambdaSigma: number,
  fieldLineups: Lineup[], selParams: SelectorParams,
): Lineup[] {
  const precomp = precomputeSlate(poolLineups, fieldLineups, allPlayers, selParams, 'mlb');
  const ctx = buildV31Context(precomp, fieldLineups, allPlayers);
  const poolCoords = poolLineups.map(l => ({ projection: l.projection, ownership: l.players.reduce((s: number, p: Player) => s + (p.ownership || 0), 0) / l.players.length }));
  const poolDist = new Map<string, number>();
  for (const c of poolCoords) { const pB = findBin(c.projection, regionMap.projBins); const oB = findBin(c.ownership, regionMap.ownBins); poolDist.set(`${pB}_${oB}`, (poolDist.get(`${pB}_${oB}`) || 0) + 1); }
  const feasCells = new Map<string, any>(regionMap.cells);
  for (const [k] of feasCells) if ((poolDist.get(k as string) || 0) < 5) feasCells.delete(k);

  // Dynamic centroid
  const poolProjSorted = poolCoords.map(c => c.projection).sort((a, b) => a - b);
  const poolP75 = poolProjSorted[Math.floor(poolProjSorted.length * 0.75)];
  const projShift = poolP75 - regionMap.top1Centroid.projection;
  const adjustedCentroid = { projection: regionMap.top1Centroid.projection + projShift, ownership: regionMap.top1Centroid.ownership };

  // Proximity-weighted allocation
  const weightedCells = new Map<string, any>();
  for (const [key, cell] of feasCells) {
    const midP = (cell.projRange[0] + cell.projRange[1]) / 2;
    const midO = (cell.ownRange[0] + cell.ownRange[1]) / 2;
    const dist = Math.sqrt(Math.pow((midP - adjustedCentroid.projection) / 10, 2) + Math.pow((midO - adjustedCentroid.ownership) / 5, 2));
    const pw = 1 / (1 + dist);
    weightedCells.set(key, { ...cell, top1Lift: cell.top1Lift * pw * pw });
  }
  const targets = computeRegionTargets({ ...regionMap, cells: weightedCells }, N, 'weighted_lift', 0.1);

  const candCoords = Array.from({ length: precomp.C }, (_, c) => ({
    idx: c, projection: precomp.candidatePool[c].projection,
    ownership: precomp.candidatePool[c].players.reduce((s: number, p: Player) => s + (p.ownership || 0), 0) / precomp.candidatePool[c].players.length,
  }));

  const sel: Lineup[] = []; const selH = new Set<string>(); const selExp = new Map<string, number>();
  const expCap = Math.ceil(0.40 * N);
  const sortedAlloc = [...targets.allocations.entries()].sort((a, b) => {
    const ca = regionMap.cells.get(a[0]), cb = regionMap.cells.get(b[0]);
    const dA = ca ? Math.abs((ca.projRange[0]+ca.projRange[1])/2 - adjustedCentroid.projection)/10 + Math.abs((ca.ownRange[0]+ca.ownRange[1])/2 - adjustedCentroid.ownership)/5 : 99;
    const dB = cb ? Math.abs((cb.projRange[0]+cb.projRange[1])/2 - adjustedCentroid.projection)/10 + Math.abs((cb.ownRange[0]+cb.ownRange[1])/2 - adjustedCentroid.ownership)/5 : 99;
    return dA - dB;
  });
  for (const [key, tc] of sortedAlloc) {
    const cell = regionMap.cells.get(key); if (!cell) continue;
    const rc = candCoords.filter(c => c.projection >= cell.projRange[0] && c.projection < cell.projRange[1] && c.ownership >= cell.ownRange[0] && c.ownership < cell.ownRange[1])
      .map(c => ({ ...c, score: v31Score(c.idx, ctx, precomp, LAMBDA_VAR, lambdaSigma) })).sort((a, b) => b.score - a.score);
    let filled = 0;
    for (const cand of rc) { if (filled >= tc) break; const lu = precomp.candidatePool[cand.idx]; if (selH.has(lu.hash)) continue;
      let ok = true; for (const p of lu.players) if ((selExp.get(p.id) || 0) >= expCap) { ok = false; break; } if (!ok) continue;
      sel.push(lu); selH.add(lu.hash); for (const p of lu.players) selExp.set(p.id, (selExp.get(p.id) || 0) + 1); filled++;
    }
  }
  if (sel.length < N) {
    const all = candCoords.map(c => ({ ...c, score: v31Score(c.idx, ctx, precomp, LAMBDA_VAR, lambdaSigma) })).sort((a, b) => b.score - a.score);
    for (const c of all) { if (sel.length >= N) break; const lu = precomp.candidatePool[c.idx]; if (selH.has(lu.hash)) continue;
      let ok = true; for (const p of lu.players) if ((selExp.get(p.id) || 0) >= expCap) { ok = false; break; } if (!ok) continue;
      sel.push(lu); selH.add(lu.hash); for (const p of lu.players) selExp.set(p.id, (selExp.get(p.id) || 0) + 1);
    }
  }
  return sel;
}

async function main() {
  const regionMap = loadRegionMap('C:/Users/colin/dfs opto/region-map-mlb-dk.json');
  const pct = (v: number) => `${(v*100).toFixed(2)}%`;

  const results: Array<{ ls: number; slates: Array<{ slate: string; t1: number; scored: number; stacks: number; avgProj: number; avgOwn: number }> }> = [];

  for (const ls of LAMBDA_SIGMA_VALUES) {
    console.log(`\n======== λσ = ${ls} (no team coverage heuristic) ========`);
    const slateResults: typeof results[0]['slates'] = [];

    for (const s of SLATES) {
      const projPath = path.join(DATA_DIR, s.proj);
      const actualsPath = path.join(DATA_DIR, s.actuals);
      const poolPath = path.join(DATA_DIR, s.pool);
      if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) continue;

      const pr = parseCSVFile(projPath, 'mlb', true);
      const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
      const pool = buildPlayerPool(pr.players, pr.detectedContestType);
      const actuals = parseContestActuals(actualsPath, config);
      const nameMap = new Map<string, Player>(); for (const p of pool.players) nameMap.set(norm(p.name), p);
      const idMap = new Map<string, Player>(); for (const p of pool.players) idMap.set(p.id, p);

      const F = actuals.entries.length;
      const sorted = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
      const top1 = sorted[Math.max(0, Math.floor(F * 0.01) - 1)] || 0;

      const fieldLineups: Lineup[] = []; const seenH = new Set<string>(); const actualByHash = new Map<string, number>();
      for (const e of actuals.entries) { const pls: Player[] = []; let ok = true;
        for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
        if (!ok) continue; const hash = pls.map(p => p.id).sort().join('|');
        if (seenH.has(hash)) continue; seenH.add(hash);
        fieldLineups.push({ players: pls, salary: pls.reduce((sm, p) => sm + p.salary, 0), projection: pls.reduce((sm, p) => sm + p.projection, 0), ownership: pls.reduce((sm, p) => sm + (p.ownership || 0), 0) / pls.length, hash });
        actualByHash.set(hash, e.actualPoints);
      }

      const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
      const synthField = generateBlendedField(loaded.lineups, pool.players, config, Math.min(8000, F), 0.20);
      const selParams: SelectorParams = { ...DEFAULT_SELECTOR_PARAMS, ...getSportDefaults('mlb'), N: 150, gamma: defaultGamma(config.rosterSize), numWorlds: 1500 };

      const portfolio = runV32NoTeamCov(loaded.lineups, pool.players, config, regionMap, 150, ls, synthField, selParams);

      // Score + team stacks
      let t1 = 0, scored = 0;
      for (const lu of portfolio) {
        const fa = actualByHash.get(lu.hash); let a: number | null = fa !== undefined ? fa : null;
        if (a === null) { let t = 0, miss = false; for (const p of lu.players) { const r = actuals.playerActualsByName.get(norm(p.name)); if (!r) { miss = true; break; } t += r.fpts; } if (!miss) a = t; }
        if (a === null) continue; scored++; if (a >= top1) t1++;
      }
      const stackTeams = new Set<string>();
      for (const lu of portfolio) {
        const tc = new Map<string, number>(); for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
        for (const [t, c] of tc) if (c >= 4) stackTeams.add(t);
      }
      let sProj = 0, sOwn = 0;
      for (const l of portfolio) { sProj += l.projection; sOwn += l.players.reduce((s: number, p: Player) => s + (p.ownership || 0), 0) / l.players.length; }

      console.log(`  ${s.slate}: t1=${t1}/${scored} stacks=${stackTeams.size} proj=${(sProj/portfolio.length).toFixed(1)} own=${(sOwn/portfolio.length).toFixed(1)}%`);
      slateResults.push({ slate: s.slate, t1, scored, stacks: stackTeams.size, avgProj: sProj / portfolio.length, avgOwn: sOwn / portfolio.length });
    }
    results.push({ ls, slates: slateResults });
  }

  let md = `# λ_sigma Sweep with Blended Field (NO team coverage heuristic)\n\n`;
  md += `| λσ | Mean Top-1% | Mean Stacks | Mean Proj | Mean Own |\n|---:|---:|---:|---:|---:|\n`;
  for (const r of results) {
    const t1Avg = r.slates.reduce((s, sr) => s + (sr.scored > 0 ? sr.t1 / sr.scored : 0), 0) / r.slates.length;
    const stackAvg = r.slates.reduce((s, sr) => s + sr.stacks, 0) / r.slates.length;
    const projAvg = r.slates.reduce((s, sr) => s + sr.avgProj, 0) / r.slates.length;
    const ownAvg = r.slates.reduce((s, sr) => s + sr.avgOwn, 0) / r.slates.length;
    md += `| ${r.ls} | **${pct(t1Avg)}** | ${stackAvg.toFixed(1)} | ${projAvg.toFixed(1)} | ${ownAvg.toFixed(1)}% |\n`;
  }
  md += `\n## Per-Slate\n\n| Slate |`;
  for (const r of results) md += ` λσ=${r.ls} t1 | stacks |`;
  md += `\n|---|`; for (const _ of results) md += `---:|---:|`; md += `\n`;
  for (let si = 0; si < SLATES.length; si++) {
    md += `| ${SLATES[si].slate} |`;
    for (const r of results) { const sr = r.slates[si]; if (sr) md += ` ${sr.t1}/${sr.scored} | ${sr.stacks} |`; else md += ` — | — |`; }
    md += `\n`;
  }
  fs.writeFileSync(path.join(DATA_DIR, 'sigma_vs_teamcov.md'), md);
  console.log(`\n✓ Report: ${path.join(DATA_DIR, 'sigma_vs_teamcov.md')}`);
}
main();
