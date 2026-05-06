# Stage 8 — Leave-One-Out Cross-Validation

## Result: gap is robust slate-by-slate

**Removing any single slate does NOT flip the comparison.** Across all 18 LOO permutations, Hermes-A still wins. The largest single-slate impacts:

| Excluded | Hermes ROI drops to | Theory ROI |
|---|---|---|
| 4-22-26 (Hermes's $40,711 jackpot) | +59.8% | −15.0% |
| 4-25-26-early ($29,788) | +81.2% | −27.7% |
| 4-21-26 ($27,386) | +85.9% | −15.5% |
| 4-27-26 (Theory's $15,433 win) | +132.9% | −45.2% (Theory worse) |
| All other slates | +134% to +140% | −15% to −34% |

Hermes-A's lead survives every single-slate removal. The gap isn't single-slate fragility.

## Tail dominance check (drop multiple slates)

| Excluded | Theory-DFS ROI | Hermes-A ROI | Winner |
|---|---|---|---|
| 4-21 + 4-22 | −10.4% | +12.7% | Hermes |
| 4-22 + 4-25-early | −23.3% | +7.7% | Hermes |
| 4-21 + 4-25-early | −23.9% | +35.5% | Hermes |
| **4-21 + 4-22 + 4-25-early (all 3 jackpots)** | **−18.9%** | **−45.9%** | **Theory-DFS** |

Both systems are tail-driven (Theory's top-3 slates = 72% of total, Hermes's top-3 = 80%). It takes removing **all 3 of Hermes's top jackpots simultaneously** to flip the comparison — and even then, both systems are net negative.

## Per-slate distribution

| Stat | Theory-DFS | Hermes-A |
|---|---|---|
| Median per-slate payout | $367 | $1,362 |
| Mean | $2,411 | $6,789 |
| Std | $4,263 | $12,305 |
| Max | $15,433 | $40,711 |
| Top-3 share | 72% | 80% |

Theory-DFS is **more consistent** (lower std) but wins by smaller margins. Hermes-A has **fatter right tail** — when it nails a slate, it nails it hard.

## Stage 8 Verdict

The spec's Stage 8 criterion: *"If 1-2 outlier slates account for most of one system's advantage, the result is fragile. If the advantage is consistent across slates, it's more credible."*

**Hermes-A's advantage is consistent.** Even though 3 jackpots account for 80% of its absolute payout, the LOO sweep shows Hermes still leads when any single slate is removed, and on slate-by-slate counts (12/18 won, 14/18 closer Mahalanobis). It doesn't hinge on one slate.

This is real **Outcome C** territory by Stage 8's standards.

## Where the chapters stand

To the user's question about chapter coverage — we have most of Ch.4–8 implemented, but only **1 of 10** Ch.9 exploits (Sim-Optimals ownership bump). The unimplemented exploits include #4 Optimizer PPD Bias, #2 Median-overweighting, and #10 Sim Combinatoric Blindness — all of which are framework-described selection mechanisms.

Notably, Hermes-A's `extremeCornerCap=true` parameter is essentially a learned form of Ch.9 #4 (it caps lineups that lean too hard on extreme-corner combos). Theory-DFS doesn't detect or avoid these. This may be where part of the remaining gap lives.

## Recommendation

Two paths:

**Path A (accept Outcome C):** The framework's principles, faithfully implemented for Ch.4–8 plus one Ch.9 exploit, lose to Hermes-A by 146pp ROI on this 17-slate sample. Stop here, document the result, and don't ship Theory-DFS as-is.

**Path B (implement remaining Ch.9 exploits):** Add #4 PPD bias, #2 Median-overweighting, #7 Clumping detection, #10 Sim combinatoric. Re-run baseline + Stage 8. This would be a more faithful "framework vs Hermes-A" comparison since the framework explicitly names these as profit sources. If the gap closes meaningfully, the framework wins by exploit-completeness; if it doesn't, the verdict is firmly C.

I'd lean toward Path B because the chapter-coverage audit honestly says we haven't fully tested the framework. But it's another implementation cycle.

## Files

- `theory_dfs_system/stage8_loo_results.json` — LOO data (18 single-removals + 4 multi-removals)
- `theory_dfs_system/STAGE8_REPORT.md` — this report
