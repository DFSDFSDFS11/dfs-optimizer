/**
 * Validate predicted field combo frequency (Adj Own product) vs the actual
 * combo frequency observed in contest entries, across the 16 dev slates.
 *
 * For each combo size in {2,3,4,5}, on each slate:
 *   predicted_freq(C) = product of (Adj Own / 100) for each player in C
 *   actual_freq(C)    = (# of contest entries containing C) / (total entries)
 *
 * Reports:
 *   - Pearson + Spearman correlation pred vs actual on combos with actual ≥ 2
 *   - Bias: log(actual / predicted) — positive = under-predicted by independence model
 *   - Top under-predicted and over-predicted combos per size (named with players)
 *   - Aggregate cross-slate signal
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as csvParse } from 'csv-parse/sync';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';

const DIR = 'C:/Users/colin/dfs opto';
const OUT = path.join(DIR, 'multi_combo_penalty_implementation', 'verification', 'field_freq_pred_vs_actual.csv');

const SLATES = [
  { slate: '4-8-26',         proj: '4-8-26projections.csv',         actuals: '4-8-26actuals.csv' },
  { slate: '4-12-26',        proj: '4-12-26projections.csv',        actuals: '4-12-26actuals.csv' },
  { slate: '4-17-26',        proj: '4-17-26projections.csv',        actuals: '4-17-26actuals.csv' },
  { slate: '4-18-26',        proj: '4-18-26projections.csv',        actuals: '4-18-26actuals.csv' },
  { slate: '4-21-26',        proj: '4-21-26projections.csv',        actuals: '4-21-26actuals.csv' },
  { slate: '4-22-26',        proj: '4-22-26projections.csv',        actuals: '4-22-26actuals.csv' },
  { slate: '4-23-26',        proj: '4-23-26projections.csv',        actuals: '4-23-26actuals.csv' },
  { slate: '4-24-26',        proj: '4-24-26projections.csv',        actuals: '4-24-26actuals.csv' },
  { slate: '4-25-26',        proj: '4-25-26projections.csv',        actuals: '4-25-26actuals.csv' },
  { slate: '4-25-26-early',  proj: '4-25-26projectionsearly.csv',   actuals: '4-25-26actualsearly.csv' },
  { slate: '4-26-26',        proj: '4-26-26projections.csv',        actuals: '4-26-26actuals.csv' },
  { slate: '4-27-26',        proj: '4-27-26projections.csv',        actuals: '4-27-26actuals.csv' },
  { slate: '4-28-26',        proj: '4-28-26projections.csv',        actuals: '4-28-26actuals.csv' },
  { slate: '4-29-26',        proj: '4-29-26projections.csv',        actuals: '4-29-26actuals.csv' },
  { slate: '5-2-26-main',    proj: '5-2-26projectionsmain.csv',     actuals: '5-2-26actualsmain.csv' },
  { slate: '5-3-26',         proj: '5-3-26projections.csv',         actuals: '5-3-26actuals.csv' },
];

const MIN_ACTUAL_COUNT = 2;     // only score combos that appear at least this often in actuals
const TOP_REPORT = 10;          // top mispredictions to surface per size

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
  pearson_log: number;
  spearman: number;
  meanLogRatio: number;        // log(actual/pred) — positive means actual > predicted (independence under-predicts)
  medianLogRatio: number;
  pctActualHigher: number;     // fraction of combos where actual > pred
  topUnderPred: { combo: string; predFreq: number; actualFreq: number; logRatio: number }[];
  topOverPred: { combo: string; predFreq: number; actualFreq: number; logRatio: number }[];
  // Same-team correlation diagnostic.
  sameTeamCount: number;
  sameTeamMeanLogRatio: number;
  diffTeamCount: number;
  diffTeamMeanLogRatio: number;
}

interface SlateReport {
  slate: string;
  fieldEntries: number;
  bySize: Record<number, SizeReport>;
  nameById: Map<string, string>;
  teamById: Map<string, string>;
  ownPctById: Map<string, number>;
}

async function main() {
  console.log('=== Field freq prediction (Adj Own product) vs actual contest entries — 16 dev slates ===\n');

  const allReports: SlateReport[] = [];
  const csvRows: string[] = ['slate,size,scored_combos,pearson_log,spearman,mean_log_ratio,median_log_ratio,pct_actual_higher,sameteam_count,sameteam_mean_log_ratio,diffteam_count,diffteam_mean_log_ratio'];

  // Aggregate top mispredictions across slates.
  const aggUnderPredBySize: Record<number, { slate: string; combo: string; predFreq: number; actualFreq: number; logRatio: number }[]> = { 2: [], 3: [], 4: [], 5: [] };
  const aggOverPredBySize: Record<number, { slate: string; combo: string; predFreq: number; actualFreq: number; logRatio: number }[]> = { 2: [], 3: [], 4: [], 5: [] };

  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj), actualsPath = path.join(DIR, s.actuals);
    if (![projPath, actualsPath].every(p => fs.existsSync(p))) { console.log('skip ' + s.slate); continue; }
    process.stdout.write(s.slate.padEnd(15) + ' ');

    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);
    const adjOwnById = loadAdjOwn(projPath);

    // Build name → player and id → ownership decimal.
    const nameMap = new Map<string, Player>();
    const ownDecById = new Map<string, number>();
    const teamById = new Map<string, string>();
    const nameById = new Map<string, string>();
    for (const p of pool.players) {
      nameMap.set(norm(p.name), p);
      const adj = adjOwnById.get(p.id);
      const o = (adj !== undefined ? adj : (p.ownership || 0)) / 100;
      ownDecById.set(p.id, Math.max(0, o));
      teamById.set(p.id, (p.team || '').toUpperCase());
      nameById.set(p.id, p.name);
    }

    // Resolve every entry's player IDs.
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
    if (F < 100) { console.log('skip (too few resolvable entries: ' + F + ')'); continue; }

    const ownPctById = new Map<string, number>();
    for (const [id, dec] of ownDecById) ownPctById.set(id, dec * 100);
    const report: SlateReport = { slate: s.slate, fieldEntries: F, bySize: {}, nameById, teamById, ownPctById };

    for (const size of [2, 3, 4, 5] as const) {
      // Count actual combo occurrences. Cap at top by frequency to keep memory tractable.
      const actualCount = new Map<string, number>();
      for (const ids of entryIds) {
        const n = ids.length;
        // enumerate combos of `size` from sorted IDs
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
        } else { // size 5
          for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let l = j + 1; l < n; l++) for (let m = l + 1; m < n; m++) for (let q = m + 1; q < n; q++) {
            const k = ids[i] + '|' + ids[j] + '|' + ids[l] + '|' + ids[m] + '|' + ids[q];
            actualCount.set(k, (actualCount.get(k) || 0) + 1);
          }
        }
      }

      // Predicted freq + actual freq for combos with actual ≥ MIN_ACTUAL_COUNT.
      const predLog: number[] = [], actLog: number[] = [];
      const records: { combo: string; predFreq: number; actualFreq: number; logRatio: number; sameTeam: boolean }[] = [];
      const SMALL = 1e-9;
      for (const [k, c] of actualCount) {
        if (c < MIN_ACTUAL_COUNT) continue;
        const ids = k.split('|');
        let pred = 1; let team0 = ''; let sameTeam = true;
        for (const id of ids) {
          pred *= (ownDecById.get(id) || 0);
          const t = teamById.get(id) || '';
          if (!team0) team0 = t;
          else if (t !== team0) sameTeam = false;
        }
        const actualFreq = c / F;
        const logPred = Math.log(pred + SMALL);
        const logAct = Math.log(actualFreq + SMALL);
        predLog.push(logPred);
        actLog.push(logAct);
        records.push({ combo: k, predFreq: pred, actualFreq, logRatio: logAct - logPred, sameTeam });
      }

      // Stats.
      const pearson_log = pearson(predLog, actLog);
      const predRanks = rankPercentile(predLog);
      const actRanks = rankPercentile(actLog);
      const spearman = pearson(predRanks, actRanks);
      const logRatios = records.map(r => r.logRatio).sort((a, b) => a - b);
      const medianLogRatio = logRatios.length ? logRatios[Math.floor(logRatios.length / 2)] : 0;
      const meanLogRatio = mean(records.map(r => r.logRatio));
      const pctActualHigher = records.length ? records.filter(r => r.logRatio > 0).length / records.length : 0;

      // Same-team vs diff-team breakdown (for size ≥ 2).
      const sameTeamRecs = records.filter(r => r.sameTeam);
      const diffTeamRecs = records.filter(r => !r.sameTeam);
      const sameTeamMeanLogRatio = sameTeamRecs.length ? mean(sameTeamRecs.map(r => r.logRatio)) : 0;
      const diffTeamMeanLogRatio = diffTeamRecs.length ? mean(diffTeamRecs.map(r => r.logRatio)) : 0;

      // Top mispredictions.
      const sortedByRatio = [...records].sort((a, b) => b.logRatio - a.logRatio);
      const topUnder = sortedByRatio.slice(0, TOP_REPORT);
      const topOver = sortedByRatio.slice(-TOP_REPORT).reverse();

      const sizeReport: SizeReport = {
        size, scoredCombos: records.length, pearson_log, spearman,
        meanLogRatio, medianLogRatio, pctActualHigher,
        topUnderPred: topUnder.map(r => ({ combo: r.combo, predFreq: r.predFreq, actualFreq: r.actualFreq, logRatio: r.logRatio })),
        topOverPred: topOver.map(r => ({ combo: r.combo, predFreq: r.predFreq, actualFreq: r.actualFreq, logRatio: r.logRatio })),
        sameTeamCount: sameTeamRecs.length,
        sameTeamMeanLogRatio,
        diffTeamCount: diffTeamRecs.length,
        diffTeamMeanLogRatio,
      };
      report.bySize[size] = sizeReport;

      csvRows.push([s.slate, size, records.length, pearson_log.toFixed(4), spearman.toFixed(4),
        meanLogRatio.toFixed(4), medianLogRatio.toFixed(4), pctActualHigher.toFixed(4),
        sameTeamRecs.length, sameTeamMeanLogRatio.toFixed(4), diffTeamRecs.length, diffTeamMeanLogRatio.toFixed(4)].join(','));

      // Aggregate top mispredictions across slates.
      for (const r of topUnder) aggUnderPredBySize[size].push({ slate: s.slate, ...r });
      for (const r of topOver) aggOverPredBySize[size].push({ slate: s.slate, ...r });
    }

    process.stdout.write(`F=${F.toString().padStart(6)} `);
    for (const size of [2, 3, 4, 5]) {
      const sr = report.bySize[size];
      if (sr) process.stdout.write(`s${size}: r=${sr.pearson_log.toFixed(2)} biasΔ=${sr.meanLogRatio.toFixed(2)} same/diff=${sr.sameTeamMeanLogRatio.toFixed(2)}/${sr.diffTeamMeanLogRatio.toFixed(2)}  `);
    }
    console.log('');
    allReports.push(report);
  }

  // Aggregate.
  console.log('\n================================================================');
  console.log('AGGREGATE — predicted vs actual field combo frequency');
  console.log('================================================================');
  console.log('size | mean Pearson(log_pred,log_actual) | mean bias(log actual-log pred) | mean same-team bias | mean diff-team bias | % actual>pred');
  for (const size of [2, 3, 4, 5]) {
    const reports = allReports.map(r => r.bySize[size]).filter(r => r);
    if (!reports.length) continue;
    const meanPearson = mean(reports.map(r => r.pearson_log));
    const meanBias = mean(reports.map(r => r.meanLogRatio));
    const meanSameTeam = mean(reports.map(r => r.sameTeamMeanLogRatio).filter(v => v !== 0));
    const meanDiffTeam = mean(reports.map(r => r.diffTeamMeanLogRatio).filter(v => v !== 0));
    const meanPctAH = mean(reports.map(r => r.pctActualHigher));
    console.log(`size ${size}  |  r=${meanPearson.toFixed(3)}  |  bias=${meanBias > 0 ? '+' : ''}${meanBias.toFixed(2)}  |  same=${meanSameTeam.toFixed(2)}  |  diff=${meanDiffTeam.toFixed(2)}  |  ${(meanPctAH * 100).toFixed(0)}%`);
  }
  console.log('\n  bias > 0 means independence model UNDER-predicts how often the field plays this combo');
  console.log('  bias < 0 means model OVER-predicts');
  console.log('  same-team bias should be > diff-team bias if stack correlation matters');

  // Sample slate detail (first slate with data).
  if (allReports.length > 0) {
    const eg = allReports[0];
    console.log(`\n================================================================`);
    console.log(`EXAMPLE SLATE: ${eg.slate} (${eg.fieldEntries} entries)`);
    console.log(`================================================================`);
    for (const size of [2, 3, 4, 5]) {
      const sr = eg.bySize[size];
      if (!sr) continue;
      console.log(`\n--- size ${size} ---`);
      console.log(`  scored: ${sr.scoredCombos} combos with actual ≥ ${MIN_ACTUAL_COUNT}`);
      console.log(`  Pearson(log_pred, log_actual) = ${sr.pearson_log.toFixed(3)}, Spearman = ${sr.spearman.toFixed(3)}`);
      console.log(`  bias mean log(actual/pred) = ${sr.meanLogRatio.toFixed(2)}, median = ${sr.medianLogRatio.toFixed(2)}`);
      console.log(`  same-team(${sr.sameTeamCount}): mean=${sr.sameTeamMeanLogRatio.toFixed(2)}  diff-team(${sr.diffTeamCount}): mean=${sr.diffTeamMeanLogRatio.toFixed(2)}`);

      console.log(`  TOP 5 UNDER-PREDICTED (actual >> predicted):`);
      for (const r of sr.topUnderPred.slice(0, 5)) {
        const ids = r.combo.split('|');
        const desc = ids.map(id => `${(eg.nameById.get(id) || id).slice(0, 16)}(${eg.teamById.get(id) || '?'},${(eg.ownPctById.get(id) || 0).toFixed(0)}%)`).join(' + ');
        console.log(`    actual=${(r.actualFreq * 100).toFixed(2)}% pred=${(r.predFreq * 100).toFixed(3)}% ratio=${Math.exp(r.logRatio).toFixed(1)}x  ${desc}`);
      }
      console.log(`  TOP 5 OVER-PREDICTED (predicted >> actual):`);
      for (const r of sr.topOverPred.slice(0, 5)) {
        const ids = r.combo.split('|');
        const desc = ids.map(id => `${(eg.nameById.get(id) || id).slice(0, 16)}(${eg.teamById.get(id) || '?'},${(eg.ownPctById.get(id) || 0).toFixed(0)}%)`).join(' + ');
        console.log(`    actual=${(r.actualFreq * 100).toFixed(2)}% pred=${(r.predFreq * 100).toFixed(3)}% ratio=${(1 / Math.exp(r.logRatio)).toFixed(1)}x  ${desc}`);
      }
    }
  }

  fs.writeFileSync(OUT, csvRows.join('\n'));
  console.log('\nWrote ' + OUT + ' (' + (csvRows.length - 1) + ' rows = slates × sizes).');
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
