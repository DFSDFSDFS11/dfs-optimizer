/**
 * MLB V30 backtest — compare OLD / V2 / V30 across historical slates.
 *
 * V30 = λ-sweep (6 λ values) + evil twin hedging (25% twin fraction)
 * V2  = V24 with calibrated MLB params (ρ=0.18, no varFloor, ownKeep=0.80)
 * OLD = V24 pre-calibration (ρ=0.60, varFloor=top70%)
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
import { lambdaSweepSelect } from '../selection/lambda-sweep';
import { applyEvilTwinHedging, DEFAULT_EVIL_TWIN_PARAMS } from '../selection/evil-twin';
import { buildV31Context, v31Score } from '../selection/v31-objective';
import { loadRegionMap, computeRegionTargets } from '../analysis/region-map';

const DATA_DIR = 'C:/Users/colin/dfs opto';
const OUT_PATH = 'C:/Users/colin/dfs opto/mlb_v30_backtest_report.md';

const SLATES = [
  { slate: '4-6-26',  proj: '4-6-26_projections.csv',  actuals: 'dkactuals 4-6-26.csv',    pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26',  proj: '4-8-26projections.csv',   actuals: '4-8-26actuals.csv',       pool: '4-8-26sspool.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv',  actuals: '4-12-26actuals.csv',      pool: '4-12-26sspool.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv',  actuals: '4-14-26actuals.csv',      pool: '4-14-26sspool.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv',  actuals: '4-15-26actuals.csv',      pool: '4-15-26sspool.csv' },
];

const OLD_PARAMS: V24Params = {
  ...DEFAULT_V24_PARAMS, rhoTarget: 0.60, varianceTopFraction: 0.70,
  projectionFloor: 1.0, ownershipKeepFraction: 1.0, maxExposure: 0.30,
};
const V2_PARAMS: V24Params = {
  ...DEFAULT_V24_PARAMS, rhoTarget: 0.18, varianceTopFraction: 1.0,
  projectionFloor: 1.0, ownershipKeepFraction: 0.80, maxExposure: 0.30,
};

function normalizeName(name: string): string {
  return (name || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
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

function scoreLineup(lu: Lineup, fieldActualByHash: Map<string, number>, actuals: ContestActuals): number | null {
  const fa = fieldActualByHash.get(lu.hash);
  if (fa !== undefined) return fa;
  let total = 0;
  for (const p of lu.players) {
    const row = actuals.playerActualsByName.get(normalizeName(p.name));
    if (!row) return null;
    total += row.fpts;
  }
  return total;
}

interface Eval { top1Rate: number; top1Hits: number; top5Rate: number; top5Hits: number; top10Rate: number; top10Hits: number; cashRate: number; cashHits: number; scored: number; avgActual: number; bestActual: number }

function evalSet(sel: Lineup[], thresholds: { top1: number; top5: number; top10: number; cash: number }, fieldActualByHash: Map<string, number>, actuals: ContestActuals): Eval {
  let t1 = 0, t5 = 0, t10 = 0, cash = 0, scored = 0, sumActual = 0, best = 0;
  for (const lu of sel) {
    const a = scoreLineup(lu, fieldActualByHash, actuals);
    if (a === null) continue;
    scored++;
    sumActual += a;
    if (a > best) best = a;
    if (a >= thresholds.top1) t1++;
    if (a >= thresholds.top5) t5++;
    if (a >= thresholds.top10) t10++;
    if (a >= thresholds.cash) cash++;
  }
  return {
    top1Rate: scored ? t1 / scored : 0, top1Hits: t1,
    top5Rate: scored ? t5 / scored : 0, top5Hits: t5,
    top10Rate: scored ? t10 / scored : 0, top10Hits: t10,
    cashRate: scored ? cash / scored : 0, cashHits: cash,
    scored, avgActual: scored ? sumActual / scored : 0, bestActual: best,
  };
}

interface ProEval {
  username: string;
  entries: number;
  top1Rate: number; top1Hits: number;
  top5Rate: number; top5Hits: number;
  cashRate: number; cashHits: number;
  avgActual: number; bestActual: number;
  avgOwnership: number;
  maxExposure: number;
  uniqueStackTeams: number;
}

interface SlateResult {
  slate: string; entries: number;
  thresholds: { top1: number; top5: number; top10: number; cash: number };
  old: Eval; v2: Eval; v30: Eval; v31: Eval; v32: Eval; v30Mode2: Eval;
  v30Diag: { avgCorr: number; negPairPct: number; twins: number; lambdaDist: string };
  v31Diag: { avgOwn: number; avgCorr: number; negPairPct: number; twins: number };
  v32Diag: { avgOwn: number; avgProj: number; distToCentroid: number };
  pros: ProEval[];
}

async function runSlate(s: typeof SLATES[0]): Promise<SlateResult | null> {
  console.log(`\n=== ${s.slate} ===`);
  const projPath = path.join(DATA_DIR, s.proj);
  const actualsPath = path.join(DATA_DIR, s.actuals);
  const poolPath = path.join(DATA_DIR, s.pool);
  for (const p of [projPath, actualsPath, poolPath]) {
    if (!fs.existsSync(p)) { console.error(`  missing: ${p}`); return null; }
  }

  const parseResult = parseCSVFile(projPath, 'mlb', true);
  const config = getContestConfig('dk', 'mlb', parseResult.detectedContestType);
  const pool = buildPlayerPool(parseResult.players, parseResult.detectedContestType);
  const actuals = parseContestActuals(actualsPath, config);

  const nameMap = new Map<string, Player>();
  for (const p of pool.players) nameMap.set(normalizeName(p.name), p);
  const idMap = new Map<string, Player>();
  for (const p of pool.players) idMap.set(p.id, p);

  const { lineups: fieldLineups, actualByHash } = entriesToLineups(actuals.entries, nameMap);
  if (fieldLineups.length < 100) { console.error('  field too small'); return null; }

  const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
  const poolLineups = loaded.lineups;
  if (poolLineups.length < 50) { console.error('  pool too small'); return null; }

  const sortedActuals = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
  const F = sortedActuals.length;
  const tAt = (frac: number) => sortedActuals[Math.max(0, Math.floor(F * frac) - 1)] || 0;
  const thresholds = { top1: tAt(0.01), top5: tAt(0.05), top10: tAt(0.10), cash: tAt(0.20) };

  const selParams: SelectorParams = {
    ...DEFAULT_SELECTOR_PARAMS, ...getSportDefaults('mlb'),
    N: 150, gamma: defaultGamma(config.rosterSize), numWorlds: 1500,
  };

  // Mode 1 precomp (pool as candidates, field = contest)
  console.log(`  precomp Mode 1 (pool=${poolLineups.length}, field=${fieldLineups.length})…`);
  const precomp1 = precomputeSlate(poolLineups, fieldLineups, pool.players, selParams, 'mlb');

  // OLD + V2
  console.log(`  OLD v24…`);
  const oldRes = v24Select(precomp1, selParams, OLD_PARAMS);
  console.log(`  V2 v24…`);
  const v2Res = v24Select(precomp1, selParams, V2_PARAMS);

  // V30: λ-sweep + evil twin on Mode 1
  console.log(`  V30 λ-sweep…`);
  const lambdaGrid = [0.3, 0.6, 1.0, 1.5, 2.2, 3.0];
  const frac = [0.10, 0.13, 0.17, 0.20, 0.20, 0.20];
  const entriesPerLambda = frac.map(f => Math.round(f * 150));
  const diff = 150 - entriesPerLambda.reduce((a, b) => a + b, 0);
  entriesPerLambda[entriesPerLambda.length - 1] += diff;

  const sweepRes = lambdaSweepSelect(precomp1, {
    lambdaGrid, entriesPerLambda,
    maxOverlap: defaultGamma(config.rosterSize),
    maxExposure: 0.30,
  });

  console.log(`  V30 evil twin…`);
  const twinRes = applyEvilTwinHedging(sweepRes.selected, precomp1, DEFAULT_EVIL_TWIN_PARAMS);
  const v30Selected = twinRes.portfolio;

  // V31: corrected math objective
  console.log(`  V31 (corrected math)…`);
  const ctx31 = buildV31Context(precomp1, fieldLineups, pool.players);
  const C31 = precomp1.C;
  const v31Grid = [
    { lambdaVar: 0.2, lambdaSigma: 0.3, entries: 20 },
    { lambdaVar: 0.5, lambdaSigma: 0.8, entries: 35 },
    { lambdaVar: 1.0, lambdaSigma: 1.5, entries: 45 },
    { lambdaVar: 1.5, lambdaSigma: 2.5, entries: 50 },
  ];
  const v31Selected: Lineup[] = [];
  const v31Hashes = new Set<string>();
  const v31ExpCount = new Map<string, number>();
  const v31ExpCap = Math.ceil(0.40 * 150);
  let v31MaxOverlap = defaultGamma(config.rosterSize);
  for (const pair of v31Grid) {
    const scores31 = new Float64Array(C31);
    for (let c = 0; c < C31; c++) scores31[c] = v31Score(c, ctx31, precomp1, pair.lambdaVar, pair.lambdaSigma);
    const sorted31 = Array.from({ length: C31 }, (_, i) => i).sort((a, b) => scores31[b] - scores31[a]);
    let picked = 0;
    for (let j = 0; j < pair.entries; j++) {
      let found = false;
      for (const ci of sorted31) {
        const lu = precomp1.candidatePool[ci];
        if (v31Hashes.has(lu.hash)) continue;
        let expOk = true;
        for (const p of lu.players) if ((v31ExpCount.get(p.id) || 0) >= v31ExpCap) { expOk = false; break; }
        if (!expOk) continue;
        let ovOk = true;
        const cids = new Set(lu.players.map(p => p.id));
        for (const prev of v31Selected) {
          let sh = 0; for (const p of prev.players) if (cids.has(p.id)) sh++;
          if (sh > v31MaxOverlap) { ovOk = false; break; }
        }
        if (!ovOk) continue;
        v31Selected.push(lu); v31Hashes.add(lu.hash);
        for (const p of lu.players) v31ExpCount.set(p.id, (v31ExpCount.get(p.id) || 0) + 1);
        found = true; picked++; break;
      }
      if (!found) { v31MaxOverlap++; j--; if (v31MaxOverlap > config.rosterSize) break; }
    }
  }
  const twin31 = applyEvilTwinHedging(v31Selected, precomp1, DEFAULT_EVIL_TWIN_PARAMS);
  const v31Final = twin31.portfolio;

  // V32: region-targeted selection using V31 scoring within regions
  console.log(`  V32 (region-targeted)…`);
  const regionMap = loadRegionMap('C:/Users/colin/dfs opto/region-map-mlb-dk.json');
  const targets = computeRegionTargets(regionMap, 150, 'weighted_lift', 1.0);
  const v32Selected: Lineup[] = [];
  const v32Hashes = new Set<string>();
  const v32ExpCount = new Map<string, number>();
  const v32ExpCap = Math.ceil(0.40 * 150);
  const v32MaxOverlap = defaultGamma(config.rosterSize);
  const v32CandCoords = Array.from({ length: precomp1.C }, (_, c) => ({
    idx: c,
    projection: precomp1.candidatePool[c].projection,
    ownership: precomp1.candidatePool[c].players.reduce((sm: number, p: Player) => sm + (p.ownership || 0), 0) / precomp1.candidatePool[c].players.length,
  }));
  const sortedAlloc = [...targets.allocations.entries()]
    .sort((a, b) => (regionMap.cells.get(b[0])?.top1Lift || 0) - (regionMap.cells.get(a[0])?.top1Lift || 0));
  for (const [key, targetCount] of sortedAlloc) {
    const cell = regionMap.cells.get(key);
    if (!cell) continue;
    const regionCands = v32CandCoords.filter(c =>
      c.projection >= cell.projRange[0] && c.projection < cell.projRange[1] &&
      c.ownership >= cell.ownRange[0] && c.ownership < cell.ownRange[1]
    ).map(c => ({ ...c, score: v31Score(c.idx, ctx31, precomp1, 0.5, 1.0) }))
     .sort((a, b) => b.score - a.score);
    let filled = 0;
    for (const cand of regionCands) {
      if (filled >= targetCount) break;
      const lu = precomp1.candidatePool[cand.idx];
      if (v32Hashes.has(lu.hash)) continue;
      let ok = true;
      for (const p of lu.players) if ((v32ExpCount.get(p.id) || 0) >= v32ExpCap) { ok = false; break; }
      if (!ok) continue;
      v32Selected.push(lu); v32Hashes.add(lu.hash);
      for (const p of lu.players) v32ExpCount.set(p.id, (v32ExpCount.get(p.id) || 0) + 1);
      filled++;
    }
  }
  // Fill remainder
  if (v32Selected.length < 150) {
    const all32 = v32CandCoords.map(c => ({ ...c, score: v31Score(c.idx, ctx31, precomp1, 0.5, 1.0) }))
      .sort((a, b) => b.score - a.score);
    for (const cand of all32) {
      if (v32Selected.length >= 150) break;
      const lu = precomp1.candidatePool[cand.idx];
      if (v32Hashes.has(lu.hash)) continue;
      let ok = true;
      for (const p of lu.players) if ((v32ExpCount.get(p.id) || 0) >= v32ExpCap) { ok = false; break; }
      if (!ok) continue;
      v32Selected.push(lu); v32Hashes.add(lu.hash);
      for (const p of lu.players) v32ExpCount.set(p.id, (v32ExpCount.get(p.id) || 0) + 1);
    }
  }
  const twin32 = applyEvilTwinHedging(v32Selected, precomp1, DEFAULT_EVIL_TWIN_PARAMS);
  const v32Final = twin32.portfolio;
  let v32SumOwn = 0, v32SumProj = 0;
  for (const l of v32Final) { v32SumOwn += l.players.reduce((sm: number, p: Player) => sm + (p.ownership || 0), 0) / l.players.length; v32SumProj += l.projection; }
  const v32AvgOwn = v32Final.length ? v32SumOwn / v32Final.length : 0;
  const v32AvgProj = v32Final.length ? v32SumProj / v32Final.length : 0;
  const v32Dist = Math.sqrt(Math.pow((v32AvgProj - regionMap.top1Centroid.projection) / 10, 2) + Math.pow((v32AvgOwn - regionMap.top1Centroid.ownership) / 5, 2));

  const oldEval = evalSet(oldRes.selected, thresholds, actualByHash, actuals);
  const v2Eval = evalSet(v2Res.selected, thresholds, actualByHash, actuals);
  const v30Eval = evalSet(v30Selected, thresholds, actualByHash, actuals);
  const v31Eval = evalSet(v31Final, thresholds, actualByHash, actuals);
  const v32Eval = evalSet(v32Final, thresholds, actualByHash, actuals);

  let v31SumOwn = 0;
  for (const l of v31Final) v31SumOwn += (l.ownership || 0);
  const v31AvgOwn = v31Final.length ? v31SumOwn / v31Final.length : 0;

  console.log(`    OLD: t1=${oldEval.top1Hits} t5=${oldEval.top5Hits} t10=${oldEval.top10Hits} cash=${oldEval.cashHits}/${oldEval.scored}`);
  console.log(`    V2:  t1=${v2Eval.top1Hits} t5=${v2Eval.top5Hits} t10=${v2Eval.top10Hits} cash=${v2Eval.cashHits}/${v2Eval.scored}`);
  console.log(`    V30: t1=${v30Eval.top1Hits} t5=${v30Eval.top5Hits} t10=${v30Eval.top10Hits} cash=${v30Eval.cashHits}/${v30Eval.scored}`);
  console.log(`    V31: t1=${v31Eval.top1Hits} t5=${v31Eval.top5Hits} t10=${v31Eval.top10Hits} cash=${v31Eval.cashHits}/${v31Eval.scored} own=${v31AvgOwn.toFixed(1)}%`);
  console.log(`    V32: t1=${v32Eval.top1Hits} t5=${v32Eval.top5Hits} t10=${v32Eval.top10Hits} cash=${v32Eval.cashHits}/${v32Eval.scored} own=${v32AvgOwn.toFixed(1)}% proj=${v32AvgProj.toFixed(1)} dist=${v32Dist.toFixed(2)}`);

  // V30 Mode 2 (field as candidates)
  console.log(`  precomp Mode 2…`);
  const precomp2 = precomputeSlate(fieldLineups, fieldLineups, pool.players, selParams, 'mlb');
  const sweep2 = lambdaSweepSelect(precomp2, {
    lambdaGrid, entriesPerLambda,
    maxOverlap: defaultGamma(config.rosterSize),
    maxExposure: 0.30,
  });
  const twin2 = applyEvilTwinHedging(sweep2.selected, precomp2, DEFAULT_EVIL_TWIN_PARAMS);
  const v30m2Eval = evalSet(twin2.portfolio, thresholds, actualByHash, actuals);
  console.log(`    V30 M2: t1=${v30m2Eval.top1Hits} t5=${v30m2Eval.top5Hits} t10=${v30m2Eval.top10Hits} cash=${v30m2Eval.cashHits}/${v30m2Eval.scored}`);

  const lambdaDist = lambdaGrid.map(l => `λ${l}:${(sweepRes.selectedByLambda.get(l) || []).length}`).join(' ');

  // ─── Pro detection + evaluation ───
  const proMap = new Map<string, ContestEntry[]>();
  for (const e of actuals.entries) {
    const u = (e.entryName || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (!u) continue;
    const arr = proMap.get(u);
    if (arr) arr.push(e); else proMap.set(u, [e]);
  }
  const pros: ProEval[] = [];
  for (const [username, entries] of proMap) {
    if (entries.length < 100) continue;
    const proLineups: Lineup[] = [];
    for (const e of entries) {
      const pls: Player[] = [];
      let ok = true;
      for (const n of e.playerNames) { const p = nameMap.get(normalizeName(n)); if (!p) { ok = false; break; } pls.push(p); }
      if (!ok) continue;
      const salary = pls.reduce((s2, p2) => s2 + p2.salary, 0);
      const projection = pls.reduce((s2, p2) => s2 + p2.projection, 0);
      const ownership = pls.reduce((s2, p2) => s2 + (p2.ownership || 0), 0) / pls.length;
      const hash = pls.map(p2 => p2.id).sort().join('|');
      proLineups.push({ players: pls, salary, projection, ownership, hash });
    }
    if (proLineups.length < 50) continue;
    const pe = evalSet(proLineups, thresholds, actualByHash, actuals);
    // Exposure + stack teams
    const expCount = new Map<string, number>();
    const stackTeams = new Set<string>();
    for (const l of proLineups) {
      for (const p2 of l.players) expCount.set(p2.id, (expCount.get(p2.id) || 0) + 1);
      const teams = new Map<string, number>();
      for (const p2 of l.players) { if (!p2.positions?.includes('P')) teams.set(p2.team, (teams.get(p2.team) || 0) + 1); }
      for (const [t, c] of teams) if (c >= 4) stackTeams.add(t);
    }
    let maxExp = 0;
    for (const c of expCount.values()) { const f = c / proLineups.length; if (f > maxExp) maxExp = f; }
    const avgOwn = proLineups.reduce((s2, l) => s2 + l.ownership, 0) / proLineups.length;
    pros.push({
      username, entries: proLineups.length,
      top1Rate: pe.top1Rate, top1Hits: pe.top1Hits,
      top5Rate: pe.top5Rate, top5Hits: pe.top5Hits,
      cashRate: pe.cashRate, cashHits: pe.cashHits,
      avgActual: pe.avgActual, bestActual: pe.bestActual,
      avgOwnership: avgOwn, maxExposure: maxExp,
      uniqueStackTeams: stackTeams.size,
    });
  }
  pros.sort((a, b) => b.top1Rate - a.top1Rate);
  console.log(`    Pros detected: ${pros.length} (top: ${pros[0]?.username || 'n/a'} ${(pros[0]?.top1Rate * 100 || 0).toFixed(1)}%)`);

  return {
    slate: s.slate, entries: F, thresholds,
    old: oldEval, v2: v2Eval, v30: v30Eval, v31: v31Eval, v32: v32Eval, v30Mode2: v30m2Eval,
    pros,
    v32Diag: { avgOwn: v32AvgOwn, avgProj: v32AvgProj, distToCentroid: v32Dist },
    v31Diag: {
      avgOwn: v31AvgOwn,
      avgCorr: twin31.diagnostics.avgCorrelationAfter,
      negPairPct: twin31.diagnostics.negativePairFractionAfter,
      twins: twin31.diagnostics.actualTwinCount,
    },
    v30Diag: {
      avgCorr: twinRes.diagnostics.avgCorrelationAfter,
      negPairPct: twinRes.diagnostics.negativePairFractionAfter,
      twins: twinRes.diagnostics.actualTwinCount,
      lambdaDist,
    },
  };
}

function writeReport(results: SlateResult[]): void {
  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
  let md = `# MLB V30 Backtest — ${results.length} Slates\n\n`;
  md += `**OLD**: V24 pre-calibration (ρ=0.60, varFloor=top70%)\n`;
  md += `**V2**: V24 calibrated (ρ=0.18, no varFloor, ownKeep=0.80)\n`;
  md += `**V30**: λ-sweep [0.3,0.6,1.0,1.5,2.2,3.0] + evil twin hedging (25%)\n\n`;

  const tiers = ['top1', 'top5', 'top10', 'cash'] as const;
  const tierLabels = { top1: 'Top 1%', top5: 'Top 5%', top10: 'Top 10%', cash: 'Cash (top 20%)' };
  const tierRateKey = { top1: 'top1Rate', top5: 'top5Rate', top10: 'top10Rate', cash: 'cashRate' } as const;
  const tierHitsKey = { top1: 'top1Hits', top5: 'top5Hits', top10: 'top10Hits', cash: 'cashHits' } as const;

  for (const tier of tiers) {
    const rk = tierRateKey[tier];
    const hk = tierHitsKey[tier];
    md += `## ${tierLabels[tier]} rate\n\n`;
    md += `| Slate | Entries | OLD | V2 | V30 | V31 | **V32** |\n`;
    md += `|---|---:|---:|---:|---:|---:|---:|\n`;
    let oS = 0, v2S = 0, v30S = 0, v31S = 0, v32S = 0, n2 = 0;
    for (const r of results) {
      oS += r.old[rk]; v2S += r.v2[rk]; v30S += r.v30[rk]; v31S += r.v31[rk]; v32S += r.v32[rk]; n2++;
      md += `| ${r.slate} | ${r.entries.toLocaleString()} | ${pct(r.old[rk])} (${r.old[hk]}) | ${pct(r.v2[rk])} (${r.v2[hk]}) | ${pct(r.v30[rk])} (${r.v30[hk]}) | ${pct(r.v31[rk])} (${r.v31[hk]}) | **${pct(r.v32[rk])} (${r.v32[hk]})** |\n`;
    }
    md += `| **MEAN** | | **${pct(oS / n2)}** | **${pct(v2S / n2)}** | **${pct(v30S / n2)}** | **${pct(v31S / n2)}** | **${pct(v32S / n2)}** |\n\n`;
  }

  md += `## Avg actual score + ownership + centroid distance\n\n`;
  md += `| Slate | OLD | V30 | V31 (own) | **V32 (own / proj / dist)** |\n|---|---:|---:|---:|---:|\n`;
  for (const r of results) {
    md += `| ${r.slate} | ${r.old.avgActual.toFixed(1)} | ${r.v30.avgActual.toFixed(1)} | ${r.v31.avgActual.toFixed(1)} (${r.v31Diag.avgOwn.toFixed(1)}%) | **${r.v32.avgActual.toFixed(1)}** (${r.v32Diag.avgOwn.toFixed(1)}% / ${r.v32Diag.avgProj.toFixed(1)} / d=${r.v32Diag.distToCentroid.toFixed(2)}) |\n`;
  }
  md += `\n`;

  // ─── Pro comparison per slate ───
  md += `## Pro Comparison (per slate)\n\n`;
  for (const r of results) {
    if (r.pros.length === 0) continue;
    md += `### ${r.slate} (${r.entries.toLocaleString()} entries, ${r.pros.length} pros detected)\n\n`;
    md += `| Rank | Player | N | Top1% | Top5% | Cash% | AvgActual | Best | AvgOwn | MaxExp | Stacks |\n`;
    md += `|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n`;
    // Show top 10 pros + our selectors for comparison
    const topPros = r.pros.slice(0, 10);
    for (let i = 0; i < topPros.length; i++) {
      const p = topPros[i];
      md += `| ${i + 1} | ${p.username} | ${p.entries} | ${pct(p.top1Rate)} (${p.top1Hits}) | ${pct(p.top5Rate)} (${p.top5Hits}) | ${pct(p.cashRate)} | ${p.avgActual.toFixed(1)} | ${p.bestActual.toFixed(1)} | ${p.avgOwnership.toFixed(1)}% | ${pct(p.maxExposure)} | ${p.uniqueStackTeams} |\n`;
    }
    md += `| — | **V31 (ours)** | ${r.v31.scored} | **${pct(r.v31.top1Rate)} (${r.v31.top1Hits})** | **${pct(r.v31.top5Rate)} (${r.v31.top5Hits})** | **${pct(r.v31.cashRate)}** | ${r.v31.avgActual.toFixed(1)} | ${r.v31.bestActual.toFixed(1)} | ${r.v31Diag.avgOwn.toFixed(1)}% | — | — |\n`;
    md += `| — | V30 | ${r.v30.scored} | ${pct(r.v30.top1Rate)} (${r.v30.top1Hits}) | ${pct(r.v30.top5Rate)} (${r.v30.top5Hits}) | ${pct(r.v30.cashRate)} | ${r.v30.avgActual.toFixed(1)} | ${r.v30.bestActual.toFixed(1)} | — | — | — |\n`;
    md += `| — | OLD | ${r.old.scored} | ${pct(r.old.top1Rate)} (${r.old.top1Hits}) | ${pct(r.old.top5Rate)} (${r.old.top5Hits}) | ${pct(r.old.cashRate)} | ${r.old.avgActual.toFixed(1)} | ${r.old.bestActual.toFixed(1)} | — | — | — |\n\n`;
  }

  // ─── Cross-slate pro ranking (aggregate) ───
  const proAgg = new Map<string, { slates: number; t1: number; t5: number; cash: number; N: number; sumActual: number; sumOwn: number; sumMaxExp: number; sumStacks: number }>();
  for (const r of results) {
    for (const p of r.pros) {
      const ex = proAgg.get(p.username);
      if (ex) {
        ex.slates++; ex.t1 += p.top1Hits; ex.t5 += p.top5Hits; ex.cash += p.cashHits; ex.N += p.entries;
        ex.sumActual += p.avgActual * p.entries; ex.sumOwn += p.avgOwnership * p.entries;
        ex.sumMaxExp += p.maxExposure; ex.sumStacks += p.uniqueStackTeams;
      } else {
        proAgg.set(p.username, {
          slates: 1, t1: p.top1Hits, t5: p.top5Hits, cash: p.cashHits, N: p.entries,
          sumActual: p.avgActual * p.entries, sumOwn: p.avgOwnership * p.entries,
          sumMaxExp: p.maxExposure, sumStacks: p.uniqueStackTeams,
        });
      }
    }
  }
  // Only show pros on 3+ slates
  const crossPros = [...proAgg.entries()]
    .filter(([, v]) => v.slates >= 3)
    .sort((a, b) => (b[1].t1 / b[1].N) - (a[1].t1 / a[1].N))
    .slice(0, 15);

  if (crossPros.length > 0) {
    md += `## Cross-Slate Pro Rankings (≥3 slates)\n\n`;
    md += `| Pro | Slates | Entries | Top1% | Top5% | Cash% | AvgActual | AvgOwn | AvgMaxExp | AvgStacks |\n`;
    md += `|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n`;
    for (const [name, v] of crossPros) {
      md += `| ${name} | ${v.slates} | ${v.N} | ${pct(v.t1 / v.N)} (${v.t1}) | ${pct(v.t5 / v.N)} (${v.t5}) | ${pct(v.cash / v.N)} | ${(v.sumActual / v.N).toFixed(1)} | ${(v.sumOwn / v.N).toFixed(1)}% | ${pct(v.sumMaxExp / v.slates)} | ${(v.sumStacks / v.slates).toFixed(1)} |\n`;
    }
    // Add our selectors
    let oT1 = 0, oT5 = 0, oCash = 0, oN = 0, oAct = 0;
    let v30T1 = 0, v30T5 = 0, v30Cash = 0, v30N = 0, v30Act = 0;
    for (const r of results) {
      oT1 += r.old.top1Hits; oT5 += r.old.top5Hits; oCash += r.old.cashHits; oN += r.old.scored; oAct += r.old.avgActual * r.old.scored;
      v30T1 += r.v30.top1Hits; v30T5 += r.v30.top5Hits; v30Cash += r.v30.cashHits; v30N += r.v30.scored; v30Act += r.v30.avgActual * r.v30.scored;
    }
    md += `| **V30 (ours)** | ${results.length} | ${v30N} | **${pct(v30T1 / v30N)} (${v30T1})** | **${pct(v30T5 / v30N)} (${v30T5})** | **${pct(v30Cash / v30N)}** | ${(v30Act / v30N).toFixed(1)} | — | — | — |\n`;
    md += `| OLD | ${results.length} | ${oN} | ${pct(oT1 / oN)} (${oT1}) | ${pct(oT5 / oN)} (${oT5}) | ${pct(oCash / oN)} | ${(oAct / oN).toFixed(1)} | — | — | — |\n\n`;
  }

  md += `## V30 diagnostics\n\n`;
  md += `| Slate | AvgCorr | Neg% | Twins | λ distribution |\n`;
  md += `|---|---:|---:|---:|---|\n`;
  for (const r of results) {
    md += `| ${r.slate} | ${r.v30Diag.avgCorr.toFixed(3)} | ${(r.v30Diag.negPairPct * 100).toFixed(1)}% | ${r.v30Diag.twins} | ${r.v30Diag.lambdaDist} |\n`;
  }
  md += `\n`;

  fs.writeFileSync(OUT_PATH, md);
  console.log(`\n✓ Report: ${OUT_PATH}`);
}

async function main() {
  const results: SlateResult[] = [];
  for (const s of SLATES) {
    try {
      const r = await runSlate(s);
      if (r) results.push(r);
      else console.error(`  ⚠ ${s.slate} returned null`);
    } catch (err) {
      console.error(`  ❌ ${s.slate}: ${(err as Error).message}`);
      console.error((err as Error).stack);
    }
  }
  if (results.length === 0) { console.error('No results.'); process.exit(1); }
  console.log(`\n${results.length}/${SLATES.length} slates succeeded.`);
  writeReport(results);
}

main();
