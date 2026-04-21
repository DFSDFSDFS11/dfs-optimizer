/**
 * V32 Selector — Region-Targeted Portfolio Construction.
 *
 * 1. Load empirical region map (where top-1% winners live in projection × ownership space)
 * 2. Compute region targets (allocate N entries across high-lift cells)
 * 3. For each region: filter pool to candidates in that region, select by V31 marginal score
 * 4. Evil twin hedging
 * 5. Diagnostics: portfolio distance to top-1% centroid
 */

import * as fs from 'fs';
import { CLIOptions, Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';
import {
  precomputeSlate, defaultGamma, getSportDefaults, DEFAULT_SELECTOR_PARAMS, SelectorParams,
} from './algorithm7-selector';
import { buildV31Context, v31Score } from './v31-objective';
import { applyEvilTwinHedging, DEFAULT_EVIL_TWIN_PARAMS } from './evil-twin';
import { applyConstructedTwins, DEFAULT_CONSTRUCTED_TWIN_PARAMS } from './constructed-twin';
import { loadOpponentModel } from '../opponent/calibration';
import { generateCalibratedField, generateBlendedField } from '../opponent/field-generator';
import {
  RegionMap, RegionTargets, loadRegionMap, computeRegionTargets, printRegionMap, auditPoolCoverage,
} from '../analysis/region-map';
import { exportForDraftKings, exportDetailedLineups } from '../scoring';

function findPoolBin(value: number, bins: number[]): number {
  for (let i = bins.length - 1; i >= 0; i--) if (value >= bins[i]) return i;
  return 0;
}

// ============================================================
// MAIN
// ============================================================

export async function runV32Select(options: CLIOptions): Promise<void> {
  console.log('================================================================');
  console.log('V32 SELECT — Region-Targeted Portfolio Construction');
  console.log('================================================================');

  if (!options.input) { console.error('--input required'); process.exit(1); }
  if (!options.poolCsv) { console.error('--pool-csv required'); process.exit(1); }

  // 1. Parse
  const parseResult = parseCSVFile(options.input, options.sport, true);
  const config = getContestConfig(options.site, options.sport, parseResult.detectedContestType);
  const pool = buildPlayerPool(parseResult.players, parseResult.detectedContestType);

  // 2. Load pools
  const poolPaths = options.poolCsv.split(',').map(s => s.trim());
  let candidatePool: Lineup[] = [];
  const seen = new Set<string>();
  for (const pp of poolPaths) {
    if (!fs.existsSync(pp)) continue;
    const loaded = loadPoolFromCSV({ filePath: pp, config, playerMap: pool.byId });
    for (const l of loaded.lineups) { if (!seen.has(l.hash)) { seen.add(l.hash); candidatePool.push(l); } }
  }
  console.log(`  candidate pool: ${candidatePool.length}`);

  // MLB stack filter
  if (options.sport === 'mlb') {
    const before = candidatePool.length;
    candidatePool = candidatePool.filter(l => {
      const teams = new Map<string, number>();
      for (const p of l.players) if (!p.positions?.includes('P')) teams.set(p.team, (teams.get(p.team) || 0) + 1);
      let max = 0; for (const c of teams.values()) if (c > max) max = c;
      return max >= 4;
    });
    if (candidatePool.length < before) console.log(`  stack filter: removed ${before - candidatePool.length}`);
  }

  const gameSet = new Set<string>();
  for (const p of pool.players) gameSet.add(p.gameInfo || `${p.team}_game`);
  const numGames = gameSet.size;
  const isSmallSlate = numGames <= 4;

  // 3. Load region map
  const regionMapPath = (options as any).regionMap as string | undefined;
  let regionMap: RegionMap;
  if (regionMapPath && fs.existsSync(regionMapPath)) {
    regionMap = loadRegionMap(regionMapPath);
    console.log(`  loaded region map from ${regionMapPath}`);
  } else {
    console.error('--region-map required for V32. Run --build-region-map first.');
    process.exit(1);
  }
  printRegionMap(regionMap);

  // 4. Compute targets
  const N = options.lineupCount;
  // Audit pool coverage before computing targets, then adjust min-lift to
  // only allocate to regions the pool can actually fill
  const poolCoordsFull = candidatePool.map(l => ({
    projection: l.projection,
    ownership: l.players.reduce((s, p) => s + (p.ownership || 0), 0) / l.players.length,
  }));
  const poolDist = new Map<string, number>();
  for (const c of poolCoordsFull) {
    const pB = findPoolBin(c.projection, regionMap.projBins);
    const oB = findPoolBin(c.ownership, regionMap.ownBins);
    const key = `${pB}_${oB}`;
    poolDist.set(key, (poolDist.get(key) || 0) + 1);
  }
  // Only target regions where pool has ≥5 candidates
  const feasibleCells = new Map(regionMap.cells);
  for (const [key] of feasibleCells) {
    if ((poolDist.get(key) || 0) < 5) feasibleCells.delete(key);
  }
  const feasibleMap = { ...regionMap, cells: feasibleCells };

  // 5. Dynamic centroid — shift to match THIS slate's pool projection range
  const poolProjSorted = poolCoordsFull.map(c => c.projection).sort((a, b) => a - b);
  const poolP75Proj = poolProjSorted[Math.floor(poolProjSorted.length * 0.75)];
  const historicalCentroidProj = regionMap.top1Centroid.projection;
  const historicalCentroidOwn = regionMap.top1Centroid.ownership;
  const projShift = poolP75Proj - historicalCentroidProj;
  const adjustedCentroid = {
    projection: historicalCentroidProj + projShift,
    ownership: historicalCentroidOwn,
  };
  console.log(`  dynamic centroid: historical=(${historicalCentroidProj.toFixed(1)}, ${historicalCentroidOwn.toFixed(1)}%) → adjusted=(${adjustedCentroid.projection.toFixed(1)}, ${adjustedCentroid.ownership.toFixed(1)}%) [pool p75=${poolP75Proj.toFixed(1)}, shift=${projShift >= 0 ? '+' : ''}${projShift.toFixed(1)}]`);
  const effectiveRegionMap = { ...regionMap, top1Centroid: adjustedCentroid };

  // Recompute targets weighted by proximity to adjusted centroid
  const centroidWeightedCells = new Map<string, any>();
  for (const [key, cell] of feasibleMap.cells) {
    const midProj = (cell.projRange[0] + cell.projRange[1]) / 2;
    const midOwn = (cell.ownRange[0] + cell.ownRange[1]) / 2;
    const dist = Math.sqrt(
      Math.pow((midProj - adjustedCentroid.projection) / 10, 2) +
      Math.pow((midOwn - adjustedCentroid.ownership) / 5, 2)
    );
    const proximityWeight = 1 / (1 + dist);
    centroidWeightedCells.set(key, { ...cell, top1Lift: cell.top1Lift * proximityWeight * proximityWeight });
  }
  const targets = computeRegionTargets({ ...feasibleMap, cells: centroidWeightedCells }, N, 'weighted_lift', 0.1);
  console.log(`  Region allocations (${targets.totalAllocated} total across ${targets.allocations.size} regions):`);
  for (const [key, count] of [...targets.allocations.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    const cell = regionMap.cells.get(key);
    if (cell) console.log(`    proj ${cell.projRange[0]}-${cell.projRange[1]}, own ${cell.ownRange[0]}-${cell.ownRange[1]}%: ${count} entries (lift=${cell.top1Lift.toFixed(1)})`);
  }

  // 6. Build blended field (80% SS pool + 20% casual) for σ_{δ,G} computation
  const fieldLineups = generateBlendedField(
    candidatePool, pool.players, config,
    Math.min(8000, candidatePool.length * 2), 0.20,
  );
  console.log(`  blended field: ${fieldLineups.length} (80% pool + 20% casual)`);

  const selParams: SelectorParams = {
    ...DEFAULT_SELECTOR_PARAMS, ...getSportDefaults(options.sport),
    N, gamma: defaultGamma(config.rosterSize),
    numWorlds: options.worlds ?? 2000,
  };
  console.log(`\n  precomputing worlds (W=${selParams.numWorlds})…`);
  const t0 = Date.now();
  const precomp = precomputeSlate(candidatePool, fieldLineups, pool.players, selParams, options.sport);
  console.log(`  precompute: ${Date.now() - t0}ms (C=${precomp.C})`);

  // 7. Build V31 context for scoring within regions
  const ctx = buildV31Context(precomp, fieldLineups, pool.players);

  // 8. Region-targeted selection
  console.log(`\n  selecting by region…`);
  const selected: Lineup[] = [];
  const selectedHashes = new Set<string>();
  const playerCount = new Map<string, number>();
  const teamStackCount = new Map<string, number>();
  const maxPerTeam = Math.floor(N * 0.25);  // no single team > 25%
  const maxExpCap = Math.ceil((isSmallSlate ? 0.50 : 0.35) * N);
  const maxOverlap = isSmallSlate ? config.rosterSize - 2 : defaultGamma(config.rosterSize);

  // Pre-compute candidate coords + V31 scores at a balanced (lambdaVar, lambdaSigma)
  const candCoords = precomp.candidatePool.map((l, c) => ({
    idx: c,
    projection: l.projection,
    ownership: l.players.reduce((s, p) => s + (p.ownership || 0), 0) / l.players.length,
  }));

  // Within-region scoring: scale λ_sigma by slate size.
  // σ_{δ,G} per player scales ~inversely with number of games (fewer games =
  // each player's ownership is a larger fraction of the field's structure).
  // Full slate (8+ games): λ_sigma = 0.30. Short slate (3-4 games): λ_sigma = 0.15.
  const lambdaVar = numGames >= 8 ? 0.30 : numGames >= 6 ? 0.25 : numGames >= 4 ? 0.10 : 0.05;
  const lambdaSigma = numGames >= 8 ? 0.30 : numGames >= 6 ? 0.22 : numGames >= 4 ? 0.05 : 0.03;
  console.log(`  λ_sigma: ${lambdaSigma} (${numGames} games, ${isSmallSlate ? 'small' : 'full'} slate)`);

  // Sort allocations by proximity to centroid (fill sweet spot FIRST, then branch out)
  const sortedAlloc = [...targets.allocations.entries()]
    .sort((a, b) => {
      const ca = regionMap.cells.get(a[0]);
      const cb = regionMap.cells.get(b[0]);
      const distA = ca ? Math.abs((ca.projRange[0] + ca.projRange[1]) / 2 - effectiveRegionMap.top1Centroid.projection) / 10
        + Math.abs((ca.ownRange[0] + ca.ownRange[1]) / 2 - effectiveRegionMap.top1Centroid.ownership) / 5 : 99;
      const distB = cb ? Math.abs((cb.projRange[0] + cb.projRange[1]) / 2 - effectiveRegionMap.top1Centroid.projection) / 10
        + Math.abs((cb.ownRange[0] + cb.ownRange[1]) / 2 - effectiveRegionMap.top1Centroid.ownership) / 5 : 99;
      return distA - distB;
    });

  for (const [key, targetCount] of sortedAlloc) {
    const cell = regionMap.cells.get(key);
    if (!cell) continue;

    // Filter candidates in this region
    const regionCands = candCoords.filter(c =>
      c.projection >= cell.projRange[0] && c.projection < cell.projRange[1] &&
      c.ownership >= cell.ownRange[0] && c.ownership < cell.ownRange[1]
    );

    // Score by V31 objective
    const scored = regionCands.map(c => ({
      ...c,
      score: precomp.candidateProjection[c.idx],  // region handles ownership; within region pick best projection
    })).sort((a, b) => b.score - a.score);

    let filled = 0;
    for (const cand of scored) {
      if (filled >= targetCount) break;
      const lu = precomp.candidatePool[cand.idx];
      if (selectedHashes.has(lu.hash)) continue;
      let expOk = true;
      for (const p of lu.players) if ((playerCount.get(p.id) || 0) >= maxExpCap) { expOk = false; break; }
      if (!expOk) continue;
      // Overlap check
      let ovOk = true;
      const cIds = new Set(lu.players.map(p => p.id));
      for (const prev of selected) {
        let sh = 0; for (const p of prev.players) if (cIds.has(p.id)) sh++;
        if (sh > maxOverlap) { ovOk = false; break; }
      }
      if (!ovOk) continue;

      // Check team stack cap
      const luTeams = new Map<string, number>();
      for (const p of lu.players) if (!p.positions?.includes('P')) luTeams.set(p.team, (luTeams.get(p.team) || 0) + 1);
      let teamCapOk = true;
      for (const [t, c] of luTeams) if (c >= 4 && (teamStackCount.get(t) || 0) >= maxPerTeam) { teamCapOk = false; break; }
      if (!teamCapOk) continue;

      selected.push(lu);
      selectedHashes.add(lu.hash);
      for (const p of lu.players) playerCount.set(p.id, (playerCount.get(p.id) || 0) + 1);
      for (const [t, c] of luTeams) if (c >= 4) teamStackCount.set(t, (teamStackCount.get(t) || 0) + 1);
      filled++;
    }

    if (filled < targetCount) {
      console.log(`    region proj ${cell.projRange[0]}-${cell.projRange[1]}, own ${cell.ownRange[0]}-${cell.ownRange[1]}%: ${filled}/${targetCount} filled`);
    }
  }
  console.log(`  region selection: ${selected.length}/${N}`);

  // Team-coverage pass: ensure every viable stack team has ≥ minPerTeam entries.
  // This prevents zero-exposure to opposing-pitcher stacks (WSH/BAL/MIA etc.)
  const coveredTeams = new Map<string, number>();
  for (const lu of selected) {
    const teams = new Map<string, number>();
    for (const p of lu.players) if (!p.positions?.includes('P')) teams.set(p.team, (teams.get(p.team) || 0) + 1);
    for (const [t, c] of teams) if (c >= 4) coveredTeams.set(t, (coveredTeams.get(t) || 0) + 1);
  }
  // Find teams with pool stacks but zero/low selection
  const allTeamsOnSlate = new Set<string>();
  for (const p of pool.players) if (p.team) allTeamsOnSlate.add(p.team);
  const minPerTeam = Math.max(3, Math.floor(N / allTeamsOnSlate.size * 0.6));
  const uncoveredTeams: string[] = [];
  for (const team of allTeamsOnSlate) {
    if ((coveredTeams.get(team) || 0) < minPerTeam) {
      // Check pool has stacks for this team
      const teamStacks = candCoords.filter(c => {
        const lu = precomp.candidatePool[c.idx];
        const tc = new Map<string, number>();
        for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
        return (tc.get(team) || 0) >= 4;
      });
      if (teamStacks.length >= 5) uncoveredTeams.push(team);
    }
  }
  if (uncoveredTeams.length > 0) {
    console.log(`  team coverage: adding entries for ${uncoveredTeams.join(', ')}`);
    for (const team of uncoveredTeams) {
      const teamCands = candCoords.filter(c => {
        const lu = precomp.candidatePool[c.idx];
        const tc = new Map<string, number>();
        for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
        return (tc.get(team) || 0) >= 4;
      }).map(c => ({ ...c, score: precomp.candidateProjection[c.idx] }))
        .sort((a, b) => b.score - a.score);

      const needed = minPerTeam - (coveredTeams.get(team) || 0);
      let added = 0;
      for (const cand of teamCands) {
        if (added >= needed) break;
        const lu = precomp.candidatePool[cand.idx];
        if (selectedHashes.has(lu.hash)) continue;
        let expOk = true;
        for (const p of lu.players) if ((playerCount.get(p.id) || 0) >= maxExpCap) { expOk = false; break; }
        if (!expOk) continue;

        // If portfolio is full, REPLACE the weakest entry (lowest projection)
        if (selected.length >= N) {
          const weakestIdx = selected.reduce((best, lu2, idx) =>
            lu2.projection < selected[best].projection ? idx : best, 0);
          const removed = selected[weakestIdx];
          // Decrement exposure for removed lineup
          for (const p of removed.players) {
            const cur = playerCount.get(p.id) || 0;
            if (cur > 0) playerCount.set(p.id, cur - 1);
          }
          selectedHashes.delete(removed.hash);
          selected[weakestIdx] = lu;
        } else {
          selected.push(lu);
        }
        selectedHashes.add(lu.hash);
        for (const p of lu.players) playerCount.set(p.id, (playerCount.get(p.id) || 0) + 1);
        added++;
      }
      if (added > 0) console.log(`    ${team}: +${added} entries`);
    }
  }

  // Fill remainder by projection
  if (selected.length < N) {
    const allScored = candCoords.map(c => ({
      ...c, score: precomp.candidateProjection[c.idx],
    })).sort((a, b) => b.score - a.score);
    for (const cand of allScored) {
      if (selected.length >= N) break;
      const lu = precomp.candidatePool[cand.idx];
      if (selectedHashes.has(lu.hash)) continue;
      let expOk = true;
      for (const p of lu.players) if ((playerCount.get(p.id) || 0) >= maxExpCap) { expOk = false; break; }
      if (!expOk) continue;
      selected.push(lu);
      selectedHashes.add(lu.hash);
      for (const p of lu.players) playerCount.set(p.id, (playerCount.get(p.id) || 0) + 1);
    }
    console.log(`  after fill: ${selected.length}/${N}`);
  }

  // 9. Skip evil twin — use region-targeted selection directly
  const finalPortfolio = selected;

  // 10. Diagnostics
  let sumProj = 0, sumOwn = 0;
  for (const l of finalPortfolio) {
    sumProj += l.projection;
    sumOwn += l.players.reduce((s, p) => s + (p.ownership || 0), 0) / l.players.length;
  }
  const avgProj = sumProj / finalPortfolio.length;
  const avgOwn = sumOwn / finalPortfolio.length;
  const distToCenter = Math.sqrt(
    Math.pow((avgProj - effectiveRegionMap.top1Centroid.projection) / 10, 2) +
    Math.pow((avgOwn - effectiveRegionMap.top1Centroid.ownership) / 5, 2)
  );
  console.log(`\n  Portfolio: ${finalPortfolio.length} lineups`);
  console.log(`    avg proj: ${avgProj.toFixed(1)} (centroid: ${effectiveRegionMap.top1Centroid.projection.toFixed(1)})`);
  console.log(`    avg own:  ${avgOwn.toFixed(1)}% (centroid: ${effectiveRegionMap.top1Centroid.ownership.toFixed(1)}%)`);
  console.log(`    distance to top-1% centroid: ${distToCenter.toFixed(2)}`);

  // 11. Export
  exportForDraftKings(finalPortfolio, config, options.output);
  const detailPath = options.output.replace('.csv', '_detailed.csv');
  exportDetailedLineups(finalPortfolio, config, detailPath);

  console.log(`\n================================================================`);
  console.log(`DONE — ${finalPortfolio.length} lineups`);
  console.log(`  • DK upload: ${options.output}`);
  console.log(`  • Detail:    ${detailPath}`);
  console.log(`================================================================`);
}
