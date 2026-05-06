# Stage 5 — Mathematical Reconciliation with 76x Pairwise-Correlation Finding

**Predicted ratio of within-portfolio pairwise lineup-similarity probability:**
```
Approach A (dominance approx, p_match ~= p_top1_joint^2):
  V1     joint-top1 freq = 0.0137
  Pros   joint-top1 freq = 0.0285
  V1     p_match (top1 sq) = 0.000503
  Pros   p_match (top1 sq) = 0.008508
  Ratio (pros / V1)        = 16.90x

Approach B (Herfindahl over full joint distribution, p_match = sum_v p(v)^2):
  V1     Herfindahl_joint = 0.033776
  Pros   Herfindahl_joint = 0.046824
  Ratio (pros / V1)       = 1.39x
```

**Observed pairwise-corr gap from prior research:** 76x

**Comparison:**
- Dominance ratio   = 16.9x vs observed 76x -> UNDERSHOOTS
- Herfindahl ratio  = 1.4x vs observed 76x -> UNDERSHOOTS

Notes: ratios are computed on the entity's top-1 primaryTeam subset (joint-cell space restricted to lineups using the entity's modal stack team). The pairwise-correlation gap from prior research applies to the full portfolio; restricting to top-primary is conservative for V1 (which is more diverse) and conservative for pros (whose effective joint concentration is even higher in the modal team than across all teams). The directional comparison is the load-bearing inference.
