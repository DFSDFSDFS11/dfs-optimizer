/**
 * Run all 108,969 configs on 4-26 slate. Add to 15-slate totals → 16-slate full.
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
const PRIOR_JSON = path.join(DIR, 'mlb_all_configs_15slate.json');
const OUT_JSON = path.join(DIR, 'mlb_all_configs_16slate.json');
const OUT_MD = path.join(DIR, 'mlb_all_configs_16slate.md');
const FEE = 20;
const N = 150;

const NEW_SLATE = { slate: '4-26-26', proj: '4-26-26projections.csv', actuals: '4-26-26actuals.csv', pool: '4-26-26sspool.csv' };

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
  candidates: Lineup[]; players: Player[];
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

async function main() {
  console.log('================================================================');
  console.log('All-configs run on 4-26 — adding to 15-slate totals → full16');
  console.log('================================================================\n');

  const t_start = Date.now();
  console.log('Loading 4-26 slate...');
  const sd = await loadNewSlate();
  console.log(`  Pool: ${sd.candidates.length}, field: ${sd.actuals.entries.length}\n`);

  console.log('Loading 15-slate prior totals...');
  const prior = JSON.parse(fs.readFileSync(PRIOR_JSON, 'utf8'));
  console.log(`  ${prior.length} configs loaded\n`);

  console.log('Running all configs on 4-26...');
  const results: any[] = [];
  let done = 0;
  for (const r of prior) {
    let runCfg = null;
    if (r.source === 'V1') runCfg = buildV1Cfg(r.phase, r.cfg, sd);
    else if (r.source === 'V2') runCfg = buildV2Cfg(r.phase, r.cfg, sd);
    if (!runCfg) {
      results.push({ ...r, pay26: 0, full16: r.full15 });
      done++; continue;
    }
    let pay26 = 0;
    try {
      const result = productionSelect(sd.candidates, sd.players, runCfg);
      for (const lu of result.portfolio) {
        const a = scoreLineup(lu, sd.actuals, sd.actualByHash);
        if (a !== null) pay26 += payoutFor(a, sd.sorted, sd.payoutTable, sd.actuals);
      }
    } catch {}
    results.push({ ...r, pay26, full16: r.full15 + pay26 });
    done++;
    if (done % 5000 === 0) {
      const elapsedMin = (Date.now() - t_start) / 60000;
      console.log(`  ${done}/${prior.length} (${(done / prior.length * 100).toFixed(1)}%) — ${elapsedMin.toFixed(1)} min`);
    }
  }

  console.log(`\n${results.length} configs total. Elapsed: ${((Date.now() - t_start) / 60000).toFixed(1)} min\n`);

  fs.writeFileSync(OUT_JSON, JSON.stringify(results, null, 0));

  // Analysis
  const byFull16 = [...results].sort((a, b) => b.full16 - a.full16);
  const byPay26 = [...results].sort((a, b) => b.pay26 - a.pay26);
  const fees = 16 * 150 * 20;

  console.log('=== TOP 25 BY 16-SLATE FULL ===\n');
  for (let i = 0; i < 25; i++) {
    const r = byFull16[i];
    const roi = ((r.full16 / fees - 1) * 100).toFixed(1);
    console.log(`  ${(i + 1).toString().padStart(2)} | ${r.source} | ${r.phase.padEnd(4)} | full16=$${r.full16.toFixed(0).padStart(6)} | 4-26=$${r.pay26.toFixed(0).padStart(5)} | full15=$${r.full15.toFixed(0).padStart(6)} | ROI=${roi}% | ${r.id.slice(0, 60)}`);
  }

  console.log('\n=== TOP 15 BY 4-26 ALONE ===\n');
  for (let i = 0; i < 15; i++) {
    const r = byPay26[i];
    console.log(`  ${(i + 1).toString().padStart(2)} | ${r.source} | ${r.phase.padEnd(4)} | 4-26=$${r.pay26.toFixed(0).padStart(5)} | full16=$${r.full16.toFixed(0).padStart(6)} | ${r.id.slice(0, 60)}`);
  }

  // Chimera tracking
  console.log('\n=== Chimera (currently shipped) tracking ===');
  const chimera = results.find(m =>
    m.source === 'V2' && m.cfg && m.cfg.lam !== undefined &&
    Math.abs(m.cfg.lam - 0.62) < 0.02 && m.cfg.gam === 6 &&
    m.cfg.tc !== undefined && Math.abs(m.cfg.tc - 0.24) < 0.02 &&
    m.cfg.corner === true && m.cfg.alloc &&
    Math.abs(m.cfg.alloc[2] - 0.85) < 0.02 &&
    m.cfg.mps === 5 && m.cfg.power === 2
  );
  if (chimera) {
    const rank = byFull16.findIndex(x => x.id === chimera.id) + 1;
    const roi = ((chimera.full16 / fees - 1) * 100).toFixed(1);
    console.log(`  Chimera rank: ${rank} of ${results.length}`);
    console.log(`  full16: $${chimera.full16.toFixed(0)} | 4-26: $${chimera.pay26.toFixed(0)} | full15: $${chimera.full15.toFixed(0)}`);
    console.log(`  16-slate ROI: ${roi}%`);
  } else {
    console.log('  Chimera config not found in dataset (specific cfg may not have been sampled)');
  }

  // Phoenix tracking too
  const phoenix = results.find(m =>
    m.source === 'V2' && m.cfg && m.cfg.lam !== undefined &&
    Math.abs(m.cfg.lam - 0.14) < 0.01 && m.cfg.gam === 6 &&
    m.cfg.tc !== undefined && Math.abs(m.cfg.tc - 0.22) < 0.01 &&
    m.cfg.corner === false && m.cfg.alloc &&
    Math.abs(m.cfg.alloc[2] - 0.85) < 0.02
  );
  if (phoenix) {
    const rank = byFull16.findIndex(x => x.id === phoenix.id) + 1;
    const roi = ((phoenix.full16 / fees - 1) * 100).toFixed(1);
    console.log(`\n=== Phoenix (deprecated) tracking ===`);
    console.log(`  Phoenix rank: ${rank} of ${results.length}`);
    console.log(`  full16: $${phoenix.full16.toFixed(0)} | 4-26: $${phoenix.pay26.toFixed(0)}`);
    console.log(`  16-slate ROI: ${roi}%`);
  }

  // Markdown
  let md = `# All Configs — 16-slate (added 4-26)\n\n`;
  md += `## Top 25 by 16-slate full\n\n`;
  md += `| Rank | Source | Phase | full16 | 4-26 | full15 | ROI | id |\n|---:|---|---|---:|---:|---:|---:|---|\n`;
  for (let i = 0; i < 25; i++) {
    const r = byFull16[i];
    const roi = ((r.full16 / fees - 1) * 100).toFixed(1);
    md += `| ${i + 1} | ${r.source} | ${r.phase} | $${r.full16.toFixed(0)} | $${r.pay26.toFixed(0)} | $${r.full15.toFixed(0)} | ${roi}% | \`${r.id.slice(0, 60)}\` |\n`;
  }
  fs.writeFileSync(OUT_MD, md);

  console.log(`\nJSON: ${OUT_JSON}`);
  console.log(`MD:   ${OUT_MD}`);
}

main().catch(e => { console.error(e); process.exit(1); });
