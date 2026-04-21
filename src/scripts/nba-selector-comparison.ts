/**
 * NBA Selector Comparison Backtest
 *
 * Tests all 4 selectors (algorithm7, v24, emax, hedging) against 18 NBA
 * historical slates using Mode 2 (contest field as candidate pool).
 *
 * Reports top-1%, top-5%, and cash (top-20%) hit rates per selector per slate.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import {
  parseCSVFile,
  buildPlayerPool,
  parseContestActuals,
  ContestActuals,
} from '../parser';
import { getContestConfig } from '../rules';
import {
  DEFAULT_SELECTOR_PARAMS,
  SelectorParams,
  defaultGamma,
  getSportDefaults,
  precomputeSlate,
  algorithm7Select,
} from '../selection/algorithm7-selector';
import { v24Select, buildV24Params } from '../selection/v24-selector';
import { emaxSelect, buildEmaxParams } from '../selection/emax-selector';
import { hedgingSelect, buildHedgingParams } from '../selection/hedging-selector';

const HIST = 'C:/Users/colin/Projects/dfs-optimizer/historical_slates';
const N = 150;

function normalizeName(n: string): string {
  return (n || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreLineup(
  lu: Lineup,
  ah: Map<string, number>,
  act: ContestActuals,
): number | null {
  const fa = ah.get(lu.hash);
  if (fa !== undefined) return fa;
  let t = 0;
  for (const p of lu.players) {
    const r = act.playerActualsByName.get(normalizeName(p.name));
    if (!r) return null;
    t += r.fpts;
  }
  return t;
}

function buildPayoutTable(F: number, fee: number = 20): Float64Array {
  const pool = F * fee * 0.88;
  const cashLine = Math.floor(F * 0.22);
  const raw = new Float64Array(cashLine);
  let rawSum = 0;
  for (let r = 0; r < cashLine; r++) { raw[r] = Math.pow(r + 1, -1.15); rawSum += raw[r]; }
  const table = new Float64Array(F);
  const minCash = fee * 1.2;
  for (let r = 0; r < cashLine; r++) table[r] = Math.max(minCash, (raw[r] / rawSum) * pool);
  let tSum = 0;
  for (let r = 0; r < cashLine; r++) tSum += table[r];
  const scale = pool / tSum;
  for (let r = 0; r < cashLine; r++) table[r] *= scale;
  return table;
}

interface SlateResult {
  t1: number;
  t5: number;
  cash: number;
  scored: number;
  totalPayout: number;
}

type SelectorName = 'algorithm7' | 'v24' | 'emax' | 'hedging';

const SELECTORS: SelectorName[] = ['algorithm7', 'v24', 'emax', 'hedging'];

function runSelector(
  name: SelectorName,
  precomp: ReturnType<typeof precomputeSlate>,
  selParams: SelectorParams,
): Lineup[] {
  switch (name) {
    case 'algorithm7':
      return algorithm7Select(precomp, selParams).selected;
    case 'v24':
      return v24Select(precomp, selParams, buildV24Params('nba')).selected;
    case 'emax':
      return emaxSelect(precomp, selParams, buildEmaxParams('nba')).selected;
    case 'hedging':
      return hedgingSelect(precomp, selParams, buildHedgingParams('nba')).selected;
  }
}

function evalPortfolio(
  portfolio: Lineup[],
  actualByHash: Map<string, number>,
  actuals: ContestActuals,
  thresholds: { top1: number; top5: number; cash: number },
  sortedScores: number[],
  payoutTable: Float64Array,
): SlateResult {
  let t1 = 0, t5 = 0, cash = 0, scored = 0, totalPayout = 0;
  for (const lu of portfolio) {
    const a = scoreLineup(lu, actualByHash, actuals);
    if (a === null) continue;
    scored++;
    if (a >= thresholds.top1) t1++;
    if (a >= thresholds.top5) t5++;
    if (a >= thresholds.cash) cash++;

    // Binary search for rank
    let lo = 0, hi = sortedScores.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sortedScores[mid] >= a) lo = mid + 1;
      else hi = mid;
    }
    const rank = Math.max(1, lo);
    const payout = rank <= payoutTable.length ? payoutTable[rank - 1] : 0;
    totalPayout += payout;
  }
  return { t1, t5, cash, scored, totalPayout };
}

async function main() {
  const files = fs.readdirSync(HIST);
  const projRe = /^(\d{4}-\d{2}-\d{2})(?:_dk(?:_night)?)?_projections\.csv$/;
  const slates: Array<{ date: string; proj: string; actuals: string }> = [];
  for (const f of files) {
    const m = f.match(projRe);
    if (!m) continue;
    const date = m[1];
    const isDkNight = f.includes('_dk_night_');
    const isDk = f.includes('_dk_');
    const base = isDkNight ? `${date}_dk_night` : isDk ? `${date}_dk` : date;
    const af = `${base}_actuals.csv`;
    if (files.includes(af))
      slates.push({
        date: base,
        proj: path.join(HIST, f),
        actuals: path.join(HIST, af),
      });
  }
  slates.sort((a, b) => a.date.localeCompare(b.date));

  console.log(`Found ${slates.length} NBA slates\n`);

  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
  const pad = (s: string, w: number) => s.padStart(w);

  // Accumulate results per selector
  const totalResults: Record<SelectorName, { t1Sum: number; t5Sum: number; cashSum: number; paySum: number; n: number }> = {
    algorithm7: { t1Sum: 0, t5Sum: 0, cashSum: 0, paySum: 0, n: 0 },
    v24: { t1Sum: 0, t5Sum: 0, cashSum: 0, paySum: 0, n: 0 },
    emax: { t1Sum: 0, t5Sum: 0, cashSum: 0, paySum: 0, n: 0 },
    hedging: { t1Sum: 0, t5Sum: 0, cashSum: 0, paySum: 0, n: 0 },
  };

  // Per-slate detail rows
  const slateRows: string[] = [];

  for (const s of slates) {
    console.log(`\n=== ${s.date} ===`);

    // Parse projections + actuals
    const pr = parseCSVFile(s.proj, 'nba', true);
    const config = getContestConfig('dk', 'nba', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(s.actuals, config);

    // Build name lookup
    const nameMap = new Map<string, Player>();
    for (const p of pool.players) nameMap.set(normalizeName(p.name), p);

    // Build field lineups from contest entries
    const fieldLineups: Lineup[] = [];
    const actualByHash = new Map<string, number>();
    const seenH = new Set<string>();
    for (const e of actuals.entries) {
      const pls: Player[] = [];
      let ok = true;
      for (const nm of e.playerNames) {
        const p = nameMap.get(normalizeName(nm));
        if (!p) { ok = false; break; }
        pls.push(p);
      }
      if (!ok) continue;
      const hash = pls.map(p => p.id).sort().join('|');
      if (seenH.has(hash)) continue;
      seenH.add(hash);
      const sal = pls.reduce((sm, p) => sm + p.salary, 0);
      const proj = pls.reduce((sm, p) => sm + p.projection, 0);
      const own = pls.reduce((sm, p) => sm + (p.ownership || 0), 0) / pls.length;
      fieldLineups.push({ players: pls, salary: sal, projection: proj, ownership: own, hash });
      actualByHash.set(hash, e.actualPoints);
    }

    if (fieldLineups.length < 100) {
      console.log('  skip (field too small)');
      continue;
    }

    // Compute thresholds from actual contest results
    const F = actuals.entries.length;
    const sorted = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
    const tAt = (f: number) => sorted[Math.max(0, Math.floor(F * f) - 1)] || 0;
    const thresholds = { top1: tAt(0.01), top5: tAt(0.05), cash: tAt(0.20) };

    // Shared precomputation
    const selParams: SelectorParams = {
      ...DEFAULT_SELECTOR_PARAMS,
      ...getSportDefaults('nba'),
      N,
      gamma: defaultGamma(config.rosterSize),
      numWorlds: 1500,
    };
    console.log(`  precomp (field=${fieldLineups.length})...`);
    const precomp = precomputeSlate(fieldLineups, fieldLineups, pool.players, selParams, 'nba');

    // Build payout table for this slate
    const payoutTable = buildPayoutTable(F, 20);

    // Run each selector
    const slateResults: Record<SelectorName, SlateResult> = {} as any;
    for (const sel of SELECTORS) {
      console.log(`  ${sel}...`);
      const t0 = Date.now();
      const portfolio = runSelector(sel, precomp, selParams);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const res = evalPortfolio(portfolio, actualByHash, actuals, thresholds, sorted, payoutTable);
      slateResults[sel] = res;
      const rate = res.scored > 0 ? res.t1 / res.scored : 0;
      console.log(`    ${sel}: t1=${res.t1}/${res.scored} (${pct(rate)}) t5=${res.t5} cash=${res.cash} pay=$${res.totalPayout.toFixed(0)}  [${elapsed}s]`);

      const tr = totalResults[sel];
      tr.t1Sum += res.scored > 0 ? res.t1 / res.scored : 0;
      tr.t5Sum += res.scored > 0 ? res.t5 / res.scored : 0;
      tr.cashSum += res.scored > 0 ? res.cash / res.scored : 0;
      tr.paySum += res.totalPayout;
      tr.n++;
    }

    // Build row
    const parts = [pad(s.date, 16), pad(F.toString(), 8)];
    for (const sel of SELECTORS) {
      const r = slateResults[sel];
      parts.push(pad(`${r.t1} / $${r.totalPayout.toFixed(0)}`, 14));
    }
    slateRows.push(parts.join(' | '));
  }

  // Print summary table
  console.log('\n\n========================================');
  console.log('   NBA SELECTOR COMPARISON BACKTEST');
  console.log('========================================\n');

  const hdr = [
    pad('Slate', 16),
    pad('Entries', 8),
    ...SELECTORS.map(s => pad(s, 14)),
  ].join(' | ');
  const sep = hdr.replace(/[^|]/g, '-');
  console.log(hdr);
  console.log(sep);
  for (const row of slateRows) console.log(row);
  console.log(sep);

  // Means
  const means = [pad('MEAN', 16), pad('', 8)];
  for (const sel of SELECTORS) {
    const tr = totalResults[sel];
    means.push(pad(pct(tr.t1Sum / tr.n), 14));
  }
  console.log(means.join(' | '));

  // Top-5% means
  const means5 = [pad('MEAN t5%', 16), pad('', 8)];
  for (const sel of SELECTORS) {
    const tr = totalResults[sel];
    means5.push(pad(pct(tr.t5Sum / tr.n), 14));
  }
  console.log(means5.join(' | '));

  // Cash means
  const meansC = [pad('MEAN cash', 16), pad('', 8)];
  for (const sel of SELECTORS) {
    const tr = totalResults[sel];
    meansC.push(pad(pct(tr.cashSum / tr.n), 14));
  }
  console.log(meansC.join(' | '));

  // Payout totals
  const payRow = [pad('TOTAL PAY', 16), pad('', 8)];
  for (const sel of SELECTORS) {
    const tr = totalResults[sel];
    payRow.push(pad(`$${tr.paySum.toFixed(0)}`, 14));
  }
  console.log(payRow.join(' | '));

  const totalFees = 20 * N * slates.length;
  console.log(`\nEntry fees: $20 x ${N} x ${slates.length} = $${totalFees.toLocaleString()}`);
  for (const sel of SELECTORS) {
    const tr = totalResults[sel];
    const roi = ((tr.paySum / totalFees) - 1) * 100;
    console.log(`  ${sel}: $${tr.paySum.toFixed(0)} payout, ${roi.toFixed(1)}% ROI`);
  }

  console.log('\n--- Best selector by total payout ---');
  let best: SelectorName = 'algorithm7';
  let bestPay = 0;
  for (const sel of SELECTORS) {
    const tr = totalResults[sel];
    if (tr.paySum > bestPay) { bestPay = tr.paySum; best = sel; }
  }
  console.log(`  Winner: ${best} ($${bestPay.toFixed(0)} total payout)`);

  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
