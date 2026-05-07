/**
 * One-off analysis: on 5-6-26 slate, surface the most-commonly-used combos
 * in V1-NoCorr's portfolio, their field saturation (Adj Own product), and
 * how many of those appearances V1-MCP demoted.
 *
 * Output:
 *   - top-20 most-saturated combos at each size (size 2,3,4,5) with V1
 *     and MCP portfolio counts
 *   - top-20 combos with the largest V1→MCP demotion (V1_count - MCP_count)
 *
 * Reads only — no files written.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as csvParse } from 'csv-parse/sync';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';

const DATA_DIR = 'C:/Users/colin/dfs opto';
const PROJ_FILE = process.env.SLATE_PROJ || '5-5-26projections.csv';
const POOL_FILE = process.env.SLATE_POOL || '5-5-26sspool.csv';
const N = 150;

const PARAMS = {
  STACK_BONUS_PER_HITTER: 0, BRINGBACK_1: 0, BRINGBACK_2: 0,
  PITCHER_VS_HITTER_PENALTY: -0.10, MIN_PRIMARY_STACK: 4,
  W_PROJ: 1.0, W_LEV: 0.30, W_VAR: 0.15, W_CMB: 0.25, W_MULTI: 0.20,
  EXPOSURE_CAP_HITTER: 0.25, EXPOSURE_CAP_PITCHER: 0.45,
  TEAM_STACK_CAP: 0.20,
  BAND_HIGH_PCT: 0.20, BAND_MID_PCT: 0.60, BAND_LOW_PCT: 0.20,
  MAX_PAIRWISE_OVERLAP: 6, TRIPLE_FREQ_CAP: 5,
  PPD_LINEUP_PENALTY: 0.10, PPD_LINEUP_TOP_PCT: 0.10,
  TOP_K: 5, LOG_EPSILON: 1e-12, FIELD_FREQ_DEFAULT: 1e-9,
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
  uniqueness: number; multi_penalty: number; ppd: number;
  proj: number; range: number; ev: number;
  projPct: number; ownPct: number; rangePct: number; ppdPct: number;
  uniqPct: number; multiPct: number;
}

async function main() {
  console.log('=== 5-6-26 combo-demotion analysis ===\n');

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
  console.log('Field combo freqs: pairs=' + fcPair.size + ' trips=' + fcTrip.size + ' quads=' + fcQuad.size + ' quints=' + fcQuint.size + '\n');

  // Score every candidate.
  const scored: S[] = [];
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
    let primaryOpp = '';
    for (const p of lu.players) if ((p.team || '').toUpperCase() === primaryTeam) { primaryOpp = (p.opponent || '').toUpperCase(); if (primaryOpp) break; }
    const bringBack = primaryOpp ? (teamHitters.get(primaryOpp) || 0) : 0;
    let pOppHitters = 0;
    for (const p of pitchers) { const o = (p.opponent || '').toUpperCase(); if (o) pOppHitters += teamHitters.get(o) || 0; }
    let corrAdj = PARAMS.PITCHER_VS_HITTER_PENALTY * pOppHitters;

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
    for (const f of tripFs.slice(0, PARAMS.TRIPLE_FREQ_CAP)) uniqueness += -Math.log(f);

    const ids = players.map(p => p.id).sort();
    const allF: number[] = [];
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      allF.push(fcPair.get(ids[i] + '|' + ids[j]) ?? PARAMS.FIELD_FREQ_DEFAULT);
      for (let l = j + 1; l < ids.length; l++) {
        allF.push(fcTrip.get(ids[i] + '|' + ids[j] + '|' + ids[l]) ?? PARAMS.FIELD_FREQ_DEFAULT);
        for (let m = l + 1; m < ids.length; m++) {
          allF.push(fcQuad.get(ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m]) ?? PARAMS.FIELD_FREQ_DEFAULT);
          for (let q = m + 1; q < ids.length; q++) {
            allF.push(fcQuint.get(ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m] + '|' + ids[q]) ?? PARAMS.FIELD_FREQ_DEFAULT);
          }
        }
      }
    }
    allF.sort((a, b) => b - a);
    let prod = 1; for (const f of allF.slice(0, PARAMS.TOP_K)) prod *= f;
    const multi_penalty = -Math.log(prod + PARAMS.LOG_EPSILON);

    let logOwn = 0;
    for (const p of lu.players) { if (isPitcher(p)) continue; logOwn += Math.log(Math.max(0.1, p.ownership || 0.5)); }
    let ppd = 0;
    for (const p of lu.players) if (p.salary && p.projection) ppd += p.projection / (p.salary / 1000);

    scored.push({ lu, primarySize, corrAdj, logOwn, uniqueness, multi_penalty, ppd,
      proj: lu.projection, range: ceiling - floor, ev: 0,
      projPct: 0, ownPct: 0, rangePct: 0, ppdPct: 0, uniqPct: 0, multiPct: 0 });
  }

  const projAdj = scored.map(s => s.proj * (1 + s.corrAdj));
  const projPct = rankPercentile(projAdj);
  const ownPct = rankPercentile(scored.map(s => s.logOwn));
  const rangePct = rankPercentile(scored.map(s => s.range));
  const ppdPct = rankPercentile(scored.map(s => s.ppd));
  const uniqPct = rankPercentile(scored.map(s => s.uniqueness));
  const multiPct = rankPercentile(scored.map(s => s.multi_penalty));
  for (let i = 0; i < scored.length; i++) {
    scored[i].projPct = projPct[i]; scored[i].ownPct = ownPct[i];
    scored[i].rangePct = rangePct[i]; scored[i].ppdPct = ppdPct[i];
    scored[i].uniqPct = uniqPct[i]; scored[i].multiPct = multiPct[i];
  }

  function evV1(s: S): number {
    let ev = PARAMS.W_PROJ * s.projPct + PARAMS.W_LEV * (1 - s.ownPct) + PARAMS.W_VAR * s.rangePct * 0.85 + PARAMS.W_CMB * s.uniqPct;
    if (s.ppdPct >= 1 - PARAMS.PPD_LINEUP_TOP_PCT) ev *= (1 - PARAMS.PPD_LINEUP_PENALTY);
    return ev;
  }
  function evMCP(s: S): number {
    let ev = PARAMS.W_PROJ * s.projPct + PARAMS.W_LEV * (1 - s.ownPct) + PARAMS.W_VAR * s.rangePct * 0.85 + PARAMS.W_CMB * s.uniqPct + PARAMS.W_MULTI * s.multiPct;
    if (s.ppdPct >= 1 - PARAMS.PPD_LINEUP_TOP_PCT) ev *= (1 - PARAMS.PPD_LINEUP_PENALTY);
    return ev;
  }

  function selectGreedy(scored: S[], evFn: (s: S) => number): S[] {
    for (const s of scored) s.ev = evFn(s);
    let pool2 = scored.filter(s => s.primarySize >= PARAMS.MIN_PRIMARY_STACK);
    if (pool2.length < N) pool2 = scored;
    const sortedHigh = [...pool2].sort((a, b) => (b.projPct + b.ownPct) - (a.projPct + a.ownPct));
    const sortedLow = [...pool2].sort((a, b) => ((1 - b.projPct) + (1 - b.ownPct)) - ((1 - a.projPct) + (1 - a.ownPct)));
    const HIGH = Math.round(N * PARAMS.BAND_HIGH_PCT);
    const LOW = Math.round(N * PARAMS.BAND_LOW_PCT);
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
      if (s.primarySize < PARAMS.MIN_PRIMARY_STACK) return false;
      for (const p of s.lu.players) {
        const cur = exposure.get(p.id) || 0;
        const cap = isPitcher(p) ? PARAMS.EXPOSURE_CAP_PITCHER : PARAMS.EXPOSURE_CAP_HITTER;
        if ((cur + 1) / N > cap) return false;
      }
      const st = primaryStackTeamOf(s);
      if (st && (((teamCount.get(st) || 0) + 1) / N > PARAMS.TEAM_STACK_CAP)) return false;
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
      for (const s of sorted) { if (added >= target) break; if (passes(s, PARAMS.MAX_PAIRWISE_OVERLAP)) { add(s); added++; } }
      if (added < target) for (const s of sorted) { if (added >= target) break; if (passes(s, PARAMS.MAX_PAIRWISE_OVERLAP + 1)) { add(s); added++; } }
    }
    fill(sortedHigh.slice(0, Math.max(HIGH * 5, 200)), HIGH);
    fill(pool2, MID);
    fill(sortedLow.slice(0, Math.max(LOW * 5, 200)), LOW);
    if (sel.length < N) {
      const sorted = [...pool2].sort((a, b) => b.ev - a.ev);
      for (const s of sorted) { if (sel.length >= N) break; if (passes(s, PARAMS.MAX_PAIRWISE_OVERLAP + 1)) add(s); }
    }
    return sel.slice(0, N);
  }

  const v1Sel = selectGreedy(scored, evV1);
  const mcpSel = selectGreedy(scored, evMCP);
  console.log('V1 selected: ' + v1Sel.length + ', MCP selected: ' + mcpSel.length + '\n');

  // Count combo appearances in V1 and MCP portfolios.
  function countCombosInPortfolio(sel: S[]): { p2: Map<string, number>; p3: Map<string, number>; p4: Map<string, number>; p5: Map<string, number> } {
    const p2 = new Map<string, number>(), p3 = new Map<string, number>(), p4 = new Map<string, number>(), p5 = new Map<string, number>();
    for (const s of sel) {
      const ids = s.lu.players.map(p => p.id).sort();
      const n = ids.length;
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        const k2 = ids[i] + '|' + ids[j]; p2.set(k2, (p2.get(k2) || 0) + 1);
        for (let l = j + 1; l < n; l++) {
          const k3 = ids[i] + '|' + ids[j] + '|' + ids[l]; p3.set(k3, (p3.get(k3) || 0) + 1);
          for (let m = l + 1; m < n; m++) {
            const k4 = ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m]; p4.set(k4, (p4.get(k4) || 0) + 1);
            for (let q = m + 1; q < n; q++) {
              const k5 = ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m] + '|' + ids[q]; p5.set(k5, (p5.get(k5) || 0) + 1);
            }
          }
        }
      }
    }
    return { p2, p3, p4, p5 };
  }
  const v1C = countCombosInPortfolio(v1Sel);
  const mcpC = countCombosInPortfolio(mcpSel);

  function nameCombo(key: string): string {
    return key.split('|').map(id => `${playerNameById.get(id) || id}(${playerTeamById.get(id) || '?'},${(ownPctById.get(id) || 0).toFixed(0)}%)`).join(' + ');
  }

  function reportTopByV1(label: string, v1m: Map<string, number>, mcpm: Map<string, number>, fc: Map<string, number>, topN: number) {
    console.log('================================================================');
    console.log('TOP ' + topN + ' MOST-USED ' + label + ' COMBOS IN V1 PORTFOLIO');
    console.log('  (sorted by V1 count desc; shows field_freq + MCP usage delta)');
    console.log('================================================================');
    const arr: { key: string; v1: number; mcp: number; ff: number }[] = [];
    for (const [k, c] of v1m) arr.push({ key: k, v1: c, mcp: mcpm.get(k) || 0, ff: fc.get(k) || 0 });
    arr.sort((a, b) => b.v1 - a.v1);
    for (const x of arr.slice(0, topN)) {
      const delta = x.mcp - x.v1;
      const arrow = delta < 0 ? '↓' + Math.abs(delta) : (delta > 0 ? '↑' + delta : '=');
      console.log(`  V1=${String(x.v1).padStart(3)}  MCP=${String(x.mcp).padStart(3)} ${arrow.padStart(5)}  ff=${x.ff.toExponential(2)}  ${nameCombo(x.key)}`);
    }
    console.log('');
  }
  function reportTopDemoted(label: string, v1m: Map<string, number>, mcpm: Map<string, number>, fc: Map<string, number>, topN: number, minV1: number) {
    console.log('================================================================');
    console.log('TOP ' + topN + ' MOST-DEMOTED ' + label + ' COMBOS (V1≥' + minV1 + ')');
    console.log('  (sorted by V1−MCP usage delta desc)');
    console.log('================================================================');
    const arr: { key: string; v1: number; mcp: number; ff: number; demote: number }[] = [];
    for (const [k, c] of v1m) {
      if (c < minV1) continue;
      const m = mcpm.get(k) || 0;
      arr.push({ key: k, v1: c, mcp: m, ff: fc.get(k) || 0, demote: c - m });
    }
    arr.sort((a, b) => b.demote - a.demote);
    for (const x of arr.slice(0, topN)) {
      console.log(`  V1=${String(x.v1).padStart(3)}  MCP=${String(x.mcp).padStart(3)}  ↓${String(x.demote).padStart(3)}  ff=${x.ff.toExponential(2)}  ${nameCombo(x.key)}`);
    }
    console.log('');
  }

  reportTopByV1('SIZE-2 (PAIR)', v1C.p2, mcpC.p2, fcPair, 15);
  reportTopByV1('SIZE-3 (TRIPLE)', v1C.p3, mcpC.p3, fcTrip, 15);
  reportTopByV1('SIZE-4', v1C.p4, mcpC.p4, fcQuad, 15);
  reportTopByV1('SIZE-5', v1C.p5, mcpC.p5, fcQuint, 15);

  reportTopDemoted('SIZE-2 (PAIR)', v1C.p2, mcpC.p2, fcPair, 15, 30);
  reportTopDemoted('SIZE-3 (TRIPLE)', v1C.p3, mcpC.p3, fcTrip, 15, 20);
  reportTopDemoted('SIZE-4', v1C.p4, mcpC.p4, fcQuad, 15, 10);
  reportTopDemoted('SIZE-5', v1C.p5, mcpC.p5, fcQuint, 15, 5);

  // Aggregate stats.
  console.log('================================================================');
  console.log('AGGREGATE');
  console.log('================================================================');
  function topConcentration(sel: S[]): { mean: number; max: number; meanPenalty: number } {
    let pSum = 0, pMax = 0, penSum = 0;
    for (const s of sel) {
      pSum += Math.exp(-s.multi_penalty);  // approximate; the original product is in s.multi_penalty's source
      penSum += s.multi_penalty;
    }
    // recompute cleanly from stored values (multi_penalty = -log(prod + eps) so prod = exp(-penalty) - eps)
    let mc = 0;
    for (const s of sel) {
      const prod = Math.exp(-s.multi_penalty) - PARAMS.LOG_EPSILON;
      if (prod > mc) mc = prod;
    }
    return { mean: pSum / sel.length, max: mc, meanPenalty: penSum / sel.length };
  }
  const v1T = topConcentration(v1Sel); const mcpT = topConcentration(mcpSel);
  console.log('  V1  meanPenalty=' + v1T.meanPenalty.toFixed(3) + '  max top-5 conc=' + v1T.max.toExponential(3));
  console.log('  MCP meanPenalty=' + mcpT.meanPenalty.toFixed(3) + '  max top-5 conc=' + mcpT.max.toExponential(3));
  console.log('  Δ   meanPenalty=' + (mcpT.meanPenalty - v1T.meanPenalty).toFixed(3) + '  max conc Δ=' + ((mcpT.max - v1T.max) / v1T.max * 100).toFixed(1) + '%');
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
