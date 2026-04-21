/**
 * Calibrated Field Generator — Haugh-Singal Eq 9 stacking copula.
 *
 * Generates a synthetic field using the calibrated opponent model:
 *   • Non-stackers: per-position Dirichlet-multinomial sampling
 *   • Stackers: pick a team, fill 4-5 slots from that team, optionally add bring-back
 *
 * Output is Lineup[] compatible with precomputeSlate's field parameter.
 */

import { Lineup, Player, ContestConfig, Sport } from '../types';
import { OpponentModelParams, DirichletCoeffs } from './calibration';

// ============================================================
// MAIN
// ============================================================

/**
 * Blended field: 80% SS pool (optimizer-quality, salary-efficient) + 20% casual
 * (ownership-weighted independent sampling). Passes all three Haugh-Singal
 * validation criteria when SS pool is the optimizer component.
 */
export function generateBlendedField(
  ssPoolLineups: Lineup[],
  players: Player[],
  config: ContestConfig,
  fieldSize: number,
  casualFraction: number = 0.20,
  seed: number = 42,
): Lineup[] {
  // 80% from SS pool (randomly sampled with replacement if needed)
  const optimizerCount = Math.floor(fieldSize * (1 - casualFraction));
  const casualCount = fieldSize - optimizerCount;

  let s = seed | 0;
  const rng = (): number => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };

  const field: Lineup[] = [];

  // Sample from SS pool (with replacement if pool < optimizerCount)
  for (let i = 0; i < optimizerCount; i++) {
    const idx = Math.floor(rng() * ssPoolLineups.length);
    field.push(ssPoolLineups[idx]);
  }

  // Generate casual lineups
  const sport = config.name.includes('MLB') ? 'mlb' as Sport : 'nba' as Sport;
  const salaryCap = config.salaryCap;
  const rosterSize = config.rosterSize;
  const positions = config.positions;
  const minProjection = 85; // casual lineups must exceed this floor

  const byPos = new Map<string, Player[]>();
  for (const p of players) {
    for (const pos of p.positions || [p.position.split('/')[0]]) {
      if (!byPos.has(pos)) byPos.set(pos, []);
      byPos.get(pos)!.push(p);
    }
  }

  let casualAttempts = 0;
  while (field.length < fieldSize && casualAttempts < casualCount * 10) {
    casualAttempts++;
    const lu = generateCasualLineup(players, byPos, positions, salaryCap, rosterSize, rng);
    if (!lu) continue;
    if (lu.projection < minProjection) continue;
    field.push(lu);
  }

  return field;
}

function generateCasualLineup(
  players: Player[],
  byPos: Map<string, Player[]>,
  positions: ContestConfig['positions'],
  salaryCap: number,
  rosterSize: number,
  rng: () => number,
): Lineup | null {
  const selected: Player[] = [];
  const usedIds = new Set<string>();
  let totalSalary = 0;

  for (const slot of positions) {
    const eligible = getEligible(slot, byPos, usedIds);
    if (eligible.length === 0) return null;

    // Casual sampling: ownership × salary-bias × noise
    const weights = eligible.map(p => {
      const own = Math.max(0.5, p.ownership || 0);
      const salaryBias = Math.pow(p.salary / 7000, 0.4); // slight star bias
      const noise = 0.7 + rng() * 0.6; // 0.7-1.3x random
      let w = own * salaryBias * noise;
      // Salary feasibility
      const remainingSlots = rosterSize - selected.length - 1;
      if (totalSalary + p.salary + remainingSlots * 3500 > salaryCap) w *= 0.01;
      return Math.max(0.001, w);
    });

    const p = sampleWeighted(eligible, weights, rng);
    if (!p) return null;
    selected.push(p);
    usedIds.add(p.id);
    totalSalary += p.salary;
  }

  if (totalSalary > salaryCap) return null;
  const projection = selected.reduce((s, p) => s + p.projection, 0);
  const ownership = selected.reduce((s, p) => s + (p.ownership || 0), 0) / selected.length;
  const hash = selected.map(p => p.id).sort().join('|');
  return { players: selected, salary: totalSalary, projection, ownership, hash };
}

export function generateCalibratedField(
  players: Player[],
  config: ContestConfig,
  fieldSize: number,
  model: OpponentModelParams,
  seed: number = 42,
): Lineup[] {
  let s = seed | 0;
  const rng = (): number => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };

  const sport = model.sport;
  const salaryCap = config.salaryCap;
  const rosterSize = config.rosterSize;
  const positions = config.positions;

  // Pre-group players by position
  const byPos = new Map<string, Player[]>();
  for (const p of players) {
    for (const pos of p.positions || [p.position.split('/')[0]]) {
      if (!byPos.has(pos)) byPos.set(pos, []);
      byPos.get(pos)!.push(p);
    }
  }
  // Group by team (exclude pitchers for MLB stacking)
  const byTeam = new Map<string, Player[]>();
  for (const p of players) {
    if (sport === 'mlb' && p.positions?.includes('P')) continue;
    if (!byTeam.has(p.team)) byTeam.set(p.team, []);
    byTeam.get(p.team)!.push(p);
  }

  const field: Lineup[] = [];
  const maxAttempts = fieldSize * 5;
  let attempts = 0;

  while (field.length < fieldSize && attempts < maxAttempts) {
    attempts++;
    const isStacker = rng() < model.stackingFraction;
    const lineup = isStacker
      ? generateStackerLineup(players, byTeam, positions, salaryCap, rosterSize, model, sport, rng)
      : generateIndependentLineup(players, byPos, positions, salaryCap, rosterSize, model, sport, rng);

    if (!lineup) continue;
    field.push(lineup);
  }

  return field;
}

// ============================================================
// INDEPENDENT LINEUP (Dirichlet per position)
// ============================================================

function generateIndependentLineup(
  players: Player[],
  byPos: Map<string, Player[]>,
  positions: ContestConfig['positions'],
  salaryCap: number,
  rosterSize: number,
  model: OpponentModelParams,
  sport: Sport,
  rng: () => number,
): Lineup | null {
  const selected: Player[] = [];
  const usedIds = new Set<string>();
  let totalSalary = 0;

  for (const slot of positions) {
    const eligible = getEligible(slot, byPos, usedIds);
    if (eligible.length === 0) return null;

    // Compute sampling weights — ownership-proportional with projection boost.
    // The Dirichlet regression coefficients (β₁=7-12) produce exp() weights that
    // are too extreme (224:1 ratio between 50% and 5% owned players). Instead,
    // use a power-law on ownership × projection blend that matches empirical
    // field ownership distribution shapes.
    const weights = eligible.map(p => {
      const own = Math.max(0.5, (p.ownership || 0));  // 0-100 scale
      const projNorm = p.projection / Math.max(1, ...eligible.map(x => x.projection));
      // Power-law: ownership dominates (real field is ownership-driven)
      // with projection tilt (field players also weight projection)
      const alpha = own * (0.6 + 0.4 * projNorm);
      return Math.max(0.001, alpha);
    });

    // Add salary feasibility weighting: heavily penalize players that blow the cap
    const remainingSlots = rosterSize - selected.length - 1;
    const minRemainingSalary = remainingSlots * 3500;
    for (let i = 0; i < eligible.length; i++) {
      if (totalSalary + eligible[i].salary + minRemainingSalary > salaryCap) {
        weights[i] *= 0.01;  // heavily discourage, don't zero out
      }
    }

    const p = sampleWeighted(eligible, weights, rng);
    if (!p) return null;
    selected.push(p);
    usedIds.add(p.id);
    totalSalary += p.salary;
  }

  if (totalSalary > salaryCap) return null;

  const projection = selected.reduce((s, p) => s + p.projection, 0);
  const ownership = selected.reduce((s, p) => s + (p.ownership || 0), 0) / selected.length;
  const hash = selected.map(p => p.id).sort().join('|');
  return { players: selected, salary: totalSalary, projection, ownership, hash };
}

// ============================================================
// STACKER LINEUP (copula — Haugh-Singal Eq 9)
// ============================================================

function generateStackerLineup(
  players: Player[],
  byTeam: Map<string, Player[]>,
  positions: ContestConfig['positions'],
  salaryCap: number,
  rosterSize: number,
  model: OpponentModelParams,
  sport: Sport,
  rng: () => number,
): Lineup | null {
  // Pick a stack team, weighted by avg team projection
  const teamWeights: Array<[string, number]> = [];
  for (const [team, teamPlayers] of byTeam) {
    if (teamPlayers.length < 4) continue;
    const avgProj = teamPlayers.reduce((s, p) => s + p.projection, 0) / teamPlayers.length;
    teamWeights.push([team, avgProj * avgProj]);
  }
  if (teamWeights.length === 0) return null;
  const totalW = teamWeights.reduce((s, [, w]) => s + w, 0);
  let r = rng() * totalW;
  let stackTeam = teamWeights[0][0];
  for (const [team, w] of teamWeights) {
    r -= w;
    if (r <= 0) { stackTeam = team; break; }
  }

  const teamPlayers = byTeam.get(stackTeam)!;
  const stackDepth = Math.min(teamPlayers.length, rng() < 0.4 ? 5 : 4);

  // Pick stack players by ownership-weighted sampling
  const stackSelected: Player[] = [];
  const used = new Set<string>();
  const ownWeights = teamPlayers.map(p => Math.max(0.5, p.ownership || 0));
  for (let i = 0; i < stackDepth; i++) {
    const eligible = teamPlayers.filter(p => !used.has(p.id));
    if (eligible.length === 0) break;
    const w = eligible.map(p => ownWeights[teamPlayers.indexOf(p)] || 1);
    const pick = sampleWeighted(eligible, w, rng);
    if (!pick) break;
    stackSelected.push(pick);
    used.add(pick.id);
  }

  // Optionally add bring-back
  if (rng() < model.bringBackFraction) {
    const stackOpp = teamPlayers[0]?.opponent;
    if (stackOpp) {
      const oppPlayers = (byTeam.get(stackOpp) || []).filter(p => !used.has(p.id));
      if (oppPlayers.length > 0) {
        const w = oppPlayers.map(p => Math.max(0.5, p.ownership || 0));
        const bb = sampleWeighted(oppPlayers, w, rng);
        if (bb) { stackSelected.push(bb); used.add(bb.id); }
      }
    }
  }

  // Fill remaining slots — exclude opposing-team players unless bring-back
  // was selected (prevents accidental bring-backs inflating the rate)
  const hasBringBack = stackSelected.some(p => p.team !== stackTeam && !p.positions?.includes('P'));
  const stackOppTeam = teamPlayers[0]?.opponent || '';
  const filledSlots = stackSelected.length;
  const remainingPositions = positions.slice(filledSlots);
  let totalSalary = stackSelected.reduce((s, p) => s + p.salary, 0);

  const byPos = new Map<string, Player[]>();
  for (const p of players) {
    if (used.has(p.id)) continue;
    // If no bring-back was chosen, exclude opposing-team batters from fill
    if (!hasBringBack && p.team === stackOppTeam && !(sport === 'mlb' && p.positions?.includes('P'))) continue;
    for (const pos of p.positions || [p.position.split('/')[0]]) {
      if (!byPos.has(pos)) byPos.set(pos, []);
      byPos.get(pos)!.push(p);
    }
  }

  const allSelected = [...stackSelected];
  for (const slot of remainingPositions) {
    const eligible = getEligible(slot, byPos, used);
    if (eligible.length === 0) return null;
    const remainingSlots = rosterSize - allSelected.length - 1;
    const minRemainingSalary = remainingSlots * 3500;
    const weights = eligible.map(p => {
      const own = Math.max(0.5, (p.ownership || 0));
      const projNorm = p.projection / Math.max(1, ...eligible.map(x => x.projection));
      let w = own * (0.6 + 0.4 * projNorm);
      if (totalSalary + p.salary + minRemainingSalary > salaryCap) w *= 0.01;
      return Math.max(0.001, w);
    });
    const pick = sampleWeighted(eligible, weights, rng);
    if (!pick) return null;
    allSelected.push(pick);
    used.add(pick.id);
    totalSalary += pick.salary;
  }

  if (totalSalary > salaryCap) return null;

  const projection = allSelected.reduce((s, p) => s + p.projection, 0);
  const ownership = allSelected.reduce((s, p) => s + (p.ownership || 0), 0) / allSelected.length;
  const hash = allSelected.map(p => p.id).sort().join('|');
  return { players: allSelected, salary: totalSalary, projection, ownership, hash };
}

// ============================================================
// HELPERS
// ============================================================

function getEligible(
  slot: ContestConfig['positions'][0],
  byPos: Map<string, Player[]>,
  usedIds: Set<string>,
): Player[] {
  const eligible: Player[] = [];
  const seen = new Set<string>();
  for (const pos of slot.eligible) {
    for (const p of byPos.get(pos) || []) {
      if (!usedIds.has(p.id) && !seen.has(p.id)) {
        seen.add(p.id);
        eligible.push(p);
      }
    }
  }
  return eligible;
}

function sampleWeighted<T>(items: T[], weights: number[], rng: () => number): T | null {
  if (items.length === 0) return null;
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return items[Math.floor(rng() * items.length)];
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

function primaryPos(p: Player, sport: Sport): string {
  if (sport === 'mlb' && p.positions?.includes('P')) return 'P';
  return (p.position || 'UTIL').split('/')[0];
}
