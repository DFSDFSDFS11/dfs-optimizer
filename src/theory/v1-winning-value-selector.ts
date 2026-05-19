/**
 * V1-WinningValue — aggressive architectural variant.
 *
 * Per spec: REPLACES V1's W_PROJ and W_VAR with a single slate-derived
 * W_WINNING term scoring lineups by winning-capability composite. Lineups
 * below the winning threshold (slate-derived) get 0; lineups above are
 * scored by upsideExcess × projection.
 *
 * EV = W_WINNING × winningValuePct       [slate-derived, replaces W_PROJ + W_VAR]
 *    + W_LEV × (1 - ownPct)
 *    + W_CMB × uniqPct
 *    + W_STRUCTURE × structurePct
 *    + W_STACK_FIELD × stackFieldPct
 *    - W_GAME_OVERLOAD × gameOverloadPct
 *
 * Raw projection is no longer directly weighted. The user's described
 * preference (pick Type B over Type A) hinges on this — a Type A lineup
 * with high projection but below-threshold p99 sum gets 0 from the
 * winning-value term, removing its dominance.
 */

import { Lineup } from '../types';
import { AnchorReference, computeAnchorReference, computeWinningValue } from './v1-anchor';
import {
  TheoryV1Params,
  TheoryV1SelectionResult,
  ScoredTheoryLineup,
  scoreTheoryV1Candidates,
  selectFromScoredTheoryLineups,
} from './v1-selector';

export interface WinningValueResult extends TheoryV1SelectionResult {
  anchor: AnchorReference;
  winningValues: number[];
  filteredOutCount: number;
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

export function selectWinningValuePortfolio(
  candidates: Lineup[],
  targetCount: number,
  params: TheoryV1Params,
): WinningValueResult {
  const anchor = computeAnchorReference(candidates);

  // Compute baseline V1 scoring (need structure/uniqueness/etc. populated).
  const scored = scoreTheoryV1Candidates(candidates, params);

  // Compute per-lineup winning value (zero if below winning threshold).
  const winningValues = candidates.map(L =>
    computeWinningValue(L, anchor.winningThreshold, anchor.anchorMean),
  );
  const winningValuePct = rankPercentile(winningValues);
  const filteredOutCount = winningValues.filter(v => v === 0).length;

  // Re-derive EV: REMOVE W_PROJ × projPct and W_VAR × rangePct × 0.85,
  // ADD W_WINNING × winningValuePct. W_LEV / W_CMB / structural terms unchanged.
  for (let i = 0; i < scored.length; i++) {
    const s = scored[i];
    let ev = anchor.winningWeight * winningValuePct[i]   // slate-derived, replaces W_PROJ + W_VAR
      + params.wLev * (1 - s.ownPct)
      + params.wCmb * s.uniqPct
      + params.wStructure * s.structurePct
      + params.wStackField * s.stackFieldPct
      - params.wGameOverload * s.gameOverloadPct;

    if (s.ppdPct >= 1 - params.ppdTopPct) ev *= (1 - params.ppdPenalty);
    s.ev = ev;
  }

  const result = selectFromScoredTheoryLineups(scored, candidates.length, targetCount, params);
  return { ...result, anchor, winningValues, filteredOutCount };
}
