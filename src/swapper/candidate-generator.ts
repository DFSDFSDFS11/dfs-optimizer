/**
 * Late Swap Candidate Generator
 *
 * Generates diverse candidate completions for each locked skeleton.
 * Uses the same strategy-diversified philosophy as branch-bound.ts:
 * - Projection: pure projection for remaining slots
 * - Field-mimic: ownership-weighted fills
 * - Leverage: penalize mid-owned, boost low-owned
 * - Balanced: moderate ownership penalty
 * - Contrarian: ceiling ratio blend + heavy ownership penalty (3 sub-strategies)
 */

import {
  Player,
  PlayerPool,
  ContestConfig,
  LockStatus,
  Lineup,
  LockedSkeleton,
} from '../types';
import { applyCeilingRatioBoost, applyCeilingBlend } from '../optimizer/branch-bound';

// ============================================================
// MAIN CANDIDATE GENERATION
// ============================================================

/**
 * Generate diverse swap candidates for a locked skeleton.
 * Returns full Lineup objects (locked players in their slots + fill for open slots).
 */
export function generateSwapCandidates(
  skeleton: LockedSkeleton,
  pool: PlayerPool,
  config: ContestConfig,
  lockStatus: Map<string, LockStatus>,
  targetCandidates: number,
  minSalary?: number
): Lineup[] {
  // Filter available players: swappable status, has projection, not in locked set
  const availablePlayers = pool.players.filter(p =>
    lockStatus.get(p.id) !== 'locked' &&
    p.projection > 0 &&
    !skeleton.lockedPlayerIds.has(p.id)
  );

  if (availablePlayers.length === 0 || skeleton.swappableSlots.length === 0) {
    return [];
  }

  // Target iterations scaled by how many entries share this skeleton
  const numIterations = Math.max(20, Math.min(60, skeleton.entryIndices.length * 3));
  const lineupsPerIteration = Math.ceil(targetCandidates / numIterations);

  // Strategy distribution (mirrors branch-bound philosophy)
  const strategies = buildStrategyList(numIterations);

  // Build original player lookup for remapping after strategy adjustments
  const originalPlayerMap = new Map<string, Player>();
  for (const p of availablePlayers) {
    originalPlayerMap.set(p.id, p);
  }
  for (const p of skeleton.lockedPlayers) {
    originalPlayerMap.set(p.id, p);
  }

  // Salary floor: lineups must use at least this much salary
  const salaryFloor = minSalary || config.salaryMin || (config.salaryCap * 0.95);

  const allCandidates: Lineup[] = [];
  const seenHashes = new Set<string>();

  for (let iter = 0; iter < strategies.length; iter++) {
    const strategy = strategies[iter];

    // Apply strategy-specific projection adjustments
    const adjustedPlayers = applyStrategyAdjustments(availablePlayers, strategy);

    // Build position-eligible candidate lists for each swappable slot
    const slotCandidates = buildSlotCandidates(
      skeleton.swappableSlots,
      config,
      adjustedPlayers,
      25 // top 25 per slot
    );

    // Skip iteration if any slot had no eligible candidates
    if (slotCandidates.length === 0) continue;

    // Generate candidates for this iteration
    const iterCandidates = generateForIteration(
      skeleton,
      config,
      slotCandidates,
      skeleton.remainingCap,
      lineupsPerIteration,
      strategy,
      originalPlayerMap,
      salaryFloor
    );

    // Deduplicate and add
    for (const candidate of iterCandidates) {
      if (!seenHashes.has(candidate.hash)) {
        seenHashes.add(candidate.hash);
        allCandidates.push(candidate);
      }
    }
  }

  // Near-duplicate filter: remove lineups sharing rosterSize-1 players
  const filtered = nearDuplicateFilter(allCandidates, config.rosterSize);

  return filtered;
}

// ============================================================
// STRATEGY TYPES
// ============================================================

type SwapStrategy =
  | 'projection'
  | 'field-mimic'
  | 'leverage-penalty'
  | 'leverage-ceiling'
  | 'leverage-boost'
  | 'balanced'
  | 'game-stack'
  | 'contrarian-ceiling'
  | 'contrarian-value'
  | 'contrarian-deep';

/**
 * Build strategy list for N iterations matching branch-bound distribution:
 * 5% projection, 8% field-mimic, 32% leverage, 15% balanced, 5% game-stack, 35% contrarian
 */
function buildStrategyList(numIterations: number): SwapStrategy[] {
  const strategies: SwapStrategy[] = [];
  const proj = Math.max(1, Math.floor(numIterations * 0.05));
  const fieldMimic = Math.max(1, Math.floor(numIterations * 0.08));
  const leverage = Math.max(2, Math.floor(numIterations * 0.32));
  const balanced = Math.max(1, Math.floor(numIterations * 0.15));
  const gameStack = Math.max(1, Math.floor(numIterations * 0.05));
  const contrarian = numIterations - proj - fieldMimic - leverage - balanced - gameStack;

  for (let i = 0; i < proj; i++) strategies.push('projection');
  for (let i = 0; i < fieldMimic; i++) strategies.push('field-mimic');

  // Leverage sub-strategies: 40% penalty, 30% ceiling, 30% boost
  for (let i = 0; i < leverage; i++) {
    const sub = i % 10;
    if (sub < 4) strategies.push('leverage-penalty');
    else if (sub < 7) strategies.push('leverage-ceiling');
    else strategies.push('leverage-boost');
  }

  for (let i = 0; i < balanced; i++) strategies.push('balanced');
  for (let i = 0; i < gameStack; i++) strategies.push('game-stack');

  // Contrarian sub-strategies: 40% ceiling, 35% value, 25% deep
  for (let i = 0; i < contrarian; i++) {
    const sub = i % 20;
    if (sub < 8) strategies.push('contrarian-ceiling');
    else if (sub < 15) strategies.push('contrarian-value');
    else strategies.push('contrarian-deep');
  }

  // Shuffle to interleave strategies
  for (let i = strategies.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [strategies[i], strategies[j]] = [strategies[j], strategies[i]];
  }

  return strategies;
}

// ============================================================
// STRATEGY-SPECIFIC ADJUSTMENTS
// ============================================================

/**
 * Apply strategy-specific projection adjustments (same multipliers from branch-bound.ts)
 */
function applyStrategyAdjustments(
  players: Player[],
  strategy: SwapStrategy
): Player[] {
  switch (strategy) {
    case 'projection':
      // Pure projection — add slight variance
      return players.map(p => ({
        ...p,
        projection: p.projection * (0.95 + Math.random() * 0.10),
      }));

    case 'field-mimic':
      // Improvement #16: Use ownership^1.5 * projection^0.5 like branch-bound field-mimic
      return players.map(p => {
        const ownWeight = Math.pow(Math.max(1, p.ownership || 1), 1.5);
        const projWeight = Math.pow(p.projection, 0.5);
        const compositeScore = ownWeight * projWeight;
        // Normalize to projection-like scale
        return { ...p, projection: compositeScore * (0.90 + Math.random() * 0.20) };
      });

    case 'leverage-penalty': {
      // Penalize mid-owned (15-40%), boost low-owned (<15%)
      return players.map(p => {
        const own = (p.ownership || 20) / 100;
        let multiplier = 1.0;
        if (own > 0.25 && own <= 0.40) multiplier = 0.50;
        else if (own > 0.15 && own <= 0.25) multiplier = 0.60;
        else if (own <= 0.15 && own > 0.08) multiplier = 1.25;
        else if (own <= 0.08) multiplier = 1.40;
        return { ...p, projection: p.projection * multiplier * (0.90 + Math.random() * 0.20) };
      });
    }

    case 'leverage-ceiling': {
      // Improvement #15: Use applyCeilingRatioBoost + applyCeilingBlend like branch-bound
      const ceilingRatioBoosted = applyCeilingRatioBoost(players, 0.15, 0.5);
      const ceilingBlended = applyCeilingBlend(ceilingRatioBoosted, 0.35);
      return ceilingBlended.map(p => {
        const own = (p.ownership || 20) / 100;
        const ownMult = own > 0.15 && own <= 0.35 ? 0.85 : own <= 0.08 ? 1.20 : own <= 0.15 ? 1.12 : 1.0;
        return { ...p, projection: p.projection * ownMult * (0.90 + Math.random() * 0.20) };
      });
    }

    case 'leverage-boost': {
      // More extreme low-owned boosts than leverage-penalty (Bug #5 fix)
      return players.map(p => {
        const own = (p.ownership || 20) / 100;
        let multiplier = 1.0;
        if (own <= 0.08) multiplier = 1.60;       // was 1.40
        else if (own <= 0.15) multiplier = 1.40;   // was 1.25
        else if (own > 0.15 && own <= 0.25) multiplier = 0.45;  // was 0.60
        else if (own > 0.25 && own <= 0.40) multiplier = 0.35;  // was 0.50
        return { ...p, projection: p.projection * multiplier * (0.90 + Math.random() * 0.20) };
      });
    }

    case 'balanced': {
      // Moderate ownership penalty (multiplier 0.35)
      return players.map(p => {
        const own = (p.ownership || 20) / 100;
        const penalty = 1 - own * 0.35;
        return { ...p, projection: p.projection * Math.max(0.5, penalty) * (0.92 + Math.random() * 0.16) };
      });
    }

    case 'game-stack': {
      // Boost players in high game total environments (Improvement #8)
      // High game totals mean more points scored, benefiting all players in that game
      const gameTotals = new Map<string, number>();
      for (const p of players) {
        if (p.gameTotal && p.gameInfo) {
          gameTotals.set(p.gameInfo, Math.max(gameTotals.get(p.gameInfo) || 0, p.gameTotal));
        }
      }
      return players.map(p => {
        const gt = gameTotals.get(p.gameInfo || '') || 220;
        const boost = gt > 230 ? 1.15 : gt > 225 ? 1.08 : gt > 220 ? 1.03 : 1.0;
        return { ...p, projection: p.projection * boost * (0.92 + Math.random() * 0.16) };
      });
    }

    case 'contrarian-ceiling': {
      // Improvement #15: Use applyCeilingRatioBoost + applyCeilingBlend like branch-bound
      const ceilingRatioBoosted = applyCeilingRatioBoost(players, 0.20, 0.4);
      const ceilingBlended = applyCeilingBlend(ceilingRatioBoosted, 0.5);
      // Apply variance AFTER ceiling blend but BEFORE ownership penalty (matches branch-bound)
      const withVariance = ceilingBlended.map(p => ({
        ...p, projection: p.projection * (0.90 + Math.random() * 0.20),
      }));
      return withVariance.map(p => {
        const own = (p.ownership || 20) / 100;
        const penalty = 1 - own * 1.5;
        return { ...p, projection: p.projection * Math.max(0.2, penalty) };
      });
    }

    case 'contrarian-value': {
      // Value-based boost + ownership penalty
      const avgPtsPerK = players.reduce((sum, p) => sum + (p.projection / Math.max(1, p.salary)) * 1000, 0) / players.length;
      return players.map(p => {
        const ptsPerK = (p.projection / Math.max(1, p.salary)) * 1000;
        const valueBoost = ptsPerK > avgPtsPerK * 1.2 ? 1.15 : ptsPerK > avgPtsPerK ? 1.05 : 1.0;
        const own = (p.ownership || 20) / 100;
        const penalty = 1 - own * 1.5;
        return { ...p, projection: p.projection * valueBoost * Math.max(0.2, penalty) * (0.90 + Math.random() * 0.20) };
      });
    }

    case 'contrarian-deep': {
      // Very heavy ownership penalty (2.0)
      return players.map(p => {
        const own = (p.ownership || 20) / 100;
        const penalty = 1 - own * 2.0;
        return { ...p, projection: p.projection * Math.max(0.1, penalty) * (0.90 + Math.random() * 0.20) };
      });
    }

    default:
      return players;
  }
}

// ============================================================
// SLOT FILLING
// ============================================================

/**
 * Build position-eligible candidate lists for each swappable slot
 */
function buildSlotCandidates(
  swappableSlots: number[],
  config: ContestConfig,
  players: Player[],
  topN: number
): Player[][] {
  const result: Player[][] = [];

  for (const slotIdx of swappableSlots) {
    const slot = config.positions[slotIdx];
    const eligible = players.filter(p =>
      p.positions.some(pos => slot.eligible.includes(pos))
    );

    // Sort by adjusted projection descending
    eligible.sort((a, b) => b.projection - a.projection);

    result.push(eligible.slice(0, topN));
  }

  // Warn and bail if any slot has no eligible candidates
  for (let i = 0; i < result.length; i++) {
    if (result[i].length === 0) {
      console.warn(`  Warning: slot ${swappableSlots[i]} has 0 eligible candidates — skipping skeleton`);
      return [];
    }
  }

  return result;
}

/**
 * Generate candidate lineups for one iteration.
 * Uses exhaustive search for ≤5 open slots, greedy+local-search for >5.
 */
function generateForIteration(
  skeleton: LockedSkeleton,
  config: ContestConfig,
  slotCandidates: Player[][],
  remainingCap: number,
  targetCount: number,
  strategy: SwapStrategy,
  originalPlayerMap: Map<string, Player>,
  salaryFloor: number
): Lineup[] {
  if (skeleton.swappableSlots.length <= 5) {
    return exhaustiveSearch(skeleton, config, slotCandidates, remainingCap, targetCount, originalPlayerMap, salaryFloor);
  } else {
    return greedyWithLocalSearch(skeleton, config, slotCandidates, remainingCap, targetCount, originalPlayerMap, salaryFloor);
  }
}

/**
 * Exhaustive search for ≤5 open slots.
 * Generates all valid combinations and keeps top N by adjusted projection.
 */
function exhaustiveSearch(
  skeleton: LockedSkeleton,
  config: ContestConfig,
  slotCandidates: Player[][],
  remainingCap: number,
  targetCount: number,
  originalPlayerMap: Map<string, Player>,
  salaryFloor: number
): Lineup[] {
  const results: { fill: Player[]; score: number }[] = [];

  // Track minScore for proper pruning (Bug #4 fix)
  let minScoreInTopN = -Infinity;

  // Pre-compute locked team counts and game set for constraint checking (Bug #3 fix)
  const lockedTeamCounts = new Map<string, number>();
  const lockedGames = new Set<string>();
  for (const p of skeleton.lockedPlayers) {
    lockedTeamCounts.set(p.team, (lockedTeamCounts.get(p.team) || 0) + 1);
    if (p.gameInfo) lockedGames.add(p.gameInfo);
  }
  const maxPerTeam = config.maxPlayersPerTeam || 4;
  const minGames = config.minGames || 2;

  const searchFixed = (
    slotIndex: number,
    currentFill: Player[],
    usedIds: Set<string>,
    currentSalary: number,
    teamCounts: Map<string, number>
  ) => {
    if (slotIndex >= slotCandidates.length) {
      if (currentSalary > remainingCap) return;

      // Enforce minGames constraint (Bug #3)
      const games = new Set(lockedGames);
      for (const p of currentFill) {
        if (p.gameInfo) games.add(p.gameInfo);
      }
      if (games.size < minGames) return;

      const score = currentFill.reduce((sum, p) => sum + p.projection, 0);
      results.push({ fill: [...currentFill], score });

      // Maintain minScoreInTopN for pruning (Bug #4 fix)
      if (results.length >= targetCount * 2) {
        results.sort((a, b) => b.score - a.score);
        results.length = targetCount * 2;
        minScoreInTopN = results[results.length - 1].score;
      }
      return;
    }

    const candidates = slotCandidates[slotIndex];

    // Pruning: estimate max remaining projection
    let maxRemaining = 0;
    for (let i = slotIndex; i < slotCandidates.length; i++) {
      const top = slotCandidates[i][0];
      if (top) maxRemaining += top.projection;
    }

    const currentProj = currentFill.reduce((sum, p) => sum + p.projection, 0);
    if (minScoreInTopN > -Infinity) {
      if (currentProj + maxRemaining < minScoreInTopN * 0.9) return;
    }

    for (const player of candidates) {
      if (usedIds.has(player.id)) continue;
      if (currentSalary + player.salary > remainingCap) continue;

      // Bug #3: Enforce maxPlayersPerTeam
      const teamCount = teamCounts.get(player.team) || 0;
      if (teamCount >= maxPerTeam) continue;

      usedIds.add(player.id);
      currentFill.push(player);
      teamCounts.set(player.team, teamCount + 1);

      searchFixed(slotIndex + 1, currentFill, usedIds, currentSalary + player.salary, teamCounts);

      currentFill.pop();
      usedIds.delete(player.id);
      if (teamCount === 0) teamCounts.delete(player.team);
      else teamCounts.set(player.team, teamCount);
    }
  };

  searchFixed(0, [], new Set(), 0, new Map(lockedTeamCounts));

  // Sort by score desc, take top N
  results.sort((a, b) => b.score - a.score);
  const top = results.slice(0, targetCount);

  // Assemble full lineups using ORIGINAL player objects (Bug #1 fix)
  return top
    .map(r => assembleLineup(skeleton, config, r.fill, originalPlayerMap))
    .filter(l => l.salary >= salaryFloor); // Improvement #9: salary floor
}

/**
 * Greedy slot fill with local search for >5 open slots.
 */
function greedyWithLocalSearch(
  skeleton: LockedSkeleton,
  config: ContestConfig,
  slotCandidates: Player[][],
  remainingCap: number,
  targetCount: number,
  originalPlayerMap: Map<string, Player>,
  salaryFloor: number
): Lineup[] {
  const lineups: Lineup[] = [];

  // Pre-compute locked constraints for validation (Bug #3 fix)
  const maxPerTeam = config.maxPlayersPerTeam || 4;
  const minGames = config.minGames || 2;

  const lockedTeamCounts = new Map<string, number>();
  const lockedGames = new Set<string>();
  for (const p of skeleton.lockedPlayers) {
    lockedTeamCounts.set(p.team, (lockedTeamCounts.get(p.team) || 0) + 1);
    if (p.gameInfo) lockedGames.add(p.gameInfo);
  }

  for (let attempt = 0; attempt < targetCount * 3 && lineups.length < targetCount; attempt++) {
    const usedIds = new Set<string>();
    let salary = 0;
    const teamCounts = new Map(lockedTeamCounts);

    // Sort slots by scarcity (fewer candidates = fill first)
    const slotOrder = slotCandidates.map((_, i) => i)
      .sort((a, b) => slotCandidates[a].length - slotCandidates[b].length);

    const fillBySlot: (Player | null)[] = new Array(slotCandidates.length).fill(null);

    for (const orderIdx of slotOrder) {
      const candidates = slotCandidates[orderIdx];
      let bestPlayer: Player | null = null;
      let bestProj = -Infinity;

      for (const player of candidates) {
        if (usedIds.has(player.id)) continue;
        if (salary + player.salary > remainingCap) continue;
        // Bug #3: Enforce maxPlayersPerTeam
        if ((teamCounts.get(player.team) || 0) >= maxPerTeam) continue;

        // Add randomization for diversity
        const adjustedProj = player.projection * (0.85 + Math.random() * 0.30);
        if (adjustedProj > bestProj) {
          bestProj = adjustedProj;
          bestPlayer = player;
        }
      }

      if (bestPlayer) {
        fillBySlot[orderIdx] = bestPlayer;
        usedIds.add(bestPlayer.id);
        salary += bestPlayer.salary;
        teamCounts.set(bestPlayer.team, (teamCounts.get(bestPlayer.team) || 0) + 1);
      }
    }

    // Only keep if all slots filled
    if (fillBySlot.every(p => p !== null)) {
      const orderedFill = fillBySlot as Player[];

      // Local search: try swapping each slot with a better candidate
      for (let pass = 0; pass < 2; pass++) {
        for (let s = 0; s < orderedFill.length; s++) {
          const current = orderedFill[s];
          const candidates = slotCandidates[s];

          for (const candidate of candidates) {
            if (candidate.id === current.id) continue;
            if (usedIds.has(candidate.id)) continue;

            const salaryDelta = candidate.salary - current.salary;
            if (salary + salaryDelta > remainingCap) continue;

            // Bug #3: Check team constraint for swap
            const currentTeamCount = teamCounts.get(current.team) || 0;
            const candidateTeamCount = teamCounts.get(candidate.team) || 0;
            if (candidate.team !== current.team && candidateTeamCount >= maxPerTeam) continue;

            if (candidate.projection > current.projection) {
              usedIds.delete(current.id);
              usedIds.add(candidate.id);
              orderedFill[s] = candidate;
              salary += salaryDelta;
              // Update team counts
              teamCounts.set(current.team, currentTeamCount - 1);
              teamCounts.set(candidate.team, (candidate.team === current.team ? currentTeamCount - 1 : candidateTeamCount) + 1);
              break;
            }
          }
        }
      }

      // Bug #3: Validate minGames before accepting
      const games = new Set(lockedGames);
      for (const p of orderedFill) {
        if (p.gameInfo) games.add(p.gameInfo);
      }
      if (games.size < minGames) continue;

      const lineup = assembleLineup(skeleton, config, orderedFill, originalPlayerMap);
      // Improvement #9: salary floor
      if (lineup.salary >= salaryFloor) {
        lineups.push(lineup);
      }
    }
  }

  return lineups;
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Assemble a full lineup from skeleton + fill players.
 * Bug #1 fix: Remaps fill players to ORIGINAL player objects (not strategy-adjusted).
 * Strategy-adjusted projections should only be used for SELECTING which players fill
 * each slot, never stored in the final lineup.
 */
function assembleLineup(
  skeleton: LockedSkeleton,
  config: ContestConfig,
  fillPlayers: Player[],
  originalPlayerMap: Map<string, Player>
): Lineup {
  const players: Player[] = new Array(config.rosterSize);

  // Place locked players
  for (let i = 0; i < skeleton.lockedSlots.length; i++) {
    players[skeleton.lockedSlots[i]] = skeleton.lockedPlayers[i];
  }

  // Place fill players — remap to ORIGINAL player objects (Bug #1 fix)
  for (let i = 0; i < skeleton.swappableSlots.length; i++) {
    const adjusted = fillPlayers[i];
    const original = originalPlayerMap.get(adjusted.id) || adjusted;
    players[skeleton.swappableSlots[i]] = original;
  }

  const salary = players.reduce((sum, p) => sum + p.salary, 0);
  const projection = players.reduce((sum, p) => sum + p.projection, 0);
  const ownership = players.reduce((sum, p) => sum + (p.ownership || 0), 0) / players.length;

  // Build hash from sorted player IDs
  const hash = players.map(p => p.id).sort().join('|');

  return {
    players,
    salary,
    projection,
    ownership,
    hash,
    constructionMethod: 'late-swap',
  };
}

/**
 * Near-duplicate filter: remove lineups sharing rosterSize-1 or more players.
 * Keeps the first (higher-projection) lineup.
 */
function nearDuplicateFilter(lineups: Lineup[], rosterSize: number): Lineup[] {
  // Sort by projection descending so we keep the best of near-dupes
  const sorted = [...lineups].sort((a, b) => b.projection - a.projection);
  const kept: Lineup[] = [];
  const keptIdSets: Set<string>[] = [];

  for (const lineup of sorted) {
    const ids = new Set(lineup.players.map(p => p.id));

    let isNearDup = false;
    for (const existingIds of keptIdSets) {
      let overlap = 0;
      for (const id of ids) {
        if (existingIds.has(id)) overlap++;
      }
      if (overlap >= rosterSize - 1) {
        isNearDup = true;
        break;
      }
    }

    if (!isNearDup) {
      kept.push(lineup);
      keptIdSets.push(ids);
    }

    // Perf: limit comparisons for large pools
    if (keptIdSets.length > 5000) break;
  }

  return kept;
}
