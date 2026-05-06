# Lineup-Level Optimization — Iterative Progress Log

Goal: continuously discover lineup-level features that distinguish pro lineups from
system lineups, and translate findings into validated system improvements. Following
Ch.8's "exposures don't matter, lineups do" — every analysis operates at the
individual lineup granularity, not aggregate exposure.

## Working principles

1. **Lineup level only.** Per-lineup features, per-lineup distance, per-lineup matching.
   No "average exposure" thinking — that's been done and is a consequence, not a cause.
2. **Compare to V1 baseline, not V2.** V2 was a degraded baseline; comparing against
   it would mislead. Hold to V1's structural metrics: Mahal=2.29, t1×=1.04, t01×=1.11,
   inverse-bell shape.
3. **Structural criteria for ship**: Mahalanobis must DECREASE, t1× and t01× must
   maintain (within 0.05), finishing distribution stays inverse-bell.
4. **Don't trust ROI on calibration data.** 18 slates is too small. Sample noise
   dominates. Pull all conclusions from structural metrics.
5. **Stop and synthesize after 5 consecutive non-shippable iterations.**

## V1 baseline (per structural-validation 18 slates)

- Mahalanobis to pros (mean): 2.29
- Top-1% × random: 1.04×
- Top-0.1% × random: 1.11×
- Finishing distribution: inverse-bell (top=9.1%, mid=19.7%, bot=12.7%)

## Iteration Queue

Pick the next pending task. After completing, mark done and update findings.

| # | Task | Status | Iteration file |
|---|---|---|---|
| I1 | **Lineup-level pairing distance.** For each Theory-DFS-V1 lineup, find nearest pro lineup in feature space (proj/own/range/stack-size). Compute mean nearest-distance. Same for Hermes-A. Hypothesis: V1 lineups individually farther from any pro than Hermes-A's are. | **DONE** | I1_findings.md |
| I2 | **Pro lineup clusters.** K-means on pro lineup features. Are pros in 2-3 clusters or spread? Do V1 lineups occupy the same clusters? Cluster occupancy gap as a metric. | **DONE** | I2_findings.md |
| I3 | **Conditional player co-occurrence pro vs field.** For top 50 players, compute P(player_B in lineup | player_A in lineup) for pros and field. Where does it differ most? Are these specific player pairs that V1 misses? | **DONE** | I3_findings.md |
| I4 | **Within-pro lineup variance.** For each individual pro's portfolio, compute variance of lineup features. Is V1's within-portfolio variance similar? Pros known to have specific within-portfolio diversity. | **DONE** | I4_findings.md |
| I5 | **Pro stack composition deep-dive.** What specific 4-5 stack patterns recur across pros? Specific pitcher pairings (e.g., always-with-stud-SP, never-with-cheap-SP)? Specific bring-back patterns. V1 pattern overlap. | **DONE** | I5_findings.md |
| I6 | **Pro lineup salary distribution.** Are pros' lineups balanced ($5.0K avg) or stars-and-scrubs (high-low bimodal)? Per-position salary tier patterns. V1 distribution comparison. | **SKIPPED** (V3 mechanism clear from I3-I5) | — |
| I6 | **Pro lineup salary distribution.** Are pros' lineups balanced ($5.0K avg) or stars-and-scrubs (high-low bimodal)? Per-position salary tier patterns. V1 distribution comparison. | pending | I6_findings.md |
| I7 | **Synthesize candidate V3.** Based on findings I1-I6, propose ONE specific change to V1 that targets the largest-magnitude lineup-level gap. Document spec in V3_proposal.md. | **DONE** | V3_proposal.md |
| I8 | **Test V3 vs V1.** Run V3 portfolio builder on 18 slates. Compute structural criteria. Pass = ship. | **DONE (rejected — t1× shortfall)** | I7_I8_findings.md |
| I9 | **V3b/V3c sweep (W=0.03/0.04).** V3 mechanism direction tested at multiple magnitudes. | **DONE — all rejected** | I7_I8_findings.md + SYNTHESIS.md |
| I10 | **STOP condition triggered.** SYNTHESIS.md written. Loop terminated. | **STOPPED** | SYNTHESIS.md |

## Iterations Completed

- **I1 (2026-05-02)**: Lineup-level pairing distance. **Hypothesis INVERTED.** Hermes-A is the FARTHEST system from individual pro lineups (mean 0.642), even further than random pool sampling (0.492). V1 Theory-DFS is in the middle (0.550) but has the smallest p10 (0.036) — i.e., V1's closest 10% of lineups are essentially identical to pros. Implication: V1's selection finds pro-like lineups well; its 20/60/20 variance-band split then forces non-pro-like lineups (likely the low band) which drags the mean. V3 candidate: reduce low-band allocation. Test via cluster analysis in I2.
- **I2 (2026-05-02)**: Pro lineup clusters. K=3 found C0 cheap-stud (25%), C1 balanced/stars (56%), C2 contrarian (18%). **V1 best matches pro distribution** (gaps all <4pp, vs Hermes-A +7.3pp on C0 / Random +22pp on C2). Pros do mostly "naked stacks" (4-5 hitter stack with no bring-back). I1's "reduce low-band" hypothesis INVALIDATED — V1 only over-represents C2 by 2.1pp. **Better V3:** within-cluster centroid-pull (pick lineups closer to cluster centroid within each band) rather than reallocate bands. Caveat: own_pct percentile broken (pool geomean vs arith mean scale mismatch); fix in next iteration.
- **I3 (2026-05-02)**: Conditional player co-occurrence pro vs field vs V1. **The decisive lineup-level finding.** V1 systematically OVER-DIVERSIFIES within stacks: same-team star pairs (Ramírez+DeLauter, Correa+Paredes, Olson+Harris) have V1 conditional probability 0.00-0.20 vs pros' 0.50-0.70. When V1 picks a stack team, it cycles through different player combinations rather than concentrating on the consistent "stack core" pros use. Symmetrically, V1 over-pairs cross-team unrelated players (Ketel Marte + Bogaerts at 0.58 V1 vs 0.08 pros). 692/1801 pairs (38%) have pros pairing more than V1; only 355 (20%) reverse. **V3 mechanism: stack-core bonus.** For each stack team, identify top-2 players by combined own×proj as the "core" — give lineups containing the core pair an EV bonus, concentrating V1's stack picks around consistent cores like pros do.
- **I4 (2026-05-02)**: Within-portfolio variance. **Surprise — V1 ALREADY matches pros on within-stack consistency** (mode_team_jaccard V1=0.459 vs pros=0.466, unique_teams V1=14.1 vs pros=14.1). I3's finding REFINED, not invalidated: V1 IS consistent within its stack but uses a DIFFERENT core than pros. V1 picks LEVERAGE pair (low-own alternates within stack); pros pick CHALK pair (top-own stars). Hermes-A uniquely UNDER-consistent (mode_jaccard 0.389, the only system below pros). V3 mechanism still valid but operational reason is "shift V1's chosen core from leverage to chalk-pair," not "make V1 more consistent." I5 next to identify specific core-pair player identities pros use.
- **I5 (2026-05-02)**: Stack composition deep-dive on 136 (slate, team) cases. **Chalk-lean is real but moderate**: pros' stack core matches chalk-top-2 proxy 34% (V1 16%, +18pp gap). Mean stack-core ownership: pros 12.7%, V1 11.5% (V1 only 1.2pp less chalk). Sample misalignments show chalk proxy wrong 66% of cases. **V3 mechanism REFINED to softer "ownership-weighted nudge"**: small bonus to lineups whose primary-stack-hitter ownership is above slate median, magnitude ~0.05 (similar to BRINGBACK_1). I6 skipped (V3 mechanism clear). Ready for I7 synthesis + I8 test.
- **I7+I8 (2026-05-02)**: V3 implemented (W_STACK_CHALK=0.05 stack chalk-lean bonus) and tested on 18 slates. **Conditional pass** — Mahal improved decisively (V1 2.29 → V3 2.19, Δ−0.10), top-0.1× preserved exactly (1.11→1.11), but top-1× dipped 0.04 below threshold (V1 1.04 → V3 0.96). Rejected per strict criteria but **first variant to improve Mahal at all** across V2a/V2b/V2c/V3. Mechanism direction validated. **V3b iteration**: reduce W_STACK_CHALK to 0.03 (60% magnitude) to preserve t1× while keeping Mahal improvement. **NOT ship-committed yet** — counter resets with V3b in next iteration.
- **I9 (2026-05-02)**: V3b (W=0.03), V3c (W=0.04), V3 (W=0.05) tested in parallel. **All three produce identical t1× = 0.96.** Mahal improvement IS gradient with magnitude (V3b −0.04, V3c −0.07, V3 −0.10) but t1× drop is binary — any non-zero stack-chalk bonus loses the same 2 specific top-1% hits. The mechanism has an inherent t1×-vs-Mahal trade-off that can't be tuned away. **Stop condition triggered** (5+ consecutive non-shippable iterations). **SYNTHESIS.md written**: V1 is structurally close to pros; remaining 1.2pp gap requires deterministic top-1% sacrifice to close. Recommendation: ship V1 as production, track live results over 30+ slates, don't iterate further on calibration data.

## Stop Conditions

- 5 consecutive iterations fail to produce ship candidate
- Queue exhausted
- Major issue blocks progress (data corruption, infrastructure failure)
- Ship candidate committed and pushed (success exit)

## Data References

- **System lineups (per-slate per-lineup, with pids/proj/own)**: `theory_dfs_structural/all_systems_lineups.json`
- **Pro lineups (per-slate per-username, with combos)**: `combo_saturation_analysis/raw_combos.json`
- **Pro consensus stats**: `pro_consensus_slate_relative.json`
- **18 historical MLB slates**: projections, actuals, pools at `C:/Users/colin/dfs opto/`
- **Field saturation per (size, type)**: in raw_combos.json `fieldSatByType`
- **NBA equivalent data**: `theory_dfs_nba/`, `combo_saturation_analysis_nba/`
