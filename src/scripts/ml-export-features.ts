/**
 * Export per-lineup features + label for ML training.
 *
 * For each slate:
 *   - Positive examples: every pro lineup (with multiplicity = # pros who used it)
 *   - Negative examples: 5,000 lineups from SaberSim pool that NO pro played
 *
 * Output: ml_lineup_classifier/training_data.csv (one row per lineup-slate)
 *
 * Held-out slates are flagged but still exported (for Stage 4 use).
 * Train scripts MUST filter by is_holdout=False during Stages 1-3.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import {
  parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals,
} from '../parser';
import { getContestConfig } from '../rules';

const DIR = 'C:/Users/colin/dfs opto';
const OUT_DIR = 'C:/Users/colin/Projects/dfs-optimizer/ml_lineup_classifier';

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
  poolProjs: number[]; poolOwns: number[]; poolSalaries: number[];
  // Player-level quintiles for archetype classification
  projRanksByPid: Map<string, number>;
  ownRanksByPid: Map<string, number>;
  salaryRanksByPid: Map<string, number>;
  valueRanksByPid: Map<string, number>; // proj/salary
  // Anchor (top-50 lineups by projection)
  anchorOwn: number;
  // Slate avg pitcher own
  pitcherOwnByTeam: Map<string, number>;
  // Per-player ownership percentile
  ownPctileByPid: Map<string, number>;
  // Team aggregate ownership ranks for stack rank lookup
  teamOwnRank: Map<string, number>;
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

  // Optimal lineup proj/ceiling = max in pool
  let optProj = 0, optCeil = 0;
  for (const lu of allLineups) {
    if (lu.projection > optProj) optProj = lu.projection;
    let c = 0;
    for (const p of lu.players) c += (p as any).ceiling || (p.projection || 0) * 1.4;
    if (c > optCeil) optCeil = c;
  }

  // Anchor: top-50 lineups by projection
  const anchor = [...allLineups].sort((a, b) => b.projection - a.projection).slice(0, 50);
  const anchorOwn = mean(anchor.map(lu => mean(lu.players.map(p => p.ownership || 0))));

  // Team total ownership for rank
  const teamOwn = new Map<string, number>();
  for (const p of players) {
    if (p.positions?.includes('P')) continue;
    teamOwn.set(p.team, (teamOwn.get(p.team) || 0) + (p.ownership || 0));
  }
  const sortedTeams = [...teamOwn.entries()].sort((a, b) => a[1] - b[1]);
  const teamOwnRank = new Map<string, number>();
  for (let i = 0; i < sortedTeams.length; i++) teamOwnRank.set(sortedTeams[i][0], i / Math.max(1, sortedTeams.length - 1));

  // Pitcher own by team
  const pitcherOwnByTeam = new Map<string, number>();
  for (const p of players) {
    if (p.positions?.includes('P')) {
      const cur = pitcherOwnByTeam.get(p.team) || 0;
      if ((p.ownership || 0) > cur) pitcherOwnByTeam.set(p.team, p.ownership || 0);
    }
  }

  // Player ownership percentile (cumulative rank)
  const ownPctileByPid = new Map<string, number>();
  for (let i = 0; i < sortedOwn.length; i++) ownPctileByPid.set(sortedOwn[i].id, i / Math.max(1, sortedOwn.length - 1));

  return {
    optProj, optCeil,
    poolProjs: sortedProj.map(p => p.projection || 0),
    poolOwns: sortedOwn.map(p => p.ownership || 0),
    poolSalaries: sortedSal.map(p => p.salary || 0),
    projRanksByPid: projRanks,
    ownRanksByPid: ownRanks,
    salaryRanksByPid: salaryRanks,
    valueRanksByPid: valueRanks,
    anchorOwn,
    pitcherOwnByTeam,
    ownPctileByPid,
    teamOwnRank,
  };
}

interface FeatureRow {
  lineup_hash: string;
  slate: string;
  is_holdout: number;
  label: number;
  pro_count: number; // multiplicity
  // Aggregate
  total_projection: number;
  total_salary: number;
  total_ownership: number;
  mean_ownership: number;
  ownership_stddev_within_lineup: number;
  total_ceiling: number;
  total_floor: number;
  // Slate-relative
  projection_ratio_to_optimal: number;
  ownership_delta_from_anchor: number;
  ceiling_ratio_to_max: number;
  salary_efficiency: number;
  avg_player_ownership_percentile: number;
  // Stack
  primary_stack_size: number;
  primary_stack_team_ownership_rank: number;
  secondary_stack_size: number;
  has_3_3_split: number;
  has_4_3_split: number;
  has_5_stack: number;
  pitcher_team_in_stacks: number;
  // Ownership distribution
  num_players_above_25_own: number;
  num_players_below_5_own: number;
  max_single_player_ownership: number;
  min_single_player_ownership: number;
  ownership_skewness: number;
  // Player archetype counts
  count_leverage_spots: number;
  count_value_plays: number;
  count_chalk_studs: number;
  count_punt_plays: number;
  count_trap_plays: number;
  // Pairwise (simplified)
  max_pairwise_player_co_ownership: number;
  // Position-level
  pitcher_total_salary: number;
  pitcher_total_ownership: number;
  hitter_salary_stddev: number;
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

function computeFeatures(lu: Lineup, ctx: SlateContext, slate: string, isHoldout: boolean, label: number, proCount: number): FeatureRow {
  const players = lu.players;
  const owns = players.map(p => p.ownership || 0);
  const proj = players.reduce((s, p) => s + (p.projection || 0), 0);
  const totalSalary = players.reduce((s, p) => s + (p.salary || 0), 0);
  const ceiling = players.reduce((s, p) => s + ((p as any).ceiling || (p.projection || 0) * 1.4), 0);
  const floor = players.reduce((s, p) => s + ((p as any).floor || (p.projection || 0) * 0.6), 0);
  const meanOwn = mean(owns);

  // Stack analysis
  const teamCounts = new Map<string, number>();
  let pitcherTeam = '';
  let pitcherTotalSalary = 0; let pitcherTotalOwn = 0;
  const hitterSalaries: number[] = [];
  for (const p of players) {
    if (p.positions?.includes('P')) {
      pitcherTeam = pitcherTeam || p.team; // first pitcher's team
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

  // Archetype counts
  let leverage = 0, value = 0, chalkStud = 0, punt = 0, trap = 0;
  for (const p of players) {
    const a = classifyArchetype(p, ctx);
    if (a.isLeverage) leverage++;
    if (a.isValue) value++;
    if (a.isChalkStud) chalkStud++;
    if (a.isPunt) punt++;
    if (a.isTrap) trap++;
  }

  // Pairwise co-ownership (max of any pair)
  let maxPairCoOwn = 0;
  for (let i = 0; i < players.length; i++) for (let j = i + 1; j < players.length; j++) {
    const co = (players[i].ownership || 0) + (players[j].ownership || 0);
    if (co > maxPairCoOwn) maxPairCoOwn = co;
  }

  // Player ownership percentile avg
  let pctileSum = 0; for (const p of players) pctileSum += ctx.ownPctileByPid.get(p.id) || 0;

  return {
    lineup_hash: lu.hash,
    slate, is_holdout: isHoldout ? 1 : 0, label, pro_count: proCount,
    total_projection: proj,
    total_salary: totalSalary,
    total_ownership: owns.reduce((s, x) => s + x, 0),
    mean_ownership: meanOwn,
    ownership_stddev_within_lineup: stddev(owns),
    total_ceiling: ceiling,
    total_floor: floor,
    projection_ratio_to_optimal: ctx.optProj > 0 ? proj / ctx.optProj : 0,
    ownership_delta_from_anchor: meanOwn - ctx.anchorOwn,
    ceiling_ratio_to_max: ctx.optCeil > 0 ? ceiling / ctx.optCeil : 0,
    salary_efficiency: totalSalary > 0 ? proj / totalSalary * 1000 : 0,
    avg_player_ownership_percentile: pctileSum / players.length,
    primary_stack_size: primaryStackSize,
    primary_stack_team_ownership_rank: primaryStackTeamOwnRank,
    secondary_stack_size: secondaryStackSize,
    has_3_3_split: has33,
    has_4_3_split: has43,
    has_5_stack: has5,
    pitcher_team_in_stacks: pitcherTeamInStacks,
    num_players_above_25_own: owns.filter(o => o >= 25).length,
    num_players_below_5_own: owns.filter(o => o <= 5).length,
    max_single_player_ownership: Math.max(...owns),
    min_single_player_ownership: Math.min(...owns),
    ownership_skewness: skewness(owns),
    count_leverage_spots: leverage,
    count_value_plays: value,
    count_chalk_studs: chalkStud,
    count_punt_plays: punt,
    count_trap_plays: trap,
    max_pairwise_player_co_ownership: maxPairCoOwn,
    pitcher_total_salary: pitcherTotalSalary,
    pitcher_total_ownership: pitcherTotalOwn,
    hitter_salary_stddev: stddev(hitterSalaries),
  };
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

async function main() {
  console.log('=== ML Feature Export ===');
  console.log('Held-out slates:', [...HELD_OUT].join(', '));
  console.log('');

  const allRows: FeatureRow[] = [];
  let totalPositives = 0; let totalNegatives = 0;

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
    const isHoldout = HELD_OUT.has(s.slate);

    // Positive lineups: deduplicate by hash, multiplicity = #pros who used
    const posByHash = new Map<string, { lu: Player[]; proSet: Set<string> }>();
    for (const p of PROS) {
      const lus = extractPro(actuals, nameMap, p.tokens);
      for (const playerLu of lus) {
        const h = playerLu.map(pl => pl.id).sort().join('|');
        if (!posByHash.has(h)) posByHash.set(h, { lu: playerLu, proSet: new Set() });
        posByHash.get(h)!.proSet.add(p.label);
      }
    }
    let nPos = 0;
    const posHashSet = new Set<string>();
    for (const [h, info] of posByHash) {
      // Build a Lineup-like object
      const lu: Lineup = {
        players: info.lu,
        projection: info.lu.reduce((s, p) => s + (p.projection || 0), 0),
        salary: info.lu.reduce((s, p) => s + (p.salary || 0), 0),
        ownership: info.lu.reduce((s, p) => s + (p.ownership || 0), 0) / info.lu.length,
        hash: h,
      };
      allRows.push(computeFeatures(lu, ctx, s.slate, isHoldout, 1, info.proSet.size));
      nPos++;
      posHashSet.add(h);
    }

    // Negative lineups: top 5000 by projection, exclude positive hashes, sample if more
    const sortedByProj = [...loaded.lineups].sort((a, b) => b.projection - a.projection).slice(0, 5000);
    const eligibleNeg = sortedByProj.filter(lu => !posHashSet.has(lu.hash));
    const targetNeg = Math.min(5000, eligibleNeg.length);
    let negLineups = eligibleNeg;
    if (eligibleNeg.length > 5000) {
      // Reservoir sample 5000
      negLineups = eligibleNeg.slice(0, 5000);
      for (let i = 5000; i < eligibleNeg.length; i++) {
        const j = Math.floor(Math.random() * (i + 1));
        if (j < 5000) negLineups[j] = eligibleNeg[i];
      }
    }
    let nNeg = 0;
    for (const lu of negLineups) {
      allRows.push(computeFeatures(lu, ctx, s.slate, isHoldout, 0, 0));
      nNeg++;
    }

    totalPositives += nPos;
    totalNegatives += nNeg;
    console.log('  ' + s.slate.padEnd(15) + ' pos=' + nPos.toString().padStart(4) + ' neg=' + nNeg.toString().padStart(5) + (isHoldout ? '  [HELD-OUT]' : ''));
  }

  console.log('');
  console.log('TOTAL: ' + totalPositives + ' positives, ' + totalNegatives + ' negatives');

  // Write CSV
  const headers = Object.keys(allRows[0]);
  const lines = [headers.join(',')];
  for (const r of allRows) {
    lines.push(headers.map(h => {
      const v = (r as any)[h];
      if (typeof v === 'number') return Number.isInteger(v) ? v.toString() : v.toFixed(6);
      return v;
    }).join(','));
  }
  const outPath = path.join(OUT_DIR, 'training_data.csv');
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log('\nSaved ' + allRows.length + ' rows to ' + outPath);

  // Also export per-pro labels for cross-pro validation
  const perProRows: Array<{ slate: string; lineup_hash: string; pro: string }> = [];
  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj), actualsPath = path.join(DIR, s.actuals);
    if (!fs.existsSync(projPath) || !fs.existsSync(actualsPath)) continue;
    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);
    const nameMap = new Map<string, Player>();
    for (const p of pool.players) nameMap.set(norm(p.name), p);
    for (const p of PROS) {
      const lus = extractPro(actuals, nameMap, p.tokens);
      for (const playerLu of lus) {
        const h = playerLu.map(pl => pl.id).sort().join('|');
        perProRows.push({ slate: s.slate, lineup_hash: h, pro: p.label });
      }
    }
  }
  const proPath = path.join(OUT_DIR, 'pro_lineups.csv');
  fs.writeFileSync(proPath, 'slate,lineup_hash,pro\n' + perProRows.map(r => `${r.slate},${r.lineup_hash},${r.pro}`).join('\n'));
  console.log('Saved ' + perProRows.length + ' pro-lineup labels to ' + proPath);

  // hash is now first column of FeatureRow — already exported above
}

main().catch(e => { console.error(e); process.exit(1); });
