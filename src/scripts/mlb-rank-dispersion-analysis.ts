/**
 * Rank-dispersion analysis: which configs spread their 150 lineups across
 * the finishing-rank distribution vs clumping all entries at similar ranks?
 *
 * For each top config (by 15-slate full ROI), re-run on all 15 slates and
 * compute per-lineup ranks within the actual field. Report:
 *   - rank IQR / field size (fraction of field middle-50% spans)
 *   - rank std / field size
 *   - % of portfolio in top-25%, mid-50%, bottom-25% of field
 *
 * Combined "smooth winner" score: ROI rank × dispersion rank.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import {
  parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals,
} from '../parser';
import { getContestConfig } from '../rules';
import { productionSelect } from '../selection/production-selector';
import { precomputeComboFrequencies } from '../selection/combo-leverage';

const DIR = 'C:/Users/colin/dfs opto';
const PRIOR_JSON = path.join(DIR, 'mlb_all_configs_15slate.json');
const OUT_MD = path.join(DIR, 'mlb_rank_dispersion.md');
const FEE = 20;
const N = 150;
const TOP_K = 200; // how many of the best ROI configs to evaluate

const SLATES = [
  { slate: '4-6-26',  proj: '4-6-26_projections.csv', actuals: 'dkactuals 4-6-26.csv', pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26',  proj: '4-8-26projections.csv',  actuals: '4-8-26actuals.csv',    pool: '4-8-26sspool.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv', actuals: '4-12-26actuals.csv',   pool: '4-12-26sspool.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv', actuals: '4-14-26actuals.csv',   pool: '4-14-26sspool.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv', actuals: '4-15-26actuals.csv',   pool: '4-15-26sspool.csv' },
  { slate: '4-17-26', proj: '4-17-26projections.csv', actuals: '4-17-26actuals.csv',   pool: '4-17-26sspool.csv' },
  { slate: '4-18-26', proj: '4-18-26projections.csv', actuals: '4-18-26actuals.csv',   pool: '4-18-26sspool.csv' },
  { slate: '4-19-26', proj: '4-19-26projections.csv', actuals: '4-19-26actuals.csv',   pool: '4-19-26sspool.csv' },
  { slate: '4-20-26', proj: '4-20-26projections.csv', actuals: '4-20-26actuals.csv',   pool: '4-20-26sspool.csv' },
  { slate: '4-21-26', proj: '4-21-26projections.csv', actuals: '4-21-26actuals.csv',   pool: '4-21-26sspool.csv' },
  { slate: '4-22-26', proj: '4-22-26projections.csv', actuals: '4-22-26actuals.csv',   pool: '4-22-26sspool.csv' },
  { slate: '4-23-26', proj: '4-23-26projections.csv', actuals: '4-23-26actuals.csv',   pool: '4-23-26sspool.csv' },
  { slate: '4-24-26', proj: '4-24-26projections.csv', actuals: '4-24-26actuals.csv',   pool: '4-24-26sspool.csv' },
  { slate: '4-25-26', proj: '4-25-26projections.csv', actuals: '4-25-26actuals.csv',   pool: '4-25-26sspool.csv' },
  { slate: '4-25-26-early', proj: '4-25-26projectionsearly.csv', actuals: '4-25-26actualsearly.csv', pool: '4-25-26sspoolearly.csv' },
];

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function scoreLineup(lu: Lineup, actuals: ContestActuals, actualByHash: Map<string, number>): number | null {
  const h = lu.players.map(p => p.id).sort().join('|'); const fa = actualByHash.get(h);
  if (fa !== undefined) return fa;
  let t = 0; for (const p of lu.players) { const r = actuals.playerActualsByName.get(norm(p.name)); if (!r) return null; t += r.fpts; }
  return t;
}
function rankOf(actual: number, sortedDesc: number[]): number {
  let lo = 0, hi = sortedDesc.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (sortedDesc[m] >= actual) lo = m + 1; else hi = m; }
  return Math.max(1, lo);
}

interface SlateData {
  slate: string;
  candidates: Lineup[];
  players: Player[];
  comboFreq: Map<string, number>;
  comboFreq1?: Map<string, number>;
  comboFreq2?: Map<string, number>;
  comboFreq4?: Map<string, number>;
  comboFreq5?: Map<string, number>;
  actuals: ContestActuals;
  actualByHash: Map<string, number>;
  sorted: number[];
  F: number;
}

async function loadSlate(s: typeof SLATES[0]): Promise<SlateData | null> {
  const projPath = path.join(DIR, s.proj); const actualsPath = path.join(DIR, s.actuals); const poolPath = path.join(DIR, s.pool);
  if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) return null;
  const pr = parseCSVFile(projPath, 'mlb', true);
  const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
  const pool = buildPlayerPool(pr.players, pr.detectedContestType);
  const actuals = parseContestActuals(actualsPath, config);
  const idMap = new Map<string, Player>(); const nameMap = new Map<string, Player>();
  for (const p of pool.players) { idMap.set(p.id, p); nameMap.set(norm(p.name), p); }
  const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
  const F = actuals.entries.length;
  const sorted = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
  const actualByHash = new Map<string, number>();
  for (const e of actuals.entries) {
    const pls: Player[] = []; let ok = true;
    for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
    if (!ok) continue;
    actualByHash.set(pls.map(p => p.id).sort().join('|'), e.actualPoints);
  }
  const comboFreq = precomputeComboFrequencies(loaded.lineups, 3);
  return { slate: s.slate, candidates: loaded.lineups, players: pool.players, comboFreq, actuals, actualByHash, sorted, F };
}

const getCombo = (sd: SlateData, power?: number) => {
  if (power === 1) return sd.comboFreq1 ?? sd.comboFreq;
  if (power === 2) return sd.comboFreq2 ?? sd.comboFreq;
  if (power === 4) return sd.comboFreq4 ?? sd.comboFreq;
  if (power === 5) return sd.comboFreq5 ?? sd.comboFreq;
  return sd.comboFreq;
};

function buildV1Cfg(phase: string, cfg: any, sd: SlateData): Parameters<typeof productionSelect>[2] | null {
  const base: any = { N, comboFreq: sd.comboFreq };
  switch (phase) {
    case 'P1': return { ...base, lambda: 0.20, maxOverlap: 7, extremeCornerCap: true,
      binAllocation: { chalk: cfg.alloc[0], core: cfg.alloc[1], value: cfg.alloc[2], contra: cfg.alloc[3], deep: cfg.alloc[4] } };
    case 'P2': return { ...base, lambda: cfg.lam, maxOverlap: cfg.gam, teamCapPct: cfg.tc, projectionFloorPct: cfg.fl,
      extremeCornerCap: cfg.corner,
      binAllocation: { chalk: cfg.alloc[0], core: cfg.alloc[1], value: cfg.alloc[2], contra: cfg.alloc[3], deep: cfg.alloc[4] } };
    case 'P3': return { ...base, lambda: 0.20, maxOverlap: 7, extremeCornerCap: true,
      extremeCornerQ5Q5Pct: cfg.q5, extremeCornerQ1Q1Pct: cfg.q1 };
    case 'P4': return { ...base, lambda: 0.20, maxOverlap: 7, extremeCornerCap: true,
      ownDropPP: cfg.od, ownershipCeilingBuffer: cfg.buf, useOwnershipCeiling: true };
    case 'P5': return { ...base,
      lambda: cfg.lam ?? 0.20, maxOverlap: cfg.gam ?? 7, teamCapPct: cfg.tc ?? 0.10,
      extremeCornerCap: cfg.corner ?? true, projectionFloorPct: cfg.fl ?? 0,
      binAllocation: { chalk: cfg.alloc[0], core: cfg.alloc[1], value: cfg.alloc[2], contra: cfg.alloc[3], deep: cfg.alloc[4] } };
    case 'P6': return { ...base, lambda: 0.20, maxOverlap: 7, extremeCornerCap: true,
      binAllocation: { chalk: cfg.alloc[0], core: cfg.alloc[1], value: cfg.alloc[2], contra: cfg.alloc[3], deep: cfg.alloc[4] } };
    case 'P7': return { ...base, lambda: 0.20, maxOverlap: cfg.gam, extremeCornerCap: cfg.corner, projectionFloorPct: cfg.fl };
    case 'P8': return { ...base, lambda: cfg.lam, maxOverlap: 7, teamCapPct: cfg.tc, extremeCornerCap: true };
    case 'P9': return { ...base, lambda: cfg.lam, maxOverlap: cfg.gam, teamCapPct: cfg.tc, projectionFloorPct: cfg.fl,
      extremeCornerCap: cfg.corner, extremeCornerQ5Q5Pct: cfg.q5, extremeCornerQ1Q1Pct: cfg.q1,
      binAllocation: { chalk: cfg.alloc[0], core: cfg.alloc[1], value: cfg.alloc[2], contra: cfg.alloc[3], deep: cfg.alloc[4] } };
    default: return null;
  }
}

function buildV2Cfg(phase: string, cfg: any, sd: SlateData): Parameters<typeof productionSelect>[2] | null {
  const alloc = cfg.alloc;
  if (!alloc || alloc.length !== 5) return null;
  const bins = { chalk: alloc[0], core: alloc[1], value: alloc[2], contra: alloc[3], deep: alloc[4] };
  switch (phase) {
    case 'A': return { N, lambda: cfg.lam, comboFreq: getCombo(sd, cfg.power), maxOverlap: 6, teamCapPct: 0.20,
      extremeCornerCap: true, projectionFloorPct: 0, binAllocation: bins };
    case 'B': return { N, lambda: cfg.lam, comboFreq: sd.comboFreq, maxOverlap: cfg.gam, teamCapPct: cfg.tc,
      extremeCornerCap: cfg.corner, projectionFloorPct: 0, binAllocation: bins };
    case 'C': return { N, lambda: cfg.lam, comboFreq: sd.comboFreq, maxOverlap: 6, teamCapPct: cfg.tc,
      extremeCornerCap: cfg.corner, projectionFloorPct: cfg.fl, binAllocation: bins };
    case 'D': return { N, lambda: cfg.lam, comboFreq: sd.comboFreq, maxOverlap: 6, teamCapPct: 0.20,
      extremeCornerCap: true, extremeCornerQ5Q5Pct: cfg.q5, extremeCornerQ1Q1Pct: cfg.q1,
      projectionFloorPct: 0, binAllocation: bins };
    case 'E': return { N, lambda: cfg.lam, comboFreq: sd.comboFreq, maxOverlap: 6, teamCapPct: 0.20,
      minPrimaryStack: cfg.mps, maxExposure: cfg.me, maxExposurePitcher: cfg.mep,
      extremeCornerCap: true, projectionFloorPct: 0, binAllocation: bins };
    case 'F': return { N, lambda: cfg.lam, comboFreq: sd.comboFreq, maxOverlap: 6, teamCapPct: 0.20,
      ownDropPP: cfg.od, ownershipCeilingBuffer: cfg.buf, useOwnershipCeiling: true,
      extremeCornerCap: true, projectionFloorPct: 0, binAllocation: bins };
    case 'G': return { N, lambda: cfg.lam, comboFreq: getCombo(sd, cfg.power), maxOverlap: cfg.gam, teamCapPct: cfg.tc,
      projectionFloorPct: cfg.fl, minPrimaryStack: cfg.mps,
      maxExposure: cfg.me, maxExposurePitcher: cfg.mep,
      extremeCornerCap: cfg.corner, extremeCornerQ5Q5Pct: cfg.q5, extremeCornerQ1Q1Pct: cfg.q1,
      useOwnershipCeiling: cfg.useOC, ownDropPP: cfg.od, ownershipCeilingBuffer: cfg.buf,
      binAllocation: bins };
    default: return null;
  }
}

interface DispResult {
  source: string; id: string; phase: string; cfg: any; full15: number;
  // Aggregated dispersion metrics across all slates
  meanIqrFrac: number;       // mean(rank IQR / fieldSize)
  meanStdFrac: number;       // mean(rank std / fieldSize)
  meanPctTop25: number;      // mean % of portfolio in top-25% of field
  meanPctMid50: number;      // mean % in middle 50%
  meanPctBot25: number;      // mean % in bottom 25%
  meanRankFrac: number;      // mean(median rank / fieldSize) — where the portfolio centers
  totalScored: number;
  perSlateIQR: { slate: string; iqrFrac: number }[];
}

async function main() {
  console.log('==================================================================');
  console.log('Rank-dispersion analysis on top 200 configs by 15-slate full ROI');
  console.log('==================================================================\n');

  console.log('Loading prior 15-slate results...');
  const prior = JSON.parse(fs.readFileSync(PRIOR_JSON, 'utf8'));
  console.log(`  ${prior.length} configs loaded\n`);

  const top200 = [...prior].sort((a, b) => b.full15 - a.full15).slice(0, TOP_K);
  console.log(`Top ${TOP_K} configs selected for dispersion analysis`);
  console.log(`  full15 range: $${top200[top200.length-1].full15.toFixed(0)} to $${top200[0].full15.toFixed(0)}\n`);

  console.log('Loading slates (15)...');
  const slates: SlateData[] = [];
  for (const s of SLATES) {
    try { const sd = await loadSlate(s); if (sd) slates.push(sd); }
    catch (e: any) { console.log(`  skip ${s.slate}: ${e.message}`); }
  }
  console.log(`${slates.length} slates loaded.\n`);

  console.log('Computing rank dispersion for each top config × slate...');
  const dispResults: DispResult[] = [];
  let done = 0;
  const t_start = Date.now();

  for (const cfg of top200) {
    let runCfg = null;
    if (cfg.source === 'V1') runCfg = (sd: SlateData) => buildV1Cfg(cfg.phase, cfg.cfg, sd);
    else if (cfg.source === 'V2') runCfg = (sd: SlateData) => buildV2Cfg(cfg.phase, cfg.cfg, sd);
    if (!runCfg) { done++; continue; }

    const perSlateIQR: { slate: string; iqrFrac: number }[] = [];
    let sumIqrFrac = 0, sumStdFrac = 0, sumTop25 = 0, sumMid50 = 0, sumBot25 = 0, sumMedFrac = 0;
    let nSlates = 0, totalScored = 0;

    for (const sd of slates) {
      const built = runCfg(sd);
      if (!built) continue;
      try {
        const result = productionSelect(sd.candidates, sd.players, built);
        const ranks: number[] = [];
        for (const lu of result.portfolio) {
          const a = scoreLineup(lu, sd.actuals, sd.actualByHash);
          if (a === null) continue;
          ranks.push(rankOf(a, sd.sorted));
        }
        if (ranks.length < 30) continue;
        ranks.sort((a, b) => a - b);
        const F = sd.F;
        const median = ranks[Math.floor(ranks.length / 2)];
        const q1 = ranks[Math.floor(ranks.length * 0.25)];
        const q3 = ranks[Math.floor(ranks.length * 0.75)];
        const iqr = q3 - q1;
        const mean = ranks.reduce((a, b) => a + b, 0) / ranks.length;
        const variance = ranks.reduce((a, r) => a + (r - mean) ** 2, 0) / ranks.length;
        const std = Math.sqrt(variance);
        // Bin counts
        const top25Thresh = F * 0.25;
        const mid75Thresh = F * 0.75;
        let topCnt = 0, midCnt = 0, botCnt = 0;
        for (const r of ranks) {
          if (r <= top25Thresh) topCnt++;
          else if (r <= mid75Thresh) midCnt++;
          else botCnt++;
        }
        sumIqrFrac += iqr / F;
        sumStdFrac += std / F;
        sumTop25 += topCnt / ranks.length;
        sumMid50 += midCnt / ranks.length;
        sumBot25 += botCnt / ranks.length;
        sumMedFrac += median / F;
        nSlates++;
        totalScored += ranks.length;
        perSlateIQR.push({ slate: sd.slate, iqrFrac: iqr / F });
      } catch {}
    }

    if (nSlates > 0) {
      dispResults.push({
        source: cfg.source, id: cfg.id, phase: cfg.phase, cfg: cfg.cfg, full15: cfg.full15,
        meanIqrFrac: sumIqrFrac / nSlates, meanStdFrac: sumStdFrac / nSlates,
        meanPctTop25: sumTop25 / nSlates, meanPctMid50: sumMid50 / nSlates, meanPctBot25: sumBot25 / nSlates,
        meanRankFrac: sumMedFrac / nSlates, totalScored, perSlateIQR,
      });
    }
    done++;
    if (done % 25 === 0) {
      const elapsedMin = (Date.now() - t_start) / 60000;
      console.log(`  ${done}/${TOP_K} (${(done / TOP_K * 100).toFixed(1)}%) — ${elapsedMin.toFixed(1)} min`);
    }
  }

  console.log(`\n${dispResults.length} configs analyzed in ${((Date.now() - t_start) / 60000).toFixed(1)} min\n`);

  // ============ ANALYSIS ============

  const fees = 15 * 150 * 20;

  // 1. Top by full15 (ROI)
  const byROI = [...dispResults].sort((a, b) => b.full15 - a.full15);
  // 2. Top by IQR fraction (most spread)
  const byIQR = [...dispResults].sort((a, b) => b.meanIqrFrac - a.meanIqrFrac);
  // 3. Combined: rank-product of ROI rank × IQR rank
  const roiRank = new Map<string, number>();
  const iqrRank = new Map<string, number>();
  for (let i = 0; i < byROI.length; i++) roiRank.set(byROI[i].id, i + 1);
  for (let i = 0; i < byIQR.length; i++) iqrRank.set(byIQR[i].id, i + 1);
  const combined = dispResults.map(r => ({
    ...r, rRank: roiRank.get(r.id)!, iqrR: iqrRank.get(r.id)!,
    combined: roiRank.get(r.id)! + iqrRank.get(r.id)!,
  })).sort((a, b) => a.combined - b.combined);

  // ============ OUTPUT ============
  console.log('=== TOP 15 BY ROI ===\n');
  for (let i = 0; i < 15; i++) {
    const r = byROI[i];
    const roi = ((r.full15 / fees - 1) * 100).toFixed(1);
    console.log(`  ${(i+1).toString().padStart(2)} | ${r.source} ${r.phase} | ROI=${roi}% | IQR/F=${(r.meanIqrFrac*100).toFixed(1)}% | top25=${(r.meanPctTop25*100).toFixed(1)}% mid50=${(r.meanPctMid50*100).toFixed(1)}% bot25=${(r.meanPctBot25*100).toFixed(1)}% | medRank/F=${(r.meanRankFrac*100).toFixed(1)}% | ${r.id.slice(0, 50)}`);
  }

  console.log('\n=== TOP 15 BY DISPERSION (smoothest) ===\n');
  for (let i = 0; i < 15; i++) {
    const r = byIQR[i];
    const roi = ((r.full15 / fees - 1) * 100).toFixed(1);
    console.log(`  ${(i+1).toString().padStart(2)} | ${r.source} ${r.phase} | IQR/F=${(r.meanIqrFrac*100).toFixed(1)}% | ROI=${roi}% | top25=${(r.meanPctTop25*100).toFixed(1)}% mid50=${(r.meanPctMid50*100).toFixed(1)}% bot25=${(r.meanPctBot25*100).toFixed(1)}% | ${r.id.slice(0, 50)}`);
  }

  console.log('\n=== TOP 15 SMOOTH WINNERS (best ROI rank × IQR rank) ===\n');
  for (let i = 0; i < 15; i++) {
    const r = combined[i];
    const roi = ((r.full15 / fees - 1) * 100).toFixed(1);
    console.log(`  ${(i+1).toString().padStart(2)} | ${r.source} ${r.phase} | ROI=${roi}% (#${r.rRank}) | IQR/F=${(r.meanIqrFrac*100).toFixed(1)}% (#${r.iqrR}) | top25=${(r.meanPctTop25*100).toFixed(1)}% bot25=${(r.meanPctBot25*100).toFixed(1)}% | ${r.id.slice(0, 50)}`);
  }

  // Phoenix tracking
  const phoenix = dispResults.find(r =>
    r.source === 'V2' && r.cfg && r.cfg.lam !== undefined &&
    Math.abs(r.cfg.lam - 0.14) < 0.01 && r.cfg.gam === 6 &&
    r.cfg.tc !== undefined && Math.abs(r.cfg.tc - 0.22) < 0.01 &&
    r.cfg.corner === false && r.cfg.alloc &&
    Math.abs(r.cfg.alloc[2] - 0.85) < 0.02
  );
  if (phoenix) {
    console.log('\n=== Phoenix dispersion ===');
    console.log(`  ROI=${((phoenix.full15 / fees - 1) * 100).toFixed(1)}%`);
    console.log(`  IQR/F: ${(phoenix.meanIqrFrac * 100).toFixed(1)}% (rank #${iqrRank.get(phoenix.id)} of ${dispResults.length})`);
    console.log(`  Std/F: ${(phoenix.meanStdFrac * 100).toFixed(1)}%`);
    console.log(`  top25=${(phoenix.meanPctTop25 * 100).toFixed(1)}%  mid50=${(phoenix.meanPctMid50 * 100).toFixed(1)}%  bot25=${(phoenix.meanPctBot25 * 100).toFixed(1)}%`);
    console.log(`  median rank as % of field: ${(phoenix.meanRankFrac * 100).toFixed(1)}%`);
  }

  // Markdown report
  let md = `# MLB Rank Dispersion — Top 200 by ROI Re-Analyzed\n\n`;
  md += `Computes rank dispersion (how spread your 150 lineups are across the field's finishing ranks per slate). Higher dispersion = less clumping.\n\n`;
  md += `Metrics:\n`;
  md += `- **IQR/F**: Inter-quartile range of ranks / field size. Higher = lineups span more of the field.\n`;
  md += `- **top25 / mid50 / bot25**: Fraction of portfolio in top-25%, middle-50%, bottom-25% of field.\n`;
  md += `- **medRank/F**: Median rank as % of field — where portfolio centers.\n\n`;
  md += `## Top 15 by ROI (your existing winner list)\n\n`;
  md += `| Rank | ROI | IQR/F | top25 | mid50 | bot25 | medRank/F | id |\n|---:|---:|---:|---:|---:|---:|---:|---|\n`;
  for (let i = 0; i < 15; i++) {
    const r = byROI[i];
    const roi = ((r.full15 / fees - 1) * 100).toFixed(1);
    md += `| ${i+1} | ${roi}% | ${(r.meanIqrFrac*100).toFixed(1)}% | ${(r.meanPctTop25*100).toFixed(1)}% | ${(r.meanPctMid50*100).toFixed(1)}% | ${(r.meanPctBot25*100).toFixed(1)}% | ${(r.meanRankFrac*100).toFixed(1)}% | \`${r.id.slice(0, 50)}\` |\n`;
  }
  md += `\n## Top 15 by Dispersion (smoothest portfolios)\n\n`;
  md += `| Rank | IQR/F | ROI | top25 | mid50 | bot25 | id |\n|---:|---:|---:|---:|---:|---:|---|\n`;
  for (let i = 0; i < 15; i++) {
    const r = byIQR[i];
    const roi = ((r.full15 / fees - 1) * 100).toFixed(1);
    md += `| ${i+1} | ${(r.meanIqrFrac*100).toFixed(1)}% | ${roi}% | ${(r.meanPctTop25*100).toFixed(1)}% | ${(r.meanPctMid50*100).toFixed(1)}% | ${(r.meanPctBot25*100).toFixed(1)}% | \`${r.id.slice(0, 50)}\` |\n`;
  }
  md += `\n## Top 15 Smooth Winners (combined ROI × dispersion)\n\n`;
  md += `These have BOTH above-median ROI AND above-median dispersion — best candidates for "good ROI without clumping."\n\n`;
  md += `| Rank | ROI rank | IQR rank | ROI | IQR/F | id |\n|---:|---:|---:|---:|---:|---|\n`;
  for (let i = 0; i < 15; i++) {
    const r = combined[i];
    const roi = ((r.full15 / fees - 1) * 100).toFixed(1);
    md += `| ${i+1} | #${r.rRank} | #${r.iqrR} | ${roi}% | ${(r.meanIqrFrac*100).toFixed(1)}% | \`${r.id.slice(0, 50)}\` |\n`;
  }

  fs.writeFileSync(OUT_MD, md);
  console.log(`\nMD: ${OUT_MD}`);
}

main().catch(e => { console.error(e); process.exit(1); });
