/**
 * DFS Optimizer CLI - Field Analysis
 *
 * Analyzes the field to understand:
 * - Combo frequencies (what opponents are building)
 * - Chalk detection (overused combinations)
 * - Construction patterns
 *
 * Uses synthetic field lineups generated from ownership data
 * to model actual opponent behavior, NOT our own optimizer pool.
 */

import { Lineup, ScoredLineup, Player, PlayerEdgeInfo, PlayerEdgeScores } from '../../types';
import { generateFieldPool } from '../simulation/tournament-sim';

// ============================================================
// CONDITIONAL OWNERSHIP (Field-Derived Pair Frequency)
// ============================================================

/**
 * Compute empirical lineup frequency from field pair co-occurrences.
 * Uses geometric mean of all pair frequencies — captures salary/position/stack
 * correlations that independence-assumed product ownership misses.
 *
 * For an 8-player lineup: C(8,2) = 28 pairs. If all pairs appear at ~5%
 * frequency in field, geoMean ≈ 0.05. If some pairs are very rare (0.1%),
 * geoMean drops to ~0.01. This is a better measure of "how likely is the
 * field to build something structurally similar" than product ownership.
 */
export function calculateConditionalOwnership(
  lineup: Lineup | ScoredLineup,
  fieldPairFreqs: Map<string, number>
): number {
  const ids = lineup.players.map(p => p.id).sort();
  let logSum = 0;
  let pairCount = 0;

  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const key = `${ids[i]}|${ids[j]}`;
      const freq = fieldPairFreqs.get(key);
      // If pair never seen in field, use a floor of 0.0001 (very rare)
      const pairFreq = freq !== undefined ? Math.max(freq, 0.0001) : 0.0001;
      logSum += Math.log(pairFreq);
      pairCount++;
    }
  }

  if (pairCount === 0) return 0;
  return Math.exp(logSum / pairCount);  // Geometric mean of pair frequencies
}

// ============================================================
// FIELD COMBO ANALYSIS
// ============================================================

export interface FieldComboAnalysis {
  pairs: Map<string, number>;      // 2-player combo frequencies
  triples: Map<string, number>;    // 3-player combo frequencies
  quads: Map<string, number>;      // 4-player combo frequencies
  quints: Map<string, number>;     // 5-player combo frequencies
  captainCombos: Map<string, number>; // CPT+FLEX combos (showdown)
  chalkPairs: Set<string>;         // Overused 2-player combos
  chalkTriples: Set<string>;       // Overused 3-player combos
  playerFrequencies?: Map<string, number>; // Individual player frequencies in pool
}

/**
 * Analyze combo frequencies in the pool
 * This represents "the field" - what other players are building
 */
export function analyzePoolCombos(
  lineups: Lineup[],
  isShowdown: boolean = false
): FieldComboAnalysis {
  const pairCounts = new Map<string, number>();
  const tripleCounts = new Map<string, number>();
  const quadCounts = new Map<string, number>();
  const quintCounts = new Map<string, number>();
  const captainComboCounts = new Map<string, number>();
  const playerCounts = new Map<string, number>();

  // Sample for combo analysis - larger sample = more accurate frequencies
  const sampleSize = Math.min(lineups.length, 20000);
  const sample = lineups.length <= sampleSize
    ? lineups
    : lineups.filter((_, i) => i % Math.ceil(lineups.length / sampleSize) === 0);

  for (const lineup of sample) {
    const players = lineup.players;
    const ids = players.map(p => p.id);

    // Track individual player frequencies
    for (const id of ids) {
      playerCounts.set(id, (playerCounts.get(id) || 0) + 1);
    }

    // 2-player combos
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const key = [ids[i], ids[j]].sort().join('|');
        pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
      }
    }

    // 3-player combos
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        for (let k = j + 1; k < players.length; k++) {
          const key = [ids[i], ids[j], ids[k]].sort().join('|');
          tripleCounts.set(key, (tripleCounts.get(key) || 0) + 1);
        }
      }
    }

    // 4-player combos - always compute (needed for field differentiation)
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        for (let k = j + 1; k < players.length; k++) {
          for (let l = k + 1; l < players.length; l++) {
            const key = [ids[i], ids[j], ids[k], ids[l]].sort().join('|');
            quadCounts.set(key, (quadCounts.get(key) || 0) + 1);
          }
        }
      }
    }

    // 5-player combos - always compute (needed for field differentiation)
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        for (let k = j + 1; k < players.length; k++) {
          for (let l = k + 1; l < players.length; l++) {
            for (let m = l + 1; m < players.length; m++) {
              const key = [ids[i], ids[j], ids[k], ids[l], ids[m]].sort().join('|');
              quintCounts.set(key, (quintCounts.get(key) || 0) + 1);
            }
          }
        }
      }
    }

    // Showdown: track CPT + FLEX combos
    if (isShowdown) {
      const cpt = players.find(p => p.isCaptain);
      if (cpt) {
        const flexPlayers = players.filter(p => !p.isCaptain);
        for (const flex of flexPlayers) {
          const key = `CPT:${cpt.id}|FLEX:${flex.id}`;
          captainComboCounts.set(key, (captainComboCounts.get(key) || 0) + 1);
        }
      }
    }
  }

  // Convert to frequencies
  const pairs = new Map<string, number>();
  const triples = new Map<string, number>();
  const quads = new Map<string, number>();
  const quints = new Map<string, number>();
  const captainCombos = new Map<string, number>();
  const playerFrequencies = new Map<string, number>();

  for (const [key, count] of pairCounts) {
    pairs.set(key, count / sample.length);
  }
  for (const [key, count] of tripleCounts) {
    triples.set(key, count / sample.length);
  }
  for (const [key, count] of quadCounts) {
    quads.set(key, count / sample.length);
  }
  for (const [key, count] of quintCounts) {
    quints.set(key, count / sample.length);
  }
  for (const [key, count] of captainComboCounts) {
    captainCombos.set(key, count / sample.length);
  }
  for (const [id, count] of playerCounts) {
    playerFrequencies.set(id, count / sample.length);
  }

  // Identify chalk combos (high frequency)
  const CHALK_PAIR_THRESHOLD = 0.15;    // 15%+ of lineups
  const CHALK_TRIPLE_THRESHOLD = 0.08;  // 8%+ of lineups

  const chalkPairs = new Set<string>();
  const chalkTriples = new Set<string>();

  for (const [key, freq] of pairs) {
    if (freq >= CHALK_PAIR_THRESHOLD) {
      chalkPairs.add(key);
    }
  }
  for (const [key, freq] of triples) {
    if (freq >= CHALK_TRIPLE_THRESHOLD) {
      chalkTriples.add(key);
    }
  }

  return {
    pairs,
    triples,
    quads,
    quints,
    captainCombos,
    chalkPairs,
    chalkTriples,
    playerFrequencies,
  };
}

/**
 * Analyze combo frequencies from synthetic field lineups.
 * These field lineups are generated from ownership data (via generateFieldPool)
 * and represent what opponents are actually building — NOT our own pool.
 *
 * This is the correct approach for chalk/leverage detection:
 * ownership-weighted synthetic field → combo frequencies → chalk identification
 */
export function analyzeFieldCombos(
  fieldLineups: Array<{ playerIds: string[] }>,
  isShowdown: boolean = false
): FieldComboAnalysis {
  const pairCounts = new Map<string, number>();
  const tripleCounts = new Map<string, number>();
  const quadCounts = new Map<string, number>();
  const quintCounts = new Map<string, number>();
  const captainComboCounts = new Map<string, number>();

  const sampleSize = Math.min(fieldLineups.length, 20000);
  const sample = fieldLineups.length <= sampleSize
    ? fieldLineups
    : fieldLineups.filter((_, i) => i % Math.ceil(fieldLineups.length / sampleSize) === 0);

  for (const lineup of sample) {
    const ids = lineup.playerIds;

    // 2-player combos
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key = [ids[i], ids[j]].sort().join('|');
        pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
      }
    }

    // 3-player combos
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        for (let k = j + 1; k < ids.length; k++) {
          const key = [ids[i], ids[j], ids[k]].sort().join('|');
          tripleCounts.set(key, (tripleCounts.get(key) || 0) + 1);
        }
      }
    }

    // 4-player combos - always compute (needed for field differentiation)
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        for (let k = j + 1; k < ids.length; k++) {
          for (let l = k + 1; l < ids.length; l++) {
            const key = [ids[i], ids[j], ids[k], ids[l]].sort().join('|');
            quadCounts.set(key, (quadCounts.get(key) || 0) + 1);
          }
        }
      }
    }

    // 5-player combos - always compute (needed for field differentiation)
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        for (let k = j + 1; k < ids.length; k++) {
          for (let l = k + 1; l < ids.length; l++) {
            for (let m = l + 1; m < ids.length; m++) {
              const key = [ids[i], ids[j], ids[k], ids[l], ids[m]].sort().join('|');
              quintCounts.set(key, (quintCounts.get(key) || 0) + 1);
            }
          }
        }
      }
    }
  }

  // Convert to frequencies
  const pairs = new Map<string, number>();
  const triples = new Map<string, number>();
  const quads = new Map<string, number>();
  const quints = new Map<string, number>();
  const captainCombos = new Map<string, number>();

  for (const [key, count] of pairCounts) {
    pairs.set(key, count / sample.length);
  }
  for (const [key, count] of tripleCounts) {
    triples.set(key, count / sample.length);
  }
  for (const [key, count] of quadCounts) {
    quads.set(key, count / sample.length);
  }
  for (const [key, count] of quintCounts) {
    quints.set(key, count / sample.length);
  }

  // Identify chalk combos (high frequency in the field)
  const CHALK_PAIR_THRESHOLD = 0.15;    // 15%+ of field lineups
  const CHALK_TRIPLE_THRESHOLD = 0.08;  // 8%+ of field lineups

  const chalkPairs = new Set<string>();
  const chalkTriples = new Set<string>();

  for (const [key, freq] of pairs) {
    if (freq >= CHALK_PAIR_THRESHOLD) {
      chalkPairs.add(key);
    }
  }
  for (const [key, freq] of triples) {
    if (freq >= CHALK_TRIPLE_THRESHOLD) {
      chalkTriples.add(key);
    }
  }

  return {
    pairs,
    triples,
    quads,
    quints,
    captainCombos,
    chalkPairs,
    chalkTriples,
  };
}

/**
 * Count chalk combos in a lineup
 * Returns number of "chalky" combinations
 */
export function countChalkCombos(
  lineup: Lineup,
  fieldCombos: FieldComboAnalysis
): number {
  const players = lineup.players;
  const ids = players.map(p => p.id);
  let chalkCount = 0;

  // Check 2-player combos
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const key = [ids[i], ids[j]].sort().join('|');
      if (fieldCombos.chalkPairs.has(key)) {
        chalkCount++;
      }
    }
  }

  // Check 3-player combos (weighted more heavily)
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      for (let k = j + 1; k < players.length; k++) {
        const key = [ids[i], ids[j], ids[k]].sort().join('|');
        if (fieldCombos.chalkTriples.has(key)) {
          chalkCount += 2; // Triple chalk counts as 2
        }
      }
    }
  }

  return chalkCount;
}

/**
 * Calculate leverage score based on combo uniqueness in the field.
 * Uses BOTH 2-player pair frequencies AND 3-player triple frequencies.
 *
 * Triples are weighted more heavily (0.6 vs 0.4) because:
 * - They capture deeper structural overlap (3-man cores define lineup identity)
 * - They're naturally rarer, so frequency signal is more meaningful
 * - Sharing a 3-man core with the field is much more damaging than sharing a pair
 */
export function calculateComboLeverageScore(
  lineup: Lineup,
  fieldCombos: FieldComboAnalysis
): number {
  const players = lineup.players;
  const ids = players.map(p => p.id);

  // 2-player pair frequencies
  let pairFreqTotal = 0;
  let pairCount = 0;
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const key = [ids[i], ids[j]].sort().join('|');
      pairFreqTotal += fieldCombos.pairs.get(key) || 0;
      pairCount++;
    }
  }

  // 3-player triple frequencies
  let tripleFreqTotal = 0;
  let tripleCount = 0;
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      for (let k = j + 1; k < players.length; k++) {
        const key = [ids[i], ids[j], ids[k]].sort().join('|');
        tripleFreqTotal += fieldCombos.triples.get(key) || 0;
        tripleCount++;
      }
    }
  }

  if (pairCount === 0) return 0.5;

  // Pair leverage: 0% avg freq → 1.0, 50%+ → 0.0
  const avgPairFreq = pairFreqTotal / pairCount;
  const pairLeverage = Math.max(0, Math.min(1, 1 - (avgPairFreq * 2)));

  // Triple leverage: 0% avg freq → 1.0, 20%+ → 0.0 (tighter scale since triples are rarer)
  const avgTripleFreq = tripleCount > 0 ? tripleFreqTotal / tripleCount : 0;
  const tripleLeverage = Math.max(0, Math.min(1, 1 - (avgTripleFreq * 5)));

  // Blend: triples weighted more heavily
  return pairLeverage * 0.4 + tripleLeverage * 0.6;
}

/**
 * Ceiling-adjusted leverage: rewards being different in ways that can WIN.
 *
 * For each player pair (i,j):
 *   uniqueness = (1 - o1) * (1 - o2)   → probability field DOESN'T have this pair
 *   ceilingUpside = ceilNorm1 * ceilNorm2 → how much upside this pair brings
 *   pairScore = uniqueness * ceilingUpside → unique AND has upside = high leverage
 *
 * This prevents the "bad contrarian" trap: being different with low-ceiling players
 * scores poorly because ceilingUpside is low even though uniqueness is high.
 *
 * Returns 0-1 where 1 = maximally leveraged with high ceiling potential.
 */
export function calculateCeilingAdjustedLeverage(
  lineup: Lineup,
  maxCeiling: number
): number {
  const players = lineup.players;
  if (maxCeiling <= 0) return 0.5;

  let scoreSum = 0;
  let pairCount = 0;

  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const o1 = players[i].ownership / 100;
      const o2 = players[j].ownership / 100;
      const c1 = (players[i].ceiling || players[i].projection * 1.3) / maxCeiling;
      const c2 = (players[j].ceiling || players[j].projection * 1.3) / maxCeiling;

      // Uniqueness: how unlikely the field replicates this pair
      const uniqueness = (1 - o1) * (1 - o2);
      // Ceiling product: how much boom potential this pair has
      const ceilingUpside = c1 * c2;

      scoreSum += uniqueness * ceilingUpside;
      pairCount++;
    }
  }

  if (pairCount === 0) return 0.5;

  const rawScore = scoreSum / pairCount;

  // Typical ranges for rawScore (uniqueness * ceilingUpside):
  //   All 5% owned, high ceiling:  ~0.90 * 0.80 = 0.72 → extremely good
  //   All 15% owned, high ceiling: ~0.72 * 0.80 = 0.58 → good
  //   All 30% owned, high ceiling: ~0.49 * 0.80 = 0.39 → moderate
  //   All 15% owned, low ceiling:  ~0.72 * 0.30 = 0.22 → bad (contrarian but no upside)
  //   All 30% owned, low ceiling:  ~0.49 * 0.30 = 0.15 → very bad
  //
  // Scale: 0.0 → 0, 0.60+ → 1.0
  return Math.max(0, Math.min(1, rawScore / 0.60));
}

// ============================================================
// SALARY CONSTRUCTION LEVERAGE
// ============================================================

export interface FieldSalaryProfile {
  avgCurve: number[];   // Average salary at each slot (sorted descending)
  stdCurve: number[];   // Std deviation at each slot
  rosterSize: number;
}

/**
 * Analyze the salary distribution shape of synthetic field lineups.
 * Builds the field's "typical salary curve": what salary the field puts
 * in their highest slot, 2nd highest, etc.
 *
 * This captures construction archetypes (stars-and-scrubs vs balanced)
 * without needing to define discrete categories.
 */
export function analyzeFieldSalaryProfile(
  fieldLineups: Array<{ salaries: number[] }>
): FieldSalaryProfile {
  if (fieldLineups.length === 0) {
    return { avgCurve: [], stdCurve: [], rosterSize: 0 };
  }

  const rosterSize = fieldLineups[0].salaries.length;
  const slotSums: number[] = new Array(rosterSize).fill(0);
  const slotSqSums: number[] = new Array(rosterSize).fill(0);
  const n = fieldLineups.length;

  for (const lineup of fieldLineups) {
    // Sort salaries descending to get the salary "shape"
    const sorted = [...lineup.salaries].sort((a, b) => b - a);
    for (let s = 0; s < rosterSize; s++) {
      slotSums[s] += sorted[s];
      slotSqSums[s] += sorted[s] * sorted[s];
    }
  }

  const avgCurve = slotSums.map(sum => sum / n);
  const stdCurve = slotSums.map((sum, s) => {
    const mean = sum / n;
    const variance = (slotSqSums[s] / n) - (mean * mean);
    return Math.sqrt(Math.max(0, variance));
  });

  return { avgCurve, stdCurve, rosterSize };
}

/**
 * Calculate salary construction leverage: how different is this lineup's
 * salary shape from the field's typical construction?
 *
 * Compares sorted salary curve (descending) against field average curve.
 * Uses z-score based deviation so each slot position is weighted by
 * how much the field varies at that slot.
 *
 * High score = different construction from field (e.g., balanced build
 * when field is mostly stars-and-scrubs, or vice versa).
 */
export function calculateSalaryConstructionLeverage(
  lineup: Lineup,
  fieldProfile: FieldSalaryProfile
): number {
  if (fieldProfile.rosterSize === 0 || fieldProfile.avgCurve.length === 0) return 0.5;

  const salaries = lineup.players.map(p => p.salary);
  const sorted = [...salaries].sort((a, b) => b - a);

  let totalDeviation = 0;
  let slotCount = 0;

  for (let s = 0; s < Math.min(sorted.length, fieldProfile.avgCurve.length); s++) {
    const diff = Math.abs(sorted[s] - fieldProfile.avgCurve[s]);
    // Use z-score if std > 0, otherwise use raw deviation / 1000
    const std = fieldProfile.stdCurve[s];
    const normalizedDiff = std > 100 ? diff / std : diff / 1000;
    totalDeviation += normalizedDiff;
    slotCount++;
  }

  if (slotCount === 0) return 0.5;

  const avgDeviation = totalDeviation / slotCount;

  // Typical ranges for avgDeviation (z-score based):
  //   Nearly identical to field: ~0.2-0.4
  //   Moderately different:      ~0.6-1.0
  //   Very different construction: ~1.2-2.0+
  //
  // Scale: 0 → 0, 1.5+ → 1.0
  return Math.max(0, Math.min(1, avgDeviation / 1.5));
}

// ============================================================
// DIRECT FIELD OVERLAP SCORING
// ============================================================

/**
 * Pre-computed index for fast field overlap lookups.
 * Contains both per-player field frequencies (for contrarian scoring)
 * and per-player field lineup indices (for combination overlap computation).
 */
export interface FieldOverlapIndex {
  playerFieldIndices: Map<string, number[]>;  // player ID → field lineup indices
  playerFieldFrequency: Map<string, number>;  // player ID → fraction of field containing them
  fieldSize: number;
  rosterSize: number;
}

/**
 * Build a reverse index from synthetic field lineups for fast overlap queries.
 * Call once after generating the field, then pass to calculateFieldOverlapScore.
 */
export function buildFieldOverlapIndex(
  fieldLineups: Array<{ playerIds: string[] }>,
  rosterSize: number
): FieldOverlapIndex {
  const playerFieldIndices = new Map<string, number[]>();

  for (let fi = 0; fi < fieldLineups.length; fi++) {
    for (const id of fieldLineups[fi].playerIds) {
      let indices = playerFieldIndices.get(id);
      if (!indices) {
        indices = [];
        playerFieldIndices.set(id, indices);
      }
      indices.push(fi);
    }
  }

  // Pre-compute frequencies
  const playerFieldFrequency = new Map<string, number>();
  for (const [id, indices] of playerFieldIndices) {
    playerFieldFrequency.set(id, indices.length / fieldLineups.length);
  }

  return { playerFieldIndices, playerFieldFrequency, fieldSize: fieldLineups.length, rosterSize };
}

/**
 * Calculate leverage score: how much this lineup differs from the field
 * in ways that can actually WIN.
 *
 * Two signals blended:
 *
 *   1. PAIRWISE CEILING-CONTRARIAN (70%) — quality differentiation
 *      For each player pair (i,j):
 *        uniqueness = (1 - fieldFreq_i) × (1 - fieldFreq_j)
 *        ceilingUpside = (ceil_i / maxCeiling) × (ceil_j / maxCeiling)
 *        pairScore = uniqueness × ceilingUpside
 *      The PAIRWISE structure is critical: having even one chalk player
 *      drags down all pairs involving it. This strongly penalizes lineups
 *      that try to be "contrarian" while still rostering popular stars.
 *      Uses actual field frequencies (more accurate than raw ownership).
 *
 *   2. COMBINATION UNIQUENESS (30%) — structural differentiation
 *      What fraction of field lineups share ≥ 3 players with this lineup?
 *      This captures lineup STRUCTURE that per-player metrics miss:
 *      if players A+B are always paired in the field, a lineup with A+B
 *      has more high-overlap field lineups than one with A+C.
 *
 * Returns 0-1 where 1 = maximally leveraged with high upside.
 */
export function calculateFieldOverlapScore(
  lineup: Lineup,
  overlapIndex: FieldOverlapIndex,
  maxCeiling: number,
  fieldComboPairs?: Map<string, number>
): number {
  const { playerFieldFrequency, rosterSize } = overlapIndex;
  if (rosterSize === 0 || maxCeiling <= 0) return 0.5;

  const players = lineup.players;

  // --- Ceiling floor: minimum ceiling threshold to prevent "cheap garbage" leverage ---
  // Players below 60% of lineup average ceiling get a multiplicative discount
  // on their leverage contribution. This prevents low-ceiling min-salary players
  // from inflating leverage scores just because nobody rosters them.
  const avgCeiling = players.reduce((sum, p) =>
    sum + (p.ceiling || p.ceiling99 || p.projection * 1.3), 0) / players.length;
  const ceilingFloorThreshold = avgCeiling * 0.60;

  // --- Signal 1: Pairwise boom-weighted contrarian ---
  // Uses p85 ceiling (expected upside) instead of p99 to avoid overweighting
  // high-variance risky players. Leverage should measure differentiation, not tail risk.
  let pairScoreSum = 0;
  let pairCount = 0;

  for (let i = 0; i < players.length; i++) {
    // Use synthetic field frequency — more accurate than raw ownership because it
    // accounts for position constraints, salary caps, and archetype distribution
    // that shape actual field construction.
    const freq_i = playerFieldFrequency.get(players[i].id) || 0;
    const rawCeil_i = players[i].ceiling || players[i].ceiling99 || players[i].projection * 1.3;
    const boomCeil_i = rawCeil_i / maxCeiling;
    const own_i = players[i].ownership / 100;
    // Ceiling floor discount: players below threshold get proportional reduction
    const ceilFloor_i = rawCeil_i >= ceilingFloorThreshold ? 1.0 : (rawCeil_i / ceilingFloorThreshold);

    for (let j = i + 1; j < players.length; j++) {
      const freq_j = playerFieldFrequency.get(players[j].id) || 0;
      const rawCeil_j = players[j].ceiling || players[j].ceiling99 || players[j].projection * 1.3;
      const boomCeil_j = rawCeil_j / maxCeiling;
      const own_j = players[j].ownership / 100;
      const ceilFloor_j = rawCeil_j >= ceilingFloorThreshold ? 1.0 : (rawCeil_j / ceilingFloorThreshold);

      // Use actual field pair frequency when available, otherwise fall back to
      // independence assumption: (1 - freq_i) * (1 - freq_j).
      // Actual pair data captures correlations in field construction (e.g., players
      // frequently paired together have higher actual pair freq than independence implies).
      let uniqueness: number;
      if (fieldComboPairs) {
        const pairKey = [players[i].id, players[j].id].sort().join('|');
        const actualPairFreq = fieldComboPairs.get(pairKey);
        if (actualPairFreq !== undefined) {
          // Use actual pair frequency from field combo analysis
          uniqueness = 1 - actualPairFreq;
        } else {
          // Pair not seen in field at all - very unique
          uniqueness = (1 - freq_i) * (1 - freq_j);
        }
      } else {
        // No pair data available - use independence assumption
        uniqueness = (1 - freq_i) * (1 - freq_j);
      }
      const ceilingUpside = boomCeil_i * boomCeil_j;

      // Smooth ownership penalty: starts at 0.20, full at 0.40
      // Replaces hard step function (own > 0.25 ? 0.7 : 1.0) with sigmoid-like curve
      const ownPenalty_i = own_i > 0.20
        ? 1.0 - 0.3 * Math.min(1, (own_i - 0.20) / 0.20)  // 0.20→1.0, 0.40→0.7
        : 1.0;
      const ownPenalty_j = own_j > 0.20
        ? 1.0 - 0.3 * Math.min(1, (own_j - 0.20) / 0.20)  // 0.20→1.0, 0.40→0.7
        : 1.0;
      const ownershipPenalty = ownPenalty_i * ownPenalty_j;
      // Apply ceiling floor discount to prevent low-ceiling players from gaming leverage
      pairScoreSum += uniqueness * ceilingUpside * ownershipPenalty * ceilFloor_i * ceilFloor_j;
      pairCount++;
    }
  }

  if (pairCount === 0) return 0.5;
  const rawPairScore = pairScoreSum / pairCount;
  // Scale: same as ceiling-adjusted leverage — 0.0 → 0, 0.60+ → 1.0
  return Math.max(0, Math.min(1, rawPairScore / 0.60));
}

// ============================================================
// FIELD ANTI-CORRELATION SCORE
// ============================================================

/**
 * Calculate anti-correlation score: how different is this lineup from the field?
 *
 * Counts field lineups sharing 4+ players with this lineup.
 * If 20%+ of field has high overlap, score is 0 (too similar).
 * If <5% of field has high overlap, score is 1 (very unique).
 *
 * Use as 10% weight in totalScore to reward structural uniqueness.
 */
export function calculateFieldAntiCorrelation(
  lineup: Lineup,
  overlapIndex: FieldOverlapIndex
): number {
  const { playerFieldIndices, fieldSize } = overlapIndex;
  if (fieldSize === 0) return 0.5;

  const playerIds = lineup.players.map(p => p.id);

  // Use intersection counting to find field lineups with high overlap
  // For each field lineup, count how many of our players it contains
  const fieldLineupOverlaps = new Map<number, number>();

  for (const playerId of playerIds) {
    const fieldIndices = playerFieldIndices.get(playerId) || [];
    for (const fieldIdx of fieldIndices) {
      fieldLineupOverlaps.set(fieldIdx, (fieldLineupOverlaps.get(fieldIdx) || 0) + 1);
    }
  }

  // Count field lineups sharing 4+ players
  let highOverlapCount = 0;
  for (const overlap of fieldLineupOverlaps.values()) {
    if (overlap >= 4) {
      highOverlapCount++;
    }
  }

  const overlapRatio = highOverlapCount / fieldSize;

  // Scale: 0% overlap = 1.0, 20%+ overlap = 0.0
  return Math.max(0, Math.min(1, 1 - overlapRatio * 5));
}

// ============================================================
// FIELD OVERLAP METRICS (Detailed Lineup-Level Analysis)
// ============================================================

export interface FieldOverlapMetrics {
  antiCorrelationScore: number;    // existing 0-1 score (kept for backward compat)
  overlapHistogram: number[];      // [0-player, 1-player, ..., N-player] counts
  maxOverlap: number;              // highest overlap with any single field lineup
  nearDuplicateCount: number;      // field lineups sharing rosterSize-2 or more players
  nearDuplicateRate: number;       // nearDuplicateCount / fieldSize
  overlapSeverity: number;         // 0-1 composite: how "field-like" this lineup is
}

/**
 * Calculate detailed field overlap metrics for a lineup.
 * Returns histogram of overlap counts, max overlap, near-duplicate rate,
 * and a composite severity score.
 */
export function calculateFieldOverlapMetrics(
  lineup: Lineup,
  overlapIndex: FieldOverlapIndex
): FieldOverlapMetrics {
  const { playerFieldIndices, fieldSize } = overlapIndex;
  const rosterSize = lineup.players.length;

  if (fieldSize === 0) {
    return {
      antiCorrelationScore: 0.5,
      overlapHistogram: new Array(rosterSize + 1).fill(0),
      maxOverlap: 0,
      nearDuplicateCount: 0,
      nearDuplicateRate: 0,
      overlapSeverity: 0,
    };
  }

  const playerIds = lineup.players.map(p => p.id);

  // Count overlap with each field lineup
  const fieldLineupOverlaps = new Map<number, number>();
  for (const playerId of playerIds) {
    const fieldIndices = playerFieldIndices.get(playerId) || [];
    for (const fieldIdx of fieldIndices) {
      fieldLineupOverlaps.set(fieldIdx, (fieldLineupOverlaps.get(fieldIdx) || 0) + 1);
    }
  }

  // Build histogram and find max overlap + near-duplicate count
  const overlapHistogram = new Array(rosterSize + 1).fill(0);
  let maxOverlap = 0;
  let nearDuplicateCount = 0;
  let highOverlapCount = 0;
  const nearDupThreshold = rosterSize - 2;

  for (const overlap of fieldLineupOverlaps.values()) {
    overlapHistogram[Math.min(overlap, rosterSize)]++;
    if (overlap > maxOverlap) maxOverlap = overlap;
    if (overlap >= nearDupThreshold) nearDuplicateCount++;
    if (overlap >= 4) highOverlapCount++;
  }
  // Field lineups with 0 overlap aren't in the map — fill in
  overlapHistogram[0] = fieldSize - fieldLineupOverlaps.size;

  const nearDuplicateRate = nearDuplicateCount / fieldSize;

  // Existing anti-correlation score (backward compat)
  const overlapRatio = highOverlapCount / fieldSize;
  const antiCorrelationScore = Math.max(0, Math.min(1, 1 - overlapRatio * 5));

  // Composite severity: how "field-like" is this lineup?
  const severity =
    0.40 * (maxOverlap / rosterSize) +                           // worst-case single field match
    0.35 * Math.min(1, nearDuplicateRate * 200) +                // rate of near-dupes (0.5% → 1.0)
    0.25 * Math.min(1, highOverlapCount / fieldSize * 5);        // existing 4+ overlap ratio

  return {
    antiCorrelationScore,
    overlapHistogram,
    maxOverlap,
    nearDuplicateCount,
    nearDuplicateRate,
    overlapSeverity: Math.max(0, Math.min(1, severity)),
  };
}

// ============================================================
// VALUE LEVERAGE ANALYSIS
// ============================================================

export interface ValueLeveragePlayer {
  id: string;
  name: string;
  salary: number;
  projection: number;
  ownership: number;
  value: number;           // pts per $1K salary
  leverageScore: number;   // 0-1 (high value + low ownership = high leverage)
  isHiddenValue: boolean;  // High value + low ownership
}

export interface ValueLeverageAnalysis {
  players: Map<string, ValueLeveragePlayer>;
  hiddenValuePlayers: ValueLeveragePlayer[];
  avgValue: number;
  avgOwnership: number;
  topLeveragePlayers: ValueLeveragePlayer[];
}

/**
 * Analyze value leverage across all players in the pool
 * Identifies "hidden value" plays (high pts/$ + low ownership)
 */
export function analyzeValueLeverage(lineups: Lineup[]): ValueLeverageAnalysis {
  const allPlayers = new Map<string, { player: Player; count: number }>();

  for (const lineup of lineups) {
    for (const player of lineup.players) {
      if (!allPlayers.has(player.id)) {
        allPlayers.set(player.id, { player, count: 1 });
      } else {
        allPlayers.get(player.id)!.count++;
      }
    }
  }

  const playerMetrics = new Map<string, ValueLeveragePlayer>();
  let totalValue = 0;
  let totalOwnership = 0;
  let playerCount = 0;

  for (const [id, { player }] of allPlayers) {
    const value = player.salary > 0 ? (player.projection / player.salary) * 1000 : 0;

    playerMetrics.set(id, {
      id: player.id,
      name: player.name,
      salary: player.salary,
      projection: player.projection,
      ownership: player.ownership,
      value,
      leverageScore: 0, // Calculated below
      isHiddenValue: false,
    });

    totalValue += value;
    totalOwnership += player.ownership;
    playerCount++;
  }

  const avgValue = playerCount > 0 ? totalValue / playerCount : 5.0;
  const avgOwnership = playerCount > 0 ? totalOwnership / playerCount : 20;

  // Calculate leverage scores
  const hiddenValuePlayers: ValueLeveragePlayer[] = [];

  for (const [id, metrics] of playerMetrics) {
    const valueScore = Math.min(1, Math.max(0, (metrics.value - 4.0) / 4.0));
    const ownershipScore = Math.min(1, Math.max(0, (30 - metrics.ownership) / 30));

    metrics.leverageScore = (valueScore * 0.5) + (ownershipScore * 0.5);

    // Boost for high value + very low ownership
    if (valueScore > 0.5 && ownershipScore > 0.7) {
      metrics.leverageScore = Math.min(1, metrics.leverageScore * 1.3);
    }

    // Hidden value criteria
    const isAboveAvgValue = metrics.value >= avgValue * 1.3;
    const isBelowAvgOwnership = metrics.ownership < avgOwnership * 0.5;
    const isViableProjection = metrics.projection >= 18;
    const isExtremeValue = metrics.value >= 7.0 && metrics.ownership < 10;

    const isHiddenValue =
      (isAboveAvgValue && isBelowAvgOwnership && isViableProjection) ||
      isExtremeValue;

    metrics.isHiddenValue = isHiddenValue;

    if (isHiddenValue) {
      hiddenValuePlayers.push(metrics);
    }
  }

  hiddenValuePlayers.sort((a, b) => b.leverageScore - a.leverageScore);

  const topLeveragePlayers = [...playerMetrics.values()]
    .sort((a, b) => b.leverageScore - a.leverageScore)
    .slice(0, 10);

  return {
    players: playerMetrics,
    hiddenValuePlayers,
    avgValue,
    avgOwnership,
    topLeveragePlayers,
  };
}

/**
 * Calculate lineup's value leverage score
 */
export function calculateLineupValueLeverageScore(
  lineup: Lineup,
  valueLeverage: ValueLeverageAnalysis
): number {
  let totalLeverageScore = 0;
  let hiddenValueCount = 0;
  let playerCount = 0;

  for (const player of lineup.players) {
    const metrics = valueLeverage.players.get(player.id);
    if (metrics) {
      totalLeverageScore += metrics.leverageScore;
      if (metrics.isHiddenValue) {
        hiddenValueCount++;
      }
      playerCount++;
    }
  }

  const baseLeverageScore = playerCount > 0 ? totalLeverageScore / playerCount : 0.5;

  // Bonus for multiple hidden value players
  let hiddenValueBonus = 0;
  if (hiddenValueCount >= 2) {
    hiddenValueBonus = 0.20;
  } else if (hiddenValueCount >= 1) {
    hiddenValueBonus = 0.10;
  }

  return Math.min(1, baseLeverageScore + hiddenValueBonus);
}

// ============================================================
// PROJECTION EDGE DETECTION
// ============================================================

/**
 * Projection edge: our projection vs ownership-implied projection.
 *
 * Uses linear regression of ownership vs projection across all players
 * to estimate what projection the FIELD expects for each ownership level.
 *
 * Edge = (ourProjection - impliedProjection) / impliedProjection
 */
export interface ProjectionEdgePlayer {
  id: string;
  name: string;
  ourProjection: number;
  impliedProjection: number;
  projectionEdge: number;      // (our - implied) / implied, can be negative
  normalizedEdge: number;      // 0-1 score where 1 = massive positive edge
  ownership: number;
}

export interface ProjectionEdgeAnalysis {
  players: Map<string, ProjectionEdgePlayer>;
  avgEdge: number;
  topEdgePlayers: string[];    // Top 10 player IDs with biggest positive edges
}

/**
 * Analyze projection edge across all players.
 *
 * Uses linear regression to determine what projection the field expects
 * at each ownership level. Players where our projection exceeds the field's
 * expectation have "edge" - we believe they're underpriced by the market.
 */
export function analyzeProjectionEdge(players: Player[]): ProjectionEdgeAnalysis {
  const n = players.length;
  if (n === 0) {
    return { players: new Map(), avgEdge: 0, topEdgePlayers: [] };
  }

  // Log-linear regression: ownership -> expected projection
  // impliedProjection = alpha + beta * log(1 + ownership)
  // Models the diminishing return of ownership as a projection signal at high levels.
  // Above ~25%, ownership is driven by "chalk gravity" (name recognition), not projection quality.
  let sumLogOwn = 0, sumProj = 0, sumLogOwnProj = 0, sumLogOwn2 = 0;

  for (const p of players) {
    const logOwn = Math.log(1 + p.ownership / 100);
    sumLogOwn += logOwn;
    sumProj += p.projection;
    sumLogOwnProj += logOwn * p.projection;
    sumLogOwn2 += logOwn * logOwn;
  }

  // Regression coefficients: impliedProj = alpha + beta * log(1 + ownership)
  const denominator = n * sumLogOwn2 - sumLogOwn * sumLogOwn;
  const beta = denominator !== 0 ? (n * sumLogOwnProj - sumLogOwn * sumProj) / denominator : 0;
  const alpha = (sumProj - beta * sumLogOwn) / n;

  // R² goodness of fit: if regression is poor, dampen edge scores
  const meanProj = sumProj / n;
  let ssRes = 0, ssTot = 0;
  for (const p of players) {
    const fitted = alpha + beta * Math.log(1 + p.ownership / 100);
    ssRes += (p.projection - fitted) ** 2;
    ssTot += (p.projection - meanProj) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  // If R² < 0.10, the regression is essentially noise — dampen edges
  const edgeDamping = r2 >= 0.10 ? 1.0 : r2 / 0.10; // Linear ramp: 0 at R²=0, 1.0 at R²≥0.10

  // Calculate implied projection and edge for each player
  const result = new Map<string, ProjectionEdgePlayer>();
  let totalEdge = 0;

  for (const p of players) {
    const impliedProj = Math.max(10, alpha + beta * Math.log(1 + p.ownership / 100));
    const rawEdge = (p.projection - impliedProj) / impliedProj;
    const edge = rawEdge * edgeDamping; // Dampen when regression is poor

    result.set(p.id, {
      id: p.id,
      name: p.name,
      ourProjection: p.projection,
      impliedProjection: impliedProj,
      projectionEdge: edge,
      // Normalize: -0.2 to +0.4 edge maps to 0 to 1
      normalizedEdge: Math.max(0, Math.min(1, (edge + 0.2) / 0.6)),
      ownership: p.ownership,
    });

    totalEdge += edge;
  }

  // Find top edge players (highest positive edge)
  const sortedByEdge = [...result.values()].sort((a, b) => b.projectionEdge - a.projectionEdge);
  const topEdgePlayers = sortedByEdge.slice(0, 10).map(p => p.id);

  return {
    players: result,
    avgEdge: totalEdge / n,
    topEdgePlayers,
  };
}

/**
 * Calculate lineup's projection edge score.
 * Rewards lineups with multiple high-edge players.
 */
export function calculateLineupProjectionEdgeScore(
  lineup: Lineup,
  edgeAnalysis: ProjectionEdgeAnalysis
): number {
  if (edgeAnalysis.players.size === 0) return 0.5;

  let totalEdgeScore = 0;
  let highEdgeCount = 0;

  for (const player of lineup.players) {
    const data = edgeAnalysis.players.get(player.id);
    if (data) {
      totalEdgeScore += data.normalizedEdge;
      if (data.projectionEdge > 0.15) highEdgeCount++;  // 15%+ edge
    }
  }

  const baseScore = totalEdgeScore / lineup.players.length;

  // Bonus for having multiple high-edge players
  const multiEdgeBonus = highEdgeCount >= 3 ? 0.15 : highEdgeCount >= 2 ? 0.10 : 0;

  return Math.min(1, baseScore + multiEdgeBonus);
}

// ============================================================
// JUSTIFIED OWNERSHIP CHALK DISTINCTION
// ============================================================

export interface JustifiedOwnershipAnalysis {
  /** Per-player justified ownership factor (0-1 where 1 = fully justified) */
  playerFactors: Map<string, number>;
}

/**
 * Compute "justified ownership" for each player by comparing projection rank to ownership rank.
 * A 40% owned player who has the slate's highest projection (legitimately elite) is "justified"
 * and should receive a reduced ownership penalty. A 40% owned player with middling projection
 * (popular but not elite) is "unjustified" and gets the full penalty.
 *
 * Returns a factor per player: 1.0 = fully justified (proj rank >= own rank),
 * lower values mean ownership is less justified by projection quality.
 */
export function analyzeJustifiedOwnership(players: Player[]): JustifiedOwnershipAnalysis {
  if (players.length === 0) return { playerFactors: new Map() };

  // Rank by projection (descending) and ownership (descending)
  const byProjection = [...players].sort((a, b) => b.projection - a.projection);
  const byOwnership = [...players].sort((a, b) => b.ownership - a.ownership);

  const projRank = new Map<string, number>();
  const ownRank = new Map<string, number>();
  for (let i = 0; i < byProjection.length; i++) projRank.set(byProjection[i].id, i);
  for (let i = 0; i < byOwnership.length; i++) ownRank.set(byOwnership[i].id, i);

  const playerFactors = new Map<string, number>();
  const n = players.length;

  for (const p of players) {
    const pRank = projRank.get(p.id) || n;
    const oRank = ownRank.get(p.id) || n;

    // If projection rank is better (lower number) than ownership rank,
    // the chalk is justified — this player SHOULD be highly owned
    if (pRank <= oRank) {
      playerFactors.set(p.id, 1.0); // Fully justified
    } else {
      // Ownership rank is better than projection rank — unjustified chalk
      // Factor reduces from 1.0 to 0.0 as the gap increases
      const rankGap = (pRank - oRank) / n; // Normalized gap
      playerFactors.set(p.id, Math.max(0, 1.0 - rankGap * 2));
    }
  }

  return { playerFactors };
}

/**
 * Calculate justified ownership adjustment for a lineup.
 * Returns a factor (0.80 - 1.0) that reduces the ownership penalty
 * for lineups where chalk is projection-justified.
 */
export function calculateJustifiedOwnershipFactor(
  lineup: Lineup | ScoredLineup,
  analysis: JustifiedOwnershipAnalysis
): number {
  if (analysis.playerFactors.size === 0) return 1.0;

  let totalFactor = 0;
  let highOwnCount = 0;

  for (const player of lineup.players) {
    if (player.ownership > 20) {
      // Only apply to high-owned players (chalk distinction only matters for popular players)
      const factor = analysis.playerFactors.get(player.id) || 0.5;
      totalFactor += factor;
      highOwnCount++;
    }
  }

  if (highOwnCount === 0) return 1.0; // No chalk players — no adjustment

  const avgFactor = totalFactor / highOwnCount;
  // Up to 20% reduction in ownership penalty when chalk is justified
  return 1.0 - (1.0 - avgFactor) * 0.20;
}

// ============================================================
// CORRELATED CEILING SCORING
// ============================================================

/**
 * Calculate correlated ceiling score for a lineup.
 *
 * Independent ceiling scoring treats each player's upside separately.
 * But in reality, game stacks have MULTIPLICATIVE ceiling: when a game
 * goes to OT or becomes a shootout, ALL players from that game boom
 * simultaneously. A 3-stack where each player has 1.4x ceiling ratio
 * produces a correlated ceiling much higher than 3 independent booms.
 *
 * Returns a 0-1 score where:
 * - 0.0 = no game stacking or low-ceiling players
 * - 0.5 = typical lineup (baseline)
 * - 1.0 = deep game stack (3+) with high-ceiling players from a high-total game
 */
export function calculateCorrelatedCeilingScore(lineup: Lineup | ScoredLineup): number {
  const players = lineup.players;
  if (players.length < 3) return 0.5;

  // Group players by game
  const gameGroups = new Map<string, typeof players>();
  for (const p of players) {
    const gameId = p.gameInfo || `${p.team}_game`;
    if (!gameGroups.has(gameId)) gameGroups.set(gameId, []);
    gameGroups.get(gameId)!.push(p);
  }

  let bestCorrelatedCeiling = 0;

  for (const [, gamePlayers] of gameGroups) {
    if (gamePlayers.length < 2) continue;

    // Calculate per-player ceiling ratios in this game stack
    const ceilingRatios: number[] = [];
    let gameTotal = 220; // default
    for (const p of gamePlayers) {
      const ceil = p.ceiling || p.projection * 1.25;
      const ceil99 = p.ceiling99 || ceil * 1.15;
      // Blend p85 (60%) + p99 (40%) for GPP-relevant ceiling
      const blendedCeil = ceil * 0.60 + ceil99 * 0.40;
      const ratio = blendedCeil / Math.max(1, p.projection);
      ceilingRatios.push(ratio);
      if (p.gameTotal && p.gameTotal > gameTotal) gameTotal = p.gameTotal;
    }

    // Correlated ceiling: geometric product of ceiling ratios
    // A 3-stack with ratios [1.4, 1.35, 1.5] has a correlated ceiling
    // of 1.4 * 1.35 * 1.5 = 2.835x — much higher than the average 1.42x
    const productRatio = ceilingRatios.reduce((prod, r) => prod * r, 1);

    // Stack size bonus: deeper stacks get multiplicative credit
    const stackBonus = gamePlayers.length >= 4 ? 1.4
      : gamePlayers.length === 3 ? 1.2
      : 1.0;

    // Game total bonus: high-scoring games have more variance (more boom)
    const gameTotalBonus = Math.max(0.8, gameTotal / 225);

    // Bring-back bonus: players from both teams in the game
    const teams = new Set(gamePlayers.map(p => p.team));
    const bringBackBonus = teams.size >= 2 ? 1.15 : 1.0;

    const correlatedScore = productRatio * stackBonus * gameTotalBonus * bringBackBonus;
    bestCorrelatedCeiling = Math.max(bestCorrelatedCeiling, correlatedScore);
  }

  // Normalize: 1.0 = no stacking/low ceiling, 3.0+ = deep high-ceiling stack
  // Map to 0-1: 1.5 → 0.25, 2.0 → 0.50, 3.0 → 1.0
  if (bestCorrelatedCeiling <= 1.0) return 0;
  return Math.max(0, Math.min(1, (bestCorrelatedCeiling - 1.0) / 2.0));
}

// ============================================================
// DEEP COMBO ANALYSIS
// ============================================================

export interface DeepComboAnalysis {
  // Combo frequency maps
  pairs: Map<string, number>;
  triples: Map<string, number>;
  quads: Map<string, number>;
  quints: Map<string, number>;
  sexts: Map<string, number>;   // 6-man combos
  septs: Map<string, number>;   // 7-man combos

  // Differentiated cores by size (combos in pool but rare in field)
  // Separated by size for weighted scoring - deeper cores are more valuable
  cores3: DifferentiatedCore[];  // 3-man cores
  cores4: DifferentiatedCore[];  // 4-man cores (more valuable)
  cores5: DifferentiatedCore[];  // 5-man cores (most valuable)

  // Field-heavy cores (combos the field uses MORE than us - AVOID these)
  fieldHeavyCores3: DifferentiatedCore[];

  // UNIVERSALLY COMMON cores (overused in BOTH pool AND field - penalize/avoid)
  // These are the "chalk constructions" that everyone is building
  // Penalty increases with combo size - more players = harder to differentiate
  universallyCommonCores3: DifferentiatedCore[];  // 3-man chalk = light penalty, substitute 1 player
  universallyCommonCores4: DifferentiatedCore[];  // 4-man chalk = medium penalty, substitute 1-2 players
  universallyCommonCores5: DifferentiatedCore[];  // 5-man chalk = heavy penalty, avoid or substitute 2+ players
  universallyCommonCores6: DifferentiatedCore[];  // 6-man chalk = reject
  universallyCommonCores7: DifferentiatedCore[];  // 7-man chalk = reject

  // Cross-combo interactions: "coreA||coreB" → field co-occurrence frequency
  // Measures how often two non-overlapping differentiated cores appear together in field
  coreInteractions: Map<string, number>;

  // Combined for backwards compatibility
  differentiatedCores: DifferentiatedCore[];
}

export interface DifferentiatedCore {
  playerIds: string[];
  playerNames: string[];
  comboSize: number;
  poolFrequency: number;
  fieldFrequency: number;
  frequencyGap: number;          // poolFreq - fieldFreq (positive = our edge)
  combinedFrequency: number;     // Combined pool + field frequency (for logging/penalties)
  avgProjection: number;
  differentiationScore: number;  // gap * projection quality
  correlationWeight: number;     // Game/team correlation multiplier
  sharpFieldFrequency?: number;  // Frequency among sharp archetypes (E2)
}

/**
 * Calculate correlation weight for a combo based on game/team structure.
 *
 * In 'bonus' mode (differentiated cores): correlated upside is MORE valuable.
 * Same-team cores (QB+WR ~0.40 correlation) boom together → bigger GPP payoff.
 *
 * In 'penalty' mode (chalk cores): correlated field upside makes chalk WORSE.
 * Same-team chalk gives the field a correlated windfall when that team hits.
 */
function calculateCorrelationWeight(
  players: Player[],
  mode: 'bonus' | 'penalty'
): number {
  const gameIds = new Set(players.map(p => p.gameInfo || `${p.team}_game`));
  const teamIds = new Set(players.map(p => p.team));
  const allSameTeam = teamIds.size === 1;
  const allSameGame = gameIds.size === 1;
  const mostlySameGame = gameIds.size <= Math.ceil(players.length / 2);

  if (mode === 'bonus') {
    // Differentiated cores: correlated upside is MORE valuable
    if (allSameTeam) return 1.30;      // ~0.40 team correlation
    if (allSameGame) return 1.15;      // ~0.15 game correlation
    if (mostlySameGame) return 1.08;
    return 1.00;
  } else {
    // Chalk cores: correlated field upside makes chalk WORSE
    if (allSameTeam) return 1.40;      // Same-team chalk = field gets correlated windfall
    if (allSameGame) return 1.25;      // Same-game chalk = game-level correlation hurts
    if (mostlySameGame) return 1.12;
    return 1.00;
  }
}

/**
 * Analyze 3/4/5-man combos on FULL pool to identify differentiated cores.
 * Compares pool combos vs field combos to find constructions we have that
 * the field is NOT utilizing.
 *
 * These "differentiated cores" are the key to GPP success - high-quality
 * player combinations that are underrepresented in opponent lineups.
 */
export function analyzeDeepCombos(
  poolLineups: Lineup[],
  fieldLineups: { playerIds: string[]; archetype?: string }[],
  allPlayers: Player[],
  numGames: number = 5
): DeepComboAnalysis {
  console.log(`  Analyzing deep combos: ${poolLineups.length} pool vs ${fieldLineups.length} field (${numGames} games)...`);

  // Build player lookup
  const playerMap = new Map(allPlayers.map(p => [p.id, p]));

  // E2: Classify field lineups into sharp/casual tiers for archetype-aware analysis
  const SHARP_ARCHETYPES = new Set(['sharpOptimizer', 'leverageOptimizer', 'ceilingOptimizer']);
  const hasArchetypeData = fieldLineups.some(l => l.archetype !== undefined);
  const sharpFieldLineups = hasArchetypeData
    ? fieldLineups.filter(l => l.archetype && SHARP_ARCHETYPES.has(l.archetype))
    : [];

  if (hasArchetypeData) {
    console.log(`  Archetype-aware analysis: ${sharpFieldLineups.length} sharp field lineups tracked`);
  }

  // Count combos in pool
  // Sample large pools to prevent memory explosion (50K lineups × C(8,5) = 2.8M quint entries)
  const MAX_POOL_SAMPLE = 15000;
  const poolSample = poolLineups.length > MAX_POOL_SAMPLE
    ? poolLineups.filter((_, i) => i % Math.ceil(poolLineups.length / MAX_POOL_SAMPLE) === 0)
    : poolLineups;
  const poolSampleScale = poolLineups.length / poolSample.length;

  const MAX_FIELD_SAMPLE = 15000;
  const fieldSample = fieldLineups.length > MAX_FIELD_SAMPLE
    ? fieldLineups.filter((_, i) => i % Math.ceil(fieldLineups.length / MAX_FIELD_SAMPLE) === 0)
    : fieldLineups;
  const fieldSampleScale = fieldLineups.length / fieldSample.length;

  const poolPairs = new Map<string, number>();
  const poolTriples = new Map<string, number>();
  const poolQuads = new Map<string, number>();
  const poolQuints = new Map<string, number>();
  const poolSexts = new Map<string, number>();   // 6-man combos
  const poolSepts = new Map<string, number>();   // 7-man combos

  for (const lineup of poolSample) {
    const ids = lineup.players.map(p => p.id).sort();

    // 2-player combos
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key = `${ids[i]}|${ids[j]}`;
        poolPairs.set(key, (poolPairs.get(key) || 0) + 1);
      }
    }

    // 3-player combos
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        for (let k = j + 1; k < ids.length; k++) {
          const key = `${ids[i]}|${ids[j]}|${ids[k]}`;
          poolTriples.set(key, (poolTriples.get(key) || 0) + 1);
        }
      }
    }

    // 4-player combos
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        for (let k = j + 1; k < ids.length; k++) {
          for (let l = k + 1; l < ids.length; l++) {
            const key = `${ids[i]}|${ids[j]}|${ids[k]}|${ids[l]}`;
            poolQuads.set(key, (poolQuads.get(key) || 0) + 1);
          }
        }
      }
    }

    // 5-player combos (full count for accurate core detection)
    if (ids.length >= 5) {
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          for (let k = j + 1; k < ids.length; k++) {
            for (let l = k + 1; l < ids.length; l++) {
              for (let m = l + 1; m < ids.length; m++) {
                const key = `${ids[i]}|${ids[j]}|${ids[k]}|${ids[l]}|${ids[m]}`;
                poolQuints.set(key, (poolQuints.get(key) || 0) + 1);
              }
            }
          }
        }
      }
    }

    // 6-player combos - ONLY for small rosters (showdown) due to O(n^6) performance
    // For 8-player classic rosters, 6-man combos are too rare to be useful
    if (ids.length === 6) {  // Only exact 6-player rosters (showdown)
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          for (let k = j + 1; k < ids.length; k++) {
            for (let l = k + 1; l < ids.length; l++) {
              for (let m = l + 1; m < ids.length; m++) {
                for (let n = m + 1; n < ids.length; n++) {
                  const key = `${ids[i]}|${ids[j]}|${ids[k]}|${ids[l]}|${ids[m]}|${ids[n]}`;
                  poolSexts.set(key, (poolSexts.get(key) || 0) + 1);
                }
              }
            }
          }
        }
      }
    }

    // 7-player combos - SKIP for performance
    // 7-man combos in an 8-player roster means only 1 player differs
    // This is better detected by checking lineup similarity directly
    // Keeping the map empty - detection will be skipped
  }

  // Count combos in field (3, 4, 5, and conditionally 6-man) — uses sampled field
  const fieldTriples = new Map<string, number>();
  const fieldQuads = new Map<string, number>();
  const fieldQuints = new Map<string, number>();
  const fieldSexts = new Map<string, number>();
  const fieldSepts = new Map<string, number>();

  for (const lineup of fieldSample) {
    const ids = [...lineup.playerIds].sort();

    // 3-player combos
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        for (let k = j + 1; k < ids.length; k++) {
          const key = `${ids[i]}|${ids[j]}|${ids[k]}`;
          fieldTriples.set(key, (fieldTriples.get(key) || 0) + 1);
        }
      }
    }

    // 4-player combos
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        for (let k = j + 1; k < ids.length; k++) {
          for (let l = k + 1; l < ids.length; l++) {
            const key = `${ids[i]}|${ids[j]}|${ids[k]}|${ids[l]}`;
            fieldQuads.set(key, (fieldQuads.get(key) || 0) + 1);
          }
        }
      }
    }

    // 5-player combos
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        for (let k = j + 1; k < ids.length; k++) {
          for (let l = k + 1; l < ids.length; l++) {
            for (let m = l + 1; m < ids.length; m++) {
              const key = `${ids[i]}|${ids[j]}|${ids[k]}|${ids[l]}|${ids[m]}`;
              fieldQuints.set(key, (fieldQuints.get(key) || 0) + 1);
            }
          }
        }
      }
    }

    // 6-player combos - ONLY for small rosters (showdown) due to O(n^6) performance
    if (ids.length === 6) {  // Only exact 6-player rosters (showdown)
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          for (let k = j + 1; k < ids.length; k++) {
            for (let l = k + 1; l < ids.length; l++) {
              for (let m = l + 1; m < ids.length; m++) {
                for (let n = m + 1; n < ids.length; n++) {
                  const key = `${ids[i]}|${ids[j]}|${ids[k]}|${ids[l]}|${ids[m]}|${ids[n]}`;
                  fieldSexts.set(key, (fieldSexts.get(key) || 0) + 1);
                }
              }
            }
          }
        }
      }
    }

    // 7-player combos - SKIP for performance (see pool counting comment)
  }

  // E2: Count combos in sharp-tier field lineups (for archetype-aware scoring)
  const sharpTriples = new Map<string, number>();
  const sharpQuads = new Map<string, number>();
  const sharpQuints = new Map<string, number>();

  if (sharpFieldLineups.length >= 100) {
    for (const lineup of sharpFieldLineups) {
      const ids = [...lineup.playerIds].sort();

      // 3-player combos
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          for (let k = j + 1; k < ids.length; k++) {
            const key = `${ids[i]}|${ids[j]}|${ids[k]}`;
            sharpTriples.set(key, (sharpTriples.get(key) || 0) + 1);
          }
        }
      }

      // 4-player combos
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          for (let k = j + 1; k < ids.length; k++) {
            for (let l = k + 1; l < ids.length; l++) {
              const key = `${ids[i]}|${ids[j]}|${ids[k]}|${ids[l]}`;
              sharpQuads.set(key, (sharpQuads.get(key) || 0) + 1);
            }
          }
        }
      }

      // 5-player combos
      if (ids.length >= 5) {
        for (let i = 0; i < ids.length; i++) {
          for (let j = i + 1; j < ids.length; j++) {
            for (let k = j + 1; k < ids.length; k++) {
              for (let l = k + 1; l < ids.length; l++) {
                for (let m = l + 1; m < ids.length; m++) {
                  const key = `${ids[i]}|${ids[j]}|${ids[k]}|${ids[l]}|${ids[m]}`;
                  sharpQuints.set(key, (sharpQuints.get(key) || 0) + 1);
                }
              }
            }
          }
        }
      }
    }
  }

  // COMBINED ANALYSIS: Pool + Field = ALL lineups in the contest
  // We compete against BOTH our own pool AND the field, so treat them as one set
  // Use sample sizes for frequency computation (combo counts are from samples)
  const poolSize = poolSample.length;
  const fieldSize = fieldSample.length;
  const totalSize = poolSize + fieldSize;
  const maxProj = Math.max(...allPlayers.map(p => p.projection));

  // Detect if this is a small roster (showdown = 6 players)
  const avgRosterSize = poolLineups.length > 0
    ? poolLineups[0].players.length
    : 8;
  const isSmallRoster = avgRosterSize <= 6;

  // Dynamic slate size multiplier: adjusts thresholds based on number of games
  // Small slates → higher thresholds (harder to flag chalk, since overlap is natural)
  // Large slates → lower thresholds (easier to flag chalk, since combos should be more diverse)
  const slateSizeMultiplier = numGames <= 2 ? 2.0 : numGames <= 3 ? 1.5
    : numGames <= 4 ? 1.2 : numGames <= 5 ? 1.0
    : numGames <= 7 ? 0.80 : Math.max(0.60, 5 / numGames);

  // Helper to create core entry with COMBINED frequency analysis
  // Goal: Find combos that are RARE across pool+field but still project well
  const createCore = (key: string, poolCount: number, fieldCount: number, comboSize: number): DifferentiatedCore | null => {
    const poolFreq = poolCount / poolSize;
    const fieldFreq = fieldCount / fieldSize;

    // COMBINED frequency: how common is this combo across ALL lineups?
    const combinedCount = poolCount + fieldCount;
    const combinedFreq = combinedCount / totalSize;

    const playerIds = key.split('|');
    const players = playerIds.map(id => playerMap.get(id)).filter(Boolean) as Player[];

    if (players.length !== comboSize) return null;

    const avgProj = players.reduce((s, p) => s + p.projection, 0) / comboSize;
    const avgOwn = players.reduce((s, p) => s + (p.ownership || 20), 0) / comboSize;
    const projQuality = avgProj / maxProj;

    // Minimum projection quality threshold (must project decently)
    const minProjQuality = isSmallRoster ? 0.70 : 0.75;
    if (projQuality < minProjQuality) return null;

    // Minimum frequency to be worth tracking (very rare combos are noise)
    const baseMinCombinedFreq = isSmallRoster
      ? (comboSize === 3 ? 0.002 : comboSize === 4 ? 0.001 : 0.0005)
      : (comboSize === 3 ? 0.005 : comboSize === 4 ? 0.002 : 0.001);
    const minCombinedFreq = baseMinCombinedFreq / slateSizeMultiplier;
    if (combinedFreq < minCombinedFreq) return null;

    // UNIQUENESS SCORE: Lower combined frequency = more unique = BETTER
    // Inverted: we WANT rare combos, so score = 1 / frequency
    // But cap it so extremely rare combos don't dominate
    const uniquenessScore = Math.min(50, 1 / Math.max(combinedFreq, 0.001));

    // Deeper combos get multiplier (4-man = 1.5x, 5-man = 2.5x)
    // Deeper = more of the lineup is unique
    const depthMultiplier = comboSize === 3 ? 1.0 : comboSize === 4 ? 1.5 : 2.5;

    // FINAL SCORE: Projection quality × Uniqueness × Depth
    // High projection + Low frequency = Best combo
    let differentiationScore = projQuality * uniquenessScore * depthMultiplier;

    // Correlation weight: same-team/same-game cores get bonus for correlated upside
    const correlationBonus = calculateCorrelationWeight(players, 'bonus');
    differentiationScore *= correlationBonus;

    // E2: Archetype-aware adjustment — penalize combos that sharp money already found
    let sharpFreq = 0;
    if (hasArchetypeData && sharpFieldLineups.length >= 100) {
      const sharpSize = sharpFieldLineups.length;
      if (comboSize === 3) sharpFreq = (sharpTriples.get(key) || 0) / sharpSize;
      else if (comboSize === 4) sharpFreq = (sharpQuads.get(key) || 0) / sharpSize;
      else if (comboSize === 5) sharpFreq = (sharpQuints.get(key) || 0) / sharpSize;

      if (sharpFreq > fieldFreq * 1.2) {
        // Sharp money overweights this combo → less valuable differentiation
        const sharpOverweight = (sharpFreq / Math.max(0.001, fieldFreq)) - 1.0;
        differentiationScore *= (1 - Math.min(0.40, sharpOverweight * 0.30));
      } else if (sharpFreq < fieldFreq * 0.5 && fieldFreq > 0.005) {
        // Combo invisible to sharps → extra valuable
        differentiationScore *= 1.10;
      }
    }

    return {
      playerIds,
      playerNames: players.map(p => p.name),
      comboSize,
      poolFrequency: poolFreq,
      fieldFrequency: fieldFreq,
      frequencyGap: poolFreq - fieldFreq,  // Actual gap (positive = our edge)
      combinedFrequency: combinedFreq,     // Combined pool + field frequency
      avgProjection: avgProj,
      differentiationScore,
      correlationWeight: correlationBonus,
      sharpFieldFrequency: sharpFreq,
    };
  };

  // Find differentiated 3-man cores
  const cores3: DifferentiatedCore[] = [];
  for (const [key, poolCount] of poolTriples) {
    const fieldCount = fieldTriples.get(key) || 0;
    const core = createCore(key, poolCount, fieldCount, 3);
    if (core) cores3.push(core);
  }
  cores3.sort((a, b) => b.differentiationScore - a.differentiationScore);

  // Find differentiated 4-man cores
  const cores4: DifferentiatedCore[] = [];
  for (const [key, poolCount] of poolQuads) {
    const fieldCount = fieldQuads.get(key) || 0;
    const core = createCore(key, poolCount, fieldCount, 4);
    if (core) cores4.push(core);
  }
  cores4.sort((a, b) => b.differentiationScore - a.differentiationScore);

  // Find differentiated 5-man cores
  const cores5: DifferentiatedCore[] = [];
  for (const [key, poolCount] of poolQuints) {
    const fieldCount = fieldQuints.get(key) || 0;
    const core = createCore(key, poolCount, fieldCount, 5);
    if (core) cores5.push(core);
  }
  cores5.sort((a, b) => b.differentiationScore - a.differentiationScore);

  // Log results - now showing COMBINED frequency (pool + field)
  // Lower combined frequency = more unique = BETTER for GPP
  console.log(`  Found ${cores3.length} unique 3-man cores (low combined frequency, high projection)`);
  console.log(`  Found ${cores4.length} unique 4-man cores`);
  console.log(`  Found ${cores5.length} unique 5-man cores`);

  if (cores3.length > 0) {
    console.log(`  Top UNIQUE 3-man cores (rare but project well):`);
    for (const core of cores3.slice(0, 3)) {
      const gap = core.frequencyGap;
      console.log(`    ${core.playerNames.join(' + ')}: pool ${(core.poolFrequency * 100).toFixed(1)}% vs field ${(core.fieldFrequency * 100).toFixed(1)}% (gap ${gap >= 0 ? '+' : ''}${(gap * 100).toFixed(1)}%) | proj ${core.avgProjection.toFixed(1)}`);
    }
  }

  if (cores4.length > 0) {
    console.log(`  Top UNIQUE 4-man cores:`);
    for (const core of cores4.slice(0, 3)) {
      const gap = core.frequencyGap;
      console.log(`    ${core.playerNames.join(' + ')}: pool ${(core.poolFrequency * 100).toFixed(1)}% vs field ${(core.fieldFrequency * 100).toFixed(1)}% (gap ${gap >= 0 ? '+' : ''}${(gap * 100).toFixed(1)}%) | proj ${core.avgProjection.toFixed(1)}`);
    }
  }

  if (cores5.length > 0) {
    console.log(`  Top UNIQUE 5-man cores:`);
    for (const core of cores5.slice(0, 3)) {
      const gap = core.frequencyGap;
      console.log(`    ${core.playerNames.join(' + ')}: pool ${(core.poolFrequency * 100).toFixed(1)}% vs field ${(core.fieldFrequency * 100).toFixed(1)}% (gap ${gap >= 0 ? '+' : ''}${(gap * 100).toFixed(1)}%) | proj ${core.avgProjection.toFixed(1)}`);
    }
  }

  // Find CHALK CORES (high combined frequency across pool + field - should AVOID)
  // These are constructions that EVERYONE builds - high duplication risk
  const chalkCores3: DifferentiatedCore[] = [];
  const chalkThreshold = (isSmallRoster ? 0.05 : 0.08) * slateSizeMultiplier;  // Scaled by slate size

  for (const [key, poolCount] of poolTriples) {
    const fieldCount = fieldTriples.get(key) || 0;
    const combinedCount = poolCount + fieldCount;
    const combinedFreq = combinedCount / totalSize;

    if (combinedFreq >= chalkThreshold) {
      const playerIds = key.split('|');
      const players = playerIds.map(id => playerMap.get(id)).filter(Boolean) as Player[];

      if (players.length === 3) {
        const poolFreq = poolCount / poolSize;
        const fieldFreq = fieldCount / fieldSize;
        const correlationPenalty = calculateCorrelationWeight(players, 'penalty');
        chalkCores3.push({
          playerIds,
          playerNames: players.map(p => p.name),
          comboSize: 3,
          poolFrequency: poolFreq,
          fieldFrequency: fieldFreq,
          frequencyGap: poolFreq - fieldFreq,
          combinedFrequency: combinedFreq,
          avgProjection: players.reduce((s, p) => s + p.projection, 0) / 3,
          differentiationScore: combinedFreq * 100,  // Higher = more chalky (worse)
          correlationWeight: correlationPenalty,
        });
      }
    }
  }
  chalkCores3.sort((a, b) => b.differentiationScore - a.differentiationScore);

  if (chalkCores3.length > 0) {
    console.log(`  CHALK 3-man cores to AVOID (${chalkCores3.length} total):`);
    for (const core of chalkCores3.slice(0, 3)) {
      console.log(`    ${core.playerNames.join(' + ')}: ${(core.combinedFrequency * 100).toFixed(1)}% combined (pool ${(core.poolFrequency * 100).toFixed(1)}% + field ${(core.fieldFrequency * 100).toFixed(1)}%)`);
    }
  }

  // For backwards compatibility, keep the old variable names
  const fieldHeavyCores3 = chalkCores3;

  // Find UNIVERSALLY COMMON cores (overused in BOTH pool AND field)
  // These are the "chalk constructions" everyone builds - we want to AVOID them
  const universallyCommonCores3: DifferentiatedCore[] = [];
  const minCommonFreq = (isSmallRoster ? 0.02 : 0.03) * slateSizeMultiplier;  // Scaled by slate size

  for (const [key, poolCount] of poolTriples) {
    const poolFreq = poolCount / poolSize;
    const fieldCount = fieldTriples.get(key) || 0;
    const fieldFreq = fieldCount / fieldSize;

    // Combo is COMMON if it's high in BOTH pool AND field
    if (poolFreq >= minCommonFreq && fieldFreq >= minCommonFreq) {
      const playerIds = key.split('|');
      const players = playerIds.map(id => playerMap.get(id)).filter(Boolean) as Player[];

      if (players.length === 3) {
        // Combined frequency = geometric mean of pool and field frequency
        // Higher = more universally common = more chalk
        const combinedFreq = Math.sqrt(poolFreq * fieldFreq);
        const avgOwn = players.reduce((s, p) => s + (p.ownership || 20), 0) / 3;
        const correlationPenalty = calculateCorrelationWeight(players, 'penalty');

        universallyCommonCores3.push({
          playerIds,
          playerNames: players.map(p => p.name),
          comboSize: 3,
          poolFrequency: poolFreq,
          fieldFrequency: fieldFreq,
          frequencyGap: poolFreq - fieldFreq,
          combinedFrequency: combinedFreq,
          avgProjection: players.reduce((s, p) => s + p.projection, 0) / 3,
          differentiationScore: combinedFreq * (1 + avgOwn / 50) * 100,  // Higher ownership = worse
          correlationWeight: correlationPenalty,
        });
      }
    }
  }
  universallyCommonCores3.sort((a, b) => b.differentiationScore - a.differentiationScore);

  if (universallyCommonCores3.length > 0) {
    console.log(`  UNIVERSALLY COMMON 3-man cores: ${universallyCommonCores3.length}`);
    for (const core of universallyCommonCores3.slice(0, 3)) {
      console.log(`    ${core.playerNames.join(' + ')}: pool ${(core.poolFrequency * 100).toFixed(1)}% AND field ${(core.fieldFrequency * 100).toFixed(1)}%`);
    }
  }

  // Find UNIVERSALLY COMMON 4-man cores (half the lineup is chalk - need to substitute)
  const universallyCommonCores4: DifferentiatedCore[] = [];
  const minCommon4 = (isSmallRoster ? 0.01 : 0.02) * slateSizeMultiplier;  // Scaled by slate size

  for (const [key, poolCount] of poolQuads) {
    const poolFreq = poolCount / poolSize;
    const fieldCount = fieldQuads.get(key) || 0;
    const fieldFreq = fieldCount / fieldSize;

    if (poolFreq >= minCommon4 && fieldFreq >= minCommon4) {
      const playerIds = key.split('|');
      const players = playerIds.map(id => playerMap.get(id)).filter(Boolean) as Player[];

      if (players.length === 4) {
        const combinedFreq = Math.sqrt(poolFreq * fieldFreq);
        const avgOwn = players.reduce((s, p) => s + (p.ownership || 20), 0) / 4;
        const correlationPenalty = calculateCorrelationWeight(players, 'penalty');

        universallyCommonCores4.push({
          playerIds,
          playerNames: players.map(p => p.name),
          comboSize: 4,
          poolFrequency: poolFreq,
          fieldFrequency: fieldFreq,
          frequencyGap: poolFreq - fieldFreq,
          combinedFrequency: combinedFreq,
          avgProjection: players.reduce((s, p) => s + p.projection, 0) / 4,
          differentiationScore: combinedFreq * (1 + avgOwn / 50) * 100,
          correlationWeight: correlationPenalty,
        });
      }
    }
  }
  universallyCommonCores4.sort((a, b) => b.differentiationScore - a.differentiationScore);

  if (universallyCommonCores4.length > 0) {
    console.log(`  UNIVERSALLY COMMON 4-man cores: ${universallyCommonCores4.length}`);
    for (const core of universallyCommonCores4.slice(0, 3)) {
      console.log(`    ${core.playerNames.join(' + ')}: pool ${(core.poolFrequency * 100).toFixed(1)}% AND field ${(core.fieldFrequency * 100).toFixed(1)}%`);
    }
  }

  // Find UNIVERSALLY COMMON 5-man cores (these are more serious - 5/8 of lineup is chalk)
  const universallyCommonCores5: DifferentiatedCore[] = [];
  const minCommon5 = (isSmallRoster ? 0.005 : 0.01) * slateSizeMultiplier;  // Scaled by slate size

  for (const [key, poolCount] of poolQuints) {
    const poolFreq = poolCount / poolSize;
    const fieldCount = fieldQuints.get(key) || 0;
    const fieldFreq = fieldCount / fieldSize;

    if (poolFreq >= minCommon5 && fieldFreq >= minCommon5) {
      const playerIds = key.split('|');
      const players = playerIds.map(id => playerMap.get(id)).filter(Boolean) as Player[];

      if (players.length === 5) {
        const combinedFreq = Math.sqrt(poolFreq * fieldFreq);
        const avgOwn = players.reduce((s, p) => s + (p.ownership || 20), 0) / 5;
        const correlationPenalty = calculateCorrelationWeight(players, 'penalty');

        universallyCommonCores5.push({
          playerIds,
          playerNames: players.map(p => p.name),
          comboSize: 5,
          poolFrequency: poolFreq,
          fieldFrequency: fieldFreq,
          frequencyGap: poolFreq - fieldFreq,
          combinedFrequency: combinedFreq,
          avgProjection: players.reduce((s, p) => s + p.projection, 0) / 5,
          differentiationScore: combinedFreq * (1 + avgOwn / 50) * 100,
          correlationWeight: correlationPenalty,
        });
      }
    }
  }
  universallyCommonCores5.sort((a, b) => b.differentiationScore - a.differentiationScore);

  // Find UNIVERSALLY COMMON 6-man cores (very serious - 6/8 of lineup is chalk)
  const universallyCommonCores6: DifferentiatedCore[] = [];
  const minCommon6 = (isSmallRoster ? 0.005 : 0.01) * slateSizeMultiplier;  // Scaled by slate size

  for (const [key, poolCount] of poolSexts) {
    const poolFreq = poolCount / poolSize;
    const fieldCount = fieldSexts.get(key) || 0;
    const fieldFreq = fieldCount / fieldSize;

    if (poolFreq >= minCommon6 && fieldFreq >= minCommon6) {
      const playerIds = key.split('|');
      const players = playerIds.map(id => playerMap.get(id)).filter(Boolean) as Player[];

      if (players.length === 6) {
        const combinedFreq = Math.sqrt(poolFreq * fieldFreq);
        const avgOwn = players.reduce((s, p) => s + (p.ownership || 20), 0) / 6;
        const correlationPenalty = calculateCorrelationWeight(players, 'penalty');

        universallyCommonCores6.push({
          playerIds,
          playerNames: players.map(p => p.name),
          comboSize: 6,
          poolFrequency: poolFreq,
          fieldFrequency: fieldFreq,
          frequencyGap: poolFreq - fieldFreq,
          combinedFrequency: combinedFreq,
          avgProjection: players.reduce((s, p) => s + p.projection, 0) / 6,
          differentiationScore: combinedFreq * (1 + avgOwn / 50) * 100,
          correlationWeight: correlationPenalty,
        });
      }
    }
  }
  universallyCommonCores6.sort((a, b) => b.differentiationScore - a.differentiationScore);

  // Find UNIVERSALLY COMMON 7-man cores (almost entire lineup is chalk!)
  const universallyCommonCores7: DifferentiatedCore[] = [];
  const minCommon7 = (isSmallRoster ? 0.001 : 0.002) * slateSizeMultiplier;  // Scaled by slate size

  for (const [key, poolCount] of poolSepts) {
    const poolFreq = poolCount / poolSize;
    const fieldCount = fieldSepts.get(key) || 0;
    const fieldFreq = fieldCount / fieldSize;

    if (poolFreq >= minCommon7 && fieldFreq >= minCommon7) {
      const playerIds = key.split('|');
      const players = playerIds.map(id => playerMap.get(id)).filter(Boolean) as Player[];

      if (players.length === 7) {
        const combinedFreq = Math.sqrt(poolFreq * fieldFreq);
        const avgOwn = players.reduce((s, p) => s + (p.ownership || 20), 0) / 7;
        const correlationPenalty = calculateCorrelationWeight(players, 'penalty');

        universallyCommonCores7.push({
          playerIds,
          playerNames: players.map(p => p.name),
          comboSize: 7,
          poolFrequency: poolFreq,
          fieldFrequency: fieldFreq,
          frequencyGap: poolFreq - fieldFreq,
          combinedFrequency: combinedFreq,
          avgProjection: players.reduce((s, p) => s + p.projection, 0) / 7,
          differentiationScore: combinedFreq * (1 + avgOwn / 50) * 100,
          correlationWeight: correlationPenalty,
        });
      }
    }
  }
  universallyCommonCores7.sort((a, b) => b.differentiationScore - a.differentiationScore);

  // Log the chalk constructions we found
  const totalChalkCores = universallyCommonCores5.length + universallyCommonCores6.length + universallyCommonCores7.length;
  if (totalChalkCores > 0) {
    console.log(`  CHALK CONSTRUCTIONS TO REJECT:`);
    console.log(`    5-man chalk cores: ${universallyCommonCores5.length}`);
    console.log(`    6-man chalk cores: ${universallyCommonCores6.length}`);
    console.log(`    7-man chalk cores: ${universallyCommonCores7.length}`);

    if (universallyCommonCores5.length > 0) {
      const top = universallyCommonCores5[0];
      console.log(`    Worst 5-man: ${top.playerNames.join(' + ')}: pool ${(top.poolFrequency * 100).toFixed(2)}% AND field ${(top.fieldFrequency * 100).toFixed(2)}%`);
    }
    if (universallyCommonCores6.length > 0) {
      const top = universallyCommonCores6[0];
      console.log(`    Worst 6-man: ${top.playerNames.join(' + ')}: pool ${(top.poolFrequency * 100).toFixed(2)}% AND field ${(top.fieldFrequency * 100).toFixed(2)}%`);
    }
    if (universallyCommonCores7.length > 0) {
      const top = universallyCommonCores7[0];
      console.log(`    Worst 7-man: ${top.playerNames.join(' + ')}: pool ${(top.poolFrequency * 100).toFixed(3)}% AND field ${(top.fieldFrequency * 100).toFixed(3)}%`);
    }
  }

  // Combine all cores for backwards compatibility, keeping top from each size
  const differentiatedCores = [
    ...cores3.slice(0, 100),
    ...cores4.slice(0, 100),
    ...cores5.slice(0, 100),
  ].sort((a, b) => b.differentiationScore - a.differentiationScore);

  // E4: Cross-combo interaction detection
  // For top differentiated cores, find non-overlapping pairs and measure field co-occurrence
  const coreInteractions = new Map<string, number>();
  const topCoresForInteraction = [
    ...cores3.slice(0, 30),
    ...cores4.slice(0, 20),
    ...cores5.slice(0, 10),
  ];

  if (topCoresForInteraction.length >= 2) {
    // Build core→field presence index: which field lineups contain each core?
    const coreFieldPresence = new Map<string, Set<number>>();

    for (const core of topCoresForInteraction) {
      const coreKey = core.playerIds.join('|');
      const coreIdSet = new Set(core.playerIds);
      const presentIn = new Set<number>();

      for (let fi = 0; fi < fieldLineups.length; fi++) {
        const fieldIds = fieldLineups[fi].playerIds;
        if (coreIdSet.size <= fieldIds.length) {
          let allPresent = true;
          for (const id of coreIdSet) {
            if (!fieldIds.includes(id)) {
              allPresent = false;
              break;
            }
          }
          if (allPresent) presentIn.add(fi);
        }
      }
      coreFieldPresence.set(coreKey, presentIn);
    }

    // For each non-overlapping core pair, count co-occurrences via set intersection
    let pairsAnalyzed = 0;
    let rarePairs = 0;

    for (let a = 0; a < topCoresForInteraction.length; a++) {
      const coreA = topCoresForInteraction[a];
      const keyA = coreA.playerIds.join('|');
      const setA = coreFieldPresence.get(keyA);
      if (!setA) continue;
      const idsA = new Set(coreA.playerIds);

      for (let b = a + 1; b < topCoresForInteraction.length; b++) {
        const coreB = topCoresForInteraction[b];

        // Skip overlapping cores (share any players)
        let overlaps = false;
        for (const id of coreB.playerIds) {
          if (idsA.has(id)) { overlaps = true; break; }
        }
        if (overlaps) continue;

        const keyB = coreB.playerIds.join('|');
        const setB = coreFieldPresence.get(keyB);
        if (!setB) continue;

        // Count intersection (co-occurrences)
        let coCount = 0;
        const smaller = setA.size <= setB.size ? setA : setB;
        const larger = setA.size <= setB.size ? setB : setA;
        for (const idx of smaller) {
          if (larger.has(idx)) coCount++;
        }

        const coFreq = fieldSize > 0 ? coCount / fieldSize : 0;
        const interactionKey = `${keyA}||${keyB}`;
        coreInteractions.set(interactionKey, coFreq);
        pairsAnalyzed++;
        if (coFreq < 0.001) rarePairs++;
      }
    }

    console.log(`  Cross-combo interactions: ${pairsAnalyzed} pairs analyzed, ${rarePairs} rare (<0.1%)`);
  }

  return {
    pairs: poolPairs,
    triples: poolTriples,
    quads: poolQuads,
    quints: poolQuints,
    sexts: poolSexts,
    septs: poolSepts,
    cores3: cores3.slice(0, 150),
    cores4: cores4.slice(0, 150),
    cores5: cores5.slice(0, 150),
    fieldHeavyCores3: fieldHeavyCores3.slice(0, 100),
    universallyCommonCores3: universallyCommonCores3.slice(0, 100),
    universallyCommonCores4: universallyCommonCores4.slice(0, 75),
    universallyCommonCores5: universallyCommonCores5.slice(0, 50),
    universallyCommonCores6: universallyCommonCores6.slice(0, 50),
    universallyCommonCores7: universallyCommonCores7.slice(0, 50),
    coreInteractions,
    differentiatedCores: differentiatedCores.slice(0, 300),
  };
}

// ============================================================
// OWNERSHIP UNCERTAINTY & ROBUSTNESS
// ============================================================

/**
 * An ownership scenario: perturbed ownerships for all players.
 */
export interface OwnershipScenario {
  playerOwnerships: Map<string, number>;  // playerId → adjusted ownership %
  scenarioWeight: number;                  // How likely this scenario is (for weighted avg)
}

/**
 * Generate N ownership scenarios by sampling around projected ownership.
 *
 * Higher-owned players have larger absolute uncertainty but smaller relative uncertainty:
 * - High owned (>30%): std = ownership * 0.20 (±20% relative)
 * - Mid owned (10-30%): std = ownership * 0.30 (±30% relative)
 * - Low owned (<10%): std = ownership * 0.50 (±50% relative)
 *
 * Correlated perturbation: when one player goes up, others go down slightly
 * to maintain a reasonable total ownership.
 */
export function generateOwnershipScenarios(
  players: Player[],
  numScenarios: number = 20
): OwnershipScenario[] {
  const scenarios: OwnershipScenario[] = [];

  // Original total ownership for normalization
  const baseTotal = players.reduce((s, p) => s + Math.max(0.5, p.ownership), 0);

  // Build game/team structure for correlated perturbations
  const gameTeams = new Map<string, Set<string>>(); // gameId -> set of teams
  const playerGames = new Map<string, string>(); // playerId -> gameId
  for (const p of players) {
    const gameId = p.gameInfo || `${p.team}_game`;
    playerGames.set(p.id, gameId);
    if (!gameTeams.has(gameId)) gameTeams.set(gameId, new Set());
    gameTeams.get(gameId)!.add(p.team);
  }

  for (let s = 0; s < numScenarios; s++) {
    const ownerships = new Map<string, number>();
    let perturbedTotal = 0;

    // Generate correlated game-level shifts (injury news shifts entire game's players)
    const gameShifts = new Map<string, number>();
    for (const gameId of gameTeams.keys()) {
      const u1 = Math.random();
      const u2 = Math.random();
      const z = Math.sqrt(-2 * Math.log(Math.max(1e-10, u1))) * Math.cos(2 * Math.PI * u2);
      gameShifts.set(gameId, z * 0.15); // N(0, 0.15) — game-level shift
    }

    // Generate correlated team-level shifts (teammates shift together)
    const teamShifts = new Map<string, number>();
    const allTeams = new Set(players.map(p => p.team));
    for (const team of allTeams) {
      const u1 = Math.random();
      const u2 = Math.random();
      const z = Math.sqrt(-2 * Math.log(Math.max(1e-10, u1))) * Math.cos(2 * Math.PI * u2);
      teamShifts.set(team, z * 0.10); // N(0, 0.10) — team-level shift
    }

    // First pass: generate raw perturbed ownerships with correlated structure
    for (const p of players) {
      const own = Math.max(0.5, p.ownership);

      // Individual noise (scales inversely with ownership level)
      let relativeStd: number;
      if (own > 30) relativeStd = 0.15;  // Reduced from 0.20 (correlated shifts handle the rest)
      else if (own > 10) relativeStd = 0.25;
      else relativeStd = 0.40;

      const individualStd = own * relativeStd;
      const u1 = Math.random();
      const u2 = Math.random();
      const z = Math.sqrt(-2 * Math.log(Math.max(1e-10, u1))) * Math.cos(2 * Math.PI * u2);
      const individualNoise = z * individualStd / own; // Relative noise

      // Correlated shifts
      const gameId = playerGames.get(p.id) || '';
      const gameShift = gameShifts.get(gameId) || 0;
      const teamShift = teamShifts.get(p.team) || 0;

      // For MMA bouts: game shift represents bout attention (both fighters get more/less ownership),
      // but team shift already handles individual fighter shifts.
      // Detect MMA: team name contains space (fighter name) and game has exactly 2 teams
      const gameTeamSet = gameTeams.get(gameId);
      const isMMABout = gameTeamSet && gameTeamSet.size === 2 && p.team.includes(' ');
      // For MMA: halve game shift (bout-level attention shift is weaker than NBA game shifts)
      const effectiveGameShift = isMMABout ? gameShift * 0.5 : gameShift;

      // Combined: perturbed_own = own * (1 + gameShift + teamShift + individualNoise)
      const perturbed = Math.max(0.5, own * (1 + effectiveGameShift + teamShift + individualNoise));
      ownerships.set(p.id, perturbed);
      perturbedTotal += perturbed;
    }

    // Second pass: soft renormalize to keep total reasonable
    // Don't force exact match (real scenarios have total shifts), but prevent extreme drift
    if (perturbedTotal > 0) {
      const ratio = baseTotal / perturbedTotal;
      // Only normalize if drift is > 15%
      if (Math.abs(ratio - 1) > 0.15) {
        const softRatio = 1 + (ratio - 1) * 0.5; // Half-correct
        for (const [id, own] of ownerships) {
          ownerships.set(id, Math.max(0.5, own * softRatio));
        }
      }
    }

    scenarios.push({
      playerOwnerships: ownerships,
      scenarioWeight: 1.0 / numScenarios,
    });
  }

  return scenarios;
}

/**
 * Calculate how robust a lineup's leverage is across ownership scenarios.
 *
 * A lineup that's contrarian in ALL ownership scenarios scores high.
 * A lineup that's only contrarian under the base ownership but chalk under
 * alternative scenarios scores low.
 *
 * Returns 0-1 where 1 = perfectly robust leverage across all scenarios.
 */
export function calculateOwnershipRobustness(
  lineup: Lineup,
  scenarios: OwnershipScenario[],
  baselineOwnership: Map<string, number>  // Original ownership (player id → ownership %)
): number {
  if (scenarios.length === 0) return 0.5;

  const n = lineup.players.length;
  const leverageScores: number[] = [];

  for (const scenario of scenarios) {
    // Calculate geometric mean ownership under this scenario
    let logOwnershipSum = 0;
    for (const player of lineup.players) {
      const own = scenario.playerOwnerships.get(player.id) || player.ownership;
      logOwnershipSum += Math.log(Math.max(own / 100, 0.005));
    }
    const geoMean = Math.exp(logOwnershipSum / n) * 100;

    // Leverage score: lower geoMean ownership = more leveraged
    // Use convex scoring (same as ownershipScore) for consistency
    const linearScore = Math.max(0, Math.min(1, 1 - (geoMean / 100)));
    leverageScores.push(linearScore * linearScore);
  }

  // Robustness = mean leverage / max leverage
  // If mean ≈ max, leverage is consistent across scenarios (robust)
  // If mean << max, leverage is scenario-dependent (fragile)
  const meanLeverage = leverageScores.reduce((s, v) => s + v, 0) / leverageScores.length;
  const maxLeverage = Math.max(...leverageScores);

  if (maxLeverage <= 0) return 0;

  // Also factor in minimum leverage — truly robust lineups don't collapse in any scenario
  const minLeverage = Math.min(...leverageScores);
  const consistencyRatio = maxLeverage > 0 ? meanLeverage / maxLeverage : 0;
  const floorRatio = maxLeverage > 0 ? minLeverage / maxLeverage : 0;

  // Blend: 60% consistency + 40% floor protection
  return Math.min(1, consistencyRatio * 0.60 + floorRatio * 0.40);
}

// ============================================================
// PLAYER EDGE SCORE COMPUTATION (for two-pass generation)
// ============================================================

/**
 * Compute per-player edge scores using lightweight heuristics.
 *
 * Combines three signals to identify exploitable players without
 * generating a synthetic field or running expensive combo enumeration:
 *
 * 1. Projection edge (40%): ownership→projection regression — players where
 *    our projection exceeds the field-implied value have positive edge.
 * 2. Pool over-representation (30%): players appearing in the pool more
 *    often than their ownership implies are ones the optimizer likes.
 * 3. Ceiling ratio bonus (30%): players with high ceiling/projection ratio
 *    have boom potential valuable for GPP.
 */
export function computePlayerEdgeScores(
  poolLineups: Lineup[],
  allPlayers: Player[],
  _rosterSize: number
): PlayerEdgeScores {
  const playerMap = new Map<string, Player>();
  for (const p of allPlayers) playerMap.set(p.id, p);

  // --- Signal 1: Projection edge via ownership→projection regression ---
  const edgeAnalysis = analyzeProjectionEdge(allPlayers);

  // --- Signal 2: Pool over-representation ---
  // Count how often each player appears in pool lineups
  const poolAppearances = new Map<string, number>();
  for (const lineup of poolLineups) {
    for (const p of lineup.players) {
      poolAppearances.set(p.id, (poolAppearances.get(p.id) || 0) + 1);
    }
  }
  const totalSlots = poolLineups.length > 0 ? poolLineups.length : 1;

  // Expected frequency from ownership (normalized)
  const totalOwnership = allPlayers.reduce((s, p) => s + Math.max(0.5, p.ownership), 0);

  // Compute over-representation ratio for each player
  const overRepScores = new Map<string, number>();
  let maxOverRep = 0.001;
  for (const p of allPlayers) {
    const poolFreq = (poolAppearances.get(p.id) || 0) / totalSlots;
    const expectedFreq = Math.max(0.5, p.ownership) / totalOwnership;
    const overRep = poolFreq / Math.max(0.001, expectedFreq);
    overRepScores.set(p.id, overRep);
    if (overRep > maxOverRep) maxOverRep = overRep;
  }

  // --- Signal 3: Ceiling ratio bonus ---
  const ceilingRatios = new Map<string, number>();
  let avgCeilRatio = 0;
  let ceilCount = 0;
  for (const p of allPlayers) {
    if (p.projection > 0) {
      const ceil = p.ceiling || p.projection * 1.25;
      const ratio = ceil / p.projection;
      ceilingRatios.set(p.id, ratio);
      avgCeilRatio += ratio;
      ceilCount++;
    }
  }
  avgCeilRatio = ceilCount > 0 ? avgCeilRatio / ceilCount : 1.25;

  // --- Combine signals into edge score ---
  const edgeMap = new Map<string, { rawScore: number; gameId: string }>();
  let maxRaw = 0.001;

  for (const p of allPlayers) {
    // Signal 1: projection edge (0-1 normalized)
    const edgeData = edgeAnalysis.players.get(p.id);
    const projEdge = edgeData ? edgeData.normalizedEdge : 0.5;

    // Signal 2: pool over-representation (0-1 normalized)
    const overRep = (overRepScores.get(p.id) || 0) / maxOverRep;

    // Signal 3: ceiling ratio bonus (0-1 normalized, centered on avg)
    const ceilRatio = ceilingRatios.get(p.id) || avgCeilRatio;
    const ceilBonus = Math.max(0, Math.min(1, 0.5 + (ceilRatio - avgCeilRatio) / 0.3));

    // Combined: 40% projection edge + 30% pool over-rep + 30% ceiling
    const rawScore = projEdge * 0.40 + overRep * 0.30 + ceilBonus * 0.30;

    const gameId = p.gameInfo || `${p.team}_game`;
    edgeMap.set(p.id, { rawScore, gameId });
    if (rawScore > maxRaw) maxRaw = rawScore;
  }

  // Normalize to 0-1
  const players = new Map<string, PlayerEdgeInfo>();
  for (const [id, data] of edgeMap) {
    const poolCount = poolAppearances.get(id) || 0;
    players.set(id, {
      edgeScore: data.rawScore / maxRaw,
      coreCount: poolCount,  // repurposed: pool appearance count
      avgGap: 0,
      gameId: data.gameId,
    });
  }

  // Group by game for rotation
  const gameGroups = new Map<string, string[]>();
  for (const [id, info] of players) {
    const group = gameGroups.get(info.gameId) || [];
    group.push(id);
    gameGroups.set(info.gameId, group);
  }

  // Top edge players
  const topEdgePlayerIds = [...players.entries()]
    .sort((a, b) => b[1].edgeScore - a[1].edgeScore)
    .slice(0, 20)
    .map(([id]) => id);

  return { players, gameGroups, topEdgePlayerIds };
}

// ============================================================
// PRIMARY COMBO EXTRACTION
// ============================================================

/**
 * Extract the "primary combo" from a lineup — the 3-4 player group that
 * most defines the lineup's identity for leverage analysis.
 *
 * For team sports (NBA/NFL/MLB): the largest same-game cluster (team stack).
 * For non-team sports (MMA/golf/NASCAR): the 3 highest-ownership players.
 *
 * The primary combo is what the field is most likely to ALSO play. If
 * we share a primary combo with the field, we lose leverage even if
 * the remaining fill players are different.
 */
export interface PrimaryCombo {
  playerIds: string[];
  comboKey: string;    // sorted IDs joined with '|'
  type: 'team-stack' | 'game-stack' | 'ownership-cluster';
}

export function extractPrimaryCombo(
  lineup: Lineup | { players?: Array<{ id: string; ownership: number; gameInfo?: string; team?: string }>; playerIds?: string[] },
  playerLookup?: Map<string, Player> | Player[],
  sport?: string,
): PrimaryCombo {
  const isNonTeamSport = sport && ['mma', 'nascar', 'golf'].includes(sport);

  // Normalize to array of { id, ownership, gameInfo, team }
  let players: Array<{ id: string; ownership: number; gameInfo?: string; team?: string }>;

  if ('players' in lineup && lineup.players) {
    players = lineup.players.map(p => ({
      id: p.id,
      ownership: p.ownership || 0,
      gameInfo: (p as any).gameInfo,
      team: (p as any).team,
    }));
  } else if ('playerIds' in lineup && lineup.playerIds) {
    // Field lineup format — resolve from lookup
    const lookupMap = playerLookup instanceof Map
      ? playerLookup
      : Array.isArray(playerLookup)
        ? new Map(playerLookup.map(p => [p.id, p]))
        : new Map<string, Player>();

    players = lineup.playerIds.map(id => {
      const p = lookupMap.get(id);
      return {
        id,
        ownership: p?.ownership || 0,
        gameInfo: p?.gameInfo,
        team: p?.team,
      };
    });
  } else {
    // Fallback: empty
    return { playerIds: [], comboKey: '', type: 'ownership-cluster' };
  }

  // --- Non-team sports: top 3 by ownership ---
  if (isNonTeamSport || players.length <= 6) {
    const sorted = [...players].sort((a, b) => b.ownership - a.ownership);
    const top = sorted.slice(0, 3);
    const ids = top.map(p => p.id).sort();
    return { playerIds: ids, comboKey: ids.join('|'), type: 'ownership-cluster' };
  }

  // --- Team sports: find largest same-game cluster ---
  const gameGroups = new Map<string, typeof players>();
  for (const p of players) {
    const game = p.gameInfo || p.team || 'unknown';
    const group = gameGroups.get(game) || [];
    group.push(p);
    gameGroups.set(game, group);
  }

  // Find the largest game cluster
  let bestGame = '';
  let bestGroup: typeof players = [];
  for (const [game, group] of gameGroups) {
    if (group.length > bestGroup.length) {
      bestGame = game;
      bestGroup = group;
    } else if (group.length === bestGroup.length) {
      // Tiebreak: higher combined ownership (more chalk = more field overlap)
      const ownA = group.reduce((s, p) => s + p.ownership, 0);
      const ownB = bestGroup.reduce((s, p) => s + p.ownership, 0);
      if (ownA > ownB) {
        bestGame = game;
        bestGroup = group;
      }
    }
  }

  // If we have a game stack of 3+, use it (cap at 4 players)
  if (bestGroup.length >= 3) {
    // Take top 4 by ownership within the game stack
    const sorted = [...bestGroup].sort((a, b) => b.ownership - a.ownership);
    const combo = sorted.slice(0, 4);
    const ids = combo.map(p => p.id).sort();
    const type = bestGroup.some(p => {
      const team = p.team || '';
      return bestGroup.some(q => q.team && q.team !== team);
    }) ? 'game-stack' as const : 'team-stack' as const;
    return { playerIds: ids, comboKey: ids.join('|'), type };
  }

  // No game stack >= 3: fall back to top 4 by ownership (chalk cluster)
  const sorted = [...players].sort((a, b) => b.ownership - a.ownership);
  const top = sorted.slice(0, 4);
  const ids = top.map(p => p.id).sort();
  return { playerIds: ids, comboKey: ids.join('|'), type: 'ownership-cluster' };
}

/**
 * Look up a combo's frequency in ensemble-averaged maps.
 * Routes to the right map based on combo size.
 */
export function lookupEnsembleComboFreq(
  comboKey: string,
  comboSize: number,
  pairs: Map<string, number>,
  triples: Map<string, number>,
  quads: Map<string, number>,
): number {
  if (comboSize === 2) return pairs.get(comboKey) || 0;
  if (comboSize === 3) return triples.get(comboKey) || 0;
  if (comboSize === 4) return quads.get(comboKey) || 0;
  return 0;
}
