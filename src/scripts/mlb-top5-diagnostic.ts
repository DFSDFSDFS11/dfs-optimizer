/**
 * MLB Top-5 Selector Diagnostic
 *
 * Answers four questions from the comprehensive sweep:
 *   1. 5x11 per-slate payout heatmap for the top 5 selectors
 *   2. 5x5 Pearson correlation of per-slate payouts (tells us if top 5 win
 *      the same or different slates — drives Interpretation A vs B decision)
 *   3. Per-selector LOO edge (each selector's own data only — remove one
 *      slate at a time, compute mean-of-remaining, check stability)
 *   4. Mechanical description of prod-extremeCorner + prod-projFloor90
 */

import * as fs from 'fs';
import * as path from 'path';

const DIR = 'C:/Users/colin/dfs opto';
const JSON_PATH = path.join(DIR, 'mlb_comprehensive_sweep.json');
const OUT_MD = path.join(DIR, 'mlb_top5_diagnostic.md');
const FEE = 20;
const N = 150;

interface RunResult {
  selector: string; family: string; slate: string; t1: number; payout: number; scored: number; runtimeMs: number; error?: string;
}

const RECENT = new Set(['4-18-26', '4-19-26', '4-20-26', '4-21-26', '4-22-26']);

function pearson(x: number[], y: number[]): number {
  const n = x.length;
  if (n !== y.length || n === 0) return 0;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
  mx /= n; my /= n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my);
    dx += (x[i] - mx) ** 2;
    dy += (y[i] - my) ** 2;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
}

function spearman(x: number[], y: number[]): number {
  const n = x.length;
  if (n !== y.length || n === 0) return 0;
  const rank = (arr: number[]): number[] => {
    const idx = arr.map((_, i) => i).sort((a, b) => arr[a] - arr[b]);
    const r = new Array(arr.length);
    for (let i = 0; i < idx.length; i++) r[idx[i]] = i + 1;
    return r;
  };
  return pearson(rank(x), rank(y));
}

function main() {
  const all: RunResult[] = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  const allSelectors = [...new Set(all.map(r => r.selector))];
  const slates = [...new Set(all.map(r => r.slate))].sort();

  // Build per-selector totals
  const totals = new Map<string, number>();
  for (const sel of allSelectors) {
    let t = 0;
    for (const r of all) if (r.selector === sel && !r.error) t += r.payout;
    totals.set(sel, t);
  }
  const TOP5 = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);

  // Build by-selector-slate lookup
  const bySS = new Map<string, Map<string, number>>();
  for (const r of all) {
    if (!bySS.has(r.selector)) bySS.set(r.selector, new Map());
    bySS.get(r.selector)!.set(r.slate, r.error ? 0 : r.payout);
  }

  // ================== 1. HEATMAP ==================
  let md = `# MLB Top-5 Selector Diagnostic\n\n`;
  md += `## 1. Per-slate payout heatmap (top 5 selectors)\n\n`;
  md += `| Selector |`;
  for (const s of slates) md += ` ${s} |`;
  md += ` **Total** |\n`;
  md += `|---|`;
  for (const _ of slates) md += `---:|`;
  md += `---:|\n`;
  for (const sel of TOP5) {
    const m = bySS.get(sel)!;
    md += `| \`${sel}\` |`;
    let t = 0;
    for (const s of slates) {
      const p = m.get(s) ?? 0;
      t += p;
      md += ` $${p.toFixed(0)} |`;
    }
    md += ` **$${t.toFixed(0)}** |\n`;
  }

  console.log('\n================ 1. PER-SLATE HEATMAP (top 5) ================\n');
  const colW = 10;
  let header = 'Selector'.padEnd(22) + '|';
  for (const s of slates) header += ' ' + s.padStart(colW - 1) + '|';
  header += ' TOTAL'.padStart(11);
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const sel of TOP5) {
    const m = bySS.get(sel)!;
    let line = sel.padEnd(22) + '|';
    let t = 0;
    for (const s of slates) {
      const p = m.get(s) ?? 0;
      t += p;
      line += ' $' + p.toFixed(0).padStart(colW - 2) + '|';
    }
    line += ' $' + t.toFixed(0).padStart(9);
    console.log(line);
  }

  // ================== 2. PAIRWISE CORRELATION ==================
  md += `\n## 2. Pairwise correlation of per-slate payouts (top 5)\n\n`;
  md += `Pearson (linear) and Spearman (rank) correlation of per-slate payouts.\n\n`;
  md += `### Pearson\n\n`;
  md += `| |`; for (const s of TOP5) md += ` \`${s}\` |`; md += `\n|---|`;
  for (const _ of TOP5) md += `---:|`; md += `\n`;
  console.log('\n================ 2. PAIRWISE CORRELATION (PEARSON) ================\n');
  let pHdr = ''.padEnd(22);
  for (const s of TOP5) pHdr += s.padStart(12);
  console.log(pHdr);
  for (const a of TOP5) {
    const xs = slates.map(s => bySS.get(a)!.get(s) ?? 0);
    let line = a.padEnd(22);
    md += `| \`${a}\` |`;
    for (const b of TOP5) {
      const ys = slates.map(s => bySS.get(b)!.get(s) ?? 0);
      const r = pearson(xs, ys);
      md += ` ${r.toFixed(2)} |`;
      line += r.toFixed(2).padStart(12);
    }
    md += `\n`;
    console.log(line);
  }

  md += `\n### Spearman (rank)\n\n`;
  md += `| |`; for (const s of TOP5) md += ` \`${s}\` |`; md += `\n|---|`;
  for (const _ of TOP5) md += `---:|`; md += `\n`;
  console.log('\n------ Spearman (rank correlation) ------');
  console.log(pHdr);
  for (const a of TOP5) {
    const xs = slates.map(s => bySS.get(a)!.get(s) ?? 0);
    let line = a.padEnd(22);
    md += `| \`${a}\` |`;
    for (const b of TOP5) {
      const ys = slates.map(s => bySS.get(b)!.get(s) ?? 0);
      const r = spearman(xs, ys);
      md += ` ${r.toFixed(2)} |`;
      line += r.toFixed(2).padStart(12);
    }
    md += `\n`;
    console.log(line);
  }

  // Also: which slates are "hot" for each selector?
  console.log('\n------ Hot slates per selector (>=$5000) ------');
  md += `\n### Hot slates per selector (payout ≥ $5,000)\n\n`;
  md += `| Selector | Hot slates |\n|---|---|\n`;
  for (const sel of TOP5) {
    const m = bySS.get(sel)!;
    const hot = slates.filter(s => (m.get(s) ?? 0) >= 5000);
    console.log(`  ${sel.padEnd(22)} ${hot.join(', ') || '(none)'}`);
    md += `| \`${sel}\` | ${hot.join(', ') || '(none)'} |\n`;
  }

  // ================== 3. PER-SELECTOR LOO ==================
  md += `\n## 3. Per-selector LOO — does each selector's edge hold if we drop each slate?\n\n`;
  md += `For each selector, leave one slate out at a time and compute the selector's mean on the remaining 10 slates. High variance across LOO means the selector's edge depends on specific slates.\n\n`;
  md += `| Selector | Mean (all 11) | Min LOO mean | Max LOO mean | Range | Worst slate to drop | Best slate to drop |\n`;
  md += `|---|---:|---:|---:|---:|---|---|\n`;
  console.log('\n================ 3. PER-SELECTOR LOO ================\n');
  console.log('Selector               | all-mean | min-LOO | max-LOO | range  | worst-drop    | best-drop');
  console.log('-'.repeat(110));
  for (const sel of TOP5) {
    const m = bySS.get(sel)!;
    const pays = slates.map(s => m.get(s) ?? 0);
    const total = pays.reduce((a, b) => a + b, 0);
    const allMean = total / slates.length;
    const loos = slates.map((_, i) => {
      let sum = 0, cnt = 0;
      for (let j = 0; j < slates.length; j++) if (j !== i) { sum += pays[j]; cnt++; }
      return sum / cnt;
    });
    const minLoo = Math.min(...loos);
    const maxLoo = Math.max(...loos);
    const worstIdx = loos.indexOf(minLoo);
    const bestIdx = loos.indexOf(maxLoo);
    const worstSlate = slates[worstIdx];
    const bestSlate = slates[bestIdx];
    console.log(`${sel.padEnd(22)} | $${allMean.toFixed(0).padStart(6)} | $${minLoo.toFixed(0).padStart(6)} | $${maxLoo.toFixed(0).padStart(6)} | $${(maxLoo - minLoo).toFixed(0).padStart(5)} | drop ${worstSlate} | drop ${bestSlate}`);
    md += `| \`${sel}\` | $${allMean.toFixed(0)} | $${minLoo.toFixed(0)} | $${maxLoo.toFixed(0)} | $${(maxLoo - minLoo).toFixed(0)} | ${worstSlate} ($${pays[worstIdx].toFixed(0)} → drop removes biggest hit) | ${bestSlate} ($${pays[bestIdx].toFixed(0)}) |\n`;
  }
  console.log('\n  Reading: large range = single-slate dependent. Small range = stable across slates.');
  console.log('  "Worst drop" = slate that, when removed, cuts the mean the most (= selector\'s biggest hit).');

  // Rank-by-LOO-mean to see how ranking shifts
  md += `\n### Rank-by-min-LOO-mean (robustness ranking)\n\n`;
  md += `This ranks selectors by their WORST-case LOO mean — the selector that survives best when its biggest slate is removed.\n\n`;
  md += `| Rank | Selector | Min LOO mean | vs full-sample mean |\n|---:|---|---:|---:|\n`;
  const robustness = TOP5.map(sel => {
    const m = bySS.get(sel)!;
    const pays = slates.map(s => m.get(s) ?? 0);
    const total = pays.reduce((a, b) => a + b, 0);
    const allMean = total / slates.length;
    const loos = slates.map((_, i) => {
      let sum = 0, cnt = 0;
      for (let j = 0; j < slates.length; j++) if (j !== i) { sum += pays[j]; cnt++; }
      return sum / cnt;
    });
    return { sel, allMean, minLoo: Math.min(...loos) };
  }).sort((a, b) => b.minLoo - a.minLoo);
  console.log('\n  Robustness ranking (by min-LOO mean):');
  for (let i = 0; i < robustness.length; i++) {
    const r = robustness[i];
    console.log(`    ${i + 1}. ${r.sel.padEnd(22)} min-LOO=$${r.minLoo.toFixed(0).padStart(4)}  all-mean=$${r.allMean.toFixed(0).padStart(4)}  drop=${(r.minLoo - r.allMean).toFixed(0)}`);
    md += `| ${i + 1} | \`${r.sel}\` | $${r.minLoo.toFixed(0)} | $${(r.minLoo - r.allMean).toFixed(0)} |\n`;
  }

  // ================== 4. MECHANICAL DESCRIPTIONS ==================
  md += `\n## 4. What do the top-5 selectors actually do?\n\n`;

  const descriptions = [
    {
      sel: 'emax', file: 'src/selection/emax-selector.ts',
      mech: `**Liu-Teo sequential E[max] optimization.** Simulates W=1500 "worlds" via t-copula scenario generation, scoring each candidate's points in each world. Iteratively picks lineups that maximize the expected maximum of the portfolio per world — i.e., each new lineup is chosen to raise the expectation of "what's the best score in my portfolio per world." Uses a projection floor (top 60% of candidates survive). Field-aware (OFF by default — treats pool itself as field).`,
    },
    {
      sel: 'prod-λ0.20', file: 'src/selection/production-selector.ts',
      mech: `**Production architecture with λ=0.20 combo leverage** (4× shipped λ=0.05). Same bin architecture (10/30/35/20/5), same γ=7 overlap cap, same team cap. Only difference: within each bin, lineups are ranked by \`projection + 0.20 × comboBonus\` instead of \`projection + 0.05 × comboBonus\`. ComboBonus measures how RARE a lineup's stacking pattern is (keys: primaryStack, 3+stackCombo, pitcher+stackCombo, stackPair). Stronger λ pushes harder toward rare construction patterns within each ownership bin.`,
    },
    {
      sel: 'prod-extremeCorner', file: 'src/selection/production-selector.ts',
      mech: `**Production + extreme-corner cap** (\`extremeCornerCap: true\`). Within the 150 portfolio, caps the share of lineups in the (Q5-proj, Q5-own) cell (highest projection × highest ownership — the "optimal chalk" corner) at 25% of portfolio, and the (Q1-proj, Q1-own) cell (lowest proj × lowest own — the "dead contrarian" corner) at 5%. This redirects selection toward middle cells, forcing off-chalk-off-floor construction. Note: prior memory says "extremeCornerCap: MLB-only; backtest win was 99.98% 4-14-driven" — so this was previously flagged as slate-concentrated.`,
    },
    {
      sel: 'parimutuel', file: 'src/selection/parimutuel-ev.ts',
      mech: `**Parimutuel expected-value greedy.** For each simulated world (W=1500), computes each candidate's rank, and the implied DK payout at that rank. Divides by (1 + expected field duplicates) to account for split-pot dilution. Selects greedily by marginal EV — each new lineup is picked to add the most incremental expected dollars to the portfolio, with overlap and team caps. Field-aware (uses actual contest entries as duplicate estimate).`,
    },
    {
      sel: 'prod-projFloor90', file: 'src/selection/production-selector.ts',
      mech: `**Production + 90% projection floor.** Before bin allocation, hard-filters the pool: any lineup whose total projection is below 90% of the pool's max (optimal) projection is dropped. This is NOT a percentile — it's a fraction-of-optimal. On MLB slates where top projection is ~115 points, floor ≈ 103.5 points. Rest of the pipeline is unchanged: default bins, λ=0.05, γ=7.`,
    },
  ];
  for (const d of descriptions) {
    md += `### \`${d.sel}\` (${d.file})\n\n${d.mech}\n\n`;
    console.log(`\n------ ${d.sel} (${d.file}) ------`);
    console.log(d.mech);
  }

  fs.writeFileSync(OUT_MD, md);
  console.log(`\nMarkdown: ${OUT_MD}`);
}

main();
