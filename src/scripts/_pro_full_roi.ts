/**
 * Full ROI table: every pro on every slate, compared to Argus-Atlas.
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseCSVFile, buildPlayerPool, parseContestActuals, ContestEntry } from '../parser';
import { getContestConfig } from '../rules';

const DIR = 'C:/Users/colin/dfs opto';
const OUT_DIR = path.join(DIR, 'multi_combo_penalty_implementation');
const FEE = 20;

const SLATE_FILES: [string, string, string][] = [
  ['4-6-26',  '4-6-26_projections.csv',          'dkactuals 4-6-26.csv'],
  ['4-8-26',  '4-8-26projections.csv',           '4-8-26actuals.csv'],
  ['4-12-26', '4-12-26projections.csv',          '4-12-26actuals.csv'],
  ['4-14-26', '4-14-26projections.csv',          '4-14-26actuals.csv'],
  ['4-15-26', '4-15-26projections.csv',          '4-15-26actuals.csv'],
  ['4-17-26', '4-17-26projections.csv',          '4-17-26actuals.csv'],
  ['4-18-26', '4-18-26projections.csv',          '4-18-26actuals.csv'],
  ['4-19-26', '4-19-26projections.csv',          '4-19-26actuals.csv'],
  ['4-20-26', '4-20-26projections.csv',          '4-20-26actuals.csv'],
  ['4-21-26', '4-21-26projections.csv',          '4-21-26actuals.csv'],
  ['4-22-26', '4-22-26projections.csv',          '4-22-26actuals.csv'],
  ['4-23-26', '4-23-26projections.csv',          '4-23-26actuals.csv'],
  ['4-24-26', '4-24-26projections.csv',          '4-24-26actuals.csv'],
  ['4-25-26', '4-25-26projections.csv',          '4-25-26actuals.csv'],
  ['4-25-26-early', '4-25-26projectionsearly.csv','4-25-26actualsearly.csv'],
  ['4-26-26', '4-26-26projections.csv',          '4-26-26actuals.csv'],
  ['4-27-26', '4-27-26projections.csv',          '4-27-26actuals.csv'],
  ['4-28-26', '4-28-26projections.csv',          '4-28-26actuals.csv'],
  ['4-29-26', '4-29-26projections.csv',          '4-29-26actuals.csv'],
  ['5-1-26',  '5-1-26projections.csv',           '5-1-26actuals.csv'],
  ['5-2-26',  '5-2-26projections.csv',           '5-2-26actuals.csv'],
  ['5-2-26-main', '5-2-26projectionsmain.csv',   '5-2-26actualsmain.csv'],
  ['5-3-26',  '5-3-26projections.csv',           '5-3-26actuals.csv'],
  ['5-3-26-late', '5-3-26projectionslate.csv',   '5-3-26actualslate.csv'],
  ['5-4-26',  '5-4-26projections.csv',           '5-4-26actuals.csv'],
  ['5-4-26-late', '5-4-26projectionslate.csv',   '5-4-26actualslate.csv'],
  ['5-5-26',  '5-5-26projections.csv',           '5-5-26actuals.csv'],
  ['5-6-26',  '5-6-26projections.csv',           '5-6-26actuals.csv'],
  ['5-8-26',  '5-8-26projections.csv',           '5-8-26actuals.csv'],
  ['5-10-26', '5-10-26projections.csv',          '5-10-26actuals.csv'],
  ['5-10-26-late', '5-10-26projectionslate.csv', '5-10-26actualslate.csv'],
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

function extractUser(s: string): string { return (s||'').replace(/\s*\([^)]*\)\s*$/,'').trim(); }

function buildPayoutTable(F: number): Float64Array {
  const pool = F * FEE * 0.88; const cashLine = Math.floor(F * 0.22);
  const raw = new Float64Array(cashLine); let rawSum = 0;
  for (let r = 0; r < cashLine; r++) { raw[r] = Math.pow(r+1, -1.15); rawSum += raw[r]; }
  const tbl = new Float64Array(F); const minCash = FEE * 1.2;
  for (let r = 0; r < cashLine; r++) tbl[r] = Math.max(minCash, (raw[r]/rawSum)*pool);
  let tSum = 0; for (let r = 0; r < cashLine; r++) tSum += tbl[r];
  const sc = pool / tSum; for (let r = 0; r < cashLine; r++) tbl[r] *= sc;
  return tbl;
}

async function main() {
  type ProTotal = { cost: number; payout: number; profitable_slates: number; n_slates: number; per_slate: Record<string, number> };
  const totals: Record<string, ProTotal> = {};
  for (const pro of PROS) totals[pro.label] = { cost: 0, payout: 0, profitable_slates: 0, n_slates: 0, per_slate: {} };

  for (const [slate, projF, actualsF] of SLATE_FILES) {
    const pp = path.join(DIR, projF), ap = path.join(DIR, actualsF);
    if (!fs.existsSync(pp) || !fs.existsSync(ap)) { console.log(`skip ${slate}`); continue; }
    const pr = parseCSVFile(pp, 'mlb', true);
    const cfg = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(ap, cfg);
    const F = actuals.entries.length;
    const sortedPts = actuals.entries.map(e => e.actualPoints).sort((a,b) => b - a);
    const tbl = buildPayoutTable(F);
    const byUser = new Map<string, ContestEntry[]>();
    for (const e of actuals.entries) {
      const u = extractUser(e.entryName);
      const arr = byUser.get(u); if (arr) arr.push(e); else byUser.set(u, [e]);
    }
    for (const pro of PROS) {
      let matched: ContestEntry[] = [];
      for (const [u, ents] of byUser) {
        if (pro.tokens.some(t => u.toLowerCase().includes(t))) matched = matched.concat(ents);
      }
      if (matched.length < 50) continue;
      let payout = 0;
      for (const e of matched) {
        const pts = e.actualPoints;
        let lo = 0, hi = sortedPts.length;
        while (lo < hi) { const m = (lo+hi)>>>1; if (sortedPts[m] >= pts) lo = m+1; else hi = m; }
        const rank = Math.max(1, lo);
        if (rank <= tbl.length) payout += tbl[rank-1];
      }
      const cost = matched.length * FEE;
      const roi = (payout/cost - 1) * 100;
      totals[pro.label].cost += cost;
      totals[pro.label].payout += payout;
      totals[pro.label].n_slates += 1;
      if (roi > 0) totals[pro.label].profitable_slates += 1;
      totals[pro.label].per_slate[slate] = roi;
    }
  }

  // Per-slate matrix
  console.log('\nPER-SLATE ROI (%):  rows=slate, cols=pro\n');
  const slates = SLATE_FILES.map(s => s[0]);
  const proLabels = PROS.map(p => p.label);
  const hdr = 'slate'.padEnd(18) + proLabels.map(p => p.slice(0,12).padStart(13)).join(' ');
  console.log(hdr);
  console.log('-'.repeat(hdr.length));
  for (const sl of slates) {
    const row = [sl.padEnd(18)];
    for (const lbl of proLabels) {
      const r = totals[lbl].per_slate[sl];
      row.push((r !== undefined ? r.toFixed(0) + '%' : '   --').padStart(13));
    }
    console.log(row.join(' '));
  }

  console.log('\n\nAGGREGATE PRO ROI:\n');
  console.log('pro'.padEnd(18) + 'slates'.padStart(7) + 'cost'.padStart(10) + 'payout'.padStart(11) + 'agg_ROI'.padStart(10) + 'profitable'.padStart(12));
  console.log('-'.repeat(68));
  for (const lbl of proLabels) {
    const t = totals[lbl];
    const roi = t.cost > 0 ? (t.payout/t.cost - 1) * 100 : 0;
    console.log(
      lbl.padEnd(18) +
      String(t.n_slates).padStart(7) +
      ('$'+t.cost.toFixed(0)).padStart(10) +
      ('$'+t.payout.toFixed(0)).padStart(11) +
      (roi.toFixed(2) + '%').padStart(10) +
      (t.profitable_slates + '/' + t.n_slates).padStart(12)
    );
  }
}
main().catch(e => { console.error(e); process.exit(1); });
