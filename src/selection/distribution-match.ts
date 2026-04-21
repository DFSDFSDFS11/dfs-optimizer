/**
 * Distribution Matching Selector — match the aggregate 150-maxer profile.
 *
 * Target: historical maxer aggregate team exposures, player exposures,
 * ownership distribution. Greedy selection minimizing squared divergence
 * from target distribution.
 *
 * No regions, no scenarios, no σ_{δ,G}, no U²ₗ. Just: look like the
 * aggregate of what smart money plays, compressed into 150 entries.
 */

import { Lineup, Player } from '../types';
import { ContestEntry, ContestActuals } from '../parser/actuals-parser';

// ============================================================
// TARGET PROFILE
// ============================================================

export interface MaxerTargetProfile {
  /** team → target fraction of portfolio stacking this team (4+) */
  teamStackTargets: Map<string, number>;
  /** player id → target exposure fraction */
  playerExpTargets: Map<string, number>;
  /** target avg ownership for the portfolio */
  targetAvgOwnership: number;
  /** number of maxer slates this profile was built from */
  slatesUsed: number;
}

/**
 * Build target profile from historical contest actuals.
 * Extracts every 150-maxer's portfolio, aggregates their team/player exposures.
 */
export function buildMaxerTargetProfile(
  slateActuals: Array<{
    actuals: ContestActuals;
    nameMap: Map<string, Player>;
  }>,
): MaxerTargetProfile {
  const teamStackCounts = new Map<string, number>();
  const playerExpCounts = new Map<string, number>();
  let totalMaxerEntries = 0;
  let sumOwnership = 0;

  for (const { actuals, nameMap } of slateActuals) {
    // Group by user
    const byUser = new Map<string, ContestEntry[]>();
    for (const e of actuals.entries) {
      const u = (e.entryName || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
      if (!u) continue;
      const a = byUser.get(u);
      if (a) a.push(e); else byUser.set(u, [e]);
    }

    for (const [, entries] of byUser) {
      if (entries.length < 140) continue;

      for (const e of entries) {
        const pls: Player[] = [];
        let ok = true;
        for (const n of e.playerNames) {
          const norm = n.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
          const p = nameMap.get(norm);
          if (!p) { ok = false; break; }
          pls.push(p);
        }
        if (!ok || pls.length < 8) continue;

        totalMaxerEntries++;
        sumOwnership += pls.reduce((s, p) => s + (p.ownership || 0), 0) / pls.length;

        // Player exposure
        for (const p of pls) {
          playerExpCounts.set(p.id, (playerExpCounts.get(p.id) || 0) + 1);
        }

        // Team stack
        const tc = new Map<string, number>();
        for (const p of pls) {
          if (p.positions?.includes('P')) continue;
          tc.set(p.team, (tc.get(p.team) || 0) + 1);
        }
        for (const [t, c] of tc) {
          if (c >= 4) teamStackCounts.set(t, (teamStackCounts.get(t) || 0) + 1);
        }
      }
    }
  }

  if (totalMaxerEntries === 0) {
    return { teamStackTargets: new Map(), playerExpTargets: new Map(), targetAvgOwnership: 14, slatesUsed: 0 };
  }

  // Normalize to fractions
  const teamStackTargets = new Map<string, number>();
  for (const [t, c] of teamStackCounts) teamStackTargets.set(t, c / totalMaxerEntries);

  const playerExpTargets = new Map<string, number>();
  for (const [id, c] of playerExpCounts) playerExpTargets.set(id, c / totalMaxerEntries);

  return {
    teamStackTargets,
    playerExpTargets,
    targetAvgOwnership: sumOwnership / totalMaxerEntries,
    slatesUsed: slateActuals.length,
  };
}

/**
 * For a NEW slate (no historical maxer data), build approximate target from
 * the SS pool itself + ownership-weighted estimates.
 */
export function buildApproxTargetFromPool(
  pool: Lineup[],
  players: Player[],
): MaxerTargetProfile {
  const N = pool.length;
  const teamStackCounts = new Map<string, number>();
  const playerExpCounts = new Map<string, number>();
  let sumOwn = 0;

  for (const lu of pool) {
    sumOwn += lu.players.reduce((s, p) => s + (p.ownership || 0), 0) / lu.players.length;
    for (const p of lu.players) playerExpCounts.set(p.id, (playerExpCounts.get(p.id) || 0) + 1);
    const tc = new Map<string, number>();
    for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
    for (const [t, c] of tc) if (c >= 4) teamStackCounts.set(t, (teamStackCounts.get(t) || 0) + 1);
  }

  const teamStackTargets = new Map<string, number>();
  for (const [t, c] of teamStackCounts) teamStackTargets.set(t, c / N);
  const playerExpTargets = new Map<string, number>();
  for (const [id, c] of playerExpCounts) playerExpTargets.set(id, c / N);

  return { teamStackTargets, playerExpTargets, targetAvgOwnership: N > 0 ? sumOwn / N : 14, slatesUsed: 0 };
}

// ============================================================
// DISTRIBUTION MATCHING SELECTOR
// ============================================================

export function distributionMatchSelect(
  candidatePool: Lineup[],
  target: MaxerTargetProfile,
  N: number,
  maxExposure: number,
  maxPerTeam: number,
): Lineup[] {
  const selected: Lineup[] = [];
  const selectedHashes = new Set<string>();
  const playerCount = new Map<string, number>();
  const teamStackCount = new Map<string, number>();
  const expCap = Math.ceil(maxExposure * N);

  // Current portfolio distributions (updated as we select)
  const currentTeamStacks = new Map<string, number>();
  const currentPlayerExp = new Map<string, number>();

  // Pre-extract candidate features
  const candFeatures = candidatePool.map(lu => {
    const tc = new Map<string, number>();
    for (const p of lu.players) if (!p.positions?.includes('P')) tc.set(p.team, (tc.get(p.team) || 0) + 1);
    let stackTeam = '';
    let stackSize = 0;
    for (const [t, c] of tc) if (c > stackSize) { stackSize = c; stackTeam = t; }
    return {
      stackTeam: stackSize >= 4 ? stackTeam : '',
      playerIds: lu.players.map(p => p.id),
      ownership: lu.players.reduce((s, p) => s + (p.ownership || 0), 0) / lu.players.length,
    };
  });

  for (let step = 0; step < N; step++) {
    let bestIdx = -1;
    let bestReduction = -Infinity;

    for (let c = 0; c < candidatePool.length; c++) {
      const lu = candidatePool[c];
      if (selectedHashes.has(lu.hash)) continue;

      // Exposure check
      let expOk = true;
      for (const p of lu.players) if ((playerCount.get(p.id) || 0) >= expCap) { expOk = false; break; }
      if (!expOk) continue;

      // Team stack cap
      const cf = candFeatures[c];
      if (cf.stackTeam && (teamStackCount.get(cf.stackTeam) || 0) >= maxPerTeam) continue;

      // Compute divergence reduction if we add this candidate
      const currentN = selected.length;
      const newN = currentN + 1;

      let reduction = 0;

      // Team stack divergence change
      for (const [team, targetFrac] of target.teamStackTargets) {
        const currentFrac = currentN > 0 ? (currentTeamStacks.get(team) || 0) / currentN : 0;
        const newCount = (currentTeamStacks.get(team) || 0) + (cf.stackTeam === team ? 1 : 0);
        const newFrac = newCount / newN;
        const oldError = (currentFrac - targetFrac) * (currentFrac - targetFrac);
        const newError = (newFrac - targetFrac) * (newFrac - targetFrac);
        reduction += (oldError - newError) * 3.0; // weight team stacks heavily
      }
      // Bonus for stacking a team that's UNDER target
      if (cf.stackTeam) {
        const targetF = target.teamStackTargets.get(cf.stackTeam) || 0;
        const currentF = currentN > 0 ? (currentTeamStacks.get(cf.stackTeam) || 0) / currentN : 0;
        if (currentF < targetF) reduction += (targetF - currentF) * 2.0;
      }

      // Player exposure divergence (sample top 20 target players for speed)
      const topTargetPlayers = [...target.playerExpTargets.entries()]
        .sort((a, b) => b[1] - a[1]).slice(0, 30);
      for (const [pid, targetFrac] of topTargetPlayers) {
        const currentFrac = currentN > 0 ? (currentPlayerExp.get(pid) || 0) / currentN : 0;
        const hasPlayer = cf.playerIds.includes(pid) ? 1 : 0;
        const newFrac = ((currentPlayerExp.get(pid) || 0) + hasPlayer) / newN;
        const oldError = (currentFrac - targetFrac) * (currentFrac - targetFrac);
        const newError = (newFrac - targetFrac) * (newFrac - targetFrac);
        reduction += (oldError - newError) * 1.0;
      }

      if (reduction > bestReduction) { bestReduction = reduction; bestIdx = c; }
    }

    if (bestIdx < 0) break;

    const lu = candidatePool[bestIdx];
    const cf = candFeatures[bestIdx];
    selected.push(lu);
    selectedHashes.add(lu.hash);
    for (const p of lu.players) {
      playerCount.set(p.id, (playerCount.get(p.id) || 0) + 1);
      currentPlayerExp.set(p.id, (currentPlayerExp.get(p.id) || 0) + 1);
    }
    if (cf.stackTeam) {
      teamStackCount.set(cf.stackTeam, (teamStackCount.get(cf.stackTeam) || 0) + 1);
      currentTeamStacks.set(cf.stackTeam, (currentTeamStacks.get(cf.stackTeam) || 0) + 1);
    }

    if ((step + 1) % 25 === 0 || step === 0) {
      // Compute current cosine to target
      let dot = 0, magA = 0, magB = 0;
      for (const [t, targetF] of target.teamStackTargets) {
        const curF = (currentTeamStacks.get(t) || 0) / (step + 1);
        dot += curF * targetF; magA += curF * curF; magB += targetF * targetF;
      }
      const cos = Math.sqrt(magA) * Math.sqrt(magB) > 0 ? dot / (Math.sqrt(magA) * Math.sqrt(magB)) : 0;
      const scenario = cf.stackTeam || 'spread';
      console.log(`    [distMatch] ${step+1}/${N} team=${scenario} stackCos=${cos.toFixed(3)}`);
    }
  }

  return selected;
}
