/**
 * MLB Rank + Clumping Diagnostic
 *
 * Two questions:
 *
 * 1. RANK: Within our 150-lineup portfolio, where do the actual-high-scoring
 *    lineups sit vs our selection metric (projection+combo)?
 *    - Compute actual-score rank within the 150 for each selected lineup.
 *    - Compute selection-score rank (projection + λ*combo) within the 150.
 *    - Correlation: does high selection rank predict high actual rank?
 *    - Where do the top-5 by actual payout sit when sorted by our metric?
 *
 * 2. CLUMPING: How similar are our 150 to each other?
 *    - Pairwise overlap distribution (min/mean/median/max).
 *    - Top-10 most exposed players (exposure %).
 *    - Team stack concentration.
 *    - Effective unique lineups (a measure of diversity — how many truly distinct
 *      constructions exist).
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import {
  parseCSVFile,
  buildPlayerPool,
  parseContestActuals,
  loadPoolFromCSV,
  ContestActuals,
} from '../parser';
import { getContestConfig } from '../rules';
import { productionSelect } from '../selection/production-selector';
import { precomputeComboFrequencies, comboBonus } from '../selection/combo-leverage';

const DIR = 'C:/Users/colin/dfs opto';
const N = 150;
const FEE = 20;
const LAMBDA = 0.20;
const GAMMA = 7;

const SLATES = [
  { slate: '4-6-26',  proj: '4-6-26_projections.csv', actuals: 'dkactuals 4-6-26.csv', pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26',  proj: '4-8-26projections.csv',  actuals: '4-8-26actuals.csv',    pool: '4-8-26sspool.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv', actuals: '4-12-26actuals.csv',   pool: '4-12-26sspool.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv', actuals: '4-14-26actuals.csv',   pool: '4-14-26sspool.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv', actuals: '4-15-26actuals.csv',   pool: '4-15-26sspool.csv' },
  { slate: '4-17-26', proj: '4-17-26projections.csv', actuals: '4-17-26actuals.csv',   pool: '4-17-26sspool.csv' },
  { slate: '4-18-26', proj: '4-18-26projections.csv', actuals: '4-18-26actuals.csv',   pool: '4-18-26sspool.csv' },
  { slate: '4-19-26', proj: '4-19-26projections.csv', actuals: '4-19-26actuals.csv',   pool: '4-19-26sspool.csv' },
  { slate: '4-20-26', proj: '4-20-26projections.csv', actuals: '4-20-26actuals.csv',   pool: '4-20-26sspool.csv' },
  { slate: '4-21-26', proj: '4-21-26projections.csv', actuals: '4-21-26actuals.csv',   pool: '4-21-26sspool.csv' },
  { slate: '4-22-26', proj: '4-22-26projections.csv', actuals: '4-22-26actuals.csv',   pool: '4-22-26sspool.csv' },
];

function norm(n: string): string {
  return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildPayoutTable(F: number): Float64Array {
  const pool = F * FEE * 0.88;
  const cashLine = Math.floor(F * 0.22);
  const raw = new Float64Array(cashLine);
  let rawSum = 0;
  for (let r = 0; r < cashLine; r++) { raw[r] = Math.pow(r + 1, -1.15); rawSum += raw[r]; }
  const table = new Float64Array(F);
  const minCash = FEE * 1.2;
  for (let r = 0; r < cashLine; r++) table[r] = Math.max(minCash, (raw[r] / rawSum) * pool);
  let tSum = 0;
  for (let r = 0; r < cashLine; r++) tSum += table[r];
  const scale = pool / tSum;
  for (let r = 0; r < cashLine; r++) table[r] *= scale;
  return table;
}

function scoreLineup(lu: Lineup, actuals: ContestActuals, actualByHash: Map<string, number>): number | null {
  const h = lu.players.map(p => p.id).sort().join('|');
  const fa = actualByHash.get(h);
  if (fa !== undefined) return fa;
  let t = 0;
  for (const p of lu.players) {
    const r = actuals.playerActualsByName.get(norm(p.name));
    if (!r) return null;
    t += r.fpts;
  }
  return t;
}

function payoutFor(actual: number, sortedScores: number[], payoutTable: Float64Array, actuals: ContestActuals): number {
  let lo = 0, hi = sortedScores.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (sortedScores[m] >= actual) lo = m + 1; else hi = m; }
  const rank = Math.max(1, lo);
  const pay = rank <= payoutTable.length ? payoutTable[rank - 1] : 0;
  if (pay <= 0) return 0;
  let co = 0;
  for (const e of actuals.entries) if (Math.abs(e.actualPoints - actual) <= 0.25) co++;
  co = Math.max(0, co - 1);
  return pay / Math.sqrt(1 + co * 0.5);
}

function spearman(x: number[], y: number[]): number {
  // rank-based correlation
  if (x.length !== y.length || x.length === 0) return 0;
  const rank = (arr: number[]): number[] => {
    const idx = arr.map((_, i) => i).sort((a, b) => arr[a] - arr[b]);
    const r = new Array(arr.length);
    for (let i = 0; i < idx.length; i++) r[idx[i]] = i + 1;
    return r;
  };
  const rx = rank(x), ry = rank(y);
  const n = x.length;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += rx[i]; my += ry[i]; }
  mx /= n; my /= n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
}

async function main() {
  console.log('================================================================');
  console.log(`MLB RANK + CLUMPING DIAGNOSTIC — prod-λ${LAMBDA}, γ=${GAMMA}`);
  console.log('================================================================\n');

  console.log('Slate      | Top-5 by actual payout — their ranks by {proj, proj+λ*combo, ceiling, own}');
  console.log('-'.repeat(110));

  // Aggregate stats
  let sumSpearmanProj = 0, sumSpearmanScore = 0, sumSpearmanCeil = 0, sumSpearmanOwn = 0, nSlates = 0;
  const aggTopActualProjRank: number[] = [];      // for top-5 by actual, where in proj rank
  const aggTopActualScoreRank: number[] = [];
  const aggTopActualCeilRank: number[] = [];
  const aggTopActualOwnRank: number[] = [];
  const aggMeanOverlap: number[] = [];
  const aggMaxOverlap: number[] = [];
  const aggMedianOverlap: number[] = [];
  const aggEffectiveLineups: number[] = [];

  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj);
    const actualsPath = path.join(DIR, s.actuals);
    const poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) continue;
    try {
      const pr = parseCSVFile(projPath, 'mlb', true);
      const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
      const pool = buildPlayerPool(pr.players, pr.detectedContestType);
      const actuals = parseContestActuals(actualsPath, config);
      const idMap = new Map<string, Player>();
      const nameMap = new Map<string, Player>();
      for (const p of pool.players) { idMap.set(p.id, p); nameMap.set(norm(p.name), p); }
      const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
      const comboFreq = precomputeComboFrequencies(loaded.lineups, 3);
      const F = actuals.entries.length;
      const sorted = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
      const payoutTable = buildPayoutTable(F);
      const actualByHash = new Map<string, number>();
      for (const e of actuals.entries) {
        const pls: Player[] = [];
        let ok = true;
        for (const nm of e.playerNames) {
          const p = nameMap.get(norm(nm));
          if (!p) { ok = false; break; }
          pls.push(p);
        }
        if (!ok) continue;
        actualByHash.set(pls.map(p => p.id).sort().join('|'), e.actualPoints);
      }

      const result = productionSelect(loaded.lineups, pool.players, {
        N, lambda: LAMBDA, comboFreq, maxOverlap: GAMMA,
      });
      const portfolio = result.portfolio;
      if (portfolio.length < 50) { console.log(`${s.slate}: portfolio too small`); continue; }

      // Compute per-lineup metrics + actuals
      const lus = portfolio.map((lu, idx) => {
        const own = lu.players.reduce((acc, p) => acc + (p.ownership || 0), 0) / lu.players.length;
        const cb = comboBonus(lu, comboFreq);
        const proj = lu.projection;
        const score = proj + LAMBDA * cb;
        let ceil = 0;
        for (const p of lu.players) {
          const pct = (p as any).percentiles;
          ceil += pct && pct['95'] ? pct['95'] : proj * 1.2;
        }
        const actual = scoreLineup(lu, actuals, actualByHash);
        const payout = actual !== null ? payoutFor(actual, sorted, payoutTable, actuals) : 0;
        return { idx, lu, proj, cb, score, ceil, own, actual: actual ?? 0, payout, actualKnown: actual !== null };
      });

      // Filter to scored lineups only
      const scored = lus.filter(x => x.actualKnown);
      if (scored.length < 50) { console.log(`${s.slate}: too few scored lineups`); continue; }

      // Rank by each metric (1 = best)
      const rankBy = (key: keyof typeof scored[0]): Map<number, number> => {
        const s2 = [...scored].sort((a, b) => (b[key] as number) - (a[key] as number));
        const m = new Map<number, number>();
        for (let r = 0; r < s2.length; r++) m.set(s2[r].idx, r + 1);
        return m;
      };
      const rProj = rankBy('proj');
      const rScore = rankBy('score');
      const rCeil = rankBy('ceil');
      const rOwnAsc = (() => {
        const s2 = [...scored].sort((a, b) => a.own - b.own); // lowest own = rank 1 (most contrarian)
        const m = new Map<number, number>();
        for (let r = 0; r < s2.length; r++) m.set(s2[r].idx, r + 1);
        return m;
      })();
      const rActual = rankBy('actual');
      const rPayout = rankBy('payout');

      // Spearman: our scoring vs actual
      const xs = scored.map(x => x.score);
      const ys = scored.map(x => x.actual);
      const zs = scored.map(x => x.payout);
      const sP = spearman(scored.map(x => x.proj), ys);
      const sS = spearman(xs, ys);
      const sC = spearman(scored.map(x => x.ceil), ys);
      const sO = spearman(scored.map(x => x.own), ys);
      const sSPay = spearman(xs, zs);
      sumSpearmanProj += sP; sumSpearmanScore += sS; sumSpearmanCeil += sC; sumSpearmanOwn += sO;

      // Top-5 by actual payout: where do they rank on our metric?
      const top5ByPay = [...scored].sort((a, b) => b.payout - a.payout).slice(0, 5);
      const top5Info = top5ByPay.map(t => ({
        payout: t.payout, actual: t.actual,
        projRank: rProj.get(t.idx) || 0,
        scoreRank: rScore.get(t.idx) || 0,
        ceilRank: rCeil.get(t.idx) || 0,
        ownRank: rOwnAsc.get(t.idx) || 0,
      }));
      for (const t of top5Info) {
        aggTopActualProjRank.push(t.projRank);
        aggTopActualScoreRank.push(t.scoreRank);
        aggTopActualCeilRank.push(t.ceilRank);
        aggTopActualOwnRank.push(t.ownRank);
      }

      // Compact print
      const summary = top5Info.filter(t => t.payout > 0).map(t => `$${t.payout.toFixed(0)}(p${t.projRank}/s${t.scoreRank}/c${t.ceilRank}/oLow${t.ownRank})`).join(' ');
      console.log(`${s.slate.padEnd(10)} | ${summary || '(no payout)'}`);

      nSlates++;

      // =============== CLUMPING ===============
      // Pairwise overlap
      const pidSets = scored.map(x => new Set(x.lu.players.map(p => p.id)));
      const overlaps: number[] = [];
      let maxOv = 0, sumOv = 0, pairs = 0;
      for (let i = 0; i < pidSets.length; i++) {
        for (let j = i + 1; j < pidSets.length; j++) {
          let ov = 0;
          for (const id of pidSets[i]) if (pidSets[j].has(id)) ov++;
          overlaps.push(ov);
          if (ov > maxOv) maxOv = ov;
          sumOv += ov;
          pairs++;
        }
      }
      const meanOv = pairs > 0 ? sumOv / pairs : 0;
      overlaps.sort((a, b) => a - b);
      const medianOv = overlaps[Math.floor(overlaps.length / 2)];
      aggMeanOverlap.push(meanOv);
      aggMaxOverlap.push(maxOv);
      aggMedianOverlap.push(medianOv);

      // Player exposure
      const expo = new Map<string, { name: string; count: number }>();
      for (const x of scored) {
        for (const p of x.lu.players) {
          const k = p.id;
          if (!expo.has(k)) expo.set(k, { name: p.name, count: 0 });
          expo.get(k)!.count++;
        }
      }
      const top10 = [...expo.values()].sort((a, b) => b.count - a.count).slice(0, 10);

      // Effective lineups: Gini-style (1 - sum p^2) where p = fraction at each pairwise overlap bucket
      // simpler: count pairs with overlap >= 8 vs <= 4 as extremes
      let highOverlap = 0, lowOverlap = 0;
      for (const o of overlaps) {
        if (o >= 8) highOverlap++;
        else if (o <= 4) lowOverlap++;
      }
      const pctHigh = pairs > 0 ? highOverlap / pairs : 0;
      const pctLow = pairs > 0 ? lowOverlap / pairs : 0;
      // Effective lineups: 1 / sum(pairwise normalized overlap) crude estimator
      const effective = pairs > 0 ? Math.max(1, scored.length * (1 - meanOv / 10)) : 0;
      aggEffectiveLineups.push(effective);
    } catch (e: any) {
      console.log(`${s.slate}: ERROR ${e.message}`);
    }
  }

  console.log('\n================ RANK CORRELATION (SPEARMAN) ================\n');
  console.log(`Across ${nSlates} slates:`);
  console.log(`  mean Spearman(projection, actual):      ${(sumSpearmanProj / nSlates).toFixed(3)}`);
  console.log(`  mean Spearman(score = proj+λ*cb, actual): ${(sumSpearmanScore / nSlates).toFixed(3)}`);
  console.log(`  mean Spearman(ceiling, actual):          ${(sumSpearmanCeil / nSlates).toFixed(3)}`);
  console.log(`  mean Spearman(ownership, actual):        ${(sumSpearmanOwn / nSlates).toFixed(3)}  (low own = more contrarian)`);
  console.log('\n  A correlation near 0 means our ordering is ~uncorrelated with actual performance.');
  console.log('  Negative = our "highest rank" lineups underperform.');

  console.log('\n================ TOP-5 BY ACTUAL PAYOUT — RANK DISTRIBUTION ================\n');
  const mean = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const median = (arr: number[]) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] || 0; };
  console.log(`Rank within our 150, where 1 = top of that metric. Lower = we'd have picked it.`);
  console.log(`  proj rank:      mean=${mean(aggTopActualProjRank).toFixed(1)}, median=${median(aggTopActualProjRank)}`);
  console.log(`  score rank:     mean=${mean(aggTopActualScoreRank).toFixed(1)}, median=${median(aggTopActualScoreRank)}`);
  console.log(`  ceiling rank:   mean=${mean(aggTopActualCeilRank).toFixed(1)}, median=${median(aggTopActualCeilRank)}`);
  console.log(`  own-ASC rank:   mean=${mean(aggTopActualOwnRank).toFixed(1)}, median=${median(aggTopActualOwnRank)}  (1 = most contrarian)`);
  console.log(`\n  If mean/median is near 75 (portfolio midpoint), our ranking is useless for finding winners.`);
  console.log(`  If mean is < 30, our top-by-metric picks ARE the actual winners.`);

  // Quartile breakdown of top-actual placements
  const buckets = (arr: number[]) => {
    const b = { q1: 0, q2: 0, q3: 0, q4: 0 };
    for (const r of arr) {
      if (r <= 38) b.q1++;
      else if (r <= 75) b.q2++;
      else if (r <= 112) b.q3++;
      else b.q4++;
    }
    return b;
  };
  const bProj = buckets(aggTopActualProjRank);
  const bScore = buckets(aggTopActualScoreRank);
  const bCeil = buckets(aggTopActualCeilRank);
  console.log(`\n  Quartile split of top-5-by-actual placements:`);
  console.log(`              Q1(1-38) Q2(39-75) Q3(76-112) Q4(113-150)`);
  console.log(`  proj-rank:  ${String(bProj.q1).padStart(5)}   ${String(bProj.q2).padStart(5)}     ${String(bProj.q3).padStart(5)}      ${String(bProj.q4).padStart(5)}`);
  console.log(`  score-rank: ${String(bScore.q1).padStart(5)}   ${String(bScore.q2).padStart(5)}     ${String(bScore.q3).padStart(5)}      ${String(bScore.q4).padStart(5)}`);
  console.log(`  ceil-rank:  ${String(bCeil.q1).padStart(5)}   ${String(bCeil.q2).padStart(5)}     ${String(bCeil.q3).padStart(5)}      ${String(bCeil.q4).padStart(5)}`);

  console.log('\n================ CLUMPING ================\n');
  console.log(`Pairwise overlap (10 players per lineup, γ=${GAMMA} cap):`);
  console.log(`  mean overlap per slate:   ${(mean(aggMeanOverlap)).toFixed(2)} players / pair`);
  console.log(`  median overlap per slate: ${(mean(aggMedianOverlap)).toFixed(2)}`);
  console.log(`  max overlap per slate:    ${(mean(aggMaxOverlap)).toFixed(2)} (should be ≤ ${GAMMA} if cap enforced)`);
  console.log(`\n  Effective-unique estimate: ${mean(aggEffectiveLineups).toFixed(1)} of 150 lineups`);
  console.log(`  (Interpretation: higher = less clumped. 150 = all fully distinct.)`);
}

main().catch(e => { console.error(e); process.exit(1); });
