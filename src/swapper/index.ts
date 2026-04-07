/**
 * Late Swap Optimizer — Full Pipeline
 *
 * Rebuilds late swap to use the full pregame scoring + simulation + portfolio
 * optimization pipeline. Late swap is *smarter* than pregame because we have
 * live contest ownership and coordinate swaps across our entire portfolio.
 *
 * Architecture:
 *   Parse entries → Group by locked skeleton → Generate candidates per skeleton
 *   → Score ALL candidates (full pregame pipeline) → Portfolio-optimal assignment
 *   → Export swapped DK lineups
 */

import {
  DKEntry,
  Player,
  PlayerPool,
  ContestConfig,
  LockStatus,
  SwapResult,
  SwapDetail,
  LateSwapResult,
  LockedSkeleton,
  ScoredLineup,
  Lineup,
} from '../types';

import { generateSwapCandidates } from './candidate-generator';
import { scoreLineupsForSwap, SwapScoringResult } from '../selection/selector';
import { PayoutTier } from '../selection/simulation/tournament-sim';

export { parseDraftKingsEntries } from './dk-parser';

// ============================================================
// MAIN LATE SWAP OPTIMIZATION
// ============================================================

/**
 * Main late swap optimization function — full pipeline.
 */
export function optimizeLateSwaps(
  entries: DKEntry[],
  pool: PlayerPool,
  config: ContestConfig,
  lockStatus: Map<string, LockStatus>,
  numGames: number = 5,
  minSalary?: number
): LateSwapResult {
  console.log('\n========================================');
  console.log('LATE SWAP OPTIMIZER (Full Pipeline)');
  console.log('========================================');
  console.log(`Entries to optimize: ${entries.length}`);
  console.log(`Player pool: ${pool.players.length} players`);
  console.log(`Games on slate: ${numGames}`);

  // Count locked vs swappable in pool
  let poolLocked = 0;
  let poolSwappable = 0;
  for (const player of pool.players) {
    const status = lockStatus.get(player.id);
    if (status === 'locked') poolLocked++;
    else poolSwappable++;
  }
  console.log(`Pool status: ${poolLocked} locked, ${poolSwappable} swappable`);

  // ============================================================
  // PHASE 0: Parse & Group by Skeleton
  // ============================================================
  console.log('\n--- PHASE 0: SKELETON GROUPING ---');

  const { skeletons, entryData, fullyLockedEntries } = buildSkeletons(
    entries, pool, config, lockStatus
  );

  console.log(`${skeletons.size} unique skeletons across ${entries.length} entries (${fullyLockedEntries} fully locked)`);

  for (const [hash, skeleton] of skeletons) {
    console.log(`  Skeleton ${hash.slice(0, 8)}...: ${skeleton.lockedSlots.length} locked, ${skeleton.swappableSlots.length} swappable, ${skeleton.entryIndices.length} entries, $${skeleton.remainingCap} cap`);
  }

  // ============================================================
  // PHASE 1: Generate Candidates
  // ============================================================
  console.log('\n--- PHASE 1: CANDIDATE GENERATION ---');

  const candidatesByHash = new Map<string, Lineup[]>();
  let totalCandidates = 0;

  for (const [hash, skeleton] of skeletons) {
    const targetPerSkeleton = Math.min(3000, Math.max(500, skeleton.entryIndices.length * 30));

    const candidates = generateSwapCandidates(
      skeleton,
      pool,
      config,
      lockStatus,
      targetPerSkeleton,
      minSalary
    );

    candidatesByHash.set(hash, candidates);
    totalCandidates += candidates.length;

    console.log(`  Skeleton ${hash.slice(0, 8)}...: ${candidates.length} candidates (target ${targetPerSkeleton})`);
  }

  console.log(`Generated ${totalCandidates} total candidates across ${skeletons.size} skeletons`);

  // Improvement #7: Include each entry's original lineup as a candidate
  let originals_added = 0;
  for (const eData of entryData) {
    if (eData.swappableSlots.length === 0 || eData.skeletonHash === '') continue;
    const candidates = candidatesByHash.get(eData.skeletonHash);
    if (!candidates) continue;

    // Build original lineup object
    const origPlayers = eData.originalPlayers;
    const origHash = origPlayers.map(p => p.id).sort().join('|');

    // Only add if not already in candidates
    if (!candidates.some(c => c.hash === origHash)) {
      const origLineup: Lineup = {
        players: origPlayers,
        salary: eData.originalSalary,
        projection: eData.originalProjection,
        ownership: origPlayers.reduce((sum, p) => sum + (p.ownership || 0), 0) / origPlayers.length,
        hash: origHash,
        constructionMethod: 'original-entry',
      };
      candidates.push(origLineup);
      originals_added++;
    }
  }
  if (originals_added > 0) {
    console.log(`  Added ${originals_added} original entry lineups as candidates`);
  }

  // ============================================================
  // PHASE 2: Score Candidates (Full Pipeline)
  // ============================================================
  console.log('\n--- PHASE 2: SCORING CANDIDATES ---');

  // Merge all candidates into one pool for scoring
  const allCandidates: Lineup[] = [];
  for (const candidates of candidatesByHash.values()) {
    allCandidates.push(...candidates);
  }

  // Collect all unique players
  const allPlayers: Player[] = [];
  const seenPlayers = new Set<string>();
  for (const player of pool.players) {
    if (!seenPlayers.has(player.id)) {
      seenPlayers.add(player.id);
      allPlayers.push(player);
    }
  }

  let scoringResult: SwapScoringResult;
  let simulationRun = false;

  if (allCandidates.length > 0) {
    scoringResult = scoreLineupsForSwap(
      allCandidates,
      allPlayers,
      numGames,
      config.salaryCap,
      config.rosterSize,
      config.sport
    );
    simulationRun = scoringResult.simFinishVectors.size > 0;
  } else {
    // No candidates - skip scoring
    scoringResult = {
      scoredLineups: [],
      syntheticField: [],
      deepComboAnalysis: { pairs: new Map(), triples: new Map(), quads: new Map(), quints: new Map(), sexts: new Map(), septs: new Map(), cores3: [], cores4: [], cores5: [], fieldHeavyCores3: [], universallyCommonCores3: [], universallyCommonCores4: [], universallyCommonCores5: [], universallyCommonCores6: [], universallyCommonCores7: [], coreInteractions: new Map(), differentiatedCores: [] },
      simFinishVectors: new Map(),
      simPayoutStructure: [],
      fieldOwnership: new Map(),
      baseline: { optimalProjection: 0, optimalOwnership: 0, avgProjection: 0, avgOwnership: 0, slateEfficiency: 0.5 },
    };
  }

  // Index scored candidates by skeleton hash
  const scoredByHash = new Map<string, ScoredLineup[]>();
  // Build a quick lookup: lineup hash → skeleton hash
  const lineupToSkeletonHash = new Map<string, string>();
  for (const [skHash, candidates] of candidatesByHash) {
    for (const c of candidates) {
      lineupToSkeletonHash.set(c.hash, skHash);
    }
  }

  for (const scored of scoringResult.scoredLineups) {
    const skHash = lineupToSkeletonHash.get(scored.hash);
    if (skHash) {
      if (!scoredByHash.has(skHash)) scoredByHash.set(skHash, []);
      scoredByHash.get(skHash)!.push(scored);
    }
  }

  // Sort each skeleton's candidates by totalScore desc
  for (const [, candidates] of scoredByHash) {
    candidates.sort((a, b) => b.totalScore - a.totalScore);
  }

  console.log(`Scored ${scoringResult.scoredLineups.length} candidates`);
  console.log(`Simulation run: ${simulationRun} (${scoringResult.simFinishVectors.size} finish vectors)`);

  // ============================================================
  // PHASE 3: Portfolio-Optimal Entry Assignment
  // ============================================================
  console.log('\n--- PHASE 3: PORTFOLIO ASSIGNMENT ---');

  const assignments = assignPortfolioOptimal(
    entryData,
    scoredByHash,
    scoringResult.simFinishVectors,
    scoringResult.simPayoutStructure,
    numGames
  );

  // ============================================================
  // PHASE 4: Build Results
  // ============================================================
  console.log('\n--- PHASE 4: BUILD RESULTS ---');

  const results: SwapResult[] = [];
  let entriesImproved = 0;
  let totalProjectionGain = 0;
  const swapFrequency = new Map<string, number>();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const eData = entryData[i];

    if (!eData) {
      // Shouldn't happen, but safety
      results.push(makeNoSwapResult(entry, [], 0, 0));
      continue;
    }

    const assigned = assignments.get(i);
    if (!assigned) {
      // No assignment (fully locked or no candidates)
      results.push(makeNoSwapResult(entry, eData.originalPlayers, eData.originalProjection, eData.originalSalary));
      continue;
    }

    // Diff assigned candidate vs original lineup
    const swaps: SwapDetail[] = [];
    const swappedPlayers = [...eData.originalPlayers];

    for (const slotIdx of eData.swappableSlots) {
      const oldPlayer = eData.originalPlayers[slotIdx];
      const newPlayer = assigned.players[slotIdx];

      if (newPlayer && newPlayer.id !== oldPlayer.id) {
        swappedPlayers[slotIdx] = newPlayer;
        swaps.push({
          slotIndex: slotIdx,
          slotName: config.positions[slotIdx].name,
          fromPlayer: oldPlayer,
          toPlayer: newPlayer,
          projectionDelta: newPlayer.projection - oldPlayer.projection,
          salaryDelta: newPlayer.salary - oldPlayer.salary,
        });

        // Track swap frequency
        swapFrequency.set(newPlayer.id, (swapFrequency.get(newPlayer.id) || 0) + 1);
      } else if (newPlayer) {
        swappedPlayers[slotIdx] = newPlayer;
      }
    }

    const swappedProjection = swappedPlayers.reduce((sum, p) => sum + p.projection, 0);
    const swappedSalary = swappedPlayers.reduce((sum, p) => sum + p.salary, 0);
    const projectionGain = swappedProjection - eData.originalProjection;

    if (projectionGain > 0) {
      entriesImproved++;
      totalProjectionGain += projectionGain;
    }

    results.push({
      entryId: entry.entryId,
      contestName: entry.contestName,
      originalPlayers: eData.originalPlayers,
      originalProjection: eData.originalProjection,
      originalSalary: eData.originalSalary,
      swappedPlayers,
      swappedProjection,
      swappedSalary,
      swaps,
      projectionGain,
      leverageScore: assigned.leverageScore || 0,
    });
  }

  // ============================================================
  // PHASE 5: Summary & Return
  // ============================================================
  const swapExposures = new Map<string, number>();
  for (const [playerId, count] of swapFrequency) {
    swapExposures.set(playerId, (count / entries.length) * 100);
  }

  const avgProjectionGain = entriesImproved > 0 ? totalProjectionGain / entriesImproved : 0;

  console.log('\n========================================');
  console.log('LATE SWAP SUMMARY');
  console.log('========================================');
  console.log(`Entries improved: ${entriesImproved}/${entries.length} (${((entriesImproved / entries.length) * 100).toFixed(1)}%)`);
  console.log(`Avg projection gain: +${avgProjectionGain.toFixed(2)} pts`);
  console.log(`Total projection gain: +${totalProjectionGain.toFixed(2)} pts`);
  console.log(`Candidates generated: ${totalCandidates}`);
  console.log(`Field size: ${scoringResult.syntheticField.length}`);
  console.log(`Simulation run: ${simulationRun}`);

  // Top swap targets
  const sortedSwaps = Array.from(swapExposures.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  if (sortedSwaps.length > 0) {
    console.log('\n--- TOP SWAP TARGETS ---');
    for (const [playerId, exposure] of sortedSwaps) {
      const player = pool.byId.get(playerId);
      if (player) {
        console.log(`  ${player.name.padEnd(25)} ${exposure.toFixed(1).padStart(5)}% of lineups`);
      }
    }
  }

  // Portfolio exposure table
  const portfolioExposures = new Map<string, number>();
  for (const result of results) {
    for (const player of result.swappedPlayers) {
      portfolioExposures.set(player.id, (portfolioExposures.get(player.id) || 0) + 1);
    }
  }

  const sortedPortfolio = Array.from(portfolioExposures.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);

  console.log('\n--- PORTFOLIO EXPOSURES ---');
  for (const [playerId, count] of sortedPortfolio) {
    const player = pool.byId.get(playerId);
    const exposure = (count / entries.length) * 100;
    if (player) {
      console.log(`  ${player.name.padEnd(25)} ${exposure.toFixed(1).padStart(5)}%`);
    }
  }

  return {
    results,
    entriesImproved,
    avgProjectionGain,
    swapExposures,
    candidatesGenerated: totalCandidates,
    fieldSize: scoringResult.syntheticField.length,
    simulationRun,
  };
}

// ============================================================
// SKELETON BUILDING
// ============================================================

interface EntryData {
  entryIndex: number;
  contestName: string;
  skeletonHash: string;
  originalPlayers: Player[];
  originalProjection: number;
  originalSalary: number;
  lockedSlots: number[];
  swappableSlots: number[];
}

function buildSkeletons(
  entries: DKEntry[],
  pool: PlayerPool,
  config: ContestConfig,
  lockStatus: Map<string, LockStatus>
): {
  skeletons: Map<string, LockedSkeleton>;
  entryData: EntryData[];
  fullyLockedEntries: number;
} {
  const skeletons = new Map<string, LockedSkeleton>();
  const entryData: EntryData[] = [];
  let fullyLockedEntries = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const originalPlayers: Player[] = [];
    const lockedSlots: number[] = [];
    const swappableSlots: number[] = [];

    for (let j = 0; j < entry.playerIds.length; j++) {
      const playerId = entry.playerIds[j];
      const player = pool.byId.get(playerId) || findPlayerByFuzzyId(playerId, pool);

      if (!player) {
        // Create placeholder for unknown player — treat as locked
        originalPlayers.push({
          id: playerId,
          name: `Unknown (${playerId})`,
          position: config.positions[j]?.name || 'UTIL',
          positions: [config.positions[j]?.name || 'UTIL'],
          team: '',
          salary: 0,
          projection: 0,
          ownership: 0,
          ceiling: 0,
          ceiling99: 0,
          gameTotal: 0,
          index: -1,
          value: 0,
        });
        lockedSlots.push(j);
        continue;
      }

      originalPlayers.push(player);

      const status = lockStatus.get(player.id);
      if (status === 'locked') {
        lockedSlots.push(j);
      } else {
        swappableSlots.push(j);
      }
    }

    const originalProjection = originalPlayers.reduce((sum, p) => sum + p.projection, 0);
    const originalSalary = originalPlayers.reduce((sum, p) => sum + p.salary, 0);

    if (swappableSlots.length === 0) {
      fullyLockedEntries++;
      entryData.push({
        entryIndex: i,
        contestName: entry.contestName,
        skeletonHash: '',
        originalPlayers,
        originalProjection,
        originalSalary,
        lockedSlots,
        swappableSlots,
      });
      continue;
    }

    // Build skeleton hash from slot:playerId pairs (Bug #2 fix)
    // Include slot indices to prevent hash collisions when same players are in different slots.
    // Use 'unconstrained' as a sentinel for entries with zero locked slots so they
    // still group/process through phase 3 (the empty-string hash got filtered out).
    const lockedIds = lockedSlots.map(s => originalPlayers[s].id);
    const hash = lockedSlots.length === 0
      ? 'unconstrained'
      : lockedSlots.map(s => `${s}:${originalPlayers[s].id}`).sort().join('|');

    if (!skeletons.has(hash)) {
      const lockedPlayers = lockedSlots.map(s => originalPlayers[s]);
      const lockedSalary = lockedPlayers.reduce((sum, p) => sum + p.salary, 0);

      skeletons.set(hash, {
        hash,
        lockedPlayers,
        lockedSlots,
        swappableSlots,
        lockedSalary,
        remainingCap: config.salaryCap - lockedSalary,
        lockedPlayerIds: new Set(lockedIds),
        entryIndices: [i],
      });
    } else {
      skeletons.get(hash)!.entryIndices.push(i);
    }

    entryData.push({
      entryIndex: i,
      contestName: entry.contestName,
      skeletonHash: hash,
      originalPlayers,
      originalProjection,
      originalSalary,
      lockedSlots,
      swappableSlots,
    });
  }

  return { skeletons, entryData, fullyLockedEntries };
}

// ============================================================
// PORTFOLIO-OPTIMAL ASSIGNMENT
// ============================================================

/**
 * Interleave entries from different skeletons within each constraint level group.
 * Improvement #12: Round-robin across skeleton hashes so entries sharing the same
 * candidate pool don't get clumped together, which would exhaust diversity budget.
 */
function interleaveBySkeletonHash(entries: EntryData[]): EntryData[] {
  // Group by constraint level (swappable slot count)
  const byConstraintLevel = new Map<number, EntryData[]>();
  for (const e of entries) {
    const level = e.swappableSlots.length;
    if (!byConstraintLevel.has(level)) byConstraintLevel.set(level, []);
    byConstraintLevel.get(level)!.push(e);
  }

  const result: EntryData[] = [];

  // Process constraint levels in ascending order (most constrained first)
  const levels = Array.from(byConstraintLevel.keys()).sort((a, b) => a - b);

  for (const level of levels) {
    const levelEntries = byConstraintLevel.get(level)!;

    // Group by skeleton hash
    const byHash = new Map<string, EntryData[]>();
    for (const e of levelEntries) {
      if (!byHash.has(e.skeletonHash)) byHash.set(e.skeletonHash, []);
      byHash.get(e.skeletonHash)!.push(e);
    }

    // Round-robin across hashes
    const hashGroups = Array.from(byHash.values());
    const indices = new Array(hashGroups.length).fill(0);
    let remaining = levelEntries.length;

    while (remaining > 0) {
      for (let g = 0; g < hashGroups.length; g++) {
        if (indices[g] < hashGroups[g].length) {
          result.push(hashGroups[g][indices[g]]);
          indices[g]++;
          remaining--;
        }
      }
    }
  }

  return result;
}

/**
 * Assign the best candidate to each entry using portfolio greedy.
 * Mirrors selectByPortfolioContribution from selector.ts.
 */
function assignPortfolioOptimal(
  entryData: EntryData[],
  candidatesBySkeletonHash: Map<string, ScoredLineup[]>,
  simFinishVectors: Map<string, number[] | Float32Array>,
  simPayoutStructure: PayoutTier[],
  numGames: number
): Map<number, ScoredLineup> {
  const assignments = new Map<number, ScoredLineup>();

  // Sort entries by constraint level (fewer swappable slots → assign first)
  const assignOrder = entryData
    .filter(e => e.swappableSlots.length > 0 && e.skeletonHash !== '')
    .sort((a, b) => a.swappableSlots.length - b.swappableSlots.length);

  if (assignOrder.length === 0) return assignments;

  // Portfolio state
  const playerExposureCounts = new Map<string, number>();
  const selectedPairs = new Map<string, number>();
  const selectedTriples = new Map<string, number>();
  const selectedQuads = new Map<string, number>();
  const selectedQuints = new Map<string, number>();
  let portfolioSize = 0;

  // Per-contest exposure state — prevents overconcentration in any single contest
  const contestPlayerCounts = new Map<string, Map<string, number>>();
  const contestSizes = new Map<string, number>();
  const contestAssigned = new Map<string, number>();
  for (const eData of entryData) {
    contestSizes.set(eData.contestName, (contestSizes.get(eData.contestName) || 0) + 1);
  }
  for (const contestName of contestSizes.keys()) {
    contestPlayerCounts.set(contestName, new Map());
    contestAssigned.set(contestName, 0);
  }
  console.log(`Per-contest tracking: ${contestSizes.size} contests`);
  for (const [name, size] of contestSizes) {
    console.log(`  ${name}: ${size} entries`);
  }

  // Finish vector tracking for marginal contribution
  const numSims = simFinishVectors.size > 0
    ? simFinishVectors.values().next().value!.length
    : 0;
  const portfolioBestFinish = numSims > 0
    ? new Float32Array(numSims).fill(10000)
    : null;

  // Improvement #12: Interleave entries from different skeletons within each constraint level
  const interleaved = interleaveBySkeletonHash(assignOrder);

  // Helper: compute exposure penalty (Improvement #10 — matches pregame progressive caps)
  const computeExposurePenalty = (lineup: ScoredLineup): number => {
    if (portfolioSize < 20) return 1.0;
    const currentCap = portfolioSize < 100 ? 0.70 : portfolioSize < 500 ? 0.60 : 0.55;
    let penalty = 1.0;
    for (const player of lineup.players) {
      const count = playerExposureCounts.get(player.id) || 0;
      const exposure = count / portfolioSize;
      if (exposure >= currentCap) {
        const excess = exposure - currentCap;
        penalty *= Math.max(0.05, 1.0 - excess * 10);
      }
    }
    return penalty;
  };

  // Per-contest hard cap — number of times each player can appear in a single contest.
  // Caps:
  //   ≤6 entries: 50% (e.g., max 3 in a 6-entry contest)
  //   7-15 entries: 50%
  //   16+ entries: 45%
  // Returns true if the candidate would violate the cap if added to this contest.
  const wouldViolateContestCap = (lineup: ScoredLineup, contestName: string): boolean => {
    const contestSize = contestSizes.get(contestName) || 1;
    const counts = contestPlayerCounts.get(contestName)!;
    const cap = contestSize <= 15 ? 0.50 : 0.45;
    // Hard limit: ceil(cap * contestSize). Min 1 to allow tiny contests to function.
    const maxCount = Math.max(1, Math.ceil(cap * contestSize));
    for (const player of lineup.players) {
      const newCount = (counts.get(player.id) || 0) + 1;
      if (newCount > maxCount) return true;
    }
    return false;
  };

  // Variant of the cap check used during local search: ignores players already
  // in the current assignment for this entry (since they'd be removed by the swap).
  const wouldViolateContestCapAfterSwap = (
    lineup: ScoredLineup,
    currentPlayerIds: Set<string>,
    contestName: string,
  ): boolean => {
    const contestSize = contestSizes.get(contestName) || 1;
    const counts = contestPlayerCounts.get(contestName)!;
    const cap = contestSize <= 15 ? 0.50 : 0.45;
    const maxCount = Math.max(1, Math.ceil(cap * contestSize));
    for (const player of lineup.players) {
      if (currentPlayerIds.has(player.id)) continue;
      const newCount = (counts.get(player.id) || 0) + 1;
      if (newCount > maxCount) return true;
    }
    return false;
  };

  // Soft penalty for cross-player concentration (combos, near-cap players)
  const computeContestExposurePenalty = (lineup: ScoredLineup, contestName: string): number => {
    const contestSize = contestSizes.get(contestName) || 1;
    const assigned = contestAssigned.get(contestName) || 0;
    if (assigned === 0) return 1.0;
    const counts = contestPlayerCounts.get(contestName)!;
    const softCap = contestSize <= 15 ? 0.40 : 0.30;
    let penalty = 1.0;
    for (const player of lineup.players) {
      const count = counts.get(player.id) || 0;
      const exposure = count / assigned;
      if (exposure >= softCap) {
        const excess = exposure - softCap;
        penalty *= Math.max(0.10, 1.0 - excess * 8);
      }
    }
    return penalty;
  };

  // Helper: compute marginal payout for a candidate
  const computeMarginalPayout = (candidate: ScoredLineup): number => {
    if (!portfolioBestFinish || numSims === 0) return 0;
    const finishVector = simFinishVectors.get(candidate.hash);
    if (!finishVector) return 0;
    let marginalSum = 0;
    for (let i = 0; i < numSims; i++) {
      const candidatePos = finishVector[i];
      const currentBest = portfolioBestFinish[i];
      if (candidatePos < currentBest) {
        const candidatePayout = lookupPayout(candidatePos, simPayoutStructure);
        const currentPayout = lookupPayout(currentBest, simPayoutStructure);
        marginalSum += candidatePayout - currentPayout;
      }
    }
    return marginalSum / numSims;
  };

  for (const eData of interleaved) {
    const candidates = candidatesBySkeletonHash.get(eData.skeletonHash);
    if (!candidates || candidates.length === 0) continue;

    // Improvement #11: Dynamic candidate scan limit
    const scanLimit = Math.min(candidates.length, Math.max(200, 10 * portfolioSize));
    const topCandidates = candidates.slice(0, scanLimit);

    let bestCandidate: ScoredLineup | null = null;
    let bestScore = -Infinity;
    let bestFallback: ScoredLineup | null = null;
    let bestFallbackScore = -Infinity;

    for (const candidate of topCandidates) {
      // HARD CAP: skip any candidate that would put a player over the per-contest cap.
      // Track the best cap-violating candidate as a fallback in case nothing passes.
      if (wouldViolateContestCap(candidate, eData.contestName)) {
        const fbMarginal = computeMarginalPayout(candidate);
        const fbScore = numSims > 0 && fbMarginal > 0
          ? (fbMarginal + candidate.totalScore * 0.01)
          : candidate.totalScore;
        if (fbScore > bestFallbackScore) {
          bestFallbackScore = fbScore;
          bestFallback = candidate;
        }
        continue;
      }

      // Compute marginal payout from finish vectors
      const marginalPayout = computeMarginalPayout(candidate);

      // Compute diversity multiplier (Bug #6: full pregame penalties)
      const divMult = computeDiversityMultiplier(
        candidate,
        playerExposureCounts,
        selectedPairs,
        selectedTriples,
        portfolioSize,
        selectedQuads,
        selectedQuints
      );

      // Improvement #10: exposure penalty matching pregame pipeline
      const exposurePenalty = computeExposurePenalty(candidate);

      // Per-contest exposure penalty — primary lever for cross-contest diversity
      const contestPenalty = computeContestExposurePenalty(candidate, eData.contestName);

      // Improvement #10: Formula matches pregame — marginal payout dominant, totalScore as tiebreaker
      let combinedScore: number;
      if (numSims > 0 && marginalPayout > 0) {
        combinedScore = (marginalPayout + candidate.totalScore * 0.01) * divMult * exposurePenalty * contestPenalty;
      } else {
        combinedScore = candidate.totalScore * divMult * exposurePenalty * contestPenalty;
      }

      if (combinedScore > bestScore) {
        bestScore = combinedScore;
        bestCandidate = candidate;
      }
    }

    // Cap-respecting fallback: if no candidate in the top scan passed the cap,
    // scan ALL candidates (not just top 200) before giving up.
    if (!bestCandidate && candidates.length > topCandidates.length) {
      for (let ci = topCandidates.length; ci < candidates.length; ci++) {
        const candidate = candidates[ci];
        if (wouldViolateContestCap(candidate, eData.contestName)) continue;

        const marginalPayout = computeMarginalPayout(candidate);
        const divMult = computeDiversityMultiplier(
          candidate, playerExposureCounts, selectedPairs, selectedTriples,
          portfolioSize, selectedQuads, selectedQuints,
        );
        const exposurePenalty = computeExposurePenalty(candidate);
        const contestPenalty = computeContestExposurePenalty(candidate, eData.contestName);

        const combinedScore = numSims > 0 && marginalPayout > 0
          ? (marginalPayout + candidate.totalScore * 0.01) * divMult * exposurePenalty * contestPenalty
          : candidate.totalScore * divMult * exposurePenalty * contestPenalty;

        if (combinedScore > bestScore) {
          bestScore = combinedScore;
          bestCandidate = candidate;
        }
      }
    }

    // Final fallback: every single candidate violates the cap. Take the best violator.
    if (!bestCandidate && bestFallback) {
      bestCandidate = bestFallback;
    }

    if (bestCandidate) {
      assignments.set(eData.entryIndex, bestCandidate);
      updatePortfolioState(
        bestCandidate,
        playerExposureCounts,
        selectedPairs,
        selectedTriples,
        portfolioBestFinish,
        simFinishVectors,
        selectedQuads,
        selectedQuints
      );
      portfolioSize++;

      // Update per-contest state
      const contestCounts = contestPlayerCounts.get(eData.contestName)!;
      for (const player of bestCandidate.players) {
        contestCounts.set(player.id, (contestCounts.get(player.id) || 0) + 1);
      }
      contestAssigned.set(eData.contestName, (contestAssigned.get(eData.contestName) || 0) + 1);
    }
  }

  console.log(`Portfolio assignment: ${assignments.size} entries assigned`);

  // Per-contest exposure report
  console.log(`\n--- PER-CONTEST EXPOSURE (top 5 per contest) ---`);
  for (const [contestName, size] of contestSizes) {
    const counts = contestPlayerCounts.get(contestName)!;
    const assigned = contestAssigned.get(contestName) || 0;
    if (assigned === 0) continue;
    const top = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    console.log(`  ${contestName} (${assigned}/${size} entries):`);
    for (const [pid, count] of top) {
      const pct = (count / assigned * 100).toFixed(0);
      console.log(`    ${pid.padEnd(12)} ${count}/${assigned} = ${pct}%`);
    }
  }

  // Local search pass: try swapping each entry to a better candidate
  // Improvement #13: Use marginal payout in local search, not just totalScore
  let localSearchImprovements = 0;
  for (let pass = 0; pass < 3; pass++) {
    let improved = false;

    for (const eData of interleaved) {
      const currentAssigned = assignments.get(eData.entryIndex);
      if (!currentAssigned) continue;

      const candidates = candidatesBySkeletonHash.get(eData.skeletonHash);
      if (!candidates || candidates.length < 2) continue;

      // Try top 20 alternatives
      const alternatives = candidates.slice(0, 20).filter(c => c.hash !== currentAssigned.hash);

      const currentDivMult = computeDiversityMultiplier(
        currentAssigned,
        playerExposureCounts,
        selectedPairs,
        selectedTriples,
        portfolioSize,
        selectedQuads,
        selectedQuints
      );
      const currentExposurePenalty = computeExposurePenalty(currentAssigned);
      const currentContestPenalty = computeContestExposurePenalty(currentAssigned, eData.contestName);

      // Improvement #13: compute marginal payout for current
      const currentMarginal = computeMarginalPayout(currentAssigned);
      const currentScore = numSims > 0 && currentMarginal > 0
        ? (currentMarginal + currentAssigned.totalScore * 0.01) * currentDivMult * currentExposurePenalty * currentContestPenalty
        : currentAssigned.totalScore * currentDivMult * currentExposurePenalty * currentContestPenalty;

      const currentPlayerIds = new Set(currentAssigned.players.map(p => p.id));

      for (const alt of alternatives) {
        // Swap-aware cap check: a player only adds to count if they're NOT already
        // in the current assignment (since we'd be removing the current first).
        if (wouldViolateContestCapAfterSwap(alt, currentPlayerIds, eData.contestName)) continue;

        const altDivMult = computeDiversityMultiplier(
          alt,
          playerExposureCounts,
          selectedPairs,
          selectedTriples,
          portfolioSize,
          selectedQuads,
          selectedQuints
        );
        const altExposurePenalty = computeExposurePenalty(alt);
        const altContestPenalty = computeContestExposurePenalty(alt, eData.contestName);

        const altMarginal = computeMarginalPayout(alt);
        const altScore = numSims > 0 && altMarginal > 0
          ? (altMarginal + alt.totalScore * 0.01) * altDivMult * altExposurePenalty * altContestPenalty
          : alt.totalScore * altDivMult * altExposurePenalty * altContestPenalty;

        // Accept swap if alternative has better combined score (1% threshold)
        if (altScore > currentScore * 1.01) {
          // Remove old assignment from portfolio state
          removeFromPortfolioState(currentAssigned, playerExposureCounts, selectedPairs, selectedTriples, selectedQuads, selectedQuints);
          // Update per-contest state: subtract old, add new
          const contestCounts = contestPlayerCounts.get(eData.contestName)!;
          for (const player of currentAssigned.players) {
            const c = contestCounts.get(player.id) || 0;
            if (c <= 1) contestCounts.delete(player.id);
            else contestCounts.set(player.id, c - 1);
          }
          for (const player of alt.players) {
            contestCounts.set(player.id, (contestCounts.get(player.id) || 0) + 1);
          }
          // Add new assignment
          assignments.set(eData.entryIndex, alt);
          updatePortfolioState(
            alt,
            playerExposureCounts,
            selectedPairs,
            selectedTriples,
            portfolioBestFinish,
            simFinishVectors,
            selectedQuads,
            selectedQuints
          );
          improved = true;
          localSearchImprovements++;
          break;
        }
      }
    }

    if (!improved) break;
  }

  if (localSearchImprovements > 0) {
    console.log(`  Local search: ${localSearchImprovements} improvements`);
  }

  return assignments;
}

// ============================================================
// PORTFOLIO HELPERS
// ============================================================

/** Look up payout for a given finish position */
function lookupPayout(position: number, payoutStructure: PayoutTier[]): number {
  for (const tier of payoutStructure) {
    if (position <= tier.maxPosition) {
      return tier.payout;
    }
  }
  return 0;
}

/**
 * Compute diversity multiplier using full quartic+cubic+quadratic+linear penalties.
 * Ported from calculatePortfolioDiversity in selector.ts (Bug #6 fix).
 * Now includes quad/quint tracking, multi-term penalties, high-exposure count bonuses,
 * and normalized divisors matching the pregame pipeline.
 */
function computeDiversityMultiplier(
  lineup: ScoredLineup | Lineup,
  playerCounts: Map<string, number>,
  pairCounts: Map<string, number>,
  tripleCounts: Map<string, number>,
  portfolioSize: number,
  quadCounts?: Map<string, number>,
  quintCounts?: Map<string, number>
): number {
  if (portfolioSize === 0) return 1.0;

  const ids = lineup.players.map(p => p.id).sort();
  const rosterSize = ids.length;

  // === PLAYER-LEVEL DIVERSITY ===
  const EXPOSURE_PENALTY_START = 0.22;
  let playerOverlapScore = 0;
  let highExposureCount = 0;

  for (const id of ids) {
    const count = playerCounts.get(id) || 0;
    const exposure = count / portfolioSize;
    if (exposure > EXPOSURE_PENALTY_START) {
      const x = exposure - EXPOSURE_PENALTY_START;
      playerOverlapScore += Math.pow(x, 4) * 500;
      playerOverlapScore += Math.pow(x, 3) * 100;
      playerOverlapScore += Math.pow(x, 2) * 20;
      playerOverlapScore += x * 2;
      if (exposure > 0.30) highExposureCount++;
    }
  }

  // Heavy penalty for multiple high-exposure players
  if (highExposureCount >= 2) playerOverlapScore += 1.0;
  if (highExposureCount >= 3) playerOverlapScore += 3.0;
  if (highExposureCount >= 4) playerOverlapScore += 6.0;
  if (highExposureCount >= 5) playerOverlapScore += 12.0;

  const playerDiversity = Math.max(0, 1 - playerOverlapScore / rosterSize);

  // === PAIR-LEVEL DIVERSITY ===
  const PAIR_THRESHOLD = 0.15;
  let pairOverlapScore = 0;
  let pairCount = 0;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const key = `${ids[i]}|${ids[j]}`;
      const count = pairCounts.get(key) || 0;
      const freq = count / portfolioSize;
      if (freq > PAIR_THRESHOLD) {
        const x = freq - PAIR_THRESHOLD;
        pairOverlapScore += Math.pow(x, 4) * 800;
        pairOverlapScore += Math.pow(x, 3) * 150;
        pairOverlapScore += Math.pow(x, 2) * 30;
      }
      pairCount++;
    }
  }
  const pairDiversity = Math.max(0, 1 - pairOverlapScore / Math.max(1, pairCount / 8));

  // === TRIPLE-LEVEL DIVERSITY ===
  const TRIPLE_THRESHOLD = 0.08;
  let tripleOverlapScore = 0;
  let tripleCount = 0;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      for (let k = j + 1; k < ids.length; k++) {
        const key = `${ids[i]}|${ids[j]}|${ids[k]}`;
        const count = tripleCounts.get(key) || 0;
        const freq = count / portfolioSize;
        if (freq > TRIPLE_THRESHOLD) {
          const x = freq - TRIPLE_THRESHOLD;
          tripleOverlapScore += Math.pow(x, 4) * 1200;
          tripleOverlapScore += Math.pow(x, 3) * 250;
          tripleOverlapScore += Math.pow(x, 2) * 40;
        }
        tripleCount++;
      }
    }
  }
  const tripleDiversity = Math.max(0, 1 - tripleOverlapScore / Math.max(1, tripleCount / 15));

  // === QUAD-LEVEL DIVERSITY ===
  const QUAD_THRESHOLD = 0.05;
  let quadOverlapScore = 0;
  let quadCount = 0;
  if (quadCounts) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        for (let k = j + 1; k < ids.length; k++) {
          for (let l = k + 1; l < ids.length; l++) {
            const key = `${ids[i]}|${ids[j]}|${ids[k]}|${ids[l]}`;
            const count = quadCounts.get(key) || 0;
            const freq = count / portfolioSize;
            if (freq > QUAD_THRESHOLD) {
              const x = freq - QUAD_THRESHOLD;
              quadOverlapScore += Math.pow(x, 4) * 2000;
              quadOverlapScore += Math.pow(x, 3) * 400;
              quadOverlapScore += Math.pow(x, 2) * 50;
            }
            quadCount++;
          }
        }
      }
    }
  }
  const quadDiversity = quadCounts ? Math.max(0, 1 - quadOverlapScore / Math.max(1, quadCount / 20)) : 1.0;

  // === QUINT-LEVEL DIVERSITY ===
  const QUINT_THRESHOLD = 0.04;
  let quintOverlapScore = 0;
  let quintCount = 0;
  if (quintCounts) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        for (let k = j + 1; k < ids.length; k++) {
          for (let l = k + 1; l < ids.length; l++) {
            for (let m = l + 1; m < ids.length; m++) {
              const key = `${ids[i]}|${ids[j]}|${ids[k]}|${ids[l]}|${ids[m]}`;
              const count = quintCounts.get(key) || 0;
              const freq = count / portfolioSize;
              if (freq > QUINT_THRESHOLD) {
                const x = freq - QUINT_THRESHOLD;
                quintOverlapScore += Math.pow(x, 4) * 3000;
                quintOverlapScore += Math.pow(x, 3) * 600;
                quintOverlapScore += Math.pow(x, 2) * 60;
              }
              quintCount++;
            }
          }
        }
      }
    }
  }
  const quintDiversity = quintCounts ? Math.max(0, 1 - quintOverlapScore / Math.max(1, quintCount / 25)) : 1.0;

  // Combined diversity score — redistribute weights if quad/quint not tracked
  if (!quadCounts && !quintCounts) {
    // No quad/quint tracking: Player 35%, Pair 30%, Triple 35%
    return playerDiversity * 0.35 + pairDiversity * 0.30 + tripleDiversity * 0.35;
  } else if (!quintCounts) {
    // No quint tracking: Player 30%, Pair 25%, Triple 25%, Quad 20%
    return playerDiversity * 0.30 + pairDiversity * 0.25 + tripleDiversity * 0.25 + quadDiversity * 0.20;
  }
  // Full tracking: Player 25%, Pair 22%, Triple 22%, Quad 18%, Quint 13%
  return playerDiversity * 0.25 + pairDiversity * 0.22 + tripleDiversity * 0.22 + quadDiversity * 0.18 + quintDiversity * 0.13;
}

/** Update portfolio state after adding a lineup */
function updatePortfolioState(
  lineup: ScoredLineup | Lineup,
  playerCounts: Map<string, number>,
  pairCounts: Map<string, number>,
  tripleCounts: Map<string, number>,
  portfolioBestFinish: Float32Array | null,
  simFinishVectors: Map<string, number[] | Float32Array>,
  quadCounts?: Map<string, number>,
  quintCounts?: Map<string, number>
): void {
  const ids = lineup.players.map(p => p.id).sort();

  // Update player counts
  for (const id of ids) {
    playerCounts.set(id, (playerCounts.get(id) || 0) + 1);
  }

  // Update pair, triple, quad, and quint counts
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const pairKey = `${ids[i]}|${ids[j]}`;
      pairCounts.set(pairKey, (pairCounts.get(pairKey) || 0) + 1);
      for (let k = j + 1; k < ids.length; k++) {
        const tripleKey = `${ids[i]}|${ids[j]}|${ids[k]}`;
        tripleCounts.set(tripleKey, (tripleCounts.get(tripleKey) || 0) + 1);
        if (quadCounts) {
          for (let l = k + 1; l < ids.length; l++) {
            const quadKey = `${ids[i]}|${ids[j]}|${ids[k]}|${ids[l]}`;
            quadCounts.set(quadKey, (quadCounts.get(quadKey) || 0) + 1);
            if (quintCounts) {
              for (let m = l + 1; m < ids.length; m++) {
                const quintKey = `${ids[i]}|${ids[j]}|${ids[k]}|${ids[l]}|${ids[m]}`;
                quintCounts.set(quintKey, (quintCounts.get(quintKey) || 0) + 1);
              }
            }
          }
        }
      }
    }
  }

  // Update finish vector tracking
  if (portfolioBestFinish) {
    const finishVector = simFinishVectors.get((lineup as ScoredLineup).hash || '');
    if (finishVector) {
      for (let i = 0; i < finishVector.length; i++) {
        if (finishVector[i] < portfolioBestFinish[i]) {
          portfolioBestFinish[i] = finishVector[i];
        }
      }
    }
  }
}

/** Remove a lineup from portfolio state (for local search swaps) */
function removeFromPortfolioState(
  lineup: ScoredLineup | Lineup,
  playerCounts: Map<string, number>,
  pairCounts: Map<string, number>,
  tripleCounts: Map<string, number>,
  quadCounts?: Map<string, number>,
  quintCounts?: Map<string, number>
): void {
  const ids = lineup.players.map(p => p.id).sort();

  for (const id of ids) {
    const count = playerCounts.get(id) || 0;
    if (count > 1) playerCounts.set(id, count - 1);
    else playerCounts.delete(id);
  }

  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const pairKey = `${ids[i]}|${ids[j]}`;
      const pCount = pairCounts.get(pairKey) || 0;
      if (pCount > 1) pairCounts.set(pairKey, pCount - 1);
      else pairCounts.delete(pairKey);
      for (let k = j + 1; k < ids.length; k++) {
        const tripleKey = `${ids[i]}|${ids[j]}|${ids[k]}`;
        const tCount = tripleCounts.get(tripleKey) || 0;
        if (tCount > 1) tripleCounts.set(tripleKey, tCount - 1);
        else tripleCounts.delete(tripleKey);
        if (quadCounts) {
          for (let l = k + 1; l < ids.length; l++) {
            const quadKey = `${ids[i]}|${ids[j]}|${ids[k]}|${ids[l]}`;
            const qCount = quadCounts.get(quadKey) || 0;
            if (qCount > 1) quadCounts.set(quadKey, qCount - 1);
            else quadCounts.delete(quadKey);
            if (quintCounts) {
              for (let m = l + 1; m < ids.length; m++) {
                const quintKey = `${ids[i]}|${ids[j]}|${ids[k]}|${ids[l]}|${ids[m]}`;
                const quCount = quintCounts.get(quintKey) || 0;
                if (quCount > 1) quintCounts.set(quintKey, quCount - 1);
                else quintCounts.delete(quintKey);
              }
            }
          }
        }
      }
    }
  }
}

// ============================================================
// UTILITY
// ============================================================

function makeNoSwapResult(
  entry: DKEntry,
  originalPlayers: Player[],
  originalProjection: number,
  originalSalary: number
): SwapResult {
  return {
    entryId: entry.entryId,
    contestName: entry.contestName,
    originalPlayers,
    originalProjection,
    originalSalary,
    swappedPlayers: [...originalPlayers],
    swappedProjection: originalProjection,
    swappedSalary: originalSalary,
    swaps: [],
    projectionGain: 0,
    leverageScore: 0,
  };
}

/**
 * Try to find player by fuzzy ID matching
 */
function findPlayerByFuzzyId(playerId: string, pool: PlayerPool): Player | null {
  // Try exact match first
  const exact = pool.byId.get(playerId);
  if (exact) return exact;

  // Try stripping leading zeros or adding them
  const stripped = playerId.replace(/^0+/, '');
  for (const [id, player] of pool.byId) {
    if (id.replace(/^0+/, '') === stripped) return player;
  }

  return null;
}
