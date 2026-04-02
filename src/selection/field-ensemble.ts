/**
 * DFS Optimizer CLI — Multi-Field Ensemble Generation
 *
 * Generates N independent synthetic field samples with different compositions
 * (fish-heavy, standard, sharp-heavy, etc.) and computes ENSEMBLE-AVERAGED
 * combo frequencies. This makes leverage estimates robust across plausible
 * field compositions instead of brittle to one sample's noise.
 *
 * A combo is only flagged as "chalk" if it's high-frequency in a MAJORITY
 * of samples — prevents over-reacting to sampling variance in one draw.
 */

import { Player, ContestSize } from '../types';
import { FieldLineup, ExpandedFieldConfig, generateFieldPool } from './simulation/tournament-sim';
import { analyzeFieldCombos, FieldComboAnalysis, extractPrimaryCombo } from './scoring/field-analysis';

// ============================================================
// TYPES
// ============================================================

export interface FieldSample {
  name: string;
  lineups: FieldLineup[];
  combos: FieldComboAnalysis;
  weight: number;
  primaryCombos: Map<string, number>;  // primary combo key → frequency in this sample
}

export interface FieldEnsemble {
  samples: FieldSample[];
  combinedPairs: Map<string, number>;
  combinedTriples: Map<string, number>;
  combinedQuads: Map<string, number>;
  combinedPrimaryCombos: Map<string, number>;
  chalkTriples: Set<string>;       // freq > 8% in majority of samples
  chalkQuads: Set<string>;         // freq > 3% in majority of samples
  chalkPrimaryCombos: string[];    // top 30 primary combos by combined freq
  totalFieldLineups: number;
}

// ============================================================
// SAMPLE CONFIGURATIONS
// ============================================================

interface SampleConfig {
  name: string;
  size: number;
  chalkMult: number;
  sharpMult: number;
  casualMult: number;
  contrarianMult: number;
  stackerMult: number;
  optimizerMult: number;
}

const SAMPLE_CONFIGS: SampleConfig[] = [
  {
    name: 'fish-heavy',
    size: 5000,
    chalkMult: 1.6,
    sharpMult: 0.3,
    casualMult: 2.5,
    contrarianMult: 0.5,
    stackerMult: 0.8,
    optimizerMult: 0.5,
  },
  {
    name: 'standard',
    size: 5000,
    chalkMult: 1.0,
    sharpMult: 1.0,
    casualMult: 1.0,
    contrarianMult: 1.0,
    stackerMult: 1.0,
    optimizerMult: 1.0,
  },
  {
    name: 'sharp-heavy',
    size: 5000,
    chalkMult: 0.5,
    sharpMult: 2.0,
    casualMult: 0.3,
    contrarianMult: 1.2,
    stackerMult: 1.3,
    optimizerMult: 1.5,
  },
  {
    name: 'chalk-concentrated',
    size: 3000,
    chalkMult: 2.0,
    sharpMult: 0.5,
    casualMult: 0.5,
    contrarianMult: 0.3,
    stackerMult: 0.6,
    optimizerMult: 0.8,
  },
  {
    name: 'random-heavy',
    size: 3000,
    chalkMult: 0.3,
    sharpMult: 0.2,
    casualMult: 3.0,
    contrarianMult: 0.8,
    stackerMult: 0.5,
    optimizerMult: 0.3,
  },
];

/** Ensemble weights by contest type — higher weight for the most likely field composition */
const ENSEMBLE_WEIGHTS: Record<ContestSize, number[]> = {
  '150max': [0.45, 0.30, 0.15, 0.05, 0.05],
  '20max':  [0.20, 0.45, 0.25, 0.05, 0.05],
  '3max':   [0.15, 0.30, 0.40, 0.10, 0.05],
  'single': [0.10, 0.25, 0.50, 0.10, 0.05],
};

// ============================================================
// BASE CONFIG (derived from getFieldEnvironments defaults for 20max)
// ============================================================

const BASE_CONFIG: ExpandedFieldConfig = {
  pureChalk: 0.19,
  semiChalk: 0.11,
  stackChalk: 0.08,
  projectionOptimizer: 0.054,
  leverageOptimizer: 0.036,
  ceilingOptimizer: 0.030,
  casual: 0.12,
  contrarian: 0.08,
  sharpOptimizer: 0.18,
  stackBuilder: 0.12,
};

// ============================================================
// MAIN FUNCTION
// ============================================================

export function generateFieldEnsemble(
  players: Player[],
  rosterSize: number,
  contestSize: ContestSize = '20max',
  numSamples: number = 3,
  salaryCap: number = 50000,
  sport?: string,
): FieldEnsemble {
  const clampedSamples = Math.max(3, Math.min(5, numSamples));
  const configs = SAMPLE_CONFIGS.slice(0, clampedSamples);
  const rawWeights = ENSEMBLE_WEIGHTS[contestSize].slice(0, clampedSamples);

  // Normalize weights to sum to 1
  const weightSum = rawWeights.reduce((s, w) => s + w, 0);
  const weights = rawWeights.map(w => w / weightSum);

  const startTime = Date.now();
  const samples: FieldSample[] = [];
  let totalFieldLineups = 0;

  // Build player lookup for primary combo extraction
  const playerMap = new Map<string, Player>();
  for (const p of players) playerMap.set(p.id, p);

  for (let si = 0; si < configs.length; si++) {
    const cfg = configs[si];

    // Build ExpandedFieldConfig with multipliers applied
    const expandedConfig = buildSampleConfig(cfg);

    // Generate field with unique seed per sample
    const seed = 42 + si * 7919;  // Different prime offsets for independence
    const fieldLineups = generateFieldPool(
      players, rosterSize, cfg.size, seed, undefined, expandedConfig, undefined, undefined, salaryCap,
    );

    // Analyze combo frequencies for this sample
    const combos = analyzeFieldCombos(fieldLineups, false);

    // Extract primary combos for all field lineups
    const primaryComboCounts = new Map<string, number>();
    for (const fl of fieldLineups) {
      const pc = extractPrimaryCombo(fl, playerMap, sport);
      if (pc.comboKey) {
        primaryComboCounts.set(pc.comboKey, (primaryComboCounts.get(pc.comboKey) || 0) + 1);
      }
    }
    // Convert to frequencies
    const primaryCombos = new Map<string, number>();
    for (const [key, count] of primaryComboCounts) {
      primaryCombos.set(key, count / fieldLineups.length);
    }

    samples.push({
      name: cfg.name,
      lineups: fieldLineups,
      combos,
      weight: weights[si],
      primaryCombos,
    });
    totalFieldLineups += fieldLineups.length;
  }

  // --- Compute weighted averages across samples ---
  const combinedPairs = averageFreqMaps(samples.map(s => s.combos.pairs), weights);
  const combinedTriples = averageFreqMaps(samples.map(s => s.combos.triples), weights);
  const combinedQuads = averageFreqMaps(samples.map(s => s.combos.quads), weights);
  const combinedPrimaryCombos = averageFreqMaps(samples.map(s => s.primaryCombos), weights);

  // --- Chalk flagging with majority vote ---
  const TRIPLE_CHALK_THRESHOLD = 0.08;
  const QUAD_CHALK_THRESHOLD = 0.03;
  const majorityCount = Math.ceil(clampedSamples / 2);

  const chalkTriples = flagChalkCombos(
    samples.map(s => s.combos.triples), TRIPLE_CHALK_THRESHOLD, majorityCount,
  );
  const chalkQuads = flagChalkCombos(
    samples.map(s => s.combos.quads), QUAD_CHALK_THRESHOLD, majorityCount,
  );

  // --- Top chalk primary combos ---
  const chalkPrimaryCombos = [...combinedPrimaryCombos.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([key]) => key);

  const elapsed = Date.now() - startTime;
  console.log(`  Field ensemble generated: ${clampedSamples} samples, ${totalFieldLineups.toLocaleString()} lineups in ${(elapsed / 1000).toFixed(1)}s`);
  console.log(`    Samples: ${samples.map(s => `${s.name}(${s.lineups.length}, w=${s.weight.toFixed(2)})`).join(', ')}`);
  console.log(`    Chalk triples: ${chalkTriples.size}, chalk quads: ${chalkQuads.size}, chalk primary combos: ${chalkPrimaryCombos.length}`);

  return {
    samples,
    combinedPairs,
    combinedTriples,
    combinedQuads,
    combinedPrimaryCombos,
    chalkTriples,
    chalkQuads,
    chalkPrimaryCombos,
    totalFieldLineups,
  };
}

// ============================================================
// HELPERS
// ============================================================

function buildSampleConfig(cfg: SampleConfig): ExpandedFieldConfig {
  const raw: ExpandedFieldConfig = {
    pureChalk: BASE_CONFIG.pureChalk * cfg.chalkMult,
    semiChalk: BASE_CONFIG.semiChalk * cfg.chalkMult,
    stackChalk: BASE_CONFIG.stackChalk * cfg.chalkMult,
    projectionOptimizer: BASE_CONFIG.projectionOptimizer * cfg.optimizerMult,
    leverageOptimizer: BASE_CONFIG.leverageOptimizer * cfg.optimizerMult,
    ceilingOptimizer: BASE_CONFIG.ceilingOptimizer * cfg.optimizerMult,
    casual: BASE_CONFIG.casual * cfg.casualMult,
    contrarian: BASE_CONFIG.contrarian * cfg.contrarianMult,
    sharpOptimizer: BASE_CONFIG.sharpOptimizer * cfg.sharpMult,
    stackBuilder: BASE_CONFIG.stackBuilder * cfg.stackerMult,
  };

  // Normalize to sum to 1.0
  const total = raw.pureChalk + raw.semiChalk + raw.stackChalk +
    raw.projectionOptimizer + raw.leverageOptimizer + raw.ceilingOptimizer +
    raw.casual + raw.contrarian + raw.sharpOptimizer + raw.stackBuilder;

  return {
    pureChalk: raw.pureChalk / total,
    semiChalk: raw.semiChalk / total,
    stackChalk: raw.stackChalk / total,
    projectionOptimizer: raw.projectionOptimizer / total,
    leverageOptimizer: raw.leverageOptimizer / total,
    ceilingOptimizer: raw.ceilingOptimizer / total,
    casual: raw.casual / total,
    contrarian: raw.contrarian / total,
    sharpOptimizer: raw.sharpOptimizer / total,
    stackBuilder: raw.stackBuilder / total,
  };
}

/**
 * Compute weighted average across N frequency maps.
 * For each key present in any map, result[key] = sum(map[i].get(key) * weight[i]).
 */
function averageFreqMaps(
  maps: Map<string, number>[],
  weights: number[],
): Map<string, number> {
  const result = new Map<string, number>();

  for (let i = 0; i < maps.length; i++) {
    const w = weights[i];
    for (const [key, freq] of maps[i]) {
      result.set(key, (result.get(key) || 0) + freq * w);
    }
  }

  return result;
}

/**
 * Flag combos as "chalk" only if they exceed the threshold in a majority of samples.
 * This prevents over-reacting to one sample's noise.
 */
function flagChalkCombos(
  sampleMaps: Map<string, number>[],
  threshold: number,
  majorityCount: number,
): Set<string> {
  // Collect all combo keys that appear in any sample
  const keyCounts = new Map<string, number>();

  for (const map of sampleMaps) {
    for (const [key, freq] of map) {
      if (freq >= threshold) {
        keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
      }
    }
  }

  const result = new Set<string>();
  for (const [key, count] of keyCounts) {
    if (count >= majorityCount) {
      result.add(key);
    }
  }

  return result;
}
