# Methodology Lock

**Locked:** 2026-05-03
**Analyst:** Outcome-conditional construction-pattern study
**Question:** Which CONSTRUCTION-LEVEL patterns distinguish V1's outperforming slates from V1's underperforming slates?

This document is FROZEN before any computation. All metrics, thresholds, and tests below are pre-specified and will be reported regardless of significance. No iteration on metric definitions after lock.

---

## Data

- Source: `C:/Users/colin/dfs opto/theory_dfs_v2/v1_pros_lineup_dump.json`
- 24 slates (4-6-26 through 5-3-26)
- Per slate: V1 portfolio (~150 lineups) + 8 pros' portfolios (~150 each, ~1200 total)
- Per lineup: pids, names, teams, salaries, owns, projection, primaryTeam, primarySize, secondarySize, bringBack, finishPct, actual, plus derived fields
- Convention: `finishPct = (totalEntries - rank) / totalEntries`. Higher finishPct = better finish. Top 0.1% = `finishPct >= 0.999`. Top 1% = `finishPct >= 0.99`.

---

## Stage 2: Outcome classification rules

For each slate s:

1. **V1 top-0.1% rate:**  `v1_top01[s] = (# V1 lineups with finishPct >= 0.999) / |V1 portfolio|`
2. **Pro avg top-0.1% rate:**  for each of 8 pros, compute their top-0.1% rate; `pro_avg_top01[s] = mean across 8 pros`
3. **Ratio:**  `r[s] = v1_top01[s] / pro_avg_top01[s]` (if pro_avg = 0, see tie-breaker rule below)

Classification:
- **Outperformed:**  r[s] > 1.5
- **Matched:**  0.5 <= r[s] <= 1.5  (i.e. within ±50% of pro avg)
- **Underperformed:**  r[s] < 0.5

**Tie-breaker / divide-by-zero rule:** If `pro_avg_top01[s] == 0`:
- If `v1_top01[s] > 0`: classify as Outperformed
- If `v1_top01[s] == 0`: fall through to top-1% comparison

**Top-1% secondary tiebreaker:** If a slate's classification is ambiguous because both V1 and pros have 0 top-0.1% (rare but possible), use top-1% rates with the same ratio rule.

Output: `per_slate_classification.csv` — columns: slate, totalEntries, v1_top01_rate, pro_avg_top01_rate, ratio_top01, v1_top1_rate, pro_avg_top1_rate, ratio_top1, classification.

---

## Stage 3: Construction metrics (pre-specified, fixed before computation)

All metrics computed at the per-slate, per-V1-portfolio level. One row per slate.

### 1. Stack-size distribution (4 sub-metrics)
- `pct_5stack` = fraction of V1 lineups with primarySize == 5
- `pct_4stack` = fraction with primarySize == 4
- `pct_33split` = fraction with primarySize == 3 AND secondarySize == 3
- `pct_nostack` = fraction with primarySize <= 2

### 2. Bring-back rate
- `bb_rate` = fraction of V1 lineups with `bringBack >= 1`

### 3. Bring-back size distribution (within BB lineups)
- `bb_size1_pct` = of BB lineups, fraction with `bringBack == 1`
- `bb_size2plus_pct` = of BB lineups, fraction with `bringBack >= 2`

### 4. Salary distribution shape (per-lineup `salaryTotal`)
- `salary_mean`, `salary_std`, `salary_range` (max - min across portfolio)

### 5. Ownership distribution shape (per-lineup `geoMeanOwnHit`, fall back to `ownAvg` if missing)
- `own_mean`, `own_std`, `own_range`

### 6. Projection distribution shape (per-lineup `projection`)
- `proj_mean`, `proj_std`, `proj_range`

### 7. Band distribution (slate-relative median split)
For each slate, compute:
- `proj_median` = median of `projection` across V1 portfolio
- `own_median` = median of `geoMeanOwnHit` (or `ownAvg`) across V1 portfolio

Each lineup gets one of 4 bands:
- HP/HO = projection >= proj_median AND own >= own_median
- HP/LO = projection >= proj_median AND own < own_median
- LP/HO = projection < proj_median AND own >= own_median
- LP/LO = projection < proj_median AND own < own_median

Metrics: `pct_HP_HO`, `pct_HP_LO`, `pct_LP_HO`, `pct_LP_LO`.

### 8. Within-portfolio Jaccard
- `mean_jaccard` = mean pairwise Jaccard over hitter pids (exclude pitcher pids) across all lineup pairs in V1 portfolio. Use hitter set (8 hitters per lineup) so stack overlap dominates over pitcher overlap.

### 9. Construction archetype (5-categorical, lineup-level)
Each lineup classified into exactly ONE archetype using these decision rules (evaluated in order, first match wins):

1. **pitcher-tournament:** both pitchers in top-3 by slate projection (i.e. ace+ace pairing). Slate "ace" = top-3 pitchers ranked by projection in the slate's full pool. Approximated using `pitcherIds` from this slate's lineups: pitchers are ranked across all lineups by their projection contribution; the top-3 unique pitcher IDs by projection are the slate aces. (If projection unavailable per pitcher, use frequency-weighted salary as proxy.)
2. **chalk-anchor-with-BB:** primarySize >= 5 AND bringBack >= 1 AND any hitter in lineup has own >= 30%.
3. **mid-tier-5-stack:** primarySize == 5 AND no hitter has own >= 30% AND mean hitter own < slate-median.
4. **contrarian-3-3-split:** primarySize == 3 AND secondarySize == 3.
5. **salary-spread-balanced:** otherwise (residual bucket — salaryStd > 0 expected).

Portfolio-level metrics: `pct_archetype_<name>` for each of 5 archetypes.

### 10. Pitcher archetype
For each slate, rank pitchers by projection (using slate-wide pitcher pool inferred from the union of all `pitcherIds` × `pitcherProjection` across V1 + pros lineups; pitcher's "slate projection" = max projection observed for that pitcher in any lineup). Then:
- Ace = rank 1-3
- Mid = rank 4-10
- Value = rank 11+

Per V1 portfolio:
- `pct_ace_pitcher` = fraction of lineup-pitcher-slots filled with an ace pitcher
- `pct_mid_pitcher` = mid
- `pct_value_pitcher` = value

(Each lineup has 2 pitchers; sum across all 2N pitcher slots.)

### 11. Mean lineup projection
- `proj_mean` (already in metric 6 — also reported separately for clarity).

---

## Stage 4: Statistical comparison

For each metric m:
- Group A = V1 metric values across Outperformed slates
- Group B = V1 metric values across Underperformed slates
- Test: **Mann-Whitney U** (two-sided), report U statistic and p-value
- Effect size: **rank-biserial correlation** `r_rb = 1 - 2U / (n1*n2)` (range -1 to +1)
- 95% CI for r_rb via bootstrap (1000 resamples) on the two groups

**Multiple-comparisons correction:** Bonferroni. Counting metrics that yield one test each:
- Stack dist: 4 (5stack, 4stack, 33split, nostack)
- BB rate: 1
- BB size dist: 2
- Salary shape: 3 (mean, std, range)
- Own shape: 3
- Proj shape: 3
- Band dist: 4
- Jaccard: 1
- Archetypes: 5
- Pitcher archetype: 3
- Total = **29 tests**

Bonferroni-corrected significance threshold: `p < 0.05 / 29 = 0.00172`. We will additionally report the user-specified threshold `p < 0.003` (matching the brief's "15-test" framing) as a secondary, more lenient cutoff. **No finding will be promoted as significant unless p < 0.00172** (the strict Bonferroni-corrected threshold for the actual test count). Findings between 0.00172 < p < 0.05 are reported descriptively as "suggestive, not corrected-significant."

Also report Matched group means for context.

Output: `outcome_comparison_table.csv` — columns: metric, n_outperformed, n_matched, n_underperformed, mean_outperformed, mean_matched, mean_underperformed, U_statistic, p_value, effect_size_r_rb, ci_low, ci_high, bonferroni_significant_strict, suggestive_p003.

---

## Stage 5: Slate-feature correlations

Slate features (computed independently of V1 portfolio):
- `slate_variance_index` = mean across active hitters of (player_proj_std / mean) — but our data only has lineup-level projections. **Approximation:** use std/mean of player projections as observed across all lineup mentions. Per-slate, compute for each pid the mean of its own per-lineup projection contribution if available; else use V1 portfolio per-lineup projection std/mean as a proxy. **Specific definition:** for each unique pid in V1's portfolio, compute the count and use slate-wide proj std / proj mean of V1-portfolio projections (proxy for slate variance). Document this proxy choice in FINDINGS.
- `scoring_environment` = mean V1 lineup projection × 9 (proxy; team implied totals not in dump)
- `anchor_ownership` = max single-player ownership observed in V1 portfolio (= max across all (lineup, hitter) of `owns`)
- `player_pool_size` = count of unique pids appearing in V1 portfolio (proxy for V1's effective pool; true slate pool size not directly available)
- `projection_concentration_gini` = Gini coefficient of usage counts across pids in V1 portfolio (high Gini = chalk-concentrated; low Gini = spread)

Compare slate features between Outperformed and Underperformed via Mann-Whitney U with the same Bonferroni framework (5 additional tests; for these slate-feature tests, treat as a separate family with `p < 0.05 / 5 = 0.01` threshold and report).

Also compute Spearman ρ between each slate feature and the continuous outcome variable `ratio_top01` (V1's relative performance).

---

## Stage 6: FINDINGS write-up

`FINDINGS.md` will report:
1. Slate outcome counts
2. Full construction-metric comparison table with p-values + effect sizes + 95% CIs (all 29 tests, regardless of significance)
3. Top 3 differentiating patterns (lowest p, largest |effect size|), characterized in plain language
4. Slate feature correlations
5. Verdict: edge mechanism identified at construction level (only if at least one metric passes Bonferroni-corrected threshold AND has |effect size| >= 0.4) OR irreducible variance (otherwise)
6. Honest interpretation; no deployment recommendations; no specific players/teams.

---

## Constraints (re-affirmed)

1. Construction-level only. No specific players or teams reported.
2. Bonferroni correction applied.
3. All metrics reported regardless of significance.
4. n=24 small. Effect sizes + 95% CIs reported.
5. Outcome classification rules above are FIXED before computation.
6. No system designs.
