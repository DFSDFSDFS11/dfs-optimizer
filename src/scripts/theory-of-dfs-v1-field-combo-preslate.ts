/**
 * Theory-of-DFS V1-FieldCombo Pre-Slate (parallel variant runner).
 *
 * V1-FieldCombo is a framework-grounded architectural variant of V1-NoCorr.
 * It replaces V1's existing combo_uniqueness term with field-referenced
 * multi-level combo saturation across combo sizes 2-5 (pitchers included).
 *
 * Spec is locked in:
 *   C:/Users/colin/dfs opto/field_combo_implementation/IMPLEMENTATION_NOTES.md
 *
 * Key differences from V1-NoCorr:
 *   - Combo frequencies are field-referenced via field_freq = product of
 *     (Adj Own / 100), not derived from the candidate pool's pair/triple
 *     counts.
 *   - Multi-level: sat_2, sat_3, sat_4, sat_5 across all C(10,k) combos in
 *     each lineup (45 + 120 + 210 + 252 = 627 lookups per lineup).
 *   - EV term replaced: + W_CMB_AVG × multiUniqPct − W_CMB_MAX × maxSatPct.
 *   - Pitchers INCLUDED in all combo computations.
 *
 * All other V1 components (correlation params, candidate pool, variance-band
 * selection, PPD penalty, mps=4, exposure caps, overlap cap, output format)
 * are preserved.
 *
 * Validation path: parallel live deployment alongside V1-NoCorr over 20-30
 * slates. NOT empirical backtest.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as csvParse } from 'csv-parse/sync';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';
import { exportForDraftKings, exportDetailedLineups } from '../scoring';

const DATA_DIR = 'C:/Users/colin/dfs opto';
// Default preslate files; overridable via env vars FC_PROJ_FILE and FC_POOL_FILES
// (comma-separated). Used by verification harness to point at historical slates
// without modifying the production runner path.
const PROJ_FILE = process.env.FC_PROJ_FILE || 'mlbdkprojpre.csv';
const POOL_FILES = (process.env.FC_POOL_FILES || 'sspool2pre.csv,sspool3pre.csv').split(',').map(s => s.trim()).filter(s => s.length > 0);
const OUTPUT_TAG = process.env.FC_OUTPUT_TAG || '';  // optional tag appended to output filenames
const TARGET_COUNT = process.env.FC_TARGET_COUNT ? parseInt(process.env.FC_TARGET_COUNT, 10) : 1000;
const N = TARGET_COUNT;

// Pre-registered constants — DO NOT TUNE.
const TODFS_FC = {
  // Correlation params (V1-NoCorr): zero forcing.
  STACK_BONUS_PER_HITTER: 0,
  BRINGBACK_1: 0,
  BRINGBACK_2: 0,
  PITCHER_VS_HITTER_PENALTY: -0.10,
  // Hard stack constraint.
  MIN_PRIMARY_STACK: 4,
  // EV weights (FC modifies the combo term only).
  W_PROJ: 1.0,
  W_LEV: 0.30,
  W_VAR: 0.15,
  W_CMB_AVG: 0.30,    // NEW: multi-level uniqueness reward
  W_CMB_MAX: 0.20,    // NEW: max-saturation penalty (subtracted)
  // Combo size weights inside multi_level_uniqueness.
  COMBO_W2: 0.10,
  COMBO_W3: 0.20,
  COMBO_W4: 0.30,
  COMBO_W5: 0.40,
  // Exposure / portfolio caps (per spec).
  EXPOSURE_CAP_HITTER: 0.20,
  EXPOSURE_CAP_PITCHER: 0.45,
  TEAM_STACK_CAP: 0.15,
  // Variance-band selection.
  BAND_HIGH_PCT: 0.20,
  BAND_MID_PCT: 0.60,
  BAND_LOW_PCT: 0.20,
  MAX_PAIRWISE_OVERLAP: 6,
  // PPD penalty.
  PPD_LINEUP_PENALTY: 0.10,
  PPD_LINEUP_TOP_PCT: 0.10,
  // Numerical floors.
  SAT_MIN: 1e-12,            // floor before −log to prevent inf
  FIELD_FREQ_DEFAULT: 1e-9,  // default for combos absent from precomputed map
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

/**
 * Read "Adj Own" column directly from projections CSV and return a map
 * keyed by DFS ID. Used to override Player.ownership with the
 * spec-mandated Adj Own column (parser falls back to "My Own" first).
 */
function loadAdjOwnFromProjections(projPath: string): Map<string, number> {
  const content = fs.readFileSync(projPath, 'utf-8');
  const records = csvParse(content, { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
  const out = new Map<string, number>();
  for (const r of records) {
    const id = (r['DFS ID'] || r['ID'] || r['DFS Id'] || '').toString().trim();
    if (!id) continue;
    const raw = (r['Adj Own'] || '').toString().trim();
    const v = raw ? parseFloat(raw.replace(/[%,]/g, '')) : NaN;
    if (!Number.isNaN(v)) out.set(id, Math.max(0, v));
  }
  return out;
}

/**
 * Field combo frequency precomputation.
 *
 * Enumerates ONLY combos that appear in any candidate lineup (avoids
 * exhaustive C(N,k) over the full active pool, which would be infeasible
 * for k=5, N≈150 — that's ~5×10^8 quintets).
 *
 * For each present combo, field_freq = ∏ (ownership_p / 100). Pitchers are
 * included. Combos absent from candidates default to FIELD_FREQ_DEFAULT
 * at lookup time (in computeComboSaturation).
 */
function computeFieldComboFrequencies(
  candidatePool: Lineup[],
  adjOwnById: Map<string, number>
): {
  pairFreq: Map<string, number>;
  tripleFreq: Map<string, number>;
  quadFreq: Map<string, number>;
  quintFreq: Map<string, number>;
} {
  const pairFreq = new Map<string, number>();
  const tripleFreq = new Map<string, number>();
  const quadFreq = new Map<string, number>();
  const quintFreq = new Map<string, number>();

  // Per-player ownership decimal cache (Adj Own / 100). Pitchers included.
  const ownDecById = new Map<string, number>();
  for (const lu of candidatePool) {
    for (const p of lu.players) {
      if (ownDecById.has(p.id)) continue;
      // Prefer Adj Own from the projections file; fall back to Player.ownership.
      const adj = adjOwnById.get(p.id);
      const o = (adj !== undefined ? adj : (p.ownership || 0)) / 100;
      ownDecById.set(p.id, Math.max(0, o));
    }
  }

  for (const lu of candidatePool) {
    const ids = lu.players.map(p => p.id).sort();
    const n = ids.length;
    // pairs
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const k2 = ids[i] + '|' + ids[j];
        if (!pairFreq.has(k2)) {
          const f = (ownDecById.get(ids[i]) || 0) * (ownDecById.get(ids[j]) || 0);
          pairFreq.set(k2, f);
        }
        // triples
        for (let l = j + 1; l < n; l++) {
          const k3 = ids[i] + '|' + ids[j] + '|' + ids[l];
          if (!tripleFreq.has(k3)) {
            const f = (ownDecById.get(ids[i]) || 0) * (ownDecById.get(ids[j]) || 0) * (ownDecById.get(ids[l]) || 0);
            tripleFreq.set(k3, f);
          }
          // quads
          for (let m = l + 1; m < n; m++) {
            const k4 = ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m];
            if (!quadFreq.has(k4)) {
              const f = (ownDecById.get(ids[i]) || 0) * (ownDecById.get(ids[j]) || 0) * (ownDecById.get(ids[l]) || 0) * (ownDecById.get(ids[m]) || 0);
              quadFreq.set(k4, f);
            }
            // quintets
            for (let q = m + 1; q < n; q++) {
              const k5 = ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m] + '|' + ids[q];
              if (!quintFreq.has(k5)) {
                const f = (ownDecById.get(ids[i]) || 0) * (ownDecById.get(ids[j]) || 0) * (ownDecById.get(ids[l]) || 0) * (ownDecById.get(ids[m]) || 0) * (ownDecById.get(ids[q]) || 0);
                quintFreq.set(k5, f);
              }
            }
          }
        }
      }
    }
  }

  return { pairFreq, tripleFreq, quadFreq, quintFreq };
}

/**
 * Per-lineup multi-level saturation.
 *
 *   sat_k = mean over all C(10,k) combos of field_freq
 *   max_sat = max over all combos of size 2..5 of field_freq
 *   multi_level_uniqueness = sum_k COMBO_Wk × (-log(sat_k))
 *
 * Pitchers included in all combo enumerations (lu.players is the full
 * 10-player roster).
 */
function computeComboSaturation(
  lineup: Lineup,
  pairFreq: Map<string, number>,
  tripleFreq: Map<string, number>,
  quadFreq: Map<string, number>,
  quintFreq: Map<string, number>
): {
  sat_2: number;
  sat_3: number;
  sat_4: number;
  sat_5: number;
  max_sat: number;
  multi_level_uniqueness: number;
} {
  const ids = lineup.players.map(p => p.id).sort();
  const n = ids.length;

  const pairs: number[] = [];
  const triples: number[] = [];
  const quads: number[] = [];
  const quints: number[] = [];

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const k2 = ids[i] + '|' + ids[j];
      pairs.push(pairFreq.get(k2) ?? TODFS_FC.FIELD_FREQ_DEFAULT);
      for (let l = j + 1; l < n; l++) {
        const k3 = ids[i] + '|' + ids[j] + '|' + ids[l];
        triples.push(tripleFreq.get(k3) ?? TODFS_FC.FIELD_FREQ_DEFAULT);
        for (let m = l + 1; m < n; m++) {
          const k4 = ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m];
          quads.push(quadFreq.get(k4) ?? TODFS_FC.FIELD_FREQ_DEFAULT);
          for (let q = m + 1; q < n; q++) {
            const k5 = ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m] + '|' + ids[q];
            quints.push(quintFreq.get(k5) ?? TODFS_FC.FIELD_FREQ_DEFAULT);
          }
        }
      }
    }
  }

  const sat_2 = mean(pairs);
  const sat_3 = mean(triples);
  const sat_4 = mean(quads);
  const sat_5 = mean(quints);

  let max_sat = 0;
  for (const v of pairs) if (v > max_sat) max_sat = v;
  for (const v of triples) if (v > max_sat) max_sat = v;
  for (const v of quads) if (v > max_sat) max_sat = v;
  for (const v of quints) if (v > max_sat) max_sat = v;

  const logSafe = (x: number) => Math.log(Math.max(TODFS_FC.SAT_MIN, x));
  const multi_level_uniqueness =
      TODFS_FC.COMBO_W2 * (-logSafe(sat_2))
    + TODFS_FC.COMBO_W3 * (-logSafe(sat_3))
    + TODFS_FC.COMBO_W4 * (-logSafe(sat_4))
    + TODFS_FC.COMBO_W5 * (-logSafe(sat_5));

  return { sat_2, sat_3, sat_4, sat_5, max_sat, multi_level_uniqueness };
}

async function main() {
  console.log('================================================================');
  console.log('THEORY-DFS V1-FieldCombo PRE-SLATE (parallel variant)');
  console.log('================================================================');
  console.log('Field-referenced multi-level combo saturation, sizes 2-5, pitchers included.');
  console.log('EV: W=1.0/0.30/0.15 (proj/lev/var) + 0.30 × multiUniqPct − 0.20 × maxSatPct.');
  console.log('Combo size weights: 0.10 / 0.20 / 0.30 / 0.40 (W2/W3/W4/W5).');
  console.log('Validation path: parallel live deployment, NOT backtest.');
  console.log('================================================================\n');

  const projPath = path.join(DATA_DIR, PROJ_FILE);
  console.log('Loading projections: ' + projPath);
  const pr = parseCSVFile(projPath, 'mlb', true);
  const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
  const pool = buildPlayerPool(pr.players, pr.detectedContestType);
  console.log('  Players: ' + pool.players.length);

  // Load Adj Own directly from projections (spec mandates Adj Own column).
  const adjOwnById = loadAdjOwnFromProjections(projPath);
  console.log('  Adj Own loaded for ' + adjOwnById.size + ' players');

  // Merge SS pools.
  const idMap = new Map<string, Player>();
  for (const p of pool.players) idMap.set(p.id, p);
  const merged = new Map<string, Lineup>();
  let total = 0;
  for (const pf of POOL_FILES) {
    const pp = path.join(DATA_DIR, pf);
    if (!fs.existsSync(pp)) { console.log('  Skip ' + pf + ': not found'); continue; }
    const loaded = loadPoolFromCSV({ filePath: pp, config, playerMap: idMap });
    total += loaded.lineups.length;
    for (const lu of loaded.lineups) if (!merged.has(lu.hash)) merged.set(lu.hash, lu);
    console.log('  ' + pf + ': ' + loaded.lineups.length + ' lineups (' + loaded.unresolvedRows + ' unresolved)');
  }
  const candidates = Array.from(merged.values());
  console.log('  Merged: ' + candidates.length + ' unique lineups (from ' + total + ')\n');

  // Field combo frequency precomputation (sizes 2-5, pitchers included).
  console.log('Computing field combo frequencies (sizes 2-5)...');
  const t0 = Date.now();
  const fieldFreqs = computeFieldComboFrequencies(candidates, adjOwnById);
  console.log('  Pairs:    ' + fieldFreqs.pairFreq.size);
  console.log('  Triples:  ' + fieldFreqs.tripleFreq.size);
  console.log('  Quads:    ' + fieldFreqs.quadFreq.size);
  console.log('  Quintets: ' + fieldFreqs.quintFreq.size);
  console.log('  ' + ((Date.now() - t0) / 1000).toFixed(2) + 's\n');

  // Score each lineup (V1 baseline + FieldCombo combo term).
  console.log('Scoring (V1-FieldCombo)...');
  interface S {
    lu: Lineup;
    primarySize: number;
    corrAdj: number;
    logOwn: number;
    sat_2: number; sat_3: number; sat_4: number; sat_5: number;
    max_sat: number;
    multi_level_uniqueness: number;
    ppd: number;
    proj: number; floor: number; ceiling: number; range: number;
    ev: number;
    projPct: number; ownPct: number; rangePct: number; ppdPct: number;
    multiUniqPct: number; maxSatPct: number;
  }
  const scored: S[] = [];
  for (const lu of candidates) {
    let floor = 0, ceiling = 0;
    for (const p of lu.players) {
      if (p.percentiles) { floor += p.percentiles.p25 || p.projection * 0.85; ceiling += p.percentiles.p75 || p.projection * 1.15; }
      else { floor += p.projection * 0.85; ceiling += p.projection * 1.15; }
    }

    // Correlation (1B) — V1-NoCorr params (all forcing zeroed except P-vs-H).
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
    if (primarySize >= 3) corrAdj += TODFS_FC.STACK_BONUS_PER_HITTER * (primarySize - 2);
    if (bringBack === 1) corrAdj += TODFS_FC.BRINGBACK_1;
    else if (bringBack >= 2) corrAdj += TODFS_FC.BRINGBACK_2;
    corrAdj += TODFS_FC.PITCHER_VS_HITTER_PENALTY * pOppHitters;

    // Multi-level combo saturation (FieldCombo replacement for V1's combo term).
    const cm = computeComboSaturation(lu, fieldFreqs.pairFreq, fieldFreqs.tripleFreq, fieldFreqs.quadFreq, fieldFreqs.quintFreq);

    // Leverage penalty: hitter ownership only (matches V1-NoCorr; pitcher
    // chalk-vs-leverage is captured in corr 1B).
    let logOwn = 0;
    for (const p of lu.players) {
      if (isPitcher(p)) continue;
      logOwn += Math.log(Math.max(0.1, p.ownership || 0.5));
    }
    let ppd = 0;
    for (const p of lu.players) if (p.salary && p.projection) ppd += p.projection / (p.salary / 1000);

    scored.push({
      lu,
      primarySize,
      corrAdj,
      logOwn,
      sat_2: cm.sat_2, sat_3: cm.sat_3, sat_4: cm.sat_4, sat_5: cm.sat_5,
      max_sat: cm.max_sat,
      multi_level_uniqueness: cm.multi_level_uniqueness,
      ppd,
      proj: lu.projection, floor, ceiling, range: ceiling - floor,
      ev: 0, projPct: 0, ownPct: 0, rangePct: 0, ppdPct: 0, multiUniqPct: 0, maxSatPct: 0,
    });
  }

  // Percentile ranks across the candidate pool.
  const projAdj = scored.map(s => s.proj * (1 + s.corrAdj));
  const projPct = rankPercentile(projAdj);
  const ownPct = rankPercentile(scored.map(s => s.logOwn));
  const rangePct = rankPercentile(scored.map(s => s.range));
  const ppdPct = rankPercentile(scored.map(s => s.ppd));
  const multiUniqPct = rankPercentile(scored.map(s => s.multi_level_uniqueness));
  const maxSatPct = rankPercentile(scored.map(s => s.max_sat));
  for (let i = 0; i < scored.length; i++) {
    scored[i].projPct = projPct[i];
    scored[i].ownPct = ownPct[i];
    scored[i].rangePct = rangePct[i];
    scored[i].ppdPct = ppdPct[i];
    scored[i].multiUniqPct = multiUniqPct[i];
    scored[i].maxSatPct = maxSatPct[i];
  }

  // FieldCombo EV formula.
  for (const s of scored) {
    let ev = TODFS_FC.W_PROJ * s.projPct
           + TODFS_FC.W_LEV * (1 - s.ownPct)
           + TODFS_FC.W_VAR * s.rangePct * 0.85
           + TODFS_FC.W_CMB_AVG * s.multiUniqPct
           - TODFS_FC.W_CMB_MAX * s.maxSatPct;
    if (s.ppdPct >= 1 - TODFS_FC.PPD_LINEUP_TOP_PCT) ev *= (1 - TODFS_FC.PPD_LINEUP_PENALTY);
    s.ev = ev;
  }

  // Hard 4+ stack constraint.
  let pool2 = scored.filter(s => s.primarySize >= TODFS_FC.MIN_PRIMARY_STACK);
  if (pool2.length < N) pool2 = scored;

  // Variance-band selection (20/60/20).
  const sortedHigh = [...pool2].sort((a, b) => (b.projPct + b.ownPct) - (a.projPct + a.ownPct));
  const sortedLow = [...pool2].sort((a, b) => ((1 - b.projPct) + (1 - b.ownPct)) - ((1 - a.projPct) + (1 - a.ownPct)));
  const HIGH_TARGET = Math.round(N * TODFS_FC.BAND_HIGH_PCT);
  const LOW_TARGET = Math.round(N * TODFS_FC.BAND_LOW_PCT);
  const MID_TARGET = N - HIGH_TARGET - LOW_TARGET;

  const selected: S[] = [];
  const exposure = new Map<string, number>();
  const teamStackCount = new Map<string, number>();
  const seen = new Set<string>();
  function primaryStackTeamOf(s: S): string {
    const tc = new Map<string, number>();
    for (const p of s.lu.players) {
      if (isPitcher(p)) continue;
      const t = (p.team || '').toUpperCase();
      if (t) tc.set(t, (tc.get(t) || 0) + 1);
    }
    let primary = '', max = 0;
    for (const [t, c] of tc) if (c > max) { max = c; primary = t; }
    return max >= 4 ? primary : '';
  }
  function passes(s: S): boolean {
    if (seen.has(s.lu.hash)) return false;
    if (s.primarySize < TODFS_FC.MIN_PRIMARY_STACK) return false;
    for (const p of s.lu.players) {
      const cur = exposure.get(p.id) || 0;
      const cap = isPitcher(p) ? TODFS_FC.EXPOSURE_CAP_PITCHER : TODFS_FC.EXPOSURE_CAP_HITTER;
      if ((cur + 1) / N > cap) return false;
    }
    const stackTeam = primaryStackTeamOf(s);
    if (stackTeam) {
      const cur = teamStackCount.get(stackTeam) || 0;
      if ((cur + 1) / N > TODFS_FC.TEAM_STACK_CAP) return false;
    }
    const ids = new Set(s.lu.players.map(p => p.id));
    for (const sel of selected) {
      let ov = 0; for (const p of sel.lu.players) if (ids.has(p.id)) ov++;
      if (ov > TODFS_FC.MAX_PAIRWISE_OVERLAP) return false;
    }
    return true;
  }
  function add(s: S) {
    selected.push(s); seen.add(s.lu.hash);
    for (const p of s.lu.players) exposure.set(p.id, (exposure.get(p.id) || 0) + 1);
    const stackTeam = primaryStackTeamOf(s);
    if (stackTeam) teamStackCount.set(stackTeam, (teamStackCount.get(stackTeam) || 0) + 1);
  }
  function fillBand(bandPool: S[], target: number) {
    const sorted = [...bandPool].sort((a, b) => b.ev - a.ev);
    let added = 0;
    for (const s of sorted) { if (added >= target) break; if (passes(s)) { add(s); added++; } }
    if (added < target) {
      const old = TODFS_FC.MAX_PAIRWISE_OVERLAP;
      (TODFS_FC as any).MAX_PAIRWISE_OVERLAP = old + 1;
      for (const s of sorted) { if (added >= target) break; if (passes(s)) { add(s); added++; } }
      (TODFS_FC as any).MAX_PAIRWISE_OVERLAP = old;
    }
  }
  fillBand(sortedHigh.slice(0, Math.max(HIGH_TARGET * 5, 200)), HIGH_TARGET);
  fillBand(pool2, MID_TARGET);
  fillBand(sortedLow.slice(0, Math.max(LOW_TARGET * 5, 200)), LOW_TARGET);
  if (selected.length < N) {
    const sorted = [...pool2].sort((a, b) => b.ev - a.ev);
    for (const s of sorted) { if (selected.length >= N) break; if (passes(s)) add(s); }
  }

  const portfolio = selected.slice(0, N).map(s => s.lu);

  // Stats + export.
  console.log('================================================================');
  console.log('PORTFOLIO STATS — Theory-DFS V1-FieldCombo');
  console.log('================================================================\n');
  console.log('  Lineups: ' + portfolio.length + '/' + N);
  const avgProj = mean(portfolio.map(lu => lu.projection));
  const avgOwn = mean(portfolio.map(lu => lu.ownership));
  let sumSal = 0; for (const lu of portfolio) sumSal += lu.salary;
  console.log('  Avg projection: ' + avgProj.toFixed(1));
  console.log('  Avg ownership:  ' + avgOwn.toFixed(1) + '%');
  console.log('  Avg salary:     $' + (sumSal / portfolio.length).toFixed(0));

  // FC-specific stats.
  const selSat2 = selected.slice(0, N).map(s => s.sat_2);
  const selSat5 = selected.slice(0, N).map(s => s.sat_5);
  const selMaxSat = selected.slice(0, N).map(s => s.max_sat);
  const selMultiUniq = selected.slice(0, N).map(s => s.multi_level_uniqueness);
  console.log('\n  FieldCombo metrics (selected portfolio):');
  console.log('    sat_2 mean:   ' + mean(selSat2).toExponential(3));
  console.log('    sat_5 mean:   ' + mean(selSat5).toExponential(3));
  console.log('    max_sat mean: ' + mean(selMaxSat).toExponential(3));
  console.log('    multi_uniq mean: ' + mean(selMultiUniq).toFixed(2));

  // Stack distribution.
  const stackCounts = new Map<string, number>();
  for (const lu of portfolio) {
    const teams = new Map<string, number>();
    for (const p of lu.players) {
      if (isPitcher(p)) continue;
      const t = (p.team || '').toUpperCase();
      if (t) teams.set(t, (teams.get(t) || 0) + 1);
    }
    let primary = '', primarySize = 0;
    for (const [t, c] of teams) if (c > primarySize) { primarySize = c; primary = t; }
    if (primarySize >= 4 && primary) stackCounts.set(primary, (stackCounts.get(primary) || 0) + 1);
  }
  const sortedStacks = [...stackCounts.entries()].sort((a, b) => b[1] - a[1]);
  console.log('\n  Team stacks (4+ hitters):');
  for (const [t, c] of sortedStacks) {
    console.log('    ' + t.padEnd(5) + ' ' + c + ' lineups (' + ((c / portfolio.length) * 100).toFixed(0) + '%)');
  }

  // Top exposures.
  const playerExp = new Map<string, { count: number; name: string; team: string; own: number; proj: number }>();
  for (const lu of portfolio) for (const p of lu.players) {
    const e = playerExp.get(p.id) || { count: 0, name: p.name, team: p.team || '', own: p.ownership || 0, proj: p.projection || 0 };
    e.count++; playerExp.set(p.id, e);
  }
  const sortedExp = [...playerExp.entries()].sort((a, b) => b[1].count - a[1].count);
  console.log('\n  Top 15 player exposures:');
  for (const [, v] of sortedExp.slice(0, 15)) {
    console.log('    ' + v.name.padEnd(25) + ' ' + v.team.padEnd(5) + ' ' + ((v.count / portfolio.length) * 100).toFixed(1).padStart(5) + '% (' + v.count + '/' + portfolio.length + ')  own=' + v.own.toFixed(1) + '%  proj=' + v.proj.toFixed(1));
  }
  console.log('\n  Unique players: ' + playerExp.size);

  // Export — separate filenames so V1-NoCorr output is not overwritten.
  const tag = OUTPUT_TAG ? '_' + OUTPUT_TAG : '';
  const OUTPUT_FILE = path.join(DATA_DIR, 'theory_dfs_v1_field_combo_preslate_' + N + tag + '.csv');
  const DETAILED_FILE = path.join(DATA_DIR, 'theory_dfs_v1_field_combo_preslate_' + N + tag + '_detailed.csv');
  exportForDraftKings(portfolio, config, OUTPUT_FILE);
  exportDetailedLineups(portfolio, config, DETAILED_FILE);

  // Augmented detail CSV with FC metrics for monitoring.
  const FC_METRICS_FILE = path.join(DATA_DIR, 'theory_dfs_v1_field_combo_preslate_' + N + tag + '_fc_metrics.csv');
  const fcRows: string[] = ['lineup_idx,proj,salary,ownership_sum,primary_stack_size,sat_2,sat_3,sat_4,sat_5,max_sat,multi_level_uniqueness,ev'];
  selected.slice(0, N).forEach((s, i) => {
    fcRows.push([
      i + 1,
      s.proj.toFixed(2),
      s.lu.salary,
      s.lu.ownership.toFixed(2),
      s.primarySize,
      s.sat_2.toExponential(4),
      s.sat_3.toExponential(4),
      s.sat_4.toExponential(4),
      s.sat_5.toExponential(4),
      s.max_sat.toExponential(4),
      s.multi_level_uniqueness.toFixed(4),
      s.ev.toFixed(4),
    ].join(','));
  });
  fs.writeFileSync(FC_METRICS_FILE, fcRows.join('\n'));

  console.log('\n================================================================');
  console.log('DONE — Theory-DFS V1-FieldCombo preslate');
  console.log('================================================================');
  console.log('  DK upload:  ' + OUTPUT_FILE);
  console.log('  Detail:     ' + DETAILED_FILE);
  console.log('  FC metrics: ' + FC_METRICS_FILE);
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });
