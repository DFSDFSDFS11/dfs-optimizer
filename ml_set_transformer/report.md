# Set Transformer for Sequential Portfolio Construction

Device: cpu, threads: 6
Held-out slates: ['4-19-26', '4-21-26', '4-24-26', '4-8-26']

## Stage 1: Data Prep

Sequence rows: 16,579 (pro lineups in their submission order)
Candidate pool rows: 89,264
Slates: 18
Lineup features: 33
Slate features: 8
Train-only slates: 12 (['4-12-26', '4-14-26', '4-15-26', '4-17-26', '4-18-26', '4-20-26', '4-23-26', '4-25-26', '4-25-26-early', '4-27-26', '4-28-26', '4-6-26'])
Inner-val slates: ['4-22-26', '4-26-26']
Held-out slates: ['4-19-26', '4-21-26', '4-24-26', '4-8-26']

## Stage 2: Model Architecture

Model parameter count: 122,529

## Stage 3: Training

Training examples (k=0..149 per pro-slate): 11,133
Inner-val examples: 1,998

Training: 25 epochs, batch_size=32, lr=0.0005, device=cpu
Estimate: 347 steps/epoch × 25 = 8,675 total steps

  Epoch  1/25  train_loss=4.0040  val_loss=3.6308  val_acc=0.1451  (0.8m)
  Epoch  2/25  train_loss=2.7975  val_loss=3.6308  val_acc=0.1607  (1.7m)
  Epoch  3/25  train_loss=2.3300  val_loss=3.7415  val_acc=0.1512  (2.5m)
  Epoch  4/25  train_loss=2.0950  val_loss=3.5333  val_acc=0.2077  (3.4m)
  Epoch  5/25  train_loss=1.9571  val_loss=3.4583  val_acc=0.2007  (4.2m)
  Epoch  6/25  train_loss=1.8160  val_loss=3.5362  val_acc=0.1967  (5.0m)
  Epoch  7/25  train_loss=1.7665  val_loss=3.1779  val_acc=0.2337  (5.9m)
  Epoch  8/25  train_loss=1.6583  val_loss=3.7029  val_acc=0.2112  (6.7m)
  Epoch  9/25  train_loss=1.6293  val_loss=3.2295  val_acc=0.2272  (7.5m)
  Epoch 10/25  train_loss=1.5734  val_loss=3.8740  val_acc=0.2608  (8.4m)
  Epoch 11/25  train_loss=1.5128  val_loss=3.4555  val_acc=0.2508  (9.2m)
  Epoch 12/25  train_loss=1.4727  val_loss=3.9171  val_acc=0.2232  (10.0m)
  Early stopping at epoch 12 (no improvement for 5 epochs)

Best inner val loss: 3.1779
Saved model to set_transformer_best.pt

## Stage 4: Cross-Pro Generalization (precision-at-150 across pros, training slates)

  bgreseth            mean precision-at-150 across 10 slates: 0.0000
  needlunchmoney      mean precision-at-150 across 11 slates: 0.0006
  nerdytenor          mean precision-at-150 across 11 slates: 0.0006
  shaidyadvice        mean precision-at-150 across 11 slates: 0.0000
  shipmymoney         mean precision-at-150 across 11 slates: 0.0006
  youdacao            mean precision-at-150 across 9 slates: 0.0000
  zroth               mean precision-at-150 across 12 slates: 0.0006

**Mean cross-pro precision-at-150: 0.0003 ± 0.0003**
Gate (mean ≥ 0.45 AND std ≤ 0.10): FAIL
Sub-gate (mean ≥ 0.40): FAIL

## Stage 5: Held-out slate validation

  4-19-26          bgreseth            precision-at-150 = 0.0000  (hits=0/150)
  4-19-26          needlunchmoney      precision-at-150 = 0.0000  (hits=0/150)
  4-19-26          nerdytenor          precision-at-150 = 0.0000  (hits=0/150)
  4-19-26          shaidyadvice        precision-at-150 = 0.0000  (hits=0/150)
  4-19-26          shipmymoney         precision-at-150 = 0.0000  (hits=0/150)
  4-19-26          youdacao            precision-at-150 = 0.0000  (hits=0/150)
  4-19-26          zroth               precision-at-150 = 0.0000  (hits=0/150)
  4-21-26          bgreseth            precision-at-150 = 0.0000  (hits=0/150)
  4-21-26          nerdytenor          precision-at-150 = 0.0000  (hits=0/150)
  4-21-26          shaidyadvice        precision-at-150 = 0.0000  (hits=0/150)
  4-21-26          shipmymoney         precision-at-150 = 0.0000  (hits=0/150)
  4-21-26          zroth               precision-at-150 = 0.0000  (hits=0/150)
  4-24-26          needlunchmoney      precision-at-150 = 0.0000  (hits=0/150)
  4-24-26          nerdytenor          precision-at-150 = 0.0000  (hits=0/150)
  4-24-26          shaidyadvice        precision-at-150 = 0.0000  (hits=0/150)
  4-24-26          shipmymoney         precision-at-150 = 0.0000  (hits=0/150)
  4-24-26          youdacao            precision-at-150 = 0.0000  (hits=0/150)
  4-24-26          zroth               precision-at-150 = 0.0000  (hits=0/150)
  4-8-26           bgreseth            precision-at-150 = 0.0067  (hits=1/150)
  4-8-26           nerdytenor          precision-at-150 = 0.0067  (hits=1/150)
  4-8-26           shaidyadvice        precision-at-150 = 0.0000  (hits=0/150)
  4-8-26           shipmymoney         precision-at-150 = 0.0000  (hits=0/150)
  4-8-26           zroth               precision-at-150 = 0.0000  (hits=0/150)

**Mean held-out precision-at-150: 0.0006**
Gate (≥ 0.40): FAIL

## Stage 6: Portfolio construction on held-out slates

  Building ST portfolio for 4-19-26...
    4-19-26: 150 lineups in 0.9s
  Building ST portfolio for 4-21-26...
    4-21-26: 150 lineups in 1.0s
  Building ST portfolio for 4-24-26...
    4-24-26: 150 lineups in 0.9s
  Building ST portfolio for 4-8-26...
    4-8-26 step 148: no valid candidate; relaxing constraints
    4-8-26 step 149: no valid candidate; relaxing constraints
    4-8-26: 150 lineups in 1.0s

## Stage 7-8: Hermes-A comparison + context-dependence

Stages 7 + 8 (gate 5 context dependence) deferred to TS post-processor to compute ROI/Mahalanobis
See ml_st_compare.ts

### Stage 8 Gate 5: context-dependence (KL div between step-50 and step-100 distributions)

  Mean symmetric KL (per-feature avg, step50 vs step100): 0.0475
  Gate (KL > 0.15): FAIL

## Preliminary Decision (Stages 4, 5, 8 only — Stage 7 pending TS post-process)

Stage 4 (cross-pro precision ≥ 0.45, std ≤ 0.10): FAIL
Stage 5 (held-out precision ≥ 0.40): FAIL
Stage 8 Gate 5 (context KL > 0.15): FAIL

**Preliminary: FAIL — document and stop**

## Stage 9: Ablations

Ablation 1: No portfolio context (10-epoch quick train)
  No-context val_loss=7.5076  val_acc=0.1672

Ablation 2: No slate context (10-epoch quick train)
  No-slate val_loss=4.4417  val_acc=0.1827

Ablation 0: Full model (10-epoch quick train, baseline)
  Full val_loss=3.1663  val_acc=0.2778

### Ablation summary

| Ablation | val_loss | val_acc | gap to full |
|---|---|---|---|
| Full model (10ep) | 3.1663 | 0.2778 | baseline |
| No portfolio context | 7.5076 | 0.1672 | +0.1106 |
| No slate context | 4.4417 | 0.1827 | +0.0951 |


---

# Stage 7: Set Transformer vs Hermes-A on held-out slates

### 4-8-26

  ST portfolio size: 150
  Hermes-A size: 126

| Metric | Set Transformer | Hermes-A | Winner |
|---|---|---|---|
| Mahalanobis | 8.37 | 1.85 | Hermes-A |
| KS distance | 0.446 | 0.121 | Hermes-A |
| ROI | -87% | -96% | ST |
| Payout | $405 | $128 | |

### 4-21-26

  ST portfolio size: 150
  Hermes-A size: 150

| Metric | Set Transformer | Hermes-A | Winner |
|---|---|---|---|
| Mahalanobis | 6.93 | 1.42 | Hermes-A |
| KS distance | 0.626 | 0.206 | Hermes-A |
| ROI | -96% | 813% | Hermes-A |
| Payout | $112 | $27386 | |

### 4-19-26

  ST portfolio size: 150
  Hermes-A size: 150

| Metric | Set Transformer | Hermes-A | Winner |
|---|---|---|---|
| Mahalanobis | 12.48 | 0.73 | Hermes-A |
| KS distance | 0.731 | 0.114 | Hermes-A |
| ROI | -94% | -82% | Hermes-A |
| Payout | $170 | $528 | |

### 4-24-26

  ST portfolio size: 150
  Hermes-A size: 150

| Metric | Set Transformer | Hermes-A | Winner |
|---|---|---|---|
| Mahalanobis | 4.75 | 0.76 | Hermes-A |
| KS distance | 0.577 | 0.140 | Hermes-A |
| ROI | -93% | -93% | ST |
| Payout | $215 | $202 | |


## Stage 7 Aggregate

Held-out slates: 4
ST beats Hermes on Mahalanobis: 0/4
ST beats Hermes on ROI: 2/4
ST total: $901 (ROI -92.5%)
Hermes-A total: $28244 (ROI 135.4%)
ST/Hermes payout ratio: 3.2%

## Stage 7 Gates

Gate (ST Mahalanobis better on ≥3 of 4): FAIL (0/4)
Gate (ST payout ≥ 80% of Hermes): FAIL (3.2%)
