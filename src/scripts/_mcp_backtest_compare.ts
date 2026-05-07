/**
 * Argus (V1-MultiComboPenalty v3) backtest descriptive comparison harness.
 *
 * Runs both V1-NoCorr and Argus on each of the 16 dev slates
 * (HOLDOUT sealed per slate_derived_research/HOLDOUT_LOCK.md) and emits
 * one CSV row per slate per variant covering construction metrics +
 * tournament metrics (descriptive only — Phase 1 NO-GO means backtest is
 * NOT a deployment criterion).
 *
 * Stage 4 of multi_combo_penalty_implementation/IMPLEMENTATION_NOTES.md.
 *
 * Output: multi_combo_penalty_implementation/backtest_comparison.csv
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as csvParse } from 'csv-parse/sync';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals } from '../parser';
import { getContestConfig } from '../rules';

const DATA_DIR = 'C:/Users/colin/dfs opto';
const OUT_DIR = path.join(DATA_DIR, 'multi_combo_penalty_implementation');
const N = 150;

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

const PARAMS_MCP = {
  ...PARAMS_V1,
  W_MULTI: 0.40,             // Argus
  TOP_K: 5,
  LOG_EPSILON: 1e-12,
  FIELD_FREQ_DEFAULT: 1e-9,
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

function loadAdjOwn(projPath: string): Map<string, number> {
  if (!fs.existsSync(projPath)) return new Map();
  const content = fs.readFileSync(projPath, 'utf-8');
  const records = csvParse(content, { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
  const out = new Map<string, number>();
  for (const r of records) {
    const id = (r['DFS ID'] || r['ID'] || '').toString().trim();
    if (!id) continue;
    const v = parseFloat((r['Adj Own'] || '').toString().replace(/[%,]/g, ''));
    if (!Number.isNaN(v)) out.set(id, Math.max(0, v));
  }
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

interface S {
  lu: Lineup;
  primarySize: number;
  corrAdj: number;
  logOwn: number;
  uniqueness: number;
  multi_penalty: number;
  top_concentration: number;
  ppd: number;
  proj: number; floor: number; ceiling: number; range: number;
  ev: number;
  projPct: number; ownPct: number; rangePct: number; ppdPct: number;
  uniqPct: number; multiPct: number;
}

function score(candidates: Lineup[], adjOwnById: Map<string, number>, P: typeof PARAMS_MCP): S[] {
  // V1 pair/triple frequencies (projection-weighted).
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

  // Field combo frequencies (Adj Own product, sizes 2-5).
  const ownDecById = new Map<string, number>();
  for (const lu of candidates) for (const p of lu.players) {
    if (ownDecById.has(p.id)) continue;
    const adj = adjOwnById.get(p.id);
    const o = (adj !== undefined ? adj : (p.ownership || 0)) / 100;
    ownDecById.set(p.id, Math.max(0, o));
  }
  const fcPair = new Map<string, number>();
  const fcTrip = new Map<string, number>();
  const fcQuad = new Map<string, number>();
  const fcQuint = new Map<string, number>();
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

  // Argus medians per size (chalk-ratio rescaling).
  function mapMedian(m: Map<string, number>): number {
    if (m.size === 0) return 1;
    const arr: number[] = []; for (const v of m.values()) arr.push(v);
    arr.sort((a, b) => a - b); return arr[Math.floor(arr.length / 2)] || 1;
  }
  const med2 = mapMedian(fcPair);
  const med3 = mapMedian(fcTrip);
  const med4 = mapMedian(fcQuad);
  const med5 = mapMedian(fcQuint);

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
    const tripFs: number[] = [];
    for (let i = 0; i < players.length; i++)
      for (let j = i + 1; j < players.length; j++)
        for (let l = j + 1; l < players.length; l++) {
          const tk = [players[i].id, players[j].id, players[l].id].sort().join('|');
          tripFs.push(tripFreq.get(tk) || 1e-6);
        }
    tripFs.sort((a, b) => b - a);
    for (const f of tripFs.slice(0, P.TRIPLE_FREQ_CAP)) uniqueness += -Math.log(f);

    // Argus penalty: median-rescaled chalk-ratio top-K product.
    const ids = players.map(p => p.id).sort();
    const slots: { f: number; r: number }[] = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const f2 = fcPair.get(ids[i] + '|' + ids[j]) ?? P.FIELD_FREQ_DEFAULT;
        slots.push({ f: f2, r: f2 / med2 });
        for (let l = j + 1; l < ids.length; l++) {
          const f3 = fcTrip.get(ids[i] + '|' + ids[j] + '|' + ids[l]) ?? P.FIELD_FREQ_DEFAULT;
          slots.push({ f: f3, r: f3 / med3 });
          for (let m = l + 1; m < ids.length; m++) {
            const f4 = fcQuad.get(ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m]) ?? P.FIELD_FREQ_DEFAULT;
            slots.push({ f: f4, r: f4 / med4 });
            for (let q = m + 1; q < ids.length; q++) {
              const f5 = fcQuint.get(ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m] + '|' + ids[q]) ?? P.FIELD_FREQ_DEFAULT;
              slots.push({ f: f5, r: f5 / med5 });
            }
          }
        }
      }
    }
    slots.sort((a, b) => b.r - a.r);
    const topK = slots.slice(0, P.TOP_K);
    let prodR = 1, prodF = 1; for (const s of topK) { prodR *= s.r; prodF *= s.f; }
    const multi_penalty = -Math.log(prodR + P.LOG_EPSILON);

    let logOwn = 0;
    for (const p of lu.players) {
      if (isPitcher(p)) continue;
      logOwn += Math.log(Math.max(0.1, p.ownership || 0.5));
    }
    let ppd = 0;
    for (const p of lu.players) if (p.salary && p.projection) ppd += p.projection / (p.salary / 1000);

    scored.push({
      lu, primarySize, corrAdj, logOwn, uniqueness,
      multi_penalty, top_concentration: prodF,
      ppd, proj: lu.projection, floor, ceiling, range: ceiling - floor,
      ev: 0, projPct: 0, ownPct: 0, rangePct: 0, ppdPct: 0, uniqPct: 0, multiPct: 0,
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
  }
  return scored;
}

function applyEv(scored: S[], P: typeof PARAMS_MCP, useMulti: boolean): void {
  for (const s of scored) {
    let ev = P.W_PROJ * s.projPct + P.W_LEV * (1 - s.ownPct)
           + P.W_VAR * s.rangePct * 0.85 + P.W_CMB * s.uniqPct;
    if (useMulti) ev += P.W_MULTI * s.multiPct;
    if (s.ppdPct >= 1 - P.PPD_LINEUP_TOP_PCT) ev *= (1 - P.PPD_LINEUP_PENALTY);
    s.ev = ev;
  }
}

function selectGreedy(scored: S[], N: number, P: typeof PARAMS_V1): S[] {
  let pool2 = scored.filter(s => s.primarySize >= P.MIN_PRIMARY_STACK);
  if (pool2.length < N) pool2 = scored;
  const sortedHigh = [...pool2].sort((a, b) => (b.projPct + b.ownPct) - (a.projPct + a.ownPct));
  const sortedLow = [...pool2].sort((a, b) => ((1 - b.projPct) + (1 - b.ownPct)) - ((1 - a.projPct) + (1 - a.ownPct)));
  const HIGH_TARGET = Math.round(N * P.BAND_HIGH_PCT);
  const LOW_TARGET = Math.round(N * P.BAND_LOW_PCT);
  const MID_TARGET = N - HIGH_TARGET - LOW_TARGET;
  const selected: S[] = [];
  const exposure = new Map<string, number>();
  const teamStackCount = new Map<string, number>();
  const seen = new Set<string>();
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
  function passes(s: S, maxOverlap: number): boolean {
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
      if (ov > maxOverlap) return false;
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
    for (const s of sorted) { if (added >= target) break; if (passes(s, P.MAX_PAIRWISE_OVERLAP)) { add(s); added++; } }
    if (added < target) {
      for (const s of sorted) { if (added >= target) break; if (passes(s, P.MAX_PAIRWISE_OVERLAP + 1)) { add(s); added++; } }
    }
  }
  fillBand(sortedHigh.slice(0, Math.max(HIGH_TARGET * 5, 200)), HIGH_TARGET);
  fillBand(pool2, MID_TARGET);
  fillBand(sortedLow.slice(0, Math.max(LOW_TARGET * 5, 200)), LOW_TARGET);
  if (selected.length < N) {
    const sorted = [...pool2].sort((a, b) => b.ev - a.ev);
    for (const s of sorted) { if (selected.length >= N) break; if (passes(s, P.MAX_PAIRWISE_OVERLAP + 1)) add(s); }
  }
  return selected.slice(0, N);
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

function jaccardMax(lineups: Lineup[]): number {
  const idsArr = lineups.map(lu => new Set(lu.players.map(p => p.id)));
  let mx = 0;
  for (let i = 0; i < idsArr.length; i++)
    for (let j = i + 1; j < idsArr.length; j++) {
      const a = idsArr[i], b = idsArr[j];
      let inter = 0;
      for (const x of a) if (b.has(x)) inter++;
      const uni = a.size + b.size - inter;
      const j2 = inter / uni;
      if (j2 > mx) mx = j2;
    }
  return mx;
}

interface SlateResult {
  slate: string;
  variant: string;
  n: number;
  candidates: number;
  meanProj: number;
  meanOwn: number;
  meanSal: number;
  pct5: number;
  pct4: number;
  bringbackRate: number;
  meanPairwiseJaccard: number;
  maxPairwiseJaccard: number;
  unique4: number;
  unique5: number;
  max4: number;
  max5: number;
  meanMultiPenalty: number;
  meanTopConcentration: number;
  maxTopConcentration: number;
  bandHigh: number;
  bandMid: number;
  bandLow: number;
  meanActual: number;
  maxActual: number;
  top1xLift: number;
  top01xLift: number;
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
  const adjOwnById = loadAdjOwn(projPath);
  const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
  const candidates = Array.from(new Map(loaded.lineups.map(l => [l.hash, l])).values());

  let actualByName = new Map<string, number>();
  let entryCount = 0;
  let entryScores: number[] = [];
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

  // Score once with shared pair/triple + field freqs (both variants).
  const scoredV1 = score(candidates, adjOwnById, PARAMS_MCP);
  applyEv(scoredV1, PARAMS_MCP, false);
  const v1Sel = selectGreedy(scoredV1, N, { ...PARAMS_V1 });

  const scoredMCP = score(candidates, adjOwnById, PARAMS_MCP);
  applyEv(scoredMCP, PARAMS_MCP, true);
  const mcpSel = selectGreedy(scoredMCP, N, { ...PARAMS_V1 });

  function metricsFor(sel: S[], variant: string): SlateResult {
    const lus = sel.map(s => s.lu);
    const actualScores = lus.map(lu => evalLineupScore(lu, actualByName, normName));
    const stackSizes = sel.map(s => s.primarySize);
    const pct5 = stackSizes.filter(x => x === 5).length / Math.max(1, sel.length);
    const pct4 = stackSizes.filter(x => x === 4).length / Math.max(1, sel.length);
    let bb = 0;
    for (const sc of sel) {
      const teamHitters = new Map<string, number>();
      const pitchers: Player[] = [];
      for (const p of sc.lu.players) {
        if (isPitcher(p)) pitchers.push(p);
        else { const t = (p.team || '').toUpperCase(); if (t) teamHitters.set(t, (teamHitters.get(t) || 0) + 1); }
      }
      let primaryTeam = '', primarySize = 0;
      for (const [t, c] of teamHitters) if (c > primarySize) { primarySize = c; primaryTeam = t; }
      let primaryOpp = '';
      for (const p of sc.lu.players) if ((p.team || '').toUpperCase() === primaryTeam) { primaryOpp = (p.opponent || '').toUpperCase(); if (primaryOpp) break; }
      const bringBack = primaryOpp ? (teamHitters.get(primaryOpp) || 0) : 0;
      if (bringBack >= 1) bb++;
    }
    const c4 = new Map<string, number>(); const c5 = new Map<string, number>();
    for (const sc of sel) {
      const { combos4, combos5 } = enumerateCombos(sc.lu.players.map(p => p.id));
      for (const c of combos4) c4.set(c, (c4.get(c) || 0) + 1);
      for (const c of combos5) c5.set(c, (c5.get(c) || 0) + 1);
    }
    let max4 = 0, max5 = 0;
    for (const v of c4.values()) if (v > max4) max4 = v;
    for (const v of c5.values()) if (v > max5) max5 = v;

    let top1Lift = 0, top01Lift = 0;
    if (entryScores.length > 0 && entryCount > 0) {
      const cut1 = entryScores[Math.max(0, Math.floor(entryCount * 0.01) - 1)] ?? Infinity;
      const cut01 = entryScores[Math.max(0, Math.floor(entryCount * 0.001) - 1)] ?? Infinity;
      const top1Count = actualScores.filter(x => x >= cut1).length;
      const top01Count = actualScores.filter(x => x >= cut01).length;
      top1Lift = (top1Count / Math.max(1, actualScores.length)) / 0.01;
      top01Lift = (top01Count / Math.max(1, actualScores.length)) / 0.001;
    }

    // Variance band proxy: re-derive using projPct + ownPct medians.
    const sortedByH = [...sel].sort((a, b) => (b.projPct + b.ownPct) - (a.projPct + a.ownPct));
    const high30 = new Set(sortedByH.slice(0, Math.round(sel.length * 0.20)).map(x => x.lu.hash));
    const sortedByL = [...sel].sort((a, b) => ((1 - b.projPct) + (1 - b.ownPct)) - ((1 - a.projPct) + (1 - a.ownPct)));
    const low30 = new Set(sortedByL.slice(0, Math.round(sel.length * 0.20)).map(x => x.lu.hash));
    let bandHigh = 0, bandLow = 0;
    for (const sc of sel) {
      if (high30.has(sc.lu.hash)) bandHigh++;
      else if (low30.has(sc.lu.hash)) bandLow++;
    }

    return {
      slate: s.slate, variant, n: sel.length, candidates: candidates.length,
      meanProj: mean(lus.map(lu => lu.projection)),
      meanOwn: mean(lus.map(lu => lu.ownership)),
      meanSal: lus.reduce((s, lu) => s + lu.salary, 0) / Math.max(1, lus.length),
      pct5, pct4, bringbackRate: bb / Math.max(1, sel.length),
      meanPairwiseJaccard: jaccardMean(lus),
      maxPairwiseJaccard: jaccardMax(lus),
      unique4: c4.size, unique5: c5.size, max4, max5,
      meanMultiPenalty: mean(sel.map(x => x.multi_penalty)),
      meanTopConcentration: mean(sel.map(x => x.top_concentration)),
      maxTopConcentration: Math.max(...sel.map(x => x.top_concentration)),
      bandHigh, bandMid: sel.length - bandHigh - bandLow, bandLow,
      meanActual: mean(actualScores),
      maxActual: actualScores.length ? Math.max(...actualScores) : 0,
      top1xLift: top1Lift, top01xLift: top01Lift,
    };
  }

  return [metricsFor(v1Sel, 'V1-NoCorr'), metricsFor(mcpSel, 'Argus')];
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
        console.log('done (' + ((Date.now() - t0) / 1000).toFixed(1) + 's) — V1 ' + r[0].n + '/' + N + ', Argus ' + r[1].n + '/' + N);
      }
    } catch (e) {
      console.log('FAILED — ' + (e as Error).message);
    }
  }

  const headers = ['slate','variant','n','candidates','meanProj','meanOwn','meanSal','pct5','pct4','bringbackRate','meanPairwiseJaccard','maxPairwiseJaccard','unique4','unique5','max4','max5','meanMultiPenalty','meanTopConcentration','maxTopConcentration','bandHigh','bandMid','bandLow','meanActual','maxActual','top1xLift','top01xLift'];
  const lines = [headers.join(',')];
  for (const r of allRows) {
    lines.push(headers.map(h => {
      const v = (r as any)[h];
      if (v === undefined || v === null) return '';
      if (typeof v === 'number') {
        if (Number.isInteger(v)) return v.toString();
        if (Math.abs(v) > 0 && (Math.abs(v) < 1e-3 || Math.abs(v) > 1e6)) return v.toExponential(4);
        return v.toFixed(4);
      }
      return String(v);
    }).join(','));
  }
  const outPath = path.join(OUT_DIR, 'backtest_comparison.csv');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log('\nWrote ' + outPath + ' with ' + allRows.length + ' rows.');

  const v1 = allRows.filter(r => r.variant === 'V1-NoCorr');
  const mcp = allRows.filter(r => r.variant === 'Argus');
  function fmt(x: number, d = 2) { return x.toFixed(d); }
  console.log('\nAGGREGATE (' + v1.length + ' slates):');
  console.log('  V1-NoCorr  meanProj=' + fmt(mean(v1.map(r => r.meanProj))) + ' meanOwn=' + fmt(mean(v1.map(r => r.meanOwn))) +
    ' meanJaccard=' + fmt(mean(v1.map(r => r.meanPairwiseJaccard)), 4) +
    ' maxJaccard=' + fmt(mean(v1.map(r => r.maxPairwiseJaccard)), 4) +
    ' unique4=' + fmt(mean(v1.map(r => r.unique4)), 0) + ' unique5=' + fmt(mean(v1.map(r => r.unique5)), 0) +
    ' max4=' + fmt(mean(v1.map(r => r.max4))) + ' max5=' + fmt(mean(v1.map(r => r.max5))) +
    ' meanMCP=' + fmt(mean(v1.map(r => r.meanMultiPenalty)), 3) +
    ' maxConc=' + mean(v1.map(r => r.maxTopConcentration)).toExponential(2) +
    ' meanActual=' + fmt(mean(v1.map(r => r.meanActual))) +
    ' maxActual=' + fmt(mean(v1.map(r => r.maxActual))) +
    ' top1×Lift=' + fmt(mean(v1.map(r => r.top1xLift))));
  console.log('  Argus      meanProj=' + fmt(mean(mcp.map(r => r.meanProj))) + ' meanOwn=' + fmt(mean(mcp.map(r => r.meanOwn))) +
    ' meanJaccard=' + fmt(mean(mcp.map(r => r.meanPairwiseJaccard)), 4) +
    ' maxJaccard=' + fmt(mean(mcp.map(r => r.maxPairwiseJaccard)), 4) +
    ' unique4=' + fmt(mean(mcp.map(r => r.unique4)), 0) + ' unique5=' + fmt(mean(mcp.map(r => r.unique5)), 0) +
    ' max4=' + fmt(mean(mcp.map(r => r.max4))) + ' max5=' + fmt(mean(mcp.map(r => r.max5))) +
    ' meanMCP=' + fmt(mean(mcp.map(r => r.meanMultiPenalty)), 3) +
    ' maxConc=' + mean(mcp.map(r => r.maxTopConcentration)).toExponential(2) +
    ' meanActual=' + fmt(mean(mcp.map(r => r.meanActual))) +
    ' maxActual=' + fmt(mean(mcp.map(r => r.maxActual))) +
    ' top1×Lift=' + fmt(mean(mcp.map(r => r.top1xLift))));
  console.log('  Δ          meanProj=' + fmt(mean(mcp.map(r => r.meanProj)) - mean(v1.map(r => r.meanProj))) +
    ' meanOwn=' + fmt(mean(mcp.map(r => r.meanOwn)) - mean(v1.map(r => r.meanOwn))) +
    ' meanJaccard=' + fmt(mean(mcp.map(r => r.meanPairwiseJaccard)) - mean(v1.map(r => r.meanPairwiseJaccard)), 4) +
    ' maxJaccard=' + fmt(mean(mcp.map(r => r.maxPairwiseJaccard)) - mean(v1.map(r => r.maxPairwiseJaccard)), 4) +
    ' unique4=' + fmt(mean(mcp.map(r => r.unique4)) - mean(v1.map(r => r.unique4)), 0) +
    ' unique5=' + fmt(mean(mcp.map(r => r.unique5)) - mean(v1.map(r => r.unique5)), 0) +
    ' max4=' + fmt(mean(mcp.map(r => r.max4)) - mean(v1.map(r => r.max4))) +
    ' max5=' + fmt(mean(mcp.map(r => r.max5)) - mean(v1.map(r => r.max5))) +
    ' meanMCP=' + fmt(mean(mcp.map(r => r.meanMultiPenalty)) - mean(v1.map(r => r.meanMultiPenalty)), 3) +
    ' meanActual=' + fmt(mean(mcp.map(r => r.meanActual)) - mean(v1.map(r => r.meanActual))) +
    ' maxActual=' + fmt(mean(mcp.map(r => r.maxActual)) - mean(v1.map(r => r.maxActual))) +
    ' top1×Lift=' + fmt(mean(mcp.map(r => r.top1xLift)) - mean(v1.map(r => r.top1xLift))));
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });
