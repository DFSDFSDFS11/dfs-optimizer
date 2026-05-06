/**
 * Print ROI for every selector × slate and aggregate.
 * Uses mlb_comprehensive_sweep.json.
 */

import * as fs from 'fs';
import * as path from 'path';

const DIR = 'C:/Users/colin/dfs opto';
const JSON_PATH = path.join(DIR, 'mlb_comprehensive_sweep.json');
const N = 150;
const FEE = 20;

interface RunResult {
  selector: string;
  family: string;
  slate: string;
  t1: number;
  payout: number;
  scored: number;
  runtimeMs: number;
  error?: string;
}

const RECENT = new Set(['4-18-26', '4-19-26', '4-20-26', '4-21-26', '4-22-26']);

function main() {
  const all: RunResult[] = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  const selectors = [...new Set(all.map(r => r.selector))];
  const slates = [...new Set(all.map(r => r.slate))].sort();

  interface Summary {
    selector: string;
    family: string;
    fullPay: number;
    fullCost: number;
    fullROI: number;
    fullSlates: number;
    recentPay: number;
    recentCost: number;
    recentROI: number;
    recentSlates: number;
    t1: number;
    recentT1: number;
    wins: number;      // # slates where this selector produced positive $
    profitable: number; // # slates where pay > entry cost
  }

  const summaries: Summary[] = [];
  for (const sel of selectors) {
    const rows = all.filter(r => r.selector === sel && !r.error);
    let fullPay = 0, fullCost = 0, recentPay = 0, recentCost = 0;
    let t1 = 0, recentT1 = 0, fullSlates = 0, recentSlates = 0, wins = 0, profitable = 0;
    for (const r of rows) {
      const cost = FEE * N; // assume 150 entries filled
      fullPay += r.payout; fullCost += cost; fullSlates++; t1 += r.t1;
      if (r.payout > 0) wins++;
      if (r.payout > cost) profitable++;
      if (RECENT.has(r.slate)) {
        recentPay += r.payout; recentCost += cost; recentSlates++; recentT1 += r.t1;
      }
    }
    summaries.push({
      selector: sel,
      family: rows[0]?.family || '?',
      fullPay, fullCost, fullROI: fullCost > 0 ? (fullPay / fullCost - 1) * 100 : 0, fullSlates,
      recentPay, recentCost, recentROI: recentCost > 0 ? (recentPay / recentCost - 1) * 100 : 0, recentSlates,
      t1, recentT1, wins, profitable,
    });
  }

  summaries.sort((a, b) => b.fullROI - a.fullROI);

  console.log('\n================================================================');
  console.log(`MLB SELECTOR ROI — 11 slates (4-11 excluded, bad pool file). N=150, fee=$20.`);
  console.log('================================================================\n');
  console.log('Rank | Selector               | Family     | Full ROI  | Recent ROI | Full Pay  | Recent Pay | t1 | Profitable');
  console.log('-----|------------------------|------------|-----------|------------|-----------|------------|----|----------');
  for (let i = 0; i < summaries.length; i++) {
    const s = summaries[i];
    console.log(
      `  ${(i + 1).toString().padStart(2)} | ${s.selector.padEnd(22)} | ${s.family.padEnd(10)} | ${s.fullROI >= 0 ? '+' : ''}${s.fullROI.toFixed(1).padStart(6)}% | ${s.recentROI >= 0 ? '+' : ''}${s.recentROI.toFixed(1).padStart(7)}% | $${s.fullPay.toFixed(0).padStart(6)} | $${s.recentPay.toFixed(0).padStart(8)} | ${s.t1.toString().padStart(2)} | ${s.profitable}/${s.fullSlates}`
    );
  }

  console.log('\nNote: ROI = (payout / $3000 per slate) - 100%. "Profitable" = slates where the 150-lineup portfolio covered its $3000 entry cost.\n');

  // Also break out: what % of slates did each selector break-even or better?
  console.log('\n===== Recent-slate ROI ranking =====\n');
  const recentSorted = [...summaries].sort((a, b) => b.recentROI - a.recentROI);
  console.log('Rank | Selector               | Recent ROI | Recent Pay | Recent Fees');
  console.log('-----|------------------------|------------|------------|------------');
  for (let i = 0; i < recentSorted.length; i++) {
    const s = recentSorted[i];
    console.log(
      `  ${(i + 1).toString().padStart(2)} | ${s.selector.padEnd(22)} | ${s.recentROI >= 0 ? '+' : ''}${s.recentROI.toFixed(1).padStart(7)}% | $${s.recentPay.toFixed(0).padStart(8)} | $${s.recentCost.toFixed(0).padStart(8)}`
    );
  }
}

main();
