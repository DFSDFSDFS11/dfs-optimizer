# SLATE-DERIVED RESEARCH — STAGE 2 SPECIFICATION (LOCKED)

**Status:** LOCKED at end of Stage 2.
**Date locked:** 2026-05-03.
**Holdout:** 8 slates locked in `HOLDOUT_LOCK.md` — NOT to be touched until Stage 6.
**Development set:** 16 slates listed in `HOLDOUT_LOCK.md`.
**Portfolio target size:** N = 75 lineups (consistent with prior SDC scale; tighter than V1's 150 to force structural decisions).

Each of the three formulations below is an architecturally distinct construction system. They are NOT V1 variants and NOT SDC revisions. They are independent operationalizations of the framework principles described in 2A.

---

## 2A. The 6 framework principles being operationalized

These are the framework axes (Theory-of-DFS Ch. 4-8) that the formulations attempt to capture. All three formulations must address all six principles, but the *mechanism* by which each principle is encoded differs across formulations. This is the architectural variation.

  - **P1. Frontier-relative play.** Pro lineups concentrate on the projection-ownership efficient frontier; midbody non-frontier lineups are dominated. (Ch. 4.)
  - **P2. Variance-band balance.** Pros split portfolios across high-projection/high-ownership chalk and low-projection/low-ownership leverage; midbody under-represented. Pro band reality on dump (slate-relative pooled median): HP/HO 38.7%, HP/LO 13.0%, LP/HO 15.2%, LP/LO 33.1%. (Ch. 5.)
  - **P3. Structural correlation.** Same-team stacks (4-5 hitters) plus bring-back hitters from the opposing team in the same game (mean stack size 4.58, bring-back ≥1 rate 21.6%). (Ch. 6.)
  - **P4. Combinatorial uniqueness.** Avoid field-saturated 2/3/4-man combos; pros use rarer pair/triple structures. (Ch. 7.)
  - **P5. Pitcher-correlation discipline.** No pitcher-vs-own-stack; pitcher in same game as bring-back gets reward. (Ch. 6.)
  - **P6. Slate-feature responsiveness.** Construction shifts with slate features: high chalk concentration ⇒ chalk-lean; flat frontier ⇒ leverage-lean; high scoring environment ⇒ more correlation. (Ch. 8.)

---

## 2B. Seven shared slate features (formal definitions)

These features are computed identically across all three formulations from the SaberSim pool L (the candidate pool from the slate's `sspool*.csv`) and the projection file. They are the *common substrate* on which the three formulations operate.

For a slate with player set P and candidate lineup pool L (|L| ≈ 5,000–15,000):

  - For each ℓ ∈ L: proj(ℓ) = Σ_p projection(p), own(ℓ) = exp((1/n_hitters) · Σ_{hitter∈ℓ} log(max(0.1, ownership%(p)))) (geoMeanOwnHit).

### 2B.1 Efficient frontier F

Pareto set: F = { ℓ ∈ L : ¬∃ ℓ' ∈ L with proj(ℓ') ≥ proj(ℓ) AND own(ℓ') ≤ own(ℓ), at least one strict }. Computed by sorting L ascending by own and sweeping running max of proj. Typical |F| ∈ [30, 200].

### 2B.2 Projection elasticity ε_slate

Sort F by own ascending → f_1, …, f_M. ε_k = (Δproj/proj(f_k)) / (Δown/own(f_k)). ε_slate = median{ε_k}. High ε ⇒ steep frontier (chalk efficient); low ε ⇒ flat frontier (contrarian cheap).

### 2B.3 Nuts cluster N

N = top-K=100 lineups in L by proj. Compute (a) mean own(ℓ ∈ N), (b) primaryStack histogram, (c) primaryTeam histogram. Define `nuts_chalk = mean own(N)`.

### 2B.4 Slate variance σ_slate

For each player p with SaberSim percentiles: σ_p = (p75−p25)/1.349; CV_p = σ_p / max(0.5, proj(p)). Filter active players (proj ≥ 5 hitters, ≥ 8 pitchers). σ_slate = mean(CV_p).

### 2B.5 Scoring environment S_slate

S_slate = mean of top-K=10 game totals from projection file (sum of both teams' implied totals per game). Captures whether it's an 11-run-game slate or a 6-run-game slate.

### 2B.6 Chalk concentration H_slate

For each team t in slate, compute total team ownership Town(t) = Σ_{p∈t} ownership%(p) for hitters only. H_slate = HHI normalized = Σ_t (Town(t)/Σ_t' Town(t'))². Range [0,1]; high H ⇒ ownership concentrated on few teams.

### 2B.7 Player pool size |P_active|

Count of active players (active = proj ≥ 5 hitters or ≥ 8 pitchers). Distinguishes 2-game tiny pools from 14-game broad slates.

These 7 features are scalar per slate and shared input to all three formulations.

---

## 2C. Three formulations — full specifications

Each formulation is implemented as one TypeScript script. Magnitudes below are PRE-REGISTERED from the framework + the prior pro behavioral data summary (T1/T8 in `lineup_level/`) — they are NOT to be tuned during implementation or validation.

### 2C — FORMULATION A: Frontier sampling with variance-adaptive 3-mode Gaussian mixture

**Architectural thesis:** Pro portfolios are well-modeled as samples from a 3-mode Gaussian mixture along the projection-ownership efficient frontier, where mode placement and weight are determined by slate features. The mixture is variance-adaptive: σ of each mode scales with σ_slate so high-variance slates spread more.

**Procedure:**

**A.1. Construct frontier coordinate.** Sort F by own ascending → f_1, …, f_M. Define normalized frontier coordinate u(f_k) = (k−1)/(M−1) ∈ [0,1]. u=0 = lowest-own end, u=1 = highest-own end.

**A.2. Define 3 mode centers.** Three Gaussian modes along u:

  - μ_chalk = 0.85 (high-own, high-proj end)
  - μ_mid = 0.50
  - μ_leverage = 0.15 (low-own, lower-proj end)

**A.3. Variance-adaptive σ.** Base σ = 0.05. Adapted: σ_mode = 0.05 · (1 + 0.5 · z(σ_slate)), where z(σ_slate) is the slate's CV vs the framework reference of 0.30. Clamped σ ∈ [0.03, 0.10]. Same σ for all 3 modes.

**A.4. Mode weights from slate features.**

  - Base weights: (w_chalk, w_mid, w_leverage) = (0.40, 0.30, 0.30) (matches pro HP/HO 38.7% + half of HP/LO going to chalk).
  - Elasticity tilt: w_chalk += 0.10 · tanh((ε_slate − 0.20)/0.10); w_leverage -= same. Pivot ε=0.20 from 2B.2.
  - Chalk-concentration tilt: w_chalk += 0.05 · (H_slate − 0.20)/0.10. Pivot H=0.20.
  - Tilts capped: each mode weight ∈ [0.15, 0.60]. Re-normalize to sum to 1.

**A.5. Sample N=75 lineups.** For each draw:
  1. Sample mode m with probability w_m.
  2. Sample u* ~ N(μ_m, σ_m²); clamp u* ∈ [0,1].
  3. Find k = round(u* · (M−1)); take ℓ = f_k.
  4. If ℓ already in portfolio (collision), retry with new u* (max 5 retries; if all collide, take nearest unused k).
  5. Apply hard constraints: reject if pitcher faces own primary stack (P5). If rejected, retry sample.

**A.6. Hard constraints applied at sample time:**
  - No pitcher-vs-own-stack (P5).
  - Min primary stack 4 (P3) — if frontier entry violates, retry up to 10 times then accept the closest mps≥4 frontier entry.

**A.7. No exposure caps.** Per protocol — caps are a parameter-tuning move; this formulation's discipline is the mode structure.

**Outputs.** 75-lineup portfolio with mode tag per lineup.

**Magnitude justifications (cross-ref to 2F ledger):**
  - μ_chalk=0.85, μ_leverage=0.15 (A1): symmetric around 0.5 with 0.35 offset = framework choice for "high but not extreme."
  - σ=0.05 baseline (A2): from prior SDC; corresponds to ~5% of frontier band, which is roughly the granularity at which frontier rank is meaningful at |F|=100.
  - Base weights (0.40, 0.30, 0.30) (A3): matches pro HP/HO 38.7% allocation.
  - Tilt magnitudes 0.10 / 0.05, pivot 0.20 / 0.20, scale 0.10 (A4): from prior SDC specification (A4 in prior ledger), held over.
  - 5 retries / 10 retries (A5/A6): standard low-collision sampler choice.

### 2C — FORMULATION B: Hierarchical anchor-then-spread

**Architectural thesis:** Pro construction is hierarchical — each lineup first anchors on a primary stack team chosen by softmax over (rank-projection − λ·rank-ownership), then fills positions independently from the slate's player pool weighted by `projection − λ·ownership`. The hierarchy decouples team-selection from player-selection, capturing pros' apparent two-stage decision process.

**Procedure:**

**B.1. Stage 1 — Anchor team selection per lineup.**

For each team t with at least 4 hitters in P_active, compute:
  - team_proj(t) = sum of top-5 hitter projections in t
  - team_own(t) = sum of top-5 hitter ownerships in t
  - rank_proj(t) = percentile rank of team_proj(t) across teams (0-1, higher = better)
  - rank_own(t) = percentile rank of team_own(t) across teams (0-1, higher = chalkier)
  - Stage1 score: s1(t) = rank_proj(t) − λ_team · rank_own(t)
  - λ_team = 0.40 base; tilted by ε_slate: λ_team_eff = 0.40 + 0.30 · tanh((ε_slate − 0.20)/0.10) (steeper frontier ⇒ pros lean chalkier ⇒ smaller λ_team — counterintuitive sign? No — high ε means chalk is efficient, so pros pay LESS attention to ownership penalty when picking team; λ_team SMALLER. Sign correction: λ_team_eff = 0.40 − 0.30 · tanh((ε_slate − 0.20)/0.10). Range clamped [0.10, 0.70].)
  - Anchor sampled: P(anchor=t) = exp(s1(t)/τ_team) / Σ_t' exp(s1(t')/τ_team), τ_team = 0.30.

**B.2. Stage 2 — Fill 4-stack from anchor team.**

For team t = anchor, compute per-hitter: s2(p) = projection(p) − λ_player · ownership%(p) / 100. λ_player = 0.30 (base). For h_i ∈ team_t hitters, draw 4 hitters via softmax: P(h selected) ∝ exp(s2(h) / τ_player), τ_player = 5.0. Without replacement.

**B.3. Stage 3 — Bring-back decision.**

Bring-back probability p_bb depends on slate: p_bb = 0.22 + 0.10 · (S_slate − 9)/2. Pivot S=9 = framework reference for "average MLB game total." Clamp p_bb ∈ [0.10, 0.35]. Coin flip per lineup. If yes, sample 1 hitter from the opposing team (in same game as anchor) via same s2 softmax with τ_player.

**B.4. Stage 4 — Pitcher selection.**

Sample 2 pitchers from active pitchers via s2 softmax with τ_pitcher = 4.0. Hard constraint: pitcher cannot share team with anchor stack OR with bring-back team (P5).

**B.5. Stage 5 — Fill remaining positions.**

After stack + bring-back + 2P, remaining positions filled by softmax over s2 with τ_player = 5.0, sampled without replacement, respecting DK position eligibility, salary cap, and no-duplicate constraints.

**B.6. Repeat 75 times.** Each lineup is an independent draw; no portfolio-level diversity logic. Lineup-level uniqueness comes from softmax sampling stochasticity. Skip duplicates (regenerate if hash collision).

**Hard constraints (P5 + roster):**
  - No pitcher-vs-own-stack.
  - Salary 49,500 ≤ total ≤ 50,000.
  - DK position eligibility.
  - Min primary stack 4 enforced by anchor procedure.

**Magnitude justifications:**
  - λ_team base 0.40 (B1): from prior SDC's chalk-vs-leverage tilt magnitude; pros weight ownership ~40% as much as projection at team level.
  - λ_team tilt scale 0.30, pivot ε=0.20 (B1): from formulation A's frontier elasticity scale, applied at team selection layer.
  - λ_player 0.30 (B2): same logic but at player level — slightly smaller because individual ownership more noisy.
  - τ_team=0.30 (B1): softmax temperature giving moderate concentration around top 3-5 teams (calibrated mentally to pro stack-team distribution where top 3 teams typically capture 50-60% of stacks).
  - τ_player=5.0 (B2): high-temp = looser sampling within team; framework choice for "fill-from-team" treatment as quasi-random.
  - τ_pitcher=4.0 (B4): tighter than τ_player because pitchers more concentrated in pro lineups.
  - p_bb base 0.22 (B3): matches pro bring-back ≥1 rate of 21.6% from dump.
  - p_bb scale 0.10 / pivot S=9 (B3): from framework principle that high game totals correlate with bring-back use.

### 2C — FORMULATION C: Game-stack foundation with explicit correlation premium scoring

**Architectural thesis:** Pro lineups are best understood as game-stack foundations (one game's hitters dominate, with bring-back from same game) plus filler. A correlation premium is computed per (anchor team, bring-back team) game pair, and lineups are constructed by sampling game pairs proportional to premium, then filling.

**Procedure:**

**C.1. Compute game pair correlation premium.**

For each game g = (team_A, team_B):
  - top5_proj(g) = sum of top-5 hitter projections in team_A + top-3 hitter projections in team_B (4-stack + bring-back skeleton).
  - chalk_penalty(g) = average ownership of those 8 players.
  - corr_score(g) = top5_proj(g) − γ · chalk_penalty(g), γ = 0.25.
  - Adjusted by slate: γ_eff = 0.25 + 0.15 · tanh((H_slate − 0.20)/0.10). Higher chalk concentration ⇒ heavier ownership penalty (lean leverage). Clamp γ_eff ∈ [0.10, 0.40].
  - Game total bonus: corr_score(g) += δ · (game_total(g) − 9). δ = 0.20.
  - Final premium(g) = corr_score(g).

**C.2. Sample game pair per lineup.**

P(g chosen) ∝ exp(premium(g) / τ_game), τ_game = 4.0.

**C.3. Construct 4-2 game stack.** From sampled game g = (A, B):
  - 4 hitters from A: top-5 by projection, drop one with prob ∝ ownership (so highest-owned has highest drop prob — explicit chalk-fade within game stack).
  - 2 hitters from B (bring-back): from B's hitters, sample 2 via softmax over s2(p) = projection(p) − 0.30·ownership%(p), τ=5.0.

**C.4. Pitcher selection.**

Sample 2 pitchers from active pitcher pool via softmax over (projection − 0.30·ownership%/100), τ_pitcher=4.0. Hard constraint: pitcher cannot be in team A or B of the sampled game (P5).

**C.5. Fill remaining 2 positions (since 4+2+2P = 8, need 2 more for 10-roster).**

Softmax over s2 = projection − 0.30·ownership%/100 with τ=5.0, sampled without replacement, respecting DK position eligibility, salary, no-duplicates.

**C.6. Slate-feature responsiveness applied:**
  - τ_game scaled by σ_slate: τ_game_eff = 4.0 · (1 + 0.5 · (σ_slate − 0.30)/0.30). High variance ⇒ higher τ ⇒ more spread across game pairs. Clamp [2.0, 8.0].
  - 4-2 default; if S_slate > 11 (extreme high game total) ⇒ allow 5-3 game stack with prob 0.30 (sample 5 from A, 3 from B). Otherwise default 4-2.

**C.7. Repeat 75 times.** Skip duplicates.

**Hard constraints:**
  - Salary 49,500 ≤ total ≤ 50,000.
  - DK position eligibility.
  - No pitcher-in-stacked-game (P5).

**Magnitude justifications:**
  - γ=0.25 base (C1): chalk-vs-correlation tradeoff; pros weight ownership ~25% as much as proj at game-stack level.
  - γ tilt 0.15 (C1): allows γ_eff to swing between 0.10–0.40, plausible range from framework.
  - δ=0.20 game-total bonus (C1): scoring-environment principle from 2B.5.
  - τ_game=4.0 (C2): moderate concentration on top 3-5 game pairs.
  - 4-2 default (C3): matches pro maxGameStack distribution mode at 5 (top game has 5+ players when 4-stack + bring-back hits).
  - τ_game adapt scale 0.5 (C6): same family as σ adaptation in formulation A.
  - 5-3 prob 0.30 if S>11 (C6): rough framework "extreme game" frequency.

---

## 2D. Five benchmarks with Bonferroni-corrected thresholds

15 tests (3 formulations × 5 benchmarks). Bonferroni-corrected α: 0.05/15 = 0.0033 per-test threshold. Bootstrap 10,000 resamples used for CIs where applicable.

### Benchmark 1: Band distribution alignment (HP/HO, HP/LO, LP/HO, LP/LO)

  - Compute slate-relative-median bands (P1 in 2A, formula matches `slate_derived_construction/validate.py`).
  - **Pass criterion (development):** Each of the 4 bands' formulation% within 8.0pp of pro%, AND the absolute total deviation Σ |formulation% − pros%| < 25pp.
  - **Pass criterion (holdout, RELAXED):** Each band within 10.0pp, AND total deviation < 32pp.
  - Pro reference: HP/HO 38.7%, HP/LO 13.0%, LP/HO 15.2%, LP/LO 33.1%.

### Benchmark 2: Stack distribution alignment (primarySize)

  - Compute distribution over primarySize ∈ {2,3,4,5,6}.
  - Pro reference (from dump, 24,200 pros): 2: 0.6%, 3: 7.8%, 4: 24.4%, 5: 67.1%, 6: 0.05%. Mean 4.58.
  - **Pass criterion (development):** mean primarySize within 0.30 of pros (i.e., ∈ [4.28, 4.88]); AND |% with primarySize≥5 − pro_67.1%| < 12pp.
  - **Pass criterion (holdout, RELAXED):** mean within 0.40 ([4.18, 4.98]); AND |% size≥5 − 67.1%| < 16pp.

### Benchmark 3: Bring-back rate

  - Compute % lineups with bringBack ≥ 1.
  - Pro reference: 21.6%.
  - **Pass criterion (development):** within 7.0pp of pros (∈ [14.6%, 28.6%]).
  - **Pass criterion (holdout, RELAXED):** within 10.0pp ([11.6%, 31.6%]).

### Benchmark 4: Mahalanobis distance to per-slate pro consensus

  - Same 7-feature universal vector as prior SDC validator (primarySize, secondarySize, bringBack, numGames, numTeamsUsed, geoMeanOwn, avgProj). Per-slate pro mean & shrunk diagonal covariance; Mahalanobis distance from each formulation lineup to pros; portfolio-level median.
  - V1 reference (from prior dump): ~2.29 average across 18 slates. Prior SDC ~2.30.
  - **Pass criterion (development):** median Mahalanobis ≤ 2.25 (slight improvement over V1) on at least 13/16 dev slates (~81%, requires statistical signal beyond noise on ~3-slate margin).
  - **Pass criterion (holdout, RELAXED):** median Mahalanobis ≤ 2.40 on at least 5/8 holdout slates.

### Benchmark 5: Fingerprint distance (median lineup-to-nearest-pro distance on 9-feature standardized Manhattan)

  - 9-feature vector: primarySize, secondarySize, bringBack, maxGameStack, numGames, numTeamsUsed, geoMeanOwnHit, salaryStd, salaryTopThree.
  - V1 reference: ~0.80 (from prior SDC validation report).
  - **Pass criterion (development):** median fingerprint distance ≤ 1.10 (within 0.30 of V1; tighter than prior SDC's 1.30) on at least 13/16 dev slates.
  - **Pass criterion (holdout, RELAXED):** median fingerprint distance ≤ 1.30 on at least 5/8 holdout slates.

---

## 2E. Selection rule (PRE-COMMITTED)

Apply STRICTLY at Stage 5. No redefinition based on results.

  1. **Primary criterion:** Number of benchmarks passed at Stage 4 development thresholds.
  2. **Qualification gate:** A formulation must pass ≥4 of 5 benchmarks to qualify for Stage 6 holdout testing.
  3. **If 0 or 1 formulation passes ≥4 benchmarks:** STOP. Negative finding. Stage 6 NOT executed.
  4. **If exactly 1 formulation passes ≥4:** that formulation proceeds to Stage 6.
  5. **If 2 or 3 formulations pass ≥4:** apply tiebreakers in order, computed on dev set ONLY:
       a. Lowest median Mahalanobis distance to pros (Benchmark 4).
       b. Lowest median fingerprint distance (Benchmark 5).
       c. Fastest mean compute time per slate.
  6. **Exactly one formulation goes to Stage 6.**

Holdout outcome at Stage 6:
  - **Strong candidate:** passes ≥4 of 5 holdout benchmarks (using RELAXED thresholds in 2D).
  - **Weak candidate:** passes 3 of 5 holdout benchmarks.
  - **No candidate:** passes ≤2 of 5 holdout benchmarks.

---

## 2F. Numbered assumption ledger

Each entry: number, formulation tag, framework chapter ref, magnitude/structural choice, what would invalidate it.

| # | Tag | Ch | Choice | Invalidates |
|---|-----|----|--------|-------------|
| 1 | All | 4 | N=75 portfolio target | If 75 too small to populate band/stack distributions reliably (sample noise dominates). |
| 2 | All | 4 | Frontier defined on geoMeanOwnHit (not arithmetic mean) | If pros' implicit ownership treatment is arithmetic, geoMean misranks frontier. |
| 3 | All | 4 | SaberSim pool L is the candidate space (no separate ILP regen) | If SaberSim pool itself biased (e.g., over-weights chalk), all formulations inherit bias. |
| 4 | All | 8 | 7 slate features sufficient to span construction (ε, σ, S, H, P_active, F, N) | Other slate-context features (e.g., weather, vegas movement) materially affect pro construction. |
| 5 | A | 5 | 3-mode mixture along frontier captures pro density | If pro density better described by 2-mode or 4+ mode (e.g., bimodal at chalk and far-leverage with no mid). |
| 6 | A | 5 | μ_chalk=0.85, μ_leverage=0.15 symmetric placement | Pros place modes asymmetrically (e.g., chalk closer to 0.95, leverage ~0.30). |
| 7 | A | 5 | Base σ=0.05 of normalized frontier coordinate | Pros sample tighter (σ~0.02) or looser (σ~0.10). |
| 8 | A | 5 | Base mode weights (0.40, 0.30, 0.30) | If pros' weight on mid-mode <0.20 or >0.45. |
| 9 | A | 8 | Elasticity tilt magnitude 0.10 with pivot ε=0.20 | If pros' tilt-with-elasticity is steeper (>0.20) or absent. |
| 10 | A | 8 | σ scales with σ_slate (1+0.5·z) | If pros DON'T spread more on high-variance slates. |
| 11 | A | 6 | Min primary stack 4, no pitcher-vs-own-stack | If pros frequently use 3-3 splits or pitcher-stack overlap (rare). |
| 12 | B | 6 | Hierarchical anchor-then-fill captures pro decision flow | If pros pick players first then collapse to teams. |
| 13 | B | 6 | λ_team=0.40 base ownership weight at team layer | If pros' ownership weighting at team level is >0.60 or <0.20. |
| 14 | B | 8 | λ_team tilts inversely with elasticity (sign-corrected) | Sign opposite — pros lean leverage MORE on steep frontiers. |
| 15 | B | 6 | λ_player=0.30 at player layer (looser than team) | Player ownership matters more than team ownership in fill. |
| 16 | B | 6 | τ_team=0.30 softmax temperature | Pros concentrate on top-1 team (much smaller τ) or use uniform team selection (much larger τ). |
| 17 | B | 6 | τ_player=5.0 quasi-uniform within team fill | Pros are deterministic top-N within team. |
| 18 | B | 6 | p_bb base 0.22, scales with S_slate at 0.10/2 | Pro bring-back not driven by game total but by stack-team identity. |
| 19 | B | 6 | Pitcher cannot share team with anchor OR bring-back | Permissive interpretation only excludes anchor opponent. |
| 20 | C | 6 | Game-stack foundation = primary unit of construction | Pros think in team-stack units, not game-stack units. |
| 21 | C | 6 | γ=0.25 chalk-vs-correlation tradeoff at game-pair level | If γ much smaller (pros ignore ownership at game level) or much larger. |
| 22 | C | 8 | γ tilts +0.15 with H_slate (chalk concentration) | If pros LESS sensitive to chalk concentration at game level. |
| 23 | C | 8 | δ=0.20 game-total premium per run-above-9 | If game total has no effect on game-pair selection at pro level. |
| 24 | C | 6 | τ_game=4.0 → 3-5 dominant game pairs sampled | Pros use only top-1 game pair (tiny τ) or scatter widely. |
| 25 | C | 5 | 4-2 default game-stack composition | Pros use 5-3 or 4-3 more often than 4-2. |
| 26 | C | 8 | 5-3 enabled with p=0.30 only when S_slate>11 | Pros use 5-3 across all S_slate, not just extreme. |
| 27 | All | 7 | No combinatorial uniqueness term in any of the 3 formulations | If avoiding field-saturated combos is dominant pro behavior, all 3 will under-perform on Mahal/fingerprint. |
| 28 | All | 7 | No exposure caps in any formulation | If pros strictly cap player exposure at e.g. 30%, all 3 may over-concentrate. |
| 29 | All | 4 | Pro band reality from dump (38.7/13.0/15.2/33.1) is the target | Pros in the 24-slate dump are not representative of "true" pro behavior. |
| 30 | All | — | Single-shot holdout at Stage 6 with 8 slates is sufficient to detect overfitting | 8 slates noisy; difference between "real pattern" and "dev-set artifact" not separable. |

End of ledger. 30 numbered assumptions; matches Stage 2 target of 20-30.

---

## SPEC LOCK

This specification is LOCKED at end of Stage 2. No magnitude or structural change permitted in Stages 3–6. If implementation reveals an ambiguity, append a Stage 2.5 amendment with timestamp BEFORE continuing — but do not change formulation structure.

End of Stage 2.
