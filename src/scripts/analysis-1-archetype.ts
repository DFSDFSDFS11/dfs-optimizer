/**
 * Analysis 1 — Player + Lineup + Portfolio archetype mining.
 *
 * Three nested levels:
 *   1. PLAYER level: classify each player (chalk-stud, leverage, value-tier, etc.)
 *   2. LINEUP level: classify each lineup by its composition (e.g., "5-chalk + 3-leverage")
 *   3. PORTFOLIO level: distribution of lineup archetypes across the 150 lineups
 *
 * For each pro and Hermes-A:
 *   - Player-level: % of player-slots in each archetype
 *   - Lineup-level: dominant lineup archetype per lineup, per-archetype lineup counts
 *   - Portfolio-level: shape of the lineup-archetype distribution (concentrated vs balanced)
 *
 * Output: gap tables at all three levels.
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
const N = 150;

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
  { slate: '4-26-26', proj: '4-26-26projections.csv', actuals: '4-26-26actuals.csv',   pool: '4-26-26sspool.csv' },
  { slate: '4-27-26', proj: '4-27-26projections.csv', actuals: '4-27-26actuals.csv',   pool: '4-27-26sspool.csv' },
  { slate: '4-28-26', proj: '4-28-26projections.csv', actuals: '4-28-26actuals.csv',   pool: '4-28-26sspool.csv' },
];

const PROS = [
  { label: 'nerdytenor', tokens: ['nerdytenor'] },
  { label: 'zroth', tokens: ['zroth', 'zroth2'] },
  { label: 'youdacao', tokens: ['youdacao'] },
  { label: 'shipmymoney', tokens: ['shipmymoney'] },
  { label: 'shaidyadvice', tokens: ['shaidyadvice'] },
  { label: 'bgreseth', tokens: ['bgreseth'] },
  { label: 'needlunchmoney', tokens: ['needlunchmoney'] },
];

const HERMES_A = {
  lambda: 0.58, gamma: 5, tc: 0.26, mps: 4, me: 0.21, mep: 0.41, corner: true,
  comboPower: 4, fl: 0.00,
  bins: { chalk: 0.50, core: 0.30, value: 0.20, contra: 0.00, deep: 0.00 },
};

const ARCHETYPES = ['chalk-stud', 'leverage', 'value-tier', 'low-own-pos', 'punt', 'trap', 'other'] as const;
type Archetype = typeof ARCHETYPES[number];

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function mean(a: number[]): number { if (!a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; }
function stddev(a: number[]): number { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); }
function entropy(probs: number[]): number {
  let h = 0;
  for (const p of probs) if (p > 0) h -= p * Math.log2(p);
  return h;
}

function classifyPlayer(p: Player, projQT: number[], ownQT: number[]): Archetype {
  const proj = p.projection || 0;
  const own = p.ownership || 0;
  const projQ = proj >= projQT[3] ? 5 : proj >= projQT[2] ? 4 : proj >= projQT[1] ? 3 : proj >= projQT[0] ? 2 : 1;
  const ownQ = own >= ownQT[3] ? 5 : own >= ownQT[2] ? 4 : own >= ownQT[1] ? 3 : own >= ownQT[0] ? 2 : 1;
  if (projQ === 5 && ownQ >= 4) return 'chalk-stud';
  if (projQ >= 4 && ownQ <= 2) return 'leverage';
  if (projQ >= 3 && projQ <= 4 && ownQ >= 3 && ownQ <= 4) return 'value-tier';
  if (projQ === 3 && ownQ === 1) return 'low-own-pos';
  if (projQ <= 2 && ownQ <= 2) return 'punt';
  if (projQ <= 2 && ownQ >= 4) return 'trap';
  return 'other';
}

interface LineupSig {
  counts: Record<Archetype, number>;          // count of each archetype in lineup
  dominantArch: Archetype;                    // most-common archetype in lineup
  diversity: number;                          // count of distinct archetypes used
  shape: string;                              // signature like "ch3_lev2_val2_oth3"
}

function classifyLineup(players: Player[], classifier: Map<string, Archetype>): LineupSig {
  const counts: Record<Archetype, number> = { 'chalk-stud': 0, 'leverage': 0, 'value-tier': 0, 'low-own-pos': 0, 'punt': 0, 'trap': 0, 'other': 0 };
  for (const p of players) counts[classifier.get(p.id) || 'other']++;
  let dominant: Archetype = 'other'; let maxC = 0;
  for (const a of ARCHETYPES) if (counts[a] > maxC) { maxC = counts[a]; dominant = a; }
  const diversity = Object.values(counts).filter(c => c > 0).length;
  // Compact shape: top archetypes only
  const shapeParts = ARCHETYPES.filter(a => counts[a] > 0).map(a => `${a.slice(0, 3)}${counts[a]}`);
  return { counts, dominantArch: dominant, diversity, shape: shapeParts.join('_') };
}

interface ArchetypeReport {
  // Player level (averaged across portfolio)
  playerMix: Record<Archetype, number>;
  // Lineup level (distribution of lineup-shapes / dominants)
  lineupDominantMix: Record<Archetype, number>;
  avgPerLineupCounts: Record<Archetype, number>;     // avg count of each archetype per lineup
  // Portfolio level
  uniqueLineupShapes: number;                          // how many distinct shapes
  topShapeFraction: number;                            // % of lineups using the most common shape
  shapeEntropy: number;                                // entropy of shape distribution
  avgDiversityPerLineup: number;                       // avg distinct-archetype count per lineup
}

function buildReport(lineups: Player[][], classifier: Map<string, Archetype>): ArchetypeReport {
  const playerCounts: Record<Archetype, number> = { 'chalk-stud': 0, 'leverage': 0, 'value-tier': 0, 'low-own-pos': 0, 'punt': 0, 'trap': 0, 'other': 0 };
  const lineupDomCounts: Record<Archetype, number> = { 'chalk-stud': 0, 'leverage': 0, 'value-tier': 0, 'low-own-pos': 0, 'punt': 0, 'trap': 0, 'other': 0 };
  const perLuArchCounts: Record<Archetype, number[]> = { 'chalk-stud': [], 'leverage': [], 'value-tier': [], 'low-own-pos': [], 'punt': [], 'trap': [], 'other': [] };
  const shapeCounts = new Map<string, number>();
  const diversities: number[] = [];
  let totalPlayers = 0;
  for (const lu of lineups) {
    const sig = classifyLineup(lu, classifier);
    for (const a of ARCHETYPES) { playerCounts[a] += sig.counts[a]; perLuArchCounts[a].push(sig.counts[a]); }
    totalPlayers += lu.length;
    lineupDomCounts[sig.dominantArch]++;
    shapeCounts.set(sig.shape, (shapeCounts.get(sig.shape) || 0) + 1);
    diversities.push(sig.diversity);
  }
  const playerMix: Record<Archetype, number> = {} as any;
  for (const a of ARCHETYPES) playerMix[a] = totalPlayers > 0 ? playerCounts[a] / totalPlayers : 0;
  const lineupDominantMix: Record<Archetype, number> = {} as any;
  for (const a of ARCHETYPES) lineupDominantMix[a] = lineups.length > 0 ? lineupDomCounts[a] / lineups.length : 0;
  const avgPerLineupCounts: Record<Archetype, number> = {} as any;
  for (const a of ARCHETYPES) avgPerLineupCounts[a] = mean(perLuArchCounts[a]);
  const sortedShapes = [...shapeCounts.entries()].sort((a, b) => b[1] - a[1]);
  const topShapeFraction = sortedShapes.length > 0 ? sortedShapes[0][1] / lineups.length : 0;
  const shapeProbs = [...shapeCounts.values()].map(c => c / lineups.length);
  return {
    playerMix, lineupDominantMix, avgPerLineupCounts,
    uniqueLineupShapes: shapeCounts.size, topShapeFraction,
    shapeEntropy: entropy(shapeProbs),
    avgDiversityPerLineup: mean(diversities),
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
  console.log('=== ANALYSIS 1: Archetype mining (Player + Lineup + Portfolio) ===\n');

  const proSlateReports: Map<string, ArchetypeReport[]> = new Map();
  for (const p of PROS) proSlateReports.set(p.label, []);
  const hermesSlateReports: ArchetypeReport[] = [];

  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj), actualsPath = path.join(DIR, s.actuals), poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) continue;
    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);
    const idMap = new Map<string, Player>(); const nameMap = new Map<string, Player>();
    for (const p of pool.players) { idMap.set(p.id, p); nameMap.set(norm(p.name), p); }
    const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });

    // Quintiles based on VIABLE players only (own > 0 AND proj > 0).
    // Otherwise the long tail of zero-projection players dominates the bins.
    const viable = pool.players.filter(p => (p.projection || 0) > 0 && (p.ownership || 0) > 0);
    const projs = viable.map(p => p.projection || 0).sort((a, b) => a - b);
    const owns = viable.map(p => p.ownership || 0).sort((a, b) => a - b);
    const projQT: number[] = [0.2, 0.4, 0.6, 0.8].map(q => projs[Math.floor(projs.length * q)]);
    const ownQT: number[] = [0.2, 0.4, 0.6, 0.8].map(q => owns[Math.floor(owns.length * q)]);

    const classifier = new Map<string, Archetype>();
    for (const p of pool.players) classifier.set(p.id, classifyPlayer(p, projQT, ownQT));

    for (const p of PROS) {
      const lus = extractPro(actuals, nameMap, p.tokens);
      if (lus.length >= 30) proSlateReports.get(p.label)!.push(buildReport(lus, classifier));
    }

    const comboFreq = precomputeComboFrequencies(loaded.lineups, HERMES_A.comboPower);
    const result = productionSelect(loaded.lineups, pool.players, {
      N, lambda: HERMES_A.lambda, comboFreq, maxOverlap: HERMES_A.gamma,
      teamCapPct: HERMES_A.tc, minPrimaryStack: HERMES_A.mps,
      maxExposure: HERMES_A.me, maxExposurePitcher: HERMES_A.mep,
      extremeCornerCap: HERMES_A.corner, projectionFloorPct: HERMES_A.fl,
      binAllocation: HERMES_A.bins,
    });
    hermesSlateReports.push(buildReport(result.portfolio.map(lu => lu.players), classifier));
  }

  // Aggregate
  function avgReports(reports: ArchetypeReport[]): ArchetypeReport {
    const playerMix: Record<Archetype, number> = {} as any;
    const lineupDominantMix: Record<Archetype, number> = {} as any;
    const avgPerLineupCounts: Record<Archetype, number> = {} as any;
    for (const a of ARCHETYPES) {
      playerMix[a] = mean(reports.map(r => r.playerMix[a]));
      lineupDominantMix[a] = mean(reports.map(r => r.lineupDominantMix[a]));
      avgPerLineupCounts[a] = mean(reports.map(r => r.avgPerLineupCounts[a]));
    }
    return {
      playerMix, lineupDominantMix, avgPerLineupCounts,
      uniqueLineupShapes: mean(reports.map(r => r.uniqueLineupShapes)),
      topShapeFraction: mean(reports.map(r => r.topShapeFraction)),
      shapeEntropy: mean(reports.map(r => r.shapeEntropy)),
      avgDiversityPerLineup: mean(reports.map(r => r.avgDiversityPerLineup)),
    };
  }

  // Pro consensus = avg-of-avg-of-pro-slate-reports
  const proAggs: ArchetypeReport[] = [];
  for (const p of PROS) {
    const reps = proSlateReports.get(p.label) || [];
    if (reps.length >= 8) proAggs.push(avgReports(reps));
  }
  const proConsensus = avgReports(proAggs);
  const hermesAgg = avgReports(hermesSlateReports);

  console.log('=== LEVEL 1: PLAYER MIX (% of player-slots in archetype) ===\n');
  console.log('archetype       | PRO_AVG  HERMES-A   gap');
  for (const a of ARCHETYPES) {
    const p = proConsensus.playerMix[a] * 100;
    const h = hermesAgg.playerMix[a] * 100;
    const dir = h - p > 0 ? 'OVER' : h - p < 0 ? 'UNDER' : 'eq';
    console.log('  ' + a.padEnd(15) + ' | ' + p.toFixed(1).padStart(6) + '%  ' + h.toFixed(1).padStart(6) + '%   ' + ((h - p > 0 ? '+' : '') + (h - p).toFixed(1)).padStart(5) + 'pp  ' + dir);
  }

  console.log('\n=== LEVEL 2: AVG COUNT PER LINEUP (out of 10 player slots) ===\n');
  console.log('archetype       | PRO_AVG  HERMES-A   gap');
  for (const a of ARCHETYPES) {
    const p = proConsensus.avgPerLineupCounts[a];
    const h = hermesAgg.avgPerLineupCounts[a];
    console.log('  ' + a.padEnd(15) + ' | ' + p.toFixed(2).padStart(6) + '   ' + h.toFixed(2).padStart(6) + '    ' + ((h - p > 0 ? '+' : '') + (h - p).toFixed(2)).padStart(6));
  }

  console.log('\n=== LEVEL 3: LINEUP DOMINANT-ARCHETYPE DISTRIBUTION ===\n');
  console.log('  (% of lineups whose most-common archetype is X)\n');
  console.log('archetype       | PRO_AVG  HERMES-A   gap');
  for (const a of ARCHETYPES) {
    const p = proConsensus.lineupDominantMix[a] * 100;
    const h = hermesAgg.lineupDominantMix[a] * 100;
    console.log('  ' + a.padEnd(15) + ' | ' + p.toFixed(1).padStart(6) + '%  ' + h.toFixed(1).padStart(6) + '%   ' + ((h - p > 0 ? '+' : '') + (h - p).toFixed(1)).padStart(5) + 'pp');
  }

  console.log('\n=== LEVEL 4: PORTFOLIO-LEVEL DIVERSITY ===\n');
  console.log('metric                              | PRO_AVG  HERMES-A   gap');
  console.log('  unique lineup shapes              | ' + proConsensus.uniqueLineupShapes.toFixed(1).padStart(6) + '   ' + hermesAgg.uniqueLineupShapes.toFixed(1).padStart(6) + '    ' + (hermesAgg.uniqueLineupShapes - proConsensus.uniqueLineupShapes).toFixed(1));
  console.log('  top-shape fraction (% of LUs)     | ' + (proConsensus.topShapeFraction * 100).toFixed(1).padStart(6) + '%  ' + (hermesAgg.topShapeFraction * 100).toFixed(1).padStart(6) + '%   ' + ((hermesAgg.topShapeFraction - proConsensus.topShapeFraction) * 100).toFixed(1) + 'pp');
  console.log('  shape entropy (bits, higher=more spread) | ' + proConsensus.shapeEntropy.toFixed(2).padStart(6) + '   ' + hermesAgg.shapeEntropy.toFixed(2).padStart(6) + '    ' + (hermesAgg.shapeEntropy - proConsensus.shapeEntropy).toFixed(2));
  console.log('  avg distinct archetypes/lineup    | ' + proConsensus.avgDiversityPerLineup.toFixed(2).padStart(6) + '   ' + hermesAgg.avgDiversityPerLineup.toFixed(2).padStart(6) + '    ' + (hermesAgg.avgDiversityPerLineup - proConsensus.avgDiversityPerLineup).toFixed(2));

  console.log('\n=== INTERPRETATION ===');
  // Identify biggest gaps and rank by deployment value
  const playerGaps: { a: Archetype; pro: number; her: number; gap: number }[] = ARCHETYPES.map(a => ({
    a, pro: proConsensus.playerMix[a] * 100, her: hermesAgg.playerMix[a] * 100, gap: (hermesAgg.playerMix[a] - proConsensus.playerMix[a]) * 100,
  }));
  playerGaps.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
  console.log('\nBiggest player-level gaps:');
  for (const g of playerGaps.slice(0, 5)) {
    const dir = g.gap > 0 ? 'Hermes OVER-uses' : 'Hermes UNDER-uses';
    console.log('  ' + dir + ' ' + g.a + ' by ' + Math.abs(g.gap).toFixed(1) + 'pp (pros ' + g.pro.toFixed(1) + '% vs Hermes ' + g.her.toFixed(1) + '%)');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
