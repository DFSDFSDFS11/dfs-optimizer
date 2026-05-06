/**
 * Analysis 6 — Field-counter positioning (player-level alpha decisions).
 *
 * For each (player, slate):
 *   - Field ownership = ownership column from projections (predicted)
 *   - Pro exposure = % of pro lineups using that player (across 7 pros, ~1050 lineups/slate)
 *   - Hermes exposure = % of Hermes-A lineups using that player
 *
 * Compute "field-counter delta" per player:
 *   - pro_exposure - field_ownership = how much pros over/under-weight player vs field
 *
 * Aggregate across slates:
 *   - Players pros consistently OVER-weight (pro_exp >> field_own) — embraces
 *   - Players pros consistently UNDER-weight (pro_exp << field_own) — fades
 *   - Does Hermes-A replicate these patterns?
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import {
  parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals,
} from '../parser';
import { getContestConfig } from '../rules';
import { productionSelect } from '../selection/production-selector';
import { precomputeComboFrequencies } from '../selection/combo-leverage';

const DIR = 'C:/Users/colin/dfs opto';
const N = 150;

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
  { slate: '4-26-26', proj: '4-26-26projections.csv', actuals: '4-26-26actuals.csv',   pool: '4-26-26sspool.csv' },
  { slate: '4-27-26', proj: '4-27-26projections.csv', actuals: '4-27-26actuals.csv',   pool: '4-27-26sspool.csv' },
  { slate: '4-28-26', proj: '4-28-26projections.csv', actuals: '4-28-26actuals.csv',   pool: '4-28-26sspool.csv' },
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

const HERMES_A = {
  lambda: 0.58, gamma: 5, tc: 0.26, mps: 4, me: 0.21, mep: 0.41, corner: true,
  comboPower: 4, fl: 0.00,
  bins: { chalk: 0.50, core: 0.30, value: 0.20, contra: 0.00, deep: 0.00 },
};

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function mean(a: number[]): number { if (!a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; }

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

interface PlayerSlateRow {
  slate: string; playerName: string; team: string; position: string;
  projection: number; ownership: number;
  proExposure: number; hermesExposure: number;
  proFieldDelta: number; hermesFieldDelta: number;
  proHermesDelta: number;
}

async function main() {
  console.log('=== ANALYSIS 6: Field-counter positioning ===\n');

  const allRows: PlayerSlateRow[] = [];

  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj), actualsPath = path.join(DIR, s.actuals), poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) continue;
    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);
    const idMap = new Map<string, Player>(); const nameMap = new Map<string, Player>();
    for (const p of pool.players) { idMap.set(p.id, p); nameMap.set(norm(p.name), p); }
    const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });

    // Pool all pro lineups for this slate
    const allProLineups: Player[][] = [];
    for (const p of PROS) allProLineups.push(...extractPro(actuals, nameMap, p.tokens));
    if (allProLineups.length < 100) continue;

    // Pro exposure per player
    const proCounts = new Map<string, number>();
    for (const lu of allProLineups) for (const p of lu) proCounts.set(p.id, (proCounts.get(p.id) || 0) + 1);
    const proTotal = allProLineups.length;

    // Hermes exposure
    const comboFreq = precomputeComboFrequencies(loaded.lineups, HERMES_A.comboPower);
    const result = productionSelect(loaded.lineups, pool.players, {
      N, lambda: HERMES_A.lambda, comboFreq, maxOverlap: HERMES_A.gamma,
      teamCapPct: HERMES_A.tc, minPrimaryStack: HERMES_A.mps,
      maxExposure: HERMES_A.me, maxExposurePitcher: HERMES_A.mep,
      extremeCornerCap: HERMES_A.corner, projectionFloorPct: HERMES_A.fl,
      binAllocation: HERMES_A.bins,
    });
    const hCounts = new Map<string, number>();
    for (const lu of result.portfolio) for (const p of lu.players) hCounts.set(p.id, (hCounts.get(p.id) || 0) + 1);
    const hTotal = result.portfolio.length;

    for (const p of pool.players) {
      const proExp = (proCounts.get(p.id) || 0) / proTotal * 100;
      const hExp = (hCounts.get(p.id) || 0) / hTotal * 100;
      const fieldOwn = p.ownership || 0;
      allRows.push({
        slate: s.slate, playerName: p.name, team: p.team, position: p.positions?.[0] || '',
        projection: p.projection || 0, ownership: fieldOwn,
        proExposure: proExp, hermesExposure: hExp,
        proFieldDelta: proExp - fieldOwn, hermesFieldDelta: hExp - fieldOwn,
        proHermesDelta: proExp - hExp,
      });
    }
  }

  // Aggregate by player NAME across slates (only players who appear ≥3 times)
  const byName = new Map<string, PlayerSlateRow[]>();
  for (const r of allRows) {
    if (!byName.has(r.playerName)) byName.set(r.playerName, []);
    byName.get(r.playerName)!.push(r);
  }
  const playerAggs: Array<{ name: string; nSlates: number; avgProj: number; avgFieldOwn: number; avgProExp: number; avgHermesExp: number; avgProFieldDelta: number; avgHermesFieldDelta: number; avgProHermesDelta: number }> = [];
  for (const [name, rows] of byName) {
    if (rows.length < 3) continue;
    playerAggs.push({
      name, nSlates: rows.length,
      avgProj: mean(rows.map(r => r.projection)),
      avgFieldOwn: mean(rows.map(r => r.ownership)),
      avgProExp: mean(rows.map(r => r.proExposure)),
      avgHermesExp: mean(rows.map(r => r.hermesExposure)),
      avgProFieldDelta: mean(rows.map(r => r.proFieldDelta)),
      avgHermesFieldDelta: mean(rows.map(r => r.hermesFieldDelta)),
      avgProHermesDelta: mean(rows.map(r => r.proHermesDelta)),
    });
  }

  // Top 20 players pros over-weight vs field (avgProFieldDelta > 0)
  console.log('=== TOP 20 PLAYERS PROS EMBRACE (proExp > fieldOwn) ===\n');
  console.log('player                       slates  proj   fieldOwn  proExp  hermesExp | proΔ    hermesΔ   pro-her');
  const embraces = playerAggs.filter(p => p.avgFieldOwn >= 5).sort((a, b) => b.avgProFieldDelta - a.avgProFieldDelta).slice(0, 20);
  for (const p of embraces) {
    console.log('  ' + p.name.padEnd(28) + ' ' + p.nSlates.toString().padStart(4) + '  ' + p.avgProj.toFixed(1).padStart(5) + '  ' + p.avgFieldOwn.toFixed(1).padStart(7) + '%  ' + p.avgProExp.toFixed(1).padStart(5) + '%  ' + p.avgHermesExp.toFixed(1).padStart(6) + '%   |  +' + p.avgProFieldDelta.toFixed(1).padStart(4) + '   ' + (p.avgHermesFieldDelta > 0 ? '+' : '') + p.avgHermesFieldDelta.toFixed(1).padStart(4) + '   ' + p.avgProHermesDelta.toFixed(1).padStart(4));
  }

  // Top 20 players pros fade vs field (avgProFieldDelta < 0)
  console.log('\n=== TOP 20 PLAYERS PROS FADE (proExp < fieldOwn) ===\n');
  console.log('player                       slates  proj   fieldOwn  proExp  hermesExp | proΔ    hermesΔ   pro-her');
  const fades = playerAggs.filter(p => p.avgFieldOwn >= 10).sort((a, b) => a.avgProFieldDelta - b.avgProFieldDelta).slice(0, 20);
  for (const p of fades) {
    console.log('  ' + p.name.padEnd(28) + ' ' + p.nSlates.toString().padStart(4) + '  ' + p.avgProj.toFixed(1).padStart(5) + '  ' + p.avgFieldOwn.toFixed(1).padStart(7) + '%  ' + p.avgProExp.toFixed(1).padStart(5) + '%  ' + p.avgHermesExp.toFixed(1).padStart(6) + '%   |  ' + p.avgProFieldDelta.toFixed(1).padStart(4) + '   ' + (p.avgHermesFieldDelta > 0 ? '+' : '') + p.avgHermesFieldDelta.toFixed(1).padStart(4) + '   ' + p.avgProHermesDelta.toFixed(1).padStart(4));
  }

  // Players where Hermes diverges from pros most (high |proHermesDelta|)
  console.log('\n=== TOP 20 PLAYERS WHERE HERMES DIVERGES FROM PROS ===\n');
  console.log('player                       slates  proj   fieldOwn  proExp  hermesExp | pro-her gap');
  const diverges = playerAggs.filter(p => p.nSlates >= 4 && p.avgFieldOwn >= 5).sort((a, b) => Math.abs(b.avgProHermesDelta) - Math.abs(a.avgProHermesDelta)).slice(0, 20);
  for (const p of diverges) {
    const dir = p.avgProHermesDelta > 0 ? 'HERMES UNDER' : 'HERMES OVER';
    console.log('  ' + p.name.padEnd(28) + ' ' + p.nSlates.toString().padStart(4) + '  ' + p.avgProj.toFixed(1).padStart(5) + '  ' + p.avgFieldOwn.toFixed(1).padStart(7) + '%  ' + p.avgProExp.toFixed(1).padStart(5) + '%  ' + p.avgHermesExp.toFixed(1).padStart(6) + '%   ' + (p.avgProHermesDelta > 0 ? '+' : '') + p.avgProHermesDelta.toFixed(1).padStart(5) + 'pp  ' + dir);
  }

  // Aggregate quintiles
  console.log('\n=== FIELD-OWNERSHIP QUINTILE: pro & Hermes lift over field ===\n');
  const all = allRows.filter(r => r.ownership > 0);
  const owns = all.map(r => r.ownership).sort((a, b) => a - b);
  const qts = [0.2, 0.4, 0.6, 0.8].map(q => owns[Math.floor(owns.length * q)]);
  const buckets = [
    { label: 'Q1 (lowest own)',  filter: (r: PlayerSlateRow) => r.ownership < qts[0] },
    { label: 'Q2',                filter: (r: PlayerSlateRow) => r.ownership >= qts[0] && r.ownership < qts[1] },
    { label: 'Q3',                filter: (r: PlayerSlateRow) => r.ownership >= qts[1] && r.ownership < qts[2] },
    { label: 'Q4',                filter: (r: PlayerSlateRow) => r.ownership >= qts[2] && r.ownership < qts[3] },
    { label: 'Q5 (highest own)',  filter: (r: PlayerSlateRow) => r.ownership >= qts[3] },
  ];
  console.log('quintile         | n      avgFieldOwn  avgProExp  avgHermesExp  pro-field  hermes-field  pro-hermes');
  for (const b of buckets) {
    const sub = all.filter(b.filter);
    if (sub.length === 0) continue;
    const af = mean(sub.map(r => r.ownership));
    const ap = mean(sub.map(r => r.proExposure));
    const ah = mean(sub.map(r => r.hermesExposure));
    console.log('  ' + b.label.padEnd(16) + ' | ' + sub.length.toString().padStart(5) + '  ' + af.toFixed(2).padStart(11) + '%  ' + ap.toFixed(2).padStart(8) + '%  ' + ah.toFixed(2).padStart(11) + '%  ' + (ap - af > 0 ? '+' : '') + (ap - af).toFixed(2).padStart(7) + '   ' + (ah - af > 0 ? '+' : '') + (ah - af).toFixed(2).padStart(8) + '   ' + (ap - ah > 0 ? '+' : '') + (ap - ah).toFixed(2).padStart(6));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
