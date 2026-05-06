# Theory-of-DFS — Complete Framework Implementation Report

## Implementation status

The full framework from Jordan/BlenderHD's "Theory of DFS for Advanced Players" is now operationalized to the extent possible from the SaberSim pool data. Coverage by chapter:

| Chapter | Status | Notes |
|---|---|---|
| Ch.2 Methodologies | foundational, n/a | Distributions over points-as-points reflected in floor/ceiling/range usage |
| Ch.3 The Edge | foundational, n/a | Top-heavy GPP assumption baked into archetype defaults |
| Ch.4 The Levers (3) | ✅ all 3 | projection (1A), correlation (1B: stack/BB/P-vs-H), leverage (1C: logOwnProd → percentile) |
| Ch.5 Relative Value | ✅ | salary inefficiency + ownership inefficiency + direct leverage |
| Ch.6 Combinatorics | ✅ | pair freq + triple freq with same-team multiplier; top-3 triple cap in selection |
| Ch.7 Archetypes (10) | ✅ all 10 surveyed | Active per-slate: Player Pool Size, High Score / Nuts gap. Player Distribution applied via hitter-variance multiplier in EV. Player Correlation in 1B. Position Scarcity reflected in salary tiers (1D). Contest Equity / Size / Format / Opponent Skill — assumed constants for backtest context. Optionality excluded per spec. |
| Ch.8 Portfolio Dynamics | ✅ | 20/60/20 variance bands, frequency optimization (target_exposure), diversification (overlap + triple-freq caps) |
| Ch.9 Exploits (10) | ✅ 7/10 operationalized; 3 documented as no-data | **#1 Projection fragility** (high-stdDev → +2pp own); **#2 Median-overweighting** (ceiling/median percentile in EV); **#4 PPD bias** (top-PPD +3pp own + lineup penalty); **#5 Insufficient randomness** (ultra-chalk lineup penalty); **#7 Clumping detector** (post-selection diagnostic); **#8 Hard-coded correlation misuse** (PPD-team 5-stack penalty); **#9 Sim-output meta-game** (Sim-Optimals +5pp own). **Not operationalizable from current data:** #3 Ownership fragility (needs manual ownership baseline corrections), #6 Excessive randomness (no exploit available, opponent-side weakness), #10 Sim combinatoric blindness (needs conditional probabilities). |
| Ch.10 Study and Review | ✅ | Finishing-percentile distribution emitted in report (inverse-bell vs bell shape detection) |

## Progression across 4 runs

| Run | Payout | ROI | Top-1% | Top-0.1% | Mahal | Slates won |
|---|---|---|---|---|---|---|
| 1. Baseline (soft stack) | $28,978 | −46.3% | 26 | 2 | 2.03 | 4/18 |
| 2. + Hard 4+ stack constraint | $43,399 | **−19.6%** | 27 | 5 | 2.38 | 6/18 |
| 3. + Path B (Ch.9 #2 #4 #9) | $36,137 | −33.1% | 21 | 4 | 2.20 | 7/18 |
| 4. + Full framework (#1 #5 #7 #8 + nuts gap) | $35,142 | −34.9% | 19 | 4 | 2.03 | 6/18 |
| **Hermes-A (frozen)** | **$122,211** | **+126.3%** | **41** | **5** | **1.22** | **14/18** |

**Single most impactful change: hard 4+ stack constraint** (+27pp ROI in run 2). Every framework addition after that has produced slight regressions on payout. The full-framework run is back to Mahalanobis 2.03 (matching baseline) — meaning the additional Ch.9 exploits pulled Theory-DFS *back* toward pro consensus on aggregate metrics, but didn't translate to payout because the specific tail-winning lineups Hermes-A finds aren't framework-prescribed.

## Ch.10 Finishing-percentile distribution

Both systems show **inverse-bell shape** (good GPP grinder pattern per Ch.10):

```
Decile      | top-1%  1-10%  10-20%  20-30%  30-40%  40-50%  50-60%  60-70%  70-80%  80-90%  90-100%
Theory-DFS  |    9%     9%    10%     9%     9%    11%     9%    11%    11%    12%
Hermes-A    |   12%    11%    10%    10%    10%     9%     9%    10%     9%    10%
```

- Theory-DFS shape: top 9.0%, mid 20.1%, bot 11.5% → **inverse-bell** ✓
- Hermes-A shape: top 12.1%, mid 18.8%, bot 9.6% → **inverse-bell** ✓

Both portfolios correctly avoid the "bell-shape mid-cash leak" the framework warns about. Hermes-A has a fatter top tail (12% vs 9%) which is exactly where its payout advantage comes from.

## Stage 8 LOO — full framework run

**Removing any single slate doesn't flip the comparison.** All 18 LOO permutations show Hermes-A winning. Even removing the 3 Hermes-jackpot slates (4-21, 4-22, 4-25-early) doesn't flip — Hermes still wins (−46% vs −56%). It now takes removing **4 specific slates** to flip, vs 3 in the Path B run. The full-framework version is *more* robust against Theory-DFS winning under removals.

## Why More Framework ≠ More Payout

The framework prescribes the *macro architecture* (chalk-centric, 88% projection ratio, 4+ stacks, inverse-bell distribution). Theory-DFS implements it correctly — verified by:
- 100% 4+ stack rate (matches Hermes-A's 99%)
- 0.881 projRatioToOptimal (matches Hermes-A's 0.882)
- Inverse-bell finishing distribution
- Pro-consensus chalk-centricness on most slates

But the framework is qualitative on *which specific lineups* to pick within that architecture. Hermes-A's `λ × comboFreq` mechanism — empirically tuned via 92K-config sweep on this exact 18-slate sample — surfaces specific lineup constructions that nail boom outcomes on 3 of these slates ($97K of its $122K). The framework's qualitative correlation/combinatoric/RV mechanics produce a structurally-correct portfolio but don't surface those specific tail-winners at the same rate.

The runs 3 and 4 made this concrete: **adding more framework exploits (#1, #2, #4, #5, #7, #8) past the stack constraint doesn't help on payout**. They make Theory-DFS more theoretically faithful, slightly improve Mahalanobis (back to 2.03), and shift the slate-by-slate wins around (run 3: Theory wins 7/18, run 4: 6/18) without lifting the total.

## Outcome

**C — Theory-DFS substantially worse than Hermes-A on this 18-slate sample, robustly.**

This holds despite the framework being implemented as completely as the source data permits (Ch.4–8 fully, Ch.7 archetypes #1, #2, #3, #4, #7 active, Ch.9 #1, #2, #4, #5, #7, #8, #9 implemented + #3, #6, #10 documented as no-data, Ch.10 distribution emitted).

## Final recommendation

Same as before: don't ship Theory-DFS as the production system on this sample's evidence. Three useful avenues outside this experiment:

1. **Hybrid 50/50 portfolio** (Theory-DFS + Hermes-A lineups) — Theory's lower variance dampens Hermes's swings; Hermes's tail-winners lift Theory's median.
2. **Theory-DFS as Hermes QA layer** — flag Hermes-A lineups that fail framework checks (extreme PPD-corner, ultra-chalk, sub-50% ceiling-efficiency, non-inverse-bell distribution).
3. **Out-of-sample validation** — run both on slates not used to calibrate Hermes-A. The current 18-slate sample has Hermes-A's sweep advantage baked in; only fresh slates can test "framework vs tuned bins" cleanly.

## Files

- Code: `src/scripts/theory-of-dfs-backtest.ts` (full framework, ~900 lines)
- Result JSONs (one per run):
  - `baseline_results.json` — soft stack
  - `stack_enforced_results.json` — hard 4+ stack
  - `pathB_results.json` — + Ch.9 #2 #4 #9
  - `full_framework_results.json` — + Ch.9 #1 #5 #7 #8 + Ch.7 nuts gap
  - `stage8_loo_results.json` — LOO data
- Reports (chronological):
  - `REPORT.md` (initial baseline)
  - `REPORT_v2.md` (stack fix)
  - `STAGE8_REPORT.md` (LOO)
  - `FINAL_REPORT.md` (Path B)
  - `COMPLETE_FRAMEWORK_REPORT.md` (this — full implementation)
- Framework source: `C:/Users/colin/dfs_theories/EXTRACT.md` + 9 chapter files

## Parameter manifest (final, all framework-implementing parameters)

```
Ch.4 Levers
  STACK_BONUS_PER_HITTER         0.10    framework Ch.7 illustrative
  BRINGBACK_1                    0.05    spec
  BRINGBACK_2                    0.08    spec
  PITCHER_VS_HITTER_PENALTY     -0.10    framework Ch.7 illustrative
  MIN_PRIMARY_STACK              4       impl (post-baseline structural fix)

Ch.5 Relative Value
  OWNERSHIP_EFFICIENCY_EXPONENT  0.5     spec
  DIRECT_LEVERAGE_BONUS          0.03    impl

Ch.6 Combinatorics
  PAIR_CORR_SAME_TEAM            1.5     spec
  PAIR_CORR_OPPOSING             0.7     spec
  PAIR_CORR_UNRELATED            1.0     spec
  TRIPLES_EVALUATED              3       spec

Ch.7 Archetypes
  HITTER_VARIANCE_MULT           1.3     spec
  PITCHER_VARIANCE_MULT          1.0     spec
  Player Pool Size               numTeams → variance_target & projection_floor (impl)
  High Score / Nuts              gap > 8% → +0.10 var; gap < 3% → -0.15 var (impl)

Ch.8 Portfolio Dynamics
  EXPLOITATIVE_EXPONENT          1.5     spec
  EXPOSURE_CAP_HITTER            0.50    spec
  EXPOSURE_CAP_PITCHER           0.60    spec
  BAND_HIGH/MID/LOW_PCT          20/60/20  spec ("maybe" per framework)
  MAX_PAIRWISE_OVERLAP           6       impl
  TRIPLE_FREQ_CAP                5       spec

EV weights
  W_PROJ                         1.0     impl normalization
  W_LEV                          0.30    spec
  W_RV                           0.20    spec
  W_CMB                          0.25    spec
  W_VAR                          0.15    spec
  W_CEIL_EFF                     0.10    Ch.9 #2

Ch.9 Exploits
  SIM_OPTIMALS_OWN_BUMP_PP       5.0     impl (#9)
  SIM_OPTIMALS_TOP_PCT           0.05    impl
  PPD_OWN_BUMP_PP                3.0     impl (#4)
  PPD_TOP_PCT                    0.10    impl
  PPD_LINEUP_PENALTY             0.10    impl (#4 lineup-level)
  PPD_LINEUP_TOP_PCT             0.10    impl
  FRAGILITY_OWN_BUMP_PP          2.0     impl (#1)
  FRAGILITY_TOP_PCT              0.10    impl
  ULTRA_CHALK_PLAYER_THRESHOLD   0.75    impl (#5)
  ULTRA_CHALK_LINEUP_MIN_COUNT   5       impl
  ULTRA_CHALK_PENALTY            0.05    impl
  PPD_STACK_PENALTY              0.05    impl (#8)
  Ch.9 #7 clumping detector      diagnostic only (gap > 8% → warning)
  Ch.9 #3 ownership fragility    not operationalized — no manual ownership baseline data
  Ch.9 #6 excessive randomness   no exploit available (opponent weakness, not edge)
  Ch.9 #10 sim combinatoric      not operationalized — no conditional probabilities in pool

Ch.10 Study and Review
  Finishing-percentile distribution → inverse-bell vs bell shape diagnostic in report
```
