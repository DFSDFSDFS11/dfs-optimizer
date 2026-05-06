# Within-Stack Concentration Test — Methodology Lock

**Locked at:** 2026-05-03
**Pre-registered.** No iteration. No sweep. Single variant.

## Empirical question

Within-stack hitter set analysis showed pros use 28% fewer unique 5-sets per stack team than V1 (the strongest mechanistic finding from 5 rounds of narrowing).

A counter-finding from per-pro variation analysis: among individual pros, concentration NEGATIVELY correlates with tournament outcomes (Spearman ρ = −0.476 between one-off concentration and top-1% rate). The most-concentrated pros performed worst.

**Question:** Does forcing V1 to concentrate within-stack 5-sets IMPROVE tournament outcomes, or DEGRADE them?

A clean controlled test: run the variant on the same 16 dev slates and compare to V1 baseline. Single variant, single decision.

## Variant specification

**V1-WSC** (V1 With-in-Stack Concentration).

V1-WSC is V1 (V1-NoCorr settings — current production V1) with the following addition:

For each candidate lineup in the slate's pool:
1. Identify the lineup's primary stack team (max same-team hitter count).
2. Determine that primary team's TOP-N hitters by projection from the slate's active hitter pool, where N = primarySize of that lineup (top-5 if 5-stack, top-4 if 4-stack).
3. The lineup PASSES the WSC filter iff it uses exactly that top-N set as its stack from the primary team.
4. Lineups that fail are dropped from the candidate pool BEFORE V1's normal scoring + variance-band selection runs.

V1's correlation adjustments, EV scoring, exposure caps, band selection, and team-stack caps run unchanged on the filtered pool.

**Concentration target is PRE-REGISTERED.** Top-N by projection (where N = primarySize). Not selected from alternatives.

Tie-breaking on projection: when multiple hitters have equal projection, lower player ID wins (deterministic). The "active hitter pool" for each team is defined as all non-pitcher players in the slate's player pool with team == primary team and projection > 0.

If applying the filter starves selection (filtered pool < 150 lineups available after band/exposure constraints), V1's existing fallback logic (relax MAX_PAIRWISE_OVERLAP) applies as in baseline V1.

If a slate has primary teams with FEWER than primarySize qualifying hitters at projection > 0 in the player pool (e.g., a team has only 4 hitters in the pool but primary stack of 5), those lineups CANNOT pass the WSC filter and will be excluded. This is expected behavior.

## Holdout integrity

The 16 development slates are:

4-8-26, 4-12-26, 4-17-26, 4-18-26, 4-21-26, 4-22-26, 4-23-26, 4-24-26, 4-25-26, 4-25-26-early, 4-26-26, 4-27-26, 4-28-26, 4-29-26, 5-2-26-main, 5-3-26

The 8 holdout slates (4-6-26, 4-14-26, 4-15-26, 4-19-26, 4-20-26, 5-1-26, 5-2-26, 5-2-26-night) are NOT touched in this test. Their data is not loaded, summarized, or referenced. Per `slate_derived_research/HOLDOUT_LOCK.md`.

## Construction metrics computed (Stage 4)

For both V1 baseline and V1-WSC on each of 16 dev slates:

1. **Within-stack 5-set diversity per stack team**: For each (slate, primary stack team) pair, count unique 5-hitter sets used across all 150 lineups that primary-stacked that team. Aggregate: portfolio-mean unique-5-set count per stack team. **V1-WSC should collapse to ~1.0** per stack team (verifying the filter worked).
2. **Stack-size distribution**: % primarySize=5+ / =4 / =3 / other.
3. **Bring-back rate**: % lineups with bringBack >= 1, % with >= 2.
4. **Band distribution**: HP/HO, HP/LO, LP/HO, LP/LO buckets using slate-level median projection and median geoMean ownership over (variant + pros) combined.
5. **Within-portfolio mean pairwise Jaccard**: average over all (i,j) pairs of |L_i ∩ L_j| / |L_i ∪ L_j| using player IDs. **V1-WSC should be HIGHER** (more shared players within stacks).
6. **Pairwise correlation distribution**: Jaccard − 0.10 × pitcher-vs-stack penalty (matching prior research method).

Output: `construction_comparison.csv` (one row per slate per variant).

## Tournament metrics computed (Stage 5)

For both V1 baseline and V1-WSC on each of 16 dev slates:

1. **Top-1% hit rate**: count of lineups with actual >= top1Threshold(slate). Lift vs random = (variant_top1_rate / 0.01).
2. **Top-0.1% hit rate**: same with 0.1% threshold.
3. **Mean finishing percentile**: average over all 150 lineups of (1 - (rank - 1) / (F - 1)).
4. **Inverse-bell ratio**: (top quintile + bot quintile) / (2 × middle quintile) using portfolio finishing-percentile bins.
5. **ROI**: (totalPayout − fees) / fees, using the standard payout table from V2 validation.

**Bootstrap CIs** (10K samples) on top-1× and top-0.1× lift. Resample is over the 16 slates (cluster bootstrap), summing hits and dividing by (16 × 150 × 0.01) for top-1×.

Output: `tournament_comparison.csv` (one row per slate per variant) plus a summary block in `FINDINGS.md`.

## Per-slate analysis (Stage 6)

For each slate, V1-WSC top-1% hits vs V1 top-1% hits. Tag as helped (WSC > V1), hurt (WSC < V1), or neutral (equal).

Output: `per_slate_analysis.csv`.

## Verdict categories (FINDINGS.md, ONE category)

- **Concentration improves**: V1-WSC top-1×/t01× higher than V1 across most slates; bootstrap CIs separate.
- **Concentration neutral**: Tournament rates statistically similar; CIs heavily overlap.
- **Concentration degrades**: V1-WSC tournament rates lower than V1; bootstrap CIs separate the wrong way (counter-finding confirmed).
- **Slate-conditional**: Helps on certain slate types, hurts on others; no aggregate signal but per-slate variance signals a conditional rule.

## Constraints

1. Single variant. No sweep over concentration depths.
2. Pre-registered concentration target. Top-N by projection (N = primarySize).
3. Holdout sealed. 16 dev slates only.
4. Don't iterate. Mixed results = mixed result.
5. Bootstrap CIs on tournament rates.
6. No deployment recommendations issued from this test.
