/**
 * Verification helper for V1-PortfolioCombo: runs V1-NoCorr's identical
 * algorithm on a chosen slate (env-driven), reports unique-combo counts and
 * top-5 most-used 4/5-combos for side-by-side comparison.
 *
 * NOT a production runner. Intentionally NOT placed under field_combo_/
 * portfolio_combo_ — lives in src/scripts as a sibling so it shares the
 * import paths.
 *
 * Usage:
 *   PC_VERIFY_PROJ=5-5-26projections.csv PC_VERIFY_POOLS=5-5-26sspool.csv \
 *   PC_VERIFY_N=150 ts-node _pc_verify_v1nocorr.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';

const DATA_DIR = 'C:/Users/colin/dfs opto';
const PROJ_FILE = process.env.PC_VERIFY_PROJ || 'mlbdkprojpre.csv';
const POOL_FILES = (process.env.PC_VERIFY_POOLS || 'sspool2pre.csv,sspool3pre.csv').split(',').map(s => s.trim()).filter(s => s.length > 0);
const N = process.env.PC_VERIFY_N ? parseInt(process.env.PC_VERIFY_N, 10) : 150;
const TAG = process.env.PC_VERIFY_TAG || 'verify';

// EXACT V1-NoCorr constants (theory-of-dfs-v1-preslate.ts).
const TODFS_V1 = {
  STACK_BONUS_PER_HITTER: 0,
  BRINGBACK_1: 0,
  BRINGBACK_2: 0,
  PITCHER_VS_HITTER_PENALTY: -0.10,
  MIN_PRIMARY_STACK: 4,
  W_PROJ: 1.0, W_LEV: 0.30, W_VAR: 0.15, W_CMB: 0.25,
  EXPOSURE_CAP_HITTER: 0.25, EXPOSURE_CAP_PITCHER: 0.45,
  TEAM_STACK_CAP: 0.20,
  BAND_HIGH_PCT: 0.20, BAND_MID_PCT: 0.60, BAND_LOW_PCT: 0.20,
  MAX_PAIRWISE_OVERLAP: 6,
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

async function main() {
  const projPath = path.join(DATA_DIR, PROJ_FILE);
  const pr = parseCSVFile(projPath, 'mlb', true);
  const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
  const pool = buildPlayerPool(pr.players, pr.detectedContestType);

  const idMap = new Map<string, Player>();
  for (const p of pool.players) idMap.set(p.id, p);
  const merged = new Map<string, Lineup>();
  for (const pf of POOL_FILES) {
    const pp = path.join(DATA_DIR, pf);
    if (!fs.existsSync(pp)) continue;
    const loaded = loadPoolFromCSV({ filePath: pp, config, playerMap: idMap });
    for (const lu of loaded.lineups) if (!merged.has(lu.hash)) merged.set(lu.hash, lu);
  }
  const candidates = Array.from(merged.values());

  // V1-NoCorr scoring.
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
        for (let l = j + 1; l < ids.length; l++) {
          const k = ids[i] + '|' + ids[j] + '|' + ids[l];
          tripFreq.set(k, (tripFreq.get(k) || 0) + w);
        }
      }
    }
  }
  for (const k of pairFreq.keys()) pairFreq.set(k, pairFreq.get(k)! / totalW);
  for (const k of tripFreq.keys()) tripFreq.set(k, tripFreq.get(k)! / totalW);

  interface S { lu: Lineup; primarySize: number; corrAdj: number; logOwn: number; uniqueness: number; ppd: number;
    proj: number; floor: number; ceiling: number; range: number; ev: number;
    projPct: number; ownPct: number; rangePct: number; ppdPct: number; uniqPct: number; }
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
    if (primarySize >= 3) corrAdj += TODFS_V1.STACK_BONUS_PER_HITTER * (primarySize - 2);
    if (bringBack === 1) corrAdj += TODFS_V1.BRINGBACK_1;
    else if (bringBack >= 2) corrAdj += TODFS_V1.BRINGBACK_2;
    corrAdj += TODFS_V1.PITCHER_VS_HITTER_PENALTY * pOppHitters;
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
    for (const t of tripFs.slice(0, TODFS_V1.TRIPLE_FREQ_CAP)) uniqueness += -Math.log(t.f);
    let logOwn = 0;
    for (const p of lu.players) {
      if (isPitcher(p)) continue;
      logOwn += Math.log(Math.max(0.1, p.ownership || 0.5));
    }
    let ppd = 0;
    for (const p of lu.players) if (p.salary && p.projection) ppd += p.projection / (p.salary / 1000);
    scored.push({ lu, primarySize, corrAdj, logOwn, uniqueness, ppd, proj: lu.projection,
      floor, ceiling, range: ceiling - floor, ev: 0, projPct: 0, ownPct: 0, rangePct: 0, ppdPct: 0, uniqPct: 0 });
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
    let ev = TODFS_V1.W_PROJ * s.projPct + TODFS_V1.W_LEV * (1 - s.ownPct)
           + TODFS_V1.W_VAR * s.rangePct * 0.85 + TODFS_V1.W_CMB * s.uniqPct;
    if (s.ppdPct >= 1 - TODFS_V1.PPD_LINEUP_TOP_PCT) ev *= (1 - TODFS_V1.PPD_LINEUP_PENALTY);
    s.ev = ev;
  }

  let pool2 = scored.filter(s => s.primarySize >= TODFS_V1.MIN_PRIMARY_STACK);
  if (pool2.length < N) pool2 = scored;
  const sortedHigh = [...pool2].sort((a, b) => (b.projPct + b.ownPct) - (a.projPct + a.ownPct));
  const sortedLow = [...pool2].sort((a, b) => ((1 - b.projPct) + (1 - b.ownPct)) - ((1 - a.projPct) + (1 - a.ownPct)));
  const HIGH_TARGET = Math.round(N * TODFS_V1.BAND_HIGH_PCT);
  const LOW_TARGET = Math.round(N * TODFS_V1.BAND_LOW_PCT);
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
    if (s.primarySize < TODFS_V1.MIN_PRIMARY_STACK) return false;
    for (const p of s.lu.players) {
      const cur = exposure.get(p.id) || 0;
      const cap = isPitcher(p) ? TODFS_V1.EXPOSURE_CAP_PITCHER : TODFS_V1.EXPOSURE_CAP_HITTER;
      if ((cur + 1) / N > cap) return false;
    }
    const stackTeam = primaryStackTeamOf(s);
    if (stackTeam) {
      const cur = teamStackCount.get(stackTeam) || 0;
      if ((cur + 1) / N > TODFS_V1.TEAM_STACK_CAP) return false;
    }
    const ids = new Set(s.lu.players.map(p => p.id));
    for (const sel of selected) {
      let ov = 0; for (const p of sel.lu.players) if (ids.has(p.id)) ov++;
      if (ov > TODFS_V1.MAX_PAIRWISE_OVERLAP) return false;
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
      const old = TODFS_V1.MAX_PAIRWISE_OVERLAP;
      (TODFS_V1 as any).MAX_PAIRWISE_OVERLAP = old + 1;
      for (const s of sorted) { if (added >= target) break; if (passes(s)) { add(s); added++; } }
      (TODFS_V1 as any).MAX_PAIRWISE_OVERLAP = old;
    }
  }
  fillBand(sortedHigh.slice(0, Math.max(HIGH_TARGET * 5, 200)), HIGH_TARGET);
  fillBand(pool2, MID_TARGET);
  fillBand(sortedLow.slice(0, Math.max(LOW_TARGET * 5, 200)), LOW_TARGET);
  if (selected.length < N) {
    const sorted = [...pool2].sort((a, b) => b.ev - a.ev);
    for (const s of sorted) { if (selected.length >= N) break; if (passes(s)) add(s); }
  }

  // Combo diversity for V1-NoCorr portfolio.
  const size4 = new Map<string, number>();
  const size5 = new Map<string, number>();
  for (const s of selected.slice(0, N)) {
    const { combos4, combos5 } = enumerateCombos(s.lu.players.map(p => p.id));
    for (const c of combos4) size4.set(c, (size4.get(c) || 0) + 1);
    for (const c of combos5) size5.set(c, (size5.get(c) || 0) + 1);
  }
  function topK(m: Map<string, number>, k: number) {
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
  }
  let max4 = 0; for (const v of size4.values()) if (v > max4) max4 = v;
  let max5 = 0; for (const v of size5.values()) if (v > max5) max5 = v;

  // Constraint readouts.
  const expByPid = new Map<string, number>();
  for (const s of selected.slice(0, N)) for (const p of s.lu.players) expByPid.set(p.id, (expByPid.get(p.id) || 0) + 1);
  let maxExp = 0; for (const v of expByPid.values()) if (v > maxExp) maxExp = v;
  let maxStack = 0; for (const v of teamStackCount.values()) if (v > maxStack) maxStack = v;
  let maxOverlap = 0;
  for (let i = 0; i < selected.length && i < N; i++) {
    const ids1 = new Set(selected[i].lu.players.map(p => p.id));
    for (let j = i + 1; j < selected.length && j < N; j++) {
      let ov = 0; for (const p of selected[j].lu.players) if (ids1.has(p.id)) ov++;
      if (ov > maxOverlap) maxOverlap = ov;
    }
  }

  const portfolio = selected.slice(0, N).map(s => s.lu);
  const out = {
    n: N,
    avgProj: mean(portfolio.map(lu => lu.projection)),
    avgOwn: mean(portfolio.map(lu => lu.ownership)),
    avgSal: portfolio.reduce((s, lu) => s + lu.salary, 0) / portfolio.length,
    unique4: size4.size,
    unique5: size5.size,
    max4, max5,
    top5_4: topK(size4, 5),
    top5_5: topK(size5, 5),
    maxPlayerExposure: maxExp,
    maxTeamStack: maxStack,
    maxPairwiseOverlap: maxOverlap,
  };
  console.log(JSON.stringify(out, null, 2));

  // Write CSV summary for verification harness.
  const outDir = process.env.PC_VERIFY_OUT || path.join(DATA_DIR, 'portfolio_combo_implementation', 'verification');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'v1nocorr_summary_' + TAG + '.json'), JSON.stringify(out, null, 2));
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });
