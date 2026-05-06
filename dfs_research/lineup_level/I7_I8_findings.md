# I7+I8: V3 Synthesis + Test — Findings

**V3 Mechanism Implemented:** Add `+ 0.05 × stack_own_pct` to lineup EV. `stack_own_pct` = slate-relative percentile rank of mean ownership of primary-stack hitters.

## V3 vs V1 Baseline (18 MLB slates)

| Metric | V1 baseline | V3 | Δ | Pass criterion | Pass? |
|---|---|---|---|---|---|
| **Mean Mahalanobis to pros** | 2.29 | **2.19** | **−0.10** | Mahal must decrease ≥0.05 | **✓ PASS** |
| **Top-0.1% × random** | 1.11× | **1.11×** | 0.00 | t01× ≥ 1.05× | **✓ PASS** |
| Top-1% × random | 1.04× | 0.96× | **−0.08** | t1× ≥ 1.0× | ✗ **FAIL** (0.04 below threshold) |
| Total ROI | −31.5% | −32.6% | −1pp | (sample noise) | n/a |

## Verdict: rejected per strict criteria

V3 **passes Mahalanobis** (the most pro-structurally-meaningful metric) and **passes top-0.1%** (deep-tail preserved). But **fails top-1% threshold by 0.04** — V3's t1× = 0.96 is below the 1.0 minimum.

The shortfall is small (28 → 26 hits = 2-hit difference). This is within sample noise on 18 slates × 150 lineups = 2,700 lineups. Both V1 and V3 are essentially at-random for top-1% (V1 1.04× ≈ baseline, V3 0.96× also ≈ baseline). But the strict criterion says ≥1.0×, and V3 is below.

## What V3 successfully demonstrated

This is the **first variant to improve Mahalanobis at all**:
- V1 (baseline): 2.29
- V2a (type-scaling): 2.26 (essentially unchanged)
- V2b (top-5 filter): 2.89 (worse)
- V2c (top-1 + scaling): 2.34 (slightly worse)
- **V3 (stack chalk-lean): 2.19** (decisively better)

Combined with no t01× degradation, the V3 mechanism is structurally moving the portfolio toward pros. The mechanism direction is correct.

## Diagnosis: V3 W_STACK_CHALK = 0.05 is slightly too aggressive

V3's t1 drop suggests the bonus is shifting too many lineups toward chalk in cases where leverage was hitting cash-band finishes. A smaller bonus (0.03 instead of 0.05) might preserve t1 while still improving Mahalanobis.

## Next Iteration: V3b

**V3b spec:**
- Same mechanism as V3
- `W_STACK_CHALK = 0.03` (60% of V3's value)
- Predicted: Mahal improves modestly (~−0.05 instead of V3's −0.10), t1× stays ≥1.0×, t01× preserved.

If V3b passes all criteria → ship.
If V3b's Mahal improvement is too small (≤0.05) but t1× holds → may need larger bonus AND additional mechanism.

## What we've learned about the lineup-level optimization

The empirical pro-vs-V1 ownership gap of 1.2pp is real and translates into a measurable Mahalanobis improvement when implemented as a small chalk-lean bonus. The trade-off is sub-threshold cash-band degradation. This is the cleanest empirical-to-implementation translation we've achieved in 7 iterations.

## Files

- V3 spec: `lineup_level/V3_proposal.md`
- Validation results: `theory_dfs_v2/v2_validation_results.json`
- This findings file: `lineup_level/I7_I8_findings.md`
