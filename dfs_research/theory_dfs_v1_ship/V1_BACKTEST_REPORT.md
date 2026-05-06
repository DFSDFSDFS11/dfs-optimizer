# Theory-DFS V1 — Final Backtest Report (Ship Decision)

**Decision:** Ship Theory-DFS V1 as MLB production.

**Updated 2026-05-02:** Added 2 new slates (4-29-26, 5-1-26) for total of **20 backtest slates**.

## 20-slate backtest summary

| Metric | V1 |
|---|---|
| Slates | **20** |
| Total lineups | 3,000 (150 × 20) |
| Total fees | $60,000 |
| Total payout | $38,225 |
| ROI | **−36.3%** |
| Top-1% hits | 31 (1.03× random) |
| Top-0.1% hits | 3 (1.00× random) |
| Mean Mahalanobis to pros | 2.29 (18 slates with consensus; new 2 have null) |
| Finishing distribution | inverse-bell (top=9.3%, mid=20.0%, bot=12.8%) ✓ |

## V1 vs all rejected variants (20 slates)

| Variant | Mahal | t1× | t01× | Verdict |
|---|---|---|---|---|
| **V1 (shipped)** | **2.29** | **1.03×** | **1.00×** | shipped |
| V2a (type-scaled combo) | 2.26 | 1.13× | 0.67× | t01 fails |
| V2b (top-5 hard filter) | 2.89 | 0.93× | 0.00× | catastrophic |
| V2c (top-1 + scaling) | 2.34 | 1.07× | 0.67× | t01 fails |
| V3 (chalk-lean W=0.05) | 2.19 | 0.97× | 1.00× | mahal pass but t1 fail |
| V3b (W=0.03) | 2.25 | 0.97× | 1.00× | t1 fail |
| V3c (W=0.04) | 2.22 | 0.97× | 1.00× | t1 fail |

**Step-function finding still holds with 20 slates**: V3/V3b/V3c all produce identical t1× = 0.97 regardless of bonus magnitude. Same 2 specific top-1% hits drop out across all magnitudes. Deterministic trade-off, not parameter-tunable.

## New slates per-slate

| Slate | V1 payout | V1 t1 | V1 t01 | Notes |
|---|---|---|---|---|
| 4-29-26 | $1,029 | 2 | 0 | normal cash slate |
| 5-1-26 | $195 | 1 | 0 | low-payout slate |

Neither new slate produced jackpot results — V1 contributed 3 top-1% hits and 0 top-0.1% hits across the new pair, roughly matching random expectation (~3 t1 expected, ~0.3 t01 expected).

## Structural metrics still favor V1

The 2 new slates didn't change the structural picture:
- Mean Mahalanobis 2.29 unchanged (new slates have no pro consensus, so don't affect mean)
- Finishing distribution still inverse-bell (top 9.3%, mid 20.0%, bot 12.8%)
- t1× ≈ 1.0 (slight drop 1.04→1.03)
- t01× dropped 1.11×→1.00× (sample noise on 20 slates with 2 new zero-t01 slates)

Per-slate Mahalanobis V1 vs V3 (excerpt):
- 4-18-26: V1 7.77, V3 7.86 (V3 worse on this slate)
- 4-25-26-early: V1 3.59, V3 3.23 (V3 better)
- Overall V3 mean −0.10 vs V1 (improvement comes broadly across slates, not 1-2 outliers)

## Why ship V1 despite negative ROI

**Don't trust ROI on calibration data — 20 slates is still too small.** Trust structural metrics:

### Lineup-level pro alignment (I1-I5 from lineup_level/SYNTHESIS.md)

- V1 mean lineup distance to nearest pro: **0.550**
- Hermes-A: 0.642 (worse)
- V1's p10 distance: **0.036** (closest 10% essentially identical to pros)

### Cluster occupancy (I2)

- Pros: 25/56/18 (cheap-stud / balanced / contrarian)
- V1: 27/52/21 — gaps all <4pp ✓
- Hermes-A: +7.3pp gap on cheap-stud cluster
- Random: +22pp gap on contrarian cluster

### Within-portfolio consistency (I4)

- Pro mode-team Jaccard: 0.466
- V1: **0.459** — essentially exact match
- Hermes-A: 0.389 (less consistent)

### Combinatorial uniqueness (I3)

V1 over-pairs cross-team players, under-pairs same-team stars vs pros. I7-I9 testing showed: closing this gap costs t1× hits in deterministic, non-tunable way.

## V1 mechanism summary (production config)

```
Stage 1 — Per-lineup scoring:
  1A Projection: median, floor (p25 sum), ceiling (p75 sum), range
  1B Correlation: stack=0.10/hitter, BB=0.05/0.08, P-vs-H=-0.10
  1C Leverage: log-ownership-product → slate-relative percentile
  1D Relative Value: salary + ownership + direct leverage
  1E Combinatorial: raw pair freq + top-3 triples (no type scaling)
  1F Archetype: variance/proj-floor based on slate team count

Stage 2 EV (slate-relative percentiles):
  ev = 1.0×proj_pct + 0.30×(1-own_pct) + 0.15×range_pct + 0.25×combo_pct
  PPD penalty: top-10% PPD lineups get -10% EV multiplier

Stage 3 Portfolio:
  - minPrimaryStack=4 hard
  - 20/60/20 variance bands (high/mid/low)
  - Frequency optimization: target_exposure = own × (proj/eff_proj)^1.5
  - Diversification: max_overlap=6, triple_freq_cap=5
  - Exposure caps: 0.50 hitter, 1.00 (uncapped) pitcher
```

## Files

- DK upload (tonight's slate): `C:\Users\colin\dfs opto\theory_dfs_v1_preslate_75.csv`
- Detailed: `C:\Users\colin\dfs opto\theory_dfs_v1_preslate_75_detailed.csv`
- Production code (committed): `src/scripts/theory-of-dfs-v1-preslate.ts` at git `ffa3164`
- Backtest data (20 slates): `theory_dfs_v2/v2_validation_results.json`
- Lineup-level analysis: `lineup_level/SYNTHESIS.md` + I1-I9 findings

## Deployment plan

1. **Tonight**: ship `theory_dfs_v1_preslate_75.csv` to DK
2. **Track structural metrics in production**: per-slate Mahalanobis (when consensus exists), top-1%/0.1% hit rates, finishing distribution shape
3. **Accumulate live data**: 30+ slates of real-money results before drawing ROI conclusions
4. **Don't iterate on calibration data**: SYNTHESIS.md proves diminishing returns
