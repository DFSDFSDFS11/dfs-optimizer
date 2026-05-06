# DEVELOPMENT VALIDATION — Stage 4

**Bonferroni-corrected α = 0.05 / 15 = 0.0033** (15 tests = 3 formulations × 5 benchmarks).
Pass criteria are deterministic thresholds (Stage 2D), not p-values; CIs are reported for transparency.

## Pro reference (16 dev slates only)

  - N pros: 16400
  - Bands: HP/HO 35.9% | HP/LO 11.7% | LP/HO 16.2% | LP/LO 36.2%
  - Primary stack mean: 4.58; %≥5: 66.9%
  - Bring-back ≥1 rate: 22.4%

## Per-formulation benchmark results

| Formulation | B1 Bands | B2 Stack | B3 BringBack | B4 Mahal | B5 Fingerprint | # Passed |
|-------------|----------|----------|--------------|----------|----------------|----------|
| A | FAIL | PASS | PASS | FAIL | FAIL | **2/5** |
| B | FAIL | FAIL | FAIL | FAIL | FAIL | **0/5** |
| C | FAIL | PASS | PASS | FAIL | FAIL | **2/5** |

### Detail per formulation

#### Formulation A

  - N lineups (all dev slates): 1200

**Benchmark 1 (Band distribution):**
  - HP/HO: 31.9% (pro 38.7%, gap -6.8pp)
  - HP/LO: 26.5% (pro 13.0%, gap +13.5pp)
  - LP/HO: 4.8% (pro 15.2%, gap -10.4pp)
  - LP/LO: 36.8% (pro 33.1%, gap +3.7pp)
  - Max gap: 13.50pp (threshold <8.0); total dev: 34.5pp (threshold <25.0)
  - **FAIL**

**Benchmark 2 (Stack distribution):**
  - Primary mean: 4.777 (pro 4.58, diff +0.197, threshold <0.3)
  - %≥5: 77.7% (pro 67.1%, diff +10.6pp, threshold <12.0)
  - **PASS**

**Benchmark 3 (Bring-back):**
  - BB ≥1 rate: 24.8% (pro 21.6%, diff +3.1pp, threshold <7.0)
  - **PASS**

**Benchmark 4 (Mahalanobis to pros):**
  - Median across 16 dev slates: 2.713
  - 95% bootstrap CI: [2.648, 3.619]
  - Slates with Mahal ≤ 2.25: 0/16 (threshold ≥ 13)
  - **FAIL**

**Benchmark 5 (Fingerprint distance):**
  - Median across 16 dev slates: 1.456
  - 95% bootstrap CI: [1.112, 1.687]
  - Slates with fingerprint ≤ 1.1: 6/16 (threshold ≥ 13)
  - **FAIL**

  - Mean compute time per slate: 1 ms

#### Formulation B

  - N lineups (all dev slates): 1200

**Benchmark 1 (Band distribution):**
  - HP/HO: 14.3% (pro 38.7%, gap -24.4pp)
  - HP/LO: 19.5% (pro 13.0%, gap +6.5pp)
  - LP/HO: 7.2% (pro 15.2%, gap -8.0pp)
  - LP/LO: 59.0% (pro 33.1%, gap +25.9pp)
  - Max gap: 25.90pp (threshold <8.0); total dev: 64.8pp (threshold <25.0)
  - **FAIL**

**Benchmark 2 (Stack distribution):**
  - Primary mean: 4.120 (pro 4.58, diff +0.460, threshold <0.3)
  - %≥5: 12.0% (pro 67.1%, diff +55.1pp, threshold <12.0)
  - **FAIL**

**Benchmark 3 (Bring-back):**
  - BB ≥1 rate: 0.1% (pro 21.6%, diff +21.5pp, threshold <7.0)
  - **FAIL**

**Benchmark 4 (Mahalanobis to pros):**
  - Median across 16 dev slates: 2.667
  - 95% bootstrap CI: [2.608, 2.929]
  - Slates with Mahal ≤ 2.25: 0/16 (threshold ≥ 13)
  - **FAIL**

**Benchmark 5 (Fingerprint distance):**
  - Median across 16 dev slates: 1.628
  - 95% bootstrap CI: [1.167, 1.756]
  - Slates with fingerprint ≤ 1.1: 6/16 (threshold ≥ 13)
  - **FAIL**

  - Mean compute time per slate: 16 ms

#### Formulation C

  - N lineups (all dev slates): 1200

**Benchmark 1 (Band distribution):**
  - HP/HO: 62.2% (pro 38.7%, gap +23.5pp)
  - HP/LO: 29.8% (pro 13.0%, gap +16.8pp)
  - LP/HO: 1.4% (pro 15.2%, gap -13.8pp)
  - LP/LO: 6.7% (pro 33.1%, gap -26.4pp)
  - Max gap: 26.43pp (threshold <8.0); total dev: 80.4pp (threshold <25.0)
  - **FAIL**

**Benchmark 2 (Stack distribution):**
  - Primary mean: 4.564 (pro 4.58, diff +0.016, threshold <0.3)
  - %≥5: 56.4% (pro 67.1%, diff +10.7pp, threshold <12.0)
  - **PASS**

**Benchmark 3 (Bring-back):**
  - BB ≥1 rate: 18.2% (pro 21.6%, diff +3.4pp, threshold <7.0)
  - **PASS**

**Benchmark 4 (Mahalanobis to pros):**
  - Median across 16 dev slates: 2.507
  - 95% bootstrap CI: [2.443, 2.811]
  - Slates with Mahal ≤ 2.25: 1/16 (threshold ≥ 13)
  - **FAIL**

**Benchmark 5 (Fingerprint distance):**
  - Median across 16 dev slates: 1.090
  - 95% bootstrap CI: [0.874, 1.419]
  - Slates with fingerprint ≤ 1.1: 8/16 (threshold ≥ 13)
  - **FAIL**

  - Mean compute time per slate: 5 ms
