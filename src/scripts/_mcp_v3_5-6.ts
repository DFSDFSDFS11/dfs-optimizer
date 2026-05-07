/**
 * V1-NoCorr vs MCP-v1(W=0.20) vs MCP-v1-W40(W=0.40) vs MCP-v3(median-rescaled, W=0.20)
 * vs MCP-v3-W40(median-rescaled, W=0.40) on 5-6-26.
 *
 * MCP-v3 penalty:
 *   For each combo c of size k in lineup: chalk_ratio_c = f_c / median_f_size_k
 *   (median_f_size_k computed across ALL candidate-pool combos of size k)
 *   Sort all 627 by chalk_ratio desc, take top-K=5, product, -log.
 *   This puts pairs/triples/quads/quints on comparable scales.
 *
 * Output: top 3/4/5-man combos in V1's portfolio with V1/MCPv1/MCPv1-W40/MCPv3/MCPv3-W40
 * usage side-by-side, plus portfolio-level max field freq per size.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as csvParse } from 'csv-parse/sync';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';

const DATA_DIR = 'C:/Users/colin/dfs opto';
const PROJ_FILE = process.env.SLATE_PROJ || '5-6-26projections.csv';
const POOL_FILE = process.env.SLATE_POOL || '5-6-26sspool.csv';
const N = 150;

const P = {
  PITCHER_VS_HITTER_PENALTY: -0.10, MIN_PRIMARY_STACK: 4,
  W_PROJ: 1.0, W_LEV: 0.30, W_VAR: 0.15, W_CMB: 0.25,
  EXPOSURE_CAP_HITTER: 0.25, EXPOSURE_CAP_PITCHER: 0.45, TEAM_STACK_CAP: 0.20,
  BAND_HIGH_PCT: 0.20, BAND_LOW_PCT: 0.20, MAX_PAIRWISE_OVERLAP: 6,
  TRIPLE_FREQ_CAP: 5,
  PPD_LINEUP_PENALTY: 0.10, PPD_LINEUP_TOP_PCT: 0.10,
  TOP_K: 5,
  LOG_EPSILON: 1e-12, FIELD_FREQ_DEFAULT: 1e-9,
};

function isPitcher(p: Player): boolean { return (p.position || '').toUpperCase().includes('P'); }
function rankPercentile(values: number[]): number[] {
  const idx = values.map((v, i) => ({ v, i }));
  idx.sort((a, b) => a.v - b.v);
  const out = new Array<number>(values.length);
  for (let r = 0; r < values.length; r++) out[idx[r].i] = values.length > 1 ? r / (values.length - 1) : 0;
  return out;
}
function median(arr: number[]): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function loadAdjOwn(p: string): Map<string, number> {
  const records = csvParse(fs.readFileSync(p, 'utf-8'), { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
  const out = new Map<string, number>();
  for (const r of records) {
    const id = (r['DFS ID'] || r['ID'] || '').trim();
    if (!id) continue;
    const v = parseFloat((r['Adj Own'] || '').replace(/[%,]/g, ''));
    if (!Number.isNaN(v)) out.set(id, Math.max(0, v));
  }
  return out;
}

interface S {
  lu: Lineup; primarySize: number; corrAdj: number; logOwn: number;
  uniqueness: number;
  pen_v1: number;       // pooled top-5, raw freq
  pen_v3: number;       // pooled top-5, median-rescaled freq
  ppd: number; proj: number; range: number; ev: number;
  projPct: number; ownPct: number; rangePct: number; ppdPct: number;
  uniqPct: number; v1Pct: number; v3Pct: number;
}

async function main() {
  console.log('=== 5-6-26  V1 vs MCP-v1(W20) vs MCP-v1-W40 vs MCP-v3(W20) vs MCP-v3-W40 ===\n');

  const projPath = path.join(DATA_DIR, PROJ_FILE);
  const poolPath = path.join(DATA_DIR, POOL_FILE);
  const pr = parseCSVFile(projPath, 'mlb', true);
  const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
  const pool = buildPlayerPool(pr.players, pr.detectedContestType);
  const adjOwnById = loadAdjOwn(projPath);
  const idMap = new Map<string, Player>();
  for (const p of pool.players) idMap.set(p.id, p);

  const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
  const candidates = Array.from(new Map(loaded.lineups.map(l => [l.hash, l])).values());
  console.log('Candidates: ' + candidates.length + '\n');

  const playerNameById = new Map<string, string>();
  const ownPctById = new Map<string, number>();
  const ownDecById = new Map<string, number>();
  for (const lu of candidates) for (const p of lu.players) {
    if (!playerNameById.has(p.id)) playerNameById.set(p.id, p.name);
    if (ownDecById.has(p.id)) continue;
    const adj = adjOwnById.get(p.id);
    const o = (adj !== undefined ? adj : (p.ownership || 0));
    ownPctById.set(p.id, o);
    ownDecById.set(p.id, Math.max(0, o / 100));
  }

  // V1 pair/triple freqs (proj-weighted) — for V1's W_CMB combo uniqueness.
  const v1Pair = new Map<string, number>();
  const v1Trip = new Map<string, number>();
  let totalW = 0;
  for (const lu of candidates) {
    const w = Math.max(0.1, lu.projection || 1) ** 2; totalW += w;
    const ids = lu.players.map(p => p.id).sort();
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      v1Pair.set(ids[i] + '|' + ids[j], (v1Pair.get(ids[i] + '|' + ids[j]) || 0) + w);
      for (let l = j + 1; l < ids.length; l++) {
        const k = ids[i] + '|' + ids[j] + '|' + ids[l];
        v1Trip.set(k, (v1Trip.get(k) || 0) + w);
      }
    }
  }
  for (const k of v1Pair.keys()) v1Pair.set(k, v1Pair.get(k)! / totalW);
  for (const k of v1Trip.keys()) v1Trip.set(k, v1Trip.get(k)! / totalW);

  // Field combo freqs (Adj Own product).
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

  // V3 normalization: median freq for each size across all candidate-pool combos.
  const med2 = median(Array.from(fcPair.values()));
  const med3 = median(Array.from(fcTrip.values()));
  const med4 = median(Array.from(fcQuad.values()));
  const med5 = median(Array.from(fcQuint.values()));
  console.log('Median freq per size: pair=' + med2.toExponential(2) + ' trip=' + med3.toExponential(2) +
              ' quad=' + med4.toExponential(2) + ' quint=' + med5.toExponential(2));
  // Max chalk-ratio (max f / median f) per size to confirm rescaling balances sizes.
  function mapMax(m: Map<string, number>): number { let mx = 0; for (const v of m.values()) if (v > mx) mx = v; return mx; }
  const maxPair = mapMax(fcPair);
  const maxTrip = mapMax(fcTrip);
  const maxQuad = mapMax(fcQuad);
  const maxQuint = mapMax(fcQuint);
  console.log('Max f / median f ratio: pair=' + (maxPair / med2).toFixed(0) + 'x  trip=' + (maxTrip / med3).toFixed(0) +
              'x  quad=' + (maxQuad / med4).toFixed(0) + 'x  quint=' + (maxQuint / med5).toFixed(0) + 'x\n');

  // Score every candidate.
  const scored: S[] = [];
  let v3SizeMix = { pairs: 0, trips: 0, quads: 0, quints: 0 };
  let nLineups = 0;
  for (const lu of candidates) {
    let floor = 0, ceiling = 0;
    for (const p of lu.players) {
      if (p.percentiles) { floor += p.percentiles.p25 || p.projection * 0.85; ceiling += p.percentiles.p75 || p.projection * 1.15; }
      else { floor += p.projection * 0.85; ceiling += p.projection * 1.15; }
    }
    const teamHitters = new Map<string, number>(); const pitchers: Player[] = [];
    for (const p of lu.players) {
      if (isPitcher(p)) pitchers.push(p);
      else { const t = (p.team || '').toUpperCase(); if (t) teamHitters.set(t, (teamHitters.get(t) || 0) + 1); }
    }
    let primaryTeam = '', primarySize = 0;
    for (const [t, c] of teamHitters) if (c > primarySize) { primarySize = c; primaryTeam = t; }
    let pOppHitters = 0;
    for (const pp of pitchers) { const o = (pp.opponent || '').toUpperCase(); if (o) pOppHitters += teamHitters.get(o) || 0; }
    const corrAdj = P.PITCHER_VS_HITTER_PENALTY * pOppHitters;

    let uniqueness = 0;
    const players = lu.players;
    for (let i = 0; i < players.length; i++) for (let j = i + 1; j < players.length; j++) {
      const k = [players[i].id, players[j].id].sort().join('|');
      uniqueness += -Math.log(v1Pair.get(k) || 1e-6);
    }
    const tripFs: number[] = [];
    for (let i = 0; i < players.length; i++) for (let j = i + 1; j < players.length; j++) for (let l = j + 1; l < players.length; l++) {
      const tk = [players[i].id, players[j].id, players[l].id].sort().join('|');
      tripFs.push(v1Trip.get(tk) || 1e-6);
    }
    tripFs.sort((a, b) => b - a);
    for (const f of tripFs.slice(0, P.TRIPLE_FREQ_CAP)) uniqueness += -Math.log(f);

    // Collect raw freqs and median-rescaled freqs by size.
    const ids = players.map(p => p.id).sort();
    interface Slot { f: number; ratio: number; sz: number }
    const slots: Slot[] = [];
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const f = fcPair.get(ids[i] + '|' + ids[j]) ?? P.FIELD_FREQ_DEFAULT;
      slots.push({ f, ratio: f / med2, sz: 2 });
      for (let l = j + 1; l < ids.length; l++) {
        const f3 = fcTrip.get(ids[i] + '|' + ids[j] + '|' + ids[l]) ?? P.FIELD_FREQ_DEFAULT;
        slots.push({ f: f3, ratio: f3 / med3, sz: 3 });
        for (let m = l + 1; m < ids.length; m++) {
          const f4 = fcQuad.get(ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m]) ?? P.FIELD_FREQ_DEFAULT;
          slots.push({ f: f4, ratio: f4 / med4, sz: 4 });
          for (let q = m + 1; q < ids.length; q++) {
            const f5 = fcQuint.get(ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m] + '|' + ids[q]) ?? P.FIELD_FREQ_DEFAULT;
            slots.push({ f: f5, ratio: f5 / med5, sz: 5 });
          }
        }
      }
    }

    // v1 penalty: top-K=5 by raw freq.
    const byF = [...slots].sort((a, b) => b.f - a.f).slice(0, P.TOP_K);
    let prod_v1 = 1;
    for (const x of byF) prod_v1 *= x.f;
    const pen_v1 = -Math.log(prod_v1 + P.LOG_EPSILON);

    // v3 penalty: top-K=5 by chalk_ratio (median-rescaled).
    const byR = [...slots].sort((a, b) => b.ratio - a.ratio).slice(0, P.TOP_K);
    let prod_v3 = 1;
    for (const x of byR) {
      prod_v3 *= x.ratio;
      if (x.sz === 2) v3SizeMix.pairs++;
      else if (x.sz === 3) v3SizeMix.trips++;
      else if (x.sz === 4) v3SizeMix.quads++;
      else v3SizeMix.quints++;
    }
    nLineups++;
    // For consistency convert chalk_ratio product to a leverage metric:
    //   prod_v3 ~ how chalky the top-5 chalkiest combos are (multiplicatively above median).
    //   penalty = -log(prod_v3 + eps): bigger = LESS chalky (more leverage). Same direction as v1.
    const pen_v3 = -Math.log(prod_v3 + P.LOG_EPSILON);

    let logOwn = 0;
    for (const p of lu.players) { if (isPitcher(p)) continue; logOwn += Math.log(Math.max(0.1, p.ownership || 0.5)); }
    let ppd = 0;
    for (const p of lu.players) if (p.salary && p.projection) ppd += p.projection / (p.salary / 1000);

    scored.push({ lu, primarySize, corrAdj, logOwn, uniqueness,
      pen_v1, pen_v3, ppd, proj: lu.projection, range: ceiling - floor,
      ev: 0, projPct: 0, ownPct: 0, rangePct: 0, ppdPct: 0, uniqPct: 0, v1Pct: 0, v3Pct: 0 });
  }

  console.log('SIZE COMPOSITION OF MCP-v3 TOP-5 PENALTY (across ' + nLineups + ' lineups, ' + (nLineups * 5) + ' slots):');
  const tot = v3SizeMix.pairs + v3SizeMix.trips + v3SizeMix.quads + v3SizeMix.quints;
  console.log('  pairs:    ' + v3SizeMix.pairs + ' (' + (v3SizeMix.pairs / tot * 100).toFixed(1) + '%)');
  console.log('  triples:  ' + v3SizeMix.trips + ' (' + (v3SizeMix.trips / tot * 100).toFixed(1) + '%)');
  console.log('  quads:    ' + v3SizeMix.quads + ' (' + (v3SizeMix.quads / tot * 100).toFixed(1) + '%)');
  console.log('  quintets: ' + v3SizeMix.quints + ' (' + (v3SizeMix.quints / tot * 100).toFixed(1) + '%)');
  console.log('');

  const projAdj = scored.map(s => s.proj * (1 + s.corrAdj));
  const projPct = rankPercentile(projAdj);
  const ownPct = rankPercentile(scored.map(s => s.logOwn));
  const rangePct = rankPercentile(scored.map(s => s.range));
  const ppdPct = rankPercentile(scored.map(s => s.ppd));
  const uniqPct = rankPercentile(scored.map(s => s.uniqueness));
  const v1Pct = rankPercentile(scored.map(s => s.pen_v1));
  const v3Pct = rankPercentile(scored.map(s => s.pen_v3));
  for (let i = 0; i < scored.length; i++) {
    scored[i].projPct = projPct[i]; scored[i].ownPct = ownPct[i];
    scored[i].rangePct = rangePct[i]; scored[i].ppdPct = ppdPct[i];
    scored[i].uniqPct = uniqPct[i]; scored[i].v1Pct = v1Pct[i]; scored[i].v3Pct = v3Pct[i];
  }
  // Pearson(v1Pct, v3Pct).
  const mp1 = v1Pct.reduce((a, b) => a + b, 0) / v1Pct.length;
  const mp3 = v3Pct.reduce((a, b) => a + b, 0) / v3Pct.length;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < v1Pct.length; i++) { const x = v1Pct[i] - mp1, y = v3Pct[i] - mp3; num += x * y; da += x * x; db += y * y; }
  const corr_v1_v3 = num / Math.sqrt(da * db);
  console.log('Pearson(v1_pen_pct, v3_pen_pct) = ' + corr_v1_v3.toFixed(3) + ' (lower = v3 reorders lineups more vs v1)\n');

  function evV1Plain(s: S) {
    let ev = P.W_PROJ * s.projPct + P.W_LEV * (1 - s.ownPct) + P.W_VAR * s.rangePct * 0.85 + P.W_CMB * s.uniqPct;
    if (s.ppdPct >= 1 - P.PPD_LINEUP_TOP_PCT) ev *= (1 - P.PPD_LINEUP_PENALTY);
    return ev;
  }
  function evMCP(s: S, multiPct: number, w: number) {
    let ev = P.W_PROJ * s.projPct + P.W_LEV * (1 - s.ownPct) + P.W_VAR * s.rangePct * 0.85 + P.W_CMB * s.uniqPct + w * multiPct;
    if (s.ppdPct >= 1 - P.PPD_LINEUP_TOP_PCT) ev *= (1 - P.PPD_LINEUP_PENALTY);
    return ev;
  }

  function selectGreedy(scored: S[], evFn: (s: S) => number): S[] {
    for (const s of scored) s.ev = evFn(s);
    let pool2 = scored.filter(s => s.primarySize >= P.MIN_PRIMARY_STACK);
    if (pool2.length < N) pool2 = scored;
    const sortedHigh = [...pool2].sort((a, b) => (b.projPct + b.ownPct) - (a.projPct + a.ownPct));
    const sortedLow = [...pool2].sort((a, b) => ((1 - b.projPct) + (1 - b.ownPct)) - ((1 - a.projPct) + (1 - a.ownPct)));
    const HIGH = Math.round(N * P.BAND_HIGH_PCT);
    const LOW = Math.round(N * P.BAND_LOW_PCT);
    const MID = N - HIGH - LOW;
    const sel: S[] = []; const exposure = new Map<string, number>(); const teamCount = new Map<string, number>(); const seen = new Set<string>();
    function primaryStackTeamOf(s: S): string {
      const tc = new Map<string, number>();
      for (const p of s.lu.players) {
        if (isPitcher(p)) continue; const t = (p.team || '').toUpperCase();
        if (t) tc.set(t, (tc.get(t) || 0) + 1);
      }
      let pri = '', max = 0; for (const [t, c] of tc) if (c > max) { max = c; pri = t; }
      return max >= 4 ? pri : '';
    }
    function passes(s: S, maxOv: number): boolean {
      if (seen.has(s.lu.hash)) return false;
      if (s.primarySize < P.MIN_PRIMARY_STACK) return false;
      for (const p of s.lu.players) {
        const cur = exposure.get(p.id) || 0;
        const cap = isPitcher(p) ? P.EXPOSURE_CAP_PITCHER : P.EXPOSURE_CAP_HITTER;
        if ((cur + 1) / N > cap) return false;
      }
      const st = primaryStackTeamOf(s);
      if (st && (((teamCount.get(st) || 0) + 1) / N > P.TEAM_STACK_CAP)) return false;
      const ids = new Set(s.lu.players.map(p => p.id));
      for (const x of sel) {
        let ov = 0; for (const p of x.lu.players) if (ids.has(p.id)) ov++;
        if (ov > maxOv) return false;
      }
      return true;
    }
    function add(s: S) {
      sel.push(s); seen.add(s.lu.hash);
      for (const p of s.lu.players) exposure.set(p.id, (exposure.get(p.id) || 0) + 1);
      const st = primaryStackTeamOf(s); if (st) teamCount.set(st, (teamCount.get(st) || 0) + 1);
    }
    function fill(bp: S[], target: number) {
      const sorted = [...bp].sort((a, b) => b.ev - a.ev);
      let added = 0;
      for (const s of sorted) { if (added >= target) break; if (passes(s, P.MAX_PAIRWISE_OVERLAP)) { add(s); added++; } }
      if (added < target) for (const s of sorted) { if (added >= target) break; if (passes(s, P.MAX_PAIRWISE_OVERLAP + 1)) { add(s); added++; } }
    }
    fill(sortedHigh.slice(0, Math.max(HIGH * 5, 200)), HIGH);
    fill(pool2, MID);
    fill(sortedLow.slice(0, Math.max(LOW * 5, 200)), LOW);
    if (sel.length < N) {
      const sorted = [...pool2].sort((a, b) => b.ev - a.ev);
      for (const s of sorted) { if (sel.length >= N) break; if (passes(s, P.MAX_PAIRWISE_OVERLAP + 1)) add(s); }
    }
    return sel.slice(0, N);
  }

  const v1Sel = selectGreedy(scored, evV1Plain);
  const mcp_v1_w20 = selectGreedy(scored, s => evMCP(s, s.v1Pct, 0.20));
  const mcp_v1_w40 = selectGreedy(scored, s => evMCP(s, s.v1Pct, 0.40));
  const mcp_v3_w20 = selectGreedy(scored, s => evMCP(s, s.v3Pct, 0.20));
  const mcp_v3_w40 = selectGreedy(scored, s => evMCP(s, s.v3Pct, 0.40));
  console.log('Selected: V1=' + v1Sel.length + '  v1_W20=' + mcp_v1_w20.length + '  v1_W40=' + mcp_v1_w40.length + '  v3_W20=' + mcp_v3_w20.length + '  v3_W40=' + mcp_v3_w40.length + '\n');

  function countCombos(sel: S[]) {
    const p3 = new Map<string, number>(), p4 = new Map<string, number>(), p5 = new Map<string, number>();
    for (const s of sel) {
      const ids = s.lu.players.map(p => p.id).sort();
      const n = ids.length;
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let l = j + 1; l < n; l++) {
        const k3 = ids[i] + '|' + ids[j] + '|' + ids[l]; p3.set(k3, (p3.get(k3) || 0) + 1);
        for (let m = l + 1; m < n; m++) {
          const k4 = ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m]; p4.set(k4, (p4.get(k4) || 0) + 1);
          for (let q = m + 1; q < n; q++) {
            const k5 = ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m] + '|' + ids[q]; p5.set(k5, (p5.get(k5) || 0) + 1);
          }
        }
      }
    }
    return { p3, p4, p5 };
  }
  const cV1 = countCombos(v1Sel);
  const c_v1_w20 = countCombos(mcp_v1_w20);
  const c_v1_w40 = countCombos(mcp_v1_w40);
  const c_v3_w20 = countCombos(mcp_v3_w20);
  const c_v3_w40 = countCombos(mcp_v3_w40);

  function nameCombo(key: string): string {
    return key.split('|').map(id => `${(playerNameById.get(id) || id).slice(0, 13)}(${(ownPctById.get(id) || 0).toFixed(0)}%)`).join(' + ');
  }

  function reportSize(label: string, fc: Map<string, number>, m1: Map<string, number>, m2: Map<string, number>, m3: Map<string, number>, m4: Map<string, number>, m5: Map<string, number>, topN: number) {
    console.log('================================================================');
    console.log('TOP ' + topN + ' MOST-USED ' + label + ' COMBOS IN V1-NoCorr');
    console.log('  ff       V1   v1W20   v1W40   v3W20   v3W40   combo');
    console.log('================================================================');
    const arr: { key: string; v1: number; a: number; b: number; c: number; d: number; ff: number }[] = [];
    for (const [k, v] of m1) arr.push({ key: k, v1: v, a: m2.get(k) || 0, b: m3.get(k) || 0, c: m4.get(k) || 0, d: m5.get(k) || 0, ff: fc.get(k) || 0 });
    arr.sort((a, b) => b.v1 - a.v1);
    function diffStr(d: number) { return d < 0 ? '↓' + Math.abs(d) : (d > 0 ? '↑' + d : ' ='); }
    for (const x of arr.slice(0, topN)) {
      const str = (n: number) => String(n).padStart(2);
      const ds = (d: number) => diffStr(d).padStart(4);
      console.log('  ' + x.ff.toExponential(2) + '  ' + str(x.v1) + '  ' + str(x.a) + ds(x.a - x.v1) + '  ' + str(x.b) + ds(x.b - x.v1) + '  ' + str(x.c) + ds(x.c - x.v1) + '  ' + str(x.d) + ds(x.d - x.v1) + '   ' + nameCombo(x.key));
    }
    console.log('');
  }

  reportSize('TRIPLE', fcTrip, cV1.p3, c_v1_w20.p3, c_v1_w40.p3, c_v3_w20.p3, c_v3_w40.p3, 12);
  reportSize('QUAD',   fcQuad, cV1.p4, c_v1_w20.p4, c_v1_w40.p4, c_v3_w20.p4, c_v3_w40.p4, 12);
  reportSize('QUINT',  fcQuint, cV1.p5, c_v1_w20.p5, c_v1_w40.p5, c_v3_w20.p5, c_v3_w40.p5, 10);

  // Portfolio-level max field freq per size.
  function portMax(sel: S[]) {
    let m3 = 0, m4 = 0, m5 = 0;
    for (const s of sel) {
      const ids = s.lu.players.map(p => p.id).sort();
      const n = ids.length;
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let l = j + 1; l < n; l++) {
        const f3 = fcTrip.get(ids[i] + '|' + ids[j] + '|' + ids[l]) ?? P.FIELD_FREQ_DEFAULT;
        if (f3 > m3) m3 = f3;
        for (let m = l + 1; m < n; m++) {
          const f4 = fcQuad.get(ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m]) ?? P.FIELD_FREQ_DEFAULT;
          if (f4 > m4) m4 = f4;
          for (let q = m + 1; q < n; q++) {
            const f5 = fcQuint.get(ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m] + '|' + ids[q]) ?? P.FIELD_FREQ_DEFAULT;
            if (f5 > m5) m5 = f5;
          }
        }
      }
    }
    return { m3, m4, m5 };
  }
  function portMeanOwnAndProj(sel: S[]) {
    let oSum = 0, pSum = 0; for (const s of sel) { oSum += s.lu.ownership; pSum += s.lu.projection; }
    return { meanOwn: oSum / sel.length, meanProj: pSum / sel.length };
  }
  console.log('================================================================');
  console.log('PORTFOLIO-LEVEL MAX FIELD FREQ PER SIZE');
  console.log('================================================================');
  console.log('  variant      meanProj  meanOwn   maxTrip    maxQuad    maxQuint');
  for (const [label, sel] of [['V1-NoCorr', v1Sel], ['MCP-v1-W20', mcp_v1_w20], ['MCP-v1-W40', mcp_v1_w40], ['MCP-v3-W20', mcp_v3_w20], ['MCP-v3-W40', mcp_v3_w40]] as [string, S[]][]) {
    const t = portMax(sel); const o = portMeanOwnAndProj(sel);
    console.log('  ' + label.padEnd(13) + ' ' + o.meanProj.toFixed(2).padStart(7) + '  ' + o.meanOwn.toFixed(2).padStart(6) + '  ' + t.m3.toExponential(2) + '  ' + t.m4.toExponential(2) + '  ' + t.m5.toExponential(2));
  }
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
