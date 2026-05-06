# METHODOLOGY — One-off Hitter Slot Concentration Analysis

**Locked: 2026-05-03**
**Analysis sequence position: 5 of 5 (descriptive only).**
**Hypothesis tested:** the residual ~76× pairwise lineup correlation gap between V1 and pros, after accounting for stack-team selection (~1×), within-stack hitter sets (~17×), and cross-cell coupling (~1×), is driven by concentrated one-off hitter slot selection.

---

## 1. Definitions

### 1.1 Lineup composition (DK MLB Classic, 10 slots)
Each lineup contains:
- 2 pitchers (P)
- 8 hitters (C, 1B, 2B, 3B, SS, OF, OF, OF)

### 1.2 Slot categories
For each lineup we partition hitters (the 8 non-pitcher slots) into three disjoint categories:

1. **Primary stack hitters** — hitters whose `team == primaryTeam` AND a count equal to `primarySize` (the canonical stack size 4 or 5). If more hitters from `primaryTeam` exist than `primarySize` (rare; can occur with overlapping mini-stacks), we take all of them as "primary stack hitters" since they belong to the same correlation block.

2. **Bring-back hitters** — hitters whose `team == bringBackTeam`, where `bringBackTeam` is the opponent of `primaryTeam` (derived from the slate-level game pairs). Defined ONLY when the lineup's `bringBack` flag == 1; otherwise no bring-back exists. If multiple opponents share the team field with primary's opponent, all such hitters count as bring-back.

3. **One-off hitters** — every remaining hitter (not in primary stack, not in bring-back, not a pitcher).

### 1.3 Pitchers
`pitcherIds` already provides the pitcher pair. Pitcher slot is identified by the sorted set of pitcher player IDs.

### 1.4 One-off slot count
Per lineup: `8 - primarySize - bringBackHitterCount`.
Typical range: 1–4 one-off hitters per lineup.

### 1.5 One-off set identifier
For each lineup, the **one-off set** = sorted tuple of player IDs of all one-off hitters. We use IDs (not names) for set comparison to avoid name-collision issues.

---

## 2. Slate-level game pair derivation

For each slate, build a map `team -> opponent` by collecting every `(pitcherTeam, pitcherOpp)` pair across ALL lineups (V1 + pros) in the slate. Each MLB game produces both directions, so the resulting map covers every team. This is used to find `bringBackTeam = opponent_of(primaryTeam)`.

---

## 3. Structured-context grouping

Within each entity (V1 or a single pro) and each slate, group lineups by the tuple:

`(primary_stack_team, bring_back_team_or_NONE, sorted_pitcher_id_set)`

This is the **structured context** for measuring residual one-off concentration. Within a fixed structured context, two lineups differ only in their one-off hitter set (and bench composition / position assignment, but those are downstream). High concentration of one-off sets within fixed structured context = pros coordinating one-off picks beyond what the stack/BB/pitcher dimensions explain.

---

## 4. Sample-size filter

A **qualifying group** is one with **≥5 lineups**. Groups with fewer lineups are excluded from concentration aggregation (insufficient sample for stable share / entropy estimate).

Per-entity, per-slate qualifying groups are reported. Entities with very few qualifying groups (a known limitation, e.g., V1 spreading thinly) are flagged but not dropped.

---

## 5. Concentration metrics (per qualifying group)

Let G be a qualifying group with N lineups (N ≥ 5) producing a multiset of one-off sets {s_1, …, s_N}.

- **unique_one_offs** = |distinct one-off sets in G|
- **top1_share** = max_s count(s) / N
- **top3_share** = sum of three largest counts / N
- **entropy** = Shannon entropy in nats: −Σ p_s · ln(p_s), where p_s = count(s)/N

We also track the structured-context tuple itself for downstream interpretation.

---

## 6. Per-entity aggregation (Stage 4)

For each entity, average each metric across its qualifying groups (unweighted mean across groups, since each group represents one structured context).

Pro-average = unweighted mean across the 8 pros.

---

## 7. Bootstrap procedure

10,000 resamples, RNG seed = 42. Resampling unit = qualifying group (group-level bootstrap) — for each entity we resample its qualifying groups with replacement and recompute the aggregated mean. Report 95% CI as the [2.5%, 97.5%] percentiles of the resampled means.

For pro-average: resample at the (pro × group) level — i.e., flatten all pro qualifying groups, resample with replacement, recompute the unweighted mean of group metrics. (This treats each pro group as a unit, weighted by group count.)

---

## 8. Mathematical reconciliation (Stage 5)

Two methods, BOTH reported:

### Method A — multiplicative dominance approximation
```
predicted_ratio_A = (within_stack_top1_share_pro / within_stack_top1_share_v1)^2
                  × (one_off_top1_share_pro / one_off_top1_share_v1)^2
```
The (·)² factor reflects the pairwise probability that two random lineups share the same dominant pick (P(both pick top item) ≈ p²). within_stack values come from analysis 3; one_off values from this analysis (Stage 4).

This is an upper-bound style sketch — assumes independence between the within-stack and one-off concentration factors and dominance by the top item.

### Method B — Herfindahl-based, full distribution
For each entity, build the joint distribution over the full 4-tuple
`(stack_set, bring_back_set, pitcher_set, one_off_set)`
counting frequency over its complete lineup pool (all slates pooled, normalized per-slate).

`P_identical = Σ_combos p(combo)^2` (Herfindahl index of the joint distribution).

Compute per-slate, then average:
```
predicted_ratio_B = mean_slate( P_identical_pro / P_identical_v1 )
```
(For "pro" we use the pooled pro distribution within each slate.)

Both predictions are compared against the observed 76× from analysis 1 (full-lineup Jaccard).

---

## 9. Hypothesis verdict bands (Stage 7A)

- **Strongly supported**: pro_one_off_top1_share / V1_one_off_top1_share ≥ 1.5 AND predicted ratio (better of Method A/B) within 2–3× of 76×.
- **Moderately supported**: ratio ≥ 1.25 AND prediction explains 40–70% of 76× on log scale (i.e., predicted ratio between ~6× and ~30×).
- **Weakly supported**: marginal differences, inconsistent across pros.
- **Not supported**: V1 ≈ pros (ratio within ±15%).
- **Inverted**: V1 > pros.

---

## 10. Constraints

1. **Descriptive only.** No system built. No parameters fit.
2. ≥5 lineup filter per qualifying group.
3. Bootstrap 10K, seed=42, group-level resample.
4. Both Method A and Method B reported for math reconciliation.
5. One pass — no iteration to amplify findings.
6. Limitations to disclose:
   - 24 slates total (small sample for stable per-pro estimates)
   - Per-pro qualifying-group counts vary
   - One-off slot count varies per lineup (1–4); concentration on a 1-slot one-off is mechanically higher than on a 4-slot one-off, so the metric should be interpreted alongside the slot-count distribution
   - V1 may have very few qualifying groups due to lineup spreading
   - Pro identity confounding: 8 pros with 9 names listed (some pros may not appear); use the actual `user` field
7. No system designs. Only research-direction implications.

---

## 11. Pro list (from `user` field)
`zroth, zroth2, nerdytenor, shipmymoney, shaidyadvice, needlunchmoney, bgreseth, youdacao, b_heals152` — 9 candidate names. Whoever appears in `user` field counts. Aggregation uses observed users.

---

## 12. Output artifacts
- `METHODOLOGY.md` — this file (locked first)
- `per_group_metrics.json` — Stage 3 output
- `per_entity_concentration_metrics.csv` — Stage 4 output (with bootstrap CIs)
- `mathematical_reconciliation.md` — Stage 5 output
- `selection_patterns.md` — Stage 6 (only if hypothesis supported)
- `per_pro_variation.csv` — Stage 7
- `FINDINGS.md` — Stage 7 verdict

**LOCK ACKNOWLEDGED — no methodology changes after this point.**
