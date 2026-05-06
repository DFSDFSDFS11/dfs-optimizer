# I4: Within-Pro Lineup Variance — Findings

**Method:** For each (source, slate) portfolio, compute within-portfolio variance metrics:
- `unique_teams`: number of distinct primary stack teams used across the portfolio
- `mode_team_share`: fraction of lineups using the most-frequent stack team
- `mode_team_jaccard`: avg pairwise Jaccard similarity between stack-player sets, restricted to lineups using the mode team
- `overall_jaccard`: avg pairwise Jaccard across all pairs of lineups (regardless of team)

Aggregate by source across slates. **Hypothesis (from I3):** pros have higher within-portfolio stack consistency (lower variance, higher mode-team Jaccard) than V1.

## Aggregate Results

| Source | unique_teams | mode_share | mode_jaccard | overall_jaccard | n_slates |
|---|---|---|---|---|---|
| **PROS combined** | **14.1** | **21%** | **0.466** | **0.062** | 6 pros |
| **theory-dfs-mlb (V1)** | **14.1** | **23%** | **0.459** | **0.060** | 18 |
| hermes-a | 15.2 | 17% | 0.389 | 0.039 | 18 |
| theory-dfs-mlb-hcombo | 15.3 | 17% | 0.445 | 0.043 | 18 |
| random-mlb | 15.7 | 17% | 0.421 | 0.041 | 18 |

## Key Finding: I3 stack-core hypothesis is INVALIDATED at the within-portfolio level

**V1 matches pros essentially exactly on every within-portfolio variance metric.** Differences are within ±0.5pp / ±0.01 jaccard:
- unique_teams: V1 14.1 vs pros 14.1 (exact match)
- mode_share: V1 23% vs pros 21% (+2pp)
- mode_team_jaccard: V1 0.459 vs pros 0.466 (−0.007)
- overall_jaccard: V1 0.060 vs pros 0.062 (−0.002)

**V1 uses the same number of stack teams, with the same mode concentration, with the same player consistency within the mode team.** It's NOT over-diversifying compared to pros.

Hermes-A, by contrast, IS structurally over-diversified within mode-team stacks (jaccard 0.389 vs pros 0.466 = −0.077, the largest gap of any system).

## Reconciling I3 (pros pair more) and I4 (V1 same consistency)

I3 showed: P(Ramírez | DeLauter) for pros = 0.67, for V1 = 0.00.
I4 shows: V1 has 0.459 mode-team Jaccard (similar to pros' 0.466).

These ARE compatible. The reconciliation:

**V1 is consistent within its stack — but uses a DIFFERENT consistent core than pros do.**

When V1 stacks CLE, it uses (say) Goodman + Karros + Castro + Moniak repeatedly. Pros stack CLE with Ramírez + DeLauter + Naylor + Fry. Both have ~50% Jaccard within their CLE-stacked lineups. But the SPECIFIC players differ — V1 picks the LEVERAGE pair (low-own, low-proj-rank), pros pick the CHALK pair (high-own, high-proj).

V1's leverage-driven selection mechanism (W_LEV = 0.30 in EV) systematically shifts away from the high-own players within a stack team. Pros explicitly target those high-own players because they're high-projection.

## V3 hypothesis — REFINED with I4

The naive V3 ("stack-core bonus = give EV bonus to top-2 by own×proj of stack team") is **still the right mechanism, but the operational reason is different from I3's framing:**

- It's not that V1 lacks within-stack consistency (it has it).
- It's that V1 chooses the WRONG core (leverage pair) within the right amount of consistency.
- Adding a bonus for the chalk pair (top-2 by own×proj of stack team) shifts V1's consistent stack from leverage-pair to chalk-pair, matching pros.

This is testable. Specific implementation:
1. Per slate, compute "core_pair[team]" = top 2 players of team by `own × proj` (skip pitchers).
2. For each candidate lineup with primary stack on team T:
   - If lineup contains BOTH players in `core_pair[T]`: EV bonus +X
   - If lineup contains 1 of them: EV bonus +X/2
3. X magnitude: try 0.10 (similar to STACK_BONUS_PER_HITTER) — small enough not to override projection but large enough to differentiate consistent-core lineups.

## Connection to I1 finding

I1 showed V1's mean lineup distance to nearest pro = 0.550. I4 explains why V1 isn't closer despite I2 showing matching cluster distribution and I4 showing matching within-portfolio variance: **V1 lineups are in the right neighborhoods but the wrong specific positions**. They're consistent CLE stacks but built around different CLE players than pros use.

The V3 stack-core bonus targets exactly this gap.

## What I4 didn't measure (caveat)

I4 measured within-portfolio variance, not specific player identity. **I5 is now the most important iteration**: deep-dive into pro stack compositions to identify SPECIFIC core players per team and confirm V1 uses different ones. Then V3 design can use observed pro-cores rather than the proxy "top-2 by own×proj."

## Files

- Analyzer: `lineup_level/I4_analyzer.py`
- Raw output: `lineup_level/I4_raw.json`
