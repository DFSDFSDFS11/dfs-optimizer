# Pairwise Lineup Correlation Methodology

**Locked:** 2026-05-05T14:00:08Z (UTC)
**Author:** Research agent (Claude Opus 4.7, 1M context)
**Status:** LOCKED before computation begins. No parameter fitting permitted downstream.

## Purpose

Descriptive measurement: do pro DFS portfolios contain more negatively correlated lineup pairs than V1 portfolios? This is NOT a benchmark, NOT a deployment candidate, NOT a parameter search. One pass through the data, both methods reported, no iteration.

## Data

- `C:/Users/colin/dfs opto/theory_dfs_v2/v1_pros_lineup_dump.json`
- 24 MLB slates
- Per slate: V1 portfolio (75-150 lineups), pro lineups (~1000-2000) tagged with `user` field
- Pros included: zroth, zroth2, nerdytenor, shipmymoney, shaidyadvice, needlunchmoney, bgreseth, youdacao, b_heals152

## Lineup-pair correlation: definitions

Both methods are computed for every pair (L_i, L_j) within a single portfolio (V1 or single-pro within a single slate). Pairs across portfolios or across slates are NOT compared. Pair (i,j) is unordered; we compute upper-triangle only (i < j).

### Method 1: Full correlation (signed, framework R-values)

```
raw(L_i, L_j) =
    + 1.00 * count_shared_player_ids(L_i, L_j)
    - 0.30 * count_pitchers_in_Li_whose_opp_team_has_hitters_in_Lj(L_i, L_j)
    - 0.30 * count_pitchers_in_Lj_whose_opp_team_has_hitters_in_Li(L_j, L_i)
    + 0.10 * count_same_team_hitter_pairs_across_lineups_NOT_already_counted_as_shared(L_i, L_j)

normalized(L_i, L_j) = raw / 10.0
```

Framework R-values used as-is (not fit):
- shared_player coefficient: `+1.00`
- pitcher_vs_opp_hitters coefficient: `-0.30` per matched-pitcher (counted symmetrically: once for each direction)
- same_team_hitters coefficient: `+0.10` per cross-lineup same-team hitter pair (excluding already-shared players)

Normalization: divide by 10.0 so a pair sharing all 10 roster slots equals exactly 1.0 (the maximum positive correlation).

#### Counting rules (exact)

A "lineup" = the 10 player IDs in `pids` (DraftKings classic). "Hitters" = roster spots that are NOT pitchers. We use `pitcherIds` to identify pitchers within a lineup; everyone else in `pids` is a hitter.

1. **count_shared_player_ids(L_i, L_j):** `|pids(L_i) intersect pids(L_j)|` (integer count of common player IDs, pitchers and hitters both eligible).

2. **count_pitchers_in_Li_whose_opp_team_has_hitters_in_Lj(L_i, L_j):** for each pitcher index `k` in `pitcherIds(L_i)`, look up the corresponding `pitcherOpp` (the opposing team that pitcher faces). Count this index `k` if any hitter in `L_j` (i.e., a pid in `pids(L_j)` that is not a pitcher of L_j) has `team == pitcherOpp(L_i, k)`. Sum over k. Reverse direction is the symmetric mirror.

3. **count_same_team_hitter_pairs_across_lineups (NOT already shared):** for each ordered pair `(h_i, h_j)` where `h_i` is a hitter in L_i and `h_j` is a hitter in L_j, count it if `team(h_i) == team(h_j)` AND `pid(h_i) != pid(h_j)`. (Excluding shared pids prevents double-counting with the shared-player term.) Sum.

   Edge case: if a hitter appears in both lineups (shared), it is excluded. If two different hitters from the same team appear in both lineups (e.g., L_i has Judge+Soto and L_j has Judge+Soto), the (Judge_in_Li, Soto_in_Lj) and (Soto_in_Li, Judge_in_Lj) cross-pairs are both counted (i.e., 2). This matches the "extra cross-lineup same-team exposure beyond shared identity" intent.

### Method 2: Simple correlation (Jaccard - hard penalty)

```
jaccard(L_i, L_j) = |pids(L_i) intersect pids(L_j)| / |pids(L_i) union pids(L_j)|

penalty = 0.0
if any pitcher in L_i has pitcherOpp matching the primaryTeam of L_j:
    penalty += 0.5
if any pitcher in L_j has pitcherOpp matching the primaryTeam of L_i:
    penalty += 0.5

simple_corr(L_i, L_j) = jaccard - penalty
```

`primaryTeam` is read directly from the lineup's structural feature field (already present in the dump). If absent for a lineup, that lineup's "primary stack" check is treated as "no match" (penalty in that direction is not applied).

Range: jaccard is in [0, 1]; simple_corr is in [-1.0, 1.0] (worst: 0 jaccard with both pitcher-vs-opp matches → -1.0; best: 1.0 = identical lineups).

## Aggregation per portfolio

For a portfolio (= one V1 set or one pro's lineups within a single slate):
- N_pairs = N*(N-1)/2 where N = lineup count
- Compute both correlation values for every pair
- Store distribution stats (mean, std, Q25, Q50, Q75, fraction_neg, fraction_strongly_neg, fraction_weak, fraction_strongly_pos)

Thresholds (FIXED, normalized scale, applied to BOTH methods):
- `fraction_neg`: corr < 0
- `fraction_strongly_neg`: corr < -0.30
- `fraction_weak`: -0.10 < corr < +0.10
- `fraction_strongly_pos`: corr > +0.50

## Aggregation across slates

- V1 mean: average each statistic across the 24 slates (each slate weighted equally; not pair-weighted).
- Pro mean: per pro, average across slates where that pro has >= 5 lineups in the slate (need >= 10 pairs for non-degenerate distribution stats). Slates where the pro has fewer lineups are excluded from that pro's aggregate.
- "Pro-average": across all pros listed above, average their per-slate stats (treating each pro-slate as one observation, equal-weighted).

## Cross-method consistency check

For each portfolio, identify the top-10 most negative pairs by Method 1 and by Method 2. Report Jaccard overlap of the two sets. Expectation: should overlap >= 30% on most portfolios; if it does not, both rankings are reported but caveated.

## Stage 6 trigger

Stage 6 ("specific structure identification") runs ONLY if:
- pros' aggregate `fraction_strongly_neg` is at least 1.5x V1's, AND
- this holds under at least one of the two methods.

Otherwise Stage 6 is skipped. (Per constraint #3: not selecting between methods to manufacture support; both methods are reported regardless. The 1.5x trigger is one-of-two so a single-method signal is enough to merit pattern inspection, but the FINDINGS will still report both methods.)

## Constraints reaffirmed

1. Framework R-values used as-is. No tuning.
2. Both methods are reported for every portfolio.
3. No definition selection on results.
4. One pass through data. No iteration.
5. No claims beyond descriptive structural difference.
6. All 24 slates used.
7. Negative findings welcome.
