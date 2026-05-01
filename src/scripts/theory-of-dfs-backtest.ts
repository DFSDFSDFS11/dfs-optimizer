/**
 * Theory-of-DFS System — Head-to-head backtest vs Hermes-A.
 *
 * Implements the framework from "Theory of DFS for Advanced Players" (Jordan/BlenderHD)
 * across 17 MLB slates (with 4-25-26 split into early/late) and compares to Hermes-A's
 * bin-allocation system on identical data.
 *
 * Framework chapters operationalized:
 *   Ch.4 Levers          — 3 levers (projection, correlation, leverage). RV is a sub-mechanic of leverage.
 *   Ch.5 Relative Value  — salary inefficiency + ownership inefficiency + direct leverage.
 *   Ch.6 Combinatorics   — pair/triple uniqueness vs field equilibrium.
 *   Ch.7 Archetypes      — 10 contextual variables → per-slate variance target & projection floor.
 *   Ch.8 Portfolio Dyn.  — variance bands + frequency optimization + diversification.
 *   Ch.9 Exploits        — Sim-output adjustment (high-Sim-Optimals players → bumped ownership).
 *
 * Note on framework vs spec vs impl: the framework (chapters) is qualitative on most magnitudes.
 * Every numerical choice in TODFS_PARAMS is documented inline as one of:
 *   - "framework: ..." → number stated in source (illustrative or definitive)
 *   - "spec: ..." → number from user's Theory-DFS implementation spec
 *   - "impl: ..." → my implementation choice where neither framework nor spec specified a value
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player, ContestConfig } from '../types';
import {
  parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals,
} from '../parser';
import { getContestConfig } from '../rules';
import { productionSelect } from '../selection/production-selector';
import { precomputeComboFrequencies } from '../selection/combo-leverage';

// ============================================================
// CONSTANTS
// ============================================================

const DIR = 'C:/Users/colin/dfs opto';
const OUT_DIR = path.join(DIR, 'theory_dfs_system');
const FEE = 20;
const N = 150;

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const SLATES = [
  { slate: '4-6-26',  proj: '4-6-26_projections.csv',      actuals: 'dkactuals 4-6-26.csv',     pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26',  proj: '4-8-26projections.csv',       actuals: '4-8-26actuals.csv',        pool: '4-8-26sspool.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv',      actuals: '4-12-26actuals.csv',       pool: '4-12-26sspool.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv',      actuals: '4-14-26actuals.csv',       pool: '4-14-26sspool.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv',      actuals: '4-15-26actuals.csv',       pool: '4-15-26sspool.csv' },
  { slate: '4-17-26', proj: '4-17-26projections.csv',      actuals: '4-17-26actuals.csv',       pool: '4-17-26sspool.csv' },
  { slate: '4-18-26', proj: '4-18-26projections.csv',      actuals: '4-18-26actuals.csv',       pool: '4-18-26sspool.csv' },
  { slate: '4-19-26', proj: '4-19-26projections.csv',      actuals: '4-19-26actuals.csv',       pool: '4-19-26sspool.csv' },
  { slate: '4-20-26', proj: '4-20-26projections.csv',      actuals: '4-20-26actuals.csv',       pool: '4-20-26sspool.csv' },
  { slate: '4-21-26', proj: '4-21-26projections.csv',      actuals: '4-21-26actuals.csv',       pool: '4-21-26sspool.csv' },
  { slate: '4-22-26', proj: '4-22-26projections.csv',      actuals: '4-22-26actuals.csv',       pool: '4-22-26sspool.csv' },
  { slate: '4-23-26', proj: '4-23-26projections.csv',      actuals: '4-23-26actuals.csv',       pool: '4-23-26sspool.csv' },
  { slate: '4-24-26', proj: '4-24-26projections.csv',      actuals: '4-24-26actuals.csv',       pool: '4-24-26sspool.csv' },
  { slate: '4-25-26', proj: '4-25-26projections.csv',      actuals: '4-25-26actuals.csv',       pool: '4-25-26sspool.csv' },
  { slate: '4-25-26-early', proj: '4-25-26projectionsearly.csv', actuals: '4-25-26actualsearly.csv', pool: '4-25-26sspoolearly.csv' },
  { slate: '4-26-26', proj: '4-26-26projections.csv',      actuals: '4-26-26actuals.csv',       pool: '4-26-26sspool.csv' },
  { slate: '4-27-26', proj: '4-27-26projections.csv',      actuals: '4-27-26actuals.csv',       pool: '4-27-26sspool.csv' },
  { slate: '4-28-26', proj: '4-28-26projections.csv',      actuals: '4-28-26actuals.csv',       pool: '4-28-26sspool.csv' },
];

// ============================================================
// HERMES-A CONFIG — canonical, frozen for fair comparison
// ============================================================
// Source: production-preslate.ts ("HERMES-A — actual sweep config"). N=150 for backtest.
const HERMES_A = {
  lambda: 0.58,
  gamma: 5,
  teamCapPct: 0.26,
  minPrimaryStack: 4,
  maxExposure: 0.21,
  maxExposurePitcher: 0.41,
  extremeCornerCap: true,
  comboPower: 4,
  binAllocation: { chalk: 0.50, core: 0.30, value: 0.20, contra: 0.00, deep: 0.00 },
};

// ============================================================
// THEORY-OF-DFS PARAMS — every numerical choice documented
// ============================================================
const TODFS_PARAMS = {
  // ── Stage 1B Correlation (Ch.4 / Ch.7) ──
  STACK_BONUS_PER_HITTER: 0.10,        // framework Ch.7: "let's say MLB hitter-hitter ≈ 10%" (illustrative)
  BRINGBACK_1: 0.05,                    // spec: 0.05 for 1 BB
  BRINGBACK_2: 0.08,                    // spec: 0.08 for 2 BBs
  PITCHER_VS_HITTER_PENALTY: -0.10,    // framework Ch.7: P-vs-opposing-H ≈ -10% (illustrative)
  // Hard structural constraint — MLB correlation lever made concrete.
  // Framework Ch.4 says correlation is a "lever" (soft); but for MLB, framework Ch.7 + Ch.8
  // imply 4+ hitter stacks are the operative correlation primitive. Soft bonus alone produced
  // 56% stack rate vs Hermes-A's 99% (baseline run). Implementing as hard floor matches Hermes-A's
  // empirical finding that 4+ stacks dominate MLB GPP outcomes.
  MIN_PRIMARY_STACK: 4,                 // impl: hard constraint added 2026-04-30 after baseline diagnostic

  // ── Stage 1D Relative Value (Ch.5) ──
  OWNERSHIP_EFFICIENCY_EXPONENT: 0.5,  // spec (range 0.3-0.8); framework gives no formula
  DIRECT_LEVERAGE_BONUS: 0.03,         // impl: 3% bonus if primary stack opposes top-3 projected SP

  // ── Stage 1E Combinatorial (Ch.6) ──
  PAIR_CORR_SAME_TEAM: 1.5,            // spec
  PAIR_CORR_OPPOSING: 0.7,             // spec
  PAIR_CORR_UNRELATED: 1.0,            // spec
  TRIPLES_EVALUATED: 3,                 // spec: top-3 most-correlated triples per lineup

  // ── Stage 1F Archetype (Ch.7) ──
  HITTER_VARIANCE_MULT: 1.3,           // spec; framework Ch.7 says hitters bimodal (qualitative)
  PITCHER_VARIANCE_MULT: 1.0,
  // Per-slate variance_target & projection_floor selected from team count.
  // Impl: small slates need lower variance target (less pool), higher proj floor (less depth).
  // Larger slates allow more variance, lower proj floor.

  // ── Stage 2 EV weights (per spec, no sweeping) ──
  W_PROJ: 1.0,                          // implicit: median + corr_adj is "the baseline"; normalized
  W_LEV:  0.30,                         // spec: 0.30 (range 0.15-0.50)
  W_RV:   0.20,                         // spec: 0.20 (range 0.10-0.30)
  W_CMB:  0.25,                         // spec: 0.25 (range 0.10-0.40)
  W_VAR:  0.15,                         // spec: 0.15 (range 0.05-0.25)
  W_CEIL_EFF: 0.10,                     // Ch.9 #2 Median-overweighting: ceiling/median ratio percentile.
                                         // Framework: "median delta of 2-3 points may be inside variance noise" — exploit by preferring wider variance at similar median.

  // ── Stage 3A Frequency optimization (Ch.8) ──
  EXPLOITATIVE_EXPONENT: 1.5,          // spec (range 1.0-2.5); framework says "scale by inefficiency" (qualitative)
  EXPOSURE_CAP_HITTER: 0.50,           // spec
  EXPOSURE_CAP_PITCHER: 0.60,          // spec

  // ── Stage 3B Variance bands (Ch.8) ──
  BAND_HIGH_PCT: 0.20,                  // spec; framework Ch.8 "maybe 20" (illustrative)
  BAND_MID_PCT:  0.60,
  BAND_LOW_PCT:  0.20,

  // ── Stage 3C Diversification ──
  MAX_PAIRWISE_OVERLAP: 6,             // matches Hermes-A's gamma=5 + 1 (so the constraint isn't strictly tighter)
  TRIPLE_FREQ_CAP: 5,                  // spec: reject lineup if any top-3 triple appears 5+ times already

  // ── Ch.9 Exploit #9: Sim-output ownership adjustment ──
  // Framework Ch.9 #9: public sim output gets read by field; high-Sim-Optimals players become over-owned.
  // Impl: if a player's "Sim Optimals" rank is in top 5%, BUMP their ownership +5pp before scoring.
  SIM_OPTIMALS_OWN_BUMP_PP: 5.0,
  SIM_OPTIMALS_TOP_PCT: 0.05,

  // ── Ch.9 Exploit #4: Optimizer Point-Per-Dollar bias ──
  // Framework Ch.9 #4: optimizers over-pick "cheap-stud combo" lineups (e.g. $10K + $4K vs balanced $7K+$7K).
  // Field uses these at 60-70% rate vs balanced at 10-20%. Exploit: BUMP ownership for top-PPD players
  // (since field will over-pick them), AND apply EV penalty for lineups whose total-lineup-PPD is in top
  // 10% of pool (these are the "knapsack-solution" lineups field over-uses).
  PPD_OWN_BUMP_PP: 3.0,
  PPD_TOP_PCT: 0.10,
  PPD_LINEUP_PENALTY: 0.10,
  PPD_LINEUP_TOP_PCT: 0.10,

  // ── Ch.9 Exploit #1: Projection fragility ──
  // Framework: opponents treat fragile projections as confident. High-stdDev players are over- or
  // under-bought relative to true variance. Impl: bump ownership +2pp for top-10% stdDev players
  // (field over-buys these when bullish, leaving leverage available either direction).
  // Note: requires player stdDev field; falls back to no-op if not present.
  FRAGILITY_OWN_BUMP_PP: 2.0,
  FRAGILITY_TOP_PCT: 0.10,

  // ── Ch.9 Exploit #5: Insufficient randomness (ultra-chalk avoidance) ──
  // Framework: opponents using 0% randomness produce predictable ultra-chalk lineups. Avoid those
  // exact constructions. Impl: detect lineups containing 4+ players from the top-25%-owned slate
  // set; apply small EV penalty. (Strong overlap with leverage lever — small magnitude OK.)
  ULTRA_CHALK_PLAYER_THRESHOLD_PCT: 0.75,  // top quartile ownership = "ultra-chalk player"
  ULTRA_CHALK_LINEUP_MIN_COUNT: 5,         // 5+ ultra-chalk players in a 10-player MLB lineup
  ULTRA_CHALK_PENALTY: 0.05,                // 5% EV multiplier penalty

  // ── Ch.9 Exploit #8: Hard-coded correlation constraint misuse (PPD-team 5-stack) ──
  // Framework: when a high-PPD player is on a stackable team, optimizers over-channel into 5-stacks
  // of that team. Impl: detect if primary stack of 5 contains a top-3-PPD player from same team.
  // Apply small EV penalty for these saturated constructions.
  PPD_STACK_PENALTY: 0.05,

  // ── Ch.7 Archetype: High Score / Nuts gap modifier ──
  // Framework: when "the nuts" is unattainable (large slate), more variance OK. When close to nuts
  // is achievable (small slate, tight pool), variance is bad. Impl: compute optimal lineup proj,
  // measure gap to top-5% pool proj, scale variance_target accordingly.
  // (Already partial via slate team count. This makes it explicit and projection-based.)
  NUTS_GAP_HIGH_THRESHOLD: 0.08,            // gap > 8% = lots of variance possible (large slate)
  NUTS_GAP_LOW_THRESHOLD: 0.03,             // gap < 3% = tight cluster, less variance OK
};

// ============================================================
// UTILS
// ============================================================

function norm(n: string): string {
  return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function mean(a: number[]): number { if (!a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; }
function stddev(a: number[]): number { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); }

function rankPercentile(values: number[]): number[] {
  // Returns [0,1] percentile rank for each value (higher value -> higher pctile).
  const idx = values.map((v, i) => ({ v, i }));
  idx.sort((a, b) => a.v - b.v);
  const out = new Array<number>(values.length);
  const n = values.length;
  for (let r = 0; r < n; r++) {
    out[idx[r].i] = n > 1 ? r / (n - 1) : 0;
  }
  return out;
}

// ============================================================
// PAYOUT MODEL — identical to production-backtest.ts
// ============================================================

function buildPayoutTable(F: number): Float64Array {
  const pool = F * FEE * 0.88;
  const cashLine = Math.floor(F * 0.22);
  const raw = new Float64Array(cashLine);
  let rawSum = 0;
  for (let r = 0; r < cashLine; r++) {
    raw[r] = Math.pow(r + 1, -1.15);
    rawSum += raw[r];
  }
  const table = new Float64Array(F);
  const minCash = FEE * 1.2;
  for (let r = 0; r < cashLine; r++) {
    table[r] = Math.max(minCash, (raw[r] / rawSum) * pool);
  }
  let tSum = 0;
  for (let r = 0; r < cashLine; r++) tSum += table[r];
  const scale = pool / tSum;
  for (let r = 0; r < cashLine; r++) table[r] *= scale;
  return table;
}

function scorePortfolio(
  portfolio: Lineup[],
  actuals: ContestActuals,
  payoutTable: Float64Array,
): { totalPayout: number; t1: number; t01: number; scored: number; finishPctiles: number[] } {
  const F = actuals.entries.length;
  const sorted = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
  const top1T = sorted[Math.max(0, Math.floor(F * 0.01) - 1)] || 0;
  const top01T = sorted[Math.max(0, Math.floor(F * 0.001) - 1)] || 0;

  let t1 = 0, t01 = 0, scored = 0, totalPayout = 0;
  const finishPctiles: number[] = [];  // Ch.10: per-lineup finishing percentile for distribution shape analysis

  for (const lu of portfolio) {
    let t = 0, miss = false;
    for (const p of lu.players) {
      const r = actuals.playerActualsByName.get(norm(p.name));
      if (!r) { miss = true; break; }
      t += r.fpts;
    }
    if (miss) continue;
    const a = t;
    scored++;

    let lo = 0, hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sorted[mid] >= a) lo = mid + 1; else hi = mid;
    }
    const rank = Math.max(1, lo);

    if (a >= top1T) t1++;
    if (a >= top01T) t01++;

    // Ch.10: percentile rank (0 = worst, 1 = best in field).
    finishPctiles.push(F > 1 ? 1 - (rank - 1) / (F - 1) : 0.5);

    const payout = rank <= payoutTable.length ? payoutTable[rank - 1] : 0;
    if (payout > 0) {
      let coWin = 0;
      for (const e of actuals.entries) {
        if (Math.abs(e.actualPoints - a) <= 0.25) coWin++;
      }
      coWin = Math.max(0, coWin - 1);
      totalPayout += payout / Math.sqrt(1 + coWin * 0.5);
    }
  }

  return { totalPayout, t1, t01, scored, finishPctiles };
}

// ============================================================
// SLATE LOADER — reuse existing parsers
// ============================================================

interface SlateData {
  slate: string;
  candidates: Lineup[];
  players: Player[];
  actuals: ContestActuals;
  payoutTable: Float64Array;
  config: ContestConfig;
  // Sim-output (from SaberSim "Sim Optimals" column) — read for Ch.9 exploit if available.
  // We load actual values via the pool file's `Sim Optimals` column; key by player ID.
  // Fallback: if not available, exploit becomes a no-op.
  simOptimalsByPlayerId: Map<string, number>;
  // Pro consensus stats for this slate (per-metric mean/std for Mahalanobis).
  consensusStats: Record<string, { mean: number; std: number }> | null;
  // Slate-level stats for universal metrics.
  slateStats: SlateStats;
}

interface SlateStats {
  optimalLineupProj: number;
  optimalLineupCeiling: number;
  chalkAnchorOwn: number;
  slateAvgPlayerOwn: number;
  ownPercentileByPlayerId: Map<string, number>;
  numTeams: number;
  teamCounts: Map<string, number>;
}

function computeSlateStats(players: Player[], allLineups: Player[][]): SlateStats {
  let optProj = 0, optCeil = 0;
  const lineupOwnPairs: { meanOwn: number }[] = [];
  for (const lu of allLineups) {
    let p = 0, c = 0, o = 0;
    for (const pl of lu) {
      p += pl.projection || 0;
      c += (pl as any).ceiling || (pl.projection || 0) * 1.4;
      o += pl.ownership || 0;
    }
    if (p > optProj) optProj = p;
    if (c > optCeil) optCeil = c;
    lineupOwnPairs.push({ meanOwn: o / lu.length });
  }
  lineupOwnPairs.sort((a, b) => b.meanOwn - a.meanOwn);
  const topN = Math.min(100, lineupOwnPairs.length);
  const chalkAnchor = mean(lineupOwnPairs.slice(0, topN).map(x => x.meanOwn));
  const slateAvg = mean(players.map(p => p.ownership || 0));
  const ownPctile = new Map<string, number>();
  const sortedByOwn = [...players].sort((a, b) => (a.ownership || 0) - (b.ownership || 0));
  for (let i = 0; i < sortedByOwn.length; i++) {
    ownPctile.set(sortedByOwn[i].id, sortedByOwn.length > 1 ? i / (sortedByOwn.length - 1) : 0);
  }
  const teamCounts = new Map<string, number>();
  for (const p of players) {
    const t = (p.team || '').toUpperCase();
    if (t) teamCounts.set(t, (teamCounts.get(t) || 0) + 1);
  }
  return {
    optimalLineupProj: optProj,
    optimalLineupCeiling: optCeil,
    chalkAnchorOwn: chalkAnchor,
    slateAvgPlayerOwn: slateAvg,
    ownPercentileByPlayerId: ownPctile,
    numTeams: teamCounts.size,
    teamCounts,
  };
}

function loadSimOptimals(poolPath: string, playerIdSet: Set<string>): Map<string, number> {
  // Parse the pool CSV header to find "Sim Optimals" column. For each lineup, increment counter
  // for each player in that row that's in the pool. Returns Map<playerId, count>.
  const out = new Map<string, number>();
  if (!fs.existsSync(poolPath)) return out;
  const content = fs.readFileSync(poolPath, 'utf-8');
  const lines = content.split(/\r?\n/);
  if (lines.length < 2) return out;
  const headers = lines[0].split(',');
  const simIdx = headers.findIndex(h => h.trim().toLowerCase() === 'sim optimals');
  if (simIdx === -1) return out;
  // Position columns are in the prefix; for MLB classic, 10 columns.
  const positionCount = 10;
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    if (cells.length < simIdx + 1) continue;
    const sim = parseFloat(cells[simIdx]);
    if (!isFinite(sim) || sim <= 0) continue;
    for (let j = 0; j < positionCount; j++) {
      const cell = (cells[j] || '').trim();
      const m = cell.match(/(\d{4,})/);
      const id = m ? m[1] : (/^\d{4,}$/.test(cell) ? cell : '');
      if (id && playerIdSet.has(id)) out.set(id, (out.get(id) || 0) + sim);
    }
  }
  return out;
}

async function loadSlate(s: typeof SLATES[0], consBySlate: Record<string, Record<string, { mean: number; std: number }>>): Promise<SlateData | null> {
  const projPath = path.join(DIR, s.proj);
  const actualsPath = path.join(DIR, s.actuals);
  const poolPath = path.join(DIR, s.pool);
  if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) {
    console.log(`  Skip ${s.slate}: missing files`);
    return null;
  }
  const pr = parseCSVFile(projPath, 'mlb', true);
  const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
  const pool = buildPlayerPool(pr.players, pr.detectedContestType);
  const actuals = parseContestActuals(actualsPath, config);

  const idMap = new Map<string, Player>();
  const nameMap = new Map<string, Player>();
  const idSet = new Set<string>();
  for (const p of pool.players) {
    idMap.set(p.id, p);
    nameMap.set(norm(p.name), p);
    idSet.add(p.id);
  }
  const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });

  // Build all field lineups for chalk anchor computation.
  const fieldLineups: Player[][] = [];
  for (const e of actuals.entries) {
    const pls: Player[] = [];
    let ok = true;
    for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
    if (ok) fieldLineups.push(pls);
  }

  const stats = computeSlateStats(pool.players, fieldLineups.length > 0 ? fieldLineups : loaded.lineups.map(lu => lu.players));
  const simOptimals = loadSimOptimals(poolPath, idSet);

  const F = actuals.entries.length;
  const payoutTable = buildPayoutTable(Math.max(F, 100));

  return {
    slate: s.slate,
    candidates: loaded.lineups,
    players: pool.players,
    actuals,
    payoutTable,
    config,
    simOptimalsByPlayerId: simOptimals,
    consensusStats: consBySlate[s.slate] || null,
    slateStats: stats,
  };
}

// ============================================================
// STAGE 1A — Projection lever (median, floor, ceiling, range)
// ============================================================

interface ProjectionScore {
  median: number;
  floor: number;
  ceiling: number;
  range: number;
}

function score1A_projection(lineup: Lineup): ProjectionScore {
  let median = 0, floor = 0, ceiling = 0;
  for (const p of lineup.players) {
    const proj = p.projection || 0;
    median += proj;
    if (p.percentiles) {
      floor += p.percentiles.p25 || proj * 0.85;
      ceiling += p.percentiles.p75 || proj * 1.15;
    } else {
      floor += proj * 0.85;
      ceiling += proj * 1.15;
    }
  }
  return { median, floor, ceiling, range: ceiling - floor };
}

// ============================================================
// STAGE 1B — Correlation lever (stacks, bring-back, P-vs-H)
// ============================================================

interface CorrelationScore {
  primaryStackTeam: string;
  primaryStackSize: number;
  bringBackCount: number;
  pitcherOpposingHitters: number;
  adjustment: number; // Multiplier on median, e.g. +0.30 = +30%
}

function score1B_correlation(lineup: Lineup): CorrelationScore {
  // Find pitcher (P) and hitter team distribution.
  const teamHitters = new Map<string, number>();
  let pitcher: Player | null = null;
  let pitcherTeam = '';
  let pitcherOpp = '';
  // Note: MLB DK lineup has 2 pitchers, but the framework's P-vs-H penalty applies to
  // each pitcher separately. We track both.
  const pitchers: Player[] = [];

  for (const p of lineup.players) {
    const pos = (p.position || '').toUpperCase();
    if (pos.includes('P')) {
      pitchers.push(p);
    } else {
      const team = (p.team || '').toUpperCase();
      if (team) teamHitters.set(team, (teamHitters.get(team) || 0) + 1);
    }
  }

  // Primary stack = team with most hitters.
  let primaryTeam = '';
  let primarySize = 0;
  for (const [team, count] of teamHitters) {
    if (count > primarySize) { primarySize = count; primaryTeam = team; }
  }

  // Bring-back: count hitters from primary stack's opposing team.
  // We need to know primary stack's opponent. Use any primary-stack hitter's `opponent` field.
  let primaryOpp = '';
  for (const p of lineup.players) {
    if ((p.team || '').toUpperCase() === primaryTeam) {
      primaryOpp = (p.opponent || '').toUpperCase();
      if (primaryOpp) break;
    }
  }
  const bringBack = primaryOpp ? (teamHitters.get(primaryOpp) || 0) : 0;

  // Pitcher-vs-hitter: count opposing hitters for each pitcher.
  let pitcherOppHitters = 0;
  for (const p of pitchers) {
    const oppTeam = (p.opponent || '').toUpperCase();
    if (oppTeam) pitcherOppHitters += (teamHitters.get(oppTeam) || 0);
  }

  // Adjustment computation:
  //   stack bonus = STACK_BONUS_PER_HITTER × (primarySize - 2) if primarySize >= 3, else 0.
  //   bring-back bonus: 0/0.05/0.08 for 0/1/2+ bring-backs.
  //   pitcher penalty: PITCHER_VS_HITTER_PENALTY × pitcherOppHitters.
  let adj = 0;
  if (primarySize >= 3) adj += TODFS_PARAMS.STACK_BONUS_PER_HITTER * (primarySize - 2);
  if (bringBack === 1) adj += TODFS_PARAMS.BRINGBACK_1;
  else if (bringBack >= 2) adj += TODFS_PARAMS.BRINGBACK_2;
  adj += TODFS_PARAMS.PITCHER_VS_HITTER_PENALTY * pitcherOppHitters;

  return {
    primaryStackTeam: primaryTeam,
    primaryStackSize: primarySize,
    bringBackCount: bringBack,
    pitcherOpposingHitters: pitcherOppHitters,
    adjustment: adj,
  };
}

// ============================================================
// STAGE 1C — Leverage lever (log-ownership-product, slate-relative percentile)
// ============================================================

function lineupLogOwnProduct(lineup: Lineup, ownAdj?: Map<string, number>): number {
  // log(prod ownership) = sum(log(own)). We use raw adj-own from projections.
  // Apply Ch.9 Sim-Optimals exploit by using ownAdj overrides if provided.
  let s = 0;
  for (const p of lineup.players) {
    const adj = ownAdj?.get(p.id);
    const own = adj !== undefined ? adj : (p.ownership || 0.5);
    s += Math.log(Math.max(0.1, own));
  }
  return s;
}

// ============================================================
// STAGE 1D — Relative value (salary inefficiency + ownership inefficiency + direct leverage)
// ============================================================

function score1D_relativeValue(lineup: Lineup, slateData: SlateData): number {
  // (a) Salary inefficiency — for each player, measure proj per $1k vs slate's position-tier average.
  // (b) Ownership inefficiency — log(proj / own^k).
  // (c) Direct leverage — bonus if primary stack opposes a top-3 projected SP.

  const players = slateData.players;

  // Compute position-tier salary expectation.
  const byPosTier = new Map<string, { sum: number; count: number }>();
  for (const p of players) {
    if (!p.salary || !p.projection) continue;
    const pos = (p.position || '').split('/')[0].toUpperCase();
    const tier = `${pos}_${Math.floor(p.salary / 1000)}`;
    const cur = byPosTier.get(tier) || { sum: 0, count: 0 };
    cur.sum += p.projection;
    cur.count++;
    byPosTier.set(tier, cur);
  }

  // (a) Salary inefficiency (per-lineup sum).
  let salaryEff = 0;
  for (const p of lineup.players) {
    const pos = (p.position || '').split('/')[0].toUpperCase();
    const tier = `${pos}_${Math.floor((p.salary || 0) / 1000)}`;
    const grp = byPosTier.get(tier);
    const tierAvg = grp && grp.count > 0 ? grp.sum / grp.count : (p.projection || 0);
    const sal = p.salary || 1000;
    salaryEff += ((p.projection || 0) - tierAvg) / (sal / 1000);
  }

  // (b) Ownership inefficiency.
  let ownEff = 0;
  for (const p of lineup.players) {
    const proj = p.projection || 0.1;
    const own = p.ownership || 0.5;
    ownEff += Math.log(proj / Math.pow(Math.max(0.1, own), TODFS_PARAMS.OWNERSHIP_EFFICIENCY_EXPONENT));
  }

  // (c) Direct leverage: identify top-3 SP by projection.
  const sps = players.filter(p => (p.position || '').toUpperCase().includes('P')).sort((a, b) => (b.projection || 0) - (a.projection || 0));
  const topSpTeams = new Set(sps.slice(0, 3).map(p => (p.team || '').toUpperCase()));
  let directBonus = 0;
  for (const p of lineup.players) {
    if ((p.position || '').toUpperCase().includes('P')) continue;
    const opp = (p.opponent || '').toUpperCase();
    if (topSpTeams.has(opp)) {
      // Hitter opposing top-3 SP. Bonus per spec.
      directBonus = TODFS_PARAMS.DIRECT_LEVERAGE_BONUS;
      break;
    }
  }

  // Combine: normalize within slate via percentile in caller. Here return a raw composite score.
  // Weights of components within RV: salary 0.4, own 0.5, direct 0.1 (impl choice).
  return salaryEff * 0.4 + ownEff * 0.5 + directBonus * 100; // direct bonus scaled for impact
}

// ============================================================
// STAGE 1E — Combinatorial uniqueness (pair/triple frequency vs field equilibrium)
// ============================================================

interface PairFreqMap {
  pairToFreq: Map<string, number>;        // "id1|id2" sorted
  tripleToFreq: Map<string, number>;     // "id1|id2|id3" sorted
}

function buildPairTripleFreqs(candidates: Lineup[]): PairFreqMap {
  // Field equilibrium estimate from field-mimicking pool. Each lineup contributes 1.0 weighted
  // by projection for de-noising (avoid noise-pool low-projection lineups dominating).
  const pairToFreq = new Map<string, number>();
  const tripleToFreq = new Map<string, number>();

  let totalWeight = 0;
  for (const lu of candidates) {
    const w = Math.max(0.1, lu.projection || 1) ** 2; // weight by projection^2
    totalWeight += w;
    const ids = lu.players.map(p => p.id).sort();
    // Pairs.
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const k = ids[i] + '|' + ids[j];
        pairToFreq.set(k, (pairToFreq.get(k) || 0) + w);
      }
    }
    // Triples.
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        for (let l = j + 1; l < ids.length; l++) {
          const k = ids[i] + '|' + ids[j] + '|' + ids[l];
          tripleToFreq.set(k, (tripleToFreq.get(k) || 0) + w);
        }
      }
    }
  }
  // Normalize to frequency per total weight.
  for (const k of pairToFreq.keys()) pairToFreq.set(k, pairToFreq.get(k)! / totalWeight);
  for (const k of tripleToFreq.keys()) tripleToFreq.set(k, tripleToFreq.get(k)! / totalWeight);

  return { pairToFreq, tripleToFreq };
}

function score1E_combinatorial(lineup: Lineup, freqs: PairFreqMap): { uniquenessScore: number; topTriples: string[] } {
  // log of pair-frequency products (with same-team boost factor).
  const ids = lineup.players.map(p => p.id).sort();
  const teamMap = new Map<string, string>();
  for (const p of lineup.players) teamMap.set(p.id, (p.team || '').toUpperCase());

  let logPairSum = 0;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const k = ids[i] + '|' + ids[j];
      const f = freqs.pairToFreq.get(k) || 1e-6;
      const ti = teamMap.get(ids[i]);
      const tj = teamMap.get(ids[j]);
      let factor = TODFS_PARAMS.PAIR_CORR_UNRELATED;
      if (ti && tj && ti === tj) factor = TODFS_PARAMS.PAIR_CORR_SAME_TEAM;
      // Opposing pair detection: would need opponent info; skip approximation here.
      logPairSum += Math.log(f * factor);
    }
  }

  // Triples — keep top-3 highest-frequency triples in lineup.
  const tripleFs: { key: string; f: number }[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      for (let l = j + 1; l < ids.length; l++) {
        const k = ids[i] + '|' + ids[j] + '|' + ids[l];
        const f = freqs.tripleToFreq.get(k) || 1e-6;
        tripleFs.push({ key: k, f });
      }
    }
  }
  tripleFs.sort((a, b) => b.f - a.f);
  const top = tripleFs.slice(0, TODFS_PARAMS.TRIPLES_EVALUATED);
  const logTripleSum = top.reduce((s, t) => s + Math.log(t.f), 0);

  // Uniqueness = -1 × sum log freqs (rare combos => low log freq => negative => negate => high uniqueness)
  return { uniquenessScore: -(logPairSum + logTripleSum), topTriples: top.map(t => t.key) };
}

// ============================================================
// STAGE 1F — Archetype scoring per slate
// ============================================================

interface ArchetypeParams {
  varianceTarget: number;       // 0..1 multiplier on range contribution
  projectionFloor: number;      // 0..1 minimum acceptable proj_pctile (filter)
  contestEquityShape: 'top-heavy' | 'flat'; // assumed top-heavy GPP
  notes: string;
}

function score1F_archetype(slateData: SlateData): ArchetypeParams {
  // The 10 archetypes (Ch.7), and how they map for our backtest context:
  //   1. Player Distribution: MLB always bimodal hitters, normal pitchers — applied via HITTER_VARIANCE_MULT
  //      in EV (range × hitter_var multiplier).
  //   2. Player Correlation: positive same-team, negative pitcher-vs-hitter — handled in score1B.
  //   3. Player Pool Size: drives variance_target & projection_floor (numTeams below).
  //   4. Position Scarcity: MLB DK Classic has 2 P slots — moderate scarcity. Reflected in score1D
  //      via salary tiers; not a separate archetype per-slate signal.
  //   5. Contest Equity: assumed top-heavy GPP — fixed for backtest.
  //   6. Contest Size: assumed large field — fixed for backtest.
  //   7. High Score / Nuts: computed below (nuts_gap) — drives variance_target adjustment.
  //   8. Format / Max Entry: assumed 150-max — fixed for backtest.
  //   9. Opponent Skill: assumed mixed field — fixed for backtest.
  //   10. Optionality / Late Swap: explicitly excluded per spec ("not at the forefront").
  const t = slateData.slateStats.numTeams;
  const nutsGap = computeNutsGap(slateData);

  let varianceTarget = 0.8;
  let projectionFloor = 0.40;
  let notes = `numTeams=${t} nutsGap=${(nutsGap*100).toFixed(1)}%`;

  // Player Pool Size (archetype #3).
  if (t <= 4) {
    varianceTarget = 0.7;
    projectionFloor = 0.50;
    notes += ', 2-game small slate';
  } else if (t <= 8) {
    varianceTarget = 0.8;
    projectionFloor = 0.40;
    notes += ', mid slate';
  } else {
    varianceTarget = 0.9;
    projectionFloor = 0.30;
    notes += ', large slate';
  }

  // High Score / Nuts (archetype #7) — modulate variance_target.
  // Large gap (nuts unattainable) → more variance OK. Tight cluster → less variance.
  if (nutsGap > TODFS_PARAMS.NUTS_GAP_HIGH_THRESHOLD) {
    varianceTarget = Math.min(1.0, varianceTarget + 0.10);
    notes += ', high nuts gap (more variance)';
  } else if (nutsGap < TODFS_PARAMS.NUTS_GAP_LOW_THRESHOLD) {
    varianceTarget = Math.max(0.4, varianceTarget - 0.15);
    notes += ', tight cluster (less variance)';
  }

  return {
    varianceTarget,
    projectionFloor,
    contestEquityShape: 'top-heavy',
    notes,
  };
}

// ============================================================
// EXPLOIT: Sim-Optimals ownership adjustment (Ch.9 #9)
// ============================================================

function buildSimOptimalsOwnAdjustments(slateData: SlateData): Map<string, number> {
  const out = new Map<string, number>();
  const sims: { id: string; sim: number }[] = [];
  for (const [id, sim] of slateData.simOptimalsByPlayerId) sims.push({ id, sim });
  if (sims.length === 0) return out;
  sims.sort((a, b) => b.sim - a.sim);
  const topCount = Math.max(1, Math.floor(sims.length * TODFS_PARAMS.SIM_OPTIMALS_TOP_PCT));
  const topIds = new Set(sims.slice(0, topCount).map(x => x.id));
  for (const p of slateData.players) {
    const baseOwn = p.ownership || 0.5;
    if (topIds.has(p.id)) {
      out.set(p.id, baseOwn + TODFS_PARAMS.SIM_OPTIMALS_OWN_BUMP_PP);
    } else {
      out.set(p.id, baseOwn);
    }
  }
  return out;
}

// Ch.9 #4: PPD ownership bump. Top-PPD players are over-used by field optimizers.
function applyPpdOwnBump(slateData: SlateData, ownAdj: Map<string, number>): void {
  // Compute PPD = projection / (salary in thousands). Skip players with zero salary or zero proj.
  const ppds: { id: string; ppd: number }[] = [];
  for (const p of slateData.players) {
    if (!p.salary || !p.projection) continue;
    const ppd = p.projection / (p.salary / 1000);
    ppds.push({ id: p.id, ppd });
  }
  if (ppds.length === 0) return;
  ppds.sort((a, b) => b.ppd - a.ppd);
  const topCount = Math.max(1, Math.floor(ppds.length * TODFS_PARAMS.PPD_TOP_PCT));
  const topIds = new Set(ppds.slice(0, topCount).map(x => x.id));
  for (const id of topIds) {
    const cur = ownAdj.get(id);
    const baseOwn = cur ?? (slateData.players.find(p => p.id === id)?.ownership || 0.5);
    ownAdj.set(id, baseOwn + TODFS_PARAMS.PPD_OWN_BUMP_PP);
  }
}

// Ch.9 #4: lineup-level PPD score for EV penalty (the knapsack-solution detector).
function lineupPpdScore(lineup: Lineup): number {
  let s = 0;
  for (const p of lineup.players) {
    if (!p.salary || !p.projection) continue;
    s += p.projection / (p.salary / 1000);
  }
  return s;
}

// Ch.9 #1: projection fragility ownership bump. Players with high stdDev are field-mispriced.
function applyFragilityOwnBump(slateData: SlateData, ownAdj: Map<string, number>): void {
  const stds: { id: string; std: number }[] = [];
  for (const p of slateData.players) {
    const std = (p as any).stdDev || 0;
    if (std > 0) stds.push({ id: p.id, std });
  }
  if (stds.length < 10) return;  // not enough signal — skip
  stds.sort((a, b) => b.std - a.std);
  const topCount = Math.max(1, Math.floor(stds.length * TODFS_PARAMS.FRAGILITY_TOP_PCT));
  const topIds = new Set(stds.slice(0, topCount).map(x => x.id));
  for (const id of topIds) {
    const cur = ownAdj.get(id);
    const baseOwn = cur ?? (slateData.players.find(p => p.id === id)?.ownership || 0.5);
    ownAdj.set(id, baseOwn + TODFS_PARAMS.FRAGILITY_OWN_BUMP_PP);
  }
}

// Ch.9 #5: ultra-chalk lineup detector. Returns count of "ultra-chalk" players (top-quartile ownership).
function ultraChalkCount(lineup: Lineup, ultraChalkIds: Set<string>): number {
  let n = 0;
  for (const p of lineup.players) if (ultraChalkIds.has(p.id)) n++;
  return n;
}

function buildUltraChalkSet(slateData: SlateData): Set<string> {
  const owns = slateData.players.map(p => ({ id: p.id, own: p.ownership || 0 }));
  if (owns.length === 0) return new Set();
  owns.sort((a, b) => b.own - a.own);
  const cutoff = Math.max(1, Math.floor(owns.length * (1 - TODFS_PARAMS.ULTRA_CHALK_PLAYER_THRESHOLD_PCT)));
  return new Set(owns.slice(0, cutoff).map(x => x.id));
}

// Ch.9 #8: PPD-team 5-stack detector. Returns true if primary stack of 5 contains top-3 PPD player.
function isPpdTeamHeavyStack(corr: CorrelationScore, lineup: Lineup, slateData: SlateData): boolean {
  if (corr.primaryStackSize < 5) return false;
  const ppds: { id: string; team: string; ppd: number }[] = [];
  for (const p of slateData.players) {
    if (!p.salary || !p.projection) continue;
    ppds.push({ id: p.id, team: (p.team || '').toUpperCase(), ppd: p.projection / (p.salary / 1000) });
  }
  ppds.sort((a, b) => b.ppd - a.ppd);
  const top3 = ppds.slice(0, 3);
  const top3Teams = new Set(top3.map(x => x.team));
  return top3Teams.has(corr.primaryStackTeam);
}

// Ch.7 archetype enhancement: High Score / Nuts gap.
function computeNutsGap(slateData: SlateData): number {
  const projs = slateData.candidates.map(lu => lu.projection).sort((a, b) => b - a);
  if (projs.length < 100) return 0.05;  // default
  const optimal = projs[0];
  const top5pct = projs[Math.floor(projs.length * 0.05)];
  return optimal > 0 ? (optimal - top5pct) / optimal : 0.05;
}

// ============================================================
// STAGE 2 — EV combination
// ============================================================

interface ScoredLU {
  lu: Lineup;
  // Raw scores
  proj: ProjectionScore;
  corr: CorrelationScore;
  logOwnProd: number;
  rv: number;
  combo: { uniquenessScore: number; topTriples: string[] };
  ppd: number;                          // Ch.9 #4: lineup PPD (penalize knapsack-solution lineups)
  ceilEff: number;                       // Ch.9 #2: ceiling/median ratio (median-overweighting exploit)
  ultraChalkN: number;                   // Ch.9 #5: count of ultra-chalk players in lineup
  ppdStack: boolean;                     // Ch.9 #8: primary 5-stack contains top-3 PPD player's team
  // Slate-relative percentiles (0..1)
  proj_pct: number;
  corr_adjusted_pct: number;
  own_pct: number;
  rv_pct: number;
  combo_pct: number;
  range_pct: number;
  ppd_pct: number;
  ceil_eff_pct: number;
  // Final EV
  ev: number;
}

function combineEV(scored: ScoredLU[], archetype: ArchetypeParams): void {
  // Compute slate-relative percentiles for each lever.
  const corrAdjusted = scored.map(s => s.proj.median * (1 + s.corr.adjustment));
  const ownVals = scored.map(s => s.logOwnProd);          // higher logOwnProd => more chalk
  const rvVals = scored.map(s => s.rv);
  const cmbVals = scored.map(s => s.combo.uniquenessScore);
  const rangeVals = scored.map(s => s.proj.range);
  const projVals = scored.map(s => s.proj.median);
  const ppdVals = scored.map(s => s.ppd);
  const ceilEffVals = scored.map(s => s.ceilEff);

  const projPct = rankPercentile(projVals);
  const corrPct = rankPercentile(corrAdjusted);
  const ownPct = rankPercentile(ownVals);
  const rvPct = rankPercentile(rvVals);
  const cmbPct = rankPercentile(cmbVals);
  const rangePct = rankPercentile(rangeVals);
  const ppdPct = rankPercentile(ppdVals);
  const ceilEffPct = rankPercentile(ceilEffVals);

  for (let i = 0; i < scored.length; i++) {
    scored[i].proj_pct = projPct[i];
    scored[i].corr_adjusted_pct = corrPct[i];
    scored[i].own_pct = ownPct[i];
    scored[i].rv_pct = rvPct[i];
    scored[i].combo_pct = cmbPct[i];
    scored[i].range_pct = rangePct[i];
    scored[i].ppd_pct = ppdPct[i];
    scored[i].ceil_eff_pct = ceilEffPct[i];
  }

  // EV formula (normalized terms; documented choice):
  //   ev = W_proj * corr_adjusted_pct
  //      + W_lev  * (1 - own_pct)
  //      + W_rv   * rv_pct
  //      + W_cmb  * combo_pct
  //      + W_var  * range_pct * varianceTarget
  //      + W_ceil_eff * ceil_eff_pct                    (Ch.9 #2 median-overweighting exploit)
  //   ev *= (1 - PPD_LINEUP_PENALTY)  if ppd_pct in top 10%   (Ch.9 #4 PPD-bias exploit)
  const w = TODFS_PARAMS;
  const ppdPenaltyThreshold = 1 - w.PPD_LINEUP_TOP_PCT;
  // Apply hitter-distribution variance multiplier (Ch.7 archetype #1) to range component.
  // MLB hitters are bimodal → reward variance more for hitter-heavy lineups (8 of 10 are hitters).
  const hitterVarianceFactor = w.HITTER_VARIANCE_MULT * 0.8 + w.PITCHER_VARIANCE_MULT * 0.2;
  for (const s of scored) {
    let ev = w.W_PROJ * s.corr_adjusted_pct
           + w.W_LEV  * (1 - s.own_pct)
           + w.W_RV   * s.rv_pct
           + w.W_CMB  * s.combo_pct
           + w.W_VAR  * s.range_pct * archetype.varianceTarget * hitterVarianceFactor
           + w.W_CEIL_EFF * s.ceil_eff_pct;
    // Ch.9 #4: PPD-corner penalty for "knapsack-solution" lineups.
    if (s.ppd_pct >= ppdPenaltyThreshold) ev *= (1 - w.PPD_LINEUP_PENALTY);
    // Ch.9 #5: ultra-chalk penalty for predictable optimizer-output lineups.
    if (s.ultraChalkN >= w.ULTRA_CHALK_LINEUP_MIN_COUNT) ev *= (1 - w.ULTRA_CHALK_PENALTY);
    // Ch.9 #8: PPD-team 5-stack penalty for field-saturated stack constructions.
    if (s.ppdStack) ev *= (1 - w.PPD_STACK_PENALTY);
    s.ev = ev;
  }
}

// ============================================================
// STAGE 3 — Portfolio building
// ============================================================

function buildTheoryPortfolio(slateData: SlateData): Lineup[] {
  // Stage 1F — archetype.
  const archetype = score1F_archetype(slateData);

  // Stage 1E — pair/triple freqs.
  const freqs = buildPairTripleFreqs(slateData.candidates);

  // Ch.9 ownership exploits — apply Sim-Optimals (#9), PPD bias (#4), and Fragility (#1) ownership bumps.
  const ownAdj = buildSimOptimalsOwnAdjustments(slateData);
  applyPpdOwnBump(slateData, ownAdj);
  applyFragilityOwnBump(slateData, ownAdj);

  // Ch.9 #5: build ultra-chalk player set for ultra-chalk lineup detection.
  const ultraChalkIds = buildUltraChalkSet(slateData);

  // Score every candidate.
  const scored: ScoredLU[] = slateData.candidates.map(lu => {
    const proj = score1A_projection(lu);
    const corr = score1B_correlation(lu);
    const logOwnProd = lineupLogOwnProduct(lu, ownAdj);
    const rv = score1D_relativeValue(lu, slateData);
    const combo = score1E_combinatorial(lu, freqs);
    const ppd = lineupPpdScore(lu);
    const ceilEff = proj.median > 0 ? proj.ceiling / proj.median : 0;
    const ultraChalkN = ultraChalkCount(lu, ultraChalkIds);
    const ppdStack = isPpdTeamHeavyStack(corr, lu, slateData);
    return {
      lu, proj, corr, logOwnProd, rv, combo, ppd, ceilEff, ultraChalkN, ppdStack,
      proj_pct: 0, corr_adjusted_pct: 0, own_pct: 0, rv_pct: 0, combo_pct: 0, range_pct: 0,
      ppd_pct: 0, ceil_eff_pct: 0, ev: 0,
    };
  });

  combineEV(scored, archetype);

  // Hard stack constraint (MLB correlation lever made structural).
  const stacked = scored.filter(s => s.corr.primaryStackSize >= TODFS_PARAMS.MIN_PRIMARY_STACK);
  const stackPoolSize = stacked.length;

  // Apply projection floor — drop lineups whose proj_pct is below floor.
  // Note: floor applied AFTER stack filter so floor percentile is relative to stacked lineups.
  let pool = stacked.filter(s => s.proj_pct >= archetype.projectionFloor);
  if (pool.length < N * 2) {
    pool = stacked.filter(s => s.proj_pct >= archetype.projectionFloor / 2);
  }
  if (pool.length < N) pool = stacked;
  // If even stacked pool is too thin (rare on small slates), fall back to all candidates with stack >= 3.
  if (pool.length < N) {
    const stackedRelaxed = scored.filter(s => s.corr.primaryStackSize >= 3);
    if (stackedRelaxed.length >= N) pool = stackedRelaxed;
    else pool = scored;
  }
  console.log(`  Stack filter: ${scored.length} → ${stackPoolSize} stacked → ${pool.length} after proj floor`);

  // Stage 3A — frequency optimization → target exposures.
  const avgProj = mean(slateData.players.map(p => p.projection || 0));
  const avgOwn = mean(slateData.players.map(p => p.ownership || 0.5));
  const targetExposureById = new Map<string, number>();
  for (const p of slateData.players) {
    const own = Math.max(0.5, p.ownership || 0.5);
    const proj = p.projection || 0;
    if (proj <= 0) { targetExposureById.set(p.id, 0); continue; }
    // ownership_efficient_projection = own × (avgProj / avgOwn) — what their projection "should be" given their own.
    const effProj = own * (avgProj / Math.max(0.5, avgOwn));
    const ratio = proj / Math.max(0.1, effProj);
    let target = (own / 100) * Math.pow(ratio, TODFS_PARAMS.EXPLOITATIVE_EXPONENT);
    const isPitcher = (p.position || '').toUpperCase().includes('P');
    const cap = isPitcher ? TODFS_PARAMS.EXPOSURE_CAP_PITCHER : TODFS_PARAMS.EXPOSURE_CAP_HITTER;
    target = Math.min(cap, target);
    targetExposureById.set(p.id, target);
  }

  // Stage 3B — variance bands.
  // Define bands by combined high-proj/high-own (band high) and low-proj/low-own (band low).
  // Compute composite band score per lineup.
  // Band high: proj_pct + own_pct (the higher the better). Top 20%.
  // Band low: (1 - proj_pct) + (1 - own_pct). Top 20%.
  const ranked: { s: ScoredLU; bandHighScore: number; bandLowScore: number }[] = pool.map(s => ({
    s,
    bandHighScore: s.proj_pct + s.own_pct,
    bandLowScore: (1 - s.proj_pct) + (1 - s.own_pct),
  }));

  // Sort into bands.
  const sortedByHigh = [...ranked].sort((a, b) => b.bandHighScore - a.bandHighScore);
  const sortedByLow = [...ranked].sort((a, b) => b.bandLowScore - a.bandLowScore);

  const HIGH_TARGET = Math.round(N * TODFS_PARAMS.BAND_HIGH_PCT);
  const LOW_TARGET = Math.round(N * TODFS_PARAMS.BAND_LOW_PCT);
  const MID_TARGET = N - HIGH_TARGET - LOW_TARGET;

  // Pre-allocate "candidate set" for each band.
  const HIGH_CAND = sortedByHigh.slice(0, Math.max(HIGH_TARGET * 5, 200)).map(x => x.s);
  const LOW_CAND = sortedByLow.slice(0, Math.max(LOW_TARGET * 5, 200)).map(x => x.s);
  // Mid candidate pool: everyone (greedy will dedupe).
  const MID_CAND = pool;

  // Stage 3C — greedy selection with constraints.
  const selected: ScoredLU[] = [];
  const exposureByPlayer = new Map<string, number>();
  const seenHashes = new Set<string>();
  const tripleSeen = new Map<string, number>();

  function passesConstraints(s: ScoredLU): boolean {
    if (seenHashes.has(s.lu.hash)) return false;

    // Player-exposure cap.
    // Frequency-optimization target_exposure is the *desired* exposure (drives selection ordering
    // via EV). The hard cap here is the global EXPOSURE_CAP, not the per-player target — otherwise
    // anchor players capped at ~20% prevent filling 150 lineups under the 4+ stack constraint.
    for (const p of s.lu.players) {
      const cur = exposureByPlayer.get(p.id) || 0;
      const isPitcher = (p.position || '').toUpperCase().includes('P');
      const cap = isPitcher ? TODFS_PARAMS.EXPOSURE_CAP_PITCHER : TODFS_PARAMS.EXPOSURE_CAP_HITTER;
      if ((cur + 1) / N > cap) return false;
    }

    // Pairwise overlap with selected lineups.
    const ids = new Set(s.lu.players.map(p => p.id));
    for (const sel of selected) {
      let overlap = 0;
      for (const p of sel.lu.players) if (ids.has(p.id)) overlap++;
      if (overlap > TODFS_PARAMS.MAX_PAIRWISE_OVERLAP) return false;
    }

    // Top triples cap.
    for (const k of s.combo.topTriples) {
      if ((tripleSeen.get(k) || 0) >= TODFS_PARAMS.TRIPLE_FREQ_CAP) return false;
    }

    return true;
  }

  function addLineup(s: ScoredLU): void {
    selected.push(s);
    seenHashes.add(s.lu.hash);
    for (const p of s.lu.players) {
      exposureByPlayer.set(p.id, (exposureByPlayer.get(p.id) || 0) + 1);
    }
    for (const k of s.combo.topTriples) {
      tripleSeen.set(k, (tripleSeen.get(k) || 0) + 1);
    }
  }

  function selectFromBand(bandPool: ScoredLU[], target: number, label: string): number {
    const sorted = [...bandPool].sort((a, b) => b.ev - a.ev);
    const initialSize = selected.length;
    let added = 0;
    for (const s of sorted) {
      if (added >= target) break;
      if (passesConstraints(s)) {
        addLineup(s);
        added++;
      }
    }
    // Relaxation pass if short.
    if (added < target) {
      // Pass 2: relax overlap to 7.
      const oldOverlap = TODFS_PARAMS.MAX_PAIRWISE_OVERLAP;
      (TODFS_PARAMS as any).MAX_PAIRWISE_OVERLAP = 7;
      for (const s of sorted) {
        if (added >= target) break;
        if (passesConstraints(s)) { addLineup(s); added++; }
      }
      (TODFS_PARAMS as any).MAX_PAIRWISE_OVERLAP = oldOverlap;
    }
    if (added < target) {
      // Pass 3: drop triple-freq cap.
      const oldCap = TODFS_PARAMS.TRIPLE_FREQ_CAP;
      (TODFS_PARAMS as any).TRIPLE_FREQ_CAP = 999;
      for (const s of sorted) {
        if (added >= target) break;
        if (passesConstraints(s)) { addLineup(s); added++; }
      }
      (TODFS_PARAMS as any).TRIPLE_FREQ_CAP = oldCap;
    }
    if (added < target) {
      // Pass 4: drop exposure cap.
      const oldHit = TODFS_PARAMS.EXPOSURE_CAP_HITTER;
      (TODFS_PARAMS as any).EXPOSURE_CAP_HITTER = 1.0;
      (TODFS_PARAMS as any).EXPOSURE_CAP_PITCHER = 1.0;
      for (const s of sorted) {
        if (added >= target) break;
        if (passesConstraints(s)) { addLineup(s); added++; }
      }
      (TODFS_PARAMS as any).EXPOSURE_CAP_HITTER = oldHit;
      (TODFS_PARAMS as any).EXPOSURE_CAP_PITCHER = TODFS_PARAMS.EXPOSURE_CAP_PITCHER;
    }
    return added;
  }

  selectFromBand(HIGH_CAND, HIGH_TARGET, 'high');
  selectFromBand(MID_CAND, MID_TARGET, 'mid');
  selectFromBand(LOW_CAND, LOW_TARGET, 'low');

  // DIAGNOSTIC — verify stack constraint actually held.
  let violations = 0;
  let stackDistribution = new Map<number, number>();
  for (const s of selected) {
    const sz = s.corr.primaryStackSize;
    stackDistribution.set(sz, (stackDistribution.get(sz) || 0) + 1);
    if (sz < TODFS_PARAMS.MIN_PRIMARY_STACK) violations++;
  }
  const distStr = [...stackDistribution.entries()].sort((a,b) => a[0]-b[0]).map(([k,v]) => `${k}:${v}`).join(' ');
  console.log(`  Selected stack-size distribution: ${distStr}  violations=${violations}`);

  // Ch.9 #7: clumping detector — check whether bottom-of-portfolio lineups have collapsed projection.
  // Framework: over-restrictive diversification causes top to be sharp + bottom to be sludge.
  // Detect: compare median proj of top-30% selected lineups vs bottom-30%. If gap > 8% of optimal,
  // log a warning (would suggest reseating LOW band with relaxed constraints).
  const sortedSel = [...selected].sort((a, b) => b.proj.median - a.proj.median);
  const topThird = sortedSel.slice(0, Math.floor(sortedSel.length / 3));
  const botThird = sortedSel.slice(-Math.floor(sortedSel.length / 3));
  const topMed = topThird.length ? topThird[Math.floor(topThird.length / 2)].proj.median : 0;
  const botMed = botThird.length ? botThird[Math.floor(botThird.length / 2)].proj.median : 0;
  const clumpGap = topMed > 0 ? (topMed - botMed) / topMed : 0;
  if (clumpGap > 0.08) {
    console.log(`  ⚠ Clumping detected: top-third proj=${topMed.toFixed(1)} vs bottom-third proj=${botMed.toFixed(1)} (gap=${(clumpGap*100).toFixed(1)}%) — Ch.9 #7 warning`);
  }

  // Final fill-up if still short (can happen with tight pool).
  if (selected.length < N) {
    const sorted = [...pool].sort((a, b) => b.ev - a.ev);
    const oldOverlap = (TODFS_PARAMS as any).MAX_PAIRWISE_OVERLAP;
    (TODFS_PARAMS as any).MAX_PAIRWISE_OVERLAP = 8;
    for (const s of sorted) {
      if (selected.length >= N) break;
      if (passesConstraints(s)) addLineup(s);
    }
    (TODFS_PARAMS as any).MAX_PAIRWISE_OVERLAP = oldOverlap;
  }

  return selected.map(s => s.lu);
}

// ============================================================
// METRICS — universal 5-metric Mahalanobis (matches pro-consensus-mahalanobis.ts)
// ============================================================

interface UniversalMetrics {
  projRatioToOptimal: number;
  ceilingRatioToOptimal: number;
  avgPlayerOwnPctile: number;
  ownStdRatio: number;
  ownDeltaFromAnchor: number;
}

function computeUniversal(lineups: Player[][], stats: SlateStats): UniversalMetrics {
  if (!lineups.length) return { projRatioToOptimal: 0, ceilingRatioToOptimal: 0, avgPlayerOwnPctile: 0, ownStdRatio: 0, ownDeltaFromAnchor: 0 };
  const luProjs: number[] = [], luCeils: number[] = [], luOwns: number[] = [], luOwnStds: number[] = [], pctileSums: number[] = [];
  for (const players of lineups) {
    const owns = players.map(p => p.ownership || 0);
    luOwns.push(mean(owns));
    luProjs.push(players.reduce((s, p) => s + (p.projection || 0), 0));
    luCeils.push(players.reduce((s, p) => s + ((p as any).ceiling || (p.projection || 0) * 1.4), 0));
    luOwnStds.push(stddev(owns));
    let pSum = 0;
    for (const p of players) pSum += stats.ownPercentileByPlayerId.get(p.id) || 0;
    pctileSums.push(pSum / players.length);
  }
  return {
    projRatioToOptimal: stats.optimalLineupProj > 0 ? mean(luProjs) / stats.optimalLineupProj : 0,
    ceilingRatioToOptimal: stats.optimalLineupCeiling > 0 ? mean(luCeils) / stats.optimalLineupCeiling : 0,
    avgPlayerOwnPctile: mean(pctileSums),
    ownStdRatio: stats.slateAvgPlayerOwn > 0 ? mean(luOwnStds) / stats.slateAvgPlayerOwn : 0,
    ownDeltaFromAnchor: mean(luOwns) - stats.chalkAnchorOwn,
  };
}

const UNIVERSAL_METRICS = ['projRatioToOptimal', 'ceilingRatioToOptimal', 'avgPlayerOwnPctile', 'ownStdRatio', 'ownDeltaFromAnchor'] as const;

function mahalanobis(metrics: UniversalMetrics, cons: Record<string, { mean: number; std: number }> | null): number | null {
  if (!cons) return null;
  let sum = 0, n = 0;
  for (const k of UNIVERSAL_METRICS) {
    const c = cons[k]; if (!c || c.std < 1e-9) continue;
    const d = ((metrics as any)[k] - c.mean) / c.std;
    sum += d * d; n++;
  }
  return n > 0 ? Math.sqrt(sum / n) : null;
}

// KS distance between two distributions (used for per-metric distribution comparison).
function ksDistance(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 1;
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  let maxD = 0, ai = 0, bi = 0;
  while (ai < sa.length && bi < sb.length) {
    const cdfA = (ai + 1) / sa.length;
    const cdfB = (bi + 1) / sb.length;
    maxD = Math.max(maxD, Math.abs(cdfA - cdfB));
    if (sa[ai] < sb[bi]) ai++;
    else if (sa[ai] > sb[bi]) bi++;
    else { ai++; bi++; }
  }
  return maxD;
}

// ============================================================
// STAGE 4 — Backtest loop
// ============================================================

interface SlateResult {
  slate: string;
  todfs: { payout: number; t1: number; t01: number; mahal: number | null; metrics: UniversalMetrics; portfolio: Lineup[]; teamStacks: Map<string, number>; uniquePlayers: number; finishPctiles: number[] };
  hermes: { payout: number; t1: number; t01: number; mahal: number | null; metrics: UniversalMetrics; portfolio: Lineup[]; teamStacks: Map<string, number>; uniquePlayers: number; finishPctiles: number[] };
}

function countTeamStacks(portfolio: Lineup[]): Map<string, number> {
  // Count lineups with 4+ hitters from a given team (primary stack).
  const m = new Map<string, number>();
  for (const lu of portfolio) {
    const teams = new Map<string, number>();
    for (const p of lu.players) {
      if ((p.position || '').toUpperCase().includes('P')) continue;
      const t = (p.team || '').toUpperCase();
      if (t) teams.set(t, (teams.get(t) || 0) + 1);
    }
    let primary = '';
    let primarySize = 0;
    for (const [t, c] of teams) if (c > primarySize) { primarySize = c; primary = t; }
    if (primarySize >= 4 && primary) m.set(primary, (m.get(primary) || 0) + 1);
  }
  return m;
}

function uniquePlayerCount(portfolio: Lineup[]): number {
  const s = new Set<string>();
  for (const lu of portfolio) for (const p of lu.players) s.add(p.id);
  return s.size;
}

async function runBacktest(): Promise<SlateResult[]> {
  console.log('Loading pro consensus...');
  const consensus = JSON.parse(fs.readFileSync(path.join(DIR, 'pro_consensus_slate_relative.json'), 'utf-8'));
  const consBySlate: Record<string, Record<string, { mean: number; std: number }>> = {};
  for (const k of UNIVERSAL_METRICS) {
    for (const entry of (consensus.metrics[k] || [])) {
      if (!consBySlate[entry.slate]) consBySlate[entry.slate] = {};
      consBySlate[entry.slate][k] = { mean: entry.mean, std: entry.std };
    }
  }

  console.log('\n================================================================');
  console.log('THEORY-OF-DFS vs HERMES-A — 17-slate backtest');
  console.log('================================================================\n');
  console.log('Slate          | TODFS-Pay  TODFS-t1 | HermA-Pay  HermA-t1 | TODFS-mahal HermA-mahal');
  console.log('---------------+---------------------+---------------------+-----------------------');

  const results: SlateResult[] = [];

  for (const s of SLATES) {
    const sd = await loadSlate(s, consBySlate);
    if (!sd) continue;

    // Theory-of-DFS portfolio.
    const t0 = Date.now();
    const todfsPortfolio = buildTheoryPortfolio(sd);
    const todfsTime = Date.now() - t0;

    // Hermes-A portfolio.
    const hermesT0 = Date.now();
    const comboFreq = precomputeComboFrequencies(sd.candidates, HERMES_A.comboPower);
    const hermesResult = productionSelect(sd.candidates, sd.players, {
      N,
      lambda: HERMES_A.lambda,
      comboFreq,
      maxOverlap: HERMES_A.gamma,
      teamCapPct: HERMES_A.teamCapPct,
      minPrimaryStack: HERMES_A.minPrimaryStack,
      maxExposure: HERMES_A.maxExposure,
      maxExposurePitcher: HERMES_A.maxExposurePitcher,
      extremeCornerCap: HERMES_A.extremeCornerCap,
      binAllocation: HERMES_A.binAllocation,
    });
    const hermesPortfolio = hermesResult.portfolio;
    const hermesTime = Date.now() - hermesT0;

    // Score.
    const todfsScore = scorePortfolio(todfsPortfolio, sd.actuals, sd.payoutTable);
    const hermesScore = scorePortfolio(hermesPortfolio, sd.actuals, sd.payoutTable);

    // Metrics.
    const todfsMetrics = computeUniversal(todfsPortfolio.map(lu => lu.players), sd.slateStats);
    const hermesMetrics = computeUniversal(hermesPortfolio.map(lu => lu.players), sd.slateStats);
    const todfsMahal = mahalanobis(todfsMetrics, sd.consensusStats);
    const hermesMahal = mahalanobis(hermesMetrics, sd.consensusStats);

    const result: SlateResult = {
      slate: s.slate,
      todfs: {
        payout: todfsScore.totalPayout, t1: todfsScore.t1, t01: todfsScore.t01,
        mahal: todfsMahal, metrics: todfsMetrics, portfolio: todfsPortfolio,
        teamStacks: countTeamStacks(todfsPortfolio), uniquePlayers: uniquePlayerCount(todfsPortfolio),
        finishPctiles: todfsScore.finishPctiles,
      },
      hermes: {
        payout: hermesScore.totalPayout, t1: hermesScore.t1, t01: hermesScore.t01,
        mahal: hermesMahal, metrics: hermesMetrics, portfolio: hermesPortfolio,
        teamStacks: countTeamStacks(hermesPortfolio), uniquePlayers: uniquePlayerCount(hermesPortfolio),
        finishPctiles: hermesScore.finishPctiles,
      },
    };
    results.push(result);

    console.log(
      `${s.slate.padEnd(14)} | $${todfsScore.totalPayout.toFixed(0).padStart(7)} ${String(todfsScore.t1).padStart(4)}      | $${hermesScore.totalPayout.toFixed(0).padStart(7)} ${String(hermesScore.t1).padStart(4)}      | ${(todfsMahal ?? 0).toFixed(2).padStart(6)}     ${(hermesMahal ?? 0).toFixed(2).padStart(6)}     [t=${todfsTime}/${hermesTime}ms]`
    );
  }

  return results;
}

// ============================================================
// STAGE 5 — Comparison report
// ============================================================

function emitReport(results: SlateResult[]): void {
  console.log('\n================================================================');
  console.log('STAGE 5 — COMPARISON REPORT');
  console.log('================================================================\n');

  const totalFees = N * FEE * results.length;
  const todfsTotal = results.reduce((s, r) => s + r.todfs.payout, 0);
  const hermesTotal = results.reduce((s, r) => s + r.hermes.payout, 0);
  const todfsT1 = results.reduce((s, r) => s + r.todfs.t1, 0);
  const hermesT1 = results.reduce((s, r) => s + r.hermes.t1, 0);
  const todfsT01 = results.reduce((s, r) => s + r.todfs.t01, 0);
  const hermesT01 = results.reduce((s, r) => s + r.hermes.t01, 0);
  const todfsMahals = results.map(r => r.todfs.mahal).filter((x): x is number => x !== null);
  const hermesMahals = results.map(r => r.hermes.mahal).filter((x): x is number => x !== null);
  const todfsWins = results.filter(r => r.todfs.payout > r.hermes.payout).length;
  const hermesWins = results.filter(r => r.hermes.payout > r.todfs.payout).length;
  const todfsMahalWins = results.filter(r => r.todfs.mahal !== null && r.hermes.mahal !== null && r.todfs.mahal < r.hermes.mahal).length;

  console.log(`Slates run: ${results.length}    Total fees: $${totalFees.toLocaleString()}\n`);
  console.log('METRIC                          | Theory-DFS    | Hermes-A      | Winner');
  console.log('--------------------------------|---------------|---------------|--------');
  console.log(`Total backtest payout           | $${todfsTotal.toFixed(0).padStart(8)}     | $${hermesTotal.toFixed(0).padStart(8)}     | ${todfsTotal > hermesTotal ? 'Theory-DFS' : 'Hermes-A'}`);
  console.log(`Total ROI                       | ${((todfsTotal/totalFees - 1) * 100).toFixed(1).padStart(7)}%      | ${((hermesTotal/totalFees - 1) * 100).toFixed(1).padStart(7)}%      | ${todfsTotal > hermesTotal ? 'Theory-DFS' : 'Hermes-A'}`);
  console.log(`Mean per-slate payout           | $${(todfsTotal/results.length).toFixed(0).padStart(8)}     | $${(hermesTotal/results.length).toFixed(0).padStart(8)}     | ${todfsTotal > hermesTotal ? 'Theory-DFS' : 'Hermes-A'}`);
  console.log(`Top-1% lineup hits              | ${String(todfsT1).padStart(8)}      | ${String(hermesT1).padStart(8)}      | ${todfsT1 > hermesT1 ? 'Theory-DFS' : (todfsT1 === hermesT1 ? 'tie' : 'Hermes-A')}`);
  console.log(`Top-0.1% lineup hits            | ${String(todfsT01).padStart(8)}      | ${String(hermesT01).padStart(8)}      | ${todfsT01 > hermesT01 ? 'Theory-DFS' : (todfsT01 === hermesT01 ? 'tie' : 'Hermes-A')}`);
  console.log(`Mean Mahalanobis to pro consensus | ${mean(todfsMahals).toFixed(2).padStart(6)}        | ${mean(hermesMahals).toFixed(2).padStart(6)}        | ${mean(todfsMahals) < mean(hermesMahals) ? 'Theory-DFS' : 'Hermes-A'}`);
  console.log(`Slates with closer Mahalanobis  | ${String(todfsMahalWins).padStart(8)}/${results.length}    | ${String(results.length - todfsMahalWins).padStart(8)}/${results.length}    | ${todfsMahalWins > results.length / 2 ? 'Theory-DFS' : 'Hermes-A'}`);
  console.log(`Slates won on payout            | ${String(todfsWins).padStart(8)}/${results.length}    | ${String(hermesWins).padStart(8)}/${results.length}    | ${todfsWins > hermesWins ? 'Theory-DFS' : 'Hermes-A'}`);
  console.log(`Per-slate payout std            | $${stddev(results.map(r => r.todfs.payout)).toFixed(0).padStart(8)}     | $${stddev(results.map(r => r.hermes.payout)).toFixed(0).padStart(8)}     | (lower = more consistent)`);

  // Per-slate breakdown.
  console.log('\nPer-slate breakdown:');
  console.log('Slate          | TODFS Pay     HermA Pay   | TODFS t1   HermA t1   | TODFS mhl  HermA mhl');
  for (const r of results) {
    console.log(
      `${r.slate.padEnd(14)} | $${r.todfs.payout.toFixed(0).padStart(7)}    $${r.hermes.payout.toFixed(0).padStart(7)}   | ${String(r.todfs.t1).padStart(5)}      ${String(r.hermes.t1).padStart(5)}      | ${(r.todfs.mahal ?? 0).toFixed(2).padStart(5)}      ${(r.hermes.mahal ?? 0).toFixed(2).padStart(5)}`
    );
  }

  // STAGE 6 — Decision.
  console.log('\n================================================================');
  console.log('STAGE 6 — DECISION');
  console.log('================================================================\n');
  const todfsMahalMean = mean(todfsMahals);
  const hermesMahalMean = mean(hermesMahals);
  const payoutRatio = hermesTotal > 0 ? todfsTotal / hermesTotal : 1;
  const mahalDelta = todfsMahalMean - hermesMahalMean;

  let outcome: string;
  if (todfsMahalWins >= 12 && payoutRatio > 1.20 && todfsT1 >= hermesT1) {
    outcome = 'A — Theory-DFS substantially beats Hermes-A. Ship Theory-DFS for live testing alongside Hermes-A.';
  } else if (Math.abs(mahalDelta) < 0.20 && payoutRatio > 0.80 && payoutRatio < 1.20) {
    outcome = 'B — Theory-DFS comparable to Hermes-A. Both equally validated on this sample. Recommend ship Theory-DFS for stronger theoretical grounding.';
  } else if (todfsMahalWins <= 5 && payoutRatio < 0.80) {
    outcome = 'C — Theory-DFS substantially worse than Hermes-A. Investigate before shipping.';
  } else {
    outcome = `Indeterminate — partial signal. Mahal delta ${mahalDelta.toFixed(2)}, payout ratio ${payoutRatio.toFixed(2)}, Theory-DFS won Mahal on ${todfsMahalWins}/${results.length}, payout on ${todfsWins}/${results.length}. Outcome falls between A/B/C thresholds; report parameter sensitivity (Stage 7) before deciding.`;
  }
  console.log(`Outcome: ${outcome}`);

  // Save JSON.
  const out = {
    params: TODFS_PARAMS,
    hermesA: HERMES_A,
    summary: {
      slatesRun: results.length,
      totalFees,
      todfs: { payout: todfsTotal, roi: todfsTotal / totalFees - 1, t1: todfsT1, t01: todfsT01, meanMahal: todfsMahalMean, slatesWonPayout: todfsWins, slatesWonMahal: todfsMahalWins },
      hermes: { payout: hermesTotal, roi: hermesTotal / totalFees - 1, t1: hermesT1, t01: hermesT01, meanMahal: hermesMahalMean, slatesWonPayout: hermesWins, slatesWonMahal: results.length - todfsMahalWins },
      outcome,
    },
    perSlate: results.map(r => ({
      slate: r.slate,
      todfs: { payout: r.todfs.payout, t1: r.todfs.t1, t01: r.todfs.t01, mahal: r.todfs.mahal, metrics: r.todfs.metrics, uniquePlayers: r.todfs.uniquePlayers, teamStacks: Object.fromEntries(r.todfs.teamStacks) },
      hermes: { payout: r.hermes.payout, t1: r.hermes.t1, t01: r.hermes.t01, mahal: r.hermes.mahal, metrics: r.hermes.metrics, uniquePlayers: r.hermes.uniquePlayers, teamStacks: Object.fromEntries(r.hermes.teamStacks) },
    })),
  };
  const outFilename = TODFS_PARAMS.ULTRA_CHALK_PENALTY > 0 && TODFS_PARAMS.PPD_STACK_PENALTY > 0
    ? 'full_framework_results.json'
    : TODFS_PARAMS.PPD_LINEUP_PENALTY > 0 && TODFS_PARAMS.W_CEIL_EFF > 0
      ? 'pathB_results.json'
      : (TODFS_PARAMS.MIN_PRIMARY_STACK >= 4 ? 'stack_enforced_results.json' : 'baseline_results.json');
  const outPath = path.join(OUT_DIR, outFilename);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nFull results saved to ${outPath}`);

  // Ch.10: finishing-percentile distribution shape. Framework says GPP grinder should be inverse-bell
  // (lots of top-1% AND lots of bottom-1%, not a normal bell — bell-shape = mid-cash leak).
  console.log('\nCh.10 — Finishing-percentile distribution (deciles, lower = better finish):');
  const allTodfs: number[] = [];
  const allHermes: number[] = [];
  for (const r of results) { allTodfs.push(...r.todfs.finishPctiles); allHermes.push(...r.hermes.finishPctiles); }
  function decileBuckets(arr: number[]): number[] {
    const buckets = new Array(10).fill(0);
    for (const v of arr) {
      const idx = Math.min(9, Math.floor((1 - v) * 10));  // top finish = decile 0
      buckets[idx]++;
    }
    return buckets;
  }
  const td = decileBuckets(allTodfs);
  const hd = decileBuckets(allHermes);
  console.log('Decile   | top-1%  1-10%  10-20%  20-30%  30-40%  40-50%  50-60%  60-70%  70-80%  80-90%  90-100%');
  console.log(`TODFS    |  ${td.map(c => String(Math.round(c/allTodfs.length*100)).padStart(5) + '%').join(' ')}`);
  console.log(`HermA    |  ${hd.map(c => String(Math.round(c/allHermes.length*100)).padStart(5) + '%').join(' ')}`);
  // Bell-vs-inverse-bell test: high top + high bottom = inverse-bell (good for GPPs).
  const todfsTop = td[0] / allTodfs.length;
  const todfsBot = td[9] / allTodfs.length;
  const todfsMid = (td[4] + td[5]) / allTodfs.length;
  const hermTop = hd[0] / allHermes.length;
  const hermBot = hd[9] / allHermes.length;
  const hermMid = (hd[4] + hd[5]) / allHermes.length;
  console.log(`TODFS  shape: top=${(todfsTop*100).toFixed(1)}% mid=${(todfsMid*100).toFixed(1)}% bot=${(todfsBot*100).toFixed(1)}%  ${todfsTop+todfsBot > todfsMid ? '(inverse-bell ✓)' : '(bell — possible mid-cash leak)'}`);
  console.log(`HermA  shape: top=${(hermTop*100).toFixed(1)}% mid=${(hermMid*100).toFixed(1)}% bot=${(hermBot*100).toFixed(1)}%  ${hermTop+hermBot > hermMid ? '(inverse-bell ✓)' : '(bell — possible mid-cash leak)'}`);

  // Sample lineups (Ch.8 "exposures don't matter, lineups do" — show actual constructions).
  if (results.length > 0) {
    const sample = results[0];
    console.log(`\nSample portfolio comparison — ${sample.slate} (first 3 lineups each):`);
    console.log('  Theory-DFS:');
    for (const lu of sample.todfs.portfolio.slice(0, 3)) {
      const names = lu.players.map(p => `${p.name}(${(p.team || '').padEnd(3)} ${(p.ownership || 0).toFixed(0)}%)`).join(', ');
      console.log(`    [proj=${lu.projection.toFixed(1)} own=${lu.ownership.toFixed(1)}] ${names}`);
    }
    console.log('  Hermes-A:');
    for (const lu of sample.hermes.portfolio.slice(0, 3)) {
      const names = lu.players.map(p => `${p.name}(${(p.team || '').padEnd(3)} ${(p.ownership || 0).toFixed(0)}%)`).join(', ');
      console.log(`    [proj=${lu.projection.toFixed(1)} own=${lu.ownership.toFixed(1)}] ${names}`);
    }
  }
}

// ============================================================
// MAIN
// ============================================================

// Stage 7: parameter sensitivity sweep. Caches loaded slates and re-runs Theory-DFS only
// (skips Hermes-A) with each parameter perturbed by ±20%, capturing key metrics.
async function runSensitivitySweep() {
  console.log('================================================================');
  console.log('STAGE 7 — PARAMETER SENSITIVITY (Theory-DFS standalone, ±20%)');
  console.log('================================================================\n');

  console.log('Loading consensus + 18 slates (one-time)...');
  const consensus = JSON.parse(fs.readFileSync(path.join(DIR, 'pro_consensus_slate_relative.json'), 'utf-8'));
  const consBySlate: Record<string, Record<string, { mean: number; std: number }>> = {};
  for (const k of UNIVERSAL_METRICS) {
    for (const entry of (consensus.metrics[k] || [])) {
      if (!consBySlate[entry.slate]) consBySlate[entry.slate] = {};
      consBySlate[entry.slate][k] = { mean: entry.mean, std: entry.std };
    }
  }
  const allSlates: SlateData[] = [];
  for (const s of SLATES) {
    const sd = await loadSlate(s, consBySlate);
    if (sd) allSlates.push(sd);
  }
  console.log(`  ${allSlates.length} slates cached\n`);

  // Run a single Theory-DFS configuration across all cached slates, return aggregate metrics.
  function runOnce(label: string): { label: string; payout: number; roi: number; t1: number; t01: number; mahal: number; topT01EdgeRatio: number; slatesT01: number } {
    let payout = 0, t1 = 0, t01 = 0, mahalSum = 0, mahalN = 0, slatesT01 = 0;
    for (const sd of allSlates) {
      const portfolio = buildTheoryPortfolio(sd);
      const score = scorePortfolio(portfolio, sd.actuals, sd.payoutTable);
      payout += score.totalPayout; t1 += score.t1; t01 += score.t01;
      if (score.t01 > 0) slatesT01++;
      const metrics = computeUniversal(portfolio.map(lu => lu.players), sd.slateStats);
      const m = mahalanobis(metrics, sd.consensusStats);
      if (m !== null) { mahalSum += m; mahalN++; }
    }
    const fees = N * FEE * allSlates.length;
    const roi = payout / fees - 1;
    const expRandT01 = 0.001 * N * allSlates.length;  // 2.7 for 18 × 150
    return { label, payout, roi, t1, t01, mahal: mahalN > 0 ? mahalSum / mahalN : 0, topT01EdgeRatio: t01 / expRandT01, slatesT01 };
  }

  // Baseline run.
  console.log('Running BASELINE config...');
  const baseline = runOnce('BASELINE (default params)');

  // Parameter perturbations. Pick the 12 most impactful parameters.
  const sweeps: { key: keyof typeof TODFS_PARAMS; default: number }[] = [
    { key: 'W_LEV', default: TODFS_PARAMS.W_LEV },
    { key: 'W_RV', default: TODFS_PARAMS.W_RV },
    { key: 'W_CMB', default: TODFS_PARAMS.W_CMB },
    { key: 'W_VAR', default: TODFS_PARAMS.W_VAR },
    { key: 'W_CEIL_EFF', default: TODFS_PARAMS.W_CEIL_EFF },
    { key: 'STACK_BONUS_PER_HITTER', default: TODFS_PARAMS.STACK_BONUS_PER_HITTER },
    { key: 'PITCHER_VS_HITTER_PENALTY', default: TODFS_PARAMS.PITCHER_VS_HITTER_PENALTY },
    { key: 'OWNERSHIP_EFFICIENCY_EXPONENT', default: TODFS_PARAMS.OWNERSHIP_EFFICIENCY_EXPONENT },
    { key: 'PAIR_CORR_SAME_TEAM', default: TODFS_PARAMS.PAIR_CORR_SAME_TEAM },
    { key: 'EXPLOITATIVE_EXPONENT', default: TODFS_PARAMS.EXPLOITATIVE_EXPONENT },
    { key: 'BAND_HIGH_PCT', default: TODFS_PARAMS.BAND_HIGH_PCT },
    { key: 'PPD_LINEUP_PENALTY', default: TODFS_PARAMS.PPD_LINEUP_PENALTY },
  ];

  type Row = ReturnType<typeof runOnce>;
  const all: Row[] = [baseline];
  console.log(`Running ${sweeps.length * 2} perturbations...`);
  let i = 0;
  for (const sw of sweeps) {
    for (const delta of [-0.20, +0.20]) {
      i++;
      const newVal = sw.default * (1 + delta);
      // Special handling: PITCHER_VS_HITTER_PENALTY is negative; ±20% means more/less negative.
      (TODFS_PARAMS as any)[sw.key] = newVal;
      // BAND_HIGH_PCT perturbation: keep BAND_LOW_PCT symmetrical, adjust BAND_MID_PCT.
      let restoreBandLow: number | null = null;
      let restoreBandMid: number | null = null;
      if (sw.key === 'BAND_HIGH_PCT') {
        restoreBandLow = TODFS_PARAMS.BAND_LOW_PCT;
        restoreBandMid = TODFS_PARAMS.BAND_MID_PCT;
        TODFS_PARAMS.BAND_LOW_PCT = newVal;
        TODFS_PARAMS.BAND_MID_PCT = 1 - 2 * newVal;
      }
      const label = `${String(sw.key).padEnd(32)} ${delta > 0 ? '+' : ''}${(delta * 100).toFixed(0)}% (${newVal.toFixed(3)})`;
      const r = runOnce(label);
      all.push(r);
      // Restore.
      (TODFS_PARAMS as any)[sw.key] = sw.default;
      if (restoreBandLow !== null) TODFS_PARAMS.BAND_LOW_PCT = restoreBandLow;
      if (restoreBandMid !== null) TODFS_PARAMS.BAND_MID_PCT = restoreBandMid;
      process.stdout.write(`  [${i}/${sweeps.length * 2}] ${label}: ROI ${(r.roi*100).toFixed(1)}%  t01=${r.t01} (${r.topT01EdgeRatio.toFixed(2)}x random)  slates_t01=${r.slatesT01}/${allSlates.length}\n`);
    }
  }

  // Emit results table.
  console.log('\n================================================================');
  console.log('SENSITIVITY RESULTS');
  console.log('================================================================\n');
  console.log(`${'Configuration'.padEnd(45)} | ${'ROI'.padStart(7)} | ${'t1'.padStart(3)} | ${'t01'.padStart(3)} | ${'×rand'.padStart(5)} | ${'slates'.padStart(6)} | ${'mahal'.padStart(5)}`);
  console.log('-'.repeat(95));
  for (const r of all) {
    console.log(`${r.label.padEnd(45)} | ${(r.roi*100).toFixed(1).padStart(6)}% | ${String(r.t1).padStart(3)} | ${String(r.t01).padStart(3)} | ${r.topT01EdgeRatio.toFixed(2).padStart(5)} | ${String(r.slatesT01).padStart(3)}/${allSlates.length} | ${r.mahal.toFixed(2).padStart(5)}`);
  }

  // Robustness summary.
  const baselineROI = baseline.roi;
  const baselineT01Edge = baseline.topT01EdgeRatio;
  const perturbations = all.slice(1);
  const roiSpread = Math.max(...perturbations.map(p => p.roi)) - Math.min(...perturbations.map(p => p.roi));
  const t01EdgeSpread = Math.max(...perturbations.map(p => p.topT01EdgeRatio)) - Math.min(...perturbations.map(p => p.topT01EdgeRatio));
  const t01EdgeMean = perturbations.reduce((s, p) => s + p.topT01EdgeRatio, 0) / perturbations.length;
  const t01EdgeMin = Math.min(...perturbations.map(p => p.topT01EdgeRatio));
  const t01EdgeMax = Math.max(...perturbations.map(p => p.topT01EdgeRatio));
  const perturbationsAtRandomOrBetter = perturbations.filter(p => p.topT01EdgeRatio >= 1.0).length;
  const perturbationsAt15xOrBetter = perturbations.filter(p => p.topT01EdgeRatio >= 1.5).length;

  console.log('\n================================================================');
  console.log('STAGE 7 ROBUSTNESS SUMMARY');
  console.log('================================================================\n');
  console.log(`Baseline:                     ROI ${(baselineROI*100).toFixed(1)}%  t01 edge ${baselineT01Edge.toFixed(2)}x random`);
  console.log(`Across ${perturbations.length} perturbations:`);
  console.log(`  ROI spread:                 ${(roiSpread*100).toFixed(1)}pp`);
  console.log(`  t01-edge mean:              ${t01EdgeMean.toFixed(2)}x random`);
  console.log(`  t01-edge range:             [${t01EdgeMin.toFixed(2)}x .. ${t01EdgeMax.toFixed(2)}x]`);
  console.log(`  Perturbations >= 1.0x rand: ${perturbationsAtRandomOrBetter}/${perturbations.length}`);
  console.log(`  Perturbations >= 1.5x rand: ${perturbationsAt15xOrBetter}/${perturbations.length}`);
  if (t01EdgeMin < 1.0) {
    console.log(`  ⚠ Some perturbations drop edge BELOW random — fragile to that parameter`);
  }

  // Save JSON
  const outPath = path.join(OUT_DIR, 'stage7_sensitivity.json');
  fs.writeFileSync(outPath, JSON.stringify(all, null, 2));
  console.log(`\nSaved to ${outPath}`);
}

async function main() {
  if (process.argv.includes('--sweep')) {
    return runSensitivitySweep();
  }
  console.log('================================================================');
  console.log('THEORY-OF-DFS BACKTEST — Stages 1-5');
  console.log('================================================================\n');
  console.log('Theoretical grounding: "Theory of DFS for Advanced Players" by Jordan/BlenderHD.');
  console.log('Framework chapters operationalized: 4 (Levers), 5 (RV), 6 (Combinatorics), 7 (Archetypes), 8 (Portfolio Dynamics), 9 (Exploits).\n');

  console.log('PARAMETER MANIFEST:');
  console.log('  Stage 1B Correlation:   stack/hitter+0.10  bringback 0.05/0.08  P-vs-H -0.10');
  console.log('  Stage 1D RelValue:      own_eff_exp=0.5  direct_lev_bonus=0.03');
  console.log('  Stage 1E Combinatorics: same-team 1.5x  opposing 0.7x  triples=top-3');
  console.log(`  Stage 2 EV weights:     proj=${TODFS_PARAMS.W_PROJ}  lev=${TODFS_PARAMS.W_LEV}  rv=${TODFS_PARAMS.W_RV}  cmb=${TODFS_PARAMS.W_CMB}  var=${TODFS_PARAMS.W_VAR}`);
  console.log(`  Stage 3A Frequency:     exploit_exp=${TODFS_PARAMS.EXPLOITATIVE_EXPONENT}  exp_cap_hit=${TODFS_PARAMS.EXPOSURE_CAP_HITTER}  exp_cap_p=${TODFS_PARAMS.EXPOSURE_CAP_PITCHER}`);
  console.log(`  Stage 3B Variance bands: 20/60/20 (high/mid/low)`);
  console.log(`  Stage 3C Diversification: max_overlap=${TODFS_PARAMS.MAX_PAIRWISE_OVERLAP}  triple_freq_cap=${TODFS_PARAMS.TRIPLE_FREQ_CAP}`);
  console.log(`  Hard constraint: minPrimaryStack=${TODFS_PARAMS.MIN_PRIMARY_STACK}  (added 2026-04-30 after baseline)`);
  console.log(`  Ch.9 #9 Sim-Optimals exploit: top ${TODFS_PARAMS.SIM_OPTIMALS_TOP_PCT*100}% players +${TODFS_PARAMS.SIM_OPTIMALS_OWN_BUMP_PP}pp ownership`);
  console.log(`  Ch.9 #4 PPD bias exploit:    top ${TODFS_PARAMS.PPD_TOP_PCT*100}% PPD players +${TODFS_PARAMS.PPD_OWN_BUMP_PP}pp own; lineups in top ${TODFS_PARAMS.PPD_LINEUP_TOP_PCT*100}% PPD penalized ${TODFS_PARAMS.PPD_LINEUP_PENALTY*100}%`);
  console.log(`  Ch.9 #2 Median-overweighting: ceiling/median ratio weight=${TODFS_PARAMS.W_CEIL_EFF}`);
  console.log(`  Ch.9 #1 Projection fragility: top ${TODFS_PARAMS.FRAGILITY_TOP_PCT*100}% stdDev players +${TODFS_PARAMS.FRAGILITY_OWN_BUMP_PP}pp own (if data present)`);
  console.log(`  Ch.9 #5 Ultra-chalk avoidance: lineups with ${TODFS_PARAMS.ULTRA_CHALK_LINEUP_MIN_COUNT}+ top-quartile-owned players penalized ${TODFS_PARAMS.ULTRA_CHALK_PENALTY*100}%`);
  console.log(`  Ch.9 #7 Clumping detector:    diagnostic only (post-selection warning)`);
  console.log(`  Ch.9 #8 PPD-stack penalty:    primary 5-stack of top-3-PPD-team penalized ${TODFS_PARAMS.PPD_STACK_PENALTY*100}%`);
  console.log(`  Ch.9 #3, #6, #10:             not operationalizable from current data (documented in source)`);
  console.log(`  Ch.7 Archetypes:              all 10 surveyed; nuts_gap + numTeams active per slate; rest constants for our context`);
  console.log(`  Ch.10 Finishing-pct shape:    reported per-portfolio (inverse-bell vs bell)\n`);

  const t0 = Date.now();
  const results = await runBacktest();
  const elapsed = (Date.now() - t0) / 1000;
  console.log(`\nBacktest completed in ${elapsed.toFixed(1)}s`);

  emitReport(results);
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });
