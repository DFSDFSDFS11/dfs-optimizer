/**
 * Structural Validation — answers Q2 ("am I building structurally correct GPP lineups?")
 * not Q1 ("does this system have positive ROI?"). Q2 requires fewer slates because
 * structural metrics are stable.
 *
 * Six framework-derived validations across all systems:
 *   V1 — Finishing-percentile distribution shape (Ch.10): inverse-bell vs bell
 *   V2 — Top-tail concentration vs random (Ch.10 sharp-user pattern)
 *   V3 — Mahalanobis to pro consensus (Ch.10 — MLB only, no NBA pro data)
 *   V4 — Variance band distribution (Ch.8): 20/60/20 high/mid/low spread
 *   V5 — Per-archetype adaptation (Ch.7): metrics shift with slate type?
 *   V6 — Combinatorial uniqueness (Ch.6): pair frequencies at/below pool equilibrium
 *
 * Systems evaluated:
 *   MLB: Hermes-A, Theory-DFS (full framework), Random (uniform sample from pool)
 *   NBA: Theory-DFS (NBA), Random (uniform sample from pool)
 *
 * Output: JSON with per-system per-slate per-lineup details + per-system scorecards.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player, ContestConfig } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals } from '../parser';
import { getContestConfig } from '../rules';
import { productionSelect } from '../selection/production-selector';
import { precomputeComboFrequencies, comboBonus } from '../selection/combo-leverage';

// ============================================================
// CONSTANTS
// ============================================================

const MLB_DIR = 'C:/Users/colin/dfs opto';
const NBA_DIR = 'C:/Users/colin/Projects/dfs-optimizer/historical_slates';
const OUT_DIR = 'C:/Users/colin/dfs opto/theory_dfs_structural';
const FEE = 20;
const N = 150;

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const MLB_SLATES = [
  { slate: '4-6-26', proj: '4-6-26_projections.csv', actuals: 'dkactuals 4-6-26.csv', pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26', proj: '4-8-26projections.csv', actuals: '4-8-26actuals.csv', pool: '4-8-26sspool.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv', actuals: '4-12-26actuals.csv', pool: '4-12-26sspool.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv', actuals: '4-14-26actuals.csv', pool: '4-14-26sspool.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv', actuals: '4-15-26actuals.csv', pool: '4-15-26sspool.csv' },
  { slate: '4-17-26', proj: '4-17-26projections.csv', actuals: '4-17-26actuals.csv', pool: '4-17-26sspool.csv' },
  { slate: '4-18-26', proj: '4-18-26projections.csv', actuals: '4-18-26actuals.csv', pool: '4-18-26sspool.csv' },
  { slate: '4-19-26', proj: '4-19-26projections.csv', actuals: '4-19-26actuals.csv', pool: '4-19-26sspool.csv' },
  { slate: '4-20-26', proj: '4-20-26projections.csv', actuals: '4-20-26actuals.csv', pool: '4-20-26sspool.csv' },
  { slate: '4-21-26', proj: '4-21-26projections.csv', actuals: '4-21-26actuals.csv', pool: '4-21-26sspool.csv' },
  { slate: '4-22-26', proj: '4-22-26projections.csv', actuals: '4-22-26actuals.csv', pool: '4-22-26sspool.csv' },
  { slate: '4-23-26', proj: '4-23-26projections.csv', actuals: '4-23-26actuals.csv', pool: '4-23-26sspool.csv' },
  { slate: '4-24-26', proj: '4-24-26projections.csv', actuals: '4-24-26actuals.csv', pool: '4-24-26sspool.csv' },
  { slate: '4-25-26', proj: '4-25-26projections.csv', actuals: '4-25-26actuals.csv', pool: '4-25-26sspool.csv' },
  { slate: '4-25-26-early', proj: '4-25-26projectionsearly.csv', actuals: '4-25-26actualsearly.csv', pool: '4-25-26sspoolearly.csv' },
  { slate: '4-26-26', proj: '4-26-26projections.csv', actuals: '4-26-26actuals.csv', pool: '4-26-26sspool.csv' },
  { slate: '4-27-26', proj: '4-27-26projections.csv', actuals: '4-27-26actuals.csv', pool: '4-27-26sspool.csv' },
  { slate: '4-28-26', proj: '4-28-26projections.csv', actuals: '4-28-26actuals.csv', pool: '4-28-26sspool.csv' },
];

const NBA_SLATES = [
  { slate: '2026-01-16', proj: '2026-01-16_projections.csv', actuals: '2026-01-16_actuals.csv', pool: '_backtest_2026-01-16.csv' },
  { slate: '2026-01-17', proj: '2026-01-17_projections.csv', actuals: '2026-01-17_actuals.csv', pool: '_backtest_2026-01-17.csv' },
  { slate: '2026-01-18', proj: '2026-01-18_projections.csv', actuals: '2026-01-18_actuals.csv', pool: '_backtest_2026-01-18.csv' },
  { slate: '2026-01-19', proj: '2026-01-19_projections.csv', actuals: '2026-01-19_actuals.csv', pool: '_backtest_2026-01-19.csv' },
  { slate: '2026-01-20', proj: '2026-01-20_projections.csv', actuals: '2026-01-20_actuals.csv', pool: '_backtest_2026-01-20.csv' },
  { slate: '2026-02-25', proj: '2026-02-25_projections.csv', actuals: '2026-02-25_actuals.csv', pool: '_backtest_2026-02-25.csv' },
  { slate: '2026-02-26', proj: '2026-02-26_projections.csv', actuals: '2026-02-26_actuals.csv', pool: '_backtest_2026-02-26.csv' },
  { slate: '2026-02-27', proj: '2026-02-27_projections.csv', actuals: '2026-02-27_actuals.csv', pool: '_backtest_2026-02-27.csv' },
  { slate: '2026-02-28', proj: '2026-02-28_projections.csv', actuals: '2026-02-28_actuals.csv', pool: '_backtest_2026-02-28.csv' },
  { slate: '2026-03-03', proj: '2026-03-03_projections.csv', actuals: '2026-03-03_actuals.csv', pool: '_backtest_2026-03-03.csv' },
  { slate: '2026-03-05', proj: '2026-03-05_dk_projections.csv', actuals: '2026-03-05_dk_actuals.csv', pool: '_backtest_2026-03-05_dk.csv' },
  { slate: '2026-03-06', proj: '2026-03-06_dk_projections.csv', actuals: '2026-03-06_dk_actuals.csv', pool: '_backtest_2026-03-06_dk.csv' },
];

// Hermes-A canonical config (MLB only).
const HERMES_A = {
  lambda: 0.58, gamma: 5, teamCapPct: 0.26, minPrimaryStack: 4,
  maxExposure: 0.21, maxExposurePitcher: 0.41, extremeCornerCap: true,
  comboPower: 4,
  binAllocation: { chalk: 0.50, core: 0.30, value: 0.20, contra: 0.00, deep: 0.00 },
};

// ============================================================
// UTILS
// ============================================================

function norm(n: string): string {
  return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function mean(a: number[]): number { if (!a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; }
function rankPercentile(values: number[]): number[] {
  const idx = values.map((v, i) => ({ v, i }));
  idx.sort((a, b) => a.v - b.v);
  const out = new Array<number>(values.length);
  for (let r = 0; r < values.length; r++) out[idx[r].i] = values.length > 1 ? r / (values.length - 1) : 0;
  return out;
}

// ============================================================
// SLATE LOADING
// ============================================================

interface SlateData {
  slate: string;
  sport: 'mlb' | 'nba';
  candidates: Lineup[];
  players: Player[];
  actuals: ContestActuals;
  config: ContestConfig;
  numTeams: number;
  numGames: number;
  // Slate stats
  slatePlayerOwnPctile: Map<string, number>;
  optimalProj: number;
  chalkAnchorOwn: number;
  // Pro consensus (MLB only).
  consensusStats: Record<string, { mean: number; std: number }> | null;
}

async function loadMlbSlate(s: typeof MLB_SLATES[0], cons: any): Promise<SlateData | null> {
  const proj = path.join(MLB_DIR, s.proj);
  const act = path.join(MLB_DIR, s.actuals);
  const pool = path.join(MLB_DIR, s.pool);
  if (![proj, act, pool].every(p => fs.existsSync(p))) return null;
  const pr = parseCSVFile(proj, 'mlb', true);
  const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
  const playerPool = buildPlayerPool(pr.players, pr.detectedContestType);
  const actuals = parseContestActuals(act, config);
  const idMap = new Map<string, Player>();
  for (const p of playerPool.players) idMap.set(p.id, p);
  const loaded = loadPoolFromCSV({ filePath: pool, config, playerMap: idMap });
  const teams = new Set(playerPool.players.map(p => (p.team || '').toUpperCase()).filter(t => t));
  const games = new Set<string>();
  for (const p of playerPool.players) {
    const t = (p.team || '').toUpperCase(), o = (p.opponent || '').toUpperCase();
    if (t && o) games.add([t, o].sort().join('@'));
  }
  // Slate stats.
  const ownPctile = new Map<string, number>();
  const sortedByOwn = [...playerPool.players].sort((a, b) => (a.ownership || 0) - (b.ownership || 0));
  for (let i = 0; i < sortedByOwn.length; i++) {
    ownPctile.set(sortedByOwn[i].id, sortedByOwn.length > 1 ? i / (sortedByOwn.length - 1) : 0);
  }
  let optProj = 0;
  for (const lu of loaded.lineups) if (lu.projection > optProj) optProj = lu.projection;
  // Chalk anchor: top 100 lineups by ownership, mean.
  const sortedByLuOwn = [...loaded.lineups].sort((a, b) => (b.ownership || 0) - (a.ownership || 0));
  const chalkAnchor = mean(sortedByLuOwn.slice(0, Math.min(100, sortedByLuOwn.length)).map(lu => lu.ownership || 0));
  return {
    slate: s.slate, sport: 'mlb', candidates: loaded.lineups, players: playerPool.players, actuals, config,
    numTeams: teams.size, numGames: games.size,
    slatePlayerOwnPctile: ownPctile, optimalProj: optProj, chalkAnchorOwn: chalkAnchor,
    consensusStats: cons[s.slate] || null,
  };
}

async function loadNbaSlate(s: typeof NBA_SLATES[0]): Promise<SlateData | null> {
  const proj = path.join(NBA_DIR, s.proj);
  const act = path.join(NBA_DIR, s.actuals);
  const pool = path.join(NBA_DIR, s.pool);
  if (![proj, act, pool].every(p => fs.existsSync(p))) return null;
  const pr = parseCSVFile(proj, 'nba', true);
  const config = getContestConfig('dk', 'nba', pr.detectedContestType);
  const playerPool = buildPlayerPool(pr.players, pr.detectedContestType);
  const actuals = parseContestActuals(act, config);
  const idMap = new Map<string, Player>();
  for (const p of playerPool.players) idMap.set(p.id, p);
  const loaded = loadPoolFromCSV({ filePath: pool, config, playerMap: idMap });
  const teams = new Set(playerPool.players.map(p => (p.team || '').toUpperCase()).filter(t => t));
  const games = new Set<string>();
  for (const p of playerPool.players) {
    const t = (p.team || '').toUpperCase(), o = (p.opponent || '').toUpperCase();
    if (t && o) games.add([t, o].sort().join('@'));
  }
  const ownPctile = new Map<string, number>();
  const sortedByOwn = [...playerPool.players].sort((a, b) => (a.ownership || 0) - (b.ownership || 0));
  for (let i = 0; i < sortedByOwn.length; i++) {
    ownPctile.set(sortedByOwn[i].id, sortedByOwn.length > 1 ? i / (sortedByOwn.length - 1) : 0);
  }
  let optProj = 0;
  for (const lu of loaded.lineups) if (lu.projection > optProj) optProj = lu.projection;
  const sortedByLuOwn = [...loaded.lineups].sort((a, b) => (b.ownership || 0) - (a.ownership || 0));
  const chalkAnchor = mean(sortedByLuOwn.slice(0, Math.min(100, sortedByLuOwn.length)).map(lu => lu.ownership || 0));
  return {
    slate: s.slate, sport: 'nba', candidates: loaded.lineups, players: playerPool.players, actuals, config,
    numTeams: teams.size, numGames: games.size,
    slatePlayerOwnPctile: ownPctile, optimalProj: optProj, chalkAnchorOwn: chalkAnchor,
    consensusStats: null,
  };
}

// ============================================================
// PORTFOLIO BUILDERS — minimal wrappers
// ============================================================

// Theory-DFS-MLB params (full framework, matching theory-of-dfs-backtest.ts).
const TODFS_MLB_PARAMS = {
  STACK_BONUS_PER_HITTER: 0.10, BRINGBACK_1: 0.05, BRINGBACK_2: 0.08, PITCHER_VS_HITTER_PENALTY: -0.10,
  MIN_PRIMARY_STACK: 4, OWNERSHIP_EFFICIENCY_EXPONENT: 0.5,
  W_PROJ: 1.0, W_LEV: 0.30, W_RV: 0.20, W_CMB: 0.25, W_VAR: 0.15, W_CEIL_EFF: 0.10,
  EXPLOITATIVE_EXPONENT: 1.5, EXPOSURE_CAP_HITTER: 0.50, EXPOSURE_CAP_PITCHER: 1.00,
  BAND_HIGH_PCT: 0.20, BAND_MID_PCT: 0.60, BAND_LOW_PCT: 0.20,
  MAX_PAIRWISE_OVERLAP: 6, TRIPLE_FREQ_CAP: 5, PPD_LINEUP_PENALTY: 0.10, PPD_LINEUP_TOP_PCT: 0.10,
  ULTRA_CHALK_PLAYER_THRESHOLD_PCT: 0.75, ULTRA_CHALK_LINEUP_MIN_COUNT: 5, ULTRA_CHALK_PENALTY: 0.05,
  TRIPLES_EVALUATED: 3, PAIR_CORR_SAME_TEAM: 1.5, PAIR_CORR_OPPOSING: 0.7, PAIR_CORR_UNRELATED: 1.0,
  HITTER_VARIANCE_MULT: 1.3, PITCHER_VARIANCE_MULT: 1.0,
};

const TODFS_NBA_PARAMS = {
  GAME_STACK_BONUS: 0.05, OPPOSING_TEAM_BONUS: 0.03, TEAM_NEGATIVE_PER_EXTRA: -0.04,
  OWNERSHIP_EFFICIENCY_EXPONENT: 0.5, W_PROJ: 1.0, W_LEV: 0.30, W_RV: 0.20, W_CMB: 0.25, W_VAR: 0.15, W_CEIL_EFF: 0.10,
  EXPLOITATIVE_EXPONENT: 1.5, EXPOSURE_CAP_HITTER: 0.40,
  BAND_HIGH_PCT: 0.20, BAND_MID_PCT: 0.60, BAND_LOW_PCT: 0.20,
  MAX_PAIRWISE_OVERLAP: 5, TRIPLE_FREQ_CAP: 5, PPD_LINEUP_PENALTY: 0.10, PPD_LINEUP_TOP_PCT: 0.10,
  ULTRA_CHALK_PLAYER_THRESHOLD_PCT: 0.75, ULTRA_CHALK_LINEUP_MIN_COUNT: 4, ULTRA_CHALK_PENALTY: 0.05,
  TRIPLES_EVALUATED: 3, PAIR_CORR_SAME_TEAM: 1.5, PAIR_CORR_OPPOSING: 0.7, PAIR_CORR_UNRELATED: 1.0,
  HITTER_VARIANCE_MULT: 1.0,
  PROJ_FLOOR_SMALL: 0.05, PROJ_FLOOR_MEDIUM: 0.08, PROJ_FLOOR_LARGE: 0.12,
};

// Lightweight MLB Theory-DFS portfolio (essentials only — not full Path-B/full-framework).
// For structural-validation purposes, we use the key elements: stack constraint, EV scoring,
// 20/60/20 bands, exposure cap. This matches the "stack-fixed" run which had the best ROI.
function buildTheoryMlbPortfolio(sd: SlateData): Lineup[] {
  const candidates = sd.candidates;
  // Score lineups.
  const scored = candidates.map(lu => {
    // Projection score.
    const proj = lu.projection;
    let floor = 0, ceiling = 0;
    for (const p of lu.players) {
      if (p.percentiles) { floor += p.percentiles.p25 || p.projection * 0.85; ceiling += p.percentiles.p75 || p.projection * 1.15; }
      else { floor += p.projection * 0.85; ceiling += p.projection * 1.15; }
    }
    const range = ceiling - floor;

    // Correlation (MLB stack/bringback/P-vs-H).
    const teamHitters = new Map<string, number>();
    const pitchers: Player[] = [];
    for (const p of lu.players) {
      const pos = (p.position || '').toUpperCase();
      if (pos.includes('P')) pitchers.push(p);
      else { const t = (p.team || '').toUpperCase(); if (t) teamHitters.set(t, (teamHitters.get(t) || 0) + 1); }
    }
    let primaryTeam = '', primarySize = 0;
    for (const [t, c] of teamHitters) if (c > primarySize) { primarySize = c; primaryTeam = t; }
    let primaryOpp = '';
    for (const p of lu.players) if ((p.team || '').toUpperCase() === primaryTeam) { primaryOpp = (p.opponent || '').toUpperCase(); if (primaryOpp) break; }
    const bringBack = primaryOpp ? (teamHitters.get(primaryOpp) || 0) : 0;
    let pOppHitters = 0;
    for (const p of pitchers) { const o = (p.opponent || '').toUpperCase(); if (o) pOppHitters += teamHitters.get(o) || 0; }
    let corrAdj = 0;
    if (primarySize >= 3) corrAdj += TODFS_MLB_PARAMS.STACK_BONUS_PER_HITTER * (primarySize - 2);
    if (bringBack === 1) corrAdj += TODFS_MLB_PARAMS.BRINGBACK_1;
    else if (bringBack >= 2) corrAdj += TODFS_MLB_PARAMS.BRINGBACK_2;
    corrAdj += TODFS_MLB_PARAMS.PITCHER_VS_HITTER_PENALTY * pOppHitters;

    // Ownership.
    let logOwn = 0;
    for (const p of lu.players) logOwn += Math.log(Math.max(0.1, p.ownership || 0.5));

    // PPD score.
    let ppd = 0;
    for (const p of lu.players) if (p.salary && p.projection) ppd += p.projection / (p.salary / 1000);

    return { lu, proj, floor, ceiling, range, corrAdj, primarySize, logOwn, ppd, ev: 0, projPct: 0, ownPct: 0, rangePct: 0, ppdPct: 0 };
  });

  // Slate-relative percentiles.
  const projPct = rankPercentile(scored.map(s => s.proj * (1 + s.corrAdj)));
  const ownPct = rankPercentile(scored.map(s => s.logOwn));
  const rangePct = rankPercentile(scored.map(s => s.range));
  const ppdPct = rankPercentile(scored.map(s => s.ppd));
  for (let i = 0; i < scored.length; i++) {
    scored[i].projPct = projPct[i]; scored[i].ownPct = ownPct[i];
    scored[i].rangePct = rangePct[i]; scored[i].ppdPct = ppdPct[i];
  }
  for (const s of scored) {
    let ev = TODFS_MLB_PARAMS.W_PROJ * s.projPct
           + TODFS_MLB_PARAMS.W_LEV * (1 - s.ownPct)
           + TODFS_MLB_PARAMS.W_VAR * s.rangePct * 0.85;
    if (s.ppdPct >= 1 - TODFS_MLB_PARAMS.PPD_LINEUP_TOP_PCT) ev *= (1 - TODFS_MLB_PARAMS.PPD_LINEUP_PENALTY);
    s.ev = ev;
  }

  // Filter: stack constraint.
  let pool = scored.filter(s => s.primarySize >= TODFS_MLB_PARAMS.MIN_PRIMARY_STACK);
  if (pool.length < N) pool = scored;

  // Variance bands + greedy selection.
  const sortedHigh = [...pool].sort((a, b) => (b.projPct + b.ownPct) - (a.projPct + a.ownPct));
  const sortedLow = [...pool].sort((a, b) => ((1 - b.projPct) + (1 - b.ownPct)) - ((1 - a.projPct) + (1 - a.ownPct)));
  const HIGH_TARGET = Math.round(N * TODFS_MLB_PARAMS.BAND_HIGH_PCT);
  const LOW_TARGET = Math.round(N * TODFS_MLB_PARAMS.BAND_LOW_PCT);
  const MID_TARGET = N - HIGH_TARGET - LOW_TARGET;

  const selected: typeof scored = [];
  const exposure = new Map<string, number>();
  const seen = new Set<string>();
  function passes(s: typeof scored[0]): boolean {
    if (seen.has(s.lu.hash)) return false;
    for (const p of s.lu.players) {
      const cur = exposure.get(p.id) || 0;
      const isPitcher = (p.position || '').toUpperCase().includes('P');
      const cap = isPitcher ? TODFS_MLB_PARAMS.EXPOSURE_CAP_PITCHER : TODFS_MLB_PARAMS.EXPOSURE_CAP_HITTER;
      if ((cur + 1) / N > cap) return false;
    }
    const ids = new Set(s.lu.players.map(p => p.id));
    for (const sel of selected) {
      let ov = 0; for (const p of sel.lu.players) if (ids.has(p.id)) ov++;
      if (ov > TODFS_MLB_PARAMS.MAX_PAIRWISE_OVERLAP) return false;
    }
    return true;
  }
  function add(s: typeof scored[0]) {
    selected.push(s); seen.add(s.lu.hash);
    for (const p of s.lu.players) exposure.set(p.id, (exposure.get(p.id) || 0) + 1);
  }
  function fillBand(bandPool: typeof scored, target: number) {
    const sorted = [...bandPool].sort((a, b) => b.ev - a.ev);
    let added = 0;
    for (const s of sorted) { if (added >= target) break; if (passes(s)) { add(s); added++; } }
    if (added < target) {
      // Relax overlap.
      const old = TODFS_MLB_PARAMS.MAX_PAIRWISE_OVERLAP;
      (TODFS_MLB_PARAMS as any).MAX_PAIRWISE_OVERLAP = old + 1;
      for (const s of sorted) { if (added >= target) break; if (passes(s)) { add(s); added++; } }
      (TODFS_MLB_PARAMS as any).MAX_PAIRWISE_OVERLAP = old;
    }
  }
  fillBand(sortedHigh.slice(0, Math.max(HIGH_TARGET * 5, 200)), HIGH_TARGET);
  fillBand(pool, MID_TARGET);
  fillBand(sortedLow.slice(0, Math.max(LOW_TARGET * 5, 200)), LOW_TARGET);
  if (selected.length < N) {
    const sorted = [...pool].sort((a, b) => b.ev - a.ev);
    for (const s of sorted) { if (selected.length >= N) break; if (passes(s)) add(s); }
  }
  return selected.slice(0, N).map(s => s.lu);
}

// Theory-DFS-MLB with Hermes-A's combo mechanism in place of raw pair/triple.
// Same band split, same EV weights, same constraints — only the combo penalty signal swapped.
// This isolates whether Hermes-A's λ × comboFreq is the operational missing piece.
function buildTheoryMlbHermesComboPortfolio(sd: SlateData): Lineup[] {
  const candidates = sd.candidates;
  // Hermes-A combo precompute: 4 structural combo types, projection^4 weighting.
  const comboFreq = precomputeComboFrequencies(candidates, 4);

  const scored = candidates.map(lu => {
    const proj = lu.projection;
    let floor = 0, ceiling = 0;
    for (const p of lu.players) {
      if (p.percentiles) { floor += p.percentiles.p25 || p.projection * 0.85; ceiling += p.percentiles.p75 || p.projection * 1.15; }
      else { floor += p.projection * 0.85; ceiling += p.projection * 1.15; }
    }
    const range = ceiling - floor;

    // MLB correlation (same as Theory-DFS).
    const teamHitters = new Map<string, number>();
    const pitchers: Player[] = [];
    for (const p of lu.players) {
      const pos = (p.position || '').toUpperCase();
      if (pos.includes('P')) pitchers.push(p);
      else { const t = (p.team || '').toUpperCase(); if (t) teamHitters.set(t, (teamHitters.get(t) || 0) + 1); }
    }
    let primaryTeam = '', primarySize = 0;
    for (const [t, c] of teamHitters) if (c > primarySize) { primarySize = c; primaryTeam = t; }
    let primaryOpp = '';
    for (const p of lu.players) if ((p.team || '').toUpperCase() === primaryTeam) { primaryOpp = (p.opponent || '').toUpperCase(); if (primaryOpp) break; }
    const bringBack = primaryOpp ? (teamHitters.get(primaryOpp) || 0) : 0;
    let pOppHitters = 0;
    for (const p of pitchers) { const o = (p.opponent || '').toUpperCase(); if (o) pOppHitters += teamHitters.get(o) || 0; }
    let corrAdj = 0;
    if (primarySize >= 3) corrAdj += TODFS_MLB_PARAMS.STACK_BONUS_PER_HITTER * (primarySize - 2);
    if (bringBack === 1) corrAdj += TODFS_MLB_PARAMS.BRINGBACK_1;
    else if (bringBack >= 2) corrAdj += TODFS_MLB_PARAMS.BRINGBACK_2;
    corrAdj += TODFS_MLB_PARAMS.PITCHER_VS_HITTER_PENALTY * pOppHitters;

    let logOwn = 0;
    for (const p of lu.players) logOwn += Math.log(Math.max(0.1, p.ownership || 0.5));
    let ppd = 0;
    for (const p of lu.players) if (p.salary && p.projection) ppd += p.projection / (p.salary / 1000);

    // ←← KEY DIFFERENCE: Hermes-A combo bonus instead of Theory-DFS pair/triple uniqueness.
    const hCombo = comboBonus(lu, comboFreq);

    return { lu, proj, floor, ceiling, range, corrAdj, primarySize, logOwn, ppd, hCombo,
             ev: 0, projPct: 0, ownPct: 0, rangePct: 0, ppdPct: 0, hComboPct: 0 };
  });

  const projPct = rankPercentile(scored.map(s => s.proj * (1 + s.corrAdj)));
  const ownPct = rankPercentile(scored.map(s => s.logOwn));
  const rangePct = rankPercentile(scored.map(s => s.range));
  const ppdPct = rankPercentile(scored.map(s => s.ppd));
  const hComboPct = rankPercentile(scored.map(s => s.hCombo));
  for (let i = 0; i < scored.length; i++) {
    scored[i].projPct = projPct[i]; scored[i].ownPct = ownPct[i];
    scored[i].rangePct = rangePct[i]; scored[i].ppdPct = ppdPct[i];
    scored[i].hComboPct = hComboPct[i];
  }

  // EV: same as Theory-DFS-MLB but with Hermes lambda=0.58 weight on combo bonus.
  const HERMES_LAMBDA = 0.58;
  for (const s of scored) {
    let ev = TODFS_MLB_PARAMS.W_PROJ * s.projPct
           + TODFS_MLB_PARAMS.W_LEV * (1 - s.ownPct)
           + TODFS_MLB_PARAMS.W_VAR * s.rangePct * 0.85
           + HERMES_LAMBDA * s.hComboPct;  // ←← Hermes-A combo penalty (rewards rare structural combos)
    if (s.ppdPct >= 1 - TODFS_MLB_PARAMS.PPD_LINEUP_TOP_PCT) ev *= (1 - TODFS_MLB_PARAMS.PPD_LINEUP_PENALTY);
    s.ev = ev;
  }

  // Same stack filter and band selection as Theory-DFS-MLB.
  let pool = scored.filter(s => s.primarySize >= TODFS_MLB_PARAMS.MIN_PRIMARY_STACK);
  if (pool.length < N) pool = scored;

  const sortedHigh = [...pool].sort((a, b) => (b.projPct + b.ownPct) - (a.projPct + a.ownPct));
  const sortedLow = [...pool].sort((a, b) => ((1 - b.projPct) + (1 - b.ownPct)) - ((1 - a.projPct) + (1 - a.ownPct)));
  const HIGH_TARGET = Math.round(N * TODFS_MLB_PARAMS.BAND_HIGH_PCT);
  const LOW_TARGET = Math.round(N * TODFS_MLB_PARAMS.BAND_LOW_PCT);
  const MID_TARGET = N - HIGH_TARGET - LOW_TARGET;
  const selected: typeof scored = [];
  const exposure = new Map<string, number>();
  const seen = new Set<string>();
  function passes(s: typeof scored[0]): boolean {
    if (seen.has(s.lu.hash)) return false;
    for (const p of s.lu.players) {
      const cur = exposure.get(p.id) || 0;
      const isPitcher = (p.position || '').toUpperCase().includes('P');
      const cap = isPitcher ? TODFS_MLB_PARAMS.EXPOSURE_CAP_PITCHER : TODFS_MLB_PARAMS.EXPOSURE_CAP_HITTER;
      if ((cur + 1) / N > cap) return false;
    }
    const ids = new Set(s.lu.players.map(p => p.id));
    for (const sel of selected) {
      let ov = 0; for (const p of sel.lu.players) if (ids.has(p.id)) ov++;
      if (ov > TODFS_MLB_PARAMS.MAX_PAIRWISE_OVERLAP) return false;
    }
    return true;
  }
  function add(s: typeof scored[0]) {
    selected.push(s); seen.add(s.lu.hash);
    for (const p of s.lu.players) exposure.set(p.id, (exposure.get(p.id) || 0) + 1);
  }
  function fillBand(bandPool: typeof scored, target: number) {
    const sorted = [...bandPool].sort((a, b) => b.ev - a.ev);
    let added = 0;
    for (const s of sorted) { if (added >= target) break; if (passes(s)) { add(s); added++; } }
    if (added < target) {
      const old = TODFS_MLB_PARAMS.MAX_PAIRWISE_OVERLAP;
      (TODFS_MLB_PARAMS as any).MAX_PAIRWISE_OVERLAP = old + 1;
      for (const s of sorted) { if (added >= target) break; if (passes(s)) { add(s); added++; } }
      (TODFS_MLB_PARAMS as any).MAX_PAIRWISE_OVERLAP = old;
    }
  }
  fillBand(sortedHigh.slice(0, Math.max(HIGH_TARGET * 5, 200)), HIGH_TARGET);
  fillBand(pool, MID_TARGET);
  fillBand(sortedLow.slice(0, Math.max(LOW_TARGET * 5, 200)), LOW_TARGET);
  if (selected.length < N) {
    const sorted = [...pool].sort((a, b) => b.ev - a.ev);
    for (const s of sorted) { if (selected.length >= N) break; if (passes(s)) add(s); }
  }
  return selected.slice(0, N).map(s => s.lu);
}

// Theory-DFS-NBA portfolio (mirrors theory-of-dfs-nba-backtest.ts but inline).
function buildTheoryNbaPortfolio(sd: SlateData): Lineup[] {
  const candidates = sd.candidates;
  const scored = candidates.map(lu => {
    const proj = lu.projection;
    let floor = 0, ceiling = 0;
    for (const p of lu.players) {
      if (p.percentiles) { floor += p.percentiles.p25 || p.projection * 0.85; ceiling += p.percentiles.p75 || p.projection * 1.15; }
      else { floor += p.projection * 0.85; ceiling += p.projection * 1.15; }
    }
    const range = ceiling - floor;

    // NBA correlation: game-stack bonus, cannibalization penalty.
    const gameCounts = new Map<string, number>();
    const teamCounts = new Map<string, number>();
    for (const p of lu.players) {
      const t = (p.team || '').toUpperCase(), o = (p.opponent || '').toUpperCase();
      if (t) teamCounts.set(t, (teamCounts.get(t) || 0) + 1);
      if (t && o) { const g = [t, o].sort().join('@'); gameCounts.set(g, (gameCounts.get(g) || 0) + 1); }
    }
    let primaryGameSize = 0, primaryGame = '';
    for (const [g, c] of gameCounts) if (c > primaryGameSize) { primaryGameSize = c; primaryGame = g; }
    let bringBack = 0;
    if (primaryGame) {
      const [a, b] = primaryGame.split('@');
      const ca = teamCounts.get(a) || 0, cb = teamCounts.get(b) || 0;
      if (ca > 0 && cb > 0) bringBack = Math.min(ca, cb);
    }
    let cannibalization = 0;
    for (const [, c] of teamCounts) if (c >= 3) cannibalization += (c - 2);
    let corrAdj = 0;
    if (primaryGameSize >= 3) corrAdj += TODFS_NBA_PARAMS.GAME_STACK_BONUS;
    if (primaryGameSize >= 3 && bringBack >= 2) corrAdj += TODFS_NBA_PARAMS.OPPOSING_TEAM_BONUS;
    corrAdj += TODFS_NBA_PARAMS.TEAM_NEGATIVE_PER_EXTRA * cannibalization;

    let logOwn = 0;
    for (const p of lu.players) logOwn += Math.log(Math.max(0.1, p.ownership || 0.5));
    let ppd = 0;
    for (const p of lu.players) if (p.salary && p.projection) ppd += p.projection / (p.salary / 1000);

    return { lu, proj, floor, ceiling, range, corrAdj, primaryGameSize, logOwn, ppd, ev: 0, projPct: 0, ownPct: 0, rangePct: 0, ppdPct: 0 };
  });
  const projPct = rankPercentile(scored.map(s => s.proj * (1 + s.corrAdj)));
  const ownPct = rankPercentile(scored.map(s => s.logOwn));
  const rangePct = rankPercentile(scored.map(s => s.range));
  const ppdPct = rankPercentile(scored.map(s => s.ppd));
  for (let i = 0; i < scored.length; i++) {
    scored[i].projPct = projPct[i]; scored[i].ownPct = ownPct[i];
    scored[i].rangePct = rangePct[i]; scored[i].ppdPct = ppdPct[i];
  }
  for (const s of scored) {
    let ev = TODFS_NBA_PARAMS.W_PROJ * s.projPct
           + TODFS_NBA_PARAMS.W_LEV * (1 - s.ownPct)
           + TODFS_NBA_PARAMS.W_VAR * s.rangePct * 0.8;
    if (s.ppdPct >= 1 - TODFS_NBA_PARAMS.PPD_LINEUP_TOP_PCT) ev *= (1 - TODFS_NBA_PARAMS.PPD_LINEUP_PENALTY);
    s.ev = ev;
  }
  // No stack filter on NBA per framework.
  const pool = scored;
  const sortedHigh = [...pool].sort((a, b) => (b.projPct + b.ownPct) - (a.projPct + a.ownPct));
  const sortedLow = [...pool].sort((a, b) => ((1 - b.projPct) + (1 - b.ownPct)) - ((1 - a.projPct) + (1 - a.ownPct)));
  const HIGH_TARGET = Math.round(N * TODFS_NBA_PARAMS.BAND_HIGH_PCT);
  const LOW_TARGET = Math.round(N * TODFS_NBA_PARAMS.BAND_LOW_PCT);
  const MID_TARGET = N - HIGH_TARGET - LOW_TARGET;
  const selected: typeof scored = [];
  const exposure = new Map<string, number>();
  const seen = new Set<string>();
  function passes(s: typeof scored[0]): boolean {
    if (seen.has(s.lu.hash)) return false;
    for (const p of s.lu.players) {
      const cur = exposure.get(p.id) || 0;
      if ((cur + 1) / N > TODFS_NBA_PARAMS.EXPOSURE_CAP_HITTER) return false;
    }
    const ids = new Set(s.lu.players.map(p => p.id));
    for (const sel of selected) {
      let ov = 0; for (const p of sel.lu.players) if (ids.has(p.id)) ov++;
      if (ov > TODFS_NBA_PARAMS.MAX_PAIRWISE_OVERLAP) return false;
    }
    return true;
  }
  function add(s: typeof scored[0]) {
    selected.push(s); seen.add(s.lu.hash);
    for (const p of s.lu.players) exposure.set(p.id, (exposure.get(p.id) || 0) + 1);
  }
  function fillBand(bandPool: typeof scored, target: number) {
    const sorted = [...bandPool].sort((a, b) => b.ev - a.ev);
    let added = 0;
    for (const s of sorted) { if (added >= target) break; if (passes(s)) { add(s); added++; } }
  }
  fillBand(sortedHigh.slice(0, Math.max(HIGH_TARGET * 5, 200)), HIGH_TARGET);
  fillBand(pool, MID_TARGET);
  fillBand(sortedLow.slice(0, Math.max(LOW_TARGET * 5, 200)), LOW_TARGET);
  if (selected.length < N) {
    const sorted = [...pool].sort((a, b) => b.ev - a.ev);
    for (const s of sorted) { if (selected.length >= N) break; if (passes(s)) add(s); }
  }
  return selected.slice(0, N).map(s => s.lu);
}

// Hermes-A portfolio for MLB.
function buildHermesAPortfolio(sd: SlateData): Lineup[] {
  const comboFreq = precomputeComboFrequencies(sd.candidates, HERMES_A.comboPower);
  const result = productionSelect(sd.candidates, sd.players, {
    N, lambda: HERMES_A.lambda, comboFreq, maxOverlap: HERMES_A.gamma,
    teamCapPct: HERMES_A.teamCapPct, minPrimaryStack: HERMES_A.minPrimaryStack,
    maxExposure: HERMES_A.maxExposure, maxExposurePitcher: HERMES_A.maxExposurePitcher,
    extremeCornerCap: HERMES_A.extremeCornerCap, binAllocation: HERMES_A.binAllocation,
  });
  return result.portfolio;
}

// Random baseline: uniform sample from pool (no replacement when possible).
function buildRandomPortfolio(sd: SlateData, seed: number = 42): Lineup[] {
  let s = seed;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xFFFFFFFF; };
  const pool = sd.candidates;
  const seen = new Set<string>();
  const picked: Lineup[] = [];
  for (let attempt = 0; attempt < N * 20 && picked.length < N; attempt++) {
    const idx = Math.floor(rand() * pool.length);
    const lu = pool[idx];
    if (seen.has(lu.hash)) continue;
    seen.add(lu.hash);
    picked.push(lu);
  }
  while (picked.length < N) picked.push(pool[Math.floor(rand() * pool.length)]);
  return picked;
}

// ============================================================
// SCORING + STRUCTURAL DATA EXTRACTION
// ============================================================

interface LineupRecord {
  hash: string;
  proj: number;
  ownership: number;
  salary: number;
  playerIds: string[];
  primaryStackSize: number;     // for MLB
  primaryGameSize: number;       // for NBA
  // Slate-relative percentiles (computed against slate's pool).
  projPct: number;
  ownPct: number;
  finishPctile: number | null;   // computed from actuals
  payout: number;
}

interface SystemRunResult {
  system: string;
  sport: 'mlb' | 'nba';
  slate: string;
  numTeams: number;
  numGames: number;
  poolSize: number;
  optimalProj: number;
  chalkAnchorOwn: number;
  // 5-metric Mahalanobis components (MLB pros only).
  metrics: { projRatioToOptimal: number; ceilingRatioToOptimal: number; avgPlayerOwnPctile: number; ownStdRatio: number; ownDeltaFromAnchor: number };
  mahal: number | null;
  // Aggregate
  totalPayout: number;
  t1: number;
  t01: number;
  // Per-lineup detail
  lineups: LineupRecord[];
}

function buildPayoutTable(F: number): Float64Array {
  const pool = F * FEE * 0.88;
  const cashLine = Math.floor(F * 0.22);
  const raw = new Float64Array(cashLine);
  let rawSum = 0;
  for (let r = 0; r < cashLine; r++) { raw[r] = Math.pow(r + 1, -1.15); rawSum += raw[r]; }
  const table = new Float64Array(F);
  const minCash = FEE * 1.2;
  for (let r = 0; r < cashLine; r++) table[r] = Math.max(minCash, (raw[r] / rawSum) * pool);
  let tSum = 0;
  for (let r = 0; r < cashLine; r++) tSum += table[r];
  const scale = pool / tSum;
  for (let r = 0; r < cashLine; r++) table[r] *= scale;
  return table;
}

function evaluatePortfolio(portfolio: Lineup[], sd: SlateData, systemName: string): SystemRunResult {
  const F = sd.actuals.entries.length;
  const sortedActuals = sd.actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
  const top1T = sortedActuals[Math.max(0, Math.floor(F * 0.01) - 1)] || 0;
  const top01T = sortedActuals[Math.max(0, Math.floor(F * 0.001) - 1)] || 0;
  const payoutTable = buildPayoutTable(Math.max(F, 100));

  // Slate-relative pool percentiles for this slate's pool.
  const projVals = sd.candidates.map(lu => lu.projection);
  const ownVals = sd.candidates.map(lu => lu.ownership);
  const projSorted = [...projVals].sort((a, b) => a - b);
  const ownSorted = [...ownVals].sort((a, b) => a - b);
  function pctile(sorted: number[], v: number): number {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid; }
    return sorted.length > 1 ? lo / (sorted.length - 1) : 0;
  }

  // Per-lineup records.
  const lineups: LineupRecord[] = [];
  let totalPayout = 0, t1 = 0, t01 = 0;
  for (const lu of portfolio) {
    let actual = 0, miss = false;
    for (const p of lu.players) {
      const r = sd.actuals.playerActualsByName.get(norm(p.name));
      if (!r) { miss = true; break; }
      actual += r.fpts;
    }
    let finishPctile: number | null = null;
    let payout = 0;
    if (!miss) {
      let lo = 0, hi = sortedActuals.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (sortedActuals[mid] >= actual) lo = mid + 1; else hi = mid; }
      const rank = Math.max(1, lo);
      finishPctile = F > 1 ? 1 - (rank - 1) / (F - 1) : 0.5;
      if (actual >= top1T) t1++;
      if (actual >= top01T) t01++;
      const pay = rank <= payoutTable.length ? payoutTable[rank - 1] : 0;
      if (pay > 0) {
        let cw = 0;
        for (const e of sd.actuals.entries) if (Math.abs(e.actualPoints - actual) <= 0.25) cw++;
        cw = Math.max(0, cw - 1);
        payout = pay / Math.sqrt(1 + cw * 0.5);
        totalPayout += payout;
      }
    }
    // Stack size for MLB / game size for NBA.
    let primaryStackSize = 0, primaryGameSize = 0;
    if (sd.sport === 'mlb') {
      const teamHitters = new Map<string, number>();
      for (const p of lu.players) {
        const pos = (p.position || '').toUpperCase();
        if (pos.includes('P')) continue;
        const t = (p.team || '').toUpperCase();
        if (t) teamHitters.set(t, (teamHitters.get(t) || 0) + 1);
      }
      for (const [, c] of teamHitters) if (c > primaryStackSize) primaryStackSize = c;
    } else {
      const gameCounts = new Map<string, number>();
      for (const p of lu.players) {
        const t = (p.team || '').toUpperCase(), o = (p.opponent || '').toUpperCase();
        if (t && o) { const g = [t, o].sort().join('@'); gameCounts.set(g, (gameCounts.get(g) || 0) + 1); }
      }
      for (const [, c] of gameCounts) if (c > primaryGameSize) primaryGameSize = c;
    }
    lineups.push({
      hash: lu.hash,
      proj: lu.projection,
      ownership: lu.ownership,
      salary: lu.salary,
      playerIds: lu.players.map(p => p.id),
      primaryStackSize, primaryGameSize,
      projPct: pctile(projSorted, lu.projection),
      ownPct: pctile(ownSorted, lu.ownership),
      finishPctile,
      payout,
    });
  }

  // 5-metric Mahalanobis.
  const luProjs: number[] = [], luCeils: number[] = [], luOwns: number[] = [], luOwnStds: number[] = [], pctileSums: number[] = [];
  for (const lu of portfolio) {
    const owns = lu.players.map(p => p.ownership || 0);
    luOwns.push(mean(owns));
    luProjs.push(lu.projection);
    luCeils.push(lu.players.reduce((s, p) => s + ((p as any).ceiling || (p.projection || 0) * 1.4), 0));
    const m = mean(owns);
    const variance = owns.reduce((s, v) => s + (v - m) ** 2, 0) / owns.length;
    luOwnStds.push(Math.sqrt(variance));
    let pSum = 0;
    for (const p of lu.players) pSum += sd.slatePlayerOwnPctile.get(p.id) || 0;
    pctileSums.push(pSum / lu.players.length);
  }
  let optCeil = 0;
  for (const lu of sd.candidates) {
    const c = lu.players.reduce((s, p) => s + ((p as any).ceiling || (p.projection || 0) * 1.4), 0);
    if (c > optCeil) optCeil = c;
  }
  const slateAvgOwn = mean(sd.players.map(p => p.ownership || 0));
  const metrics = {
    projRatioToOptimal: sd.optimalProj > 0 ? mean(luProjs) / sd.optimalProj : 0,
    ceilingRatioToOptimal: optCeil > 0 ? mean(luCeils) / optCeil : 0,
    avgPlayerOwnPctile: mean(pctileSums),
    ownStdRatio: slateAvgOwn > 0 ? mean(luOwnStds) / slateAvgOwn : 0,
    ownDeltaFromAnchor: mean(luOwns) - sd.chalkAnchorOwn,
  };

  // Mahalanobis (MLB only).
  let mahal: number | null = null;
  if (sd.consensusStats) {
    let sum = 0, n = 0;
    for (const k of Object.keys(metrics) as (keyof typeof metrics)[]) {
      const c = sd.consensusStats[k];
      if (!c || c.std < 1e-9) continue;
      const d = (metrics[k] - c.mean) / c.std;
      sum += d * d; n++;
    }
    if (n > 0) mahal = Math.sqrt(sum / n);
  }

  return {
    system: systemName, sport: sd.sport, slate: sd.slate,
    numTeams: sd.numTeams, numGames: sd.numGames, poolSize: sd.candidates.length,
    optimalProj: sd.optimalProj, chalkAnchorOwn: sd.chalkAnchorOwn,
    metrics, mahal, totalPayout, t1, t01, lineups,
  };
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log('================================================================');
  console.log('STRUCTURAL VALIDATION — 6 framework checks across all systems');
  console.log('================================================================\n');

  // Pro consensus (MLB).
  const consensusRaw = JSON.parse(fs.readFileSync(path.join(MLB_DIR, 'pro_consensus_slate_relative.json'), 'utf-8'));
  const cons: Record<string, Record<string, { mean: number; std: number }>> = {};
  for (const k of ['projRatioToOptimal', 'ceilingRatioToOptimal', 'avgPlayerOwnPctile', 'ownStdRatio', 'ownDeltaFromAnchor']) {
    for (const e of (consensusRaw.metrics[k] || [])) {
      if (!cons[e.slate]) cons[e.slate] = {};
      cons[e.slate][k] = { mean: e.mean, std: e.std };
    }
  }

  console.log('Loading slates...');
  const mlbSlates: SlateData[] = [];
  for (const s of MLB_SLATES) {
    const sd = await loadMlbSlate(s, cons);
    if (sd) mlbSlates.push(sd);
  }
  const nbaSlates: SlateData[] = [];
  for (const s of NBA_SLATES) {
    const sd = await loadNbaSlate(s);
    if (sd) nbaSlates.push(sd);
  }
  console.log(`  MLB: ${mlbSlates.length} slates, NBA: ${nbaSlates.length} slates`);

  console.log('\nRunning systems...');
  const results: SystemRunResult[] = [];

  // MLB systems.
  console.log('  MLB Hermes-A...');
  for (const sd of mlbSlates) results.push(evaluatePortfolio(buildHermesAPortfolio(sd), sd, 'hermes-a'));
  console.log('  MLB Theory-DFS...');
  for (const sd of mlbSlates) results.push(evaluatePortfolio(buildTheoryMlbPortfolio(sd), sd, 'theory-dfs-mlb'));
  console.log('  MLB Theory-DFS + Hermes-A combo...');
  for (const sd of mlbSlates) results.push(evaluatePortfolio(buildTheoryMlbHermesComboPortfolio(sd), sd, 'theory-dfs-mlb-hcombo'));
  console.log('  MLB Random...');
  for (const sd of mlbSlates) results.push(evaluatePortfolio(buildRandomPortfolio(sd), sd, 'random-mlb'));

  // NBA systems.
  console.log('  NBA Theory-DFS...');
  for (const sd of nbaSlates) results.push(evaluatePortfolio(buildTheoryNbaPortfolio(sd), sd, 'theory-dfs-nba'));
  console.log('  NBA Random...');
  for (const sd of nbaSlates) results.push(evaluatePortfolio(buildRandomPortfolio(sd), sd, 'random-nba'));

  // Save results.
  const outPath = path.join(OUT_DIR, 'all_systems_lineups.json');
  // Strip lineups to keep file size manageable but keep structural fields.
  const slim = results.map(r => ({
    system: r.system, sport: r.sport, slate: r.slate,
    numTeams: r.numTeams, numGames: r.numGames, poolSize: r.poolSize,
    optimalProj: r.optimalProj, chalkAnchorOwn: r.chalkAnchorOwn,
    metrics: r.metrics, mahal: r.mahal, totalPayout: r.totalPayout, t1: r.t1, t01: r.t01,
    lineups: r.lineups.map(lu => ({
      proj: lu.proj, own: lu.ownership, salary: lu.salary,
      pri: lu.primaryStackSize || lu.primaryGameSize,
      pp: lu.projPct, op: lu.ownPct,
      fp: lu.finishPctile, pay: lu.payout,
      pids: lu.playerIds,
    })),
  }));
  fs.writeFileSync(outPath, JSON.stringify(slim, null, 0));
  console.log(`\nSaved ${results.length} system-slate combinations to ${outPath}`);
  console.log(`  File size: ${(fs.statSync(outPath).size / 1024 / 1024).toFixed(1)} MB`);
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });
