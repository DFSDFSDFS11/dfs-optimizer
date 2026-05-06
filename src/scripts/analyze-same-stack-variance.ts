/**
 * Same-Stack Overlap + Variance-vs-Projection Analysis.
 *
 * Two orthogonal questions about structural rules beyond global γ=7:
 *
 *   (1) Within-same-stack overlap — when two lineups share the same primary
 *       stack team, how similar are they? nerdy might enforce a sub-γ on
 *       same-stack pairs (differentiated bets) vs. letting near-duplicates exist.
 *
 *   (2) Variance-vs-projection — does variance scale INVERSELY with projection
 *       in nerdy's portfolio? Low-projection lineups constructed for high ceiling
 *       to justify the lower floor? Production's ownership filter is neutral on
 *       variance; if nerdy actively selects for variance in the contrarian tail,
 *       that's a missing mechanism.
 *
 * Output: markdown report, per-slate + cross-slate.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import {
  parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV,
} from '../parser';
import { getContestConfig } from '../rules';
import { generateWorlds } from '../v35/simulation';
import { productionSelect } from '../selection/production-selector';
import { precomputeComboFrequencies } from '../selection/combo-leverage';

const DIR = 'C:/Users/colin/dfs opto';
const N = 150;
const LAMBDA = 0.05;
const GAMMA = 7;
const NUM_WORLDS = 3000;
const SEED = 12345;

const SLATES = [
  { slate: '4-6-26', proj: '4-6-26_projections.csv', actuals: 'dkactuals 4-6-26.csv', pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26', proj: '4-8-26projections.csv', actuals: '4-8-26actuals.csv', pool: '4-8-26sspool.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv', actuals: '4-12-26actuals.csv', pool: '4-12-26sspool.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv', actuals: '4-14-26actuals.csv', pool: '4-14-26sspool.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv', actuals: '4-15-26actuals.csv', pool: '4-15-26sspool.csv' },
  { slate: '4-17-26', proj: '4-17-26projections.csv', actuals: '4-17-26actuals.csv', pool: '4-17-26sspool.csv' },
  { slate: '4-19-26', proj: '4-19-26projections.csv', actuals: '4-19-26actuals.csv', pool: '4-19-26sspool.csv' },
  { slate: '4-20-26', proj: '4-20-26projections.csv', actuals: '4-20-26actuals.csv', pool: '4-20-26sspool.csv' },
];

function norm(n: string): string {
  return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function mean(arr: Float64Array | number[]): number {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return arr.length ? s / arr.length : 0;
}

function variance(arr: Float64Array | number[]): number {
  const m = mean(arr);
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += (arr[i] - m) * (arr[i] - m);
  return arr.length ? s / arr.length : 0;
}

function primaryStackTeam(players: Player[]): { team: string | null; size: number } {
  const counts = new Map<string, number>();
  for (const p of players) {
    if (!p.positions?.includes('P')) counts.set(p.team, (counts.get(p.team) || 0) + 1);
  }
  let maxT: string | null = null, maxN = 0;
  for (const [t, n] of counts) if (n > maxN) { maxN = n; maxT = t; }
  return maxN >= 4 ? { team: maxT, size: maxN } : { team: null, size: maxN };
}

function overlapCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const id of a) if (b.has(id)) n++;
  return n;
}

function resolveLineup(playerNames: string[], nameMap: Map<string, Player>): Player[] | null {
  const pls: Player[] = [];
  for (const nm of playerNames) {
    const p = nameMap.get(norm(nm));
    if (!p) return null;
    pls.push(p);
  }
  return pls;
}

interface ResolvedLineup {
  players: Player[];
  pidSet: Set<string>;
  stackTeam: string | null;
  stackSize: number;
  projection: number;
  variance: number;  // computed from scenarios if available
}

function sameStackAnalysis(label: string, lineups: ResolvedLineup[], out: string[]) {
  // Group by primary stack team (including nulls as "no-stack" bucket)
  const groups = new Map<string, ResolvedLineup[]>();
  for (const l of lineups) {
    const key = l.stackTeam ?? '__none__';
    let arr = groups.get(key);
    if (!arr) { arr = []; groups.set(key, arr); }
    arr.push(l);
  }

  // For each team with 2+ same-stack lineups, compute pairwise overlaps within group
  const sameStackOverlaps: number[] = [];
  const crossStackOverlaps: number[] = [];
  const teamStats: Array<{ team: string; n: number; max: number; mean: number; minDiff: number }> = [];

  for (const [team, arr] of groups) {
    if (team === '__none__') continue; // no-stack bucket doesn't get same-stack semantics
    if (arr.length < 2) continue;
    let teamMax = 0, teamSum = 0, teamPairs = 0;
    let teamMinDiff = 10;
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const o = overlapCount(arr[i].pidSet, arr[j].pidSet);
        sameStackOverlaps.push(o);
        teamSum += o; teamPairs++;
        if (o > teamMax) teamMax = o;
        const diff = 10 - o;
        if (diff < teamMinDiff) teamMinDiff = diff;
      }
    }
    teamStats.push({
      team, n: arr.length,
      max: teamMax,
      mean: teamPairs > 0 ? teamSum / teamPairs : 0,
      minDiff: teamMinDiff,
    });
  }

  // Cross-stack (different primary stacks, or one is no-stack)
  const teamList = [...groups.entries()];
  for (let gi = 0; gi < teamList.length; gi++) {
    for (let gj = gi + 1; gj < teamList.length; gj++) {
      const [tA, arrA] = teamList[gi];
      const [tB, arrB] = teamList[gj];
      // Always cross-stack (different teams), but skip noStack vs noStack if both null
      for (const a of arrA) for (const b of arrB) {
        crossStackOverlaps.push(overlapCount(a.pidSet, b.pidSet));
      }
    }
  }

  out.push(`\n### ${label} — same-stack overlap analysis\n`);
  if (sameStackOverlaps.length === 0) {
    out.push('  (no same-stack pairs)');
    return { sameMax: 0, sameMean: 0, sameN: 0, crossMean: 0 };
  }
  const sameMax = Math.max(...sameStackOverlaps);
  const sameMean = mean(sameStackOverlaps);
  const crossMax = crossStackOverlaps.length ? Math.max(...crossStackOverlaps) : 0;
  const crossMean = crossStackOverlaps.length ? mean(crossStackOverlaps) : 0;

  out.push(`  Same-stack pairs: ${sameStackOverlaps.length}  max=${sameMax}  mean=${sameMean.toFixed(2)}`);
  out.push(`  Cross-stack pairs: ${crossStackOverlaps.length}  max=${crossMax}  mean=${crossMean.toFixed(2)}`);
  out.push(`  Histogram of same-stack overlaps:`);
  const hist = new Array(11).fill(0);
  for (const o of sameStackOverlaps) hist[o]++;
  out.push(`    ${hist.map((c, i) => `${i}=${c}`).join('  ')}`);
  out.push('');
  out.push(`  Per-team (teams with ≥2 same-stack lineups):`);
  for (const ts of teamStats.sort((a, b) => b.n - a.n)) {
    out.push(`    ${ts.team.padEnd(5)} n=${ts.n.toString().padStart(3)}  max=${ts.max}  mean=${ts.mean.toFixed(2)}  min differentiation=${ts.minDiff}/10`);
  }

  return { sameMax, sameMean, sameN: sameStackOverlaps.length, crossMean };
}

function varianceByProjectionBins(
  label: string,
  lineups: ResolvedLineup[],
  out: string[],
): { bins: Array<{ band: string; n: number; proj: number; var: number; sd: number }> } {
  // Rank by projection
  const sorted = [...lineups].sort((a, b) => a.projection - b.projection);
  const n = sorted.length;
  const bins = [
    { band: 'Q1 lowest proj (bottom 20%)', lo: 0.0, hi: 0.2 },
    { band: 'Q2 (20-40%)', lo: 0.2, hi: 0.4 },
    { band: 'Q3 (40-60%)', lo: 0.4, hi: 0.6 },
    { band: 'Q4 (60-80%)', lo: 0.6, hi: 0.8 },
    { band: 'Q5 highest proj (top 20%)', lo: 0.8, hi: 1.0 },
  ];
  out.push(`\n### ${label} — variance by projection quintile\n`);
  out.push(`  Band                        | n  | mean proj | mean var | mean stddev`);
  out.push(`  ----------------------------|----|-----------|----------|------------`);
  const binResults = [];
  for (const b of bins) {
    const lo = Math.floor(n * b.lo);
    const hi = Math.floor(n * b.hi);
    const slice = sorted.slice(lo, hi);
    const meanProj = mean(slice.map(l => l.projection));
    const meanVar = mean(slice.map(l => l.variance));
    const meanSd = Math.sqrt(meanVar);
    out.push(`  ${b.band.padEnd(27)} | ${slice.length.toString().padStart(2)} | ${meanProj.toFixed(2).padStart(9)} | ${meanVar.toFixed(1).padStart(8)} | ${meanSd.toFixed(2).padStart(11)}`);
    binResults.push({ band: b.band, n: slice.length, proj: meanProj, var: meanVar, sd: meanSd });
  }
  return { bins: binResults };
}

function scoreVariance(
  lineup: Player[],
  playerIndexMap: Map<string, number>,
  scores: Float32Array,
  numWorlds: number,
): number {
  const indices: number[] = [];
  for (const p of lineup) {
    const idx = playerIndexMap.get(p.id);
    if (idx !== undefined) indices.push(idx);
  }
  const scoreVec = new Float64Array(numWorlds);
  for (let w = 0; w < numWorlds; w++) {
    let s = 0;
    for (const pi of indices) s += scores[pi * numWorlds + w];
    scoreVec[w] = s;
  }
  return variance(scoreVec);
}

async function main() {
  const out: string[] = [];
  out.push('# Same-Stack Overlap + Variance-vs-Projection Analysis');
  out.push(`Generated ${new Date().toISOString()}`);
  out.push(`\nProduction config: λ=${LAMBDA}, γ=${GAMMA} (shipped defaults). ${NUM_WORLDS} scenarios for variance.\n`);

  type SlateAgg = {
    slate: string;
    nerdySame: { sameMax: number; sameMean: number; sameN: number; crossMean: number };
    prodSame: { sameMax: number; sameMean: number; sameN: number; crossMean: number };
    nerdyBins: Array<{ band: string; n: number; proj: number; var: number; sd: number }>;
    prodBins: Array<{ band: string; n: number; proj: number; var: number; sd: number }>;
  };
  const agg: SlateAgg[] = [];

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
    const idMap = new Map<string, Player>();
    for (const p of pool.players) idMap.set(p.id, p);

    const nerdyEntries = actuals.entries.filter(e => e.entryName.toLowerCase().includes('nerdytenor'));
    if (nerdyEntries.length === 0) continue;

    const nerdyRaw = nerdyEntries.map(e => resolveLineup(e.playerNames, nameMap))
      .filter((x): x is Player[] => x !== null);

    const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
    const comboFreq = precomputeComboFrequencies(loaded.lineups, 3);
    const prodResult = productionSelect(loaded.lineups, pool.players, {
      N, lambda: LAMBDA, comboFreq, maxOverlap: GAMMA,
    });
    const prodRaw = prodResult.portfolio.map(lu => lu.players);

    // Generate scenarios for variance
    console.log(`  ${s.slate}: generating ${NUM_WORLDS} scenarios...`);
    const sim = generateWorlds(pool.players, NUM_WORLDS, 5, SEED);
    const playerIndexMap = new Map<string, number>();
    for (let i = 0; i < pool.players.length; i++) playerIndexMap.set(pool.players[i].id, i);

    function enrich(raw: Player[][]): ResolvedLineup[] {
      return raw.map(players => {
        const stack = primaryStackTeam(players);
        return {
          players,
          pidSet: new Set(players.map(p => p.id)),
          stackTeam: stack.team,
          stackSize: stack.size,
          projection: players.reduce((s, p) => s + (p.projection || 0), 0),
          variance: scoreVariance(players, playerIndexMap, sim.scores, NUM_WORLDS),
        };
      });
    }

    const nerdy = enrich(nerdyRaw);
    const prod = enrich(prodRaw);

    out.push(`\n\n---\n\n# ${s.slate}`);
    out.push(`Field: ${actuals.entries.length.toLocaleString()}, Pool: ${loaded.lineups.length}, Nerdy lineups: ${nerdy.length}, Prod: ${prod.length}\n`);

    out.push(`\n## 1) Same-Stack Overlap\n`);
    const nerdySame = sameStackAnalysis('nerdytenor', nerdy, out);
    const prodSame = sameStackAnalysis('production', prod, out);

    out.push(`\n## 2) Variance by Projection Quintile\n`);
    const nerdyBins = varianceByProjectionBins('nerdytenor', nerdy, out).bins;
    const prodBins = varianceByProjectionBins('production', prod, out).bins;

    agg.push({ slate: s.slate, nerdySame, prodSame, nerdyBins, prodBins });
  }

  // ============================================================
  // CROSS-SLATE SUMMARY
  // ============================================================
  out.push('\n\n---\n\n# Cross-Slate Summary\n');

  out.push('## Same-stack overlap\n');
  out.push('| Slate | nerdy max | nerdy mean | prod max | prod mean | Δ mean (n-p) |');
  out.push('|---|---:|---:|---:|---:|---:|');
  for (const a of agg) {
    const d = a.nerdySame.sameMean - a.prodSame.sameMean;
    out.push(`| ${a.slate} | ${a.nerdySame.sameMax} | ${a.nerdySame.sameMean.toFixed(2)} | ${a.prodSame.sameMax} | ${a.prodSame.sameMean.toFixed(2)} | ${d >= 0 ? '+' : ''}${d.toFixed(2)} |`);
  }
  out.push(`| **AVG** | ${mean(agg.map(a => a.nerdySame.sameMax)).toFixed(2)} | ${mean(agg.map(a => a.nerdySame.sameMean)).toFixed(2)} | ${mean(agg.map(a => a.prodSame.sameMax)).toFixed(2)} | ${mean(agg.map(a => a.prodSame.sameMean)).toFixed(2)} | ${(mean(agg.map(a => a.nerdySame.sameMean)) - mean(agg.map(a => a.prodSame.sameMean))).toFixed(2)} |`);

  out.push('\n## Variance by projection quintile (cross-slate means)\n');
  const bandLabels = ['Q1 lowest proj', 'Q2', 'Q3', 'Q4', 'Q5 highest proj'];
  out.push('| Quintile | nerdy mean proj | nerdy mean stddev | prod mean proj | prod mean stddev | Δ stddev (n-p) |');
  out.push('|---|---:|---:|---:|---:|---:|');
  for (let bi = 0; bi < 5; bi++) {
    const nerdyProj = mean(agg.map(a => a.nerdyBins[bi].proj));
    const nerdySd = mean(agg.map(a => a.nerdyBins[bi].sd));
    const prodProj = mean(agg.map(a => a.prodBins[bi].proj));
    const prodSd = mean(agg.map(a => a.prodBins[bi].sd));
    const d = nerdySd - prodSd;
    out.push(`| ${bandLabels[bi]} | ${nerdyProj.toFixed(2)} | ${nerdySd.toFixed(2)} | ${prodProj.toFixed(2)} | ${prodSd.toFixed(2)} | ${d >= 0 ? '+' : ''}${d.toFixed(2)} |`);
  }

  out.push('\n### Interpretation\n');
  out.push('If nerdy\'s Q1 (lowest proj) stddev > Q5 (highest proj) stddev, variance scales INVERSELY with projection — low-proj lineups are built for ceiling.');
  out.push('If production shows the same pattern, no structural gap on variance. If production\'s pattern is flat or positive (higher proj = higher variance), that\'s a missing mechanism.\n');
  // Explicit nerdy Q1 vs Q5 sd comparison
  const nerdyQ1sd = mean(agg.map(a => a.nerdyBins[0].sd));
  const nerdyQ5sd = mean(agg.map(a => a.nerdyBins[4].sd));
  const prodQ1sd = mean(agg.map(a => a.prodBins[0].sd));
  const prodQ5sd = mean(agg.map(a => a.prodBins[4].sd));
  out.push(`  nerdy Q1 stddev - Q5 stddev = ${(nerdyQ1sd - nerdyQ5sd).toFixed(2)}  ${nerdyQ1sd > nerdyQ5sd ? '(inverse: low proj → higher var)' : '(positive/flat: low proj → lower var)'}`);
  out.push(`  prod  Q1 stddev - Q5 stddev = ${(prodQ1sd - prodQ5sd).toFixed(2)}  ${prodQ1sd > prodQ5sd ? '(inverse: low proj → higher var)' : '(positive/flat: low proj → lower var)'}`);
  out.push(`  Gap (nerdy Q1-Q5 minus prod Q1-Q5) = ${((nerdyQ1sd - nerdyQ5sd) - (prodQ1sd - prodQ5sd)).toFixed(2)}`);

  const reportPath = path.join(DIR, 'same_stack_variance_analysis.md');
  fs.writeFileSync(reportPath, out.join('\n'));
  console.log(`Report: ${reportPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
