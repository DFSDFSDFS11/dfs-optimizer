/**
 * Concrete answer to "how close are we for predicting actual % of combos
 * of players in the field." For each combo size, on each slate:
 *   - keep only combos that appear ≥ MIN_K times in actuals (signal)
 *   - compare pool-model prediction (count_in_pool / pool_size) vs actual %
 *   - report distribution of absolute error |pred% - actual%| AND ratio actual/pred
 *   - bucket by actual% to show where the model is more / less accurate
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';

const DIR = 'C:/Users/colin/dfs opto';
const MIN_K = 5;  // only score combos that appear at least MIN_K times in actuals

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

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function quantile(sortedAsc: number[], q: number): number {
  if (!sortedAsc.length) return 0;
  return sortedAsc[Math.floor(q * (sortedAsc.length - 1))];
}

// Aggregate records per size across ALL slates.
const allRecords: Record<number, { actualPct: number; predPct: number; absErr: number; ratio: number; sameTeam: boolean }[]> = { 2: [], 3: [], 4: [], 5: [] };

async function main() {
  console.log('=== Pool-model prediction accuracy: actual % vs predicted %, 16 slates ===');
  console.log('   Only scoring combos with actual count ≥ ' + MIN_K + ' (signal)\n');

  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj), actualsPath = path.join(DIR, s.actuals), poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) { continue; }

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
    if (F < 100 || P < 100) continue;

    // Pool counts.
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

    for (const size of [2, 3, 4, 5] as const) {
      for (const [k, c] of actualCount[size]) {
        if (c < MIN_K) continue;
        const actualPct = c / F * 100;
        const poolC = poolCount[size].get(k) || 0;
        const predPct = poolC / P * 100;
        const absErr = Math.abs(predPct - actualPct);
        const ratio = predPct > 0 ? actualPct / predPct : Infinity;
        const ids = k.split('|');
        let team0 = ''; let sameTeam = true;
        for (const id of ids) { const t = teamById.get(id) || ''; if (!team0) team0 = t; else if (t !== team0) sameTeam = false; }
        allRecords[size].push({ actualPct, predPct, absErr, ratio, sameTeam });
      }
    }
    process.stdout.write('.');
  }
  console.log('\n');

  console.log('================================================================');
  console.log('AGGREGATE — pool-model accuracy at predicting actual % of contest entries containing combo');
  console.log('================================================================\n');
  console.log('size | scored | median actual% | median pred% | median |abs err| | median |err|/actual | p75 |err|/actual');
  for (const size of [2, 3, 4, 5]) {
    const recs = allRecords[size];
    if (!recs.length) continue;
    const actuals = recs.map(r => r.actualPct).sort((a, b) => a - b);
    const preds = recs.map(r => r.predPct).sort((a, b) => a - b);
    const errs = recs.map(r => r.absErr).sort((a, b) => a - b);
    const relErrs = recs.map(r => r.actualPct > 0 ? r.absErr / r.actualPct : 0).sort((a, b) => a - b);
    console.log(
      `  ${size}  | ${String(recs.length).padStart(7)} | ${quantile(actuals, 0.5).toFixed(3).padStart(13)}% | ${quantile(preds, 0.5).toFixed(3).padStart(11)}% | ` +
      `${quantile(errs, 0.5).toFixed(3).padStart(15)}% | ${(quantile(relErrs, 0.5) * 100).toFixed(0).padStart(18)}% | ` +
      `${(quantile(relErrs, 0.75) * 100).toFixed(0).padStart(15)}%`
    );
  }

  console.log('\n--- Bucket by actual % (size 4): how does accuracy depend on combo popularity? ---');
  console.log('actual%-bucket | combos | median pred% | median |err| | median |err|/actual');
  for (const [lo, hi, label] of [[0, 0.05, '0.0-0.05%'], [0.05, 0.1, '0.05-0.1%'], [0.1, 0.5, '0.1-0.5%'], [0.5, 1.0, '0.5-1%'], [1.0, 5.0, '1-5%'], [5.0, 100, '>5%']] as [number, number, string][]) {
    const recs = allRecords[4].filter(r => r.actualPct >= lo && r.actualPct < hi);
    if (!recs.length) { console.log(`  ${label.padEnd(13)} | ${'0'.padStart(6)} | -`); continue; }
    const preds = recs.map(r => r.predPct).sort((a, b) => a - b);
    const errs = recs.map(r => r.absErr).sort((a, b) => a - b);
    const relErrs = recs.map(r => r.actualPct > 0 ? r.absErr / r.actualPct : 0).sort((a, b) => a - b);
    console.log(`  ${label.padEnd(13)} | ${String(recs.length).padStart(6)} | ${quantile(preds, 0.5).toFixed(3).padStart(10)}% | ${quantile(errs, 0.5).toFixed(3).padStart(10)}% | ${(quantile(relErrs, 0.5) * 100).toFixed(0).padStart(17)}%`);
  }

  console.log('\n--- Same-team vs diff-team accuracy ---');
  console.log('size | combo type | combos | median actual% | median pred% | median |err|/actual');
  for (const size of [2, 3, 4, 5]) {
    for (const [type, sameTeam] of [['same-team', true], ['diff-team', false]] as [string, boolean][]) {
      const recs = allRecords[size].filter(r => r.sameTeam === sameTeam);
      if (!recs.length) continue;
      const actuals = recs.map(r => r.actualPct).sort((a, b) => a - b);
      const preds = recs.map(r => r.predPct).sort((a, b) => a - b);
      const relErrs = recs.map(r => r.actualPct > 0 ? r.absErr / r.actualPct : 0).sort((a, b) => a - b);
      console.log(`  ${size}  | ${type.padEnd(10)} | ${String(recs.length).padStart(6)} | ${quantile(actuals, 0.5).toFixed(3).padStart(13)}% | ${quantile(preds, 0.5).toFixed(3).padStart(11)}% | ${(quantile(relErrs, 0.5) * 100).toFixed(0).padStart(17)}%`);
    }
  }

  console.log('\n--- Top-5 highest-actual-% combos at each size: how close was prediction? ---');
  for (const size of [2, 3, 4, 5]) {
    const sorted = [...allRecords[size]].sort((a, b) => b.actualPct - a.actualPct).slice(0, 5);
    console.log(`size ${size}:`);
    for (const r of sorted) {
      console.log(`  actual=${r.actualPct.toFixed(2).padStart(5)}%  predicted=${r.predPct.toFixed(2).padStart(5)}%  off by ${(r.absErr / r.actualPct * 100).toFixed(0)}%`);
    }
  }
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
