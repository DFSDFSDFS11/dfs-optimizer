/**
 * 150-Maxer Similarity Analysis — compare V32's portfolio to EVERY 150-maxer
 * on EVERY slate. Measures: team stack overlap, player overlap, ownership profile,
 * projection profile, top-1% rate, and cosine similarity.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals, ContestEntry } from '../parser';
import { getContestConfig } from '../rules';
import { DEFAULT_SELECTOR_PARAMS, SelectorParams, defaultGamma, getSportDefaults, precomputeSlate } from '../selection/algorithm7-selector';
import { generateBlendedField } from '../opponent/field-generator';
import { loadRegionMap, computeRegionTargets } from '../analysis/region-map';

const DIR = 'C:/Users/colin/dfs opto';
const norm = (n: string) => (n||'').toLowerCase().replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim();
const extractUser = (e: string) => (e||'').replace(/\s*\([^)]*\)\s*$/,'').trim();
const findBin = (v: number, bins: number[]) => { for (let i = bins.length-1; i >= 0; i--) if (v >= bins[i]) return i; return 0; };

const SLATES = [
  { slate: '4-6-26', proj: '4-6-26_projections.csv', actuals: 'dkactuals 4-6-26.csv', pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26', proj: '4-8-26projections.csv', actuals: '4-8-26actuals.csv', pool: '4-8-26sspool.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv', actuals: '4-12-26actuals.csv', pool: '4-12-26sspool.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv', actuals: '4-14-26actuals.csv', pool: '4-14-26sspool.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv', actuals: '4-15-26actuals.csv', pool: '4-15-26sspool.csv' },
  { slate: '4-17-26', proj: '4-17-26projections.csv', actuals: '4-17-26actuals.csv', pool: '4-17-26sspool.csv' },
  { slate: '4-18-26', proj: '4-18-26projections.csv', actuals: '4-18-26actuals.csv', pool: '4-18-26sspool.csv' },
];

interface PortfolioProfile {
  name: string;
  entries: number;
  t1: number; t1Rate: number;
  t5: number; cashHits: number; cashRate: number;
  avgActual: number;
  avgProj: number;
  avgOwn: number;
  teamStackVec: Map<string, number>; // team -> fraction of entries stacking that team
  playerExpVec: Map<string, number>; // player id -> exposure fraction
  uniqueStacks: number;
}

function buildProfile(
  name: string,
  lineups: Lineup[],
  entries: ContestEntry[],
  thresholds: { top1: number; top5: number; cash: number },
  nameMap: Map<string, Player>,
): PortfolioProfile {
  const N = lineups.length;
  let t1 = 0, t5 = 0, cash = 0, sumActual = 0, sumProj = 0, sumOwn = 0;

  for (const e of entries) {
    if (e.actualPoints >= thresholds.top1) t1++;
    if (e.actualPoints >= thresholds.top5) t5++;
    if (e.actualPoints >= thresholds.cash) cash++;
    sumActual += e.actualPoints;
  }

  const teamStacks = new Map<string, number>();
  const playerExp = new Map<string, number>();
  const stackTeams = new Set<string>();

  for (const lu of lineups) {
    sumProj += lu.projection;
    sumOwn += lu.players.reduce((s, p) => s + (p.ownership || 0), 0) / lu.players.length;
    for (const p of lu.players) playerExp.set(p.id, (playerExp.get(p.id) || 0) + 1);
    const tc = new Map<string, number>();
    for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
    for (const [t, c] of tc) if (c >= 4) { teamStacks.set(t, (teamStacks.get(t) || 0) + 1); stackTeams.add(t); }
  }

  // Normalize to fractions
  const teamStackVec = new Map<string, number>();
  for (const [t, c] of teamStacks) teamStackVec.set(t, c / N);
  const playerExpVec = new Map<string, number>();
  for (const [id, c] of playerExp) playerExpVec.set(id, c / N);

  return {
    name, entries: N,
    t1, t1Rate: N > 0 ? t1 / N : 0,
    t5, cashHits: cash, cashRate: N > 0 ? cash / N : 0,
    avgActual: entries.length > 0 ? sumActual / entries.length : 0,
    avgProj: N > 0 ? sumProj / N : 0,
    avgOwn: N > 0 ? sumOwn / N : 0,
    teamStackVec, playerExpVec,
    uniqueStacks: stackTeams.size,
  };
}

function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  const allKeys = new Set([...a.keys(), ...b.keys()]);
  let dot = 0, magA = 0, magB = 0;
  for (const k of allKeys) {
    const va = a.get(k) || 0, vb = b.get(k) || 0;
    dot += va * vb; magA += va * va; magB += vb * vb;
  }
  const d = Math.sqrt(magA) * Math.sqrt(magB);
  return d > 0 ? dot / d : 0;
}

// V32 selection (same code path as production)
function runV32(precomp: any, regionMap: any, poolLineups: Lineup[], numGames: number, allPlayers: Player[]): Lineup[] {
  const isSmallSlate = numGames <= 4;
  const poolCoords = poolLineups.map((l: Lineup) => ({ projection: l.projection, ownership: l.players.reduce((s: number, p: Player) => s + (p.ownership || 0), 0) / l.players.length }));
  const poolDist = new Map<string, number>(); for (const c of poolCoords) { const pB = findBin(c.projection, regionMap.projBins); const oB = findBin(c.ownership, regionMap.ownBins); poolDist.set(`${pB}_${oB}`, (poolDist.get(`${pB}_${oB}`) || 0) + 1); }
  const feasCells = new Map<string, any>(regionMap.cells); for (const [k] of feasCells) if ((poolDist.get(k as string) || 0) < 5) feasCells.delete(k);
  const pps = poolCoords.map((c: any) => c.projection).sort((a: number, b: number) => a - b);
  const adjCent = { projection: regionMap.top1Centroid.projection + (pps[Math.floor(pps.length * 0.75)] - regionMap.top1Centroid.projection), ownership: regionMap.top1Centroid.ownership };
  const wCells = new Map<string, any>(); for (const [key, cell] of feasCells) { const d = Math.sqrt(Math.pow(((cell.projRange[0]+cell.projRange[1])/2-adjCent.projection)/10, 2) + Math.pow(((cell.ownRange[0]+cell.ownRange[1])/2-adjCent.ownership)/5, 2)); wCells.set(key, { ...cell, top1Lift: cell.top1Lift / (1+d) / (1+d) }); }
  const targets = computeRegionTargets({ ...regionMap, cells: wCells }, 150, 'weighted_lift', 0.1);
  const candCoords = Array.from({ length: precomp.C }, (_: any, c: number) => ({ idx: c, projection: precomp.candidatePool[c].projection, ownership: precomp.candidatePool[c].players.reduce((s: number, p: Player) => s + (p.ownership || 0), 0) / precomp.candidatePool[c].players.length }));
  const sel: Lineup[] = []; const selH = new Set<string>(); const selExp = new Map<string, number>(); const tsc = new Map<string, number>();
  const expCap = Math.ceil((isSmallSlate ? 0.50 : 0.35) * 150); const maxPT = Math.floor(150 * 0.25);
  const sa = [...targets.allocations.entries()].sort((a: any, b: any) => { const ca = regionMap.cells.get(a[0]) as any, cb = regionMap.cells.get(b[0]) as any; return (ca ? Math.abs((ca.projRange[0]+ca.projRange[1])/2 - adjCent.projection)/10 + Math.abs((ca.ownRange[0]+ca.ownRange[1])/2 - adjCent.ownership)/5 : 99) - (cb ? Math.abs((cb.projRange[0]+cb.projRange[1])/2 - adjCent.projection)/10 + Math.abs((cb.ownRange[0]+cb.ownRange[1])/2 - adjCent.ownership)/5 : 99); });
  for (const [key, tc] of sa) { const cell = regionMap.cells.get(key) as any; if (!cell) continue; const rc = candCoords.filter((c: any) => c.projection >= cell.projRange[0] && c.projection < cell.projRange[1] && c.ownership >= cell.ownRange[0] && c.ownership < cell.ownRange[1]).sort((a: any, b: any) => precomp.candidateProjection[b.idx] - precomp.candidateProjection[a.idx]); let f = 0; for (const cand of rc) { if (f >= tc) break; const lu = precomp.candidatePool[cand.idx]; if (selH.has(lu.hash)) continue; let ok = true; for (const p of lu.players) if ((selExp.get(p.id) || 0) >= expCap) { ok = false; break; } if (!ok) continue; const ltc = new Map<string, number>(); for (const p of lu.players) if (!p.positions?.includes('P')) ltc.set(p.team, (ltc.get(p.team) || 0) + 1); let tOk = true; for (const [t, cnt] of ltc) if (cnt >= 4 && (tsc.get(t) || 0) >= maxPT) { tOk = false; break; } if (!tOk) continue; sel.push(lu); selH.add(lu.hash); for (const p of lu.players) selExp.set(p.id, (selExp.get(p.id) || 0) + 1); for (const [t, cnt] of ltc) if (cnt >= 4) tsc.set(t, (tsc.get(t) || 0) + 1); f++; } }
  // Team coverage
  const covT = new Map<string, number>(); for (const lu of sel) { const tc = new Map<string, number>(); for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1); for (const [t, c] of tc) if (c >= 4) covT.set(t, (covT.get(t) || 0) + 1); }
  const allT = new Set<string>(); for (const p of allPlayers) if (p.team) allT.add(p.team);
  const minPT = Math.max(3, Math.floor(150 / allT.size * 0.6));
  for (const team of allT) { if ((covT.get(team) || 0) >= minPT) continue; const tc2 = candCoords.filter((c: any) => { const lu = precomp.candidatePool[c.idx]; const tc = new Map<string, number>(); for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1); return (tc.get(team) || 0) >= 4; }); if (tc2.length < 5) continue; const s2 = tc2.sort((a: any, b: any) => precomp.candidateProjection[b.idx] - precomp.candidateProjection[a.idx]); const needed = minPT - (covT.get(team) || 0); let added = 0; for (const cand of s2) { if (added >= needed) break; const lu = precomp.candidatePool[cand.idx]; if (selH.has(lu.hash)) continue; let ok = true; for (const p of lu.players) if ((selExp.get(p.id) || 0) >= expCap) { ok = false; break; } if (!ok) continue; if (sel.length >= 150) { const wIdx = sel.reduce((best: number, lu2: Lineup, idx: number) => lu2.projection < sel[best].projection ? idx : best, 0); const rem = sel[wIdx]; for (const p of rem.players) { const c = selExp.get(p.id) || 0; if (c > 0) selExp.set(p.id, c - 1); } selH.delete(rem.hash); sel[wIdx] = lu; } else sel.push(lu); selH.add(lu.hash); for (const p of lu.players) selExp.set(p.id, (selExp.get(p.id) || 0) + 1); added++; } }
  if (sel.length < 150) { const all2 = candCoords.sort((a: any, b: any) => precomp.candidateProjection[b.idx] - precomp.candidateProjection[a.idx]); for (const c of all2) { if (sel.length >= 150) break; const lu = precomp.candidatePool[c.idx]; if (selH.has(lu.hash)) continue; let ok = true; for (const p of lu.players) if ((selExp.get(p.id) || 0) >= expCap) { ok = false; break; } if (!ok) continue; sel.push(lu); selH.add(lu.hash); for (const p of lu.players) selExp.set(p.id, (selExp.get(p.id) || 0) + 1); } }
  return sel;
}

async function main() {
  const regionMap = loadRegionMap(path.join(DIR, 'region-map-mlb-dk.json'));
  const pct = (v: number) => `${(v*100).toFixed(1)}%`;

  let md = `# 150-Maxer Similarity Analysis — V32 vs EVERY Maxer on EVERY Slate\n\n`;

  // Cross-slate aggregation
  const crossSlateProfiles = new Map<string, { slates: number; sumT1Rate: number; sumOwn: number; sumProj: number; sumStackCos: number; sumPlayerCos: number }>();

  for (const s of SLATES) {
    const projPath = path.join(DIR, s.proj), actualsPath = path.join(DIR, s.actuals), poolPath = path.join(DIR, s.pool);
    if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) continue;

    console.log(`\n=== ${s.slate} ===`);
    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);
    const nameMap = new Map<string, Player>(); for (const p of pool.players) nameMap.set(norm(p.name), p);
    const idMap = new Map<string, Player>(); for (const p of pool.players) idMap.set(p.id, p);

    const F = actuals.entries.length;
    const sorted = actuals.entries.map(e => e.actualPoints).sort((a, b) => b - a);
    const thresholds = { top1: sorted[Math.max(0, Math.floor(F * 0.01) - 1)] || 0, top5: sorted[Math.max(0, Math.floor(F * 0.05) - 1)] || 0, cash: sorted[Math.max(0, Math.floor(F * 0.22) - 1)] || 0 };

    // V32 portfolio
    const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
    const gameSet = new Set<string>(); for (const p of pool.players) gameSet.add(p.gameInfo || `${p.team}_game`);
    const blendedField = generateBlendedField(loaded.lineups, pool.players, config, Math.min(8000, F), 0.20);
    const selParams: SelectorParams = { ...DEFAULT_SELECTOR_PARAMS, ...getSportDefaults('mlb'), N: 150, gamma: defaultGamma(config.rosterSize), numWorlds: 1500 };
    const precomp = precomputeSlate(loaded.lineups, blendedField, pool.players, selParams, 'mlb');
    const v32Lineups = runV32(precomp, regionMap, loaded.lineups, gameSet.size, pool.players);

    // Score V32 against actuals
    const actualByHash = new Map<string, number>();
    const fieldLineups: Lineup[] = [];
    for (const e of actuals.entries) { const pls: Player[] = []; let ok = true; for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); } if (!ok) continue; const hash = pls.map(p => p.id).sort().join('|'); fieldLineups.push({ players: pls, salary: 0, projection: pls.reduce((sm, p) => sm + p.projection, 0), ownership: pls.reduce((sm, p) => sm + (p.ownership || 0), 0) / pls.length, hash }); actualByHash.set(hash, e.actualPoints); }

    const v32Entries: ContestEntry[] = v32Lineups.map((l, i) => {
      const fa = actualByHash.get(l.hash); let score = fa !== undefined ? fa : 0;
      if (fa === undefined) { for (const p of l.players) { const r = actuals.playerActualsByName.get(norm(p.name)); if (r) score += r.fpts; } }
      return { rank: 0, entryId: `v32_${i}`, entryName: 'V32', actualPoints: score, playerNames: l.players.map(p => p.name) };
    });
    const v32Profile = buildProfile('V32', v32Lineups, v32Entries, thresholds, nameMap);

    // Every 150-maxer
    const byUser = new Map<string, ContestEntry[]>();
    for (const e of actuals.entries) { const u = extractUser(e.entryName); if (u) { const a = byUser.get(u); if (a) a.push(e); else byUser.set(u, [e]); } }

    const maxerProfiles: PortfolioProfile[] = [];
    for (const [username, entries] of byUser) {
      if (entries.length < 140) continue;
      const lineups: Lineup[] = [];
      for (const e of entries) {
        const pls: Player[] = []; let ok = true;
        for (const n of e.playerNames) { const p = nameMap.get(norm(n)); if (!p) { ok = false; break; } pls.push(p); }
        if (!ok) continue;
        lineups.push({ players: pls, salary: pls.reduce((sm, p) => sm + p.salary, 0), projection: pls.reduce((sm, p) => sm + p.projection, 0), ownership: pls.reduce((sm, p) => sm + (p.ownership || 0), 0) / pls.length, hash: pls.map(p => p.id).sort().join('|') });
      }
      if (lineups.length < 100) continue;
      maxerProfiles.push(buildProfile(username, lineups, entries, thresholds, nameMap));
    }

    maxerProfiles.sort((a, b) => b.t1Rate - a.t1Rate);

    // Compute similarities
    md += `## ${s.slate} (${F.toLocaleString()} entries, ${maxerProfiles.length} maxers)\n\n`;
    md += `V32: t1=${v32Profile.t1} (${pct(v32Profile.t1Rate)}) own=${v32Profile.avgOwn.toFixed(1)}% proj=${v32Profile.avgProj.toFixed(1)} stacks=${v32Profile.uniqueStacks}\n\n`;
    md += `| Rank | Maxer | N | T1% | Own | Proj | Stacks | StackCos | PlayerCos |\n`;
    md += `|---:|---|---:|---:|---:|---:|---:|---:|---:|\n`;

    for (let i = 0; i < maxerProfiles.length; i++) {
      const mp = maxerProfiles[i];
      const stackCos = cosineSimilarity(v32Profile.teamStackVec, mp.teamStackVec);
      const playerCos = cosineSimilarity(v32Profile.playerExpVec, mp.playerExpVec);

      md += `| ${i + 1} | ${mp.name} | ${mp.entries} | ${pct(mp.t1Rate)} | ${mp.avgOwn.toFixed(1)}% | ${mp.avgProj.toFixed(1)} | ${mp.uniqueStacks} | ${stackCos.toFixed(3)} | ${playerCos.toFixed(3)} |\n`;

      // Aggregate for cross-slate
      const ex = crossSlateProfiles.get(mp.name);
      if (ex) { ex.slates++; ex.sumT1Rate += mp.t1Rate; ex.sumOwn += mp.avgOwn; ex.sumProj += mp.avgProj; ex.sumStackCos += stackCos; ex.sumPlayerCos += playerCos; }
      else crossSlateProfiles.set(mp.name, { slates: 1, sumT1Rate: mp.t1Rate, sumOwn: mp.avgOwn, sumProj: mp.avgProj, sumStackCos: stackCos, sumPlayerCos: playerCos });
    }
    md += `\n`;

    console.log(`  ${maxerProfiles.length} maxers profiled`);
  }

  // Cross-slate summary
  md += `## Cross-Slate Summary (maxers with 3+ slates)\n\n`;
  md += `| Rank | Maxer | Slates | AvgT1% | AvgOwn | AvgProj | AvgStackCos | AvgPlayerCos |\n`;
  md += `|---:|---|---:|---:|---:|---:|---:|---:|\n`;

  const ranked = [...crossSlateProfiles.entries()]
    .filter(([, v]) => v.slates >= 3)
    .sort((a, b) => (b[1].sumT1Rate / b[1].slates) - (a[1].sumT1Rate / a[1].slates));

  for (let i = 0; i < ranked.length && i < 30; i++) {
    const [name, v] = ranked[i];
    md += `| ${i + 1} | ${name} | ${v.slates} | ${pct(v.sumT1Rate / v.slates)} | ${(v.sumOwn / v.slates).toFixed(1)}% | ${(v.sumProj / v.slates).toFixed(1)} | ${(v.sumStackCos / v.slates).toFixed(3)} | ${(v.sumPlayerCos / v.slates).toFixed(3)} |\n`;
  }

  // Averages
  const avgStackCos = ranked.reduce((s, [, v]) => s + v.sumStackCos / v.slates, 0) / ranked.length;
  const avgPlayerCos = ranked.reduce((s, [, v]) => s + v.sumPlayerCos / v.slates, 0) / ranked.length;
  md += `\n**Average similarity to V32 across all ${ranked.length} multi-slate maxers:**\n`;
  md += `- Stack cosine: **${avgStackCos.toFixed(3)}**\n`;
  md += `- Player cosine: **${avgPlayerCos.toFixed(3)}**\n`;

  fs.writeFileSync(path.join(DIR, 'maxer_similarity.md'), md);
  console.log(`\n✓ Report: ${path.join(DIR, 'maxer_similarity.md')}`);
}
main();
