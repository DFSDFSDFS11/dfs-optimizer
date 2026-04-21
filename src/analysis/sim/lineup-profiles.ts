/**
 * Part 1: LINEUP-LEVEL analysis.
 *
 * Builds a LineupProfile for every lineup (or a representative sample), then
 * runs separation / quintile / projection-vs-actual analyses.
 */

import { Lineup, Player, Sport } from '../../types';
import { ContestEntry } from '../../parser/actuals-parser';
import { SlatePrecomputation } from '../../selection/algorithm7-selector';
import {
  computeMeanAndVar,
  effectSize,
  percentileOfRow,
  playerPairCorrelation,
  scoreLineups,
  spearmanCorrelation,
} from './sim-core';
import { countTeamPlayers, primaryStackTeam } from '../common';

// ============================================================
// TYPES
// ============================================================

export interface LineupProfile {
  hash: string;
  rank: number;
  actualScore: number;
  actualRank: number;

  // Projection
  projectedScore: number;
  projectionError: number;
  projectionErrorPct: number;

  // Variance (from sim)
  simVariance: number;
  simStdDev: number;
  p95Score: number;
  p99Score: number;
  ceilingRatio: number;

  // Correlation (within-lineup pairs via player world scores)
  positiveCorrPairs: number;   // ρ > 0.05
  negativeCorrPairs: number;   // ρ < -0.05
  netCorrelation: number;
  avgWithinCorrelation: number;

  // Stack
  primaryStackTeam: string;
  primaryStackDepth: number;
  secondaryStackTeam: string | null;
  secondaryStackDepth: number;
  bringBackTeam: string | null;
  bringBackCount: number;
  teamsRepresented: number;
  gameEnvironments: number;

  // Ownership
  avgOwnership: number;
  minOwnership: number;
  maxOwnership: number;
  ownershipProduct: number;

  // Salary
  totalSalary: number;
  avgPlayerSalary: number;
  salaryStdDev: number;
}

export interface QuintileRow {
  bucket: number;
  lineupCount: number;
  top1HitRate: number;
  top5HitRate: number;
  avgActual: number;
  avgProjection: number;
  avgVariance: number;
}

export interface SeparationMetric {
  metric: string;
  top1Avg: number;
  fieldAvg: number;
  fieldStd: number;
  effectSize: number;           // Cohen-style
  direction: 'higher' | 'lower';
  researchPrediction?: string;
  researchMatch?: boolean;
}

export interface LineupLevelAnalysis {
  lineupCount: number;
  profileSample: LineupProfile[];   // full set of profiles

  // Separation
  separationMetrics: SeparationMetric[];

  // Quintiles
  varianceQuintiles: QuintileRow[];
  ownershipQuintiles: QuintileRow[];
  stackDepthBreakdown: QuintileRow[];

  // Spearman projection vs actual
  projectionActualCorrelation: number;

  // Ideal lineup profile
  idealLineupProfile: LineupProfile | null;
  bestPoolLineupProfile: LineupProfile | null;
  mostCommonFieldPlayers: string[];
}

// ============================================================
// MAIN
// ============================================================

export function analyzeLineupLevel(
  fieldLineups: Lineup[],
  poolLineups: Lineup[] | null,
  entryHashes: (string | null)[],
  contestEntries: ContestEntry[],
  hashScores: Map<string, number>,
  precomp: SlatePrecomputation,
  sport: Sport,
): LineupLevelAnalysis {
  const W = precomp.W;
  const N = fieldLineups.length;

  // Score every field lineup across worlds
  const fieldScores = scoreLineups(fieldLineups, precomp);
  const { means: fieldMeans, vars: fieldVars } = computeMeanAndVar(fieldScores, N, W);

  // Pre-compute hash→lineupIndex and hash→actual
  const hashToIdx = new Map<string, number>();
  fieldLineups.forEach((l, i) => hashToIdx.set(l.hash, i));

  // Actuals-based ranks
  const sortedActuals = contestEntries.map(e => e.actualPoints).sort((a, b) => b - a);
  const rankOf = (s: number) => {
    let lo = 0, hi = sortedActuals.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sortedActuals[mid] >= s) lo = mid + 1; else hi = mid;
    }
    return Math.max(1, lo);
  };

  // Build profiles for every field lineup
  const profiles: LineupProfile[] = [];
  for (let i = 0; i < N; i++) {
    const lu = fieldLineups[i];
    const actual = hashScores.get(lu.hash) ?? 0;
    const profile = buildProfile(lu, i, fieldScores, fieldMeans[i], fieldVars[i], W, precomp, sport, actual, rankOf(actual));
    profiles.push(profile);
  }

  // ─── Separation analysis ───
  const thresholds = computePercentileScore(contestEntries, 0.01);
  const isTop1 = profiles.map(p => p.actualScore >= thresholds);
  const separationMetrics = computeSeparation(profiles, isTop1, sport);

  // ─── Quintile bins ───
  const varianceQuintiles = binAndCompute(profiles, isTop1, p => p.simVariance, 5);
  const ownershipQuintiles = binAndCompute(profiles, isTop1, p => p.avgOwnership, 5);

  // Stack depth: discrete bins 2,3,4,5,6+
  const stackDepthBreakdown = binByCategory(
    profiles,
    isTop1,
    p => Math.min(6, Math.max(2, p.primaryStackDepth)),
    [2, 3, 4, 5, 6],
  );

  // ─── Projection-actual Spearman ───
  const projRank = profiles.map(p => p.projectedScore);
  const actualArr = profiles.map(p => p.actualScore);
  const projectionActualCorrelation = spearmanCorrelation(projRank, actualArr);

  // ─── Ideal lineup ───
  const idealIdx = profiles
    .map((p, i) => ({ i, s: p.actualScore }))
    .sort((a, b) => b.s - a.s)[0]?.i ?? -1;
  const idealLineupProfile = idealIdx >= 0 ? profiles[idealIdx] : null;

  // Best-pool lineup by actual score (if pool provided)
  let bestPoolLineupProfile: LineupProfile | null = null;
  if (poolLineups && poolLineups.length > 0) {
    const poolScores = new Map<string, number>();
    for (const l of poolLineups) poolScores.set(l.hash, hashScores.get(l.hash) ?? 0);
    const best = [...poolLineups].sort((a, b) => (poolScores.get(b.hash) ?? 0) - (poolScores.get(a.hash) ?? 0))[0];
    if (best) {
      const inFieldIdx = hashToIdx.get(best.hash);
      if (inFieldIdx !== undefined) {
        bestPoolLineupProfile = profiles[inFieldIdx];
      } else {
        // Build a one-off profile by scoring this lineup alone
        const oneScore = scoreLineups([best], precomp);
        const { means: m, vars: v } = computeMeanAndVar(oneScore, 1, W);
        const actual = hashScores.get(best.hash) ?? 0;
        bestPoolLineupProfile = buildProfile(best, 0, oneScore, m[0], v[0], W, precomp, sport, actual, rankOf(actual));
      }
    }
  }

  // Most-common field players (top 10 by frequency)
  const freq = new Map<string, number>();
  for (const l of fieldLineups) for (const p of l.players) freq.set(p.id, (freq.get(p.id) || 0) + 1);
  const mostCommonFieldPlayers = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([id]) => {
      const pl = fieldLineups.flatMap(l => l.players).find(p => p.id === id);
      return pl?.name || id;
    });

  return {
    lineupCount: N,
    profileSample: profiles,
    separationMetrics,
    varianceQuintiles,
    ownershipQuintiles,
    stackDepthBreakdown,
    projectionActualCorrelation,
    idealLineupProfile,
    bestPoolLineupProfile,
    mostCommonFieldPlayers,
  };
}

// ============================================================
// BUILD PROFILE
// ============================================================

function buildProfile(
  lu: Lineup,
  idx: number,
  scores: Float32Array,
  mean: number,
  variance: number,
  W: number,
  precomp: SlatePrecomputation,
  sport: Sport,
  actualScore: number,
  actualRank: number,
): LineupProfile {
  const { team: stackTeam, depth: stackDepth } = primaryStackTeam(lu, sport);

  // Secondary stack
  const counts = countTeamPlayers(lu, { excludePitcher: sport === 'mlb' });
  const sortedTeams = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const secondaryStackTeam = sortedTeams.length > 1 ? sortedTeams[1][0] : null;
  const secondaryStackDepth = sortedTeams.length > 1 ? sortedTeams[1][1] : 0;

  // Bring-back: players from the opponent of the primary stack team
  let bringBackTeam: string | null = null;
  let bringBackCount = 0;
  if (stackTeam) {
    const opp = lu.players.find(p => p.team === stackTeam)?.opponent ?? null;
    if (opp) {
      bringBackTeam = opp;
      bringBackCount = lu.players.filter(p => p.team === opp && !(sport === 'mlb' && p.positions?.includes('P'))).length;
    }
  }

  const teamsRepresented = counts.size;
  const gamesSet = new Set<string>();
  for (const p of lu.players) gamesSet.add(p.gameInfo || `${p.team}_game`);

  // Within-lineup correlation pairs
  const idxs: number[] = [];
  for (const p of lu.players) {
    const pi = precomp.indexMap.get(p.id);
    if (pi !== undefined) idxs.push(pi);
  }
  let posPairs = 0, negPairs = 0, sumCorr = 0, pairCount = 0;
  for (let a = 0; a < idxs.length; a++) {
    for (let b = a + 1; b < idxs.length; b++) {
      const rho = playerPairCorrelation(precomp.playerWorldScores, idxs[a], idxs[b], W);
      sumCorr += rho;
      pairCount++;
      if (rho > 0.05) posPairs++;
      else if (rho < -0.05) negPairs++;
    }
  }

  // Ownership stats
  const owns = lu.players.map(p => (p.ownership || 0) / 100);
  let minOwn = Infinity, maxOwn = -Infinity, sumOwn = 0, prod = 1;
  for (const o of owns) {
    if (o < minOwn) minOwn = o;
    if (o > maxOwn) maxOwn = o;
    sumOwn += o;
    prod *= Math.max(0.001, o);
  }

  // Salary stats
  const sals = lu.players.map(p => p.salary);
  const avgSal = sals.reduce((a, b) => a + b, 0) / sals.length;
  let ssq = 0;
  for (const s of sals) ssq += (s - avgSal) * (s - avgSal);
  const salStd = Math.sqrt(ssq / sals.length);

  // Percentiles from world scores (if this is from full field, idx indexes row)
  const p95 = percentileOfRow(scores, idx, W, 0.95);
  const p99 = percentileOfRow(scores, idx, W, 0.99);

  return {
    hash: lu.hash,
    rank: actualRank,
    actualScore,
    actualRank,
    projectedScore: lu.projection,
    projectionError: actualScore - lu.projection,
    projectionErrorPct: lu.projection > 0 ? (actualScore - lu.projection) / lu.projection : 0,
    simVariance: variance,
    simStdDev: Math.sqrt(variance),
    p95Score: p95,
    p99Score: p99,
    ceilingRatio: lu.projection > 0 ? p99 / lu.projection : 0,
    positiveCorrPairs: posPairs,
    negativeCorrPairs: negPairs,
    netCorrelation: posPairs - negPairs,
    avgWithinCorrelation: pairCount > 0 ? sumCorr / pairCount : 0,
    primaryStackTeam: stackTeam,
    primaryStackDepth: stackDepth,
    secondaryStackTeam,
    secondaryStackDepth,
    bringBackTeam,
    bringBackCount,
    teamsRepresented,
    gameEnvironments: gamesSet.size,
    avgOwnership: sumOwn / owns.length,
    minOwnership: minOwn === Infinity ? 0 : minOwn,
    maxOwnership: maxOwn === -Infinity ? 0 : maxOwn,
    ownershipProduct: prod,
    totalSalary: lu.salary,
    avgPlayerSalary: avgSal,
    salaryStdDev: salStd,
  };
}

// ============================================================
// SEPARATION
// ============================================================

function computeSeparation(
  profiles: LineupProfile[],
  isTop1: boolean[],
  sport: Sport,
): SeparationMetric[] {
  const topProfiles = profiles.filter((_, i) => isTop1[i]);
  const fieldProfiles = profiles;

  const predictions: Array<{
    metric: string;
    getter: (p: LineupProfile) => number;
    expected: 'higher' | 'lower';
    basis: string;
  }> = [
    { metric: 'simVariance',          getter: p => p.simVariance,          expected: 'higher', basis: 'Hunter Principle 2' },
    { metric: 'netCorrelation',       getter: p => p.netCorrelation,       expected: 'higher', basis: 'Hunter Eq 2.8' },
    { metric: 'avgOwnership',         getter: p => p.avgOwnership,         expected: 'lower',  basis: 'Haugh-Singal (sport-dep)' },
    { metric: 'primaryStackDepth',    getter: p => p.primaryStackDepth,    expected: 'higher', basis: 'Winner analysis' },
    { metric: 'ownershipProduct',     getter: p => p.ownershipProduct,     expected: 'lower',  basis: 'Haugh-Singal uniqueness' },
    { metric: 'p99Score',             getter: p => p.p99Score,             expected: 'higher', basis: 'Ceiling matters in GPPs' },
    { metric: 'ceilingRatio',         getter: p => p.ceilingRatio,         expected: 'higher', basis: 'Hunter Principle 2' },
    { metric: 'projectedScore',       getter: p => p.projectedScore,       expected: 'higher', basis: 'Hunter Principle 1' },
    { metric: 'bringBackCount',       getter: p => p.bringBackCount,       expected: 'higher', basis: 'H-S opposing stacks' },
    { metric: 'salaryStdDev',         getter: p => p.salaryStdDev,         expected: 'higher', basis: 'Stars+scrubs structure' },
  ];

  const metrics: SeparationMetric[] = [];
  for (const pred of predictions) {
    const topVals = topProfiles.map(pred.getter);
    const fieldVals = fieldProfiles.map(pred.getter);
    const topAvg = avg(topVals);
    const fieldAvg = avg(fieldVals);
    const fieldStd = stddev(fieldVals, fieldAvg);
    const es = effectSize(topAvg, fieldAvg, fieldStd);
    const direction: 'higher' | 'lower' = topAvg >= fieldAvg ? 'higher' : 'lower';
    metrics.push({
      metric: pred.metric,
      top1Avg: topAvg,
      fieldAvg,
      fieldStd,
      effectSize: es,
      direction,
      researchPrediction: `${pred.expected} (${pred.basis})`,
      researchMatch: direction === pred.expected,
    });
  }

  metrics.sort((a, b) => Math.abs(b.effectSize) - Math.abs(a.effectSize));
  return metrics;
}

// ============================================================
// QUINTILE BINNING
// ============================================================

function binAndCompute(
  profiles: LineupProfile[],
  isTop1: boolean[],
  getter: (p: LineupProfile) => number,
  bins: number,
): QuintileRow[] {
  const N = profiles.length;
  if (N === 0) return [];
  const sorted = profiles.map((p, i) => ({ i, v: getter(p) })).sort((a, b) => a.v - b.v);

  const out: QuintileRow[] = [];
  for (let b = 0; b < bins; b++) {
    const start = Math.floor((b * N) / bins);
    const end = Math.floor(((b + 1) * N) / bins);
    const slice = sorted.slice(start, end);
    const count = slice.length;
    let t1 = 0, t5 = 0, sumActual = 0, sumProj = 0, sumVar = 0;
    for (const { i } of slice) {
      if (isTop1[i]) t1++;
      const p = profiles[i];
      sumActual += p.actualScore;
      sumProj += p.projectedScore;
      sumVar += p.simVariance;
    }
    out.push({
      bucket: b + 1,
      lineupCount: count,
      top1HitRate: count ? t1 / count : 0,
      top5HitRate: 0,  // populated below if useful
      avgActual: count ? sumActual / count : 0,
      avgProjection: count ? sumProj / count : 0,
      avgVariance: count ? sumVar / count : 0,
    });
  }
  return out;
}

function binByCategory(
  profiles: LineupProfile[],
  isTop1: boolean[],
  getter: (p: LineupProfile) => number,
  categories: number[],
): QuintileRow[] {
  const out: QuintileRow[] = [];
  for (const cat of categories) {
    const rows = profiles.map((p, i) => ({ p, i })).filter(r => getter(r.p) === cat);
    const count = rows.length;
    let t1 = 0, sumActual = 0, sumProj = 0, sumVar = 0;
    for (const { p, i } of rows) {
      if (isTop1[i]) t1++;
      sumActual += p.actualScore;
      sumProj += p.projectedScore;
      sumVar += p.simVariance;
    }
    out.push({
      bucket: cat,
      lineupCount: count,
      top1HitRate: count ? t1 / count : 0,
      top5HitRate: 0,
      avgActual: count ? sumActual / count : 0,
      avgProjection: count ? sumProj / count : 0,
      avgVariance: count ? sumVar / count : 0,
    });
  }
  return out;
}

// ============================================================
// HELPERS
// ============================================================

function avg(a: number[]): number {
  if (a.length === 0) return 0;
  let s = 0;
  for (const x of a) s += x;
  return s / a.length;
}

function stddev(a: number[], m: number): number {
  if (a.length < 2) return 0;
  let s = 0;
  for (const x of a) s += (x - m) * (x - m);
  return Math.sqrt(s / (a.length - 1));
}

function computePercentileScore(entries: ContestEntry[], frac: number): number {
  const scores = entries.map(e => e.actualPoints).sort((a, b) => b - a);
  return scores[Math.max(0, Math.floor(scores.length * frac) - 1)] || 0;
}
