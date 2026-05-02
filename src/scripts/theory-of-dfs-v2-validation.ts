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
  STACK_BONUS_PER_HITTER: 0.10, BRINGBACK_1: 0.05, BRINGBACK_2: 0.08, PITCHER_VS_HITTER_PENALTY: -0.10,
  MIN_PRIMARY_STACK: 4, OWNERSHIP_EFFICIENCY_EXPONENT: 0.5,
  W_PROJ: 1.0, W_LEV: 0.30, W_RV: 0.20, W_CMB: 0.25, W_VAR: 0.15, W_CEIL_EFF: 0.10,
  EXPLOITATIVE_EXPONENT: 1.5, EXPOSURE_CAP_HITTER: 0.50, EXPOSURE_CAP_PITCHER: 1.00,
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
  let primaryOpp = '';
  for (const p of lu.players) if ((p.team || '').toUpperCase() === primaryTeam) { primaryOpp = (p.opponent || '').toUpperCase(); if (primaryOpp) break; }
  const bringBack = primaryOpp ? (teamHitters.get(primaryOpp) || 0) : 0;
  let pOppHitters = 0;
  for (const p of pitchers) { const o = (p.opponent || '').toUpperCase(); if (o) pOppHitters += teamHitters.get(o) || 0; }
  let corrAdj = 0;
  if (primarySize >= 3) corrAdj += TODFS_PARAMS.STACK_BONUS_PER_HITTER * (primarySize - 2);
  if (bringBack === 1) corrAdj += TODFS_PARAMS.BRINGBACK_1;
  else if (bringBack >= 2) corrAdj += TODFS_PARAMS.BRINGBACK_2;
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
    primarySize, corrAdj, logOwn, uniqueness, ppd, stackOwnAvg,
    ev: 0, projPct: 0, ownPct: 0, rangePct: 0, ppdPct: 0, uniqPct: 0, stackOwnPct: 0,
  };
}

interface VariantOpts { applyTypeScaling: boolean; topNFilter: number; stackChalkBonus?: number; }

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
  const scored = candidatePool.map(lu => scoreLineup(lu, pair, triple, opts.applyTypeScaling));
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
  for (const s of scored) {
    let ev = TODFS_PARAMS.W_PROJ * s.projPct
           + TODFS_PARAMS.W_LEV * (1 - s.ownPct)
           + TODFS_PARAMS.W_VAR * s.rangePct * 0.85
           + TODFS_PARAMS.W_CMB * s.uniqPct
           + stackChalkBonus * s.stackOwnPct;  // V3 term
    if (s.ppdPct >= 1 - TODFS_PARAMS.PPD_LINEUP_TOP_PCT) ev *= (1 - TODFS_PARAMS.PPD_LINEUP_PENALTY);
    s.ev = ev;
  }

  let pool = scored.filter(s => s.primarySize >= TODFS_PARAMS.MIN_PRIMARY_STACK);
  if (pool.length < N) pool = scored;

  const sortedHigh = [...pool].sort((a, b) => (b.projPct + b.ownPct) - (a.projPct + a.ownPct));
  const sortedLow = [...pool].sort((a, b) => ((1 - b.projPct) + (1 - b.ownPct)) - ((1 - a.projPct) + (1 - a.ownPct)));
  const HIGH_TARGET = Math.round(N * TODFS_PARAMS.BAND_HIGH_PCT);
  const LOW_TARGET = Math.round(N * TODFS_PARAMS.BAND_LOW_PCT);
  const MID_TARGET = N - HIGH_TARGET - LOW_TARGET;

  const selected: ScoredLU[] = [];
  const exposure = new Map<string, number>();
  const seen = new Set<string>();
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
    return true;
  }
  function add(s: ScoredLU) {
    selected.push(s); seen.add(s.lu.hash);
    for (const p of s.lu.players) exposure.set(p.id, (exposure.get(p.id) || 0) + 1);
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
  return { system, slate: sd.slate, totalPayout, t1, t01, metrics, mahal, finishPctiles, poolFiltered: filteredPoolSize, poolOriginal: originalPoolSize };
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log('================================================================');
  console.log('THEORY-DFS V2 VALIDATION — empirically-calibrated combinatorial uniqueness');
  console.log('================================================================\n');

  const consensusRaw = JSON.parse(fs.readFileSync(path.join(MLB_DIR, 'pro_consensus_slate_relative.json'), 'utf-8'));
  const cons: Record<string, Record<string, { mean: number; std: number }>> = {};
  for (const k of UNIVERSAL_METRICS) {
    for (const e of (consensusRaw.metrics[k] || [])) {
      if (!cons[e.slate]) cons[e.slate] = {};
      cons[e.slate][k] = { mean: e.mean, std: e.std };
    }
  }
  loadTop5();  // pre-load

  const allResults: Result[] = [];
  for (const s of SLATES) {
    const sd = await loadSlate(s, cons);
    if (!sd) continue;
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
    allResults.push(v1Result, v3Result, v3bResult, v3cResult, v2aResult, v2bResult, v2cResult);
    process.stderr.write(`v1 m=${v1Result.mahal?.toFixed(2)} | v2a m=${v2aResult.mahal?.toFixed(2)} | v2b m=${v2bResult.mahal?.toFixed(2)} pool=${filteredPoolSize} | v2c m=${v2cResult.mahal?.toFixed(2)} pool=${v2cPoolFiltered} [${((Date.now() - t0) / 1000).toFixed(1)}s]\n`);
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
  const fees = N * FEE * v1.length;
  const expT1 = 0.01 * N * v1.length;
  const expT01 = 0.001 * N * v1.length;

  function summary(rs: Result[], label: string) {
    const totalPay = rs.reduce((s, r) => s + r.totalPayout, 0);
    const totalT1 = rs.reduce((s, r) => s + r.t1, 0);
    const totalT01 = rs.reduce((s, r) => s + r.t01, 0);
    const mahals = rs.map(r => r.mahal).filter((x): x is number => x !== null);
    const meanMahal = mean(mahals);
    return { label, totalPay, roi: totalPay / fees - 1, totalT1, totalT01, meanMahal, t1Edge: totalT1 / expT1, t01Edge: totalT01 / expT01 };
  }
  const sV1 = summary(v1, 'V1');
  const sV3 = summary(v3, 'V3');
  const sV3b = summary(v3b, 'V3b');
  const sV3c = summary(v3c, 'V3c');
  const sV2a = summary(v2, 'V2a');
  const sV2b = summary(v2b, 'V2b');
  const sV2c = summary(v2c, 'V2c');

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
  console.log('\nFinishing distribution (deciles, lower idx = better finish):');
  console.log('V1   : ' + dV1.map(p => p.toFixed(1).padStart(5) + '%').join(' '));
  console.log('V2   : ' + dV2.map(p => p.toFixed(1).padStart(5) + '%').join(' '));
  const v1Top = dV1[0], v1Mid = dV1[4] + dV1[5], v1Bot = dV1[9];
  const v2Top = dV2[0], v2Mid = dV2[4] + dV2[5], v2Bot = dV2[9];
  const v1Shape = (v1Top + v1Bot > v1Mid) ? 'inverse-bell' : 'bell';
  const v2Shape = (v2Top + v2Bot > v2Mid) ? 'inverse-bell' : 'bell';
  console.log('V1 shape: top=' + v1Top.toFixed(1) + '% mid=' + v1Mid.toFixed(1) + '% bot=' + v1Bot.toFixed(1) + '% -> ' + v1Shape);
  console.log('V2 shape: top=' + v2Top.toFixed(1) + '% mid=' + v2Mid.toFixed(1) + '% bot=' + v2Bot.toFixed(1) + '% -> ' + v2Shape);

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
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });
