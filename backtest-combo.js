#!/usr/bin/env node
// ============================================================
// DFS Optimizer Backtest — Combo Uniqueness Validation
// Runs optimizer on all historical slates, scores against actuals,
// measures hit rates + combo uniqueness metrics
// ============================================================
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SLATES_DIR = path.join(__dirname, 'historical_slates');
const COUNT = 500;
const SPORT = 'nba';
const TIMEOUT_MS = 900000; // 15 min per slate

// --- Find all complete slates ---
function findSlates() {
  const files = fs.readdirSync(SLATES_DIR);
  const projFiles = files.filter(f => f.endsWith('_projections.csv'));
  const slates = [];
  for (const pf of projFiles) {
    const base = pf.replace('_projections.csv', '');
    const af = base + '_actuals.csv';
    if (files.includes(af)) {
      slates.push({ date: base, projFile: path.join(SLATES_DIR, pf), actualsFile: path.join(SLATES_DIR, af) });
    }
  }
  return slates.sort((a, b) => a.date.localeCompare(b.date));
}

// --- Parse projections CSV (get player ID → actual points mapping) ---
function parseProjections(csvPath) {
  const raw = fs.readFileSync(csvPath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());
  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
  const players = new Map();
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',');
    const obj = {};
    headers.forEach((h, idx) => obj[h] = (vals[idx] || '').trim().replace(/"/g, ''));
    const id = obj['DFS ID'];
    if (!id) continue;
    players.set(id, {
      id, name: obj['Name'] || '', team: obj['Team'] || '',
      salary: parseFloat(obj['Salary']) || 0,
      projection: parseFloat(obj['SS Proj'] || obj['dk_points']) || 0,
      actual: parseFloat(obj['Actual']) || 0,
      ownership: parseFloat(obj['Adj Own'] || obj['My Own']) || 0,
      ceiling: parseFloat(obj['dk_85_percentile']) || 0,
    });
  }
  return players;
}

// --- Parse actuals CSV (get contest field scores) ---
function parseActuals(csvPath) {
  const raw = fs.readFileSync(csvPath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());
  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
  const rankIdx = headers.indexOf('Rank');
  const ptsIdx = headers.indexOf('Points');
  const entryIdx = headers.indexOf('EntryId');
  const nameIdx = headers.indexOf('EntryName');

  // Deduplicate by EntryId (multiple rows per entry)
  const entries = new Map();
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',');
    const eid = (vals[entryIdx] || '').trim();
    if (!eid || entries.has(eid)) continue;
    entries.set(eid, {
      rank: parseInt(vals[rankIdx]) || 9999999,
      points: parseFloat(vals[ptsIdx]) || 0,
      name: (vals[nameIdx] || '').trim(),
    });
  }
  // Sort by points descending for percentile calc
  const sorted = [...entries.values()].sort((a, b) => b.points - a.points);
  return sorted;
}

// --- Parse our generated lineups CSV ---
function parseLineups(csvPath, playerMap) {
  const raw = fs.readFileSync(csvPath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const lineups = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',');
    const players = [];
    for (const v of vals) {
      const id = v.trim().replace(/"/g, '');
      if (/^\d{7,10}$/.test(id)) {
        const p = playerMap.get(id);
        if (p) players.push(p);
      }
    }
    if (players.length < 5) continue;
    const actualPts = players.reduce((s, p) => s + p.actual, 0);
    const projection = players.reduce((s, p) => s + p.projection, 0);
    const ceiling = players.reduce((s, p) => s + p.ceiling, 0);
    const avgOwn = players.reduce((s, p) => s + p.ownership, 0) / players.length;
    lineups.push({ players, actualPts, projection, ceiling, avgOwn });
  }
  return lineups;
}

// --- Compute percentile of our lineup in the contest field ---
function computePercentile(ourPoints, fieldSorted) {
  // fieldSorted is descending by points
  let beatCount = 0;
  for (const entry of fieldSorted) {
    if (ourPoints > entry.points) beatCount++;
  }
  return beatCount / fieldSorted.length * 100;
}

// --- Main ---
async function main() {
  const slates = findSlates();
  console.log(`Found ${slates.length} historical slates\n`);

  const aggregateResults = [];
  const allTierHits = { '95-100': { lu: 0, hits1: 0 }, '90-95': { lu: 0, hits1: 0 }, '85-90': { lu: 0, hits1: 0 }, '80-85': { lu: 0, hits1: 0 } };
  let totalLineups = 0, totalTop1 = 0, totalTop5 = 0, totalTop10 = 0, totalCash = 0;
  let totalActualPts = 0, totalFieldAvg = 0;

  for (const slate of slates) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Slate: ${slate.date}`);
    console.log(`${'='.repeat(60)}`);

    // Step 1: Run optimizer
    const outFile = path.join(SLATES_DIR, `_backtest_${slate.date}.csv`);
    console.log(`Running optimizer on ${slate.date}...`);
    const t0 = Date.now();
    try {
      execSync(
        `node dist/run.js -i "${slate.projFile}" -s ${SPORT} --pool 40000 --count ${COUNT} -o "${outFile}" --mc-field-size 5000 --mc-sims 3000`,
        { cwd: __dirname, stdio: 'pipe', timeout: TIMEOUT_MS }
      );
    } catch (e) {
      console.log(`  ERROR running optimizer: ${e.message?.slice(0, 200)}`);
      continue;
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  Optimizer completed in ${elapsed}s`);

    // Step 2: Load data
    const playerMap = parseProjections(slate.projFile);
    const field = parseActuals(slate.actualsFile);
    const lineups = parseLineups(outFile, playerMap);
    if (lineups.length === 0) { console.log('  No lineups generated'); continue; }

    const fieldSize = field.length;
    const fieldAvgPts = field.reduce((s, e) => s + e.points, 0) / fieldSize;
    const bestProj = Math.max(...lineups.map(l => l.projection));

    console.log(`  Generated: ${lineups.length} lineups | Field: ${fieldSize} entries`);

    // Step 3: Score lineups against field
    let top1 = 0, top5 = 0, top10 = 0, cash = 0;
    let sumActual = 0;
    const hitLineups = [], missLineups = [];

    for (const lu of lineups) {
      const pct = computePercentile(lu.actualPts, field);
      lu.percentile = pct;
      lu.projPct = lu.projection / bestProj;
      lu.ceilRatio = lu.ceiling / Math.max(lu.projection, 1);
      sumActual += lu.actualPts;

      if (pct >= 99) { top1++; hitLineups.push(lu); }
      else { missLineups.push(lu); }
      if (pct >= 95) top5++;
      if (pct >= 90) top10++;
      if (pct >= 50) cash++;
    }

    const n = lineups.length;
    console.log(`\n  Results:`);
    console.log(`    Top 1%: ${top1}/${n} (${(top1/n*100).toFixed(2)}%)`);
    console.log(`    Top 5%: ${top5}/${n} (${(top5/n*100).toFixed(2)}%)`);
    console.log(`    Top 10%: ${top10}/${n} (${(top10/n*100).toFixed(2)}%)`);
    console.log(`    Cash rate: ${(cash/n*100).toFixed(1)}%`);
    console.log(`    Avg actual pts: ${(sumActual/n).toFixed(1)} | Field avg: ${fieldAvgPts.toFixed(1)}`);
    console.log(`    Runtime: ${elapsed}s`);

    // Step 4: Hit vs Miss combo analysis
    if (hitLineups.length > 0) {
      const hitAvgOwn = hitLineups.reduce((s, l) => s + l.avgOwn, 0) / hitLineups.length;
      const hitAvgCeil = hitLineups.reduce((s, l) => s + l.ceilRatio, 0) / hitLineups.length;
      const hitAvgProj = hitLineups.reduce((s, l) => s + l.projPct, 0) / hitLineups.length;
      const missAvgOwn = missLineups.length > 0 ? missLineups.reduce((s, l) => s + l.avgOwn, 0) / missLineups.length : 0;
      const missAvgCeil = missLineups.length > 0 ? missLineups.reduce((s, l) => s + l.ceilRatio, 0) / missLineups.length : 0;
      console.log(`\n  Hit vs Miss Analysis:`);
      console.log(`    Hits avg own: ${hitAvgOwn.toFixed(1)}% | Misses avg own: ${missAvgOwn.toFixed(1)}%`);
      console.log(`    Hits avg ceil ratio: ${hitAvgCeil.toFixed(2)} | Misses: ${missAvgCeil.toFixed(2)}`);
      console.log(`    Hits avg proj tier: ${(hitAvgProj*100).toFixed(1)}%`);
    }

    // Step 5: Projection tier breakdown
    console.log(`\n  Projection Tier Breakdown:`);
    const tiers = [
      { label: '95-100%', min: 0.95, max: 1.01, key: '95-100' },
      { label: '90-95%', min: 0.90, max: 0.95, key: '90-95' },
      { label: '85-90%', min: 0.85, max: 0.90, key: '85-90' },
      { label: '80-85%', min: 0.80, max: 0.85, key: '80-85' },
    ];
    for (const t of tiers) {
      const tier = lineups.filter(l => l.projPct >= t.min && l.projPct < t.max);
      if (tier.length === 0) continue;
      const hits = tier.filter(l => l.percentile >= 99).length;
      const avgCeil = tier.reduce((s, l) => s + l.ceilRatio, 0) / tier.length;
      const avgOwn = tier.reduce((s, l) => s + l.avgOwn, 0) / tier.length;
      console.log(`    ${t.label}: ${tier.length} lu, ${hits} hits (${(hits/tier.length*100).toFixed(1)}%), ceil=${avgCeil.toFixed(2)}, own=${avgOwn.toFixed(1)}%`);
      allTierHits[t.key].lu += tier.length;
      allTierHits[t.key].hits1 += hits;
    }

    // Accumulate
    totalLineups += n;
    totalTop1 += top1;
    totalTop5 += top5;
    totalTop10 += top10;
    totalCash += cash;
    totalActualPts += sumActual;
    totalFieldAvg += fieldAvgPts;

    aggregateResults.push({
      date: slate.date, n, top1, top5, top10, cash,
      avgActual: sumActual / n, fieldAvg: fieldAvgPts, elapsed,
    });
  }

  // --- Aggregate Summary ---
  console.log(`\n\n${'='.repeat(60)}`);
  console.log(`AGGREGATE RESULTS — ${aggregateResults.length} slates, ${totalLineups} lineups`);
  console.log(`${'='.repeat(60)}`);
  console.log(`  Top 1%:  ${totalTop1}/${totalLineups} (${(totalTop1/totalLineups*100).toFixed(2)}%)`);
  console.log(`  Top 5%:  ${totalTop5}/${totalLineups} (${(totalTop5/totalLineups*100).toFixed(2)}%)`);
  console.log(`  Top 10%: ${totalTop10}/${totalLineups} (${(totalTop10/totalLineups*100).toFixed(2)}%)`);
  console.log(`  Cash:    ${(totalCash/totalLineups*100).toFixed(1)}%`);
  console.log(`  Avg actual pts: ${(totalActualPts/totalLineups).toFixed(1)}`);

  console.log(`\n  Projection Tier Aggregate:`);
  for (const [key, data] of Object.entries(allTierHits)) {
    if (data.lu === 0) continue;
    console.log(`    ${key}%: ${data.lu} lu, ${data.hits1} hits (${(data.hits1/data.lu*100).toFixed(2)}%)`);
  }

  // Compact table
  console.log(`\n  Slate-by-Slate:`);
  console.log(`  ${'Date'.padEnd(20)} ${'Top1%'.padEnd(18)} ${'Top5%'.padEnd(18)} ${'Top10%'.padEnd(18)} ${'Time'.padEnd(8)}`);
  for (const r of aggregateResults) {
    const t1 = `${r.top1}/${r.n} (${(r.top1/r.n*100).toFixed(1)}%)`;
    const t5 = `${r.top5}/${r.n} (${(r.top5/r.n*100).toFixed(1)}%)`;
    const t10 = `${r.top10}/${r.n} (${(r.top10/r.n*100).toFixed(1)}%)`;
    console.log(`  ${r.date.padEnd(20)} ${t1.padEnd(18)} ${t5.padEnd(18)} ${t10.padEnd(18)} ${r.elapsed}s`);
  }

  // Save results
  const outPath = path.join(SLATES_DIR, 'backtest_combo_results.txt');
  // Capture console output isn't trivial — just note the file
  console.log(`\nBacktest complete. ${aggregateResults.length} slates processed.`);
}

main().catch(e => { console.error(e); process.exit(1); });
