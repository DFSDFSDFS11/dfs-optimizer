/**
 * Baseline Update — V1-NoCorr on 4 new slates only.
 *
 * Mirrors v2-validation harness exactly for V1-NoCorr (stackBonus=0, BB1=0, BB2=0,
 * applyTypeScaling=false, topNFilter=0). Runs only on the 4 new slates and produces
 * a JSON dump of structural features per lineup, in the same shape as
 * v1_pros_lineup_dump.json's `vNoCorr` arrays.
 *
 * No system changes. Descriptive monitoring only. Comparable to existing 24-slate
 * baseline because identical params/N/caps as the v2-validation `vNoCorr` build.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player, ContestConfig } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals } from '../parser';
import { getContestConfig } from '../rules';
import { exportForDraftKings, exportDetailedLineups } from '../scoring';

const MLB_DIR = 'C:/Users/colin/dfs opto';
const OUT_DIR = 'C:/Users/colin/dfs opto/baseline_update';
const PORTFOLIO_DIR = path.join(OUT_DIR, 'new_slates_portfolios');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
if (!fs.existsSync(PORTFOLIO_DIR)) fs.mkdirSync(PORTFOLIO_DIR, { recursive: true });

// Match the 24-slate baseline: N=150 lineups (per v2-validation harness).
const N = 150;
const FEE = 20;

// 4 new slates with complete projections+actuals+sspool trios in proper pool format.
// 4-11-26 was excluded: its sspool.csv is a projections file, not a lineup pool.
// 5-5-26-late and 5-5-26-night were excluded: missing projections files.
const NEW_SLATES = [
  { slate: '5-3-26-late', proj: '5-3-26projectionslate.csv',   actuals: '5-3-26actualslate.csv',   pool: '5-3-26sspoollate.csv' },
  { slate: '5-4-26',      proj: '5-4-26projections.csv',       actuals: '5-4-26actuals.csv',       pool: '5-4-26sspool.csv' },
  { slate: '5-4-26-late', proj: '5-4-26projectionslate.csv',   actuals: '5-4-26actualslate.csv',   pool: '5-4-26sspoollate.csv' },
  { slate: '5-5-26',      proj: '5-5-26projections.csv',       actuals: '5-5-26actuals.csv',       pool: '5-5-26sspool.csv' },
];


// V1-NoCorr params (matches v2-validation's vNoCorr exactly).
const TODFS_PARAMS = {
  STACK_BONUS_PER_HITTER: 0,    // V1-NoCorr override
  BRINGBACK_1: 0,               // V1-NoCorr override
  BRINGBACK_2: 0,               // V1-NoCorr override
  PITCHER_VS_HITTER_PENALTY: -0.10,
  MIN_PRIMARY_STACK: 4,
  W_PROJ: 1.0, W_LEV: 0.30, W_VAR: 0.15, W_CMB: 0.25,
  EXPOSURE_CAP_HITTER: 0.50, EXPOSURE_CAP_PITCHER: 1.00,
  BAND_HIGH_PCT: 0.20, BAND_MID_PCT: 0.60, BAND_LOW_PCT: 0.20,
  MAX_PAIRWISE_OVERLAP: 6,
  TRIPLE_FREQ_CAP: 5,
  PPD_LINEUP_PENALTY: 0.10, PPD_LINEUP_TOP_PCT: 0.10,
};

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function mean(a: number[]): number { if (!a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; }
function rankPercentile(values: number[]): number[] {
  const idx = values.map((v, i) => ({ v, i }));
  idx.sort((a, b) => a.v - b.v);
  const out = new Array<number>(values.length);
  for (let r = 0; r < values.length; r++) out[idx[r].i] = values.length > 1 ? r / (values.length - 1) : 0;
  return out;
}
function isPitcher(p: Player): boolean { return (p.position || '').toUpperCase().includes('P'); }

interface SlateData {
  slate: string;
  candidates: Lineup[];
  players: Player[];
  actuals: ContestActuals;
  config: ContestConfig;
  optimalProj: number;
  numTeams: number;
  totalEntries: number;
}

async function loadSlate(s: typeof NEW_SLATES[0]): Promise<SlateData | null> {
  const proj = path.join(MLB_DIR, s.proj);
  const act = path.join(MLB_DIR, s.actuals);
  const pool = path.join(MLB_DIR, s.pool);
  if (![proj, act, pool].every(p => fs.existsSync(p))) {
    console.error(`MISSING FILE for ${s.slate}`);
    return null;
  }
  const pr = parseCSVFile(proj, 'mlb', true);
  const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
  const playerPool = buildPlayerPool(pr.players, pr.detectedContestType);
  const actuals = parseContestActuals(act, config);
  const idMap = new Map<string, Player>();
  for (const p of playerPool.players) idMap.set(p.id, p);
  const loaded = loadPoolFromCSV({ filePath: pool, config, playerMap: idMap });
  let optProj = 0;
  for (const lu of loaded.lineups) if (lu.projection > optProj) optProj = lu.projection;
  const teams = new Set(playerPool.players.map(p => (p.team || '').toUpperCase()).filter(t => t));
  return {
    slate: s.slate, candidates: loaded.lineups, players: playerPool.players, actuals, config,
    optimalProj: optProj, numTeams: teams.size, totalEntries: actuals.entries.length,
  };
}

function buildPairTripleFreqs(candidates: Lineup[]): { pair: Map<string, number>; triple: Map<string, number> } {
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
  for (const k of pair.keys()) pair.set(k, pair.get(k)! / totalW);
  for (const k of triple.keys()) triple.set(k, triple.get(k)! / totalW);
  return { pair, triple };
}

interface ScoredLU {
  lu: Lineup;
  proj: number; floor: number; ceiling: number; range: number;
  primarySize: number; secondarySize: number; bringBack: number;
  corrAdj: number; logOwn: number; uniqueness: number; ppd: number;
  ev: number;
  projPct: number; ownPct: number; rangePct: number; ppdPct: number; uniqPct: number;
}

function scoreLineup(lu: Lineup, pairFreqs: Map<string, number>, tripleFreqs: Map<string, number>): ScoredLU {
  let floor = 0, ceiling = 0;
  for (const p of lu.players) {
    if (p.percentiles) {
      floor += p.percentiles.p25 || p.projection * 0.85;
      ceiling += p.percentiles.p75 || p.projection * 1.15;
    } else { floor += p.projection * 0.85; ceiling += p.projection * 1.15; }
  }
  const teamHitters = new Map<string, number>();
  const pitchers: Player[] = [];
  for (const p of lu.players) {
    if (isPitcher(p)) pitchers.push(p);
    else { const t = (p.team || '').toUpperCase(); if (t) teamHitters.set(t, (teamHitters.get(t) || 0) + 1); }
  }
  let primaryTeam = '', primarySize = 0;
  for (const [t, c] of teamHitters) if (c > primarySize) { primarySize = c; primaryTeam = t; }
  let secondarySize = 0;
  for (const [t, c] of teamHitters) if (t !== primaryTeam && c > secondarySize) secondarySize = c;
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

  // Combinatorial uniqueness — raw (no type scaling for V1).
  let uniqueness = 0;
  for (let i = 0; i < lu.players.length; i++) {
    for (let j = i + 1; j < lu.players.length; j++) {
      const a = lu.players[i], b = lu.players[j];
      const key = [a.id, b.id].sort().join('|');
      const f = pairFreqs.get(key) || 1e-6;
      uniqueness += -Math.log(f);
    }
  }
  const tripFs: { f: number }[] = [];
  for (let i = 0; i < lu.players.length; i++) {
    for (let j = i + 1; j < lu.players.length; j++) {
      for (let l = j + 1; l < lu.players.length; l++) {
        const k = [lu.players[i].id, lu.players[j].id, lu.players[l].id].sort().join('|');
        tripFs.push({ f: tripleFreqs.get(k) || 1e-6 });
      }
    }
  }
  tripFs.sort((a, b) => b.f - a.f);
  for (const t of tripFs.slice(0, TODFS_PARAMS.TRIPLE_FREQ_CAP)) uniqueness += -Math.log(t.f);

  let logOwn = 0;
  for (const p of lu.players) logOwn += Math.log(Math.max(0.1, p.ownership || 0.5));
  let ppd = 0;
  for (const p of lu.players) if (p.salary && p.projection) ppd += p.projection / (p.salary / 1000);

  return {
    lu, proj: lu.projection, floor, ceiling, range: ceiling - floor,
    primarySize, secondarySize, bringBack, corrAdj, logOwn, uniqueness, ppd,
    ev: 0, projPct: 0, ownPct: 0, rangePct: 0, ppdPct: 0, uniqPct: 0,
  };
}

function buildV1NoCorrPortfolio(sd: SlateData): Lineup[] {
  const candidatePool = sd.candidates;
  const { pair, triple } = buildPairTripleFreqs(candidatePool);
  const scored = candidatePool.map(lu => scoreLineup(lu, pair, triple));
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
    let ev = TODFS_PARAMS.W_PROJ * s.projPct
           + TODFS_PARAMS.W_LEV * (1 - s.ownPct)
           + TODFS_PARAMS.W_VAR * s.rangePct * 0.85
           + TODFS_PARAMS.W_CMB * s.uniqPct;
    if (s.ppdPct >= 1 - TODFS_PARAMS.PPD_LINEUP_TOP_PCT) ev *= (1 - TODFS_PARAMS.PPD_LINEUP_PENALTY);
    s.ev = ev;
  }

  let pool = scored.filter(s => s.primarySize >= TODFS_PARAMS.MIN_PRIMARY_STACK);
  if (pool.length < N) pool = scored;

  const sortedHigh = [...pool].sort((a, b) => (b.projPct + b.ownPct) - (a.projPct + a.ownPct));
  const sortedLow = [...pool].sort((a, b) => ((1 - b.projPct) + (1 - b.ownPct)) - ((1 - a.projPct) + (1 - a.ownPct)));
  const HIGH_TARGET = Math.round(N * TODFS_PARAMS.BAND_HIGH_PCT);
  const LOW_TARGET = Math.round(N * TODFS_PARAMS.BAND_LOW_PCT);
  const MID_TARGET = N - HIGH_TARGET - LOW_TARGET;

  const selected: ScoredLU[] = [];
  const exposure = new Map<string, number>();
  const seen = new Set<string>();

  function passes(s: ScoredLU): boolean {
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
  function add(s: ScoredLU) {
    selected.push(s); seen.add(s.lu.hash);
    for (const p of s.lu.players) exposure.set(p.id, (exposure.get(p.id) || 0) + 1);
  }
  function fillBand(bandPool: ScoredLU[], target: number) {
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
  fillBand(pool, MID_TARGET);
  fillBand(sortedLow.slice(0, Math.max(LOW_TARGET * 5, 200)), LOW_TARGET);
  if (selected.length < N) {
    const sorted = [...pool].sort((a, b) => b.ev - a.ev);
    for (const s of sorted) { if (selected.length >= N) break; if (passes(s)) add(s); }
  }
  return selected.slice(0, N).map(s => s.lu);
}

function structuralFeatures(players: Player[]) {
  const teamHitterCounts = new Map<string, number>();
  const gameCounts = new Map<string, number>();
  const pitchers: Player[] = [];
  let salaryTotal = 0;
  const salaries: number[] = [];
  const owns: number[] = [];
  for (const p of players) {
    salaryTotal += p.salary || 0;
    salaries.push(p.salary || 0);
    owns.push(p.ownership || 0);
    const t = (p.team || '').toUpperCase(), o = (p.opponent || '').toUpperCase();
    if (isPitcher(p)) pitchers.push(p);
    else if (t) teamHitterCounts.set(t, (teamHitterCounts.get(t) || 0) + 1);
    if (t && o) {
      const g = [t, o].sort().join('@');
      gameCounts.set(g, (gameCounts.get(g) || 0) + 1);
    }
  }
  let primaryTeam = '', primarySize = 0;
  for (const [t, c] of teamHitterCounts) if (c > primarySize) { primarySize = c; primaryTeam = t; }
  let secondarySize = 0;
  for (const [t, c] of teamHitterCounts) if (t !== primaryTeam && c > secondarySize) secondarySize = c;
  let primaryOpp = '';
  for (const p of players) if ((p.team || '').toUpperCase() === primaryTeam) { primaryOpp = (p.opponent || '').toUpperCase(); if (primaryOpp) break; }
  const bringBack = primaryOpp ? (teamHitterCounts.get(primaryOpp) || 0) : 0;
  let maxGameStack = 0;
  for (const [, c] of gameCounts) if (c > maxGameStack) maxGameStack = c;
  const numGames = gameCounts.size;
  const numTeamsUsed = teamHitterCounts.size + (pitchers.length > 0 ? new Set(pitchers.map(p => (p.team || '').toUpperCase())).size : 0);
  salaries.sort((a, b) => b - a);
  const meanSal = salaryTotal / Math.max(1, salaries.length);
  const salaryStd = Math.sqrt(salaries.reduce((s, v) => s + (v - meanSal) ** 2, 0) / Math.max(1, salaries.length));
  const salaryTopThree = salaries.slice(0, 3).reduce((s, v) => s + v, 0);
  const salaryBotThree = salaries.slice(-3).reduce((s, v) => s + v, 0);
  let logOwnHit = 0, hitN = 0;
  for (const p of players) {
    if (isPitcher(p)) continue;
    logOwnHit += Math.log(Math.max(0.1, p.ownership || 0.5));
    hitN++;
  }
  const geoMeanOwnHit = hitN > 0 ? Math.exp(logOwnHit / hitN) : 0;
  const ownAvg = owns.reduce((s, v) => s + v, 0) / Math.max(1, owns.length);
  return {
    primaryTeam, primarySize, secondarySize, bringBack,
    maxGameStack, numGames, numTeamsUsed,
    salaryTotal, salaryStd, salaryTopThree, salaryBotThree,
    geoMeanOwnHit, ownAvg,
    pitcherIds: pitchers.map(p => p.id),
    pitcherNames: pitchers.map(p => p.name),
    pitcherTeams: pitchers.map(p => (p.team || '').toUpperCase()),
    pitcherOpps: pitchers.map(p => (p.opponent || '').toUpperCase()),
  };
}

function buildLineupDetail(lu: Lineup, sd: SlateData) {
  const pids = lu.players.map(p => p.id);
  const names = lu.players.map(p => p.name);
  const teams = lu.players.map(p => p.team || '');
  const positions = lu.players.map(p => p.position || '');
  const salaries = lu.players.map(p => p.salary || 0);
  const owns = lu.players.map(p => p.ownership || 0);
  const features = structuralFeatures(lu.players);

  // Compute lineup actual points, rank, finishPct.
  let actual = 0, miss = false;
  for (const p of lu.players) {
    const r = sd.actuals.playerActualsByName.get(norm(p.name));
    if (!r) { miss = true; break; }
    actual += r.fpts;
  }
  const sortedActuals = sd.actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
  let rank = -1, finishPct = 0;
  if (!miss) {
    let lo = 0, hi = sortedActuals.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (sortedActuals[mid] >= actual) lo = mid + 1; else hi = mid; }
    rank = Math.max(1, lo);
    finishPct = sortedActuals.length > 1 ? 1 - (rank - 1) / (sortedActuals.length - 1) : 0.5;
  }
  return {
    pids, names, teams, positions, salaries, owns,
    projection: lu.projection,
    actual: miss ? null : actual,
    rank, finishPct,
    ...features,
  };
}

async function main() {
  console.log('================================================================');
  console.log('BASELINE UPDATE — V1-NoCorr on 4 new slates');
  console.log('================================================================\n');

  const allDump: any[] = [];
  for (const s of NEW_SLATES) {
    process.stderr.write(`Loading ${s.slate}...`);
    const sd = await loadSlate(s);
    if (!sd) { console.error(`SKIP ${s.slate}: load failed`); continue; }
    process.stderr.write(` pool=${sd.candidates.length} teams=${sd.numTeams} entries=${sd.totalEntries} ... `);
    const t0 = Date.now();
    const portfolio = buildV1NoCorrPortfolio(sd);
    process.stderr.write(`done (${Date.now() - t0}ms, ${portfolio.length} lineups)\n`);

    // Export DK CSV + detail.
    const dkCsv = path.join(PORTFOLIO_DIR, `${s.slate}_dk.csv`);
    const detailCsv = path.join(PORTFOLIO_DIR, `${s.slate}_detail.csv`);
    exportForDraftKings(portfolio, sd.config, dkCsv);
    exportDetailedLineups(portfolio, sd.config, detailCsv);

    // Build dump row.
    const vNoCorr = portfolio.map(lu => buildLineupDetail(lu, sd));
    allDump.push({
      slate: sd.slate,
      numTeams: sd.numTeams,
      totalEntries: sd.totalEntries,
      poolSize: sd.candidates.length,
      optimalProj: sd.optimalProj,
      vNoCorr,
    });

    // Quick stats.
    const projs = vNoCorr.map(l => l.projection);
    const owns = vNoCorr.map(l => l.ownAvg);
    const sals = vNoCorr.map(l => l.salaryTotal);
    const stack5plus = vNoCorr.filter(l => l.primarySize >= 5).length;
    const stack4 = vNoCorr.filter(l => l.primarySize === 4).length;
    const stack3 = vNoCorr.filter(l => l.primarySize === 3).length;
    const bbAtLeast1 = vNoCorr.filter(l => l.bringBack >= 1).length;
    console.log(`  ${s.slate}: lineups=${portfolio.length}/${N}  proj=${mean(projs).toFixed(1)}  own=${mean(owns).toFixed(1)}%  sal=${mean(sals).toFixed(0)}  stk5+=${stack5plus} stk4=${stack4} stk3=${stack3}  BB>=1=${bbAtLeast1}/${portfolio.length}`);
  }

  // Save dump.
  const dumpPath = path.join(OUT_DIR, 'new_slates_v1nocorr_dump.json');
  fs.writeFileSync(dumpPath, JSON.stringify(allDump, null, 2));
  console.log(`\nDump saved: ${dumpPath}`);
  console.log(`Portfolios saved: ${PORTFOLIO_DIR}/`);
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });
