/**
 * Parimutuel EV Backtest — the unified formula vs V32 on 7 slates.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals } from '../parser';
import { getContestConfig } from '../rules';
import { DEFAULT_SELECTOR_PARAMS, SelectorParams, defaultGamma, getSportDefaults, precomputeSlate } from '../selection/algorithm7-selector';
import { buildParimutuelPrecomp, parimutuelGreedySelect } from '../selection/parimutuel-ev';
import { generateBlendedField } from '../opponent/field-generator';

const DIR = 'C:/Users/colin/dfs opto';
const FEE = 20;
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

function buildPayoutTable(F: number): Float64Array {
  const pool = F * FEE * 0.88; const cashLine = Math.floor(F * 0.22);
  const raw = new Float64Array(cashLine); let rawSum = 0;
  for (let r = 0; r < cashLine; r++) { raw[r] = Math.pow(r + 1, -1.15); rawSum += raw[r]; }
  const table = new Float64Array(F); const minCash = FEE * 1.2;
  for (let r = 0; r < cashLine; r++) table[r] = Math.max(minCash, (raw[r] / rawSum) * pool);
  let tSum = 0; for (let r = 0; r < cashLine; r++) tSum += table[r];
  const scale = pool / tSum; for (let r = 0; r < cashLine; r++) table[r] *= scale;
  return table;
}

function scorePortfolio(portfolio: Lineup[], actuals: ContestActuals, actualByHash: Map<string, number>, payoutTable: Float64Array) {
  const F = actuals.entries.length;
  const sorted = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
  const top1T = sorted[Math.max(0, Math.floor(F * 0.01) - 1)] || 0;
  let t1 = 0, scored = 0, totalPayout = 0;
  for (const lu of portfolio) {
    const fa = actualByHash.get(lu.hash); let a: number | null = fa !== undefined ? fa : null;
    if (a === null) { let t = 0, miss = false; for (const p of lu.players) { const r = actuals.playerActualsByName.get(norm(p.name)); if (!r) { miss = true; break; } t += r.fpts; } if (!miss) a = t; }
    if (a === null) continue; scored++;
    let lo = 0, hi = sorted.length; while (lo < hi) { const mid = (lo + hi) >>> 1; if (sorted[mid] >= a) lo = mid + 1; else hi = mid; }
    const rank = Math.max(1, lo);
    if (a >= top1T) t1++;
    const payout = rank <= payoutTable.length ? payoutTable[rank - 1] : 0;
    if (payout > 0) { let coWin = 0; for (const e of actuals.entries) if (Math.abs(e.actualPoints - a) <= 0.25) coWin++; coWin = Math.max(0, coWin - 1); totalPayout += payout / Math.sqrt(1 + coWin * 0.5); }
  }
  const stackTeams = new Set<string>();
  let sOwn = 0, sProj = 0;
  for (const lu of portfolio) { sOwn += lu.players.reduce((s: number, p: Player) => s + (p.ownership || 0), 0) / lu.players.length; sProj += lu.projection; const tc = new Map<string, number>(); for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1); for (const [t, c] of tc) if (c >= 4) stackTeams.add(t); }
  return { t1, scored, totalPayout, stacks: stackTeams.size, avgOwn: portfolio.length > 0 ? sOwn / portfolio.length : 0, avgProj: portfolio.length > 0 ? sProj / portfolio.length : 0 };
}

async function main() {
  const pct = (v: number) => `${(v*100).toFixed(2)}%`;
  let md = `# Parimutuel EV Backtest — Unified Formula (7 slates)\n\n`;
  md += `ΔEV(c|P) = Σ_w [hit(c,w) × prize(rank) / (1 + field_co_hits(w) + portfolio_hits(w))]\n\n`;
  md += `| Slate | F | pEV t1 | pEV pay | pEV stacks | pEV own | pEV proj |\n`;
  md += `|---|---:|---:|---:|---:|---:|---:|\n`;

  let totalPay = 0, totalT1 = 0, n = 0;

  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj), actualsPath = path.join(DIR, s.actuals), poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) continue;
    console.log(`\n=== ${s.slate} ===`);
    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);
    const nameMap = new Map<string, Player>(); for (const p of pool.players) nameMap.set(norm(p.name), p);
    const idMap = new Map<string, Player>(); for (const p of pool.players) idMap.set(p.id, p);
    const F = actuals.entries.length; const payoutTable = buildPayoutTable(F);
    const fieldLineups: Lineup[] = []; const seenH = new Set<string>(); const actualByHash = new Map<string, number>();
    for (const e of actuals.entries) { const pls: Player[] = []; let ok = true; for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); } if (!ok) continue; const hash = pls.map(p => p.id).sort().join('|'); if (seenH.has(hash)) continue; seenH.add(hash); fieldLineups.push({ players: pls, salary: pls.reduce((sm, p) => sm + p.salary, 0), projection: pls.reduce((sm, p) => sm + p.projection, 0), ownership: pls.reduce((sm, p) => sm + (p.ownership || 0), 0) / pls.length, hash }); actualByHash.set(hash, e.actualPoints); }
    const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
    const blendedField = generateBlendedField(loaded.lineups, pool.players, config, Math.min(8000, F), 0.20);
    const selParams: SelectorParams = { ...DEFAULT_SELECTOR_PARAMS, ...getSportDefaults('mlb'), N: 150, gamma: defaultGamma(config.rosterSize), numWorlds: 2000 };

    console.log(`  precompute…`);
    const precomp = precomputeSlate(loaded.lineups, blendedField, pool.players, selParams, 'mlb');

    console.log(`  building parimutuel precomp…`);
    const ppc = buildParimutuelPrecomp(precomp, blendedField, F, FEE);

    console.log(`  parimutuel greedy select…`);
    const maxPerTeam = Math.floor(150 * 0.25);
    const portfolio = parimutuelGreedySelect(precomp, ppc, 150, 0.40, maxPerTeam, F, FEE);

    const result = scorePortfolio(portfolio, actuals, actualByHash, payoutTable);
    console.log(`  pEV: t1=${result.t1} pay=$${result.totalPayout.toFixed(0)} stacks=${result.stacks} own=${result.avgOwn.toFixed(1)}% proj=${result.avgProj.toFixed(1)}`);

    totalPay += result.totalPayout; totalT1 += result.t1; n++;
    md += `| ${s.slate} | ${F.toLocaleString()} | ${result.t1} (${pct(result.scored>0?result.t1/result.scored:0)}) | $${result.totalPayout.toFixed(0)} | ${result.stacks} | ${result.avgOwn.toFixed(1)}% | ${result.avgProj.toFixed(1)} |\n`;
  }

  const totalFees = FEE * 150 * n;
  md += `| **TOTAL** | | **${totalT1}** | **$${totalPay.toFixed(0)}** | | | |\n\n`;
  md += `**Parimutuel EV ROI: ${((totalPay/totalFees-1)*100).toFixed(1)}%**\n\n`;
  md += `Baselines:\n`;
  md += `- V32 regions: $19,014 total, −9.5% ROI\n`;
  md += `- Scenario-weighted: $6,522 total, −68.9% ROI\n`;

  fs.writeFileSync(path.join(DIR, 'parimutuel_backtest.md'), md);
  console.log(`\n✓ Report: ${path.join(DIR, 'parimutuel_backtest.md')}`);
}
main();
