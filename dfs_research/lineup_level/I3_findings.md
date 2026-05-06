# I3: Conditional Player Co-occurrence — Findings

**Method:** For each slate, identify top-30 most-used players. For each ordered pair (A, B), compute P(B in lineup | A in lineup) for three sources: pros (~14K lineups), field (~150K capped), V1 (2,700 lineups). Aggregate per-pair across slates by player **name** (not ID, since rosters change daily). Compute `pro_v1_gap = (pro_cond − field_cond) − (v1_cond − field_cond)`.

## Aggregate Findings

| Stat | Value |
|---|---|
| Pairs with ≥2-slate data | **1,801** |
| Pros pair MORE than V1 (gap > +5pp) | **692 (38%)** |
| Pros pair LESS than V1 (gap < −5pp) | **355 (20%)** |
| Mean pro_lift (pro_cond − field_cond) | −0.015 (≈ pros pair like field) |
| Mean V1_lift (v1_cond − field_cond) | **−0.037** (V1 pairs LESS than field) |
| Mean &#124;pro−v1 gap&#124; | 0.080 (8pp average) |

## Key Pattern: V1 over-diversifies within stacks, under-stacks specific same-team cores

**Top 10 pairs where pros pair MORE than V1** are almost entirely **same-team stack pairs**:

| Pair | pro_cond | v1_cond | gap |
|---|---|---|---|
| Chase DeLauter + Jose Ramirez (both CLE) | 0.67 | **0.00** | +0.67 |
| Carlos Correa + Isaac Paredes (both HOU) | 0.54 | **0.00** | +0.54 |
| Matt Olson + Michael Harris II (both ATL) | 0.62 | 0.09 | +0.53 |
| Xavier Edwards + Eury Perez (both MIA) | 0.69 | 0.20 | +0.49 |
| Geraldo Perdomo + Ketel Marte (both ARI) | 0.66 | 0.25 | +0.41 |
| J.C. Escarra + Cody Bellinger (both NYY) | 0.56 | 0.17 | +0.39 |
| Ronald Acuña Jr. + Michael Harris II (both ATL) | 0.46 | 0.10 | +0.36 |
| Jordan Walker + Iván Herrera (both STL) | 0.69 | 0.36 | +0.33 |
| Drake Baldwin + Michael Harris II (both ATL) | 0.49 | 0.17 | +0.32 |

**Striking observation: V1 conditional probability is exactly 0.00 for many key stack pairs.** When DeLauter is in a V1 lineup, Ramirez is **never** also in that lineup. Pros pair them in 67% of lineups containing DeLauter.

This isn't because V1 doesn't stack — V1 has `minPrimaryStack=4` as a hard constraint. The issue is **V1 uses different CLE players in different lineups (over-diversifying within the stack), while pros consistently pair the same star duo.**

## Top 10 pairs where pros pair LESS than V1 — all CROSS-TEAM unrelated

| Pair | pro_cond | v1_cond | gap |
|---|---|---|---|
| Ketel Marte + Xander Bogaerts (ARI vs SD) | 0.08 | **0.58** | −0.50 |
| Ketel Marte + Manny Machado (ARI vs SD) | 0.09 | 0.54 | −0.45 |
| Julio Rodriguez + Jose Soriano (SEA vs LAA) | 0.37 | **0.81** | −0.44 |
| Ketel Marte + Ramon Laureano (ARI vs ATL) | 0.14 | 0.54 | −0.41 |
| Ozzie Albies + Ramon Laureano (ATL hitters but cross-game) | 0.10 | 0.50 | −0.40 |
| Ozzie Albies + Jackson Merrill (ATL vs SD) | 0.11 | 0.50 | −0.39 |
| Cody Bellinger + Aaron Judge (both NYY but uncommon pairing for pros) | 0.27 | 0.55 | −0.28 |

**V1 over-pairs unrelated cross-team players at 0.50-0.80 rate; pros pair them at 0.10-0.30.** When V1 has player A from team X, V1 frequently has player B from unrelated team Y. Pros don't.

## Interpretation: the "stack core" finding

V1's selection is tactically inverted from pros at the pair level:
- Within a team stack, **pros use consistent star cores** (e.g., always Ramírez + DeLauter for CLE, always Olson + Harris for ATL). V1 cycles through different combinations of CLE/ATL hitters.
- Across teams, **pros maintain tight team focus** (one stack per slate, sometimes with a specific bring-back). V1 over-spreads across multiple teams' star players.

This explains the I1 result (V1 individual lineups drift from pros — V1 lineups have different CLE players each time) AND the I2 result (V1's *cluster occupancy* matches pros — same proportion of stacks/balanced/contrarian, just different specific player picks).

## V3 hypothesis — UPDATED with I3

I2 said: "within-cluster centroid-pull (pick lineups closer to cluster centroid within each band)."
I3 sharpens this: **the centroid V1 should pull toward is the consistent stack core pros use, not a generic feature centroid.**

**Concrete V3 mechanism:**
1. For each slate, identify "pro cores" — pairs/triples of same-team players that pros consistently co-roster.
   - Heuristic: top 5 players per team by ownership × projection are the candidate "core."
   - Pros' actual cores are likely the top 2-3 by combined own × proj.
2. When V1 picks a lineup with primary stack on team X, prefer lineups containing the top-2 players of team X (the "core").
3. Apply as a soft bonus: lineups containing the core pair get an EV bonus; lineups using a non-core stack composition get less.

This concentrates V1's stacks around consistent cores instead of cycling through alternates. Should bring V1 individual lineups closer to pro lineups (improve I1 metric) without disrupting the cluster distribution V1 already nails (preserve I2 result).

## Counter-hypothesis to test

**Or:** the issue might be V1's diversification mechanism itself (overlap cap, exposure cap) is over-spreading the stack. Reducing diversification on stack-team players (allow higher exposure for top-2 of stack team) might naturally produce the consistent-core pattern.

## Files

- Analyzer: `lineup_level/I3_analyzer.py`
- Raw output: `lineup_level/I3_raw.json` (1,801 pairs ranked by pro_v1_gap)
