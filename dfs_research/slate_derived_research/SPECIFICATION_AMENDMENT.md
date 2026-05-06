# SPECIFICATION AMENDMENT — Stage 2.5

**Date:** 2026-05-03 (during Stage 3 implementation, before any results computed).
**Scope:** Implementation choice — does NOT change formulation structure.

## Amendment 1: Formulations B and C selection over pool, not de novo construction

**Issue.** Formulations B and C as written in Stage 2 specify a per-lineup constructive procedure (B: anchor team → fill 4-stack → bring-back → 2P → fill 2 more; C: sample game → 4-2 game stack → 2P → fill 2 more). Implementing position-aware, salary-aware, eligibility-aware lineup construction de novo would require re-implementing the full DK Classic lineup-builder, plus introducing potentially un-pre-registered choices around position fill order, salary trade-offs at fill time, etc.

**Resolution.** Formulations B and C operate on the same SaberSim pool L as Formulation A (consistent with Formulation A's spec and Assumption 3). Within L, each pool lineup ℓ is **scored** by the formulation's selection logic, then the top-N=75 are selected (with deterministic-seeded tie-break). Specifically:

- **Formulation B:** For each pool lineup ℓ, compute its "would-be" anchor team (= ℓ's primary stack team), and compute the s1 + s2 softmax probabilities the lineup would have under the hierarchical procedure. Score(ℓ) = log P(anchor=primaryTeam(ℓ)) + log P(picked-4-hitters | anchor) + log p_bb (if bringBack≥1) or log(1−p_bb) (if 0) + log P(2 pitchers | constraints) + filler. Select N=75 by descending Score(ℓ), with the slate-feature-driven λ_team / λ_player / p_bb modulating Score across slates.
- **Formulation C:** For each pool lineup ℓ, identify its dominant game (max maxGameStack hitters), compute Premium(g) for that game given slate features, and compute Score(ℓ) = Premium(g_ℓ) + log-likelihood that ℓ matches the 4-2 (or 5-3 if S>11) skeleton with sampled hitters. Select top-N=75.

This preserves the architectural thesis of each formulation (B = hierarchical anchor+fill; C = game-stack foundation) while reusing the candidate-space discipline already pre-registered for Formulation A.

**What this changes.** Implementation tractability. Score logic is fully derived from the pre-registered Stage 2 magnitudes (λ_team, λ_player, τ_team, τ_player, τ_pitcher, p_bb, γ, δ, τ_game). No new magnitudes introduced.

**What this does NOT change.** Formulation A is unchanged. The thesis of B (hierarchical decoupling of team-then-player) and C (game-stack foundation) is preserved. Magnitudes are unchanged.

**Risk.** Score(ℓ) over pool lineups gives a different distribution than independent samples from the constructive procedure — pool lineups already biased toward high-projection / valid-roster region. This may bias B and C closer to high-projection space than the pure constructive procedures would. This is an implementation-induced bias; documented here, not corrected.

End of Amendment 1.

## Amendment 2: gameTotal already in run-units, no /24 scaling

**Date:** 2026-05-03 (during Stage 3 implementation, observed in B and C first-pass output before any benchmark scoring).

**Issue.** In the first-pass implementation of Formulations B and C, I scaled `gameTotal` by /24 under the assumption it was in DK projection-point units. Inspection of the parser output shows `gameTotal` is in run units (typical values 7–12 for MLB), matching the spec's pivot S=9 directly. The /24 scaling produced S_slate values of 0.37–0.39, which made p_bb hit its lower clamp (0.10) on every slate and made the 5-3 toggle (S>11) never fire.

**Resolution.** Remove the /24 division in Formulations B and C. Use `gameTotal` directly. Formulation A is unaffected (its S_slate is informational only; not used in the mode-weight computation in 2C-A).

**What this changes.** Numerical implementation of S_slate matches spec interpretation. p_bb now varies across slates per spec. 5-3 toggle in C can fire on high-game-total slates per spec.

**What this does NOT change.** No magnitude is changed. The pre-registered base p_bb = 0.22, scale = 0.10/2, pivot = 9, and 5-3 threshold = 11 are unchanged.

End of Amendment 2.
