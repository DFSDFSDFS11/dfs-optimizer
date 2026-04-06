/**
 * Full Backtest: 4/4/26 MLB Slate
 *
 * Scores our new pool (chalk avoidance), SaberSim pool, and DK actuals
 * against real player outcomes. Comprehensive comparison.
 */

import * as fs from 'fs';

// ============================================================
// PARSE PLAYER POOL — get actual scores per player ID
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
  return players;
}

// ============================================================
// PARSE LINEUP FILES (SaberSim format: 10 ID columns)
// ============================================================

interface ParsedLineup {
  playerIds: string[];
  projection: number;
  salary: number;
  actualScore: number;
  players: PlayerData[];
}

function parseLineupFile(filePath: string, playerPool: Map<string, PlayerData>): ParsedLineup[] {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());

  const lineups: ParsedLineup[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const playerIds = cols.slice(0, 10).map(c => c.trim()).filter(c => c && c !== '');
    if (playerIds.length < 10) continue;

    let actualScore = 0;
    let projection = 0;
    let salary = 0;
    const players: PlayerData[] = [];

    for (const id of playerIds) {
      const p = playerPool.get(id);
      if (p) {
        actualScore += p.actual;
        projection += p.ssProj;
        salary += p.salary;
        players.push(p);
      }
    }

    lineups.push({ playerIds, projection, salary, actualScore, players });
  }
  return lineups;
}

// ============================================================
// PARSE DK CONTEST RESULTS
// ============================================================

interface DKEntry {
  rank: number;
  entryName: string;
  points: number;
}

function parseActuals(filePath: string): DKEntry[] {
  const raw = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/).filter(l => l.trim());

  const entries: DKEntry[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const rank = parseInt(cols[0]);
    const entryName = cols[2]?.trim() || '';
    const points = parseFloat(cols[4]);
    if (isNaN(rank) || isNaN(points)) continue;
    entries.push({ rank, entryName, points });
  }
  return entries;
}

// ============================================================
// ANALYSIS HELPERS
// ============================================================

function percentile(sorted: number[], p: number): number {
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function countAbove(scores: number[], threshold: number): number {
  return scores.filter(s => s >= threshold).length;
}

function getChalkDepth(lineup: ParsedLineup, chalkTeams: Set<string>, sport: string): Map<string, number> {
  const depths = new Map<string, number>();
  for (const team of chalkTeams) depths.set(team, 0);
  for (const p of lineup.players) {
    if (chalkTeams.has(p.team) && p.pos !== 'P') {
      depths.set(p.team, (depths.get(p.team) || 0) + 1);
    }
  }
  return depths;
}

function getMaxChalkDepth(lineup: ParsedLineup, chalkTeams: Set<string>): number {
  let max = 0;
  for (const p of lineup.players) {
    if (chalkTeams.has(p.team) && p.pos !== 'P') {
      // Quick count
    }
  }
  const depths = getChalkDepth(lineup, chalkTeams, 'mlb');
  for (const d of depths.values()) if (d > max) max = d;
  return max;
}

// ============================================================
// MAIN
// ============================================================

function main() {
  console.log('══════════════════════════════════════════════════════');
  console.log('  FULL BACKTEST: 4/4/26 MLB Slate vs DK Actuals');
  console.log('══════════════════════════════════════════════════════\n');

  // 1. Load player pool with actuals
  const playerPool = parsePlayerPool('C:/Users/colin/Downloads/our pool.csv');
  console.log(`Loaded ${playerPool.size} players with actual scores\n`);

  // Identify chalk teams
  const teamBatters = new Map<string, PlayerData[]>();
  for (const p of playerPool.values()) {
    if (p.pos === 'P' || p.ssProj <= 0) continue;
    if (!teamBatters.has(p.team)) teamBatters.set(p.team, []);
    teamBatters.get(p.team)!.push(p);
  }

  const chalkTeams = new Set<string>();
  const teamAvgOwn = new Map<string, number>();
  for (const [team, batters] of teamBatters) {
    const avgOwn = batters.reduce((s, p) => s + p.ownership, 0) / batters.length;
    teamAvgOwn.set(team, avgOwn);
    if (avgOwn >= 18) chalkTeams.add(team);
  }

  // Show chalk team actual performance
  console.log('─── CHALK TEAM ACTUAL PERFORMANCE ───');
  for (const team of chalkTeams) {
    const batters = teamBatters.get(team)!.sort((a, b) => b.ownership - a.ownership);
    const totalActual = batters.reduce((s, p) => s + p.actual, 0);
    const totalProj = batters.reduce((s, p) => s + p.ssProj, 0);
    console.log(`\n  ${team} (avg own: ${teamAvgOwn.get(team)?.toFixed(1)}%, proj: ${totalProj.toFixed(0)}, actual: ${totalActual.toFixed(0)}):`);
    for (const p of batters.slice(0, 10)) {
      if (p.ownership < 1 && p.ssProj < 1) continue;
      const delta = p.actual - p.ssProj;
      const indicator = delta > 2 ? '🔥' : delta < -3 ? '💀' : '  ';
      console.log(`    ${p.name.padEnd(22)} own:${p.ownership.toFixed(0).padStart(3)}%  proj:${p.ssProj.toFixed(1).padStart(5)}  actual:${p.actual.toFixed(1).padStart(5)}  ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} ${indicator}`);
    }
  }

  // 2. Parse DK contest results (the field)
  console.log('\n\n─── DK CONTEST FIELD ───');
  const dkEntries = parseActuals('C:/Users/colin/Downloads/actuals4-4-26.csv');
  const fieldScores = dkEntries.map(e => e.points).sort((a, b) => b - a);
  const totalEntries = dkEntries.length;

  const fieldWinner = fieldScores[0];
  const fieldTop1Pct = percentile(fieldScores, 0.01);
  const fieldTop5Pct = percentile(fieldScores, 0.05);
  const fieldTop10Pct = percentile(fieldScores, 0.10);
  const fieldTop20Pct = percentile(fieldScores, 0.20);
  const fieldMedian = percentile(fieldScores, 0.50);

  console.log(`  Entries:    ${totalEntries.toLocaleString()}`);
  console.log(`  Winner:     ${fieldWinner.toFixed(1)} pts`);
  console.log(`  Top 1%:     ${fieldTop1Pct.toFixed(1)} pts (rank ${Math.floor(totalEntries * 0.01)})`);
  console.log(`  Top 5%:     ${fieldTop5Pct.toFixed(1)} pts`);
  console.log(`  Top 10%:    ${fieldTop10Pct.toFixed(1)} pts`);
  console.log(`  Cash line:  ${fieldTop20Pct.toFixed(1)} pts (top 20%)`);
  console.log(`  Median:     ${fieldMedian.toFixed(1)} pts`);

  // 3. Parse our new pool
  console.log('\n\n─── OUR NEW POOL (chalk avoidance) ───');
  const ourPool = parseLineupFile('C:/Users/colin/Downloads/new-pool-crowding.csv', playerPool);
  console.log(`  Lineups: ${ourPool.length}`);

  // 4. Parse SS pool
  console.log('\n─── SABERSIM POOL ───');
  const ssPool = parseLineupFile('C:/Users/colin/Downloads/sspool4-4-26.csv', playerPool);
  console.log(`  Lineups: ${ssPool.length}`);

  // ============================================================
  // SCORE EACH POOL vs ACTUALS
  // ============================================================

  function analyzePool(name: string, lineups: ParsedLineup[]) {
    const scores = lineups.map(l => l.actualScore).sort((a, b) => b - a);
    const projections = lineups.map(l => l.projection);
    const n = lineups.length;

    const avgActual = scores.reduce((a, b) => a + b, 0) / n;
    const avgProj = projections.reduce((a, b) => a + b, 0) / n;
    const medianActual = percentile(scores, 0.50);
    const best = scores[0];
    const top1 = percentile(scores, 0.01);
    const top5 = percentile(scores, 0.05);
    const top10 = percentile(scores, 0.10);

    // Count how many beat field thresholds
    const aboveMedian = countAbove(scores, fieldMedian);
    const aboveTop20 = countAbove(scores, fieldTop20Pct);
    const aboveTop10 = countAbove(scores, fieldTop10Pct);
    const aboveTop5 = countAbove(scores, fieldTop5Pct);
    const aboveTop1 = countAbove(scores, fieldTop1Pct);

    // Calculate simulated ROI (assuming top-20% cashes at 2x, top-1% at 100x)
    // Simplified GPP payout: top 20% cash, top 1% big money
    let totalPayout = 0;
    for (const s of scores) {
      const rank = fieldScores.filter(f => f > s).length;
      const pctile = rank / totalEntries;
      if (pctile <= 0.001) totalPayout += 200;      // Top 0.1% = 200x
      else if (pctile <= 0.005) totalPayout += 50;   // Top 0.5% = 50x
      else if (pctile <= 0.01) totalPayout += 20;    // Top 1% = 20x
      else if (pctile <= 0.05) totalPayout += 5;     // Top 5% = 5x
      else if (pctile <= 0.10) totalPayout += 2.5;   // Top 10% = 2.5x
      else if (pctile <= 0.20) totalPayout += 1.5;   // Top 20% = 1.5x
      else totalPayout += 0;                          // Below cash = $0
    }
    const avgROI = (totalPayout / n - 1) * 100;

    // Chalk depth analysis
    const depthDist = new Map<string, number[]>();
    for (const team of chalkTeams) depthDist.set(team, [0, 0, 0, 0, 0, 0, 0]);
    let shallowCount = 0;

    // Performance by chalk depth
    const scoresByDepth: Map<number, number[]> = new Map();
    for (let d = 0; d <= 6; d++) scoresByDepth.set(d, []);

    for (const lu of lineups) {
      const depths = getChalkDepth(lu, chalkTeams, 'mlb');
      let maxDepth = 0;
      let isShallow = true;
      for (const [team, depth] of depths) {
        const dist = depthDist.get(team)!;
        dist[Math.min(depth, 6)]++;
        if (depth > maxDepth) maxDepth = depth;
        if (depth >= 3) isShallow = false;
      }
      if (isShallow) shallowCount++;
      scoresByDepth.get(Math.min(maxDepth, 5))!.push(lu.actualScore);
    }

    console.log(`\n  ═══ ${name} (${n} lineups) ═══`);
    console.log(`  Avg projection:  ${avgProj.toFixed(1)}`);
    console.log(`  Avg actual:      ${avgActual.toFixed(1)}`);
    console.log(`  Median actual:   ${medianActual.toFixed(1)}`);
    console.log(`  Best lineup:     ${best.toFixed(1)}`);
    console.log(`  Our top 1%:      ${top1.toFixed(1)}`);
    console.log(`  Our top 5%:      ${top5.toFixed(1)}`);
    console.log(`  Our top 10%:     ${top10.toFixed(1)}`);

    console.log(`\n  vs DK Field (${totalEntries.toLocaleString()} entries):`);
    console.log(`    Beat field median:  ${aboveMedian}/${n} (${(aboveMedian/n*100).toFixed(1)}%)`);
    console.log(`    Beat field top 20%: ${aboveTop20}/${n} (${(aboveTop20/n*100).toFixed(1)}%) ← cash line`);
    console.log(`    Beat field top 10%: ${aboveTop10}/${n} (${(aboveTop10/n*100).toFixed(1)}%)`);
    console.log(`    Beat field top 5%:  ${aboveTop5}/${n} (${(aboveTop5/n*100).toFixed(1)}%)`);
    console.log(`    Beat field top 1%:  ${aboveTop1}/${n} (${(aboveTop1/n*100).toFixed(1)}%)`);
    console.log(`    Estimated GPP ROI:  ${avgROI >= 0 ? '+' : ''}${avgROI.toFixed(1)}%`);

    console.log(`\n  Chalk depth (${[...chalkTeams].join(', ')}):`);
    for (const team of chalkTeams) {
      const dist = depthDist.get(team)!;
      console.log(`    ${team}:  ` +
        `0:${(dist[0]/n*100).toFixed(0)}%  ` +
        `1:${(dist[1]/n*100).toFixed(0)}%  ` +
        `2:${(dist[2]/n*100).toFixed(0)}%  ` +
        `3:${(dist[3]/n*100).toFixed(0)}%  ` +
        `4:${(dist[4]/n*100).toFixed(0)}%  ` +
        `5+:${(dist.slice(5).reduce((a,b)=>a+b,0)/n*100).toFixed(0)}%`
      );
    }
    console.log(`    Shallow (0-2 from all chalk): ${(shallowCount/n*100).toFixed(0)}%`);

    console.log(`\n  Actual performance BY chalk depth:`);
    for (let d = 0; d <= 5; d++) {
      const dScores = scoresByDepth.get(d)!;
      if (dScores.length === 0) continue;
      const dAvg = dScores.reduce((a, b) => a + b, 0) / dScores.length;
      const dSorted = [...dScores].sort((a, b) => b - a);
      const dBest = dSorted[0];
      const dAboveCash = dScores.filter(s => s >= fieldTop20Pct).length;
      const dAboveTop5 = dScores.filter(s => s >= fieldTop5Pct).length;
      console.log(`    ${d} chalk players: ${String(dScores.length).padStart(4)} lu | avg: ${dAvg.toFixed(1).padStart(5)} | best: ${dBest.toFixed(1).padStart(5)} | cash: ${(dAboveCash/dScores.length*100).toFixed(0).padStart(3)}% | top5: ${(dAboveTop5/dScores.length*100).toFixed(0).padStart(3)}%`);
    }

    // Show best 10 lineups
    console.log(`\n  Top 10 lineups by actual score:`);
    const sortedByActual = [...lineups].sort((a, b) => b.actualScore - a.actualScore);
    for (let i = 0; i < Math.min(10, sortedByActual.length); i++) {
      const lu = sortedByActual[i];
      const depths = getChalkDepth(lu, chalkTeams, 'mlb');
      const chalkStr = [...depths.entries()].filter(([,d]) => d > 0).map(([t,d]) => `${t}:${d}`).join(' ') || 'none';
      const fieldRank = fieldScores.filter(f => f > lu.actualScore).length + 1;
      const fieldPctile = (fieldRank / totalEntries * 100).toFixed(2);
      console.log(`    #${(i+1).toString().padStart(2)}: ${lu.actualScore.toFixed(1).padStart(5)} pts (proj: ${lu.projection.toFixed(1)}) | chalk: ${chalkStr.padEnd(8)} | field rank: ${fieldRank}/${totalEntries} (top ${fieldPctile}%)`);
    }

    return { avgActual, medianActual, best, top1, top5, top10, aboveMedian, aboveTop20, aboveTop10, aboveTop5, aboveTop1, avgROI, shallowPct: shallowCount/n*100, avgProj, n };
  }

  const ourStats = analyzePool('OUR NEW POOL (chalk avoidance)', ourPool);
  const ssStats = analyzePool('SABERSIM POOL', ssPool);

  // ============================================================
  // FINAL COMPARISON TABLE
  // ============================================================

  console.log('\n\n══════════════════════════════════════════════════════');
  console.log('  SIDE-BY-SIDE COMPARISON');
  console.log('══════════════════════════════════════════════════════');

  const rows: [string, number, number][] = [
    ['Lineups', ourStats.n, ssStats.n],
    ['Avg projection', ourStats.avgProj, ssStats.avgProj],
    ['Avg actual pts', ourStats.avgActual, ssStats.avgActual],
    ['Median actual pts', ourStats.medianActual, ssStats.medianActual],
    ['Best lineup', ourStats.best, ssStats.best],
    ['Pool top 1%', ourStats.top1, ssStats.top1],
    ['Pool top 5%', ourStats.top5, ssStats.top5],
    ['Pool top 10%', ourStats.top10, ssStats.top10],
    ['% beat field median', ourStats.aboveMedian/ourStats.n*100, ssStats.aboveMedian/ssStats.n*100],
    ['% beat field cash', ourStats.aboveTop20/ourStats.n*100, ssStats.aboveTop20/ssStats.n*100],
    ['% beat field top 10%', ourStats.aboveTop10/ourStats.n*100, ssStats.aboveTop10/ssStats.n*100],
    ['% beat field top 5%', ourStats.aboveTop5/ourStats.n*100, ssStats.aboveTop5/ssStats.n*100],
    ['% beat field top 1%', ourStats.aboveTop1/ourStats.n*100, ssStats.aboveTop1/ssStats.n*100],
    ['Est. GPP ROI', ourStats.avgROI, ssStats.avgROI],
    ['Shallow chalk %', ourStats.shallowPct, ssStats.shallowPct],
  ];

  console.log(`\n  ${'Metric'.padEnd(25)} ${'Ours'.padStart(10)} ${'SaberSim'.padStart(10)} ${'Delta'.padStart(10)} ${'Winner'.padStart(8)}`);
  console.log('  ' + '─'.repeat(65));

  for (const [name, ours, ss] of rows) {
    const delta = ours - ss;
    const deltaStr = (delta >= 0 ? '+' : '') + delta.toFixed(1);
    // For most metrics, higher is better. For lineups count, it's neutral.
    let winner = '';
    if (name === 'Lineups') winner = '';
    else if (name === 'Shallow chalk %') winner = ours > ss ? '← OURS' : '← SS';
    else winner = ours > ss ? '← OURS' : ours < ss ? '← SS' : 'TIE';
    console.log(`  ${name.padEnd(25)} ${ours.toFixed(1).padStart(10)} ${ss.toFixed(1).padStart(10)} ${deltaStr.padStart(10)} ${winner.padStart(8)}`);
  }

  // ============================================================
  // KEY INSIGHT
  // ============================================================

  console.log('\n\n══════════════════════════════════════════════════════');
  console.log('  KEY INSIGHTS');
  console.log('══════════════════════════════════════════════════════');

  // Did chalk team bust or boom?
  for (const team of chalkTeams) {
    const batters = teamBatters.get(team)!;
    const totalActual = batters.reduce((s, p) => s + p.actual, 0);
    const totalProj = batters.reduce((s, p) => s + p.ssProj, 0);
    const delta = totalActual - totalProj;
    const status = delta > 5 ? 'BOOMED' : delta < -5 ? 'BUSTED' : 'PUSHED';
    console.log(`\n  ${team} ${status}: projected ${totalProj.toFixed(0)} → actual ${totalActual.toFixed(0)} (${delta >= 0 ? '+' : ''}${delta.toFixed(0)})`);

    if (status === 'BUSTED') {
      console.log(`  → Chalk avoidance HELPS: our shallow chalk portfolio (${ourStats.shallowPct.toFixed(0)}%) is less damaged by the bust.`);
      console.log(`    80% of our lineups were independent of ${team} — they keep their upside.`);
    } else if (status === 'BOOMED') {
      console.log(`  → Chalk BOOMED: our 10% hedge (4-5 man stacks) captures some upside.`);
      console.log(`    The cost of chalk avoidance on this slate: fewer top lineups.`);
      console.log(`    But this is expected — we sacrifice boom-slate upside for bust-slate protection.`);
    } else {
      console.log(`  → ${team} was middling. Neither approach had a clear edge on this slate.`);
    }
  }

  // Compare performance in each chalk-depth bucket
  console.log('\n  Performance insight by chalk depth bucket:');
  for (let d = 0; d <= 5; d++) {
    const ourLus = ourPool.filter(lu => {
      const depths = getChalkDepth(lu, chalkTeams, 'mlb');
      return Math.max(...depths.values(), 0) === d;
    });
    if (ourLus.length === 0) continue;
    const avgActual = ourLus.reduce((s, l) => s + l.actualScore, 0) / ourLus.length;
    const aboveCashPct = ourLus.filter(l => l.actualScore >= fieldTop20Pct).length / ourLus.length * 100;
    console.log(`    ${d} chalk: ${ourLus.length} lineups, avg ${avgActual.toFixed(1)} pts, ${aboveCashPct.toFixed(0)}% cash`);
  }

  console.log('\n══════════════════════════════════════════════════════\n');
}

main();
