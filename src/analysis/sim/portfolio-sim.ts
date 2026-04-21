/**
 * Part 2: PORTFOLIO-LEVEL simulation analysis.
 *
 * For each portfolio (pro's entries, SS pool, or ad-hoc set):
 *   - E[max] across worlds
 *   - World coverage by tier (top 0.1% / 1% / 5% / 10%)
 *   - Pairwise correlation histogram + avg/median
 *   - Var(z_i - z_j) diversification
 *   - Hunter U²ₗ reconstruction: greedy marginal gain curve + productive entries
 *   - Coverage curve (worlds covered after N entries in greedy optimal order)
 *   - Player exposure, stack diversity, opposing-stack coverage, anchor leverage
 */

import { Lineup, Player, Sport } from '../../types';
import { SlatePrecomputation } from '../../selection/algorithm7-selector';
import {
  computeMeanAndVar,
  fieldThresholdsMulti,
  pearsonRow,
  scoreLineups,
  varDiffRow,
} from './sim-core';
import { anchorOfLineup, countTeamPlayers, hasBringBack, primaryStackTeam } from '../common';

// ============================================================
// TYPES
// ============================================================

export interface MarginalGainRow {
  entryNumber: number;
  marginalGain: number;
  cumulativeGain: number;
  newWorldsCovered: number;
  maxCorrWithPrevious: number;
  entryProjection: number;
  entryVariance: number;
  entryAvgOwnership: number;
}

export interface CoverageCurveRow {
  entryCount: number;
  top01Coverage: number;
  top1Coverage: number;
  top5Coverage: number;
}

export interface CoverageTierRow {
  percentile: number;
  coverageRate: number;
  contributingEntries: number;
  deadweightEntries: number;
}

export interface PortfolioSim {
  owner: string;
  entryCount: number;

  expectedMax: number;
  totalU2: number;
  productiveEntryCount: number;
  deadweightEntries: number;

  avgPairwiseCorrelation: number;
  medianPairwiseCorrelation: number;
  negativePairFraction: number;
  correlationHistogram: number[];  // bins: [<-0.5, -0.5..0, 0..0.25, 0.25..0.5, 0.5..0.75, >0.75]
  avgVarDifference: number;

  coverageByTier: CoverageTierRow[];
  coverageCurve: CoverageCurveRow[];
  gainCurve: MarginalGainRow[];

  maxPlayerExposure: number;
  avgTop5PlayerExposure: number;
  uniquePlayers: number;
  playerExposureHHI: number;
  uniqueStackTeams: number;
  stackDistributionHHI: number;
  opposingStackPairs: number;
  totalGames: number;
  opposingCoverageRate: number;

  chalkAnchor: string;
  chalkAnchorExposure: number;
  chalkAnchorFieldOwnership: number;
  anchorLeverageRatio: number;
}

// ============================================================
// MAIN
// ============================================================

export function analyzePortfolioSim(
  owner: string,
  lineups: Lineup[],
  precomp: SlatePrecomputation,
  fieldPlayerOwnership: Map<string, number>,  // id -> field fraction
  numGamesOnSlate: number,
  sport: Sport,
): PortfolioSim | null {
  if (lineups.length < 2) return null;
  const W = precomp.W;

  // Score this portfolio across worlds
  const scores = scoreLineups(lineups, precomp);
  const N = lineups.length;
  const { means, vars: vars_ } = computeMeanAndVar(scores, N, W);

  // Per-world thresholds (uses field from precomp)
  const tiers = [0.999, 0.99, 0.95, 0.90];
  const thresholds = fieldThresholdsMulti(precomp.fieldWorldScores, precomp.F, W, tiers);

  // ─── E[max] & coverage ───
  const maxPerWorld = new Float64Array(W);
  const coveredCount = tiers.map(() => new Uint8Array(W));
  const firstHitBy = tiers.map(() => new Int32Array(W).fill(-1));
  for (let w = 0; w < W; w++) {
    let best = -Infinity;
    for (let i = 0; i < N; i++) {
      const s = scores[i * W + w];
      if (s > best) best = s;
      for (let t = 0; t < tiers.length; t++) {
        if (!coveredCount[t][w] && s >= thresholds[t][w]) {
          coveredCount[t][w] = 1;
          if (firstHitBy[t][w] === -1) firstHitBy[t][w] = i;
        }
      }
    }
    maxPerWorld[w] = best === -Infinity ? 0 : best;
  }
  let emax = 0;
  for (let w = 0; w < W; w++) emax += maxPerWorld[w];
  emax /= W;

  // Coverage tier rows
  const coverageByTier: CoverageTierRow[] = tiers.map((pct, t) => {
    let cov = 0;
    const contrib = new Set<number>();
    for (let w = 0; w < W; w++) {
      if (coveredCount[t][w]) {
        cov++;
        if (firstHitBy[t][w] >= 0) contrib.add(firstHitBy[t][w]);
      }
    }
    return {
      percentile: pct,
      coverageRate: cov / W,
      contributingEntries: contrib.size,
      deadweightEntries: N - contrib.size,
    };
  });

  // ─── Correlation & var-diff (sampled pairs for speed) ───
  const maxPairs = 800;
  const totalPairs = (N * (N - 1)) / 2;
  const pairIndices: Array<[number, number]> = [];
  if (totalPairs <= maxPairs) {
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) pairIndices.push([i, j]);
  } else {
    let seed = 17;
    const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };
    for (let p = 0; p < maxPairs; p++) {
      const i = Math.floor(rng() * N);
      let j = Math.floor(rng() * (N - 1));
      if (j >= i) j++;
      pairIndices.push([Math.min(i, j), Math.max(i, j)]);
    }
  }
  const corrs: number[] = [];
  let sumVarDiff = 0;
  for (const [i, j] of pairIndices) {
    corrs.push(pearsonRow(scores, i, j, W, means[i], means[j]));
    sumVarDiff += varDiffRow(scores, i, j, W);
  }
  corrs.sort((a, b) => a - b);
  const avgCorr = corrs.reduce((a, b) => a + b, 0) / corrs.length;
  const medianCorr = corrs[Math.floor(corrs.length / 2)];
  const negFrac = corrs.filter(c => c < 0).length / corrs.length;
  const histogramBins = [-0.5, 0, 0.25, 0.5, 0.75];
  const histogram = new Array(histogramBins.length + 1).fill(0);
  for (const c of corrs) {
    let placed = false;
    for (let b = 0; b < histogramBins.length; b++) {
      if (c < histogramBins[b]) { histogram[b]++; placed = true; break; }
    }
    if (!placed) histogram[histogramBins.length]++;
  }
  const avgVarDiff = sumVarDiff / pairIndices.length;

  // ─── Hunter U²ₗ greedy reconstruction ───
  // Objective: sum of indicator(any entry ≥ top-1% threshold) over all worlds.
  // Pick entries one at a time, each time choosing the one that adds the most
  // NEW covered worlds at the top-1% tier.
  const top1Tier = 1;  // index into tiers
  const covered = new Uint8Array(W);
  const chosen = new Array<boolean>(N).fill(false);
  const gainCurve: MarginalGainRow[] = [];
  let cumulative = 0;
  for (let step = 0; step < N; step++) {
    let bestI = -1, bestGain = -1, bestNew = -1;
    for (let i = 0; i < N; i++) {
      if (chosen[i]) continue;
      // Count worlds this entry would add
      let added = 0;
      for (let w = 0; w < W; w++) {
        if (!covered[w] && scores[i * W + w] >= thresholds[top1Tier][w]) added++;
      }
      if (added > bestGain) { bestGain = added; bestI = i; bestNew = added; }
    }
    if (bestI < 0) break;
    chosen[bestI] = true;
    // Mark worlds covered
    for (let w = 0; w < W; w++) {
      if (scores[bestI * W + w] >= thresholds[top1Tier][w]) covered[w] = 1;
    }
    cumulative += bestGain;
    // max corr with any previously chosen entry
    let maxPrevCorr = 0;
    for (let j = 0; j < N; j++) {
      if (j === bestI || !chosen[j]) continue;
      const rho = pearsonRow(scores, bestI, j, W, means[bestI], means[j]);
      if (Math.abs(rho) > Math.abs(maxPrevCorr)) maxPrevCorr = rho;
    }
    const lu = lineups[bestI];
    const avgOwn = lu.players.reduce((s, p) => s + (p.ownership || 0) / 100, 0) / lu.players.length;
    gainCurve.push({
      entryNumber: step + 1,
      marginalGain: bestGain,
      cumulativeGain: cumulative,
      newWorldsCovered: bestNew,
      maxCorrWithPrevious: step === 0 ? 0 : maxPrevCorr,
      entryProjection: lu.projection,
      entryVariance: vars_[bestI],
      entryAvgOwnership: avgOwn,
    });
  }
  const productiveEntryCount = gainCurve.filter(r => r.marginalGain > 0).length;

  // Coverage curve at a few checkpoints (from greedy order above)
  const checkpoints = [10, 25, 50, 75, 100, 150];
  const coverageCurve: CoverageCurveRow[] = [];
  // Re-run minimally to also track top 0.1/5%
  const cov01 = new Uint8Array(W), cov1 = new Uint8Array(W), cov5 = new Uint8Array(W);
  for (let step = 0; step < gainCurve.length; step++) {
    // Find the entry in lineup-order from gainCurve[step].entryNumber (1-based within the greedy sequence)
    // We don't have the original chosen index here; re-derive by recomputing greedy in same order
    // Instead use the same greedy traversal:
    // (We'll do a lightweight second pass: greedy order by marginal gain at each step was tracked;
    // but we dropped the entry index. Re-run from scores.)
    break;
  }
  // Simpler: redo the greedy traversal but recording coverage at each step
  cov01.fill(0); cov1.fill(0); cov5.fill(0);
  const chosen2 = new Array<boolean>(N).fill(false);
  const greedyOrder: number[] = [];
  for (let step = 0; step < N; step++) {
    let bestI = -1, bestGain = -1;
    for (let i = 0; i < N; i++) {
      if (chosen2[i]) continue;
      let added = 0;
      for (let w = 0; w < W; w++) {
        if (!cov1[w] && scores[i * W + w] >= thresholds[1][w]) added++;
      }
      if (added > bestGain) { bestGain = added; bestI = i; }
    }
    if (bestI < 0) break;
    chosen2[bestI] = true;
    greedyOrder.push(bestI);
    for (let w = 0; w < W; w++) {
      const s = scores[bestI * W + w];
      if (s >= thresholds[0][w]) cov01[w] = 1;
      if (s >= thresholds[1][w]) cov1[w] = 1;
      if (s >= thresholds[2][w]) cov5[w] = 1;
    }
    const cp = step + 1;
    if (checkpoints.includes(cp) || cp === N) {
      coverageCurve.push({
        entryCount: cp,
        top01Coverage: sumU8(cov01) / W,
        top1Coverage: sumU8(cov1) / W,
        top5Coverage: sumU8(cov5) / W,
      });
    }
  }

  // ─── Player exposure ───
  const exposureCount = new Map<string, number>();
  for (const lu of lineups) for (const p of lu.players) exposureCount.set(p.id, (exposureCount.get(p.id) || 0) + 1);
  let maxExp = 0;
  let hhi = 0;
  for (const c of exposureCount.values()) {
    const f = c / N;
    hhi += f * f;
    if (f > maxExp) maxExp = f;
  }
  const sortedExp = [...exposureCount.entries()].sort((a, b) => b[1] - a[1]);
  const avgTop5 = sortedExp.slice(0, 5).reduce((a, [, c]) => a + c / N, 0) / Math.min(5, sortedExp.length);

  // ─── Stack diversity ───
  const stackTeamCount = new Map<string, number>();
  for (const lu of lineups) {
    const { team } = primaryStackTeam(lu, sport);
    if (team) stackTeamCount.set(team, (stackTeamCount.get(team) || 0) + 1);
  }
  let stackHHI = 0;
  for (const c of stackTeamCount.values()) { const f = c / N; stackHHI += f * f; }

  // ─── Opposing stacks (both sides of a game stacked) ───
  const opposingPairs = countOpposingStacks(lineups, sport);

  // ─── Anchor leverage ───
  const anchorCount = new Map<string, { count: number; fieldOwn: number; name: string }>();
  for (const lu of lineups) {
    const a = anchorOfLineup(lu, sport);
    if (!a) continue;
    const ex = anchorCount.get(a.id);
    const fo = fieldPlayerOwnership.get(a.id) ?? 0;
    if (ex) ex.count++; else anchorCount.set(a.id, { count: 1, fieldOwn: fo, name: a.name });
  }
  const anchorSorted = [...anchorCount.entries()].sort((a, b) => b[1].fieldOwn - a[1].fieldOwn);
  const chalkAnchor = anchorSorted[0];
  const chalkAnchorName = chalkAnchor?.[1].name || '';
  const chalkAnchorExp = chalkAnchor ? chalkAnchor[1].count / N : 0;
  const chalkAnchorFieldOwn = chalkAnchor?.[1].fieldOwn ?? 0;
  const leverage = chalkAnchorExp > 0 ? chalkAnchorFieldOwn / chalkAnchorExp : 0;

  // ─── Total U² ───
  const totalU2 = coverageByTier[1].coverageRate * W;  // worlds covered at top-1%

  return {
    owner,
    entryCount: N,
    expectedMax: emax,
    totalU2,
    productiveEntryCount,
    deadweightEntries: N - productiveEntryCount,
    avgPairwiseCorrelation: avgCorr,
    medianPairwiseCorrelation: medianCorr,
    negativePairFraction: negFrac,
    correlationHistogram: histogram,
    avgVarDifference: avgVarDiff,
    coverageByTier,
    coverageCurve,
    gainCurve,
    maxPlayerExposure: maxExp,
    avgTop5PlayerExposure: avgTop5,
    uniquePlayers: exposureCount.size,
    playerExposureHHI: hhi,
    uniqueStackTeams: stackTeamCount.size,
    stackDistributionHHI: stackHHI,
    opposingStackPairs: opposingPairs,
    totalGames: numGamesOnSlate,
    opposingCoverageRate: numGamesOnSlate > 0 ? opposingPairs / numGamesOnSlate : 0,
    chalkAnchor: chalkAnchorName,
    chalkAnchorExposure: chalkAnchorExp,
    chalkAnchorFieldOwnership: chalkAnchorFieldOwn,
    anchorLeverageRatio: leverage,
  };
}

// ============================================================
// HELPERS
// ============================================================

function sumU8(arr: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s;
}

function countOpposingStacks(lineups: Lineup[], sport: Sport): number {
  const games = new Set<string>();
  for (const lu of lineups) {
    const byTeam = countTeamPlayers(lu, { excludePitcher: sport === 'mlb' });
    const teams = [...byTeam.entries()].filter(([, c]) => c >= 3).map(([t]) => t);
    if (teams.length >= 2) {
      // Any pair of teams that play each other?
      for (let i = 0; i < teams.length; i++) {
        for (let j = i + 1; j < teams.length; j++) {
          const a = teams[i], b = teams[j];
          const aOpp = lu.players.find(p => p.team === a)?.opponent;
          if (aOpp === b) {
            games.add([a, b].sort().join('@'));
          }
        }
      }
    }
  }
  return games.size;
}
