/**
 * Combo Leverage — per-lineup construction rarity signal.
 *
 * Captures V35's insight that lineup-level construction matters beyond aggregate
 * ownership, without V35's noisy simulation-EV optimization. Applied as a within-bin
 * additive nudge on top of production's structural framework.
 *
 * Combo types (4):
 *   1. Exact stack identity         — stack:{team}:{sortedHitterIds}
 *   2. Each pitcher                  — p:{pitcherId}
 *   3. Pitcher + primary stack team  — pstack:{pitcherId}:{stackTeam}
 *   4. Stack team + each comp bat    — stackbat:{stackTeam}:{batId}
 *
 * Frequency computed over the SS pool, weighted by projection^k (default k=3,
 * same as V35's field weighting). This approximates the realistic field
 * distribution without running a full simulation.
 */

import { Lineup, Player } from '../types';

const SMOOTHING = 1e-5;
const DEFAULT_PROJECTION_POWER = 3;

/**
 * Identify the combo keys for a single lineup.
 * Returns an empty list if no primary stack (no team with ≥4 hitters) — in that
 * case we still emit pitcher keys so pitcher leverage is counted.
 */
export function comboKeysForLineup(lineup: Lineup): string[] {
  const keys: string[] = [];

  // Partition into pitchers and hitters
  const pitchers: Player[] = [];
  const hittersByTeam = new Map<string, Player[]>();
  for (const p of lineup.players) {
    if (p.positions?.includes('P')) {
      pitchers.push(p);
    } else {
      const t = p.team;
      let arr = hittersByTeam.get(t);
      if (!arr) { arr = []; hittersByTeam.set(t, arr); }
      arr.push(p);
    }
  }

  // Type 2: each pitcher
  for (const pp of pitchers) {
    keys.push(`p:${pp.id}`);
  }

  // Identify primary stack team = team with most hitters, if ≥4
  let stackTeam: string | null = null;
  let stackHitters: Player[] = [];
  let maxCount = 0;
  for (const [team, hitters] of hittersByTeam) {
    if (hitters.length > maxCount) {
      maxCount = hitters.length;
      stackTeam = team;
      stackHitters = hitters;
    }
  }
  if (maxCount < 4) return keys;

  // Type 1: exact stack identity
  const sortedStackIds = stackHitters.map(p => p.id).sort().join(',');
  keys.push(`stack:${stackTeam}:${sortedStackIds}`);

  // Type 3: pitcher + primary stack team
  for (const pp of pitchers) {
    keys.push(`pstack:${pp.id}:${stackTeam}`);
  }

  // Type 4: primary stack team + each complementary bat
  for (const [team, hitters] of hittersByTeam) {
    if (team === stackTeam) continue;
    for (const bat of hitters) {
      keys.push(`stackbat:${stackTeam}:${bat.id}`);
    }
  }

  return keys;
}

/**
 * Precompute weighted combo frequencies over a pool of lineups.
 * Weight per lineup = projection^projectionPower.
 * Returns Map<comboKey, frequency> where frequency = weightedCount / totalWeight.
 */
export function precomputeComboFrequencies(
  pool: Lineup[],
  projectionPower: number = DEFAULT_PROJECTION_POWER,
): Map<string, number> {
  const counts = new Map<string, number>();
  let totalWeight = 0;

  for (const lu of pool) {
    const w = Math.pow(Math.max(0, lu.projection), projectionPower);
    if (w <= 0) continue;
    totalWeight += w;
    const keys = comboKeysForLineup(lu);
    for (const k of keys) {
      counts.set(k, (counts.get(k) || 0) + w);
    }
  }

  const freq = new Map<string, number>();
  if (totalWeight > 0) {
    for (const [k, c] of counts) freq.set(k, c / totalWeight);
  }
  return freq;
}

/**
 * Compute the combo leverage bonus for a lineup.
 * bonus = Σ log(1 / max(freq, SMOOTHING)) across the lineup's combo keys.
 * Higher = rarer construction.
 */
export function comboBonus(lineup: Lineup, freq: Map<string, number>): number {
  const keys = comboKeysForLineup(lineup);
  let bonus = 0;
  for (const k of keys) {
    const f = freq.get(k) || 0;
    bonus += Math.log(1 / Math.max(f, SMOOTHING));
  }
  return bonus;
}
