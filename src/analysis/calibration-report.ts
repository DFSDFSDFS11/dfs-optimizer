/**
 * Calibration report writer.
 *
 * Renders single-slate and cross-slate analyses to markdown + JSON. Markdown
 * is human-readable; JSON preserves every metric for downstream automation.
 */

import * as fs from 'fs';
import * as path from 'path';
import { SlateAnalysis } from './index';
import { CrossSlateReport } from './cross-slate';

export interface CalibrationReportOptions {
  outDir: string;
  sport: string;
  perSlate: SlateAnalysis[];
  crossSlate?: CrossSlateReport;
}

export function generateCalibrationReport(opts: CalibrationReportOptions): {
  markdownPath: string;
  jsonPath: string;
} {
  const { outDir, sport, perSlate, crossSlate } = opts;
  fs.mkdirSync(outDir, { recursive: true });

  const label = crossSlate ? `all_${sport}` : perSlate[0]?.slate || sport;
  const mdPath = path.join(outDir, `analysis_${label}.md`);
  const jsonPath = path.join(outDir, `analysis_${label}.json`);

  // ─── Markdown ───
  let md = '';
  md += `# Backtest Intelligence Report\n`;
  md += `**Sport:** ${sport.toUpperCase()}  |  **Slates analyzed:** ${perSlate.length}\n\n`;

  for (const s of perSlate) {
    md += renderSlateMarkdown(s);
    md += `\n---\n\n`;
  }

  if (crossSlate) {
    md += renderCrossSlateMarkdown(crossSlate);
  }

  fs.writeFileSync(mdPath, md);

  // ─── JSON ───
  const jsonPayload = {
    sport,
    perSlate: perSlate.map(toJsonSafe),
    crossSlate: crossSlate ?? null,
  };
  fs.writeFileSync(jsonPath, JSON.stringify(jsonPayload, null, 2));

  return { markdownPath: mdPath, jsonPath };
}

// ============================================================
// SINGLE-SLATE MARKDOWN
// ============================================================

function renderSlateMarkdown(s: SlateAnalysis): string {
  const w = s.winnerAnatomy;
  const f = s.fieldAnalysis;
  const pro = s.proAnalysis;
  const pg = s.poolGap;

  const pct = (v: number, digits = 1) => `${(v * 100).toFixed(digits)}%`;
  const fmt = (v: number, digits = 1) => v.toFixed(digits);

  let md = `## Slate: ${s.slate} (${w.totalEntries.toLocaleString()} entries)\n\n`;

  // ─── Winner Anatomy ───
  md += `### What Won\n\n`;
  md += `- **Top 1% threshold:** ${fmt(w.top1Threshold)} pts (${w.top1Count} entries)\n`;
  md += `- **Winner avg ownership:** ${pct(w.winnerAvgOwnership)} vs field ${pct(w.fieldAvgOwnership)} → **${w.ownershipDirection}** (Δ ${w.ownershipDelta >= 0 ? '+' : ''}${w.ownershipDelta.toFixed(1)}pp)\n`;
  md += `- **Winner avg projection:** ${fmt(w.winnerAvgProjection)} vs field ${fmt(w.fieldAvgProjection)} (Δ ${(w.projectionDelta * 100).toFixed(1)}%)\n`;
  md += `- **Winner avg actual:** ${fmt(w.winnerAvgActual)} (error ${w.winnerAvgError >= 0 ? '+' : ''}${fmt(w.winnerAvgError)} vs proj)\n`;
  md += `- **Winner avg variance:** ${fmt(w.winnerAvgVariance)} vs field ${fmt(w.fieldAvgVariance)} (Δ ${(w.varianceDelta * 100).toFixed(1)}%)\n`;
  md += `- **Winner avg stack depth:** ${fmt(w.winnerAvgStackDepth, 2)} vs field ${fmt(w.fieldAvgStackDepth, 2)}\n`;
  md += `- **Salary usage:** winner $${Math.round(w.winnerAvgSalary).toLocaleString()} (leftover $${Math.round(w.winnerAvgSalaryLeftover)})\n\n`;

  // Alpha players
  md += `#### Alpha Players (highest winner lift)\n\n`;
  md += `| Player | Pos | Team | Own% | Proj | Actual | Err | Win% | Field% | Lift |\n`;
  md += `|---|---|---|---:|---:|---:|---:|---:|---:|---:|\n`;
  for (const a of w.alphaPlayers.slice(0, 10)) {
    md += `| ${a.name} | ${a.position} | ${a.team} | ${pct(a.ownership)} | ${fmt(a.projection)} | ${fmt(a.actual)} | ${a.projectionError >= 0 ? '+' : ''}${fmt(a.projectionError)} | ${pct(a.frequencyInTop1)} | ${pct(a.frequencyInField)} | ${fmt(a.winnerLift, 2)}x |\n`;
  }
  md += `\n`;

  // Top stacks in winners
  md += `#### Winning Stacks (teams stacked 4+ by top-1%)\n\n`;
  md += `| Team | Winner rate | Field rate | Lift |\n`;
  md += `|---|---:|---:|---:|\n`;
  for (const sp of w.stackProfile.slice(0, 8)) {
    md += `| ${sp.team} | ${pct(sp.winnerRate)} | ${pct(sp.fieldRate)} | ${fmt(sp.stackLift, 2)}x |\n`;
  }
  md += `\n`;

  // ─── Field ───
  md += `### Field Structure\n\n`;
  md += `- **Slate type:** ${f.slateType}\n`;
  md += `- **Ownership Gini:** ${fmt(f.ownershipGini, 3)}\n`;
  md += `- **Exact duplicate lineups:** ${f.exactDuplicateCount} (${fmt(f.avgDuplicatesPerLineup, 3)} avg per unique)\n`;
  md += `- **Chalk combo hit rate:** ${pct(f.chalkComboHitRate)} — ${f.chalkComboHitRate < 0.25 ? 'chalk combos were TRAPS' : f.chalkComboHitRate > 0.50 ? 'chalk combos were SMART' : 'mixed'}\n`;
  md += `- **Chalk anchor actual vs proj:** ${f.chalkAnchorActualVsProj >= 0 ? '+' : ''}${pct(f.chalkAnchorActualVsProj)}\n\n`;

  md += `**Top 5 owned players**\n\n`;
  md += `| Player | Team | Own% | Actual | Proj Err |\n`;
  md += `|---|---|---:|---:|---:|\n`;
  for (const p of f.top5OwnedPlayers) {
    md += `| ${p.name} | ${p.team} | ${pct(p.ownership)} | ${fmt(p.actual)} | ${p.projectionError >= 0 ? '+' : ''}${fmt(p.projectionError)} |\n`;
  }
  md += `\n`;

  if (f.fieldStackDistribution.length > 0) {
    md += `**Top field stacks (4+ players)**\n\n`;
    md += `| Team | Field rate |\n|---|---:|\n`;
    for (const e of f.fieldStackDistribution.slice(0, 8)) {
      md += `| ${e.team} | ${pct(e.fraction)} |\n`;
    }
    md += `\n`;
  }

  // ─── Pros ───
  if (pro && pro.topPros.length > 0) {
    md += `### Pro Portfolios (auto-detected, ≥${pro.minEntriesThreshold} entries)\n\n`;
    md += `**${pro.prosDetected} pros detected.** Field baselines: avgOwn=${pct(pro.fieldAvgs.avgOwnership)}, avgVar=${fmt(pro.fieldAvgs.avgVariance)}, maxExp=${pct(pro.fieldAvgs.maxExposure)}\n\n`;
    md += `| Pro | Entries | Top1% | Top5% | Best Rank | AvgOwn | AvgVar | MaxExp | AvgOverlap | Stacks | BringBack |\n`;
    md += `|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n`;
    for (const p of pro.topPros.slice(0, 10)) {
      md += `| ${p.username} | ${p.entries} | ${pct(p.top1Rate, 2)} | ${pct(p.top5Rate, 1)} | ${p.bestRank} | ${pct(p.avgOwnership)} | ${fmt(p.avgVariance)} | ${pct(p.maxExposure)} | ${fmt(p.avgPairwiseOverlap, 2)} | ${p.uniqueStackTeams} | ${pct(p.bringBackRate)} |\n`;
    }
    md += `\n`;

    // Show top pro's hitting entries
    const topPro = pro.topPros[0];
    if (topPro && topPro.hittingEntries.length > 0) {
      md += `#### ${topPro.username}'s top-1% entries\n\n`;
      md += `| Rank | Actual | Proj | Own% | Var | Stack | Depth | Anchor |\n`;
      md += `|---:|---:|---:|---:|---:|---|---:|---|\n`;
      for (const h of topPro.hittingEntries.slice(0, 5)) {
        md += `| ${h.rank} | ${fmt(h.actual)} | ${fmt(h.projection)} | ${pct(h.ownership)} | ${fmt(h.variance)} | ${h.stackTeam} | ${h.stackDepth} | ${h.anchor} |\n`;
      }
      md += `\n`;
    }
  }

  // ─── Pool Gap ───
  if (pg) {
    md += `### Pool Gap Analysis\n\n`;
    md += `- **Pool size:** ${pg.poolSize.toLocaleString()} (unique: ${pg.poolUniqueLineups.toLocaleString()}, unique players: ${pg.poolUniquePlayers})\n`;
    md += `- **Pool best actual:** ${fmt(pg.poolBestActual)} vs contest best ${fmt(pg.contestBestActual)} (gap: ${fmt(pg.ceilingGap)})\n`;
    md += `- **Top-1% capture rate:** ${pg.top1LineupsInPool}/${pg.top1LineupsTotal} = ${pct(pg.poolCaptureRate)}\n`;
    md += `- **Pool avg stack depth:** ${fmt(pg.poolAvgStackDepth, 2)}\n\n`;

    if (pg.missingAlphaPlayers.some(a => !a.inPool || a.poolExposure < 0.10)) {
      md += `**Missing alpha players**\n\n`;
      md += `| Player | Own% | Actual | Lift | In Pool? | Pool Exp |\n|---|---:|---:|---:|:-:|---:|\n`;
      for (const a of pg.missingAlphaPlayers.filter(x => !x.inPool || x.poolExposure < 0.15).slice(0, 8)) {
        md += `| ${a.name} | ${pct(a.ownership)} | ${fmt(a.actual)} | ${fmt(a.winnerLift, 2)}x | ${a.inPool ? 'yes' : '**NO**'} | ${pct(a.poolExposure)} |\n`;
      }
      md += `\n`;
    }

    if (pg.missingStacks.length > 0) {
      md += `**Missing stacks**\n\n`;
      md += `| Team | Winner rate | Pool rate | Gap |\n|---|---:|---:|---:|\n`;
      for (const ms of pg.missingStacks.slice(0, 6)) {
        md += `| ${ms.team} | ${pct(ms.winnerStackRate)} | ${pct(ms.poolStackRate)} | **${pct(ms.stackGap)}** |\n`;
      }
      md += `\n`;
    }

    if (pg.recommendations.length > 0) {
      md += `**Recommendations**\n\n`;
      for (const r of pg.recommendations) {
        md += `- **${r.setting}**: ${r.rationale}\n  _Expected impact:_ ${r.expectedImpact}\n`;
      }
      md += `\n`;
    }
  }

  return md;
}

// ============================================================
// CROSS-SLATE MARKDOWN
// ============================================================

function renderCrossSlateMarkdown(cs: CrossSlateReport): string {
  const pct = (v: number, digits = 1) => `${(v * 100).toFixed(digits)}%`;
  const fmt = (v: number, digits = 1) => v.toFixed(digits);

  let md = `# Calibration Report — Cross-Slate Patterns (${cs.slatesAnalyzed} slates)\n\n`;

  md += `## Winner Patterns\n\n`;
  md += `| Metric | Winner avg | Field avg | Delta | Consistency | Research |\n`;
  md += `|---|---:|---:|---:|---:|---|\n`;
  for (const p of cs.winnerPatterns) {
    md += `| ${p.metric} | ${fmt(p.winnerAvg, 3)} | ${fmt(p.fieldAvg, 3)} | ${p.delta >= 0 ? '+' : ''}${fmt(p.delta, 3)} | ${pct(p.consistency)} | ${p.researchBasis || ''} |\n`;
  }
  md += `\n`;

  if (cs.proGaps.length > 0) {
    md += `## Pro Gaps vs Field\n\n`;
    md += `| Metric | Pro avg | Field avg | Gap | Consistency | Research |\n`;
    md += `|---|---:|---:|---:|---:|---|\n`;
    for (const g of cs.proGaps) {
      md += `| ${g.metric} | ${fmt(g.proAvg, 3)} | ${fmt(g.fieldAvg, 3)} | ${g.gap >= 0 ? '+' : ''}${fmt(g.gap, 3)} | ${pct(g.consistency)} | ${g.researchBasis || ''} |\n`;
    }
    md += `\n`;
  }

  md += `## Alpha Player Profile\n\n`;
  md += `- Avg ownership: ${pct(cs.alphaPlayerProfile.avgOwnership)}\n`;
  md += `- Avg salary: $${Math.round(cs.alphaPlayerProfile.avgSalary).toLocaleString()}\n`;
  md += `- Avg projection error: ${cs.alphaPlayerProfile.avgProjectionError >= 0 ? '+' : ''}${fmt(cs.alphaPlayerProfile.avgProjectionError)}\n`;
  md += `- Avg ceiling realization: ${pct(cs.alphaPlayerProfile.avgCeilingRealization)} of p99\n\n`;

  if (cs.avgPoolCaptureRate !== null) {
    md += `## Pool Capture\n\n`;
    md += `- Average pool capture rate: **${pct(cs.avgPoolCaptureRate)}** of top-1% lineups\n\n`;
    if (cs.recurringPoolGaps.length > 0) {
      md += `| Gap type | Frequency | Avg impact |\n|---|---:|---:|\n`;
      for (const g of cs.recurringPoolGaps) {
        md += `| ${g.gapType} | ${pct(g.frequency)} | ${fmt(g.avgImpact, 3)} |\n`;
      }
      md += `\n`;
    }
  }

  if (cs.parameterRecommendations.length > 0) {
    md += `## Parameter Recommendations\n\n`;
    for (const r of cs.parameterRecommendations) {
      md += `- **${r.param}**: ${r.currentGuess} → **${r.recommendedValue}** — ${r.basis}\n`;
    }
    md += `\n`;
  }

  md += `## Slate Classification\n\n`;
  md += `| Slate | Entries | Games | Top-own | Outcome |\n|---|---:|---:|---:|---|\n`;
  for (const s of cs.slateClassification) {
    md += `| ${s.slate} | ${s.totalEntries.toLocaleString()} | ${s.numGames} | ${pct(s.topOwnership)} | ${s.outcome} |\n`;
  }
  md += `\n`;

  return md;
}

// ============================================================
// JSON-SAFE SERIALIZATION
// ============================================================

function toJsonSafe(s: SlateAnalysis): any {
  // Drop non-serializable fields (config already pure JSON)
  return {
    slate: s.slate,
    sport: s.sport,
    site: s.site,
    numGames: s.numGames,
    winnerAnatomy: s.winnerAnatomy,
    fieldAnalysis: s.fieldAnalysis,
    proAnalysis: s.proAnalysis,
    poolGap: s.poolGap,
  };
}
