/**
 * Analysis 3 — Lineup-pair correlation eigenvalue spectrum.
 *
 * For each pro & Hermes-A on each slate:
 *   - Compute 150-lineup pairwise overlap (Jaccard) matrix
 *   - Use lineup-overlap as proxy for outcome correlation (high overlap = correlated outcome)
 *   - Compute eigenvalues; effective rank = sum(eig) / max(eig)
 *
 * Higher effective rank = more independent themes (more diversified portfolio).
 * Compare pro avg vs Hermes-A.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import {
  parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals,
} from '../parser';
import { getContestConfig } from '../rules';
import { productionSelect } from '../selection/production-selector';
import { precomputeComboFrequencies } from '../selection/combo-leverage';

const DIR = 'C:/Users/colin/dfs opto';
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
  { slate: '4-23-26', proj: '4-23-26projections.csv', actuals: '4-23-26actuals.csv',   pool: '4-23-26sspool.csv' },
  { slate: '4-24-26', proj: '4-24-26projections.csv', actuals: '4-24-26actuals.csv',   pool: '4-24-26sspool.csv' },
  { slate: '4-25-26', proj: '4-25-26projections.csv', actuals: '4-25-26actuals.csv',   pool: '4-25-26sspool.csv' },
  { slate: '4-25-26-early', proj: '4-25-26projectionsearly.csv', actuals: '4-25-26actualsearly.csv', pool: '4-25-26sspoolearly.csv' },
  { slate: '4-26-26', proj: '4-26-26projections.csv', actuals: '4-26-26actuals.csv',   pool: '4-26-26sspool.csv' },
  { slate: '4-27-26', proj: '4-27-26projections.csv', actuals: '4-27-26actuals.csv',   pool: '4-27-26sspool.csv' },
  { slate: '4-28-26', proj: '4-28-26projections.csv', actuals: '4-28-26actuals.csv',   pool: '4-28-26sspool.csv' },
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

const HERMES_A = {
  lambda: 0.58, gamma: 5, tc: 0.26, mps: 4, me: 0.21, mep: 0.41, corner: true,
  comboPower: 4, fl: 0.00,
  bins: { chalk: 0.50, core: 0.30, value: 0.20, contra: 0.00, deep: 0.00 },
};

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function mean(a: number[]): number { if (!a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; }

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// Power iteration for top-k eigenvalues of symmetric matrix
function topEigenvalues(M: number[][], k: number = 10): number[] {
  const n = M.length;
  const eigs: number[] = [];
  // Make a copy we can deflate
  const A = M.map(r => [...r]);
  for (let iter = 0; iter < k; iter++) {
    let v = new Array(n).fill(0).map(() => Math.random() - 0.5);
    let lambda = 0;
    for (let it = 0; it < 80; it++) {
      const Av = new Array(n).fill(0);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) Av[i] += A[i][j] * v[j];
      let nrm = 0;
      for (const x of Av) nrm += x * x;
      nrm = Math.sqrt(nrm);
      if (nrm < 1e-12) { lambda = 0; break; }
      v = Av.map(x => x / nrm);
      let dot = 0; const Av2 = new Array(n).fill(0);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) Av2[i] += A[i][j] * v[j];
      for (let i = 0; i < n; i++) dot += v[i] * Av2[i];
      lambda = dot;
    }
    if (lambda < 1e-9) break;
    eigs.push(lambda);
    // Deflate: A = A - lambda * v v^T
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) A[i][j] -= lambda * v[i] * v[j];
  }
  return eigs;
}

function effectiveRank(M: number[][]): { sumEig: number; topEig: number; effRank: number; eigs: number[] } {
  const eigs = topEigenvalues(M, 10);
  const sumEig = eigs.reduce((s, e) => s + e, 0);
  const topEig = eigs[0] || 1;
  return { sumEig, topEig, effRank: sumEig / topEig, eigs };
}

function buildOverlapMatrix(lineups: Set<string>[]): number[][] {
  const n = lineups.length;
  const M = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    M[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      const j2 = jaccard(lineups[i], lineups[j]);
      M[i][j] = j2; M[j][i] = j2;
    }
  }
  return M;
}

function extractPro(actuals: ContestActuals, nameMap: Map<string, Player>, tokens: string[]): Player[][] {
  const out: Player[][] = [];
  for (const e of actuals.entries) {
    const en = (e.entryName || '').toLowerCase();
    if (!tokens.some(t => en.includes(t))) continue;
    const pls: Player[] = []; let ok = true;
    for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
    if (ok) out.push(pls);
  }
  return out;
}

async function main() {
  console.log('=== ANALYSIS 3: Eigenvalue spectrum (effective portfolio rank) ===\n');

  const proRanksBySlate: Map<string, Map<string, number>> = new Map();
  const proTopEigBySlate: Map<string, Map<string, number>> = new Map();
  const hermesRanksBySlate: Map<string, number> = new Map();

  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj), actualsPath = path.join(DIR, s.actuals), poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) continue;
    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);
    const idMap = new Map<string, Player>(); const nameMap = new Map<string, Player>();
    for (const p of pool.players) { idMap.set(p.id, p); nameMap.set(norm(p.name), p); }
    const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });

    const proRanks = new Map<string, number>();
    const proTops = new Map<string, number>();
    for (const p of PROS) {
      const lus = extractPro(actuals, nameMap, p.tokens);
      if (lus.length < 50) continue;
      // Subsample to 100 lineups for speed
      const sub = lus.slice(0, 100).map(lu => new Set(lu.map(pl => pl.id)));
      const M = buildOverlapMatrix(sub);
      const r = effectiveRank(M);
      proRanks.set(p.label, r.effRank);
      proTops.set(p.label, r.topEig);
    }
    proRanksBySlate.set(s.slate, proRanks);
    proTopEigBySlate.set(s.slate, proTops);

    const comboFreq = precomputeComboFrequencies(loaded.lineups, HERMES_A.comboPower);
    const result = productionSelect(loaded.lineups, pool.players, {
      N, lambda: HERMES_A.lambda, comboFreq, maxOverlap: HERMES_A.gamma,
      teamCapPct: HERMES_A.tc, minPrimaryStack: HERMES_A.mps,
      maxExposure: HERMES_A.me, maxExposurePitcher: HERMES_A.mep,
      extremeCornerCap: HERMES_A.corner, projectionFloorPct: HERMES_A.fl,
      binAllocation: HERMES_A.bins,
    });
    const hSets = result.portfolio.slice(0, 100).map(lu => new Set(lu.players.map(p => p.id)));
    const hM = buildOverlapMatrix(hSets);
    hermesRanksBySlate.set(s.slate, effectiveRank(hM).effRank);
  }

  // Aggregate per pro
  console.log('=== PER-SLATE EFFECTIVE RANK (sum_eig / top_eig — higher = more independent themes) ===\n');
  const proAvgRanks: Record<string, number[]> = {};
  for (const p of PROS) proAvgRanks[p.label] = [];
  console.log('slate           | nerdy  zroth  youda  ship   shaidy bgrese needlu | HERMES-A');
  for (const s of SLATES) {
    const proRanks = proRanksBySlate.get(s.slate);
    if (!proRanks) continue;
    let row = '  ' + s.slate.padEnd(15) + ' | ';
    for (const p of PROS) {
      const v = proRanks.get(p.label);
      if (v !== undefined) { proAvgRanks[p.label].push(v); row += v.toFixed(2).padStart(6); }
      else row += '   -  ';
    }
    const h = hermesRanksBySlate.get(s.slate);
    row += '  | ' + (h !== undefined ? h.toFixed(2).padStart(7) : '   -  ');
    console.log(row);
  }

  console.log('\n=== AGGREGATE EFFECTIVE RANK ===');
  const proAvgValues: number[] = [];
  for (const p of PROS) {
    if (proAvgRanks[p.label].length > 0) {
      const a = mean(proAvgRanks[p.label]);
      proAvgValues.push(a);
      console.log('  ' + p.label.padEnd(18) + ' avg effective rank: ' + a.toFixed(2));
    }
  }
  const proAvg = mean(proAvgValues);
  const hermesAvg = mean([...hermesRanksBySlate.values()]);
  console.log('  Pro consensus avg effective rank: ' + proAvg.toFixed(2));
  console.log('  Hermes-A avg effective rank:      ' + hermesAvg.toFixed(2));
  console.log('  Gap: ' + (hermesAvg - proAvg > 0 ? '+' : '') + (hermesAvg - proAvg).toFixed(2) + ' (negative = Hermes more concentrated)');

  if (hermesAvg < proAvg - 0.5) console.log('\n→ INTERPRETATION: Hermes is MORE CONCENTRATED than pros — running fewer independent themes.');
  else if (hermesAvg > proAvg + 0.5) console.log('\n→ INTERPRETATION: Hermes is MORE DIVERSIFIED than pros — running more independent themes.');
  else console.log('\n→ INTERPRETATION: Hermes runs ~same number of independent themes as pros.');
}

main().catch(e => { console.error(e); process.exit(1); });
