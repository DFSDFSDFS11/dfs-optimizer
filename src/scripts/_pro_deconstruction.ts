/**
 * Pro Deconstruction — 5 analyses on 17+ MLB slates × 7 named pros.
 *
 * #1 Stack-shape distribution: categorize each lineup by exact shape (5+3, 5+2+1, 4+4, ...)
 *    and compare distribution across pros + portfolio entropy.
 *
 * #2 Within-portfolio top-spike vs core: partition each pro's 150 lineups into top-10%
 *    by actual pts and bottom-50%. Compare structural metrics between tiers.
 *
 * #4 Conditional player Jaccard: per pro, for each player A with ≥30% exposure,
 *    compute P(B | A). Find pairs where pros are deterministic.
 *
 * #6 Lineup-pair structural distance: per pro, distribution of pairwise distances
 *    (overlap-based). Pro distributions probably bimodal (clusters + spikes).
 *
 * #7 Pro-vs-pro exposure disagreement: per player per slate, exposure variance across
 *    pros. Identifies "split decision" players and bounds achievable matching.
 *
 * Output: structured Markdown report to argus_v9_research/pro_deconstruction.md
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import {
  parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestEntry,
} from '../parser';
import { getContestConfig } from '../rules';

const DIR = 'C:/Users/colin/dfs opto';
const OUT_DIR = path.join(DIR, 'multi_combo_penalty_implementation');

const SLATES = [
  { slate: '4-6-26',  proj: '4-6-26_projections.csv', actuals: 'dkactuals 4-6-26.csv',     pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26',  proj: '4-8-26projections.csv',  actuals: '4-8-26actuals.csv',        pool: '4-8-26sspool.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv', actuals: '4-12-26actuals.csv',       pool: '4-12-26sspool.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv', actuals: '4-14-26actuals.csv',       pool: '4-14-26sspool.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv', actuals: '4-15-26actuals.csv',       pool: '4-15-26sspool.csv' },
  { slate: '4-17-26', proj: '4-17-26projections.csv', actuals: '4-17-26actuals.csv',       pool: '4-17-26sspool.csv' },
  { slate: '4-18-26', proj: '4-18-26projections.csv', actuals: '4-18-26actuals.csv',       pool: '4-18-26sspool.csv' },
  { slate: '4-19-26', proj: '4-19-26projections.csv', actuals: '4-19-26actuals.csv',       pool: '4-19-26sspool.csv' },
  { slate: '4-20-26', proj: '4-20-26projections.csv', actuals: '4-20-26actuals.csv',       pool: '4-20-26sspool.csv' },
  { slate: '4-21-26', proj: '4-21-26projections.csv', actuals: '4-21-26actuals.csv',       pool: '4-21-26sspool.csv' },
  { slate: '4-22-26', proj: '4-22-26projections.csv', actuals: '4-22-26actuals.csv',       pool: '4-22-26sspool.csv' },
  { slate: '4-23-26', proj: '4-23-26projections.csv', actuals: '4-23-26actuals.csv',       pool: '4-23-26sspool.csv' },
  { slate: '4-24-26', proj: '4-24-26projections.csv', actuals: '4-24-26actuals.csv',       pool: '4-24-26sspool.csv' },
  { slate: '4-25-26', proj: '4-25-26projections.csv', actuals: '4-25-26actuals.csv',       pool: '4-25-26sspool.csv' },
  { slate: '4-25-26-early', proj: '4-25-26projectionsearly.csv', actuals: '4-25-26actualsearly.csv', pool: '4-25-26sspoolearly.csv' },
  { slate: '4-26-26', proj: '4-26-26projections.csv', actuals: '4-26-26actuals.csv',       pool: '4-26-26sspool.csv' },
  { slate: '4-27-26', proj: '4-27-26projections.csv', actuals: '4-27-26actuals.csv',       pool: '4-27-26sspool.csv' },
  { slate: '4-28-26', proj: '4-28-26projections.csv', actuals: '4-28-26actuals.csv',       pool: '4-28-26sspool.csv' },
  { slate: '4-29-26', proj: '4-29-26projections.csv', actuals: '4-29-26actuals.csv',       pool: '4-29-26sspool.csv' },
  { slate: '5-3-26',  proj: '5-3-26projections.csv',  actuals: '5-3-26actuals.csv',        pool: '5-3-26sspool.csv' },
  { slate: '5-5-26',  proj: '5-5-26projections.csv',  actuals: '5-5-26actuals.csv',        pool: '5-5-26sspool.csv' },
  { slate: '5-6-26',  proj: '5-6-26projections.csv',  actuals: '5-6-26actuals.csv',        pool: '5-6-26sspool.csv' },
  { slate: '5-8-26',  proj: '5-8-26projections.csv',  actuals: '5-8-26actuals.csv',        pool: '5-8-26sspool.csv' },
  { slate: '5-10-26', proj: '5-10-26projections.csv', actuals: '5-10-26actuals.csv',       pool: '5-10-26sspool.csv' },
  { slate: '5-10-26-late', proj: '5-10-26projectionslate.csv', actuals: '5-10-26actualslate.csv', pool: '5-10-26sspoollate.csv' },
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

// ===== utilities =====

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function extractUser(entryName: string): string { return (entryName || '').replace(/\s*\([^)]*\)\s*$/, '').trim(); }
function isPitcher(p: Player): boolean { return (p.position || '').toUpperCase().includes('P'); }
function mean(a: number[]): number { if (!a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; }
function stddev(a: number[]): number { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); }
function median(a: number[]): number { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }
function quantile(a: number[], q: number): number { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; }

function entropy(probs: number[]): number {
  let h = 0;
  for (const p of probs) if (p > 0) h -= p * Math.log2(p);
  return h;
}

function jsDivergence(p: number[], q: number[]): number {
  // Jensen-Shannon (symmetric, bounded). Inputs assumed same length and sum 1.
  let kl_pm = 0, kl_qm = 0;
  for (let i = 0; i < p.length; i++) {
    const m = 0.5 * (p[i] + q[i]);
    if (p[i] > 0 && m > 0) kl_pm += p[i] * Math.log2(p[i] / m);
    if (q[i] > 0 && m > 0) kl_qm += q[i] * Math.log2(q[i] / m);
  }
  return 0.5 * (kl_pm + kl_qm);
}

// ===== stack-shape classification =====

function stackShape(players: Player[]): string {
  // Count hitters per team (pitchers excluded).
  const teamCounts = new Map<string, number>();
  for (const p of players) {
    if (isPitcher(p)) continue;
    const t = (p.team || '').toUpperCase();
    if (!t) continue;
    teamCounts.set(t, (teamCounts.get(t) || 0) + 1);
  }
  const sizes = [...teamCounts.values()].sort((a, b) => b - a);
  return sizes.join('+') || 'unknown';
}

// ===== structural distance =====

function structuralDistance(luA: Player[], luB: Player[]): number {
  // Player overlap as primary signal (Jaccard distance), + shape mismatch bonus.
  const idsA = new Set(luA.map(p => p.id));
  const idsB = new Set(luB.map(p => p.id));
  let inter = 0;
  for (const id of idsA) if (idsB.has(id)) inter++;
  const union = idsA.size + idsB.size - inter;
  const jaccDist = union > 0 ? 1 - (inter / union) : 1;
  // Shape diff component (0 if identical shape, 0.5 if completely different).
  const shapeA = stackShape(luA);
  const shapeB = stackShape(luB);
  const shapeDiff = shapeA === shapeB ? 0 : 0.5;
  // Salary diff component (normalized).
  const salA = luA.reduce((s, p) => s + p.salary, 0);
  const salB = luB.reduce((s, p) => s + p.salary, 0);
  const salDiff = Math.abs(salA - salB) / 50000;
  return jaccDist + 0.3 * shapeDiff + 0.2 * salDiff;
}

// ===== main =====

interface ProLineup {
  pro: string;
  slate: string;
  players: Player[];
  actualPts: number;
  rank: number;       // rank within full contest
  fieldSize: number;
}

async function main() {
  console.log('================================================================');
  console.log('PRO DECONSTRUCTION — 5 deep analyses on 17+ slates × 7 pros');
  console.log('================================================================\n');

  // Per-pro, per-slate accumulators.
  const proLineups: Map<string, ProLineup[]> = new Map();
  for (const pro of PROS) proLineups.set(pro.label, []);
  // Per-slate, per-player exposure within each pro (for #7 disagreement).
  const slateProPlayerExposure: Map<string, Map<string, Map<string, number>>> = new Map();
  // slate -> pro -> playerName -> exposure (0..1)

  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj);
    const actualsPath = path.join(DIR, s.actuals);
    const poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) { console.log(`skip ${s.slate}`); continue; }

    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);
    const nameMap = new Map<string, Player>();
    for (const p of pool.players) nameMap.set(norm(p.name), p);

    const F = actuals.entries.length;
    const sortedPts = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);

    // Group entries by user.
    const byUser = new Map<string, ContestEntry[]>();
    for (const e of actuals.entries) {
      const u = extractUser(e.entryName);
      const arr = byUser.get(u); if (arr) arr.push(e); else byUser.set(u, [e]);
    }

    const slateExposure: Map<string, Map<string, number>> = new Map();
    slateProPlayerExposure.set(s.slate, slateExposure);

    for (const pro of PROS) {
      // Find this pro's entries by token match.
      let matchedEntries: ContestEntry[] = [];
      for (const [u, ents] of byUser) {
        for (const tok of pro.tokens) {
          if (u.toLowerCase().includes(tok)) {
            matchedEntries = matchedEntries.concat(ents);
            break;
          }
        }
      }
      if (matchedEntries.length < 100) continue;
      // Cap at 150 to compare apples-to-apples.
      const entries = matchedEntries.slice(0, 150);

      const proLus: ProLineup[] = [];
      const playerCount = new Map<string, number>();
      let usedEntries = 0;
      for (const e of entries) {
        const pls: Player[] = []; let ok = true;
        for (const n of e.playerNames) { const p = nameMap.get(norm(n)); if (!p) { ok = false; break; } pls.push(p); }
        if (!ok) continue;
        usedEntries++;
        // Rank in field.
        let lo = 0, hi = sortedPts.length;
        while (lo < hi) { const mid = (lo + hi) >>> 1; if (sortedPts[mid] > e.actualPoints) lo = mid + 1; else hi = mid; }
        const rank = lo + 1;
        proLus.push({ pro: pro.label, slate: s.slate, players: pls, actualPts: e.actualPoints, rank, fieldSize: F });
        for (const p of pls) playerCount.set(p.name, (playerCount.get(p.name) || 0) + 1);
      }
      if (proLus.length < 100) continue;
      proLineups.get(pro.label)!.push(...proLus);
      const expMap = new Map<string, number>();
      for (const [n, c] of playerCount) expMap.set(n, c / usedEntries);
      slateExposure.set(pro.label, expMap);
    }
  }

  // Summary of data loaded.
  for (const pro of PROS) {
    const lus = proLineups.get(pro.label)!;
    console.log(`  ${pro.label.padEnd(16)} ${lus.length} lineups across ${new Set(lus.map(l => l.slate)).size} slates`);
  }

  const lines: string[] = [];
  lines.push('# Pro Deconstruction Report');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Slates: ${SLATES.length} | Pros: ${PROS.length}\n`);

  // ============================================================
  // #1 Stack-shape distribution
  // ============================================================
  console.log('\n=== #1 Stack-shape distributions ===');
  lines.push('## #1 Stack-Shape Distribution Per Pro\n');
  const allShapes = new Set<string>();
  const shapeDistByPro = new Map<string, Map<string, number>>();
  for (const pro of PROS) {
    const lus = proLineups.get(pro.label)!;
    if (!lus.length) continue;
    const dist = new Map<string, number>();
    for (const lu of lus) {
      const sh = stackShape(lu.players);
      dist.set(sh, (dist.get(sh) || 0) + 1);
      allShapes.add(sh);
    }
    shapeDistByPro.set(pro.label, dist);
  }
  // Identify top-10 shapes by total count across pros.
  const shapeTotalCount = new Map<string, number>();
  for (const dist of shapeDistByPro.values()) {
    for (const [sh, c] of dist) shapeTotalCount.set(sh, (shapeTotalCount.get(sh) || 0) + c);
  }
  const topShapes = [...shapeTotalCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(x => x[0]);

  // Print table.
  lines.push('|        pro       | ' + topShapes.join(' | ') + ' | entropy |');
  lines.push('|---|' + topShapes.map(() => '---').join('|') + '|---|');
  for (const pro of PROS) {
    const dist = shapeDistByPro.get(pro.label);
    if (!dist) continue;
    const totalCount = [...dist.values()].reduce((s, c) => s + c, 0);
    const probs = topShapes.map(sh => (dist.get(sh) || 0) / totalCount);
    const rest = 1 - probs.reduce((s, p) => s + p, 0);
    const fullProbs = [...probs, rest];
    const ent = entropy(fullProbs);
    lines.push(`| ${pro.label.padEnd(15)} | ` + probs.map(p => (p * 100).toFixed(1) + '%').join(' | ') + ` | ${ent.toFixed(2)} |`);
    console.log(`  ${pro.label.padEnd(16)} entropy=${ent.toFixed(2)} top shape: ${topShapes[probs.indexOf(Math.max(...probs))]} ${(Math.max(...probs) * 100).toFixed(0)}%`);
  }

  // Cross-pro JS divergence.
  lines.push('\n### Cross-pro JS divergence (shape distribution)\n');
  lines.push('|          | ' + PROS.map(p => p.label).join(' | ') + ' |');
  lines.push('|---|' + PROS.map(() => '---').join('|') + '|');
  for (const a of PROS) {
    const distA = shapeDistByPro.get(a.label);
    if (!distA) continue;
    const totA = [...distA.values()].reduce((s, c) => s + c, 0);
    const probsA = topShapes.map(sh => (distA.get(sh) || 0) / totA);
    probsA.push(1 - probsA.reduce((s, p) => s + p, 0));
    const row = [a.label];
    for (const b of PROS) {
      const distB = shapeDistByPro.get(b.label);
      if (!distB) { row.push('--'); continue; }
      const totB = [...distB.values()].reduce((s, c) => s + c, 0);
      const probsB = topShapes.map(sh => (distB.get(sh) || 0) / totB);
      probsB.push(1 - probsB.reduce((s, p) => s + p, 0));
      row.push(jsDivergence(probsA, probsB).toFixed(3));
    }
    lines.push('| ' + row.join(' | ') + ' |');
  }

  // ============================================================
  // #2 Top-spike vs Core decomposition
  // ============================================================
  console.log('\n=== #2 Top-spike vs Core (within-portfolio) ===');
  lines.push('\n## #2 Top-Spike vs Core Decomposition\n');
  lines.push('Each pro\'s lineups split into top-10% by actual pts vs bottom-50%.');
  lines.push('Stats: avg ownership, avg projection, avg salary, dominant stack-shape.\n');
  lines.push('|        pro       | tier  | n   | avgPts | avgProj | avgOwn | avgSal | topShape | shapeEntropy |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const pro of PROS) {
    const lus = proLineups.get(pro.label)!;
    if (lus.length < 20) continue;
    // Group by slate first, then take top/bottom within each slate.
    const bySlate = new Map<string, ProLineup[]>();
    for (const lu of lus) { const arr = bySlate.get(lu.slate); if (arr) arr.push(lu); else bySlate.set(lu.slate, [lu]); }
    const topLus: ProLineup[] = []; const botLus: ProLineup[] = [];
    for (const slateLus of bySlate.values()) {
      const sorted = [...slateLus].sort((a, b) => b.actualPts - a.actualPts);
      const t = Math.max(1, Math.floor(sorted.length * 0.1));
      const b = Math.max(1, Math.floor(sorted.length * 0.5));
      topLus.push(...sorted.slice(0, t));
      botLus.push(...sorted.slice(-b));
    }
    function tierStats(tierLus: ProLineup[]) {
      const own = tierLus.map(l => mean(l.players.map(p => p.ownership || 0)));
      const proj = tierLus.map(l => l.players.reduce((s, p) => s + (p.projection || 0), 0));
      const sal = tierLus.map(l => l.players.reduce((s, p) => s + (p.salary || 0), 0));
      const shapes = tierLus.map(l => stackShape(l.players));
      const shapeCount = new Map<string, number>();
      for (const sh of shapes) shapeCount.set(sh, (shapeCount.get(sh) || 0) + 1);
      const topShape = [...shapeCount.entries()].sort((a, b) => b[1] - a[1])[0];
      const total = shapes.length;
      const probs = [...shapeCount.values()].map(c => c / total);
      return { meanOwn: mean(own), meanProj: mean(proj), meanSal: mean(sal), topShape: topShape ? `${topShape[0]}(${(topShape[1] / total * 100).toFixed(0)}%)` : '-', ent: entropy(probs) };
    }
    const t = tierStats(topLus);
    const b = tierStats(botLus);
    const tPts = mean(topLus.map(l => l.actualPts));
    const bPts = mean(botLus.map(l => l.actualPts));
    lines.push(`| ${pro.label.padEnd(15)} | top10 | ${topLus.length} | ${tPts.toFixed(1)} | ${t.meanProj.toFixed(1)} | ${t.meanOwn.toFixed(1)}% | $${t.meanSal.toFixed(0)} | ${t.topShape} | ${t.ent.toFixed(2)} |`);
    lines.push(`| ${pro.label.padEnd(15)} | bot50 | ${botLus.length} | ${bPts.toFixed(1)} | ${b.meanProj.toFixed(1)} | ${b.meanOwn.toFixed(1)}% | $${b.meanSal.toFixed(0)} | ${b.topShape} | ${b.ent.toFixed(2)} |`);
    console.log(`  ${pro.label.padEnd(16)} top10:${tPts.toFixed(0)}pts own${t.meanOwn.toFixed(1)}%  bot50:${bPts.toFixed(0)}pts own${b.meanOwn.toFixed(1)}%  Δown=${(t.meanOwn - b.meanOwn).toFixed(1)}pp`);
  }

  // ============================================================
  // #4 Conditional player Jaccard
  // ============================================================
  console.log('\n=== #4 Conditional player Jaccard ===');
  lines.push('\n## #4 Conditional Player Jaccard\n');
  lines.push('For each pro, players with ≥30% exposure across their full portfolio (within slate),');
  lines.push('show top-3 conditional companions (P(B in lineup | A in lineup)).\n');
  for (const pro of PROS) {
    const lus = proLineups.get(pro.label)!;
    if (lus.length < 30) continue;
    lines.push(`### ${pro.label}`);
    // Within-slate conditional analysis.
    const bySlate = new Map<string, ProLineup[]>();
    for (const lu of lus) { const arr = bySlate.get(lu.slate); if (arr) arr.push(lu); else bySlate.set(lu.slate, [lu]); }
    // Aggregate across slates: anchor = player, companion = player; count co-occurrence.
    const anchorExposure = new Map<string, number>();   // anchor -> total lineups containing
    const pairCount = new Map<string, number>();        // anchor|companion -> count
    const totalLus = lus.length;
    for (const lu of lus) {
      const names = lu.players.map(p => p.name);
      for (const a of names) anchorExposure.set(a, (anchorExposure.get(a) || 0) + 1);
      for (const a of names) for (const b of names) {
        if (a === b) continue;
        const k = a + '||' + b;
        pairCount.set(k, (pairCount.get(k) || 0) + 1);
      }
    }
    // Anchors with ≥30% exposure.
    const anchors = [...anchorExposure.entries()].filter(([_, c]) => c >= 0.3 * totalLus).sort((a, b) => b[1] - a[1]).slice(0, 5);
    lines.push('| anchor (exposure) | top-3 P(B \\| A) |');
    lines.push('|---|---|');
    for (const [anchor, ac] of anchors) {
      const companions: { name: string; cond: number }[] = [];
      for (const b of anchorExposure.keys()) {
        if (b === anchor) continue;
        const c = pairCount.get(anchor + '||' + b) || 0;
        if (c < 3) continue;
        companions.push({ name: b, cond: c / ac });
      }
      companions.sort((x, y) => y.cond - x.cond);
      const top3 = companions.slice(0, 3).map(x => `${x.name} ${(x.cond * 100).toFixed(0)}%`).join('; ');
      lines.push(`| ${anchor} (${(ac / totalLus * 100).toFixed(0)}%) | ${top3} |`);
    }
    lines.push('');
  }

  // ============================================================
  // #6 Structural distance distribution
  // ============================================================
  console.log('\n=== #6 Lineup-pair structural distance distribution ===');
  lines.push('\n## #6 Lineup-Pair Structural Distance Distribution\n');
  lines.push('Pairwise distance = Jaccard-of-players + shape-mismatch + salary-diff.');
  lines.push('Pros with bimodal distributions (clusters + spikes) are doing Paes-Leme variance concentration.\n');
  lines.push('|        pro       | sampleN | dist_p10 | p25 | p50 | p75 | p90 | sd | bimodality* |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const pro of PROS) {
    const lus = proLineups.get(pro.label)!;
    if (lus.length < 50) continue;
    // Group by slate to avoid cross-slate pairings (different player sets).
    const bySlate = new Map<string, ProLineup[]>();
    for (const lu of lus) { const arr = bySlate.get(lu.slate); if (arr) arr.push(lu); else bySlate.set(lu.slate, [lu]); }
    const dists: number[] = [];
    for (const slateLus of bySlate.values()) {
      // Sample pairs to keep computation tractable.
      const n = slateLus.length;
      const sampleSize = Math.min(500, (n * (n - 1)) / 2);
      let attempts = 0;
      const seen = new Set<string>();
      while (dists.length % 500 < sampleSize && attempts < sampleSize * 4) {
        attempts++;
        const i = Math.floor(Math.random() * n);
        const j = Math.floor(Math.random() * n);
        if (i === j) continue;
        const k = Math.min(i, j) + '_' + Math.max(i, j);
        if (seen.has(k)) continue;
        seen.add(k);
        dists.push(structuralDistance(slateLus[i].players, slateLus[j].players));
        if (seen.size >= sampleSize) break;
      }
    }
    if (!dists.length) continue;
    // Bimodality: ratio of |p10 - p50| / |p50 - p90|. > 0.7 hints at structure.
    const p10 = quantile(dists, 0.1), p25 = quantile(dists, 0.25), p50 = quantile(dists, 0.5);
    const p75 = quantile(dists, 0.75), p90 = quantile(dists, 0.9);
    const sd = stddev(dists);
    const lowRange = Math.abs(p10 - p50);
    const highRange = Math.abs(p50 - p90);
    const bimodality = highRange > 1e-6 ? (lowRange / highRange) : 0;
    lines.push(`| ${pro.label.padEnd(15)} | ${dists.length} | ${p10.toFixed(3)} | ${p25.toFixed(3)} | ${p50.toFixed(3)} | ${p75.toFixed(3)} | ${p90.toFixed(3)} | ${sd.toFixed(3)} | ${bimodality.toFixed(2)} |`);
    console.log(`  ${pro.label.padEnd(16)} n=${dists.length} p50=${p50.toFixed(2)} sd=${sd.toFixed(2)} bimodal=${bimodality.toFixed(2)}`);
  }
  lines.push('\n*bimodality = (p50-p10)/(p90-p50). Higher = more clustered/bimodal.');

  // ============================================================
  // #7 Pro-vs-pro exposure disagreement
  // ============================================================
  console.log('\n=== #7 Pro-vs-pro exposure disagreement ===');
  lines.push('\n## #7 Pro-vs-Pro Exposure Disagreement\n');
  lines.push('Per slate, per player: exposure variance across pros. High variance = "split decision" players.');
  lines.push('Aggregated across slates: which players consistently divide pros?\n');
  // Per-slate: player -> exposures-across-pros vector.
  interface DisagreementRow { player: string; slate: string; n_pros: number; exposures: number[]; mean: number; std: number; range: number; }
  const rows: DisagreementRow[] = [];
  for (const [slate, proMap] of slateProPlayerExposure) {
    if (proMap.size < 3) continue;
    const allPlayers = new Set<string>();
    for (const ex of proMap.values()) for (const p of ex.keys()) allPlayers.add(p);
    for (const player of allPlayers) {
      const exps: number[] = [];
      for (const ex of proMap.values()) exps.push(ex.get(player) || 0);
      if (exps.length < 3) continue;
      const m = mean(exps);
      if (m < 0.05) continue; // skip players no one is on
      const sd = stddev(exps);
      const range = Math.max(...exps) - Math.min(...exps);
      rows.push({ player, slate, n_pros: exps.length, exposures: exps, mean: m, std: sd, range });
    }
  }
  // Sort by range descending.
  rows.sort((a, b) => b.range - a.range);
  lines.push('### Top-25 split-decision player-slates (max-min exposure gap)\n');
  lines.push('| player | slate | n_pros | min | mean | max | range (pp) | std (pp) |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const r of rows.slice(0, 25)) {
    const minE = Math.min(...r.exposures);
    const maxE = Math.max(...r.exposures);
    lines.push(`| ${r.player} | ${r.slate} | ${r.n_pros} | ${(minE * 100).toFixed(0)}% | ${(r.mean * 100).toFixed(0)}% | ${(maxE * 100).toFixed(0)}% | ${(r.range * 100).toFixed(1)} | ${(r.std * 100).toFixed(1)} |`);
  }

  // Aggregate: median exposure range per slate (overall agreement level).
  const slateMedianRange = new Map<string, number>();
  for (const [slate, _] of slateProPlayerExposure) {
    const slateRows = rows.filter(r => r.slate === slate);
    if (slateRows.length < 5) continue;
    slateMedianRange.set(slate, median(slateRows.map(r => r.range)));
  }
  lines.push('\n### Median exposure-range per slate (smaller = pros agree more)\n');
  lines.push('| slate | median range (pp) | n players |');
  lines.push('|---|---|---|');
  for (const [slate, mr] of [...slateMedianRange.entries()].sort((a, b) => b[1] - a[1])) {
    const n = rows.filter(r => r.slate === slate).length;
    lines.push(`| ${slate} | ${(mr * 100).toFixed(1)} | ${n} |`);
  }

  // Bound on achievable matching: if pros disagree this much, what's the best match anyone can hit?
  const allRanges = rows.map(r => r.range);
  const meanRange = mean(allRanges);
  lines.push(`\nOverall: pros disagree on player exposure by **${(meanRange * 100).toFixed(1)}pp on average** (median ${(median(allRanges) * 100).toFixed(1)}pp).`);
  lines.push('This bounds achievable "matching" — Argus cannot match all pros simultaneously when they disagree by 20+pp.');

  // ============================================================
  // SAVE REPORT
  // ============================================================
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, 'pro_deconstruction.md');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`\nSaved: ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
