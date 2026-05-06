/**
 * Deeper analysis of mlb_comprehensive_sweep.json:
 * - Concentration: what fraction of each selector's total comes from its best slate?
 * - LOO: which selector wins on N-1 slates for each held-out slate?
 * - Per-slate head-to-head vs prod-shipped.
 * - Robust metrics: median, IQR, profit-slate count.
 */

import * as fs from 'fs';
import * as path from 'path';

const DIR = 'C:/Users/colin/dfs opto';
const JSON_PATH = path.join(DIR, 'mlb_comprehensive_sweep.json');
const OUT_MD = path.join(DIR, 'mlb_sweep_analysis.md');

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

  const bySelSlate = new Map<string, Map<string, RunResult>>();
  for (const r of all) {
    if (!bySelSlate.has(r.selector)) bySelSlate.set(r.selector, new Map());
    bySelSlate.get(r.selector)!.set(r.slate, r);
  }

  const shipped = bySelSlate.get('prod-shipped')!;

  // ================== CONCENTRATION ==================
  interface Conc {
    selector: string;
    total: number;
    bestSlate: string;
    bestPay: number;
    bestFrac: number;
    totalMinusBest: number;
    shippedMinusBest: number;
    deltaWithoutBest: number;  // selector total-minus-best vs shipped total-minus-best
    profitSlates: number;
    wins: number;              // slates where selector beat shipped
    losses: number;
  }

  const concs: Conc[] = [];
  let shippedTotal = 0;
  for (const s of slates) shippedTotal += shipped.get(s)?.payout ?? 0;

  for (const sel of selectors) {
    const m = bySelSlate.get(sel)!;
    let total = 0, bestPay = 0, bestSlate = '', profit = 0;
    let wins = 0, losses = 0;
    for (const s of slates) {
      const r = m.get(s);
      const p = r?.payout ?? 0;
      total += p;
      if (p > bestPay) { bestPay = p; bestSlate = s; }
      if (p > 3000) profit++; // break-even threshold is $3000 (150 x $20)
      const shipPay = shipped.get(s)?.payout ?? 0;
      if (p > shipPay + 5) wins++;
      else if (p < shipPay - 5) losses++;
    }
    const shippedMinusBest = shippedTotal - (shipped.get(bestSlate)?.payout ?? 0);
    concs.push({
      selector: sel, total, bestSlate, bestPay,
      bestFrac: total > 0 ? bestPay / total : 0,
      totalMinusBest: total - bestPay,
      shippedMinusBest,
      deltaWithoutBest: (total - bestPay) - shippedMinusBest,
      profitSlates: profit, wins, losses,
    });
  }
  concs.sort((a, b) => b.total - a.total);

  // ================== LOO: for each held-out slate, which selector is best by total on the remaining? ==================
  const looPicks: { heldOut: string; best: string; totalOnOthers: number; shippedOnOthers: number; delta: number; heldPay: number; shippedHeldPay: number }[] = [];
  for (const held of slates) {
    let bestSel = '', bestSum = -Infinity;
    for (const sel of selectors) {
      const m = bySelSlate.get(sel)!;
      let sum = 0;
      for (const s of slates) if (s !== held) sum += m.get(s)?.payout ?? 0;
      if (sum > bestSum) { bestSum = sum; bestSel = sel; }
    }
    let shipSum = 0;
    for (const s of slates) if (s !== held) shipSum += shipped.get(s)?.payout ?? 0;
    looPicks.push({
      heldOut: held,
      best: bestSel,
      totalOnOthers: bestSum,
      shippedOnOthers: shipSum,
      delta: bestSum - shipSum,
      heldPay: bySelSlate.get(bestSel)!.get(held)?.payout ?? 0,
      shippedHeldPay: shipped.get(held)?.payout ?? 0,
    });
  }

  // Sum of LOO-held-out payouts (meta-selector payout if we actually used LOO picks)
  const looSum = looPicks.reduce((a, p) => a + p.heldPay, 0);
  const shippedSum = looPicks.reduce((a, p) => a + p.shippedHeldPay, 0);

  // ================== RECENT 5 head-to-head ==================
  const recentAnalysis: { selector: string; recentTotal: number; recentBestSlate: string; recentBestPay: number; recentMinusBest: number; wins: number; losses: number }[] = [];
  for (const sel of selectors) {
    const m = bySelSlate.get(sel)!;
    let total = 0, bestPay = 0, bestSlate = '', wins = 0, losses = 0;
    for (const s of RECENT) {
      const p = m.get(s)?.payout ?? 0;
      total += p;
      if (p > bestPay) { bestPay = p; bestSlate = s; }
      const shipPay = shipped.get(s)?.payout ?? 0;
      if (p > shipPay + 5) wins++;
      else if (p < shipPay - 5) losses++;
    }
    recentAnalysis.push({ selector: sel, recentTotal: total, recentBestSlate: bestSlate, recentBestPay: bestPay, recentMinusBest: total - bestPay, wins, losses });
  }
  recentAnalysis.sort((a, b) => b.recentTotal - a.recentTotal);

  // ================== OUTPUT ==================
  let md = `# MLB Sweep — Deeper Analysis\n\n`;
  md += `## 1. Concentration check — how much of each selector's total comes from 1 slate?\n\n`;
  md += `**Rule of thumb: if best-slate fraction > 50%, the ranking is unreliable.**\n\n`;
  md += `| Selector | Total | Best slate | Best pay | Best frac | Total w/o best | Shipped w/o same slate | Δ vs shipped w/o | Wins | Losses |\n`;
  md += `|---|---:|---|---:|---:|---:|---:|---:|---:|---:|\n`;
  for (const c of concs) {
    md += `| \`${c.selector}\` | $${c.total.toFixed(0)} | ${c.bestSlate} | $${c.bestPay.toFixed(0)} | **${(c.bestFrac * 100).toFixed(0)}%** | $${c.totalMinusBest.toFixed(0)} | $${c.shippedMinusBest.toFixed(0)} | ${c.deltaWithoutBest >= 0 ? '+' : ''}$${c.deltaWithoutBest.toFixed(0)} | ${c.wins} | ${c.losses} |\n`;
  }

  md += `\n## 2. LOO — leave-one-out meta-selector\n\n`;
  md += `For each held-out slate, pick the best selector by total on the OTHER 10 slates, then evaluate on the held-out slate. If LOO totalizes higher than shipped, there's a generalizable signal.\n\n`;
  md += `| Held out | Best selector (by others' total) | Its pay on held slate | Shipped pay on held | Δ |\n`;
  md += `|---|---|---:|---:|---:|\n`;
  for (const p of looPicks) {
    md += `| ${p.heldOut} | \`${p.best}\` | $${p.heldPay.toFixed(0)} | $${p.shippedHeldPay.toFixed(0)} | ${p.heldPay - p.shippedHeldPay >= 0 ? '+' : ''}$${(p.heldPay - p.shippedHeldPay).toFixed(0)} |\n`;
  }
  md += `\n**LOO total: $${looSum.toFixed(0)} vs shipped (no LOO): $${shippedSum.toFixed(0)} → ${looSum - shippedSum >= 0 ? '+' : ''}$${(looSum - shippedSum).toFixed(0)}**\n\n`;

  md += `## 3. Recent 5 slates (${[...RECENT].sort().join(', ')})\n\n`;
  md += `| Selector | Recent total | Best recent slate | Best pay | Total w/o best | Wins | Losses |\n`;
  md += `|---|---:|---|---:|---:|---:|---:|\n`;
  for (const r of recentAnalysis) {
    md += `| \`${r.selector}\` | $${r.recentTotal.toFixed(0)} | ${r.recentBestSlate} | $${r.recentBestPay.toFixed(0)} | $${r.recentMinusBest.toFixed(0)} | ${r.wins} | ${r.losses} |\n`;
  }

  md += `\n## 4. Per-slate head-to-head vs \`prod-shipped\`\n\n`;
  md += `Cells: Δ vs shipped (positive = selector won that slate).\n\n`;
  md += `| Selector |`;
  for (const s of slates) md += ` ${s} |`;
  md += ` Wins | Losses |\n`;
  md += `|---|`;
  for (const _ of slates) md += `---:|`;
  md += `---:|---:|\n`;
  for (const c of concs) {
    const m = bySelSlate.get(c.selector)!;
    md += `| \`${c.selector}\` |`;
    for (const s of slates) {
      const p = m.get(s)?.payout ?? 0;
      const ship = shipped.get(s)?.payout ?? 0;
      const d = p - ship;
      md += ` ${d >= 0 ? '+' : ''}$${d.toFixed(0)} |`;
    }
    md += ` ${c.wins} | ${c.losses} |\n`;
  }

  fs.writeFileSync(OUT_MD, md);

  // Print key findings to console
  console.log('\n================ KEY FINDINGS ================\n');
  console.log('TOP 10 BY TOTAL (with concentration):');
  for (let i = 0; i < 10; i++) {
    const c = concs[i];
    const flag = c.bestFrac > 0.5 ? ' ⚠ 1-slate concentrated' : '';
    console.log(`  ${(i + 1).toString().padStart(2)}. ${c.selector.padEnd(20)} $${c.total.toFixed(0).padStart(6)}  best=${c.bestSlate}($${c.bestPay.toFixed(0)}, ${(c.bestFrac*100).toFixed(0)}%)  w/o-best Δvs-shipped: ${c.deltaWithoutBest >= 0 ? '+' : ''}$${c.deltaWithoutBest.toFixed(0)}${flag}`);
  }

  console.log('\nLOO META-SELECTOR:');
  for (const p of looPicks) {
    console.log(`  held=${p.heldOut}: pick ${p.best}, gets $${p.heldPay.toFixed(0)} vs shipped $${p.shippedHeldPay.toFixed(0)} (${p.heldPay - p.shippedHeldPay >= 0 ? '+' : ''}$${(p.heldPay - p.shippedHeldPay).toFixed(0)})`);
  }
  console.log(`\nLOO total: $${looSum.toFixed(0)} vs shipped $${shippedSum.toFixed(0)} → ${looSum - shippedSum >= 0 ? '+' : ''}$${(looSum - shippedSum).toFixed(0)}`);

  console.log('\n\nRECENT 5:');
  for (let i = 0; i < recentAnalysis.length; i++) {
    const r = recentAnalysis[i];
    const frac = r.recentTotal > 0 ? r.recentBestPay / r.recentTotal : 0;
    const flag = frac > 0.5 ? ' ⚠' : '';
    console.log(`  ${(i + 1).toString().padStart(2)}. ${r.selector.padEnd(20)} $${r.recentTotal.toFixed(0).padStart(6)}  best=${r.recentBestSlate}($${r.recentBestPay.toFixed(0)}, ${(frac*100).toFixed(0)}%)  wins=${r.wins}, losses=${r.losses}${flag}`);
  }

  console.log(`\nMarkdown: ${OUT_MD}`);
}

main();
