import { Lineup, Player } from '../types';

export type OwnershipScope = 'hitters' | 'all';

export interface TheoryV1Params {
  name: string;
  stackBonusPerHitter: number;
  bringBack1: number;
  bringBack2: number;
  pitcherVsHitterPenalty: number;
  minPrimaryStack: number;
  wProj: number;
  wLev: number;
  wVar: number;
  wCmb: number;
  wStructure: number;
  wStackField: number;
  wGameOverload: number;
  exposureCapHitter: number;
  exposureCapPitcher: number;
  teamStackCap: number;
  bandHighPct: number;
  bandMidPct: number;
  bandLowPct: number;
  maxPairwiseOverlap: number;
  tripleFreqCap: number;
  ppdPenalty: number;
  ppdTopPct: number;
  ownershipScope: OwnershipScope;
}

export interface LineupStructure {
  primaryTeam: string;
  primarySize: number;
  secondarySize: number;
  bringBack: number;
  pitcherVsHitterCount: number;
  maxGameHitters: number;
  teamHitters: Map<string, number>;
}

export interface ScoredTheoryLineup {
  lineup: Lineup;
  primaryTeam: string;
  primarySize: number;
  secondarySize: number;
  bringBack: number;
  maxGameHitters: number;
  pitcherVsHitterCount: number;
  proj: number;
  floor: number;
  ceiling: number;
  range: number;
  corrAdj: number;
  logOwnership: number;
  uniqueness: number;
  ppd: number;
  structureScore: number;
  stackFieldScore: number;
  gameOverloadScore: number;
  ev: number;
  projPct: number;
  ownPct: number;
  rangePct: number;
  ppdPct: number;
  uniqPct: number;
  structurePct: number;
  stackFieldPct: number;
  gameOverloadPct: number;
}

export interface TheoryV1SelectionDiagnostics {
  originalCount: number;
  filteredCount: number;
  targetCount: number;
  selectedCount: number;
  highTarget: number;
  midTarget: number;
  lowTarget: number;
  highSelected: number;
  midSelected: number;
  lowSelected: number;
  fallbackSelected: number;
  relaxedOverlapAttempts: number;
}

export interface TheoryV1SelectionResult {
  portfolio: Lineup[];
  selected: ScoredTheoryLineup[];
  scored: ScoredTheoryLineup[];
  diagnostics: TheoryV1SelectionDiagnostics;
}

export interface TheoryPortfolioSummary {
  lineups: number;
  avgProjection: number;
  avgOwnership: number;
  avgOwnershipSum: number;
  avgSalary: number;
  pctPrimary4: number;
  pctPrimary5Plus: number;
  pctBringBackGte1: number;
  pctBringBackGte2: number;
  pctNaked5Plus: number;
  pctGameOverload8: number;
  uniquePlayers: number;
  stackCounts: Array<{ team: string; count: number; pct: number }>;
  topExposures: Array<{
    id: string;
    name: string;
    team: string;
    position: string;
    count: number;
    pct: number;
    ownership: number;
    projection: number;
  }>;
}

export const THEORY_V1_NOCORR_PARAMS: TheoryV1Params = {
  name: 'nocorr',
  stackBonusPerHitter: 0,
  bringBack1: 0,
  bringBack2: 0,
  pitcherVsHitterPenalty: -0.10,
  minPrimaryStack: 4,
  wProj: 1.0,
  wLev: 0.30,
  wVar: 0.15,
  wCmb: 0.25,
  wStructure: 0,
  wStackField: 0,
  wGameOverload: 0,
  exposureCapHitter: 0.25,
  exposureCapPitcher: 0.45,
  teamStackCap: 0.20,
  bandHighPct: 0.20,
  bandMidPct: 0.60,
  bandLowPct: 0.20,
  maxPairwiseOverlap: 6,
  tripleFreqCap: 5,
  ppdPenalty: 0.10,
  ppdTopPct: 0.10,
  ownershipScope: 'hitters',
};

export const THEORY_V1_PRINCIPLES_PARAMS: TheoryV1Params = {
  ...THEORY_V1_NOCORR_PARAMS,
  name: 'principles',
  wLev: 0.10,
  wStructure: 0.10,
  wStackField: 0.05,
  wGameOverload: 0.08,
};

export const THEORY_V1_REVIVAL_PARAMS: TheoryV1Params = {
  ...THEORY_V1_NOCORR_PARAMS,
  name: 'revival',
  stackBonusPerHitter: 0.01,
  ownershipScope: 'all',
};

export const THEORY_V1_PITCHER_UNCAP_PARAMS: TheoryV1Params = {
  ...THEORY_V1_NOCORR_PARAMS,
  name: 'pitcher-uncap',
  exposureCapPitcher: 1.0,
};

export function cloneTheoryParams(
  base: TheoryV1Params,
  overrides: Partial<TheoryV1Params> = {},
): TheoryV1Params {
  return { ...base, ...overrides };
}

export function isPitcher(player: Player): boolean {
  return (player.position || '').toUpperCase().includes('P');
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function rankPercentile(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  if (n === 1) return [0];

  const sorted = values.map((value, index) => ({ value, index }))
    .sort((a, b) => a.value - b.value);
  const out = new Array<number>(n);

  let start = 0;
  while (start < n) {
    let end = start;
    while (end + 1 < n && sorted[end + 1].value === sorted[start].value) end++;
    const pct = ((start + end) / 2) / (n - 1);
    for (let i = start; i <= end; i++) out[sorted[i].index] = pct;
    start = end + 1;
  }

  return out;
}

export function computeLineupStructure(lineup: Lineup): LineupStructure {
  const teamHitters = new Map<string, number>();
  const pitchers: Player[] = [];
  const gameHitters = new Map<string, number>();

  for (const player of lineup.players) {
    const team = normalizeTeam(player.team);
    const opponent = normalizeTeam(player.opponent);
    if (isPitcher(player)) {
      pitchers.push(player);
      continue;
    }

    if (team) teamHitters.set(team, (teamHitters.get(team) || 0) + 1);
    if (team && opponent) {
      const gameKey = [team, opponent].sort().join('@');
      gameHitters.set(gameKey, (gameHitters.get(gameKey) || 0) + 1);
    }
  }

  let primaryTeam = '';
  let primarySize = 0;
  for (const [team, count] of teamHitters) {
    if (count > primarySize) {
      primaryTeam = team;
      primarySize = count;
    }
  }

  let secondarySize = 0;
  for (const [team, count] of teamHitters) {
    if (team !== primaryTeam && count > secondarySize) secondarySize = count;
  }

  let primaryOpponent = '';
  if (primaryTeam) {
    for (const player of lineup.players) {
      if (isPitcher(player)) continue;
      if (normalizeTeam(player.team) !== primaryTeam) continue;
      primaryOpponent = normalizeTeam(player.opponent);
      if (primaryOpponent) break;
    }
  }

  const bringBack = primaryOpponent ? (teamHitters.get(primaryOpponent) || 0) : 0;

  let pitcherVsHitterCount = 0;
  for (const pitcher of pitchers) {
    const opponent = normalizeTeam(pitcher.opponent);
    if (opponent) pitcherVsHitterCount += teamHitters.get(opponent) || 0;
  }

  let maxGameHitters = 0;
  for (const [, count] of gameHitters) {
    if (count > maxGameHitters) maxGameHitters = count;
  }

  return {
    primaryTeam,
    primarySize,
    secondarySize,
    bringBack,
    pitcherVsHitterCount,
    maxGameHitters,
    teamHitters,
  };
}

export function scoreTheoryV1Candidates(
  candidates: Lineup[],
  params: TheoryV1Params,
): ScoredTheoryLineup[] {
  const comboFreqs = buildPairTripleFreqs(candidates);
  const teamStackStrength = buildTeamStackStrength(candidates);

  const scored = candidates.map((lineup): ScoredTheoryLineup => {
    const structure = computeLineupStructure(lineup);
    const distribution = lineupDistribution(lineup);
    const corrAdj = correlationAdjustment(structure, params);
    const uniqueness = comboUniqueness(lineup, comboFreqs.pair, comboFreqs.triple, params.tripleFreqCap);
    const logOwnership = lineupLogOwnership(lineup, params.ownershipScope);
    const ppd = lineupPpd(lineup);
    const structureScore = structuralPriorScore(structure);
    const stackFieldScore = teamStackStrength.get(structure.primaryTeam) ?? 0;
    const gameOverloadScore = gameOverloadPriorScore(structure);

    return {
      lineup,
      primaryTeam: structure.primaryTeam,
      primarySize: structure.primarySize,
      secondarySize: structure.secondarySize,
      bringBack: structure.bringBack,
      maxGameHitters: structure.maxGameHitters,
      pitcherVsHitterCount: structure.pitcherVsHitterCount,
      proj: lineup.projection,
      floor: distribution.floor,
      ceiling: distribution.ceiling,
      range: distribution.ceiling - distribution.floor,
      corrAdj,
      logOwnership,
      uniqueness,
      ppd,
      structureScore,
      stackFieldScore,
      gameOverloadScore,
      ev: 0,
      projPct: 0,
      ownPct: 0,
      rangePct: 0,
      ppdPct: 0,
      uniqPct: 0,
      structurePct: 0,
      stackFieldPct: 0,
      gameOverloadPct: 0,
    };
  });

  const projPct = rankPercentile(scored.map(s => Math.max(0, s.proj * (1 + s.corrAdj))));
  const ownPct = rankPercentile(scored.map(s => s.logOwnership));
  const rangePct = rankPercentile(scored.map(s => s.range));
  const ppdPct = rankPercentile(scored.map(s => s.ppd));
  const uniqPct = rankPercentile(scored.map(s => s.uniqueness));
  const structurePct = rankPercentile(scored.map(s => s.structureScore));
  const stackFieldPct = rankPercentile(scored.map(s => s.stackFieldScore));
  const gameOverloadPct = rankPercentile(scored.map(s => s.gameOverloadScore));

  for (let i = 0; i < scored.length; i++) {
    const s = scored[i];
    s.projPct = projPct[i];
    s.ownPct = ownPct[i];
    s.rangePct = rangePct[i];
    s.ppdPct = ppdPct[i];
    s.uniqPct = uniqPct[i];
    s.structurePct = structurePct[i];
    s.stackFieldPct = stackFieldPct[i];
    s.gameOverloadPct = gameOverloadPct[i];

    let ev = params.wProj * s.projPct
      + params.wLev * (1 - s.ownPct)
      + params.wVar * s.rangePct * 0.85
      + params.wCmb * s.uniqPct
      + params.wStructure * s.structurePct
      + params.wStackField * s.stackFieldPct
      - params.wGameOverload * s.gameOverloadPct;

    if (s.ppdPct >= 1 - params.ppdTopPct) ev *= (1 - params.ppdPenalty);
    s.ev = ev;
  }

  return scored;
}

/**
 * Selection-only pipeline: takes pre-scored candidates (with .ev populated) and
 * runs the V1 band-fill + exposure/overlap selection. Exposed so V1-UpsideMax
 * and V1-WinningValue can re-use the selection logic with their own scoring.
 */
export function selectFromScoredTheoryLineups(
  scored: ScoredTheoryLineup[],
  candidatesCount: number,
  targetCount: number,
  params: TheoryV1Params,
): TheoryV1SelectionResult {
  let pool = scored.filter(s => s.primarySize >= params.minPrimaryStack);
  if (pool.length < targetCount) pool = scored;

  const highTarget = Math.round(targetCount * params.bandHighPct);
  const lowTarget = Math.round(targetCount * params.bandLowPct);
  const midTarget = targetCount - highTarget - lowTarget;

  const sortedHigh = [...pool].sort((a, b) => (b.projPct + b.ownPct) - (a.projPct + a.ownPct));
  const sortedLow = [...pool].sort((a, b) => ((1 - b.projPct) + (1 - b.ownPct)) - ((1 - a.projPct) + (1 - a.ownPct)));

  const selected: ScoredTheoryLineup[] = [];
  const exposure = new Map<string, number>();
  const teamStackCount = new Map<string, number>();
  const seen = new Set<string>();
  let relaxedOverlapAttempts = 0;

  const passes = (s: ScoredTheoryLineup, maxOverlap: number): boolean => {
    if (seen.has(s.lineup.hash)) return false;
    if (s.primarySize < params.minPrimaryStack) return false;

    for (const player of s.lineup.players) {
      const current = exposure.get(player.id) || 0;
      const cap = isPitcher(player) ? params.exposureCapPitcher : params.exposureCapHitter;
      if ((current + 1) / targetCount > cap) return false;
    }

    if (s.primaryTeam) {
      const current = teamStackCount.get(s.primaryTeam) || 0;
      if ((current + 1) / targetCount > params.teamStackCap) return false;
    }

    const ids = new Set(s.lineup.players.map(player => player.id));
    for (const alreadySelected of selected) {
      let overlap = 0;
      for (const player of alreadySelected.lineup.players) {
        if (ids.has(player.id)) overlap++;
      }
      if (overlap > maxOverlap) return false;
    }

    return true;
  };

  const add = (s: ScoredTheoryLineup): void => {
    selected.push(s);
    seen.add(s.lineup.hash);
    for (const player of s.lineup.players) {
      exposure.set(player.id, (exposure.get(player.id) || 0) + 1);
    }
    if (s.primaryTeam) {
      teamStackCount.set(s.primaryTeam, (teamStackCount.get(s.primaryTeam) || 0) + 1);
    }
  };

  const fillBand = (bandPool: ScoredTheoryLineup[], target: number): number => {
    const sorted = [...bandPool].sort((a, b) => b.ev - a.ev);
    let added = 0;
    for (const s of sorted) {
      if (added >= target) break;
      if (passes(s, params.maxPairwiseOverlap)) {
        add(s);
        added++;
      }
    }
    if (added < target) {
      relaxedOverlapAttempts++;
      for (const s of sorted) {
        if (added >= target) break;
        if (passes(s, params.maxPairwiseOverlap + 1)) {
          add(s);
          added++;
        }
      }
    }
    return added;
  };

  const highSelected = fillBand(sortedHigh.slice(0, Math.max(highTarget * 5, 200)), highTarget);
  const midSelected = fillBand(pool, midTarget);
  const lowSelected = fillBand(sortedLow.slice(0, Math.max(lowTarget * 5, 200)), lowTarget);

  let fallbackSelected = 0;
  if (selected.length < targetCount) {
    const sorted = [...pool].sort((a, b) => b.ev - a.ev);
    for (const s of sorted) {
      if (selected.length >= targetCount) break;
      if (passes(s, params.maxPairwiseOverlap + 1)) {
        add(s);
        fallbackSelected++;
      }
    }
  }
  if (selected.length < targetCount) {
    const sorted = [...pool].sort((a, b) => b.ev - a.ev);
    for (const s of sorted) {
      if (selected.length >= targetCount) break;
      if (passes(s, params.maxPairwiseOverlap + 2)) {
        add(s);
        fallbackSelected++;
      }
    }
  }

  const selectedSlice = selected.slice(0, targetCount);
  return {
    portfolio: selectedSlice.map(s => s.lineup),
    selected: selectedSlice,
    scored,
    diagnostics: {
      originalCount: candidatesCount,
      filteredCount: pool.length,
      targetCount,
      selectedCount: selectedSlice.length,
      highTarget,
      midTarget,
      lowTarget,
      highSelected,
      midSelected,
      lowSelected,
      fallbackSelected,
      relaxedOverlapAttempts,
    },
  };
}

export function selectTheoryV1Portfolio(
  candidates: Lineup[],
  targetCount: number,
  params: TheoryV1Params,
): TheoryV1SelectionResult {
  const scored = scoreTheoryV1Candidates(candidates, params);
  return selectFromScoredTheoryLineups(scored, candidates.length, targetCount, params);
}

export function summarizeTheoryPortfolio(
  selected: ScoredTheoryLineup[],
): TheoryPortfolioSummary {
  const n = selected.length;
  const lineups = selected.map(s => s.lineup);
  const stackCounter = new Map<string, number>();
  const exposure = new Map<string, {
    id: string;
    name: string;
    team: string;
    position: string;
    count: number;
    ownership: number;
    projection: number;
  }>();

  let primary4 = 0;
  let primary5Plus = 0;
  let bringBackGte1 = 0;
  let bringBackGte2 = 0;
  let naked5Plus = 0;
  let gameOverload8 = 0;

  for (const s of selected) {
    if (s.primaryTeam) stackCounter.set(s.primaryTeam, (stackCounter.get(s.primaryTeam) || 0) + 1);
    if (s.primarySize === 4) primary4++;
    if (s.primarySize >= 5) primary5Plus++;
    if (s.bringBack >= 1) bringBackGte1++;
    if (s.bringBack >= 2) bringBackGte2++;
    if (s.primarySize >= 5 && s.bringBack === 0) naked5Plus++;
    if (s.maxGameHitters >= 8) gameOverload8++;

    for (const player of s.lineup.players) {
      const current = exposure.get(player.id) || {
        id: player.id,
        name: player.name,
        team: player.team || '',
        position: player.position || '',
        count: 0,
        ownership: player.ownership || 0,
        projection: player.projection || 0,
      };
      current.count++;
      exposure.set(player.id, current);
    }
  }

  const pct = (count: number): number => n > 0 ? count / n : 0;
  const avgOwnershipSum = mean(lineups.map(lineup => lineup.players.reduce((sum, p) => sum + (p.ownership || 0), 0)));

  return {
    lineups: n,
    avgProjection: mean(lineups.map(lineup => lineup.projection || 0)),
    avgOwnership: mean(lineups.map(lineup => lineup.ownership || 0)),
    avgOwnershipSum,
    avgSalary: mean(lineups.map(lineup => lineup.salary || 0)),
    pctPrimary4: pct(primary4),
    pctPrimary5Plus: pct(primary5Plus),
    pctBringBackGte1: pct(bringBackGte1),
    pctBringBackGte2: pct(bringBackGte2),
    pctNaked5Plus: pct(naked5Plus),
    pctGameOverload8: pct(gameOverload8),
    uniquePlayers: exposure.size,
    stackCounts: Array.from(stackCounter.entries())
      .map(([team, count]) => ({ team, count, pct: pct(count) }))
      .sort((a, b) => b.count - a.count),
    topExposures: Array.from(exposure.values())
      .map(item => ({ ...item, pct: pct(item.count) }))
      .sort((a, b) => b.count - a.count),
  };
}

function normalizeTeam(team: string | undefined): string {
  return (team || '').trim().toUpperCase();
}

function buildPairTripleFreqs(candidates: Lineup[]): { pair: Map<string, number>; triple: Map<string, number> } {
  const pair = new Map<string, number>();
  const triple = new Map<string, number>();
  let totalWeight = 0;

  for (const lineup of candidates) {
    const weight = Math.max(0.1, lineup.projection || 1) ** 2;
    totalWeight += weight;
    const ids = lineup.players.map(player => player.id).sort();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key = ids[i] + '|' + ids[j];
        pair.set(key, (pair.get(key) || 0) + weight);
      }
      for (let j = i + 1; j < ids.length; j++) {
        for (let k = j + 1; k < ids.length; k++) {
          const key = ids[i] + '|' + ids[j] + '|' + ids[k];
          triple.set(key, (triple.get(key) || 0) + weight);
        }
      }
    }
  }

  if (totalWeight <= 0) return { pair, triple };

  for (const key of pair.keys()) pair.set(key, (pair.get(key) || 0) / totalWeight);
  for (const key of triple.keys()) triple.set(key, (triple.get(key) || 0) / totalWeight);
  return { pair, triple };
}

function buildTeamStackStrength(candidates: Lineup[]): Map<string, number> {
  const hittersByTeam = new Map<string, Map<string, Player>>();
  for (const lineup of candidates) {
    for (const player of lineup.players) {
      if (isPitcher(player)) continue;
      const team = normalizeTeam(player.team);
      if (!team) continue;
      if (!hittersByTeam.has(team)) hittersByTeam.set(team, new Map<string, Player>());
      hittersByTeam.get(team)!.set(player.id, player);
    }
  }

  const raw = new Map<string, number>();
  for (const [team, playerMap] of hittersByTeam) {
    const hitters = Array.from(playerMap.values())
      .sort((a, b) => (b.ownership || 0) - (a.ownership || 0));
    if (hitters.length < 4) {
      raw.set(team, -100);
      continue;
    }
    const top4 = hitters.slice(0, 4);
    const ownProduct = top4.reduce((product, player) => product * Math.max(0.001, (player.ownership || 0.1) / 100), 1);
    const projMean = mean(top4.map(player => player.projection || 0));
    raw.set(team, Math.log(ownProduct) + Math.log(Math.max(1, projMean)));
  }

  return raw;
}

function lineupDistribution(lineup: Lineup): { floor: number; ceiling: number } {
  let floor = 0;
  let ceiling = 0;
  for (const player of lineup.players) {
    if (player.percentiles) {
      floor += player.percentiles.p25 || player.projection * 0.85;
      ceiling += player.percentiles.p75 || player.projection * 1.15;
    } else {
      floor += player.projection * 0.85;
      ceiling += player.projection * 1.15;
    }
  }
  return { floor, ceiling };
}

function correlationAdjustment(structure: LineupStructure, params: TheoryV1Params): number {
  let corrAdj = 0;
  if (structure.primarySize >= 3) {
    corrAdj += params.stackBonusPerHitter * (structure.primarySize - 2);
  }
  if (structure.bringBack === 1) corrAdj += params.bringBack1;
  else if (structure.bringBack >= 2) corrAdj += params.bringBack2;
  corrAdj += params.pitcherVsHitterPenalty * structure.pitcherVsHitterCount;
  return corrAdj;
}

function comboUniqueness(
  lineup: Lineup,
  pairFreqs: Map<string, number>,
  tripleFreqs: Map<string, number>,
  tripleFreqCap: number,
): number {
  let uniqueness = 0;
  const players = lineup.players;
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const key = [players[i].id, players[j].id].sort().join('|');
      uniqueness += -Math.log(pairFreqs.get(key) || 1e-6);
    }
  }

  const tripleFreqList: number[] = [];
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      for (let k = j + 1; k < players.length; k++) {
        const key = [players[i].id, players[j].id, players[k].id].sort().join('|');
        tripleFreqList.push(tripleFreqs.get(key) || 1e-6);
      }
    }
  }

  tripleFreqList.sort((a, b) => b - a);
  for (const freq of tripleFreqList.slice(0, tripleFreqCap)) {
    uniqueness += -Math.log(freq);
  }
  return uniqueness;
}

function lineupLogOwnership(lineup: Lineup, scope: OwnershipScope): number {
  let logOwnership = 0;
  for (const player of lineup.players) {
    if (scope === 'hitters' && isPitcher(player)) continue;
    logOwnership += Math.log(Math.max(0.1, player.ownership || 0.5));
  }
  return logOwnership;
}

function lineupPpd(lineup: Lineup): number {
  let ppd = 0;
  for (const player of lineup.players) {
    if (player.salary > 0 && player.projection > 0) {
      ppd += player.projection / (player.salary / 1000);
    }
  }
  return ppd;
}

function structuralPriorScore(structure: LineupStructure): number {
  let score = 0;

  if (structure.primarySize >= 5) {
    if (structure.bringBack >= 2) score += 1.00;
    else if (structure.bringBack === 1) score += 0.65;
    else score += 0.25;

    if (structure.secondarySize >= 2) score += 0.10;
  } else if (structure.primarySize === 4) {
    if (structure.secondarySize >= 3) score += 0.90;
    else if (structure.secondarySize === 2) score += 0.70;
    else score += 0.35;

    if (structure.bringBack >= 1) score += 0.15;
  } else if (structure.primarySize === 3 && structure.secondarySize >= 3) {
    score += 0.30;
  }

  if (structure.pitcherVsHitterCount > 0) score -= 0.25 * structure.pitcherVsHitterCount;
  return score;
}

function gameOverloadPriorScore(structure: LineupStructure): number {
  if (structure.maxGameHitters >= 8) return 1;
  if (structure.maxGameHitters === 7) return 0.5;
  return 0;
}
