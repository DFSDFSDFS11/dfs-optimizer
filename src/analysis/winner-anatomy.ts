/**
 * Module 1: WINNER ANATOMY
 *
 * Dissects every lineup that finished in the top 1% of the contest. Produces:
 *   • alphaPlayers      — players massively over-represented in winners vs field
 *   • winnerStackProfile— per-team presence in winners vs field
 *   • winnerAvg*        — ownership / projection / error / variance of winners
 *   • ownershipDirection— whether winners were chalkier or more contrarian
 *
 * Input contract: joined field lineups + ContestActuals with per-player FPTS.
 */

import { ContestActuals } from '../parser/actuals-parser';
import { Lineup, Player, Sport } from '../types';
import {
  approximateLineupVariance,
  computeFieldThresholds,
  countTeamPlayers,
  normalizeName,
} from './common';

export interface AlphaPlayer {
  id: string;
  name: string;
  team: string;
  position: string;
  salary: number;
  ownership: number;         // 0-1 pre-contest
  projection: number;
  actual: number;
  projectionError: number;   // actual - projection
  ceilingRealization: number;// actual / p99 (0 if no p99)
  frequencyInTop1: number;   // 0-1
  frequencyInField: number;  // 0-1
  winnerLift: number;        // frequencyInTop1 / frequencyInField
}

export interface StackProfileEntry {
  team: string;
  winnerRate: number;        // fraction of top-1% lineups stacking 4+
  fieldRate: number;         // fraction of field stacking 4+
  winnerAvgDepth: number;
  fieldAvgDepth: number;
  stackLift: number;         // winnerRate / max(fieldRate, eps)
}

export interface WinnerAnatomy {
  slate: string;
  totalEntries: number;
  top1Count: number;
  top1Threshold: number;

  // Winner-level stats
  winnerAvgOwnership: number;
  winnerAvgProjection: number;
  winnerAvgActual: number;
  winnerAvgError: number;
  winnerAvgSalary: number;
  winnerAvgSalaryLeftover: number;
  winnerAvgVariance: number;
  winnerAvgStackDepth: number;

  // Field-level baselines
  fieldAvgOwnership: number;
  fieldAvgProjection: number;
  fieldAvgActual: number;
  fieldAvgError: number;
  fieldAvgSalary: number;
  fieldAvgSalaryLeftover: number;
  fieldAvgVariance: number;
  fieldAvgStackDepth: number;

  // Deltas
  ownershipDirection: 'chalkier' | 'more_contrarian' | 'neutral';
  ownershipDelta: number;        // winner - field (percentage points)
  varianceDelta: number;         // winner / field - 1
  projectionDelta: number;
  stackDepthDelta: number;

  // Top 15 alpha players (by winnerLift, min frequencyInTop1 > 0.10)
  alphaPlayers: AlphaPlayer[];

  // Stack profile
  stackProfile: StackProfileEntry[];
}

export function analyzeWinners(
  slate: string,
  fieldLineups: Lineup[],
  entryHashes: (string | null)[],  // index-aligned with ContestActuals.entries
  actuals: ContestActuals,
  hashScores: Map<string, number>,
  allPlayers: Player[],
  sport: Sport,
  salaryCap: number,
): WinnerAnatomy {
  const thresholds = computeFieldThresholds(actuals.entries);
  const { top1, top1Count, totalEntries } = thresholds;

  // Identify top-1% entries and their lineups (via hash)
  const top1Entries = actuals.entries.filter(e => e.actualPoints >= top1);
  const top1Hashes = new Set<string>();
  for (let i = 0; i < actuals.entries.length; i++) {
    const e = actuals.entries[i];
    if (e.actualPoints >= top1) {
      const h = entryHashes[i];
      if (h) top1Hashes.add(h);
    }
  }

  // Get the unique top-1% lineups
  const hashToLineup = new Map<string, Lineup>();
  for (const l of fieldLineups) hashToLineup.set(l.hash, l);
  const top1Lineups: Lineup[] = [];
  for (const h of top1Hashes) {
    const l = hashToLineup.get(h);
    if (l) top1Lineups.push(l);
  }

  // ─── Winner-level aggregates ───
  const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  const winnerVar = top1Lineups.map(l => approximateLineupVariance(l, sport));
  const winnerOwn = top1Lineups.map(l => avgPlayerOwnership(l));
  const winnerProj = top1Lineups.map(l => l.projection);
  const winnerActual = top1Entries.map(e => e.actualPoints);
  const winnerSalary = top1Lineups.map(l => l.salary);
  const winnerStack = top1Lineups.map(l => maxTeamCount(l, sport));
  const winnerError = top1Lineups.map(l => {
    const actual = hashScores.get(l.hash) ?? 0;
    return actual - l.projection;
  });

  // ─── Field baselines (entire joined field) ───
  const fieldVar = fieldLineups.map(l => approximateLineupVariance(l, sport));
  const fieldOwn = fieldLineups.map(l => avgPlayerOwnership(l));
  const fieldProj = fieldLineups.map(l => l.projection);
  const fieldActualArr = fieldLineups.map(l => hashScores.get(l.hash) ?? 0);
  const fieldSalary = fieldLineups.map(l => l.salary);
  const fieldStack = fieldLineups.map(l => maxTeamCount(l, sport));
  const fieldError = fieldLineups.map(l => {
    const a = hashScores.get(l.hash) ?? 0;
    return a - l.projection;
  });

  const winnerAvgOwnership = avg(winnerOwn);
  const fieldAvgOwnership = avg(fieldOwn);
  const ownershipDelta = (winnerAvgOwnership - fieldAvgOwnership) * 100;
  const ownershipDirection: WinnerAnatomy['ownershipDirection'] =
    Math.abs(ownershipDelta) < 0.5 ? 'neutral' :
    ownershipDelta < 0 ? 'more_contrarian' : 'chalkier';

  // ─── Alpha players ───
  const alphaPlayers = computeAlphaPlayers(
    top1Lineups, fieldLineups, top1Count, totalEntries, actuals, allPlayers,
  );

  // ─── Stack profile ───
  const stackProfile = computeStackProfile(top1Lineups, fieldLineups, sport);

  const winnerAvgVariance = avg(winnerVar);
  const fieldAvgVariance = avg(fieldVar);
  const winnerAvgProjection = avg(winnerProj);
  const fieldAvgProjection = avg(fieldProj);
  const winnerAvgStackDepth = avg(winnerStack);
  const fieldAvgStackDepth = avg(fieldStack);

  return {
    slate,
    totalEntries,
    top1Count,
    top1Threshold: top1,
    winnerAvgOwnership,
    winnerAvgProjection,
    winnerAvgActual: avg(winnerActual),
    winnerAvgError: avg(winnerError),
    winnerAvgSalary: avg(winnerSalary),
    winnerAvgSalaryLeftover: salaryCap - avg(winnerSalary),
    winnerAvgVariance,
    winnerAvgStackDepth,
    fieldAvgOwnership,
    fieldAvgProjection,
    fieldAvgActual: avg(fieldActualArr),
    fieldAvgError: avg(fieldError),
    fieldAvgSalary: avg(fieldSalary),
    fieldAvgSalaryLeftover: salaryCap - avg(fieldSalary),
    fieldAvgVariance,
    fieldAvgStackDepth,
    ownershipDirection,
    ownershipDelta,
    varianceDelta: fieldAvgVariance > 0 ? winnerAvgVariance / fieldAvgVariance - 1 : 0,
    projectionDelta: fieldAvgProjection > 0 ? winnerAvgProjection / fieldAvgProjection - 1 : 0,
    stackDepthDelta: winnerAvgStackDepth - fieldAvgStackDepth,
    alphaPlayers,
    stackProfile,
  };
}

// ============================================================
// HELPERS
// ============================================================

function avgPlayerOwnership(lu: Lineup): number {
  if (lu.players.length === 0) return 0;
  let sum = 0;
  for (const p of lu.players) sum += (p.ownership || 0) / 100;
  return sum / lu.players.length;
}

function maxTeamCount(lu: Lineup, sport: Sport): number {
  const counts = countTeamPlayers(lu, { excludePitcher: sport === 'mlb' });
  let max = 0;
  for (const c of counts.values()) if (c > max) max = c;
  return max;
}

function computeAlphaPlayers(
  top1Lineups: Lineup[],
  fieldLineups: Lineup[],
  top1Count: number,
  fieldSize: number,
  actuals: ContestActuals,
  allPlayers: Player[],
): AlphaPlayer[] {
  // Count player appearances in top-1% and in field
  const topCounts = new Map<string, number>();
  const fieldCounts = new Map<string, number>();
  for (const l of top1Lineups) {
    for (const p of l.players) topCounts.set(p.id, (topCounts.get(p.id) || 0) + 1);
  }
  for (const l of fieldLineups) {
    for (const p of l.players) fieldCounts.set(p.id, (fieldCounts.get(p.id) || 0) + 1);
  }

  const playerById = new Map<string, Player>();
  for (const p of allPlayers) playerById.set(p.id, p);

  const alphas: AlphaPlayer[] = [];
  for (const [id, tc] of topCounts) {
    const player = playerById.get(id);
    if (!player) continue;
    const fc = fieldCounts.get(id) || 0;
    const freqTop = tc / Math.max(1, top1Lineups.length);
    const freqField = fc / Math.max(1, fieldLineups.length);
    const lift = freqField > 0 ? freqTop / freqField : freqTop * 1000;
    const actualRow = actuals.playerActualsByName.get(normalizeName(player.name));
    const actual = actualRow?.fpts ?? 0;
    const p99 = player.percentiles?.p99 || player.ceiling99 || 0;

    alphas.push({
      id: player.id,
      name: player.name,
      team: player.team,
      position: player.position,
      salary: player.salary,
      ownership: (player.ownership || 0) / 100,
      projection: player.projection,
      actual,
      projectionError: actual - player.projection,
      ceilingRealization: p99 > 0 ? actual / p99 : 0,
      frequencyInTop1: freqTop,
      frequencyInField: freqField,
      winnerLift: lift,
    });
  }

  // Filter to meaningful alphas (present in >=10% of winners) and sort by lift
  return alphas
    .filter(a => a.frequencyInTop1 >= 0.05)
    .sort((a, b) => b.winnerLift - a.winnerLift)
    .slice(0, 15);
}

function computeStackProfile(
  top1Lineups: Lineup[],
  fieldLineups: Lineup[],
  sport: Sport,
): StackProfileEntry[] {
  const teams = new Set<string>();
  for (const l of [...top1Lineups, ...fieldLineups]) {
    for (const p of l.players) if (p.team) teams.add(p.team);
  }

  const stackDepth = (lu: Lineup, team: string): number => {
    let n = 0;
    for (const p of lu.players) {
      if (p.team !== team) continue;
      if (sport === 'mlb' && p.positions?.includes('P')) continue;
      n++;
    }
    return n;
  };

  const result: StackProfileEntry[] = [];
  for (const team of teams) {
    const winnerDepths = top1Lineups.map(l => stackDepth(l, team));
    const fieldDepths = fieldLineups.map(l => stackDepth(l, team));
    const winnerStacked = winnerDepths.filter(d => d >= 4).length;
    const fieldStacked = fieldDepths.filter(d => d >= 4).length;
    const winnerRate = top1Lineups.length ? winnerStacked / top1Lineups.length : 0;
    const fieldRate = fieldLineups.length ? fieldStacked / fieldLineups.length : 0;
    if (winnerRate === 0 && fieldRate < 0.01) continue;
    const avg = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
    result.push({
      team,
      winnerRate,
      fieldRate,
      winnerAvgDepth: avg(winnerDepths),
      fieldAvgDepth: avg(fieldDepths),
      stackLift: fieldRate > 0 ? winnerRate / fieldRate : winnerRate * 100,
    });
  }

  return result.sort((a, b) => b.stackLift - a.stackLift).slice(0, 15);
}
