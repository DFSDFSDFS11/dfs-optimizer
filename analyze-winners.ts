/**
 * Contest Winner Analysis — Ground Truth from 17 NBA Slates
 *
 * Parses actual contest results and projections to profile:
 * 1. What top-1% lineups look like structurally
 * 2. How pro 150-max portfolios are built
 * 3. What separates top-1% from top-5%
 */

import * as fs from 'fs';
import * as path from 'path';

const DATA_DIR = './historical_slates';
const NBA_POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL'];

interface PlayerData {
  name: string; team: string; salary: number; actual: number;
  projection: number; ownership: number; ceiling: number;
  positions: string[]; gameInfo: string;
}

interface ParsedLineup {
  rank: number; points: number; entryName: string;
  playerNames: string[]; players: PlayerData[];
}

interface SlateData {
  date: string; entries: ParsedLineup[]; playerPool: Map<string, PlayerData>;
  totalEntries: number; optimalProj: number;
}

// Parse lineup text "PG Player1 SG Player2 ..."
function parseLineupText(text: string): string[] {
  const names: string[] = [];
  // Split by position markers
  const parts = text.split(/\s+(?=PG |SG |SF |PF |C |G |F |UTIL )/);
  for (const part of parts) {
    // Remove position prefix
    const cleaned = part.replace(/^(PG|SG|SF|PF|C|G|F|UTIL)\s+/, '').trim();
    if (cleaned) names.push(cleaned);
  }
  return names;
}

function loadSlate(date: string, projFile: string, actualsFile: string): SlateData | null {
  // Load projections
  const projRaw = fs.readFileSync(path.join(DATA_DIR, projFile), 'utf-8');
  const projLines = projRaw.split(/\r?\n/).filter(l => l.trim());
  const projHeaders = projLines[0].split(',');

  const nameIdx = projHeaders.indexOf('Name');
  const teamIdx = projHeaders.indexOf('Team');
  const salaryIdx = projHeaders.indexOf('Salary');
  const actualIdx = projHeaders.indexOf('Actual');
  const projIdx = projHeaders.indexOf('SS Proj');
  const ownIdx = projHeaders.indexOf('My Own') >= 0 ? projHeaders.indexOf('My Own') : projHeaders.indexOf('Adj Own');
  const posIdx = projHeaders.indexOf('Pos');
  const ceilIdx = projHeaders.indexOf('dk_85_percentile') >= 0 ? projHeaders.indexOf('dk_85_percentile') : -1;
  const oppIdx = projHeaders.indexOf('Opp');

  const playerPool = new Map<string, PlayerData>();
  let optimalProj = 0;

  for (let i = 1; i < projLines.length; i++) {
    const cols = projLines[i].split(',');
    const name = cols[nameIdx]?.trim();
    if (!name) continue;
    const proj = parseFloat(cols[projIdx]) || 0;
    const team = cols[teamIdx]?.trim() || '';
    const opp = cols[oppIdx]?.trim() || '';
    const p: PlayerData = {
      name,
      team,
      salary: parseFloat(cols[salaryIdx]) || 0,
      actual: parseFloat(cols[actualIdx]) || 0,
      projection: proj,
      ownership: parseFloat(cols[ownIdx]) || 0,
      ceiling: ceilIdx >= 0 ? parseFloat(cols[ceilIdx]) || proj * 1.25 : proj * 1.25,
      positions: (cols[posIdx]?.trim() || '').split('/'),
      gameInfo: `${team}@${opp}`,
    };
    playerPool.set(name, p);
    if (proj > optimalProj) optimalProj = proj;
  }

  // Load actuals
  const actRaw = fs.readFileSync(path.join(DATA_DIR, actualsFile), 'utf-8').replace(/^\uFEFF/, '');
  const actLines = actRaw.split(/\r?\n/).filter(l => l.trim());

  const entries: ParsedLineup[] = [];
  for (let i = 1; i < actLines.length; i++) {
    const cols = actLines[i].split(',');
    const rank = parseInt(cols[0]);
    const entryName = cols[2]?.trim() || '';
    const points = parseFloat(cols[4]);
    const lineupText = cols[5]?.trim() || '';
    if (isNaN(rank) || isNaN(points) || !lineupText) continue;

    const playerNames = parseLineupText(lineupText);
    const players = playerNames.map(n => playerPool.get(n)).filter((p): p is PlayerData => p !== undefined);

    entries.push({ rank, points, entryName, playerNames, players });
  }

  if (entries.length < 100 || playerPool.size < 20) return null;

  return { date, entries, playerPool, totalEntries: entries.length, optimalProj };
}

function avg(arr: number[]): number { return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

function analyzeLineup(lu: ParsedLineup, optimalProj: number) {
  const ps = lu.players;
  if (ps.length < 6) return null; // Not enough matched players

  const teamCounts = new Map<string, number>();
  const gameCounts = new Map<string, number>();
  let salarySum = 0, ownSum = 0, projSum = 0, ceilSum = 0;
  let numAbove8K = 0, numAbove9K = 0, numBelow4K = 0;
  let numAbove30Own = 0, numAbove20Own = 0, numBelow10Own = 0, numBelow5Own = 0;
  let numAboveProj = 0;
  let bigBoom = -999, bigBoomName = '', bigBoomOwn = 0, bigBoomSalary = 0, bigBoomPos = '';

  for (const p of ps) {
    teamCounts.set(p.team, (teamCounts.get(p.team) || 0) + 1);
    const gKey = [p.team, p.gameInfo].sort().join('|');
    gameCounts.set(p.gameInfo, (gameCounts.get(p.gameInfo) || 0) + 1);
    salarySum += p.salary;
    ownSum += p.ownership;
    projSum += p.projection;
    ceilSum += p.ceiling;
    if (p.salary >= 8000) numAbove8K++;
    if (p.salary >= 9000) numAbove9K++;
    if (p.salary < 4000) numBelow4K++;
    if (p.ownership >= 30) numAbove30Own++;
    if (p.ownership >= 20) numAbove20Own++;
    if (p.ownership < 10) numBelow10Own++;
    if (p.ownership < 5) numBelow5Own++;
    if (p.actual > p.projection) numAboveProj++;
    const boom = p.actual - p.projection;
    if (boom > bigBoom) {
      bigBoom = boom; bigBoomName = p.name; bigBoomOwn = p.ownership;
      bigBoomSalary = p.salary; bigBoomPos = p.positions[0] || '?';
    }
  }

  const maxTeam = Math.max(...teamCounts.values());
  const distinctTeams = teamCounts.size;
  const distinctGames = new Set(ps.map(p => p.gameInfo)).size;

  // Bring-back: does the primary stack team's opponent have a player too?
  let primaryTeam = '';
  for (const [t, c] of teamCounts) { if (c === maxTeam) { primaryTeam = t; break; } }
  const primaryPlayers = ps.filter(p => p.team === primaryTeam);
  const primaryOpp = primaryPlayers[0]?.gameInfo?.replace(primaryTeam, '').replace('@', '') || '';
  const hasBringBack = ps.some(p => p.team === primaryOpp && p.team !== primaryTeam);

  // Team rank by projection
  const teamProjs = new Map<string, number>();
  for (const p of ps) {
    teamProjs.set(p.team, (teamProjs.get(p.team) || 0) + p.projection);
  }

  return {
    points: lu.points,
    projPts: projSum,
    projPctOfOptimal: projSum / optimalProj,
    actualMinusProj: lu.points - projSum,
    primaryStackSize: maxTeam,
    hasBringBack,
    numDistinctTeams: distinctTeams,
    numDistinctGames: distinctGames,
    salaryUsed: salarySum,
    numAbove8K, numAbove9K, numBelow4K,
    avgOwnership: ownSum / ps.length,
    numAbove30Own, numAbove20Own, numBelow10Own, numBelow5Own,
    numAboveProj,
    bigBoom, bigBoomOwn, bigBoomSalary, bigBoomPos, bigBoomName,
    ceilingRatio: ceilSum / Math.max(1, projSum),
    entryName: lu.entryName,
    rank: lu.rank,
    nPlayers: ps.length,
  };
}

function main() {
  console.log('================================================================');
  console.log('CONTEST WINNER ANALYSIS — 17 NBA Slates (Ground Truth)');
  console.log('================================================================\n');

  // Find all slate pairs
  const files = fs.readdirSync(DATA_DIR);
  const slates: SlateData[] = [];

  for (const f of files) {
    if (!f.includes('_actuals')) continue;
    const base = f.replace('_actuals.csv', '');
    const projFile = files.find(pf => pf.startsWith(base) && pf.includes('projections'));
    if (!projFile) continue;

    const slate = loadSlate(base, projFile, f);
    if (slate) {
      slates.push(slate);
      console.log(`Loaded ${base}: ${slate.entries.length} entries, ${slate.playerPool.size} players`);
    }
  }

  console.log(`\nTotal slates: ${slates.length}\n`);

  // Collect all analyzed lineups across slates
  type Profile = NonNullable<ReturnType<typeof analyzeLineup>>;
  const allTop1: Profile[] = [];
  const allTop5: Profile[] = [];
  const allTop10: Profile[] = [];
  const allField: Profile[] = [];
  const allTop2to5: Profile[] = [];

  for (const slate of slates) {
    const n = slate.entries.length;
    const top1Cutoff = Math.floor(n * 0.01);
    const top5Cutoff = Math.floor(n * 0.05);
    const top10Cutoff = Math.floor(n * 0.10);

    for (const entry of slate.entries) {
      const profile = analyzeLineup(entry, slate.optimalProj);
      if (!profile) continue;

      if (entry.rank <= top1Cutoff) allTop1.push(profile);
      if (entry.rank <= top5Cutoff && entry.rank > top1Cutoff) allTop2to5.push(profile);
      if (entry.rank <= top5Cutoff) allTop5.push(profile);
      if (entry.rank <= top10Cutoff) allTop10.push(profile);
      allField.push(profile);
    }
  }

  console.log(`Analyzed: ${allField.length} total, ${allTop1.length} top-1%, ${allTop5.length} top-5%, ${allTop10.length} top-10%\n`);

  // ================================================================
  // SECTION 1: TOP 1% LINEUP PROFILE
  // ================================================================
  console.log('================================================================');
  console.log('SECTION 1: TOP 1% LINEUP PROFILE (GROUND TRUTH)');
  console.log('================================================================\n');

  const f = (v: number, d: number = 1) => v.toFixed(d);

  console.log('Stack structure:');
  const stackDist = (arr: Profile[]) => {
    const d = { s2: 0, s3: 0, s4: 0, s5: 0 };
    for (const p of arr) {
      if (p.primaryStackSize >= 5) d.s5++;
      else if (p.primaryStackSize === 4) d.s4++;
      else if (p.primaryStackSize === 3) d.s3++;
      else d.s2++;
    }
    return d;
  };
  const t1s = stackDist(allTop1);
  const fs_ = stackDist(allField);
  console.log(`  ${'Size'.padEnd(8)} ${'Top 1%'.padStart(10)} ${'Field'.padStart(10)} ${'Lift'.padStart(10)}`);
  for (const [k, label] of [['s2','2-man'],['s3','3-man'],['s4','4-man'],['s5','5-man']] as const) {
    const t1p = t1s[k] / allTop1.length * 100;
    const fp = fs_[k] / allField.length * 100;
    const lift = fp > 0 ? (t1p / fp).toFixed(2) + 'x' : 'n/a';
    console.log(`  ${label.padEnd(8)} ${f(t1p,1).padStart(9)}% ${f(fp,1).padStart(9)}% ${lift.padStart(10)}`);
  }

  console.log(`\n  Bring-back rate:  top1%: ${f(allTop1.filter(p=>p.hasBringBack).length/allTop1.length*100)}%  field: ${f(allField.filter(p=>p.hasBringBack).length/allField.length*100)}%`);
  console.log(`  Avg distinct games: top1%: ${f(avg(allTop1.map(p=>p.numDistinctGames)))}  field: ${f(avg(allField.map(p=>p.numDistinctGames)))}`);

  // ================================================================
  // SECTION 2: COMPARISON TABLE
  // ================================================================
  console.log('\n================================================================');
  console.log('SECTION 2: TOP 1% vs TOP 10% vs FIELD');
  console.log('================================================================\n');

  type MetricDef = { name: string; fn: (p: Profile) => number; fmt?: string };
  const metrics: MetricDef[] = [
    { name: 'Avg ownership', fn: p => p.avgOwnership },
    { name: 'Players >30% own', fn: p => p.numAbove30Own },
    { name: 'Players >20% own', fn: p => p.numAbove20Own },
    { name: 'Players <10% own', fn: p => p.numBelow10Own },
    { name: 'Players <5% own', fn: p => p.numBelow5Own },
    { name: 'Primary stack size', fn: p => p.primaryStackSize },
    { name: 'Distinct games', fn: p => p.numDistinctGames },
    { name: 'Salary used', fn: p => p.salaryUsed, fmt: '0' },
    { name: 'Players >$8K', fn: p => p.numAbove8K },
    { name: 'Players >$9K', fn: p => p.numAbove9K },
    { name: 'Players <$4K', fn: p => p.numBelow4K },
    { name: 'Players above proj', fn: p => p.numAboveProj },
    { name: 'Biggest boom (pts)', fn: p => p.bigBoom },
    { name: 'Biggest boom own%', fn: p => p.bigBoomOwn },
    { name: 'Biggest boom salary', fn: p => p.bigBoomSalary, fmt: '0' },
    { name: 'Ceiling ratio', fn: p => p.ceilingRatio, fmt: '3' },
    { name: 'Actual - Proj', fn: p => p.actualMinusProj },
    { name: 'Has bring-back', fn: p => p.hasBringBack ? 1 : 0, fmt: '2' },
  ];

  console.log(`  ${'Metric'.padEnd(24)} ${'Top 1%'.padStart(10)} ${'Top 10%'.padStart(10)} ${'Field'.padStart(10)} ${'1% vs F'.padStart(10)}`);
  console.log('  ' + '─'.repeat(66));
  for (const m of metrics) {
    const d = m.fmt === '0' ? 0 : m.fmt === '2' ? 2 : m.fmt === '3' ? 3 : 1;
    const t1 = avg(allTop1.map(m.fn));
    const t10 = avg(allTop10.map(m.fn));
    const fi = avg(allField.map(m.fn));
    const delta = fi !== 0 ? ((t1 - fi) / Math.abs(fi) * 100).toFixed(0) + '%' : 'n/a';
    console.log(`  ${m.name.padEnd(24)} ${t1.toFixed(d).padStart(10)} ${t10.toFixed(d).padStart(10)} ${fi.toFixed(d).padStart(10)} ${delta.padStart(10)}`);
  }

  // ================================================================
  // SECTION 3: TOP 1% vs TOP 2-5%
  // ================================================================
  console.log('\n================================================================');
  console.log('SECTION 3: WHAT SEPARATES TOP 1% FROM TOP 2-5%?');
  console.log('================================================================\n');

  console.log(`  ${'Metric'.padEnd(24)} ${'Top 1%'.padStart(10)} ${'Top 2-5%'.padStart(10)} ${'Delta'.padStart(10)} ${'Signal'.padStart(8)}`);
  console.log('  ' + '─'.repeat(54));
  for (const m of metrics) {
    const d = m.fmt === '0' ? 0 : m.fmt === '2' ? 2 : m.fmt === '3' ? 3 : 1;
    const t1 = avg(allTop1.map(m.fn));
    const t25 = avg(allTop2to5.map(m.fn));
    const delta = t1 - t25;
    const pctDelta = t25 !== 0 ? Math.abs(delta / t25) * 100 : 0;
    const sig = pctDelta > 15 ? '***' : pctDelta > 8 ? '**' : pctDelta > 3 ? '*' : '';
    console.log(`  ${m.name.padEnd(24)} ${t1.toFixed(d).padStart(10)} ${t25.toFixed(d).padStart(10)} ${(delta >= 0 ? '+' : '') + delta.toFixed(d)}`.padEnd(58) + sig.padStart(8));
  }

  // ================================================================
  // SECTION 4: BOOM PLAYER PROFILES
  // ================================================================
  console.log('\n================================================================');
  console.log('SECTION 4: BOOM PLAYER ANALYSIS');
  console.log('================================================================\n');

  console.log('Biggest boom player position (top 1% vs field):');
  const posGroups = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL'];
  for (const pos of posGroups) {
    const t1pct = allTop1.filter(p => p.bigBoomPos === pos).length / allTop1.length * 100;
    const fpct = allField.filter(p => p.bigBoomPos === pos).length / allField.length * 100;
    if (t1pct > 0 || fpct > 0) {
      console.log(`  ${pos.padEnd(6)} top1%: ${f(t1pct,0).padStart(3)}%  field: ${f(fpct,0).padStart(3)}%${t1pct > fpct + 3 ? '  ← MORE IN WINNERS' : ''}`);
    }
  }

  console.log('\nBiggest boom player salary (top 1% vs field):');
  const salBuckets = [
    { label: '$3K-5K', min: 3000, max: 5000 },
    { label: '$5K-7K', min: 5000, max: 7000 },
    { label: '$7K-9K', min: 7000, max: 9000 },
    { label: '$9K+', min: 9000, max: 99999 },
  ];
  for (const b of salBuckets) {
    const t1pct = allTop1.filter(p => p.bigBoomSalary >= b.min && p.bigBoomSalary < b.max).length / allTop1.length * 100;
    const fpct = allField.filter(p => p.bigBoomSalary >= b.min && p.bigBoomSalary < b.max).length / allField.length * 100;
    console.log(`  ${b.label.padEnd(8)} top1%: ${f(t1pct,0).padStart(3)}%  field: ${f(fpct,0).padStart(3)}%${t1pct > fpct + 3 ? '  ← MORE IN WINNERS' : ''}`);
  }

  // ================================================================
  // SECTION 5: PRO PORTFOLIO STRUCTURE
  // ================================================================
  console.log('\n================================================================');
  console.log('SECTION 5: PRO PORTFOLIO STRUCTURE (150-max sets)');
  console.log('================================================================\n');

  // Find pro usernames with high entry counts
  const proEntries = new Map<string, Profile[]>();
  for (const slate of slates) {
    for (const entry of slate.entries) {
      const profile = analyzeLineup(entry, slate.optimalProj);
      if (!profile) continue;
      const name = entry.entryName.replace(/\s*\(\d+\/\d+\)/, '').toLowerCase();
      if (!proEntries.has(name)) proEntries.set(name, []);
      proEntries.get(name)!.push(profile);
    }
  }

  // Top pros by entry count
  const topPros = [...proEntries.entries()]
    .filter(([, entries]) => entries.length >= 500)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 15);

  console.log(`  ${'Pro'.padEnd(20)} ${'Entries'.padStart(7)} ${'AvgOwn'.padStart(8)} ${'MaxStack'.padStart(9)} ${'Avg$'.padStart(8)} ${'<10%Own'.padStart(8)} ${'>30%Own'.padStart(8)} ${'AvgPts'.padStart(8)} ${'BoomOwn'.padStart(8)}`);
  console.log('  ' + '─'.repeat(88));

  for (const [name, entries] of topPros) {
    console.log(`  ${name.padEnd(20)} ${String(entries.length).padStart(7)} ${f(avg(entries.map(e=>e.avgOwnership))).padStart(8)} ${f(avg(entries.map(e=>e.primaryStackSize))).padStart(9)} ${avg(entries.map(e=>e.salaryUsed)).toFixed(0).padStart(8)} ${f(avg(entries.map(e=>e.numBelow10Own))).padStart(8)} ${f(avg(entries.map(e=>e.numAbove30Own))).padStart(8)} ${f(avg(entries.map(e=>e.points))).padStart(8)} ${f(avg(entries.map(e=>e.bigBoomOwn))).padStart(8)}`);
  }

  // ================================================================
  // SECTION 6: ACTIONABLE FINDINGS
  // ================================================================
  console.log('\n================================================================');
  console.log('SECTION 6: ACTIONABLE FINDINGS');
  console.log('================================================================\n');

  // Compute key deltas
  const t1StackSize = avg(allTop1.map(p => p.primaryStackSize));
  const fieldStackSize = avg(allField.map(p => p.primaryStackSize));
  const t1Own = avg(allTop1.map(p => p.avgOwnership));
  const fieldOwn = avg(allField.map(p => p.avgOwnership));
  const t1Below10 = avg(allTop1.map(p => p.numBelow10Own));
  const fieldBelow10 = avg(allField.map(p => p.numBelow10Own));
  const t1BoomOwn = avg(allTop1.map(p => p.bigBoomOwn));
  const fieldBoomOwn = avg(allField.map(p => p.bigBoomOwn));
  const t1Games = avg(allTop1.map(p => p.numDistinctGames));
  const fieldGames = avg(allField.map(p => p.numDistinctGames));
  const t1Above8K = avg(allTop1.map(p => p.numAbove8K));
  const fieldAbove8K = avg(allField.map(p => p.numAbove8K));
  const t1BB = allTop1.filter(p => p.hasBringBack).length / allTop1.length * 100;
  const fieldBB = allField.filter(p => p.hasBringBack).length / allField.length * 100;

  const findings = [
    { metric: 'Stack size', t1Val: t1StackSize, fieldVal: fieldStackSize, unit: '' },
    { metric: 'Avg ownership', t1Val: t1Own, fieldVal: fieldOwn, unit: '%' },
    { metric: 'Players <10% own', t1Val: t1Below10, fieldVal: fieldBelow10, unit: '' },
    { metric: 'Boom player own', t1Val: t1BoomOwn, fieldVal: fieldBoomOwn, unit: '%' },
    { metric: 'Distinct games', t1Val: t1Games, fieldVal: fieldGames, unit: '' },
    { metric: 'Players >$8K', t1Val: t1Above8K, fieldVal: fieldAbove8K, unit: '' },
    { metric: 'Bring-back rate', t1Val: t1BB, fieldVal: fieldBB, unit: '%' },
  ].sort((a, b) => Math.abs(b.t1Val - b.fieldVal) / Math.max(0.01, Math.abs(b.fieldVal)) - Math.abs(a.t1Val - a.fieldVal) / Math.max(0.01, Math.abs(a.fieldVal)));

  for (let i = 0; i < findings.length; i++) {
    const f = findings[i];
    const delta = f.t1Val - f.fieldVal;
    const pctDelta = f.fieldVal !== 0 ? (delta / Math.abs(f.fieldVal) * 100).toFixed(0) : '?';
    const direction = delta > 0 ? 'HIGHER' : 'LOWER';
    console.log(`${i + 1}. ${f.metric}: Top 1% is ${direction} (${f.t1Val.toFixed(1)}${f.unit} vs field ${f.fieldVal.toFixed(1)}${f.unit}, ${pctDelta}% delta)`);
  }

  console.log('\n================================================================\n');
}

main();
