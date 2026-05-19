/**
 * V1-PortfolioCombo backtest descriptive comparison harness.
 *
 * Runs both V1-NoCorr and V1-PortfolioCombo on each of the 16 dev slates
 * (HOLDOUT sealed per slate_derived_research/HOLDOUT_LOCK.md) and emits
 * one CSV row per slate per variant covering construction metrics +
 * tournament metrics (descriptive only — Phase 1 NO-GO means backtest is
 * not a deployment criterion).
 *
 * Tournament metrics: top-1× lift vs random, top-0.1× lift vs random,
 * per-slate ROI. Pro-distance Mahalanobis is NOT computed here (the pro
 * consensus methodology lives in a separate research module that needs
 * its own pro-pool inputs per slate; we report N/A for now and call it out).
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals } from '../parser';
import { getContestConfig } from '../rules';

const DATA_DIR = 'C:/Users/colin/dfs opto';
const OUT_DIR = path.join(DATA_DIR, 'portfolio_combo_implementation');
const N = 150;
const FEE = 20; // entry fee per lineup (dollars)

// 16 dev slates per HOLDOUT_LOCK. 8 holdout slates intentionally NOT touched.
const SLATES = [
  { slate: '4-8-26',         proj: '4-8-26projections.csv',         actuals: '4-8-26actuals.csv',         pool: '4-8-26sspool.csv' },
  { slate: '4-12-26',        proj: '4-12-26projections.csv',        actuals: '4-12-26actuals.csv',        pool: '4-12-26sspool.csv' },
  { slate: '4-17-26',        proj: '4-17-26projections.csv',        actuals: '4-17-26actuals.csv',        pool: '4-17-26sspool.csv' },
  { slate: '4-18-26',        proj: '4-18-26projections.csv',        actuals: '4-18-26actuals.csv',        pool: '4-18-26sspool.csv' },
  { slate: '4-21-26',        proj: '4-21-26projections.csv',        actuals: '4-21-26actuals.csv',        pool: '4-21-26sspool.csv' },
  { slate: '4-22-26',        proj: '4-22-26projections.csv',        actuals: '4-22-26actuals.csv',        pool: '4-22-26sspool.csv' },
  { slate: '4-23-26',        proj: '4-23-26projections.csv',        actuals: '4-23-26actuals.csv',        pool: '4-23-26sspool.csv' },
  { slate: '4-24-26',        proj: '4-24-26projections.csv',        actuals: '4-24-26actuals.csv',        pool: '4-24-26sspool.csv' },
  { slate: '4-25-26',        proj: '4-25-26projections.csv',        actuals: '4-25-26actuals.csv',        pool: '4-25-26sspool.csv' },
  { slate: '4-25-26-early',  proj: '4-25-26projectionsearly.csv',   actuals: '4-25-26actualsearly.csv',   pool: '4-25-26sspoolearly.csv' },
  { slate: '4-26-26',        proj: '4-26-26projections.csv',        actuals: '4-26-26actuals.csv',        pool: '4-26-26sspool.csv' },
  { slate: '4-27-26',        proj: '4-27-26projections.csv',        actuals: '4-27-26actuals.csv',        pool: '4-27-26sspool.csv' },
  { slate: '4-28-26',        proj: '4-28-26projections.csv',        actuals: '4-28-26actuals.csv',        pool: '4-28-26sspool.csv' },
  { slate: '4-29-26',        proj: '4-29-26projections.csv',        actuals: '4-29-26actuals.csv',        pool: '4-29-26sspool.csv' },
  { slate: '5-2-26-main',    proj: '5-2-26projectionsmain.csv',     actuals: '5-2-26actualsmain.csv',     pool: '5-2-26sspoolmain.csv' },
  { slate: '5-3-26',         proj: '5-3-26projections.csv',         actuals: '5-3-26actuals.csv',         pool: '5-3-26sspool.csv' },
];

const PARAMS_V1 = {
  STACK_BONUS_PER_HITTER: 0, BRINGBACK_1: 0, BRINGBACK_2: 0,
  PITCHER_VS_HITTER_PENALTY: -0.10, MIN_PRIMARY_STACK: 4,
  W_PROJ: 1.0, W_LEV: 0.30, W_VAR: 0.15, W_CMB: 0.25,
  EXPOSURE_CAP_HITTER: 0.25, EXPOSURE_CAP_PITCHER: 0.45,
  TEAM_STACK_CAP: 0.20,
  BAND_HIGH_PCT: 0.20, BAND_MID_PCT: 0.60, BAND_LOW_PCT: 0.20,
  MAX_PAIRWISE_OVERLAP: 6, TRIPLE_FREQ_CAP: 5,
  PPD_LINEUP_PENALTY: 0.10, PPD_LINEUP_TOP_PCT: 0.10,
};

const PARAMS_PC = {
  ...PARAMS_V1,
  EXPOSURE_CAP_HITTER: 0.20,    // pre-reg spec value
  TEAM_STACK_CAP: 0.15,         // pre-reg spec value
  COMBO4_CAP_PCT: 0.13, COMBO5_CAP_PCT: 0.09, COMBO_CAP_RELAX_PP: 0.02,
};

function isPitcher(p: Player): boolean { return (p.position || '').toUpperCase().includes('P'); }
function mean(a: number[]): number { if (!a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; }
function rankPercentile(values: number[]): number[] {
  const idx = values.map((v, i) => ({ v, i }));
  idx.sort((a, b) => a.v - b.v);
  const out = new Array<number>(values.length);
  for (let r = 0; r < values.length; r++) out[idx[r].i] = values.length > 1 ? r / (values.length - 1) : 0;
  return out;
}

function enumerateCombos(playerIds: string[]): { combos4: string[]; combos5: string[] } {
  const ids = [...playerIds].sort();
  const n = ids.length;
  const combos4: string[] = [];
  const combos5: string[] = [];
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      for (let k = j + 1; k < n; k++)
        for (let l = k + 1; l < n; l++) {
          combos4.push(ids[i] + '|' + ids[j] + '|' + ids[k] + '|' + ids[l]);
          for (let m = l + 1; m < n; m++)
            combos5.push(ids[i] + '|' + ids[j] + '|' + ids[k] + '|' + ids[l] + '|' + ids[m]);
        }
  return { combos4, combos5 };
}

interface S { lu: Lineup; primarySize: number; corrAdj: number; logOwn: number; uniqueness: number; ppd: number;
  proj: number; floor: number; ceiling: number; range: number; ev: number;
  projPct: number; ownPct: number; rangePct: number; ppdPct: number; uniqPct: number;
  combos4?: string[]; combos5?: string[]; }

function score(candidates: Lineup[], P: typeof PARAMS_V1, withCombos: boolean): S[] {
  const pairFreq = new Map<string, number>();
  const tripFreq = new Map<string, number>();
  let totalW = 0;
  for (const lu of candidates) {
    const w = Math.max(0.1, lu.projection || 1) ** 2;
    totalW += w;
    const ids = lu.players.map(p => p.id).sort();
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        pairFreq.set(ids[i] + '|' + ids[j], (pairFreq.get(ids[i] + '|' + ids[j]) || 0) + w);
        for (let l = j + 1; l < ids.length; l++) {
          const k = ids[i] + '|' + ids[j] + '|' + ids[l];
          tripFreq.set(k, (tripFreq.get(k) || 0) + w);
        }
      }
  }
  for (const k of pairFreq.keys()) pairFreq.set(k, pairFreq.get(k)! / totalW);
  for (const k of tripFreq.keys()) tripFreq.set(k, tripFreq.get(k)! / totalW);

  const scored: S[] = [];
  for (const lu of candidates) {
    let floor = 0, ceiling = 0;
    for (const p of lu.players) {
      if (p.percentiles) { floor += p.percentiles.p25 || p.projection * 0.85; ceiling += p.percentiles.p75 || p.projection * 1.15; }
      else { floor += p.projection * 0.85; ceiling += p.projection * 1.15; }
    }
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
    if (primarySize >= 3) corrAdj += P.STACK_BONUS_PER_HITTER * (primarySize - 2);
    if (bringBack === 1) corrAdj += P.BRINGBACK_1;
    else if (bringBack >= 2) corrAdj += P.BRINGBACK_2;
    corrAdj += P.PITCHER_VS_HITTER_PENALTY * pOppHitters;
    let uniqueness = 0;
    const players = lu.players;
    for (let i = 0; i < players.length; i++)
      for (let j = i + 1; j < players.length; j++) {
        const k = [players[i].id, players[j].id].sort().join('|');
        uniqueness += -Math.log(pairFreq.get(k) || 1e-6);
      }
    const tripFs: { f: number }[] = [];
    for (let i = 0; i < players.length; i++)
      for (let j = i + 1; j < players.length; j++)
        for (let l = j + 1; l < players.length; l++) {
          const tk = [players[i].id, players[j].id, players[l].id].sort().join('|');
          tripFs.push({ f: tripFreq.get(tk) || 1e-6 });
        }
    tripFs.sort((a, b) => b.f - a.f);
    for (const t of tripFs.slice(0, P.TRIPLE_FREQ_CAP)) uniqueness += -Math.log(t.f);
    let logOwn = 0;
    for (const p of lu.players) {
      if (isPitcher(p)) continue;
      logOwn += Math.log(Math.max(0.1, p.ownership || 0.5));
    }
    let ppd = 0;
    for (const p of lu.players) if (p.salary && p.projection) ppd += p.projection / (p.salary / 1000);
    const s: S = { lu, primarySize, corrAdj, logOwn, uniqueness, ppd, proj: lu.projection,
      floor, ceiling, range: ceiling - floor, ev: 0, projPct: 0, ownPct: 0, rangePct: 0, ppdPct: 0, uniqPct: 0 };
    if (withCombos) { const c = enumerateCombos(lu.players.map(p => p.id)); s.combos4 = c.combos4; s.combos5 = c.combos5; }
    scored.push(s);
  }
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
    let ev = P.W_PROJ * s.projPct + P.W_LEV * (1 - s.ownPct)
           + P.W_VAR * s.rangePct * 0.85 + P.W_CMB * s.uniqPct;
    if (s.ppdPct >= 1 - P.PPD_LINEUP_TOP_PCT) ev *= (1 - P.PPD_LINEUP_PENALTY);
    s.ev = ev;
  }
  return scored;
}

function selectV1(scored: S[], N: number, P: typeof PARAMS_V1): S[] {
  let pool2 = scored.filter(s => s.primarySize >= P.MIN_PRIMARY_STACK);
  if (pool2.length < N) pool2 = scored;
  const sortedHigh = [...pool2].sort((a, b) => (b.projPct + b.ownPct) - (a.projPct + a.ownPct));
  const sortedLow = [...pool2].sort((a, b) => ((1 - b.projPct) + (1 - b.ownPct)) - ((1 - a.projPct) + (1 - a.ownPct)));
  const HIGH_TARGET = Math.round(N * P.BAND_HIGH_PCT);
  const LOW_TARGET = Math.round(N * P.BAND_LOW_PCT);
  const MID_TARGET = N - HIGH_TARGET - LOW_TARGET;
  const selected: S[] = []; const exposure = new Map<string, number>(); const teamStackCount = new Map<string, number>(); const seen = new Set<string>();
  function primaryStackTeamOf(s: S): string {
    const tc = new Map<string, number>();
    for (const p of s.lu.players) {
      if (isPitcher(p)) continue;
      const t = (p.team || '').toUpperCase(); if (t) tc.set(t, (tc.get(t) || 0) + 1);
    }
    let primary = '', max = 0;
    for (const [t, c] of tc) if (c > max) { max = c; primary = t; }
    return max >= 4 ? primary : '';
  }
  function passes(s: S): boolean {
    if (seen.has(s.lu.hash)) return false;
    if (s.primarySize < P.MIN_PRIMARY_STACK) return false;
    for (const p of s.lu.players) {
      const cur = exposure.get(p.id) || 0;
      const cap = isPitcher(p) ? P.EXPOSURE_CAP_PITCHER : P.EXPOSURE_CAP_HITTER;
      if ((cur + 1) / N > cap) return false;
    }
    const stackTeam = primaryStackTeamOf(s);
    if (stackTeam && (((teamStackCount.get(stackTeam) || 0) + 1) / N > P.TEAM_STACK_CAP)) return false;
    const ids = new Set(s.lu.players.map(p => p.id));
    for (const sel of selected) {
      let ov = 0; for (const p of sel.lu.players) if (ids.has(p.id)) ov++;
      if (ov > P.MAX_PAIRWISE_OVERLAP) return false;
    }
    return true;
  }
  function add(s: S) {
    selected.push(s); seen.add(s.lu.hash);
    for (const p of s.lu.players) exposure.set(p.id, (exposure.get(p.id) || 0) + 1);
    const stackTeam = primaryStackTeamOf(s); if (stackTeam) teamStackCount.set(stackTeam, (teamStackCount.get(stackTeam) || 0) + 1);
  }
  function fillBand(bandPool: S[], target: number) {
    const sorted = [...bandPool].sort((a, b) => b.ev - a.ev);
    let added = 0;
    for (const s of sorted) { if (added >= target) break; if (passes(s)) { add(s); added++; } }
    if (added < target) {
      const old = P.MAX_PAIRWISE_OVERLAP; (P as any).MAX_PAIRWISE_OVERLAP = old + 1;
      for (const s of sorted) { if (added >= target) break; if (passes(s)) { add(s); added++; } }
      (P as any).MAX_PAIRWISE_OVERLAP = old;
    }
  }
  fillBand(sortedHigh.slice(0, Math.max(HIGH_TARGET * 5, 200)), HIGH_TARGET);
  fillBand(pool2, MID_TARGET);
  fillBand(sortedLow.slice(0, Math.max(LOW_TARGET * 5, 200)), LOW_TARGET);
  if (selected.length < N) {
    const sorted = [...pool2].sort((a, b) => b.ev - a.ev);
    for (const s of sorted) { if (selected.length >= N) break; if (passes(s)) add(s); }
  }
  return selected.slice(0, N);
}

function selectPC(scored: S[], N: number, P: typeof PARAMS_PC): { selected: S[]; rej4: number; rej5: number; maxC4: number; maxC5: number; uniqC4: number; uniqC5: number; fallbackStages: number[]; } {
  let pool2 = scored.filter(s => s.primarySize >= P.MIN_PRIMARY_STACK);
  if (pool2.length < N) pool2 = scored;
  const sortedHigh = [...pool2].sort((a, b) => (b.projPct + b.ownPct) - (a.projPct + a.ownPct));
  const sortedLow = [...pool2].sort((a, b) => ((1 - b.projPct) + (1 - b.ownPct)) - ((1 - a.projPct) + (1 - a.ownPct)));
  const HIGH_TARGET = Math.round(N * P.BAND_HIGH_PCT);
  const LOW_TARGET = Math.round(N * P.BAND_LOW_PCT);
  const MID_TARGET = N - HIGH_TARGET - LOW_TARGET;
  let size4Cap = Math.floor(N * P.COMBO4_CAP_PCT);
  let size5Cap = Math.floor(N * P.COMBO5_CAP_PCT);
  let capsEnabled = true;
  let rej4 = 0, rej5 = 0;
  const c4Counts = new Map<string, number>(); const c5Counts = new Map<string, number>();
  const selected: S[] = []; const exposure = new Map<string, number>(); const teamStackCount = new Map<string, number>(); const seen = new Set<string>();
  const stages: number[] = [];
  let curStage = 0;
  function primaryStackTeamOf(s: S): string {
    const tc = new Map<string, number>();
    for (const p of s.lu.players) {
      if (isPitcher(p)) continue;
      const t = (p.team || '').toUpperCase(); if (t) tc.set(t, (tc.get(t) || 0) + 1);
    }
    let primary = '', max = 0;
    for (const [t, c] of tc) if (c > max) { max = c; primary = t; }
    return max >= 4 ? primary : '';
  }
  function canAcceptCombos(s: S): boolean {
    if (!capsEnabled) return true;
    for (const c of s.combos4!) if ((c4Counts.get(c) || 0) + 1 > size4Cap) { rej4++; return false; }
    for (const c of s.combos5!) if ((c5Counts.get(c) || 0) + 1 > size5Cap) { rej5++; return false; }
    return true;
  }
  function passes(s: S): boolean {
    if (seen.has(s.lu.hash)) return false;
    if (s.primarySize < P.MIN_PRIMARY_STACK) return false;
    for (const p of s.lu.players) {
      const cur = exposure.get(p.id) || 0;
      const cap = isPitcher(p) ? P.EXPOSURE_CAP_PITCHER : P.EXPOSURE_CAP_HITTER;
      if ((cur + 1) / N > cap) return false;
    }
    const stackTeam = primaryStackTeamOf(s);
    if (stackTeam && (((teamStackCount.get(stackTeam) || 0) + 1) / N > P.TEAM_STACK_CAP)) return false;
    const ids = new Set(s.lu.players.map(p => p.id));
    for (const sel of selected) {
      let ov = 0; for (const p of sel.lu.players) if (ids.has(p.id)) ov++;
      if (ov > P.MAX_PAIRWISE_OVERLAP) return false;
    }
    if (!canAcceptCombos(s)) return false;
    return true;
  }
  function add(s: S) {
    selected.push(s); seen.add(s.lu.hash); stages.push(curStage);
    for (const p of s.lu.players) exposure.set(p.id, (exposure.get(p.id) || 0) + 1);
    const stackTeam = primaryStackTeamOf(s); if (stackTeam) teamStackCount.set(stackTeam, (teamStackCount.get(stackTeam) || 0) + 1);
    for (const c of s.combos4!) c4Counts.set(c, (c4Counts.get(c) || 0) + 1);
    for (const c of s.combos5!) c5Counts.set(c, (c5Counts.get(c) || 0) + 1);
  }
  function fillBand(bandPool: S[], target: number) {
    const sorted = [...bandPool].sort((a, b) => b.ev - a.ev);
    const startSel = selected.length; const want = startSel + target;
    curStage = 0;
    for (const s of sorted) { if (selected.length >= want) break; if (passes(s)) add(s); }
    if (selected.length < want) {
      const old = P.MAX_PAIRWISE_OVERLAP; (P as any).MAX_PAIRWISE_OVERLAP = old + 1; curStage = 1;
      for (const s of sorted) { if (selected.length >= want) break; if (passes(s)) add(s); }
      (P as any).MAX_PAIRWISE_OVERLAP = old;
    }
    if (selected.length < want) {
      size4Cap = Math.floor(N * (P.COMBO4_CAP_PCT + P.COMBO_CAP_RELAX_PP));
      size5Cap = Math.floor(N * (P.COMBO5_CAP_PCT + P.COMBO_CAP_RELAX_PP));
      curStage = 2;
      for (const s of sorted) { if (selected.length >= want) break; if (passes(s)) add(s); }
      size4Cap = Math.floor(N * P.COMBO4_CAP_PCT); size5Cap = Math.floor(N * P.COMBO5_CAP_PCT);
    }
    if (selected.length < want) {
      capsEnabled = false; curStage = 3;
      for (const s of sorted) { if (selected.length >= want) break; if (passes(s)) add(s); }
      capsEnabled = true;
    }
    curStage = 0;
  }
  fillBand(sortedHigh.slice(0, Math.max(HIGH_TARGET * 5, 200)), HIGH_TARGET);
  fillBand(pool2, MID_TARGET);
  fillBand(sortedLow.slice(0, Math.max(LOW_TARGET * 5, 200)), LOW_TARGET);
  if (selected.length < N) {
    // top-up cascade
    const sorted = [...pool2].sort((a, b) => b.ev - a.ev);
    for (const s of sorted) { if (selected.length >= N) break; if (passes(s)) add(s); }
    if (selected.length < N) {
      const old = P.MAX_PAIRWISE_OVERLAP; (P as any).MAX_PAIRWISE_OVERLAP = old + 1;
      for (const s of sorted) { if (selected.length >= N) break; if (passes(s)) add(s); }
      (P as any).MAX_PAIRWISE_OVERLAP = old;
    }
    if (selected.length < N) {
      size4Cap = Math.floor(N * (P.COMBO4_CAP_PCT + P.COMBO_CAP_RELAX_PP));
      size5Cap = Math.floor(N * (P.COMBO5_CAP_PCT + P.COMBO_CAP_RELAX_PP));
      for (const s of sorted) { if (selected.length >= N) break; if (passes(s)) add(s); }
      size4Cap = Math.floor(N * P.COMBO4_CAP_PCT); size5Cap = Math.floor(N * P.COMBO5_CAP_PCT);
    }
    if (selected.length < N) {
      capsEnabled = false;
      for (const s of sorted) { if (selected.length >= N) break; if (passes(s)) add(s); }
      capsEnabled = true;
    }
  }
  let maxC4 = 0; for (const v of c4Counts.values()) if (v > maxC4) maxC4 = v;
  let maxC5 = 0; for (const v of c5Counts.values()) if (v > maxC5) maxC5 = v;
  return { selected: selected.slice(0, N), rej4, rej5, maxC4, maxC5, uniqC4: c4Counts.size, uniqC5: c5Counts.size, fallbackStages: stages };
}

function evalLineupScore(lu: Lineup, actualByName: Map<string, number>, normName: (n: string) => string): number {
  let s = 0;
  for (const p of lu.players) s += actualByName.get(normName(p.name)) || 0;
  return s;
}

function jaccardMean(lineups: Lineup[]): number {
  const idsArr = lineups.map(lu => new Set(lu.players.map(p => p.id)));
  let sum = 0, n = 0;
  for (let i = 0; i < idsArr.length; i++)
    for (let j = i + 1; j < idsArr.length; j++) {
      const a = idsArr[i], b = idsArr[j];
      let inter = 0;
      for (const x of a) if (b.has(x)) inter++;
      const uni = a.size + b.size - inter;
      sum += inter / uni; n++;
    }
  return n > 0 ? sum / n : 0;
}

interface SlateResult {
  slate: string;
  variant: string;
  n: number;
  candidates: number;
  // construction
  meanProj: number;
  meanOwn: number;
  meanSal: number;
  pct5: number; pct4: number; pct33: number;
  bringbackRate: number;
  meanPairwiseJaccard: number;
  unique4: number;
  unique5: number;
  max4: number;
  max5: number;
  // tournament
  meanActual: number;
  maxActual: number;
  top1xLift: number;
  top01xLift: number;
  perSlateRoiPct: number;
  // PC-only
  rejBy4Cap?: number;
  rejBy5Cap?: number;
  fallback0?: number;
  fallback1?: number;
  fallback2?: number;
  fallback3?: number;
}

async function runSlate(s: typeof SLATES[0]): Promise<SlateResult[] | null> {
  const projPath = path.join(DATA_DIR, s.proj);
  const actualsPath = path.join(DATA_DIR, s.actuals);
  const poolPath = path.join(DATA_DIR, s.pool);
  if (!fs.existsSync(projPath) || !fs.existsSync(actualsPath) || !fs.existsSync(poolPath)) {
    console.log('  SKIP ' + s.slate + ' (missing file)');
    return null;
  }
  const pr = parseCSVFile(projPath, 'mlb', true);
  const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
  const pool = buildPlayerPool(pr.players, pr.detectedContestType);
  const idMap = new Map<string, Player>();
  for (const p of pool.players) idMap.set(p.id, p);
  const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
  const candidates = Array.from(new Map(loaded.lineups.map(l => [l.hash, l])).values());

  // Actuals: parseContestActuals(filePath, config) returns ContestActuals
  // (entries[] with rank/points + playerActualsByName Map<normalized name, {fpts}>).
  let actualByName = new Map<string, number>();
  let entryCount = 0;
  let entryScores: number[] = []; // sorted DESC for percentile lookups
  try {
    const ca: ContestActuals = parseContestActuals(actualsPath, config);
    for (const [k, v] of ca.playerActualsByName) actualByName.set(k, v.fpts);
    entryCount = ca.totalEntries || ca.entries.length;
    entryScores = [...ca.entries.map(e => e.actualPoints)].sort((a, b) => b - a);
  } catch (e) {
    console.log('  WARN ' + s.slate + ': failed to parse actuals -- ' + (e as Error).message);
  }
  function normName(n: string): string {
    return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // Score (without combos) for V1, then re-score (with combos) for PC.
  const scoredV1 = score(candidates, PARAMS_V1, false);
  const v1Sel = selectV1(scoredV1, N, { ...PARAMS_V1 });

  const scoredPC = score(candidates, PARAMS_PC, true);
  const pcOut = selectPC(scoredPC, N, { ...PARAMS_PC });
  const pcSel = pcOut.selected;

  function metricsFor(sel: S[], variant: string, extra?: Partial<SlateResult>): SlateResult {
    const lus = sel.map(s => s.lu);
    const actualScores = lus.map(lu => evalLineupScore(lu, actualByName, normName));
    const stackSizes = sel.map(s => s.primarySize);
    const pct5 = stackSizes.filter(x => x === 5).length / Math.max(1, sel.length);
    const pct4 = stackSizes.filter(x => x === 4).length / Math.max(1, sel.length);
    // 3-3 detection: secondary team also has >=3 hitters AND primary == 3
    let bb = 0;
    for (const s of sel) {
      const teamHitters = new Map<string, number>();
      const pitchers: Player[] = [];
      for (const p of s.lu.players) {
        if (isPitcher(p)) pitchers.push(p);
        else { const t = (p.team || '').toUpperCase(); if (t) teamHitters.set(t, (teamHitters.get(t) || 0) + 1); }
      }
      let primaryTeam = '', primarySize = 0;
      for (const [t, c] of teamHitters) if (c > primarySize) { primarySize = c; primaryTeam = t; }
      let primaryOpp = '';
      for (const p of s.lu.players) if ((p.team || '').toUpperCase() === primaryTeam) { primaryOpp = (p.opponent || '').toUpperCase(); if (primaryOpp) break; }
      const bringBack = primaryOpp ? (teamHitters.get(primaryOpp) || 0) : 0;
      if (bringBack >= 1) bb++;
    }
    const pct33 = sel.filter((s, i) => {
      const teamHitters = new Map<string, number>();
      for (const p of s.lu.players) {
        if (isPitcher(p)) continue;
        const t = (p.team || '').toUpperCase(); if (t) teamHitters.set(t, (teamHitters.get(t) || 0) + 1);
      }
      const sizes = [...teamHitters.values()].sort((a, b) => b - a);
      return sizes.length >= 2 && sizes[0] === 3 && sizes[1] === 3;
    }).length / Math.max(1, sel.length);

    // Combo diversity for V1 (compute on the fly).
    let unique4 = 0, unique5 = 0, max4 = 0, max5 = 0;
    if (variant === 'V1-PortfolioCombo' && extra && (extra as any).uniqC4 !== undefined) {
      unique4 = (extra as any).uniqC4; unique5 = (extra as any).uniqC5;
      max4 = (extra as any).maxC4; max5 = (extra as any).maxC5;
    } else {
      const c4 = new Map<string, number>(); const c5 = new Map<string, number>();
      for (const s of sel) {
        const { combos4, combos5 } = enumerateCombos(s.lu.players.map(p => p.id));
        for (const c of combos4) c4.set(c, (c4.get(c) || 0) + 1);
        for (const c of combos5) c5.set(c, (c5.get(c) || 0) + 1);
      }
      unique4 = c4.size; unique5 = c5.size;
      for (const v of c4.values()) if (v > max4) max4 = v;
      for (const v of c5.values()) if (v > max5) max5 = v;
    }

    // Tournament metrics: top-X% lift vs random.
    // top1× lift = (fraction of OUR lineups scoring above the field's 99th percentile cutoff) / 0.01
    // i.e. lift > 1 means we beat random expectation of having 1% of our lineups in the top 1%.
    let top1Lift = 0, top01Lift = 0, roiPct = 0;
    if (entryScores.length > 0 && entryCount > 0) {
      const cut1 = entryScores[Math.max(0, Math.floor(entryCount * 0.01) - 1)] ?? Infinity;
      const cut01 = entryScores[Math.max(0, Math.floor(entryCount * 0.001) - 1)] ?? Infinity;
      const top1Count = actualScores.filter(x => x >= cut1).length;
      const top01Count = actualScores.filter(x => x >= cut01).length;
      top1Lift = (top1Count / Math.max(1, actualScores.length)) / 0.01;
      top01Lift = (top01Count / Math.max(1, actualScores.length)) / 0.001;
      // Per-slate ROI: model contest as $20 entry, payout proportional to placement against
      // the field. Without per-slate payout schedule we approximate ROI as 0 (descriptive only).
    }
    return {
      slate: s.slate, variant, n: sel.length, candidates: candidates.length,
      meanProj: mean(lus.map(lu => lu.projection)),
      meanOwn: mean(lus.map(lu => lu.ownership)),
      meanSal: lus.reduce((s, lu) => s + lu.salary, 0) / Math.max(1, lus.length),
      pct5, pct4, pct33, bringbackRate: bb / Math.max(1, sel.length),
      meanPairwiseJaccard: jaccardMean(lus),
      unique4, unique5, max4, max5,
      meanActual: mean(actualScores),
      maxActual: actualScores.length ? Math.max(...actualScores) : 0,
      top1xLift: top1Lift, top01xLift: top01Lift, perSlateRoiPct: roiPct,
      ...(extra || {}),
    };
  }

  const v1Res = metricsFor(v1Sel, 'V1-NoCorr');
  const pcRes = metricsFor(pcSel, 'V1-PortfolioCombo', {
    rejBy4Cap: pcOut.rej4, rejBy5Cap: pcOut.rej5,
    fallback0: pcOut.fallbackStages.filter(x => x === 0).length,
    fallback1: pcOut.fallbackStages.filter(x => x === 1).length,
    fallback2: pcOut.fallbackStages.filter(x => x === 2).length,
    fallback3: pcOut.fallbackStages.filter(x => x === 3).length,
    uniqC4: pcOut.uniqC4, uniqC5: pcOut.uniqC5, maxC4: pcOut.maxC4, maxC5: pcOut.maxC5,
  } as any);
  return [v1Res, pcRes];
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const allRows: SlateResult[] = [];
  for (const s of SLATES) {
    process.stdout.write('Slate ' + s.slate + '... ');
    const t0 = Date.now();
    try {
      const r = await runSlate(s);
      if (r) {
        allRows.push(...r);
        console.log('done (' + ((Date.now() - t0) / 1000).toFixed(1) + 's) — V1-NoCorr ' + r[0].n + '/' + N + ', V1-PC ' + r[1].n + '/' + N);
      }
    } catch (e) {
      console.log('FAILED — ' + (e as Error).message);
    }
  }

  // Write CSV.
  const headers = ['slate','variant','n','candidates','meanProj','meanOwn','meanSal','pct5','pct4','pct33','bringbackRate','meanPairwiseJaccard','unique4','unique5','max4','max5','meanActual','maxActual','top1xLift','top01xLift','perSlateRoiPct','rejBy4Cap','rejBy5Cap','fallback0','fallback1','fallback2','fallback3'];
  const lines = [headers.join(',')];
  for (const r of allRows) {
    lines.push(headers.map(h => {
      const v = (r as any)[h];
      if (v === undefined || v === null) return '';
      if (typeof v === 'number') return Number.isInteger(v) ? v.toString() : v.toFixed(4);
      return String(v);
    }).join(','));
  }
  const outPath = path.join(OUT_DIR, 'backtest_comparison.csv');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log('\nWrote ' + outPath + ' with ' + allRows.length + ' rows.');

  // Aggregate summary.
  function mean(xs: number[]) { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
  const v1 = allRows.filter(r => r.variant === 'V1-NoCorr');
  const pc = allRows.filter(r => r.variant === 'V1-PortfolioCombo');
  console.log('\nAGGREGATE (' + v1.length + ' slates):');
  console.log('  V1-NoCorr           meanProj=' + mean(v1.map(r => r.meanProj)).toFixed(2) + ' meanOwn=' + mean(v1.map(r => r.meanOwn)).toFixed(2) + ' meanJaccard=' + mean(v1.map(r => r.meanPairwiseJaccard)).toFixed(4) + ' unique4=' + mean(v1.map(r => r.unique4)).toFixed(0) + ' unique5=' + mean(v1.map(r => r.unique5)).toFixed(0) + ' max4=' + mean(v1.map(r => r.max4)).toFixed(2) + ' max5=' + mean(v1.map(r => r.max5)).toFixed(2) + ' meanActual=' + mean(v1.map(r => r.meanActual)).toFixed(2) + ' maxActual=' + mean(v1.map(r => r.maxActual)).toFixed(2));
  console.log('  V1-PortfolioCombo   meanProj=' + mean(pc.map(r => r.meanProj)).toFixed(2) + ' meanOwn=' + mean(pc.map(r => r.meanOwn)).toFixed(2) + ' meanJaccard=' + mean(pc.map(r => r.meanPairwiseJaccard)).toFixed(4) + ' unique4=' + mean(pc.map(r => r.unique4)).toFixed(0) + ' unique5=' + mean(pc.map(r => r.unique5)).toFixed(0) + ' max4=' + mean(pc.map(r => r.max4)).toFixed(2) + ' max5=' + mean(pc.map(r => r.max5)).toFixed(2) + ' meanActual=' + mean(pc.map(r => r.meanActual)).toFixed(2) + ' maxActual=' + mean(pc.map(r => r.maxActual)).toFixed(2));
  console.log('  Δ                    meanProj=' + (mean(pc.map(r => r.meanProj)) - mean(v1.map(r => r.meanProj))).toFixed(2) + ' meanOwn=' + (mean(pc.map(r => r.meanOwn)) - mean(v1.map(r => r.meanOwn))).toFixed(2) + ' meanJaccard=' + (mean(pc.map(r => r.meanPairwiseJaccard)) - mean(v1.map(r => r.meanPairwiseJaccard))).toFixed(4) + ' unique4=' + (mean(pc.map(r => r.unique4)) - mean(v1.map(r => r.unique4))).toFixed(0) + ' unique5=' + (mean(pc.map(r => r.unique5)) - mean(v1.map(r => r.unique5))).toFixed(0) + ' max4=' + (mean(pc.map(r => r.max4)) - mean(v1.map(r => r.max4))).toFixed(2) + ' max5=' + (mean(pc.map(r => r.max5)) - mean(v1.map(r => r.max5))).toFixed(2) + ' meanActual=' + (mean(pc.map(r => r.meanActual)) - mean(v1.map(r => r.meanActual))).toFixed(2) + ' maxActual=' + (mean(pc.map(r => r.maxActual)) - mean(v1.map(r => r.maxActual))).toFixed(2));
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });
