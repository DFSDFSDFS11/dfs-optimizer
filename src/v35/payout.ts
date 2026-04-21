/**
 * V35 Payout Model — DK GPP prize structure and rank computation.
 *
 * Power-law payout: pool * C * r^(-1.15), normalized.
 * Binary search for rank computation in sorted field scores.
 */

// ============================================================
// PAYOUT TABLE
// ============================================================

export interface PayoutModel {
  table: Float64Array;
  fieldSize: number;
  cashLine: number;
  entryFee: number;
}

/**
 * Build a DK GPP payout table using power-law approximation.
 *
 * @param fieldSize - Total number of entries
 * @param entryFee - Entry fee (default $20)
 */
export function buildPayoutModel(fieldSize: number, entryFee: number = 20): PayoutModel {
  const pool = fieldSize * entryFee * 0.88;
  const cashLine = Math.floor(fieldSize * 0.22);

  const raw = new Float64Array(cashLine);
  let rawSum = 0;
  for (let r = 0; r < cashLine; r++) {
    raw[r] = Math.pow(r + 1, -1.15);
    rawSum += raw[r];
  }

  const table = new Float64Array(fieldSize);
  const minCash = entryFee * 1.2;
  for (let r = 0; r < cashLine; r++) {
    table[r] = Math.max(minCash, (raw[r] / rawSum) * pool);
  }

  // Re-normalize after min-cash floor
  let tSum = 0;
  for (let r = 0; r < cashLine; r++) tSum += table[r];
  const scale = pool / tSum;
  for (let r = 0; r < cashLine; r++) table[r] *= scale;

  return { table, fieldSize, cashLine, entryFee };
}

// ============================================================
// RANK COMPUTATION — binary search in pre-sorted field scores
// ============================================================

/**
 * Find the rank of a score among sorted field scores (descending order).
 * Rank 1 = best. Uses binary search for O(log n).
 *
 * @param score - The score to rank
 * @param sortedDesc - Field scores sorted in descending order
 * @returns 1-indexed rank
 */
export function findRank(score: number, sortedDesc: Float64Array): number {
  // Binary search: find first index where sortedDesc[i] < score
  let lo = 0, hi = sortedDesc.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedDesc[mid] >= score) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(1, lo);
}

/**
 * Get the payout at a given rank.
 */
export function getPayoutAtRank(rank: number, model: PayoutModel): number {
  if (rank < 1 || rank > model.cashLine) return 0;
  return model.table[rank - 1];
}

// ============================================================
// PORTFOLIO PAYOUT IN A SINGLE WORLD
// ============================================================

/**
 * Compute total portfolio payout in a single world.
 *
 * @param portfolioScores - Scores of each portfolio lineup in this world
 * @param fieldSortedDesc - Field scores in this world, sorted descending
 * @param model - Payout model
 * @param bestPortfolioScore - Best score among existing portfolio lineups (for incremental computation)
 * @returns Total payout for the portfolio in this world
 */
export function computeWorldPayout(
  portfolioScores: number[],
  fieldSortedDesc: Float64Array,
  model: PayoutModel,
): number {
  let total = 0;
  for (const score of portfolioScores) {
    const rank = findRank(score, fieldSortedDesc);
    total += getPayoutAtRank(rank, model);
  }
  return total;
}
