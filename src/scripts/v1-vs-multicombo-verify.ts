/**
 * V1-NoCorr vs V1-MultiComboPenalty verification harness.
 *
 * Loads a slate (5-5-26 by default) and computes BOTH V1-NoCorr's EV and
 * V1-MultiComboPenalty's EV on the same candidate pool. Outputs the four
 * verification artifacts mandated by Stage 3 of the spec:
 *
 *   - field_freq_sanity.csv      — top-20 most-frequent pairs/triples/quads/quintets
 *   - penalty_range_check.csv    — distribution of multi_combo_penalty + top-K
 *                                   product across the candidate pool
 *   - ranking_correlation.csv    — V1 vs MCP EV per lineup, plus Pearson +
 *                                   Spearman correlations
 *   - concentration_comparison.csv — V1-NoCorr vs MCP top-150 portfolios on
 *                                   multi-combo concentration metrics + top
 *                                   exposure deltas
 *
 * NOT used in production. Verification only.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as csvParse } from 'csv-parse/sync';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';

const DATA_DIR = 'C:/Users/colin/dfs opto';
const OUT_DIR = path.join(DATA_DIR, 'multi_combo_penalty_implementation', 'verification');
const PROJ_FILE = process.env.MCP_PROJ_FILE || '5-5-26projections.csv';
const POOL_FILES = (process.env.MCP_POOL_FILES || '5-5-26sspool.csv').split(',').map(s => s.trim());
const N = process.env.MCP_TARGET_COUNT ? parseInt(process.env.MCP_TARGET_COUNT, 10) : 150;

// V1-NoCorr params (production).
const V1 = {
  STACK_BONUS_PER_HITTER: 0,
  BRINGBACK_1: 0,
  BRINGBACK_2: 0,
  PITCHER_VS_HITTER_PENALTY: -0.10,
  MIN_PRIMARY_STACK: 4,
  W_PROJ: 1.0, W_LEV: 0.30, W_VAR: 0.15, W_CMB: 0.25,
  TRIPLE_FREQ_CAP: 5,
  PPD_LINEUP_PENALTY: 0.10, PPD_LINEUP_TOP_PCT: 0.10,
};

// Argus params (V1-MCP v3, W_MULTI=0.20, median-rescaled).
const MCP = {
  STACK_BONUS_PER_HITTER: 0,
  BRINGBACK_1: 0,
  BRINGBACK_2: 0,
  PITCHER_VS_HITTER_PENALTY: -0.10,
  W_PROJ: 1.0, W_LEV: 0.30, W_VAR: 0.15, W_CMB: 0.25, W_MULTI: 0.20,
  TRIPLE_FREQ_CAP: 5,
  PPD_LINEUP_PENALTY: 0.10, PPD_LINEUP_TOP_PCT: 0.10,
  TOP_K: 5,
  LOG_EPSILON: 1e-12,
  FIELD_FREQ_DEFAULT: 1e-9,
};

function isPitcher(p: Player): boolean { return (p.position || '').toUpperCase().includes('P'); }
function mean(a: number[]): number { if (!a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; }
function stddev(a: number[]): number { if (a.length < 2) return 0; const m = mean(a); let s = 0; for (const v of a) s += (v - m) * (v - m); return Math.sqrt(s / (a.length - 1)); }
function pearson(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length); if (n < 2) return 0;
  const mx = mean(x), my = mean(y);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = x[i] - mx, b = y[i] - my; num += a * b; dx += a * a; dy += b * b; }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
}
function rankPercentile(values: number[]): number[] {
  const idx = values.map((v, i) => ({ v, i }));
  idx.sort((a, b) => a.v - b.v);
  const out = new Array<number>(values.length);
  for (let r = 0; r < values.length; r++) out[idx[r].i] = values.length > 1 ? r / (values.length - 1) : 0;
  return out;
}
function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const idx = Math.floor(q * (sorted.length - 1));
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

function loadAdjOwn(projPath: string): Map<string, number> {
  const content = fs.readFileSync(projPath, 'utf-8');
  const records = csvParse(content, { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
  const out = new Map<string, number>();
  for (const r of records) {
    const id = (r['DFS ID'] || r['ID'] || '').toString().trim();
    if (!id) continue;
    const v = parseFloat((r['Adj Own'] || '').toString().replace(/[%,]/g, ''));
    if (!Number.isNaN(v)) out.set(id, Math.max(0, v));
  }
  return out;
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log('Verifying V1-NoCorr vs V1-MultiComboPenalty on slate: ' + PROJ_FILE);
  console.log('Output dir: ' + OUT_DIR + '\n');

  const projPath = path.join(DATA_DIR, PROJ_FILE);
  const pr = parseCSVFile(projPath, 'mlb', true);
  const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
  const pool = buildPlayerPool(pr.players, pr.detectedContestType);
  const adjOwnById = loadAdjOwn(projPath);
  const idMap = new Map<string, Player>();
  for (const p of pool.players) idMap.set(p.id, p);

  const merged = new Map<string, Lineup>();
  for (const pf of POOL_FILES) {
    const pp = path.join(DATA_DIR, pf);
    if (!fs.existsSync(pp)) { console.log('  Skip ' + pf); continue; }
    const loaded = loadPoolFromCSV({ filePath: pp, config, playerMap: idMap });
    for (const lu of loaded.lineups) if (!merged.has(lu.hash)) merged.set(lu.hash, lu);
  }
  const candidates = Array.from(merged.values());
  console.log('Candidate pool: ' + candidates.length + ' unique lineups\n');

  // ===== Player Adj Own decimal cache =====
  const playerNameById = new Map<string, string>();
  const playerTeamById = new Map<string, string>();
  const ownDecById = new Map<string, number>();
  for (const lu of candidates) {
    for (const p of lu.players) {
      if (!playerNameById.has(p.id)) playerNameById.set(p.id, p.name);
      if (!playerTeamById.has(p.id)) playerTeamById.set(p.id, p.team || '');
      if (ownDecById.has(p.id)) continue;
      const adj = adjOwnById.get(p.id);
      const o = (adj !== undefined ? adj : (p.ownership || 0)) / 100;
      ownDecById.set(p.id, Math.max(0, o));
    }
  }

  // ===== V1-NoCorr style pair/triple frequencies (projection-weighted, from candidate pool) =====
  // Used to compute V1's combo uniqueness (preserved in MCP scoring).
  const v1PairFreq = new Map<string, number>();
  const v1TripFreq = new Map<string, number>();
  let totalW = 0;
  for (const lu of candidates) {
    const w = Math.max(0.1, lu.projection || 1) ** 2;
    totalW += w;
    const ids = lu.players.map(p => p.id).sort();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        v1PairFreq.set(ids[i] + '|' + ids[j], (v1PairFreq.get(ids[i] + '|' + ids[j]) || 0) + w);
        for (let l = j + 1; l < ids.length; l++) {
          const k = ids[i] + '|' + ids[j] + '|' + ids[l];
          v1TripFreq.set(k, (v1TripFreq.get(k) || 0) + w);
        }
      }
    }
  }
  for (const k of v1PairFreq.keys()) v1PairFreq.set(k, v1PairFreq.get(k)! / totalW);
  for (const k of v1TripFreq.keys()) v1TripFreq.set(k, v1TripFreq.get(k)! / totalW);

  // ===== Field combo frequencies (Adj Own product, sizes 2-5) =====
  const fcPair = new Map<string, number>();
  const fcTrip = new Map<string, number>();
  const fcQuad = new Map<string, number>();
  const fcQuint = new Map<string, number>();
  for (const lu of candidates) {
    const ids = lu.players.map(p => p.id).sort();
    const n = ids.length;
    for (let i = 0; i < n; i++) {
      const oi = ownDecById.get(ids[i]) || 0;
      for (let j = i + 1; j < n; j++) {
        const oj = ownDecById.get(ids[j]) || 0;
        const k2 = ids[i] + '|' + ids[j];
        if (!fcPair.has(k2)) fcPair.set(k2, oi * oj);
        for (let l = j + 1; l < n; l++) {
          const ol = ownDecById.get(ids[l]) || 0;
          const k3 = ids[i] + '|' + ids[j] + '|' + ids[l];
          if (!fcTrip.has(k3)) fcTrip.set(k3, oi * oj * ol);
          for (let m = l + 1; m < n; m++) {
            const om = ownDecById.get(ids[m]) || 0;
            const k4 = ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m];
            if (!fcQuad.has(k4)) fcQuad.set(k4, oi * oj * ol * om);
            for (let q = m + 1; q < n; q++) {
              const oq = ownDecById.get(ids[q]) || 0;
              const k5 = ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m] + '|' + ids[q];
              if (!fcQuint.has(k5)) fcQuint.set(k5, oi * oj * ol * om * oq);
            }
          }
        }
      }
    }
  }

  // ===== Argus medians per size for chalk-ratio rescaling =====
  function mapMedian(m: Map<string, number>): number {
    if (m.size === 0) return 1;
    const arr: number[] = []; for (const v of m.values()) arr.push(v);
    arr.sort((a, b) => a - b); return arr[Math.floor(arr.length / 2)] || 1;
  }
  const med2 = mapMedian(fcPair);
  const med3 = mapMedian(fcTrip);
  const med4 = mapMedian(fcQuad);
  const med5 = mapMedian(fcQuint);

  // ===== Verification 1: field_freq_sanity.csv (top-20 per size) =====
  function topN<T>(map: Map<string, number>, n: number): { key: string; v: number }[] {
    const arr: { key: string; v: number }[] = [];
    for (const [k, v] of map) arr.push({ key: k, v });
    arr.sort((a, b) => b.v - a.v);
    return arr.slice(0, n);
  }
  function comboNames(key: string): string {
    return key.split('|').map(id => `${playerNameById.get(id) || id} (${playerTeamById.get(id) || '?'})`).join(' + ');
  }
  const sanityLines: string[] = ['size,rank,player_combo,field_freq,player_ownerships'];
  for (const [size, m] of [[2, fcPair], [3, fcTrip], [4, fcQuad], [5, fcQuint]] as [number, Map<string, number>][]) {
    const top = topN(m, 20);
    top.forEach((t, i) => {
      const ids = t.key.split('|');
      const owns = ids.map(id => `${((ownDecById.get(id) || 0) * 100).toFixed(1)}%`).join(' / ');
      sanityLines.push(`${size},${i + 1},"${comboNames(t.key)}",${t.v.toExponential(4)},"${owns}"`);
    });
  }
  fs.writeFileSync(path.join(OUT_DIR, 'field_freq_sanity.csv'), sanityLines.join('\n'));
  console.log('Wrote field_freq_sanity.csv (top 20 per size)');

  // ===== Score every candidate under both systems =====
  interface Row {
    hash: string;
    proj: number;
    salary: number;
    primarySize: number;
    primaryTeam: string;
    corrAdj: number;
    logOwn: number;
    range: number;
    ppd: number;
    v1Uniq: number;
    multi_penalty: number;
    top_concentration: number;
    max_freq: number;
  }
  const rows: Row[] = [];
  for (const lu of candidates) {
    let floor = 0, ceiling = 0;
    for (const p of lu.players) {
      if (p.percentiles) { floor += p.percentiles.p25 || p.projection * 0.85; ceiling += p.percentiles.p75 || p.projection * 1.15; }
      else { floor += p.projection * 0.85; ceiling += p.projection * 1.15; }
    }
    const teamHitters = new Map<string, number>();
    const pitchers: Player[] = [];
    for (const p of lu.players) {
      if (isPitcher(p)) pitchers.push(p);
      else { const t = (p.team || '').toUpperCase(); if (t) teamHitters.set(t, (teamHitters.get(t) || 0) + 1); }
    }
    let primarySize = 0, primaryTeam = '';
    for (const [t, c] of teamHitters) if (c > primarySize) { primarySize = c; primaryTeam = t; }
    let primaryOpp = '';
    for (const p of lu.players) if ((p.team || '').toUpperCase() === primaryTeam) { primaryOpp = (p.opponent || '').toUpperCase(); if (primaryOpp) break; }
    const bringBack = primaryOpp ? (teamHitters.get(primaryOpp) || 0) : 0;
    let pOppHitters = 0;
    for (const p of pitchers) { const o = (p.opponent || '').toUpperCase(); if (o) pOppHitters += teamHitters.get(o) || 0; }
    let corrAdj = 0;
    if (primarySize >= 3) corrAdj += V1.STACK_BONUS_PER_HITTER * (primarySize - 2);
    if (bringBack === 1) corrAdj += V1.BRINGBACK_1;
    else if (bringBack >= 2) corrAdj += V1.BRINGBACK_2;
    corrAdj += V1.PITCHER_VS_HITTER_PENALTY * pOppHitters;

    let logOwn = 0;
    for (const p of lu.players) { if (isPitcher(p)) continue; logOwn += Math.log(Math.max(0.1, p.ownership || 0.5)); }
    let ppd = 0;
    for (const p of lu.players) if (p.salary && p.projection) ppd += p.projection / (p.salary / 1000);

    // V1 uniqueness (preserved in MCP).
    let v1Uniq = 0;
    const players = lu.players;
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const k = [players[i].id, players[j].id].sort().join('|');
        v1Uniq += -Math.log(v1PairFreq.get(k) || 1e-6);
      }
    }
    const tripFs: number[] = [];
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        for (let l = j + 1; l < players.length; l++) {
          const tk = [players[i].id, players[j].id, players[l].id].sort().join('|');
          tripFs.push(v1TripFreq.get(tk) || 1e-6);
        }
      }
    }
    tripFs.sort((a, b) => b - a);
    for (const f of tripFs.slice(0, V1.TRIPLE_FREQ_CAP)) v1Uniq += -Math.log(f);

    // Argus multi-combo penalty (median-rescaled chalk-ratios).
    const ids = players.map(p => p.id).sort();
    const slots: { f: number; r: number }[] = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const f2 = fcPair.get(ids[i] + '|' + ids[j]) ?? MCP.FIELD_FREQ_DEFAULT;
        slots.push({ f: f2, r: f2 / med2 });
        for (let l = j + 1; l < ids.length; l++) {
          const f3 = fcTrip.get(ids[i] + '|' + ids[j] + '|' + ids[l]) ?? MCP.FIELD_FREQ_DEFAULT;
          slots.push({ f: f3, r: f3 / med3 });
          for (let m = l + 1; m < ids.length; m++) {
            const f4 = fcQuad.get(ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m]) ?? MCP.FIELD_FREQ_DEFAULT;
            slots.push({ f: f4, r: f4 / med4 });
            for (let q = m + 1; q < ids.length; q++) {
              const f5 = fcQuint.get(ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m] + '|' + ids[q]) ?? MCP.FIELD_FREQ_DEFAULT;
              slots.push({ f: f5, r: f5 / med5 });
            }
          }
        }
      }
    }
    slots.sort((a, b) => b.r - a.r);
    const topK = slots.slice(0, MCP.TOP_K);
    let prodR = 1, prodF = 1;
    for (const s of topK) { prodR *= s.r; prodF *= s.f; }
    const multi_penalty = -Math.log(prodR + MCP.LOG_EPSILON);
    const max_freq = slots.reduce((mx, s) => s.f > mx ? s.f : mx, 0);
    const top_concentration = prodF;

    rows.push({
      hash: lu.hash,
      proj: lu.projection,
      salary: lu.salary,
      primarySize,
      primaryTeam,
      corrAdj,
      logOwn,
      range: ceiling - floor,
      ppd,
      v1Uniq,
      multi_penalty,
      top_concentration,
      max_freq,
    });
  }
  console.log('Scored ' + rows.length + ' lineups under both V1-NoCorr and V1-MCP\n');

  // ===== Verification 2: penalty_range_check.csv =====
  function distLine(label: string, vals: number[], expFmt: boolean): string {
    const sorted = [...vals].sort((a, b) => a - b);
    const fmt = (x: number) => expFmt ? x.toExponential(4) : x.toFixed(4);
    return [label,
      fmt(mean(vals)),
      fmt(stddev(vals)),
      fmt(sorted[0]),
      fmt(quantile(sorted, 0.25)),
      fmt(quantile(sorted, 0.50)),
      fmt(quantile(sorted, 0.75)),
      fmt(sorted[sorted.length - 1]),
    ].join(',');
  }
  const penLines = ['metric,mean,stddev,min,p25,p50,p75,max'];
  penLines.push(distLine('multi_combo_penalty', rows.map(r => r.multi_penalty), false));
  penLines.push(distLine('top_K_concentration_product', rows.map(r => r.top_concentration), true));
  penLines.push(distLine('max_combo_freq', rows.map(r => r.max_freq), true));
  penLines.push(distLine('v1_uniqueness', rows.map(r => r.v1Uniq), false));
  fs.writeFileSync(path.join(OUT_DIR, 'penalty_range_check.csv'), penLines.join('\n'));
  console.log('Wrote penalty_range_check.csv');

  // Sanity: spot-check 5 lineups with highest concentration vs lowest.
  const sortedByConc = [...rows].sort((a, b) => b.top_concentration - a.top_concentration);
  console.log('  5 most-concentrated lineups (LOWEST penalty):');
  for (let i = 0; i < 5; i++) {
    const r = sortedByConc[i];
    console.log('    [' + i + '] proj=' + r.proj.toFixed(1) + ' penalty=' + r.multi_penalty.toFixed(3) + ' top5_prod=' + r.top_concentration.toExponential(2) + ' max_combo=' + r.max_freq.toExponential(2) + ' team=' + r.primaryTeam);
  }
  console.log('  5 most-diverse lineups (HIGHEST penalty):');
  for (let i = 0; i < 5; i++) {
    const r = sortedByConc[sortedByConc.length - 1 - i];
    console.log('    [' + i + '] proj=' + r.proj.toFixed(1) + ' penalty=' + r.multi_penalty.toFixed(3) + ' top5_prod=' + r.top_concentration.toExponential(2) + ' max_combo=' + r.max_freq.toExponential(2) + ' team=' + r.primaryTeam);
  }

  // ===== EVs =====
  const projAdj = rows.map(r => r.proj * (1 + r.corrAdj));
  const projPct = rankPercentile(projAdj);
  const ownPct = rankPercentile(rows.map(r => r.logOwn));
  const rangePct = rankPercentile(rows.map(r => r.range));
  const ppdPct = rankPercentile(rows.map(r => r.ppd));
  const uniqPct = rankPercentile(rows.map(r => r.v1Uniq));
  const multiPct = rankPercentile(rows.map(r => r.multi_penalty));

  const v1Ev: number[] = [];
  const mcpEv: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    let ev1 = V1.W_PROJ * projPct[i] + V1.W_LEV * (1 - ownPct[i]) + V1.W_VAR * rangePct[i] * 0.85 + V1.W_CMB * uniqPct[i];
    if (ppdPct[i] >= 1 - V1.PPD_LINEUP_TOP_PCT) ev1 *= (1 - V1.PPD_LINEUP_PENALTY);
    let ev2 = MCP.W_PROJ * projPct[i] + MCP.W_LEV * (1 - ownPct[i]) + MCP.W_VAR * rangePct[i] * 0.85
            + MCP.W_CMB * uniqPct[i] + MCP.W_MULTI * multiPct[i];
    if (ppdPct[i] >= 1 - MCP.PPD_LINEUP_TOP_PCT) ev2 *= (1 - MCP.PPD_LINEUP_PENALTY);
    v1Ev.push(ev1);
    mcpEv.push(ev2);
  }

  // ===== Verification 3: ranking_correlation.csv =====
  const r = pearson(v1Ev, mcpEv);
  const v1Rank = rankPercentile(v1Ev);
  const mcpRank = rankPercentile(mcpEv);
  const corrLines: string[] = ['metric,value'];
  corrLines.push('pearson_v1_vs_mcp,' + r.toFixed(4));
  corrLines.push('spearman_v1_vs_mcp,' + pearson(v1Rank, mcpRank).toFixed(4));
  corrLines.push('n_lineups,' + rows.length);
  corrLines.push('v1_ev_mean,' + mean(v1Ev).toFixed(4));
  corrLines.push('mcp_ev_mean,' + mean(mcpEv).toFixed(4));
  corrLines.push('v1_ev_std,' + stddev(v1Ev).toFixed(4));
  corrLines.push('mcp_ev_std,' + stddev(mcpEv).toFixed(4));
  fs.writeFileSync(path.join(OUT_DIR, 'ranking_correlation.csv'), corrLines.join('\n'));
  console.log('Wrote ranking_correlation.csv  (Pearson r = ' + r.toFixed(3) + ', Spearman = ' + pearson(v1Rank, mcpRank).toFixed(3) + ')');

  // ===== Verification 4: concentration_comparison.csv =====
  // Rank-based top-N comparison (no exposure caps applied — pure scoring delta).
  const v1Order = rows.map((row, i) => ({ row, i, ev: v1Ev[i] })).sort((a, b) => b.ev - a.ev);
  const mcpOrder = rows.map((row, i) => ({ row, i, ev: mcpEv[i] })).sort((a, b) => b.ev - a.ev);
  const v1Top = v1Order.slice(0, N);
  const mcpTop = mcpOrder.slice(0, N);

  function portfolioStats(top: { row: Row; i: number; ev: number }[]): {
    meanProj: number; meanLogOwn: number; meanSal: number; meanRange: number;
    meanV1Uniq: number; meanMultiPenalty: number; maxConcentration: number; meanConcentration: number; meanMaxFreq: number;
    teamStackDist: Map<string, number>;
    playerExp: Map<string, number>;
  } {
    const meanProj = mean(top.map(t => t.row.proj));
    const meanLogOwn = mean(top.map(t => t.row.logOwn));
    const meanSal = mean(top.map(t => t.row.salary));
    const meanRange = mean(top.map(t => t.row.range));
    const meanV1Uniq = mean(top.map(t => t.row.v1Uniq));
    const meanMultiPenalty = mean(top.map(t => t.row.multi_penalty));
    const meanConcentration = mean(top.map(t => t.row.top_concentration));
    const meanMaxFreq = mean(top.map(t => t.row.max_freq));
    let maxConcentration = 0;
    for (const t of top) if (t.row.top_concentration > maxConcentration) maxConcentration = t.row.top_concentration;
    const teamStackDist = new Map<string, number>();
    const playerExp = new Map<string, number>();
    for (const t of top) {
      const lu = candidates.find(l => l.hash === t.row.hash)!;
      const teamHitters = new Map<string, number>();
      for (const p of lu.players) {
        playerExp.set(p.id, (playerExp.get(p.id) || 0) + 1);
        if (isPitcher(p)) continue;
        const tt = (p.team || '').toUpperCase();
        if (tt) teamHitters.set(tt, (teamHitters.get(tt) || 0) + 1);
      }
      let primary = '', max = 0;
      for (const [tt, c] of teamHitters) if (c > max) { max = c; primary = tt; }
      if (max >= 4 && primary) teamStackDist.set(primary, (teamStackDist.get(primary) || 0) + 1);
    }
    return { meanProj, meanLogOwn, meanSal, meanRange, meanV1Uniq, meanMultiPenalty, maxConcentration, meanConcentration, meanMaxFreq, teamStackDist, playerExp };
  }
  const v1Stats = portfolioStats(v1Top);
  const mcpStats = portfolioStats(mcpTop);

  const portLines: string[] = ['metric,V1_NoCorr,V1_MCP,delta'];
  portLines.push(['mean_projection', v1Stats.meanProj.toFixed(2), mcpStats.meanProj.toFixed(2), (mcpStats.meanProj - v1Stats.meanProj).toFixed(2)].join(','));
  portLines.push(['mean_log_ownership_sum', v1Stats.meanLogOwn.toFixed(3), mcpStats.meanLogOwn.toFixed(3), (mcpStats.meanLogOwn - v1Stats.meanLogOwn).toFixed(3)].join(','));
  portLines.push(['mean_salary', v1Stats.meanSal.toFixed(0), mcpStats.meanSal.toFixed(0), (mcpStats.meanSal - v1Stats.meanSal).toFixed(0)].join(','));
  portLines.push(['mean_range', v1Stats.meanRange.toFixed(2), mcpStats.meanRange.toFixed(2), (mcpStats.meanRange - v1Stats.meanRange).toFixed(2)].join(','));
  portLines.push(['mean_v1_uniq', v1Stats.meanV1Uniq.toFixed(2), mcpStats.meanV1Uniq.toFixed(2), (mcpStats.meanV1Uniq - v1Stats.meanV1Uniq).toFixed(2)].join(','));
  portLines.push(['mean_multi_combo_penalty', v1Stats.meanMultiPenalty.toFixed(3), mcpStats.meanMultiPenalty.toFixed(3), (mcpStats.meanMultiPenalty - v1Stats.meanMultiPenalty).toFixed(3)].join(','));
  portLines.push(['mean_top5_concentration', v1Stats.meanConcentration.toExponential(3), mcpStats.meanConcentration.toExponential(3), (mcpStats.meanConcentration - v1Stats.meanConcentration).toExponential(3)].join(','));
  portLines.push(['max_top5_concentration', v1Stats.maxConcentration.toExponential(3), mcpStats.maxConcentration.toExponential(3), (mcpStats.maxConcentration - v1Stats.maxConcentration).toExponential(3)].join(','));
  portLines.push(['mean_max_combo_freq', v1Stats.meanMaxFreq.toExponential(3), mcpStats.meanMaxFreq.toExponential(3), (mcpStats.meanMaxFreq - v1Stats.meanMaxFreq).toExponential(3)].join(','));
  portLines.push('');
  portLines.push('TEAM_STACK_DISTRIBUTION,V1_NoCorr_count,V1_MCP_count,delta');
  const allStackTeams = new Set<string>([...v1Stats.teamStackDist.keys(), ...mcpStats.teamStackDist.keys()]);
  for (const t of [...allStackTeams].sort()) {
    const v = v1Stats.teamStackDist.get(t) || 0;
    const f = mcpStats.teamStackDist.get(t) || 0;
    portLines.push([t, v, f, f - v].join(','));
  }
  portLines.push('');
  portLines.push('TOP_15_PLAYER_EXPOSURE_DELTAS,player_name,team,V1_count,MCP_count,delta');
  const allPlayers = new Set<string>([...v1Stats.playerExp.keys(), ...mcpStats.playerExp.keys()]);
  const playerDeltas: { id: string; v: number; f: number; delta: number }[] = [];
  for (const id of allPlayers) {
    const v = v1Stats.playerExp.get(id) || 0;
    const f = mcpStats.playerExp.get(id) || 0;
    playerDeltas.push({ id, v, f, delta: f - v });
  }
  playerDeltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  for (const pd of playerDeltas.slice(0, 15)) {
    portLines.push(['', `"${(playerNameById.get(pd.id) || pd.id).replace(/"/g, "'")}"`, playerTeamById.get(pd.id) || '', pd.v, pd.f, pd.delta].join(','));
  }
  fs.writeFileSync(path.join(OUT_DIR, 'concentration_comparison.csv'), portLines.join('\n'));
  console.log('Wrote concentration_comparison.csv');

  console.log('\nSUMMARY');
  console.log('  Pearson(V1_EV, MCP_EV)  = ' + r.toFixed(3));
  console.log('  Spearman(V1_EV, MCP_EV) = ' + pearson(v1Rank, mcpRank).toFixed(3));
  console.log('  Top-' + N + ' V1:  meanProj=' + v1Stats.meanProj.toFixed(1) + ' meanLogOwn=' + v1Stats.meanLogOwn.toFixed(2) + ' maxTop5Conc=' + v1Stats.maxConcentration.toExponential(2));
  console.log('  Top-' + N + ' MCP: meanProj=' + mcpStats.meanProj.toFixed(1) + ' meanLogOwn=' + mcpStats.meanLogOwn.toFixed(2) + ' maxTop5Conc=' + mcpStats.maxConcentration.toExponential(2));
  console.log('  MCP\'s worst concentration ' + (mcpStats.maxConcentration < v1Stats.maxConcentration ? 'IS LESS extreme than V1\'s — penalty is working' : 'is NOT less extreme than V1\'s — verify scoring'));
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });
