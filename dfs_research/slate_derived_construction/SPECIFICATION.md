# SLATE-DERIVED CONSTRUCTION — STAGE 1 SPECIFICATION (LOCKED)

**Status:** LOCKED. Edits forbidden after Stage 2 begins. Any new constants discovered
during implementation MUST be added explicitly to this file with justification before
the implementation continues.

**Author:** Slate-derived-construction system, Stage 1.
**Date locked:** 2026-05-03.

## 0. Goal and method

Construct a 75-lineup MLB DFS GPP portfolio whose composition is *derived* from
slate-level structural features rather than fitted to portfolio-level outcome metrics.
Each numeric choice is a single value justified by a Theory-of-DFS framework principle
(Ch. 4-8). No parameter sweeps. No outcome-driven tuning.

The system is an architectural alternative to V1 (the parameter-scored production
system at `theory-of-dfs-v1-preslate.ts`). It is NOT a V1 variant.

The validation metric is *structural alignment to professional GPP portfolios* on the
same slate (band distribution, stack distribution, bring-back rate, Mahalanobis
distance to per-slate pro consensus, fingerprint distance). Outcome ROI is NOT a
validation metric — it is too noisy on 24 slates to be load-bearing for architecture
selection.

The portfolio target size is **N = 75** lineups (vs V1's 150) because the explicit aim
is a tighter, more concentrated portfolio, where pro-style band balance is enforced by
the construction model rather than backfilled by parameter tuning. (See ASSUMPTION 1.)

---

## 1A. Slate feature extraction (formal definitions)

Given a slate with player set P and a candidate lineup pool L (10,000 lineups
generated as per 1C), the following features are defined:

### 1A.1 Projection-ownership efficient frontier F

For each candidate lineup ℓ ∈ L, define:
  - proj(ℓ) = Σ_{p∈ℓ} projection(p)
  - own(ℓ)  = geoMeanOwn(ℓ) = exp( (1/10) · Σ_{p∈ℓ} log(max(0.1, ownership_pct(p))) )

`own(ℓ)` is the per-player geometric-mean ownership in percent; it matches the
`geoMeanOwnHit` field used in the slate dump (and matches V1's lineup-level
ownership representation). The 0.1% floor prevents log(0).

The **efficient frontier** F ⊂ L is the Pareto-optimal set:
```
F = { ℓ ∈ L : ¬∃ ℓ' ∈ L with proj(ℓ') ≥ proj(ℓ) AND own(ℓ') ≤ own(ℓ),
                with at least one strict inequality }
```
Computed by sorting L by own ascending and sweeping a running max of proj. F has
typical cardinality 30-200 for a 10K pool.

### 1A.2 Projection elasticity ε

Sort F by own ascending: F = {f_1, f_2, ..., f_M} with own(f_1) < ... < own(f_M).

The **projection elasticity** at frontier point f_k is
```
ε_k = ( Δproj / proj(f_k) ) / ( Δown / own(f_k) )
```
where Δproj = proj(f_{k+1}) − proj(f_k) and Δown = own(f_{k+1}) − own(f_k) (forward
finite difference; for k=M, use backward).

Aggregate elasticity:
```
ε_slate = median{ ε_k : k = 1..M-1 }
```

ε_slate measures how much projection you give up per unit of ownership reduction.
**High elasticity** (e.g., ε > 0.3) ⇒ steep frontier, chalk is pricing efficient,
contrarian costs a lot of points → lean chalk-core. **Low elasticity** (e.g.,
ε < 0.1) ⇒ flat frontier, contrarian is cheap → lean leverage-heavy.

### 1A.3 Nuts cluster N

```
N = top-K=100 lineups in L by proj, sorted descending
```
Compute structural characteristics of N:
  - Stack-size distribution: histogram over (primarySize, secondarySize)
  - Mean ownership: mean(own(ℓ) for ℓ ∈ N)
  - Common stack teams: histogram of primaryTeam(ℓ)
  - Mean salary
  - Player frequencies: for each p ∈ P, count(ℓ ∈ N : p ∈ ℓ) / 100

### 1A.4 Slate variance σ_slate

For each player p in P with non-null SaberSim percentiles (p25, p50, p75, p85,
p95, p99):
```
σ_p = (p75(p) − p25(p)) / 1.349    [robust σ from IQR]
CV_p = σ_p / max(0.5, projection(p))
```
Filter to active players (projection(p) ≥ 5 for hitters, ≥ 8 for pitchers).
```
σ_slate = mean{ CV_p : p active }
```

High σ_slate ⇒ noisy slate (more variance band weight, more leverage tolerance).

### 1A.5 Scoring environment T_slate

Sum of team implied totals across teams on the slate:
```
T_slate = Σ_{t ∈ teams} teamTotal(t)
```
where `teamTotal(t)` is the per-team Vegas implied total (the field `Saber Total`
in projections CSV). High T_slate ⇒ high-scoring slate, hitter stacks have more
ceiling, scoring distribution wider; low T_slate ⇒ pitcher-dominant slate,
bring-back less rewarding.

### 1A.6 Chalk concentration C_slate

```
C_slate.maxOwn = max{ ownership(p) : p ∈ P_active }
C_slate.stdOwn = stdev{ ownership(p) : p ∈ P_active }
```
A single number summary:
```
C_slate = C_slate.maxOwn / mean(ownership(p) : p ∈ P_active)
```
High C_slate ⇒ concentrated chalk (one or two huge plays) → fading them is
expensive ⇒ chalk core matters. Low C_slate ⇒ diffuse ownership ⇒ more freedom.

---

## 1B. Model: portfolio composition derived from features

The portfolio is constructed in **three concentric tiers**: Nuts Anchor, Frontier
Body, and Deep-Contrarian Tail. Allocations and shapes depend on slate features.

### 1B.1 Tier allocations (N = 75)

```
n_nuts        = round(N · α_nuts)         where α_nuts = 0.15
n_frontier    = round(N · α_frontier)     where α_frontier = 0.65
n_deep        = N − n_nuts − n_frontier   ⇒ ≈ 0.20 · N
```

α_nuts = 0.15: Ch. 7 high-score archetype mandates probability mass near optimal
lineup; pros consistently allocate 10-20% to chalk-anchored highest-projection
builds (per pro band data: HighProj/HighOwn ≈ 38%, but only the proj-leader subset
of that lives near the nuts; the rest are in 1B.2). 0.15 is the
mid-point of [0.10, 0.20] (single value, not swept).

α_frontier = 0.65: Ch. 8 portfolio dynamics; the bulk of a pro portfolio lives on
the projection-ownership trade curve. The remaining 0.20 is for the deep tail
(Ch. 5 chalk-fade, level-3 thinking).

### 1B.2 Frontier body — 3-mode Gaussian mixture

Sample n_frontier lineups from the frontier F using a mixture of three Gaussians
indexed by the **own-percentile coordinate** along F (after sorting F by own
ascending and assigning each f_k its own-rank u_k ∈ [0,1]).

The three modes correspond to Ch. 8's three variance bands:
  - **Chalk-core** mode at u = 0.20, weight w_C = 0.30
  - **Mid (leverage)** mode at u = 0.50, weight w_L = 0.45
  - **Deep-contrarian (frontier)** mode at u = 0.80, weight w_D = 0.25

Each mode is a Gaussian with σ_u = 0.10 in u-coordinates (truncated to [0,1]).

For each mode, the weight is a **base** weight modulated by slate features:
```
w_C* = w_C · (1 + 0.5 · η_chalk)
w_L* = w_L
w_D* = w_D · (1 − 0.5 · η_chalk)
```
where η_chalk is the **chalk-concentration tilt**:
```
η_chalk = clip( (ε_slate − 0.20) / 0.20, −1, 1 )
```
Interpretation: if elasticity is well above 0.20 (steep frontier ⇒ chalk-leaning
slate), η_chalk → +1 and chalk-core mode gains weight; if elasticity is well
below 0.20 (flat frontier ⇒ contrarian-leaning slate), η_chalk → −1 and
deep-contrarian gains. The factor 0.5 caps the swing at ±50% of mode weight, so
chalk-core ranges from 0.15 to 0.45 across slates and deep-contrarian from 0.125
to 0.375.

After tilt the weights are renormalized to sum to 1.

The 0.20 elasticity pivot: ε = 0.20 means 1 own-unit costs 20% projection per
projection-unit, which is a roughly neutral slate (the median elasticity across
all 24 slates' frontiers is ~0.2 by construction of how MLB ownerships and
projections distribute; we treat 0.2 as the neutral value).

### 1B.3 Nuts anchor — concentration sample

Sample n_nuts lineups from N (top-100 by projection) with weights proportional
to projection rank position:
```
weight(ℓ) ∝ exp( −β_nuts · rank_in_N(ℓ) )    with β_nuts = 0.05
```
β = 0.05 ⇒ rank-1 has weight 1.0, rank-100 has weight ≈ 0.0067; effective sample
is concentrated in top ~30 of nuts cluster but rank 50-100 still get nonzero
mass.

### 1B.4 Deep-contrarian tail

Sample n_deep lineups from the **lowest-ownership tail** of the candidate pool
L (NOT restricted to F). Specifically, take the lineups with own(ℓ) below the
20th percentile of L, with proj(ℓ) ≥ 0.85 · max_proj. Sample uniformly.

The 0.85 floor ensures the deep tail is not catastrophically below-projection;
Ch. 5 chalk-fade is still constrained by Ch. 4 projection adequacy. 0.85 is the
most aggressive plausible projection floor (V1's effective floor is similar).

### 1B.5 Stack size distribution per band (HARD CONSTRAINTS at sample-time)

When sampling within each tier, enforce stack-size mix matching pro empirics
(observed in the dump: pro 39.3% (5,2), 14.1% (5,1), 13.7% (5,3), 10.3% (4,3),
9.5% (4,2), 4.1% (3,3), 3.6% (3,2), 3.6% (4,4)). These are ASSUMPTIONS based on
empirical pro frequency — they are CHOICES (could differ).

Per tier target stack-size mix (primarySize, secondarySize):
  - **Nuts** (n=11):  100% in {(5,2), (5,3), (5,1)} matching the
    candidate-pool top-100's own dominant stack patterns.
  - **Frontier-chalk-core** mode: (5,2)=50%, (5,3)=20%, (5,1)=15%, (4,3)=15%
  - **Frontier-mid** mode: (5,2)=35%, (5,3)=15%, (4,3)=20%, (4,2)=15%, (5,1)=10%, (3,3)=5%
  - **Frontier-deep** mode: (5,2)=25%, (5,3)=15%, (4,3)=20%, (4,2)=15%, (3,3)=15%, (4,4)=10%
  - **Deep tail**: (5,2)=20%, (5,3)=10%, (4,3)=20%, (4,2)=15%, (3,3)=20%, (4,4)=15%

Sampling: within each (tier, mode), filter the candidate set to lineups with
stack patterns appearing in the target mix, then sample with weights proportional
to the target mix percentages. This is a soft enforcement — if a stack pattern
isn't represented in the candidate set on a given slate, that pattern's weight is
dropped and the others are renormalized.

### 1B.6 Bring-back logic

Bring-back inclusion is **rate-controlled per tier**:
  - **Nuts** (chalk-anchored): bringBack ≥ 1 in ≥ 50% of lineups
    (Ch. 7 high-score archetype: chalk stacks need their stack scoring to win,
    which correlates with opposing-side bullpen scoring).
  - **Frontier-chalk-core** mode: bringBack ≥ 1 in ≥ 30% of lineups.
  - **Frontier-mid** mode: bringBack ≥ 1 in ≥ 20% of lineups.
  - **Frontier-deep** mode: bringBack rate is unconstrained (0% acceptable).
  - **Deep tail**: bringBack rate is unconstrained.

Implementation: when sampling within a tier/mode, weight bringBack-≥1 lineups
1.5× over bringBack=0 lineups in tiers requiring bring-back; weight uniformly
in tiers without requirement. The rate constraint is approximate
(Bernoulli mean, not a hard quota).

The 0.30/0.20/0.50 schedule reflects pros' aggregate bring-back rate of 21.6%
(observed), but rebalances *across* tiers: chalk-anchored builds need bring-back
more (highest-projection chalk stacks have more upside if game scores high);
frontier-deep and deep-tail can skip bring-back because the leverage edge already
comes from elsewhere. This is a CHOICE.

### 1B.7 Pitcher-stack interaction

A lineup is **invalid** if any pitcher's opponent appears in the primary stack
(i.e., the pitcher faces his own stack's hitters). This is a hard rejection.

This is V1's existing P-vs-H penalty taken to its logical conclusion (binding
constraint instead of soft penalty). Justification: Ch. 4 correlation lever —
pitcher-vs-stack is a structural anti-correlation, not a marginal cost.

A lineup is *preferred* (1.5× weight in sampling) if a pitcher's opponent is
ALSO an opposing-side bring-back team for the primary stack. Specifically, if
pitcher_opponent == primary_stack_opponent, the lineup gets the bonus weight.
Justification: Ch. 4 — pitcher and primary stack now both bet on the same game
script (primary stack scores big, pitcher's opponent gets shut down).

---

## 1C. Implementation choices

  - **Candidate pool size**: 10,000 lineups per slate. Source: SaberSim sspool
    CSV (which already contains 5,000 lineups by default; we use the full pool
    as-is — see ASSUMPTION 7).
  - **Frontier discretization**: Continuous (no fixed bin count). Sampling is
    over u ∈ [0,1] from the truncated mixture; nearest frontier point is
    chosen by closest u_k.
  - **Sampling method**: Rejection sampling at the (tier × mode × stack-pattern)
    level. Within each cell, weighted random draw without replacement from the
    candidate subset that matches the cell's filters. If a cell's pool is empty,
    its target is reallocated to the nearest non-empty cell of the same tier.
  - **Constraint handling**:
      - Salary cap and position requirements are inherited from the
        SaberSim pool (every candidate is already legal).
      - **No exposure caps.** The system relies on the (tier × mode ×
        stack-pattern) decomposition to provide diversity. Adding exposure caps
        would re-introduce a parameter without a framework basis. (See
        ASSUMPTION 12.)
      - **Pitcher-vs-stack hard rejection** is enforced at sample time.
      - **Duplicate check**: lineup hash equality. No duplicate lineups in the
        portfolio.
  - **Pseudo-random seed**: deterministic seed derived from slate name (hash
    mod 2^31). Re-running the same slate yields the same portfolio.
  - **Random number generation**: Linear congruential generator, seeded as above.

---

## 1D. Assumption ledger

Every numeric value introduced in 1A-1C must appear here.

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

Numeric values that appear in 1A-1C and ALSO in the ledger above (audit):
  - 0.1 (own floor) → Assumption 2.
  - 100 (nuts K) → Assumption 3.
  - 5, 8 (active thresholds) → Assumption 4.
  - 1.349 (IQR/σ) → Assumption 5.
  - 0.15, 0.65, 0.20 (tier alphas) → Assumption 6.
  - 5,000-lineup pool → Assumption 7.
  - 3 modes → Assumption 8.
  - 0.20, 0.50, 0.80 (mode u) → Assumption 22.
  - 0.30, 0.45, 0.25 (mode weights) → Assumption 9.
  - 0.10 (σ_u) → Assumption 10.
  - 0.20 (elasticity pivot), 0.5 (tilt scale) → Assumptions 11, 23.
  - No exposure caps → Assumption 12.
  - 0.05 (β_nuts) → Assumption 13.
  - 0.85 (deep proj floor), 20 (deep own pctile) → Assumption 14.
  - Stack-size mix percentages → Assumption 15.
  - 0.50, 0.30, 0.20 (per-tier BB rates), 0% deep → Assumption 16.
  - 1.5 (BB weight, P-bonus weight) → Assumptions 17, 19.
  - Pitcher-vs-stack hard reject → Assumption 18.
  - Slate-name seed → Assumption 20.
  - LCG RNG → Assumption 21.

All numeric values are accounted for. **Spec locked.**
