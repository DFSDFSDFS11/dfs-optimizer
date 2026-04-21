/**
 * σ_{δ,G} multiplier sweep — test 3 values of lambdaSigma with blended field.
 * Current: 0.30, Test: 0.25, 0.21
 */
import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals } from '../parser';
import { getContestConfig } from '../rules';
import { DEFAULT_SELECTOR_PARAMS, SelectorParams, defaultGamma, getSportDefaults, precomputeSlate } from '../selection/algorithm7-selector';
import { buildV31Context, v31Score } from '../selection/v31-objective';
import { applyConstructedTwins, DEFAULT_CONSTRUCTED_TWIN_PARAMS } from '../selection/constructed-twin';
import { loadRegionMap, computeRegionTargets } from '../analysis/region-map';
import { generateBlendedField } from '../opponent/field-generator';

const DATA_DIR = 'C:/Users/colin/dfs opto';
const SLATES = [
  { slate: '4-6-26', proj: '4-6-26_projections.csv', actuals: 'dkactuals 4-6-26.csv', pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26', proj: '4-8-26projections.csv', actuals: '4-8-26actuals.csv', pool: '4-8-26sspool.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv', actuals: '4-12-26actuals.csv', pool: '4-12-26sspool.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv', actuals: '4-14-26actuals.csv', pool: '4-14-26sspool.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv', actuals: '4-15-26actuals.csv', pool: '4-15-26sspool.csv' },
  { slate: '4-17-26', proj: '4-17-26projections.csv', actuals: '4-17-26actuals.csv', pool: '4-17-26sspool.csv' },
  { slate: '4-18-26', proj: '4-18-26projections.csv', actuals: '4-18-26actuals.csv', pool: '4-18-26sspool.csv' },
];
const LAMBDA_SIGMA_VALUES = [0.30, 0.25, 0.21];
const LAMBDA_VAR = 0.3;

function norm(n: string): string { return (n||'').toLowerCase().replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim(); }
function findBin(v: number, bins: number[]): number { for (let i = bins.length-1; i >= 0; i--) if (v >= bins[i]) return i; return 0; }

async function main() {
  const regionMap = loadRegionMap('C:/Users/colin/dfs opto/region-map-mlb-dk.json');
  const pct = (v: number) => `${(v*100).toFixed(2)}%`;
  const results: Array<{ lambdaSigma: number; slateResults: Array<{ slate: string; t1: number; t5: number; cash: number; scored: number }> }> = [];

  for (const ls of LAMBDA_SIGMA_VALUES) {
    console.log(`\n======== lambdaSigma = ${ls} ========`);
    const slateResults: typeof results[0]['slateResults'] = [];

    for (const s of SLATES) {
      const projPath = path.join(DATA_DIR, s.proj);
      const actualsPath = path.join(DATA_DIR, s.actuals);
      const poolPath = path.join(DATA_DIR, s.pool);
      if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) continue;

      const pr = parseCSVFile(projPath, 'mlb', true);
      const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
      const pool = buildPlayerPool(pr.players, pr.detectedContestType);
      const actuals = parseContestActuals(actualsPath, config);
      const nameMap = new Map<string, Player>(); for (const p of pool.players) nameMap.set(norm(p.name), p);
      const idMap = new Map<string, Player>(); for (const p of pool.players) idMap.set(p.id, p);

      const F = actuals.entries.length;
      const sorted = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
      const tAt = (f: number) => sorted[Math.max(0, Math.floor(F * f) - 1)] || 0;
      const thresholds = { top1: tAt(0.01), top5: tAt(0.05), cash: tAt(0.20) };

      const fieldLineups: Lineup[] = []; const seenH = new Set<string>(); const actualByHash = new Map<string, number>();
      for (const e of actuals.entries) {
        const pls: Player[] = []; let ok = true;
        for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
        if (!ok) continue;
        const hash = pls.map(p => p.id).sort().join('|');
        if (seenH.has(hash)) continue; seenH.add(hash);
        fieldLineups.push({ players: pls, salary: pls.reduce((sm, p) => sm + p.salary, 0), projection: pls.reduce((sm, p) => sm + p.projection, 0), ownership: pls.reduce((sm, p) => sm + (p.ownership || 0), 0) / pls.length, hash });
        actualByHash.set(hash, e.actualPoints);
      }

      const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
      // Use blended field
      const synthField = generateBlendedField(loaded.lineups, pool.players, config, Math.min(8000, F), 0.20);
      const selParams: SelectorParams = { ...DEFAULT_SELECTOR_PARAMS, ...getSportDefaults('mlb'), N: 150, gamma: defaultGamma(config.rosterSize), numWorlds: 1500 };
      const precomp = precomputeSlate(loaded.lineups, synthField, pool.players, selParams, 'mlb');
      const ctx = buildV31Context(precomp, synthField, pool.players);

      // Region selection with this lambdaSigma
      const poolCoords = loaded.lineups.map(l => ({ projection: l.projection, ownership: l.players.reduce((sm: number, p: Player) => sm + (p.ownership || 0), 0) / l.players.length }));
      const poolDist = new Map<string, number>();
      for (const c of poolCoords) { const pB = findBin(c.projection, regionMap.projBins); const oB = findBin(c.ownership, regionMap.ownBins); poolDist.set(`${pB}_${oB}`, (poolDist.get(`${pB}_${oB}`) || 0) + 1); }
      const feasCells = new Map<string, any>(regionMap.cells);
      for (const [k] of feasCells) if ((poolDist.get(k as string) || 0) < 5) feasCells.delete(k);
      const targets = computeRegionTargets({ ...regionMap, cells: feasCells }, 150, 'weighted_lift', 1.0);
      const candCoords = Array.from({ length: precomp.C }, (_, c) => ({ idx: c, projection: precomp.candidatePool[c].projection, ownership: precomp.candidatePool[c].players.reduce((sm: number, p: Player) => sm + (p.ownership || 0), 0) / precomp.candidatePool[c].players.length }));
      const sel: Lineup[] = []; const selH = new Set<string>(); const selExp = new Map<string, number>(); const expCap = Math.ceil(0.40 * 150);
      const sortedAlloc = [...targets.allocations.entries()].sort((a, b) => { const ca = regionMap.cells.get(a[0]), cb = regionMap.cells.get(b[0]); const dA = ca ? Math.abs((ca.projRange[0]+ca.projRange[1])/2-regionMap.top1Centroid.projection)/10+Math.abs((ca.ownRange[0]+ca.ownRange[1])/2-regionMap.top1Centroid.ownership)/5 : 99; const dB = cb ? Math.abs((cb.projRange[0]+cb.projRange[1])/2-regionMap.top1Centroid.projection)/10+Math.abs((cb.ownRange[0]+cb.ownRange[1])/2-regionMap.top1Centroid.ownership)/5 : 99; return dA-dB; });
      for (const [key, tc] of sortedAlloc) { const cell = regionMap.cells.get(key); if (!cell) continue; const rc = candCoords.filter(c => c.projection >= cell.projRange[0] && c.projection < cell.projRange[1] && c.ownership >= cell.ownRange[0] && c.ownership < cell.ownRange[1]).map(c => ({ ...c, score: v31Score(c.idx, ctx, precomp, LAMBDA_VAR, ls) })).sort((a, b) => b.score - a.score); let filled = 0; for (const cand of rc) { if (filled >= tc) break; const lu = precomp.candidatePool[cand.idx]; if (selH.has(lu.hash)) continue; let ok = true; for (const p of lu.players) if ((selExp.get(p.id) || 0) >= expCap) { ok = false; break; } if (!ok) continue; sel.push(lu); selH.add(lu.hash); for (const p of lu.players) selExp.set(p.id, (selExp.get(p.id) || 0) + 1); filled++; } }
      if (sel.length < 150) { const all = candCoords.map(c => ({ ...c, score: v31Score(c.idx, ctx, precomp, LAMBDA_VAR, ls) })).sort((a, b) => b.score - a.score); for (const c of all) { if (sel.length >= 150) break; const lu = precomp.candidatePool[c.idx]; if (selH.has(lu.hash)) continue; let ok = true; for (const p of lu.players) if ((selExp.get(p.id) || 0) >= expCap) { ok = false; break; } if (!ok) continue; sel.push(lu); selH.add(lu.hash); for (const p of lu.players) selExp.set(p.id, (selExp.get(p.id) || 0) + 1); } }
      const twin = applyConstructedTwins(sel, pool.players, precomp, config);
      const portfolio = twin.portfolio;

      let t1 = 0, t5 = 0, cash = 0, scored = 0;
      for (const lu of portfolio) {
        const fa = actualByHash.get(lu.hash); let a: number | null = fa !== undefined ? fa : null;
        if (a === null) { let t = 0, miss = false; for (const p of lu.players) { const r = actuals.playerActualsByName.get(norm(p.name)); if (!r) { miss = true; break; } t += r.fpts; } if (!miss) a = t; }
        if (a === null) continue; scored++;
        if (a >= thresholds.top1) t1++; if (a >= thresholds.top5) t5++; if (a >= thresholds.cash) cash++;
      }
      console.log(`  ${s.slate}: t1=${t1} t5=${t5} cash=${cash}/${scored}`);
      slateResults.push({ slate: s.slate, t1, t5, cash, scored });
    }
    results.push({ lambdaSigma: ls, slateResults });
  }

  // Report
  let md = `# σ_{δ,G} Multiplier Sweep — Blended Field\n\n`;
  md += `| lambdaSigma | Mean Top-1% | Mean Top-5% | Mean Cash |\n|---:|---:|---:|---:|\n`;
  for (const r of results) {
    const t1Avg = r.slateResults.reduce((s, sr) => s + (sr.scored > 0 ? sr.t1 / sr.scored : 0), 0) / r.slateResults.length;
    const t5Avg = r.slateResults.reduce((s, sr) => s + (sr.scored > 0 ? sr.t5 / sr.scored : 0), 0) / r.slateResults.length;
    const cashAvg = r.slateResults.reduce((s, sr) => s + (sr.scored > 0 ? sr.cash / sr.scored : 0), 0) / r.slateResults.length;
    md += `| ${r.lambdaSigma} | **${pct(t1Avg)}** | ${pct(t5Avg)} | ${pct(cashAvg)} |\n`;
  }
  md += `\n## Per-Slate\n\n`;
  md += `| Slate |`;
  for (const r of results) md += ` λσ=${r.lambdaSigma} |`;
  md += `\n|---|`; for (const _ of results) md += `---:|`; md += `\n`;
  for (let si = 0; si < SLATES.length; si++) {
    md += `| ${SLATES[si].slate} |`;
    for (const r of results) {
      const sr = r.slateResults[si];
      if (sr) md += ` ${sr.t1}/${sr.scored} |`;
      else md += ` — |`;
    }
    md += `\n`;
  }
  fs.writeFileSync(path.join(DATA_DIR, 'sigma_sweep.md'), md);
  console.log(`\n✓ Report: ${path.join(DATA_DIR, 'sigma_sweep.md')}`);
}
main();
