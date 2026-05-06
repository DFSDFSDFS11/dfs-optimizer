# SYNTHESIS — Lineup-Level Optimization Loop Summary

**Status: STOPPED.** 5+ consecutive non-shippable iterations triggered the stop condition. The chalk-lean mechanism direction is abandoned because all magnitudes (0.03, 0.04, 0.05) produce the same t1× = 0.96 fail.

## What was tried (8 iterations across V2a/b/c and V3/V3b/V3c)

| Variant | Mechanism | Mahal | t1× | t01× | Verdict |
|---|---|---|---|---|---|
| V1 (baseline) | Theory-DFS as-is | 2.29 | 1.04 | 1.11 | — |
| V2a | Type-aware combo penalty scaling only | 2.26 | 1.15 | 0.74 | rejected (t01 fails) |
| V2b | Top-5 hard filter only | 2.89 | 0.93 | 0.00 | rejected hard |
| V2c | Top-1 filter + type scaling | 2.34 | 1.07 | 0.74 | rejected |
| V3  (W=0.05) | Stack chalk-lean bonus | **2.19** | 0.96 | **1.11** | rejected (t1 fails) |
| V3b (W=0.03) | Smaller stack chalk-lean | 2.25 | **0.96** | 1.11 | rejected |
| V3c (W=0.04) | Middle stack chalk-lean | 2.22 | **0.96** | 1.11 | rejected |

## The decisive finding: t1× = 0.96 is a step function

V3, V3b, V3c **all produce identical t1× = 0.96** regardless of bonus magnitude (0.03, 0.04, 0.05). Mahalanobis improvement IS gradient with magnitude (V3b −0.04, V3c −0.07, V3 −0.10), but the t1× drop is binary — **any non-zero stack-chalk bonus loses the same 2 specific top-1% hits**.

The same 2 lineups drop out across all three bonus magnitudes. They're V1-selected leverage-pair stacks that the bonus deterministically reorders below chalk-pair alternatives. The chalk-pair alternatives don't hit top-1% as often (because the field also picks them, so they don't differentiate). **The mechanism has an inherent t1×-vs-Mahal trade-off that can't be tuned away.**

## What we learned about V1

Across 9 iterations of lineup-level investigation, V1 turned out to be **structurally closer to pros than initially understood**:

1. **I1**: V1 mean lineup distance to pros = 0.550 (better than Hermes-A's 0.642). V1's p10 = 0.036 — its closest 10% of lineups are essentially identical to pros.
2. **I2**: V1 cluster occupancy MATCHES pros (gaps all <4pp; Hermes +7.3pp gap on cheap-stud cluster).
3. **I3**: V1 over-pairs cross-team unrelated players, under-pairs same-team star pairs.
4. **I4**: V1's within-portfolio stack consistency MATCHES pros (mode_jaccard 0.459 vs 0.466). V1 IS consistent within stacks but uses a DIFFERENT core (leverage-pair vs chalk-pair).
5. **I5**: Pros are only 1.2pp chalkier than V1 in stack core. Modest gap.
6. **I7-I9**: All chalk-lean variants improve Mahal but cost t1× hits.

V1 is genuinely close to pros structurally. Closing the remaining 1.2pp ownership gap requires sacrificing top-1% hits in a deterministic, non-tunable way.

## What this means

**The lineup-level investigation has exhausted the high-signal mechanisms.** Three more iterations of variants on the same chalk-lean theme would just confirm the same step-function result.

The remaining gap between V1 and pros at the lineup level is structurally small (1.2pp ownership in stack core, ~0.10 Mahalanobis). The mechanisms that close that gap have a real cost in cash-band hits. The trade-off doesn't tune away.

**Two honest interpretations:**

1. **V1 is already at a local optimum.** Within the variance-band + EV-weighted framework, V1 is approximately as pro-like as the framework allows without sacrificing other structural metrics. Further improvement would require a different framework.

2. **The remaining gap is sample-noise, not signal.** With 18 slates and 14,100 pro lineup observations, a 1.2pp ownership gap might not be a true pro-pattern but slate-specific variance. The mechanisms aim at noise, hence don't translate.

Either interpretation says: stop trying to lineup-level-optimize V1 further. Either ship it or replace it.

## Recommendation

**Ship Theory-DFS V1 as the framework-grounded production system.** It's:
- Closest to pros in cluster occupancy of any tested system
- Has same within-portfolio consistency as pros
- Produces inverse-bell finishing distribution
- Beats Hermes-A on lineup-level pro-distance (0.550 vs 0.642)

The lineup-level investigation has produced strong empirical EVIDENCE that V1 is already pro-aligned. The remaining gap is small and the mechanisms to close it have real costs.

For the production-quality bar:
- Ship V1 (Theory-DFS-MLB) as MLB production
- Track live results over 30+ slates to determine whether V1's structural advantage translates to ROI
- Don't iterate further on calibration data — this is what diminishing returns looks like

## What was NOT explored (deferred)

- I6 (salary distribution) — skipped because V3 mechanism was clear from I3-I5
- Pitcher-pairing patterns specifically — pros may have specific pitcher-with-stack heuristics V1 doesn't capture
- Bring-back pattern variations (3-2 vs 4-1 splits) — partially covered by combo analysis but not at lineup level

These could be productive in a later investigation IF V1 live performance suggests specific failure modes. Don't speculatively explore now.

## Counter-evidence considered

- **Could V3 be acceptable as ship despite t1 drop?** No. The strict criteria are designed to prevent shipping degraded variants. t1 drop of 0.04 is sample-borderline but consistent across magnitudes — that's deterministic, not noise.
- **Could a different mechanism close the gap without t1 cost?** Possible but speculative. After 7 mechanism variants, the natural directions have been tested.
- **Could we re-derive cores from pro lineup data directly (not chalk-top-2 proxy)?** That would be data-fitting on the calibration set. No.

## Files (final state of lineup_level/)

- I1_findings.md (lineup pairing distance)
- I2_findings.md (pro lineup clusters)
- I3_findings.md (conditional player co-occurrence)
- I4_findings.md (within-portfolio variance)
- I5_findings.md (stack composition deep-dive)
- V3_proposal.md (mechanism spec)
- I7_I8_findings.md (V3 test result)
- SYNTHESIS.md (this file)
- Code: src/scripts/theory-of-dfs-v2-validation.ts (V1, V2a/b/c, V3, V3b, V3c all implemented)

## Loop terminated. No further wake-up scheduled.
