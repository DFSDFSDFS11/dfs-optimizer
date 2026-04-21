/**
 * V33 Discounted — Hunter U²ₗ with duplication discount against blended field.
 *
 * Pure greedy marginal gain: each step picks the candidate that covers the most
 * NEW worlds at top-1%, discounted by expected field duplicates (player overlap
 * with the blended field).
 *
 * No regions. No tilted projections. Team coverage + exposure cap as hard constraints.
 */

import { Lineup, Player, ContestConfig } from '../types';
import { SlatePrecomputation } from './algorithm7-selector';

export interface V33Params {
  maxExposure: number;
  maxPerTeam: number;
  fieldForDuplication: Lineup[];  // blended field for duplicate counting
}

export function v33DiscountedSelect(
  precomp: SlatePrecomputation,
  N: number,
  params: V33Params,
): Lineup[] {
  const { W, C, candidateWorldScores, candidatePool } = precomp;
  const thresh1 = precomp.thresh1;

  // Pre-compute per-candidate per-world hit indicator
  const hits = new Uint8Array(C * W);
  for (let c = 0; c < C; c++) {
    for (let w = 0; w < W; w++) {
      if (candidateWorldScores[c * W + w] >= thresh1[w]) hits[c * W + w] = 1;
    }
  }

  // Pre-compute duplication discount per candidate
  const fieldSample = params.fieldForDuplication.slice(0, 3000);
  const fieldScale = params.fieldForDuplication.length / fieldSample.length;
  const discounts = new Float64Array(C);
  for (let c = 0; c < C; c++) {
    const cIds = new Set(candidatePool[c].players.map(p => p.id));
    const rosterSize = candidatePool[c].players.length;
    let dups = 0;
    for (const f of fieldSample) {
      let overlap = 0;
      for (const p of f.players) if (cIds.has(p.id)) overlap++;
      const frac = overlap / rosterSize;
      if (frac >= 1.0) dups += 1.0;
      else if (frac >= 0.9) dups += 0.5;
      else if (frac >= 0.8) dups += 0.15;
    }
    discounts[c] = 1 / (1 + dups * fieldScale);
  }

  const selected: Lineup[] = [];
  const selectedHashes = new Set<string>();
  const playerCount = new Map<string, number>();
  const teamStackCount = new Map<string, number>();
  const covered = new Uint8Array(W);
  const expCap = Math.ceil(params.maxExposure * N);

  for (let step = 0; step < N; step++) {
    let bestIdx = -1;
    let bestGain = -Infinity;

    for (let c = 0; c < C; c++) {
      const lu = candidatePool[c];
      if (selectedHashes.has(lu.hash)) continue;

      let expOk = true;
      for (const p of lu.players) if ((playerCount.get(p.id) || 0) >= expCap) { expOk = false; break; }
      if (!expOk) continue;

      const tc = new Map<string, number>();
      for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
      let teamOk = true;
      for (const [t, cnt] of tc) if (cnt >= 4 && (teamStackCount.get(t) || 0) >= params.maxPerTeam) { teamOk = false; break; }
      if (!teamOk) continue;

      let rawGain = 0;
      for (let w = 0; w < W; w++) {
        if (!covered[w] && hits[c * W + w]) rawGain++;
      }
      const gain = rawGain * discounts[c];

      if (gain > bestGain) { bestGain = gain; bestIdx = c; }
    }

    if (bestIdx < 0) break;

    const lu = candidatePool[bestIdx];
    selected.push(lu);
    selectedHashes.add(lu.hash);
    for (const p of lu.players) playerCount.set(p.id, (playerCount.get(p.id) || 0) + 1);
    const tc2 = new Map<string, number>();
    for (const p of lu.players) if (!p.positions?.includes('P')) tc2.set(p.team, (tc2.get(p.team) || 0) + 1);
    for (const [t, cnt] of tc2) if (cnt >= 4) teamStackCount.set(t, (teamStackCount.get(t) || 0) + 1);
    for (let w = 0; w < W; w++) { if (hits[bestIdx * W + w]) covered[w] = 1; }

    if ((step + 1) % 50 === 0) {
      let cov = 0; for (let w = 0; w < W; w++) cov += covered[w];
      console.log(`    [V33d] ${step+1}/${N} gain=${bestGain.toFixed(1)} cov=${(cov/W*100).toFixed(1)}%`);
    }
  }

  return selected;
}
