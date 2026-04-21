/**
 * Pool Augmentation — Generate diverse lineups via modified-objective optimization.
 *
 * Each strategy clones the player pool, tweaks projections, runs the B&B
 * optimizer (which thinks it's maximizing projection), then restores real
 * projections on the resulting lineups.  The merged pool feeds downstream
 * selection (Algorithm 7, emax, etc.) with structurally different candidates.
 *
 * Strategies:
 *   1. Variance-seeking  (projection + λ·σ)
 *   2. Team-forced stacks (+50% team boost)
 *   3. Ceiling pool       (p95 / p99 as objective)
 *   4. Contrarian          (ownership-penalised projection)
 */

import {
  ContestConfig,
  Lineup,
  Player,
  PlayerPool,
} from '../types';
import { optimizeLineups } from './branch-bound';

// ============================================================
// HELPERS
// ============================================================

/** Build a PlayerPool from a player array with lookup maps. */
function buildPool(players: Player[]): PlayerPool {
  const byId = new Map<string, Player>();
  const byPosition = new Map<string, Player[]>();
  const byTeam = new Map<string, Player[]>();
  for (const p of players) {
    byId.set(p.id, p);
    const posArr = byPosition.get(p.position) ?? [];
    posArr.push(p);
    byPosition.set(p.position, posArr);
    for (const pos of p.positions) {
      if (pos !== p.position) {
        const arr = byPosition.get(pos) ?? [];
        arr.push(p);
        byPosition.set(pos, arr);
      }
    }
    const teamArr = byTeam.get(p.team) ?? [];
    teamArr.push(p);
    byTeam.set(p.team, teamArr);
  }
  return { players, byId, byPosition, byTeam };
}

/** Clone players with a projection modifier, preserving all other fields. */
function clonePoolWithModifiedProjections(
  players: Player[],
  modifyFn: (p: Player) => number,
): PlayerPool {
  const cloned = players.map((p, i) => {
    const newProj = modifyFn(p);
    return {
      ...p,
      index: i,
      projection: newProj,
      value: newProj / (p.salary / 1000),
    };
  });
  return buildPool(cloned);
}

/** Estimate stdDev when not provided. */
function estimateStdDev(p: Player): number {
  if (p.stdDev && p.stdDev > 0) return p.stdDev;
  if (p.percentiles && p.percentiles.p95 > 0 && p.percentiles.p25 > 0) {
    return (p.percentiles.p95 - p.percentiles.p25) / 1.35;
  }
  if (p.ceiling > 0 && p.projection > 0) {
    return (p.ceiling - p.projection) / 1.04;
  }
  // Fallback: ~20% of projection
  return p.projection * 0.20;
}

/** Map from original player ID → original Player for projection restoration. */
function buildOriginalMap(players: Player[]): Map<string, Player> {
  const m = new Map<string, Player>();
  for (const p of players) m.set(p.id, p);
  return m;
}

/** Restore original projections on lineups generated with modified objectives. */
function restoreProjections(lineups: Lineup[], origMap: Map<string, Player>): void {
  for (const lu of lineups) {
    let proj = 0;
    let own = 0;
    for (let i = 0; i < lu.players.length; i++) {
      const orig = origMap.get(lu.players[i].id);
      if (orig) {
        lu.players[i] = { ...lu.players[i], projection: orig.projection, value: orig.value };
        proj += orig.projection;
        own += orig.ownership;
      } else {
        proj += lu.players[i].projection;
        own += lu.players[i].ownership;
      }
    }
    lu.projection = proj;
    lu.ownership = own;
  }
}

/** Tag each lineup's constructionMethod. */
function tagLineups(lineups: Lineup[], method: string): void {
  for (const lu of lineups) lu.constructionMethod = method;
}

// ============================================================
// STRATEGY 1: VARIANCE-SEEKING
// ============================================================

function generateVariancePool(
  players: Player[],
  config: ContestConfig,
  lambda: number,
  count: number,
): Lineup[] {
  const pool = clonePoolWithModifiedProjections(players, (p) => {
    const sd = estimateStdDev(p);
    return p.projection + lambda * sd;
  });
  const result = optimizeLineups({
    config,
    pool,
    poolSize: count,
  });
  const origMap = buildOriginalMap(players);
  restoreProjections(result.lineups, origMap);
  tagLineups(result.lineups, `variance-${lambda}`);
  return result.lineups;
}

// ============================================================
// STRATEGY 2: TEAM-FORCED STACKS
// ============================================================

function generateTeamForcedPool(
  players: Player[],
  config: ContestConfig,
  perTeam: number,
): Lineup[] {
  const teams = new Set<string>();
  for (const p of players) teams.add(p.team);

  const origMap = buildOriginalMap(players);
  const allLineups: Lineup[] = [];

  for (const team of teams) {
    const pool = clonePoolWithModifiedProjections(players, (p) => {
      return p.team === team ? p.projection * 1.5 : p.projection;
    });
    const result = optimizeLineups({
      config,
      pool,
      poolSize: perTeam,
    });
    restoreProjections(result.lineups, origMap);
    tagLineups(result.lineups, `team-forced-${team}`);
    allLineups.push(...result.lineups);
  }

  return allLineups;
}

// ============================================================
// STRATEGY 3: CEILING POOL
// ============================================================

function generateCeilingPool(
  players: Player[],
  config: ContestConfig,
  count: number,
): Lineup[] {
  const origMap = buildOriginalMap(players);

  // p95 pool: first 75% of count
  const p95Count = Math.round(count * 0.75);
  const p95Pool = clonePoolWithModifiedProjections(players, (p) => {
    if (p.percentiles && p.percentiles.p95 > 0) return p.percentiles.p95;
    // Fallback: use ceiling (p85)
    return p.ceiling > 0 ? p.ceiling : p.projection * 1.2;
  });
  const p95Result = optimizeLineups({ config, pool: p95Pool, poolSize: p95Count });
  restoreProjections(p95Result.lineups, origMap);
  tagLineups(p95Result.lineups, 'ceiling-p95');

  // p99 pool: remaining 25%
  const p99Count = count - p95Count;
  const p99Pool = clonePoolWithModifiedProjections(players, (p) => {
    if (p.percentiles && p.percentiles.p99 > 0) return p.percentiles.p99;
    if (p.ceiling99 > 0) return p.ceiling99;
    // Fallback: use p95 + extra
    return p.ceiling > 0 ? p.ceiling * 1.15 : p.projection * 1.35;
  });
  const p99Result = optimizeLineups({ config, pool: p99Pool, poolSize: p99Count });
  restoreProjections(p99Result.lineups, origMap);
  tagLineups(p99Result.lineups, 'ceiling-p99');

  return [...p95Result.lineups, ...p99Result.lineups];
}

// ============================================================
// STRATEGY 4: CONTRARIAN POOL
// ============================================================

function generateContrarianPool(
  players: Player[],
  config: ContestConfig,
  count: number,
): Lineup[] {
  const pool = clonePoolWithModifiedProjections(players, (p) => {
    // ownership is typically 0-1 (fraction) — some formats use 0-100
    const own = p.ownership > 1 ? p.ownership / 100 : p.ownership;
    return p.projection * (1 - own * 0.5);
  });
  const result = optimizeLineups({ config, pool, poolSize: count });
  const origMap = buildOriginalMap(players);
  restoreProjections(result.lineups, origMap);
  tagLineups(result.lineups, 'contrarian');
  return result.lineups;
}

// ============================================================
// DEDUPLICATION
// ============================================================

/** Get the set of player IDs in a lineup. */
function lineupPlayerIds(lu: Lineup): Set<string> {
  return new Set(lu.players.map(p => p.id));
}

/**
 * Remove near-duplicates: lineups sharing rosterSize-1 or more players
 * with any existing lineup. For speed, check against a random sample of
 * existing lineups.
 */
function deduplicateNearMatches(
  lineups: Lineup[],
  rosterSize: number,
  sampleSize: number = 500,
): Lineup[] {
  // Build ID sets for a sample of existing lineups
  const sample: Set<string>[] = [];
  const indices = new Set<number>();
  const max = Math.min(sampleSize, lineups.length);
  while (indices.size < max) {
    indices.add(Math.floor(Math.random() * lineups.length));
  }
  for (const idx of indices) {
    sample.push(lineupPlayerIds(lineups[idx]));
  }

  const threshold = rosterSize - 1;
  const kept: Lineup[] = [];
  const keptSets: Set<string>[] = [];

  for (const lu of lineups) {
    const ids = lineupPlayerIds(lu);
    let nearDup = false;

    // Check against sample
    for (const existing of sample) {
      let overlap = 0;
      for (const id of ids) {
        if (existing.has(id)) overlap++;
      }
      if (overlap >= threshold) {
        nearDup = true;
        break;
      }
    }

    // Also check against already-kept lineups (for internal near-dups)
    if (!nearDup) {
      for (const existing of keptSets) {
        let overlap = 0;
        for (const id of ids) {
          if (existing.has(id)) overlap++;
        }
        if (overlap >= threshold) {
          nearDup = true;
          break;
        }
      }
    }

    if (!nearDup) {
      kept.push(lu);
      keptSets.push(ids);
    }
  }

  return kept;
}

// ============================================================
// MAIN ENTRY POINT
// ============================================================

export function augmentPool(
  ssPool: Lineup[],
  players: Player[],
  config: ContestConfig,
  sport: string,
): { augmented: Lineup[]; sources: Map<string, string> } {
  console.log('\n>>> Pool augmentation');
  const t0 = Date.now();

  // Track existing hashes
  const existingHashes = new Set<string>();
  for (const lu of ssPool) existingHashes.add(lu.hash);

  // --- Strategy 1: Variance-seeking ---
  const var03 = generateVariancePool(players, config, 0.3, 500);
  console.log(`  Variance pool (λ=0.3):  ${var03.length} lineups`);

  const var08 = generateVariancePool(players, config, 0.8, 500);
  console.log(`  Variance pool (λ=0.8):  ${var08.length} lineups`);

  const var15 = generateVariancePool(players, config, 1.5, 500);
  console.log(`  Variance pool (λ=1.5):  ${var15.length} lineups`);

  // --- Strategy 2: Team-forced stacks ---
  const teamForced = generateTeamForcedPool(players, config, 150);
  const uniqueTeams = new Set(players.map(p => p.team));
  console.log(`  Team-forced (${uniqueTeams.size} teams): ${teamForced.length} lineups`);

  // --- Strategy 3: Ceiling pool ---
  const ceiling = generateCeilingPool(players, config, 800);
  const p95Count = ceiling.filter(l => l.constructionMethod === 'ceiling-p95').length;
  const p99Count = ceiling.filter(l => l.constructionMethod === 'ceiling-p99').length;
  console.log(`  Ceiling pool (p95/p99): ${ceiling.length} lineups (${p95Count}/${p99Count})`);

  // --- Strategy 4: Contrarian ---
  const contrarian = generateContrarianPool(players, config, 500);
  console.log(`  Contrarian pool:        ${contrarian.length} lineups`);

  // --- Merge all augmented ---
  const allAugmented = [...var03, ...var08, ...var15, ...teamForced, ...ceiling, ...contrarian];
  const totalRaw = allAugmented.length;

  // --- Deduplicate by hash (vs SS pool and vs each other) ---
  const dedupedByHash: Lineup[] = [];
  const seenHashes = new Set(existingHashes);
  for (const lu of allAugmented) {
    if (!seenHashes.has(lu.hash)) {
      dedupedByHash.push(lu);
      seenHashes.add(lu.hash);
    }
  }

  // --- Remove near-duplicates ---
  // Build the sample from SS pool for near-dup checking
  const ssSample: Set<string>[] = [];
  const ssMax = Math.min(500, ssPool.length);
  const ssIndices = new Set<number>();
  while (ssIndices.size < ssMax && ssIndices.size < ssPool.length) {
    ssIndices.add(Math.floor(Math.random() * ssPool.length));
  }
  for (const idx of ssIndices) {
    ssSample.push(lineupPlayerIds(ssPool[idx]));
  }

  const threshold = config.rosterSize - 1;
  const finalAugmented: Lineup[] = [];

  for (const lu of dedupedByHash) {
    const ids = lineupPlayerIds(lu);
    let nearDup = false;

    // Check against SS pool sample
    for (const existing of ssSample) {
      let overlap = 0;
      for (const id of ids) {
        if (existing.has(id)) overlap++;
      }
      if (overlap >= threshold) {
        nearDup = true;
        break;
      }
    }

    if (!nearDup) {
      finalAugmented.push(lu);
    }
  }

  // --- Build source map ---
  const sources = new Map<string, string>();
  for (const lu of ssPool) sources.set(lu.hash, 'ss-pool');
  for (const lu of finalAugmented) sources.set(lu.hash, lu.constructionMethod ?? 'augmented');

  // --- Merge ---
  const merged = [...ssPool, ...finalAugmented];
  const elapsed = Date.now() - t0;

  console.log(`  ---`);
  console.log(`  TOTAL augmented:        ${finalAugmented.length} new lineups (${totalRaw} raw, deduped from ${totalRaw - finalAugmented.length})`);
  console.log(`  Merged pool:            ${merged.length} unique (${ssPool.length} SS + ${finalAugmented.length} augmented)`);
  console.log(`  Augmentation time:      ${(elapsed / 1000).toFixed(1)}s`);

  return { augmented: merged, sources };
}
