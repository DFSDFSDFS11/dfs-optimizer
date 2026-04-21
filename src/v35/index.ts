/**
 * V35 — Sequential Portfolio Construction via Marginal Payout Maximization
 *
 * Entry point that wires together:
 *   1. World simulation (t-copula correlated player scores)
 *   2. Field sampling from SS pool
 *   3. Pre-computation of score matrices
 *   4. Greedy marginal payout optimization
 */

import { Lineup, Player, ContestConfig, DFSSite, Sport } from '../types';
import { generateWorlds } from './simulation';
import { sampleField } from './field-sampler';
import { precompute, optimize, V35OptimizerParams, V35Result } from './optimizer';
import { buildPayoutModel } from './payout';

export { generateWorlds } from './simulation';
export { sampleField } from './field-sampler';
export { buildPayoutModel } from './payout';
export { precompute, optimize } from './optimizer';
export type { V35OptimizerParams, V35Result } from './optimizer';

export interface V35RunParams {
  /** All players on the slate (from projections CSV) */
  players: Player[];
  /** Candidate lineups from SS pool */
  candidates: Lineup[];
  /** Full SS pool (field is sampled from this; may differ from candidates) */
  pool: Lineup[];
  /** Number of lineups to select */
  targetCount?: number;
  /** Number of simulation worlds */
  numWorlds?: number;
  /** Simulated field size */
  fieldSize?: number;
  /** Entry fee */
  entryFee?: number;
  /** Max single-player exposure */
  maxExposure?: number;
  /** Max team stack percentage */
  maxTeamStackPct?: number;
  /** RNG seed */
  seed?: number;
}

/**
 * Run the full V35 pipeline.
 */
export async function runV35(params: V35RunParams): Promise<V35Result> {
  const {
    players,
    candidates,
    pool,
    targetCount = 150,
    numWorlds = 5000,
    fieldSize = 13000,
    entryFee = 20,
    maxExposure = 0.40,
    maxTeamStackPct = 0.10,
    seed = 12345,
  } = params;

  console.log(`\n  V35 Pipeline Starting...`);
  console.log(`    Players: ${players.length}, Candidates: ${candidates.length}, Pool: ${pool.length}`);
  console.log(`    Worlds: ${numWorlds}, Field: ${fieldSize}, Target: ${targetCount}`);

  // Step 1: Build player index map
  const playerIndexMap = new Map<string, number>();
  for (let i = 0; i < players.length; i++) {
    playerIndexMap.set(players[i].id, i);
  }

  // Step 2: Simulate worlds
  console.log(`  Step 1: Generating ${numWorlds} worlds via t-copula...`);
  const t0 = Date.now();
  const sim = generateWorlds(players, numWorlds, 5, seed);
  console.log(`    Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Step 3: Sample field from pool
  console.log(`  Step 2: Sampling ${fieldSize} field lineups from pool...`);
  const fieldSample = sampleField(pool, fieldSize, seed + 1);

  // Step 4: Pre-compute score matrices
  console.log(`  Step 3: Pre-computing score matrices...`);
  const t1 = Date.now();
  const precompData = precompute(
    candidates, pool, fieldSample, sim, playerIndexMap, fieldSize, entryFee,
  );
  console.log(`    Done in ${((Date.now() - t1) / 1000).toFixed(1)}s`);

  // Step 5: Run optimizer
  console.log(`  Step 4: Running sequential marginal payout optimization...`);
  const result = optimize(candidates, precompData, {
    maxExposure,
    maxTeamStackPct,
    targetCount,
    coarseWorlds: Math.min(500, numWorlds),
    fineTopK: 200,
  });

  return result;
}
