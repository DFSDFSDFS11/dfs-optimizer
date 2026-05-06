# Slate-Conditional Construction Adaptation — Methodology Lock

**Locked:** 2026-05-03 (pre-computation)
**Scope:** Descriptive measurement only — Chapter 8 framing. NO deployment recommendations, NO player/team-specific findings, NO system-building.
**Question:** Do V1 and pros adapt their lineup CONSTRUCTION to slate archetypes? If so, who adapts more, on which dimensions, and where do the V1-vs-pro gaps concentrate?

---

## Data

- Lineup dump: `C:/Users/colin/dfs opto/theory_dfs_v2/v1_pros_lineup_dump.json` (24 slates × 150 V1 lineups + ~5–8 pros × 150 lineups each)
- Per-slate raw projections: `C:/Users/colin/dfs opto/<slate>projections.csv`
- Pros: zroth, zroth2, nerdytenor, shipmymoney, shaidyadvice, needlunchmoney, bgreseth, youdacao, b_heals152
- Slates: 24, dates 4-6-26 → 5-3-26 (some with `-early` / `-main` / `-night` sub-slate variants)

---

## Stage 2 — Slate features (6, computed from per-slate projections.csv)

Active player = projections row where `Status` is `Confirmed` (or non-empty/non-OUT) AND `dk_50_percentile > 0`. Pitchers and hitters both included unless explicitly noted.

1. **Slate variance index**
   `mean_over_active_players( (dk_85_percentile − dk_25_percentile) / dk_50_percentile )`
   Higher → more uncertainty per player.

2. **Scoring environment**
   Sum of `Saber Total` over all unique teams active on slate (one value per team, taken from any active row of that team). If `Saber Total` missing for some teams, fall back to mean of `dk_50_percentile` × team-size (9) for that team only. Reported value is total expected runs across slate.

3. **Anchor concentration**
   `max(My Own) / second_max(My Own)` over active players. Higher → one dominant chalk anchor.

4. **Player pool size**
   Count of active players (post-filter).

5. **Projection inequality (Gini)**
   Gini coefficient of `dk_50_percentile` over active players. Higher → projection mass concentrated in few players.

6. **Salary efficiency**
   Pearson correlation between `Salary` and `dk_50_percentile` over active players. Higher → salary tracks projection more cleanly.

Saved to: `slate_features.csv` with columns `slate, variance_idx, scoring_env, anchor_conc, pool_size, gini, salary_eff`.

---

## Stage 3 — Clustering

- **Inputs:** 6 features above, z-score normalized (mean 0 / std 1) across the 24 slates.
- **Algorithm:** Agglomerative hierarchical, **Ward linkage**, **Euclidean distance**. (Pre-specified, not iterated.)
- **Cuts:** k=3, k=4, k=5. **Primary = k=4.** k=3 and k=5 reported as sensitivity.
- **Labels:** Heuristic, derived from cluster centroid sign pattern across the 6 z-scored features (e.g., "high-variance large-pool", "chalk-heavy small-pool"). NOT hand-tuned.

Saved to: `archetype_assignments.csv` with columns `slate, k3_cluster, k4_cluster, k5_cluster`.

---

## Stage 4 — Construction metrics (per entity, per archetype)

Entities: `V1`, each pro individually, `pro_avg` (mean across pros). All metrics computed at slate level then averaged across slates within an archetype, weighted equally per slate.

Per lineup, the dump provides: `primarySize`, `secondarySize`, `bringBack`, `salaryStd`, `salaryTotal`, `ownAvg`, `pids`. Bands not directly in dump — derived as follows:

- **Stack-size distribution.** A lineup's `primarySize` and `secondarySize` define stack shape:
  - 5-stack: `primarySize == 5`
  - 4-stack: `primarySize == 4`
  - 3-3 stack: `primarySize == 3 AND secondarySize == 3`
  - no-stack / other: anything else (e.g., 2-2, 4-2, 5-3 collapsed to 5-stack since `primary==5` already, etc.)
  Reported as % of entity's lineups in each bucket per archetype.

- **Bring-back rate.** Fraction of entity's lineups with `bringBack >= 1`.

- **Band distribution (HP/HO, HP/LO, LP/HO, LP/LO).** Lineup classification by **median split per slate** of (a) projection vs slate-V1+pros median projection and (b) `ownAvg` vs slate-V1+pros median `ownAvg`. HP = above-median projection; HO = above-median ownership. Splits are entity-agnostic (computed from pooled V1+pros lineups for that slate). Reported as % of entity's lineups in each band per archetype.

- **Within-portfolio mean pairwise Jaccard.** For each entity in each slate: compute pairwise Jaccard similarity of `pids` sets across all 150 lineup pairs (or all pairs if <150), take the mean. Then average across slates within archetype. Higher → entity's portfolio is more concentrated/redundant.

- **Salary distribution shape.** Mean of `salaryTotal` and mean of `salaryStd` across entity's lineups in archetype.

- **Ownership distribution shape.** Mean and std of `ownAvg` across entity's lineups in archetype.

Saved to: `per_archetype_construction_metrics.csv`.

---

## Stage 5 — Adaptation amplitude

For each entity and each metric:

  `amplitude(entity, metric) = std_over_archetypes( metric_value(entity, archetype) )`

using k=4 archetype assignments. Compare V1's amplitude to `pro_avg`'s amplitude per metric.

Saved to: `adaptation_amplitude_comparison.csv`.

---

## Stage 6 — Per-archetype gap & V1 outcomes

- Per archetype, per metric: `gap = V1_value − pro_avg_value`. Identify archetypes with largest absolute gap aggregated across metrics (z-score the per-metric gaps using the across-archetype std of the metric, then average absolute z's per archetype).
- V1 outcomes per archetype: top-1% rate, top-0.1% rate (from `finishPct < 0.01` and `< 0.001`), mean `finishPct`. ROI not computable without per-slate contest payout data — flagged as N/A unless a payout structure can be derived from `totalEntries`.
- **Bootstrap 95% CIs:** 2,000 resamples of slates within archetype with replacement; CI on entity-level top-1% rate.

Saved to: `per_archetype_outcomes.csv`.

---

## Stage 7 — FINDINGS verdict

One of:

- **Strong adaptation gap** — pros adapt substantially across archetypes, V1 doesn't. V1's gaps concentrated in specific archetypes. Slate-conditional logic identified as productive direction.
- **Moderate adaptation gap** — pros adapt somewhat more. Worth considering for future research.
- **No adaptation gap** — V1 ≈ pros adaptation. Not the answer.
- **Inverted** — V1 adapts MORE than pros. Surprising; might be over-doing what should be stable.

---

## Methodology integrity confirmations

1. Clustering algorithm (Ward / Euclidean / k=4 primary) **pre-specified before computation**.
2. Sensitivity test at k=3 and k=5 reported regardless of outcome.
3. n=24 slates, ~6 per cluster — wide CIs expected and reported honestly.
4. No iteration on cluster algorithm.
5. No player/team-level findings; construction-level only.
6. No deployment recommendations.
