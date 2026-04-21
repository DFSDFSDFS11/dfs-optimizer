/**
 * λ-Sweep Portfolio Construction — Haugh-Singal Algorithm 7.
 *
 * Constructs a portfolio across multiple λ values on the mean-variance-covPenalty
 * frontier. Each λ controls the tradeoff between projection (low λ) and
 * variance-seeking (high λ):
 *
 *   obj(c) = projection[c] + λ × (variance[c] - 2 × covPenalty[c])
 *
 * Uses precomp's scalar per-candidate metrics (NOT the full PxP covariance
 * matrix), so BQP reduces to O(C) scoring per entry pick.
 *
 * Hard constraints:
 *   • γ = rosterSize - 3 overlap (Haugh-Singal Theorem 1)
 *   • maxExposure per player across the ENTIRE portfolio (not per-λ family)
 *   • No exact duplicate lineups
 */

import { Lineup } from '../types';
import { SlatePrecomputation } from './algorithm7-selector';

// ============================================================
// TYPES
// ============================================================

export interface LambdaSweepParams {
  lambdaGrid: number[];           // e.g. [0.3, 0.6, 1.0, 1.5, 2.2, 3.0]
  entriesPerLambda: number[];     // e.g. [15, 20, 25, 30, 30, 30] = 150 total
  maxOverlap: number;             // γ = rosterSize - 3 (e.g. 7 for MLB-10)
  maxExposure: number;            // 0.30 = 30%
}

export interface LambdaSweepDiagnostics {
  entriesPerLambda: Map<number, number>;
  meanByLambda: Map<number, number>;
  varianceByLambda: Map<number, number>;
  covPenaltyByLambda: Map<number, number>;
  objectiveByLambda: Map<number, number>;
  overlapRelaxations: number;
  totalSelected: number;
  selectionTimeMs: number;
}

export interface LambdaSweepResult {
  selected: Lineup[];
  selectedByLambda: Map<number, Lineup[]>;
  diagnostics: LambdaSweepDiagnostics;
}

// ============================================================
// MAIN
// ============================================================

export function lambdaSweepSelect(
  precomp: SlatePrecomputation,
  params: LambdaSweepParams,
): LambdaSweepResult {
  const t0 = Date.now();
  const {
    C, W,
    candidatePool,
    candidateProjection,
    candidateVariance,
    candidateCovPenalty,
    lambdaScale,
  } = precomp;
  const { lambdaGrid, entriesPerLambda, maxOverlap, maxExposure } = params;
  const totalTarget = entriesPerLambda.reduce((a, b) => a + b, 0);

  const selected: Lineup[] = [];
  const selectedByLambda = new Map<number, Lineup[]>();
  const selectedHashes = new Set<string>();

  // Player exposure tracking — cap against TOTAL target, not current count
  const playerCount = new Map<string, number>();
  const exposureCap = Math.ceil(maxExposure * totalTarget);
  const incrementExposure = (lu: Lineup) => {
    for (const p of lu.players) playerCount.set(p.id, (playerCount.get(p.id) || 0) + 1);
  };
  const exceedsExposure = (lu: Lineup): boolean => {
    for (const p of lu.players) {
      if ((playerCount.get(p.id) || 0) >= exposureCap) return true;
    }
    return false;
  };

  // Overlap check: does candidate share more than maxOverlap players with ANY selected?
  const violatesOverlap = (candidate: Lineup, currentMaxOverlap: number): boolean => {
    const cIds = new Set(candidate.players.map(p => p.id));
    for (const prev of selected) {
      let shared = 0;
      for (const p of prev.players) if (cIds.has(p.id)) shared++;
      if (shared > currentMaxOverlap) return true;
    }
    return false;
  };

  let overlapRelaxations = 0;
  let currentMaxOverlap = maxOverlap;
  const rosterSize = candidatePool[0]?.players.length ?? 10;

  // Diagnostics accumulators
  const diagMean = new Map<number, number[]>();
  const diagVar = new Map<number, number[]>();
  const diagCov = new Map<number, number[]>();
  const diagObj = new Map<number, number[]>();

  for (let li = 0; li < lambdaGrid.length; li++) {
    const lambda = lambdaGrid[li];
    const count = entriesPerLambda[li];
    const family: Lineup[] = [];
    diagMean.set(lambda, []);
    diagVar.set(lambda, []);
    diagCov.set(lambda, []);
    diagObj.set(lambda, []);

    // Score all candidates under this λ
    const scores = new Float64Array(C);
    for (let c = 0; c < C; c++) {
      const proj = candidateProjection[c];
      const adjVar = candidateVariance[c] - 2 * candidateCovPenalty[c];
      scores[c] = proj + lambda * lambdaScale * adjVar;
    }

    // Sort candidates by score descending for efficient traversal
    const sortedIdx = Array.from({ length: C }, (_, i) => i)
      .sort((a, b) => scores[b] - scores[a]);

    for (let j = 0; j < count; j++) {
      let picked = false;

      for (const cIdx of sortedIdx) {
        const lu = candidatePool[cIdx];
        if (selectedHashes.has(lu.hash)) continue;
        if (exceedsExposure(lu)) continue;
        if (violatesOverlap(lu, currentMaxOverlap)) continue;

        // Accept
        selected.push(lu);
        family.push(lu);
        selectedHashes.add(lu.hash);
        incrementExposure(lu);

        diagMean.get(lambda)!.push(candidateProjection[cIdx]);
        diagVar.get(lambda)!.push(candidateVariance[cIdx]);
        diagCov.get(lambda)!.push(candidateCovPenalty[cIdx]);
        diagObj.get(lambda)!.push(scores[cIdx]);
        picked = true;
        break;
      }

      if (!picked) {
        currentMaxOverlap++;
        overlapRelaxations++;
        j--;
        if (currentMaxOverlap > rosterSize) {
          // Fully relaxed — no possible entry even with no overlap constraint.
          // Last λ family: break. Earlier families: move on so later λ values get a chance.
          if (li === lambdaGrid.length - 1) {
            break;
          } else {
            console.log(`    λ=${lambda}: exhausted at ${family.length} entries, moving on`);
            break;
          }
        }
      }
    }

    selectedByLambda.set(lambda, family);

    // If this family didn't fill, carry remainder to next λ
    const shortfall = count - family.length;
    if (shortfall > 0 && li + 1 < lambdaGrid.length) {
      entriesPerLambda[li + 1] += shortfall;
    }
  }

  // Print summary
  const avgFn = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  console.log(`\n  λ-sweep results (${selected.length}/${totalTarget} entries):`);
  for (const lambda of lambdaGrid) {
    const f = selectedByLambda.get(lambda) || [];
    const m = avgFn(diagMean.get(lambda)!);
    const v = avgFn(diagVar.get(lambda)!);
    console.log(`    λ=${lambda.toFixed(1)}: ${f.length} entries, avgProj=${m.toFixed(1)}, avgVar=${v.toFixed(0)}`);
  }
  console.log(`    overlap relaxations: ${overlapRelaxations}`);

  // Build diagnostics
  const diagnostics: LambdaSweepDiagnostics = {
    entriesPerLambda: new Map(lambdaGrid.map((l, i) => [l, (selectedByLambda.get(l) || []).length])),
    meanByLambda: new Map(lambdaGrid.map(l => [l, avgFn(diagMean.get(l)!)])),
    varianceByLambda: new Map(lambdaGrid.map(l => [l, avgFn(diagVar.get(l)!)])),
    covPenaltyByLambda: new Map(lambdaGrid.map(l => [l, avgFn(diagCov.get(l)!)])),
    objectiveByLambda: new Map(lambdaGrid.map(l => [l, avgFn(diagObj.get(l)!)])),
    overlapRelaxations,
    totalSelected: selected.length,
    selectionTimeMs: Date.now() - t0,
  };

  return { selected, selectedByLambda, diagnostics };
}
