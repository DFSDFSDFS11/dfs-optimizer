/**
 * Theory-of-DFS V2 Pre-Slate (production runner).
 *
 * Tonight's MLB slate: load mlbdkprojpre.csv + sspool1pre.csv + sspool2pre.csv,
 * build V2 portfolio, output DK CSV.
 *
 * V2 mechanics (vs V1):
 *   - Type-aware combinatorial-uniqueness scaling (1E only, NOT correlation 1B)
 *   - Surgical top-5 hard filter (using merged pool as field proxy since no actuals yet)
 *
 * Empirical scales derived from 18-slate combo-saturation analysis (6 pros, 14,100 lineups).
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player, ContestConfig } from '../types';
import { parseCSVFile, buildPlayerPool, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';
import { exportForDraftKings, exportDetailedLineups } from '../scoring';

const DATA_DIR = 'C:/Users/colin/dfs opto';
const PROJ_FILE = 'mlbdkprojpre.csv';
const POOL_FILES = ['sspool1pre.csv', 'sspool2pre.csv', 'sspool3pre.csv'];
const TARGET_COUNT = 75;
const N = TARGET_COUNT;

// Empirical type scales (from combo_saturation_analysis).
const TYPE_SCALES: Record<string, number> = {
  'same-team-2H': 0.64, 'same-team-3H': 0.62, 'same-team-4H': 0.56, 'same-team-5H': 0.60,
  'P-plus-2stack': 0.62, 'P-plus-3stack': 0.59, 'P-plus-4stack': 0.53,
  'bring-back-2plus1': 0.00, 'bring-back-3plus1': 0.00, 'bring-back-4plus1': 0.00,
  'bring-back-2plus2': 0.25, 'bring-back-3plus2': 0.24,
  'same-game-2': 0.43, 'same-game-3': 0.25,
  'same-game-4': 0.00, 'same-game-5': 0.00,
  'pair-both-high-salary': 0.65, 'pair-both-low-salary': 0.50,
  'P-vs-1H': 1.00, 'other': 1.00,
};

const TODFS_PARAMS = {
  STACK_BONUS_PER_HITTER: 0.10, BRINGBACK_1: 0.05, BRINGBACK_2: 0.08, PITCHER_VS_HITTER_PENALTY: -0.10,
  MIN_PRIMARY_STACK: 4,
  W_PROJ: 1.0, W_LEV: 0.30, W_VAR: 0.15, W_CMB: 0.25,
  EXPOSURE_CAP_HITTER: 0.50, EXPOSURE_CAP_PITCHER: 1.00,
  BAND_HIGH_PCT: 0.20, BAND_MID_PCT: 0.60, BAND_LOW_PCT: 0.20,
  MAX_PAIRWISE_OVERLAP: 6, TRIPLE_FREQ_CAP: 5,
  PPD_LINEUP_PENALTY: 0.10, PPD_LINEUP_TOP_PCT: 0.10,
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

// ============================================================
// COMBO TYPE CLASSIFIER (matches combo-saturation-extract.ts)
// ============================================================
function classifyComboPair(a: Player, b: Player): string[] {
  const types: string[] = [];
  const aIsP = isPitcher(a), bIsP = isPitcher(b);
  const aTeam = (a.team || '').toUpperCase(), bTeam = (b.team || '').toUpperCase();
  const aOpp = (a.opponent || '').toUpperCase(), bOpp = (b.opponent || '').toUpperCase();
  if (!aIsP && !bIsP) {
    if (aTeam && bTeam && aTeam === bTeam) types.push('same-team-2H');
    if (aTeam && aOpp && bTeam && bOpp && [aTeam, aOpp].sort().join('@') === [bTeam, bOpp].sort().join('@')) {
      types.push('same-game-2');
    }
  }
  if ((aIsP && !bIsP && aOpp === bTeam) || (bIsP && !aIsP && bOpp === aTeam)) types.push('P-vs-1H');
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
  if (games.size === 1) types.push('same-game-' + players.length);
  if (hitters.length === players.length && [...teamCount.values()].length === 1) {
    types.push('same-team-' + players.length + 'H');
  }
  if (hitters.length === players.length && [...teamCount.values()].length === 2) {
    const counts = [...teamCount.values()].sort((a, b) => b - a);
    types.push('bring-back-' + counts[0] + 'plus' + counts[1]);
  }
  if (pitchers.length === 1 && hitters.length === players.length - 1) {
    const distinctTeams = new Set(hitters.map(p => (p.team || '').toUpperCase()));
    if (distinctTeams.size === 1) types.push('P-plus-' + hitters.length + 'stack');
  }
  if (types.length === 0) types.push('other');
  return types;
}

function comboTypeFor(players: Player[]): string {
  const types = players.length === 2 ? classifyComboPair(players[0], players[1]) : classifyComboTriple(players);
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
// MAIN
// ============================================================
async function main() {
  console.log('================================================================');
  console.log('THEORY-DFS V2 PRE-SLATE (empirically-calibrated combo uniqueness)');
  console.log('================================================================');
  console.log('Type scales (combinatorial uniqueness only — correlation 1B unchanged):');
  console.log('  same-team-NH:  ~0.60   (pros chalkier than V1, reduce penalty)');
  console.log('  P-plus-Nstack: ~0.58');
  console.log('  bring-back-1plus*: 0.00 (pros use at field rate; remove penalty entirely)');
  console.log('  bring-back-2plus*: ~0.25');
  console.log('  same-game-2/3: ~0.35   same-game-4/5: 0.00');
  console.log('Top-5 hard filter: uses merged pool as field proxy (no actuals pre-slate)');
  console.log('================================================================\n');

  // 1. Load projections
  const projPath = path.join(DATA_DIR, PROJ_FILE);
  console.log('Loading projections: ' + projPath);
  const pr = parseCSVFile(projPath, 'mlb', true);
  const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
  const pool = buildPlayerPool(pr.players, pr.detectedContestType);
  console.log('  Players parsed: ' + pool.players.length);

  // 2. Merge SS pools
  const idMap = new Map<string, Player>();
  for (const p of pool.players) idMap.set(p.id, p);
  const mergedByHash = new Map<string, Lineup>();
  let totalLoaded = 0;
  for (const pf of POOL_FILES) {
    const poolPath = path.join(DATA_DIR, pf);
    if (!fs.existsSync(poolPath)) { console.log('  Skipping ' + pf + ': not found'); continue; }
    const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
    totalLoaded += loaded.lineups.length;
    for (const lu of loaded.lineups) if (!mergedByHash.has(lu.hash)) mergedByHash.set(lu.hash, lu);
    console.log('  ' + pf + ': ' + loaded.lineups.length + ' lineups (' + loaded.unresolvedRows + ' unresolved)');
  }
  let candidates = Array.from(mergedByHash.values());
  console.log('  Merged pool: ' + candidates.length + ' unique lineups (from ' + totalLoaded + ' total)\n');

  // 3. Field proxy = merged pool. Compute top-5 most-saturated combos at sizes 2,3,4,5.
  console.log('Computing top-5 saturated combos (merged-pool as field proxy)...');
  const fieldCounts: Record<number, Map<string, number>> = { 2: new Map(), 3: new Map(), 4: new Map(), 5: new Map() };
  for (const lu of candidates) {
    for (const N2 of [2, 3, 4, 5]) {
      for (const c of combosOfSize(lu.players, N2)) {
        const k = c.map(p => p.id).sort().join('|');
        fieldCounts[N2].set(k, (fieldCounts[N2].get(k) || 0) + 1);
      }
    }
  }
  const top5ByLevel: Map<number, Set<string>> = new Map();
  for (const N2 of [2, 3, 4, 5]) {
    const sorted = [...fieldCounts[N2].entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    top5ByLevel.set(N2, new Set(sorted.map(x => x[0])));
    console.log('  Top-5 size-' + N2 + ' counts: ' + sorted.map(x => x[1]).join(', ') + ' (out of ' + candidates.length + ' lineups)');
  }

  // 4. Filter pool — remove any lineup containing ANY top-5 combo.
  const beforeFilter = candidates.length;
  candidates = candidates.filter(lu => {
    const ids = new Set(lu.players.map(p => p.id));
    for (const [, combos] of top5ByLevel) {
      for (const ck of combos) {
        const required = ck.split('|');
        let contains = true;
        for (const id of required) if (!ids.has(id)) { contains = false; break; }
        if (contains) return false;
      }
    }
    return true;
  });
  console.log('  After top-5 filter: ' + beforeFilter + ' -> ' + candidates.length + ' lineups\n');

  // 5. Build pair/triple frequency maps from filtered pool (1E baseline).
  console.log('Computing pair/triple frequencies for type-scaled uniqueness...');
  const pairFreq = new Map<string, number>();
  const tripFreq = new Map<string, number>();
  let totalW = 0;
  for (const lu of candidates) {
    const w = Math.max(0.1, lu.projection || 1) ** 2;
    totalW += w;
    const ids = lu.players.map(p => p.id).sort();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const k = ids[i] + '|' + ids[j];
        pairFreq.set(k, (pairFreq.get(k) || 0) + w);
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

  // 6. Score each lineup with type-scaled combinatorial uniqueness.
  console.log('Scoring with type-scaled combinatorial uniqueness...');
  interface S { lu: Lineup; primarySize: number; corrAdj: number; logOwn: number; uniqueness: number; ppd: number;
                proj: number; floor: number; ceiling: number; range: number; ev: number;
                projPct: number; ownPct: number; rangePct: number; ppdPct: number; }
  const scored: S[] = [];
  for (const lu of candidates) {
    let floor = 0, ceiling = 0;
    for (const p of lu.players) {
      if (p.percentiles) { floor += p.percentiles.p25 || p.projection * 0.85; ceiling += p.percentiles.p75 || p.projection * 1.15; }
      else { floor += p.projection * 0.85; ceiling += p.projection * 1.15; }
    }
    // Correlation (1B) — unchanged.
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

    // Type-scaled combinatorial uniqueness (1E).
    let uniqueness = 0;
    const players = lu.players;
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const k = [players[i].id, players[j].id].sort().join('|');
        const f = pairFreq.get(k) || 1e-6;
        const ty = comboTypeFor([players[i], players[j]]);
        const scale = TYPE_SCALES[ty] !== undefined ? TYPE_SCALES[ty] : 1.0;
        uniqueness += scale * (-Math.log(f));
      }
    }
    const tripFs: { players: Player[]; key: string; f: number }[] = [];
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        for (let l = j + 1; l < players.length; l++) {
          const tri = [players[i], players[j], players[l]];
          const tk = tri.map(p => p.id).sort().join('|');
          tripFs.push({ players: tri, key: tk, f: tripFreq.get(tk) || 1e-6 });
        }
      }
    }
    tripFs.sort((a, b) => b.f - a.f);
    for (const t of tripFs.slice(0, TODFS_PARAMS.TRIPLE_FREQ_CAP)) {
      const ty = comboTypeFor(t.players);
      const scale = TYPE_SCALES[ty] !== undefined ? TYPE_SCALES[ty] : 1.0;
      uniqueness += scale * (-Math.log(t.f));
    }

    let logOwn = 0;
    for (const p of lu.players) logOwn += Math.log(Math.max(0.1, p.ownership || 0.5));
    let ppd = 0;
    for (const p of lu.players) if (p.salary && p.projection) ppd += p.projection / (p.salary / 1000);

    scored.push({
      lu, primarySize, corrAdj, logOwn, uniqueness, ppd,
      proj: lu.projection, floor, ceiling, range: ceiling - floor,
      ev: 0, projPct: 0, ownPct: 0, rangePct: 0, ppdPct: 0,
    });
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
  }
  for (let i = 0; i < scored.length; i++) {
    const s = scored[i];
    let ev = TODFS_PARAMS.W_PROJ * s.projPct
           + TODFS_PARAMS.W_LEV * (1 - s.ownPct)
           + TODFS_PARAMS.W_VAR * s.rangePct * 0.85
           + TODFS_PARAMS.W_CMB * uniqPct[i];
    if (s.ppdPct >= 1 - TODFS_PARAMS.PPD_LINEUP_TOP_PCT) ev *= (1 - TODFS_PARAMS.PPD_LINEUP_PENALTY);
    s.ev = ev;
  }

  // 7. Apply hard 4+ stack constraint.
  let pool2 = scored.filter(s => s.primarySize >= TODFS_PARAMS.MIN_PRIMARY_STACK);
  if (pool2.length < N) pool2 = scored;

  // 8. Variance-band selection (20/60/20).
  const sortedHigh = [...pool2].sort((a, b) => (b.projPct + b.ownPct) - (a.projPct + a.ownPct));
  const sortedLow = [...pool2].sort((a, b) => ((1 - b.projPct) + (1 - b.ownPct)) - ((1 - a.projPct) + (1 - a.ownPct)));
  const HIGH_TARGET = Math.round(N * TODFS_PARAMS.BAND_HIGH_PCT);
  const LOW_TARGET = Math.round(N * TODFS_PARAMS.BAND_LOW_PCT);
  const MID_TARGET = N - HIGH_TARGET - LOW_TARGET;

  const selected: S[] = [];
  const exposure = new Map<string, number>();
  const seen = new Set<string>();
  function passes(s: S): boolean {
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
  function add(s: S) {
    selected.push(s); seen.add(s.lu.hash);
    for (const p of s.lu.players) exposure.set(p.id, (exposure.get(p.id) || 0) + 1);
  }
  function fillBand(bandPool: S[], target: number) {
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
  fillBand(pool2, MID_TARGET);
  fillBand(sortedLow.slice(0, Math.max(LOW_TARGET * 5, 200)), LOW_TARGET);
  if (selected.length < N) {
    const sorted = [...pool2].sort((a, b) => b.ev - a.ev);
    for (const s of sorted) { if (selected.length >= N) break; if (passes(s)) add(s); }
  }

  const portfolio = selected.slice(0, N).map(s => s.lu);

  // 9. Stats + export.
  console.log('================================================================');
  console.log('PORTFOLIO STATS — Theory-DFS V2');
  console.log('================================================================\n');
  const totalProj = mean(portfolio.map(lu => lu.projection));
  const totalOwn = mean(portfolio.map(lu => lu.ownership));
  let sumSal = 0; for (const lu of portfolio) sumSal += lu.salary;
  console.log('  Lineups: ' + portfolio.length + '/' + N);
  console.log('  Avg projection: ' + totalProj.toFixed(1));
  console.log('  Avg ownership: ' + totalOwn.toFixed(1) + '%');
  console.log('  Avg salary: $' + (sumSal / portfolio.length).toFixed(0));

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
  const playerExp = new Map<string, { count: number; name: string; team: string; own: number }>();
  for (const lu of portfolio) for (const p of lu.players) {
    const e = playerExp.get(p.id) || { count: 0, name: p.name, team: p.team || '', own: p.ownership || 0 };
    e.count++; playerExp.set(p.id, e);
  }
  const sortedExp = [...playerExp.entries()].sort((a, b) => b[1].count - a[1].count);
  console.log('\n  Top 15 player exposures:');
  for (const [, v] of sortedExp.slice(0, 15)) {
    console.log('    ' + v.name.padEnd(25) + ' ' + v.team.padEnd(5) + ' ' + ((v.count / portfolio.length) * 100).toFixed(1).padStart(5) + '% (' + v.count + '/' + portfolio.length + ')  own=' + v.own.toFixed(1) + '%');
  }
  console.log('\n  Unique players: ' + playerExp.size);

  // Export.
  const OUTPUT_FILE = path.join(DATA_DIR, 'theory_dfs_v2_preslate_' + N + '.csv');
  const DETAILED_FILE = path.join(DATA_DIR, 'theory_dfs_v2_preslate_' + N + '_detailed.csv');
  exportForDraftKings(portfolio, config, OUTPUT_FILE);
  exportDetailedLineups(portfolio, config, DETAILED_FILE);
  console.log('\n================================================================');
  console.log('DONE — Theory-DFS V2 preslate');
  console.log('================================================================');
  console.log('  DK upload: ' + OUTPUT_FILE);
  console.log('  Detail:    ' + DETAILED_FILE);
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });
