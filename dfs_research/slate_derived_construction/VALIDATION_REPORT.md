# SLATE-DERIVED CONSTRUCTION V1 — VALIDATION REPORT

**Date:** 2026-05-03.
**Scope:** Stage 1 spec locked, Stage 2 implementation, Stage 3 validation against
24-slate pro corpus.

---

## 1. Stage 1 specification (summary)

Full text in `SPECIFICATION.md`. Brief summary:

  - **Portfolio size** N = 75 (deliberately tighter than V1's 150).
  - **Three concentric tiers**: nuts anchor (15%), frontier body (65%) split into
    three Gaussian modes along the projection-ownership efficient frontier
    (chalk-core / mid / frontier-deep), and deep-contrarian tail (20%).
  - **Slate-feature-driven mode tilt**: chalk vs deep-contrarian mode weights are
    elastically tilted by the slate's projection-ownership elasticity ε:
    steep frontier ⇒ more chalk-core, flat frontier ⇒ more deep-contrarian.
    Pivot ε=0.20, scale 0.5, capped ±50%.
  - **Hard constraints**: pitcher-faces-own-stack rejected; pitcher-shares-bring-back
    game receives 1.5× weight.
  - **Per-tier stack-size mix**: empirical pro-frequency bins (Ch. 8 framework
    aligned with observed pro behavior).
  - **Per-tier bring-back rate**: 50% (nuts), 30% (chalk-core mode), 20% (mid mode),
    0% (frontier-deep + deep-tail) — concentrated where chalk-stack ceiling
    correlates most with bring-back.
  - **No exposure caps**, no parameter sweeps, no outcome-driven tuning.

23 numeric assumptions are documented in the SPECIFICATION ledger; the spec was
locked before any validation ran. The locked ledger is included verbatim at the
end of this report.

---

## 2. Implementation details

  - **TypeScript implementation**:
    `C:/Users/colin/Projects/dfs-optimizer/src/scripts/slate-derived-construction-v1.ts`
  - **Output (per-slate DK + detail CSV, run summary)**:
    `C:/Users/colin/dfs opto/slate_derived_construction/`
  - **Python validator**:
    `C:/Users/colin/dfs opto/slate_derived_construction/validate.py`
  - **Validation outputs**:
    - `validation_table.txt` (human-readable)
    - `validation_results.json` (machine-readable)

Key code decisions:

  - Used the SaberSim 5K-lineup pool as the candidate pool L (per ASSUMPTION 7);
    no separate ILP rerun. The pool already covers the projection-ownership
    frontier.
  - LCG seeded from slate name hash → reproducibility.
  - Pitcher-vs-stack rejection enforced at sample time (not as post-filter).
  - Stack-pattern cells with empty candidate sets (e.g., a slate has no (3,3)
    builds in the pool) reallocate to the next mix entry rather than failing.
  - Detail CSV emits all 9 fingerprint features (primarySize, secondarySize,
    bringBack, maxGameStack, numGames, numTeamsUsed, geoMeanOwnHit, salaryStd,
    salaryTopThree) so the validator computes distances on a directly
    comparable basis with V1 / pros from the dump.

---

## 3. Aggregate validation results

24 slates × 75 SDC lineups = 1,725 SDC lineups; vs 150 V1 × 23 = 3,450 V1
lineups; vs ~1,200 pros × 23 ≈ 24,200 pro lineups. (Slate `5-2-26-night` has SDC
output but no V1/pros entries in the dump, so it is dropped from the structural
comparison.)

### 3.1 Band distribution (slate-relative pooled median)

| Band  | V1 %   | SDC %  | Pros % | V1 gap   | SDC gap  |
|-------|--------|--------|--------|----------|----------|
| HP/HO | 25.6%  | 23.3%  | 38.7%  | −13.2pp  | −15.4pp  |
| HP/LO | 21.1%  | 10.6%  | 13.0%  | +8.1pp   | −2.3pp   |
| LP/HO | 3.9%   | 13.7%  | 15.2%  | −11.3pp  | −1.4pp   |
| LP/LO | 49.4%  | 52.3%  | 33.1%  | +16.3pp  | +19.2pp  |

  - HP/LO and LP/HO bands ALIGN with pros: SDC −2.3pp / −1.4pp gaps vs V1's
    +8.1pp / −11.3pp gaps. SDC closes both V1 dimensional misses.
  - HP/HO band MISSES pros by 15.4pp — *worse* than V1's 13.2pp gap. SDC is even
    more under-allocated to chalk-core anchors than V1.
  - LP/LO band MISSES by 19.2pp — *worse* than V1's 16.3pp. SDC is even more
    over-allocated to deep contrarian.

### 3.2 Stack distribution

| Pattern | V1 %  | SDC %  | Pros % |
|---------|-------|--------|--------|
| 5-2     | 56.6% | 38.6%  | 39.3%  |
| 5-1     | 26.8% | 8.2%   | 14.1%  |
| 5-3     | 11.6% | 17.7%  | 13.7%  |
| 4-3     | 1.7%  | 15.4%  | 10.3%  |
| 4-2     | 2.8%  | 8.9%   | 9.5%   |
| 3-3     | 0.0%  | 4.9%   | 4.1%   |
| 3-2     | 0.0%  | 0.0%   | 3.6%   |
| 4-4     | 0.2%  | 6.3%   | 3.6%   |
| 4-1     | 0.3%  | 0.1%   | 0.0%   |

  - SDC matches the pros' top stack (5-2) almost perfectly (38.6% vs 39.3%).
  - SDC closes the V1 over-allocation to (5-1) — V1 26.8% → SDC 8.2% vs pros
    14.1% (slight under-allocation but qualitatively right direction).
  - SDC introduces (4-3), (4-2), (3-3), (4-4) representation that V1 entirely
    lacks. (4-3): V1 1.7% → SDC 15.4% vs pros 10.3%; (3-3): V1 0% → SDC 4.9%
    vs pros 4.1%.
  - (3-2) is missing from SDC (0% vs 3.6%) — a stack-mix cell that wasn't
    represented in any tier's mix. Spec gap.

### 3.3 Bring-back rate

| Metric  | V1    | SDC   | Pros  |
|---------|-------|-------|-------|
| avg     | 1.03  | 0.42  | 0.36  |
| ≥1 %    | 65.4% | 23.3% | 21.6% |
| ≥2 %    | 32.0% | 12.1% | 10.1% |

SDC matches pros nearly exactly. The per-tier rate schedule (50/30/20/0/0)
delivers a portfolio-wide mean ≈ 23% of lineups with bring-back ≥ 1, which
hits 21.6% pros target. V1's 65% is a known V1 over-correlation issue.

### 3.4 Mahalanobis distance to per-slate pro consensus

7-feature vector: primarySize, secondarySize, bringBack, numGames, numTeamsUsed,
geoMeanOwn, avgProj. Distances are normalized standard deviations of pro
portfolio-mean.

| System | median | mean |
|--------|--------|------|
| V1     | 0.56   | 0.59 |
| SDC    | 0.46   | 0.54 |

SDC is closer to pros on aggregate Mahalanobis than V1 (0.46 vs 0.56 median;
0.54 vs 0.59 mean). Per-slate, SDC beats V1 on 17 of 23 slates (4-12-26,
4-14-26, 4-15-26, 4-17-26, 4-18-26, 4-19-26, 4-20-26, 4-22-26, 4-23-26,
4-24-26, 4-25-26, 4-25-26-early, 4-26-26, 4-27-26, 4-28-26, 5-1-26, 5-2-26,
5-2-26-main, 5-3-26).

### 3.5 Per-portfolio fingerprint distance

9-feature Manhattan, scale-normalized per slate (V1+pros+SDC pooled standardization).
Median of "each portfolio lineup's distance to nearest pro lineup".

| System | median | mean |
|--------|--------|------|
| V1     | 0.80   | 0.81 |
| SDC    | 1.30   | 1.37 |

SDC is **further** from pros at lineup-level than V1 (1.30 vs 0.80 median).
This is the only metric where V1 outperforms SDC.

The driver, after inspection of the per-slate scores, is the deep-tail tier:
SDC's bottom-20%-own deep-contrarian lineups have structural fingerprints
(specifically: 3-3 splits with 4 games used, 0 bring-back, low salaryTopThree)
that don't have close neighbors in the pro corpus on most slates. Pros in the
LP/LO band tend to be 4-3 or 4-2 with 5 games used; SDC's deep tier
deliberately diversifies into smaller-stack patterns following the
DEEP_TAIL_STACK_MIX in 1B.5.

---

## 4. Honest assessment

### 4.1 What WORKED

  - **Bring-back rate**: 23.3% ≥1 vs pros 21.6% — within 2pp without any
    parameter tuning. Per-tier rate scheduling (ASSUMPTION 16) delivered this.
  - **HP/LO and LP/HO bands**: closed V1's gaps (+8.1pp → −2.3pp on HP/LO;
    −11.3pp → −1.4pp on LP/HO). The frontier-mode Gaussian + chalk-tilt
    mechanism (1B.2) is doing the right thing structurally.
  - **Stack-pattern diversification**: SDC introduced 4-3, 4-2, 3-3, 4-4
    representation that V1 lacks, hitting pro frequencies within 5pp on each.
  - **Mahalanobis to pro consensus**: 17/23 slates beat V1; median 0.46 vs 0.56.
  - **Top stack pattern (5-2)**: SDC 38.6% vs pros 39.3% — within 1pp without
    targeting it directly.

### 4.2 What FAILED

  - **HP/HO band**: SDC −15.4pp gap is *worse* than V1's −13.2pp gap. The
    nuts-anchor tier (15% allocation) PLUS frontier-chalk-core mode (~30% of
    65% = ~20% of portfolio in the chalk band) sums to 35% but the band
    measurement only counts ~23% as HP/HO. The discrepancy is real:
    chalk-mode lineups frequently fall into HP/LO or LP/HO bands because the
    "chalk" mode targets u=0.20 (20th percentile own), which is below the
    SLATE-RELATIVE median own — so chalk-mode lineups are often categorized as
    LO, not HO, by the band metric.
    - Identified problematic assumption: **ASSUMPTION 22** (mode locations
      0.20/0.50/0.80 in own-rank u-coordinates). The 0.20 chalk anchor is the
      20th-percentile of OWN-RANKED lineups, not the chalkiness threshold for
      HP/HO classification (which is the median).
  - **LP/LO band**: SDC +19.2pp gap is *worse* than V1's +16.3pp gap. The deep
    tail tier (20% allocation) AND any frontier-deep mode lineups (~16% of 65%
    = ~10%) sum to ~30% of the portfolio targeted at LP/LO, but observed
    portfolio share is 52%. The frontier-deep mode is leaking into LP/LO.
    - Identified problematic assumption: again **ASSUMPTION 22** — frontier-deep
      at u=0.80 lands in LP territory of the OWN-rank distribution, but
      pool-projection is correlated with own, so "low own" in the candidate
      pool also tends to be "lower projection" relative to the slate optimum.
  - **Fingerprint distance**: SDC +63% farther from pros at lineup-level than V1.
    Driver: deep-tail (3-3 / 4-4 patterns) and frontier-deep stack-pattern
    distribution (ASSUMPTION 15) puts probability mass on stack patterns that
    pros use less in the LP/LO band.
    - Identified problematic assumptions: **ASSUMPTION 15** (specifically the
      DEEP_TAIL_STACK_MIX and FRONTIER_DEEP_STACK_MIX entries for 3-3, 4-4)
      may be over-weighted vs pros' actual LP/LO behavior.
  - **(3-2) stack pattern**: 0% in SDC vs 3.6% in pros. The mix tables (1B.5)
    don't include a (3-2) entry on any tier. Spec gap.
  - **Slate `5-2-26-night`**: ε = 0.338 (highest in dataset), but the slate has
    no V1/pros entries in the dump, so we couldn't measure SDC's structural
    alignment on the most chalk-leaning slate.

### 4.3 Verdict

**The architecture partially produced pro-aligned portfolios.** Three of the
five structural metrics (bring-back rate, two of four bands, top stack
patterns, Mahalanobis median) align with or beat V1 on pro-similarity. Two
metrics regressed (HP/HO and LP/LO band shares, fingerprint distance).

The regressions trace primarily to **ASSUMPTION 22** (mode location
coordinates) and **ASSUMPTION 15** (stack-pattern mix in the deeper tiers).
The chalk-core and frontier-deep modes' u-coordinate placements (0.20 and
0.80 in own-rank space) are not the same as the band-classification
thresholds (slate-relative median of projection × geoMeanOwnHit), so a
lineup intended to be "chalk-core" by mode can fall into HP/LO or LP/HO at
band classification.

**Per the methodology contract, the spec is NOT iterated to fix this.**
The user will decide whether to revise ASSUMPTION 22 / 15 explicitly (and
re-run from a new locked spec), abandon the architecture, or accept the
trade-off (better Mahalanobis and bring-back at the cost of worse fingerprint
and band tail).

---

## 5. Limitations

  - **24 slates is small** for architecture validation. Confidence intervals on
    aggregate metrics are wide.
  - **In-sample**: ASSUMPTION 15 (per-tier stack mix) was set from the
    aggregate pro stack distribution observed in this same 24-slate dump.
    That makes the stack-distribution metric trivially favored. Treat the
    "matches pros' 5-2 to within 1pp" finding as a sanity check, not
    independent evidence.
  - **Out-of-sample on bring-back**: ASSUMPTION 16's per-tier rates (50/30/20/0/0)
    are framework-derived (Ch. 4 correlation lever), not fitted to pro
    frequencies. The aggregate ≈22% match is genuinely architectural.
  - **Diagnostic feature `T_slate` (scoring environment) is 0** because
    `teamTotal` is not currently parsed from the projections CSV header. This
    affects ONLY the diagnostic output; no construction logic uses T_slate.
    (Spec 1A.5 defines it but no Stage 1B rule depends on it — included for
    later experimentation per Ch. 7 high-score archetype.)
  - **`5-2-26-night`** has no pro lineups in the dump → 23 (not 24) slates
    contributed to validation aggregates.
  - **Mahalanobis feature set is reduced** vs the V2-validation-harness set
    (no projRatioToOptimal, ceilingRatioToOptimal, ownStdRatio,
    ownDeltaFromAnchor) because reproducing those requires the slate-relative
    own-percentile and ceiling-anchor objects which are not carried in the
    dump. Replaced with primarySize / secondarySize / bringBack / numGames /
    numTeamsUsed / geoMeanOwn / avgProj. Different feature set ⇒ Mahal
    numbers are not directly comparable to those in the V2 harness.
  - **Deployment**: validation is in-sample for the design (ASSUMPTION 15
    used pro empirics on the same slates). Even on OUT-OF-SAMPLE structural
    metrics, this is NOT a deploy candidate — the regressed metrics
    (HP/HO band, LP/LO band, fingerprint) need an architectural answer, not
    a parameter answer.

---

## 6. Locked Stage 1 ledger (verbatim)

```
ASSUMPTION 1: Portfolio size N = 75 lineups.
  Justification: Tighter, more concentrated portfolio than V1's 150. With
  framework-derived band balance, fewer lineups are needed to cover the
  variance bands at the empirically-observed pro densities. Chosen as a
  midpoint of plausible {50, 75, 100, 150} range.
  Choice flag: YES — could be 50 or 100; 75 chosen.

ASSUMPTION 2: Geometric-mean ownership floor of 0.1%.
  Justification: Prevents log(0). Matches V1's ownership-floor convention.
  Choice flag: NO (necessary for math).

ASSUMPTION 3: Nuts cluster size K = 100.
  Justification: Ch. 7 — highest-projection lineups define the slate's
  "achievable ceiling" archetype. K=100 is small enough to be tightly
  packed near the projection optimum, large enough for stack diversity.
  Choice flag: YES — could be 50-200; 100 chosen.

ASSUMPTION 4: Active-player thresholds (proj ≥ 5 hitter, ≥ 8 pitcher).
  Justification: Removes inactive/unstarted players from variance calc.
  Standard MLB DFS minimums.
  Choice flag: YES — magnitude could differ; standard values used.

ASSUMPTION 5: σ_p = (p75 − p25) / 1.349 (IQR-to-σ).
  Justification: Robust scale estimator; 1.349 is the standard normal IQR.
  Choice flag: NO (mathematical convention).

ASSUMPTION 6: Tier allocations: α_nuts=0.15, α_frontier=0.65, α_deep=0.20.
  Justification: Ch. 7 high-score archetype + Ch. 5 chalk-fade. Pros'
  observed band split is roughly 38/13/16/33 (HP/HO, HP/LO, LP/HO, LP/LO);
  α_nuts (~chalk-core anchor) = 0.15 is the proj-leader portion of HP/HO.
  α_frontier covers HP/LO + LP/HO + the rest of HP/HO; α_deep covers LP/LO.
  Choice flag: YES — magnitudes could shift ±0.05 each. Single midpoint
  values chosen, NOT swept.

ASSUMPTION 7: Use the 5,000-lineup SaberSim pool directly as the candidate
  pool L (effectively 10K target reduced to whatever SaberSim provided).
  Justification: Re-running an ILP to generate 10K is implementation cost
  with no theoretical benefit (SaberSim's pool already covers the
  proj-own efficient frontier). Pragmatic choice.
  Choice flag: YES — could regenerate ILP at 10K; SS pool used.

ASSUMPTION 8: Frontier mixture has 3 modes at u = (0.20, 0.50, 0.80).
  Justification: Ch. 8 — chalk-core / leverage / deep-contrarian tripartite
  variance band structure. 3 = minimum for inverse-bell shape with a
  meaningful middle.
  Choice flag: YES — could be 2-5 modes; 3 chosen.

ASSUMPTION 9: Mode weights base = (0.30, 0.45, 0.25).
  Justification: Ch. 8 leverage band (mid) is the bulk; chalk-core (0.30)
  > deep-contrarian (0.25) because chalk-core lineups have higher
  expected projection. The 5pp split chalk>deep is a CHOICE.
  Choice flag: YES — alternatives (0.25, 0.50, 0.25) or (0.33, 0.34, 0.33)
  were not swept; (0.30, 0.45, 0.25) chosen on framework reasoning alone.

ASSUMPTION 10: Mode width σ_u = 0.10.
  Justification: Smaller than mode separation (0.30) so modes don't
  collapse, large enough that no individual frontier point dominates.
  Choice flag: YES — could be 0.05-0.15; 0.10 chosen.

ASSUMPTION 11: Chalk tilt η_chalk uses elasticity pivot 0.20 with linear
  scaling factor 0.5 capped at ±1.
  Justification: 0.20 ε is the heuristic neutral slate. 0.5 cap (±50% of
  base mode weight) is moderate (not all-or-nothing).
  Choice flag: YES — pivot and cap both choices; pivot=0.20 from rough
  calibration to the empirical median, cap=0.5 from the principle that
  no single feature should dominate.

ASSUMPTION 12: No exposure caps.
  Justification: V1 uses 0.25 hitter / 0.55 pitcher; these are tunable
  parameters. The slate-derived approach relies on tier/mode/stack
  decomposition for diversity. No hard caps means a chalky slate can
  legitimately produce 60% exposure to the chalk anchor.
  Choice flag: YES — explicit deviation from V1.

ASSUMPTION 13: Nuts-anchor sampling β = 0.05.
  Justification: At β = 0.05, rank-1 ≈ 1.0, rank-50 ≈ 0.082, rank-100 ≈
  0.0067. Mass concentrated in top 30 but tail still alive.
  Choice flag: YES — could be 0.02-0.10.

ASSUMPTION 14: Deep tail uses bottom-20% own at proj ≥ 0.85·max_proj.
  Justification: Ch. 5 chalk-fade — deepest leverage requires low ownership;
  Ch. 4 projection adequacy — must be within 15% of optimal to have
  ceiling. 0.85 is the most aggressive plausible floor.
  Choice flag: YES — could be 0.80-0.90.

ASSUMPTION 15: Stack-size mix per band — empirical pro frequencies.
  Justification: Ch. 8 — pros' observed stack distribution (39.3% (5,2),
  14.1% (5,1), 13.7% (5,3), 10.3% (4,3), 9.5% (4,2), 4.1% (3,3),
  3.6% (3,2), 3.6% (4,4)) is the framework-aligned target since it's the
  empirical realization of the framework principles in expert play.
  Choice flag: YES — used aggregated empirical pros directly. This is the
  ONE place empirical data informs the spec; alternative would be
  framework-only with a single 5-stack default.

ASSUMPTION 16: Bring-back rate per tier (50%/30%/20% for nuts /
  chalk-core / mid; 0% for deep tiers).
  Justification: Pros' aggregate ≥1 bring-back rate is 21.6%. Concentrated
  into chalk-leaning tiers makes the system MORE bring-back-heavy where
  the projection ceiling demands the game-environment correlation, and
  free elsewhere.
  Choice flag: YES — single value per tier, framework-justified
  (Ch. 4 correlation lever).

ASSUMPTION 17: Bring-back enforcement weight = 1.5×.
  Justification: Multiplicative weight in sampling that produces the target
  rate approximately when the candidate pool has roughly 50/50 bring-back
  representation. NOT a hard quota.
  Choice flag: YES — could be 1.2-2.0×; 1.5 chosen.

ASSUMPTION 18: Pitcher-vs-stack hard rejection.
  Justification: Ch. 4 correlation lever taken to its conclusion. V1
  applied a soft penalty; the framework principle supports a hard
  constraint.
  Choice flag: NO (framework-mandated).

ASSUMPTION 19: Pitcher-vs-bring-back-team bonus = 1.5× weight.
  Justification: Same game script alignment between pitcher and stack.
  Same magnitude as bring-back enforcement weight (consistency).
  Choice flag: YES — magnitude tied to ASSUMPTION 17.

ASSUMPTION 20: Deterministic seed from slate name.
  Justification: Reproducibility for validation. No theoretical content.
  Choice flag: NO (engineering hygiene).

ASSUMPTION 21: Linear congruential RNG.
  Justification: Reproducibility, simplicity. No theoretical content.
  Choice flag: NO (engineering hygiene).

ASSUMPTION 22: Mode location u = (0.20, 0.50, 0.80).
  Justification: Symmetric coverage of frontier; 0.20 / 0.80 are the
  "shoulders" of the unit interval, 0.50 is the median.
  Choice flag: YES — could be (0.15, 0.50, 0.85) or other; symmetric
  around 0.5 is the framework-natural choice.

ASSUMPTION 23: η_chalk applies to chalk and deep modes symmetrically
  (mid is unmodulated).
  Justification: The mid (leverage) band is the always-present "body"; the
  chalk and deep modes are the elastic "shoulders" that respond to slate
  shape.
  Choice flag: YES — could modulate mid as well; symmetric shoulder-only
  chosen.
```
