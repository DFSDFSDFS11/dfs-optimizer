/**
 * V32-only backtest — reuses OLD/V2/V30/V31 numbers from prior run,
 * only computes V32 on each slate.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import {
  parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals, ContestEntry,
} from '../parser';
import { getContestConfig } from '../rules';
import {
  DEFAULT_SELECTOR_PARAMS, SelectorParams, defaultGamma, getSportDefaults, precomputeSlate,
} from '../selection/algorithm7-selector';
import { buildV31Context, v31Score } from '../selection/v31-objective';
import { applyEvilTwinHedging, DEFAULT_EVIL_TWIN_PARAMS } from '../selection/evil-twin';
import { loadRegionMap, computeRegionTargets } from '../analysis/region-map';

const DATA_DIR = 'C:/Users/colin/dfs opto';

const SLATES = [
  { slate: '4-6-26',  proj: '4-6-26_projections.csv',  actuals: 'dkactuals 4-6-26.csv',    pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26',  proj: '4-8-26projections.csv',   actuals: '4-8-26actuals.csv',       pool: '4-8-26sspool.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv',  actuals: '4-12-26actuals.csv',      pool: '4-12-26sspool.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv',  actuals: '4-14-26actuals.csv',      pool: '4-14-26sspool.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv',  actuals: '4-15-26actuals.csv',      pool: '4-15-26sspool.csv' },
  { slate: '4-17-26', proj: '4-17-26projections.csv',  actuals: '4-17-26actuals.csv',      pool: '4-17-26sspool.csv' },
];

// Hardcoded from last run
const PRIOR: Record<string, { old: number[]; v2: number[]; v30: number[]; v31: number[] }> = {
  '4-6-26':  { old: [5,14,28,42], v2: [1,5,10,20], v30: [1,4,8,14], v31: [1,3,3,10] },
  '4-8-26':  { old: [0,7,17,29], v2: [2,9,18,35], v30: [3,10,19,37], v31: [5,12,18,37] },
  '4-12-26': { old: [0,3,3,21], v2: [0,1,2,11], v30: [0,1,4,10], v31: [0,1,4,7] },
  '4-14-26': { old: [2,8,16,32], v2: [2,10,17,27], v30: [3,9,13,23], v31: [1,10,17,27] },
  '4-15-26': { old: [0,3,7,18], v2: [0,3,9,16], v30: [0,2,4,14], v31: [0,1,3,10] },
  '4-17-26': { old: [0,0,0,0], v2: [0,0,0,0], v30: [0,0,0,0], v31: [0,0,0,0] },
};

function normalizeName(n: string): string {
  return (n||'').toLowerCase().replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim();
}

function scoreLineup(lu: Lineup, ah: Map<string,number>, act: ContestActuals): number|null {
  const fa = ah.get(lu.hash); if (fa !== undefined) return fa;
  let t = 0;
  for (const p of lu.players) { const r = act.playerActualsByName.get(normalizeName(p.name)); if (!r) return null; t += r.fpts; }
  return t;
}

async function main() {
  const regionMap = loadRegionMap('C:/Users/colin/dfs opto/region-map-mlb-dk.json');
  const pct = (v: number) => `${(v*100).toFixed(2)}%`;
  let md = `# V32 Backtest — 5 MLB Slates\n\n`;
  md += `| Slate | Entries | OLD t1 | V2 t1 | V30 t1 | V31 t1 | **V32 t1** | V32 own | V32 proj | V32 dist |\n`;
  md += `|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n`;

  let v32T1Sum = 0, v32T5Sum = 0, v32CashSum = 0, v32N = 0;

  for (const s of SLATES) {
    const projPath = path.join(DATA_DIR, s.proj);
    const actualsPath = path.join(DATA_DIR, s.actuals);
    const poolPath = path.join(DATA_DIR, s.pool);
    if (![projPath,actualsPath,poolPath].every(p => fs.existsSync(p))) { console.log(`skip ${s.slate}`); continue; }

    console.log(`\n=== ${s.slate} ===`);
    const pr = parseCSVFile(projPath, 'mlb', true);
    const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, config);
    const nameMap = new Map<string,Player>(); for (const p of pool.players) nameMap.set(normalizeName(p.name), p);
    const idMap = new Map<string,Player>(); for (const p of pool.players) idMap.set(p.id, p);

    // Join field
    const fieldLineups: Lineup[] = []; const actualByHash = new Map<string,number>(); const seenH = new Set<string>();
    for (const e of actuals.entries) {
      const pls: Player[] = []; let ok = true;
      for (const n of e.playerNames) { const p = nameMap.get(normalizeName(n)); if (!p){ok=false;break;} pls.push(p); }
      if (!ok) continue;
      const sal = pls.reduce((sm,p)=>sm+p.salary,0);
      const proj = pls.reduce((sm,p)=>sm+p.projection,0);
      const own = pls.reduce((sm,p)=>sm+(p.ownership||0),0)/pls.length;
      const hash = pls.map(p=>p.id).sort().join('|');
      if (seenH.has(hash)) continue; seenH.add(hash);
      fieldLineups.push({players:pls,salary:sal,projection:proj,ownership:own,hash});
      actualByHash.set(hash, e.actualPoints);
    }

    const loaded = loadPoolFromCSV({filePath:poolPath,config,playerMap:idMap});
    const poolLineups = loaded.lineups;
    const F = actuals.entries.length;
    const tAt = (f:number) => { const sorted = actuals.entries.map(e=>e.actualPoints).sort((a,b)=>b-a); return sorted[Math.max(0,Math.floor(F*f)-1)]||0; };
    const thresholds = { top1: tAt(0.01), top5: tAt(0.05), top10: tAt(0.10), cash: tAt(0.20) };

    const selParams: SelectorParams = { ...DEFAULT_SELECTOR_PARAMS, ...getSportDefaults('mlb'), N:150, gamma:defaultGamma(config.rosterSize), numWorlds:1500 };
    console.log(`  precomp (pool=${poolLineups.length}, field=${fieldLineups.length})…`);
    const precomp = precomputeSlate(poolLineups, fieldLineups, pool.players, selParams, 'mlb');

    console.log(`  V32…`);
    const ctx = buildV31Context(precomp, fieldLineups, pool.players);
    const targets = computeRegionTargets(regionMap, 150, 'weighted_lift', 1.0);
    const candCoords = Array.from({length:precomp.C},(_,c)=>({
      idx:c, projection:precomp.candidatePool[c].projection,
      ownership:precomp.candidatePool[c].players.reduce((sm:number,p:Player)=>sm+(p.ownership||0),0)/precomp.candidatePool[c].players.length,
    }));
    const v32Sel: Lineup[] = []; const v32H = new Set<string>(); const v32Exp = new Map<string,number>();
    const expCap = Math.ceil(0.40*150);
    const sortedAlloc = [...targets.allocations.entries()].sort((a,b)=>(regionMap.cells.get(b[0])?.top1Lift||0)-(regionMap.cells.get(a[0])?.top1Lift||0));
    for (const [key,tc] of sortedAlloc) {
      const cell = regionMap.cells.get(key); if (!cell) continue;
      const rc = candCoords.filter(c=>c.projection>=cell.projRange[0]&&c.projection<cell.projRange[1]&&c.ownership>=cell.ownRange[0]&&c.ownership<cell.ownRange[1])
        .map(c=>({...c,score:v31Score(c.idx,ctx,precomp,0.5,1.0)})).sort((a,b)=>b.score-a.score);
      let filled=0;
      for (const cand of rc) {
        if (filled>=tc) break;
        const lu=precomp.candidatePool[cand.idx]; if (v32H.has(lu.hash)) continue;
        let ok=true; for (const p of lu.players) if ((v32Exp.get(p.id)||0)>=expCap){ok=false;break;} if (!ok) continue;
        v32Sel.push(lu); v32H.add(lu.hash); for (const p of lu.players) v32Exp.set(p.id,(v32Exp.get(p.id)||0)+1); filled++;
      }
    }
    if (v32Sel.length<150) {
      const all32=candCoords.map(c=>({...c,score:v31Score(c.idx,ctx,precomp,0.5,1.0)})).sort((a,b)=>b.score-a.score);
      for (const c of all32) { if (v32Sel.length>=150) break; const lu=precomp.candidatePool[c.idx]; if (v32H.has(lu.hash)) continue;
        let ok=true; for (const p of lu.players) if ((v32Exp.get(p.id)||0)>=expCap){ok=false;break;} if (!ok) continue;
        v32Sel.push(lu); v32H.add(lu.hash); for (const p of lu.players) v32Exp.set(p.id,(v32Exp.get(p.id)||0)+1);
      }
    }
    const twin32=applyEvilTwinHedging(v32Sel,precomp,DEFAULT_EVIL_TWIN_PARAMS);
    const v32F=twin32.portfolio;

    let t1=0,t5=0,t10=0,cash=0,scored=0,sumAct=0;
    for (const lu of v32F) { const a=scoreLineup(lu,actualByHash,actuals); if (a===null) continue; scored++;sumAct+=a; if (a>=thresholds.top1)t1++; if (a>=thresholds.top5)t5++; if (a>=thresholds.top10)t10++; if (a>=thresholds.cash)cash++; }
    let sOwn=0,sProj=0; for (const l of v32F){sOwn+=l.players.reduce((sm:number,p:Player)=>sm+(p.ownership||0),0)/l.players.length;sProj+=l.projection;}
    const avgOwn=sOwn/v32F.length; const avgProj=sProj/v32F.length;
    const dist=Math.sqrt(Math.pow((avgProj-regionMap.top1Centroid.projection)/10,2)+Math.pow((avgOwn-regionMap.top1Centroid.ownership)/5,2));

    console.log(`    V32: t1=${t1} t5=${t5} t10=${t10} cash=${cash}/${scored} own=${avgOwn.toFixed(1)}% proj=${avgProj.toFixed(1)} dist=${dist.toFixed(2)}`);
    v32T1Sum+=t1/scored; v32T5Sum+=t5/scored; v32CashSum+=cash/scored; v32N++;

    const prior = PRIOR[s.slate];
    md += `| ${s.slate} | ${F.toLocaleString()} | ${prior?.old[0]||'?'} | ${prior?.v2[0]||'?'} | ${prior?.v30[0]||'?'} | ${prior?.v31[0]||'?'} | **${t1}** | ${avgOwn.toFixed(1)}% | ${avgProj.toFixed(1)} | ${dist.toFixed(2)} |\n`;
  }

  md += `\n**V32 mean top-1%: ${pct(v32T1Sum/v32N)}** | top-5%: ${pct(v32T5Sum/v32N)} | cash: ${pct(v32CashSum/v32N)}\n`;
  md += `\nPrior means: OLD=0.93%, V2=0.67%, V30=0.93%, V31=0.93%\n`;

  fs.writeFileSync('C:/Users/colin/dfs opto/mlb_v32_backtest.md', md);
  console.log(`\n✓ Report: C:/Users/colin/dfs opto/mlb_v32_backtest.md`);
}

main();
