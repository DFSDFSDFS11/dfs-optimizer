"""Phase 6: HOLDOUT validation for the ensemble variants."""
import json, os
LIVE_AUDIT = "C:/Users/colin/Projects/dfs-optimizer/live_audit"
DFSOPTO = "C:/Users/colin/dfs opto"

splits = json.load(open(os.path.join(LIVE_AUDIT, 'wfa_splits.json')))
holdout_slates = set(splits['holdout'])
print(f"HOLDOUT slates: {sorted(holdout_slates)}")

data = json.load(open(os.path.join(DFSOPTO, 'methods_multi_results.json')))
rows = data['rows']
variants = [v['name'] for v in data['variants']]

# HOLDOUT-only
hold_rows = [r for r in rows if r['slate'] in holdout_slates]
print(f"\nHOLDOUT contests found in backtest: {[r['slate'] for r in hold_rows]}")

def agg_roi(rows_, v):
    c = sum(r['variants'][v]['cost'] for r in rows_)
    p = sum(r['variants'][v]['payout'] for r in rows_)
    return (p/c - 1) * 100 if c > 0 else 0
def top1(rows_, v): return sum(r['variants'][v]['top1'] for r in rows_)
def top01(rows_, v): return sum(r['variants'][v]['top01'] for r in rows_)

print(f"\n=== HOLDOUT-only (Phase 6 validation) ===")
print(f"{'Variant':<14} {'HOLD ROI':>10} {'top1':>5} {'top01':>6}")
for v in variants:
    print(f"{v:<14} {agg_roi(hold_rows, v):>9.2f}% {top1(hold_rows, v):>5} {top01(hold_rows, v):>6}")

# Per-slate detail on holdout
print(f"\n=== PER-SLATE HOLDOUT ROI ===")
print(f"{'slate':<10} " + " ".join(v.rjust(13) for v in variants))
for r in sorted(hold_rows, key=lambda x: x['slate']):
    vals = " ".join(f"{r['variants'][v]['roi']:>12.1f}%" for v in variants)
    print(f"{r['slate']:<10} {vals}")
