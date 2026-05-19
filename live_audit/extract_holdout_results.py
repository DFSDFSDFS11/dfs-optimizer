"""
Per Method 4 walk-forward protocol: extract HOLDOUT-only results from full backtest.

Reads atlas_vs_stacks_v3_results.json. Filters to holdout slates only.
Reports: Atlas vs Stacks-BB vs Stacks-V3 (and V4 if available) on HOLDOUT only.

Holdout slates (most recent 20%): 5-4-26, 5-5-26, 5-6-26, 5-8-26, 5-10-26
"""
import json, os, sys
import numpy as np

LIVE_AUDIT = "C:/Users/colin/Projects/dfs-optimizer/live_audit"
DFSOPTO = "C:/Users/colin/dfs opto"

splits = json.load(open(os.path.join(LIVE_AUDIT, 'wfa_splits.json')))
holdout_slates = set(splits['holdout'])
print(f"Holdout slates: {sorted(holdout_slates)}")

for fname in ['atlas_vs_stacks_v3_results.json', 'atlas_vs_stacks_v4_results.json']:
    path = os.path.join(DFSOPTO, fname)
    if not os.path.exists(path):
        print(f"\n{fname}: not yet generated")
        continue
    print(f"\n{'='*70}")
    print(f"HOLDOUT-ONLY results from {fname}")
    print('='*70)
    data = json.load(open(path))
    rows = data['rows']
    holdout_rows = [r for r in rows if r['slate'] in holdout_slates]
    print(f"Holdout slates found in results: {[r['slate'] for r in holdout_rows]}")
    if not holdout_rows: continue

    for label, key in [('Atlas', 'atlas'), ('Stacks-BB', 'v2nr'), ('Stacks-V3/V4 (challenger)', 'ic')]:
        cost = sum(r[key]['cost'] for r in holdout_rows)
        pay = sum(r[key]['payout'] for r in holdout_rows)
        roi = (pay / cost - 1) * 100 if cost > 0 else 0
        top1 = sum(r[key]['top1'] for r in holdout_rows)
        top01 = sum(r[key]['top01'] for r in holdout_rows)
        prof = sum(1 for r in holdout_rows if r[key]['roi'] > 0)
        mahals = [r[key]['mahal'] for r in holdout_rows if r[key]['mahal'] is not None]
        print(f"\n{label}:")
        print(f"  ROI: {roi:.2f}% | Profitable: {prof}/{len(holdout_rows)} | top1: {top1} top01: {top01}")
        print(f"  Per-slate ROI: {[(r['slate'], round(r[key]['roi'], 0)) for r in holdout_rows]}")
        if mahals:
            print(f"  Mean Mahalanobis: {np.mean(mahals):.3f}")
