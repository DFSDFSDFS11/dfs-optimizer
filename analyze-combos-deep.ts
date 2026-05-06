/**
 * Deep Combo Analysis — 6 Critical Sub-Questions (Enhanced)
 *
 * Before changing the crowding discount, answer each definitively.
 * Don't take the first aggregate answer at face value — aggregates hide structure.
 *
 * Q1: Does combo uniqueness help in LARGE fields (29K+)?
 * Q2: Does combo uniqueness help at the VERY TOP (rank 1-10, not rank 1-100)?
 * Q3: Do pro HITS have different combo profiles than pro MISSES?
 * Q4: Do pro CONTRARIAN lineups hit at a higher rate than pro CHALK lineups?
 * Q5: Are top-1% lineups converging on ONE combo or MANY?
 * Q6: Does GAME concentration predict winning more than TEAM stacking?
 */

import * as fs from 'fs';
import * as path from 'path';

const DATA_DIR = './historical_slates';

interface PlayerData {
  name: string; team: string; salary: number; actual: number;
  projection: number; ownership: number; positions: string[];
  gameInfo: string; // normalized: sorted teams joined by '|'
  opp: string;
}

interface AnalyzedEntry {
  rank: number; points: number; entryName: string;
  playerNames: string[]; avgOwnership: number;
  maxCombo4Freq: number; avgCombo4Freq: number;
  maxCombo3Freq: number;
  maxPlayersOneGame: number;
  primaryStackSize: number; hasBringBack: boolean;
  rankPct: number;
  // Enhanced fields
  productOwnership: number; // product of all player ownerships (as decimals)
  numDistinctGames: number;
  numDistinctTeams: number;
  primaryGame: string; // the game with most players
  primaryTeam: string; // the team with most players
  playersFromPrimaryGame: number;
  coreComboKey: string; // top-3 owned players sorted
  shellComboKey: string; // bottom-5 players sorted
}

interface SlateAnalysis {
  date: string;
  fieldSize: number;
  entries: AnalyzedEntry[];
  comboRatio: number; // top1% combo freq / field combo freq
  combo4Freq: Map<string, number>;
  combo3Freq: Map<string, number>;
  playerPool: Map<string, PlayerData>;
}

function parseLineupText(text: string): string[] {
  const names: string[] = [];
  const parts = text.split(/\s+(?=PG |SG |SF |PF |C |G |F |UTIL )/);
  for (const part of parts) {
    const cleaned = part.replace(/^(PG|SG|SF|PF|C|G|F|UTIL)\s+/, '').trim();
    if (cleaned) names.push(cleaned);
  }
  return names;
}

function avg(arr: number[]): number { return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}
function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.floor(s.length * p);
  return s[Math.min(idx, s.length - 1)];
}
function correlation(xs: number[], ys: number[]): number {
  if (xs.length < 3) return 0;
  const mx = avg(xs), my = avg(ys);
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < xs.length; i++) {
    cov += (xs[i] - mx) * (ys[i] - my);
    vx += (xs[i] - mx) ** 2;
    vy += (ys[i] - my) ** 2;
  }
  return vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : 0;
}

function main() {
  console.log('================================================================');
  console.log('DEEP COMBO ANALYSIS — 6 Critical Questions (Enhanced)');
  console.log('Don\'t gut the crowding discount until ALL 6 are answered.');
  console.log('================================================================\n');

  const files = fs.readdirSync(DATA_DIR);
  const allSlates: SlateAnalysis[] = [];
  const allEntriesGlobal: AnalyzedEntry[] = [];

  for (const f of files) {
    if (!f.includes('_actuals')) continue;
    const base = f.replace('_actuals.csv', '');
    // Match projection file: same base prefix
    const projFile = files.find(pf => pf.startsWith(base.replace('_dk', '').replace('_night', '')) && pf.includes('projections')
      && ((base.includes('_dk_night') && pf.includes('_night')) || (base.includes('_dk') && !base.includes('_night') && pf.includes('_dk') && !pf.includes('_night')) || (!base.includes('_dk') && !pf.includes('_dk'))));
    // Simplified: find matching projection file
    const projFileSimple = files.find(pf => {
      const projBase = pf.replace('_projections.csv', '');
      return projBase === base.replace('_actuals', '').replace('.csv', '') ||
             (base.startsWith(projBase) && pf.includes('projections'));
    });
    const actualProjFile = projFile || projFileSimple || files.find(pf => pf.startsWith(base.split('_')[0]) && pf.includes('projections'));
    if (!actualProjFile) { console.log(`  SKIP ${base}: no projection file`); continue; }

    // Load projections
    const projRaw = fs.readFileSync(path.join(DATA_DIR, actualProjFile), 'utf-8');
    const projLines = projRaw.split(/\r?\n/).filter(l => l.trim());
    const projHeaders = projLines[0].split(',');
    const nameIdx = projHeaders.indexOf('Name');
    const ownIdx = projHeaders.indexOf('My Own') >= 0 ? projHeaders.indexOf('My Own') : projHeaders.indexOf('Adj Own');
    const teamIdx = projHeaders.indexOf('Team');
    const oppIdx = projHeaders.indexOf('Opp');
    const salaryIdx = projHeaders.indexOf('Salary');
    const projIdx = projHeaders.indexOf('SS Proj');
    const actualIdx = projHeaders.indexOf('Actual');
    const posIdx = projHeaders.indexOf('Pos');

    const playerPool = new Map<string, PlayerData>();
    for (let i = 1; i < projLines.length; i++) {
      const cols = projLines[i].split(',');
      const name = cols[nameIdx]?.trim();
      if (!name) continue;
      const team = cols[teamIdx]?.trim() || '';
      const opp = cols[oppIdx]?.trim() || '';
      const gameInfo = [team, opp].sort().join('|');
      playerPool.set(name, {
        name, team, opp, gameInfo,
        salary: parseFloat(cols[salaryIdx]) || 0,
        actual: parseFloat(cols[actualIdx]) || 0,
        projection: parseFloat(cols[projIdx]) || 0,
        ownership: parseFloat(cols[ownIdx]) || 0,
        positions: (cols[posIdx]?.trim() || '').split('/'),
      });
    }

    // Load actuals
    const actRaw = fs.readFileSync(path.join(DATA_DIR, f), 'utf-8').replace(/^\uFEFF/, '');
    const actLines = actRaw.split(/\r?\n/).filter(l => l.trim());

    const rawEntries: { rank: number; points: number; entryName: string; playerNames: string[] }[] = [];
    for (let i = 1; i < actLines.length; i++) {
      const cols = actLines[i].split(',');
      const rank = parseInt(cols[0]);
      const points = parseFloat(cols[4]);
      const lineupText = cols[5]?.trim() || '';
      if (isNaN(rank) || !lineupText) continue;
      rawEntries.push({ rank, points, entryName: cols[2]?.trim() || '', playerNames: parseLineupText(lineupText) });
    }

    if (rawEntries.length < 500) continue;
    const totalEntries = rawEntries.length;

    // Build combo frequency maps from random sample of field
    const SAMPLE_SIZE = Math.min(5000, rawEntries.length);
    const sampleSet = new Set<number>();
    while (sampleSet.size < SAMPLE_SIZE) sampleSet.add(Math.floor(Math.random() * rawEntries.length));
    const sampleEntries = [...sampleSet].map(i => rawEntries[i]);

    const combo4Freq = new Map<string, number>();
    const combo3Freq = new Map<string, number>();
    for (const entry of sampleEntries) {
      const names = entry.playerNames.sort();
      for (let i = 0; i < names.length; i++)
        for (let j = i + 1; j < names.length; j++)
          for (let k = j + 1; k < names.length; k++) {
            combo3Freq.set(`${names[i]}|${names[j]}|${names[k]}`, (combo3Freq.get(`${names[i]}|${names[j]}|${names[k]}`) || 0) + 1);
            for (let l = k + 1; l < names.length; l++) {
              const key = `${names[i]}|${names[j]}|${names[k]}|${names[l]}`;
              combo4Freq.set(key, (combo4Freq.get(key) || 0) + 1);
            }
          }
    }
    for (const [k, v] of combo3Freq) combo3Freq.set(k, v / SAMPLE_SIZE);
    for (const [k, v] of combo4Freq) combo4Freq.set(k, v / SAMPLE_SIZE);

    // Analyze each entry
    const analyzed: AnalyzedEntry[] = [];
    for (const entry of rawEntries) {
      const names = entry.playerNames.sort();
      if (names.length < 6) continue;

      // Max & avg 4-combo freq
      let maxC4 = 0, sumC4 = 0, countC4 = 0;
      let maxC3 = 0;
      for (let i = 0; i < names.length; i++)
        for (let j = i + 1; j < names.length; j++)
          for (let k = j + 1; k < names.length; k++) {
            const f3 = combo3Freq.get(`${names[i]}|${names[j]}|${names[k]}`) || 0;
            if (f3 > maxC3) maxC3 = f3;
            for (let l = k + 1; l < names.length; l++) {
              const freq = combo4Freq.get(`${names[i]}|${names[j]}|${names[k]}|${names[l]}`) || 0;
              if (freq > maxC4) maxC4 = freq;
              sumC4 += freq; countC4++;
            }
          }

      // Ownership & team/game structure
      let ownSum = 0, matched = 0, prodOwn = 1;
      const teamCounts = new Map<string, number>();
      const gameCounts = new Map<string, number>();
      const playersByOwn: { name: string; own: number }[] = [];

      for (const nm of entry.playerNames) {
        const p = playerPool.get(nm);
        if (p) {
          ownSum += p.ownership; matched++;
          prodOwn *= Math.max(p.ownership / 100, 0.001);
          teamCounts.set(p.team, (teamCounts.get(p.team) || 0) + 1);
          gameCounts.set(p.gameInfo, (gameCounts.get(p.gameInfo) || 0) + 1);
          playersByOwn.push({ name: nm, own: p.ownership });
        }
      }
      if (matched < 6) continue;

      const maxTeam = Math.max(...teamCounts.values(), 0);
      const maxGame = Math.max(...gameCounts.values(), 0);
      let primaryTeam = '', primaryGame = '';
      for (const [t, c] of teamCounts) if (c === maxTeam) { primaryTeam = t; break; }
      for (const [g, c] of gameCounts) if (c === maxGame) { primaryGame = g; break; }

      // Bring-back detection
      const primaryPlayers = [...playerPool.values()].filter(p => p.team === primaryTeam);
      const primaryOpp = primaryPlayers[0]?.opp || '';
      const hasBringBack = entry.playerNames.some(nm => {
        const p = playerPool.get(nm);
        return p && p.team === primaryOpp && p.team !== primaryTeam;
      });

      // Core (top 3 owned) vs Shell (bottom 5)
      playersByOwn.sort((a, b) => b.own - a.own);
      const coreComboKey = playersByOwn.slice(0, 3).map(p => p.name).sort().join('|');
      const shellComboKey = playersByOwn.slice(3).map(p => p.name).sort().join('|');

      analyzed.push({
        rank: entry.rank, points: entry.points, entryName: entry.entryName,
        playerNames: entry.playerNames,
        avgOwnership: ownSum / matched,
        productOwnership: prodOwn,
        maxCombo4Freq: maxC4,
        avgCombo4Freq: countC4 > 0 ? sumC4 / countC4 : 0,
        maxCombo3Freq: maxC3,
        maxPlayersOneGame: maxGame,
        primaryStackSize: maxTeam,
        hasBringBack,
        rankPct: entry.rank / totalEntries,
        numDistinctGames: gameCounts.size,
        numDistinctTeams: teamCounts.size,
        primaryGame, primaryTeam,
        playersFromPrimaryGame: maxGame,
        coreComboKey, shellComboKey,
      });
    }

    if (analyzed.length < 200) continue;

    const top1 = analyzed.filter(e => e.rankPct <= 0.01);
    const fieldSample = analyzed.filter((_, i) => i % 10 === 0);
    const ratio = avg(top1.map(e => e.maxCombo4Freq)) / Math.max(0.0001, avg(fieldSample.map(e => e.maxCombo4Freq)));

    allSlates.push({ date: base, fieldSize: totalEntries, entries: analyzed, comboRatio: ratio, combo4Freq, combo3Freq, playerPool });
    allEntriesGlobal.push(...analyzed);

    console.log(`Loaded ${base}: ${totalEntries} entries, ${analyzed.length} analyzed, ratio=${ratio.toFixed(2)}`);
  }

  console.log(`\nTotal: ${allSlates.length} slates, ${allEntriesGlobal.length} entries\n`);

  // ================================================================
  // Q1: FIELD SIZE vs COMBO UNIQUENESS
  // "Does combo uniqueness help in LARGE fields?"
  // ================================================================
  console.log('================================================================');
  console.log('Q1: FIELD SIZE vs COMBO UNIQUENESS');
  console.log('Do large-field GPPs (where 1st place $$ is concentrated) reward uniqueness?');
  console.log('================================================================\n');

  const sorted = [...allSlates].sort((a, b) => a.fieldSize - b.fieldSize);
  console.log(`  ${'Slate'.padEnd(30)} ${'Field'.padStart(7)} ${'Top1%C4'.padStart(9)} ${'FieldC4'.padStart(9)} ${'Ratio'.padStart(7)} ${'Signal'.padStart(17)}`);
  console.log('  ' + '─'.repeat(81));
  for (const s of sorted) {
    const top1 = s.entries.filter(e => e.rankPct <= 0.01);
    const fieldSample = s.entries.filter((_, i) => i % 10 === 0);
    const t1c4 = avg(top1.map(e => e.maxCombo4Freq));
    const fc4 = avg(fieldSample.map(e => e.maxCombo4Freq));
    const signal = s.comboRatio < 0.85 ? 'UNIQUE WINS' : s.comboRatio > 1.15 ? 'CHALK WINS' : 'NEUTRAL';
    console.log(`  ${s.date.padEnd(30)} ${String(s.fieldSize).padStart(7)} ${(t1c4*100).toFixed(2).padStart(8)}% ${(fc4*100).toFixed(2).padStart(8)}% ${s.comboRatio.toFixed(2).padStart(7)} ${signal.padStart(17)}`);
  }

  // Correlation between field size and ratio
  const sizes = allSlates.map(s => s.fieldSize);
  const ratios = allSlates.map(s => s.comboRatio);
  const fieldSizeCorr = correlation(sizes, ratios);

  // Also split by large vs small
  const largeSlates = allSlates.filter(s => s.fieldSize >= 10000);
  const smallSlates = allSlates.filter(s => s.fieldSize < 10000);
  const largeAvgRatio = avg(largeSlates.map(s => s.comboRatio));
  const smallAvgRatio = avg(smallSlates.map(s => s.comboRatio));

  console.log(`\n  Correlation(field_size, combo_ratio): ${fieldSizeCorr.toFixed(3)}`);
  console.log(`  Large fields (>10K, n=${largeSlates.length}): avg ratio = ${largeAvgRatio.toFixed(2)}`);
  console.log(`  Small fields (<10K, n=${smallSlates.length}): avg ratio = ${smallAvgRatio.toFixed(2)}`);
  console.log(`  → ${fieldSizeCorr < -0.3 ? 'LARGER FIELDS REWARD UNIQUENESS — scale crowding with field size'
    : fieldSizeCorr > 0.3 ? 'LARGER FIELDS REWARD CHALK'
    : largeAvgRatio < 0.9 ? 'LARGE FIELDS TREND TOWARD UNIQUENESS (weak correlation)'
    : 'NO CLEAR FIELD-SIZE RELATIONSHIP'}`);

  // Suggested alpha scaling
  if (fieldSizeCorr < -0.15 || largeAvgRatio < smallAvgRatio * 0.9) {
    console.log('\n  SUGGESTED: Scale crowding alpha by field size:');
    console.log('    <5K entries:  alpha = 0.0  (no crowding discount)');
    console.log('    5K-20K:       alpha = 0.10');
    console.log('    20K-50K:      alpha = 0.20');
    console.log('    50K+:         alpha = 0.35');
  }

  // ================================================================
  // Q2: SUB-TIER ANALYSIS — Very top vs bottom of top 1%
  // "Rank #1 pays 100x what rank #98 pays"
  // ================================================================
  console.log('\n================================================================');
  console.log('Q2: SUB-TIER ANALYSIS — Does uniqueness matter at the VERY TOP?');
  console.log('Top 0.1% (rank 1-10) vs top 0.5-1% (rank 50-100) vs top 1-5%');
  console.log('================================================================\n');

  // Per-slate breakdown
  console.log(`  ${'Slate'.padEnd(30)} ${'Top0.1%'.padStart(9)} ${'Top0.1-0.5%'.padStart(12)} ${'Top0.5-1%'.padStart(10)} ${'Top1-5%'.padStart(9)} ${'Field'.padStart(9)} ${'TopVsBot'.padStart(10)}`);
  console.log('  ' + '─'.repeat(91));

  for (const slate of allSlates) {
    const top01 = slate.entries.filter(e => e.rankPct <= 0.001);
    const top01to05 = slate.entries.filter(e => e.rankPct > 0.001 && e.rankPct <= 0.005);
    const top05to1 = slate.entries.filter(e => e.rankPct > 0.005 && e.rankPct <= 0.01);
    const top1to5 = slate.entries.filter(e => e.rankPct > 0.01 && e.rankPct <= 0.05);
    const fieldSample = slate.entries.filter((_, i) => i % 10 === 0);
    if (top01.length < 2) continue;

    const t01 = avg(top01.map(e => e.maxCombo4Freq)) * 100;
    const t0105 = avg(top01to05.map(e => e.maxCombo4Freq)) * 100;
    const t051 = avg(top05to1.map(e => e.maxCombo4Freq)) * 100;
    const t15 = avg(top1to5.map(e => e.maxCombo4Freq)) * 100;
    const fld = avg(fieldSample.map(e => e.maxCombo4Freq)) * 100;
    const dir = t01 < t051 * 0.85 ? 'TOP UNIQUE' : t01 > t051 * 1.15 ? 'TOP CHALK' : 'SIMILAR';
    console.log(`  ${slate.date.padEnd(30)} ${t01.toFixed(2).padStart(8)}% ${t0105.toFixed(2).padStart(11)}% ${t051.toFixed(2).padStart(9)}% ${t15.toFixed(2).padStart(8)}% ${fld.toFixed(2).padStart(8)}% ${dir.padStart(10)}`);
  }

  // Aggregate across all slates
  const allTop001 = allEntriesGlobal.filter(e => e.rankPct <= 0.001);
  const allTop001to005 = allEntriesGlobal.filter(e => e.rankPct > 0.001 && e.rankPct <= 0.005);
  const allTop005to01 = allEntriesGlobal.filter(e => e.rankPct > 0.005 && e.rankPct <= 0.01);
  const allTop01to05 = allEntriesGlobal.filter(e => e.rankPct > 0.01 && e.rankPct <= 0.05);
  const allFieldSample = allEntriesGlobal.filter((_, i) => i % 10 === 0);

  console.log(`\n  AGGREGATE (${allSlates.length} slates):`);
  console.log(`    Top 0.1%      (n=${allTop001.length.toString().padStart(5)}): maxC4 = ${(avg(allTop001.map(e=>e.maxCombo4Freq))*100).toFixed(3)}%   avgC4 = ${(avg(allTop001.map(e=>e.avgCombo4Freq))*100).toFixed(4)}%`);
  console.log(`    Top 0.1-0.5%  (n=${allTop001to005.length.toString().padStart(5)}): maxC4 = ${(avg(allTop001to005.map(e=>e.maxCombo4Freq))*100).toFixed(3)}%   avgC4 = ${(avg(allTop001to005.map(e=>e.avgCombo4Freq))*100).toFixed(4)}%`);
  console.log(`    Top 0.5-1%    (n=${allTop005to01.length.toString().padStart(5)}): maxC4 = ${(avg(allTop005to01.map(e=>e.maxCombo4Freq))*100).toFixed(3)}%   avgC4 = ${(avg(allTop005to01.map(e=>e.avgCombo4Freq))*100).toFixed(4)}%`);
  console.log(`    Top 1-5%      (n=${allTop01to05.length.toString().padStart(5)}): maxC4 = ${(avg(allTop01to05.map(e=>e.maxCombo4Freq))*100).toFixed(3)}%   avgC4 = ${(avg(allTop01to05.map(e=>e.avgCombo4Freq))*100).toFixed(4)}%`);
  console.log(`    Field sample  (n=${allFieldSample.length.toString().padStart(5)}): maxC4 = ${(avg(allFieldSample.map(e=>e.maxCombo4Freq))*100).toFixed(3)}%   avgC4 = ${(avg(allFieldSample.map(e=>e.avgCombo4Freq))*100).toFixed(4)}%`);

  const top001c4 = avg(allTop001.map(e => e.maxCombo4Freq));
  const top005to01c4 = avg(allTop005to01.map(e => e.maxCombo4Freq));
  const gradient = top005to01c4 > 0 ? top001c4 / top005to01c4 : 1;
  console.log(`\n  Gradient (top0.1% / top0.5-1%): ${gradient.toFixed(3)}`);
  console.log(`  → ${gradient < 0.85 ? 'VERY TOP IS MORE UNIQUE — uniqueness matters WHERE THE MONEY IS'
    : gradient > 1.15 ? 'VERY TOP IS MORE CHALKY — projection > uniqueness at the peak'
    : 'NO CLEAR GRADIENT — uniqueness is not the differentiator at the very top'}`);

  // Also check avg ownership gradient
  console.log(`\n  Ownership gradient:`);
  console.log(`    Top 0.1%  avg own: ${avg(allTop001.map(e=>e.avgOwnership)).toFixed(1)}%`);
  console.log(`    Top 0.5-1% avg own: ${avg(allTop005to01.map(e=>e.avgOwnership)).toFixed(1)}%`);
  console.log(`    Top 1-5%  avg own: ${avg(allTop01to05.map(e=>e.avgOwnership)).toFixed(1)}%`);
  console.log(`    Field     avg own: ${avg(allFieldSample.map(e=>e.avgOwnership)).toFixed(1)}%`);

  // ================================================================
  // Q3: PRO HITS vs PRO MISSES
  // "If pro hits have different combo profiles than misses, combo structure matters"
  // ================================================================
  console.log('\n================================================================');
  console.log('Q3: PRO HITS vs PRO MISSES — Does combo profile differ?');
  console.log('If hits are more unique than misses, pros get edge from construction');
  console.log('================================================================\n');

  const proNames = [
    'bgreseth', 'zroth2', 'bpcologna', 'oxenduck', 'invertedcheese', 'moklovin',
    'shipmymoney', 'skijmb', 'kszng', 'awen419', 'beaker913', 'westonselman',
    'onedropking', 'idlove2win', 'slimbomangler', 'austinturner773',
    'shaidyadvice', 'cheddabisque', 'lozingitall', 'hixx', 'fjbourne',
    'sullybrochill', 'xmalachi', 'giantsquid', 'mazwa', 'btmboss2',
    'sbcousle', 'jpm11', 'royalpain21', 'hebrewcheetah', 'cjcashing',
    'rsbathla', 'narendra22', 'jdm68a', 'aarondp987', 'hurliss', 'b_heals152',
  ];

  let proHitsMoreUnique = 0, proHitsMoreChalk = 0, proSimilar = 0;
  const proResults: { name: string; entries: number; hits: number; hitC4: number; missC4: number; ratio: number }[] = [];

  console.log(`  ${'Pro'.padEnd(20)} ${'Entries'.padStart(7)} ${'Hits'.padStart(5)} ${'HitC4%'.padStart(8)} ${'MissC4%'.padStart(9)} ${'Ratio'.padStart(7)} ${'HitOwn%'.padStart(8)} ${'MissOwn%'.padStart(9)} ${'Signal'.padStart(18)}`);
  console.log('  ' + '─'.repeat(93));

  for (const proName of proNames) {
    const proEntries = allEntriesGlobal.filter(e => {
      const clean = e.entryName.replace(/\s*\(\d+\/\d+\)/, '').toLowerCase();
      return clean === proName;
    });
    if (proEntries.length < 50) continue;

    const hits = proEntries.filter(e => e.rankPct <= 0.01);
    const nearMisses = proEntries.filter(e => e.rankPct > 0.01 && e.rankPct <= 0.05);
    const misses = proEntries.filter(e => e.rankPct > 0.10);
    if (hits.length < 2) continue;

    const hitCombo = avg(hits.map(e => e.maxCombo4Freq));
    const missCombo = avg(misses.map(e => e.maxCombo4Freq));
    const ratio = missCombo > 0 ? hitCombo / missCombo : 1;
    const hitOwn = avg(hits.map(e => e.avgOwnership));
    const missOwn = avg(misses.map(e => e.avgOwnership));

    const dir = ratio < 0.85 ? 'HITS MORE UNIQUE' : ratio > 1.15 ? 'HITS MORE CHALK' : 'SIMILAR';
    if (ratio < 0.85) proHitsMoreUnique++;
    else if (ratio > 1.15) proHitsMoreChalk++;
    else proSimilar++;

    proResults.push({ name: proName, entries: proEntries.length, hits: hits.length, hitC4: hitCombo, missC4: missCombo, ratio });
    console.log(`  ${proName.padEnd(20)} ${String(proEntries.length).padStart(7)} ${String(hits.length).padStart(5)} ${(hitCombo*100).toFixed(2).padStart(7)}% ${(missCombo*100).toFixed(2).padStart(8)}% ${ratio.toFixed(2).padStart(7)} ${hitOwn.toFixed(1).padStart(7)}% ${missOwn.toFixed(1).padStart(8)}% ${dir.padStart(18)}`);
  }

  console.log(`\n  SUMMARY: ${proHitsMoreUnique} pros hits more unique, ${proHitsMoreChalk} hits more chalk, ${proSimilar} similar`);
  if (proResults.length > 0) {
    const avgRatio = avg(proResults.map(r => r.ratio));
    console.log(`  Avg hit/miss combo ratio: ${avgRatio.toFixed(3)}`);
    console.log(`  → ${avgRatio < 0.85 ? 'PRO HITS ARE MORE UNIQUE — combo construction matters for the best players'
      : avgRatio > 1.15 ? 'PRO HITS ARE CHALKIER — pros win with projection, not uniqueness'
      : 'NO CLEAR PATTERN — combo structure is not the key differentiator for pros'}`);
  }

  // ================================================================
  // Q4: PRO CHALK vs CONTRARIAN HIT RATES
  // "Within a pro's portfolio, do chalk or contrarian lineups win more?"
  // ================================================================
  console.log('\n================================================================');
  console.log('Q4: PRO CHALK vs CONTRARIAN LINEUP HIT RATES');
  console.log('Within a pro\'s 150 entries: chalk lineups vs contrarian lineups');
  console.log('================================================================\n');

  console.log(`  ${'Pro'.padEnd(20)} ${'ChalkN'.padStart(7)} ${'Chalk1%'.padStart(8)} ${'ChalkCsh'.padStart(9)} ${'ContN'.padStart(6)} ${'Cont1%'.padStart(8)} ${'ContCsh'.padStart(8)} ${'MidN'.padStart(6)} ${'Mid1%'.padStart(8)} ${'Winner'.padStart(12)}`);
  console.log('  ' + '─'.repeat(94));

  let chalkWins = 0, contWins = 0, neither = 0;

  for (const proName of proNames) {
    const proEntries = allEntriesGlobal.filter(e => {
      const clean = e.entryName.replace(/\s*\(\d+\/\d+\)/, '').toLowerCase();
      return clean === proName;
    });
    if (proEntries.length < 100) continue;

    // Three tiers of ownership within the pro's portfolio
    const chalk = proEntries.filter(e => e.avgOwnership > 25);
    const mid = proEntries.filter(e => e.avgOwnership >= 18 && e.avgOwnership <= 25);
    const contrarian = proEntries.filter(e => e.avgOwnership < 18);
    if (chalk.length < 15 || contrarian.length < 15) continue;

    const chalkHit = chalk.filter(e => e.rankPct <= 0.01).length / chalk.length * 100;
    const contHit = contrarian.filter(e => e.rankPct <= 0.01).length / contrarian.length * 100;
    const midHit = mid.length > 10 ? mid.filter(e => e.rankPct <= 0.01).length / mid.length * 100 : -1;
    const chalkCash = chalk.filter(e => e.rankPct <= 0.20).length / chalk.length * 100;
    const contCash = contrarian.filter(e => e.rankPct <= 0.20).length / contrarian.length * 100;

    const winner = contHit > chalkHit * 1.5 ? 'CONTRARIAN' : chalkHit > contHit * 1.5 ? 'CHALK' : 'MIXED';
    if (winner === 'CONTRARIAN') contWins++;
    else if (winner === 'CHALK') chalkWins++;
    else neither++;

    console.log(`  ${proName.padEnd(20)} ${String(chalk.length).padStart(7)} ${chalkHit.toFixed(1).padStart(7)}% ${chalkCash.toFixed(0).padStart(8)}% ${String(contrarian.length).padStart(6)} ${contHit.toFixed(1).padStart(7)}% ${contCash.toFixed(0).padStart(7)}% ${String(mid.length).padStart(6)} ${(midHit >= 0 ? midHit.toFixed(1) + '%' : 'n/a').padStart(8)} ${winner.padStart(12)}`);
  }

  console.log(`\n  SUMMARY: Contrarian wins for ${contWins} pros, Chalk wins for ${chalkWins}, Mixed ${neither}`);
  console.log(`  → ${contWins > chalkWins * 1.5 ? 'CONTRARIAN APPROACH VALIDATED — keep crowding discount'
    : chalkWins > contWins * 1.5 ? 'CHALK APPROACH WINS — reduce crowding discount'
    : 'MIXED RESULTS — ownership alone doesn\'t determine hit rate'}`);

  // ================================================================
  // Q5: DISTINCT COMBO CLUSTERS IN TOP 1%
  // "Are winners converging on ONE combo or MANY?"
  // ================================================================
  console.log('\n================================================================');
  console.log('Q5: TOP 1% COMBO DIVERSITY — One winning path or many?');
  console.log('If many clusters: uniqueness = less splitting per path');
  console.log('If few clusters: one winning combo, uniqueness doesn\'t help');
  console.log('================================================================\n');

  console.log(`  ${'Slate'.padEnd(30)} ${'Top1%'.padStart(6)} ${'Clusters'.padStart(9)} ${'Largest'.padStart(8)} ${'Cl>5'.padStart(5)} ${'Cl>10'.padStart(6)} ${'Paths'.padStart(7)} ${'Verdict'.padStart(14)}`);
  console.log('  ' + '─'.repeat(87));

  let manyPathSlates = 0, fewPathSlates = 0;

  for (const slate of allSlates) {
    const top1 = slate.entries.filter(e => e.rankPct <= 0.01);
    if (top1.length < 10) continue;

    // Cluster by player overlap: 5+ shared players = same cluster
    const clusters: number[][] = [];
    const assigned = new Set<number>();

    for (let i = 0; i < top1.length; i++) {
      if (assigned.has(i)) continue;
      const cluster = [i];
      assigned.add(i);

      // BFS: add all lineups connected to this cluster
      const queue = [i];
      while (queue.length > 0) {
        const curr = queue.shift()!;
        for (let j = 0; j < top1.length; j++) {
          if (assigned.has(j)) continue;
          const shared = top1[curr].playerNames.filter(n => top1[j].playerNames.includes(n)).length;
          if (shared >= 5) {
            cluster.push(j);
            assigned.add(j);
            queue.push(j);
          }
        }
      }
      clusters.push(cluster);
    }

    const largestCluster = Math.max(...clusters.map(c => c.length));
    const clustersAbove5 = clusters.filter(c => c.length >= 5).length;
    const clustersAbove10 = clusters.filter(c => c.length >= 10).length;
    const verdict = clusters.length >= 10 ? 'MANY PATHS' : clusters.length <= 3 ? 'FEW PATHS' : 'MODERATE';
    if (clusters.length >= 10) manyPathSlates++;
    else if (clusters.length <= 3) fewPathSlates++;

    console.log(`  ${slate.date.padEnd(30)} ${String(top1.length).padStart(6)} ${String(clusters.length).padStart(9)} ${String(largestCluster).padStart(8)} ${String(clustersAbove5).padStart(5)} ${String(clustersAbove10).padStart(6)} ${String(clusters.length).padStart(7)} ${verdict.padStart(14)}`);

    // Show top 3 clusters (players in common)
    const sortedClusters = clusters.sort((a, b) => b.length - a.length).slice(0, 3);
    for (let ci = 0; ci < sortedClusters.length && ci < 3; ci++) {
      const cl = sortedClusters[ci];
      if (cl.length < 3) continue;
      // Find common players across cluster
      const allNames = cl.map(idx => new Set(top1[idx].playerNames));
      const common = [...allNames[0]].filter(name => allNames.every(s => s.has(name)));
      console.log(`    Cluster ${ci+1} (${cl.length} lineups): core = [${common.join(', ')}]`);
    }
  }

  console.log(`\n  SUMMARY: ${manyPathSlates} slates with many paths (10+), ${fewPathSlates} with few paths (≤3)`);
  console.log(`  → ${manyPathSlates > fewPathSlates ? 'MANY WINNING PATHS — uniqueness avoids splitting, KEEP diversity in portfolio'
    : fewPathSlates > manyPathSlates ? 'FEW WINNING PATHS — one combo dominates, uniqueness doesn\'t help'
    : 'MIXED — path diversity varies by slate'}`);

  // ================================================================
  // Q6: GAME CONCENTRATION — Both teams, not just one team
  // "Game stacking captures correlated boom (OT, pace)"
  // ================================================================
  console.log('\n================================================================');
  console.log('Q6: GAME CONCENTRATION vs TEAM STACKING');
  console.log('Game concentration = players from BOTH teams in a high-scoring game');
  console.log('Team stacking = players from ONE team');
  console.log('================================================================\n');

  const allTop1Global = allEntriesGlobal.filter(e => e.rankPct <= 0.01);
  const allTop5Global = allEntriesGlobal.filter(e => e.rankPct > 0.01 && e.rankPct <= 0.05);
  const allFieldSample2 = allEntriesGlobal.filter((_, i) => i % 20 === 0);

  // Game concentration distribution
  console.log('  A) MAX PLAYERS FROM ONE GAME (both teams):');
  console.log(`  ${'Players'.padEnd(20)} ${'Top 1%'.padStart(10)} ${'Top 2-5%'.padStart(10)} ${'Field'.padStart(10)} ${'Lift(1%/F)'.padStart(12)}`);
  console.log('  ' + '─'.repeat(64));
  for (let gc = 2; gc <= 7; gc++) {
    const t1pct = allTop1Global.filter(e => e.maxPlayersOneGame >= gc).length / allTop1Global.length * 100;
    const t5pct = allTop5Global.filter(e => e.maxPlayersOneGame >= gc).length / allTop5Global.length * 100;
    const fpct = allFieldSample2.filter(e => e.maxPlayersOneGame >= gc).length / allFieldSample2.length * 100;
    const lift = fpct > 0 ? (t1pct / fpct).toFixed(2) + 'x' : 'n/a';
    console.log(`  ${(gc + '+ from one game').padEnd(20)} ${t1pct.toFixed(1).padStart(9)}% ${t5pct.toFixed(1).padStart(9)}% ${fpct.toFixed(1).padStart(9)}% ${lift.padStart(12)}`);
  }

  // Team stacking distribution
  console.log('\n  B) MAX PLAYERS FROM ONE TEAM:');
  console.log(`  ${'Stack'.padEnd(20)} ${'Top 1%'.padStart(10)} ${'Top 2-5%'.padStart(10)} ${'Field'.padStart(10)} ${'Lift(1%/F)'.padStart(12)}`);
  console.log('  ' + '─'.repeat(64));
  for (let ts = 2; ts <= 5; ts++) {
    const t1pct = allTop1Global.filter(e => e.primaryStackSize >= ts).length / allTop1Global.length * 100;
    const t5pct = allTop5Global.filter(e => e.primaryStackSize >= ts).length / allTop5Global.length * 100;
    const fpct = allFieldSample2.filter(e => e.primaryStackSize >= ts).length / allFieldSample2.length * 100;
    const lift = fpct > 0 ? (t1pct / fpct).toFixed(2) + 'x' : 'n/a';
    console.log(`  ${(ts + '-man team stack').padEnd(20)} ${t1pct.toFixed(1).padStart(9)}% ${t5pct.toFixed(1).padStart(9)}% ${fpct.toFixed(1).padStart(9)}% ${lift.padStart(12)}`);
  }

  // Bring-back analysis
  const t1BB = allTop1Global.filter(e => e.hasBringBack).length / allTop1Global.length * 100;
  const fBB = allFieldSample2.filter(e => e.hasBringBack).length / allFieldSample2.length * 100;
  console.log(`\n  C) BRING-BACK (opponent player in stack game):`);
  console.log(`     Top 1%: ${t1BB.toFixed(1)}%    Field: ${fBB.toFixed(1)}%    Lift: ${(t1BB/fBB).toFixed(2)}x`);

  // Structure classification
  console.log('\n  D) LINEUP STRUCTURE CLASSIFICATION:');
  const classifyStructure = (e: AnalyzedEntry): string => {
    if (e.playersFromPrimaryGame >= 5) return 'game-stack-5+';
    if (e.playersFromPrimaryGame >= 4) return 'game-stack-4';
    if (e.playersFromPrimaryGame >= 3 && e.numDistinctGames <= 3) return 'double-game';
    return 'spread';
  };

  const structures = ['game-stack-5+', 'game-stack-4', 'double-game', 'spread'];
  console.log(`  ${'Structure'.padEnd(20)} ${'Top 1%'.padStart(10)} ${'Field'.padStart(10)} ${'Lift'.padStart(10)}`);
  console.log('  ' + '─'.repeat(52));
  for (const struct of structures) {
    const t1pct = allTop1Global.filter(e => classifyStructure(e) === struct).length / allTop1Global.length * 100;
    const fpct = allFieldSample2.filter(e => classifyStructure(e) === struct).length / allFieldSample2.length * 100;
    const lift = fpct > 0 ? (t1pct / fpct).toFixed(2) + 'x' : 'n/a';
    console.log(`  ${struct.padEnd(20)} ${t1pct.toFixed(1).padStart(9)}% ${fpct.toFixed(1).padStart(9)}% ${lift.padStart(10)}`);
  }

  // Game vs team stacking effectiveness
  const gameConc = avg(allTop1Global.map(e => e.playersFromPrimaryGame));
  const fieldGameConc = avg(allFieldSample2.map(e => e.playersFromPrimaryGame));
  const teamConc = avg(allTop1Global.map(e => e.primaryStackSize));
  const fieldTeamConc = avg(allFieldSample2.map(e => e.primaryStackSize));
  const gameLift = fieldGameConc > 0 ? gameConc / fieldGameConc : 1;
  const teamLift = fieldTeamConc > 0 ? teamConc / fieldTeamConc : 1;

  console.log(`\n  E) GAME vs TEAM CONCENTRATION LIFT:`);
  console.log(`     Game concentration: Top1% ${gameConc.toFixed(2)} vs Field ${fieldGameConc.toFixed(2)} → ${gameLift.toFixed(2)}x lift`);
  console.log(`     Team concentration: Top1% ${teamConc.toFixed(2)} vs Field ${fieldTeamConc.toFixed(2)} → ${teamLift.toFixed(2)}x lift`);
  console.log(`     → ${gameLift > teamLift * 1.1 ? 'GAME stacking > TEAM stacking — shift to game-stack emphasis (both teams in a shootout)'
    : teamLift > gameLift * 1.1 ? 'TEAM stacking > GAME stacking — one-sided stacks work better'
    : 'SIMILAR — both game and team concentration help equally'}`);

  // Distinct games in winners
  console.log(`\n  F) DISTINCT GAMES USED:`);
  console.log(`     Top 1%: ${avg(allTop1Global.map(e=>e.numDistinctGames)).toFixed(2)} games    Field: ${avg(allFieldSample2.map(e=>e.numDistinctGames)).toFixed(2)} games`);
  console.log(`     → Winners ${avg(allTop1Global.map(e=>e.numDistinctGames)) < avg(allFieldSample2.map(e=>e.numDistinctGames)) ? 'CONCENTRATE in fewer games' : 'SPREAD across more games'}`);

  // ================================================================
  // BONUS: CORE + SHELL ANALYSIS
  // "Same stars, different supporting casts"
  // ================================================================
  console.log('\n================================================================');
  console.log('BONUS: CORE + SHELL PATTERN');
  console.log('Do winners share the same CORE (top-3 owned) but differ on SHELL?');
  console.log('================================================================\n');

  // Analyze shell diversity within top 1% that share the same core
  for (const slate of allSlates) {
    const top1 = slate.entries.filter(e => e.rankPct <= 0.01);
    if (top1.length < 10) continue;

    const coreCounts = new Map<string, number>();
    const shellCounts = new Map<string, number>();
    for (const e of top1) {
      coreCounts.set(e.coreComboKey, (coreCounts.get(e.coreComboKey) || 0) + 1);
      shellCounts.set(e.shellComboKey, (shellCounts.get(e.shellComboKey) || 0) + 1);
    }

    const topCores = [...coreCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    const uniqueCores = coreCounts.size;
    const uniqueShells = shellCounts.size;

    console.log(`  ${slate.date}: ${top1.length} top-1%, ${uniqueCores} unique cores, ${uniqueShells} unique shells`);
    console.log(`    Core diversity: ${(uniqueCores / top1.length * 100).toFixed(0)}%  Shell diversity: ${(uniqueShells / top1.length * 100).toFixed(0)}%`);
    if (uniqueShells / top1.length > uniqueCores / top1.length * 1.3) {
      console.log(`    → CONFIRMED: shared cores, different shells`);
    }
    for (const [core, count] of topCores) {
      if (count >= 3) {
        const names = core.split('|').map(n => n.substring(0, 15));
        console.log(`    Top core: [${names.join(', ')}] × ${count}`);
      }
    }
  }

  // ================================================================
  // DECISION FRAMEWORK
  // ================================================================
  console.log('\n================================================================');
  console.log('                    DECISION FRAMEWORK');
  console.log('Only remove crowding discount if ALL 6 answers say "no"');
  console.log('================================================================\n');

  const q1Signal = fieldSizeCorr < -0.15 || largeAvgRatio < smallAvgRatio * 0.9;
  const q2Signal = gradient < 0.90;
  const q3Signal = proResults.length > 0 && avg(proResults.map(r => r.ratio)) < 0.90;
  const q4Signal = contWins > chalkWins;
  const q5Signal = manyPathSlates > fewPathSlates;
  const q6Signal = gameLift > teamLift * 1.05;

  const yesCount = [q1Signal, q2Signal, q3Signal, q4Signal, q5Signal, q6Signal].filter(Boolean).length;

  console.log(`  Q1 (large fields reward uniqueness):   ${q1Signal ? 'YES ✓' : 'NO ✗'}  (corr=${fieldSizeCorr.toFixed(2)}, large=${largeAvgRatio.toFixed(2)} vs small=${smallAvgRatio.toFixed(2)})`);
  console.log(`  Q2 (very top is more unique):          ${q2Signal ? 'YES ✓' : 'NO ✗'}  (gradient=${gradient.toFixed(3)})`);
  console.log(`  Q3 (pro hits more unique than misses): ${q3Signal ? 'YES ✓' : 'NO ✗'}  (avg ratio=${proResults.length > 0 ? avg(proResults.map(r=>r.ratio)).toFixed(3) : 'n/a'})`);
  console.log(`  Q4 (pro contrarian > pro chalk):       ${q4Signal ? 'YES ✓' : 'NO ✗'}  (cont=${contWins}, chalk=${chalkWins})`);
  console.log(`  Q5 (many winning paths, not one):      ${q5Signal ? 'YES ✓' : 'NO ✗'}  (many=${manyPathSlates}, few=${fewPathSlates})`);
  console.log(`  Q6 (game concentration > team stack):   ${q6Signal ? 'YES ✓' : 'NO ✗'}  (game=${gameLift.toFixed(2)}x, team=${teamLift.toFixed(2)}x)`);

  console.log(`\n  SCORE: ${yesCount}/6 questions support keeping/enhancing crowding discount`);

  if (yesCount >= 4) {
    console.log('\n  ██████████████████████████████████████████████████████████');
    console.log('  ██  KEEP CROWDING DISCOUNT — Multiple signals support it ██');
    console.log('  ██████████████████████████████████████████████████████████\n');
    console.log('  RECOMMENDED ACTIONS:');
    if (q1Signal) console.log('  • Scale crowding alpha with field size (0.0 for <5K, up to 0.35 for 50K+)');
    if (q2Signal) console.log('  • Very top rewards uniqueness — increase alpha for top-heavy GPPs');
    if (q3Signal) console.log('  • Pro hits are unique — validate our construction approach');
    if (q4Signal) console.log('  • Contrarian works for pros — maintain ownership penalty');
    if (q5Signal) console.log('  • Many winning paths — portfolio diversity avoids splitting');
    if (q6Signal) console.log('  • Shift from team-only stacking to GAME stacking (both teams in shootouts)');
  } else if (yesCount >= 2) {
    console.log('\n  ████████████████████████████████████████████████████████');
    console.log('  ██  TUNE crowding discount — reduce but don\'t remove ██');
    console.log('  ████████████████████████████████████████████████████████\n');
    console.log('  RECOMMENDED: Reduce NBA alpha from current to 0.05-0.10');
    console.log('  Keep for MLB/NFL where stacking creates deeper combo structures');
  } else {
    console.log('\n  ██████████████████████████████████████████████████████');
    console.log('  ██  REDUCE crowding discount — data says chalk wins ██');
    console.log('  ██████████████████████████████████████████████████████\n');
    console.log('  RECOMMENDED: Reduce NBA alpha to 0.02-0.05');
    console.log('  Focus on correlation model and projection accuracy');
    console.log('  NBA GPP may be a projection game, not a leverage game');
  }

  console.log('\n================================================================');
  console.log('THE MANTRA: Don\'t take the first answer at face value.');
  console.log('The aggregate says chalk wins. But aggregates hide structure.');
  console.log('Does chalk win in 29K milly-makers? At rank #1? For PROS?');
  console.log('Ask the right sub-questions before changing the strategy.');
  console.log('================================================================\n');
}

main();
