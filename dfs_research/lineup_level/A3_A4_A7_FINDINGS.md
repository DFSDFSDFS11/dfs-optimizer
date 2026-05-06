# Three Lineup-Level Findings — Live-Monitoring Hypotheses

Three structural analyses on V1's 2,700 lineups vs pros' 14,100 lineups across 18 MLB slates. **Per methodology constraint: these findings are hypotheses to monitor in live deployment, not triggers for backtest variant testing.**

The V2/V3 path showed that backtest-driven fixes for structural findings introduce overfitting at the implementation level. Live data validates implementation choices in a way 18-slate backtest can't.

---

## Finding 1 (PRIORITY): V1 over-concentrates on 5-stacks vs pros' diverse stack-size mix

**A3 — Stack size distribution**

| Primary stack size | V1 % | Pros % | Δ |
|---|---|---|---|
| 3 | 0.0% | 7.2% | −7.2pp |
| **4** | **5.1%** | **23.9%** | **−18.8pp** |
| **5** | **94.9%** | **68.3%** | **+26.6pp** |

**Stack archetype:**

| | V1 % | Pros % | Δ |
|---|---|---|---|
| 5-2 (5-stack + bring-back of 2) | 55.0% | 41.2% | +13.7pp |
| 5-naked (5-stack, no BB) | 25.0% | 15.8% | +9.2pp |
| 5-3 | 15.0% | 11.4% | +3.6pp |
| **4-3** | **2.2%** | **13.8%** | **−11.6pp** |
| 4-2 | 2.6% | 9.0% | −6.4pp |
| 3-3 | 0.0% | 3.8% | −3.8pp |

**Diagnosis:** V1's `STACK_BONUS_PER_HITTER = 0.10 × (size - 2)` gives 5-stacks +30% projection bonus and 4-stacks only +20%. In EV ranking, 5-stacks systematically beat 4-stacks. Pros' actual flexibility on stack size (24% 4-stacks, 7% 3-stacks) suggests slate-specific judgment that V1 lacks.

**Live-monitoring hypothesis:** On slates where pros heavily use 4-stacks or 3-3 splits, V1 will systematically miss the slate archetype. Track per-slate: did pros' modal stack-size match V1's (≈always 5)? When they diverge, does V1's portfolio underperform?

**Why this matters more than aggregate metrics:** Mahalanobis-to-pros didn't catch this because the 5-metric framework averages across the portfolio. The stack-size distribution shows V1 is consistent — just consistent at the wrong distribution.

---

## Finding 2: Pitcher selection is V1's primary calibration gap (hitters are well-matched)

**A7 — Specific player exposure differences**

Position-level mean exposure-gap std vs pros:

| Position | Mean gap | Std |
|---|---|---|
| **Pitcher (P)** | −0.2pp | **7.5pp** |
| 1B | +0.2pp | 2.2pp |
| 2B | +0.4pp | 2.4pp |
| 3B | −0.2pp | 2.5pp |
| SS | +0.2pp | 2.5pp |
| OF | +0.0pp | 2.4pp |
| C | +0.0pp | 2.2pp |

**Hitter gaps are noise (std 2.2-2.5pp). Pitcher gaps are 3× larger (std 7.5pp).** This is the cleanest signal.

**V1 OVER-exposes (mid-tier leverage SPs):**

| Player | V1 exp | Pro exp | gap | proj | own |
|---|---|---|---|---|---|
| MacKenzie Gore | 62.7% | 37.6% | **+25pp** | 21.4 | 31% |
| Robbie Ray | 54.7% | 32.7% | +22pp | 17.8 | 36% |
| Jose Soriano | 34.0% | 20.0% | +14pp | 18.0 | 19% |
| Michael Soroka | 26.7% | 13.9% | +13pp | 16.1 | 18% |

**V1 UNDER-exposes (chalk aces):**

| Player | V1 exp | Pro exp | gap | proj | own |
|---|---|---|---|---|---|
| Brandon Woodruff | 2.7% | 27.1% | **−24pp** | 15.8 | 28% |
| Joe Ryan | 25.6% | 39.8% | −14pp | 18.5 | 31% |
| Kevin Gausman | 12.0% | 25.5% | −14pp | 15.9 | 38% |
| Eury Perez | 27.1% | 39.8% | −13pp | 15.5 | 28% |
| Yamamoto | 32.7% | 45.1% | −12pp | 20.7 | 39% |
| Glasnow | 21.0% | 33.3% | −12pp | 18.2 | 38% |

**Diagnosis:** V1's `W_LEV = 0.30` ownership penalty pushes selection toward mid-tier leverage pitchers (Gore, Ray, Soroka) and away from chalk aces (Woodruff, Yamamoto, Sale). Pros pay up for chalk aces because the projection-vs-ownership trade-off favors them.

**Live-monitoring hypothesis:** When V1 picks a leverage SP (Gore, Ray) instead of the chalk ace (Woodruff, Yamamoto) on the same slate, does V1's portfolio underperform the pro choice? Track per-slate: did V1's pitcher choice differ from pros' modal pitcher? Outcome correlation will reveal whether the leverage premium is real edge or systematic miscalibration.

**Caveat:** Most of these per-pitcher findings have only 2-3 slate observations. The position-aggregate signal (std 7.5pp on P vs 2.4pp on hitters) is the robust signal; specific player gaps need more slates.

---

## Finding 3: V1's contrarian band shifts STACK SIZE — pros keep stack architecture constant across ownership bands

**A4 — Ownership-stratified construction**

Comparison of bottom-25% (Q1, contrarian) vs top-25% (Q4, chalk) within each portfolio:

| Metric | V1 Q1 | Pros Q1 | V1 Q4 | Pros Q4 | V1 Q4-Q1 | Pros Q4-Q1 |
|---|---|---|---|---|---|---|
| primary stack size | 4.82 | 4.60 | 5.00 | 4.64 | **+0.18** | +0.05 |
| bring-back size | 0.54 | 0.28 | 1.08 | 0.41 | **+0.55** | +0.13 |
| ownership | 7.10% | 10.03% | 19.68% | 20.14% | +12.6 | +10.1 |
| salary | $49,378 | $49,247 | $49,633 | $49,558 | +$255 | +$310 |
| range | 129 | 135 | 143 | 145 | +14 | +9 |

**4-stack vs 5-stack rates per quartile:**

| | Q1 (contrarian) | Q4 (chalk) |
|---|---|---|
| **V1** | 18% 4-stack / 82% 5-stack | **0% 4-stack / 100% 5-stack** |
| Pros | 25% 4-stack / 67% 5-stack | 23% 4-stack / 71% 5-stack |

**Diagnosis:** Pros use **the same stack architecture** across ownership bands (≈24% 4-stacks regardless). The contrarian-ness comes from picking lower-projected/lower-owned **players within the same stack structure**. V1's contrarian band has SMALLER stacks (more 4-stacks, less correlated) AND fewer bring-backs — it's reducing correlation in the contrarian band, not just swapping players.

This is the OPPOSITE of the "swap-in" failure mode the user warned about. V1 IS making structural shifts — but the shift direction (smaller stacks in contrarian) reduces correlation upside, while pros keep correlation maximized in both bands.

**Live-monitoring hypothesis:** V1's contrarian-band 4-stacks may underperform vs the pro pattern of consistent 5-stack architecture. Track over live slates: do V1's Q1 (contrarian) lineups have lower top-1% hit rate than would be expected from the 5-stack-only Q4? If yes, V1's contrarian construction is leaving correlation upside on the table.

---

## Combined live-monitoring scorecard

| Hypothesis | Track signal | Interpretation if confirmed |
|---|---|---|
| V1 over-uses 5-stacks (+27pp) | Per-slate: pros' modal stack size vs V1's | If pros use 4-stack on slate X and V1 uses 5-stack, V1's portfolio scores worse → fix correlation lever calibration |
| V1 picks leverage SPs over chalk aces | Per-slate: did V1's modal SP match pros'? Outcome of that pitcher | If V1's leverage SP underperforms pros' chalk SP repeatedly, ownership penalty too aggressive on pitcher position |
| V1's contrarian band has smaller stacks | Per-slate Q1 (V1's bottom-25% own) lineups: do they score worse than Q4 of same V1 portfolio when controlled for projection? | If yes, V1 contrarian construction is sacrificing correlation that pros preserve |

**Decision rule for translating live data into changes:** if a hypothesis is confirmed across 10+ live slates with consistent direction, then design a targeted fix. If confirmed but inconsistent (some slates show pattern, others don't), the calibration is conditional — needs slate-archetype-aware mechanism. If not confirmed in 20+ live slates, hypothesis was sample artifact and don't fix.

## Why these three together

- **A3** = the strongest aggregate signal (V1's 95% 5-stack rate vs pros' 68%, +27pp gap is the largest finding across all 9 lineup-level analyses).
- **A7** = the most actionable specific finding (pitcher selection identifiable as the dominant calibration gap).
- **A4** = the structural finding that catches a failure mode aggregate metrics miss (V1's contrarian band shrinks stacks; pros don't).

These three converge on: **V1's correlation/ownership lever balance is off in two specific ways — over-bonus for stack size, over-penalty for high-owned pitchers.** Both are hypotheses to monitor live. Don't fix in backtest (V2/V3 path showed why).

## Files

- Analyzers: `lineup_level/A3_analyzer.py`, `A4_analyzer.py`, `A7_analyzer.py`
- Raw data: `A3_raw.json`, `A4_raw.json`, `A7_raw.json`
- This synthesis: `A3_A4_A7_FINDINGS.md`
