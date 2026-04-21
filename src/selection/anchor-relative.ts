/**
 * Anchor-Relative Distribution Matching.
 *
 * Everything measured relative to the slate's top-100 pool centroid (anchor).
 * Two target distributions from historical data:
 *   - Winner distribution (70% weight): where top-1% finishers land relative to anchor
 *   - Maxer distribution (30% weight): where all 150-maxer entries land (includes lottery tickets)
 *
 * Both distributions transfer across slates because they're relative, not absolute.
 */

import { Lineup, Player } from '../types';
import { ContestActuals, ContestEntry } from '../parser/actuals-parser';

// ============================================================
// ANCHOR COMPUTATION
// ============================================================

export interface SlateAnchor {
  projection: number;
  ownership: number;
}

/** Compute anchor from top-100 lineups in pool by projection. */
export function computeAnchor(pool: Lineup[], topK: number = 100): SlateAnchor {
  const sorted = [...pool].sort((a, b) => b.projection - a.projection).slice(0, topK);
  const n = sorted.length;
  return {
    projection: sorted.reduce((s, l) => s + l.projection, 0) / n,
    ownership: sorted.reduce((s, l) => s + l.players.reduce((so, p) => so + (p.ownership || 0), 0) / l.players.length, 0) / n,
  };
}

// ============================================================
// RELATIVE COORDINATE
// ============================================================

export interface RelativeCoord {
  projDelta: number;   // lineup projection - anchor projection (typically negative)
  ownDelta: number;    // lineup avg ownership - anchor ownership
}

function toRelative(lu: Lineup, anchor: SlateAnchor): RelativeCoord {
  const own = lu.players.reduce((s, p) => s + (p.ownership || 0), 0) / lu.players.length;
  return { projDelta: lu.projection - anchor.projection, ownDelta: own - anchor.ownership };
}

// ============================================================
// BUILD RELATIVE DISTRIBUTIONS FROM HISTORICAL DATA
// ============================================================

export interface RelativeDistribution {
  /** Binned: projDelta bins × ownDelta bins → fraction of entries in that bin */
  bins: Map<string, number>;
  projBins: number[];   // e.g., [-30, -20, -15, -10, -5, 0, 5]
  ownBins: number[];    // e.g., [-10, -7, -4, -2, 0, 2, 5]
  totalEntries: number;
}

function binKey(projDelta: number, ownDelta: number, projBins: number[], ownBins: number[]): string {
  let pBin = 0;
  for (let i = projBins.length - 1; i >= 0; i--) if (projDelta >= projBins[i]) { pBin = i; break; }
  let oBin = 0;
  for (let i = ownBins.length - 1; i >= 0; i--) if (ownDelta >= ownBins[i]) { oBin = i; break; }
  return `${pBin}_${oBin}`;
}

const PROJ_BINS = [-30, -20, -15, -10, -7, -4, -1, 3];
const OWN_BINS = [-12, -8, -5, -3, -1, 1, 3, 6];

export function buildWinnerDistribution(
  slateData: Array<{
    actuals: ContestActuals;
    nameMap: Map<string, Player>;
    pool: Lineup[];
  }>,
): RelativeDistribution {
  const bins = new Map<string, number>();
  let total = 0;

  for (const { actuals, nameMap, pool } of slateData) {
    const anchor = computeAnchor(pool);
    const F = actuals.entries.length;
    const sorted = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
    const top1T = sorted[Math.max(0, Math.floor(F * 0.01) - 1)] || 0;

    for (const e of actuals.entries) {
      if (e.actualPoints < top1T) continue;
      const pls: Player[] = []; let ok = true;
      for (const n of e.playerNames) {
        const norm = n.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
        const p = nameMap.get(norm);
        if (!p) { ok = false; break; }
        pls.push(p);
      }
      if (!ok || pls.length < 8) continue;
      const proj = pls.reduce((s, p) => s + p.projection, 0);
      const own = pls.reduce((s, p) => s + (p.ownership || 0), 0) / pls.length;
      const rel: RelativeCoord = { projDelta: proj - anchor.projection, ownDelta: own - anchor.ownership };
      const key = binKey(rel.projDelta, rel.ownDelta, PROJ_BINS, OWN_BINS);
      bins.set(key, (bins.get(key) || 0) + 1);
      total++;
    }
  }

  // Normalize
  for (const [k, v] of bins) bins.set(k, v / total);
  return { bins, projBins: PROJ_BINS, ownBins: OWN_BINS, totalEntries: total };
}

export function buildMaxerDistribution(
  slateData: Array<{
    actuals: ContestActuals;
    nameMap: Map<string, Player>;
    pool: Lineup[];
  }>,
): RelativeDistribution {
  const bins = new Map<string, number>();
  let total = 0;

  for (const { actuals, nameMap, pool } of slateData) {
    const anchor = computeAnchor(pool);

    const byUser = new Map<string, ContestEntry[]>();
    for (const e of actuals.entries) {
      const u = (e.entryName || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
      if (u) { const a = byUser.get(u); if (a) a.push(e); else byUser.set(u, [e]); }
    }

    for (const [, entries] of byUser) {
      if (entries.length < 140) continue;
      for (const e of entries) {
        const pls: Player[] = []; let ok = true;
        for (const n of e.playerNames) {
          const norm = n.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
          const p = nameMap.get(norm);
          if (!p) { ok = false; break; }
          pls.push(p);
        }
        if (!ok || pls.length < 8) continue;
        const proj = pls.reduce((s, p) => s + p.projection, 0);
        const own = pls.reduce((s, p) => s + (p.ownership || 0), 0) / pls.length;
        const rel: RelativeCoord = { projDelta: proj - anchor.projection, ownDelta: own - anchor.ownership };
        const key = binKey(rel.projDelta, rel.ownDelta, PROJ_BINS, OWN_BINS);
        bins.set(key, (bins.get(key) || 0) + 1);
        total++;
      }
    }
  }

  for (const [k, v] of bins) bins.set(k, v / total);
  return { bins, projBins: PROJ_BINS, ownBins: OWN_BINS, totalEntries: total };
}

// ============================================================
// BLENDED TARGET + REGION ALLOCATION
// ============================================================

export interface AnchorRegionTargets {
  allocations: Map<string, number>;  // binKey → entry count
  anchor: SlateAnchor;
}

export function computeAnchorTargets(
  winnerDist: RelativeDistribution,
  maxerDist: RelativeDistribution,
  anchor: SlateAnchor,
  N: number,
  winnerWeight: number = 0.70,
): AnchorRegionTargets {
  const maxerWeight = 1 - winnerWeight;
  const blended = new Map<string, number>();

  const allKeys = new Set([...winnerDist.bins.keys(), ...maxerDist.bins.keys()]);
  for (const k of allKeys) {
    const wFrac = winnerDist.bins.get(k) || 0;
    const mFrac = maxerDist.bins.get(k) || 0;
    const bFrac = wFrac * winnerWeight + mFrac * maxerWeight;
    if (bFrac > 0.005) blended.set(k, bFrac);
  }

  // Normalize and allocate
  const total = [...blended.values()].reduce((a, b) => a + b, 0);
  const allocations = new Map<string, number>();
  let allocated = 0;
  for (const [k, frac] of blended) {
    const count = Math.round((frac / total) * N);
    if (count > 0) { allocations.set(k, count); allocated += count; }
  }
  // Fix rounding
  if (allocated !== N && allocations.size > 0) {
    const topKey = [...allocations.entries()].sort((a, b) => b[1] - a[1])[0][0];
    allocations.set(topKey, allocations.get(topKey)! + (N - allocated));
  }

  return { allocations, anchor };
}

// ============================================================
// SELECTOR
// ============================================================

export function anchorRelativeSelect(
  pool: Lineup[],
  targets: AnchorRegionTargets,
  N: number,
  maxExposure: number,
  maxPerTeam: number,
): Lineup[] {
  const { allocations, anchor } = targets;
  const selected: Lineup[] = [];
  const selectedHashes = new Set<string>();
  const playerCount = new Map<string, number>();
  const teamStackCount = new Map<string, number>();
  const expCap = Math.ceil(maxExposure * N);

  // Pre-compute each pool lineup's relative bin
  const poolBins = pool.map(lu => {
    const rel = toRelative(lu, anchor);
    return binKey(rel.projDelta, rel.ownDelta, PROJ_BINS, OWN_BINS);
  });

  // Sort allocations by size descending (fill big bins first for stability)
  const sortedAlloc = [...allocations.entries()].sort((a, b) => b[1] - a[1]);

  for (const [binK, targetCount] of sortedAlloc) {
    // Find pool lineups in this bin, sorted by projection desc
    const binCandidates = pool
      .map((lu, i) => ({ lu, i, bin: poolBins[i] }))
      .filter(c => c.bin === binK)
      .sort((a, b) => b.lu.projection - a.lu.projection);

    let filled = 0;
    for (const { lu } of binCandidates) {
      if (filled >= targetCount) break;
      if (selectedHashes.has(lu.hash)) continue;

      let expOk = true;
      for (const p of lu.players) if ((playerCount.get(p.id) || 0) >= expCap) { expOk = false; break; }
      if (!expOk) continue;

      const tc = new Map<string, number>();
      for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
      let teamOk = true;
      for (const [t, cnt] of tc) if (cnt >= 4 && (teamStackCount.get(t) || 0) >= maxPerTeam) { teamOk = false; break; }
      if (!teamOk) continue;

      selected.push(lu);
      selectedHashes.add(lu.hash);
      for (const p of lu.players) playerCount.set(p.id, (playerCount.get(p.id) || 0) + 1);
      for (const [t, cnt] of tc) if (cnt >= 4) teamStackCount.set(t, (teamStackCount.get(t) || 0) + 1);
      filled++;
    }
  }

  // Fill remainder by projection
  if (selected.length < N) {
    const sorted2 = [...pool].sort((a, b) => b.projection - a.projection);
    for (const lu of sorted2) {
      if (selected.length >= N) break;
      if (selectedHashes.has(lu.hash)) continue;
      let expOk = true;
      for (const p of lu.players) if ((playerCount.get(p.id) || 0) >= expCap) { expOk = false; break; }
      if (!expOk) continue;
      selected.push(lu);
      selectedHashes.add(lu.hash);
      for (const p of lu.players) playerCount.set(p.id, (playerCount.get(p.id) || 0) + 1);
    }
  }

  return selected;
}
