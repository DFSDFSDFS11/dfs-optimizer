/**
 * V35 World Simulation — T-copula correlated player score sampling.
 *
 * For each of N worlds, draws correlated player scores using:
 *   1. Cholesky decomposition of a correlation matrix
 *   2. Correlated t-distributed samples (df=5 for tail dependence)
 *   3. Map through t-CDF to uniform, then through player percentile inverse CDF
 *
 * Output: Float32Array of [numPlayers x numWorlds] fantasy point scores.
 */

import { Player } from '../types';

// ============================================================
// RNG — Mulberry32 for reproducibility
// ============================================================

function createRng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Box-Muller for standard normal
function normalPair(rng: () => number): [number, number] {
  let u1: number, u2: number;
  do { u1 = rng(); } while (u1 === 0);
  u2 = rng();
  const r = Math.sqrt(-2 * Math.log(u1));
  return [r * Math.cos(2 * Math.PI * u2), r * Math.sin(2 * Math.PI * u2)];
}

// ============================================================
// T-DISTRIBUTION CDF (approximation via regularized incomplete beta)
// ============================================================

// Regularized incomplete beta function via continued fraction (Lentz's method)
function betaIncomplete(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  const lnBeta = lgamma(a) + lgamma(b) - lgamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnBeta);

  // Lentz's continued fraction
  let f = 1, c = 1, d = 1 - (a + b) * x / (a + 1);
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d;
  f = d;

  for (let m = 1; m <= 200; m++) {
    // Even step
    let numerator = m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m));
    d = 1 + numerator * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + numerator / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    f *= c * d;

    // Odd step
    numerator = -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 + numerator * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + numerator / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    const delta = c * d;
    f *= delta;
    if (Math.abs(delta - 1) < 1e-10) break;
  }

  return front * f / a;
}

function lgamma(x: number): number {
  // Lanczos approximation
  const g = 7;
  const c = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  }
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function tCDF(t: number, nu: number): number {
  const x = nu / (nu + t * t);
  const ib = betaIncomplete(nu / 2, 0.5, x);
  if (t >= 0) return 1 - 0.5 * ib;
  return 0.5 * ib;
}

// ============================================================
// PERCENTILE INVERSE CDF — linear interpolation
// ============================================================

/**
 * Given a uniform quantile u in [0,1], interpolate through the player's
 * percentile distribution to get a fantasy point score.
 */
function percentileInvCDF(u: number, p: Player): number {
  // Percentile knots: (quantile, value)
  const pct = p.percentiles;
  if (!pct) {
    // Fallback: normal approximation from projection + stdDev
    const sd = p.stdDev || p.projection * 0.35;
    // Inverse normal approximation (Beasley-Springer-Moro)
    const z = approxNormInv(u);
    return Math.max(0, p.projection + z * sd);
  }

  const knots: [number, number][] = [
    [0.00, Math.max(0, pct.p25 - (pct.p50 - pct.p25) * 1.5)], // ~p0 estimate
    [0.25, pct.p25],
    [0.50, pct.p50],
    [0.75, pct.p75],
    [0.85, pct.p85],
    [0.95, pct.p95],
    [0.99, pct.p99],
    [1.00, pct.p99 + (pct.p99 - pct.p95) * 0.5], // ~p100 estimate
  ];

  // Find the interval and linearly interpolate
  for (let i = 0; i < knots.length - 1; i++) {
    if (u <= knots[i + 1][0]) {
      const [u0, v0] = knots[i];
      const [u1, v1] = knots[i + 1];
      const t = (u - u0) / (u1 - u0 + 1e-12);
      return Math.max(0, v0 + t * (v1 - v0));
    }
  }
  return Math.max(0, knots[knots.length - 1][1]);
}

// Rational approximation of inverse normal CDF
function approxNormInv(p: number): number {
  if (p <= 0) return -4;
  if (p >= 1) return 4;
  if (p === 0.5) return 0;
  if (p < 0.5) return -approxNormInv(1 - p);
  // Abramowitz & Stegun 26.2.23
  const t = Math.sqrt(-2 * Math.log(1 - p));
  const c0 = 2.515517, c1 = 0.802853, c2 = 0.010328;
  const d1 = 1.432788, d2 = 0.189269, d3 = 0.001308;
  return t - (c0 + c1 * t + c2 * t * t) / (1 + d1 * t + d2 * t * t + d3 * t * t * t);
}

// ============================================================
// CORRELATION MATRIX CONSTRUCTION
// ============================================================

interface CorrelationInfo {
  /** Flat lower-triangular Cholesky factor, row-major */
  cholesky: Float64Array;
  n: number;
}

function buildCorrelationMatrix(players: Player[]): CorrelationInfo {
  const n = players.length;
  // Build correlation matrix
  const corr = new Float64Array(n * n);

  // Diagonal = 1
  for (let i = 0; i < n; i++) corr[i * n + i] = 1.0;

  // Build game lookup: gameInfo -> team -> players
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const pi = players[i], pj = players[j];
      let rho = 0;

      if (pi.team === pj.team) {
        // Teammates
        rho = 0.12;
      } else if (pi.gameInfo && pj.gameInfo && pi.gameInfo === pj.gameInfo) {
        // Same game, different teams
        const piIsPitcher = pi.positions?.includes('P') || pi.position?.includes('P');
        const pjIsPitcher = pj.positions?.includes('P') || pj.position?.includes('P');

        if ((piIsPitcher && pj.team === pi.opponent) || (pjIsPitcher && pi.team === pj.opponent)) {
          // Pitcher vs opposing batters
          rho = -0.25;
        } else {
          // Same-game opponents (batter vs batter across teams)
          rho = -0.05;
        }
      }

      corr[i * n + j] = rho;
      corr[j * n + i] = rho;
    }
  }

  // Cholesky decomposition (in-place on a copy)
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = 0;
      for (let k = 0; k < j; k++) sum += L[i * n + k] * L[j * n + k];
      if (i === j) {
        const diag = corr[i * n + i] - sum;
        L[i * n + j] = diag > 0 ? Math.sqrt(diag) : 1e-6;
      } else {
        L[i * n + j] = (corr[i * n + j] - sum) / (L[j * n + j] || 1e-6);
      }
    }
  }

  return { cholesky: L, n };
}

// ============================================================
// MAIN: Generate worlds
// ============================================================

export interface SimulationResult {
  /** Player scores: scores[p * numWorlds + w] = score of player p in world w */
  scores: Float32Array;
  numPlayers: number;
  numWorlds: number;
}

/**
 * Generate N worlds of correlated player scores using t-copula.
 *
 * @param players - All players on the slate
 * @param numWorlds - Number of simulation worlds (default 3000)
 * @param nu - Degrees of freedom for t-copula (default 5)
 * @param seed - RNG seed for reproducibility
 */
export function generateWorlds(
  players: Player[],
  numWorlds: number = 3000,
  nu: number = 5,
  seed: number = 12345,
): SimulationResult {
  const n = players.length;
  const rng = createRng(seed);

  // Build correlation and Cholesky
  const { cholesky: L } = buildCorrelationMatrix(players);

  // Output array
  const scores = new Float32Array(n * numWorlds);

  // For each world, generate correlated t-distributed samples
  for (let w = 0; w < numWorlds; w++) {
    // 1. Generate n independent standard normals
    const z = new Float64Array(n);
    for (let i = 0; i < n; i += 2) {
      const [n1, n2] = normalPair(rng);
      z[i] = n1;
      if (i + 1 < n) z[i + 1] = n2;
    }

    // 2. Multiply by Cholesky factor: y = L * z
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let j = 0; j <= i; j++) sum += L[i * n + j] * z[j];
      y[i] = sum;
    }

    // 3. Generate chi-squared(nu) via sum of nu standard normals squared
    let chi2 = 0;
    for (let k = 0; k < nu; k++) {
      const [n1] = normalPair(rng);
      chi2 += n1 * n1;
    }

    // 4. t-distributed: t = y / sqrt(chi2/nu)
    const scale = Math.sqrt(chi2 / nu);
    for (let i = 0; i < n; i++) {
      const t = y[i] / (scale || 1);
      // 5. Convert to uniform via t-CDF
      const u = tCDF(t, nu);
      // 6. Map through percentile inverse CDF
      scores[i * numWorlds + w] = percentileInvCDF(u, players[i]);
    }
  }

  return { scores, numPlayers: n, numWorlds };
}
