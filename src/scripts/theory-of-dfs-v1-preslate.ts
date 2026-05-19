/**
 * Theory-DFS V1 pre-slate runner.
 *
 * Default mode is the deployed V1-NoCorr system. The optional "principles"
 * challenger keeps NoCorr as the base and adds small, explicit priors from the
 * research notes:
 *   - lineup leverage is hitter-only and lighter
 *   - stack integrity matters more than raw stack forcing
 *   - field-familiar stack teams get a small prior
 *   - 7/8 hitter one-game overloads are penalized
 *
 * Usage examples:
 *   npx ts-node src/scripts/theory-of-dfs-v1-preslate.ts --variant nocorr --n 150
 *   npx ts-node src/scripts/theory-of-dfs-v1-preslate.ts --variant revival --n 150
 *   npx ts-node src/scripts/theory-of-dfs-v1-preslate.ts --variant principles --n 150
 *   npx ts-node src/scripts/theory-of-dfs-v1-preslate.ts --pools sspool1pre.csv,sspool2pre.csv
 */

import * as fs from 'fs';
import * as path from 'path';
import { stringify } from 'csv-stringify/sync';
import { ContestConfig, Lineup, Player } from '../types';
import { buildPlayerPool, loadPoolFromCSV, parseCSVFile } from '../parser';
import { getContestConfig } from '../rules';
import { exportForDraftKings } from '../scoring';
import {
  ScoredTheoryLineup,
  THEORY_V1_NOCORR_PARAMS,
  THEORY_V1_PITCHER_UNCAP_PARAMS,
  THEORY_V1_PRINCIPLES_PARAMS,
  THEORY_V1_REVIVAL_PARAMS,
  TheoryV1Params,
  cloneTheoryParams,
  selectTheoryV1Portfolio,
  summarizeTheoryPortfolio,
} from '../theory/v1-selector';

type VariantName = 'nocorr' | 'principles' | 'revival' | 'pitcher-uncap';

interface PreslateArgs {
  dataDir: string;
  projectionsFile: string;
  poolFiles: string[];
  targetCount: number;
  variant: VariantName;
  outPrefix: string;
  outTag: string;
  overrides: Partial<TheoryV1Params>;
}

const DEFAULT_DATA_DIR = 'C:/Users/colin/dfs opto';
const DEFAULT_PROJECTIONS = 'mlbdkprojpre.csv';
const DEFAULT_POOLS = ['sspool1pre.csv', 'sspool2pre.csv'];
const FRESH_POOL_WINDOW_MS = 8 * 60 * 60 * 1000;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const baseParams = paramsForVariant(args.variant);
  const params = cloneTheoryParams(baseParams, args.overrides);

  console.log('================================================================');
  console.log('THEORY-DFS V1 PRE-SLATE');
  console.log('================================================================');
  console.log(`Variant: ${args.variant}`);
  console.log(`Lineups: ${args.targetCount}`);
  console.log(`Data dir: ${args.dataDir}`);
  console.log(`Projection file: ${args.projectionsFile}`);
  console.log(`Pool files: ${args.poolFiles.join(', ')}`);
  console.log(`Weights: proj=${params.wProj} lev=${params.wLev} var=${params.wVar} cmb=${params.wCmb} structure=${params.wStructure} stackField=${params.wStackField} overload=${params.wGameOverload}`);
  console.log(`Constraints: hitterCap=${params.exposureCapHitter} pitcherCap=${params.exposureCapPitcher} teamStackCap=${params.teamStackCap} maxOverlap=${params.maxPairwiseOverlap}`);
  console.log('================================================================\n');

  const { candidates, config } = loadInputs(args);
  const result = selectTheoryV1Portfolio(candidates, args.targetCount, params);
  const summary = summarizeTheoryPortfolio(result.selected);

  printPortfolioSummary(summary, result.diagnostics);

  const outputStem = outputStemFor(args);
  const uploadPath = path.join(args.dataDir, `${outputStem}.csv`);
  const detailPath = path.join(args.dataDir, `${outputStem}_detailed.csv`);

  exportForDraftKings(result.portfolio, config, uploadPath);
  exportDetailedTheoryLineups(result.selected, config, detailPath);

  console.log('\n================================================================');
  console.log('DONE - Theory-DFS V1 preslate');
  console.log('================================================================');
  console.log(`DK upload: ${uploadPath}`);
  console.log(`Detail:    ${detailPath}`);
}

function loadInputs(args: PreslateArgs): { candidates: Lineup[]; config: ContestConfig } {
  const projPath = path.join(args.dataDir, args.projectionsFile);
  console.log(`Loading projections: ${projPath}`);
  const parsed = parseCSVFile(projPath, 'mlb', true);
  const config = getContestConfig('dk', 'mlb', parsed.detectedContestType);
  const playerPool = buildPlayerPool(parsed.players, parsed.detectedContestType);
  console.log(`Players: ${playerPool.players.length}`);

  const playerMap = new Map<string, Player>();
  for (const player of playerPool.players) playerMap.set(player.id, player);

  const merged = new Map<string, Lineup>();
  let totalLoaded = 0;

  for (const poolFile of args.poolFiles) {
    const poolPath = path.join(args.dataDir, poolFile);
    if (!fs.existsSync(poolPath)) {
      console.log(`Skipping missing pool: ${poolFile}`);
      continue;
    }

    const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap });
    totalLoaded += loaded.lineups.length;
    for (const lineup of loaded.lineups) {
      if (!merged.has(lineup.hash)) merged.set(lineup.hash, lineup);
    }
    console.log(`${poolFile}: ${loaded.lineups.length} lineups (${loaded.unresolvedRows} unresolved)`);
  }

  const candidates = Array.from(merged.values());
  if (candidates.length === 0) {
    throw new Error('No candidate lineups loaded. Check --pools and projection file IDs.');
  }

  console.log(`Merged pool: ${candidates.length} unique lineups from ${totalLoaded} loaded rows\n`);
  return { candidates, config };
}

function parseArgs(argv: string[]): PreslateArgs {
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelpAndExit();
  }

  const variantRaw = readArg(argv, 'variant') || process.env.V1_VARIANT || 'nocorr';
  const variant = parseVariant(variantRaw);
  const defaultPrefix = variant === 'nocorr' ? 'theory_dfs_v1' : `theory_dfs_v1_${variant.replace('-', '_')}`;
  const dataDir = readArg(argv, 'data-dir') || process.env.V1_DATA_DIR || DEFAULT_DATA_DIR;
  const projectionsFile = readArg(argv, 'projections') || process.env.V1_PROJ_FILE || DEFAULT_PROJECTIONS;
  const explicitPoolString = readArg(argv, 'pools') || process.env.V1_POOL_FILES;

  const overrides: Partial<TheoryV1Params> = {};
  applyNumberOverride(argv, overrides, 'w-lev', 'wLev');
  applyNumberOverride(argv, overrides, 'w-structure', 'wStructure');
  applyNumberOverride(argv, overrides, 'w-stack-field', 'wStackField');
  applyNumberOverride(argv, overrides, 'w-overload', 'wGameOverload');
  applyNumberOverride(argv, overrides, 'hitter-cap', 'exposureCapHitter');
  applyNumberOverride(argv, overrides, 'pitcher-cap', 'exposureCapPitcher');
  applyNumberOverride(argv, overrides, 'team-cap', 'teamStackCap');
  applyNumberOverride(argv, overrides, 'overlap', 'maxPairwiseOverlap');

  return {
    dataDir,
    projectionsFile,
    poolFiles: explicitPoolString
      ? explicitPoolString.split(',').map(item => item.trim()).filter(Boolean)
      : discoverFreshPoolFiles(dataDir, projectionsFile),
    targetCount: readNumberArg(argv, 'n') || readEnvNumber('V1_TARGET_COUNT') || 150,
    variant,
    outPrefix: readArg(argv, 'out-prefix') || defaultPrefix,
    outTag: readArg(argv, 'out-tag') || '',
    overrides,
  };
}

function discoverFreshPoolFiles(dataDir: string, projectionsFile: string): string[] {
  const projPath = path.join(dataDir, projectionsFile);
  if (!fs.existsSync(projPath)) return DEFAULT_POOLS;

  const projTime = fs.statSync(projPath).mtimeMs;
  const candidates = fs.readdirSync(dataDir)
    .filter(name => /^sspool.*pre\.csv$/i.test(name))
    .filter(name => {
      const fileTime = fs.statSync(path.join(dataDir, name)).mtimeMs;
      return Math.abs(fileTime - projTime) <= FRESH_POOL_WINDOW_MS;
    })
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

  return candidates.length > 0 ? candidates : DEFAULT_POOLS;
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

function readEnvNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be numeric`);
  return value;
}

function applyNumberOverride<T extends keyof TheoryV1Params>(
  argv: string[],
  target: Partial<TheoryV1Params>,
  argName: string,
  key: T,
): void {
  const value = readNumberArg(argv, argName);
  if (value !== undefined) {
    target[key] = value as TheoryV1Params[T];
  }
}

function parseVariant(raw: string): VariantName {
  const value = raw.trim().toLowerCase();
  if (value === 'nocorr' || value === 'no-corr' || value === 'v1') return 'nocorr';
  if (value === 'principles' || value === 'math' || value === 'v1-principles') return 'principles';
  if (value === 'revival' || value === 'v1-revival' || value === 'stack001-all') return 'revival';
  if (value === 'pitcher-uncap' || value === 'pcap100' || value === 'pitcheruncap') return 'pitcher-uncap';
  throw new Error(`Unknown --variant "${raw}". Use nocorr, revival, pitcher-uncap, or principles.`);
}

function paramsForVariant(variant: VariantName): TheoryV1Params {
  if (variant === 'principles') return THEORY_V1_PRINCIPLES_PARAMS;
  if (variant === 'revival') return THEORY_V1_REVIVAL_PARAMS;
  if (variant === 'pitcher-uncap') return THEORY_V1_PITCHER_UNCAP_PARAMS;
  return THEORY_V1_NOCORR_PARAMS;
}

function outputStemFor(args: PreslateArgs): string {
  const parts = [args.outPrefix, 'preslate'];
  if (args.outTag) parts.push(args.outTag);
  parts.push(String(args.targetCount));
  return parts.join('_');
}

function printPortfolioSummary(
  summary: ReturnType<typeof summarizeTheoryPortfolio>,
  diagnostics: { filteredCount: number; originalCount: number; selectedCount: number; targetCount: number; highSelected: number; midSelected: number; lowSelected: number; fallbackSelected: number; relaxedOverlapAttempts: number },
): void {
  console.log('================================================================');
  console.log('PORTFOLIO STATS');
  console.log('================================================================');
  console.log(`Lineups: ${diagnostics.selectedCount}/${diagnostics.targetCount}`);
  console.log(`Pool after min-stack filter: ${diagnostics.filteredCount}/${diagnostics.originalCount}`);
  console.log(`Band fill: high=${diagnostics.highSelected} mid=${diagnostics.midSelected} low=${diagnostics.lowSelected} fallback=${diagnostics.fallbackSelected}`);
  console.log(`Relaxed overlap attempts: ${diagnostics.relaxedOverlapAttempts}`);
  console.log('');
  console.log(`Avg projection: ${summary.avgProjection.toFixed(2)}`);
  console.log(`Avg ownership:  ${summary.avgOwnership.toFixed(2)}% avg, ${summary.avgOwnershipSum.toFixed(1)} sum`);
  console.log(`Avg salary:     $${summary.avgSalary.toFixed(0)}`);
  console.log(`Stack mix:      4-stack ${(summary.pctPrimary4 * 100).toFixed(1)}%, 5+ ${(summary.pctPrimary5Plus * 100).toFixed(1)}%`);
  console.log(`Bring-backs:    >=1 ${(summary.pctBringBackGte1 * 100).toFixed(1)}%, >=2 ${(summary.pctBringBackGte2 * 100).toFixed(1)}%`);
  console.log(`Risk flags:     naked 5+ ${(summary.pctNaked5Plus * 100).toFixed(1)}%, 8-hitter game ${(summary.pctGameOverload8 * 100).toFixed(1)}%`);
  console.log(`Unique players: ${summary.uniquePlayers}`);

  console.log('\nTeam stacks:');
  for (const item of summary.stackCounts.slice(0, 20)) {
    console.log(`  ${item.team.padEnd(5)} ${String(item.count).padStart(3)} lineups (${(item.pct * 100).toFixed(1)}%)`);
  }

  console.log('\nTop 15 player exposures:');
  for (const item of summary.topExposures.slice(0, 15)) {
    console.log(`  ${item.name.padEnd(25)} ${item.team.padEnd(5)} ${item.position.padEnd(5)} ${(item.pct * 100).toFixed(1).padStart(5)}% (${item.count}/${summary.lineups}) own=${item.ownership.toFixed(1)} proj=${item.projection.toFixed(1)}`);
  }
}

function exportDetailedTheoryLineups(
  selected: ScoredTheoryLineup[],
  config: ContestConfig,
  outputPath: string,
): void {
  console.log(`\nExporting detailed Theory V1 data to ${outputPath}`);
  const headers: string[] = [];
  for (const position of config.positions) {
    headers.push(`${position.name}_ID`);
    headers.push(`${position.name}_Name`);
    headers.push(`${position.name}_Team`);
    headers.push(`${position.name}_Pos`);
    headers.push(`${position.name}_Salary`);
    headers.push(`${position.name}_Proj`);
    headers.push(`${position.name}_Own`);
  }

  headers.push(
    'Total_Projection',
    'Total_Salary',
    'Avg_Ownership',
    'Ownership_Sum',
    'Primary_Team',
    'Primary_Size',
    'Secondary_Size',
    'Bring_Back',
    'Pitcher_Vs_Hitter',
    'Max_Game_Hitters',
    'Floor',
    'Ceiling',
    'Range',
    'EV',
    'Proj_Pct',
    'Own_Pct',
    'Range_Pct',
    'PPD_Pct',
    'Uniq_Pct',
    'Structure_Pct',
    'Stack_Field_Pct',
    'Game_Overload_Pct',
    'Combo_Uniqueness',
    'PPD',
  );

  const rows = selected.map((scored) => {
    const lineup = scored.lineup;
    const row: string[] = [];
    for (const player of lineup.players) {
      row.push(player.id);
      row.push(player.name);
      row.push(player.team || '');
      row.push(player.position || '');
      row.push(String(player.salary || 0));
      row.push((player.projection || 0).toFixed(2));
      row.push((player.ownership || 0).toFixed(2));
    }

    const ownershipSum = lineup.players.reduce((sum, player) => sum + (player.ownership || 0), 0);
    row.push(
      lineup.projection.toFixed(2),
      String(lineup.salary),
      (lineup.ownership || 0).toFixed(2),
      ownershipSum.toFixed(2),
      scored.primaryTeam,
      String(scored.primarySize),
      String(scored.secondarySize),
      String(scored.bringBack),
      String(scored.pitcherVsHitterCount),
      String(scored.maxGameHitters),
      scored.floor.toFixed(2),
      scored.ceiling.toFixed(2),
      scored.range.toFixed(2),
      scored.ev.toFixed(6),
      scored.projPct.toFixed(6),
      scored.ownPct.toFixed(6),
      scored.rangePct.toFixed(6),
      scored.ppdPct.toFixed(6),
      scored.uniqPct.toFixed(6),
      scored.structurePct.toFixed(6),
      scored.stackFieldPct.toFixed(6),
      scored.gameOverloadPct.toFixed(6),
      scored.uniqueness.toFixed(4),
      scored.ppd.toFixed(4),
    );
    return row;
  });

  fs.writeFileSync(outputPath, stringify([headers, ...rows]), 'utf-8');
  console.log(`Exported detailed data to ${outputPath}`);
}

function printHelpAndExit(): never {
  console.log(`Theory-DFS V1 preslate

Options:
  --variant nocorr|revival|pitcher-uncap|principles
  --n 150
  --data-dir "C:/Users/colin/dfs opto"
  --projections mlbdkprojpre.csv
  --pools sspool1pre.csv,sspool2pre.csv
  --out-tag slate-name
  --w-lev 0.10
  --w-structure 0.10
  --w-stack-field 0.05
  --w-overload 0.08
  --hitter-cap 0.25
  --pitcher-cap 0.45
  --team-cap 0.20
  --overlap 6
`);
  process.exit(0);
}

main().catch(err => {
  console.error('FAILED:', err);
  process.exit(1);
});
