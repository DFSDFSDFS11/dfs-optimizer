#!/usr/bin/env node
// ============================================================
// DFS Lineup Stats Dashboard Generator
// Reads optimizer output + source projections → generates HTML dashboard
// Usage: node lineup-stats-ui.js <projections.csv> <lineups.csv>
// ============================================================
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
if (args.length < 2) {
  console.log('Usage: node lineup-stats-ui.js <projections.csv> <lineups.csv>');
  process.exit(1);
}

const projectionsFile = args[0];
const lineupsFile = args[1];

// --- Parse projections CSV ---
function parseProjections(csvPath) {
  const raw = fs.readFileSync(csvPath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());
  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));

  const players = new Map();
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCSVLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => obj[h] = vals[idx]?.trim().replace(/"/g, '') || '');

    const id = obj['DFS ID'] || obj['Id'] || '';
    if (!id) continue;

    players.set(id, {
      id,
      name: obj['Name'] || '',
      pos: obj['Pos'] || '',
      team: obj['Team'] || '',
      opp: obj['Opp'] || '',
      salary: parseFloat(obj['Salary']) || 0,
      projection: parseFloat(obj['SS Proj'] || obj['dk_points']) || 0,
      ownership: parseFloat(obj['Adj Own'] || obj['My Own']) || 0,
      ceiling: parseFloat(obj['dk_85_percentile']) || 0,
      p99: parseFloat(obj['dk_99_percentile']) || 0,
      stdDev: parseFloat(obj['dk_std']) || 0,
      order: obj['Order'] || '',
      teamTotal: parseFloat(obj['Saber Team']) || 0,
      gameTotal: parseFloat(obj['Saber Total']) || 0,
    });
  }
  return players;
}

// Simple CSV line parser handling quoted fields
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { result.push(current); current = ''; }
    else { current += ch; }
  }
  result.push(current);
  return result;
}

// --- Parse lineups CSV ---
function parseLineups(csvPath, playerMap) {
  const raw = fs.readFileSync(csvPath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());
  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));

  const lineups = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCSVLine(lines[i]);
    const playerIds = [];
    const players = [];

    // Collect player IDs from position columns (first N columns before metadata)
    for (let j = 0; j < vals.length; j++) {
      const v = vals[j]?.trim().replace(/"/g, '');
      if (!v) continue;
      // Check if this looks like a DFS ID (numeric, 7-10 digits)
      if (/^\d{7,10}$/.test(v)) {
        const p = playerMap.get(v);
        if (p) {
          playerIds.push(v);
          players.push(p);
        }
      }
    }

    if (players.length < 5) continue; // Skip malformed lines

    const projection = players.reduce((s, p) => s + p.projection, 0);
    const salary = players.reduce((s, p) => s + p.salary, 0);
    const ceiling = players.reduce((s, p) => s + p.ceiling, 0);
    const avgOwnership = players.reduce((s, p) => s + p.ownership, 0) / players.length;
    const logOwn = players.reduce((s, p) => s + Math.log(Math.max(p.ownership, 0.1) / 100), 0);
    const geoOwnership = Math.exp(logOwn / players.length) * 100;
    const dupProb = Math.exp(players.reduce((s, p) => s + Math.log(Math.max(p.ownership, 0.1) / 100), 0));

    // Stack detection
    const teamCounts = new Map();
    for (const p of players) {
      if (!['P', 'SP', 'RP'].some(pos => p.pos.includes(pos))) {
        teamCounts.set(p.team, (teamCounts.get(p.team) || 0) + 1);
      }
    }
    let stackTeam = '', stackSize = 0;
    for (const [t, c] of teamCounts) {
      if (c > stackSize) { stackSize = c; stackTeam = t; }
    }

    // Bring-back detection
    const opps = new Set();
    for (const p of players) {
      if (p.team === stackTeam && !['P', 'SP', 'RP'].some(pos => p.pos.includes(pos))) {
        opps.add(p.opp);
      }
    }
    let bringBack = 0;
    for (const p of players) {
      if (opps.has(p.team) && p.team !== stackTeam && !['P', 'SP', 'RP'].some(pos => p.pos.includes(pos))) {
        bringBack++;
      }
    }

    const ceilRatio = ceiling / Math.max(projection, 1);

    lineups.push({
      players, projection, salary, ceiling, avgOwnership, geoOwnership,
      dupProb, stackTeam, stackSize, bringBack, ceilRatio,
    });
  }
  return lineups;
}

// --- Analysis ---
function analyze(lineups) {
  if (lineups.length === 0) return null;

  const bestProj = Math.max(...lineups.map(l => l.projection));

  // Projection-Ownership tiers
  const tiers = [
    { label: '95-100%', min: 0.95, max: 1.01, color: '#10b981', target: 50 },
    { label: '90-95%', min: 0.90, max: 0.95, color: '#3b82f6', target: 15 },
    { label: '85-90%', min: 0.85, max: 0.90, color: '#f59e0b', target: 7 },
    { label: '80-85%', min: 0.80, max: 0.85, color: '#ef4444', target: 4 },
    { label: '<80%', min: 0.0, max: 0.80, color: '#8b5cf6', target: 2 },
  ];

  const tierData = tiers.map(t => {
    const lus = lineups.filter(l => {
      const pct = l.projection / bestProj;
      return pct >= t.min && pct < t.max;
    });
    if (lus.length === 0) return { ...t, count: 0, avgOwn: 0, avgGeoOwn: 0, avgProj: 0, avgSalary: 0, avgCeiling: 0, avgDupProb: 0, ownProjRatio: 0, avgCeilRatio: 0 };

    const avgOwn = lus.reduce((s, l) => s + l.avgOwnership, 0) / lus.length;
    const avgGeoOwn = lus.reduce((s, l) => s + l.geoOwnership, 0) / lus.length;
    const avgProj = lus.reduce((s, l) => s + l.projection, 0) / lus.length;
    return {
      ...t,
      count: lus.length,
      avgOwn,
      avgGeoOwn,
      avgProj,
      avgSalary: lus.reduce((s, l) => s + l.salary, 0) / lus.length,
      avgCeiling: lus.reduce((s, l) => s + l.ceiling, 0) / lus.length,
      avgDupProb: lus.reduce((s, l) => s + l.dupProb, 0) / lus.length,
      ownProjRatio: avgOwn / avgProj,
      avgCeilRatio: lus.reduce((s, l) => s + l.ceilRatio, 0) / lus.length,
    };
  });

  // Player exposure
  const exposureCounts = new Map();
  for (const lu of lineups) {
    for (const p of lu.players) {
      const key = p.id;
      if (!exposureCounts.has(key)) exposureCounts.set(key, { ...p, count: 0 });
      exposureCounts.get(key).count++;
    }
  }
  const exposures = [...exposureCounts.values()]
    .map(e => ({ ...e, exposure: e.count / lineups.length * 100 }))
    .sort((a, b) => b.exposure - a.exposure);

  // Stack distribution
  const stackDist = new Map();
  for (const lu of lineups) {
    const key = `${lu.stackTeam} (${lu.stackSize}${lu.bringBack > 0 ? '+' + lu.bringBack + 'BB' : ''})`;
    stackDist.set(key, (stackDist.get(key) || 0) + 1);
  }
  const stacks = [...stackDist.entries()].sort((a, b) => b[1] - a[1]);

  // Salary distribution
  const salaryBuckets = [];
  const minSal = Math.min(...lineups.map(l => l.salary));
  const maxSal = Math.max(...lineups.map(l => l.salary));
  const salStep = Math.ceil((maxSal - minSal) / 8 / 100) * 100 || 500;
  for (let s = minSal; s <= maxSal; s += salStep) {
    const count = lineups.filter(l => l.salary >= s && l.salary < s + salStep).length;
    salaryBuckets.push({ min: s, max: s + salStep, count });
  }

  // Ownership histogram
  const ownBuckets = [];
  for (let o = 0; o < 35; o += 5) {
    const count = lineups.filter(l => l.avgOwnership >= o && l.avgOwnership < o + 5).length;
    ownBuckets.push({ min: o, max: o + 5, count });
  }

  // Scatter data: projection vs ownership (sample 500 for perf)
  const scatterSample = lineups.length > 500
    ? lineups.filter((_, i) => i % Math.ceil(lineups.length / 500) === 0)
    : lineups;
  const scatter = scatterSample.map(l => ({
    x: l.projection,
    y: l.avgOwnership,
    sal: l.salary,
    stack: l.stackTeam,
    stackSize: l.stackSize,
    dupProb: l.dupProb,
  }));

  // Lineup-level ownership (geometric mean — the true duplication metric)
  const avgGeoOwn = lineups.reduce((s, l) => s + l.geoOwnership, 0) / lineups.length;

  // --- Field vs Portfolio Comparison ---
  // Build simulated field: ownership-weighted player usage
  const allPlayers = [...playerMap.values()].filter(p => p.projection > 0);
  const fieldPlayerUsage = new Map();
  const fieldStackUsage = new Map();
  // Simulate 5000 ownership-weighted field lineups (simple: pick players by ownership probability)
  for (let fi = 0; fi < 5000; fi++) {
    // Weighted random picks proportional to ownership
    const picked = [];
    const used = new Set();
    const totalOwn = allPlayers.reduce((s, p) => s + Math.max(p.ownership, 0.1), 0);
    for (let slot = 0; slot < 10 && picked.length < 10; slot++) {
      let r = Math.random() * totalOwn;
      for (const p of allPlayers) {
        if (used.has(p.id)) continue;
        r -= Math.max(p.ownership, 0.1);
        if (r <= 0) { picked.push(p); used.add(p.id); break; }
      }
    }
    // Track player usage
    for (const p of picked) {
      fieldPlayerUsage.set(p.id, (fieldPlayerUsage.get(p.id) || 0) + 1);
    }
    // Track stacks
    const tc = new Map();
    for (const p of picked) {
      if (!['P', 'SP', 'RP'].some(pos => p.pos.includes(pos))) {
        tc.set(p.team, (tc.get(p.team) || 0) + 1);
      }
    }
    let mxT = '', mxC = 0;
    for (const [t, c] of tc) { if (c > mxC) { mxC = c; mxT = t; } }
    if (mxC >= 3) fieldStackUsage.set(mxT, (fieldStackUsage.get(mxT) || 0) + 1);
  }

  // Field top players (by usage rate)
  const fieldPlayers = [...fieldPlayerUsage.entries()]
    .map(([id, count]) => {
      const p = playerMap.get(id);
      return { id, name: p?.name || id, team: p?.team || '?', pos: p?.pos || '?',
               ownership: p?.ownership || 0, fieldRate: count / 5000 * 100 };
    })
    .sort((a, b) => b.fieldRate - a.fieldRate)
    .slice(0, 20);

  // Field top stacks
  const fieldStacks = [...fieldStackUsage.entries()]
    .map(([team, count]) => ({ team, fieldRate: count / 5000 * 100 }))
    .sort((a, b) => b.fieldRate - a.fieldRate);

  // Our top players (already in exposures)
  // Our top stacks: extract team from stack dist
  const ourTeamStacks = new Map();
  for (const lu of lineups) {
    if (lu.stackSize >= 4) {
      ourTeamStacks.set(lu.stackTeam, (ourTeamStacks.get(lu.stackTeam) || 0) + 1);
    }
  }
  const ourStacks = [...ourTeamStacks.entries()]
    .map(([team, count]) => ({ team, ourRate: count / lineups.length * 100 }))
    .sort((a, b) => b.ourRate - a.ourRate);

  // Merge field + our stacks for comparison
  const allStackTeams = new Set([...fieldStacks.map(s => s.team), ...ourStacks.map(s => s.team)]);
  const stackComparison = [...allStackTeams].map(team => {
    const field = fieldStacks.find(s => s.team === team);
    const ours = ourStacks.find(s => s.team === team);
    return {
      team,
      fieldRate: field?.fieldRate || 0,
      ourRate: ours?.ourRate || 0,
      edge: (ours?.ourRate || 0) - (field?.fieldRate || 0),
    };
  }).sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));

  // Merge field + our players for comparison
  const playerComparison = fieldPlayers.map(fp => {
    const ourExp = exposures.find(e => e.id === fp.id);
    return {
      name: fp.name, team: fp.team, pos: fp.pos, ownership: fp.ownership,
      fieldRate: fp.fieldRate,
      ourRate: ourExp?.exposure || 0,
      edge: (ourExp?.exposure || 0) - fp.fieldRate,
    };
  });

  return {
    totalLineups: lineups.length,
    bestProj,
    avgProj: lineups.reduce((s, l) => s + l.projection, 0) / lineups.length,
    avgOwn: lineups.reduce((s, l) => s + l.avgOwnership, 0) / lineups.length,
    avgGeoOwn,
    avgSalary: lineups.reduce((s, l) => s + l.salary, 0) / lineups.length,
    avgCeiling: lineups.reduce((s, l) => s + l.ceiling, 0) / lineups.length,
    tierData,
    exposures: exposures.slice(0, 40),
    stacks: stacks.slice(0, 20),
    salaryBuckets,
    ownBuckets,
    scatter,
    stackComparison,
    playerComparison,
  };
}

// --- Generate HTML ---
function generateHTML(data) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DFS Lineup Stats Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>
<style>
  :root {
    --bg: #0f172a;
    --surface: #1e293b;
    --surface2: #334155;
    --border: #475569;
    --text: #f1f5f9;
    --text2: #94a3b8;
    --green: #10b981;
    --blue: #3b82f6;
    --yellow: #f59e0b;
    --red: #ef4444;
    --purple: #8b5cf6;
    --cyan: #06b6d4;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    background: var(--bg); color: var(--text); font-family: 'Inter', -apple-system, system-ui, sans-serif;
    min-height: 100vh;
  }
  .header {
    background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);
    border-bottom: 1px solid var(--border);
    padding: 24px 32px;
    display: flex; align-items: center; gap: 20px;
  }
  .header-icon {
    width: 48px; height: 48px; border-radius: 12px;
    background: linear-gradient(135deg, var(--blue), var(--purple));
    display: flex; align-items: center; justify-content: center;
    font-size: 24px; font-weight: 800;
  }
  .header h1 { font-size: 22px; font-weight: 700; letter-spacing: -0.5px; }
  .header p { color: var(--text2); font-size: 13px; margin-top: 2px; }

  .kpi-row {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 12px; padding: 20px 32px;
  }
  .kpi {
    background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
    padding: 16px 18px; position: relative; overflow: hidden;
  }
  .kpi::before {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px;
    background: linear-gradient(90deg, var(--blue), var(--purple));
  }
  .kpi-label { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: var(--text2); margin-bottom: 6px; }
  .kpi-value { font-size: 24px; font-weight: 700; }
  .kpi-sub { font-size: 11px; color: var(--text2); margin-top: 3px; }

  .grid { display: grid; gap: 16px; padding: 0 32px 24px; }
  .grid-2 { grid-template-columns: 1fr 1fr; }
  .grid-3 { grid-template-columns: 1fr 1fr 1fr; }
  .grid-2-1 { grid-template-columns: 2fr 1fr; }

  .card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
    padding: 20px; position: relative;
  }
  .card-title {
    font-size: 14px; font-weight: 600; margin-bottom: 16px;
    display: flex; align-items: center; gap: 8px;
  }
  .card-title .dot { width: 8px; height: 8px; border-radius: 50%; }

  /* Projection-Ownership Tier Table */
  .tier-table { width: 100%; border-collapse: collapse; }
  .tier-table th {
    text-align: left; font-size: 11px; text-transform: uppercase;
    letter-spacing: 0.8px; color: var(--text2); padding: 8px 12px;
    border-bottom: 1px solid var(--border);
  }
  .tier-table td { padding: 10px 12px; font-size: 13px; border-bottom: 1px solid rgba(71,85,105,0.3); }
  .tier-table tr:last-child td { border-bottom: none; }
  .tier-badge {
    display: inline-flex; align-items: center; gap: 6px;
    font-weight: 600; font-size: 13px;
  }
  .tier-badge .pip { width: 10px; height: 10px; border-radius: 3px; }
  .status-ok { color: var(--green); font-weight: 600; }
  .status-high { color: var(--red); font-weight: 600; }
  .status-warn { color: var(--yellow); font-weight: 600; }
  .bar-cell { position: relative; }
  .bar-bg {
    position: absolute; left: 0; top: 0; bottom: 0; border-radius: 4px; opacity: 0.12;
  }

  /* Exposure table */
  .exp-table { width: 100%; border-collapse: collapse; }
  .exp-table th {
    text-align: left; font-size: 10px; text-transform: uppercase;
    letter-spacing: 0.8px; color: var(--text2); padding: 6px 8px;
    border-bottom: 1px solid var(--border); position: sticky; top: 0;
    background: var(--surface);
  }
  .exp-table td { padding: 5px 8px; font-size: 12px; border-bottom: 1px solid rgba(71,85,105,0.2); }
  .exp-bar-wrap { width: 100%; height: 6px; background: var(--surface2); border-radius: 3px; overflow: hidden; }
  .exp-bar { height: 100%; border-radius: 3px; transition: width 0.3s; }
  .exp-scroll { max-height: 420px; overflow-y: auto; }
  .exp-scroll::-webkit-scrollbar { width: 4px; }
  .exp-scroll::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

  /* Stack chips */
  .stack-list { display: flex; flex-wrap: wrap; gap: 8px; }
  .stack-chip {
    background: var(--surface2); border: 1px solid var(--border);
    border-radius: 8px; padding: 8px 12px; font-size: 12px;
    display: flex; align-items: center; gap: 8px;
  }
  .stack-chip .count {
    background: var(--blue); color: white; border-radius: 4px;
    padding: 2px 6px; font-size: 11px; font-weight: 700;
  }

  .chart-wrap { position: relative; height: 260px; }
  .chart-wrap-tall { position: relative; height: 340px; }

  @media (max-width: 1200px) { .grid-2, .grid-3 { grid-template-columns: 1fr; } .grid-2-1 { grid-template-columns: 1fr; } }
</style>
</head>
<body>

<div class="header">
  <div class="header-icon">⚾</div>
  <div>
    <h1>DFS Lineup Stats Dashboard</h1>
    <p>${data.totalLineups} lineups · Best projection: ${data.bestProj.toFixed(1)} pts · Generated ${new Date().toLocaleDateString()}</p>
  </div>
</div>

<!-- KPI Row -->
<div class="kpi-row">
  <div class="kpi">
    <div class="kpi-label">Lineups</div>
    <div class="kpi-value">${data.totalLineups}</div>
  </div>
  <div class="kpi">
    <div class="kpi-label">Avg Projection</div>
    <div class="kpi-value">${data.avgProj.toFixed(1)}</div>
    <div class="kpi-sub">Best: ${data.bestProj.toFixed(1)}</div>
  </div>
  <div class="kpi">
    <div class="kpi-label">Avg Player Own</div>
    <div class="kpi-value">${data.avgOwn.toFixed(1)}%</div>
    <div class="kpi-sub">arithmetic mean</div>
  </div>
  <div class="kpi">
    <div class="kpi-label">Avg Lineup Own</div>
    <div class="kpi-value">${data.avgGeoOwn.toFixed(2)}%</div>
    <div class="kpi-sub">geo mean (dup proxy)</div>
  </div>
  <div class="kpi">
    <div class="kpi-label">Avg Salary</div>
    <div class="kpi-value">$${Math.round(data.avgSalary).toLocaleString()}</div>
    <div class="kpi-sub">of $50,000</div>
  </div>
  <div class="kpi">
    <div class="kpi-label">Avg Ceiling</div>
    <div class="kpi-value">${data.avgCeiling.toFixed(1)}</div>
    <div class="kpi-sub">p85 sum</div>
  </div>
  <div class="kpi">
    <div class="kpi-label">Unique Teams</div>
    <div class="kpi-value">${new Set(data.stacks.map(s => s[0].split(' ')[0])).size}</div>
    <div class="kpi-sub">stacked</div>
  </div>
</div>

<!-- Projection-Ownership Tier Table (THE KEY METRIC) -->
<div class="grid" style="padding-top:0">
  <div class="card">
    <div class="card-title"><div class="dot" style="background:var(--cyan)"></div> Projection-Ownership Profile <span style="color:var(--text2);font-size:11px;font-weight:400">(Critical: ownership must drop as projection drops)</span></div>
    <table class="tier-table">
      <thead>
        <tr>
          <th>Projection Tier</th>
          <th>Lineups</th>
          <th>Player Own%</th>
          <th>Lineup Own%</th>
          <th>Own/Proj</th>
          <th>Target Max</th>
          <th>Status</th>
          <th>Ceil Ratio</th>
          <th>Avg Proj</th>
          <th>Avg Ceiling</th>
          <th>Dup Prob</th>
        </tr>
      </thead>
      <tbody>
        ${data.tierData.filter(t => t.count > 0).map(t => {
          const status = t.avgOwn <= t.target ? 'OK' : t.avgOwn <= t.target * 1.5 ? 'WARN' : 'HIGH';
          const statusClass = status === 'OK' ? 'status-ok' : status === 'WARN' ? 'status-warn' : 'status-high';
          return `<tr>
            <td><div class="tier-badge"><span class="pip" style="background:${t.color}"></span>${t.label}</div></td>
            <td>${t.count} <span style="color:var(--text2)">(${(t.count/data.totalLineups*100).toFixed(0)}%)</span></td>
            <td class="bar-cell">
              <div class="bar-bg" style="width:${Math.min(t.avgOwn/30*100, 100)}%;background:${t.color}"></div>
              <strong>${t.avgOwn.toFixed(1)}%</strong>
            </td>
            <td>${t.avgGeoOwn.toFixed(2)}%</td>
            <td style="color:${t.ownProjRatio > 0.15 ? 'var(--red)' : t.ownProjRatio > 0.10 ? 'var(--yellow)' : 'var(--green)'}">${t.ownProjRatio.toFixed(3)}</td>
            <td style="color:var(--text2)">&lt;${t.target}%</td>
            <td><span class="${statusClass}">${status}</span></td>
            <td style="color:${t.avgCeilRatio >= 1.65 ? 'var(--green)' : t.avgCeilRatio >= 1.55 ? 'var(--yellow)' : 'var(--red)'}"><strong>${t.avgCeilRatio.toFixed(2)}</strong></td>
            <td>${t.avgProj.toFixed(1)}</td>
            <td>${t.avgCeiling.toFixed(1)}</td>
            <td style="color:${t.avgDupProb > 0.001 ? 'var(--red)' : 'var(--green)'}">${t.avgDupProb < 0.0001 ? '<0.01%' : (t.avgDupProb * 100).toFixed(2) + '%'}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>
</div>

<!-- Charts Row -->
<div class="grid grid-2">
  <div class="card">
    <div class="card-title"><div class="dot" style="background:var(--blue)"></div> Projection vs Ownership (per lineup)</div>
    <div class="chart-wrap-tall"><canvas id="scatterChart"></canvas></div>
  </div>
  <div class="card">
    <div class="card-title"><div class="dot" style="background:var(--purple)"></div> Ownership Distribution</div>
    <div class="chart-wrap-tall"><canvas id="ownChart"></canvas></div>
  </div>
</div>

<!-- Exposure + Stacks -->
<div class="grid grid-2-1">
  <div class="card">
    <div class="card-title"><div class="dot" style="background:var(--green)"></div> Player Exposure (Top 40)</div>
    <div class="exp-scroll">
      <table class="exp-table">
        <thead>
          <tr><th>Player</th><th>Pos</th><th>Team</th><th>Salary</th><th>Proj</th><th>Own%</th><th>Exposure</th><th></th></tr>
        </thead>
        <tbody>
          ${data.exposures.map(e => {
            const barColor = e.exposure > 40 ? 'var(--red)' : e.exposure > 25 ? 'var(--yellow)' : 'var(--green)';
            return `<tr>
              <td style="font-weight:600">${e.name}</td>
              <td style="color:var(--text2)">${e.pos}</td>
              <td>${e.team}</td>
              <td>$${e.salary.toLocaleString()}</td>
              <td>${e.projection.toFixed(1)}</td>
              <td>${e.ownership.toFixed(1)}%</td>
              <td style="width:100px">
                <div class="exp-bar-wrap"><div class="exp-bar" style="width:${Math.min(e.exposure, 100)}%;background:${barColor}"></div></div>
              </td>
              <td style="font-weight:600;font-size:12px">${e.exposure.toFixed(1)}%</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  </div>
  <div class="card">
    <div class="card-title"><div class="dot" style="background:var(--yellow)"></div> Stack Distribution</div>
    <div class="stack-list">
      ${data.stacks.map(([label, count]) => {
        return `<div class="stack-chip"><span class="count">${count}</span>${label}</div>`;
      }).join('')}
    </div>
    <div style="margin-top:20px">
      <div class="card-title" style="margin-bottom:12px"><div class="dot" style="background:var(--cyan)"></div> Salary Distribution</div>
      <div class="chart-wrap"><canvas id="salaryChart"></canvas></div>
    </div>
  </div>
</div>

<!-- Field vs Portfolio Comparison -->
<div class="grid grid-2">
  <div class="card">
    <div class="card-title"><div class="dot" style="background:var(--red)"></div> Stacks: Field vs Our Portfolio</div>
    <table class="exp-table">
      <thead><tr><th>Team</th><th>Field Rate</th><th>Our Rate</th><th>Edge</th><th></th></tr></thead>
      <tbody>
        ${data.stackComparison.map(s => {
          const edgeColor = s.edge > 3 ? 'var(--green)' : s.edge < -3 ? 'var(--red)' : 'var(--text2)';
          const edgeSign = s.edge > 0 ? '+' : '';
          const barW = Math.min(Math.max(s.ourRate, s.fieldRate), 40);
          return `<tr>
            <td style="font-weight:600">${s.team}</td>
            <td>${s.fieldRate.toFixed(1)}%</td>
            <td style="font-weight:600">${s.ourRate.toFixed(1)}%</td>
            <td style="color:${edgeColor};font-weight:600">${edgeSign}${s.edge.toFixed(1)}%</td>
            <td style="width:120px">
              <div style="display:flex;gap:2px;align-items:center">
                <div style="height:8px;width:${s.fieldRate/40*100}%;background:var(--red);border-radius:2px;opacity:0.5" title="Field"></div>
                <div style="height:8px;width:${s.ourRate/40*100}%;background:var(--green);border-radius:2px" title="Ours"></div>
              </div>
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>
  <div class="card">
    <div class="card-title"><div class="dot" style="background:var(--cyan)"></div> Players: Field vs Our Portfolio (Top 20)</div>
    <div class="exp-scroll">
    <table class="exp-table">
      <thead><tr><th>Player</th><th>Team</th><th>Own%</th><th>Field</th><th>Ours</th><th>Edge</th></tr></thead>
      <tbody>
        ${data.playerComparison.map(p => {
          const edgeColor = p.edge > 5 ? 'var(--green)' : p.edge < -5 ? 'var(--red)' : 'var(--text2)';
          const edgeSign = p.edge > 0 ? '+' : '';
          return `<tr>
            <td style="font-weight:600">${p.name}</td>
            <td>${p.team}</td>
            <td style="color:var(--text2)">${p.ownership.toFixed(1)}%</td>
            <td>${p.fieldRate.toFixed(1)}%</td>
            <td style="font-weight:600">${p.ourRate.toFixed(1)}%</td>
            <td style="color:${edgeColor};font-weight:600">${edgeSign}${p.edge.toFixed(1)}%</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
    </div>
  </div>
</div>

<div style="padding:16px 32px;text-align:center;color:var(--text2);font-size:11px">
  DFS Optimizer — Combo-Level Portfolio Construction — Generated ${new Date().toLocaleString()}
</div>

<script>
Chart.defaults.color = '#94a3b8';
Chart.defaults.borderColor = 'rgba(71,85,105,0.3)';
Chart.defaults.font.family = "'Inter', -apple-system, system-ui, sans-serif";

// Scatter: Projection vs Ownership
const scatterData = ${JSON.stringify(data.scatter)};
new Chart(document.getElementById('scatterChart'), {
  type: 'scatter',
  data: {
    datasets: [{
      data: scatterData.map(d => ({ x: d.x, y: d.y })),
      backgroundColor: scatterData.map(d => {
        const projPct = d.x / ${data.bestProj};
        if (projPct >= 0.95) return 'rgba(16,185,129,0.5)';
        if (projPct >= 0.90) return 'rgba(59,130,246,0.5)';
        if (projPct >= 0.85) return 'rgba(245,158,11,0.5)';
        return 'rgba(239,68,68,0.5)';
      }),
      pointRadius: 3,
      pointHoverRadius: 6,
    }]
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false },
      tooltip: {
        callbacks: {
          label: (ctx) => {
            const d = scatterData[ctx.dataIndex];
            return \`Proj: \${d.x.toFixed(1)} | Own: \${d.y.toFixed(1)}% | \${d.stack} \${d.stackSize}-man | Dup: \${(d.dupProb*100).toFixed(4)}%\`;
          }
        }
      }
    },
    scales: {
      x: { title: { display: true, text: 'Lineup Projection' }, grid: { color: 'rgba(71,85,105,0.15)' } },
      y: { title: { display: true, text: 'Avg Player Ownership %' }, grid: { color: 'rgba(71,85,105,0.15)' } }
    }
  }
});

// Ownership histogram
const ownBuckets = ${JSON.stringify(data.ownBuckets)};
new Chart(document.getElementById('ownChart'), {
  type: 'bar',
  data: {
    labels: ownBuckets.map(b => b.min + '-' + b.max + '%'),
    datasets: [{
      data: ownBuckets.map(b => b.count),
      backgroundColor: ownBuckets.map(b => {
        if (b.min < 5) return 'rgba(16,185,129,0.7)';
        if (b.min < 10) return 'rgba(59,130,246,0.7)';
        if (b.min < 15) return 'rgba(245,158,11,0.7)';
        if (b.min < 20) return 'rgba(239,68,68,0.7)';
        return 'rgba(139,92,246,0.7)';
      }),
      borderRadius: 4,
    }]
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { title: { display: true, text: 'Avg Player Ownership' }, grid: { display: false } },
      y: { title: { display: true, text: 'Lineup Count' }, grid: { color: 'rgba(71,85,105,0.15)' } }
    }
  }
});

// Salary histogram
const salBuckets = ${JSON.stringify(data.salaryBuckets)};
new Chart(document.getElementById('salaryChart'), {
  type: 'bar',
  data: {
    labels: salBuckets.map(b => '$' + (b.min/1000).toFixed(0) + 'k'),
    datasets: [{
      data: salBuckets.map(b => b.count),
      backgroundColor: 'rgba(6,182,212,0.6)',
      borderRadius: 4,
    }]
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { display: false } },
      y: { grid: { color: 'rgba(71,85,105,0.15)' } }
    }
  }
});
</script>
</body>
</html>`;
}

// --- Main ---
console.log('Loading projections...');
const playerMap = parseProjections(projectionsFile);
console.log(`  ${playerMap.size} players loaded`);

console.log('Loading lineups...');
const lineups = parseLineups(lineupsFile, playerMap);
console.log(`  ${lineups.length} lineups loaded`);

if (lineups.length === 0) {
  console.error('No lineups found! Check the lineups CSV file.');
  process.exit(1);
}

console.log('Analyzing...');
const data = analyze(lineups);

const outPath = path.join(path.dirname(lineupsFile), 'lineup-stats.html');
fs.writeFileSync(outPath, generateHTML(data));
console.log(`\nDashboard written to: ${outPath}`);
console.log('Open in browser to view.');
