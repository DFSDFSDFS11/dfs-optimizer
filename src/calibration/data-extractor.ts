/**
 * DFS Optimizer CLI - Pro Data Extraction & Combo Analysis Pipeline
 *
 * Extracts structured CSV data from historical slates:
 *   1. pro_entries.csv    — Every pro entry with full player/formula detail
 *   2. pro_combos.csv     — Aggregated 2/3/4/5-man combos from pro entries
 *   3. field_summary.csv  — Per-slate field stats
 *
 * Usage:
 *   node dist/run.js --extract-data --data ./historical_slates --sport nba --site dk
 */

import * as fs from 'fs';
import * as path from 'path';
import { Player, Lineup, Sport, DFSSite } from '../types';
import {
  findSlates, loadProjections, loadActuals, processSlate,
  scoreLineup, computeTotalScore,
  ComponentScores, ScoredEntry, ContestEntry, PlayerData, SlateResult,
} from './backtester';
import { OptimizedWeights } from '../selection/selector';

// ============================================================
// TRACKED PROS (same list as backtester.ts)
// ============================================================

const TRACKED_PROS = [
  // Tier 1: 8-9/9 slates (most consistent)
  'zroth', 'zroth2', 'bpcologna', 'bgreseth', 'skijmb', 'oxenduck', 'invertedcheese',
  // Tier 2: 6-7/9 slates
  'ocdobv', 'moklovin', 'shipmymoney', 'awen419', 'beaker913', 'westonselman',
  'onedropking', 'kszng', 'idlove2win', 'slimbomangler', 'austinturner773',
  // Tier 3: 5/9 slates
  'shaidyadvice', 'cheddabisque', 'lozingitall', 'hixx', 'fjbourne',
  'sullybrochill', 'xmalachi', 'giantsquid', 'mazwa', 'btmboss2',
  'sbcousle', 'jpm11', 'royalpain21', 'hebrewcheetah', 'cjcashing',
  // Tier 4: 4/9 slates
  'rsbathla', 'narendra22', 'jdm68a', 'aarondp987', 'hurliss', 'b_heals152',
];

function isTrackedPro(username: string): boolean {
  const lower = username.toLowerCase();
  return TRACKED_PROS.some(p => lower === p || lower.startsWith(p));
}

// ============================================================
// COMBO TRACKING TYPES
// ============================================================

interface ComboStats {
  count: number;
  countTop1Pct: number;
  countField: number;          // -1 for 4/5-man (too expensive to compute)
  totalActual: number;
  totalRankPct: number;
  totalComboOwn: number;
  totalComboProj: number;
  slates: Set<string>;
  sameGame: boolean;
  sameTeam: boolean;
}

interface ProEntryRow {
  slateDate: string;
  username: string;
  rank: number;
  percentile: number;
  points: number;
  totalEntries: number;
  totalSalary: number;
  totalProjection: number;
  totalActual: number;
  geoMeanOwn: number;
  sumOwn: number;
  players: Array<{
    name: string;
    team: string;
    pos: string;
    salary: number;
    proj: number;
    own: number;
    actual: number;
    game: string;
  }>;
  stackPattern: string;
  maxStackSize: number;
  hasBringback: boolean;
  bbCount: number;
  primaryStackGame: string;
  components: ComponentScores;
  totalScore: number;
}

interface FieldSummaryRow {
  slateDate: string;
  totalEntries: number;
  playerCount: number;
  gameCount: number;
  avgPoints: number;
  medianPoints: number;
  p99Points: number;
  winnerPoints: number;
  avgSalary: number;
  avgOwn: number;
  avgProjection: number;
  proEntryCount: number;
  proAvgRankPct: number;
  proTop1Count: number;
}

// ============================================================
// STACKING ANALYSIS
// ============================================================

function analyzeStacking(lineup: Lineup): {
  stackPattern: string;
  maxStackSize: number;
  hasBringback: boolean;
  bbCount: number;
  primaryStackGame: string;
} {
  // Group players by game
  const gameGroups = new Map<string, { teams: Map<string, number>; count: number }>();
  for (const p of lineup.players) {
    const gameId = p.gameInfo || `${p.team}_game`;
    if (!gameGroups.has(gameId)) {
      gameGroups.set(gameId, { teams: new Map(), count: 0 });
    }
    const group = gameGroups.get(gameId)!;
    group.count++;
    group.teams.set(p.team, (group.teams.get(p.team) || 0) + 1);
  }

  // Sort game groups by count descending
  const sorted = [...gameGroups.entries()].sort((a, b) => b[1].count - a[1].count);

  // Stack pattern: counts per game, e.g., "4-2-1-1"
  const stackPattern = sorted.map(([, g]) => g.count).join('-');

  // Max stack = largest game group
  const maxStackSize = sorted.length > 0 ? sorted[0][1].count : 0;

  // Primary stack game
  const primaryStackGame = sorted.length > 0 ? sorted[0][0] : '';

  // Bringback: game with 2+ teams represented (each with 1+ player)
  let bbCount = 0;
  let hasBringback = false;
  for (const [, group] of gameGroups) {
    if (group.teams.size >= 2) {
      hasBringback = true;
      // Count the number of bringback players (players on the minority team)
      const teamCounts = [...group.teams.values()].sort((a, b) => b - a);
      // Sum all teams except the primary = bringback count
      for (let i = 1; i < teamCounts.length; i++) {
        bbCount += teamCounts[i];
      }
    }
  }

  return { stackPattern, maxStackSize, hasBringback, bbCount, primaryStackGame };
}

// ============================================================
// COMBO ENUMERATION
// ============================================================

function* combinations<T>(arr: T[], k: number): Generator<T[]> {
  if (k === 0) { yield []; return; }
  if (k > arr.length) return;
  for (let i = 0; i <= arr.length - k; i++) {
    for (const rest of combinations(arr.slice(i + 1), k - 1)) {
      yield [arr[i], ...rest];
    }
  }
}

function makeComboKey(playerNames: string[]): string {
  return playerNames.slice().sort().join('|');
}

function checkSameGame(players: Player[]): boolean {
  if (players.length < 2) return true;
  const game = players[0].gameInfo || `${players[0].team}_game`;
  return players.every(p => (p.gameInfo || `${p.team}_game`) === game);
}

function checkSameTeam(players: Player[]): boolean {
  if (players.length < 2) return true;
  return players.every(p => p.team === players[0].team);
}

// ============================================================
// CSV WRITING HELPERS
// ============================================================

function escapeCSV(val: string | number | boolean): string {
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function writeCSV(filePath: string, headers: string[], rows: (string | number | boolean)[][]): void {
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(row.map(escapeCSV).join(','));
  }
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
}

// ============================================================
// MAIN EXTRACTION
// ============================================================

export async function runDataExtraction(
  dataDir: string,
  sport: Sport,
  site: DFSSite,
): Promise<void> {
  console.log('\n========================================');
  console.log('DATA EXTRACTION PIPELINE');
  console.log('========================================');
  console.log(`Data dir: ${dataDir}`);
  console.log(`Sport: ${sport}, Site: ${site}`);

  const startTime = Date.now();

  // Discover slates
  const slates = findSlates(dataDir);
  console.log(`\nFound ${slates.length} slates`);

  if (slates.length === 0) {
    console.error('No slate pairs found. Need {date}_projections.csv + {date}_actuals.csv');
    return;
  }

  // Output accumulators
  const proEntryRows: ProEntryRow[] = [];
  const fieldSummaryRows: FieldSummaryRow[] = [];
  const comboMap = new Map<string, ComboStats>();
  const proComboKeys2 = new Set<string>();  // Track which 2-man combos pros use
  const proComboKeys3 = new Set<string>();  // Track which 3-man combos pros use

  // Process each slate sequentially (memory management)
  for (const slate of slates) {
    console.log(`\n--- Processing ${slate.date} ---`);

    // Use processSlate to score all entries
    const result = await processSlate(dataDir, slate);
    if (!result) {
      console.log(`  Skipped (no data)`);
      continue;
    }

    // Load player data for actual scores
    const players = loadProjections(dataDir, slate.projFile);

    // Count games
    const gameSet = new Set<string>();
    for (const [, pd] of players) {
      if (pd.gameInfo) gameSet.add(pd.gameInfo);
    }
    const gameCount = gameSet.size > 0 ? gameSet.size : Math.ceil(players.size / 10);

    // Separate pro entries vs all entries
    const proEntries: ScoredEntry[] = [];
    const allEntries: ScoredEntry[] = [];

    for (const se of result.scoredEntries) {
      if (se.lineup) {
        allEntries.push(se);
        if (isTrackedPro(se.entry.username)) {
          proEntries.push(se);
        }
      }
    }

    console.log(`  ${allEntries.length} matched entries, ${proEntries.length} pro entries`);

    // --- Pro Entries ---
    for (const se of proEntries) {
      const lineup = se.lineup!;
      const stacking = analyzeStacking(lineup);

      // Geometric mean ownership
      let ownershipProduct = 1;
      let sumOwn = 0;
      for (const p of lineup.players) {
        ownershipProduct *= Math.max(0.1, p.ownership) / 100;
        sumOwn += p.ownership;
      }
      const geoMeanOwn = Math.pow(ownershipProduct, 1 / lineup.players.length) * 100;

      // Compute actual points from player data
      let totalActual = 0;
      const playerRows: ProEntryRow['players'] = [];
      for (const p of lineup.players) {
        const pd = players.get(p.name.toLowerCase());
        const actual = pd?.actual || 0;
        totalActual += actual;
        playerRows.push({
          name: p.name,
          team: p.team,
          pos: p.position,
          salary: p.salary,
          proj: p.projection,
          own: p.ownership,
          actual,
          game: p.gameInfo || '',
        });
      }

      proEntryRows.push({
        slateDate: slate.date,
        username: se.entry.username,
        rank: se.entry.rank,
        percentile: se.actualPercentile,
        points: se.entry.points,
        totalEntries: result.totalEntries,
        totalSalary: lineup.salary,
        totalProjection: lineup.projection,
        totalActual,
        geoMeanOwn,
        sumOwn,
        players: playerRows,
        ...stacking,
        components: se.components,
        totalScore: se.totalScore,
      });

      // Accumulate combos (2/3/4/5-man)
      const isTop1Pct = se.actualPercentile >= 99;
      for (let comboSize = 2; comboSize <= 5; comboSize++) {
        for (const combo of combinations(lineup.players, comboSize)) {
          const key = makeComboKey(combo.map(p => p.name));
          const comboOwn = combo.reduce((s, p) => s + p.ownership, 0);
          const comboProj = combo.reduce((s, p) => s + p.projection, 0);

          if (!comboMap.has(key)) {
            comboMap.set(key, {
              count: 0,
              countTop1Pct: 0,
              countField: comboSize <= 3 ? 0 : -1,
              totalActual: 0,
              totalRankPct: 0,
              totalComboOwn: 0,
              totalComboProj: 0,
              slates: new Set(),
              sameGame: checkSameGame(combo),
              sameTeam: checkSameTeam(combo),
            });
          }
          const stats = comboMap.get(key)!;
          stats.count++;
          if (isTop1Pct) stats.countTop1Pct++;
          stats.totalActual += se.entry.points;
          stats.totalRankPct += se.actualPercentile;
          stats.totalComboOwn += comboOwn;
          stats.totalComboProj += comboProj;
          stats.slates.add(slate.date);

          if (comboSize === 2) proComboKeys2.add(key);
          if (comboSize === 3) proComboKeys3.add(key);
        }
      }
    }

    // --- Field combo frequency (2/3-man only, for combos that pros use) ---
    console.log(`  Computing field frequency for ${proComboKeys2.size} 2-man + ${proComboKeys3.size} 3-man combos...`);
    for (const se of allEntries) {
      const lineup = se.lineup!;
      const playerNames = lineup.players.map(p => p.name);

      // 2-man combos
      for (let i = 0; i < playerNames.length; i++) {
        for (let j = i + 1; j < playerNames.length; j++) {
          const key = [playerNames[i], playerNames[j]].sort().join('|');
          if (proComboKeys2.has(key)) {
            const stats = comboMap.get(key);
            if (stats) stats.countField++;
          }
        }
      }

      // 3-man combos
      for (let i = 0; i < playerNames.length; i++) {
        for (let j = i + 1; j < playerNames.length; j++) {
          for (let k = j + 1; k < playerNames.length; k++) {
            const key = [playerNames[i], playerNames[j], playerNames[k]].sort().join('|');
            if (proComboKeys3.has(key)) {
              const stats = comboMap.get(key);
              if (stats) stats.countField++;
            }
          }
        }
      }
    }

    // --- Field Summary ---
    const points = allEntries.map(se => se.entry.points).sort((a, b) => a - b);
    const salaries = allEntries.filter(se => se.lineup).map(se => se.lineup!.salary);
    const projections = allEntries.filter(se => se.lineup).map(se => se.lineup!.projection);
    const ownerships = allEntries.filter(se => se.lineup).map(se => se.lineup!.ownership);

    const median = points.length > 0 ? points[Math.floor(points.length / 2)] : 0;
    const p99Idx = Math.floor(points.length * 0.99);
    const p99 = points.length > 0 ? points[Math.min(p99Idx, points.length - 1)] : 0;

    const proRankPcts = proEntries.map(se => se.actualPercentile);
    const proTop1 = proEntries.filter(se => se.actualPercentile >= 99).length;

    fieldSummaryRows.push({
      slateDate: slate.date,
      totalEntries: result.totalEntries,
      playerCount: players.size,
      gameCount,
      avgPoints: points.length > 0 ? points.reduce((s, v) => s + v, 0) / points.length : 0,
      medianPoints: median,
      p99Points: p99,
      winnerPoints: points.length > 0 ? points[points.length - 1] : 0,
      avgSalary: salaries.length > 0 ? salaries.reduce((s, v) => s + v, 0) / salaries.length : 0,
      avgOwn: ownerships.length > 0 ? ownerships.reduce((s, v) => s + v, 0) / ownerships.length : 0,
      avgProjection: projections.length > 0 ? projections.reduce((s, v) => s + v, 0) / projections.length : 0,
      proEntryCount: proEntries.length,
      proAvgRankPct: proRankPcts.length > 0 ? proRankPcts.reduce((s, v) => s + v, 0) / proRankPcts.length : 0,
      proTop1Count: proTop1,
    });

    console.log(`  Done. ${proEntryRows.length} total pro entries so far.`);
  }

  // ============================================================
  // WRITE CSVs
  // ============================================================

  const outputDir = path.join(path.dirname(dataDir), 'data_export');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // --- CSV 1: pro_entries.csv ---
  const maxPlayers = 8; // DK NBA Classic
  const proHeaders: string[] = [
    'slate_date', 'username', 'rank', 'percentile', 'points', 'total_entries',
    'total_salary', 'total_projection', 'total_actual', 'geo_mean_own', 'sum_own',
  ];
  for (let i = 1; i <= maxPlayers; i++) {
    proHeaders.push(`p${i}_name`, `p${i}_team`, `p${i}_pos`, `p${i}_salary`, `p${i}_proj`, `p${i}_own`, `p${i}_actual`, `p${i}_game`);
  }
  proHeaders.push(
    'stack_pattern', 'max_stack_size', 'has_bringback', 'bb_count', 'primary_stack_game',
    'formula_score', 'proj_score', 'ceil_score', 'var_score', 'sal_eff_score',
    'rel_val_score', 'game_stack_score', 'ceil_ratio_score', 'game_env_score',
  );

  const proRows: (string | number | boolean)[][] = [];
  for (const row of proEntryRows) {
    const r: (string | number | boolean)[] = [
      row.slateDate, row.username, row.rank,
      +row.percentile.toFixed(2), +row.points.toFixed(2), row.totalEntries,
      row.totalSalary, +row.totalProjection.toFixed(2), +row.totalActual.toFixed(2),
      +row.geoMeanOwn.toFixed(3), +row.sumOwn.toFixed(2),
    ];
    // Player columns (pad to maxPlayers)
    for (let i = 0; i < maxPlayers; i++) {
      if (i < row.players.length) {
        const p = row.players[i];
        r.push(p.name, p.team, p.pos, p.salary, +p.proj.toFixed(2), +p.own.toFixed(2), +p.actual.toFixed(2), p.game);
      } else {
        r.push('', '', '', 0, 0, 0, 0, '');
      }
    }
    r.push(
      row.stackPattern, row.maxStackSize, row.hasBringback, row.bbCount, row.primaryStackGame,
      +row.totalScore.toFixed(4),
      +row.components.projectionScore.toFixed(4),
      +row.components.ceilingScore.toFixed(4),
      +row.components.varianceScore.toFixed(4),
      +row.components.salaryEfficiencyScore.toFixed(4),
      +row.components.relativeValueScore.toFixed(4),
      +row.components.gameStackScore.toFixed(4),
      +row.components.ceilingRatioScore.toFixed(4),
      +row.components.gameEnvironmentScore.toFixed(4),
    );
    proRows.push(r);
  }

  const proPath = path.join(outputDir, 'pro_entries.csv');
  writeCSV(proPath, proHeaders, proRows);
  console.log(`\nWrote ${proRows.length} pro entries to ${proPath}`);

  // --- CSV 2: pro_combos.csv ---
  const comboHeaders = [
    'combo_size', 'player_names', 'count', 'count_top1pct', 'count_field',
    'avg_actual', 'avg_rank_pct', 'avg_combo_own', 'avg_combo_proj',
    'slate_count', 'same_game', 'same_team',
  ];

  const comboRows: (string | number | boolean)[][] = [];
  for (const [key, stats] of comboMap) {
    const names = key.split('|');
    comboRows.push([
      names.length,
      key,
      stats.count,
      stats.countTop1Pct,
      stats.countField,
      +(stats.totalActual / stats.count).toFixed(2),
      +(stats.totalRankPct / stats.count).toFixed(2),
      +(stats.totalComboOwn / stats.count).toFixed(2),
      +(stats.totalComboProj / stats.count).toFixed(2),
      stats.slates.size,
      stats.sameGame,
      stats.sameTeam,
    ]);
  }

  // Sort by count descending
  comboRows.sort((a, b) => (b[2] as number) - (a[2] as number));

  const comboPath = path.join(outputDir, 'pro_combos.csv');
  writeCSV(comboPath, comboHeaders, comboRows);
  console.log(`Wrote ${comboRows.length} combos to ${comboPath}`);

  // --- CSV 3: field_summary.csv ---
  const fieldHeaders = [
    'slate_date', 'total_entries', 'player_count', 'game_count',
    'avg_points', 'median_points', 'p99_points', 'winner_points',
    'avg_salary', 'avg_own', 'avg_projection',
    'pro_entry_count', 'pro_avg_rank_pct', 'pro_top1_count',
  ];

  const fieldRows: (string | number | boolean)[][] = [];
  for (const row of fieldSummaryRows) {
    fieldRows.push([
      row.slateDate, row.totalEntries, row.playerCount, row.gameCount,
      +row.avgPoints.toFixed(2), +row.medianPoints.toFixed(2),
      +row.p99Points.toFixed(2), +row.winnerPoints.toFixed(2),
      +row.avgSalary.toFixed(0), +row.avgOwn.toFixed(2), +row.avgProjection.toFixed(2),
      row.proEntryCount, +row.proAvgRankPct.toFixed(2), row.proTop1Count,
    ]);
  }

  const fieldPath = path.join(outputDir, 'field_summary.csv');
  writeCSV(fieldPath, fieldHeaders, fieldRows);
  console.log(`Wrote ${fieldRows.length} field summaries to ${fieldPath}`);

  // --- Summary ---
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n========================================`);
  console.log(`DATA EXTRACTION COMPLETE`);
  console.log(`========================================`);
  console.log(`  Slates processed: ${fieldSummaryRows.length}`);
  console.log(`  Pro entries: ${proEntryRows.length}`);
  console.log(`  Unique combos: ${comboMap.size.toLocaleString()}`);
  console.log(`  Output dir: ${outputDir}`);
  console.log(`  Time: ${elapsed}s`);

  // Top combos by top-1% count
  const topCombos = [...comboMap.entries()]
    .filter(([, s]) => s.countTop1Pct > 0)
    .sort((a, b) => b[1].countTop1Pct - a[1].countTop1Pct)
    .slice(0, 10);

  if (topCombos.length > 0) {
    console.log(`\n  Top combos by top-1% appearances:`);
    for (const [key, stats] of topCombos) {
      const names = key.split('|');
      console.log(`    ${names.join(' + ')} (${names.length}-man): ${stats.countTop1Pct}/${stats.count} top-1% (${stats.slates.size} slates)`);
    }
  }

  console.log('');
}
