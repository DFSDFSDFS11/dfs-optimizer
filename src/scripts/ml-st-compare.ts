/**
 * Stage 7: Set Transformer vs Hermes-A on held-out slates.
 * Reads st_portfolios.json (built by Python pipeline). Computes ROI + Mahalanobis vs Hermes-A.
 */
import * as fs from 'fs'; import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals } from '../parser';
import { getContestConfig } from '../rules';
import { productionSelect } from '../selection/production-selector';
import { precomputeComboFrequencies } from '../selection/combo-leverage';

const DIR = 'C:/Users/colin/dfs opto';
const ML_DIR = 'C:/Users/colin/Projects/dfs-optimizer/ml_set_transformer';
const N = 150; const FEE = 20;
const QUANTILES = [0.10, 0.25, 0.50, 0.75, 0.90];
const METRICS = ['lineupOwn', 'lineupProjRatio', 'lineupCeilRatio', 'lineupOwnStd', 'lineupOwnPctile'] as const;

const HELD_OUT_SLATES = [
  { slate: '4-8-26',  proj: '4-8-26projections.csv',  actuals: '4-8-26actuals.csv',    pool: '4-8-26sspool.csv' },
  { slate: '4-21-26', proj: '4-21-26projections.csv', actuals: '4-21-26actuals.csv',   pool: '4-21-26sspool.csv' },
  { slate: '4-19-26', proj: '4-19-26projections.csv', actuals: '4-19-26actuals.csv',   pool: '4-19-26sspool.csv' },
  { slate: '4-24-26', proj: '4-24-26projections.csv', actuals: '4-24-26actuals.csv',   pool: '4-24-26sspool.csv' },
];
const HERMES_A = {
  lambda: 0.58, gamma: 5, tc: 0.26, mps: 4, me: 0.21, mep: 0.41, corner: true,
  comboPower: 4, fl: 0.00, bins: { chalk: 0.50, core: 0.30, value: 0.20, contra: 0.00, deep: 0.00 },
};

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function mean(a: number[]): number { if (!a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; }
function stddev(a: number[]): number { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); }
function quantilesOf(arr: number[], qs: number[]): number[] {
  const sorted = [...arr].sort((a, b) => a - b);
  return qs.map(q => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]);
}
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
function payoutFor(actual: number, sorted: number[], pt: Float64Array, actuals: ContestActuals): number {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (sorted[m] >= actual) lo = m + 1; else hi = m; }
  const rank = Math.max(1, lo); const pay = rank <= pt.length ? pt[rank - 1] : 0;
  if (pay <= 0) return 0;
  let co = 0; for (const e of actuals.entries) if (Math.abs(e.actualPoints - actual) <= 0.25) co++;
  co = Math.max(0, co - 1);
  return pay / Math.sqrt(1 + co * 0.5);
}
function ksDist(a: number[], b: number[]): number {
  const sa = [...a].sort((x, y) => x - y); const sb = [...b].sort((x, y) => x - y);
  let mx = 0, ai = 0, bi = 0;
  while (ai < sa.length && bi < sb.length) {
    const ca = (ai + 1) / sa.length, cb = (bi + 1) / sb.length;
    if (Math.abs(ca - cb) > mx) mx = Math.abs(ca - cb);
    if (sa[ai] < sb[bi]) ai++; else if (sa[ai] > sb[bi]) bi++; else { ai++; bi++; }
  }
  return mx;
}
function computeQuantiles(lineups: Player[][], ctx: any): Record<string, number[]> {
  const own: number[] = [], proj: number[] = [], ceil: number[] = [], ownStd: number[] = [], pctile: number[] = [];
  for (const players of lineups) {
    const owns = players.map(p => p.ownership || 0);
    own.push(mean(owns));
    proj.push(ctx.optProj > 0 ? players.reduce((s, p) => s + (p.projection || 0), 0) / ctx.optProj : 0);
    ceil.push(ctx.optCeil > 0 ? players.reduce((s, p) => s + ((p as any).ceiling || (p.projection || 0) * 1.4), 0) / ctx.optCeil : 0);
    ownStd.push(ctx.slateAvgOwn > 0 ? stddev(owns) / ctx.slateAvgOwn : 0);
    let ps = 0; for (const p of players) ps += ctx.ownPctile.get(p.id) || 0;
    pctile.push(ps / players.length);
  }
  return {
    lineupOwn: quantilesOf(own, QUANTILES),
    lineupProjRatio: quantilesOf(proj, QUANTILES),
    lineupCeilRatio: quantilesOf(ceil, QUANTILES),
    lineupOwnStd: quantilesOf(ownStd, QUANTILES),
    lineupOwnPctile: quantilesOf(pctile, QUANTILES),
  };
}
async function main() {
  const REPORT: string[] = [];
  const log = (m: string = '') => { console.log(m); REPORT.push(m); };
  log('# Stage 7: Set Transformer vs Hermes-A on held-out slates');
  log('');
  if (!fs.existsSync(path.join(ML_DIR, 'st_portfolios.json'))) { log('ERROR: st_portfolios.json missing.'); process.exit(1); }
  const stPort = JSON.parse(fs.readFileSync(path.join(ML_DIR, 'st_portfolios.json'), 'utf-8'));
  const cons = JSON.parse(fs.readFileSync(path.join(DIR, 'pro_consensus_quantile.json'), 'utf-8'));
  const consBySlate: Record<string, Record<string, { mean: number[]; std: number[] }>> = {};
  for (const m of METRICS) for (const sd of (cons.metrics[m] || [])) {
    if (!consBySlate[sd.slate]) consBySlate[sd.slate] = {};
    consBySlate[sd.slate][m] = { mean: sd.mean, std: sd.std };
  }
  const compResults: any[] = [];
  for (const s of HELD_OUT_SLATES) {
    const projPath = path.join(DIR, s.proj), actualsPath = path.join(DIR, s.actuals), poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) continue;
    log(`### ${s.slate}`); log('');
    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);
    const idMap = new Map<string, Player>(); const nameMap = new Map<string, Player>();
    for (const p of pool.players) { idMap.set(p.id, p); nameMap.set(norm(p.name), p); }
    const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
    const fieldLineups: Player[][] = [];
    for (const e of actuals.entries) {
      const pls: Player[] = []; let ok = true;
      for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
      if (ok) fieldLineups.push(pls);
    }
    let optProj = 0, optCeil = 0;
    for (const lu of fieldLineups) {
      let p = 0, c = 0;
      for (const pl of lu) { p += pl.projection || 0; c += (pl as any).ceiling || (pl.projection || 0) * 1.4; }
      if (p > optProj) optProj = p; if (c > optCeil) optCeil = c;
    }
    const slateAvgOwn = mean(pool.players.map(p => p.ownership || 0));
    const ownPctile = new Map<string, number>();
    const sortedByOwn = [...pool.players].sort((a, b) => (a.ownership || 0) - (b.ownership || 0));
    for (let i = 0; i < sortedByOwn.length; i++) ownPctile.set(sortedByOwn[i].id, sortedByOwn.length > 1 ? i / (sortedByOwn.length - 1) : 0);
    const ctx = { optProj, optCeil, slateAvgOwn, ownPctile };

    // ST portfolio
    const stHashes: string[] = stPort[s.slate] || [];
    const hashToLu = new Map<string, Lineup>();
    for (const lu of loaded.lineups) hashToLu.set(lu.hash, lu);
    const stLineups: Lineup[] = stHashes.map(h => hashToLu.get(h)).filter(Boolean) as Lineup[];
    log(`  ST portfolio size: ${stLineups.length}`);

    // Hermes-A
    const cf = precomputeComboFrequencies(loaded.lineups, HERMES_A.comboPower);
    const hr = productionSelect(loaded.lineups, pool.players, {
      N, lambda: HERMES_A.lambda, comboFreq: cf, maxOverlap: HERMES_A.gamma,
      teamCapPct: HERMES_A.tc, minPrimaryStack: HERMES_A.mps,
      maxExposure: HERMES_A.me, maxExposurePitcher: HERMES_A.mep,
      extremeCornerCap: HERMES_A.corner, projectionFloorPct: HERMES_A.fl,
      binAllocation: HERMES_A.bins,
    });
    const hLineups = hr.portfolio;
    log(`  Hermes-A size: ${hLineups.length}`);

    const stQ = computeQuantiles(stLineups.map(lu => lu.players), ctx);
    const hQ = computeQuantiles(hLineups.map(lu => lu.players), ctx);
    const cn = consBySlate[s.slate];
    const computeDist = (q: Record<string, number[]>): number => {
      let sumSq = 0, n = 0;
      for (const m of METRICS) {
        const c = cn?.[m]; if (!c) continue;
        for (let qi = 0; qi < 5; qi++) { if (c.std[qi] < 1e-9) continue;
          const z = (q[m][qi] - c.mean[qi]) / c.std[qi]; sumSq += z * z; n++; }
      }
      return n > 0 ? Math.sqrt(sumSq / n) : 0;
    };
    const stDist = computeDist(stQ); const hDist = computeDist(hQ);

    // KS distance vs pros
    const PROS = [['nerdytenor'], ['zroth', 'zroth2'], ['youdacao'], ['shipmymoney'], ['shaidyadvice'], ['bgreseth'], ['needlunchmoney']];
    const allPro: Player[][] = [];
    for (const tokens of PROS) {
      for (const e of actuals.entries) {
        const en = (e.entryName || '').toLowerCase();
        if (!tokens.some(t => en.includes(t))) continue;
        const pls: Player[] = []; let ok = true;
        for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
        if (ok) allPro.push(pls);
      }
    }
    function rawValues(lineups: Player[][]) {
      const own: number[] = [], proj: number[] = [], ceil: number[] = [], ownStd: number[] = [], pctile: number[] = [];
      for (const players of lineups) {
        const owns = players.map(p => p.ownership || 0);
        own.push(mean(owns));
        proj.push(ctx.optProj > 0 ? players.reduce((s, p) => s + (p.projection || 0), 0) / ctx.optProj : 0);
        ceil.push(ctx.optCeil > 0 ? players.reduce((s, p) => s + ((p as any).ceiling || (p.projection || 0) * 1.4), 0) / ctx.optCeil : 0);
        ownStd.push(ctx.slateAvgOwn > 0 ? stddev(owns) / ctx.slateAvgOwn : 0);
        let ps = 0; for (const p of players) ps += ctx.ownPctile.get(p.id) || 0;
        pctile.push(ps / players.length);
      }
      return { lineupOwn: own, lineupProjRatio: proj, lineupCeilRatio: ceil, lineupOwnStd: ownStd, lineupOwnPctile: pctile };
    }
    const proRaw = rawValues(allPro);
    const stRaw = rawValues(stLineups.map(lu => lu.players));
    const hRaw = rawValues(hLineups.map(lu => lu.players));
    const stKs = (
      ksDist(stRaw.lineupOwn, proRaw.lineupOwn) + ksDist(stRaw.lineupProjRatio, proRaw.lineupProjRatio) +
      ksDist(stRaw.lineupCeilRatio, proRaw.lineupCeilRatio) + ksDist(stRaw.lineupOwnStd, proRaw.lineupOwnStd) +
      ksDist(stRaw.lineupOwnPctile, proRaw.lineupOwnPctile)
    ) / 5;
    const hKs = (
      ksDist(hRaw.lineupOwn, proRaw.lineupOwn) + ksDist(hRaw.lineupProjRatio, proRaw.lineupProjRatio) +
      ksDist(hRaw.lineupCeilRatio, proRaw.lineupCeilRatio) + ksDist(hRaw.lineupOwnStd, proRaw.lineupOwnStd) +
      ksDist(hRaw.lineupOwnPctile, proRaw.lineupOwnPctile)
    ) / 5;

    // ROI scoring
    const F = actuals.entries.length;
    const sortedDesc = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
    const pt = buildPayoutTable(F);
    const ah = new Map<string, number>();
    for (const e of actuals.entries) {
      const pls: Player[] = []; let ok = true;
      for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
      if (!ok) continue;
      ah.set(pls.map(p => p.id).sort().join('|'), e.actualPoints);
    }
    function score(portfolio: Lineup[]): number {
      let total = 0;
      for (const lu of portfolio) {
        const h = lu.players.map(p => p.id).sort().join('|');
        let a = ah.get(h);
        if (a === undefined) {
          let t = 0; let ok = true;
          for (const p of lu.players) {
            const r = actuals.playerActualsByName.get(norm(p.name));
            if (!r) { ok = false; break; }
            t += r.fpts;
          }
          if (!ok) continue; a = t;
        }
        total += payoutFor(a, sortedDesc, pt, actuals);
      }
      return total;
    }
    const stPay = score(stLineups); const hPay = score(hLineups);
    const fee = N * FEE;
    const stROI = (stPay / fee - 1) * 100; const hROI = (hPay / fee - 1) * 100;

    log(''); log('| Metric | Set Transformer | Hermes-A | Winner |'); log('|---|---|---|---|');
    log(`| Mahalanobis | ${stDist.toFixed(2)} | ${hDist.toFixed(2)} | ${stDist < hDist ? 'ST' : 'Hermes-A'} |`);
    log(`| KS distance | ${stKs.toFixed(3)} | ${hKs.toFixed(3)} | ${stKs < hKs ? 'ST' : 'Hermes-A'} |`);
    log(`| ROI | ${stROI.toFixed(0)}% | ${hROI.toFixed(0)}% | ${stPay > hPay ? 'ST' : 'Hermes-A'} |`);
    log(`| Payout | $${stPay.toFixed(0)} | $${hPay.toFixed(0)} | |`); log('');
    compResults.push({ slate: s.slate, stDist, hDist, stKs, hKs, stPay, hPay, stROI, hROI });
  }

  log(''); log('## Stage 7 Aggregate'); log('');
  const stMW = compResults.filter(r => r.stDist < r.hDist).length;
  const stRW = compResults.filter(r => r.stROI > r.hROI).length;
  const tSt = compResults.reduce((s, r) => s + r.stPay, 0);
  const tH = compResults.reduce((s, r) => s + r.hPay, 0);
  const tF = compResults.length * N * FEE;
  log(`Held-out slates: ${compResults.length}`);
  log(`ST beats Hermes on Mahalanobis: ${stMW}/${compResults.length}`);
  log(`ST beats Hermes on ROI: ${stRW}/${compResults.length}`);
  log(`ST total: $${tSt.toFixed(0)} (ROI ${((tSt/tF-1)*100).toFixed(1)}%)`);
  log(`Hermes-A total: $${tH.toFixed(0)} (ROI ${((tH/tF-1)*100).toFixed(1)}%)`);
  log(`ST/Hermes payout ratio: ${(tSt/Math.max(1,tH)*100).toFixed(1)}%`);
  log('');
  log('## Stage 7 Gates'); log('');
  const gateMahal = stMW >= 3;
  const gatePay = tSt >= 0.8 * tH;
  log(`Gate (ST Mahalanobis better on ≥3 of 4): ${gateMahal ? 'PASS' : 'FAIL'} (${stMW}/4)`);
  log(`Gate (ST payout ≥ 80% of Hermes): ${gatePay ? 'PASS' : 'FAIL'} (${(tSt/Math.max(1,tH)*100).toFixed(1)}%)`);
  log('');
  fs.writeFileSync(path.join(ML_DIR, 'stage7_comparison.json'), JSON.stringify(compResults, null, 2));
  let existing = '';
  try { existing = fs.readFileSync(path.join(ML_DIR, 'report.md'), 'utf-8'); } catch {}
  fs.writeFileSync(path.join(ML_DIR, 'report.md'), existing + '\n\n---\n\n' + REPORT.join('\n'));
  console.log('\nStage 7 complete.');
}
main().catch(e => { console.error(e); process.exit(1); });
