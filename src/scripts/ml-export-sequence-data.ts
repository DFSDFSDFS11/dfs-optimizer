/**
 * Export per-pro-portfolio sequence data for set transformer training.
 *
 * For each pro × slate:
 *   - Extract their 150 lineups
 *   - Sort by total projection DESC (deterministic surrogate for submission order)
 *   - Compute per-lineup features (re-using the 35 features from prior ML export)
 *
 * Output:
 *   - sequence_lineups.csv: one row per pro-slate-lineup with order index + features + label
 *   - candidate_pool.csv: one row per (slate, lineup) with features (used as negative pool)
 *   - slate_features.csv: per-slate context (8 features)
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import {
  parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals,
} from '../parser';
import { getContestConfig } from '../rules';

const DIR = 'C:/Users/colin/dfs opto';
const OUT_DIR = 'C:/Users/colin/Projects/dfs-optimizer/ml_set_transformer';

const HELD_OUT = new Set(['4-8-26', '4-21-26', '4-19-26', '4-24-26']);

const SLATES = [
  { slate: '4-6-26',  proj: '4-6-26_projections.csv', actuals: 'dkactuals 4-6-26.csv', pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26',  proj: '4-8-26projections.csv',  actuals: '4-8-26actuals.csv',    pool: '4-8-26sspool.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv', actuals: '4-12-26actuals.csv',   pool: '4-12-26sspool.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv', actuals: '4-14-26actuals.csv',   pool: '4-14-26sspool.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv', actuals: '4-15-26actuals.csv',   pool: '4-15-26sspool.csv' },
  { slate: '4-17-26', proj: '4-17-26projections.csv', actuals: '4-17-26actuals.csv',   pool: '4-17-26sspool.csv' },
  { slate: '4-18-26', proj: '4-18-26projections.csv', actuals: '4-18-26actuals.csv',   pool: '4-18-26sspool.csv' },
  { slate: '4-19-26', proj: '4-19-26projections.csv', actuals: '4-19-26actuals.csv',   pool: '4-19-26sspool.csv' },
  { slate: '4-20-26', proj: '4-20-26projections.csv', actuals: '4-20-26actuals.csv',   pool: '4-20-26sspool.csv' },
  { slate: '4-21-26', proj: '4-21-26projections.csv', actuals: '4-21-26actuals.csv',   pool: '4-21-26sspool.csv' },
  { slate: '4-22-26', proj: '4-22-26projections.csv', actuals: '4-22-26actuals.csv',   pool: '4-22-26sspool.csv' },
  { slate: '4-23-26', proj: '4-23-26projections.csv', actuals: '4-23-26actuals.csv',   pool: '4-23-26sspool.csv' },
  { slate: '4-24-26', proj: '4-24-26projections.csv', actuals: '4-24-26actuals.csv',   pool: '4-24-26sspool.csv' },
  { slate: '4-25-26', proj: '4-25-26projections.csv', actuals: '4-25-26actuals.csv',   pool: '4-25-26sspool.csv' },
  { slate: '4-25-26-early', proj: '4-25-26projectionsearly.csv', actuals: '4-25-26actualsearly.csv', pool: '4-25-26sspoolearly.csv' },
  { slate: '4-26-26', proj: '4-26-26projections.csv', actuals: '4-26-26actuals.csv', pool: '4-26-26sspool.csv' },
  { slate: '4-27-26', proj: '4-27-26projections.csv', actuals: '4-27-26actuals.csv', pool: '4-27-26sspool.csv' },
  { slate: '4-28-26', proj: '4-28-26projections.csv', actuals: '4-28-26actuals.csv', pool: '4-28-26sspool.csv' },
];

const PROS = [
  { label: 'nerdytenor', tokens: ['nerdytenor'] },
  { label: 'zroth', tokens: ['zroth', 'zroth2'] },
  { label: 'youdacao', tokens: ['youdacao'] },
  { label: 'shipmymoney', tokens: ['shipmymoney'] },
  { label: 'shaidyadvice', tokens: ['shaidyadvice'] },
  { label: 'bgreseth', tokens: ['bgreseth'] },
  { label: 'needlunchmoney', tokens: ['needlunchmoney'] },
];

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function mean(a: number[]): number { if (!a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; }
function stddev(a: number[]): number { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); }
function skewness(a: number[]): number {
  if (a.length < 3) return 0;
  const m = mean(a); const s = stddev(a); if (s < 1e-9) return 0;
  return a.reduce((sum, x) => sum + Math.pow((x - m) / s, 3), 0) / a.length;
}

interface SlateContext {
  optProj: number; optCeil: number;
  projRanksByPid: Map<string, number>;
  ownRanksByPid: Map<string, number>;
  salaryRanksByPid: Map<string, number>;
  valueRanksByPid: Map<string, number>;
  anchorOwn: number;
  ownPctileByPid: Map<string, number>;
  teamOwnRank: Map<string, number>;
  // Slate-level features
  nGames: number; nTeams: number; slateAvgOwn: number;
}

function buildSlateContext(players: Player[], allLineups: Lineup[]): SlateContext {
  const viable = players.filter(p => (p.projection || 0) > 0 && (p.ownership || 0) > 0);
  const sortedProj = [...viable].sort((a, b) => (a.projection || 0) - (b.projection || 0));
  const sortedOwn = [...viable].sort((a, b) => (a.ownership || 0) - (b.ownership || 0));
  const sortedSal = [...viable].sort((a, b) => (a.salary || 0) - (b.salary || 0));
  const sortedVal = [...viable].sort((a, b) => ((a.projection || 0) / Math.max(1, a.salary || 1)) - ((b.projection || 0) / Math.max(1, b.salary || 1)));
  const projRanks = new Map<string, number>();
  const ownRanks = new Map<string, number>();
  const salaryRanks = new Map<string, number>();
  const valueRanks = new Map<string, number>();
  for (let i = 0; i < sortedProj.length; i++) projRanks.set(sortedProj[i].id, i / Math.max(1, sortedProj.length - 1));
  for (let i = 0; i < sortedOwn.length; i++) ownRanks.set(sortedOwn[i].id, i / Math.max(1, sortedOwn.length - 1));
  for (let i = 0; i < sortedSal.length; i++) salaryRanks.set(sortedSal[i].id, i / Math.max(1, sortedSal.length - 1));
  for (let i = 0; i < sortedVal.length; i++) valueRanks.set(sortedVal[i].id, i / Math.max(1, sortedVal.length - 1));
  let optProj = 0, optCeil = 0;
  for (const lu of allLineups) {
    if (lu.projection > optProj) optProj = lu.projection;
    let c = 0; for (const p of lu.players) c += (p as any).ceiling || (p.projection || 0) * 1.4;
    if (c > optCeil) optCeil = c;
  }
  const anchor = [...allLineups].sort((a, b) => b.projection - a.projection).slice(0, 50);
  const anchorOwn = mean(anchor.map(lu => mean(lu.players.map(p => p.ownership || 0))));
  const teamOwn = new Map<string, number>();
  for (const p of players) {
    if (p.positions?.includes('P')) continue;
    teamOwn.set(p.team, (teamOwn.get(p.team) || 0) + (p.ownership || 0));
  }
  const sortedTeams = [...teamOwn.entries()].sort((a, b) => a[1] - b[1]);
  const teamOwnRank = new Map<string, number>();
  for (let i = 0; i < sortedTeams.length; i++) teamOwnRank.set(sortedTeams[i][0], i / Math.max(1, sortedTeams.length - 1));
  const ownPctileByPid = new Map<string, number>();
  for (let i = 0; i < sortedOwn.length; i++) ownPctileByPid.set(sortedOwn[i].id, i / Math.max(1, sortedOwn.length - 1));
  const teamSet = new Set<string>(players.map(p => p.team));
  return {
    optProj, optCeil,
    projRanksByPid: projRanks, ownRanksByPid: ownRanks, salaryRanksByPid: salaryRanks, valueRanksByPid: valueRanks,
    anchorOwn, ownPctileByPid, teamOwnRank,
    nGames: Math.floor(teamSet.size / 2), nTeams: teamSet.size,
    slateAvgOwn: mean(players.map(p => p.ownership || 0)),
  };
}

function classifyArchetype(p: Player, ctx: SlateContext): { isLeverage: boolean; isValue: boolean; isChalkStud: boolean; isPunt: boolean; isTrap: boolean } {
  const projR = ctx.projRanksByPid.get(p.id) || 0;
  const ownR = ctx.ownRanksByPid.get(p.id) || 0;
  const salR = ctx.salaryRanksByPid.get(p.id) || 0;
  const valR = ctx.valueRanksByPid.get(p.id) || 0;
  return {
    isLeverage: projR >= 0.7 && ownR <= 0.3,
    isValue: valR >= 0.5 && salR <= 0.5,
    isChalkStud: salR >= 0.8 && ownR >= 0.8,
    isPunt: salR <= 0.15 && valR >= 0.5,
    isTrap: ownR >= 0.7 && valR <= 0.3,
  };
}

function computeFeatures(lu: Lineup, ctx: SlateContext): number[] {
  const players = lu.players;
  const owns = players.map(p => p.ownership || 0);
  const proj = players.reduce((s, p) => s + (p.projection || 0), 0);
  const totalSalary = players.reduce((s, p) => s + (p.salary || 0), 0);
  const ceiling = players.reduce((s, p) => s + ((p as any).ceiling || (p.projection || 0) * 1.4), 0);
  const floor = players.reduce((s, p) => s + ((p as any).floor || (p.projection || 0) * 0.6), 0);
  const meanOwn = mean(owns);
  const teamCounts = new Map<string, number>();
  let pitcherTeam = '', pitcherTotalSalary = 0, pitcherTotalOwn = 0;
  const hitterSalaries: number[] = [];
  for (const p of players) {
    if (p.positions?.includes('P')) {
      pitcherTeam = pitcherTeam || p.team;
      pitcherTotalSalary += p.salary || 0;
      pitcherTotalOwn += p.ownership || 0;
    } else {
      teamCounts.set(p.team, (teamCounts.get(p.team) || 0) + 1);
      hitterSalaries.push(p.salary || 0);
    }
  }
  const sortedTeams = [...teamCounts.entries()].sort((a, b) => b[1] - a[1]);
  const primaryStackSize = sortedTeams[0]?.[1] || 0;
  const primaryTeam = sortedTeams[0]?.[0] || '';
  const secondaryStackSize = sortedTeams[1]?.[1] || 0;
  const has33 = primaryStackSize === 3 && secondaryStackSize === 3 ? 1 : 0;
  const has43 = primaryStackSize === 4 && secondaryStackSize === 3 ? 1 : 0;
  const has5 = primaryStackSize >= 5 ? 1 : 0;
  const pitcherTeamInStacks = pitcherTeam && teamCounts.has(pitcherTeam) ? 1 : 0;
  const primaryStackTeamOwnRank = ctx.teamOwnRank.get(primaryTeam) || 0;
  let leverage = 0, value = 0, chalkStud = 0, punt = 0, trap = 0;
  for (const p of players) {
    const a = classifyArchetype(p, ctx);
    if (a.isLeverage) leverage++; if (a.isValue) value++; if (a.isChalkStud) chalkStud++; if (a.isPunt) punt++; if (a.isTrap) trap++;
  }
  let maxPairCoOwn = 0;
  for (let i = 0; i < players.length; i++) for (let j = i + 1; j < players.length; j++) {
    const co = (players[i].ownership || 0) + (players[j].ownership || 0);
    if (co > maxPairCoOwn) maxPairCoOwn = co;
  }
  let pctileSum = 0; for (const p of players) pctileSum += ctx.ownPctileByPid.get(p.id) || 0;

  return [
    proj, totalSalary, owns.reduce((s, x) => s + x, 0), meanOwn, stddev(owns), ceiling, floor,
    ctx.optProj > 0 ? proj / ctx.optProj : 0, meanOwn - ctx.anchorOwn, ctx.optCeil > 0 ? ceiling / ctx.optCeil : 0,
    totalSalary > 0 ? proj / totalSalary * 1000 : 0, pctileSum / players.length,
    primaryStackSize, primaryStackTeamOwnRank, secondaryStackSize, has33, has43, has5, pitcherTeamInStacks,
    owns.filter(o => o >= 25).length, owns.filter(o => o <= 5).length,
    Math.max(...owns), Math.min(...owns), skewness(owns),
    leverage, value, chalkStud, punt, trap,
    maxPairCoOwn, pitcherTotalSalary, pitcherTotalOwn, stddev(hitterSalaries),
  ];
}

function extractPro(actuals: ContestActuals, nameMap: Map<string, Player>, tokens: string[]): Player[][] {
  const out: Player[][] = [];
  for (const e of actuals.entries) {
    const en = (e.entryName || '').toLowerCase();
    if (!tokens.some(t => en.includes(t))) continue;
    const pls: Player[] = []; let ok = true;
    for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
    if (ok) out.push(pls);
  }
  return out;
}

const FEATURE_NAMES = [
  'total_projection', 'total_salary', 'total_ownership', 'mean_ownership',
  'ownership_stddev_within_lineup', 'total_ceiling', 'total_floor',
  'projection_ratio_to_optimal', 'ownership_delta_from_anchor', 'ceiling_ratio_to_max',
  'salary_efficiency', 'avg_player_ownership_percentile',
  'primary_stack_size', 'primary_stack_team_ownership_rank', 'secondary_stack_size',
  'has_3_3_split', 'has_4_3_split', 'has_5_stack', 'pitcher_team_in_stacks',
  'num_players_above_25_own', 'num_players_below_5_own',
  'max_single_player_ownership', 'min_single_player_ownership', 'ownership_skewness',
  'count_leverage_spots', 'count_value_plays', 'count_chalk_studs', 'count_punt_plays', 'count_trap_plays',
  'max_pairwise_player_co_ownership', 'pitcher_total_salary', 'pitcher_total_ownership', 'hitter_salary_stddev',
];

const SLATE_FEATURE_NAMES = [
  'slate_n_games', 'slate_n_teams', 'slate_anchor_own', 'slate_optimal_proj',
  'slate_avg_player_own', 'slate_optimal_ceil', 'slate_size_small', 'slate_size_large',
];

async function main() {
  console.log('=== Sequence Data Export for Set Transformer ===');
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  // Output streams
  const seqRows: string[] = [['slate', 'pro', 'order_index', 'lineup_hash', 'is_holdout', ...FEATURE_NAMES].join(',')];
  const candRows: string[] = [['slate', 'lineup_hash', ...FEATURE_NAMES].join(',')];
  const slateRows: string[] = [['slate', 'is_holdout', ...SLATE_FEATURE_NAMES].join(',')];

  let totalSeq = 0, totalCand = 0;

  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj), actualsPath = path.join(DIR, s.actuals), poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) { console.log('  ' + s.slate + ' SKIP'); continue; }
    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);
    const idMap = new Map<string, Player>(); const nameMap = new Map<string, Player>();
    for (const p of pool.players) { idMap.set(p.id, p); nameMap.set(norm(p.name), p); }
    const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
    const ctx = buildSlateContext(pool.players, loaded.lineups);
    const isHoldout = HELD_OUT.has(s.slate) ? 1 : 0;

    // Slate features
    slateRows.push([
      s.slate, isHoldout,
      ctx.nGames, ctx.nTeams, ctx.anchorOwn.toFixed(4), ctx.optProj.toFixed(2),
      ctx.slateAvgOwn.toFixed(4), ctx.optCeil.toFixed(2),
      ctx.nTeams <= 14 ? 1 : 0, ctx.nTeams >= 22 ? 1 : 0,
    ].join(','));

    // Sequence rows: each pro's portfolio sorted by projection desc
    let nSeqSlate = 0;
    for (const p of PROS) {
      const lus = extractPro(actuals, nameMap, p.tokens);
      if (lus.length < 30) continue;
      // Build proper Lineup objects + dedupe + sort by projection desc
      const luObjs: Lineup[] = lus.map(playerLu => ({
        players: playerLu,
        projection: playerLu.reduce((s, pl) => s + (pl.projection || 0), 0),
        salary: playerLu.reduce((s, pl) => s + (pl.salary || 0), 0),
        ownership: playerLu.reduce((s, pl) => s + (pl.ownership || 0), 0) / playerLu.length,
        hash: playerLu.map(pl => pl.id).sort().join('|'),
      }));
      // Dedupe by hash (a pro might submit duplicates)
      const seen = new Set<string>();
      const unique = luObjs.filter(lu => { if (seen.has(lu.hash)) return false; seen.add(lu.hash); return true; });
      // Sort by projection desc (deterministic submission-order surrogate)
      unique.sort((a, b) => b.projection - a.projection);
      for (let i = 0; i < unique.length; i++) {
        const lu = unique[i];
        const feats = computeFeatures(lu, ctx);
        seqRows.push([s.slate, p.label, i, lu.hash, isHoldout, ...feats.map(v => Number.isInteger(v) ? v.toString() : v.toFixed(6))].join(','));
        nSeqSlate++;
        totalSeq++;
      }
    }

    // Candidate pool: ALL lineups in SaberSim pool (used as negative pool source)
    let nCand = 0;
    for (const lu of loaded.lineups) {
      const feats = computeFeatures(lu, ctx);
      candRows.push([s.slate, lu.hash, ...feats.map(v => Number.isInteger(v) ? v.toString() : v.toFixed(6))].join(','));
      nCand++;
      totalCand++;
    }
    console.log('  ' + s.slate.padEnd(15) + ' seq=' + nSeqSlate.toString().padStart(5) + ' cand=' + nCand.toString().padStart(6) + (isHoldout ? '  [HELD-OUT]' : ''));
  }

  fs.writeFileSync(path.join(OUT_DIR, 'sequence_lineups.csv'), seqRows.join('\n'));
  fs.writeFileSync(path.join(OUT_DIR, 'candidate_pool.csv'), candRows.join('\n'));
  fs.writeFileSync(path.join(OUT_DIR, 'slate_features.csv'), slateRows.join('\n'));
  fs.writeFileSync(path.join(OUT_DIR, 'feature_names.json'), JSON.stringify({ lineup: FEATURE_NAMES, slate: SLATE_FEATURE_NAMES }, null, 2));

  console.log('');
  console.log('TOTAL: ' + totalSeq + ' sequence rows, ' + totalCand + ' candidate rows');
  console.log('Saved to ' + OUT_DIR);
}

main().catch(e => { console.error(e); process.exit(1); });
