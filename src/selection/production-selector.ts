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
import { comboBonus } from './combo-leverage';

// ============================================================
// CONFIGURATION — calibrated from 8 MLB slates
// ============================================================

export interface ProductionConfig {
  N: number;                    // Portfolio size (default 150)
  ownDropPP: number;            // Target ownership = anchor - this (default 6.0)
  teamCapPct: number;           // Max fraction of N per team stack (default 0.10)
  maxExposure: number;          // Max player exposure fraction for non-pitchers (default 0.40)
  maxExposurePitcher: number;   // Max exposure fraction for pitchers specifically (default = maxExposure)
  anchorTopK: number;           // Top-K lineups for anchor computation (default 50)
  teamCoverageMinPct: number;   // Min entries per team = N / numTeams * this (default 0.6)
  teamCoverageFloor: number;    // Absolute minimum per team (default 3)
  lambda: number;               // Combo leverage weight (default 0 = pure raw projection)
  comboFreq?: Map<string, number>; // Precomputed combo frequencies; required if lambda > 0
  maxOverlap: number;           // Max shared players between any two selected lineups (10 = no constraint)
  sameStackMaxOverlap: number;  // Max shared players when two lineups share primary stack team (10 = disabled, use global maxOverlap only)
  ownershipCeilingBuffer: number; // Proportional ownership filter: buffer in pp added to the linear cap. Positive = looser, negative = stricter. Only applied when useOwnershipCeiling=true.
  useOwnershipCeiling: boolean; // Enable proportional ownership filter (default false)
  binAllocation?: { chalk: number; core: number; value: number; contra: number; deep: number }; // Override bin fractions (default 10/30/35/20/5)
  extremeCornerCap: boolean; // Cap (Q5-proj, Q5-own) and (Q1-proj, Q1-own) cells to force middle-cell representation (default false)
  extremeCornerQ5Q5Pct: number; // Max share of portfolio in (Q5-proj, Q5-own) cell (default 0.25 = 25%, nerdy's rate)
  extremeCornerQ1Q1Pct: number; // Max share of portfolio in (Q1-proj, Q1-own) cell (default 0.05 = 5%, nerdy's rate)
  minPrimaryStack: number;      // Minimum primary stack size for pool filter (default 4 = legacy behavior, 0 = no internal filter)
  projectionFloorPct: number;   // Minimum projection as fraction of pool optimum (default 0 = disabled; 0.85 = reject lineups below 85% of max proj)
}

export const DEFAULT_PRODUCTION_CONFIG: ProductionConfig = {
  N: 150,
  ownDropPP: 6.0,
  teamCapPct: 0.10,
  maxExposure: 0.40,
  maxExposurePitcher: 0.40,
  anchorTopK: 50,
  teamCoverageMinPct: 0.6,
  teamCoverageFloor: 3,
  lambda: 0,
  maxOverlap: 7,
  sameStackMaxOverlap: 10,
  ownershipCeilingBuffer: 0,
  useOwnershipCeiling: false,
  extremeCornerCap: false,
  extremeCornerQ5Q5Pct: 0.25,
  extremeCornerQ1Q1Pct: 0.05,
  minPrimaryStack: 4,
  projectionFloorPct: 0,
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
  ownershipCeiling?: { filtered: number; minCeiling: number; medianCeiling: number; maxCeiling: number };
}

export function productionSelect(
  pool: Lineup[],
  players: Player[],
  config: Partial<ProductionConfig> = {},
): ProductionResult {
  const cfg = { ...DEFAULT_PRODUCTION_CONFIG, ...config };
  const { N, ownDropPP, teamCapPct, maxExposure, maxExposurePitcher, anchorTopK, teamCoverageMinPct, teamCoverageFloor, lambda, comboFreq, maxOverlap, sameStackMaxOverlap, ownershipCeilingBuffer, useOwnershipCeiling, extremeCornerCap, extremeCornerQ5Q5Pct, extremeCornerQ1Q1Pct, minPrimaryStack, binAllocation, projectionFloorPct } = cfg;
  const useCombo = lambda > 0 && comboFreq !== undefined;
  const useOverlap = maxOverlap < 10;
  const useSameStackCap = sameStackMaxOverlap < 10;
  const useOwnCeiling = useOwnershipCeiling === true;
  const useCornerCap = extremeCornerCap === true;

  // 1. Compute anchor from top-K pool lineups
  const anchor = computeAnchor(pool, anchorTopK);
  const targetOwn = anchor.ownership - ownDropPP;

  // 1b. Projection floor — reject any lineup whose projection < projectionFloorPct * pool optimum.
  // Acts as a safety rail: prevents contrarian structure from picking up lineups too far below optimal.
  let projFilteredPool = pool;
  if (projectionFloorPct > 0 && pool.length > 0) {
    let optimalProj = 0;
    for (const lu of pool) if (lu.projection > optimalProj) optimalProj = lu.projection;
    const floor = projectionFloorPct * optimalProj;
    projFilteredPool = pool.filter(lu => lu.projection >= floor);
  }

  // 2. MLB stack filter — default requires primary stack >= minPrimaryStack (default 4).
  // minPrimaryStack=0 disables the filter entirely (caller is expected to pre-filter).
  const stackPool = minPrimaryStack <= 0 ? projFilteredPool : projFilteredPool.filter(lu => {
    const teams = new Map<string, number>();
    for (const p of lu.players) {
      if (!p.positions?.includes('P')) teams.set(p.team, (teams.get(p.team) || 0) + 1);
    }
    let max = 0;
    for (const c of teams.values()) if (c > max) max = c;
    return max >= minPrimaryStack;
  });

  // 3. Compute ownership for each lineup (+ combo bonus if lambda > 0, + player id set if overlap constraint active)
  let poolWithMeta = stackPool.map(lu => ({
    lu,
    own: lu.players.reduce((s, p) => s + (p.ownership || 0), 0) / lu.players.length,
    proj: lu.projection,
    cb: useCombo ? comboBonus(lu, comboFreq!) : 0,
    primaryTeam: getPrimaryStackTeam(lu),
    pidSet: (useOverlap || useSameStackCap) ? new Set(lu.players.map(p => p.id)) : null,
  }));

  // 3b. Proportional ownership ceiling (optional, stricter variant).
  // Cap scales linearly with projection across the ENTIRE range, not just median→max.
  // At max projection: cap = anchor + buffer
  // At median projection: cap = (anchor - ownDropPP) + buffer
  // At min projection: cap = (anchor - ownDropPP) + buffer - (anchor - (anchor - ownDropPP)) = anchor - 2*ownDropPP + buffer
  //                    (i.e., the same slope continues symmetrically below median)
  // Hard filter — pruned lineups can't enter the bins.
  let ownCeilingStats = { filtered: 0, minCeiling: 0, medianCeiling: 0, maxCeiling: 0 };
  if (useOwnCeiling) {
    const projsSorted = poolWithMeta.map(e => e.proj).sort((a, b) => a - b);
    const medianProj = projsSorted[Math.floor(projsSorted.length / 2)];
    const maxProj = projsSorted[projsSorted.length - 1];
    const minProj = projsSorted[0];
    const targetAvgOwn = anchor.ownership - ownDropPP;
    const slopeHigh = maxProj > medianProj ? (anchor.ownership - targetAvgOwn) / (maxProj - medianProj) : 0;
    const slopeLow = medianProj > minProj ? (anchor.ownership - targetAvgOwn) / (maxProj - medianProj) : 0;
    const before = poolWithMeta.length;
    poolWithMeta = poolWithMeta.filter(e => {
      // Linear cap with the same slope on both sides of median.
      // Above median: cap = targetAvgOwn + buffer + (proj - median) * slope
      // Below median: cap = targetAvgOwn + buffer + (proj - median) * slope   (same formula, negative delta reduces cap)
      const delta = e.proj - medianProj;
      const ceiling = targetAvgOwn + ownershipCeilingBuffer + delta * slopeHigh;
      return e.own <= ceiling;
    });
    ownCeilingStats = {
      filtered: before - poolWithMeta.length,
      minCeiling: targetAvgOwn + ownershipCeilingBuffer + (minProj - medianProj) * slopeHigh,
      medianCeiling: targetAvgOwn + ownershipCeilingBuffer,
      maxCeiling: anchor.ownership + ownershipCeilingBuffer,
    };
  }

  // 3c. Compute pool-wide projection and ownership quintile thresholds (for extreme-corner cap).
  let projQThresh: [number, number, number, number] = [0, 0, 0, 0];
  let ownQThresh: [number, number, number, number] = [0, 0, 0, 0];
  if (useCornerCap && poolWithMeta.length > 0) {
    const allProj = poolWithMeta.map(e => e.proj).sort((a, b) => a - b);
    const allOwn = poolWithMeta.map(e => e.own).sort((a, b) => a - b);
    const n = allProj.length;
    projQThresh = [allProj[Math.floor(n * 0.2)], allProj[Math.floor(n * 0.4)], allProj[Math.floor(n * 0.6)], allProj[Math.floor(n * 0.8)]];
    ownQThresh = [allOwn[Math.floor(n * 0.2)], allOwn[Math.floor(n * 0.4)], allOwn[Math.floor(n * 0.6)], allOwn[Math.floor(n * 0.8)]];
  }
  const projQ = (p: number) => p >= projQThresh[3] ? 4 : p >= projQThresh[2] ? 3 : p >= projQThresh[1] ? 2 : p >= projQThresh[0] ? 1 : 0;
  const ownQ = (o: number) => o >= ownQThresh[3] ? 4 : o >= ownQThresh[2] ? 3 : o >= ownQThresh[1] ? 2 : o >= ownQThresh[0] ? 1 : 0;

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

  // Sort each bin by score descending. lambda=0 → pure projection (identical to baseline).
  // lambda>0 → projection + lambda * combo leverage bonus (rarer construction nudged up).
  for (const [, entries] of binned) {
    if (useCombo) {
      entries.sort((a, b) => (b.proj + lambda * b.cb) - (a.proj + lambda * a.cb));
    } else {
      entries.sort((a, b) => b.proj - a.proj);
    }
  }

  // 5. Compute bin allocations (use override fractions if binAllocation provided)
  const effectiveFractions = binAllocation
    ? [binAllocation.chalk, binAllocation.core, binAllocation.value, binAllocation.contra, binAllocation.deep]
    : OWNERSHIP_BINS.map(b => b.fraction);
  const allocations = new Map<string, number>();
  let totalAlloc = 0;
  for (let i = 0; i < OWNERSHIP_BINS.length; i++) {
    const count = Math.round(effectiveFractions[i] * N);
    allocations.set(OWNERSHIP_BINS[i].label, count);
    totalAlloc += count;
  }
  // Fix rounding to exactly N
  if (totalAlloc !== N) {
    // Award the residual to the largest bin by fraction
    let largestIdx = 0;
    for (let i = 1; i < OWNERSHIP_BINS.length; i++) if (effectiveFractions[i] > effectiveFractions[largestIdx]) largestIdx = i;
    const label = OWNERSHIP_BINS[largestIdx].label;
    allocations.set(label, allocations.get(label)! + (N - totalAlloc));
  }

  // 6. Greedy selection with constraints
  const selected: Lineup[] = [];
  const selectedHashes = new Set<string>();
  const selectedPidSets: Set<string>[] = []; // parallel to selected, populated when useOverlap or useSameStackCap
  const selectedPrimaryTeams: (string | null)[] = []; // parallel to selected, for same-stack overlap check
  const playerCount = new Map<string, number>();
  const teamStackCount = new Map<string, number>();
  const maxPerTeam = Math.max(1, Math.floor(N * teamCapPct));
  const expCap = Math.ceil(maxExposure * N);
  const expCapPitcher = Math.ceil(maxExposurePitcher * N);
  const binFills = new Map<string, number>();
  let q5q5Count = 0, q1q1Count = 0;
  const q5q5Max = useCornerCap ? Math.ceil(extremeCornerQ5Q5Pct * N) : Infinity;
  const q1q1Max = useCornerCap ? Math.ceil(extremeCornerQ1Q1Pct * N) : Infinity;

  const canAdd = (entry: typeof poolWithMeta[0]): boolean => {
    if (selectedHashes.has(entry.lu.hash)) return false;
    // Player exposure check — pitchers get their own cap (maxExposurePitcher)
    for (const p of entry.lu.players) {
      const cap = p.positions?.includes('P') ? expCapPitcher : expCap;
      if ((playerCount.get(p.id) || 0) >= cap) return false;
    }
    // Team stack cap check
    const team = entry.primaryTeam;
    if (team && (teamStackCount.get(team) || 0) >= maxPerTeam) return false;
    // Extreme-corner cap (Q5-Q5 chalk stars, Q1-Q1 contrarian punts)
    if (useCornerCap) {
      const pq = projQ(entry.proj), oq = ownQ(entry.own);
      if (pq === 4 && oq === 4 && q5q5Count >= q5q5Max) return false;
      if (pq === 0 && oq === 0 && q1q1Count >= q1q1Max) return false;
    }
    // Pairwise overlap check (gamma) — skip candidates sharing > maxOverlap players with any selected
    // When same-stack cap is active, apply the tighter sameStackMaxOverlap to pairs sharing the primary stack team.
    if ((useOverlap || useSameStackCap) && entry.pidSet) {
      const candTeam = entry.primaryTeam;
      for (let si = 0; si < selectedPidSets.length; si++) {
        const sel = selectedPidSets[si];
        const selTeam = selectedPrimaryTeams[si];
        const sameStack = useSameStackCap && candTeam !== null && candTeam === selTeam;
        const cap = sameStack ? Math.min(maxOverlap, sameStackMaxOverlap) : maxOverlap;
        if (cap >= 10 && !sameStack) continue;
        let shared = 0;
        for (const id of entry.pidSet) {
          if (sel.has(id)) {
            shared++;
            if (shared > cap) return false;
          }
        }
      }
    }
    return true;
  };

  const addLineup = (entry: typeof poolWithMeta[0]): void => {
    selected.push(entry.lu);
    selectedHashes.add(entry.lu.hash);
    if ((useOverlap || useSameStackCap) && entry.pidSet) {
      selectedPidSets.push(entry.pidSet);
      selectedPrimaryTeams.push(entry.primaryTeam);
    }
    if (useCornerCap) {
      const pq = projQ(entry.proj), oq = ownQ(entry.own);
      if (pq === 4 && oq === 4) q5q5Count++;
      if (pq === 0 && oq === 0) q1q1Count++;
    }
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
        const cap = p.positions?.includes('P') ? expCapPitcher : expCap;
        if ((playerCount.get(p.id) || 0) >= cap) { expOk = false; break; }
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
    ownershipCeiling: useOwnCeiling ? ownCeilingStats : undefined,
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
