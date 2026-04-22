/**
 * V35 Determinism Probe — run V35 twice on the same slate with the same seed
 * and compare portfolio hashes. If result differs, RNG state is leaking.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Player } from '../types';
import { parseCSVFile, buildPlayerPool, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';
import { runV35 } from '../v35';

const DATA_DIR = 'C:/Users/colin/dfs opto';
const SLATE = { proj: '4-20-26projections.csv', pool: '4-20-26sspool.csv' };

async function runOnce(label: string) {
  const projPath = path.join(DATA_DIR, SLATE.proj);
  const poolPath = path.join(DATA_DIR, SLATE.pool);

  const pr = parseCSVFile(projPath, 'mlb', true);
  const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
  const pool = buildPlayerPool(pr.players, pr.detectedContestType);

  const idMap = new Map<string, Player>();
  for (const p of pool.players) idMap.set(p.id, p);

  const loaded = loadPoolFromCSV({ filePath: poolPath, config, playerMap: idMap });
  const candidates = loaded.lineups;

  const r = await runV35({
    players: pool.players,
    candidates,
    pool: candidates,
    targetCount: 150,
    numWorlds: 3000,
    fieldSize: 8000,
    entryFee: 20,
    maxExposure: 0.40,
    maxTeamStackPct: 0.10,
    seed: 12345,
  });

  const hashes = r.portfolio.map(lu => lu.hash).sort();
  const sig = hashes.join('|');
  const crc = sig.length; // quick signature
  const sumProj = r.portfolio.reduce((s, lu) => s + lu.projection, 0);
  console.log(`\n[${label}] portfolio size=${r.portfolio.length} sigLen=${crc} sumProj=${sumProj.toFixed(4)} firstHash=${hashes[0]} lastHash=${hashes[hashes.length - 1]}`);
  return { sig, sumProj, hashes };
}

async function main() {
  console.log('=== V35 Determinism Probe — 4-20-26, seed=12345 ===');
  const a = await runOnce('RUN-A');
  const b = await runOnce('RUN-B');

  const identical = a.sig === b.sig;
  console.log(`\n${'='.repeat(60)}`);
  console.log(`RESULT: ${identical ? 'DETERMINISTIC ✓ — same portfolio twice' : 'NON-DETERMINISTIC ✗ — portfolio differs'}`);
  console.log(`  sumProj A = ${a.sumProj.toFixed(4)}`);
  console.log(`  sumProj B = ${b.sumProj.toFixed(4)}`);
  console.log(`  sumProj delta = ${(a.sumProj - b.sumProj).toFixed(6)}`);
  if (!identical) {
    let diffs = 0;
    const setA = new Set(a.hashes);
    for (const h of b.hashes) if (!setA.has(h)) diffs++;
    console.log(`  lineups in B but not A: ${diffs} / ${b.hashes.length}`);
  }
  console.log(`${'='.repeat(60)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
