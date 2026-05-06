# Cross-Cell Coupling Analysis — Methodology Lock

**Locked:** 2026-05-03
**Purpose:** Descriptive measurement of cross-cell coupling. Test whether pros couple decisions across lineup positions in coordinated ways, producing the residual 76× pairwise-correlation gap.

This document is LOCKED before any computation. All decisions below are pre-registered. No iterative tuning to produce stronger findings.

---

## 1. Data

- **Source:** `C:/Users/colin/dfs opto/theory_dfs_v2/v1_pros_lineup_dump.json`
- **Slates:** 24 MLB slates 4-6-26 -> 5-3-26
- **Entities:**
  - `v1` (150 lineups per slate)
  - 8 pros per slate (each with 150 lineups): `b_heals152, bgreseth, needlunchmoney, nerdytenor, shaidyadvice, shipmymoney, youdacao, zroth2`
  - Note: prompt mentions 9 pros (`zroth, zroth2, ...`); only `zroth2` is present in the dump. Analysis runs on the 8 actually present.
- **Group by:** entity (v1 or pro user) within slate.

## 2. Cell Definitions (verbatim from prompt)

- **Cell 1 (Primary stack hitter set):** the N players from `primaryTeam` where N = `primarySize` (4 or 5). Hitter set identified by sorted player IDs (excluding pitchers).
- **Cell 2 (Bring-back hitter set):** the hitter(s) from primary team's opponent (the "bring-back" team). If `bringBack = 0`, Cell 2 = the categorical literal `"NO_BRINGBACK"`. Otherwise Cell 2 = sorted set of opponent-team hitter IDs.
  - Opponent team = the team identifier in `pitcherOpps` that matches the primary team's opponent. Implementation: identify primary team's opponent on the slate via the pitcher whose `pitcherOpps` entry equals `primaryTeam` -> that pitcher's `pitcherTeams` value is the primary team's opponent. As a fallback: any non-pitcher hitter whose team appears alongside the primary team in the same matchup is treated as the bring-back team. The simpler operational definition (used here): for each lineup, identify the set of non-primary, non-pitcher hitter teams; the "bring-back team" is the team that has `bringBack > 0` hitters and is the opponent of the primary stack. We obtain this directly by counting non-pitcher hitter teams in the lineup; if `bringBack > 0` we take the team contributing exactly `bringBack` hitters (and not `primaryTeam`). Cell 2 = sorted tuple of those hitter IDs.
- **Cell 3 (Pitcher selection):** the pitcher(s) in the lineup. Pitcher set = sorted tuple of `pitcherIds`.
- **Cell 4 (One-off hitter slots):** remaining hitter slots not in primary stack or bring-back. Optional; main analysis is Cell1 x Cell2 x Cell3.

Each cell value is a sorted tuple of player IDs (or the categorical `"NO_BRINGBACK"` for Cell 2 when `bringBack = 0`).

## 3. Marginal Concentration (Stage 2)

For each `(entity, slate)` instance:

- **Cell 1 marginal (top-1 share):** group lineups by `primaryTeam`; within each primary team subset, compute `share = count(top1 Cell1 set) / count(lineups in subset)`. Aggregate across primary teams via lineup-weighted average. Equivalent: `share = sum_{primaryTeam t} max_{set s} count(t,s) / total_lineups_in_(entity,slate)`.
- **Cell 2 marginal (top-1 share):** condition on `(primaryTeam, bringBackTeam)`. The `"NO_BRINGBACK"` category is grouped under primaryTeam alone (no bring-back team). Top-1 share is lineup-weighted across `(primaryTeam, bringBackTeam)` cells.
- **Cell 3 marginal:** across all lineups in the (entity, slate), top-1, top-2, top-3 pitcher-set shares.
- **Cell 4 marginal (optional):** top-1 one-off hitter pattern share, conditioned on (Cell1, Cell2). Reported as a sanity check only.

## 4. Joint Concentration (Stage 3)

Per `(entity, slate)` instance, computed conditional on the most-frequent cells (i.e., we restrict to the entity's top-1 primaryTeam to make the joint comparable across entities, and within that primaryTeam to its top-1 (Cell1, Cell2, Cell3) values).

Concretely, for the (entity, slate) restricted to the top-1 `primaryTeam` only:

- Let `c1*` = most-frequent Cell 1 value, with marginal frequency `p1 = freq(c1*)`.
- Let `c2*` = most-frequent Cell 2 value, with marginal frequency `p2 = freq(c2*)`.
- Let `c3*` = most-frequent Cell 3 value, with marginal frequency `p3 = freq(c3*)`.

Joint frequencies:
- `p_12 = freq(c1*, c2*)`  joint observed
- `p_13 = freq(c1*, c3*)`
- `p_23 = freq(c2*, c3*)`
- `p_123 = freq(c1*, c2*, c3*)`

**Coupling coefficients:**
```
coupling(C1, C2) = p_12 / (p1 * p2)
coupling(C1, C3) = p_13 / (p1 * p3)
coupling(C2, C3) = p_23 / (p2 * p3)
coupling(C1,C2,C3) = p_123 / (p1 * p2 * p3)
```

- coupling = 1.0 -> independent
- coupling > 1.0 -> coupled (joint observed > independence-predicted)
- coupling < 1.0 -> anti-coupled

## 5. Aggregate Coupling Comparison (Stage 4)

Per entity, aggregate coupling across (entity, slate) instances passing filter (see 7).
Aggregation = unweighted arithmetic mean of coupling coefficients across instances (one observation per (entity, slate)).

Pro average = unweighted arithmetic mean across the 8 pros' aggregate values. (NOT pooled across all pro-slate instances; per-pro aggregate first, then average.)

Output: `coupling_coefficient_table.csv`.

## 6. Bootstrap Confidence Intervals

- **Method:** non-parametric bootstrap over (entity, slate) instances.
- **Resamples:** 10,000.
- **Seed:** 42 (numpy RNG).
- For each entity and each metric (the four coupling coefficients), resample with replacement from the entity's set of (slate) instances passing the filter, recompute the mean, and report the 2.5th and 97.5th percentiles as the 95% CI.
- For "pro avg": at each bootstrap iteration, resample the 8 pros' aggregate means with replacement and average.

## 7. Sample-Size Filter

- **Threshold:** >=10 lineups per (entity, slate, primaryTeam) for stable measurement.
- We restrict to the entity's top-1 primaryTeam in each slate; that primaryTeam must have >=10 lineups.
- (entity, slate) instances that fail the filter are dropped from coupling calculations for that slate (logged in output).
- For Cell 2 marginal calculations involving `(primaryTeam, bringBackTeam)`, no additional filter is applied; we condition on the entity's top-1 primaryTeam and report the modal bring-back regardless of cell sample size, because top-1 share is well defined even on small cells. (Documented as a known limitation for very small bring-back cells.)

## 8. Mathematical Reconciliation (Stage 5)

Between two random lineups within an entity's portfolio, the probability they share the SAME (Cell1, Cell2, Cell3) joint value is:
```
P_match_joint ≈ sum_v p(v)^2  (Herfindahl over joint-set distribution)
```
For a quick comparison we use the dominance approximation:
```
P_match_joint_approx ≈ p_123^2
```
where p_123 is the joint top-1 frequency.

Predicted pairwise-correlation ratio between pros and V1:
```
ratio_predicted = P_match_joint(pros) / P_match_joint(V1)
```
We report both Herfindahl and dominance-approx versions. We then compare to the prior-finding 76x pairwise-correlation gap.

- If `ratio_predicted` is within ~2-3x of 76x: math reconciles, mechanism identified.
- If `ratio_predicted` is much smaller than 76x: residual gap remains.

## 9. Per-Pro Variation (Stage 6)

Per pro, compute aggregate (entity-level) coupling. Sort pros by coupling strength.

Outcome metrics (from `finishPct` field in lineups; >=0.99 = top-1% finish, otherwise compute `winRate = mean(finishPct >= 0.99)` per pro):
- `top1pct_rate = mean(finishPct >= 0.99)` across all the pro's lineups.
- `top10pct_rate = mean(finishPct >= 0.90)` across all the pro's lineups.

Compute Spearman rank correlation between pro's three-way coupling and pro's `top1pct_rate`. Report rho and p-value (descriptive only; n=8 so power is low).

Output: `per_pro_coupling_variation.csv`.

## 10. Methodology Constraints

1. Descriptive only. No system designs proposed. No parameters fit.
2. >=10-lineup filter applied (Section 7).
3. Bootstrap 95% CIs (10,000 resamples, seed=42).
4. Both marginal and joint metrics reported; multiplicative effect visible.
5. One pass. No iteration to produce stronger findings.
6. Limitations documented:
   - 24 slates is small.
   - Per-cell sample size limits some pros (especially when their top-1 primaryTeam has <10 lineups in a given slate).
   - Cell definitions may miss relevant positions (e.g., one-off correlation patterns, secondary stacks beyond bring-back).
   - We restrict the joint analysis to the entity's top-1 primaryTeam, which both stabilizes the measurement and makes coupling values comparable across entities; this means the analysis describes coupling within an entity's most-favored stack-team neighborhood, not the entire portfolio.
7. No deployment recommendations. Implications limited to research-direction language.

---

LOCK CONFIRMED. Proceeding to Stage 2.
