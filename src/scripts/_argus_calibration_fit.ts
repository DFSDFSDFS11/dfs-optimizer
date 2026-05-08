/**
 * Fit + validate empirical concentration multiplier for the SS-pool field model.
 *
 * For each (size, predicted_pct_bucket): median of (actual_pct / predicted_pct)
 * across all combos in all training slates. This is the "concentration
 * multiplier" — pool predictions get scaled up by this factor to match the
 * field's actual concentration on chalk combos.
 *
 * Validation: leave-one-out (LOO).
 *   For each held-out slate i:
 *     fit multipliers on the other 15 slates
 *     compute uncalibrated and calibrated predictions on slate i
 *     compare Pearson(log_pred, log_actual) and median |rel err|
 *   Aggregate LOO results across slates.
 *
 * Final fit (on all 16 slates) is saved as argus_calibration.json
 * for use by the production preslate runner.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';

const DIR = 'C:/Users/colin/dfs opto';
const OUT_JSON = path.join(DIR, 'multi_combo_penalty_implementation', 'argus_calibration.json');
const OUT_CSV = path.join(DIR, 'multi_combo_penalty_implementation', 'verification', 'calibration_multipliers.csv');

const SLATES = [
  { slate: '4-8-26',         proj: '4-8-26projections.csv',         actuals: '4-8-26actuals.csv',         pool: '4-8-26sspool.csv' },
  { slate: '4-12-26',        proj: '4-12-26projections.csv',        actuals: '4-12-26actuals.csv',        pool: '4-12-26sspool.csv' },
  { slate: '4-17-26',        proj: '4-17-26projections.csv',        actuals: '4-17-26actuals.csv',        pool: '4-17-26sspool.csv' },
  { slate: '4-18-26',        proj: '4-18-26projections.csv',        actuals: '4-18-26actuals.csv',        pool: '4-18-26sspool.csv' },
  { slate: '4-21-26',        proj: '4-21-26projections.csv',        actuals: '4-21-26actuals.csv',        pool: '4-21-26sspool.csv' },
  { slate: '4-22-26',        proj: '4-22-26projections.csv',        actuals: '4-22-26actuals.csv',        pool: '4-22-26sspool.csv' },
  { slate: '4-23-26',        proj: '4-23-26projections.csv',        actuals: '4-23-26actuals.csv',        pool: '4-23-26sspool.csv' },
  { slate: '4-24-26',        proj: '4-24-26projections.csv',        actuals: '4-24-26actuals.csv',        pool: '4-24-26sspool.csv' },
  { slate: '4-25-26',        proj: '4-25-26projections.csv',        actuals: '4-25-26actuals.csv',        pool: '4-25-26sspool.csv' },
  { slate: '4-25-26-early',  proj: '4-25-26projectionsearly.csv',   actuals: '4-25-26actualsearly.csv',   pool: '4-25-26sspoolearly.csv' },
  { slate: '4-26-26',        proj: '4-26-26projections.csv',        actuals: '4-26-26actuals.csv',        pool: '4-26-26sspool.csv' },
  { slate: '4-27-26',        proj: '4-27-26projections.csv',        actuals: '4-27-26actuals.csv',        pool: '4-27-26sspool.csv' },
  { slate: '4-28-26',        proj: '4-28-26projections.csv',        actuals: '4-28-26actuals.csv',        pool: '4-28-26sspool.csv' },
  { slate: '4-29-26',        proj: '4-29-26projections.csv',        actuals: '4-29-26actuals.csv',        pool: '4-29-26sspool.csv' },
  { slate: '5-2-26-main',    proj: '5-2-26projectionsmain.csv',     actuals: '5-2-26actualsmain.csv',     pool: '5-2-26sspoolmain.csv' },
  { slate: '5-3-26',         proj: '5-3-26projections.csv',         actuals: '5-3-26actuals.csv',         pool: '5-3-26sspool.csv' },
];

// Predicted-% buckets (chosen to give roughly equal numbers of high-signal combos).
// pred=0 (combo absent from pool) is its own bucket.
const PRED_BUCKETS: { id: string; lo: number; hi: number }[] = [
  { id: 'absent',     lo: -0.0001, hi: 0.0001 }, // exactly 0 (combo not in pool)
  { id: '0-0.02%',    lo:  0.0001, hi: 0.02 / 100 },
  { id: '0.02-0.05%', lo:  0.02 / 100, hi: 0.05 / 100 },
  { id: '0.05-0.1%',  lo:  0.05 / 100, hi: 0.10 / 100 },
  { id: '0.1-0.25%',  lo:  0.10 / 100, hi: 0.25 / 100 },
  { id: '0.25-0.5%',  lo:  0.25 / 100, hi: 0.50 / 100 },
  { id: '0.5-1%',     lo:  0.50 / 100, hi: 1.0 / 100 },
  { id: '1-2%',       lo:  1.0 / 100,  hi: 2.0 / 100 },
  { id: '2-5%',       lo:  2.0 / 100,  hi: 5.0 / 100 },
  { id: '>5%',        lo:  5.0 / 100,  hi: 1.0 },
];
const MIN_ACTUAL = 2;  // signal threshold

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function median(arr: number[]): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function pearson(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length); if (n < 2) return 0;
  let mx = 0, my = 0; for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
  mx /= n; my /= n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = x[i] - mx, b = y[i] - my; num += a * b; dx += a * a; dy += b * b; }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
}

interface SlateData {
  slate: string;
  poolSize: number;
  fieldSize: number;
  /** Records per size: {predFreq, actualFreq} for combos with actual >= MIN_ACTUAL */
  recordsBySize: Record<number, { predFreq: number; actualFreq: number; sameTeam: boolean }[]>;
}

async function loadSlate(s: typeof SLATES[0]): Promise<SlateData | null> {
  const projPath = path.join(DIR, s.proj), actualsPath = path.join(DIR, s.actuals), poolPath = path.join(DIR, s.pool);
  if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) return null;
  const pr = parseCSVFile(projPath, 'mlb', true);
  const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
  const pool = buildPlayerPool(pr.players, pr.detectedContestType);
  const actuals = parseContestActuals(actualsPath, config);
  const idMap = new Map<string, Player>(); const nameMap = new Map<string, Player>();
  const teamById = new Map<string, string>();
  for (const p of pool.players) { idMap.set(p.id, p); nameMap.set(norm(p.name), p); teamById.set(p.id, (p.team || '').toUpperCase()); }
  const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
  const poolLineups = Array.from(new Map(loaded.lineups.map(l => [l.hash, l])).values());

  const entryIds: string[][] = [];
  for (const e of actuals.entries) {
    const ids: string[] = []; let ok = true;
    for (const nm of e.playerNames) { const pl = nameMap.get(norm(nm)); if (!pl) { ok = false; break; } ids.push(pl.id); }
    if (ok) entryIds.push(ids.sort());
  }
  const F = entryIds.length;
  const P = poolLineups.length;
  if (F < 100 || P < 100) return null;

  // Pool counts (predicted source).
  const poolCount: Record<number, Map<string, number>> = { 2: new Map(), 3: new Map(), 4: new Map(), 5: new Map() };
  for (const lu of poolLineups) {
    const ids = lu.players.map(p => p.id).sort();
    const n = ids.length;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      poolCount[2].set(ids[i] + '|' + ids[j], (poolCount[2].get(ids[i] + '|' + ids[j]) || 0) + 1);
      for (let l = j + 1; l < n; l++) {
        const k3 = ids[i] + '|' + ids[j] + '|' + ids[l];
        poolCount[3].set(k3, (poolCount[3].get(k3) || 0) + 1);
        for (let m = l + 1; m < n; m++) {
          const k4 = ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m];
          poolCount[4].set(k4, (poolCount[4].get(k4) || 0) + 1);
          for (let q = m + 1; q < n; q++) {
            const k5 = ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m] + '|' + ids[q];
            poolCount[5].set(k5, (poolCount[5].get(k5) || 0) + 1);
          }
        }
      }
    }
  }

  // Actual counts.
  const actualCount: Record<number, Map<string, number>> = { 2: new Map(), 3: new Map(), 4: new Map(), 5: new Map() };
  for (const ids of entryIds) {
    const n = ids.length;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      actualCount[2].set(ids[i] + '|' + ids[j], (actualCount[2].get(ids[i] + '|' + ids[j]) || 0) + 1);
      for (let l = j + 1; l < n; l++) {
        const k3 = ids[i] + '|' + ids[j] + '|' + ids[l];
        actualCount[3].set(k3, (actualCount[3].get(k3) || 0) + 1);
        for (let m = l + 1; m < n; m++) {
          const k4 = ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m];
          actualCount[4].set(k4, (actualCount[4].get(k4) || 0) + 1);
          for (let q = m + 1; q < n; q++) {
            const k5 = ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m] + '|' + ids[q];
            actualCount[5].set(k5, (actualCount[5].get(k5) || 0) + 1);
          }
        }
      }
    }
  }

  const recordsBySize: Record<number, { predFreq: number; actualFreq: number; sameTeam: boolean }[]> = { 2: [], 3: [], 4: [], 5: [] };
  for (const size of [2, 3, 4, 5] as const) {
    for (const [k, c] of actualCount[size]) {
      if (c < MIN_ACTUAL) continue;
      const ids = k.split('|');
      let team0 = ''; let sameTeam = true;
      for (const id of ids) { const t = teamById.get(id) || ''; if (!team0) team0 = t; else if (t !== team0) sameTeam = false; }
      const poolC = poolCount[size].get(k) || 0;
      recordsBySize[size].push({ predFreq: poolC / P, actualFreq: c / F, sameTeam });
    }
  }

  return { slate: s.slate, poolSize: P, fieldSize: F, recordsBySize };
}

interface CalibrationTable {
  /** size -> bucketId -> { multiplier, n } */
  bySize: Record<number, Record<string, { multiplier: number; n: number; medianPred: number; medianActual: number }>>;
}

function bucketOf(predFreq: number): string {
  for (const b of PRED_BUCKETS) if (predFreq >= b.lo && predFreq < b.hi) return b.id;
  return PRED_BUCKETS[PRED_BUCKETS.length - 1].id;
}

function fitCalibration(slates: SlateData[]): CalibrationTable {
  const bySize: Record<number, Record<string, { multiplier: number; n: number; medianPred: number; medianActual: number }>> = { 2: {}, 3: {}, 4: {}, 5: {} };
  for (const size of [2, 3, 4, 5] as const) {
    const buckets = new Map<string, { ratios: number[]; preds: number[]; actuals: number[] }>();
    for (const sd of slates) {
      for (const r of sd.recordsBySize[size]) {
        const id = bucketOf(r.predFreq);
        if (!buckets.has(id)) buckets.set(id, { ratios: [], preds: [], actuals: [] });
        const b = buckets.get(id)!;
        // For pred=0 we still want a "calibrated" estimate. Use ratio against a tiny floor.
        const safePred = r.predFreq > 0 ? r.predFreq : 1e-9;
        b.ratios.push(r.actualFreq / safePred);
        b.preds.push(r.predFreq);
        b.actuals.push(r.actualFreq);
      }
    }
    for (const [id, b] of buckets) {
      bySize[size][id] = {
        multiplier: median(b.ratios),
        n: b.ratios.length,
        medianPred: median(b.preds),
        medianActual: median(b.actuals),
      };
    }
  }
  return { bySize };
}

function applyCalibration(predFreq: number, size: number, table: CalibrationTable, fallbackMissingFreq: number): number {
  const id = bucketOf(predFreq);
  const cell = table.bySize[size]?.[id];
  if (!cell) return predFreq > 0 ? predFreq : fallbackMissingFreq;
  if (predFreq <= 0) return cell.medianActual;  // for absent combos, predict the median actual freq for that size's "absent" bucket
  return predFreq * cell.multiplier;
}

interface EvalResult {
  slate: string;
  size: number;
  uncal_pearson_log: number;
  cal_pearson_log: number;
  uncal_median_relErr: number;
  cal_median_relErr: number;
  uncal_median_absErr_pct: number;
  cal_median_absErr_pct: number;
  scoredCombos: number;
}

function evaluate(slate: SlateData, table: CalibrationTable): EvalResult[] {
  const results: EvalResult[] = [];
  for (const size of [2, 3, 4, 5] as const) {
    const recs = slate.recordsBySize[size];
    if (!recs.length) continue;
    const fallback = 0.5 / slate.poolSize;
    const uncalLog: number[] = []; const calLog: number[] = []; const actLog: number[] = [];
    const uncalRel: number[] = []; const calRel: number[] = [];
    const uncalAbs: number[] = []; const calAbs: number[] = [];
    for (const r of recs) {
      const a = r.actualFreq;
      const u = r.predFreq > 0 ? r.predFreq : fallback;
      const c = applyCalibration(r.predFreq, size, table, fallback);
      uncalLog.push(Math.log(u + 1e-12));
      calLog.push(Math.log(c + 1e-12));
      actLog.push(Math.log(a + 1e-12));
      const aPct = a * 100;
      uncalRel.push(aPct > 0 ? Math.abs(u * 100 - aPct) / aPct : 0);
      calRel.push(aPct > 0 ? Math.abs(c * 100 - aPct) / aPct : 0);
      uncalAbs.push(Math.abs(u * 100 - aPct));
      calAbs.push(Math.abs(c * 100 - aPct));
    }
    results.push({
      slate: slate.slate, size, scoredCombos: recs.length,
      uncal_pearson_log: pearson(uncalLog, actLog),
      cal_pearson_log: pearson(calLog, actLog),
      uncal_median_relErr: median(uncalRel),
      cal_median_relErr: median(calRel),
      uncal_median_absErr_pct: median(uncalAbs),
      cal_median_absErr_pct: median(calAbs),
    });
  }
  return results;
}

async function main() {
  console.log('=== Argus calibration: empirical concentration multiplier ===\n');

  const slates: SlateData[] = [];
  for (const s of SLATES) {
    process.stdout.write(s.slate.padEnd(15) + ' ');
    const sd = await loadSlate(s);
    if (sd) {
      slates.push(sd);
      console.log(`F=${sd.fieldSize.toString().padStart(6)} P=${sd.poolSize.toString().padStart(5)} ` +
        `s2=${sd.recordsBySize[2].length} s3=${sd.recordsBySize[3].length} s4=${sd.recordsBySize[4].length} s5=${sd.recordsBySize[5].length}`);
    } else {
      console.log('skip');
    }
  }
  console.log(`\nLoaded ${slates.length} slates.\n`);

  // Final fit on ALL slates (this is what we ship).
  const finalTable = fitCalibration(slates);

  // Print the calibration table.
  console.log('================================================================');
  console.log('CALIBRATION TABLE (median actual/predicted ratio per size × predicted-bucket)');
  console.log('================================================================');
  console.log('size | bucket       |     n    | median pred% | median actual% | multiplier');
  for (const size of [2, 3, 4, 5]) {
    for (const b of PRED_BUCKETS) {
      const cell = finalTable.bySize[size]?.[b.id];
      if (!cell || cell.n < 50) continue;
      console.log(
        `  ${size}  | ${b.id.padEnd(11)} | ${String(cell.n).padStart(7)} | ` +
        `${(cell.medianPred * 100).toFixed(3).padStart(11)}% | ` +
        `${(cell.medianActual * 100).toFixed(3).padStart(13)}% | ` +
        `${cell.multiplier.toFixed(2).padStart(8)}x`
      );
    }
    console.log('');
  }

  // LOO validation.
  console.log('================================================================');
  console.log('LEAVE-ONE-OUT VALIDATION (uncalibrated vs calibrated)');
  console.log('================================================================\n');

  const looBySize: Record<number, EvalResult[]> = { 2: [], 3: [], 4: [], 5: [] };
  for (let i = 0; i < slates.length; i++) {
    const heldOut = slates[i];
    const train = slates.filter((_, j) => j !== i);
    const trainTable = fitCalibration(train);
    const evals = evaluate(heldOut, trainTable);
    for (const r of evals) looBySize[r.size].push(r);
  }

  console.log('size | mean uncal Pearson | mean cal Pearson | uncal med relErr | cal med relErr | uncal med absErr% | cal med absErr% | wins');
  for (const size of [2, 3, 4, 5]) {
    const rs = looBySize[size];
    if (!rs.length) continue;
    const meanU = rs.reduce((s, r) => s + r.uncal_pearson_log, 0) / rs.length;
    const meanC = rs.reduce((s, r) => s + r.cal_pearson_log, 0) / rs.length;
    const meanRU = rs.reduce((s, r) => s + r.uncal_median_relErr, 0) / rs.length;
    const meanRC = rs.reduce((s, r) => s + r.cal_median_relErr, 0) / rs.length;
    const meanAU = rs.reduce((s, r) => s + r.uncal_median_absErr_pct, 0) / rs.length;
    const meanAC = rs.reduce((s, r) => s + r.cal_median_absErr_pct, 0) / rs.length;
    const calWinsRel = rs.filter(r => r.cal_median_relErr < r.uncal_median_relErr).length;
    console.log(
      `  ${size}  | ${meanU.toFixed(3).padStart(13)} | ${meanC.toFixed(3).padStart(13)} | ` +
      `${(meanRU * 100).toFixed(0).padStart(13)}% | ${(meanRC * 100).toFixed(0).padStart(11)}% | ` +
      `${meanAU.toFixed(3).padStart(13)}% | ${meanAC.toFixed(3).padStart(11)}% | ${calWinsRel}/${rs.length}`
    );
  }

  // Also check: LOO fit consistency (do multipliers stable across folds?)
  console.log('\n--- Multiplier stability across LOO folds (size 4) ---');
  console.log('bucket       | min mult | median mult | max mult | std');
  const fold4Mults: Record<string, number[]> = {};
  for (let i = 0; i < slates.length; i++) {
    const train = slates.filter((_, j) => j !== i);
    const t = fitCalibration(train);
    for (const b of PRED_BUCKETS) {
      const cell = t.bySize[4]?.[b.id];
      if (cell && cell.n >= 50) {
        if (!fold4Mults[b.id]) fold4Mults[b.id] = [];
        fold4Mults[b.id].push(cell.multiplier);
      }
    }
  }
  for (const b of PRED_BUCKETS) {
    const arr = fold4Mults[b.id]; if (!arr || arr.length < 5) continue;
    const sorted = [...arr].sort((a, b) => a - b);
    const m = arr.reduce((s, x) => s + x, 0) / arr.length;
    const std = Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
    console.log(`  ${b.id.padEnd(11)} | ${sorted[0].toFixed(2).padStart(7)}x | ${sorted[Math.floor(sorted.length / 2)].toFixed(2).padStart(10)}x | ${sorted[sorted.length - 1].toFixed(2).padStart(7)}x | ${std.toFixed(2)}`);
  }

  // Save final calibration table.
  if (!fs.existsSync(path.dirname(OUT_JSON))) fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify({
    generated_at: new Date().toISOString(),
    n_slates: slates.length,
    buckets: PRED_BUCKETS,
    table: finalTable.bySize,
    notes: 'Per-size, per-predicted-bucket median(actual/predicted) ratio. Apply: calibrated_pred = pred * multiplier(bucket). For pred=0 (absent combo), use medianActual of the absent bucket as the calibrated prediction.',
  }, null, 2));
  console.log(`\nSaved calibration table to ${OUT_JSON}`);

  // Save LOO eval CSV.
  if (!fs.existsSync(path.dirname(OUT_CSV))) fs.mkdirSync(path.dirname(OUT_CSV), { recursive: true });
  const csvLines = ['slate,size,scored,uncal_pearson_log,cal_pearson_log,uncal_med_relErr,cal_med_relErr,uncal_med_absErr_pct,cal_med_absErr_pct'];
  for (const size of [2, 3, 4, 5]) for (const r of looBySize[size]) {
    csvLines.push([r.slate, r.size, r.scoredCombos, r.uncal_pearson_log.toFixed(4), r.cal_pearson_log.toFixed(4),
      r.uncal_median_relErr.toFixed(4), r.cal_median_relErr.toFixed(4),
      r.uncal_median_absErr_pct.toFixed(4), r.cal_median_absErr_pct.toFixed(4)].join(','));
  }
  fs.writeFileSync(OUT_CSV, csvLines.join('\n'));
  console.log(`Saved LOO eval to ${OUT_CSV}`);
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
