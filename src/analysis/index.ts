/**
 * Backtest Intelligence orchestrator.
 *
 * Exports:
 *   • analyzeSlate(...)       — run Modules 1-4 on a single slate
 *   • analyzeAllSlates(...)   — run analyzeSlate across a directory + Module 5
 *   • generateCalibrationReport(...) — write markdown + JSON output
 *
 * Integrates with run.ts via --analyze-slate and --analyze-all flags.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ContestConfig, Sport, DFSSite } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';
import { WinnerAnatomy, analyzeWinners } from './winner-anatomy';
import { FieldAnalysis, analyzeField } from './field-structure';
import { ProAnalysis, analyzeProPortfolios } from './pro-portfolios';
import { PoolGapAnalysis, analyzePoolGaps } from './pool-gap';
import { CrossSlateReport, analyzeCrossSlate } from './cross-slate';
import { buildNameToPlayerMap, entriesToLineups } from './common';

// ============================================================
// TYPES
// ============================================================

export interface SlateAnalysis {
  slate: string;
  sport: Sport;
  site: DFSSite;
  config: ContestConfig;
  numGames: number;
  winnerAnatomy: WinnerAnatomy;
  fieldAnalysis: FieldAnalysis;
  proAnalysis: ProAnalysis | null;
  poolGap: PoolGapAnalysis | null;
}

export interface SlateInputs {
  slate: string;
  projectionsPath: string;
  actualsPath: string;
  poolCsvPath?: string;
}

// ============================================================
// SINGLE SLATE
// ============================================================

export async function analyzeSlate(
  inputs: SlateInputs,
  site: DFSSite,
  sport: Sport,
  options: { minProEntries?: number } = {},
): Promise<SlateAnalysis | null> {
  const minProEntries = options.minProEntries ?? 100;

  // 1. Parse projections + actuals
  const parseResult = parseCSVFile(inputs.projectionsPath, sport, true);
  const config = getContestConfig(site, sport, parseResult.detectedContestType);
  const pool = buildPlayerPool(parseResult.players, parseResult.detectedContestType);
  const actuals = parseContestActuals(inputs.actualsPath, config);

  // 2. Join contest entries to lineups
  const nameMap = buildNameToPlayerMap(pool.players);
  const joined = entriesToLineups(actuals.entries, nameMap);

  if (joined.lineups.length < 100) {
    console.warn(`  [${inputs.slate}] joined field too small (${joined.lineups.length}) — skipping`);
    return null;
  }

  // 3. hashScores map for fast lineup actual lookup
  const hashScores = joined.actualByHash;

  // 4. Count distinct games
  const gameSet = new Set<string>();
  for (const p of pool.players) gameSet.add(p.gameInfo || `${p.team}_game`);
  const numGames = gameSet.size;

  // 5. Module 1: winner anatomy
  const winnerAnatomy = analyzeWinners(
    inputs.slate,
    joined.lineups,
    joined.entryHashes,
    actuals,
    hashScores,
    pool.players,
    sport,
    config.salaryCap,
  );

  // 6. Module 3: field structure
  const fieldAnalysis = analyzeField(
    joined.lineups,
    joined.entryHashes,
    actuals,
    hashScores,
    pool.players,
    sport,
  );

  // 7. Module 2: pro portfolios (auto-detect)
  let proAnalysis: ProAnalysis | null = null;
  try {
    proAnalysis = analyzeProPortfolios(
      joined.lineups,
      joined.entryHashes,
      actuals,
      hashScores,
      pool.players,
      sport,
      minProEntries,
    );
  } catch (err) {
    console.warn(`  [${inputs.slate}] pro analysis failed: ${(err as Error).message}`);
  }

  // 8. Module 4: pool gap (if pool provided)
  let poolGap: PoolGapAnalysis | null = null;
  if (inputs.poolCsvPath && fs.existsSync(inputs.poolCsvPath)) {
    try {
      const idMap = new Map(pool.players.map(p => [p.id, p] as const));
      const loaded = loadPoolFromCSV({
        filePath: inputs.poolCsvPath,
        config,
        playerMap: idMap,
      });
      // Build top-1% hash set
      const top1Hashes = new Set<string>();
      const thr = winnerAnatomy.top1Threshold;
      for (let i = 0; i < actuals.entries.length; i++) {
        if (actuals.entries[i].actualPoints >= thr) {
          const h = joined.entryHashes[i];
          if (h) top1Hashes.add(h);
        }
      }
      poolGap = analyzePoolGaps(loaded.lineups, winnerAnatomy, top1Hashes, hashScores, sport);
    } catch (err) {
      console.warn(`  [${inputs.slate}] pool gap analysis failed: ${(err as Error).message}`);
    }
  }

  return {
    slate: inputs.slate,
    sport,
    site,
    config,
    numGames,
    winnerAnatomy,
    fieldAnalysis,
    proAnalysis,
    poolGap,
  };
}

// ============================================================
// MULTI-SLATE
// ============================================================

export async function analyzeAllSlates(
  dataDir: string,
  site: DFSSite,
  sport: Sport,
  options: { minProEntries?: number } = {},
): Promise<{ perSlate: SlateAnalysis[]; crossSlate: CrossSlateReport }> {
  const slateInputs = discoverSlates(dataDir);
  if (slateInputs.length === 0) {
    console.warn(`No slates found in ${dataDir}`);
    return { perSlate: [], crossSlate: analyzeCrossSlate([]) };
  }

  console.log(`Discovered ${slateInputs.length} slates in ${dataDir}`);
  const perSlate: SlateAnalysis[] = [];
  for (const s of slateInputs) {
    try {
      console.log(`\nAnalyzing ${s.slate}…`);
      const r = await analyzeSlate(s, site, sport, options);
      if (r) perSlate.push(r);
    } catch (err) {
      console.warn(`  Error on ${s.slate}: ${(err as Error).message}`);
    }
  }

  const crossSlate = analyzeCrossSlate(perSlate);
  return { perSlate, crossSlate };
}

export function discoverSlates(dataDir: string): SlateInputs[] {
  if (!fs.existsSync(dataDir)) return [];
  const files = fs.readdirSync(dataDir);
  const slates: SlateInputs[] = [];

  // Pattern A (historical_slates/): YYYY-MM-DD[_dk[_night]]_projections.csv
  const longRe = /^(\d{4}-\d{2}-\d{2})(?:_dk(?:_night)?)?_projections\.csv$/;
  // Pattern B (loose "dfs opto" folder): M-D-YY[-suffix]projections.csv (no underscore, optional hyphens)
  const shortRe = /^(\d{1,2}-\d{1,2}-\d{2,4})[-_]?(.*)?projections\.csv$/i;

  for (const f of files) {
    let slate: string | null = null;
    let actualsCandidates: string[] = [];
    let poolCandidates: string[] = [];

    const mLong = f.match(longRe);
    if (mLong) {
      const date = mLong[1];
      const isDkNight = f.includes('_dk_night_');
      const isDk = f.includes('_dk_');
      const baseName = isDkNight ? `${date}_dk_night` : isDk ? `${date}_dk` : date;
      slate = baseName;
      actualsCandidates = [`${baseName}_actuals.csv`];
      poolCandidates = [`${baseName}_pool.csv`, `${baseName}_sspool.csv`, `${date}_pool.csv`];
    } else {
      const mShort = f.match(shortRe);
      if (mShort) {
        const date = mShort[1];
        slate = date;
        actualsCandidates = [
          `${date}actuals.csv`, `${date}_actuals.csv`, `${date}-actuals.csv`,
          `dkactuals ${date}.csv`,  // allow "dkactuals 4-6-26.csv"
        ];
        poolCandidates = [
          `${date}sspool.csv`, `${date}_sspool.csv`, `${date}-sspool.csv`,
          `sspool${date}.csv`,
          `${date}pool.csv`,
        ];
      }
    }

    if (!slate) continue;
    const actualsMatch = actualsCandidates.find(c => files.includes(c));
    if (!actualsMatch) continue;
    const poolMatch = poolCandidates.find(c => files.includes(c));

    slates.push({
      slate,
      projectionsPath: path.join(dataDir, f),
      actualsPath: path.join(dataDir, actualsMatch),
      poolCsvPath: poolMatch ? path.join(dataDir, poolMatch) : undefined,
    });
  }
  return slates.sort((a, b) => a.slate.localeCompare(b.slate));
}

// ============================================================
// REPORT GENERATION
// ============================================================

export { generateCalibrationReport } from './calibration-report';
