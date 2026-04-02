# DFS Optimizer CLI - Project Context

## Overview
Advanced DFS (Daily Fantasy Sports) lineup optimizer with game-theory based selection.

## Architecture
- `src/optimization/` - Branch & bound lineup generation
- `src/selection/selector.ts` - Main selection engine with all scoring/simulation
- `src/scoring/export.ts` - CSV export functions
- `src/types/index.ts` - TypeScript interfaces
- `src/rules/` - Contest configs and constraints

## Key Features Implemented

### Game Theory Scoring System
1. **Expected Finish Position Distribution** - Simulates finish positions across GPP structures
2. **Ceiling Correlation Matrices** - Tracks player boom correlations
3. **Field Distribution Reconstruction** - Models opponent lineup archetypes
4. **Kelly-Based Exposure Sizing** - Bankroll-optimal exposure levels
5. **Game Script Scenario Trees** - Non-linear projection adjustments by game state

### Advanced Simulation Engine
- **Correlated Player Outcomes** - Game-level (std=0.15) and team-level (std=0.10) correlation factors
  - Teammates correlate positively (shared game environment)
  - Same-game players correlate (pace, OT potential)
  - Enables realistic game stack evaluation
- **Field Reconstruction** - Synthetic opponent lineups (70% chalk, 20% balanced, 10% contrarian)
- **Tournament Simulation** - Monte Carlo with 1000+ iterations per lineup
- **Portfolio Simulation** - Evaluates 5000-lineup portfolio against 20K field lineups

### Elite Selection System
- **Two-Gate Qualification**: Core metrics + Simulation metrics
- **Adaptive Thresholds**: Auto-adjusts to ensure minimum 500 lineups
- **Multi-Tier**: S/A/B/C tiers with minimum 500 elite pool
- **Multiplicative Core Formula**: Geometric mean prevents weak links

## Supported Sports
- **NBA** - DraftKings Classic (8 players) and Showdown (6 players)
- **NFL** - DraftKings Classic (9 players) and Showdown (6 players)
- **MMA** - DraftKings (6 fighters, all "F" position)

## Build & Run
```bash
npm run build
# NBA
node dist/run.js --input ./sabersim_dk.csv --sport nba --site dk --output ./dk_lineups.csv
# MMA
node dist/run.js --input ./sabersim_dk.csv --sport mma --site dk --output ./mma_lineups.csv --pool 10000
```

**Note**: For MMA, use smaller pool sizes (10K-20K) as the 26-player slate has fewer combinations.

## User Preferences
- Minimum 500 elite lineups for SaberSim export
- All exported lineups must be elite in ALL categories
- No exposure limits (GPP mode)

---

## Key Rules (learned from corrections)

### Proportional Ownership Filter (CRITICAL)
The core GPP principle: **As projection drops, ownership MUST drop proportionally.**

- Use **PRODUCT ownership** (multiply all player ownerships as decimals) - this represents probability the field builds that exact lineup
- **Baseline = MAX ownership among top 5% lineups**, NOT the optimal lineup's ownership
  - Why: The optimal (highest projection) lineup might be contrarian. Using it as baseline unfairly penalizes chalk lineups.
  - The baseline represents "full chalk" - what the chalkiest good lineup looks like
- **Rule**: If projection drops X%, normalized ownership must drop ≥X%
- **Normalize with geometric mean** (nth root of product ownership ratio) to make comparison fair across roster sizes
- Location: `src/selection/selector.ts` → `filterProportionalOwnership()`

### Small Slates (MMA, <35 players)
- Use 80 iterations (vs 50 for normal slates)
- Higher contrarian penalty (5.0 vs 1.5) to generate truly low-owned lineups
- Still enforce proportional filter, but use progressive relaxation if needed to hit 500 minimum
- Pool size: 50K is fine (not 10-20K as previously noted)

### Pool Generation Philosophy
**NO EXCLUSIONS** - all players available in all iterations:
- Projection iterations (find optimal lineups)
- Ownership-weighted iterations (lineups the field would build)
- Leverage iterations (penalize mid-owned, boost low-owned - NO EXCLUSIONS)
- Balanced iterations (projection + moderate ownership penalty)
- Contrarian iterations (ceiling blend + ownership penalty)

Pool retention uses **efficient frontier** - keeps lineups with best projection-to-ownership ratio.
The proportional filtering happens in the SELECTOR, not the pool generator.

### Common Mistakes to Avoid
1. **Don't use SUM ownership for proportional filter** - use PRODUCT
2. **Don't compare to optimal lineup's ownership** - compare to max ownership in top tier
3. **Don't disable proportional filter for small slates** - relax it progressively instead
4. **Don't EXCLUDE chalk players** - use them but pair with low-owned (different combinations)
5. **Don't cap individual player exposure below field** - we want SIMILAR exposure, DIFFERENT combos
6. **Don't fade good players** - Mitchell at 50% owned is still a great play, just pair him differently

---

## Bug Fixes Applied (Feb 2026)

### Critical Fixes

1. **Simulation Score Formula** (`tournament-sim.ts:872-878`)
   - **Problem**: Multipliers were too high (pFirst * 100), causing most lineups to cap at 1.0
   - **Fix**: Reduced multipliers (100→40, 10→5, 2→1.5, 0.5→0.3) for better differentiation

2. **Double-Weighted Simulation** (`selector.ts:271-277`)
   - **Problem**: Simulation score was added to totalScore redundantly
   - **Fix**: Removed additive simulation; it now only influences tier classification

3. **Pool Ownership Filter Used SUM** (`branch-bound.ts:600-602`)
   - **Problem**: Soft proportional filter used SUM ownership instead of PRODUCT
   - **Fix**: Now computes PRODUCT ownership for accurate field probability comparison

4. **Chalk Player Extraction Timing** (`branch-bound.ts:537-542`)
   - **Problem**: Checked `iter === 0 && optimalLineup` but optimalLineup wasn't set yet
   - **Fix**: Moved extraction to run AFTER iteration 0 results are collected

### High-Priority Fixes

5. **Exposure Check Denominator** (`selector.ts:1359`)
   - **Problem**: Used CONFIG.ELITE_MAX (5000) instead of actual targetCount
   - **Fix**: Added targetCount parameter; exposure constraints now scale correctly

6. **Leverage Used p99 Instead of p85** (`field-analysis.ts:625,629`)
   - **Problem**: Using ceiling99 overweighted high-variance risky players
   - **Fix**: Changed to prefer ceiling (p85) for expected upside, not tail risk

7. **Ownership Weight Floor Too High** (`branch-bound.ts:1068,1073`)
   - **Problem**: Floor of 1% artificially boosted very low-owned players
   - **Fix**: Changed floor from 1.0 to 0.5

### Code Quality

8. **Missing Braces in Swap Loop** (`tournament-sim.ts:628`)
   - **Problem**: `if (archetype !== 'chalk')` without braces before for loop
   - **Fix**: Added explicit braces for safety

### DraftKings Rule Enforcement (Feb 2026)

9. **Max Players Per Team** (`constraints.ts`, `branch-bound.ts`)
   - **Problem**: Lineups could have 5+ players from the same team, violating DK rules
   - **Fix**: Added `maxPlayersPerTeam: 4` to DK_NBA_CLASSIC config and enforced during:
     - Branch-bound search (pruning during construction)
     - Field-mimic construction
     - Random lineup construction
     - Final lineup validation

10. **Minimum Games Requirement** (`constraints.ts`, `branch-bound.ts`, `csv-parser.ts`)
    - **Problem**: Lineups could have all players from a single game, violating DK rules
    - **Fix**: Added `minGames: 2` to DK_NBA_CLASSIC config and enforced throughout:
      - Added `gameInfo` field to Player type (parsed from CSV "Game" or "Opponent" columns)
      - Validates lineups use players from at least 2 different games
      - Falls back to team-based game derivation if no explicit game column in CSV

11. **Missing Player Correlation in Simulation** (`tournament-sim.ts:128-240, 798-815`)
    - **Problem**: Player outcomes were sampled INDEPENDENTLY - no correlation between teammates or same-game players. This is fundamentally wrong for DFS because:
      - Teammates correlate (shared game environment, ball sharing, opponent foul trouble)
      - Same-game players correlate (pace, overtime potential, game script)
      - Game stacks couldn't benefit from correlated upside
    - **Fix**: Added `CorrelationFactors` interface and `generateCorrelationFactors()` function:
      - **Game factors** (std=0.15): High-scoring games boost ALL players in that game
      - **Team factors** (std=0.10): When a team is "hot", their players correlate
      - Combined factor applied to deviation from mean: `70% gameFactor + 30% teamFactor`
      - This creates realistic correlation (0.3-0.5) between same-game players
    - **Impact**: Portfolio E[ROI] improved from 19.9% to 33.5%

---

## GPP Optimization Overhaul (Feb 2026)

### Core Goal
**Maximize projection while minimizing ownership** - the fundamental GPP principle.

### Critical Fixes Applied

#### 1. Ownership Penalty Formula Changed to Multiplicative
**File:** `branch-bound.ts:174-175`

**Before (broken):**
```typescript
adjusted = projection - (ownership/100 * avgProj * multiplier)
// 40-proj chalk - 3 penalty = 37 pts
// 30-proj contrarian - 0.5 penalty = 29.5 pts → CHALK STILL WINS
```

**After (correct):**
```typescript
adjusted = projection * (1 - ownership/100 * multiplier)
// 40-proj at 50% owned * 0.75 = 30 pts
// 35-proj at 10% owned * 0.95 = 33.25 pts → CONTRARIAN WINS!
```

#### 2. Ownership Weight Was BACKWARDS
**File:** `selector.ts:44-54`

**Before (broken):** `ownershipScore: -0.06` (NEGATIVE weight)
- ownershipScore is inverted: low ownership = HIGH score (0.9)
- Negative weight meant low-owned lineups scored WORSE!

**After (correct):** `ownershipScore: 0.20` (POSITIVE weight)
- Low ownership (score=0.9) × 0.20 = +0.18 contribution
- High ownership (score=0.5) × 0.20 = +0.10 contribution
- Low-owned lineups now properly rewarded!

#### 3. Iteration Distribution Rebalanced for GPP
**File:** `branch-bound.ts:421-435`

**Before:** 50% ownership-weighted (chalk-heavy pool)
**After (NO EXCLUSIONS):**
- 4% projection (find optimal anchors)
- 4% ownership-weighted (field calibration only)
- 50% leverage (penalize mid-owned, boost low-owned - creates chalk+value combos)
- 12% balanced (moderate ownership penalty)
- 30% contrarian (ceiling blend + ownership penalty)

**Pool retention:** Efficient frontier keeps lineups with best projection/sqrt(ownership) ratio

#### 4. Contrarian Now Uses Ceiling Blend
**File:** `branch-bound.ts:536-546`

**Before:** Only applied ownership penalty → found low-owned trash
**After:** Ceiling blend (40%) FIRST, then ownership penalty → finds HIGH-CEILING low-owned players

#### 5. Removed Top 3% Projection Free Pass
**File:** `selector.ts:1403-1456`

**Before:** Lineups within 3% of optimal skipped all ownership checks
**After:** ALL lineups must justify their ownership level, even near-optimal

### Weight Configuration
```typescript
DEFAULT_WEIGHTS = {
  projectionScore: 0.25,   // Projection still matters most
  ownershipScore: 0.20,    // Low ownership now properly rewarded
  leverageScore: 0.20,     // Uniqueness vs field
  ceilingScore: 0.15,      // Boom potential
  varianceScore: 0.05,
  relativeValueScore: 0.05,
  valueLeverageScore: 0.05,
  salaryEfficiencyScore: 0.05,
}
```

### Penalty Multipliers (Multiplicative Formula)
- **Balanced:** 0.4 (normal) / 0.5 (small slates)
  - 30% owned → 12% reduction / 15% reduction
- **Contrarian:** 1.2 (normal) / 1.5 (small slates)
  - 30% owned → 36% reduction / 45% reduction

---

## Advanced GPP Enhancements (Feb 2026)

### 1. Value Leverage Score Re-Enabled
**File:** `selector.ts:532-534`, `field-analysis.ts:760-790`

Identifies "hidden gems" - players with high pts/$ value AND low ownership:
```typescript
const valueLeverageScore = calculateLineupValueLeverageScore(lineup, valueLeverageAnalysis);
```
- Lineups with 2+ hidden value players get 20% bonus
- Lineups with 1 hidden value player get 10% bonus
- Weight: 0.05 in totalScore

### 2. Contrarian Core Guarantee
**File:** `selector.ts:1031-1070`

Forces 2% of portfolio to be high-leverage lineups:
```typescript
const contrarianCoreTarget = Math.floor(targetCount * 0.02);
// Selection criteria:
// - Minimum 88% of optimal projection
// - Leverage score >= 0.65 (top 20% uniqueness)
// - Passes diversity check
```
Ensures contrarian representation even in projection-heavy portfolios.

### 3. Small Slate Penalty Calibration
Reduced aggressive multipliers that destroyed projection on small slates:
- Balanced: 0.8 → 0.5 (30% owned retains 85% of projection)
- Contrarian: 3.0 → 1.5 (30% owned retains 55% of projection)

### Key Metrics for GPP Success
1. **Projection** - Must be competitive (within 12-15% of optimal)
2. **Ownership** - Lower is better (geometric mean of player ownerships)
3. **Leverage** - Uniqueness vs field (pairwise contrarian scoring)
4. **Value Leverage** - High pts/$ + low owned = hidden gems
5. **Ceiling** - Upside potential for winning tournaments

---

## Leverage Optimization Overhaul (Feb 2026)

### Core Insight: Same Players, Different Combinations
**WRONG approach:** Fade chalk players entirely (reduce exposure below field)
**CORRECT approach:** Use the SAME good players as field, but in DIFFERENT combinations

The leverage comes from:
- **Similar exposure** to chalk players as field (Mitchell at ~50%, not 0%)
- **Different pairings** - chalk + low-owned instead of chalk + chalk
- **Unique 3/4/5-man cores** that field doesn't build

### Critical Rule: NO PLAYER EXCLUSIONS
Never exclude players from pool generation. All players should be available.
- Don't exclude Mitchell because he's 50% owned
- Don't exclude Allen because he's 48% owned
- Instead, penalize mid-owned SUPPORTING CAST to force unique combinations

### Efficient Frontier Pool Retention
**File:** `branch-bound.ts:720-790`

Mathematical approach replaces heuristic bucketing:

```typescript
// Efficiency score: projection per unit of ownership "cost"
const efficiencyScore = lineup.projection / Math.pow(avgOwnership, 0.5);

// Efficient frontier: lineups where no other has BOTH higher proj AND lower ownership
// Sort by ownership ascending, keep lineups that exceed max projection seen
for (const item of byOwnership) {
  if (item.lineup.projection > maxProjectionSeen) {
    efficientFrontier.push(item);
    maxProjectionSeen = item.lineup.projection;
  }
}
```

This directly optimizes for: **highest projection at each ownership level**

### Leverage Iteration Strategy (No Exclusions)
**File:** `branch-bound.ts:503-560`

Instead of excluding chalk, use ownership penalties on mid-owned players:

```typescript
// Penalize mid-owned (15-35%) to force chalk + low-owned pairings
// Stars (>35%) keep full projection - they're the anchors
// Low-owned (<15%) get BOOSTED to compete with mid-chalk
if (own > 0.15 && own <= 0.35) {
  multiplier = 0.75;  // 25% penalty for mid-chalk
} else if (own <= 0.15) {
  multiplier = 1.10;  // 10% BOOST for low-owned
}
```

### Chalk + Low-Owned Pairing Check
**File:** `selector.ts:1180-1220`

Instead of capping individual exposure, enforce lineup composition:

```typescript
// If lineup has chalk players, the REST must be low-owned
const chalkPlayers = players.filter(p => p.ownership > 35);
const nonChalkPlayers = players.filter(p => p.ownership <= 35);

if (chalkPlayers.length > 0) {
  const supportingAvgOwn = nonChalkPlayers.reduce(...) / nonChalkPlayers.length;
  // 1 chalk: supporting cast avg < 22%
  // 2 chalk: supporting cast avg < 18%
  // 3+ chalk: supporting cast avg < 15%
}
```

### Results Achieved
With efficient frontier + no exclusions:
- **Win rate: 54%** (up from 26% with wrong approach)
- **E[ROI: 276%**
- **All chalk players included** (Mitchell 62%, Allen 34%, etc.)
- **229 unique winning lineups**

### Key Learnings
1. **Don't fade chalk** - use them, just pair differently
2. **No exclusions** - all players available in all iterations
3. **Penalize mid-owned** - they're the "trap" plays that create field overlap
4. **Boost low-owned** - make them competitive with mid-priced options
5. **Efficient frontier** - mathematically optimal pool retention
6. **Combo uniqueness** - reject chalk-on-chalk pairings that match field

### Weight Configuration (Updated Feb 2026)
```typescript
DEFAULT_WEIGHTS = {
  // === CORE GPP METRICS (44% total) ===
  projectionScore: 0.12,       // Base projection quality
  ownershipScore: 0.20,        // POSITIVE: low ownership = high score = rewarded
  ceilingScore: 0.12,          // Boom potential for GPP upside

  // === DIFFERENTIATION METRICS (30% total) ===
  coreBonus: 0.15,             // Differentiated 3/4/5-man cores (MOST IMPORTANT)
  antiCorrelationScore: 0.08,  // Structural uniqueness vs field
  leverageScore: 0.07,         // Player-level uniqueness vs field

  // === SUPPORTING METRICS (26% total) ===
  varianceScore: 0.08,         // Upside variance
  simulationScore: 0.08,       // Sim-based win rate
  salaryEfficiencyScore: 0.06, // Cap utilization
  relativeValueScore: 0.02,    // Value relative to optimal
  valueLeverageScore: 0.02,    // Hidden gems (high value + low owned)
}
```

---

## Pool Generation & Combo Analysis Overhaul (Feb 2026)

### Problem Solved
Previous approach generated too few lineups (~16K) with imbalanced iterations (50% leverage, only 4% field-mimicking). Combo analysis was shallow and only used during selection, not as primary differentiator.

### Solution: Larger Pool + Deep Combo Analysis

#### 1. Pool Generation (100 iterations, 50K+ lineups)
**File:** `branch-bound.ts:421-525`

```typescript
// NEW iteration distribution (100 iterations total)
const NUM_ITERATIONS = isShowdown ? 20 : (isSmallSlate ? 120 : 100);

projectionIterations:  5%   // Find optimal anchors
fieldMimicIterations: 25%   // Build what field builds (ownership-weighted)
balancedIterations:   25%   // Projection + moderate low-own
leverageIterations:   30%   // Anti-chalk combinations
contrarianIterations: 15%   // Deep fades with ceiling
```

#### 2. Field-Mimic Construction
**File:** `branch-bound.ts:1210-1310`

New function generates ownership-weighted lineups to understand field behavior:
```typescript
function constructOwnershipWeightedLineup(pool, config, eligibilityMatrix) {
  // Weight by ownership^1.5 * projection^0.5 (ownership-heavy)
  // Creates lineups that look like what the field would build
  const weights = eligible.map(p =>
    Math.pow(Math.max(1, p.ownership || 1), 1.5) * Math.pow(p.projection, 0.5)
  );
}
```

#### 3. Deep Combo Analysis (3/4/5-man cores)
**File:** `field-analysis.ts:844-1030`

Analyzes FULL pool to identify differentiated cores - combos we have that field rarely uses:

```typescript
interface DifferentiatedCore {
  playerIds: string[];
  playerNames: string[];
  comboSize: number;          // 3, 4, or 5
  poolFrequency: number;      // How often we have this combo
  fieldFrequency: number;     // How often field has it
  frequencyGap: number;       // Our advantage
  avgProjection: number;
  differentiationScore: number;  // gap * projection quality * depth multiplier
}
```

**Depth multipliers** (deeper = more valuable):
- 3-man: 1.0x
- 4-man: 1.5x
- 5-man: 2.5x (defines nearly entire lineup)

**Low-ownership bonus**: Cores with avg ownership <15% get 1.5x, <25% get 1.2x

#### 4. Core Bonus Scoring
**File:** `selector.ts:640-720`

Lineups containing differentiated cores get bonus in selection:
```typescript
function calculateDifferentiatedCoreBonus(lineup, deepAnalysis) {
  // Check for cores at each depth
  // 5-man cores weighted 2.5x (most valuable)
  // 4-man cores weighted 1.5x
  // 3-man cores weighted 1.0x
  // Multi-core bonus for having multiple unique cores
}
```

### Expected Output
```
--- DEEP COMBO ANALYSIS ---
  Analyzing deep combos: 50000 pool vs 20000 field...
  Found 751 differentiated 3-man cores
  Found 1504 differentiated 4-man cores
  Found 2146 differentiated 5-man cores
  Top 3-man cores:
    SGA + Mitchell + Grant: pool 6.4% vs field 1.2% (gap 5.2%)
  Top 4-man cores:
    SGA + Mitchell + Grant + Wesley: pool 2.8% vs field 0.4% (gap 2.4%)
  Top 5-man cores:
    Murray + Sharpe + Grant + Hartenstein + Cissoko: pool 0.6% vs field 0.0%
```

### Results
- Pool size: 50K+ lineups (up from 16K)
- Portfolio win rate: 64%
- Portfolio E[ROI]: 351%
- Unique winning lineups: 265+

### Key Insight
A unique 5-man core means nearly the entire lineup is different from field. When it hits, we have massive leverage (often 10x+ more lineups with that combo than field).

---

## Leveraged Lineup Generation Tuning (Feb 2026)

### Goal
Generate more low-ownership/high-leverage lineups in the pool. Winning GPP lineups often come from lower projection tiers (e.g., 235 proj winner vs 254 top proj), so better representation of quality contrarian lineups is needed.

### Changes Made

#### Pool Generation (branch-bound.ts)

1. **Iteration Distribution Rebalanced**
   ```
   Before: 5% proj, 25% field-mimic, 25% balanced, 30% leverage, 15% contrarian
   After:  3% proj, 15% field-mimic, 20% balanced, 35% leverage, 27% contrarian
   ```
   Rationale: Only need a few projection iterations to find optimal anchors. Shift allocation to leverage (unique combos) and contrarian (low-owned upside).

2. **Aggressive Leverage Multipliers**
   ```
   Mid-chalk penalty (15-35% owned): 0.75 → 0.65 (35% penalty)
   Low-owned boost (<15%):           1.10 → 1.20 (20% boost)
   Very-low boost (<8%):             1.20 → 1.35 (35% boost)
   ```

3. **Heavier Contrarian Penalty**
   ```
   Normal slates: 1.0 → 1.3
   Small slates:  1.2 → 1.5
   ```
   At 1.3, a 30% owned player loses 39% projection (vs 30% currently).

4. **Increased Contrarian Ceiling Blend**
   ```
   Ceiling blend: 0.40 → 0.50 (50% ceiling weight)
   ```

5. **Relaxed Proportional Frontier Tolerance**
   ```
   Normal slates: 1.05 → 1.12
   Small slates:  1.15 → 1.25
   ```

#### Selection (selector.ts)

6. **Adjusted Tier Weights**
   ```
   Before: [0.35, 0.25, 0.18, 0.12, 0.07, 0.03]
   After:  [0.28, 0.22, 0.18, 0.15, 0.10, 0.07]
   ```
   More allocation to lower tiers where winning contrarian lineups live.

7. **Relaxed Diversity Thresholds**
   ```
   Before: [0, 0.15, 0.20, 0.25, 0.30, 0.35]
   After:  [0, 0.10, 0.15, 0.18, 0.22, 0.25]
   ```
   Lower tiers are already "different" by projection.

8. **Re-enabled leverageScore Weight**
   ```
   leverageScore:      0.00 → 0.08
   valueLeverageScore: 0.00 → 0.04
   ownershipScore:     0.36 → 0.32 (reduced to compensate)
   projectionScore:    0.20 → 0.18
   varianceScore:      0.18 → 0.12
   ```
   leverageScore measures uniqueness vs synthetic field (unique combos), not just low average ownership.

### Expected Results
- Leverage pool count: ~4500 → ~6000+
- Contrarian pool count: ~900 → ~2000+
- Tier 5-6 selection counts increased
- Lower average ownership in portfolio
- Projection average should stay >240

---

## Advanced Leveraged Lineup Generation (Feb 2026)

### Goal
Generate high-projection, high-ceiling, low-ownership lineups for GPP by:
1. Using ceiling RATIO (not just raw ceiling) to identify boom candidates
2. Detecting projection edge (where our proj differs from field's implied proj)

### Phase 1: Ceiling Ratio Boost

**File:** `branch-bound.ts`

#### Problem
The existing `applyCeilingBlend()` uses raw ceiling values. A player with 30 proj / 45 ceiling (1.5x ratio) has more boom potential than 35 proj / 42 ceiling (1.2x ratio), but they're treated similarly.

#### Solution: `applyCeilingRatioBoost()`
Boost players based on their ceiling-to-projection RATIO, incorporating BOTH p85 and p99 percentiles.

```typescript
function applyCeilingRatioBoost(
  players: Player[],
  boostFactor: number = 0.20,
  p99Weight: number = 0.4  // 60% p85 + 40% p99
): Player[] {
  // Calculate blended ceiling ratios using both p85 and p99
  const ratios = players.map(p => {
    const p85Ceil = p.ceiling || p.projection * 1.25;
    const p99Ceil = p.ceiling99 || p85Ceil * 1.15;
    const blendedCeil = p85Ceil * (1 - p99Weight) + p99Ceil * p99Weight;
    return blendedCeil / Math.max(1, p.projection);
  });

  // Calculate average ratio and boost above-average players
  const avgRatio = ratios.reduce((sum, r) => sum + r, 0) / ratios.length;
  return players.map((p, i) => {
    const ratioDiff = ratios[i] - avgRatio;
    const boost = 1 + ratioDiff * boostFactor;
    return { ...p, projection: p.projection * Math.max(0.8, Math.min(1.4, boost)) };
  });
}
```

**Formula breakdown:**
- `blendedCeil = p85 * 0.6 + p99 * 0.4` (configurable via p99Weight)
- `ratio = blendedCeil / projection`
- `boost = 1 + (ratio - avgRatio) * 0.20`
- Player with 1.45 ratio vs 1.35 avg gets: `1 + (0.10 * 0.20) = 1.02x` projection boost

#### Integration
Applied in **contrarian iterations** and **leverage iterations (strategyType < 7)**:
- Contrarian: `applyCeilingRatioBoost(pool.players, 0.20, 0.4)` → then ceiling blend → then variance
- Leverage: `applyCeilingRatioBoost(pool.players, 0.15, 0.5)` → then ceiling blend → then penalty

### Phase 2: Projection Edge Detection

**File:** `field-analysis.ts`

#### Problem
We don't detect when our projection differs from what the field expects. If a player is 8% owned but we project 35 pts, the field thinks they're ~25 pts. This GAP is exploitable edge.

#### Solution: `analyzeProjectionEdge()`
Uses linear regression of ownership vs projection to estimate field's expected projection at each ownership level.

```typescript
export interface ProjectionEdgePlayer {
  id: string;
  name: string;
  ourProjection: number;
  impliedProjection: number;
  projectionEdge: number;      // (our - implied) / implied
  normalizedEdge: number;      // 0-1 score where 1 = massive positive edge
  ownership: number;
}

export function analyzeProjectionEdge(players: Player[]): ProjectionEdgeAnalysis {
  // Linear regression: ownership -> expected projection
  // impliedProj = alpha + beta * ownership
  // Edge = (ourProjection - impliedProjection) / impliedProjection
}

export function calculateLineupProjectionEdgeScore(
  lineup: Lineup,
  edgeAnalysis: ProjectionEdgeAnalysis
): number {
  // Base score = average normalized edge across players
  // Bonus for 3+ high-edge players: +0.15
  // Bonus for 2 high-edge players: +0.10
}
```

**Edge interpretation:**
- `projectionEdge > 0.15`: Player is 15%+ higher than field expects → strong positive edge
- `projectionEdge < 0`: We project LOWER than field expects → negative edge

### Phase 3: Weight Configuration

**File:** `selector.ts`

Updated `DEFAULT_WEIGHTS` to include `projectionEdgeScore`:

```typescript
const DEFAULT_WEIGHTS: OptimizedWeights = {
  // === CORE GPP METRICS (72% total) ===
  projectionScore: 0.16,         // 0.18 → 0.16
  ownershipScore: 0.30,          // 0.32 → 0.30
  ceilingScore: 0.14,            // 0.16 → 0.14
  varianceScore: 0.12,           // unchanged

  // === DIFFERENTIATION METRICS (18% total) ===
  leverageScore: 0.08,           // unchanged
  projectionEdgeScore: 0.06,     // NEW: our proj vs field-implied proj
  valueLeverageScore: 0.04,      // unchanged

  // === SUPPORTING METRICS (10% total) ===
  salaryEfficiencyScore: 0.06,   // unchanged
  relativeValueScore: 0.04,      // unchanged

  // === DISABLED ===
  antiCorrelationScore: 0.00,
  simulationScore: 0.00,
};
```

### Expected Console Output
```
--- PROJECTION EDGE ANALYSIS ---
  Projection edge: avg 2.3%
    Top edge players: Sharpe, Cissoko, Wesley, Grant, Murray
```

### Expected Outcomes
- **Higher ceiling ratios** in portfolio (players with above-average boom potential)
- **Projection edge exploitation** (players where we project higher than field implies)
- **Maintained projection floor** (ceiling ratio boost doesn't help low-projection players)
- **Average projection should stay >238**
- **Average ownership should decrease**

---

## Dynamic Portfolio Overlap Penalty System (Feb 2026)

### Problem
Single players could dominate the portfolio with 66%+ exposure (e.g., Derrick White). Hard caps at 45% were too rigid and caused lineup selection to fail on small slates.

### Solution: Aggressive Quartic Penalty Curves
Replace hard caps with dynamic penalties that make high exposure progressively harder (but never impossible).

**File:** `src/selection/selector.ts` → `calculatePortfolioDiversity()`

### Design Principles
1. **No Hard Caps** - Removed the 45% hard cap entirely
2. **Aggressive Scaling** - Quartic (x^4) curves grow VERY fast at high exposures
3. **Combo-Aware** - Penalize 2/3/4-man combos, not just individual players
4. **Dynamic** - Penalty based on CURRENT selected portfolio, recalculated each selection

### Player Penalty Formula
```typescript
const EXPOSURE_PENALTY_START = 0.20;

if (exposure > EXPOSURE_PENALTY_START) {
  const x = exposure - EXPOSURE_PENALTY_START;

  // Quartic (x^4) - VERY aggressive at high exposures
  playerOverlapScore += Math.pow(x, 4) * 500;
  // Cubic (x^3) - Strong secondary curve
  playerOverlapScore += Math.pow(x, 3) * 100;
  // Quadratic (x^2) - Moderate curve
  playerOverlapScore += Math.pow(x, 2) * 20;
  // Linear (x) - Base penalty
  playerOverlapScore += x * 2;
}
```

**Penalty Behavior:**
| Exposure | Penalty Points | Diversity Impact |
|----------|----------------|------------------|
| 20%      | 0              | ~1.0 (no penalty) |
| 25%      | 0.25           | ~0.97 |
| 30%      | 2.1            | ~0.75 |
| 40%      | 21.5           | ~0.30 (significant) |
| 50%      | 76.6           | ~0.05 (nearly blocked) |
| 60%      | 214            | ~0.00 (effectively blocked) |

### Combo Penalties (Quartic Scaling)

**Pair Penalty (2-man combos):**
```typescript
const PAIR_THRESHOLD = 0.12;
if (freq > PAIR_THRESHOLD) {
  const x = freq - PAIR_THRESHOLD;
  pairOverlapScore += Math.pow(x, 4) * 800;
  pairOverlapScore += Math.pow(x, 3) * 150;
  pairOverlapScore += Math.pow(x, 2) * 30;
}
```

**Triple Penalty (3-man combos):**
```typescript
const TRIPLE_THRESHOLD = 0.06;
if (freq > TRIPLE_THRESHOLD) {
  const x = freq - TRIPLE_THRESHOLD;
  tripleOverlapScore += Math.pow(x, 4) * 1200;
  tripleOverlapScore += Math.pow(x, 3) * 250;
  tripleOverlapScore += Math.pow(x, 2) * 40;
}
```

**Quad Penalty (4-man combos) - NEW:**
```typescript
const QUAD_THRESHOLD = 0.04;
if (freq > QUAD_THRESHOLD) {
  const x = freq - QUAD_THRESHOLD;
  quadOverlapScore += Math.pow(x, 4) * 2000;
  quadOverlapScore += Math.pow(x, 3) * 400;
  quadOverlapScore += Math.pow(x, 2) * 50;
}
```

### Combined Diversity Formula
```typescript
// Reweighted: Player 30%, Pair 25%, Triple 25%, Quad 20%
return playerDiversity * 0.30 + pairDiversity * 0.25 + tripleDiversity * 0.25 + quadDiversity * 0.20;
```

### Tracking Maps Added
```typescript
const selectedPairs = new Map<string, number>();
const selectedTriples = new Map<string, number>();
const selectedQuads = new Map<string, number>();  // NEW
```

### Function Signature Updated
```typescript
function calculatePortfolioDiversity(
  lineup: Lineup,
  playerCounts: Map<string, number>,
  pairCounts: Map<string, number>,
  tripleCounts: Map<string, number>,
  quadCounts: Map<string, number>,  // NEW
  portfolioSize: number
): number
```

### Results
**Large slate (149 players, 7 games):**
- Max exposure: 52.2% (Kawhi Leonard) - down from 66%+
- Top 5 avg exposure: 39.6%
- 5000 lineups selected
- 695 lineups skipped for low diversity

**Small slate (44 players, 2 games):**
- Max exposure: 54.2% (DeMar DeRozan)
- 3896 lineups selected (limited by slate size)
- Strategic chalk fading: Mitchell 34.4% vs field 64.9%, Leonard 39.6% vs field 60.2%

### Key Benefits
1. **Natural diversity** - No artificial hard caps that break on small slates
2. **Soft ceiling ~50%** - Quartic penalty makes >50% exposure nearly impossible
3. **Combo diversity** - 4-man tracking prevents repetitive constructions
4. **Smooth degradation** - Penalties increase gradually, not cliff-edge rejections

---

## Projection-Ownership Tradeoff Scaling Fix (Feb 2026)

### Problem
Portfolio had a fundamental issue: **ownership did not scale down hard enough as projection dropped.** The optimizer was selecting mid-projection + high-ownership lineups (bad) and lower-projection + still-high-ownership lineups (terrible). Pros play either high-projection chalk OR low-projection/low-ownership contrarian — never mid-projection/high-owned.

5 root causes identified:
1. Ownership scoring was linear — gap too small to matter vs projection
2. Proportional ownership filter was nearly dormant (0.4 multiplier, 3% free pass)
3. Exposure caps were asymmetric (chalk 0.65 vs contrarian 0.50 — 50x harder for contrarian)
4. Contrarian sorting conflated ceiling with low ownership
5. No portfolio-level tier enforcement to prevent high-owned lineups in low-projection tiers

### Fix 1: Convex Ownership Scoring (HIGHEST IMPACT)
**File:** `src/selection/scoring/lineup-scorer.ts` → `calculateOwnershipScore()`

```typescript
// OLD: linear
return Math.max(0, Math.min(1, 1 - (geoMeanOwn / 100)));

// NEW: convex (squared)
const linearScore = Math.max(0, Math.min(1, 1 - (geoMeanOwn / 100)));
return linearScore * linearScore;
```

**Score mapping:**
| geoMean Own | Linear (old) | Convex (new) | Gap vs 10% (old → new) |
|-------------|-------------|-------------|----------------------|
| 10% | 0.90 | 0.81 | — |
| 20% | 0.80 | 0.64 | 0.10 → 0.17 |
| 30% | 0.70 | 0.49 | 0.20 → 0.32 |
| 40% | 0.60 | 0.36 | 0.30 → 0.45 |

With 0.22 weight, 30% vs 10% gap: `0.32 * 0.22 = 0.070` (was 0.044). Combined with interaction term (~0.08), effective gap reaches ~0.10 — enough to overcome a meaningful projection disadvantage.

### Fix 2: Tighter Proportional Ownership Filter
**File:** `src/selection/selector.ts` → `addLineup()` proportional ownership check

```typescript
// OLD:
const ownershipDropMultiplier = numGames <= 3 ? 0.25 : 0.4;
const passesOwnership = ownDropActual >= ownDropRequired || projDropPct < 0.03;

// NEW:
const ownershipDropMultiplier = numGames <= 3 ? 0.30 : 0.70;
const passesOwnership = ownDropActual >= ownDropRequired || projDropPct < (numGames <= 3 ? 0.02 : 0.015);
```

A 10% projection drop now requires 7% normalized ownership drop on normal slates (was 4%). Free pass shrinks to 1.5% (was 3%). Small slates use 0.30 multiplier and 2% free pass to avoid starving selection on tiny player pools.

### Fix 3: Reduced Exposure Cap Asymmetry
**File:** `src/selection/selector.ts` → `addLineup()` exposure cap section

On normal slates (5+ games), tighter archetype-differentiated caps:
```typescript
// OLD → NEW (5+ game slates)
chalk:      0.65 → 0.50
balanced:   0.60 → 0.48
leverage:   baseCap → 0.45
contrarian: 0.50 → 0.40
```

On small slates (<5 games), original caps preserved to avoid starving selection. The `slateRelaxation` factor (based on unique player count) is also applied to the exposure multiplier so low-owned players on small slates aren't over-capped.

**Key change:** The spread between chalk (0.50) and contrarian (0.40) narrows from 0.15 to 0.10. Players above ~14% ownership no longer all hit the same ceiling.

### Fix 4: Explicit Ownership Weight in Contrarian Sorting
**File:** `src/selection/selector.ts` → `sortByArchetype()`, contrarian case

```typescript
// OLD:
(a.ceilingScore || 0.5) * 0.40 + a.totalScore * 0.40 + a.projectionScore * 0.20

// NEW:
a.ownershipScore * 0.30 + (a.ceilingScore || 0.5) * 0.25 + a.totalScore * 0.25 + a.projectionScore * 0.20
```

Ownership becomes #1 factor in contrarian ranking (30% direct weight). With convex scoring, 10% geoMean lineup gets `0.81 * 0.30 = 0.243` vs 30% geoMean at `0.49 * 0.30 = 0.147` — decisive 0.096 gap.

### Fix 5: Portfolio-Level Projection-Ownership Tier Enforcement
**File:** `src/selection/selector.ts` → `selectWithDiversity()` / `addLineup()`

New tracking arrays after `selectedQuints`:
```typescript
const tierOwnershipSums = [0, 0, 0, 0, 0];
const tierCounts = [0, 0, 0, 0, 0];
```

After 500 lineups (warm-up), each projection tier's avg ownership is enforced:
```typescript
if (selected.length >= 500) {
  const projPct = projRange > 0 ? (maxProj - lineup.projection) / projRange : 0;
  const tier = Math.min(4, Math.floor(projPct * 5));
  if (tierCounts[tier] >= 20) {
    const tierAvgOwn = tierOwnershipSums[tier] / tierCounts[tier];
    if (prodOwn > tierAvgOwn * 1.20) { /* reject */ }
  }
}
```

After selection, tier tracking updated:
```typescript
const projPctForTier = projRange > 0 ? (maxProj - lineup.projection) / projRange : 0;
const lineupTier = Math.min(4, Math.floor(projPctForTier * 5));
tierOwnershipSums[lineupTier] += prodOwn;
tierCounts[lineupTier]++;
```

Self-reinforcing: as low-ownership lineups enter lower tiers, the tier average drops, making it harder for high-owned lineups to enter. Ensures ownership monotonically decreases as projection drops.

### Results (2-game slate, 43 players)
- 2,195 lineups selected (limited by small slate diversity)
- Avg projection: 258.38
- Ownership filter rejections: 7,958 (working much harder than before)
- Key exposure changes vs field:
  - Mitchell: 65% us vs 77% field (faded)
  - Grant: 48% vs 61% field (big fade)
  - Ty Jerome: 51% vs 17% field (3x leverage)
  - Nique Clifford: 41% vs 15% field (2.8x leverage)
  - KCP: 37% vs 7% field (5x leverage)
- Archetype distribution: chalk 23, balanced 390, leverage 1564, contrarian 218

### Small Slate Considerations
- Fix 3 exposure caps only tightened on 5+ game slates (`tightenCaps = numGames >= 5`)
- Fix 2 uses relaxed multiplier (0.30 vs 0.70) and wider free pass (2% vs 1.5%) for ≤3 games
- Fix 5 tier enforcement starts at 500 lineups — on tiny slates it may not activate
- `slateRelaxation` factor applied to exposure multiplier to prevent over-capping on small player pools

### What Was NOT Changed
- `optimized_weights.json` — weights are fine; problem was the scoring FUNCTION shape
- `calculateGeometricMeanOwnership()` — geoMean is correct metric
- Quartic penalty coefficients in `calculatePortfolioDiversity()` — well-tuned
- `branch-bound.ts` — pool generation already produces low-owned lineups; the selection system was failing to retain them