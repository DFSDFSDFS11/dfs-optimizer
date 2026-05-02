/**
 * Theory-DFS V2 NBA Pre-Slate.
 *
 * Empirical NBA combo-saturation analysis (12 slates, 100K+ NBA grinder lineups) found:
 * pro_gap is ~0 or NEGATIVE across all combo types. NBA grinders are AT LEAST as saturated
 * as field on every combo size (2/3/4/5) and every type (same-team, same-game, bring-back).
 *
 * Implication: NBA combinatorial uniqueness penalty should be ZEROED OUT entirely.
 * That's what V2 NBA does here: type_scales = 0 for all types → W_CMB term contributes nothing.
 * Net effect: scoring = projection + correlation + leverage + variance, no combo penalty.
 *
 * Top-5 hard filter: also skipped (NBA pros use saturated combos at field rate).
 *
 * Tonight's MLB equivalent uses non-zero scales because MLB pros DO exploit combos. NBA empirical
 * data says no combo exploitation exists, so V2 NBA = pure projection/leverage/variance ranking.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player, ContestConfig } from '../types';
import { parseCSVFile, buildPlayerPool, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';
import { exportForDraftKings, exportDetailedLineups } from '../scoring';

const DATA_DIR = 'C:/Users/colin/dfs opto';
const PROJ_FILE = 'nbaprojpre.csv';
const POOL_FILES = ['ssnbapool.csv', 'ssnbapool2.csv'];
const TARGET_COUNT = 50;
const N = TARGET_COUNT;

// NBA-specific Theory-DFS V2 params.
// Cross-sport-equal: W_PROJ, W_LEV, W_VAR, EXPLOITATIVE_EXPONENT, BAND splits.
// NBA-specific: weaker correlation magnitudes (Ch.7), no team-stack mandate, lower exposure caps.
const TODFS_NBA_V2 = {
  // Correlation (1B) — UNCHANGED from V1 NBA per Ch.7 framework guidance.
  GAME_STACK_BONUS: 0.05,
  OPPOSING_TEAM_BONUS: 0.03,
  TEAM_NEGATIVE_PER_EXTRA: -0.04,

  // EV weights — W_CMB ZEROED OUT per empirical NBA finding.
  W_PROJ: 1.0, W_LEV: 0.30, W_VAR: 0.15,
  W_CMB: 0.0,        // <<< ZEROED — empirical NBA pros don't avoid saturated combos
  W_CEIL_EFF: 0.10,

  // Selection.
  EXPOSURE_CAP_HITTER: 0.40,
  BAND_HIGH_PCT: 0.20, BAND_MID_PCT: 0.60, BAND_LOW_PCT: 0.20,
  MAX_PAIRWISE_OVERLAP: 5,    // NBA roster=8, scaled overlap cap

  // PPD penalty — keep at MLB level since no NBA-specific finding contradicts.
  PPD_LINEUP_PENALTY: 0.10, PPD_LINEUP_TOP_PCT: 0.10,
};

function isPitcher(p: Player): boolean { return false; }  // NBA — no pitchers
function mean(a: number[]): number { if (!a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; }
function rankPercentile(values: number[]): number[] {
  const idx = values.map((v, i) => ({ v, i }));
  idx.sort((a, b) => a.v - b.v);
  const out = new Array<number>(values.length);
  for (let r = 0; r < values.length; r++) out[idx[r].i] = values.length > 1 ? r / (values.length - 1) : 0;
  return out;
}

async function main() {
  console.log('================================================================');
  console.log('THEORY-DFS V2 NBA PRE-SLATE');
  console.log('================================================================');
  console.log('Empirical NBA finding: combinatorial uniqueness penalty contributes nothing.');
  console.log('Pro gap = 0 or negative across all combo types/sizes (12 slates, 100K+ lineups).');
  console.log('V2 NBA: W_CMB = 0 (no combo penalty), no top-5 filter.');
  console.log('================================================================\n');

  // 1. Projections.
  const projPath = path.join(DATA_DIR, PROJ_FILE);
  console.log('Loading projections: ' + projPath);
  const pr = parseCSVFile(projPath, 'nba', true);
  const config = getContestConfig('dk', 'nba', pr.detectedContestType);
  const playerPool = buildPlayerPool(pr.players, pr.detectedContestType);
  console.log('  Players: ' + playerPool.players.length);

  // 2. Merge pools.
  const idMap = new Map<string, Player>();
  for (const p of playerPool.players) idMap.set(p.id, p);
  const merged = new Map<string, Lineup>();
  let total = 0;
  for (const pf of POOL_FILES) {
    const pp = path.join(DATA_DIR, pf);
    if (!fs.existsSync(pp)) { console.log('  Skip ' + pf + ': not found'); continue; }
    const loaded = loadPoolFromCSV({ filePath: pp, config, playerMap: idMap });
    total += loaded.lineups.length;
    for (const lu of loaded.lineups) if (!merged.has(lu.hash)) merged.set(lu.hash, lu);
    console.log('  ' + pf + ': ' + loaded.lineups.length + ' lineups');
  }
  const candidates = Array.from(merged.values());
  console.log('  Merged: ' + candidates.length + ' unique lineups (from ' + total + ')\n');

  // 3. Score lineups.
  console.log('Scoring (no combo penalty per empirical NBA finding)...');
  interface S {
    lu: Lineup; primaryGameSize: number; primaryTeamSize: number; corrAdj: number;
    logOwn: number; ppd: number; proj: number; floor: number; ceiling: number; range: number;
    ev: number; projPct: number; ownPct: number; rangePct: number; ppdPct: number; ceilEffPct: number;
  }
  const scored: S[] = [];
  for (const lu of candidates) {
    let floor = 0, ceiling = 0;
    for (const p of lu.players) {
      if (p.percentiles) { floor += p.percentiles.p25 || p.projection * 0.85; ceiling += p.percentiles.p75 || p.projection * 1.15; }
      else { floor += p.projection * 0.85; ceiling += p.projection * 1.15; }
    }
    // Correlation (1B) — game-stack focus.
    const gameCounts = new Map<string, number>();
    const teamCounts = new Map<string, number>();
    for (const p of lu.players) {
      const t = (p.team || '').toUpperCase(), o = (p.opponent || '').toUpperCase();
      if (t) teamCounts.set(t, (teamCounts.get(t) || 0) + 1);
      if (t && o) { const g = [t, o].sort().join('@'); gameCounts.set(g, (gameCounts.get(g) || 0) + 1); }
    }
    let primaryGame = '', primaryGameSize = 0;
    for (const [g, c] of gameCounts) if (c > primaryGameSize) { primaryGameSize = c; primaryGame = g; }
    let primaryTeamSize = 0;
    for (const [, c] of teamCounts) if (c > primaryTeamSize) primaryTeamSize = c;
    let bringBack = 0;
    if (primaryGame) {
      const [a, b] = primaryGame.split('@');
      const ca = teamCounts.get(a) || 0, cb = teamCounts.get(b) || 0;
      if (ca > 0 && cb > 0) bringBack = Math.min(ca, cb);
    }
    let cannibal = 0;
    for (const [, c] of teamCounts) if (c >= 3) cannibal += (c - 2);
    let corrAdj = 0;
    if (primaryGameSize >= 3) corrAdj += TODFS_NBA_V2.GAME_STACK_BONUS;
    if (primaryGameSize >= 3 && bringBack >= 2) corrAdj += TODFS_NBA_V2.OPPOSING_TEAM_BONUS;
    corrAdj += TODFS_NBA_V2.TEAM_NEGATIVE_PER_EXTRA * cannibal;

    let logOwn = 0;
    for (const p of lu.players) logOwn += Math.log(Math.max(0.1, p.ownership || 0.5));
    let ppd = 0;
    for (const p of lu.players) if (p.salary && p.projection) ppd += p.projection / (p.salary / 1000);

    scored.push({
      lu, primaryGameSize, primaryTeamSize, corrAdj, logOwn, ppd,
      proj: lu.projection, floor, ceiling, range: ceiling - floor,
      ev: 0, projPct: 0, ownPct: 0, rangePct: 0, ppdPct: 0, ceilEffPct: 0,
    });
  }

  const projAdj = scored.map(s => s.proj * (1 + s.corrAdj));
  const projPct = rankPercentile(projAdj);
  const ownPct = rankPercentile(scored.map(s => s.logOwn));
  const rangePct = rankPercentile(scored.map(s => s.range));
  const ppdPct = rankPercentile(scored.map(s => s.ppd));
  const ceilEffPct = rankPercentile(scored.map(s => s.proj > 0 ? s.ceiling / s.proj : 0));
  for (let i = 0; i < scored.length; i++) {
    scored[i].projPct = projPct[i]; scored[i].ownPct = ownPct[i];
    scored[i].rangePct = rangePct[i]; scored[i].ppdPct = ppdPct[i];
    scored[i].ceilEffPct = ceilEffPct[i];
  }
  for (const s of scored) {
    let ev = TODFS_NBA_V2.W_PROJ * s.projPct
           + TODFS_NBA_V2.W_LEV * (1 - s.ownPct)
           + TODFS_NBA_V2.W_VAR * s.rangePct * 0.8
           + TODFS_NBA_V2.W_CEIL_EFF * s.ceilEffPct;
    // W_CMB term skipped: 0 contribution.
    if (s.ppdPct >= 1 - TODFS_NBA_V2.PPD_LINEUP_TOP_PCT) ev *= (1 - TODFS_NBA_V2.PPD_LINEUP_PENALTY);
    s.ev = ev;
  }

  // 4. Variance bands + greedy selection.
  const sortedHigh = [...scored].sort((a, b) => (b.projPct + b.ownPct) - (a.projPct + a.ownPct));
  const sortedLow = [...scored].sort((a, b) => ((1 - b.projPct) + (1 - b.ownPct)) - ((1 - a.projPct) + (1 - a.ownPct)));
  const HIGH_TARGET = Math.round(N * TODFS_NBA_V2.BAND_HIGH_PCT);
  const LOW_TARGET = Math.round(N * TODFS_NBA_V2.BAND_LOW_PCT);
  const MID_TARGET = N - HIGH_TARGET - LOW_TARGET;
  const selected: S[] = [];
  const exposure = new Map<string, number>();
  const seen = new Set<string>();
  function passes(s: S): boolean {
    if (seen.has(s.lu.hash)) return false;
    for (const p of s.lu.players) {
      const cur = exposure.get(p.id) || 0;
      if ((cur + 1) / N > TODFS_NBA_V2.EXPOSURE_CAP_HITTER) return false;
    }
    const ids = new Set(s.lu.players.map(p => p.id));
    for (const sel of selected) {
      let ov = 0; for (const p of sel.lu.players) if (ids.has(p.id)) ov++;
      if (ov > TODFS_NBA_V2.MAX_PAIRWISE_OVERLAP) return false;
    }
    return true;
  }
  function add(s: S) {
    selected.push(s); seen.add(s.lu.hash);
    for (const p of s.lu.players) exposure.set(p.id, (exposure.get(p.id) || 0) + 1);
  }
  function fillBand(bandPool: S[], target: number) {
    const sorted = [...bandPool].sort((a, b) => b.ev - a.ev);
    let added = 0;
    for (const s of sorted) { if (added >= target) break; if (passes(s)) { add(s); added++; } }
    if (added < target) {
      const old = TODFS_NBA_V2.MAX_PAIRWISE_OVERLAP;
      (TODFS_NBA_V2 as any).MAX_PAIRWISE_OVERLAP = old + 1;
      for (const s of sorted) { if (added >= target) break; if (passes(s)) { add(s); added++; } }
      (TODFS_NBA_V2 as any).MAX_PAIRWISE_OVERLAP = old;
    }
  }
  fillBand(sortedHigh.slice(0, Math.max(HIGH_TARGET * 5, 200)), HIGH_TARGET);
  fillBand(scored, MID_TARGET);
  fillBand(sortedLow.slice(0, Math.max(LOW_TARGET * 5, 200)), LOW_TARGET);
  if (selected.length < N) {
    const sorted = [...scored].sort((a, b) => b.ev - a.ev);
    for (const s of sorted) { if (selected.length >= N) break; if (passes(s)) add(s); }
  }
  const portfolio = selected.slice(0, N).map(s => s.lu);

  // 5. Stats + export.
  console.log('================================================================');
  console.log('PORTFOLIO STATS — Theory-DFS V2 NBA');
  console.log('================================================================\n');
  console.log('  Lineups: ' + portfolio.length + '/' + N);
  const avgProj = mean(portfolio.map(lu => lu.projection));
  const avgOwn = mean(portfolio.map(lu => lu.ownership));
  let sumSal = 0; for (const lu of portfolio) sumSal += lu.salary;
  console.log('  Avg projection: ' + avgProj.toFixed(1));
  console.log('  Avg ownership: ' + avgOwn.toFixed(1) + '%');
  console.log('  Avg salary: $' + (sumSal / portfolio.length).toFixed(0));

  // Top exposures.
  const playerExp = new Map<string, { count: number; name: string; team: string; own: number; proj: number }>();
  for (const lu of portfolio) for (const p of lu.players) {
    const e = playerExp.get(p.id) || { count: 0, name: p.name, team: p.team || '', own: p.ownership || 0, proj: p.projection || 0 };
    e.count++; playerExp.set(p.id, e);
  }
  const sortedExp = [...playerExp.entries()].sort((a, b) => b[1].count - a[1].count);
  console.log('\n  Top 15 player exposures:');
  for (const [, v] of sortedExp.slice(0, 15)) {
    console.log('    ' + v.name.padEnd(25) + ' ' + v.team.padEnd(5) + ' ' + ((v.count / portfolio.length) * 100).toFixed(1).padStart(5) + '% (' + v.count + '/' + portfolio.length + ')  own=' + v.own.toFixed(1) + '% proj=' + v.proj.toFixed(1));
  }
  console.log('\n  Unique players: ' + playerExp.size);

  // Export.
  const OUTPUT_FILE = path.join(DATA_DIR, 'theory_dfs_v2_nba_preslate_' + N + '.csv');
  const DETAILED_FILE = path.join(DATA_DIR, 'theory_dfs_v2_nba_preslate_' + N + '_detailed.csv');
  exportForDraftKings(portfolio, config, OUTPUT_FILE);
  exportDetailedLineups(portfolio, config, DETAILED_FILE);
  console.log('\n================================================================');
  console.log('DONE — Theory-DFS V2 NBA preslate');
  console.log('================================================================');
  console.log('  DK upload: ' + OUTPUT_FILE);
  console.log('  Detail:    ' + DETAILED_FILE);
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });
