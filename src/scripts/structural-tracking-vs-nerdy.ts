/**
 * Per-slate structural tracking vs nerdytenor.
 *
 * For each mechanism variant (baseline, ceiling ν=0.5 μ=0.3, chalk-avoid X=6,
 * multi-criteria M5 own-heavy, A5 contra-heavy allocation, chalk-avoid X=3),
 * compute 9 portfolio-level metrics on each slate where nerdy played.
 *
 * Then compute Pearson correlation across slates between (mechanism's value
 * on slate i) and (nerdy's value on slate i) for each metric. High r means
 * the mechanism moves with nerdy slate-to-slate.
 *
 * Composite tracking score = mean(|r|) across 9 metrics.
 * Purely diagnostic. No ship decisions.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals, ContestEntry } from '../parser';
import { getContestConfig } from '../rules';
import { productionSelect, DEFAULT_PRODUCTION_CONFIG } from '../selection/production-selector';
import { precomputeComboFrequencies, comboBonus } from '../selection/combo-leverage';
import { generateWorlds } from '../v35/simulation';
import { computeAnchor } from '../selection/anchor-relative';

const DIR = 'C:/Users/colin/dfs opto';
const N = 150;
const LAMBDA = 0.05;
const GAMMA = 7;
const NUM_WORLDS = 1000;
const SEED = 12345;

const SLATES = [
  { slate: '4-6-26', proj: '4-6-26_projections.csv', actuals: 'dkactuals 4-6-26.csv', pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26', proj: '4-8-26projections.csv', actuals: '4-8-26actuals.csv', pool: '4-8-26sspool.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv', actuals: '4-12-26actuals.csv', pool: '4-12-26sspool.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv', actuals: '4-14-26actuals.csv', pool: '4-14-26sspool.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv', actuals: '4-15-26actuals.csv', pool: '4-15-26sspool.csv' },
  { slate: '4-17-26', proj: '4-17-26projections.csv', actuals: '4-17-26actuals.csv', pool: '4-17-26sspool.csv' },
  { slate: '4-19-26', proj: '4-19-26projections.csv', actuals: '4-19-26actuals.csv', pool: '4-19-26sspool.csv' },
  { slate: '4-20-26', proj: '4-20-26projections.csv', actuals: '4-20-26actuals.csv', pool: '4-20-26sspool.csv' },
  { slate: '4-21-26', proj: '4-21-26projections.csv', actuals: '4-21-26actuals.csv', pool: '4-21-26sspool.csv' },
];

const OWNERSHIP_BINS_BASE = [
  { label: 'chalk',  deltaLo: -2,  deltaHi: 99,  fraction: 0.10 },
  { label: 'core',   deltaLo: -5,  deltaHi: -2,  fraction: 0.30 },
  { label: 'value',  deltaLo: -8,  deltaHi: -5,  fraction: 0.35 },
  { label: 'contra', deltaLo: -12, deltaHi: -8,  fraction: 0.20 },
  { label: 'deep',   deltaLo: -20, deltaHi: -12, fraction: 0.05 },
];

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function mean(arr: number[]): number { if (!arr.length) return 0; let s = 0; for (let i = 0; i < arr.length; i++) s += arr[i]; return s / arr.length; }
function stddev(arr: number[]): number { if (arr.length < 2) return 0; const m = mean(arr); return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length); }
function pearson(xs: number[], ys: number[]): number {
  const n = xs.length; if (n < 2) return 0;
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; num += dx * dy; dx2 += dx * dx; dy2 += dy * dy; }
  return num / (Math.sqrt(dx2 * dy2) || 0);
}

interface SlateData {
  slate: string; actuals: ContestActuals; candidates: Lineup[]; poolPlayers: Player[];
  comboFreq: Map<string, number>; ceilingByHash: Map<string, number>; nameMap: Map<string, Player>;
}

// ================================================================
// Portfolio metrics (shared for all portfolio types — nerdy, mechanism outputs)
// ================================================================
interface PortfolioMetrics {
  meanOwn: number; meanProj: number; meanCeiling: number;
  ownStdWithinLineup: number;
  meanPairwiseOverlap: number; maxPairwiseOverlap: number;
  nonFourStackPct: number; uniqueTeams: number; maxTeamExposure: number;
}

function computeMetrics(lineups: Player[][], ceilingByHash: Map<string, number>): PortfolioMetrics {
  // lineups here = array of player arrays (for nerdy resolved or mechanism selected)
  if (lineups.length === 0) return { meanOwn: 0, meanProj: 0, meanCeiling: 0, ownStdWithinLineup: 0, meanPairwiseOverlap: 0, maxPairwiseOverlap: 0, nonFourStackPct: 0, uniqueTeams: 0, maxTeamExposure: 0 };
  const luOwns: number[] = [];
  const luProjs: number[] = [];
  const luCeils: number[] = [];
  const luOwnStds: number[] = [];
  let nonFour = 0;
  const teamExp = new Map<string, number>();
  const allStackTeams = new Set<string>();
  const pidSets: Set<string>[] = [];

  for (const players of lineups) {
    const owns = players.map(p => p.ownership || 0);
    luOwns.push(mean(owns));
    luProjs.push(players.reduce((s, p) => s + (p.projection || 0), 0));
    luOwnStds.push(stddev(owns));
    const hash = players.map(p => p.id).sort().join('|');
    const ceil = ceilingByHash.get(hash);
    if (ceil !== undefined) luCeils.push(ceil);

    // Team stack analysis
    const counts = new Map<string, number>();
    for (const p of players) if (!p.positions?.includes('P')) counts.set(p.team, (counts.get(p.team) || 0) + 1);
    let maxCount = 0, maxTeam: string | null = null;
    for (const [t, c] of counts) { if (c > maxCount) { maxCount = c; maxTeam = t; } if (c >= 4) allStackTeams.add(t); }
    if (maxCount < 4) nonFour++;
    if (maxTeam && maxCount >= 4) teamExp.set(maxTeam, (teamExp.get(maxTeam) || 0) + 1);

    pidSets.push(new Set(players.map(p => p.id)));
  }

  // Pairwise overlaps
  let maxOvl = 0, sumOvl = 0, pairs = 0;
  for (let i = 0; i < pidSets.length; i++) {
    for (let j = i + 1; j < pidSets.length; j++) {
      let o = 0; for (const id of pidSets[i]) if (pidSets[j].has(id)) o++;
      if (o > maxOvl) maxOvl = o;
      sumOvl += o; pairs++;
    }
  }

  return {
    meanOwn: mean(luOwns),
    meanProj: mean(luProjs),
    meanCeiling: luCeils.length > 0 ? mean(luCeils) : 0,
    ownStdWithinLineup: mean(luOwnStds),
    meanPairwiseOverlap: pairs > 0 ? sumOvl / pairs : 0,
    maxPairwiseOverlap: maxOvl,
    nonFourStackPct: lineups.length > 0 ? nonFour / lineups.length * 100 : 0,
    uniqueTeams: allStackTeams.size,
    maxTeamExposure: teamExp.size > 0 ? Math.max(...teamExp.values()) / lineups.length * 100 : 0,
  };
}

// ================================================================
// Mechanism selectors (reuse from prior blocks)
// ================================================================
function runBaseline(sd: SlateData): Player[][] {
  const r = productionSelect(sd.candidates, sd.poolPlayers, { N, lambda: LAMBDA, comboFreq: sd.comboFreq, maxOverlap: GAMMA });
  return r.portfolio.map(lu => lu.players);
}

function runBinVariant(sd: SlateData, opts: { bins?: { chalk: number; core: number; value: number; contra: number; deep: number }; chalkAvoidX?: number; nu?: number; muAbs?: number }): Player[][] {
  const stackPool = sd.candidates.filter(lu => {
    const tc = new Map<string, number>();
    for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
    let max = 0; for (const c of tc.values()) if (c > max) max = c;
    return max >= 4;
  });
  const anchor = computeAnchor(stackPool, 50);
  let filtered = stackPool;
  if (opts.chalkAvoidX !== undefined) {
    const byOwn = [...stackPool].sort((a, b) => {
      const oa = a.players.reduce((s, p) => s + (p.ownership || 0), 0) / a.players.length;
      const ob = b.players.reduce((s, p) => s + (p.ownership || 0), 0) / b.players.length;
      return ob - oa;
    }).slice(0, Math.min(50, stackPool.length));
    const maxerCentroid = mean(byOwn.map(lu => mean(lu.players.map(p => p.ownership || 0))));
    filtered = stackPool.filter(lu => {
      const o = lu.players.reduce((s, p) => s + (p.ownership || 0), 0) / lu.players.length;
      return o <= maxerCentroid - opts.chalkAvoidX!;
    });
  }

  const meta = filtered.map(lu => {
    const own = lu.players.reduce((s, p) => s + (p.ownership || 0), 0) / lu.players.length;
    const hash = lu.players.map(p => p.id).sort().join('|');
    const ceiling = sd.ceilingByHash.get(hash) ?? lu.projection;
    const cb = comboBonus(lu, sd.comboFreq);
    const pidSet = new Set(lu.players.map(p => p.id));
    const counts = new Map<string, number>();
    for (const p of lu.players) if (!p.positions?.includes('P')) counts.set(p.team, (counts.get(p.team) || 0) + 1);
    let pt: string | null = null, mx = 0;
    for (const [t, c] of counts) if (c > mx) { mx = c; pt = t; }
    return { lu, own, proj: lu.projection, ceiling, cb, pidSet, primaryTeam: mx >= 4 ? pt : null };
  });

  const bins = opts.bins ?? { chalk: 0.10, core: 0.30, value: 0.35, contra: 0.20, deep: 0.05 };
  const binDefs = OWNERSHIP_BINS_BASE.map((b, i) => ({ ...b, fraction: [bins.chalk, bins.core, bins.value, bins.contra, bins.deep][i] }));

  const binned = new Map<string, typeof meta>();
  for (const b of binDefs) binned.set(b.label, []);
  for (const e of meta) {
    const delta = e.own - anchor.ownership;
    for (const b of binDefs) {
      if (delta >= b.deltaLo && delta < b.deltaHi) { binned.get(b.label)!.push(e); break; }
    }
  }

  const nu = opts.nu ?? 0;
  const muAbs = opts.muAbs ?? 0;
  for (const [, entries] of binned) {
    entries.sort((a, b) => {
      const sa = a.proj + nu * (a.ceiling - a.proj) - muAbs * a.own + LAMBDA * a.cb;
      const sb = b.proj + nu * (b.ceiling - b.proj) - muAbs * b.own + LAMBDA * b.cb;
      return sb - sa;
    });
  }

  const allocations = new Map<string, number>();
  let tot = 0;
  for (const b of binDefs) { const c = Math.round(b.fraction * N); allocations.set(b.label, c); tot += c; }
  if (tot !== N) { const largest = binDefs.reduce((a, b) => a.fraction > b.fraction ? a : b); allocations.set(largest.label, allocations.get(largest.label)! + (N - tot)); }

  const selected: Lineup[] = [];
  const selectedHashes = new Set<string>();
  const pidSets: Set<string>[] = [];
  const playerCount = new Map<string, number>();
  const teamStackCount = new Map<string, number>();
  const maxPerTeam = Math.max(1, Math.floor(N * DEFAULT_PRODUCTION_CONFIG.teamCapPct));
  const expCap = Math.ceil(DEFAULT_PRODUCTION_CONFIG.maxExposure * N);
  const canAdd = (e: typeof meta[0]) => {
    if (selectedHashes.has(e.lu.hash)) return false;
    for (const p of e.lu.players) if ((playerCount.get(p.id) || 0) >= expCap) return false;
    if (e.primaryTeam && (teamStackCount.get(e.primaryTeam) || 0) >= maxPerTeam) return false;
    for (const sel of pidSets) { let shared = 0; for (const id of e.pidSet) if (sel.has(id)) { shared++; if (shared > GAMMA) return false; } }
    return true;
  };
  const add = (e: typeof meta[0]) => {
    selected.push(e.lu); selectedHashes.add(e.lu.hash); pidSets.push(e.pidSet);
    for (const p of e.lu.players) playerCount.set(p.id, (playerCount.get(p.id) || 0) + 1);
    if (e.primaryTeam) teamStackCount.set(e.primaryTeam, (teamStackCount.get(e.primaryTeam) || 0) + 1);
  };
  for (const label of ['core', 'value', 'chalk', 'contra', 'deep']) {
    const target = allocations.get(label) || 0;
    const cands = binned.get(label) || [];
    let filled = 0;
    for (const c of cands) { if (filled >= target) break; if (!canAdd(c)) continue; add(c); filled++; }
  }
  if (selected.length < N) {
    const all = [...meta].sort((a, b) => {
      const sa = a.proj + nu * (a.ceiling - a.proj) - muAbs * a.own + LAMBDA * a.cb;
      const sb = b.proj + nu * (b.ceiling - b.proj) - muAbs * b.own + LAMBDA * b.cb;
      return sb - sa;
    });
    for (const c of all) { if (selected.length >= N) break; if (!canAdd(c)) continue; add(c); }
  }
  return selected.map(lu => lu.players);
}

function runMultiCriteriaNoBins(sd: SlateData, w: { wProj: number; wCeiling: number; wOwn: number }): Player[][] {
  const stackPool = sd.candidates.filter(lu => {
    const tc = new Map<string, number>();
    for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
    let max = 0; for (const c of tc.values()) if (c > max) max = c;
    return max >= 4;
  });
  const projs = stackPool.map(lu => lu.projection);
  const owns = stackPool.map(lu => lu.players.reduce((s, p) => s + (p.ownership || 0), 0) / lu.players.length);
  const ceilings = stackPool.map(lu => sd.ceilingByHash.get(lu.players.map(p => p.id).sort().join('|')) ?? lu.projection);
  const normalize = (arr: number[]) => { const mn = Math.min(...arr), mx = Math.max(...arr); return arr.map(v => mx > mn ? (v - mn) / (mx - mn) : 0); };
  const nProj = normalize(projs), nCeiling = normalize(ceilings), nOwn = normalize(owns);

  const scored = stackPool.map((lu, i) => {
    const cb = comboBonus(lu, sd.comboFreq);
    const pidSet = new Set(lu.players.map(p => p.id));
    const counts = new Map<string, number>();
    for (const p of lu.players) if (!p.positions?.includes('P')) counts.set(p.team, (counts.get(p.team) || 0) + 1);
    let pt: string | null = null, mx = 0;
    for (const [t, c] of counts) if (c > mx) { mx = c; pt = t; }
    const score = w.wProj * nProj[i] + w.wCeiling * (nCeiling[i] - nProj[i]) - w.wOwn * nOwn[i] + LAMBDA * cb / 50;
    return { lu, pidSet, primaryTeam: mx >= 4 ? pt : null, score };
  });
  scored.sort((a, b) => b.score - a.score);

  const selected: Lineup[] = [];
  const selectedHashes = new Set<string>();
  const pidSets: Set<string>[] = [];
  const playerCount = new Map<string, number>();
  const teamStackCount = new Map<string, number>();
  const maxPerTeam = Math.max(1, Math.floor(N * DEFAULT_PRODUCTION_CONFIG.teamCapPct));
  const expCap = Math.ceil(DEFAULT_PRODUCTION_CONFIG.maxExposure * N);
  for (const e of scored) {
    if (selected.length >= N) break;
    if (selectedHashes.has(e.lu.hash)) continue;
    let expOK = true;
    for (const p of e.lu.players) if ((playerCount.get(p.id) || 0) >= expCap) { expOK = false; break; }
    if (!expOK) continue;
    if (e.primaryTeam && (teamStackCount.get(e.primaryTeam) || 0) >= maxPerTeam) continue;
    let ovOK = true;
    for (const sel of pidSets) { let shared = 0; for (const id of e.pidSet) if (sel.has(id)) { shared++; if (shared > GAMMA) { ovOK = false; break; } } if (!ovOK) break; }
    if (!ovOK) continue;
    selected.push(e.lu); selectedHashes.add(e.lu.hash); pidSets.push(e.pidSet);
    for (const p of e.lu.players) playerCount.set(p.id, (playerCount.get(p.id) || 0) + 1);
    if (e.primaryTeam) teamStackCount.set(e.primaryTeam, (teamStackCount.get(e.primaryTeam) || 0) + 1);
  }
  return selected.map(lu => lu.players);
}

// ================================================================
// Load + precompute
// ================================================================
async function main() {
  console.log('Loading slates...');
  const slateData: SlateData[] = [];
  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj);
    const actualsPath = path.join(DIR, s.actuals);
    const poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) continue;
    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);
    const nameMap = new Map<string, Player>();
    for (const p of pool.players) nameMap.set(norm(p.name), p);
    const idMap = new Map<string, Player>();
    for (const p of pool.players) idMap.set(p.id, p);
    const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
    const comboFreq = precomputeComboFrequencies(loaded.lineups, 3);
    console.log(`  ${s.slate}: generating sim...`);
    const sim = generateWorlds(pool.players, NUM_WORLDS, 5, SEED);
    const playerIdx = new Map<string, number>();
    for (let i = 0; i < pool.players.length; i++) playerIdx.set(pool.players[i].id, i);
    const ceilingByHash = new Map<string, number>();
    for (const lu of loaded.lineups) {
      const indices: number[] = [];
      for (const p of lu.players) { const idx = playerIdx.get(p.id); if (idx !== undefined) indices.push(idx); }
      const scores = new Float64Array(NUM_WORLDS);
      for (let w = 0; w < NUM_WORLDS; w++) { let sum = 0; for (const pi of indices) sum += sim.scores[pi * NUM_WORLDS + w]; scores[w] = sum; }
      const sortedScores = [...scores].sort((a, b) => a - b);
      ceilingByHash.set(lu.players.map(p => p.id).sort().join('|'), sortedScores[Math.floor(NUM_WORLDS * 0.9)]);
    }
    slateData.push({ slate: s.slate, actuals, candidates: loaded.lineups, poolPlayers: pool.players, comboFreq, ceilingByHash, nameMap });
  }

  // Extract nerdy's portfolios per slate
  const nerdyBySlate: Map<string, Player[][]> = new Map();
  for (const sd of slateData) {
    const nerdy: Player[][] = [];
    for (const e of sd.actuals.entries) {
      if (!e.entryName.toLowerCase().includes('nerdytenor')) continue;
      const pls: Player[] = [];
      let ok = true;
      for (const nm of e.playerNames) { const p = sd.nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
      if (ok) nerdy.push(pls);
    }
    if (nerdy.length > 0) nerdyBySlate.set(sd.slate, nerdy);
  }

  console.log(`\nNerdy portfolios: ${[...nerdyBySlate.keys()].join(', ')}`);

  // Mechanisms
  interface Mechanism { label: string; run: (sd: SlateData) => Player[][]; }
  const mechanisms: Mechanism[] = [
    { label: 'baseline', run: (sd) => runBaseline(sd) },
    { label: 'ν=0.5 μ_abs=0.3', run: (sd) => runBinVariant(sd, { nu: 0.5, muAbs: 0.3 }) },
    { label: 'chalk-avoid X=3', run: (sd) => runBinVariant(sd, { chalkAvoidX: 3 }) },
    { label: 'chalk-avoid X=6', run: (sd) => runBinVariant(sd, { chalkAvoidX: 6 }) },
    { label: 'A5 contra-heavy', run: (sd) => runBinVariant(sd, { bins: { chalk: 0.05, core: 0.25, value: 0.35, contra: 0.25, deep: 0.10 } }) },
    { label: 'M5 own-heavy', run: (sd) => runMultiCriteriaNoBins(sd, { wProj: 0.35, wCeiling: 0.20, wOwn: 0.45 }) },
  ];

  const METRIC_KEYS = ['meanOwn', 'meanProj', 'meanCeiling', 'ownStdWithinLineup', 'meanPairwiseOverlap', 'maxPairwiseOverlap', 'nonFourStackPct', 'uniqueTeams', 'maxTeamExposure'] as const;

  // For each mechanism × each slate (where nerdy played) → PortfolioMetrics
  const mechMetrics: Map<string, Map<string, PortfolioMetrics>> = new Map();
  const nerdyMetrics: Map<string, PortfolioMetrics> = new Map();
  for (const m of mechanisms) mechMetrics.set(m.label, new Map());

  for (const sd of slateData) {
    if (!nerdyBySlate.has(sd.slate)) continue;
    console.log(`\n--- ${sd.slate} ---`);
    // Nerdy metrics
    const nerdyLineups = nerdyBySlate.get(sd.slate)!;
    const nm = computeMetrics(nerdyLineups, sd.ceilingByHash);
    nerdyMetrics.set(sd.slate, nm);
    console.log(`  nerdy: own=${nm.meanOwn.toFixed(2)} proj=${nm.meanProj.toFixed(1)} ceil=${nm.meanCeiling.toFixed(1)} maxOvl=${nm.maxPairwiseOverlap} nonFour=${nm.nonFourStackPct.toFixed(1)}% maxTeam=${nm.maxTeamExposure.toFixed(1)}%`);

    for (const m of mechanisms) {
      const portfolio = m.run(sd);
      const mm = computeMetrics(portfolio, sd.ceilingByHash);
      mechMetrics.get(m.label)!.set(sd.slate, mm);
      console.log(`  ${m.label.padEnd(25)}: own=${mm.meanOwn.toFixed(2)} proj=${mm.meanProj.toFixed(1)} ceil=${mm.meanCeiling.toFixed(1)} maxOvl=${mm.maxPairwiseOverlap} nonFour=${mm.nonFourStackPct.toFixed(1)}% maxTeam=${mm.maxTeamExposure.toFixed(1)}% n=${portfolio.length}`);
    }
  }

  // Correlations
  console.log('\n\n================================================================');
  console.log('PER-SLATE CORRELATION WITH NERDY (Pearson r across slates)');
  console.log('================================================================\n');
  console.log('Metric                    | ' + mechanisms.map(m => m.label.padStart(20)).join(' | '));
  const slatesWithNerdy = [...nerdyBySlate.keys()];
  const trackingScores: Map<string, number[]> = new Map();
  for (const m of mechanisms) trackingScores.set(m.label, []);

  for (const metric of METRIC_KEYS) {
    const nerdyValues: number[] = slatesWithNerdy.map(s => (nerdyMetrics.get(s) as any)[metric]);
    let row = metric.padEnd(25) + ' | ';
    for (const m of mechanisms) {
      const mechValues = slatesWithNerdy.map(s => (mechMetrics.get(m.label)!.get(s) as any)[metric]);
      const r = pearson(mechValues, nerdyValues);
      trackingScores.get(m.label)!.push(Math.abs(r));
      row += r.toFixed(3).padStart(20) + ' | ';
    }
    console.log(row);
  }

  // Composite scores
  console.log('\n--- Composite tracking score (avg |r| across 9 metrics) ---\n');
  const composite: Array<{ label: string; score: number }> = [];
  for (const m of mechanisms) {
    const s = mean(trackingScores.get(m.label)!);
    composite.push({ label: m.label, score: s });
  }
  composite.sort((a, b) => b.score - a.score);
  for (const c of composite) console.log(`  ${c.label.padEnd(25)}: ${c.score.toFixed(3)}`);

  // Deep-dive on top tracker
  const top = composite[0];
  console.log(`\n\n--- DEEP DIVE: top tracker = ${top.label} ---\n`);
  console.log('Per-slate metric values (top tracker vs nerdy):');
  console.log('Slate     | ' + METRIC_KEYS.map(m => m.padStart(12)).join(' | '));
  for (const s of slatesWithNerdy) {
    const n = nerdyMetrics.get(s)!;
    const t = mechMetrics.get(top.label)!.get(s)!;
    console.log(`${s.padEnd(10)}| nerdy: ${METRIC_KEYS.map(m => ((n as any)[m]).toFixed(1).padStart(12)).join(' | ')}`);
    console.log(`${''.padEnd(10)}| top:   ${METRIC_KEYS.map(m => ((t as any)[m]).toFixed(1).padStart(12)).join(' | ')}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
