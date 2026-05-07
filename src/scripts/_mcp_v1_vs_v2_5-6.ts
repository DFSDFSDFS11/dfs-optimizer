/**
 * V1-MCP (current) vs V1-MCP-v2 (per-size 3/4/5) on 5-6-26.
 *
 * v1 penalty: top-K=5 freqs from {2,3,4,5} pooled (pair-dominated by magnitude).
 * v2 penalty: top-3 triples + top-2 quads + top-1 quint (forces 3/4/5).
 *
 * Outputs side-by-side V1-NoCorr / MCP-v1 / MCP-v2 portfolio combo usage.
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
  W_PROJ: 1.0, W_LEV: 0.30, W_VAR: 0.15, W_CMB: 0.25, W_MULTI: 0.20,
  EXPOSURE_CAP_HITTER: 0.25, EXPOSURE_CAP_PITCHER: 0.45, TEAM_STACK_CAP: 0.20,
  BAND_HIGH_PCT: 0.20, BAND_LOW_PCT: 0.20, MAX_PAIRWISE_OVERLAP: 6,
  TRIPLE_FREQ_CAP: 5,
  PPD_LINEUP_PENALTY: 0.10, PPD_LINEUP_TOP_PCT: 0.10,
  TOP_K_V1: 5,                       // v1 spec
  V2_TOP_TRIPLES: 3, V2_TOP_QUADS: 2, V2_TOP_QUINTS: 1,  // v2 spec
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
  pen_v1: number; pen_v2: number;
  ppd: number; proj: number; range: number; ev: number;
  projPct: number; ownPct: number; rangePct: number; ppdPct: number;
  uniqPct: number; v1Pct: number; v2Pct: number;
}

async function main() {
  console.log('=== 5-6-26 V1-NoCorr vs MCP-v1 vs MCP-v2 ===\n');

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
  const playerTeamById = new Map<string, string>();
  const ownDecById = new Map<string, number>();
  const ownPctById = new Map<string, number>();
  for (const lu of candidates) for (const p of lu.players) {
    if (!playerNameById.has(p.id)) playerNameById.set(p.id, p.name);
    if (!playerTeamById.has(p.id)) playerTeamById.set(p.id, p.team || '');
    if (ownDecById.has(p.id)) continue;
    const adj = adjOwnById.get(p.id);
    const o = (adj !== undefined ? adj : (p.ownership || 0));
    ownPctById.set(p.id, o);
    ownDecById.set(p.id, Math.max(0, o / 100));
  }

  // V1-NoCorr pair/triple freqs (proj-weighted).
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

  // Score every candidate.
  const scored: S[] = [];
  let sizeMix = { pairs: 0, trips: 0, quads: 0, quints: 0 };
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

    // Collect freqs by size.
    const ids = players.map(p => p.id).sort();
    const pairs: { f: number; sz: number }[] = [];
    const trips: number[] = [], quads: number[] = [], quints: number[] = [];
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      pairs.push({ f: fcPair.get(ids[i] + '|' + ids[j]) ?? P.FIELD_FREQ_DEFAULT, sz: 2 });
      for (let l = j + 1; l < ids.length; l++) {
        trips.push(fcTrip.get(ids[i] + '|' + ids[j] + '|' + ids[l]) ?? P.FIELD_FREQ_DEFAULT);
        for (let m = l + 1; m < ids.length; m++) {
          quads.push(fcQuad.get(ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m]) ?? P.FIELD_FREQ_DEFAULT);
          for (let q = m + 1; q < ids.length; q++) {
            quints.push(fcQuint.get(ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m] + '|' + ids[q]) ?? P.FIELD_FREQ_DEFAULT);
          }
        }
      }
    }

    // v1 penalty: top-K=5 across all sizes pooled.
    const allFreqs: { f: number; sz: number }[] = [
      ...pairs,
      ...trips.map(f => ({ f, sz: 3 })),
      ...quads.map(f => ({ f, sz: 4 })),
      ...quints.map(f => ({ f, sz: 5 })),
    ];
    allFreqs.sort((a, b) => b.f - a.f);
    const top5_v1 = allFreqs.slice(0, P.TOP_K_V1);
    let prod_v1 = 1;
    for (const x of top5_v1) {
      prod_v1 *= x.f;
      if (x.sz === 2) sizeMix.pairs++;
      else if (x.sz === 3) sizeMix.trips++;
      else if (x.sz === 4) sizeMix.quads++;
      else sizeMix.quints++;
    }
    nLineups++;
    const pen_v1 = -Math.log(prod_v1 + P.LOG_EPSILON);

    // v2 penalty: per-size top-K (top-3 trips + top-2 quads + top-1 quint).
    trips.sort((a, b) => b - a);
    quads.sort((a, b) => b - a);
    quints.sort((a, b) => b - a);
    const sel_v2 = [
      ...trips.slice(0, P.V2_TOP_TRIPLES),
      ...quads.slice(0, P.V2_TOP_QUADS),
      ...quints.slice(0, P.V2_TOP_QUINTS),
    ];
    let prod_v2 = 1;
    for (const f of sel_v2) prod_v2 *= f;
    const pen_v2 = -Math.log(prod_v2 + P.LOG_EPSILON);

    let logOwn = 0;
    for (const p of lu.players) { if (isPitcher(p)) continue; logOwn += Math.log(Math.max(0.1, p.ownership || 0.5)); }
    let ppd = 0;
    for (const p of lu.players) if (p.salary && p.projection) ppd += p.projection / (p.salary / 1000);

    scored.push({ lu, primarySize, corrAdj, logOwn, uniqueness,
      pen_v1, pen_v2, ppd, proj: lu.projection, range: ceiling - floor,
      ev: 0, projPct: 0, ownPct: 0, rangePct: 0, ppdPct: 0, uniqPct: 0, v1Pct: 0, v2Pct: 0 });
  }

  console.log('SIZE COMPOSITION OF V1-MCP TOP-5 PENALTY (across ' + nLineups + ' lineups, ' + (nLineups * 5) + ' slots):');
  const tot = sizeMix.pairs + sizeMix.trips + sizeMix.quads + sizeMix.quints;
  console.log('  pairs:    ' + sizeMix.pairs + ' (' + (sizeMix.pairs / tot * 100).toFixed(1) + '%)');
  console.log('  triples:  ' + sizeMix.trips + ' (' + (sizeMix.trips / tot * 100).toFixed(1) + '%)');
  console.log('  quads:    ' + sizeMix.quads + ' (' + (sizeMix.quads / tot * 100).toFixed(1) + '%)');
  console.log('  quintets: ' + sizeMix.quints + ' (' + (sizeMix.quints / tot * 100).toFixed(1) + '%)');
  console.log('');

  const projAdj = scored.map(s => s.proj * (1 + s.corrAdj));
  const projPct = rankPercentile(projAdj);
  const ownPct = rankPercentile(scored.map(s => s.logOwn));
  const rangePct = rankPercentile(scored.map(s => s.range));
  const ppdPct = rankPercentile(scored.map(s => s.ppd));
  const uniqPct = rankPercentile(scored.map(s => s.uniqueness));
  const v1Pct = rankPercentile(scored.map(s => s.pen_v1));
  const v2Pct = rankPercentile(scored.map(s => s.pen_v2));
  for (let i = 0; i < scored.length; i++) {
    scored[i].projPct = projPct[i]; scored[i].ownPct = ownPct[i];
    scored[i].rangePct = rangePct[i]; scored[i].ppdPct = ppdPct[i];
    scored[i].uniqPct = uniqPct[i]; scored[i].v1Pct = v1Pct[i]; scored[i].v2Pct = v2Pct[i];
  }

  function evV1Plain(s: S) {
    let ev = P.W_PROJ * s.projPct + P.W_LEV * (1 - s.ownPct) + P.W_VAR * s.rangePct * 0.85 + P.W_CMB * s.uniqPct;
    if (s.ppdPct >= 1 - P.PPD_LINEUP_TOP_PCT) ev *= (1 - P.PPD_LINEUP_PENALTY);
    return ev;
  }
  function evMCPv1(s: S) { return evV1Plain(s) * (1 - 0) + P.W_MULTI * s.v1Pct - 0; /* compose */
    // Actually: need to apply PPD penalty BEFORE adding W_MULTI? The original spec adds W_MULTI to ev THEN applies PPD. Let's match. }
  }
  function evMCP(s: S, multiPct: number) {
    let ev = P.W_PROJ * s.projPct + P.W_LEV * (1 - s.ownPct) + P.W_VAR * s.rangePct * 0.85 + P.W_CMB * s.uniqPct + P.W_MULTI * multiPct;
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
  const mcpV1Sel = selectGreedy(scored, s => evMCP(s, s.v1Pct));
  const mcpV2Sel = selectGreedy(scored, s => evMCP(s, s.v2Pct));
  console.log('Selected: V1=' + v1Sel.length + ', MCP-v1=' + mcpV1Sel.length + ', MCP-v2=' + mcpV2Sel.length + '\n');

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
  const cMCP1 = countCombos(mcpV1Sel);
  const cMCP2 = countCombos(mcpV2Sel);

  function nameCombo(key: string): string {
    return key.split('|').map(id => `${(playerNameById.get(id) || id).slice(0, 14)}(${(ownPctById.get(id) || 0).toFixed(0)}%)`).join(' + ');
  }

  function reportSize(label: string, fc: Map<string, number>, mV1: Map<string, number>, mMCP1: Map<string, number>, mMCP2: Map<string, number>, topN: number) {
    console.log('================================================================');
    console.log('TOP ' + topN + ' MOST-USED ' + label + ' COMBOS IN V1-NoCorr');
    console.log('  ff       V1   MCPv1   MCPv2     combo');
    console.log('================================================================');
    const arr: { key: string; v1: number; mc1: number; mc2: number; ff: number }[] = [];
    for (const [k, c] of mV1) arr.push({ key: k, v1: c, mc1: mMCP1.get(k) || 0, mc2: mMCP2.get(k) || 0, ff: fc.get(k) || 0 });
    arr.sort((a, b) => b.v1 - a.v1);
    for (const x of arr.slice(0, topN)) {
      const d1 = x.mc1 - x.v1; const d2 = x.mc2 - x.v1;
      const fmt1 = (d1 < 0 ? '↓' + Math.abs(d1) : (d1 > 0 ? '↑' + d1 : ' ='));
      const fmt2 = (d2 < 0 ? '↓' + Math.abs(d2) : (d2 > 0 ? '↑' + d2 : ' ='));
      console.log('  ' + x.ff.toExponential(2) + '  ' + String(x.v1).padStart(2) + '  ' + String(x.mc1).padStart(3) + ' ' + fmt1.padStart(4) + '  ' + String(x.mc2).padStart(3) + ' ' + fmt2.padStart(4) + '   ' + nameCombo(x.key));
    }
    console.log('');
  }

  reportSize('TRIPLE', fcTrip, cV1.p3, cMCP1.p3, cMCP2.p3, 15);
  reportSize('QUAD',   fcQuad, cV1.p4, cMCP1.p4, cMCP2.p4, 15);
  reportSize('QUINT',  fcQuint, cV1.p5, cMCP1.p5, cMCP2.p5, 12);

  // Aggregate.
  function topConcByPortfolio(sel: S[], whichPen: 'v1' | 'v2'): { meanPen: number; max3: number; max4: number; max5: number; mean5conc: number; max5conc: number } {
    let penSum = 0;
    let max3 = 0, max4 = 0, max5 = 0;
    let mean5sum = 0, max5conc = 0;
    for (const s of sel) {
      penSum += whichPen === 'v1' ? s.pen_v1 : s.pen_v2;
      const ids = s.lu.players.map(p => p.id).sort();
      const n = ids.length;
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let l = j + 1; l < n; l++) {
        const f3 = fcTrip.get(ids[i] + '|' + ids[j] + '|' + ids[l]) ?? P.FIELD_FREQ_DEFAULT;
        if (f3 > max3) max3 = f3;
        for (let m = l + 1; m < n; m++) {
          const f4 = fcQuad.get(ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m]) ?? P.FIELD_FREQ_DEFAULT;
          if (f4 > max4) max4 = f4;
          for (let q = m + 1; q < n; q++) {
            const f5 = fcQuint.get(ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m] + '|' + ids[q]) ?? P.FIELD_FREQ_DEFAULT;
            if (f5 > max5) max5 = f5;
            mean5sum += f5;
          }
        }
      }
    }
    const c5_count = sel.length * 252;
    return { meanPen: penSum / sel.length, max3, max4, max5, mean5conc: mean5sum / c5_count, max5conc: max5 };
  }

  console.log('================================================================');
  console.log('PORTFOLIO-LEVEL FIELD CONCENTRATION (3/4/5-mans across the portfolio)');
  console.log('================================================================');
  for (const [label, sel, pen] of [['V1-NoCorr', v1Sel, 'v1'], ['MCP-v1', mcpV1Sel, 'v1'], ['MCP-v2', mcpV2Sel, 'v2']] as [string, S[], 'v1' | 'v2'][]) {
    const t = topConcByPortfolio(sel, pen);
    console.log('  ' + label.padEnd(11) + '  meanPen=' + t.meanPen.toFixed(2) +
      '  maxTrip=' + t.max3.toExponential(2) +
      '  maxQuad=' + t.max4.toExponential(2) +
      '  maxQuint=' + t.max5.toExponential(2));
  }
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
