# SELECTION — Stage 5

**Date:** 2026-05-03
**Source:** `DEVELOPMENT_VALIDATION.md` benchmarks at Bonferroni p<0.01

## Pre-registered selection rule (Stage 2H)

- 5 or 6 of 6 passed → STRONG candidate → Stage 6 holdout (single-shot).
- Exactly 4 of 6 passed → MODERATE candidate → Stage 6 holdout (single-shot, deploy at minimal stakes if holdout supports).
- 3 or fewer passed → STOP. No holdout. Document negative finding.

## Result

| Benchmark | Pass? |
|---|---|
| B1 inverse-bell | FAIL |
| B2 top-1% | FAIL |
| B3 top-0.1% | FAIL |
| B4 band distribution | PASS |
| B5 lineup fingerprint | PASS |
| B6 portfolio decorrelation | PASS |

**3 of 6 passed.**

## Selection outcome

**STOP. No Stage 6 holdout.**

The multi-bucket architecture as pre-registered does not pass the 4/6 minimum threshold for moderate candidacy. Per Stage 2H:
- Selection rule is binary (no partial credit, no "almost pass").
- Magnitudes are pre-registered and cannot be modified to chase additional passes.
- Architecture is fixed; threshold relaxation would invalidate Bonferroni correction.

The 8 holdout slates remain **SEALED**. They will not be opened by this research.

## Honest assessment

The architecture passed the **portfolio-shape benchmarks** (B4, B5, B6) — band distribution within 10pp of pros, lineup-level fingerprint median 0.654, decorrelation mean 0.124 — but failed the **tournament-finishing benchmarks** (B1, B2, B3). The multi-bucket portfolio looks pro-shaped on the surface but does not generate the tournament-tail finishes that pro portfolios produce.

The most diagnostic result is **zero top-0.1% hits across 1,185 dev portfolio lineups** (expected 1.18). This is structural evidence that the architecture's decorrelation goal is at odds with its tournament-tail goal: enforcing max pairwise Jaccard ≤ 0.7 across a 75-lineup portfolio constrains the construction in ways that prevent the high-correlation correlated-extreme-leverage builds that win MLB GPP top tiers.

This is not a tuning problem. The pre-registered magnitudes (45/15/15, ρ_T=0.25, δ=5.0, μ=2.0, Jaccard cap 0.7) are framework-grounded and cannot be retro-fitted to pass without invalidating the methodology. The negative finding stands: **multi-bucket portfolio architecture with global decorrelation does not produce pro tournament-finishing behavior on the 16 dev slates, at the pre-registered magnitudes.**

Proceed to FINAL_REPORT.md.
