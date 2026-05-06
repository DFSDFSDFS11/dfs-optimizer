/**
 * Backtest Chalk Avoidance - 4/4/26 MLB Slate
 *
 * Compares:
 * 1. Our NEW pool (with chalk avoidance)
 * 2. SaberSim's pool (sspool4-4-26.csv)
 * 3. DK actuals (contest results)
 *
 * Scores all pools against actual DK points and analyzes chalk depth.
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================
// PARSE PLAYER POOL (our pool.csv) — get actual scores & player data
// ============================================================

interface PlayerData {
  id: string;
  name: string;
  pos: string;
  team: string;
  opp: string;
  salary: number;
  actual: number;
  ssProj: number;
  ownership: number;
}

function parsePlayerPool(filePath: string): Map<string, PlayerData> {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());
  const headers = lines[0].split(',');

  const idIdx = headers.indexOf('DFS ID');
  const nameIdx = headers.indexOf('Name');
  const posIdx = headers.indexOf('Pos');
  const teamIdx = headers.indexOf('Team');
  const oppIdx = headers.indexOf('Opp');
  const salaryIdx = headers.indexOf('Salary');
  const actualIdx = headers.indexOf('Actual');
  const ssProjIdx = headers.indexOf('SS Proj');
  const ownIdx = headers.indexOf('My Own');

  const players = new Map<string, PlayerData>();
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const id = cols[idIdx]?.trim();
    if (!id) continue;
    players.set(id, {
      id,
      name: cols[nameIdx]?.trim() || '',
      pos: cols[posIdx]?.trim() || '',
      team: cols[teamIdx]?.trim() || '',
      opp: cols[oppIdx]?.trim() || '',
      salary: parseFloat(cols[salaryIdx]) || 0,
      actual: parseFloat(cols[actualIdx]) || 0,
      ssProj: parseFloat(cols[ssProjIdx]) || 0,
      ownership: parseFloat(cols[ownIdx]) || 0,
    });
  }

  // Also build name lookup (for actuals matching)
  const byName = new Map<string, PlayerData>();
  for (const p of players.values()) {
    byName.set(p.name, p);
  }

  return players;
}

// ============================================================
// PARSE SS POOL (sspool4-4-26.csv) — SaberSim's 5K lineups
// ============================================================

interface SSLineup {
  playerIds: string[];
  projScore: number;
  ownership: number;
  saberScore: number;
  actualScore?: number;
}

function parseSSPool(filePath: string): SSLineup[] {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());
  const headers = lines[0].split(',');

  // First 10 columns are position slots (P,P,C,1B,2B,3B,SS,OF,OF,OF)
  // Then: empty, Proj Score, 25th, ..., Ownership, Salary, ...
  const projIdx = headers.indexOf('Proj Score');
  const ownIdx = headers.indexOf('Ownership');
  const saberIdx = headers.indexOf('Saber Score');

  const lineups: SSLineup[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const playerIds = cols.slice(0, 10).map(c => c.trim()).filter(c => c);
    if (playerIds.length < 10) continue;

    lineups.push({
      playerIds,
      projScore: parseFloat(cols[projIdx]) || 0,
      ownership: parseFloat(cols[ownIdx]) || 0,
      saberScore: parseFloat(cols[saberIdx]) || 0,
    });
  }

  return lineups;
}

// ============================================================
// PARSE ACTUALS (DK contest results)
// ============================================================

interface ActualEntry {
  rank: number;
  entryId: string;
  entryName: string;
  points: number;
  lineup: string;
}

function parseActuals(filePath: string): ActualEntry[] {
  const raw = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, ''); // Remove BOM
  const lines = raw.split('\n').filter(l => l.trim());

  const entries: ActualEntry[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const rank = parseInt(cols[0]);
    const entryId = cols[1]?.trim();
    const entryName = cols[2]?.trim();
    const points = parseFloat(cols[4]);
    const lineup = cols[5]?.trim() || '';

    if (!entryId || isNaN(rank)) continue;
    entries.push({ rank, entryId, entryName, points, lineup });
  }

  return entries;
}

// ============================================================
// ANALYZE CHALK DEPTH for a set of lineups
// ============================================================

interface ChalkAnalysis {
  totalLineups: number;
  chalkTeams: Map<string, number>; // team → avg batter ownership
  depthDist: Map<string, number[]>; // team → [0-count, 1-count, 2-count, ...]
  shallowPct: number; // % of lineups with 0-2 from all chalk teams
  avgActualScore: number;
  medianActualScore: number;
  top1PctScore: number;
  top5PctScore: number;
  pctAboveMedian: number; // % that would beat the median entry
}

function analyzeChalkDepth(
  lineupPlayerIds: string[][],
  players: Map<string, PlayerData>,
  chalkTeams: Set<string>,
  actualScores?: number[],
): ChalkAnalysis {
  const depthDist = new Map<string, number[]>();
  for (const team of chalkTeams) {
    depthDist.set(team, [0, 0, 0, 0, 0, 0, 0]);
  }

  let shallowCount = 0;

  for (const ids of lineupPlayerIds) {
    let isShallow = true;
    for (const team of chalkTeams) {
      let ct = 0;
      for (const id of ids) {
        const p = players.get(id);
        if (p && p.team === team && p.pos !== 'P') ct++;
      }
      const dist = depthDist.get(team)!;
      dist[Math.min(ct, 6)]++;
      if (ct >= 3) isShallow = false;
    }
    if (isShallow) shallowCount++;
  }

  const scores = actualScores || [];
  const sortedScores = [...scores].sort((a, b) => b - a);

  return {
    totalLineups: lineupPlayerIds.length,
    chalkTeams: new Map(),
    depthDist,
    shallowPct: lineupPlayerIds.length > 0 ? shallowCount / lineupPlayerIds.length * 100 : 0,
    avgActualScore: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0,
    medianActualScore: scores.length > 0 ? sortedScores[Math.floor(scores.length / 2)] : 0,
    top1PctScore: sortedScores.length > 0 ? sortedScores[Math.floor(sortedScores.length * 0.01)] : 0,
    top5PctScore: sortedScores.length > 0 ? sortedScores[Math.floor(sortedScores.length * 0.05)] : 0,
    pctAboveMedian: 0,
  };
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log('===========================================');
  console.log('CHALK AVOIDANCE BACKTEST — 4/4/26 MLB Slate');
  console.log('===========================================\n');

  // 1. Parse player pool (actuals + projections)
  const playerPool = parsePlayerPool('C:/Users/colin/Downloads/our pool.csv');
  console.log(`Player pool: ${playerPool.size} players`);

  // Identify chalk teams
  const teamBatterOwn = new Map<string, { sum: number; count: number }>();
  for (const p of playerPool.values()) {
    if (p.pos === 'P') continue;
    if (p.ssProj <= 0) continue;
    const existing = teamBatterOwn.get(p.team) || { sum: 0, count: 0 };
    existing.sum += p.ownership;
    existing.count++;
    teamBatterOwn.set(p.team, existing);
  }

  const chalkTeams = new Set<string>();
  console.log('\nTeam avg batter ownership:');
  const sortedTeams = [...teamBatterOwn.entries()]
    .map(([team, data]) => ({ team, avgOwn: data.sum / data.count, count: data.count }))
    .sort((a, b) => b.avgOwn - a.avgOwn);

  for (const { team, avgOwn, count } of sortedTeams) {
    const isChalk = avgOwn >= 18;
    if (isChalk) chalkTeams.add(team);
    console.log(`  ${team.padEnd(5)} avg own: ${avgOwn.toFixed(1)}% (${count} batters) ${isChalk ? '← CHALK' : ''}`);
  }

  // Show top owned players on chalk teams
  console.log('\nTop owned players from chalk teams:');
  const chalkPlayers = [...playerPool.values()]
    .filter(p => chalkTeams.has(p.team) && p.pos !== 'P')
    .sort((a, b) => b.ownership - a.ownership)
    .slice(0, 15);
  for (const p of chalkPlayers) {
    console.log(`  ${p.name.padEnd(22)} ${p.team.padEnd(5)} ${p.ownership.toFixed(1)}% own  proj: ${p.ssProj.toFixed(1)}  actual: ${p.actual.toFixed(1)}`);
  }

  // 2. Parse SS pool
  console.log('\n-------------------------------------------');
  console.log('SABERSIM POOL (5K lineups)');
  console.log('-------------------------------------------');
  const ssPool = parseSSPool('C:/Users/colin/Downloads/sspool4-4-26.csv');
  console.log(`SS pool: ${ssPool.length} lineups`);

  // Score SS pool against actuals
  const ssActualScores: number[] = [];
  const ssPlayerIds: string[][] = [];
  for (const lu of ssPool) {
    let totalActual = 0;
    for (const id of lu.playerIds) {
      const p = playerPool.get(id);
      if (p) totalActual += p.actual;
    }
    ssActualScores.push(totalActual);
    ssPlayerIds.push(lu.playerIds);
  }

  const ssAnalysis = analyzeChalkDepth(ssPlayerIds, playerPool, chalkTeams, ssActualScores);

  console.log(`\nSS Pool Chalk Depth:`);
  for (const team of chalkTeams) {
    const dist = ssAnalysis.depthDist.get(team)!;
    console.log(`  ${team}:`);
    for (let d = 0; d <= 6; d++) {
      if (dist[d] > 0) {
        console.log(`    ${d} players: ${dist[d]} (${(dist[d]/ssPool.length*100).toFixed(1)}%)`);
      }
    }
  }
  console.log(`  Shallow chalk (0-2): ${ssAnalysis.shallowPct.toFixed(1)}%`);

  console.log(`\nSS Pool Actual Performance:`);
  const ssSorted = [...ssActualScores].sort((a, b) => b - a);
  console.log(`  Avg actual:  ${ssAnalysis.avgActualScore.toFixed(1)}`);
  console.log(`  Median:      ${ssSorted[Math.floor(ssSorted.length/2)]?.toFixed(1)}`);
  console.log(`  Best:        ${ssSorted[0]?.toFixed(1)}`);
  console.log(`  Top 1%:      ${ssSorted[Math.floor(ssSorted.length*0.01)]?.toFixed(1)}`);
  console.log(`  Top 5%:      ${ssSorted[Math.floor(ssSorted.length*0.05)]?.toFixed(1)}`);
  console.log(`  Top 10%:     ${ssSorted[Math.floor(ssSorted.length*0.10)]?.toFixed(1)}`);

  // 3. Parse DK actuals
  console.log('\n-------------------------------------------');
  console.log('DK CONTEST RESULTS');
  console.log('-------------------------------------------');
  const actuals = parseActuals('C:/Users/colin/Downloads/actuals4-4-26.csv');
  console.log(`Total entries: ${actuals.length}`);

  // Get distribution of scores
  const actualScoresSorted = actuals.map(e => e.points).sort((a, b) => b - a);
  const medianField = actualScoresSorted[Math.floor(actualScoresSorted.length / 2)];
  const top1pctField = actualScoresSorted[Math.floor(actualScoresSorted.length * 0.01)];
  const top5pctField = actualScoresSorted[Math.floor(actualScoresSorted.length * 0.05)];
  const top10pctField = actualScoresSorted[Math.floor(actualScoresSorted.length * 0.10)];

  console.log(`  Winner:     ${actualScoresSorted[0]?.toFixed(1)} pts`);
  console.log(`  Top 1%:     ${top1pctField?.toFixed(1)} pts`);
  console.log(`  Top 5%:     ${top5pctField?.toFixed(1)} pts`);
  console.log(`  Top 10%:    ${top10pctField?.toFixed(1)} pts`);
  console.log(`  Median:     ${medianField?.toFixed(1)} pts`);
  console.log(`  Cash line:  ~${actualScoresSorted[Math.floor(actualScoresSorted.length * 0.20)]?.toFixed(1)} pts (top 20%)`);

  // 4. Score SS pool vs field
  console.log('\n-------------------------------------------');
  console.log('SS POOL vs FIELD');
  console.log('-------------------------------------------');

  let ssAboveMedian = 0, ssAboveTop10 = 0, ssAboveTop5 = 0, ssAboveTop1 = 0;
  for (const score of ssActualScores) {
    if (score >= medianField) ssAboveMedian++;
    if (score >= top10pctField) ssAboveTop10++;
    if (score >= top5pctField) ssAboveTop5++;
    if (score >= top1pctField) ssAboveTop1++;
  }

  console.log(`SS Pool (${ssPool.length} lineups):`);
  console.log(`  Above median:   ${ssAboveMedian} (${(ssAboveMedian/ssPool.length*100).toFixed(1)}%)`);
  console.log(`  Above top 10%:  ${ssAboveTop10} (${(ssAboveTop10/ssPool.length*100).toFixed(1)}%)`);
  console.log(`  Above top 5%:   ${ssAboveTop5} (${(ssAboveTop5/ssPool.length*100).toFixed(1)}%)`);
  console.log(`  Above top 1%:   ${ssAboveTop1} (${(ssAboveTop1/ssPool.length*100).toFixed(1)}%)`);

  // 5. Now run OUR optimizer
  console.log('\n===========================================');
  console.log('RUNNING OUR OPTIMIZER (with chalk avoidance)');
  console.log('===========================================');
  console.log('Running node dist/run.js on the player pool...\n');

  const { execSync } = require('child_process');
  try {
    const output = execSync(
      `node dist/run.js --input "C:/Users/colin/Downloads/our pool.csv" --sport mlb --site dk --count 500 --output "C:/Users/colin/Downloads/new-pool-chalk-avoid.csv"`,
      { cwd: 'C:/Users/colin/Projects/dfs-optimizer', timeout: 300000, encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }
    );
    console.log(output);
  } catch (e: any) {
    console.log(e.stdout || '');
    console.error(e.stderr || '');
    console.error('Optimizer run failed:', e.message);
  }

  // 6. Parse our new pool and score against actuals
  console.log('\n-------------------------------------------');
  console.log('NEW POOL ANALYSIS (chalk avoidance)');
  console.log('-------------------------------------------');

  const newPoolPath = 'C:/Users/colin/Downloads/new-pool-chalk-avoid.csv';
  if (fs.existsSync(newPoolPath)) {
    const newPoolRaw = fs.readFileSync(newPoolPath, 'utf-8');
    const newPoolLines = newPoolRaw.split('\n').filter(l => l.trim());
    const newPoolHeaders = newPoolLines[0].split(',');

    // Parse new pool lineups - these are SaberSim format (player IDs in position columns)
    const newPoolPlayerIds: string[][] = [];
    const newPoolActualScores: number[] = [];

    for (let i = 1; i < newPoolLines.length; i++) {
      const cols = newPoolLines[i].split(',');
      // SaberSim format: 10 position columns (P,P,C,1B,2B,3B,SS,OF,OF,OF)
      const ids = cols.slice(0, 10).map(c => c.trim()).filter(c => c);
      if (ids.length < 10) continue;

      let totalActual = 0;
      for (const id of ids) {
        const p = playerPool.get(id);
        if (p) totalActual += p.actual;
      }
      newPoolPlayerIds.push(ids);
      newPoolActualScores.push(totalActual);
    }

    console.log(`New pool: ${newPoolPlayerIds.length} lineups`);

    // Chalk depth analysis
    const newAnalysis = analyzeChalkDepth(newPoolPlayerIds, playerPool, chalkTeams, newPoolActualScores);

    console.log(`\nNew Pool Chalk Depth:`);
    for (const team of chalkTeams) {
      const dist = newAnalysis.depthDist.get(team)!;
      console.log(`  ${team}:`);
      for (let d = 0; d <= 6; d++) {
        if (dist[d] > 0) {
          console.log(`    ${d} players: ${dist[d]} (${(dist[d]/newPoolPlayerIds.length*100).toFixed(1)}%)`);
        }
      }
    }
    console.log(`  Shallow chalk (0-2): ${newAnalysis.shallowPct.toFixed(1)}%`);

    // Score vs field
    const newSorted = [...newPoolActualScores].sort((a, b) => b - a);
    console.log(`\nNew Pool Actual Performance:`);
    console.log(`  Avg actual:  ${newAnalysis.avgActualScore.toFixed(1)}`);
    console.log(`  Median:      ${newSorted[Math.floor(newSorted.length/2)]?.toFixed(1)}`);
    console.log(`  Best:        ${newSorted[0]?.toFixed(1)}`);
    console.log(`  Top 1%:      ${newSorted[Math.floor(newSorted.length*0.01)]?.toFixed(1)}`);
    console.log(`  Top 5%:      ${newSorted[Math.floor(newSorted.length*0.05)]?.toFixed(1)}`);
    console.log(`  Top 10%:     ${newSorted[Math.floor(newSorted.length*0.10)]?.toFixed(1)}`);

    let newAboveMedian = 0, newAboveTop10 = 0, newAboveTop5 = 0, newAboveTop1 = 0;
    for (const score of newPoolActualScores) {
      if (score >= medianField) newAboveMedian++;
      if (score >= top10pctField) newAboveTop10++;
      if (score >= top5pctField) newAboveTop5++;
      if (score >= top1pctField) newAboveTop1++;
    }

    console.log(`\nNew Pool vs Field:`);
    console.log(`  Above median:   ${newAboveMedian} (${(newAboveMedian/newPoolPlayerIds.length*100).toFixed(1)}%)`);
    console.log(`  Above top 10%:  ${newAboveTop10} (${(newAboveTop10/newPoolPlayerIds.length*100).toFixed(1)}%)`);
    console.log(`  Above top 5%:   ${newAboveTop5} (${(newAboveTop5/newPoolPlayerIds.length*100).toFixed(1)}%)`);
    console.log(`  Above top 1%:   ${newAboveTop1} (${(newAboveTop1/newPoolPlayerIds.length*100).toFixed(1)}%)`);

    // 7. COMPARISON TABLE
    console.log('\n===========================================');
    console.log('COMPARISON: SS Pool vs Our New Pool');
    console.log('===========================================');
    console.log(`${'Metric'.padEnd(25)} ${'SS Pool'.padStart(12)} ${'New Pool'.padStart(12)} ${'Delta'.padStart(10)}`);
    console.log('-'.repeat(60));

    const metrics = [
      ['Lineups', ssPool.length, newPoolPlayerIds.length],
      ['Avg actual pts', ssAnalysis.avgActualScore, newAnalysis.avgActualScore],
      ['Best lineup pts', ssSorted[0], newSorted[0]],
      ['Top 1% pts', ssSorted[Math.floor(ssSorted.length*0.01)], newSorted[Math.floor(newSorted.length*0.01)]],
      ['Top 5% pts', ssSorted[Math.floor(ssSorted.length*0.05)], newSorted[Math.floor(newSorted.length*0.05)]],
      ['% above median', ssAboveMedian/ssPool.length*100, newAboveMedian/newPoolPlayerIds.length*100],
      ['% above top 10%', ssAboveTop10/ssPool.length*100, newAboveTop10/newPoolPlayerIds.length*100],
      ['% above top 5%', ssAboveTop5/ssPool.length*100, newAboveTop5/newPoolPlayerIds.length*100],
      ['% above top 1%', ssAboveTop1/ssPool.length*100, newAboveTop1/newPoolPlayerIds.length*100],
      ['Shallow chalk %', ssAnalysis.shallowPct, newAnalysis.shallowPct],
    ];

    for (const [name, ssVal, newVal] of metrics) {
      const delta = (newVal as number) - (ssVal as number);
      const deltaStr = delta > 0 ? `+${delta.toFixed(1)}` : delta.toFixed(1);
      console.log(`${(name as string).padEnd(25)} ${(ssVal as number).toFixed(1).padStart(12)} ${(newVal as number).toFixed(1).padStart(12)} ${deltaStr.padStart(10)}`);
    }

    // 8. Chalk depth comparison
    console.log('\n--- CHALK DEPTH COMPARISON ---');
    for (const team of chalkTeams) {
      const ssDist = ssAnalysis.depthDist.get(team)!;
      const newDist = newAnalysis.depthDist.get(team)!;
      console.log(`\n${team}:`);
      console.log(`${'Depth'.padEnd(12)} ${'SS Pool'.padStart(10)} ${'New Pool'.padStart(10)} ${'Target'.padStart(10)}`);
      const targets = ['55%', '24%', '16%', '≤8%', '≤10%', '', ''];
      for (let d = 0; d <= 5; d++) {
        const ssStr = ssDist[d] > 0 ? `${(ssDist[d]/ssPool.length*100).toFixed(1)}%` : '0%';
        const newStr = newDist[d] > 0 ? `${(newDist[d]/newPoolPlayerIds.length*100).toFixed(1)}%` : '0%';
        console.log(`  ${d} players`.padEnd(12) + ssStr.padStart(10) + newStr.padStart(10) + (targets[d] || '').padStart(10));
      }
    }
  }

  console.log('\n===========================================');
  console.log('BACKTEST COMPLETE');
  console.log('===========================================');
}

main().catch(console.error);
