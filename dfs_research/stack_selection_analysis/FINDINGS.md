# Stack Selection Concentration: Pros vs V1 vs Field

_Analysis run: 2026-05-05T10:27:00.096253_

Descriptive measurement research: where does pros' stack concentration sit relative to the field, and how does V1 differ?

## Methodology Summary
- Slates: 24 MLB slates (4-6-26 through 5-3-26).
- Pros: b_heals152, bgreseth, needlunchmoney, nerdytenor, shaidyadvice, shipmymoney, youdacao, zroth2.
- field_stack_share(T) = (mean(top-6 hitter ownership_T) / 100)^4. Approximation of probability the field stacks 4 from T.
- Field-aligned = primary stack is in field-top-3. Field-contrarian = primary stack in field bottom-50%. Else mixed.
- Winning stack: team whose 4 highest-scoring hitters (DK actuals) sum highest.
- Bootstrap CIs: 10,000 resamples over slates.

## 8A. Stack concentration (top-N share + unique stack teams used)

| Entity | top-1 share | top-2 share | top-3 share | unique teams (avg/slate) | n_slates |
|---|---|---|---|---|---|
| **V1** | 22.4% | 37.8% | 49.4% | 14.0 | 24 |
| b_heals152 | 20.6% | 33.8% | 45.1% | 15.2 | 22 |
| bgreseth | 21.9% | 36.6% | 47.8% | 14.1 | 16 |
| needlunchmoney | 12.7% | 23.7% | 33.1% | 16.2 | 19 |
| nerdytenor | 19.6% | 33.1% | 44.5% | 15.0 | 22 |
| shaidyadvice | 25.6% | 43.3% | 56.4% | 12.9 | 22 |
| shipmymoney | 23.4% | 38.8% | 51.2% | 13.1 | 22 |
| youdacao | 26.0% | 41.7% | 54.3% | 11.2 | 16 |
| zroth2 | 23.2% | 39.6% | 51.8% | 14.0 | 23 |
| **PRO_AVG** | 21.6% | 36.3% | 48.0% | 13.9 | — |

## 8B. Field-relative classification

| Entity | % field-aligned | % mixed | % field-contrarian | unique stack teams (avg/slate) | n_slates |
|---|---|---|---|---|---|
| **V1** | 33.7% | 23.6% | 42.7% | 14.0 | 24 |
| b_heals152 | 34.7% | 33.2% | 32.1% | 15.2 | 22 |
| bgreseth | 37.3% | 31.1% | 31.6% | 14.1 | 16 |
| needlunchmoney | 24.1% | 33.3% | 42.6% | 16.2 | 19 |
| nerdytenor | 36.7% | 34.5% | 28.8% | 15.0 | 22 |
| shaidyadvice | 39.3% | 38.5% | 22.2% | 12.9 | 22 |
| shipmymoney | 40.3% | 32.8% | 26.9% | 13.1 | 22 |
| youdacao | 40.5% | 40.7% | 18.8% | 11.2 | 16 |
| zroth2 | 38.5% | 36.3% | 25.1% | 14.0 | 23 |
| **PRO_AVG** | 36.4% | 35.0% | 28.5% | 13.9 | — |

## 8C. Winning-stack hit rates (bootstrap 95% CIs)

| Entity | hit rate | 95% CI | n slates |
|---|---|---|---|
| V1 | 16.7% | [4.2%, 33.3%] | 24 |
| b_heals152 | 13.6% | [0.0%, 27.3%] | 22 |
| bgreseth | 31.2% | [12.5%, 56.2%] | 16 |
| needlunchmoney | 15.8% | [0.0%, 31.6%] | 19 |
| nerdytenor | 27.3% | [9.1%, 45.5%] | 22 |
| shaidyadvice | 9.1% | [0.0%, 22.7%] | 22 |
| shipmymoney | 13.6% | [0.0%, 27.3%] | 22 |
| youdacao | 6.2% | [0.0%, 18.8%] | 16 |
| zroth2 | 13.0% | [0.0%, 26.1%] | 23 |
| **PRO_AVG** | 16.1% | [7.6%, 25.6%] | 23 |
| Random baseline (1/15.4) | 6.5% | — | — |

## 8D. Field-entity Jaccard overlap

| Entity | J@2 | J@3 | J@5 | n_slates |
|---|---|---|---|---|
| V1 | 0.236 | 0.283 | 0.350 | 24 |
| b_heals152 | 0.439 | 0.450 | 0.443 | 22 |
| bgreseth | 0.333 | 0.369 | 0.481 | 16 |
| needlunchmoney | 0.175 | 0.284 | 0.335 | 19 |
| nerdytenor | 0.439 | 0.486 | 0.472 | 22 |
| shaidyadvice | 0.379 | 0.350 | 0.485 | 22 |
| shipmymoney | 0.348 | 0.436 | 0.486 | 22 |
| youdacao | 0.375 | 0.362 | 0.470 | 16 |
| zroth2 | 0.290 | 0.348 | 0.499 | 23 |
| **PRO_AVG** | 0.347 | 0.386 | 0.459 | — |

Interpretation thresholds: J@3 > 0.7 → field-aligned (exploit not at stack selection). J@3 < 0.3 → field-contrarian (exploit IS stack selection).

## 8E. Specific patterns

### Top 3 most-divergent slates (|pros_top1_share - V1_top1_share|)

| Slate | pros_top1_share | V1_top1_share | gap | pros_consensus | V1_top1 | winner | winner_field_rank |
|---|---|---|---|---|---|---|---|
| 5-2-26-night | 0.000 | 0.393 | -0.393 | None (0/0) | KC | LAA | 4 |
| 4-22-26 | 0.334 | 0.593 | -0.259 | SD (4/8) | SD | ARI | 4 |
| 4-20-26 | 0.171 | 0.307 | -0.136 | LAD (4/8) | LAD | ATH | 15 |

### Slates where pros agreed and V1 missed: 6 / 24

| Slate | pros_consensus | (count) | V1_top1 | winner |
|---|---|---|---|---|
| 4-6-26 | COL | 4/8 | HOU | LAD |
| 4-15-26 | NYY | 4/8 | COL | LAD |
| 4-18-26 | LAD | 4/6 | LAA | SEA |
| 4-21-26 | KC | 3/6 | SEA | KC |
| 4-26-26 | DET | 5/8 | NYY | DET |
| 4-29-26 | CIN | 4/8 | WSH | WSH |

### Slates where winner was neither V1 nor pros heavy: 5 / 24

| Slate | winner | winner_field_rank | n_teams |
|---|---|---|---|
| 4-18-26 | SEA | 8 | 12 |
| 4-23-26 | CHC | 8 | 12 |
| 4-24-26 | BAL | 15 | 26 |
| 4-25-26-early | STL | 9 | 12 |
| 5-2-26 | PIT | 6 | 10 |

### Conviction signal: what features did each entity's top-1 stack team have?

| Entity | % top-1 = highest implied total | % top-1 = highest top-4 projection sum | % top-1 = best value (high proj × low field share) | avg top-1 field_stack_share | n |
|---|---|---|---|---|---|
| V1 | 45.8% | 45.8% | 41.7% | 0.00474 | 24 |
| b_heals152 | 45.5% | 50.0% | 50.0% | 0.00510 | 22 |
| bgreseth | 43.8% | 31.2% | 31.2% | 0.00342 | 16 |
| needlunchmoney | 15.8% | 10.5% | 10.5% | 0.00073 | 19 |
| nerdytenor | 40.9% | 36.4% | 36.4% | 0.00459 | 22 |
| shaidyadvice | 40.9% | 27.3% | 27.3% | 0.00409 | 22 |
| shipmymoney | 22.7% | 36.4% | 36.4% | 0.00263 | 22 |
| youdacao | 25.0% | 25.0% | 25.0% | 0.00323 | 16 |
| zroth2 | 39.1% | 30.4% | 30.4% | 0.00337 | 23 |

## 8F. Verdict

**Mixed/intermediate.** PRO_AVG J@3 = 0.386, % aligned = 36.4%, % contrarian = 28.5%. Pros lean modestly chalk but with notable contrarian tail; not a clean exploit-IS-here verdict.

**Reasoning:**
- PRO_AVG J@3 (0.386) sits between 0.3 and 0.7. % aligned (36.4%) below 0.5 and % contrarian (28.5%) below 0.4.

**Supporting numbers:**
- V1: 33.7% aligned / 23.6% mixed / 42.7% contrarian. Avg unique stacks/slate = 14.0. Hit rate 16.7%.
- PRO_AVG: 36.4% aligned / 35.0% mixed / 28.5% contrarian. Avg unique stacks/slate = 13.9. Hit rate 16.1%.
- V1 J@3 = 0.283, PRO_AVG J@3 = 0.386. (Higher = more overlap with field's chalkiest 3 stacks.)
- Random hit-rate baseline = 6.5%.

## 8G. Implications for V1 (research direction notes only)

Pros' stack-selection pattern is not uniformly chalky or contrarian. Future research direction: examine whether pros are slate-conditional (concentrate on chalk when implied totals are extreme; spread when slate is flat). Cluster slates by features (number of teams, ownership variance, top-team implied total spread) and look for distinct concentration regimes. V1 may benefit from a slate-conditional concentration policy rather than a fixed posture.

## Limitations
- field_stack_share is approximated from individual ownership^4. Real field stack frequencies depend on covariance and stacking conventions; this overestimates concentration for high-own teams and underestimates noise.
- pro lineup pool may be biased: only 8 pros, all relatively concentrated portfolios.
- 24 slates is a small sample for outcome metrics; bootstrap CIs reflect this.
- primaryTeam attribution comes from the dump; lineups without a 4+ stack may have noisy primaryTeam.
- 4-25-26-early treated as a separate slate from 4-25-26 main; both contribute independently.
- 5-2-26-night had no pro lineups in the dump.
