/**
 * MLB Hybrid V3 — add ceiling + variance + ceiling-gap signals.
 *
 * Anchored on Config B (λc=0.20, corner=true). Adds new mechanical signals:
 *   + λcl·(ceiling)                  // high-p95 sum
 *   + λg·(ceiling - projection)      // upside gap
 *   + λv·(worldVariance)             // per-world variance from precomp
 *
 * If no combo beats Config B ($54,869 full / $43,347 recent / $2,951 min-LOO)
 * then feature-combination space is exhausted and we should ship Config B.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import {
  parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals,
} from '../parser';
import { getContestConfig } from '../rules';
import {
  DEFAULT_SELECTOR_PARAMS, SelectorParams, defaultGamma, getSportDefaults, precomputeSlate,
} from '../selection/algorithm7-selector';
import { precomputeComboFrequencies, comboBonus } from '../selection/combo-leverage';
import { computeAnchor } from '../selection/anchor-relative';

const DIR = 'C:/Users/colin/dfs opto';
const OUT_MD = path.join(DIR, 'mlb_hybrid_v3.md');
const FEE = 20;
const N = 150;

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
const RECENT = new Set(['4-18-26', '4-19-26', '4-20-26', '4-21-26', '4-22-26']);

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function buildPayoutTable(F: number): Float64Array {
  const pool = F * FEE * 0.88; const cashLine = Math.floor(F * 0.22);
  const raw = new Float64Array(cashLine); let rawSum = 0;
  for (let r = 0; r < cashLine; r++) { raw[r] = Math.pow(r + 1, -1.15); rawSum += raw[r]; }
  const table = new Float64Array(F); const minCash = FEE * 1.2;
  for (let r = 0; r < cashLine; r++) table[r] = Math.max(minCash, (raw[r] / rawSum) * pool);
  let tSum = 0; for (let r = 0; r < cashLine; r++) tSum += table[r];
  const scale = pool / tSum;
  for (let r = 0; r < cashLine; r++) table[r] *= scale;
  return table;
}
function scoreLineup(lu: Lineup, actuals: ContestActuals, actualByHash: Map<string, number>): number | null {
  const h = lu.players.map(p => p.id).sort().join('|'); const fa = actualByHash.get(h);
  if (fa !== undefined) return fa;
  let t = 0; for (const p of lu.players) { const r = actuals.playerActualsByName.get(norm(p.name)); if (!r) return null; t += r.fpts; }
  return t;
}
function payoutFor(actual: number, sortedScores: number[], payoutTable: Float64Array, actuals: ContestActuals): number {
  let lo = 0, hi = sortedScores.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (sortedScores[m] >= actual) lo = m + 1; else hi = m; }
  const rank = Math.max(1, lo);
  const pay = rank <= payoutTable.length ? payoutTable[rank - 1] : 0;
  if (pay <= 0) return 0;
  let co = 0; for (const e of actuals.entries) if (Math.abs(e.actualPoints - actual) <= 0.25) co++;
  co = Math.max(0, co - 1);
  return pay / Math.sqrt(1 + co * 0.5);
}
function scorePortfolio(portfolio: Lineup[], actuals: ContestActuals, actualByHash: Map<string, number>, sorted: number[], payoutTable: Float64Array, top1Thresh: number) {
  let pay = 0, t1 = 0;
  for (const lu of portfolio) {
    const a = scoreLineup(lu, actuals, actualByHash);
    if (a === null) continue;
    pay += payoutFor(a, sorted, payoutTable, actuals);
    if (a >= top1Thresh) t1++;
  }
  return { pay, t1 };
}

interface SlateCache {
  slate: string; candidatePool: Lineup[]; players: Player[];
  actuals: ContestActuals; actualByHash: Map<string, number>;
  sorted: number[]; top1Thresh: number; payoutTable: Float64Array; F: number;
  anchor: ReturnType<typeof computeAnchor>;
  projection: Float64Array; combo: Float64Array;
  ceiling: Float64Array; variance: Float64Array; ceilGap: Float64Array;
  top01Cov: Float64Array; ownership: Float64Array; primaryTeam: string[]; pidSets: Set<string>[];
}

async function loadSlate(s: typeof SLATES[0]): Promise<SlateCache | null> {
  const projPath = path.join(DIR, s.proj); const actualsPath = path.join(DIR, s.actuals); const poolPath = path.join(DIR, s.pool);
  if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) return null;
  const pr = parseCSVFile(projPath, 'mlb', true);
  const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
  const pool = buildPlayerPool(pr.players, pr.detectedContestType);
  const actuals = parseContestActuals(actualsPath, config);
  const idMap = new Map<string, Player>(); const nameMap = new Map<string, Player>();
  for (const p of pool.players) { idMap.set(p.id, p); nameMap.set(norm(p.name), p); }
  const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
  const comboFreq = precomputeComboFrequencies(loaded.lineups, 3);
  const F = actuals.entries.length;
  const sorted = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
  const payoutTable = buildPayoutTable(F);
  const top1Thresh = sorted[Math.max(0, Math.floor(F * 0.01) - 1)] || 0;
  const actualByHash = new Map<string, number>();
  for (const e of actuals.entries) {
    const pls: Player[] = []; let ok = true;
    for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
    if (!ok) continue;
    actualByHash.set(pls.map(p => p.id).sort().join('|'), e.actualPoints);
  }
  const fieldLineups: Lineup[] = []; const seenH = new Set<string>();
  for (const e of actuals.entries) {
    const pls: Player[] = []; let ok = true;
    for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
    if (!ok) continue;
    const hash = pls.map(p => p.id).sort().join('|'); if (seenH.has(hash)) continue; seenH.add(hash);
    const sal = pls.reduce((s, p) => s + p.salary, 0); const proj = pls.reduce((s, p) => s + p.projection, 0);
    const own = pls.reduce((s, p) => s + (p.ownership || 0), 0) / pls.length;
    fieldLineups.push({ players: pls, salary: sal, projection: proj, ownership: own, hash });
  }
  const selParams: SelectorParams = {
    ...DEFAULT_SELECTOR_PARAMS, ...getSportDefaults('mlb'),
    N, gamma: defaultGamma(config.rosterSize), numWorlds: 1500,
  };
  const precomp = precomputeSlate(loaded.lineups, fieldLineups.length >= 100 ? fieldLineups : loaded.lineups, pool.players, selParams, 'mlb');

  const C = precomp.C; const W = precomp.W;
  const projection = new Float64Array(C);
  const combo = new Float64Array(C);
  const ceiling = new Float64Array(C);
  const variance = new Float64Array(C);
  const ceilGap = new Float64Array(C);
  const top01Cov = new Float64Array(C);
  const ownership = new Float64Array(C);
  const primaryTeam: string[] = new Array(C);
  const pidSets: Set<string>[] = new Array(C);

  for (let c = 0; c < C; c++) {
    const lu = precomp.candidatePool[c];
    projection[c] = lu.projection;
    combo[c] = comboBonus(lu, comboFreq);
    variance[c] = precomp.candidateVariance[c];
    // Ceiling = sum of player p95 percentiles (or 1.2*proj fallback)
    let ceil = 0;
    for (const p of lu.players) {
      const pct = (p as any).percentiles;
      ceil += pct && pct['95'] ? pct['95'] : p.projection * 1.2;
    }
    ceiling[c] = ceil;
    ceilGap[c] = ceil - lu.projection;
    // Top-1% coverage
    const base = c * W;
    let hits = 0;
    for (let w = 0; w < W; w++) if (precomp.candidateWorldScores[base + w] >= precomp.thresh1[w]) hits++;
    top01Cov[c] = hits / W;
    let ownSum = 0; for (const p of lu.players) ownSum += p.ownership || 0;
    ownership[c] = ownSum / lu.players.length;
    const tc = new Map<string, number>();
    for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
    let bt = '', bn = 0; for (const [t, n] of tc) if (n > bn) { bt = t; bn = n; }
    primaryTeam[c] = bt;
    pidSets[c] = new Set(lu.players.map(p => p.id));
  }
  const anchor = computeAnchor(loaded.lineups, 50);
  return {
    slate: s.slate, candidatePool: precomp.candidatePool, players: pool.players,
    actuals, actualByHash, sorted, top1Thresh, payoutTable, F, anchor,
    projection, combo, ceiling, variance, ceilGap, top01Cov, ownership, primaryTeam, pidSets,
  };
}

const OWN_BINS = [
  { label: 'chalk', deltaLo: -2, deltaHi: 99 },
  { label: 'core', deltaLo: -5, deltaHi: -2 },
  { label: 'value', deltaLo: -8, deltaHi: -5 },
  { label: 'contra', deltaLo: -12, deltaHi: -8 },
  { label: 'deep', deltaLo: -20, deltaHi: -12 },
];
const BIN_FRACTIONS: [number, number, number, number, number] = [0.10, 0.30, 0.35, 0.20, 0.05];

interface Cfg {
  lambdaCombo: number; lambdaCeiling: number; lambdaGap: number; lambdaVar: number; lambdaEmax: number;
  corner: boolean; floor: number;
}

function runHybrid(sd: SlateCache, cfg: Cfg): Lineup[] {
  const C = sd.candidatePool.length;
  const score = new Float64Array(C);
  for (let c = 0; c < C; c++) {
    score[c] = sd.projection[c]
      + cfg.lambdaCombo * sd.combo[c]
      + cfg.lambdaCeiling * (sd.ceiling[c] - sd.projection[c]) // ceiling-gap scaled from ceiling alone
      + cfg.lambdaGap * sd.ceilGap[c]
      + cfg.lambdaVar * Math.sqrt(sd.variance[c])
      + cfg.lambdaEmax * sd.top01Cov[c] * 100;
  }
  const optimalProj = sd.candidatePool.reduce((m, lu) => lu.projection > m ? lu.projection : m, 0);
  const floor = cfg.floor * optimalProj;

  type Meta = { c: number; lu: Lineup; own: number; proj: number; score: number; primaryTeam: string; pidSet: Set<string>; projQ: number; ownQ: number };
  let projQThresh: [number, number, number, number] = [0, 0, 0, 0];
  let ownQThresh: [number, number, number, number] = [0, 0, 0, 0];
  if (cfg.corner) {
    const p = [...sd.projection].sort((a, b) => a - b); const o = [...sd.ownership].sort((a, b) => a - b);
    const n = p.length;
    projQThresh = [p[Math.floor(n * 0.2)], p[Math.floor(n * 0.4)], p[Math.floor(n * 0.6)], p[Math.floor(n * 0.8)]];
    ownQThresh = [o[Math.floor(n * 0.2)], o[Math.floor(n * 0.4)], o[Math.floor(n * 0.6)], o[Math.floor(n * 0.8)]];
  }
  const projQ = (p: number) => p >= projQThresh[3] ? 4 : p >= projQThresh[2] ? 3 : p >= projQThresh[1] ? 2 : p >= projQThresh[0] ? 1 : 0;
  const ownQ = (o: number) => o >= ownQThresh[3] ? 4 : o >= ownQThresh[2] ? 3 : o >= ownQThresh[1] ? 2 : o >= ownQThresh[0] ? 1 : 0;

  const metas: Meta[] = [];
  for (let c = 0; c < C; c++) {
    if (cfg.floor > 0 && sd.projection[c] < floor) continue;
    metas.push({
      c, lu: sd.candidatePool[c], own: sd.ownership[c], proj: sd.projection[c], score: score[c],
      primaryTeam: sd.primaryTeam[c], pidSet: sd.pidSets[c],
      projQ: cfg.corner ? projQ(sd.projection[c]) : 0,
      ownQ: cfg.corner ? ownQ(sd.ownership[c]) : 0,
    });
  }
  const binned: Meta[][] = [[], [], [], [], []];
  for (const m of metas) {
    const delta = m.own - sd.anchor.ownership;
    for (let b = 0; b < OWN_BINS.length; b++) {
      if (delta >= OWN_BINS[b].deltaLo && delta < OWN_BINS[b].deltaHi) { binned[b].push(m); break; }
    }
  }
  for (const bin of binned) bin.sort((a, b) => b.score - a.score);
  const targets = BIN_FRACTIONS.map(f => Math.round(f * N));
  if (targets.reduce((a, b) => a + b, 0) !== N) targets[2] += N - targets.reduce((a, b) => a + b, 0);

  const selected: Lineup[] = []; const sPidSets: Set<string>[] = [];
  const playerCount = new Map<string, number>(); const teamCount = new Map<string, number>();
  let q5q5 = 0, q1q1 = 0;
  const q5Cap = Math.ceil(0.25 * N); const q1Cap = Math.ceil(0.05 * N);
  const teamCapN = Math.ceil(0.10 * N); const expCap = Math.ceil(0.40 * N);
  const canAdd = (m: Meta): boolean => {
    for (const p of m.lu.players) if ((playerCount.get(p.id) || 0) >= expCap) return false;
    if ((teamCount.get(m.primaryTeam) || 0) >= teamCapN) return false;
    for (const s of sPidSets) { let ov = 0; for (const id of m.pidSet) if (s.has(id)) { ov++; if (ov > 7) return false; } }
    if (cfg.corner) {
      if (m.projQ === 4 && m.ownQ === 4 && q5q5 >= q5Cap) return false;
      if (m.projQ === 0 && m.ownQ === 0 && q1q1 >= q1Cap) return false;
    }
    return true;
  };
  const add = (m: Meta) => {
    selected.push(m.lu); sPidSets.push(m.pidSet);
    for (const p of m.lu.players) playerCount.set(p.id, (playerCount.get(p.id) || 0) + 1);
    teamCount.set(m.primaryTeam, (teamCount.get(m.primaryTeam) || 0) + 1);
    if (cfg.corner) { if (m.projQ === 4 && m.ownQ === 4) q5q5++; if (m.projQ === 0 && m.ownQ === 0) q1q1++; }
  };
  for (const bi of [1, 2, 0, 3, 4]) {
    const target = targets[bi]; const cands = binned[bi]; let filled = 0;
    for (const c of cands) { if (filled >= target) break; if (!canAdd(c)) continue; add(c); filled++; }
  }
  if (selected.length < N) {
    const all = [...metas].sort((a, b) => b.score - a.score);
    for (const m of all) { if (selected.length >= N) break; if (sPidSets.includes(m.pidSet)) continue; if (!canAdd(m)) continue; add(m); }
  }
  return selected;
}

async function main() {
  console.log('================================================================');
  console.log(`MLB HYBRID V3 — ceiling + variance + gap signals on Config B foundation`);
  console.log('================================================================\n');

  const cache: SlateCache[] = [];
  for (const s of SLATES) {
    console.log(`Loading ${s.slate}...`);
    try { const c = await loadSlate(s); if (c) cache.push(c); } catch (e: any) { console.log(`  skip: ${e.message}`); }
  }
  console.log(`\n${cache.length} slates loaded.\n`);

  // Grid: lambdaCombo {0.15, 0.20, 0.25}, lambdaCeiling {0, 0.1, 0.2, 0.5}, lambdaGap {0, 0.1, 0.2, 0.5}, lambdaVar {0, 0.05, 0.1}, lambdaEmax {0}, corner {true}, floor {0}
  const cfgs: { id: string; cfg: Cfg }[] = [];
  for (const lc of [0.15, 0.20, 0.25]) {
    for (const lcl of [0, 0.1, 0.2, 0.5]) {
      for (const lg of [0, 0.1, 0.2, 0.5]) {
        for (const lv of [0, 0.05, 0.1]) {
          const id = `lc${lc}|lcl${lcl}|lg${lg}|lv${lv}`;
          cfgs.push({
            id,
            cfg: { lambdaCombo: lc, lambdaCeiling: lcl, lambdaGap: lg, lambdaVar: lv, lambdaEmax: 0, corner: true, floor: 0 },
          });
        }
      }
    }
  }
  console.log(`${cfgs.length} configs to evaluate\n`);

  interface Row { combo: string; slate: string; pay: number; t1: number }
  const rows: Row[] = [];
  let done = 0;
  for (const c of cfgs) {
    for (const sd of cache) {
      const pf = runHybrid(sd, c.cfg);
      const s = scorePortfolio(pf, sd.actuals, sd.actualByHash, sd.sorted, sd.payoutTable, sd.top1Thresh);
      rows.push({ combo: c.id, slate: sd.slate, pay: s.pay, t1: s.t1 });
    }
    done++; if (done % 40 === 0) console.log(`  ${done}/${cfgs.length}`);
  }

  interface Summary { combo: string; full: number; recent: number; minLoo: number; profitable: number }
  const summaries: Summary[] = [];
  for (const c of cfgs) {
    const r = rows.filter(x => x.combo === c.id);
    const pays = r.map(x => x.pay);
    let full = 0, recent = 0, profitable = 0;
    for (const x of r) { full += x.pay; if (x.pay > FEE * N) profitable++; if (RECENT.has(x.slate)) recent += x.pay; }
    const loos = pays.map((_, i) => { let s = 0, cnt = 0; for (let j = 0; j < pays.length; j++) if (j !== i) { s += pays[j]; cnt++; } return cnt ? s / cnt : 0; });
    summaries.push({ combo: c.id, full, recent, minLoo: Math.min(...loos), profitable });
  }
  summaries.sort((a, b) => b.full - a.full);

  const CONFIG_B_FULL = 54869;
  const CONFIG_B_RECENT = 43347;
  const CONFIG_B_MINLOO = 2951;

  console.log('\n================ TOP 15 BY FULL ================\n');
  console.log('Rank | Combo                         | Full     | Recent   | min-LOO | Profit | vs Config B');
  console.log('-'.repeat(105));
  for (let i = 0; i < 15; i++) {
    const s = summaries[i];
    const d = s.full - CONFIG_B_FULL;
    console.log(`  ${(i + 1).toString().padStart(2)} | ${s.combo.padEnd(30)} | $${s.full.toFixed(0).padStart(6)} | $${s.recent.toFixed(0).padStart(6)} | $${s.minLoo.toFixed(0).padStart(5)} | ${s.profitable}/11 | ${d >= 0 ? '+' : ''}$${d.toFixed(0)}`);
  }
  const beats = summaries.filter(s => s.full > CONFIG_B_FULL);
  const beatsBoth = summaries.filter(s => s.full > CONFIG_B_FULL && s.recent > CONFIG_B_RECENT && s.minLoo > CONFIG_B_MINLOO);
  console.log(`\n  Configs beating Config B full-sample: ${beats.length}`);
  console.log(`  Configs beating Config B on all three metrics: ${beatsBoth.length}`);
  if (beatsBoth.length > 0) {
    console.log('\n  Triple-metric winners:');
    for (const s of beatsBoth) console.log(`    ${s.combo.padEnd(30)} full $${s.full.toFixed(0)}  recent $${s.recent.toFixed(0)}  min-LOO $${s.minLoo.toFixed(0)}  profit ${s.profitable}/11`);
  }

  // Also check top by other metrics
  const byRecent = [...summaries].sort((a, b) => b.recent - a.recent);
  const byMinLoo = [...summaries].sort((a, b) => b.minLoo - a.minLoo);
  console.log('\n================ TOP 5 BY RECENT ================');
  for (let i = 0; i < 5; i++) { const s = byRecent[i]; console.log(`  ${s.combo.padEnd(30)} recent $${s.recent.toFixed(0)}  full $${s.full.toFixed(0)}  min-LOO $${s.minLoo.toFixed(0)}`); }
  console.log('\n================ TOP 5 BY min-LOO ================');
  for (let i = 0; i < 5; i++) { const s = byMinLoo[i]; console.log(`  ${s.combo.padEnd(30)} min-LOO $${s.minLoo.toFixed(0)}  full $${s.full.toFixed(0)}  recent $${s.recent.toFixed(0)}`); }

  // Markdown
  let md = `# MLB Hybrid V3 — Ceiling/Variance/Gap Signals\n\n`;
  md += `Foundation: Config B (λc=0.20, corner=true). Added signals: ceiling, ceiling-gap, variance.\n\n`;
  md += `**Config B reference**: full $54,869 / recent $43,347 / min-LOO $2,951 / profitable 5/11.\n\n`;
  md += `## Top 15 full-sample\n\n`;
  md += `| Rank | Combo | Full | Recent | min-LOO | Profit | vs Config B |\n|---:|---|---:|---:|---:|---:|---:|\n`;
  for (let i = 0; i < 15; i++) {
    const s = summaries[i]; const d = s.full - CONFIG_B_FULL;
    md += `| ${i + 1} | \`${s.combo}\` | $${s.full.toFixed(0)} | $${s.recent.toFixed(0)} | $${s.minLoo.toFixed(0)} | ${s.profitable}/11 | ${d >= 0 ? '+' : ''}$${d.toFixed(0)} |\n`;
  }
  md += `\n**Configs beating Config B full-sample**: ${beats.length}\n`;
  md += `**Configs beating Config B on all three metrics (full, recent, min-LOO)**: ${beatsBoth.length}\n`;
  fs.writeFileSync(OUT_MD, md);
  console.log(`\nMD: ${OUT_MD}`);
}

main().catch(e => { console.error(e); process.exit(1); });
