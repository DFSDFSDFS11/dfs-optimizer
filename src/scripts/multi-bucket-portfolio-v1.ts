/**
 * Multi-Bucket Portfolio V1 — Stage 3 implementation for multi_bucket_research.
 *
 * Architecture (LOCKED in SPECIFICATION.md):
 *   - 75-lineup portfolio split into 3 functional buckets:
 *     - Bucket T (Tournament tail): 45 lineups (60%). V1 EV scoring with λ_T=0.30, ρ_T=0.25.
 *       Stack mix 60% 5-stacks / 30% 4+BB / 10% 3-3.
 *     - Bucket C (Cash-line equity): 15 lineups (20%). proj_sum + 0.5·floor_sum.
 *       NO ownership penalty. 4-stacks only. NO bring-backs. Top-5 SP required.
 *     - Bucket D (Decorrelation): 15 lineups (20%). proj − 5.0·max_jac − 2.0·mean_jac.
 *       ≥80% of optimal projection threshold.
 *   - Global decorrelation: max pairwise Jaccard ≤ 0.7 enforced post-bucket.
 *     50-iteration replacement cap. Replacement priority: D > T > C.
 *
 * Pre-registered magnitudes — DO NOT TUNE.
 *
 * Runs on 16 dev slates only. Holdout slates remain sealed.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';

const MLB_DIR = 'C:/Users/colin/dfs opto';
const OUT_DIR = 'C:/Users/colin/dfs opto/multi_bucket_research/development_results';
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const N = 75;
const T_SIZE = 45;
const C_SIZE = 15;
const D_SIZE = 15;

// LOCKED magnitudes
const LAMBDA_T = 0.30; // Bucket T ownership weight (V1 W_LEV)
const RHO_T = 0.25;    // Bucket T internal max Jaccard
const RHO_C_FLOOR_WEIGHT = 0.5; // Bucket C floor coefficient
const RHO_C_INTERNAL_JAC = 0.5; // Bucket C internal Jaccard cap
const DELTA_D = 5.0;   // Bucket D max-Jaccard penalty
const MU_D = 2.0;      // Bucket D mean-Jaccard penalty
const D_PROJ_THRESHOLD = 0.80; // ≥80% of optimal projection
const GLOBAL_JAC_CAP = 0.7;
const MAX_GLOBAL_ITERS = 50;

// V1 EV weights (preserved)
const W_PROJ = 1.0;
const W_VAR = 0.15;
const W_CMB = 0.25;

const V1_PARAMS = {
  STACK_BONUS_PER_HITTER: 0.10,
  BRINGBACK_1: 0.05,
  BRINGBACK_2: 0.08,
  PITCHER_VS_HITTER_PENALTY: -0.10,
  TRIPLE_FREQ_CAP: 5,
  PPD_LINEUP_PENALTY: 0.10,
  PPD_LINEUP_TOP_PCT: 0.10,
};

// 16 dev slates only
interface SlateSpec { slate: string; proj: string; pool: string; }
const DEV_SLATES: SlateSpec[] = [
  { slate: '4-8-26',         proj: '4-8-26projections.csv',         pool: '4-8-26sspool.csv' },
  { slate: '4-12-26',        proj: '4-12-26projections.csv',        pool: '4-12-26sspool.csv' },
  { slate: '4-17-26',        proj: '4-17-26projections.csv',        pool: '4-17-26sspool.csv' },
  { slate: '4-18-26',        proj: '4-18-26projections.csv',        pool: '4-18-26sspool.csv' },
  { slate: '4-21-26',        proj: '4-21-26projections.csv',        pool: '4-21-26sspool.csv' },
  { slate: '4-22-26',        proj: '4-22-26projections.csv',        pool: '4-22-26sspool.csv' },
  { slate: '4-23-26',        proj: '4-23-26projections.csv',        pool: '4-23-26sspool.csv' },
  { slate: '4-24-26',        proj: '4-24-26projections.csv',        pool: '4-24-26sspool.csv' },
  { slate: '4-25-26',        proj: '4-25-26projections.csv',        pool: '4-25-26sspool.csv' },
  { slate: '4-25-26-early',  proj: '4-25-26projectionsearly.csv',   pool: '4-25-26sspoolearly.csv' },
  { slate: '4-26-26',        proj: '4-26-26projections.csv',        pool: '4-26-26sspool.csv' },
  { slate: '4-27-26',        proj: '4-27-26projections.csv',        pool: '4-27-26sspool.csv' },
  { slate: '4-28-26',        proj: '4-28-26projections.csv',        pool: '4-28-26sspool.csv' },
  { slate: '4-29-26',        proj: '4-29-26projections.csv',        pool: '4-29-26sspool.csv' },
  { slate: '5-2-26-main',    proj: '5-2-26projectionsmain.csv',     pool: '5-2-26sspoolmain.csv' },
  { slate: '5-3-26',         proj: '5-3-26projections.csv',         pool: '5-3-26sspool.csv' },
];

const HOLDOUT_SLATES = new Set(['4-6-26', '4-14-26', '4-15-26', '4-19-26', '4-20-26', '5-1-26', '5-2-26', '5-2-26-night']);

// ============================================================
// UTILS
// ============================================================
function isPitcher(p: Player): boolean { return (p.position || '').toUpperCase().includes('P'); }
function mean(a: number[]): number { if (!a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; }
function rankPercentile(values: number[]): number[] {
  const idx = values.map((v, i) => ({ v, i }));
  idx.sort((a, b) => a.v - b.v);
  const out = new Array<number>(values.length);
  for (let r = 0; r < values.length; r++) out[idx[r].i] = values.length > 1 ? r / (values.length - 1) : 0;
  return out;
}
function jaccard(idsA: Set<string>, idsB: Set<string>): number {
  let inter = 0;
  for (const id of idsA) if (idsB.has(id)) inter++;
  const union = idsA.size + idsB.size - inter;
  return union === 0 ? 0 : inter / union;
}
function lineupIdSet(lu: Lineup): Set<string> {
  return new Set(lu.players.map(p => p.id));
}

// ============================================================
// SCORED LINEUP STRUCTURE
// ============================================================
interface ScoredLU {
  lu: Lineup;
  ids: Set<string>;
  proj: number;
  floor: number;
  ceiling: number;
  range: number;
  primarySize: number;
  secondarySize: number;
  primaryTeam: string;
  primaryOpp: string;
  bringBack: number;
  pOppHitters: number;
  corrAdj: number;
  logOwn: number;
  uniqueness: number;
  ppd: number;
  // ranks/percentiles (set in batch)
  projPct: number;
  ownPct: number;
  rangePct: number;
  ppdPct: number;
  uniqPct: number;
  // bucket scores
  ev_T: number;
  score_C: number;
  score_D: number; // computed lazily
  // stack-type tag
  stackType: 'fivePlus' | 'four+BB' | 'four+naked' | 'three-three' | 'other';
  // top-5 SP test
  hasTop5SP: boolean;
}

function classifyStackType(s: ScoredLU): 'fivePlus' | 'four+BB' | 'four+naked' | 'three-three' | 'other' {
  if (s.primarySize >= 5) return 'fivePlus';
  if (s.primarySize === 4 && s.bringBack >= 1) return 'four+BB';
  if (s.primarySize === 4) return 'four+naked';
  if (s.primarySize === 3 && s.secondarySize >= 3) return 'three-three';
  return 'other';
}

function scoreLineupBase(
  lu: Lineup,
  pairFreq: Map<string, number>,
  tripleFreq: Map<string, number>,
  topSpIds: Set<string>,
): ScoredLU {
  let floor = 0, ceiling = 0;
  for (const p of lu.players) {
    if (p.percentiles) {
      floor += p.percentiles.p25 || p.projection * 0.85;
      ceiling += p.percentiles.p75 || p.projection * 1.15;
    } else {
      floor += p.projection * 0.85;
      ceiling += p.projection * 1.15;
    }
  }
  const teamHitters = new Map<string, number>();
  const pitchers: Player[] = [];
  for (const p of lu.players) {
    if (isPitcher(p)) pitchers.push(p);
    else {
      const t = (p.team || '').toUpperCase();
      if (t) teamHitters.set(t, (teamHitters.get(t) || 0) + 1);
    }
  }
  let primaryTeam = '', primarySize = 0;
  for (const [t, c] of teamHitters) if (c > primarySize) { primarySize = c; primaryTeam = t; }
  let secondarySize = 0;
  for (const [t, c] of teamHitters) if (t !== primaryTeam && c > secondarySize) secondarySize = c;
  let primaryOpp = '';
  for (const p of lu.players) {
    if ((p.team || '').toUpperCase() === primaryTeam) {
      primaryOpp = (p.opponent || '').toUpperCase();
      if (primaryOpp) break;
    }
  }
  const bringBack = primaryOpp ? (teamHitters.get(primaryOpp) || 0) : 0;
  let pOppHitters = 0;
  for (const p of pitchers) {
    const o = (p.opponent || '').toUpperCase();
    if (o) pOppHitters += teamHitters.get(o) || 0;
  }
  let corrAdj = 0;
  if (primarySize >= 3) corrAdj += V1_PARAMS.STACK_BONUS_PER_HITTER * (primarySize - 2);
  if (bringBack === 1) corrAdj += V1_PARAMS.BRINGBACK_1;
  else if (bringBack >= 2) corrAdj += V1_PARAMS.BRINGBACK_2;
  corrAdj += V1_PARAMS.PITCHER_VS_HITTER_PENALTY * pOppHitters;

  // Combinatorial uniqueness (V1 untyped raw)
  let uniqueness = 0;
  const players = lu.players;
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const k = [players[i].id, players[j].id].sort().join('|');
      const f = pairFreq.get(k) || 1e-6;
      uniqueness += -Math.log(f);
    }
  }
  const tripFs: { f: number }[] = [];
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      for (let l = j + 1; l < players.length; l++) {
        const tk = [players[i].id, players[j].id, players[l].id].sort().join('|');
        tripFs.push({ f: tripleFreq.get(tk) || 1e-6 });
      }
    }
  }
  tripFs.sort((a, b) => b.f - a.f);
  for (const t of tripFs.slice(0, V1_PARAMS.TRIPLE_FREQ_CAP)) uniqueness += -Math.log(t.f);

  // V1 logOwn (HITTERS ONLY — per V1 final implementation)
  let logOwn = 0;
  for (const p of lu.players) {
    if (isPitcher(p)) continue;
    logOwn += Math.log(Math.max(0.1, p.ownership || 0.5));
  }
  let ppd = 0;
  for (const p of lu.players) {
    if (p.salary && p.projection) ppd += p.projection / (p.salary / 1000);
  }

  let hasTop5SP = false;
  let countTop5 = 0;
  for (const p of pitchers) if (topSpIds.has(p.id)) countTop5++;
  hasTop5SP = countTop5 === pitchers.length && pitchers.length >= 1;

  const sl: ScoredLU = {
    lu, ids: lineupIdSet(lu),
    proj: lu.projection,
    floor, ceiling, range: ceiling - floor,
    primarySize, secondarySize, primaryTeam, primaryOpp,
    bringBack, pOppHitters, corrAdj,
    logOwn, uniqueness, ppd,
    projPct: 0, ownPct: 0, rangePct: 0, ppdPct: 0, uniqPct: 0,
    ev_T: 0, score_C: 0, score_D: 0,
    stackType: 'other',
    hasTop5SP,
  };
  sl.stackType = classifyStackType(sl);
  return sl;
}

// ============================================================
// PAIR/TRIPLE FREQUENCIES (V1 pattern: projection-squared weighted)
// ============================================================
function buildFreqs(candidates: Lineup[]): { pair: Map<string, number>; triple: Map<string, number> } {
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
  if (totalW > 0) {
    for (const k of pair.keys()) pair.set(k, pair.get(k)! / totalW);
    for (const k of triple.keys()) triple.set(k, triple.get(k)! / totalW);
  }
  return { pair, triple };
}

// ============================================================
// BUCKET T: 45 lineups, V1 EV with stack-mix and ρ_T=0.25
// ============================================================
function buildBucketT(scored: ScoredLU[]): { selected: ScoredLU[]; eligible: ScoredLU[] } {
  // Filter to candidates with a valid stack type (5+, 4+BB, 4+naked, or 3-3).
  // 4+naked is allowed as fallback only.
  const eligible = scored.filter(s => s.stackType !== 'other' && s.pOppHitters === 0);

  // Sort by EV_T descending within each stack-type sub-pool
  const fivePlus = eligible.filter(s => s.stackType === 'fivePlus').sort((a, b) => b.ev_T - a.ev_T);
  const fourBB = eligible.filter(s => s.stackType === 'four+BB').sort((a, b) => b.ev_T - a.ev_T);
  const fourNaked = eligible.filter(s => s.stackType === 'four+naked').sort((a, b) => b.ev_T - a.ev_T);
  const threeThree = eligible.filter(s => s.stackType === 'three-three').sort((a, b) => b.ev_T - a.ev_T);

  const TARGET_5 = Math.round(T_SIZE * 0.60); // 27
  const TARGET_4BB = Math.round(T_SIZE * 0.30); // 13
  const TARGET_33 = T_SIZE - TARGET_5 - TARGET_4BB; // 5

  const selected: ScoredLU[] = [];

  function tryAdd(s: ScoredLU): boolean {
    // Internal Jaccard ≤ ρ_T
    for (const sel of selected) {
      if (jaccard(s.ids, sel.ids) > RHO_T) return false;
    }
    selected.push(s);
    return true;
  }

  function fillFrom(pool: ScoredLU[], target: number): number {
    let added = 0;
    for (const s of pool) {
      if (added >= target) break;
      if (tryAdd(s)) added++;
    }
    return added;
  }

  // Fill in priority order: 5+, then 4+BB, then 3-3
  let added5 = fillFrom(fivePlus, TARGET_5);
  let added4bb = fillFrom(fourBB, TARGET_4BB);
  let added33 = fillFrom(threeThree, TARGET_33);

  // Overflow rules: if 3-3 short, fall to 4+BB then 5+
  if (added33 < TARGET_33) {
    const need = TARGET_33 - added33;
    const extra = fillFrom(fourBB.filter(s => !selected.includes(s)), need);
    added4bb += extra;
    added33 += extra;
  }
  if (added4bb < TARGET_4BB) {
    const need = TARGET_4BB - added4bb;
    const extra = fillFrom(fivePlus.filter(s => !selected.includes(s)), need);
    added5 += extra;
    added4bb += extra;
  }
  // If still short, allow 4+naked as last resort
  if (selected.length < T_SIZE) {
    const need = T_SIZE - selected.length;
    fillFrom(fourNaked.filter(s => !selected.includes(s)), need);
  }
  // If still short, relax ρ_T progressively
  if (selected.length < T_SIZE) {
    const remaining = eligible.filter(s => !selected.includes(s)).sort((a, b) => b.ev_T - a.ev_T);
    for (const s of remaining) {
      if (selected.length >= T_SIZE) break;
      // accept with looser cap of 0.45 (V1's 6/10 overlap ≈ 0.43)
      let ok = true;
      for (const sel of selected) if (jaccard(s.ids, sel.ids) > 0.45) { ok = false; break; }
      if (ok) selected.push(s);
    }
  }

  return { selected: selected.slice(0, T_SIZE), eligible };
}

// ============================================================
// BUCKET C: 15 cash-line lineups
// ============================================================
function buildBucketC(
  scored: ScoredLU[],
  excluded: Set<string>,
): { selected: ScoredLU[]; eligible: ScoredLU[] } {
  // Filter: 4-stack only, no bring-back, top-5 SP required
  const eligible = scored.filter(s =>
    !excluded.has(s.lu.hash)
    && s.primarySize === 4
    && s.bringBack === 0
    && s.hasTop5SP
    && s.pOppHitters === 0
  );
  // Score by score_C
  for (const s of eligible) s.score_C = s.proj + RHO_C_FLOOR_WEIGHT * s.floor;
  eligible.sort((a, b) => b.score_C - a.score_C);

  const selected: ScoredLU[] = [];

  function tryAdd(s: ScoredLU, jacCap: number): boolean {
    for (const sel of selected) if (jaccard(s.ids, sel.ids) > jacCap) return false;
    selected.push(s);
    return true;
  }

  // Round 1: Jaccard ≤ 0.5
  for (const s of eligible) {
    if (selected.length >= C_SIZE) break;
    tryAdd(s, RHO_C_INTERNAL_JAC);
  }
  // Round 2: relax to 0.6
  if (selected.length < C_SIZE) {
    for (const s of eligible) {
      if (selected.length >= C_SIZE) break;
      if (selected.includes(s)) continue;
      tryAdd(s, 0.6);
    }
  }
  // Round 3: relax to 0.7
  if (selected.length < C_SIZE) {
    for (const s of eligible) {
      if (selected.length >= C_SIZE) break;
      if (selected.includes(s)) continue;
      tryAdd(s, 0.7);
    }
  }
  // Round 4: if still short, relax SP rule (keep 4-stack and no-BB)
  if (selected.length < C_SIZE) {
    const fallbackEligible = scored.filter(s =>
      !excluded.has(s.lu.hash)
      && s.primarySize === 4
      && s.bringBack === 0
      && s.pOppHitters === 0
      && !selected.includes(s)
    );
    for (const s of fallbackEligible) s.score_C = s.proj + RHO_C_FLOOR_WEIGHT * s.floor;
    fallbackEligible.sort((a, b) => b.score_C - a.score_C);
    for (const s of fallbackEligible) {
      if (selected.length >= C_SIZE) break;
      tryAdd(s, 0.7);
    }
  }
  return { selected: selected.slice(0, C_SIZE), eligible };
}

// ============================================================
// BUCKET D: 15 decorrelation lineups
// ============================================================
function buildBucketD(
  scored: ScoredLU[],
  TC_set: ScoredLU[],
  excluded: Set<string>,
  poolOptimalProj: number,
): { selected: ScoredLU[]; eligible: ScoredLU[] } {
  const minProj = D_PROJ_THRESHOLD * poolOptimalProj;
  const eligibleBase = scored.filter(s =>
    !excluded.has(s.lu.hash)
    && s.proj >= minProj
    && s.pOppHitters === 0
  );

  const selected: ScoredLU[] = [];
  const portfolioSoFar = TC_set.slice(); // start with T∪C

  function scoreD(s: ScoredLU, others: ScoredLU[]): number {
    let maxJ = 0;
    let sumJ = 0;
    for (const o of others) {
      const j = jaccard(s.ids, o.ids);
      if (j > maxJ) maxJ = j;
      sumJ += j;
    }
    const meanJ = others.length > 0 ? sumJ / others.length : 0;
    return s.proj - DELTA_D * maxJ - MU_D * meanJ;
  }

  while (selected.length < D_SIZE) {
    const remaining = eligibleBase.filter(s => !selected.includes(s));
    if (remaining.length === 0) break;
    // Compute score_D for each remaining vs portfolioSoFar
    const others = portfolioSoFar.concat(selected);
    let bestScore = -Infinity;
    let bestIdx = -1;
    for (let i = 0; i < remaining.length; i++) {
      const sc = scoreD(remaining[i], others);
      if (sc > bestScore) { bestScore = sc; bestIdx = i; }
    }
    if (bestIdx < 0) break;
    const pick = remaining[bestIdx];
    pick.score_D = bestScore;
    selected.push(pick);
  }

  return { selected: selected.slice(0, D_SIZE), eligible: eligibleBase };
}

// ============================================================
// GLOBAL DECORRELATION ENFORCEMENT
// ============================================================
interface PortfolioState {
  T: ScoredLU[];
  C: ScoredLU[];
  D: ScoredLU[];
}

function findWorstPair(state: PortfolioState): { i: number; j: number; jac: number; iBucket: 'T'|'C'|'D'; jBucket: 'T'|'C'|'D' } | null {
  const all: { sl: ScoredLU; bucket: 'T'|'C'|'D'; idx: number }[] = [];
  state.T.forEach((sl, i) => all.push({ sl, bucket: 'T', idx: i }));
  state.C.forEach((sl, i) => all.push({ sl, bucket: 'C', idx: i }));
  state.D.forEach((sl, i) => all.push({ sl, bucket: 'D', idx: i }));
  let worstJ = 0;
  let worstA = -1, worstB = -1;
  for (let a = 0; a < all.length; a++) {
    for (let b = a + 1; b < all.length; b++) {
      const jc = jaccard(all[a].sl.ids, all[b].sl.ids);
      if (jc > worstJ) { worstJ = jc; worstA = a; worstB = b; }
    }
  }
  if (worstJ <= GLOBAL_JAC_CAP || worstA < 0) return null;
  return {
    i: all[worstA].idx,
    j: all[worstB].idx,
    jac: worstJ,
    iBucket: all[worstA].bucket,
    jBucket: all[worstB].bucket,
  };
}

function getCurrentlyUsedHashes(state: PortfolioState): Set<string> {
  const s = new Set<string>();
  for (const sl of state.T) s.add(sl.lu.hash);
  for (const sl of state.C) s.add(sl.lu.hash);
  for (const sl of state.D) s.add(sl.lu.hash);
  return s;
}

function maxJaccardAgainstPortfolio(s: ScoredLU, state: PortfolioState, excludeIdx: { bucket: 'T'|'C'|'D'; idx: number } | null): number {
  let m = 0;
  const check = (arr: ScoredLU[], bucket: 'T'|'C'|'D') => {
    for (let i = 0; i < arr.length; i++) {
      if (excludeIdx && excludeIdx.bucket === bucket && excludeIdx.idx === i) continue;
      const jc = jaccard(s.ids, arr[i].ids);
      if (jc > m) m = jc;
    }
  };
  check(state.T, 'T');
  check(state.C, 'C');
  check(state.D, 'D');
  return m;
}

function attemptReplaceT(
  state: PortfolioState,
  idx: number,
  eligibleT: ScoredLU[],
  log: string[],
): boolean {
  const old = state.T[idx];
  const oldStackType = old.stackType;
  const used = getCurrentlyUsedHashes(state);
  // Try same stack-type first
  const sameType = eligibleT
    .filter(s => s.stackType === oldStackType && !used.has(s.lu.hash))
    .sort((a, b) => b.ev_T - a.ev_T);
  for (const cand of sameType) {
    const m = maxJaccardAgainstPortfolio(cand, state, { bucket: 'T', idx });
    if (m <= GLOBAL_JAC_CAP) {
      state.T[idx] = cand;
      log.push(`Replaced T[${idx}] (${oldStackType}) — sameType: ${old.lu.hash.slice(0,6)} -> ${cand.lu.hash.slice(0,6)} (maxJ ${m.toFixed(3)})`);
      return true;
    }
  }
  // Fallback: any T-eligible (preserve stack-mix priority 5+ -> 4+BB -> 3-3 -> 4+naked)
  const priority: ('fivePlus'|'four+BB'|'three-three'|'four+naked')[] = ['fivePlus', 'four+BB', 'three-three', 'four+naked'];
  for (const tp of priority) {
    if (tp === oldStackType) continue;
    const cands = eligibleT
      .filter(s => s.stackType === tp && !used.has(s.lu.hash))
      .sort((a, b) => b.ev_T - a.ev_T);
    for (const cand of cands) {
      const m = maxJaccardAgainstPortfolio(cand, state, { bucket: 'T', idx });
      if (m <= GLOBAL_JAC_CAP) {
        state.T[idx] = cand;
        log.push(`Replaced T[${idx}] (${oldStackType}) — fallback: ${old.lu.hash.slice(0,6)} -> ${cand.lu.hash.slice(0,6)} (newType ${tp}, maxJ ${m.toFixed(3)})`);
        return true;
      }
    }
  }
  return false;
}

function attemptReplaceC(
  state: PortfolioState,
  idx: number,
  eligibleC: ScoredLU[],
  log: string[],
): boolean {
  const old = state.C[idx];
  const used = getCurrentlyUsedHashes(state);
  const sortedC = eligibleC
    .filter(s => !used.has(s.lu.hash))
    .sort((a, b) => b.score_C - a.score_C);
  for (const cand of sortedC) {
    const m = maxJaccardAgainstPortfolio(cand, state, { bucket: 'C', idx });
    if (m <= GLOBAL_JAC_CAP) {
      state.C[idx] = cand;
      log.push(`Replaced C[${idx}]: ${old.lu.hash.slice(0,6)} -> ${cand.lu.hash.slice(0,6)} (maxJ ${m.toFixed(3)})`);
      return true;
    }
  }
  return false;
}

function attemptReplaceD(
  state: PortfolioState,
  idx: number,
  eligibleD: ScoredLU[],
  log: string[],
): boolean {
  const old = state.D[idx];
  const used = getCurrentlyUsedHashes(state);
  // Re-score D candidates against current state minus the one being replaced
  const TC_minusD = state.T.concat(state.C);
  const Dminus = state.D.filter((_, i) => i !== idx);
  const others = TC_minusD.concat(Dminus);
  const cands = eligibleD.filter(s => !used.has(s.lu.hash));
  const ranked = cands.map(s => {
    let maxJ = 0, sumJ = 0;
    for (const o of others) {
      const j = jaccard(s.ids, o.ids);
      if (j > maxJ) maxJ = j;
      sumJ += j;
    }
    const meanJ = others.length > 0 ? sumJ / others.length : 0;
    const score = s.proj - DELTA_D * maxJ - MU_D * meanJ;
    return { s, score, maxJ };
  }).sort((a, b) => b.score - a.score);
  for (const r of ranked) {
    if (r.maxJ <= GLOBAL_JAC_CAP) {
      state.D[idx] = r.s;
      log.push(`Replaced D[${idx}]: ${old.lu.hash.slice(0,6)} -> ${r.s.lu.hash.slice(0,6)} (maxJ ${r.maxJ.toFixed(3)})`);
      return true;
    }
  }
  return false;
}

function enforceGlobalDecorrelation(
  state: PortfolioState,
  eligibleT: ScoredLU[],
  eligibleC: ScoredLU[],
  eligibleD: ScoredLU[],
): { iters: number; resolved: boolean; replacementLog: string[] } {
  const log: string[] = [];
  let iters = 0;
  while (iters < MAX_GLOBAL_ITERS) {
    const worst = findWorstPair(state);
    if (!worst) {
      return { iters, resolved: true, replacementLog: log };
    }
    iters++;
    // Priority: D > T > C
    let replaced = false;
    // Try replacing whichever member of the offending pair is in D (priority 1)
    if (worst.iBucket === 'D') {
      replaced = attemptReplaceD(state, worst.i, eligibleD, log);
    }
    if (!replaced && worst.jBucket === 'D') {
      replaced = attemptReplaceD(state, worst.j, eligibleD, log);
    }
    // Then T (priority 2)
    if (!replaced && worst.iBucket === 'T') {
      replaced = attemptReplaceT(state, worst.i, eligibleT, log);
    }
    if (!replaced && worst.jBucket === 'T') {
      replaced = attemptReplaceT(state, worst.j, eligibleT, log);
    }
    // Then C (priority 3, only if absolutely needed)
    if (!replaced && worst.iBucket === 'C') {
      replaced = attemptReplaceC(state, worst.i, eligibleC, log);
    }
    if (!replaced && worst.jBucket === 'C') {
      replaced = attemptReplaceC(state, worst.j, eligibleC, log);
    }
    if (!replaced) {
      log.push(`Iter ${iters}: NO REPLACEMENT FOUND for pair (${worst.iBucket}[${worst.i}], ${worst.jBucket}[${worst.j}]) maxJ=${worst.jac.toFixed(3)} — ABORTING`);
      return { iters, resolved: false, replacementLog: log };
    }
  }
  // Hit cap
  const final = findWorstPair(state);
  return { iters, resolved: final === null, replacementLog: log };
}

// ============================================================
// PER-SLATE DRIVER
// ============================================================
async function processSlateSpec(s: SlateSpec): Promise<{ slate: string; ok: boolean; summary: any }> {
  const projPath = path.join(MLB_DIR, s.proj);
  const poolPath = path.join(MLB_DIR, s.pool);
  if (!fs.existsSync(projPath) || !fs.existsSync(poolPath)) {
    console.log(`  SKIP ${s.slate}: missing files`);
    return { slate: s.slate, ok: false, summary: { error: 'missing files' } };
  }
  const pr = parseCSVFile(projPath, 'mlb', true);
  const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
  const playerPool = buildPlayerPool(pr.players, pr.detectedContestType);
  const idMap = new Map<string, Player>();
  for (const p of playerPool.players) idMap.set(p.id, p);
  const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
  // Dedupe by hash
  const uniq = new Map<string, Lineup>();
  for (const lu of loaded.lineups) if (!uniq.has(lu.hash)) uniq.set(lu.hash, lu);
  const candidates = Array.from(uniq.values());
  console.log(`  ${s.slate}: ${candidates.length} unique candidates`);
  if (candidates.length < 200) {
    console.log(`    WARNING: very thin pool; bucket fills may fail`);
  }

  // Top-5 SP for Bucket C
  const allPitchers = playerPool.players.filter(p => isPitcher(p));
  allPitchers.sort((a, b) => b.projection - a.projection);
  const topSpIds = new Set(allPitchers.slice(0, 5).map(p => p.id));

  // Score base
  const { pair, triple } = buildFreqs(candidates);
  const scored = candidates.map(lu => scoreLineupBase(lu, pair, triple, topSpIds));

  // Compute Bucket-T EV percentiles + EV
  const projAdj = scored.map(s2 => s2.proj * (1 + s2.corrAdj));
  const projPct = rankPercentile(projAdj);
  const ownPct = rankPercentile(scored.map(s2 => s2.logOwn));
  const rangePct = rankPercentile(scored.map(s2 => s2.range));
  const ppdPct = rankPercentile(scored.map(s2 => s2.ppd));
  const uniqPct = rankPercentile(scored.map(s2 => s2.uniqueness));
  for (let i = 0; i < scored.length; i++) {
    scored[i].projPct = projPct[i];
    scored[i].ownPct = ownPct[i];
    scored[i].rangePct = rangePct[i];
    scored[i].ppdPct = ppdPct[i];
    scored[i].uniqPct = uniqPct[i];
  }
  for (const s2 of scored) {
    let ev = W_PROJ * s2.projPct
           + LAMBDA_T * (1 - s2.ownPct)
           + W_VAR * s2.rangePct * 0.85
           + W_CMB * s2.uniqPct;
    if (s2.ppdPct >= 1 - V1_PARAMS.PPD_LINEUP_TOP_PCT) ev *= (1 - V1_PARAMS.PPD_LINEUP_PENALTY);
    s2.ev_T = ev;
  }

  // Bucket T
  const tResult = buildBucketT(scored);
  console.log(`    Bucket T: ${tResult.selected.length}/${T_SIZE} (eligible ${tResult.eligible.length})`);

  // Bucket C
  const usedAfterT = new Set(tResult.selected.map(s2 => s2.lu.hash));
  const cResult = buildBucketC(scored, usedAfterT);
  console.log(`    Bucket C: ${cResult.selected.length}/${C_SIZE} (eligible ${cResult.eligible.length})`);

  // Bucket D
  const TC = tResult.selected.concat(cResult.selected);
  const usedAfterTC = new Set(TC.map(s2 => s2.lu.hash));
  const poolOptProj = Math.max(...candidates.map(lu => lu.projection));
  const dResult = buildBucketD(scored, TC, usedAfterTC, poolOptProj);
  console.log(`    Bucket D: ${dResult.selected.length}/${D_SIZE} (eligible ${dResult.eligible.length}, optProj=${poolOptProj.toFixed(2)}, threshold=${(D_PROJ_THRESHOLD * poolOptProj).toFixed(2)})`);

  // Global decorrelation
  const state: PortfolioState = {
    T: tResult.selected,
    C: cResult.selected,
    D: dResult.selected,
  };
  const decResult = enforceGlobalDecorrelation(state, tResult.eligible, cResult.eligible, dResult.eligible);
  console.log(`    Global decorr: ${decResult.iters} iters, resolved=${decResult.resolved}`);

  // Final portfolio
  const portfolio = state.T.concat(state.C).concat(state.D);
  if (portfolio.length !== N) {
    console.log(`    WARN: portfolio has ${portfolio.length}/${N} lineups`);
  }

  // Compute final pairwise Jaccard stats
  let pairCount = 0, sumJ = 0, maxJ = 0;
  for (let i = 0; i < portfolio.length; i++) {
    for (let j = i + 1; j < portfolio.length; j++) {
      const jc = jaccard(portfolio[i].ids, portfolio[j].ids);
      sumJ += jc; pairCount++;
      if (jc > maxJ) maxJ = jc;
    }
  }
  const meanJ = pairCount > 0 ? sumJ / pairCount : 0;

  // Stack-type breakdown
  const stTBreakdown: Record<string, number> = { fivePlus: 0, 'four+BB': 0, 'four+naked': 0, 'three-three': 0, other: 0 };
  for (const s2 of state.T) stTBreakdown[s2.stackType] = (stTBreakdown[s2.stackType] || 0) + 1;
  const stCBreakdown: Record<string, number> = {};
  for (const s2 of state.C) stCBreakdown[s2.stackType] = (stCBreakdown[s2.stackType] || 0) + 1;
  const stDBreakdown: Record<string, number> = {};
  for (const s2 of state.D) stDBreakdown[s2.stackType] = (stDBreakdown[s2.stackType] || 0) + 1;

  // Write detail CSV
  const detailRows: string[] = [];
  detailRows.push('idx,bucket,stackType,primarySize,secondarySize,bringBack,primaryTeam,projection,ownership,floor,ceiling,corrAdj,evT,scoreC,scoreD,maxJacToPortfolio');
  let idx = 0;
  function rowFor(sl: ScoredLU, bucket: string) {
    const m = (() => { let mm = 0; for (let k = 0; k < portfolio.length; k++) { if (portfolio[k].lu.hash === sl.lu.hash) continue; const jc = jaccard(sl.ids, portfolio[k].ids); if (jc > mm) mm = jc; } return mm; })();
    return [
      idx++, bucket, sl.stackType, sl.primarySize, sl.secondarySize, sl.bringBack, sl.primaryTeam,
      sl.proj.toFixed(2), (sl.lu.ownership || 0).toFixed(2), sl.floor.toFixed(2), sl.ceiling.toFixed(2),
      sl.corrAdj.toFixed(3), sl.ev_T.toFixed(3), sl.score_C.toFixed(3), sl.score_D.toFixed(3), m.toFixed(3),
    ].join(',');
  }
  for (const sl of state.T) detailRows.push(rowFor(sl, 'T'));
  for (const sl of state.C) detailRows.push(rowFor(sl, 'C'));
  for (const sl of state.D) detailRows.push(rowFor(sl, 'D'));
  fs.writeFileSync(path.join(OUT_DIR, `${s.slate}_detail.csv`), detailRows.join('\n'));

  // Write DK CSV (10 cols of player IDs/names per lineup)
  const dkRows: string[] = [];
  // Header — generic position labels
  dkRows.push('P,P,C,1B,2B,3B,SS,OF,OF,OF');
  for (const sl of portfolio) {
    const ids = sl.lu.players.map(p => `${p.name} (${p.id})`);
    dkRows.push(ids.join(','));
  }
  fs.writeFileSync(path.join(OUT_DIR, `${s.slate}_dk.csv`), dkRows.join('\n'));

  return {
    slate: s.slate,
    ok: true,
    summary: {
      candidates: candidates.length,
      portfolioSize: portfolio.length,
      tStackMix: stTBreakdown,
      cStackMix: stCBreakdown,
      dStackMix: stDBreakdown,
      meanJ: meanJ,
      maxJ: maxJ,
      decorrIters: decResult.iters,
      decorrResolved: decResult.resolved,
      poolOptProj: poolOptProj,
      avgProj: mean(portfolio.map(s2 => s2.proj)),
      avgOwn: mean(portfolio.map(s2 => s2.lu.ownership || 0)),
    },
  };
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log('================================================================');
  console.log('MULTI-BUCKET PORTFOLIO V1 — Stage 3 implementation');
  console.log('================================================================');
  console.log(`Output: ${OUT_DIR}`);
  console.log(`16 dev slates only. Holdout slates SEALED (not processed).`);
  console.log(`Pre-registered: T=45, C=15, D=15. λ_T=${LAMBDA_T}, ρ_T=${RHO_T}, ρ_C_floor=${RHO_C_FLOOR_WEIGHT}, δ=${DELTA_D}, μ=${MU_D}, globalJacCap=${GLOBAL_JAC_CAP}`);
  console.log('================================================================\n');

  // Sanity: confirm no holdout slates in dev list
  for (const s of DEV_SLATES) {
    if (HOLDOUT_SLATES.has(s.slate)) {
      console.error(`FATAL: holdout slate ${s.slate} in dev list`);
      process.exit(1);
    }
  }

  const allSummaries: any[] = [];
  const t0 = Date.now();
  for (const s of DEV_SLATES) {
    const t1 = Date.now();
    const res = await processSlateSpec(s);
    const dt = ((Date.now() - t1) / 1000).toFixed(1);
    console.log(`    [${dt}s] ${s.slate} done`);
    allSummaries.push(res);
  }
  const totalDt = ((Date.now() - t0) / 1000).toFixed(1);

  // Aggregate run summary
  fs.writeFileSync(
    path.join(OUT_DIR, 'run_summary.json'),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      totalRuntimeSec: totalDt,
      lockedConfig: {
        T_SIZE, C_SIZE, D_SIZE,
        LAMBDA_T, RHO_T, RHO_C_FLOOR_WEIGHT, RHO_C_INTERNAL_JAC,
        DELTA_D, MU_D, D_PROJ_THRESHOLD,
        GLOBAL_JAC_CAP, MAX_GLOBAL_ITERS,
        stackMix: { fivePlus: 0.60, fourBB: 0.30, threeThree: 0.10 },
      },
      slates: allSummaries,
    }, null, 2),
  );
  console.log(`\nDone in ${totalDt}s. Run summary written.`);
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });
