/**
 * Three orthogonal structural analyses of nerdytenor vs production:
 *
 *   (1) Barbell ownership — stddev of per-player ownership within each lineup.
 *       High stddev = "chalk stars + cheap punts" construction.
 *       Low stddev = uniform ownership across lineup.
 *
 *   (2) Structural stacks per lineup — count of correlation structures:
 *        a) Primary stack (4+ hitters one team)
 *        b) Mini-stacks (teams with 2-3 hitters, beyond primary)
 *        c) Pitcher-vs-opposing-stack (anti-correlation, bad — count how often it happens)
 *
 *   (3) Positional leverage — avg ownership + variance per roster position slot
 *       (P, C, 1B, 2B, 3B, SS, OF).
 *
 * Production config: λ=0.05, γ=7 shipped defaults.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';
import { productionSelect } from '../selection/production-selector';
import { precomputeComboFrequencies } from '../selection/combo-leverage';

const DIR = 'C:/Users/colin/dfs opto';
const N = 150;
const LAMBDA = 0.05;
const GAMMA = 7;

const SLATES = [
  { slate: '4-6-26', proj: '4-6-26_projections.csv', actuals: 'dkactuals 4-6-26.csv', pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26', proj: '4-8-26projections.csv', actuals: '4-8-26actuals.csv', pool: '4-8-26sspool.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv', actuals: '4-12-26actuals.csv', pool: '4-12-26sspool.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv', actuals: '4-14-26actuals.csv', pool: '4-14-26sspool.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv', actuals: '4-15-26actuals.csv', pool: '4-15-26sspool.csv' },
  { slate: '4-17-26', proj: '4-17-26projections.csv', actuals: '4-17-26actuals.csv', pool: '4-17-26sspool.csv' },
  { slate: '4-19-26', proj: '4-19-26projections.csv', actuals: '4-19-26actuals.csv', pool: '4-19-26sspool.csv' },
  { slate: '4-20-26', proj: '4-20-26projections.csv', actuals: '4-20-26actuals.csv', pool: '4-20-26sspool.csv' },
];

const POSITIONS = ['P', 'C', '1B', '2B', '3B', 'SS', 'OF'];

function norm(n: string): string {
  return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function mean(arr: number[]): number {
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}

function stddev(arr: number[]): number {
  if (arr.length <= 1) return 0;
  const m = mean(arr);
  const v = arr.reduce((s, x) => s + (x - m) * (x - m), 0) / arr.length;
  return Math.sqrt(v);
}

function resolveLineup(playerNames: string[], nameMap: Map<string, Player>): Player[] | null {
  const pls: Player[] = [];
  for (const nm of playerNames) {
    const p = nameMap.get(norm(nm));
    if (!p) return null;
    pls.push(p);
  }
  return pls;
}

// ============================================================
// (1) Barbell ownership
// ============================================================
function barbellStats(portfolio: Player[][]): { avgStddev: number; avgMean: number; avgMax: number; avgMin: number } {
  const stddevs: number[] = [];
  const means: number[] = [];
  const maxs: number[] = [];
  const mins: number[] = [];
  for (const lu of portfolio) {
    const owns = lu.map(p => p.ownership || 0);
    stddevs.push(stddev(owns));
    means.push(mean(owns));
    maxs.push(Math.max(...owns));
    mins.push(Math.min(...owns));
  }
  return {
    avgStddev: mean(stddevs),
    avgMean: mean(means),
    avgMax: mean(maxs),
    avgMin: mean(mins),
  };
}

// ============================================================
// (2) Structural stack count
// ============================================================
function structuralStats(portfolio: Player[][]): {
  avgPrimaryStackSize: number;
  pctWithPrimary4Plus: number;
  avgMiniStackCount: number;    // teams with 2-3 hitters (excluding primary 4+)
  avgTotalCorrStructures: number; // primary 4+ (count=1 if exists) + miniStacks
  pctPitcherVsOwnStack: number;  // pitcher on SAME team as primary stack (bad in MLB)
  pctPitcherVsOpposingStack: number;  // pitcher on opposing team of primary stack (bad — anti-corr)
} {
  let primSizes: number[] = [];
  let withPrim = 0;
  let miniCounts: number[] = [];
  let totalCorr: number[] = [];
  let pitcherOnOwnStack = 0;
  let pitcherOnOpposingStack = 0;

  for (const lu of portfolio) {
    const pitchers: Player[] = [];
    const hittersByTeam = new Map<string, number>();
    const hitterOpponents = new Map<string, string>(); // team → opponent abbrev
    for (const p of lu) {
      if (p.positions?.includes('P')) {
        pitchers.push(p);
      } else {
        hittersByTeam.set(p.team, (hittersByTeam.get(p.team) || 0) + 1);
        if (p.opponent) hitterOpponents.set(p.team, p.opponent);
      }
    }
    // Identify primary stack
    let primaryTeam: string | null = null;
    let primarySize = 0;
    for (const [t, n] of hittersByTeam) {
      if (n > primarySize) { primarySize = n; primaryTeam = t; }
    }
    const hasPrim = primarySize >= 4;
    if (hasPrim) withPrim++;
    primSizes.push(primarySize);

    // Mini-stacks: teams with 2+ hitters, excluding primary
    let mini = 0;
    for (const [t, n] of hittersByTeam) {
      if (t === primaryTeam) continue;
      if (n >= 2) mini++;
    }
    miniCounts.push(mini);
    totalCorr.push((hasPrim ? 1 : 0) + mini);

    // Pitcher alignment to primary stack
    if (hasPrim && primaryTeam) {
      for (const pp of pitchers) {
        if (pp.team === primaryTeam) pitcherOnOwnStack++;
        else if (pp.opponent === primaryTeam) pitcherOnOpposingStack++;
      }
    }
  }

  return {
    avgPrimaryStackSize: mean(primSizes),
    pctWithPrimary4Plus: portfolio.length ? withPrim / portfolio.length * 100 : 0,
    avgMiniStackCount: mean(miniCounts),
    avgTotalCorrStructures: mean(totalCorr),
    pctPitcherVsOwnStack: portfolio.length ? pitcherOnOwnStack / portfolio.length * 100 : 0,
    pctPitcherVsOpposingStack: portfolio.length ? pitcherOnOpposingStack / portfolio.length * 100 : 0,
  };
}

// ============================================================
// (3) Positional leverage
// ============================================================
function positionStats(portfolio: Player[][]): Map<string, { n: number; avgOwn: number; avgProj: number; avgCeiling: number }> {
  const byPos = new Map<string, { owns: number[]; projs: number[]; ceilings: number[] }>();
  for (const pos of POSITIONS) byPos.set(pos, { owns: [], projs: [], ceilings: [] });

  for (const lu of portfolio) {
    for (const p of lu) {
      // Pick primary position. If pitcher, tag P. Else use first hitter position.
      let tag: string | null = null;
      if (p.positions?.includes('P')) tag = 'P';
      else {
        for (const pos of POSITIONS) {
          if (pos === 'P') continue;
          if (p.positions?.includes(pos)) { tag = pos; break; }
        }
      }
      if (!tag) continue;
      const rec = byPos.get(tag);
      if (!rec) continue;
      rec.owns.push(p.ownership || 0);
      rec.projs.push(p.projection || 0);
      rec.ceilings.push(p.ceiling || (p.projection || 0) * 1.3);
    }
  }

  const result = new Map<string, { n: number; avgOwn: number; avgProj: number; avgCeiling: number }>();
  for (const [pos, rec] of byPos) {
    result.set(pos, {
      n: rec.owns.length,
      avgOwn: mean(rec.owns),
      avgProj: mean(rec.projs),
      avgCeiling: mean(rec.ceilings),
    });
  }
  return result;
}

async function main() {
  const out: string[] = [];
  out.push('# Barbell + Structural + Positional Analysis');
  out.push(`Generated ${new Date().toISOString()}`);
  out.push(`\nProduction config: λ=${LAMBDA}, γ=${GAMMA}.\n`);

  type SlateAgg = {
    slate: string;
    nerdyBar: ReturnType<typeof barbellStats>;
    prodBar: ReturnType<typeof barbellStats>;
    nerdyStruct: ReturnType<typeof structuralStats>;
    prodStruct: ReturnType<typeof structuralStats>;
    nerdyPos: Map<string, { n: number; avgOwn: number; avgProj: number; avgCeiling: number }>;
    prodPos: Map<string, { n: number; avgOwn: number; avgProj: number; avgCeiling: number }>;
  };
  const agg: SlateAgg[] = [];

  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj);
    const actualsPath = path.join(DIR, s.actuals);
    const poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) continue;

    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);

    const nameMap = new Map<string, Player>();
    for (const p of pool.players) nameMap.set(norm(p.name), p);
    const idMap = new Map<string, Player>();
    for (const p of pool.players) idMap.set(p.id, p);

    const nerdyEntries = actuals.entries.filter(e => e.entryName.toLowerCase().includes('nerdytenor'));
    if (nerdyEntries.length === 0) continue;
    const nerdyLineups = nerdyEntries.map(e => resolveLineup(e.playerNames, nameMap))
      .filter((x): x is Player[] => x !== null);

    const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
    const comboFreq = precomputeComboFrequencies(loaded.lineups, 3);
    const prodResult = productionSelect(loaded.lineups, pool.players, {
      N, lambda: LAMBDA, comboFreq, maxOverlap: GAMMA,
    });
    const prodLineups = prodResult.portfolio.map(lu => lu.players);

    const nerdyBar = barbellStats(nerdyLineups);
    const prodBar = barbellStats(prodLineups);
    const nerdyStruct = structuralStats(nerdyLineups);
    const prodStruct = structuralStats(prodLineups);
    const nerdyPos = positionStats(nerdyLineups);
    const prodPos = positionStats(prodLineups);

    agg.push({ slate: s.slate, nerdyBar, prodBar, nerdyStruct, prodStruct, nerdyPos, prodPos });

    out.push(`\n## ${s.slate}\n`);
    out.push(`### Barbell ownership (within-lineup stddev of per-player ownership)`);
    out.push(`  nerdy: avgStddev=${nerdyBar.avgStddev.toFixed(2)} avgMin=${nerdyBar.avgMin.toFixed(2)}% avgMax=${nerdyBar.avgMax.toFixed(2)}% avgMean=${nerdyBar.avgMean.toFixed(2)}%`);
    out.push(`  prod:  avgStddev=${prodBar.avgStddev.toFixed(2)} avgMin=${prodBar.avgMin.toFixed(2)}% avgMax=${prodBar.avgMax.toFixed(2)}% avgMean=${prodBar.avgMean.toFixed(2)}%`);
    out.push(`  Δ stddev (n-p): ${(nerdyBar.avgStddev - prodBar.avgStddev).toFixed(2)}`);

    out.push(`\n### Structural stack count`);
    out.push(`  nerdy: primary_size=${nerdyStruct.avgPrimaryStackSize.toFixed(2)} pct4+=${nerdyStruct.pctWithPrimary4Plus.toFixed(1)}% miniStacks=${nerdyStruct.avgMiniStackCount.toFixed(2)} totalCorr=${nerdyStruct.avgTotalCorrStructures.toFixed(2)} P-vs-ownStack=${nerdyStruct.pctPitcherVsOwnStack.toFixed(1)}% P-vs-oppStack=${nerdyStruct.pctPitcherVsOpposingStack.toFixed(1)}%`);
    out.push(`  prod:  primary_size=${prodStruct.avgPrimaryStackSize.toFixed(2)} pct4+=${prodStruct.pctWithPrimary4Plus.toFixed(1)}% miniStacks=${prodStruct.avgMiniStackCount.toFixed(2)} totalCorr=${prodStruct.avgTotalCorrStructures.toFixed(2)} P-vs-ownStack=${prodStruct.pctPitcherVsOwnStack.toFixed(1)}% P-vs-oppStack=${prodStruct.pctPitcherVsOpposingStack.toFixed(1)}%`);
    out.push(`  Δ totalCorr: ${(nerdyStruct.avgTotalCorrStructures - prodStruct.avgTotalCorrStructures).toFixed(2)}`);

    out.push(`\n### Positional leverage (mean ownership by slot)`);
    out.push(`  Pos | nerdy own | prod own | Δ (n-p) | nerdy proj | prod proj | Δ`);
    for (const pos of POSITIONS) {
      const n = nerdyPos.get(pos)!;
      const p = prodPos.get(pos)!;
      const dOwn = n.avgOwn - p.avgOwn;
      const dProj = n.avgProj - p.avgProj;
      out.push(`  ${pos.padEnd(3)} | ${n.avgOwn.toFixed(2).padStart(9)}% | ${p.avgOwn.toFixed(2).padStart(8)}% | ${(dOwn >= 0 ? '+' : '') + dOwn.toFixed(2).padStart(4)} | ${n.avgProj.toFixed(2).padStart(10)} | ${p.avgProj.toFixed(2).padStart(9)} | ${(dProj >= 0 ? '+' : '') + dProj.toFixed(2)}`);
    }
  }

  // ============================================================
  // CROSS-SLATE AVERAGES
  // ============================================================
  out.push('\n\n---\n\n# Cross-Slate Averages\n');

  const avgN = <T extends object>(arr: T[], getter: (x: T) => number) => mean(arr.map(getter));

  out.push('## 1. Barbell ownership\n');
  out.push('| Metric | nerdy | prod | delta (n-p) |');
  out.push('|---|---:|---:|---:|');
  out.push(`| Within-lineup ownership stddev | ${avgN(agg, a => a.nerdyBar.avgStddev).toFixed(2)} | ${avgN(agg, a => a.prodBar.avgStddev).toFixed(2)} | ${(avgN(agg, a => a.nerdyBar.avgStddev) - avgN(agg, a => a.prodBar.avgStddev)).toFixed(2)} |`);
  out.push(`| Per-lineup min ownership | ${avgN(agg, a => a.nerdyBar.avgMin).toFixed(2)}% | ${avgN(agg, a => a.prodBar.avgMin).toFixed(2)}% | ${(avgN(agg, a => a.nerdyBar.avgMin) - avgN(agg, a => a.prodBar.avgMin)).toFixed(2)} |`);
  out.push(`| Per-lineup max ownership | ${avgN(agg, a => a.nerdyBar.avgMax).toFixed(2)}% | ${avgN(agg, a => a.prodBar.avgMax).toFixed(2)}% | ${(avgN(agg, a => a.nerdyBar.avgMax) - avgN(agg, a => a.prodBar.avgMax)).toFixed(2)} |`);
  out.push(`| Per-lineup mean ownership | ${avgN(agg, a => a.nerdyBar.avgMean).toFixed(2)}% | ${avgN(agg, a => a.prodBar.avgMean).toFixed(2)}% | ${(avgN(agg, a => a.nerdyBar.avgMean) - avgN(agg, a => a.prodBar.avgMean)).toFixed(2)} |`);

  out.push('\n## 2. Structural stacks\n');
  out.push('| Metric | nerdy | prod | delta (n-p) |');
  out.push('|---|---:|---:|---:|');
  out.push(`| Avg primary stack size | ${avgN(agg, a => a.nerdyStruct.avgPrimaryStackSize).toFixed(2)} | ${avgN(agg, a => a.prodStruct.avgPrimaryStackSize).toFixed(2)} | ${(avgN(agg, a => a.nerdyStruct.avgPrimaryStackSize) - avgN(agg, a => a.prodStruct.avgPrimaryStackSize)).toFixed(2)} |`);
  out.push(`| % with primary 4+ stack | ${avgN(agg, a => a.nerdyStruct.pctWithPrimary4Plus).toFixed(1)}% | ${avgN(agg, a => a.prodStruct.pctWithPrimary4Plus).toFixed(1)}% | ${(avgN(agg, a => a.nerdyStruct.pctWithPrimary4Plus) - avgN(agg, a => a.prodStruct.pctWithPrimary4Plus)).toFixed(1)} |`);
  out.push(`| Avg mini-stacks (2-3 hitters) | ${avgN(agg, a => a.nerdyStruct.avgMiniStackCount).toFixed(2)} | ${avgN(agg, a => a.prodStruct.avgMiniStackCount).toFixed(2)} | ${(avgN(agg, a => a.nerdyStruct.avgMiniStackCount) - avgN(agg, a => a.prodStruct.avgMiniStackCount)).toFixed(2)} |`);
  out.push(`| Avg total correlation structures | ${avgN(agg, a => a.nerdyStruct.avgTotalCorrStructures).toFixed(2)} | ${avgN(agg, a => a.prodStruct.avgTotalCorrStructures).toFixed(2)} | ${(avgN(agg, a => a.nerdyStruct.avgTotalCorrStructures) - avgN(agg, a => a.prodStruct.avgTotalCorrStructures)).toFixed(2)} |`);
  out.push(`| % pitcher vs own-stack | ${avgN(agg, a => a.nerdyStruct.pctPitcherVsOwnStack).toFixed(1)}% | ${avgN(agg, a => a.prodStruct.pctPitcherVsOwnStack).toFixed(1)}% | ${(avgN(agg, a => a.nerdyStruct.pctPitcherVsOwnStack) - avgN(agg, a => a.prodStruct.pctPitcherVsOwnStack)).toFixed(1)} |`);
  out.push(`| % pitcher vs opposing-stack | ${avgN(agg, a => a.nerdyStruct.pctPitcherVsOpposingStack).toFixed(1)}% | ${avgN(agg, a => a.prodStruct.pctPitcherVsOpposingStack).toFixed(1)}% | ${(avgN(agg, a => a.nerdyStruct.pctPitcherVsOpposingStack) - avgN(agg, a => a.prodStruct.pctPitcherVsOpposingStack)).toFixed(1)} |`);

  out.push('\n## 3. Positional leverage (cross-slate means)\n');
  out.push('| Pos | nerdy own | prod own | Δ own (n-p) | nerdy proj | prod proj | Δ proj | nerdy ceiling | prod ceiling | Δ ceiling |');
  out.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const pos of POSITIONS) {
    const nOwn = avgN(agg, a => a.nerdyPos.get(pos)!.avgOwn);
    const pOwn = avgN(agg, a => a.prodPos.get(pos)!.avgOwn);
    const nProj = avgN(agg, a => a.nerdyPos.get(pos)!.avgProj);
    const pProj = avgN(agg, a => a.prodPos.get(pos)!.avgProj);
    const nCeil = avgN(agg, a => a.nerdyPos.get(pos)!.avgCeiling);
    const pCeil = avgN(agg, a => a.prodPos.get(pos)!.avgCeiling);
    out.push(`| ${pos} | ${nOwn.toFixed(2)}% | ${pOwn.toFixed(2)}% | ${(nOwn - pOwn >= 0 ? '+' : '') + (nOwn - pOwn).toFixed(2)} | ${nProj.toFixed(2)} | ${pProj.toFixed(2)} | ${(nProj - pProj >= 0 ? '+' : '') + (nProj - pProj).toFixed(2)} | ${nCeil.toFixed(2)} | ${pCeil.toFixed(2)} | ${(nCeil - pCeil >= 0 ? '+' : '') + (nCeil - pCeil).toFixed(2)} |`);
  }

  const reportPath = path.join(DIR, 'barbell_structural_positional_analysis.md');
  fs.writeFileSync(reportPath, out.join('\n'));
  console.log(`Report: ${reportPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
