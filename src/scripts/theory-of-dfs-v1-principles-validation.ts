/**
 * Focused validation for the Theory-DFS V1 principles challenger.
 *
 * Default split is dev only. The sealed holdout slates are not touched unless
 * explicitly requested with both --split all/holdout and --include-holdout.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { buildPlayerPool, loadPoolFromCSV, parseContestActuals, parseCSVFile, ContestActuals } from '../parser';
import { getContestConfig } from '../rules';
import {
  THEORY_V1_NOCORR_PARAMS,
  THEORY_V1_PITCHER_UNCAP_PARAMS,
  THEORY_V1_PRINCIPLES_PARAMS,
  THEORY_V1_REVIVAL_PARAMS,
  TheoryV1Params,
  cloneTheoryParams,
  mean,
  selectTheoryV1Portfolio,
  summarizeTheoryPortfolio,
} from '../theory/v1-selector';

interface SlateSpec {
  slate: string;
  proj: string;
  actuals: string;
  pool: string;
}

interface SlateData {
  slate: string;
  candidates: Lineup[];
  players: Player[];
  actuals: ContestActuals;
  optimalProj: number;
}

interface VariantSpec {
  system: string;
  params: TheoryV1Params;
}

interface EvalResult {
  system: string;
  slate: string;
  lineups: number;
  totalPayout: number;
  roi: number;
  t1: number;
  t01: number;
  missingLineups: number;
  avgProj: number;
  avgOwnSum: number;
  avgSalary: number;
  pctPrimary4: number;
  pctPrimary5Plus: number;
  pctBringBackGte1: number;
  pctBringBackGte2: number;
  pctNaked5Plus: number;
  pctGameOverload8: number;
  poolOriginal: number;
  poolFiltered: number;
}

interface SummaryResult {
  system: string;
  slates: number;
  lineups: number;
  totalPayout: number;
  roi: number;
  t1: number;
  t01: number;
  t1Edge: number;
  t01Edge: number;
  missingLineups: number;
  avgProj: number;
  avgOwnSum: number;
  avgSalary: number;
  pctPrimary4: number;
  pctPrimary5Plus: number;
  pctBringBackGte1: number;
  pctBringBackGte2: number;
  pctNaked5Plus: number;
  pctGameOverload8: number;
}

const MLB_DIR = 'C:/Users/colin/dfs opto';
const OUT_DIR = 'C:/Users/colin/dfs opto/theory_dfs_v2';
const FEE = 3;

const SLATES: SlateSpec[] = [
  { slate: '4-6-26', proj: '4-6-26_projections.csv', actuals: 'dkactuals 4-6-26.csv', pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26', proj: '4-8-26projections.csv', actuals: '4-8-26actuals.csv', pool: '4-8-26sspool.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv', actuals: '4-12-26actuals.csv', pool: '4-12-26sspool.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv', actuals: '4-14-26actuals.csv', pool: '4-14-26sspool.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv', actuals: '4-15-26actuals.csv', pool: '4-15-26sspool.csv' },
  { slate: '4-17-26', proj: '4-17-26projections.csv', actuals: '4-17-26actuals.csv', pool: '4-17-26sspool.csv' },
  { slate: '4-18-26', proj: '4-18-26projections.csv', actuals: '4-18-26actuals.csv', pool: '4-18-26sspool.csv' },
  { slate: '4-19-26', proj: '4-19-26projections.csv', actuals: '4-19-26actuals.csv', pool: '4-19-26sspool.csv' },
  { slate: '4-20-26', proj: '4-20-26projections.csv', actuals: '4-20-26actuals.csv', pool: '4-20-26sspool.csv' },
  { slate: '4-21-26', proj: '4-21-26projections.csv', actuals: '4-21-26actuals.csv', pool: '4-21-26sspool.csv' },
  { slate: '4-22-26', proj: '4-22-26projections.csv', actuals: '4-22-26actuals.csv', pool: '4-22-26sspool.csv' },
  { slate: '4-23-26', proj: '4-23-26projections.csv', actuals: '4-23-26actuals.csv', pool: '4-23-26sspool.csv' },
  { slate: '4-24-26', proj: '4-24-26projections.csv', actuals: '4-24-26actuals.csv', pool: '4-24-26sspool.csv' },
  { slate: '4-25-26', proj: '4-25-26projections.csv', actuals: '4-25-26actuals.csv', pool: '4-25-26sspool.csv' },
  { slate: '4-25-26-early', proj: '4-25-26projectionsearly.csv', actuals: '4-25-26actualsearly.csv', pool: '4-25-26sspoolearly.csv' },
  { slate: '4-26-26', proj: '4-26-26projections.csv', actuals: '4-26-26actuals.csv', pool: '4-26-26sspool.csv' },
  { slate: '4-27-26', proj: '4-27-26projections.csv', actuals: '4-27-26actuals.csv', pool: '4-27-26sspool.csv' },
  { slate: '4-28-26', proj: '4-28-26projections.csv', actuals: '4-28-26actuals.csv', pool: '4-28-26sspool.csv' },
  { slate: '4-29-26', proj: '4-29-26projections.csv', actuals: '4-29-26actuals.csv', pool: '4-29-26sspool.csv' },
  { slate: '5-1-26', proj: '5-1-26projections.csv', actuals: '5-1-26actuals.csv', pool: '5-1-26sspool.csv' },
  { slate: '5-2-26', proj: '5-2-26projections.csv', actuals: '5-2-26actuals.csv', pool: '5-2-26sspool.csv' },
  { slate: '5-2-26-main', proj: '5-2-26projectionsmain.csv', actuals: '5-2-26actualsmain.csv', pool: '5-2-26sspoolmain.csv' },
  { slate: '5-2-26-night', proj: '5-2-26projectionsnight.csv', actuals: '5-2-26actualsnight.csv', pool: '5-2-26sspoolnight.csv' },
  { slate: '5-3-26', proj: '5-3-26projections.csv', actuals: '5-3-26actuals.csv', pool: '5-3-26sspool.csv' },
];

const HOLDOUT = new Set([
  '4-6-26',
  '4-14-26',
  '4-15-26',
  '4-19-26',
  '4-20-26',
  '5-1-26',
  '5-2-26',
  '5-2-26-night',
]);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const n = readNumberArg(argv, 'n') || 150;
  const split = readArg(argv, 'split') || 'dev';
  const suite = readArg(argv, 'suite') || 'core';
  const includeHoldout = argv.includes('--include-holdout');
  const slates = selectSlates(split, includeHoldout);

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const variants = buildVariants(suite);

  console.log('================================================================');
  console.log('THEORY-DFS V1 PRINCIPLES VALIDATION');
  console.log('================================================================');
  console.log(`Split: ${split}`);
  console.log(`Suite: ${suite}`);
  console.log(`Slates: ${slates.length}`);
  console.log(`Lineups per slate: ${n}`);
  console.log(`Holdout included: ${includeHoldout ? 'YES' : 'NO'}`);
  console.log('================================================================\n');

  const results: EvalResult[] = [];
  for (const slate of slates) {
    const sd = loadSlate(slate);
    if (!sd) {
      console.log(`Skipping ${slate.slate}: missing files`);
      continue;
    }

    process.stderr.write(`${slate.slate}: pool=${sd.candidates.length} ... `);
    for (const variant of variants) {
      const selected = selectTheoryV1Portfolio(sd.candidates, n, variant.params);
      const result = evaluatePortfolio(variant.system, selected.selected, sd, n);
      result.poolOriginal = selected.diagnostics.originalCount;
      result.poolFiltered = selected.diagnostics.filteredCount;
      results.push(result);
    }
    process.stderr.write('done\n');
  }

  const summaries = variants.map(variant => summarizeResults(results.filter(r => r.system === variant.system), n));
  printSummary(summaries);
  writeOutput(results, summaries, split, n);
}

function buildVariants(suite: string): VariantSpec[] {
  const core: VariantSpec[] = [
    { system: 'v1-nocorr', params: THEORY_V1_NOCORR_PARAMS },
    { system: 'v1-revival', params: THEORY_V1_REVIVAL_PARAMS },
    { system: 'v1-pitcher-uncap', params: THEORY_V1_PITCHER_UNCAP_PARAMS },
    { system: 'v1-lev10', params: cloneTheoryParams(THEORY_V1_NOCORR_PARAMS, { name: 'lev10', wLev: 0.10 }) },
    { system: 'v1-principles', params: THEORY_V1_PRINCIPLES_PARAMS },
  ];

  if (suite === 'core') return core;
  if (suite !== 'sweep') throw new Error(`Unknown --suite "${suite}". Use core or sweep.`);

  return [
    { system: 'v1-nocorr', params: THEORY_V1_NOCORR_PARAMS },
    { system: 'v1-lev20', params: cloneTheoryParams(THEORY_V1_NOCORR_PARAMS, { name: 'lev20', wLev: 0.20 }) },
    { system: 'v1-lev15', params: cloneTheoryParams(THEORY_V1_NOCORR_PARAMS, { name: 'lev15', wLev: 0.15 }) },
    { system: 'v1-lev10', params: cloneTheoryParams(THEORY_V1_NOCORR_PARAMS, { name: 'lev10', wLev: 0.10 }) },
    { system: 'v1-lev05', params: cloneTheoryParams(THEORY_V1_NOCORR_PARAMS, { name: 'lev05', wLev: 0.05 }) },
    { system: 'v1-allown', params: cloneTheoryParams(THEORY_V1_NOCORR_PARAMS, { name: 'allown', ownershipScope: 'all' }) },
    { system: 'v1-allown-p100', params: cloneTheoryParams(THEORY_V1_NOCORR_PARAMS, { name: 'allown-p100', ownershipScope: 'all', exposureCapPitcher: 1.0 }) },
    { system: 'v1-allown-noteam', params: cloneTheoryParams(THEORY_V1_NOCORR_PARAMS, { name: 'allown-noteam', ownershipScope: 'all', teamStackCap: 1.0 }) },
    { system: 'v1-allown-nt-p100', params: cloneTheoryParams(THEORY_V1_NOCORR_PARAMS, { name: 'allown-nt-p100', ownershipScope: 'all', teamStackCap: 1.0, exposureCapPitcher: 1.0 }) },
    { system: 'v1-stack001-all', params: cloneTheoryParams(THEORY_V1_NOCORR_PARAMS, { name: 'stack001-all', ownershipScope: 'all', stackBonusPerHitter: 0.01 }) },
    { system: 'v1-stack001-all-nt', params: cloneTheoryParams(THEORY_V1_NOCORR_PARAMS, { name: 'stack001-all-nt', ownershipScope: 'all', stackBonusPerHitter: 0.01, teamStackCap: 1.0 }) },
    { system: 'v1-stack001-hit', params: cloneTheoryParams(THEORY_V1_NOCORR_PARAMS, { name: 'stack001-hit', stackBonusPerHitter: 0.01 }) },
    { system: 'v1-noteamcap', params: cloneTheoryParams(THEORY_V1_NOCORR_PARAMS, { name: 'noteamcap', teamStackCap: 1.0 }) },
    { system: 'v1-pcap100', params: cloneTheoryParams(THEORY_V1_NOCORR_PARAMS, { name: 'pcap100', exposureCapPitcher: 1.0 }) },
    { system: 'v1-noteam-p100', params: cloneTheoryParams(THEORY_V1_NOCORR_PARAMS, { name: 'noteam-p100', teamStackCap: 1.0, exposureCapPitcher: 1.0 }) },
    { system: 'v1-tightcaps', params: cloneTheoryParams(THEORY_V1_NOCORR_PARAMS, { name: 'tightcaps', exposureCapHitter: 0.20, teamStackCap: 0.15 }) },
    { system: 'v1-over03', params: cloneTheoryParams(THEORY_V1_NOCORR_PARAMS, { name: 'over03', wGameOverload: 0.03 }) },
    { system: 'v1-field03', params: cloneTheoryParams(THEORY_V1_NOCORR_PARAMS, { name: 'field03', wStackField: 0.03 }) },
    { system: 'v1-struct03', params: cloneTheoryParams(THEORY_V1_NOCORR_PARAMS, { name: 'struct03', wStructure: 0.03 }) },
    {
      system: 'v1-principles-lite',
      params: cloneTheoryParams(THEORY_V1_NOCORR_PARAMS, {
        name: 'principles-lite',
        wLev: 0.15,
        wStructure: 0.03,
        wStackField: 0.02,
        wGameOverload: 0.03,
      }),
    },
    { system: 'v1-principles', params: THEORY_V1_PRINCIPLES_PARAMS },
  ];
}

function selectSlates(split: string, includeHoldout: boolean): SlateSpec[] {
  const normalized = split.trim().toLowerCase();
  if (normalized === 'dev') return SLATES.filter(s => !HOLDOUT.has(s.slate));
  if ((normalized === 'all' || normalized === 'holdout') && !includeHoldout) {
    throw new Error('Holdout access is blocked by default. Add --include-holdout to run this split intentionally.');
  }
  if (normalized === 'all') return SLATES;
  if (normalized === 'holdout') return SLATES.filter(s => HOLDOUT.has(s.slate));
  throw new Error(`Unknown --split "${split}". Use dev, all, or holdout.`);
}

function loadSlate(spec: SlateSpec): SlateData | null {
  const projPath = path.join(MLB_DIR, spec.proj);
  const actualsPath = path.join(MLB_DIR, spec.actuals);
  const poolPath = path.join(MLB_DIR, spec.pool);
  if (![projPath, actualsPath, poolPath].every(filePath => fs.existsSync(filePath))) return null;

  const parsed = parseCSVFile(projPath, 'mlb', true);
  const config = getContestConfig('dk', 'mlb', parsed.detectedContestType);
  const playerPool = buildPlayerPool(parsed.players, parsed.detectedContestType);
  const actuals = parseContestActuals(actualsPath, config);
  const playerMap = new Map<string, Player>();
  for (const player of playerPool.players) playerMap.set(player.id, player);
  const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap });

  let optimalProj = 0;
  for (const lineup of loaded.lineups) {
    if (lineup.projection > optimalProj) optimalProj = lineup.projection;
  }

  return {
    slate: spec.slate,
    candidates: loaded.lineups,
    players: playerPool.players,
    actuals,
    optimalProj,
  };
}

function evaluatePortfolio(
  system: string,
  selected: ReturnType<typeof selectTheoryV1Portfolio>['selected'],
  sd: SlateData,
  targetCount: number,
): EvalResult {
  const portfolio = selected.map(s => s.lineup);
  const F = sd.actuals.entries.length;
  const sortedActuals = sd.actuals.entries.map(entry => entry.actualPoints).sort((a, b) => b - a);
  const top1Threshold = sortedActuals[Math.max(0, Math.floor(F * 0.01) - 1)] || 0;
  const top01Threshold = sortedActuals[Math.max(0, Math.floor(F * 0.001) - 1)] || 0;
  const payoutTable = buildPayoutTable(Math.max(F, 100));

  let totalPayout = 0;
  let t1 = 0;
  let t01 = 0;
  let missingLineups = 0;

  for (const lineup of portfolio) {
    const score = scoreLineup(lineup, sd.actuals);
    if (score === null) {
      missingLineups++;
      continue;
    }

    const rank = rankScore(score, sortedActuals);
    if (score >= top1Threshold) t1++;
    if (score >= top01Threshold) t01++;
    const pay = rank <= payoutTable.length ? payoutTable[rank - 1] : 0;
    if (pay > 0) totalPayout += pay / chopAdjustment(score, sd.actuals);
  }

  const summary = summarizeTheoryPortfolio(selected);
  return {
    system,
    slate: sd.slate,
    lineups: portfolio.length,
    totalPayout,
    roi: targetCount > 0 ? totalPayout / (targetCount * FEE) - 1 : 0,
    t1,
    t01,
    missingLineups,
    avgProj: summary.avgProjection,
    avgOwnSum: summary.avgOwnershipSum,
    avgSalary: summary.avgSalary,
    pctPrimary4: summary.pctPrimary4,
    pctPrimary5Plus: summary.pctPrimary5Plus,
    pctBringBackGte1: summary.pctBringBackGte1,
    pctBringBackGte2: summary.pctBringBackGte2,
    pctNaked5Plus: summary.pctNaked5Plus,
    pctGameOverload8: summary.pctGameOverload8,
    poolOriginal: 0,
    poolFiltered: 0,
  };
}

function scoreLineup(lineup: Lineup, actuals: ContestActuals): number | null {
  let total = 0;
  for (const player of lineup.players) {
    const actual = actuals.playerActualsByName.get(norm(player.name));
    if (!actual) return null;
    total += actual.fpts;
  }
  return total;
}

function chopAdjustment(score: number, actuals: ContestActuals): number {
  let closeScores = 0;
  for (const entry of actuals.entries) {
    if (Math.abs(entry.actualPoints - score) <= 0.25) closeScores++;
  }
  const duplicatedFieldScores = Math.max(0, closeScores - 1);
  return Math.sqrt(1 + duplicatedFieldScores * 0.5);
}

function buildPayoutTable(fieldSize: number): Float64Array {
  const pool = fieldSize * FEE * 0.88;
  const cashLine = Math.floor(fieldSize * 0.22);
  const raw = new Float64Array(cashLine);
  let rawSum = 0;
  for (let rank = 0; rank < cashLine; rank++) {
    raw[rank] = Math.pow(rank + 1, -1.15);
    rawSum += raw[rank];
  }

  const table = new Float64Array(fieldSize);
  const minCash = FEE * 1.2;
  for (let rank = 0; rank < cashLine; rank++) {
    table[rank] = Math.max(minCash, (raw[rank] / rawSum) * pool);
  }

  let tableSum = 0;
  for (let rank = 0; rank < cashLine; rank++) tableSum += table[rank];
  const scale = tableSum > 0 ? pool / tableSum : 0;
  for (let rank = 0; rank < cashLine; rank++) table[rank] *= scale;

  return table;
}

function rankScore(score: number, sortedDesc: number[]): number {
  let lo = 0;
  let hi = sortedDesc.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedDesc[mid] >= score) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(1, lo);
}

function summarizeResults(results: EvalResult[], targetCount: number): SummaryResult {
  const lineups = results.reduce((sum, result) => sum + result.lineups, 0);
  const totalPayout = results.reduce((sum, result) => sum + result.totalPayout, 0);
  const t1 = results.reduce((sum, result) => sum + result.t1, 0);
  const t01 = results.reduce((sum, result) => sum + result.t01, 0);
  const fees = results.length * targetCount * FEE;
  const expectedTop1 = results.length * targetCount * 0.01;
  const expectedTop01 = results.length * targetCount * 0.001;

  return {
    system: results[0]?.system || 'none',
    slates: results.length,
    lineups,
    totalPayout,
    roi: fees > 0 ? totalPayout / fees - 1 : 0,
    t1,
    t01,
    t1Edge: expectedTop1 > 0 ? t1 / expectedTop1 : 0,
    t01Edge: expectedTop01 > 0 ? t01 / expectedTop01 : 0,
    missingLineups: results.reduce((sum, result) => sum + result.missingLineups, 0),
    avgProj: mean(results.map(result => result.avgProj)),
    avgOwnSum: mean(results.map(result => result.avgOwnSum)),
    avgSalary: mean(results.map(result => result.avgSalary)),
    pctPrimary4: mean(results.map(result => result.pctPrimary4)),
    pctPrimary5Plus: mean(results.map(result => result.pctPrimary5Plus)),
    pctBringBackGte1: mean(results.map(result => result.pctBringBackGte1)),
    pctBringBackGte2: mean(results.map(result => result.pctBringBackGte2)),
    pctNaked5Plus: mean(results.map(result => result.pctNaked5Plus)),
    pctGameOverload8: mean(results.map(result => result.pctGameOverload8)),
  };
}

function printSummary(summaries: SummaryResult[]): void {
  console.log('\n================================================================');
  console.log('SUMMARY');
  console.log('================================================================');
  console.log('System          | ROI     | t1x  | t01x | AvgProj | OwnSum | 4stk  | 5+stk | BB1+  | BB2+  | Naked5 | 8Game');
  console.log('-'.repeat(120));
  for (const s of summaries) {
    console.log(
      `${s.system.padEnd(15)} | ${(s.roi * 100).toFixed(1).padStart(6)}% | ` +
      `${s.t1Edge.toFixed(2).padStart(4)} | ${s.t01Edge.toFixed(2).padStart(4)} | ` +
      `${s.avgProj.toFixed(2).padStart(7)} | ${s.avgOwnSum.toFixed(1).padStart(6)} | ` +
      `${(s.pctPrimary4 * 100).toFixed(1).padStart(5)}% | ${(s.pctPrimary5Plus * 100).toFixed(1).padStart(5)}% | ` +
      `${(s.pctBringBackGte1 * 100).toFixed(1).padStart(5)}% | ${(s.pctBringBackGte2 * 100).toFixed(1).padStart(5)}% | ` +
      `${(s.pctNaked5Plus * 100).toFixed(1).padStart(6)}% | ${(s.pctGameOverload8 * 100).toFixed(1).padStart(5)}%`
    );
  }
}

function writeOutput(
  results: EvalResult[],
  summaries: SummaryResult[],
  split: string,
  targetCount: number,
): void {
  const output = {
    createdAt: new Date().toISOString(),
    split,
    targetCount,
    holdoutSlates: Array.from(HOLDOUT),
    summaries,
    perSlate: results,
  };
  const outPath = path.join(OUT_DIR, `v1_principles_validation_${split}_${targetCount}.json`);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`\nSaved validation results to ${outPath}`);
}

function norm(name: string): string {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function readArg(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
    if (arg === `--${name}` && i + 1 < argv.length) return argv[i + 1];
  }
  return undefined;
}

function readNumberArg(argv: string[], name: string): number | undefined {
  const raw = readArg(argv, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} must be numeric`);
  return value;
}

main().catch(err => {
  console.error('FAILED:', err);
  process.exit(1);
});
