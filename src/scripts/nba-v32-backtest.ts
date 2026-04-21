/**
 * NBA V32 backtest — V32 (region-targeted) vs OLD (algorithm7) on 18 NBA slates.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, ContestActuals, ContestEntry } from '../parser';
import { getContestConfig } from '../rules';
import { DEFAULT_SELECTOR_PARAMS, SelectorParams, defaultGamma, getSportDefaults, precomputeSlate } from '../selection/algorithm7-selector';
import { v24Select, DEFAULT_V24_PARAMS } from '../selection/v24-selector';
import { buildV31Context, v31Score } from '../selection/v31-objective';
import { applyEvilTwinHedging, DEFAULT_EVIL_TWIN_PARAMS } from '../selection/evil-twin';
import { loadRegionMap, computeRegionTargets } from '../analysis/region-map';

const HIST = 'C:/Users/colin/Projects/dfs-optimizer/historical_slates';

function normalizeName(n: string): string { return (n||'').toLowerCase().replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim(); }

function scoreLineup(lu: Lineup, ah: Map<string,number>, act: ContestActuals): number|null {
  const fa = ah.get(lu.hash); if (fa !== undefined) return fa;
  let t = 0; for (const p of lu.players) { const r = act.playerActualsByName.get(normalizeName(p.name)); if (!r) return null; t += r.fpts; } return t;
}

async function main() {
  const regionMap = loadRegionMap(path.join(HIST, 'region-map-nba-dk.json'));
  const files = fs.readdirSync(HIST);
  const projRe = /^(\d{4}-\d{2}-\d{2})(?:_dk(?:_night)?)?_projections\.csv$/;
  const slates: Array<{ date: string; proj: string; actuals: string }> = [];
  for (const f of files) {
    const m = f.match(projRe); if (!m) continue;
    const date = m[1]; const isDkNight = f.includes('_dk_night_'); const isDk = f.includes('_dk_');
    const base = isDkNight ? `${date}_dk_night` : isDk ? `${date}_dk` : date;
    const af = `${base}_actuals.csv`;
    if (files.includes(af)) slates.push({ date: base, proj: path.join(HIST, f), actuals: path.join(HIST, af) });
  }
  slates.sort((a, b) => a.date.localeCompare(b.date));

  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
  let md = `# NBA V32 Backtest — ${slates.length} Slates (Mode 2: contest field as pool)\n\n`;
  md += `| Slate | Entries | OLD t1 | **V32 t1** | V32 own | V32 proj | V32 dist | V32 cash |\n`;
  md += `|---|---:|---:|---:|---:|---:|---:|---:|\n`;

  let oldT1Sum = 0, v32T1Sum = 0, oldCashSum = 0, v32CashSum = 0, n = 0;

  for (const s of slates) {
    console.log(`\n=== ${s.date} ===`);
    const pr = parseCSVFile(s.proj, 'nba', true);
    const config = getContestConfig('dk', 'nba', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(s.actuals, config);
    const nameMap = new Map<string,Player>(); for (const p of pool.players) nameMap.set(normalizeName(p.name), p);

    const fieldLineups: Lineup[] = []; const actualByHash = new Map<string,number>(); const seenH = new Set<string>();
    for (const e of actuals.entries) {
      const pls: Player[] = []; let ok = true;
      for (const nm of e.playerNames) { const p = nameMap.get(normalizeName(nm)); if (!p){ok=false;break;} pls.push(p); }
      if (!ok) continue;
      const hash = pls.map(p=>p.id).sort().join('|');
      if (seenH.has(hash)) continue; seenH.add(hash);
      const sal = pls.reduce((sm,p)=>sm+p.salary,0);
      const proj = pls.reduce((sm,p)=>sm+p.projection,0);
      const own = pls.reduce((sm,p)=>sm+(p.ownership||0),0)/pls.length;
      fieldLineups.push({players:pls,salary:sal,projection:proj,ownership:own,hash});
      actualByHash.set(hash, e.actualPoints);
    }
    if (fieldLineups.length < 100) { console.log('  skip (field too small)'); continue; }

    const F = actuals.entries.length;
    const sorted = actuals.entries.map(e=>e.actualPoints).sort((a,b)=>b-a);
    const tAt = (f:number) => sorted[Math.max(0,Math.floor(F*f)-1)]||0;
    const thresholds = { top1: tAt(0.01), top5: tAt(0.05), top10: tAt(0.10), cash: tAt(0.20) };

    const selParams: SelectorParams = { ...DEFAULT_SELECTOR_PARAMS, ...getSportDefaults('nba'), N:150, gamma:defaultGamma(config.rosterSize), numWorlds:1500 };

    // Mode 2: field as candidates
    console.log(`  precomp (field=${fieldLineups.length})…`);
    const precomp = precomputeSlate(fieldLineups, fieldLineups, pool.players, selParams, 'nba');

    // OLD (algorithm7 NBA defaults via v24 with NBA params)
    const oldParams = { ...DEFAULT_V24_PARAMS, rhoTarget: 0.70, varianceTopFraction: 0.9, projectionFloor: 0.5, ownershipKeepFraction: 1.0, maxExposure: 0.40 };
    const oldRes = v24Select(precomp, selParams, oldParams);
    let oT1=0,oCash=0,oScored=0;
    for (const lu of oldRes.selected) { const a=scoreLineup(lu,actualByHash,actuals); if (a===null) continue; oScored++; if (a>=thresholds.top1) oT1++; if (a>=thresholds.cash) oCash++; }

    // V32
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
        .map(c=>({...c,score:v31Score(c.idx,ctx,precomp,0.3,0.5)})).sort((a,b)=>b.score-a.score);
      let filled=0;
      for (const cand of rc) { if (filled>=tc) break; const lu=precomp.candidatePool[cand.idx]; if (v32H.has(lu.hash)) continue;
        let ok=true; for (const p of lu.players) if ((v32Exp.get(p.id)||0)>=expCap){ok=false;break;} if (!ok) continue;
        v32Sel.push(lu); v32H.add(lu.hash); for (const p of lu.players) v32Exp.set(p.id,(v32Exp.get(p.id)||0)+1); filled++;
      }
    }
    if (v32Sel.length<150) {
      const all32=candCoords.map(c=>({...c,score:v31Score(c.idx,ctx,precomp,0.3,0.5)})).sort((a,b)=>b.score-a.score);
      for (const c of all32) { if (v32Sel.length>=150) break; const lu=precomp.candidatePool[c.idx]; if (v32H.has(lu.hash)) continue;
        let ok=true; for (const p of lu.players) if ((v32Exp.get(p.id)||0)>=expCap){ok=false;break;} if (!ok) continue;
        v32Sel.push(lu); v32H.add(lu.hash); for (const p of lu.players) v32Exp.set(p.id,(v32Exp.get(p.id)||0)+1);
      }
    }
    const twin32=applyEvilTwinHedging(v32Sel,precomp,DEFAULT_EVIL_TWIN_PARAMS);
    const v32F=twin32.portfolio;
    let vT1=0,vCash=0,vScored=0,sumAct=0;
    for (const lu of v32F) { const a=scoreLineup(lu,actualByHash,actuals); if (a===null) continue; vScored++; sumAct+=a; if (a>=thresholds.top1) vT1++; if (a>=thresholds.cash) vCash++; }
    let sOwn=0,sProj=0; for (const l of v32F){sOwn+=l.players.reduce((sm:number,p:Player)=>sm+(p.ownership||0),0)/l.players.length;sProj+=l.projection;}
    const avgOwn=sOwn/v32F.length; const avgProj=sProj/v32F.length;
    const dist=Math.sqrt(Math.pow((avgProj-regionMap.top1Centroid.projection)/10,2)+Math.pow((avgOwn-regionMap.top1Centroid.ownership)/5,2));

    console.log(`    OLD: t1=${oT1}/${oScored}  V32: t1=${vT1}/${vScored} own=${avgOwn.toFixed(1)}% proj=${avgProj.toFixed(1)} dist=${dist.toFixed(2)}`);

    oldT1Sum += oScored>0?oT1/oScored:0; v32T1Sum += vScored>0?vT1/vScored:0;
    oldCashSum += oScored>0?oCash/oScored:0; v32CashSum += vScored>0?vCash/vScored:0; n++;
    md += `| ${s.date} | ${F.toLocaleString()} | ${pct(oScored>0?oT1/oScored:0)} (${oT1}) | **${pct(vScored>0?vT1/vScored:0)} (${vT1})** | ${avgOwn.toFixed(1)}% | ${avgProj.toFixed(1)} | ${dist.toFixed(2)} | ${pct(vScored>0?vCash/vScored:0)} |\n`;
  }

  md += `| **MEAN** | | **${pct(oldT1Sum/n)}** | **${pct(v32T1Sum/n)}** | | | | **${pct(v32CashSum/n)}** |\n`;
  md += `\nOLD mean top-1%: ${pct(oldT1Sum/n)} | V32 mean top-1%: ${pct(v32T1Sum/n)}\n`;
  fs.writeFileSync(path.join(HIST, 'nba_v32_backtest.md'), md);
  console.log(`\n✓ Report: ${path.join(HIST, 'nba_v32_backtest.md')}`);
}
main();
