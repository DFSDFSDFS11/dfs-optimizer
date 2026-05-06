/**
 * Theory-of-DFS V2 — Empirically-calibrated combinatorial uniqueness module.
 *
 * Two changes vs V1, both derived from the multi-level combo-saturation analysis
 * (combo_saturation_analysis/COMBO_SATURATION_REPORT.md):
 *
 * Change 1 (Type-aware penalty scaling on 1E only):
 *   The combinatorial uniqueness penalty in 1E is scaled by combo type, NOT applied
 *   uniformly. Scaling factor per type = pro_gap[type] / todfs_gap[type] (empirical).
 *   Correlation lever (1B) is NOT touched — bring-back correlation bonus stays intact.
 *
 * Change 2 (Surgical top-5 hard filter):
 *   For each slate, identify the 5 most field-saturated combos at each size (2,3,4,5).
 *   Reject any candidate lineup containing any of those 20 specific combos.
 *   Implements the one place pros DO show strong avoidance (98% rate at quint level).
 *
 * Validation: re-run on same 18 MLB slates as V1. Track Mahalanobis to pros (target:
 * decrease), top-1%/top-0.1% × random (target: maintained), finishing distribution
 * (target: stays inverse-bell).
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player, ContestConfig } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals } from '../parser';
import { getContestConfig } from '../rules';

const MLB_DIR = 'C:/Users/colin/dfs opto';
const OUT_DIR = 'C:/Users/colin/dfs opto/theory_dfs_v2';
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
const N = 150;
const FEE = 20;

const SLATES = [
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
  { slate: '4-29-26', proj: '4-29-26projections.csv', actuals: '4-29-26actuals.csv', pool: '4-29-26sspool.csv' },
  { slate: '5-1-26',  proj: '5-1-26projections.csv',  actuals: '5-1-26actuals.csv',  pool: '5-1-26sspool.csv' },
  { slate: '5-2-26',       proj: '5-2-26projections.csv',       actuals: '5-2-26actuals.csv',       pool: '5-2-26sspool.csv' },
  { slate: '5-2-26-main',  proj: '5-2-26projectionsmain.csv',   actuals: '5-2-26actualsmain.csv',   pool: '5-2-26sspoolmain.csv' },
  { slate: '5-2-26-night', proj: '5-2-26projectionsnight.csv',  actuals: '5-2-26actualsnight.csv',  pool: '5-2-26sspoolnight.csv' },
  { slate: '5-3-26',       proj: '5-3-26projections.csv',       actuals: '5-3-26actuals.csv',       pool: '5-3-26sspool.csv' },
];

// ============================================================
// EMPIRICAL TYPE SCALES (derived from combo_saturation analysis)
// ============================================================
// Each scale = pro_gap[type] / todfs_gap[type], computed from analysis_output.json.
// Scale 1.0 = preserve current Theory-DFS V1 penalty. Scale 0.0 = remove penalty entirely.
//
// Rationale per type:
//   same-team-NH: pro 0.20-0.28, todfs 0.32-0.47 -> scale ~0.60 (pros chalkier than V1)
//   P-plus-Nstack: pro 0.22-0.25, todfs 0.36-0.47 -> scale ~0.58
//   bring-back-1plus*: pro ~0.0, todfs +0.43-0.58 -> scale ~0.0 (pros at field rate)
//   bring-back-2plus*: pro 0.13-0.14, todfs +0.50-0.59 -> scale ~0.25
//   same-game-2/3: pro 0.11-0.17, todfs 0.39-0.44 -> scale ~0.35
//   same-game-4/5: pro -0.12 to -0.04, todfs 0.44-0.46 -> scale ~0.0 (pros use these MORE than field)
//   other (unrelated): scale 1.0 (no empirical signal)
const TYPE_SCALES: Record<string, number> = {
  'same-team-2H': 0.64, 'same-team-3H': 0.62, 'same-team-4H': 0.56, 'same-team-5H': 0.60,
  'P-plus-2stack': 0.62, 'P-plus-3stack': 0.59, 'P-plus-4stack': 0.53,
  'bring-back-2plus1': 0.00, 'bring-back-3plus1': 0.00, 'bring-back-4plus1': 0.00,
  'bring-back-2plus2': 0.25, 'bring-back-3plus2': 0.24,
  'same-game-2': 0.43, 'same-game-3': 0.25,
  'same-game-4': 0.00, 'same-game-5': 0.00,
  'pair-both-high-salary': 0.65, 'pair-both-low-salary': 0.50,
  'P-vs-1H': 1.00,  // keep P-vs-H penalty intact (Theory-DFS already correctly penalizes this in 1B)
  'other': 1.00,
};

// ============================================================
// THEORY-DFS PARAMS (V1 baseline + V2 new fields)
// ============================================================
const TODFS_PARAMS = {
  STACK_BONUS_PER_HITTER: 0.01, BRINGBACK_1: 0, BRINGBACK_2: 0, PITCHER_VS_HITTER_PENALTY: -0.10,
  MIN_PRIMARY_STACK: 4, OWNERSHIP_EFFICIENCY_EXPONENT: 0.5,
  W_PROJ: 1.0, W_LEV: 0.30, W_RV: 0.20, W_CMB: 0.25, W_VAR: 0.15, W_CEIL_EFF: 0.10,
  EXPLOITATIVE_EXPONENT: 1.5, EXPOSURE_CAP_HITTER: 0.25, EXPOSURE_CAP_PITCHER: 0.45,
  BAND_HIGH_PCT: 0.20, BAND_MID_PCT: 0.60, BAND_LOW_PCT: 0.20,
  MAX_PAIRWISE_OVERLAP: 6, TRIPLE_FREQ_CAP: 5, PPD_LINEUP_PENALTY: 0.10, PPD_LINEUP_TOP_PCT: 0.10,
};

// ============================================================
// HERMES-A baseline (for cross-comparison only)
// ============================================================
const HERMES_A = {
  lambda: 0.58, gamma: 5, teamCapPct: 0.26, minPrimaryStack: 4,
  maxExposure: 0.21, maxExposurePitcher: 0.41, extremeCornerCap: true,
  comboPower: 4, binAllocation: { chalk: 0.50, core: 0.30, value: 0.20, contra: 0.00, deep: 0.00 },
};

// ============================================================
// UTILS
// ============================================================
function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function mean(a: number[]): number { if (!a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; }
function stddev(a: number[]): number { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); }
function rankPercentile(values: number[]): number[] {
  const idx = values.map((v, i) => ({ v, i }));
  idx.sort((a, b) => a.v - b.v);
  const out = new Array<number>(values.length);
  for (let r = 0; r < values.length; r++) out[idx[r].i] = values.length > 1 ? r / (values.length - 1) : 0;
  return out;
}
function isPitcher(p: Player): boolean { return (p.position || '').toUpperCase().includes('P'); }

// ============================================================
// Top-5 combos loader (from combo-saturation raw output)
// ============================================================
let SLATE_TOP5: Map<string, Map<number, Set<string>>> | null = null;
function loadTop5(): Map<string, Map<number, Set<string>>> {
  if (SLATE_TOP5) return SLATE_TOP5;
  console.log('Loading top-5 combos from raw_combos.json...');
  const raw = JSON.parse(fs.readFileSync(path.join(MLB_DIR, 'combo_saturation_analysis', 'raw_combos.json'), 'utf-8'));
  const result = new Map<string, Map<number, Set<string>>>();
  for (const slate of raw) {
    const bySize = new Map<number, Set<string>>();
    for (const N of [2, 3, 4, 5]) {
      const fs2 = slate.fieldSummary[String(N)] || slate.fieldSummary[N];
      if (!fs2) continue;
      const top5keys = (fs2.topCombos || []).slice(0, 5).map((c: any) => c.key);
      bySize.set(N, new Set(top5keys));
    }
    result.set(slate.slate, bySize);
  }
  SLATE_TOP5 = result;
  return result;
}

// Returns true if `lineup` contains all players of `combo` (combo = sorted '|'-joined ID string).
function lineupContainsCombo(lineupIds: Set<string>, combo: string): boolean {
  const ids = combo.split('|');
  for (const id of ids) if (!lineupIds.has(id)) return false;
  return true;
}

function lineupContainsAnyTop5(lineupIds: Set<string>, top5: Map<number, Set<string>>): boolean {
  for (const [, combos] of top5) {
    for (const c of combos) {
      if (lineupContainsCombo(lineupIds, c)) return true;
    }
  }
  return false;
}

// ============================================================
// COMBO TYPE CLASSIFIER (matches combo-saturation-extract)
// ============================================================
function classifyComboPair(a: Player, b: Player): string[] {
  const types: string[] = [];
  const aIsP = isPitcher(a), bIsP = isPitcher(b);
  const aTeam = (a.team || '').toUpperCase(), bTeam = (b.team || '').toUpperCase();
  const aOpp = (a.opponent || '').toUpperCase(), bOpp = (b.opponent || '').toUpperCase();

  if (!aIsP && !bIsP) {
    if (aTeam && bTeam && aTeam === bTeam) types.push('same-team-2H');
    if (aTeam && bTeam && aTeam !== bTeam && aOpp === bTeam && bOpp === aTeam) {
      // Bring-back pair (cross-game pair).
    }
    if (aTeam && aOpp && bTeam && bOpp && [aTeam, aOpp].sort().join('@') === [bTeam, bOpp].sort().join('@')) {
      types.push('same-game-2');
    }
  }
  if ((aIsP && !bIsP && aOpp === bTeam) || (bIsP && !aIsP && bOpp === aTeam)) {
    types.push('P-vs-1H');
  }
  if ((aIsP && !bIsP && aTeam === bTeam) || (bIsP && !aIsP && bTeam === aTeam)) {
    types.push('P-plus-1stack');  // pitcher + own-team hitter (rare/odd construction)
  }
  // Salary tier.
  const sals = [a.salary || 0, b.salary || 0].sort((x, y) => y - x);
  if (sals[0] > 6000 && sals[1] > 6000) types.push('pair-both-high-salary');
  else if (sals[0] < 4000 && sals[1] < 4000) types.push('pair-both-low-salary');
  if (types.length === 0) types.push('other');
  return types;
}

function classifyComboTriple(players: Player[]): string[] {
  const types: string[] = [];
  const pitchers = players.filter(isPitcher);
  const hitters = players.filter(p => !isPitcher(p));
  const teamCount = new Map<string, number>();
  for (const p of hitters) {
    const t = (p.team || '').toUpperCase();
    if (t) teamCount.set(t, (teamCount.get(t) || 0) + 1);
  }
  const games = new Set<string>();
  for (const p of players) {
    const t = (p.team || '').toUpperCase(), o = (p.opponent || '').toUpperCase();
    if (t && o) games.add([t, o].sort().join('@'));
  }
  if (games.size === 1) types.push(`same-game-${players.length}`);
  if (hitters.length === players.length && [...teamCount.values()].length === 1) {
    types.push(`same-team-${players.length}H`);
  }
  if (hitters.length === players.length && [...teamCount.values()].length === 2) {
    const counts = [...teamCount.values()].sort((a, b) => b - a);
    types.push(`bring-back-${counts[0]}plus${counts[1]}`);
  }
  if (pitchers.length === 1 && hitters.length === players.length - 1) {
    const distinctTeams = new Set(hitters.map(p => (p.team || '').toUpperCase()));
    if (distinctTeams.size === 1) types.push(`P-plus-${hitters.length}stack`);
  }
  if (types.length === 0) types.push('other');
  return types;
}

function comboTypeFor(players: Player[]): string {
  // Pick the FIRST classification (priority order: same-team > P-plus-stack > bring-back > same-game > other).
  // This matches the combo-saturation analysis's primary type assignment.
  const types = players.length === 2 ? classifyComboPair(players[0], players[1]) : classifyComboTriple(players);
  // Priority: prefer same-team, then P-plus-stack, then bring-back, then same-game, then salary, then other.
  for (const prefix of ['same-team-', 'P-plus-', 'bring-back-', 'same-game-', 'pair-both', 'P-vs-']) {
    const t = types.find(x => x.startsWith(prefix));
    if (t) return t;
  }
  return types[0] || 'other';
}

function combosOfSize<T>(arr: T[], n: number): T[][] {
  const out: T[][] = []; const k = arr.length;
  if (n > k) return out;
  const idx = Array.from({ length: n }, (_, i) => i);
  while (true) {
    out.push(idx.map(i => arr[i]));
    let i = n - 1;
    while (i >= 0 && idx[i] === k - n + i) i--;
    if (i < 0) break;
    idx[i]++;
    for (let j = i + 1; j < n; j++) idx[j] = idx[j - 1] + 1;
  }
  return out;
}

// ============================================================
// SLATE LOADING
// ============================================================
interface SlateData {
  slate: string;
  candidates: Lineup[];
  players: Player[];
  actuals: ContestActuals;
  config: ContestConfig;
  optimalProj: number;
  chalkAnchorOwn: number;
  slatePlayerOwnPctile: Map<string, number>;
  consensusStats: Record<string, { mean: number; std: number }> | null;
  numTeams: number;
}

async function loadSlate(s: typeof SLATES[0], cons: any): Promise<SlateData | null> {
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
  let optProj = 0;
  for (const lu of loaded.lineups) if (lu.projection > optProj) optProj = lu.projection;
  const sortedByLuOwn = [...loaded.lineups].sort((a, b) => (b.ownership || 0) - (a.ownership || 0));
  const chalkAnchor = mean(sortedByLuOwn.slice(0, Math.min(100, sortedByLuOwn.length)).map(lu => lu.ownership || 0));
  const ownPctile = new Map<string, number>();
  const sortedByOwn = [...playerPool.players].sort((a, b) => (a.ownership || 0) - (b.ownership || 0));
  for (let i = 0; i < sortedByOwn.length; i++) {
    ownPctile.set(sortedByOwn[i].id, sortedByOwn.length > 1 ? i / (sortedByOwn.length - 1) : 0);
  }
  const teams = new Set(playerPool.players.map(p => (p.team || '').toUpperCase()).filter(t => t));
  return {
    slate: s.slate, candidates: loaded.lineups, players: playerPool.players, actuals, config,
    optimalProj: optProj, chalkAnchorOwn: chalkAnchor,
    slatePlayerOwnPctile: ownPctile, consensusStats: cons[s.slate] || null,
    numTeams: teams.size,
  };
}

// ============================================================
// PORTFOLIO BUILDERS
// ============================================================

// Build pair/triple field-frequency maps from CANDIDATE POOL (proxy for field).
// Used by both V1 and V2 — same as Theory-DFS-MLB original 1E.
function buildPairTripleFreqs(candidates: Lineup[]): { pair: Map<string, number>; triple: Map<string, number> } {
  const pair = new Map<string, number>();
  const triple = new Map<string, number>();
  let totalW = 0;
  for (const lu of candidates) {
    const w = Math.max(0.1, lu.projection || 1) ** 2;
    totalW += w;
    const ids = lu.players.map(p => p.id).sort();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const k = ids[i] + '|' + ids[j];
        pair.set(k, (pair.get(k) || 0) + w);
      }
    }
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        for (let l = j + 1; l < ids.length; l++) {
          const k = ids[i] + '|' + ids[j] + '|' + ids[l];
          triple.set(k, (triple.get(k) || 0) + w);
        }
      }
    }
  }
  for (const k of pair.keys()) pair.set(k, pair.get(k)! / totalW);
  for (const k of triple.keys()) triple.set(k, triple.get(k)! / totalW);
  return { pair, triple };
}

interface ScoredLU {
  lu: Lineup;
  proj: number; floor: number; ceiling: number; range: number;
  primarySize: number;
  secondarySize: number;  // V5: needed for 3-3 archetype
  bringBack: number;      // V7: bring-back hitter count
  corrAdj: number;
  logOwn: number;
  uniqueness: number;  // raw uniqueness score (typed-or-untyped depending on V1 vs V2)
  ppd: number;
  stackOwnAvg: number;  // V3: mean ownership of primary-stack hitters
  ev: number;
  projPct: number; ownPct: number; rangePct: number; ppdPct: number; uniqPct: number;
  stackOwnPct: number;  // V3: slate-relative percentile of stackOwnAvg
}

function scoreLineup(
  lu: Lineup,
  pairFreqs: Map<string, number>,
  tripleFreqs: Map<string, number>,
  applyTypeScaling: boolean,
  stackBonus?: number,
  bringback1?: number,
  bringback2?: number,
  secondary4StkBonus?: number,
): ScoredLU {
  let floor = 0, ceiling = 0;
  for (const p of lu.players) {
    if (p.percentiles) {
      floor += p.percentiles.p25 || p.projection * 0.85;
      ceiling += p.percentiles.p75 || p.projection * 1.15;
    } else { floor += p.projection * 0.85; ceiling += p.projection * 1.15; }
  }
  // Correlation (1B) — UNCHANGED in V2.
  const teamHitters = new Map<string, number>();
  const pitchers: Player[] = [];
  for (const p of lu.players) {
    if (isPitcher(p)) pitchers.push(p);
    else { const t = (p.team || '').toUpperCase(); if (t) teamHitters.set(t, (teamHitters.get(t) || 0) + 1); }
  }
  let primaryTeam = '', primarySize = 0;
  for (const [t, c] of teamHitters) if (c > primarySize) { primarySize = c; primaryTeam = t; }
  let secondarySize = 0;
  for (const [t, c] of teamHitters) if (t !== primaryTeam && c > secondarySize) secondarySize = c;
  let primaryOpp = '';
  for (const p of lu.players) if ((p.team || '').toUpperCase() === primaryTeam) { primaryOpp = (p.opponent || '').toUpperCase(); if (primaryOpp) break; }
  const bringBack = primaryOpp ? (teamHitters.get(primaryOpp) || 0) : 0;
  let pOppHitters = 0;
  for (const p of pitchers) { const o = (p.opponent || '').toUpperCase(); if (o) pOppHitters += teamHitters.get(o) || 0; }
  const sb = stackBonus !== undefined ? stackBonus : TODFS_PARAMS.STACK_BONUS_PER_HITTER;
  const bb1 = bringback1 !== undefined ? bringback1 : TODFS_PARAMS.BRINGBACK_1;
  const bb2 = bringback2 !== undefined ? bringback2 : TODFS_PARAMS.BRINGBACK_2;
  let corrAdj = 0;
  if (primarySize >= 3) corrAdj += sb * (primarySize - 2);
  if (bringBack === 1) corrAdj += bb1;
  else if (bringBack >= 2) corrAdj += bb2;
  // Secondary stack bonus for 4-stacks (avoid naked 4s; promote 4-2 / 4-3 structure).
  if (secondary4StkBonus && primarySize === 4 && secondarySize >= 2) {
    corrAdj += secondary4StkBonus * (Math.min(secondarySize, 3) - 1);  // 2→1×, 3+→2×
  }
  corrAdj += TODFS_PARAMS.PITCHER_VS_HITTER_PENALTY * pOppHitters;

  // Combinatorial uniqueness (1E) — TYPE-SCALED in V2.
  const ids = lu.players.map(p => p.id).sort();
  let uniqueness = 0;
  for (let i = 0; i < lu.players.length; i++) {
    for (let j = i + 1; j < lu.players.length; j++) {
      const a = lu.players[i], b = lu.players[j];
      const key = [a.id, b.id].sort().join('|');
      const f = pairFreqs.get(key) || 1e-6;
      const baseContribution = -Math.log(f);  // higher for rare combos
      let scale = 1.0;
      if (applyTypeScaling) {
        const t = comboTypeFor([a, b]);
        scale = TYPE_SCALES[t] !== undefined ? TYPE_SCALES[t] : 1.0;
      }
      uniqueness += scale * baseContribution;
    }
  }
  // Top-3 triples by frequency.
  const tripFs: { players: Player[]; key: string; f: number }[] = [];
  for (let i = 0; i < lu.players.length; i++) {
    for (let j = i + 1; j < lu.players.length; j++) {
      for (let l = j + 1; l < lu.players.length; l++) {
        const tri = [lu.players[i], lu.players[j], lu.players[l]];
        const k = tri.map(p => p.id).sort().join('|');
        const f = tripleFreqs.get(k) || 1e-6;
        tripFs.push({ players: tri, key: k, f });
      }
    }
  }
  tripFs.sort((a, b) => b.f - a.f);
  const topTrips = tripFs.slice(0, TODFS_PARAMS.TRIPLE_FREQ_CAP);
  for (const t of topTrips) {
    const baseContribution = -Math.log(t.f);
    let scale = 1.0;
    if (applyTypeScaling) {
      const ty = comboTypeFor(t.players);
      scale = TYPE_SCALES[ty] !== undefined ? TYPE_SCALES[ty] : 1.0;
    }
    uniqueness += scale * baseContribution;
  }

  let logOwn = 0;
  for (const p of lu.players) logOwn += Math.log(Math.max(0.1, p.ownership || 0.5));
  let ppd = 0;
  for (const p of lu.players) if (p.salary && p.projection) ppd += p.projection / (p.salary / 1000);

  // V3: stack chalk-lean — mean ownership of primary-stack hitters.
  let stackOwnAvg = 0;
  if (primaryTeam) {
    const stackOwns: number[] = [];
    for (const p of lu.players) {
      if (isPitcher(p)) continue;
      if ((p.team || '').toUpperCase() === primaryTeam) stackOwns.push(p.ownership || 0);
    }
    if (stackOwns.length > 0) stackOwnAvg = stackOwns.reduce((s, x) => s + x, 0) / stackOwns.length;
  }

  return {
    lu, proj: lu.projection, floor, ceiling, range: ceiling - floor,
    primarySize, secondarySize, bringBack, corrAdj, logOwn, uniqueness, ppd, stackOwnAvg,
    ev: 0, projPct: 0, ownPct: 0, rangePct: 0, ppdPct: 0, uniqPct: 0, stackOwnPct: 0,
  };
}

interface VariantOpts {
  applyTypeScaling: boolean;
  topNFilter: number;
  stackChalkBonus?: number;
  wCmbOverride?: number;
  wLevOverride?: number;  // V1.1 sweep: leverage weight (V1 default 0.30)
  wProjOverride?: number;  // V1-ProjEmphasis: projection weight (V1 default 1.0)
  excludeLPHO?: boolean;   // V1-NoLowProjHighOwn: hard 0% on LowProj/HighOwn band
  // V1-NaturalCorr: relax correlation forcing to match pro patterns
  // (V1 audit: pros 80% naked vs V1 4% naked; pros 22% 4-stacks vs V1 0%)
  stackBonusOverride?: number;   // V1 default 0.10 (× (size-2))
  bringback1Override?: number;   // V1 default 0.05
  bringback2Override?: number;   // V1 default 0.08
  secondary4StkBonus?: number;   // bonus when primarySize=4 AND secondarySize >= 2 (4-2 or 4-3)
  // V5: stack-size mix mandate (fractions sum to 1.0). If set, forces portfolio composition.
  stackMix?: { fivePlus: number; four: number; threeThree: number };
  // V6: PPD-corner penalty overrides
  ppdTopPctOverride?: number;
  ppdPenaltyOverride?: number;
  // V7: bring-back mandate (min lineups with BB>=1, BB>=2). If set, forces composition.
  bringBackMin?: { gte1: number; gte2: number };
}

function buildTheoryDfsPortfolio(sd: SlateData, opts: VariantOpts): Lineup[] {
  // Optionally apply top-N hard filter (topNFilter=0 means no filter).
  let candidatePool = sd.candidates;
  if (opts.topNFilter > 0) {
    const fullTop5 = loadTop5().get(sd.slate);  // map<size, Set<keys (top-5)>>
    if (fullTop5) {
      // Build topN subset: take only first N from each size's top-5.
      const topN = new Map<number, Set<string>>();
      for (const [size, combos] of fullTop5) {
        const arr = Array.from(combos).slice(0, opts.topNFilter);
        topN.set(size, new Set(arr));
      }
      const filtered: Lineup[] = [];
      for (const lu of candidatePool) {
        const ids = new Set(lu.players.map(p => p.id));
        if (!lineupContainsAnyTop5(ids, topN)) filtered.push(lu);
      }
      if (filtered.length >= N * 5) candidatePool = filtered;
    }
  }

  const { pair, triple } = buildPairTripleFreqs(candidatePool);
  const scored = candidatePool.map(lu => scoreLineup(lu, pair, triple, opts.applyTypeScaling, opts.stackBonusOverride, opts.bringback1Override, opts.bringback2Override, opts.secondary4StkBonus));
  const projAdj = scored.map(s => s.proj * (1 + s.corrAdj));
  const projPct = rankPercentile(projAdj);
  const ownPct = rankPercentile(scored.map(s => s.logOwn));
  const rangePct = rankPercentile(scored.map(s => s.range));
  const ppdPct = rankPercentile(scored.map(s => s.ppd));
  const uniqPct = rankPercentile(scored.map(s => s.uniqueness));
  const stackOwnPct = rankPercentile(scored.map(s => s.stackOwnAvg));
  for (let i = 0; i < scored.length; i++) {
    scored[i].projPct = projPct[i]; scored[i].ownPct = ownPct[i];
    scored[i].rangePct = rangePct[i]; scored[i].ppdPct = ppdPct[i];
    scored[i].uniqPct = uniqPct[i];
    scored[i].stackOwnPct = stackOwnPct[i];
  }
  const stackChalkBonus = opts.stackChalkBonus || 0;
  const wCmb = opts.wCmbOverride !== undefined ? opts.wCmbOverride : TODFS_PARAMS.W_CMB;
  const wLev = opts.wLevOverride !== undefined ? opts.wLevOverride : TODFS_PARAMS.W_LEV;
  const wProj = opts.wProjOverride !== undefined ? opts.wProjOverride : TODFS_PARAMS.W_PROJ;
  const ppdTop = opts.ppdTopPctOverride !== undefined ? opts.ppdTopPctOverride : TODFS_PARAMS.PPD_LINEUP_TOP_PCT;
  const ppdPen = opts.ppdPenaltyOverride !== undefined ? opts.ppdPenaltyOverride : TODFS_PARAMS.PPD_LINEUP_PENALTY;
  for (const s of scored) {
    let ev = wProj * s.projPct
           + wLev * (1 - s.ownPct)
           + TODFS_PARAMS.W_VAR * s.rangePct * 0.85
           + wCmb * s.uniqPct
           + stackChalkBonus * s.stackOwnPct;  // V3 term
    if (s.ppdPct >= 1 - ppdTop) ev *= (1 - ppdPen);
    s.ev = ev;
  }

  // V5: if stackMix enabled, allow primarySize=3 (3-3 splits). Otherwise require >= MIN_PRIMARY_STACK.
  const minStack = opts.stackMix ? 3 : TODFS_PARAMS.MIN_PRIMARY_STACK;
  let pool = scored.filter(s => s.primarySize >= minStack);
  if (pool.length < N) pool = scored;

  // V1-NoLowProjHighOwn: hard 0% on LowProj/HighOwn band.
  // Per-slate medians from CANDIDATE POOL (not pool+pros, since pros aren't accessible here).
  if (opts.excludeLPHO) {
    const projsArr = pool.map(s => s.proj).slice().sort((a, b) => a - b);
    const ownsArr = pool.map(s => s.lu.ownership || 0).slice().sort((a, b) => a - b);
    const medProj = projsArr[Math.floor(projsArr.length / 2)];
    const medOwn = ownsArr[Math.floor(ownsArr.length / 2)];
    pool = pool.filter(s => {
      const hp = s.proj >= medProj;
      const ho = (s.lu.ownership || 0) >= medOwn;
      return !(!hp && ho);  // exclude LowProj && HighOwn
    });
    if (pool.length < N) pool = scored;  // fallback if filter starves selection
  }

  const sortedHigh = [...pool].sort((a, b) => (b.projPct + b.ownPct) - (a.projPct + a.ownPct));
  const sortedLow = [...pool].sort((a, b) => ((1 - b.projPct) + (1 - b.ownPct)) - ((1 - a.projPct) + (1 - a.ownPct)));
  const HIGH_TARGET = Math.round(N * TODFS_PARAMS.BAND_HIGH_PCT);
  const LOW_TARGET = Math.round(N * TODFS_PARAMS.BAND_LOW_PCT);
  const MID_TARGET = N - HIGH_TARGET - LOW_TARGET;

  const selected: ScoredLU[] = [];
  const exposure = new Map<string, number>();
  const seen = new Set<string>();
  // V5: stack-mix bucket counts.
  const stackBucketCount = { fivePlus: 0, four: 0, threeThree: 0, threeOther: 0 };
  function bucketOf(s: ScoredLU): 'fivePlus' | 'four' | 'threeThree' | 'threeOther' {
    if (s.primarySize >= 5) return 'fivePlus';
    if (s.primarySize === 4) return 'four';
    if (s.primarySize === 3 && s.secondarySize >= 3) return 'threeThree';
    return 'threeOther';
  }
  // V7: bring-back counts.
  const bbCount = { gte1: 0, gte2: 0 };
  function passes(s: ScoredLU): boolean {
    if (seen.has(s.lu.hash)) return false;
    for (const p of s.lu.players) {
      const cur = exposure.get(p.id) || 0;
      const cap = isPitcher(p) ? TODFS_PARAMS.EXPOSURE_CAP_PITCHER : TODFS_PARAMS.EXPOSURE_CAP_HITTER;
      if ((cur + 1) / N > cap) return false;
    }
    const ids = new Set(s.lu.players.map(p => p.id));
    for (const sel of selected) {
      let ov = 0; for (const p of sel.lu.players) if (ids.has(p.id)) ov++;
      if (ov > TODFS_PARAMS.MAX_PAIRWISE_OVERLAP) return false;
    }
    // V5: stack-mix bucket caps.
    if (opts.stackMix) {
      const b = bucketOf(s);
      if (b === 'threeOther') return false;
      const cap5 = Math.round(N * opts.stackMix.fivePlus);
      const cap4 = Math.round(N * opts.stackMix.four);
      const cap33 = Math.round(N * opts.stackMix.threeThree);
      if (b === 'fivePlus' && stackBucketCount.fivePlus >= cap5) return false;
      if (b === 'four' && stackBucketCount.four >= cap4) return false;
      if (b === 'threeThree' && stackBucketCount.threeThree >= cap33) return false;
    }
    // V7: bring-back mandate via inverse cap on naked / BB<2 lineups.
    if (opts.bringBackMin) {
      const minGte1 = Math.round(N * opts.bringBackMin.gte1);
      const minGte2 = Math.round(N * opts.bringBackMin.gte2);
      const maxNaked = N - minGte1;
      const maxLessThan2 = N - minGte2;
      const nakedCount = selected.length - bbCount.gte1;
      const lessThan2Count = selected.length - bbCount.gte2;
      if (s.bringBack < 1 && nakedCount >= maxNaked) return false;
      if (s.bringBack < 2 && lessThan2Count >= maxLessThan2) return false;
    }
    return true;
  }
  function add(s: ScoredLU) {
    selected.push(s); seen.add(s.lu.hash);
    for (const p of s.lu.players) exposure.set(p.id, (exposure.get(p.id) || 0) + 1);
    if (opts.stackMix) stackBucketCount[bucketOf(s)]++;
    if (s.bringBack >= 1) bbCount.gte1++;
    if (s.bringBack >= 2) bbCount.gte2++;
  }
  function fillBand(bandPool: ScoredLU[], target: number) {
    const sorted = [...bandPool].sort((a, b) => b.ev - a.ev);
    let added = 0;
    for (const s of sorted) { if (added >= target) break; if (passes(s)) { add(s); added++; } }
    if (added < target) {
      const old = TODFS_PARAMS.MAX_PAIRWISE_OVERLAP;
      (TODFS_PARAMS as any).MAX_PAIRWISE_OVERLAP = old + 1;
      for (const s of sorted) { if (added >= target) break; if (passes(s)) { add(s); added++; } }
      (TODFS_PARAMS as any).MAX_PAIRWISE_OVERLAP = old;
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

// ============================================================
// SCORING + STRUCTURAL METRICS (mirrors structural-validation)
// ============================================================
const UNIVERSAL_METRICS = ['projRatioToOptimal', 'ceilingRatioToOptimal', 'avgPlayerOwnPctile', 'ownStdRatio', 'ownDeltaFromAnchor'] as const;

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

interface Result {
  system: string;
  slate: string;
  totalPayout: number; t1: number; t01: number;
  metrics: { projRatioToOptimal: number; ceilingRatioToOptimal: number; avgPlayerOwnPctile: number; ownStdRatio: number; ownDeltaFromAnchor: number };
  mahal: number | null;
  finishPctiles: number[];
  poolFiltered: number; poolOriginal: number;
  avgProj: number; avgOwn: number;
}

function evaluatePortfolio(portfolio: Lineup[], sd: SlateData, system: string, originalPoolSize: number, filteredPoolSize: number): Result {
  const F = sd.actuals.entries.length;
  const sortedActuals = sd.actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
  const top1T = sortedActuals[Math.max(0, Math.floor(F * 0.01) - 1)] || 0;
  const top01T = sortedActuals[Math.max(0, Math.floor(F * 0.001) - 1)] || 0;
  const payoutTable = buildPayoutTable(Math.max(F, 100));
  let totalPayout = 0, t1 = 0, t01 = 0;
  const finishPctiles: number[] = [];
  for (const lu of portfolio) {
    let actual = 0, miss = false;
    for (const p of lu.players) {
      const r = sd.actuals.playerActualsByName.get(norm(p.name));
      if (!r) { miss = true; break; }
      actual += r.fpts;
    }
    if (miss) continue;
    let lo = 0, hi = sortedActuals.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (sortedActuals[mid] >= actual) lo = mid + 1; else hi = mid; }
    const rank = Math.max(1, lo);
    finishPctiles.push(F > 1 ? 1 - (rank - 1) / (F - 1) : 0.5);
    if (actual >= top1T) t1++;
    if (actual >= top01T) t01++;
    const pay = rank <= payoutTable.length ? payoutTable[rank - 1] : 0;
    if (pay > 0) {
      let cw = 0;
      for (const e of sd.actuals.entries) if (Math.abs(e.actualPoints - actual) <= 0.25) cw++;
      cw = Math.max(0, cw - 1);
      totalPayout += pay / Math.sqrt(1 + cw * 0.5);
    }
  }
  // 5-metric universal.
  const luProjs: number[] = [], luCeils: number[] = [], luOwns: number[] = [], luOwnStds: number[] = [], pctileSums: number[] = [];
  for (const lu of portfolio) {
    const owns = lu.players.map(p => p.ownership || 0);
    luOwns.push(mean(owns));
    luProjs.push(lu.projection);
    luCeils.push(lu.players.reduce((s, p) => s + ((p as any).ceiling || (p.projection || 0) * 1.4), 0));
    luOwnStds.push(stddev(owns));
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
  let mahal: number | null = null;
  if (sd.consensusStats) {
    let sum = 0, n = 0;
    for (const k of UNIVERSAL_METRICS) {
      const c = sd.consensusStats[k];
      if (!c || c.std < 1e-9) continue;
      const d = ((metrics as any)[k] - c.mean) / c.std;
      sum += d * d; n++;
    }
    if (n > 0) mahal = Math.sqrt(sum / n);
  }
  return { system, slate: sd.slate, totalPayout, t1, t01, metrics, mahal, finishPctiles, poolFiltered: filteredPoolSize, poolOriginal: originalPoolSize, avgProj: mean(luProjs), avgOwn: mean(luOwns) };
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log('================================================================');
  console.log('THEORY-DFS V2 VALIDATION — empirically-calibrated combinatorial uniqueness');
  console.log('================================================================\n');

  // Consensus is now computed PER SLATE from the slate's pro lineups (was: static external file).
  // This fixes Mahal=0.00 on slates not in pro_consensus_slate_relative.json (4-29-26+).
  const cons: Record<string, Record<string, { mean: number; std: number }>> = {};
  loadTop5();  // pre-load

  const allResults: Result[] = [];
  // Per-slate lineup-level dump (V1 + pros) for descriptive analysis.
  const dumpAll: any[] = [];
  const PROS = new Set(['zroth', 'zroth2', 'nerdytenor', 'shipmymoney', 'shaidyadvice', 'needlunchmoney', 'bgreseth', 'youdacao', 'b_heals152']);
  for (const s of SLATES) {
    const sd = await loadSlate(s, cons);
    if (!sd) continue;

    // === DYNAMIC CONSENSUS: compute pro portfolio metrics inline per slate ===
    const playerByName = new Map<string, Player>();
    for (const p of sd.players) playerByName.set(norm(p.name), p);
    const proPortfolios = new Map<string, Player[][]>();  // user -> list of lineups (arrays of Player)
    for (const e of sd.actuals.entries) {
      const user = (e.entryName || '').toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').trim();
      if (!PROS.has(user)) continue;
      const players: Player[] = [];
      let miss = false;
      for (const nm of e.playerNames) {
        const p = playerByName.get(norm(nm));
        if (!p) { miss = true; break; }
        players.push(p);
      }
      if (miss || players.length !== 10) continue;
      if (!proPortfolios.has(user)) proPortfolios.set(user, []);
      proPortfolios.get(user)!.push(players);
    }
    // Compute optimal ceiling (max ceiling lineup in pool, for ratio metric).
    let optCeil = 0;
    for (const lu of sd.candidates) {
      const c = lu.players.reduce((s2, p) => s2 + ((p as any).ceiling || (p.projection || 0) * 1.4), 0);
      if (c > optCeil) optCeil = c;
    }
    const slateAvgOwn = mean(sd.players.map(p => p.ownership || 0));
    // Per-pro metrics array
    const metricArrays: Record<string, number[]> = {
      projRatioToOptimal: [], ceilingRatioToOptimal: [], avgPlayerOwnPctile: [],
      ownStdRatio: [], ownDeltaFromAnchor: [],
    };
    for (const [, lineups] of proPortfolios) {
      if (lineups.length === 0) continue;
      const luProjs: number[] = [], luCeils: number[] = [], luOwns: number[] = [], luOwnStds: number[] = [], pctileSums: number[] = [];
      for (const players of lineups) {
        const owns = players.map(p => p.ownership || 0);
        luOwns.push(mean(owns));
        luProjs.push(players.reduce((s2, p) => s2 + (p.projection || 0), 0));
        luCeils.push(players.reduce((s2, p) => s2 + ((p as any).ceiling || (p.projection || 0) * 1.4), 0));
        luOwnStds.push(stddev(owns));
        let pSum = 0;
        for (const p of players) pSum += sd.slatePlayerOwnPctile.get(p.id) || 0;
        pctileSums.push(pSum / players.length);
      }
      metricArrays.projRatioToOptimal.push(sd.optimalProj > 0 ? mean(luProjs) / sd.optimalProj : 0);
      metricArrays.ceilingRatioToOptimal.push(optCeil > 0 ? mean(luCeils) / optCeil : 0);
      metricArrays.avgPlayerOwnPctile.push(mean(pctileSums));
      metricArrays.ownStdRatio.push(slateAvgOwn > 0 ? mean(luOwnStds) / slateAvgOwn : 0);
      metricArrays.ownDeltaFromAnchor.push(mean(luOwns) - sd.chalkAnchorOwn);
    }
    const slateCons: Record<string, { mean: number; std: number }> = {};
    for (const k of UNIVERSAL_METRICS) {
      const vals = metricArrays[k];
      if (vals.length === 0) continue;
      const m = mean(vals);
      const sdv = vals.length > 1 ? Math.sqrt(vals.reduce((s2, v) => s2 + (v - m) ** 2, 0) / vals.length) : 0.01;
      slateCons[k] = { mean: m, std: sdv > 1e-9 ? sdv : 0.01 };
    }
    sd.consensusStats = Object.keys(slateCons).length > 0 ? slateCons : null;
    const top5 = loadTop5().get(sd.slate);
    let filteredPoolSize = sd.candidates.length;
    if (top5) {
      let n = 0;
      for (const lu of sd.candidates) {
        const ids = new Set(lu.players.map(p => p.id));
        if (!lineupContainsAnyTop5(ids, top5)) n++;
      }
      filteredPoolSize = n;
    }
    process.stderr.write(`${s.slate}: pool=${sd.candidates.length} filtered=${filteredPoolSize} ... `);
    const t0 = Date.now();
    // V1 baseline.
    const v1Portfolio = buildTheoryDfsPortfolio(sd, { applyTypeScaling: false, topNFilter: 0 });
    const v1Result = evaluatePortfolio(v1Portfolio, sd, 'theory-dfs-v1', sd.candidates.length, sd.candidates.length);
    // V1.1 W_LEV sweep portfolios (built early so dump can reference them).
    const vLev20Portfolio = buildTheoryDfsPortfolio(sd, { applyTypeScaling: false, topNFilter: 0, wLevOverride: 0.20 });
    const vLev15Portfolio = buildTheoryDfsPortfolio(sd, { applyTypeScaling: false, topNFilter: 0, wLevOverride: 0.15 });
    const vLev10Portfolio = buildTheoryDfsPortfolio(sd, { applyTypeScaling: false, topNFilter: 0, wLevOverride: 0.10 });
    const vLev05Portfolio = buildTheoryDfsPortfolio(sd, { applyTypeScaling: false, topNFilter: 0, wLevOverride: 0.05 });
    // V1-ProjEmphasis portfolio (built early so dump can reference it).
    const vProjEmphaPortfolio = buildTheoryDfsPortfolio(sd, { applyTypeScaling: false, topNFilter: 0, wProjOverride: 1.25 });
    // V1-NoLowProjHighOwn portfolio (hard 0% LP/HO; descriptive run).
    const vNoLPHOPortfolio = buildTheoryDfsPortfolio(sd, { applyTypeScaling: false, topNFilter: 0, excludeLPHO: true });
    // V1-NaturalCorr: halve STACK_BONUS, zero bring-back bonuses (let pros' patterns emerge naturally).
    const vNatCorrPortfolio = buildTheoryDfsPortfolio(sd, { applyTypeScaling: false, topNFilter: 0,
      stackBonusOverride: 0.05, bringback1Override: 0, bringback2Override: 0 });
    // V1-NoCorr: ZERO all correlation bonuses. Tests whether corrAdj is the binding constraint on 4-stack rate.
    const vNoCorrPortfolio = buildTheoryDfsPortfolio(sd, { applyTypeScaling: false, topNFilter: 0,
      stackBonusOverride: 0, bringback1Override: 0, bringback2Override: 0 });
    // V1-NoCorr-Sec4: V1-NoCorr but with secondary stack bonus for 4-stacks (4-2/4-3 structure, not naked).
    const vNoCorrSec4Portfolio = buildTheoryDfsPortfolio(sd, { applyTypeScaling: false, topNFilter: 0,
      stackBonusOverride: 0, bringback1Override: 0, bringback2Override: 0, secondary4StkBonus: 0.05 });

    // === Lineup-level dump for descriptive analysis ===
    function structuralFeatures(players: Player[]) {
      const teamHitterCounts = new Map<string, number>();
      const gameCounts = new Map<string, number>();
      const pitchers: Player[] = [];
      let salaryTotal = 0;
      const salaries: number[] = [];
      const owns: number[] = [];
      for (const p of players) {
        salaryTotal += p.salary || 0;
        salaries.push(p.salary || 0);
        owns.push(p.ownership || 0);
        const t = (p.team || '').toUpperCase(), o = (p.opponent || '').toUpperCase();
        if (isPitcher(p)) pitchers.push(p);
        else if (t) teamHitterCounts.set(t, (teamHitterCounts.get(t) || 0) + 1);
        if (t && o) {
          const g = [t, o].sort().join('@');
          gameCounts.set(g, (gameCounts.get(g) || 0) + 1);
        }
      }
      let primaryTeam = '', primarySize = 0;
      for (const [t, c] of teamHitterCounts) if (c > primarySize) { primarySize = c; primaryTeam = t; }
      let secondarySize = 0;
      for (const [t, c] of teamHitterCounts) if (t !== primaryTeam && c > secondarySize) secondarySize = c;
      let primaryOpp = '';
      for (const p of players) if ((p.team || '').toUpperCase() === primaryTeam) { primaryOpp = (p.opponent || '').toUpperCase(); if (primaryOpp) break; }
      const bringBack = primaryOpp ? (teamHitterCounts.get(primaryOpp) || 0) : 0;
      let maxGameStack = 0;
      for (const [, c] of gameCounts) if (c > maxGameStack) maxGameStack = c;
      const numGames = gameCounts.size;
      const numTeamsUsed = teamHitterCounts.size + (pitchers.length > 0 ? new Set(pitchers.map(p => (p.team || '').toUpperCase())).size : 0);
      // Salary distribution shape
      salaries.sort((a, b) => b - a);
      const salaryStd = Math.sqrt(salaries.reduce((s, v) => s + (v - salaryTotal / salaries.length) ** 2, 0) / Math.max(1, salaries.length));
      const salaryTopThree = salaries.slice(0, 3).reduce((s, v) => s + v, 0);
      const salaryBotThree = salaries.slice(-3).reduce((s, v) => s + v, 0);
      // GeoMean ownership (hitters only — pitcher leverage carve-out)
      let logOwnHit = 0, hitN = 0;
      for (const p of players) {
        if (isPitcher(p)) continue;
        logOwnHit += Math.log(Math.max(0.1, p.ownership || 0.5));
        hitN++;
      }
      const geoMeanOwnHit = hitN > 0 ? Math.exp(logOwnHit / hitN) : 0;
      const ownAvg = owns.reduce((s, v) => s + v, 0) / Math.max(1, owns.length);
      return {
        primaryTeam, primarySize, secondarySize, bringBack,
        maxGameStack, numGames, numTeamsUsed,
        salaryTotal, salaryStd, salaryTopThree, salaryBotThree,
        geoMeanOwnHit, ownAvg,
        pitcherIds: pitchers.map(p => p.id),
        pitcherNames: pitchers.map(p => p.name),
        pitcherTeams: pitchers.map(p => (p.team || '').toUpperCase()),
        pitcherOpps: pitchers.map(p => (p.opponent || '').toUpperCase()),
      };
    }
    function rankIn(actual: number, sortedDesc: number[]): number {
      let lo = 0, hi = sortedDesc.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (sortedDesc[mid] >= actual) lo = mid + 1; else hi = mid; }
      return Math.max(1, lo);
    }
    const sortedActuals = sd.actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
    const F = sd.actuals.entries.length;
    // V1 lineups detail
    const v1Detail: any[] = [];
    for (const lu of v1Portfolio) {
      let actual = 0, miss = false;
      for (const p of lu.players) {
        const r = sd.actuals.playerActualsByName.get(norm(p.name));
        if (!r) { miss = true; break; }
        actual += r.fpts;
      }
      const rank = miss ? -1 : rankIn(actual, sortedActuals);
      const feat = structuralFeatures(lu.players);
      v1Detail.push({
        pids: lu.players.map(p => p.id),
        names: lu.players.map(p => p.name),
        teams: lu.players.map(p => p.team),
        positions: lu.players.map(p => p.position),
        salaries: lu.players.map(p => p.salary),
        owns: lu.players.map(p => p.ownership),
        projection: lu.projection,
        actual: miss ? null : actual,
        rank,
        finishPct: rank > 0 && F > 1 ? 1 - (rank - 1) / (F - 1) : null,
        ...feat,
      });
    }
    // Pro lineups detail (reuses playerByName from consensus block above)
    const proDetail: any[] = [];
    for (const e of sd.actuals.entries) {
      const user = (e.entryName || '').toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').trim();
      if (!PROS.has(user)) continue;
      const players: Player[] = [];
      let miss = false;
      for (const nm of e.playerNames) {
        const p = playerByName.get(norm(nm));
        if (!p) { miss = true; break; }
        players.push(p);
      }
      if (miss || players.length !== 10) continue;
      const feat = structuralFeatures(players);
      const rank = e.rank;
      proDetail.push({
        user,
        pids: players.map(p => p.id),
        names: players.map(p => p.name),
        teams: players.map(p => p.team),
        positions: players.map(p => p.position),
        salaries: players.map(p => p.salary),
        owns: players.map(p => p.ownership),
        projection: players.reduce((s, p) => s + (p.projection || 0), 0),
        actual: e.actualPoints,
        rank,
        finishPct: F > 1 ? 1 - (rank - 1) / (F - 1) : null,
        ...feat,
      });
    }
    // V_LEV portfolio detail (each as same shape as v1Detail, minimal fields needed for band analysis).
    function buildLineupDetail(portfolio: Lineup[]): any[] {
      const out: any[] = [];
      const sdLocal = sd!;
      for (const lu of portfolio) {
        const feat = structuralFeatures(lu.players);
        let actual = 0, miss = false;
        for (const p of lu.players) {
          const r = sdLocal.actuals.playerActualsByName.get(norm(p.name));
          if (!r) { miss = true; break; }
          actual += r.fpts;
        }
        const rank = miss ? -1 : rankIn(actual, sortedActuals);
        out.push({
          projection: lu.projection,
          actual: miss ? null : actual,
          rank,
          finishPct: rank > 0 && F > 1 ? 1 - (rank - 1) / (F - 1) : null,
          ...feat,
        });
      }
      return out;
    }
    dumpAll.push({
      slate: sd.slate,
      numTeams: sd.numTeams,
      totalEntries: F,
      v1: v1Detail,
      pros: proDetail,
      vLev20: buildLineupDetail(vLev20Portfolio),
      vLev15: buildLineupDetail(vLev15Portfolio),
      vLev10: buildLineupDetail(vLev10Portfolio),
      vLev05: buildLineupDetail(vLev05Portfolio),
      vProjEmpha: buildLineupDetail(vProjEmphaPortfolio),
      vNoLPHO: buildLineupDetail(vNoLPHOPortfolio),
      vNatCorr: buildLineupDetail(vNatCorrPortfolio),
      vNoCorr: buildLineupDetail(vNoCorrPortfolio),
      vNoCorrSec4: buildLineupDetail(vNoCorrSec4Portfolio),
    });
    // V3: V1 + stack chalk-lean bonus (W_STACK_CHALK = 0.05).
    const v3Portfolio = buildTheoryDfsPortfolio(sd, { applyTypeScaling: false, topNFilter: 0, stackChalkBonus: 0.05 });
    const v3Result = evaluatePortfolio(v3Portfolio, sd, 'theory-dfs-v3', sd.candidates.length, sd.candidates.length);
    // V3b: smaller bonus (W_STACK_CHALK = 0.03).
    const v3bPortfolio = buildTheoryDfsPortfolio(sd, { applyTypeScaling: false, topNFilter: 0, stackChalkBonus: 0.03 });
    const v3bResult = evaluatePortfolio(v3bPortfolio, sd, 'theory-dfs-v3b', sd.candidates.length, sd.candidates.length);
    // V3c: middle bonus (W_STACK_CHALK = 0.04) — fallback if V3b too small.
    const v3cPortfolio = buildTheoryDfsPortfolio(sd, { applyTypeScaling: false, topNFilter: 0, stackChalkBonus: 0.04 });
    const v3cResult = evaluatePortfolio(v3cPortfolio, sd, 'theory-dfs-v3c', sd.candidates.length, sd.candidates.length);
    // V2a: type-scaling only (no top-N filter).
    const v2aPortfolio = buildTheoryDfsPortfolio(sd, { applyTypeScaling: true, topNFilter: 0 });
    const v2aResult = evaluatePortfolio(v2aPortfolio, sd, 'theory-dfs-v2a-scaling-only', sd.candidates.length, sd.candidates.length);
    // V2b: top-5 filter only (no scaling).
    const v2bPortfolio = buildTheoryDfsPortfolio(sd, { applyTypeScaling: false, topNFilter: 5 });
    const v2bResult = evaluatePortfolio(v2bPortfolio, sd, 'theory-dfs-v2b-top5-only', sd.candidates.length, filteredPoolSize);
    // V2c: top-1 surgical filter + type-scaling.
    const v2cPortfolio = buildTheoryDfsPortfolio(sd, { applyTypeScaling: true, topNFilter: 1 });
    // Recompute filtered count for v2c.
    let v2cPoolFiltered = sd.candidates.length;
    {
      const top1 = loadTop5().get(sd.slate);
      if (top1) {
        const tn = new Map<number, Set<string>>();
        for (const [size, combos] of top1) tn.set(size, new Set(Array.from(combos).slice(0, 1)));
        let n = 0;
        for (const lu of sd.candidates) {
          const ids = new Set(lu.players.map(p => p.id));
          if (!lineupContainsAnyTop5(ids, tn)) n++;
        }
        v2cPoolFiltered = n;
      }
    }
    const v2cResult = evaluatePortfolio(v2cPortfolio, sd, 'theory-dfs-v2c-top1-plus-scaling', sd.candidates.length, v2cPoolFiltered);
    // V4 variants: increased combo penalty (W_CMB > 0.25 baseline).
    const v4aPortfolio = buildTheoryDfsPortfolio(sd, { applyTypeScaling: false, topNFilter: 0, wCmbOverride: 0.40 });
    const v4aResult = evaluatePortfolio(v4aPortfolio, sd, 'theory-dfs-v4a', sd.candidates.length, sd.candidates.length);
    const v4bPortfolio = buildTheoryDfsPortfolio(sd, { applyTypeScaling: false, topNFilter: 0, wCmbOverride: 0.55 });
    const v4bResult = evaluatePortfolio(v4bPortfolio, sd, 'theory-dfs-v4b', sd.candidates.length, sd.candidates.length);
    const v4cPortfolio = buildTheoryDfsPortfolio(sd, { applyTypeScaling: false, topNFilter: 0, wCmbOverride: 0.70 });
    const v4cResult = evaluatePortfolio(v4cPortfolio, sd, 'theory-dfs-v4c', sd.candidates.length, sd.candidates.length);
    // V5: stack-size mix mandate (matches pros' empirical 68/24/8 distribution from A3 finding).
    const v5Portfolio = buildTheoryDfsPortfolio(sd, { applyTypeScaling: false, topNFilter: 0, stackMix: { fivePlus: 0.68, four: 0.24, threeThree: 0.08 } });
    const v5Result = evaluatePortfolio(v5Portfolio, sd, 'theory-dfs-v5-stackmix', sd.candidates.length, sd.candidates.length);
    // V6 series: PPD-corner penalty sweep.
    const v6aPortfolio = buildTheoryDfsPortfolio(sd, { applyTypeScaling: false, topNFilter: 0, ppdTopPctOverride: 0.10, ppdPenaltyOverride: 0.20 });
    const v6aResult = evaluatePortfolio(v6aPortfolio, sd, 'theory-dfs-v6a', sd.candidates.length, sd.candidates.length);
    const v6bPortfolio = buildTheoryDfsPortfolio(sd, { applyTypeScaling: false, topNFilter: 0, ppdTopPctOverride: 0.15, ppdPenaltyOverride: 0.20 });
    const v6bResult = evaluatePortfolio(v6bPortfolio, sd, 'theory-dfs-v6b', sd.candidates.length, sd.candidates.length);
    const v6cPortfolio = buildTheoryDfsPortfolio(sd, { applyTypeScaling: false, topNFilter: 0, ppdTopPctOverride: 0.10, ppdPenaltyOverride: 0.30 });
    const v6cResult = evaluatePortfolio(v6cPortfolio, sd, 'theory-dfs-v6c', sd.candidates.length, sd.candidates.length);
    const v6dPortfolio = buildTheoryDfsPortfolio(sd, { applyTypeScaling: false, topNFilter: 0, ppdTopPctOverride: 0.05, ppdPenaltyOverride: 0.20 });
    const v6dResult = evaluatePortfolio(v6dPortfolio, sd, 'theory-dfs-v6d', sd.candidates.length, sd.candidates.length);
    // V7: bring-back mandate (60% lineups have BB>=1, 30% have BB>=2).
    const v7Portfolio = buildTheoryDfsPortfolio(sd, { applyTypeScaling: false, topNFilter: 0, bringBackMin: { gte1: 0.60, gte2: 0.30 } });
    const v7Result = evaluatePortfolio(v7Portfolio, sd, 'theory-dfs-v7-bringback', sd.candidates.length, sd.candidates.length);
    // V8: COMPOUND — V4a (W_CMB=0.40) + V6d (PPD 5%/20%).
    const v8Portfolio = buildTheoryDfsPortfolio(sd, { applyTypeScaling: false, topNFilter: 0, wCmbOverride: 0.40, ppdTopPctOverride: 0.05, ppdPenaltyOverride: 0.20 });
    const v8Result = evaluatePortfolio(v8Portfolio, sd, 'theory-dfs-v8-compound', sd.candidates.length, sd.candidates.length);
    // V1-ProjEmphasis evaluated (built earlier with W_PROJ × 1.25; descriptive run).
    const vProjEmphaResult = evaluatePortfolio(vProjEmphaPortfolio, sd, 'theory-dfs-vprojempha', sd.candidates.length, sd.candidates.length);
    allResults.push(vProjEmphaResult);
    // V1-NoLowProjHighOwn evaluated.
    const vNoLPHOResult = evaluatePortfolio(vNoLPHOPortfolio, sd, 'theory-dfs-vnolpho', sd.candidates.length, sd.candidates.length);
    allResults.push(vNoLPHOResult);
    // V1-NaturalCorr evaluated.
    const vNatCorrResult = evaluatePortfolio(vNatCorrPortfolio, sd, 'theory-dfs-vnatcorr', sd.candidates.length, sd.candidates.length);
    allResults.push(vNatCorrResult);
    // V1-NoCorr evaluated (diagnostic).
    const vNoCorrResult = evaluatePortfolio(vNoCorrPortfolio, sd, 'theory-dfs-vnocorr', sd.candidates.length, sd.candidates.length);
    allResults.push(vNoCorrResult);
    // V1-NoCorr-Sec4 evaluated.
    const vNoCorrSec4Result = evaluatePortfolio(vNoCorrSec4Portfolio, sd, 'theory-dfs-vnocorrsec4', sd.candidates.length, sd.candidates.length);
    allResults.push(vNoCorrSec4Result);
    // V1.1 W_LEV sweep portfolios already built above; just evaluate now.
    const vLev20Result = evaluatePortfolio(vLev20Portfolio, sd, 'theory-dfs-vlev20', sd.candidates.length, sd.candidates.length);
    const vLev15Result = evaluatePortfolio(vLev15Portfolio, sd, 'theory-dfs-vlev15', sd.candidates.length, sd.candidates.length);
    const vLev10Result = evaluatePortfolio(vLev10Portfolio, sd, 'theory-dfs-vlev10', sd.candidates.length, sd.candidates.length);
    const vLev05Result = evaluatePortfolio(vLev05Portfolio, sd, 'theory-dfs-vlev05', sd.candidates.length, sd.candidates.length);
    allResults.push(v1Result, v3Result, v3bResult, v3cResult, v2aResult, v2bResult, v2cResult, v4aResult, v4bResult, v4cResult, v5Result, v6aResult, v6bResult, v6cResult, v6dResult, v7Result, v8Result,
                    vLev20Result, vLev15Result, vLev10Result, vLev05Result);
    process.stderr.write(`v1 m=${v1Result.mahal?.toFixed(2)} | v5 m=${v5Result.mahal?.toFixed(2)} | v6a m=${v6aResult.mahal?.toFixed(2)} | v7 m=${v7Result.mahal?.toFixed(2)} [${((Date.now() - t0) / 1000).toFixed(1)}s]\n`);
  }

  // Aggregate.
  console.log('\n================================================================');
  console.log('ISOLATION TEST: Theory-DFS V1 vs V2a (scaling only) vs V2b (top-5 only) vs V2c (top-1 + scaling)');
  console.log('================================================================\n');
  const v1 = allResults.filter(r => r.system === 'theory-dfs-v1');
  const v3 = allResults.filter(r => r.system === 'theory-dfs-v3');
  const v3b = allResults.filter(r => r.system === 'theory-dfs-v3b');
  const v3c = allResults.filter(r => r.system === 'theory-dfs-v3c');
  const v2 = allResults.filter(r => r.system === 'theory-dfs-v2a-scaling-only');
  const v2b = allResults.filter(r => r.system === 'theory-dfs-v2b-top5-only');
  const v2c = allResults.filter(r => r.system === 'theory-dfs-v2c-top1-plus-scaling');
  const v4a = allResults.filter(r => r.system === 'theory-dfs-v4a');
  const v4b = allResults.filter(r => r.system === 'theory-dfs-v4b');
  const v4c = allResults.filter(r => r.system === 'theory-dfs-v4c');
  const v5 = allResults.filter(r => r.system === 'theory-dfs-v5-stackmix');
  const v6a = allResults.filter(r => r.system === 'theory-dfs-v6a');
  const v6b = allResults.filter(r => r.system === 'theory-dfs-v6b');
  const v6c = allResults.filter(r => r.system === 'theory-dfs-v6c');
  const v6d = allResults.filter(r => r.system === 'theory-dfs-v6d');
  const v7 = allResults.filter(r => r.system === 'theory-dfs-v7-bringback');
  const v8 = allResults.filter(r => r.system === 'theory-dfs-v8-compound');
  const vLev20 = allResults.filter(r => r.system === 'theory-dfs-vlev20');
  const vLev15 = allResults.filter(r => r.system === 'theory-dfs-vlev15');
  const vLev10 = allResults.filter(r => r.system === 'theory-dfs-vlev10');
  const vLev05 = allResults.filter(r => r.system === 'theory-dfs-vlev05');
  const fees = N * FEE * v1.length;
  const expT1 = 0.01 * N * v1.length;
  const expT01 = 0.001 * N * v1.length;

  function summary(rs: Result[], label: string) {
    const totalPay = rs.reduce((s, r) => s + r.totalPayout, 0);
    const totalT1 = rs.reduce((s, r) => s + r.t1, 0);
    const totalT01 = rs.reduce((s, r) => s + r.t01, 0);
    const mahals = rs.map(r => r.mahal).filter((x): x is number => x !== null);
    const meanMahal = mean(mahals);
    const meanProj = mean(rs.map(r => r.avgProj));
    const meanOwn = mean(rs.map(r => r.avgOwn));
    return { label, totalPay, roi: totalPay / fees - 1, totalT1, totalT01, meanMahal, meanProj, meanOwn, t1Edge: totalT1 / expT1, t01Edge: totalT01 / expT01 };
  }
  const sV1 = summary(v1, 'V1');
  const sV3 = summary(v3, 'V3');
  const sV3b = summary(v3b, 'V3b');
  const sV3c = summary(v3c, 'V3c');
  const sV2a = summary(v2, 'V2a');
  const sV2b = summary(v2b, 'V2b');
  const sV2c = summary(v2c, 'V2c');
  const sV4a = summary(v4a, 'V4a');
  const sV4b = summary(v4b, 'V4b');
  const sV4c = summary(v4c, 'V4c');
  const sV5 = summary(v5, 'V5');
  const sV6a = summary(v6a, 'V6a');
  const sV6b = summary(v6b, 'V6b');
  const sV6c = summary(v6c, 'V6c');
  const sV6d = summary(v6d, 'V6d');
  const sV7 = summary(v7, 'V7');
  const sV8 = summary(v8, 'V8');
  const sVLev20 = summary(vLev20, 'VLev20');
  const sVLev15 = summary(vLev15, 'VLev15');
  const sVLev10 = summary(vLev10, 'VLev10');
  const sVLev05 = summary(vLev05, 'VLev05');

  function passOrFail(variant: ReturnType<typeof summary>, baseline: ReturnType<typeof summary>): { mahal: string; t1: string; t01: string; verdict: string } {
    const mahalImproved = variant.meanMahal < baseline.meanMahal - 0.05;
    const t1Maintained = variant.t1Edge >= baseline.t1Edge - 0.05;
    const t01Maintained = variant.t01Edge >= baseline.t01Edge - 0.05;
    const allPass = mahalImproved && t1Maintained && t01Maintained;
    return {
      mahal: mahalImproved ? 'PASS (improved)' : 'FAIL',
      t1: t1Maintained ? 'PASS' : 'FAIL',
      t01: t01Maintained ? 'PASS' : 'FAIL',
      verdict: allPass ? '*** SHIP CANDIDATE ***' : '(rejected)',
    };
  }
  const verdictA = passOrFail(sV2a, sV1);
  const verdictB = passOrFail(sV2b, sV1);
  const verdictC = passOrFail(sV2c, sV1);
  const verdictV3 = passOrFail(sV3, sV1);
  const verdictV3b = passOrFail(sV3b, sV1);
  const verdictV3c = passOrFail(sV3c, sV1);

  console.log('Comparison vs V1 baseline:');
  console.log('Metric                      | V1          | V3          | V2a         | V2b         | V2c         ');
  console.log('-'.repeat(105));
  console.log(`Total ROI                   | ${(sV1.roi*100).toFixed(1).padStart(8)}%   | ${(sV3.roi*100).toFixed(1).padStart(8)}%   | ${(sV2a.roi*100).toFixed(1).padStart(8)}%   | ${(sV2b.roi*100).toFixed(1).padStart(8)}%   | ${(sV2c.roi*100).toFixed(1).padStart(8)}%   `);
  console.log(`Top-1% hits                 | ${String(sV1.totalT1).padStart(11)} | ${String(sV3.totalT1).padStart(11)} | ${String(sV2a.totalT1).padStart(11)} | ${String(sV2b.totalT1).padStart(11)} | ${String(sV2c.totalT1).padStart(11)}`);
  console.log(`Top-1% x random             | ${sV1.t1Edge.toFixed(2).padStart(10)}x | ${sV3.t1Edge.toFixed(2).padStart(10)}x | ${sV2a.t1Edge.toFixed(2).padStart(10)}x | ${sV2b.t1Edge.toFixed(2).padStart(10)}x | ${sV2c.t1Edge.toFixed(2).padStart(10)}x`);
  console.log(`Top-0.1% hits               | ${String(sV1.totalT01).padStart(11)} | ${String(sV3.totalT01).padStart(11)} | ${String(sV2a.totalT01).padStart(11)} | ${String(sV2b.totalT01).padStart(11)} | ${String(sV2c.totalT01).padStart(11)}`);
  console.log(`Top-0.1% x random           | ${sV1.t01Edge.toFixed(2).padStart(10)}x | ${sV3.t01Edge.toFixed(2).padStart(10)}x | ${sV2a.t01Edge.toFixed(2).padStart(10)}x | ${sV2b.t01Edge.toFixed(2).padStart(10)}x | ${sV2c.t01Edge.toFixed(2).padStart(10)}x`);
  console.log(`Mean Mahalanobis to pros    | ${sV1.meanMahal.toFixed(2).padStart(11)} | ${sV3.meanMahal.toFixed(2).padStart(11)} | ${sV2a.meanMahal.toFixed(2).padStart(11)} | ${sV2b.meanMahal.toFixed(2).padStart(11)} | ${sV2c.meanMahal.toFixed(2).padStart(11)}`);
  console.log('');
  console.log('Variant            | Mahal pass?       | t1 pass? | t01 pass? | Verdict');
  console.log('-'.repeat(85));
  console.log(`V3  (W=0.05)       | mahal=${sV3.meanMahal.toFixed(2)}  t1=${sV3.t1Edge.toFixed(2)}x  t01=${sV3.t01Edge.toFixed(2)}x  | ${verdictV3.verdict}`);
  console.log(`V3b (W=0.03)       | mahal=${sV3b.meanMahal.toFixed(2)}  t1=${sV3b.t1Edge.toFixed(2)}x  t01=${sV3b.t01Edge.toFixed(2)}x  | ${verdictV3b.verdict}`);
  console.log(`V3c (W=0.04)       | mahal=${sV3c.meanMahal.toFixed(2)}  t1=${sV3c.t1Edge.toFixed(2)}x  t01=${sV3c.t01Edge.toFixed(2)}x  | ${verdictV3c.verdict}`);
  console.log(`V2a (scaling only) | ${verdictA.mahal.padEnd(15)} | ${verdictA.t1.padEnd(7)} | ${verdictA.t01.padEnd(8)} | ${verdictA.verdict}`);
  console.log(`V2b (top-5 only)   | ${verdictB.mahal.padEnd(15)} | ${verdictB.t1.padEnd(7)} | ${verdictB.t01.padEnd(8)} | ${verdictB.verdict}`);
  console.log(`V2c (top-1+scale)  | ${verdictC.mahal.padEnd(15)} | ${verdictC.t1.padEnd(7)} | ${verdictC.t01.padEnd(8)} | ${verdictC.verdict}`);
  const verdictV4a = passOrFail(sV4a, sV1);
  const verdictV4b = passOrFail(sV4b, sV1);
  const verdictV4c = passOrFail(sV4c, sV1);
  console.log('');
  console.log('V4 SWEEP — INCREASED COMBO PENALTY (V1 baseline W_CMB=0.25):');
  console.log('Variant            |  W_CMB  |  Mahal  |  AvgProj |  AvgOwn |  t1x  |  t01x | ROI    | Verdict');
  console.log('-'.repeat(100));
  console.log(`V1 baseline        |  0.25   | ${sV1.meanMahal.toFixed(2).padStart(6)} | ${sV1.meanProj.toFixed(2).padStart(8)} | ${(sV1.meanOwn*100).toFixed(2).padStart(6)}% | ${sV1.t1Edge.toFixed(2).padStart(4)}x | ${sV1.t01Edge.toFixed(2).padStart(4)}x | ${(sV1.roi*100).toFixed(1).padStart(5)}% | (baseline)`);
  console.log(`V4a                |  0.40   | ${sV4a.meanMahal.toFixed(2).padStart(6)} | ${sV4a.meanProj.toFixed(2).padStart(8)} | ${(sV4a.meanOwn*100).toFixed(2).padStart(6)}% | ${sV4a.t1Edge.toFixed(2).padStart(4)}x | ${sV4a.t01Edge.toFixed(2).padStart(4)}x | ${(sV4a.roi*100).toFixed(1).padStart(5)}% | ${verdictV4a.verdict}`);
  console.log(`V4b                |  0.55   | ${sV4b.meanMahal.toFixed(2).padStart(6)} | ${sV4b.meanProj.toFixed(2).padStart(8)} | ${(sV4b.meanOwn*100).toFixed(2).padStart(6)}% | ${sV4b.t1Edge.toFixed(2).padStart(4)}x | ${sV4b.t01Edge.toFixed(2).padStart(4)}x | ${(sV4b.roi*100).toFixed(1).padStart(5)}% | ${verdictV4b.verdict}`);
  console.log(`V4c                |  0.70   | ${sV4c.meanMahal.toFixed(2).padStart(6)} | ${sV4c.meanProj.toFixed(2).padStart(8)} | ${(sV4c.meanOwn*100).toFixed(2).padStart(6)}% | ${sV4c.t1Edge.toFixed(2).padStart(4)}x | ${sV4c.t01Edge.toFixed(2).padStart(4)}x | ${(sV4c.roi*100).toFixed(1).padStart(5)}% | ${verdictV4c.verdict}`);
  const verdictV5 = passOrFail(sV5, sV1);
  const verdictV6a = passOrFail(sV6a, sV1);
  const verdictV6b = passOrFail(sV6b, sV1);
  const verdictV6c = passOrFail(sV6c, sV1);
  const verdictV6d = passOrFail(sV6d, sV1);
  const verdictV7 = passOrFail(sV7, sV1);
  console.log('');
  console.log('STRUCTURAL CANDIDATES — V5 (stack-mix), V6 (PPD sweep), V7 (bring-back mandate):');
  console.log('Variant            |  Detail                  |  Mahal  |  AvgProj |  AvgOwn  |  t1x  |  t01x | ROI    | Verdict');
  console.log('-'.repeat(115));
  console.log(`V1 baseline        |  -                       | ${sV1.meanMahal.toFixed(2).padStart(6)} | ${sV1.meanProj.toFixed(2).padStart(8)} | ${(sV1.meanOwn*100).toFixed(2).padStart(7)}% | ${sV1.t1Edge.toFixed(2).padStart(4)}x | ${sV1.t01Edge.toFixed(2).padStart(4)}x | ${(sV1.roi*100).toFixed(1).padStart(5)}% | (baseline)`);
  console.log(`V5 stack-mix       |  68/24/8 5/4/3-3 mandate | ${sV5.meanMahal.toFixed(2).padStart(6)} | ${sV5.meanProj.toFixed(2).padStart(8)} | ${(sV5.meanOwn*100).toFixed(2).padStart(7)}% | ${sV5.t1Edge.toFixed(2).padStart(4)}x | ${sV5.t01Edge.toFixed(2).padStart(4)}x | ${(sV5.roi*100).toFixed(1).padStart(5)}% | ${verdictV5.verdict}`);
  console.log(`V6a PPD            |  thresh=10% pen=20%      | ${sV6a.meanMahal.toFixed(2).padStart(6)} | ${sV6a.meanProj.toFixed(2).padStart(8)} | ${(sV6a.meanOwn*100).toFixed(2).padStart(7)}% | ${sV6a.t1Edge.toFixed(2).padStart(4)}x | ${sV6a.t01Edge.toFixed(2).padStart(4)}x | ${(sV6a.roi*100).toFixed(1).padStart(5)}% | ${verdictV6a.verdict}`);
  console.log(`V6b PPD            |  thresh=15% pen=20%      | ${sV6b.meanMahal.toFixed(2).padStart(6)} | ${sV6b.meanProj.toFixed(2).padStart(8)} | ${(sV6b.meanOwn*100).toFixed(2).padStart(7)}% | ${sV6b.t1Edge.toFixed(2).padStart(4)}x | ${sV6b.t01Edge.toFixed(2).padStart(4)}x | ${(sV6b.roi*100).toFixed(1).padStart(5)}% | ${verdictV6b.verdict}`);
  console.log(`V6c PPD            |  thresh=10% pen=30%      | ${sV6c.meanMahal.toFixed(2).padStart(6)} | ${sV6c.meanProj.toFixed(2).padStart(8)} | ${(sV6c.meanOwn*100).toFixed(2).padStart(7)}% | ${sV6c.t1Edge.toFixed(2).padStart(4)}x | ${sV6c.t01Edge.toFixed(2).padStart(4)}x | ${(sV6c.roi*100).toFixed(1).padStart(5)}% | ${verdictV6c.verdict}`);
  console.log(`V6d PPD            |  thresh=5%  pen=20%      | ${sV6d.meanMahal.toFixed(2).padStart(6)} | ${sV6d.meanProj.toFixed(2).padStart(8)} | ${(sV6d.meanOwn*100).toFixed(2).padStart(7)}% | ${sV6d.t1Edge.toFixed(2).padStart(4)}x | ${sV6d.t01Edge.toFixed(2).padStart(4)}x | ${(sV6d.roi*100).toFixed(1).padStart(5)}% | ${verdictV6d.verdict}`);
  console.log(`V7 bring-back      |  60% BB>=1 / 30% BB>=2   | ${sV7.meanMahal.toFixed(2).padStart(6)} | ${sV7.meanProj.toFixed(2).padStart(8)} | ${(sV7.meanOwn*100).toFixed(2).padStart(7)}% | ${sV7.t1Edge.toFixed(2).padStart(4)}x | ${sV7.t01Edge.toFixed(2).padStart(4)}x | ${(sV7.roi*100).toFixed(1).padStart(5)}% | ${verdictV7.verdict}`);
  const verdictV8 = passOrFail(sV8, sV1);
  console.log(`V8 V4a+V6d combo   |  W_CMB=0.40 + PPD 5/20   | ${sV8.meanMahal.toFixed(2).padStart(6)} | ${sV8.meanProj.toFixed(2).padStart(8)} | ${(sV8.meanOwn*100).toFixed(2).padStart(7)}% | ${sV8.t1Edge.toFixed(2).padStart(4)}x | ${sV8.t01Edge.toFixed(2).padStart(4)}x | ${(sV8.roi*100).toFixed(1).padStart(5)}% | ${verdictV8.verdict}`);

  // === V1.1 W_LEV SWEEP ===
  // Methodology: single-parameter optimization. Target metric is BAND DISTRIBUTION match to pros (38/13/16/33), not ROI.
  // Compute band distribution per variant using same logic as T8 analyzer (in-line).
  // Pro band targets from T8 analysis:
  //   HighProj/HighOwn 38.3%, HighProj/LowOwn 12.9%, LowProj/HighOwn 15.9%, LowProj/LowOwn 32.9%
  function computeBandDist(slatesData: any[], variantKey: string): { hpHo: number; hpLo: number; lpHo: number; lpLo: number } {
    let hpHo = 0, hpLo = 0, lpHo = 0, lpLo = 0, total = 0;
    for (const s of slatesData) {
      const variantLus = s[variantKey];
      const pros = s.pros;
      if (!variantLus || !pros || variantLus.length === 0 || pros.length === 0) continue;
      const allLus = [...variantLus, ...pros];
      const projs = allLus.map((lu: any) => lu.projection).sort((a: number, b: number) => a - b);
      const owns = allLus.map((lu: any) => lu.geoMeanOwnHit || 0).sort((a: number, b: number) => a - b);
      const medProj = projs[Math.floor(projs.length / 2)];
      const medOwn = owns[Math.floor(owns.length / 2)];
      for (const lu of variantLus) {
        const hp = lu.projection >= medProj;
        const ho = (lu.geoMeanOwnHit || 0) >= medOwn;
        if (hp && ho) hpHo++;
        else if (hp && !ho) hpLo++;
        else if (!hp && ho) lpHo++;
        else lpLo++;
        total++;
      }
    }
    return total === 0 ? { hpHo: 0, hpLo: 0, lpHo: 0, lpLo: 0 } :
           { hpHo: hpHo / total * 100, hpLo: hpLo / total * 100, lpHo: lpHo / total * 100, lpLo: lpLo / total * 100 };
  }
  function bandDistForResult(rs: Result[]): { hpHo: number; hpLo: number; lpHo: number; lpLo: number } {
    // For variants we didn't dump, return placeholder (computed via dumpAll for V1 + V_LEV).
    return { hpHo: 0, hpLo: 0, lpHo: 0, lpLo: 0 };
  }
  // Compute pro band dist (target).
  let pHpHo = 0, pHpLo = 0, pLpHo = 0, pLpLo = 0, pT = 0;
  for (const sl of dumpAll) {
    const all = [...sl.v1, ...sl.pros];
    if (all.length === 0) continue;
    const projs = all.map((lu: any) => lu.projection).sort((a: number, b: number) => a - b);
    const owns = all.map((lu: any) => lu.geoMeanOwnHit || 0).sort((a: number, b: number) => a - b);
    const mp = projs[Math.floor(projs.length / 2)]; const mo = owns[Math.floor(owns.length / 2)];
    for (const lu of sl.pros) {
      const hp = lu.projection >= mp; const ho = (lu.geoMeanOwnHit || 0) >= mo;
      if (hp && ho) pHpHo++; else if (hp && !ho) pHpLo++; else if (!hp && ho) pLpHo++; else pLpLo++;
      pT++;
    }
  }
  const proBand = pT === 0 ? { hpHo: 0, hpLo: 0, lpHo: 0, lpLo: 0 } :
    { hpHo: pHpHo / pT * 100, hpLo: pHpLo / pT * 100, lpHo: pLpHo / pT * 100, lpLo: pLpLo / pT * 100 };
  const v1Band = computeBandDist(dumpAll, 'v1');
  const vLev20Band = computeBandDist(dumpAll, 'vLev20');
  const vLev15Band = computeBandDist(dumpAll, 'vLev15');
  const vLev10Band = computeBandDist(dumpAll, 'vLev10');
  const vLev05Band = computeBandDist(dumpAll, 'vLev05');
  // Distance from pro band targets (sum of absolute differences across 4 buckets — lower = closer to pros).
  function bandDist(b: { hpHo: number; hpLo: number; lpHo: number; lpLo: number }): number {
    return Math.abs(b.hpHo - proBand.hpHo) + Math.abs(b.hpLo - proBand.hpLo) +
           Math.abs(b.lpHo - proBand.lpHo) + Math.abs(b.lpLo - proBand.lpLo);
  }

  console.log('');
  console.log('=== V1.1 W_LEV SINGLE-PARAMETER SWEEP (PARK CANDIDATE — DO NOT DEPLOY) ===');
  console.log('Target: band distribution match to pros (' + proBand.hpHo.toFixed(1) + '/' + proBand.hpLo.toFixed(1) + '/' + proBand.lpHo.toFixed(1) + '/' + proBand.lpLo.toFixed(1) + '). NOT optimizing for ROI.');
  console.log('');
  console.log('Variant | W_LEV | HP/HO  | HP/LO  | LP/HO  | LP/LO  | Δ-band | Mahal  | t1x   | t01x  | ROI');
  console.log('-'.repeat(110));
  function lvlRow(label: string, wl: string, b: { hpHo: number; hpLo: number; lpHo: number; lpLo: number }, s: ReturnType<typeof summary>): string {
    return `${label.padEnd(8)} | ${wl.padStart(5)} | ${b.hpHo.toFixed(1).padStart(5)}% | ${b.hpLo.toFixed(1).padStart(5)}% | ${b.lpHo.toFixed(1).padStart(5)}% | ${b.lpLo.toFixed(1).padStart(5)}% | ${bandDist(b).toFixed(1).padStart(5)} | ${s.meanMahal.toFixed(2).padStart(5)} | ${s.t1Edge.toFixed(2).padStart(4)}x | ${s.t01Edge.toFixed(2).padStart(4)}x | ${(s.roi*100).toFixed(1).padStart(5)}%`;
  }
  console.log(`Pros     |   --  | ${proBand.hpHo.toFixed(1).padStart(5)}% | ${proBand.hpLo.toFixed(1).padStart(5)}% | ${proBand.lpHo.toFixed(1).padStart(5)}% | ${proBand.lpLo.toFixed(1).padStart(5)}% |   0.0 |   --  |   --  |   --  |    --`);
  console.log(lvlRow('V1', '0.30', v1Band, sV1));
  console.log(lvlRow('VLev20', '0.20', vLev20Band, sVLev20));
  console.log(lvlRow('VLev15', '0.15', vLev15Band, sVLev15));
  console.log(lvlRow('VLev10', '0.10', vLev10Band, sVLev10));
  console.log(lvlRow('VLev05', '0.05', vLev05Band, sVLev05));
  console.log('');
  console.log('Lower Δ-band = closer to pro distribution. Optimal Δ-band identifies V1.1 candidate.');

  // === V1-ProjEmphasis descriptive run (16 dev slates only) ===
  // The 16 dev slates are everything EXCEPT the 8 holdout slates from slate_derived_research.
  // Holdout: 4-6-26, 4-14-26, 4-15-26, 4-19-26, 4-20-26, 5-1-26, 5-2-26, 5-2-26-night
  const HOLDOUT = new Set(['4-6-26', '4-14-26', '4-15-26', '4-19-26', '4-20-26', '5-1-26', '5-2-26', '5-2-26-night']);
  const devDump = dumpAll.filter(s => !HOLDOUT.has(s.slate));
  console.log('');
  console.log('=== V1-ProjEmphasis (W_PROJ × 1.25) — DESCRIPTIVE on 16 dev slates ===');
  console.log('NOT a deploy candidate. NOT a selection. Park alongside V1.1.');
  console.log(`Dev slates analyzed: ${devDump.length} (holdout sealed)`);

  // Compute band distribution for V1 vs V1-ProjEmpha vs pros on dev only.
  function bandDistDev(variantKey: string): { hpHo: number; hpLo: number; lpHo: number; lpLo: number } {
    let hpHo = 0, hpLo = 0, lpHo = 0, lpLo = 0, total = 0;
    for (const s of devDump) {
      const variantLus = s[variantKey];
      const pros = s.pros;
      if (!variantLus || !pros || variantLus.length === 0 || pros.length === 0) continue;
      const allLus = [...variantLus, ...pros];
      const projs = allLus.map((lu: any) => lu.projection).sort((a: number, b: number) => a - b);
      const owns = allLus.map((lu: any) => lu.geoMeanOwnHit || 0).sort((a: number, b: number) => a - b);
      const medProj = projs[Math.floor(projs.length / 2)];
      const medOwn = owns[Math.floor(owns.length / 2)];
      for (const lu of variantLus) {
        const hp = lu.projection >= medProj;
        const ho = (lu.geoMeanOwnHit || 0) >= medOwn;
        if (hp && ho) hpHo++;
        else if (hp && !ho) hpLo++;
        else if (!hp && ho) lpHo++;
        else lpLo++;
        total++;
      }
    }
    return total === 0 ? { hpHo: 0, hpLo: 0, lpHo: 0, lpLo: 0 } :
           { hpHo: hpHo / total * 100, hpLo: hpLo / total * 100, lpHo: lpHo / total * 100, lpLo: lpLo / total * 100 };
  }
  let pHpHo2 = 0, pHpLo2 = 0, pLpHo2 = 0, pLpLo2 = 0, pT2 = 0;
  for (const sl of devDump) {
    const all = [...sl.v1, ...sl.pros];
    if (all.length === 0) continue;
    const projs = all.map((lu: any) => lu.projection).sort((a: number, b: number) => a - b);
    const owns = all.map((lu: any) => lu.geoMeanOwnHit || 0).sort((a: number, b: number) => a - b);
    const mp = projs[Math.floor(projs.length / 2)]; const mo = owns[Math.floor(owns.length / 2)];
    for (const lu of sl.pros) {
      const hp = lu.projection >= mp; const ho = (lu.geoMeanOwnHit || 0) >= mo;
      if (hp && ho) pHpHo2++; else if (hp && !ho) pHpLo2++; else if (!hp && ho) pLpHo2++; else pLpLo2++;
      pT2++;
    }
  }
  const proBandDev = pT2 === 0 ? { hpHo: 0, hpLo: 0, lpHo: 0, lpLo: 0 } :
    { hpHo: pHpHo2 / pT2 * 100, hpLo: pHpLo2 / pT2 * 100, lpHo: pLpHo2 / pT2 * 100, lpLo: pLpLo2 / pT2 * 100 };
  const v1BandDev = bandDistDev('v1');
  const projEmphaBandDev = bandDistDev('vProjEmpha');

  console.log('');
  console.log('Band distribution (HP/HO, HP/LO, LP/HO, LP/LO):');
  console.log(`  Pros (target):  ${proBandDev.hpHo.toFixed(1)}%  /  ${proBandDev.hpLo.toFixed(1)}%  /  ${proBandDev.lpHo.toFixed(1)}%  /  ${proBandDev.lpLo.toFixed(1)}%`);
  console.log(`  V1 baseline:    ${v1BandDev.hpHo.toFixed(1)}%  /  ${v1BandDev.hpLo.toFixed(1)}%  /  ${v1BandDev.lpHo.toFixed(1)}%  /  ${v1BandDev.lpLo.toFixed(1)}%`);
  console.log(`  V1-ProjEmpha:   ${projEmphaBandDev.hpHo.toFixed(1)}%  /  ${projEmphaBandDev.hpLo.toFixed(1)}%  /  ${projEmphaBandDev.lpHo.toFixed(1)}%  /  ${projEmphaBandDev.lpLo.toFixed(1)}%`);

  // Tournament metrics on dev set.
  const v1Dev = v1.filter(r => !HOLDOUT.has(r.slate));
  const projEmphaDev = allResults.filter(r => r.system === 'theory-dfs-vprojempha' && !HOLDOUT.has(r.slate));
  function devSummary(rs: Result[]) {
    const totalT1 = rs.reduce((s, r) => s + r.t1, 0);
    const totalT01 = rs.reduce((s, r) => s + r.t01, 0);
    const totalPay = rs.reduce((s, r) => s + r.totalPayout, 0);
    const expT1 = 0.01 * N * rs.length;
    const expT01 = 0.001 * N * rs.length;
    const fees = N * FEE * rs.length;
    const mahals = rs.map(r => r.mahal).filter((x): x is number => x !== null);
    return {
      t1Edge: expT1 > 0 ? totalT1 / expT1 : 0,
      t01Edge: expT01 > 0 ? totalT01 / expT01 : 0,
      roi: fees > 0 ? totalPay / fees - 1 : 0,
      meanMahal: mean(mahals),
      meanProj: mean(rs.map(r => r.avgProj)),
      meanOwn: mean(rs.map(r => r.avgOwn)),
    };
  }
  const v1DevSum = devSummary(v1Dev);
  const projEmphaDevSum = devSummary(projEmphaDev);
  console.log('');
  console.log('Tournament + structural metrics (16 dev slates):');
  console.log(`  Metric         | V1 baseline | V1-ProjEmpha | Δ`);
  console.log(`  Mahal          | ${v1DevSum.meanMahal.toFixed(2).padStart(11)} | ${projEmphaDevSum.meanMahal.toFixed(2).padStart(12)} | ${(projEmphaDevSum.meanMahal - v1DevSum.meanMahal).toFixed(2)}`);
  console.log(`  AvgProj        | ${v1DevSum.meanProj.toFixed(2).padStart(11)} | ${projEmphaDevSum.meanProj.toFixed(2).padStart(12)} | ${(projEmphaDevSum.meanProj - v1DevSum.meanProj).toFixed(2)}`);
  console.log(`  AvgOwn         | ${(v1DevSum.meanOwn*100).toFixed(2).padStart(10)}% | ${(projEmphaDevSum.meanOwn*100).toFixed(2).padStart(11)}% | ${((projEmphaDevSum.meanOwn - v1DevSum.meanOwn)*100).toFixed(2)}pp`);
  console.log(`  t1×            | ${v1DevSum.t1Edge.toFixed(2).padStart(10)}× | ${projEmphaDevSum.t1Edge.toFixed(2).padStart(11)}× | ${(projEmphaDevSum.t1Edge - v1DevSum.t1Edge).toFixed(2)}`);
  console.log(`  t01×           | ${v1DevSum.t01Edge.toFixed(2).padStart(10)}× | ${projEmphaDevSum.t01Edge.toFixed(2).padStart(11)}× | ${(projEmphaDevSum.t01Edge - v1DevSum.t01Edge).toFixed(2)}`);
  console.log(`  ROI            | ${(v1DevSum.roi*100).toFixed(1).padStart(10)}% | ${(projEmphaDevSum.roi*100).toFixed(1).padStart(11)}% | ${((projEmphaDevSum.roi - v1DevSum.roi)*100).toFixed(1)}pp`);
  console.log('');
  console.log('Descriptive output. No deploy decision. Park alongside V1.1 (W_LEV=0.15) candidate.');

  // === V1-NoLowProjHighOwn descriptive run (16 dev slates only) ===
  const noLPHOBandDev = bandDistDev('vNoLPHO');
  console.log('');
  console.log('=== V1-NoLowProjHighOwn (hard 0% LP/HO band) — DESCRIPTIVE on 16 dev slates ===');
  console.log('NOT a deploy candidate. NOT a selection. Park alongside V1.1 + V1-ProjEmpha.');
  console.log('');
  console.log('Band distribution (HP/HO, HP/LO, LP/HO, LP/LO):');
  console.log(`  Pros (target):      ${proBandDev.hpHo.toFixed(1)}%  /  ${proBandDev.hpLo.toFixed(1)}%  /  ${proBandDev.lpHo.toFixed(1)}%  /  ${proBandDev.lpLo.toFixed(1)}%`);
  console.log(`  V1 baseline:        ${v1BandDev.hpHo.toFixed(1)}%  /  ${v1BandDev.hpLo.toFixed(1)}%  /  ${v1BandDev.lpHo.toFixed(1)}%  /  ${v1BandDev.lpLo.toFixed(1)}%`);
  console.log(`  V1-NoLPHO:          ${noLPHOBandDev.hpHo.toFixed(1)}%  /  ${noLPHOBandDev.hpLo.toFixed(1)}%  /  ${noLPHOBandDev.lpHo.toFixed(1)}%  /  ${noLPHOBandDev.lpLo.toFixed(1)}%`);
  // Predicted redistribution: 26 / 20.8 / 0 / 52.1 (approximately)
  console.log(`  Predicted (proportional):  26.0%  /  20.8%  /   0.0%  /  52.1%`);

  const noLPHODev = allResults.filter(r => r.system === 'theory-dfs-vnolpho' && !HOLDOUT.has(r.slate));
  const noLPHODevSum = devSummary(noLPHODev);
  console.log('');
  console.log('Tournament + structural metrics (16 dev slates):');
  console.log(`  Metric         | V1 baseline | V1-NoLPHO    | Δ`);
  console.log(`  Mahal          | ${v1DevSum.meanMahal.toFixed(2).padStart(11)} | ${noLPHODevSum.meanMahal.toFixed(2).padStart(12)} | ${(noLPHODevSum.meanMahal - v1DevSum.meanMahal).toFixed(2)}`);
  console.log(`  AvgProj        | ${v1DevSum.meanProj.toFixed(2).padStart(11)} | ${noLPHODevSum.meanProj.toFixed(2).padStart(12)} | ${(noLPHODevSum.meanProj - v1DevSum.meanProj).toFixed(2)}`);
  console.log(`  AvgOwn (sum)   | ${(v1DevSum.meanOwn).toFixed(2).padStart(11)} | ${(noLPHODevSum.meanOwn).toFixed(2).padStart(12)} | ${(noLPHODevSum.meanOwn - v1DevSum.meanOwn).toFixed(2)}`);
  console.log(`  t1×            | ${v1DevSum.t1Edge.toFixed(2).padStart(10)}× | ${noLPHODevSum.t1Edge.toFixed(2).padStart(11)}× | ${(noLPHODevSum.t1Edge - v1DevSum.t1Edge).toFixed(2)}`);
  console.log(`  t01×           | ${v1DevSum.t01Edge.toFixed(2).padStart(10)}× | ${noLPHODevSum.t01Edge.toFixed(2).padStart(11)}× | ${(noLPHODevSum.t01Edge - v1DevSum.t01Edge).toFixed(2)}`);
  console.log(`  ROI            | ${(v1DevSum.roi*100).toFixed(1).padStart(10)}% | ${(noLPHODevSum.roi*100).toFixed(1).padStart(11)}% | ${((noLPHODevSum.roi - v1DevSum.roi)*100).toFixed(1)}pp`);

  // Inverse-bell shape on dev only.
  function devShape(sys: string): { top: number; mid: number; bot: number; ratio: number } {
    const rs = allResults.filter(r => r.system === sys && !HOLDOUT.has(r.slate));
    const all: number[] = [];
    for (const r of rs) all.push(...r.finishPctiles);
    if (all.length === 0) return { top: 0, mid: 0, bot: 0, ratio: 0 };
    const buckets = new Array(5).fill(0);
    for (const v of all) buckets[Math.min(4, Math.floor((1 - v) * 5))]++;
    const pcts = buckets.map(c => c / all.length * 100);
    return { top: pcts[0], mid: pcts[2], bot: pcts[4], ratio: (pcts[0] + pcts[4]) / 2 / Math.max(0.01, pcts[2]) };
  }
  const v1Shape = devShape('theory-dfs-v1');
  const noLPHOShape = devShape('theory-dfs-vnolpho');
  console.log('');
  console.log('Finishing distribution (quintile shape, dev only):');
  console.log(`  V1 baseline:  top=${v1Shape.top.toFixed(1)}% mid=${v1Shape.mid.toFixed(1)}% bot=${v1Shape.bot.toFixed(1)}% inv-bell ratio=${v1Shape.ratio.toFixed(2)}`);
  console.log(`  V1-NoLPHO:    top=${noLPHOShape.top.toFixed(1)}% mid=${noLPHOShape.mid.toFixed(1)}% bot=${noLPHOShape.bot.toFixed(1)}% inv-bell ratio=${noLPHOShape.ratio.toFixed(2)}`);

  // Second-order: stack distribution, bring-back rate, salary on dev.
  function secondOrder(variantKey: string): { stack5: number; stack4: number; stack3: number; bbAvg: number; salaryAvg: number } {
    let s5 = 0, s4 = 0, s3 = 0, bb = 0, sal = 0, n = 0;
    for (const sl of devDump) {
      const lus = sl[variantKey];
      if (!lus) continue;
      for (const lu of lus) {
        const ps = lu.primarySize || 0;
        if (ps >= 5) s5++; else if (ps === 4) s4++; else if (ps === 3) s3++;
        bb += lu.bringBack || 0;
        sal += lu.salaryTotal || 0;
        n++;
      }
    }
    return n === 0 ? { stack5: 0, stack4: 0, stack3: 0, bbAvg: 0, salaryAvg: 0 } :
           { stack5: s5 / n * 100, stack4: s4 / n * 100, stack3: s3 / n * 100, bbAvg: bb / n, salaryAvg: sal / n };
  }
  const v1SO = secondOrder('v1');
  const noLPHOSO = secondOrder('vNoLPHO');
  console.log('');
  console.log('Second-order effects (dev only):');
  console.log(`  Metric          | V1            | V1-NoLPHO     | Δ`);
  console.log(`  5+ stack %      | ${v1SO.stack5.toFixed(1).padStart(13)}% | ${noLPHOSO.stack5.toFixed(1).padStart(13)}% | ${(noLPHOSO.stack5 - v1SO.stack5).toFixed(1)}pp`);
  console.log(`  4 stack %       | ${v1SO.stack4.toFixed(1).padStart(13)}% | ${noLPHOSO.stack4.toFixed(1).padStart(13)}% | ${(noLPHOSO.stack4 - v1SO.stack4).toFixed(1)}pp`);
  console.log(`  3 stack %       | ${v1SO.stack3.toFixed(1).padStart(13)}% | ${noLPHOSO.stack3.toFixed(1).padStart(13)}% | ${(noLPHOSO.stack3 - v1SO.stack3).toFixed(1)}pp`);
  console.log(`  Avg bring-back  | ${v1SO.bbAvg.toFixed(2).padStart(13)}  | ${noLPHOSO.bbAvg.toFixed(2).padStart(13)}  | ${(noLPHOSO.bbAvg - v1SO.bbAvg).toFixed(2)}`);
  console.log(`  Avg salary $    | ${v1SO.salaryAvg.toFixed(0).padStart(13)}  | ${noLPHOSO.salaryAvg.toFixed(0).padStart(13)}  | ${(noLPHOSO.salaryAvg - v1SO.salaryAvg).toFixed(0)}`);
  console.log('');
  console.log('Descriptive output. No deploy decision. Park.');

  // === V1-NaturalCorr (halved stack bonus + zeroed bring-backs) — DESCRIPTIVE on 16 dev slates ===
  const natCorrBandDev = bandDistDev('vNatCorr');
  const natCorrDev = allResults.filter(r => r.system === 'theory-dfs-vnatcorr' && !HOLDOUT.has(r.slate));
  const natCorrDevSum = devSummary(natCorrDev);
  const natCorrShape = devShape('theory-dfs-vnatcorr');
  const natCorrSO = secondOrder('vNatCorr');
  const proSO = secondOrder('pros');
  console.log('');
  console.log('=== V1-NaturalCorr (STACK_BONUS=0.05, BB1=0, BB2=0) — DESCRIPTIVE on 16 dev slates ===');
  console.log('Hypothesis: V1 over-forces correlation. Pros use 80% naked, 22% 4-stacks; V1 uses 4% naked, 0% 4-stacks.');
  console.log('Halving STACK_BONUS and zeroing BB lets stack-mix and BB-rate emerge from EV ranking alone.');
  console.log('');
  console.log('Band distribution (HP/HO, HP/LO, LP/HO, LP/LO):');
  console.log(`  Pros (target):       ${proBandDev.hpHo.toFixed(1)}%  /  ${proBandDev.hpLo.toFixed(1)}%  /  ${proBandDev.lpHo.toFixed(1)}%  /  ${proBandDev.lpLo.toFixed(1)}%`);
  console.log(`  V1 baseline:         ${v1BandDev.hpHo.toFixed(1)}%  /  ${v1BandDev.hpLo.toFixed(1)}%  /  ${v1BandDev.lpHo.toFixed(1)}%  /  ${v1BandDev.lpLo.toFixed(1)}%`);
  console.log(`  V1-NaturalCorr:      ${natCorrBandDev.hpHo.toFixed(1)}%  /  ${natCorrBandDev.hpLo.toFixed(1)}%  /  ${natCorrBandDev.lpHo.toFixed(1)}%  /  ${natCorrBandDev.lpLo.toFixed(1)}%`);
  console.log('');
  console.log('Stack + bring-back composition (target = pros):');
  console.log(`  Metric          | Pros          | V1            | V1-NatCorr    | Δ (NatCorr−V1)`);
  console.log(`  5+ stack %      | ${proSO.stack5.toFixed(1).padStart(13)}% | ${v1SO.stack5.toFixed(1).padStart(13)}% | ${natCorrSO.stack5.toFixed(1).padStart(13)}% | ${(natCorrSO.stack5 - v1SO.stack5).toFixed(1)}pp`);
  console.log(`  4 stack %       | ${proSO.stack4.toFixed(1).padStart(13)}% | ${v1SO.stack4.toFixed(1).padStart(13)}% | ${natCorrSO.stack4.toFixed(1).padStart(13)}% | ${(natCorrSO.stack4 - v1SO.stack4).toFixed(1)}pp`);
  console.log(`  Avg bring-back  | ${proSO.bbAvg.toFixed(2).padStart(13)}  | ${v1SO.bbAvg.toFixed(2).padStart(13)}  | ${natCorrSO.bbAvg.toFixed(2).padStart(13)}  | ${(natCorrSO.bbAvg - v1SO.bbAvg).toFixed(2)}`);
  console.log('');
  console.log('Tournament + structural metrics:');
  console.log(`  Metric         | V1 baseline | V1-NatCorr   | Δ`);
  console.log(`  Mahal          | ${v1DevSum.meanMahal.toFixed(2).padStart(11)} | ${natCorrDevSum.meanMahal.toFixed(2).padStart(12)} | ${(natCorrDevSum.meanMahal - v1DevSum.meanMahal).toFixed(2)}`);
  console.log(`  AvgProj        | ${v1DevSum.meanProj.toFixed(2).padStart(11)} | ${natCorrDevSum.meanProj.toFixed(2).padStart(12)} | ${(natCorrDevSum.meanProj - v1DevSum.meanProj).toFixed(2)}`);
  console.log(`  AvgOwn (sum)   | ${(v1DevSum.meanOwn).toFixed(2).padStart(11)} | ${(natCorrDevSum.meanOwn).toFixed(2).padStart(12)} | ${(natCorrDevSum.meanOwn - v1DevSum.meanOwn).toFixed(2)}`);
  console.log(`  t1×            | ${v1DevSum.t1Edge.toFixed(2).padStart(10)}× | ${natCorrDevSum.t1Edge.toFixed(2).padStart(11)}× | ${(natCorrDevSum.t1Edge - v1DevSum.t1Edge).toFixed(2)}`);
  console.log(`  t01×           | ${v1DevSum.t01Edge.toFixed(2).padStart(10)}× | ${natCorrDevSum.t01Edge.toFixed(2).padStart(11)}× | ${(natCorrDevSum.t01Edge - v1DevSum.t01Edge).toFixed(2)}`);
  console.log(`  ROI            | ${(v1DevSum.roi*100).toFixed(1).padStart(10)}% | ${(natCorrDevSum.roi*100).toFixed(1).padStart(11)}% | ${((natCorrDevSum.roi - v1DevSum.roi)*100).toFixed(1)}pp`);
  console.log(`  Inv-bell ratio | ${v1Shape.ratio.toFixed(2).padStart(11)} | ${natCorrShape.ratio.toFixed(2).padStart(12)} | ${(natCorrShape.ratio - v1Shape.ratio).toFixed(2)}`);
  console.log('');
  console.log('Descriptive output. Park alongside V1.1, V1-ProjEmpha.');

  // === V1-NoCorr diagnostic — what's holding V1 at 95% 5-stacks? ===
  const noCorrSO = secondOrder('vNoCorr');
  const noCorrDev = allResults.filter(r => r.system === 'theory-dfs-vnocorr' && !HOLDOUT.has(r.slate));
  const noCorrDevSum = devSummary(noCorrDev);
  console.log('');
  console.log('=== V1-NoCorr (STACK_BONUS=0, BB1=0, BB2=0) — DIAGNOSTIC ===');
  console.log('Tests whether corrAdj is the binding constraint on 4-stack rate.');
  console.log('');
  console.log(`  Source            | 5+ stk%  | 4 stk%   | 3 stk%   | BB avg`);
  console.log(`  SaberSim pool     |   68.0%  |   23.1%  |    8.1%  |   ?`);
  console.log(`  Pros              |   66.9%  |   24.8%  |    7.5%  |   0.38`);
  console.log(`  V1 (full corrAdj) |   ${v1SO.stack5.toFixed(1).padStart(5)}%  |   ${v1SO.stack4.toFixed(1).padStart(5)}%  |   ${v1SO.stack3.toFixed(1).padStart(5)}%  |   ${v1SO.bbAvg.toFixed(2)}`);
  console.log(`  V1-NatCorr (½)    |   ${natCorrSO.stack5.toFixed(1).padStart(5)}%  |   ${natCorrSO.stack4.toFixed(1).padStart(5)}%  |   ${natCorrSO.stack3.toFixed(1).padStart(5)}%  |   ${natCorrSO.bbAvg.toFixed(2)}`);
  console.log(`  V1-NoCorr (zero)  |   ${noCorrSO.stack5.toFixed(1).padStart(5)}%  |   ${noCorrSO.stack4.toFixed(1).padStart(5)}%  |   ${noCorrSO.stack3.toFixed(1).padStart(5)}%  |   ${noCorrSO.bbAvg.toFixed(2)}`);
  console.log('');
  console.log(`  V1-NoCorr tournament metrics: t1×=${noCorrDevSum.t1Edge.toFixed(2)} t01×=${noCorrDevSum.t01Edge.toFixed(2)} ROI=${(noCorrDevSum.roi*100).toFixed(1)}%`);
  console.log('');

  // === V1-NoCorr-Sec4: avoid naked 4-stacks via secondary stack bonus ===
  const sec4SO = secondOrder('vNoCorrSec4');
  const sec4Dev = allResults.filter(r => r.system === 'theory-dfs-vnocorrsec4' && !HOLDOUT.has(r.slate));
  const sec4DevSum = devSummary(sec4Dev);
  const sec4BandDev = bandDistDev('vNoCorrSec4');

  // Compute 4-stack secondary-stack composition for both V1-NoCorr and V1-NoCorr-Sec4.
  function fourStackComp(variantKey: string): { pct4_naked: number; pct4_2sec: number; pct4_3sec: number; n4: number } {
    let n4 = 0, naked = 0, sec2 = 0, sec3 = 0;
    for (const sl of devDump) {
      const lus = sl[variantKey];
      if (!lus) continue;
      for (const lu of lus) {
        if ((lu.primarySize || 0) !== 4) continue;
        n4++;
        const ss = lu.secondarySize || 0;
        if (ss <= 1) naked++;
        else if (ss === 2) sec2++;
        else sec3++;
      }
    }
    return n4 === 0 ? { pct4_naked: 0, pct4_2sec: 0, pct4_3sec: 0, n4: 0 } :
      { pct4_naked: naked / n4 * 100, pct4_2sec: sec2 / n4 * 100, pct4_3sec: sec3 / n4 * 100, n4 };
  }
  const noCorrFour = fourStackComp('vNoCorr');
  const sec4Four = fourStackComp('vNoCorrSec4');
  const proFour = fourStackComp('pros');

  console.log('=== V1-NoCorr-Sec4 (NoCorr + 4-stack secondary bonus 0.05 × (sec-1)) ===');
  console.log('Tests whether secondary-stack incentive on 4-stacks promotes 4-2/4-3 structure (vs naked).');
  console.log('');
  console.log(`  Source             | 5+ stk%  | 4 stk%   | BB avg  | 4-stk naked  | 4-stk w/ 2sec | 4-stk w/ 3+sec`);
  console.log(`  Pros               |   66.9%  |   24.8%  |   0.38  | ${proFour.pct4_naked.toFixed(1).padStart(11)}%  | ${proFour.pct4_2sec.toFixed(1).padStart(12)}%  | ${proFour.pct4_3sec.toFixed(1).padStart(13)}%`);
  console.log(`  V1-NoCorr          |   ${noCorrSO.stack5.toFixed(1).padStart(5)}%  |   ${noCorrSO.stack4.toFixed(1).padStart(5)}%  |   ${noCorrSO.bbAvg.toFixed(2)}  | ${noCorrFour.pct4_naked.toFixed(1).padStart(11)}%  | ${noCorrFour.pct4_2sec.toFixed(1).padStart(12)}%  | ${noCorrFour.pct4_3sec.toFixed(1).padStart(13)}%`);
  console.log(`  V1-NoCorr-Sec4     |   ${sec4SO.stack5.toFixed(1).padStart(5)}%  |   ${sec4SO.stack4.toFixed(1).padStart(5)}%  |   ${sec4SO.bbAvg.toFixed(2)}  | ${sec4Four.pct4_naked.toFixed(1).padStart(11)}%  | ${sec4Four.pct4_2sec.toFixed(1).padStart(12)}%  | ${sec4Four.pct4_3sec.toFixed(1).padStart(13)}%`);
  console.log('');
  console.log(`Band: HP/HO  HP/LO  LP/HO  LP/LO`);
  console.log(`  Pros:           ${proBandDev.hpHo.toFixed(1)}%  ${proBandDev.hpLo.toFixed(1)}%  ${proBandDev.lpHo.toFixed(1)}%  ${proBandDev.lpLo.toFixed(1)}%`);
  console.log(`  V1-NoCorr-Sec4: ${sec4BandDev.hpHo.toFixed(1)}%  ${sec4BandDev.hpLo.toFixed(1)}%  ${sec4BandDev.lpHo.toFixed(1)}%  ${sec4BandDev.lpLo.toFixed(1)}%`);
  console.log('');
  console.log(`Tournament metrics (dev): V1-NoCorr-Sec4 t1×=${sec4DevSum.t1Edge.toFixed(2)} t01×=${sec4DevSum.t01Edge.toFixed(2)} ROI=${(sec4DevSum.roi*100).toFixed(1)}%`);
  console.log(`                          V1-NoCorr      t1×=${noCorrDevSum.t1Edge.toFixed(2)} t01×=${noCorrDevSum.t01Edge.toFixed(2)} ROI=${(noCorrDevSum.roi*100).toFixed(1)}%`);
  console.log(`                          V1 baseline    t1×=${v1DevSum.t1Edge.toFixed(2)} t01×=${v1DevSum.t01Edge.toFixed(2)} ROI=${(v1DevSum.roi*100).toFixed(1)}%`);
  console.log('');
  const sV2 = sV2a;  // alias for downstream code that references sV2

  // Finishing distribution decile shape (V1 vs V2).
  function decileShape(rs: Result[]): number[] {
    const all: number[] = [];
    for (const r of rs) all.push(...r.finishPctiles);
    const buckets = new Array(10).fill(0);
    for (const v of all) buckets[Math.min(9, Math.floor((1 - v) * 10))]++;
    return buckets.map(c => c / all.length * 100);
  }
  const dV1 = decileShape(v1);
  const dV2 = decileShape(v2);
  const dV4a = decileShape(v4a);
  const dV5 = decileShape(v5);
  const dV6d = decileShape(v6d);
  const dV7 = decileShape(v7);
  const dV8 = decileShape(v8);
  console.log('\nFinishing distribution (deciles, lower idx = better finish):');
  console.log('Decile  :  TOP1   TOP2   TOP3   TOP4   TOP5   TOP6   TOP7   TOP8   TOP9   BOT1');
  console.log('V1      : ' + dV1.map(p => p.toFixed(1).padStart(5) + '%').join(' '));
  console.log('V4a     : ' + dV4a.map(p => p.toFixed(1).padStart(5) + '%').join(' '));
  console.log('V5      : ' + dV5.map(p => p.toFixed(1).padStart(5) + '%').join(' '));
  console.log('V6d     : ' + dV6d.map(p => p.toFixed(1).padStart(5) + '%').join(' '));
  console.log('V7      : ' + dV7.map(p => p.toFixed(1).padStart(5) + '%').join(' '));
  console.log('V8      : ' + dV8.map(p => p.toFixed(1).padStart(5) + '%').join(' '));
  function shape(d: number[]): { top: number; mid: number; bot: number; label: string; topHeavy: number } {
    const top = d[0]; const mid = d[4] + d[5]; const bot = d[9];
    const label = (top + bot > mid) ? 'inverse-bell' : 'bell';
    return { top, mid, bot, label, topHeavy: top - bot };
  }
  console.log('\nShape summary (top = TOP-decile %, mid = D5+D6, bot = BOT-decile %):');
  console.log('System | top   | mid   | bot   | top-bot | shape         | t1x   | t01x  | ROI');
  console.log('-'.repeat(95));
  function shapeRow(label: string, d: number[], s: ReturnType<typeof summary>) {
    const sh = shape(d);
    return `${label.padEnd(6)} | ${sh.top.toFixed(1).padStart(4)}% | ${sh.mid.toFixed(1).padStart(4)}% | ${sh.bot.toFixed(1).padStart(4)}% | ${(sh.topHeavy >= 0 ? '+' : '') + sh.topHeavy.toFixed(1).padStart(5)} | ${sh.label.padEnd(13)} | ${s.t1Edge.toFixed(2).padStart(4)}x | ${s.t01Edge.toFixed(2).padStart(4)}x | ${(s.roi*100).toFixed(1).padStart(5)}%`;
  }
  console.log(shapeRow('V1', dV1, sV1));
  console.log(shapeRow('V4a', dV4a, sV4a));
  console.log(shapeRow('V5', dV5, sV5));
  console.log(shapeRow('V6d', dV6d, sV6d));
  console.log(shapeRow('V7', dV7, sV7));
  console.log(shapeRow('V8', dV8, sV8));

  // Per-slate breakdown.
  console.log('\nPer-slate Mahalanobis comparison:');
  console.log('  ' + 'Slate'.padEnd(14) + ' | ' + 'V1 mahal'.padStart(8) + ' | ' + 'V2 mahal'.padStart(8) + ' | ' + 'delta'.padStart(7) + ' | ' + 'V1 t01'.padStart(5) + ' | ' + 'V2 t01'.padStart(5) + ' | ' + 'pool->filt'.padStart(15));
  for (let i = 0; i < v1.length; i++) {
    const r1 = v1[i], r2 = v2[i];
    const m1 = (r1.mahal || 0).toFixed(2);
    const m2 = (r2.mahal || 0).toFixed(2);
    const dRaw = (r2.mahal || 0) - (r1.mahal || 0);
    const dStr = (dRaw >= 0 ? '+' : '') + dRaw.toFixed(2);
    const poolStr = r2.poolOriginal + '->' + r2.poolFiltered;
    console.log('  ' + r1.slate.padEnd(14) + ' | ' + m1.padStart(8) + ' | ' + m2.padStart(8) + ' | ' + dStr.padStart(7) + ' | ' + String(r1.t01).padStart(5) + ' | ' + String(r2.t01).padStart(5) + ' | ' + poolStr.padStart(15));
  }

  // Save.
  const outPath = path.join(OUT_DIR, 'v2_validation_results.json');
  fs.writeFileSync(outPath, JSON.stringify({ summaryV1: sV1, summaryV2: sV2, decileV1: dV1, decileV2: dV2, perSlate: allResults }, null, 0));
  console.log('\nSaved to ' + outPath);

  // Per-slate lineup-level dump for descriptive analysis.
  const dumpPath = path.join(OUT_DIR, 'v1_pros_lineup_dump.json');
  fs.writeFileSync(dumpPath, JSON.stringify(dumpAll, null, 0));
  console.log('Lineup dump saved to ' + dumpPath);
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });
