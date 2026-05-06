/**
 * Slate-Derived Research — FORMULATION C
 * Game-stack foundation with explicit correlation premium scoring.
 *
 * Spec: C:/Users/colin/dfs opto/slate_derived_research/SPECIFICATION.md (Section 2C-C)
 * Amendment 1 in SPECIFICATION_AMENDMENT.md: scoring over pool, not de novo construction.
 *
 * For each pool lineup ℓ:
 *   - identify dominant game g_ℓ (the game with most hitters from ℓ).
 *   - compute Premium(g_ℓ) given slate features (γ_eff for chalk-conc, δ for game total).
 *   - skeleton match: 4-2 (or 5-3 if S>11) — partial credit for off-skeleton lineups.
 *   - reject if pitcher in stacked game.
 * Score(ℓ) = Premium(g_ℓ) + skeleton_match_score.
 * Top 75 by score.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';
import { exportForDraftKings } from '../scoring';

// ===== SPEC-LOCKED CONSTANTS (Formulation C, Stage 2C-C) =====
const N = 75;
const GAMMA_BASE = 0.25;
const GAMMA_TILT_MAG = 0.15;
const GAMMA_TILT_SCALE = 0.10;
const GAMMA_PIVOT_H = 0.20;
const GAMMA_MIN = 0.10;
const GAMMA_MAX = 0.40;
const DELTA_GAME_TOTAL = 0.20;
const GAME_TOTAL_PIVOT = 9.0;
const TAU_GAME_BASE = 4.0;
const TAU_GAME_VARIANCE_SCALE = 0.5;
const TAU_GAME_MIN = 2.0;
const TAU_GAME_MAX = 8.0;
const TAU_PITCHER = 4.0;
const TAU_PLAYER = 5.0;
const FILLER_LAMBDA_PLAYER = 0.30;
const SCORING_THRESHOLD_53 = 11.0;
const PROB_53 = 0.30;
const SIGMA_REF = 0.30;
const ELASTICITY_PIVOT = 0.20;
const OWN_FLOOR = 0.1;
const ACTIVE_HITTER_PROJ = 5;
const ACTIVE_PITCHER_PROJ = 8;
const IQR_TO_SIGMA = 1.349;
const MIN_PRIMARY_STACK = 4;

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

const DATA_DIR = 'C:/Users/colin/dfs opto';
const OUT_DIR = 'C:/Users/colin/dfs opto/slate_derived_research/development_results/C';

function isPitcher(p: Player): boolean { return (p.position || '').toUpperCase().includes('P'); }
function clip(x: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, x)); }
function mean(a: number[]): number { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
function median(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function gameId(t: string, o: string): string {
  return t < o ? `${t}@${o}` : `${o}@${t}`;
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
  hitters: Player[];
  pitchers: Player[];
  pitcherFacesPrimaryStack: boolean;
  // Game-stack identity for Formulation C
  dominantGame: string;
  dominantGameHitterCounts: { teamA: string; cntA: number; teamB: string; cntB: number };
  pitcherInDominantGame: boolean;
}

function characterize(lu: Lineup): LineupChar {
  const teamHitters = new Map<string, number>();
  const pitchers: Player[] = [];
  const hitters: Player[] = [];
  const gameHitters = new Map<string, { teamCounts: Map<string, number> }>();
  for (const p of lu.players) {
    if (isPitcher(p)) pitchers.push(p);
    else {
      hitters.push(p);
      const t = (p.team || '').toUpperCase();
      const o = (p.opponent || '').toUpperCase();
      if (t) {
        teamHitters.set(t, (teamHitters.get(t) || 0) + 1);
        const gid = gameId(t, o);
        if (!gameHitters.has(gid)) gameHitters.set(gid, { teamCounts: new Map() });
        const g = gameHitters.get(gid)!;
        g.teamCounts.set(t, (g.teamCounts.get(t) || 0) + 1);
      }
    }
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
  for (const p of hitters) {
    const o = Math.max(OWN_FLOOR, p.ownership || OWN_FLOOR);
    logOwnHit += Math.log(o); nh++;
  }
  const geoMeanOwnHit = nh > 0 ? Math.exp(logOwnHit / nh) : OWN_FLOOR;

  // Dominant game: max sum of hitters in one game.
  let dominantGame = '', dominantTotal = 0;
  let dominantA = '', dominantCntA = 0, dominantB = '', dominantCntB = 0;
  for (const [gid, g] of gameHitters) {
    let total = 0;
    for (const c of g.teamCounts.values()) total += c;
    if (total > dominantTotal) {
      dominantTotal = total;
      dominantGame = gid;
      const sortedTC = [...g.teamCounts.entries()].sort((a, b) => b[1] - a[1]);
      dominantA = sortedTC[0]?.[0] || ''; dominantCntA = sortedTC[0]?.[1] || 0;
      dominantB = sortedTC[1]?.[0] || ''; dominantCntB = sortedTC[1]?.[1] || 0;
    }
  }
  // Pitcher-in-dominant-game: pitcher's team or opponent equals dominantA or dominantB
  let pitcherInDominantGame = false;
  for (const p of pitchers) {
    const t = (p.team || '').toUpperCase();
    const o = (p.opponent || '').toUpperCase();
    if (t === dominantA || t === dominantB || o === dominantA || o === dominantB) {
      pitcherInDominantGame = true; break;
    }
  }

  const games = new Set<string>(); const allTeams = new Set<string>();
  const gameCounts = new Map<string, number>();
  for (const p of lu.players) {
    const t = (p.team || '').toUpperCase(); const o = (p.opponent || '').toUpperCase();
    if (!t) continue; allTeams.add(t);
    const gid = gameId(t, o);
    games.add(gid); gameCounts.set(gid, (gameCounts.get(gid) || 0) + 1);
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
    salaryStd, salaryTopThree, hitters, pitchers, pitcherFacesPrimaryStack,
    dominantGame, dominantGameHitterCounts: { teamA: dominantA, cntA: dominantCntA, teamB: dominantB, cntB: dominantCntB },
    pitcherInDominantGame,
  };
}

interface GamePremium {
  gameId: string;
  teamA: string;
  teamB: string;
  premium: number;
  gameTotal: number;
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

function computeGamePremiums(players: Player[], gammaEff: number): { premiums: Map<string, GamePremium>; sigmaSlate: number; chalkConc: number; gameTotalAvg: number } {
  // Build per-game team rosters
  const byGame = new Map<string, { teamA: string; teamB: string; rosterA: Player[]; rosterB: Player[]; gameTotal: number }>();
  for (const p of players) {
    if (isPitcher(p)) continue;
    if ((p.projection || 0) < ACTIVE_HITTER_PROJ) continue;
    const t = (p.team || '').toUpperCase();
    const o = (p.opponent || '').toUpperCase();
    if (!t || !o) continue;
    const gid = gameId(t, o);
    if (!byGame.has(gid)) {
      const teamA = t < o ? t : o;
      const teamB = t < o ? o : t;
      byGame.set(gid, { teamA, teamB, rosterA: [], rosterB: [], gameTotal: (p as any).gameTotal || 0 });
    }
    const g = byGame.get(gid)!;
    if (t === g.teamA) g.rosterA.push(p);
    else g.rosterB.push(p);
    if (!g.gameTotal) g.gameTotal = (p as any).gameTotal || 0;
  }
  const premiums = new Map<string, GamePremium>();
  let totalGameTotal = 0; let nGT = 0;
  for (const [gid, g] of byGame) {
    const top5A = [...g.rosterA].sort((a, b) => b.projection - a.projection).slice(0, 5);
    const top3B = [...g.rosterB].sort((a, b) => b.projection - a.projection).slice(0, 3);
    if (top5A.length < 4 || top3B.length < 1) continue;
    const projSum = top5A.reduce((s, p) => s + p.projection, 0) + top3B.reduce((s, p) => s + p.projection, 0);
    const ownAvg = ([...top5A, ...top3B].reduce((s, p) => s + (p.ownership || 0), 0)) / 8;
    // gameTotal already in run-units (~7-12 typical MLB) per Stage 2.5 Amendment 2; no /24 scaling.
    const gtRunsPerTeam = g.gameTotal;
    const gtBonus = DELTA_GAME_TOTAL * (gtRunsPerTeam - GAME_TOTAL_PIVOT);
    const corrScore = projSum - gammaEff * ownAvg + gtBonus;
    premiums.set(gid, { gameId: gid, teamA: g.teamA, teamB: g.teamB, premium: corrScore, gameTotal: gtRunsPerTeam });
    totalGameTotal += gtRunsPerTeam; nGT++;
  }
  const sigmaSlate = computeSigmaSlate(players);
  const chalkConc = computeChalkConcentration(players);
  return { premiums, sigmaSlate, chalkConc, gameTotalAvg: nGT ? totalGameTotal / nGT : GAME_TOTAL_PIVOT };
}

function computeElasticity(chars: LineupChar[]): number {
  const sorted = [...chars].sort((a, b) => a.geoMeanOwnHit - b.geoMeanOwnHit);
  const front: LineupChar[] = [];
  let bestProj = -Infinity;
  for (const c of sorted) if (c.proj > bestProj) { front.push(c); bestProj = c.proj; }
  if (front.length < 2) return ELASTICITY_PIVOT;
  const eps: number[] = [];
  for (let k = 0; k < front.length - 1; k++) {
    const f1 = front[k], f2 = front[k + 1];
    const dp = f2.proj - f1.proj;
    const doE = f2.geoMeanOwnHit - f1.geoMeanOwnHit;
    if (Math.abs(doE) < 1e-9 || f1.proj <= 0 || f1.geoMeanOwnHit <= 0) continue;
    const e = (dp / f1.proj) / (doE / f1.geoMeanOwnHit);
    if (isFinite(e)) eps.push(e);
  }
  return eps.length ? median(eps) : ELASTICITY_PIVOT;
}

function logSoftmaxFor(score: number, allScores: number[], tau: number): number {
  const denom = allScores.reduce((s, x) => s + Math.exp(x / tau), 0);
  return score / tau - Math.log(Math.max(1e-12, denom));
}

function scoreCLineup(c: LineupChar, premiums: Map<string, GamePremium>, allPremiumScores: number[], tauGame: number, gammaEff: number, gtAvg: number, pitcherPool: Player[], use53: boolean): number | null {
  // Hard reject: pitcher-in-dominant-game.
  if (c.pitcherInDominantGame) return null;
  if (c.primarySize < MIN_PRIMARY_STACK) return null;

  const gp = premiums.get(c.dominantGame);
  if (!gp) return null;

  // log P(g chosen) = premium(g)/τ_game − log Σ exp(premium/τ_game)
  const logPg = logSoftmaxFor(gp.premium, allPremiumScores, tauGame);

  // Skeleton match: 4-2 default. If use53 and c matches 5-3, give bonus PROB_53; else 4-2 standard.
  const a = c.dominantGameHitterCounts.cntA;
  const b = c.dominantGameHitterCounts.cntB;
  let skelMatch = 0;
  if (use53) {
    if ((a === 5 && b === 3) || (a === 3 && b === 5)) skelMatch = Math.log(PROB_53);
    else if ((a === 4 && b === 2) || (a === 2 && b === 4)) skelMatch = Math.log(1 - PROB_53);
    else if ((a >= 4 && b >= 1) || (b >= 4 && a >= 1)) skelMatch = Math.log(0.5 * (1 - PROB_53)); // partial
    else skelMatch = Math.log(1e-3); // off-skeleton
  } else {
    if ((a === 4 && b === 2) || (a === 2 && b === 4)) skelMatch = 0; // exact match = 0 log-pen
    else if ((a >= 4 && b >= 1) || (b >= 4 && a >= 1)) skelMatch = Math.log(0.7); // close
    else if (a + b >= 5) skelMatch = Math.log(0.4);
    else skelMatch = Math.log(0.1);
  }

  // 4-stack chalk-fade: in C.3 we drop one of top-5 with prob ∝ ownership. The lineup has its 4 hitters from team A;
  // give a small bonus if the highest-owned of top-5 is NOT in the lineup (consistent with chalk-fade).
  // Simplification: skip the per-lineup bonus; the premium term already accounts for chalk via γ.

  // Pitcher log-likelihood
  const allSP = pitcherPool.map(p => (p.projection || 0) - FILLER_LAMBDA_PLAYER * (p.ownership || 0) / 100);
  const denomP = allSP.reduce((s, x) => s + Math.exp(x / TAU_PITCHER), 0);
  let chosenSumP = 0; let nP = 0;
  for (const p of c.pitchers) {
    chosenSumP += (p.projection || 0) - FILLER_LAMBDA_PLAYER * (p.ownership || 0) / 100;
    nP++;
  }
  const logPp = chosenSumP / TAU_PITCHER - nP * Math.log(Math.max(1e-12, denomP));

  // Filler: for the 2 players NOT in dominant game, score by s2 = proj - 0.30·own/100, summed / τ_player.
  let fillerSum = 0; let nFill = 0;
  for (const h of c.hitters) {
    const t = (h.team || '').toUpperCase();
    if (t === c.dominantGameHitterCounts.teamA || t === c.dominantGameHitterCounts.teamB) continue;
    fillerSum += (h.projection || 0) - FILLER_LAMBDA_PLAYER * (h.ownership || 0) / 100;
    nFill++;
  }
  const logFill = fillerSum / TAU_PLAYER;

  return logPg + skelMatch + logPp + logFill;
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
  const elasticity = computeElasticity(chars);
  const sigmaSlate = computeSigmaSlate(pool.players);
  const chalkConc = computeChalkConcentration(pool.players);

  // γ_eff
  const gammaEff = clip(GAMMA_BASE + GAMMA_TILT_MAG * Math.tanh((chalkConc - GAMMA_PIVOT_H) / GAMMA_TILT_SCALE), GAMMA_MIN, GAMMA_MAX);
  // τ_game_eff
  const tauGameEff = clip(TAU_GAME_BASE * (1 + TAU_GAME_VARIANCE_SCALE * (sigmaSlate - SIGMA_REF) / SIGMA_REF), TAU_GAME_MIN, TAU_GAME_MAX);
  const { premiums, gameTotalAvg } = computeGamePremiums(pool.players, gammaEff);
  const allPremiumScores = [...premiums.values()].map(g => g.premium);
  const use53 = gameTotalAvg > SCORING_THRESHOLD_53;

  const pitcherPool = pool.players.filter(p => isPitcher(p) && (p.projection || 0) >= ACTIVE_PITCHER_PROJ);

  const t0 = Date.now();
  const scored: { c: LineupChar; score: number }[] = [];
  for (const c of chars) {
    const sc = scoreCLineup(c, premiums, allPremiumScores, tauGameEff, gammaEff, gameTotalAvg, pitcherPool, use53);
    if (sc != null && isFinite(sc)) scored.push({ c, score: sc });
  }
  scored.sort((a, b) => b.score - a.score);
  const selected = scored.slice(0, N).map(s => s.c);
  const elapsed = Date.now() - t0;

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const dkPath = path.join(OUT_DIR, `${slate}_dk.csv`);
  const detPath = path.join(OUT_DIR, `${slate}_detail.csv`);
  exportForDraftKings(selected.map(c => c.lu), config, dkPath);
  writeDetailCSV(selected, scored.slice(0, N).map(s => s.score), detPath);

  console.log(`  [${slate}] cands=${candidates.length} valid=${scored.length} N=${selected.length}/${N} ` +
    `H=${chalkConc.toFixed(3)} σ=${sigmaSlate.toFixed(3)} γ=${gammaEff.toFixed(3)} τg=${tauGameEff.toFixed(2)} S=${gameTotalAvg.toFixed(2)} 5-3=${use53} ${elapsed}ms`);

  return {
    slate, n: selected.length, elapsed,
    elasticity, sigmaSlate, chalkConc, gammaEff, tauGameEff, gameTotalAvg, use53,
    poolValid: scored.length, poolTotal: candidates.length,
  };
}

function writeDetailCSV(selected: LineupChar[], scores: number[], outPath: string) {
  const headers = ['rank', 'score', 'primarySize', 'secondarySize', 'primaryTeam', 'primaryOpp', 'bringBack',
    'numGames', 'numTeamsUsed', 'maxGameStack', 'salaryStd', 'salaryTopThree', 'proj', 'geoMeanOwnHit', 'salaryTotal',
    'pitcherFacesStack', 'dominantGame', 'dominantA', 'cntA', 'dominantB', 'cntB'];
  const lines = [headers.join(',')];
  for (let i = 0; i < selected.length; i++) {
    const c = selected[i];
    const row = [
      i + 1, (scores[i] || 0).toFixed(3),
      c.primarySize, c.secondarySize, c.primaryTeam, c.primaryOpp, c.bringBack,
      c.numGames, c.numTeamsUsed, c.maxGameStack, c.salaryStd.toFixed(2), c.salaryTopThree,
      c.proj.toFixed(2), c.geoMeanOwnHit.toFixed(3), c.lu.salary,
      c.pitcherFacesPrimaryStack ? 1 : 0,
      c.dominantGame, c.dominantGameHitterCounts.teamA, c.dominantGameHitterCounts.cntA,
      c.dominantGameHitterCounts.teamB, c.dominantGameHitterCounts.cntB,
    ];
    lines.push(row.join(','));
  }
  fs.writeFileSync(outPath, lines.join('\n'), 'utf-8');
}

async function main() {
  console.log('='.repeat(64));
  console.log('SLATE-DERIVED FORMULATION C — Game-stack premium scoring');
  console.log('='.repeat(64));
  console.log(`Running ${DEV_SLATES.length} development slates only.\n`);
  const summary: any[] = [];
  for (const s of DEV_SLATES) {
    const r = await runSlate(s.slate, s.proj, s.pool);
    if (r) summary.push(r);
  }
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'run_summary.json'), JSON.stringify(summary, null, 2), 'utf-8');
  console.log('\nDONE — Formulation C development run.');
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });
