# Theory-of-DFS vs Hermes-A — Final Report

Three iterations of Theory-DFS implementation, all evaluated on the same 18 MLB slates with identical Hermes-A baseline.

## Progression Across Runs

| Run | Payout | ROI | Top-1% | Top-0.1% | Mahal | Slates won |
|---|---|---|---|---|---|---|
| Baseline (soft stack bonus) | $28,978 | −46.3% | 26 | 2 | 2.03 | 4/18 |
| + Hard 4+ stack constraint | $43,399 | **−19.6%** | 27 | 5 | 2.38 | 6/18 |
| + Path B (Ch.9 #4 + #2) | $36,137 | −33.1% | 21 | 4 | 2.20 | **7/18** |
| **Hermes-A (frozen)** | **$122,211** | **+126.3%** | 41 | 5 | 1.22 | 14/18 |

The stack constraint was the single biggest improvement (+27pp ROI). Path B's PPD-bias and median-overweighting exploits added theoretical completeness but slightly regressed payout (−14pp). Top-0.1% hits doubled from baseline (2 → 4-5), but top-1% peaked at the stack-fix run.

## What Path B Actually Did

Adding Ch.9 #4 (PPD bias) + Ch.9 #2 (median-overweighting) shifted Theory-DFS:

- **More contrarian** at lineup level (PPD ownership bumps + PPD penalty pushed selection away from "knapsack-solution" lineups the field over-uses)
- **Boom-success rate up** (top-0.1% hits: 2 baseline → 4-5 with Path B), suggesting more lineups positioned to hit tail outcomes
- **Cash rate down** (top-1% hits: 27 stack-fix → 21 Path B), suggesting reduced consistency at mid-payout tiers
- **Slate-count wins up to 7/18** but smaller payouts per win

This is exactly the trade-off the framework predicts: chasing more tail variance increases boom potential at the cost of consistent cashing. The framework says this is correct GPP architecture for top-heavy contests. The specific 18-slate sample evidently rewards the cashier-consistency profile Hermes-A targets, not the boom-hunter profile Theory-DFS produces.

## Chapter Coverage After Path B

| Chapter | Coverage |
|---|---|
| Ch.4 Levers | ✅ all 3 (projection, correlation, leverage) |
| Ch.5 Relative Value | ✅ |
| Ch.6 Combinatorics | ✅ |
| Ch.7 Archetypes | ⚠️ Player Pool Size dynamic; others assumed (top-heavy GPP, 150-max, large field) |
| Ch.8 Portfolio Dynamics | ✅ (variance bands, frequency optimization, diversification) |
| Ch.9 Exploits | ⚠️ **3 of 10 implemented** (#2 median-overweighting, #4 PPD bias, #9 Sim-output) |

Still missing: #1 Projection fragility, #3 Ownership fragility, #5/6 randomness exploits, #7 Clumping detection, #8 Hard-coded correlation misuse, #10 Sim combinatoric blindness. Most of these would require external data signals or adversary modeling that the SaberSim pool doesn't expose.

## Stage 8 LOO — Path B Run

Same robust pattern as the stack-fix run:

- **All 18 single-slate removals**: Hermes-A still wins. Largest single-slate impact: removing 4-22-26 drops Hermes from +126% to +60% ROI; Theory still loses at −29%.
- **Drop 2 jackpots**: Hermes still wins (4-21+4-22: +13% vs −26%).
- **Drop 3 jackpots (4-21+4-22+4-25-early)**: Theory-DFS wins (−35% vs −46%).
- **Drop 4 slates**: Theory-DFS wins by larger margin.

The comparison is **not single-slate fragile**. It takes removing all 3 Hermes-jackpot slates simultaneously to flip the comparison. Per the spec's Stage 8 criterion, that means the gap is real, not outlier-noise.

## Why the Gap Persists

The macro structural metrics are nearly identical between systems:

| Metric (Path B run) | Theory-DFS | Hermes-A |
|---|---|---|
| projRatioToOptimal | 0.881 | 0.882 |
| ceilingRatioToOptimal | 0.896 | 0.907 |
| avgPlayerOwnPctile | 0.910 | 0.932 |
| 4+ stack rate | 100% | 99% |

Both portfolios are chalk-centric, both 4+ stacked, both ~88% projection ratio. The remaining gap lives in **per-slate lineup selection**:

- Hermes-A's `λ × comboFreq` mechanism (combo-leverage) consistently surfaces specific lineup constructions that nail tail outcomes on a few slates per cycle (4-21, 4-22, 4-25-early in this sample).
- Theory-DFS's framework-derived selection produces a structurally-faithful portfolio but doesn't surface those specific tail-winning lineups at the same rate.

The framework describes the *right macro architecture* and Theory-DFS implements it. But the specific selection mechanism that finds *which exact lineups* hit the boom outcomes is something Hermes-A learned empirically through 92K-config sweeping. This is information the framework's qualitative description doesn't encode.

## Honest Verdict

**Outcome C confirmed by Stage 8 LOO.**

The framework principles are correctly implemented and produce a portfolio that:
- Matches pros on macro structure (chalk-centric, 88% proj ratio, 100% stacked)
- Wins 7/18 slates by 1.5–4.5× margins where it wins
- Has lower per-slate variance (more consistent)

But Hermes-A wins:
- 11/18 slates outright
- By 100×+ on 3 specific jackpot slates
- Robustly across all single-slate removals
- By 1.16σ on Mahalanobis to pro consensus

## Recommendation

**Don't ship Theory-DFS as the production system.** The framework's principles are theoretically sound and correctly implemented, but on this 18-slate sample, Hermes-A's empirically-tuned selection mechanism captures more profit. The chapter-coverage gap (3/10 Ch.9 exploits) isn't the issue — Path B confirmed that adding more framework mechanisms doesn't close the gap.

**What might be worth trying** (not in scope for this experiment):

1. **Hybrid portfolio**: 50/50 mix of Hermes-A and Theory-DFS lineups. Theory-DFS's lower variance would dampen Hermes's swings; Hermes's tail-winning lineups would lift Theory's median.

2. **Theory-DFS as Hermes-A QA layer**: use Theory-DFS scoring to flag Hermes-A lineups that are framework-suspicious (e.g., extreme PPD-corner constructions, sub-50% ceiling-efficiency). Doesn't require shipping Theory-DFS as primary.

3. **Out-of-sample validation**: the entire comparison ran on 18 slates Hermes-A was sweep-tuned on. If newer slates become available, run both systems on those — that's the only way to test the "framework vs empirically-tuned bins" hypothesis cleanly.

## Files

- Code: `src/scripts/theory-of-dfs-backtest.ts` (single file, ~750 lines, all 3 runs supported by params)
- Result JSONs:
  - `theory_dfs_system/baseline_results.json` (soft stack)
  - `theory_dfs_system/stack_enforced_results.json` (hard 4+)
  - `theory_dfs_system/pathB_results.json` (+ Ch.9 #4 #2)
  - `theory_dfs_system/stage8_loo_results.json` (LOO data on stack-fix run)
- Reports:
  - `theory_dfs_system/REPORT.md` (initial)
  - `theory_dfs_system/REPORT_v2.md` (after stack fix)
  - `theory_dfs_system/STAGE8_REPORT.md` (LOO)
  - `theory_dfs_system/FINAL_REPORT.md` (this)
- Framework reference: `C:/Users/colin/dfs_theories/EXTRACT.md` + 9 chapter files

## Parameter Manifest (final)

All numerical choices documented as `framework:` (stated in source), `spec:` (from user's spec), or `impl:` (my choice).

```
Stage 1B Correlation:    stack +0.10/hitter (framework illustrative)
                          bringback 0.05/0.08 (spec)
                          P-vs-H -0.10 (framework illustrative)
Stage 1D Relative Value: own_eff_exp=0.5 (spec)
                          direct_lev_bonus=0.03 (impl)
Stage 1E Combinatorics:  same-team 1.5× (spec) opposing 0.7× (spec) triples=top-3 (spec)
Stage 1F Archetypes:     hitter_var=1.3 pitcher_var=1.0 (spec)
                          slate-team-count → variance_target & projection_floor (impl)
Stage 2 EV weights:      proj=1.0 (impl) lev=0.30 rv=0.20 cmb=0.25 var=0.15 ceil_eff=0.10 (spec/impl)
Stage 3A Frequency:      exploit_exp=1.5 (spec)
                          exposure caps 0.50/0.60 (spec)
Stage 3B Variance bands: 20/60/20 (spec; framework "maybe")
Stage 3C Diversification:max_overlap=6, triple_freq_cap=5
Hard constraint:         min_primary_stack=4 (impl, post-baseline)
Ch.9 #9 Sim-Optimals:    top 5% +5pp own (impl)
Ch.9 #4 PPD bias:        top 10% +3pp own + top 10% lineup penalty 10% (impl)
Ch.9 #2 Median-overwt:   ceiling/median percentile weight 0.10 (impl)
```
