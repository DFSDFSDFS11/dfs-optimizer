/**
 * Combo-Level Analysis — Do Winners Use Chalk Players in Unique Combos?
 *
 * Measures combo overlap (not individual ownership) for top-1% vs field.
 * Tests the hypothesis: winners play the same stars but different shells.
 */

import * as fs from 'fs';
import * as path from 'path';

const DATA_DIR = './historical_slates';

interface PlayerData {
  name: string; team: string; salary: number; actual: number;
  projection: number; ownership: number; positions: string[];
}

interface ParsedEntry {
  rank: number; points: number; entryName: string;
  playerNames: string[];
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
  console.log('COMBO-LEVEL ANALYSIS — NBA Contest Winners');
  console.log('================================================================\n');

  const files = fs.readdirSync(DATA_DIR);

  // Process each slate independently (combo frequencies are slate-specific)
  interface SlateComboResult {
    date: string;
    // Per-tier combo stats
    top1AvgMaxCombo3: number;
    top1AvgMaxCombo4: number;
    top5AvgMaxCombo3: number;
    fieldAvgMaxCombo3: number;
    fieldAvgMaxCombo4: number;
    // Core vs shell
    top1CoreFreq: number;
    top1ShellFreq: number;
    fieldCoreFreq: number;
    fieldShellFreq: number;
    // Counts
    totalEntries: number;
    top1Count: number;
  }

  const slateResults: SlateComboResult[] = [];

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
    const salaryIdx = projHeaders.indexOf('Salary');
    const projIdx2 = projHeaders.indexOf('SS Proj');

    const playerPool = new Map<string, PlayerData>();
    for (let i = 1; i < projLines.length; i++) {
      const cols = projLines[i].split(',');
      const name = cols[nameIdx]?.trim();
      if (!name) continue;
      playerPool.set(name, {
        name, team: cols[projHeaders.indexOf('Team')]?.trim() || '',
        salary: parseFloat(cols[salaryIdx]) || 0,
        actual: parseFloat(cols[projHeaders.indexOf('Actual')]) || 0,
        projection: parseFloat(cols[projIdx2]) || 0,
        ownership: parseFloat(cols[ownIdx]) || 0,
        positions: (cols[projHeaders.indexOf('Pos')]?.trim() || '').split('/'),
      });
    }

    // Load actuals
    const actRaw = fs.readFileSync(path.join(DATA_DIR, f), 'utf-8').replace(/^\uFEFF/, '');
    const actLines = actRaw.split(/\r?\n/).filter(l => l.trim());

    const entries: ParsedEntry[] = [];
    for (let i = 1; i < actLines.length; i++) {
      const cols = actLines[i].split(',');
      const rank = parseInt(cols[0]);
      const points = parseFloat(cols[4]);
      const lineupText = cols[5]?.trim() || '';
      if (isNaN(rank) || !lineupText) continue;
      entries.push({ rank, points, entryName: cols[2]?.trim() || '', playerNames: parseLineupText(lineupText) });
    }

    if (entries.length < 500) continue;

    const n = entries.length;
    const top1Cutoff = Math.floor(n * 0.01);
    const top5Cutoff = Math.floor(n * 0.05);

    // Build combo frequency tables from a SAMPLE of field entries (for speed)
    // Sample 5000 field entries to estimate combo frequencies
    const SAMPLE_SIZE = Math.min(5000, entries.length);
    const sampleIndices = new Set<number>();
    while (sampleIndices.size < SAMPLE_SIZE) {
      sampleIndices.add(Math.floor(Math.random() * entries.length));
    }
    const sampleEntries = [...sampleIndices].map(i => entries[i]);

    // Build 3-man and 4-man combo frequency maps from sample
    const combo3Freq = new Map<string, number>();
    const combo4Freq = new Map<string, number>();

    for (const entry of sampleEntries) {
      const names = entry.playerNames.sort();
      const nn = names.length;
      // 3-man combos
      for (let i = 0; i < nn; i++) {
        for (let j = i + 1; j < nn; j++) {
          for (let k = j + 1; k < nn; k++) {
            const key = `${names[i]}|${names[j]}|${names[k]}`;
            combo3Freq.set(key, (combo3Freq.get(key) || 0) + 1);
          }
        }
      }
      // 4-man combos (sample fewer for speed)
      for (let i = 0; i < nn; i++) {
        for (let j = i + 1; j < nn; j++) {
          for (let k = j + 1; k < nn; k++) {
            for (let l = k + 1; l < nn; l++) {
              const key = `${names[i]}|${names[j]}|${names[k]}|${names[l]}`;
              combo4Freq.set(key, (combo4Freq.get(key) || 0) + 1);
            }
          }
        }
      }
    }

    // Normalize frequencies
    for (const [k, v] of combo3Freq) combo3Freq.set(k, v / SAMPLE_SIZE);
    for (const [k, v] of combo4Freq) combo4Freq.set(k, v / SAMPLE_SIZE);

    // Compute combo stats per entry
    function getComboStats(entry: ParsedEntry) {
      const names = entry.playerNames.sort();
      const nn = names.length;
      if (nn < 4) return null;

      // Max 3-combo freq
      let maxC3 = 0;
      for (let i = 0; i < nn; i++) {
        for (let j = i + 1; j < nn; j++) {
          for (let k = j + 1; k < nn; k++) {
            const freq = combo3Freq.get(`${names[i]}|${names[j]}|${names[k]}`) || 0;
            if (freq > maxC3) maxC3 = freq;
          }
        }
      }

      // Max 4-combo freq
      let maxC4 = 0;
      for (let i = 0; i < nn; i++) {
        for (let j = i + 1; j < nn; j++) {
          for (let k = j + 1; k < nn; k++) {
            for (let l = k + 1; l < nn; l++) {
              const freq = combo4Freq.get(`${names[i]}|${names[j]}|${names[k]}|${names[l]}`) || 0;
              if (freq > maxC4) maxC4 = freq;
            }
          }
        }
      }

      // Core vs Shell: sort players by ownership, split top 3 (core) vs bottom 5 (shell)
      const withOwn = entry.playerNames.map(nm => ({ name: nm, own: playerPool.get(nm)?.ownership || 0 }));
      withOwn.sort((a, b) => b.own - a.own);
      const coreNames = withOwn.slice(0, 3).map(p => p.name).sort();
      const shellNames = withOwn.slice(3).map(p => p.name).sort();

      // Core combo freq (3-man of highest owned)
      const coreKey = coreNames.join('|');
      const coreFreq = combo3Freq.get(coreKey) || 0;

      // Shell combo freq (avg of all 3-man combos from shell players)
      let shellFreqSum = 0, shellCombos = 0;
      for (let i = 0; i < shellNames.length; i++) {
        for (let j = i + 1; j < shellNames.length; j++) {
          for (let k = j + 1; k < shellNames.length; k++) {
            shellFreqSum += combo3Freq.get(`${shellNames[i]}|${shellNames[j]}|${shellNames[k]}`) || 0;
            shellCombos++;
          }
        }
      }
      const shellFreq = shellCombos > 0 ? shellFreqSum / shellCombos : 0;

      return { maxC3, maxC4, coreFreq, shellFreq };
    }

    // Compute for top-1%, top-5%, and a field sample
    const top1Stats: ReturnType<typeof getComboStats>[] = [];
    const top5Stats: ReturnType<typeof getComboStats>[] = [];
    const fieldStats: ReturnType<typeof getComboStats>[] = [];

    for (const entry of entries) {
      const stats = getComboStats(entry);
      if (!stats) continue;

      if (entry.rank <= top1Cutoff) top1Stats.push(stats);
      if (entry.rank <= top5Cutoff) top5Stats.push(stats);

      // Sample field (every 20th entry for speed)
      if (entry.rank % 20 === 0) fieldStats.push(stats);
    }

    if (top1Stats.length === 0 || fieldStats.length === 0) continue;

    const validT1 = top1Stats.filter((s): s is NonNullable<typeof s> => s !== null);
    const validT5 = top5Stats.filter((s): s is NonNullable<typeof s> => s !== null);
    const validF = fieldStats.filter((s): s is NonNullable<typeof s> => s !== null);

    slateResults.push({
      date: base,
      top1AvgMaxCombo3: avg(validT1.map(s => s.maxC3)),
      top1AvgMaxCombo4: avg(validT1.map(s => s.maxC4)),
      top5AvgMaxCombo3: avg(validT5.map(s => s.maxC3)),
      fieldAvgMaxCombo3: avg(validF.map(s => s.maxC3)),
      fieldAvgMaxCombo4: avg(validF.map(s => s.maxC4)),
      top1CoreFreq: avg(validT1.map(s => s.coreFreq)),
      top1ShellFreq: avg(validT1.map(s => s.shellFreq)),
      fieldCoreFreq: avg(validF.map(s => s.coreFreq)),
      fieldShellFreq: avg(validF.map(s => s.shellFreq)),
      totalEntries: n,
      top1Count: validT1.length,
    });

    console.log(`${base}: ${n} entries, ${validT1.length} top-1% | ` +
      `maxC4: top1%=${(avg(validT1.map(s=>s.maxC4))*100).toFixed(2)}% field=${(avg(validF.map(s=>s.maxC4))*100).toFixed(2)}% | ` +
      `core: top1%=${(avg(validT1.map(s=>s.coreFreq))*100).toFixed(2)}% field=${(avg(validF.map(s=>s.coreFreq))*100).toFixed(2)}% | ` +
      `shell: top1%=${(avg(validT1.map(s=>s.shellFreq))*100).toFixed(3)}% field=${(avg(validF.map(s=>s.shellFreq))*100).toFixed(3)}%`);
  }

  // Aggregate across all slates
  console.log('\n================================================================');
  console.log('AGGREGATE COMBO ANALYSIS');
  console.log('================================================================\n');

  const allT1C3 = avg(slateResults.map(s => s.top1AvgMaxCombo3));
  const allFC3 = avg(slateResults.map(s => s.fieldAvgMaxCombo3));
  const allT1C4 = avg(slateResults.map(s => s.top1AvgMaxCombo4));
  const allFC4 = avg(slateResults.map(s => s.fieldAvgMaxCombo4));
  const allT1Core = avg(slateResults.map(s => s.top1CoreFreq));
  const allFCore = avg(slateResults.map(s => s.fieldCoreFreq));
  const allT1Shell = avg(slateResults.map(s => s.top1ShellFreq));
  const allFShell = avg(slateResults.map(s => s.fieldShellFreq));

  console.log('COMBO FREQUENCY (avg across slates):');
  console.log(`  ${'Metric'.padEnd(30)} ${'Top 1%'.padStart(10)} ${'Field'.padStart(10)} ${'Ratio'.padStart(10)}`);
  console.log('  ' + '─'.repeat(62));
  console.log(`  ${'Max 3-combo field freq'.padEnd(30)} ${(allT1C3*100).toFixed(2).padStart(9)}% ${(allFC3*100).toFixed(2).padStart(9)}% ${(allT1C3/allFC3).toFixed(2).padStart(10)}x`);
  console.log(`  ${'Max 4-combo field freq'.padEnd(30)} ${(allT1C4*100).toFixed(2).padStart(9)}% ${(allFC4*100).toFixed(2).padStart(9)}% ${(allT1C4/allFC4).toFixed(2).padStart(10)}x`);
  console.log(`  ${'Core (top-3 owned) freq'.padEnd(30)} ${(allT1Core*100).toFixed(2).padStart(9)}% ${(allFCore*100).toFixed(2).padStart(9)}% ${(allT1Core/allFCore).toFixed(2).padStart(10)}x`);
  console.log(`  ${'Shell (bottom-5) freq'.padEnd(30)} ${(allT1Shell*100).toFixed(3).padStart(9)}% ${(allFShell*100).toFixed(3).padStart(9)}% ${(allFShell > 0 ? allT1Shell/allFShell : 0).toFixed(2).padStart(10)}x`);

  console.log('\n  INTERPRETATION:');
  if (allT1C4 < allFC4 * 0.85) {
    console.log('  *** Winners have LOWER combo frequency than the field ***');
    console.log('  → Combo uniqueness IS a predictor of winning');
    console.log('  → Our crowding discount is directionally correct');
  } else if (allT1C4 > allFC4 * 1.15) {
    console.log('  *** Winners have HIGHER combo frequency than the field ***');
    console.log('  → Being in common combos HELPS (good lineups cluster)');
    console.log('  → REDUCE crowding discount — it is hurting us');
  } else {
    console.log('  *** Winners have SIMILAR combo frequency to the field ***');
    console.log('  → Combo uniqueness is NOT a strong predictor');
    console.log('  → Crowding discount has limited impact — focus elsewhere');
  }

  if (allT1Core > allFCore * 0.9 && allT1Shell < allFShell * 0.9) {
    console.log('\n  *** CORE-SHELL SPLIT CONFIRMED ***');
    console.log('  → Winners play the SAME stars (high core freq)');
    console.log('  → But DIFFERENT supporting casts (low shell freq)');
    console.log('  → Optimize: pick best stars, then DIVERSIFY the shell');
  }

  // Per-slate table
  console.log('\n  Per-slate breakdown:');
  console.log(`  ${'Slate'.padEnd(20)} ${'Entries'.padStart(7)} ${'T1%C4'.padStart(8)} ${'FieldC4'.padStart(8)} ${'Ratio'.padStart(8)} ${'T1Core'.padStart(8)} ${'FCore'.padStart(8)} ${'T1Shell'.padStart(8)} ${'FShell'.padStart(8)}`);
  console.log('  ' + '─'.repeat(88));
  for (const s of slateResults) {
    console.log(`  ${s.date.padEnd(20)} ${String(s.totalEntries).padStart(7)} ${(s.top1AvgMaxCombo4*100).toFixed(2).padStart(7)}% ${(s.fieldAvgMaxCombo4*100).toFixed(2).padStart(7)}% ${(s.fieldAvgMaxCombo4 > 0 ? s.top1AvgMaxCombo4/s.fieldAvgMaxCombo4 : 0).toFixed(2).padStart(8)} ${(s.top1CoreFreq*100).toFixed(2).padStart(7)}% ${(s.fieldCoreFreq*100).toFixed(2).padStart(7)}% ${(s.top1ShellFreq*100).toFixed(3).padStart(7)}% ${(s.fieldShellFreq*100).toFixed(3).padStart(7)}%`);
  }

  console.log('\n================================================================\n');
}

main();
