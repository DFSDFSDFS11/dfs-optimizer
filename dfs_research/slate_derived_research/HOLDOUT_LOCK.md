# HOLDOUT LOCK — Stage 1

**Locked at:** 2026-05-03
**Random seed:** 42 (Python `random.seed(42)`, then `random.sample(slates, 8)` from sorted-style list as defined in protocol)
**Method:** Python `random.sample` after `random.seed(42)` over the 24-slate list in the order specified in the protocol prompt.

## HOLDOUT (8 slates) — DO NOT TOUCH UNTIL STAGE 6

1. 4-6-26
2. 4-14-26
3. 4-15-26
4. 4-19-26
5. 4-20-26
6. 5-1-26
7. 5-2-26
8. 5-2-26-night

## DEVELOPMENT (16 slates) — Stages 3–5 only

1. 4-8-26
2. 4-12-26
3. 4-17-26
4. 4-18-26
5. 4-21-26
6. 4-22-26
7. 4-23-26
8. 4-24-26
9. 4-25-26
10. 4-25-26-early
11. 4-26-26
12. 4-27-26
13. 4-28-26
14. 4-29-26
15. 5-2-26-main
16. 5-3-26

## Apparent imbalance notes (NOT re-rolled)

- Holdout pulls 4-6-26 (the earliest slate) and 5-2-26-night (one of the latest); decent temporal coverage despite imbalance toward early-window dates.
- Holdout contains 5-2-26 and 5-2-26-night (same calendar day, two distinct slates). Dev retains 5-2-26-main. This is acceptable per protocol: slates are treated as independent observations.
- Holdout has no "early" slate variant; one "early" slate (4-25-26-early) is in dev. This is minor and not re-rolled.
- Development set has 16 slates as required; holdout has 8 as required. No re-roll permitted by protocol.

## Lock affirmation

These 8 holdout slates will not be opened, visualized, summary-statted, or otherwise touched in Stages 2–5. The first time any holdout data is read is in Stage 6 single-shot validation.
