# Pareto-Filter (V1-PF) Variant Test - Methodology Lock

**Locked at:** 2026-05-03
**Pre-registered.** No iteration. No sweep. Single binary-constraint variant.

## Empirical question

Prior 9 descriptive variants tested modifications to V1's selection scoring (W_LEV, W_CMB, stack bonuses, bring-back, no-correlation, etc.). All 9 produced null tournament-outcome findings. The forced concentration variant (V1-WSC) DEGRADED V1's tournament metrics rather than improving them.

This test investigates a different intervention angle: rather than modifying V1's selection scoring, **constrain the candidate pool itself** to Pareto-optimal lineups on the (projection, ownership) trade-off BEFORE V1's normal selection logic runs.

**Hypothesis:** V1 currently selects some Pareto-dominated lineups (other available lineups have both higher projection AND lower ownership). These dominated selections may drag down portfolio quality. Filtering to the Pareto frontier ensures all selections are non-dominated.

## Variant specification

**V1-PF** (V1 With Pareto-Filtered Candidate Pool).

V1-PF is V1 (V1-NoCorr settings = current production V1) with the following addition:

For each candidate lineup in the slate's pool:
1. Compute `(projection_sum, ownership_sum)` where:
   - `projection_sum` = sum of player projections in the lineup
   - `ownership_sum` = sum of player ownership percentages in the lineup
2. Compute the 2D Pareto frontier on `(projection_sum, ownership_sum)`.
3. Filter the candidate pool to the Pareto-optimal subset BEFORE V1's normal scoring + variance-band selection runs.

V1's correlation adjustments, EV scoring, exposure caps, band selection, and team-stack caps run unchanged on the filtered pool.

## Pareto definition (PRE-REGISTERED, 2D ONLY)

A lineup `L` is Pareto-optimal (on the frontier) if and only if:

> No other candidate lineup `L'` has BOTH `proj(L') >= proj(L)` AND `own(L') <= own(L)` with at least one strict inequality.

Equivalently: there is no `L'` that dominates `L` (better-or-equal on both dimensions and strictly better on at least one).

**Dimensions are PRE-REGISTERED at exactly two:**
- `projection_sum` (sum across all 10 players)
- `ownership_sum` (sum across all 10 players, raw ownership percent values, NOT geometric-mean log-own)

**No additional dimensions** (no salary, no ceiling, no leverage, no variance) may be added mid-test.

## Algorithm

Standard 2D Pareto frontier sweep:

1. Sort all candidates by `projection_sum` descending.
2. Initialize `min_own_seen = +infinity`.
3. Iterate through sorted candidates:
   - If `ownership_sum < min_own_seen`: mark as Pareto-optimal; update `min_own_seen = ownership_sum`.
   - Else: not on frontier (dominated by some earlier-iterated higher-projection lineup with lower-or-equal ownership).
4. Tie-handling on `projection_sum`: when multiple lineups have equal `projection_sum`, sub-sort by `ownership_sum` ascending. This ensures the lowest-ownership lineup at each unique projection level is kept; equal-projection equal-ownership duplicates are retained for downstream V1 deduplication via lineup hash.

This algorithm is O(N log N) and implements the strict-dominance definition above.

## Lineup count target

**N = 75 lineups** for V1-PF portfolios. (V1 baseline portfolios in the existing lineup dump are N=150; tournament metrics are compared as **per-lineup rates**, not absolute hit counts. Per-lineup rates are scale-invariant, so the comparison is valid.)

**No fallback if frontier < 75 lineups** — under-fill is acceptable and informative. We document under-fill rate explicitly.

V1's existing fallback behaviors inside `buildPortfolio` (relax MAX_PAIRWISE_OVERLAP) still apply within the filtered pool, but if the frontier itself contains < 75 lineups satisfying V1's hard constraints (MIN_PRIMARY_STACK, exposure cap, etc.), the portfolio under-fills rather than padding from non-frontier lineups.

## V1 hyperparameters preserved

All V1 hyperparameters are unchanged from the V1 baseline (V1-NoCorr settings, current production V1):

```
STACK_BONUS_PER_HITTER: 0
BRINGBACK_1: 0
BRINGBACK_2: 0
PITCHER_VS_HITTER_PENALTY: -0.10
MIN_PRIMARY_STACK: 4
W_PROJ: 1.0, W_LEV: 0.30, W_VAR: 0.15, W_CMB: 0.25
EXPOSURE_CAP_HITTER: 0.25, EXPOSURE_CAP_PITCHER: 0.55
TEAM_STACK_CAP: 0.20
BAND_HIGH_PCT: 0.20, BAND_MID_PCT: 0.60, BAND_LOW_PCT: 0.20
MAX_PAIRWISE_OVERLAP: 6
TRIPLE_FREQ_CAP: 5
PPD_LINEUP_PENALTY: 0.10, PPD_LINEUP_TOP_PCT: 0.10
```

## Holdout integrity

The 16 development slates are:

`4-8-26, 4-12-26, 4-17-26, 4-18-26, 4-21-26, 4-22-26, 4-23-26, 4-24-26, 4-25-26, 4-25-26-early, 4-26-26, 4-27-26, 4-28-26, 4-29-26, 5-2-26-main, 5-3-26`

The 8 holdout slates (`4-6-26, 4-14-26, 4-15-26, 4-19-26, 4-20-26, 5-1-26, 5-2-26, 5-2-26-night`) are NOT touched in this test. Their data is not loaded, summarized, or referenced. Per `slate_derived_research/HOLDOUT_LOCK.md`.

## Verification metrics (Stage 4)

Per slate:
1. **Frontier size**: how many lineups from the candidate pool lie on the Pareto frontier.
2. **Under-fill flag**: 1 if `frontier_size < 75` (or if V1-PF portfolio < 75 due to V1 hard constraints exhausting the frontier), else 0.
3. **Filter overlap with V1 baseline**: % of V1's 150 baseline lineups (from dump) that were on the Pareto frontier of the candidate pool. High = filter has minimal effect on what V1 was already picking; low = filter substantially changes the realized portfolio.

Output: `per_slate_frontier_size.csv`.

## Construction metrics (Stage 5)

Per slate, for both V1-PF and V1 baseline (V1 from dump):
- Band distribution (HP/HO, HP/LO, LP/HO, LP/LO using slate-relative median projection and median geo-mean ownership over the variant's portfolio)
- Stack-size distribution (% primary 5+, =4, =3, other)
- Bring-back rate (>= 1, >= 2)
- Mean salary used
- Mean ownership_sum (over portfolio lineups)
- Mean projection_sum (over portfolio lineups)
- Within-portfolio mean and max pairwise Jaccard
- Lineup-level mean Mahalanobis distance to dynamic per-slate pro consensus (using inverse covariance over [projRatioToOptimal, geoMeanOwnHit, primarySize, bringBack, salaryTotal])

Output: `construction_comparison.csv`.

## Tournament metrics (Stage 6)

Per slate, for both V1-PF and V1:
1. **Top-1% hit rate** (fraction of lineups in top 1% of contest field) with bootstrap 95% CIs (10K samples, seed=42).
2. **Top-0.1% hit rate**.
3. **Mean finishing percentile**.
4. **Inverse-bell ratio**.
5. **Per-slate ROI** (caveat: 16 slates is a small ROI sample).

**Per-lineup rate normalization is mandatory.** Top-1% rate = hits / numLineups. This is scale-invariant: V1 with 150 lineups and 5 hits has rate 3.33%; V1-PF with 75 lineups and 3 hits has rate 4.0%. Comparison is valid even when N differs.

Output: `tournament_comparison.csv`.

## Per-slate analysis + diagnostic (Stage 7)

Per slate, classify V1-PF vs V1:
- **helped**: V1-PF top-1% rate is > 50% above V1 top-1% rate.
- **hurt**: V1-PF top-1% rate is > 50% below V1 top-1% rate.
- **neutral**: otherwise.

Same classification on top-0.1% rate.

Output: count of slates in each category.

**Diagnostic characterization:**
- Lineups in V1's portfolio but Pareto-dominated (i.e., not in V1-PF's filtered pool): characterize by stack-size, band, common features.
- Lineups in V1-PF's portfolio but not in V1's portfolio: characterize the same way.

Identifies the trade-off the filter makes.

Output: `per_slate_outcomes.csv` and `filtered_lineup_diagnostics.md`.

## Bootstrap CI methodology

Cluster bootstrap on slates: at each of 10K iterations (seed=42, deterministic Mulberry32), sample 16 slates with replacement, sum hits and lineups across resampled slates, compute lift = (hits / lineups) / expected_rate. Take 2.5/97.5 percentiles for 95% CI.

## Verdict categories (FINDINGS.md, exactly ONE)

1. **Filter improves**: V1-PF top-1% / top-0.1% rate higher than V1 across most slates; bootstrap CIs separate. Construction improved or neutral. Architectural direction validated.
2. **Filter neutral**: Tournament rates statistically similar; CIs heavily overlap. V1's selections were already mostly Pareto-optimal.
3. **Filter degrades**: V1-PF tournament rates lower than V1; bootstrap CIs separate the wrong way. Dominated lineups were serving a function (likely combinatorial uniqueness in non-Pareto space).
4. **Mixed**: Results vary across slates without clear pattern. Insufficient evidence.

## Constraints

1. Single variant. No sweep over Pareto definitions.
2. Pre-registered Pareto definition: 2D on `(projection_sum, ownership_sum)` only.
3. Holdout sealed. 16 dev slates only.
4. Don't iterate. Mixed results = mixed result.
5. Document under-fill honestly rather than padding via fallback.
6. Bootstrap 95% CIs (10K samples, seed=42) on tournament rates.
7. No deployment recommendations issued from this test.
