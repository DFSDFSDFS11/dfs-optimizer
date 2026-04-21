/**
 * Full-analysis orchestrator — sim-backed lineup + portfolio + pool analysis.
 *
 * runFullAnalysis(inputs, ...) produces a FullSlateAnalysis combining:
 *   • Part 1: lineup-level profiles + separation + quintile binning
 *   • Part 2: per-pro + our-v24 portfolio sim (E[max], coverage, gain curve)
 *   • Part 3: SS pool-as-portfolio
 *
 * runFullCalibration aggregates across all historical slates → cross-slate
 * research validation + metric ranking + prioritized actions.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Sport, DFSSite, Lineup } from '../../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV } from '../../parser';
import { getContestConfig } from '../../rules';
import {
  DEFAULT_SELECTOR_PARAMS,
  SelectorParams,
  defaultGamma,
  getSportDefaults,
  precomputeSlate,
  SlatePrecomputation,
} from '../../selection/algorithm7-selector';
import { analyzeWinners, WinnerAnatomy } from '../winner-anatomy';
import { analyzeField, FieldAnalysis } from '../field-structure';
import { buildNameToPlayerMap, detectPros, entriesToLineups } from '../common';
import { analyzeLineupLevel, LineupLevelAnalysis } from './lineup-profiles';
import { analyzePortfolioSim, PortfolioSim } from './portfolio-sim';
import { analyzePoolAsPortfolio, PoolAsPortfolioAnalysis } from './pool-as-portfolio';
import { buildFullCrossSlate, FullCrossSlateReport } from './research-validation';
import { SlateInputs, discoverSlates } from '../index';

export interface ProPortfolioResult {
  username: string;
  entryCount: number;
  top1Hits: number;
  top1Rate: number;
  top5Rate: number;
  bestRank: number;
  avgActual: number;
  sim: PortfolioSim;
}

export interface FullSlateAnalysis {
  slate: string;
  sport: Sport;
  site: DFSSite;
  numGames: number;

  winnerAnatomy: WinnerAnatomy;
  fieldAnalysis: FieldAnalysis;
  lineupLevel: LineupLevelAnalysis;

  pros: {
    prosDetected: number;
    minEntriesThreshold: number;
    proPortfolios: ProPortfolioResult[];
  };

  poolAsPortfolio: PoolAsPortfolioAnalysis | null;
}

// ============================================================
// SINGLE SLATE
// ============================================================

export async function runFullAnalysis(
  inputs: SlateInputs,
  site: DFSSite,
  sport: Sport,
  options: { minProEntries?: number; numWorlds?: number } = {},
): Promise<FullSlateAnalysis | null> {
  const minProEntries = options.minProEntries ?? 100;
  const numWorlds = options.numWorlds ?? 2000;

  // 1. Parse projections + actuals
  const parseResult = parseCSVFile(inputs.projectionsPath, sport, true);
  const config = getContestConfig(site, sport, parseResult.detectedContestType);
  const pool = buildPlayerPool(parseResult.players, parseResult.detectedContestType);
  const actuals = parseContestActuals(inputs.actualsPath, config);

  // 2. Join field
  const nameMap = buildNameToPlayerMap(pool.players);
  const joined = entriesToLineups(actuals.entries, nameMap);
  if (joined.lineups.length < 100) {
    console.warn(`  [${inputs.slate}] joined field too small — skipping`);
    return null;
  }

  // 3. Optional pool load
  let poolLineups: Lineup[] | null = null;
  if (inputs.poolCsvPath && fs.existsSync(inputs.poolCsvPath)) {
    const idMap = new Map(pool.players.map(p => [p.id, p] as const));
    try {
      const loaded = loadPoolFromCSV({ filePath: inputs.poolCsvPath, config, playerMap: idMap });
      poolLineups = loaded.lineups;
    } catch (err) {
      console.warn(`  pool load failed: ${(err as Error).message}`);
    }
  }

  // 4. Build precomp for sim (candidates = field-subsample for speed, field = field)
  const params: SelectorParams = {
    ...DEFAULT_SELECTOR_PARAMS,
    ...getSportDefaults(sport),
    N: 150,
    gamma: defaultGamma(config.rosterSize),
    numWorlds,
  };

  console.log(`  running precomputeSlate (W=${numWorlds}, field=${joined.lineups.length})…`);
  const t0 = Date.now();
  const precomp = precomputeSlate(joined.lineups, joined.lineups, pool.players, params, sport);
  console.log(`  precompute: ${Date.now() - t0} ms (W=${precomp.W} P=${precomp.P} C=${precomp.C} F=${precomp.F})`);

  // 5. Basic modules (from existing pipeline)
  const hashScores = joined.actualByHash;
  const winnerAnatomy = analyzeWinners(
    inputs.slate, joined.lineups, joined.entryHashes, actuals, hashScores, pool.players, sport, config.salaryCap,
  );
  const fieldAnalysis = analyzeField(joined.lineups, joined.entryHashes, actuals, hashScores, pool.players, sport);

  // 6. Part 1: lineup-level analysis (uses precomp world scores)
  console.log(`  part 1: lineup profiles…`);
  const t1 = Date.now();
  const lineupLevel = analyzeLineupLevel(
    joined.lineups, poolLineups, joined.entryHashes, actuals.entries, hashScores, precomp, sport,
  );
  console.log(`  part 1 done: ${Date.now() - t1} ms`);

  // 7. Part 2: pro portfolio sim
  const pros = detectPros(actuals.entries, minProEntries);
  const hashToLineup = new Map<string, Lineup>();
  for (const l of joined.lineups) hashToLineup.set(l.hash, l);

  const fieldOwnership = new Map<string, number>();
  const countsById = new Map<string, number>();
  for (const l of joined.lineups) for (const p of l.players) countsById.set(p.id, (countsById.get(p.id) || 0) + 1);
  for (const [id, c] of countsById) fieldOwnership.set(id, c / joined.lineups.length);

  const gameSet = new Set<string>();
  for (const p of pool.players) gameSet.add(p.gameInfo || `${p.team}_game`);
  const numGames = gameSet.size;

  const idxByEntryId = new Map<string, number>();
  for (let i = 0; i < actuals.entries.length; i++) idxByEntryId.set(actuals.entries[i].entryId, i);

  console.log(`  part 2: pro portfolio sims (${pros.length} pros)…`);
  const t2 = Date.now();
  const proPortfolios: ProPortfolioResult[] = [];
  const sortedActuals = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
  const top1T = sortedActuals[Math.max(0, Math.floor(sortedActuals.length * 0.01) - 1)] || 0;
  const top5T = sortedActuals[Math.max(0, Math.floor(sortedActuals.length * 0.05) - 1)] || 0;

  // Only analyze the top ~15 most-entered pros for speed
  const prosToAnalyze = pros.slice(0, 15);
  for (const pro of prosToAnalyze) {
    const lineups: Lineup[] = [];
    let top1 = 0, top5 = 0, sumActual = 0, bestRank = Infinity;
    for (const e of pro.entries) {
      const idx = idxByEntryId.get(e.entryId);
      if (idx === undefined) continue;
      const h = joined.entryHashes[idx];
      if (!h) continue;
      const l = hashToLineup.get(h);
      if (!l) continue;
      lineups.push(l);
      sumActual += e.actualPoints;
      if (e.rank < bestRank) bestRank = e.rank;
      if (e.actualPoints >= top1T) top1++;
      if (e.actualPoints >= top5T) top5++;
    }
    if (lineups.length < 20) continue;
    const sim = analyzePortfolioSim(pro.username, lineups, precomp, fieldOwnership, numGames, sport);
    if (!sim) continue;
    proPortfolios.push({
      username: pro.username,
      entryCount: lineups.length,
      top1Hits: top1,
      top1Rate: top1 / lineups.length,
      top5Rate: top5 / lineups.length,
      bestRank: bestRank === Infinity ? sortedActuals.length : bestRank,
      avgActual: sumActual / lineups.length,
      sim,
    });
  }
  proPortfolios.sort((a, b) => b.top1Rate - a.top1Rate);
  console.log(`  part 2 done: ${Date.now() - t2} ms (${proPortfolios.length} pros analyzed)`);

  // 8. Part 3: pool-as-portfolio
  let poolAsPortfolio: PoolAsPortfolioAnalysis | null = null;
  if (poolLineups && poolLineups.length > 50) {
    console.log(`  part 3: pool-as-portfolio (pool size ${poolLineups.length})…`);
    const t3 = Date.now();
    const top1Hashes = new Set<string>();
    for (let i = 0; i < actuals.entries.length; i++) {
      if (actuals.entries[i].actualPoints >= top1T) {
        const h = joined.entryHashes[i];
        if (h) top1Hashes.add(h);
      }
    }
    poolAsPortfolio = analyzePoolAsPortfolio(
      poolLineups, joined.lineups, fieldOwnership, precomp,
      winnerAnatomy, hashScores, top1Hashes, pool.players, numGames, sport,
    );
    console.log(`  part 3 done: ${Date.now() - t3} ms`);
  }

  return {
    slate: inputs.slate,
    sport,
    site,
    numGames,
    winnerAnatomy,
    fieldAnalysis,
    lineupLevel,
    pros: {
      prosDetected: pros.length,
      minEntriesThreshold: minProEntries,
      proPortfolios,
    },
    poolAsPortfolio,
  };
}

// ============================================================
// CROSS-SLATE
// ============================================================

export async function runFullCalibration(
  dataDir: string,
  site: DFSSite,
  sport: Sport,
  options: { minProEntries?: number; numWorlds?: number } = {},
): Promise<{ perSlate: FullSlateAnalysis[]; crossSlate: FullCrossSlateReport }> {
  const slateInputs = discoverSlates(dataDir);
  console.log(`Discovered ${slateInputs.length} slates for full-calibration`);
  const perSlate: FullSlateAnalysis[] = [];
  for (const s of slateInputs) {
    try {
      console.log(`\n— Running full analysis on ${s.slate} —`);
      const r = await runFullAnalysis(s, site, sport, options);
      if (r) perSlate.push(r);
    } catch (err) {
      console.warn(`  Error on ${s.slate}: ${(err as Error).message}`);
    }
  }
  const crossSlate = buildFullCrossSlate(perSlate);
  return { perSlate, crossSlate };
}

// Re-exports
export * from './lineup-profiles';
export * from './portfolio-sim';
export * from './pool-as-portfolio';
export * from './research-validation';
