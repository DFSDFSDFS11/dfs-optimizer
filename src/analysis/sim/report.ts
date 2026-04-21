/**
 * Full-analysis markdown renderer.
 */

import * as fs from 'fs';
import * as path from 'path';
import { FullSlateAnalysis } from './index';
import { FullCrossSlateReport } from './research-validation';

export interface FullReportOpts {
  outDir: string;
  sport: string;
  perSlate: FullSlateAnalysis[];
  crossSlate?: FullCrossSlateReport;
}

export function writeFullReport(opts: FullReportOpts): { markdownPath: string; jsonPath: string } {
  fs.mkdirSync(opts.outDir, { recursive: true });
  const label = opts.crossSlate ? `full_${opts.sport}` : `full_${opts.perSlate[0]?.slate || opts.sport}`;
  const mdPath = path.join(opts.outDir, `${label}.md`);
  const jsonPath = path.join(opts.outDir, `${label}.json`);

  let md = `# Full-Analysis Report\n**Sport:** ${opts.sport.toUpperCase()} | **Slates:** ${opts.perSlate.length}\n\n`;

  for (const s of opts.perSlate) {
    md += renderSlate(s);
    md += `\n---\n\n`;
  }

  if (opts.crossSlate) md += renderCrossSlate(opts.crossSlate);

  fs.writeFileSync(mdPath, md);
  fs.writeFileSync(jsonPath, JSON.stringify({
    sport: opts.sport,
    perSlate: opts.perSlate,
    crossSlate: opts.crossSlate ?? null,
  }, null, 2));
  return { markdownPath: mdPath, jsonPath };
}

// ============================================================
// PER-SLATE RENDERER
// ============================================================

function renderSlate(s: FullSlateAnalysis): string {
  const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;
  const fmt = (v: number, d = 2) => (v ?? 0).toFixed(d);
  let md = `## Slate ${s.slate} (${s.winnerAnatomy.totalEntries.toLocaleString()} entries, ${s.numGames} games)\n\n`;

  // Lineup-level separation
  md += `### Lineup-Level Separation (top-1% vs field)\n\n`;
  md += `| Metric | Top-1% avg | Field avg | Effect | Dir | Research | Match? |\n`;
  md += `|---|---:|---:|---:|:-:|---|:-:|\n`;
  for (const sep of s.lineupLevel.separationMetrics) {
    md += `| ${sep.metric} | ${fmt(sep.top1Avg, 3)} | ${fmt(sep.fieldAvg, 3)} | ${sep.effectSize >= 0 ? '+' : ''}${fmt(sep.effectSize, 2)} | ${sep.direction} | ${sep.researchPrediction || ''} | ${sep.researchMatch ? '✓' : '✗'} |\n`;
  }
  md += `\n`;

  // Variance quintiles
  md += `### Variance quintile → top-1% hit rate\n\n`;
  md += `| Bucket | Count | Top-1% rate | Avg variance | Avg actual |\n|---|---:|---:|---:|---:|\n`;
  for (const q of s.lineupLevel.varianceQuintiles) {
    md += `| Q${q.bucket} | ${q.lineupCount} | ${pct(q.top1HitRate, 2)} | ${fmt(q.avgVariance)} | ${fmt(q.avgActual)} |\n`;
  }
  md += `\n`;

  // Ownership quintiles
  md += `### Ownership quintile → top-1% hit rate\n\n`;
  md += `| Bucket | Count | Top-1% rate | Avg actual |\n|---|---:|---:|---:|\n`;
  for (const q of s.lineupLevel.ownershipQuintiles) {
    md += `| Q${q.bucket} | ${q.lineupCount} | ${pct(q.top1HitRate, 2)} | ${fmt(q.avgActual)} |\n`;
  }
  md += `\n`;

  // Stack depth
  md += `### Stack depth → top-1% hit rate\n\n`;
  md += `| Depth | Count | Top-1% rate | Avg variance |\n|---|---:|---:|---:|\n`;
  for (const q of s.lineupLevel.stackDepthBreakdown) {
    md += `| ${q.bucket} | ${q.lineupCount} | ${pct(q.top1HitRate, 2)} | ${fmt(q.avgVariance)} |\n`;
  }
  md += `\n`;

  md += `- **Spearman projection → actual correlation:** ${fmt(s.lineupLevel.projectionActualCorrelation, 3)}\n`;
  if (s.lineupLevel.idealLineupProfile) {
    const ideal = s.lineupLevel.idealLineupProfile;
    md += `- **Ideal lineup:** ${fmt(ideal.actualScore)} actual (proj ${fmt(ideal.projectedScore)}, own ${pct(ideal.avgOwnership)}, variance ${fmt(ideal.simVariance)}, stack ${ideal.primaryStackTeam}×${ideal.primaryStackDepth})\n`;
  }
  if (s.lineupLevel.bestPoolLineupProfile) {
    const bp = s.lineupLevel.bestPoolLineupProfile;
    md += `- **Best pool lineup:** ${fmt(bp.actualScore)} actual (proj ${fmt(bp.projectedScore)}, stack ${bp.primaryStackTeam}×${bp.primaryStackDepth})\n`;
  }
  md += `\n`;

  // Pro portfolios — simulation table
  if (s.pros.proPortfolios.length > 0) {
    md += `### Pro Portfolios — Simulation Metrics\n\n`;
    md += `| Pro | N | Top-1% | E[max] | Prod entries | AvgCorr | NegPair% | VarDiff | Cov@1% | Anchor lev |\n`;
    md += `|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n`;
    for (const ps of s.pros.proPortfolios.slice(0, 10)) {
      const sim = ps.sim;
      md += `| ${ps.username} | ${ps.entryCount} | ${pct(ps.top1Rate, 2)} | ${fmt(sim.expectedMax)} | ${sim.productiveEntryCount}/${sim.entryCount} | ${fmt(sim.avgPairwiseCorrelation, 3)} | ${pct(sim.negativePairFraction)} | ${fmt(sim.avgVarDifference)} | ${pct(sim.coverageByTier[1]?.coverageRate ?? 0)} | ${fmt(sim.anchorLeverageRatio, 2)} |\n`;
    }
    md += `\n`;

    // Top pro's gain curve summary
    const top = s.pros.proPortfolios[0];
    if (top && top.sim.gainCurve.length > 0) {
      md += `#### ${top.username} — Greedy Marginal Gain Curve (checkpoints)\n\n`;
      md += `| Entry # | Marginal | Cumulative | Max ρ w/ prev | Proj | Variance |\n|---:|---:|---:|---:|---:|---:|\n`;
      const cps = [1, 5, 10, 25, 50, 75, 100, 150];
      for (const cp of cps) {
        const row = top.sim.gainCurve[cp - 1];
        if (!row) continue;
        md += `| ${row.entryNumber} | ${row.marginalGain} | ${row.cumulativeGain} | ${fmt(row.maxCorrWithPrevious, 3)} | ${fmt(row.entryProjection)} | ${fmt(row.entryVariance)} |\n`;
      }
      md += `- Productive entries: **${top.sim.productiveEntryCount}** / ${top.sim.entryCount} (${top.sim.deadweightEntries} deadweight)\n\n`;
    }
  }

  // Pool-as-portfolio
  const pap = s.poolAsPortfolio;
  if (pap) {
    md += `### SS Pool as Portfolio\n\n`;
    md += `- **Pool size:** ${pap.poolPortfolio?.entryCount.toLocaleString() || 'n/a'} (sampled from pool)\n`;
    md += `- **Pool E[max]:** ${fmt(pap.poolPortfolio?.expectedMax ?? 0)}  |  Avg pair corr: ${fmt(pap.poolPortfolio?.avgPairwiseCorrelation ?? 0, 3)} (field: ${fmt(pap.fieldAvgPairCorrelation, 3)})\n`;
    md += `- **Player coverage:** ${pap.playersInPool}/${pap.playersOnSlate} (${pct(pap.playerCoverage)})\n`;
    md += `- **Winner avg variance (${fmt(pap.winnerAvgVariance)}) sits at pool's ${(pap.winnerVariancePoolPercentile * 100).toFixed(0)}th percentile** — ${pap.winnerVariancePoolPercentile > 0.85 ? '⚠ pool rarely generates winners\' variance' : 'pool variance adequate'}\n\n`;

    md += `**Coverage: pool vs field**\n\n`;
    md += `| Tier | Pool rate | Field rate | Gap |\n|---|---:|---:|---:|\n`;
    for (let i = 0; i < pap.poolCoverageByTier.length; i++) {
      const pt = pap.poolCoverageByTier[i], ft = pap.fieldCoverageByTier[i];
      md += `| p${pt.percentile} | ${pct(pt.rate)} | ${pct(ft.rate)} | ${pct(ft.rate - pt.rate)} |\n`;
    }
    md += `\n`;

    md += `**Pool variance distribution**\n\n`;
    md += `| Percentile | Variance |\n|---:|---:|\n`;
    for (const v of pap.poolVarianceDistribution) md += `| ${v.percentile}th | ${fmt(v.variance)} |\n`;
    md += `\n`;

    const topGaps = pap.poolStackGaps.filter(g => g.gap > 0.02).slice(0, 6);
    if (topGaps.length > 0) {
      md += `**Stack gaps (winner rate − pool rate)**\n\n`;
      md += `| Team | Winner | Pool | Field | Gap |\n|---|---:|---:|---:|---:|\n`;
      for (const g of topGaps) {
        md += `| ${g.team} | ${pct(g.winnerStackRate)} | ${pct(g.poolStackRate)} | ${pct(g.fieldStackRate)} | **${pct(g.gap)}** |\n`;
      }
      md += `\n`;
    }

    if (pap.recommendations.length > 0) {
      md += `**Pool augmentation recommendations (ranked)**\n\n`;
      for (const r of pap.recommendations) {
        md += `${r.priority}. **${r.type}** — ${r.detail}\n   _Rationale:_ ${r.rationale}\n   _Expected improvement:_ +${(r.expectedCaptureImprovement * 100).toFixed(0)}% capture\n\n`;
      }
    }
  }

  return md;
}

// ============================================================
// CROSS-SLATE RENDERER
// ============================================================

function renderCrossSlate(cs: FullCrossSlateReport): string {
  const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;
  const fmt = (v: number, d = 3) => (v ?? 0).toFixed(d);
  let md = `# Full Calibration Report (${cs.slatesAnalyzed} slates)\n\n`;

  md += `## Research Validation\n\n`;
  md += `| Prediction | Paper | Validated | Effect | Consistency | Implication |\n`;
  md += `|---|---|:-:|---:|---:|---|\n`;
  for (const v of cs.researchValidation) {
    md += `| ${v.prediction} | ${v.paper} | ${v.validated ? '✓' : '✗'} | ${fmt(v.avgEffectSize, 2)} | ${pct(v.consistency)} | ${v.implication} |\n`;
  }
  md += `\n`;

  md += `## Portfolio Metric → Top-1% Correlation\n\n`;
  md += `| Metric | Pearson r | Spearman ρ | Consistency | Current | Target | Parameter |\n`;
  md += `|---|---:|---:|---:|---:|---:|---|\n`;
  for (const m of cs.metricRanking) {
    md += `| ${m.metric} | ${fmt(m.correlationWithTop1, 3)} | ${fmt(m.rankCorrelation, 3)} | ${pct(m.consistency)} | ${fmt(m.currentValue)} | ${fmt(m.targetValue)} | ${m.parameterToAdjust} |\n`;
  }
  md += `\n`;

  md += `## Prioritized Actions\n\n`;
  for (const a of cs.prioritizedActions) {
    md += `${a.rank}. **[${a.type}, effort=${a.effort}]** ${a.action}\n   _Expected impact:_ ${a.expectedImpact}\n   _Research basis:_ ${a.researchBasis}\n\n`;
  }

  return md;
}
