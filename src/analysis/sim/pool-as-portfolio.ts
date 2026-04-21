/**
 * Part 3: SS POOL AS A PORTFOLIO.
 *
 * Treat the entire SS pool (or subsample) as one big portfolio and measure
 * its world coverage, variance distribution, stack coverage vs field/winners,
 * and game-script representation. Produce ranked pool augmentation recs.
 */

import { Lineup, Player, Sport } from '../../types';
import { SlatePrecomputation } from '../../selection/algorithm7-selector';
import { scoreLineups, fieldThresholdsMulti, computeMeanAndVar } from './sim-core';
import { countTeamPlayers } from '../common';
import { PortfolioSim, analyzePortfolioSim } from './portfolio-sim';
import { WinnerAnatomy } from '../winner-anatomy';

export interface PoolVarianceDistRow {
  percentile: number;       // 10, 25, 50, 75, 90
  variance: number;
}

export interface PoolStackGap {
  team: string;
  poolStackRate: number;
  fieldStackRate: number;
  winnerStackRate: number;
  gap: number;              // winnerStackRate - poolStackRate
}

export interface PoolRecommendation {
  priority: number;
  type: string;
  detail: string;
  expectedCaptureImprovement: number;
  rationale: string;
}

export interface PoolAsPortfolioAnalysis {
  poolPortfolio: PortfolioSim | null;
  fieldAvgPairCorrelation: number;  // reference computed on field sample

  // Coverage comparison
  poolCoverageByTier: Array<{ percentile: number; rate: number }>;
  fieldCoverageByTier: Array<{ percentile: number; rate: number }>;

  // Variance distribution
  poolVarianceDistribution: PoolVarianceDistRow[];
  winnerAvgVariance: number;
  winnerVariancePoolPercentile: number;  // where the winner variance sits within pool distribution

  // Stack gaps
  poolStackGaps: PoolStackGap[];

  // Player coverage
  playersInPool: number;
  playersOnSlate: number;
  playerCoverage: number;
  missingWinnerPlayers: Array<{ name: string; winnerLift: number; poolExposure: number; inPool: boolean }>;

  recommendations: PoolRecommendation[];
}

export function analyzePoolAsPortfolio(
  poolLineups: Lineup[],
  fieldLineups: Lineup[],
  fieldPlayerOwnership: Map<string, number>,
  precomp: SlatePrecomputation,
  winnerAnatomy: WinnerAnatomy,
  hashScores: Map<string, number>,
  top1Hashes: Set<string>,
  allPlayers: Player[],
  numGames: number,
  sport: Sport,
): PoolAsPortfolioAnalysis {
  const W = precomp.W;

  // To keep tractable: sample up to 2000 pool lineups for the portfolio-sim math
  const poolSampleSize = Math.min(poolLineups.length, 2000);
  const poolSample = sample(poolLineups, poolSampleSize, 31);

  const poolPortfolio = analyzePortfolioSim(
    'ss_pool',
    poolSample,
    precomp,
    fieldPlayerOwnership,
    numGames,
    sport,
  );

  // Field reference avg pair correlation — use precomp.fieldWorldScores directly
  const F = precomp.F;
  const pairs = Math.min(500, (F * (F - 1)) / 2);
  const fAvgCorr = samplePairAvgCorrelation(precomp.fieldWorldScores, F, W, pairs);

  // Coverage: pool vs field at tiers [0.999, 0.99, 0.95]
  const tiers = [0.999, 0.99, 0.95];
  const thresholds = fieldThresholdsMulti(precomp.fieldWorldScores, F, W, tiers);

  // Pool coverage (score the pool sample)
  const poolScores = scoreLineups(poolSample, precomp);
  const poolCoverage = computeCoverageRates(poolScores, poolSample.length, W, thresholds);
  const fieldCoverage = computeCoverageRates(precomp.fieldWorldScores, F, W, thresholds);
  const poolCoverageByTier = tiers.map((p, i) => ({ percentile: p, rate: poolCoverage[i] }));
  const fieldCoverageByTier = tiers.map((p, i) => ({ percentile: p, rate: fieldCoverage[i] }));

  // Pool variance distribution
  const { vars: poolVars } = computeMeanAndVar(poolScores, poolSample.length, W);
  const sortedVars = [...poolVars].sort((a, b) => a - b);
  const poolVarianceDistribution = [10, 25, 50, 75, 90].map(p => ({
    percentile: p,
    variance: sortedVars[Math.max(0, Math.min(sortedVars.length - 1, Math.floor(sortedVars.length * (p / 100))))],
  }));

  const winnerAvgVariance = winnerAnatomy.winnerAvgVariance;
  let winnerVariancePoolPercentile = 0;
  for (let i = 0; i < sortedVars.length; i++) {
    if (sortedVars[i] >= winnerAvgVariance) { winnerVariancePoolPercentile = i / sortedVars.length; break; }
    if (i === sortedVars.length - 1) winnerVariancePoolPercentile = 1;
  }

  // Stack gaps: per team compare pool vs field vs winners (winners from winnerAnatomy.stackProfile)
  const poolStackByTeam = new Map<string, number>();
  for (const l of poolLineups) {
    const counts = countTeamPlayers(l, { excludePitcher: sport === 'mlb' });
    for (const [t, c] of counts) if (c >= 4) poolStackByTeam.set(t, (poolStackByTeam.get(t) || 0) + 1);
  }
  const fieldStackByTeam = new Map<string, number>();
  for (const l of fieldLineups) {
    const counts = countTeamPlayers(l, { excludePitcher: sport === 'mlb' });
    for (const [t, c] of counts) if (c >= 4) fieldStackByTeam.set(t, (fieldStackByTeam.get(t) || 0) + 1);
  }

  const poolStackGaps: PoolStackGap[] = [];
  for (const sp of winnerAnatomy.stackProfile) {
    const poolRate = (poolStackByTeam.get(sp.team) || 0) / Math.max(1, poolLineups.length);
    const fieldRate = (fieldStackByTeam.get(sp.team) || 0) / Math.max(1, fieldLineups.length);
    const gap = sp.winnerRate - poolRate;
    poolStackGaps.push({
      team: sp.team,
      poolStackRate: poolRate,
      fieldStackRate: fieldRate,
      winnerStackRate: sp.winnerRate,
      gap,
    });
  }
  poolStackGaps.sort((a, b) => b.gap - a.gap);

  // Player coverage
  const poolPlayerSet = new Set<string>();
  const poolPlayerCount = new Map<string, number>();
  for (const l of poolLineups) for (const p of l.players) {
    poolPlayerSet.add(p.id);
    poolPlayerCount.set(p.id, (poolPlayerCount.get(p.id) || 0) + 1);
  }
  const playersInPool = poolPlayerSet.size;
  const playersOnSlate = allPlayers.length;
  const playerCoverage = playersOnSlate > 0 ? playersInPool / playersOnSlate : 0;

  const missingWinnerPlayers = winnerAnatomy.alphaPlayers.map(a => {
    const c = poolPlayerCount.get(a.id) || 0;
    return {
      name: a.name,
      winnerLift: a.winnerLift,
      poolExposure: poolLineups.length ? c / poolLineups.length : 0,
      inPool: c > 0,
    };
  });

  // ─── Recommendations (ranked by expected impact heuristic) ───
  const recommendations: PoolRecommendation[] = [];
  let priority = 1;

  // Compare winner variance to pool variance 90th pctile
  const p90Var = sortedVars[Math.floor(sortedVars.length * 0.90)] || 0;
  if (winnerAvgVariance > p90Var * 0.9) {
    recommendations.push({
      priority: priority++,
      type: 'ceiling_weight',
      detail: 'Generate a ceiling-weighted pool (objective = p95 / p99 rather than projection)',
      expectedCaptureImprovement: 0.10,
      rationale: `Winner avg variance (${winnerAvgVariance.toFixed(0)}) is at ${(winnerVariancePoolPercentile * 100).toFixed(0)}th percentile of current pool — most pool lineups can't reach it`,
    });
  }

  const topMissingStacks = poolStackGaps.filter(g => g.gap > 0.05).slice(0, 3);
  for (const g of topMissingStacks) {
    recommendations.push({
      priority: priority++,
      type: 'team_force',
      detail: `Generate a per-team pool with ${g.team} forced (≥4 batters/players) — 300-500 lineups`,
      expectedCaptureImprovement: Math.min(0.25, g.gap),
      rationale: `${(g.winnerStackRate * 100).toFixed(0)}% of winners stacked ${g.team}; pool only produces ${(g.poolStackRate * 100).toFixed(1)}%`,
    });
  }

  const lowOwnMissing = missingWinnerPlayers.filter(m => !m.inPool || m.poolExposure < 0.05);
  if (lowOwnMissing.length >= 2) {
    recommendations.push({
      priority: priority++,
      type: 'ownership_cap',
      detail: `Generate ownership-capped pool (max player exposure 15%) — 1000-2000 lineups`,
      expectedCaptureImprovement: 0.15,
      rationale: `${lowOwnMissing.length} alpha players under-represented: ${lowOwnMissing.slice(0, 3).map(m => m.name).join(', ')}`,
    });
  }

  if (poolPortfolio && poolPortfolio.opposingCoverageRate < 0.50 && (sport === 'mlb' || sport === 'nfl')) {
    recommendations.push({
      priority: priority++,
      type: 'opposing_stack',
      detail: `Generate opposing-stack pool (both sides of a game ≥3 each) per high-total game`,
      expectedCaptureImprovement: 0.08,
      rationale: `Pool covers opposing stacks in only ${((poolPortfolio.opposingCoverageRate) * 100).toFixed(0)}% of games — research says these produce n⁻ᵢⱼ diversification`,
    });
  }

  return {
    poolPortfolio,
    fieldAvgPairCorrelation: fAvgCorr,
    poolCoverageByTier,
    fieldCoverageByTier,
    poolVarianceDistribution,
    winnerAvgVariance,
    winnerVariancePoolPercentile,
    poolStackGaps,
    playersInPool,
    playersOnSlate,
    playerCoverage,
    missingWinnerPlayers,
    recommendations,
  };
}

// ============================================================
// HELPERS
// ============================================================

function sample<T>(arr: T[], n: number, seed: number): T[] {
  if (arr.length <= n) return arr;
  let s = seed | 0;
  const rng = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
  const indices = Array.from({ length: arr.length }, (_, i) => i);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng() * (arr.length - i));
    const t = indices[i]; indices[i] = indices[j]; indices[j] = t;
  }
  return indices.slice(0, n).map(i => arr[i]);
}

function computeCoverageRates(
  scores: Float32Array,
  N: number,
  W: number,
  thresholds: Float32Array[],
): number[] {
  const T = thresholds.length;
  const covered = thresholds.map(() => new Uint8Array(W));
  for (let w = 0; w < W; w++) {
    for (let i = 0; i < N; i++) {
      const s = scores[i * W + w];
      for (let t = 0; t < T; t++) {
        if (!covered[t][w] && s >= thresholds[t][w]) covered[t][w] = 1;
      }
    }
  }
  return covered.map(c => {
    let x = 0; for (let w = 0; w < W; w++) x += c[w]; return x / W;
  });
}

function samplePairAvgCorrelation(
  scores: Float32Array,
  N: number,
  W: number,
  pairs: number,
): number {
  let seed = 11;
  const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };
  const means = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let s = 0;
    for (let w = 0; w < W; w++) s += scores[i * W + w];
    means[i] = s / W;
  }
  let sum = 0;
  for (let p = 0; p < pairs; p++) {
    const i = Math.floor(rng() * N);
    let j = Math.floor(rng() * (N - 1));
    if (j >= i) j++;
    let num = 0, dI = 0, dJ = 0;
    for (let w = 0; w < W; w++) {
      const a = scores[i * W + w] - means[i];
      const b = scores[j * W + w] - means[j];
      num += a * b; dI += a * a; dJ += b * b;
    }
    const d = Math.sqrt(dI * dJ);
    sum += d > 1e-12 ? num / d : 0;
  }
  return sum / pairs;
}
