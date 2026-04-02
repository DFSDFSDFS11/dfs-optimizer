/**
 * DFS Optimizer CLI - Pool Analyzer
 *
 * Analyzes lineup pool to identify:
 * - High-value player combos (by projection)
 * - Chalk combos (overused in field)
 * - Leverage opportunities (high projection, low ownership)
 * - Team stacks and correlations
 */

import { Lineup, Player, PlayerCombo, PoolAnalysis } from '../types';

/**
 * Combo data with leverage scoring
 */
export interface ScoredCombo {
  key: string;
  playerIds: string[];
  playerNames: string[];
  frequency: number;      // How often in pool (0-1)
  avgProjection: number;  // Average projection when this combo appears
  avgOwnership: number;   // Average ownership of players
  leverage: number;       // High projection + low ownership = high leverage
  isStack: boolean;       // Same team?
}

/**
 * Enhanced combo frequency maps with leverage scoring
 */
export interface EnhancedComboMaps {
  twos: Map<string, ScoredCombo>;
  threes: Map<string, ScoredCombo>;
  topLeverageCombos: ScoredCombo[];  // Best leverage opportunities
  chalkCombos: ScoredCombo[];        // Most overused combos to fade
}

/**
 * Build enhanced combo maps with leverage analysis
 * Optimized for speed - samples large pools
 */
export function buildEnhancedComboMaps(lineups: Lineup[]): EnhancedComboMaps {
  // Sample if pool is very large (for speed)
  const sampleSize = Math.min(lineups.length, 5000);
  const sample = lineups.length <= sampleSize
    ? lineups
    : sampleLineups(lineups, sampleSize);

  const twoComboData = new Map<string, { count: number; projSum: number; ownSum: number; players: Player[]; isStack: boolean }>();
  const threeComboData = new Map<string, { count: number; projSum: number; ownSum: number; players: Player[]; isStack: boolean }>();

  for (const lineup of sample) {
    const players = lineup.players;
    const ids = players.map(p => p.id).sort();

    // 2-player combos
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const p1 = players[i], p2 = players[j];
        const key = [p1.id, p2.id].sort().join('|');
        const comboProj = p1.projection + p2.projection;
        const comboOwn = (p1.ownership + p2.ownership) / 2;
        const isStack = p1.team === p2.team;

        const existing = twoComboData.get(key);
        if (existing) {
          existing.count++;
          existing.projSum += comboProj;
          existing.ownSum += comboOwn;
        } else {
          twoComboData.set(key, {
            count: 1,
            projSum: comboProj,
            ownSum: comboOwn,
            players: [p1, p2],
            isStack,
          });
        }
      }
    }

    // 3-player combos (core stacks)
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        for (let k = j + 1; k < players.length; k++) {
          const p1 = players[i], p2 = players[j], p3 = players[k];
          const key = [p1.id, p2.id, p3.id].sort().join('|');
          const comboProj = p1.projection + p2.projection + p3.projection;
          const comboOwn = (p1.ownership + p2.ownership + p3.ownership) / 3;
          const isStack = p1.team === p2.team && p2.team === p3.team;

          const existing = threeComboData.get(key);
          if (existing) {
            existing.count++;
            existing.projSum += comboProj;
            existing.ownSum += comboOwn;
          } else {
            threeComboData.set(key, {
              count: 1,
              projSum: comboProj,
              ownSum: comboOwn,
              players: [p1, p2, p3],
              isStack,
            });
          }
        }
      }
    }
  }

  // Convert to scored combos
  const twos = new Map<string, ScoredCombo>();
  const threes = new Map<string, ScoredCombo>();

  for (const [key, data] of twoComboData) {
    const freq = data.count / sample.length;
    const avgProj = data.projSum / data.count;
    const avgOwn = data.ownSum / data.count;
    // Leverage = high projection value, low ownership, bonus for stacks
    const leverage = (avgProj / 100) * (1 - avgOwn / 100) * (data.isStack ? 1.2 : 1.0);

    twos.set(key, {
      key,
      playerIds: key.split('|'),
      playerNames: data.players.map(p => p.name),
      frequency: freq,
      avgProjection: avgProj,
      avgOwnership: avgOwn,
      leverage,
      isStack: data.isStack,
    });
  }

  for (const [key, data] of threeComboData) {
    const freq = data.count / sample.length;
    const avgProj = data.projSum / data.count;
    const avgOwn = data.ownSum / data.count;
    const leverage = (avgProj / 150) * (1 - avgOwn / 100) * (data.isStack ? 1.3 : 1.0);

    threes.set(key, {
      key,
      playerIds: key.split('|'),
      playerNames: data.players.map(p => p.name),
      frequency: freq,
      avgProjection: avgProj,
      avgOwnership: avgOwn,
      leverage,
      isStack: data.isStack,
    });
  }

  // Find top leverage combos (high projection, low ownership)
  const allCombos = [...twos.values(), ...threes.values()];
  allCombos.sort((a, b) => b.leverage - a.leverage);
  const topLeverageCombos = allCombos.slice(0, 50);

  // Find chalk combos (high frequency, high ownership)
  const chalkCombos = [...twos.values()]
    .filter(c => c.frequency > 0.1 && c.avgOwnership > 30)
    .sort((a, b) => (b.frequency * b.avgOwnership) - (a.frequency * a.avgOwnership))
    .slice(0, 30);

  return { twos, threes, topLeverageCombos, chalkCombos };
}

/**
 * Sample lineups evenly across projection range
 */
function sampleLineups(lineups: Lineup[], size: number): Lineup[] {
  // Sort by projection
  const sorted = [...lineups].sort((a, b) => b.projection - a.projection);
  const step = Math.floor(sorted.length / size);
  const sampled: Lineup[] = [];

  for (let i = 0; i < sorted.length && sampled.length < size; i += step) {
    sampled.push(sorted[i]);
  }

  return sampled;
}

/**
 * Calculate lineup leverage score based on combo analysis
 * Higher = more unique/contrarian lineup
 */
export function calculateLineupLeverage(
  lineup: Lineup,
  comboMaps: EnhancedComboMaps
): number {
  const players = lineup.players;
  let leverageSum = 0;
  let chalkPenalty = 0;
  let comboCount = 0;

  // Check 2-player combos
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const key = [players[i].id, players[j].id].sort().join('|');
      const combo = comboMaps.twos.get(key);

      if (combo) {
        leverageSum += combo.leverage;
        // Penalize very common combos
        if (combo.frequency > 0.2) {
          chalkPenalty += combo.frequency * 0.5;
        }
      }
      comboCount++;
    }
  }

  // Check 3-player combos (weighted more heavily)
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      for (let k = j + 1; k < players.length; k++) {
        const key = [players[i].id, players[j].id, players[k].id].sort().join('|');
        const combo = comboMaps.threes.get(key);

        if (combo) {
          leverageSum += combo.leverage * 1.5; // 3-player combos weighted more
          if (combo.frequency > 0.1) {
            chalkPenalty += combo.frequency * 0.3;
          }
        }
        comboCount++;
      }
    }
  }

  if (comboCount === 0) return 0.5;

  // Normalize and apply chalk penalty
  const rawLeverage = leverageSum / comboCount;
  return Math.max(0, Math.min(1, rawLeverage - chalkPenalty));
}

/**
 * Build simple combo frequency map (for backward compatibility)
 */
export function buildComboFrequencyMap(lineups: Lineup[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const lineup of lineups) {
    const players = lineup.players;
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const key = [players[i].id, players[j].id].sort().join('|');
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
  }

  const frequencies = new Map<string, number>();
  for (const [key, count] of counts) {
    frequencies.set(key, count / lineups.length);
  }

  return frequencies;
}

/**
 * Build combo frequency maps for 2, 3, 4-player combos
 */
export interface ComboFrequencyMaps {
  twos: Map<string, number>;
  threes: Map<string, number>;
  fours: Map<string, number>;
  fullLineups: Map<string, number>;
}

export function buildComboFrequencyMaps(lineups: Lineup[]): ComboFrequencyMaps {
  // Sample for speed on large pools
  const sampleSize = Math.min(lineups.length, 3000);
  const sample = lineups.length <= sampleSize
    ? lineups
    : sampleLineups(lineups, sampleSize);

  const twoCounts = new Map<string, number>();
  const threeCounts = new Map<string, number>();
  const fourCounts = new Map<string, number>();
  const fullCounts = new Map<string, number>();

  for (const lineup of sample) {
    const ids = lineup.players.map(p => p.id).sort();

    fullCounts.set(lineup.hash, (fullCounts.get(lineup.hash) || 0) + 1);

    // 2-player combos
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key = `${ids[i]}|${ids[j]}`;
        twoCounts.set(key, (twoCounts.get(key) || 0) + 1);
      }
    }

    // 3-player combos
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        for (let k = j + 1; k < ids.length; k++) {
          const key = `${ids[i]}|${ids[j]}|${ids[k]}`;
          threeCounts.set(key, (threeCounts.get(key) || 0) + 1);
        }
      }
    }

    // 4-player combos (sample only top combos for speed)
    if (sample.length <= 2000) {
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          for (let k = j + 1; k < ids.length; k++) {
            for (let l = k + 1; l < ids.length; l++) {
              const key = `${ids[i]}|${ids[j]}|${ids[k]}|${ids[l]}`;
              fourCounts.set(key, (fourCounts.get(key) || 0) + 1);
            }
          }
        }
      }
    }
  }

  const toFreq = (counts: Map<string, number>) => {
    const freq = new Map<string, number>();
    for (const [key, count] of counts) {
      freq.set(key, count / sample.length);
    }
    return freq;
  };

  return {
    twos: toFreq(twoCounts),
    threes: toFreq(threeCounts),
    fours: toFreq(fourCounts),
    fullLineups: toFreq(fullCounts),
  };
}

/**
 * Analyze player pool
 */
export function analyzePool(lineups: Lineup[]): PoolAnalysis {
  if (lineups.length === 0) {
    return {
      totalLineups: 0,
      maxProjection: 0,
      avgProjection: 0,
      minProjection: 0,
      playerExposures: new Map(),
      topCombos: [],
    };
  }

  const projections = lineups.map(l => l.projection);
  const maxProjection = Math.max(...projections);
  const minProjection = Math.min(...projections);
  const avgProjection = projections.reduce((a, b) => a + b, 0) / projections.length;

  // Calculate exposures
  const playerCounts = new Map<string, number>();
  for (const lineup of lineups) {
    for (const player of lineup.players) {
      playerCounts.set(player.id, (playerCounts.get(player.id) || 0) + 1);
    }
  }

  const playerExposures = new Map<string, number>();
  for (const [id, count] of playerCounts) {
    playerExposures.set(id, (count / lineups.length) * 100);
  }

  // Get top combos
  const comboCounts = new Map<string, { players: Player[]; count: number }>();
  for (const lineup of lineups.slice(0, 1000)) {
    const players = lineup.players;
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const key = [players[i].id, players[j].id].sort().join('|');
        const existing = comboCounts.get(key);
        if (existing) {
          existing.count++;
        } else {
          comboCounts.set(key, { players: [players[i], players[j]], count: 1 });
        }
      }
    }
  }

  const topCombos: PlayerCombo[] = Array.from(comboCounts.entries())
    .map(([key, data]) => ({
      playerIds: key.split('|'),
      count: data.count,
      frequency: data.count / Math.min(lineups.length, 1000),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  return {
    totalLineups: lineups.length,
    maxProjection,
    avgProjection,
    minProjection,
    playerExposures,
    topCombos,
  };
}
