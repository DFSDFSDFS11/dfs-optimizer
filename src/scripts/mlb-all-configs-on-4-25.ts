/**
 * Re-evaluate all ~108k sweep configs (V1 + V2) on the new 4-25 slate.
 * Merge with existing totals to produce 14-slate full-sample rankings.
 *
 * Sources:
 *   - mlb_megabin_oos.json (V1 sweep + OOS re-eval): 67,900 configs with 13-slate data
 *   - mlb_megabin2_sweep.json (V2 sweep): 40,326 configs with 13-slate data
 *
 * Output: full14 rankings, identifies if any config dethrones Phoenix.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import {
  parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals,
} from '../parser';
import { getContestConfig } from '../rules';
import { productionSelect } from '../selection/production-selector';
import { precomputeComboFrequencies } from '../selection/combo-leverage';
import { computeAnchor } from '../selection/anchor-relative';

const DIR = 'C:/Users/colin/dfs opto';
const V1_JSON = path.join(DIR, 'mlb_megabin_oos.json');
const V2_JSON = path.join(DIR, 'mlb_megabin2_sweep.json');
const OUT_JSON = path.join(DIR, 'mlb_all_configs_14slate.json');
const OUT_MD = path.join(DIR, 'mlb_all_configs_14slate.md');
const FEE = 20;
const N = 150;

const NEW_SLATE = { slate: '4-25-26', proj: '4-25-26projections.csv', actuals: '4-25-26actuals.csv', pool: '4-25-26sspool.csv' };

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function buildPayoutTable(F: number): Float64Array {
  const pool = F * FEE * 0.88; const cashLine = Math.floor(F * 0.22);
  const raw = new Float64Array(cashLine); let rawSum = 0;
  for (let r = 0; r < cashLine; r++) { raw[r] = Math.pow(r + 1, -1.15); rawSum += raw[r]; }
  const table = new Float64Array(F); const minCash = FEE * 1.2;
  for (let r = 0; r < cashLine; r++) table[r] = Math.max(minCash, (raw[r] / rawSum) * pool);
  let tSum = 0; for (let r = 0; r < cashLine; r++) tSum += table[r];
  const scale = pool / tSum; for (let r = 0; r < cashLine; r++) table[r] *= scale;
  return table;
}
function scoreLineup(lu: Lineup, actuals: ContestActuals, actualByHash: Map<string, number>): number | null {
  const h = lu.players.map(p => p.id).sort().join('|'); const fa = actualByHash.get(h);
  if (fa !== undefined) return fa;
  let t = 0; for (const p of lu.players) { const r = actuals.playerActualsByName.get(norm(p.name)); if (!r) return null; t += r.fpts; }
  return t;
}
function payoutFor(actual: number, sorted: number[], payoutTable: Float64Array, actuals: ContestActuals): number {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (sorted[m] >= actual) lo = m + 1; else hi = m; }
  const rank = Math.max(1, lo);
  const pay = rank <= payoutTable.length ? payoutTable[rank - 1] : 0;
  if (pay <= 0) return 0;
  let co = 0; for (const e of actuals.entries) if (Math.abs(e.actualPoints - actual) <= 0.25) co++;
  co = Math.max(0, co - 1);
  return pay / Math.sqrt(1 + co * 0.5);
}

interface SlateData {
  candidates: Lineup[];
  players: Player[];
  comboFreq: Map<string, number>;
  comboFreq1: Map<string, number>;
  comboFreq2: Map<string, number>;
  comboFreq4: Map<string, number>;
  comboFreq5: Map<string, number>;
  actuals: ContestActuals;
  actualByHash: Map<string, number>;
  sorted: number[];
  payoutTable: Float64Array;
  F: number;
  anchor: ReturnType<typeof computeAnchor>;
}

async function loadNewSlate(): Promise<SlateData> {
  const projPath = path.join(DIR, NEW_SLATE.proj); const actualsPath = path.join(DIR, NEW_SLATE.actuals); const poolPath = path.join(DIR, NEW_SLATE.pool);
  const pr = parseCSVFile(projPath, 'mlb', true);
  const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
  const pool = buildPlayerPool(pr.players, pr.detectedContestType);
  const actuals = parseContestActuals(actualsPath, config);
  const idMap = new Map<string, Player>(); const nameMap = new Map<string, Player>();
  for (const p of pool.players) { idMap.set(p.id, p); nameMap.set(norm(p.name), p); }
  const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
  const F = actuals.entries.length;
  const sorted = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
  const payoutTable = buildPayoutTable(F);
  const actualByHash = new Map<string, number>();
  for (const e of actuals.entries) {
    const pls: Player[] = []; let ok = true;
    for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
    if (!ok) continue;
    actualByHash.set(pls.map(p => p.id).sort().join('|'), e.actualPoints);
  }
  const comboFreq = precomputeComboFrequencies(loaded.lineups, 3);
  const comboFreq1 = precomputeComboFrequencies(loaded.lineups, 1);
  const comboFreq2 = precomputeComboFrequencies(loaded.lineups, 2);
  const comboFreq4 = precomputeComboFrequencies(loaded.lineups, 4);
  const comboFreq5 = precomputeComboFrequencies(loaded.lineups, 5);
  const anchor = computeAnchor(loaded.lineups, 50);
  return {
    candidates: loaded.lineups, players: pool.players,
    comboFreq, comboFreq1, comboFreq2, comboFreq4, comboFreq5,
    actuals, actualByHash, sorted, payoutTable, F, anchor,
  };
}

const getCombo = (sd: SlateData, power?: number) => {
  if (power === 1) return sd.comboFreq1;
  if (power === 2) return sd.comboFreq2;
  if (power === 4) return sd.comboFreq4;
  if (power === 5) return sd.comboFreq5;
  return sd.comboFreq;
};

// V1 phase config reconstruction
function buildV1Cfg(phase: string, cfg: any, sd: SlateData): Parameters<typeof productionSelect>[2] | null {
  const base: any = { N, comboFreq: sd.comboFreq };
  switch (phase) {
    case 'P1': return { ...base, lambda: 0.20, maxOverlap: 7, extremeCornerCap: true,
      binAllocation: { chalk: cfg.alloc[0], core: cfg.alloc[1], value: cfg.alloc[2], contra: cfg.alloc[3], deep: cfg.alloc[4] } };
    case 'P2': return { ...base, lambda: cfg.lam, maxOverlap: cfg.gam, teamCapPct: cfg.tc, projectionFloorPct: cfg.fl,
      extremeCornerCap: cfg.corner,
      binAllocation: { chalk: cfg.alloc[0], core: cfg.alloc[1], value: cfg.alloc[2], contra: cfg.alloc[3], deep: cfg.alloc[4] } };
    case 'P3': return { ...base, lambda: 0.20, maxOverlap: 7, extremeCornerCap: true,
      extremeCornerQ5Q5Pct: cfg.q5, extremeCornerQ1Q1Pct: cfg.q1 };
    case 'P4': return { ...base, lambda: 0.20, maxOverlap: 7, extremeCornerCap: true,
      ownDropPP: cfg.od, ownershipCeilingBuffer: cfg.buf, useOwnershipCeiling: true };
    case 'P5': return { ...base,
      lambda: cfg.lam ?? 0.20, maxOverlap: cfg.gam ?? 7, teamCapPct: cfg.tc ?? 0.10,
      extremeCornerCap: cfg.corner ?? true, projectionFloorPct: cfg.fl ?? 0,
      binAllocation: { chalk: cfg.alloc[0], core: cfg.alloc[1], value: cfg.alloc[2], contra: cfg.alloc[3], deep: cfg.alloc[4] } };
    case 'P6': return { ...base, lambda: 0.20, maxOverlap: 7, extremeCornerCap: true,
      binAllocation: { chalk: cfg.alloc[0], core: cfg.alloc[1], value: cfg.alloc[2], contra: cfg.alloc[3], deep: cfg.alloc[4] } };
    case 'P7': return { ...base, lambda: 0.20, maxOverlap: cfg.gam, extremeCornerCap: cfg.corner, projectionFloorPct: cfg.fl };
    case 'P8': return { ...base, lambda: cfg.lam, maxOverlap: 7, teamCapPct: cfg.tc, extremeCornerCap: true };
    case 'P9': return { ...base, lambda: cfg.lam, maxOverlap: cfg.gam, teamCapPct: cfg.tc, projectionFloorPct: cfg.fl,
      extremeCornerCap: cfg.corner, extremeCornerQ5Q5Pct: cfg.q5, extremeCornerQ1Q1Pct: cfg.q1,
      binAllocation: { chalk: cfg.alloc[0], core: cfg.alloc[1], value: cfg.alloc[2], contra: cfg.alloc[3], deep: cfg.alloc[4] } };
    default: return null;
  }
}

// V2 phase config reconstruction
function buildV2Cfg(phase: string, cfg: any, sd: SlateData): Parameters<typeof productionSelect>[2] | null {
  const alloc = cfg.alloc;
  if (!alloc || alloc.length !== 5) return null;
  const bins = { chalk: alloc[0], core: alloc[1], value: alloc[2], contra: alloc[3], deep: alloc[4] };
  switch (phase) {
    case 'A': return { N, lambda: cfg.lam, comboFreq: getCombo(sd, cfg.power), maxOverlap: 6, teamCapPct: 0.20,
      extremeCornerCap: true, projectionFloorPct: 0, binAllocation: bins };
    case 'B': return { N, lambda: cfg.lam, comboFreq: sd.comboFreq, maxOverlap: cfg.gam, teamCapPct: cfg.tc,
      extremeCornerCap: cfg.corner, projectionFloorPct: 0, binAllocation: bins };
    case 'C': return { N, lambda: cfg.lam, comboFreq: sd.comboFreq, maxOverlap: 6, teamCapPct: cfg.tc,
      extremeCornerCap: cfg.corner, projectionFloorPct: cfg.fl, binAllocation: bins };
    case 'D': return { N, lambda: cfg.lam, comboFreq: sd.comboFreq, maxOverlap: 6, teamCapPct: 0.20,
      extremeCornerCap: true, extremeCornerQ5Q5Pct: cfg.q5, extremeCornerQ1Q1Pct: cfg.q1,
      projectionFloorPct: 0, binAllocation: bins };
    case 'E': return { N, lambda: cfg.lam, comboFreq: sd.comboFreq, maxOverlap: 6, teamCapPct: 0.20,
      minPrimaryStack: cfg.mps, maxExposure: cfg.me, maxExposurePitcher: cfg.mep,
      extremeCornerCap: true, projectionFloorPct: 0, binAllocation: bins };
    case 'F': return { N, lambda: cfg.lam, comboFreq: sd.comboFreq, maxOverlap: 6, teamCapPct: 0.20,
      ownDropPP: cfg.od, ownershipCeilingBuffer: cfg.buf, useOwnershipCeiling: true,
      extremeCornerCap: true, projectionFloorPct: 0, binAllocation: bins };
    case 'G': return { N, lambda: cfg.lam, comboFreq: getCombo(sd, cfg.power), maxOverlap: cfg.gam, teamCapPct: cfg.tc,
      projectionFloorPct: cfg.fl, minPrimaryStack: cfg.mps,
      maxExposure: cfg.me, maxExposurePitcher: cfg.mep,
      extremeCornerCap: cfg.corner, extremeCornerQ5Q5Pct: cfg.q5, extremeCornerQ1Q1Pct: cfg.q1,
      useOwnershipCeiling: cfg.useOC, ownDropPP: cfg.od, ownershipCeilingBuffer: cfg.buf,
      binAllocation: bins };
    default: return null;
  }
}

interface MergedRecord {
  source: 'V1' | 'V2';
  id: string;
  phase: string;
  cfg: any;
  prevTotal: number;     // existing full13 from prior runs
  pay25: number;         // payout on 4-25
  full14: number;        // prevTotal + pay25
  oosOriginal: number;   // V1: oos23+oos24; V2: from 4-23+4-24 in perSlate
}

async function main() {
  console.log('================================================================');
  console.log('All-configs run on 4-25-26 — merging V1 (67.9k) + V2 (40.3k)');
  console.log('================================================================\n');

  const t_start = Date.now();
  console.log('Loading new slate 4-25-26...');
  const sd = await loadNewSlate();
  console.log(`  Pool: ${sd.candidates.length} lineups, ${sd.actuals.entries.length} field entries\n`);

  console.log('Loading V1 OOS JSON (compact)...');
  const v1Raw = JSON.parse(fs.readFileSync(V1_JSON, 'utf8'));
  console.log(`  V1: ${v1Raw.length} configs\n`);

  console.log('Loading V2 sweep JSON...');
  const v2Raw = JSON.parse(fs.readFileSync(V2_JSON, 'utf8'));
  console.log(`  V2: ${v2Raw.length} configs\n`);

  const merged: MergedRecord[] = [];

  // Process V1 configs (in-sample 11 + OOS 2 = 13 slates already)
  console.log('Running V1 configs on 4-25...');
  let v1Done = 0;
  for (const r of v1Raw) {
    const phase = r.phase;
    const cfg = r.cfg;
    const runCfg = buildV1Cfg(phase, cfg, sd);
    if (!runCfg) { v1Done++; continue; }
    let pay25 = 0;
    try {
      const result = productionSelect(sd.candidates, sd.players, runCfg);
      for (const lu of result.portfolio) {
        const a = scoreLineup(lu, sd.actuals, sd.actualByHash);
        if (a !== null) pay25 += payoutFor(a, sd.sorted, sd.payoutTable, sd.actuals);
      }
    } catch {}
    const prevTotal = (r.fullPay || 0) + (r.oos23 || 0) + (r.oos24 || 0);
    merged.push({
      source: 'V1', id: r.id, phase, cfg, prevTotal, pay25, full14: prevTotal + pay25,
      oosOriginal: (r.oos23 || 0) + (r.oos24 || 0),
    });
    v1Done++;
    if (v1Done % 5000 === 0) {
      const elapsedMin = (Date.now() - t_start) / 60000;
      console.log(`  V1: ${v1Done}/${v1Raw.length} (${(v1Done / v1Raw.length * 100).toFixed(1)}%) — ${elapsedMin.toFixed(1)} min`);
    }
  }
  console.log(`  V1 complete: ${merged.length} configs processed\n`);

  // Process V2 configs (already 13-slate full)
  console.log('Running V2 configs on 4-25...');
  let v2Done = 0;
  for (const r of v2Raw) {
    const phase = r.phase;
    const cfg = r.cfg;
    const runCfg = buildV2Cfg(phase, cfg, sd);
    if (!runCfg) { v2Done++; continue; }
    let pay25 = 0;
    try {
      const result = productionSelect(sd.candidates, sd.players, runCfg);
      for (const lu of result.portfolio) {
        const a = scoreLineup(lu, sd.actuals, sd.actualByHash);
        if (a !== null) pay25 += payoutFor(a, sd.sorted, sd.payoutTable, sd.actuals);
      }
    } catch {}
    const prevTotal = r.fullPay || 0;
    // OOS for V2 was 4-23 + 4-24 — value stored in r.oosPay
    merged.push({
      source: 'V2', id: r.id, phase, cfg, prevTotal, pay25, full14: prevTotal + pay25,
      oosOriginal: r.oosPay || 0,
    });
    v2Done++;
    if (v2Done % 5000 === 0) {
      const elapsedMin = (Date.now() - t_start) / 60000;
      console.log(`  V2: ${v2Done}/${v2Raw.length} (${(v2Done / v2Raw.length * 100).toFixed(1)}%) — ${elapsedMin.toFixed(1)} min`);
    }
  }
  console.log(`  V2 complete\n`);

  console.log(`\nTotal configs evaluated: ${merged.length}`);
  console.log(`Total elapsed: ${((Date.now() - t_start) / 60000).toFixed(1)} min\n`);

  // Persist
  fs.writeFileSync(OUT_JSON, JSON.stringify(merged.map(m => ({
    source: m.source, id: m.id, phase: m.phase, cfg: m.cfg,
    prevTotal: m.prevTotal, pay25: m.pay25, full14: m.full14, oos: m.oosOriginal,
  })), null, 0));

  // ============ ANALYSIS ============
  const byFull14 = [...merged].sort((a, b) => b.full14 - a.full14);
  const byPay25 = [...merged].sort((a, b) => b.pay25 - a.pay25);

  console.log('=== TOP 25 BY 14-SLATE FULL ===\n');
  console.log('Rank | Source | Phase | full14   | 4-25     | prev13   | OOS-orig | id');
  console.log('-'.repeat(140));
  for (let i = 0; i < 25; i++) {
    const r = byFull14[i];
    console.log(`  ${(i + 1).toString().padStart(2)} | ${r.source} | ${r.phase.padEnd(4)} | $${r.full14.toFixed(0).padStart(6)} | $${r.pay25.toFixed(0).padStart(5)} | $${r.prevTotal.toFixed(0).padStart(6)} | $${r.oosOriginal.toFixed(0).padStart(5)} | ${r.id.slice(0, 70)}`);
  }

  console.log('\n=== TOP 15 BY 4-25 PAY ALONE ===\n');
  for (let i = 0; i < 15; i++) {
    const r = byPay25[i];
    console.log(`  ${(i + 1).toString().padStart(2)} | ${r.source} | ${r.phase.padEnd(4)} | 4-25=$${r.pay25.toFixed(0).padStart(5)} | full14=$${r.full14.toFixed(0).padStart(6)} | ${r.id.slice(0, 70)}`);
  }

  // Where does Phoenix sit?
  // Phoenix was V2 #13 → search by approximate cfg
  console.log('\n=== Phoenix tracking ===');
  const phoenixCandidates = merged.filter(m =>
    m.source === 'V2' && m.cfg && m.cfg.lam !== undefined &&
    Math.abs(m.cfg.lam - 0.14) < 0.01 && m.cfg.gam === 6 &&
    m.cfg.tc !== undefined && Math.abs(m.cfg.tc - 0.22) < 0.01 &&
    m.cfg.corner === false && m.cfg.alloc &&
    Math.abs(m.cfg.alloc[2] - 0.85) < 0.02
  );
  if (phoenixCandidates.length > 0) {
    const top = phoenixCandidates.sort((a, b) => b.full14 - a.full14)[0];
    const rank = byFull14.findIndex(x => x.id === top.id) + 1;
    console.log(`  Phoenix-like config rank: ${rank} of ${merged.length}`);
    console.log(`  Phoenix full14: $${top.full14.toFixed(0)}, pay25: $${top.pay25.toFixed(0)}, prev13: $${top.prevTotal.toFixed(0)}`);
  }

  // Source distribution of top-100
  const top100 = byFull14.slice(0, 100);
  let v1Cnt = 0, v2Cnt = 0;
  for (const r of top100) { if (r.source === 'V1') v1Cnt++; else v2Cnt++; }
  console.log(`\nTop 100 by full14: V1=${v1Cnt}, V2=${v2Cnt}`);

  // Markdown
  let md = `# All Configs (V1+V2) Re-Eval on 4-25\n\n`;
  md += `**${merged.length} configs** evaluated on 4-25-26 and merged with prior 13-slate totals.\n\n`;
  md += `## Top 25 by 14-slate full\n\n`;
  md += `| Rank | Source | Phase | full14 | 4-25 | prev13 | id |\n|---:|---|---|---:|---:|---:|---|\n`;
  for (let i = 0; i < 25; i++) {
    const r = byFull14[i];
    md += `| ${i + 1} | ${r.source} | ${r.phase} | $${r.full14.toFixed(0)} | $${r.pay25.toFixed(0)} | $${r.prevTotal.toFixed(0)} | \`${r.id.slice(0, 70)}\` |\n`;
  }
  fs.writeFileSync(OUT_MD, md);

  console.log(`\nJSON: ${OUT_JSON}`);
  console.log(`MD:   ${OUT_MD}`);
}

main().catch(e => { console.error(e); process.exit(1); });
