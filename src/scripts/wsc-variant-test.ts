/**
 * Within-Stack Concentration (WSC) variant test.
 *
 * Single-variant controlled test: does forcing V1 to concentrate within-stack 5-sets
 * to the top-N hitters by projection improve or degrade tournament outcomes?
 *
 * V1-WSC = V1 (current = V1-NoCorr settings) + filter:
 *   - For each candidate lineup, find primary stack team & primarySize
 *   - The lineup PASSES iff its primary-stack hitter set == top-primarySize hitters
 *     by projection from that team's active hitter pool (slate-level)
 *
 * Outputs to C:/Users/colin/dfs opto/within_stack_concentration_test/
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player, ContestConfig } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals } from '../parser';
import { getContestConfig } from '../rules';
import { exportForDraftKings, exportDetailedLineups } from '../scoring';

const MLB_DIR = 'C:/Users/colin/dfs opto';
const OUT_DIR = 'C:/Users/colin/dfs opto/within_stack_concentration_test';
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
const PORTFOLIO_DIR = path.join(OUT_DIR, 'v1_wsc_portfolios');
if (!fs.existsSync(PORTFOLIO_DIR)) fs.mkdirSync(PORTFOLIO_DIR, { recursive: true });

const N = 150;
const FEE = 20;

// 16 dev slates per HOLDOUT_LOCK.md. Holdout slates are NOT touched.
const DEV_SLATES = [
  { slate: '4-8-26',        proj: '4-8-26projections.csv',        actuals: '4-8-26actuals.csv',        pool: '4-8-26sspool.csv' },
  { slate: '4-12-26',       proj: '4-12-26projections.csv',       actuals: '4-12-26actuals.csv',       pool: '4-12-26sspool.csv' },
  { slate: '4-17-26',       proj: '4-17-26projections.csv',       actuals: '4-17-26actuals.csv',       pool: '4-17-26sspool.csv' },
  { slate: '4-18-26',       proj: '4-18-26projections.csv',       actuals: '4-18-26actuals.csv',       pool: '4-18-26sspool.csv' },
  { slate: '4-21-26',       proj: '4-21-26projections.csv',       actuals: '4-21-26actuals.csv',       pool: '4-21-26sspool.csv' },
  { slate: '4-22-26',       proj: '4-22-26projections.csv',       actuals: '4-22-26actuals.csv',       pool: '4-22-26sspool.csv' },
  { slate: '4-23-26',       proj: '4-23-26projections.csv',       actuals: '4-23-26actuals.csv',       pool: '4-23-26sspool.csv' },
  { slate: '4-24-26',       proj: '4-24-26projections.csv',       actuals: '4-24-26actuals.csv',       pool: '4-24-26sspool.csv' },
  { slate: '4-25-26',       proj: '4-25-26projections.csv',       actuals: '4-25-26actuals.csv',       pool: '4-25-26sspool.csv' },
  { slate: '4-25-26-early', proj: '4-25-26projectionsearly.csv',  actuals: '4-25-26actualsearly.csv',  pool: '4-25-26sspoolearly.csv' },
  { slate: '4-26-26',       proj: '4-26-26projections.csv',       actuals: '4-26-26actuals.csv',       pool: '4-26-26sspool.csv' },
  { slate: '4-27-26',       proj: '4-27-26projections.csv',       actuals: '4-27-26actuals.csv',       pool: '4-27-26sspool.csv' },
  { slate: '4-28-26',       proj: '4-28-26projections.csv',       actuals: '4-28-26actuals.csv',       pool: '4-28-26sspool.csv' },
  { slate: '4-29-26',       proj: '4-29-26projections.csv',       actuals: '4-29-26actuals.csv',       pool: '4-29-26sspool.csv' },
  { slate: '5-2-26-main',   proj: '5-2-26projectionsmain.csv',    actuals: '5-2-26actualsmain.csv',    pool: '5-2-26sspoolmain.csv' },
  { slate: '5-3-26',        proj: '5-3-26projections.csv',        actuals: '5-3-26actuals.csv',        pool: '5-3-26sspool.csv' },
];

// V1 (current production, V1-NoCorr settings) — copied verbatim from theory-of-dfs-v1-preslate.ts
const TODFS_V1 = {
  STACK_BONUS_PER_HITTER: 0,
  BRINGBACK_1: 0,
  BRINGBACK_2: 0,
  PITCHER_VS_HITTER_PENALTY: -0.10,
  MIN_PRIMARY_STACK: 4,
  W_PROJ: 1.0, W_LEV: 0.30, W_VAR: 0.15, W_CMB: 0.25,
  EXPOSURE_CAP_HITTER: 0.25, EXPOSURE_CAP_PITCHER: 0.55,
  TEAM_STACK_CAP: 0.20,
  BAND_HIGH_PCT: 0.20, BAND_MID_PCT: 0.60, BAND_LOW_PCT: 0.20,
  MAX_PAIRWISE_OVERLAP: 6,
  TRIPLE_FREQ_CAP: 5,
  PPD_LINEUP_PENALTY: 0.10, PPD_LINEUP_TOP_PCT: 0.10,
};

function isPitcher(p: Player): boolean { return (p.position || '').toUpperCase().includes('P'); }
function mean(a: number[]): number { if (!a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; }
function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function rankPercentile(values: number[]): number[] {
  const idx = values.map((v, i) => ({ v, i }));
  idx.sort((a, b) => a.v - b.v);
  const out = new Array<number>(values.length);
  for (let r = 0; r < values.length; r++) out[idx[r].i] = values.length > 1 ? r / (values.length - 1) : 0;
  return out;
}

interface ScoredLU {
  lu: Lineup; primarySize: number; primaryTeam: string; corrAdj: number; logOwn: number; uniqueness: number; ppd: number;
  proj: number; floor: number; ceiling: number; range: number; ev: number;
  projPct: number; ownPct: number; rangePct: number; ppdPct: number; uniqPct: number;
  primaryStackHitterIds: string[];  // sorted list of stack hitter IDs (for WSC verification)
}

interface SlateData {
  slate: string;
  candidates: Lineup[];
  players: Player[];
  actuals: ContestActuals;
  config: ContestConfig;
  // Top-N by projection per team (active hitter pool, projection > 0). Tie-break: lower player ID.
  topNByTeam: Map<string, string[]>;  // teamUpper -> player IDs sorted by projection desc, id asc
}

async function loadSlate(s: typeof DEV_SLATES[0]): Promise<SlateData | null> {
  const proj = path.join(MLB_DIR, s.proj);
  const act = path.join(MLB_DIR, s.actuals);
  const pool = path.join(MLB_DIR, s.pool);
  if (![proj, act, pool].every(p => fs.existsSync(p))) {
    console.log(`  Skip ${s.slate}: missing files`);
    return null;
  }
  const pr = parseCSVFile(proj, 'mlb', true);
  const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
  const playerPool = buildPlayerPool(pr.players, pr.detectedContestType);
  const actuals = parseContestActuals(act, config);
  const idMap = new Map<string, Player>();
  for (const p of playerPool.players) idMap.set(p.id, p);
  const loaded = loadPoolFromCSV({ filePath: pool, config, playerMap: idMap });

  // Build top-N by team. Active hitter pool = non-pitchers with projection > 0.
  const teamHitters = new Map<string, Player[]>();
  for (const p of playerPool.players) {
    if (isPitcher(p)) continue;
    if (!(p.projection > 0)) continue;
    const t = (p.team || '').toUpperCase();
    if (!t) continue;
    if (!teamHitters.has(t)) teamHitters.set(t, []);
    teamHitters.get(t)!.push(p);
  }
  const topNByTeam = new Map<string, string[]>();
  for (const [team, hitters] of teamHitters) {
    // Sort by projection desc; tie-break: lower id wins (deterministic).
    hitters.sort((a, b) => {
      if (b.projection !== a.projection) return b.projection - a.projection;
      return a.id.localeCompare(b.id);
    });
    topNByTeam.set(team, hitters.map(h => h.id));
  }
  return { slate: s.slate, candidates: loaded.lineups, players: playerPool.players, actuals, config, topNByTeam };
}

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

function scoreLineup(lu: Lineup, pairFreqs: Map<string, number>, tripleFreqs: Map<string, number>): ScoredLU {
  let floor = 0, ceiling = 0;
  for (const p of lu.players) {
    if (p.percentiles) { floor += p.percentiles.p25 || p.projection * 0.85; ceiling += p.percentiles.p75 || p.projection * 1.15; }
    else { floor += p.projection * 0.85; ceiling += p.projection * 1.15; }
  }
  const teamHitters = new Map<string, number>();
  const teamHitterIds = new Map<string, string[]>();
  const pitchers: Player[] = [];
  for (const p of lu.players) {
    if (isPitcher(p)) pitchers.push(p);
    else {
      const t = (p.team || '').toUpperCase();
      if (t) {
        teamHitters.set(t, (teamHitters.get(t) || 0) + 1);
        if (!teamHitterIds.has(t)) teamHitterIds.set(t, []);
        teamHitterIds.get(t)!.push(p.id);
      }
    }
  }
  let primaryTeam = '', primarySize = 0;
  for (const [t, c] of teamHitters) if (c > primarySize) { primarySize = c; primaryTeam = t; }
  let primaryOpp = '';
  for (const p of lu.players) if ((p.team || '').toUpperCase() === primaryTeam) { primaryOpp = (p.opponent || '').toUpperCase(); if (primaryOpp) break; }
  const bringBack = primaryOpp ? (teamHitters.get(primaryOpp) || 0) : 0;
  let pOppHitters = 0;
  for (const p of pitchers) { const o = (p.opponent || '').toUpperCase(); if (o) pOppHitters += teamHitters.get(o) || 0; }
  let corrAdj = 0;
  if (primarySize >= 3) corrAdj += TODFS_V1.STACK_BONUS_PER_HITTER * (primarySize - 2);
  if (bringBack === 1) corrAdj += TODFS_V1.BRINGBACK_1;
  else if (bringBack >= 2) corrAdj += TODFS_V1.BRINGBACK_2;
  corrAdj += TODFS_V1.PITCHER_VS_HITTER_PENALTY * pOppHitters;

  let uniqueness = 0;
  const players = lu.players;
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const k = [players[i].id, players[j].id].sort().join('|');
      const f = pairFreqs.get(k) || 1e-6;
      uniqueness += -Math.log(f);
    }
  }
  const tripFs: { key: string; f: number }[] = [];
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      for (let l = j + 1; l < players.length; l++) {
        const tk = [players[i].id, players[j].id, players[l].id].sort().join('|');
        tripFs.push({ key: tk, f: tripleFreqs.get(tk) || 1e-6 });
      }
    }
  }
  tripFs.sort((a, b) => b.f - a.f);
  for (const t of tripFs.slice(0, TODFS_V1.TRIPLE_FREQ_CAP)) uniqueness += -Math.log(t.f);

  let logOwn = 0;
  for (const p of lu.players) {
    if (isPitcher(p)) continue;
    logOwn += Math.log(Math.max(0.1, p.ownership || 0.5));
  }
  let ppd = 0;
  for (const p of lu.players) if (p.salary && p.projection) ppd += p.projection / (p.salary / 1000);

  const primaryStackHitterIds = (teamHitterIds.get(primaryTeam) || []).slice().sort();

  return {
    lu, primarySize, primaryTeam, corrAdj, logOwn, uniqueness, ppd,
    proj: lu.projection, floor, ceiling, range: ceiling - floor,
    ev: 0, projPct: 0, ownPct: 0, rangePct: 0, ppdPct: 0, uniqPct: 0,
    primaryStackHitterIds,
  };
}

interface BuildOpts {
  wscConcentration: boolean;
  topNByTeam?: Map<string, string[]>;
}

function buildPortfolio(sd: SlateData, opts: BuildOpts): Lineup[] {
  // ============================================================
  // WSC FILTER (Stage 2): drop candidates whose primary-stack hitter set
  // != top-primarySize hitters by projection from that team.
  // Only applies to lineups with primarySize >= MIN_PRIMARY_STACK (4).
  // ============================================================
  let candidatePool = sd.candidates;
  let filteredCount = 0;
  if (opts.wscConcentration) {
    const topN = opts.topNByTeam!;
    const filtered: Lineup[] = [];
    for (const lu of candidatePool) {
      // Determine primary stack team & primarySize.
      const teamHitterIds = new Map<string, string[]>();
      for (const p of lu.players) {
        if (isPitcher(p)) continue;
        const t = (p.team || '').toUpperCase();
        if (!t) continue;
        if (!teamHitterIds.has(t)) teamHitterIds.set(t, []);
        teamHitterIds.get(t)!.push(p.id);
      }
      let primaryTeam = '', primarySize = 0;
      for (const [t, ids] of teamHitterIds) if (ids.length > primarySize) { primarySize = ids.length; primaryTeam = t; }
      // Only filter lineups with primarySize >= 4 (the V1 hard constraint).
      if (primarySize < TODFS_V1.MIN_PRIMARY_STACK) {
        // Keep — V1 will fall back to scored pool if pool2 < N anyway.
        filtered.push(lu);
        continue;
      }
      const stackIds = (teamHitterIds.get(primaryTeam) || []).slice().sort();
      const teamTopN = topN.get(primaryTeam) || [];
      if (teamTopN.length < primarySize) continue;  // Team doesn't have N qualifying hitters in active pool.
      const targetIds = teamTopN.slice(0, primarySize).slice().sort();
      // Equal sets check (both sorted, same length).
      let equal = stackIds.length === targetIds.length;
      if (equal) {
        for (let i = 0; i < stackIds.length; i++) if (stackIds[i] !== targetIds[i]) { equal = false; break; }
      }
      if (equal) filtered.push(lu);
    }
    filteredCount = filtered.length;
    candidatePool = filtered;
  }

  // Score the candidate pool.
  const { pair, triple } = buildPairTripleFreqs(candidatePool.length > 0 ? candidatePool : sd.candidates);
  const scored: ScoredLU[] = [];
  for (const lu of candidatePool) scored.push(scoreLineup(lu, pair, triple));

  // Compute percentiles & EV.
  const projAdj = scored.map(s => s.proj * (1 + s.corrAdj));
  const projPct = rankPercentile(projAdj);
  const ownPct = rankPercentile(scored.map(s => s.logOwn));
  const rangePct = rankPercentile(scored.map(s => s.range));
  const ppdPct = rankPercentile(scored.map(s => s.ppd));
  const uniqPct = rankPercentile(scored.map(s => s.uniqueness));
  for (let i = 0; i < scored.length; i++) {
    scored[i].projPct = projPct[i]; scored[i].ownPct = ownPct[i];
    scored[i].rangePct = rangePct[i]; scored[i].ppdPct = ppdPct[i];
    scored[i].uniqPct = uniqPct[i];
  }
  for (const s of scored) {
    let ev = TODFS_V1.W_PROJ * s.projPct
           + TODFS_V1.W_LEV * (1 - s.ownPct)
           + TODFS_V1.W_VAR * s.rangePct * 0.85
           + TODFS_V1.W_CMB * s.uniqPct;
    if (s.ppdPct >= 1 - TODFS_V1.PPD_LINEUP_TOP_PCT) ev *= (1 - TODFS_V1.PPD_LINEUP_PENALTY);
    s.ev = ev;
  }

  // Hard MIN_PRIMARY_STACK constraint.
  let pool2 = scored.filter(s => s.primarySize >= TODFS_V1.MIN_PRIMARY_STACK);
  if (pool2.length < N) pool2 = scored;
  if (pool2.length === 0) {
    console.log(`    WARN ${sd.slate}: pool2 empty after WSC filter, falling back to unfiltered candidates`);
    // Re-score from full unfiltered candidate pool.
    const { pair: p2, triple: t2 } = buildPairTripleFreqs(sd.candidates);
    const scored2: ScoredLU[] = [];
    for (const lu of sd.candidates) scored2.push(scoreLineup(lu, p2, t2));
    const projAdj2 = scored2.map(s => s.proj * (1 + s.corrAdj));
    const pp2 = rankPercentile(projAdj2);
    const op2 = rankPercentile(scored2.map(s => s.logOwn));
    const rp2 = rankPercentile(scored2.map(s => s.range));
    const pdp2 = rankPercentile(scored2.map(s => s.ppd));
    const up2 = rankPercentile(scored2.map(s => s.uniqueness));
    for (let i = 0; i < scored2.length; i++) {
      scored2[i].projPct = pp2[i]; scored2[i].ownPct = op2[i];
      scored2[i].rangePct = rp2[i]; scored2[i].ppdPct = pdp2[i]; scored2[i].uniqPct = up2[i];
    }
    for (const s of scored2) {
      let ev = TODFS_V1.W_PROJ * s.projPct + TODFS_V1.W_LEV * (1 - s.ownPct) + TODFS_V1.W_VAR * s.rangePct * 0.85 + TODFS_V1.W_CMB * s.uniqPct;
      if (s.ppdPct >= 1 - TODFS_V1.PPD_LINEUP_TOP_PCT) ev *= (1 - TODFS_V1.PPD_LINEUP_PENALTY);
      s.ev = ev;
    }
    pool2 = scored2.filter(s => s.primarySize >= TODFS_V1.MIN_PRIMARY_STACK);
    if (pool2.length < N) pool2 = scored2;
  }

  // Variance bands (20/60/20).
  const sortedHigh = [...pool2].sort((a, b) => (b.projPct + b.ownPct) - (a.projPct + a.ownPct));
  const sortedLow = [...pool2].sort((a, b) => ((1 - b.projPct) + (1 - b.ownPct)) - ((1 - a.projPct) + (1 - a.ownPct)));
  const HIGH_TARGET = Math.round(N * TODFS_V1.BAND_HIGH_PCT);
  const LOW_TARGET = Math.round(N * TODFS_V1.BAND_LOW_PCT);
  const MID_TARGET = N - HIGH_TARGET - LOW_TARGET;

  const selected: ScoredLU[] = [];
  const exposure = new Map<string, number>();
  const teamStackCount = new Map<string, number>();
  const seen = new Set<string>();
  function primaryStackTeamOf(s: ScoredLU): string {
    return s.primarySize >= 4 ? s.primaryTeam : '';
  }
  function passes(s: ScoredLU): boolean {
    if (seen.has(s.lu.hash)) return false;
    if (s.primarySize < TODFS_V1.MIN_PRIMARY_STACK) return false;
    for (const p of s.lu.players) {
      const cur = exposure.get(p.id) || 0;
      const cap = isPitcher(p) ? TODFS_V1.EXPOSURE_CAP_PITCHER : TODFS_V1.EXPOSURE_CAP_HITTER;
      if ((cur + 1) / N > cap) return false;
    }
    const stackTeam = primaryStackTeamOf(s);
    if (stackTeam) {
      const cur = teamStackCount.get(stackTeam) || 0;
      if ((cur + 1) / N > TODFS_V1.TEAM_STACK_CAP) return false;
    }
    const ids = new Set(s.lu.players.map(p => p.id));
    for (const sel of selected) {
      let ov = 0; for (const p of sel.lu.players) if (ids.has(p.id)) ov++;
      if (ov > TODFS_V1.MAX_PAIRWISE_OVERLAP) return false;
    }
    return true;
  }
  function add(s: ScoredLU) {
    selected.push(s); seen.add(s.lu.hash);
    for (const p of s.lu.players) exposure.set(p.id, (exposure.get(p.id) || 0) + 1);
    const stackTeam = primaryStackTeamOf(s);
    if (stackTeam) teamStackCount.set(stackTeam, (teamStackCount.get(stackTeam) || 0) + 1);
  }
  function fillBand(bandPool: ScoredLU[], target: number) {
    const sorted = [...bandPool].sort((a, b) => b.ev - a.ev);
    let added = 0;
    for (const s of sorted) { if (added >= target) break; if (passes(s)) { add(s); added++; } }
    if (added < target) {
      const old = TODFS_V1.MAX_PAIRWISE_OVERLAP;
      (TODFS_V1 as any).MAX_PAIRWISE_OVERLAP = old + 1;
      for (const s of sorted) { if (added >= target) break; if (passes(s)) { add(s); added++; } }
      (TODFS_V1 as any).MAX_PAIRWISE_OVERLAP = old;
    }
  }
  fillBand(sortedHigh.slice(0, Math.max(HIGH_TARGET * 5, 200)), HIGH_TARGET);
  fillBand(pool2, MID_TARGET);
  fillBand(sortedLow.slice(0, Math.max(LOW_TARGET * 5, 200)), LOW_TARGET);
  if (selected.length < N) {
    const sorted = [...pool2].sort((a, b) => b.ev - a.ev);
    for (const s of sorted) { if (selected.length >= N) break; if (passes(s)) add(s); }
  }
  // Last-resort fill: relax team-stack cap if still short (rare for WSC on small slates).
  if (selected.length < N) {
    const sorted = [...pool2].sort((a, b) => b.ev - a.ev);
    const oldCap = TODFS_V1.TEAM_STACK_CAP;
    (TODFS_V1 as any).TEAM_STACK_CAP = 1.0;
    for (const s of sorted) { if (selected.length >= N) break; if (passes(s)) add(s); }
    (TODFS_V1 as any).TEAM_STACK_CAP = oldCap;
  }
  if (opts.wscConcentration) {
    process.stderr.write(`    WSC pool=${filteredCount}/${sd.candidates.length} selected=${selected.length}\n`);
  }
  return selected.slice(0, N).map(s => s.lu);
}

// ============================================================
// METRICS
// ============================================================
interface ConstructionMetrics {
  slate: string;
  variant: string;
  uniqueFiveSetsPerStackTeam: number;     // mean unique 5-sets across distinct primary stack teams
  uniqueFourSetsPerStackTeam: number;     // mean unique 4-sets
  pctPrimary5plus: number;
  pctPrimary4: number;
  pctPrimary3: number;
  pctPrimaryOther: number;
  pctBringback1plus: number;
  pctBringback2plus: number;
  bandHpHo: number; bandHpLo: number; bandLpHo: number; bandLpLo: number;
  meanPairwiseJaccard: number;
  meanPairwiseCorr: number;  // jaccard - 0.10*P-vs-stack
  numPlayersUsed: number;
}

function computeConstructionMetrics(portfolio: Lineup[], slate: string, variant: string): ConstructionMetrics {
  // Stack-size distribution + primary stack team.
  const stackTeamHitterSets = new Map<string, Set<string>>();  // team -> Set<sortedHitterSetKey>
  const stackTeamSizeMap = new Map<string, number[]>();        // team -> list of primarySize values
  let p5 = 0, p4 = 0, p3 = 0, pOther = 0;
  let bb1 = 0, bb2 = 0;
  const lineupPrimarySize: number[] = [];
  for (const lu of portfolio) {
    const teamHitterIds = new Map<string, string[]>();
    const pitchers: Player[] = [];
    for (const p of lu.players) {
      if (isPitcher(p)) pitchers.push(p);
      else {
        const t = (p.team || '').toUpperCase();
        if (t) {
          if (!teamHitterIds.has(t)) teamHitterIds.set(t, []);
          teamHitterIds.get(t)!.push(p.id);
        }
      }
    }
    let primaryTeam = '', primarySize = 0;
    for (const [t, ids] of teamHitterIds) if (ids.length > primarySize) { primarySize = ids.length; primaryTeam = t; }
    lineupPrimarySize.push(primarySize);
    if (primarySize >= 5) p5++;
    else if (primarySize === 4) p4++;
    else if (primarySize === 3) p3++;
    else pOther++;
    let primaryOpp = '';
    for (const p of lu.players) if ((p.team || '').toUpperCase() === primaryTeam) { primaryOpp = (p.opponent || '').toUpperCase(); if (primaryOpp) break; }
    const bringBack = primaryOpp ? (teamHitterIds.get(primaryOpp)?.length || 0) : 0;
    if (bringBack >= 1) bb1++;
    if (bringBack >= 2) bb2++;
    if (primaryTeam && primarySize >= 4) {
      if (!stackTeamHitterSets.has(primaryTeam)) stackTeamHitterSets.set(primaryTeam, new Set());
      const setKey = (teamHitterIds.get(primaryTeam) || []).slice().sort().join('|');
      stackTeamHitterSets.get(primaryTeam)!.add(setKey);
      if (!stackTeamSizeMap.has(primaryTeam)) stackTeamSizeMap.set(primaryTeam, []);
      stackTeamSizeMap.get(primaryTeam)!.push(primarySize);
    }
  }

  // Within-stack 5-set and 4-set unique-count per stack team.
  // For each team that primary-stacks at least once, count unique 5-sets and unique 4-sets used.
  // Aggregate: mean across teams.
  const team5Counts: number[] = [];
  const team4Counts: number[] = [];
  for (const [team, sets] of stackTeamHitterSets) {
    // Filter sets by size: 5-sets (5 hitters) vs 4-sets (4 hitters).
    const fiveSets = new Set<string>();
    const fourSets = new Set<string>();
    for (const k of sets) {
      const n = k.split('|').length;
      if (n === 5) fiveSets.add(k);
      else if (n === 4) fourSets.add(k);
      else if (n > 5) {
        // Stacks of 6+ — collapse to top-5 of stack? For simplicity we use the full stack key.
        // For this analysis count toward fiveSets bucket.
        fiveSets.add(k);
      }
    }
    if (fiveSets.size > 0) team5Counts.push(fiveSets.size);
    if (fourSets.size > 0) team4Counts.push(fourSets.size);
  }
  const uniqueFiveSetsPerStackTeam = team5Counts.length > 0 ? mean(team5Counts) : 0;
  const uniqueFourSetsPerStackTeam = team4Counts.length > 0 ? mean(team4Counts) : 0;

  // Band distribution: HP/HO etc using slate-relative medians from PORTFOLIO ITSELF
  // (variant- and slate-local; matches V2 validation methodology applied to single variant).
  const projs = portfolio.map(lu => lu.projection).slice().sort((a, b) => a - b);
  const geoOwns = portfolio.map(lu => {
    let logOwnHit = 0, hitN = 0;
    for (const p of lu.players) {
      if (isPitcher(p)) continue;
      logOwnHit += Math.log(Math.max(0.1, p.ownership || 0.5));
      hitN++;
    }
    return hitN > 0 ? Math.exp(logOwnHit / hitN) : 0;
  }).slice().sort((a, b) => a - b);
  const medProj = projs[Math.floor(projs.length / 2)];
  const medOwn = geoOwns[Math.floor(geoOwns.length / 2)];
  let hpHo = 0, hpLo = 0, lpHo = 0, lpLo = 0;
  for (const lu of portfolio) {
    const hp = lu.projection >= medProj;
    let logOwnHit = 0, hitN = 0;
    for (const p of lu.players) {
      if (isPitcher(p)) continue;
      logOwnHit += Math.log(Math.max(0.1, p.ownership || 0.5));
      hitN++;
    }
    const geoOwn = hitN > 0 ? Math.exp(logOwnHit / hitN) : 0;
    const ho = geoOwn >= medOwn;
    if (hp && ho) hpHo++;
    else if (hp && !ho) hpLo++;
    else if (!hp && ho) lpHo++;
    else lpLo++;
  }

  // Within-portfolio mean pairwise Jaccard.
  const lineupIds = portfolio.map(lu => new Set(lu.players.map(p => p.id)));
  let jacSum = 0, corrSum = 0, pairCount = 0;
  // Pre-compute primary stack team per lineup for P-vs-stack penalty.
  const primaryStackTeams: string[] = [];
  const pitcherOpps: string[][] = [];
  for (const lu of portfolio) {
    const teamHitterIds = new Map<string, string[]>();
    const ps: Player[] = [];
    for (const p of lu.players) {
      if (isPitcher(p)) ps.push(p);
      else {
        const t = (p.team || '').toUpperCase();
        if (t) {
          if (!teamHitterIds.has(t)) teamHitterIds.set(t, []);
          teamHitterIds.get(t)!.push(p.id);
        }
      }
    }
    let pt = '', pSize = 0;
    for (const [t, ids] of teamHitterIds) if (ids.length > pSize) { pSize = ids.length; pt = t; }
    primaryStackTeams.push(pt);
    pitcherOpps.push(ps.map(p => (p.opponent || '').toUpperCase()));
  }
  for (let i = 0; i < lineupIds.length; i++) {
    for (let j = i + 1; j < lineupIds.length; j++) {
      const a = lineupIds[i], b = lineupIds[j];
      let inter = 0;
      for (const id of a) if (b.has(id)) inter++;
      const uni = a.size + b.size - inter;
      const jac = uni > 0 ? inter / uni : 0;
      jacSum += jac;
      // P-vs-stack penalty: if pitcher in lineup i opposes lineup j's primary stack team (or vice versa).
      let penalty = 0;
      if (primaryStackTeams[j] && pitcherOpps[i].includes(primaryStackTeams[j])) penalty += 1;
      if (primaryStackTeams[i] && pitcherOpps[j].includes(primaryStackTeams[i])) penalty += 1;
      corrSum += jac - 0.10 * penalty;
      pairCount++;
    }
  }
  const meanPairwiseJaccard = pairCount > 0 ? jacSum / pairCount : 0;
  const meanPairwiseCorr = pairCount > 0 ? corrSum / pairCount : 0;

  // Players used.
  const allIds = new Set<string>();
  for (const lu of portfolio) for (const p of lu.players) allIds.add(p.id);

  const total = portfolio.length;
  return {
    slate, variant,
    uniqueFiveSetsPerStackTeam, uniqueFourSetsPerStackTeam,
    pctPrimary5plus: total > 0 ? p5 / total : 0,
    pctPrimary4: total > 0 ? p4 / total : 0,
    pctPrimary3: total > 0 ? p3 / total : 0,
    pctPrimaryOther: total > 0 ? pOther / total : 0,
    pctBringback1plus: total > 0 ? bb1 / total : 0,
    pctBringback2plus: total > 0 ? bb2 / total : 0,
    bandHpHo: total > 0 ? hpHo / total : 0,
    bandHpLo: total > 0 ? hpLo / total : 0,
    bandLpHo: total > 0 ? lpHo / total : 0,
    bandLpLo: total > 0 ? lpLo / total : 0,
    meanPairwiseJaccard, meanPairwiseCorr,
    numPlayersUsed: allIds.size,
  };
}

// Tournament metrics.
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

interface TournamentMetrics {
  slate: string;
  variant: string;
  numLineups: number;
  numScored: number;  // lineups that didn't hit miss=true
  top1Hits: number;
  top01Hits: number;
  top1Rate: number;
  top01Rate: number;
  top1LiftVsRandom: number;
  top01LiftVsRandom: number;
  meanFinishPctile: number;
  inverseBellRatio: number;
  totalPayout: number;
  fees: number;
  roi: number;
  fieldEntries: number;
}

function computeTournamentMetrics(portfolio: Lineup[], slate: string, variant: string, actuals: ContestActuals): TournamentMetrics {
  const F = actuals.entries.length;
  const sortedActuals = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
  const top1T = sortedActuals[Math.max(0, Math.floor(F * 0.01) - 1)] || 0;
  const top01T = sortedActuals[Math.max(0, Math.floor(F * 0.001) - 1)] || 0;
  const payoutTable = buildPayoutTable(Math.max(F, 100));

  let totalPayout = 0, t1 = 0, t01 = 0;
  const finishPctiles: number[] = [];
  for (const lu of portfolio) {
    let actual = 0, miss = false;
    for (const p of lu.players) {
      const r = actuals.playerActualsByName.get(norm(p.name));
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
      for (const e of actuals.entries) if (Math.abs(e.actualPoints - actual) <= 0.25) cw++;
      cw = Math.max(0, cw - 1);
      totalPayout += pay / Math.sqrt(1 + cw * 0.5);
    }
  }
  const numScored = finishPctiles.length;
  const fees = portfolio.length * FEE;
  // Inverse-bell ratio: top quintile + bot quintile / 2*middle.
  const sortedFin = finishPctiles.slice().sort((a, b) => a - b);
  const q1 = sortedFin.length > 0 ? Math.floor(sortedFin.length * 0.2) : 0;
  const q4 = sortedFin.length > 0 ? Math.floor(sortedFin.length * 0.8) : 0;
  const m1 = Math.floor(sortedFin.length * 0.4);
  const m2 = Math.floor(sortedFin.length * 0.6);
  const botQuint = q1;
  const topQuint = sortedFin.length - q4;
  const midQuint = Math.max(1, m2 - m1);
  const inverseBellRatio = midQuint > 0 ? (botQuint + topQuint) / (2 * midQuint) : 0;
  return {
    slate, variant,
    numLineups: portfolio.length, numScored,
    top1Hits: t1, top01Hits: t01,
    top1Rate: portfolio.length > 0 ? t1 / portfolio.length : 0,
    top01Rate: portfolio.length > 0 ? t01 / portfolio.length : 0,
    top1LiftVsRandom: portfolio.length > 0 ? (t1 / portfolio.length) / 0.01 : 0,
    top01LiftVsRandom: portfolio.length > 0 ? (t01 / portfolio.length) / 0.001 : 0,
    meanFinishPctile: finishPctiles.length > 0 ? mean(finishPctiles) : 0,
    inverseBellRatio,
    totalPayout, fees,
    roi: fees > 0 ? totalPayout / fees - 1 : 0,
    fieldEntries: F,
  };
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log('================================================================');
  console.log('WITHIN-STACK CONCENTRATION (WSC) VARIANT TEST');
  console.log('Single variant. Pre-registered top-N concentration. 16 dev slates.');
  console.log('================================================================\n');

  const constructionRows: ConstructionMetrics[] = [];
  const tournamentRows: TournamentMetrics[] = [];
  const perSlateAnalysis: any[] = [];

  for (const s of DEV_SLATES) {
    process.stderr.write(`${s.slate}: loading ... `);
    const sd = await loadSlate(s);
    if (!sd) continue;
    process.stderr.write(`pool=${sd.candidates.length} ... `);

    // V1 baseline.
    const v1 = buildPortfolio(sd, { wscConcentration: false });
    // V1-WSC.
    const wsc = buildPortfolio(sd, { wscConcentration: true, topNByTeam: sd.topNByTeam });

    // Save portfolio CSVs.
    const v1Out = path.join(PORTFOLIO_DIR, `${s.slate}_v1_dk.csv`);
    const v1Detail = path.join(PORTFOLIO_DIR, `${s.slate}_v1_detail.csv`);
    const wscOut = path.join(PORTFOLIO_DIR, `${s.slate}_wsc_dk.csv`);
    const wscDetail = path.join(PORTFOLIO_DIR, `${s.slate}_wsc_detail.csv`);
    exportForDraftKings(v1, sd.config, v1Out);
    exportDetailedLineups(v1, sd.config, v1Detail);
    exportForDraftKings(wsc, sd.config, wscOut);
    exportDetailedLineups(wsc, sd.config, wscDetail);

    // Construction metrics.
    const cmV1 = computeConstructionMetrics(v1, s.slate, 'V1');
    const cmWSC = computeConstructionMetrics(wsc, s.slate, 'V1-WSC');
    constructionRows.push(cmV1, cmWSC);

    // Tournament metrics.
    const tmV1 = computeTournamentMetrics(v1, s.slate, 'V1', sd.actuals);
    const tmWSC = computeTournamentMetrics(wsc, s.slate, 'V1-WSC', sd.actuals);
    tournamentRows.push(tmV1, tmWSC);

    // Per-slate comparison.
    const helpedHurt = tmWSC.top1Hits > tmV1.top1Hits ? 'helped'
                     : tmWSC.top1Hits < tmV1.top1Hits ? 'hurt' : 'neutral';
    const helpedHurt01 = tmWSC.top01Hits > tmV1.top01Hits ? 'helped'
                       : tmWSC.top01Hits < tmV1.top01Hits ? 'hurt' : 'neutral';
    perSlateAnalysis.push({
      slate: s.slate,
      v1_top1: tmV1.top1Hits, wsc_top1: tmWSC.top1Hits, top1_diff: tmWSC.top1Hits - tmV1.top1Hits, top1_verdict: helpedHurt,
      v1_top01: tmV1.top01Hits, wsc_top01: tmWSC.top01Hits, top01_diff: tmWSC.top01Hits - tmV1.top01Hits, top01_verdict: helpedHurt01,
      v1_meanFin: tmV1.meanFinishPctile, wsc_meanFin: tmWSC.meanFinishPctile,
      v1_roi: tmV1.roi, wsc_roi: tmWSC.roi,
      v1_uniqueFiveSets: cmV1.uniqueFiveSetsPerStackTeam, wsc_uniqueFiveSets: cmWSC.uniqueFiveSetsPerStackTeam,
      v1_meanPairwiseJaccard: cmV1.meanPairwiseJaccard, wsc_meanPairwiseJaccard: cmWSC.meanPairwiseJaccard,
    });

    process.stderr.write(`v1_t1=${tmV1.top1Hits} wsc_t1=${tmWSC.top1Hits} v1_5sets=${cmV1.uniqueFiveSetsPerStackTeam.toFixed(2)} wsc_5sets=${cmWSC.uniqueFiveSetsPerStackTeam.toFixed(2)}\n`);
  }

  // Write CSVs.
  function writeCsv(filename: string, rows: any[], headerOrder?: string[]) {
    if (rows.length === 0) { fs.writeFileSync(path.join(OUT_DIR, filename), ''); return; }
    const headers = headerOrder || Object.keys(rows[0]);
    const lines = [headers.join(',')];
    for (const r of rows) {
      lines.push(headers.map(h => {
        const v = r[h];
        if (typeof v === 'number') return v.toFixed(6).replace(/\.?0+$/, '');
        return String(v ?? '');
      }).join(','));
    }
    fs.writeFileSync(path.join(OUT_DIR, filename), lines.join('\n') + '\n');
  }
  writeCsv('construction_comparison.csv', constructionRows);
  writeCsv('tournament_comparison.csv', tournamentRows);
  writeCsv('per_slate_analysis.csv', perSlateAnalysis);

  // Aggregate: bootstrap CIs.
  const v1Slates = tournamentRows.filter(r => r.variant === 'V1');
  const wscSlates = tournamentRows.filter(r => r.variant === 'V1-WSC');
  function aggLift(rows: TournamentMetrics[], pctile: 'top1' | 'top01'): { lift: number; totalHits: number; totalLineups: number } {
    let hits = 0, total = 0;
    for (const r of rows) {
      hits += pctile === 'top1' ? r.top1Hits : r.top01Hits;
      total += r.numLineups;
    }
    const expectedRate = pctile === 'top1' ? 0.01 : 0.001;
    return { lift: total > 0 ? (hits / total) / expectedRate : 0, totalHits: hits, totalLineups: total };
  }
  // Cluster bootstrap (resample slates with replacement).
  function clusterBootstrap(rows: TournamentMetrics[], pctile: 'top1' | 'top01', samples: number = 10000): { lift: number; lo: number; hi: number } {
    const liftSamples: number[] = [];
    const expectedRate = pctile === 'top1' ? 0.01 : 0.001;
    for (let s = 0; s < samples; s++) {
      let hits = 0, total = 0;
      for (let i = 0; i < rows.length; i++) {
        const idx = Math.floor(Math.random() * rows.length);
        const r = rows[idx];
        hits += pctile === 'top1' ? r.top1Hits : r.top01Hits;
        total += r.numLineups;
      }
      liftSamples.push(total > 0 ? (hits / total) / expectedRate : 0);
    }
    liftSamples.sort((a, b) => a - b);
    return {
      lift: liftSamples[Math.floor(samples / 2)],
      lo: liftSamples[Math.floor(samples * 0.025)],
      hi: liftSamples[Math.floor(samples * 0.975)],
    };
  }
  const v1Top1 = aggLift(v1Slates, 'top1');
  const wscTop1 = aggLift(wscSlates, 'top1');
  const v1Top01 = aggLift(v1Slates, 'top01');
  const wscTop01 = aggLift(wscSlates, 'top01');
  const v1Top1Boot = clusterBootstrap(v1Slates, 'top1');
  const wscTop1Boot = clusterBootstrap(wscSlates, 'top1');
  const v1Top01Boot = clusterBootstrap(v1Slates, 'top01');
  const wscTop01Boot = clusterBootstrap(wscSlates, 'top01');
  const v1ROI = v1Slates.reduce((s, r) => s + r.totalPayout, 0) / v1Slates.reduce((s, r) => s + r.fees, 0) - 1;
  const wscROI = wscSlates.reduce((s, r) => s + r.totalPayout, 0) / wscSlates.reduce((s, r) => s + r.fees, 0) - 1;

  // Per-slate breakdown.
  let helpedTop1 = 0, hurtTop1 = 0, neutralTop1 = 0;
  let helpedTop01 = 0, hurtTop01 = 0, neutralTop01 = 0;
  for (const a of perSlateAnalysis) {
    if (a.top1_verdict === 'helped') helpedTop1++;
    else if (a.top1_verdict === 'hurt') hurtTop1++;
    else neutralTop1++;
    if (a.top01_verdict === 'helped') helpedTop01++;
    else if (a.top01_verdict === 'hurt') hurtTop01++;
    else neutralTop01++;
  }

  // 5-set diversity verification.
  const v1Sets = constructionRows.filter(r => r.variant === 'V1').map(r => r.uniqueFiveSetsPerStackTeam);
  const wscSets = constructionRows.filter(r => r.variant === 'V1-WSC').map(r => r.uniqueFiveSetsPerStackTeam);
  const v1Jac = constructionRows.filter(r => r.variant === 'V1').map(r => r.meanPairwiseJaccard);
  const wscJac = constructionRows.filter(r => r.variant === 'V1-WSC').map(r => r.meanPairwiseJaccard);

  console.log('\n================================================================');
  console.log('SUMMARY');
  console.log('================================================================');
  console.log(`Slates evaluated: ${v1Slates.length}`);
  console.log('');
  console.log('VERIFICATION (within-stack 5-set diversity per stack team):');
  console.log(`  V1 mean: ${mean(v1Sets).toFixed(2)}    V1-WSC mean: ${mean(wscSets).toFixed(2)}`);
  console.log(`  V1 mean pairwise Jaccard: ${mean(v1Jac).toFixed(4)}    V1-WSC: ${mean(wscJac).toFixed(4)}`);
  console.log('');
  console.log('TOURNAMENT METRICS (16 dev slates):');
  console.log(`  V1     top-1× lift: ${v1Top1.lift.toFixed(3)}  (95% CI [${v1Top1Boot.lo.toFixed(3)}, ${v1Top1Boot.hi.toFixed(3)}])  hits=${v1Top1.totalHits}/${v1Top1.totalLineups}`);
  console.log(`  V1-WSC top-1× lift: ${wscTop1.lift.toFixed(3)}  (95% CI [${wscTop1Boot.lo.toFixed(3)}, ${wscTop1Boot.hi.toFixed(3)}])  hits=${wscTop1.totalHits}/${wscTop1.totalLineups}`);
  console.log(`  V1     top-0.1× lift: ${v1Top01.lift.toFixed(3)}  (95% CI [${v1Top01Boot.lo.toFixed(3)}, ${v1Top01Boot.hi.toFixed(3)}])  hits=${v1Top01.totalHits}`);
  console.log(`  V1-WSC top-0.1× lift: ${wscTop01.lift.toFixed(3)}  (95% CI [${wscTop01Boot.lo.toFixed(3)}, ${wscTop01Boot.hi.toFixed(3)}])  hits=${wscTop01.totalHits}`);
  console.log(`  V1     ROI: ${(v1ROI*100).toFixed(1)}%`);
  console.log(`  V1-WSC ROI: ${(wscROI*100).toFixed(1)}%`);
  console.log('');
  console.log(`PER-SLATE TOP-1% (V1-WSC vs V1): helped=${helpedTop1} hurt=${hurtTop1} neutral=${neutralTop1}`);
  console.log(`PER-SLATE TOP-0.1%: helped=${helpedTop01} hurt=${hurtTop01} neutral=${neutralTop01}`);

  // Save aggregate JSON for FINDINGS use.
  const aggregate = {
    methodology_locked_at: '2026-05-03',
    num_dev_slates: v1Slates.length,
    holdout_sealed: true,
    pre_registered_target: 'top-N by projection (N = primarySize)',
    single_variant: true,
    verification: {
      v1_mean_unique_5sets_per_stack: mean(v1Sets),
      wsc_mean_unique_5sets_per_stack: mean(wscSets),
      v1_mean_unique_4sets_per_stack: mean(constructionRows.filter(r => r.variant === 'V1').map(r => r.uniqueFourSetsPerStackTeam)),
      wsc_mean_unique_4sets_per_stack: mean(constructionRows.filter(r => r.variant === 'V1-WSC').map(r => r.uniqueFourSetsPerStackTeam)),
      v1_mean_pairwise_jaccard: mean(v1Jac),
      wsc_mean_pairwise_jaccard: mean(wscJac),
    },
    tournament: {
      v1: { top1_lift: v1Top1.lift, top1_ci: [v1Top1Boot.lo, v1Top1Boot.hi], top1_hits: v1Top1.totalHits, top01_lift: v1Top01.lift, top01_ci: [v1Top01Boot.lo, v1Top01Boot.hi], top01_hits: v1Top01.totalHits, roi: v1ROI },
      wsc: { top1_lift: wscTop1.lift, top1_ci: [wscTop1Boot.lo, wscTop1Boot.hi], top1_hits: wscTop1.totalHits, top01_lift: wscTop01.lift, top01_ci: [wscTop01Boot.lo, wscTop01Boot.hi], top01_hits: wscTop01.totalHits, roi: wscROI },
    },
    per_slate: {
      top1: { helped: helpedTop1, hurt: hurtTop1, neutral: neutralTop1 },
      top01: { helped: helpedTop01, hurt: hurtTop01, neutral: neutralTop01 },
    },
  };
  fs.writeFileSync(path.join(OUT_DIR, 'aggregate.json'), JSON.stringify(aggregate, null, 2));
  console.log(`\nAggregate saved: ${path.join(OUT_DIR, 'aggregate.json')}`);
  console.log('Construction CSV: construction_comparison.csv');
  console.log('Tournament CSV: tournament_comparison.csv');
  console.log('Per-slate CSV: per_slate_analysis.csv');
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });
