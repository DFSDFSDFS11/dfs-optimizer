/**
 * Compare TWO field-freq prediction models against actual contest entries:
 *
 *   pred_indep(C) = product of (Adj Own / 100)         — current Argus model
 *   pred_pool(C)  = (# SS pool lineups containing C) / pool_size  — Argus-v4 model
 *   actual(C)     = (# contest entries containing C) / total_entries
 *
 * For each combo size in {2,3,4,5}:
 *   - Pearson(log_pred, log_actual) for both models
 *   - Bias mean log(actual/pred) for both
 *   - Same-team vs diff-team bias breakdown for both
 *   - % of combos where each model is closer to truth
 *
 * Higher Pearson + lower |bias| + smaller same-vs-diff gap = better model.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as csvParse } from 'csv-parse/sync';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';

const DIR = 'C:/Users/colin/dfs opto';

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

const MIN_ACTUAL_COUNT = 2;
const SMALL = 1e-9;

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function mean(a: number[]): number { if (!a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; }
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
function loadAdjOwn(p: string): Map<string, number> {
  if (!fs.existsSync(p)) return new Map();
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

interface SizeReport {
  size: number;
  scoredCombos: number;
  // Independence model (current Argus).
  indep_pearson: number;
  indep_meanBias: number;
  indep_sameTeamBias: number;
  indep_diffTeamBias: number;
  // Pool model (Argus-v4).
  pool_pearson: number;
  pool_meanBias: number;
  pool_sameTeamBias: number;
  pool_diffTeamBias: number;
  // Direct comparison.
  poolBetterPearson: boolean;
  poolBetterBias: boolean;
}

interface SlateReport {
  slate: string;
  fieldEntries: number;
  poolSize: number;
  bySize: Record<number, SizeReport>;
}

async function main() {
  console.log('=== Field-freq model comparison: independence vs SS pool, 16 dev slates ===\n');

  const allReports: SlateReport[] = [];

  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj), actualsPath = path.join(DIR, s.actuals), poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) { console.log('skip ' + s.slate); continue; }
    process.stdout.write(s.slate.padEnd(15) + ' ');

    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);
    const adjOwnById = loadAdjOwn(projPath);
    const idMap = new Map<string, Player>();
    const nameMap = new Map<string, Player>();
    const ownDecById = new Map<string, number>();
    const teamById = new Map<string, string>();
    for (const p of pool.players) {
      idMap.set(p.id, p);
      nameMap.set(norm(p.name), p);
      const adj = adjOwnById.get(p.id);
      const o = (adj !== undefined ? adj : (p.ownership || 0)) / 100;
      ownDecById.set(p.id, Math.max(0, o));
      teamById.set(p.id, (p.team || '').toUpperCase());
    }
    const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
    const poolLineups = Array.from(new Map(loaded.lineups.map(l => [l.hash, l])).values());

    // Resolve every actual entry's player IDs.
    const entryIds: string[][] = [];
    for (const e of actuals.entries) {
      const ids: string[] = []; let ok = true;
      for (const nm of e.playerNames) {
        const pl = nameMap.get(norm(nm)); if (!pl) { ok = false; break; }
        ids.push(pl.id);
      }
      if (ok) entryIds.push(ids.sort());
    }
    const F = entryIds.length;
    const P = poolLineups.length;
    if (F < 100 || P < 100) { console.log('skip (F=' + F + ', P=' + P + ')'); continue; }

    const report: SlateReport = { slate: s.slate, fieldEntries: F, poolSize: P, bySize: {} };

    // Pool combo counts (Argus-v4 model). Built once per slate.
    const poolCount: Record<number, Map<string, number>> = { 2: new Map(), 3: new Map(), 4: new Map(), 5: new Map() };
    for (const lu of poolLineups) {
      const ids = lu.players.map(p => p.id).sort();
      const n = ids.length;
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        const k2 = ids[i] + '|' + ids[j];
        poolCount[2].set(k2, (poolCount[2].get(k2) || 0) + 1);
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

    for (const size of [2, 3, 4, 5] as const) {
      // Actual combo counts.
      const actualCount = new Map<string, number>();
      for (const ids of entryIds) {
        const n = ids.length;
        if (size === 2) {
          for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
            const k = ids[i] + '|' + ids[j];
            actualCount.set(k, (actualCount.get(k) || 0) + 1);
          }
        } else if (size === 3) {
          for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let l = j + 1; l < n; l++) {
            const k = ids[i] + '|' + ids[j] + '|' + ids[l];
            actualCount.set(k, (actualCount.get(k) || 0) + 1);
          }
        } else if (size === 4) {
          for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let l = j + 1; l < n; l++) for (let m = l + 1; m < n; m++) {
            const k = ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m];
            actualCount.set(k, (actualCount.get(k) || 0) + 1);
          }
        } else {
          for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let l = j + 1; l < n; l++) for (let m = l + 1; m < n; m++) for (let q = m + 1; q < n; q++) {
            const k = ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m] + '|' + ids[q];
            actualCount.set(k, (actualCount.get(k) || 0) + 1);
          }
        }
      }

      const indepLog: number[] = [], poolLog: number[] = [], actLog: number[] = [];
      const records: { sameTeam: boolean; indepBias: number; poolBias: number }[] = [];
      for (const [k, c] of actualCount) {
        if (c < MIN_ACTUAL_COUNT) continue;
        const ids = k.split('|');
        let predIndep = 1; let team0 = ''; let sameTeam = true;
        for (const id of ids) {
          predIndep *= (ownDecById.get(id) || 0);
          const t = teamById.get(id) || '';
          if (!team0) team0 = t;
          else if (t !== team0) sameTeam = false;
        }
        const poolC = poolCount[size].get(k) || 0;
        const predPool = poolC / P;

        const actualFreq = c / F;
        const logPI = Math.log(predIndep + SMALL);
        const logPP = Math.log(predPool + SMALL);
        const logA = Math.log(actualFreq + SMALL);

        indepLog.push(logPI);
        poolLog.push(logPP);
        actLog.push(logA);
        records.push({ sameTeam, indepBias: logA - logPI, poolBias: logA - logPP });
      }

      const indep_pearson = pearson(indepLog, actLog);
      const pool_pearson = pearson(poolLog, actLog);

      const indep_meanBias = mean(records.map(r => r.indepBias));
      const pool_meanBias = mean(records.map(r => r.poolBias));

      const sameRecs = records.filter(r => r.sameTeam);
      const diffRecs = records.filter(r => !r.sameTeam);
      const indep_sameTeamBias = sameRecs.length ? mean(sameRecs.map(r => r.indepBias)) : 0;
      const indep_diffTeamBias = diffRecs.length ? mean(diffRecs.map(r => r.indepBias)) : 0;
      const pool_sameTeamBias = sameRecs.length ? mean(sameRecs.map(r => r.poolBias)) : 0;
      const pool_diffTeamBias = diffRecs.length ? mean(diffRecs.map(r => r.poolBias)) : 0;

      report.bySize[size] = {
        size, scoredCombos: records.length,
        indep_pearson, indep_meanBias, indep_sameTeamBias, indep_diffTeamBias,
        pool_pearson, pool_meanBias, pool_sameTeamBias, pool_diffTeamBias,
        poolBetterPearson: pool_pearson > indep_pearson,
        poolBetterBias: Math.abs(pool_meanBias) < Math.abs(indep_meanBias),
      };
    }

    process.stdout.write(`F=${F.toString().padStart(6)} P=${P.toString().padStart(5)} `);
    for (const size of [2, 3, 4, 5]) {
      const r = report.bySize[size]; if (!r) continue;
      process.stdout.write(`s${size}: indep r=${r.indep_pearson.toFixed(2)} bias=${r.indep_meanBias.toFixed(2)} | pool r=${r.pool_pearson.toFixed(2)} bias=${r.pool_meanBias.toFixed(2)}  `);
    }
    console.log('');
    allReports.push(report);
  }

  // Aggregate.
  console.log('\n================================================================');
  console.log('AGGREGATE — Independence (current) vs Pool (proposed v4) field model');
  console.log('================================================================\n');
  console.log(`size | indep r | pool r | indep |bias| | pool |bias| | indep same-T bias | pool same-T bias | indep diff-T | pool diff-T`);
  for (const size of [2, 3, 4, 5]) {
    const reports = allReports.map(r => r.bySize[size]).filter(r => r);
    if (!reports.length) continue;
    const indep_r = mean(reports.map(r => r.indep_pearson));
    const pool_r = mean(reports.map(r => r.pool_pearson));
    const indep_bias = mean(reports.map(r => Math.abs(r.indep_meanBias)));
    const pool_bias = mean(reports.map(r => Math.abs(r.pool_meanBias)));
    const indep_st = mean(reports.map(r => r.indep_sameTeamBias));
    const pool_st = mean(reports.map(r => r.pool_sameTeamBias));
    const indep_dt = mean(reports.map(r => r.indep_diffTeamBias));
    const pool_dt = mean(reports.map(r => r.pool_diffTeamBias));
    console.log(
      `  ${size}  |  ${indep_r.toFixed(2).padStart(6)}  |  ${pool_r.toFixed(2).padStart(5)}  |  ${indep_bias.toFixed(2).padStart(6)}  |  ${pool_bias.toFixed(2).padStart(5)}  |  ` +
      `${indep_st > 0 ? '+' : ''}${indep_st.toFixed(2).padStart(8)}  |  ${pool_st > 0 ? '+' : ''}${pool_st.toFixed(2).padStart(8)}  |  ` +
      `${indep_dt > 0 ? '+' : ''}${indep_dt.toFixed(2).padStart(7)}  |  ${pool_dt > 0 ? '+' : ''}${pool_dt.toFixed(2).padStart(6)}`
    );
  }

  // Per-slate winner counts.
  console.log('\nPer-slate: which model has higher Pearson at each size?');
  console.log('size | indep wins | pool wins');
  for (const size of [2, 3, 4, 5]) {
    const reports = allReports.map(r => r.bySize[size]).filter(r => r);
    const poolWins = reports.filter(r => r.poolBetterPearson).length;
    const indepWins = reports.length - poolWins;
    console.log(`  ${size}  |  ${indepWins.toString().padStart(2)}        |  ${poolWins.toString().padStart(2)}  ${poolWins > indepWins ? '<-- pool better' : ''}`);
  }

  console.log('\nPer-slate: which model has lower |bias| at each size?');
  console.log('size | indep wins | pool wins');
  for (const size of [2, 3, 4, 5]) {
    const reports = allReports.map(r => r.bySize[size]).filter(r => r);
    const poolWins = reports.filter(r => r.poolBetterBias).length;
    const indepWins = reports.length - poolWins;
    console.log(`  ${size}  |  ${indepWins.toString().padStart(2)}        |  ${poolWins.toString().padStart(2)}  ${poolWins > indepWins ? '<-- pool better' : ''}`);
  }
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
