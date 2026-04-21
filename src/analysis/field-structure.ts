/**
 * Module 3: FIELD STRUCTURE — what the masses do wrong.
 *
 * Measures the field's concentration, combo duplication, stack distribution,
 * and anchor distribution. Flags whether the slate was chalk-dominated or
 * contrarian-dominated based on how the field's most-common plays performed.
 */

import { Lineup, Player, Sport } from '../types';
import { ContestActuals } from '../parser/actuals-parser';
import { anchorOfLineup, countTeamPlayers, normalizeName } from './common';

export interface FieldAnalysis {
  totalEntries: number;
  uniqueLineups: number;

  // Ownership concentration
  top5OwnedPlayers: Array<{
    name: string;
    team: string;
    ownership: number;     // pre-contest (0-1)
    actual: number;
    projectionError: number;
  }>;
  ownershipGini: number;

  // Combo frequency (top 20 3-player combos)
  top20Combos: Array<{
    players: string[];
    frequency: number;    // 0-1
    avgActual: number;
    hitTop1: boolean;
  }>;
  chalkComboHitRate: number;  // fraction of top-20 combos with any top-1% hit

  // Duplication
  exactDuplicateCount: number;
  avgDuplicatesPerLineup: number;

  // Stack distribution
  fieldStackDistribution: Array<{ team: string; fraction: number }>;
  understackedTeams: string[];  // <5% of field 4-stacking

  // Anchor distribution
  fieldAnchorDistribution: Array<{
    name: string;
    ownership: number;
    fraction: number;
    actual: number;
  }>;

  // Slate classification
  chalkAnchorActualVsProj: number;  // (actual - proj) / proj of the #1 anchor
  slateType: 'chalk_won' | 'contrarian_won' | 'mixed';
}

export function analyzeField(
  fieldLineups: Lineup[],
  entryHashes: (string | null)[],
  actuals: ContestActuals,
  hashScores: Map<string, number>,
  allPlayers: Player[],
  sport: Sport,
): FieldAnalysis {
  const totalEntries = actuals.entries.length;
  const uniqueLineups = fieldLineups.length;

  // ─── Duplication: count how many entries share each hash ───
  const hashEntryCount = new Map<string, number>();
  for (const h of entryHashes) {
    if (!h) continue;
    hashEntryCount.set(h, (hashEntryCount.get(h) || 0) + 1);
  }
  let exactDuplicateCount = 0;
  let totalDupes = 0;
  for (const c of hashEntryCount.values()) {
    if (c > 1) {
      exactDuplicateCount += c - 1;   // dupes beyond the first
      totalDupes += c;
    }
  }
  const avgDuplicatesPerLineup = uniqueLineups ? exactDuplicateCount / uniqueLineups : 0;

  // ─── Top owned players ───
  const byOwn = [...allPlayers]
    .filter(p => (p.ownership || 0) > 0)
    .sort((a, b) => (b.ownership || 0) - (a.ownership || 0));
  const top5OwnedPlayers = byOwn.slice(0, 5).map(p => {
    const actualRow = actuals.playerActualsByName.get(normalizeName(p.name));
    const actual = actualRow?.fpts ?? 0;
    return {
      name: p.name,
      team: p.team,
      ownership: (p.ownership || 0) / 100,
      actual,
      projectionError: actual - p.projection,
    };
  });

  // ─── Ownership Gini (over all rostered players) ───
  const ownershipValues = allPlayers.map(p => (p.ownership || 0) / 100).filter(v => v > 0);
  const ownershipGini = gini(ownershipValues);

  // ─── Top 3-player combos in the field ───
  const comboCounts = new Map<string, { ids: string[]; count: number; sumActual: number; hitTop1: boolean }>();
  const top1Threshold = topPercentileScore(actuals, 0.01);
  for (let i = 0; i < fieldLineups.length; i++) {
    const l = fieldLineups[i];
    const actual = hashScores.get(l.hash) ?? 0;
    const isTop1 = actual >= top1Threshold;
    const ids = l.players.map(p => p.id).sort();
    // Enumerate 3-combos — O(C(n,3)) ≤ 120 for NBA 8, 120 for MLB 10 etc. Fine.
    for (let a = 0; a < ids.length; a++) {
      for (let b = a + 1; b < ids.length; b++) {
        for (let c = b + 1; c < ids.length; c++) {
          const key = `${ids[a]}|${ids[b]}|${ids[c]}`;
          const ex = comboCounts.get(key);
          if (ex) {
            ex.count++;
            ex.sumActual += actual;
            if (isTop1) ex.hitTop1 = true;
          } else {
            comboCounts.set(key, {
              ids: [ids[a], ids[b], ids[c]],
              count: 1,
              sumActual: actual,
              hitTop1: isTop1,
            });
          }
        }
      }
    }
  }
  const playerById = new Map(allPlayers.map(p => [p.id, p] as const));
  const topComboArr = Array.from(comboCounts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
  const top20Combos = topComboArr.map(c => ({
    players: c.ids.map(id => playerById.get(id)?.name || id),
    frequency: uniqueLineups ? c.count / uniqueLineups : 0,
    avgActual: c.count ? c.sumActual / c.count : 0,
    hitTop1: c.hitTop1,
  }));
  const chalkComboHitRate = top20Combos.length
    ? top20Combos.filter(c => c.hitTop1).length / top20Combos.length
    : 0;

  // ─── Stack distribution ───
  const teamStackCount = new Map<string, number>();
  for (const l of fieldLineups) {
    const counts = countTeamPlayers(l, { excludePitcher: sport === 'mlb' });
    for (const [team, n] of counts) {
      if (n >= 4) teamStackCount.set(team, (teamStackCount.get(team) || 0) + 1);
    }
  }
  const fieldStackDistribution = Array.from(teamStackCount.entries())
    .map(([team, c]) => ({ team, fraction: c / uniqueLineups }))
    .sort((a, b) => b.fraction - a.fraction);

  const allTeams = new Set<string>();
  for (const p of allPlayers) if (p.team) allTeams.add(p.team);
  const understackedTeams: string[] = [];
  for (const t of allTeams) {
    const frac = (teamStackCount.get(t) || 0) / uniqueLineups;
    if (frac < 0.05) understackedTeams.push(t);
  }

  // ─── Anchor distribution ───
  const anchorCount = new Map<string, number>();
  for (const l of fieldLineups) {
    const a = anchorOfLineup(l, sport);
    if (a) anchorCount.set(a.id, (anchorCount.get(a.id) || 0) + 1);
  }
  const anchorArr = Array.from(anchorCount.entries())
    .map(([id, c]) => {
      const p = playerById.get(id);
      const actualRow = p ? actuals.playerActualsByName.get(normalizeName(p.name)) : undefined;
      return {
        name: p?.name || id,
        ownership: p ? (p.ownership || 0) / 100 : 0,
        fraction: c / uniqueLineups,
        actual: actualRow?.fpts || 0,
        projection: p?.projection || 0,
      };
    })
    .sort((a, b) => b.fraction - a.fraction);
  const fieldAnchorDistribution = anchorArr.slice(0, 10).map(a => ({
    name: a.name,
    ownership: a.ownership,
    fraction: a.fraction,
    actual: a.actual,
  }));

  const topAnchor = anchorArr[0];
  const chalkAnchorActualVsProj = topAnchor && topAnchor.projection > 0
    ? (topAnchor.actual - topAnchor.projection) / topAnchor.projection
    : 0;

  // Slate classification: chalk anchor performance + chalk combo hit rate
  let slateType: FieldAnalysis['slateType'] = 'mixed';
  if (chalkComboHitRate <= 0.25 && chalkAnchorActualVsProj < -0.10) slateType = 'contrarian_won';
  else if (chalkComboHitRate >= 0.50 && chalkAnchorActualVsProj > 0.05) slateType = 'chalk_won';

  return {
    totalEntries,
    uniqueLineups,
    top5OwnedPlayers,
    ownershipGini,
    top20Combos,
    chalkComboHitRate,
    exactDuplicateCount,
    avgDuplicatesPerLineup,
    fieldStackDistribution,
    understackedTeams,
    fieldAnchorDistribution,
    chalkAnchorActualVsProj,
    slateType,
  };
}

// ============================================================
// HELPERS
// ============================================================

function gini(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  let cum = 0, sum = 0;
  for (let i = 0; i < n; i++) {
    cum += (i + 1) * sorted[i];
    sum += sorted[i];
  }
  if (sum === 0) return 0;
  return (2 * cum) / (n * sum) - (n + 1) / n;
}

function topPercentileScore(actuals: ContestActuals, frac: number): number {
  const scores = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
  return scores[Math.max(0, Math.floor(scores.length * frac) - 1)] || 0;
}
