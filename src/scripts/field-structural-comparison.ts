/**
 * Field Structural Comparison — synthetic vs actual field on every slate.
 *
 * Measures:
 *   1. Ownership RMSE (per-player ownership delta)
 *   2. 3-combo frequency RMSE (Haugh-Singal validation metric, target <0.02)
 *   3. Stack frequency (4+ same-team) comparison
 *   4. Bring-back frequency comparison
 *   5. Field centroid in (projection, ownership) space
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals } from '../parser';
import { getContestConfig } from '../rules';
import { loadOpponentModel } from '../opponent/calibration';
import { generateCalibratedField, generateBlendedField } from '../opponent/field-generator';

const DATA_DIR = 'C:/Users/colin/dfs opto';
const SLATES = [
  { slate: '4-6-26',  proj: '4-6-26_projections.csv',  actuals: 'dkactuals 4-6-26.csv',    pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26',  proj: '4-8-26projections.csv',   actuals: '4-8-26actuals.csv',       pool: '4-8-26sspool.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv',  actuals: '4-12-26actuals.csv',      pool: '4-12-26sspool.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv',  actuals: '4-14-26actuals.csv',      pool: '4-14-26sspool.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv',  actuals: '4-15-26actuals.csv',      pool: '4-15-26sspool.csv' },
  { slate: '4-17-26', proj: '4-17-26projections.csv',  actuals: '4-17-26actuals.csv',      pool: '4-17-26sspool.csv' },
  { slate: '4-18-26', proj: '4-18-26projections.csv',  actuals: '4-18-26actuals.csv',      pool: '4-18-26sspool.csv' },
];

function norm(n: string): string { return (n||'').toLowerCase().replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim(); }

interface FieldStats {
  playerOwnership: Map<string, number>;  // id → fraction
  combo3Freq: Map<string, number>;       // sorted 3-id key → fraction
  stackRate: number;                     // fraction with 4+ same-team
  bringBackRate: number;                 // fraction of stackers with bring-back
  centroidProj: number;
  centroidOwn: number;
  totalLineups: number;
}

function computeFieldStats(lineups: Lineup[], sport: string): FieldStats {
  const N = lineups.length;
  const playerCount = new Map<string, number>();
  let stackers = 0, bringBacks = 0;
  let sumProj = 0, sumOwn = 0;

  // 3-combo counting (sample if too large)
  const combo3Count = new Map<string, number>();
  const sampleSize = Math.min(N, 5000);
  const sampleStep = Math.max(1, Math.floor(N / sampleSize));

  for (let li = 0; li < N; li++) {
    const l = lineups[li];
    for (const p of l.players) playerCount.set(p.id, (playerCount.get(p.id) || 0) + 1);
    sumProj += l.projection;
    sumOwn += l.players.reduce((s, p) => s + (p.ownership || 0) / 100, 0) / l.players.length;

    // Stack + bring-back
    const teams = new Map<string, number>();
    for (const p of l.players) {
      if (sport === 'mlb' && p.positions?.includes('P')) continue;
      teams.set(p.team, (teams.get(p.team) || 0) + 1);
    }
    let maxSt = 0, stTeam = '';
    for (const [t, c] of teams) if (c > maxSt) { maxSt = c; stTeam = t; }
    if (maxSt >= 4) {
      stackers++;
      const opp = l.players.find(p => p.team === stTeam)?.opponent;
      if (opp && l.players.some(p => p.team === opp && !(sport === 'mlb' && p.positions?.includes('P')))) {
        bringBacks++;
      }
    }

    // 3-combos (sampled)
    if (li % sampleStep === 0) {
      const ids = l.players.map(p => p.id).sort();
      for (let a = 0; a < ids.length; a++) {
        for (let b = a + 1; b < ids.length; b++) {
          for (let c = b + 1; c < ids.length; c++) {
            const key = `${ids[a]}|${ids[b]}|${ids[c]}`;
            combo3Count.set(key, (combo3Count.get(key) || 0) + 1);
          }
        }
      }
    }
  }

  const playerOwnership = new Map<string, number>();
  for (const [id, c] of playerCount) playerOwnership.set(id, c / N);

  const sampledN = Math.ceil(N / sampleStep);
  const combo3Freq = new Map<string, number>();
  for (const [k, c] of combo3Count) combo3Freq.set(k, c / sampledN);

  return {
    playerOwnership,
    combo3Freq,
    stackRate: N > 0 ? stackers / N : 0,
    bringBackRate: stackers > 0 ? bringBacks / stackers : 0,
    centroidProj: N > 0 ? sumProj / N : 0,
    centroidOwn: N > 0 ? sumOwn / N : 0,
    totalLineups: N,
  };
}

function ownershipRMSE(synth: Map<string, number>, actual: Map<string, number>): number {
  const allIds = new Set([...synth.keys(), ...actual.keys()]);
  let sse = 0, count = 0;
  for (const id of allIds) {
    const sv = synth.get(id) || 0;
    const av = actual.get(id) || 0;
    if (av < 0.01 && sv < 0.01) continue; // skip irrelevant players
    sse += (sv - av) * (sv - av);
    count++;
  }
  return count > 0 ? Math.sqrt(sse / count) : 0;
}

function combo3RMSE(synth: Map<string, number>, actual: Map<string, number>): number {
  // Only compare combos that appear in actual at ≥0.5% frequency
  const significant = [...actual.entries()].filter(([, v]) => v >= 0.005).sort((a, b) => b[1] - a[1]).slice(0, 500);
  if (significant.length === 0) return 0;
  let sse = 0;
  for (const [key, av] of significant) {
    const sv = synth.get(key) || 0;
    sse += (sv - av) * (sv - av);
  }
  return Math.sqrt(sse / significant.length);
}

async function main() {
  let opponentModel: any = null;
  try { opponentModel = loadOpponentModel('C:/Users/colin/dfs opto/opponent-mlb-dk.json'); } catch {}

  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

  let md = `# Field Structural Comparison — Synthetic vs Actual\n\n`;
  md += `Haugh-Singal validation thresholds: ownership RMSE < 3pp, combo-3 RMSE < 0.02, stack gap < 5pp\n\n`;
  md += `| Slate | Entries | Own RMSE | Combo3 RMSE | Stack (synth) | Stack (actual) | Stack gap | BB (synth) | BB (actual) | BB gap | Centroid synth | Centroid actual |\n`;
  md += `|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|\n`;

  let sumOwnRMSE = 0, sumCombo3RMSE = 0, sumStackGap = 0, sumBBGap = 0, n = 0;

  for (const s of SLATES) {
    const projPath = path.join(DATA_DIR, s.proj);
    const actualsPath = path.join(DATA_DIR, s.actuals);
    const poolPath = path.join(DATA_DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) continue;

    console.log(`\n=== ${s.slate} ===`);
    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);
    const nameMap = new Map<string, Player>(); for (const p of pool.players) nameMap.set(norm(p.name), p);
    const idMap = new Map<string, Player>(); for (const p of pool.players) idMap.set(p.id, p);

    // Build actual field lineups
    const actualLineups: Lineup[] = [];
    for (const e of actuals.entries) {
      const pls: Player[] = []; let ok = true;
      for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
      if (!ok) continue;
      actualLineups.push({ players: pls, salary: pls.reduce((sm, p) => sm + p.salary, 0), projection: pls.reduce((sm, p) => sm + p.projection, 0), ownership: pls.reduce((sm, p) => sm + (p.ownership || 0), 0) / pls.length, hash: pls.map(p => p.id).sort().join('|') });
    }

    // Build synthetic field — 80/20 blend: SS pool + casual noise
    const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
    const synthLineups = generateBlendedField(
      loaded.lineups, pool.players, config,
      Math.min(8000, actualLineups.length),
      0.20, // 20% casual
    );

    console.log(`  actual: ${actualLineups.length} lineups, synth: ${synthLineups.length} lineups`);

    // Compute stats
    const actualStats = computeFieldStats(actualLineups, 'mlb');
    const synthStats = computeFieldStats(synthLineups, 'mlb');

    const ownR = ownershipRMSE(synthStats.playerOwnership, actualStats.playerOwnership);
    const c3R = combo3RMSE(synthStats.combo3Freq, actualStats.combo3Freq);
    const stackGap = Math.abs(synthStats.stackRate - actualStats.stackRate);
    const bbGap = Math.abs(synthStats.bringBackRate - actualStats.bringBackRate);

    console.log(`  ownership RMSE: ${(ownR * 100).toFixed(2)}pp  (target: <3pp)`);
    console.log(`  combo-3 RMSE: ${c3R.toFixed(4)}  (target: <0.02)`);
    console.log(`  stack: synth=${pct(synthStats.stackRate)} actual=${pct(actualStats.stackRate)} gap=${pct(stackGap)}`);
    console.log(`  bring-back: synth=${pct(synthStats.bringBackRate)} actual=${pct(actualStats.bringBackRate)} gap=${pct(bbGap)}`);
    console.log(`  centroid: synth=(${synthStats.centroidProj.toFixed(1)}, ${pct(synthStats.centroidOwn)}) actual=(${actualStats.centroidProj.toFixed(1)}, ${pct(actualStats.centroidOwn)})`);

    sumOwnRMSE += ownR; sumCombo3RMSE += c3R; sumStackGap += stackGap; sumBBGap += bbGap; n++;

    md += `| ${s.slate} | ${actuals.entries.length.toLocaleString()} | ${(ownR*100).toFixed(2)}pp | ${c3R.toFixed(4)} | ${pct(synthStats.stackRate)} | ${pct(actualStats.stackRate)} | ${pct(stackGap)} | ${pct(synthStats.bringBackRate)} | ${pct(actualStats.bringBackRate)} | ${pct(bbGap)} | (${synthStats.centroidProj.toFixed(0)}, ${pct(synthStats.centroidOwn)}) | (${actualStats.centroidProj.toFixed(0)}, ${pct(actualStats.centroidOwn)}) |\n`;
  }

  md += `| **MEAN** | | **${(sumOwnRMSE/n*100).toFixed(2)}pp** | **${(sumCombo3RMSE/n).toFixed(4)}** | | | **${pct(sumStackGap/n)}** | | | **${pct(sumBBGap/n)}** | | |\n\n`;

  // Verdict
  const passOwn = (sumOwnRMSE / n) < 0.03;
  const passCombo3 = (sumCombo3RMSE / n) < 0.02;
  const passStack = (sumStackGap / n) < 0.05;
  const passAll = passOwn && passCombo3 && passStack;

  md += `## Haugh-Singal Validation\n\n`;
  md += `| Criterion | Target | Result | Pass? |\n|---|---|---|:-:|\n`;
  md += `| Ownership RMSE | < 3.0pp | ${(sumOwnRMSE/n*100).toFixed(2)}pp | ${passOwn ? '✓' : '✗'} |\n`;
  md += `| 3-combo RMSE | < 0.02 | ${(sumCombo3RMSE/n).toFixed(4)} | ${passCombo3 ? '✓' : '✗'} |\n`;
  md += `| Stack rate gap | < 5.0pp | ${pct(sumStackGap/n)} | ${passStack ? '✓' : '✗'} |\n\n`;

  if (passAll) {
    md += `**All criteria pass.** Synthetic field is structurally similar to actual field within Haugh-Singal thresholds. The system is genuinely complete — Interpretation A is correct.\n`;
  } else {
    md += `**Criteria FAILED.** Synthetic field is structurally different from actual field.\n\n`;
    md += `**Interpretation B is correct:** Two miscalibrated components (opponent model + σ_{δ,G} weighting) are partially canceling. This is fragile.\n\n`;
    md += `**Action:** Calibrate BOTH the opponent model AND reduce the σ_{δ,G} multiplier together. Each alone makes V32 worse; both together should improve it.\n`;
    if (!passOwn) md += `- Ownership: synthetic misestimates individual player exposure by ${(sumOwnRMSE/n*100).toFixed(1)}pp avg\n`;
    if (!passCombo3) md += `- Combos: synthetic under-models lineup clustering (RMSE ${(sumCombo3RMSE/n).toFixed(4)} vs target 0.02)\n`;
    if (!passStack) md += `- Stacking: synthetic underestimates stack rate by ${pct(sumStackGap/n)} avg\n`;
  }

  const outPath = path.join(DATA_DIR, 'field_structural_comparison.md');
  fs.writeFileSync(outPath, md);
  console.log(`\n✓ Report: ${outPath}`);
}

main();
