/**
 * Multi-level Combinatorial Saturation Extraction.
 *
 * For each MLB slate:
 *   - Load actuals (field representative)
 *   - Identify pro entries by username (zroth, nerdytenor, shipmymoney, shaidyadvice,
 *     needlunchmoney, bgreseth, youdacao)
 *   - For each combo size N in {2,3,4,5}:
 *     * Build field combo→count map (one pass over actuals)
 *     * For each pro lineup, enumerate combos, classify by type, look up field freq
 *   - Also extract for Hermes-A and Theory-DFS portfolios from prior structural-validation JSON
 *
 * Output: combo_saturation_analysis/raw_combos.json with per-slate-per-system-per-lineup
 * combo records. Python analyzer consumes this to produce the saturation gap tables.
 *
 * Design choice: classify combos by structural type (same-team-hitter, P+stack, etc.)
 * since framework Ch.6 says pure random combos don't carry correlation weight.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player, ContestConfig } from '../types';
import { parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals } from '../parser';
import { getContestConfig } from '../rules';

const MLB_DIR = 'C:/Users/colin/dfs opto';
const OUT_DIR = 'C:/Users/colin/dfs opto/combo_saturation_analysis';
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const PRO_NAMES = new Set(['zroth', 'nerdytenor', 'shipmymoney', 'shaidyadvice', 'needlunchmoney', 'bgreseth', 'youdacao']);

const SLATES = [
  { slate: '4-6-26', proj: '4-6-26_projections.csv', actuals: 'dkactuals 4-6-26.csv', pool: 'sspool4-6-26.csv' },
  { slate: '4-8-26', proj: '4-8-26projections.csv', actuals: '4-8-26actuals.csv', pool: '4-8-26sspool.csv' },
  { slate: '4-12-26', proj: '4-12-26projections.csv', actuals: '4-12-26actuals.csv', pool: '4-12-26sspool.csv' },
  { slate: '4-14-26', proj: '4-14-26projections.csv', actuals: '4-14-26actuals.csv', pool: '4-14-26sspool.csv' },
  { slate: '4-15-26', proj: '4-15-26projections.csv', actuals: '4-15-26actuals.csv', pool: '4-15-26sspool.csv' },
  { slate: '4-17-26', proj: '4-17-26projections.csv', actuals: '4-17-26actuals.csv', pool: '4-17-26sspool.csv' },
  { slate: '4-18-26', proj: '4-18-26projections.csv', actuals: '4-18-26actuals.csv', pool: '4-18-26sspool.csv' },
  { slate: '4-19-26', proj: '4-19-26projections.csv', actuals: '4-19-26actuals.csv', pool: '4-19-26sspool.csv' },
  { slate: '4-20-26', proj: '4-20-26projections.csv', actuals: '4-20-26actuals.csv', pool: '4-20-26sspool.csv' },
  { slate: '4-21-26', proj: '4-21-26projections.csv', actuals: '4-21-26actuals.csv', pool: '4-21-26sspool.csv' },
  { slate: '4-22-26', proj: '4-22-26projections.csv', actuals: '4-22-26actuals.csv', pool: '4-22-26sspool.csv' },
  { slate: '4-23-26', proj: '4-23-26projections.csv', actuals: '4-23-26actuals.csv', pool: '4-23-26sspool.csv' },
  { slate: '4-24-26', proj: '4-24-26projections.csv', actuals: '4-24-26actuals.csv', pool: '4-24-26sspool.csv' },
  { slate: '4-25-26', proj: '4-25-26projections.csv', actuals: '4-25-26actuals.csv', pool: '4-25-26sspool.csv' },
  { slate: '4-25-26-early', proj: '4-25-26projectionsearly.csv', actuals: '4-25-26actualsearly.csv', pool: '4-25-26sspoolearly.csv' },
  { slate: '4-26-26', proj: '4-26-26projections.csv', actuals: '4-26-26actuals.csv', pool: '4-26-26sspool.csv' },
  { slate: '4-27-26', proj: '4-27-26projections.csv', actuals: '4-27-26actuals.csv', pool: '4-27-26sspool.csv' },
  { slate: '4-28-26', proj: '4-28-26projections.csv', actuals: '4-28-26actuals.csv', pool: '4-28-26sspool.csv' },
];

function norm(n: string): string {
  return (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function extractUsername(entryName: string): string {
  // "nerdytenor (93/150)" → "nerdytenor". Drop trailing parenthetical.
  return (entryName || '').replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();
}

// Classify a player by role (P = pitcher, H = hitter).
function isPitcher(p: Player): boolean {
  return (p.position || '').toUpperCase().includes('P') || !!(p.positions || []).includes?.('P');
}

// ============================================================
// COMBO ENUMERATION + CLASSIFICATION
// ============================================================

interface ComboRecord {
  size: number;            // 2/3/4/5
  type: string;            // same-team-hitter, P-stack, etc.
  key: string;             // sorted player-IDs joined by '|'
}

function combosOfSize<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  const k = arr.length;
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

// Classify a combo of N players based on team / position / opposing-game structure.
// Returns one or more type labels; a single combo may belong to multiple types
// (e.g., a same-team triple is also a same-game triple). We dedupe at usage time.
function classifyCombo(players: Player[]): string[] {
  const types: string[] = [];
  const teams = new Set(players.map(p => (p.team || '').toUpperCase()).filter(t => t));
  const pitchers = players.filter(p => isPitcher(p));
  const hitters = players.filter(p => !isPitcher(p));
  const teamCount = new Map<string, number>();
  for (const p of hitters) {
    const t = (p.team || '').toUpperCase();
    if (t) teamCount.set(t, (teamCount.get(t) || 0) + 1);
  }
  const opponents = new Set(players.map(p => (p.opponent || '').toUpperCase()).filter(t => t));

  const n = players.length;
  // All same team?
  if (n >= 2 && hitters.length === n) {
    const distinctTeams = new Set(hitters.map(p => (p.team || '').toUpperCase()));
    if (distinctTeams.size === 1) types.push(`same-team-${n}H`);
  }

  // Same game (all in one game)?
  if (n >= 2) {
    const games = new Set<string>();
    for (const p of players) {
      const t = (p.team || '').toUpperCase(), o = (p.opponent || '').toUpperCase();
      if (t && o) games.add([t, o].sort().join('@'));
    }
    if (games.size === 1) types.push(`same-game-${n}`);
  }

  // Bring-back patterns (split between two opposing teams in one game).
  if (n >= 3 && hitters.length === n) {
    const teamArr = [...teamCount.entries()];
    if (teamArr.length === 2) {
      const [t1, c1] = teamArr[0]; const [t2, c2] = teamArr[1];
      // Check they oppose each other.
      const sample1 = hitters.find(p => (p.team || '').toUpperCase() === t1);
      const sample2 = hitters.find(p => (p.team || '').toUpperCase() === t2);
      if (sample1 && sample2 && (sample1.opponent || '').toUpperCase() === t2 && (sample2.opponent || '').toUpperCase() === t1) {
        const [a, b] = [c1, c2].sort((x, y) => y - x);
        types.push(`bring-back-${a}plus${b}`);
      }
    }
  }

  // Pitcher + N-stack (any combo with exactly 1 pitcher and the rest from one hitter team).
  if (pitchers.length === 1 && hitters.length >= 2) {
    const distinctHitterTeams = new Set(hitters.map(p => (p.team || '').toUpperCase()));
    if (distinctHitterTeams.size === 1) types.push(`P-plus-${hitters.length}stack`);
  }

  // P-vs-opposing-H (pitcher + at least one hitter from pitcher's opposing team).
  if (pitchers.length >= 1) {
    for (const pp of pitchers) {
      const popp = (pp.opponent || '').toUpperCase();
      if (popp) {
        const oppHitters = hitters.filter(p => (p.team || '').toUpperCase() === popp);
        if (oppHitters.length === n - 1 && pitchers.length === 1) types.push(`P-vs-${oppHitters.length}H`);
      }
    }
  }

  // Salary tier pair (only at N=2; classify as both-top-25% or both-bot-25%).
  if (n === 2) {
    const sals = players.map(p => p.salary || 0).sort((a, b) => b - a);
    if (sals[0] > 6000 && sals[1] > 6000) types.push('pair-both-high-salary');
    else if (sals[0] < 4000 && sals[1] < 4000) types.push('pair-both-low-salary');
  }

  return types;
}

function comboKey(players: Player[]): string {
  return players.map(p => p.id).sort().join('|');
}

// ============================================================
// PER-SLATE EXTRACTION
// ============================================================

interface SlateRecord {
  slate: string;
  fieldSize: number;
  proLineupCount: number;
  pros: ProLineupRecord[];
  hermes: SystemLineupRecord[];
  todfs: SystemLineupRecord[];
  fieldSummary: Record<number, { totalCombos: number; meanFreq: number; topCombos: { key: string; freq: number; type: string }[] }>;
  // PROPER field saturation per (size, type): expected fieldFreq of a combo drawn from a random
  // field lineup, weighted by combo occurrence. Computed as sum(c^2) / (F * sum(c)) per type.
  fieldSatByType: Record<string, number>;  // key = "size|type" → expected freq
}

interface ProLineupRecord {
  username: string;
  rank: number;
  combos: { size: number; type: string; key: string; fieldFreq: number }[];
}

interface SystemLineupRecord {
  combos: { size: number; type: string; key: string; fieldFreq: number }[];
}

async function processSlate(s: typeof SLATES[0]): Promise<SlateRecord | null> {
  const projPath = path.join(MLB_DIR, s.proj);
  const actualsPath = path.join(MLB_DIR, s.actuals);
  const poolPath = path.join(MLB_DIR, s.pool);
  if (![projPath, actualsPath, poolPath].every(p => fs.existsSync(p))) return null;

  const pr = parseCSVFile(projPath, 'mlb', true);
  const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
  const playerPool = buildPlayerPool(pr.players, pr.detectedContestType);
  const actuals = parseContestActuals(actualsPath, config);
  const idMap = new Map<string, Player>();
  const nameMap = new Map<string, Player>();
  for (const p of playerPool.players) { idMap.set(p.id, p); nameMap.set(norm(p.name), p); }

  // Resolve actuals entries → Player[][] (drop entries with unresolvable players).
  const allFieldLineups: Player[][] = [];
  for (const e of actuals.entries) {
    const pls: Player[] = [];
    let ok = true;
    for (const nm of e.playerNames) {
      const p = nameMap.get(norm(nm));
      if (!p) { ok = false; break; }
      pls.push(p);
    }
    if (ok && pls.length === config.rosterSize) allFieldLineups.push(pls);
  }
  // Subsample large fields to 10K (representative for combo frequency estimation, computationally bounded).
  const FIELD_SAMPLE_CAP = 10000;
  let fieldLineups = allFieldLineups;
  if (allFieldLineups.length > FIELD_SAMPLE_CAP) {
    // Keep top-ranked entries (rank 1 first) — preserves the heavy-action portion of field.
    fieldLineups = allFieldLineups.slice(0, FIELD_SAMPLE_CAP);
  }
  const fieldSize = fieldLineups.length;
  process.stderr.write(`  ${s.slate}: ${allFieldLineups.length} resolved → ${fieldSize} sampled field lineups\n`);
  if (fieldSize < 100) {
    console.log(`  skip ${s.slate}: only ${fieldSize} resolvable field lineups`);
    return null;
  }

  // Build field combo count maps for N = 2,3,4,5.
  const fieldCounts: Record<number, Map<string, number>> = { 2: new Map(), 3: new Map(), 4: new Map(), 5: new Map() };
  // For top-saturated tracking, also remember representative classification per key.
  const keyToTypes: Record<number, Map<string, string[]>> = { 2: new Map(), 3: new Map(), 4: new Map(), 5: new Map() };
  for (const lu of fieldLineups) {
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

  // Field summary: top-K most-saturated combos per level.
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

  // PROPER field saturation per (size, type): expected fieldFreq of a combo drawn from a random
  // field lineup. = sum(c^2) / (F * sum(c)) for combos of that type.
  const fieldSatByType: Record<string, number> = {};
  for (const N of [2, 3, 4, 5]) {
    // Aggregate sum_c, sum_c2 per type from fieldCounts + keyToTypes.
    const sumC: Map<string, number> = new Map();
    const sumC2: Map<string, number> = new Map();
    for (const [key, count] of fieldCounts[N]) {
      const types = keyToTypes[N].get(key) || [];
      for (const t of types) {
        sumC.set(t, (sumC.get(t) || 0) + count);
        sumC2.set(t, (sumC2.get(t) || 0) + count * count);
      }
    }
    for (const t of sumC.keys()) {
      const sc = sumC.get(t)!;
      const sc2 = sumC2.get(t)!;
      if (sc > 0) {
        fieldSatByType[`${N}|${t}`] = sc2 / (fieldSize * sc);
      }
    }
  }

  // Identify pro entries.
  const proEntries = actuals.entries.filter(e => PRO_NAMES.has(extractUsername(e.entryName)));
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
        if (types.length === 0) continue;  // skip uninteresting combos
        const key = comboKey(c);
        const cnt = fieldCounts[N].get(key) || 0;
        const freq = cnt / fieldSize;
        for (const t of types) combos.push({ size: N, type: t, key, fieldFreq: freq });
      }
    }
    pros.push({ username: extractUsername(e.entryName), rank: e.rank, combos });
  }

  // Hermes-A and Theory-DFS portfolios from structural-validation output.
  const hermes: SystemLineupRecord[] = [];
  const todfs: SystemLineupRecord[] = [];
  try {
    const sysData = JSON.parse(fs.readFileSync(path.join(MLB_DIR, 'theory_dfs_structural', 'all_systems_lineups.json'), 'utf-8'));
    for (const sys of sysData) {
      if (sys.slate !== s.slate) continue;
      const isHermes = sys.system === 'hermes-a';
      const isTodfs = sys.system === 'theory-dfs-mlb';
      if (!isHermes && !isTodfs) continue;
      for (const lu of sys.lineups) {
        const pls = lu.pids.map((pid: string) => idMap.get(pid)).filter((p: Player | undefined) => p !== undefined) as Player[];
        if (pls.length !== config.rosterSize) continue;
        const combos: SystemLineupRecord['combos'] = [];
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
        const rec = { combos };
        if (isHermes) hermes.push(rec);
        else todfs.push(rec);
      }
    }
  } catch (e) {
    console.log(`  warn ${s.slate}: structural data not loaded (${e})`);
  }

  return { slate: s.slate, fieldSize, proLineupCount: pros.length, pros, hermes, todfs, fieldSummary, fieldSatByType };
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log('================================================================');
  console.log('COMBO SATURATION EXTRACTION (descriptive only)');
  console.log('================================================================\n');

  const all: SlateRecord[] = [];
  const outPath = path.join(OUT_DIR, 'raw_combos.json');
  for (const s of SLATES) {
    process.stderr.write(`${s.slate}... `);
    const t0 = Date.now();
    const rec = await processSlate(s);
    if (rec) {
      all.push(rec);
      process.stderr.write(`field=${rec.fieldSize} pros=${rec.proLineupCount} hermes=${rec.hermes.length} todfs=${rec.todfs.length} [${((Date.now() - t0) / 1000).toFixed(1)}s]\n`);
      // Incremental save every slate so we don't lose progress on long runs.
      fs.writeFileSync(outPath, JSON.stringify(all, null, 0));
    }
  }
  const sizeMB = fs.statSync(outPath).size / 1024 / 1024;
  process.stderr.write(`\nSaved ${all.length} slates to ${outPath} (${sizeMB.toFixed(1)} MB)\n`);
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });
