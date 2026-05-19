"""Per-slate analysis of BB variants from methods_multi_results.json.
Identify which variants win/lose on which slates. Check HOLDOUT separately."""
import json, os
import numpy as np

LIVE_AUDIT = "C:/Users/colin/Projects/dfs-optimizer/live_audit"
DFSOPTO = "C:/Users/colin/dfs opto"

splits = json.load(open(os.path.join(LIVE_AUDIT, 'wfa_splits.json')))
holdout_slates = set(splits['holdout'])
wfa_slates = set(splits['wfa'])
dev_slates = set(splits['dev'])

data = json.load(open(os.path.join(DFSOPTO, 'methods_multi_results.json')))
rows = data['rows']
variants = [v['name'] for v in data['variants']]

# Per-split aggregate
print(f"{'Variant':<10} {'DEV ROI':>9} {'WFA ROI':>9} {'HOLD ROI':>10} {'DEV prof':>9} {'WFA prof':>9} {'HOLD prof':>10}")
print('-' * 80)
for v in variants:
    for split_name, split_set in [('DEV', dev_slates), ('WFA', wfa_slates), ('HOLDOUT', holdout_slates)]:
        rows_split = [r for r in rows if r['slate'] in split_set]
        cost = sum(r['variants'][v]['cost'] for r in rows_split)
        pay = sum(r['variants'][v]['payout'] for r in rows_split)
        roi = (pay/cost - 1) * 100 if cost > 0 else 0
        prof = sum(1 for r in rows_split if r['variants'][v]['roi'] > 0)
    # condense one line per variant
    dev_rows = [r for r in rows if r['slate'] in dev_slates]
    wfa_rows = [r for r in rows if r['slate'] in wfa_slates]
    hold_rows = [r for r in rows if r['slate'] in holdout_slates]

    def roi_for(rows_, v):
        c = sum(r['variants'][v]['cost'] for r in rows_)
        p = sum(r['variants'][v]['payout'] for r in rows_)
        return (p/c - 1) * 100 if c > 0 else 0
    def prof_for(rows_, v):
        return sum(1 for r in rows_ if r['variants'][v]['roi'] > 0)

    print(f"{v:<10} {roi_for(dev_rows, v):>8.2f}% {roi_for(wfa_rows, v):>8.2f}% {roi_for(hold_rows, v):>9.2f}% {prof_for(dev_rows, v)}/{len(dev_rows):<7} {prof_for(wfa_rows, v)}/{len(wfa_rows):<7} {prof_for(hold_rows, v)}/{len(hold_rows)}")

print(f"\n=== PER-SLATE ROI COMPARISON ===")
print(f"{'slate':<15} {'split':<8} " + " ".join(v.rjust(7) for v in variants))
for r in sorted(rows, key=lambda x: x['slate']):
    split = 'DEV' if r['slate'] in dev_slates else ('WFA' if r['slate'] in wfa_slates else 'HOLDOUT')
    vals = " ".join(f"{r['variants'][v]['roi']:>6.0f}%" for v in variants)
    print(f"{r['slate']:<15} {split:<8} {vals}")
