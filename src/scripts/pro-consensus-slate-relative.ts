/**
 * Pro Consensus Diagnostic — Slate-Relative version.
 *
 * Replaces absolute metrics (meanProj=98.75) with slate-relative ones
 * (projRatioToOptimal=0.76). Same 7 pros × 18 slates, but metrics now portable.
 *
 * Slate-relative metric set:
 *   - projRatioToOptimal       = mean_lineup_proj / max_lineup_proj_in_field
 *   - ceilingRatioToOptimal    = mean_lineup_ceiling / max_lineup_ceiling_in_field
 *   - ownDeltaFromAnchor       = mean_lineup_own - chalk_anchor_own
 *   - ownStdRatio              = ownStdWithinLineup / slate_avg_player_own
 *   - maxTeamExposureRel       = max_team_exposure / 50 (cosmetic — could use roster-fraction cap)
 *   - nonFourStackPct          (kept — already slate-portable)
 *   - meanPairwiseOverlap      (kept)
 *   - maxPairwiseOverlap       (kept)
 *   - uniqueTeamsRatio         = uniqueTeams / teams_in_slate
 *   - pctChalkPrimary          = pct of lineups with primary stack from top-3 ownership teams
 *   - pctContraPrimary         = pct of lineups with primary stack from bottom-3 ownership teams
 *   - avgPlayerOwnPctile       = avg ownership-rank-percentile of players used (0=lowest, 1=highest)
 */

import * as fs from 'fs';
import * as path from 'path';
import { Player } from '../types';
import {
  parseCSVFile, buildPlayerPool, parseContestActuals, ContestActuals,
} from '../parser';
import { getContestConfig } from '../rules';

const DIR = 'C:/Users/colin/dfs opto';

const SLATES = [
  { slate: '4-6-26', proj: '4-6-26_projections.csv', actuals: 'dkactuals 4-6-26.csv' },
  { slate: '4-8-26', proj: '4-8-26projections.csv', actuals: '4-8-26actuals.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv', actuals: '4-12-26actuals.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv', actuals: '4-14-26actuals.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv', actuals: '4-15-26actuals.csv' },
  { slate: '4-17-26', proj: '4-17-26projections.csv', actuals: '4-17-26actuals.csv' },
  { slate: '4-18-26', proj: '4-18-26projections.csv', actuals: '4-18-26actuals.csv' },
  { slate: '4-19-26', proj: '4-19-26projections.csv', actuals: '4-19-26actuals.csv' },
  { slate: '4-20-26', proj: '4-20-26projections.csv', actuals: '4-20-26actuals.csv' },
  { slate: '4-21-26', proj: '4-21-26projections.csv', actuals: '4-21-26actuals.csv' },
  { slate: '4-22-26', proj: '4-22-26projections.csv', actuals: '4-22-26actuals.csv' },
  { slate: '4-23-26', proj: '4-23-26projections.csv', actuals: '4-23-26actuals.csv' },
  { slate: '4-24-26', proj: '4-24-26projections.csv', actuals: '4-24-26actuals.csv' },
  { slate: '4-25-26', proj: '4-25-26projections.csv', actuals: '4-25-26actuals.csv' },
  { slate: '4-25-26-early', proj: '4-25-26projectionsearly.csv', actuals: '4-25-26actualsearly.csv' },
  { slate: '4-26-26', proj: '4-26-26projections.csv', actuals: '4-26-26actuals.csv' },
  { slate: '4-27-26', proj: '4-27-26projections.csv', actuals: '4-27-26actuals.csv' },
  { slate: '4-28-26', proj: '4-28-26projections.csv', actuals: '4-28-26actuals.csv' },
];

const PROS = [
  { label: 'nerdytenor', tokens: ['nerdytenor'] },
  { label: 'zroth', tokens: ['zroth', 'zroth2'] },
  { label: 'youdacao', tokens: ['youdacao'] },
  { label: 'shipmymoney', tokens: ['shipmymoney'] },
  { label: 'shaidyadvice', tokens: ['shaidyadvice'] },
  { label: 'bgreseth', tokens: ['bgreseth'] },
  { label: 'needlunchmoney', tokens: ['needlunchmoney'] },
];

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function mean(a: number[]): number { if (!a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; }
function stddev(a: number[]): number { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); }
function pearson(xs: number[], ys: number[]): number {
  const n = xs.length; if (n < 2) return 0;
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; num += dx * dy; dx2 += dx * dx; dy2 += dy * dy; }
  const den = Math.sqrt(dx2 * dy2);
  return den === 0 ? 0 : num / den;
}

interface SlateStats {
  // Field-level scalars used to make metrics slate-relative
  optimalLineupProj: number;       // max projection of any lineup in field
  optimalLineupCeiling: number;    // max ceiling of any lineup in field
  chalkAnchorOwn: number;          // mean ownership of top-3 highest-owned players
  slateAvgPlayerOwn: number;       // mean ownership across all players
  totalTeams: number;              // teams in slate
  chalkTeams: Set<string>;         // top-3 teams by aggregate ownership
  contraTeams: Set<string>;        // bottom-3 teams by aggregate ownership
  ownPercentileByPlayerId: Map<string, number>; // each player's rank-percentile by ownership
}

interface SlateRelativeMetrics {
  projRatioToOptimal: number;
  ceilingRatioToOptimal: number;
  ownDeltaFromAnchor: number;
  ownStdRatio: number;
  meanPairwiseOverlap: number;
  maxPairwiseOverlap: number;
  nonFourStackPct: number;
  uniqueTeamsRatio: number;
  pctChalkPrimary: number;
  pctContraPrimary: number;
  avgPlayerOwnPctile: number;
  maxTeamExposureRel: number;
}
const SR_KEYS = [
  'projRatioToOptimal', 'ceilingRatioToOptimal', 'ownDeltaFromAnchor', 'ownStdRatio',
  'meanPairwiseOverlap', 'maxPairwiseOverlap', 'nonFourStackPct', 'uniqueTeamsRatio',
  'pctChalkPrimary', 'pctContraPrimary', 'avgPlayerOwnPctile', 'maxTeamExposureRel',
] as const;

function computeSlateStats(players: Player[], allLineups: Player[][]): SlateStats {
  // Optimal lineup proj/ceiling = max in field
  let optProj = 0, optCeil = 0;
  // Pre-compute lineup-level ownership and projection for chalk anchor
  const lineupOwnPairs: { meanOwn: number; lu: Player[] }[] = [];
  for (const lu of allLineups) {
    let p = 0, c = 0, o = 0;
    for (const pl of lu) {
      p += pl.projection || 0;
      c += (pl as any).ceiling || (pl.projection || 0) * 1.4;
      o += pl.ownership || 0;
    }
    if (p > optProj) optProj = p;
    if (c > optCeil) optCeil = c;
    lineupOwnPairs.push({ meanOwn: o / lu.length, lu });
  }
  // Chalk anchor = mean lineup-ownership of TOP 100 lineups by mean lineup-ownership
  // (what the field's most-chalked lineups look like)
  lineupOwnPairs.sort((a, b) => b.meanOwn - a.meanOwn);
  const topN = Math.min(100, lineupOwnPairs.length);
  const chalkAnchor = mean(lineupOwnPairs.slice(0, topN).map(x => x.meanOwn));
  // Slate avg own
  const slateAvg = mean(players.map(p => p.ownership || 0));
  // Teams
  const teams = new Set<string>(players.map(p => p.team));
  // Team aggregate ownership (only count non-pitchers since hitters get stacked)
  const teamOwn = new Map<string, number>();
  for (const p of players) {
    if (p.positions?.includes('P')) continue;
    teamOwn.set(p.team, (teamOwn.get(p.team) || 0) + (p.ownership || 0));
  }
  const teamSorted = [...teamOwn.entries()].sort((a, b) => b[1] - a[1]);
  const chalkTeams = new Set(teamSorted.slice(0, 3).map(([t]) => t));
  const contraTeams = new Set(teamSorted.slice(-3).map(([t]) => t));
  // Player ownership percentile (rank/total)
  const ownPctile = new Map<string, number>();
  const sortedByOwn = [...players].sort((a, b) => (a.ownership || 0) - (b.ownership || 0));
  for (let i = 0; i < sortedByOwn.length; i++) {
    ownPctile.set(sortedByOwn[i].id, sortedByOwn.length > 1 ? i / (sortedByOwn.length - 1) : 0);
  }
  return {
    optimalLineupProj: optProj,
    optimalLineupCeiling: optCeil,
    chalkAnchorOwn: chalkAnchor,
    slateAvgPlayerOwn: slateAvg,
    totalTeams: teams.size,
    chalkTeams,
    contraTeams,
    ownPercentileByPlayerId: ownPctile,
  };
}

function computeSlateRelativeMetrics(lineups: Player[][], stats: SlateStats): SlateRelativeMetrics {
  if (!lineups.length) return SR_KEYS.reduce((acc, k) => { acc[k] = 0; return acc; }, {} as any) as SlateRelativeMetrics;

  const luProjs: number[] = [], luCeils: number[] = [], luOwns: number[] = [], luOwnStds: number[] = [];
  let nonFour = 0;
  let chalkPrimary = 0, contraPrimary = 0;
  const allStackTeams = new Set<string>();
  const teamExp = new Map<string, number>();
  const pidSets: Set<string>[] = [];
  const allPctileSums: number[] = [];

  for (const players of lineups) {
    const owns = players.map(p => p.ownership || 0);
    luOwns.push(mean(owns));
    luProjs.push(players.reduce((s, p) => s + (p.projection || 0), 0));
    luCeils.push(players.reduce((s, p) => s + ((p as any).ceiling || (p.projection || 0) * 1.4), 0));
    luOwnStds.push(stddev(owns));

    // Player ownership percentile sum
    let pctileSum = 0;
    for (const p of players) pctileSum += stats.ownPercentileByPlayerId.get(p.id) || 0;
    allPctileSums.push(pctileSum / players.length);

    // Stack analysis
    const counts = new Map<string, number>();
    for (const p of players) if (!p.positions?.includes('P')) counts.set(p.team, (counts.get(p.team) || 0) + 1);
    let maxCount = 0, maxTeam: string | null = null;
    for (const [t, c] of counts) { if (c > maxCount) { maxCount = c; maxTeam = t; } if (c >= 4) allStackTeams.add(t); }
    if (maxCount < 4) nonFour++;
    if (maxTeam && maxCount >= 4) {
      teamExp.set(maxTeam, (teamExp.get(maxTeam) || 0) + 1);
      if (stats.chalkTeams.has(maxTeam)) chalkPrimary++;
      if (stats.contraTeams.has(maxTeam)) contraPrimary++;
    }
    pidSets.push(new Set(players.map(p => p.id)));
  }
  let maxOvl = 0, sumOvl = 0, pairs = 0;
  for (let i = 0; i < pidSets.length; i++) for (let j = i + 1; j < pidSets.length; j++) {
    let o = 0; for (const id of pidSets[i]) if (pidSets[j].has(id)) o++;
    if (o > maxOvl) maxOvl = o;
    sumOvl += o; pairs++;
  }
  const meanLuOwn = mean(luOwns);
  const meanLuOwnStd = mean(luOwnStds);
  const maxTeamExp = teamExp.size > 0 ? Math.max(...teamExp.values()) / lineups.length : 0;
  return {
    projRatioToOptimal: stats.optimalLineupProj > 0 ? mean(luProjs) / stats.optimalLineupProj : 0,
    ceilingRatioToOptimal: stats.optimalLineupCeiling > 0 ? mean(luCeils) / stats.optimalLineupCeiling : 0,
    ownDeltaFromAnchor: meanLuOwn - stats.chalkAnchorOwn,
    ownStdRatio: stats.slateAvgPlayerOwn > 0 ? meanLuOwnStd / stats.slateAvgPlayerOwn : 0,
    meanPairwiseOverlap: pairs > 0 ? sumOvl / pairs : 0,
    maxPairwiseOverlap: maxOvl,
    nonFourStackPct: nonFour / lineups.length * 100,
    uniqueTeamsRatio: stats.totalTeams > 0 ? allStackTeams.size / stats.totalTeams : 0,
    pctChalkPrimary: chalkPrimary / lineups.length * 100,
    pctContraPrimary: contraPrimary / lineups.length * 100,
    avgPlayerOwnPctile: mean(allPctileSums),
    maxTeamExposureRel: maxTeamExp,
  };
}

function extractPro(actuals: ContestActuals, nameMap: Map<string, Player>, tokens: string[]): Player[][] {
  const out: Player[][] = [];
  for (const e of actuals.entries) {
    const en = (e.entryName || '').toLowerCase();
    if (!tokens.some(t => en.includes(t))) continue;
    const pls: Player[] = []; let ok = true;
    for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
    if (ok) out.push(pls);
  }
  return out;
}

async function main() {
  console.log('================================================================');
  console.log('PRO CONSENSUS DIAGNOSTIC — SLATE-RELATIVE');
  console.log('================================================================\n');

  // For each slate: compute slate stats, extract all entries (for optimal computation), extract pros
  const slateProMetrics: Map<string, Map<string, SlateRelativeMetrics>> = new Map();
  const proSlateCount: Map<string, number> = new Map();
  for (const p of PROS) proSlateCount.set(p.label, 0);

  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj), actualsPath = path.join(DIR, s.actuals);
    if (!fs.existsSync(projPath) || !fs.existsSync(actualsPath)) {
      console.log('  ' + s.slate + ': MISSING'); continue;
    }
    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);
    const nameMap = new Map<string, Player>();
    for (const p of pool.players) nameMap.set(norm(p.name), p);

    // Build all field lineups for optimal computation
    const allFieldLineups: Player[][] = [];
    for (const e of actuals.entries) {
      const pls: Player[] = []; let ok = true;
      for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
      if (ok) allFieldLineups.push(pls);
    }
    if (allFieldLineups.length < 100) { console.log('  ' + s.slate + ': only ' + allFieldLineups.length + ' valid field lineups, skip'); continue; }

    const slateStats = computeSlateStats(pool.players, allFieldLineups);

    const proMap = new Map<string, SlateRelativeMetrics>();
    const counts: string[] = [];
    for (const p of PROS) {
      const lineups = extractPro(actuals, nameMap, p.tokens);
      counts.push(p.label.slice(0, 8) + '=' + lineups.length);
      if (lineups.length >= 30) {
        proMap.set(p.label, computeSlateRelativeMetrics(lineups, slateStats));
        proSlateCount.set(p.label, proSlateCount.get(p.label)! + 1);
      }
    }
    slateProMetrics.set(s.slate, proMap);
    console.log('  ' + s.slate.padEnd(15) + ' opt=' + slateStats.optimalLineupProj.toFixed(0) + ' chalk=' + slateStats.chalkAnchorOwn.toFixed(1) + '% teams=' + slateStats.totalTeams + ' | ' + counts.join(' '));
  }

  const COVERAGE_MIN = 8;
  const validPros = PROS.filter(p => (proSlateCount.get(p.label) || 0) >= COVERAGE_MIN);
  console.log('\nValid pros (≥' + COVERAGE_MIN + ' slates):');
  for (const p of validPros) console.log('  ' + p.label.padEnd(18) + ' ' + proSlateCount.get(p.label) + ' slates');

  // Pairwise inter-pro tracking with slate-relative metrics
  console.log('\n================================================================');
  console.log('PAIRWISE INTER-PRO TRACKING — SLATE-RELATIVE (avg |r| across 12 metrics)');
  console.log('================================================================\n');
  const pairwiseR: Map<string, number> = new Map();
  for (let i = 0; i < validPros.length; i++) {
    for (let j = i + 1; j < validPros.length; j++) {
      const a = validPros[i].label, b = validPros[j].label;
      const commonSlates = SLATES.map(s => s.slate).filter(sl => {
        const m = slateProMetrics.get(sl);
        return m && m.has(a) && m.has(b);
      });
      if (commonSlates.length < 5) continue;
      const rs: number[] = [];
      for (const k of SR_KEYS) {
        const xs = commonSlates.map(sl => (slateProMetrics.get(sl)!.get(a)! as any)[k]);
        const ys = commonSlates.map(sl => (slateProMetrics.get(sl)!.get(b)! as any)[k]);
        rs.push(pearson(xs, ys));
      }
      const comp = mean(rs.map(r => Math.abs(r)));
      pairwiseR.set([a, b].sort().join(' x '), comp);
    }
  }
  // Print all pairwise
  console.log('Pairwise composite |r|:');
  for (const [k, v] of [...pairwiseR.entries()].sort((a, b) => b[1] - a[1])) {
    console.log('  ' + k.padEnd(40) + ' = ' + v.toFixed(3));
  }
  const allR = [...pairwiseR.values()];
  console.log('\nAverage: ' + mean(allR).toFixed(3) + '  min: ' + Math.min(...allR).toFixed(3) + '  max: ' + Math.max(...allR).toFixed(3));

  // Per-metric agreement (slate-relative)
  console.log('\n================================================================');
  console.log('PER-METRIC PRO AGREEMENT — SLATE-RELATIVE');
  console.log('================================================================\n');
  console.log('Metric                       | pro mean | pro std  | CV     | agreement');
  for (const k of SR_KEYS) {
    const slateStats: { mean: number; std: number }[] = [];
    for (const sl of SLATES.map(s => s.slate)) {
      const m = slateProMetrics.get(sl); if (!m) continue;
      const vals: number[] = [];
      for (const p of validPros) {
        const pm = m.get(p.label); if (pm) vals.push((pm as any)[k]);
      }
      if (vals.length >= 3) slateStats.push({ mean: mean(vals), std: stddev(vals) });
    }
    if (!slateStats.length) continue;
    const avgMean = mean(slateStats.map(s => s.mean));
    const avgStd = mean(slateStats.map(s => s.std));
    const cv = Math.abs(avgMean) > 1e-9 ? avgStd / Math.abs(avgMean) : NaN;
    const tight = isNaN(cv) ? '?' : cv < 0.10 ? '✅ TIGHT' : cv < 0.20 ? '🟡 MEDIUM' : '❌ LOOSE';
    console.log('  ' + k.padEnd(28) + '| ' + avgMean.toFixed(3).padStart(7) + '  | ' + avgStd.toFixed(3).padStart(7) + '  | ' + (isNaN(cv) ? 'n/a'.padStart(6) : cv.toFixed(3).padStart(6)) + ' | ' + tight);
  }

  // Save consensus
  const consensus: any = { metrics: {}, pros: validPros.map(p => p.label) };
  for (const k of SR_KEYS) {
    const slateConsensus: { slate: string; mean: number; std: number }[] = [];
    for (const sl of SLATES.map(s => s.slate)) {
      const m = slateProMetrics.get(sl); if (!m) continue;
      const vals: number[] = [];
      for (const p of validPros) {
        const pm = m.get(p.label); if (pm) vals.push((pm as any)[k]);
      }
      if (vals.length >= 3) slateConsensus.push({ slate: sl, mean: mean(vals), std: stddev(vals) });
    }
    consensus.metrics[k] = slateConsensus;
  }
  fs.writeFileSync(path.join(DIR, 'pro_consensus_slate_relative.json'), JSON.stringify(consensus, null, 0));
  console.log('\nConsensus signature saved.');

  // Show per-slate consensus values for the most-tracked metrics
  console.log('\n=== PER-SLATE CONSENSUS for high-agreement metrics (sanity check) ===');
  const showMetrics = ['projRatioToOptimal', 'ceilingRatioToOptimal', 'ownDeltaFromAnchor', 'ownStdRatio'];
  console.log('slate'.padEnd(15) + showMetrics.map(m => m.slice(0, 14).padStart(15)).join(''));
  for (const sl of SLATES.map(s => s.slate)) {
    const m = slateProMetrics.get(sl); if (!m) continue;
    const row = sl.padEnd(15);
    let line = row;
    for (const k of showMetrics) {
      const vals: number[] = [];
      for (const p of validPros) { const pm = m.get(p.label); if (pm) vals.push((pm as any)[k]); }
      if (vals.length >= 3) {
        line += (mean(vals).toFixed(3).padStart(8) + '±' + stddev(vals).toFixed(3).padStart(5)).padStart(15);
      } else {
        line += '       n/a     '.padStart(15);
      }
    }
    console.log(line);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
