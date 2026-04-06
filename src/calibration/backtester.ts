/**
 * DFS Optimizer CLI - Backtester
 *
 * Evaluates the scoring formula against actual contest results.
 * Uses the EXACT same scoring components as the selector so that
 * optimized weights directly improve lineup selection.
 *
 * Pipeline:
 *   1. Load historical slates (projections + actuals)
 *   2. Score all contest entries with our formula components
 *   3. Correlate each component with actual finish percentile
 *   4. Analyze tracked pro portfolios
 *   5. Optimize weights via gradient descent
 *   6. Save optimized_weights.json for the selector to load
 *
 * Usage:
 *   node dist/run.js --backtest --data ./historical_slates/
 */

import * as fs from 'fs';
import * as path from 'path';
import { Player, Lineup, Sport, DFSSite, PlayerPercentiles, ContestType, SelectionConfig } from '../types';
import { OptimizedWeights, selectLineups } from '../selection/selector';
import { selectLineupsSimple, computeConstructionMultiplier } from '../selection/simple-selector';
import { parseCSVFile, buildPlayerPool } from '../parser/csv-parser';
import { optimizeLineups } from '../optimizer/branch-bound';
import { getContestConfig } from '../rules/contests';

// Scoring functions — SAME ones the selector uses
import {
  calculateOwnershipSum,
  calculateOwnershipScore,
  normalizeProjectionScore,
  calculateVarianceScore,
  calculateRelativeValue,
  calculateBaselineMetrics,
  calculateCeilingRatioScore,
  calculateGameEnvironmentScore,
} from '../selection/scoring/lineup-scorer';
import {
  buildFieldOverlapIndex,
  calculateFieldOverlapScore,
  calculateFieldOverlapMetrics,
  FieldOverlapIndex,
  analyzeProjectionEdge,
  calculateLineupProjectionEdgeScore,
  ProjectionEdgeAnalysis,
} from '../selection/scoring/field-analysis';
import { generateFieldPool, dateSeed } from '../selection/simulation/tournament-sim';

// ============================================================
// TYPES
// ============================================================

export interface PlayerData {
  id: string;
  name: string;
  position: string;
  team: string;
  salary: number;
  projection: number;
  ownership: number;
  ceiling: number;     // dk_85_percentile
  ceiling99: number;   // dk_99_percentile
  actual: number;      // Actual DK FPTS for this slate
  gameTotal: number;
  percentiles?: PlayerPercentiles;
  gameInfo?: string;   // Canonical game ID (e.g., "DEN@LAL") derived from Team+Opp
}

export interface ContestEntry {
  rank: number;
  entryId: string;
  username: string;
  entryNumber: number;
  maxEntries: number;
  points: number;
  lineupStr: string;
}

export interface ComponentScores {
  projectionScore: number;
  ownershipScore: number;
  leverageScore: number;
  varianceScore: number;
  relativeValueScore: number;
  ceilingScore: number;
  salaryEfficiencyScore: number;
  antiCorrelationScore: number;
  projectionEdgeScore: number;
  gameStackScore: number;
  ceilingRatioScore: number;
  gameEnvironmentScore: number;
}

export interface ScoredEntry {
  entry: ContestEntry;
  lineup: Lineup | null;
  components: ComponentScores;
  totalScore: number;
  actualPercentile: number;   // 0-100, higher = better finish
}

interface SlateData {
  date: string;
  players: Map<string, PlayerData>;       // lowercase name → data
  playerAliases: Map<string, string>;     // alias → canonical lowercase name
  entries: ContestEntry[];
  totalEntries: number;
}

export interface SlateResult {
  date: string;
  scoredEntries: ScoredEntry[];
  totalEntries: number;
  numGames: number;
}

// ============================================================
// TRACKED PROS
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

function parseEntryCount(entryName: string): { username: string; entryNum: number; maxEntries: number } {
  const match = entryName.match(/^(\S+)\s*\((\d+)\/(\d+)\)/);
  if (match) {
    return {
      username: match[1].toLowerCase(),
      entryNum: parseInt(match[2]),
      maxEntries: parseInt(match[3]),
    };
  }
  return {
    username: entryName.replace(/\s*\(.*\)/, '').toLowerCase(),
    entryNum: 1,
    maxEntries: 1,
  };
}

// ============================================================
// CSV PARSING
// ============================================================

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());

  return result;
}

function stripBOM(str: string): string {
  return str.charCodeAt(0) === 0xFEFF ? str.slice(1) : str;
}

function findColumnIndex(headers: string[], ...candidates: string[]): number {
  const lower = headers.map(h => h.toLowerCase().trim());
  for (const candidate of candidates) {
    const idx = lower.findIndex(h => h === candidate.toLowerCase());
    if (idx >= 0) return idx;
  }
  // Partial match
  for (const candidate of candidates) {
    const idx = lower.findIndex(h => h.includes(candidate.toLowerCase()));
    if (idx >= 0) return idx;
  }
  return -1;
}

// ============================================================
// DATA LOADING
// ============================================================

export function findSlates(dataDir: string): Array<{ date: string; projFile: string; actualsFile: string }> {
  const files = fs.readdirSync(dataDir);
  // Support both formats:
  //   2026-01-16_projections.csv              (original — one slate per day)
  //   2026-01-16_early_projections.csv        (multi-slate — suffix before _projections/_actuals)
  // Slate key = "2026-01-16" or "2026-01-16_early"
  const slateMap = new Map<string, { proj?: string; actuals?: string }>();

  for (const file of files) {
    const match = file.match(/^(\d{4}-\d{2}-\d{2}(?:_[a-zA-Z0-9]+)?)_(projections|actuals)\.csv$/);
    if (!match) continue;
    const [, slateKey, type] = match;
    if (!slateMap.has(slateKey)) slateMap.set(slateKey, {});
    const entry = slateMap.get(slateKey)!;
    if (type === 'projections') entry.proj = file;
    if (type === 'actuals') entry.actuals = file;
  }

  const slates: Array<{ date: string; projFile: string; actualsFile: string }> = [];
  for (const [slateKey, slateFiles] of slateMap) {
    if (slateFiles.proj && slateFiles.actuals) {
      slates.push({ date: slateKey, projFile: slateFiles.proj, actualsFile: slateFiles.actuals });
    }
  }

  return slates.sort((a, b) => a.date.localeCompare(b.date));
}

export function loadProjections(dataDir: string, fileName: string): Map<string, PlayerData> {
  const content = stripBOM(fs.readFileSync(path.join(dataDir, fileName), 'utf-8'));
  const lines = content.split('\n').filter(l => l.trim().length > 0);
  if (lines.length < 2) return new Map();

  const headers = parseCSVLine(lines[0]);

  const idIdx = findColumnIndex(headers, 'DFS ID', 'Id', 'ID');
  const nameIdx = findColumnIndex(headers, 'Name');
  const posIdx = findColumnIndex(headers, 'Pos', 'Position');
  const teamIdx = findColumnIndex(headers, 'Team');
  const salaryIdx = findColumnIndex(headers, 'Salary');
  const actualIdx = findColumnIndex(headers, 'Actual');
  const projIdx = findColumnIndex(headers, 'SS Proj', 'My Proj', 'Projection');
  const ownIdx = findColumnIndex(headers, 'My Own', 'Ownership', 'Own');
  const ceilingIdx = findColumnIndex(headers, 'dk_85_percentile');
  const ceiling99Idx = findColumnIndex(headers, 'dk_99_percentile');
  const gameTotalIdx = findColumnIndex(headers, 'Saber Total', 'Game Total');
  const oppIdx = findColumnIndex(headers, 'Opp', 'Opponent');
  const p25Idx = findColumnIndex(headers, 'dk_25_percentile');
  const p50Idx = findColumnIndex(headers, 'dk_50_percentile');
  const p75Idx = findColumnIndex(headers, 'dk_75_percentile');
  const p85Idx = findColumnIndex(headers, 'dk_85_percentile');
  const p95Idx = findColumnIndex(headers, 'dk_95_percentile');
  const p99Idx = findColumnIndex(headers, 'dk_99_percentile');
  const hasPercentiles = p25Idx >= 0 && p50Idx >= 0 && p75Idx >= 0 && p85Idx >= 0 && p95Idx >= 0 && p99Idx >= 0;

  if (nameIdx < 0 || salaryIdx < 0 || projIdx < 0) {
    console.warn(`  Warning: Missing critical columns in ${fileName}`);
    return new Map();
  }

  const players = new Map<string, PlayerData>();

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    if (cols.length < 5) continue;

    const name = cols[nameIdx]?.trim();
    if (!name) continue;

    const projection = parseFloat(cols[projIdx]) || 0;
    if (projection <= 0) continue; // Skip zero-projection players

    const salary = parseFloat(cols[salaryIdx]) || 0;
    const ceiling = ceilingIdx >= 0 ? (parseFloat(cols[ceilingIdx]) || projection * 1.3) : projection * 1.3;
    const ceiling99 = ceiling99Idx >= 0 ? (parseFloat(cols[ceiling99Idx]) || ceiling * 1.15) : ceiling * 1.15;

    let percentiles: PlayerPercentiles | undefined;
    if (hasPercentiles) {
      percentiles = {
        p25: parseFloat(cols[p25Idx]) || 0,
        p50: parseFloat(cols[p50Idx]) || 0,
        p75: parseFloat(cols[p75Idx]) || 0,
        p85: parseFloat(cols[p85Idx]) || 0,
        p95: parseFloat(cols[p95Idx]) || 0,
        p99: parseFloat(cols[p99Idx]) || 0,
      };
    }

    const team = teamIdx >= 0 ? (cols[teamIdx]?.trim() || '') : '';
    const opp = oppIdx >= 0 ? (cols[oppIdx]?.trim() || '') : '';
    // Canonical game ID: alphabetically sorted "TEAM@OPP" so both sides match
    const gameInfo = team && opp ? [team, opp].sort().join('@') : '';

    const player: PlayerData = {
      id: idIdx >= 0 ? (cols[idIdx] || name) : name,
      name,
      position: posIdx >= 0 ? (cols[posIdx] || '') : '',
      team,
      salary,
      projection,
      ownership: ownIdx >= 0 ? (parseFloat(cols[ownIdx]) || 5) : 5,
      ceiling,
      ceiling99,
      actual: actualIdx >= 0 ? (parseFloat(cols[actualIdx]) || 0) : 0,
      gameTotal: gameTotalIdx >= 0 ? (parseFloat(cols[gameTotalIdx]) || 220) : 220,
      percentiles,
      gameInfo,
    };

    players.set(name.toLowerCase(), player);
  }

  return players;
}

export function loadActuals(dataDir: string, fileName: string): ContestEntry[] {
  const content = stripBOM(fs.readFileSync(path.join(dataDir, fileName), 'utf-8'));
  const lines = content.split('\n').filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];

  const headers = parseCSVLine(lines[0]);
  const rankIdx = findColumnIndex(headers, 'Rank');
  const entryIdIdx = findColumnIndex(headers, 'EntryId');
  const entryNameIdx = findColumnIndex(headers, 'EntryName');
  const pointsIdx = findColumnIndex(headers, 'Points');
  const lineupIdx = findColumnIndex(headers, 'Lineup');

  if (rankIdx < 0 || pointsIdx < 0 || lineupIdx < 0) {
    console.warn(`  Warning: Missing columns in actuals file ${fileName}`);
    return [];
  }

  const entries: ContestEntry[] = [];
  const seenEntryIds = new Set<string>();

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    if (cols.length < 5) continue;

    const rank = parseInt(cols[rankIdx]);
    const points = parseFloat(cols[pointsIdx]);
    if (isNaN(rank) || isNaN(points)) continue;

    const entryId = cols[entryIdIdx] || `${i}`;
    // Some formats have multiple rows per entry (player breakdowns) — deduplicate
    if (seenEntryIds.has(entryId)) continue;
    seenEntryIds.add(entryId);

    const entryName = cols[entryNameIdx] || '';
    const parsed = parseEntryCount(entryName);
    const lineupStr = cols[lineupIdx] || '';

    entries.push({
      rank,
      entryId,
      username: parsed.username,
      entryNumber: parsed.entryNum,
      maxEntries: parsed.maxEntries,
      points,
      lineupStr,
    });
  }

  return entries;
}

// ============================================================
// LINEUP STRING PARSING
// ============================================================

/**
 * Parse DK lineup string into player names.
 * Format: "C PlayerName F PlayerName PG PlayerName ..."
 * Positions: UTIL, PG, SG, SF, PF, C, G, F
 */
function parseLineupString(lineupStr: string): string[] {
  if (!lineupStr || lineupStr.trim().length === 0) return [];

  // Find all position markers and their positions in the string.
  // Process longer tokens first so PG/SG/SF/PF/UTIL don't partially match.
  const posTokens = ['UTIL', 'PG', 'SG', 'SF', 'PF', 'C', 'G', 'F'];
  const markers: Array<{ pos: string; nameStart: number }> = [];

  // Build regex: match position as a whole word followed by a space
  // Use (?:^|\s) to anchor at start-of-string or after whitespace
  const regex = /(?:^|\s)(UTIL|PG|SG|SF|PF|C|G|F)\s+/g;
  let match;
  while ((match = regex.exec(lineupStr)) !== null) {
    const nameStart = match.index + match[0].length;
    markers.push({ pos: match[1], nameStart });
  }

  // Extract names between consecutive markers
  const names: string[] = [];
  for (let i = 0; i < markers.length; i++) {
    const start = markers[i].nameStart;
    const end = i + 1 < markers.length
      ? lineupStr.lastIndexOf(' ', markers[i + 1].nameStart - markers[i + 1].pos.length - 1)
      : lineupStr.length;
    const name = lineupStr.substring(start, end).trim();
    if (name) names.push(name);
  }

  return names;
}

/**
 * Match a player name from the actuals to our projections data.
 * Tries exact match, then fuzzy matching for Jr./III/etc.
 */
function matchPlayerName(
  name: string,
  players: Map<string, PlayerData>,
): PlayerData | null {
  const lower = name.toLowerCase().trim();

  // Exact match
  if (players.has(lower)) return players.get(lower)!;

  // Remove suffixes and try again
  const cleaned = lower
    .replace(/\s+(jr\.?|sr\.?|ii|iii|iv|v)$/i, '')
    .replace(/\./g, '')
    .trim();
  if (players.has(cleaned)) return players.get(cleaned)!;

  // Try matching without dots in the projections too
  for (const [key, data] of players) {
    const keyClean = key.replace(/\./g, '').trim();
    if (keyClean === cleaned) return data;
    if (keyClean === lower) return data;
  }

  // Last resort: last name match (only if unique)
  const lastNameParts = lower.split(/\s+/);
  const lastName = lastNameParts[lastNameParts.length - 1];
  if (lastName.length >= 4) {
    const lastNameMatches: PlayerData[] = [];
    for (const [key, data] of players) {
      if (key.endsWith(lastName)) lastNameMatches.push(data);
    }
    if (lastNameMatches.length === 1) return lastNameMatches[0];
  }

  return null;
}

// ============================================================
// BUILD LINEUP FROM CONTEST ENTRY
// ============================================================

function buildLineupFromEntry(
  entry: ContestEntry,
  players: Map<string, PlayerData>,
): Lineup | null {
  const names = parseLineupString(entry.lineupStr);
  if (names.length < 6) return null; // Need at least 6 players

  const lineupPlayers: Player[] = [];
  let totalSalary = 0;
  let totalProjection = 0;
  let totalOwnership = 0;

  for (let i = 0; i < names.length; i++) {
    const data = matchPlayerName(names[i], players);
    if (!data) return null; // Can't match a player → skip entry

    const player: Player = {
      id: data.id,
      name: data.name,
      position: data.position,
      team: data.team,
      salary: data.salary,
      projection: data.projection,
      ownership: data.ownership,
      ceiling: data.ceiling,
      ceiling99: data.ceiling99,
      gameTotal: data.gameTotal,
      gameInfo: data.gameInfo,
      index: i,
      positions: data.position.split('/').map(p => p.trim()),
      value: data.salary > 0 ? (data.projection / data.salary) * 1000 : 0,
      percentiles: data.percentiles,
    };

    lineupPlayers.push(player);
    totalSalary += data.salary;
    totalProjection += data.projection;
    totalOwnership += data.ownership;
  }

  const hash = lineupPlayers.map(p => p.id).sort().join('|');

  return {
    players: lineupPlayers,
    salary: totalSalary,
    projection: totalProjection,
    ownership: totalOwnership,
    hash,
  };
}

// ============================================================
// COMPONENT SCORING
// ============================================================

export function scoreLineup(
  lineup: Lineup,
  minProj: number,
  maxProj: number,
  optimalProjection: number,
  optimalOwnership: number,
  overlapIndex: FieldOverlapIndex,
  maxCeiling: number,
  poolMinCeiling: number,
  ceilingRange: number,
  projectionEdgeAnalysis: ProjectionEdgeAnalysis | null,
  numGames: number = 5,
): ComponentScores {
  const projectionScore = normalizeProjectionScore(lineup.projection, minProj, maxProj);
  const ownershipScore = calculateOwnershipScore(lineup);

  // Field overlap leverage (same as selector): ceiling-weighted contrarian + combo uniqueness
  const leverageScore = calculateFieldOverlapScore(lineup, overlapIndex, maxCeiling);

  // Anti-correlation: structural uniqueness vs field (from field overlap metrics)
  const overlapMetrics = calculateFieldOverlapMetrics(lineup, overlapIndex);
  const antiCorrelationScore = overlapMetrics.antiCorrelationScore;

  const varianceData = calculateVarianceScore(lineup);
  const varianceScore = varianceData.score;

  const relValue = calculateRelativeValue(lineup, optimalProjection, optimalOwnership);
  const relativeValueScore = relValue.relativeValueScore;

  // Range-based ceiling normalization (same as selector)
  const ceilingScore = ceilingRange > 0
    ? Math.max(0, Math.min(1, (varianceData.ceiling - poolMinCeiling) / ceilingRange))
    : 0.5;

  // Salary efficiency: smooth quadratic decay (same as selector)
  const salaryLeft = 50000 - lineup.salary;
  const x = Math.min(1, salaryLeft / 1800);
  const salaryEfficiencyScore = Math.max(0.1, 1 - x * x);

  // Projection edge: our projection vs field-implied projection
  const projectionEdgeScore = projectionEdgeAnalysis
    ? calculateLineupProjectionEdgeScore(lineup, projectionEdgeAnalysis)
    : 0.5;

  // Game stack score: correlated upside from same-game players + bring-backs
  // Matches selector's calculateGameStackScore() exactly
  const gameStackScore = computeGameStackScore(lineup, numGames);

  // Ceiling ratio: boom potential as ratio (blended p85/p99 vs projection)
  const ceilingRatioScore = calculateCeilingRatioScore(lineup);

  // Game environment: high-total games produce more DFS points
  const gameEnvironmentScore = calculateGameEnvironmentScore(lineup);

  return {
    projectionScore,
    ownershipScore,
    leverageScore,
    varianceScore,
    relativeValueScore,
    ceilingScore,
    salaryEfficiencyScore,
    antiCorrelationScore,
    projectionEdgeScore,
    gameStackScore,
    ceilingRatioScore,
    gameEnvironmentScore,
  };
}

/**
 * Game stack scoring — mirrors selector's calculateGameStackScore().
 * Pro top-1%: 94% 3+stack, 55% 4+stack, 93% bring-back.
 * Winners: 100% BB, 67% 4+stack, avg max stack 4.08.
 */
function computeGameStackScore(lineup: Lineup, numGames: number): number {
  // Pro data (63K entries, 17 slates) — top-1% hit rates by construction:
  //   3-2-2-1: 1.55% (best common),  6-1-1: 2.30% (best overall, rare)
  //   5-1-1-1: 1.53%,  4-3-1: 1.44%,  4-2-1-1: 1.36%,  5-2-1: 1.36%
  //   3-2-1-1-1: 1.25%,  3-3-2: 1.07%,  2-2-2-1-1: 0.91% (worst)
  // Key: 3-man primary + multiple secondary stacks is the sweet spot.

  let gameTotalSum = 0;
  let gameTotalCount = 0;
  for (const p of lineup.players) {
    if (p.gameTotal && p.gameTotal > 0) {
      gameTotalSum += p.gameTotal;
      gameTotalCount++;
    }
  }
  const slateAvgGameTotal = gameTotalCount > 0 ? gameTotalSum / gameTotalCount : 225;

  const gameGroups = new Map<string, { teams: Set<string>; count: number; gameTotal: number }>();
  for (const player of lineup.players) {
    const gameId = player.gameInfo || `${player.team}_game`;
    const group = gameGroups.get(gameId) || { teams: new Set(), count: 0, gameTotal: player.gameTotal || slateAvgGameTotal };
    group.teams.add(player.team);
    group.count++;
    gameGroups.set(gameId, group);
  }

  let stackBonus = 0;
  let maxStackSize = 0;
  const stackSizes: number[] = [];

  for (const [, group] of gameGroups) {
    const gameTotalScaler = group.gameTotal / slateAvgGameTotal;
    if (group.count > maxStackSize) maxStackSize = group.count;
    const hasBB = group.teams.size >= 2;

    if (group.count >= 6) {
      stackBonus += 0.20 * gameTotalScaler;
      if (hasBB) stackBonus += 0.08 * gameTotalScaler;
    } else if (group.count >= 5) {
      stackBonus += 0.14 * gameTotalScaler;
      if (hasBB) stackBonus += 0.06 * gameTotalScaler;
    } else if (group.count >= 4) {
      stackBonus += 0.10 * gameTotalScaler;
      if (hasBB) stackBonus += 0.05 * gameTotalScaler;
    } else if (group.count >= 3) {
      stackBonus += 0.10 * gameTotalScaler;
      if (hasBB) stackBonus += 0.04 * gameTotalScaler;
    } else if (group.count === 2) {
      stackBonus += 0.03 * gameTotalScaler;
      if (hasBB) stackBonus += 0.02 * gameTotalScaler;
    }
    if (group.count >= 2) stackSizes.push(group.count);
  }

  stackSizes.sort((a, b) => b - a);
  const numStackGroups = stackSizes.length;

  if (numStackGroups >= 3) {
    stackBonus += 0.12;
  } else if (numStackGroups >= 2) {
    stackBonus += 0.07;
  }

  if (maxStackSize <= 2 && numGames > 2) {
    stackBonus -= 0.06;
  }
  if (numStackGroups <= 1 && maxStackSize >= 3 && numGames >= 4) {
    stackBonus -= 0.04;
  }

  const slateScaler = numGames <= 3 ? 0.80 : numGames <= 4 ? 0.90 : numGames <= 6 ? 1.00 : 1.10;
  return Math.max(-0.05, Math.min(0.70, stackBonus * slateScaler));
}

export function computeTotalScore(
  components: ComponentScores,
  weights: OptimizedWeights,
  lineup?: Lineup | null,
  numGames?: number,
  sport?: string,
): number {
  // MUST MATCH selector's calculateTotalScore() × (1 + gameStackScore) × constructionMultiplier exactly.
  // Optimized Mar 2026: Coordinate descent on 12-slate backtest (242K entries).
  // Balances actual-points correlation AND GPP win differentiation.
  // relativeValue: -0.089 actual-pts corr BUT +10.2% winner diff (#1 differentiator).
  // Game stack applied multiplicatively (same as selector's scoreHeuristicLineup).

  // 5-component additive score (Plans 1 & 2: removed ceilingRatio and gameEnvironment — negative/zero predictors)
  const additiveScore = (
    components.projectionScore * weights.projectionScore +
    components.ceilingScore * weights.ceilingScore +
    components.varianceScore * weights.varianceScore +
    components.salaryEfficiencyScore * weights.salaryEfficiencyScore +
    components.relativeValueScore * weights.relativeValueScore
  );

  // Quality gate: projection and ceiling are non-negotiable
  // Thresholds from formula sweep (default to legacy values if not set)
  const projGateThresh = weights.projGateThreshold || 0.50;
  const ceilGateThresh = weights.ceilGateThreshold || 0.40;
  const projGate = Math.min(1, components.projectionScore / projGateThresh);
  const ceilGate = Math.min(1, components.ceilingScore / ceilGateThresh);
  const qualityGate = Math.sqrt(projGate * ceilGate);

  // Construction multiplier: massive bonus/penalty for stacking patterns (matching selector)
  const constructionMult = (lineup && numGames != null)
    ? computeConstructionMultiplier(lineup, numGames, sport)
    : 1.0;

  // Game stack bonus applied multiplicatively (matching selector)
  // Pro top-1%: 94% 3+stack, 55% 4+stack, 93% bring-back
  return additiveScore * qualityGate * (1 + components.gameStackScore) * constructionMult;
}

// All raw scoring components — used for correlation analysis
const COMPONENT_KEYS: (keyof ComponentScores)[] = [
  'projectionScore', 'ownershipScore', 'leverageScore', 'varianceScore',
  'relativeValueScore', 'ceilingScore', 'salaryEfficiencyScore',
  'antiCorrelationScore', 'projectionEdgeScore', 'gameStackScore',
  'ceilingRatioScore', 'gameEnvironmentScore',
];

// Weight keys that computeTotalScore actually uses — these are what the optimizer varies.
// NOTE: leverageScore/antiCorrelationScore are blended into uniquenessScore internally,
// so the optimizer varies the *uniqueness blend weight*, not individual sub-components.
const WEIGHT_KEYS: (keyof OptimizedWeights)[] = [
  'projectionScore', 'ownershipScore', 'uniquenessScore',
  'varianceScore', 'ceilingScore', 'salaryEfficiencyScore',
  'relativeValueScore', 'projectionEdgeScore',
];

// ============================================================
// CORRELATION ANALYSIS
// ============================================================

function pearsonCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 3) return 0;

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i];
    sumY += y[i];
    sumXY += x[i] * y[i];
    sumX2 += x[i] * x[i];
    sumY2 += y[i] * y[i];
  }

  const denom = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  if (denom === 0) return 0;

  return (n * sumXY - sumX * sumY) / denom;
}

function analyzeCorrelations(
  results: SlateResult[],
): Map<keyof ComponentScores, number> {
  // Pool all scored entries across all slates
  const allComponents: ComponentScores[] = [];
  const allPercentiles: number[] = [];

  for (const result of results) {
    for (const se of result.scoredEntries) {
      if (!se.lineup) continue;
      allComponents.push(se.components);
      allPercentiles.push(se.actualPercentile);
    }
  }

  console.log(`\n  Correlation analysis across ${allComponents.length} scored entries`);

  const correlations = new Map<keyof ComponentScores, number>();

  for (const key of COMPONENT_KEYS) {
    const values = allComponents.map(c => c[key]);
    const corr = pearsonCorrelation(values, allPercentiles);
    correlations.set(key, corr);
  }

  return correlations;
}

// ============================================================
// PRO ANALYSIS
// ============================================================

interface ProProfile {
  username: string;
  totalEntries: number;
  avgRank: number;
  bestFinish: number;
  top1PctRate: number;
  top10PctRate: number;
  cashRate: number;
  avgComponents: ComponentScores;
  avgTotalScore: number;
}

function analyzePros(results: SlateResult[]): ProProfile[] {
  // Collect all pro entries across slates
  const proEntries = new Map<string, ScoredEntry[]>();

  for (const result of results) {
    for (const se of result.scoredEntries) {
      if (!isTrackedPro(se.entry.username)) continue;
      const key = se.entry.username.toLowerCase();
      if (!proEntries.has(key)) proEntries.set(key, []);
      proEntries.get(key)!.push(se);
    }
  }

  const profiles: ProProfile[] = [];

  for (const [username, entries] of proEntries) {
    if (entries.length < 3) continue; // Need meaningful sample

    const avgRank = entries.reduce((s, e) => s + e.entry.rank, 0) / entries.length;
    const bestFinish = Math.min(...entries.map(e => e.entry.rank));

    // Calculate rates
    const top1PctCount = entries.filter(e => e.actualPercentile >= 99).length;
    const top10PctCount = entries.filter(e => e.actualPercentile >= 90).length;
    const cashCount = entries.filter(e => e.actualPercentile >= 80).length;

    // Average component scores
    const avgComp: ComponentScores = {
      projectionScore: 0, ownershipScore: 0, leverageScore: 0, varianceScore: 0,
      relativeValueScore: 0, ceilingScore: 0, salaryEfficiencyScore: 0,
      antiCorrelationScore: 0, projectionEdgeScore: 0, gameStackScore: 0,
      ceilingRatioScore: 0, gameEnvironmentScore: 0,
    };
    let validCount = 0;

    for (const se of entries) {
      if (!se.lineup) continue;
      for (const key of COMPONENT_KEYS) {
        avgComp[key] += se.components[key];
      }
      validCount++;
    }

    if (validCount > 0) {
      for (const key of COMPONENT_KEYS) {
        avgComp[key] /= validCount;
      }
    }

    const avgTotal = entries.reduce((s, e) => s + e.totalScore, 0) / entries.length;

    profiles.push({
      username,
      totalEntries: entries.length,
      avgRank,
      bestFinish,
      top1PctRate: top1PctCount / entries.length,
      top10PctRate: top10PctCount / entries.length,
      cashRate: cashCount / entries.length,
      avgComponents: avgComp,
      avgTotalScore: avgTotal,
    });
  }

  return profiles.sort((a, b) => a.avgRank - b.avgRank);
}

// ============================================================
// WEIGHT OPTIMIZATION
// ============================================================

/**
 * Objective function: given a set of weights, how well does our formula
 * predict top 1% finishes across all scored entries?
 *
 * Method: sort entries by formula score, take top N as "our picks".
 * Measure what % of our picks actually finished in the top 1%.
 * Higher = better weights.
 */
function evaluateWeights(
  results: SlateResult[],
  weights: OptimizedWeights,
  topN: number = 150,
): number {
  let totalScore = 0;
  let slateCount = 0;

  for (const result of results) {
    const valid = result.scoredEntries.filter(se => se.lineup !== null);
    if (valid.length < 100) continue;

    // Recompute total scores with these weights
    const reScored = valid.map(se => ({
      totalScore: computeTotalScore(se.components, weights, se.lineup, result.numGames),
      actualPercentile: se.actualPercentile,
    }));

    // Sort by formula score descending, take top N
    reScored.sort((a, b) => b.totalScore - a.totalScore);
    const picks = reScored.slice(0, Math.min(topN, Math.max(50, Math.floor(valid.length * 0.01))));

    // Measure success of our picks
    const top1PctHits = picks.filter(p => p.actualPercentile >= 99).length;
    const top10PctHits = picks.filter(p => p.actualPercentile >= 90).length;
    const top20PctHits = picks.filter(p => p.actualPercentile >= 80).length;

    const slateScore =
      (top1PctHits / picks.length) * 10.0 +   // Top 1% is everything for GPP
      (top10PctHits / picks.length) * 1.0;     // Secondary signal only

    totalScore += slateScore;
    slateCount++;
  }

  return slateCount > 0 ? totalScore / slateCount : 0;
}

function optimizeWeights(
  results: SlateResult[],
  startingWeights: OptimizedWeights,
): OptimizedWeights {
  console.log('\n--- WEIGHT OPTIMIZATION (multi-phase) ---');
  console.log('  Using coarse-to-fine coordinate descent...');

  const weights = { ...startingWeights };
  const keys = WEIGHT_KEYS;

  let bestScore = evaluateWeights(results, weights);
  console.log(`  Starting score: ${bestScore.toFixed(4)}`);

  const MIN_WEIGHT = 0.00;
  const MAX_WEIGHT = 0.50;

  // Multi-phase schedule: coarse exploration → fine tuning
  const phases = [
    { step: 0.08, patience: 3, label: 'Phase 1 (coarse)' },
    { step: 0.03, patience: 2, label: 'Phase 2 (medium)' },
    { step: 0.01, patience: 2, label: 'Phase 3 (fine)' },
  ];

  for (const phase of phases) {
    let noImproveCount = 0;
    let phaseIter = 0;

    console.log(`  ${phase.label}: step=${phase.step}, patience=${phase.patience}`);

    while (noImproveCount < phase.patience) {
      let improved = false;
      phaseIter++;

      for (const key of keys) {
        const original = weights[key] || 0;

        // Try increasing this weight
        if (original + phase.step <= MAX_WEIGHT) {
          (weights as any)[key] = original + phase.step;
          const score = evaluateWeights(results, weights);
          if (score > bestScore) {
            bestScore = score;
            improved = true;
            continue;
          }
          (weights as any)[key] = original;
        }

        // Try decreasing this weight
        if (original - phase.step >= MIN_WEIGHT) {
          (weights as any)[key] = original - phase.step;
          const score = evaluateWeights(results, weights);
          if (score > bestScore) {
            bestScore = score;
            improved = true;
            continue;
          }
          (weights as any)[key] = original;
        }
      }

      if (!improved) {
        noImproveCount++;
      } else {
        noImproveCount = 0;
      }

      if (phaseIter % 5 === 0) {
        console.log(`    iter ${phaseIter}: score = ${bestScore.toFixed(4)}`);
      }
    }

    console.log(`    ${phase.label} done after ${phaseIter} iterations, score = ${bestScore.toFixed(4)}`);
  }

  // Normalize all optimized component weights to sum to 1.0
  // (simulationScore is separate — not included in this sum)
  const optimizedTotal = keys.reduce((s, k) => s + (weights[k] || 0), 0);
  if (optimizedTotal > 0) {
    for (const key of keys) {
      (weights as any)[key] = (weights[key] || 0) / optimizedTotal;
    }
  }

  console.log(`  Final score: ${bestScore.toFixed(4)}`);
  return weights;
}

// ============================================================
// REPORT GENERATION
// ============================================================

function generateReport(
  results: SlateResult[],
  correlations: Map<keyof ComponentScores, number>,
  proProfiles: ProProfile[],
  currentWeights: OptimizedWeights,
  optimizedWeights: OptimizedWeights,
): string {
  const lines: string[] = [];

  lines.push('========================================');
  lines.push('DFS OPTIMIZER - BACKTEST REPORT');
  lines.push(`Date: ${new Date().toISOString().split('T')[0]}`);
  lines.push(`Slates analyzed: ${results.length}`);
  lines.push('========================================');

  // Total entries scored
  const totalScored = results.reduce((s, r) => s + r.scoredEntries.filter(e => e.lineup).length, 0);
  const totalEntries = results.reduce((s, r) => s + r.totalEntries, 0);
  lines.push(`\nTotal contest entries analyzed: ${totalScored.toLocaleString()} / ${totalEntries.toLocaleString()}`);

  // Per-slate summary
  lines.push('\nPER-SLATE SUMMARY:');
  for (const result of results) {
    const scored = result.scoredEntries.filter(e => e.lineup);
    const matchRate = ((scored.length / result.totalEntries) * 100).toFixed(1);
    lines.push(`  ${result.date}: ${scored.length.toLocaleString()} entries scored (${matchRate}% match rate), ${result.totalEntries.toLocaleString()} total`);
  }

  // Component correlations
  lines.push('\n========================================');
  lines.push('COMPONENT CORRELATIONS WITH ACTUAL FINISH');
  lines.push('(Positive = predicts higher finish)');
  lines.push('========================================');

  const sorted = [...correlations.entries()].sort((a, b) => b[1] - a[1]);
  for (const [key, corr] of sorted) {
    const bar = corr > 0 ? '+'.repeat(Math.round(corr * 40)) : '-'.repeat(Math.round(-corr * 40));
    const sign = corr >= 0 ? '+' : '';
    const label = key.replace('Score', '').padEnd(20);
    lines.push(`  ${label}: ${sign}${corr.toFixed(4)}  ${bar}`);
  }

  // Pro analysis
  if (proProfiles.length > 0) {
    lines.push('\n========================================');
    lines.push('PRO PLAYER ANALYSIS');
    lines.push('========================================');

    // Field average components
    const allValid = results.flatMap(r => r.scoredEntries.filter(e => e.lineup));
    const fieldAvg: Record<string, number> = {};
    for (const key of COMPONENT_KEYS) {
      fieldAvg[key] = allValid.reduce((s, e) => s + e.components[key], 0) / allValid.length;
    }

    for (const pro of proProfiles) {
      lines.push(`\n  ${pro.username} (${pro.totalEntries} entries across ${results.length} slates)`);
      lines.push(`    Avg Rank: ${pro.avgRank.toFixed(0)} | Best: #${pro.bestFinish}`);
      lines.push(`    Top 1%: ${(pro.top1PctRate * 100).toFixed(1)}% | Top 10%: ${(pro.top10PctRate * 100).toFixed(1)}% | Cash: ${(pro.cashRate * 100).toFixed(1)}%`);

      lines.push('    Component comparison vs field:');
      for (const key of COMPONENT_KEYS) {
        const proVal = pro.avgComponents[key];
        const fieldVal = fieldAvg[key];
        const diff = proVal - fieldVal;
        const direction = diff > 0.02 ? 'HIGHER' : diff < -0.02 ? 'LOWER' : 'similar';
        const label = key.replace('Score', '').padEnd(20);
        lines.push(`      ${label}: ${proVal.toFixed(3)} vs ${fieldVal.toFixed(3)} (${direction})`);
      }
    }
  }

  // Weight comparison
  lines.push('\n========================================');
  lines.push('WEIGHT OPTIMIZATION RESULTS');
  lines.push('========================================');
  lines.push('Component            Current    Optimized   Change');
  lines.push('----------------------------------------------------');

  for (const key of WEIGHT_KEYS) {
    const current = currentWeights[key] || 0;
    const optimized = optimizedWeights[key] || 0;
    const diff = optimized - current;
    const diffStr = diff > 0 ? `+${(diff * 100).toFixed(1)}%` : `${(diff * 100).toFixed(1)}%`;
    const label = key.replace('Score', '').padEnd(20);
    lines.push(`  ${label} ${(current * 100).toFixed(1).padStart(6)}%    ${(optimized * 100).toFixed(1).padStart(6)}%    ${diffStr}`);
  }

  return lines.join('\n');
}

// ============================================================
// MAIN SLATE PROCESSING
// ============================================================

export async function processSlate(
  dataDir: string,
  slate: { date: string; projFile: string; actualsFile: string },
): Promise<SlateResult | null> {
  console.log(`\n  Processing ${slate.date}...`);

  // Load data
  const players = loadProjections(dataDir, slate.projFile);
  const entries = loadActuals(dataDir, slate.actualsFile);

  if (players.size === 0) {
    console.log(`    No players loaded from projections`);
    return null;
  }
  if (entries.length === 0) {
    console.log(`    No entries loaded from actuals`);
    return null;
  }

  console.log(`    ${players.size} players, ${entries.length} contest entries`);

  // Build Player objects for field generation
  const playerList: Player[] = [];
  let idx = 0;
  for (const [, data] of players) {
    playerList.push({
      id: data.id,
      name: data.name,
      position: data.position,
      team: data.team,
      salary: data.salary,
      projection: data.projection,
      ownership: data.ownership,
      ceiling: data.ceiling,
      ceiling99: data.ceiling99,
      gameTotal: data.gameTotal,
      gameInfo: data.gameInfo,
      index: idx++,
      positions: data.position.split('/').map(p => p.trim()),
      value: data.salary > 0 ? (data.projection / data.salary) * 1000 : 0,
      percentiles: data.percentiles,
    });
  }

  // Count distinct games for stacking scaling
  const gameSet = new Set<string>();
  for (const p of playerList) {
    if (p.gameInfo) gameSet.add(p.gameInfo);
  }
  const numGames = gameSet.size > 0 ? gameSet.size : Math.ceil(new Set(playerList.map(p => p.team)).size / 2);

  // Generate synthetic field for combo analysis
  const rosterSize = 8; // DK NBA Classic
  const syntheticField = generateFieldPool(playerList, rosterSize, 5000, dateSeed(slate.date));
  const overlapIndex = buildFieldOverlapIndex(syntheticField, rosterSize);
  // Uses ceiling99 (p99) to match the leverage function's boom weighting
  const maxCeiling = playerList.reduce((max, p) => {
    const ceil = p.ceiling99 || p.ceiling || p.projection * 1.3;
    return ceil > max ? ceil : max;
  }, 0);

  // Projection edge analysis (same as selector)
  const projEdgeAnalysis = analyzeProjectionEdge(playerList);

  // Build lineups from contest entries
  const scoredEntries: ScoredEntry[] = [];
  let matchedCount = 0;
  let failedCount = 0;

  // First pass: build all lineups to find projection range
  const builtLineups: Array<{ entry: ContestEntry; lineup: Lineup | null }> = [];
  for (const entry of entries) {
    const lineup = buildLineupFromEntry(entry, players);
    builtLineups.push({ entry, lineup });
    if (lineup) matchedCount++;
    else failedCount++;
  }

  console.log(`    Matched ${matchedCount} / ${entries.length} entries (${failedCount} failed)`);

  if (matchedCount < 50) {
    console.log(`    Too few matched entries, skipping slate`);
    return null;
  }

  // Find projection range across matched entries
  const projections = builtLineups.filter(b => b.lineup).map(b => b.lineup!.projection);
  let maxProj = -Infinity, minProj = Infinity;
  for (const p of projections) { if (p > maxProj) maxProj = p; if (p < minProj) minProj = p; }

  // Find optimal lineup (highest projection)
  const bestLineup = builtLineups.reduce((best, cur) =>
    cur.lineup && (!best.lineup || cur.lineup.projection > best.lineup.projection) ? cur : best
  );
  const optimalProjection = bestLineup.lineup?.projection || maxProj;
  const optimalOwnership = bestLineup.lineup ? calculateOwnershipSum(bestLineup.lineup) : 200;

  // Pre-pass: find ceiling sum range for proper normalization
  let poolMinCeiling = Infinity;
  let poolMaxCeiling = -Infinity;
  for (const { lineup } of builtLineups) {
    if (!lineup) continue;
    const vd = calculateVarianceScore(lineup);
    if (vd.ceiling < poolMinCeiling) poolMinCeiling = vd.ceiling;
    if (vd.ceiling > poolMaxCeiling) poolMaxCeiling = vd.ceiling;
  }
  const ceilingRange = poolMaxCeiling - poolMinCeiling;

  // Score all entries
  const totalEntries = entries.length;

  for (const { entry, lineup } of builtLineups) {
    const actualPercentile = 100 * (1 - entry.rank / totalEntries);

    if (!lineup) {
      scoredEntries.push({
        entry,
        lineup: null,
        components: {
          projectionScore: 0, ownershipScore: 0, leverageScore: 0, varianceScore: 0,
          relativeValueScore: 0, ceilingScore: 0, salaryEfficiencyScore: 0,
          antiCorrelationScore: 0, projectionEdgeScore: 0, gameStackScore: 0,
          ceilingRatioScore: 0, gameEnvironmentScore: 0,
        },
        totalScore: 0,
        actualPercentile,
      });
      continue;
    }

    const components = scoreLineup(
      lineup, minProj, maxProj, optimalProjection, optimalOwnership,
      overlapIndex, maxCeiling, poolMinCeiling, ceilingRange, projEdgeAnalysis,
      numGames,
    );

    const totalScore = computeTotalScore(components, DEFAULT_WEIGHTS_COPY, lineup, numGames);

    scoredEntries.push({
      entry,
      lineup,
      components,
      totalScore,
      actualPercentile,
    });
  }

  console.log(`    Scored ${scoredEntries.filter(e => e.lineup).length} entries`);

  return {
    date: slate.date,
    scoredEntries,
    totalEntries,
    numGames,
  };
}

// Starting weights for backtester — MUST match selector's DEFAULT_WEIGHTS
// so the optimizer starts from the same place production uses.
// Non-sim weights sum to 1.0; simulationScore is separate.
const DEFAULT_WEIGHTS_COPY: OptimizedWeights = {
  // Must match selector DEFAULT_WEIGHTS and optimized_weights.json
  // Rebalanced Mar 2026: more projection/ceiling, less relativeValue
  // Pro profile target: proj 0.83, ceil 0.85, var 0.90, relVal 0.53
  projectionScore: 0.20,
  ownershipScore: 0.00,
  uniquenessScore: 0.00,
  projectionEdgeScore: 0.00,
  ceilingRatioScore: 0.00,
  gameEnvironmentScore: 0.00,
  ceilingScore: 0.20,
  varianceScore: 0.20,
  salaryEfficiencyScore: 0.10,
  relativeValueScore: 0.30,
  simulationScore: 0.00,
  projGateThreshold: 0.50,
  ceilGateThreshold: 0.40,
};

// ============================================================
// MAIN ENTRY POINT
// ============================================================

export class Backtester {
  private dataDir: string;

  constructor(dataDir: string, _sport: Sport = 'nba', _site: DFSSite = 'dk') {
    this.dataDir = dataDir;
  }

  async runBacktest(): Promise<SlateResult[]> {
    return [];
  }

  async autoTuneWeights(): Promise<Record<string, number>> {
    return {};
  }

  generateReport(_results: any[]): string {
    return '';
  }
}

// ============================================================
// COMPREHENSIVE ANALYSIS FUNCTIONS
// ============================================================

/**
 * Analyze what the top finishers look like across all scoring components.
 * Shows the "ideal profile" based on actual results.
 */
function analyzeWinnerProfiles(results: SlateResult[]): void {
  console.log('\n========================================');
  console.log('WINNER PROFILE ANALYSIS');
  console.log('========================================');

  const tiers = [
    { name: 'Top 0.1%', min: 99.9 },
    { name: 'Top 1%  ', min: 99.0 },
    { name: 'Top 5%  ', min: 95.0 },
    { name: 'Top 10% ', min: 90.0 },
    { name: 'Top 25% ', min: 75.0 },
    { name: 'Bot 50% ', min: 0, max: 50.0 },
  ];

  // Collect all valid entries
  const allEntries: ScoredEntry[] = [];
  for (const result of results) {
    for (const se of result.scoredEntries) {
      if (se.lineup) allEntries.push(se);
    }
  }

  if (allEntries.length === 0) return;

  // Compute field averages
  const fieldAvg: Record<string, number> = {};
  let fieldAvgPoints = 0;
  let fieldAvgProj = 0;
  let fieldAvgOwn = 0;
  for (const key of COMPONENT_KEYS) {
    fieldAvg[key] = allEntries.reduce((s, e) => s + e.components[key], 0) / allEntries.length;
  }
  fieldAvgPoints = allEntries.reduce((s, e) => s + e.entry.points, 0) / allEntries.length;
  fieldAvgProj = allEntries.filter(e => e.lineup).reduce((s, e) => s + e.lineup!.projection, 0) / allEntries.length;
  fieldAvgOwn = allEntries.filter(e => e.lineup).reduce((s, e) => {
    return s + e.lineup!.players.reduce((os, p) => os + p.ownership, 0);
  }, 0) / allEntries.length;

  // Header
  console.log(`\n  ${'Tier'.padEnd(10)} ${'Actual'.padStart(7)} ${'Proj'.padStart(6)} ${'Own%'.padStart(6)} ${'proj'.padStart(6)} ${'own'.padStart(6)} ${'lev'.padStart(6)} ${'ceil'.padStart(6)} ${'salEff'.padStart(6)} ${'var'.padStart(6)} ${'relVal'.padStart(6)}`);
  console.log(`  ${''.padEnd(10)} ${'Points'.padStart(7)} ${''.padStart(6)} ${'Sum'.padStart(6)} ${'Score'.padStart(6)} ${'Score'.padStart(6)} ${'Score'.padStart(6)} ${'Score'.padStart(6)} ${'Score'.padStart(6)} ${'Score'.padStart(6)} ${'Score'.padStart(6)}`);
  console.log(`  ${'─'.repeat(80)}`);

  // Field average row
  console.log(`  ${'Field Avg'.padEnd(10)} ${fieldAvgPoints.toFixed(1).padStart(7)} ${fieldAvgProj.toFixed(1).padStart(6)} ${fieldAvgOwn.toFixed(0).padStart(6)} ${fieldAvg.projectionScore.toFixed(3).padStart(6)} ${fieldAvg.ownershipScore.toFixed(3).padStart(6)} ${fieldAvg.leverageScore.toFixed(3).padStart(6)} ${fieldAvg.ceilingScore.toFixed(3).padStart(6)} ${fieldAvg.salaryEfficiencyScore.toFixed(3).padStart(6)} ${fieldAvg.varianceScore.toFixed(3).padStart(6)} ${fieldAvg.relativeValueScore.toFixed(3).padStart(6)}`);
  console.log(`  ${'─'.repeat(80)}`);

  for (const tier of tiers) {
    const tierEntries = allEntries.filter(e => {
      if (tier.max !== undefined) return e.actualPercentile >= tier.min && e.actualPercentile < tier.max;
      return e.actualPercentile >= tier.min;
    });

    if (tierEntries.length === 0) continue;

    const avgPoints = tierEntries.reduce((s, e) => s + e.entry.points, 0) / tierEntries.length;
    const avgProj = tierEntries.filter(e => e.lineup).reduce((s, e) => s + e.lineup!.projection, 0) / tierEntries.length;
    const avgOwn = tierEntries.filter(e => e.lineup).reduce((s, e) => {
      return s + e.lineup!.players.reduce((os, p) => os + p.ownership, 0);
    }, 0) / tierEntries.length;

    const tierAvg: Record<string, number> = {};
    for (const key of COMPONENT_KEYS) {
      tierAvg[key] = tierEntries.reduce((s, e) => s + e.components[key], 0) / tierEntries.length;
    }

    console.log(`  ${tier.name.padEnd(10)} ${avgPoints.toFixed(1).padStart(7)} ${avgProj.toFixed(1).padStart(6)} ${avgOwn.toFixed(0).padStart(6)} ${tierAvg.projectionScore.toFixed(3).padStart(6)} ${tierAvg.ownershipScore.toFixed(3).padStart(6)} ${tierAvg.leverageScore.toFixed(3).padStart(6)} ${tierAvg.ceilingScore.toFixed(3).padStart(6)} ${tierAvg.salaryEfficiencyScore.toFixed(3).padStart(6)} ${tierAvg.varianceScore.toFixed(3).padStart(6)} ${tierAvg.relativeValueScore.toFixed(3).padStart(6)}`);
  }

  // Show what sets winners apart from the field
  const winners = allEntries.filter(e => e.actualPercentile >= 99);
  if (winners.length > 0) {
    console.log(`\n  WHAT SETS TOP 1% APART FROM FIELD:`);
    const diffs: Array<{ key: string; diff: number }> = [];
    for (const key of COMPONENT_KEYS) {
      const winAvg = winners.reduce((s, e) => s + e.components[key], 0) / winners.length;
      const diff = winAvg - fieldAvg[key];
      diffs.push({ key: key.replace('Score', ''), diff });
    }
    diffs.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
    for (const { key, diff } of diffs) {
      const direction = diff > 0 ? '▲' : '▼';
      const pct = ((diff / fieldAvg[key + 'Score'] || 0) * 100);
      console.log(`    ${direction} ${key.padEnd(20)}: ${diff > 0 ? '+' : ''}${diff.toFixed(4)} (${pct > 0 ? '+' : ''}${pct.toFixed(1)}% vs field)`);
    }

    // Actual points comparison
    const winAvgPoints = winners.reduce((s, e) => s + e.entry.points, 0) / winners.length;
    const winAvgProj = winners.filter(e => e.lineup).reduce((s, e) => s + e.lineup!.projection, 0) / winners.length;
    console.log(`\n    Avg actual points: ${winAvgPoints.toFixed(1)} (field: ${fieldAvgPoints.toFixed(1)}, +${(winAvgPoints - fieldAvgPoints).toFixed(1)})`);
    console.log(`    Avg projection:    ${winAvgProj.toFixed(1)} (field: ${fieldAvgProj.toFixed(1)}, +${(winAvgProj - fieldAvgProj).toFixed(1)})`);
    console.log(`    Points over proj:  +${(winAvgPoints - winAvgProj).toFixed(1)} (field: +${(fieldAvgPoints - fieldAvgProj).toFixed(1)})`);
  }
}

/**
 * Correlate scoring components with actual DK points scored (not finish position).
 * This removes field effects — a 350-point lineup is great regardless of contest.
 */
function analyzeActualPointsCorrelation(results: SlateResult[]): void {
  console.log('\n========================================');
  console.log('ACTUAL POINTS CORRELATION');
  console.log('(What predicts high actual fantasy points?)');
  console.log('========================================');

  const allComponents: ComponentScores[] = [];
  const allPoints: number[] = [];
  const allProjections: number[] = [];

  for (const result of results) {
    for (const se of result.scoredEntries) {
      if (!se.lineup || se.entry.points <= 0) continue;
      allComponents.push(se.components);
      allPoints.push(se.entry.points);
      allProjections.push(se.lineup.projection);
    }
  }

  if (allComponents.length < 100) {
    console.log('  Not enough data for points correlation');
    return;
  }

  console.log(`\n  Points correlation across ${allComponents.length} entries:`);

  // Component correlations with actual points
  const correlations: Array<{ key: string; corr: number }> = [];
  for (const key of COMPONENT_KEYS) {
    const values = allComponents.map(c => c[key]);
    const corr = pearsonCorrelation(values, allPoints);
    correlations.push({ key: key.replace('Score', ''), corr });
  }

  // Also add projection raw correlation
  const projCorr = pearsonCorrelation(allProjections, allPoints);
  correlations.push({ key: 'rawProjection', corr: projCorr });

  correlations.sort((a, b) => b.corr - a.corr);
  for (const { key, corr } of correlations) {
    const sign = corr >= 0 ? '+' : '';
    console.log(`  ${key.padEnd(20)}: ${sign}${corr.toFixed(4)}`);
  }

  // Points vs projection accuracy
  const avgPoints = allPoints.reduce((s, p) => s + p, 0) / allPoints.length;
  const avgProj = allProjections.reduce((s, p) => s + p, 0) / allProjections.length;
  console.log(`\n  Avg actual points: ${avgPoints.toFixed(1)} | Avg projection: ${avgProj.toFixed(1)} | Proj accuracy: ${(projCorr * 100).toFixed(1)}%`);

  // Points over projection distribution
  const overProj = allPoints.map((p, i) => p - allProjections[i]);
  const avgOver = overProj.reduce((s, p) => s + p, 0) / overProj.length;
  const boomRate = overProj.filter(o => o > 30).length / overProj.length;
  const bustRate = overProj.filter(o => o < -30).length / overProj.length;
  console.log(`  Avg points over projection: ${avgOver > 0 ? '+' : ''}${avgOver.toFixed(1)}`);
  console.log(`  Boom rate (30+ over proj): ${(boomRate * 100).toFixed(1)}% | Bust rate (30+ under): ${(bustRate * 100).toFixed(1)}%`);
}

/**
 * Select lineups with diversity enforcement.
 * Mirrors the live selector's approach: greedily pick lineups while
 * tracking player usage counts, skipping lineups with too much overlap.
 * Falls back to raw top-N if diversity filtering would leave us short.
 */
function selectWithDiversity<T extends ScoredEntry>(
  sorted: T[],
  pickCount: number,
): T[] {
  if (sorted.length <= pickCount) return sorted.slice();

  const selected: T[] = [];
  const playerUsage = new Map<string, number>();

  for (const entry of sorted) {
    if (selected.length >= pickCount) break;
    if (!entry.lineup) continue;

    // Check overlap: skip if >60% of players are already at high usage
    if (selected.length > 0) {
      const players = entry.lineup.players;
      const highUsageThreshold = Math.max(1, Math.floor(selected.length * 0.25));
      let highUsagePlayers = 0;
      for (const p of players) {
        if ((playerUsage.get(p.id) ?? 0) >= highUsageThreshold) {
          highUsagePlayers++;
        }
      }
      if (highUsagePlayers / players.length > 0.60) {
        continue; // Too much overlap, skip
      }
    }

    selected.push(entry);
    for (const p of entry.lineup.players) {
      playerUsage.set(p.id, (playerUsage.get(p.id) ?? 0) + 1);
    }
  }

  // Fall back to raw top-N if diversity filtering left us short
  if (selected.length < pickCount) {
    return sorted.slice(0, pickCount);
  }

  return selected;
}

/**
 * Simulate portfolio construction using our formula for each slate.
 * Tests: if we picked the top-scored lineups, how would they actually perform?
 */
function simulatePortfolioPerformance(results: SlateResult[], weights: OptimizedWeights): void {
  console.log('\n========================================');
  console.log('SIMULATED PORTFOLIO PERFORMANCE');
  console.log('(How would our formula\'s picks perform?)');
  console.log('========================================');

  let totalSlates = 0;
  let totalPicks = 0;
  let totalTop1Hits = 0;
  let totalTop5Hits = 0;
  let totalTop10Hits = 0;
  let totalCashHits = 0; // top 22%
  let totalBestFinish = Infinity;
  let totalPickPoints = 0;
  let totalFieldPoints = 0;
  let totalPickEntries = 0;
  let totalFieldEntries = 0;

  // Random baseline for comparison
  let totalRandom1Hits = 0;
  let totalRandomPicks = 0;
  const allUniquePlayerIds = new Set<string>();

  // Per-slate results
  const slateResults: Array<{
    date: string;
    picks: number;
    top1: number;
    top5: number;
    top10: number;
    bestFinish: number;
    avgPickPoints: number;
    avgFieldPoints: number;
  }> = [];

  for (const result of results) {
    const valid = result.scoredEntries.filter(se => se.lineup !== null);
    if (valid.length < 100) continue;

    // Rescore with optimized weights + construction multiplier
    const reScored = valid.map(se => ({
      ...se,
      formulaScore: computeTotalScore(se.components, weights, se.lineup, result.numGames),
    }));

    // Sort by formula score, pick with diversity enforcement
    reScored.sort((a, b) => b.formulaScore - a.formulaScore);
    const pickCount = Math.min(150, Math.max(50, Math.floor(valid.length * 0.01)));
    const picks = selectWithDiversity(reScored, pickCount);

    // Measure actual performance of our picks
    const top1Hits = picks.filter(p => p.actualPercentile >= 99).length;
    const top5Hits = picks.filter(p => p.actualPercentile >= 95).length;
    const top10Hits = picks.filter(p => p.actualPercentile >= 90).length;
    const cashHits = picks.filter(p => p.actualPercentile >= 78).length;
    const bestFinish = Math.min(...picks.map(p => p.entry.rank));
    const avgPickPoints = picks.reduce((s, p) => s + p.entry.points, 0) / picks.length;
    const avgFieldPoints = valid.reduce((s, e) => s + e.entry.points, 0) / valid.length;

    // Random baseline: pick same number randomly, measure top 1% hits
    const actualPickCount = picks.length;
    let randomHits = 0;
    const numTrials = 100;
    for (let t = 0; t < numTrials; t++) {
      const randomPicks: ScoredEntry[] = [];
      const indices = new Set<number>();
      while (indices.size < actualPickCount) {
        indices.add(Math.floor(Math.random() * valid.length));
      }
      for (const idx of indices) {
        randomPicks.push(valid[idx]);
      }
      randomHits += randomPicks.filter(p => p.actualPercentile >= 99).length;
    }
    const avgRandomHits = randomHits / numTrials;

    slateResults.push({
      date: result.date,
      picks: actualPickCount,
      top1: top1Hits,
      top5: top5Hits,
      top10: top10Hits,
      bestFinish,
      avgPickPoints,
      avgFieldPoints,
    });

    totalSlates++;
    totalPicks += pickCount;
    totalTop1Hits += top1Hits;
    totalTop5Hits += top5Hits;
    totalTop10Hits += top10Hits;
    totalCashHits += cashHits;
    if (bestFinish < totalBestFinish) totalBestFinish = bestFinish;
    totalPickPoints += avgPickPoints * pickCount;
    totalFieldPoints += avgFieldPoints * valid.length;
    totalPickEntries += pickCount;
    totalFieldEntries += valid.length;
    totalRandom1Hits += avgRandomHits;
    totalRandomPicks += pickCount;
    for (const p of picks) {
      if (p.lineup) {
        for (const pl of p.lineup.players) {
          allUniquePlayerIds.add(pl.id);
        }
      }
    }
  }

  if (totalSlates === 0) return;

  // Per-slate table
  console.log(`\n  ${'Slate'.padEnd(12)} ${'Picks'.padStart(5)} ${'Top1%'.padStart(6)} ${'Top5%'.padStart(6)} ${'Top10%'.padStart(7)} ${'Best'.padStart(6)} ${'AvgPts'.padStart(7)} ${'Field'.padStart(7)}`);
  console.log(`  ${'─'.repeat(62)}`);

  for (const sr of slateResults) {
    console.log(`  ${sr.date.padEnd(12)} ${String(sr.picks).padStart(5)} ${String(sr.top1).padStart(6)} ${String(sr.top5).padStart(6)} ${String(sr.top10).padStart(7)} ${('#' + sr.bestFinish).padStart(6)} ${sr.avgPickPoints.toFixed(1).padStart(7)} ${sr.avgFieldPoints.toFixed(1).padStart(7)}`);
  }

  // Aggregate summary
  const top1Rate = totalTop1Hits / totalPicks;
  const top5Rate = totalTop5Hits / totalPicks;
  const top10Rate = totalTop10Hits / totalPicks;
  const cashRate = totalCashHits / totalPicks;
  const randomTop1Rate = totalRandom1Hits / totalRandomPicks;
  const avgPickPts = totalPickPoints / totalPickEntries;
  const avgFieldPts = totalFieldPoints / totalFieldEntries;

  console.log(`\n  AGGREGATE RESULTS (${totalSlates} slates, ${totalPicks} total picks):`);
  console.log(`    Top 1% hit rate:  ${(top1Rate * 100).toFixed(2)}% (${totalTop1Hits}/${totalPicks}) — random baseline: ${(randomTop1Rate * 100).toFixed(2)}% — ${(top1Rate / Math.max(0.001, randomTop1Rate)).toFixed(1)}x better`);
  console.log(`    Top 5% hit rate:  ${(top5Rate * 100).toFixed(2)}% (${totalTop5Hits}/${totalPicks})`);
  console.log(`    Top 10% hit rate: ${(top10Rate * 100).toFixed(2)}% (${totalTop10Hits}/${totalPicks})`);
  console.log(`    Cash rate:        ${(cashRate * 100).toFixed(2)}% (${totalCashHits}/${totalPicks})`);
  console.log(`    Best finish:      #${totalBestFinish}`);
  console.log(`    Avg pick points:  ${avgPickPts.toFixed(1)} vs field avg ${avgFieldPts.toFixed(1)} (+${(avgPickPts - avgFieldPts).toFixed(1)})`);
  console.log(`    Unique players:   ${allUniquePlayerIds.size} across ${totalPicks} picks`);
}

/**
 * Enhanced pro analysis showing portfolio construction details
 * and how their approach compares to our formula's picks.
 */
function analyzeProPortfolios(results: SlateResult[], weights: OptimizedWeights): void {
  console.log('\n========================================');
  console.log('PRO PORTFOLIO DEEP DIVE');
  console.log('========================================');

  // Collect all valid entries for field baseline
  const allValid: ScoredEntry[] = [];
  for (const result of results) {
    for (const se of result.scoredEntries) {
      if (se.lineup) allValid.push(se);
    }
  }
  if (allValid.length === 0) return;

  const fieldAvgPoints = allValid.reduce((s, e) => s + e.entry.points, 0) / allValid.length;
  const fieldAvgProj = allValid.reduce((s, e) => s + e.lineup!.projection, 0) / allValid.length;
  const fieldAvgOwn = allValid.reduce((s, e) => {
    return s + e.lineup!.players.reduce((os, p) => os + p.ownership, 0);
  }, 0) / allValid.length;

  // Get our formula's top picks for comparison
  const formulaPicks: ScoredEntry[] = [];
  for (const result of results) {
    const valid = result.scoredEntries.filter(se => se.lineup !== null);
    const reScored = valid.map(se => ({
      ...se,
      formulaScore: computeTotalScore(se.components, weights, se.lineup, result.numGames),
    }));
    reScored.sort((a, b) => b.formulaScore - a.formulaScore);
    const pickCount = Math.min(150, Math.max(50, Math.floor(valid.length * 0.01)));
    formulaPicks.push(...selectWithDiversity(reScored, pickCount));
  }

  const formulaAvgProj = formulaPicks.length > 0
    ? formulaPicks.reduce((s, e) => s + e.lineup!.projection, 0) / formulaPicks.length : 0;
  const formulaAvgOwn = formulaPicks.length > 0
    ? formulaPicks.reduce((s, e) => s + e.lineup!.players.reduce((os, p) => os + p.ownership, 0), 0) / formulaPicks.length : 0;
  const formulaAvgPoints = formulaPicks.length > 0
    ? formulaPicks.reduce((s, e) => s + e.entry.points, 0) / formulaPicks.length : 0;

  // Collect pro entries
  const proEntries = new Map<string, ScoredEntry[]>();
  for (const result of results) {
    for (const se of result.scoredEntries) {
      if (!se.lineup || !isTrackedPro(se.entry.username)) continue;
      const key = se.entry.username.toLowerCase();
      if (!proEntries.has(key)) proEntries.set(key, []);
      proEntries.get(key)!.push(se);
    }
  }

  // Sort pros by avg rank
  const proNames = [...proEntries.keys()].sort((a, b) => {
    const aEntries = proEntries.get(a)!;
    const bEntries = proEntries.get(b)!;
    const aAvg = aEntries.reduce((s, e) => s + e.entry.rank, 0) / aEntries.length;
    const bAvg = bEntries.reduce((s, e) => s + e.entry.rank, 0) / bEntries.length;
    return aAvg - bAvg;
  });

  // Show our formula's picks as baseline
  console.log(`\n  OUR FORMULA'S PICKS (${formulaPicks.length} total across ${results.length} slates):`);
  console.log(`    Avg projection:  ${formulaAvgProj.toFixed(1)} (field: ${fieldAvgProj.toFixed(1)})`);
  console.log(`    Avg ownership:   ${formulaAvgOwn.toFixed(0)}% (field: ${fieldAvgOwn.toFixed(0)}%)`);
  console.log(`    Avg actual pts:  ${formulaAvgPoints.toFixed(1)} (field: ${fieldAvgPoints.toFixed(1)})`);

  // Formula component averages
  const formulaCompAvg: Record<string, number> = {};
  for (const key of COMPONENT_KEYS) {
    formulaCompAvg[key] = formulaPicks.reduce((s, e) => s + e.components[key], 0) / formulaPicks.length;
  }

  // Show top 3 pros in detail
  console.log(`\n  PRO COMPARISON (vs our formula's picks):`);
  console.log(`  ${''.padEnd(15)} ${'Entries'.padStart(7)} ${'AvgProj'.padStart(7)} ${'Own%'.padStart(6)} ${'ActPts'.padStart(7)} ${'Top1%'.padStart(6)} ${'Top10%'.padStart(7)} ${'UniqPl'.padStart(6)}`);
  console.log(`  ${'─'.repeat(65)}`);

  // Our formula row
  const formulaTop1 = formulaPicks.filter(e => e.actualPercentile >= 99).length;
  const formulaTop10 = formulaPicks.filter(e => e.actualPercentile >= 90).length;
  const formulaUniquePlayers = new Set(formulaPicks.flatMap(e => e.lineup!.players.map(p => p.id))).size;
  console.log(`  ${'OUR FORMULA'.padEnd(15)} ${String(formulaPicks.length).padStart(7)} ${formulaAvgProj.toFixed(1).padStart(7)} ${formulaAvgOwn.toFixed(0).padStart(6)} ${formulaAvgPoints.toFixed(1).padStart(7)} ${(formulaTop1 / formulaPicks.length * 100).toFixed(1).padStart(5)}% ${(formulaTop10 / formulaPicks.length * 100).toFixed(1).padStart(6)}% ${String(formulaUniquePlayers).padStart(6)}`);

  for (const proName of proNames) {
    const entries = proEntries.get(proName)!;
    if (entries.length < 10) continue;

    const avgProj = entries.reduce((s, e) => s + e.lineup!.projection, 0) / entries.length;
    const avgOwn = entries.reduce((s, e) => s + e.lineup!.players.reduce((os, p) => os + p.ownership, 0), 0) / entries.length;
    const avgPoints = entries.reduce((s, e) => s + e.entry.points, 0) / entries.length;
    const top1 = entries.filter(e => e.actualPercentile >= 99).length;
    const top10 = entries.filter(e => e.actualPercentile >= 90).length;
    const uniquePlayers = new Set(entries.flatMap(e => e.lineup!.players.map(p => p.id))).size;

    console.log(`  ${proName.padEnd(15)} ${String(entries.length).padStart(7)} ${avgProj.toFixed(1).padStart(7)} ${avgOwn.toFixed(0).padStart(6)} ${avgPoints.toFixed(1).padStart(7)} ${(top1 / entries.length * 100).toFixed(1).padStart(5)}% ${(top10 / entries.length * 100).toFixed(1).padStart(6)}% ${String(uniquePlayers).padStart(6)}`);
  }

  // Show component comparison for top pro (zroth2)
  const topPro = proNames.find(n => proEntries.get(n)!.length >= 100);
  if (topPro) {
    const entries = proEntries.get(topPro)!;
    console.log(`\n  COMPONENT COMPARISON: ${topPro} vs Our Formula vs Field:`);
    console.log(`  ${'Component'.padEnd(20)} ${'Pro'.padStart(7)} ${'Formula'.padStart(8)} ${'Field'.padStart(7)} ${'Pro-Field'.padStart(10)}`);
    console.log(`  ${'─'.repeat(55)}`);

    const fieldCompAvg: Record<string, number> = {};
    for (const key of COMPONENT_KEYS) {
      fieldCompAvg[key] = allValid.reduce((s, e) => s + e.components[key], 0) / allValid.length;
    }

    for (const key of COMPONENT_KEYS) {
      const proAvg = entries.reduce((s, e) => s + e.components[key], 0) / entries.length;
      const fmlAvg = formulaCompAvg[key];
      const fldAvg = fieldCompAvg[key];
      const diff = proAvg - fldAvg;
      const label = key.replace('Score', '').padEnd(20);
      console.log(`  ${label} ${proAvg.toFixed(3).padStart(7)} ${fmlAvg.toFixed(3).padStart(8)} ${fldAvg.toFixed(3).padStart(7)} ${(diff > 0 ? '+' : '') + diff.toFixed(3).padStart(9)}`);
    }
  }
}

// ============================================================
// ============================================================
// SIMPLE SELECTION — Score by formula, sort, greedy pick
// Bypasses all complex selection (sim, diversity, chalk penalty)
// ============================================================

interface SimpleSelectedLineup extends Lineup {
  totalScore: number;
  projectionScore: number;
  ceilingScore: number;
  varianceScore: number;
  salaryEfficiencyScore: number;
  relativeValueScore: number;
  gameStackScore: number;
}

function simpleSelectFromPool(
  lineups: Lineup[],
  targetCount: number,
  weights: OptimizedWeights,
  numGames: number,
): { selected: SimpleSelectedLineup[] } {
  if (lineups.length === 0) return { selected: [] };

  // Compute pool-level stats
  const projections = lineups.map(l => l.projection);
  let minProj = Infinity, maxProj = -Infinity;
  for (const p of projections) { if (p > maxProj) maxProj = p; if (p < minProj) minProj = p; }
  const optimalProjection = maxProj;

  // Optimal ownership = ownership of highest-projection lineup
  let optIdx = 0;
  for (let i = 1; i < lineups.length; i++) {
    if (lineups[i].projection > lineups[optIdx].projection) optIdx = i;
  }
  const optimalOwnership = calculateOwnershipSum(lineups[optIdx]);

  // Ceiling range for normalization
  let poolMinCeil = Infinity, poolMaxCeil = -Infinity;
  for (const l of lineups) {
    const vd = calculateVarianceScore(l);
    if (vd.ceiling < poolMinCeil) poolMinCeil = vd.ceiling;
    if (vd.ceiling > poolMaxCeil) poolMaxCeil = vd.ceiling;
  }
  const ceilingRange = poolMaxCeil - poolMinCeil;

  // Score each lineup
  const scored: SimpleSelectedLineup[] = lineups.map(l => {
    const projectionScore = normalizeProjectionScore(l.projection, minProj, maxProj);
    const varianceData = calculateVarianceScore(l);
    const relValue = calculateRelativeValue(l, optimalProjection, optimalOwnership);

    const ceilingScore = ceilingRange > 0
      ? Math.max(0, Math.min(1, (varianceData.ceiling - poolMinCeil) / ceilingRange))
      : 0.5;

    const salaryLeft = 50000 - l.salary;
    const x = Math.min(1, salaryLeft / 1800);
    const salaryEfficiencyScore = Math.max(0.1, 1 - x * x);

    const gameStackScore = computeGameStackScore(l, numGames);

    const components: ComponentScores = {
      projectionScore,
      ownershipScore: 0,
      leverageScore: 0,
      varianceScore: varianceData.score,
      relativeValueScore: relValue.relativeValueScore,
      ceilingScore,
      salaryEfficiencyScore,
      antiCorrelationScore: 0,
      projectionEdgeScore: 0,
      gameStackScore,
      ceilingRatioScore: calculateCeilingRatioScore(l),
      gameEnvironmentScore: calculateGameEnvironmentScore(l),
    };

    const totalScore = computeTotalScore(components, weights, l, numGames);

    return {
      ...l,
      totalScore,
      projectionScore,
      ceilingScore,
      varianceScore: varianceData.score,
      salaryEfficiencyScore,
      relativeValueScore: relValue.relativeValueScore,
      gameStackScore,
    };
  });

  // Sort by totalScore descending
  scored.sort((a, b) => b.totalScore - a.totalScore);

  // Greedy pick with player exposure cap
  const selected: SimpleSelectedLineup[] = [];
  const playerCounts = new Map<string, number>();
  const MAX_EXPOSURE = 0.40;  // Soft cap: no player in >40% of lineups

  for (const lineup of scored) {
    if (selected.length >= targetCount) break;

    // Check exposure — would any player exceed cap?
    let ok = true;
    const currentSize = selected.length + 1;
    for (const p of lineup.players) {
      const count = (playerCounts.get(p.id) || 0) + 1;
      if (count / currentSize > MAX_EXPOSURE && selected.length >= 20) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    selected.push(lineup);
    for (const p of lineup.players) {
      playerCounts.set(p.id, (playerCounts.get(p.id) || 0) + 1);
    }
  }

  return { selected };
}

// ============================================================
// FULL PIPELINE BACKTEST
// Replays the entire optimizer+selector pipeline against each
// historical slate and evaluates against actual contest results.
// ============================================================

function runFullPipelineBacktest(
  dataDir: string,
  slates: Array<{ date: string; projFile: string; actualsFile: string }>,
  sport: Sport,
  site: DFSSite,
  options?: { cachePool?: boolean; fromCache?: boolean; simpleSelect?: boolean; noChalk?: boolean; backtestFast?: boolean },
): void {
  const useSimpleSelect = options?.simpleSelect !== false;  // Default: true (simple selector)
  const useNoChalk = options?.noChalk ?? false;
  const useFast = options?.backtestFast ?? false;
  console.log('\n========================================');
  console.log(`FULL PIPELINE BACKTEST${useSimpleSelect ? ' (SIMPLE SELECT)' : ''}${useNoChalk ? ' (NO CHALK PENALTY)' : ''}`);
  console.log('(Generate lineups → rank against actual contest field)');
  console.log('========================================');
  if (useSimpleSelect) {
    console.log('  Mode: SIMPLE — score by formula, sort, greedy pick (no sim/diversity/chalk penalty)');
  }

  const POOL_SIZE = useFast ? 15000 : 25000;
  if (useFast) {
    console.log('  ⚡ FAST MODE: pool=50K, iterations=80');
  }
  const TARGET_COUNT = 500;
  const contestType: ContestType = 'classic';
  const config = getContestConfig(site, sport, contestType);

  // Aggregate tracking
  let totalSlates = 0;
  let totalSelected = 0;
  let totalTop1 = 0;
  let totalTop5 = 0;
  let totalTop10 = 0;
  let totalCash = 0;
  let overallBestFinish = Infinity;
  let totalActualPoints = 0;
  let totalFieldPoints = 0;
  let totalFieldEntries = 0;
  const allUniquePlayerIds = new Set<string>();

  // Collect contest entries per slate for pro comparison
  const allSlateContestEntries: Array<{ date: string; entries: ContestEntry[] }> = [];

  // Hit/miss profile collection for pattern analysis
  interface HitProfile {
    date: string;
    actualPts: number;
    projPts: number;
    percentile: number;
    rank: number;
    isTop1: boolean;
    isTop5: boolean;
    isTop10: boolean;
    isCash: boolean;
    // Player characteristics
    avgOwnership: number;
    geoMeanOwnership: number;
    avgSalary: number;
    salaryUsed: number;
    numPlayersAboveProj: number;    // players scoring above their projection
    biggestBoom: number;            // max (actual - proj) for any player
    biggestBoomOwn: number;         // ownership of biggest boom player
    biggestBoomSalary: number;      // salary of biggest boom player
    biggestBoomPos: string;         // position of biggest boom player
    // Stack structure
    maxSameTeam: number;            // largest same-team group
    numTeams: number;               // distinct teams in lineup
    numGames: number;               // distinct games in lineup
    // Ceiling profile
    projPctOfOptimal: number;       // projection / slate optimal
    ceilingSum: number;             // sum of player ceilings
    ceilingRatio: number;           // ceiling / projection
  }
  const allProfiles: HitProfile[] = [];

  const slateResults: Array<{
    date: string;
    poolSize: number;
    selected: number;
    avgActual: number;
    top1: number;
    top5: number;
    top10: number;
    bestFinish: number;
    uniquePlayers: number;
    fieldAvg: number;
  }> = [];

  // Process all slates for comprehensive evaluation
  const slatesToProcess = slates;

  for (const slate of slatesToProcess) {
    console.log(`\n  Processing ${slate.date}...`);

    // 1. Parse projections CSV using the standard pipeline parser
    const projPath = path.join(dataDir, slate.projFile);
    let parseResult;
    try {
      parseResult = parseCSVFile(projPath, sport);
    } catch (e) {
      console.log(`    Skipping — failed to parse projections: ${e}`);
      continue;
    }
    if (parseResult.players.length < 20) {
      console.log(`    Skipping — only ${parseResult.players.length} players`);
      continue;
    }

    // 2. Build player pool for the optimizer
    const pool = buildPlayerPool(parseResult.players, contestType);

    // 3. Load player actuals (name → actual DK FPTS)
    const playerData = loadProjections(dataDir, slate.projFile);
    const actualsById = new Map<string, number>();
    const actualsByName = new Map<string, number>();
    for (const [nameLower, pd] of playerData) {
      if (pd.actual > 0) {
        actualsById.set(pd.id, pd.actual);
        actualsByName.set(nameLower, pd.actual);
      }
    }

    // 4. Load contest entries for ranking
    const contestEntries = loadActuals(dataDir, slate.actualsFile);
    if (contestEntries.length < 100) {
      console.log(`    Skipping — only ${contestEntries.length} contest entries`);
      continue;
    }
    allSlateContestEntries.push({ date: slate.date, entries: contestEntries });
    const contestPoints = contestEntries.map(e => e.points).sort((a, b) => b - a);
    const fieldAvgPoints = contestPoints.reduce((s, p) => s + p, 0) / contestPoints.length;

    // 5. Count distinct games from pool data
    const gameSet = new Set<string>();
    for (const p of pool.players) {
      if (p.gameInfo) {
        gameSet.add(p.gameInfo);
      } else if (p.team) {
        gameSet.add(p.team); // fallback: count teams / 2 later
      }
    }
    const numGames = gameSet.size > 0
      ? (pool.players[0]?.gameInfo ? gameSet.size : Math.ceil(gameSet.size / 2))
      : 5;

    // 6. Selectively suppress console output during pipeline (keep progress)
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = (...args: any[]) => {
      const msg = String(args[0] || '');
      if (msg.includes('Iter ') || msg.includes('Generated') ||
          msg.includes('Selected:') || msg.includes('PHASE') ||
          msg.includes('Pool size:') || msg.includes('Target:') ||
          msg.includes('Stack enumeration') || msg.includes('Pool quality')) {
        originalLog(`    [${slate.date}]`, ...args);
      }
    };
    console.warn = () => {};

    let optResult;
    let selResult;

    // Pool caching support
    const cacheDir = path.join(dataDir, 'cached_pools');
    const poolCachePath = path.join(cacheDir, `${slate.date}_pool.json`);
    const useCache = options?.fromCache && fs.existsSync(poolCachePath);

    try {
      if (useCache) {
        // Load cached pool instead of regenerating
        const cached = JSON.parse(fs.readFileSync(poolCachePath, 'utf-8'));
        optResult = { lineups: cached.lineups as Lineup[], optimalLineup: cached.lineups[0] as Lineup };
        originalLog(`    [${slate.date}] Loaded ${cached.lineups.length} lineups from cache`);
      } else {
        optResult = optimizeLineups({ config, pool, poolSize: POOL_SIZE, backtestFast: useFast });
      }

      // Save pool cache if requested
      if (options?.cachePool && !useCache) {
        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
        const poolData = {
          date: slate.date,
          lineups: optResult.lineups.map((l: Lineup) => ({
            players: l.players.map(p => ({
              id: p.id, name: p.name, position: p.position, team: p.team,
              salary: p.salary, projection: p.projection, ownership: p.ownership,
              ceiling: p.ceiling, ceiling99: p.ceiling99, gameTotal: p.gameTotal,
              index: p.index, positions: p.positions, value: p.value,
              percentiles: p.percentiles, gameInfo: p.gameInfo,
            })),
            salary: l.salary, projection: l.projection, ownership: l.ownership,
            hash: l.hash, constructionMethod: l.constructionMethod,
          })),
        };
        fs.writeFileSync(poolCachePath, JSON.stringify(poolData));
        originalLog(`    [${slate.date}] Cached ${optResult.lineups.length} lineups to ${poolCachePath}`);
      }

      if (useSimpleSelect) {
        // Simple formula-based selection with field ensemble + combo leverage
        selResult = selectLineupsSimple({
          lineups: optResult.lineups,
          targetCount: TARGET_COUNT,
          numGames,
          salaryCap: config.salaryCap,
          sport,
          players: pool.players,
          contestSize: '20max',
        });
      } else {
        selResult = selectLineups({
          lineups: optResult.lineups,
          targetCount: TARGET_COUNT,
          maxExposure: 0.5,
          projectionWeight: 0.4,
          leverageWeight: 0.25,
          ownershipWeight: 0.15,
          diversityWeight: 0.2,
          sport: sport,
          simMode: 'none',  // Pure heuristic — skip all simulation overhead
          numGames: numGames,
          contestSize: '20max',
          skipChalkPenalty: useNoChalk,
        });
      }
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
    }

    // Pool quality diagnostic: compare formula scores of our selected lineups vs contest field
    {
      const weights = DEFAULT_WEIGHTS_COPY;
      // Score our selected pool lineups using the same formula
      const poolFormScores: number[] = [];
      let poolMinProj = Infinity, poolMaxProj = -Infinity;
      for (const l of optResult.lineups) {
        if (l.projection < poolMinProj) poolMinProj = l.projection;
        if (l.projection > poolMaxProj) poolMaxProj = l.projection;
      }
      const poolOptProj = poolMaxProj;
      const poolOptIdx = optResult.lineups.findIndex(l => l.projection === poolMaxProj);
      const poolOptOwn = calculateOwnershipSum(optResult.lineups[poolOptIdx >= 0 ? poolOptIdx : 0]);

      // Ceiling range
      let pMinCeil = Infinity, pMaxCeil = -Infinity;
      for (const l of selResult.selected) {
        const vd = calculateVarianceScore(l);
        if (vd.ceiling < pMinCeil) pMinCeil = vd.ceiling;
        if (vd.ceiling > pMaxCeil) pMaxCeil = vd.ceiling;
      }
      const pCeilRange = pMaxCeil - pMinCeil;

      for (const l of selResult.selected) {
        const pScore = normalizeProjectionScore(l.projection, poolMinProj, poolMaxProj);
        const vd = calculateVarianceScore(l);
        const rv = calculateRelativeValue(l, poolOptProj, poolOptOwn);
        const cScore = pCeilRange > 0 ? Math.max(0, Math.min(1, (vd.ceiling - pMinCeil) / pCeilRange)) : 0.5;
        const salLeft = 50000 - l.salary;
        const sx = Math.min(1, salLeft / 1800);
        const seScore = Math.max(0.1, 1 - sx * sx);
        // Game stack
        let gsScore = computeGameStackScore(l, numGames);
        const crScore = calculateCeilingRatioScore(l);
        const geScore = calculateGameEnvironmentScore(l);
        const baseS = pScore * weights.projectionScore + cScore * weights.ceilingScore + vd.score * weights.varianceScore + seScore * weights.salaryEfficiencyScore + rv.relativeValueScore * weights.relativeValueScore + crScore * (weights.ceilingRatioScore || 0) + geScore * (weights.gameEnvironmentScore || 0);
        const pgGate = Math.min(1, pScore / (weights.projGateThreshold || 0.50));
        const cgGate = Math.min(1, cScore / (weights.ceilGateThreshold || 0.40));
        const qGate = Math.sqrt(pgGate * cgGate);
        poolFormScores.push(baseS * qGate * (1 + gsScore));
      }

      // Score contest field entries the same way
      const fieldFormScores: number[] = [];
      // Reconstruct field lineups from contest entries and score them
      // We already have contestEntries — use their actual scores as a proxy
      // (full scoring would require lineup reconstruction which is expensive)
      // Instead compare pool totalScore distribution vs what simulated portfolio achieves

      poolFormScores.sort((a, b) => b - a);
      const topN = Math.min(poolFormScores.length, 500);
      const poolAvgForm = poolFormScores.slice(0, topN).reduce((s, v) => s + v, 0) / topN;
      const poolMedianForm = poolFormScores[Math.floor(poolFormScores.length / 2)] || 0;
      console.log(`    [${slate.date}] Pool quality: top-${topN} avg formula=${poolAvgForm.toFixed(4)}, median=${poolMedianForm.toFixed(4)}, selected=${selResult.selected.length}`);
    }

    // 6. Calculate actual points for each selected lineup
    const lineupActuals: Array<{ actualPoints: number; rank: number; percentile: number }> = [];
    const slateUniquePlayers = new Set<string>();

    for (const lineup of selResult.selected) {
      let actualTotal = 0;
      let allMatched = true;
      for (const p of lineup.players) {
        const actual = actualsById.get(p.id) ?? actualsByName.get(p.name.toLowerCase());
        if (actual !== undefined) {
          actualTotal += actual;
        } else {
          allMatched = false;
        }
        allUniquePlayerIds.add(p.id);
        slateUniquePlayers.add(p.id);
      }

      if (!allMatched) continue;

      // 7. Rank against contest field (binary search in sorted descending array)
      let rank = 1;
      let lo = 0, hi = contestPoints.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (contestPoints[mid] > actualTotal) {
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      rank = lo + 1; // 1-indexed rank
      const percentile = (1 - (rank - 1) / contestPoints.length) * 100;

      lineupActuals.push({ actualPoints: actualTotal, rank, percentile });

      // Build hit profile for pattern analysis
      const optimalProj = optResult.lineups.reduce((m, l) => Math.max(m, l.projection), 0);
      let biggestBoom = -Infinity, biggestBoomOwn = 0, biggestBoomSalary = 0, biggestBoomPos = '';
      let numAboveProj = 0;
      let ceilSum = 0;
      const teamCounts = new Map<string, number>();
      const gameCounts = new Set<string>();
      let ownSum = 0, ownProduct = 1, salarySum = 0;

      for (const p of lineup.players) {
        const pActual = actualsById.get(p.id) ?? actualsByName.get(p.name.toLowerCase()) ?? 0;
        const boom = pActual - p.projection;
        if (boom > biggestBoom) {
          biggestBoom = boom;
          biggestBoomOwn = p.ownership;
          biggestBoomSalary = p.salary;
          biggestBoomPos = p.positions?.[0] || p.position || '?';
        }
        if (pActual > p.projection) numAboveProj++;
        ceilSum += (p.ceiling || p.projection * 1.25);
        teamCounts.set(p.team, (teamCounts.get(p.team) || 0) + 1);
        gameCounts.add(p.gameInfo || p.team);
        ownSum += p.ownership;
        ownProduct *= Math.max(0.1, p.ownership) / 100;
        salarySum += p.salary;
      }
      const n = lineup.players.length;
      allProfiles.push({
        date: slate.date,
        actualPts: actualTotal,
        projPts: lineup.projection,
        percentile,
        rank,
        isTop1: percentile >= 99,
        isTop5: percentile >= 95,
        isTop10: percentile >= 90,
        isCash: percentile >= 78,
        avgOwnership: ownSum / n,
        geoMeanOwnership: Math.pow(ownProduct, 1 / n) * 100,
        avgSalary: salarySum / n,
        salaryUsed: salarySum,
        numPlayersAboveProj: numAboveProj,
        biggestBoom,
        biggestBoomOwn,
        biggestBoomSalary,
        biggestBoomPos,
        maxSameTeam: Math.max(...teamCounts.values()),
        numTeams: teamCounts.size,
        numGames: gameCounts.size,
        projPctOfOptimal: lineup.projection / optimalProj,
        ceilingSum: ceilSum,
        ceilingRatio: ceilSum / Math.max(1, lineup.projection),
      });
    }

    if (lineupActuals.length === 0) {
      console.log(`    Skipping — no lineups matched actuals`);
      continue;
    }

    // 8. Compute per-slate stats
    const avgActual = lineupActuals.reduce((s, l) => s + l.actualPoints, 0) / lineupActuals.length;
    const top1 = lineupActuals.filter(l => l.percentile >= 99).length;
    const top5 = lineupActuals.filter(l => l.percentile >= 95).length;
    const top10 = lineupActuals.filter(l => l.percentile >= 90).length;
    const cash = lineupActuals.filter(l => l.percentile >= 78).length;
    const bestFinish = Math.min(...lineupActuals.map(l => l.rank));

    slateResults.push({
      date: slate.date,
      poolSize: optResult.lineups.length,
      selected: lineupActuals.length,
      avgActual,
      top1,
      top5,
      top10,
      bestFinish,
      uniquePlayers: slateUniquePlayers.size,
      fieldAvg: fieldAvgPoints,
    });

    totalSlates++;
    totalSelected += lineupActuals.length;
    totalTop1 += top1;
    totalTop5 += top5;
    totalTop10 += top10;
    totalCash += cash;
    if (bestFinish < overallBestFinish) overallBestFinish = bestFinish;
    totalActualPoints += avgActual * lineupActuals.length;
    totalFieldPoints += fieldAvgPoints * contestEntries.length;
    totalFieldEntries += contestEntries.length;

    console.log(`    Pool: ${optResult.lineups.length} → Selected: ${lineupActuals.length} | Top1%: ${top1} | Best: #${bestFinish} | AvgActual: ${avgActual.toFixed(1)} | UniqPl: ${slateUniquePlayers.size}`);
  }

  if (totalSlates === 0) {
    console.log('\n  No slates completed full pipeline backtest.');
    return;
  }

  // Per-slate table
  console.log(`\n  ${'Slate'.padEnd(12)} ${'Pool'.padStart(6)} ${'Sel'.padStart(5)} ${'AvgAct'.padStart(7)} ${'Field'.padStart(7)} ${'Top1%'.padStart(6)} ${'Top5%'.padStart(6)} ${'Top10%'.padStart(7)} ${'Best'.padStart(6)} ${'UniqPl'.padStart(7)}`);
  console.log(`  ${'─'.repeat(75)}`);

  for (const sr of slateResults) {
    console.log(`  ${sr.date.padEnd(12)} ${String(sr.poolSize).padStart(6)} ${String(sr.selected).padStart(5)} ${sr.avgActual.toFixed(1).padStart(7)} ${sr.fieldAvg.toFixed(1).padStart(7)} ${String(sr.top1).padStart(6)} ${String(sr.top5).padStart(6)} ${String(sr.top10).padStart(7)} ${('#' + sr.bestFinish).padStart(6)} ${String(sr.uniquePlayers).padStart(7)}`);
  }

  // Aggregate summary
  const top1Rate = totalTop1 / totalSelected;
  const top5Rate = totalTop5 / totalSelected;
  const top10Rate = totalTop10 / totalSelected;
  const cashRate = totalCash / totalSelected;
  const avgActualPts = totalActualPoints / totalSelected;
  const avgFieldPts = totalFieldPoints / totalFieldEntries;

  console.log(`\n  FULL PIPELINE AGGREGATE (${totalSlates} slates, ${totalSelected} generated lineups):`);
  console.log(`    Top 1% hit rate:  ${(top1Rate * 100).toFixed(2)}% (${totalTop1}/${totalSelected})`);
  console.log(`    Top 5% hit rate:  ${(top5Rate * 100).toFixed(2)}% (${totalTop5}/${totalSelected})`);
  console.log(`    Top 10% hit rate: ${(top10Rate * 100).toFixed(2)}% (${totalTop10}/${totalSelected})`);
  console.log(`    Cash rate:        ${(cashRate * 100).toFixed(2)}% (${totalCash}/${totalSelected})`);
  console.log(`    Best finish:      #${overallBestFinish}`);
  console.log(`    Avg actual pts:   ${avgActualPts.toFixed(1)} vs field avg ${avgFieldPts.toFixed(1)} (+${(avgActualPts - avgFieldPts).toFixed(1)})`);
  console.log(`    Unique players:   ${allUniquePlayerIds.size} across ${totalSelected} lineups`);

  // ============================================================
  // HIT/MISS PATTERN ANALYSIS
  // ============================================================
  if (allProfiles.length > 0) {
    const hits = allProfiles.filter(p => p.isTop1);
    const top5hits = allProfiles.filter(p => p.isTop5 && !p.isTop1);
    const misses = allProfiles.filter(p => !p.isTop10);
    const n = allProfiles.length;

    console.log(`\n  ========================================`);
    console.log(`  HIT/MISS PATTERN ANALYSIS (${n} lineups)`);
    console.log(`  ========================================`);
    console.log(`  Top 1% hits: ${hits.length} | Top 5%: ${top5hits.length} | Below top 10%: ${misses.length}\n`);

    const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const pct = (arr: boolean[]) => arr.length > 0 ? arr.filter(Boolean).length / arr.length * 100 : 0;

    const metrics: Array<{ name: string; hitVal: number; missVal: number; format: string }> = [
      { name: 'Proj % of optimal', hitVal: avg(hits.map(h => h.projPctOfOptimal * 100)), missVal: avg(misses.map(m => m.projPctOfOptimal * 100)), format: '.1' },
      { name: 'Actual - Proj delta', hitVal: avg(hits.map(h => h.actualPts - h.projPts)), missVal: avg(misses.map(m => m.actualPts - m.projPts)), format: '.1' },
      { name: 'Ceiling ratio', hitVal: avg(hits.map(h => h.ceilingRatio)), missVal: avg(misses.map(m => m.ceilingRatio)), format: '.3' },
      { name: 'Avg ownership', hitVal: avg(hits.map(h => h.avgOwnership)), missVal: avg(misses.map(m => m.avgOwnership)), format: '.1' },
      { name: 'GeoMean ownership', hitVal: avg(hits.map(h => h.geoMeanOwnership)), missVal: avg(misses.map(m => m.geoMeanOwnership)), format: '.1' },
      { name: 'Salary used', hitVal: avg(hits.map(h => h.salaryUsed)), missVal: avg(misses.map(m => m.salaryUsed)), format: '.0' },
      { name: 'Players above proj', hitVal: avg(hits.map(h => h.numPlayersAboveProj)), missVal: avg(misses.map(m => m.numPlayersAboveProj)), format: '.1' },
      { name: 'Biggest boom (pts)', hitVal: avg(hits.map(h => h.biggestBoom)), missVal: avg(misses.map(m => m.biggestBoom)), format: '.1' },
      { name: 'Biggest boom own%', hitVal: avg(hits.map(h => h.biggestBoomOwn)), missVal: avg(misses.map(m => m.biggestBoomOwn)), format: '.1' },
      { name: 'Biggest boom salary', hitVal: avg(hits.map(h => h.biggestBoomSalary)), missVal: avg(misses.map(m => m.biggestBoomSalary)), format: '.0' },
      { name: 'Max same-team count', hitVal: avg(hits.map(h => h.maxSameTeam)), missVal: avg(misses.map(m => m.maxSameTeam)), format: '.1' },
      { name: 'Distinct teams', hitVal: avg(hits.map(h => h.numTeams)), missVal: avg(misses.map(m => m.numTeams)), format: '.1' },
      { name: 'Distinct games', hitVal: avg(hits.map(h => h.numGames)), missVal: avg(misses.map(m => m.numGames)), format: '.1' },
    ];

    console.log(`  ${'Metric'.padEnd(28)} ${'Top1% Hits'.padStart(12)} ${'Below T10%'.padStart(12)} ${'Delta'.padStart(10)} ${'Signal'.padStart(8)}`);
    console.log(`  ${'─'.repeat(72)}`);
    for (const m of metrics) {
      const delta = m.hitVal - m.missVal;
      const pctDelta = m.missVal !== 0 ? Math.abs(delta / m.missVal) * 100 : 0;
      const signal = pctDelta > 15 ? '***' : pctDelta > 8 ? '**' : pctDelta > 3 ? '*' : '';
      const fmt = (v: number) => m.format === '.0' ? v.toFixed(0) : m.format === '.1' ? v.toFixed(1) : v.toFixed(3);
      console.log(`  ${m.name.padEnd(28)} ${fmt(m.hitVal).padStart(12)} ${fmt(m.missVal).padStart(12)} ${(delta >= 0 ? '+' : '') + fmt(delta)}`.padEnd(65) + signal.padStart(8));
    }

    // Boom player position breakdown
    console.log(`\n  Biggest boom player position distribution:`);
    const hitBoomPos = new Map<string, number>();
    const missBoomPos = new Map<string, number>();
    for (const h of hits) { hitBoomPos.set(h.biggestBoomPos, (hitBoomPos.get(h.biggestBoomPos) || 0) + 1); }
    for (const m of misses) { missBoomPos.set(m.biggestBoomPos, (missBoomPos.get(m.biggestBoomPos) || 0) + 1); }
    const allPositions = new Set([...hitBoomPos.keys(), ...missBoomPos.keys()]);
    for (const pos of [...allPositions].sort()) {
      const hitPct = hits.length > 0 ? (hitBoomPos.get(pos) || 0) / hits.length * 100 : 0;
      const missPct = misses.length > 0 ? (missBoomPos.get(pos) || 0) / misses.length * 100 : 0;
      if (hitPct > 0 || missPct > 0) {
        console.log(`    ${pos.padEnd(10)} hits: ${hitPct.toFixed(0).padStart(3)}% | misses: ${missPct.toFixed(0).padStart(3)}%${hitPct > missPct + 5 ? ' ← MORE IN HITS' : ''}`);
      }
    }

    // Boom player salary bucket breakdown
    console.log(`\n  Biggest boom player salary distribution:`);
    const salaryBuckets = ['$3K-5K', '$5K-7K', '$7K-9K', '$9K+'];
    const getBucket = (s: number) => s < 5000 ? '$3K-5K' : s < 7000 ? '$5K-7K' : s < 9000 ? '$7K-9K' : '$9K+';
    for (const bucket of salaryBuckets) {
      const hitPct = hits.length > 0 ? hits.filter(h => getBucket(h.biggestBoomSalary) === bucket).length / hits.length * 100 : 0;
      const missPct = misses.length > 0 ? misses.filter(m => getBucket(m.biggestBoomSalary) === bucket).length / misses.length * 100 : 0;
      console.log(`    ${bucket.padEnd(10)} hits: ${hitPct.toFixed(0).padStart(3)}% | misses: ${missPct.toFixed(0).padStart(3)}%${hitPct > missPct + 5 ? ' ← MORE IN HITS' : ''}`);
    }

    // Projection tier of winning lineups
    console.log(`\n  Projection tier of top-1% hits:`);
    const projTiers = [
      { label: '97-100%', min: 0.97, max: 1.01 },
      { label: '94-97%', min: 0.94, max: 0.97 },
      { label: '91-94%', min: 0.91, max: 0.94 },
      { label: '88-91%', min: 0.88, max: 0.91 },
      { label: '<88%', min: 0, max: 0.88 },
    ];
    for (const tier of projTiers) {
      const hitCount = hits.filter(h => h.projPctOfOptimal >= tier.min && h.projPctOfOptimal < tier.max).length;
      const poolCount = allProfiles.filter(p => p.projPctOfOptimal >= tier.min && p.projPctOfOptimal < tier.max).length;
      const hitRate = poolCount > 0 ? hitCount / poolCount * 100 : 0;
      console.log(`    ${tier.label.padEnd(10)} ${hitCount} hits from ${poolCount} lineups (${hitRate.toFixed(2)}% hit rate)`);
    }
  }

  // ============================================================
  // PRO COMPARISON
  // ============================================================
  if (allSlateContestEntries.length > 0) {
    console.log(`\n  ========================================`);
    console.log(`  PRO vs PIPELINE COMPARISON`);
    console.log(`  ========================================`);

    // Aggregate pro stats across all slates
    const proAgg = new Map<string, {
      username: string;
      totalEntries: number;
      totalPoints: number;
      top1: number;
      top5: number;
      top10: number;
      bestFinish: number;
      slateCount: number;
    }>();

    for (const { date, entries } of allSlateContestEntries) {
      const totalInSlate = entries.length;
      for (const entry of entries) {
        if (!isTrackedPro(entry.username)) continue;
        const key = entry.username.toLowerCase();
        if (!proAgg.has(key)) {
          proAgg.set(key, {
            username: key,
            totalEntries: 0,
            totalPoints: 0,
            top1: 0,
            top5: 0,
            top10: 0,
            bestFinish: Infinity,
            slateCount: 0,
          });
        }
        const agg = proAgg.get(key)!;
        agg.totalEntries++;
        agg.totalPoints += entry.points;
        const percentile = (1 - (entry.rank - 1) / totalInSlate) * 100;
        if (percentile >= 99) agg.top1++;
        if (percentile >= 95) agg.top5++;
        if (percentile >= 90) agg.top10++;
        if (entry.rank < agg.bestFinish) agg.bestFinish = entry.rank;
        // Track unique slates (use entryNumber === 1 as proxy for first entry in slate)
      }
      // Count unique slates per pro
      const prosInSlate = new Set<string>();
      for (const entry of entries) {
        if (isTrackedPro(entry.username)) {
          prosInSlate.add(entry.username.toLowerCase());
        }
      }
      for (const pro of prosInSlate) {
        if (proAgg.has(pro)) {
          proAgg.get(pro)!.slateCount++;
        }
      }
    }

    // Sort by total entries descending
    const sortedPros = [...proAgg.values()]
      .filter(p => p.totalEntries >= 10)
      .sort((a, b) => b.totalEntries - a.totalEntries);

    if (sortedPros.length > 0) {
      console.log(`\n  ${'Name'.padEnd(22)} ${'Entries'.padStart(7)} ${'Slates'.padStart(6)} ${'AvgPts'.padStart(7)} ${'Top1%'.padStart(6)} ${'Top5%'.padStart(6)} ${'Top10%'.padStart(7)} ${'Best'.padStart(6)}`);
      console.log(`  ${'─'.repeat(69)}`);

      // Our pipeline row
      console.log(`  ${'** OUR PIPELINE **'.padEnd(22)} ${String(totalSelected).padStart(7)} ${String(totalSlates).padStart(6)} ${avgActualPts.toFixed(1).padStart(7)} ${(top1Rate * 100).toFixed(1).padStart(5)}% ${(top5Rate * 100).toFixed(1).padStart(5)}% ${(top10Rate * 100).toFixed(1).padStart(6)}% ${('#' + overallBestFinish).padStart(6)}`);

      // Pro rows
      for (const pro of sortedPros) {
        const avgPts = pro.totalPoints / pro.totalEntries;
        const t1 = (pro.top1 / pro.totalEntries * 100).toFixed(1);
        const t5 = (pro.top5 / pro.totalEntries * 100).toFixed(1);
        const t10 = (pro.top10 / pro.totalEntries * 100).toFixed(1);
        console.log(`  ${pro.username.padEnd(22)} ${String(pro.totalEntries).padStart(7)} ${String(pro.slateCount).padStart(6)} ${avgPts.toFixed(1).padStart(7)} ${t1.padStart(5)}% ${t5.padStart(5)}% ${t10.padStart(6)}% ${('#' + pro.bestFinish).padStart(6)}`);
      }
    } else {
      console.log(`\n  No tracked pros found with 10+ entries in contest data.`);
    }

    // ============================================================
    // 150-MAXER AUTO-DETECTION
    // ============================================================
    console.log(`\n  ========================================`);
    console.log(`  HIGH-VOLUME ENTRANT DISCOVERY`);
    console.log(`  ========================================`);

    // Find users with maxEntries >= 100 appearing in 4+ slates
    const highVolUsers = new Map<string, { slates: Set<string>; maxEntries: number; totalEntries: number }>();
    for (const { date, entries } of allSlateContestEntries) {
      const seenInSlate = new Set<string>();
      for (const entry of entries) {
        const key = entry.username.toLowerCase();
        if (seenInSlate.has(key)) continue;
        seenInSlate.add(key);
        if (entry.maxEntries >= 100) {
          if (!highVolUsers.has(key)) {
            highVolUsers.set(key, { slates: new Set(), maxEntries: 0, totalEntries: 0 });
          }
          const u = highVolUsers.get(key)!;
          u.slates.add(date);
          if (entry.maxEntries > u.maxEntries) u.maxEntries = entry.maxEntries;
        }
      }
    }
    // Count total entries for each
    for (const { entries } of allSlateContestEntries) {
      for (const entry of entries) {
        const key = entry.username.toLowerCase();
        if (highVolUsers.has(key)) {
          highVolUsers.get(key)!.totalEntries++;
        }
      }
    }

    const discovered = [...highVolUsers.entries()]
      .filter(([username, data]) => data.slates.size >= 4 && !isTrackedPro(username))
      .sort((a, b) => b[1].slates.size - a[1].slates.size || b[1].totalEntries - a[1].totalEntries);

    if (discovered.length > 0) {
      console.log(`\n  Found ${discovered.length} high-volume entrants NOT in TRACKED_PROS:`);
      console.log(`  ${'Username'.padEnd(22)} ${'Slates'.padStart(6)} ${'MaxEntries'.padStart(10)} ${'TotalEntries'.padStart(12)}`);
      console.log(`  ${'─'.repeat(52)}`);
      for (const [username, data] of discovered.slice(0, 30)) {
        console.log(`  ${username.padEnd(22)} ${String(data.slates.size).padStart(6)} ${String(data.maxEntries).padStart(10)} ${String(data.totalEntries).padStart(12)}`);
      }
      if (discovered.length > 30) {
        console.log(`  ... and ${discovered.length - 30} more`);
      }
    } else {
      console.log(`\n  No undiscovered high-volume entrants found.`);
    }
  }
}

export async function runBacktest(
  dataDir: string,
  _sport: Sport = 'nba',
  _site: DFSSite = 'dk',
  options?: { cachePool?: boolean; fromCache?: boolean; simpleSelect?: boolean; noChalk?: boolean; backtestFast?: boolean },
): Promise<void> {
  console.log('\n========================================');
  console.log('DFS OPTIMIZER - BACKTESTER');
  console.log('========================================');

  // Find all complete slates
  const slates = findSlates(dataDir);
  if (slates.length === 0) {
    console.log('No complete slates found. Need both YYYY-MM-DD_projections.csv and YYYY-MM-DD_actuals.csv');
    return;
  }

  console.log(`Found ${slates.length} complete slates:`);
  for (const s of slates) {
    console.log(`  ${s.date}`);
  }

  // Process each slate
  const results: SlateResult[] = [];
  for (const slate of slates) {
    const result = await processSlate(dataDir, slate);
    if (result) results.push(result);
  }

  if (results.length === 0) {
    console.log('\nNo slates processed successfully.');
    return;
  }

  console.log(`\nSuccessfully processed ${results.length} slates`);

  // Correlation analysis
  console.log('\n========================================');
  console.log('CORRELATION ANALYSIS');
  console.log('========================================');
  const correlations = analyzeCorrelations(results);

  const sortedCorr = [...correlations.entries()].sort((a, b) => b[1] - a[1]);
  for (const [key, corr] of sortedCorr) {
    const sign = corr >= 0 ? '+' : '';
    const label = key.replace('Score', '').padEnd(20);
    console.log(`  ${label}: ${sign}${corr.toFixed(4)}`);
  }

  // Pro analysis
  console.log('\n========================================');
  console.log('PRO ANALYSIS');
  console.log('========================================');
  const proProfiles = analyzePros(results);

  if (proProfiles.length === 0) {
    console.log('  No tracked pro entries found in contest data');
  } else {
    for (const pro of proProfiles) {
      console.log(`  ${pro.username}: ${pro.totalEntries} entries | Avg rank: ${pro.avgRank.toFixed(0)} | Best: #${pro.bestFinish} | Top1%: ${(pro.top1PctRate * 100).toFixed(1)}% | Top10%: ${(pro.top10PctRate * 100).toFixed(1)}%`);
    }
  }

  // Weight optimization
  const currentWeights = DEFAULT_WEIGHTS_COPY;
  const optimizedWeights = optimizeWeights(results, currentWeights);

  // Print optimized weights
  console.log('\n  Optimized weights:');
  for (const key of WEIGHT_KEYS) {
    const label = key.replace('Score', '').padEnd(20);
    console.log(`    ${label}: ${((optimizedWeights[key] || 0) * 100).toFixed(1)}%`);
  }

  // ============================================================
  // COMPREHENSIVE ANALYSIS
  // ============================================================

  // Winner profiles: what do actual top finishers look like?
  analyzeWinnerProfiles(results);

  // Actual points correlation: what predicts raw fantasy points?
  analyzeActualPointsCorrelation(results);

  // Simulated portfolio: how would our picks actually perform?
  simulatePortfolioPerformance(results, optimizedWeights);

  // Pro deep dive: how do pros build and how do we compare?
  analyzeProPortfolios(results, optimizedWeights);

  // Generate and save report
  const report = generateReport(results, correlations, proProfiles, currentWeights, optimizedWeights);

  const reportPath = path.join(dataDir, 'backtest_report.txt');
  fs.writeFileSync(reportPath, report);
  console.log(`\nReport saved to: ${reportPath}`);

  // Print optimized weights (don't auto-save to avoid clobbering tuned weights)
  const weightsPath = path.join(dataDir, 'optimized_weights.json');
  console.log('\n  Recommended weights (review before applying):');
  console.log('  ' + JSON.stringify(optimizedWeights, null, 2).replace(/\n/g, '\n  '));
  console.log(`\n  To apply: manually copy to ${weightsPath}`);

  // Full pipeline backtest: replay optimizer+selector against each historical slate
  runFullPipelineBacktest(dataDir, slates, _sport, _site, options);
}

// ============================================================
// SELECTION PARAMETER SWEEP
// ============================================================

/**
 * Latin Hypercube Sampling: generates N samples across D dimensions,
 * each dimension divided into N equal strata, one sample per stratum.
 */
function latinHypercubeSample(n: number, ranges: Array<[number, number]>): number[][] {
  const d = ranges.length;
  const samples: number[][] = [];
  // Create shuffled permutations for each dimension
  const perms: number[][] = [];
  for (let dim = 0; dim < d; dim++) {
    const perm = Array.from({ length: n }, (_, i) => i);
    // Fisher-Yates shuffle
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    perms.push(perm);
  }
  for (let i = 0; i < n; i++) {
    const sample: number[] = [];
    for (let dim = 0; dim < d; dim++) {
      const [lo, hi] = ranges[dim];
      // Stratified position within the stratum
      const stratum = perms[dim][i];
      const u = (stratum + Math.random()) / n;
      sample.push(lo + u * (hi - lo));
    }
    samples.push(sample);
  }
  return samples;
}

export async function runSelectionSweep(
  dataDir: string,
  sport: Sport = 'nba',
  site: DFSSite = 'dk',
  sampleCount: number = 100,
): Promise<void> {
  const startTime = Date.now();
  console.log('\n========================================');
  console.log('SELECTION PARAMETER SWEEP');
  console.log('========================================');
  console.log(`  Using Latin Hypercube Sampling: ${sampleCount} configs`);

  // 1. Find slates and load cached pools
  const slates = findSlates(dataDir);
  if (slates.length === 0) {
    console.log('No slates found.');
    return;
  }

  const cacheDir = path.join(dataDir, 'cached_pools');
  const contestType: ContestType = 'classic';
  const config = getContestConfig(site, sport, contestType);
  const TARGET_COUNT = 500;

  // Load all slates with cached pools and actuals
  interface SlateData {
    date: string;
    pool: Lineup[];
    contestPoints: number[];
    actualsById: Map<string, number>;
    actualsByName: Map<string, number>;
    numGames: number;
    fieldAvg: number;
  }
  const loadedSlates: SlateData[] = [];

  for (const slate of slates) {
    const poolCachePath = path.join(cacheDir, `${slate.date}_pool.json`);
    if (!fs.existsSync(poolCachePath)) {
      console.log(`  ${slate.date}: No cached pool — skipping (run --backtest --cache-pool first)`);
      continue;
    }

    // Load cached pool
    const cached = JSON.parse(fs.readFileSync(poolCachePath, 'utf-8'));
    const pool = cached.lineups as Lineup[];

    // Load actuals
    const playerData = loadProjections(dataDir, slate.projFile);
    const actualsById = new Map<string, number>();
    const actualsByName = new Map<string, number>();
    for (const [nameLower, pd] of playerData) {
      if (pd.actual > 0) {
        actualsById.set(pd.id, pd.actual);
        actualsByName.set(nameLower, pd.actual);
      }
    }

    // Load contest entries
    const contestEntries = loadActuals(dataDir, slate.actualsFile);
    if (contestEntries.length < 100) continue;
    const contestPoints = contestEntries.map(e => e.points).sort((a, b) => b - a);
    const fieldAvg = contestPoints.reduce((s, p) => s + p, 0) / contestPoints.length;

    // Count games
    const gameSet = new Set<string>();
    for (const p of pool.flatMap((l: Lineup) => l.players)) {
      if (p.gameInfo) gameSet.add(p.gameInfo);
      else if (p.team) gameSet.add(p.team);
    }
    const numGames = gameSet.size > 0
      ? (pool[0]?.players[0]?.gameInfo ? gameSet.size : Math.ceil(gameSet.size / 2))
      : 5;

    loadedSlates.push({ date: slate.date, pool, contestPoints, actualsById, actualsByName, numGames, fieldAvg });
    console.log(`  ${slate.date}: ${pool.length.toLocaleString()} lineups, ${contestEntries.length.toLocaleString()} entries, ${numGames} games`);
  }

  if (loadedSlates.length === 0) {
    console.log('\nNo slates with cached pools found. Run --backtest --cache-pool first.');
    return;
  }
  console.log(`\n  ${loadedSlates.length} slates loaded`);

  // 2. Generate LHS configs
  // Dimensions: projFloor, ownMarginBoost, maxExposure, diversityBase, diversityFreePass
  const ranges: Array<[number, number]> = [
    [0.84, 0.94],    // projFloorPct
    [0, 6],          // ownMarginBoost
    [0.55, 0.90],    // maxExposure
    [0.10, 0.35],    // diversityBase
    [0.03, 0.15],    // diversityFreePass
  ];
  const paramNames = ['projFloor', 'ownMarginBoost', 'maxExposure', 'divBase', 'divFreePass'];
  const samples = latinHypercubeSample(sampleCount, ranges);

  // Add baseline config as first entry
  samples.unshift([0.94, 0, 0.65, 0.25, 0.06]);

  console.log(`\n  Testing ${samples.length} configs across ${loadedSlates.length} slates...\n`);

  // 3. Run sweep
  interface SweepResult {
    idx: number;
    config: SelectionConfig;
    totalSelected: number;
    totalTop1: number;
    totalTop5: number;
    top1Rate: number;
    avgSelected: number;
    perSlate: Array<{ date: string; selected: number; top1: number }>;
  }
  const sweepResults: SweepResult[] = [];

  // Suppress console output during sweep
  const originalLog = console.log;
  const originalWarn = console.warn;

  for (let i = 0; i < samples.length; i++) {
    const [projFloor, ownBoost, maxExp, divBase, divFreePass] = samples[i];
    const selConfig: SelectionConfig = {
      projFloorPct: projFloor,
      ownMarginBoost: ownBoost,
      maxExposure: maxExp,
      diversityBase: divBase,
      diversityFreePass: divFreePass,
    };

    let totalSelected = 0;
    let totalTop1 = 0;
    let totalTop5 = 0;
    const perSlate: Array<{ date: string; selected: number; top1: number }> = [];

    for (const slate of loadedSlates) {
      // Silence logs during selection
      console.log = () => {};
      console.warn = () => {};

      let selResult;
      try {
        selResult = selectLineups({
          lineups: slate.pool,
          targetCount: TARGET_COUNT,
          maxExposure: 0.5,
          projectionWeight: 0.4,
          leverageWeight: 0.25,
          ownershipWeight: 0.15,
          diversityWeight: 0.2,
          sport: sport,
          simMode: 'none',
          numGames: slate.numGames,
          contestSize: '20max',
          selectionConfig: selConfig,
        });
      } finally {
        console.log = originalLog;
        console.warn = originalWarn;
      }

      // Score against actuals
      let slateTop1 = 0;
      let slateTop5 = 0;
      let matched = 0;

      for (const lineup of selResult.selected) {
        let actualTotal = 0;
        let allMatched = true;
        for (const p of lineup.players) {
          const actual = slate.actualsById.get(p.id) ?? slate.actualsByName.get(p.name.toLowerCase());
          if (actual !== undefined) actualTotal += actual;
          else allMatched = false;
        }
        if (!allMatched) continue;
        matched++;
        const rank = binarySearchRank(slate.contestPoints, actualTotal);
        const percentile = (1 - (rank - 1) / slate.contestPoints.length) * 100;
        if (percentile >= 99) slateTop1++;
        if (percentile >= 95) slateTop5++;
      }

      totalSelected += matched;
      totalTop1 += slateTop1;
      totalTop5 += slateTop5;
      perSlate.push({ date: slate.date, selected: matched, top1: slateTop1 });
    }

    const top1Rate = totalSelected > 0 ? totalTop1 / totalSelected : 0;
    sweepResults.push({
      idx: i,
      config: selConfig,
      totalSelected,
      totalTop1,
      totalTop5,
      top1Rate,
      avgSelected: totalSelected / loadedSlates.length,
      perSlate,
    });

    // Progress
    if ((i + 1) % 10 === 0 || i === 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = (i + 1) / elapsed;
      const eta = ((samples.length - i - 1) / rate).toFixed(0);
      const bestSoFar = sweepResults.reduce((a, b) => a.top1Rate > b.top1Rate ? a : b);
      originalLog(`  ${(i + 1).toString().padStart(4)}/${samples.length} (${elapsed.toFixed(0)}s, ETA ${eta}s) — best: ${(bestSoFar.top1Rate * 100).toFixed(2)}% (#${bestSoFar.idx})`);
    }
  }

  // 4. Sort and report
  sweepResults.sort((a, b) => b.top1Rate - a.top1Rate);

  console.log('\n========================================');
  console.log('SWEEP RESULTS — Top 20');
  console.log('========================================');
  console.log(`  ${'#'.padStart(3)} ${'Top1%'.padStart(7)} ${'Hits'.padStart(5)} ${'Sel'.padStart(6)} ${'AvgSel'.padStart(6)}  projFloor ownBoost maxExp  divBase divFP`);
  console.log(`  ${'─'.repeat(90)}`);

  for (let i = 0; i < Math.min(20, sweepResults.length); i++) {
    const r = sweepResults[i];
    const c = r.config;
    console.log(`  ${(i + 1).toString().padStart(3)} ${(r.top1Rate * 100).toFixed(2).padStart(7)} ${r.totalTop1.toString().padStart(5)} ${r.totalSelected.toString().padStart(6)} ${r.avgSelected.toFixed(0).padStart(6)}  ${(c.projFloorPct ?? 0).toFixed(3).padStart(8)} ${(c.ownMarginBoost ?? 0).toFixed(1).padStart(8)} ${(c.maxExposure ?? 0).toFixed(2).padStart(6)} ${(c.diversityBase ?? 0).toFixed(3).padStart(8)} ${(c.diversityFreePass ?? 0).toFixed(3).padStart(5)}`);
  }

  // Baseline comparison
  const baselineResult = sweepResults.find(r => r.idx === 0);
  if (baselineResult) {
    const rank = sweepResults.indexOf(baselineResult) + 1;
    console.log(`\n  Baseline: ${(baselineResult.top1Rate * 100).toFixed(2)}% (rank #${rank}/${sweepResults.length})`);
  }

  // Best config
  const best = sweepResults[0];
  console.log(`\n  Best config:`);
  console.log(`    projFloorPct: ${best.config.projFloorPct?.toFixed(4)}`);
  console.log(`    ownMarginBoost: ${best.config.ownMarginBoost?.toFixed(2)}`);
  console.log(`    maxExposure: ${best.config.maxExposure?.toFixed(3)}`);
  console.log(`    diversityBase: ${best.config.diversityBase?.toFixed(4)}`);
  console.log(`    diversityFreePass: ${best.config.diversityFreePass?.toFixed(4)}`);

  // Per-slate breakdown for best config
  console.log(`\n  Per-slate breakdown (best config):`);
  for (const s of best.perSlate) {
    console.log(`    ${s.date}: ${s.top1} top-1% from ${s.selected} selected`);
  }

  // Save results
  const sweepPath = path.join(dataDir, 'sweep_results.json');
  fs.writeFileSync(sweepPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    sampleCount: samples.length,
    slateCount: loadedSlates.length,
    results: sweepResults.slice(0, 50).map(r => ({
      rank: sweepResults.indexOf(r) + 1,
      top1Rate: r.top1Rate,
      totalTop1: r.totalTop1,
      totalSelected: r.totalSelected,
      avgSelected: r.avgSelected,
      config: r.config,
      perSlate: r.perSlate,
    })),
  }, null, 2) + '\n');
  console.log(`\n  Saved results to ${sweepPath}`);

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nTotal sweep time: ${totalTime}s`);
}

/** Binary search rank in descending sorted array */
function binarySearchRank(sorted: number[], value: number): number {
  let lo = 0, hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] > value) lo = mid + 1;
    else hi = mid - 1;
  }
  return lo + 1;
}
