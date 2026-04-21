/**
 * Production Selector — Clean Architecture for MLB GPP.
 *
 * Empirically validated across 8 MLB slates. Design principles:
 *
 * 1. ANCHOR-RELATIVE COORDINATES: Compute top-50 pool centroid as anchor.
 *    Everything measured as deltas from anchor. Auto-adapts to any slate.
 *
 * 2. OWNERSHIP TARGETING: Portfolio average ownership = anchor - 6pp.
 *    Achieved through bin allocation (chalk + contrarian averaging to target),
 *    NOT hard filtering.
 *
 * 3. TEAM STACK CAP: 10-12% max per-team stack exposure forces diversity.
 *    This was a $5K improvement over 25% cap across 7 slates.
 *
 * 4. RAW PROJECTION WITHIN BINS: No σ_{δ,G}, no Hunter U²ₗ, no parimutuel EV.
 *    Every "smarter" within-bin scoring performed WORSE than raw projection.
 *
 * 5. TEAM COVERAGE: Minimum entries per viable stack team prevents zero-exposure.
 *
 * 6. NO SPECIAL-CASING: No slate-size gating, no dynamic centroid shift,
 *    no region maps. The anchor-relative system handles it all.
 */

import { Lineup, Player } from '../types';
import { computeAnchor, SlateAnchor } from './anchor-relative';

// ============================================================
// CONFIGURATION — calibrated from 8 MLB slates
// ============================================================

export interface ProductionConfig {
  N: number;                    // Portfolio size (default 150)
  ownDropPP: number;            // Target ownership = anchor - this (default 6.0)
  teamCapPct: number;           // Max fraction of N per team stack (default 0.10)
  maxExposure: number;          // Max player exposure fraction (default 0.40)
  anchorTopK: number;           // Top-K lineups for anchor computation (default 50)
  teamCoverageMinPct: number;   // Min entries per team = N / numTeams * this (default 0.6)
  teamCoverageFloor: number;    // Absolute minimum per team (default 3)
}

export const DEFAULT_PRODUCTION_CONFIG: ProductionConfig = {
  N: 150,
  ownDropPP: 6.0,
  teamCapPct: 0.10,
  maxExposure: 0.40,
  anchorTopK: 50,
  teamCoverageMinPct: 0.6,
  teamCoverageFloor: 3,
};

// ============================================================
// OWNERSHIP BINS — 5 bins for allocation
// ============================================================

interface OwnershipBin {
  label: string;
  deltaLo: number;   // relative to anchor ownership
  deltaHi: number;
  fraction: number;   // target fraction of N in this bin
}

/**
 * Bin allocation designed so the portfolio-weighted average ownership
 * lands at approximately anchor - 6pp.
 *
 * Bin midpoints and fractions:
 *   chalk:    [-2, +2] mid=0  → 10% of N → contributes 0pp
 *   core:     [-5, -2] mid=-3.5 → 30% → contributes -1.05pp
 *   value:    [-8, -5] mid=-6.5 → 35% → contributes -2.275pp
 *   contra:   [-12, -8] mid=-10 → 20% → contributes -2.0pp
 *   deep:     [-20, -12] mid=-16 → 5% → contributes -0.8pp
 *   Total weighted delta ≈ -6.1pp ✓
 */
const OWNERSHIP_BINS: OwnershipBin[] = [
  { label: 'chalk',   deltaLo: -2,  deltaHi: 99,  fraction: 0.10 },
  { label: 'core',    deltaLo: -5,  deltaHi: -2,  fraction: 0.30 },
  { label: 'value',   deltaLo: -8,  deltaHi: -5,  fraction: 0.35 },
  { label: 'contra',  deltaLo: -12, deltaHi: -8,  fraction: 0.20 },
  { label: 'deep',    deltaLo: -20, deltaHi: -12, fraction: 0.05 },
];

// ============================================================
// MAIN SELECTOR
// ============================================================

export interface ProductionResult {
  portfolio: Lineup[];
  anchor: SlateAnchor;
  targetOwnership: number;
  actualAvgOwnership: number;
  actualAvgProjection: number;
  teamStackCounts: Map<string, number>;
  binFills: Map<string, number>;
}

export function productionSelect(
  pool: Lineup[],
  players: Player[],
  config: Partial<ProductionConfig> = {},
): ProductionResult {
  const cfg = { ...DEFAULT_PRODUCTION_CONFIG, ...config };
  const { N, ownDropPP, teamCapPct, maxExposure, anchorTopK, teamCoverageMinPct, teamCoverageFloor } = cfg;

  // 1. Compute anchor from top-K pool lineups
  const anchor = computeAnchor(pool, anchorTopK);
  const targetOwn = anchor.ownership - ownDropPP;

  // 2. MLB stack filter — only lineups with 4+ hitters from same team
  const stackPool = pool.filter(lu => {
    const teams = new Map<string, number>();
    for (const p of lu.players) {
      if (!p.positions?.includes('P')) teams.set(p.team, (teams.get(p.team) || 0) + 1);
    }
    let max = 0;
    for (const c of teams.values()) if (c > max) max = c;
    return max >= 4;
  });

  // 3. Compute ownership for each lineup
  const poolWithMeta = stackPool.map(lu => ({
    lu,
    own: lu.players.reduce((s, p) => s + (p.ownership || 0), 0) / lu.players.length,
    proj: lu.projection,
    primaryTeam: getPrimaryStackTeam(lu),
  }));

  // 4. Assign each lineup to an ownership bin (relative to anchor)
  const binned = new Map<string, typeof poolWithMeta>();
  for (const bin of OWNERSHIP_BINS) binned.set(bin.label, []);
  for (const entry of poolWithMeta) {
    const delta = entry.own - anchor.ownership;
    for (const bin of OWNERSHIP_BINS) {
      if (delta >= bin.deltaLo && delta < bin.deltaHi) {
        binned.get(bin.label)!.push(entry);
        break;
      }
    }
  }

  // Sort each bin by projection descending (raw projection wins)
  for (const [, entries] of binned) {
    entries.sort((a, b) => b.proj - a.proj);
  }

  // 5. Compute bin allocations
  const allocations = new Map<string, number>();
  let totalAlloc = 0;
  for (const bin of OWNERSHIP_BINS) {
    const count = Math.round(bin.fraction * N);
    allocations.set(bin.label, count);
    totalAlloc += count;
  }
  // Fix rounding to exactly N
  if (totalAlloc !== N) {
    const largest = OWNERSHIP_BINS.reduce((a, b) => a.fraction > b.fraction ? a : b);
    allocations.set(largest.label, allocations.get(largest.label)! + (N - totalAlloc));
  }

  // 6. Greedy selection with constraints
  const selected: Lineup[] = [];
  const selectedHashes = new Set<string>();
  const playerCount = new Map<string, number>();
  const teamStackCount = new Map<string, number>();
  const maxPerTeam = Math.max(1, Math.floor(N * teamCapPct));
  const expCap = Math.ceil(maxExposure * N);
  const binFills = new Map<string, number>();

  const canAdd = (entry: typeof poolWithMeta[0]): boolean => {
    if (selectedHashes.has(entry.lu.hash)) return false;
    // Player exposure check
    for (const p of entry.lu.players) {
      if ((playerCount.get(p.id) || 0) >= expCap) return false;
    }
    // Team stack cap check
    const team = entry.primaryTeam;
    if (team && (teamStackCount.get(team) || 0) >= maxPerTeam) return false;
    return true;
  };

  const addLineup = (entry: typeof poolWithMeta[0]): void => {
    selected.push(entry.lu);
    selectedHashes.add(entry.lu.hash);
    for (const p of entry.lu.players) {
      playerCount.set(p.id, (playerCount.get(p.id) || 0) + 1);
    }
    const team = entry.primaryTeam;
    if (team) teamStackCount.set(team, (teamStackCount.get(team) || 0) + 1);
  };

  // Fill bins in order: core → value → chalk → contra → deep
  // (fill the meaty middle first for stability)
  const fillOrder = ['core', 'value', 'chalk', 'contra', 'deep'];

  for (const binLabel of fillOrder) {
    const target = allocations.get(binLabel) || 0;
    const candidates = binned.get(binLabel) || [];
    let filled = 0;

    for (const entry of candidates) {
      if (filled >= target) break;
      if (!canAdd(entry)) continue;
      addLineup(entry);
      filled++;
    }
    binFills.set(binLabel, filled);
  }

  // 7. Fill remainder from any bin, by projection
  if (selected.length < N) {
    const allSorted = [...poolWithMeta].sort((a, b) => b.proj - a.proj);
    for (const entry of allSorted) {
      if (selected.length >= N) break;
      if (!canAdd(entry)) continue;
      addLineup(entry);
    }
  }

  // 8. Team coverage enforcement
  const allTeams = new Set<string>();
  for (const p of players) if (p.team) allTeams.add(p.team);
  const minPerTeam = Math.max(teamCoverageFloor, Math.floor(N / allTeams.size * teamCoverageMinPct));

  for (const team of allTeams) {
    const current = teamStackCount.get(team) || 0;
    if (current >= minPerTeam) continue;

    // Check if pool has viable stacks for this team
    const teamCands = poolWithMeta
      .filter(e => e.primaryTeam === team)
      .sort((a, b) => b.proj - a.proj);
    if (teamCands.length < 5) continue;

    const needed = minPerTeam - current;
    let added = 0;

    for (const entry of teamCands) {
      if (added >= needed) break;
      if (selectedHashes.has(entry.lu.hash)) continue;
      // Player exposure check only (team cap is what we're overriding)
      let expOk = true;
      for (const p of entry.lu.players) {
        if ((playerCount.get(p.id) || 0) >= expCap) { expOk = false; break; }
      }
      if (!expOk) continue;

      if (selected.length >= N) {
        // Replace weakest projection lineup
        const wIdx = selected.reduce((best, lu2, idx) =>
          lu2.projection < selected[best].projection ? idx : best, 0);
        const removed = selected[wIdx];
        // Undo removed lineup's tracking
        for (const p of removed.players) {
          const c = playerCount.get(p.id) || 0;
          if (c > 0) playerCount.set(p.id, c - 1);
        }
        selectedHashes.delete(removed.hash);
        const removedTeam = getPrimaryStackTeam(removed);
        if (removedTeam) {
          const tc = teamStackCount.get(removedTeam) || 0;
          if (tc > 0) teamStackCount.set(removedTeam, tc - 1);
        }
        selected[wIdx] = entry.lu;
      } else {
        selected.push(entry.lu);
      }
      selectedHashes.add(entry.lu.hash);
      for (const p of entry.lu.players) {
        playerCount.set(p.id, (playerCount.get(p.id) || 0) + 1);
      }
      teamStackCount.set(team, (teamStackCount.get(team) || 0) + 1);
      added++;
    }
  }

  // 9. Compute portfolio stats
  let sumOwn = 0, sumProj = 0;
  for (const lu of selected) {
    sumOwn += lu.players.reduce((s, p) => s + (p.ownership || 0), 0) / lu.players.length;
    sumProj += lu.projection;
  }

  return {
    portfolio: selected,
    anchor,
    targetOwnership: targetOwn,
    actualAvgOwnership: selected.length > 0 ? sumOwn / selected.length : 0,
    actualAvgProjection: selected.length > 0 ? sumProj / selected.length : 0,
    teamStackCounts: teamStackCount,
    binFills,
  };
}

// ============================================================
// HELPERS
// ============================================================

/** Get the primary stack team (team with most non-pitcher players, if 4+) */
function getPrimaryStackTeam(lu: Lineup): string | null {
  const teams = new Map<string, number>();
  for (const p of lu.players) {
    if (!p.positions?.includes('P')) {
      teams.set(p.team, (teams.get(p.team) || 0) + 1);
    }
  }
  let maxTeam: string | null = null;
  let maxCount = 0;
  for (const [t, c] of teams) {
    if (c > maxCount) { maxCount = c; maxTeam = t; }
  }
  return maxCount >= 4 ? maxTeam : null;
}
