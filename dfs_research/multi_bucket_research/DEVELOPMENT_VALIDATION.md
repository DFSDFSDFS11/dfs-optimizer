# DEVELOPMENT VALIDATION — Stage 4

**Run date:** 2026-05-03
**Slates:** 16 dev slates only (holdout sealed)
**Lineups evaluated:** 75 per slate × 15 slates + 60 (4-28-26, narrow C pool) = 1,185 portfolio lineups
**Bonferroni p<0.01 thresholds applied**

## Summary

| Benchmark | Result | Pass? |
|---|---|---|
| B1 (inverse-bell) | ratio 0.995, 95% CI [0.937, 1.073] | **FAIL** |
| B2 (top-1%) | obs/exp 0.928, 95% CI lo 0.382× | **FAIL** |
| B3 (top-0.1%) | obs/exp 0.000 (0 hits, expected 1.18) | **FAIL** |
| B4 (band distribution) | HP/HO 41.4 / HP/LO 9.3 / LP/HO 9.3 / LP/LO 40.1 | **PASS** |
| B5 (lineup fingerprint) | median 0.654, p90 2.139 | **PASS** |
| B6 (portfolio decorrelation) | mean 0.124, max 0.619 | **PASS** |

**Total: 3 of 6 benchmarks PASSED.**

Per Stage 2H selection rule: **3 or fewer passed → STOP. No holdout. Document negative finding.**

---

## Per-slate diagnostic table

| Slate | F | top-1% | top-0.1% | avgFinishPct | meanJ | maxJ | B5 median |
|---|---|---|---|---|---|---|---|
| 4-8-26 | 6,274 | 1 | 0 | 0.4350 | 0.149 | 0.667 | 1.609 |
| 4-12-26 | 13,071 | 0 | 0 | 0.5993 | 0.153 | 0.667 | 0.316 |
| 4-17-26 | 29,411 | 0 | 0 | 0.4637 | 0.125 | 0.667 | 0.343 |
| 4-18-26 | 9,748 | 1 | 0 | 0.5324 | 0.119 | 0.538 | 0.968 |
| 4-21-26 | 9,803 | 0 | 0 | 0.4700 | 0.141 | 0.538 | 1.471 |
| 4-22-26 | 13,071 | 0 | 0 | 0.3766 | 0.158 | 0.667 | 0.403 |
| 4-23-26 | 9,803 | 0 | 0 | 0.4319 | 0.143 | 0.667 | 0.678 |
| 4-24-26 | 29,411 | 1 | 0 | 0.5507 | 0.084 | 0.538 | 0.228 |
| 4-25-26 | 9,803 | 0 | 0 | 0.5301 | 0.122 | 0.667 | 0.378 |
| 4-25-26-early | 9,693 | 1 | 0 | 0.3798 | 0.125 | 0.538 | 1.423 |
| 4-26-26 | 13,071 | 3 | 0 | 0.6752 | 0.105 | 0.538 | 0.234 |
| 4-27-26 | 44,646 | 0 | 0 | 0.5697 | 0.113 | 0.667 | 0.638 |
| 4-28-26 | 13,071 | 1 | 0 | 0.5211 | 0.094 | 0.667 | 0.245 |
| 4-29-26 | 12,586 | 1 | 0 | 0.4558 | 0.108 | 0.667 | 1.562 |
| 5-2-26-main | 9,803 | 0 | 0 | 0.6258 | 0.130 | 0.538 | 1.412 |
| 5-3-26 | 13,071 | 2 | 0 | 0.5269 | 0.113 | 0.667 | 1.448 |

(meanJ, maxJ are the per-slate mean/max pairwise Jaccard within the 75-lineup portfolio.)

---

## Detailed benchmark analysis

### B1 — Inverse-bell shape: FAIL (ratio 0.995, CI [0.937, 1.073])

The portfolio's finishPct distribution is **uniform**, not inverse-bell. Quintile means:
- top quintile: 0.886
- mid quintile: 0.511
- bottom quintile: 0.131

Mean of (top + bot) / 2 = 0.508, vs mid = 0.511. Ratio = 0.995. The 95% bootstrap CI lower bound (0.937) is below the threshold of 1.0; the point estimate (0.995) is far below the threshold of 1.4.

**Implications:**
- Bucket D (decorrelation) appears to be drawing from middle-of-the-pack lineups rather than tail-coverage candidates. Finishes are spread roughly uniformly — D's lineups land in the middle of the finish distribution.
- Bucket T's stack-mix discipline (60% 5-stacks) does not generate the bottom-tail bust-and-boom pattern that produces inverse-bell.
- This is the central failure: the multi-bucket architecture as pre-registered did NOT produce the inverse-bell shape we hypothesized it would.
- Implicates AS-01 (three-bucket decomposition), AS-13 (D unbounded on stack), AS-10/AS-11 (D's δ/μ Jaccard penalty drives toward "most different" rather than "most boom-or-bust").

### B2 — Top-1% hits: FAIL (obs/exp 0.928, CI lo 0.382×)

11 observed top-1% hits across 1,185 lineups vs ~11.85 expected. The point estimate (0.928) is just barely below 1.0. The binomial 95% CI lower bound (0.382× expected) fails the 0.85 threshold by a wide margin.

**Implications:**
- The portfolio is producing top-1% hits at roughly random rate, **not** at the lift-multiplier rate we'd expect from a portfolio explicitly engineered for tail coverage.
- 4-26-26 contributes 3 of the 11 (best slate); 8 dev slates produce 0 top-1% hits. The hit-rate is also extremely uneven across slates — high-variance.
- Implicates AS-04 (V1 EV is the right T objective), AS-05 (ρ_T = 0.25), AS-06 (60/30/10 stack mix). The architecture is not concentrating tournament-tail candidates well enough.

### B3 — Top-0.1% hits: FAIL (0 of expected 1.18)

**Zero top-0.1% finishes across all 1,185 dev portfolio lineups.** This is the most damning result. Expected count is 1.18 — small enough that a single hit would have been "in line with random." Zero hits is significantly below the 0.7× CI threshold.

**Implications:**
- The architecture, with its global Jaccard cap at 0.7 and stack-mix discipline, may be *preventing* the kind of high-correlation extreme-leverage builds that win the very top of GPP fields.
- A genuine winning lineup at 0.1% percentile usually requires perfectly correlated 5-stack + bring-back + low-owned anchors. The 0.7 Jaccard cap and the "60% 5-stack / 30% 4+BB / 10% 3-3" mix may be diluting that structure.
- Strong implication: **the architecture's decorrelation goal is at odds with its tournament-tail goal.** The two cannot be simultaneously satisfied with the pre-registered weights.

### B4 — Band distribution: PASS

| Band | Multi-bucket | Pro | Diff |
|---|---|---|---|
| HP/HO | 41.4% | 38.7% | +2.7pp |
| HP/LO | 9.3% | 13.0% | -3.7pp |
| LP/HO | 9.3% | 15.2% | -5.9pp |
| LP/LO | 40.1% | 33.1% | +7.0pp |

All differences within 10pp; no band exceeds 50%. The portfolio shape matches pro band distribution closely. Architecture's bucket decomposition appears to be doing something right at the band level.

### B5 — Lineup-level fingerprint: PASS (median 0.654, p90 2.139)

Median Manhattan distance from each portfolio lineup to its nearest pro lineup (z-scored on 8 features) is 0.654, below the 1.3 threshold. p90 is 2.139, below the 3.5 threshold. This is well above V1's reported 0.55 but within the spec.

### B6 — Portfolio decorrelation: PASS (mean 0.124, max 0.619)

Mean per-slate mean pairwise Jaccard: 0.124. Mean per-slate max pairwise Jaccard: 0.619 (so the global 0.7 cap is *almost* binding but not always — the average max sits at 0.619). The decorrelation is achieved.

However, the global cap is binding more than expected — 11 of 16 dev slates have max Jaccard at 0.667 or 0.538 (which are 6/10 and 5/10 overlap respectively), suggesting many pairs sit right at the edge of the constraint. This is consistent with the pool having dense "high-overlap clusters" that the decorrelation pass struggles to fully separate.

---

## Pool-thinness flag — 4-28-26 Bucket C

On 4-28-26, Bucket C's strict eligibility filter (4-stack + no-bring-back + top-5-SP + no-PVH) yielded 0 candidates and the round-4 fallback (relax SP requirement) also yielded 0. The slate's portfolio is therefore **60 lineups (T=45, C=0, D=15)** rather than 75. This is a confirmed instance of AS-09 falsification on a single slate. It does not change benchmark thresholds (each benchmark is computed on whatever portfolio size resulted), but it adds noise to the aggregates.

---

## Falsification ledger update

Based on dev validation:

- **AS-01** (three-bucket decomposition is meaningful): UNCONFIRMED; the bucket structure produced band-distribution match (B4 pass) but failed to generate the tournament-tail signature (B1, B2, B3 fail). Whether buckets *converge to V1 lineups* was not directly tested but the failure pattern suggests buckets did differentiate (else B6 wouldn't have passed cleanly) — they just didn't differentiate **toward the right targets**.
- **AS-03** (Jaccard 0.7 cap captures right level): The cap is binding (max ~0.62) but the resulting portfolio still failed B1/B2/B3. The cap may be at the right magnitude but is constraining the architecture in a way that prevents tail concentration.
- **AS-09** (Bucket C strict filter): FALSIFIED on 4-28-26 (0 eligible).
- **AS-10/AS-11/AS-13** (Bucket D scoring drives genuine coverage): UNCONFIRMED; D produced low-Jaccard lineups but those lineups did not show up in either tail of the finish distribution. The "decorrelation, not garbage" guardrail (≥80% projection) is too lax — D's lineups appear to land in the middle.

The most important update: the 0 top-0.1% hits across 1,185 lineups is structural evidence that the multi-bucket architecture, as pre-registered, **structurally prevents** the kind of correlated-extreme-leverage construction that wins the very top of MLB GPP fields. This is consistent with the failure of prior 3 formulations in `slate_derived_research/` and suggests the deeper issue is not the *number of buckets* but the **tournament-construction primitive** itself.

---

## Stage 4 verdict

3 of 6 passed. Per pre-registered selection rule, this triggers a **STOP**: no Stage 6 holdout. Document negative finding in FINAL_REPORT.md.

Holdout slates remain SEALED. They will not be opened.
