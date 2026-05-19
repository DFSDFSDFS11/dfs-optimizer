/**
 * V1-StdDevMax — direct sim-σ score variant.
 *
 * Replaces V1's wVar (point-estimate range) term with W_STDDEV × sigmaPct
 * where sigma is the lineup's std-dev across t-copula sim worlds. Direct
 * implementation of "we want high std deviation lineups".
 *
 * EV = W_PROJ × projPct
 *    + W_LEV × (1 - ownPct)
 *    + W_STDDEV × sigmaPct          [replaces V1's wVar × rangePct, slate-derived]
 *    + W_CMB × uniqPct
 *    + V1 structural priors
 *
 * Tradeoff: σ correlates with mean (high-mean lineups have higher absolute σ),
 * so this is partially projection-anchored. V1-SigmaResidual addresses that
 * directly by residualizing.
 */

import { Lineup, Player } from '../types';
import {
  TheoryV1Params,
  TheoryV1SelectionResult,
  scoreTheoryV1Candidates,
  selectFromScoredTheoryLineups,
} from './v1-selector';
import { LineupSimStats, rankPercentileFA, computeSlateDerivedWeight } from './v1-sim-stats';

export interface StdDevMaxResult extends TheoryV1SelectionResult {
  stdDevWeight: number;
  sigmaMean: number;
  sigmaStd: number;
}

const W_STDDEV_BASE = 0.30;
const W_STDDEV_SCALE = 1.0;

export function selectStdDevMaxPortfolio(
  candidates: Lineup[],
  _players: Player[],
  targetCount: number,
  params: TheoryV1Params,
  simStats: LineupSimStats,
): StdDevMaxResult {
  if (candidates.length === 0) throw new Error('selectStdDevMaxPortfolio: empty candidate pool');

  const sigmaPct = rankPercentileFA(simStats.std);
  const { weight, anchorMean, anchorStd } = computeSlateDerivedWeight(
    simStats.std, candidates, W_STDDEV_BASE, W_STDDEV_SCALE,
  );

  const scored = scoreTheoryV1Candidates(candidates, params);

  // Replace wVar × rangePct × 0.85 with weight × sigmaPct.
  for (let i = 0; i < scored.length; i++) {
    const s = scored[i];
    let ev = params.wProj * s.projPct
      + params.wLev * (1 - s.ownPct)
      + weight * sigmaPct[i]                   // <-- new term replaces wVar × rangePct
      + params.wCmb * s.uniqPct
      + params.wStructure * s.structurePct
      + params.wStackField * s.stackFieldPct
      - params.wGameOverload * s.gameOverloadPct;

    if (s.ppdPct >= 1 - params.ppdTopPct) ev *= (1 - params.ppdPenalty);
    s.ev = ev;
  }

  const result = selectFromScoredTheoryLineups(scored, candidates.length, targetCount, params);
  return { ...result, stdDevWeight: weight, sigmaMean: anchorMean, sigmaStd: anchorStd };
}
