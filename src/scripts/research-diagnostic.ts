/**
 * Research diagnostic — nerdytenor vs production, framework-grounded metrics.
 *
 * For each slate, simulate scenarios via V35's t-copula, then compute:
 *   Hunter:         mean lineup proj, mean lineup var, avg pairwise correlation,
 *                   max shared players, avg shared players
 *   Haugh-Singal:   avg σ_{δ,G} where G = top-1% field score
 *   Liu-Teo:        E[max] across portfolio, E[max] / mean ratio,
 *                   within-portfolio variance, evil twin strength
 *
 * Start with 4-14 (largest payout gap), optionally extend to all 8 slates.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import {
  parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestEntry,
} from '../parser';
import { getContestConfig } from '../rules';
import { generateWorlds } from '../v35/simulation';
import { productionSelect } from '../selection/production-selector';
import { precomputeComboFrequencies } from '../selection/combo-leverage';

const DIR = 'C:/Users/colin/dfs opto';
const N = 150;
const LAMBDA = 0.05;
const NUM_WORLDS = 3000;
const SEED = 12345;

// Run diagnostic on: 4-14 first (biggest gap), then all valid slates
const ALL_SLATES = [
  { slate: '4-6-26', proj: '4-6-26_projections.csv', actuals: 'dkactuals 4-6-26.csv', pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26', proj: '4-8-26projections.csv', actuals: '4-8-26actuals.csv', pool: '4-8-26sspool.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv', actuals: '4-12-26actuals.csv', pool: '4-12-26sspool.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv', actuals: '4-14-26actuals.csv', pool: '4-14-26sspool.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv', actuals: '4-15-26actuals.csv', pool: '4-15-26sspool.csv' },
  { slate: '4-17-26', proj: '4-17-26projections.csv', actuals: '4-17-26actuals.csv', pool: '4-17-26sspool.csv' },
  { slate: '4-19-26', proj: '4-19-26projections.csv', actuals: '4-19-26actuals.csv', pool: '4-19-26sspool.csv' },
  { slate: '4-20-26', proj: '4-20-26projections.csv', actuals: '4-20-26actuals.csv', pool: '4-20-26sspool.csv' },
];

function norm(n: string): string {
  return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function mean(arr: Float64Array | number[]): number {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return arr.length ? s / arr.length : 0;
}

function variance(arr: Float64Array | number[]): number {
  const m = mean(arr);
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += (arr[i] - m) * (arr[i] - m);
  return arr.length ? s / arr.length : 0;
}

function cov(a: Float64Array | number[], b: Float64Array | number[]): number {
  const ma = mean(a), mb = mean(b);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - ma) * (b[i] - mb);
  return a.length ? s / a.length : 0;
}

/**
 * Score a set of lineups across all scenarios. Returns a matrix [lineupIdx][scenarioIdx].
 */
function scoreLineups(
  lineups: Player[][],      // player arrays per lineup
  playerIndexMap: Map<string, number>,
  scores: Float32Array,      // from generateWorlds
  numWorlds: number,
): Float64Array[] {
  const result: Float64Array[] = [];
  for (const players of lineups) {
    const row = new Float64Array(numWorlds);
    const indices: number[] = [];
    for (const p of players) {
      const idx = playerIndexMap.get(p.id);
      if (idx === undefined) continue;
      indices.push(idx);
    }
    for (let w = 0; w < numWorlds; w++) {
      let s = 0;
      for (const pi of indices) s += scores[pi * numWorlds + w];
      row[w] = s;
    }
    result.push(row);
  }
  return result;
}

/**
 * Compute avg pairwise correlation of lineup score vectors.
 * Also compute min per-lineup correlation (evil twin strength) averaged over portfolio.
 */
function correlationMetrics(lineupScores: Float64Array[]): {
  avgCorr: number;
  evilTwinAvg: number;
} {
  const N = lineupScores.length;
  // Standardize each score vector
  const std: Float64Array[] = [];
  for (const v of lineupScores) {
    const m = mean(v);
    const varv = variance(v);
    const sd = Math.sqrt(Math.max(varv, 1e-12));
    const out = new Float64Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = (v[i] - m) / sd;
    std.push(out);
  }
  const W = lineupScores[0].length;
  let sumCorr = 0;
  let pairs = 0;
  const minPerLineup = new Float64Array(N);
  minPerLineup.fill(Infinity);
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      let c = 0;
      for (let w = 0; w < W; w++) c += std[i][w] * std[j][w];
      c /= W;
      sumCorr += c;
      pairs++;
      if (c < minPerLineup[i]) minPerLineup[i] = c;
      if (c < minPerLineup[j]) minPerLineup[j] = c;
    }
  }
  const avgCorr = pairs > 0 ? sumCorr / pairs : 0;
  const evilTwinAvg = mean(minPerLineup);
  return { avgCorr, evilTwinAvg };
}

function pairwiseOverlap(lineups: Player[][]): { max: number; mean: number } {
  const sets = lineups.map(lu => new Set(lu.map(p => p.id)));
  let sum = 0;
  let pairs = 0;
  let maxO = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      let o = 0;
      for (const id of sets[i]) if (sets[j].has(id)) o++;
      sum += o;
      pairs++;
      if (o > maxO) maxO = o;
    }
  }
  return { max: maxO, mean: pairs > 0 ? sum / pairs : 0 };
}

function resolveLineup(playerNames: string[], nameMap: Map<string, Player>): Player[] | null {
  const pls: Player[] = [];
  for (const nm of playerNames) {
    const p = nameMap.get(norm(nm));
    if (!p) return null;
    pls.push(p);
  }
  return pls;
}

function diagnoseSlate(slateCfg: typeof ALL_SLATES[0], out: string[]) {
  const projPath = path.join(DIR, slateCfg.proj);
  const actualsPath = path.join(DIR, slateCfg.actuals);
  const poolPath = path.join(DIR, slateCfg.pool);
  if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) {
    out.push(`\n## ${slateCfg.slate} — SKIPPED (missing files)\n`);
    return null;
  }

  const pr = parseCSVFile(projPath, 'mlb', true);
  const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
  const pool = buildPlayerPool(pr.players, pr.detectedContestType);
  const actuals = parseContestActuals(actualsPath, config);

  const nameMap = new Map<string, Player>();
  for (const p of pool.players) nameMap.set(norm(p.name), p);
  const idMap = new Map<string, Player>();
  for (const p of pool.players) idMap.set(p.id, p);

  const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
  const ssPool: Player[][] = loaded.lineups.map(lu => lu.players);

  const nerdyEntries = actuals.entries.filter(e => e.entryName.toLowerCase().includes('nerdytenor'));
  if (nerdyEntries.length === 0) {
    out.push(`\n## ${slateCfg.slate} — SKIPPED (no nerdytenor entries)\n`);
    return null;
  }
  const nerdyLineups = nerdyEntries.map(e => resolveLineup(e.playerNames, nameMap))
    .filter((x): x is Player[] => x !== null);

  // Production portfolio
  const comboFreq = precomputeComboFrequencies(loaded.lineups, 3);
  const prodResult = productionSelect(loaded.lineups, pool.players, {
    N, lambda: LAMBDA, comboFreq, maxOverlap: 10,
  });
  const prodLineups: Player[][] = prodResult.portfolio.map(lu => lu.players);

  console.log(`  ${slateCfg.slate}: Generating ${NUM_WORLDS} worlds...`);
  const t0 = Date.now();
  const sim = generateWorlds(pool.players, NUM_WORLDS, 5, SEED);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  ${slateCfg.slate}: Worlds generated in ${dt}s`);

  // Player index map
  const playerIndexMap = new Map<string, number>();
  for (let i = 0; i < pool.players.length; i++) playerIndexMap.set(pool.players[i].id, i);

  console.log(`  ${slateCfg.slate}: Scoring portfolios and field...`);
  const t1 = Date.now();
  const nerdyScores = scoreLineups(nerdyLineups, playerIndexMap, sim.scores, NUM_WORLDS);
  const prodScores = scoreLineups(prodLineups, playerIndexMap, sim.scores, NUM_WORLDS);
  const fieldScores = scoreLineups(ssPool, playerIndexMap, sim.scores, NUM_WORLDS);
  console.log(`  ${slateCfg.slate}: Scoring done in ${((Date.now() - t1) / 1000).toFixed(1)}s`);

  // Compute G = top-1% field score per scenario
  const G = new Float64Array(NUM_WORLDS);
  {
    const fieldScoresByScenario = new Float64Array(fieldScores.length);
    const top1Idx = Math.max(0, Math.floor(fieldScores.length * 0.01) - 1);
    for (let w = 0; w < NUM_WORLDS; w++) {
      for (let i = 0; i < fieldScores.length; i++) fieldScoresByScenario[i] = fieldScores[i][w];
      // Sort descending
      const sorted = [...fieldScoresByScenario].sort((a, b) => b - a);
      G[w] = sorted[top1Idx];
    }
  }
  const meanG = mean(G);

  function portfolioMetrics(label: string, scoreMatrix: Float64Array[], lineups: Player[][]) {
    // Hunter: per-lineup mean and variance
    const meanPerLineup = scoreMatrix.map(v => mean(v));
    const varPerLineup = scoreMatrix.map(v => variance(v));
    const portMean = mean(meanPerLineup);
    const portVar = mean(varPerLineup);

    // Hunter γ overlap
    const overlap = pairwiseOverlap(lineups);

    // Pairwise correlation + evil twin
    console.log(`  ${slateCfg.slate}: Computing ${label} correlation matrix (${scoreMatrix.length} lineups)...`);
    const tcorr = Date.now();
    const { avgCorr, evilTwinAvg } = correlationMetrics(scoreMatrix);
    console.log(`  ${slateCfg.slate}: ${label} correlations in ${((Date.now() - tcorr) / 1000).toFixed(1)}s`);

    // Haugh-Singal σ_{δ,G}
    const sigmaDG = scoreMatrix.map(v => cov(v, G));
    const avgSigmaDG = mean(sigmaDG);

    // Liu-Teo E[max]
    const maxPerScenario = new Float64Array(NUM_WORLDS);
    for (let w = 0; w < NUM_WORLDS; w++) {
      let m = -Infinity;
      for (let i = 0; i < scoreMatrix.length; i++) if (scoreMatrix[i][w] > m) m = scoreMatrix[i][w];
      maxPerScenario[w] = m;
    }
    const Emax = mean(maxPerScenario);
    const EmaxOverMean = Emax / portMean;

    // Within-portfolio variance (var across lineups within each scenario, averaged)
    const withinPortVar = new Float64Array(NUM_WORLDS);
    for (let w = 0; w < NUM_WORLDS; w++) {
      const col = new Float64Array(scoreMatrix.length);
      for (let i = 0; i < scoreMatrix.length; i++) col[i] = scoreMatrix[i][w];
      withinPortVar[w] = variance(col);
    }
    const meanWithinPortVar = mean(withinPortVar);

    // Count top-1% scenarios where portfolio beats G
    let beatsG = 0;
    for (let w = 0; w < NUM_WORLDS; w++) {
      if (maxPerScenario[w] >= G[w]) beatsG++;
    }

    return {
      label, n: scoreMatrix.length,
      portMean, portVar, portSd: Math.sqrt(portVar),
      overlap,
      avgCorr, evilTwinAvg,
      avgSigmaDG,
      Emax, EmaxOverMean,
      meanWithinPortVar, meanWithinPortSd: Math.sqrt(meanWithinPortVar),
      beatsGFrac: beatsG / NUM_WORLDS,
    };
  }

  const nerdyM = portfolioMetrics('nerdytenor', nerdyScores, nerdyLineups);
  const prodM = portfolioMetrics('production', prodScores, prodLineups);

  out.push(`\n## ${slateCfg.slate}\n`);
  out.push(`Field size: ${actuals.entries.length.toLocaleString()}, Pool: ${loaded.lineups.length}, Players: ${pool.players.length}`);
  out.push(`Simulated G (top-1% field score) mean=${meanG.toFixed(2)} over ${NUM_WORLDS} scenarios\n`);
  out.push('| Metric | Framework | nerdytenor | production | delta (n-p) | Winner |');
  out.push('|---|---|---:|---:|---:|---|');

  function row(label: string, fwk: string, nv: number, pv: number, fmt: (x: number) => string, lowerBetter: boolean) {
    const delta = nv - pv;
    const winner = lowerBetter ? (nv < pv ? 'nerdy' : (nv > pv ? 'prod' : 'tie')) : (nv > pv ? 'nerdy' : (nv < pv ? 'prod' : 'tie'));
    out.push(`| ${label} | ${fwk} | ${fmt(nv)} | ${fmt(pv)} | ${delta >= 0 ? '+' : ''}${fmt(delta)} | ${winner} |`);
  }

  const fN = (x: number) => x.toFixed(3);
  const fP = (x: number) => x.toFixed(2);
  const fI = (x: number) => x.toFixed(0);

  row('Mean lineup projection',      'Hunter',       nerdyM.portMean,          prodM.portMean,          fP, false);
  row('Mean lineup variance',        'Hunter',       nerdyM.portVar,           prodM.portVar,           fP, false);
  row('Mean lineup stddev',          'Hunter',       nerdyM.portSd,            prodM.portSd,            fP, false);
  row('Avg pairwise correlation',    'Hunter U²',    nerdyM.avgCorr,           prodM.avgCorr,           fN, true);
  row('Max shared players',          'Hunter γ',     nerdyM.overlap.max,       prodM.overlap.max,       fI, true);
  row('Avg shared players',          'Hunter γ',     nerdyM.overlap.mean,      prodM.overlap.mean,      fP, true);
  row('Avg σ(δ, G)',                 'Haugh-Singal', nerdyM.avgSigmaDG,        prodM.avgSigmaDG,        fP, true);
  row('Portfolio E[max]',            'Liu-Teo',      nerdyM.Emax,              prodM.Emax,              fP, false);
  row('E[max] / mean ratio',         'Liu-Teo',      nerdyM.EmaxOverMean,      prodM.EmaxOverMean,      fN, false);
  row('Within-portfolio stddev',     'Liu-Teo',      nerdyM.meanWithinPortSd,  prodM.meanWithinPortSd,  fP, false);
  row('Min-corr partner (evil twin)', 'Liu-Teo Thm4', nerdyM.evilTwinAvg,      prodM.evilTwinAvg,       fN, true);
  row('P(max ≥ G) across scenarios', 'Haugh-Singal', nerdyM.beatsGFrac,        prodM.beatsGFrac,        fN, false);

  return { nerdy: nerdyM, prod: prodM, meanG };
}

async function main() {
  const out: string[] = [];
  out.push('# Research-Grounded Diagnostic — nerdytenor vs production');
  out.push(`Generated ${new Date().toISOString()}`);
  out.push(`\n${NUM_WORLDS} t-copula scenarios (V35 sim, seed=${SEED}). Lambda=${LAMBDA}. G = top-1% field score per scenario.\n`);

  // Start with 4-14 per user request, then do the rest
  const slateOrder = ['4-14-26', '4-6-26', '4-8-26', '4-12-26', '4-15-26', '4-17-26', '4-19-26', '4-20-26'];
  const ordered = slateOrder.map(s => ALL_SLATES.find(x => x.slate === s)!).filter(Boolean);

  const allResults: Array<ReturnType<typeof diagnoseSlate>> = [];
  for (const s of ordered) {
    const r = diagnoseSlate(s, out);
    allResults.push(r);
  }

  // Cross-slate averages (non-null results)
  const valid = allResults.filter((r): r is NonNullable<typeof r> => r !== null);
  if (valid.length > 0) {
    out.push('\n## Cross-slate averages (all valid slates)\n');
    const avgN = (fn: (r: NonNullable<typeof valid[0]>) => number) => mean(valid.map(fn));
    out.push('| Metric | nerdy avg | prod avg | delta |');
    out.push('|---|---:|---:|---:|');
    out.push(`| Mean lineup proj | ${avgN(r => r.nerdy.portMean).toFixed(2)} | ${avgN(r => r.prod.portMean).toFixed(2)} | ${(avgN(r => r.nerdy.portMean) - avgN(r => r.prod.portMean)).toFixed(2)} |`);
    out.push(`| Mean lineup stddev | ${avgN(r => r.nerdy.portSd).toFixed(2)} | ${avgN(r => r.prod.portSd).toFixed(2)} | ${(avgN(r => r.nerdy.portSd) - avgN(r => r.prod.portSd)).toFixed(2)} |`);
    out.push(`| Avg pairwise corr | ${avgN(r => r.nerdy.avgCorr).toFixed(3)} | ${avgN(r => r.prod.avgCorr).toFixed(3)} | ${(avgN(r => r.nerdy.avgCorr) - avgN(r => r.prod.avgCorr)).toFixed(3)} |`);
    out.push(`| Max shared players | ${avgN(r => r.nerdy.overlap.max).toFixed(2)} | ${avgN(r => r.prod.overlap.max).toFixed(2)} | ${(avgN(r => r.nerdy.overlap.max) - avgN(r => r.prod.overlap.max)).toFixed(2)} |`);
    out.push(`| Avg σ(δ,G) | ${avgN(r => r.nerdy.avgSigmaDG).toFixed(2)} | ${avgN(r => r.prod.avgSigmaDG).toFixed(2)} | ${(avgN(r => r.nerdy.avgSigmaDG) - avgN(r => r.prod.avgSigmaDG)).toFixed(2)} |`);
    out.push(`| Portfolio E[max] | ${avgN(r => r.nerdy.Emax).toFixed(2)} | ${avgN(r => r.prod.Emax).toFixed(2)} | ${(avgN(r => r.nerdy.Emax) - avgN(r => r.prod.Emax)).toFixed(2)} |`);
    out.push(`| E[max]/mean ratio | ${avgN(r => r.nerdy.EmaxOverMean).toFixed(3)} | ${avgN(r => r.prod.EmaxOverMean).toFixed(3)} | ${(avgN(r => r.nerdy.EmaxOverMean) - avgN(r => r.prod.EmaxOverMean)).toFixed(3)} |`);
    out.push(`| Evil twin avg corr | ${avgN(r => r.nerdy.evilTwinAvg).toFixed(3)} | ${avgN(r => r.prod.evilTwinAvg).toFixed(3)} | ${(avgN(r => r.nerdy.evilTwinAvg) - avgN(r => r.prod.evilTwinAvg)).toFixed(3)} |`);
    out.push(`| P(max ≥ G) | ${avgN(r => r.nerdy.beatsGFrac).toFixed(3)} | ${avgN(r => r.prod.beatsGFrac).toFixed(3)} | ${(avgN(r => r.nerdy.beatsGFrac) - avgN(r => r.prod.beatsGFrac)).toFixed(3)} |`);
  }

  const reportPath = path.join(DIR, 'research_diagnostic.md');
  fs.writeFileSync(reportPath, out.join('\n'));
  console.log(`\nReport written: ${reportPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
