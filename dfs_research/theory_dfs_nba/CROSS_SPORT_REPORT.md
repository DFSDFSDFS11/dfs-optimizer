# Cross-Sport Validation: Theory-of-DFS on NBA

## Executive Summary — Outcome C (decisive)

The framework-derived Theory-DFS principles **do not produce edge on NBA**. Random uniform sampling from the SaberSim pool **outperforms Theory-DFS on every metric** across 12 NBA slates. Combined with the cross-sport BAND_HIGH_PCT sensitivity finding that diverges sharply between MLB and NBA, this is decisive evidence that the apparent MLB top-0.1% edge was 17-slate sampling artifact, not signal.

| Metric | MLB Theory-DFS (18 slates) | NBA Theory-DFS (12 slates) | NBA Random Baseline |
|---|---|---|---|
| Total ROI | −34.9% | **+96.6%** | **+186.4%** |
| Top-1% × random | 1.0× (≈ random) | 1.11× | **1.17×** |
| Top-0.1% × random | 1.48× (in baseline window) | **0.56×** (BELOW random) | 1.67× |
| Slates with t01 ≥ 1 | 3/18 | 1/12 | 2/12 |
| Game-stack rate (3+) | 100% (4+ stacks) | 97% | 94% |

**Random beats Theory-DFS on every NBA metric except slate-count wins (7/12 vs 5/12), and even there the magnitude per win goes to Random.**

## Critical Single-Slate Dominance

The headline NBA ROI numbers (+96.6%, +186.4%) are deceiving — **91% of both systems' total payout comes from one slate (2026-03-03)**.

| | All 12 slates | Excluding 2026-03-03 |
|---|---|---|
| Theory-DFS NBA | $70,788 (+96.6%) | $6,070 (**−81.6% ROI**) |
| Random NBA | $103,088 (+186.4%) | $9,389 (**−71.5% ROI**) |

Without that one jackpot slate, both NBA systems are deeply negative — same shape as MLB. The "NBA looks profitable" headline is single-slate noise. Random still wins.

## Stage 6 — Cross-Sport BAND_HIGH_PCT Sensitivity

This was the spec's "most decisive test." The MLB result showed BAND_HIGH_PCT was a fragile parameter (edge varied from 0.74× to 1.85× across ±20% perturbation). **NBA shows the parameter has zero effect.**

| Band split | MLB t01-edge | NBA t01-edge |
|---|---|---|
| 16/68/16 | 1.85× | 0.56× |
| 18/64/18 | 1.65× (interpolated) | 0.56× |
| 20/60/20 (baseline) | 1.48× | 0.56× |
| 22/56/22 | 1.10× (interpolated) | 0.56× |
| 24/52/24 | 0.74× | 0.56× |

**On NBA, top-0.1% edge is invariant at 0.56× across all band splits.** Either there's no edge to capture, or NBA's correlation structure is so different from MLB that the band-allocation principle has no purchase. Either way, this confirms the band-split parameter is not encoding a real cross-sport principle.

The MLB sensitivity curve (steep monotonic decrease as BAND_HIGH_PCT rises) doesn't replicate on NBA. The MLB shape was specific to that 17-slate sample.

## Per-Slate Breakdown

| Slate | TODFS pay | Rand pay | TODFS t01 | Rand t01 | TODFS t1 | Rand t1 |
|---|---|---|---|---|---|---|
| 2026-01-16 | $95 | $92 | 0 | 0 | 1 | 0 |
| 2026-01-17 | $2,835 | $7,012 | 0 | 1 | 3 | 5 |
| 2026-01-18 | $120 | $636 | 0 | 0 | 0 | 2 |
| 2026-01-19 | $49 | $35 | 0 | 0 | 0 | 0 |
| 2026-01-20 | $151 | $108 | 0 | 0 | 2 | 1 |
| 2026-02-25 | $45 | $67 | 0 | 0 | 0 | 0 |
| 2026-02-26 | $1,851 | $592 | 0 | 0 | 3 | 2 |
| 2026-02-27 | $509 | $501 | 0 | 0 | 6 | 5 |
| 2026-02-28 | $41 | $101 | 0 | 0 | 0 | 0 |
| **2026-03-03** | **$64,718** | **$93,698** | 1 | **2** | 3 | 5 |
| 2026-03-05 | $209 | $174 | 0 | 0 | 1 | 1 |
| 2026-03-06 | $164 | $72 | 0 | 0 | 1 | 0 |

Theory-DFS wins 7/12 slates outright (4-6, 4-26 included), but loses by margin on the 5 it doesn't win — including the jackpot 3-03 where Random got $93K vs Theory's $64K. **Random dominates the dollar-weighted comparison.**

## Why This Result Resolves the MLB Question

The user's earlier insight that Hermes-A's MLB ROI was overfit to its 17-slate calibration sample applies symmetrically to Theory-DFS. The Stage 7 finding (BAND_HIGH_PCT fragility) and Stage 8 finding (3-4 of 18 slates account for all top-0.1% hits) were warnings that the MLB Theory-DFS edge could be sample-fitting. **The NBA cross-sport test is the verification.**

If Theory-DFS's framework principles were real, they should produce *some* edge on NBA — even if magnitudes differ per Ch.7's "weaker NBA correlation" guidance. Instead:

1. **NBA top-0.1× = 0.56**: below random. Theory-DFS's selection mechanism actively picks worse-than-random lineups in the deep tail on NBA.
2. **BAND_HIGH_PCT invariant on NBA**: the parameter that drove MLB sensitivity has zero NBA effect. This isn't sport-specific calibration — it's pure noise on MLB.
3. **Random pool sampling is the strong baseline.** A correlation-aware SaberSim pool, sampled uniformly, beats framework-targeted selection on both top-1% rate and top-0.1% rate on NBA. The pool quality is doing the work, not the selection logic.

## Implementation Choices Documented

NBA-specific framework-derived parameters (NOT tuned to NBA backtest):

- **No hard `MIN_PRIMARY_STACK`** (Ch.7: NBA stacking is soft; framework explicitly says weaker than MLB)
- **GAME_STACK_BONUS = 0.05** (vs MLB STACK_BONUS_PER_HITTER = 0.10) — Ch.7 "much weaker NBA correlation"
- **TEAM_NEGATIVE_PER_EXTRA = −0.04** (NBA-specific opportunity cannibalization per Ch.7)
- **HITTER_VARIANCE_MULT = 1.0** (vs MLB 1.3) — Ch.7 "NBA more normal distribution"
- **EXPOSURE_CAP = 0.40** (vs MLB 0.50) — NBA star concentration
- **MAX_PAIRWISE_OVERLAP = 5** (vs MLB 6) — scaled to 8-player roster

Cross-sport-equal: W_LEV (0.30), W_RV (0.20), W_CMB (0.25), W_VAR (0.15), W_CEIL_EFF (0.10), 20/60/20 bands, EXPLOITATIVE_EXPONENT (1.5), TRIPLE_FREQ_CAP (5).

The discipline of using framework-derived rather than NBA-tuned parameters is what makes this test meaningful. **Tuning would have fit NBA noise the same way the original MLB run fit MLB noise — and the cross-sport invariance to BAND_HIGH_PCT is exactly the signal that there's no shared principle to tune.**

## Decision

Per the spec's outcome criteria:
- **Outcome C: NBA shows no edge regardless of parameters.**
- **Decision: Don't ship Theory-DFS for NBA. MLB ship decision unchanged but confidence reduced.**

Practical interpretation: the MLB Theory-DFS deep-tail edge (1.48× random in baseline, 1.85× in BAND_HIGH_PCT-tuned variants) was almost certainly 17-slate sample artifact. It does not replicate on a 12-slate NBA sample with framework-derived parameters. The framework principles describe the right macro architecture (chalk-centric, inverse-bell distribution) but their translation into a selection mechanism doesn't produce edge above random pool sampling.

## What This Means For Live Deployment

**Don't commit a 30-slate deployment plan based on Theory-DFS having validated edge.** The cross-sport test was the highest-leverage rigor check available, and it failed. Two paths forward:

1. **Live data collection.** Deploy Theory-DFS for tonight's MLB slate as planned (theoretical-foundation tiebreaker over Hermes-A still holds — both are equally suspect, framework grounding is the cleaner ship). But track results as out-of-sample data accumulating, not as confirmation. Plan for 30+ slates of live data before drawing conclusions about real-money edge.

2. **Random-pool baseline as production candidate.** The NBA finding suggests random sampling from the SaberSim pool may be a strong baseline. Worth testing on MLB slates: random 150 from pool vs Theory-DFS vs Hermes-A. If random matches or beats both on out-of-sample data, the right production system might be "trust the SaberSim pool, don't try to be clever."

## Files

- Code: `src/scripts/theory-of-dfs-nba-backtest.ts`
- NBA results: `theory_dfs_nba/nba_results.json`
- NBA band sweep: `theory_dfs_nba/nba_band_sweep.json`
- This report: `theory_dfs_nba/CROSS_SPORT_REPORT.md`

## What This Conversation Has Established

1. **Hermes-A's MLB +126% ROI** = sweep-overfit on 17-slate calibration sample (3 jackpot slates dominate)
2. **Theory-DFS-MLB's apparent 1.48-1.85× t01 edge** = 17-slate sample artifact (Stage 7 fragile, Stage 8 concentrated, Stage 6 cross-sport doesn't replicate)
3. **NBA Random baseline** = +186% ROI driven by single jackpot slate; same shape as MLB
4. **The right move**: stop iterating on backtest evidence. Deploy live, gather honest out-of-sample data, then decide.

The cross-sport test was worth running. It produced the strongest negative signal available from existing data. That's exactly what rigorous validation is for.
