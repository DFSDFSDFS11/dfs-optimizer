/**
 * Parimutuel EV Selection — the unified formula.
 *
 * ΔEV(c | P) = Σ_w [ hit(c,w) × prize(rank_c_w) / (1 + field_co_hits(w) + portfolio_hits(w,P)) ]
 *
 * Replaces: projection scoring, σ_{δ,G}, tilted projections, region targeting,
 * scenario scoring, construction penalty, ceiling scoring. One formula.
 *
 * Research basis: Hunter §2 (submodular), Haugh-Singal §5.3 (parimutuel),
 * Liu §3 (worst-case coverage).
 */

import { Lineup, Player } from '../types';
import { SlatePrecomputation } from './algorithm7-selector';

// ============================================================
// PRECOMPUTATION
// ============================================================

export interface ParimutuelPrecomp {
  W: number;
  C: number;

  /** Per-candidate per-world: does candidate hit top-1% in this world? */
  candidateHits: Uint8Array;    // [C × W] flat

  /** Per-world: how many field entries hit top-1% in this world */
  fieldCoHits: Float32Array;    // [W]

  /** Per-world: approximate prize for a top-1% hit in this world.
   *  Uses rank-based power-law: prize ∝ 1/rank^1.15 */
  prizePerWorld: Float32Array;  // [W] — average prize for a hit in this world

  /** Per-candidate per-world: candidate's rank among field in this world */
  candidateRankInWorld: Uint16Array; // [C × W] — rank (1=best)
}

export function buildParimutuelPrecomp(
  precomp: SlatePrecomputation,
  field: Lineup[],
  fieldSize: number,        // actual contest size (for prize scaling)
  entryFee: number,
): ParimutuelPrecomp {
  const { W, C, candidateWorldScores, candidatePool } = precomp;
  const thresh1 = precomp.thresh1;
  const F = precomp.F;

  // 1. Candidate hit vectors
  const candidateHits = new Uint8Array(C * W);
  for (let c = 0; c < C; c++) {
    for (let w = 0; w < W; w++) {
      if (candidateWorldScores[c * W + w] >= thresh1[w]) candidateHits[c * W + w] = 1;
    }
  }

  // 2. Field co-hits per world: how many field lineups also hit top-1% in each world
  //    Use precomp.sortedFieldByWorld to count entries above threshold
  const fieldCoHits = new Float32Array(W);
  for (let w = 0; w < W; w++) {
    const sortedField = precomp.sortedFieldByWorld[w];
    if (!sortedField || sortedField.length === 0) continue;
    const threshold = thresh1[w];
    // Binary search for how many field entries exceed threshold
    let lo = 0, hi = sortedField.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sortedField[mid] < threshold) lo = mid + 1; else hi = mid;
    }
    const hitsAbove = sortedField.length - lo;
    // Scale to actual contest size (field sample is smaller than real contest)
    fieldCoHits[w] = hitsAbove * (fieldSize / sortedField.length);
  }

  // 3. Prize per world: approximate rank-based prize for a top-1% hit
  //    A hit in a world with 50 field co-hits splits more than one with 5
  const prizePool = fieldSize * entryFee * 0.88;
  const prizePerWorld = new Float32Array(W);
  for (let w = 0; w < W; w++) {
    const coHits = Math.max(1, fieldCoHits[w]);
    // Average prize for a random hit among coHits entries in the prize zone
    // Using power-law: avg prize ≈ prizePool × integral(r^-1.15, 1, coHits) / coHits
    // Simplified: prizePool / (coHits^0.85) × normalization
    prizePerWorld[w] = prizePool * 0.01 / Math.pow(coHits, 0.85);
  }

  // 4. Candidate rank in each world (among field entries)
  //    Approximate: count field entries scoring higher
  const candidateRankInWorld = new Uint16Array(C * W);
  for (let c = 0; c < C; c++) {
    for (let w = 0; w < W; w++) {
      if (!candidateHits[c * W + w]) { candidateRankInWorld[c * W + w] = 65535; continue; }
      const score = candidateWorldScores[c * W + w];
      const sortedField = precomp.sortedFieldByWorld[w];
      // Binary search: how many field entries score higher
      let lo2 = 0, hi2 = sortedField.length;
      while (lo2 < hi2) {
        const mid = (lo2 + hi2) >>> 1;
        if (sortedField[mid] <= score) lo2 = mid + 1; else hi2 = mid;
      }
      const rank = Math.max(1, sortedField.length - lo2 + 1);
      candidateRankInWorld[c * W + w] = Math.min(65535, Math.round(rank * fieldSize / sortedField.length));
    }
  }

  return { W, C, candidateHits, fieldCoHits, prizePerWorld, candidateRankInWorld };
}

// ============================================================
// THE FORMULA
// ============================================================

/**
 * Marginal EV of adding candidate c to portfolio P.
 *
 * ΔEV(c | P) = Σ_w [ hit(c,w) × prize(rank_c_w) / (1 + field_co_hits(w) + portfolio_hits(w)) ]
 */
export function marginalEV(
  candidateIdx: number,
  portfolioHitsPerWorld: Float32Array,  // [W] — count of existing portfolio entries hitting each world
  ppc: ParimutuelPrecomp,
  prizePool: number,
  fieldSize: number,
): number {
  const { W, candidateHits, fieldCoHits, candidateRankInWorld } = ppc;
  let ev = 0;

  for (let w = 0; w < W; w++) {
    if (!candidateHits[candidateIdx * W + w]) continue;

    // Prize based on this candidate's rank in this world
    const rank = candidateRankInWorld[candidateIdx * W + w];
    if (rank >= 65535) continue;

    // Power-law prize: prize = prizePool × C_norm × rank^(-1.15)
    // Normalize so sum of prizes for top-22% = prizePool
    const rawPrize = prizePool * 0.005 * Math.pow(Math.max(1, rank), -1.15);

    // Divide by total entries competing in this world's prize zone
    const denominator = 1 + fieldCoHits[w] + portfolioHitsPerWorld[w];

    ev += rawPrize / denominator;
  }

  return ev / W;  // average across worlds
}

// ============================================================
// GREEDY SELECTION
// ============================================================

export function parimutuelGreedySelect(
  precomp: SlatePrecomputation,
  ppc: ParimutuelPrecomp,
  N: number,
  maxExposure: number,
  maxPerTeam: number,
  fieldSize: number,
  entryFee: number,
): Lineup[] {
  const { W, C, candidateHits } = ppc;
  const { candidatePool } = precomp;
  const prizePool = fieldSize * entryFee * 0.88;

  const selected: Lineup[] = [];
  const selectedHashes = new Set<string>();
  const playerCount = new Map<string, number>();
  const teamStackCount = new Map<string, number>();
  const portfolioHitsPerWorld = new Float32Array(W);
  const expCap = Math.ceil(maxExposure * N);

  for (let step = 0; step < N; step++) {
    let bestIdx = -1;
    let bestEV = -Infinity;

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

      const ev = marginalEV(c, portfolioHitsPerWorld, ppc, prizePool, fieldSize);

      if (ev > bestEV) { bestEV = ev; bestIdx = c; }
    }

    if (bestIdx < 0) break;

    const lu = candidatePool[bestIdx];
    selected.push(lu);
    selectedHashes.add(lu.hash);
    for (const p of lu.players) playerCount.set(p.id, (playerCount.get(p.id) || 0) + 1);
    const tc2 = new Map<string, number>();
    for (const p of lu.players) if (!p.positions?.includes('P')) tc2.set(p.team, (tc2.get(p.team) || 0) + 1);
    for (const [t, cnt] of tc2) if (cnt >= 4) teamStackCount.set(t, (teamStackCount.get(t) || 0) + 1);

    // Update portfolio hits per world
    for (let w = 0; w < W; w++) {
      if (candidateHits[bestIdx * W + w]) portfolioHitsPerWorld[w]++;
    }

    if ((step + 1) % 25 === 0 || step === 0) {
      let coveredWorlds = 0;
      for (let w = 0; w < W; w++) if (portfolioHitsPerWorld[w] > 0) coveredWorlds++;
      const scenario = getScenario(lu);
      console.log(`    [pEV] ${step+1}/${N} ev=${bestEV.toFixed(4)} scenario=${scenario} cov=${(coveredWorlds/W*100).toFixed(1)}%`);
    }
  }

  return selected;
}

function getScenario(lu: Lineup): string {
  const tc = new Map<string, number>();
  for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
  let best = '', bestC = 0;
  for (const [t, c] of tc) if (c > bestC) { bestC = c; best = t; }
  return best;
}
