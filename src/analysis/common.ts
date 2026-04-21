/**
 * Shared helpers for the standalone analysis suite (--analyze-slate / --analyze-all).
 *
 * These utilities are intentionally self-contained and do NOT depend on the
 * world-simulation precompute; variance estimates use per-player stdDev plus a
 * small sport-aware correlation bump. For full simulated analysis, see
 * `src/analysis/pro-portfolio-analysis.ts` which runs inside --elite-backtest.
 */

import { ContestEntry, ContestActuals } from '../parser/actuals-parser';
import { Lineup, Player, Sport, ContestConfig } from '../types';

// ============================================================
// NAME NORMALIZATION
// ============================================================

export function normalizeName(name: string): string {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildNameToPlayerMap(players: Player[]): Map<string, Player> {
  const map = new Map<string, Player>();
  for (const p of players) map.set(normalizeName(p.name), p);
  return map;
}

// ============================================================
// CONTEST ENTRY → LINEUP JOIN
// ============================================================

export interface JoinedField {
  lineups: Lineup[];
  /** hash -> best-ranked entry */
  entryByHash: Map<string, ContestEntry>;
  /** hash -> actual score */
  actualByHash: Map<string, number>;
  /** entry index (original order) -> lineup hash, for preserving rank */
  entryHashes: (string | null)[];
  dropped: number;
}

export function entriesToLineups(
  entries: ContestEntry[],
  nameMap: Map<string, Player>,
): JoinedField {
  const lineups: Lineup[] = [];
  const entryByHash = new Map<string, ContestEntry>();
  const actualByHash = new Map<string, number>();
  const entryHashes: (string | null)[] = [];
  let dropped = 0;

  for (const entry of entries) {
    const players: Player[] = [];
    let resolved = true;
    for (const n of entry.playerNames) {
      const p = nameMap.get(normalizeName(n));
      if (!p) { resolved = false; break; }
      players.push(p);
    }
    if (!resolved || players.length === 0) {
      dropped++;
      entryHashes.push(null);
      continue;
    }
    const salary = players.reduce((s, p) => s + p.salary, 0);
    const projection = players.reduce((s, p) => s + p.projection, 0);
    const ownership = players.reduce((s, p) => s + (p.ownership || 0), 0) / players.length;
    const hash = players.map(p => p.id).sort().join('|');
    entryHashes.push(hash);
    if (!entryByHash.has(hash)) {
      entryByHash.set(hash, entry);
      actualByHash.set(hash, entry.actualPoints);
      lineups.push({ players, salary, projection, ownership, hash });
    } else {
      const existing = entryByHash.get(hash)!;
      if (entry.rank < existing.rank) {
        entryByHash.set(hash, entry);
        actualByHash.set(hash, entry.actualPoints);
      }
    }
  }
  return { lineups, entryByHash, actualByHash, entryHashes, dropped };
}

// ============================================================
// PRO AUTO-DETECTION
// ============================================================

/**
 * DK contest entry names typically look like `username (N/150)` or `username`.
 * Strip the trailing "(N/K)" marker to get the base username, then count entries
 * per username. Any username with >= minEntries is considered a pro.
 *
 * Pros on DK always play up to 150 lineups in the largest GPPs, so the default
 * threshold of 100 reliably separates pros from casual multi-entry players.
 */
export function extractUsername(entryName: string): string {
  return (entryName || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
}

export interface DetectedPro {
  username: string;
  entryCount: number;
  entries: ContestEntry[];
}

export function detectPros(
  entries: ContestEntry[],
  minEntries = 100,
): DetectedPro[] {
  const byUser = new Map<string, ContestEntry[]>();
  for (const e of entries) {
    const u = extractUsername(e.entryName);
    if (!u) continue;
    const arr = byUser.get(u);
    if (arr) arr.push(e); else byUser.set(u, [e]);
  }
  const pros: DetectedPro[] = [];
  for (const [username, es] of byUser) {
    if (es.length >= minEntries) {
      pros.push({ username, entryCount: es.length, entries: es });
    }
  }
  pros.sort((a, b) => b.entryCount - a.entryCount);
  return pros;
}

// ============================================================
// VARIANCE APPROXIMATION (stdDev-based, no sim)
// ============================================================

/**
 * Approximate lineup variance from per-player stdDev values.
 * Var(lineup) ≈ Σ σᵢ² + 2·ρ_avg · Σᵢ<ⱼ σᵢ σⱼ [teammates]
 *             + 2·(-ρ_opp) · Σᵢ<ⱼ σᵢ σⱼ [opposing hitters vs pitcher]
 *
 * Sport-specific correlation defaults (rough values from the research papers):
 *   NBA: ρ_teammate = 0.15, ρ_opp = 0.05
 *   MLB: ρ_teammate = 0.11 (non-pitcher), ρ_pitcher_opp = -0.35
 *   NFL: ρ_teammate = 0.25 (QB stack), ρ_opp = 0.10 (bring-back)
 */
export function approximateLineupVariance(lu: Lineup, sport: Sport): number {
  const n = lu.players.length;
  const sigma = lu.players.map(p => p.stdDev || 0);
  let sumVar = 0;
  for (let i = 0; i < n; i++) sumVar += sigma[i] * sigma[i];

  const rhoTeammate = sport === 'mlb' ? 0.11 : sport === 'nfl' ? 0.20 : sport === 'nba' ? 0.12 : 0.05;
  const rhoOppPitcher = sport === 'mlb' ? -0.30 : 0;

  for (let i = 0; i < n; i++) {
    const pi = lu.players[i];
    for (let j = i + 1; j < n; j++) {
      const pj = lu.players[j];
      if (sigma[i] === 0 || sigma[j] === 0) continue;
      const sameTeam = pi.team && pj.team && pi.team === pj.team;
      const isPitcherVsOppHitter =
        sport === 'mlb' &&
        ((pi.positions?.includes('P') && pj.team === pi.opponent) ||
         (pj.positions?.includes('P') && pi.team === pj.opponent));
      let rho = 0;
      if (isPitcherVsOppHitter) rho = rhoOppPitcher;
      else if (sameTeam) rho = rhoTeammate;
      sumVar += 2 * rho * sigma[i] * sigma[j];
    }
  }
  return Math.max(1, sumVar);
}

// ============================================================
// STACK ANALYSIS HELPERS
// ============================================================

export function countTeamPlayers(lu: Lineup, opts?: { excludePitcher?: boolean }): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of lu.players) {
    if (opts?.excludePitcher && p.positions?.includes('P')) continue;
    m.set(p.team, (m.get(p.team) || 0) + 1);
  }
  return m;
}

export function primaryStackTeam(lu: Lineup, sport: Sport): { team: string; depth: number } {
  const counts = countTeamPlayers(lu, { excludePitcher: sport === 'mlb' });
  let best = '', depth = 0;
  for (const [team, c] of counts) {
    if (c > depth) { best = team; depth = c; }
  }
  return { team: best, depth };
}

export function hasBringBack(lu: Lineup, sport: Sport): boolean {
  if (sport !== 'mlb' && sport !== 'nfl') return false;
  const { team: stackTeam } = primaryStackTeam(lu, sport);
  if (!stackTeam) return false;
  // Find an opponent player in the lineup from the game of the stack team
  const stackOpp = lu.players.find(p => p.team === stackTeam)?.opponent;
  if (!stackOpp) return false;
  const bringBackCount = lu.players.filter(
    p => p.team === stackOpp && !(sport === 'mlb' && p.positions?.includes('P')),
  ).length;
  return bringBackCount >= 1;
}

// ============================================================
// PERCENTILE / THRESHOLD HELPERS
// ============================================================

export interface FieldThresholds {
  top1: number;
  top5: number;
  top10: number;
  top1Count: number;      // number of entries in top-1% bucket
  totalEntries: number;
}

export function computeFieldThresholds(entries: ContestEntry[]): FieldThresholds {
  const n = entries.length;
  const sorted = entries.map(e => e.actualPoints).sort((a, b) => b - a);
  const at = (frac: number) => sorted[Math.max(0, Math.floor(n * frac) - 1)] || 0;
  return {
    top1: at(0.01),
    top5: at(0.05),
    top10: at(0.10),
    top1Count: Math.max(1, Math.floor(n * 0.01)),
    totalEntries: n,
  };
}

// ============================================================
// IDENTIFY ANCHOR PLAYER
// ============================================================

/**
 * Sport-specific anchor: pitcher (MLB), top-salary player (NBA/NFL default).
 */
export function anchorOfLineup(lu: Lineup, sport: Sport): Player | null {
  if (sport === 'mlb') {
    return lu.players.find(p => p.positions?.includes('P')) || null;
  }
  return [...lu.players].sort((a, b) => b.salary - a.salary)[0] || null;
}

// ============================================================
// UNUSED BUT USEFUL — re-export for modules
// ============================================================

export type { ContestConfig, Lineup, Player };
