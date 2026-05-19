/**
 * Theory-of-DFS V1-PortfolioCombo Pre-Slate (parallel variant runner).
 *
 * V1-PortfolioCombo is a framework-grounded architectural EXTENSION of V1-NoCorr.
 * It adds COMBO-LEVEL decorrelation caps during greedy selection. Combo caps
 * complement (not replace) the existing player / team / overlap caps.
 *
 * Spec is locked in:
 *   C:/Users/colin/dfs opto/portfolio_combo_implementation/IMPLEMENTATION_NOTES.md
 *
 * Key differences from V1-NoCorr:
 *   - PortfolioComboTracker class tracks 4-combo and 5-combo counts across the
 *     selected portfolio.
 *   - Per-candidate enumeration of all C(10,4)=210 size-4 and C(10,5)=252 size-5
 *     combos (pitchers INCLUDED).
 *   - Cap thresholds: 13% of N for size-4, 9% of N for size-5
 *     (Math.floor(N × pct)).
 *   - Cap enforcement: passes(s) checks tracker before accepting.
 *   - Fallback cascade per band: relax overlap +1 → relax combo caps +2pp →
 *     disable combo caps entirely.
 *   - Output: per-lineup combo metadata, aggregate combo diversity stats.
 *
 * SCORING IS NOT MODIFIED. Only the selection phase is extended with combo
 * cap tracking.
 *
 * Validation path: parallel live deployment alongside V1-NoCorr. NOT empirical
 * backtest (Phase 1 NO-GO).
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';
import { exportForDraftKings, exportDetailedLineups } from '../scoring';

const DATA_DIR = 'C:/Users/colin/dfs opto';
// Default preslate files; overridable via env vars PC_PROJ_FILE and PC_POOL_FILES
// (comma-separated). Used by verification harness to point at historical slates
// without modifying the production runner path.
const PROJ_FILE = process.env.PC_PROJ_FILE || 'mlbdkprojpre.csv';
const POOL_FILES = (process.env.PC_POOL_FILES || 'sspool2pre.csv,sspool3pre.csv').split(',').map(s => s.trim()).filter(s => s.length > 0);
const OUTPUT_TAG = process.env.PC_OUTPUT_TAG || '';
const TARGET_COUNT = process.env.PC_TARGET_COUNT ? parseInt(process.env.PC_TARGET_COUNT, 10) : 1000;
const N = TARGET_COUNT;

// Pre-registered constants — DO NOT TUNE.
const TODFS_PC = {
  // Correlation params (V1-NoCorr): zero forcing.
  STACK_BONUS_PER_HITTER: 0,
  BRINGBACK_1: 0,
  BRINGBACK_2: 0,
  PITCHER_VS_HITTER_PENALTY: -0.10,
  // Hard stack constraint.
  MIN_PRIMARY_STACK: 4,
  // EV weights (PortfolioCombo preserves V1's existing scoring).
  W_PROJ: 1.0, W_LEV: 0.30, W_VAR: 0.15, W_CMB: 0.25,
  // Exposure / portfolio caps (per spec — pre-registered).
  EXPOSURE_CAP_HITTER: 0.20,
  EXPOSURE_CAP_PITCHER: 0.45,
  TEAM_STACK_CAP: 0.15,
  // Variance-band selection.
  BAND_HIGH_PCT: 0.20,
  BAND_MID_PCT: 0.60,
  BAND_LOW_PCT: 0.20,
  MAX_PAIRWISE_OVERLAP: 6,
  TRIPLE_FREQ_CAP: 5,
  // PPD penalty.
  PPD_LINEUP_PENALTY: 0.10,
  PPD_LINEUP_TOP_PCT: 0.10,
  // NEW combo caps (pre-registered, do not tune).
  COMBO4_CAP_PCT: 0.13,
  COMBO5_CAP_PCT: 0.09,
  COMBO_CAP_RELAX_PP: 0.02,
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
 * Enumerate all C(10,4)=210 size-4 combos and C(10,5)=252 size-5 combos for
 * a 10-player roster. Pitchers INCLUDED. Combo IDs are canonical:
 * sorted player IDs joined with '|'.
 *
 * Single shared helper guarantees that the enumeration order and key format
 * used at scoring time match exactly what the tracker uses for cap checks.
 */
function enumerateCombos(playerIds: string[]): { combos4: string[]; combos5: string[] } {
  const ids = [...playerIds].sort();
  const n = ids.length;
  const combos4: string[] = [];
  const combos5: string[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (let k = j + 1; k < n; k++) {
        for (let l = k + 1; l < n; l++) {
          combos4.push(ids[i] + '|' + ids[j] + '|' + ids[k] + '|' + ids[l]);
          for (let m = l + 1; m < n; m++) {
            combos5.push(ids[i] + '|' + ids[j] + '|' + ids[k] + '|' + ids[l] + '|' + ids[m]);
          }
        }
      }
    }
  }
  return { combos4, combos5 };
}

/**
 * Tracks 4-combo and 5-combo counts across the selected portfolio. Caps
 * are integer counts derived from `floor(N × cap_pct)`.
 */
class PortfolioComboTracker {
  private size4Counts = new Map<string, number>();
  private size5Counts = new Map<string, number>();
  private size4Cap: number;
  private size5Cap: number;
  private capsEnabled = true;
  // Audit counters.
  public rejectionsBy4Cap = 0;
  public rejectionsBy5Cap = 0;

  constructor(N: number, size4Pct: number, size5Pct: number) {
    this.size4Cap = Math.floor(N * size4Pct);
    this.size5Cap = Math.floor(N * size5Pct);
  }

  canAccept(combos4: string[], combos5: string[]): boolean {
    if (!this.capsEnabled) return true;
    for (const c of combos4) {
      if ((this.size4Counts.get(c) || 0) + 1 > this.size4Cap) {
        this.rejectionsBy4Cap++;
        return false;
      }
    }
    for (const c of combos5) {
      if ((this.size5Counts.get(c) || 0) + 1 > this.size5Cap) {
        this.rejectionsBy5Cap++;
        return false;
      }
    }
    return true;
  }

  /**
   * Returns per-lineup metadata: how many of this lineup's 4-combos and
   * 5-combos are first-time vs duplicate vs the current portfolio state.
   * Called BEFORE accept() so the counts reflect the pre-accept state.
   */
  classify(combos4: string[], combos5: string[]): {
    firstTimeCombos4: number; dupCombos4: number;
    firstTimeCombos5: number; dupCombos5: number;
  } {
    let f4 = 0, d4 = 0, f5 = 0, d5 = 0;
    for (const c of combos4) {
      if ((this.size4Counts.get(c) || 0) === 0) f4++;
      else d4++;
    }
    for (const c of combos5) {
      if ((this.size5Counts.get(c) || 0) === 0) f5++;
      else d5++;
    }
    return { firstTimeCombos4: f4, dupCombos4: d4, firstTimeCombos5: f5, dupCombos5: d5 };
  }

  accept(combos4: string[], combos5: string[]): void {
    for (const c of combos4) this.size4Counts.set(c, (this.size4Counts.get(c) || 0) + 1);
    for (const c of combos5) this.size5Counts.set(c, (this.size5Counts.get(c) || 0) + 1);
  }

  /** Relax both caps by deltaPp (e.g. 0.02 for +2pp). Recomputes integer caps. */
  relaxCaps(deltaPp: number, N: number, size4PctBase: number, size5PctBase: number): void {
    this.size4Cap = Math.floor(N * (size4PctBase + deltaPp));
    this.size5Cap = Math.floor(N * (size5PctBase + deltaPp));
  }

  /** Restore caps to their pre-registered values. */
  restoreCaps(N: number, size4Pct: number, size5Pct: number): void {
    this.size4Cap = Math.floor(N * size4Pct);
    this.size5Cap = Math.floor(N * size5Pct);
    this.capsEnabled = true;
  }

  /** Disable cap enforcement entirely (last-resort fallback). */
  disableCaps(): void { this.capsEnabled = false; }
  /** Re-enable caps (after a fallback band finishes). */
  enableCaps(): void { this.capsEnabled = true; }

  isEnabled(): boolean { return this.capsEnabled; }
  getSize4Cap(): number { return this.size4Cap; }
  getSize5Cap(): number { return this.size5Cap; }

  uniqueCount(size: 4 | 5): number {
    return size === 4 ? this.size4Counts.size : this.size5Counts.size;
  }

  topK(size: 4 | 5, k: number): Array<{ combo: string; count: number }> {
    const m = size === 4 ? this.size4Counts : this.size5Counts;
    const arr = [...m.entries()].map(([combo, count]) => ({ combo, count }));
    arr.sort((a, b) => b.count - a.count);
    return arr.slice(0, k);
  }

  maxCount(size: 4 | 5): number {
    const m = size === 4 ? this.size4Counts : this.size5Counts;
    let max = 0;
    for (const v of m.values()) if (v > max) max = v;
    return max;
  }
}

async function main() {
  console.log('================================================================');
  console.log('THEORY-DFS V1-PortfolioCombo PRE-SLATE (parallel variant)');
  console.log('================================================================');
  console.log('V1-NoCorr scoring + COMBO-LEVEL decorrelation caps during selection.');
  console.log('Cap thresholds: size-4 13% of N, size-5 9% of N (pre-registered).');
  console.log('Fallback cascade: overlap +1 → combo caps +2pp → caps disabled.');
  console.log('Validation path: parallel live deployment, NOT backtest.');
  console.log('================================================================\n');

  const projPath = path.join(DATA_DIR, PROJ_FILE);
  console.log('Loading projections: ' + projPath);
  const pr = parseCSVFile(projPath, 'mlb', true);
  const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
  const pool = buildPlayerPool(pr.players, pr.detectedContestType);
  console.log('  Players: ' + pool.players.length);

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

  // Build pair/triple frequency maps from candidate pool (V1-NoCorr scoring,
  // unchanged — combo caps operate at selection time, not scoring time).
  console.log('Computing combo frequencies (for V1 W_CMB scoring term)...');
  const pairFreq = new Map<string, number>();
  const tripFreq = new Map<string, number>();
  let totalW = 0;
  for (const lu of candidates) {
    const w = Math.max(0.1, lu.projection || 1) ** 2;
    totalW += w;
    const ids = lu.players.map(p => p.id).sort();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        pairFreq.set(ids[i] + '|' + ids[j], (pairFreq.get(ids[i] + '|' + ids[j]) || 0) + w);
      }
      for (let j = i + 1; j < ids.length; j++) {
        for (let l = j + 1; l < ids.length; l++) {
          const k = ids[i] + '|' + ids[j] + '|' + ids[l];
          tripFreq.set(k, (tripFreq.get(k) || 0) + w);
        }
      }
    }
  }
  for (const k of pairFreq.keys()) pairFreq.set(k, pairFreq.get(k)! / totalW);
  for (const k of tripFreq.keys()) tripFreq.set(k, tripFreq.get(k)! / totalW);

  // Score each lineup (V1 baseline — UNCHANGED).
  console.log('Scoring (V1-NoCorr formula, unchanged)...');
  interface S {
    lu: Lineup; primarySize: number; corrAdj: number; logOwn: number; uniqueness: number; ppd: number;
    proj: number; floor: number; ceiling: number; range: number; ev: number;
    projPct: number; ownPct: number; rangePct: number; ppdPct: number; uniqPct: number;
    combos4: string[]; combos5: string[];   // NEW: precomputed combo IDs.
  }
  const tScore0 = Date.now();
  const scored: S[] = [];
  for (const lu of candidates) {
    let floor = 0, ceiling = 0;
    for (const p of lu.players) {
      if (p.percentiles) { floor += p.percentiles.p25 || p.projection * 0.85; ceiling += p.percentiles.p75 || p.projection * 1.15; }
      else { floor += p.projection * 0.85; ceiling += p.projection * 1.15; }
    }
    // Correlation (1B).
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
    if (primarySize >= 3) corrAdj += TODFS_PC.STACK_BONUS_PER_HITTER * (primarySize - 2);
    if (bringBack === 1) corrAdj += TODFS_PC.BRINGBACK_1;
    else if (bringBack >= 2) corrAdj += TODFS_PC.BRINGBACK_2;
    corrAdj += TODFS_PC.PITCHER_VS_HITTER_PENALTY * pOppHitters;

    // Combinatorial uniqueness (1E) — UNCHANGED from V1-NoCorr.
    let uniqueness = 0;
    const players = lu.players;
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const k = [players[i].id, players[j].id].sort().join('|');
        const f = pairFreq.get(k) || 1e-6;
        uniqueness += -Math.log(f);
      }
    }
    const tripFs: { key: string; f: number }[] = [];
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        for (let l = j + 1; l < players.length; l++) {
          const tk = [players[i].id, players[j].id, players[l].id].sort().join('|');
          tripFs.push({ key: tk, f: tripFreq.get(tk) || 1e-6 });
        }
      }
    }
    tripFs.sort((a, b) => b.f - a.f);
    for (const t of tripFs.slice(0, TODFS_PC.TRIPLE_FREQ_CAP)) {
      uniqueness += -Math.log(t.f);
    }

    // Leverage (1C) — UNCHANGED from V1-NoCorr.
    let logOwn = 0;
    for (const p of lu.players) {
      if (isPitcher(p)) continue;
      logOwn += Math.log(Math.max(0.1, p.ownership || 0.5));
    }
    let ppd = 0;
    for (const p of lu.players) if (p.salary && p.projection) ppd += p.projection / (p.salary / 1000);

    // NEW: precompute size-4 and size-5 combo IDs once per candidate.
    const { combos4, combos5 } = enumerateCombos(lu.players.map(p => p.id));

    scored.push({
      lu, primarySize, corrAdj, logOwn, uniqueness, ppd,
      proj: lu.projection, floor, ceiling, range: ceiling - floor,
      ev: 0, projPct: 0, ownPct: 0, rangePct: 0, ppdPct: 0, uniqPct: 0,
      combos4, combos5,
    });
  }
  console.log('  Scored ' + scored.length + ' lineups in ' + ((Date.now() - tScore0) / 1000).toFixed(2) + 's');

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
    let ev = TODFS_PC.W_PROJ * s.projPct
           + TODFS_PC.W_LEV * (1 - s.ownPct)
           + TODFS_PC.W_VAR * s.rangePct * 0.85
           + TODFS_PC.W_CMB * s.uniqPct;
    if (s.ppdPct >= 1 - TODFS_PC.PPD_LINEUP_TOP_PCT) ev *= (1 - TODFS_PC.PPD_LINEUP_PENALTY);
    s.ev = ev;
  }

  // Hard 4+ stack constraint.
  let pool2 = scored.filter(s => s.primarySize >= TODFS_PC.MIN_PRIMARY_STACK);
  if (pool2.length < N) pool2 = scored;

  // Variance-band selection (20/60/20).
  const sortedHigh = [...pool2].sort((a, b) => (b.projPct + b.ownPct) - (a.projPct + a.ownPct));
  const sortedLow = [...pool2].sort((a, b) => ((1 - b.projPct) + (1 - b.ownPct)) - ((1 - a.projPct) + (1 - a.ownPct)));
  const HIGH_TARGET = Math.round(N * TODFS_PC.BAND_HIGH_PCT);
  const LOW_TARGET = Math.round(N * TODFS_PC.BAND_LOW_PCT);
  const MID_TARGET = N - HIGH_TARGET - LOW_TARGET;

  // Per-lineup audit metadata captured in selection order so we can write it
  // out to the metrics CSV later. Index aligned with `selected[]`.
  interface SelMeta { firstTimeCombos4: number; dupCombos4: number; firstTimeCombos5: number; dupCombos5: number; fallbackStage: number; }
  const selMeta: SelMeta[] = [];

  // Combo tracker — NEW.
  const tracker = new PortfolioComboTracker(N, TODFS_PC.COMBO4_CAP_PCT, TODFS_PC.COMBO5_CAP_PCT);
  console.log('Combo cap thresholds for N=' + N + ': size-4 ≤ ' + tracker.getSize4Cap() + ' (' + (TODFS_PC.COMBO4_CAP_PCT * 100).toFixed(1) + '%), size-5 ≤ ' + tracker.getSize5Cap() + ' (' + (TODFS_PC.COMBO5_CAP_PCT * 100).toFixed(1) + '%)\n');

  // Track which fallback stage filled each lineup (0=normal, 1=overlap+1, 2=combo+2pp, 3=combo disabled).
  let currentFallbackStage = 0;

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
    if (s.primarySize < TODFS_PC.MIN_PRIMARY_STACK) return false;
    for (const p of s.lu.players) {
      const cur = exposure.get(p.id) || 0;
      const cap = isPitcher(p) ? TODFS_PC.EXPOSURE_CAP_PITCHER : TODFS_PC.EXPOSURE_CAP_HITTER;
      if ((cur + 1) / N > cap) return false;
    }
    const stackTeam = primaryStackTeamOf(s);
    if (stackTeam) {
      const cur = teamStackCount.get(stackTeam) || 0;
      if ((cur + 1) / N > TODFS_PC.TEAM_STACK_CAP) return false;
    }
    const ids = new Set(s.lu.players.map(p => p.id));
    for (const sel of selected) {
      let ov = 0; for (const p of sel.lu.players) if (ids.has(p.id)) ov++;
      if (ov > TODFS_PC.MAX_PAIRWISE_OVERLAP) return false;
    }
    // NEW: combo cap check (last; cheaper to fail other checks first).
    if (!tracker.canAccept(s.combos4, s.combos5)) return false;
    return true;
  }
  function add(s: S) {
    // Capture per-lineup audit metadata BEFORE incrementing the tracker,
    // so first-time vs dup counts reflect the pre-accept portfolio state.
    const meta = tracker.classify(s.combos4, s.combos5);
    selMeta.push({ ...meta, fallbackStage: currentFallbackStage });
    selected.push(s); seen.add(s.lu.hash);
    for (const p of s.lu.players) exposure.set(p.id, (exposure.get(p.id) || 0) + 1);
    const stackTeam = primaryStackTeamOf(s);
    if (stackTeam) teamStackCount.set(stackTeam, (teamStackCount.get(stackTeam) || 0) + 1);
    tracker.accept(s.combos4, s.combos5);
  }

  // Per-band fill function with bounded fallback cascade:
  //   stage 0: caps as pre-registered
  //   stage 1: relax MAX_PAIRWISE_OVERLAP +1 (V1 existing fallback)
  //   stage 2: relax combo caps +2pp (NEW)
  //   stage 3: disable combo caps (NEW, last resort)
  // After the band fills, all caps are restored to pre-registered values
  // for the next band.
  function fillBand(bandPool: S[], target: number, label: string) {
    const sorted = [...bandPool].sort((a, b) => b.ev - a.ev);
    let added = 0;
    const startSelected = selected.length;
    const wantTotal = startSelected + target;

    // Stage 0.
    currentFallbackStage = 0;
    for (const s of sorted) { if (selected.length >= wantTotal) break; if (passes(s)) { add(s); added++; } }

    // Stage 1: relax overlap +1 (existing V1 fallback).
    if (selected.length < wantTotal) {
      const old = TODFS_PC.MAX_PAIRWISE_OVERLAP;
      (TODFS_PC as any).MAX_PAIRWISE_OVERLAP = old + 1;
      currentFallbackStage = 1;
      for (const s of sorted) { if (selected.length >= wantTotal) break; if (passes(s)) { add(s); added++; } }
      (TODFS_PC as any).MAX_PAIRWISE_OVERLAP = old;
    }

    // Stage 2: relax combo caps +2pp.
    if (selected.length < wantTotal) {
      tracker.relaxCaps(TODFS_PC.COMBO_CAP_RELAX_PP, N, TODFS_PC.COMBO4_CAP_PCT, TODFS_PC.COMBO5_CAP_PCT);
      currentFallbackStage = 2;
      console.log('  [' + label + '] band underfilled at stage 1 — relaxing combo caps +2pp (size-4 ≤ ' + tracker.getSize4Cap() + ', size-5 ≤ ' + tracker.getSize5Cap() + ').');
      for (const s of sorted) { if (selected.length >= wantTotal) break; if (passes(s)) { add(s); added++; } }
      tracker.restoreCaps(N, TODFS_PC.COMBO4_CAP_PCT, TODFS_PC.COMBO5_CAP_PCT);
    }

    // Stage 3: disable combo caps entirely (last resort).
    if (selected.length < wantTotal) {
      tracker.disableCaps();
      currentFallbackStage = 3;
      console.log('  [' + label + '] band still underfilled — disabling combo caps as last-resort fallback.');
      for (const s of sorted) { if (selected.length >= wantTotal) break; if (passes(s)) { add(s); added++; } }
      tracker.enableCaps();
    }

    currentFallbackStage = 0;
    if (selected.length < wantTotal) {
      console.log('  [' + label + '] band still underfilled after all fallbacks: ' + (selected.length - startSelected) + '/' + target + '.');
    }
  }

  fillBand(sortedHigh.slice(0, Math.max(HIGH_TARGET * 5, 200)), HIGH_TARGET, 'HIGH');
  fillBand(pool2, MID_TARGET, 'MID');
  fillBand(sortedLow.slice(0, Math.max(LOW_TARGET * 5, 200)), LOW_TARGET, 'LOW');
  if (selected.length < N) {
    // Final top-up: try with all caps active first; cascade if needed.
    const sorted = [...pool2].sort((a, b) => b.ev - a.ev);
    currentFallbackStage = 0;
    for (const s of sorted) { if (selected.length >= N) break; if (passes(s)) add(s); }
    if (selected.length < N) {
      const old = TODFS_PC.MAX_PAIRWISE_OVERLAP;
      (TODFS_PC as any).MAX_PAIRWISE_OVERLAP = old + 1;
      currentFallbackStage = 1;
      for (const s of sorted) { if (selected.length >= N) break; if (passes(s)) add(s); }
      (TODFS_PC as any).MAX_PAIRWISE_OVERLAP = old;
    }
    if (selected.length < N) {
      tracker.relaxCaps(TODFS_PC.COMBO_CAP_RELAX_PP, N, TODFS_PC.COMBO4_CAP_PCT, TODFS_PC.COMBO5_CAP_PCT);
      currentFallbackStage = 2;
      for (const s of sorted) { if (selected.length >= N) break; if (passes(s)) add(s); }
      tracker.restoreCaps(N, TODFS_PC.COMBO4_CAP_PCT, TODFS_PC.COMBO5_CAP_PCT);
    }
    if (selected.length < N) {
      tracker.disableCaps();
      currentFallbackStage = 3;
      for (const s of sorted) { if (selected.length >= N) break; if (passes(s)) add(s); }
      tracker.enableCaps();
    }
  }

  const portfolio = selected.slice(0, N).map(s => s.lu);

  // Stats + export.
  console.log('================================================================');
  console.log('PORTFOLIO STATS — Theory-DFS V1-PortfolioCombo');
  console.log('================================================================\n');
  console.log('  Lineups: ' + portfolio.length + '/' + N);
  const avgProj = mean(portfolio.map(lu => lu.projection));
  const avgOwn = mean(portfolio.map(lu => lu.ownership));
  let sumSal = 0; for (const lu of portfolio) sumSal += lu.salary;
  console.log('  Avg projection: ' + avgProj.toFixed(1));
  console.log('  Avg ownership:  ' + avgOwn.toFixed(1) + '%');
  console.log('  Avg salary:     $' + (sumSal / portfolio.length).toFixed(0));

  // Combo diversity stats — NEW.
  console.log('\n  Combo diversity:');
  console.log('    Unique 4-combos: ' + tracker.uniqueCount(4));
  console.log('    Unique 5-combos: ' + tracker.uniqueCount(5));
  console.log('    Max single 4-combo count: ' + tracker.maxCount(4) + ' (cap ' + tracker.getSize4Cap() + ')');
  console.log('    Max single 5-combo count: ' + tracker.maxCount(5) + ' (cap ' + tracker.getSize5Cap() + ')');
  console.log('    Cap rejections during selection — by 4-cap: ' + tracker.rejectionsBy4Cap + ', by 5-cap: ' + tracker.rejectionsBy5Cap);
  // Fallback stage summary.
  const stageCounts = [0, 0, 0, 0];
  for (const m of selMeta.slice(0, N)) stageCounts[m.fallbackStage]++;
  console.log('    Fallback stage of selected lineups: stage0=' + stageCounts[0] + ' stage1=' + stageCounts[1] + ' stage2=' + stageCounts[2] + ' stage3=' + stageCounts[3]);

  // Top-5 most-used combos by ID (use first hit's player names if accessible).
  const playerNameById = new Map<string, string>();
  for (const lu of portfolio) for (const p of lu.players) playerNameById.set(p.id, p.name);
  function fmtCombo(combo: string): string {
    return combo.split('|').map(id => playerNameById.get(id) || id).join(' + ');
  }
  console.log('\n    Top 5 most-used 4-combos:');
  for (const t of tracker.topK(4, 5)) console.log('      ' + ('×' + t.count).padStart(4) + '  ' + fmtCombo(t.combo));
  console.log('    Top 5 most-used 5-combos:');
  for (const t of tracker.topK(5, 5)) console.log('      ' + ('×' + t.count).padStart(4) + '  ' + fmtCombo(t.combo));

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

  // Export — separate filenames so V1-NoCorr and V1-FieldCombo outputs are not overwritten.
  const tag = OUTPUT_TAG ? '_' + OUTPUT_TAG : '';
  const OUTPUT_FILE = path.join(DATA_DIR, 'theory_dfs_v1_portfolio_combo_preslate_' + N + tag + '.csv');
  const DETAILED_FILE = path.join(DATA_DIR, 'theory_dfs_v1_portfolio_combo_preslate_' + N + tag + '_detailed.csv');
  exportForDraftKings(portfolio, config, OUTPUT_FILE);
  exportDetailedLineups(portfolio, config, DETAILED_FILE);

  // PortfolioCombo-specific per-lineup metrics CSV.
  const PC_METRICS_FILE = path.join(DATA_DIR, 'theory_dfs_v1_portfolio_combo_preslate_' + N + tag + '_pc_metrics.csv');
  const pcRows: string[] = ['lineup_idx,proj,salary,ownership_sum,primary_stack_size,first_time_combos4,dup_combos4,first_time_combos5,dup_combos5,fallback_stage,ev'];
  selected.slice(0, N).forEach((s, i) => {
    const m = selMeta[i] || { firstTimeCombos4: 0, dupCombos4: 0, firstTimeCombos5: 0, dupCombos5: 0, fallbackStage: 0 };
    pcRows.push([
      i + 1,
      s.proj.toFixed(2),
      s.lu.salary,
      s.lu.ownership.toFixed(2),
      s.primarySize,
      m.firstTimeCombos4,
      m.dupCombos4,
      m.firstTimeCombos5,
      m.dupCombos5,
      m.fallbackStage,
      s.ev.toFixed(4),
    ].join(','));
  });
  fs.writeFileSync(PC_METRICS_FILE, pcRows.join('\n'));

  console.log('\n================================================================');
  console.log('DONE — Theory-DFS V1-PortfolioCombo preslate');
  console.log('================================================================');
  console.log('  DK upload:  ' + OUTPUT_FILE);
  console.log('  Detail:     ' + DETAILED_FILE);
  console.log('  PC metrics: ' + PC_METRICS_FILE);
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });
