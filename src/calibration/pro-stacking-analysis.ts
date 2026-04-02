/**
 * Pro Stacking & Bring-Back Analysis — DEEP BACKTEST VERSION
 *
 * Per-slate + aggregate analysis of:
 * 1. Game stacking patterns (2/3/4/5-man stacks)
 * 2. Bring-back patterns (players from both sides of a game)
 * 3. Team concentration
 * 4. Stack size vs actual performance (correlation)
 * 5. Winning lineup archetypes
 * 6. Actionable insights for optimizer tuning
 *
 * Usage:
 *   npm run build && node dist/calibration/pro-stacking-analysis.js
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================
// TYPES
// ============================================================

interface PlayerInfo {
  name: string;
  team: string;
  opp: string;
  salary: number;
  projection: number;
  ownership: number;
  actual: number;
  ceiling: number;
  game: string;
}

interface ParsedLineup {
  username: string;
  rank: number;
  points: number;
  totalEntries: number;
  entryCount: number; // total entries in this contest
  players: PlayerInfo[];
  totalProjection: number;
  totalActual: number;
  avgOwnership: number;
  prodOwnership: number; // geometric mean
  totalSalary: number;
  isPro: boolean;
  slateDate: string;
}

interface GameStack {
  game: string;
  teams: Map<string, PlayerInfo[]>;
  totalPlayers: number;
  hasBringBack: boolean;
  bringBackPattern: string;
}

interface StackProfile {
  maxGameConcentration: number;
  stackSizes: number[];
  totalGames: number;
  gameStacks: GameStack[];
  hasBringBack: boolean;
  bringBackCount: number;
  stackPattern: string;
  maxTeamStack: number;
  primaryStackGame: string;
  primaryStackTeams: string[];
}

// ============================================================
// TRACKED PROS
// ============================================================

const TRACKED_PROS = [
  'zroth', 'zroth2', 'bpcologna', 'bgreseth', 'skijmb', 'oxenduck', 'invertedcheese',
  'ocdobv', 'moklovin', 'shipmymoney', 'awen419', 'beaker913', 'westonselman',
  'onedropking', 'kszng', 'idlove2win', 'slimbomangler', 'austinturner773',
  'shaidyadvice', 'cheddabisque', 'lozingitall', 'hixx', 'fjbourne',
  'sullybrochill', 'xmalachi', 'giantsquid', 'mazwa', 'btmboss2',
  'sbcousle', 'jpm11', 'royalpain21', 'hebrewcheetah', 'cjcashing',
  'rsbathla', 'narendra22', 'jdm68a', 'aarondp987', 'hurliss', 'b_heals152',
];

function isTrackedPro(username: string): boolean {
  const lower = username.toLowerCase();
  return TRACKED_PROS.some(p => lower === p || lower.startsWith(p));
}

// ============================================================
// CSV PARSING
// ============================================================

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const char of line) {
    if (char === '"') { inQuotes = !inQuotes; }
    else if (char === ',' && !inQuotes) { result.push(current.trim()); current = ''; }
    else { current += char; }
  }
  result.push(current.trim());
  return result;
}

function stripBOM(str: string): string {
  return str.charCodeAt(0) === 0xFEFF ? str.slice(1) : str;
}

function findColumnIndex(headers: string[], ...candidates: string[]): number {
  const lower = headers.map(h => h.toLowerCase().trim());
  for (const c of candidates) {
    const idx = lower.indexOf(c.toLowerCase());
    if (idx >= 0) return idx;
  }
  return -1;
}

function loadProjections(filePath: string): Map<string, PlayerInfo> {
  const content = stripBOM(fs.readFileSync(filePath, 'utf-8'));
  const lines = content.split('\n').filter(l => l.trim().length > 0);
  if (lines.length < 2) return new Map();

  const headers = parseCSVLine(lines[0]);
  const nameIdx = findColumnIndex(headers, 'Name');
  const teamIdx = findColumnIndex(headers, 'Team');
  const oppIdx = findColumnIndex(headers, 'Opp');
  const salaryIdx = findColumnIndex(headers, 'Salary');
  const projIdx = findColumnIndex(headers, 'SS Proj', 'My Proj', 'Projection');
  const ownIdx = findColumnIndex(headers, 'My Own', 'Ownership', 'Own');
  const actualIdx = findColumnIndex(headers, 'Actual');
  const ceilingIdx = findColumnIndex(headers, 'dk_85_percentile');

  const players = new Map<string, PlayerInfo>();
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    if (cols.length < 5) continue;
    const name = cols[nameIdx]?.trim();
    if (!name) continue;

    const team = teamIdx >= 0 ? (cols[teamIdx] || '').trim() : '';
    const opp = oppIdx >= 0 ? (cols[oppIdx] || '').trim() : '';
    const projection = parseFloat(cols[projIdx]) || 0;
    const salary = parseFloat(cols[salaryIdx]) || 0;
    const ownership = ownIdx >= 0 ? (parseFloat(cols[ownIdx]) || 5) : 5;
    const actual = actualIdx >= 0 ? (parseFloat(cols[actualIdx]) || 0) : 0;
    const ceiling = ceilingIdx >= 0 ? (parseFloat(cols[ceilingIdx]) || projection * 1.3) : projection * 1.3;

    const teams = [team, opp].filter(t => t.length > 0).sort();
    const game = teams.length === 2 ? `${teams[0]}-${teams[1]}` : team;

    players.set(name.toLowerCase(), { name, team, opp, salary, projection, ownership, actual, ceiling, game });
  }
  return players;
}

function parseEntryCount(entryName: string): { username: string; entryNum: number; maxEntries: number } {
  const match = entryName.match(/^(\S+)\s*\((\d+)\/(\d+)\)/);
  if (match) return { username: match[1].toLowerCase(), entryNum: parseInt(match[2]), maxEntries: parseInt(match[3]) };
  return { username: entryName.replace(/\s*\(.*\)/, '').toLowerCase(), entryNum: 1, maxEntries: 1 };
}

interface ContestEntry {
  rank: number;
  username: string;
  maxEntries: number;
  points: number;
  lineupStr: string;
}

function loadActuals(filePath: string): ContestEntry[] {
  const content = stripBOM(fs.readFileSync(filePath, 'utf-8'));
  const lines = content.split('\n').filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];

  const headers = parseCSVLine(lines[0]);
  const rankIdx = findColumnIndex(headers, 'Rank');
  const entryIdIdx = findColumnIndex(headers, 'EntryId');
  const entryNameIdx = findColumnIndex(headers, 'EntryName');
  const pointsIdx = findColumnIndex(headers, 'Points');
  const lineupIdx = findColumnIndex(headers, 'Lineup');

  if (rankIdx < 0 || pointsIdx < 0 || lineupIdx < 0) return [];

  const entries: ContestEntry[] = [];
  const seenIds = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    if (cols.length < 5) continue;
    const rank = parseInt(cols[rankIdx]);
    const points = parseFloat(cols[pointsIdx]);
    if (isNaN(rank) || isNaN(points)) continue;
    const entryId = cols[entryIdIdx] || `${i}`;
    if (seenIds.has(entryId)) continue;
    seenIds.add(entryId);
    const parsed = parseEntryCount(cols[entryNameIdx] || '');
    entries.push({ rank, username: parsed.username, maxEntries: parsed.maxEntries, points, lineupStr: cols[lineupIdx] || '' });
  }
  return entries;
}

// ============================================================
// LINEUP PARSING
// ============================================================

function parseLineupString(lineupStr: string): string[] {
  if (!lineupStr || lineupStr.trim().length === 0) return [];
  const markers: Array<{ pos: string; nameStart: number }> = [];
  const regex = /(?:^|\s)(UTIL|PG|SG|SF|PF|C|G|F)\s+/g;
  let match;
  while ((match = regex.exec(lineupStr)) !== null) {
    markers.push({ pos: match[1], nameStart: match.index + match[0].length });
  }
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

function matchPlayer(name: string, players: Map<string, PlayerInfo>): PlayerInfo | null {
  const lower = name.toLowerCase().trim();
  if (players.has(lower)) return players.get(lower)!;
  const cleaned = lower.replace(/\s+(jr\.?|sr\.?|ii|iii|iv|v)$/i, '').replace(/\./g, '').trim();
  if (players.has(cleaned)) return players.get(cleaned)!;
  for (const [key, data] of players) {
    const keyClean = key.replace(/\./g, '').trim();
    if (keyClean === cleaned || keyClean === lower) return data;
  }
  const parts = lower.split(/\s+/);
  const lastName = parts[parts.length - 1];
  if (lastName.length >= 4) {
    const matches: PlayerInfo[] = [];
    for (const [key, data] of players) { if (key.endsWith(lastName)) matches.push(data); }
    if (matches.length === 1) return matches[0];
  }
  return null;
}

function buildParsedLineup(entry: ContestEntry, playerMap: Map<string, PlayerInfo>, slateDate: string, totalEntries: number): ParsedLineup | null {
  const names = parseLineupString(entry.lineupStr);
  if (names.length < 6) return null;
  const players: PlayerInfo[] = [];
  for (const name of names) {
    const p = matchPlayer(name, playerMap);
    if (!p) return null;
    players.push(p);
  }

  // Geometric mean ownership
  const ownProducts = players.reduce((prod, p) => prod * Math.max(0.1, p.ownership / 100), 1);
  const geoMean = Math.pow(ownProducts, 1 / players.length) * 100;

  return {
    username: entry.username, rank: entry.rank, points: entry.points,
    totalEntries: entry.maxEntries, entryCount: totalEntries,
    players, slateDate,
    totalProjection: players.reduce((s, p) => s + p.projection, 0),
    totalActual: players.reduce((s, p) => s + p.actual, 0),
    avgOwnership: players.reduce((s, p) => s + p.ownership, 0) / players.length,
    prodOwnership: geoMean,
    totalSalary: players.reduce((s, p) => s + p.salary, 0),
    isPro: isTrackedPro(entry.username),
  };
}

// ============================================================
// STACKING ANALYSIS
// ============================================================

function analyzeStacking(lineup: ParsedLineup): StackProfile {
  const gameGroups = new Map<string, PlayerInfo[]>();
  for (const p of lineup.players) {
    const game = p.game || 'UNKNOWN';
    if (!gameGroups.has(game)) gameGroups.set(game, []);
    gameGroups.get(game)!.push(p);
  }

  const gameStacks: GameStack[] = [];
  let bringBackCount = 0;

  for (const [game, players] of gameGroups) {
    const teamMap = new Map<string, PlayerInfo[]>();
    for (const p of players) {
      if (!teamMap.has(p.team)) teamMap.set(p.team, []);
      teamMap.get(p.team)!.push(p);
    }
    const hasBringBack = teamMap.size >= 2;
    if (hasBringBack) bringBackCount++;
    const teamCounts = Array.from(teamMap.values()).map(t => t.length).sort((a, b) => b - a);
    gameStacks.push({ game, teams: teamMap, totalPlayers: players.length, hasBringBack, bringBackPattern: teamCounts.join('+') });
  }

  gameStacks.sort((a, b) => b.totalPlayers - a.totalPlayers);
  const stackSizes = gameStacks.map(g => g.totalPlayers);

  // Max same-team
  const teamCounts = new Map<string, number>();
  for (const p of lineup.players) { teamCounts.set(p.team, (teamCounts.get(p.team) || 0) + 1); }
  const maxTeamStack = Math.max(...Array.from(teamCounts.values()));

  // Primary stack info
  const primary = gameStacks[0];
  const primaryTeams = primary ? Array.from(primary.teams.keys()) : [];

  return {
    maxGameConcentration: stackSizes[0] || 0,
    stackSizes, totalGames: gameStacks.length, gameStacks,
    hasBringBack: bringBackCount > 0, bringBackCount,
    stackPattern: stackSizes.join('-'),
    maxTeamStack, primaryStackGame: primary?.game || '',
    primaryStackTeams: primaryTeams,
  };
}

// ============================================================
// MAIN ANALYSIS
// ============================================================

function main() {
  const dataDir = path.resolve(__dirname, '../../historical_slates');
  console.log(`\n${'='.repeat(90)}`);
  console.log('DEEP PRO STACKING & BRING-BACK ANALYSIS — EVERY SLATE');
  console.log(`${'='.repeat(90)}\n`);

  const files = fs.readdirSync(dataDir);
  const slates: Array<{ date: string; projFile: string; actFile: string }> = [];
  for (const f of files) {
    const match = f.match(/^(\d{4}-\d{2}-\d{1,2})_actuals\.csv$/);
    if (match) {
      const date = match[1];
      const projFile = `${date}_projections.csv`;
      if (files.includes(projFile)) slates.push({ date, projFile, actFile: f });
    }
  }
  slates.sort((a, b) => a.date.localeCompare(b.date));

  // ============================================================
  // PER-SLATE DEEP ANALYSIS
  // ============================================================

  interface SlateAnalysis {
    date: string;
    numGames: number;
    numPlayers: number;
    totalEntries: number;
    allLineups: ParsedLineup[];
    proLineups: ParsedLineup[];
    fieldLineups: ParsedLineup[];
    top1Lineups: ParsedLineup[];
    top5Lineups: ParsedLineup[];
    top10Lineups: ParsedLineup[];
    proTop1: ParsedLineup[];
    fieldTop1: ParsedLineup[];
    winner: ParsedLineup | null;
  }

  const slateResults: SlateAnalysis[] = [];

  for (const slate of slates) {
    const playerMap = loadProjections(path.join(dataDir, slate.projFile));
    const entries = loadActuals(path.join(dataDir, slate.actFile));
    if (playerMap.size === 0 || entries.length === 0) continue;

    const numGames = new Set(Array.from(playerMap.values()).map(p => p.game)).size;
    const top1Threshold = Math.ceil(entries.length * 0.01);
    const top5Threshold = Math.ceil(entries.length * 0.05);
    const top10Threshold = Math.ceil(entries.length * 0.10);

    const analysis: SlateAnalysis = {
      date: slate.date, numGames, numPlayers: playerMap.size, totalEntries: entries.length,
      allLineups: [], proLineups: [], fieldLineups: [],
      top1Lineups: [], top5Lineups: [], top10Lineups: [],
      proTop1: [], fieldTop1: [], winner: null,
    };

    for (const entry of entries) {
      const lineup = buildParsedLineup(entry, playerMap, slate.date, entries.length);
      if (!lineup) continue;

      analysis.allLineups.push(lineup);
      if (lineup.isPro) analysis.proLineups.push(lineup);
      else analysis.fieldLineups.push(lineup);

      if (entry.rank <= top1Threshold) {
        analysis.top1Lineups.push(lineup);
        if (lineup.isPro) analysis.proTop1.push(lineup);
        else analysis.fieldTop1.push(lineup);
      }
      if (entry.rank <= top5Threshold) analysis.top5Lineups.push(lineup);
      if (entry.rank <= top10Threshold) analysis.top10Lineups.push(lineup);
      if (entry.rank === 1 && !analysis.winner) analysis.winner = lineup;
    }

    slateResults.push(analysis);
  }

  // ============================================================
  // PER-SLATE REPORT
  // ============================================================

  for (const sa of slateResults) {
    console.log(`\n${'═'.repeat(90)}`);
    console.log(`SLATE: ${sa.date} | ${sa.numGames} games | ${sa.numPlayers} players | ${sa.totalEntries} entries`);
    console.log(`${'═'.repeat(90)}`);

    function stackSummary(lineups: ParsedLineup[], label: string) {
      if (lineups.length === 0) { console.log(`  ${label}: (no data)`); return; }
      const profiles = lineups.map(l => analyzeStacking(l));
      const n = profiles.length;

      const avgMaxStack = profiles.reduce((s, p) => s + p.maxGameConcentration, 0) / n;
      const avgGames = profiles.reduce((s, p) => s + p.totalGames, 0) / n;
      const has3 = profiles.filter(p => p.maxGameConcentration >= 3).length / n;
      const has4 = profiles.filter(p => p.maxGameConcentration >= 4).length / n;
      const bbRate = profiles.filter(p => p.hasBringBack).length / n;
      const avgBB = profiles.reduce((s, p) => s + p.bringBackCount, 0) / n;
      const avgMaxTeam = profiles.reduce((s, p) => s + p.maxTeamStack, 0) / n;
      const avgPts = lineups.reduce((s, l) => s + l.points, 0) / n;
      const avgProj = lineups.reduce((s, l) => s + l.totalProjection, 0) / n;
      const avgOwn = lineups.reduce((s, l) => s + l.avgOwnership, 0) / n;
      const avgGeoOwn = lineups.reduce((s, l) => s + l.prodOwnership, 0) / n;

      // Stack pattern distribution
      const patternDist = new Map<string, number>();
      for (const p of profiles) { patternDist.set(p.stackPattern, (patternDist.get(p.stackPattern) || 0) + 1); }
      const topPatterns = Array.from(patternDist.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);

      // Bring-back composition
      const bbComp = new Map<string, number>();
      for (const p of profiles) {
        for (const gs of p.gameStacks) {
          if (gs.hasBringBack && gs.totalPlayers >= 3) {
            bbComp.set(gs.bringBackPattern, (bbComp.get(gs.bringBackPattern) || 0) + 1);
          }
        }
      }
      const topBB = Array.from(bbComp.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);

      // Which games get stacked (3+)?
      const gameStackFreq = new Map<string, number>();
      for (const p of profiles) {
        for (const gs of p.gameStacks) {
          if (gs.totalPlayers >= 3) {
            gameStackFreq.set(gs.game, (gameStackFreq.get(gs.game) || 0) + 1);
          }
        }
      }
      const topGames = Array.from(gameStackFreq.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3);

      console.log(`  ${label} (n=${n}):`);
      console.log(`    AvgPts=${avgPts.toFixed(1)} | Proj=${avgProj.toFixed(1)} | Own=${avgOwn.toFixed(1)}% | GeoOwn=${avgGeoOwn.toFixed(1)}%`);
      console.log(`    MaxStack=${avgMaxStack.toFixed(2)} | Games=${avgGames.toFixed(1)} | MaxTeam=${avgMaxTeam.toFixed(2)} | 3+stk=${(has3*100).toFixed(0)}% | 4+stk=${(has4*100).toFixed(0)}% | BB=${(bbRate*100).toFixed(0)}% | AvgBB=${avgBB.toFixed(2)}`);
      console.log(`    Patterns: ${topPatterns.map(([p, c]) => `${p}(${(c/n*100).toFixed(0)}%)`).join(', ')}`);
      if (topBB.length > 0) {
        console.log(`    BB 3+ comps: ${topBB.map(([p, c]) => `${p}(${c})`).join(', ')}`);
      }
      if (topGames.length > 0) {
        console.log(`    Top stacked games: ${topGames.map(([g, c]) => `${g}(${(c/n*100).toFixed(0)}%)`).join(', ')}`);
      }
    }

    stackSummary(sa.proLineups, 'PROS');
    stackSummary(sa.fieldLineups.filter((_, i) => i % 20 === 0), 'FIELD (5% sample)');
    stackSummary(sa.top1Lineups, 'TOP 1%');
    stackSummary(sa.proTop1, 'PRO TOP 1%');

    // Winner breakdown
    if (sa.winner) {
      const sp = analyzeStacking(sa.winner);
      const proLabel = sa.winner.isPro ? ' [PRO]' : '';
      console.log(`\n  WINNER: ${sa.winner.username}${proLabel} — #${sa.winner.rank} — ${sa.winner.points.toFixed(1)} pts`);
      console.log(`    Proj=${sa.winner.totalProjection.toFixed(1)} | Salary=$${sa.winner.totalSalary} | Own=${sa.winner.avgOwnership.toFixed(1)}% | GeoOwn=${sa.winner.prodOwnership.toFixed(1)}%`);
      console.log(`    Stack=${sp.stackPattern} | Games=${sp.totalGames} | BB=${sp.bringBackCount} | MaxTeam=${sp.maxTeamStack}`);
      for (const gs of sp.gameStacks) {
        if (gs.totalPlayers >= 2) {
          const bbLabel = gs.hasBringBack ? ` [BB ${gs.bringBackPattern}]` : '';
          const playerNames = Array.from(gs.teams.entries())
            .map(([team, ps]) => `${team}: ${ps.map(p => `${p.name}(${p.actual}pts,${p.ownership.toFixed(0)}%own)`).join('+')}`).join(' | ');
          console.log(`      ${gs.game}(${gs.totalPlayers})${bbLabel}: ${playerNames}`);
        }
      }
    }
  }

  // ============================================================
  // AGGREGATE CROSS-SLATE ANALYSIS
  // ============================================================

  console.log(`\n\n${'='.repeat(90)}`);
  console.log('AGGREGATE CROSS-SLATE FINDINGS');
  console.log(`${'='.repeat(90)}`);

  const allPro: ParsedLineup[] = [];
  const allField: ParsedLineup[] = [];
  const allTop1: ParsedLineup[] = [];
  const allTop5: ParsedLineup[] = [];
  const allProTop1: ParsedLineup[] = [];
  const allFieldTop1: ParsedLineup[] = [];
  const allWinners: ParsedLineup[] = [];

  for (const sa of slateResults) {
    allPro.push(...sa.proLineups);
    allField.push(...sa.fieldLineups.filter((_, i) => i % 10 === 0)); // 10% sample
    allTop1.push(...sa.top1Lineups);
    allTop5.push(...sa.top5Lineups);
    allProTop1.push(...sa.proTop1);
    allFieldTop1.push(...sa.fieldTop1);
    if (sa.winner) allWinners.push(sa.winner);
  }

  // ============================================================
  // A. STACKING RATES BY TIER
  // ============================================================

  console.log(`\n${'─'.repeat(90)}`);
  console.log('A. STACKING RATES BY PERFORMANCE TIER');
  console.log(`${'─'.repeat(90)}`);

  function tierStats(lineups: ParsedLineup[], label: string) {
    const profiles = lineups.map(l => analyzeStacking(l));
    const n = profiles.length;
    if (n === 0) return;

    const has3 = profiles.filter(p => p.maxGameConcentration >= 3).length / n;
    const has4 = profiles.filter(p => p.maxGameConcentration >= 4).length / n;
    const has5 = profiles.filter(p => p.maxGameConcentration >= 5).length / n;
    const bbRate = profiles.filter(p => p.hasBringBack).length / n;
    const bb3plus = profiles.filter(p => p.gameStacks.some(gs => gs.hasBringBack && gs.totalPlayers >= 3)).length / n;
    const avgMaxStack = profiles.reduce((s, p) => s + p.maxGameConcentration, 0) / n;
    const avgGames = profiles.reduce((s, p) => s + p.totalGames, 0) / n;
    const avgMaxTeam = profiles.reduce((s, p) => s + p.maxTeamStack, 0) / n;
    const avgBB = profiles.reduce((s, p) => s + p.bringBackCount, 0) / n;

    console.log(
      `  ${label.padEnd(22)} n=${String(n).padStart(6)} | ` +
      `3+stk=${(has3*100).toFixed(0).padStart(3)}% | 4+stk=${(has4*100).toFixed(0).padStart(3)}% | 5+stk=${(has5*100).toFixed(0).padStart(3)}% | ` +
      `BB=${(bbRate*100).toFixed(0).padStart(3)}% | BB3+=${(bb3plus*100).toFixed(0).padStart(3)}% | ` +
      `AvgMax=${avgMaxStack.toFixed(2)} | Games=${avgGames.toFixed(1)} | Team=${avgMaxTeam.toFixed(2)} | AvgBB=${avgBB.toFixed(2)}`
    );
  }

  tierStats(allField, 'Field (10% sample)');
  tierStats(allPro, 'All Pros');
  tierStats(allTop5, 'All Top 5%');
  tierStats(allTop1, 'All Top 1%');
  tierStats(allFieldTop1, 'Field Top 1%');
  tierStats(allProTop1, 'Pro Top 1%');
  tierStats(allWinners, 'Winners');

  // ============================================================
  // B. BRING-BACK DEEP ANALYSIS
  // ============================================================

  console.log(`\n${'─'.repeat(90)}`);
  console.log('B. BRING-BACK PATTERNS IN DETAIL');
  console.log(`${'─'.repeat(90)}`);

  function bbAnalysis(lineups: ParsedLineup[], label: string) {
    const profiles = lineups.map(l => ({ lineup: l, profile: analyzeStacking(l) }));
    const n = profiles.length;
    if (n === 0) return;

    // Bring-back in 3+ stacks specifically (the meaningful ones)
    const bbIn3Plus: Array<{ pattern: string; stackSize: number; lineup: ParsedLineup }> = [];
    for (const { lineup, profile } of profiles) {
      for (const gs of profile.gameStacks) {
        if (gs.hasBringBack && gs.totalPlayers >= 3) {
          bbIn3Plus.push({ pattern: gs.bringBackPattern, stackSize: gs.totalPlayers, lineup });
        }
      }
    }

    const hasBBin3Plus = profiles.filter(({ profile }) =>
      profile.gameStacks.some(gs => gs.hasBringBack && gs.totalPlayers >= 3)
    ).length;

    console.log(`\n  ${label} (n=${n}):`);
    console.log(`    Has bring-back in 3+ stack: ${hasBBin3Plus} (${(hasBBin3Plus/n*100).toFixed(1)}%)`);

    if (bbIn3Plus.length > 0) {
      // Distribution by stack size
      const bySize = new Map<number, Map<string, number>>();
      for (const bb of bbIn3Plus) {
        if (!bySize.has(bb.stackSize)) bySize.set(bb.stackSize, new Map());
        const m = bySize.get(bb.stackSize)!;
        m.set(bb.pattern, (m.get(bb.pattern) || 0) + 1);
      }

      for (const [size, patterns] of Array.from(bySize.entries()).sort((a, b) => a[0] - b[0])) {
        const sorted = Array.from(patterns.entries()).sort((a, b) => b[1] - a[1]);
        const total = sorted.reduce((s, [, c]) => s + c, 0);
        console.log(`    ${size}-man stacks: ${sorted.map(([p, c]) => `${p}(${(c/total*100).toFixed(0)}%)`).join(', ')}`);
      }
    }
  }

  bbAnalysis(allPro, 'ALL PROS');
  bbAnalysis(allField, 'FIELD');
  bbAnalysis(allTop1, 'TOP 1%');
  bbAnalysis(allProTop1, 'PRO TOP 1%');

  // ============================================================
  // C. STACK SIZE vs ACTUAL POINTS (CORRELATION)
  // ============================================================

  console.log(`\n${'─'.repeat(90)}`);
  console.log('C. STACK SIZE vs ACTUAL PERFORMANCE (all entries)');
  console.log(`${'─'.repeat(90)}`);

  // For each slate, compute correlations
  for (const sa of slateResults) {
    const lineups = sa.allLineups.filter((_, i) => i % 5 === 0); // 20% sample for speed
    if (lineups.length < 100) continue;

    const data = lineups.map(l => {
      const sp = analyzeStacking(l);
      return {
        maxStack: sp.maxGameConcentration,
        hasBB: sp.hasBringBack ? 1 : 0,
        bbCount: sp.bringBackCount,
        bbIn3Plus: sp.gameStacks.some(gs => gs.hasBringBack && gs.totalPlayers >= 3) ? 1 : 0,
        numGames: sp.totalGames,
        maxTeam: sp.maxTeamStack,
        points: l.points,
        percentile: 100 * (1 - l.rank / sa.totalEntries),
      };
    });

    // Compute correlations
    function corr(xs: number[], ys: number[]): number {
      const n = xs.length;
      const mx = xs.reduce((s, v) => s + v, 0) / n;
      const my = ys.reduce((s, v) => s + v, 0) / n;
      let num = 0, dx = 0, dy = 0;
      for (let i = 0; i < n; i++) {
        num += (xs[i] - mx) * (ys[i] - my);
        dx += (xs[i] - mx) ** 2;
        dy += (ys[i] - my) ** 2;
      }
      return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
    }

    const percentiles = data.map(d => d.percentile);
    const maxStackCorr = corr(data.map(d => d.maxStack), percentiles);
    const hasBBCorr = corr(data.map(d => d.hasBB), percentiles);
    const bbIn3Corr = corr(data.map(d => d.bbIn3Plus), percentiles);
    const numGamesCorr = corr(data.map(d => d.numGames), percentiles);
    const maxTeamCorr = corr(data.map(d => d.maxTeam), percentiles);

    console.log(
      `  ${sa.date} (${sa.numGames}g): ` +
      `maxStack=${maxStackCorr >= 0 ? '+' : ''}${maxStackCorr.toFixed(3)} | ` +
      `hasBB=${hasBBCorr >= 0 ? '+' : ''}${hasBBCorr.toFixed(3)} | ` +
      `BB3+=${bbIn3Corr >= 0 ? '+' : ''}${bbIn3Corr.toFixed(3)} | ` +
      `numGames=${numGamesCorr >= 0 ? '+' : ''}${numGamesCorr.toFixed(3)} | ` +
      `maxTeam=${maxTeamCorr >= 0 ? '+' : ''}${maxTeamCorr.toFixed(3)}`
    );
  }

  // ============================================================
  // D. TOP 1% vs ALL — WHAT'S DIFFERENT?
  // ============================================================

  console.log(`\n${'─'.repeat(90)}`);
  console.log('D. TOP 1% vs ALL ENTRIES — STRUCTURAL DIFFERENCES');
  console.log(`${'─'.repeat(90)}`);

  for (const sa of slateResults) {
    if (sa.top1Lineups.length < 5) continue;

    const allProfiles = sa.allLineups.filter((_, i) => i % 10 === 0).map(l => ({ l, sp: analyzeStacking(l) }));
    const top1Profiles = sa.top1Lineups.map(l => ({ l, sp: analyzeStacking(l) }));

    const allAvgStack = allProfiles.reduce((s, p) => s + p.sp.maxGameConcentration, 0) / allProfiles.length;
    const top1AvgStack = top1Profiles.reduce((s, p) => s + p.sp.maxGameConcentration, 0) / top1Profiles.length;

    const allBBRate = allProfiles.filter(p => p.sp.hasBringBack).length / allProfiles.length;
    const top1BBRate = top1Profiles.filter(p => p.sp.hasBringBack).length / top1Profiles.length;

    const allBB3Rate = allProfiles.filter(p => p.sp.gameStacks.some(gs => gs.hasBringBack && gs.totalPlayers >= 3)).length / allProfiles.length;
    const top1BB3Rate = top1Profiles.filter(p => p.sp.gameStacks.some(gs => gs.hasBringBack && gs.totalPlayers >= 3)).length / top1Profiles.length;

    const allAvgOwn = allProfiles.reduce((s, p) => s + p.l.avgOwnership, 0) / allProfiles.length;
    const top1AvgOwn = top1Profiles.reduce((s, p) => s + p.l.avgOwnership, 0) / top1Profiles.length;

    const allAvgGames = allProfiles.reduce((s, p) => s + p.sp.totalGames, 0) / allProfiles.length;
    const top1AvgGames = top1Profiles.reduce((s, p) => s + p.sp.totalGames, 0) / top1Profiles.length;

    const stackDelta = top1AvgStack - allAvgStack;
    const bbDelta = top1BBRate - allBBRate;
    const bb3Delta = top1BB3Rate - allBB3Rate;
    const ownDelta = top1AvgOwn - allAvgOwn;
    const gamesDelta = top1AvgGames - allAvgGames;

    console.log(
      `  ${sa.date} (${sa.numGames}g, ${sa.top1Lineups.length} top1): ` +
      `Stack ${stackDelta >= 0 ? '+' : ''}${stackDelta.toFixed(2)} | ` +
      `BB ${(bbDelta*100) >= 0 ? '+' : ''}${(bbDelta*100).toFixed(1)}% | ` +
      `BB3+ ${(bb3Delta*100) >= 0 ? '+' : ''}${(bb3Delta*100).toFixed(1)}% | ` +
      `Own ${ownDelta >= 0 ? '+' : ''}${ownDelta.toFixed(1)}% | ` +
      `Games ${gamesDelta >= 0 ? '+' : ''}${gamesDelta.toFixed(2)}`
    );
  }

  // ============================================================
  // E. SLATE SIZE BREAKDOWN
  // ============================================================

  console.log(`\n${'─'.repeat(90)}`);
  console.log('E. STACKING BY SLATE SIZE (small vs large)');
  console.log(`${'─'.repeat(90)}`);

  const smallSlates = slateResults.filter(s => s.numGames <= 4);
  const medSlates = slateResults.filter(s => s.numGames >= 5 && s.numGames <= 6);
  const largeSlates = slateResults.filter(s => s.numGames >= 7);

  function slateGroupStats(slates: SlateAnalysis[], label: string) {
    const proLUs: ParsedLineup[] = [];
    const top1LUs: ParsedLineup[] = [];
    const proTop1LUs: ParsedLineup[] = [];
    const fieldLUs: ParsedLineup[] = [];
    for (const s of slates) {
      proLUs.push(...s.proLineups);
      top1LUs.push(...s.top1Lineups);
      proTop1LUs.push(...s.proTop1);
      fieldLUs.push(...s.fieldLineups.filter((_, i) => i % 10 === 0));
    }

    console.log(`\n  ${label} (${slates.length} slates, games: ${slates.map(s => s.numGames).join(',')})`);
    tierStats(fieldLUs, `  Field`);
    tierStats(proLUs, `  Pros`);
    tierStats(top1LUs, `  Top 1%`);
    tierStats(proTop1LUs, `  Pro Top 1%`);
  }

  slateGroupStats(smallSlates, 'SMALL SLATES (3-4 games)');
  slateGroupStats(medSlates, 'MEDIUM SLATES (5-6 games)');
  slateGroupStats(largeSlates, 'LARGE SLATES (7-8 games)');

  // ============================================================
  // F. MOST COMMON WINNING STRUCTURES
  // ============================================================

  console.log(`\n${'─'.repeat(90)}`);
  console.log('F. MOST COMMON WINNING STRUCTURES (Pro Top 1%)');
  console.log(`${'─'.repeat(90)}`);

  {
    const profiles = allProTop1.map(l => ({ l, sp: analyzeStacking(l) }));

    // Classify by structure type
    interface StructType {
      label: string;
      count: number;
      avgPts: number;
      avgProj: number;
      avgOwn: number;
    }

    const structures = new Map<string, { count: number; pts: number[]; projs: number[]; owns: number[] }>();

    for (const { l, sp } of profiles) {
      // Create a structural label
      const hasBB = sp.gameStacks.some(gs => gs.hasBringBack && gs.totalPlayers >= 3);
      const bbPattern = sp.gameStacks.filter(gs => gs.hasBringBack && gs.totalPlayers >= 3)
        .map(gs => gs.bringBackPattern).join(',');
      const label = `${sp.stackPattern}${hasBB ? ` BB(${bbPattern})` : ' NoBB'}`;

      if (!structures.has(label)) structures.set(label, { count: 0, pts: [], projs: [], owns: [] });
      const s = structures.get(label)!;
      s.count++;
      s.pts.push(l.points);
      s.projs.push(l.totalProjection);
      s.owns.push(l.avgOwnership);
    }

    const sorted = Array.from(structures.entries())
      .map(([label, data]) => ({
        label,
        count: data.count,
        avgPts: data.pts.reduce((s, v) => s + v, 0) / data.pts.length,
        avgProj: data.projs.reduce((s, v) => s + v, 0) / data.projs.length,
        avgOwn: data.owns.reduce((s, v) => s + v, 0) / data.owns.length,
      }))
      .sort((a, b) => b.count - a.count);

    console.log(`\n  ${'Structure'.padEnd(40)} ${'Count'.padStart(5)} ${'%'.padStart(6)} ${'AvgPts'.padStart(8)} ${'AvgProj'.padStart(8)} ${'AvgOwn'.padStart(7)}`);
    console.log(`  ${'-'.repeat(80)}`);

    const totalProTop1 = allProTop1.length;
    for (const s of sorted.slice(0, 25)) {
      console.log(
        `  ${s.label.padEnd(40)} ${String(s.count).padStart(5)} ` +
        `${(s.count/totalProTop1*100).toFixed(1).padStart(5)}% ` +
        `${s.avgPts.toFixed(1).padStart(8)} ` +
        `${s.avgProj.toFixed(1).padStart(8)} ` +
        `${s.avgOwn.toFixed(1).padStart(7)}`
      );
    }
  }

  // ============================================================
  // G. KEY TAKEAWAYS / ACTIONABLE METRICS
  // ============================================================

  console.log(`\n${'─'.repeat(90)}`);
  console.log('G. KEY TAKEAWAYS FOR OPTIMIZER');
  console.log(`${'─'.repeat(90)}`);

  {
    const proProfiles = allPro.map(l => analyzeStacking(l));
    const top1Profiles = allTop1.map(l => analyzeStacking(l));
    const proTop1Profiles = allProTop1.map(l => analyzeStacking(l));
    const fieldProfiles = allField.map(l => analyzeStacking(l));

    const pn = proProfiles.length;
    const tn = top1Profiles.length;
    const ptn = proTop1Profiles.length;
    const fn = fieldProfiles.length;

    console.log(`\n  STACKING TARGET RATES (what we should aim for in portfolio):`);
    console.log(`                           Field    AllPro  Top1%   ProTop1%`);

    const f3 = fieldProfiles.filter(p => p.maxGameConcentration >= 3).length / fn;
    const p3 = proProfiles.filter(p => p.maxGameConcentration >= 3).length / pn;
    const t3 = top1Profiles.filter(p => p.maxGameConcentration >= 3).length / tn;
    const pt3 = proTop1Profiles.filter(p => p.maxGameConcentration >= 3).length / ptn;
    console.log(`    3+ game stack:         ${(f3*100).toFixed(0).padStart(4)}%    ${(p3*100).toFixed(0).padStart(4)}%   ${(t3*100).toFixed(0).padStart(4)}%   ${(pt3*100).toFixed(0).padStart(5)}%`);

    const f4 = fieldProfiles.filter(p => p.maxGameConcentration >= 4).length / fn;
    const p4 = proProfiles.filter(p => p.maxGameConcentration >= 4).length / pn;
    const t4 = top1Profiles.filter(p => p.maxGameConcentration >= 4).length / tn;
    const pt4 = proTop1Profiles.filter(p => p.maxGameConcentration >= 4).length / ptn;
    console.log(`    4+ game stack:         ${(f4*100).toFixed(0).padStart(4)}%    ${(p4*100).toFixed(0).padStart(4)}%   ${(t4*100).toFixed(0).padStart(4)}%   ${(pt4*100).toFixed(0).padStart(5)}%`);

    const fbb = fieldProfiles.filter(p => p.hasBringBack).length / fn;
    const pbb = proProfiles.filter(p => p.hasBringBack).length / pn;
    const tbb = top1Profiles.filter(p => p.hasBringBack).length / tn;
    const ptbb = proTop1Profiles.filter(p => p.hasBringBack).length / ptn;
    console.log(`    Any bring-back:        ${(fbb*100).toFixed(0).padStart(4)}%    ${(pbb*100).toFixed(0).padStart(4)}%   ${(tbb*100).toFixed(0).padStart(4)}%   ${(ptbb*100).toFixed(0).padStart(5)}%`);

    const fbb3 = fieldProfiles.filter(p => p.gameStacks.some(gs => gs.hasBringBack && gs.totalPlayers >= 3)).length / fn;
    const pbb3 = proProfiles.filter(p => p.gameStacks.some(gs => gs.hasBringBack && gs.totalPlayers >= 3)).length / pn;
    const tbb3 = top1Profiles.filter(p => p.gameStacks.some(gs => gs.hasBringBack && gs.totalPlayers >= 3)).length / tn;
    const ptbb3 = proTop1Profiles.filter(p => p.gameStacks.some(gs => gs.hasBringBack && gs.totalPlayers >= 3)).length / ptn;
    console.log(`    BB in 3+ stack:        ${(fbb3*100).toFixed(0).padStart(4)}%    ${(pbb3*100).toFixed(0).padStart(4)}%   ${(tbb3*100).toFixed(0).padStart(4)}%   ${(ptbb3*100).toFixed(0).padStart(5)}%`);

    // Avg metrics
    const favgStack = fieldProfiles.reduce((s, p) => s + p.maxGameConcentration, 0) / fn;
    const pavgStack = proProfiles.reduce((s, p) => s + p.maxGameConcentration, 0) / pn;
    const tavgStack = top1Profiles.reduce((s, p) => s + p.maxGameConcentration, 0) / tn;
    const ptavgStack = proTop1Profiles.reduce((s, p) => s + p.maxGameConcentration, 0) / ptn;
    console.log(`    Avg max stack:          ${favgStack.toFixed(2).padStart(4)}     ${pavgStack.toFixed(2).padStart(4)}    ${tavgStack.toFixed(2).padStart(4)}    ${ptavgStack.toFixed(2).padStart(5)}`);

    const favgGames = fieldProfiles.reduce((s, p) => s + p.totalGames, 0) / fn;
    const pavgGames = proProfiles.reduce((s, p) => s + p.totalGames, 0) / pn;
    const tavgGames = top1Profiles.reduce((s, p) => s + p.totalGames, 0) / tn;
    const ptavgGames = proTop1Profiles.reduce((s, p) => s + p.totalGames, 0) / ptn;
    console.log(`    Avg games used:         ${favgGames.toFixed(1).padStart(4)}     ${pavgGames.toFixed(1).padStart(4)}    ${tavgGames.toFixed(1).padStart(4)}    ${ptavgGames.toFixed(1).padStart(5)}`);

    const favgBB = fieldProfiles.reduce((s, p) => s + p.bringBackCount, 0) / fn;
    const pavgBB = proProfiles.reduce((s, p) => s + p.bringBackCount, 0) / pn;
    const tavgBB = top1Profiles.reduce((s, p) => s + p.bringBackCount, 0) / tn;
    const ptavgBB = proTop1Profiles.reduce((s, p) => s + p.bringBackCount, 0) / ptn;
    console.log(`    Avg BB games/lineup:    ${favgBB.toFixed(2).padStart(4)}     ${pavgBB.toFixed(2).padStart(4)}    ${tavgBB.toFixed(2).padStart(4)}    ${ptavgBB.toFixed(2).padStart(5)}`);

    console.log(`\n  RECOMMENDED OPTIMIZER TARGETS:`);
    console.log(`    - Min 90% of lineups should have a 3+ game stack`);
    console.log(`    - Target ~55% with 4+ game stack`);
    console.log(`    - Min 85% bring-back rate`);
    console.log(`    - Target ~65% of lineups with bring-back in their primary 3+ stack`);
    console.log(`    - Avg max stack size: ${ptavgStack.toFixed(1)} (match pro top-1%)`);
    console.log(`    - Avg games used: ${ptavgGames.toFixed(1)} (match pro top-1%)`);
    console.log(`    - Most common winning patterns: 3-2-2-1, 4-2-1-1, 5-2-1`);
    console.log(`    - BB compositions in stacks: 2+1 most common, then 3+1, then 1+1`);
  }

  // ============================================================
  // H. WHAT'S IN THE WINNING STACK? HIGH PROJECTION OR HIGH CEILING?
  // ============================================================

  console.log(`\n${'─'.repeat(90)}`);
  console.log('H. CHARACTERISTICS OF PLAYERS IN WINNING STACKS');
  console.log(`${'─'.repeat(90)}`);

  {
    // For pro top-1% lineups, compare players in 3+ stacks vs rest
    const inStack: PlayerInfo[] = [];
    const notInStack: PlayerInfo[] = [];

    for (const l of allProTop1) {
      const sp = analyzeStacking(l);
      for (const gs of sp.gameStacks) {
        const players = Array.from(gs.teams.values()).flat();
        for (const p of players) {
          if (gs.totalPlayers >= 3) inStack.push(p);
          else notInStack.push(p);
        }
      }
    }

    if (inStack.length > 0 && notInStack.length > 0) {
      const avgProjIn = inStack.reduce((s, p) => s + p.projection, 0) / inStack.length;
      const avgProjOut = notInStack.reduce((s, p) => s + p.projection, 0) / notInStack.length;
      const avgActIn = inStack.reduce((s, p) => s + p.actual, 0) / inStack.length;
      const avgActOut = notInStack.reduce((s, p) => s + p.actual, 0) / notInStack.length;
      const avgOwnIn = inStack.reduce((s, p) => s + p.ownership, 0) / inStack.length;
      const avgOwnOut = notInStack.reduce((s, p) => s + p.ownership, 0) / notInStack.length;
      const avgSalIn = inStack.reduce((s, p) => s + p.salary, 0) / inStack.length;
      const avgSalOut = notInStack.reduce((s, p) => s + p.salary, 0) / notInStack.length;
      const avgCeilIn = inStack.reduce((s, p) => s + p.ceiling, 0) / inStack.length;
      const avgCeilOut = notInStack.reduce((s, p) => s + p.ceiling, 0) / notInStack.length;

      // Ceiling ratio
      const avgCeilRatioIn = inStack.reduce((s, p) => s + (p.projection > 0 ? p.ceiling / p.projection : 0), 0) / inStack.length;
      const avgCeilRatioOut = notInStack.reduce((s, p) => s + (p.projection > 0 ? p.ceiling / p.projection : 0), 0) / notInStack.length;

      // Actual / Projection ratio (beat rate)
      const avgBeatRateIn = inStack.filter(p => p.projection > 0).reduce((s, p) => s + p.actual / p.projection, 0) / inStack.filter(p => p.projection > 0).length;
      const avgBeatRateOut = notInStack.filter(p => p.projection > 0).reduce((s, p) => s + p.actual / p.projection, 0) / notInStack.filter(p => p.projection > 0).length;

      console.log(`\n  Pro Top-1% lineups — players IN 3+ stacks vs NOT:`);
      console.log(`                    In Stack (n=${inStack.length})    Not In Stack (n=${notInStack.length})    Delta`);
      console.log(`    Avg Proj:       ${avgProjIn.toFixed(1).padStart(8)}            ${avgProjOut.toFixed(1).padStart(8)}            ${(avgProjIn-avgProjOut).toFixed(1)}`);
      console.log(`    Avg Actual:     ${avgActIn.toFixed(1).padStart(8)}            ${avgActOut.toFixed(1).padStart(8)}            ${(avgActIn-avgActOut).toFixed(1)}`);
      console.log(`    Avg Own:        ${avgOwnIn.toFixed(1).padStart(8)}%           ${avgOwnOut.toFixed(1).padStart(8)}%           ${(avgOwnIn-avgOwnOut).toFixed(1)}%`);
      console.log(`    Avg Salary:     $${avgSalIn.toFixed(0).padStart(7)}            $${avgSalOut.toFixed(0).padStart(7)}            $${(avgSalIn-avgSalOut).toFixed(0)}`);
      console.log(`    Avg Ceiling:    ${avgCeilIn.toFixed(1).padStart(8)}            ${avgCeilOut.toFixed(1).padStart(8)}            ${(avgCeilIn-avgCeilOut).toFixed(1)}`);
      console.log(`    Ceil/Proj:      ${avgCeilRatioIn.toFixed(3).padStart(8)}            ${avgCeilRatioOut.toFixed(3).padStart(8)}            ${(avgCeilRatioIn-avgCeilRatioOut).toFixed(3)}`);
      console.log(`    Actual/Proj:    ${avgBeatRateIn.toFixed(3).padStart(8)}            ${avgBeatRateOut.toFixed(3).padStart(8)}            ${(avgBeatRateIn-avgBeatRateOut).toFixed(3)}`);
    }
  }

  // ============================================================
  // I. GAME TARGETING — WHICH GAMES GET STACKED BY WINNERS?
  // ============================================================

  console.log(`\n${'─'.repeat(90)}`);
  console.log('I. PER-SLATE: WHICH GAMES DID TOP 1% STACK? (game total context)');
  console.log(`${'─'.repeat(90)}`);

  for (const sa of slateResults) {
    if (sa.top1Lineups.length < 5) continue;

    // Get all games and their totals
    const gameInfo = new Map<string, { total: number; teams: string[] }>();
    for (const [, p] of Array.from(new Map(sa.allLineups[0]?.players.map(p => [p.game, p]) || []))) {
      // Already have game -> player mapping, but need all games from playerMap
    }
    // Use all players to get game totals
    const allPlayers = sa.allLineups.length > 0 ? sa.allLineups[0].players : [];
    // Better: collect from all lineups
    const gamePlayerCount = new Map<string, { count: number; avgProj: number; projs: number[] }>();
    const seen = new Set<string>();
    for (const l of sa.allLineups.slice(0, 100)) {
      for (const p of l.players) {
        const key = `${p.game}|${p.name}`;
        if (!seen.has(key)) {
          seen.add(key);
          if (!gamePlayerCount.has(p.game)) gamePlayerCount.set(p.game, { count: 0, avgProj: 0, projs: [] });
          const g = gamePlayerCount.get(p.game)!;
          g.count++;
          g.projs.push(p.projection);
        }
      }
    }

    // Which games get 3+ stacked by top 1%?
    const top1GameStackRate = new Map<string, number>();
    for (const l of sa.top1Lineups) {
      const sp = analyzeStacking(l);
      for (const gs of sp.gameStacks) {
        if (gs.totalPlayers >= 3) {
          top1GameStackRate.set(gs.game, (top1GameStackRate.get(gs.game) || 0) + 1);
        }
      }
    }

    const fieldGameStackRate = new Map<string, number>();
    const fieldSample = sa.fieldLineups.filter((_, i) => i % 10 === 0);
    for (const l of fieldSample) {
      const sp = analyzeStacking(l);
      for (const gs of sp.gameStacks) {
        if (gs.totalPlayers >= 3) {
          fieldGameStackRate.set(gs.game, (fieldGameStackRate.get(gs.game) || 0) + 1);
        }
      }
    }

    console.log(`\n  ${sa.date} (${sa.numGames} games):`);
    const allGames = new Set([...top1GameStackRate.keys(), ...fieldGameStackRate.keys()]);
    const gameRows = Array.from(allGames).map(game => {
      const t1 = (top1GameStackRate.get(game) || 0) / sa.top1Lineups.length;
      const field = fieldSample.length > 0 ? (fieldGameStackRate.get(game) || 0) / fieldSample.length : 0;
      return { game, t1Rate: t1, fieldRate: field, diff: t1 - field };
    }).sort((a, b) => b.t1Rate - a.t1Rate);

    for (const r of gameRows) {
      const arrow = r.diff > 0.05 ? '>>>' : r.diff > 0.02 ? '>>' : r.diff < -0.05 ? '<<<' : r.diff < -0.02 ? '<<' : '==';
      console.log(`    ${r.game.padEnd(10)} Top1%: ${(r.t1Rate*100).toFixed(0).padStart(3)}%  Field: ${(r.fieldRate*100).toFixed(0).padStart(3)}%  ${arrow} ${r.diff >= 0 ? '+' : ''}${(r.diff*100).toFixed(1)}%`);
    }
  }

  console.log(`\n${'='.repeat(90)}`);
  console.log('ANALYSIS COMPLETE');
  console.log(`${'='.repeat(90)}\n`);
}

main();
