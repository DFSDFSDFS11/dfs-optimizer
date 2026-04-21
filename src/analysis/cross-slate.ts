/**
 * Module 5: CROSS-SLATE PATTERNS.
 *
 * Takes a list of SlateAnalysis results and finds patterns that hold across
 * slates. Produces consistency-weighted deltas and calibration recommendations.
 */

import { SlateAnalysis } from './index';

export interface CrossSlatePattern {
  metric: string;
  winnerAvg: number;
  fieldAvg: number;
  delta: number;
  consistency: number;   // fraction of slates where delta has the same sign
  researchBasis?: string;
}

export interface ProGap {
  metric: string;
  proAvg: number;
  fieldAvg: number;
  gap: number;           // pro - field
  consistency: number;   // fraction of slates where gap has same sign
  researchBasis?: string;
}

export interface RecurringPoolGap {
  gapType: string;
  frequency: number;     // fraction of slates with the gap
  avgImpact: number;
}

export interface ParameterRecommendation {
  param: string;
  currentGuess: string;
  recommendedValue: string;
  basis: string;
}

export interface CrossSlateReport {
  slatesAnalyzed: number;

  winnerPatterns: CrossSlatePattern[];
  proGaps: ProGap[];
  avgPoolCaptureRate: number | null;
  recurringPoolGaps: RecurringPoolGap[];

  alphaPlayerProfile: {
    avgOwnership: number;
    avgSalary: number;
    avgProjectionError: number;
    avgCeilingRealization: number;
  };

  parameterRecommendations: ParameterRecommendation[];

  slateClassification: Array<{
    slate: string;
    topOwnership: number;
    numGames: number;
    totalEntries: number;
    outcome: 'chalk_won' | 'contrarian_won' | 'mixed';
  }>;
}

export function analyzeCrossSlate(results: SlateAnalysis[]): CrossSlateReport {
  if (results.length === 0) {
    return emptyReport();
  }

  const n = results.length;
  const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const consistency = (deltas: number[]): number => {
    if (deltas.length === 0) return 0;
    const pos = deltas.filter(d => d > 0).length;
    const neg = deltas.filter(d => d < 0).length;
    return Math.max(pos, neg) / deltas.length;
  };

  // ─── Winner patterns ───
  const ownershipDeltas = results.map(r => r.winnerAnatomy.winnerAvgOwnership - r.winnerAnatomy.fieldAvgOwnership);
  const varianceDeltas = results.map(r => r.winnerAnatomy.varianceDelta);
  const projectionDeltas = results.map(r => r.winnerAnatomy.projectionDelta);
  const stackDeltas = results.map(r => r.winnerAnatomy.stackDepthDelta);

  const winnerPatterns: CrossSlatePattern[] = [
    {
      metric: 'Avg player ownership',
      winnerAvg: avg(results.map(r => r.winnerAnatomy.winnerAvgOwnership)),
      fieldAvg: avg(results.map(r => r.winnerAnatomy.fieldAvgOwnership)),
      delta: avg(ownershipDeltas),
      consistency: consistency(ownershipDeltas),
      researchBasis: 'Liu et al. — contrarian entries maximize E[max]',
    },
    {
      metric: 'Lineup variance',
      winnerAvg: avg(results.map(r => r.winnerAnatomy.winnerAvgVariance)),
      fieldAvg: avg(results.map(r => r.winnerAnatomy.fieldAvgVariance)),
      delta: avg(varianceDeltas),
      consistency: consistency(varianceDeltas),
      researchBasis: 'Hunter Principle 2 — high variance wins GPPs',
    },
    {
      metric: 'Total projection',
      winnerAvg: avg(results.map(r => r.winnerAnatomy.winnerAvgProjection)),
      fieldAvg: avg(results.map(r => r.winnerAnatomy.fieldAvgProjection)),
      delta: avg(projectionDeltas),
      consistency: consistency(projectionDeltas),
      researchBasis: 'Hunter Principle 1 — reasonable mean still matters',
    },
    {
      metric: 'Max team stack depth',
      winnerAvg: avg(results.map(r => r.winnerAnatomy.winnerAvgStackDepth)),
      fieldAvg: avg(results.map(r => r.winnerAnatomy.fieldAvgStackDepth)),
      delta: avg(stackDeltas),
      consistency: consistency(stackDeltas),
      researchBasis: 'H-S — correlated stacks concentrate variance',
    },
  ];

  // ─── Pro gaps ───
  const topProStats: Array<{ proAvgOwn: number; proAvgVar: number; proMaxExp: number; proOverlap: number; proStackTeams: number }> = [];
  for (const r of results) {
    const topPros = r.proAnalysis?.topPros.slice(0, 3) ?? [];
    if (topPros.length === 0) continue;
    topProStats.push({
      proAvgOwn: avg(topPros.map(p => p.avgOwnership)),
      proAvgVar: avg(topPros.map(p => p.avgVariance)),
      proMaxExp: avg(topPros.map(p => p.maxExposure)),
      proOverlap: avg(topPros.map(p => p.avgPairwiseOverlap)),
      proStackTeams: avg(topPros.map(p => p.uniqueStackTeams)),
    });
  }

  const proGaps: ProGap[] = [];
  if (topProStats.length > 0) {
    const fieldOwn = avg(results.map(r => r.proAnalysis?.fieldAvgs.avgOwnership ?? 0));
    const fieldVar = avg(results.map(r => r.proAnalysis?.fieldAvgs.avgVariance ?? 0));
    const fieldMaxExp = avg(results.map(r => r.proAnalysis?.fieldAvgs.maxExposure ?? 0));
    const proOwnArr = topProStats.map(s => s.proAvgOwn - fieldOwn);
    const proVarArr = topProStats.map(s => s.proAvgVar - fieldVar);
    const proExpArr = topProStats.map(s => s.proMaxExp - fieldMaxExp);

    proGaps.push({
      metric: 'Avg ownership',
      proAvg: avg(topProStats.map(s => s.proAvgOwn)),
      fieldAvg: fieldOwn,
      gap: avg(proOwnArr),
      consistency: consistency(proOwnArr),
      researchBasis: 'H-S σ_{δ,G} — pros fade chalk',
    });
    proGaps.push({
      metric: 'Lineup variance',
      proAvg: avg(topProStats.map(s => s.proAvgVar)),
      fieldAvg: fieldVar,
      gap: avg(proVarArr),
      consistency: consistency(proVarArr),
      researchBasis: 'Hunter Principle 2',
    });
    proGaps.push({
      metric: 'Max exposure',
      proAvg: avg(topProStats.map(s => s.proMaxExp)),
      fieldAvg: fieldMaxExp,
      gap: avg(proExpArr),
      consistency: consistency(proExpArr),
      researchBasis: 'Liu Eq 14 — portfolio diversification',
    });
  }

  // ─── Pool capture rate ───
  const poolRates = results.map(r => r.poolGap?.poolCaptureRate).filter((v): v is number => v !== undefined);
  const avgPoolCaptureRate = poolRates.length ? avg(poolRates) : null;

  // ─── Recurring pool gaps ───
  const recurringPoolGaps: RecurringPoolGap[] = [];
  const slatesWithPool = results.filter(r => r.poolGap).length;
  if (slatesWithPool > 0) {
    const missingStacksFreq = results.filter(r => r.poolGap && r.poolGap.missingStacks.length > 0).length / slatesWithPool;
    const missingAlphasFreq = results.filter(r => r.poolGap && r.poolGap.missingAlphaPlayers.some(a => !a.inPool || a.poolExposure < 0.05)).length / slatesWithPool;
    recurringPoolGaps.push({
      gapType: 'missing_team_stacks',
      frequency: missingStacksFreq,
      avgImpact: avg(results.map(r => r.poolGap?.missingStacks[0]?.stackGap ?? 0)),
    });
    recurringPoolGaps.push({
      gapType: 'missing_alpha_players',
      frequency: missingAlphasFreq,
      avgImpact: avg(results.map(r => r.poolGap?.missingAlphaPlayers.filter(a => !a.inPool).length ?? 0)),
    });
  }

  // ─── Alpha profile ───
  const allAlphas = results.flatMap(r => r.winnerAnatomy.alphaPlayers);
  const alphaPlayerProfile = {
    avgOwnership: avg(allAlphas.map(a => a.ownership)),
    avgSalary: avg(allAlphas.map(a => a.salary)),
    avgProjectionError: avg(allAlphas.map(a => a.projectionError)),
    avgCeilingRealization: avg(allAlphas.map(a => a.ceilingRealization)),
  };

  // ─── Parameter recommendations ───
  const parameterRecommendations: ParameterRecommendation[] = [];
  const varianceDelta = avg(varianceDeltas);
  const ownershipDelta = avg(ownershipDeltas);

  if (consistency(varianceDeltas) >= 0.65 && varianceDelta > 0.10) {
    parameterRecommendations.push({
      param: 'varianceTopFraction',
      currentGuess: '0.70',
      recommendedValue: (0.60 + 0.10 * (1 - Math.min(1, varianceDelta))).toFixed(2),
      basis: `Winners had ${(varianceDelta * 100).toFixed(0)}% higher variance (${(consistency(varianceDeltas) * 100).toFixed(0)}% consistency)`,
    });
  }
  if (consistency(ownershipDeltas) >= 0.65) {
    const dirSign = ownershipDelta < 0 ? 'fade' : 'embrace';
    parameterRecommendations.push({
      param: 'projectionFloor',
      currentGuess: '0.60',
      recommendedValue: ownershipDelta < 0 ? '0.55' : '0.65',
      basis: `Winners ${dirSign}d chalk by ${Math.abs(ownershipDelta * 100).toFixed(1)}pp (${(consistency(ownershipDeltas) * 100).toFixed(0)}% consistency)`,
    });
  }
  if (topProStats.length >= 3) {
    const avgProMaxExp = avg(topProStats.map(s => s.proMaxExp));
    parameterRecommendations.push({
      param: 'maxExposure',
      currentGuess: '0.40',
      recommendedValue: avgProMaxExp.toFixed(2),
      basis: `Top pros run at ${(avgProMaxExp * 100).toFixed(0)}% avg max exposure`,
    });
  }
  if (avgPoolCaptureRate !== null && avgPoolCaptureRate < 0.50) {
    parameterRecommendations.push({
      param: 'SS pool generation',
      currentGuess: 'standard',
      recommendedValue: 'multi-pool (ownership-cap + per-team + ceiling-weighted)',
      basis: `Pool captured only ${(avgPoolCaptureRate * 100).toFixed(0)}% of winners — selector is capped`,
    });
  }

  // ─── Slate classification ───
  const slateClassification = results.map(r => ({
    slate: r.slate,
    topOwnership: r.fieldAnalysis.top5OwnedPlayers[0]?.ownership ?? 0,
    numGames: r.numGames,
    totalEntries: r.winnerAnatomy.totalEntries,
    outcome: r.fieldAnalysis.slateType,
  }));

  return {
    slatesAnalyzed: n,
    winnerPatterns,
    proGaps,
    avgPoolCaptureRate,
    recurringPoolGaps,
    alphaPlayerProfile,
    parameterRecommendations,
    slateClassification,
  };
}

function emptyReport(): CrossSlateReport {
  return {
    slatesAnalyzed: 0,
    winnerPatterns: [],
    proGaps: [],
    avgPoolCaptureRate: null,
    recurringPoolGaps: [],
    alphaPlayerProfile: { avgOwnership: 0, avgSalary: 0, avgProjectionError: 0, avgCeilingRealization: 0 },
    parameterRecommendations: [],
    slateClassification: [],
  };
}
