/**
 * Argus pro-consensus + ROI validation across the 16 dev slates.
 *
 * For each slate:
 *   - Load slate, run Argus selection (V1-MCP v3 + W_MULTI=0.40).
 *   - Compute real payout via canonical power-law schedule (FEE=$20, 88% pool,
 *     22% cash line, exponent -1.15) — same as anchor-backtest.ts.
 *   - Compute pro consensus from 150-entry-username field entries: 5 universal
 *     slate-relative metrics (projRatioToOptimal, ceilingRatioToOptimal,
 *     avgPlayerOwnPctile, ownStdRatio, ownDeltaFromAnchor).
 *   - Compute the same 5 metrics for Argus's portfolio.
 *   - Mahalanobis distance per slate: sqrt(mean_i ((argus_i - cons_mean_i) / cons_std_i)^2).
 *
 * Outputs aggregate + per-slate table.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as csvParse } from 'csv-parse/sync';
import { Lineup, Player } from '../types';
import {
  parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV,
  ContestActuals, ContestEntry,
} from '../parser';
import { getContestConfig } from '../rules';

const DIR = 'C:/Users/colin/dfs opto';
const N = 150;
const FEE = 20;

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

// Argus + V1-NoCorr params.
const PARAMS = {
  STACK_BONUS_PER_HITTER: 0, BRINGBACK_1: 0, BRINGBACK_2: 0,
  PITCHER_VS_HITTER_PENALTY: -0.10, MIN_PRIMARY_STACK: 4,
  W_PROJ: 1.0, W_LEV: 0.30, W_VAR: 0.15, W_CMB: 0.25, W_MULTI: 0.20,
  EXPOSURE_CAP_HITTER: 0.25, EXPOSURE_CAP_PITCHER: 0.45, TEAM_STACK_CAP: 0.20,
  BAND_HIGH_PCT: 0.20, BAND_LOW_PCT: 0.20, MAX_PAIRWISE_OVERLAP: 6,
  TRIPLE_FREQ_CAP: 5,
  PPD_LINEUP_PENALTY: 0.10, PPD_LINEUP_TOP_PCT: 0.10,
  TOP_K: 5, LOG_EPSILON: 1e-12, FIELD_FREQ_DEFAULT: 1e-9,
};

const UNIVERSAL_METRICS = ['projRatioToOptimal', 'ceilingRatioToOptimal', 'avgPlayerOwnPctile', 'ownStdRatio', 'ownDeltaFromAnchor'] as const;
type UniversalMetric = typeof UNIVERSAL_METRICS[number];

function isPitcher(p: Player): boolean { return (p.position || '').toUpperCase().includes('P'); }
function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function extractUser(entryName: string): string { return (entryName || '').replace(/\s*\([^)]*\)\s*$/, '').trim(); }
function mean(a: number[]): number { if (!a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; }
function stddev(a: number[]): number { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); }
function rankPercentile(values: number[]): number[] {
  const idx = values.map((v, i) => ({ v, i }));
  idx.sort((a, b) => a.v - b.v);
  const out = new Array<number>(values.length);
  for (let r = 0; r < values.length; r++) out[idx[r].i] = values.length > 1 ? r / (values.length - 1) : 0;
  return out;
}
function loadAdjOwn(p: string): Map<string, number> {
  if (!fs.existsSync(p)) return new Map();
  const records = csvParse(fs.readFileSync(p, 'utf-8'), { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
  const out = new Map<string, number>();
  for (const r of records) {
    const id = (r['DFS ID'] || r['ID'] || '').trim();
    if (!id) continue;
    const v = parseFloat((r['Adj Own'] || '').replace(/[%,]/g, ''));
    if (!Number.isNaN(v)) out.set(id, Math.max(0, v));
  }
  return out;
}
function buildPayoutTable(F: number): Float64Array {
  const pool = F * FEE * 0.88; const cashLine = Math.floor(F * 0.22);
  const raw = new Float64Array(cashLine); let rawSum = 0;
  for (let r = 0; r < cashLine; r++) { raw[r] = Math.pow(r + 1, -1.15); rawSum += raw[r]; }
  const table = new Float64Array(F); const minCash = FEE * 1.2;
  for (let r = 0; r < cashLine; r++) table[r] = Math.max(minCash, (raw[r] / rawSum) * pool);
  let tSum = 0; for (let r = 0; r < cashLine; r++) tSum += table[r];
  const scale = pool / tSum; for (let r = 0; r < cashLine; r++) table[r] *= scale;
  return table;
}
function scoreActual(lu: Lineup, actuals: ContestActuals): number | null {
  let t = 0; let miss = false;
  for (const p of lu.players) {
    const r = actuals.playerActualsByName.get(norm(p.name));
    if (!r) { miss = true; break; }
    t += r.fpts;
  }
  return miss ? null : t;
}
function scorePortfolioPayout(portfolio: Lineup[], actuals: ContestActuals, payoutTable: Float64Array): { totalPayout: number; scored: number; t1: number } {
  const F = actuals.entries.length;
  const sortedPts = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
  const top1T = sortedPts[Math.max(0, Math.floor(F * 0.01) - 1)] || 0;
  let total = 0, scored = 0, t1 = 0;
  for (const lu of portfolio) {
    const a = scoreActual(lu, actuals);
    if (a === null) continue;
    scored++;
    let lo = 0, hi = sortedPts.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (sortedPts[mid] >= a) lo = mid + 1; else hi = mid; }
    const rank = Math.max(1, lo);
    if (a >= top1T) t1++;
    const payout = rank <= payoutTable.length ? payoutTable[rank - 1] : 0;
    if (payout > 0) {
      let coWin = 0;
      for (const e of actuals.entries) if (Math.abs(e.actualPoints - a) <= 0.25) coWin++;
      coWin = Math.max(0, coWin - 1);
      total += payout / Math.sqrt(1 + coWin * 0.5);
    }
  }
  return { totalPayout: total, scored, t1 };
}

interface SlateStats {
  optimalLineupProj: number;
  optimalLineupCeiling: number;
  chalkAnchorOwn: number;
  slateAvgPlayerOwn: number;
  ownPercentileByPlayerId: Map<string, number>;
}
function computeSlateStats(players: Player[], allFieldLineups: Player[][]): SlateStats {
  let optProj = 0, optCeil = 0;
  const lineupOwnPairs: { meanOwn: number }[] = [];
  for (const lu of allFieldLineups) {
    let p = 0, c = 0, o = 0;
    for (const pl of lu) {
      p += pl.projection || 0;
      c += (pl as any).percentiles?.p75 || (pl.projection || 0) * 1.15;
      o += pl.ownership || 0;
    }
    if (p > optProj) optProj = p;
    if (c > optCeil) optCeil = c;
    lineupOwnPairs.push({ meanOwn: o / lu.length });
  }
  lineupOwnPairs.sort((a, b) => b.meanOwn - a.meanOwn);
  const topN = Math.min(100, lineupOwnPairs.length);
  const chalkAnchor = topN > 0 ? mean(lineupOwnPairs.slice(0, topN).map(x => x.meanOwn)) : 0;
  const slateAvg = mean(players.map(p => p.ownership || 0));
  const ownPctile = new Map<string, number>();
  const sortedByOwn = [...players].sort((a, b) => (a.ownership || 0) - (b.ownership || 0));
  for (let i = 0; i < sortedByOwn.length; i++) {
    ownPctile.set(sortedByOwn[i].id, sortedByOwn.length > 1 ? i / (sortedByOwn.length - 1) : 0);
  }
  return { optimalLineupProj: optProj, optimalLineupCeiling: optCeil, chalkAnchorOwn: chalkAnchor, slateAvgPlayerOwn: slateAvg, ownPercentileByPlayerId: ownPctile };
}

interface UniversalMetrics { projRatioToOptimal: number; ceilingRatioToOptimal: number; avgPlayerOwnPctile: number; ownStdRatio: number; ownDeltaFromAnchor: number }
function computeUniversal(lineups: Player[][], stats: SlateStats): UniversalMetrics {
  if (!lineups.length) return { projRatioToOptimal: 0, ceilingRatioToOptimal: 0, avgPlayerOwnPctile: 0, ownStdRatio: 0, ownDeltaFromAnchor: 0 };
  const luProjs: number[] = [], luCeils: number[] = [], luOwns: number[] = [], luOwnStds: number[] = [], pctileSums: number[] = [];
  for (const players of lineups) {
    const owns = players.map(p => p.ownership || 0);
    luOwns.push(mean(owns));
    luProjs.push(players.reduce((s, p) => s + (p.projection || 0), 0));
    luCeils.push(players.reduce((s, p) => s + ((p as any).percentiles?.p75 || (p.projection || 0) * 1.15), 0));
    luOwnStds.push(stddev(owns));
    let pSum = 0; for (const p of players) pSum += stats.ownPercentileByPlayerId.get(p.id) || 0;
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

interface S {
  lu: Lineup; primarySize: number; corrAdj: number; logOwn: number;
  uniqueness: number; multi_penalty: number; ppd: number;
  proj: number; range: number; ev: number;
  projPct: number; ownPct: number; rangePct: number; ppdPct: number;
  uniqPct: number; multiPct: number;
}

function selectArgus(candidates: Lineup[], adjOwnById: Map<string, number>): S[] {
  // V1 pair/triple freqs (proj-weighted).
  const v1Pair = new Map<string, number>(); const v1Trip = new Map<string, number>();
  let totalW = 0;
  for (const lu of candidates) {
    const w = Math.max(0.1, lu.projection || 1) ** 2; totalW += w;
    const ids = lu.players.map(p => p.id).sort();
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      v1Pair.set(ids[i] + '|' + ids[j], (v1Pair.get(ids[i] + '|' + ids[j]) || 0) + w);
      for (let l = j + 1; l < ids.length; l++) {
        const k = ids[i] + '|' + ids[j] + '|' + ids[l];
        v1Trip.set(k, (v1Trip.get(k) || 0) + w);
      }
    }
  }
  for (const k of v1Pair.keys()) v1Pair.set(k, v1Pair.get(k)! / totalW);
  for (const k of v1Trip.keys()) v1Trip.set(k, v1Trip.get(k)! / totalW);

  // Field combo freqs.
  const ownDecById = new Map<string, number>();
  for (const lu of candidates) for (const p of lu.players) {
    if (ownDecById.has(p.id)) continue;
    const adj = adjOwnById.get(p.id);
    const o = (adj !== undefined ? adj : (p.ownership || 0)) / 100;
    ownDecById.set(p.id, Math.max(0, o));
  }
  const fcPair = new Map<string, number>(); const fcTrip = new Map<string, number>();
  const fcQuad = new Map<string, number>(); const fcQuint = new Map<string, number>();
  for (const lu of candidates) {
    const ids = lu.players.map(p => p.id).sort();
    const n = ids.length;
    for (let i = 0; i < n; i++) {
      const oi = ownDecById.get(ids[i]) || 0;
      for (let j = i + 1; j < n; j++) {
        const oj = ownDecById.get(ids[j]) || 0;
        const k2 = ids[i] + '|' + ids[j];
        if (!fcPair.has(k2)) fcPair.set(k2, oi * oj);
        for (let l = j + 1; l < n; l++) {
          const ol = ownDecById.get(ids[l]) || 0;
          const k3 = ids[i] + '|' + ids[j] + '|' + ids[l];
          if (!fcTrip.has(k3)) fcTrip.set(k3, oi * oj * ol);
          for (let m = l + 1; m < n; m++) {
            const om = ownDecById.get(ids[m]) || 0;
            const k4 = ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m];
            if (!fcQuad.has(k4)) fcQuad.set(k4, oi * oj * ol * om);
            for (let q = m + 1; q < n; q++) {
              const oq = ownDecById.get(ids[q]) || 0;
              const k5 = ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m] + '|' + ids[q];
              if (!fcQuint.has(k5)) fcQuint.set(k5, oi * oj * ol * om * oq);
            }
          }
        }
      }
    }
  }
  function mapMedian(m: Map<string, number>): number {
    if (m.size === 0) return 1; const arr: number[] = []; for (const v of m.values()) arr.push(v);
    arr.sort((a, b) => a - b); return arr[Math.floor(arr.length / 2)] || 1;
  }
  const med2 = mapMedian(fcPair), med3 = mapMedian(fcTrip), med4 = mapMedian(fcQuad), med5 = mapMedian(fcQuint);

  // Score each candidate.
  const scored: S[] = [];
  for (const lu of candidates) {
    let floor = 0, ceiling = 0;
    for (const p of lu.players) {
      if (p.percentiles) { floor += p.percentiles.p25 || p.projection * 0.85; ceiling += p.percentiles.p75 || p.projection * 1.15; }
      else { floor += p.projection * 0.85; ceiling += p.projection * 1.15; }
    }
    const teamHitters = new Map<string, number>(); const pitchers: Player[] = [];
    for (const p of lu.players) {
      if (isPitcher(p)) pitchers.push(p);
      else { const t = (p.team || '').toUpperCase(); if (t) teamHitters.set(t, (teamHitters.get(t) || 0) + 1); }
    }
    let primaryTeam = '', primarySize = 0;
    for (const [t, c] of teamHitters) if (c > primarySize) { primarySize = c; primaryTeam = t; }
    let pOppHitters = 0;
    for (const p of pitchers) { const o = (p.opponent || '').toUpperCase(); if (o) pOppHitters += teamHitters.get(o) || 0; }
    const corrAdj = PARAMS.PITCHER_VS_HITTER_PENALTY * pOppHitters;

    let uniqueness = 0;
    const players = lu.players;
    for (let i = 0; i < players.length; i++) for (let j = i + 1; j < players.length; j++) {
      const k = [players[i].id, players[j].id].sort().join('|');
      uniqueness += -Math.log(v1Pair.get(k) || 1e-6);
    }
    const tripFs: number[] = [];
    for (let i = 0; i < players.length; i++) for (let j = i + 1; j < players.length; j++) for (let l = j + 1; l < players.length; l++) {
      const tk = [players[i].id, players[j].id, players[l].id].sort().join('|');
      tripFs.push(v1Trip.get(tk) || 1e-6);
    }
    tripFs.sort((a, b) => b - a);
    for (const f of tripFs.slice(0, PARAMS.TRIPLE_FREQ_CAP)) uniqueness += -Math.log(f);

    // Argus penalty.
    const ids = players.map(p => p.id).sort();
    const slots: { f: number; r: number }[] = [];
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const f2 = fcPair.get(ids[i] + '|' + ids[j]) ?? PARAMS.FIELD_FREQ_DEFAULT;
      slots.push({ f: f2, r: f2 / med2 });
      for (let l = j + 1; l < ids.length; l++) {
        const f3 = fcTrip.get(ids[i] + '|' + ids[j] + '|' + ids[l]) ?? PARAMS.FIELD_FREQ_DEFAULT;
        slots.push({ f: f3, r: f3 / med3 });
        for (let m = l + 1; m < ids.length; m++) {
          const f4 = fcQuad.get(ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m]) ?? PARAMS.FIELD_FREQ_DEFAULT;
          slots.push({ f: f4, r: f4 / med4 });
          for (let q = m + 1; q < ids.length; q++) {
            const f5 = fcQuint.get(ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m] + '|' + ids[q]) ?? PARAMS.FIELD_FREQ_DEFAULT;
            slots.push({ f: f5, r: f5 / med5 });
          }
        }
      }
    }
    slots.sort((a, b) => b.r - a.r);
    let prodR = 1; for (const s of slots.slice(0, PARAMS.TOP_K)) prodR *= s.r;
    const multi_penalty = -Math.log(prodR + PARAMS.LOG_EPSILON);

    let logOwn = 0;
    for (const p of lu.players) { if (isPitcher(p)) continue; logOwn += Math.log(Math.max(0.1, p.ownership || 0.5)); }
    let ppd = 0;
    for (const p of lu.players) if (p.salary && p.projection) ppd += p.projection / (p.salary / 1000);

    scored.push({
      lu, primarySize, corrAdj, logOwn, uniqueness, multi_penalty, ppd,
      proj: lu.projection, range: ceiling - floor, ev: 0,
      projPct: 0, ownPct: 0, rangePct: 0, ppdPct: 0, uniqPct: 0, multiPct: 0,
    });
  }

  const projAdj = scored.map(s => s.proj * (1 + s.corrAdj));
  const projPct = rankPercentile(projAdj);
  const ownPct = rankPercentile(scored.map(s => s.logOwn));
  const rangePct = rankPercentile(scored.map(s => s.range));
  const ppdPct = rankPercentile(scored.map(s => s.ppd));
  const uniqPct = rankPercentile(scored.map(s => s.uniqueness));
  const multiPct = rankPercentile(scored.map(s => s.multi_penalty));
  for (let i = 0; i < scored.length; i++) {
    scored[i].projPct = projPct[i]; scored[i].ownPct = ownPct[i];
    scored[i].rangePct = rangePct[i]; scored[i].ppdPct = ppdPct[i];
    scored[i].uniqPct = uniqPct[i]; scored[i].multiPct = multiPct[i];
    let ev = PARAMS.W_PROJ * projPct[i] + PARAMS.W_LEV * (1 - ownPct[i]) + PARAMS.W_VAR * rangePct[i] * 0.85 + PARAMS.W_CMB * uniqPct[i] + PARAMS.W_MULTI * multiPct[i];
    if (ppdPct[i] >= 1 - PARAMS.PPD_LINEUP_TOP_PCT) ev *= (1 - PARAMS.PPD_LINEUP_PENALTY);
    scored[i].ev = ev;
  }

  // Greedy fill.
  let pool2 = scored.filter(s => s.primarySize >= PARAMS.MIN_PRIMARY_STACK);
  if (pool2.length < N) pool2 = scored;
  const sortedHigh = [...pool2].sort((a, b) => (b.projPct + b.ownPct) - (a.projPct + a.ownPct));
  const sortedLow = [...pool2].sort((a, b) => ((1 - b.projPct) + (1 - b.ownPct)) - ((1 - a.projPct) + (1 - a.ownPct)));
  const HIGH = Math.round(N * PARAMS.BAND_HIGH_PCT);
  const LOW = Math.round(N * PARAMS.BAND_LOW_PCT);
  const MID = N - HIGH - LOW;
  const sel: S[] = []; const exposure = new Map<string, number>(); const teamCount = new Map<string, number>(); const seen = new Set<string>();
  function primaryStackTeamOf(s: S): string {
    const tc = new Map<string, number>();
    for (const p of s.lu.players) {
      if (isPitcher(p)) continue; const t = (p.team || '').toUpperCase();
      if (t) tc.set(t, (tc.get(t) || 0) + 1);
    }
    let pri = '', max = 0; for (const [t, c] of tc) if (c > max) { max = c; pri = t; }
    return max >= 4 ? pri : '';
  }
  function passes(s: S, maxOv: number): boolean {
    if (seen.has(s.lu.hash)) return false;
    if (s.primarySize < PARAMS.MIN_PRIMARY_STACK) return false;
    for (const p of s.lu.players) {
      const cur = exposure.get(p.id) || 0;
      const cap = isPitcher(p) ? PARAMS.EXPOSURE_CAP_PITCHER : PARAMS.EXPOSURE_CAP_HITTER;
      if ((cur + 1) / N > cap) return false;
    }
    const st = primaryStackTeamOf(s);
    if (st && (((teamCount.get(st) || 0) + 1) / N > PARAMS.TEAM_STACK_CAP)) return false;
    const ids = new Set(s.lu.players.map(p => p.id));
    for (const x of sel) {
      let ov = 0; for (const p of x.lu.players) if (ids.has(p.id)) ov++;
      if (ov > maxOv) return false;
    }
    return true;
  }
  function add(s: S) {
    sel.push(s); seen.add(s.lu.hash);
    for (const p of s.lu.players) exposure.set(p.id, (exposure.get(p.id) || 0) + 1);
    const st = primaryStackTeamOf(s); if (st) teamCount.set(st, (teamCount.get(st) || 0) + 1);
  }
  function fill(bp: S[], target: number) {
    const sorted = [...bp].sort((a, b) => b.ev - a.ev);
    let added = 0;
    for (const s of sorted) { if (added >= target) break; if (passes(s, PARAMS.MAX_PAIRWISE_OVERLAP)) { add(s); added++; } }
    if (added < target) for (const s of sorted) { if (added >= target) break; if (passes(s, PARAMS.MAX_PAIRWISE_OVERLAP + 1)) { add(s); added++; } }
  }
  fill(sortedHigh.slice(0, Math.max(HIGH * 5, 200)), HIGH);
  fill(pool2, MID);
  fill(sortedLow.slice(0, Math.max(LOW * 5, 200)), LOW);
  if (sel.length < N) {
    const sorted = [...pool2].sort((a, b) => b.ev - a.ev);
    for (const s of sorted) { if (sel.length >= N) break; if (passes(s, PARAMS.MAX_PAIRWISE_OVERLAP + 1)) add(s); }
  }
  return sel.slice(0, N);
}

interface SlateRow {
  slate: string;
  fieldSize: number;
  pros150: number;
  argusActual: number;
  argusMax: number;
  argusPay: number;
  argusCost: number;
  argusROI: number;
  argusT1: number;
  // pro consensus mahalanobis
  mahalanobis: number | null;
  proConsM: UniversalMetrics | null;
  argusM: UniversalMetrics;
}

async function main() {
  console.log('=== ARGUS-W20 pro-consensus + ROI validation, 16 dev slates ===\n');

  const rows: SlateRow[] = [];
  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj), actualsPath = path.join(DIR, s.actuals), poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) { console.log('skip ' + s.slate); continue; }
    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);
    const adjOwnById = loadAdjOwn(projPath);
    const idMap = new Map<string, Player>(); const nameMap = new Map<string, Player>();
    for (const p of pool.players) { idMap.set(p.id, p); nameMap.set(norm(p.name), p); }
    const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
    const candidates = Array.from(new Map(loaded.lineups.map(l => [l.hash, l])).values());

    // Build all field lineups (all entries) for slate stats.
    const fieldLineups: Player[][] = [];
    const fieldEntriesByUser = new Map<string, ContestEntry[]>();
    for (const e of actuals.entries) {
      const pls: Player[] = []; let ok = true;
      for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
      if (ok) fieldLineups.push(pls);
      const u = extractUser(e.entryName);
      if (!fieldEntriesByUser.has(u)) fieldEntriesByUser.set(u, []);
      fieldEntriesByUser.get(u)!.push(e);
    }
    const slateStats = computeSlateStats(pool.players, fieldLineups);

    // Run Argus.
    const argusSel = selectArgus(candidates, adjOwnById);
    const argusLineups = argusSel.map(s => s.lu.players);

    // Argus universal metrics.
    const argusM = computeUniversal(argusLineups, slateStats);

    // Pro consensus: 150-entry usernames.
    const proLineups: Player[][] = [];
    let pros150 = 0;
    for (const [u, ents] of fieldEntriesByUser) {
      if (ents.length !== 150) continue;
      pros150++;
      // Use this pro's lineups
      const proLus: Player[][] = [];
      for (const e of ents) {
        const pls: Player[] = []; let ok = true;
        for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
        if (ok) proLus.push(pls);
      }
      if (proLus.length > 0) {
        for (const lu of proLus) proLineups.push(lu);
      }
    }

    // Compute consensus from all pros' lineups (each pro's portfolio's universal metrics).
    let proConsM: UniversalMetrics | null = null;
    let mahalanobis: number | null = null;
    if (pros150 >= 3) {
      const proPortfolioMetrics: UniversalMetrics[] = [];
      for (const [u, ents] of fieldEntriesByUser) {
        if (ents.length !== 150) continue;
        const proLus: Player[][] = [];
        for (const e of ents) {
          const pls: Player[] = []; let ok = true;
          for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
          if (ok) proLus.push(pls);
        }
        if (proLus.length >= 100) proPortfolioMetrics.push(computeUniversal(proLus, slateStats));
      }
      if (proPortfolioMetrics.length >= 3) {
        const cons: any = {};
        for (const k of UNIVERSAL_METRICS) {
          const vals = proPortfolioMetrics.map(m => m[k]);
          cons[k] = { mean: mean(vals), std: stddev(vals) };
        }
        proConsM = { projRatioToOptimal: cons.projRatioToOptimal.mean, ceilingRatioToOptimal: cons.ceilingRatioToOptimal.mean, avgPlayerOwnPctile: cons.avgPlayerOwnPctile.mean, ownStdRatio: cons.ownStdRatio.mean, ownDeltaFromAnchor: cons.ownDeltaFromAnchor.mean };
        // Mahalanobis
        let sum = 0; let n = 0;
        for (const k of UNIVERSAL_METRICS) {
          const c = cons[k]; if (c.std < 1e-9) continue;
          const d = (argusM[k] - c.mean) / c.std;
          sum += d * d; n++;
        }
        mahalanobis = n > 0 ? Math.sqrt(sum / n) : null;
      }
    }

    // Real ROI via canonical payout schedule.
    const F = actuals.entries.length;
    const payoutTable = buildPayoutTable(F);
    const argusActuals = argusSel.map(s => scoreActual(s.lu, actuals)).filter((x): x is number => x !== null);
    const { totalPayout, scored, t1 } = scorePortfolioPayout(argusSel.map(s => s.lu), actuals, payoutTable);
    const argusCost = N * FEE;

    rows.push({
      slate: s.slate, fieldSize: F, pros150,
      argusActual: mean(argusActuals), argusMax: argusActuals.length ? Math.max(...argusActuals) : 0,
      argusPay: totalPayout, argusCost, argusROI: argusCost > 0 ? (totalPayout / argusCost - 1) * 100 : 0,
      argusT1: t1, mahalanobis, proConsM, argusM,
    });
    console.log(`  ${s.slate.padEnd(15)} F=${String(F).padStart(6)}  pros150=${String(pros150).padStart(3)}  pay=$${totalPayout.toFixed(0).padStart(5)}  ROI=${(argusCost > 0 ? (totalPayout / argusCost - 1) * 100 : 0).toFixed(1).padStart(6)}%  t1=${String(t1).padStart(3)}  Mahal=${mahalanobis?.toFixed(2).padStart(5) || ' n/a'}`);
  }

  // Aggregate.
  console.log('\n================================================================');
  console.log('AGGREGATE');
  console.log('================================================================');
  const totalPay = rows.reduce((s, r) => s + r.argusPay, 0);
  const totalCost = rows.reduce((s, r) => s + r.argusCost, 0);
  const aggROI = totalCost > 0 ? (totalPay / totalCost - 1) * 100 : 0;
  const profitable = rows.filter(r => r.argusPay > r.argusCost).length;
  const breakEven = rows.filter(r => r.argusPay > 0).length;
  const validMahal = rows.filter(r => r.mahalanobis !== null).map(r => r.mahalanobis!);
  console.log('Slates:        ' + rows.length);
  console.log('Total payout:  $' + totalPay.toFixed(0));
  console.log('Total cost:    $' + totalCost.toFixed(0) + ' (' + N + ' lineups × $' + FEE + ' × ' + rows.length + ' slates)');
  console.log('Aggregate ROI: ' + aggROI.toFixed(2) + '%');
  console.log('Profitable slates: ' + profitable + '/' + rows.length + ' (' + (profitable / rows.length * 100).toFixed(0) + '%)');
  console.log('Cash slates:       ' + breakEven + '/' + rows.length + ' (any payout)');
  console.log('Total t1 hits: ' + rows.reduce((s, r) => s + r.argusT1, 0));
  console.log('');
  if (validMahal.length > 0) {
    console.log('Mahalanobis to pro consensus (5 universal metrics, ' + validMahal.length + ' slates with ≥3 pros):');
    console.log('  mean:   ' + mean(validMahal).toFixed(3));
    console.log('  median: ' + [...validMahal].sort((a, b) => a - b)[Math.floor(validMahal.length / 2)].toFixed(3));
    console.log('  min:    ' + Math.min(...validMahal).toFixed(3));
    console.log('  max:    ' + Math.max(...validMahal).toFixed(3));
    const within15 = validMahal.filter(d => d < 1.5).length;
    const within20 = validMahal.filter(d => d < 2.0).length;
    console.log('  within d<1.5 (gate): ' + within15 + '/' + validMahal.length + ' slates');
    console.log('  within d<2.0:        ' + within20 + '/' + validMahal.length + ' slates');
  }

  // Per-slate table.
  console.log('\n================================================================');
  console.log('PER-SLATE');
  console.log('================================================================');
  console.log('slate          | F      | pros | pay      | cost   | ROI%   | t1 | Mahal');
  for (const r of rows) {
    console.log(
      r.slate.padEnd(15) + '|' +
      String(r.fieldSize).padStart(7) + ' |' +
      String(r.pros150).padStart(5) + ' |' +
      ('$' + r.argusPay.toFixed(0)).padStart(9) + ' |' +
      ('$' + r.argusCost.toFixed(0)).padStart(7) + ' |' +
      r.argusROI.toFixed(1).padStart(7) + ' |' +
      String(r.argusT1).padStart(3) + ' |' +
      (r.mahalanobis !== null ? r.mahalanobis.toFixed(2) : 'n/a').padStart(6)
    );
  }
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
