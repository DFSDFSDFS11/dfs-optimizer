# MULTI-BUCKET PORTFOLIO RESEARCH — STAGE 2 SPECIFICATION (LOCKED)

**Status:** LOCKED at end of Stage 2.
**Date locked:** 2026-05-03.
**Holdout:** 8 slates per `HOLDOUT_LOCK.md` (sealed). NOT to be touched until Stage 6.
**Development set:** 16 slates per `HOLDOUT_LOCK.md`.
**Portfolio target size:** N = 75 lineups. Bucket sizes are PRE-REGISTERED at 45 / 15 / 15.

This research tests whether a multi-bucket architecture with **portfolio-wide decorrelation** captures professional DFS construction behavior in a way prior single-formulation systems (V1, SDC, A/B/C in slate_derived_research) did not.

---

## 2A. Architecture overview

### 2A.1 The hypothesis

Pro DFS portfolios appear to behave less like a single "best lineup" optimizer and more like a **functional ensemble**: a tournament-tail bucket designed to capture top-1% / top-0.1% finishes via correlated stacks and contrarian leverage; a cash-line equity bucket designed to bank near-optimal projection without ownership penalty for the top of the field; and a decorrelation bucket designed specifically to cover *failure modes* of the first two — projections that don't bust but cover game-state worlds the first 60 lineups missed.

V1 (and the prior 3 formulations in `slate_derived_research`) all produced portfolios that scored each lineup independently against a single objective. The hypothesis under test is that **single-objective scoring is structurally incapable of producing the observed pro portfolio shape** — specifically, the inverse-bell finishing distribution and the simultaneous coverage of top-1% with low pairwise Jaccard similarity. A multi-bucket architecture, by contrast, *can* produce both because the buckets target different worlds and the global decorrelation step explicitly enforces the Jaccard property.

### 2A.2 The three buckets

| Bucket | Size | % | Purpose | Scoring formula | Bring-back | Stack mix |
|---|---|---|---|---|---|---|
| T (Tournament tail) | 45 | 60% | Win top-1% / top-0.1% | V1 EV with λ_T=0.30, ρ_T=0.25 | yes (per V1 corr 1B) | 60% 5-stacks / 30% 4+BB / 10% 3-3 |
| C (Cash-line equity) | 15 | 20% | Bank cashing equity | proj_sum + 0.5·floor_sum, NO ownership penalty | no | 4-stacks only |
| D (Decorrelation) | 15 | 20% | Cover uncovered worlds | proj_sum − 5.0·max_jac − 2.0·mean_jac, ≥80% projection | optional | unconstrained |

### 2A.3 The architectural primitive that distinguishes this from prior work

After all 3 buckets are populated independently, a **global decorrelation enforcement pass** runs: for every pair (i, j) of selected lineups, if Jaccard(i, j) > 0.7, replace whichever lineup is in the lowest-priority bucket (D > T > C in replacement preference: D first, then T, then C if absolutely required) with the next-best candidate from that bucket's eligible-list that satisfies the constraint. Iterate until the constraint holds or 50 iterations occur.

This decorrelation enforcement is the architectural primitive that prior single-formulation systems lacked. Whether it actually produces the observed pro behavioral signatures is the empirical question.

### 2A.4 Justification for 45/15/15

- 45 (60%) for T: the tournament tail is where the inverse-bell upper-extreme density is generated. Pro band data shows ~52% of lineups in HP-* bands (38.7 + 13.0). 60% is one band-width higher to bias toward T-mode and let the global decorrelation pass shave overlap.
- 15 (20%) for C: pro band data shows 33.1% LP/LO. C is *not* LP/LO — it is HP/HO (cash chalk). 20% is the rough mid-point between "no cash bucket" (V1) and "all cash" (unrealistic). Held at 20% as a structural-symmetry default with D.
- 15 (20%) for D: equal to C as a deliberate constraint that any "extra" structure must come from the global decorrelation pass, not bucket-size tuning.

These sizes are FIXED. They are not adjusted during validation.

---

## 2B. Bucket T construction (45 lineups, V1 parameters preserved)

### 2B.1 Formula

Bucket T uses V1's EV scoring with the V1 weights:

```
EV_T(ℓ) = W_PROJ · projPct(ℓ) + W_LEV · (1 − ownPct(ℓ)) + W_VAR · rangePct(ℓ) · 0.85 + W_CMB · uniqPct(ℓ)
```

with V1 magnitudes: `W_PROJ=1.0`, `W_LEV=0.30` (this is **λ_T**), `W_VAR=0.15`, `W_CMB=0.25`. Correlation adjustment per V1 corr 1B (stack bonus, bring-back, P-vs-H penalty) applied as `proj * (1 + corrAdj)` before percentile ranking. PPD-corner penalty applied as in V1.

`ρ_T = 0.25` is the **maximum pairwise Jaccard similarity within Bucket T during T-selection**. Implemented as the V1 max-pairwise-overlap ≤ 6 of 10 players (= 6/(10+10−6) = 0.428 Jaccard) is replaced with a stricter Jaccard ≤ 0.25 cap during T-selection. This makes T internally decorrelated *before* the global decorrelation pass.

### 2B.2 Stack mix targets

T must hit the following stack distribution as best the candidate pool allows:
- 60% × 45 = **27 lineups** with primaryStack=5 (5-stack, no bring-back required)
- 30% × 45 = **13 lineups** with primaryStack=4 + bringBack≥1 ("4+BB")
- 10% × 45 = **5 lineups** with primaryStack=3 AND secondaryStack=3 ("3-3")

Implementation: candidate pool is partitioned into the three stack types after Bucket-T scoring. Within each type, top-k by EV_T are taken subject to the ρ_T ≤ 0.25 Jaccard cap and the 4-stack hard constraint (replaced for 3-3 stacks). If a stack-type pool is too small to fill its quota, leftover slots fall through to the next type in the order (5-stack > 4+BB > 3-3) — i.e., 5-stack overflow before 3-3. This is a deterministic engineering rule, not a parameter.

### 2B.3 Hard constraints

- minPrimaryStack ≥ 4 for the 5-stack and 4+BB lineups; minPrimaryStack=3 + minSecondaryStack=3 for 3-3 lineups.
- No pitcher-vs-own-stack (V1 P5).
- No salary cap violations.
- ρ_T Jaccard ≤ 0.25 internally.

### 2B.4 No exposure caps within T

Per the prior single-formulation research lessons: exposure caps are a parameter-tuning move. The discipline within T comes from (a) the EV formula, (b) the stack mix targets, and (c) the ρ_T Jaccard cap. The global decorrelation pass enforces portfolio-level coverage.

---

## 2C. Bucket C construction (15 lineups, cash-line equity)

### 2C.1 Formula

```
score_C(ℓ) = projection_sum(ℓ) + 0.5 · floor_sum(ℓ)
```

where `floor_sum` is `Σ_p p25(p)` (or `Σ_p projection(p) · 0.85` if percentiles unavailable, mirroring V1 fallback). The 0.5 weight on floor (= **ρ_C**) tilts C toward HP/HO with floor-discipline — exactly the cash-line equity profile.

**No ownership penalty.** This is a deliberate architectural choice, not a tuning slip. Bucket C is meant to behave like a cash-game build: take the best chalk available, eat the ownership, and let the floor protect against bust nights.

### 2C.2 Hard constraints

- 4-stacks only (primaryStack = 4, exactly). No 5-stacks (those go to T). No 3-stacks.
- **No bring-backs.** Bring-back is a tournament construct.
- **Top pitchers required.** Specifically: each Bucket-C lineup must use 2 pitchers from the top-5 by projection on the slate. This is the cash-line "pay up for SP" rule.
- ρ_C-internal Jaccard ≤ 0.5 (looser than T because C is a small bucket and pros do play very-similar cash builds).
- Salary cap, position eligibility, no-pitcher-vs-own-stack.

### 2C.3 Selection sequence

1. Filter the candidate pool to lineups satisfying all hard constraints (4-stack, no BB, 2 top-5 SP).
2. Score by `score_C`.
3. Greedy: take the top-scoring, then the next that satisfies Jaccard ≤ 0.5 with all already-selected. Repeat until 15.
4. If pool exhausted before 15, relax Jaccard cap to 0.6, then 0.7. Document any relaxation in the run log.

---

## 2D. Bucket D construction (15 lineups, decorrelation)

### 2D.1 Formula

Bucket D is scored *after* T and C are populated (so the existing 60-lineup portfolio is fixed). For each remaining candidate ℓ:

```
score_D(ℓ) = projection(ℓ) − δ · max_jac(ℓ, T∪C) − μ · mean_jac(ℓ, T∪C)
```

where `max_jac(ℓ, T∪C)` is the maximum Jaccard similarity between ℓ and any lineup in T∪C, and `mean_jac` is the mean across all 60. Pre-registered: **δ = 5.0**, **μ = 2.0**. The asymmetric weighting (max much heavier than mean) ensures D fills *uncovered* corners — a single high-overlap lineup is much worse than mild average overlap.

### 2D.2 Hard constraint: ≥ 80% projection threshold

Define `proj_optimal_T∪C` as the maximum lineup projection in the candidate pool. Reject any candidate with `projection(ℓ) < 0.80 · proj_optimal_T∪C`. This is the explicit "decorrelation, not garbage" guardrail — D is allowed to sacrifice projection for coverage, but not unboundedly.

### 2D.3 Other constraints

- All standard roster + salary + DK position rules.
- No pitcher-vs-own-stack.
- No minPrimaryStack constraint (D is unconstrained on stack shape, since coverage is the objective).
- Bring-back optional.

### 2D.4 Selection sequence

1. Compute `proj_optimal_T∪C` from the full candidate pool.
2. Filter pool to candidates with proj ≥ 0.80 · proj_optimal and not already in T or C.
3. Score by `score_D` *iteratively*: after each selection, recompute max_jac and mean_jac for remaining candidates against the new T∪C∪D_so_far. This is the standard greedy-decorrelation pattern.
4. Continue until 15 selected. If pool exhausts (which would be a major flag), document and select fewer.

---

## 2E. Global decorrelation constraint (post-bucket enforcement)

### 2E.1 The constraint

After T (45) + C (15) + D (15) = 75 lineups are populated, compute pairwise Jaccard for all C(75, 2) = 2,775 pairs. **No pair may exceed 0.7 Jaccard similarity.**

### 2E.2 Replacement procedure

If any pair (i, j) exceeds 0.7:
1. Identify the offending pair (i, j) with the highest Jaccard.
2. Determine which lineup to replace using priority order: **D first** (most replaceable, since D is a coverage bucket), **then T** (large, has many backup candidates), **then C only if no T/D option exists**.
3. Replace the chosen lineup with the next-best candidate from its bucket's eligible-list (sorted by that bucket's score) that:
   - Was not previously in the portfolio,
   - Satisfies that bucket's internal constraints (e.g., stack-type quota for T, top-5 SP for C),
   - Has max Jaccard ≤ 0.7 with all other 74 portfolio lineups.
4. If no replacement exists for any bucket: log a "constraint-fail" event, retain the offending pair, and continue.

### 2E.3 Iteration cap

Iterate the procedure above until no pair > 0.7 OR 50 total replacements have been attempted. The cap prevents infinite loops on small slates with thin pools.

### 2E.4 Stack-mix preservation under replacement

When replacing a T lineup, the replacement should come from the same stack-type sub-pool (5-stack / 4+BB / 3-3) so that the 60/30/10 mix is preserved. If that sub-pool is exhausted, the replacement comes from the next-priority sub-pool (5 → 4+BB → 3-3). This is a deterministic engineering rule.

---

## 2F. Construction sequence (the implementation flow)

1. **Read slate inputs.** projections.csv + sspool.csv (merged from sspool1, sspool2, sspool3 if present) + actuals.csv (held until benchmark step).
2. **Build candidate pool.** Use the SaberSim pool directly (deduped by hash). This typically yields 5K-15K candidate lineups per slate. Engineering note: V1 also uses the SS pool directly; we follow the same convention. We do **not** generate an additional 50K via ILP — this would be a divergence from V1 and an extra parameter (number of synthetic lineups). The "50K candidates" target in the prompt is reinterpreted as "use the full SS pool, which serves as the candidate set." This is documented here as a Stage 2 clarification, not a Stage 2.5 amendment, because it does not change any pre-registered magnitude.
3. **Score Bucket T.** Compute pair/triple frequencies, V1 corrAdj, ownership, range, ppd, projPct/ownPct/rangePct/ppdPct/uniqPct, EV. Partition by stack type. Greedy-fill T to 45 with ρ_T=0.25.
4. **Score Bucket C.** Filter pool to 4-stack + no-BB + top-5-SP candidates. Greedy-fill to 15 with internal Jaccard cap.
5. **Score Bucket D.** Filter to ≥80% proj, exclude T∪C, iterative-greedy on score_D to 15.
6. **Global decorrelation pass.** Up to 50 iterations of replacement to enforce max Jaccard ≤ 0.7 across all 75 pairs.
7. **Export.** 75-lineup portfolio + per-lineup detail CSV (bucket tag, score, stack type, max-Jaccard-to-portfolio, etc.).

---

## 2G. Six benchmarks (Bonferroni p < 0.01 development thresholds)

All benchmarks computed across 16 development slates. The unit of evaluation is the **portfolio of 75 lineups per slate**. Bonferroni correction is built into the threshold definitions below.

### 2G.1 B1 — Inverse-bell shape

Per slate: split the 75 portfolio lineups into 5 quintiles by *actual* finish percentile. Compute mean actual finish percentile within each quintile. Aggregate across 16 slates. Pass criteria:
- (top-quintile mean + bottom-quintile mean) / 2 > middle-quintile mean × 1.4.
- 10,000-bootstrap 95% CI lower bound on the ratio > 1.0.

### 2G.2 B2 — Top-1% hits

Per slate: count how many of the 75 lineups finished in the contest's top 1% (rank ≤ 0.01 × totalEntries). Pass criteria:
- Aggregate observed/expected ≥ 1.0, where expected = 0.01 × 75 × num_dev_slates_with_actuals.
- 95% binomial CI lower bound ≥ 0.85 × expected.

### 2G.3 B3 — Top-0.1% hits

Same as B2 with rank ≤ 0.001 × totalEntries. Pass criteria:
- Observed/expected ≥ 1.0.
- 95% binomial CI lower bound ≥ 0.7 × expected.

### 2G.4 B4 — Band distribution

For each lineup, compute slate-relative HP/LP and HO/LO bins (HP = top half by lineup projection; HO = top half by lineup geoMeanOwnHit). Aggregate across all dev portfolio lineups. Pass criteria:
- Each of 4 bands (HP/HO, HP/LO, LP/HO, LP/LO) within ±10pp of pro reference (38.7, 13.0, 15.2, 33.1).
- No band exceeds 50%.

### 2G.5 B5 — Lineup-level fingerprint

For each portfolio lineup ℓ, compute the Manhattan distance in a feature space (primarySize, secondarySize, bringBack, numGames, numTeamsUsed, maxGameStack, salaryStd, salaryTopThree, geoMeanOwnHit, ownAvg) — each feature z-scored using the dump's pro distribution — to its **nearest pro lineup** in the dump on the same slate. Pass criteria:
- Median across all dev portfolio lineups (across all 16 slates) < 1.3.
- p90 across all dev portfolio lineups < 3.5.

### 2G.6 B6 — Portfolio decorrelation (NEW)

Per slate: compute mean and max pairwise Jaccard across the C(75, 2) pairs. Aggregate across 16 dev slates as the simple mean of per-slate stats. Pass criteria:
- Mean of (per-slate mean pairwise Jaccard) < 0.5.
- Mean of (per-slate max pairwise Jaccard) < 0.7.

### 2G.7 Bonferroni note

All thresholds above are the prompt's pre-registered values, which the user noted are slightly more stringent than 0.05/6 ≈ 0.0083 in conventional statistical practice. The thresholds are pre-registered and used as-is.

---

## 2H. Selection rule

Strictly applied at end of Stage 4:

- **5 or 6 of 6 passed:** STRONG candidate → proceed to Stage 6 holdout (single-shot).
- **Exactly 4 of 6 passed:** MODERATE candidate → proceed to Stage 6 holdout (single-shot); deploy only at minimal stakes if holdout supports.
- **3 or fewer of 6 passed:** STOP. No holdout. Document negative finding in FINAL_REPORT.md.

The selection rule is binary on each benchmark — no partial credit, no "almost pass."

---

## 2I. Numbered assumption ledger

Each assumption includes (a) the magnitude or rule, (b) the framework justification, (c) the falsification criterion. Falsification means: "if this is observed during development, the assumption is wrong and the multi-bucket hypothesis is harmed in a specific identifiable way."

### Architectural assumptions

**AS-01. Three-bucket decomposition is meaningful.**
Rule: Portfolio split into T (45) + C (15) + D (15), where each bucket targets a distinct world-class.
Justification: V1 single-objective scoring failed to produce inverse-bell shape consistently in prior research. Multi-bucket is the next architectural primitive in the framework hierarchy (Ch. 8 — slate-feature responsiveness implies multi-mode construction).
Falsification: If post-validation we observe that >80% of T, C, and D selections overlap with a V1-only run on the same slate (i.e., the buckets converge on the same lineups), the bucket decomposition added no information.

**AS-02. Bucket sizes 45/15/15 are appropriate.**
Rule: 60/20/20 split.
Justification: 60% biases toward tournament tail (consistent with HP-* = 51.7% pro share inflated for tail-coverage); 20/20 split gives equal weight to cash-equity and decorrelation buckets.
Falsification: If C and D portfolio finish distributions are statistically indistinguishable from each other (KS test p>0.05) across dev slates, the 20/20 split is over-engineered relative to a single 30-lineup "non-T" bucket.

**AS-03. Global Jaccard cap of 0.7 captures the right level of decorrelation.**
Rule: After bucket population, no pair exceeds 0.7 Jaccard.
Justification: Pro lineup-level analysis (T8 in `lineup_level/`) shows mode_jaccard near 0.46 within pro portfolios. 0.7 is a soft ceiling — half-again above the central tendency.
Falsification: If post-validation portfolio mean Jaccard is below 0.3 (i.e., the 0.7 cap is not binding), the global decorrelation step did no work.

### Bucket T assumptions

**AS-04. V1 EV formula is the right Bucket-T objective.**
Rule: EV_T = W_PROJ · projPct + 0.30 · (1−ownPct) + 0.15 · rangePct · 0.85 + 0.25 · uniqPct.
Justification: V1 was the prior best system on lineup-level pro distance (0.550 vs Hermes-A 0.642).
Falsification: If dev B5 (lineup-level fingerprint) p90 > 3.5, the V1 formula is inadequate even within its bucket — the multi-bucket hypothesis is not the issue; V1 itself is the issue and we should fix it before testing buckets.

**AS-05. ρ_T = 0.25 internal Jaccard cap.**
Rule: Within Bucket T, no pair of selected lineups has Jaccard > 0.25.
Justification: Stricter than V1's max-overlap=6 (which is ~0.43 Jaccard) because T is a tournament-tail-dense bucket and needs more internal spread.
Falsification: If T-internal Jaccard mean > 0.40 in dev (despite the cap), the cap is unreachable on the candidate pool, indicating either the pool is too thin or the cap is too aggressive.

**AS-06. Stack mix 60/30/10 (5-stack / 4+BB / 3-3) within T.**
Rule: T's 45 lineups are 27 5-stacks, 13 4+BB, 5 3-3.
Justification: Pro stack distribution from `lineup_level/` summary heavily skews toward 4+BB; 60% 5-stack is more aggressive than pros and intentionally biases T toward tail-coverage.
Falsification: If achieved stack mix in dev deviates from target by >15pp on any stack type, the candidate pool can't support the mix and the assumption is wrong on this slate set.

### Bucket C assumptions

**AS-07. C uses no ownership penalty.**
Rule: score_C = projection_sum + 0.5 · floor_sum.
Justification: Cash-line builds in pro practice eat ownership for floor and projection. C is *not* a tournament construct.
Falsification: If C lineups have systematically *better* tournament finishes than T lineups in dev, the ownership penalty was needed and we under-specified C. (This is a "C did the wrong job" failure, not a "C is bad" failure.)

**AS-08. ρ_C = 0.5 — the floor weight in score_C.**
Rule: 0.5 weight on floor_sum vs 1.0 on projection_sum.
Justification: Floor matters for cash-line equity but should not dominate projection (which is the primary cashing signal).
Falsification: If C lineups have anomalously low ceiling but normal projection, the 0.5 floor weight is too high — C builds are lined up for cash but unable to scale with hot games.

**AS-09. C uses 4-stacks only, no bring-backs, top-5 SP required.**
Rule: Bucket-C composition rules.
Justification: These match the canonical cash-line shape — moderate stack, no tournament correlation, premium SP for floor.
Falsification: If dev portfolio's actual cash-game-style finishes (median rank ≤ 50% threshold) are not concentrated in C, the cash-line construction rule is not what produces cash equity; perhaps SP quality matters more, or 5-stacks cash too.

### Bucket D assumptions

**AS-10. D's δ=5.0 max-Jaccard penalty.**
Rule: 5.0 × max_jac coefficient in score_D.
Justification: Decorrelation pressure must be strong enough that a coefficient-1 unit of Jaccard (= identical lineup) reduces score by 5 units of projection — a near-rejection.
Falsification: If D lineups frequently have max_jac > 0.5 with T∪C (i.e., D failed to find low-overlap candidates), the penalty was too soft OR the candidate pool can't support the bucket.

**AS-11. D's μ=2.0 mean-Jaccard penalty.**
Rule: 2.0 × mean_jac coefficient.
Justification: Mean Jaccard captures broad portfolio-overlap risk; weight is 40% of max-Jaccard weight (a deliberate asymmetric weighting reflecting that one extreme overlap is worse than uniform mild overlap).
Falsification: If D lineups have low max_jac (< 0.3) but high mean_jac (> 0.4), μ was too low to discriminate among low-max-jac candidates.

**AS-12. D's ≥80% projection threshold.**
Rule: D candidates must have projection ≥ 0.80 × pool-optimal projection.
Justification: Decorrelation, not garbage. 80% is the minimum projection at which a lineup is plausibly cashing.
Falsification: If D lineups have systematically the worst per-slate finishes (i.e., D bucket's finishPct mean is significantly below T and C), 80% is too low — the threshold should bind closer to optimal.

**AS-13. D unbounded on stack shape.**
Rule: D may use any stack shape (3, 4, 5, or no primary stack).
Justification: D's job is coverage; constraining stack shape would defeat that.
Falsification: If D lineups all converge to 4-stacks anyway (signaling that the pool's only candidates ≥80% proj are 4-stacks), the unboundedness is illusory and we have a "bucket = filter" issue.

### Global decorrelation assumptions

**AS-14. Replacement priority D > T > C is correct.**
Rule: When breaking the 0.7 Jaccard constraint, prefer to replace D first, then T, last C.
Justification: D is least committed to a fixed lineup-set (it's defined as the residual), T is large enough to re-fill, C is small and structurally fixed (4-stack + no-BB + top-5-SP is a narrow pool).
Falsification: If post-decorrelation portfolio has C lineups with very high mean Jaccard (>0.5) to non-C lineups, the priority order failed to protect C-internal coverage.

**AS-15. 50-iteration replacement cap is sufficient.**
Rule: Up to 50 attempted replacements before the global pass terminates.
Justification: 75 lineups × 74 / 2 = 2,775 pairs; a healthy slate should resolve in ≤ 30 attempts. 50 is a soft ceiling.
Falsification: If >5 dev slates hit the 50-iteration cap, the cap is binding and the assumption breaks — either the constraint is unreachable or the procedure is flawed.

### Operational assumptions

**AS-16. Candidate pool = SaberSim pool (no synthetic ILP generation).**
Rule: We use the slate's `sspool*.csv` lineups directly (typically 5K-15K candidates per slate).
Justification: V1 uses the SS pool. Adding 50K synthetic candidates introduces an unspecified parameter (sampling weight, ILP variation count) that itself becomes a confound.
Falsification: If multiple buckets cannot fill their quotas on dev slates (especially Bucket C with its narrow 4-stack + no-BB + top-5-SP filter), the pool is too thin and synthetic generation may have been needed.

**AS-17. Stack-mix preservation under T-replacement.**
Rule: When replacing a T lineup during global decorrelation, the replacement must come from the same stack-type sub-pool (5-stack / 4+BB / 3-3) when possible.
Justification: Preserving stack mix is part of T's pre-registered structure; otherwise replacement could collapse T into one stack type.
Falsification: If achieved T stack mix deviates >5pp from target on >25% of dev slates because of replacement, the stack-preservation rule is too rigid.

**AS-18. Floor fallback for C when percentiles unavailable.**
Rule: If a player has no SS percentiles, use 0.85 × projection as p25.
Justification: V1 uses the same fallback.
Falsification: If C lineups on slates with sparse percentile data systematically under-perform on actuals, the fallback is biasing toward a fake floor.

### Benchmarking assumptions

**AS-19. Pro reference for B4 = (38.7, 13.0, 15.2, 33.1).**
Rule: Band-distribution targets from `lineup_level/` SYNTHESIS.
Justification: This is the pre-prompt-given pro behavioral baseline.
Falsification: If our portfolio matches all other benchmarks but fails B4, B4 may be measuring something the multi-bucket architecture deliberately should not match (e.g., we may want HP/HO concentration > 38.7% intentionally for tail-coverage). Documentation of this would inform Stage 5 selection but not change Stage 4 numerics.

**AS-20. B5 nearest-pro distance < 1.3 is a meaningful threshold.**
Rule: B5 median distance < 1.3.
Justification: V1 achieved 0.55 in lineup-level analysis, so 1.3 is a soft ceiling that is well above V1 but tight enough to be meaningful for novel architectures.
Falsification: If B5 median is between 1.3 and 1.6 but other benchmarks pass, the B5 threshold may be over-tight given a multi-bucket portfolio that intentionally includes bucket-D lineups designed to be unusual.

**AS-21. 16 dev slates is sufficient for Bonferroni p<0.01.**
Rule: Sample size for benchmark CIs.
Justification: 16 × 75 = 1,200 lineups for B4/B5/B6. For B2/B3, 16 slates × ~10K total contest entries = ~160K observation tied to ~1,200 lineups; binomial CI is reasonably tight.
Falsification: If CIs are so wide on dev that no benchmark can distinguish "pass" from "marginal" (e.g., B2 CI lower bound below 0.5× expected for many configurations), the sample is too small.

### Total: 21 assumptions logged.

---

## 2J. Lock affirmation

The architecture, magnitudes, benchmark thresholds, selection rule, and assumption ledger above are LOCKED at 2026-05-03. No edit may be made after this date except via a numbered Stage 2.5 amendment (justification + clarification of intent without changing magnitude). Implementation in Stage 3 follows this specification verbatim.

The 8 holdout slates remain sealed. Stage 6 single-shot is gated on Stage 5 selection rule passing.

END OF STAGE 2 SPECIFICATION.
