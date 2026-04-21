/**
 * Module 4: SS POOL GAP ANALYSIS — what our pool missed.
 *
 * Takes a pre-built SaberSim pool CSV (already joined to projections) and the
 * winner anatomy from Module 1. Reports:
 *
 *   • poolCaptureRate  — fraction of top-1% lineups that existed in the pool
 *   • ceilingGap       — best pool score vs best contest score
 *   • missingAlphas    — alpha players under-represented in the pool
 *   • missingStacks    — teams winners stacked but the pool didn't
 *   • recommendations  — specific SS pool-gen settings likely to close the gap
 *
 * When no pool CSV is provided, returns null and the caller can skip this
 * module.
 */

import { Lineup, Sport } from '../types';
import { AlphaPlayer, StackProfileEntry, WinnerAnatomy } from './winner-anatomy';
import { countTeamPlayers } from './common';

export interface PoolGapAnalysis {
  poolSize: number;
  poolUniqueLineups: number;

  // Ceiling
  poolBestActual: number;
  contestBestActual: number;
  ceilingGap: number;

  // Winner coverage
  top1LineupsInPool: number;
  top1LineupsTotal: number;
  poolCaptureRate: number;

  // Missing alpha players
  missingAlphaPlayers: Array<{
    name: string;
    ownership: number;
    projection: number;
    actual: number;
    winnerLift: number;
    inPool: boolean;
    poolExposure: number;
  }>;

  // Missing stacks
  missingStacks: Array<{
    team: string;
    winnerStackRate: number;
    poolStackRate: number;
    stackGap: number;
  }>;

  // Pool diversity
  poolUniquePlayers: number;
  poolAvgStackDepth: number;

  recommendations: Array<{
    setting: string;
    rationale: string;
    expectedImpact: string;
  }>;
}

export function analyzePoolGaps(
  poolLineups: Lineup[],
  winnerAnatomy: WinnerAnatomy,
  top1Hashes: Set<string>,   // hashes of top-1% lineups (from the joined field)
  hashScores: Map<string, number>,
  sport: Sport,
): PoolGapAnalysis {
  const poolSize = poolLineups.length;
  const poolHashes = new Set(poolLineups.map(l => l.hash));
  const poolUniqueLineups = poolHashes.size;

  // ─── Ceiling gap ───
  let poolBestActual = 0;
  for (const l of poolLineups) {
    const a = hashScores.get(l.hash) ?? 0;
    if (a > poolBestActual) poolBestActual = a;
  }
  const contestBestActual = winnerAnatomy.top1Threshold > 0
    ? Math.max(...Array.from(hashScores.values()))
    : 0;

  // ─── Top-1% capture ───
  let top1InPool = 0;
  for (const h of top1Hashes) if (poolHashes.has(h)) top1InPool++;
  const poolCaptureRate = top1Hashes.size ? top1InPool / top1Hashes.size : 0;

  // ─── Missing alpha players ───
  const poolPlayerCount = new Map<string, number>();
  for (const l of poolLineups) {
    for (const p of l.players) poolPlayerCount.set(p.id, (poolPlayerCount.get(p.id) || 0) + 1);
  }
  const missingAlphaPlayers = winnerAnatomy.alphaPlayers.map(a => {
    const poolCount = poolPlayerCount.get(a.id) || 0;
    const poolExp = poolSize ? poolCount / poolSize : 0;
    const inPool = poolCount > 0;
    return {
      name: a.name,
      ownership: a.ownership,
      projection: a.projection,
      actual: a.actual,
      winnerLift: a.winnerLift,
      inPool,
      poolExposure: poolExp,
    };
  });

  // ─── Missing stacks ───
  // Compute pool stack rate per team, compare vs winner stack rate
  const poolStackByTeam = new Map<string, number>();
  for (const l of poolLineups) {
    const counts = countTeamPlayers(l, { excludePitcher: sport === 'mlb' });
    for (const [team, n] of counts) {
      if (n >= 4) poolStackByTeam.set(team, (poolStackByTeam.get(team) || 0) + 1);
    }
  }
  const missingStacks: PoolGapAnalysis['missingStacks'] = [];
  for (const sp of winnerAnatomy.stackProfile) {
    const poolRate = (poolStackByTeam.get(sp.team) || 0) / Math.max(1, poolSize);
    const gap = sp.winnerRate - poolRate;
    if (gap > 0.05) {
      missingStacks.push({
        team: sp.team,
        winnerStackRate: sp.winnerRate,
        poolStackRate: poolRate,
        stackGap: gap,
      });
    }
  }
  missingStacks.sort((a, b) => b.stackGap - a.stackGap);

  // Pool diversity
  const poolUniquePlayers = poolPlayerCount.size;
  let poolSumStack = 0;
  for (const l of poolLineups) {
    const counts = countTeamPlayers(l, { excludePitcher: sport === 'mlb' });
    let maxDepth = 0;
    for (const n of counts.values()) if (n > maxDepth) maxDepth = n;
    poolSumStack += maxDepth;
  }
  const poolAvgStackDepth = poolSize ? poolSumStack / poolSize : 0;

  // ─── Recommendations ───
  const recommendations: PoolGapAnalysis['recommendations'] = [];

  const lowOwnedMissing = missingAlphaPlayers.filter(a => a.ownership < 0.15 && a.poolExposure < 0.10);
  if (lowOwnedMissing.length > 0) {
    recommendations.push({
      setting: `Ownership cap 15-20%`,
      rationale: `${lowOwnedMissing.length} alpha players with <15% ownership had <10% pool exposure`,
      expectedImpact: `Covers these alpha plays: ${lowOwnedMissing.slice(0, 3).map(a => a.name).join(', ')}`,
    });
  }

  if (missingStacks.length > 0) {
    const topMissing = missingStacks[0];
    recommendations.push({
      setting: `Per-team lock pool for ${topMissing.team}`,
      rationale: `${(topMissing.winnerStackRate * 100).toFixed(0)}% of winners stacked ${topMissing.team}; pool only ${(topMissing.poolStackRate * 100).toFixed(1)}%`,
      expectedImpact: `Could lift pool capture rate substantially on this stack`,
    });
  }

  if (winnerAnatomy.varianceDelta > 0.15 && poolAvgStackDepth < winnerAnatomy.winnerAvgStackDepth - 0.3) {
    recommendations.push({
      setting: `Ceiling-weighted pool generation (p95 objective)`,
      rationale: `Winners have ${(winnerAnatomy.varianceDelta * 100).toFixed(0)}% higher variance and deeper stacks`,
      expectedImpact: `Adds high-ceiling lineups the pool currently lacks`,
    });
  }

  if (poolCaptureRate < 0.20 && top1Hashes.size > 0) {
    recommendations.push({
      setting: `Increase pool diversity (more per-team/per-pitcher pools)`,
      rationale: `Pool captured only ${(poolCaptureRate * 100).toFixed(1)}% of top-1% lineups`,
      expectedImpact: `Even hitting 50% capture doubles the selector's ceiling`,
    });
  }

  return {
    poolSize,
    poolUniqueLineups,
    poolBestActual,
    contestBestActual,
    ceilingGap: contestBestActual - poolBestActual,
    top1LineupsInPool: top1InPool,
    top1LineupsTotal: top1Hashes.size,
    poolCaptureRate,
    missingAlphaPlayers,
    missingStacks,
    poolUniquePlayers,
    poolAvgStackDepth,
    recommendations,
  };
}
