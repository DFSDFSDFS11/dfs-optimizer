# SELECTION — Stage 5

**Date:** 2026-05-03.
**Selection rule (PRE-COMMITTED in Stage 2E):**
  1. Primary: number of benchmarks passed at Stage 4 dev thresholds.
  2. Qualification gate: ≥4 of 5 benchmarks.
  3. **If 0 or 1 formulation passes ≥4 ⇒ STOP. Negative finding. Stage 6 NOT executed.**
  4. If exactly 1 passes ≥4: that formulation proceeds to Stage 6.
  5. If 2 or 3 pass ≥4: tiebreakers (Mahal → fingerprint → compute) on dev only.

## Result

| Formulation | # Benchmarks Passed | Qualifies (≥4)? |
|-------------|---------------------|-----------------|
| A           | 2/5                 | No              |
| B           | 0/5                 | No              |
| C           | 2/5                 | No              |

**ZERO formulations pass ≥4 of 5 benchmarks at the pre-registered Stage 2D dev thresholds.**

## Decision

Per Stage 2E rule 3: **STOP. Stage 6 (holdout single-shot) is NOT executed.** This is a pre-registered negative finding.

The pre-registered selection rule is applied as written. No redefinition of "pass ≥4" to a softer criterion. No selection of "best by feel" (which would be A or C tied at 2/5 and not meaningfully better than each other).

## Why this is the correct decision (not a failure to investigate)

- All 3 formulations fail Benchmark 1 (band distribution) — none place lineups in the slate-relative HP/HO band at pro frequency.
- All 3 fail Benchmark 4 (Mahalanobis ≤ 2.25): A median 2.71, B 2.67, C 2.51 — even the best (C) is well above the 2.25 threshold and only 1/16 dev slates pass.
- All 3 fail Benchmark 5 (fingerprint ≤ 1.10 on ≥13 of 16): A 6/16, B 6/16, C 8/16.
- Formulations A and C pass Benchmarks 2 (stack distribution) and 3 (bring-back rate), but the qualification gate is ≥4 of 5, not 2.

The architectural variation across the 3 formulations (mixture sampling, hierarchical anchor, game-stack premium) was not sufficient to clear the dev thresholds. This rules out (within these formulation families and these magnitudes) the hypothesis that framework-derived structural construction matches pros on all 5 benchmarks simultaneously.

## What is NOT being inferred from this negative result

- **NOT inferred:** that the framework principles in 2A are wrong.
- **NOT inferred:** that any other set of 3 formulations would also fail.
- **NOT inferred:** that the magnitudes were "near the edge of passing" — Bonferroni-corrected thresholds are, by design, conservative; we cannot infer effect sizes from threshold-failure.
- **NOT inferred:** that Formulation A or C is the "winner among the failures." The rule is strictly ≥4/5; below that, all are non-qualifying.

## What this finding means

The 3 pre-registered formulations, with the magnitudes specified in 2C, do not meet the Bonferroni-corrected thresholds on the 16-slate development set. Stage 6 is not executed. The user decides next steps; this protocol does not propose successor formulations.

End of Stage 5.
