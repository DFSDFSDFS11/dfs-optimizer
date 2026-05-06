# I2: Pro Lineup Clusters — Findings

**Method:** K-means (k=3) on 14,100 pro lineup feature vectors. Features: proj_pct, own_pct, range_pct, salary_pct (slate-relative), plus stack_norm and bring_back_norm. For each system, assign each lineup to nearest pro cluster centroid. Compute cluster occupancy gap.

## Pro clusters (k=3)

| Cluster | Size | Defining feature | Interpretation |
|---|---|---|---|
| C0 | 3,585 (25%) | high proj (0.79), **low salary (0.13)** | "cheap-stud / value-extreme" — squeezing salary for value |
| C1 | 7,911 (56%) | high proj (0.75), **high salary (0.77)** | "balanced / stars-spending" — typical chalk-stars build |
| C2 | 2,604 (18%) | **low proj (0.25)**, low salary (0.21) | "contrarian / punt" — sub-optimal projection, low cost |

All clusters share: high range_pct (~1.00, lineups span the upside), stack_norm 0.66 (~4.6 hitter primary stack), bring_back near zero. **Pros mostly do "naked stack" (4-5 stack with no bring-back) constructions.**

## System cluster occupancy vs pros

| System | C0% | C1% | C2% | n | C0 gap | C1 gap | C2 gap |
|---|---|---|---|---|---|---|---|
| **PROS** | **25%** | **56%** | **18%** | 14,100 | — | — | — |
| hermes-a | 33% | 53% | 15% | 2,676 | **+7.3pp** | −3.6pp | −3.7pp |
| **theory-dfs-mlb (V1)** | 27% | 52% | 21% | 2,700 | **+1.6pp** | **−3.7pp** | **+2.1pp** |
| theory-dfs-mlb-hcombo | 26% | 46% | 28% | 2,700 | +0.1pp | **−9.8pp** | +9.8pp |
| random-mlb | 22% | 38% | 41% | 2,700 | −3.7pp | **−18.4pp** | **+22.1pp** |

## Key findings

1. **V1 is the closest match to pro cluster distribution.** All gaps are <4pp. This is striking given I1 showed V1 in the middle of the pack on lineup-level distance.

2. **Random heavily over-represents C2 (the contrarian cluster) by +22pp.** It picks too many low-projection/low-salary lineups, missing the 56% of pro portfolios in the balanced C1 cluster. This explains why random's individual lineups are close to pros (those that ARE pro-like cluster well) but random's portfolio AS A WHOLE diverges from pro distribution.

3. **Hermes-A over-represents C0 (cheap-stud) by +7pp.** Its `extremeCornerCap` mechanism, supposed to penalize cheap-stud builds, is mis-calibrated — it's allowing TOO MANY cheap-stud lineups, more than pros use.

4. **Theory-DFS-V1+hcombo over-represents C2 by +10pp.** Adding Hermes-A's combo mechanism to V1 pushes it more contrarian, away from the balanced C1 cluster.

## Reconciling I1 and I2

I1 said: V1 mean lineup distance to pros = 0.550 (middle of pack).
I2 says: V1 cluster occupancy = closest to pro distribution.

These are NOT contradictory. They measure different things:
- I1 = "how individually pro-like are V1 lineups?" Answer: middle.
- I2 = "does V1's portfolio span pro clusters in pro proportions?" Answer: yes.

**Implication:** V1 is in the right CLUSTERS in the right proportions, but its lineups within each cluster are at wrong END of the cluster (further from cluster centroid than pros). The fix isn't to redistribute across clusters — V1 already does that well — but to pick lineups closer to the cluster centroids within each band.

## V3 candidate updated

Original I1 hypothesis was "reduce low-band allocation 20→10%." I2 invalidates that:
- Pros are 18% in C2 (~roughly the low band)
- V1 is 21% in C2 (only 2.1pp over)
- Reducing low-band would push V1 AWAY from pros' 18% C2 share

**Better V3 hypothesis based on I1+I2 combined:**
- Within each variance band, prefer lineups closer to the pro cluster centroid for that band's profile.
- Specifically: rank candidates within each band by distance to pros' MEAN position in that band's natural cluster.
- Don't change band proportions.

This is a "centroid-pull" mechanism rather than "band reallocation."

## Methodology caveats

- **own_pct percentile rank is broken.** All pro lineups percentile-rank to 0.0 because pool's Ownership column uses different scale (geomean) than my arithmetic-mean computation. Need to fix in I3+ — either use raw ownership values or unify the metric.
- **bring_back near zero across all clusters** suggests pros do mostly naked 5-stacks. Conflicts with combo analysis (bring-back-2plus1 at field rate). Possible explanation: combo analysis's "bring-back-2plus1" includes 2-stacks (not 5-stacks), where bring-back IS common. 5-stacks tend to be naked. Worth confirming in I5 stack composition deep-dive.

## Files

- Analyzer: `lineup_level/I2_analyzer.py`
- Raw output: `lineup_level/I2_raw.json`
