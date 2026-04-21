/**
 * V35 Field Sampler — Sample field lineups from SaberSim pool.
 *
 * Weights lineups by projection^3 * ownership^0.5 to mimic a realistic
 * DK GPP field composition. Samples WITH replacement so chalk lineups
 * appear multiple times (realistic duplication).
 */

import { Lineup } from '../types';

// ============================================================
// RNG
// ============================================================

function createRng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================
// WALKER'S ALIAS METHOD for O(1) weighted sampling
// ============================================================

interface AliasTable {
  prob: Float64Array;
  alias: Int32Array;
  n: number;
}

function buildAliasTable(weights: number[]): AliasTable {
  const n = weights.length;
  const totalW = weights.reduce((s, w) => s + w, 0);
  const prob = new Float64Array(n);
  const alias = new Int32Array(n);

  // Normalize weights to sum to n
  const scaled = new Float64Array(n);
  for (let i = 0; i < n; i++) scaled[i] = (weights[i] / totalW) * n;

  const small: number[] = [];
  const large: number[] = [];
  for (let i = 0; i < n; i++) {
    if (scaled[i] < 1) small.push(i);
    else large.push(i);
  }

  while (small.length > 0 && large.length > 0) {
    const s = small.pop()!;
    const l = large.pop()!;
    prob[s] = scaled[s];
    alias[s] = l;
    scaled[l] = scaled[l] + scaled[s] - 1;
    if (scaled[l] < 1) small.push(l);
    else large.push(l);
  }

  // Remaining items get probability 1
  while (large.length > 0) prob[large.pop()!] = 1;
  while (small.length > 0) prob[small.pop()!] = 1;

  return { prob, alias, n };
}

function sampleAlias(table: AliasTable, rng: () => number): number {
  const i = Math.floor(rng() * table.n);
  return rng() < table.prob[i] ? i : table.alias[i];
}

// ============================================================
// MAIN: Sample field from SS pool
// ============================================================

export interface FieldSample {
  /** Indices into the source pool for each sampled lineup */
  indices: Int32Array;
  /** Number of field lineups */
  size: number;
}

/**
 * Sample field lineups from the SS pool with weighted replacement.
 *
 * @param pool - SS pool lineups
 * @param fieldSize - Number of field lineups to sample (default 8000)
 * @param seed - RNG seed
 * @returns Sampled field as indices into the pool
 */
export function sampleField(
  pool: Lineup[],
  fieldSize: number = 13000,
  seed: number = 42,
): FieldSample {
  const rng = createRng(seed);
  const n = pool.length;

  // Compute weights: projection^3 * avgOwnership^0.5
  const weights: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const lu = pool[i];
    const proj = lu.projection || 1;
    const avgOwn = lu.ownership || 1; // Already averaged in loadPoolFromCSV
    weights[i] = Math.pow(proj, 3) * Math.pow(Math.max(avgOwn, 0.1), 0.5);
  }

  // Build alias table for O(1) sampling
  const table = buildAliasTable(weights);

  // Sample with replacement
  const indices = new Int32Array(fieldSize);
  for (let i = 0; i < fieldSize; i++) {
    indices[i] = sampleAlias(table, rng);
  }

  return { indices, size: fieldSize };
}
