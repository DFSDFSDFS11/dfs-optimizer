/**
 * Deep Research-Based Backtest — measures every lineup-level metric the papers
 * and pros reveal, across all MLB slates.
 *
 * Metrics computed per lineup:
 *   - Salary distribution (Gini, elite/mid/value counts, structure type)
 *   - Batting order (top-of-order count, bottom-of-order exposure)
 *   - Pitcher-opposing hitter alignment (conflict detection)
 *   - Game concentration (HHI, unique games)
 *   - Parimutuel leverage per player
 *   - Within-lineup correlation profile
 *
 * Aggregated per portfolio (pro or V32) and compared cross-slate.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import {
  parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV,
  ContestActuals, ContestEntry,
} from '../parser';
import { getContestConfig } from '../rules';
import {
  DEFAULT_SELECTOR_PARAMS, SelectorParams, defaultGamma, getSportDefaults, precomputeSlate,
} from '../selection/algorithm7-selector';
import { buildV31Context, v31Score } from '../selection/v31-objective';
import { applyConstructedTwins, DEFAULT_CONSTRUCTED_TWIN_PARAMS } from '../selection/constructed-twin';
import { loadRegionMap, computeRegionTargets } from '../analysis/region-map';

const DATA_DIR = 'C:/Users/colin/dfs opto';
const SLATES = [
  { slate: '4-6-26',  proj: '4-6-26_projections.csv',  actuals: 'dkactuals 4-6-26.csv',    pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26',  proj: '4-8-26projections.csv',   actuals: '4-8-26actuals.csv',       pool: '4-8-26sspool.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv',  actuals: '4-12-26actuals.csv',      pool: '4-12-26sspool.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv',  actuals: '4-14-26actuals.csv',      pool: '4-14-26sspool.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv',  actuals: '4-15-26actuals.csv',      pool: '4-15-26sspool.csv' },
  { slate: '4-17-26', proj: '4-17-26projections.csv',  actuals: '4-17-26actuals.csv',      pool: '4-17-26sspool.csv' },
  { slate: '4-18-26', proj: '4-18-26projections.csv',  actuals: '4-18-26actuals.csv',      pool: '4-18-26sspool.csv' },
];

function norm(n: string): string { return (n||'').toLowerCase().replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim(); }
function extractUser(e: string): string { return (e||'').replace(/\s*\([^)]*\)\s*$/,'').trim(); }

// ============================================================
// LINEUP-LEVEL METRICS
// ============================================================

interface LineupMetrics {
  // Salary
  salaryUsed: number;
  salaryRemaining: number;
  salaryGini: number;
  eliteCount: number;      // > $8000
  midCount: number;        // $4500-$8000
  valueCount: number;      // < $4500
  salaryStructure: string;

  // Batting order
  topOfOrderCount: number; // batters in pos 1-4
  bottomOfOrderCount: number; // batters in pos 7-9
  avgBattingOrder: number;

  // Pitcher alignment
  pitcherTeam: string;
  pitcherOpp: string;
  stacksOppOfPitcher: boolean;  // stacks the team facing our pitcher (GOOD)
  ownsOpposingHitters: number;  // hitters facing our own pitcher (BAD — conflict)

  // Game concentration
  uniqueGames: number;
  maxGamePlayers: number;
  gameHHI: number;

  // Stack
  primaryStackTeam: string;
  primaryStackDepth: number;
  hasBringBack: boolean;

  // Ownership
  avgOwnership: number;
  minOwnership: number;
  ownershipProduct: number;
}

function profileLineup(lu: Lineup, salaryCap: number): LineupMetrics {
  const players = lu.players;
  const N = players.length;

  // Salary
  const salaries = players.map(p => p.salary).sort((a, b) => a - b);
  const salaryUsed = salaries.reduce((a, b) => a + b, 0);
  const salaryGini = gini(salaries);
  const eliteCount = salaries.filter(s => s > 8000).length;
  const midCount = salaries.filter(s => s >= 4500 && s <= 8000).length;
  const valueCount = salaries.filter(s => s < 4500).length;
  const salaryStructure = eliteCount >= 2 && valueCount >= 2 ? 'stars_and_value'
    : eliteCount >= 3 ? 'all_studs' : valueCount >= 5 ? 'all_value' : 'balanced';

  // Batting order (MLB: "Order" column in projections, stored on player object)
  const batters = players.filter(p => !p.positions?.includes('P'));
  const orders = batters.map(p => {
    const o = (p as any).order || (p as any).battingOrder || 0;
    return typeof o === 'number' ? o : parseInt(o) || 0;
  }).filter(o => o > 0);
  const topOfOrderCount = orders.filter(o => o >= 1 && o <= 4).length;
  const bottomOfOrderCount = orders.filter(o => o >= 7 && o <= 9).length;
  const avgBattingOrder = orders.length > 0 ? orders.reduce((a, b) => a + b, 0) / orders.length : 5;

  // Pitcher alignment
  const pitcher = players.find(p => p.positions?.includes('P'));
  const pitcherTeam = pitcher?.team || '';
  const pitcherOpp = pitcher?.opponent || '';
  const teamCounts = new Map<string, number>();
  for (const p of batters) teamCounts.set(p.team, (teamCounts.get(p.team) || 0) + 1);
  const stacksOppOfPitcher = pitcherOpp ? (teamCounts.get(pitcherOpp) || 0) >= 3 : false;
  const ownsOpposingHitters = pitcherTeam
    ? batters.filter(p => p.team === pitcherOpp && p.opponent === pitcherTeam).length
    : 0;
  // Actually: "opposing hitters" means hitters who FACE our pitcher = hitters from pitcherOpp team
  // Wait, that's the stack-opp scenario. The conflict is: hitters from OUR PITCHER'S OPPONENT
  // team whose performance is anti-correlated with our pitcher.
  // Actually the real conflict is having a batter who faces your own other pitcher (in 2P lineups).
  // For simplicity: count batters from the team our pitcher faces (pitcherOpp) that are NOT part of a stack.
  // If we stack pitcherOpp (3+ batters), that's intentional. If we have 1-2 stray pitcherOpp batters, that's a conflict.
  const oppBatterCount = pitcherOpp ? (teamCounts.get(pitcherOpp) || 0) : 0;
  const pitcherConflict = (oppBatterCount >= 1 && oppBatterCount <= 2) ? oppBatterCount : 0;

  // Game concentration
  const games = new Map<string, number>();
  for (const p of players) {
    const g = p.gameInfo || `${p.team}@${p.opponent || 'UNK'}`;
    games.set(g, (games.get(g) || 0) + 1);
  }
  const uniqueGames = games.size;
  let maxGamePlayers = 0;
  for (const c of games.values()) if (c > maxGamePlayers) maxGamePlayers = c;
  let gameHHI = 0;
  for (const c of games.values()) gameHHI += (c / N) * (c / N);

  // Stack
  let stackTeam = '', stackDepth = 0;
  for (const [t, c] of teamCounts) if (c > stackDepth) { stackDepth = c; stackTeam = t; }
  const stackOpp = batters.find(p => p.team === stackTeam)?.opponent;
  const hasBringBack = stackOpp ? batters.some(p => p.team === stackOpp) : false;

  // Ownership
  const owns = players.map(p => (p.ownership || 0) / 100);
  const avgOwnership = owns.reduce((a, b) => a + b, 0) / N;
  const minOwnership = Math.min(...owns);
  let prod = 1; for (const o of owns) prod *= Math.max(0.001, o);

  return {
    salaryUsed, salaryRemaining: salaryCap - salaryUsed, salaryGini,
    eliteCount, midCount, valueCount, salaryStructure,
    topOfOrderCount, bottomOfOrderCount, avgBattingOrder,
    pitcherTeam, pitcherOpp, stacksOppOfPitcher,
    ownsOpposingHitters: pitcherConflict,
    uniqueGames, maxGamePlayers, gameHHI,
    primaryStackTeam: stackTeam, primaryStackDepth: stackDepth, hasBringBack,
    avgOwnership, minOwnership, ownershipProduct: prod,
  };
}

// ============================================================
// PORTFOLIO AGGREGATE
// ============================================================

interface PortfolioProfile {
  name: string;
  slate: string;
  entries: number;
  top1Hits: number; top1Rate: number;
  top5Hits: number; cashHits: number; cashRate: number;
  avgActual: number; bestActual: number;

  // Aggregated lineup metrics (means)
  avgSalaryUsed: number; avgSalaryRemaining: number; avgSalaryGini: number;
  avgEliteCount: number; avgMidCount: number; avgValueCount: number;
  salaryStructureDist: Map<string, number>;
  avgTopOfOrder: number; avgBottomOfOrder: number; avgBattingOrder: number;
  pitcherConflictRate: number;  // % lineups with opposing-hitter conflict
  stacksOppOfPitcherRate: number;
  avgUniqueGames: number; avgGameHHI: number;
  avgStackDepth: number; bringBackRate: number;
  avgOwnership: number; avgOwnershipProduct: number;

  // Portfolio-level
  uniqueStackTeams: number;
  avgPairOverlap: number;
  maxExposure: number;
  maxExpPlayer: string;
}

function buildPortfolioProfile(
  name: string, slate: string, lineups: Lineup[], entries: ContestEntry[],
  thresholds: { top1: number; top5: number; cash: number },
  actuals: ContestActuals, salaryCap: number, allPlayerMap: Map<string, Player>,
): PortfolioProfile {
  const N = lineups.length;
  const profiles = lineups.map(l => profileLineup(l, salaryCap));

  // Score against actuals
  let t1 = 0, t5 = 0, cash = 0, sumAct = 0, bestAct = 0;
  for (const e of entries) {
    if (e.actualPoints >= thresholds.top1) t1++;
    if (e.actualPoints >= thresholds.top5) t5++;
    if (e.actualPoints >= thresholds.cash) cash++;
    sumAct += e.actualPoints;
    if (e.actualPoints > bestAct) bestAct = e.actualPoints;
  }

  const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  // Salary structure distribution
  const structDist = new Map<string, number>();
  for (const p of profiles) structDist.set(p.salaryStructure, (structDist.get(p.salaryStructure) || 0) + 1);
  for (const [k, v] of structDist) structDist.set(k, v / N);

  // Portfolio-level: stacks, overlap, exposure
  const stackTeams = new Set<string>();
  const expCount = new Map<string, number>();
  for (const l of lineups) {
    for (const p of l.players) expCount.set(p.id, (expCount.get(p.id) || 0) + 1);
    const tc = new Map<string, number>();
    for (const p of l.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
    for (const [t, c] of tc) if (c >= 4) stackTeams.add(t);
  }
  let maxExp = 0, maxExpId = '';
  for (const [id, c] of expCount) { const f = c / N; if (f > maxExp) { maxExp = f; maxExpId = id; } }

  // Pair overlap (sample 300)
  let overlapSum = 0, overlapCount = 0;
  let seed = 7;
  const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };
  for (let p = 0; p < Math.min(300, N * (N - 1) / 2); p++) {
    const i = Math.floor(rng() * N); let j = Math.floor(rng() * (N - 1)); if (j >= i) j++;
    const si = new Set(lineups[i].players.map(x => x.id));
    let sh = 0; for (const x of lineups[j].players) if (si.has(x.id)) sh++;
    overlapSum += sh; overlapCount++;
  }

  return {
    name, slate, entries: N,
    top1Hits: t1, top1Rate: N > 0 ? t1 / N : 0,
    top5Hits: t5, cashHits: cash, cashRate: N > 0 ? cash / N : 0,
    avgActual: entries.length > 0 ? sumAct / entries.length : 0, bestActual: bestAct,
    avgSalaryUsed: avg(profiles.map(p => p.salaryUsed)),
    avgSalaryRemaining: avg(profiles.map(p => p.salaryRemaining)),
    avgSalaryGini: avg(profiles.map(p => p.salaryGini)),
    avgEliteCount: avg(profiles.map(p => p.eliteCount)),
    avgMidCount: avg(profiles.map(p => p.midCount)),
    avgValueCount: avg(profiles.map(p => p.valueCount)),
    salaryStructureDist: structDist,
    avgTopOfOrder: avg(profiles.map(p => p.topOfOrderCount)),
    avgBottomOfOrder: avg(profiles.map(p => p.bottomOfOrderCount)),
    avgBattingOrder: avg(profiles.map(p => p.avgBattingOrder)),
    pitcherConflictRate: profiles.filter(p => p.ownsOpposingHitters > 0).length / N,
    stacksOppOfPitcherRate: profiles.filter(p => p.stacksOppOfPitcher).length / N,
    avgUniqueGames: avg(profiles.map(p => p.uniqueGames)),
    avgGameHHI: avg(profiles.map(p => p.gameHHI)),
    avgStackDepth: avg(profiles.map(p => p.primaryStackDepth)),
    bringBackRate: profiles.filter(p => p.hasBringBack).length / N,
    avgOwnership: avg(profiles.map(p => p.avgOwnership)) * 100,
    avgOwnershipProduct: avg(profiles.map(p => p.ownershipProduct)),
    uniqueStackTeams: stackTeams.size,
    avgPairOverlap: overlapCount > 0 ? overlapSum / overlapCount : 0,
    maxExposure: maxExp,
    maxExpPlayer: allPlayerMap.get(maxExpId)?.name || maxExpId,
  };
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  const regionMap = loadRegionMap('C:/Users/colin/dfs opto/region-map-mlb-dk.json');
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const fmt = (v: number, d = 1) => v.toFixed(d);

  // Collect all profiles
  const allProProfiles: PortfolioProfile[] = [];
  const allV32Profiles: PortfolioProfile[] = [];
  const allWinnerProfiles: PortfolioProfile[] = [];

  for (const s of SLATES) {
    const projPath = path.join(DATA_DIR, s.proj);
    const actualsPath = path.join(DATA_DIR, s.actuals);
    const poolPath = path.join(DATA_DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) { console.log(`skip ${s.slate}`); continue; }

    console.log(`\n=== ${s.slate} ===`);
    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);
    const nameMap = new Map<string, Player>(); for (const p of pool.players) nameMap.set(norm(p.name), p);
    const idMap = new Map<string, Player>(); for (const p of pool.players) idMap.set(p.id, p);

    const F = actuals.entries.length;
    const sorted = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
    const tAt = (f: number) => sorted[Math.max(0, Math.floor(F * f) - 1)] || 0;
    const thresholds = { top1: tAt(0.01), top5: tAt(0.05), cash: tAt(0.20) };

    // Build lineups from entries
    const resolveEntry = (e: ContestEntry): Lineup | null => {
      const pls: Player[] = []; let ok = true;
      for (const n of e.playerNames) { const p = nameMap.get(norm(n)); if (!p) { ok = false; break; } pls.push(p); }
      if (!ok || pls.length < 8) return null;
      return { players: pls, salary: pls.reduce((sm, p) => sm + p.salary, 0), projection: pls.reduce((sm, p) => sm + p.projection, 0), ownership: pls.reduce((sm, p) => sm + (p.ownership || 0), 0) / pls.length, hash: pls.map(p => p.id).sort().join('|') };
    };

    // Profile every 150-entry pro
    const byUser = new Map<string, ContestEntry[]>();
    for (const e of actuals.entries) { const u = extractUser(e.entryName); if (u) { const a = byUser.get(u); if (a) a.push(e); else byUser.set(u, [e]); } }

    for (const [username, entries] of byUser) {
      if (entries.length < 140) continue;
      const lineups = entries.map(resolveEntry).filter((l): l is Lineup => l !== null);
      if (lineups.length < 100) continue;
      const profile = buildPortfolioProfile(username, s.slate, lineups, entries, thresholds, actuals, config.salaryCap, idMap);
      allProProfiles.push(profile);
    }

    // Profile top-1% winners
    const winnerEntries = actuals.entries.filter(e => e.actualPoints >= thresholds.top1);
    const winnerLineups = winnerEntries.map(resolveEntry).filter((l): l is Lineup => l !== null);
    if (winnerLineups.length > 0) {
      const wp = buildPortfolioProfile('top1_winners', s.slate, winnerLineups, winnerEntries, thresholds, actuals, config.salaryCap, idMap);
      allWinnerProfiles.push(wp);
    }

    // Run V32 on this slate
    const fieldLineups: Lineup[] = []; const seenH = new Set<string>(); const actualByHash = new Map<string, number>();
    for (const e of actuals.entries) { const l = resolveEntry(e); if (!l) continue; if (seenH.has(l.hash)) continue; seenH.add(l.hash); fieldLineups.push(l); actualByHash.set(l.hash, e.actualPoints); }
    const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
    const selParams: SelectorParams = { ...DEFAULT_SELECTOR_PARAMS, ...getSportDefaults('mlb'), N: 150, gamma: defaultGamma(config.rosterSize), numWorlds: 1500 };
    const precomp = precomputeSlate(loaded.lineups, fieldLineups, pool.players, selParams, 'mlb');
    const ctx = buildV31Context(precomp, fieldLineups, pool.players);

    // Region-targeted V32 selection
    const poolCoords = loaded.lineups.map(l => ({ projection: l.projection, ownership: l.players.reduce((sm: number, p: Player) => sm + (p.ownership || 0), 0) / l.players.length }));
    const poolDist = new Map<string, number>();
    for (const c of poolCoords) { const pB = findBin(c.projection, regionMap.projBins); const oB = findBin(c.ownership, regionMap.ownBins); poolDist.set(`${pB}_${oB}`, (poolDist.get(`${pB}_${oB}`) || 0) + 1); }
    const feasCells = new Map(regionMap.cells); for (const [k] of feasCells) if ((poolDist.get(k) || 0) < 5) feasCells.delete(k);
    const targets = computeRegionTargets({ ...regionMap, cells: feasCells }, 150, 'weighted_lift', 1.0);
    const candCoords = Array.from({ length: precomp.C }, (_, c) => ({ idx: c, projection: precomp.candidatePool[c].projection, ownership: precomp.candidatePool[c].players.reduce((sm: number, p: Player) => sm + (p.ownership || 0), 0) / precomp.candidatePool[c].players.length }));
    const v32Sel: Lineup[] = []; const v32H = new Set<string>(); const v32Exp = new Map<string, number>(); const expCap = Math.ceil(0.40 * 150);
    const sortedAlloc = [...targets.allocations.entries()].sort((a, b) => { const ca = regionMap.cells.get(a[0]), cb = regionMap.cells.get(b[0]); const dA = ca ? Math.abs((ca.projRange[0]+ca.projRange[1])/2-regionMap.top1Centroid.projection)/10+Math.abs((ca.ownRange[0]+ca.ownRange[1])/2-regionMap.top1Centroid.ownership)/5 : 99; const dB = cb ? Math.abs((cb.projRange[0]+cb.projRange[1])/2-regionMap.top1Centroid.projection)/10+Math.abs((cb.ownRange[0]+cb.ownRange[1])/2-regionMap.top1Centroid.ownership)/5 : 99; return dA-dB; });
    for (const [key, tc] of sortedAlloc) { const cell = regionMap.cells.get(key); if (!cell) continue; const rc = candCoords.filter(c => c.projection>=cell.projRange[0]&&c.projection<cell.projRange[1]&&c.ownership>=cell.ownRange[0]&&c.ownership<cell.ownRange[1]).map(c => ({...c, score: v31Score(c.idx, ctx, precomp, 0.3, 0.3)})).sort((a, b) => b.score-a.score); let filled = 0; for (const cand of rc) { if (filled>=tc) break; const lu=precomp.candidatePool[cand.idx]; if (v32H.has(lu.hash)) continue; let ok=true; for (const p of lu.players) if ((v32Exp.get(p.id)||0)>=expCap){ok=false;break;} if (!ok) continue; v32Sel.push(lu); v32H.add(lu.hash); for (const p of lu.players) v32Exp.set(p.id,(v32Exp.get(p.id)||0)+1); filled++; } }
    if (v32Sel.length<150) { const all32 = candCoords.map(c => ({...c, score: v31Score(c.idx, ctx, precomp, 0.3, 0.3)})).sort((a, b) => b.score-a.score); for (const c of all32) { if (v32Sel.length>=150) break; const lu=precomp.candidatePool[c.idx]; if (v32H.has(lu.hash)) continue; let ok=true; for (const p of lu.players) if ((v32Exp.get(p.id)||0)>=expCap){ok=false;break;} if (!ok) continue; v32Sel.push(lu); v32H.add(lu.hash); for (const p of lu.players) v32Exp.set(p.id,(v32Exp.get(p.id)||0)+1); } }
    const twin = applyConstructedTwins(v32Sel, pool.players, precomp, config);
    const v32F = twin.portfolio;

    // Score V32
    const v32Entries: ContestEntry[] = v32F.map((l, i) => {
      const a = actualByHash.get(l.hash); let score = a !== undefined ? a : 0;
      if (a === undefined) { for (const p of l.players) { const r = actuals.playerActualsByName.get(norm(p.name)); if (r) score += r.fpts; } }
      return { rank: 0, entryId: `v32_${i}`, entryName: 'V32', actualPoints: score, playerNames: l.players.map(p => p.name) };
    });
    const v32Profile = buildPortfolioProfile('V32', s.slate, v32F, v32Entries, thresholds, actuals, config.salaryCap, idMap);
    allV32Profiles.push(v32Profile);
    console.log(`  V32: t1=${v32Profile.top1Hits} cash=${v32Profile.cashHits}/${v32Profile.entries}`);
  }

  // ─── BUILD REPORT ───
  let md = `# Deep Research-Based Backtest — ${SLATES.length} MLB Slates\n\n`;

  // Cross-slate pro aggregation (≥3 slates)
  const proAgg = new Map<string, PortfolioProfile[]>();
  for (const p of allProProfiles) { const a = proAgg.get(p.name); if (a) a.push(p); else proAgg.set(p.name, [p]); }
  const rankedPros = [...proAgg.entries()].filter(([, v]) => v.length >= 3)
    .sort((a, b) => avg(b[1].map(p => p.top1Rate)) - avg(a[1].map(p => p.top1Rate)));

  // Compute metric averages for top-10 pros and V32
  const top10Pros = rankedPros.slice(0, 10);
  const metrics = [
    'avgSalaryRemaining', 'avgSalaryGini', 'avgEliteCount', 'avgMidCount', 'avgValueCount',
    'avgTopOfOrder', 'avgBottomOfOrder', 'avgBattingOrder',
    'pitcherConflictRate', 'stacksOppOfPitcherRate',
    'avgUniqueGames', 'avgGameHHI',
    'avgStackDepth', 'bringBackRate',
    'avgOwnership', 'uniqueStackTeams', 'avgPairOverlap', 'maxExposure',
  ] as const;

  type MetricKey = typeof metrics[number];
  const proMetricAvg = new Map<MetricKey, number>();
  const v32MetricAvg = new Map<MetricKey, number>();
  const winnerMetricAvg = new Map<MetricKey, number>();

  for (const m of metrics) {
    const proVals = top10Pros.flatMap(([, ps]) => ps.map(p => (p as any)[m] as number));
    proMetricAvg.set(m, avg(proVals));
    v32MetricAvg.set(m, avg(allV32Profiles.map(p => (p as any)[m] as number)));
    winnerMetricAvg.set(m, avg(allWinnerProfiles.map(p => (p as any)[m] as number)));
  }

  md += `## Lineup-Level Metric Comparison: Top-10 Pros vs V32 vs Winners\n\n`;
  md += `| Metric | Top-1% Winners | Top-10 Pros | V32 | Gap (Pro-V32) | Verdict |\n`;
  md += `|---|---:|---:|---:|---:|---|\n`;
  for (const m of metrics) {
    const wv = winnerMetricAvg.get(m) || 0;
    const pv = proMetricAvg.get(m) || 0;
    const vv = v32MetricAvg.get(m) || 0;
    const gap = pv - vv;
    const isPercent = m.includes('Rate') || m === 'avgOwnership' || m === 'maxExposure';
    const fmtVal = (v: number) => isPercent ? pct(v) : fmt(v, 2);
    const verdict = Math.abs(gap) < (isPercent ? 0.03 : 0.3) ? '✓ match' : gap > 0 ? '⚠ pro higher' : '⚠ V32 higher';
    md += `| ${m} | ${fmtVal(wv)} | ${fmtVal(pv)} | ${fmtVal(vv)} | ${gap >= 0 ? '+' : ''}${isPercent ? (gap * 100).toFixed(1) + 'pp' : fmt(gap)} | ${verdict} |\n`;
  }
  md += `\n`;

  // Salary structure distribution
  md += `## Salary Structure Distribution\n\n`;
  md += `| Structure | Top-10 Pros | V32 | Winners |\n|---|---:|---:|---:|\n`;
  const structures = ['stars_and_value', 'balanced', 'all_studs', 'all_value'];
  for (const st of structures) {
    const proRate = avg(top10Pros.flatMap(([, ps]) => ps.map(p => p.salaryStructureDist.get(st) || 0)));
    const v32Rate = avg(allV32Profiles.map(p => p.salaryStructureDist.get(st) || 0));
    const winRate = avg(allWinnerProfiles.map(p => p.salaryStructureDist.get(st) || 0));
    md += `| ${st} | ${pct(proRate)} | ${pct(v32Rate)} | ${pct(winRate)} |\n`;
  }
  md += `\n`;

  // Per-slate breakdown for top 3 pros + V32
  md += `## Per-Slate Deep Metrics — skijmb vs V32\n\n`;
  const skijmbProfiles = proAgg.get('skijmb') || [];
  if (skijmbProfiles.length > 0) {
    md += `| Slate | | Top1% | SalRem | SalGini | Elite | TopOrd | BotOrd | PitcherConf | StackOppP | Games | GameHHI | BringBack |\n`;
    md += `|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n`;
    for (const s of SLATES) {
      const sp = skijmbProfiles.find(p => p.slate === s.slate);
      const vp = allV32Profiles.find(p => p.slate === s.slate);
      if (sp) md += `| ${s.slate} | skijmb | ${pct(sp.top1Rate)} | $${fmt(sp.avgSalaryRemaining, 0)} | ${fmt(sp.avgSalaryGini, 3)} | ${fmt(sp.avgEliteCount)} | ${fmt(sp.avgTopOfOrder)} | ${fmt(sp.avgBottomOfOrder)} | ${pct(sp.pitcherConflictRate)} | ${pct(sp.stacksOppOfPitcherRate)} | ${fmt(sp.avgUniqueGames)} | ${fmt(sp.avgGameHHI, 3)} | ${pct(sp.bringBackRate)} |\n`;
      if (vp) md += `| | V32 | ${pct(vp.top1Rate)} | $${fmt(vp.avgSalaryRemaining, 0)} | ${fmt(vp.avgSalaryGini, 3)} | ${fmt(vp.avgEliteCount)} | ${fmt(vp.avgTopOfOrder)} | ${fmt(vp.avgBottomOfOrder)} | ${pct(vp.pitcherConflictRate)} | ${pct(vp.stacksOppOfPitcherRate)} | ${fmt(vp.avgUniqueGames)} | ${fmt(vp.avgGameHHI, 3)} | ${pct(vp.bringBackRate)} |\n`;
    }
  }
  md += `\n`;

  // Ranked gaps by absolute effect size
  md += `## Ranked Gaps (sorted by magnitude)\n\n`;
  const gaps = metrics.map(m => {
    const pv = proMetricAvg.get(m) || 0;
    const vv = v32MetricAvg.get(m) || 0;
    const isPercent = m.includes('Rate') || m === 'avgOwnership' || m === 'maxExposure';
    const normalizedGap = isPercent ? Math.abs(pv - vv) * 100 : Math.abs(pv - vv) / Math.max(0.01, Math.abs(pv));
    return { metric: m, proVal: pv, v32Val: vv, gap: pv - vv, normalizedGap, isPercent };
  }).sort((a, b) => b.normalizedGap - a.normalizedGap);

  md += `| Rank | Metric | Pro | V32 | Gap | Actionable? |\n|---:|---|---:|---:|---:|---|\n`;
  for (let i = 0; i < gaps.length; i++) {
    const g = gaps[i];
    const fmtV = (v: number) => g.isPercent ? pct(v) : fmt(v, 2);
    md += `| ${i + 1} | ${g.metric} | ${fmtV(g.proVal)} | ${fmtV(g.v32Val)} | ${g.gap >= 0 ? '+' : ''}${g.isPercent ? (g.gap * 100).toFixed(1) + 'pp' : fmt(g.gap)} | |\n`;
  }
  md += `\n`;

  const outPath = path.join(DATA_DIR, 'deep_backtest_report.md');
  fs.writeFileSync(outPath, md);
  console.log(`\n✓ Report: ${outPath}`);
}

function gini(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  let cum = 0, sum = 0;
  for (let i = 0; i < n; i++) { cum += (i + 1) * sorted[i]; sum += sorted[i]; }
  if (sum === 0) return 0;
  return (2 * cum) / (n * sum) - (n + 1) / n;
}

function avg(arr: number[]): number { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

function findBin(value: number, bins: number[]): number { for (let i = bins.length-1; i >= 0; i--) if (value >= bins[i]) return i; return 0; }

main();
