/**
 * Team Stack Comparison — V32 (Mode 1) vs top pros across all 7 slates.
 * Shows which teams each portfolio stacks and cosine similarity.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals } from '../parser';
import { getContestConfig } from '../rules';
import { DEFAULT_SELECTOR_PARAMS, SelectorParams, defaultGamma, getSportDefaults, precomputeSlate } from '../selection/algorithm7-selector';
import { generateBlendedField } from '../opponent/field-generator';
import { loadRegionMap, computeRegionTargets } from '../analysis/region-map';

const DIR = 'C:/Users/colin/dfs opto';
const SLATES = [
  { slate: '4-6-26', proj: '4-6-26_projections.csv', actuals: 'dkactuals 4-6-26.csv', pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26', proj: '4-8-26projections.csv', actuals: '4-8-26actuals.csv', pool: '4-8-26sspool.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv', actuals: '4-12-26actuals.csv', pool: '4-12-26sspool.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv', actuals: '4-14-26actuals.csv', pool: '4-14-26sspool.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv', actuals: '4-15-26actuals.csv', pool: '4-15-26sspool.csv' },
  { slate: '4-17-26', proj: '4-17-26projections.csv', actuals: '4-17-26actuals.csv', pool: '4-17-26sspool.csv' },
  { slate: '4-18-26', proj: '4-18-26projections.csv', actuals: '4-18-26actuals.csv', pool: '4-18-26sspool.csv' },
];

function norm(n: string): string { return (n||'').toLowerCase().replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim(); }
function extractUser(e: string): string { return (e||'').replace(/\s*\([^)]*\)\s*$/,'').trim(); }
function findBin(v: number, bins: number[]): number { for (let i = bins.length-1; i >= 0; i--) if (v >= bins[i]) return i; return 0; }

async function main() {
  const regionMap = loadRegionMap(path.join(DIR, 'region-map-mlb-dk.json'));

  // Aggregate stack counts: per-slate per-team for V32 and each pro
  const v32Stacks = new Map<string, Map<string, number>>(); // slate -> team -> count
  const proStacks = new Map<string, Map<string, Map<string, number>>>(); // pro -> slate -> team -> count
  const proEntryCount = new Map<string, number>();
  let v32TotalEntries = 0;

  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj), actualsPath = path.join(DIR, s.actuals), poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) continue;

    console.log(`=== ${s.slate} ===`);
    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);
    const nameMap = new Map<string, Player>(); for (const p of pool.players) nameMap.set(norm(p.name), p);
    const idMap = new Map<string, Player>(); for (const p of pool.players) idMap.set(p.id, p);

    // V32 selection
    const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
    const blendedField = generateBlendedField(loaded.lineups, pool.players, config, Math.min(8000, actuals.entries.length), 0.20);
    const selParams: SelectorParams = { ...DEFAULT_SELECTOR_PARAMS, ...getSportDefaults('mlb'), N: 150, gamma: defaultGamma(config.rosterSize), numWorlds: 1500 };
    const precomp = precomputeSlate(loaded.lineups, blendedField, pool.players, selParams, 'mlb');

    const poolCoords = loaded.lineups.map(l => ({ projection: l.projection, ownership: l.players.reduce((sm: number, p: Player) => sm + (p.ownership || 0), 0) / l.players.length }));
    const poolDist = new Map<string, number>();
    for (const c of poolCoords) { const pB = findBin(c.projection, regionMap.projBins); const oB = findBin(c.ownership, regionMap.ownBins); poolDist.set(`${pB}_${oB}`, (poolDist.get(`${pB}_${oB}`) || 0) + 1); }
    const feasCells = new Map<string, any>(regionMap.cells);
    for (const [k] of feasCells) if ((poolDist.get(k as string) || 0) < 5) feasCells.delete(k);
    const poolProjSorted = poolCoords.map(c => c.projection).sort((a, b) => a - b);
    const adjCent = { projection: regionMap.top1Centroid.projection + (poolProjSorted[Math.floor(poolProjSorted.length * 0.75)] - regionMap.top1Centroid.projection), ownership: regionMap.top1Centroid.ownership };
    const wCells = new Map<string, any>();
    for (const [key, cell] of feasCells) { const d = Math.sqrt(Math.pow(((cell.projRange[0]+cell.projRange[1])/2 - adjCent.projection)/10, 2) + Math.pow(((cell.ownRange[0]+cell.ownRange[1])/2 - adjCent.ownership)/5, 2)); wCells.set(key, { ...cell, top1Lift: cell.top1Lift / (1+d) / (1+d) }); }
    const targets = computeRegionTargets({ ...regionMap, cells: wCells }, 150, 'weighted_lift', 0.1);

    const candCoords = Array.from({ length: precomp.C }, (_, c) => ({ idx: c, projection: precomp.candidatePool[c].projection }));
    const sel: Lineup[] = []; const selH = new Set<string>(); const selExp = new Map<string, number>(); const tsc = new Map<string, number>();
    const expCap = Math.ceil(0.40 * 150); const maxPT = Math.floor(150 * 0.25);
    const sortedAlloc = [...targets.allocations.entries()].sort((a, b) => { const ca = regionMap.cells.get(a[0]) as any, cb = regionMap.cells.get(b[0]) as any; const dA = ca ? Math.abs((ca.projRange[0]+ca.projRange[1])/2 - adjCent.projection)/10 + Math.abs((ca.ownRange[0]+ca.ownRange[1])/2 - adjCent.ownership)/5 : 99; const dB = cb ? Math.abs((cb.projRange[0]+cb.projRange[1])/2 - adjCent.projection)/10 + Math.abs((cb.ownRange[0]+cb.ownRange[1])/2 - adjCent.ownership)/5 : 99; return dA - dB; });
    for (const [key, tc] of sortedAlloc) { const cell = regionMap.cells.get(key) as any; if (!cell) continue; const cc2 = candCoords.filter(c => { const lu = precomp.candidatePool[c.idx]; const own = lu.players.reduce((sm: number, p: Player) => sm + (p.ownership || 0), 0) / lu.players.length; return lu.projection >= cell.projRange[0] && lu.projection < cell.projRange[1] && own >= cell.ownRange[0] && own < cell.ownRange[1]; }).sort((a, b) => precomp.candidateProjection[b.idx] - precomp.candidateProjection[a.idx]); let f = 0; for (const cand of cc2) { if (f >= tc) break; const lu = precomp.candidatePool[cand.idx]; if (selH.has(lu.hash)) continue; let ok = true; for (const p of lu.players) if ((selExp.get(p.id) || 0) >= expCap) { ok = false; break; } if (!ok) continue; const ltc = new Map<string, number>(); for (const p of lu.players) if (!p.positions?.includes('P')) ltc.set(p.team, (ltc.get(p.team) || 0) + 1); let tOk = true; for (const [t, cnt] of ltc) if (cnt >= 4 && (tsc.get(t) || 0) >= maxPT) { tOk = false; break; } if (!tOk) continue; sel.push(lu); selH.add(lu.hash); for (const p of lu.players) selExp.set(p.id, (selExp.get(p.id) || 0) + 1); for (const [t, cnt] of ltc) if (cnt >= 4) tsc.set(t, (tsc.get(t) || 0) + 1); f++; } }

    // V32 stacks for this slate
    const slateV32 = new Map<string, number>();
    for (const lu of sel) { const tc = new Map<string, number>(); for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1); for (const [t, c] of tc) if (c >= 4) slateV32.set(t, (slateV32.get(t) || 0) + 1); }
    v32Stacks.set(s.slate, slateV32);
    v32TotalEntries += sel.length;

    // Pro stacks
    const byUser = new Map<string, any[]>();
    for (const e of actuals.entries) { const u = extractUser(e.entryName); if (u) { const a = byUser.get(u); if (a) a.push(e); else byUser.set(u, [e]); } }
    for (const [username, entries] of byUser) {
      if (entries.length < 140) continue;
      if (!proStacks.has(username)) proStacks.set(username, new Map());
      const userSlateStacks = new Map<string, number>();
      let count = 0;
      for (const e of entries) {
        const pls: Player[] = []; let ok = true;
        for (const n of e.playerNames) { const p = nameMap.get(norm(n)); if (!p) { ok = false; break; } pls.push(p); }
        if (!ok) continue; count++;
        const tc = new Map<string, number>(); for (const p of pls) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
        for (const [t, c] of tc) if (c >= 4) userSlateStacks.set(t, (userSlateStacks.get(t) || 0) + 1);
      }
      proStacks.get(username)!.set(s.slate, userSlateStacks);
      proEntryCount.set(username, (proEntryCount.get(username) || 0) + count);
    }
  }

  // Aggregate and report
  const topPros = ['skijmb', 'giantsquid', 'dannyoms', 'hesebeckd', 'rsbathla'];

  let md = `# Team Stack Comparison — V32 vs Top Pros (7 slates)\n\n`;

  for (const s of SLATES) {
    const slateV32 = v32Stacks.get(s.slate);
    if (!slateV32) continue;

    md += `## ${s.slate}\n\n`;
    md += `| Team | V32 |`;
    for (const pro of topPros) md += ` ${pro.substring(0, 8)} |`;
    md += `\n|---|---:|`;
    for (const _ of topPros) md += `---:|`;
    md += `\n`;

    const allTeams = new Set<string>();
    for (const t of slateV32.keys()) allTeams.add(t);
    for (const pro of topPros) { const ps = proStacks.get(pro)?.get(s.slate); if (ps) for (const t of ps.keys()) allTeams.add(t); }

    for (const team of [...allTeams].sort()) {
      const v32Count = slateV32.get(team) || 0;
      if (v32Count === 0 && topPros.every(pro => !(proStacks.get(pro)?.get(s.slate)?.get(team)))) continue;
      let row = `| ${team} | ${v32Count} |`;
      for (const pro of topPros) {
        const c = proStacks.get(pro)?.get(s.slate)?.get(team) || 0;
        row += ` ${c || '—'} |`;
      }
      md += row + `\n`;
    }
    md += `\n`;
  }

  // Cosine similarity across all slates aggregated
  md += `## Cosine Similarity (all slates aggregated)\n\n`;
  const v32Agg = new Map<string, number>();
  for (const [, slateMap] of v32Stacks) for (const [t, c] of slateMap) v32Agg.set(t, (v32Agg.get(t) || 0) + c);

  for (const pro of topPros) {
    const proAgg = new Map<string, number>();
    for (const [, slateMap] of proStacks.get(pro) || new Map()) for (const [t, c] of slateMap) proAgg.set(t, (proAgg.get(t) || 0) + c);
    const allT = new Set([...v32Agg.keys(), ...proAgg.keys()]);
    const pTotal = proEntryCount.get(pro) || 1;
    let dot = 0, magV = 0, magP = 0;
    for (const t of allT) {
      const v = (v32Agg.get(t) || 0) / v32TotalEntries;
      const p = (proAgg.get(t) || 0) / pTotal;
      dot += v * p; magV += v * v; magP += p * p;
    }
    const cos = Math.sqrt(magV) * Math.sqrt(magP) > 0 ? dot / (Math.sqrt(magV) * Math.sqrt(magP)) : 0;
    md += `- **${pro}**: cosine similarity = **${cos.toFixed(3)}**\n`;
  }

  fs.writeFileSync(path.join(DIR, 'team_stack_comparison.md'), md);
  console.log(`\n✓ Report: ${path.join(DIR, 'team_stack_comparison.md')}`);
}
main();
