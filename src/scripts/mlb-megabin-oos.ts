/**
 * Re-evaluate all 67,900 megabin sweep configs on the 2 new OOS slates
 * (4-23, 4-24). Merge with original in-sample results for full 13-slate ranking.
 *
 * Tells us:
 *   1. Did the same configs that won in-sample also win OOS?
 *   2. How many configs that beat Apex on 11 slates ALSO beat Apex on 2 OOS slates?
 *   3. Top configs by combined 13-slate full + min-LOO.
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
const IN_JSON = path.join(DIR, 'mlb_megabin_sweep.json');
const OUT_JSON = path.join(DIR, 'mlb_megabin_oos.json');
const OUT_MD = path.join(DIR, 'mlb_megabin_oos.md');
const FEE = 20;
const N = 150;

const NEW_SLATES = [
  { slate: '4-23-26', proj: '4-23-26projections.csv', actuals: '4-23-26actuals.csv', pool: '4-23-26sspool.csv' },
  { slate: '4-24-26', proj: '4-24-26projections.csv', actuals: '4-24-26actuals.csv', pool: '4-24-26sspool.csv' },
];

const APEX_FULL_INSAMPLE = 54869;
const APEX_OOS = 3701;
const APEX_MINLOO_13 = 3276; // from OOS validation

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
  slate: string;
  candidates: Lineup[];
  players: Player[];
  comboFreq: Map<string, number>;
  actuals: ContestActuals;
  actualByHash: Map<string, number>;
  sorted: number[];
  top1Thresh: number;
  payoutTable: Float64Array;
  F: number;
  anchor: ReturnType<typeof computeAnchor>;
}

async function loadSlate(s: typeof NEW_SLATES[0]): Promise<SlateData | null> {
  const projPath = path.join(DIR, s.proj); const actualsPath = path.join(DIR, s.actuals); const poolPath = path.join(DIR, s.pool);
  if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) return null;
  const pr = parseCSVFile(projPath, 'mlb', true);
  const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
  const pool = buildPlayerPool(pr.players, pr.detectedContestType);
  const actuals = parseContestActuals(actualsPath, config);
  const idMap = new Map<string, Player>(); const nameMap = new Map<string, Player>();
  for (const p of pool.players) { idMap.set(p.id, p); nameMap.set(norm(p.name), p); }
  const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
  const comboFreq = precomputeComboFrequencies(loaded.lineups, 3);
  const F = actuals.entries.length;
  const sorted = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
  const top1Thresh = sorted[Math.max(0, Math.floor(F * 0.01) - 1)] || 0;
  const payoutTable = buildPayoutTable(F);
  const actualByHash = new Map<string, number>();
  for (const e of actuals.entries) {
    const pls: Player[] = []; let ok = true;
    for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
    if (!ok) continue;
    actualByHash.set(pls.map(p => p.id).sort().join('|'), e.actualPoints);
  }
  const anchor = computeAnchor(loaded.lineups, 50);
  return { slate: s.slate, candidates: loaded.lineups, players: pool.players, comboFreq, actuals, actualByHash, sorted, top1Thresh, payoutTable, F, anchor };
}

// Reconstruct the productionSelect cfg from a sweep result's cfg + phase
function buildSelectCfg(phase: string, cfg: any, comboFreq: Map<string, number>): Parameters<typeof productionSelect>[2] {
  const base: any = { N, comboFreq };
  switch (phase) {
    case 'P1':
      // 5-bin alloc only; λ=0.20, γ=7, corner=true fixed
      return {
        ...base, lambda: 0.20, maxOverlap: 7, extremeCornerCap: true,
        binAllocation: { chalk: cfg.alloc[0], core: cfg.alloc[1], value: cfg.alloc[2], contra: cfg.alloc[3], deep: cfg.alloc[4] },
      };
    case 'P2':
      return {
        ...base, lambda: cfg.lam, maxOverlap: cfg.gam, teamCapPct: cfg.tc, projectionFloorPct: cfg.fl,
        extremeCornerCap: cfg.corner,
        binAllocation: { chalk: cfg.alloc[0], core: cfg.alloc[1], value: cfg.alloc[2], contra: cfg.alloc[3], deep: cfg.alloc[4] },
      };
    case 'P3':
      // corner-percent grid; λ=0.20, γ=7, corner=true fixed
      return {
        ...base, lambda: 0.20, maxOverlap: 7, extremeCornerCap: true,
        extremeCornerQ5Q5Pct: cfg.q5, extremeCornerQ1Q1Pct: cfg.q1,
      };
    case 'P4':
      // own-drop + buffer with useOwnershipCeiling=true
      return {
        ...base, lambda: 0.20, maxOverlap: 7, extremeCornerCap: true,
        ownDropPP: cfg.od, ownershipCeilingBuffer: cfg.buf, useOwnershipCeiling: true,
      };
    case 'P5':
      return {
        ...base,
        lambda: cfg.lam ?? 0.20,
        maxOverlap: cfg.gam ?? 7,
        teamCapPct: cfg.tc ?? 0.10,
        extremeCornerCap: cfg.corner ?? true,
        projectionFloorPct: cfg.fl ?? 0,
        binAllocation: { chalk: cfg.alloc[0], core: cfg.alloc[1], value: cfg.alloc[2], contra: cfg.alloc[3], deep: cfg.alloc[4] },
      };
    case 'P6':
      // constrained-simplex 5-bin; λ=0.20, γ=7, corner=true
      return {
        ...base, lambda: 0.20, maxOverlap: 7, extremeCornerCap: true,
        binAllocation: { chalk: cfg.alloc[0], core: cfg.alloc[1], value: cfg.alloc[2], contra: cfg.alloc[3], deep: cfg.alloc[4] },
      };
    case 'P7':
      return {
        ...base, lambda: 0.20, maxOverlap: cfg.gam, extremeCornerCap: cfg.corner, projectionFloorPct: cfg.fl,
      };
    case 'P8':
      return {
        ...base, lambda: cfg.lam, maxOverlap: 7, teamCapPct: cfg.tc, extremeCornerCap: true,
      };
    case 'P9':
      return {
        ...base, lambda: cfg.lam, maxOverlap: cfg.gam, teamCapPct: cfg.tc, projectionFloorPct: cfg.fl,
        extremeCornerCap: cfg.corner, extremeCornerQ5Q5Pct: cfg.q5, extremeCornerQ1Q1Pct: cfg.q1,
        binAllocation: { chalk: cfg.alloc[0], core: cfg.alloc[1], value: cfg.alloc[2], contra: cfg.alloc[3], deep: cfg.alloc[4] },
      };
    default:
      throw new Error('Unknown phase: ' + phase);
  }
}

interface OrigResult {
  id: string;
  phase: string;
  cfg: any;
  fullPay: number;
  recentPay: number;
  minLoo: number;
  t1: number;
  profitable: number;
  perSlate: { slate: string; pay: number; t1: number }[];
}

async function main() {
  console.log('================================================================');
  console.log('MLB MEGABIN OUT-OF-SAMPLE — re-evaluate 67,900 configs on 4-23 + 4-24');
  console.log('================================================================\n');

  // Load OOS slates ONCE (precomp shared across all configs since we're reusing pool)
  console.log('Loading OOS slates...');
  const oosCache: SlateData[] = [];
  for (const s of NEW_SLATES) {
    const c = await loadSlate(s); if (c) oosCache.push(c);
  }
  console.log(`${oosCache.length} OOS slates loaded.\n`);

  console.log('Loading sweep JSON (131 MB — may take 30s)...');
  const t0 = Date.now();
  const data = JSON.parse(fs.readFileSync(IN_JSON, 'utf8'));
  const original: OrigResult[] = data.results || data;
  console.log(`Loaded ${original.length} configs in ${((Date.now() - t0) / 1000).toFixed(0)}s.\n`);

  console.log(`Re-evaluating ${original.length} configs on 2 OOS slates...\n`);

  interface MergedResult extends OrigResult {
    oos23: number;
    oos24: number;
    oosTotal: number;
    full13: number;
    minLoo13: number;
    profitable13: number;
    beatsApexInSample: boolean;
    beatsApexOos: boolean;
    beatsApexBoth: boolean;
  }

  const merged: MergedResult[] = [];
  let processed = 0;

  for (const orig of original) {
    const perSlateExt: { slate: string; pay: number; t1: number }[] = [...orig.perSlate];
    let oos23 = 0, oos24 = 0, oosT1 = 0;
    for (const sd of oosCache) {
      let cfg: Parameters<typeof productionSelect>[2];
      try {
        cfg = buildSelectCfg(orig.phase, orig.cfg, sd.comboFreq);
      } catch {
        // unknown phase — skip
        continue;
      }
      try {
        const result = productionSelect(sd.candidates, sd.players, cfg);
        let pay = 0, t1 = 0;
        for (const lu of result.portfolio) {
          const a = scoreLineup(lu, sd.actuals, sd.actualByHash); if (a === null) continue;
          pay += payoutFor(a, sd.sorted, sd.payoutTable, sd.actuals);
          if (a >= sd.top1Thresh) t1++;
        }
        if (sd.slate === '4-23-26') { oos23 = pay; oosT1 += t1; }
        if (sd.slate === '4-24-26') { oos24 = pay; oosT1 += t1; }
        perSlateExt.push({ slate: sd.slate, pay, t1 });
      } catch (e) {
        // skip on error
      }
    }
    const oosTotal = oos23 + oos24;
    const full13 = orig.fullPay + oosTotal;
    const pays = perSlateExt.map(x => x.pay);
    const loos = pays.map((_, i) => { let s = 0, cnt = 0; for (let j = 0; j < pays.length; j++) if (j !== i) { s += pays[j]; cnt++; } return cnt ? s / cnt : 0; });
    const minLoo13 = loos.length ? Math.min(...loos) : 0;
    const profitable13 = perSlateExt.filter(x => x.pay > FEE * N).length;

    const beatsInSample = orig.fullPay > APEX_FULL_INSAMPLE;
    const beatsOos = oosTotal > APEX_OOS;
    merged.push({
      ...orig,
      oos23, oos24, oosTotal, full13, minLoo13, profitable13,
      beatsApexInSample: beatsInSample,
      beatsApexOos: beatsOos,
      beatsApexBoth: beatsInSample && beatsOos,
    });

    processed++;
    if (processed % 5000 === 0) {
      const elapsedMin = (Date.now() - t0) / 60000;
      const rate = processed / elapsedMin;
      const remaining = (original.length - processed) / rate;
      console.log(`  ${processed}/${original.length} (${(processed / original.length * 100).toFixed(1)}%) — ${elapsedMin.toFixed(1)} min elapsed, ~${remaining.toFixed(0)} min remaining`);
    }
  }

  // Persist
  fs.writeFileSync(OUT_JSON, JSON.stringify(merged.map(m => ({
    id: m.id, phase: m.phase, cfg: m.cfg, fullPay: m.fullPay, oos23: m.oos23, oos24: m.oos24,
    full13: m.full13, minLoo13: m.minLoo13, profitable13: m.profitable13,
    beatsApexBoth: m.beatsApexBoth,
  })), null, 2));

  // ============== ANALYSIS ==============
  console.log('\n================ ANALYSIS ================\n');

  const beatBoth = merged.filter(m => m.beatsApexBoth);
  const beatInOnly = merged.filter(m => m.beatsApexInSample && !m.beatsApexOos);
  const beatOosOnly = merged.filter(m => !m.beatsApexInSample && m.beatsApexOos);
  const beatNeither = merged.filter(m => !m.beatsApexInSample && !m.beatsApexOos);

  console.log(`Apex baselines: in-sample $${APEX_FULL_INSAMPLE}, OOS $${APEX_OOS}\n`);
  console.log(`Configs that beat Apex on:`);
  console.log(`  In-sample only:  ${beatInOnly.length}`);
  console.log(`  OOS only:        ${beatOosOnly.length}`);
  console.log(`  BOTH (validated):${beatBoth.length}  ← these are the true winners`);
  console.log(`  Neither:         ${beatNeither.length}`);

  // Top 20 by combined 13-slate full
  const byFull13 = [...merged].sort((a, b) => b.full13 - a.full13).slice(0, 20);
  console.log('\n=== TOP 20 BY 13-SLATE FULL ===\n');
  console.log('Rank | Phase | full13   | OOS$   | min-LOO | beats Apex both | id');
  console.log('-'.repeat(125));
  for (let i = 0; i < byFull13.length; i++) {
    const m = byFull13[i];
    console.log(`  ${(i + 1).toString().padStart(2)} | ${m.phase.padEnd(4)} | $${m.full13.toFixed(0).padStart(6)} | $${m.oosTotal.toFixed(0).padStart(5)} | $${m.minLoo13.toFixed(0).padStart(5)} | ${m.beatsApexBoth ? 'YES' : 'no '}             | ${m.id.slice(0, 70)}`);
  }

  // Top 20 by OOS only
  const byOos = [...merged].sort((a, b) => b.oosTotal - a.oosTotal).slice(0, 20);
  console.log('\n=== TOP 20 BY OOS ONLY (4-23 + 4-24) ===\n');
  console.log('Rank | Phase | OOS$   | full13   | in-sample | beats both | id');
  console.log('-'.repeat(125));
  for (let i = 0; i < byOos.length; i++) {
    const m = byOos[i];
    console.log(`  ${(i + 1).toString().padStart(2)} | ${m.phase.padEnd(4)} | $${m.oosTotal.toFixed(0).padStart(5)} | $${m.full13.toFixed(0).padStart(6)} | $${m.fullPay.toFixed(0).padStart(7)} | ${m.beatsApexBoth ? 'YES' : 'no'}        | ${m.id.slice(0, 70)}`);
  }

  // Top 20 BEATS BOTH (these are the validated winners)
  const byBoth = [...beatBoth].sort((a, b) => b.full13 - a.full13).slice(0, 20);
  console.log(`\n=== TOP 20 OF "BEATS BOTH" (${beatBoth.length} validated configs) ===\n`);
  console.log('Rank | Phase | full13   | OOS$   | in-sample | min-LOO13 | id');
  console.log('-'.repeat(125));
  for (let i = 0; i < byBoth.length; i++) {
    const m = byBoth[i];
    console.log(`  ${(i + 1).toString().padStart(2)} | ${m.phase.padEnd(4)} | $${m.full13.toFixed(0).padStart(6)} | $${m.oosTotal.toFixed(0).padStart(5)} | $${m.fullPay.toFixed(0).padStart(7)} | $${m.minLoo13.toFixed(0).padStart(5)} | ${m.id.slice(0, 70)}`);
  }

  // Where does shipped Kraken sit in this list?
  console.log('\n=== Reference: Kraken-shipped (λ=0.378, γ=6, tc=0.21, no-corner, value-heavy) ===');
  const krakenLike = merged.filter(m =>
    m.cfg && m.cfg.lam !== undefined && Math.abs(m.cfg.lam - 0.378) < 0.01 &&
    m.cfg.gam === 6 && m.cfg.tc !== undefined && Math.abs(m.cfg.tc - 0.21) < 0.005 &&
    m.cfg.corner === false
  );
  console.log(`  Found ${krakenLike.length} configs matching shipped Kraken parameters`);
  if (krakenLike.length > 0) {
    const top = krakenLike.sort((a, b) => b.full13 - a.full13)[0];
    console.log(`  Top match: full13 $${top.full13}, OOS $${top.oosTotal}, in-sample $${top.fullPay}, beats both: ${top.beatsApexBoth}`);
    const rank = byFull13.length > 0 ? merged.sort((a, b) => b.full13 - a.full13).findIndex(m => m.id === top.id) : -1;
    console.log(`  Kraken rank by full13: ${rank + 1} of ${merged.length}`);
  }

  // Markdown summary
  let md = `# MLB Megabin OOS Re-Evaluation\n\n`;
  md += `Re-evaluated all ${merged.length} configs from the in-sample sweep on the 2 OOS slates (4-23, 4-24).\n\n`;
  md += `## Apex baselines\n\n`;
  md += `- In-sample (11 slates): $${APEX_FULL_INSAMPLE}\n`;
  md += `- OOS (2 slates): $${APEX_OOS}\n\n`;
  md += `## Validation summary\n\n`;
  md += `| Category | Count | % of total |\n|---|---:|---:|\n`;
  md += `| Beats Apex on BOTH (validated) | ${beatBoth.length} | ${(beatBoth.length / merged.length * 100).toFixed(1)}% |\n`;
  md += `| Beats Apex in-sample only | ${beatInOnly.length} | ${(beatInOnly.length / merged.length * 100).toFixed(1)}% |\n`;
  md += `| Beats Apex OOS only | ${beatOosOnly.length} | ${(beatOosOnly.length / merged.length * 100).toFixed(1)}% |\n`;
  md += `| Beats neither | ${beatNeither.length} | ${(beatNeither.length / merged.length * 100).toFixed(1)}% |\n\n`;
  md += `## Top 20 validated winners (beats Apex on both)\n\n`;
  md += `| Rank | Phase | full13 | OOS | in-sample | min-LOO13 |\n|---:|---|---:|---:|---:|---:|\n`;
  for (let i = 0; i < byBoth.length; i++) {
    const m = byBoth[i];
    md += `| ${i + 1} | ${m.phase} | $${m.full13.toFixed(0)} | $${m.oosTotal.toFixed(0)} | $${m.fullPay.toFixed(0)} | $${m.minLoo13.toFixed(0)} |\n`;
  }
  fs.writeFileSync(OUT_MD, md);

  console.log(`\nJSON: ${OUT_JSON}`);
  console.log(`MD:   ${OUT_MD}`);
}

main().catch(e => { console.error(e); process.exit(1); });
