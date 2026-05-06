# V3 Proposal: Stack Chalk-Lean Nudge

## Synthesis from I1–I5

| Iteration | Finding |
|---|---|
| I1 | V1 mean lineup distance to nearest pro = 0.550. Hermes-A farthest (0.642). V1's p10 = 0.036 (some V1 lineups essentially identical to pros). |
| I2 | V1 cluster occupancy MATCHES pro distribution (gaps all <4pp). |
| I3 | V1 over-pairs cross-team unrelated players; under-pairs same-team star pairs (e.g., DeLauter+Ramírez at 0.00 V1 vs 0.67 pros). |
| I4 | V1's within-portfolio stack consistency MATCHES pros (mode_jaccard 0.459 vs 0.466). V1 IS consistent within stacks but uses different cores. |
| I5 | Pros' stack core averages 12.7% ownership; V1's 11.5% (1.2pp gap). Pros match chalk-top-2 proxy 34% of time; V1 16%. Modest chalk-lean. |

## V3 Mechanism

**Add a small stack chalk-lean bonus to lineup EV.**

For each candidate lineup:
1. Compute `stack_own_avg` = mean ownership of primary-stack hitters (the hitters from the team most-stacked in this lineup, ≥4 hitters).
2. Compute slate-relative percentile rank `stack_own_pct` of this value across the pool.
3. Add term to EV: `+ W_STACK_CHALK × stack_own_pct` with **W_STACK_CHALK = 0.05**.

Rationale:
- 0.05 magnitude similar to BRINGBACK_1 — small enough not to override projection lever, large enough to differentiate.
- Operates within existing scoring framework — no structural change to band selection or correlation.
- Targets the specific 1.2pp ownership gap I5 identified.

## What V3 does NOT change

- Min primary stack still 4
- Variance bands still 20/60/20
- Correlation lever (1B) unchanged
- Combinatorial uniqueness (1E) unchanged
- All other V1 mechanics preserved

## Predicted effect

V1 currently scores high-projection chalk and high-projection leverage equally within a stack. V3 adds a tiebreaker: when picking 4-5 hitters from primary stack team, prefer the higher-owned ones. This shifts V1's average stack-own-avg from 11.5% → ~12-13% (toward pros' 12.7%).

Expected structural impact:
- **Mahalanobis to pros**: should decrease (V1 picks closer to pro ownership pattern within stack)
- **Top-1% × random**: maintained (selection still EV-driven)
- **Top-0.1% × random**: maintained or slightly improved (chalk concentrates more on high-projection actuals)
- **Finishing distribution**: stays inverse-bell

## Ship criteria

- Mahal_v3 < Mahal_v1 (2.29) by at least 0.05
- t1×_v3 ≥ 1.0 (V1 baseline 1.04, allow tiny drop within noise)
- t01×_v3 ≥ 1.05 (V1 baseline 1.11)
- Top-decile finish % > middle-deciles (inverse-bell)

If all pass → commit + push as ship candidate.

## Risks

1. **Selection inertia** — W_STACK_CHALK = 0.05 might be too small to move V1's selection at all. If V3 results are essentially V1, increment to 0.10 in a follow-up V3b variant.
2. **Tail degradation** — adding chalk lean could hurt top-0.1% if pros' tail comes from non-chalk lineups. Watch t01× carefully.
3. **Inverse-bell shape disruption** — pushing toward chalk could narrow the distribution. Verify shape post-test.
