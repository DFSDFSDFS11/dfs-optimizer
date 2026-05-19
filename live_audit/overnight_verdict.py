"""
Final overnight verdict report.
Reads all bias-diagnostic outputs and gives a single recommendation.
"""
import json, os
import numpy as np
LIVE_AUDIT = "C:/Users/colin/Projects/dfs-optimizer/live_audit"

def safe_load(name):
    p = os.path.join(LIVE_AUDIT, name)
    if not os.path.exists(p): return None
    return json.load(open(p))

def agg(rows, key):
    c = sum(r[key]['cost'] for r in rows)
    p = sum(r[key]['payout'] for r in rows)
    prof = sum(1 for r in rows if r[key]['roi'] > 0)
    t1 = sum(r[key]['top1'] for r in rows)
    return (p/c-1)*100 if c>0 else 0, prof, t1, p-c

print("=" * 78)
print("OVERNIGHT VERDICT: v4 (125 feats) vs v5 (201 feats)")
print("=" * 78)

# 1. Original backtest
orig = safe_load('v5_backtest_results.json')
if orig:
    rows = orig['rows']
    splits = json.load(open(os.path.join(LIVE_AUDIT,'wfa_splits.json')))
    TRAINED = set(splits['dev']) | set(splits['wfa'])
    oos = [r for r in rows if r['slate'] not in TRAINED]
    ins = [r for r in rows if r['slate'] in TRAINED]
    print(f"\n[1] ORIGINAL BACKTEST (in-sample headline)")
    print(f"{'set':<14} {'n':>3} {'v4 ROI':>10} {'v5 ROI':>10} {'diff':>8}")
    for label, lst in [('FULL 29', rows), ('IN-SAMPLE', ins), ('TRUE OOS', oos)]:
        v4r,_,_,_ = agg(lst,'v4'); v5r,_,_,_ = agg(lst,'v5')
        print(f"  {label:<12} {len(lst):>3} {v4r:>+9.2f}% {v5r:>+9.2f}% {v5r-v4r:>+7.2f}")

# 2. Lottery drop
if orig:
    rows = orig['rows']
    v5_nets = sorted([(r['slate'], r['v5']['payout']-r['v5']['cost']) for r in rows], key=lambda x: -x[1])
    v4_nets = sorted([(r['slate'], r['v4']['payout']-r['v4']['cost']) for r in rows], key=lambda x: -x[1])
    print(f"\n[2] LOTTERY-DROP ROBUSTNESS (drop top-K winning slates per model)")
    print(f"  K  v5_ROI    v4_ROI    Edge")
    for K in [0,1,2,3,5,7]:
        d5 = set(s for s,_ in v5_nets[:K])
        d4 = set(s for s,_ in v4_nets[:K])
        v5_keep = [r for r in rows if r['slate'] not in d5]
        v4_keep = [r for r in rows if r['slate'] not in d4]
        v5r,_,_,_ = agg(v5_keep,'v5'); v4r,_,_,_ = agg(v4_keep,'v4')
        print(f"  {K:>2}  {v5r:>+8.2f}% {v4r:>+8.2f}%   {v5r-v4r:>+6.2f}pp")

# 3. Retrain LOO (honest)
loo = safe_load('loo_retrain_results.json')
if loo:
    rows = loo['rows']
    print(f"\n[3] RETRAIN-LOO (each slate retrained with itself excluded, n={len(rows)})")
    print(f"{'model':<6} {'ROI':>10} {'NET':>10} {'prof':>8} {'top1':>6}")
    for m in ['v4','v5']:
        roi, prof, t1, net = agg(rows, m)
        print(f"  {m:<5} {roi:>+9.2f}% ${net:>+9.0f} {prof:>3}/{len(rows):<3} {t1:>6}")
else:
    print(f"\n[3] RETRAIN-LOO: pending (still running or not started)")

# 4. Purged k-fold
pk = safe_load('purged_kfold_results.json')
if pk:
    print(f"\n[4] PURGED K-FOLD CV (5-fold, embargo=1)")
    print(f"  v4 mean AUC: {pk['v4_mean']:.4f}  (folds: {[f'{x:.4f}' for x in pk['v4_aucs']]})")
    print(f"  v5 mean AUC: {pk['v5_mean']:.4f}  (folds: {[f'{x:.4f}' for x in pk['v5_aucs']]})")
    print(f"  delta: {pk['v5_mean']-pk['v4_mean']:+.4f}")
else:
    print(f"\n[4] PURGED K-FOLD: pending")

# 5. Final recommendation
print(f"\n" + "=" * 78)
print("RECOMMENDATION")
print("=" * 78)
verdict_lines = []
if orig and loo:
    rows = orig['rows']
    splits = json.load(open(os.path.join(LIVE_AUDIT,'wfa_splits.json')))
    TRAINED = set(splits['dev']) | set(splits['wfa'])
    oos = [r for r in rows if r['slate'] not in TRAINED]
    oos_v4_roi,_,_,_ = agg(oos,'v4'); oos_v5_roi,_,_,_ = agg(oos,'v5')
    loo_v4_roi,_,_,_ = agg(loo['rows'],'v4'); loo_v5_roi,_,_,_ = agg(loo['rows'],'v5')
    edge_oos = oos_v5_roi - oos_v4_roi
    edge_loo = loo_v5_roi - loo_v4_roi
    edge_cv = (pk['v5_mean'] - pk['v4_mean']) if pk else None

    print(f"\nv5 - v4 edge under three honest tests:")
    print(f"  True-OOS ROI:    {edge_oos:>+7.2f}pp  ({oos_v5_roi:+.1f}% vs {oos_v4_roi:+.1f}%)")
    print(f"  Retrain-LOO ROI: {edge_loo:>+7.2f}pp  ({loo_v5_roi:+.1f}% vs {loo_v4_roi:+.1f}%)")
    if edge_cv is not None:
        print(f"  Purged CV AUC:   {edge_cv:>+7.4f}   ({pk['v5_mean']:.4f} vs {pk['v4_mean']:.4f})")

    # Decision rule
    if edge_loo > 10 and edge_oos > 10 and (edge_cv is None or edge_cv > 0):
        print(f"\n  VERDICT: SHIP v5. Edge is robust to retraining LOO.")
    elif edge_loo > 0 and edge_oos > 0:
        print(f"\n  VERDICT: v5 is marginally better, but small sample. Ship v5 at REDUCED entry size (50 lineups).")
    elif edge_loo < 0 or edge_oos < 0:
        print(f"\n  VERDICT: REVERT TO v4. v5's +358% headline was DEV-overfitting.")
    else:
        print(f"\n  VERDICT: TIE — v5 ≈ v4. Choose v4 for simplicity (fewer features = less overfit risk).")
else:
    print("\n  Pending — wait for retrain LOO + purged k-fold to complete.")
