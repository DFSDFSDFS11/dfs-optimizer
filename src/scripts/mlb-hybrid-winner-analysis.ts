/**
 * Per-slate analysis of the two hybrid V2 winners to check slate concentration.
 */

import * as fs from 'fs';
import * as path from 'path';

const DIR = 'C:/Users/colin/dfs opto';
const JSON_PATH = path.join(DIR, 'mlb_hybrid_v2.json');

interface Row { combo: string; slate: string; pay: number; t1: number }

const WINNERS = [
  'λc0.2|λe2|λp0|floor0|corner',       // full-winner
  'λc0.2|λe0|λp0|floor0|corner',       // recent-winner (simpler)
  'λc0.2|λe0.25|λp0|floor0|corner',
  'λc0.2|λe0.5|λp0|floor0|corner',
  'λc0.2|λe0|λp0|floor0',              // pure prod-λ0.20 in this framework
];

function main() {
  const rows: Row[] = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  const slates = [...new Set(rows.map(r => r.slate))].sort();

  console.log('Per-slate payouts for top hybrid V2 configs:\n');
  let hdr = 'Config'.padEnd(42) + '|';
  for (const s of slates) hdr += ' ' + s.padStart(9) + ' |';
  hdr += '  TOTAL';
  console.log(hdr);
  console.log('-'.repeat(hdr.length));

  for (const combo of WINNERS) {
    const r = rows.filter(x => x.combo === combo);
    let line = combo.padEnd(42) + '|';
    let total = 0;
    for (const s of slates) {
      const row = r.find(x => x.slate === s);
      const p = row?.pay ?? 0;
      total += p;
      line += ' $' + p.toFixed(0).padStart(7) + ' |';
    }
    line += ' $' + total.toFixed(0).padStart(7);
    console.log(line);
  }

  // Concentration analysis
  console.log('\n\nConcentration analysis:\n');
  console.log('Config                                      | Total    | Best slate | Best pay | Best %  | Total w/o best');
  console.log('-'.repeat(110));
  for (const combo of WINNERS) {
    const r = rows.filter(x => x.combo === combo);
    let total = 0, bestPay = 0, bestSlate = '';
    for (const x of r) {
      total += x.pay;
      if (x.pay > bestPay) { bestPay = x.pay; bestSlate = x.slate; }
    }
    const pct = total > 0 ? (bestPay / total) * 100 : 0;
    console.log(`${combo.padEnd(42)} | $${total.toFixed(0).padStart(6)} | ${bestSlate.padEnd(9)} | $${bestPay.toFixed(0).padStart(6)} | ${pct.toFixed(0).padStart(4)}%   | $${(total - bestPay).toFixed(0).padStart(6)}`);
  }

  // LOO for all winners
  console.log('\n\nLOO analysis:\n');
  for (const combo of WINNERS) {
    const r = rows.filter(x => x.combo === combo);
    const pays = slates.map(s => r.find(x => x.slate === s)?.pay ?? 0);
    const total = pays.reduce((a, b) => a + b, 0);
    const loos = slates.map((_, i) => {
      let s = 0, cnt = 0;
      for (let j = 0; j < pays.length; j++) if (j !== i) { s += pays[j]; cnt++; }
      return cnt > 0 ? s / cnt : 0;
    });
    const minLoo = Math.min(...loos);
    const maxLoo = Math.max(...loos);
    const minIdx = loos.indexOf(minLoo);
    console.log(`${combo.padEnd(42)} total=$${total.toFixed(0)}  min-LOO=$${minLoo.toFixed(0)} (drop ${slates[minIdx]})  max-LOO=$${maxLoo.toFixed(0)}  range=$${(maxLoo - minLoo).toFixed(0)}`);
  }

  // Compare to prod-λ0.20 benchmark from the comprehensive sweep
  console.log('\n\nReference from comprehensive sweep:');
  console.log(`  prod-λ0.20 (no corner):  full $47,864, recent $42,235, min-LOO $2,250, profitable 3/11`);
  console.log(`  prod-extremeCorner (λc=0.05 + corner): full $46,108, recent $27,684, min-LOO $2,080, profitable 3/11`);
}

main();
