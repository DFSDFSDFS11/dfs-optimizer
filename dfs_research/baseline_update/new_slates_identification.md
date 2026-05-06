# Stage 1 — New Slates Identification & Holdout Check

**Run date:** 2026-05-03

## Holdout list (from `slate_derived_research/HOLDOUT_LOCK.md`)

The 8 sealed holdout slates are:
1. 4-6-26
2. 4-14-26
3. 4-15-26
4. 4-19-26
5. 4-20-26
6. 5-1-26
7. 5-2-26
8. 5-2-26-night

## Filesystem scan

Inspected `C:/Users/colin/dfs opto/` for files matching `<DATE>-26{projections,actuals,sspool}.csv` patterns, comparing against the 24-slate harness list in `src/scripts/theory-of-dfs-v2-validation.ts`.

Candidate new slates (date-keyed files not already in the 24-slate harness):

| Candidate | projections | actuals | sspool (lineup pool format?) | Status |
|---|---|---|---|---|
| 4-11-26 | yes | yes | **NO** — 4-11-26sspool.csv has projection columns, not the lineup pool `P,P,C,1B,2B,3B,SS,OF,OF,OF,...` header | EXCLUDED (pool file is malformed; cannot run V1-NoCorr) |
| 5-3-26-late | yes (`5-3-26projectionslate.csv`) | yes (`5-3-26actualslate.csv`) | yes | **INCLUDED** |
| 5-4-26 | yes | yes | yes | **INCLUDED** |
| 5-4-26-late | yes | yes | yes | **INCLUDED** |
| 5-5-26 | yes | yes | yes | **INCLUDED** |
| 5-5-26-late | no projectionslate file present | n/a | sspoollate present | EXCLUDED (no projections) |
| 5-5-26-night | no projectionsnight file present | actualsnight present | sspoolnight present | EXCLUDED (no projections) |

## The 4 new slates being processed

1. **5-3-26-late** (8 teams, 4 games)
2. **5-4-26** (16 teams, 8 games)
3. **5-4-26-late** (6 teams, 3 games)
4. **5-5-26** (20 teams, 10 games)

## Holdout check result

**CLEAN — no holdout breach.**

None of the 4 new slates appear in the holdout list:
- `5-3-26-late` (note: the holdout has `5-2-26-night`, not `5-3-26-late`; distinct slate by date and time-window)
- `5-4-26` — not in holdout
- `5-4-26-late` — not in holdout
- `5-5-26` — not in holdout

The holdout slates remain sealed. Proceeding with Stages 2-7.

## Note on slate count

The spec describes "4 new slates," and we are processing exactly 4. A 5th candidate (4-11-26) was excluded because its sspool.csv is in projections format (header begins with `DFS ID,Name,Pos,...`) rather than the lineup pool format used by all 24 baseline slates (header begins with `P,P,C,1B,2B,3B,SS,OF,OF,OF,...`). Without a valid lineup pool, V1-NoCorr cannot be run on 4-11-26 (the framework requires a SaberSim pool to score and select from).
