/**
 * V33 Pure — Hunter U²ₗ marginal gain with blended field, no regions.
 *
 * Pure research framework: precomputeSlate → greedy marginal gain selection
 * one entry at a time, each maximizing new world coverage. Team coverage
 * constraint + exposure cap as the only hard constraints. No regions, no
 * tilted projections, no within-region scoring.
 *
 * Backtested on 7 MLB slates vs V32 (region-targeted).
 */

import * as fs from 'fs';
import * as path from 'path';
import { Lineup, Player } from '../types';
import {
  parseCSVFile, buildPlayerPool, parseContestActuals, loadPoolFromCSV, ContestActuals,
} from '../parser';
import { getContestConfig } from '../rules';
import {
  DEFAULT_SELECTOR_PARAMS, SelectorParams, defaultGamma, getSportDefaults, precomputeSlate,
  SlatePrecomputation,
} from '../selection/algorithm7-selector';
import { generateBlendedField } from '../opponent/field-generator';

const DATA_DIR = 'C:/Users/colin/dfs opto';
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

/**
 * Pure Hunter U²ₗ greedy selection.
 *
 * For each entry slot: score every candidate by how many NEW worlds at the
 * top-1% tier it covers that the current portfolio doesn't. Pick the one
 * with highest marginal gain. Repeat N times.
 *
 * Hard constraints: exposure cap, team stack cap.
 */
function selectPureU2(
  precomp: SlatePrecomputation,
  N: number,
  maxExposure: number,
  maxPerTeam: number,
): Lineup[] {
  const { W, C, candidateWorldScores, candidatePool } = precomp;
  const thresh1 = precomp.thresh1;  // per-world top-1% threshold

  // Pre-compute per-candidate per-world hit indicator
  const hits = new Uint8Array(C * W);
  for (let c = 0; c < C; c++) {
    for (let w = 0; w < W; w++) {
      if (candidateWorldScores[c * W + w] >= thresh1[w]) hits[c * W + w] = 1;
    }
  }

  const selected: Lineup[] = [];
  const selectedHashes = new Set<string>();
  const playerCount = new Map<string, number>();
  const teamStackCount = new Map<string, number>();
  const covered = new Uint8Array(W);  // worlds already covered by portfolio
  const expCap = Math.ceil(maxExposure * N);

  for (let step = 0; step < N; step++) {
    let bestIdx = -1;
    let bestGain = -1;

    for (let c = 0; c < C; c++) {
      const lu = candidatePool[c];
      if (selectedHashes.has(lu.hash)) continue;

      // Exposure check
      let expOk = true;
      for (const p of lu.players) if ((playerCount.get(p.id) || 0) >= expCap) { expOk = false; break; }
      if (!expOk) continue;

      // Team stack cap
      const tc = new Map<string, number>();
      for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
      let teamOk = true;
      for (const [t, cnt] of tc) if (cnt >= 4 && (teamStackCount.get(t) || 0) >= maxPerTeam) { teamOk = false; break; }
      if (!teamOk) continue;

      // Marginal gain: count NEW worlds this candidate covers
      let gain = 0;
      for (let w = 0; w < W; w++) {
        if (!covered[w] && hits[c * W + w]) gain++;
      }

      if (gain > bestGain) { bestGain = gain; bestIdx = c; }
    }

    if (bestIdx < 0) break;

    const lu = candidatePool[bestIdx];
    selected.push(lu);
    selectedHashes.add(lu.hash);
    for (const p of lu.players) playerCount.set(p.id, (playerCount.get(p.id) || 0) + 1);
    const tc2 = new Map<string, number>();
    for (const p of lu.players) if (!p.positions?.includes('P')) tc2.set(p.team, (tc2.get(p.team) || 0) + 1);
    for (const [t, cnt] of tc2) if (cnt >= 4) teamStackCount.set(t, (teamStackCount.get(t) || 0) + 1);

    // Mark covered worlds
    for (let w = 0; w < W; w++) {
      if (hits[bestIdx * W + w]) covered[w] = 1;
    }

    if ((step + 1) % 25 === 0 || step === 0) {
      let covCount = 0; for (let w = 0; w < W; w++) covCount += covered[w];
      console.log(`    [U²] ${step + 1}/${N}  gain=${bestGain}  coverage=${(covCount / W * 100).toFixed(1)}%`);
    }
  }

  return selected;
}

async function main() {
  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
  let md = `# V33 Pure (Hunter U²ₗ, blended field, no regions) vs V32\n\n`;
  md += `| Slate | Entries | V32 t1 (prior) | **V33 t1** | V33 stacks | V33 overlap | V33 own | V33 proj |\n`;
  md += `|---|---:|---:|---:|---:|---:|---:|---:|\n`;

  // V32 prior results (hardcoded from last run)
  const v32Prior: Record<string, number> = {
    '4-6-26': 14, '4-8-26': 4, '4-12-26': 0, '4-14-26': 0,
    '4-15-26': 2, '4-17-26': 2, '4-18-26': 6,
  };

  let v33T1Sum = 0, v33N = 0;

  for (const s of SLATES) {
    const projPath = path.join(DATA_DIR, s.proj);
    const actualsPath = path.join(DATA_DIR, s.actuals);
    const poolPath = path.join(DATA_DIR, s.pool);
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
    const top1 = sorted[Math.max(0, Math.floor(F * 0.01) - 1)] || 0;

    // Build field + pool
    const fieldLineups: Lineup[] = []; const seenH = new Set<string>(); const actualByHash = new Map<string, number>();
    for (const e of actuals.entries) { const pls: Player[] = []; let ok = true;
      for (const nm of e.playerNames) { const p = nameMap.get(norm(nm)); if (!p) { ok = false; break; } pls.push(p); }
      if (!ok) continue; const hash = pls.map(p => p.id).sort().join('|');
      if (seenH.has(hash)) continue; seenH.add(hash);
      fieldLineups.push({ players: pls, salary: pls.reduce((sm, p) => sm + p.salary, 0), projection: pls.reduce((sm, p) => sm + p.projection, 0), ownership: pls.reduce((sm, p) => sm + (p.ownership || 0), 0) / pls.length, hash });
      actualByHash.set(hash, e.actualPoints);
    }

    const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
    const blendedField = generateBlendedField(loaded.lineups, pool.players, config, Math.min(8000, F), 0.20);

    const selParams: SelectorParams = { ...DEFAULT_SELECTOR_PARAMS, ...getSportDefaults('mlb'), N: 150, gamma: defaultGamma(config.rosterSize), numWorlds: 1500 };

    console.log(`  precompute…`);
    const precomp = precomputeSlate(loaded.lineups, blendedField, pool.players, selParams, 'mlb');

    console.log(`  V33 pure U²ₗ selection…`);
    const maxPerTeam = Math.floor(150 * 0.25);
    const portfolio = selectPureU2(precomp, 150, 0.40, maxPerTeam);

    // Score
    let t1 = 0, scored = 0;
    for (const lu of portfolio) {
      const fa = actualByHash.get(lu.hash); let a: number | null = fa !== undefined ? fa : null;
      if (a === null) { let t = 0, miss = false; for (const p of lu.players) { const r = actuals.playerActualsByName.get(norm(p.name)); if (!r) { miss = true; break; } t += r.fpts; } if (!miss) a = t; }
      if (a === null) continue; scored++; if (a >= top1) t1++;
    }

    // Structural
    const stackTeams = new Set<string>();
    for (const lu of portfolio) {
      const tc = new Map<string, number>(); for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
      for (const [t, c] of tc) if (c >= 4) stackTeams.add(t);
    }
    let os = 0, oc = 0; let seed = 13;
    const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };
    for (let p = 0; p < 300; p++) { const i = Math.floor(rng() * portfolio.length); let j = Math.floor(rng() * (portfolio.length - 1)); if (j >= i) j++;
      const si = new Set(portfolio[i].players.map(x => x.id)); let sh = 0; for (const x of portfolio[j].players) if (si.has(x.id)) sh++; os += sh; oc++; }
    let sP = 0, sO = 0;
    for (const l of portfolio) { sP += l.projection; sO += l.players.reduce((sm: number, p: Player) => sm + (p.ownership || 0), 0) / l.players.length; }

    console.log(`  V33: t1=${t1}/${scored} stacks=${stackTeams.size} overlap=${(os/oc).toFixed(1)} proj=${(sP/portfolio.length).toFixed(1)} own=${(sO/portfolio.length).toFixed(1)}%`);

    v33T1Sum += scored > 0 ? t1 / scored : 0; v33N++;
    md += `| ${s.slate} | ${F.toLocaleString()} | ${v32Prior[s.slate] ?? '?'} | **${t1}** | ${stackTeams.size} | ${(os/oc).toFixed(1)} | ${(sO/portfolio.length).toFixed(1)}% | ${(sP/portfolio.length).toFixed(1)} |\n`;
  }

  md += `\n**V33 mean top-1%: ${pct(v33T1Sum / v33N)}**\n`;
  md += `V32 mean top-1%: ~3.15% (from prior backtests)\n`;

  fs.writeFileSync(path.join(DATA_DIR, 'v33_pure_backtest.md'), md);
  console.log(`\n✓ Report: ${path.join(DATA_DIR, 'v33_pure_backtest.md')}`);
}

main();
