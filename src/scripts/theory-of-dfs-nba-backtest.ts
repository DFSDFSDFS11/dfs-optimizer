/**
 * Theory-of-DFS NBA Backtest — cross-sport validation.
 *
 * Same framework principles as theory-of-dfs-backtest.ts (MLB), but with NBA-specific
 * implementations per the framework Ch.7 archetype guidance. Sport-specific parameters
 * are derived from the framework, NOT tuned to NBA backtest data.
 *
 * Cross-sport-equal parameters (same as MLB): EV weights (W_LEV, W_RV, W_CMB, W_VAR,
 * W_CEIL_EFF), 20/60/20 variance bands, exploitative_exponent, triple_freq_cap.
 *
 * Sport-specific parameters (NBA-derived from framework):
 *   - Correlation magnitudes (NBA "much weaker" per Ch.7 → ~1/3 of MLB)
 *   - No hard min_primary_stack (NBA stacking is soft per Ch.7)
 *   - Variance multipliers (NBA more normal than MLB bimodal)
 *   - Pairwise overlap cap 5 (vs MLB 6, scaled to roster 8 vs 10)
 *   - Exposure cap 0.40 (vs MLB 0.50, NBA star concentration typical)
 *
 * Comparison: random baseline (150 uniform samples from SaberSim pool) — no NBA Hermes-A
 * equivalent and no NBA pro consensus data available.
 *
 * Critical: do NOT tune NBA parameters to NBA performance. The discipline of using
 * framework-derived parameters is what makes this cross-sport test meaningful.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player, ContestConfig } from '../types';
import {
  parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals,
} from '../parser';
import { getContestConfig } from '../rules';

// ============================================================
// CONSTANTS
// ============================================================

const HISTORICAL_DIR = 'C:/Users/colin/Projects/dfs-optimizer/historical_slates';
const OUT_DIR = 'C:/Users/colin/dfs opto/theory_dfs_nba';
const FEE = 20;
const N = 150;
const ROSTER_SIZE = 8;  // NBA DK Classic

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// 12 NBA slates with full proj+actuals+pool data.
const SLATES = [
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

// ============================================================
// THEORY-OF-DFS NBA PARAMS
// ============================================================
// Cross-sport-equal weights are taken DIRECTLY from MLB Theory-DFS (no re-tuning).
// Sport-specific parameters are framework-derived (Ch.7 NBA archetype guidance).
const TODFS_NBA = {
  // ── EV WEIGHTS (cross-sport, identical to MLB) ──
  W_PROJ: 1.0,
  W_LEV: 0.30,
  W_RV: 0.20,
  W_CMB: 0.25,
  W_VAR: 0.15,
  W_CEIL_EFF: 0.10,

  // ── Stage 1B Correlation (Ch.7 NBA archetype: "much weaker than MLB", roughly 1/3) ──
  GAME_STACK_BONUS: 0.05,            // 3+ players from one game (game-stack analog of MLB team-stack)
  OPPOSING_TEAM_BONUS: 0.03,          // 3-2 cross-game-stack bonus
  TEAM_NEGATIVE_PER_EXTRA: -0.04,    // each teammate beyond 2 (opportunity cannibalization, Ch.7)
  // Note: MLB used STACK_BONUS_PER_HITTER=0.10. NBA framework says "weak correlation" → 0.03-0.05 range.

  // ── Stage 1C Stacking (NO HARD CONSTRAINT — framework says NBA stacking is soft) ──
  // Critical difference vs MLB: no MIN_PRIMARY_STACK filter. NBA framework does not require
  // structural stacking. Soft bonus via score1B_correlation only.

  // ── Stage 1D Relative Value (cross-sport) ──
  OWNERSHIP_EFFICIENCY_EXPONENT: 0.5,
  DIRECT_LEVERAGE_BONUS: 0.03,

  // ── Stage 1E Combinatorial (cross-sport) ──
  PAIR_CORR_SAME_TEAM: 1.5,
  PAIR_CORR_OPPOSING: 0.7,
  PAIR_CORR_UNRELATED: 1.0,
  TRIPLES_EVALUATED: 3,

  // ── Stage 1F Archetype (NBA Ch.7) ──
  // Per Ch.7: NBA more normal distribution → less variance multiplier than MLB hitters (1.3).
  HITTER_VARIANCE_MULT: 1.0,         // NBA all positions ≈ normal; no bimodal correction
  PITCHER_VARIANCE_MULT: 1.0,        // unused in NBA
  // Per spec: pool size adjustment for projection floor (5%/8%/12%).
  PROJ_FLOOR_SMALL: 0.05,            // ≤4 games
  PROJ_FLOOR_MEDIUM: 0.08,            // 5-9 games
  PROJ_FLOOR_LARGE: 0.12,             // 10+ games

  // ── Stage 2 EV (variance band split — IDENTICAL to MLB for cross-sport test) ──
  BAND_HIGH_PCT: 0.20,
  BAND_MID_PCT: 0.60,
  BAND_LOW_PCT: 0.20,

  // ── Stage 3A Frequency optimization (cross-sport) ──
  EXPLOITATIVE_EXPONENT: 1.5,
  // NBA exposure caps lower than MLB per spec (NBA star concentration).
  EXPOSURE_CAP_HITTER: 0.40,         // vs MLB 0.50
  EXPOSURE_CAP_PITCHER: 0.40,         // unused in NBA but kept for compat

  // ── Stage 3C Diversification (NBA-scaled overlap cap) ──
  // NBA roster=8 (MLB=10). Overlap cap 5 of 8 ≈ 6 of 10 (matches MLB ratio).
  MAX_PAIRWISE_OVERLAP: 5,
  TRIPLE_FREQ_CAP: 5,

  // ── Ch.9 Exploits (cross-sport, identical magnitudes to MLB) ──
  PPD_OWN_BUMP_PP: 3.0,
  PPD_TOP_PCT: 0.10,
  PPD_LINEUP_PENALTY: 0.10,
  PPD_LINEUP_TOP_PCT: 0.10,
  ULTRA_CHALK_PLAYER_THRESHOLD_PCT: 0.75,
  ULTRA_CHALK_LINEUP_MIN_COUNT: 4,    // 4 of 8 (NBA roster) ≈ 5 of 10 (MLB)
  ULTRA_CHALK_PENALTY: 0.05,
  // Skipped: SIM_OPTIMALS bump (NBA pool format doesn't include sim_optimals column),
  //         FRAGILITY bump (no stdDev field in NBA projections),
  //         PPD_STACK_PENALTY (no MLB-style team-stack concept).
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
  const idx = values.map((v, i) => ({ v, i }));
  idx.sort((a, b) => a.v - b.v);
  const out = new Array<number>(values.length);
  const n = values.length;
  for (let r = 0; r < n; r++) out[idx[r].i] = n > 1 ? r / (n - 1) : 0;
  return out;
}

// ============================================================
// PAYOUT MODEL — identical to MLB
// ============================================================

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
  const finishPctiles: number[] = [];

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
    finishPctiles.push(F > 1 ? 1 - (rank - 1) / (F - 1) : 0.5);
    const payout = rank <= payoutTable.length ? payoutTable[rank - 1] : 0;
    if (payout > 0) {
      let coWin = 0;
      for (const e of actuals.entries) if (Math.abs(e.actualPoints - a) <= 0.25) coWin++;
      coWin = Math.max(0, coWin - 1);
      totalPayout += payout / Math.sqrt(1 + coWin * 0.5);
    }
  }
  return { totalPayout, t1, t01, scored, finishPctiles };
}

// ============================================================
// SLATE LOADING (NBA-specific paths)
// ============================================================

interface SlateData {
  slate: string;
  candidates: Lineup[];
  players: Player[];
  actuals: ContestActuals;
  payoutTable: Float64Array;
  config: ContestConfig;
  numGames: number;
}

async function loadSlate(s: typeof SLATES[0]): Promise<SlateData | null> {
  const projPath = path.join(HISTORICAL_DIR, s.proj);
  const actualsPath = path.join(HISTORICAL_DIR, s.actuals);
  const poolPath = path.join(HISTORICAL_DIR, s.pool);
  if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) {
    console.log(`  SKIP ${s.slate}: missing files`);
    return null;
  }
  const pr = parseCSVFile(projPath, 'nba', true);
  const config = getContestConfig('dk', 'nba', pr.detectedContestType);
  const pool = buildPlayerPool(pr.players, pr.detectedContestType);
  const actuals = parseContestActuals(actualsPath, config);
  const idMap = new Map<string, Player>();
  for (const p of pool.players) idMap.set(p.id, p);
  const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });

  // Count games (each player has team + opponent → game = sorted pair).
  const games = new Set<string>();
  for (const p of pool.players) {
    const t = (p.team || '').toUpperCase();
    const o = (p.opponent || '').toUpperCase();
    if (t && o) games.add([t, o].sort().join('@'));
  }

  const F = actuals.entries.length;
  const payoutTable = buildPayoutTable(Math.max(F, 100));

  return {
    slate: s.slate, candidates: loaded.lineups, players: pool.players,
    actuals, payoutTable, config,
    numGames: games.size,
  };
}

// ============================================================
// NBA SCORING FUNCTIONS
// ============================================================

interface ProjectionScore { median: number; floor: number; ceiling: number; range: number; }
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

interface CorrelationScoreNBA {
  primaryGameSize: number;       // largest count of players from a single game
  primaryGame: string;
  primaryTeamSize: number;        // largest count from a single team
  primaryTeam: string;
  bringBackCount: number;         // opposing-team count for 3-2 game stacks
  teamCannibalization: number;    // NBA-specific: extra teammates beyond 2 (negative correlation)
  adjustment: number;
}

// NBA correlation: game-stack focus (3+ from one game = positive correlation), with negative
// correction for "too many" teammates (opportunity cannibalization).
function score1B_correlationNBA(lineup: Lineup): CorrelationScoreNBA {
  const gameCounts = new Map<string, number>();
  const teamCounts = new Map<string, number>();
  for (const p of lineup.players) {
    const team = (p.team || '').toUpperCase();
    const opp = (p.opponent || '').toUpperCase();
    if (team) teamCounts.set(team, (teamCounts.get(team) || 0) + 1);
    if (team && opp) {
      const g = [team, opp].sort().join('@');
      gameCounts.set(g, (gameCounts.get(g) || 0) + 1);
    }
  }
  let primaryGame = '', primaryGameSize = 0;
  for (const [g, c] of gameCounts) if (c > primaryGameSize) { primaryGameSize = c; primaryGame = g; }
  let primaryTeam = '', primaryTeamSize = 0;
  for (const [t, c] of teamCounts) if (c > primaryTeamSize) { primaryTeamSize = c; primaryTeam = t; }

  // Bring-back: in primary game, count split (e.g., 3-2 = bring-back of 2).
  const teamsInPrimaryGame = primaryGame ? primaryGame.split('@') : [];
  let bringBack = 0;
  if (teamsInPrimaryGame.length === 2) {
    const a = teamCounts.get(teamsInPrimaryGame[0]) || 0;
    const b = teamCounts.get(teamsInPrimaryGame[1]) || 0;
    if (a > 0 && b > 0) bringBack = Math.min(a, b);
  }

  // Team cannibalization: if a team has ≥3 players, each extra beyond 2 incurs -0.04 (Ch.7 NBA negative correlation).
  let cannibalization = 0;
  for (const [, c] of teamCounts) {
    if (c >= 3) cannibalization += (c - 2);
  }

  let adj = 0;
  // Game-stack bonus: 0.05 if primary game has 3+ players.
  if (primaryGameSize >= 3) adj += TODFS_NBA.GAME_STACK_BONUS;
  // Opposing-team bonus: 0.03 if 3-2 split (or richer) in primary game.
  if (primaryGameSize >= 3 && bringBack >= 2) adj += TODFS_NBA.OPPOSING_TEAM_BONUS;
  // Cannibalization penalty.
  adj += TODFS_NBA.TEAM_NEGATIVE_PER_EXTRA * cannibalization;

  return {
    primaryGameSize, primaryGame, primaryTeamSize, primaryTeam,
    bringBackCount: bringBack, teamCannibalization: cannibalization, adjustment: adj,
  };
}

function lineupLogOwnProduct(lineup: Lineup, ownAdj?: Map<string, number>): number {
  let s = 0;
  for (const p of lineup.players) {
    const adj = ownAdj?.get(p.id);
    const own = adj !== undefined ? adj : (p.ownership || 0.5);
    s += Math.log(Math.max(0.1, own));
  }
  return s;
}

function score1D_relativeValue(lineup: Lineup, players: Player[]): number {
  const byPosTier = new Map<string, { sum: number; count: number }>();
  for (const p of players) {
    if (!p.salary || !p.projection) continue;
    const pos = (p.position || '').split('/')[0].toUpperCase();
    const tier = `${pos}_${Math.floor(p.salary / 1000)}`;
    const cur = byPosTier.get(tier) || { sum: 0, count: 0 };
    cur.sum += p.projection; cur.count++;
    byPosTier.set(tier, cur);
  }
  let salaryEff = 0, ownEff = 0;
  for (const p of lineup.players) {
    const pos = (p.position || '').split('/')[0].toUpperCase();
    const tier = `${pos}_${Math.floor((p.salary || 0) / 1000)}`;
    const grp = byPosTier.get(tier);
    const tierAvg = grp && grp.count > 0 ? grp.sum / grp.count : (p.projection || 0);
    salaryEff += ((p.projection || 0) - tierAvg) / Math.max(1, (p.salary || 1000) / 1000);
    const proj = p.projection || 0.1;
    const own = p.ownership || 0.5;
    ownEff += Math.log(proj / Math.pow(Math.max(0.1, own), TODFS_NBA.OWNERSHIP_EFFICIENCY_EXPONENT));
  }
  return salaryEff * 0.4 + ownEff * 0.5;
}

interface PairFreqMap { pairToFreq: Map<string, number>; tripleToFreq: Map<string, number>; }
function buildPairTripleFreqs(candidates: Lineup[]): PairFreqMap {
  const pairToFreq = new Map<string, number>();
  const tripleToFreq = new Map<string, number>();
  let totalWeight = 0;
  for (const lu of candidates) {
    const w = Math.max(0.1, lu.projection || 1) ** 2;
    totalWeight += w;
    const ids = lu.players.map(p => p.id).sort();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const k = ids[i] + '|' + ids[j];
        pairToFreq.set(k, (pairToFreq.get(k) || 0) + w);
      }
    }
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        for (let l = j + 1; l < ids.length; l++) {
          const k = ids[i] + '|' + ids[j] + '|' + ids[l];
          tripleToFreq.set(k, (tripleToFreq.get(k) || 0) + w);
        }
      }
    }
  }
  for (const k of pairToFreq.keys()) pairToFreq.set(k, pairToFreq.get(k)! / totalWeight);
  for (const k of tripleToFreq.keys()) tripleToFreq.set(k, tripleToFreq.get(k)! / totalWeight);
  return { pairToFreq, tripleToFreq };
}

function score1E_combinatorial(lineup: Lineup, freqs: PairFreqMap): { uniquenessScore: number; topTriples: string[] } {
  const ids = lineup.players.map(p => p.id).sort();
  const teamMap = new Map<string, string>();
  for (const p of lineup.players) teamMap.set(p.id, (p.team || '').toUpperCase());
  let logPairSum = 0;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const k = ids[i] + '|' + ids[j];
      const f = freqs.pairToFreq.get(k) || 1e-6;
      const ti = teamMap.get(ids[i]); const tj = teamMap.get(ids[j]);
      let factor = TODFS_NBA.PAIR_CORR_UNRELATED;
      if (ti && tj && ti === tj) factor = TODFS_NBA.PAIR_CORR_SAME_TEAM;
      logPairSum += Math.log(f * factor);
    }
  }
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
  const top = tripleFs.slice(0, TODFS_NBA.TRIPLES_EVALUATED);
  const logTripleSum = top.reduce((s, t) => s + Math.log(t.f), 0);
  return { uniquenessScore: -(logPairSum + logTripleSum), topTriples: top.map(t => t.key) };
}

interface ArchetypeParams { varianceTarget: number; projectionFloor: number; notes: string; }
function score1F_archetype(slateData: SlateData): ArchetypeParams {
  // NBA archetype: pool size from numGames; variance target stays 0.8 (NBA more normal so less variance push needed).
  const games = slateData.numGames;
  let varianceTarget = 0.8;
  let projectionFloor = TODFS_NBA.PROJ_FLOOR_MEDIUM;
  let notes = `numGames=${games}`;
  if (games <= 4) {
    varianceTarget = 0.7;
    projectionFloor = TODFS_NBA.PROJ_FLOOR_SMALL;
    notes += ', small slate';
  } else if (games >= 10) {
    varianceTarget = 0.9;
    projectionFloor = TODFS_NBA.PROJ_FLOOR_LARGE;
    notes += ', large slate';
  } else {
    notes += ', medium slate';
  }
  return { varianceTarget, projectionFloor, notes };
}

function applyPpdOwnBump(slateData: SlateData, ownAdj: Map<string, number>): void {
  const ppds: { id: string; ppd: number }[] = [];
  for (const p of slateData.players) {
    if (!p.salary || !p.projection) continue;
    ppds.push({ id: p.id, ppd: p.projection / (p.salary / 1000) });
  }
  if (ppds.length === 0) return;
  ppds.sort((a, b) => b.ppd - a.ppd);
  const topCount = Math.max(1, Math.floor(ppds.length * TODFS_NBA.PPD_TOP_PCT));
  const topIds = new Set(ppds.slice(0, topCount).map(x => x.id));
  for (const id of topIds) {
    const cur = ownAdj.get(id);
    const baseOwn = cur ?? (slateData.players.find(p => p.id === id)?.ownership || 0.5);
    ownAdj.set(id, baseOwn + TODFS_NBA.PPD_OWN_BUMP_PP);
  }
}

function lineupPpdScore(lineup: Lineup): number {
  let s = 0;
  for (const p of lineup.players) {
    if (!p.salary || !p.projection) continue;
    s += p.projection / (p.salary / 1000);
  }
  return s;
}

function buildUltraChalkSet(slateData: SlateData): Set<string> {
  const owns = slateData.players.map(p => ({ id: p.id, own: p.ownership || 0 }));
  if (owns.length === 0) return new Set();
  owns.sort((a, b) => b.own - a.own);
  const cutoff = Math.max(1, Math.floor(owns.length * (1 - TODFS_NBA.ULTRA_CHALK_PLAYER_THRESHOLD_PCT)));
  return new Set(owns.slice(0, cutoff).map(x => x.id));
}

function ultraChalkCount(lineup: Lineup, ultraChalkIds: Set<string>): number {
  let n = 0;
  for (const p of lineup.players) if (ultraChalkIds.has(p.id)) n++;
  return n;
}

// ============================================================
// SCORED LU + EV
// ============================================================

interface ScoredLU {
  lu: Lineup;
  proj: ProjectionScore;
  corr: CorrelationScoreNBA;
  logOwnProd: number;
  rv: number;
  combo: { uniquenessScore: number; topTriples: string[] };
  ppd: number;
  ceilEff: number;
  ultraChalkN: number;
  proj_pct: number;
  corr_adjusted_pct: number;
  own_pct: number;
  rv_pct: number;
  combo_pct: number;
  range_pct: number;
  ppd_pct: number;
  ceil_eff_pct: number;
  ev: number;
}

function combineEV(scored: ScoredLU[], archetype: ArchetypeParams): void {
  const corrAdjusted = scored.map(s => s.proj.median * (1 + s.corr.adjustment));
  const ownVals = scored.map(s => s.logOwnProd);
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
  const w = TODFS_NBA;
  const ppdPenaltyThreshold = 1 - w.PPD_LINEUP_TOP_PCT;
  // NBA: hitter_var = 1.0, no bimodal correction (vs MLB which had 1.3).
  const hitterVarianceFactor = w.HITTER_VARIANCE_MULT;
  for (const s of scored) {
    let ev = w.W_PROJ * s.corr_adjusted_pct
           + w.W_LEV  * (1 - s.own_pct)
           + w.W_RV   * s.rv_pct
           + w.W_CMB  * s.combo_pct
           + w.W_VAR  * s.range_pct * archetype.varianceTarget * hitterVarianceFactor
           + w.W_CEIL_EFF * s.ceil_eff_pct;
    if (s.ppd_pct >= ppdPenaltyThreshold) ev *= (1 - w.PPD_LINEUP_PENALTY);
    if (s.ultraChalkN >= w.ULTRA_CHALK_LINEUP_MIN_COUNT) ev *= (1 - w.ULTRA_CHALK_PENALTY);
    s.ev = ev;
  }
}

// ============================================================
// PORTFOLIO BUILDER (NBA — no min_primary_stack constraint)
// ============================================================

function buildTheoryPortfolioNBA(slateData: SlateData): Lineup[] {
  const archetype = score1F_archetype(slateData);
  const freqs = buildPairTripleFreqs(slateData.candidates);
  const ownAdj = new Map<string, number>();
  for (const p of slateData.players) ownAdj.set(p.id, p.ownership || 0.5);
  applyPpdOwnBump(slateData, ownAdj);
  const ultraChalkIds = buildUltraChalkSet(slateData);

  const scored: ScoredLU[] = slateData.candidates.map(lu => {
    const proj = score1A_projection(lu);
    const corr = score1B_correlationNBA(lu);
    const logOwnProd = lineupLogOwnProduct(lu, ownAdj);
    const rv = score1D_relativeValue(lu, slateData.players);
    const combo = score1E_combinatorial(lu, freqs);
    const ppd = lineupPpdScore(lu);
    const ceilEff = proj.median > 0 ? proj.ceiling / proj.median : 0;
    const uChalk = ultraChalkCount(lu, ultraChalkIds);
    return {
      lu, proj, corr, logOwnProd, rv, combo, ppd, ceilEff, ultraChalkN: uChalk,
      proj_pct: 0, corr_adjusted_pct: 0, own_pct: 0, rv_pct: 0, combo_pct: 0, range_pct: 0,
      ppd_pct: 0, ceil_eff_pct: 0, ev: 0,
    };
  });
  combineEV(scored, archetype);

  // Apply projection floor (no stack filter — NBA framework does NOT mandate stacking).
  let pool = scored.filter(s => s.proj_pct >= archetype.projectionFloor);
  if (pool.length < N) pool = scored;

  // Variance bands (same as MLB).
  const ranked = pool.map(s => ({
    s,
    bandHighScore: s.proj_pct + s.own_pct,
    bandLowScore: (1 - s.proj_pct) + (1 - s.own_pct),
  }));
  const sortedByHigh = [...ranked].sort((a, b) => b.bandHighScore - a.bandHighScore);
  const sortedByLow = [...ranked].sort((a, b) => b.bandLowScore - a.bandLowScore);
  const HIGH_TARGET = Math.round(N * TODFS_NBA.BAND_HIGH_PCT);
  const LOW_TARGET = Math.round(N * TODFS_NBA.BAND_LOW_PCT);
  const MID_TARGET = N - HIGH_TARGET - LOW_TARGET;
  const HIGH_CAND = sortedByHigh.slice(0, Math.max(HIGH_TARGET * 5, 200)).map(x => x.s);
  const LOW_CAND = sortedByLow.slice(0, Math.max(LOW_TARGET * 5, 200)).map(x => x.s);
  const MID_CAND = pool;

  const selected: ScoredLU[] = [];
  const exposureByPlayer = new Map<string, number>();
  const seenHashes = new Set<string>();
  const tripleSeen = new Map<string, number>();

  function passesConstraints(s: ScoredLU): boolean {
    if (seenHashes.has(s.lu.hash)) return false;
    for (const p of s.lu.players) {
      const cur = exposureByPlayer.get(p.id) || 0;
      if ((cur + 1) / N > TODFS_NBA.EXPOSURE_CAP_HITTER) return false;
    }
    const ids = new Set(s.lu.players.map(p => p.id));
    for (const sel of selected) {
      let overlap = 0;
      for (const p of sel.lu.players) if (ids.has(p.id)) overlap++;
      if (overlap > TODFS_NBA.MAX_PAIRWISE_OVERLAP) return false;
    }
    for (const k of s.combo.topTriples) {
      if ((tripleSeen.get(k) || 0) >= TODFS_NBA.TRIPLE_FREQ_CAP) return false;
    }
    return true;
  }
  function addLineup(s: ScoredLU): void {
    selected.push(s); seenHashes.add(s.lu.hash);
    for (const p of s.lu.players) exposureByPlayer.set(p.id, (exposureByPlayer.get(p.id) || 0) + 1);
    for (const k of s.combo.topTriples) tripleSeen.set(k, (tripleSeen.get(k) || 0) + 1);
  }
  function selectFromBand(bandPool: ScoredLU[], target: number): number {
    const sorted = [...bandPool].sort((a, b) => b.ev - a.ev);
    let added = 0;
    for (const s of sorted) { if (added >= target) break; if (passesConstraints(s)) { addLineup(s); added++; } }
    if (added < target) {
      const old = TODFS_NBA.MAX_PAIRWISE_OVERLAP;
      (TODFS_NBA as any).MAX_PAIRWISE_OVERLAP = old + 1;
      for (const s of sorted) { if (added >= target) break; if (passesConstraints(s)) { addLineup(s); added++; } }
      (TODFS_NBA as any).MAX_PAIRWISE_OVERLAP = old;
    }
    return added;
  }

  selectFromBand(HIGH_CAND, HIGH_TARGET);
  selectFromBand(MID_CAND, MID_TARGET);
  selectFromBand(LOW_CAND, LOW_TARGET);

  if (selected.length < N) {
    const sorted = [...pool].sort((a, b) => b.ev - a.ev);
    const old = TODFS_NBA.MAX_PAIRWISE_OVERLAP;
    (TODFS_NBA as any).MAX_PAIRWISE_OVERLAP = 7;
    for (const s of sorted) { if (selected.length >= N) break; if (passesConstraints(s)) addLineup(s); }
    (TODFS_NBA as any).MAX_PAIRWISE_OVERLAP = old;
  }
  return selected.map(s => s.lu);
}

// ============================================================
// RANDOM BASELINE (uniform sample from SaberSim pool)
// ============================================================

function buildRandomBaseline(slateData: SlateData, seed: number = 42): Lineup[] {
  // Linear congruential generator for reproducibility.
  let s = seed;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xFFFFFFFF; };
  const candidates = slateData.candidates;
  if (candidates.length === 0) return [];
  // Sample N lineups uniformly with replacement (allow duplicates if pool < N).
  const picked: Lineup[] = [];
  const seen = new Set<string>();
  for (let attempt = 0; attempt < N * 10 && picked.length < N; attempt++) {
    const idx = Math.floor(rand() * candidates.length);
    const lu = candidates[idx];
    if (seen.has(lu.hash)) continue;
    seen.add(lu.hash);
    picked.push(lu);
  }
  // If pool too small to reach N, fill with non-unique.
  while (picked.length < N) {
    const idx = Math.floor(rand() * candidates.length);
    picked.push(candidates[idx]);
  }
  return picked;
}

// ============================================================
// METRICS
// ============================================================

function gameStackRate(portfolio: Lineup[]): number {
  // Fraction of lineups with 3+ players from any single game.
  let n = 0;
  for (const lu of portfolio) {
    const games = new Map<string, number>();
    for (const p of lu.players) {
      const t = (p.team || '').toUpperCase();
      const o = (p.opponent || '').toUpperCase();
      if (t && o) {
        const g = [t, o].sort().join('@');
        games.set(g, (games.get(g) || 0) + 1);
      }
    }
    let max = 0;
    for (const [, c] of games) if (c > max) max = c;
    if (max >= 3) n++;
  }
  return portfolio.length > 0 ? n / portfolio.length : 0;
}

function uniquePlayerCount(portfolio: Lineup[]): number {
  const s = new Set<string>();
  for (const lu of portfolio) for (const p of lu.players) s.add(p.id);
  return s.size;
}

// ============================================================
// MAIN BACKTEST
// ============================================================

interface SlateResult {
  slate: string;
  numGames: number;
  poolSize: number;
  todfs: { payout: number; t1: number; t01: number; gameStack: number; uniquePlayers: number; finishPctiles: number[] };
  random: { payout: number; t1: number; t01: number; gameStack: number; uniquePlayers: number; finishPctiles: number[] };
}

async function runBacktest(): Promise<SlateResult[]> {
  console.log('\n================================================================');
  console.log('THEORY-OF-DFS NBA BACKTEST — cross-sport validation');
  console.log('================================================================\n');
  console.log(`${'Slate'.padEnd(12)} | games | pool |   TODFS-Pay  TODFS-t1 t01 |  Random-Pay Rand-t1 t01`);
  console.log('-'.repeat(95));
  const results: SlateResult[] = [];
  for (const s of SLATES) {
    const sd = await loadSlate(s);
    if (!sd) continue;
    const todfsPort = buildTheoryPortfolioNBA(sd);
    const randPort = buildRandomBaseline(sd, 42);
    const todfsScore = scorePortfolio(todfsPort, sd.actuals, sd.payoutTable);
    const randScore = scorePortfolio(randPort, sd.actuals, sd.payoutTable);
    const result: SlateResult = {
      slate: s.slate, numGames: sd.numGames, poolSize: sd.candidates.length,
      todfs: {
        payout: todfsScore.totalPayout, t1: todfsScore.t1, t01: todfsScore.t01,
        gameStack: gameStackRate(todfsPort), uniquePlayers: uniquePlayerCount(todfsPort),
        finishPctiles: todfsScore.finishPctiles,
      },
      random: {
        payout: randScore.totalPayout, t1: randScore.t1, t01: randScore.t01,
        gameStack: gameStackRate(randPort), uniquePlayers: uniquePlayerCount(randPort),
        finishPctiles: randScore.finishPctiles,
      },
    };
    results.push(result);
    console.log(`${s.slate.padEnd(12)} |   ${String(sd.numGames).padStart(2)}  | ${String(sd.candidates.length).padStart(4)} |  $${todfsScore.totalPayout.toFixed(0).padStart(7)}  ${String(todfsScore.t1).padStart(4)}    ${String(todfsScore.t01).padStart(2)} | $${randScore.totalPayout.toFixed(0).padStart(7)}  ${String(randScore.t1).padStart(4)}   ${String(randScore.t01).padStart(2)}`);
  }
  return results;
}

// ============================================================
// REPORT
// ============================================================

function emitReport(results: SlateResult[]): void {
  console.log('\n================================================================');
  console.log('CROSS-SPORT NBA BACKTEST — COMPARISON REPORT');
  console.log('================================================================\n');
  const totalFees = N * FEE * results.length;
  const todfsTotal = results.reduce((s, r) => s + r.todfs.payout, 0);
  const randTotal = results.reduce((s, r) => s + r.random.payout, 0);
  const todfsT1 = results.reduce((s, r) => s + r.todfs.t1, 0);
  const randT1 = results.reduce((s, r) => s + r.random.t1, 0);
  const todfsT01 = results.reduce((s, r) => s + r.todfs.t01, 0);
  const randT01 = results.reduce((s, r) => s + r.random.t01, 0);
  const expRandT1 = 0.01 * N * results.length;
  const expRandT01 = 0.001 * N * results.length;

  console.log(`Slates run: ${results.length}    Total fees: $${totalFees.toLocaleString()}\n`);
  console.log('METRIC                  | Theory-DFS NBA | Random NBA  | Expected Random');
  console.log('------------------------|----------------|-------------|----------------');
  console.log(`Total payout            | $${todfsTotal.toFixed(0).padStart(8)}      | $${randTotal.toFixed(0).padStart(7)}    |`);
  console.log(`Total ROI               | ${((todfsTotal/totalFees - 1) * 100).toFixed(1).padStart(7)}%       | ${((randTotal/totalFees - 1) * 100).toFixed(1).padStart(6)}%     |`);
  console.log(`Top-1% hits             | ${String(todfsT1).padStart(8)}       | ${String(randT1).padStart(7)}     | ${expRandT1.toFixed(1)}`);
  console.log(`Top-1% × random         | ${(todfsT1 / expRandT1).toFixed(2).padStart(8)}x      | ${(randT1 / expRandT1).toFixed(2).padStart(7)}x    | 1.00x`);
  console.log(`Top-0.1% hits           | ${String(todfsT01).padStart(8)}       | ${String(randT01).padStart(7)}     | ${expRandT01.toFixed(2)}`);
  console.log(`Top-0.1% × random       | ${(todfsT01 / expRandT01).toFixed(2).padStart(8)}x      | ${(randT01 / expRandT01).toFixed(2).padStart(7)}x    | 1.00x`);
  console.log(`Slates with t01 ≥ 1     | ${String(results.filter(r => r.todfs.t01 > 0).length).padStart(8)}/${results.length}     | ${String(results.filter(r => r.random.t01 > 0).length).padStart(7)}/${results.length}    |`);

  // Game-stack rate comparison.
  const todfsGS = mean(results.map(r => r.todfs.gameStack));
  const randGS = mean(results.map(r => r.random.gameStack));
  console.log(`Game-stack rate (3+)    | ${(todfsGS * 100).toFixed(0).padStart(7)}%        | ${(randGS * 100).toFixed(0).padStart(6)}%      |`);

  // Per-slate breakdown.
  console.log('\nPer-slate breakdown:');
  console.log(`${'Slate'.padEnd(12)} | TODFS pay  Rand pay   | TODFS t01  Rand t01  | TODFS t1  Rand t1`);
  for (const r of results) {
    console.log(`${r.slate.padEnd(12)} | $${r.todfs.payout.toFixed(0).padStart(7)}  $${r.random.payout.toFixed(0).padStart(7)}  | ${String(r.todfs.t01).padStart(5)}      ${String(r.random.t01).padStart(5)}     | ${String(r.todfs.t1).padStart(5)}    ${String(r.random.t1).padStart(5)}`);
  }

  // Save JSON.
  const out = {
    params: TODFS_NBA,
    summary: {
      slatesRun: results.length, totalFees,
      todfs: { payout: todfsTotal, roi: todfsTotal / totalFees - 1, t1: todfsT1, t01: todfsT01,
               t01EdgeRatio: todfsT01 / expRandT01, t1EdgeRatio: todfsT1 / expRandT1, slatesWithT01: results.filter(r => r.todfs.t01 > 0).length },
      random: { payout: randTotal, roi: randTotal / totalFees - 1, t1: randT1, t01: randT01,
                t01EdgeRatio: randT01 / expRandT01, t1EdgeRatio: randT1 / expRandT1 },
    },
    perSlate: results.map(r => ({ slate: r.slate, numGames: r.numGames, poolSize: r.poolSize,
      todfs: { payout: r.todfs.payout, t1: r.todfs.t1, t01: r.todfs.t01, gameStack: r.todfs.gameStack, uniquePlayers: r.todfs.uniquePlayers },
      random: { payout: r.random.payout, t1: r.random.t1, t01: r.random.t01, gameStack: r.random.gameStack, uniquePlayers: r.random.uniquePlayers },
    })),
  };
  const outPath = path.join(OUT_DIR, 'nba_results.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nSaved to ${outPath}`);
}

// ============================================================
// STAGE 6 — Cross-sport BAND_HIGH_PCT sensitivity sweep
// ============================================================

async function runBandSweep() {
  console.log('\n================================================================');
  console.log('STAGE 6 — Cross-sport BAND_HIGH_PCT sensitivity (NBA)');
  console.log('================================================================\n');
  const allSlates: SlateData[] = [];
  for (const s of SLATES) {
    const sd = await loadSlate(s);
    if (sd) allSlates.push(sd);
  }
  console.log(`${allSlates.length} NBA slates cached`);

  function runOnce(highPct: number) {
    const orig = TODFS_NBA.BAND_HIGH_PCT;
    const origLow = TODFS_NBA.BAND_LOW_PCT;
    const origMid = TODFS_NBA.BAND_MID_PCT;
    TODFS_NBA.BAND_HIGH_PCT = highPct;
    TODFS_NBA.BAND_LOW_PCT = highPct;
    TODFS_NBA.BAND_MID_PCT = 1 - 2 * highPct;
    let payout = 0, t1 = 0, t01 = 0;
    for (const sd of allSlates) {
      const portfolio = buildTheoryPortfolioNBA(sd);
      const score = scorePortfolio(portfolio, sd.actuals, sd.payoutTable);
      payout += score.totalPayout; t1 += score.t1; t01 += score.t01;
    }
    TODFS_NBA.BAND_HIGH_PCT = orig;
    TODFS_NBA.BAND_LOW_PCT = origLow;
    TODFS_NBA.BAND_MID_PCT = origMid;
    const fees = N * FEE * allSlates.length;
    const expT01 = 0.001 * N * allSlates.length;
    const expT1 = 0.01 * N * allSlates.length;
    return { highPct, payout, roi: payout / fees - 1, t1, t01, t01EdgeRatio: t01 / expT01, t1EdgeRatio: t1 / expT1 };
  }

  const sweeps = [0.16, 0.18, 0.20, 0.22, 0.24];
  console.log(`\nBand split  | ROI       | t1   | t01  | t1×rand | t01×rand`);
  console.log('-'.repeat(65));
  const sweepResults = [];
  for (const h of sweeps) {
    const r = runOnce(h);
    sweepResults.push(r);
    console.log(`${(h*100).toFixed(0)}/${((1-2*h)*100).toFixed(0)}/${(h*100).toFixed(0)}     | ${(100*r.roi).toFixed(1).padStart(7)}%  | ${String(r.t1).padStart(4)} | ${String(r.t01).padStart(4)} | ${r.t1EdgeRatio.toFixed(2).padStart(6)}x | ${r.t01EdgeRatio.toFixed(2).padStart(6)}x`);
  }
  fs.writeFileSync(path.join(OUT_DIR, 'nba_band_sweep.json'), JSON.stringify(sweepResults, null, 2));
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log('================================================================');
  console.log('THEORY-OF-DFS NBA — CROSS-SPORT VALIDATION');
  console.log('================================================================\n');
  console.log('Framework-derived NBA parameters (NOT tuned to NBA backtest):');
  console.log(`  Cross-sport-equal: W_LEV=${TODFS_NBA.W_LEV} W_RV=${TODFS_NBA.W_RV} W_CMB=${TODFS_NBA.W_CMB} W_VAR=${TODFS_NBA.W_VAR} bands=20/60/20`);
  console.log(`  NBA-specific: GAME_STACK=${TODFS_NBA.GAME_STACK_BONUS} OPP=${TODFS_NBA.OPPOSING_TEAM_BONUS} CANNIBAL=${TODFS_NBA.TEAM_NEGATIVE_PER_EXTRA}`);
  console.log(`                no MIN_PRIMARY_STACK constraint (NBA stacking is soft per Ch.7)`);
  console.log(`                hitter_var=${TODFS_NBA.HITTER_VARIANCE_MULT} (NBA more normal vs MLB hitters bimodal 1.3)`);
  console.log(`                exposure_cap=${TODFS_NBA.EXPOSURE_CAP_HITTER} overlap_cap=${TODFS_NBA.MAX_PAIRWISE_OVERLAP}\n`);

  const t0 = Date.now();
  const results = await runBacktest();
  console.log(`\nMain backtest: ${((Date.now() - t0)/1000).toFixed(1)}s`);
  emitReport(results);

  if (process.argv.includes('--sweep')) {
    await runBandSweep();
  }
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });
