/**
 * MLB v2-selector validation backtest.
 *
 * Runs three configurations on each of 5 MLB slates (4-6, 4-8, 4-11, 4-12, 4-14)
 * and reports Mode 1 top-1% rate by configuration:
 *
 *   1. OLD v24   (ρ=0.60, varFloor=top70%, projFloor=top100%, no ownFilter)
 *   2. V2 v24    (ρ=0.18, varFloor=top100%=OFF, projFloor=top100%=OFF, ownKeep=0.80)
 *   3. V2 Mode 2 (same params, but candidates = contest field — ceiling reference)
 *
 * For every v2 Mode 1 top-1% hit, record whether it would have been filtered out
 * by the OLD selector's variance floor (i.e. was its variance below the 30th
 * percentile of the candidate pool). This attributes wins to the variance-floor
 * removal specifically.
 *
 * Usage:
 *   npx ts-node src/scripts/mlb-v2-backtest.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import {
  parseCSVFile,
  buildPlayerPool,
  parseContestActuals,
  loadPoolFromCSV,
  ContestActuals,
  ContestEntry,
} from '../parser';
import { getContestConfig } from '../rules';
import {
  DEFAULT_SELECTOR_PARAMS,
  SelectorParams,
  defaultGamma,
  getSportDefaults,
  precomputeSlate,
} from '../selection/algorithm7-selector';
import { v24Select, V24Params, DEFAULT_V24_PARAMS } from '../selection/v24-selector';

// ============================================================
// CONFIG
// ============================================================

const DATA_DIR = 'C:/Users/colin/dfs opto';
const OUT_PATH = 'C:/Users/colin/dfs opto/mlb_v2_backtest_report.md';

const SLATES: Array<{ slate: string; proj: string; actuals: string; pool: string }> = [
  { slate: '4-6-26',  proj: '4-6-26_projections.csv',  actuals: 'dkactuals 4-6-26.csv',    pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26',  proj: '4-8-26projections.csv',   actuals: '4-8-26actuals.csv',       pool: '4-8-26sspool.csv' },
  { slate: '4-11-26', proj: '4-11-26projections.csv',  actuals: '4-11-26actuals.csv',      pool: '4-11-26sspool.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv',  actuals: '4-12-26actuals.csv',      pool: '4-12-26sspool.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv',  actuals: '4-14-26actuals.csv',      pool: '4-14-26sspool.csv' },
];

const OLD_PARAMS: V24Params = {
  ...DEFAULT_V24_PARAMS,
  rhoTarget: 0.60,
  varianceTopFraction: 0.70,
  projectionFloor: 1.0,
  ownershipKeepFraction: 1.0,
  maxExposure: 0.30,
};

const V2_PARAMS: V24Params = {
  ...DEFAULT_V24_PARAMS,
  rhoTarget: 0.18,
  varianceTopFraction: 1.0,
  projectionFloor: 1.0,
  ownershipKeepFraction: 0.80,
  maxExposure: 0.30,
};

// V3 = V2 without ownership filter. U²ₗ should handle field-size-dep chalk/contrarian balance.
const V3_PARAMS: V24Params = {
  ...DEFAULT_V24_PARAMS,
  rhoTarget: 0.18,
  varianceTopFraction: 1.0,
  projectionFloor: 1.0,
  ownershipKeepFraction: 1.0,
  maxExposure: 0.30,
};

// ============================================================
// HELPERS
// ============================================================

function normalizeName(name: string): string {
  return (name || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildNameMap(players: Player[]): Map<string, Player> {
  const m = new Map<string, Player>();
  for (const p of players) m.set(normalizeName(p.name), p);
  return m;
}
function buildIdMap(players: Player[]): Map<string, Player> {
  const m = new Map<string, Player>();
  for (const p of players) m.set(p.id, p);
  return m;
}

function entriesToLineups(entries: ContestEntry[], nameMap: Map<string, Player>): {
  lineups: Lineup[]; actualByHash: Map<string, number>;
} {
  const lineups: Lineup[] = [];
  const actualByHash = new Map<string, number>();
  const seen = new Set<string>();
  for (const e of entries) {
    const pls: Player[] = [];
    let ok = true;
    for (const n of e.playerNames) {
      const p = nameMap.get(normalizeName(n));
      if (!p) { ok = false; break; }
      pls.push(p);
    }
    if (!ok) continue;
    const salary = pls.reduce((s, p) => s + p.salary, 0);
    const projection = pls.reduce((s, p) => s + p.projection, 0);
    const ownership = pls.reduce((s, p) => s + (p.ownership || 0), 0) / pls.length;
    const hash = pls.map(p => p.id).sort().join('|');
    if (seen.has(hash)) continue;
    seen.add(hash);
    lineups.push({ players: pls, salary, projection, ownership, hash });
    actualByHash.set(hash, e.actualPoints);
  }
  return { lineups, actualByHash };
}

function scoreLineupBySumOfPlayerActuals(lu: Lineup, actuals: ContestActuals): number | null {
  let total = 0;
  for (const p of lu.players) {
    const row = actuals.playerActualsByName.get(normalizeName(p.name));
    if (!row) return null;
    total += row.fpts;
  }
  return total;
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.max(0, Math.min(s.length - 1, Math.floor(s.length * p)))];
}

// ============================================================
// PER-SLATE RUN
// ============================================================

interface SelectorEval {
  top1Rate: number;
  top1Hits: number;
  selectedCount: number;
}

interface SlateResult {
  slate: string;
  entries: number;
  top1Threshold: number;

  old: SelectorEval;
  v2: SelectorEval & {
    hitsFilteredByOldVarFloor: number;
    hitsFilteredByV2Ownership: number;
    sampleAttributions: Array<{
      rank: number;
      actual: number;
      projection: number;
      avgOwnership: number;
      variance: number;
      filteredByOld: string[];
    }>;
  };
  v3: SelectorEval & {
    hitsFilteredByOldVarFloor: number;
    hitsFilteredByV2Ownership: number;  // would v2 have dropped this?
    sampleAttributions: Array<{
      rank: number;
      actual: number;
      projection: number;
      avgOwnership: number;
      variance: number;
      filteredByOld: string[];
    }>;
  };
  v3Mode2: SelectorEval;

  notes: string[];
}

async function runSlate(s: typeof SLATES[0]): Promise<SlateResult | null> {
  console.log(`\n=== ${s.slate} ===`);

  const projPath = path.join(DATA_DIR, s.proj);
  const actualsPath = path.join(DATA_DIR, s.actuals);
  const poolPath = path.join(DATA_DIR, s.pool);
  for (const p of [projPath, actualsPath, poolPath]) {
    if (!fs.existsSync(p)) { console.error(`  missing: ${p}`); return null; }
  }

  // Parse
  const parseResult = parseCSVFile(projPath, 'mlb', true);
  const config = getContestConfig('dk', 'mlb', parseResult.detectedContestType);
  const pool = buildPlayerPool(parseResult.players, parseResult.detectedContestType);
  const actuals = parseContestActuals(actualsPath, config);

  const nameMap = buildNameMap(pool.players);
  const idMap = buildIdMap(pool.players);

  // Build field (contest entries → lineups)
  const { lineups: fieldLineups, actualByHash: fieldActualByHash } = entriesToLineups(actuals.entries, nameMap);
  if (fieldLineups.length < 100) { console.error('  field too small'); return null; }

  // Load SS pool
  const loadedPool = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
  const poolLineups = loadedPool.lineups;
  if (poolLineups.length < 50) { console.error('  pool too small'); return null; }

  // Top-1% threshold
  const sortedActuals = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
  const F = sortedActuals.length;
  const top1 = sortedActuals[Math.max(0, Math.floor(F * 0.01) - 1)] || 0;

  // Selector params (shared)
  const selParams: SelectorParams = {
    ...DEFAULT_SELECTOR_PARAMS,
    ...getSportDefaults('mlb'),
    N: 150,
    gamma: defaultGamma(config.rosterSize),
    numWorlds: 1500,
  };

  // --- Precomp Mode 1 (pool as candidates, field = contest field) ---
  console.log(`  precomputing Mode 1 (pool=${poolLineups.length}, field=${fieldLineups.length})…`);
  const t0 = Date.now();
  const precomp1 = precomputeSlate(poolLineups, fieldLineups, pool.players, selParams, 'mlb');
  console.log(`    precomp: ${Date.now() - t0}ms (C=${precomp1.C})`);

  // Run OLD v24
  console.log(`  OLD v24…`);
  const oldRes = v24Select(precomp1, selParams, OLD_PARAMS);

  // Run V2 v24 on same precomp
  console.log(`  V2 v24…`);
  const v2Res = v24Select(precomp1, selParams, V2_PARAMS);

  // Run V3 v24 (no ownership filter) on same precomp
  console.log(`  V3 v24 (no ownership filter)…`);
  const v3Res = v24Select(precomp1, selParams, V3_PARAMS);

  // Score Mode 1 selections by summing per-player actuals
  const scoreLineup = (lu: Lineup): number | null => {
    // Prefer contest-field match (exact duplicate)
    const fa = fieldActualByHash.get(lu.hash);
    if (fa !== undefined) return fa;
    return scoreLineupBySumOfPlayerActuals(lu, actuals);
  };

  const evalSet = (sel: Lineup[]): { rate: number; hits: number; scored: number; hitLineups: Array<{ lu: Lineup; actual: number }> } => {
    let hits = 0, scored = 0;
    const hitLineups: Array<{ lu: Lineup; actual: number }> = [];
    for (const lu of sel) {
      const a = scoreLineup(lu);
      if (a === null) continue;
      scored++;
      if (a >= top1) {
        hits++;
        hitLineups.push({ lu, actual: a });
      }
    }
    return { rate: scored ? hits / scored : 0, hits, scored, hitLineups };
  };

  const oldEval = evalSet(oldRes.selected);
  const v2Eval = evalSet(v2Res.selected);
  const v3Eval = evalSet(v3Res.selected);

  console.log(`    OLD Mode 1: ${oldEval.hits}/${oldEval.scored} = ${(oldEval.rate * 100).toFixed(2)}%`);
  console.log(`    V2  Mode 1: ${v2Eval.hits}/${v2Eval.scored} = ${(v2Eval.rate * 100).toFixed(2)}%`);
  console.log(`    V3  Mode 1: ${v3Eval.hits}/${v3Eval.scored} = ${(v3Eval.rate * 100).toFixed(2)}%`);

  // --- Precomp Mode 2 (field as candidates) for ceiling reference ---
  console.log(`  precomputing Mode 2 (field=${fieldLineups.length} as candidates)…`);
  const t1 = Date.now();
  const precomp2 = precomputeSlate(fieldLineups, fieldLineups, pool.players, selParams, 'mlb');
  console.log(`    precomp: ${Date.now() - t1}ms (C=${precomp2.C})`);
  const v3Mode2Res = v24Select(precomp2, selParams, V3_PARAMS);
  const v3m2Eval = evalSet(v3Mode2Res.selected);
  console.log(`    V3  Mode 2: ${v3m2Eval.hits}/${v3m2Eval.scored} = ${(v3m2Eval.rate * 100).toFixed(2)}%`);

  // --- Attribution ---
  const candVar = Array.from({ length: precomp1.C }, (_, c) => precomp1.candidateVariance[c]);
  const oldVarThreshold = percentile(candVar, 1 - 0.70);
  const candOwn = precomp1.candidatePool.map(l => l.ownership || 0);
  const v2OwnCeiling = percentile(candOwn, 0.80);

  const hashToCandIdx = new Map<string, number>();
  for (let c = 0; c < precomp1.C; c++) hashToCandIdx.set(precomp1.candidatePool[c].hash, c);

  const attribute = (hitLineups: Array<{ lu: Lineup; actual: number }>) => {
    let filteredByOld = 0;
    let filteredByV2Own = 0;
    const sample: SlateResult['v2']['sampleAttributions'] = [];
    for (const { lu, actual } of hitLineups) {
      const cIdx = hashToCandIdx.get(lu.hash);
      if (cIdx === undefined) continue;
      const v = precomp1.candidateVariance[cIdx];
      const own = lu.ownership || 0;
      const reasons: string[] = [];
      if (v < oldVarThreshold) { reasons.push('OLD varFloor'); filteredByOld++; }
      if (own > v2OwnCeiling) { reasons.push('V2 ownership'); filteredByV2Own++; }
      let rank = sortedActuals.length;
      for (let i = 0; i < sortedActuals.length; i++) {
        if (sortedActuals[i] < actual) { rank = i + 1; break; }
      }
      if (reasons.length > 0 || sample.length < 10) {
        sample.push({ rank, actual, projection: lu.projection, avgOwnership: own, variance: v, filteredByOld: reasons });
      }
    }
    return { filteredByOld, filteredByV2Own, sample };
  };

  const v2Attr = attribute(v2Eval.hitLineups);
  const v3Attr = attribute(v3Eval.hitLineups);
  console.log(`    v2 hits filtered by OLD varFloor: ${v2Attr.filteredByOld}/${v2Eval.hits}`);
  console.log(`    v3 hits filtered by OLD varFloor: ${v3Attr.filteredByOld}/${v3Eval.hits}  (blocked by V2 ownFilter: ${v3Attr.filteredByV2Own})`);

  return {
    slate: s.slate,
    entries: F,
    top1Threshold: top1,
    old: { top1Rate: oldEval.rate, top1Hits: oldEval.hits, selectedCount: oldEval.scored },
    v2: {
      top1Rate: v2Eval.rate,
      top1Hits: v2Eval.hits,
      selectedCount: v2Eval.scored,
      hitsFilteredByOldVarFloor: v2Attr.filteredByOld,
      hitsFilteredByV2Ownership: v2Attr.filteredByV2Own,
      sampleAttributions: v2Attr.sample,
    },
    v3: {
      top1Rate: v3Eval.rate,
      top1Hits: v3Eval.hits,
      selectedCount: v3Eval.scored,
      hitsFilteredByOldVarFloor: v3Attr.filteredByOld,
      hitsFilteredByV2Ownership: v3Attr.filteredByV2Own,
      sampleAttributions: v3Attr.sample,
    },
    v3Mode2: { top1Rate: v3m2Eval.rate, top1Hits: v3m2Eval.hits, selectedCount: v3m2Eval.scored },
    notes: [],
  };
}

// ============================================================
// REPORT
// ============================================================

function writeReport(results: SlateResult[]): void {
  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
  let md = `# MLB V3 Selector Backtest — ${results.length} Slates\n\n`;
  md += `**Configs tested (all on Mode 1 SS pool):**\n`;
  md += `- **OLD**: ρ=0.60, varFloor=top70%, projFloor=top100%, no ownFilter (pre-calibration)\n`;
  md += `- **V2**:  ρ=0.18, no varFloor, projFloor off, ownKeep=0.80 (calibration v1)\n`;
  md += `- **V3**:  ρ=0.18, no varFloor, projFloor off, NO ownFilter (U²ₗ handles field-size)\n`;
  md += `- **V3 Mode 2**: V3 params but field as candidates — ceiling reference\n\n`;

  md += `## Headline: top-1% rate per slate\n\n`;
  md += `| Slate | Entries | Thresh | OLD | V2 | **V3** | V3 Mode 2 |\n`;
  md += `|---|---:|---:|---:|---:|---:|---:|\n`;
  let oldSum = 0, v2Sum = 0, v3Sum = 0, v3m2Sum = 0, n = 0;
  for (const r of results) {
    oldSum += r.old.top1Rate;
    v2Sum += r.v2.top1Rate;
    v3Sum += r.v3.top1Rate;
    v3m2Sum += r.v3Mode2.top1Rate;
    n++;
    md += `| ${r.slate} | ${r.entries.toLocaleString()} | ${r.top1Threshold.toFixed(1)} | ${pct(r.old.top1Rate)} (${r.old.top1Hits}/${r.old.selectedCount}) | ${pct(r.v2.top1Rate)} (${r.v2.top1Hits}/${r.v2.selectedCount}) | **${pct(r.v3.top1Rate)} (${r.v3.top1Hits}/${r.v3.selectedCount})** | ${pct(r.v3Mode2.top1Rate)} (${r.v3Mode2.top1Hits}/${r.v3Mode2.selectedCount}) |\n`;
  }
  md += `| **MEAN** | | | **${pct(oldSum / n)}** | **${pct(v2Sum / n)}** | **${pct(v3Sum / n)}** | **${pct(v3m2Sum / n)}** |\n\n`;

  md += `Δ(V3 − OLD): **${((v3Sum - oldSum) / n * 100).toFixed(2)}pp**  |  Δ(V3 − V2): **${((v3Sum - v2Sum) / n * 100).toFixed(2)}pp**  |  Mode1-to-Mode2 gap: **${((v3m2Sum - v3Sum) / n * 100).toFixed(2)}pp**\n\n`;

  md += `## Attribution: V3 hits filtered by OLD selector\n\n`;
  md += `| Slate | V3 hits | Filtered by OLD varFloor | Filtered by V2 ownCap | % dropped by V2 | % saved by no-varFloor |\n`;
  md += `|---|---:|---:|---:|---:|---:|\n`;
  let totalHits = 0, totalFilteredByOld = 0, totalFilteredByV2Own = 0;
  for (const r of results) {
    totalHits += r.v3.top1Hits;
    totalFilteredByOld += r.v3.hitsFilteredByOldVarFloor;
    totalFilteredByV2Own += r.v3.hitsFilteredByV2Ownership;
    const oldFilt = r.v3.top1Hits ? r.v3.hitsFilteredByOldVarFloor / r.v3.top1Hits : 0;
    const v2Filt = r.v3.top1Hits ? r.v3.hitsFilteredByV2Ownership / r.v3.top1Hits : 0;
    md += `| ${r.slate} | ${r.v3.top1Hits} | ${r.v3.hitsFilteredByOldVarFloor} | ${r.v3.hitsFilteredByV2Ownership} | ${pct(v2Filt)} | ${pct(oldFilt)} |\n`;
  }
  const oldFiltPct = totalHits ? totalFilteredByOld / totalHits : 0;
  const v2FiltPct = totalHits ? totalFilteredByV2Own / totalHits : 0;
  md += `| **TOTAL** | **${totalHits}** | **${totalFilteredByOld}** | **${totalFilteredByV2Own}** | **${pct(v2FiltPct)}** | **${pct(oldFiltPct)}** |\n\n`;

  md += `### Interpretation\n\n`;
  md += `- **${pct(oldFiltPct)}** of V3's top-1% hits would have been filtered out by OLD's variance floor → variance-floor removal is doing the work.\n`;
  md += `- **${pct(v2FiltPct)}** of V3's top-1% hits would have been filtered out by V2's ownership cap → these are high-ownership lineups that still won. On chalk-wins slates, the ownership filter was removing these.\n`;
  md += `- If V3 > V2 and V3 > OLD, the U²ₗ objective is successfully handling field-size-dep chalk/contrarian balance without needing a hard ownership filter.\n\n`;

  md += `## Per-slate V3 sample hits\n\n`;
  for (const r of results) {
    if (r.v3.sampleAttributions.length === 0) continue;
    md += `### ${r.slate}\n\n`;
    md += `| Rank | Actual | Projection | Avg Own | Variance | Filtered by |\n`;
    md += `|---:|---:|---:|---:|---:|---|\n`;
    for (const a of r.v3.sampleAttributions.slice(0, 8)) {
      md += `| ${a.rank} | ${a.actual.toFixed(1)} | ${a.projection.toFixed(1)} | ${(a.avgOwnership).toFixed(1)}% | ${a.variance.toFixed(0)} | ${a.filteredByOld.length ? '**' + a.filteredByOld.join(', ') + '**' : '—' } |\n`;
    }
    md += `\n`;
  }

  fs.writeFileSync(OUT_PATH, md);
  console.log(`\n✓ Report: ${OUT_PATH}`);
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  const results: SlateResult[] = [];
  for (const s of SLATES) {
    try {
      const r = await runSlate(s);
      if (r) results.push(r);
      else console.error(`  ⚠ ${s.slate} returned null (see earlier logs)`);
    } catch (err) {
      console.error(`  ❌ ERROR on ${s.slate}: ${(err as Error).message}`);
      console.error((err as Error).stack);
    }
  }
  if (results.length === 0) { console.error('No results.'); process.exit(1); }
  console.log(`\n${results.length}/${SLATES.length} slates succeeded.`);
  writeReport(results);
}

main();
