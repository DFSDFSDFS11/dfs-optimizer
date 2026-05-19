/**
 * Quick scan: did named pros also bomb on 5-8, 5-10, 5-10-late?
 *
 * For each pro per slate, compute:
 *   - n entries
 *   - mean actual pts
 *   - count of top-1% / top-5% / top-20% hits
 *   - approx ROI using same payout schedule as Argus backtest
 */
import * as fs from 'fs';
import * as path from 'path';
import { Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, ContestEntry } from '../parser';
import { getContestConfig } from '../rules';

const DIR = 'C:/Users/colin/dfs opto';
const FEE = 20;
const SLATES = [
  { slate: '5-8-26',  proj: '5-8-26projections.csv',  actuals: '5-8-26actuals.csv' },
  { slate: '5-10-26', proj: '5-10-26projections.csv', actuals: '5-10-26actuals.csv' },
  { slate: '5-10-26-late', proj: '5-10-26projectionslate.csv', actuals: '5-10-26actualslate.csv' },
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

function extractUser(s: string): string { return (s || '').replace(/\s*\([^)]*\)\s*$/, '').trim(); }

function buildPayoutTable(F: number): Float64Array {
  const pool = F * FEE * 0.88; const cashLine = Math.floor(F * 0.22);
  const raw = new Float64Array(cashLine); let rawSum = 0;
  for (let r = 0; r < cashLine; r++) { raw[r] = Math.pow(r + 1, -1.15); rawSum += raw[r]; }
  const tbl = new Float64Array(F); const minCash = FEE * 1.2;
  for (let r = 0; r < cashLine; r++) tbl[r] = Math.max(minCash, (raw[r] / rawSum) * pool);
  let tSum = 0; for (let r = 0; r < cashLine; r++) tSum += tbl[r];
  const sc = pool / tSum; for (let r = 0; r < cashLine; r++) tbl[r] *= sc;
  return tbl;
}

async function main() {
  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj);
    const actualsPath = path.join(DIR, s.actuals);
    if (!fs.existsSync(projPath) || !fs.existsSync(actualsPath)) { console.log(`skip ${s.slate}`); continue; }
    const pr = parseCSVFile(projPath, 'mlb', true);
    const cfg = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, cfg);
    const F = actuals.entries.length;
    const sortedPts = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
    const top1T = sortedPts[Math.max(0, Math.floor(F*0.01)-1)] || 0;
    const top5T = sortedPts[Math.max(0, Math.floor(F*0.05)-1)] || 0;
    const top20T = sortedPts[Math.max(0, Math.floor(F*0.20)-1)] || 0;
    const tbl = buildPayoutTable(F);
    const byUser = new Map<string, ContestEntry[]>();
    for (const e of actuals.entries) {
      const u = extractUser(e.entryName);
      const arr = byUser.get(u); if (arr) arr.push(e); else byUser.set(u, [e]);
    }
    console.log(`\n=== ${s.slate}  field=${F}  top1_threshold=${top1T.toFixed(1)} ===`);
    // Show field median for context.
    const medianPts = sortedPts[Math.floor(F/2)];
    console.log(`  field median pts: ${medianPts.toFixed(1)}  top5_threshold: ${top5T.toFixed(1)}  top20: ${top20T.toFixed(1)}`);
    for (const pro of PROS) {
      let matched: ContestEntry[] = [];
      for (const [u, ents] of byUser) {
        if (pro.tokens.some(t => u.toLowerCase().includes(t))) matched = matched.concat(ents);
      }
      if (matched.length < 50) continue;
      let total = 0; let t1=0, t5=0, t20=0;
      const pts: number[] = [];
      for (const e of matched) {
        const p = e.actualPoints;
        pts.push(p);
        if (p >= top1T) t1++;
        if (p >= top5T) t5++;
        if (p >= top20T) t20++;
        // Find rank
        let lo = 0, hi = sortedPts.length;
        while (lo < hi) { const m = (lo+hi)>>>1; if (sortedPts[m] >= p) lo = m+1; else hi = m; }
        const rank = Math.max(1, lo);
        if (rank <= tbl.length) total += tbl[rank-1];
      }
      const cost = matched.length * FEE;
      const roi = (total/cost - 1) * 100;
      const mean = pts.reduce((a,b)=>a+b,0) / pts.length;
      console.log(`  ${pro.label.padEnd(16)} n=${matched.length}  mean=${mean.toFixed(1)}  t1=${t1} t5=${t5} t20=${t20}  payout=$${total.toFixed(0).padStart(7)}  ROI=${roi.toFixed(0).padStart(5)}%`);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
