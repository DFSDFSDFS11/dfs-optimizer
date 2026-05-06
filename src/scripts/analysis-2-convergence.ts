/**
 * Analysis 2 — Pro-vs-Pro Lineup Convergence within slate.
 *
 * For each slate:
 *   - Pairwise lineup similarity (Jaccard) between pros' 150-lineup portfolios
 *   - Identify "convergence zones": player-sets that appear in MULTIPLE pros' lineups
 *   - For each pro pair, compute mean Jaccard across all 150x150 lineup pairs
 *   - Identify slates with high inter-pro agreement (convergence) vs disagreement
 *   - For convergence slates: does Hermes-A include the convergence-zone constructions?
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

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function mean(a: number[]): number { if (!a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; }

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
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
  console.log('=== ANALYSIS 2: Pro-vs-pro lineup convergence ===\n');

  const slateRows: any[] = [];

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

    // Extract each pro's lineup-id-sets
    const proLineupSets: Map<string, Set<string>[]> = new Map();
    for (const p of PROS) {
      const lus = extractPro(actuals, nameMap, p.tokens);
      if (lus.length >= 30) proLineupSets.set(p.label, lus.map(lu => new Set(lu.map(pl => pl.id))));
    }
    const validPros = [...proLineupSets.keys()];
    if (validPros.length < 3) continue;

    // Pairwise mean Jaccard between pros (mean of best-match Jaccard for each lineup)
    let proPairScores: number[] = [];
    for (let i = 0; i < validPros.length; i++) {
      for (let j = i + 1; j < validPros.length; j++) {
        const a = proLineupSets.get(validPros[i])!;
        const b = proLineupSets.get(validPros[j])!;
        // For each lineup in a, find max Jaccard with any in b. Avg.
        const maxJaccards: number[] = [];
        for (const la of a) {
          let maxJ = 0;
          for (const lb of b) {
            const j2 = jaccard(la, lb);
            if (j2 > maxJ) maxJ = j2;
          }
          maxJaccards.push(maxJ);
        }
        proPairScores.push(mean(maxJaccards));
      }
    }
    const meanProPairJaccard = mean(proPairScores);

    // Find "convergence lineups": player-sets that appear (Jaccard > 0.7) across ≥3 pros
    // Approximate: for each lineup of pro 0, count how many other pros have a near-match
    const allProLineups: { pro: string; set: Set<string> }[] = [];
    for (const [proLabel, sets] of proLineupSets) {
      for (const lset of sets) allProLineups.push({ pro: proLabel, set: lset });
    }
    // Convergence: lineups with Jaccard ≥ 0.8 across 3+ different pros
    let convergenceLineups = 0;
    const convExemplars: Set<string>[] = [];
    for (let i = 0; i < allProLineups.length; i++) {
      const matches = new Set<string>();
      matches.add(allProLineups[i].pro);
      for (let j = 0; j < allProLineups.length; j++) {
        if (i === j) continue;
        if (allProLineups[i].pro === allProLineups[j].pro) continue;
        if (jaccard(allProLineups[i].set, allProLineups[j].set) >= 0.8) matches.add(allProLineups[j].pro);
      }
      if (matches.size >= 3) {
        convergenceLineups++;
        if (convExemplars.length < 30) convExemplars.push(allProLineups[i].set);
      }
    }

    // Hermes-A
    const comboFreq = precomputeComboFrequencies(loaded.lineups, HERMES_A.comboPower);
    const result = productionSelect(loaded.lineups, pool.players, {
      N, lambda: HERMES_A.lambda, comboFreq, maxOverlap: HERMES_A.gamma,
      teamCapPct: HERMES_A.tc, minPrimaryStack: HERMES_A.mps,
      maxExposure: HERMES_A.me, maxExposurePitcher: HERMES_A.mep,
      extremeCornerCap: HERMES_A.corner, projectionFloorPct: HERMES_A.fl,
      binAllocation: HERMES_A.bins,
    });
    const hermesSets = result.portfolio.map(lu => new Set(lu.players.map(p => p.id)));

    // For each convergence exemplar, does Hermes-A have a lineup with Jaccard ≥ 0.8?
    let hermesConvMatches = 0;
    for (const exemp of convExemplars) {
      let maxJ = 0;
      for (const hs of hermesSets) {
        const j = jaccard(exemp, hs);
        if (j > maxJ) maxJ = j;
      }
      if (maxJ >= 0.8) hermesConvMatches++;
    }

    // Hermes mean best-match Jaccard vs each pro
    const hermesProJaccards: number[] = [];
    for (const [proLabel, sets] of proLineupSets) {
      const maxJs: number[] = [];
      for (const hs of hermesSets) {
        let maxJ = 0;
        for (const ls of sets) {
          const j = jaccard(hs, ls);
          if (j > maxJ) maxJ = j;
        }
        maxJs.push(maxJ);
      }
      hermesProJaccards.push(mean(maxJs));
    }

    slateRows.push({
      slate: s.slate, validPros: validPros.length, meanProPairJaccard,
      convergenceLineups, convExemplarsCount: convExemplars.length,
      hermesConvMatches, hermesMeanJaccardVsPros: mean(hermesProJaccards),
    });
  }

  console.log('slate           | proPairs  meanJacc  convLUs  hermesMatches  hermesVsPros');
  for (const r of slateRows) {
    console.log('  ' + r.slate.padEnd(15) + ' | ' + r.validPros.toString().padStart(7) + '   ' + r.meanProPairJaccard.toFixed(3) + '  ' + r.convergenceLineups.toString().padStart(7) + '   ' + r.hermesConvMatches.toString().padStart(7) + '/' + r.convExemplarsCount + '       ' + r.hermesMeanJaccardVsPros.toFixed(3));
  }

  console.log('\n=== AGGREGATE ===');
  console.log('  Mean pro-pair Jaccard: ' + mean(slateRows.map(r => r.meanProPairJaccard)).toFixed(3));
  console.log('  Mean Hermes-A vs pros Jaccard: ' + mean(slateRows.map(r => r.hermesMeanJaccardVsPros)).toFixed(3));
  console.log('  Total convergence lineups identified: ' + slateRows.reduce((s, r) => s + r.convergenceLineups, 0));
  console.log('  Hermes-A captured (Jaccard≥0.8) ' + slateRows.reduce((s, r) => s + r.hermesConvMatches, 0) + ' / ' + slateRows.reduce((s, r) => s + r.convExemplarsCount, 0) + ' convergence exemplars');

  // Slates by agreement
  console.log('\n=== SLATES SORTED BY PRO AGREEMENT ===');
  const sorted = [...slateRows].sort((a, b) => b.meanProPairJaccard - a.meanProPairJaccard);
  console.log('High-agreement slates (top 5):');
  for (const r of sorted.slice(0, 5)) console.log('  ' + r.slate + '  proPairJaccard=' + r.meanProPairJaccard.toFixed(3) + '  hermesVsPros=' + r.hermesMeanJaccardVsPros.toFixed(3));
  console.log('Low-agreement slates (bottom 5):');
  for (const r of sorted.slice(-5)) console.log('  ' + r.slate + '  proPairJaccard=' + r.meanProPairJaccard.toFixed(3) + '  hermesVsPros=' + r.hermesMeanJaccardVsPros.toFixed(3));
}

main().catch(e => { console.error(e); process.exit(1); });
