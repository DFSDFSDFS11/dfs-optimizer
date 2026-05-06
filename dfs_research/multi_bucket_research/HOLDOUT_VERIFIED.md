# HOLDOUT INTEGRITY VERIFICATION — Stage 1

**Verified at:** 2026-05-03
**Verifier:** multi_bucket_research Stage 1 process
**Source of truth:** `C:/Users/colin/dfs opto/slate_derived_research/HOLDOUT_LOCK.md` (locked 2026-05-03, seed 42)

## 8 sealed holdout slates (NOT to be touched until Stage 6)

1. 4-6-26
2. 4-14-26
3. 4-15-26
4. 4-19-26
5. 4-20-26
6. 5-1-26
7. 5-2-26
8. 5-2-26-night

## 16 development slates (Stages 3-5)

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

## Verification

For each holdout slate `<S>`, verified zero files matching `^<S>_(detail|dk)\.csv$` exist in:
- `C:/Users/colin/dfs opto/slate_derived_research/development_results/A/`
- `C:/Users/colin/dfs opto/slate_derived_research/development_results/B/`
- `C:/Users/colin/dfs opto/slate_derived_research/development_results/C/`

Result: **0 violations across all 24 (slate, bucket) combinations.**

Naming-collision care: `5-2-26-main` is in dev and present in prior dev_results; `5-2-26` (bare) and `5-2-26-night` are in holdout. The regex `^<slate>_` correctly distinguishes — `5-2-26-main_detail.csv` does not match `^5-2-26_` because the next character is `-`, not `_`. Both `5-2-26_*.csv` and `5-2-26-night_*.csv` were searched and not found.

## Lock affirmation

Holdout slates will not be opened, projected, scored, lineup-built, visualized, or summary-statted in Stages 2-5 of this research. The first read of any holdout-slate raw data is gated on Stage 5 selection passing.

Stage 1 PASS. Proceeding to Stage 2 specification.
