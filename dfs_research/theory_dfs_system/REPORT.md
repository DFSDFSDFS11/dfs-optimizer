# Theory-of-DFS vs Hermes-A — Head-to-Head Backtest Report

**Status:** Stages 1–6 complete. Stage 7 (parameter sensitivity) and Stage 8 (LOO cross-validation) deferred pending review.

## Executive Summary

**Outcome: C — Theory-DFS substantially worse than Hermes-A on payout.**

| Metric | Theory-DFS | Hermes-A | Winner |
|---|---|---|---|
| Total backtest payout | $28,978 | $122,211 | Hermes-A |
| Total ROI (vs $54k fees) | −46.3% | +126.3% | Hermes-A |
| Top-1% lineup hits | 26 | 41 | Hermes-A |
| Top-0.1% lineup hits | 2 | 5 | Hermes-A |
| Mean Mahalanobis to pro consensus | 2.03 | 1.22 | Hermes-A |
| Slates with closer Mahalanobis | 1/18 | 17/18 | Hermes-A |
| Slates won on payout | 4/18 | 14/18 | Hermes-A |
| Per-slate payout std | $3,752 | $11,959 | (Theory more consistent) |

The gap is wide enough that this is not noise from a couple of lucky slates: even excluding the two slates where Hermes-A had jackpot paydays (4-21-26 and 4-22-26), Hermes-A still wins **12/16** slates and posts +12.7% ROI vs Theory-DFS's −41.1%.

Per the spec's decision criteria, this is Outcome C — investigate before shipping.

## What's Counterintuitive — and What Diagnoses the Gap

The two systems land on **virtually identical macro metrics**:

| Universal metric | Theory-DFS mean | Hermes-A mean | Pro-consensus target |
|---|---|---|---|
| projRatioToOptimal | 0.883 | 0.882 | ~0.90 |
| ceilingRatioToOptimal | 0.905 | 0.907 | ~0.91 |
| avgPlayerOwnPctile | 0.929 | 0.932 | ~0.94 |
| ownStdRatio | 6.04 | 6.64 | varies |
| ownDeltaFromAnchor | −7.98 | −7.63 | varies |

Both portfolios are **chalk-centric** (avg player ownership percentile ~0.93), both **sacrifice ~12% of optimal projection**, both have similar ceiling profiles. So the framework principles produce the right macro pattern. Yet Mahalanobis is still 0.81σ worse for Theory-DFS — meaning per-slate alignment to pros is worse, even though slate-aggregate alignment matches.

**The smoking gun is at the lineup-construction level.** Hermes-A produces a 4+ hitter primary stack in **99%** of its 150 lineups. Theory-DFS only does so in **56%**.

| | 4+ stacks | 3-or-scattered |
|---|---|---|
| Hermes-A (across all 18 slates × 150 = 2,700 lineups) | 2,676 (99%) | 24 (1%) |
| Theory-DFS | 1,508 (56%) | 1,192 (44%) |

This is the framework's "exposures don't matter, lineups do" principle (Ch.8) playing out. Same exposures and same macro metrics → wildly different per-slate payouts because **the ~44% of Theory-DFS lineups that aren't 4+ stacked are dead weight** — they can't hit the boom outcomes needed to win GPPs.

The 44% comes mostly from the 20% "low" variance band (low-proj/low-own contrarian). The framework Ch.8 says contrarian lineups should have stacks of unowned teams; the SaberSim pool we used as candidate space has limited representation of low-projection 5-stacks of low-owned teams, so the band fills with naturally weak-stacked spread lineups.

## Implementation Summary

Code: `src/scripts/theory-of-dfs-backtest.ts` (~700 lines, single file).

Framework chapters operationalized:
- **Ch.4 Levers** — projection (1A), correlation (1B: stack/bring-back/P-vs-H), leverage (1C: log-ownership-product → slate-relative percentile)
- **Ch.5 Relative Value** — salary inefficiency + ownership inefficiency + direct leverage (1D)
- **Ch.6 Combinatorics** — pair- and triple-frequency vs field equilibrium (1E)
- **Ch.7 Archetypes** — per-slate variance target & projection floor based on slate size (1F)
- **Ch.8 Portfolio Dynamics** — variance bands (20/60/20) + frequency optimization + greedy selection with overlap/exposure/triple-freq caps
- **Ch.9 Exploits** — Sim-Optimals ownership adjustment (top-5% players +5pp ownership)

Hermes-A used as canonical config (λ=0.58, γ=5, tc=0.26, mps=4, me=0.21, mep=0.41, corner=on, comboPower=4, bins 50/30/20/0/0, N=150).

## Explicit Parameter Choices (for Stage 7 reference)

Every numerical choice in the Theory-DFS implementation is documented inline in `TODFS_PARAMS` with one of three labels:

- **framework:** stated in source (e.g., `STACK_BONUS_PER_HITTER = 0.10` — Ch.7 "let's say MLB hitter-hitter ≈ 10%", illustrative)
- **spec:** from user's Theory-DFS implementation spec
- **impl:** my implementation choice where neither framework nor spec specified a value

Notable framework-vs-spec gaps surfaced during implementation:
1. The framework names **3 levers** (projection, correlation, leverage). The spec lists relative value as a 4th lever. RV is actually a *mechanic under leverage* per Ch.5. Implementation kept them as separate scoring functions per the spec but documented this.
2. The framework Ch.8 presents **20/60/20 as illustrative** ("maybe 20… 60 you may scale any way you see fit"). The spec hardcodes 20/60/20. Implementation used spec value.
3. The framework gives **no formula for the projection-vs-ownership trade rate**. Ch.4 explicitly says it "can be exceedingly difficult to measure accurately." The spec's `ownership_efficiency_exponent=0.5` is one reasonable interpretation; impl used spec.
4. The framework's `correlation_adjustment` (Ch.4 EV formula) is **qualitative**; impl uses linear-in-stack-size (10% per hitter above 2). An alternative interpretation is quadratic-in-pairs (10% × C(n,2)) which would dramatically over-weight 5-stacks.

## Per-Slate Breakdown

| Slate | TODFS pay | HermA pay | TODFS t1 | HermA t1 | TODFS mhl | HermA mhl |
|---|---|---|---|---|---|---|
| 4-6-26 | $938 | $1,062 | 4 | 2 | 0.68 | 0.71 |
| 4-8-26 | $155 | $128 | 0 | 0 | 2.44 | 0.57 |
| 4-12-26 | $712 | $679 | 4 | 2 | 0.88 | 0.78 |
| 4-14-26 | $146 | $459 | 0 | 2 | 2.92 | 2.88 |
| 4-15-26 | $98 | $284 | 0 | 0 | 1.20 | 1.20 |
| 4-17-26 | $165 | $174 | 1 | 0 | 3.70 | 2.71 |
| 4-18-26 | $857 | $2,323 | 1 | 3 | 4.37 | 1.17 |
| 4-19-26 | $549 | $528 | 1 | 1 | 1.60 | 0.64 |
| 4-20-26 | $28 | $44 | 0 | 0 | 1.85 | 1.21 |
| 4-21-26 | $656 | **$27,386** | 1 | 3 | 1.05 | 1.04 |
| 4-22-26 | $73 | **$40,711** | 0 | 3 | 1.70 | 0.30 |
| 4-23-26 | $69 | $1,662 | 0 | 3 | 1.45 | 0.95 |
| 4-24-26 | $133 | $202 | 1 | 1 | 2.05 | 0.72 |
| 4-25-26 | $6,695 | $8,720 | 2 | 2 | 3.44 | 1.48 |
| 4-25-26-early | $423 | $29,788 | 2 | 2 | 1.91 | 1.85 |
| 4-26-26 | $1,130 | $2,663 | 1 | 4 | 1.70 | 1.67 |
| 4-27-26 | $15,834 | $3,452 | 5 | 9 | 1.23 | 0.84 |
| 4-28-26 | $317 | $1,947 | 3 | 4 | 2.34 | 1.29 |

Theory-DFS won 4 slates: 4-6, 4-8, 4-12, 4-27.

## Stage 6 — Decision

**Per the spec's outcome criteria: Outcome C.**

Decision: **investigate before shipping**, with the specific failure mode being:

> Theory-DFS produces correct macro-portfolio metrics (chalk-centric, ~88% projection ratio, ~0.93 ownership percentile — matching pros) but only 56% of its lineups are 4+ stacked, vs 99% for Hermes-A. The 44% sub-stacked lineups carry portfolio-level variance load (the variance-band 20/60/20 split) but lack the boom potential to cash. Per Ch.8 "exposures don't matter, lineups do" — same macro exposures, different lineup constructions, different payouts.

## Why This Is Not Necessarily a Verdict on the Framework

A few caveats worth flagging:

1. **The Hermes-A baseline is itself overfit to this 17-slate sample.** It was selected from a 92K-config sweep precisely because it minimizes Mahalanobis distance on these slates. So the comparison is "framework-faithful Theory-DFS" vs "best-of-92K Hermes-A on this exact sample." The fair comparison would be Theory-DFS vs a NON-cherry-picked Hermes baseline, or Theory-DFS vs Hermes on out-of-sample slates.

2. **Two outlier slates account for 71% of the gap** (4-21 + 4-22 contribute $66K of the $93K Hermes advantage). With 17 slates and one slate sometimes paying 100× another, single-slate variance dominates. Stage 8 LOO cross-validation would directly test this.

3. **The "stack rate" gap is fixable in implementation.** The framework's correlation lever was implemented as a soft +10%-per-hitter bonus — faithful to Ch.7's "let's say 10%" but loose enough that low-proj/low-own contrarian lineups (which the variance-band split actively recruits) often slip in without 4+ stacks. Adding a hard `minPrimaryStack=4` constraint would close most of this gap. Doing so is **not** parameter-tuning the levers — it's enforcing a structural requirement the framework's correlation lever implies for MLB but doesn't formally state.

4. **Stage 7 sensitivity not yet run.** Given the size of the gap (Mahalanobis 0.81σ apart, ROI 173pp apart), I predict ±20% perturbations on the explicit parameters would not flip the comparison — the result is likely robust. But the user's spec explicitly emphasized Stage 7 as the rigor check, and that's still pending.

## Files

- Code: `C:/Users/colin/Projects/dfs-optimizer/src/scripts/theory-of-dfs-backtest.ts`
- JSON results: `C:/Users/colin/dfs opto/theory_dfs_system/baseline_results.json`
- This report: `C:/Users/colin/dfs opto/theory_dfs_system/REPORT.md`
- Framework reference (extracted from Jordan/BlenderHD doc): `C:/Users/colin/dfs_theories/EXTRACT.md`
- Per-chapter source files: `C:/Users/colin/dfs_theories/ch02_*.md` through `ch10_*.md`

## Recommended Next Steps (in order of expected information value)

1. **Add `minPrimaryStack=4` hard constraint** and re-run baseline. This is a structural fix, not a parameter tune. Expected effect: close ~60% of the payout gap based on the 99% vs 56% stack-rate delta.
2. **Run Stage 8 LOO cross-validation** (17 backtests). Will reveal whether the comparison is dominated by 1–2 outlier slates or holds slate-by-slate. ~10 min compute.
3. **Run Stage 7 parameter sensitivity** (~24 backtests). With current implementation, expected outcome is "comparison holds under ±20% perturbations" — confirming the gap is real, not parameter-noise.
4. **Run Theory-DFS on out-of-sample slates** (newer slates not used to calibrate Hermes-A). This is the only way to escape the "both systems share validation data" problem the user flagged.
