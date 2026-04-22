/**
 * nerdytenor Construction Analysis — reverse-engineer a millions-won pro's portfolio.
 *
 * For each slate, pull all 150 nerdytenor entries, resolve player names to the
 * projection pool to recover ownership/projection/team, then extract:
 *   - Entry count audit (completeness check)
 *   - Ownership distribution (per-lineup avg: min, p10, p25, p50, p75, p90, max, mean)
 *   - Max team stack exposure
 *   - Stack type distribution (5+, 4, 4-4 split, 4-3, 3-3, no-stack)
 *   - Per-player exposures (top 20 + zero-exposure projected chalk)
 *   - Pitcher concentration
 *   - Pairwise lineup overlap distribution
 *   - Deep dives: 4-14 winning lineups (6 hits $12,957), 4-19 top hit ($17,728)
 *
 * Side-by-side with production (λ=0.05, γ disabled) on the same slate.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals, ContestEntry } from '../parser';
import { getContestConfig } from '../rules';
import { productionSelect } from '../selection/production-selector';
import { precomputeComboFrequencies } from '../selection/combo-leverage';

const DIR = 'C:/Users/colin/dfs opto';
const FEE = 20;
const N = 150;
const LAMBDA = 0.05;

const SLATES = [
  { slate: '4-6-26', proj: '4-6-26_projections.csv', actuals: 'dkactuals 4-6-26.csv', pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26', proj: '4-8-26projections.csv', actuals: '4-8-26actuals.csv', pool: '4-8-26sspool.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv', actuals: '4-12-26actuals.csv', pool: '4-12-26sspool.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv', actuals: '4-14-26actuals.csv', pool: '4-14-26sspool.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv', actuals: '4-15-26actuals.csv', pool: '4-15-26sspool.csv' },
  { slate: '4-17-26', proj: '4-17-26projections.csv', actuals: '4-17-26actuals.csv', pool: '4-17-26sspool.csv' },
  { slate: '4-18-26', proj: '4-18-26projections.csv', actuals: '4-18-26actuals.csv', pool: '4-18-26sspool.csv' },
  { slate: '4-19-26', proj: '4-19-26projections.csv', actuals: '4-19-26actuals.csv', pool: '4-19-26sspool.csv' },
  { slate: '4-20-26', proj: '4-20-26projections.csv', actuals: '4-20-26actuals.csv', pool: '4-20-26sspool.csv' },
];

function norm(n: string): string {
  return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(s.length - 1, Math.floor(p * s.length)));
  return s[idx];
}

function mean(arr: number[]): number {
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}

interface ResolvedEntry {
  entry: ContestEntry;
  players: Player[];        // same order as lineup
  pitchers: Player[];
  hittersByTeam: Map<string, Player[]>;
  primaryStackTeam: string | null;
  primaryStackSize: number;
  secondaryStackSize: number;  // size of second-largest hitter cluster
  avgOwn: number;
  totalProj: number;
  ceiling: number;  // sum of p85 (SaberSim ceiling)
  pidSet: Set<string>;
  stackType: string;
}

function classifyStack(primary: number, secondary: number): string {
  if (primary >= 5) return `${primary}-stack`;
  if (primary === 4 && secondary >= 4) return '4-4 split';
  if (primary === 4 && secondary === 3) return '4-3';
  if (primary === 4 && secondary === 2) return '4-2';
  if (primary === 4) return '4-stack';
  if (primary === 3 && secondary === 3) return '3-3';
  if (primary === 3) return '3-stack';
  return 'no-stack';
}

function resolveEntry(entry: ContestEntry, nameMap: Map<string, Player>): ResolvedEntry | null {
  const players: Player[] = [];
  for (const nm of entry.playerNames) {
    const p = nameMap.get(norm(nm));
    if (!p) return null;
    players.push(p);
  }
  const pitchers: Player[] = [];
  const hittersByTeam = new Map<string, Player[]>();
  for (const p of players) {
    if (p.positions?.includes('P')) pitchers.push(p);
    else {
      let arr = hittersByTeam.get(p.team);
      if (!arr) { arr = []; hittersByTeam.set(p.team, arr); }
      arr.push(p);
    }
  }
  // Primary and secondary stack
  const counts = [...hittersByTeam.entries()].map(([t, arr]) => ({ team: t, n: arr.length }));
  counts.sort((a, b) => b.n - a.n);
  const primaryStackTeam = counts.length > 0 && counts[0].n >= 4 ? counts[0].team : null;
  const primaryStackSize = counts.length > 0 ? counts[0].n : 0;
  const secondaryStackSize = counts.length > 1 ? counts[1].n : 0;
  const avgOwn = players.reduce((s, p) => s + (p.ownership || 0), 0) / players.length;
  const totalProj = players.reduce((s, p) => s + (p.projection || 0), 0);
  const ceiling = players.reduce((s, p) => s + (p.ceiling || p.projection * 1.3), 0);
  return {
    entry, players, pitchers, hittersByTeam,
    primaryStackTeam, primaryStackSize, secondaryStackSize,
    avgOwn, totalProj, ceiling,
    pidSet: new Set(players.map(p => p.id)),
    stackType: classifyStack(primaryStackSize, secondaryStackSize),
  };
}

function summarizePortfolio(label: string, resolved: ResolvedEntry[], F: number, out: string[]) {
  out.push(`\n## ${label} — ${resolved.length} lineups, field size ${F.toLocaleString()}\n`);

  const ownArr = resolved.map(r => r.avgOwn);
  const projArr = resolved.map(r => r.totalProj);
  const ceilArr = resolved.map(r => r.ceiling);
  out.push('### Ownership distribution (per-lineup avg)');
  out.push(`  min=${percentile(ownArr, 0).toFixed(1)}% p10=${percentile(ownArr, 0.1).toFixed(1)}% p25=${percentile(ownArr, 0.25).toFixed(1)}% p50=${percentile(ownArr, 0.5).toFixed(1)}% p75=${percentile(ownArr, 0.75).toFixed(1)}% p90=${percentile(ownArr, 0.9).toFixed(1)}% max=${percentile(ownArr, 1).toFixed(1)}% mean=${mean(ownArr).toFixed(1)}%`);
  out.push(`### Projection distribution (per-lineup total)`);
  out.push(`  min=${percentile(projArr, 0).toFixed(1)} p25=${percentile(projArr, 0.25).toFixed(1)} p50=${percentile(projArr, 0.5).toFixed(1)} p75=${percentile(projArr, 0.75).toFixed(1)} max=${percentile(projArr, 1).toFixed(1)} mean=${mean(projArr).toFixed(1)}`);
  out.push(`### Ceiling distribution (per-lineup total, p85 sum)`);
  out.push(`  p25=${percentile(ceilArr, 0.25).toFixed(1)} p50=${percentile(ceilArr, 0.5).toFixed(1)} p75=${percentile(ceilArr, 0.75).toFixed(1)} mean=${mean(ceilArr).toFixed(1)}`);

  // Team stack exposure
  const teamStackCounts = new Map<string, number>();
  for (const r of resolved) {
    if (r.primaryStackTeam) teamStackCounts.set(r.primaryStackTeam, (teamStackCounts.get(r.primaryStackTeam) || 0) + 1);
  }
  const sortedTeams = [...teamStackCounts.entries()].sort((a, b) => b[1] - a[1]);
  out.push(`\n### Primary stack team exposure (max=${sortedTeams[0]?.[1] || 0}/150 = ${((sortedTeams[0]?.[1] || 0) / resolved.length * 100).toFixed(1)}%)`);
  for (const [t, c] of sortedTeams) {
    out.push(`  ${t.padEnd(5)} ${c} lineups (${(c / resolved.length * 100).toFixed(1)}%)`);
  }

  // Stack types
  const stackTypes = new Map<string, number>();
  for (const r of resolved) stackTypes.set(r.stackType, (stackTypes.get(r.stackType) || 0) + 1);
  out.push(`\n### Stack type distribution`);
  const sortedTypes = [...stackTypes.entries()].sort((a, b) => b[1] - a[1]);
  for (const [t, c] of sortedTypes) {
    out.push(`  ${t.padEnd(12)} ${c} (${(c / resolved.length * 100).toFixed(1)}%)`);
  }

  // Pitcher concentration
  const pitcherExp = new Map<string, { name: string; count: number; own: number }>();
  for (const r of resolved) {
    for (const p of r.pitchers) {
      const rec = pitcherExp.get(p.id) || { name: p.name, count: 0, own: p.ownership || 0 };
      rec.count++;
      pitcherExp.set(p.id, rec);
    }
  }
  const sortedPitchers = [...pitcherExp.values()].sort((a, b) => b.count - a.count);
  out.push(`\n### Pitcher concentration (${sortedPitchers.length} unique, top 10)`);
  for (const v of sortedPitchers.slice(0, 10)) {
    out.push(`  ${v.name.padEnd(28)} ${v.count}/${resolved.length} = ${(v.count / resolved.length * 100).toFixed(1)}%   own=${v.own.toFixed(1)}%`);
  }

  // Top player exposures (hitters + pitchers)
  const playerExp = new Map<string, { name: string; team: string; pos: string; count: number; own: number; proj: number }>();
  for (const r of resolved) {
    for (const p of r.players) {
      const rec = playerExp.get(p.id) || {
        name: p.name, team: p.team, pos: p.positions?.[0] || '?', count: 0,
        own: p.ownership || 0, proj: p.projection || 0,
      };
      rec.count++;
      playerExp.set(p.id, rec);
    }
  }
  const sortedPlayers = [...playerExp.values()].sort((a, b) => b.count - a.count);
  out.push(`\n### Top 25 player exposures`);
  for (const v of sortedPlayers.slice(0, 25)) {
    out.push(`  ${v.name.padEnd(25)} ${v.team.padEnd(4)} ${v.pos.padEnd(3)} ${v.count}/${resolved.length} = ${(v.count / resolved.length * 100).toFixed(1).padStart(5)}%  own=${v.own.toFixed(1).padStart(5)}%  proj=${v.proj.toFixed(1)}`);
  }
  out.push(`\n  Total unique players: ${sortedPlayers.length}`);

  // Pairwise overlap distribution
  const overlaps: number[] = [];
  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      let n = 0;
      for (const id of resolved[i].pidSet) if (resolved[j].pidSet.has(id)) n++;
      overlaps.push(n);
    }
  }
  out.push(`\n### Pairwise lineup overlap (${overlaps.length} pairs)`);
  const maxOverlap = Math.max(...overlaps);
  out.push(`  max=${maxOverlap} p50=${percentile(overlaps, 0.5)} p75=${percentile(overlaps, 0.75)} p90=${percentile(overlaps, 0.9)} p99=${percentile(overlaps, 0.99)} mean=${mean(overlaps).toFixed(2)}`);
  // Histogram 0-10
  const hist = new Array(11).fill(0);
  for (const o of overlaps) hist[o]++;
  out.push(`  Histogram: ` + hist.map((c, i) => `${i}=${c}`).join(' '));
}

function deepDiveWinners(
  label: string,
  resolved: ResolvedEntry[],
  actuals: ContestActuals,
  top1T: number,
  sortedDesc: number[],
  out: string[],
) {
  const withScore = resolved.map(r => ({ r, score: r.entry.actualPoints }));
  withScore.sort((a, b) => b.score - a.score);

  out.push(`\n## ${label} — Top-1% Winners Deep Dive\n`);
  out.push(`Top-1% threshold: ${top1T.toFixed(2)} pts\n`);

  const winners = withScore.filter(w => w.score >= top1T);
  out.push(`${winners.length} top-1% hits:\n`);

  for (const w of winners) {
    // Find rank
    let lo = 0, hi = sortedDesc.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sortedDesc[mid] >= w.score) lo = mid + 1; else hi = mid;
    }
    const rank = Math.max(1, lo);
    out.push(`### Score ${w.score.toFixed(2)} — Rank ${rank} — stack: ${w.r.stackType} (${w.r.primaryStackTeam || '—'})`);
    out.push(`   avgOwn=${w.r.avgOwn.toFixed(1)}%  totalProj=${w.r.totalProj.toFixed(1)}  ceiling=${w.r.ceiling.toFixed(1)}`);
    for (const p of w.r.players) {
      const actual = actuals.playerActualsByName.get(norm(p.name));
      const fpts = actual ? actual.fpts.toFixed(1) : '?';
      out.push(`   ${(p.positions?.[0] || '?').padEnd(2)} ${p.name.padEnd(25)} ${p.team.padEnd(4)} own=${(p.ownership || 0).toFixed(1).padStart(5)}%  proj=${p.projection.toFixed(1).padStart(5)}  actual=${fpts.padStart(5)}`);
    }
    out.push('');
  }

  // Also show top-50 hit (if any) regardless of slate's top1 threshold
  const top50Cutoff = sortedDesc[Math.min(sortedDesc.length - 1, 49)];
  const top50Hits = withScore.filter(w => w.score >= top50Cutoff);
  if (top50Hits.length > 0) {
    out.push(`### Top-50 finishes: ${top50Hits.length}`);
    for (const w of top50Hits) {
      let lo = 0, hi = sortedDesc.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (sortedDesc[mid] >= w.score) lo = mid + 1; else hi = mid;
      }
      const rank = Math.max(1, lo);
      out.push(`  Rank ${rank}: ${w.score.toFixed(2)} pts  stack=${w.r.stackType} ${w.r.primaryStackTeam || ''}  avgOwn=${w.r.avgOwn.toFixed(1)}%`);
    }
  }
}

async function main() {
  const out: string[] = [];
  out.push('# nerdytenor Construction Analysis');
  out.push(`Generated ${new Date().toISOString()}\n`);
  out.push('Reverse-engineering a millions-won pro\'s portfolio across 9 MLB slates (Apr 2026).\n');

  // Entry count audit
  out.push('## Entry Count Audit\n');
  const entryCounts: { slate: string; nerdy: number; F: number }[] = [];
  for (const s of SLATES) {
    const actualsPath = path.join(DIR, s.actuals);
    if (!fs.existsSync(actualsPath)) {
      entryCounts.push({ slate: s.slate, nerdy: -1, F: 0 });
      continue;
    }
    const pr = parseCSVFile(path.join(DIR, s.proj), 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);
    const nerdy = actuals.entries.filter(e => e.entryName.toLowerCase().includes('nerdytenor')).length;
    entryCounts.push({ slate: s.slate, nerdy, F: actuals.entries.length });
  }
  for (const c of entryCounts) {
    const flag = c.nerdy === 150 ? '✓' : (c.nerdy === 0 ? '✗ NO DATA' : `~ partial (${c.nerdy}/150)`);
    out.push(`  ${c.slate.padEnd(10)} F=${String(c.F).padStart(6)}  nerdytenor entries: ${String(c.nerdy).padStart(3)}  ${flag}`);
  }

  // Aggregate comparison table (collected as we iterate)
  type SlateStats = {
    slate: string; F: number;
    nerdyMeanOwn: number; nerdyMaxTeam: number; nerdyStack5Plus: number; nerdyMaxPitcher: number;
    nerdyMaxOverlap: number; nerdyMeanOverlap: number; nerdyUniquePlayers: number;
    prodMeanOwn: number; prodMaxTeam: number; prodStack5Plus: number; prodMaxPitcher: number;
    prodMaxOverlap: number; prodMeanOverlap: number; prodUniquePlayers: number;
  };
  const slateStats: SlateStats[] = [];

  // Per-slate analysis
  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj);
    const actualsPath = path.join(DIR, s.actuals);
    const poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) continue;

    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);

    const nameMap = new Map<string, Player>();
    for (const p of pool.players) nameMap.set(norm(p.name), p);

    const nerdyRaw = actuals.entries.filter(e => e.entryName.toLowerCase().includes('nerdytenor'));
    if (nerdyRaw.length === 0) {
      out.push(`\n\n---\n\n# Slate ${s.slate} — SKIPPED (0 nerdytenor entries)\n`);
      continue;
    }
    const nerdyResolved = nerdyRaw.map(e => resolveEntry(e, nameMap)).filter((r): r is ResolvedEntry => r !== null);

    // Production on same slate
    const idMap = new Map<string, Player>();
    for (const p of pool.players) idMap.set(p.id, p);
    const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
    const comboFreq = precomputeComboFrequencies(loaded.lineups, 3);
    const prodResult = productionSelect(loaded.lineups, pool.players, {
      N, lambda: LAMBDA, comboFreq, maxOverlap: 10,
    });
    const prodResolved = prodResult.portfolio.map(lu => {
      const e: ContestEntry = {
        rank: 0, entryId: lu.hash, entryName: 'production',
        actualPoints: 0, playerNames: lu.players.map(p => p.name),
      };
      return resolveEntry(e, nameMap);
    }).filter((r): r is ResolvedEntry => r !== null);

    out.push(`\n\n---\n\n# Slate ${s.slate}`);
    out.push(`Games: ${pr.detectedContestType}, Pool: ${loaded.lineups.length}, Field: ${actuals.entries.length.toLocaleString()}\n`);

    summarizePortfolio(`nerdytenor (${s.slate})`, nerdyResolved, actuals.entries.length, out);
    summarizePortfolio(`production λ=0.05 (${s.slate})`, prodResolved, actuals.entries.length, out);

    // Compute max pitcher % and stack 5+ % for summary table
    const maxPitcher = (resolved: ResolvedEntry[]) => {
      const m = new Map<string, number>();
      for (const r of resolved) for (const p of r.pitchers) m.set(p.id, (m.get(p.id) || 0) + 1);
      return Math.max(0, ...m.values());
    };
    const stack5PlusPct = (resolved: ResolvedEntry[]) =>
      resolved.filter(r => r.primaryStackSize >= 5).length / resolved.length * 100;
    const overlapStats = (resolved: ResolvedEntry[]) => {
      const overlaps: number[] = [];
      for (let i = 0; i < resolved.length; i++) {
        for (let j = i + 1; j < resolved.length; j++) {
          let n = 0;
          for (const id of resolved[i].pidSet) if (resolved[j].pidSet.has(id)) n++;
          overlaps.push(n);
        }
      }
      return { max: Math.max(0, ...overlaps), mean: mean(overlaps) };
    };
    const maxTeamPct = (resolved: ResolvedEntry[]) => {
      const m = new Map<string, number>();
      for (const r of resolved) if (r.primaryStackTeam) m.set(r.primaryStackTeam, (m.get(r.primaryStackTeam) || 0) + 1);
      return Math.max(0, ...m.values()) / resolved.length * 100;
    };
    const uniquePlayers = (resolved: ResolvedEntry[]) => {
      const s = new Set<string>();
      for (const r of resolved) for (const p of r.players) s.add(p.id);
      return s.size;
    };

    const nerdyOverlap = overlapStats(nerdyResolved);
    const prodOverlap = overlapStats(prodResolved);
    slateStats.push({
      slate: s.slate, F: actuals.entries.length,
      nerdyMeanOwn: mean(nerdyResolved.map(r => r.avgOwn)),
      nerdyMaxTeam: maxTeamPct(nerdyResolved),
      nerdyStack5Plus: stack5PlusPct(nerdyResolved),
      nerdyMaxPitcher: maxPitcher(nerdyResolved) / nerdyResolved.length * 100,
      nerdyMaxOverlap: nerdyOverlap.max,
      nerdyMeanOverlap: nerdyOverlap.mean,
      nerdyUniquePlayers: uniquePlayers(nerdyResolved),
      prodMeanOwn: mean(prodResolved.map(r => r.avgOwn)),
      prodMaxTeam: maxTeamPct(prodResolved),
      prodStack5Plus: stack5PlusPct(prodResolved),
      prodMaxPitcher: maxPitcher(prodResolved) / prodResolved.length * 100,
      prodMaxOverlap: prodOverlap.max,
      prodMeanOverlap: prodOverlap.mean,
      prodUniquePlayers: uniquePlayers(prodResolved),
    });

    // Deep dive on 4-14 and 4-19 winners (nerdy only)
    if (s.slate === '4-14-26' || s.slate === '4-19-26') {
      const sortedDesc = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
      const top1T = sortedDesc[Math.max(0, Math.floor(actuals.entries.length * 0.01) - 1)];
      deepDiveWinners(`nerdytenor ${s.slate}`, nerdyResolved, actuals, top1T, sortedDesc, out);
    }
  }

  // ==============================================
  // HEADLINE COMPARISON TABLE
  // ==============================================
  out.push('\n\n---\n\n# Headline Comparison — nerdytenor vs production\n');
  out.push('Side-by-side per-slate (n=nerdytenor, p=production):\n');
  out.push('| Slate   | mean_own | max_team | 5+_stack | max_pitch | max_ovl | mean_ovl | unique_players |');
  out.push('|---------|---------:|---------:|---------:|----------:|--------:|---------:|---------------:|');
  for (const s of slateStats) {
    out.push(`| **${s.slate}** n | ${s.nerdyMeanOwn.toFixed(1)}% | ${s.nerdyMaxTeam.toFixed(1)}% | ${s.nerdyStack5Plus.toFixed(1)}% | ${s.nerdyMaxPitcher.toFixed(1)}% | ${s.nerdyMaxOverlap} | ${s.nerdyMeanOverlap.toFixed(2)} | ${s.nerdyUniquePlayers} |`);
    out.push(`| ${s.slate}    p | ${s.prodMeanOwn.toFixed(1)}% | ${s.prodMaxTeam.toFixed(1)}% | ${s.prodStack5Plus.toFixed(1)}% | ${s.prodMaxPitcher.toFixed(1)}% | ${s.prodMaxOverlap} | ${s.prodMeanOverlap.toFixed(2)} | ${s.prodUniquePlayers} |`);
  }

  // Averages across slates
  const avg = (getter: (s: SlateStats) => number) => mean(slateStats.map(getter));
  out.push('\n## Cross-slate averages\n');
  out.push(`|               | nerdytenor | production | delta |`);
  out.push(`|---------------|-----------:|-----------:|------:|`);
  out.push(`| mean ownership   | ${avg(s => s.nerdyMeanOwn).toFixed(2)}% | ${avg(s => s.prodMeanOwn).toFixed(2)}% | ${(avg(s => s.nerdyMeanOwn) - avg(s => s.prodMeanOwn)).toFixed(2)}pp |`);
  out.push(`| max team stack % | ${avg(s => s.nerdyMaxTeam).toFixed(2)}% | ${avg(s => s.prodMaxTeam).toFixed(2)}% | ${(avg(s => s.nerdyMaxTeam) - avg(s => s.prodMaxTeam)).toFixed(2)}pp |`);
  out.push(`| 5+-stack %       | ${avg(s => s.nerdyStack5Plus).toFixed(2)}% | ${avg(s => s.prodStack5Plus).toFixed(2)}% | ${(avg(s => s.nerdyStack5Plus) - avg(s => s.prodStack5Plus)).toFixed(2)}pp |`);
  out.push(`| max pitcher %    | ${avg(s => s.nerdyMaxPitcher).toFixed(2)}% | ${avg(s => s.prodMaxPitcher).toFixed(2)}% | ${(avg(s => s.nerdyMaxPitcher) - avg(s => s.prodMaxPitcher)).toFixed(2)}pp |`);
  out.push(`| max pairwise overlap | ${avg(s => s.nerdyMaxOverlap).toFixed(2)} | ${avg(s => s.prodMaxOverlap).toFixed(2)} | ${(avg(s => s.nerdyMaxOverlap) - avg(s => s.prodMaxOverlap)).toFixed(2)} |`);
  out.push(`| mean pairwise overlap | ${avg(s => s.nerdyMeanOverlap).toFixed(2)} | ${avg(s => s.prodMeanOverlap).toFixed(2)} | ${(avg(s => s.nerdyMeanOverlap) - avg(s => s.prodMeanOverlap)).toFixed(2)} |`);
  out.push(`| unique players   | ${avg(s => s.nerdyUniquePlayers).toFixed(1)} | ${avg(s => s.prodUniquePlayers).toFixed(1)} | ${(avg(s => s.nerdyUniquePlayers) - avg(s => s.prodUniquePlayers)).toFixed(1)} |`);

  const reportPath = path.join(DIR, 'nerdytenor_analysis.md');
  fs.writeFileSync(reportPath, out.join('\n'));
  console.log(`Report written: ${reportPath}`);
  console.log(`Total lines: ${out.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
