/**
 * V1-SimEnsemble — multi-stat ensemble from one t-copula sim.
 *
 * Extracts FOUR independent signals from the sim by residualizing each stat
 * on the sim mean (decorrelates from projection):
 *
 *   sigma_res    = σ      − E[σ      | mean]    (variance above expected)
 *   p99_res      = p99    − E[p99    | mean]    (extreme tail above expected)
 *   p25_res_neg  = −(p25  − E[p25    | mean])   (downside resistance: high p25 vs mean)
 *   skew_res     = skew   − E[skew   | mean]    (right-skew lottery profile)
 *
 * Ensemble score = mean of the four rank-percentiles. Captures "independent
 * upside signal" while limiting reliance on any single estimator.
 *
 * EV = W_PROJ × projPct
 *    + W_LEV × (1 - ownPct)
 *    + W_ENS × ensemblePct          [replaces V1's wVar × rangePct, slate-derived]
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

export interface SimEnsembleResult extends TheoryV1SelectionResult {
  ensembleWeight: number;
  ensembleAnchorMean: number;
  ensembleAnchorStd: number;
}

const W_ENS_BASE = 0.40;          // slightly higher base — ensemble is a stronger composite
const W_ENS_SCALE = 1.0;

export function selectSimEnsemblePortfolio(
  candidates: Lineup[],
  _players: Player[],
  targetCount: number,
  params: TheoryV1Params,
  simStats: LineupSimStats,
): SimEnsembleResult {
  if (candidates.length === 0) throw new Error('selectSimEnsemblePortfolio: empty candidate pool');

  const sigRes = residualize(simStats.std, simStats.mean);
  const p99Res = residualize(simStats.p99, simStats.mean);
  // p25 residual: high means above-expected DOWNSIDE FLOOR; not what we want for
  // GPP upside seeking. Invert sign so the residual rewards lineups whose p25 is
  // higher than their mean would predict (resilient floor).
  const p25Res = residualize(simStats.p25, simStats.mean);
  // Skew already standardized; we residualize against mean to remove any
  // mean-dependent skew bias.
  const skewRes = residualize(simStats.skew, simStats.mean);

  const sigPct = rankPercentileFA(sigRes);
  const p99Pct = rankPercentileFA(p99Res);
  const p25Pct = rankPercentileFA(p25Res);
  const skewPct = rankPercentileFA(skewRes);

  const ensemble = new Float64Array(candidates.length);
  for (let i = 0; i < candidates.length; i++) {
    ensemble[i] = 0.25 * (sigPct[i] + p99Pct[i] + p25Pct[i] + skewPct[i]);
  }

  const ensPct = rankPercentileFA(ensemble);
  const { weight, anchorMean, anchorStd } = computeSlateDerivedWeight(
    ensemble, candidates, W_ENS_BASE, W_ENS_SCALE,
  );

  const scored = scoreTheoryV1Candidates(candidates, params);

  for (let i = 0; i < scored.length; i++) {
    const s = scored[i];
    let ev = params.wProj * s.projPct
      + params.wLev * (1 - s.ownPct)
      + weight * ensPct[i]
      + params.wCmb * s.uniqPct
      + params.wStructure * s.structurePct
      + params.wStackField * s.stackFieldPct
      - params.wGameOverload * s.gameOverloadPct;

    if (s.ppdPct >= 1 - params.ppdTopPct) ev *= (1 - params.ppdPenalty);
    s.ev = ev;
  }

  const result = selectFromScoredTheoryLineups(scored, candidates.length, targetCount, params);
  return { ...result, ensembleWeight: weight, ensembleAnchorMean: anchorMean, ensembleAnchorStd: anchorStd };
}
