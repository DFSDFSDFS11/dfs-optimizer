/**
 * DFS Optimizer - Formula Calibration & Pro Comparison Module
 *
 * Analyzes historical slates to optimize scoring formula weights
 * by comparing against ACTUAL contest results.
 *
 * KEY CONCEPT:
 * - Parse DraftKings contest results (actual winning lineups)
 * - Score those lineups with our formula components
 * - Calculate correlation: which components predict actual success?
 * - Components with HIGH correlation with actual rank = INCREASE weight
 * - Components with LOW/NEGATIVE correlation = DECREASE or REMOVE
 *
 * Usage:
 *   node dist/run.js --calibrate --data ./historical_slates/
 *
 * Expected file structure:
 *   ./historical_slates/
 *     2024-01-15_projections.csv  (SaberSim export with projections)
 *     2024-01-15_actuals.csv      (DraftKings contest results export)
 *     ...
 *
 * DraftKings Contest Export Format (the _actuals.csv file):
 *   Rank,EntryId,EntryName,TimeRemaining,Points,Lineup,...
 *   1,5049604632,Maddking,0,369.5,C Jock Landale F Zion Williamson...
 *   2,5049588437,zroth2 (4/150),0,369.25,C Onyeka Okongwu...
 *
 * Tracked Pro Players:
 *   zroth, zroth2, ocdobv, shaidyadvice, bpcologna, awesemo, csuram88
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseCSVFile, buildPlayerPool } from '../parser';
import { getContestConfig } from '../rules';
import { optimizeLineups } from '../optimizer';
import { Player, Lineup, Sport, DFSSite } from '../types';

// ============================================================
// TYPES
// ============================================================

interface SlateData {
  date: string;
  projections: Map<string, Player>;  // playerId -> projected player
  actuals: Map<string, number>;       // playerName -> actual points
}

interface LineupResult {
  lineup: Lineup;
  formulaScore: number;
  actualScore: number;
  actualPercentile: number;  // 0-100, higher = better finish
  components: ComponentScores;
}

interface ComponentScores {
  projectionScore: number;
  leverageScore: number;
  ownershipScore: number;
  antiFieldScore: number;
  gtoScore: number;
  opponentEdge: number;
  cascadeBoom: number;
  regimeAlignment: number;
  informationUniqueness: number;
  expectedPayout: number;
  simulationScore: number;
  varianceScore: number;
}

interface CalibrationResult {
  slateCount: number;
  lineupCount: number;
  correlations: Map<string, number>;  // component -> correlation with actual success
  currentWeights: Map<string, number>;
  suggestedWeights: Map<string, number>;
  improvement: {
    roiDelta: number;
    top10RateDelta: number;
    cashRateDelta: number;
  };
  proComparison?: ProComparisonResult;
}

// ============================================================
// PRO PLAYER COMPARISON TYPES
// ============================================================

// Known sharp DFS players to track
const TRACKED_PROS = ['zroth', 'zroth2', 'ocdobv', 'shaidyadvice', 'bpcologna', 'awesemo', 'csuram88'];

interface ProPortfolio {
  username: string;
  exposures: Map<string, number>;  // playerName -> exposure %
  lineups?: ProLineup[];
  avgProjection?: number;
  avgOwnership?: number;
  constructionStyle?: 'stars_scrubs' | 'balanced' | 'value' | 'mixed';
}

interface ProLineup {
  players: string[];
  projection: number;
  ownership: number;
  actualScore?: number;
  rank?: number;
}

interface ProComparisonResult {
  pros: Map<string, ProSlateResult>;  // username -> results
  ourResults: OurSlateResult;
  comparison: ComparisonMetrics;
}

interface ProSlateResult {
  username: string;
  slateCount: number;
  avgROI: number;
  winRate: number;       // % of slates with 1st place finish
  top1PctRate: number;   // % of lineups in top 1%
  top10PctRate: number;  // % of lineups in top 10%
  cashRate: number;      // % of lineups that cashed
  avgExposures: Map<string, number>;  // player -> avg exposure
  constructionBreakdown: {
    starsAndScrubs: number;
    balanced: number;
    value: number;
  };
  keyDifferentiators: string[];  // Players they overweight vs field
}

interface OurSlateResult {
  slateCount: number;
  avgROI: number;
  simWinRate: number;
  simTop1PctRate: number;
  simTop10PctRate: number;
  simCashRate: number;
  avgExposures: Map<string, number>;
  constructionBreakdown: {
    starsAndScrubs: number;
    balanced: number;
    value: number;
  };
}

interface ComparisonMetrics {
  roiGap: Map<string, number>;      // pro -> our ROI - their ROI
  exposureDiffs: Map<string, Map<string, number>>;  // pro -> player -> diff
  constructionDiffs: Map<string, string>;  // pro -> description
  recommendations: string[];
}

// ============================================================
// CURRENT FORMULA WEIGHTS (from selector.ts)
// ============================================================

const CURRENT_WEIGHTS: Record<string, number> = {
  // Game Theory (40%)
  gtoScore: 0.12,
  opponentEdge: 0.08,
  cascadeBoom: 0.06,
  regimeAlignment: 0.05,
  informationUniqueness: 0.05,
  firstPlaceEquity: 0.04,
  // Projection & Value (34%) - increased for NBA
  projectionScore: 0.22,
  expectedPayout: 0.12,
  // Ownership Leverage (16%) - reduced per calibration
  leverageScore: 0.05,
  ownershipScore: 0.08,
  antiFieldScore: 0.03,
  // Validation (10%)
  simulationScore: 0.05,
  varianceScore: 0.05,
};

// ============================================================
// MAIN CALIBRATION FUNCTION
// ============================================================

export async function runCalibration(
  dataDir: string,
  site: DFSSite = 'dk',
  sport: Sport = 'nba'
): Promise<CalibrationResult> {
  console.log('========================================');
  console.log('FORMULA CALIBRATION MODULE');
  console.log('========================================');
  console.log(`Data directory: ${dataDir}`);
  console.log(`Site: ${site}, Sport: ${sport}`);
  console.log('');

  // Find all slate pairs
  const slates = findSlatePairs(dataDir);
  console.log(`Found ${slates.length} historical slates`);

  if (slates.length === 0) {
    console.error('No slate pairs found. Expected files like:');
    console.error('  2024-01-15_projections.csv');
    console.error('  2024-01-15_actuals.csv');
    throw new Error('No calibration data found');
  }

  if (slates.length < 5) {
    console.warn(`Warning: Only ${slates.length} slates. Recommend 10+ for reliable calibration.`);
  }

  // Process each slate
  const allResults: LineupResult[] = [];
  const allProPerformance: Map<string, ProContestPerformance[]> = new Map();
  const allProFormulaAnalysis: Map<string, ProFormulaAnalysis[]> = new Map();

  for (const slate of slates) {
    console.log(`\nProcessing slate: ${slate.date}`);

    try {
      const slateAnalysis = await processSlate(slate, site, sport);
      allResults.push(...slateAnalysis.results);
      console.log(`  Scored ${slateAnalysis.results.length} contest lineups`);

      // Aggregate pro performance
      for (const [username, perf] of slateAnalysis.proPerformance) {
        if (!allProPerformance.has(username)) {
          allProPerformance.set(username, []);
        }
        allProPerformance.get(username)!.push(perf);
      }

      // Aggregate pro formula analysis
      for (const [username, analysis] of slateAnalysis.proFormulaAnalysis) {
        if (!allProFormulaAnalysis.has(username)) {
          allProFormulaAnalysis.set(username, []);
        }
        allProFormulaAnalysis.get(username)!.push(analysis);
      }
    } catch (error) {
      console.error(`  Error processing slate: ${error}`);
    }
  }

  // Print aggregated pro performance
  if (allProPerformance.size > 0) {
    console.log('\n' + '═'.repeat(70));
    console.log('PRO PLAYER PERFORMANCE ACROSS SLATES');
    console.log('═'.repeat(70));

    for (const [username, perfs] of allProPerformance) {
      const totalEntries = perfs.reduce((s, p) => s + p.entries, 0);
      const avgBestRank = perfs.reduce((s, p) => s + p.bestRank, 0) / perfs.length;
      const totalTop1Pct = perfs.reduce((s, p) => s + p.top1Pct, 0);
      const totalTop10Pct = perfs.reduce((s, p) => s + p.top10Pct, 0);
      const totalCashed = perfs.reduce((s, p) => s + p.cashed, 0);

      console.log(`\n👤 ${username.toUpperCase()}:`);
      console.log(`   Slates: ${perfs.length} | Entries: ${totalEntries}`);
      console.log(`   Avg Best Rank: #${avgBestRank.toFixed(0)}`);
      console.log(`   Top 1% finishes: ${totalTop1Pct} (${(totalTop1Pct/totalEntries*100).toFixed(1)}%)`);
      console.log(`   Top 10% finishes: ${totalTop10Pct} (${(totalTop10Pct/totalEntries*100).toFixed(1)}%)`);
      console.log(`   Cash rate: ${(totalCashed/totalEntries*100).toFixed(1)}%`);
    }
  }

  // Print pro formula analysis - how well does our metric predict their best lineups?
  if (allProFormulaAnalysis.size > 0) {
    console.log('\n' + '═'.repeat(70));
    console.log('OUR FORMULA vs PRO PORTFOLIOS');
    console.log('═'.repeat(70));
    console.log('\nDoes our formula correctly identify their best lineups?\n');

    for (const [username, analyses] of allProFormulaAnalysis) {
      if (analyses.length === 0) continue;

      console.log(`\n${'─'.repeat(70)}`);
      console.log(`👤 ${username.toUpperCase()} (${analyses.length} slates, ${analyses.reduce((s, a) => s + a.entries, 0)} entries)`);
      console.log(`${'─'.repeat(70)}`);

      // Aggregate metrics
      const avgCorrelation = analyses.reduce((s, a) => s + a.formulaVsActualCorrelation, 0) / analyses.length;
      const avgFormulaRankOfBest = analyses.reduce((s, a) => s + a.formulaRankOfActualBest, 0) / analyses.length;
      const avgFormulaBestActualRank = analyses.reduce((s, a) => s + a.formulaBestActualRank, 0) / analyses.length;

      console.log(`\n  FORMULA ACCURACY:`);
      console.log(`    Correlation (formula vs actual): ${avgCorrelation >= 0 ? '+' : ''}${avgCorrelation.toFixed(3)}`);
      if (avgCorrelation > 0.3) {
        console.log(`    ✅ Good - our formula predicts their results well`);
      } else if (avgCorrelation > 0) {
        console.log(`    ⚠️  Weak positive - some predictive power`);
      } else {
        console.log(`    ❌ Poor - our formula doesn't match their success`);
      }

      console.log(`\n  BEST LINEUP IDENTIFICATION:`);
      console.log(`    Their actual best lineup → Our formula ranked it #${avgFormulaRankOfBest.toFixed(0)} (of 150)`);
      console.log(`    Our formula's #1 pick → Actually finished #${avgFormulaBestActualRank.toFixed(0)}`);

      if (avgFormulaRankOfBest <= 10) {
        console.log(`    ✅ Great - we'd have found their best lineup in top 10`);
      } else if (avgFormulaRankOfBest <= 30) {
        console.log(`    ⚠️  OK - we'd have found it in top 30`);
      } else {
        console.log(`    ❌ Poor - we'd have missed their best lineup`);
      }

      // Component comparison: what do they prioritize vs field?
      console.log(`\n  WHAT MAKES ${username.toUpperCase()}'S LINEUPS DIFFERENT:`);

      // Average their component scores vs field
      const proAvgComponents: Record<string, number> = {};
      const fieldAvgComponents: Record<string, number> = {};
      const componentKeys = ['projectionScore', 'leverageScore', 'ownershipScore', 'antiFieldScore',
                            'cascadeBoom', 'varianceScore', 'gtoScore', 'expectedPayout'];

      for (const key of componentKeys) {
        proAvgComponents[key] = analyses.reduce((s, a) => s + (a.avgComponents as any)[key], 0) / analyses.length;
        fieldAvgComponents[key] = analyses.reduce((s, a) => s + (a.fieldAvgComponents as any)[key], 0) / analyses.length;
      }

      // Show biggest differences
      const diffs: { key: string; diff: number; proVal: number; fieldVal: number }[] = [];
      for (const key of componentKeys) {
        const diff = proAvgComponents[key] - fieldAvgComponents[key];
        diffs.push({ key, diff, proVal: proAvgComponents[key], fieldVal: fieldAvgComponents[key] });
      }
      diffs.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

      for (const { key, diff, proVal, fieldVal } of diffs.slice(0, 5)) {
        const direction = diff > 0 ? '↑' : '↓';
        const pct = fieldVal > 0 ? ((diff / fieldVal) * 100).toFixed(0) : 'N/A';
        console.log(`    ${key.padEnd(22)} ${direction} ${Math.abs(diff).toFixed(3)} (${proVal.toFixed(3)} vs field ${fieldVal.toFixed(3)}, ${pct}%)`);
      }

      // Per-slate breakdown
      console.log(`\n  PER-SLATE BREAKDOWN:`);
      for (const analysis of analyses) {
        const corrStr = analysis.formulaVsActualCorrelation >= 0 ? '+' : '';
        console.log(`    ${analysis.slateDate}: corr=${corrStr}${analysis.formulaVsActualCorrelation.toFixed(3)} | best@#${analysis.actualBestRank}→formula ranked #${analysis.formulaRankOfActualBest} | formula#1→actual #${analysis.formulaBestActualRank}`);
      }
    }

    // Summary recommendations
    console.log('\n' + '═'.repeat(70));
    console.log('RECOMMENDATIONS TO MATCH PRO PORTFOLIOS');
    console.log('═'.repeat(70));

    // Find which components pros consistently score higher on
    const proComponentAdvantages: Map<string, number[]> = new Map();
    for (const [username, analyses] of allProFormulaAnalysis) {
      for (const analysis of analyses) {
        const componentKeys = ['projectionScore', 'leverageScore', 'ownershipScore', 'antiFieldScore',
                              'cascadeBoom', 'varianceScore', 'gtoScore', 'expectedPayout'];
        for (const key of componentKeys) {
          const proVal = (analysis.avgComponents as any)[key];
          const fieldVal = (analysis.fieldAvgComponents as any)[key];
          const diff = proVal - fieldVal;
          if (!proComponentAdvantages.has(key)) {
            proComponentAdvantages.set(key, []);
          }
          proComponentAdvantages.get(key)!.push(diff);
        }
      }
    }

    console.log('\n  Components where PROS consistently score HIGHER than field:');
    for (const [key, diffs] of proComponentAdvantages) {
      const avgDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
      if (avgDiff > 0.01) {
        console.log(`    ✅ ${key}: +${avgDiff.toFixed(3)} (pros prioritize this)`);
      }
    }

    console.log('\n  Components where PROS score LOWER than field:');
    for (const [key, diffs] of proComponentAdvantages) {
      const avgDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
      if (avgDiff < -0.01) {
        console.log(`    ❌ ${key}: ${avgDiff.toFixed(3)} (pros avoid this)`);
      }
    }
  }

  console.log(`\n========================================`);
  console.log(`ANALYZING ${allResults.length} LINEUPS FROM ${slates.length} SLATES`);
  console.log(`========================================\n`);

  // Calculate correlations
  const correlations = calculateCorrelations(allResults);

  // Run automated weight optimization
  const optimizationResult = optimizeWeightsAutomated(allResults, true);

  // Generate suggested weights (legacy method for comparison)
  const suggestedWeights = optimizeWeights(correlations);

  // Calculate improvement metrics
  const improvement = calculateImprovement(allResults, optimizationResult.weights);

  // Print correlation results
  printCalibrationResults(correlations, suggestedWeights, improvement);

  // Print optimized formula
  printOptimizedFormula(optimizationResult, correlations);

  return {
    slateCount: slates.length,
    lineupCount: allResults.length,
    correlations,
    currentWeights: new Map(Object.entries(CURRENT_WEIGHTS)),
    suggestedWeights,
    improvement,
  };
}

/**
 * Aggregate multiple pro comparisons across slates
 */
function aggregateProComparisons(comparisons: ProComparisonResult[]): ProComparisonResult {
  if (comparisons.length === 1) return comparisons[0];

  // Aggregate our results
  const ourResults: OurSlateResult = {
    slateCount: comparisons.length,
    avgROI: comparisons.reduce((s, c) => s + c.ourResults.avgROI, 0) / comparisons.length,
    simWinRate: comparisons.reduce((s, c) => s + c.ourResults.simWinRate, 0) / comparisons.length,
    simTop1PctRate: comparisons.reduce((s, c) => s + c.ourResults.simTop1PctRate, 0) / comparisons.length,
    simTop10PctRate: comparisons.reduce((s, c) => s + c.ourResults.simTop10PctRate, 0) / comparisons.length,
    simCashRate: comparisons.reduce((s, c) => s + c.ourResults.simCashRate, 0) / comparisons.length,
    avgExposures: new Map(),  // Would need to aggregate properly
    constructionBreakdown: {
      starsAndScrubs: comparisons.reduce((s, c) => s + c.ourResults.constructionBreakdown.starsAndScrubs, 0) / comparisons.length,
      balanced: comparisons.reduce((s, c) => s + c.ourResults.constructionBreakdown.balanced, 0) / comparisons.length,
      value: comparisons.reduce((s, c) => s + c.ourResults.constructionBreakdown.value, 0) / comparisons.length,
    },
  };

  // Aggregate pro results
  const aggregatedPros = new Map<string, ProSlateResult>();
  for (const comparison of comparisons) {
    for (const [username, result] of comparison.pros) {
      if (!aggregatedPros.has(username)) {
        aggregatedPros.set(username, { ...result, slateCount: 1 });
      } else {
        const existing = aggregatedPros.get(username)!;
        existing.slateCount++;
        existing.avgROI = (existing.avgROI * (existing.slateCount - 1) + result.avgROI) / existing.slateCount;
        existing.winRate = (existing.winRate * (existing.slateCount - 1) + result.winRate) / existing.slateCount;
        existing.top1PctRate = (existing.top1PctRate * (existing.slateCount - 1) + result.top1PctRate) / existing.slateCount;
        existing.top10PctRate = (existing.top10PctRate * (existing.slateCount - 1) + result.top10PctRate) / existing.slateCount;
        existing.cashRate = (existing.cashRate * (existing.slateCount - 1) + result.cashRate) / existing.slateCount;
      }
    }
  }

  // Aggregate comparison metrics
  const allRecommendations: string[] = [];
  for (const comparison of comparisons) {
    allRecommendations.push(...comparison.comparison.recommendations);
  }

  return {
    pros: aggregatedPros,
    ourResults,
    comparison: {
      roiGap: new Map(),
      exposureDiffs: new Map(),
      constructionDiffs: new Map(),
      recommendations: [...new Set(allRecommendations)].slice(0, 10),
    },
  };
}

// ============================================================
// FILE DISCOVERY
// ============================================================

interface SlatePair {
  date: string;
  projectionsPath: string;
  actualsPath: string;
}

function findSlatePairs(dataDir: string): SlatePair[] {
  const files = fs.readdirSync(dataDir);
  const pairs: SlatePair[] = [];

  // Group by date prefix
  const dateMap = new Map<string, { projections?: string; actuals?: string }>();

  for (const file of files) {
    const match = file.match(/^(\d{4}-\d{2}-\d{2})_(projections|actuals)\.csv$/i);
    if (match) {
      const [, date, type] = match;
      if (!dateMap.has(date)) {
        dateMap.set(date, {});
      }
      const entry = dateMap.get(date)!;
      if (type.toLowerCase() === 'projections') {
        entry.projections = path.join(dataDir, file);
      } else {
        entry.actuals = path.join(dataDir, file);
      }
    }
  }

  // Filter to complete pairs
  for (const [date, entry] of dateMap) {
    if (entry.projections && entry.actuals) {
      pairs.push({
        date,
        projectionsPath: entry.projections,
        actualsPath: entry.actuals,
      });
    }
  }

  return pairs.sort((a, b) => a.date.localeCompare(b.date));
}

// ============================================================
// SLATE PROCESSING - SCORE ACTUAL CONTEST LINEUPS
// ============================================================

interface SlateAnalysis {
  results: LineupResult[];
  contestData?: ContestData;
  proPerformance: Map<string, ProContestPerformance>;
  proFormulaAnalysis: Map<string, ProFormulaAnalysis>;
}

interface ProContestPerformance {
  username: string;
  entries: number;
  bestRank: number;
  avgRank: number;
  avgPoints: number;
  top1Pct: number;  // Count in top 1%
  top10Pct: number; // Count in top 10%
  cashed: number;   // Count that cashed
}

async function processSlate(
  slate: SlatePair,
  site: DFSSite,
  sport: Sport
): Promise<SlateAnalysis> {
  // Load projections (for player pool data)
  const parseResult = parseCSVFile(slate.projectionsPath, sport);
  const contestType = parseResult.detectedContestType;
  const pool = buildPlayerPool(parseResult.players, contestType);

  // Check if actuals file is a DK contest export
  const content = fs.readFileSync(slate.actualsPath, 'utf-8');
  const firstLine = content.split('\n')[0].toLowerCase();
  const isDKContest = firstLine.includes('rank') && firstLine.includes('entryname') && firstLine.includes('lineup');

  if (!isDKContest) {
    console.log('  Note: Actuals file is not DK contest format, using legacy processing');
    return {
      results: await processSlateOld(slate, site, sport),
      proPerformance: new Map(),
      proFormulaAnalysis: new Map(),
    };
  }

  // Parse DK contest results
  const contestData = parseDraftKingsContest(slate.actualsPath);
  console.log(`  Contest: ${contestData.totalEntries} entries, winning score: ${contestData.winningScore}`);

  // Track pro performance
  const proPerformance = analyzeProPerformance(contestData);
  for (const [username, perf] of proPerformance) {
    console.log(`  Pro ${username}: ${perf.entries} entries, best rank #${perf.bestRank}, avg rank #${perf.avgRank.toFixed(0)}`);
  }

  // Score contest lineups with our formula
  const results: LineupResult[] = [];
  const playerProjections = new Map<string, Player>();

  // Build player lookup from pool
  for (const player of pool.players) {
    playerProjections.set(player.name.toLowerCase(), player);
    playerProjections.set(normalizePlayerName(player.name), player);
  }

  // Analyze ALL contest entries for accurate correlation data
  // More data = more reliable correlations
  const entriesToAnalyze: ContestEntry[] = [...contestData.entries];

  console.log(`  Analyzing ${entriesToAnalyze.length} entries from contest...`);

  for (const entry of entriesToAnalyze) {
    // Build pseudo-lineup from entry
    const players: Player[] = [];
    let totalProjection = 0;
    let totalOwnership = 0;
    let missingPlayers = false;

    for (const playerName of entry.lineup) {
      const player = playerProjections.get(playerName) ||
                     playerProjections.get(normalizePlayerName(playerName));

      if (player) {
        players.push(player);
        totalProjection += player.projection;
        totalOwnership += player.ownership;
      } else {
        missingPlayers = true;
      }
    }

    if (missingPlayers || players.length < 6) continue; // Skip incomplete lineups

    // Create pseudo-lineup object
    const lineup: Lineup = {
      players,
      projection: totalProjection,
      salary: players.reduce((s, p) => s + p.salary, 0),
      ownership: totalOwnership,
      hash: entry.entryId,
    };

    // Calculate component scores
    const components = calculateComponentScores(lineup, pool);
    const formulaScore = calculateFormulaScore(components, CURRENT_WEIGHTS);

    // Actual percentile based on contest rank (lower rank = higher percentile)
    const actualPercentile = 100 * (1 - entry.rank / contestData.totalEntries);

    results.push({
      lineup,
      formulaScore,
      actualScore: entry.points,
      actualPercentile,
      components,
    });
  }

  // Analyze each pro's portfolio against our formula
  const proFormulaAnalysis = new Map<string, ProFormulaAnalysis>();

  for (const username of TRACKED_PROS) {
    const proEntries = contestData.entries.filter(e =>
      e.username.includes(username) || username.includes(e.username)
    );

    if (proEntries.length > 0) {
      const analysis = analyzeProPortfolioWithFormula(proEntries, results, pool, playerProjections);
      if (analysis) {
        analysis.slateDate = slate.date;
        proFormulaAnalysis.set(username, analysis);
      }
    }
  }

  return {
    results,
    contestData,
    proPerformance,
    proFormulaAnalysis,
  };
}

/**
 * Analyze pro player performance in contest
 */
function analyzeProPerformance(contestData: ContestData): Map<string, ProContestPerformance> {
  const proPerf = new Map<string, ProContestPerformance>();
  const top1PctThreshold = Math.ceil(contestData.totalEntries * 0.01);
  const top10PctThreshold = Math.ceil(contestData.totalEntries * 0.10);
  const cashThreshold = Math.ceil(contestData.totalEntries * 0.20);

  for (const entry of contestData.entries) {
    if (!entry.isTrackedPro) continue;

    if (!proPerf.has(entry.username)) {
      proPerf.set(entry.username, {
        username: entry.username,
        entries: 0,
        bestRank: Infinity,
        avgRank: 0,
        avgPoints: 0,
        top1Pct: 0,
        top10Pct: 0,
        cashed: 0,
      });
    }

    const perf = proPerf.get(entry.username)!;
    perf.entries++;
    perf.avgRank = (perf.avgRank * (perf.entries - 1) + entry.rank) / perf.entries;
    perf.avgPoints = (perf.avgPoints * (perf.entries - 1) + entry.points) / perf.entries;

    if (entry.rank < perf.bestRank) {
      perf.bestRank = entry.rank;
    }

    if (entry.rank <= top1PctThreshold) perf.top1Pct++;
    if (entry.rank <= top10PctThreshold) perf.top10Pct++;
    if (entry.rank <= cashThreshold) perf.cashed++;
  }

  return proPerf;
}

// ============================================================
// PRO PORTFOLIO FORMULA ANALYSIS
// ============================================================

interface ProFormulaAnalysis {
  username: string;
  slateDate: string;
  entries: number;
  // How well does our formula rank their lineups?
  formulaVsActualCorrelation: number;  // Correlation between our score and their actual finish
  // Would our formula have found their best lineup?
  actualBestRank: number;
  actualBestPoints: number;
  formulaRankOfActualBest: number;  // Where our formula ranked their actual best lineup
  formulaBestActualRank: number;    // Actual rank of lineup our formula ranked #1
  // Component correlations for this pro's set
  componentCorrelations: Map<string, number>;
  // Their avg component scores vs field avg
  avgComponents: ComponentScores;
  fieldAvgComponents: ComponentScores;
}

/**
 * Analyze how our formula performs on a specific pro's portfolio
 */
function analyzeProPortfolioWithFormula(
  proEntries: ContestEntry[],
  allResults: LineupResult[],
  pool: any,
  playerProjections: Map<string, Player>
): ProFormulaAnalysis | null {
  if (proEntries.length === 0) return null;

  const username = proEntries[0].username;

  // Score each of the pro's lineups with our formula
  interface ScoredProLineup {
    entry: ContestEntry;
    formulaScore: number;
    components: ComponentScores;
  }

  const scoredProLineups: ScoredProLineup[] = [];

  for (const entry of proEntries) {
    // Build lineup from entry
    const players: Player[] = [];
    for (const playerName of entry.lineup) {
      const player = playerProjections.get(playerName) ||
                     playerProjections.get(normalizePlayerName(playerName));
      if (player) {
        players.push(player);
      }
    }

    if (players.length < 6) continue;

    const lineup: Lineup = {
      players,
      projection: players.reduce((s, p) => s + p.projection, 0),
      salary: players.reduce((s, p) => s + p.salary, 0),
      ownership: players.reduce((s, p) => s + p.ownership, 0),
      hash: entry.entryId,
    };

    const components = calculateComponentScores(lineup, pool);
    const formulaScore = calculateFormulaScore(components, CURRENT_WEIGHTS);

    scoredProLineups.push({
      entry,
      formulaScore,
      components,
    });
  }

  if (scoredProLineups.length < 10) return null;

  // Sort by formula score (our ranking)
  const byFormula = [...scoredProLineups].sort((a, b) => b.formulaScore - a.formulaScore);

  // Sort by actual rank (their actual performance)
  const byActual = [...scoredProLineups].sort((a, b) => a.entry.rank - b.entry.rank);

  // Calculate correlation between our formula score and actual rank
  const formulaScores = scoredProLineups.map(l => l.formulaScore);
  const actualRanks = scoredProLineups.map(l => -l.entry.rank); // Negative because lower rank = better
  const formulaVsActualCorrelation = pearsonCorrelation(formulaScores, actualRanks);

  // Find their actual best lineup
  const actualBest = byActual[0];
  const actualBestRank = actualBest.entry.rank;
  const actualBestPoints = actualBest.entry.points;

  // Where did our formula rank their actual best lineup?
  const formulaRankOfActualBest = byFormula.findIndex(l => l.entry.entryId === actualBest.entry.entryId) + 1;

  // What was the actual rank of the lineup our formula ranked #1?
  const formulaBest = byFormula[0];
  const formulaBestActualRank = formulaBest.entry.rank;

  // Calculate component correlations for this pro's set
  const componentCorrelations = new Map<string, number>();
  const componentKeys: (keyof ComponentScores)[] = [
    'projectionScore', 'leverageScore', 'ownershipScore', 'antiFieldScore',
    'gtoScore', 'opponentEdge', 'cascadeBoom', 'regimeAlignment',
    'informationUniqueness', 'expectedPayout', 'simulationScore', 'varianceScore'
  ];

  for (const key of componentKeys) {
    const componentValues = scoredProLineups.map(l => l.components[key]);
    const corr = pearsonCorrelation(componentValues, actualRanks);
    componentCorrelations.set(key, corr);
  }

  // Calculate average component scores for pro vs field
  const avgComponents: ComponentScores = {
    projectionScore: 0, leverageScore: 0, ownershipScore: 0, antiFieldScore: 0,
    gtoScore: 0, opponentEdge: 0, cascadeBoom: 0, regimeAlignment: 0,
    informationUniqueness: 0, expectedPayout: 0, simulationScore: 0, varianceScore: 0,
  };

  for (const l of scoredProLineups) {
    for (const key of componentKeys) {
      avgComponents[key] += l.components[key] / scoredProLineups.length;
    }
  }

  // Field average (from all results)
  const fieldAvgComponents: ComponentScores = {
    projectionScore: 0, leverageScore: 0, ownershipScore: 0, antiFieldScore: 0,
    gtoScore: 0, opponentEdge: 0, cascadeBoom: 0, regimeAlignment: 0,
    informationUniqueness: 0, expectedPayout: 0, simulationScore: 0, varianceScore: 0,
  };

  if (allResults.length > 0) {
    for (const r of allResults) {
      for (const key of componentKeys) {
        fieldAvgComponents[key] += r.components[key] / allResults.length;
      }
    }
  }

  return {
    username,
    slateDate: '',
    entries: scoredProLineups.length,
    formulaVsActualCorrelation,
    actualBestRank,
    actualBestPoints,
    formulaRankOfActualBest,
    formulaBestActualRank,
    componentCorrelations,
    avgComponents,
    fieldAvgComponents,
  };
}

/**
 * Legacy slate processing (for non-DK contest format)
 */
async function processSlateOld(
  slate: SlatePair,
  site: DFSSite,
  sport: Sport
): Promise<LineupResult[]> {
  const parseResult = parseCSVFile(slate.projectionsPath, sport);
  const contestType = parseResult.detectedContestType;
  const config = getContestConfig(site, sport, contestType);
  const pool = buildPlayerPool(parseResult.players, contestType);
  const actuals = loadActuals(slate.actualsPath);

  const optimizationResult = optimizeLineups({
    config,
    pool,
    poolSize: 5000,
    minSalary: config.salaryCap - 1000,
  });

  const lineupsToAnalyze = optimizationResult.lineups
    .sort((a, b) => b.projection - a.projection)
    .slice(0, 500);

  const results: LineupResult[] = [];

  for (const lineup of lineupsToAnalyze) {
    let actualScore = 0;
    for (const player of lineup.players) {
      const actual = actuals.get(player.name.toLowerCase()) ||
                     actuals.get(normalizePlayerName(player.name));
      if (actual !== undefined) {
        actualScore += actual;
      } else {
        actualScore = -1;
        break;
      }
    }

    if (actualScore < 0) continue;

    const components = calculateComponentScores(lineup, pool);
    const formulaScore = calculateFormulaScore(components, CURRENT_WEIGHTS);

    results.push({
      lineup,
      formulaScore,
      actualScore,
      actualPercentile: 0,
      components,
    });
  }

  results.sort((a, b) => b.actualScore - a.actualScore);
  for (let i = 0; i < results.length; i++) {
    results[i].actualPercentile = 100 * (1 - i / results.length);
  }

  return results;
}

// ============================================================
// DRAFTKINGS CONTEST RESULTS PARSING
// ============================================================

interface ContestEntry {
  rank: number;
  entryId: string;
  username: string;
  points: number;
  lineup: string[];  // Player names
  isTrackedPro: boolean;
}

interface ContestData {
  entries: ContestEntry[];
  playerActuals: Map<string, number>;  // player name -> actual FPTS
  totalEntries: number;
  winningScore: number;
  cashLine: number;  // Approximate cash line score
}

/**
 * Parse DraftKings contest export CSV
 * Format: Rank,EntryId,EntryName,TimeRemaining,Points,Lineup,,Player,Roster Position,%Drafted,FPTS
 */
function parseDraftKingsContest(filePath: string): ContestData {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  const entries: ContestEntry[] = [];
  const playerActuals = new Map<string, number>();
  const seenPlayers = new Set<string>();

  // Parse header
  const header = lines[0].replace(/^\uFEFF/, ''); // Remove BOM
  const headers = header.split(',').map(h => h.trim().toLowerCase());

  // Find column indices
  const rankCol = headers.findIndex(h => h === 'rank');
  const entryIdCol = headers.findIndex(h => h.includes('entryid'));
  const entryNameCol = headers.findIndex(h => h.includes('entryname'));
  const pointsCol = headers.findIndex(h => h === 'points');
  const lineupCol = headers.findIndex(h => h === 'lineup');
  const playerCol = headers.findIndex(h => h === 'player');
  const fptsCol = headers.findIndex(h => h === 'fpts');

  // Parse data
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = parseCSVLine(line);
    if (cols.length < 5) continue;

    // Parse entry data
    const rank = parseInt(cols[rankCol]);
    const entryId = cols[entryIdCol] || '';
    const entryName = cols[entryNameCol] || '';
    const points = parseFloat(cols[pointsCol]);
    const lineupStr = cols[lineupCol] || '';

    // Extract username from entry name (e.g., "zroth2 (4/150)" -> "zroth2")
    const usernameMatch = entryName.match(/^([^\s(]+)/);
    const username = usernameMatch ? usernameMatch[1].toLowerCase() : entryName.toLowerCase();

    // Check if tracked pro
    const isTrackedPro = TRACKED_PROS.some(pro =>
      username.includes(pro) || username === pro
    );

    // Parse lineup from string like "C Jock Landale F Zion Williamson G Baylor Scheierman..."
    const lineup = parseLineupString(lineupStr);

    if (!isNaN(rank) && !isNaN(points) && lineup.length > 0) {
      entries.push({
        rank,
        entryId,
        username,
        points,
        lineup,
        isTrackedPro,
      });
    }

    // Extract player actual FPTS from right side columns
    if (playerCol >= 0 && fptsCol >= 0 && cols.length > fptsCol) {
      const playerName = (cols[playerCol] || '').toLowerCase().trim();
      const fpts = parseFloat(cols[fptsCol]);
      if (playerName && !isNaN(fpts) && !seenPlayers.has(playerName)) {
        playerActuals.set(playerName, fpts);
        playerActuals.set(normalizePlayerName(playerName), fpts);
        seenPlayers.add(playerName);
      }
    }
  }

  // Sort by rank
  entries.sort((a, b) => a.rank - b.rank);

  // Calculate contest metrics
  const totalEntries = entries.length;
  const winningScore = entries[0]?.points || 0;
  const cashLineIndex = Math.floor(totalEntries * 0.20); // Top 20% typically cash
  const cashLine = entries[cashLineIndex]?.points || 0;

  return {
    entries,
    playerActuals,
    totalEntries,
    winningScore,
    cashLine,
  };
}

/**
 * Parse lineup string from DK format
 * "C Jock Landale F Zion Williamson G Baylor Scheierman PF Jaren Jackson Jr. PG Cam Spencer SF Saddiq Bey SG Trey Murphy III UTIL Onyeka Okongwu"
 */
function parseLineupString(lineupStr: string): string[] {
  const players: string[] = [];

  // Split by roster positions
  const positions = ['C ', 'F ', 'G ', 'PF ', 'PG ', 'SF ', 'SG ', 'UTIL ', 'CPT ', 'FLEX '];

  let remaining = lineupStr;
  for (const pos of positions) {
    const idx = remaining.indexOf(pos);
    if (idx >= 0) {
      // Find end of this player's name (next position or end of string)
      let endIdx = remaining.length;
      for (const nextPos of positions) {
        const nextIdx = remaining.indexOf(nextPos, idx + pos.length);
        if (nextIdx > idx && nextIdx < endIdx) {
          endIdx = nextIdx;
        }
      }

      const playerName = remaining.substring(idx + pos.length, endIdx).trim();
      if (playerName) {
        players.push(playerName.toLowerCase());
      }
    }
  }

  return players;
}

/**
 * Legacy actuals loader (for simple player -> points CSV)
 */
function loadActuals(filePath: string): Map<string, number> {
  // Check if this is a DK contest export
  const content = fs.readFileSync(filePath, 'utf-8');
  const firstLine = content.split('\n')[0].toLowerCase();

  if (firstLine.includes('rank') && firstLine.includes('entryname') && firstLine.includes('lineup')) {
    // This is a DK contest export - extract player actuals from it
    const contestData = parseDraftKingsContest(filePath);
    return contestData.playerActuals;
  }

  // Legacy format: simple player,points CSV
  const actuals = new Map<string, number>();
  const lines = content.split('\n');

  const header = lines[0].toLowerCase();
  let nameCol = 0;
  let pointsCol = 1;

  const headers = header.split(',').map(h => h.trim());
  for (let i = 0; i < headers.length; i++) {
    if (headers[i].includes('name') || headers[i].includes('player')) {
      nameCol = i;
    }
    if (headers[i].includes('actual') || headers[i].includes('fpts') ||
        headers[i].includes('points') || headers[i].includes('score')) {
      pointsCol = i;
    }
  }

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = parseCSVLine(line);
    if (cols.length > Math.max(nameCol, pointsCol)) {
      const name = cols[nameCol].toLowerCase().trim();
      const points = parseFloat(cols[pointsCol]);
      if (!isNaN(points)) {
        actuals.set(name, points);
        actuals.set(normalizePlayerName(name), points);
      }
    }
  }

  return actuals;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());

  return result;
}

function normalizePlayerName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ============================================================
// COMPONENT SCORING
// ============================================================

function calculateComponentScores(lineup: Lineup, pool: any): ComponentScores {
  const players = lineup.players;

  // Projection score (normalized 0-1)
  const maxProj = 300;  // Approximate max lineup projection
  const projectionScore = Math.min(1, lineup.projection / maxProj);

  // Ownership-based scores
  const avgOwnership = players.reduce((s, p) => s + p.ownership, 0) / players.length;
  const ownershipScore = Math.max(0, 1 - avgOwnership / 50);  // Lower ownership = higher score

  // Ownership product for leverage
  let ownershipProduct = 1;
  for (const p of players) {
    ownershipProduct *= Math.max(0.01, p.ownership / 100);
  }
  const leverageScore = Math.min(1, -Math.log10(ownershipProduct + 1e-10) / 10);

  // Anti-field: how different from chalk
  const chalkThreshold = 25;
  const lowOwnCount = players.filter(p => p.ownership < chalkThreshold).length;
  const antiFieldScore = lowOwnCount / players.length;

  // Variance/ceiling score
  const avgCeiling = players.reduce((s, p) => s + (p.ceiling || p.projection * 1.3), 0) / players.length;
  const varianceScore = Math.min(1, (avgCeiling - lineup.projection / players.length) / 10);

  // Placeholder scores for game theory components
  // In full calibration, these would come from the actual selector calculations
  const gtoScore = 0.5 + (projectionScore * 0.2) + (leverageScore * 0.3);
  const opponentEdge = leverageScore * 0.8 + antiFieldScore * 0.2;
  const cascadeBoom = varianceScore * 0.7 + projectionScore * 0.3;
  const regimeAlignment = 0.5;  // Would need slate context
  const informationUniqueness = antiFieldScore * 0.6 + leverageScore * 0.4;
  const expectedPayout = projectionScore * 0.5 + leverageScore * 0.5;
  const simulationScore = projectionScore * 0.6 + leverageScore * 0.4;

  return {
    projectionScore,
    leverageScore,
    ownershipScore,
    antiFieldScore,
    gtoScore,
    opponentEdge,
    cascadeBoom,
    regimeAlignment,
    informationUniqueness,
    expectedPayout,
    simulationScore,
    varianceScore,
  };
}

function calculateFormulaScore(
  components: ComponentScores,
  weights: Record<string, number>
): number {
  return (
    (components.gtoScore * weights.gtoScore) +
    (components.opponentEdge * weights.opponentEdge) +
    (components.cascadeBoom * weights.cascadeBoom) +
    (components.regimeAlignment * weights.regimeAlignment) +
    (components.informationUniqueness * weights.informationUniqueness) +
    (components.projectionScore * weights.projectionScore) +
    (components.expectedPayout * weights.expectedPayout) +
    (components.leverageScore * weights.leverageScore) +
    (components.ownershipScore * weights.ownershipScore) +
    (components.antiFieldScore * weights.antiFieldScore) +
    (components.simulationScore * weights.simulationScore) +
    (components.varianceScore * weights.varianceScore)
  );
}

// ============================================================
// CORRELATION ANALYSIS
// ============================================================

function calculateCorrelations(results: LineupResult[]): Map<string, number> {
  const correlations = new Map<string, number>();
  const components = Object.keys(CURRENT_WEIGHTS);

  // Extract actual percentiles
  const actualPercentiles = results.map(r => r.actualPercentile);

  for (const component of components) {
    // Get component scores
    const componentKey = component as keyof ComponentScores;

    // Map component names to ComponentScores keys
    const keyMap: Record<string, keyof ComponentScores> = {
      gtoScore: 'gtoScore',
      opponentEdge: 'opponentEdge',
      cascadeBoom: 'cascadeBoom',
      regimeAlignment: 'regimeAlignment',
      informationUniqueness: 'informationUniqueness',
      firstPlaceEquity: 'gtoScore',  // Proxy
      projectionScore: 'projectionScore',
      expectedPayout: 'expectedPayout',
      leverageScore: 'leverageScore',
      ownershipScore: 'ownershipScore',
      antiFieldScore: 'antiFieldScore',
      simulationScore: 'simulationScore',
      varianceScore: 'varianceScore',
    };

    const mappedKey = keyMap[component] || 'projectionScore';
    const componentScores = results.map(r => r.components[mappedKey]);

    // Calculate Pearson correlation
    const corr = pearsonCorrelation(componentScores, actualPercentiles);
    correlations.set(component, corr);
  }

  return correlations;
}

function pearsonCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  if (n === 0) return 0;

  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((total, xi, i) => total + xi * y[i], 0);
  const sumX2 = x.reduce((total, xi) => total + xi * xi, 0);
  const sumY2 = y.reduce((total, yi) => total + yi * yi, 0);

  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt(
    (n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY)
  );

  if (denominator === 0) return 0;
  return numerator / denominator;
}

// ============================================================
// WEIGHT OPTIMIZATION - AUTOMATED HYPERPARAMETER TUNING
// ============================================================

interface OptimizationResult {
  weights: Map<string, number>;
  correlation: number;
  top10Accuracy: number;
  cashAccuracy: number;
}

/**
 * Brute-force weight optimization - tests thousands of combinations
 * to find the weights that best predict actual contest results
 */
function optimizeWeightsAutomated(
  results: LineupResult[],
  verbose: boolean = true
): OptimizationResult {
  const components = [
    'projectionScore', 'cascadeBoom', 'varianceScore',
    'leverageScore', 'ownershipScore', 'antiFieldScore',
    'gtoScore', 'opponentEdge', 'expectedPayout',
    'simulationScore', 'informationUniqueness', 'regimeAlignment'
  ];

  // Extract actual percentiles for correlation calculation
  const actualPercentiles = results.map(r => r.actualPercentile);

  // Function to calculate correlation for a given weight set
  const evaluateWeights = (weights: Record<string, number>): number => {
    const formulaScores = results.map(r => {
      let score = 0;
      for (const comp of components) {
        const compKey = comp as keyof ComponentScores;
        score += (r.components[compKey] || 0) * (weights[comp] || 0);
      }
      return score;
    });
    return pearsonCorrelation(formulaScores, actualPercentiles);
  };

  // Function to calculate top 10% accuracy
  const evaluateTop10Accuracy = (weights: Record<string, number>): number => {
    const scored = results.map((r, i) => ({
      formulaScore: components.reduce((s, c) =>
        s + (r.components[c as keyof ComponentScores] || 0) * (weights[c] || 0), 0),
      actualPercentile: r.actualPercentile,
      idx: i
    }));

    // Sort by formula score descending
    scored.sort((a, b) => b.formulaScore - a.formulaScore);

    // Take top 10% by formula
    const top10Count = Math.floor(results.length * 0.1);
    const top10ByFormula = scored.slice(0, top10Count);

    // How many of those are actually in top 10%?
    const actuallyTop10 = top10ByFormula.filter(s => s.actualPercentile >= 90).length;
    return actuallyTop10 / top10Count;
  };

  if (verbose) {
    console.log('\n' + '═'.repeat(70));
    console.log('AUTOMATED WEIGHT OPTIMIZATION');
    console.log('═'.repeat(70));
    console.log(`\nTesting weight combinations across ${results.length} lineups...`);
  }

  let bestWeights: Record<string, number> = {};
  let bestCorrelation = -1;
  let testedCombos = 0;

  // ============================================================
  // PHASE 1: Test removing each component entirely
  // ============================================================
  if (verbose) console.log('\n--- PHASE 1: Component Removal Testing ---');

  const baselineWeights: Record<string, number> = {
    projectionScore: 0.35, cascadeBoom: 0.25, varianceScore: 0.20,
    leverageScore: 0.02, ownershipScore: 0.02, antiFieldScore: 0.01,
    gtoScore: 0.04, opponentEdge: 0.03, expectedPayout: 0.04,
    simulationScore: 0.02, informationUniqueness: 0.01, regimeAlignment: 0.01
  };

  const baselineCorr = evaluateWeights(baselineWeights);
  if (verbose) console.log(`  Baseline correlation: ${baselineCorr.toFixed(4)}`);

  // Test removing each component
  const componentImpact: { comp: string; impact: number }[] = [];
  for (const comp of components) {
    const testWeights = { ...baselineWeights, [comp]: 0 };
    // Normalize
    const total = Object.values(testWeights).reduce((a, b) => a + b, 0);
    for (const k of Object.keys(testWeights)) {
      testWeights[k] = testWeights[k] / total;
    }
    const corr = evaluateWeights(testWeights);
    const impact = corr - baselineCorr;
    componentImpact.push({ comp, impact });
    testedCombos++;
  }

  componentImpact.sort((a, b) => b.impact - a.impact);
  if (verbose) {
    console.log('\n  Impact of REMOVING each component:');
    for (const { comp, impact } of componentImpact) {
      const sign = impact >= 0 ? '+' : '';
      const verdict = impact > 0.01 ? '← REMOVE (improves)' : impact < -0.01 ? '← KEEP (hurts to remove)' : '';
      console.log(`    ${comp.padEnd(24)} ${sign}${impact.toFixed(4)} ${verdict}`);
    }
  }

  // ============================================================
  // PHASE 2: Coarse Grid Search
  // ============================================================
  if (verbose) console.log('\n--- PHASE 2: Coarse Grid Search ---');

  // Focus on the top 3 positive components
  const topComponents = ['projectionScore', 'cascadeBoom', 'varianceScore'];
  const otherComponents = components.filter(c => !topComponents.includes(c));

  // Coarse grid for top 3
  const coarseSteps = [0.1, 0.2, 0.3, 0.4, 0.5];
  let coarseBest: Record<string, number> = {};
  let coarseBestCorr = -1;

  for (const proj of coarseSteps) {
    for (const boom of coarseSteps) {
      for (const variance of coarseSteps) {
        if (proj + boom + variance > 0.95) continue; // Leave room for others

        const remaining = 1 - proj - boom - variance;
        const otherWeight = remaining / otherComponents.length;

        const weights: Record<string, number> = {
          projectionScore: proj,
          cascadeBoom: boom,
          varianceScore: variance,
        };
        for (const c of otherComponents) {
          weights[c] = otherWeight;
        }

        const corr = evaluateWeights(weights);
        testedCombos++;

        if (corr > coarseBestCorr) {
          coarseBestCorr = corr;
          coarseBest = { ...weights };
        }
      }
    }
  }

  if (verbose) {
    console.log(`  Tested ${testedCombos} combinations`);
    console.log(`  Best coarse correlation: ${coarseBestCorr.toFixed(4)}`);
    console.log(`  Best coarse weights: proj=${coarseBest.projectionScore?.toFixed(2)}, boom=${coarseBest.cascadeBoom?.toFixed(2)}, var=${coarseBest.varianceScore?.toFixed(2)}`);
  }

  // ============================================================
  // PHASE 3: Fine Grid Search around best
  // ============================================================
  if (verbose) console.log('\n--- PHASE 3: Fine Grid Search ---');

  const fineSteps = [-0.05, -0.02, 0, 0.02, 0.05];
  let fineBest = { ...coarseBest };
  let fineBestCorr = coarseBestCorr;

  for (const dProj of fineSteps) {
    for (const dBoom of fineSteps) {
      for (const dVar of fineSteps) {
        const proj = Math.max(0.05, Math.min(0.6, (coarseBest.projectionScore || 0.3) + dProj));
        const boom = Math.max(0.05, Math.min(0.5, (coarseBest.cascadeBoom || 0.2) + dBoom));
        const variance = Math.max(0.05, Math.min(0.4, (coarseBest.varianceScore || 0.2) + dVar));

        if (proj + boom + variance > 0.95) continue;

        const remaining = 1 - proj - boom - variance;

        // Test different distributions of remaining weight
        for (const negWeight of [0, 0.01, 0.02, 0.03]) {
          const weights: Record<string, number> = {
            projectionScore: proj,
            cascadeBoom: boom,
            varianceScore: variance,
          };

          // Distribute remaining: some to negative components, rest evenly
          const negComponents = ['leverageScore', 'antiFieldScore', 'ownershipScore'];
          const neutralComponents = otherComponents.filter(c => !negComponents.includes(c));

          for (const c of negComponents) {
            weights[c] = negWeight;
          }
          const neutralWeight = (remaining - negWeight * negComponents.length) / neutralComponents.length;
          for (const c of neutralComponents) {
            weights[c] = Math.max(0, neutralWeight);
          }

          const corr = evaluateWeights(weights);
          testedCombos++;

          if (corr > fineBestCorr) {
            fineBestCorr = corr;
            fineBest = { ...weights };
          }
        }
      }
    }
  }

  if (verbose) {
    console.log(`  Tested ${testedCombos} combinations total`);
    console.log(`  Best fine correlation: ${fineBestCorr.toFixed(4)}`);
  }

  // ============================================================
  // PHASE 4: Test zero weights for negative components
  // ============================================================
  if (verbose) console.log('\n--- PHASE 4: Zero Weight Testing ---');

  const negativeComponents = componentImpact
    .filter(c => c.impact > 0) // Removing improves correlation
    .map(c => c.comp);

  if (verbose) console.log(`  Testing removing: ${negativeComponents.join(', ')}`);

  // Test all combinations of zeroing negative components
  const numNeg = negativeComponents.length;
  for (let mask = 0; mask < (1 << numNeg); mask++) {
    const weights = { ...fineBest };

    for (let i = 0; i < numNeg; i++) {
      if (mask & (1 << i)) {
        weights[negativeComponents[i]] = 0;
      }
    }

    // Normalize
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    if (total === 0) continue;
    for (const k of Object.keys(weights)) {
      weights[k] = weights[k] / total;
    }

    const corr = evaluateWeights(weights);
    testedCombos++;

    if (corr > bestCorrelation) {
      bestCorrelation = corr;
      bestWeights = { ...weights };
    }
  }

  // ============================================================
  // PHASE 5: Ultra-fine tuning around best
  // ============================================================
  if (verbose) console.log('\n--- PHASE 5: Ultra-Fine Tuning ---');

  const ultraFineSteps = [-0.01, -0.005, 0, 0.005, 0.01];

  for (let iter = 0; iter < 3; iter++) {
    const currentBest = { ...bestWeights };

    for (const comp of topComponents) {
      for (const delta of ultraFineSteps) {
        const testWeights = { ...currentBest };
        testWeights[comp] = Math.max(0.01, (testWeights[comp] || 0) + delta);

        // Normalize
        const total = Object.values(testWeights).reduce((a, b) => a + b, 0);
        for (const k of Object.keys(testWeights)) {
          testWeights[k] = testWeights[k] / total;
        }

        const corr = evaluateWeights(testWeights);
        testedCombos++;

        if (corr > bestCorrelation) {
          bestCorrelation = corr;
          bestWeights = { ...testWeights };
        }
      }
    }
  }

  if (verbose) {
    console.log(`  Total combinations tested: ${testedCombos.toLocaleString()}`);
  }

  // Calculate final metrics
  const top10Accuracy = evaluateTop10Accuracy(bestWeights);

  // Convert to Map
  const weightsMap = new Map<string, number>();
  for (const [k, v] of Object.entries(bestWeights)) {
    weightsMap.set(k, Math.round(v * 1000) / 1000);
  }

  return {
    weights: weightsMap,
    correlation: bestCorrelation,
    top10Accuracy,
    cashAccuracy: 0, // TODO: implement
  };
}

/**
 * Simple correlation-based weight optimization (legacy)
 */
function optimizeWeights(correlations: Map<string, number>): Map<string, number> {
  const suggested = new Map<string, number>();

  const allCorrs: { component: string; corr: number }[] = [];
  for (const [component, corr] of correlations) {
    allCorrs.push({ component, corr });
  }

  const totalPositiveCorr = allCorrs
    .filter(c => c.corr > 0)
    .reduce((sum, c) => sum + c.corr, 0);

  for (const { component, corr } of allCorrs) {
    const currentWeight = CURRENT_WEIGHTS[component] || 0.05;

    let newWeight: number;
    if (corr <= 0) {
      newWeight = Math.max(0.01, currentWeight * 0.3);
    } else if (totalPositiveCorr > 0) {
      const corrShare = corr / totalPositiveCorr;
      newWeight = currentWeight * 0.4 + corrShare * 0.6;
    } else {
      newWeight = currentWeight;
    }

    suggested.set(component, Math.round(newWeight * 1000) / 1000);
  }

  const total = Array.from(suggested.values()).reduce((a, b) => a + b, 0);
  for (const [component, weight] of suggested) {
    suggested.set(component, Math.round((weight / total) * 1000) / 1000);
  }

  return suggested;
}

// ============================================================
// IMPROVEMENT CALCULATION
// ============================================================

function calculateImprovement(
  results: LineupResult[],
  suggestedWeights: Map<string, number>
): { roiDelta: number; top10RateDelta: number; cashRateDelta: number } {
  // Recalculate scores with suggested weights
  const weightObj: Record<string, number> = {};
  for (const [k, v] of suggestedWeights) {
    weightObj[k] = v;
  }

  const newResults = results.map(r => ({
    ...r,
    newFormulaScore: calculateFormulaScore(r.components, weightObj),
  }));

  // Sort by current formula score
  const currentRanked = [...results].sort((a, b) => b.formulaScore - a.formulaScore);
  const currentTop10 = currentRanked.slice(0, Math.floor(results.length * 0.1));
  const currentTop50 = currentRanked.slice(0, Math.floor(results.length * 0.5));

  // Sort by new formula score
  const newRanked = [...newResults].sort((a, b) => b.newFormulaScore - a.newFormulaScore);
  const newTop10 = newRanked.slice(0, Math.floor(results.length * 0.1));
  const newTop50 = newRanked.slice(0, Math.floor(results.length * 0.5));

  // Calculate actual performance metrics
  const currentTop10AvgActual = currentTop10.reduce((s, r) => s + r.actualPercentile, 0) / currentTop10.length;
  const newTop10AvgActual = newTop10.reduce((s, r) => s + r.actualPercentile, 0) / newTop10.length;

  const currentCashRate = currentTop50.filter(r => r.actualPercentile >= 50).length / currentTop50.length;
  const newCashRate = newTop50.filter(r => r.actualPercentile >= 50).length / newTop50.length;

  return {
    roiDelta: (newTop10AvgActual - currentTop10AvgActual) / 100,
    top10RateDelta: (newTop10AvgActual - currentTop10AvgActual),
    cashRateDelta: (newCashRate - currentCashRate) * 100,
  };
}

// ============================================================
// OUTPUT
// ============================================================

function printCalibrationResults(
  correlations: Map<string, number>,
  suggestedWeights: Map<string, number>,
  improvement: { roiDelta: number; top10RateDelta: number; cashRateDelta: number }
): void {
  console.log('FORMULA COMPONENT ANALYSIS:\n');
  console.log('Component                Correlation   Current   Suggested   Change');
  console.log('─'.repeat(70));

  // Sort by correlation
  const sorted = [...correlations.entries()].sort((a, b) => b[1] - a[1]);

  for (const [component, corr] of sorted) {
    const current = CURRENT_WEIGHTS[component] || 0;
    const suggested = suggestedWeights.get(component) || 0;
    const change = suggested - current;
    const changeStr = change > 0 ? `+${(change * 100).toFixed(1)}%` : `${(change * 100).toFixed(1)}%`;
    const corrStr = corr >= 0 ? `+${corr.toFixed(3)}` : corr.toFixed(3);
    const indicator = corr < 0 ? ' ← hurting' : corr > 0.3 ? ' ← strong' : '';

    console.log(
      `${component.padEnd(24)} ${corrStr.padStart(8)}   ${(current * 100).toFixed(1).padStart(5)}%   ` +
      `${(suggested * 100).toFixed(1).padStart(7)}%   ${changeStr.padStart(7)}${indicator}`
    );
  }

  console.log('\n' + '─'.repeat(70));
  console.log('\nPROJECTED IMPROVEMENT WITH SUGGESTED WEIGHTS:\n');
  console.log(`  Top 10% actual percentile: ${improvement.top10RateDelta >= 0 ? '+' : ''}${improvement.top10RateDelta.toFixed(1)}%`);
  console.log(`  Cash rate improvement:     ${improvement.cashRateDelta >= 0 ? '+' : ''}${improvement.cashRateDelta.toFixed(1)}%`);

  console.log('\n' + '─'.repeat(70));
  console.log('\nSUGGESTED FORMULA (copy to selector.ts):\n');

  // Group by tier
  const gameTheory = ['gtoScore', 'opponentEdge', 'cascadeBoom', 'regimeAlignment', 'informationUniqueness', 'firstPlaceEquity'];
  const projection = ['projectionScore', 'expectedPayout'];
  const leverage = ['leverageScore', 'ownershipScore', 'antiFieldScore'];
  const validation = ['simulationScore', 'varianceScore'];

  const printTier = (name: string, components: string[]) => {
    const tierTotal = components.reduce((s, c) => s + (suggestedWeights.get(c) || 0), 0);
    console.log(`// ${name} (${(tierTotal * 100).toFixed(0)}%)`);
    for (const c of components) {
      const w = suggestedWeights.get(c) || 0;
      if (w >= 0.01) {
        console.log(`(${c} * ${w.toFixed(2)}) +`);
      }
    }
  };

  printTier('GAME THEORY', gameTheory);
  printTier('PROJECTION & VALUE', projection);
  printTier('OWNERSHIP LEVERAGE', leverage);
  printTier('VALIDATION', validation);
}

/**
 * Print the optimized formula from automated tuning
 */
function printOptimizedFormula(
  result: OptimizationResult,
  correlations: Map<string, number>
): void {
  console.log('\n' + '═'.repeat(70));
  console.log('🎯 OPTIMIZED FORMULA (from automated testing)');
  console.log('═'.repeat(70));

  console.log(`\n  Final Correlation with Actual Results: ${result.correlation.toFixed(4)}`);
  console.log(`  Top 10% Accuracy: ${(result.top10Accuracy * 100).toFixed(1)}%`);
  console.log(`  (If we pick top 10% by formula, ${(result.top10Accuracy * 100).toFixed(1)}% are actually top 10%)`);

  console.log('\n  OPTIMIZED WEIGHTS:');
  console.log('  ' + '─'.repeat(60));

  // Sort by weight descending
  const sortedWeights = [...result.weights.entries()].sort((a, b) => b[1] - a[1]);

  for (const [component, weight] of sortedWeights) {
    const corr = correlations.get(component) || 0;
    const corrStr = corr >= 0 ? `+${corr.toFixed(3)}` : corr.toFixed(3);
    const bar = '█'.repeat(Math.round(weight * 50));
    const action = weight < 0.02 ? ' (minimal)' : weight > 0.2 ? ' ← KEY' : '';

    console.log(`  ${component.padEnd(24)} ${(weight * 100).toFixed(1).padStart(5)}% ${bar}${action}`);
  }

  // Print as code
  console.log('\n  ' + '─'.repeat(60));
  console.log('\n  COPY THIS TO selector.ts:\n');
  console.log('  totalScore =');

  // Group by category
  const projection = ['projectionScore', 'expectedPayout'];
  const ceiling = ['cascadeBoom', 'varianceScore'];
  const ownership = ['leverageScore', 'ownershipScore', 'antiFieldScore'];
  const gameTheory = ['gtoScore', 'opponentEdge', 'informationUniqueness', 'regimeAlignment', 'simulationScore'];

  const printGroup = (name: string, components: string[]) => {
    const groupTotal = components.reduce((s, c) => s + (result.weights.get(c) || 0), 0);
    if (groupTotal < 0.01) return;

    console.log(`    // ${name} (${(groupTotal * 100).toFixed(0)}%)`);
    for (const c of components) {
      const w = result.weights.get(c) || 0;
      if (w >= 0.005) {
        console.log(`    (${c} * ${w.toFixed(3)}) +`);
      }
    }
  };

  printGroup('PROJECTION', projection);
  printGroup('CEILING/BOOM', ceiling);
  printGroup('OWNERSHIP LEVERAGE', ownership);
  printGroup('GAME THEORY', gameTheory);

  console.log('    0; // End\n');

  // Summary
  const projTotal = projection.reduce((s, c) => s + (result.weights.get(c) || 0), 0);
  const ceilTotal = ceiling.reduce((s, c) => s + (result.weights.get(c) || 0), 0);
  const ownTotal = ownership.reduce((s, c) => s + (result.weights.get(c) || 0), 0);
  const gtTotal = gameTheory.reduce((s, c) => s + (result.weights.get(c) || 0), 0);

  console.log('  FORMULA BREAKDOWN:');
  console.log(`    Projection:       ${(projTotal * 100).toFixed(0)}%`);
  console.log(`    Ceiling/Boom:     ${(ceilTotal * 100).toFixed(0)}%`);
  console.log(`    Ownership:        ${(ownTotal * 100).toFixed(0)}%`);
  console.log(`    Game Theory:      ${(gtTotal * 100).toFixed(0)}%`);

  console.log('\n' + '═'.repeat(70));
}

// ============================================================
// PRO PLAYER COMPARISON
// ============================================================

/**
 * Load pro portfolios from a slate's pros directory
 */
function loadProPortfolios(slateDir: string, date: string): Map<string, ProPortfolio> {
  const pros = new Map<string, ProPortfolio>();
  const prosDir = path.join(slateDir, `${date}_pros`);

  if (!fs.existsSync(prosDir)) {
    return pros;
  }

  const files = fs.readdirSync(prosDir);
  for (const file of files) {
    if (!file.endsWith('.csv')) continue;

    const username = file.replace('.csv', '').toLowerCase();
    const filePath = path.join(prosDir, file);

    try {
      const portfolio = parseProPortfolio(filePath, username);
      pros.set(username, portfolio);
    } catch (e) {
      console.warn(`  Warning: Could not parse ${file}`);
    }
  }

  return pros;
}

/**
 * Parse a pro portfolio CSV file
 */
function parseProPortfolio(filePath: string, username: string): ProPortfolio {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const exposures = new Map<string, number>();

  // Skip header
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = parseCSVLine(line);
    if (cols.length >= 2) {
      const playerName = cols[0].toLowerCase().trim();
      const exposure = parseFloat(cols[1]);
      if (!isNaN(exposure)) {
        exposures.set(playerName, exposure);
      }
    }
  }

  // Determine construction style
  const exposureValues = Array.from(exposures.values());
  const avgExposure = exposureValues.reduce((a, b) => a + b, 0) / exposureValues.length;
  const highExposures = exposureValues.filter(e => e > 40).length;
  const lowExposures = exposureValues.filter(e => e < 10 && e > 0).length;

  let constructionStyle: 'stars_scrubs' | 'balanced' | 'value' | 'mixed' = 'balanced';
  if (highExposures >= 3 && lowExposures >= 3) {
    constructionStyle = 'stars_scrubs';
  } else if (avgExposure < 20) {
    constructionStyle = 'value';
  }

  return {
    username,
    exposures,
    constructionStyle,
  };
}

/**
 * Parse contest results to extract pro lineups
 */
function loadContestResults(slateDir: string, date: string): Map<string, ProLineup[]> {
  const proLineups = new Map<string, ProLineup[]>();
  const contestPath = path.join(slateDir, `${date}_contest.csv`);

  if (!fs.existsSync(contestPath)) {
    return proLineups;
  }

  const content = fs.readFileSync(contestPath, 'utf-8');
  const lines = content.split('\n');

  // Parse header
  const header = lines[0].toLowerCase();
  const headers = header.split(',').map(h => h.trim());
  let rankCol = 0, userCol = 1, pointsCol = 2, lineupCol = 3;

  for (let i = 0; i < headers.length; i++) {
    if (headers[i].includes('rank') || headers[i].includes('place')) rankCol = i;
    if (headers[i].includes('user') || headers[i].includes('name') || headers[i].includes('entry')) userCol = i;
    if (headers[i].includes('points') || headers[i].includes('fpts') || headers[i].includes('score')) pointsCol = i;
    if (headers[i].includes('lineup') || headers[i].includes('players')) lineupCol = i;
  }

  // Parse data
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = parseCSVLine(line);
    if (cols.length > Math.max(rankCol, userCol, pointsCol)) {
      const username = cols[userCol].toLowerCase().trim();
      const rank = parseInt(cols[rankCol]);
      const points = parseFloat(cols[pointsCol]);
      const lineupStr = cols[lineupCol] || '';

      // Check if this is a tracked pro
      const isTrackedPro = TRACKED_PROS.some(pro =>
        username.includes(pro) || pro.includes(username)
      );

      if (isTrackedPro && !isNaN(points)) {
        const players = lineupStr.split(/[,;]/).map(p => p.trim().toLowerCase());

        if (!proLineups.has(username)) {
          proLineups.set(username, []);
        }

        proLineups.get(username)!.push({
          players,
          projection: 0,  // Unknown from contest results
          ownership: 0,   // Unknown from contest results
          actualScore: points,
          rank,
        });
      }
    }
  }

  return proLineups;
}

/**
 * Compare our portfolio against pro portfolios
 */
function compareAgainstPros(
  ourLineups: LineupResult[],
  proPortfolios: Map<string, ProPortfolio>,
  proContestResults: Map<string, ProLineup[]>,
  actuals: Map<string, number>
): ProComparisonResult {
  const proResults = new Map<string, ProSlateResult>();

  // Calculate our results
  const ourExposures = calculateExposures(ourLineups.map(l => l.lineup));
  const ourConstruction = analyzeConstruction(ourLineups.map(l => l.lineup));

  const ourResults: OurSlateResult = {
    slateCount: 1,
    avgROI: 0,  // Would need entry fee and payout info
    simWinRate: ourLineups.filter(l => l.actualPercentile >= 99.9).length / ourLineups.length * 100,
    simTop1PctRate: ourLineups.filter(l => l.actualPercentile >= 99).length / ourLineups.length * 100,
    simTop10PctRate: ourLineups.filter(l => l.actualPercentile >= 90).length / ourLineups.length * 100,
    simCashRate: ourLineups.filter(l => l.actualPercentile >= 50).length / ourLineups.length * 100,
    avgExposures: ourExposures,
    constructionBreakdown: ourConstruction,
  };

  // Analyze each pro
  for (const [username, portfolio] of proPortfolios) {
    const contestLineups = proContestResults.get(username) || [];

    // Calculate actual results from contest data
    let winCount = 0;
    let top1PctCount = 0;
    let top10PctCount = 0;
    let cashCount = 0;
    let totalLineups = contestLineups.length || 1;

    for (const lineup of contestLineups) {
      if (lineup.rank === 1) winCount++;
      if (lineup.rank && lineup.rank <= 100) top1PctCount++;  // Approx top 1%
      if (lineup.rank && lineup.rank <= 1000) top10PctCount++;
      if (lineup.rank && lineup.rank <= 5000) cashCount++;  // Approx cash line
    }

    // Find key differentiators (players they over-expose vs field avg)
    const keyDifferentiators: string[] = [];
    for (const [player, exposure] of portfolio.exposures) {
      // If exposure > 30% and significantly higher than typical
      if (exposure > 30) {
        keyDifferentiators.push(`${player}: ${exposure.toFixed(1)}%`);
      }
    }

    proResults.set(username, {
      username,
      slateCount: 1,
      avgROI: 0,  // Would need payout data
      winRate: (winCount / totalLineups) * 100,
      top1PctRate: (top1PctCount / totalLineups) * 100,
      top10PctRate: (top10PctCount / totalLineups) * 100,
      cashRate: (cashCount / totalLineups) * 100,
      avgExposures: portfolio.exposures,
      constructionBreakdown: {
        starsAndScrubs: portfolio.constructionStyle === 'stars_scrubs' ? 100 : 0,
        balanced: portfolio.constructionStyle === 'balanced' ? 100 : 0,
        value: portfolio.constructionStyle === 'value' ? 100 : 0,
      },
      keyDifferentiators: keyDifferentiators.slice(0, 5),
    });
  }

  // Calculate comparison metrics
  const comparison = calculateComparisonMetrics(ourResults, proResults);

  return {
    pros: proResults,
    ourResults,
    comparison,
  };
}

/**
 * Calculate player exposures from lineups
 */
function calculateExposures(lineups: Lineup[]): Map<string, number> {
  const exposures = new Map<string, number>();
  const totalLineups = lineups.length;

  if (totalLineups === 0) return exposures;

  for (const lineup of lineups) {
    for (const player of lineup.players) {
      const name = player.name.toLowerCase();
      exposures.set(name, (exposures.get(name) || 0) + 1);
    }
  }

  // Convert to percentages
  for (const [name, count] of exposures) {
    exposures.set(name, (count / totalLineups) * 100);
  }

  return exposures;
}

/**
 * Analyze construction style breakdown
 */
function analyzeConstruction(lineups: Lineup[]): { starsAndScrubs: number; balanced: number; value: number } {
  let starsAndScrubs = 0;
  let balanced = 0;
  let value = 0;

  for (const lineup of lineups) {
    const salaries = lineup.players.map(p => p.salary).sort((a, b) => b - a);
    const topSalary = salaries[0];
    const bottomSalary = salaries[salaries.length - 1];
    const spread = topSalary - bottomSalary;

    if (spread > 7000) {
      starsAndScrubs++;
    } else if (spread < 4000) {
      value++;
    } else {
      balanced++;
    }
  }

  const total = lineups.length || 1;
  return {
    starsAndScrubs: (starsAndScrubs / total) * 100,
    balanced: (balanced / total) * 100,
    value: (value / total) * 100,
  };
}

/**
 * Calculate comparison metrics between us and pros
 */
function calculateComparisonMetrics(
  ourResults: OurSlateResult,
  proResults: Map<string, ProSlateResult>
): ComparisonMetrics {
  const roiGap = new Map<string, number>();
  const exposureDiffs = new Map<string, Map<string, number>>();
  const constructionDiffs = new Map<string, string>();
  const recommendations: string[] = [];

  for (const [username, proResult] of proResults) {
    // ROI gap (negative means pro is beating us)
    roiGap.set(username, ourResults.avgROI - proResult.avgROI);

    // Exposure differences
    const diffs = new Map<string, number>();
    const allPlayers = new Set([
      ...ourResults.avgExposures.keys(),
      ...proResult.avgExposures.keys()
    ]);

    for (const player of allPlayers) {
      const ourExp = ourResults.avgExposures.get(player) || 0;
      const proExp = proResult.avgExposures.get(player) || 0;
      const diff = ourExp - proExp;

      if (Math.abs(diff) > 10) {  // Significant difference
        diffs.set(player, diff);
      }
    }
    exposureDiffs.set(username, diffs);

    // Construction style comparison
    const proStyle = proResult.constructionBreakdown.starsAndScrubs > 50 ? 'stars & scrubs' :
                     proResult.constructionBreakdown.value > 50 ? 'value' : 'balanced';
    const ourStyle = ourResults.constructionBreakdown.starsAndScrubs > 50 ? 'stars & scrubs' :
                     ourResults.constructionBreakdown.value > 50 ? 'value' : 'balanced';

    if (proStyle !== ourStyle) {
      constructionDiffs.set(username, `${username} uses ${proStyle}, we use ${ourStyle}`);
    }

    // Generate recommendations based on diffs
    for (const [player, diff] of diffs) {
      if (diff < -20) {
        recommendations.push(`Consider increasing ${player} exposure (${username} has +${Math.abs(diff).toFixed(0)}% more)`);
      }
    }
  }

  return {
    roiGap,
    exposureDiffs,
    constructionDiffs,
    recommendations: [...new Set(recommendations)].slice(0, 10),
  };
}

/**
 * Print pro comparison results
 */
function printProComparison(proComparison: ProComparisonResult): void {
  console.log('\n' + '═'.repeat(70));
  console.log('PRO PLAYER COMPARISON');
  console.log('═'.repeat(70));

  // Print our results
  console.log('\n📊 OUR PORTFOLIO METRICS:');
  console.log(`  Win Rate (sim):      ${proComparison.ourResults.simWinRate.toFixed(2)}%`);
  console.log(`  Top 1% Rate (sim):   ${proComparison.ourResults.simTop1PctRate.toFixed(2)}%`);
  console.log(`  Top 10% Rate (sim):  ${proComparison.ourResults.simTop10PctRate.toFixed(2)}%`);
  console.log(`  Cash Rate (sim):     ${proComparison.ourResults.simCashRate.toFixed(2)}%`);
  console.log(`  Construction: S&S=${proComparison.ourResults.constructionBreakdown.starsAndScrubs.toFixed(0)}% | Balanced=${proComparison.ourResults.constructionBreakdown.balanced.toFixed(0)}% | Value=${proComparison.ourResults.constructionBreakdown.value.toFixed(0)}%`);

  // Print each pro's results
  for (const [username, result] of proComparison.pros) {
    console.log(`\n👤 ${username.toUpperCase()}:`);
    if (result.winRate > 0 || result.top1PctRate > 0) {
      console.log(`  Win Rate:     ${result.winRate.toFixed(2)}%`);
      console.log(`  Top 1% Rate:  ${result.top1PctRate.toFixed(2)}%`);
      console.log(`  Top 10% Rate: ${result.top10PctRate.toFixed(2)}%`);
      console.log(`  Cash Rate:    ${result.cashRate.toFixed(2)}%`);
    }

    if (result.keyDifferentiators.length > 0) {
      console.log(`  Key Exposures: ${result.keyDifferentiators.join(', ')}`);
    }

    // Show exposure differences
    const diffs = proComparison.comparison.exposureDiffs.get(username);
    if (diffs && diffs.size > 0) {
      console.log(`  Exposure Diffs vs Us:`);
      const sortedDiffs = [...diffs.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 5);
      for (const [player, diff] of sortedDiffs) {
        const sign = diff > 0 ? '+' : '';
        console.log(`    ${player}: ${sign}${diff.toFixed(1)}% (we have ${diff > 0 ? 'more' : 'less'})`);
      }
    }
  }

  // Print recommendations
  if (proComparison.comparison.recommendations.length > 0) {
    console.log('\n💡 RECOMMENDATIONS:');
    for (const rec of proComparison.comparison.recommendations) {
      console.log(`  • ${rec}`);
    }
  }

  console.log('\n' + '═'.repeat(70));
}

// ============================================================
// UPDATED MAIN CALIBRATION TO INCLUDE PRO COMPARISON
// ============================================================

/**
 * Process slate with pro comparison
 */
async function processSlateWithPros(
  slate: SlatePair,
  site: DFSSite,
  sport: Sport,
  dataDir: string
): Promise<{ results: LineupResult[]; proComparison?: ProComparisonResult }> {
  // Load projections
  const parseResult = parseCSVFile(slate.projectionsPath, sport);
  const contestType = parseResult.detectedContestType;
  const config = getContestConfig(site, sport, contestType);
  const pool = buildPlayerPool(parseResult.players, contestType);

  // Load actuals
  const actuals = loadActuals(slate.actualsPath);

  // Load pro data
  const proPortfolios = loadProPortfolios(dataDir, slate.date);
  const proContestResults = loadContestResults(dataDir, slate.date);

  console.log(`  Found ${proPortfolios.size} pro portfolios, ${proContestResults.size} contest results`);

  // Generate lineups (smaller pool for calibration speed)
  const optimizationResult = optimizeLineups({
    config,
    pool,
    poolSize: 5000,
    minSalary: config.salaryCap - 1000,
  });

  // Take top 500 lineups for analysis
  const lineupsToAnalyze = optimizationResult.lineups
    .sort((a, b) => b.projection - a.projection)
    .slice(0, 500);

  // Score each lineup
  const results: LineupResult[] = [];

  for (const lineup of lineupsToAnalyze) {
    let actualScore = 0;
    for (const player of lineup.players) {
      const actual = actuals.get(player.name.toLowerCase()) ||
                     actuals.get(normalizePlayerName(player.name));
      if (actual !== undefined) {
        actualScore += actual;
      } else {
        actualScore = -1;
        break;
      }
    }

    if (actualScore < 0) continue;

    const components = calculateComponentScores(lineup, pool);
    const formulaScore = calculateFormulaScore(components, CURRENT_WEIGHTS);

    results.push({
      lineup,
      formulaScore,
      actualScore,
      actualPercentile: 0,
      components,
    });
  }

  // Calculate percentiles
  results.sort((a, b) => b.actualScore - a.actualScore);
  for (let i = 0; i < results.length; i++) {
    results[i].actualPercentile = 100 * (1 - i / results.length);
  }

  // Compare against pros if data available
  let proComparison: ProComparisonResult | undefined;
  if (proPortfolios.size > 0 || proContestResults.size > 0) {
    proComparison = compareAgainstPros(results, proPortfolios, proContestResults, actuals);
  }

  return { results, proComparison };
}

// ============================================================
// EXPORT
// ============================================================

export {
  CalibrationResult,
  SlateData,
  LineupResult,
  ProComparisonResult,
  ProPortfolio,
  ProSlateResult,
  TRACKED_PROS,
  loadProPortfolios,
  loadContestResults,
  compareAgainstPros,
  printProComparison,
};

// Export backtester module
export {
  Backtester, runBacktest, runSelectionSweep,
  findSlates, processSlate, computeTotalScore, scoreLineup,
  loadProjections, loadActuals,
  ComponentScores, ScoredEntry, ContestEntry, PlayerData, SlateResult,
} from './backtester';

// Export fast formula optimizer
export { runFastFormulaOptimizer } from './fast-formula-optimizer';
