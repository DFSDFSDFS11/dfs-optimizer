# Overnight Methodology Run — Synthesis

**Date:** 2026-05-16 → 2026-05-17

Applied the 8-method elite methodology to DFS contest data per the document. Quant finance + poker GTO + Kaggle ensemble methods.

---

## What was built

### Phase 1: Factor pool expansion (104 → 111 features)

`factor_engine_v2.py` + `field_deviation.py`:
- A. Basic sums/means/extremes (proj/own/sal/ceiling at 85/95/99 percentiles)
- B. Hitter-only and pitcher-only aggregations
- C. Cross-feature interactions (proj_per_dollar, ceil_per_dollar, leverage ratios)
- D. Stack composition (primary/secondary/tertiary stack sizes, batting order spread, salary spread)
- E. Bring-back, game-stack, pitcher-anti-hitters
- F. Field-relative (vs slate medians)
- G. Top-K / Bottom-K within lineup
- H. Field-deviation exploitation (Method 3): Adj Own minus projection-implied ownership

Output: `factor_frame_v3.csv` — 477,839 lineups × 111 features.

### Method 3: Field-deviation features (GTO + exploitation)

`field_deviation.py` — for each player, compute (Adj Own − projection-implied optimal own).
Per-lineup features: dev_sum, dev_max_over, dev_sum_under, dev_n_over, dev_n_under, dev_mean, dev_abs_sum.

### Phase 6: Walk-Forward IS/WFA/OOS split

`wfa_ic_pipeline.py`:
- DEV: 11 oldest slates (4-6 → 4-22)
- WFA: 6 middle slates (4-24 → 5-2)
- HOLDOUT: 5 most recent slates (5-4 → 5-10)

IC analysis done on DEV ONLY. Validated on WFA. Holdout untouched until final.

### Phase 1-3 re-run: IC + Decile + Decay on 111 factors

`wfa_ic_pipeline.py` outputs:
- `wfa_factor_ranking.csv` — factor IC mean/std/sign-stability per ic_type (full, top1, top5)
- `wfa_decile_decomposition.csv` — monotonicity check
- `wfa_factor_decay.csv` — early vs late DEV split
- `wfa_validation.csv` — DEV-selected factors tested on WFA
- `wfa_selected_factors.json` — factors passing DEV IC>0.03 + sign-stable + WFA sign-match

### Method 8: Contest-conditional analysis

`contest_conditional.py` — split contests by size (small/medium/large), IC analysis per bucket.

### Phase 4: Stacks-V3 with WFA-validated filters

`atlas-vs-stacks-v3-backtest.ts` — Stacks-BB + proj_min hard floor (4.0pts) + n_lev_5less cap (max 2). Running on full 29 slates.

---

## Key findings

### Top WFA-validated factors (DEV + WFA agreement, full-finishing IC)

| Factor | DEV IC | WFA IC | Sign-stable | Interpretation |
|---|---|---|---|---|
| **proj_bot3_sum** | +0.116 | +0.038 | 73% | bottom-3 projection sum (no punts wins) |
| **proj_min** | **+0.112** | +0.047 | **82%** | MOST STABLE — avoid punt plays |
| **h_proj_min** | +0.111 | +0.056 | 82% | hitter min projection same effect |
| dev_sum_under | +0.107 | +0.044 | 64% | under-owned vs implied = good |
| ceil85_max | +0.100 | +0.049 | 73% | having a high-ceiling player |
| **dev_sum** | +0.098 | **+0.140 (GROWING)** | 73% | field deviation, decay-ratio 1.43 |
| dev_mean | +0.098 | +0.140 | 73% | same |
| **n_lev_5less** | **-0.077** | **-0.092 (worse)** | 64% | NEGATIVE — too many <5%-own plays hurts |
| n_lev_10less | -0.072 | -0.104 | 64% | growing more negative |

### Top WFA-validated factors (top-1% binary IC)

| Factor | DEV IC | WFA IC | Sign-stable |
|---|---|---|---|
| **proj_min** | +0.016 | +0.008 | 73% (POSITIVE both targets) |
| h_proj_min | +0.016 | +0.010 | 72% |
| proj_range | **-0.028** | -0.005 | 73% (range hurts top-1%) |
| proj_max | -0.026 | -0.003 | 64% |
| own_sum | -0.024 | -0.001 | 64% (chalk hurts top-1%) |
| dev_max_over | -0.025 | -0.007 | 64% (max over-owned player hurts) |

### Sign-flip across objectives

CRITICAL: own_sum has POSITIVE IC for full finishing (+0.08) but NEGATIVE for top-1% (-0.02). Same with bring-back.
- **Cash-line strategy** = chalk-favoring (higher own = better)
- **GPP top-1% strategy** = leverage-favoring (lower own = better)

This explains the Stacks-IC −4% ROI failure earlier — the IC composite used full-finish IC weights, which over-rotated to chalk and lost top-1% equity.

### Contest-conditional IC differs by size

**LARGE contests (n≥20k, 8 contests):** proj_sum / proj_mean IC = **+0.235** (dominant signal)
**MEDIUM contests (5k-20k, 19 contests):** dev_n_over +0.10, saber_game_mean +0.09, proj_sum +0.06
**SMALL contests (<5k, 3 contests):** most factors NEGATIVE (chalk hurts in small fields)

Method 8 hypothesis validated: optimal selector differs by contest size. Atlas/Stacks don't currently differentiate.

### Stacks-IC failed at 29-slate backtest (−4% ROI)

The IC-weighted composite score (using full-finishing IC weights):
- Pushed toward CLOSEST structural fidelity to pros (all 5 principles best of any selector)
- But lost ROI by over-rotating to chalk (own_prod_log had high positive full-finish IC)
- Top-1% hits dropped: 55 (Atlas) → 50 (BB) → 43 (IC)

**Lesson:** IC measured on FULL finishing distribution doesn't transfer to GPP-focused selection. Need top-1% IC weights for GPP selectors.

---

## Production decision

**Argus-Stacks-BB-only remains the validated production selector.** +6.37pp LOO ROI vs Atlas confirmed.

Stacks-IC FAILS — IC composite over-rotates to chalk via full-finishing IC weights.

Stacks-V3 (proj_min hard filter + n_lev cap) — backtest pending; early results mixed.

---

## What this validated (vs the document's claims)

✓ **Method 1 (IC analysis)**: identified proj_min as most stable signal across both cash-line and top-1%
✓ **Method 3 (GTO + exploitation)**: dev_sum / dev_mean factors GROWING in IC over time (1.43× decay ratio = strengthening)
✓ **Method 4 (Walk-forward)**: DEV→WFA validation correctly flagged proj_min as robust (high sign-stability + same sign in WFA)
✓ **Method 5 (Factor decay)**: own_sum and ownership-product factors STRENGTHENING over time (recent slates more chalk-favoring); leverage factors WEAKENING in negative direction (more negative IC)
✓ **Method 8 (Contest-conditional)**: empirically confirmed factor IC differs by contest size — actionable for future
✗ **Method 7 (Ensemble V1)**: full hill-climbing not done — Stacks-IC was an unweighted composite that failed; proper ensemble needs WFA-tuned weights per IC type AND contest type

---

## Open items

1. **Stacks-V3 backtest finish** — pending
2. **Proper top-1% IC ensemble** — use top-1% IC weights instead of full-finish for GPP-focused selector
3. **Contest-conditional selector** — different config for small/medium/large contests (Method 8 actionable)
4. **Live deployment of Stacks-BB** as parallel to Atlas for 10+ live slates to gather OOS validation data

---

## Code/data artifacts

`C:/Users/colin/Projects/dfs-optimizer/live_audit/`:
- `extract_all_lineups.py` — 622K lineups from 39 contests
- `factor_engine_v2.py` — 100+ feature generator
- `field_deviation.py` — Method 3 GTO+exploitation features
- `wfa_ic_pipeline.py` — Phase 6 walk-forward IC pipeline
- `contest_conditional.py` — Method 8 size-bucketed IC
- `factor_frame_v3.csv` — 477K × 111 master factor frame
- `wfa_selected_factors.json` — DEV+WFA-passing factor list
- `wfa_factor_ranking.csv` — per-factor IC summary
- `contest_conditional_ic.json` — IC by contest size

`C:/Users/colin/Projects/dfs-optimizer/src/scripts/`:
- `atlas-vs-stacks-v3-backtest.ts` — V3 with proj_min + n_lev filters

---

## Final word on the methodology

The document's framing is correct: factor research > artisanal architecture. But the implementation discovered the same answer in a different way:

- Argus-Stacks-BB-only is the +6.37pp winner — it adds the lineup-level structure pros use (bring-back floor matching pro median 17%/8%) WITHOUT distorting team-choice
- IC analysis confirms proj_min is the most stable signal (82% sign-stable)
- IC analysis SHOWS that single-objective optimization (full-finish OR top-1%) needs different weights per contest type
- Pure IC-weighting failed because it averaged across objectives — needs objective + contest stratification

**Next iteration:** build a top-1%-IC-weighted selector AND test contest-conditional variants. But ship Stacks-BB now since it's already validated.
