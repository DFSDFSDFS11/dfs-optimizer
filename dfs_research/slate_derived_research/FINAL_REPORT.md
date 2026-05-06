# FINAL REPORT — Slate-Derived Research Protocol

**Date:** 2026-05-03.
**Status:** NO CANDIDATE. Stage 6 not executed per pre-registered selection rule.
**Working directory:** `C:/Users/colin/dfs opto/slate_derived_research/`

---

## 1. Research question + protocol

**Question.** Do framework-derived mathematical formulations capture pro DFS lineup-construction behavior on the same slate, evaluated by 5 structural benchmarks (band distribution, stack distribution, bring-back rate, Mahalanobis-to-pros, fingerprint-to-pros)?

**Protocol.**
  - Pre-register 3 architecturally-distinct formulations with all magnitudes locked.
  - Hold out 8 of 24 slates at Stage 1 (random seed 42), do not touch until Stage 6.
  - Run formulations on 16 development slates only.
  - Apply Bonferroni-corrected (α/15 = 0.0033) thresholds in Stage 4.
  - Apply pre-committed selection rule in Stage 5.
  - Stage 6 (holdout single-shot) only if a formulation qualifies (≥4/5 dev benchmarks).
  - No iteration, no parameter tuning, no cross-formulation influence.

---

## 2. Holdout split (Stage 1)

Random seed 42, Python `random.sample` over 24-slate list.

**HOLDOUT (8 slates, sealed until Stage 6 — Stage 6 not executed):**
  - 4-6-26, 4-14-26, 4-15-26, 4-19-26, 4-20-26, 5-1-26, 5-2-26, 5-2-26-night

**DEVELOPMENT (16 slates):**
  - 4-8-26, 4-12-26, 4-17-26, 4-18-26, 4-21-26, 4-22-26, 4-23-26, 4-24-26, 4-25-26, 4-25-26-early, 4-26-26, 4-27-26, 4-28-26, 4-29-26, 5-2-26-main, 5-3-26

Lock document: `HOLDOUT_LOCK.md`.

---

## 3. Pre-registered specifications summary (Stage 2)

Three formulations operationalizing 6 framework principles (P1 frontier, P2 variance bands, P3 stack correlation, P4 combinatorial uniqueness, P5 pitcher discipline, P6 slate responsiveness) over 7 shared slate features (efficient frontier, elasticity ε, nuts cluster, slate variance σ, scoring environment S, chalk concentration H, player pool size).

  - **Formulation A:** Frontier sampling with variance-adaptive 3-mode Gaussian mixture along normalized frontier coordinate u ∈ [0,1]; modes at μ_chalk=0.85, μ_mid=0.50, μ_leverage=0.15; base weights (0.40, 0.30, 0.30) tilted by ε and H; σ scales with σ_slate.
  - **Formulation B:** Hierarchical anchor-then-spread; Stage 1 anchor team via softmax over (rank-proj − λ_team·rank-own); Stage 2 fill via projection − λ_player·ownership; bring-back probability p_bb scales with S_slate.
  - **Formulation C:** Game-stack foundation with explicit correlation premium = top-5+top-3 projection sum − γ·avg-ownership + δ·(game_total − 9); γ tilts with H_slate; τ_game adapts with σ_slate; default 4-2 split, optional 5-3 if S>11.

Implementation note (Stage 2.5 Amendment 1): Formulations B and C operate by *scoring* lineups in the SaberSim pool with the formulation's selection logic, then taking top-N=75. Stage 2.5 Amendment 2 corrected `gameTotal` units (run-units, not /24-scaled). No magnitudes were changed; only implementation interpretation. See `SPECIFICATION.md`, `SPECIFICATION_AMENDMENT.md`.

Pre-registered Stage 2D pass thresholds (development):
  - **B1 Bands:** each of 4 bands within 8.0pp of pros AND total deviation < 25pp.
  - **B2 Stack:** primary mean within 0.30 of 4.58 AND |%≥5 − 67.1%| < 12pp.
  - **B3 Bring-back:** within 7.0pp of pro 21.6%.
  - **B4 Mahalanobis:** ≤2.25 on ≥13/16 dev slates.
  - **B5 Fingerprint:** ≤1.10 on ≥13/16 dev slates.

Selection rule (Stage 2E): qualify with ≥4/5 benchmarks.

Assumption ledger: 30 numbered assumptions in `SPECIFICATION.md` §2F.

---

## 4. Development results (Stage 4)

### Aggregate benchmark table

| Formulation | B1 Bands | B2 Stack | B3 BringBack | B4 Mahal (med) | B5 FP (med) | # Passed |
|---|---|---|---|---|---|---|
| **A** | FAIL (max gap 13.5pp; total 34.5pp) | **PASS** (mean 4.78, ≥5: 77.7%) | **PASS** (24.8%) | FAIL (2.71; 0/16 ≤2.25) | FAIL (1.46; 6/16 ≤1.10) | **2/5** |
| **B** | FAIL (max gap 25.9pp; total 64.8pp) | FAIL (mean 4.12, ≥5: 12.0%) | FAIL (0.1%) | FAIL (2.67; 0/16 ≤2.25) | FAIL (1.63; 6/16 ≤1.10) | **0/5** |
| **C** | FAIL (max gap 26.4pp; total 80.4pp) | **PASS** (mean 4.56, ≥5: 56.4%) | **PASS** (18.2%) | FAIL (2.51; 1/16 ≤2.25) | FAIL (1.09; 8/16 ≤1.10) | **2/5** |

Bootstrap 95% CIs (10,000 resamples on per-slate medians):
  - A Mahal CI [2.65, 3.62], FP CI [1.11, 1.69]
  - B Mahal CI [2.61, 2.93], FP CI [1.17, 1.76]
  - C Mahal CI [2.44, 2.81], FP CI [0.87, 1.42]

### Pro reference (16 dev slates only, N=16,400 pro lineups)

  - Bands: HP/HO 35.9%, HP/LO 11.7%, LP/HO 16.2%, LP/LO 36.2% (slightly different from full-24-slate pooled 38.7/13.0/15.2/33.1 because pooled medians shift with formulation lineups added).
  - Primary stack mean 4.58; %≥5 = 66.9%.
  - Bring-back ≥1 rate = 22.4%.

### Notable observations (descriptive only — do NOT influence Stage 5)

  - Formulation A over-allocates to HP/LO (+13.5pp) and under-allocates to LP/HO (−10.4pp) — the mid-mode Gaussian centered at u=0.50 is selecting frontier points that are mostly the "high-projection-low-ownership" leverage class.
  - Formulation B drops below 12% at primary≥5 because its anchor-softmax + stage-2-fill scoring rewards balanced lineups with smaller stacks (the high-temp τ_player=5.0 makes 5-stack uniqueness a low-probability event in the score).
  - Formulation C produces the lowest fingerprint distance (1.09 vs A 1.46, B 1.63) and lowest Mahal (2.51) but band distribution is severely chalk-skewed (HP/HO 62%, LP/LO only 6.7%) — pool-scoring on premium pushes selection to the highest-projection game-stacks, blowing the band balance.

These observations are not used to modify formulations or the selection rule. They are recorded for the user's decision-making.

---

## 5. Selection outcome (Stage 5)

**Per pre-registered Stage 2E rule 3:** Zero formulations pass ≥4 of 5 benchmarks. **STOP.** Stage 6 is NOT executed. This is a pre-registered negative finding.

Document: `SELECTION.md`.

---

## 6. Holdout validation (Stage 6)

**NOT EXECUTED.** Per Stage 2E selection rule, no candidate qualifies for the single-shot holdout. The 8 holdout slates remain sealed.

---

## 7. Final assessment + recommendation

**Outcome classification: NO CANDIDATE.**

The 3 pre-registered formulations, with the magnitudes locked in Stage 2 (and unchanged through Stage 4), do not match pros on the 5 structural benchmarks at the Bonferroni-corrected dev thresholds. The architectural variation tested (mixture sampling, hierarchical anchor, game-stack premium) was not sufficient to clear ≥4/5.

This is a **substantive negative finding** under pre-registered methodology. It is NOT a failure of execution.

**What the user can validly conclude:**

  1. Within the 3 formulation families × the locked magnitudes, no formulation is a match-pros candidate at the registered thresholds.
  2. All three formulations capture *some* pro structure (B2 + B3 pass for A and C); the gaps are concentrated in band distribution (B1), Mahalanobis (B4), and fingerprint (B5).
  3. The single best aggregate metric across formulations is C's median fingerprint of 1.09 (right at the threshold) and median Mahal of 2.51 (above threshold). C is the closest to qualifying but did not.

**What the user CANNOT validly conclude (without a fresh pre-registration):**

  1. That C "would have passed" at a relaxed threshold — relaxing thresholds post-hoc invalidates the multiple-comparison correction.
  2. That a small-magnitude tweak to A or C "would close the gap" — would-be tweaks are not pre-registered, so testing them on dev would be selection bias and testing on holdout would burn the holdout.
  3. That the framework principles in 2A are wrong — the architectures *operationalize* the principles in only one of many possible ways.

**Recommendation (to user, who decides):** Treat this as a closed protocol. If further work is desired, design a fresh pre-registration with new formulation families OR new magnitudes (informed by these results, but with a NEW holdout split to preserve generalization validity).

---

## METHODOLOGY INTEGRITY CHECKLIST

- [x] Holdout slates were locked in Stage 1 and not analyzed until Stage 6.
  - Locked at start of Stage 1 in `HOLDOUT_LOCK.md`. Stage 6 not executed; holdout never opened. Validator (`validate.py`) iterates only over the 16-slate `DEV_SLATES` list. Implementation scripts iterate `DEV_SLATES` only and document `HOLDOUT_SLATES_DO_NOT_OPEN`.

- [x] All 3 formulations were specified in Stage 2 before any was implemented.
  - `SPECIFICATION.md` was written and locked end-of-Stage-2 with all 3 formulation structures + magnitudes + 30-entry assumption ledger before any of `slate-derived-formulation-{A,B,C}.ts` was authored.

- [x] No formulation was modified based on results from another formulation.
  - Implementation order: A → B → C in chronological succession. After C was implemented and run, no edits to A or B were made on the basis of B/C diagnostics. Stage 2.5 Amendment 2 (gameTotal scaling) applied uniformly to B and C as a unit-interpretation correction; not driven by validation results.

- [x] Multiple-comparisons correction was applied to development benchmark thresholds.
  - α = 0.05 / 15 = 0.0033 declared in Stage 2D. Stage 4 thresholds (per-band 8.0pp, primary ±0.30, bring-back ±7.0pp, Mahal ≤2.25 on ≥13/16, fingerprint ≤1.10 on ≥13/16) are pre-registered conservative thresholds chosen to be robust at the corrected α.

- [x] Selection rule was applied as pre-registered, not redefined post-hoc.
  - `SELECTION.md` applies the Stage 2E rule literally: zero formulations pass ≥4/5 ⇒ STOP. The rule was NOT softened to "best of 2/5" or "any formulation that passes 2+ on Mahal."

- [x] Holdout test was single-shot with no iteration based on results.
  - Holdout test was not run (no qualifier per Stage 5). Therefore no iteration occurred.

- [x] Final report includes negative findings honestly if applicable.
  - Section 7 declares "NO CANDIDATE" and explicitly enumerates what cannot be inferred from the negative result.

- [x] Magnitude choices in formulations are framework-justified, not data-fitted.
  - All magnitudes (μ_chalk=0.85, σ=0.05, base weights (0.40, 0.30, 0.30), λ_team=0.40, λ_player=0.30, p_bb=0.22, γ=0.25, δ=0.20, τ_team=0.30, τ_player=5.0, τ_pitcher=4.0, τ_game=4.0, etc.) are tied to framework principles + prior pro behavioral aggregates (band 38.7%, bring-back 21.6%, mean primary 4.58). Pro behavioral data was used to set magnitudes BEFORE running on dev, not adjusted from dev results. The pro reference numbers come from `lineup_level/` analyses computed before this protocol began.

All 8 items checked. No methodology breach to report.

---

## Files (final state of slate_derived_research/)

  - `HOLDOUT_LOCK.md` — Stage 1 holdout split.
  - `SPECIFICATION.md` — Stage 2 locked specification.
  - `SPECIFICATION_AMENDMENT.md` — Stage 2.5 amendments (implementation choices).
  - `validate.py` — Stage 4 validator.
  - `validation_results.json` — machine-readable Stage 4 results.
  - `DEVELOPMENT_VALIDATION.md` — human-readable Stage 4 results.
  - `SELECTION.md` — Stage 5 selection outcome.
  - `FINAL_REPORT.md` — this file.
  - `development_results/{A,B,C}/{slate}_dk.csv`, `{slate}_detail.csv`, `run_summary.json` — per-formulation per-slate output.

Implementation files (in dfs-optimizer repo):
  - `src/scripts/slate-derived-formulation-A.ts`
  - `src/scripts/slate-derived-formulation-B.ts`
  - `src/scripts/slate-derived-formulation-C.ts`

End of Final Report.
