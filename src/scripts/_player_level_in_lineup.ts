/**
 * Within-lineup player-level analysis:
 *
 * For each lineup (pro or Argus), look at the 10 PLAYERS picked. Compute:
 *   - avg player projection
 *   - avg player std (IQR-based proxy: (p75-p25)/1.349)
 *   - avg player CV (std / projection)  — normalized volatility
 *   - within-lineup std of player std (do they mix steady + volatile?)
 *   - avg player ownership
 *   - ownership quartile distribution (how many players in 0-25%, 25-50%, etc.)
 *   - count of "boom" players (CV > 0.45), "steady" players (CV < 0.25)
 *
 * Aggregated across all slates, per pro + Argus-Atlas.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Player } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, ContestEntry } from '../parser';
import { getContestConfig } from '../rules';

const DIR = 'C:/Users/colin/dfs opto';
const OUT_DIR = path.join(DIR, 'multi_combo_penalty_implementation');

const SLATE_FILES: Record<string, { proj: string; actuals: string }> = {
  '4-6-26': { proj: '4-6-26_projections.csv', actuals: 'dkactuals 4-6-26.csv' },
  '4-8-26': { proj: '4-8-26projections.csv', actuals: '4-8-26actuals.csv' },
  '4-12-26': { proj: '4-12-26projections.csv', actuals: '4-12-26actuals.csv' },
  '4-14-26': { proj: '4-14-26projections.csv', actuals: '4-14-26actuals.csv' },
  '4-15-26': { proj: '4-15-26projections.csv', actuals: '4-15-26actuals.csv' },
  '4-17-26': { proj: '4-17-26projections.csv', actuals: '4-17-26actuals.csv' },
  '4-18-26': { proj: '4-18-26projections.csv', actuals: '4-18-26actuals.csv' },
  '4-19-26': { proj: '4-19-26projections.csv', actuals: '4-19-26actuals.csv' },
  '4-20-26': { proj: '4-20-26projections.csv', actuals: '4-20-26actuals.csv' },
  '4-21-26': { proj: '4-21-26projections.csv', actuals: '4-21-26actuals.csv' },
  '4-22-26': { proj: '4-22-26projections.csv', actuals: '4-22-26actuals.csv' },
  '4-23-26': { proj: '4-23-26projections.csv', actuals: '4-23-26actuals.csv' },
  '4-24-26': { proj: '4-24-26projections.csv', actuals: '4-24-26actuals.csv' },
  '4-25-26': { proj: '4-25-26projections.csv', actuals: '4-25-26actuals.csv' },
  '4-25-26-early': { proj: '4-25-26projectionsearly.csv', actuals: '4-25-26actualsearly.csv' },
  '4-26-26': { proj: '4-26-26projections.csv', actuals: '4-26-26actuals.csv' },
  '4-27-26': { proj: '4-27-26projections.csv', actuals: '4-27-26actuals.csv' },
  '4-28-26': { proj: '4-28-26projections.csv', actuals: '4-28-26actuals.csv' },
  '4-29-26': { proj: '4-29-26projections.csv', actuals: '4-29-26actuals.csv' },
  '5-1-26': { proj: '5-1-26projections.csv', actuals: '5-1-26actuals.csv' },
  '5-2-26': { proj: '5-2-26projections.csv', actuals: '5-2-26actuals.csv' },
  '5-2-26-main': { proj: '5-2-26projectionsmain.csv', actuals: '5-2-26actualsmain.csv' },
  '5-3-26': { proj: '5-3-26projections.csv', actuals: '5-3-26actuals.csv' },
  '5-3-26-late': { proj: '5-3-26projectionslate.csv', actuals: '5-3-26actualslate.csv' },
  '5-4-26': { proj: '5-4-26projections.csv', actuals: '5-4-26actuals.csv' },
  '5-4-26-late': { proj: '5-4-26projectionslate.csv', actuals: '5-4-26actualslate.csv' },
  '5-5-26': { proj: '5-5-26projections.csv', actuals: '5-5-26actuals.csv' },
  '5-6-26': { proj: '5-6-26projections.csv', actuals: '5-6-26actuals.csv' },
  '5-8-26': { proj: '5-8-26projections.csv', actuals: '5-8-26actuals.csv' },
  '5-10-26': { proj: '5-10-26projections.csv', actuals: '5-10-26actuals.csv' },
  '5-10-26-late': { proj: '5-10-26projectionslate.csv', actuals: '5-10-26actualslate.csv' },
};

const PROS = [
  { label: 'nerdytenor', tokens: ['nerdytenor'] },
  { label: 'zroth', tokens: ['zroth', 'zroth2'] },
  { label: 'youdacao', tokens: ['youdacao'] },
  { label: 'shipmymoney', tokens: ['shipmymoney'] },
  { label: 'shaidyadvice', tokens: ['shaidyadvice'] },
  { label: 'bgreseth', tokens: ['bgreseth'] },
  { label: 'needlunchmoney', tokens: ['needlunchmoney'] },
];

function norm(n: string): string { return (n||'').toLowerCase().replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim(); }
function extractUser(e: string): string { return (e||'').replace(/\s*\([^)]*\)\s*$/,'').trim(); }
function mean(a: number[]): number { return a.length ? a.reduce((s,v)=>s+v,0)/a.length : 0; }
function stddev(a: number[]): number { if (a.length<2) return 0; const m=mean(a); return Math.sqrt(a.reduce((s,v)=>s+(v-m)**2,0)/a.length); }

function playerStdP99(p: Player): number {
  // Top-end std proxy: distance from projection to p99, divided by 2.33σ assumption.
  const pct = (p as any).percentiles;
  if (!pct) return (p.projection || 0) * 0.45;
  const p99 = pct.p99 || 0;
  const proj = p.projection || 0;
  return Math.max(0, (p99 - proj) / 2.33);
}

function playerCVp99(p: Player): number {
  const proj = p.projection || 0;
  if (proj <= 0.01) return 0;
  return playerStdP99(p) / proj;
}

function lineupMetrics(lu: Player[]) {
  const projs = lu.map(p => p.projection || 0);
  const stds = lu.map(playerStdP99);
  const cvs = lu.map(playerCVp99);
  const owns = lu.map(p => p.ownership || 0);
  const p99s = lu.map(p => (p as any).percentiles?.p99 || 0);
  return {
    avgProj: mean(projs),
    avgP99: mean(p99s),
    avgPlayerStdP99: mean(stds),
    avgPlayerCV: mean(cvs),
    stdOfStdsIn: stddev(stds),       // within-lineup spread of player volatilities
    cvOfStdsIn: mean(stds) > 0 ? stddev(stds)/mean(stds) : 0,
    avgOwn: mean(owns),
    stdOwnIn: stddev(owns),
    nBoom: cvs.filter(c => c > 0.45).length,
    nSteady: cvs.filter(c => c < 0.25).length,
    nVeryHighOwn: owns.filter(o => o > 30).length,
    nHighOwn: owns.filter(o => o > 20).length,
    nLowOwn: owns.filter(o => o < 10).length,
    nVeryLowOwn: owns.filter(o => o < 5).length,
    nPunt: owns.filter(o => o < 3).length,
  };
}

async function main() {
  const groups: Record<string, ReturnType<typeof lineupMetrics>[]> = {};
  for (const lbl of [...PROS.map(p => p.label), 'argus-atlas']) groups[lbl] = [];

  for (const [slate, f] of Object.entries(SLATE_FILES)) {
    const projPath = path.join(DIR, f.proj);
    const actualsPath = path.join(DIR, f.actuals);
    if (!fs.existsSync(projPath) || !fs.existsSync(actualsPath)) continue;
    const pr = parseCSVFile(projPath, 'mlb', true);
    const cfg = getContestConfig('dk', 'mlb', pr.detectedContestType);
    const pool = buildPlayerPool(pr.players, pr.detectedContestType);
    const actuals = parseContestActuals(actualsPath, cfg);
    const nameMap = new Map<string, Player>();
    for (const p of pool.players) nameMap.set(norm(p.name), p);

    const byUser = new Map<string, ContestEntry[]>();
    for (const e of actuals.entries) {
      const u = extractUser(e.entryName);
      const arr = byUser.get(u); if (arr) arr.push(e); else byUser.set(u, [e]);
    }
    for (const pro of PROS) {
      let matched: ContestEntry[] = [];
      for (const [u, ents] of byUser) {
        if (pro.tokens.some(t => u.toLowerCase().includes(t))) matched = matched.concat(ents);
      }
      if (matched.length < 100) continue;
      for (const e of matched.slice(0, 150)) {
        const pls: Player[] = []; let ok = true;
        for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
        if (ok) groups[pro.label].push(lineupMetrics(pls));
      }
    }
    // Argus
    const argusFile = ['argus_v9e_32slate_lineups_','argus_v9e_lineups_','argus_v9c_lineups_']
      .map(prefix => path.join(OUT_DIR, prefix + slate + '.csv'))
      .find(p => fs.existsSync(p));
    if (!argusFile) continue;
    const lines = fs.readFileSync(argusFile, 'utf-8').split('\n').slice(1).filter(l => l.trim());
    for (const line of lines) {
      const m = line.match(/"([^"]+)"/);
      if (!m) continue;
      const names = m[1].split('|');
      const pls: Player[] = []; let ok = true;
      for (const nm of names) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
      if (ok) groups['argus-atlas'].push(lineupMetrics(pls));
    }
  }

  console.log('Within-lineup player-level analysis (player std from p99: (p99-proj)/2.33)\n');
  const cols = ['label','n_lus','avgProj','avgP99','avgStdP99','avgCV(p99)','stdOfStds_in','cvOfStds_in','stdOfStds_across','avgOwn','stdOwn_in','#boom','#steady','#own>30','#own>20','#own<10','#own<5','#own<3'];
  const widths = [16,7,8,8,10,11,13,12,17,7,10,7,8,8,8,8,7,7];
  console.log(cols.map((c,i)=>c.padEnd(widths[i])).join(' '));
  console.log('-'.repeat(widths.reduce((a,b)=>a+b,0) + cols.length));
  for (const [lbl, arr] of Object.entries(groups)) {
    if (!arr.length) continue;
    const f = (k: keyof typeof arr[0]) => mean(arr.map(x => x[k] as number));
    const stdAcross = (k: keyof typeof arr[0]) => stddev(arr.map(x => x[k] as number));
    const v: string[] = [
      lbl.padEnd(widths[0]),
      String(arr.length).padStart(widths[1]),
      f('avgProj').toFixed(2).padStart(widths[2]),
      f('avgP99').toFixed(2).padStart(widths[3]),
      f('avgPlayerStdP99').toFixed(2).padStart(widths[4]),
      f('avgPlayerCV').toFixed(3).padStart(widths[5]),
      f('stdOfStdsIn').toFixed(2).padStart(widths[6]),
      f('cvOfStdsIn').toFixed(3).padStart(widths[7]),
      stdAcross('avgPlayerStdP99').toFixed(2).padStart(widths[8]),
      f('avgOwn').toFixed(2).padStart(widths[9]),
      f('stdOwnIn').toFixed(2).padStart(widths[10]),
      f('nBoom').toFixed(2).padStart(widths[11]),
      f('nSteady').toFixed(2).padStart(widths[12]),
      f('nVeryHighOwn').toFixed(2).padStart(widths[13]),
      f('nHighOwn').toFixed(2).padStart(widths[14]),
      f('nLowOwn').toFixed(2).padStart(widths[15]),
      f('nVeryLowOwn').toFixed(2).padStart(widths[16]),
      f('nPunt').toFixed(2).padStart(widths[17]),
    ];
    console.log(v.join(' '));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
