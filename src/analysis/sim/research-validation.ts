/**
 * Part 4: RESEARCH VALIDATION + METRIC-TO-WIN CORRELATION RANKING.
 *
 * Takes an array of FullSlateAnalysis results (per-slate sim output) and
 * produces:
 *   • per-prediction empirical validation (did the research hold?)
 *   • portfolio metric → top-1% rate correlation ranking
 *   • prioritized actions (ranked by expected impact × consistency)
 */

import { FullSlateAnalysis } from './index';
import { PortfolioSim } from './portfolio-sim';

export interface ResearchValidation {
  prediction: string;
  paper: string;
  validated: boolean;
  avgEffectSize: number;
  consistency: number;
  implication: string;
}

export interface MetricPredictiveness {
  metric: string;
  correlationWithTop1: number;
  rankCorrelation: number;
  consistency: number;
  currentValue: number;         // our selector avg (best-ranked pro as proxy)
  targetValue: number;
  recommendedValue: number;
  parameterToAdjust: string;
}

export interface PrioritizedAction {
  rank: number;
  action: string;
  type: 'pool_generation' | 'selector_parameter' | 'correlation_engine';
  expectedImpact: string;
  effort: 'low' | 'medium' | 'high';
  researchBasis: string;
}

export interface FullCrossSlateReport {
  slatesAnalyzed: number;
  researchValidation: ResearchValidation[];
  metricRanking: MetricPredictiveness[];
  prioritizedActions: PrioritizedAction[];
}

// ============================================================
// MAIN
// ============================================================

export function buildFullCrossSlate(results: FullSlateAnalysis[]): FullCrossSlateReport {
  const n = results.length;

  // ─── Research validation from lineup separation ───
  const researchValidation: ResearchValidation[] = [];
  const predictionKeys = [
    { metric: 'simVariance',       paper: 'Hunter Principle 2',         implication: 'Tighten variance floor in selector; weight ceilingRatio' },
    { metric: 'avgOwnership',      paper: 'Haugh-Singal',                implication: 'Adjust projection floor / chalk penalty' },
    { metric: 'primaryStackDepth', paper: 'Hunter Eq 2.8',               implication: 'Require 4+ stacks in MLB, aggressive stacking rules' },
    { metric: 'netCorrelation',    paper: 'Hunter Eq 2.8',               implication: 'Reward within-lineup positive correlation' },
    { metric: 'ownershipProduct',  paper: 'Haugh-Singal uniqueness',    implication: 'Include lineup uniqueness in selector score' },
    { metric: 'bringBackCount',    paper: 'H-S opposing stack',          implication: 'Force bring-backs in MLB/NFL pool generation' },
    { metric: 'projectedScore',    paper: 'Hunter Principle 1',          implication: 'Keep meaningful projection weight' },
  ];

  for (const pk of predictionKeys) {
    const effects: number[] = [];
    const matches: boolean[] = [];
    for (const r of results) {
      const m = r.lineupLevel.separationMetrics.find(s => s.metric === pk.metric);
      if (!m) continue;
      effects.push(m.effectSize);
      matches.push(m.researchMatch ?? false);
    }
    if (effects.length === 0) continue;
    const avgEffect = effects.reduce((a, b) => a + b, 0) / effects.length;
    const consistency = matches.filter(Boolean).length / matches.length;
    researchValidation.push({
      prediction: `${pk.metric} separates top-1%`,
      paper: pk.paper,
      validated: consistency >= 0.65 && Math.abs(avgEffect) >= 0.10,
      avgEffectSize: avgEffect,
      consistency,
      implication: pk.implication,
    });
  }
  researchValidation.sort((a, b) => Math.abs(b.avgEffectSize) - Math.abs(a.avgEffectSize));

  // ─── Metric ranking: portfolio-metric → top-1% rate ───
  // Gather (portfolioSim, top1Rate) pairs across all slates
  const allPortfolios: Array<{ sim: PortfolioSim; top1Rate: number }> = [];
  for (const r of results) {
    for (const ps of r.pros.proPortfolios) {
      const top1Rate = ps.top1Rate ?? 0;
      allPortfolios.push({ sim: ps.sim, top1Rate });
    }
  }
  const metricsToCheck: Array<{ name: string; getter: (s: PortfolioSim) => number; param: string }> = [
    { name: 'expectedMax',                getter: s => s.expectedMax,                param: 'rewardWeights / selector objective' },
    { name: 'productiveEntryCount',       getter: s => s.productiveEntryCount,       param: 'N / diversification boost' },
    { name: 'avgPairwiseCorrelation',     getter: s => s.avgPairwiseCorrelation,     param: 'rhoMax (hedging) / gamma (alg7)' },
    { name: 'negativePairFraction',       getter: s => s.negativePairFraction,       param: 'forced opposing stacks' },
    { name: 'avgVarDifference',           getter: s => s.avgVarDifference,           param: 'Liu Eq 14 target' },
    { name: 'coverageTop1',               getter: s => s.coverageByTier[1]?.coverageRate ?? 0, param: 'candidate pool diversity' },
    { name: 'maxPlayerExposure',          getter: s => s.maxPlayerExposure,          param: 'maxExposure' },
    { name: 'playerExposureHHI',          getter: s => s.playerExposureHHI,          param: 'exposure HHI constraint' },
    { name: 'uniqueStackTeams',           getter: s => s.uniqueStackTeams,           param: 'stack diversity requirement' },
    { name: 'opposingCoverageRate',       getter: s => s.opposingCoverageRate,       param: 'opposing-stack pool generation' },
  ];

  const metricRanking: MetricPredictiveness[] = [];
  for (const m of metricsToCheck) {
    const pts = allPortfolios.map(p => ({ x: m.getter(p.sim), y: p.top1Rate }));
    if (pts.length < 3) continue;
    const r = pearson(pts);
    const rs = spearman(pts);
    // Consistency: fraction of (slate, portfolio) pairs where higher metric → above-median top-1%
    const medianT1 = median(pts.map(p => p.y));
    const medianX = median(pts.map(p => p.x));
    const agreeing = pts.filter(p =>
      (p.x > medianX && p.y > medianT1) || (p.x <= medianX && p.y <= medianT1),
    ).length;
    const consistency = agreeing / pts.length;

    // Current vs target value: use top-quartile portfolios as target
    const sortedByY = [...pts].sort((a, b) => b.y - a.y);
    const topQ = sortedByY.slice(0, Math.max(1, Math.floor(sortedByY.length / 4)));
    const botQ = sortedByY.slice(-Math.max(1, Math.floor(sortedByY.length / 4)));
    const target = avg(topQ.map(p => p.x));
    const current = avg(botQ.map(p => p.x));

    metricRanking.push({
      metric: m.name,
      correlationWithTop1: r,
      rankCorrelation: rs,
      consistency,
      currentValue: current,
      targetValue: target,
      recommendedValue: target,
      parameterToAdjust: m.param,
    });
  }
  metricRanking.sort((a, b) => Math.abs(b.correlationWithTop1) - Math.abs(a.correlationWithTop1));

  // ─── Prioritized actions ───
  const actions: PrioritizedAction[] = [];

  // Pool generation priorities from recurring pool recommendations
  const poolRecFreq = new Map<string, { slates: Set<string>; detail: string; basis: string }>();
  for (const r of results) {
    const seenTypes = new Set<string>();
    for (const rec of r.poolAsPortfolio?.recommendations ?? []) {
      const key = rec.type;
      if (seenTypes.has(key)) continue;
      seenTypes.add(key);
      const ex = poolRecFreq.get(key);
      if (ex) ex.slates.add(r.slate);
      else poolRecFreq.set(key, { slates: new Set([r.slate]), detail: rec.detail, basis: rec.rationale });
    }
  }
  for (const [type, { slates, detail, basis }] of poolRecFreq) {
    const freq = slates.size / n;
    if (freq < 0.33) continue;
    actions.push({
      rank: 0,  // filled later
      action: detail,
      type: 'pool_generation',
      expectedImpact: `Applicable on ${(freq * 100).toFixed(0)}% of slates`,
      effort: type === 'ownership_cap' ? 'low' : 'medium',
      researchBasis: basis,
    });
  }

  // Top-3 predictive portfolio metrics → selector parameter recommendations
  const top3 = metricRanking.slice(0, 3);
  for (const m of top3) {
    if (Math.abs(m.correlationWithTop1) < 0.15) continue;
    actions.push({
      rank: 0,
      action: `Calibrate ${m.parameterToAdjust} to target ${m.metric}=${m.recommendedValue.toFixed(3)} (top-quartile portfolios run here)`,
      type: 'selector_parameter',
      expectedImpact: `r=${m.correlationWithTop1.toFixed(2)} with top-1% rate across ${allPortfolios.length} (pro, slate) pairs`,
      effort: 'low',
      researchBasis: `Empirical correlation on ${n} slates`,
    });
  }

  // Sort actions by effort × expected effect
  actions.forEach((a, i) => a.rank = i + 1);

  return {
    slatesAnalyzed: n,
    researchValidation,
    metricRanking,
    prioritizedActions: actions,
  };
}

// ============================================================
// STATS HELPERS
// ============================================================

function pearson(pts: Array<{ x: number; y: number }>): number {
  const n = pts.length;
  if (n < 2) return 0;
  const mx = avg(pts.map(p => p.x));
  const my = avg(pts.map(p => p.y));
  let num = 0, dx = 0, dy = 0;
  for (const p of pts) {
    num += (p.x - mx) * (p.y - my);
    dx += (p.x - mx) * (p.x - mx);
    dy += (p.y - my) * (p.y - my);
  }
  const d = Math.sqrt(dx * dy);
  return d > 1e-12 ? num / d : 0;
}

function spearman(pts: Array<{ x: number; y: number }>): number {
  const xs = pts.map(p => p.x);
  const ys = pts.map(p => p.y);
  const rx = ranks(xs);
  const ry = ranks(ys);
  return pearson(rx.map((x, i) => ({ x, y: ry[i] })));
}

function ranks(arr: number[]): number[] {
  const idx = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const r = new Array(arr.length);
  for (let i = 0; i < idx.length; i++) r[idx[i].i] = i + 1;
  return r;
}

function avg(a: number[]): number {
  if (a.length === 0) return 0;
  let s = 0; for (const x of a) s += x; return s / a.length;
}

function median(a: number[]): number {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
