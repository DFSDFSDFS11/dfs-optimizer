/**
 * Scenario-Level Scoring — Haugh-Singal Section 5.3 parimutuel formulation.
 *
 * For each candidate lineup:
 *   1. Identify its primary winning scenario (which team stack needs to boom)
 *   2. Count how many field lineups ALSO win in that scenario
 *   3. Score = P(scenario booms) × P(lineup hits | scenario) / field_coverage
 *
 * This replaces player-level σ_{δ,G} with the correct abstraction level.
 */

import { Lineup, Player } from '../types';
import { SlatePrecomputation } from './algorithm7-selector';

// ============================================================
// SCENARIO IDENTIFICATION
// ============================================================

/** A scenario = "team X's offense booms" — defined by the primary stack team. */
function getScenario(lu: Lineup): string {
  const tc = new Map<string, number>();
  for (const p of lu.players) {
    if (p.positions?.includes('P')) continue;
    tc.set(p.team, (tc.get(p.team) || 0) + 1);
  }
  let best = '', bestCount = 0;
  for (const [t, c] of tc) if (c > bestCount) { bestCount = c; best = t; }
  return best || 'NONE';
}

// ============================================================
// FIELD COVERAGE PER SCENARIO
// ============================================================

export interface ScenarioCoverage {
  /** scenario (team) → number of field lineups with that primary stack */
  fieldCountByScenario: Map<string, number>;
  /** scenario → fraction of field (for normalization) */
  fieldFractionByScenario: Map<string, number>;
  /** total field lineups analyzed */
  totalField: number;
}

export function computeScenarioCoverage(field: Lineup[]): ScenarioCoverage {
  const counts = new Map<string, number>();
  for (const lu of field) {
    const s = getScenario(lu);
    counts.set(s, (counts.get(s) || 0) + 1);
  }
  const fractions = new Map<string, number>();
  for (const [s, c] of counts) fractions.set(s, c / field.length);
  return { fieldCountByScenario: counts, fieldFractionByScenario: fractions, totalField: field.length };
}

// ============================================================
// SCENARIO-WEIGHTED CANDIDATE SCORING
// ============================================================

/**
 * For each candidate, compute:
 *   score = worldsWhereHits / fieldCoverageOfScenario
 *
 * worldsWhereHits = number of simulated worlds where this candidate's score
 *   exceeds the top-1% threshold (from precomp.thresh1)
 *
 * fieldCoverageOfScenario = how many field lineups share this candidate's
 *   primary stack team (from ScenarioCoverage)
 *
 * The ratio captures: "how often does this lineup win" / "how many others
 * also win in the same world" — the parimutuel edge.
 */
export function computeScenarioScores(
  precomp: SlatePrecomputation,
  scenarioCoverage: ScenarioCoverage,
): Float64Array {
  const { W, C, candidateWorldScores, candidatePool } = precomp;
  const thresh1 = precomp.thresh1;
  const scores = new Float64Array(C);

  for (let c = 0; c < C; c++) {
    // Count worlds where this candidate hits top-1%
    let hitWorlds = 0;
    for (let w = 0; w < W; w++) {
      if (candidateWorldScores[c * W + w] >= thresh1[w]) hitWorlds++;
    }

    // Field coverage of this candidate's scenario
    const scenario = getScenario(candidatePool[c]);
    const fieldCoverage = scenarioCoverage.fieldCountByScenario.get(scenario) || 1;

    // Scenario-weighted score: hit rate / field crowding
    // Higher = lineup wins in worlds where few field entries compete
    scores[c] = hitWorlds / fieldCoverage;
  }

  return scores;
}

/**
 * Greedy selector using scenario scores.
 *
 * Each step picks the candidate with highest scenario score that covers
 * NEW worlds. Team coverage + exposure constraints enforced.
 */
export function scenarioGreedySelect(
  precomp: SlatePrecomputation,
  scenarioScores: Float64Array,
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

      // Marginal gain × scenario score
      let rawGain = 0;
      for (let w = 0; w < W; w++) {
        if (!covered[w] && hits[c * W + w]) rawGain++;
      }

      // Combined: scenario score (parimutuel edge) × marginal world coverage
      const score = scenarioScores[c] * (1 + rawGain * 0.1);

      if (score > bestScore) { bestScore = score; bestIdx = c; }
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
      const scenario = getScenario(lu);
      console.log(`    [scenario] ${step+1}/${N} score=${bestScore.toFixed(2)} scenario=${scenario} cov=${(cov/W*100).toFixed(1)}%`);
    }
  }

  return selected;
}
