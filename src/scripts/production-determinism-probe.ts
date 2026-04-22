/**
 * Production Selector Determinism Probe — run twice on same slate,
 * compare portfolio hashes. Zero RNG means this should be trivially identical.
 */

import * as path from 'path';
import { Player } from '../types';
import { parseCSVFile, buildPlayerPool, loadPoolFromCSV } from '../parser';
import { getContestConfig } from '../rules';
import { productionSelect } from '../selection/production-selector';

const DIR = 'C:/Users/colin/dfs opto';
const SLATE = { proj: '4-20-26projections.csv', pool: '4-20-26sspool.csv' };

function runOnce(label: string) {
  const pr = parseCSVFile(path.join(DIR, SLATE.proj), 'mlb', true);
  const config = getContestConfig('dk', 'mlb', pr.detectedContestType);
  const pool = buildPlayerPool(pr.players, pr.detectedContestType);

  const idMap = new Map<string, Player>();
  for (const p of pool.players) idMap.set(p.id, p);

  const loaded = loadPoolFromCSV({ filePath: path.join(DIR, SLATE.pool), config, playerMap: idMap });

  const r = productionSelect(loaded.lineups, pool.players, { N: 150 });

  const hashes = r.portfolio.map(lu => lu.hash).sort();
  const sig = hashes.join('|');
  const sumProj = r.portfolio.reduce((s, lu) => s + lu.projection, 0);
  console.log(`[${label}] size=${r.portfolio.length} sigLen=${sig.length} sumProj=${sumProj.toFixed(4)}`);
  return { sig, sumProj };
}

function main() {
  console.log('=== Production Determinism Probe — 4-20-26 ===');
  const a = runOnce('RUN-A');
  const b = runOnce('RUN-B');
  const identical = a.sig === b.sig;
  console.log(`\nRESULT: ${identical ? 'DETERMINISTIC ✓' : 'NON-DETERMINISTIC ✗'}`);
  console.log(`  sumProj delta = ${(a.sumProj - b.sumProj).toFixed(6)}`);
}

main();
