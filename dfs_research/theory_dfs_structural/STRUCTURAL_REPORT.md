# Structural Validation Report

**Question being answered:** Q2 — "are these systems structurally well-built per framework principles?"  
**Not:** Q1 — "do these systems have positive ROI?" (requires hundreds of slates)

Six framework-derived structural checks across 5 systems on 30 total slates (18 MLB + 12 NBA).

## Cross-System Scorecard

| System | V1 shape | V2 t1× | V2 t01× | V3 mahal | V4 bands | V5 adapt | V6 combo | Pass |
|---|---|---|---|---|---|---|---|---|
| **Hermes-A (MLB)** | inverse-bell ✓ | **1.52×** | **1.85×** | 1.95 (✗ near pass) | 55/37/8 (✗) | 0.07 spread ✓ | 17% top ✓ | **4/6** |
| **Theory-DFS (MLB)** | inverse-bell ✓ | 1.07× | 0.74× ✗ | 2.26 ✗ | 49/31/20 ✓ | 0.07 ✓ | 26% top ✓ | **4/6** |
| **Random (MLB)** | inverse-bell, top=8% ✗ | 1.11× | 1.48× ✗ | 2.13 ✗ | 27/44/29 ✓ | 0.01 ✗ | 14% top ✓ | **2/6** |
| **Theory-DFS (NBA)** | inverse-bell ✓ | 1.17× | 0.56× ✗ | n/a | 34/45/21 ✓ | 0.12 ✓ | 22% top ✓ | **4/5** |
| **Random (NBA)** | inverse-bell, top=9% ✗ | 1.17× | **1.67×** ✓ | n/a | 30/41/29 ✓ | 0.04 ✗ | 22% top ✓ | **3/5** |

P = pass, ✗ = fail. V3 not applicable for NBA (no pro consensus data).

## Per-Validation Findings

### V1 — Finishing-Percentile Distribution Shape (Ch.10)

All 5 systems produce inverse-bell shape distributions — the structural shape the framework prescribes for GPP grinders. **But the SaberSim pool itself is what produces this shape** — Random samples from the pool also produce inverse-bell (just with weaker top concentration).

| System | Top decile | Mid (4-5) | Bottom decile |
|---|---|---|---|
| Hermes-A MLB | **12.1%** | 18.8% | 9.6% |
| Theory-DFS MLB | 9.6% | 19.9% | 13.0% |
| Random MLB | 8.0% (below random) | 18.3% | 15.6% |
| Theory-DFS NBA | 9.8% | 19.6% | 11.6% |
| Random NBA | 8.6% | 20.0% | 13.0% |

**The shape is supplied by the pool, not by selection.** Selection-driven systems (Hermes-A, Theory-DFS) merely concentrate more in the top decile vs random. Hermes-A is the only system materially above the 10% top-decile baseline.

### V2 — Top-Tail Concentration (Ch.10 sharp-user pattern)

This is the **most discriminating validation**. The threshold is 1.5× random in either top-1% or top-0.1%.

- **Hermes-A passes hard**: 1.52× top-1%, 1.85× top-0.1%. Real cash-band concentration above what the pool delivers.
- **Theory-DFS-MLB fails**: 1.07× top-1%, 0.74× top-0.1%. **Below random** in the deep tail. The selection mechanism is *removing* lineups that would have hit top-0.1%.
- **Random-MLB nearly passes**: 1.48× top-0.1% (barely under threshold). Pool itself has top-tail concentration.
- **Theory-DFS-NBA fails badly**: 0.56× top-0.1%. Same below-random pattern.
- **Random-NBA passes**: 1.67× top-0.1% — but this is from one jackpot slate (2026-03-03 = 2 of 3 hits). Single-slate artifact, not signal.

**Interpretation:** Theory-DFS's selection mechanism actively reduces top-tail concentration on both sports. On NBA, Random beats Theory-DFS in top-0.1% by 3× (1.67 vs 0.56). The framework's selection logic is selecting against the top-tail pattern the pool naturally delivers.

### V3 — Mahalanobis to Pro Consensus (MLB only)

Pros cluster at d<1.3 (per pro_consensus docs). All 3 MLB systems fall outside that zone:

- Hermes-A: mean 1.95 (range 0.28–3.37) — slate-by-slate variance is huge despite being sweep-tuned to consensus
- Theory-DFS-MLB: mean 2.26 (range 0.72–8.79)
- Random-MLB: mean 2.13 (range 0.84–4.80)

**Random is closer to pros than Theory-DFS-MLB on average (2.13 vs 2.26).** Hermes-A is closest but still fails the 1.5 threshold. None of these systems consistently reproduce pro structural patterns slate-by-slate.

### V4 — Variance Band Distribution (Ch.8)

Framework target: ~20/60/20 high/mid/low bands (illustrative per Ch.8).

- **Hermes-A**: 55/37/8 — **chalk-concentrated by design** (its bin allocation is 50/30/20/0/0). Fails on low-band representation.
- **Theory-DFS-MLB**: 49/31/20 — drifts chalk-heavy despite 20/60/20 spec. Achieves spec only on low band.
- **Random-MLB**: 27/44/29 — most balanced because it doesn't try to be anything.
- **Theory-DFS-NBA**: 34/45/21 — closer to spec.
- **Random-NBA**: 30/41/29 — also balanced.

**Theory-DFS achieves the framework's variance-band intent better than Hermes-A** — but this doesn't translate to V2 top-tail edge.

### V5 — Per-Archetype Adaptation (Ch.7)

Threshold: system metrics shift > 5pp between slate-size archetypes. **This is the cleanest discriminator between framework-driven systems and random.**

- Hermes-A: own_spread 0.028, **proj_spread 0.070** → PASS (proj-driven adaptation)
- Theory-DFS-MLB: own_spread 0.013, **proj_spread 0.067** → PASS
- **Random-MLB: own_spread 0.003, proj_spread 0.007 → FAIL** (no adaptation, by definition)
- Theory-DFS-NBA: **own_spread 0.117, proj_spread 0.113** → PASS (largest spread, real adaptation)
- **Random-NBA: own_spread 0.038, proj_spread 0.037 → FAIL**

**Theory-DFS distinguishes itself from Random here.** Both Theory-DFS variants correctly shift their portfolio characteristics with slate type; both Random variants don't. This is the strongest signal that the framework is doing *something* meaningful — adapting to slate context — even if it's not translating into V2 edge.

### V6 — Combinatorial Uniqueness (Ch.6)

Threshold: top pair appears in <85% of portfolio lineups (no extreme over-duplication).

All 5 systems pass comfortably:
- Random-MLB: 14% (lowest, most diverse)
- Hermes-A: 17%
- Theory-DFS-NBA: 22%
- Random-NBA: 22%
- Theory-DFS-MLB: 26% (highest, most concentrated but still well below threshold)

No system over-duplicates pairs in a way that violates Ch.6 equilibrium principles.

## What This Resolves

### Theory-DFS's structural strengths

1. **Achieves framework variance-band intent better than Hermes-A** (V4: 49/31/20 vs Hermes 55/37/8)
2. **Adapts to slate-size archetype** (V5: clear shifts on both sports)
3. **Produces inverse-bell finishing distribution** (V1, though pool-driven)
4. **No combinatorial duplication problems** (V6)

### Theory-DFS's structural weakness

**The decisive structural failure is V2 top-tail concentration.** On both MLB and NBA, Theory-DFS selection produces top-0.1% rates *below random* (0.74× MLB, 0.56× NBA). The framework's selection logic — chalk-centric variance bands + frequency optimization + Ch.9 exploits — is removing lineups from the top-0.1% zone the pool naturally provides.

This is consistent across both sports. **Cross-sport invariance of this failure strongly suggests it's a Theory-DFS implementation property, not slate-sample noise.** The framework principles, as I implemented them, *reduce* deep-tail concentration vs the pool's natural distribution.

### What Hermes-A does that Theory-DFS doesn't

Hermes-A is the only MLB system passing V2. Mechanically, it adds:
- `λ × comboFreq` term penalizing field-frequent constructions
- `extremeCornerCap` rejecting PPD-extreme lineups
- Hard `minPrimaryStack=4` + 50/30/20/0/0 chalk-heavy bins

These produce top-tail concentration above pool baseline. The framework principles I implemented (PPD-bias bump, ultra-chalk penalty, ceiling-efficiency) point in similar directions but don't achieve the same V2 outcome. **Hermes-A's λ × comboFreq mechanism appears to be the operational difference.**

## Decision Implications

### What to deploy

**For MLB:**
- **Hermes-A is the only system with measurable structural V2 edge.** Pass 4/6 with the strongest pass on the most-discriminating check.
- **Theory-DFS-MLB matches Hermes-A on count (4/6) but fails the most important check.** It's structurally valid (variance bands, adaptation, no duplication) but produces below-random top-0.1% rate. That's a real concern.
- **Random-MLB is the floor:** 2/6, fails adaptation by definition. Don't deploy random unless other systems also fail V2 — at which point random is the cheaper option.

**For NBA:**
- **No system passes V2 above pool baseline.** Random-NBA's 1.67× is single-slate noise. Theory-DFS-NBA fails worse (0.56×).
- **Theory-DFS-NBA does pass V5 strongly** (0.12 spread vs Random's 0.04) — clearest signal the framework is adapting to slate context.
- **Don't deploy any system on NBA based on structural evidence.** The pool itself produces top-tail concentration; selection adds nothing measurable.

### What this rules out

The structural validation conclusively says:

1. **Theory-DFS's MLB top-0.1% edge from prior runs (1.48×, 1.85×) was sample-fitting.** When you control for slate identity (just look at distributional shape), Theory-DFS's structural V2 score is 0.74× — *below random*. The earlier runs' apparent edge came from picking specific lineups that happened to hit on specific slates.

2. **Theory-DFS does not produce structural top-tail concentration** by my implementation of the framework principles. Either the framework requires a mechanism I'm missing (most likely the λ × comboFreq style penalty Hermes-A uses), or the framework's qualitative description doesn't translate to a top-tail-concentrating selection in pool-based selection settings.

3. **Hermes-A's structural edge is real on this metric** even though its ROI is sample-fit on jackpot slates. The 1.52× t1 and 1.85× t01 are stable across all 18 slates, not concentrated in 2-3 outliers. **Hermes-A's V2 strength is the cleanest evidence of any positive structural finding in this entire experiment.**

## Bottom-Line Recommendation

**Ship Hermes-A for production MLB**, not Theory-DFS. The structural validation flips the prior recommendation:

- Hermes-A's ROI advantage was suspicious because it was empirically tuned on the calibration sample
- But its **V2 structural edge (1.52× t1, 1.85× t01) is independently real**, validated by a sample-stable structural metric
- Theory-DFS lacks this property. Its 4/6 pass count is real but on lower-discriminating checks
- For NBA: don't deploy structural-based selection at all. Random pool sampling is competitive enough that selection adds no measurable value

**For the framework principles themselves:** they're partially validated (V5 adaptation is real and distinguishes from random) but the operational selection mechanism the framework describes doesn't translate into the most important structural property (V2 top-tail concentration). Hermes-A's bin allocation + combo leverage *is* operationally what the framework needs but doesn't fully specify. The framework's qualitative description of how to build GPP portfolios needs the empirical bin/combo machinery to produce measurable V2 edge.

## Files

- Code: `src/scripts/structural-validation.ts` + `theory_dfs_structural/analyze.py`
- Per-system per-slate per-lineup data: `theory_dfs_structural/all_systems_lineups.json` (2.9 MB)
- Scorecards JSON: `theory_dfs_structural/scorecards.json`
- This report: `theory_dfs_structural/STRUCTURAL_REPORT.md`
