/**
 * V32 Structural Audit — compute the three metrics the pro analysis left uncomputed:
 *   1. Unique stack teams across 150 entries
 *   2. Avg pairwise player overlap between entries
 *   3. Bring-back rate (opposing-team hitter in game of primary stack)
 *
 * Runs V32 on each slate and measures these alongside the pro comparison.
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
import { applyEvilTwinHedging, DEFAULT_EVIL_TWIN_PARAMS } from '../selection/evil-twin';
import { loadRegionMap, computeRegionTargets } from '../analysis/region-map';

const DATA_DIR = 'C:/Users/colin/dfs opto';
const SLATES = [
  { slate: '4-6-26',  proj: '4-6-26_projections.csv',  actuals: 'dkactuals 4-6-26.csv',    pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26',  proj: '4-8-26projections.csv',   actuals: '4-8-26actuals.csv',       pool: '4-8-26sspool.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv',  actuals: '4-12-26actuals.csv',      pool: '4-12-26sspool.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv',  actuals: '4-14-26actuals.csv',      pool: '4-14-26sspool.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv',  actuals: '4-15-26actuals.csv',      pool: '4-15-26sspool.csv' },
  { slate: '4-17-26', proj: '4-17-26projections.csv',  actuals: '4-17-26actuals.csv',      pool: '4-17-26sspool.csv' },
];

function norm(n: string): string { return (n||'').toLowerCase().replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim(); }
function findBin(value: number, bins: number[]): number { for (let i = bins.length-1; i >= 0; i--) if (value >= bins[i]) return i; return 0; }

function computeStructural(lineups: Lineup[], sport: string): {
  uniqueStacks: number; avgPairOverlap: number; bringBackRate: number;
} {
  const N = lineups.length;
  const stackTeams = new Set<string>();
  let bringBacks = 0;

  for (const l of lineups) {
    const teams = new Map<string, number>();
    for (const p of l.players) {
      if (sport === 'mlb' && p.positions?.includes('P')) continue;
      teams.set(p.team, (teams.get(p.team) || 0) + 1);
    }
    let maxSt = 0, stTeam = '';
    for (const [t, c] of teams) if (c > maxSt) { maxSt = c; stTeam = t; }
    if (maxSt >= 4) stackTeams.add(stTeam);

    if (stTeam) {
      const opp = l.players.find(p => p.team === stTeam)?.opponent;
      if (opp && l.players.some(p => p.team === opp && !(sport === 'mlb' && p.positions?.includes('P')))) {
        bringBacks++;
      }
    }
  }

  // Avg pair overlap (sample 500 pairs)
  let overlapSum = 0, overlapCount = 0;
  const maxPairs = Math.min(500, (N * (N - 1)) / 2);
  let seed = 13;
  const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };
  if (N >= 2) {
    for (let p = 0; p < maxPairs; p++) {
      const i = Math.floor(rng() * N);
      let j = Math.floor(rng() * (N - 1)); if (j >= i) j++;
      const si = new Set(lineups[i].players.map(x => x.id));
      let sh = 0; for (const x of lineups[j].players) if (si.has(x.id)) sh++;
      overlapSum += sh; overlapCount++;
    }
  }

  return {
    uniqueStacks: stackTeams.size,
    avgPairOverlap: overlapCount > 0 ? overlapSum / overlapCount : 0,
    bringBackRate: N > 0 ? bringBacks / N : 0,
  };
}

async function main() {
  const regionMap = loadRegionMap('C:/Users/colin/dfs opto/region-map-mlb-dk.json');
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

  interface SlateRow {
    slate: string; entries: number;
    t1: number; t5: number; cash: number; scored: number;
    avgOwn: number; avgProj: number;
    uniqueStacks: number; avgPairOverlap: number; bringBackRate: number;
  }
  const results: SlateRow[] = [];

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

    // Build field
    const fieldLineups: Lineup[] = []; const actualByHash = new Map<string, number>(); const seenH = new Set<string>();
    for (const e of actuals.entries) {
      const pls: Player[] = []; let ok = true;
      for (const n of e.playerNames) { const p = nameMap.get(norm(n)); if (!p) { ok = false; break; } pls.push(p); }
      if (!ok) continue;
      const hash = pls.map(p => p.id).sort().join('|');
      if (seenH.has(hash)) continue; seenH.add(hash);
      fieldLineups.push({ players: pls, salary: pls.reduce((sm, p) => sm + p.salary, 0), projection: pls.reduce((sm, p) => sm + p.projection, 0), ownership: pls.reduce((sm, p) => sm + (p.ownership || 0), 0) / pls.length, hash });
      actualByHash.set(hash, e.actualPoints);
    }

    const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
    const selParams: SelectorParams = { ...DEFAULT_SELECTOR_PARAMS, ...getSportDefaults('mlb'), N: 150, gamma: defaultGamma(config.rosterSize), numWorlds: 1500 };
    const precomp = precomputeSlate(loaded.lineups, fieldLineups, pool.players, selParams, 'mlb');
    const ctx = buildV31Context(precomp, fieldLineups, pool.players);

    // Feasibility filter
    const poolCoords = loaded.lineups.map(l => ({ projection: l.projection, ownership: l.players.reduce((sm: number, p: Player) => sm + (p.ownership || 0), 0) / l.players.length }));
    const poolDist = new Map<string, number>();
    for (const c of poolCoords) { const pB = findBin(c.projection, regionMap.projBins); const oB = findBin(c.ownership, regionMap.ownBins); poolDist.set(`${pB}_${oB}`, (poolDist.get(`${pB}_${oB}`) || 0) + 1); }
    const feasibleCells = new Map(regionMap.cells);
    for (const [key] of feasibleCells) if ((poolDist.get(key) || 0) < 5) feasibleCells.delete(key);
    const feasTargets = computeRegionTargets({ ...regionMap, cells: feasibleCells }, 150, 'weighted_lift', 1.0);

    const candCoords = Array.from({ length: precomp.C }, (_, c) => ({
      idx: c, projection: precomp.candidatePool[c].projection,
      ownership: precomp.candidatePool[c].players.reduce((sm: number, p: Player) => sm + (p.ownership || 0), 0) / precomp.candidatePool[c].players.length,
    }));
    const v32Sel: Lineup[] = []; const v32H = new Set<string>(); const v32Exp = new Map<string, number>();
    const expCap = Math.ceil(0.40 * 150);
    const sortedAlloc = [...feasTargets.allocations.entries()].sort((a, b) => {
      const ca = regionMap.cells.get(a[0]), cb = regionMap.cells.get(b[0]);
      const dA = ca ? Math.abs((ca.projRange[0]+ca.projRange[1])/2 - regionMap.top1Centroid.projection)/10 + Math.abs((ca.ownRange[0]+ca.ownRange[1])/2 - regionMap.top1Centroid.ownership)/5 : 99;
      const dB = cb ? Math.abs((cb.projRange[0]+cb.projRange[1])/2 - regionMap.top1Centroid.projection)/10 + Math.abs((cb.ownRange[0]+cb.ownRange[1])/2 - regionMap.top1Centroid.ownership)/5 : 99;
      return dA - dB;
    });
    for (const [key, tc] of sortedAlloc) {
      const cell = regionMap.cells.get(key); if (!cell) continue;
      const rc = candCoords.filter(c => c.projection >= cell.projRange[0] && c.projection < cell.projRange[1] && c.ownership >= cell.ownRange[0] && c.ownership < cell.ownRange[1])
        .map(c => ({ ...c, score: v31Score(c.idx, ctx, precomp, 0.3, 0.3) })).sort((a, b) => b.score - a.score);
      let filled = 0;
      for (const cand of rc) { if (filled >= tc) break; const lu = precomp.candidatePool[cand.idx]; if (v32H.has(lu.hash)) continue;
        let ok = true; for (const p of lu.players) if ((v32Exp.get(p.id) || 0) >= expCap) { ok = false; break; } if (!ok) continue;
        v32Sel.push(lu); v32H.add(lu.hash); for (const p of lu.players) v32Exp.set(p.id, (v32Exp.get(p.id) || 0) + 1); filled++;
      }
    }
    if (v32Sel.length < 150) {
      const all32 = candCoords.map(c => ({ ...c, score: v31Score(c.idx, ctx, precomp, 0.3, 0.3) })).sort((a, b) => b.score - a.score);
      for (const c of all32) { if (v32Sel.length >= 150) break; const lu = precomp.candidatePool[c.idx]; if (v32H.has(lu.hash)) continue;
        let ok = true; for (const p of lu.players) if ((v32Exp.get(p.id) || 0) >= expCap) { ok = false; break; } if (!ok) continue;
        v32Sel.push(lu); v32H.add(lu.hash); for (const p of lu.players) v32Exp.set(p.id, (v32Exp.get(p.id) || 0) + 1);
      }
    }
    const twin = applyEvilTwinHedging(v32Sel, precomp, DEFAULT_EVIL_TWIN_PARAMS);
    const v32F = twin.portfolio;

    // Score
    let t1 = 0, t5 = 0, cash = 0, scored = 0;
    for (const lu of v32F) {
      const fa = actualByHash.get(lu.hash); let a: number | null = fa !== undefined ? fa : null;
      if (a === null) { let t = 0, miss = false; for (const p of lu.players) { const r = actuals.playerActualsByName.get(norm(p.name)); if (!r) { miss = true; break; } t += r.fpts; } if (!miss) a = t; }
      if (a === null) continue; scored++;
      if (a >= thresholds.top1) t1++; if (a >= thresholds.top5) t5++; if (a >= thresholds.cash) cash++;
    }

    // Structural metrics
    const structural = computeStructural(v32F, 'mlb');
    let sOwn = 0, sProj = 0;
    for (const l of v32F) { sOwn += l.players.reduce((sm: number, p: Player) => sm + (p.ownership || 0), 0) / l.players.length; sProj += l.projection; }

    console.log(`  V32: t1=${t1} stacks=${structural.uniqueStacks} overlap=${structural.avgPairOverlap.toFixed(1)} bb=${pct(structural.bringBackRate)}`);

    results.push({
      slate: s.slate, entries: F, t1, t5, cash, scored,
      avgOwn: sOwn / v32F.length, avgProj: sProj / v32F.length,
      ...structural,
    });
  }

  // Report
  let md = `# V32 Structural Audit — 6 MLB Slates\n\n`;
  md += `## Per-Slate V32 Structural Metrics\n\n`;
  md += `| Slate | Entries | Top1% | Top5% | Cash% | AvgOwn | AvgProj | **Stacks** | **Overlap** | **BB%** |\n`;
  md += `|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n`;
  let sumStacks = 0, sumOverlap = 0, sumBB = 0, sumT1 = 0, sumN = 0, n = 0;
  for (const r of results) {
    sumStacks += r.uniqueStacks; sumOverlap += r.avgPairOverlap; sumBB += r.bringBackRate;
    sumT1 += r.t1; sumN += r.scored; n++;
    md += `| ${r.slate} | ${r.entries.toLocaleString()} | ${pct(r.scored > 0 ? r.t1/r.scored : 0)} (${r.t1}) | ${pct(r.scored > 0 ? r.t5/r.scored : 0)} | ${pct(r.scored > 0 ? r.cash/r.scored : 0)} | ${r.avgOwn.toFixed(1)}% | ${r.avgProj.toFixed(1)} | **${r.uniqueStacks}** | **${r.avgPairOverlap.toFixed(1)}** | **${pct(r.bringBackRate)}** |\n`;
  }
  md += `| **MEAN** | | **${pct(sumT1/sumN)}** | | | | | **${(sumStacks/n).toFixed(1)}** | **${(sumOverlap/n).toFixed(1)}** | **${pct(sumBB/n)}** |\n\n`;

  md += `## Comparison: V32 vs Top-10 Pros\n\n`;
  md += `| Metric | Top-10 Pros | **V32** | Gap | Verdict |\n`;
  md += `|---|---:|---:|---:|---|\n`;
  md += `| Top-1% rate | 2.30% | ${pct(sumT1/sumN)} | ${((sumT1/sumN - 0.023) * 100).toFixed(2)}pp | ${sumT1/sumN >= 0.020 ? '✓ MATCH' : '✗ below'} |\n`;
  md += `| Unique stacks | 12.6 | ${(sumStacks/n).toFixed(1)} | ${(sumStacks/n - 12.6).toFixed(1)} | ${sumStacks/n >= 10 ? '✓ adequate' : '✗ too narrow'} |\n`;
  md += `| Avg pair overlap | 2.1 | ${(sumOverlap/n).toFixed(1)} | ${(sumOverlap/n - 2.1).toFixed(1)} | ${sumOverlap/n <= 2.5 ? '✓ diverse' : '✗ too clustered'} |\n`;
  md += `| Bring-back % | 25.2% | ${pct(sumBB/n)} | ${((sumBB/n - 0.252) * 100).toFixed(1)}pp | ${sumBB/n >= 0.20 ? '✓ hedging' : '✗ not enough hedging'} |\n\n`;

  md += `## Interpretation\n\n`;
  const isStructuralMatch = sumStacks/n >= 10 && sumOverlap/n <= 2.5 && sumBB/n >= 0.20;
  if (isStructuralMatch) {
    md += `**V32 structurally matches pros.** The top-1% rate is durable — it's achieved through the same stack diversity, lineup uniqueness, and game-script hedging that pros use. The remaining gap to skijmb (4.00%) is genuinely single-player selection skill.\n`;
  } else {
    md += `**V32 has structural gaps.** The top-1% rate may be fragile. `;
    if (sumStacks/n < 10) md += `Stack diversity (${(sumStacks/n).toFixed(1)}) is below pro level (12.6). `;
    if (sumOverlap/n > 2.5) md += `Pair overlap (${(sumOverlap/n).toFixed(1)}) is above pro level (2.1) — entries are too similar. `;
    if (sumBB/n < 0.20) md += `Bring-back rate (${pct(sumBB/n)}) is below pro level (25.2%) — not enough game-script hedging. `;
    md += `\n`;
  }

  const outPath = path.join(DATA_DIR, 'v32_structural_audit.md');
  fs.writeFileSync(outPath, md);
  console.log(`\n✓ Report: ${outPath}`);
}

main();
