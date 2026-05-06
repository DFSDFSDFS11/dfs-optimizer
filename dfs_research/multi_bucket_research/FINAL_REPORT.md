# FINAL REPORT — Multi-Bucket Portfolio Research

**Date:** 2026-05-03
**Outcome:** **NEGATIVE FINDING.** Multi-bucket architecture with global decorrelation rejected at pre-registered magnitudes.

## 1. Executive summary

This research pre-registered and tested a 75-lineup multi-bucket portfolio architecture (45 tournament-tail / 15 cash-line / 15 decorrelation), with global Jaccard ≤ 0.7 enforcement, against 16 dev MLB DFS slates.

The architecture **passed 3 of 6 Bonferroni-corrected benchmarks** (B4 band distribution, B5 lineup fingerprint, B6 portfolio decorrelation) and **failed the three benchmarks tied to tournament finishing** (B1 inverse-bell, B2 top-1%, B3 top-0.1%).

Per the pre-registered Stage 2H selection rule, 3-or-fewer passes triggers STOP. **The 8 holdout slates remain sealed and were not opened.** No Stage 6 was conducted.

The hypothesis that "a multi-bucket architecture with portfolio-wide decorrelation captures pro DFS construction behavior" is **rejected** at the pre-registered magnitudes on the dev set.

## 2. Stages executed

- Stage 1: Holdout integrity verified (zero dev-result files for any of 8 holdout slates in `slate_derived_research/development_results/{A,B,C}/`). Recorded in `HOLDOUT_VERIFIED.md`.
- Stage 2: Pre-registered specification with 21 numbered assumptions and falsification criteria. Locked in `SPECIFICATION.md`.
- Stage 3: Implemented `multi-bucket-portfolio-v1.ts` and ran on 16 dev slates. Output: `development_results/<slate>_{detail,dk}.csv` × 16 + `run_summary.json`.
- Stage 4: Computed all 6 benchmarks. Output: `DEVELOPMENT_VALIDATION.md` and `validation_results.json`.
- Stage 5: Applied selection rule. Output: `SELECTION.md`. Outcome: STOP (3/6 passed).
- Stage 6: **NOT EXECUTED** (gated on Stage 5 ≥ 4/6 passing; gate not satisfied; holdout sealed).
- Stage 7: This report.

## 3. Quantitative results

| Benchmark | Threshold | Result | Pass? |
|---|---|---|---|
| B1 inverse-bell ratio | > 1.4 AND CI lo > 1.0 | 0.995, CI [0.937, 1.073] | **FAIL** |
| B2 top-1% obs/exp | ≥ 1.0 AND CI lo ≥ 0.85× | 0.928, CI lo 0.382× | **FAIL** |
| B3 top-0.1% obs/exp | ≥ 1.0 AND CI lo ≥ 0.7× | 0.000 (0 hits, expected 1.18) | **FAIL** |
| B4 band distribution | each band within 10pp; no band > 50% | (HP/HO 41.4, HP/LO 9.3, LP/HO 9.3, LP/LO 40.1) vs (38.7, 13.0, 15.2, 33.1) | **PASS** |
| B5 lineup fingerprint | median < 1.3 AND p90 < 3.5 | median 0.654, p90 2.139 | **PASS** |
| B6 portfolio decorrelation | mean < 0.5 AND max < 0.7 | mean 0.124, max 0.619 | **PASS** |

**3 / 6 passed.** No holdout testing.

## 4. Implications

### What the architecture does well

The multi-bucket decomposition produces portfolios that *look* pro-shaped at the band level, *look* pro-shaped at the lineup-level Manhattan-distance fingerprint, and *successfully* enforce decorrelation. These are non-trivial results: prior single-formulation systems (V1, SDC, A/B/C in `slate_derived_research`) did not always meet all three.

### What the architecture does NOT do

The architecture fails at the *finishing* benchmarks. Specifically:
- The portfolio's finishPct distribution is roughly **uniform**, not inverse-bell. Quintile means: 0.886 / 0.694 / 0.511 / 0.336 / 0.131. The (top + bot) / 2 = 0.508 sits ε below mid = 0.511.
- The point-estimate top-1% rate (11 hits / 1,185 lineups) is roughly random.
- **Zero top-0.1% finishes across 1,185 dev lineups** (expected ~1.18). This is the most damning result.

### The structural diagnosis

The most defensible interpretation is that **the architecture's decorrelation goal is structurally at odds with its tournament-tail goal**. Specifically:

1. The global Jaccard ≤ 0.7 cap and the ρ_T = 0.25 internal Jaccard cap together force the 45 tournament-tail lineups to be highly diverse from each other.
2. But the lineups that win MLB GPP top-0.1% finishes are typically **highly correlated** structures (same 5-stack + bring-back + same chalk pitcher).
3. Spreading the tournament-tail across diverse stack-types and bring-back configurations means many lineups are positioned for *different* extreme outcomes — but on any single slate, only 1-2 of those outcomes actually happens, and the "right" lineup for that day's outcome ends up under-represented.
4. Pro portfolios appear to *concentrate* on specific tournament-tail bets per slate (driven by slate-specific edge identification), NOT to *diversify* across the tail. The multi-bucket architecture's global decorrelation works against this concentration.

### What this rules in/out for future research

- Multi-bucket-with-global-decorrelation as an **architectural primitive for tail-concentration** is rejected. Pre-registered magnitudes do not produce the tail-finishing pattern.
- Multi-bucket-without-global-decorrelation, OR multi-bucket-with-different-Jaccard-thresholds, are NOT tested by this research and would require separate pre-registered work.
- The B4/B5/B6 passes suggest that the *shape* of the bucket decomposition is roughly correct — the issue is in the *scoring* and *constraint* magnitudes, not the bucket counts.
- Specifically, AS-01 (three-bucket decomposition is meaningful) was UNCONFIRMED but not falsified in the strong sense (the buckets did differentiate, evidenced by B6); the failure mode is that the differentiation didn't produce the right tail concentration.

## 5. Methodology integrity checklist

- [X] Holdout slates verified sealed at Stage 1 (zero dev-result files for any of 8) — see `HOLDOUT_VERIFIED.md`
- [X] Architecture specification fully completed before any implementation — see `SPECIFICATION.md`
- [X] No design modifications based on early implementation results — TS implementation followed spec verbatim; one engineering clarification ("candidate pool = SS pool, not synthetic ILP-generated 50K") was documented in spec section 2F as a Stage 2 clarification, not a Stage 2.5 amendment, because it does not change any pre-registered magnitude
- [X] No magnitude adjustments during implementation — all magnitudes (45/15/15, λ_T=0.30, ρ_T=0.25, ρ_C=0.5, δ=5.0, μ=2.0, Jaccard cap 0.7) used as pre-registered
- [X] Bonferroni correction applied to development benchmarks (p<0.01 thresholds per spec)
- [X] Selection rule applied as pre-registered (3/6 → STOP, NOT relaxed)
- [X] Holdout test single-shot only if Stage 5 selection rule passed — Stage 5 did NOT pass; Stage 6 was correctly skipped
- [X] Holdout slates not analyzed in Stages 1-5 — 8 sealed slates were never read for projection/pool/actuals data; the lineup_dump entries for those slates were filtered out in Stage 4 validation
- [X] Negative findings documented honestly — this report does not propose "next variants" or "fix the architecture"; the negative finding is recorded as the result
- [X] All architectural assumptions documented with falsification criteria — 21 assumptions in `SPECIFICATION.md` Section 2I

## 6. Stage 2 assumption ledger summary

21 assumptions were registered in `SPECIFICATION.md` Section 2I. Five representative entries:

**AS-01. Three-bucket decomposition is meaningful.**
Falsification: If post-validation we observe that >80% of T, C, and D selections overlap with a V1-only run on the same slate, the bucket decomposition added no information.
**Status:** UNCONFIRMED (not directly tested, but indirect evidence — B6 pass means buckets did differentiate, but B1-B3 fails mean the differentiation didn't matter for finishing outcomes).

**AS-03. Global Jaccard cap of 0.7 captures the right level of decorrelation.**
Falsification: If post-validation portfolio mean Jaccard is below 0.3, the global decorrelation step did no work.
**Status:** Mean Jaccard 0.124 (well below 0.3); max Jaccard mean 0.619 (cap binding but not maximally). The cap IS doing work, but the resulting portfolio still failed B1-B3. **Falsification triggered in the indirect sense:** the cap is reachable and binding, but the portfolio still fails on tournament finishes.

**AS-09. Bucket C uses 4-stacks only, no bring-backs, top-5 SP required.**
Falsification: If dev portfolio's actual cash-game-style finishes (median rank ≤ 50% threshold) are not concentrated in C, the cash-line construction rule is not what produces cash equity.
**Status:** **FALSIFIED on 4-28-26** (zero eligible candidates after the strict filter; portfolio defaulted to 60 lineups). On other slates, C-bucket finishes were not separately analyzed.

**AS-10. D's δ=5.0 max-Jaccard penalty.**
Falsification: If D lineups frequently have max_jac > 0.5 with T∪C, the penalty was too soft.
**Status:** D lineups did achieve low max_jac (the global cap was met on 16/16 dev slates within 0-2 iterations). **Not falsified at this level.** But the broader hypothesis (D would cover uncovered worlds and produce tail finishes) was not supported.

**AS-19. Pro reference for B4 = (38.7, 13.0, 15.2, 33.1).**
Falsification: If our portfolio matches all other benchmarks but fails B4, B4 may be measuring something the architecture deliberately should not match.
**Status:** B4 PASSED (all bands within 10pp). The architecture matched the pro band reference. This is a partial validation of AS-19.

The remaining 16 assumptions are catalogued in `SPECIFICATION.md` Section 2I.

## 7. Final recommendation

**No candidate.** The multi-bucket architecture as pre-registered does not pass the development-validation threshold for holdout testing. The hypothesis is rejected. **The 8 holdout slates remain sealed and have not been opened by this research.**

No deployment is recommended.

No "next variant" is proposed by this report. Per Stage 2 anti-pattern guidance:
- "The multi-bucket idea is right but bucket sizes need adjustment" — would be parameter tuning post-hoc, prohibited.
- "Threshold relaxation since architecture is close" — invalidates Bonferroni correction, prohibited.

Future research, if conducted, must (a) be pre-registered separately, (b) use a different holdout set (the 8 slates are now spent for any portfolio test conceptually similar to this one — though they remain sealed at the data level for this specific architecture), and (c) explicitly hypothesize why a different architectural primitive would not be subject to the same finishing-vs-decorrelation tension diagnosed here.

---

**End of Multi-Bucket Portfolio Research.**
