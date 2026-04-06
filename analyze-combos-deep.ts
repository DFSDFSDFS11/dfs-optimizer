/**
 * Deep Combo Analysis — 6 Critical Sub-Questions
 * Before changing the crowding discount, answer each definitively.
 */

import * as fs from 'fs';
import * as path from 'path';

const DATA_DIR = './historical_slates';

interface PlayerData {
  name: string; team: string; salary: number; actual: number;
  projection: number; ownership: number; positions: string[];
  gameInfo: string;
}

interface AnalyzedEntry {
  rank: number; points: number; entryName: string;
  playerNames: string[]; avgOwnership: number;
  maxCombo4Freq: number; maxPlayersOneGame: number;
  primaryStackSize: number; hasBringBack: boolean;
  rankPct: number; // rank / totalEntries
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

function main() {
  console.log('================================================================');
  console.log('DEEP COMBO ANALYSIS — 6 Critical Questions');
  console.log('================================================================\n');

  const files = fs.readdirSync(DATA_DIR);

  interface SlateAnalysis {
    date: string;
    fieldSize: number;
    entries: AnalyzedEntry[];
    comboRatio: number; // top1% combo freq / field combo freq
  }

  const allSlates: SlateAnalysis[] = [];
  const allEntriesGlobal: AnalyzedEntry[] = [];

  for (const f of files) {
    if (!f.includes('_actuals')) continue;
    const base = f.replace('_actuals.csv', '');
    const projFile = files.find(pf => pf.startsWith(base) && pf.includes('projections'));
    if (!projFile) continue;

    // Load projections
    const projRaw = fs.readFileSync(path.join(DATA_DIR, projFile), 'utf-8');
    const projLines = projRaw.split(/\r?\n/).filter(l => l.trim());
    const projHeaders = projLines[0].split(',');
    const nameIdx = projHeaders.indexOf('Name');
    const ownIdx = projHeaders.indexOf('My Own') >= 0 ? projHeaders.indexOf('My Own') : projHeaders.indexOf('Adj Own');
    const teamIdx = projHeaders.indexOf('Team');
    const oppIdx = projHeaders.indexOf('Opp');

    const playerPool = new Map<string, PlayerData>();
    for (let i = 1; i < projLines.length; i++) {
      const cols = projLines[i].split(',');
      const name = cols[nameIdx]?.trim();
      if (!name) continue;
      const team = cols[teamIdx]?.trim() || '';
      const opp = cols[oppIdx]?.trim() || '';
      playerPool.set(name, {
        name, team, salary: parseFloat(cols[projHeaders.indexOf('Salary')]) || 0,
        actual: parseFloat(cols[projHeaders.indexOf('Actual')]) || 0,
        projection: parseFloat(cols[projHeaders.indexOf('SS Proj')]) || 0,
        ownership: parseFloat(cols[ownIdx]) || 0,
        positions: (cols[projHeaders.indexOf('Pos')]?.trim() || '').split('/'),
        gameInfo: [team, opp].sort().join('|'),
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

    // Build 4-combo frequency map from sample
    const SAMPLE_SIZE = Math.min(4000, rawEntries.length);
    const sampleSet = new Set<number>();
    while (sampleSet.size < SAMPLE_SIZE) sampleSet.add(Math.floor(Math.random() * rawEntries.length));
    const sampleEntries = [...sampleSet].map(i => rawEntries[i]);

    const combo4Freq = new Map<string, number>();
    for (const entry of sampleEntries) {
      const names = entry.playerNames.sort();
      for (let i = 0; i < names.length; i++)
        for (let j = i+1; j < names.length; j++)
          for (let k = j+1; k < names.length; k++)
            for (let l = k+1; l < names.length; l++) {
              const key = `${names[i]}|${names[j]}|${names[k]}|${names[l]}`;
              combo4Freq.set(key, (combo4Freq.get(key) || 0) + 1);
            }
    }
    for (const [k, v] of combo4Freq) combo4Freq.set(k, v / SAMPLE_SIZE);

    // Analyze each entry
    const analyzed: AnalyzedEntry[] = [];
    for (const entry of rawEntries) {
      const names = entry.playerNames.sort();
      if (names.length < 6) continue;

      // Max 4-combo freq
      let maxC4 = 0;
      for (let i = 0; i < names.length; i++)
        for (let j = i+1; j < names.length; j++)
          for (let k = j+1; k < names.length; k++)
            for (let l = k+1; l < names.length; l++) {
              const freq = combo4Freq.get(`${names[i]}|${names[j]}|${names[k]}|${names[l]}`) || 0;
              if (freq > maxC4) maxC4 = freq;
            }

      // Ownership
      let ownSum = 0, matched = 0;
      const teamCounts = new Map<string, number>();
      const gameCounts = new Map<string, number>();
      for (const nm of entry.playerNames) {
        const p = playerPool.get(nm);
        if (p) { ownSum += p.ownership; matched++;
          teamCounts.set(p.team, (teamCounts.get(p.team) || 0) + 1);
          gameCounts.set(p.gameInfo, (gameCounts.get(p.gameInfo) || 0) + 1);
        }
      }
      if (matched < 6) continue;

      const maxTeam = Math.max(...teamCounts.values(), 0);
      const maxGame = Math.max(...gameCounts.values(), 0);

      analyzed.push({
        rank: entry.rank, points: entry.points, entryName: entry.entryName,
        playerNames: entry.playerNames,
        avgOwnership: ownSum / matched,
        maxCombo4Freq: maxC4,
        maxPlayersOneGame: maxGame,
        primaryStackSize: maxTeam,
        hasBringBack: false, // simplified
        rankPct: entry.rank / totalEntries,
      });
    }

    if (analyzed.length < 200) continue;

    const top1 = analyzed.filter(e => e.rankPct <= 0.01);
    const fieldSample = analyzed.filter((_, i) => i % 10 === 0); // 10% sample
    const ratio = avg(top1.map(e => e.maxCombo4Freq)) / Math.max(0.0001, avg(fieldSample.map(e => e.maxCombo4Freq)));

    allSlates.push({ date: base, fieldSize: totalEntries, entries: analyzed, comboRatio: ratio });
    allEntriesGlobal.push(...analyzed);

    console.log(`${base}: ${totalEntries} entries, ratio=${ratio.toFixed(2)}`);
  }

  // ================================================================
  // Q1: FIELD SIZE vs COMBO UNIQUENESS
  // ================================================================
  console.log('\n================================================================');
  console.log('Q1: FIELD SIZE vs COMBO UNIQUENESS');
  console.log('================================================================\n');

  const sorted = [...allSlates].sort((a, b) => a.fieldSize - b.fieldSize);
  console.log(`  ${'Slate'.padEnd(20)} ${'Field'.padStart(7)} ${'Ratio'.padStart(7)} ${'Signal'.padStart(15)}`);
  console.log('  ' + '─'.repeat(51));
  for (const s of sorted) {
    const signal = s.comboRatio < 0.85 ? 'UNIQUE WINS' : s.comboRatio > 1.15 ? 'CHALK WINS' : 'NEUTRAL';
    console.log(`  ${s.date.padEnd(20)} ${String(s.fieldSize).padStart(7)} ${s.comboRatio.toFixed(2).padStart(7)} ${signal.padStart(15)}`);
  }

  // Correlation: field size vs ratio
  const sizes = allSlates.map(s => s.fieldSize);
  const ratios = allSlates.map(s => s.comboRatio);
  const meanSize = avg(sizes);
  const meanRatio = avg(ratios);
  let cov = 0, varSize = 0, varRatio = 0;
  for (let i = 0; i < sizes.length; i++) {
    cov += (sizes[i] - meanSize) * (ratios[i] - meanRatio);
    varSize += (sizes[i] - meanSize) ** 2;
    varRatio += (ratios[i] - meanRatio) ** 2;
  }
  const corr = varSize > 0 && varRatio > 0 ? cov / Math.sqrt(varSize * varRatio) : 0;
  console.log(`\n  Correlation(field_size, combo_ratio): ${corr.toFixed(3)}`);
  console.log(`  → ${corr < -0.3 ? 'LARGER FIELDS REWARD UNIQUENESS' : corr > 0.3 ? 'LARGER FIELDS REWARD CHALK' : 'NO CLEAR RELATIONSHIP'}`);

  // ================================================================
  // Q2: TOP 0.1% vs TOP 0.5-1% COMBO FREQ
  // ================================================================
  console.log('\n================================================================');
  console.log('Q2: SUB-TIER ANALYSIS (very top vs bottom of top 1%)');
  console.log('================================================================\n');

  for (const slate of allSlates) {
    const n = slate.entries.length;
    const top01 = slate.entries.filter(e => e.rankPct <= 0.001);
    const top05to1 = slate.entries.filter(e => e.rankPct > 0.005 && e.rankPct <= 0.01);
    if (top01.length < 3 || top05to1.length < 5) continue;
    const t01avg = avg(top01.map(e => e.maxCombo4Freq));
    const t05avg = avg(top05to1.map(e => e.maxCombo4Freq));
    const dir = t01avg < t05avg * 0.85 ? 'TOP MORE UNIQUE' : t01avg > t05avg * 1.15 ? 'TOP MORE CHALK' : 'SIMILAR';
    console.log(`  ${slate.date.padEnd(20)} top0.1%(${top01.length}): ${(t01avg*100).toFixed(2)}%  top0.5-1%(${top05to1.length}): ${(t05avg*100).toFixed(2)}%  → ${dir}`);
  }

  // Aggregate
  const allTop01 = allEntriesGlobal.filter(e => e.rankPct <= 0.001);
  const allTop05to1 = allEntriesGlobal.filter(e => e.rankPct > 0.005 && e.rankPct <= 0.01);
  console.log(`\n  AGGREGATE: top0.1%(${allTop01.length}): ${(avg(allTop01.map(e=>e.maxCombo4Freq))*100).toFixed(2)}%  top0.5-1%(${allTop05to1.length}): ${(avg(allTop05to1.map(e=>e.maxCombo4Freq))*100).toFixed(2)}%`);

  // ================================================================
  // Q3: PRO HITS vs PRO MISSES
  // ================================================================
  console.log('\n================================================================');
  console.log('Q3: PRO HITS vs PRO MISSES COMBO PROFILE');
  console.log('================================================================\n');

  const proNames = ['bgreseth', 'zroth2', 'bpcologna', 'oxenduck', 'invertedcheese', 'moklovin',
    'shipmymoney', 'skijmb', 'lostories', 'kszng'];

  for (const proName of proNames) {
    const proEntries = allEntriesGlobal.filter(e => {
      const clean = e.entryName.replace(/\s*\(\d+\/\d+\)/, '').toLowerCase();
      return clean === proName;
    });
    if (proEntries.length < 50) continue;

    const hits = proEntries.filter(e => e.rankPct <= 0.01);
    const misses = proEntries.filter(e => e.rankPct > 0.10);
    if (hits.length < 2) continue;

    const hitCombo = avg(hits.map(e => e.maxCombo4Freq));
    const missCombo = avg(misses.map(e => e.maxCombo4Freq));
    const dir = hitCombo < missCombo * 0.85 ? 'HITS MORE UNIQUE' : hitCombo > missCombo * 1.15 ? 'HITS MORE CHALK' : 'SIMILAR';
    console.log(`  ${proName.padEnd(18)} entries:${String(proEntries.length).padStart(5)} hits:${String(hits.length).padStart(3)} | hit_combo:${(hitCombo*100).toFixed(2)}% miss_combo:${(missCombo*100).toFixed(2)}% → ${dir}`);
  }

  // ================================================================
  // Q4: PRO CHALK vs CONTRARIAN HIT RATES
  // ================================================================
  console.log('\n================================================================');
  console.log('Q4: PRO CHALK vs CONTRARIAN LINEUP HIT RATES');
  console.log('================================================================\n');

  for (const proName of proNames) {
    const proEntries = allEntriesGlobal.filter(e => {
      const clean = e.entryName.replace(/\s*\(\d+\/\d+\)/, '').toLowerCase();
      return clean === proName;
    });
    if (proEntries.length < 100) continue;

    const chalk = proEntries.filter(e => e.avgOwnership > 25);
    const contrarian = proEntries.filter(e => e.avgOwnership < 18);
    if (chalk.length < 20 || contrarian.length < 20) continue;

    const chalkHit = chalk.filter(e => e.rankPct <= 0.01).length / chalk.length * 100;
    const contHit = contrarian.filter(e => e.rankPct <= 0.01).length / contrarian.length * 100;
    const chalkCash = chalk.filter(e => e.rankPct <= 0.20).length / chalk.length * 100;
    const contCash = contrarian.filter(e => e.rankPct <= 0.20).length / contrarian.length * 100;
    console.log(`  ${proName.padEnd(18)} chalk(${chalk.length}): top1%=${chalkHit.toFixed(1)}% cash=${chalkCash.toFixed(0)}% | cont(${contrarian.length}): top1%=${contHit.toFixed(1)}% cash=${contCash.toFixed(0)}%`);
  }

  // ================================================================
  // Q5: DISTINCT COMBO CLUSTERS IN TOP 1%
  // ================================================================
  console.log('\n================================================================');
  console.log('Q5: TOP 1% COMBO DIVERSITY (distinct clusters)');
  console.log('================================================================\n');

  for (const slate of allSlates) {
    const top1 = slate.entries.filter(e => e.rankPct <= 0.01);
    if (top1.length < 10) continue;

    // Simple clustering: two lineups are "same cluster" if they share 5+ of 8 players
    const clusters: number[][] = [];
    const assigned = new Set<number>();

    for (let i = 0; i < top1.length; i++) {
      if (assigned.has(i)) continue;
      const cluster = [i];
      assigned.add(i);

      for (let j = i + 1; j < top1.length; j++) {
        if (assigned.has(j)) continue;
        // Count shared players
        const shared = top1[i].playerNames.filter(n => top1[j].playerNames.includes(n)).length;
        if (shared >= 5) {
          cluster.push(j);
          assigned.add(j);
        }
      }
      clusters.push(cluster);
    }

    const largestCluster = Math.max(...clusters.map(c => c.length));
    const clustersAbove5 = clusters.filter(c => c.length >= 5).length;
    console.log(`  ${slate.date.padEnd(20)} ${top1.length} top-1% → ${clusters.length} clusters (largest: ${largestCluster}, clusters>5: ${clustersAbove5})`);
  }

  // ================================================================
  // Q6: GAME CONCENTRATION IN WINNERS
  // ================================================================
  console.log('\n================================================================');
  console.log('Q6: GAME CONCENTRATION (players from same game, both teams)');
  console.log('================================================================\n');

  const allTop1Global = allEntriesGlobal.filter(e => e.rankPct <= 0.01);
  const allFieldSample = allEntriesGlobal.filter((_, i) => i % 20 === 0);

  console.log(`  Top 1% avg max players from one GAME: ${avg(allTop1Global.map(e => e.maxPlayersOneGame)).toFixed(2)}`);
  console.log(`  Field avg max players from one GAME:  ${avg(allFieldSample.map(e => e.maxPlayersOneGame)).toFixed(2)}`);

  // Distribution
  console.log('\n  Game concentration distribution:');
  for (let gc = 2; gc <= 6; gc++) {
    const t1pct = allTop1Global.filter(e => e.maxPlayersOneGame >= gc).length / allTop1Global.length * 100;
    const fpct = allFieldSample.filter(e => e.maxPlayersOneGame >= gc).length / allFieldSample.length * 100;
    const lift = fpct > 0 ? (t1pct / fpct).toFixed(2) + 'x' : 'n/a';
    console.log(`    ${gc}+ players from one game: top1%=${t1pct.toFixed(1)}%  field=${fpct.toFixed(1)}%  lift=${lift}`);
  }

  // ================================================================
  // DECISION FRAMEWORK
  // ================================================================
  console.log('\n================================================================');
  console.log('DECISION FRAMEWORK SUMMARY');
  console.log('================================================================\n');

  console.log('Q1 (field size vs uniqueness):   Correlation = ' + corr.toFixed(3));
  console.log('Q2 (top 0.1% vs 0.5-1%):        ' +
    (avg(allTop01.map(e=>e.maxCombo4Freq)) < avg(allTop05to1.map(e=>e.maxCombo4Freq)) * 0.9 ? 'VERY TOP IS MORE UNIQUE' : 'NO CLEAR DIFFERENCE'));
  console.log('Q6 (game concentration):         Winners = ' +
    avg(allTop1Global.map(e => e.maxPlayersOneGame)).toFixed(2) +
    ', Field = ' + avg(allFieldSample.map(e => e.maxPlayersOneGame)).toFixed(2));

  console.log('\n================================================================\n');
}

main();
