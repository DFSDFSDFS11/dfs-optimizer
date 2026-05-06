# I5: Pro Stack Composition Deep-Dive — Findings

**Method:** For each (slate, stack team) where pros stacked the team in 20+ lineups, identify:
- `pro_top2`: 2 most-frequently-used players in pros' stacks for that team
- `v1_top2`: 2 most-frequently-used players in V1's stacks for that team
- `chalk_top2`: top 2 hitters of that team by `own × proj` (the V3 candidate proxy)

136 (slate, team) cases analyzed across 18 slates.

## Aggregate Overlap

| Comparison | Mean overlap (of 2) | Full 2/2 match rate |
|---|---|---|
| **pro_top2 ↔ chalk_top2** | **1.24** | **34%** |
| pro_top2 ↔ v1_top2 | 1.03 | 23% |
| v1_top2 ↔ chalk_top2 | 0.97 | 16% |

**Pros' actual stack core matches the chalk-top-2 proxy at 34% rate. V1's matches at 16%.** Pros are more chalk-aligned than V1 by 18pp on full 2/2 match. Modest signal, not overwhelming.

## Mean Ownership of Stack Core

| Source | Mean own |
|---|---|
| pro_top2_avg_own | 12.7% |
| v1_top2_avg_own | 11.5% (−1.2pp) |
| chalk_top2_avg_own | 14.4% (+1.7pp) |

**V1's stack core averages 1.2pp less ownership than pros' core.** Pros are slightly chalkier than V1 but well below the pure chalk-top-2 proxy (which is 1.7pp above pros).

## What this means: chalk-lean is real but moderate

The simple "V3 = bonus for chalk-top-2-stack" mechanism would push V1 toward picks pros use 34% of the time. That's better than V1's current 16% match rate but still wrong 66% of the time. The proxy isn't perfect.

**Better V3 framing:** small ownership-weighted bonus for stack core, not forcing the literal chalk pair.

## Sample misalignments

Where V1 picks differently from pros (and chalk):

| Slate | Team | n_pro | n_v1 | pro_top2 | v1_top2 | chalk_top2 |
|---|---|---|---|---|---|---|
| 4-6-26 | LAD | 72 | 23 | Freeman + Muncy | Rushing + Ohtani | Ohtani + Tucker |
| 4-6-26 | ATL | 58 | 5 | Albies + Baldwin | Albies + Yastrzemski | Acuña + Baldwin |
| 4-6-26 | BAL | 58 | 8 | Henderson + Mayo | O'Neill + Jackson | Henderson + O'Neill |
| 4-6-26 | SEA | 34 | 11 | Raleigh + Naylor | Raleigh + Rodríguez | Raleigh + Donovan |
| 4-8-26 | CIN | 34 | 18 | De La Cruz + McLain | De La Cruz + Stewart | De La Cruz + Friedl |

Some patterns:
- Pros and V1 share one anchor (Albies, Raleigh, De La Cruz) but pair with different secondaries
- Chalk proxy often picks the wrong secondary (e.g., Tucker not in LAD; Donovan not in SEA)
- Pros sometimes pick non-obvious secondaries (Baldwin over Acuña on ATL — pros picked rookie Baldwin)

The stack core identity is meaningfully variable per slate. **A clean V3 mechanism using "chalk top-2" will be wrong 66% of the time.**

## V3 design — REFINED to a softer mechanism

Given I5's nuance, the V3 design should:
1. **Not force a specific chalk-pair.** The chalk proxy is too crude (only 34% pro match).
2. **Apply a small ownership-weighted bonus** to stack hitters. Lineups whose stack hitters average ~1pp higher ownership get a small bonus. This shifts V1 toward pros' 12.7% average ownership without forcing specific pair identity.
3. **Magnitude small** — ~0.05 multiplier on EV (similar to BRINGBACK_1). Don't override projection.

Mechanism in Theory-DFS V1's scoring:
- For each candidate lineup, compute `stack_own_avg` = mean ownership of primary-stack hitters
- Compare to slate's median stack-own-avg → percentile rank within slate
- Add small EV term: `+ W_STACK_CHALK × stack_own_avg_pct` with W_STACK_CHALK = 0.05

This is a "stack chalk-lean nudge" rather than "stack-core enforcement." More subtle than originally proposed in I3 follow-up.

## Decision: ready for I7 synthesis

I3+I4+I5 converge on:
- V1 has same cluster occupancy and within-stack consistency as pros (✓)
- V1 uses ~1.2pp lower ownership in stack core than pros
- Pros lean modestly chalk in stack core (34% match to chalk proxy)
- The right V3 mechanism is a SMALL ownership-weighted nudge, not a hard core-enforcement

Skipping I6 (salary distribution) — primary V3 mechanism is already clear, additional analysis is diminishing returns. I7 will synthesize V3 spec, I8 will test against V1 baseline.

## Files

- Analyzer: `lineup_level/I5_analyzer.py`
- Raw output: `lineup_level/I5_raw.json` (136 cases)
