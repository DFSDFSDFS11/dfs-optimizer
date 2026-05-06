# Mathematical Reconciliation — Stage 5

**Question:** does one-off hitter slot concentration close the residual ~76× full-lineup pairwise gap between V1 and pros?

## Inputs

| Component | V1 | Pro avg | Ratio (pro/V1) | Source |
|---|---:|---:|---:|---|
| Within-stack 5-set top-1 share | 0.172 | 0.220 | 1.28× | Analysis 3 (within_stack_analysis) |
| One-off top-1 share (≥5 lineups/group) | 0.175 | 0.185 | 1.06× | This analysis (Stage 4) |
| Cross-cell coupling | ~1.0 | ~1.0 | 1.0× | Analysis 4 |
| Stack-team selection | ~14 teams | ~14 teams | 1.0× | Analysis 2 |

The one-off ratio of 1.06× is barely meaningful given V1 (0.175) sits inside the bootstrap CIs of most pros (e.g., b_heals152 [0.157, 0.218], needlunchmoney [0.159, 0.179], zroth2 [0.156, 0.183]).

## Method A — multiplicative dominance approximation

Formula:
```
predicted_ratio_A = (within_stack_pro / within_stack_V1)^2
                  × (one_off_pro / one_off_V1)^2
```

Computation:
- Within-stack factor: (0.220 / 0.172)² = 1.636
- One-off factor: (0.185 / 0.175)² = 1.120
- **Product = 1.83×**

Interpretation: the multiplicative dominance prediction is **1.83×**, far below the observed **76×** (a factor of ~42× short, or ~3.5 orders of magnitude on a multiplicative scale).

## Method B — Herfindahl-based, full distribution

For each entity within each slate, compute the Herfindahl index of the joint distribution over the full 4-tuple `(stack_set, bring_back_set, pitcher_set, one_off_set)` — a direct measure of `P(two random lineups are identical)` along these four axes.

Reported in two flavors:

### B1 — per-pro average (fair: matches sample size since each pro has ~150 lineups, like V1)

For each slate, compute Herfindahl per-pro and per-V1; report the mean of the per-pro Herfindahls divided by V1 Herfindahl.

- 23 slates
- **Arithmetic mean ratio = 1.42×**
- **Geometric mean ratio = 1.15×**

### B2 — pooled pros (biased: pooling 8 pros' lineups dilutes Herfindahl by ~8×)

Pooled over all pro lineups in a slate (~1,200 keys vs V1's 150 keys).

- Arithmetic mean ratio = 0.20×
- Geometric mean ratio = 0.16×

This pooled version is informational only — it confounds sample-size effects with concentration. Each pro has ~150 lineups, so per-pro Herfindahl is the apples-to-apples comparison against V1.

## Bottom line

| Method | Predicted ratio | Observed | Closes gap? |
|---|---:|---:|---|
| A (multiplicative) | 1.83× | 76× | **No** — 42× short |
| B1 (per-pro avg, fair) | 1.42× | 76× | **No** — 53× short |
| B2 (pooled, biased) | 0.20× | 76× | **No** — inverted |

**Both methods, on every reasonable construction, predict ratios in the 1–2× range, vs an observed 76× full-lineup pairwise correlation gap.**

The hypothesis that one-off hitter concentration is the dominant residual mechanism is **NOT supported**.

## Cross-check: confirm pro one-off concentration is not actually higher in raw form

Bootstrap 95% CIs from Stage 4:
- V1: 0.175 [0.159, 0.196]
- youdacao: 0.240 [0.213, 0.271]  ← only pro materially above V1
- shipmymoney: 0.209 [0.189, 0.230]  ← marginally above
- nerdytenor: 0.190 [0.175, 0.208]  ← overlaps V1
- b_heals152: 0.184 [0.157, 0.218]  ← overlaps V1
- needlunchmoney: 0.169 [0.159, 0.179]  ← below V1
- zroth2: 0.169 [0.156, 0.183]  ← below V1
- bgreseth: 0.163 [0.151, 0.176]  ← below V1
- shaidyadvice: 0.160 [0.152, 0.168]  ← below V1

Five of eight pros have one-off top-1 share AT or BELOW V1's. Pro average being 5–6% above V1 is dominated by two pros (youdacao, shipmymoney). This is the opposite signature from within-stack concentration where pros uniformly beat V1.

## Reconciliation outcome

The 76× residual does NOT live in concentrated one-off hitter selection within fixed structured contexts. With:
- Stack-team selection: 1×
- Within-stack 5-set: 17× (analysis 3, prior, observed-on-comparable-Jaccard scale)
- Cross-cell coupling: 1×
- One-off concentration: ~1–2× (this analysis)

Multiplicative chain still falls short of 76× by an order of magnitude. The residual must live elsewhere. Candidate next directions (research only, not deployment):

1. **Position-slot correlations** — pros may concentrate on the same SS or the same OF3 player across structurally-different lineups (a player-level rather than lineup-level effect).
2. **Game-stack correlations across "different" structured contexts** — e.g., pros use the same one-off bat across multiple stack contexts (cross-context coupling, opposite of what this analysis measured).
3. **Salary-distribution-driven over-concentration on cheap value** — pros may all default to the same min-priced punt (cheapest 4 OF / cheapest C) regardless of stack, which would inflate full-lineup pairwise similarity even when structured cells differ.
4. **Methodological: re-examine the 76× number itself.** Analysis 1's full-lineup Jaccard ratio may be measuring something not fully reducible to the multiplicative chain (e.g., it may include same-pitcher-pair effects double-counted, or framework-R-value effects orthogonal to lineup similarity).

## Limitations

- 24 slates; per-pro qualifying-group counts range from 29 (b_heals152, nerdytenor) to 130 (shaidyadvice). Concentration estimates for pros with few groups have wide CIs.
- One-off slot count varies by lineup: 0–6 one-offs (most lineups have 3 one-offs given common 5-stack + 1-BB + 2-P shape; needlunchmoney + nerdytenor sit at ~4 one-offs more often, lowering their concentration mechanically).
- Method A assumes independence of stack and one-off concentration — they may be coupled, but this would only push the prediction up modestly, not by 40×.
- Method B per-pro-avg uses each pro's own Herfindahl; if a pro is highly diversified per-lineup but shares lineup keys with other pros, the cross-pro pairwise rate would be higher — not what this analysis measures.
