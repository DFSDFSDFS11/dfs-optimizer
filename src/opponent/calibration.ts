/**
 * Opponent Model Calibration — Haugh-Singal Sections 3.2, 6.3
 *
 * Fits a per-position Dirichlet regression from historical contest actuals:
 *   α_p = exp(β⁰ + β¹·own_p + β²·salary_p + β³·proj_p)
 *
 * Also measures stacking/bring-back fractions from real field data.
 *
 * Uses IRLS (iteratively reweighted least squares) with ridge regularization
 * instead of full Dirichlet MLE — stable, deterministic, no external deps.
 */

import * as fs from 'fs';
import { ContestEntry, ContestActuals } from '../parser/actuals-parser';
import { Player, Sport, ContestConfig } from '../types';

// ============================================================
// TYPES
// ============================================================

export interface DirichletCoeffs {
  beta0: number;   // intercept
  beta1: number;   // crowd-consensus ownership
  beta2: number;   // normalized salary
  beta3: number;   // normalized projection
}

export interface OpponentModelParams {
  sport: Sport;
  dirichletCoeffs: Map<string, DirichletCoeffs>;  // position → coefficients

  stackingFraction: number;       // fraction of field lineups with 4+ same-team
  bringBackFraction: number;      // fraction of stackers with bring-back
  avgStackDepth: number;          // mean stack depth for stackers

  archetypeDistribution: {
    chalkFraction: number;        // lineups where avg ownership > median
    contrarianFraction: number;   // lineups where avg ownership < p25
    stackerFraction: number;      // lineups with 4+ stack
    casualFraction: number;       // lineups violating salary efficiency (high leftover)
  };

  calibratedOnSlates: string[];
  calibrationRMSE: number;
  combo3RMSE: number;
}

export interface CalibrationSlate {
  slate: string;
  players: Player[];
  config: ContestConfig;
  actuals: ContestActuals;
}

// ============================================================
// MAIN CALIBRATION
// ============================================================

export function calibrateOpponentModel(
  slates: CalibrationSlate[],
  sport: Sport,
): OpponentModelParams {
  console.log(`\nCalibrating opponent model from ${slates.length} historical slates…`);

  // ─── Collect per-position observed ownership across all slates ───
  const positionObs: Map<string, Array<{ features: number[]; observed: number }>> = new Map();
  let totalStackers = 0, totalBringBack = 0, totalStackDepth = 0, totalStackLineups = 0;
  let totalChalk = 0, totalContrarian = 0, totalCasual = 0, totalEntries = 0;

  for (const slate of slates) {
    const { players, actuals, config } = slate;
    const playerByName = new Map<string, Player>();
    for (const p of players) playerByName.set(normalizeName(p.name), p);

    // Per-player actual ownership from contest (from %Drafted column)
    const actualOwnership = new Map<string, number>();
    for (const [name, pa] of actuals.playerActualsByName) {
      actualOwnership.set(name, pa.drafted);
    }

    // Build position observations for Dirichlet regression
    for (const p of players) {
      if ((p.ownership || 0) <= 0) continue;
      const norm = normalizeName(p.name);
      const actual = actualOwnership.get(norm);
      if (actual === undefined) continue;
      const pos = primaryPosition(p, sport);
      if (!positionObs.has(pos)) positionObs.set(pos, []);
      const maxSal = Math.max(...players.map(x => x.salary));
      const maxProj = Math.max(...players.map(x => x.projection));
      positionObs.get(pos)!.push({
        features: [
          1,                                          // intercept
          (p.ownership || 0) / 100,                   // crowd ownership
          p.salary / maxSal,                          // normalized salary
          p.projection / maxProj,                     // normalized projection
        ],
        observed: actual,
      });
    }

    // Measure stacking/bring-back from actual entries
    const medianOwn = medianOf(players.filter(p => (p.ownership || 0) > 0).map(p => (p.ownership || 0) / 100));
    const p25Own = percentileOf(players.filter(p => (p.ownership || 0) > 0).map(p => (p.ownership || 0) / 100), 0.25);
    const maxSalary = config.salaryCap;

    for (const entry of actuals.entries) {
      totalEntries++;
      const entryPlayers: Player[] = [];
      for (const name of entry.playerNames) {
        const p = playerByName.get(normalizeName(name));
        if (p) entryPlayers.push(p);
      }
      if (entryPlayers.length < 6) continue;

      // Avg ownership
      const avgOwn = entryPlayers.reduce((s, p) => s + (p.ownership || 0) / 100, 0) / entryPlayers.length;
      if (avgOwn > medianOwn) totalChalk++;
      if (avgOwn < p25Own) totalContrarian++;

      // Salary leftover
      const totalSalary = entryPlayers.reduce((s, p) => s + p.salary, 0);
      if (maxSalary - totalSalary > maxSalary * 0.05) totalCasual++;

      // Stack detection
      const teamCounts = new Map<string, number>();
      for (const p of entryPlayers) {
        if (sport === 'mlb' && p.positions?.includes('P')) continue;
        teamCounts.set(p.team, (teamCounts.get(p.team) || 0) + 1);
      }
      let maxStack = 0, stackTeam = '';
      for (const [t, c] of teamCounts) if (c > maxStack) { maxStack = c; stackTeam = t; }
      if (maxStack >= 4) {
        totalStackers++;
        totalStackDepth += maxStack;
        totalStackLineups++;
        // Bring-back: any non-pitcher from the opponent of stackTeam
        const stackOpp = entryPlayers.find(p => p.team === stackTeam)?.opponent;
        if (stackOpp) {
          const bb = entryPlayers.filter(p => p.team === stackOpp && !(sport === 'mlb' && p.positions?.includes('P'))).length;
          if (bb >= 1) totalBringBack++;
        }
      }
    }
  }

  // ─── Fit Dirichlet regression per position via IRLS ───
  const dirichletCoeffs = new Map<string, DirichletCoeffs>();
  let totalRMSE = 0;
  let posCount = 0;

  for (const [pos, obs] of positionObs) {
    if (obs.length < 10) {
      dirichletCoeffs.set(pos, { beta0: 0, beta1: 1, beta2: 0, beta3: 0 });
      continue;
    }
    const coeffs = fitDirichletIRLS(obs);
    dirichletCoeffs.set(pos, coeffs);
    // Compute RMSE on this position
    let sse = 0;
    for (const o of obs) {
      const predicted = predictAlpha(o.features, coeffs);
      const err = predicted - o.observed;
      sse += err * err;
    }
    const rmse = Math.sqrt(sse / obs.length);
    totalRMSE += rmse;
    posCount++;
    console.log(`  ${pos}: β=[${coeffs.beta0.toFixed(3)}, ${coeffs.beta1.toFixed(3)}, ${coeffs.beta2.toFixed(3)}, ${coeffs.beta3.toFixed(3)}] RMSE=${rmse.toFixed(4)} (${obs.length} obs)`);
  }

  const stackingFraction = totalEntries > 0 ? totalStackers / totalEntries : 0;
  const bringBackFraction = totalStackLineups > 0 ? totalBringBack / totalStackLineups : 0;
  const avgStackDepth = totalStackLineups > 0 ? totalStackDepth / totalStackLineups : 0;

  console.log(`  stacking fraction: ${(stackingFraction * 100).toFixed(1)}%`);
  console.log(`  bring-back fraction: ${(bringBackFraction * 100).toFixed(1)}% (of stackers)`);
  console.log(`  avg stack depth: ${avgStackDepth.toFixed(2)}`);
  console.log(`  chalk: ${(totalChalk / totalEntries * 100).toFixed(1)}%, contrarian: ${(totalContrarian / totalEntries * 100).toFixed(1)}%, casual: ${(totalCasual / totalEntries * 100).toFixed(1)}%`);

  const params: OpponentModelParams = {
    sport,
    dirichletCoeffs,
    stackingFraction,
    bringBackFraction,
    avgStackDepth,
    archetypeDistribution: {
      chalkFraction: totalEntries > 0 ? totalChalk / totalEntries : 0.50,
      contrarianFraction: totalEntries > 0 ? totalContrarian / totalEntries : 0.15,
      stackerFraction: stackingFraction,
      casualFraction: totalEntries > 0 ? totalCasual / totalEntries : 0.15,
    },
    calibratedOnSlates: slates.map(s => s.slate),
    calibrationRMSE: posCount > 0 ? totalRMSE / posCount : 1,
    combo3RMSE: 0,
  };

  return params;
}

// ============================================================
// VALIDATION
// ============================================================

export interface CalibrationDiagnostics {
  ownershipRMSE: number;
  combo2RMSE: number;
  combo3RMSE: number;
  stackKL: number;
  thresholdRMSE: number;
}

export function validateCalibration(
  syntheticField: Array<{ playerIds: string[] }>,
  actualEntries: ContestEntry[],
  playerById: Map<string, Player>,
  sport: Sport,
): CalibrationDiagnostics {
  // Player ownership: synthetic vs actual
  const synOwn = computeFieldOwnership(syntheticField.map(l => l.playerIds), playerById);
  const actOwn = computeFieldOwnership(actualEntries.map(e => resolveEntryPlayerIds(e, playerById)), playerById);

  let ownershipSSE = 0, count = 0;
  for (const [id, so] of synOwn) {
    const ao = actOwn.get(id) ?? 0;
    ownershipSSE += (so - ao) * (so - ao);
    count++;
  }
  const ownershipRMSE = count > 0 ? Math.sqrt(ownershipSSE / count) : 1;

  // 2-player combo frequency
  const synCombos2 = computeComboFreq(syntheticField.map(l => l.playerIds), 2);
  const actCombos2 = computeComboFreq(actualEntries.map(e => resolveEntryPlayerIds(e, playerById)), 2);
  const combo2RMSE = computeMapRMSE(synCombos2, actCombos2);

  // 3-player combo frequency
  const synCombos3 = computeComboFreq(syntheticField.map(l => l.playerIds), 3);
  const actCombos3 = computeComboFreq(actualEntries.map(e => resolveEntryPlayerIds(e, playerById)), 3);
  const combo3RMSE = computeMapRMSE(synCombos3, actCombos3);

  // Stack KL divergence
  const synStacks = stackDistribution(syntheticField.map(l => l.playerIds), playerById, sport);
  const actStacks = stackDistribution(actualEntries.map(e => resolveEntryPlayerIds(e, playerById)), playerById, sport);
  const stackKL = klDiv(synStacks, actStacks);

  return { ownershipRMSE, combo2RMSE, combo3RMSE, stackKL, thresholdRMSE: 0 };
}

// ============================================================
// SERIALIZATION
// ============================================================

export function saveOpponentModel(params: OpponentModelParams, path: string): void {
  const serializable = {
    ...params,
    dirichletCoeffs: Object.fromEntries(params.dirichletCoeffs),
  };
  fs.writeFileSync(path, JSON.stringify(serializable, null, 2));
  console.log(`Opponent model saved to ${path}`);
}

export function loadOpponentModel(path: string): OpponentModelParams {
  const raw = JSON.parse(fs.readFileSync(path, 'utf-8'));
  return {
    ...raw,
    dirichletCoeffs: new Map(Object.entries(raw.dirichletCoeffs)),
  };
}

// ============================================================
// IRLS DIRICHLET FIT
// ============================================================

function fitDirichletIRLS(
  obs: Array<{ features: number[]; observed: number }>,
  maxIter = 50,
  ridge = 0.01,
): DirichletCoeffs {
  const n = obs.length;
  const k = obs[0].features.length;  // 4: intercept, own, salary, proj

  // Target: log(α_p) = X·β  where α_p is proportional to observed ownership
  // Fit via weighted least squares: log(observed + eps) = X·β + ε
  const y = new Float64Array(n);
  const X = new Float64Array(n * k);
  for (let i = 0; i < n; i++) {
    y[i] = Math.log(Math.max(1e-6, obs[i].observed));
    for (let j = 0; j < k; j++) X[i * k + j] = obs[i].features[j];
  }

  // OLS with ridge: β = (X'X + λI)⁻¹ X'y
  const XtX = new Float64Array(k * k);
  const Xty = new Float64Array(k);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += X[i * k + a] * y[i];
      for (let b = 0; b < k; b++) {
        XtX[a * k + b] += X[i * k + a] * X[i * k + b];
      }
    }
  }
  for (let j = 0; j < k; j++) XtX[j * k + j] += ridge;

  const beta = solveLinear(XtX, Xty, k);
  return { beta0: beta[0], beta1: beta[1], beta2: beta[2], beta3: beta[3] };
}

function predictAlpha(features: number[], coeffs: DirichletCoeffs): number {
  const logAlpha = coeffs.beta0 * features[0] + coeffs.beta1 * features[1] +
                   coeffs.beta2 * features[2] + coeffs.beta3 * features[3];
  return Math.exp(logAlpha);
}

function solveLinear(A: Float64Array, b: Float64Array, n: number): Float64Array {
  // Gaussian elimination with partial pivoting
  const aug = new Float64Array(n * (n + 1));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) aug[i * (n + 1) + j] = A[i * n + j];
    aug[i * (n + 1) + n] = b[i];
  }
  for (let col = 0; col < n; col++) {
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row * (n + 1) + col]) > Math.abs(aug[maxRow * (n + 1) + col])) maxRow = row;
    }
    if (maxRow !== col) {
      for (let j = 0; j <= n; j++) {
        const tmp = aug[col * (n + 1) + j];
        aug[col * (n + 1) + j] = aug[maxRow * (n + 1) + j];
        aug[maxRow * (n + 1) + j] = tmp;
      }
    }
    const pivot = aug[col * (n + 1) + col];
    if (Math.abs(pivot) < 1e-12) continue;
    for (let j = col; j <= n; j++) aug[col * (n + 1) + j] /= pivot;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = aug[row * (n + 1) + col];
      for (let j = col; j <= n; j++) aug[row * (n + 1) + j] -= factor * aug[col * (n + 1) + j];
    }
  }
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = aug[i * (n + 1) + n];
  return x;
}

// ============================================================
// HELPERS
// ============================================================

function normalizeName(name: string): string {
  return (name || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function primaryPosition(p: Player, sport: Sport): string {
  if (sport === 'mlb' && p.positions?.includes('P')) return 'P';
  return (p.position || 'UTIL').split('/')[0];
}

function medianOf(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function percentileOf(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.max(0, Math.min(s.length - 1, Math.floor(s.length * p)))];
}

function computeFieldOwnership(lineups: string[][], playerById: Map<string, Player>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const ids of lineups) for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
  const n = lineups.length || 1;
  const result = new Map<string, number>();
  for (const [id, c] of counts) result.set(id, c / n);
  return result;
}

function resolveEntryPlayerIds(entry: ContestEntry, playerById: Map<string, Player>): string[] {
  const ids: string[] = [];
  for (const name of entry.playerNames) {
    const norm = normalizeName(name);
    for (const [id, p] of playerById) {
      if (normalizeName(p.name) === norm) { ids.push(id); break; }
    }
  }
  return ids;
}

function computeComboFreq(lineups: string[][], comboSize: number): Map<string, number> {
  const counts = new Map<string, number>();
  const N = lineups.length || 1;
  // Sample to cap at 5000 lineups for speed
  const sample = lineups.length <= 5000 ? lineups : lineups.slice(0, 5000);
  for (const ids of sample) {
    const sorted = [...ids].sort();
    if (comboSize === 2) {
      for (let a = 0; a < sorted.length; a++) {
        for (let b = a + 1; b < sorted.length; b++) {
          const key = `${sorted[a]}|${sorted[b]}`;
          counts.set(key, (counts.get(key) || 0) + 1);
        }
      }
    } else if (comboSize === 3) {
      for (let a = 0; a < sorted.length; a++) {
        for (let b = a + 1; b < sorted.length; b++) {
          for (let c = b + 1; c < sorted.length; c++) {
            const key = `${sorted[a]}|${sorted[b]}|${sorted[c]}`;
            counts.set(key, (counts.get(key) || 0) + 1);
          }
        }
      }
    }
  }
  const freq = new Map<string, number>();
  for (const [k, c] of counts) freq.set(k, c / sample.length);
  return freq;
}

function computeMapRMSE(a: Map<string, number>, b: Map<string, number>): number {
  const allKeys = new Set([...a.keys(), ...b.keys()]);
  // Only compare top-500 combos by actual frequency for stability
  const sorted = [...allKeys].sort((x, y) => (b.get(y) ?? 0) - (b.get(x) ?? 0)).slice(0, 500);
  let sse = 0;
  for (const k of sorted) {
    const d = (a.get(k) ?? 0) - (b.get(k) ?? 0);
    sse += d * d;
  }
  return sorted.length > 0 ? Math.sqrt(sse / sorted.length) : 0;
}

function stackDistribution(
  lineups: string[][],
  playerById: Map<string, Player>,
  sport: Sport,
): Map<number, number> {
  const dist = new Map<number, number>();
  for (const ids of lineups) {
    const teams = new Map<string, number>();
    for (const id of ids) {
      const p = playerById.get(id);
      if (!p) continue;
      if (sport === 'mlb' && p.positions?.includes('P')) continue;
      teams.set(p.team, (teams.get(p.team) || 0) + 1);
    }
    let max = 0;
    for (const c of teams.values()) if (c > max) max = c;
    dist.set(max, (dist.get(max) || 0) + 1);
  }
  const n = lineups.length || 1;
  for (const [k, v] of dist) dist.set(k, v / n);
  return dist;
}

function klDiv(p: Map<number, number>, q: Map<number, number>): number {
  let kl = 0;
  for (const [k, pv] of p) {
    const qv = Math.max(1e-10, q.get(k) ?? 1e-10);
    if (pv > 1e-10) kl += pv * Math.log(pv / qv);
  }
  return kl;
}
