/**
 * V1-CVaR — score by tail conditional expectation.
 *
 * CVaR_95[c] = E[score_c | score_c >= p95(c)]
 *
 * Smoothed average of the top 5% of sim worlds (150 worlds of 3000). Less
 * noisy than a single p99 quantile estimate — captures "how big does it score
 * when it hits" rather than "is the p99 above some threshold".
 *
 * EV = W_PROJ × projPct
 *    + W_LEV × (1 - ownPct)
 *    + W_CVAR × cvarPct             [replaces V1's wVar × rangePct, slate-derived]
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
import { LineupSimStats, rankPercentileFA, computeSlateDerivedWeight } from './v1-sim-stats';

export interface CVaRResult extends TheoryV1SelectionResult {
  cvarWeight: number;
  cvarAnchorMean: number;
  cvarAnchorStd: number;
}

const W_CVAR_BASE = 0.30;
const W_CVAR_SCALE = 1.0;

export function selectCVaRPortfolio(
  candidates: Lineup[],
  _players: Player[],
  targetCount: number,
  params: TheoryV1Params,
  simStats: LineupSimStats,
): CVaRResult {
  if (candidates.length === 0) throw new Error('selectCVaRPortfolio: empty candidate pool');

  const cvarPct = rankPercentileFA(simStats.cvar95);
  const { weight, anchorMean, anchorStd } = computeSlateDerivedWeight(
    simStats.cvar95, candidates, W_CVAR_BASE, W_CVAR_SCALE,
  );

  const scored = scoreTheoryV1Candidates(candidates, params);

  for (let i = 0; i < scored.length; i++) {
    const s = scored[i];
    let ev = params.wProj * s.projPct
      + params.wLev * (1 - s.ownPct)
      + weight * cvarPct[i]
      + params.wCmb * s.uniqPct
      + params.wStructure * s.structurePct
      + params.wStackField * s.stackFieldPct
      - params.wGameOverload * s.gameOverloadPct;

    if (s.ppdPct >= 1 - params.ppdTopPct) ev *= (1 - params.ppdPenalty);
    s.ev = ev;
  }

  const result = selectFromScoredTheoryLineups(scored, candidates.length, targetCount, params);
  return { ...result, cvarWeight: weight, cvarAnchorMean: anchorMean, cvarAnchorStd: anchorStd };
}
