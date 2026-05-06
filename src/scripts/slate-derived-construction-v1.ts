/**
 * Slate-Derived Construction V1.
 *
 * Architectural alternative to V1 (theory-of-dfs-v1-preslate.ts) — NOT a V1 variant.
 * Portfolio composition is derived mathematically from per-slate structural features
 * (efficient frontier, projection elasticity, nuts cluster, slate variance, scoring
 * environment, chalk concentration), not from fitted EV-blend parameters.
 *
 * Specification: C:/Users/colin/dfs opto/slate_derived_construction/SPECIFICATION.md
 * (LOCKED at Stage 1 — no edits without explicit ledger update.)
 *
 * Output target: 75 lineups per slate. Single-slate or per-slate batch invocation.
 *
 * Usage (single slate):
 *   npx ts-node src/scripts/slate-derived-construction-v1.ts \
 *       --proj  "<...>/4-12-26projections.csv" \
 *       --pool  "<...>/4-12-26sspool.csv" \
 *       --slate "4-12-26"
 *
 * Usage (batch all 24 slates from spec): omit --slate / --proj / --pool;
 * defaults to iterating the canonical 24-slate list (same as
 * theory-of-dfs-v2-validation.ts).
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';
import { exportForDraftKings, exportDetailedLineups } from '../scoring';

// ============================================================
// SPEC-LOCKED CONSTANTS (any change requires SPECIFICATION.md update)
// ============================================================
const N = 75;                                    // ASSUMPTION 1
const OWN_FLOOR = 0.1;                           // ASSUMPTION 2 (in % units)
const NUTS_K = 100;                              // ASSUMPTION 3
const ACTIVE_HITTER_PROJ_MIN = 5;                // ASSUMPTION 4
const ACTIVE_PITCHER_PROJ_MIN = 8;               // ASSUMPTION 4
const IQR_TO_SIGMA = 1.349;                      // ASSUMPTION 5
const ALPHA_NUTS = 0.15;                         // ASSUMPTION 6
const ALPHA_FRONTIER = 0.65;                     // ASSUMPTION 6
const ALPHA_DEEP = 0.20;                         // ASSUMPTION 6 (derived)
const MODE_U = [0.20, 0.50, 0.80];               // ASSUMPTION 22
const MODE_BASE_W = [0.30, 0.45, 0.25];          // ASSUMPTION 9
const MODE_SIGMA_U = 0.10;                       // ASSUMPTION 10
const ELASTICITY_PIVOT = 0.20;                   // ASSUMPTION 11
const ELASTICITY_TILT_SCALE = 0.5;               // ASSUMPTION 11/23
const NUTS_BETA = 0.05;                          // ASSUMPTION 13
const DEEP_OWN_PCTILE = 0.20;                    // ASSUMPTION 14
const DEEP_PROJ_FLOOR_FRAC = 0.85;               // ASSUMPTION 14
const BB_WEIGHT = 1.5;                           // ASSUMPTION 17
const PITCHER_BRINGBACK_BONUS = 1.5;             // ASSUMPTION 19

// ASSUMPTION 15 — empirical pro stack-size mix per band
type StackMix = Array<{ primary: number; secondary: number; weight: number }>;
const NUTS_STACK_MIX: StackMix = [
  { primary: 5, secondary: 2, weight: 0.50 },
  { primary: 5, secondary: 3, weight: 0.30 },
  { primary: 5, secondary: 1, weight: 0.20 },
];
const CHALK_CORE_STACK_MIX: StackMix = [
  { primary: 5, secondary: 2, weight: 0.50 },
  { primary: 5, secondary: 3, weight: 0.20 },
  { primary: 5, secondary: 1, weight: 0.15 },
  { primary: 4, secondary: 3, weight: 0.15 },
];
const MID_STACK_MIX: StackMix = [
  { primary: 5, secondary: 2, weight: 0.35 },
  { primary: 5, secondary: 3, weight: 0.15 },
  { primary: 4, secondary: 3, weight: 0.20 },
  { primary: 4, secondary: 2, weight: 0.15 },
  { primary: 5, secondary: 1, weight: 0.10 },
  { primary: 3, secondary: 3, weight: 0.05 },
];
const FRONTIER_DEEP_STACK_MIX: StackMix = [
  { primary: 5, secondary: 2, weight: 0.25 },
  { primary: 5, secondary: 3, weight: 0.15 },
  { primary: 4, secondary: 3, weight: 0.20 },
  { primary: 4, secondary: 2, weight: 0.15 },
  { primary: 3, secondary: 3, weight: 0.15 },
  { primary: 4, secondary: 4, weight: 0.10 },
];
const DEEP_TAIL_STACK_MIX: StackMix = [
  { primary: 5, secondary: 2, weight: 0.20 },
  { primary: 5, secondary: 3, weight: 0.10 },
  { primary: 4, secondary: 3, weight: 0.20 },
  { primary: 4, secondary: 2, weight: 0.15 },
  { primary: 3, secondary: 3, weight: 0.20 },
  { primary: 4, secondary: 4, weight: 0.15 },
];

// ASSUMPTION 16 — bring-back rate per tier
const BB_RATE_NUTS = 0.50;
const BB_RATE_CHALK_CORE = 0.30;
const BB_RATE_MID = 0.20;
const BB_RATE_FRONTIER_DEEP = 0.0;
const BB_RATE_DEEP_TAIL = 0.0;

// ============================================================
// 24-SLATE CANONICAL LIST (matches theory-of-dfs-v2-validation.ts)
// ============================================================
const DATA_DIR = 'C:/Users/colin/dfs opto';
const OUT_DIR = 'C:/Users/colin/dfs opto/slate_derived_construction';

const SLATES = [
  { slate: '4-6-26', proj: '4-6-26_projections.csv',  pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26', proj: '4-8-26projections.csv',   pool: '4-8-26sspool.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv', pool: '4-12-26sspool.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv', pool: '4-14-26sspool.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv', pool: '4-15-26sspool.csv' },
  { slate: '4-17-26', proj: '4-17-26projections.csv', pool: '4-17-26sspool.csv' },
  { slate: '4-18-26', proj: '4-18-26projections.csv', pool: '4-18-26sspool.csv' },
  { slate: '4-19-26', proj: '4-19-26projections.csv', pool: '4-19-26sspool.csv' },
  { slate: '4-20-26', proj: '4-20-26projections.csv', pool: '4-20-26sspool.csv' },
  { slate: '4-21-26', proj: '4-21-26projections.csv', pool: '4-21-26sspool.csv' },
  { slate: '4-22-26', proj: '4-22-26projections.csv', pool: '4-22-26sspool.csv' },
  { slate: '4-23-26', proj: '4-23-26projections.csv', pool: '4-23-26sspool.csv' },
  { slate: '4-24-26', proj: '4-24-26projections.csv', pool: '4-24-26sspool.csv' },
  { slate: '4-25-26', proj: '4-25-26projections.csv', pool: '4-25-26sspool.csv' },
  { slate: '4-25-26-early', proj: '4-25-26projectionsearly.csv', pool: '4-25-26sspoolearly.csv' },
  { slate: '4-26-26', proj: '4-26-26projections.csv', pool: '4-26-26sspool.csv' },
  { slate: '4-27-26', proj: '4-27-26projections.csv', pool: '4-27-26sspool.csv' },
  { slate: '4-28-26', proj: '4-28-26projections.csv', pool: '4-28-26sspool.csv' },
  { slate: '4-29-26', proj: '4-29-26projections.csv', pool: '4-29-26sspool.csv' },
  { slate: '5-1-26',  proj: '5-1-26projections.csv',  pool: '5-1-26sspool.csv' },
  { slate: '5-2-26',       proj: '5-2-26projections.csv',       pool: '5-2-26sspool.csv' },
  { slate: '5-2-26-main',  proj: '5-2-26projectionsmain.csv',   pool: '5-2-26sspoolmain.csv' },
  { slate: '5-2-26-night', proj: '5-2-26projectionsnight.csv',  pool: '5-2-26sspoolnight.csv' },
  { slate: '5-3-26',       proj: '5-3-26projections.csv',       pool: '5-3-26sspool.csv' },
];

// ============================================================
// UTILITIES
// ============================================================
function isPitcher(p: Player): boolean { return (p.position || '').toUpperCase().includes('P'); }
function mean(a: number[]): number { if (!a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; }
function median(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function stdev(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  let v = 0; for (const x of a) v += (x - m) ** 2;
  return Math.sqrt(v / a.length);
}
function clip(x: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, x)); }

// Deterministic LCG seeded by slate name (ASSUMPTIONS 20, 21).
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  if (s === 0) s = 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
function hashSeed(slate: string): number {
  let h = 2166136261;
  for (let i = 0; i < slate.length; i++) {
    h ^= slate.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function weightedSample<T>(items: T[], weights: number[], rng: () => number): T | null {
  if (!items.length) return null;
  let total = 0; for (const w of weights) total += Math.max(0, w);
  if (total <= 0) return items[Math.floor(rng() * items.length)];
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= Math.max(0, weights[i]);
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

// ============================================================
// LINEUP STRUCTURAL CHARACTERIZATION
// ============================================================
interface LineupChar {
  lu: Lineup;
  proj: number;
  geoMeanOwn: number;        // 1A.1 own(ℓ) — geomean of player own%, % units
  geoMeanOwnHit: number;     // hitter-only geomean own (matches dump's geoMeanOwnHit)
  primarySize: number;
  secondarySize: number;
  primaryTeam: string;
  primaryOpp: string;
  bringBack: number;
  numGames: number;
  numTeamsUsed: number;
  maxGameStack: number;
  salaryStd: number;
  salaryTopThree: number;
  pitchers: Player[];
  pitcherOpps: string[];
  pitcherFacesPrimaryStack: boolean;   // hard-reject flag (ASSUMPTION 18)
  pitcherSharesGameWithBringBack: boolean; // bonus flag (ASSUMPTION 19)
}

function characterize(lu: Lineup): LineupChar {
  const teamHitters = new Map<string, number>();
  const pitchers: Player[] = [];
  for (const p of lu.players) {
    if (isPitcher(p)) pitchers.push(p);
    else { const t = (p.team || '').toUpperCase(); if (t) teamHitters.set(t, (teamHitters.get(t) || 0) + 1); }
  }
  let primaryTeam = '', primarySize = 0, secondarySize = 0;
  const sortedTeams = [...teamHitters.entries()].sort((a, b) => b[1] - a[1]);
  if (sortedTeams.length > 0) { primaryTeam = sortedTeams[0][0]; primarySize = sortedTeams[0][1]; }
  if (sortedTeams.length > 1) { secondarySize = sortedTeams[1][1]; }

  let primaryOpp = '';
  for (const p of lu.players) {
    if ((p.team || '').toUpperCase() === primaryTeam) {
      const opp = (p.opponent || '').toUpperCase();
      if (opp) { primaryOpp = opp; break; }
    }
  }
  const bringBack = primaryOpp ? (teamHitters.get(primaryOpp) || 0) : 0;

  const pitcherOpps: string[] = [];
  let pitcherFacesPrimaryStack = false;
  let pitcherSharesGameWithBringBack = false;
  for (const p of pitchers) {
    const opp = (p.opponent || '').toUpperCase();
    pitcherOpps.push(opp);
    if (opp === primaryTeam) pitcherFacesPrimaryStack = true;
    if (opp === primaryOpp && primaryOpp) pitcherSharesGameWithBringBack = true;
  }

  // Geometric-mean ownership (all 10 slots) and hitter-only.
  let logOwn = 0; let nOwn = 0;
  let logOwnHit = 0; let nOwnHit = 0;
  for (const p of lu.players) {
    const o = Math.max(OWN_FLOOR, p.ownership || OWN_FLOOR);
    logOwn += Math.log(o); nOwn++;
    if (!isPitcher(p)) { logOwnHit += Math.log(o); nOwnHit++; }
  }
  const geoMeanOwn = Math.exp(logOwn / Math.max(1, nOwn));
  const geoMeanOwnHit = Math.exp(logOwnHit / Math.max(1, nOwnHit));

  // Number of distinct games (using team+opp pairs as game id; canonicalize).
  const games = new Set<string>();
  const allTeams = new Set<string>();
  const gameCounts = new Map<string, number>();
  for (const p of lu.players) {
    const t = (p.team || '').toUpperCase();
    const o = (p.opponent || '').toUpperCase();
    if (!t) continue;
    allTeams.add(t);
    const gameId = t < o ? `${t}@${o}` : `${o}@${t}`;
    games.add(gameId);
    gameCounts.set(gameId, (gameCounts.get(gameId) || 0) + 1);
  }
  let maxGameStack = 0;
  for (const c of gameCounts.values()) if (c > maxGameStack) maxGameStack = c;

  // Salary stats.
  const sals = lu.players.map(p => p.salary || 0);
  const sm = sals.reduce((a, b) => a + b, 0) / Math.max(1, sals.length);
  let sv = 0; for (const s of sals) sv += (s - sm) ** 2;
  const salaryStd = Math.sqrt(sv / Math.max(1, sals.length));
  const sortedSals = [...sals].sort((a, b) => b - a);
  const salaryTopThree = sortedSals.slice(0, 3).reduce((a, b) => a + b, 0);

  return {
    lu, proj: lu.projection, geoMeanOwn, geoMeanOwnHit,
    primarySize, secondarySize, primaryTeam, primaryOpp, bringBack,
    numGames: games.size, numTeamsUsed: allTeams.size, maxGameStack,
    salaryStd, salaryTopThree,
    pitchers, pitcherOpps, pitcherFacesPrimaryStack, pitcherSharesGameWithBringBack,
  };
}

// ============================================================
// 1A FEATURES
// ============================================================
interface SlateFeatures {
  frontier: LineupChar[];     // 1A.1 — sorted by own ascending
  elasticity: number;         // 1A.2 — ε_slate (median)
  nuts: LineupChar[];         // 1A.3 — top-100 by proj
  sigmaSlate: number;         // 1A.4
  scoringEnv: number;         // 1A.5
  chalkConcentration: number; // 1A.6
  chalkMaxOwn: number;
  chalkStdOwn: number;
}

function computeFrontier(chars: LineupChar[]): LineupChar[] {
  const sorted = [...chars].sort((a, b) => a.geoMeanOwn - b.geoMeanOwn);
  const front: LineupChar[] = [];
  let bestProj = -Infinity;
  for (const c of sorted) {
    if (c.proj > bestProj) {
      front.push(c);
      bestProj = c.proj;
    }
  }
  return front;
}

function computeElasticity(frontier: LineupChar[]): number {
  if (frontier.length < 2) return ELASTICITY_PIVOT;
  const eps: number[] = [];
  for (let k = 0; k < frontier.length - 1; k++) {
    const f1 = frontier[k], f2 = frontier[k + 1];
    const dp = f2.proj - f1.proj;
    const doE = f2.geoMeanOwn - f1.geoMeanOwn;
    if (Math.abs(doE) < 1e-9 || f1.proj <= 0 || f1.geoMeanOwn <= 0) continue;
    const e = (dp / f1.proj) / (doE / f1.geoMeanOwn);
    if (isFinite(e)) eps.push(e);
  }
  if (eps.length === 0) return ELASTICITY_PIVOT;
  return median(eps);
}

function computeSlateVariance(players: Player[]): number {
  const cvs: number[] = [];
  for (const p of players) {
    const isP = isPitcher(p);
    const min = isP ? ACTIVE_PITCHER_PROJ_MIN : ACTIVE_HITTER_PROJ_MIN;
    if ((p.projection || 0) < min) continue;
    if (!p.percentiles) continue;
    const p25 = p.percentiles.p25, p75 = p.percentiles.p75;
    if (p25 == null || p75 == null) continue;
    const sigma = (p75 - p25) / IQR_TO_SIGMA;
    const cv = sigma / Math.max(0.5, p.projection);
    if (isFinite(cv) && cv > 0) cvs.push(cv);
  }
  return cvs.length ? mean(cvs) : 0.3;
}

function computeScoringEnv(players: Player[]): number {
  const teamTotals = new Map<string, number>();
  for (const p of players) {
    const t = (p.team || '').toUpperCase();
    if (!t) continue;
    const tt = (p as any).teamTotal || 0;
    if (tt > 0 && !teamTotals.has(t)) teamTotals.set(t, tt);
  }
  let s = 0;
  for (const tt of teamTotals.values()) s += tt;
  return s;
}

function computeChalkConcentration(players: Player[]): { c: number; maxOwn: number; stdOwn: number } {
  const owns: number[] = [];
  for (const p of players) {
    const isP = isPitcher(p);
    const min = isP ? ACTIVE_PITCHER_PROJ_MIN : ACTIVE_HITTER_PROJ_MIN;
    if ((p.projection || 0) < min) continue;
    owns.push(p.ownership || 0);
  }
  if (!owns.length) return { c: 1, maxOwn: 0, stdOwn: 0 };
  const mx = Math.max(...owns);
  const mn = mean(owns);
  return { c: mn > 0 ? mx / mn : 1, maxOwn: mx, stdOwn: stdev(owns) };
}

function extractFeatures(chars: LineupChar[], players: Player[]): SlateFeatures {
  const frontier = computeFrontier(chars);
  const elasticity = computeElasticity(frontier);
  const nuts = [...chars].sort((a, b) => b.proj - a.proj).slice(0, NUTS_K);
  const sigmaSlate = computeSlateVariance(players);
  const scoringEnv = computeScoringEnv(players);
  const cc = computeChalkConcentration(players);
  return {
    frontier, elasticity, nuts, sigmaSlate, scoringEnv,
    chalkConcentration: cc.c, chalkMaxOwn: cc.maxOwn, chalkStdOwn: cc.stdOwn,
  };
}

// ============================================================
// 1B SAMPLING
// ============================================================
function gaussianPdf(u: number, mu: number, sigma: number): number {
  const d = (u - mu) / sigma;
  return Math.exp(-0.5 * d * d) / (sigma * Math.sqrt(2 * Math.PI));
}

interface Mode { name: 'chalk-core' | 'mid' | 'frontier-deep'; u: number; weight: number; mix: StackMix; bbRate: number; }

function modeForFrontier(features: SlateFeatures): Mode[] {
  const eta = clip((features.elasticity - ELASTICITY_PIVOT) / ELASTICITY_PIVOT, -1, 1);
  const w0 = MODE_BASE_W[0] * (1 + ELASTICITY_TILT_SCALE * eta);
  const w1 = MODE_BASE_W[1];
  const w2 = MODE_BASE_W[2] * (1 - ELASTICITY_TILT_SCALE * eta);
  const total = w0 + w1 + w2;
  return [
    { name: 'chalk-core',    u: MODE_U[0], weight: w0 / total, mix: CHALK_CORE_STACK_MIX,    bbRate: BB_RATE_CHALK_CORE },
    { name: 'mid',           u: MODE_U[1], weight: w1 / total, mix: MID_STACK_MIX,           bbRate: BB_RATE_MID },
    { name: 'frontier-deep', u: MODE_U[2], weight: w2 / total, mix: FRONTIER_DEEP_STACK_MIX, bbRate: BB_RATE_FRONTIER_DEEP },
  ];
}

interface SamplingMeta {
  tier: 'nuts' | 'frontier' | 'deep-tail';
  mode: string;
  uTarget: number | null;
  stackPattern: { primary: number; secondary: number };
  bringBackRequired: boolean;
}

interface SampledLineup { ch: LineupChar; meta: SamplingMeta; }

function filterStackPattern(chars: LineupChar[], primary: number, secondary: number): LineupChar[] {
  return chars.filter(c => c.primarySize === primary && c.secondarySize === secondary && !c.pitcherFacesPrimaryStack);
}

function sampleFromCell(
  cellChars: LineupChar[],
  rng: () => number,
  bringBackRequired: boolean,
  uTarget: number | null,
  uMin: number,
  uMax: number,
): LineupChar | null {
  if (!cellChars.length) return null;
  const candidates = uTarget == null ? cellChars : cellChars; // own-rank used in weights for frontier
  const weights: number[] = [];
  for (const c of candidates) {
    let w = 1.0;
    // Bring-back weight (ASSUMPTION 17)
    if (bringBackRequired) {
      w *= c.bringBack >= 1 ? BB_WEIGHT : 1.0;
    }
    // Pitcher-bring-back bonus (ASSUMPTION 19)
    if (c.pitcherSharesGameWithBringBack) w *= PITCHER_BRINGBACK_BONUS;
    // Frontier u-targeted weighting via Gaussian
    if (uTarget != null) {
      // candidate's u is its own-rank position within the cell (already sliced to [uMin,uMax]).
      // We weight by Gaussian centered at uTarget within global [0,1].
      const idx = candidates.indexOf(c);
      const u = uMin + (idx / Math.max(1, candidates.length - 1)) * (uMax - uMin);
      w *= gaussianPdf(u, uTarget, MODE_SIGMA_U);
    }
    weights.push(w);
  }
  return weightedSample(candidates, weights, rng);
}

// Reservoir sampler that draws K unique items from `pool` according to weights/Gaussian.
function sampleK(
  pool: LineupChar[],
  k: number,
  rng: () => number,
  bringBackRequired: boolean,
  uTarget: number | null,
  uMin: number,
  uMax: number,
  taken: Set<string>,
): LineupChar[] {
  const out: LineupChar[] = [];
  let working = pool.filter(c => !taken.has(c.lu.hash));
  while (out.length < k && working.length > 0) {
    const pick = sampleFromCell(working, rng, bringBackRequired, uTarget, uMin, uMax);
    if (!pick) break;
    out.push(pick);
    taken.add(pick.lu.hash);
    working = working.filter(c => c.lu.hash !== pick.lu.hash);
  }
  return out;
}

// ============================================================
// PORTFOLIO BUILD
// ============================================================
interface PortfolioBuildResult {
  selected: SampledLineup[];
  features: SlateFeatures;
  modes: Mode[];
  diagnostics: Record<string, any>;
}

function build(allChars: LineupChar[], features: SlateFeatures, rng: () => number): PortfolioBuildResult {
  const taken = new Set<string>();
  const selected: SampledLineup[] = [];

  // ----- 1B.3 Nuts anchor -----
  const nNuts = Math.round(N * ALPHA_NUTS);
  // Sort nuts by descending proj; weight by exp(-β · rank). Filter pitcher-vs-stack.
  const nutsSorted = [...features.nuts].filter(c => !c.pitcherFacesPrimaryStack);
  const nutsByMix: LineupChar[] = nutsSorted; // nuts mix is a subset filter; we relax to "any 5-stack" to keep mass
  // Apply nuts-stack mix soft filter — prefer those matching {(5,2),(5,3),(5,1)}
  function inNutsMix(c: LineupChar): boolean {
    return NUTS_STACK_MIX.some(m => m.primary === c.primarySize && m.secondary === c.secondarySize);
  }
  const nutsPreferred = nutsByMix.filter(inNutsMix);
  const nutsPool = nutsPreferred.length >= nNuts ? nutsPreferred : nutsByMix;
  // Weighted sample by exp(-β · rank-in-nuts-by-proj-desc).
  const nutsWeights = nutsPool.map((c, idx) => {
    let w = Math.exp(-NUTS_BETA * idx);
    if (c.pitcherSharesGameWithBringBack) w *= PITCHER_BRINGBACK_BONUS;
    if (c.bringBack >= 1) w *= BB_WEIGHT; // BB_RATE_NUTS = 0.50
    return w;
  });
  const nutsTaken = new Set<string>();
  while (selected.filter(s => s.meta.tier === 'nuts').length < nNuts && nutsPool.length > nutsTaken.size) {
    const items = nutsPool.filter(c => !nutsTaken.has(c.lu.hash) && !taken.has(c.lu.hash));
    if (!items.length) break;
    const w = items.map((c, idx) => {
      const origIdx = nutsPool.indexOf(c);
      return nutsWeights[origIdx];
    });
    const pick = weightedSample(items, w, rng);
    if (!pick) break;
    nutsTaken.add(pick.lu.hash);
    taken.add(pick.lu.hash);
    selected.push({ ch: pick, meta: { tier: 'nuts', mode: 'nuts', uTarget: null, stackPattern: { primary: pick.primarySize, secondary: pick.secondarySize }, bringBackRequired: true } });
  }

  // ----- 1B.2 Frontier body -----
  const nFrontier = Math.round(N * ALPHA_FRONTIER);
  const modes = modeForFrontier(features);

  // For each mode, distribute the mode's count across stack patterns by mix weights.
  const modeCounts = modes.map(m => Math.round(nFrontier * m.weight));
  // Adjust for rounding so sum = nFrontier
  let diff = nFrontier - modeCounts.reduce((a, b) => a + b, 0);
  for (let i = 0; i < Math.abs(diff); i++) {
    modeCounts[i % modes.length] += diff > 0 ? 1 : -1;
  }

  // Frontier as own-sorted ascending (already constructed that way in computeFrontier)
  // But we sample from the FULL candidate pool, not just F itself, weighted by Gaussian
  // over own-rank u in [0,1] (allows mode to draw nearby off-frontier lineups).
  const allByOwn = [...allChars].filter(c => !c.pitcherFacesPrimaryStack)
    .sort((a, b) => a.geoMeanOwn - b.geoMeanOwn);
  // Assign u-coordinates to all candidates by own-rank
  const allWithU: { c: LineupChar; u: number }[] = allByOwn.map((c, i) => ({
    c, u: allByOwn.length > 1 ? i / (allByOwn.length - 1) : 0.5,
  }));

  for (let mi = 0; mi < modes.length; mi++) {
    const m = modes[mi];
    const target = modeCounts[mi];
    if (target <= 0) continue;
    // Decompose target across stack patterns by mix weights.
    const stackCounts = m.mix.map(s => Math.round(target * s.weight));
    let diffStack = target - stackCounts.reduce((a, b) => a + b, 0);
    for (let i = 0; i < Math.abs(diffStack); i++) stackCounts[i % m.mix.length] += diffStack > 0 ? 1 : -1;

    for (let si = 0; si < m.mix.length; si++) {
      const stack = m.mix[si];
      let need = stackCounts[si];
      if (need <= 0) continue;
      // Filter candidate pool to this stack pattern.
      const cellPool = allWithU.filter(x => x.c.primarySize === stack.primary && x.c.secondarySize === stack.secondary && !taken.has(x.c.lu.hash));
      if (!cellPool.length) {
        // Reallocation: dump need into adjacent stack-pattern (next in mix).
        const nextIdx = (si + 1) % m.mix.length;
        stackCounts[nextIdx] += need;
        continue;
      }
      // Per-candidate weights = Gaussian(u; mu=mode.u, sigma=σ_u) × bringBack × pitcher-bonus
      const bringBackRequired = rng() < m.bbRate; // bernoulli per draw approximated below
      while (need > 0) {
        const live = cellPool.filter(x => !taken.has(x.c.lu.hash));
        if (!live.length) break;
        const bbThisDraw = rng() < m.bbRate;
        const weights = live.map(x => {
          let w = gaussianPdf(x.u, m.u, MODE_SIGMA_U);
          if (bbThisDraw) w *= x.c.bringBack >= 1 ? BB_WEIGHT : 1.0;
          if (x.c.pitcherSharesGameWithBringBack) w *= PITCHER_BRINGBACK_BONUS;
          return w;
        });
        const pickEntry = weightedSample(live, weights, rng);
        if (!pickEntry) break;
        taken.add(pickEntry.c.lu.hash);
        selected.push({ ch: pickEntry.c, meta: { tier: 'frontier', mode: m.name, uTarget: m.u, stackPattern: { primary: stack.primary, secondary: stack.secondary }, bringBackRequired: bbThisDraw } });
        need--;
      }
    }
  }

  // ----- 1B.4 Deep-contrarian tail -----
  const nDeep = N - selected.length;
  // bottom-20% own at proj >= 0.85 * max_proj
  const ownsSorted = [...allChars].map(c => c.geoMeanOwn).sort((a, b) => a - b);
  const ownThresh = ownsSorted[Math.floor(ownsSorted.length * DEEP_OWN_PCTILE)];
  const maxProj = Math.max(...allChars.map(c => c.proj));
  const deepPool = allChars.filter(c =>
    !c.pitcherFacesPrimaryStack &&
    c.geoMeanOwn <= ownThresh &&
    c.proj >= DEEP_PROJ_FLOOR_FRAC * maxProj &&
    !taken.has(c.lu.hash)
  );

  // Decompose nDeep across DEEP_TAIL_STACK_MIX
  const deepStackCounts = DEEP_TAIL_STACK_MIX.map(s => Math.round(nDeep * s.weight));
  let dDiff = nDeep - deepStackCounts.reduce((a, b) => a + b, 0);
  for (let i = 0; i < Math.abs(dDiff); i++) deepStackCounts[i % DEEP_TAIL_STACK_MIX.length] += dDiff > 0 ? 1 : -1;

  for (let si = 0; si < DEEP_TAIL_STACK_MIX.length; si++) {
    const s = DEEP_TAIL_STACK_MIX[si];
    let need = deepStackCounts[si];
    if (need <= 0) continue;
    let cellPool = deepPool.filter(c => c.primarySize === s.primary && c.secondarySize === s.secondary && !taken.has(c.lu.hash));
    if (!cellPool.length) {
      // Reallocate to next-best stack pattern within deep tail.
      const nextIdx = (si + 1) % DEEP_TAIL_STACK_MIX.length;
      deepStackCounts[nextIdx] += need;
      continue;
    }
    while (need > 0 && cellPool.length > 0) {
      const weights = cellPool.map(c => c.pitcherSharesGameWithBringBack ? PITCHER_BRINGBACK_BONUS : 1.0);
      const pick = weightedSample(cellPool, weights, rng);
      if (!pick) break;
      taken.add(pick.lu.hash);
      cellPool = cellPool.filter(c => c.lu.hash !== pick.lu.hash);
      selected.push({ ch: pick, meta: { tier: 'deep-tail', mode: 'deep', uTarget: null, stackPattern: { primary: s.primary, secondary: s.secondary }, bringBackRequired: false } });
      need--;
    }
  }

  // If we under-shot (slate too small / cells empty), fill from any remaining pool (lowest own first).
  if (selected.length < N) {
    const remaining = allChars
      .filter(c => !taken.has(c.lu.hash) && !c.pitcherFacesPrimaryStack)
      .sort((a, b) => a.geoMeanOwn - b.geoMeanOwn);
    for (const c of remaining) {
      if (selected.length >= N) break;
      taken.add(c.lu.hash);
      selected.push({ ch: c, meta: { tier: 'deep-tail', mode: 'fill', uTarget: null, stackPattern: { primary: c.primarySize, secondary: c.secondarySize }, bringBackRequired: false } });
    }
  }

  return {
    selected: selected.slice(0, N),
    features,
    modes,
    diagnostics: {
      elasticity: features.elasticity,
      eta_chalk: clip((features.elasticity - ELASTICITY_PIVOT) / ELASTICITY_PIVOT, -1, 1),
      modeWeights: modes.map(m => ({ name: m.name, w: m.weight })),
      sigmaSlate: features.sigmaSlate,
      scoringEnv: features.scoringEnv,
      chalkConcentration: features.chalkConcentration,
      nutsK: features.nuts.length,
      frontierSize: features.frontier.length,
    },
  };
}

// ============================================================
// SLATE RUNNER
// ============================================================
async function runSlate(slate: string, projFile: string, poolFile: string): Promise<{ slate: string; lineups: Lineup[]; details: any[]; diagnostics: any } | null> {
  const projPath = path.join(DATA_DIR, projFile);
  const poolPath = path.join(DATA_DIR, poolFile);
  if (!fs.existsSync(projPath)) { console.warn(`Skip ${slate}: missing ${projFile}`); return null; }
  if (!fs.existsSync(poolPath)) { console.warn(`Skip ${slate}: missing ${poolFile}`); return null; }

  const pr = parseCSVFile(projPath, 'mlb', true);
  const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
  const pool = buildPlayerPool(pr.players, pr.detectedContestType);
  const idMap = new Map<string, Player>();
  for (const p of pool.players) idMap.set(p.id, p);
  const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
  // Deduplicate
  const merged = new Map<string, Lineup>();
  for (const lu of loaded.lineups) if (!merged.has(lu.hash)) merged.set(lu.hash, lu);
  const candidates = Array.from(merged.values());
  if (candidates.length === 0) { console.warn(`Skip ${slate}: empty pool`); return null; }

  // Characterize
  const chars = candidates.map(characterize);
  const features = extractFeatures(chars, pool.players);
  const seed = hashSeed(slate);
  const rng = makeRng(seed);

  const result = build(chars, features, rng);

  // Diagnostics
  const lineups = result.selected.map(s => s.ch.lu);
  const details = result.selected.map((s, idx) => ({
    rank: idx + 1,
    tier: s.meta.tier,
    mode: s.meta.mode,
    stackPattern: `${s.meta.stackPattern.primary}-${s.meta.stackPattern.secondary}`,
    bringBackRequired: s.meta.bringBackRequired,
    primarySize: s.ch.primarySize,
    secondarySize: s.ch.secondarySize,
    primaryTeam: s.ch.primaryTeam,
    primaryOpp: s.ch.primaryOpp,
    bringBack: s.ch.bringBack,
    numGames: s.ch.numGames,
    numTeamsUsed: s.ch.numTeamsUsed,
    maxGameStack: s.ch.maxGameStack,
    salaryStd: s.ch.salaryStd,
    salaryTopThree: s.ch.salaryTopThree,
    proj: s.ch.proj,
    geoMeanOwn: s.ch.geoMeanOwn,
    geoMeanOwnHit: s.ch.geoMeanOwnHit,
    salaryTotal: s.ch.lu.salary,
    pitcherFacesStack: s.ch.pitcherFacesPrimaryStack,
    pitcherSharesGameWithBringBack: s.ch.pitcherSharesGameWithBringBack,
    playerNames: s.ch.lu.players.map(p => p.name).join(';'),
    playerIds: s.ch.lu.players.map(p => p.id).join(';'),
    playerTeams: s.ch.lu.players.map(p => p.team || '').join(';'),
    playerOwn: s.ch.lu.players.map(p => (p.ownership || 0).toFixed(2)).join(';'),
  }));

  // Output
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const dkPath = path.join(OUT_DIR, `${slate}_dk.csv`);
  const detPath = path.join(OUT_DIR, `${slate}_detail.csv`);
  exportForDraftKings(lineups, config, dkPath);
  // Hand-rolled detail CSV.
  writeDetailCSV(details, detPath);

  console.log(`  [${slate}] candidates=${candidates.length} portfolio=${lineups.length}/${N} ` +
    `ε=${features.elasticity.toFixed(3)} σ=${features.sigmaSlate.toFixed(3)} ` +
    `T=${features.scoringEnv.toFixed(1)} cc=${features.chalkConcentration.toFixed(2)}`);
  return { slate, lineups, details, diagnostics: result.diagnostics };
}

function writeDetailCSV(details: any[], outPath: string) {
  if (!details.length) { fs.writeFileSync(outPath, '', 'utf-8'); return; }
  const headers = Object.keys(details[0]);
  const lines = [headers.join(',')];
  for (const d of details) {
    lines.push(headers.map(h => {
      const v = d[h];
      if (v == null) return '';
      const s = String(v);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`;
      return s;
    }).join(','));
  }
  fs.writeFileSync(outPath, lines.join('\n'), 'utf-8');
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log('================================================================');
  console.log('SLATE-DERIVED CONSTRUCTION V1 (locked Stage 1 spec)');
  console.log('================================================================\n');

  // Parse args
  const args = process.argv.slice(2);
  const argMap: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && i + 1 < args.length) {
      argMap[args[i].slice(2)] = args[i + 1];
      i++;
    }
  }

  if (argMap.slate) {
    const slate = argMap.slate;
    const projFile = argMap.proj ? path.basename(argMap.proj) : `${slate}projections.csv`;
    const poolFile = argMap.pool ? path.basename(argMap.pool) : `${slate}sspool.csv`;
    await runSlate(slate, projFile, poolFile);
  } else {
    const summaryRows: any[] = [];
    for (const s of SLATES) {
      const r = await runSlate(s.slate, s.proj, s.pool);
      if (r) summaryRows.push({ slate: s.slate, n: r.lineups.length, ...r.diagnostics });
    }
    const summaryPath = path.join(OUT_DIR, 'run_summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(summaryRows, null, 2), 'utf-8');
    console.log(`\nWrote summary: ${summaryPath}`);
  }

  console.log('\n================================================================');
  console.log('DONE — slate-derived-construction-v1');
  console.log('================================================================');
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });
