/**
 * Multi-level Combo Saturation Extraction — NBA edition.
 *
 * Same methodology as MLB (combo-saturation-extract.ts) but adapted:
 *   - 8-player roster (PG/SG/SF/PF/C/G/F/UTIL)
 *   - No pitcher concept; all combos are hitter-style
 *   - Game-stack focus (NBA's correlation primitive) instead of team-stack
 *   - Combo types: same-team-N, same-game-N, bring-back-NplusM
 *
 * Pro identification: same 7 MLB usernames + any high-volume NBA-only entrants.
 * Several MLB pros (bgreseth, others) play NBA too — that's our pro signal.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player, ContestConfig } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';

const NBA_DIR = 'C:/Users/colin/Projects/dfs-optimizer/historical_slates';
const OUT_DIR = 'C:/Users/colin/dfs opto/combo_saturation_analysis_nba';
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// MLB pros that may also play NBA + try to detect NBA-only pros via volume.
const KNOWN_PROS = new Set(['zroth', 'nerdytenor', 'shipmymoney', 'shaidyadvice', 'needlunchmoney', 'bgreseth', 'youdacao']);

const SLATES = [
  { slate: '2026-01-16', proj: '2026-01-16_projections.csv', actuals: '2026-01-16_actuals.csv', pool: '_backtest_2026-01-16.csv' },
  { slate: '2026-01-17', proj: '2026-01-17_projections.csv', actuals: '2026-01-17_actuals.csv', pool: '_backtest_2026-01-17.csv' },
  { slate: '2026-01-18', proj: '2026-01-18_projections.csv', actuals: '2026-01-18_actuals.csv', pool: '_backtest_2026-01-18.csv' },
  { slate: '2026-01-19', proj: '2026-01-19_projections.csv', actuals: '2026-01-19_actuals.csv', pool: '_backtest_2026-01-19.csv' },
  { slate: '2026-01-20', proj: '2026-01-20_projections.csv', actuals: '2026-01-20_actuals.csv', pool: '_backtest_2026-01-20.csv' },
  { slate: '2026-02-25', proj: '2026-02-25_projections.csv', actuals: '2026-02-25_actuals.csv', pool: '_backtest_2026-02-25.csv' },
  { slate: '2026-02-26', proj: '2026-02-26_projections.csv', actuals: '2026-02-26_actuals.csv', pool: '_backtest_2026-02-26.csv' },
  { slate: '2026-02-27', proj: '2026-02-27_projections.csv', actuals: '2026-02-27_actuals.csv', pool: '_backtest_2026-02-27.csv' },
  { slate: '2026-02-28', proj: '2026-02-28_projections.csv', actuals: '2026-02-28_actuals.csv', pool: '_backtest_2026-02-28.csv' },
  { slate: '2026-03-03', proj: '2026-03-03_projections.csv', actuals: '2026-03-03_actuals.csv', pool: '_backtest_2026-03-03.csv' },
  { slate: '2026-03-05', proj: '2026-03-05_dk_projections.csv', actuals: '2026-03-05_dk_actuals.csv', pool: '_backtest_2026-03-05_dk.csv' },
  { slate: '2026-03-06', proj: '2026-03-06_dk_projections.csv', actuals: '2026-03-06_dk_actuals.csv', pool: '_backtest_2026-03-06_dk.csv' },
];

function norm(n: string): string { return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function extractUsername(entryName: string): string { return (entryName || '').replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase(); }

// NBA combo classifier — no pitcher distinction, just team and game structures.
function classifyCombo(players: Player[]): string[] {
  const types: string[] = [];
  const n = players.length;
  const teamCount = new Map<string, number>();
  for (const p of players) {
    const t = (p.team || '').toUpperCase();
    if (t) teamCount.set(t, (teamCount.get(t) || 0) + 1);
  }
  const games = new Set<string>();
  for (const p of players) {
    const t = (p.team || '').toUpperCase(), o = (p.opponent || '').toUpperCase();
    if (t && o) games.add([t, o].sort().join('@'));
  }
  // All same team.
  if (n >= 2 && teamCount.size === 1) types.push('same-team-' + n);
  // All same game.
  if (n >= 2 && games.size === 1) types.push('same-game-' + n);
  // Bring-back: split between exactly 2 teams in one game.
  if (n >= 3 && teamCount.size === 2 && games.size === 1) {
    const counts = [...teamCount.values()].sort((a, b) => b - a);
    types.push('bring-back-' + counts[0] + 'plus' + counts[1]);
  }
  // Salary tier (pair only).
  if (n === 2) {
    const sals = players.map(p => p.salary || 0).sort((a, b) => b - a);
    if (sals[0] > 8000 && sals[1] > 8000) types.push('pair-both-high-salary');
    else if (sals[0] < 5000 && sals[1] < 5000) types.push('pair-both-low-salary');
  }
  return types;
}

function comboKey(players: Player[]): string {
  return players.map(p => p.id).sort().join('|');
}

function combosOfSize<T>(arr: T[], n: number): T[][] {
  const out: T[][] = []; const k = arr.length;
  if (n > k) return out;
  const idx = Array.from({ length: n }, (_, i) => i);
  while (true) {
    out.push(idx.map(i => arr[i]));
    let i = n - 1;
    while (i >= 0 && idx[i] === k - n + i) i--;
    if (i < 0) break;
    idx[i]++;
    for (let j = i + 1; j < n; j++) idx[j] = idx[j - 1] + 1;
  }
  return out;
}

interface ProLineupRecord { username: string; rank: number; combos: { size: number; type: string; key: string; fieldFreq: number }[]; }
interface SystemLineupRecord { combos: { size: number; type: string; key: string; fieldFreq: number }[]; }
interface SlateRecord {
  slate: string;
  fieldSize: number;
  proLineupCount: number;
  pros: ProLineupRecord[];
  hermes: SystemLineupRecord[];   // not applicable for NBA — empty
  todfs: SystemLineupRecord[];     // Theory-DFS-NBA from prior structural-validation
  fieldSummary: Record<number, { totalCombos: number; meanFreq: number; topCombos: { key: string; freq: number; type: string }[] }>;
  fieldSatByType: Record<string, number>;
  // High-volume usernames in this slate (potentially NBA-specific pros).
  highVolumeUsers: { username: string; entries: number }[];
}

async function processSlate(s: typeof SLATES[0]): Promise<SlateRecord | null> {
  const projPath = path.join(NBA_DIR, s.proj);
  const actualsPath = path.join(NBA_DIR, s.actuals);
  const poolPath = path.join(NBA_DIR, s.pool);
  if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) return null;
  const pr = parseCSVFile(projPath, 'nba', true);
  const config = getContestConfig('dk', 'nba', pr.detectedContestType);
  const playerPool = buildPlayerPool(pr.players, pr.detectedContestType);
  const actuals = parseContestActuals(actualsPath, config);
  const idMap = new Map<string, Player>();
  const nameMap = new Map<string, Player>();
  for (const p of playerPool.players) { idMap.set(p.id, p); nameMap.set(norm(p.name), p); }

  // Build field lineups from actuals.
  const fieldLineups: Player[][] = [];
  for (const e of actuals.entries) {
    const pls: Player[] = [];
    let ok = true;
    for (const nm of e.playerNames) {
      const p = nameMap.get(norm(nm));
      if (!p) { ok = false; break; }
      pls.push(p);
    }
    if (ok && pls.length === config.rosterSize) fieldLineups.push(pls);
  }
  if (fieldLineups.length < 100) return null;

  // Cap field at 10K like MLB analysis (preserves consistency).
  const fieldSize = Math.min(fieldLineups.length, 10000);
  const fl = fieldLineups.slice(0, fieldSize);

  // Build field combo counts at sizes 2-5.
  const fieldCounts: Record<number, Map<string, number>> = { 2: new Map(), 3: new Map(), 4: new Map(), 5: new Map() };
  const keyToTypes: Record<number, Map<string, string[]>> = { 2: new Map(), 3: new Map(), 4: new Map(), 5: new Map() };
  for (const lu of fl) {
    for (const N of [2, 3, 4, 5]) {
      for (const c of combosOfSize(lu, N)) {
        const key = comboKey(c);
        fieldCounts[N].set(key, (fieldCounts[N].get(key) || 0) + 1);
        if (!keyToTypes[N].has(key)) {
          const t = classifyCombo(c);
          if (t.length > 0) keyToTypes[N].set(key, t);
        }
      }
    }
  }

  // Field summary.
  const fieldSummary: SlateRecord['fieldSummary'] = {};
  for (const N of [2, 3, 4, 5]) {
    const totalCombos = fieldCounts[N].size;
    let sum = 0;
    for (const c of fieldCounts[N].values()) sum += c;
    const meanFreq = sum / (totalCombos * fieldSize);
    const top: { key: string; freq: number; type: string }[] = [];
    const sortedKeys = [...fieldCounts[N].entries()].sort((a, b) => b[1] - a[1]).slice(0, 50);
    for (const [k, c] of sortedKeys) {
      const types = keyToTypes[N].get(k) || [];
      top.push({ key: k, freq: c / fieldSize, type: types[0] || 'other' });
    }
    fieldSummary[N] = { totalCombos, meanFreq, topCombos: top };
  }

  // Proper field saturation per (size, type).
  const fieldSatByType: Record<string, number> = {};
  for (const N of [2, 3, 4, 5]) {
    const sumC = new Map<string, number>(), sumC2 = new Map<string, number>();
    for (const [key, count] of fieldCounts[N]) {
      const types = keyToTypes[N].get(key) || [];
      for (const t of types) {
        sumC.set(t, (sumC.get(t) || 0) + count);
        sumC2.set(t, (sumC2.get(t) || 0) + count * count);
      }
    }
    for (const t of sumC.keys()) {
      const sc = sumC.get(t)!, sc2 = sumC2.get(t)!;
      if (sc > 0) fieldSatByType[N + '|' + t] = sc2 / (fieldSize * sc);
    }
  }

  // Identify high-volume usernames (potential NBA pros).
  const userVolume = new Map<string, number>();
  for (const e of actuals.entries) {
    const u = extractUsername(e.entryName);
    if (u) userVolume.set(u, (userVolume.get(u) || 0) + 1);
  }
  const sortedUsers = [...userVolume.entries()].sort((a, b) => b[1] - a[1]);
  const highVolumeUsers = sortedUsers.slice(0, 20).map(([u, n]) => ({ username: u, entries: n }));

  // Pro lineups: known MLB pros + any with 100+ entries (NBA grinder threshold).
  const NBA_VOLUME_PRO_THRESHOLD = 100;
  const detectedNbaPros = new Set<string>();
  for (const [u, n] of userVolume) if (KNOWN_PROS.has(u) || n >= NBA_VOLUME_PRO_THRESHOLD) detectedNbaPros.add(u);
  const proEntries = actuals.entries.filter(e => detectedNbaPros.has(extractUsername(e.entryName)));
  const pros: ProLineupRecord[] = [];
  for (const e of proEntries) {
    const pls: Player[] = [];
    let ok = true;
    for (const nm of e.playerNames) {
      const p = nameMap.get(norm(nm));
      if (!p) { ok = false; break; }
      pls.push(p);
    }
    if (!ok || pls.length !== config.rosterSize) continue;
    const combos: ProLineupRecord['combos'] = [];
    for (const N of [2, 3, 4, 5]) {
      for (const c of combosOfSize(pls, N)) {
        const types = classifyCombo(c);
        if (types.length === 0) continue;
        const key = comboKey(c);
        const cnt = fieldCounts[N].get(key) || 0;
        const freq = cnt / fieldSize;
        for (const t of types) combos.push({ size: N, type: t, key, fieldFreq: freq });
      }
    }
    pros.push({ username: extractUsername(e.entryName), rank: e.rank, combos });
  }

  // Theory-DFS-NBA portfolios from cross-sport JSON if present.
  const todfs: SystemLineupRecord[] = [];
  try {
    const sysData = JSON.parse(fs.readFileSync(path.join('C:/Users/colin/dfs opto/theory_dfs_nba', 'nba_results.json'), 'utf-8'));
    const slateData = sysData.perSlate.find((x: any) => x.slate === s.slate);
    if (slateData) {
      // The JSON saved per-slate metrics but not per-lineup composition. Skip.
    }
  } catch {}

  return { slate: s.slate, fieldSize, proLineupCount: pros.length, pros, hermes: [], todfs, fieldSummary, fieldSatByType, highVolumeUsers };
}

async function main() {
  console.log('================================================================');
  console.log('COMBO SATURATION EXTRACTION — NBA');
  console.log('================================================================\n');
  const all: SlateRecord[] = [];
  const outPath = path.join(OUT_DIR, 'raw_combos_nba.json');
  for (const s of SLATES) {
    process.stderr.write(s.slate + '... ');
    const t0 = Date.now();
    const rec = await processSlate(s);
    if (rec) {
      all.push(rec);
      process.stderr.write('field=' + rec.fieldSize + ' pros=' + rec.proLineupCount + ' [' + ((Date.now() - t0) / 1000).toFixed(1) + 's]\n');
      fs.writeFileSync(outPath, JSON.stringify(all, null, 0));
    }
  }
  const sizeMB = fs.statSync(outPath).size / 1024 / 1024;
  process.stderr.write('\nSaved ' + all.length + ' slates to ' + outPath + ' (' + sizeMB.toFixed(1) + ' MB)\n');

  // Print high-volume usernames for diagnostic.
  console.log('\nHigh-volume usernames per slate (top 5):');
  for (const r of all) {
    console.log('  ' + r.slate + ': ' + r.highVolumeUsers.slice(0, 5).map(u => u.username + '(' + u.entries + ')').join(', '));
  }
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });
