/**
 * Theory-of-DFS ARGUS Pre-Slate (parallel variant runner). Currently v4.
 *
 * Argus is the deployed configuration of V1-MultiComboPenalty. Codename
 * after Argus Panoptes — the all-seeing 100-eyed giant — because the
 * penalty looks at all 627 combo dimensions per lineup (sizes 2-5) and
 * catches chalk wherever it surfaces.
 *
 * v4 (current, 2026-05-07): replaces the broken independence field model
 * (Adj Own product) with the SS pool-count field model. Validation across
 * 16 dev slates showed the independence model under-predicted same-team
 * combos by 19×–561× (sizes 2-5) and lost on Pearson(log_pred, log_actual)
 * to the pool model on 16/16 slates at sizes 3/4/5. Pool model captures
 * the team-stack correlation structure the field actually plays.
 * See Stage 10 of IMPLEMENTATION_NOTES.md.
 *
 * Spec is locked in:
 *   C:/Users/colin/dfs opto/multi_combo_penalty_implementation/IMPLEMENTATION_NOTES.md
 *
 * Key differences from V1-NoCorr:
 *   - Field combo frequency table (sizes 2-5) precomputed once per slate
 *     using the Adj Own product approximation (same as V1-FieldCombo).
 *   - Per-lineup multi_combo_penalty = -log(product of top-5 most-saturated
 *     combos in the lineup, MEDIAN-RESCALED so all sizes contribute on
 *     comparable scales). Higher value = lower joint concentration =
 *     more leverage. Lower value = lineup combines multiple chalk combos.
 *   - EV gains a NEW additive term: + W_MULTI × multi_combo_penalty_pct
 *     (W_MULTI = 0.20, walked back from a brief 0.40 trial after the 16-slate
 *     pro-consensus check showed 0.40 over-corrected away from pros — see
 *     Stage 8/9 of IMPLEMENTATION_NOTES.md).
 *   - V1-NoCorr's existing combo uniqueness term (W_CMB × uniqPct, 0.25
 *     weight) is PRESERVED — multi-combo penalty refines selection, not
 *     replaces existing scoring.
 *
 * Spec evolution:
 *   - v1 (initial): top-K=5 from raw freq pool. Diagnostic on 5-6-26 showed
 *     top-5 was 99.7% pairs by magnitude — quintets/quads never entered the
 *     product. Per-size signal effectively dead.
 *   - v3 (current/Argus): each combo's freq divided by the candidate-pool
 *     median freq for its size before sorting. Top-5 composition becomes
 *     ~20%/18%/16%/46% (pair/trip/quad/quint), giving genuine multi-size
 *     coverage. 5-6-26 portfolio meanOwn drops 10.17 → 8.66 (-15%).
 *   - W_MULTI: 0.20 → 0.40. Doubling does most of the demotion work
 *     (e.g., Ragans+Soto+Bichette triple goes from V1=13 lineups → 0).
 *
 * All other V1-NoCorr components UNCHANGED:
 *   - Candidate pool generation (SaberSim merge + dedup)
 *   - Correlation params (only PITCHER_VS_HITTER_PENALTY = -0.10 active)
 *   - Min-stack-4 hard filter
 *   - Variance-band selection (20/60/20 high/mid/low)
 *   - Exposure caps: 25% hitter, 45% pitcher, 20% team stack
 *   - Pairwise overlap cap (max 6)
 *   - PPD penalty (top 10% PPD lineups × 0.90)
 *   - Output format (DK upload + detailed CSV)
 *
 * Pre-registered constants (DO NOT TUNE):
 *   - K = 5 (count of combos in product)
 *   - W_MULTI = 0.20
 *   - Field freq default 1e-9, log epsilon 1e-12
 *
 * Validation path: parallel live deployment alongside V1-NoCorr over 20-30
 * slates. Backtest comparison is DESCRIPTIVE only, not deployment criterion.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as csvParse } from 'csv-parse/sync';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';
import { exportForDraftKings, exportDetailedLineups } from '../scoring';

const DATA_DIR = 'C:/Users/colin/dfs opto';
// Default preslate files; overridable via env vars ARGUS_PROJ_FILE and
// ARGUS_POOL_FILES (or legacy MCP_*) — comma-separated. Used by verification
// harness to point at historical slates without modifying the production
// runner path.
const PROJ_FILE = process.env.ARGUS_PROJ_FILE || process.env.MCP_PROJ_FILE || 'mlbdkprojpre.csv';
const POOL_FILES = (process.env.ARGUS_POOL_FILES || process.env.MCP_POOL_FILES || 'sspool2pre.csv,sspool3pre.csv').split(',').map(s => s.trim()).filter(s => s.length > 0);
const OUTPUT_TAG = process.env.ARGUS_OUTPUT_TAG || process.env.MCP_OUTPUT_TAG || '';
const TARGET_COUNT = process.env.ARGUS_TARGET_COUNT ? parseInt(process.env.ARGUS_TARGET_COUNT, 10)
                   : process.env.MCP_TARGET_COUNT ? parseInt(process.env.MCP_TARGET_COUNT, 10) : 150;
const N = TARGET_COUNT;

// Pre-registered constants — DO NOT TUNE.
const ARGUS = {
  // Correlation params (V1-NoCorr): zero forcing, only P-vs-H penalty active.
  STACK_BONUS_PER_HITTER: 0,
  BRINGBACK_1: 0,
  BRINGBACK_2: 0,
  PITCHER_VS_HITTER_PENALTY: -0.10,
  // Hard stack constraint.
  MIN_PRIMARY_STACK: 4,
  // EV weights — V1-NoCorr preserved + new W_MULTI added.
  W_PROJ: 1.0,
  W_LEV: 0.30,
  W_VAR: 0.15,
  W_CMB: 0.25,    // V1-NoCorr existing combo uniqueness — PRESERVED
  W_MULTI: 0.20,  // multi-combo joint concentration penalty (Argus: walked back 0.40 → 0.20 after pro-consensus validation)
  // V1-NoCorr triple cap (used by existing combo uniqueness term).
  TRIPLE_FREQ_CAP: 5,
  // Exposure / portfolio caps — V1-NoCorr values preserved.
  EXPOSURE_CAP_HITTER: 0.25,
  EXPOSURE_CAP_PITCHER: 0.45,
  TEAM_STACK_CAP: 0.20,
  // Variance-band selection.
  BAND_HIGH_PCT: 0.20,
  BAND_MID_PCT: 0.60,
  BAND_LOW_PCT: 0.20,
  MAX_PAIRWISE_OVERLAP: 6,
  // PPD penalty.
  PPD_LINEUP_PENALTY: 0.10,
  PPD_LINEUP_TOP_PCT: 0.10,
  // Multi-combo penalty parameters (pre-registered).
  TOP_K: 5,                  // count of combos in the product
  LOG_EPSILON: 1e-12,        // floor inside -log(product + ε)
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
 * Field combo frequency precomputation (sizes 2-5, pitchers included).
 *
 * Argus-v4: pool-count field model. For each combo present in the candidate
 * pool, field_freq = (# pool lineups containing combo) / pool_size. This
 * directly captures the team-stack correlation structure that the v1-v3
 * independence model (Adj Own product) systematically under-predicted by
 * 19×–561× at sizes 2–5 (see Stage 10 of IMPLEMENTATION_NOTES.md).
 *
 * Validation result: pool model wins Pearson(log_pred, log_actual) at
 * sizes 3/4/5 on 16/16 dev slates vs the independence model.
 *
 * Combos not present in the pool get FIELD_FREQ_DEFAULT at lookup time
 * (uses 0.5 / pool_size as a Laplace-smoothed missing-combo estimate, set
 * dynamically per slate).
 *
 * Computed ONCE per slate before the scoring loop.
 */
function computeFieldComboFrequencies(
  candidatePool: Lineup[],
  _adjOwnById: Map<string, number>
): {
  pairFreq: Map<string, number>;
  tripleFreq: Map<string, number>;
  quadFreq: Map<string, number>;
  quintFreq: Map<string, number>;
  poolSize: number;
} {
  const pairCount = new Map<string, number>();
  const tripleCount = new Map<string, number>();
  const quadCount = new Map<string, number>();
  const quintCount = new Map<string, number>();

  for (const lu of candidatePool) {
    const ids = lu.players.map(p => p.id).sort();
    const n = ids.length;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const k2 = ids[i] + '|' + ids[j];
        pairCount.set(k2, (pairCount.get(k2) || 0) + 1);
        for (let l = j + 1; l < n; l++) {
          const k3 = ids[i] + '|' + ids[j] + '|' + ids[l];
          tripleCount.set(k3, (tripleCount.get(k3) || 0) + 1);
          for (let m = l + 1; m < n; m++) {
            const k4 = ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m];
            quadCount.set(k4, (quadCount.get(k4) || 0) + 1);
            for (let q = m + 1; q < n; q++) {
              const k5 = ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m] + '|' + ids[q];
              quintCount.set(k5, (quintCount.get(k5) || 0) + 1);
            }
          }
        }
      }
    }
  }

  const P = candidatePool.length;
  const pairFreq = new Map<string, number>();
  const tripleFreq = new Map<string, number>();
  const quadFreq = new Map<string, number>();
  const quintFreq = new Map<string, number>();
  for (const [k, c] of pairCount) pairFreq.set(k, c / P);
  for (const [k, c] of tripleCount) tripleFreq.set(k, c / P);
  for (const [k, c] of quadCount) quadFreq.set(k, c / P);
  for (const [k, c] of quintCount) quintFreq.set(k, c / P);

  return { pairFreq, tripleFreq, quadFreq, quintFreq, poolSize: P };
}

/**
 * Median per size across the candidate pool's combo freq tables.
 * Used by Argus to put pair/triple/quad/quint freqs on comparable scales
 * before picking the top-K most-chalk combos in any given lineup.
 */
function computeMediansBySize(
  pairFreq: Map<string, number>,
  tripleFreq: Map<string, number>,
  quadFreq: Map<string, number>,
  quintFreq: Map<string, number>
): { med2: number; med3: number; med4: number; med5: number } {
  function median(m: Map<string, number>): number {
    if (m.size === 0) return 1;
    const arr: number[] = [];
    for (const v of m.values()) arr.push(v);
    arr.sort((a, b) => a - b);
    return arr[Math.floor(arr.length / 2)] || 1;
  }
  return {
    med2: median(pairFreq),
    med3: median(tripleFreq),
    med4: median(quadFreq),
    med5: median(quintFreq),
  };
}

/**
 * Per-lineup multi-combo joint concentration penalty (Argus / v3 spec).
 *
 * Steps:
 *   1. Enumerate all C(10,k) combos for k=2,3,4,5 (45+120+210+252 = 627).
 *   2. Look up field_freq for each combo.
 *   3. Compute chalk_ratio = freq / median_freq_for_size_k. This puts each
 *      size on a comparable scale — the median for each size becomes 1.0.
 *   4. Sort all 627 by chalk_ratio descending.
 *   5. Take top-K (K=5) most-chalky-for-their-size combos.
 *   6. Compute product of top-K chalk_ratios.
 *   7. Return -log(product + ε) as the penalty value.
 *
 * Higher returned value = lower joint concentration = MORE leverage.
 * Lower returned value = lineup combines multiple chalk combos = LESS leverage.
 *
 * Why median-rescaled (v3 vs original v1): pair freqs are 100× higher than
 * quint freqs by raw magnitude, so a top-K=5 over raw freqs is structurally
 * dominated by pairs (5-6-26 diagnostic showed 99.7% of slots were pairs).
 * Rescaling by per-size median forces 3/4/5-mans into the top-K when they
 * are chalk-extreme for their size; on 5-6-26 this gives a top-K composition
 * of ~20%/18%/16%/46% (pair/trip/quad/quint).
 *
 * Pitchers included in all combo enumerations (lu.players is full 10-player roster).
 */
function computeMultiComboPenalty(
  lineup: Lineup,
  pairFreq: Map<string, number>,
  tripleFreq: Map<string, number>,
  quadFreq: Map<string, number>,
  quintFreq: Map<string, number>,
  medians: { med2: number; med3: number; med4: number; med5: number },
  missingFreq: number
): { penalty: number; topConcentration: number; topRatio: number; maxFreq: number } {
  const ids = lineup.players.map(p => p.id).sort();
  const n = ids.length;
  // Track each combo as { rawFreq, chalkRatio } so we sort by ratio but
  // can also report the raw-freq-based concentration for monitoring.
  const slots: { f: number; r: number }[] = [];
  let maxFreq = 0;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const f2 = pairFreq.get(ids[i] + '|' + ids[j]) ?? missingFreq;
      slots.push({ f: f2, r: f2 / medians.med2 });
      if (f2 > maxFreq) maxFreq = f2;
      for (let l = j + 1; l < n; l++) {
        const f3 = tripleFreq.get(ids[i] + '|' + ids[j] + '|' + ids[l]) ?? missingFreq;
        slots.push({ f: f3, r: f3 / medians.med3 });
        if (f3 > maxFreq) maxFreq = f3;
        for (let m = l + 1; m < n; m++) {
          const f4 = quadFreq.get(ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m]) ?? missingFreq;
          slots.push({ f: f4, r: f4 / medians.med4 });
          if (f4 > maxFreq) maxFreq = f4;
          for (let q = m + 1; q < n; q++) {
            const f5 = quintFreq.get(ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m] + '|' + ids[q]) ?? missingFreq;
            slots.push({ f: f5, r: f5 / medians.med5 });
            if (f5 > maxFreq) maxFreq = f5;
          }
        }
      }
    }
  }

  slots.sort((a, b) => b.r - a.r);
  const topK = slots.slice(0, ARGUS.TOP_K);
  let prodRatio = 1;
  let prodFreq = 1;
  for (const s of topK) { prodRatio *= s.r; prodFreq *= s.f; }
  const penalty = -Math.log(prodRatio + ARGUS.LOG_EPSILON);
  return { penalty, topConcentration: prodFreq, topRatio: prodRatio, maxFreq };
}

/**
 * V1-NoCorr's existing combo uniqueness — pair + capped-triple log-frequency
 * sum, derived from the candidate pool's projection-weighted freqs (NOT from
 * field ownership). Preserved here because spec 1E mandates it stays as a
 * separate scoring component alongside the new multi-combo penalty.
 */
function buildPairTripleFreqs(candidates: Lineup[]): { pair: Map<string, number>; triple: Map<string, number> } {
  const pair = new Map<string, number>();
  const triple = new Map<string, number>();
  let totalWeight = 0;

  for (const lineup of candidates) {
    const weight = Math.max(0.1, lineup.projection || 1) ** 2;
    totalWeight += weight;
    const ids = lineup.players.map(p => p.id).sort();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const k2 = ids[i] + '|' + ids[j];
        pair.set(k2, (pair.get(k2) || 0) + weight);
        for (let l = j + 1; l < ids.length; l++) {
          const k3 = ids[i] + '|' + ids[j] + '|' + ids[l];
          triple.set(k3, (triple.get(k3) || 0) + weight);
        }
      }
    }
  }

  if (totalWeight <= 0) return { pair, triple };
  for (const k of pair.keys()) pair.set(k, (pair.get(k) || 0) / totalWeight);
  for (const k of triple.keys()) triple.set(k, (triple.get(k) || 0) / totalWeight);
  return { pair, triple };
}

function computeV1Uniqueness(
  lineup: Lineup,
  pairFreqs: Map<string, number>,
  tripleFreqs: Map<string, number>,
  tripleFreqCap: number
): number {
  let uniqueness = 0;
  const players = lineup.players;
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const key = [players[i].id, players[j].id].sort().join('|');
      uniqueness += -Math.log(pairFreqs.get(key) || 1e-6);
    }
  }
  const tripleFreqList: number[] = [];
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      for (let k = j + 1; k < players.length; k++) {
        const key = [players[i].id, players[j].id, players[k].id].sort().join('|');
        tripleFreqList.push(tripleFreqs.get(key) || 1e-6);
      }
    }
  }
  tripleFreqList.sort((a, b) => b - a);
  for (const freq of tripleFreqList.slice(0, tripleFreqCap)) {
    uniqueness += -Math.log(freq);
  }
  return uniqueness;
}

async function main() {
  console.log('================================================================');
  console.log('ARGUS PRE-SLATE  (V1-MultiComboPenalty v4, W_MULTI=' + ARGUS.W_MULTI + ')');
  console.log('================================================================');
  console.log('Pool-count field model + median-rescaled multi-combo penalty (top-K=5 chalk-ratios, sizes 2-5).');
  console.log('EV = 1.0×projPct + 0.30×(1-ownPct) + 0.15×rangePct×0.85 + 0.25×uniqPct + ' + ARGUS.W_MULTI + '×multiComboPenaltyPct.');
  console.log('V1-NoCorr W_CMB combo uniqueness PRESERVED alongside W_MULTI term.');
  console.log('Validation path: parallel live deployment, NOT backtest.');
  console.log('================================================================\n');

  const projPath = path.join(DATA_DIR, PROJ_FILE);
  console.log('Loading projections: ' + projPath);
  const pr = parseCSVFile(projPath, 'mlb', true);
  const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
  const pool = buildPlayerPool(pr.players, pr.detectedContestType);
  console.log('  Players: ' + pool.players.length);

  const adjOwnById = loadAdjOwnFromProjections(projPath);
  console.log('  Adj Own loaded for ' + adjOwnById.size + ' players');

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

  // V1-NoCorr's existing combo uniqueness (preserved per spec 1E).
  console.log('Building V1-NoCorr pair/triple freqs (preserved combo uniqueness)...');
  const v1Freqs = buildPairTripleFreqs(candidates);
  console.log('  Pairs:   ' + v1Freqs.pair.size + ', Triples: ' + v1Freqs.triple.size + '\n');

  // Field combo frequency precomputation (Argus-v4: pool-count model, sizes 2-5).
  console.log('Computing field combo frequencies (sizes 2-5, pool-count model)...');
  const t0 = Date.now();
  const fieldFreqs = computeFieldComboFrequencies(candidates, adjOwnById);
  console.log('  Pool size: ' + fieldFreqs.poolSize);
  console.log('  Pairs:     ' + fieldFreqs.pairFreq.size);
  console.log('  Triples:   ' + fieldFreqs.tripleFreq.size);
  console.log('  Quads:     ' + fieldFreqs.quadFreq.size);
  console.log('  Quintets:  ' + fieldFreqs.quintFreq.size);
  console.log('  ' + ((Date.now() - t0) / 1000).toFixed(2) + 's');

  // Argus v3: per-size median for chalk-ratio rescaling.
  const medians = computeMediansBySize(fieldFreqs.pairFreq, fieldFreqs.tripleFreq, fieldFreqs.quadFreq, fieldFreqs.quintFreq);
  console.log('  Median freq per size: pair=' + medians.med2.toExponential(2) + ' trip=' + medians.med3.toExponential(2) +
              ' quad=' + medians.med4.toExponential(2) + ' quint=' + medians.med5.toExponential(2));

  // Argus v4: missing-combo Laplace smoother = 0.5 / pool_size.
  const missingFreq = 0.5 / Math.max(1, fieldFreqs.poolSize);
  console.log('  Missing-combo freq (Laplace 0.5/P): ' + missingFreq.toExponential(2) + '\n');

  // Score every candidate.
  console.log('Scoring (Argus = V1-MultiComboPenalty v3, W_MULTI=' + ARGUS.W_MULTI + ')...');
  interface S {
    lu: Lineup;
    primarySize: number;
    primaryTeam: string;
    bringBack: number;
    pitcherVsHitterCount: number;
    corrAdj: number;
    logOwn: number;
    uniqueness: number;       // V1's existing combo uniqueness
    multiPenalty: number;     // NEW
    topConcentration: number; // NEW (for monitoring CSV)
    maxFreq: number;          // NEW (for monitoring CSV)
    ppd: number;
    proj: number; floor: number; ceiling: number; range: number;
    ev: number;
    projPct: number; ownPct: number; rangePct: number; ppdPct: number;
    uniqPct: number; multiPenaltyPct: number;
  }
  const scored: S[] = [];
  const t1 = Date.now();
  for (const lu of candidates) {
    let floor = 0, ceiling = 0;
    for (const p of lu.players) {
      if (p.percentiles) { floor += p.percentiles.p25 || p.projection * 0.85; ceiling += p.percentiles.p75 || p.projection * 1.15; }
      else { floor += p.projection * 0.85; ceiling += p.projection * 1.15; }
    }

    // Correlation (V1-NoCorr params).
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
    if (primarySize >= 3) corrAdj += ARGUS.STACK_BONUS_PER_HITTER * (primarySize - 2);
    if (bringBack === 1) corrAdj += ARGUS.BRINGBACK_1;
    else if (bringBack >= 2) corrAdj += ARGUS.BRINGBACK_2;
    corrAdj += ARGUS.PITCHER_VS_HITTER_PENALTY * pOppHitters;

    // V1-NoCorr existing combo uniqueness (preserved).
    const uniqueness = computeV1Uniqueness(lu, v1Freqs.pair, v1Freqs.triple, ARGUS.TRIPLE_FREQ_CAP);

    // Argus v4: pool-count field model, median-rescaled, multi-combo penalty.
    const mc = computeMultiComboPenalty(lu, fieldFreqs.pairFreq, fieldFreqs.tripleFreq, fieldFreqs.quadFreq, fieldFreqs.quintFreq, medians, missingFreq);

    // Leverage penalty: hitter ownership only (matches V1-NoCorr).
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
      primaryTeam,
      bringBack,
      pitcherVsHitterCount: pOppHitters,
      corrAdj,
      logOwn,
      uniqueness,
      multiPenalty: mc.penalty,
      topConcentration: mc.topConcentration,
      maxFreq: mc.maxFreq,
      ppd,
      proj: lu.projection, floor, ceiling, range: ceiling - floor,
      ev: 0, projPct: 0, ownPct: 0, rangePct: 0, ppdPct: 0, uniqPct: 0, multiPenaltyPct: 0,
    });
  }
  console.log('  ' + ((Date.now() - t1) / 1000).toFixed(2) + 's for ' + scored.length + ' lineups\n');

  // Percentile ranks across the candidate pool.
  const projAdj = scored.map(s => Math.max(0, s.proj * (1 + s.corrAdj)));
  const projPct = rankPercentile(projAdj);
  const ownPct = rankPercentile(scored.map(s => s.logOwn));
  const rangePct = rankPercentile(scored.map(s => s.range));
  const ppdPct = rankPercentile(scored.map(s => s.ppd));
  const uniqPct = rankPercentile(scored.map(s => s.uniqueness));
  const multiPenaltyPct = rankPercentile(scored.map(s => s.multiPenalty));
  for (let i = 0; i < scored.length; i++) {
    scored[i].projPct = projPct[i];
    scored[i].ownPct = ownPct[i];
    scored[i].rangePct = rangePct[i];
    scored[i].ppdPct = ppdPct[i];
    scored[i].uniqPct = uniqPct[i];
    scored[i].multiPenaltyPct = multiPenaltyPct[i];
  }

  // V1-NoCorr EV formula + new W_MULTI term.
  for (const s of scored) {
    let ev = ARGUS.W_PROJ * s.projPct
           + ARGUS.W_LEV * (1 - s.ownPct)
           + ARGUS.W_VAR * s.rangePct * 0.85
           + ARGUS.W_CMB * s.uniqPct
           + ARGUS.W_MULTI * s.multiPenaltyPct;
    if (s.ppdPct >= 1 - ARGUS.PPD_LINEUP_TOP_PCT) ev *= (1 - ARGUS.PPD_LINEUP_PENALTY);
    s.ev = ev;
  }

  // Hard 4+ stack constraint (V1-NoCorr behavior).
  let pool2 = scored.filter(s => s.primarySize >= ARGUS.MIN_PRIMARY_STACK);
  if (pool2.length < N) pool2 = scored;

  // Variance-band selection (20/60/20).
  const sortedHigh = [...pool2].sort((a, b) => (b.projPct + b.ownPct) - (a.projPct + a.ownPct));
  const sortedLow = [...pool2].sort((a, b) => ((1 - b.projPct) + (1 - b.ownPct)) - ((1 - a.projPct) + (1 - a.ownPct)));
  const HIGH_TARGET = Math.round(N * ARGUS.BAND_HIGH_PCT);
  const LOW_TARGET = Math.round(N * ARGUS.BAND_LOW_PCT);
  const MID_TARGET = N - HIGH_TARGET - LOW_TARGET;

  const selected: S[] = [];
  const exposure = new Map<string, number>();
  const teamStackCount = new Map<string, number>();
  const seen = new Set<string>();
  let relaxedOverlap = 0;

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
  function passes(s: S, maxOverlap: number): boolean {
    if (seen.has(s.lu.hash)) return false;
    if (s.primarySize < ARGUS.MIN_PRIMARY_STACK) return false;
    for (const p of s.lu.players) {
      const cur = exposure.get(p.id) || 0;
      const cap = isPitcher(p) ? ARGUS.EXPOSURE_CAP_PITCHER : ARGUS.EXPOSURE_CAP_HITTER;
      if ((cur + 1) / N > cap) return false;
    }
    const stackTeam = primaryStackTeamOf(s);
    if (stackTeam) {
      const cur = teamStackCount.get(stackTeam) || 0;
      if ((cur + 1) / N > ARGUS.TEAM_STACK_CAP) return false;
    }
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
    const stackTeam = primaryStackTeamOf(s);
    if (stackTeam) teamStackCount.set(stackTeam, (teamStackCount.get(stackTeam) || 0) + 1);
  }
  function fillBand(bandPool: S[], target: number) {
    const sorted = [...bandPool].sort((a, b) => b.ev - a.ev);
    let added = 0;
    for (const s of sorted) { if (added >= target) break; if (passes(s, ARGUS.MAX_PAIRWISE_OVERLAP)) { add(s); added++; } }
    if (added < target) {
      relaxedOverlap++;
      for (const s of sorted) { if (added >= target) break; if (passes(s, ARGUS.MAX_PAIRWISE_OVERLAP + 1)) { add(s); added++; } }
    }
  }
  fillBand(sortedHigh.slice(0, Math.max(HIGH_TARGET * 5, 200)), HIGH_TARGET);
  fillBand(pool2, MID_TARGET);
  fillBand(sortedLow.slice(0, Math.max(LOW_TARGET * 5, 200)), LOW_TARGET);
  if (selected.length < N) {
    const sorted = [...pool2].sort((a, b) => b.ev - a.ev);
    for (const s of sorted) { if (selected.length >= N) break; if (passes(s, ARGUS.MAX_PAIRWISE_OVERLAP + 1)) add(s); }
  }
  if (selected.length < N) {
    const sorted = [...pool2].sort((a, b) => b.ev - a.ev);
    for (const s of sorted) { if (selected.length >= N) break; if (passes(s, ARGUS.MAX_PAIRWISE_OVERLAP + 2)) add(s); }
  }

  const portfolio = selected.slice(0, N).map(s => s.lu);

  // Stats + export.
  console.log('================================================================');
  console.log('PORTFOLIO STATS — Argus (V1-MultiComboPenalty v3)');
  console.log('================================================================\n');
  console.log('  Lineups: ' + portfolio.length + '/' + N);
  console.log('  Pool after min-stack-4: ' + pool2.length + '/' + scored.length);
  console.log('  Relaxed-overlap fallbacks: ' + relaxedOverlap);
  const avgProj = mean(portfolio.map(lu => lu.projection));
  const avgOwn = mean(portfolio.map(lu => lu.ownership));
  let sumSal = 0; for (const lu of portfolio) sumSal += lu.salary;
  console.log('  Avg projection: ' + avgProj.toFixed(1));
  console.log('  Avg ownership:  ' + avgOwn.toFixed(1) + '%');
  console.log('  Avg salary:     $' + (sumSal / Math.max(1, portfolio.length)).toFixed(0));

  // MCP-specific stats on selected portfolio.
  const selPenalty = selected.slice(0, N).map(s => s.multiPenalty);
  const selTopConc = selected.slice(0, N).map(s => s.topConcentration);
  const selMaxFreq = selected.slice(0, N).map(s => s.maxFreq);
  console.log('\n  MultiCombo metrics (selected portfolio):');
  console.log('    multi_combo_penalty mean: ' + mean(selPenalty).toFixed(3));
  console.log('    multi_combo_penalty min:  ' + Math.min(...selPenalty).toFixed(3));
  console.log('    multi_combo_penalty max:  ' + Math.max(...selPenalty).toFixed(3));
  console.log('    top_concentration mean:   ' + mean(selTopConc).toExponential(3));
  console.log('    top_concentration max:    ' + Math.max(...selTopConc).toExponential(3));
  console.log('    max_combo_freq mean:      ' + mean(selMaxFreq).toExponential(3));

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
  const OUTPUT_FILE = path.join(DATA_DIR, 'theory_dfs_argus_preslate_' + N + tag + '.csv');
  const DETAILED_FILE = path.join(DATA_DIR, 'theory_dfs_argus_preslate_' + N + tag + '_detailed.csv');
  exportForDraftKings(portfolio, config, OUTPUT_FILE);
  exportDetailedLineups(portfolio, config, DETAILED_FILE);

  // Augmented detail CSV with Argus metrics for monitoring.
  const MCP_METRICS_FILE = path.join(DATA_DIR, 'theory_dfs_argus_preslate_' + N + tag + '_metrics.csv');
  const mcpRows: string[] = ['lineup_idx,proj,salary,ownership_sum,primary_stack_size,uniqueness,multi_combo_penalty,top_concentration,max_combo_freq,ev'];
  selected.slice(0, N).forEach((s, i) => {
    mcpRows.push([
      i + 1,
      s.proj.toFixed(2),
      s.lu.salary,
      s.lu.ownership.toFixed(2),
      s.primarySize,
      s.uniqueness.toFixed(4),
      s.multiPenalty.toFixed(4),
      s.topConcentration.toExponential(4),
      s.maxFreq.toExponential(4),
      s.ev.toFixed(4),
    ].join(','));
  });
  fs.writeFileSync(MCP_METRICS_FILE, mcpRows.join('\n'));

  console.log('\n================================================================');
  console.log('DONE — Argus preslate (V1-MultiComboPenalty v3)');
  console.log('================================================================');
  console.log('  DK upload:     ' + OUTPUT_FILE);
  console.log('  Detail:        ' + DETAILED_FILE);
  console.log('  Argus metrics: ' + MCP_METRICS_FILE);
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });
