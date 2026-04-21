/**
 * Module 2: PRO PORTFOLIOS (auto-detect, standalone, no simulation).
 *
 * For every user with >= minEntries (default 100), compute the portfolio
 * metrics that the research papers say matter most:
 *
 *   • avgProjection, avgVariance   — Hunter Principles 1 & 2
 *   • avgPairwiseOverlap           — entry uniqueness proxy for Hunter Principle 3
 *                                    (low overlap ~ low correlation between entries)
 *   • maxExposure, exposureHHI     — Haugh-Singal saturation effect
 *   • anchorDistribution           — sport-aware anchor leverage vs field
 *   • avgStackDepth, bringBackRate — stack structure
 *   • top1Rate, top5Rate, bestRank — actuals performance
 *   • hittingEntries               — what their top-1% entries looked like
 *
 * Variance uses the stdDev-based approximation from common.ts rather than
 * world simulation — this keeps the analysis fast and dependency-free.
 */

import { ContestActuals, ContestEntry } from '../parser/actuals-parser';
import { Lineup, Player, Sport } from '../types';
import {
  anchorOfLineup,
  approximateLineupVariance,
  countTeamPlayers,
  detectPros,
  extractUsername,
  hasBringBack,
  normalizeName,
  primaryStackTeam,
} from './common';

export interface ProHittingEntry {
  rank: number;
  actual: number;
  projection: number;
  ownership: number;       // avg player ownership (0-1)
  variance: number;
  stackTeam: string;
  stackDepth: number;
  anchor: string;
}

export interface ProPortfolio {
  username: string;
  entries: number;
  top1Hits: number;
  top1Rate: number;
  top5Hits: number;
  top5Rate: number;
  avgActual: number;
  bestRank: number;

  avgProjection: number;
  avgVariance: number;
  avgOwnership: number;         // avg of per-lineup avg player ownership (0-1)

  maxExposure: number;
  maxExposurePlayer: string;
  exposureHHI: number;
  avgPairwiseOverlap: number;   // avg shared players between entry pairs (lower = more diverse)

  avgStackDepth: number;
  uniqueStackTeams: number;
  bringBackRate: number;

  anchorDistribution: Array<{
    name: string;
    exposure: number;            // fraction of pro's entries
    fieldOwnership: number;      // pre-contest ownership
    leverage: number;            // exposure / fieldOwnership
  }>;

  hittingEntries: ProHittingEntry[];
}

export interface ProAnalysis {
  prosDetected: number;
  minEntriesThreshold: number;
  topPros: ProPortfolio[];     // sorted by top1Rate
  fieldAvgs: {
    top1Rate: number;           // field baseline = 0.01 by definition
    avgOwnership: number;
    avgVariance: number;
    avgProjection: number;
    maxExposure: number;
  };
}

export function analyzeProPortfolios(
  fieldLineups: Lineup[],
  entryHashes: (string | null)[],
  actuals: ContestActuals,
  hashScores: Map<string, number>,
  allPlayers: Player[],
  sport: Sport,
  minEntries = 100,
): ProAnalysis {
  const pros = detectPros(actuals.entries, minEntries);

  // Build per-entry Lineup lookup
  const hashToLineup = new Map<string, Lineup>();
  for (const l of fieldLineups) hashToLineup.set(l.hash, l);

  // Field baselines for top1 threshold
  const sorted = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
  const top1 = sorted[Math.max(0, Math.floor(sorted.length * 0.01) - 1)] || 0;
  const top5 = sorted[Math.max(0, Math.floor(sorted.length * 0.05) - 1)] || 0;

  const playerById = new Map(allPlayers.map(p => [p.id, p] as const));

  // Collect per-pro metrics
  const topPros: ProPortfolio[] = [];

  // For each pro, walk their entries and resolve to lineups
  const entryByIdx = actuals.entries;
  const idxByEntryId = new Map<string, number>();
  for (let i = 0; i < entryByIdx.length; i++) idxByEntryId.set(entryByIdx[i].entryId, i);

  for (const pro of pros) {
    const proLineups: Lineup[] = [];
    const proEntries: ContestEntry[] = [];
    for (const e of pro.entries) {
      const idx = idxByEntryId.get(e.entryId);
      if (idx === undefined) continue;
      const h = entryHashes[idx];
      if (!h) continue;
      const l = hashToLineup.get(h);
      if (!l) continue;
      proLineups.push(l);
      proEntries.push(e);
    }
    if (proLineups.length < 20) continue;

    const N = proLineups.length;
    let sumProj = 0, sumVar = 0, sumOwn = 0, sumStack = 0;
    let top1Hits = 0, top5Hits = 0, sumActual = 0, bestRank = Infinity;
    let bringBacks = 0;
    const stackTeams = new Set<string>();
    const exposureCount = new Map<string, number>();
    const anchorCount = new Map<string, number>();
    const hits: ProHittingEntry[] = [];

    for (let i = 0; i < N; i++) {
      const l = proLineups[i];
      const e = proEntries[i];
      sumProj += l.projection;
      sumVar += approximateLineupVariance(l, sport);
      let ownSum = 0;
      for (const p of l.players) ownSum += (p.ownership || 0) / 100;
      const lineupOwn = ownSum / l.players.length;
      sumOwn += lineupOwn;

      const { team: stackTeam, depth } = primaryStackTeam(l, sport);
      sumStack += depth;
      if (stackTeam) stackTeams.add(stackTeam);
      if (hasBringBack(l, sport)) bringBacks++;

      for (const p of l.players) {
        exposureCount.set(p.id, (exposureCount.get(p.id) || 0) + 1);
      }
      const anchor = anchorOfLineup(l, sport);
      if (anchor) anchorCount.set(anchor.id, (anchorCount.get(anchor.id) || 0) + 1);

      sumActual += e.actualPoints;
      if (e.rank < bestRank) bestRank = e.rank;
      if (e.actualPoints >= top1) {
        top1Hits++;
        hits.push({
          rank: e.rank,
          actual: e.actualPoints,
          projection: l.projection,
          ownership: lineupOwn,
          variance: approximateLineupVariance(l, sport),
          stackTeam,
          stackDepth: depth,
          anchor: anchor?.name || '',
        });
      }
      if (e.actualPoints >= top5) top5Hits++;
    }

    // Exposure metrics
    let maxExp = 0, maxExpPlayerId = '';
    let hhi = 0;
    for (const [id, c] of exposureCount) {
      const f = c / N;
      hhi += f * f;
      if (f > maxExp) { maxExp = f; maxExpPlayerId = id; }
    }

    // Pairwise overlap — sample up to 300 pairs for speed
    const maxPairs = 300;
    let pairSum = 0, pairCount = 0;
    if (N > 1) {
      const totalPairs = (N * (N - 1)) / 2;
      if (totalPairs <= maxPairs) {
        for (let i = 0; i < N; i++) {
          const si = new Set(proLineups[i].players.map(p => p.id));
          for (let j = i + 1; j < N; j++) {
            let shared = 0;
            for (const p of proLineups[j].players) if (si.has(p.id)) shared++;
            pairSum += shared;
            pairCount++;
          }
        }
      } else {
        let seed = 7;
        const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };
        for (let p = 0; p < maxPairs; p++) {
          const i = Math.floor(rng() * N);
          let j = Math.floor(rng() * (N - 1));
          if (j >= i) j++;
          const si = new Set(proLineups[i].players.map(p => p.id));
          let shared = 0;
          for (const pl of proLineups[j].players) if (si.has(pl.id)) shared++;
          pairSum += shared;
          pairCount++;
        }
      }
    }
    const avgPairwiseOverlap = pairCount ? pairSum / pairCount : 0;

    // Anchor distribution (top 5)
    const anchorDistribution = Array.from(anchorCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id, c]) => {
        const p = playerById.get(id);
        const fieldOwn = p ? (p.ownership || 0) / 100 : 0;
        const exp = c / N;
        return {
          name: p?.name || id,
          exposure: exp,
          fieldOwnership: fieldOwn,
          leverage: fieldOwn > 0 ? exp / fieldOwn : 0,
        };
      });

    const maxExpPlayerName = playerById.get(maxExpPlayerId)?.name || maxExpPlayerId;

    topPros.push({
      username: pro.username,
      entries: N,
      top1Hits,
      top1Rate: top1Hits / N,
      top5Hits,
      top5Rate: top5Hits / N,
      avgActual: sumActual / N,
      bestRank: bestRank === Infinity ? sorted.length : bestRank,
      avgProjection: sumProj / N,
      avgVariance: sumVar / N,
      avgOwnership: sumOwn / N,
      maxExposure: maxExp,
      maxExposurePlayer: maxExpPlayerName,
      exposureHHI: hhi,
      avgPairwiseOverlap,
      avgStackDepth: sumStack / N,
      uniqueStackTeams: stackTeams.size,
      bringBackRate: bringBacks / N,
      anchorDistribution,
      hittingEntries: hits.sort((a, b) => a.rank - b.rank).slice(0, 10),
    });
  }

  topPros.sort((a, b) => b.top1Rate - a.top1Rate);

  // Field baselines
  let fSumOwn = 0, fSumVar = 0, fSumProj = 0, fN = fieldLineups.length;
  for (const l of fieldLineups) {
    fSumVar += approximateLineupVariance(l, sport);
    fSumProj += l.projection;
    let ownSum = 0;
    for (const p of l.players) ownSum += (p.ownership || 0) / 100;
    fSumOwn += ownSum / l.players.length;
  }
  const fieldExposureCount = new Map<string, number>();
  for (const l of fieldLineups) {
    for (const p of l.players) fieldExposureCount.set(p.id, (fieldExposureCount.get(p.id) || 0) + 1);
  }
  let fieldMaxExp = 0;
  for (const c of fieldExposureCount.values()) {
    const f = c / fN;
    if (f > fieldMaxExp) fieldMaxExp = f;
  }

  return {
    prosDetected: topPros.length,
    minEntriesThreshold: minEntries,
    topPros,
    fieldAvgs: {
      top1Rate: 0.01,
      avgOwnership: fN ? fSumOwn / fN : 0,
      avgVariance: fN ? fSumVar / fN : 0,
      avgProjection: fN ? fSumProj / fN : 0,
      maxExposure: fieldMaxExp,
    },
  };
}
