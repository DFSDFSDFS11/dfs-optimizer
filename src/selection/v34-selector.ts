/**
 * V34 — Ceiling × Construction-Duplication selector.
 *
 * Score = correlated_ceiling × construction_discount × ownership_bonus
 *
 * Greedy selection: each step picks the candidate with highest V34 score
 * that covers NEW worlds at top-1%, with team coverage + exposure constraints.
 *
 * No regions. No tilted projections. Ceiling drives quality, construction
 * duplication drives uniqueness.
 */

import { Lineup, Player, ContestConfig } from '../types';
import { SlatePrecomputation } from './algorithm7-selector';

// ============================================================
// CEILING SCORING
// ============================================================

export function computeLineupCeiling(lu: Lineup): number {
  // Naive: sum of p99 (or ceiling99) per player
  let naive = 0;
  for (const p of lu.players) {
    naive += p.percentiles?.p99 || p.ceiling99 || p.ceiling || p.projection * 1.5;
  }

  // Stack boost: correlated teammates amplify ceiling
  const teamPlayers = new Map<string, Player[]>();
  for (const p of lu.players) {
    if (p.positions?.includes('P')) continue;
    if (!teamPlayers.has(p.team)) teamPlayers.set(p.team, []);
    teamPlayers.get(p.team)!.push(p);
  }

  let boost = 0;
  for (const [, teammates] of teamPlayers) {
    if (teammates.length >= 5) {
      boost += teammates.reduce((s, p) => s + (p.percentiles?.p99 || p.ceiling99 || p.projection * 1.5), 0) * 0.20;
    } else if (teammates.length >= 4) {
      boost += teammates.reduce((s, p) => s + (p.percentiles?.p99 || p.ceiling99 || p.projection * 1.5), 0) * 0.15;
    } else if (teammates.length >= 3) {
      boost += teammates.reduce((s, p) => s + (p.percentiles?.p99 || p.ceiling99 || p.projection * 1.5), 0) * 0.08;
    }
  }

  return naive + boost;
}

// ============================================================
// CONSTRUCTION SIGNATURE + DUPLICATION
// ============================================================

export interface ConstructionSig {
  stackTeam: string;
  stackSize: number;
  pitcher1: string;
  pitcher2: string;
  bringBackTeam: string;
}

export function extractSig(lu: Lineup): ConstructionSig {
  const tc = new Map<string, number>();
  for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
  let stackTeam = '', stackSize = 0;
  for (const [t, c] of tc) if (c > stackSize) { stackSize = c; stackTeam = t; }

  const pitchers = lu.players.filter(p => p.positions?.includes('P'));

  const stackOpp = lu.players.find(p => p.team === stackTeam)?.opponent || '';
  const bbCount = lu.players.filter(p => p.team === stackOpp && !p.positions?.includes('P')).length;

  return {
    stackTeam, stackSize,
    pitcher1: pitchers[0]?.id || '',
    pitcher2: pitchers[1]?.id || '',
    bringBackTeam: bbCount >= 1 ? stackOpp : '',
  };
}

export function computeConstructionDupes(
  candidate: Lineup,
  field: Lineup[],
  fieldSigs: ConstructionSig[],
): number {
  const candSig = extractSig(candidate);
  const candIds = new Set(candidate.players.map(p => p.id));
  const rosterSize = candidate.players.length;
  let total = 0;

  for (let i = 0; i < field.length; i++) {
    const fSig = fieldSigs[i];
    let w = 0;

    // Primary stack match
    if (candSig.stackTeam && candSig.stackTeam === fSig.stackTeam) {
      w += 0.5;
      if (candSig.stackSize === fSig.stackSize) w += 0.1;
    }

    // Pitcher matches
    if (candSig.pitcher1 && candSig.pitcher1 === fSig.pitcher1) w += 0.2;
    if (candSig.pitcher2 && candSig.pitcher2 === fSig.pitcher2) w += 0.15;

    // Stack + pitcher combo
    if (candSig.stackTeam === fSig.stackTeam && candSig.pitcher1 === fSig.pitcher1) w += 0.3;

    // Bring-back match
    if (candSig.bringBackTeam && candSig.bringBackTeam === fSig.bringBackTeam) w += 0.1;

    // Direct player overlap (downweighted)
    let overlap = 0;
    for (const p of field[i].players) if (candIds.has(p.id)) overlap++;
    if (overlap / rosterSize >= 0.9) w += 0.3;
    else if (overlap / rosterSize >= 0.7) w += 0.1;

    total += w;
  }

  return total;
}

// ============================================================
// V34 SELECTOR
// ============================================================

export function v34Select(
  precomp: SlatePrecomputation,
  field: Lineup[],
  N: number,
  maxExposure: number,
  maxPerTeam: number,
): Lineup[] {
  const { W, C, candidateWorldScores, candidatePool } = precomp;
  const thresh1 = precomp.thresh1;

  // Pre-compute hits
  const hits = new Uint8Array(C * W);
  for (let c = 0; c < C; c++) {
    for (let w = 0; w < W; w++) {
      if (candidateWorldScores[c * W + w] >= thresh1[w]) hits[c * W + w] = 1;
    }
  }

  // Pre-compute ceilings
  const ceilings = new Float64Array(C);
  for (let c = 0; c < C; c++) {
    ceilings[c] = computeLineupCeiling(candidatePool[c]);
  }

  // Pre-compute field construction signatures (sample for speed)
  const fieldSample = field.slice(0, 3000);
  const fieldScale = field.length / fieldSample.length;
  console.log(`    computing construction sigs for ${fieldSample.length} field lineups…`);
  const fieldSigs = fieldSample.map(f => extractSig(f));

  // Pre-compute construction duplication discount per candidate
  console.log(`    computing construction duplication for ${C} candidates…`);
  const discounts = new Float64Array(C);
  for (let c = 0; c < C; c++) {
    const dupes = computeConstructionDupes(candidatePool[c], fieldSample, fieldSigs) * fieldScale;
    discounts[c] = 1 / (1 + dupes * 0.3);
  }

  // Ownership bonus
  const ownBonus = new Float64Array(C);
  for (let c = 0; c < C; c++) {
    const ownSum = candidatePool[c].players.reduce((s, p) => s + (p.ownership || 0), 0);
    if (ownSum < 80) ownBonus[c] = 1.2;
    else if (ownSum > 180) ownBonus[c] = 0.7;
    else ownBonus[c] = 1.0;
  }

  // Greedy selection
  const selected: Lineup[] = [];
  const selectedHashes = new Set<string>();
  const playerCount = new Map<string, number>();
  const teamStackCount = new Map<string, number>();
  const covered = new Uint8Array(W);
  const expCap = Math.ceil(maxExposure * N);

  for (let step = 0; step < N; step++) {
    let bestIdx = -1;
    let bestScore = -Infinity;

    for (let c = 0; c < C; c++) {
      const lu = candidatePool[c];
      if (selectedHashes.has(lu.hash)) continue;

      // Exposure
      let expOk = true;
      for (const p of lu.players) if ((playerCount.get(p.id) || 0) >= expCap) { expOk = false; break; }
      if (!expOk) continue;

      // Team stack cap
      const tc = new Map<string, number>();
      for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
      let teamOk = true;
      for (const [t, cnt] of tc) if (cnt >= 4 && (teamStackCount.get(t) || 0) >= maxPerTeam) { teamOk = false; break; }
      if (!teamOk) continue;

      // Marginal world coverage
      let rawGain = 0;
      for (let w = 0; w < W; w++) {
        if (!covered[w] && hits[c * W + w]) rawGain++;
      }
      if (rawGain <= 0 && step < N * 0.8) continue; // don't pick zero-gain early

      // V34 score: ceiling × construction discount × ownership bonus × marginal gain
      const score = ceilings[c] * discounts[c] * ownBonus[c] * (1 + rawGain * 0.01);

      if (score > bestScore) { bestScore = score; bestIdx = c; }
    }

    if (bestIdx < 0) {
      // Fallback: pick by ceiling alone
      for (let c = 0; c < C; c++) {
        const lu = candidatePool[c]; if (selectedHashes.has(lu.hash)) continue;
        let expOk = true; for (const p of lu.players) if ((playerCount.get(p.id) || 0) >= expCap) { expOk = false; break; } if (!expOk) continue;
        if (ceilings[c] > bestScore) { bestScore = ceilings[c]; bestIdx = c; }
      }
      if (bestIdx < 0) break;
    }

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
      console.log(`    [V34] ${step+1}/${N} ceil=${ceilings[bestIdx].toFixed(0)} disc=${discounts[bestIdx].toFixed(3)} cov=${(cov/W*100).toFixed(1)}%`);
    }
  }

  return selected;
}
