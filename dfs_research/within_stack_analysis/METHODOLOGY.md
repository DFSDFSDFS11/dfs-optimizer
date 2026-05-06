# Within-Stack Hitter-Set Analysis — Methodology Lock

**Lock timestamp:** 2026-05-03 (locked before any computation)
**Purpose:** Test whether the V1-vs-pros concentration gap (76x more strongly-positively-correlated lineup pairs in pros vs V1; identical at team-selection level) lives at the within-primary-stack hitter-set level.

This is **descriptive measurement research**. No system is built, no parameters fit, no deployment candidates produced.

---

## 1. Definitions

### 1.1 Primary stack hitter set
For a given lineup L:
- Let `pt = L.primaryTeam` and `ps = L.primarySize`.
- Let `H(L) = {pid : pid in L.pids, team(pid) == pt, pid NOT in L.pitcherIds}`.
- The "primary stack hitter set" is the unordered tuple `sorted(H(L))`.
- We require `|H(L)| == ps`. (Sanity: lineups failing this are flagged but in practice match.)

For 4-stacks: `ps == 4`, set is a 4-combination of that team's active hitters.
For 5-stacks: `ps == 5`, set is a 5-combination.

We analyze 4-stacks and 5-stacks separately because their combinatorics differ
(`C(8,4)=70` vs `C(8,5)=56`) and pros have heterogeneous stack-size mixes.

### 1.2 Entity
One of: `V1`, or one pro username from {zroth, zroth2, nerdytenor, shipmymoney, shaidyadvice, needlunchmoney, bgreseth, youdacao, b_heals152}.
(Note: `zroth` does not appear in the dump — only `zroth2`. We use whatever pro usernames are actually present in each slate's `pros` array.)

For V1: all 150 V1 lineups per slate.
For each pro: the 150 lineups of that user in that slate.

### 1.3 (Entity, slate, team, stackSize) cell
A unit of analysis = the lineups produced by one entity on one slate that primary-stack `team` at size `stackSize` (4 or 5).

---

## 2. Sample-size filter

**Rule:** Only include (entity, slate, team, stackSize) cells with **>= 5 lineups** for concentration measurement.

Rationale: with 1-4 lineups, "unique sets" and "top-1 share" are mechanically constrained and uninformative. 5 is the documented threshold from the spec.

Cells with <5 lineups are excluded from concentration metrics. We report (a) how many cells pass the filter per entity, (b) total lineups covered.

---

## 3. Concentration metrics (per cell)

For each cell (entity, slate, team, stackSize), with N lineups and hitter-set frequency distribution `c_1 >= c_2 >= ... >= c_K`:

- `lineups_n = N`
- `unique_sets = K`
- `top1_set_share = c_1 / N`
- `top3_set_share = (c_1 + c_2 + c_3) / N` (using only as many as exist)
- `entropy = - sum_i (c_i/N) * ln(c_i/N)` (natural log; 0 = full concentration; ln(K_max) = uniform)

---

## 4. Aggregation across cells

For each entity, aggregate by **simple mean** across cells (each cell is one observation).

We separately aggregate 4-stack cells and 5-stack cells because of their differing combinatorial baselines.

We also report:
- Number of qualifying cells per entity
- Total lineups per entity covered by qualifying cells
- Stack-size mix (% of lineups that are 4-stacks vs 5-stacks vs other; computed over ALL lineups, not just qualifying cells)

A "Pro avg" row = simple mean across the per-pro entity rows (each pro is one observation); this prevents heavy-volume pros from dominating.

---

## 5. Stage 5 — Hitter-set selection patterns (only if hypothesis supported)

If pros are observed to use systematically fewer unique sets, we examine **which** set each pro most-frequently picks per (slate, team, stackSize) cell.

For each cell's top-1 set, classify whether it matches:
- **Top-N by SS Proj**: are these the top-`stackSize` players (from the stack team's 8 active hitters) ranked by `SS Proj` (per-slate projection csv)?
- **Top-N by anti-ownership**: lowest `Adj Own` `stackSize` players?
- **Top-N by SS Proj * (1/AdjOwn)** (leverage proxy): top-`stackSize` by `SS Proj / max(AdjOwn,1)`?
- **Contiguous batting order**: do the picks come from a contiguous slot range (1-4, 2-5, 3-6, etc.)?
- **Other**: none of the above.

Tabulate the proportion of (entity, cell) top-1 sets matching each pattern. Categories may overlap (e.g., top-projection often includes top-batting-order); report each independently.

If the hypothesis is **not** supported (V1 ~= pros at the hitter-set level), Stage 5 is skipped and we document.

---

## 6. Stage 6 — Outcome correlation

For each cell, compute the **actual fantasy points** scored by that cell's most-frequently-used hitter set on that slate:
- Sum the `Actual` (DK fantasy points) values for the players in the set, from the slate's `actuals.csv`.

Compare:
- V1's most-used sets across all qualifying cells: mean actual
- Each pro's most-used sets: mean actual
- Random baseline: for each cell, draw 10,000 random `stackSize`-subsets from the team's 8 active hitters; score each; average.

**Bootstrap CIs:** 95% CIs via 10,000-resample bootstrap over cells (resample cells with replacement, recompute mean).

Note: SaberSim projections drive V1, but pros may use different projection sources. Outcome scoring uses the realized actuals, so the comparison is sport-neutral to projection source.

---

## 7. Stack-team identity

Team strings come straight from the lineup `teams` array. We use these as opaque tokens (e.g., `LAD`, `CWS`). The 8-active-hitter universe per team comes from each slate's projections csv (filtered to position != `P` and `Status == Confirmed`).

---

## 8. Outputs

- `within_stack_analysis/METHODOLOGY.md` (this file; Stage 1)
- `within_stack_analysis/per_team_per_slate_comparisons.json` (Stage 2)
- `within_stack_analysis/distribution_comparison.csv` (Stages 3-4)
- `within_stack_analysis/hitter_set_patterns.md` (Stage 5; conditional)
- `within_stack_analysis/outcome_correlation.csv` (Stage 6)
- `within_stack_analysis/FINDINGS.md` (Stage 7)

---

## 9. Methodology constraints (binding)

1. Descriptive only. No system. No parameter fits.
2. Sample-size filter applied uniformly (>= 5 lineups per cell).
3. Bootstrap CIs reported on outcome stats (24 slates is small).
4. One pass; no iteration on findings.
5. Documented limitations:
   - 24 slates is small; per-(entity, team) cells often have small N.
   - SaberSim projection source may differ from each pro's source.
   - Pros and V1 may differ in how they label `primaryTeam` / `primarySize` (we trust the dump's labeling).
   - Pro user `zroth` (no "2") is documented in the spec but not present in the dump; we use only users actually in the data.
6. No system designs in FINDINGS — only research-direction notes.
