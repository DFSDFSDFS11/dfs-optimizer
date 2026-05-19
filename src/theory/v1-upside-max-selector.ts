/**
 * V1-UpsideMax — conservative architectural variant.
 *
 * Per spec: adds slate-derived W_UPSIDE component alongside V1's existing
 * W_PROJ = 1.0. W_UPSIDE replaces W_VAR's role in the EV formula. All other
 * V1 components (W_LEV, W_CMB, W_STRUCTURE, W_STACK_FIELD, W_GAME_OVERLOAD)
 * are unchanged.
 *
 * EV = W_PROJ × projPct
 *    + W_LEV × (1 - ownPct)
 *    + W_UPSIDE × upsideScorePct           [slate-derived]
 *    + W_CMB × uniqPct
 *    + W_STRUCTURE × structurePct
 *    + W_STACK_FIELD × stackFieldPct
 *    - W_GAME_OVERLOAD × gameOverloadPct
 */

import { Lineup } from '../types';
import { AnchorReference, computeAnchorReference, computeUpsideScore } from './v1-anchor';
import {
  TheoryV1Params,
  TheoryV1SelectionResult,
  ScoredTheoryLineup,
  scoreTheoryV1Candidates,
  selectFromScoredTheoryLineups,
} from './v1-selector';

export interface UpsideMaxResult extends TheoryV1SelectionResult {
  anchor: AnchorReference;
  upsideScores: number[];
}

function rankPercentile(values: number[]): number[] {
  const idx = values.map((v, i) => ({ v, i }));
  idx.sort((a, b) => a.v - b.v);
  const out = new Array<number>(values.length).fill(0);
  for (let r = 0; r < idx.length; r++) {
    out[idx[r].i] = values.length > 1 ? r / (values.length - 1) : 0;
  }
  return out;
}

export function selectUpsideMaxPortfolio(
  candidates: Lineup[],
  targetCount: number,
  params: TheoryV1Params,
): UpsideMaxResult {
  const anchor = computeAnchorReference(candidates);

  // Compute baseline V1 scoring (this populates structure/correlation/uniqueness/etc.).
  const scored = scoreTheoryV1Candidates(candidates, params);

  // Compute per-lineup upside score using slate-derived threshold + anchor mean.
  const upsideScores = candidates.map(L =>
    computeUpsideScore(L, anchor.winningThreshold, anchor.anchorMean),
  );
  const upsidePct = rankPercentile(upsideScores);

  // Re-derive EV: REPLACE the W_VAR term with W_UPSIDE × upsidePct. Everything else unchanged.
  for (let i = 0; i < scored.length; i++) {
    const s = scored[i];
    let ev = params.wProj * s.projPct
      + params.wLev * (1 - s.ownPct)
      + anchor.upsideWeight * upsidePct[i]              // slate-derived, replaces W_VAR
      + params.wCmb * s.uniqPct
      + params.wStructure * s.structurePct
      + params.wStackField * s.stackFieldPct
      - params.wGameOverload * s.gameOverloadPct;

    if (s.ppdPct >= 1 - params.ppdTopPct) ev *= (1 - params.ppdPenalty);
    s.ev = ev;
  }

  const result = selectFromScoredTheoryLineups(scored, candidates.length, targetCount, params);
  return { ...result, anchor, upsideScores };
}
