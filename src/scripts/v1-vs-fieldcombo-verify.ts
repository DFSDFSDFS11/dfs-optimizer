/**
 * V1-NoCorr vs V1-FieldCombo verification harness.
 *
 * Loads a slate (5-5-26 by default) and computes BOTH V1-NoCorr's EV and
 * V1-FieldCombo's EV on the same candidate pool. Outputs:
 *   - field_freq_sanity.csv     — top-20 most-frequent pairs/triples/quads/quintets
 *   - saturation_ranges.csv     — distribution of sat_k & max_sat across pool
 *   - ranking_correlation.csv   — V1 vs FC EV per lineup, plus Pearson correlation
 *   - portfolio_comparison.csv  — V1-NoCorr vs FC portfolios (top 150 each by EV)
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
const OUT_DIR = path.join(DATA_DIR, 'field_combo_implementation', 'verification');
const PROJ_FILE = process.env.FC_PROJ_FILE || '5-5-26projections.csv';
const POOL_FILES = (process.env.FC_POOL_FILES || '5-5-26sspool.csv').split(',').map(s => s.trim());
const N = process.env.FC_TARGET_COUNT ? parseInt(process.env.FC_TARGET_COUNT, 10) : 150;

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

// V1-FC params.
const FC = {
  STACK_BONUS_PER_HITTER: 0,
  BRINGBACK_1: 0,
  BRINGBACK_2: 0,
  PITCHER_VS_HITTER_PENALTY: -0.10,
  W_PROJ: 1.0, W_LEV: 0.30, W_VAR: 0.15,
  W_CMB_AVG: 0.30, W_CMB_MAX: 0.20,
  COMBO_W2: 0.10, COMBO_W3: 0.20, COMBO_W4: 0.30, COMBO_W5: 0.40,
  PPD_LINEUP_PENALTY: 0.10, PPD_LINEUP_TOP_PCT: 0.10,
  SAT_MIN: 1e-12,
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
  console.log('Verifying V1-NoCorr vs V1-FieldCombo on slate: ' + PROJ_FILE);
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

  // ===== V1-NoCorr style pair/triple frequencies (from candidate pool) =====
  // (Used only to compute V1's combo uniqueness for ranking comparison.)
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

  // ===== V1-FC field combo frequencies (Adj Own product) =====
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

  // ===== Verification 1: field_freq_sanity.csv =====
  function topN<T>(map: Map<string, number>, n: number): { key: string; v: number }[] {
    const arr: { key: string; v: number }[] = [];
    for (const [k, v] of map) arr.push({ key: k, v });
    arr.sort((a, b) => b.v - a.v);
    return arr.slice(0, n);
  }
  function combo2Names(key: string): string {
    return key.split('|').map(id => `${playerNameById.get(id) || id} (${playerTeamById.get(id) || '?'})`).join(' + ');
  }
  const sanityLines: string[] = ['size,rank,player_combo,field_freq,player_ownerships'];
  for (const [size, m] of [[2, fcPair], [3, fcTrip], [4, fcQuad], [5, fcQuint]] as [number, Map<string, number>][]) {
    const top = topN(m, 20);
    top.forEach((t, i) => {
      const ids = t.key.split('|');
      const owns = ids.map(id => `${((ownDecById.get(id) || 0) * 100).toFixed(1)}%`).join(' / ');
      sanityLines.push(`${size},${i + 1},"${combo2Names(t.key)}",${t.v.toExponential(4)},"${owns}"`);
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
    corrAdj: number;
    logOwn: number;
    range: number;
    ppd: number;
    v1Uniq: number;
    sat_2: number; sat_3: number; sat_4: number; sat_5: number;
    max_sat: number;
    multi_uniq: number;
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

    // V1 uniqueness
    let v1Uniq = 0;
    const players = lu.players;
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const k = [players[i].id, players[j].id].sort().join('|');
        const f = v1PairFreq.get(k) || 1e-6;
        v1Uniq += -Math.log(f);
      }
    }
    const tripFs: { f: number }[] = [];
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        for (let l = j + 1; l < players.length; l++) {
          const tk = [players[i].id, players[j].id, players[l].id].sort().join('|');
          tripFs.push({ f: v1TripFreq.get(tk) || 1e-6 });
        }
      }
    }
    tripFs.sort((a, b) => b.f - a.f);
    for (const t of tripFs.slice(0, V1.TRIPLE_FREQ_CAP)) v1Uniq += -Math.log(t.f);

    // FC saturation
    const ids = players.map(p => p.id).sort();
    const pairs: number[] = [], triples: number[] = [], quads: number[] = [], quints: number[] = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        pairs.push(fcPair.get(ids[i] + '|' + ids[j]) ?? FC.FIELD_FREQ_DEFAULT);
        for (let l = j + 1; l < ids.length; l++) {
          triples.push(fcTrip.get(ids[i] + '|' + ids[j] + '|' + ids[l]) ?? FC.FIELD_FREQ_DEFAULT);
          for (let m = l + 1; m < ids.length; m++) {
            quads.push(fcQuad.get(ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m]) ?? FC.FIELD_FREQ_DEFAULT);
            for (let q = m + 1; q < ids.length; q++) {
              quints.push(fcQuint.get(ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m] + '|' + ids[q]) ?? FC.FIELD_FREQ_DEFAULT);
            }
          }
        }
      }
    }
    const sat_2 = mean(pairs), sat_3 = mean(triples), sat_4 = mean(quads), sat_5 = mean(quints);
    let max_sat = 0;
    for (const v of pairs) if (v > max_sat) max_sat = v;
    for (const v of triples) if (v > max_sat) max_sat = v;
    for (const v of quads) if (v > max_sat) max_sat = v;
    for (const v of quints) if (v > max_sat) max_sat = v;
    const ls = (x: number) => Math.log(Math.max(FC.SAT_MIN, x));
    const multi_uniq = FC.COMBO_W2 * (-ls(sat_2)) + FC.COMBO_W3 * (-ls(sat_3)) + FC.COMBO_W4 * (-ls(sat_4)) + FC.COMBO_W5 * (-ls(sat_5));

    rows.push({
      hash: lu.hash,
      proj: lu.projection,
      salary: lu.salary,
      primarySize,
      corrAdj,
      logOwn,
      range: ceiling - floor,
      ppd,
      v1Uniq,
      sat_2, sat_3, sat_4, sat_5, max_sat, multi_uniq,
    });
  }
  console.log('Scored ' + rows.length + ' lineups under both V1-NoCorr and V1-FC\n');

  // ===== Compute EVs =====
  const projAdj = rows.map(r => r.proj * (1 + r.corrAdj));
  const projPct = rankPercentile(projAdj);
  const ownPct = rankPercentile(rows.map(r => r.logOwn));
  const rangePct = rankPercentile(rows.map(r => r.range));
  const ppdPct = rankPercentile(rows.map(r => r.ppd));
  const v1UniqPct = rankPercentile(rows.map(r => r.v1Uniq));
  const multiUniqPct = rankPercentile(rows.map(r => r.multi_uniq));
  const maxSatPct = rankPercentile(rows.map(r => r.max_sat));

  const v1Ev: number[] = [];
  const fcEv: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    let ev1 = V1.W_PROJ * projPct[i] + V1.W_LEV * (1 - ownPct[i]) + V1.W_VAR * rangePct[i] * 0.85 + V1.W_CMB * v1UniqPct[i];
    if (ppdPct[i] >= 1 - V1.PPD_LINEUP_TOP_PCT) ev1 *= (1 - V1.PPD_LINEUP_PENALTY);
    let ev2 = FC.W_PROJ * projPct[i] + FC.W_LEV * (1 - ownPct[i]) + FC.W_VAR * rangePct[i] * 0.85
            + FC.W_CMB_AVG * multiUniqPct[i] - FC.W_CMB_MAX * maxSatPct[i];
    if (ppdPct[i] >= 1 - FC.PPD_LINEUP_TOP_PCT) ev2 *= (1 - FC.PPD_LINEUP_PENALTY);
    v1Ev.push(ev1);
    fcEv.push(ev2);
  }

  // ===== Verification 2: saturation_ranges.csv =====
  // Distribution of sat_k & max_sat across the candidate pool (V1-NoCorr's
  // would be the same set since it shares the pool).
  function distLine(label: string, vals: number[]): string {
    const sorted = [...vals].sort((a, b) => a - b);
    return [label,
      mean(vals).toExponential(4),
      stddev(vals).toExponential(4),
      sorted[0].toExponential(4),
      quantile(sorted, 0.25).toExponential(4),
      quantile(sorted, 0.50).toExponential(4),
      quantile(sorted, 0.75).toExponential(4),
      sorted[sorted.length - 1].toExponential(4),
    ].join(',');
  }
  const satLines = ['metric,mean,stddev,min,p25,p50,p75,max'];
  satLines.push(distLine('sat_2', rows.map(r => r.sat_2)));
  satLines.push(distLine('sat_3', rows.map(r => r.sat_3)));
  satLines.push(distLine('sat_4', rows.map(r => r.sat_4)));
  satLines.push(distLine('sat_5', rows.map(r => r.sat_5)));
  satLines.push(distLine('max_sat', rows.map(r => r.max_sat)));
  satLines.push(['multi_level_uniqueness',
    mean(rows.map(r => r.multi_uniq)).toFixed(4),
    stddev(rows.map(r => r.multi_uniq)).toFixed(4),
    Math.min(...rows.map(r => r.multi_uniq)).toFixed(4),
    quantile(rows.map(r => r.multi_uniq).sort((a, b) => a - b), 0.25).toFixed(4),
    quantile(rows.map(r => r.multi_uniq).sort((a, b) => a - b), 0.50).toFixed(4),
    quantile(rows.map(r => r.multi_uniq).sort((a, b) => a - b), 0.75).toFixed(4),
    Math.max(...rows.map(r => r.multi_uniq)).toFixed(4),
  ].join(','));
  fs.writeFileSync(path.join(OUT_DIR, 'saturation_ranges.csv'), satLines.join('\n'));
  console.log('Wrote saturation_ranges.csv');

  // ===== Verification 3: ranking_correlation.csv =====
  const r = pearson(v1Ev, fcEv);
  const corrLines: string[] = ['metric,value'];
  corrLines.push('pearson_v1_vs_fc,' + r.toFixed(4));
  corrLines.push('n_lineups,' + rows.length);
  corrLines.push('v1_ev_mean,' + mean(v1Ev).toFixed(4));
  corrLines.push('fc_ev_mean,' + mean(fcEv).toFixed(4));
  corrLines.push('v1_ev_std,' + stddev(v1Ev).toFixed(4));
  corrLines.push('fc_ev_std,' + stddev(fcEv).toFixed(4));
  // Spearman by ranking the EVs and computing pearson on ranks.
  const v1Rank = rankPercentile(v1Ev);
  const fcRank = rankPercentile(fcEv);
  corrLines.push('spearman_v1_vs_fc,' + pearson(v1Rank, fcRank).toFixed(4));
  fs.writeFileSync(path.join(OUT_DIR, 'ranking_correlation.csv'), corrLines.join('\n'));
  console.log('Wrote ranking_correlation.csv  (Pearson r = ' + r.toFixed(3) + ')');

  // ===== Verification 4: portfolio_comparison.csv =====
  // Top-N lineups by EV under each system (no exposure caps applied here —
  // this is a pure-ranking comparison of what each system VALUES most).
  const v1Order = rows.map((row, i) => ({ row, i, ev: v1Ev[i] })).sort((a, b) => b.ev - a.ev);
  const fcOrder = rows.map((row, i) => ({ row, i, ev: fcEv[i] })).sort((a, b) => b.ev - a.ev);
  const v1Top = v1Order.slice(0, N);
  const fcTop = fcOrder.slice(0, N);

  function portfolioStats(top: { row: Row; i: number; ev: number }[]): {
    meanProj: number; meanLogOwn: number; meanSal: number; meanRange: number;
    meanV1Uniq: number; meanMultiUniq: number; meanMaxSat: number;
    teamStackDist: Map<string, number>;
    playerExp: Map<string, number>;
  } {
    const meanProj = mean(top.map(t => t.row.proj));
    const meanLogOwn = mean(top.map(t => t.row.logOwn));
    const meanSal = mean(top.map(t => t.row.salary));
    const meanRange = mean(top.map(t => t.row.range));
    const meanV1Uniq = mean(top.map(t => t.row.v1Uniq));
    const meanMultiUniq = mean(top.map(t => t.row.multi_uniq));
    const meanMaxSat = mean(top.map(t => t.row.max_sat));
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
    return { meanProj, meanLogOwn, meanSal, meanRange, meanV1Uniq, meanMultiUniq, meanMaxSat, teamStackDist, playerExp };
  }
  const v1Stats = portfolioStats(v1Top);
  const fcStats = portfolioStats(fcTop);

  const portLines: string[] = ['metric,V1_NoCorr,V1_FieldCombo,delta'];
  portLines.push(['mean_projection', v1Stats.meanProj.toFixed(2), fcStats.meanProj.toFixed(2), (fcStats.meanProj - v1Stats.meanProj).toFixed(2)].join(','));
  portLines.push(['mean_log_ownership_sum', v1Stats.meanLogOwn.toFixed(3), fcStats.meanLogOwn.toFixed(3), (fcStats.meanLogOwn - v1Stats.meanLogOwn).toFixed(3)].join(','));
  portLines.push(['mean_salary', v1Stats.meanSal.toFixed(0), fcStats.meanSal.toFixed(0), (fcStats.meanSal - v1Stats.meanSal).toFixed(0)].join(','));
  portLines.push(['mean_range', v1Stats.meanRange.toFixed(2), fcStats.meanRange.toFixed(2), (fcStats.meanRange - v1Stats.meanRange).toFixed(2)].join(','));
  portLines.push(['mean_v1_uniq', v1Stats.meanV1Uniq.toFixed(2), fcStats.meanV1Uniq.toFixed(2), (fcStats.meanV1Uniq - v1Stats.meanV1Uniq).toFixed(2)].join(','));
  portLines.push(['mean_multi_level_uniq', v1Stats.meanMultiUniq.toFixed(2), fcStats.meanMultiUniq.toFixed(2), (fcStats.meanMultiUniq - v1Stats.meanMultiUniq).toFixed(2)].join(','));
  portLines.push(['mean_max_sat', v1Stats.meanMaxSat.toExponential(3), fcStats.meanMaxSat.toExponential(3), (fcStats.meanMaxSat - v1Stats.meanMaxSat).toExponential(3)].join(','));
  portLines.push('');
  portLines.push('TEAM_STACK_DISTRIBUTION,V1_NoCorr_count,V1_FieldCombo_count,delta');
  const allStackTeams = new Set<string>([...v1Stats.teamStackDist.keys(), ...fcStats.teamStackDist.keys()]);
  for (const t of [...allStackTeams].sort()) {
    const v = v1Stats.teamStackDist.get(t) || 0;
    const f = fcStats.teamStackDist.get(t) || 0;
    portLines.push([t, v, f, f - v].join(','));
  }
  portLines.push('');
  portLines.push('TOP_15_PLAYER_EXPOSURE_DELTAS,player_name,team,V1_count,FC_count,delta');
  const allPlayers = new Set<string>([...v1Stats.playerExp.keys(), ...fcStats.playerExp.keys()]);
  const playerDeltas: { id: string; v: number; f: number; delta: number }[] = [];
  for (const id of allPlayers) {
    const v = v1Stats.playerExp.get(id) || 0;
    const f = fcStats.playerExp.get(id) || 0;
    playerDeltas.push({ id, v, f, delta: f - v });
  }
  playerDeltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  for (const pd of playerDeltas.slice(0, 15)) {
    portLines.push(['', `"${(playerNameById.get(pd.id) || pd.id).replace(/"/g, "'")}"`, playerTeamById.get(pd.id) || '', pd.v, pd.f, pd.delta].join(','));
  }
  fs.writeFileSync(path.join(OUT_DIR, 'portfolio_comparison.csv'), portLines.join('\n'));
  console.log('Wrote portfolio_comparison.csv');

  console.log('\nSUMMARY');
  console.log('  Pearson(V1_EV, FC_EV) = ' + r.toFixed(3));
  console.log('  Mean V1 EV = ' + mean(v1Ev).toFixed(4));
  console.log('  Mean FC EV = ' + mean(fcEv).toFixed(4));
  console.log('  Top-' + N + ' V1: meanProj=' + v1Stats.meanProj.toFixed(1) + ' meanLogOwn=' + v1Stats.meanLogOwn.toFixed(2));
  console.log('  Top-' + N + ' FC: meanProj=' + fcStats.meanProj.toFixed(1) + ' meanLogOwn=' + fcStats.meanLogOwn.toFixed(2));
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });
