/**
 * V1-SigmaResidual — variance decorrelated from mean.
 *
 * σ_residual[c] = σ_sim[c] − E[σ | mean(c)]   (linear regression of σ on mean)
 *
 * Captures lineups with MORE variance than their mean predicts — independent
 * of projection rank. Fixes WinningCapability's failure mode where joint-p99
 * rank-percentile correlated with projection rank-percentile.
 *
 * EV = W_PROJ × projPct
 *    + W_LEV × (1 - ownPct)
 *    + W_SIGRES × sigmaResidualPct  [replaces V1's wVar × rangePct, slate-derived]
 *    + W_CMB × uniqPct
 *    + V1 structural priors
 */

import { Lineup, Player } from '../types';
import {
  TheoryV1Params,
  TheoryV1SelectionResult,
  scoreTheoryV1Candidates,
  selectFromScoredTheoryLineups,
} from './v1-selector';
import { LineupSimStats, rankPercentileFA, computeSlateDerivedWeight, residualize } from './v1-sim-stats';

export interface SigmaResidualResult extends TheoryV1SelectionResult {
  sigResWeight: number;
  residualMean: number;
  residualStd: number;
}

const W_SIGRES_BASE = 0.30;
const W_SIGRES_SCALE = 1.0;

export function selectSigmaResidualPortfolio(
  candidates: Lineup[],
  _players: Player[],
  targetCount: number,
  params: TheoryV1Params,
  simStats: LineupSimStats,
): SigmaResidualResult {
  if (candidates.length === 0) throw new Error('selectSigmaResidualPortfolio: empty candidate pool');

  // Decorrelate sigma from mean. Residual captures lineups with MORE variance
  // than their mean predicts. Pure "upside-density" signal.
  const sigRes = residualize(simStats.std, simStats.mean);
  const sigResPct = rankPercentileFA(sigRes);

  const { weight, anchorMean, anchorStd } = computeSlateDerivedWeight(
    sigRes, candidates, W_SIGRES_BASE, W_SIGRES_SCALE,
  );

  const scored = scoreTheoryV1Candidates(candidates, params);

  for (let i = 0; i < scored.length; i++) {
    const s = scored[i];
    let ev = params.wProj * s.projPct
      + params.wLev * (1 - s.ownPct)
      + weight * sigResPct[i]
      + params.wCmb * s.uniqPct
      + params.wStructure * s.structurePct
      + params.wStackField * s.stackFieldPct
      - params.wGameOverload * s.gameOverloadPct;

    if (s.ppdPct >= 1 - params.ppdTopPct) ev *= (1 - params.ppdPenalty);
    s.ev = ev;
  }

  const result = selectFromScoredTheoryLineups(scored, candidates.length, targetCount, params);
  return { ...result, sigResWeight: weight, residualMean: anchorMean, residualStd: anchorStd };
}
