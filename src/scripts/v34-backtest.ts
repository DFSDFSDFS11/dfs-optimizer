/**
 * V34 Backtest — ceiling × construction-duplication with payout + maxer benchmark.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import {
  parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV,
  ContestActuals, ContestEntry,
} from '../parser';
import { getContestConfig } from '../rules';
import {
  DEFAULT_SELECTOR_PARAMS, SelectorParams, defaultGamma, getSportDefaults,
  precomputeSlate, SlatePrecomputation,
} from '../selection/algorithm7-selector';
import { v34Select, computeLineupCeiling, extractSig } from '../selection/v34-selector';
import { generateBlendedField } from '../opponent/field-generator';

const DATA_DIR = 'C:/Users/colin/dfs opto';
const ENTRY_FEE = 20;
const SLATES = [
  { slate: '4-6-26', proj: '4-6-26_projections.csv', actuals: 'dkactuals 4-6-26.csv', pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26', proj: '4-8-26projections.csv', actuals: '4-8-26actuals.csv', pool: '4-8-26sspool.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv', actuals: '4-12-26actuals.csv', pool: '4-12-26sspool.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv', actuals: '4-14-26actuals.csv', pool: '4-14-26sspool.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv', actuals: '4-15-26actuals.csv', pool: '4-15-26sspool.csv' },
  { slate: '4-17-26', proj: '4-17-26projections.csv', actuals: '4-17-26actuals.csv', pool: '4-17-26sspool.csv' },
  { slate: '4-18-26', proj: '4-18-26projections.csv', actuals: '4-18-26actuals.csv', pool: '4-18-26sspool.csv' },
];

function norm(n: string): string { return (n||'').toLowerCase().replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim(); }
function extractUser(e: string): string { return (e||'').replace(/\s*\([^)]*\)\s*$/,'').trim(); }

function buildPayoutTable(totalEntries: number, fee: number): Float64Array {
  const pool = totalEntries * fee * 0.88;
  const cashLine = Math.floor(totalEntries * 0.22);
  const raw = new Float64Array(cashLine);
  let rawSum = 0;
  for (let r = 0; r < cashLine; r++) { raw[r] = Math.pow(r + 1, -1.15); rawSum += raw[r]; }
  const table = new Float64Array(totalEntries);
  const minCash = fee * 1.2;
  for (let r = 0; r < cashLine; r++) table[r] = Math.max(minCash, (raw[r] / rawSum) * pool);
  let tSum = 0; for (let r = 0; r < cashLine; r++) tSum += table[r];
  const scale = pool / tSum;
  for (let r = 0; r < cashLine; r++) table[r] *= scale;
  return table;
}

function scorePortfolio(portfolio: Lineup[], actuals: ContestActuals, actualByHash: Map<string, number>, payoutTable: Float64Array) {
  const F = actuals.entries.length;
  const sorted = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
  const top1T = sorted[Math.max(0, Math.floor(F * 0.01) - 1)] || 0;
  let t1 = 0, scored = 0, totalPayout = 0, sumCeiling = 0;
  const hitRanks: number[] = [];

  for (const lu of portfolio) {
    const fa = actualByHash.get(lu.hash);
    let a: number | null = fa !== undefined ? fa : null;
    if (a === null) { let t = 0, miss = false; for (const p of lu.players) { const r = actuals.playerActualsByName.get(norm(p.name)); if (!r) { miss = true; break; } t += r.fpts; } if (!miss) a = t; }
    if (a === null) continue;
    scored++;
    sumCeiling += computeLineupCeiling(lu);

    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (sorted[mid] >= a) lo = mid + 1; else hi = mid; }
    const rank = Math.max(1, lo);

    if (a >= top1T) { t1++; hitRanks.push(rank); }
    const payout = rank <= payoutTable.length ? payoutTable[rank - 1] : 0;
    if (payout > 0) {
      let coWin = 0;
      for (const e of actuals.entries) if (Math.abs(e.actualPoints - a) <= 0.25) coWin++;
      coWin = Math.max(0, coWin - 1);
      totalPayout += payout / Math.sqrt(1 + coWin * 0.5);
    }
  }

  const stackTeams = new Set<string>();
  let sOwn = 0;
  for (const lu of portfolio) {
    sOwn += lu.players.reduce((s: number, p: Player) => s + (p.ownership || 0), 0) / lu.players.length;
    const tc = new Map<string, number>(); for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
    for (const [t, c] of tc) if (c >= 4) stackTeams.add(t);
  }

  // Construction diversity (unique signatures)
  const sigs = new Set(portfolio.map(lu => { const s = extractSig(lu); return `${s.stackTeam}|${s.pitcher1}|${s.pitcher2}`; }));

  return {
    t1, scored, totalPayout,
    avgCeiling: scored > 0 ? sumCeiling / scored : 0,
    avgOwn: portfolio.length > 0 ? sOwn / portfolio.length : 0,
    stacks: stackTeams.size,
    uniqueConstructions: sigs.size,
    medianHitRank: hitRanks.length > 0 ? hitRanks.sort((a, b) => a - b)[Math.floor(hitRanks.length / 2)] : 0,
  };
}

function profileMaxers(actuals: ContestActuals, nameMap: Map<string, Player>) {
  const byUser = new Map<string, ContestEntry[]>();
  for (const e of actuals.entries) { const u = extractUser(e.entryName); if (u) { const a = byUser.get(u); if (a) a.push(e); else byUser.set(u, [e]); } }
  const maxers = [...byUser.entries()].filter(([, es]) => es.length >= 140);
  if (maxers.length === 0) return null;

  let sumCeiling = 0, sumOwn = 0, count = 0;
  const teamExp = new Map<string, number>();
  const sigs = new Set<string>();

  for (const [, entries] of maxers) {
    for (const e of entries) {
      const pls: Player[] = []; let ok = true;
      for (const n of e.playerNames) { const p = nameMap.get(norm(n)); if (!p) { ok = false; break; } pls.push(p); }
      if (!ok) continue;
      const lu: Lineup = { players: pls, salary: 0, projection: pls.reduce((s, p) => s + p.projection, 0), ownership: pls.reduce((s, p) => s + (p.ownership || 0), 0) / pls.length, hash: '' };
      sumCeiling += computeLineupCeiling(lu);
      sumOwn += lu.ownership;
      count++;
      const tc = new Map<string, number>(); for (const p of pls) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
      for (const [t, c] of tc) if (c >= 4) teamExp.set(t, (teamExp.get(t) || 0) + 1);
      const sig = extractSig(lu); sigs.add(`${sig.stackTeam}|${sig.pitcher1}|${sig.pitcher2}`);
    }
  }

  return {
    numMaxers: maxers.length,
    totalEntries: count,
    avgCeiling: count > 0 ? sumCeiling / count : 0,
    avgOwn: count > 0 ? sumOwn / count : 0,
    uniqueConstructions: sigs.size,
    teamExposures: teamExp,
  };
}

async function main() {
  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
  let md = `# V34 Backtest — Ceiling × Construction-Duplication (7 slates)\n\n`;
  md += `| Slate | Entries | V34 t1 | V34 pay | V34 ceil | V34 own | V34 stacks | V34 uniqConst | Maxer ceil | Maxer own | MedHitRank |\n`;
  md += `|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n`;

  let totalPay = 0, totalT1 = 0, n = 0;

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

    const F = actuals.entries.length;
    const payoutTable = buildPayoutTable(F, ENTRY_FEE);

    const fieldLineups: Lineup[] = []; const seenH = new Set<string>(); const actualByHash = new Map<string, number>();
    for (const e of actuals.entries) { const pls: Player[] = []; let ok = true;
      for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
      if (!ok) continue; const hash = pls.map(p => p.id).sort().join('|');
      if (seenH.has(hash)) continue; seenH.add(hash);
      fieldLineups.push({ players: pls, salary: pls.reduce((sm, p) => sm + p.salary, 0), projection: pls.reduce((sm, p) => sm + p.projection, 0), ownership: pls.reduce((sm, p) => sm + (p.ownership || 0), 0) / pls.length, hash });
      actualByHash.set(hash, e.actualPoints);
    }

    const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
    const blendedField = generateBlendedField(loaded.lineups, pool.players, config, Math.min(8000, F), 0.20);
    const selParams: SelectorParams = { ...DEFAULT_SELECTOR_PARAMS, ...getSportDefaults('mlb'), N: 150, gamma: defaultGamma(config.rosterSize), numWorlds: 1500 };

    console.log(`  precompute…`);
    const precomp = precomputeSlate(loaded.lineups, blendedField, pool.players, selParams, 'mlb');

    console.log(`  V34 select…`);
    const maxPerTeam = Math.floor(150 * 0.25);
    const v34Portfolio = v34Select(precomp, blendedField, 150, 0.40, maxPerTeam);
    const v34Result = scorePortfolio(v34Portfolio, actuals, actualByHash, payoutTable);

    // Maxer profile
    const maxerProfile = profileMaxers(actuals, nameMap);

    console.log(`  V34: t1=${v34Result.t1} pay=$${v34Result.totalPayout.toFixed(0)} ceil=${v34Result.avgCeiling.toFixed(0)} own=${v34Result.avgOwn.toFixed(1)}% stacks=${v34Result.stacks} uniqConst=${v34Result.uniqueConstructions} medRank=${v34Result.medianHitRank}`);

    totalPay += v34Result.totalPayout; totalT1 += v34Result.t1; n++;
    md += `| ${s.slate} | ${F.toLocaleString()} | ${v34Result.t1} (${pct(v34Result.scored>0?v34Result.t1/v34Result.scored:0)}) | $${v34Result.totalPayout.toFixed(0)} | ${v34Result.avgCeiling.toFixed(0)} | ${v34Result.avgOwn.toFixed(1)}% | ${v34Result.stacks} | ${v34Result.uniqueConstructions} | ${maxerProfile?.avgCeiling.toFixed(0) || '?'} | ${maxerProfile?.avgOwn.toFixed(1) || '?'}% | ${v34Result.medianHitRank} |\n`;
  }

  const totalFees = ENTRY_FEE * 150 * n;
  md += `| **TOTAL** | | **${totalT1}** | **$${totalPay.toFixed(0)}** | | | | | | | |\n\n`;
  md += `Entry fees: $${totalFees.toLocaleString()}\n`;
  md += `**V34 ROI: ${((totalPay / totalFees - 1) * 100).toFixed(1)}%**\n\n`;
  md += `V32 baseline: $19,014 total payout, −9.5% ROI\n`;
  md += `V33d baseline: $5,342 total payout, −74.6% ROI\n`;

  fs.writeFileSync(path.join(DATA_DIR, 'v34_backtest.md'), md);
  console.log(`\n✓ Report: ${path.join(DATA_DIR, 'v34_backtest.md')}`);
}

main();
