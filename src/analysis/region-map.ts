/**
 * 2D Winner Region Analysis — (Projection, Ownership) heatmap.
 *
 * Bins every contest entry into a (projection, ownership) cell, counts top-1%/5%/cash
 * hits per cell, computes lift (conditional hit rate / baseline hit rate).
 *
 * Output: a RegionMap that tells us WHERE in (projection, ownership) space
 * winning lineups actually live. Used by V32 selector to target portfolio
 * construction into high-lift regions.
 */

import * as fs from 'fs';
import { ContestEntry, ContestActuals } from '../parser/actuals-parser';
import { Player } from '../types';

// ============================================================
// TYPES
// ============================================================

export interface RegionCell {
  projRange: [number, number];
  ownRange: [number, number];
  totalLineups: number;
  top1Lineups: number;
  top5Lineups: number;
  cashLineups: number;
  top1Rate: number;
  top5Rate: number;
  cashRate: number;
  fieldFraction: number;
  top1Lift: number;
}

export interface RegionMap {
  projBins: number[];
  ownBins: number[];
  cells: Map<string, RegionCell>;
  baselineTop1Rate: number;
  top1Centroid: { projection: number; ownership: number };
  slatesUsed: number;
}

export interface RegionTargets {
  allocations: Map<string, number>;  // cellKey → entry count
  totalAllocated: number;
}

// ============================================================
// BUILD REGION MAP
// ============================================================

export function buildRegionMap(
  slateData: Array<{
    entries: ContestEntry[];
    playerByName: Map<string, Player>;
    totalEntries: number;
  }>,
  projBins: number[] = [70, 80, 85, 90, 95, 100, 105, 110, 120],
  ownBins: number[] = [0, 5, 8, 12, 16, 20, 25, 35, 60],
): RegionMap {
  const cells = new Map<string, RegionCell>();
  let totalAll = 0, totalTop1 = 0;
  let sumTop1Proj = 0, sumTop1Own = 0;

  for (const slate of slateData) {
    const N = slate.totalEntries;
    const top1Thresh = Math.floor(N * 0.01);
    const top5Thresh = Math.floor(N * 0.05);
    const cashThresh = Math.floor(N * 0.22);

    for (const entry of slate.entries) {
      // Resolve players
      const players: Player[] = [];
      for (const name of entry.playerNames) {
        const norm = name.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
        const p = slate.playerByName.get(norm);
        if (p) players.push(p);
      }
      if (players.length < 6) continue;

      const totalProj = players.reduce((s, p) => s + p.projection, 0);
      const avgOwn = players.reduce((s, p) => s + (p.ownership || 0), 0) / players.length;
      const isTop1 = entry.rank <= top1Thresh;
      const isTop5 = entry.rank <= top5Thresh;
      const isCash = entry.rank <= cashThresh;

      const pBin = findBin(totalProj, projBins);
      const oBin = findBin(avgOwn, ownBins);
      const key = `${pBin}_${oBin}`;

      if (!cells.has(key)) {
        cells.set(key, {
          projRange: [projBins[pBin] || 0, projBins[pBin + 1] || 999],
          ownRange: [ownBins[oBin] || 0, ownBins[oBin + 1] || 100],
          totalLineups: 0, top1Lineups: 0, top5Lineups: 0, cashLineups: 0,
          top1Rate: 0, top5Rate: 0, cashRate: 0, fieldFraction: 0, top1Lift: 0,
        });
      }
      const cell = cells.get(key)!;
      cell.totalLineups++;
      if (isTop1) { cell.top1Lineups++; sumTop1Proj += totalProj; sumTop1Own += avgOwn; }
      if (isTop5) cell.top5Lineups++;
      if (isCash) cell.cashLineups++;
      totalAll++;
      if (isTop1) totalTop1++;
    }
  }

  const baselineTop1Rate = totalAll > 0 ? totalTop1 / totalAll : 0.01;
  for (const cell of cells.values()) {
    cell.top1Rate = cell.totalLineups > 0 ? cell.top1Lineups / cell.totalLineups : 0;
    cell.top5Rate = cell.totalLineups > 0 ? cell.top5Lineups / cell.totalLineups : 0;
    cell.cashRate = cell.totalLineups > 0 ? cell.cashLineups / cell.totalLineups : 0;
    cell.fieldFraction = totalAll > 0 ? cell.totalLineups / totalAll : 0;
    cell.top1Lift = baselineTop1Rate > 0 ? cell.top1Rate / baselineTop1Rate : 0;
  }

  const top1Centroid = {
    projection: totalTop1 > 0 ? sumTop1Proj / totalTop1 : 95,
    ownership: totalTop1 > 0 ? sumTop1Own / totalTop1 : 15,
  };

  return { projBins, ownBins, cells, baselineTop1Rate, top1Centroid, slatesUsed: slateData.length };
}

// ============================================================
// COMPUTE REGION TARGETS
// ============================================================

export function computeRegionTargets(
  regionMap: RegionMap,
  portfolioSize: number,
  strategy: 'match_winners' | 'weighted_lift' = 'weighted_lift',
  minLift: number = 1.0,
): RegionTargets {
  const allocations = new Map<string, number>();

  if (strategy === 'match_winners') {
    const totalTop1 = [...regionMap.cells.values()].reduce((s, c) => s + c.top1Lineups, 0);
    if (totalTop1 === 0) return { allocations, totalAllocated: 0 };
    for (const [key, cell] of regionMap.cells) {
      if (cell.top1Lineups === 0) continue;
      const frac = cell.top1Lineups / totalTop1;
      const count = Math.round(frac * portfolioSize);
      if (count > 0) allocations.set(key, count);
    }
  } else {
    const eligible = [...regionMap.cells.entries()].filter(([, c]) => c.top1Lift >= minLift && c.top1Lineups > 0);
    const totalLift = eligible.reduce((s, [, c]) => s + c.top1Lift * c.top1Lineups, 0);
    if (totalLift === 0) return { allocations, totalAllocated: 0 };
    for (const [key, cell] of eligible) {
      const weight = cell.top1Lift * cell.top1Lineups;
      const count = Math.max(1, Math.round((weight / totalLift) * portfolioSize));
      allocations.set(key, count);
    }
  }

  // Fix rounding to hit portfolioSize
  const total = [...allocations.values()].reduce((a, b) => a + b, 0);
  if (total !== portfolioSize && allocations.size > 0) {
    const sorted = [...allocations.entries()].sort((a, b) => b[1] - a[1]);
    const diff = portfolioSize - total;
    sorted[0][1] += diff;
    allocations.set(sorted[0][0], sorted[0][1]);
  }

  return { allocations, totalAllocated: [...allocations.values()].reduce((a, b) => a + b, 0) };
}

// ============================================================
// SERIALIZATION
// ============================================================

export function saveRegionMap(map: RegionMap, filePath: string): void {
  const serializable = {
    ...map,
    cells: Object.fromEntries(map.cells),
  };
  fs.writeFileSync(filePath, JSON.stringify(serializable, null, 2));
}

export function loadRegionMap(filePath: string): RegionMap {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  return { ...raw, cells: new Map(Object.entries(raw.cells)) };
}

// ============================================================
// DIAGNOSTICS
// ============================================================

export function printRegionMap(map: RegionMap): void {
  console.log(`\n  Region Map (${map.slatesUsed} slates, baseline top-1% = ${(map.baselineTop1Rate * 100).toFixed(2)}%)`);
  console.log(`  Top-1% centroid: proj=${map.top1Centroid.projection.toFixed(1)}, own=${map.top1Centroid.ownership.toFixed(1)}%`);

  const sorted = [...map.cells.entries()]
    .filter(([, c]) => c.top1Lineups > 0)
    .sort((a, b) => b[1].top1Lift - a[1].top1Lift);

  console.log(`\n  Top regions by lift:`);
  console.log(`  ${'Proj range'.padEnd(14)} ${'Own range'.padEnd(12)} ${'Field%'.padStart(7)} ${'T1 hits'.padStart(8)} ${'T1 rate'.padStart(8)} ${'Lift'.padStart(6)}`);
  for (const [, cell] of sorted.slice(0, 12)) {
    console.log(`  ${`${cell.projRange[0]}-${cell.projRange[1]}`.padEnd(14)} ${`${cell.ownRange[0]}-${cell.ownRange[1]}%`.padEnd(12)} ${(cell.fieldFraction * 100).toFixed(1).padStart(6)}% ${String(cell.top1Lineups).padStart(8)} ${(cell.top1Rate * 100).toFixed(2).padStart(7)}% ${cell.top1Lift.toFixed(1).padStart(6)}`);
  }
}

export function auditPoolCoverage(
  pool: Array<{ projection: number; ownership: number }>,
  targets: RegionTargets,
  projBins: number[],
  ownBins: number[],
): Array<{ region: string; target: number; poolCount: number; gap: number }> {
  const poolDist = new Map<string, number>();
  for (const c of pool) {
    const pBin = findBin(c.projection, projBins);
    const oBin = findBin(c.ownership, ownBins);
    const key = `${pBin}_${oBin}`;
    poolDist.set(key, (poolDist.get(key) || 0) + 1);
  }
  const gaps: Array<{ region: string; target: number; poolCount: number; gap: number }> = [];
  for (const [key, target] of targets.allocations) {
    const poolCount = poolDist.get(key) || 0;
    if (poolCount < target * 2) {
      gaps.push({ region: key, target, poolCount, gap: target - Math.floor(poolCount / 2) });
    }
  }
  return gaps;
}

// ============================================================
// HELPERS
// ============================================================

function findBin(value: number, bins: number[]): number {
  for (let i = bins.length - 1; i >= 0; i--) {
    if (value >= bins[i]) return i;
  }
  return 0;
}
