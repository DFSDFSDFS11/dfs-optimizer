/**
 * Theory-of-DFS — MLB Showdown Pre-Slate.
 *
 * Showdown adaptation of V1 framework. Key differences from MLB classic:
 *   - 6-player roster (1 CPT + 5 UTIL). CPT gets 1.5x points & salary.
 *   - Single game (one matchup), so no team-stack mandate or bring-back logic.
 *   - Smaller player pool (~30 players) → smaller pairwise overlap cap (3 vs 6).
 *   - No MIN_PRIMARY_STACK constraint (every lineup is "stacked" by definition).
 *   - Combo penalty kept but reduced (W_CMB=0.20) — small pool means raw freq noisier.
 *   - Variance bands still apply (chalk/contrarian split is contest-agnostic).
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';
import { exportForDraftKings, exportDetailedLineups } from '../scoring';

const DATA_DIR = 'C:/Users/colin/dfs opto';
const PROJ_FILE = process.env.MLB_SD_PROJ || 'mlbdkprojpre.csv';
const POOL_FILES = (process.env.MLB_SD_POOLS || 'sspool1pre.csv,sspool2pre.csv').split(',');
const TARGET_COUNT = 150;
const N = TARGET_COUNT;

const TODFS_SHOWDOWN = {
  PITCHER_VS_HITTER_PENALTY: -0.10,  // pitcher facing same-team hitters in your lineup
  TEAM_BALANCE_BONUS: 0.04,           // small bonus for 3-3 balanced split
  W_PROJ: 1.0, W_LEV: 0.30, W_VAR: 0.15, W_CMB: 0.20,
  EXPOSURE_CAP_HITTER: 0.50, EXPOSURE_CAP_PITCHER: 0.65,
  BAND_HIGH_PCT: 0.20, BAND_MID_PCT: 0.60, BAND_LOW_PCT: 0.20,
  MAX_PAIRWISE_OVERLAP: 3,            // 6-roster, 3 = at least 3 distinct
  TRIPLE_FREQ_CAP: 5,
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

async function main() {
  console.log('================================================================');
  console.log('THEORY-DFS MLB SHOWDOWN PRE-SLATE');
  console.log('================================================================');
  console.log('Showdown adaptation: 6-roster CPT+UTIL, single-game, no team mandate.');
  console.log(`N=${N}, MAX_OVERLAP=${TODFS_SHOWDOWN.MAX_PAIRWISE_OVERLAP}`);
  console.log('================================================================\n');

  const projPath = path.join(DATA_DIR, PROJ_FILE);
  console.log('Loading projections: ' + projPath);
  const pr = parseCSVFile(projPath, 'mlb', true);
  const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
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

  // Build pair/triple frequency maps.
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

  console.log('Scoring (Theory-DFS Showdown)...');
  interface S {
    lu: Lineup; corrAdj: number; logOwn: number; uniqueness: number; ppd: number;
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
    // Correlation: pitcher-vs-hitter penalty + team-balance bonus.
    const teamCounts = new Map<string, number>();
    const pitchers: Player[] = [];
    for (const p of lu.players) {
      if (isPitcher(p)) pitchers.push(p);
      const t = (p.team || '').toUpperCase();
      if (t) teamCounts.set(t, (teamCounts.get(t) || 0) + 1);
    }
    let pOppHitters = 0;
    for (const p of pitchers) {
      const o = (p.opponent || '').toUpperCase();
      if (o) {
        let oppHits = 0;
        for (const pl of lu.players) {
          if (isPitcher(pl)) continue;
          if ((pl.team || '').toUpperCase() === o) oppHits++;
        }
        pOppHitters += oppHits;
      }
    }
    const sortedSplit = [...teamCounts.values()].sort((a, b) => b - a);
    const teamSplit = sortedSplit.join('-');  // e.g. "3-3" or "4-2"
    let corrAdj = 0;
    corrAdj += TODFS_SHOWDOWN.PITCHER_VS_HITTER_PENALTY * pOppHitters;
    if (sortedSplit[0] === 3 && sortedSplit[1] === 3) corrAdj += TODFS_SHOWDOWN.TEAM_BALANCE_BONUS;

    // Combinatorial uniqueness.
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
    for (const t of tripFs.slice(0, TODFS_SHOWDOWN.TRIPLE_FREQ_CAP)) {
      uniqueness += -Math.log(t.f);
    }

    // Leverage: hitter ownership only (carve-out for pitcher chalk).
    let logOwn = 0;
    for (const p of lu.players) {
      if (isPitcher(p)) continue;
      logOwn += Math.log(Math.max(0.1, p.ownership || 0.5));
    }
    let ppd = 0;
    for (const p of lu.players) if (p.salary && p.projection) ppd += p.projection / (p.salary / 1000);

    scored.push({
      lu, corrAdj, logOwn, uniqueness, ppd,
      proj: lu.projection, floor, ceiling, range: ceiling - floor,
      ev: 0, projPct: 0, ownPct: 0, rangePct: 0, ppdPct: 0, uniqPct: 0,
      teamSplit,
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
    scored[i].uniqPct = uniqPct[i];
  }
  for (const s of scored) {
    let ev = TODFS_SHOWDOWN.W_PROJ * s.projPct
           + TODFS_SHOWDOWN.W_LEV * (1 - s.ownPct)
           + TODFS_SHOWDOWN.W_VAR * s.rangePct * 0.85
           + TODFS_SHOWDOWN.W_CMB * s.uniqPct;
    if (s.ppdPct >= 1 - TODFS_SHOWDOWN.PPD_LINEUP_TOP_PCT) ev *= (1 - TODFS_SHOWDOWN.PPD_LINEUP_PENALTY);
    s.ev = ev;
  }

  // Variance-band selection (20/60/20).
  const sortedHigh = [...scored].sort((a, b) => (b.projPct + b.ownPct) - (a.projPct + a.ownPct));
  const sortedLow = [...scored].sort((a, b) => ((1 - b.projPct) + (1 - b.ownPct)) - ((1 - a.projPct) + (1 - a.ownPct)));
  const HIGH_TARGET = Math.round(N * TODFS_SHOWDOWN.BAND_HIGH_PCT);
  const LOW_TARGET = Math.round(N * TODFS_SHOWDOWN.BAND_LOW_PCT);
  const MID_TARGET = N - HIGH_TARGET - LOW_TARGET;

  const selected: S[] = [];
  const exposure = new Map<string, number>();
  const seen = new Set<string>();
  function passes(s: S): boolean {
    if (seen.has(s.lu.hash)) return false;
    for (const p of s.lu.players) {
      const cur = exposure.get(p.id) || 0;
      const cap = isPitcher(p) ? TODFS_SHOWDOWN.EXPOSURE_CAP_PITCHER : TODFS_SHOWDOWN.EXPOSURE_CAP_HITTER;
      if ((cur + 1) / N > cap) return false;
    }
    const ids = new Set(s.lu.players.map(p => p.id));
    for (const sel of selected) {
      let ov = 0; for (const p of sel.lu.players) if (ids.has(p.id)) ov++;
      if (ov > TODFS_SHOWDOWN.MAX_PAIRWISE_OVERLAP) return false;
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
      const old = TODFS_SHOWDOWN.MAX_PAIRWISE_OVERLAP;
      (TODFS_SHOWDOWN as any).MAX_PAIRWISE_OVERLAP = old + 1;
      for (const s of sorted) { if (added >= target) break; if (passes(s)) { add(s); added++; } }
      (TODFS_SHOWDOWN as any).MAX_PAIRWISE_OVERLAP = old;
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

  // Stats + export.
  console.log('================================================================');
  console.log('PORTFOLIO STATS — Theory-DFS MLB Showdown');
  console.log('================================================================\n');
  console.log('  Lineups: ' + portfolio.length + '/' + N);
  const avgProj = mean(portfolio.map(lu => lu.projection));
  const avgOwn = mean(portfolio.map(lu => lu.ownership));
  let sumSal = 0; for (const lu of portfolio) sumSal += lu.salary;
  console.log('  Avg projection: ' + avgProj.toFixed(1));
  console.log('  Avg ownership:  ' + avgOwn.toFixed(1) + '%');
  console.log('  Avg salary:     $' + (sumSal / portfolio.length).toFixed(0));

  // Team split distribution.
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

  // Top player exposures (any slot).
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

  // Export.
  const dkPath = path.join(DATA_DIR, `theory_dfs_mlb_showdown_preslate_${N}.csv`);
  const detailPath = path.join(DATA_DIR, `theory_dfs_mlb_showdown_preslate_${N}_detailed.csv`);
  console.log(`\nExporting ${portfolio.length} lineups for DraftKings upload`);
  exportForDraftKings(portfolio, config, dkPath);
  console.log(`Exported to ${dkPath}`);
  console.log(`\nExporting detailed lineup data to ${detailPath}`);
  exportDetailedLineups(portfolio, config, detailPath);
  console.log(`Exported detailed data to ${detailPath}`);

  console.log('\n================================================================');
  console.log('DONE — Theory-DFS MLB Showdown preslate');
  console.log('================================================================');
  console.log(`  DK upload: ${dkPath}`);
  console.log(`  Detail:    ${detailPath}`);
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });
