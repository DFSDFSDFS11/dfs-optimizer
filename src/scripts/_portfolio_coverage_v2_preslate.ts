/**
 * PortfolioCoverage-v2 pre-slate (production scoring path for tonight's slate).
 *
 * Replaces Argus-Atlas as the shipped MLB selector based on the 29-slate
 * validation (2026-05-12): v2 LOO ROI +169.12% vs Atlas baseline +75.05%,
 * LOO worst-drop +108% vs v1 +18.6%, Mahalanobis 1.290.
 *
 * Architecture:
 *   - T-copula sim (ν=5, 3000 worlds) with empirical-CDF marginals — matches
 *     the v1-sim-stats module used in validation
 *   - Greedy E[max(portfolio_score across worlds)] selection at top-K=3000 by
 *     V1 EV
 *   - Ownership regularizer: hybrid score blends coverage gain (rank pct)
 *     with movement toward target ownDelta = −7.2, weighted 80/20
 *   - V1-EV fallback for slots greedy can't fill due to exposure caps
 *
 * chalkAnchorOwn approximation:
 *   The 29-slate validation used the actual contest field's top-100
 *   highest-mean-ownership lineups. Preslate we don't have the field, so we
 *   proxy with top-100 highest-mean-ownership lineups from the merged
 *   SaberSim pool. This should overlap heavily with the actual chalk anchor
 *   since pool generation is field-aware.
 *
 * Env vars:
 *   COV_PROJ_FILE        default mlbdkprojpre.csv
 *   COV_POOL_FILES       default sspool1pre.csv,sspool2pre.csv,sspool3pre.csv
 *   COV_TARGET_COUNT     default 150
 *   COV_OUTPUT_TAG       default 'pcv2'
 *   COV_NUM_WORLDS       default 3000
 *   COV_TARGET_OWN_DELTA default -7.2
 *   COV_OWN_WEIGHT       default 0.20
 *   COV_PRE_FILTER_K     default 3000
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';
import { exportForDraftKings, exportDetailedLineups } from '../scoring';
import { THEORY_V1_NOCORR_PARAMS, isPitcher } from '../theory/v1-selector';
import { computeLineupSimStats } from '../theory/v1-sim-stats';
import { selectPortfolioCoverageV2Portfolio } from '../theory/v1-portfolio-coverage-v2-selector';
import { parse as csvParse } from 'csv-parse/sync';

const DIR = 'C:/Users/colin/dfs opto';
const PROJ_FILE = process.env.COV_PROJ_FILE || 'mlbdkprojpre.csv';
const POOL_FILES = (process.env.COV_POOL_FILES || 'sspool1pre.csv,sspool2pre.csv,sspool3pre.csv').split(',').map(s => s.trim()).filter(Boolean);
const N = process.env.COV_TARGET_COUNT ? parseInt(process.env.COV_TARGET_COUNT, 10) : 150;
const TAG = process.env.COV_OUTPUT_TAG || 'pcv2';
const TARGET_OWN_DELTA = process.env.COV_TARGET_OWN_DELTA ? parseFloat(process.env.COV_TARGET_OWN_DELTA) : -7.2;
const OWN_WEIGHT = process.env.COV_OWN_WEIGHT ? parseFloat(process.env.COV_OWN_WEIGHT) : 0.20;
const PRE_FILTER_K = process.env.COV_PRE_FILTER_K ? parseInt(process.env.COV_PRE_FILTER_K, 10) : 3000;
const DISABLE_REG = process.env.COV_DISABLE_REG === '1' || process.env.COV_DISABLE_REG === 'true';

function mean(a: number[]): number { if (!a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; }

// Mirror Atlas's projection-file Adj Own override.
function loadProjFile(p: string): { adjOwn: Map<string, number> } {
  const out = { adjOwn: new Map<string, number>() };
  if (!fs.existsSync(p)) return out;
  const records = csvParse(fs.readFileSync(p, 'utf-8'), { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
  for (const r of records) {
    const id = (r['DFS ID'] || r['ID'] || '').trim(); if (!id) continue;
    const adj = parseFloat((r['Adj Own'] || '').replace(/[%,]/g, ''));
    if (!Number.isNaN(adj)) out.adjOwn.set(id, Math.max(0, adj));
  }
  return out;
}

function lineupMeanOwn(lu: Lineup): number {
  if (!lu.players.length) return 0;
  let s = 0;
  for (const p of lu.players) s += (p.ownership || 0);
  return s / lu.players.length;
}

function computeChalkAnchorOwn(candidates: Lineup[]): number {
  // Proxy: top-100 highest-mean-ownership candidates in pool.
  const owns = candidates.map((lu, i) => ({ i, own: lineupMeanOwn(lu) }));
  owns.sort((a, b) => b.own - a.own);
  const topN = Math.min(100, owns.length);
  return mean(owns.slice(0, topN).map(x => x.own));
}

async function main() {
  console.log('================================================================');
  console.log('PortfolioCoverage-v2 pre-slate (greedy world-coverage + ownDelta reg)');
  console.log('================================================================');
  console.log(`Target N=${N}, top-K=${PRE_FILTER_K}, targetOwnDelta=${TARGET_OWN_DELTA}, ownWeight=${OWN_WEIGHT}\n`);

  // Projections + pool.
  const projPath = path.join(DIR, PROJ_FILE);
  if (!fs.existsSync(projPath)) { console.error(`Missing projections: ${projPath}`); process.exit(1); }
  const pr = parseCSVFile(projPath, 'mlb', true);
  const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
  const pool = buildPlayerPool(pr.players, pr.detectedContestType);
  const projData = loadProjFile(projPath);
  const idMap = new Map<string, Player>();
  for (const p of pool.players) {
    idMap.set(p.id, p);
    const adj = projData.adjOwn.get(p.id);
    p.ownership = (adj !== undefined ? adj : (p.ownership || 0));
  }
  const players = pool.players;
  console.log(`Slate: ${players.length} players`);

  // Merge candidate pools (dedupe by hash).
  const merged = new Map<string, Lineup>();
  let total = 0;
  for (const pf of POOL_FILES) {
    const pp = path.join(DIR, pf);
    if (!fs.existsSync(pp)) { console.log(`  Skip ${pf}: not found`); continue; }
    const loaded = loadPoolFromCSV({ filePath: pp, config, playerMap: idMap });
    total += loaded.lineups.length;
    for (const lu of loaded.lineups) if (!merged.has(lu.hash)) merged.set(lu.hash, lu);
    console.log(`  ${pf}: ${loaded.lineups.length} lineups`);
  }
  const candidates = Array.from(merged.values());
  console.log(`Merged: ${candidates.length} unique lineups (from ${total})\n`);

  if (candidates.length < N) {
    console.error(`Only ${candidates.length} unique lineups but target N=${N}. Aborting.`);
    process.exit(1);
  }

  // chalkAnchorOwn proxy.
  const chalkAnchorOwn = computeChalkAnchorOwn(candidates);
  console.log(`Computed chalkAnchorOwn (top-100 pool proxy): ${chalkAnchorOwn.toFixed(2)}%`);

  // T-copula sim + per-lineup world scores.
  console.log(`\n[1/3] T-copula sim + per-lineup stats...`);
  const t1 = Date.now();
  const simStats = computeLineupSimStats(candidates, players);
  console.log(`  done in ${((Date.now() - t1) / 1000).toFixed(1)}s — ${candidates.length} lineups × ${simStats.nWorlds} worlds`);

  // Greedy v2 selection.
  console.log(`\n[2/3] Greedy v2 (coverage + ownDelta reg + V1-EV fallback)...`);
  const t2 = Date.now();
  const selectorOpts = DISABLE_REG
    ? { preFilterTopK: PRE_FILTER_K, fallbackToV1: true }   // no chalkAnchorOwn = regularizer off
    : { chalkAnchorOwn, targetOwnDelta: TARGET_OWN_DELTA, ownDeltaWeight: OWN_WEIGHT, preFilterTopK: PRE_FILTER_K, fallbackToV1: true };
  if (DISABLE_REG) console.log(`(regularizer DISABLED via COV_DISABLE_REG)`);
  const result = selectPortfolioCoverageV2Portfolio(
    candidates, players, N, THEORY_V1_NOCORR_PARAMS, simStats,
    selectorOpts,
  );
  console.log(`  done in ${((Date.now() - t2) / 1000).toFixed(1)}s`);
  console.log(`  greedy picks=${result.diagnostics.greedyPicks}, fallback picks=${result.diagnostics.fallbackPicks}`);
  console.log(`  finalOwnDelta=${result.diagnostics.finalOwnDelta.toFixed(2)} (target ${TARGET_OWN_DELTA})`);
  console.log(`  maxWorldMean=${result.diagnostics.finalMaxWorldMean.toFixed(1)}, maxWorldStd=${result.diagnostics.finalMaxWorldStd.toFixed(1)}`);

  const selected = result.selected;
  if (selected.length < N) {
    console.warn(`WARNING: only filled ${selected.length}/${N} slots.`);
  }

  // Portfolio summary.
  const avgProj = mean(selected.map(l => l.projection));
  const avgOwn = mean(selected.map(l => lineupMeanOwn(l)));
  const avgSal = mean(selected.map(l => l.players.reduce((s, p) => s + (p.salary || 0), 0)));

  console.log('\n================================================================');
  console.log('PORTFOLIO STATS — PortfolioCoverage-v2');
  console.log('================================================================');
  console.log(`  Lineups:        ${selected.length}/${N}`);
  console.log(`  Avg projection: ${avgProj.toFixed(1)}`);
  console.log(`  Avg ownership:  ${avgOwn.toFixed(2)}%   (anchor ${chalkAnchorOwn.toFixed(2)}, delta ${(avgOwn - chalkAnchorOwn).toFixed(2)})`);
  console.log(`  Avg salary:     $${avgSal.toFixed(0)}`);

  // Team stack summary (4+ hitters).
  const stackSummary = new Map<string, number>();
  for (const lu of selected) {
    const tc = new Map<string, number>();
    for (const p of lu.players) {
      if (isPitcher(p)) continue;
      const t = (p.team || '').toUpperCase();
      tc.set(t, (tc.get(t) || 0) + 1);
    }
    for (const [t, c] of tc) if (c >= 4) stackSummary.set(t, (stackSummary.get(t) || 0) + 1);
  }
  console.log(`\n  Team stacks (4+ hitters):`);
  const sortedStacks = [...stackSummary.entries()].sort((a, b) => b[1] - a[1]);
  for (const [t, c] of sortedStacks) console.log(`    ${t.padEnd(6)} ${String(c).padStart(3)} lineups (${((c / selected.length) * 100).toFixed(0)}%)`);

  // Top 15 player exposures.
  const expByPlayer = new Map<string, { name: string; team: string; own: number; proj: number; count: number }>();
  for (const lu of selected) {
    for (const p of lu.players) {
      const k = p.id;
      const r = expByPlayer.get(k);
      if (r) r.count++; else expByPlayer.set(k, { name: p.name, team: p.team || '', own: p.ownership || 0, proj: p.projection || 0, count: 1 });
    }
  }
  console.log(`\n  Top 15 player exposures:`);
  const sortedExp = [...expByPlayer.values()].sort((a, b) => b.count - a.count).slice(0, 15);
  for (const r of sortedExp) console.log(`    ${r.name.padEnd(26)} ${r.team.padEnd(4)} ${((r.count / selected.length) * 100).toFixed(1).padStart(5)}% (${r.count}/${selected.length})  own=${r.own.toFixed(1)}%  proj=${r.proj.toFixed(1)}`);
  console.log(`  Unique players: ${expByPlayer.size}`);

  // Export.
  console.log(`\n[3/3] Export...`);
  const tagSuffix = TAG ? `_${TAG}` : '';
  const outDk = path.join(DIR, `theory_dfs_portfolio_coverage_v2_preslate_${selected.length}${tagSuffix}.csv`);
  const outDetail = path.join(DIR, `theory_dfs_portfolio_coverage_v2_preslate_${selected.length}${tagSuffix}_detailed.csv`);
  exportForDraftKings(selected, config, outDk);
  exportDetailedLineups(selected, config, outDetail);

  console.log('\n================================================================');
  console.log('DONE — PortfolioCoverage-v2 preslate');
  console.log('================================================================');
  console.log(`  DK upload: ${outDk}`);
  console.log(`  Detail:    ${outDetail}`);
}

main().catch(e => { console.error(e); process.exit(1); });
