/**
 * Pro portfolio deep analysis — 7 pros × 29 slates.
 *
 * Loads pro entries from actuals contest data, groups by extracted username,
 * matches to the 7 tracked pros (per `_argus_v9_research.ts`). For each pro
 * per slate computes player-level exposure, stack shape, salary, pitcher
 * patterns. Then aggregates across pros to identify:
 *   - Consensus plays (high agreement across pros)
 *   - Differentiators (high pro-to-pro disagreement)
 *   - Stack shape distribution (4-stack vs 3-2 vs alt patterns)
 *   - Pitcher selection patterns (always-played vs differentiated)
 *
 * Output:
 *   - pro_deep_analysis.json — full data
 *   - Console summary
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as csvParse } from 'csv-parse/sync';
import { Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals } from '../parser';
import { getContestConfig } from '../rules';

const DIR = 'C:/Users/colin/dfs opto';
const OUT_JSON = path.join(DIR, 'pro_deep_analysis.json');

const PROS = [
  { label: 'nerdytenor',     tokens: ['nerdytenor'] },
  { label: 'zroth',          tokens: ['zroth', 'zroth2'] },
  { label: 'youdacao',       tokens: ['youdacao'] },
  { label: 'shipmymoney',    tokens: ['shipmymoney'] },
  { label: 'shaidyadvice',   tokens: ['shaidyadvice'] },
  { label: 'bgreseth',       tokens: ['bgreseth'] },
  { label: 'needlunchmoney', tokens: ['needlunchmoney'] },
];

const SLATES = [
  { slate: '4-6-26',         proj: '4-6-26_projections.csv',        actuals: 'dkactuals 4-6-26.csv',      pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26',         proj: '4-8-26projections.csv',         actuals: '4-8-26actuals.csv',         pool: '4-8-26sspool.csv' },
  { slate: '4-12-26',        proj: '4-12-26projections.csv',        actuals: '4-12-26actuals.csv',        pool: '4-12-26sspool.csv' },
  { slate: '4-14-26',        proj: '4-14-26projections.csv',        actuals: '4-14-26actuals.csv',        pool: '4-14-26sspool.csv' },
  { slate: '4-15-26',        proj: '4-15-26projections.csv',        actuals: '4-15-26actuals.csv',        pool: '4-15-26sspool.csv' },
  { slate: '4-17-26',        proj: '4-17-26projections.csv',        actuals: '4-17-26actuals.csv',        pool: '4-17-26sspool.csv' },
  { slate: '4-18-26',        proj: '4-18-26projections.csv',        actuals: '4-18-26actuals.csv',        pool: '4-18-26sspool.csv' },
  { slate: '4-19-26',        proj: '4-19-26projections.csv',        actuals: '4-19-26actuals.csv',        pool: '4-19-26sspool.csv' },
  { slate: '4-20-26',        proj: '4-20-26projections.csv',        actuals: '4-20-26actuals.csv',        pool: '4-20-26sspool.csv' },
  { slate: '4-21-26',        proj: '4-21-26projections.csv',        actuals: '4-21-26actuals.csv',        pool: '4-21-26sspool.csv' },
  { slate: '4-22-26',        proj: '4-22-26projections.csv',        actuals: '4-22-26actuals.csv',        pool: '4-22-26sspool.csv' },
  { slate: '4-23-26',        proj: '4-23-26projections.csv',        actuals: '4-23-26actuals.csv',        pool: '4-23-26sspool.csv' },
  { slate: '4-24-26',        proj: '4-24-26projections.csv',        actuals: '4-24-26actuals.csv',        pool: '4-24-26sspool.csv' },
  { slate: '4-25-26',        proj: '4-25-26projections.csv',        actuals: '4-25-26actuals.csv',        pool: '4-25-26sspool.csv' },
  { slate: '4-25-26-early',  proj: '4-25-26projectionsearly.csv',   actuals: '4-25-26actualsearly.csv',   pool: '4-25-26sspoolearly.csv' },
  { slate: '4-26-26',        proj: '4-26-26projections.csv',        actuals: '4-26-26actuals.csv',        pool: '4-26-26sspool.csv' },
  { slate: '4-27-26',        proj: '4-27-26projections.csv',        actuals: '4-27-26actuals.csv',        pool: '4-27-26sspool.csv' },
  { slate: '4-28-26',        proj: '4-28-26projections.csv',        actuals: '4-28-26actuals.csv',        pool: '4-28-26sspool.csv' },
  { slate: '4-29-26',        proj: '4-29-26projections.csv',        actuals: '4-29-26actuals.csv',        pool: '4-29-26sspool.csv' },
  { slate: '5-1-26',         proj: '5-1-26projections.csv',         actuals: '5-1-26actuals.csv',         pool: '5-1-26sspool.csv' },
  { slate: '5-2-26',         proj: '5-2-26projections.csv',         actuals: '5-2-26actuals.csv',         pool: '5-2-26sspool.csv' },
  { slate: '5-2-26-main',    proj: '5-2-26projectionsmain.csv',     actuals: '5-2-26actualsmain.csv',     pool: '5-2-26sspoolmain.csv' },
  { slate: '5-2-26-night',   proj: '5-2-26projectionsnight.csv',    actuals: '5-2-26actualsnight.csv',    pool: '5-2-26sspoolnight.csv' },
  { slate: '5-3-26',         proj: '5-3-26projections.csv',         actuals: '5-3-26actuals.csv',         pool: '5-3-26sspool.csv' },
  { slate: '5-3-26-late',    proj: '5-3-26projectionslate.csv',     actuals: '5-3-26actualslate.csv',     pool: '5-3-26sspoollate.csv' },
  { slate: '5-4-26',         proj: '5-4-26projections.csv',         actuals: '5-4-26actuals.csv',         pool: '5-4-26sspool.csv' },
  { slate: '5-4-26-late',    proj: '5-4-26projectionslate.csv',     actuals: '5-4-26actualslate.csv',     pool: '5-4-26sspoollate.csv' },
  { slate: '5-5-26',         proj: '5-5-26projections.csv',         actuals: '5-5-26actuals.csv',         pool: '5-5-26sspool.csv' },
  { slate: '5-6-26',         proj: '5-6-26projections.csv',         actuals: '5-6-26actuals.csv',         pool: '5-6-26sspool.csv' },
];

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function extractUser(entryName: string): string { return (entryName || '').replace(/\s*\([^)]*\)\s*$/, '').trim(); }
function mean(a: number[]): number { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function stddev(a: number[]): number { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); }
function isPitcher(p: Player): boolean { return (p.position || '').toUpperCase().includes('P'); }

function loadAdjOwn(projPath: string): Map<string, number> {
  const out = new Map<string, number>();
  if (!fs.existsSync(projPath)) return out;
  const records = csvParse(fs.readFileSync(projPath, 'utf-8'), { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
  for (const r of records) {
    const id = (r['DFS ID'] || r['ID'] || '').trim(); if (!id) continue;
    const adj = parseFloat((r['Adj Own'] || '').replace(/[%,]/g, ''));
    if (!Number.isNaN(adj)) out.set(id, Math.max(0, adj));
  }
  return out;
}

/**
 * Per-pro per-slate analysis.
 * Captures: player exposures, stack shapes, salary distribution, pitcher patterns.
 */
interface ProSlateStats {
  pro: string;
  slate: string;
  lineupCount: number;
  meanProj: number;
  meanOwn: number;
  meanSalary: number;
  ownStd: number;            // stddev of mean-own across lineups
  uniquePlayers: number;
  topExposures: Array<{ name: string; team: string; pos: string; own: number; proj: number; count: number; pct: number }>;
  // Stack shape counts: 4-stack (4+ same team hitters), 3-stack, 2-stack, none
  stack4Count: number;       // lineups with 4+ same-team hitters
  stack3Count: number;       // lineups with 3 (but not 4+) same-team hitters as primary
  stack5Count: number;       // lineups with 5 same-team hitters
  bringBackRate: number;     // fraction of stacks that have a bring-back (opposing pitcher's hitter)
  // Pitcher patterns
  pitcherExposures: Array<{ name: string; team: string; own: number; proj: number; count: number; pct: number }>;
  // 2-player combo counts (for finding pro-favored pairs)
  // Top 50 most-used pairs
  topPairs: Array<{ p1: string; p2: string; count: number; pct: number }>;
}

function computeStackShape(lineupPlayers: Player[]): {
  primarySize: number;
  primaryTeam: string;
  secondarySize: number;
  bringBack: number;
} {
  const teamCounts = new Map<string, number>();
  let primaryPitcherTeam = '';
  for (const p of lineupPlayers) {
    if (isPitcher(p)) {
      // Track pitcher's team to detect bring-back
      if (!primaryPitcherTeam) primaryPitcherTeam = (p.team || '').toUpperCase();
      continue;
    }
    const t = (p.team || '').toUpperCase();
    teamCounts.set(t, (teamCounts.get(t) || 0) + 1);
  }
  let primary = { team: '', size: 0 };
  let secondary = { team: '', size: 0 };
  for (const [t, c] of teamCounts) {
    if (c > primary.size) { secondary = primary; primary = { team: t, size: c }; }
    else if (c > secondary.size) { secondary = { team: t, size: c }; }
  }
  // Bring-back = secondary stack contains hitter on opposing team of primary pitcher
  // Simplification: count secondary stack only if it's not the primary team. We don't
  // detect opposing-team relationships here without game info — approximate.
  return {
    primarySize: primary.size,
    primaryTeam: primary.team,
    secondarySize: secondary.size,
    bringBack: secondary.size,    // approximation
  };
}

function analyzePro(label: string, slate: string, lineupsPlayers: Player[][]): ProSlateStats {
  const N = lineupsPlayers.length;
  const lineupProjs: number[] = [];
  const lineupOwns: number[] = [];
  const lineupSalaries: number[] = [];
  const lineupMeanOwns: number[] = [];
  const exposureCount = new Map<string, { name: string; team: string; pos: string; own: number; proj: number; count: number }>();
  const pitcherExposureCount = new Map<string, { name: string; team: string; own: number; proj: number; count: number }>();
  const pairCount = new Map<string, { p1: string; p2: string; count: number }>();
  let stack5 = 0, stack4 = 0, stack3 = 0;

  for (const pls of lineupsPlayers) {
    let proj = 0, own = 0, sal = 0;
    const owns: number[] = [];
    for (const p of pls) {
      proj += p.projection || 0;
      own += p.ownership || 0;
      sal += p.salary || 0;
      owns.push(p.ownership || 0);
      const k = p.id;
      const r = exposureCount.get(k);
      if (r) r.count++;
      else exposureCount.set(k, { name: p.name, team: p.team || '', pos: p.position || '', own: p.ownership || 0, proj: p.projection || 0, count: 1 });
      if (isPitcher(p)) {
        const pr = pitcherExposureCount.get(k);
        if (pr) pr.count++;
        else pitcherExposureCount.set(k, { name: p.name, team: p.team || '', own: p.ownership || 0, proj: p.projection || 0, count: 1 });
      }
    }
    lineupProjs.push(proj);
    lineupOwns.push(own);
    lineupSalaries.push(sal);
    lineupMeanOwns.push(own / pls.length);

    // Stack shape
    const shape = computeStackShape(pls);
    if (shape.primarySize >= 5) stack5++;
    else if (shape.primarySize >= 4) stack4++;
    else if (shape.primarySize >= 3) stack3++;

    // 2-player combos (only among hitters from same team — most useful for stack analysis)
    const hitters = pls.filter(p => !isPitcher(p));
    const ids = hitters.map(p => p.id).sort();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const k = ids[i] + '|' + ids[j];
        const r = pairCount.get(k);
        if (r) r.count++;
        else pairCount.set(k, { p1: ids[i], p2: ids[j], count: 1 });
      }
    }
  }

  const topExposures = [...exposureCount.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 25)
    .map(r => ({ ...r, pct: r.count / N }));

  const pitcherExposures = [...pitcherExposureCount.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
    .map(r => ({ ...r, pct: r.count / N }));

  const topPairs = [...pairCount.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 50)
    .map(r => ({ ...r, pct: r.count / N }));

  return {
    pro: label,
    slate,
    lineupCount: N,
    meanProj: mean(lineupProjs),
    meanOwn: mean(lineupMeanOwns),
    meanSalary: mean(lineupSalaries),
    ownStd: stddev(lineupMeanOwns),
    uniquePlayers: exposureCount.size,
    topExposures,
    stack4Count: stack4,
    stack3Count: stack3,
    stack5Count: stack5,
    bringBackRate: 0,         // approximation; not used in first pass
    pitcherExposures,
    topPairs,
  };
}

async function main() {
  console.log('================================================================');
  console.log('Pro Portfolio Deep Analysis — 7 pros × 29 slates');
  console.log('================================================================\n');

  interface SlateResult {
    slate: string;
    proCount: number;        // pros found with >=100 lineups
    proStats: ProSlateStats[];
    // Cross-pro consensus
    consensusPlays: Array<{ playerId: string; name: string; team: string; pos: string; own: number; proj: number; meanPct: number; minPct: number; maxPct: number }>;  // players used >=30% by avg pro
    differentiatorPlays: Array<{ playerId: string; name: string; team: string; meanPct: number; spreadPct: number }>;  // players where pros disagree most
    proJaccardMatrix: Record<string, Record<string, number>>;     // Jaccard of player sets between pros
  }
  const results: SlateResult[] = [];

  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj);
    const actualsPath = path.join(DIR, s.actuals);
    if (![projPath, actualsPath].every(p => fs.existsSync(p))) { console.log(`  ${s.slate}: missing files, skip`); continue; }
    try {
      const pr = parseCSVFile(projPath, 'mlb', true);
      const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
      const playerPool = buildPlayerPool(pr.players, pr.detectedContestType);
      const actuals = parseContestActuals(actualsPath, config);

      // Apply Adj Own override.
      const adjOwn = loadAdjOwn(projPath);
      for (const p of playerPool.players) {
        const adj = adjOwn.get(p.id);
        if (adj !== undefined) p.ownership = adj;
      }

      const nameMap = new Map<string, Player>();
      for (const p of playerPool.players) nameMap.set(norm(p.name), p);

      const byUser = new Map<string, typeof actuals.entries>();
      for (const e of actuals.entries) {
        const u = extractUser(e.entryName);
        const arr = byUser.get(u); if (arr) arr.push(e); else byUser.set(u, [e]);
      }

      const proStatsList: ProSlateStats[] = [];
      const proPlayerSets: Record<string, Set<string>> = {};
      for (const pro of PROS) {
        let matched: typeof actuals.entries = [];
        for (const [u, ents] of byUser) {
          if (pro.tokens.some(t => u.toLowerCase().includes(t))) matched = matched.concat(ents);
        }
        if (matched.length < 100) continue;
        const proLus: Player[][] = [];
        for (const e of matched.slice(0, 150)) {
          const pls: Player[] = []; let ok = true;
          for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
          if (ok) proLus.push(pls);
        }
        if (proLus.length < 100) continue;
        const stats = analyzePro(pro.label, s.slate, proLus);
        proStatsList.push(stats);
        const playerSet = new Set<string>();
        for (const pls of proLus) for (const p of pls) playerSet.add(p.id);
        proPlayerSets[pro.label] = playerSet;
      }

      // Cross-pro: compute consensus + differentiator plays
      // Aggregate player exposure across pros (mean pct, min, max)
      const playerAgg = new Map<string, { name: string; team: string; pos: string; own: number; proj: number; pcts: number[] }>();
      for (const ps of proStatsList) {
        for (const e of ps.topExposures) {
          // Note: topExposures uses player NAME as key indirectly; use a stable id later
        }
        // Need full per-player pct per pro, not just top-25
      }
      // Rebuild player exposures fully per pro
      const proExposurePcts: Record<string, Map<string, number>> = {};
      for (const pro of PROS) {
        let matched: typeof actuals.entries = [];
        for (const [u, ents] of byUser) {
          if (pro.tokens.some(t => u.toLowerCase().includes(t))) matched = matched.concat(ents);
        }
        if (matched.length < 100) continue;
        const m = new Map<string, number>();
        let lineupN = 0;
        for (const e of matched.slice(0, 150)) {
          const pls: Player[] = []; let ok = true;
          for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
          if (ok) {
            lineupN++;
            for (const p of pls) m.set(p.id, (m.get(p.id) || 0) + 1);
          }
        }
        if (lineupN < 100) continue;
        // Convert counts to pcts
        const pctMap = new Map<string, number>();
        for (const [id, c] of m) pctMap.set(id, c / lineupN);
        proExposurePcts[pro.label] = pctMap;
      }

      // Aggregate: for each player, gather pcts across pros
      const allPlayerIds = new Set<string>();
      for (const m of Object.values(proExposurePcts)) for (const id of m.keys()) allPlayerIds.add(id);
      const playerCrossPro = new Map<string, { name: string; team: string; pos: string; own: number; proj: number; pcts: number[] }>();
      const idMap = new Map<string, Player>();
      for (const p of playerPool.players) idMap.set(p.id, p);
      for (const id of allPlayerIds) {
        const pl = idMap.get(id); if (!pl) continue;
        const pcts: number[] = [];
        for (const proLabel of Object.keys(proExposurePcts)) {
          pcts.push(proExposurePcts[proLabel].get(id) || 0);
        }
        playerCrossPro.set(id, { name: pl.name, team: pl.team || '', pos: pl.position || '', own: pl.ownership || 0, proj: pl.projection || 0, pcts });
      }

      const consensus = [...playerCrossPro.entries()]
        .map(([id, r]) => ({ playerId: id, name: r.name, team: r.team, pos: r.pos, own: r.own, proj: r.proj, meanPct: mean(r.pcts), minPct: Math.min(...r.pcts), maxPct: Math.max(...r.pcts) }))
        .filter(r => r.meanPct >= 0.30)
        .sort((a, b) => b.meanPct - a.meanPct);

      const differentiators = [...playerCrossPro.entries()]
        .map(([id, r]) => ({ playerId: id, name: r.name, team: r.team, meanPct: mean(r.pcts), spreadPct: Math.max(...r.pcts) - Math.min(...r.pcts) }))
        .filter(r => r.meanPct >= 0.05 && r.spreadPct >= 0.30)
        .sort((a, b) => b.spreadPct - a.spreadPct);

      // Jaccard matrix
      const jaccard: Record<string, Record<string, number>> = {};
      const pros = Object.keys(proExposurePcts);
      for (const a of pros) {
        jaccard[a] = {};
        const setA = new Set([...proExposurePcts[a].keys()].filter(k => proExposurePcts[a].get(k)! >= 0.05));
        for (const b of pros) {
          if (a === b) { jaccard[a][b] = 1; continue; }
          const setB = new Set([...proExposurePcts[b].keys()].filter(k => proExposurePcts[b].get(k)! >= 0.05));
          let inter = 0;
          for (const x of setA) if (setB.has(x)) inter++;
          const union = setA.size + setB.size - inter;
          jaccard[a][b] = union > 0 ? inter / union : 0;
        }
      }

      results.push({
        slate: s.slate,
        proCount: proStatsList.length,
        proStats: proStatsList,
        consensusPlays: consensus,
        differentiatorPlays: differentiators,
        proJaccardMatrix: jaccard,
      });

      console.log(`  ${s.slate.padEnd(15)} pros=${proStatsList.length}  meanStack4=${mean(proStatsList.map(s => s.stack4Count / s.lineupCount)).toFixed(2)}  meanStack3=${mean(proStatsList.map(s => s.stack3Count / s.lineupCount)).toFixed(2)}  meanStack5=${mean(proStatsList.map(s => s.stack5Count / s.lineupCount)).toFixed(2)}  consensus=${consensus.length}  diff=${differentiators.length}  avgJaccard=${mean(Object.values(jaccard).flatMap(j => Object.entries(j).filter(([k]) => k !== Object.keys(jaccard)[Object.values(j).indexOf(j[k])]).map(([_, v]) => v))).toFixed(2)}`);
    } catch (e: any) {
      console.log(`  ${s.slate}: error — ${e?.message || e}`);
    }
  }

  // Aggregate: across slates, what stack shapes do pros use?
  console.log('\n================================================================');
  console.log('AGGREGATE — across all pros, all slates');
  console.log('================================================================\n');

  const allProStats = results.flatMap(r => r.proStats);
  console.log(`Total pro-slate observations: ${allProStats.length}`);
  console.log(`Distinct pros: ${new Set(allProStats.map(s => s.pro)).size}`);
  console.log(`Slates covered: ${results.length}`);

  // Stack shape distribution per pro
  console.log('\n--- Stack shape (fraction of pro\'s portfolio with primary stack of size...) ---');
  const proLabels = [...new Set(allProStats.map(s => s.pro))];
  console.log(`${'Pro'.padEnd(18)} stack5%   stack4%   stack3%   none%`);
  for (const pl of proLabels) {
    const stats = allProStats.filter(s => s.pro === pl);
    const total = stats.reduce((a, s) => a + s.lineupCount, 0);
    const s5 = stats.reduce((a, s) => a + s.stack5Count, 0);
    const s4 = stats.reduce((a, s) => a + s.stack4Count, 0);
    const s3 = stats.reduce((a, s) => a + s.stack3Count, 0);
    const none = total - s5 - s4 - s3;
    console.log(`${pl.padEnd(18)} ${(s5 / total * 100).toFixed(1).padStart(5)}%   ${(s4 / total * 100).toFixed(1).padStart(5)}%   ${(s3 / total * 100).toFixed(1).padStart(5)}%   ${(none / total * 100).toFixed(1).padStart(5)}%`);
  }

  // Mean projection, ownership, salary per pro
  console.log('\n--- Mean lineup metrics per pro ---');
  console.log(`${'Pro'.padEnd(18)} meanProj   meanOwn   meanSal   uniqPly`);
  for (const pl of proLabels) {
    const stats = allProStats.filter(s => s.pro === pl);
    console.log(`${pl.padEnd(18)} ${mean(stats.map(s => s.meanProj)).toFixed(1).padStart(7)}    ${mean(stats.map(s => s.meanOwn)).toFixed(2).padStart(5)}%   $${mean(stats.map(s => s.meanSalary)).toFixed(0).padStart(5)}   ${mean(stats.map(s => s.uniquePlayers)).toFixed(0).padStart(4)}`);
  }

  // Pro-vs-pro Jaccard agreement (avg across slates)
  console.log('\n--- Pro-vs-pro player-set agreement (avg Jaccard across slates, threshold 5% exposure) ---');
  const pairAgreement: Record<string, number[]> = {};
  for (const r of results) {
    for (const a of Object.keys(r.proJaccardMatrix)) {
      for (const b of Object.keys(r.proJaccardMatrix[a])) {
        if (a >= b) continue;
        const k = `${a} vs ${b}`;
        if (!pairAgreement[k]) pairAgreement[k] = [];
        pairAgreement[k].push(r.proJaccardMatrix[a][b]);
      }
    }
  }
  const sortedPairs = Object.entries(pairAgreement).map(([k, v]) => ({ k, avg: mean(v) })).sort((a, b) => b.avg - a.avg);
  for (const p of sortedPairs.slice(0, 15)) console.log(`  ${p.k.padEnd(40)} ${(p.avg * 100).toFixed(1)}%`);

  fs.writeFileSync(OUT_JSON, JSON.stringify(results, null, 2));
  console.log(`\nFull data saved to ${OUT_JSON}`);
}

main().catch(e => { console.error(e); process.exit(1); });
