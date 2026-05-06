/**
 * Theory-of-DFS — NBA Showdown Pre-Slate.
 *
 * NBA showdown adaptation. Key differences from NBA classic Theory-DFS:
 *   - 6-roster (1 CPT + 5 UTIL). CPT gets 1.5x points & salary.
 *   - Single game; no team-stack mandate (NBA has no stacking concept anyway).
 *   - Smaller pairwise overlap cap (3 vs 5).
 *   - W_CMB kept at 0.15 (NBA reduced — see V2 NBA empirical combo finding).
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';
import { exportForDraftKings, exportDetailedLineups } from '../scoring';

const DATA_DIR = 'C:/Users/colin/dfs opto';
const PROJ_FILE = 'nbashowdownproj.csv';
const POOL_FILES = ['nbashowdownpool.csv', 'nbashowdownpool2.csv'];
const TARGET_COUNT = 150;
const N = TARGET_COUNT;

const TODFS_NBA_SD = {
  W_PROJ: 1.0, W_LEV: 0.30, W_VAR: 0.15, W_CMB: 0.15,
  EXPOSURE_CAP: 0.50,
  BAND_HIGH_PCT: 0.20, BAND_MID_PCT: 0.60, BAND_LOW_PCT: 0.20,
  MAX_PAIRWISE_OVERLAP: 3,
  TRIPLE_FREQ_CAP: 5,
  PPD_LINEUP_PENALTY: 0.10, PPD_LINEUP_TOP_PCT: 0.10,
};

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
  console.log('THEORY-DFS NBA SHOWDOWN PRE-SLATE');
  console.log('================================================================');
  console.log('No stack mandate (NBA), W_CMB=0.15 (NBA reduced), 20/60/20 bands.');
  console.log(`N=${N}, MAX_OVERLAP=${TODFS_NBA_SD.MAX_PAIRWISE_OVERLAP}`);
  console.log('================================================================\n');

  const projPath = path.join(DATA_DIR, PROJ_FILE);
  console.log('Loading projections: ' + projPath);
  const pr = parseCSVFile(projPath, 'nba', true);
  const config = getContestConfig('dk', 'nba', pr.detectedContestType);
  const pool = buildPlayerPool(pr.players, pr.detectedContestType);
  console.log('  Contest: ' + pr.detectedContestType);
  console.log('  Players: ' + pool.players.length);

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

  console.log('Computing combo frequencies...');
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

  console.log('Scoring (Theory-DFS NBA Showdown)...');
  interface S {
    lu: Lineup; logOwn: number; uniqueness: number; ppd: number;
    proj: number; floor: number; ceiling: number; range: number; ev: number;
    projPct: number; ownPct: number; rangePct: number; ppdPct: number; uniqPct: number;
    teamSplit: string;
  }
  const scored: S[] = [];
  for (const lu of candidates) {
    let floor = 0, ceiling = 0;
    for (const p of lu.players) {
      if (p.percentiles) { floor += p.percentiles.p25 || p.projection * 0.85; ceiling += p.percentiles.p75 || p.projection * 1.15; }
      else { floor += p.projection * 0.85; ceiling += p.projection * 1.15; }
    }
    const teamCounts = new Map<string, number>();
    for (const p of lu.players) {
      const t = (p.team || '').toUpperCase();
      if (t) teamCounts.set(t, (teamCounts.get(t) || 0) + 1);
    }
    const sortedSplit = [...teamCounts.values()].sort((a, b) => b - a);
    const teamSplit = sortedSplit.join('-');

    // Combinatorial uniqueness (W_CMB applied below).
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
    for (const t of tripFs.slice(0, TODFS_NBA_SD.TRIPLE_FREQ_CAP)) {
      uniqueness += -Math.log(t.f);
    }

    let logOwn = 0;
    for (const p of lu.players) logOwn += Math.log(Math.max(0.1, p.ownership || 0.5));
    let ppd = 0;
    for (const p of lu.players) if (p.salary && p.projection) ppd += p.projection / (p.salary / 1000);

    scored.push({
      lu, logOwn, uniqueness, ppd,
      proj: lu.projection, floor, ceiling, range: ceiling - floor,
      ev: 0, projPct: 0, ownPct: 0, rangePct: 0, ppdPct: 0, uniqPct: 0,
      teamSplit,
    });
  }

  const projPct = rankPercentile(scored.map(s => s.proj));
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
    let ev = TODFS_NBA_SD.W_PROJ * s.projPct
           + TODFS_NBA_SD.W_LEV * (1 - s.ownPct)
           + TODFS_NBA_SD.W_VAR * s.rangePct * 0.85
           + TODFS_NBA_SD.W_CMB * s.uniqPct;
    if (s.ppdPct >= 1 - TODFS_NBA_SD.PPD_LINEUP_TOP_PCT) ev *= (1 - TODFS_NBA_SD.PPD_LINEUP_PENALTY);
    s.ev = ev;
  }

  // Variance-band selection (20/60/20).
  const sortedHigh = [...scored].sort((a, b) => (b.projPct + b.ownPct) - (a.projPct + a.ownPct));
  const sortedLow = [...scored].sort((a, b) => ((1 - b.projPct) + (1 - b.ownPct)) - ((1 - a.projPct) + (1 - a.ownPct)));
  const HIGH_TARGET = Math.round(N * TODFS_NBA_SD.BAND_HIGH_PCT);
  const LOW_TARGET = Math.round(N * TODFS_NBA_SD.BAND_LOW_PCT);
  const MID_TARGET = N - HIGH_TARGET - LOW_TARGET;

  const selected: S[] = [];
  const exposure = new Map<string, number>();
  const seen = new Set<string>();
  function passes(s: S): boolean {
    if (seen.has(s.lu.hash)) return false;
    for (const p of s.lu.players) {
      const cur = exposure.get(p.id) || 0;
      if ((cur + 1) / N > TODFS_NBA_SD.EXPOSURE_CAP) return false;
    }
    const ids = new Set(s.lu.players.map(p => p.id));
    for (const sel of selected) {
      let ov = 0; for (const p of sel.lu.players) if (ids.has(p.id)) ov++;
      if (ov > TODFS_NBA_SD.MAX_PAIRWISE_OVERLAP) return false;
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
      const old = TODFS_NBA_SD.MAX_PAIRWISE_OVERLAP;
      (TODFS_NBA_SD as any).MAX_PAIRWISE_OVERLAP = old + 1;
      for (const s of sorted) { if (added >= target) break; if (passes(s)) { add(s); added++; } }
      (TODFS_NBA_SD as any).MAX_PAIRWISE_OVERLAP = old;
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

  console.log('================================================================');
  console.log('PORTFOLIO STATS — Theory-DFS NBA Showdown');
  console.log('================================================================\n');
  console.log('  Lineups: ' + portfolio.length + '/' + N);
  const avgProj = mean(portfolio.map(lu => lu.projection));
  const avgOwn = mean(portfolio.map(lu => lu.ownership));
  let sumSal = 0; for (const lu of portfolio) sumSal += lu.salary;
  console.log('  Avg projection: ' + avgProj.toFixed(1));
  console.log('  Avg ownership:  ' + avgOwn.toFixed(1) + '%');
  console.log('  Avg salary:     $' + (sumSal / portfolio.length).toFixed(0));

  // Team split.
  const splitCounts = new Map<string, number>();
  for (const s of selected.slice(0, N)) {
    splitCounts.set(s.teamSplit, (splitCounts.get(s.teamSplit) || 0) + 1);
  }
  console.log('\n  Team split distribution:');
  const splits = [...splitCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [sp, c] of splits) {
    console.log('    ' + sp.padEnd(8) + c + ' lineups (' + Math.round(c / N * 100) + '%)');
  }

  // CPT exposure.
  const cptCounts = new Map<string, { p: Player; n: number }>();
  for (const lu of portfolio) {
    const cpt = lu.players.find(p => (p.position || '').toUpperCase().includes('CPT'));
    if (cpt) {
      const cur = cptCounts.get(cpt.id) || { p: cpt, n: 0 };
      cur.n++;
      cptCounts.set(cpt.id, cur);
    }
  }
  console.log('\n  CPT exposure:');
  const cpts = [...cptCounts.values()].sort((a, b) => b.n - a.n);
  for (const c of cpts.slice(0, 15)) {
    const p = c.p;
    console.log(`    ${(p.name || '').padEnd(24)} ${(p.team || '').padEnd(4)} ${(c.n / N * 100).toFixed(1)}% (${c.n}/${N})  own=${(p.ownership || 0).toFixed(1)}%  proj=${(p.projection || 0).toFixed(1)}`);
  }

  // Top exposures.
  const expoCounts = new Map<string, { p: Player; n: number }>();
  for (const lu of portfolio) {
    for (const p of lu.players) {
      const cur = expoCounts.get(p.id) || { p, n: 0 };
      cur.n++;
      expoCounts.set(p.id, cur);
    }
  }
  console.log('\n  Top 15 player exposures (any slot):');
  const expoSort = [...expoCounts.values()].sort((a, b) => b.n - a.n);
  for (const c of expoSort.slice(0, 15)) {
    const p = c.p;
    console.log(`    ${(p.name || '').padEnd(24)} ${(p.team || '').padEnd(4)} ${(c.n / N * 100).toFixed(1)}% (${c.n}/${N})  own=${(p.ownership || 0).toFixed(1)}%  proj=${(p.projection || 0).toFixed(1)}`);
  }

  const uniquePlayers = new Set<string>();
  for (const lu of portfolio) for (const p of lu.players) uniquePlayers.add(p.id);
  console.log(`\n  Unique players: ${uniquePlayers.size}`);

  const dkPath = path.join(DATA_DIR, `theory_dfs_nba_showdown_preslate_${N}.csv`);
  const detailPath = path.join(DATA_DIR, `theory_dfs_nba_showdown_preslate_${N}_detailed.csv`);
  console.log(`\nExporting ${portfolio.length} lineups for DraftKings upload`);
  exportForDraftKings(portfolio, config, dkPath);
  console.log(`Exported to ${dkPath}`);
  console.log(`\nExporting detailed lineup data to ${detailPath}`);
  exportDetailedLineups(portfolio, config, detailPath);
  console.log(`Exported detailed data to ${detailPath}`);

  console.log('\n================================================================');
  console.log('DONE — Theory-DFS NBA Showdown preslate');
  console.log('================================================================');
  console.log(`  DK upload: ${dkPath}`);
  console.log(`  Detail:    ${detailPath}`);
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });
