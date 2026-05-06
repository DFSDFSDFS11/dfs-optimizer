# ML Lineup Classifier — Validation Report

## Stage 1: Data Summary

Total rows loaded: 103,782
Positive rows: 16,567
Negative rows: 87,215
Held-out slates: ['4-19-26', '4-21-26', '4-24-26', '4-8-26']
Training slates: ['4-12-26', '4-14-26', '4-15-26', '4-17-26', '4-18-26', '4-20-26', '4-22-26', '4-23-26', '4-25-26', '4-25-26-early', '4-26-26', '4-27-26', '4-28-26', '4-6-26']
Training rows: 80,344  (13,120 pos, 67,224 neg)
Held-out rows: 23,438  (3,447 pos, 19,991 neg)

Feature count: 33
Features: total_projection, total_salary, total_ownership, mean_ownership, ownership_stddev_within_lineup, total_ceiling, total_floor, projection_ratio_to_optimal, ownership_delta_from_anchor, ceiling_ratio_to_max, salary_efficiency, avg_player_ownership_percentile, primary_stack_size, primary_stack_team_ownership_rank, secondary_stack_size, has_3_3_split, has_4_3_split, has_5_stack, pitcher_team_in_stacks, num_players_above_25_own, num_players_below_5_own, max_single_player_ownership, min_single_player_ownership, ownership_skewness, count_leverage_spots, count_value_plays, count_chalk_studs, count_punt_plays, count_trap_plays, max_pairwise_player_co_ownership, pitcher_total_salary, pitcher_total_ownership, hitter_salary_stddev

## Stage 2: Initial Model — Slate-level 5-fold CV

  Fold 1: train AUC=0.8121  val AUC=0.6377  val slates: ['4-12-26', '4-22-26', '4-25-26-early']
  Fold 2: train AUC=0.8581  val AUC=0.7594  val slates: ['4-18-26', '4-20-26', '4-25-26']
  Fold 3: train AUC=0.7906  val AUC=0.7312  val slates: ['4-17-26', '4-23-26', '4-26-26']
  Fold 4: train AUC=0.8785  val AUC=0.8037  val slates: ['4-14-26', '4-27-26', '4-6-26']
  Fold 5: train AUC=0.9236  val AUC=0.7819  val slates: ['4-15-26', '4-28-26']

**Mean train AUC: 0.8526 ± 0.0474**
**Mean val AUC:   0.7428 ± 0.0578**

🟡 Validation AUC in [0.65, 0.75] — moderate signal

### Top 20 features by gain:

| Rank | Feature | Gain | Split count |
|---|---|---|---|
| 9 | ceiling_ratio_to_max | 65959 | 524 |
| 1 | total_salary | 55514 | 966 |
| 5 | total_ceiling | 23839 | 412 |
| 21 | max_single_player_ownership | 22285 | 591 |
| 13 | primary_stack_team_ownership_rank | 21758 | 695 |
| 31 | pitcher_total_ownership | 20848 | 485 |
| 8 | ownership_delta_from_anchor | 15839 | 518 |
| 2 | total_ownership | 11431 | 398 |
| 22 | min_single_player_ownership | 10764 | 516 |
| 30 | pitcher_total_salary | 8197 | 456 |
| 11 | avg_player_ownership_percentile | 6691 | 330 |
| 29 | max_pairwise_player_co_ownership | 5288 | 250 |
| 10 | salary_efficiency | 5133 | 268 |
| 0 | total_projection | 5065 | 286 |
| 7 | projection_ratio_to_optimal | 3986 | 314 |
| 23 | ownership_skewness | 3855 | 265 |
| 32 | hitter_salary_stddev | 3832 | 321 |
| 14 | secondary_stack_size | 3377 | 194 |
| 12 | primary_stack_size | 3195 | 189 |
| 26 | count_chalk_studs | 1919 | 99 |

### Calibration (decile of predicted prob):

| Decile | Mean pred prob | Observed pro-pick rate | Count |
|---|---|---|---|
| 0 | 0.0095 | 0.0004 | 8035 |
| 1 | 0.0223 | 0.0054 | 8034 |
| 2 | 0.0357 | 0.0118 | 8034 |
| 3 | 0.0508 | 0.0241 | 8035 |
| 4 | 0.0701 | 0.0390 | 8034 |
| 5 | 0.0964 | 0.0630 | 8034 |
| 6 | 0.1360 | 0.1068 | 8035 |
| 7 | 0.2015 | 0.1977 | 8034 |
| 8 | 0.3270 | 0.3625 | 8034 |
| 9 | 0.6844 | 0.8224 | 8035 |

### Confusion matrix at 0.5 threshold:

```
                Predicted 0    Predicted 1
Actual 0         66458           766
Actual 1          7498          5622
```

## Stage 3: Cross-Pro Validation (Leave-One-Pro-Out)

Pros: ['bgreseth', 'needlunchmoney', 'nerdytenor', 'shaidyadvice', 'shipmymoney', 'youdacao', 'zroth']

  Held-out pro: bgreseth            AUC: 0.8045  (test pos: 1800, neg: 57227)
  Held-out pro: needlunchmoney      AUC: 0.8740  (test pos: 1950, neg: 62229)
  Held-out pro: nerdytenor          AUC: 0.7810  (test pos: 1950, neg: 62224)
  Held-out pro: shaidyadvice        AUC: 0.8965  (test pos: 1945, neg: 62224)
  Held-out pro: shipmymoney         AUC: 0.8025  (test pos: 1950, neg: 62225)
  Held-out pro: youdacao            AUC: 0.8926  (test pos: 1436, neg: 52237)
  Held-out pro: zroth               AUC: 0.9019  (test pos: 2100, neg: 67224)

**Mean cross-pro AUC: 0.8504 ± 0.0483**
Min: 0.7810 (nerdytenor)
Max: 0.9019 (zroth)

Gate 3 (mean ≥ 0.70 AND stddev ≤ 0.07): ✅ PASS

## Stage 4: Held-Out Slate Validation

Apply final model to 4 held-out slates. Compare model top-150 vs pros' actual lineups.

  4-19-26          AUC: 0.5574  top-150 contains 89/1049 pro lineups  (precision=0.593, recall=0.085)
  4-21-26          AUC: 0.7365  top-150 contains 86/748 pro lineups  (precision=0.573, recall=0.115)
  4-24-26          AUC: 0.8257  top-150 contains 131/900 pro lineups  (precision=0.873, recall=0.146)
  4-8-26           AUC: 0.6857  top-150 contains 125/750 pro lineups  (precision=0.833, recall=0.167)

**Mean held-out AUC: 0.7013**
Gate 4 (mean held-out AUC ≥ 0.72): ❌ FAIL

## Stage 5: Portfolio Construction on Held-Out Slates

  Loading lineup pools and player metadata for held-out slates...
  (NOTE: Stage 5/6 require player-level data; running TS exporter for held-out pools)

  Saved holdout_predictions.csv (for TS post-processing into Stage 5/6 portfolio comparison)

## Stage 6: Hermes-A vs ML — DEFERRED to TS post-processing

See ml_compare_to_hermes.ts run after this script.

## Stage 7: Preliminary Decision

Gate 1 (CV val AUC ≥ 0.65): ✅ PASS (got 0.7428)
Gate 3 (Cross-pro): ✅ PASS
Gate 4 (Held-out AUC): ❌ FAIL

**Preliminary: FAIL — document and stop**

## Stage 8: Feature Ablation

### Cumulative ablation (add groups in order):

| Cumulative groups | n features | CV val AUC |
|---|---|---|
| +aggregate | 7 | 0.7241 |
| +slate_relative | 12 | 0.7257 |
| +stack | 19 | 0.7331 |
| +ownership_dist | 24 | 0.7338 |
| +archetype | 29 | 0.7306 |
| +pairwise | 30 | 0.7344 |
| +position | 33 | 0.7427 |


## Files saved

- `lgb_final.txt` — trained LightGBM model
- `feature_importance.csv` — feature importances
- `holdout_predictions.csv` — held-out predictions (for Stage 5/6 TS post-processing)
- `ablation.json` — feature ablation results
- `report.md` — this report


---

# Stage 5/6 — ML Portfolio vs Hermes-A on Held-Out Slates

### 4-8-26

  ML portfolio size: 150
  Hermes-A portfolio size: 126

| Metric | ML | Hermes-A | Winner |
|---|---|---|---|
| Mahalanobis distance | 5.58 | 1.85 | Hermes-A |
| KS distance | 0.301 | 0.121 | Hermes-A |
| ROI | -82% | -96% | ML |
| Payout | $526 | $128 |  |

### 4-21-26

  ML portfolio size: 150
  Hermes-A portfolio size: 150

| Metric | ML | Hermes-A | Winner |
|---|---|---|---|
| Mahalanobis distance | 1.97 | 1.42 | Hermes-A |
| KS distance | 0.293 | 0.206 | Hermes-A |
| ROI | -95% | 813% | Hermes-A |
| Payout | $162 | $27386 |  |

### 4-19-26

  ML portfolio size: 150
  Hermes-A portfolio size: 150

| Metric | ML | Hermes-A | Winner |
|---|---|---|---|
| Mahalanobis distance | 3.62 | 0.73 | Hermes-A |
| KS distance | 0.299 | 0.114 | Hermes-A |
| ROI | -92% | -82% | Hermes-A |
| Payout | $239 | $528 |  |

### 4-24-26

  ML portfolio size: 150
  Hermes-A portfolio size: 150

| Metric | ML | Hermes-A | Winner |
|---|---|---|---|
| Mahalanobis distance | 1.38 | 0.76 | Hermes-A |
| KS distance | 0.254 | 0.140 | Hermes-A |
| ROI | -91% | -93% | ML |
| Payout | $255 | $202 |  |


## Stage 6 Aggregate Comparison

Held-out slates evaluated: 4
ML beats Hermes on Mahalanobis: 0/4
ML beats Hermes on ROI: 2/4
ML total: $1182 (ROI -90.1%)
Hermes-A total: $28244 (ROI 135.4%)

ML payout / Hermes payout ratio: 4.2%

## Stage 7: Ship Decision

Gate: ML Mahalanobis better on ≥3 of 4 held-out slates: ❌ (0/4)
Gate: ML payout ≥ 80% of Hermes-A payout: ❌  (4.2%)

(Stages 1-4 gates checked in run_pipeline.py)
