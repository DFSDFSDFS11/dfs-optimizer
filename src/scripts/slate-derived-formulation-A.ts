/**
 * Slate-Derived Research — FORMULATION A
 * Frontier sampling with variance-adaptive 3-mode Gaussian mixture.
 *
 * Spec: C:/Users/colin/dfs opto/slate_derived_research/SPECIFICATION.md (Section 2C-A)
 * LOCKED at Stage 2 — do not modify magnitudes.
 *
 * Output: 75-lineup portfolio per slate to slate_derived_research/development_results/A/
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';
import { exportForDraftKings } from '../scoring';

// ===== SPEC-LOCKED CONSTANTS (Formulation A, Stage 2C-A) =====
const N = 75;
const MU_CHALK = 0.85;
const MU_MID = 0.50;
const MU_LEVERAGE = 0.15;
const SIGMA_BASE = 0.05;
const SIGMA_VARIANCE_SCALE = 0.5;
const SIGMA_MIN = 0.03;
const SIGMA_MAX = 0.10;
const W_CHALK_BASE = 0.40;
const W_MID_BASE = 0.30;
const W_LEVERAGE_BASE = 0.30;
const ELASTICITY_PIVOT = 0.20;
const ELASTICITY_TILT_MAG = 0.10;
const ELASTICITY_TILT_SCALE = 0.10;
const CHALK_CONC_PIVOT = 0.20;
const CHALK_CONC_TILT_MAG = 0.05;
const CHALK_CONC_TILT_SCALE = 0.10;
const MODE_W_MIN = 0.15;
const MODE_W_MAX = 0.60;
const SAMPLE_RETRIES = 5;
const STACK_RETRIES = 10;
const MIN_PRIMARY_STACK = 4;
const SIGMA_REF = 0.30;
const OWN_FLOOR = 0.1;
const ACTIVE_HITTER_PROJ = 5;
const ACTIVE_PITCHER_PROJ = 8;
const IQR_TO_SIGMA = 1.349;

// 16 development slates ONLY — holdout 8 are not opened (HOLDOUT_LOCK.md)
const DEV_SLATES: { slate: string; proj: string; pool: string }[] = [
  { slate: '4-8-26', proj: '4-8-26projections.csv', pool: '4-8-26sspool.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv', pool: '4-12-26sspool.csv' },
  { slate: '4-17-26', proj: '4-17-26projections.csv', pool: '4-17-26sspool.csv' },
  { slate: '4-18-26', proj: '4-18-26projections.csv', pool: '4-18-26sspool.csv' },
  { slate: '4-21-26', proj: '4-21-26projections.csv', pool: '4-21-26sspool.csv' },
  { slate: '4-22-26', proj: '4-22-26projections.csv', pool: '4-22-26sspool.csv' },
  { slate: '4-23-26', proj: '4-23-26projections.csv', pool: '4-23-26sspool.csv' },
  { slate: '4-24-26', proj: '4-24-26projections.csv', pool: '4-24-26sspool.csv' },
  { slate: '4-25-26', proj: '4-25-26projections.csv', pool: '4-25-26sspool.csv' },
  { slate: '4-25-26-early', proj: '4-25-26projectionsearly.csv', pool: '4-25-26sspoolearly.csv' },
  { slate: '4-26-26', proj: '4-26-26projections.csv', pool: '4-26-26sspool.csv' },
  { slate: '4-27-26', proj: '4-27-26projections.csv', pool: '4-27-26sspool.csv' },
  { slate: '4-28-26', proj: '4-28-26projections.csv', pool: '4-28-26sspool.csv' },
  { slate: '4-29-26', proj: '4-29-26projections.csv', pool: '4-29-26sspool.csv' },
  { slate: '5-2-26-main', proj: '5-2-26projectionsmain.csv', pool: '5-2-26sspoolmain.csv' },
  { slate: '5-3-26', proj: '5-3-26projections.csv', pool: '5-3-26sspool.csv' },
];

// Holdout slates list — not used for any analysis until Stage 6.
const HOLDOUT_SLATES_DO_NOT_OPEN: { slate: string; proj: string; pool: string }[] = [
  { slate: '4-6-26', proj: '4-6-26_projections.csv', pool: 'sspool4-6-26.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv', pool: '4-14-26sspool.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv', pool: '4-15-26sspool.csv' },
  { slate: '4-19-26', proj: '4-19-26projections.csv', pool: '4-19-26sspool.csv' },
  { slate: '4-20-26', proj: '4-20-26projections.csv', pool: '4-20-26sspool.csv' },
  { slate: '5-1-26', proj: '5-1-26projections.csv', pool: '5-1-26sspool.csv' },
  { slate: '5-2-26', proj: '5-2-26projections.csv', pool: '5-2-26sspool.csv' },
  { slate: '5-2-26-night', proj: '5-2-26projectionsnight.csv', pool: '5-2-26sspoolnight.csv' },
];

const DATA_DIR = 'C:/Users/colin/dfs opto';
const OUT_DIR = 'C:/Users/colin/dfs opto/slate_derived_research/development_results/A';

function isPitcher(p: Player): boolean { return (p.position || '').toUpperCase().includes('P'); }
function clip(x: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, x)); }
function mean(a: number[]): number { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
function median(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function makeRng(seed: number): () => number {
  let s = seed >>> 0; if (s === 0) s = 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}
function hashSeed(slate: string): number {
  let h = 2166136261;
  for (let i = 0; i < slate.length; i++) { h ^= slate.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

interface LineupChar {
  lu: Lineup;
  proj: number;
  geoMeanOwnHit: number;
  primarySize: number;
  secondarySize: number;
  primaryTeam: string;
  primaryOpp: string;
  bringBack: number;
  numGames: number;
  numTeamsUsed: number;
  maxGameStack: number;
  salaryStd: number;
  salaryTopThree: number;
  pitcherFacesPrimaryStack: boolean;
}

function characterize(lu: Lineup): LineupChar {
  const teamHitters = new Map<string, number>();
  const pitchers: Player[] = [];
  for (const p of lu.players) {
    if (isPitcher(p)) pitchers.push(p);
    else { const t = (p.team || '').toUpperCase(); if (t) teamHitters.set(t, (teamHitters.get(t) || 0) + 1); }
  }
  let primaryTeam = '', primarySize = 0, secondarySize = 0;
  const sortedTeams = [...teamHitters.entries()].sort((a, b) => b[1] - a[1]);
  if (sortedTeams.length > 0) { primaryTeam = sortedTeams[0][0]; primarySize = sortedTeams[0][1]; }
  if (sortedTeams.length > 1) secondarySize = sortedTeams[1][1];
  let primaryOpp = '';
  for (const p of lu.players) {
    if ((p.team || '').toUpperCase() === primaryTeam) {
      const opp = (p.opponent || '').toUpperCase();
      if (opp) { primaryOpp = opp; break; }
    }
  }
  const bringBack = primaryOpp ? (teamHitters.get(primaryOpp) || 0) : 0;
  let pitcherFacesPrimaryStack = false;
  for (const p of pitchers) {
    if ((p.opponent || '').toUpperCase() === primaryTeam) pitcherFacesPrimaryStack = true;
  }
  let logOwnHit = 0; let nh = 0;
  for (const p of lu.players) if (!isPitcher(p)) {
    const o = Math.max(OWN_FLOOR, p.ownership || OWN_FLOOR);
    logOwnHit += Math.log(o); nh++;
  }
  const geoMeanOwnHit = nh > 0 ? Math.exp(logOwnHit / nh) : OWN_FLOOR;
  const games = new Set<string>(); const allTeams = new Set<string>();
  const gameCounts = new Map<string, number>();
  for (const p of lu.players) {
    const t = (p.team || '').toUpperCase(); const o = (p.opponent || '').toUpperCase();
    if (!t) continue; allTeams.add(t);
    const gameId = t < o ? `${t}@${o}` : `${o}@${t}`;
    games.add(gameId); gameCounts.set(gameId, (gameCounts.get(gameId) || 0) + 1);
  }
  let maxGameStack = 0;
  for (const c of gameCounts.values()) if (c > maxGameStack) maxGameStack = c;
  const sals = lu.players.map(p => p.salary || 0);
  const sm = sals.reduce((a, b) => a + b, 0) / Math.max(1, sals.length);
  let sv = 0; for (const s of sals) sv += (s - sm) ** 2;
  const salaryStd = Math.sqrt(sv / Math.max(1, sals.length));
  const salaryTopThree = [...sals].sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
  return {
    lu, proj: lu.projection, geoMeanOwnHit,
    primarySize, secondarySize, primaryTeam, primaryOpp, bringBack,
    numGames: games.size, numTeamsUsed: allTeams.size, maxGameStack,
    salaryStd, salaryTopThree, pitcherFacesPrimaryStack,
  };
}

interface SlateFeatures {
  frontier: LineupChar[];
  elasticity: number;
  sigmaSlate: number;
  scoringEnv: number;
  chalkConcentration: number;
}

function computeFrontier(chars: LineupChar[]): LineupChar[] {
  const sorted = [...chars].sort((a, b) => a.geoMeanOwnHit - b.geoMeanOwnHit);
  const front: LineupChar[] = [];
  let bestProj = -Infinity;
  for (const c of sorted) if (c.proj > bestProj) { front.push(c); bestProj = c.proj; }
  return front;
}

function computeElasticity(frontier: LineupChar[]): number {
  if (frontier.length < 2) return ELASTICITY_PIVOT;
  const eps: number[] = [];
  for (let k = 0; k < frontier.length - 1; k++) {
    const f1 = frontier[k], f2 = frontier[k + 1];
    const dp = f2.proj - f1.proj;
    const doE = f2.geoMeanOwnHit - f1.geoMeanOwnHit;
    if (Math.abs(doE) < 1e-9 || f1.proj <= 0 || f1.geoMeanOwnHit <= 0) continue;
    const e = (dp / f1.proj) / (doE / f1.geoMeanOwnHit);
    if (isFinite(e)) eps.push(e);
  }
  return eps.length ? median(eps) : ELASTICITY_PIVOT;
}

function computeSigmaSlate(players: Player[]): number {
  const cvs: number[] = [];
  for (const p of players) {
    const isP = isPitcher(p);
    const min = isP ? ACTIVE_PITCHER_PROJ : ACTIVE_HITTER_PROJ;
    if ((p.projection || 0) < min) continue;
    if (!p.percentiles) continue;
    const p25 = p.percentiles.p25, p75 = p.percentiles.p75;
    if (p25 == null || p75 == null) continue;
    const s = (p75 - p25) / IQR_TO_SIGMA;
    const cv = s / Math.max(0.5, p.projection);
    if (isFinite(cv) && cv > 0) cvs.push(cv);
  }
  return cvs.length ? mean(cvs) : SIGMA_REF;
}

function computeChalkConcentration(players: Player[]): number {
  const teamOwn = new Map<string, number>();
  for (const p of players) {
    if (isPitcher(p)) continue;
    if ((p.projection || 0) < ACTIVE_HITTER_PROJ) continue;
    const t = (p.team || '').toUpperCase();
    if (!t) continue;
    teamOwn.set(t, (teamOwn.get(t) || 0) + (p.ownership || 0));
  }
  const total = [...teamOwn.values()].reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  let hhi = 0;
  for (const v of teamOwn.values()) {
    const s = v / total;
    hhi += s * s;
  }
  return hhi;
}

function extractFeatures(chars: LineupChar[], players: Player[]): SlateFeatures {
  const frontier = computeFrontier(chars);
  const elasticity = computeElasticity(frontier);
  const sigmaSlate = computeSigmaSlate(players);
  // S_slate = mean of top-K=10 game totals
  const gameTotals = new Map<string, number>();
  for (const p of players) {
    const t = (p.team || '').toUpperCase();
    const o = (p.opponent || '').toUpperCase();
    if (!t || !o) continue;
    const gameId = t < o ? `${t}@${o}` : `${o}@${t}`;
    const gt = (p as any).gameTotal || 0;
    if (gt > 0 && !gameTotals.has(gameId)) gameTotals.set(gameId, gt);
  }
  const gts = [...gameTotals.values()].sort((a, b) => b - a).slice(0, 10);
  const scoringEnv = gts.length ? mean(gts) / 10 : 9.0; // per-team game total reference (e.g., 220-pt total / ~24 = 9 runs); use raw / 10 as scaled metric
  const chalkConcentration = computeChalkConcentration(players);
  return { frontier, elasticity, sigmaSlate, scoringEnv, chalkConcentration };
}

function computeModeWeights(features: SlateFeatures): { wChalk: number; wMid: number; wLeverage: number; sigma: number } {
  const elTilt = ELASTICITY_TILT_MAG * Math.tanh((features.elasticity - ELASTICITY_PIVOT) / ELASTICITY_TILT_SCALE);
  const ccTilt = CHALK_CONC_TILT_MAG * (features.chalkConcentration - CHALK_CONC_PIVOT) / CHALK_CONC_TILT_SCALE;
  let wC = W_CHALK_BASE + elTilt + ccTilt;
  let wM = W_MID_BASE;
  let wL = W_LEVERAGE_BASE - elTilt;
  wC = clip(wC, MODE_W_MIN, MODE_W_MAX);
  wM = clip(wM, MODE_W_MIN, MODE_W_MAX);
  wL = clip(wL, MODE_W_MIN, MODE_W_MAX);
  const total = wC + wM + wL;
  wC /= total; wM /= total; wL /= total;
  // σ_mode: 0.05 · (1 + 0.5 · z(σ_slate)), z = (σ_slate − SIGMA_REF) / SIGMA_REF
  const z = (features.sigmaSlate - SIGMA_REF) / SIGMA_REF;
  const sigma = clip(SIGMA_BASE * (1 + SIGMA_VARIANCE_SCALE * z), SIGMA_MIN, SIGMA_MAX);
  return { wChalk: wC, wMid: wM, wLeverage: wL, sigma };
}

function gaussianSample(mu: number, sigma: number, rng: () => number): number {
  const u1 = Math.max(1e-9, rng());
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mu + sigma * z;
}

function selectFromFrontierByU(frontier: LineupChar[], u: number, taken: Set<string>): LineupChar | null {
  if (!frontier.length) return null;
  const M = frontier.length;
  const k = Math.max(0, Math.min(M - 1, Math.round(u * (M - 1))));
  // Try k, then expand outward.
  if (!taken.has(frontier[k].lu.hash)) return frontier[k];
  for (let off = 1; off < M; off++) {
    if (k - off >= 0 && !taken.has(frontier[k - off].lu.hash)) return frontier[k - off];
    if (k + off < M && !taken.has(frontier[k + off].lu.hash)) return frontier[k + off];
  }
  return null;
}

function build(features: SlateFeatures, allChars: LineupChar[], rng: () => number): { selected: LineupChar[]; meta: Array<{ mode: string; uTarget: number; uSampled: number }>; weights: { wChalk: number; wMid: number; wLeverage: number; sigma: number } } {
  // Frontier filtered: enforce mps>=4 + no pitcher-vs-stack.
  const frontierFiltered = features.frontier.filter(c => c.primarySize >= MIN_PRIMARY_STACK && !c.pitcherFacesPrimaryStack);
  // If frontier filtered too small, fall back to: any pool lineup with mps>=4 and no pitcher-vs-stack, sorted by ownership.
  let workFrontier = frontierFiltered;
  if (workFrontier.length < 30) {
    workFrontier = allChars
      .filter(c => c.primarySize >= MIN_PRIMARY_STACK && !c.pitcherFacesPrimaryStack)
      .sort((a, b) => a.geoMeanOwnHit - b.geoMeanOwnHit);
    // Re-apply the Pareto sweep on this larger filtered set
    const sweep: LineupChar[] = [];
    let bestProj = -Infinity;
    for (const c of workFrontier) if (c.proj > bestProj) { sweep.push(c); bestProj = c.proj; }
    if (sweep.length >= 20) workFrontier = sweep;
  }
  if (workFrontier.length === 0) {
    // last resort: use any candidate
    workFrontier = [...allChars].sort((a, b) => a.geoMeanOwnHit - b.geoMeanOwnHit);
  }

  const w = computeModeWeights(features);
  const taken = new Set<string>();
  const selected: LineupChar[] = [];
  const meta: Array<{ mode: string; uTarget: number; uSampled: number }> = [];

  while (selected.length < N) {
    // Sample mode
    const r = rng();
    let modeName: string; let mu: number;
    if (r < w.wChalk) { modeName = 'chalk'; mu = MU_CHALK; }
    else if (r < w.wChalk + w.wMid) { modeName = 'mid'; mu = MU_MID; }
    else { modeName = 'leverage'; mu = MU_LEVERAGE; }

    let chosen: LineupChar | null = null;
    let uSampled = 0;
    for (let retry = 0; retry < SAMPLE_RETRIES; retry++) {
      uSampled = clip(gaussianSample(mu, w.sigma, rng), 0, 1);
      const cand = selectFromFrontierByU(workFrontier, uSampled, taken);
      if (cand) { chosen = cand; break; }
    }
    if (!chosen) {
      // Pool exhausted at the frontier — fall back to any unused char with mps>=4
      const fallback = allChars.find(c => !taken.has(c.lu.hash) && c.primarySize >= MIN_PRIMARY_STACK && !c.pitcherFacesPrimaryStack);
      if (fallback) chosen = fallback;
      else break;
    }
    taken.add(chosen.lu.hash);
    selected.push(chosen);
    meta.push({ mode: modeName, uTarget: mu, uSampled });
    if (selected.length > N * 3) break; // safety
  }

  return { selected: selected.slice(0, N), meta, weights: w };
}

async function runSlate(slate: string, projFile: string, poolFile: string): Promise<any> {
  const projPath = path.join(DATA_DIR, projFile);
  const poolPath = path.join(DATA_DIR, poolFile);
  if (!fs.existsSync(projPath) || !fs.existsSync(poolPath)) {
    console.warn(`Skip ${slate}: missing files`);
    return null;
  }
  const pr = parseCSVFile(projPath, 'mlb', true);
  const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
  const pool = buildPlayerPool(pr.players, pr.detectedContestType);
  const idMap = new Map<string, Player>();
  for (const p of pool.players) idMap.set(p.id, p);
  const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
  const merged = new Map<string, Lineup>();
  for (const lu of loaded.lineups) if (!merged.has(lu.hash)) merged.set(lu.hash, lu);
  const candidates = Array.from(merged.values());
  if (!candidates.length) { console.warn(`Skip ${slate}: empty pool`); return null; }

  const chars = candidates.map(characterize);
  const features = extractFeatures(chars, pool.players);
  const seed = hashSeed(slate);
  const rng = makeRng(seed);
  const t0 = Date.now();
  const result = build(features, chars, rng);
  const elapsed = Date.now() - t0;

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const dkPath = path.join(OUT_DIR, `${slate}_dk.csv`);
  const detPath = path.join(OUT_DIR, `${slate}_detail.csv`);
  exportForDraftKings(result.selected.map(c => c.lu), config, dkPath);
  writeDetailCSV(result.selected, result.meta, detPath);

  console.log(`  [${slate}] cands=${candidates.length} N=${result.selected.length}/${N} ` +
    `ε=${features.elasticity.toFixed(3)} σ=${features.sigmaSlate.toFixed(3)} ` +
    `H=${features.chalkConcentration.toFixed(3)} S=${features.scoringEnv.toFixed(2)} ` +
    `wC/M/L=${result.weights.wChalk.toFixed(2)}/${result.weights.wMid.toFixed(2)}/${result.weights.wLeverage.toFixed(2)} ` +
    `σ_mode=${result.weights.sigma.toFixed(3)} ${elapsed}ms`);

  return {
    slate, n: result.selected.length, elapsed,
    elasticity: features.elasticity, sigmaSlate: features.sigmaSlate,
    chalkConcentration: features.chalkConcentration, scoringEnv: features.scoringEnv,
    wChalk: result.weights.wChalk, wMid: result.weights.wMid, wLeverage: result.weights.wLeverage,
    sigmaMode: result.weights.sigma,
  };
}

function writeDetailCSV(selected: LineupChar[], meta: Array<{ mode: string; uTarget: number; uSampled: number }>, outPath: string) {
  const headers = ['rank', 'mode', 'uTarget', 'uSampled', 'primarySize', 'secondarySize', 'primaryTeam', 'primaryOpp', 'bringBack',
    'numGames', 'numTeamsUsed', 'maxGameStack', 'salaryStd', 'salaryTopThree', 'proj', 'geoMeanOwnHit', 'salaryTotal',
    'pitcherFacesStack'];
  const lines = [headers.join(',')];
  for (let i = 0; i < selected.length; i++) {
    const c = selected[i]; const m = meta[i] || { mode: '', uTarget: 0, uSampled: 0 };
    const row = [
      i + 1, m.mode, m.uTarget.toFixed(3), m.uSampled.toFixed(3),
      c.primarySize, c.secondarySize, c.primaryTeam, c.primaryOpp, c.bringBack,
      c.numGames, c.numTeamsUsed, c.maxGameStack, c.salaryStd.toFixed(2), c.salaryTopThree,
      c.proj.toFixed(2), c.geoMeanOwnHit.toFixed(3), c.lu.salary, c.pitcherFacesPrimaryStack ? 1 : 0,
    ];
    lines.push(row.join(','));
  }
  fs.writeFileSync(outPath, lines.join('\n'), 'utf-8');
}

async function main() {
  console.log('='.repeat(64));
  console.log('SLATE-DERIVED FORMULATION A — Frontier 3-mode Gaussian mixture');
  console.log('='.repeat(64));
  console.log(`HOLDOUT slates excluded: ${HOLDOUT_SLATES_DO_NOT_OPEN.map(s => s.slate).join(', ')}`);
  console.log(`Running ${DEV_SLATES.length} development slates only.\n`);
  const summary: any[] = [];
  for (const s of DEV_SLATES) {
    const r = await runSlate(s.slate, s.proj, s.pool);
    if (r) summary.push(r);
  }
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'run_summary.json'), JSON.stringify(summary, null, 2), 'utf-8');
  console.log('\nDONE — Formulation A development run.');
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });
