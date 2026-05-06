# Tier 1/2/5 Descriptive Analysis — Synthesis

**Sample**: 3,300 V1 lineups + 16,800 pro lineups across 23 MLB slates. Descriptive analysis only — no variant testing, no parameter tuning. Output: hypotheses to monitor in live deployment.

---

## T1 — Per-lineup structural fingerprint comparison

V1 has a **moderate right tail of structurally anomalous lineups** but most V1 lineups are pro-shaped.

| Percentile | Manhattan distance to nearest pro |
|---|---|
| p25 | 0.58 |
| median | 0.99 |
| p75 | 1.64 |
| p90 | 2.48 |
| p95 | 3.17 |
| max | 9.41 |

**Tail thickness**: 200 lineups (6.1% of V1) have distance > 3× median.

### Per-slate variance is small
Per-slate median distance ranges 0.60–2.05 (std 0.32). The 0.60 slate is V1's most pro-like; the 2.05 slate is least pro-like. Slate identity matters, but not dramatically.

### Outlier characteristics
Top-10 farthest V1 lineups break into two failure modes:

1. **Extreme game-stacks** — 5-3 stacks with BB=3, producing 8-player game-stacks across only 3 games. (Examples: 5-1-26 ATL d=9.41, two more 5-1-26 ATL with d=6.75–6.82.) These are degenerate "all-eggs-one-game" lineups.
2. **Extreme contrarian builds** — 5-2 with 0 bring-back, geoMeanOwn ~2-4%. (Examples: 4-26-26 STL, 5-2-26-main COL, 4-17-26 CIN.) Pro-rare contrarian constructions.

**Outliers don't cluster in failures**: the 10 farthest lineups have finishPct ranging 0.015 → 0.905 — some hit, some bust. So the outlier tail is *structurally* anomalous but not *systematically* losing. They're mostly random variance.

### Hypothesis to monitor
> Track per-slate the fraction of V1 lineups with distance > 3× pro-median. If the 6.1% outlier rate spikes to 15-20% on certain slates, V1 may be drifting from pro patterns on those slate archetypes.

---

## T2 — Game stack rate analysis

**Null finding.** V1 and pros both produce ~100% game-stacked lineups for MLB. The metric is saturated.

| Game stack | V1 % | Pros % | gap |
|---|---|---|---|
| 2+ players in same game | 100.0% | 100.0% | 0.0pp |
| 3+ | 100.0% | 99.9% | +0.1pp |
| 4+ | 100.0% | 96.5% | +3.5pp |

Per-slate variance is negligible (std 0.0–0.1pp). This metric doesn't discriminate.

### Why it's saturated
MLB lineups are inherently game-stacked: pitcher + opposing hitters always live in the same matchup, so any 5-stack + 1 BB → 6 players in a single game by construction. Pros' 96.5% rate at 4+ is essentially noise from rare 4-stack-no-BB constructions; V1's 5-stack-with-BB convention forces 4+ game-stacks always.

### Hypothesis to monitor
> Skip this metric. Game-stack rate doesn't differentiate V1 from pros in MLB. (Would matter for NFL where game-stack is a meaningful portfolio choice.)

---

## T5 — Worst-V1-lineup forensics

**Strong finding.** V1's worst lineups have identifiable recurring features.

### Feature comparison (worst 20% vs best 20% by finish percentile, 674 lineups each)

| Feature | Worst mean | Best mean | Δ |
|---|---|---|---|
| **projection** | **92.81** | **97.11** | **−4.30** |
| **geoMeanOwnHit** | **5.92** | **7.45** | **−1.52** |
| primarySize | 4.94 | 4.95 | −0.02 |
| bringBack | 0.98 | 1.04 | −0.06 |
| salaryStd | 2050.92 | 2075.37 | −24.45 |
| numGames | 4.03 | 4.01 | +0.01 |

**The two dominant signals**: lower projection (−4.3 pts) and lower hitter ownership (−1.52pp geoMean) characterize V1's losers. Worst lineups are contrarian projection-suboptimal builds.

### Archetype distribution

| Archetype | Worst % | Best % | Δ |
|---|---|---|---|
| **5-stack / BB0 (naked 5)** | **35.6%** | **31.2%** | **+4.5pp** |
| 5-stack / BB1 | 29.8% | 31.9% | −2.1pp |
| **5-stack / BB2** | 22.0% | 27.2% | **−5.2pp** |
| 5-stack / BB3 | 6.2% | 5.0% | +1.2pp |

**Naked 5-stacks systematically underperform** (+4.5pp in worst-bucket). **5+BB2** is V1's strongest archetype (−5.2pp in worst means it over-indexes in best). This is the cleanest actionable finding.

### Pitchers over-represented in V1 failures (worst − best)

| Pitcher | in worst | in best | net |
|---|---|---|---|
| Bryan Woo | 38 | 9 | **+29** |
| Nolan McLean | 47 | 21 | **+26** |
| Framber Valdez | 27 | 3 | **+24** |
| Logan Gilbert | 59 | 37 | **+22** |
| Cristopher Sanchez | 22 | 4 | **+18** |
| Lance McCullers Jr. | 16 | 3 | +13 |

These pitchers appeared 2-5× more often in V1 losers than winners. **Note: McLean is a chalk anchor V1 currently picks at 60%+ exposure** — that's a calibration concern. Either V1 over-uses McLean, or McLean's actual outcomes diverged from his projections across multiple slates.

### Pitchers over-represented in V1 successes

| Pitcher | net |
|---|---|
| Will Warren | −25 |
| Max Fried | −20 |
| Jose Soriano | −19 |
| Freddy Peralta | −19 |
| Bailey Ober | −18 |
| Max Meyer | −18 |
| Shohei Ohtani | −18 |
| Tyler Glasnow | −16 |
| Chris Sale | −18 |

Mid-tier projected SPs dominate the winners list, **including Soriano** which the original A7 finding flagged as V1 over-exposing vs pros (+14pp gap). T5 says Soriano was actually a *good* call — he over-indexed in V1 winners. So the A7 framework hypothesis ("over-exposed leverage SPs underperform") is **not supported** by direct outcome analysis.

### Stack teams over-represented in failures

| Team | in worst | in best | net |
|---|---|---|---|
| SF | 28 | 6 | +22 |
| PHI | 40 | 19 | +21 |
| SD | 41 | 23 | +18 |
| COL | 54 | 38 | +16 |
| CWS | 35 | 21 | +14 |
| WSH | 33 | 20 | +13 |

V1 over-stacks these teams and they fail more often than succeed. SF, PHI, SD, COL, CWS, WSH are V1's stack-failure cluster.

### Hypotheses to monitor (T5)

1. **Naked 5-stacks underperform.** Track per-slate finish-rank distribution split by archetype. If naked 5s consistently land bottom-quartile, V1's stack-bonus formula `0.10 × (size-2)` may not capture the bring-back premium correctly.
2. **Specific pitchers.** Watch Woo, McLean, Valdez, Gilbert, Sanchez when V1 picks them. If they continue to over-index in losses, pitcher leverage fix may be overcorrecting toward chalk.
3. **Specific stack teams.** Watch SF, PHI, SD, COL, CWS, WSH stacks. If continued failures, V1's correlation bonus may be miscalibrated for these teams' lineup environments.

---

## Combined synthesis

| Tier | Finding | Strength |
|---|---|---|
| T1 | V1 has 6.1% structural-outlier tail; outliers don't systematically fail | Weak (descriptive only) |
| T2 | Game-stack rate doesn't differentiate V1 vs pros in MLB | Null (saturated metric) |
| **T5** | **Naked 5-stacks underperform; specific pitchers/teams over-fail** | **Strong** |

### Most actionable: T5 archetype finding
The 5-stack/BB0 vs 5-stack/BB2 gap (+4.5pp / −5.2pp) is V1's clearest performance asymmetry. It's not a hypothesis about pro-similarity — it's a direct outcome correlation in V1's own portfolios across 23 slates.

### What this is NOT
- Not a backtest variant. Don't build "V9 = penalize naked 5-stacks" on this data.
- Not parameter tuning. Don't adjust BRINGBACK_2 magnitude based on this.
- Pure descriptive: live deployment will reveal whether the naked-5 underperformance persists or reverses.

### Live deployment monitoring scorecard

| Signal | Track |
|---|---|
| Naked 5-stack rate in V1 portfolio | Per-slate, flag if >40% |
| Naked-5 finish percentile distribution | Per-slate, flag if median <0.45 |
| Bryan Woo / Nolan McLean / Framber Valdez exposure when V1 picks them | Per-slate finish |
| SF / PHI / SD / COL stack outcome | Per-slate finish percentile |
| Outlier-tail rate (V1 lineups with fingerprint distance >3× pro median) | Per-slate, flag if >15% |

Files:
- `T1_fingerprint.md` (full per-slate)
- `T2_gamestack.md`
- `T5_worst_v1_forensics.md`
- This synthesis: `T1_T2_T5_SYNTHESIS.md`
