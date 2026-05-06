/**
 * Slate-Derived Research — FORMULATION B
 * Hierarchical anchor-then-spread.
 *
 * Spec: C:/Users/colin/dfs opto/slate_derived_research/SPECIFICATION.md (Section 2C-B)
 * Amendment 1 in SPECIFICATION_AMENDMENT.md: scoring over pool, not de novo construction.
 *
 * For each pool lineup ℓ:
 *   - identify primaryTeam(ℓ) (= "would-be anchor")
 *   - compute Stage 1 score s1(t) for that team in slate context
 *   - compute Stage 2 score sum: Σ s2(p) for the 4 hitters in primaryTeam from ℓ
 *   - bring-back log-likelihood depends on slate via p_bb
 *   - pitcher score Σ s2_p for the 2 pitchers
 *   - filler score Σ s2 for remaining
 *   - reject lineup if pitcher shares team with anchor or bring-back
 * Top 75 by combined log-score.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';
import { exportForDraftKings } from '../scoring';

// ===== SPEC-LOCKED CONSTANTS (Formulation B, Stage 2C-B) =====
const N = 75;
const LAMBDA_TEAM_BASE = 0.40;
const LAMBDA_TEAM_TILT_MAG = 0.30;
const LAMBDA_TEAM_TILT_SCALE = 0.10;
const LAMBDA_TEAM_MIN = 0.10;
const LAMBDA_TEAM_MAX = 0.70;
const LAMBDA_PLAYER = 0.30;
const TAU_TEAM = 0.30;
const TAU_PLAYER = 5.0;
const TAU_PITCHER = 4.0;
const P_BB_BASE = 0.22;
const P_BB_SCALE = 0.10;
const P_BB_PIVOT_S = 9.0;
const P_BB_DELTA_DIV = 2.0;
const P_BB_MIN = 0.10;
const P_BB_MAX = 0.35;
const ELASTICITY_PIVOT = 0.20;
const OWN_FLOOR = 0.1;
const ACTIVE_HITTER_PROJ = 5;
const ACTIVE_PITCHER_PROJ = 8;
const IQR_TO_SIGMA = 1.349;
const SIGMA_REF = 0.30;
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
const OUT_DIR = 'C:/Users/colin/dfs opto/slate_derived_research/development_results/B';

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
  hitters: Player[];
  pitchers: Player[];
  pitcherFacesPrimaryStack: boolean;
  pitcherInBringBackTeam: boolean;
}

function characterize(lu: Lineup): LineupChar {
  const teamHitters = new Map<string, number>();
  const pitchers: Player[] = [];
  const hitters: Player[] = [];
  for (const p of lu.players) {
    if (isPitcher(p)) pitchers.push(p);
    else { hitters.push(p); const t = (p.team || '').toUpperCase(); if (t) teamHitters.set(t, (teamHitters.get(t) || 0) + 1); }
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
  let pitcherInBringBackTeam = false;
  for (const p of pitchers) {
    const t = (p.team || '').toUpperCase();
    if ((p.opponent || '').toUpperCase() === primaryTeam) pitcherFacesPrimaryStack = true;
    if (primaryOpp && t === primaryOpp) pitcherInBringBackTeam = true;
  }
  let logOwnHit = 0; let nh = 0;
  for (const p of hitters) {
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
    salaryStd, salaryTopThree, hitters, pitchers,
    pitcherFacesPrimaryStack, pitcherInBringBackTeam,
  };
}

interface SlateContext {
  // Per-team stats for s1
  teamProj: Map<string, number>;
  teamOwn: Map<string, number>;
  teamProjRank: Map<string, number>;
  teamOwnRank: Map<string, number>;
  // Per-player s2
  s2Player: Map<string, number>;
  // Slate features
  elasticity: number;
  sigmaSlate: number;
  scoringEnv: number;  // S_slate
  // Effective lambdas
  lambdaTeamEff: number;
  pBb: number;
}

function buildSlateContext(players: Player[], chars: LineupChar[], scoringEnv: number, elasticity: number): SlateContext {
  const teamProj = new Map<string, number>();
  const teamOwn = new Map<string, number>();
  const byTeam = new Map<string, Player[]>();
  for (const p of players) {
    if (isPitcher(p)) continue;
    if ((p.projection || 0) < ACTIVE_HITTER_PROJ) continue;
    const t = (p.team || '').toUpperCase();
    if (!t) continue;
    if (!byTeam.has(t)) byTeam.set(t, []);
    byTeam.get(t)!.push(p);
  }
  for (const [t, ps] of byTeam) {
    if (ps.length < 4) continue;
    const top5 = [...ps].sort((a, b) => b.projection - a.projection).slice(0, 5);
    teamProj.set(t, top5.reduce((s, p) => s + p.projection, 0));
    teamOwn.set(t, top5.reduce((s, p) => s + (p.ownership || 0), 0));
  }
  // Percentile ranks
  function pctRank(m: Map<string, number>): Map<string, number> {
    const vals = [...m.entries()].sort((a, b) => a[1] - b[1]);
    const out = new Map<string, number>();
    for (let i = 0; i < vals.length; i++) {
      out.set(vals[i][0], vals.length > 1 ? i / (vals.length - 1) : 0.5);
    }
    return out;
  }
  const teamProjRank = pctRank(teamProj);
  const teamOwnRank = pctRank(teamOwn);

  // s2 per player = projection - LAMBDA_PLAYER * ownership/100  (hitters)
  // For pitchers: use projection - LAMBDA_PLAYER * ownership/100 too (s2_p applied with τ_pitcher)
  const s2Player = new Map<string, number>();
  for (const p of players) {
    const own = p.ownership || 0;
    s2Player.set(p.id, (p.projection || 0) - LAMBDA_PLAYER * own / 100);
  }

  // Effective λ_team: 0.40 − 0.30 · tanh((ε - 0.20)/0.10), clamp [0.10, 0.70]
  const lambdaTeamEff = clip(
    LAMBDA_TEAM_BASE - LAMBDA_TEAM_TILT_MAG * Math.tanh((elasticity - ELASTICITY_PIVOT) / LAMBDA_TEAM_TILT_SCALE),
    LAMBDA_TEAM_MIN, LAMBDA_TEAM_MAX,
  );
  // p_bb = 0.22 + 0.10 · (S_slate − 9)/2; clamp [0.10, 0.35]
  const pBb = clip(P_BB_BASE + P_BB_SCALE * (scoringEnv - P_BB_PIVOT_S) / P_BB_DELTA_DIV, P_BB_MIN, P_BB_MAX);

  return { teamProj, teamOwn, teamProjRank, teamOwnRank, s2Player, elasticity, sigmaSlate: 0, scoringEnv, lambdaTeamEff, pBb };
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

function computeScoringEnv(players: Player[]): number {
  const gameTotals = new Map<string, number>();
  for (const p of players) {
    const t = (p.team || '').toUpperCase(); const o = (p.opponent || '').toUpperCase();
    if (!t || !o) continue;
    const gameId = t < o ? `${t}@${o}` : `${o}@${t}`;
    const gt = (p as any).gameTotal || 0;
    if (gt > 0 && !gameTotals.has(gameId)) gameTotals.set(gameId, gt);
  }
  const gts = [...gameTotals.values()].sort((a, b) => b - a).slice(0, 10);
  if (!gts.length) return P_BB_PIVOT_S;
  // gameTotal is in run-units already (parser yields values 7-12 for MLB game totals).
  // Per Stage 2.5 Amendment 2, no scaling applied.
  return mean(gts);
}

function logSoftmaxFor(score: number, allScores: number[], tau: number): number {
  // log P(item | softmax) = score/τ - log Σ exp(score'/τ)
  const denom = allScores.reduce((s, x) => s + Math.exp(x / tau), 0);
  return score / tau - Math.log(Math.max(1e-12, denom));
}

function scoreBLineup(c: LineupChar, ctx: SlateContext): number | null {
  // Hard reject: pitcher faces own stack OR pitcher in bring-back team
  if (c.pitcherFacesPrimaryStack) return null;
  if (c.pitcherInBringBackTeam) return null;
  if (c.primarySize < MIN_PRIMARY_STACK) return null;

  const t = c.primaryTeam;
  const tRankProj = ctx.teamProjRank.get(t);
  const tRankOwn = ctx.teamOwnRank.get(t);
  if (tRankProj == null || tRankOwn == null) return null;

  // Stage 1: log P(anchor=t)
  const allTeams = [...ctx.teamProj.keys()];
  const allS1 = allTeams.map(team => {
    const rp = ctx.teamProjRank.get(team) || 0;
    const ro = ctx.teamOwnRank.get(team) || 0;
    return rp - ctx.lambdaTeamEff * ro;
  });
  const s1 = tRankProj - ctx.lambdaTeamEff * tRankOwn;
  const logP1 = logSoftmaxFor(s1, allS1, TAU_TEAM);

  // Stage 2: log P(picked-4-hitters | anchor)
  // The 4 hitters from team t in the lineup (if primarySize >= 4): take the 4 anchor-team hitters in c.
  const teamHitters = c.hitters.filter(p => (p.team || '').toUpperCase() === t);
  // This is the actual subset chosen; compute log-likelihood of THIS subset under softmax.
  // For ranking lineups, we approximate as: sum of s2 for chosen / τ_player − 4·log Σ exp(s2/τ) over team's hitters.
  const teamHitterPool = (ctx as any).__teamHitterPool as Map<string, Player[]> | undefined;
  let logP2 = 0;
  if (teamHitterPool && teamHitterPool.has(t)) {
    const pool = teamHitterPool.get(t)!;
    const allS2 = pool.map(p => ctx.s2Player.get(p.id) || 0);
    const denom = allS2.reduce((s, x) => s + Math.exp(x / TAU_PLAYER), 0);
    const chosenIds = new Set(teamHitters.map(p => p.id));
    let chosenSum = 0; let nChosen = 0;
    for (const p of pool) {
      if (chosenIds.has(p.id)) { chosenSum += (ctx.s2Player.get(p.id) || 0); nChosen++; }
    }
    // approximate Plackett-Luce: log P ≈ Σ s_chosen/τ − k·log denom
    logP2 = chosenSum / TAU_PLAYER - nChosen * Math.log(Math.max(1e-12, denom));
  } else {
    // Fallback: just use sum of s2 for chosen team hitters
    logP2 = teamHitters.reduce((s, p) => s + (ctx.s2Player.get(p.id) || 0), 0) / TAU_PLAYER;
  }

  // Stage 3: bring-back log-prob
  const logP3 = c.bringBack >= 1 ? Math.log(ctx.pBb) : Math.log(Math.max(1e-12, 1 - ctx.pBb));

  // Stage 4: pitcher log-likelihood (2 pitchers from active pool, softmax with τ_pitcher)
  const pitcherPool = (ctx as any).__pitcherPool as Player[] | undefined;
  let logP4 = 0;
  if (pitcherPool) {
    const allSP = pitcherPool.map(p => ctx.s2Player.get(p.id) || 0);
    const denomP = allSP.reduce((s, x) => s + Math.exp(x / TAU_PITCHER), 0);
    let chosenSumP = 0; let nP = 0;
    for (const p of c.pitchers) { chosenSumP += (ctx.s2Player.get(p.id) || 0); nP++; }
    logP4 = chosenSumP / TAU_PITCHER - nP * Math.log(Math.max(1e-12, denomP));
  } else {
    logP4 = c.pitchers.reduce((s, p) => s + (ctx.s2Player.get(p.id) || 0), 0) / TAU_PITCHER;
  }

  // Stage 5: filler — any non-anchor non-pitcher non-bringback hitter, scored by s2/τ_player softmax.
  // We approximate by summing s2 of those hitters / τ_player (no normalization needed for ranking purposes since this term varies modestly across lineups with valid roster fills).
  const anchorIds = new Set(teamHitters.map(p => p.id));
  const opp = c.primaryOpp;
  let fillerSum = 0; let nFill = 0;
  for (const h of c.hitters) {
    if (anchorIds.has(h.id)) continue;
    if (opp && (h.team || '').toUpperCase() === opp) continue; // bring-back already counted by p_bb
    fillerSum += (ctx.s2Player.get(h.id) || 0);
    nFill++;
  }
  const logP5 = fillerSum / TAU_PLAYER;

  return logP1 + logP2 + logP3 + logP4 + logP5;
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
  const scoringEnv = computeScoringEnv(pool.players);
  const ctx = buildSlateContext(pool.players, chars, scoringEnv, elasticity);

  // Build per-team active hitter pool & active pitcher pool for log-likelihood normalizers
  const teamHitterPool = new Map<string, Player[]>();
  const pitcherPool: Player[] = [];
  for (const p of pool.players) {
    if (isPitcher(p)) {
      if ((p.projection || 0) >= ACTIVE_PITCHER_PROJ) pitcherPool.push(p);
    } else {
      if ((p.projection || 0) < ACTIVE_HITTER_PROJ) continue;
      const t = (p.team || '').toUpperCase();
      if (!t) continue;
      if (!teamHitterPool.has(t)) teamHitterPool.set(t, []);
      teamHitterPool.get(t)!.push(p);
    }
  }
  (ctx as any).__teamHitterPool = teamHitterPool;
  (ctx as any).__pitcherPool = pitcherPool;

  const t0 = Date.now();
  const scored: { c: LineupChar; score: number }[] = [];
  for (const c of chars) {
    const sc = scoreBLineup(c, ctx);
    if (sc != null && isFinite(sc)) scored.push({ c, score: sc });
  }
  scored.sort((a, b) => b.score - a.score);

  // Deterministic tie-break with seeded RNG: shuffle equal-scored ties (rounded to 4 decimals)
  // Already handled implicitly by sort stability + LCG seed not used at selection; that's OK for B since scores are continuous.
  const selected = scored.slice(0, N).map(s => s.c);
  const elapsed = Date.now() - t0;

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const dkPath = path.join(OUT_DIR, `${slate}_dk.csv`);
  const detPath = path.join(OUT_DIR, `${slate}_detail.csv`);
  exportForDraftKings(selected.map(c => c.lu), config, dkPath);
  writeDetailCSV(selected, scored.slice(0, N).map(s => s.score), detPath);

  console.log(`  [${slate}] cands=${candidates.length} valid=${scored.length} N=${selected.length}/${N} ` +
    `ε=${elasticity.toFixed(3)} S=${scoringEnv.toFixed(2)} λteam=${ctx.lambdaTeamEff.toFixed(2)} pBb=${ctx.pBb.toFixed(3)} ${elapsed}ms`);

  return {
    slate, n: selected.length, elapsed,
    elasticity, scoringEnv, lambdaTeamEff: ctx.lambdaTeamEff, pBb: ctx.pBb,
    poolValid: scored.length, poolTotal: candidates.length,
  };
}

function writeDetailCSV(selected: LineupChar[], scores: number[], outPath: string) {
  const headers = ['rank', 'score', 'primarySize', 'secondarySize', 'primaryTeam', 'primaryOpp', 'bringBack',
    'numGames', 'numTeamsUsed', 'maxGameStack', 'salaryStd', 'salaryTopThree', 'proj', 'geoMeanOwnHit', 'salaryTotal',
    'pitcherFacesStack', 'pitcherInBringBackTeam'];
  const lines = [headers.join(',')];
  for (let i = 0; i < selected.length; i++) {
    const c = selected[i];
    const row = [
      i + 1, (scores[i] || 0).toFixed(3),
      c.primarySize, c.secondarySize, c.primaryTeam, c.primaryOpp, c.bringBack,
      c.numGames, c.numTeamsUsed, c.maxGameStack, c.salaryStd.toFixed(2), c.salaryTopThree,
      c.proj.toFixed(2), c.geoMeanOwnHit.toFixed(3), c.lu.salary,
      c.pitcherFacesPrimaryStack ? 1 : 0, c.pitcherInBringBackTeam ? 1 : 0,
    ];
    lines.push(row.join(','));
  }
  fs.writeFileSync(outPath, lines.join('\n'), 'utf-8');
}

async function main() {
  console.log('='.repeat(64));
  console.log('SLATE-DERIVED FORMULATION B — Hierarchical anchor-then-spread');
  console.log('='.repeat(64));
  console.log(`Running ${DEV_SLATES.length} development slates only.\n`);
  const summary: any[] = [];
  for (const s of DEV_SLATES) {
    const r = await runSlate(s.slate, s.proj, s.pool);
    if (r) summary.push(r);
  }
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'run_summary.json'), JSON.stringify(summary, null, 2), 'utf-8');
  console.log('\nDONE — Formulation B development run.');
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });
