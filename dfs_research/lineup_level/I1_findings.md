# I1: Lineup-Level Pairing Distance — Findings

**Method:** For each system lineup across 18 MLB slates, compute Euclidean distance to the nearest pro lineup in standardized feature space (proj_pct, own_pct, primary_stack/10). Compare aggregate distance distributions.

**Pro lineups extracted:** 14,100 across 18 slates (zroth, nerdytenor, shipmymoney, shaidyadvice, needlunchmoney, bgreseth, youdacao).

## Aggregate Results

| System | Mean | Median | p10 (closest) | p90 (farthest) | n |
|---|---|---|---|---|---|
| **hermes-a** | **0.642** | 0.699 | 0.240 | 0.935 | 2676 |
| theory-dfs-mlb (V1) | 0.550 | 0.597 | **0.036** | 0.949 | 2700 |
| theory-dfs-mlb-hcombo | 0.490 | 0.476 | 0.048 | 0.946 | 2700 |
| **random-mlb** | **0.492** | 0.489 | 0.099 | 0.893 | 2700 |

## Key Finding (rotates the whole comparison)

**Hermes-A produces lineups that are individually FARTHER from any pro lineup than every other system tested — including random pool sampling.** Random uniform sampling from the SaberSim pool produces lineups closer to pros (mean 0.492) than Hermes-A (mean 0.642).

This **inverts the structural-validation finding**. Hermes-A's aggregate Mahalanobis (1.95) was best because it averages structural metrics across the portfolio. But at the **per-lineup** level, it's the *least* pro-like system. Its individual lineups are different from pros'; the aggregate match comes from constructing a portfolio whose centroid lands near pros, not from picking pro-like lineups.

This is exactly the Ch.8 phenomenon ("exposures don't matter, lineups do") in numerical form. **Two portfolios with identical aggregate metrics can have completely different lineup compositions, and the lineup-level differences matter more than the aggregate match.**

## Theory-DFS V1 specifically

V1's mean distance (0.550) is in the middle. But its **p10 = 0.036** is the smallest of any system — V1 has *some* lineups essentially identical to pro lineups. The rest drift further away.

| System | p10 | mean |
|---|---|---|
| theory-dfs-mlb | 0.036 | 0.550 |
| hermes-a | 0.240 | 0.642 |
| random-mlb | 0.099 | 0.492 |

V1's bottom 10% are 3× closer to pros than Hermes's bottom 10%. But V1's mean is still worse than Random. **V1's selection finds pro-like lineups effectively, but its 20/60/20 variance-band split then forces enough non-pro-like lineups (the low band) to drag the mean back up.**

## Hypothesis for next iteration (I2)

V1's closest-to-pro lineups (the bottom 10% by distance) likely concentrate in the "high" or "mid" band. The "low" band (20% of portfolio = 30 lineups) likely contains all the high-distance lineups that drag the mean.

**Test in I2:** cluster pro lineups (k-means in feature space). Then for each V1 band (high/mid/low), measure cluster occupancy. Hypothesis: V1's high+mid bands occupy pro clusters; V1's low band occupies a cluster pros don't visit.

If true → reducing the low-band allocation (or replacing it with mid-band lineups closer to a different pro cluster) would close the lineup-level gap without breaking V1's V4 band-spread structural pass.

## Implication for V3 design

A V3 candidate based on I1 alone would be: **"V1 with low-band proportion reduced from 20% to 10%, replaced by mid-band lineups."** This is testable.

But I2's cluster analysis could show whether this is the right specific surgery, or whether the low-band is fine and the mid-band drift is the real issue.

## Per-slate breakdown (mean nearest-distance)

```
4-6-26:  hermes=0.692 | v1=0.535 | v1-hc=0.480 | rand=0.481
4-8-26:  hermes=0.589 | v1=0.404 | v1-hc=0.439 | rand=0.420
4-12-26: hermes=0.578 | v1=0.523 | v1-hc=0.484 | rand=0.482
4-14-26: hermes=0.659 | v1=0.520 | v1-hc=0.479 | rand=0.529
4-15-26: hermes=0.711 | v1=0.480 | v1-hc=0.439 | rand=0.495
4-17-26: hermes=0.673 | v1=0.524 | v1-hc=0.475 | rand=0.500
4-18-26: hermes=0.712 | v1=0.551 | v1-hc=0.443 | rand=0.488
4-19-26: hermes=0.682 | v1=0.536 | v1-hc=0.465 | rand=0.516
4-20-26: hermes=0.591 | v1=0.590 | v1-hc=0.495 | rand=0.483
4-21-26: hermes=0.592 | v1=0.581 | v1-hc=0.499 | rand=0.518
4-22-26: hermes=0.555 | v1=0.659 | v1-hc=0.550 | rand=0.509
4-23-26: hermes=0.675 | v1=0.564 | v1-hc=0.497 | rand=0.499
4-24-26: hermes=0.713 | v1=0.572 | v1-hc=0.537 | rand=0.448
4-25-26: hermes=0.709 | v1=0.570 | v1-hc=0.518 | rand=0.495
4-25-26-early: hermes=0.536 | v1=0.429 | v1-hc=0.423 | rand=0.523
4-26-26: hermes=0.650 | v1=0.530 | v1-hc=0.529 | rand=0.503
4-27-26: hermes=0.634 | v1=0.560 | v1-hc=0.503 | rand=0.475
4-28-26: hermes=0.692 | v1=0.516 | v1-hc=0.457 | rand=0.447
```

V1 < Hermes-A on **17 of 18 slates** (only 4-22-26 has V1 worse). The "V1 closer to pros at lineup level than Hermes-A" finding is robust.

## Files

- Analyzer: `lineup_level/I1_analyzer.py`
- Raw output: `lineup_level/I1_raw.json`
