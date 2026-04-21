/**
 * Deep Pro Analysis — every 150-entry pro across every MLB slate.
 *
 * For each pro and each slate: top-1/5/10/cash rates, avg actual, avg ownership,
 * max exposure, unique stack teams, bring-back rate, avg projection, best lineup profile.
 *
 * Cross-slate aggregation: consistency, which pros beat us and by how much,
 * structural differences (own, stacks, exposure) that explain the gap.
 *
 * Also runs V32 on each slate for direct comparison.
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
function extractUser(entryName: string): string { return (entryName||'').replace(/\s*\([^)]*\)\s*$/,'').trim(); }

interface ProSlateStats {
  slate: string;
  entries: number;
  top1Hits: number; top1Rate: number;
  top5Hits: number; top5Rate: number;
  top10Hits: number; top10Rate: number;
  cashHits: number; cashRate: number;
  avgActual: number;
  bestActual: number;
  bestRank: number;
  avgProjection: number;
  avgOwnership: number;
  maxExposure: number;
  maxExpPlayer: string;
  uniqueStackTeams: number;
  bringBackRate: number;
  avgPairOverlap: number;
  topPlayerExposures: Array<{ name: string; exposure: number; fieldOwn: number }>;
}

interface V32SlateStats {
  slate: string;
  top1Hits: number; top1Rate: number;
  top5Hits: number; top5Rate: number;
  cashHits: number; cashRate: number;
  avgActual: number;
  avgProjection: number;
  avgOwnership: number;
  distToCentroid: number;
}

async function main() {
  const regionMap = loadRegionMap('C:/Users/colin/dfs opto/region-map-mlb-dk.json');

  // Collect all per-slate pro data
  const allProStats = new Map<string, ProSlateStats[]>(); // username → stats per slate
  const v32Stats: V32SlateStats[] = [];

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
    const thresholds = { top1: tAt(0.01), top5: tAt(0.05), top10: tAt(0.10), cash: tAt(0.20) };

    // Group entries by username
    const byUser = new Map<string, ContestEntry[]>();
    for (const e of actuals.entries) {
      const u = extractUser(e.entryName);
      if (!u) continue;
      const arr = byUser.get(u);
      if (arr) arr.push(e); else byUser.set(u, [e]);
    }

    // Analyze every 150-entry pro
    for (const [username, entries] of byUser) {
      if (entries.length < 140) continue; // allow 140-150

      const lineups: Lineup[] = [];
      let sumActual = 0, bestActual = 0, bestRank = F;
      let t1 = 0, t5 = 0, t10 = 0, cash = 0;

      for (const e of entries) {
        const pls: Player[] = []; let ok = true;
        for (const n of e.playerNames) { const p = nameMap.get(norm(n)); if (!p) { ok = false; break; } pls.push(p); }
        if (!ok) continue;
        const sal = pls.reduce((sm, p) => sm + p.salary, 0);
        const proj = pls.reduce((sm, p) => sm + p.projection, 0);
        const own = pls.reduce((sm, p) => sm + (p.ownership || 0), 0) / pls.length;
        const hash = pls.map(p => p.id).sort().join('|');
        lineups.push({ players: pls, salary: sal, projection: proj, ownership: own, hash });
        sumActual += e.actualPoints;
        if (e.actualPoints > bestActual) { bestActual = e.actualPoints; bestRank = e.rank; }
        if (e.actualPoints >= thresholds.top1) t1++;
        if (e.actualPoints >= thresholds.top5) t5++;
        if (e.actualPoints >= thresholds.top10) t10++;
        if (e.actualPoints >= thresholds.cash) cash++;
      }

      if (lineups.length < 50) continue;
      const N = lineups.length;

      // Exposure
      const expCount = new Map<string, number>();
      for (const l of lineups) for (const p of l.players) expCount.set(p.id, (expCount.get(p.id) || 0) + 1);
      let maxExp = 0, maxExpId = '';
      for (const [id, c] of expCount) { const f = c / N; if (f > maxExp) { maxExp = f; maxExpId = id; } }
      const topExposures = [...expCount.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([id, c]) => {
          const p = idMap.get(id) || pool.players.find(x => x.id === id);
          return { name: p?.name || id, exposure: c / N, fieldOwn: (p?.ownership || 0) / 100 };
        });

      // Stack teams + bring-back
      const stackTeams = new Set<string>();
      let bringBacks = 0;
      for (const l of lineups) {
        const teams = new Map<string, number>();
        for (const p of l.players) if (!p.positions?.includes('P')) teams.set(p.team, (teams.get(p.team) || 0) + 1);
        let maxSt = 0, stTeam = '';
        for (const [t, c] of teams) if (c > maxSt) { maxSt = c; stTeam = t; }
        if (maxSt >= 4) stackTeams.add(stTeam);
        // Bring-back
        if (stTeam) {
          const opp = l.players.find(p => p.team === stTeam)?.opponent;
          if (opp && l.players.some(p => p.team === opp && !p.positions?.includes('P'))) bringBacks++;
        }
      }

      // Pairwise overlap (sample 200 pairs)
      let overlapSum = 0, overlapCount = 0;
      const maxPairs = Math.min(200, (N * (N - 1)) / 2);
      let seed = 7;
      const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };
      for (let p = 0; p < maxPairs; p++) {
        const i = Math.floor(rng() * N);
        let j = Math.floor(rng() * (N - 1)); if (j >= i) j++;
        const si = new Set(lineups[i].players.map(x => x.id));
        let sh = 0; for (const x of lineups[j].players) if (si.has(x.id)) sh++;
        overlapSum += sh; overlapCount++;
      }

      const avgProj = lineups.reduce((sm, l) => sm + l.projection, 0) / N;
      const avgOwn = lineups.reduce((sm, l) => sm + l.ownership, 0) / N;

      const stats: ProSlateStats = {
        slate: s.slate, entries: N,
        top1Hits: t1, top1Rate: t1 / N,
        top5Hits: t5, top5Rate: t5 / N,
        top10Hits: t10, top10Rate: t10 / N,
        cashHits: cash, cashRate: cash / N,
        avgActual: sumActual / N, bestActual, bestRank,
        avgProjection: avgProj, avgOwnership: avgOwn,
        maxExposure: maxExp, maxExpPlayer: idMap.get(maxExpId)?.name || maxExpId,
        uniqueStackTeams: stackTeams.size,
        bringBackRate: N > 0 ? bringBacks / N : 0,
        avgPairOverlap: overlapCount > 0 ? overlapSum / overlapCount : 0,
        topPlayerExposures: topExposures,
      };

      if (!allProStats.has(username)) allProStats.set(username, []);
      allProStats.get(username)!.push(stats);
    }

    // Run V32 on this slate
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
    const targets = computeRegionTargets(regionMap, 150, 'weighted_lift', 1.0);

    // Feasibility filter
    const poolCoords = loaded.lineups.map(l => ({ projection: l.projection, ownership: l.players.reduce((sm: number, p: Player) => sm + (p.ownership || 0), 0) / l.players.length }));
    const poolDist = new Map<string, number>();
    for (const c of poolCoords) {
      const pB = findBin(c.projection, regionMap.projBins);
      const oB = findBin(c.ownership, regionMap.ownBins);
      poolDist.set(`${pB}_${oB}`, (poolDist.get(`${pB}_${oB}`) || 0) + 1);
    }
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
      const dA = ca ? Math.abs((ca.projRange[0] + ca.projRange[1]) / 2 - regionMap.top1Centroid.projection) / 10 + Math.abs((ca.ownRange[0] + ca.ownRange[1]) / 2 - regionMap.top1Centroid.ownership) / 5 : 99;
      const dB = cb ? Math.abs((cb.projRange[0] + cb.projRange[1]) / 2 - regionMap.top1Centroid.projection) / 10 + Math.abs((cb.ownRange[0] + cb.ownRange[1]) / 2 - regionMap.top1Centroid.ownership) / 5 : 99;
      return dA - dB;
    });
    for (const [key, tc] of sortedAlloc) {
      const cell = regionMap.cells.get(key); if (!cell) continue;
      const rc = candCoords.filter(c => c.projection >= cell.projRange[0] && c.projection < cell.projRange[1] && c.ownership >= cell.ownRange[0] && c.ownership < cell.ownRange[1])
        .map(c => ({ ...c, score: v31Score(c.idx, ctx, precomp, 0.3, 0.3) })).sort((a, b) => b.score - a.score);
      let filled = 0;
      for (const cand of rc) {
        if (filled >= tc) break;
        const lu = precomp.candidatePool[cand.idx]; if (v32H.has(lu.hash)) continue;
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

    let vT1 = 0, vT5 = 0, vCash = 0, vScored = 0, vSumAct = 0;
    for (const lu of v32F) {
      const fa = actualByHash.get(lu.hash); let a: number | null = fa !== undefined ? fa : null;
      if (a === null) { let t = 0, miss = false; for (const p of lu.players) { const r = actuals.playerActualsByName.get(norm(p.name)); if (!r) { miss = true; break; } t += r.fpts; } if (!miss) a = t; }
      if (a === null) continue;
      vScored++; vSumAct += a; if (a >= thresholds.top1) vT1++; if (a >= thresholds.top5) vT5++; if (a >= thresholds.cash) vCash++;
    }
    let sOwn = 0, sProj = 0;
    for (const l of v32F) { sOwn += l.players.reduce((sm: number, p: Player) => sm + (p.ownership || 0), 0) / l.players.length; sProj += l.projection; }
    const dist = Math.sqrt(Math.pow((sProj / v32F.length - regionMap.top1Centroid.projection) / 10, 2) + Math.pow((sOwn / v32F.length - regionMap.top1Centroid.ownership) / 5, 2));

    v32Stats.push({
      slate: s.slate, top1Hits: vT1, top1Rate: vScored > 0 ? vT1 / vScored : 0,
      top5Hits: vT5, top5Rate: vScored > 0 ? vT5 / vScored : 0,
      cashHits: vCash, cashRate: vScored > 0 ? vCash / vScored : 0,
      avgActual: vScored > 0 ? vSumAct / vScored : 0,
      avgProjection: sProj / v32F.length, avgOwnership: sOwn / v32F.length,
      distToCentroid: dist,
    });
    console.log(`  V32: t1=${vT1} t5=${vT5} cash=${vCash}/${vScored} own=${(sOwn / v32F.length).toFixed(1)}%`);
  }

  // ─── BUILD REPORT ───
  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
  let md = `# Deep Pro Analysis — MLB (${SLATES.length} slates)\n\n`;

  // Cross-slate pro aggregation (≥3 slates only)
  const crossPro = new Map<string, { slates: number; totalEntries: number; t1: number; t5: number; t10: number; cash: number; sumActual: number; sumOwn: number; sumProj: number; sumMaxExp: number; sumStacks: number; sumOverlap: number; sumBBRate: number; bestSlate: string; bestT1Rate: number }>();
  for (const [username, statsArr] of allProStats) {
    if (statsArr.length < 3) continue;
    const agg = { slates: statsArr.length, totalEntries: 0, t1: 0, t5: 0, t10: 0, cash: 0, sumActual: 0, sumOwn: 0, sumProj: 0, sumMaxExp: 0, sumStacks: 0, sumOverlap: 0, sumBBRate: 0, bestSlate: '', bestT1Rate: 0 };
    for (const st of statsArr) {
      agg.totalEntries += st.entries; agg.t1 += st.top1Hits; agg.t5 += st.top5Hits; agg.t10 += st.top10Hits; agg.cash += st.cashHits;
      agg.sumActual += st.avgActual * st.entries; agg.sumOwn += st.avgOwnership * st.entries; agg.sumProj += st.avgProjection * st.entries;
      agg.sumMaxExp += st.maxExposure; agg.sumStacks += st.uniqueStackTeams; agg.sumOverlap += st.avgPairOverlap; agg.sumBBRate += st.bringBackRate;
      if (st.top1Rate > agg.bestT1Rate) { agg.bestT1Rate = st.top1Rate; agg.bestSlate = st.slate; }
    }
    crossPro.set(username, agg);
  }
  const rankedPros = [...crossPro.entries()].sort((a, b) => (b[1].t1 / b[1].totalEntries) - (a[1].t1 / a[1].totalEntries));

  // V32 aggregate
  const v32Agg = { t1: 0, t5: 0, cash: 0, N: 0, sumAct: 0, sumOwn: 0, sumProj: 0 };
  for (const vs of v32Stats) { v32Agg.t1 += vs.top1Hits; v32Agg.t5 += vs.top5Hits; v32Agg.cash += vs.cashHits; v32Agg.N += 150; v32Agg.sumAct += vs.avgActual * 150; v32Agg.sumOwn += vs.avgOwnership * 150; v32Agg.sumProj += vs.avgProjection * 150; }

  md += `## Cross-Slate Rankings (pros with ≥3 slates)\n\n`;
  md += `| Rank | Pro | Slates | Entries | Top1% | Top5% | Top10% | Cash% | AvgActual | AvgOwn | AvgProj | MaxExp | Stacks | Overlap | BB% |\n`;
  md += `|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n`;
  let rank = 1;
  for (const [name, v] of rankedPros.slice(0, 25)) {
    md += `| ${rank++} | ${name} | ${v.slates} | ${v.totalEntries} | ${pct(v.t1 / v.totalEntries)} (${v.t1}) | ${pct(v.t5 / v.totalEntries)} (${v.t5}) | ${pct(v.t10 / v.totalEntries)} | ${pct(v.cash / v.totalEntries)} | ${(v.sumActual / v.totalEntries).toFixed(1)} | ${(v.sumOwn / v.totalEntries).toFixed(1)}% | ${(v.sumProj / v.totalEntries).toFixed(1)} | ${pct(v.sumMaxExp / v.slates)} | ${(v.sumStacks / v.slates).toFixed(1)} | ${(v.sumOverlap / v.slates).toFixed(1)} | ${pct(v.sumBBRate / v.slates)} |\n`;
  }
  md += `| — | **V32 (ours)** | ${v32Stats.length} | ${v32Agg.N} | **${pct(v32Agg.t1 / v32Agg.N)} (${v32Agg.t1})** | **${pct(v32Agg.t5 / v32Agg.N)}** | — | **${pct(v32Agg.cash / v32Agg.N)}** | ${(v32Agg.sumAct / v32Agg.N).toFixed(1)} | ${(v32Agg.sumOwn / v32Agg.N).toFixed(1)}% | ${(v32Agg.sumProj / v32Agg.N).toFixed(1)} | — | — | — | — |\n\n`;

  // Per-slate breakdown for top 5 cross-slate pros + V32
  const top5Pros = rankedPros.slice(0, 5).map(([n]) => n);
  md += `## Per-Slate Breakdown — Top 5 Pros vs V32\n\n`;
  for (const s of SLATES) {
    md += `### ${s.slate}\n\n`;
    md += `| Player | N | Top1% | Top5% | Cash% | AvgAct | AvgOwn | AvgProj | MaxExp | Stacks | Overlap | BB% |\n`;
    md += `|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n`;
    for (const proName of top5Pros) {
      const stats = allProStats.get(proName)?.find(st => st.slate === s.slate);
      if (!stats) { md += `| ${proName} | — | — | — | — | — | — | — | — | — | — | — |\n`; continue; }
      md += `| ${proName} | ${stats.entries} | ${pct(stats.top1Rate)} (${stats.top1Hits}) | ${pct(stats.top5Rate)} | ${pct(stats.cashRate)} | ${stats.avgActual.toFixed(1)} | ${stats.avgOwnership.toFixed(1)}% | ${stats.avgProjection.toFixed(1)} | ${pct(stats.maxExposure)} ${stats.maxExpPlayer.substring(0, 12)} | ${stats.uniqueStackTeams} | ${stats.avgPairOverlap.toFixed(1)} | ${pct(stats.bringBackRate)} |\n`;
    }
    const vs = v32Stats.find(v => v.slate === s.slate);
    if (vs) md += `| **V32** | 150 | **${pct(vs.top1Rate)} (${vs.top1Hits})** | **${pct(vs.top5Rate)}** | **${pct(vs.cashRate)}** | ${vs.avgActual.toFixed(1)} | ${vs.avgOwnership.toFixed(1)}% | ${vs.avgProjection.toFixed(1)} | — | — | — | — |\n`;
    md += `\n`;
  }

  // Structural comparison: avg of top-10 pros vs V32
  md += `## Structural Gap Analysis — Top 10 Pros vs V32\n\n`;
  const top10 = rankedPros.slice(0, 10);
  const proAvg = { own: 0, proj: 0, maxExp: 0, stacks: 0, overlap: 0, bb: 0, t1Rate: 0, cashRate: 0, actual: 0 };
  for (const [, v] of top10) {
    proAvg.own += v.sumOwn / v.totalEntries; proAvg.proj += v.sumProj / v.totalEntries;
    proAvg.maxExp += v.sumMaxExp / v.slates; proAvg.stacks += v.sumStacks / v.slates;
    proAvg.overlap += v.sumOverlap / v.slates; proAvg.bb += v.sumBBRate / v.slates;
    proAvg.t1Rate += v.t1 / v.totalEntries; proAvg.cashRate += v.cash / v.totalEntries;
    proAvg.actual += v.sumActual / v.totalEntries;
  }
  const n10 = top10.length;
  md += `| Metric | Top-10 Pros (avg) | V32 | Gap | Interpretation |\n`;
  md += `|---|---:|---:|---:|---|\n`;
  md += `| Top 1% rate | ${pct(proAvg.t1Rate / n10)} | ${pct(v32Agg.t1 / v32Agg.N)} | ${((proAvg.t1Rate / n10 - v32Agg.t1 / v32Agg.N) * 100).toFixed(2)}pp | |\n`;
  md += `| Cash rate | ${pct(proAvg.cashRate / n10)} | ${pct(v32Agg.cash / v32Agg.N)} | ${((proAvg.cashRate / n10 - v32Agg.cash / v32Agg.N) * 100).toFixed(2)}pp | |\n`;
  md += `| Avg actual | ${(proAvg.actual / n10).toFixed(1)} | ${(v32Agg.sumAct / v32Agg.N).toFixed(1)} | ${((proAvg.actual / n10) - (v32Agg.sumAct / v32Agg.N)).toFixed(1)} | Higher = better player picks |\n`;
  md += `| Avg ownership | ${(proAvg.own / n10).toFixed(1)}% | ${(v32Agg.sumOwn / v32Agg.N).toFixed(1)}% | ${((proAvg.own / n10) - (v32Agg.sumOwn / v32Agg.N)).toFixed(1)}pp | Pro vs V32 contrarianism |\n`;
  md += `| Avg projection | ${(proAvg.proj / n10).toFixed(1)} | ${(v32Agg.sumProj / v32Agg.N).toFixed(1)} | ${((proAvg.proj / n10) - (v32Agg.sumProj / v32Agg.N)).toFixed(1)} | Projection accuracy gap |\n`;
  md += `| Max exposure | ${pct(proAvg.maxExp / n10)} | — | — | Player concentration |\n`;
  md += `| Unique stacks | ${(proAvg.stacks / n10).toFixed(1)} | — | — | Stack diversity |\n`;
  md += `| Avg pair overlap | ${(proAvg.overlap / n10).toFixed(1)} | — | — | Lineup uniqueness (lower = more diverse) |\n`;
  md += `| Bring-back % | ${pct(proAvg.bb / n10)} | — | — | Opposing-stack hedging |\n`;
  md += `\n`;

  // Top player exposure comparison for #1 pro
  if (rankedPros.length > 0) {
    const topPro = rankedPros[0][0];
    const topProStats = allProStats.get(topPro) || [];
    md += `## ${topPro}'s Player Exposures (per slate)\n\n`;
    for (const st of topProStats) {
      md += `### ${st.slate}\n`;
      md += `| Player | Pro Exp | Field Own | Leverage |\n|---|---:|---:|---:|\n`;
      for (const te of st.topPlayerExposures) {
        const lev = te.fieldOwn > 0 ? (te.exposure / te.fieldOwn).toFixed(2) + 'x' : 'n/a';
        md += `| ${te.name} | ${pct(te.exposure)} | ${pct(te.fieldOwn)} | ${lev} |\n`;
      }
      md += `\n`;
    }
  }

  const outPath = path.join(DATA_DIR, 'deep_pro_analysis.md');
  fs.writeFileSync(outPath, md);
  console.log(`\n✓ Report: ${outPath}`);
}

function findBin(value: number, bins: number[]): number {
  for (let i = bins.length - 1; i >= 0; i--) if (value >= bins[i]) return i;
  return 0;
}

main();
