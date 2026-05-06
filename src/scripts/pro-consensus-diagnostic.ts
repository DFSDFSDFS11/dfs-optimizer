/**
 * Pro Consensus Diagnostic — Phase 1.
 *
 * For 8 named pros across 18 slates:
 *   1. Extract per-slate portfolios (filter actuals.entries by entryName)
 *   2. Compute 9 portfolio metrics per (pro, slate)
 *   3. Compute pairwise inter-pro Pearson correlation across slates × metrics
 *   4. Build per-metric "agreement std" (tight agreement = small std across pros)
 *   5. Output: which metrics are universal pro signal, which are stylistic noise
 *
 * Determines achievable tracking threshold — bounded by inter-pro agreement.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import {
  parseCSVFile, buildPlayerPool, parseContestActuals, ContestActuals,
} from '../parser';
import { getContestConfig } from '../rules';

const DIR = 'C:/Users/colin/dfs opto';

const SLATES = [
  { slate: '4-6-26', proj: '4-6-26_projections.csv', actuals: 'dkactuals 4-6-26.csv' },
  { slate: '4-8-26', proj: '4-8-26projections.csv', actuals: '4-8-26actuals.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv', actuals: '4-12-26actuals.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv', actuals: '4-14-26actuals.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv', actuals: '4-15-26actuals.csv' },
  { slate: '4-17-26', proj: '4-17-26projections.csv', actuals: '4-17-26actuals.csv' },
  { slate: '4-18-26', proj: '4-18-26projections.csv', actuals: '4-18-26actuals.csv' },
  { slate: '4-19-26', proj: '4-19-26projections.csv', actuals: '4-19-26actuals.csv' },
  { slate: '4-20-26', proj: '4-20-26projections.csv', actuals: '4-20-26actuals.csv' },
  { slate: '4-21-26', proj: '4-21-26projections.csv', actuals: '4-21-26actuals.csv' },
  { slate: '4-22-26', proj: '4-22-26projections.csv', actuals: '4-22-26actuals.csv' },
  { slate: '4-23-26', proj: '4-23-26projections.csv', actuals: '4-23-26actuals.csv' },
  { slate: '4-24-26', proj: '4-24-26projections.csv', actuals: '4-24-26actuals.csv' },
  { slate: '4-25-26', proj: '4-25-26projections.csv', actuals: '4-25-26actuals.csv' },
  { slate: '4-25-26-early', proj: '4-25-26projectionsearly.csv', actuals: '4-25-26actualsearly.csv' },
  { slate: '4-26-26', proj: '4-26-26projections.csv', actuals: '4-26-26actuals.csv' },
  { slate: '4-27-26', proj: '4-27-26projections.csv', actuals: '4-27-26actuals.csv' },
  { slate: '4-28-26', proj: '4-28-26projections.csv', actuals: '4-28-26actuals.csv' },
];

const PROS = [
  { label: 'nerdytenor', tokens: ['nerdytenor'] },
  { label: 'zroth', tokens: ['zroth', 'zroth2'] },
  { label: 'youdacao', tokens: ['youdacao'] },
  { label: 'shipmymoney', tokens: ['shipmymoney'] },
  { label: 'shaidyadvice', tokens: ['shaidyadvice'] },
  { label: 'bgreseth', tokens: ['bgreseth'] },
  { label: 'bheals', tokens: ['bheals'] },
  { label: 'needlunchmoney', tokens: ['needlunchmoney'] },
];

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function mean(a: number[]): number { if (!a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; }
function stddev(a: number[]): number { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); }
function pearson(xs: number[], ys: number[]): number {
  const n = xs.length; if (n < 2) return 0;
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; num += dx * dy; dx2 += dx * dx; dy2 += dy * dy; }
  const den = Math.sqrt(dx2 * dy2);
  return den === 0 ? 0 : num / den;
}

interface PortfolioMetrics {
  meanOwn: number; meanProj: number; meanCeiling: number;
  ownStdWithinLineup: number;
  meanPairwiseOverlap: number; maxPairwiseOverlap: number;
  nonFourStackPct: number; uniqueTeams: number; maxTeamExposure: number;
}
const METRIC_KEYS = ['meanOwn', 'meanProj', 'meanCeiling', 'ownStdWithinLineup', 'meanPairwiseOverlap', 'maxPairwiseOverlap', 'nonFourStackPct', 'uniqueTeams', 'maxTeamExposure'] as const;

function computeMetrics(lineups: Player[][]): PortfolioMetrics {
  if (!lineups.length) return { meanOwn: 0, meanProj: 0, meanCeiling: 0, ownStdWithinLineup: 0, meanPairwiseOverlap: 0, maxPairwiseOverlap: 0, nonFourStackPct: 0, uniqueTeams: 0, maxTeamExposure: 0 };
  const luOwns: number[] = [], luProjs: number[] = [], luCeils: number[] = [], luOwnStds: number[] = [];
  let nonFour = 0;
  const teamExp = new Map<string, number>();
  const allStackTeams = new Set<string>();
  const pidSets: Set<string>[] = [];
  for (const players of lineups) {
    const owns = players.map(p => p.ownership || 0);
    luOwns.push(mean(owns));
    luProjs.push(players.reduce((s, p) => s + (p.projection || 0), 0));
    luCeils.push(players.reduce((s, p) => s + ((p as any).ceiling || (p.projection || 0) * 1.4), 0));
    luOwnStds.push(stddev(owns));
    const counts = new Map<string, number>();
    for (const p of players) if (!p.positions?.includes('P')) counts.set(p.team, (counts.get(p.team) || 0) + 1);
    let maxCount = 0, maxTeam: string | null = null;
    for (const [t, c] of counts) { if (c > maxCount) { maxCount = c; maxTeam = t; } if (c >= 4) allStackTeams.add(t); }
    if (maxCount < 4) nonFour++;
    if (maxTeam && maxCount >= 4) teamExp.set(maxTeam, (teamExp.get(maxTeam) || 0) + 1);
    pidSets.push(new Set(players.map(p => p.id)));
  }
  let maxOvl = 0, sumOvl = 0, pairs = 0;
  for (let i = 0; i < pidSets.length; i++) for (let j = i + 1; j < pidSets.length; j++) {
    let o = 0; for (const id of pidSets[i]) if (pidSets[j].has(id)) o++;
    if (o > maxOvl) maxOvl = o;
    sumOvl += o; pairs++;
  }
  return {
    meanOwn: mean(luOwns), meanProj: mean(luProjs), meanCeiling: mean(luCeils),
    ownStdWithinLineup: mean(luOwnStds),
    meanPairwiseOverlap: pairs > 0 ? sumOvl / pairs : 0,
    maxPairwiseOverlap: maxOvl,
    nonFourStackPct: nonFour / lineups.length * 100,
    uniqueTeams: allStackTeams.size,
    maxTeamExposure: teamExp.size > 0 ? Math.max(...teamExp.values()) / lineups.length * 100 : 0,
  };
}

function extractPro(actuals: ContestActuals, nameMap: Map<string, Player>, tokens: string[]): Player[][] {
  const out: Player[][] = [];
  for (const e of actuals.entries) {
    const en = (e.entryName || '').toLowerCase();
    if (!tokens.some(t => en.includes(t))) continue;
    const pls: Player[] = []; let ok = true;
    for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
    if (ok) out.push(pls);
  }
  return out;
}

async function main() {
  console.log('================================================================');
  console.log('PRO CONSENSUS DIAGNOSTIC — Phase 1');
  console.log('  ' + PROS.length + ' pros × ' + SLATES.length + ' slates');
  console.log('================================================================\n');

  // Load each slate's actuals + projections, extract pros
  const slateProMetrics: Map<string, Map<string, PortfolioMetrics>> = new Map(); // slate -> pro -> metrics
  const proSlateCount: Map<string, number> = new Map();
  const proLineupCount: Map<string, number[]> = new Map();
  for (const p of PROS) { proSlateCount.set(p.label, 0); proLineupCount.set(p.label, []); }

  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj), actualsPath = path.join(DIR, s.actuals);
    if (!fs.existsSync(projPath) || !fs.existsSync(actualsPath)) {
      console.log('  ' + s.slate + ': MISSING'); continue;
    }
    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);
    const nameMap = new Map<string, Player>();
    for (const p of pool.players) nameMap.set(norm(p.name), p);

    const proMetricsForSlate = new Map<string, PortfolioMetrics>();
    const counts: string[] = [];
    for (const p of PROS) {
      const lineups = extractPro(actuals, nameMap, p.tokens);
      counts.push(p.label + '=' + lineups.length);
      if (lineups.length >= 30) {
        proMetricsForSlate.set(p.label, computeMetrics(lineups));
        proSlateCount.set(p.label, proSlateCount.get(p.label)! + 1);
        proLineupCount.get(p.label)!.push(lineups.length);
      }
    }
    slateProMetrics.set(s.slate, proMetricsForSlate);
    console.log('  ' + s.slate + ': ' + counts.join(' '));
  }

  console.log('\n=== Pro coverage summary ===');
  for (const p of PROS) {
    const slatesCovered = proSlateCount.get(p.label) || 0;
    const lineupCounts = proLineupCount.get(p.label) || [];
    const avgLineups = lineupCounts.length > 0 ? mean(lineupCounts).toFixed(0) : '0';
    console.log('  ' + p.label.padEnd(18) + ' covers ' + slatesCovered + '/' + SLATES.length + ' slates (avg ' + avgLineups + ' lineups/slate)');
  }

  // Filter to pros with sufficient coverage
  const COVERAGE_MIN = 8;
  const validPros = PROS.filter(p => (proSlateCount.get(p.label) || 0) >= COVERAGE_MIN);
  console.log('\nPros with ≥' + COVERAGE_MIN + ' slates: ' + validPros.map(p => p.label).join(', '));

  // PAIRWISE INTER-PRO TRACKING
  console.log('\n================================================================');
  console.log('PAIRWISE INTER-PRO TRACKING (composite |r| across 9 metrics)');
  console.log('================================================================\n');

  const pairwiseR: Map<string, number> = new Map();
  for (let i = 0; i < validPros.length; i++) {
    for (let j = i + 1; j < validPros.length; j++) {
      const a = validPros[i].label, b = validPros[j].label;
      // Find slates where BOTH have data
      const commonSlates = SLATES.map(s => s.slate).filter(sl => {
        const m = slateProMetrics.get(sl);
        return m && m.has(a) && m.has(b);
      });
      if (commonSlates.length < 5) { pairwiseR.set(a + ' x ' + b, NaN); continue; }
      const rs: number[] = [];
      for (const k of METRIC_KEYS) {
        const xs = commonSlates.map(sl => (slateProMetrics.get(sl)!.get(a)! as any)[k]);
        const ys = commonSlates.map(sl => (slateProMetrics.get(sl)!.get(b)! as any)[k]);
        rs.push(pearson(xs, ys));
      }
      const comp = mean(rs.map(r => Math.abs(r)));
      pairwiseR.set(a + ' x ' + b, comp);
    }
  }

  // Print pairwise matrix
  console.log('Composite |r| matrix:');
  const labelW = 16;
  let header = ' '.repeat(labelW) + ' | ';
  for (const p of validPros) header += p.label.slice(0, 10).padStart(11);
  console.log(header);
  for (const a of validPros) {
    let row = a.label.padEnd(labelW) + ' | ';
    for (const b of validPros) {
      if (a.label === b.label) { row += '   1.000  '; continue; }
      const key = a.label < b.label ? a.label + ' x ' + b.label : b.label + ' x ' + a.label;
      const v = pairwiseR.get(key);
      row += (v === undefined || isNaN(v) ? '    -    ' : v.toFixed(3).padStart(9)) + '  ';
    }
    console.log(row);
  }

  // Average inter-pro tracking (excluding diagonal)
  const allR = [...pairwiseR.values()].filter(v => !isNaN(v));
  if (allR.length > 0) {
    console.log('\nAverage pairwise inter-pro tracking: ' + mean(allR).toFixed(3));
    console.log('  min=' + Math.min(...allR).toFixed(3) + '  max=' + Math.max(...allR).toFixed(3));
    console.log('  → realistic tracking threshold for candidate configs is bounded by this');
  }

  // PER-METRIC AGREEMENT: how tightly do pros agree on each metric per slate?
  console.log('\n================================================================');
  console.log('PER-METRIC PRO AGREEMENT (across pros, averaged across slates)');
  console.log('================================================================\n');
  console.log('Metric                      | pro mean | pro std | CV (std/|mean|) | tight agreement?');
  for (const k of METRIC_KEYS) {
    const slateStats: { mean: number; std: number }[] = [];
    for (const sl of SLATES.map(s => s.slate)) {
      const m = slateProMetrics.get(sl); if (!m) continue;
      const vals: number[] = [];
      for (const p of validPros) {
        const pm = m.get(p.label); if (pm) vals.push((pm as any)[k]);
      }
      if (vals.length >= 3) slateStats.push({ mean: mean(vals), std: stddev(vals) });
    }
    if (slateStats.length === 0) continue;
    const avgMean = mean(slateStats.map(s => s.mean));
    const avgStd = mean(slateStats.map(s => s.std));
    const cv = Math.abs(avgMean) > 0 ? avgStd / Math.abs(avgMean) : NaN;
    const tight = cv < 0.10 ? '✅ TIGHT' : cv < 0.20 ? '🟡 MEDIUM' : '❌ LOOSE';
    console.log('  ' + k.padEnd(28) + '| ' + avgMean.toFixed(2).padStart(7) + '  | ' + avgStd.toFixed(2).padStart(6) + '  | ' + (isNaN(cv) ? 'n/a'.padStart(11) : cv.toFixed(3).padStart(11)) + '       | ' + tight);
  }

  // Save consensus signature for later use
  const consensus: any = { metrics: {}, pros: validPros.map(p => p.label) };
  for (const k of METRIC_KEYS) {
    const slateConsensus: { slate: string; mean: number; std: number }[] = [];
    for (const sl of SLATES.map(s => s.slate)) {
      const m = slateProMetrics.get(sl); if (!m) continue;
      const vals: number[] = [];
      for (const p of validPros) {
        const pm = m.get(p.label); if (pm) vals.push((pm as any)[k]);
      }
      if (vals.length >= 3) slateConsensus.push({ slate: sl, mean: mean(vals), std: stddev(vals) });
    }
    consensus.metrics[k] = slateConsensus;
  }
  fs.writeFileSync(path.join(DIR, 'pro_consensus_signature.json'), JSON.stringify(consensus, null, 0));
  console.log('\nConsensus signature saved to pro_consensus_signature.json');
}

main().catch(e => { console.error(e); process.exit(1); });
