# Live Audit v2 — LINEUP-LEVEL Gap (per Theory Ch.8)

**Date:** 2026-05-16
**Per Theory of DFS Ch.8: "Simply put, exposures don't matter. Lineups do."**

This is the corrected analysis — the v1 findings focused on individual player exposures (raised Marte from 25% to 39%). That was the wrong level. The framework says portfolio quality lives at the LINEUP level: stack shape, bring-back, pair-frequency, variance-band coverage.

---

## Data

15,660 individual pro lineups extracted from 39 DraftKings contest-standings ZIPs (108 reconstructed 150-entry pro portfolios). Matched against slate projection files for team/opp/own/proj data.

For lineup-level classification, filtered to MLB main slates (avg primary stack ≥ 3.5).

---

## Cross-slate pro medians (MLB main)

| Metric | pros median | pros p25 | pros p75 | Atlas (5-15) | Atlas vs pros |
|---|---|---|---|---|---|
| % lineups with 5-stack | **72%** | 52% | 83% | 76% | OK — close to median |
| % lineups with 4-stack | 15% | 5% | 28% | 20% | OK |
| % lineups with 3-stack | 3.7% | 0% | 10.7% | 3% | OK |
| **% lineups with bring-back ≥1** | **17%** | 9% | 28% | **7%** | **GAP — below pro p25** |
| **% lineups with bring-back ≥2** | **8.2%** | 4% | 12% | **1%** | **BIG GAP** |
| avg lineup proj sum | 52-103 | 44 | 98 | 102.4 | varies by slate |
| avg lineup own sum | 59 | 44 | 131 | 130 | OK |

(bring-back = hitters from primary stack team's OPPONENT, i.e. classic MLB game-stack pattern)

---

## What pros do that Atlas doesn't

### 1. BRING-BACK gap (the biggest lineup-level miss)

Per Ch.8 portfolio dynamics, the canonical pro construction is:
> "You may choose to have high exposure to a higher projected under-own starting pitcher and build lineups with him in higher frequency, yet at the same time build a lineup or several lineups that do not have this starting pitcher and actually have 5 opposing hitters against him."

Pros build **17% of their portfolio with at least 1 bring-back hitter** — these are the lineups capturing game-score correlation (when team A scores, team B usually does too in high-total games). Atlas builds bring-back in only 7% of lineups.

Specific pro examples where bring-back was the winning structure:
- 5-3-26 idlove2win (rank 1): **63% of 150 lineups had bring-back** ≥1, 35% had bring-back ≥2. Won 5-3 slate.
- 4-23-26 youdacao (rank 4): 33% bring-back ≥1
- 5-3-26 dannyoms: 19% bring-back ≥1
- 4-8-26 conradical907: 55% bring-back ≥1

### 2. Stack-shape RIGIDITY

Atlas applies ~76% 5-stack rate to every MLB main slate. Pros adapt to slate context:

- **5-stack heavy** (slate favors one team): jmoore3903 on 5-10 = 100% 5-stacks
- **4-stack heavy** (slate has multiple competitive teams): melvco 4-28 = 79% 4-stacks, only 9% 5-stacks. youdacao 4-23 = 82% 4-stacks, only 4% 5-stacks
- **Mixed**: bafoon13 5-5 = 44% 5-stack + 11% 4-stack + 27% 3-stack

Atlas's `TEAM_STACK_CAP=0.20` controls how many teams have 4-stacks, but never decides "no 5-stacks at all" or "all 4-stacks." It's slate-rigid.

### 3. Variance band coverage (Ch.8 prescription)

Ch.8 prescribes: **20% high-projected/high-owned + 60% middle + 20% low-projected/low-owned.**

Pros span: avg_own_sum from 30 (super leverage) to 218 (super chalk). Different pros run different positions on the variance spectrum based on slate strategy.

Atlas on 5-15: avg own sum 129.9 — a SINGLE point in the middle. Atlas doesn't intentionally allocate 20%/60%/20% bands. Its variance is mechanical (selector finds best EV lineups, all of which cluster around the same proj-own balance).

### 4. Slate-specific structural choice (Ch.7 archetypes)

Pros' lineup architecture VARIES per slate based on Ch.7 archetypes:
- 15-game slate → 5-stacks dominate (more game pools available)
- 3-4 game slate → 4-stack + bring-back dominate (more games to cover)
- Low total slate → conservative, more 4-stacks
- High total slate → aggressive 5-stack + bring-back

Atlas applies the SAME selector config across slate types. Memory mentions "extremeCornerCap: false" for NBA showdown handling — but no parallel slate-adaptive logic for MLB stack-shape.

---

## What to implement

### Priority 1: BRING-BACK FLOOR (biggest gap, cleanest fix)

Add to selector: require **17% of lineups have bring-back ≥1, and 8% have bring-back ≥2** (matching pro medians).

Implementation:
- Pre-compute per candidate-lineup: is bring-back ≥1? ≥2?
- During greedy: after step S, check if bring-back rate is below proportional target (e.g., step 50 should have ≥8 bring-back lineups out of 50 to be on track for 17% by step 150).
- If below target: restrict next candidate to bring-back lineups (subject to other caps).

### Priority 2: STACK-SHAPE FLOOR/CAP

Replace flat 20% team stack cap with **stack-shape allocation**:
- e.g., 65% 5-stack, 25% 4-stack, 10% 3-stack (default; adaptive based on slate)
- Selector picks within each bucket; balances across buckets.

### Priority 3: VARIANCE BAND ALLOCATION (Ch.8 explicit prescription)

Split portfolio:
- 20% lineups in HIGH proj × HIGH own region (chalk-anchored boom)
- 60% middle (free)
- 20% lineups in LOW proj × LOW own region (leverage boom)

Currently Atlas selects only the EV-maximizing portion, which clusters at a single (proj, own) point.

---

## Quote-aligned summary

Per Ch.8: "When approaching building a lineup portfolio, it is imperative to optimize by frequency on a LINEUP level rather than simply individual players."

Per Ch.7 archetype #6 (Contest Size) + #7 (The Nuts): "When you need to be CLOSE to the nuts (small contest, tight pool, strong correlations), prefer constructions that allow extremity. When you do not need to be close to the nuts (15-game MLB, 30K-entry), more conservative correlation works."

Atlas's 5-stack rigidity = optimized for "close to nuts" all the time. Pros' shape variability = adapted to contest size and slate context.

---

## Next: implement bring-back floor in Argus-Anchor + test

Target structural fit:
- Bring-back ≥1 rate: 17% (pro median)
- Bring-back ≥2 rate: 8%
- Maintain Atlas's other strengths (5-stack rate, EV calibration)

Will create `_argus_bringback_preslate.ts` and validate on 5-15 (today) + 5-10 historical.
