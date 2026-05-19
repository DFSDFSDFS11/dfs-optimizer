"""
PAIRED COMPARISON: Atlas vs BB25 vs v4-XGB vs v5-XGB on the same 29 slates.

Atlas/BB25: from methods_multi_results.json (no training, drop-and-score LOO is the same as in-sample)
v4/v5: from loo_retrain_results.json (gold-standard retrain-LOO — each slate held out from training)

This is the definitive head-to-head under matched conditions.
"""
import json, os
from collections import defaultdict

LIVE_AUDIT = "C:/Users/colin/Projects/dfs-optimizer/live_audit"
DFSOPTO = "C:/Users/colin/dfs opto"

mm = json.load(open(os.path.join(DFSOPTO, 'methods_multi_results.json')))
loo = json.load(open(os.path.join(LIVE_AUDIT, 'loo_retrain_results.json')))['rows']
orig = json.load(open(os.path.join(LIVE_AUDIT, 'v5_backtest_results.json')))['rows']

# Index methods-multi by slate
mm_by_slate = {r['slate']: r['variants'] for r in mm['rows']}
loo_by_slate = {r['slate']: r for r in loo}
orig_by_slate = {r['slate']: r for r in orig}

# Shared slate set
slates_common = sorted(set(mm_by_slate.keys()) & set(loo_by_slate.keys()))
print(f"Common slates across BB25/Atlas backtest AND XGB retrain-LOO: {len(slates_common)}")

def agg(rows_dict, slate_key, model_key, payout_key='payout', cost_key='cost', top1_key='top1'):
    cost = sum(rows_dict[s][model_key][cost_key] for s in slates_common)
    pay = sum(rows_dict[s][model_key][payout_key] for s in slates_common)
    prof = sum(1 for s in slates_common if rows_dict[s][model_key]['roi'] > 0)
    t1 = sum(rows_dict[s][model_key].get(top1_key, 0) for s in slates_common)
    return (pay/cost - 1)*100 if cost > 0 else 0, prof, t1, pay - cost

# Method-multi access uses different structure
def agg_mm(model):
    cost = sum(mm_by_slate[s][model]['cost'] for s in slates_common)
    pay = sum(mm_by_slate[s][model]['payout'] for s in slates_common)
    prof = sum(1 for s in slates_common if mm_by_slate[s][model]['roi'] > 0)
    t1 = sum(mm_by_slate[s][model]['top1'] for s in slates_common)
    return (pay/cost - 1)*100 if cost > 0 else 0, prof, t1, pay - cost

def agg_xgb_loo(model):  # v4 or v5 retrain-LOO
    cost = sum(loo_by_slate[s][model]['cost'] for s in slates_common)
    pay = sum(loo_by_slate[s][model]['payout'] for s in slates_common)
    prof = sum(1 for s in slates_common if loo_by_slate[s][model]['roi'] > 0)
    t1 = sum(loo_by_slate[s][model]['top1'] for s in slates_common)
    return (pay/cost - 1)*100 if cost > 0 else 0, prof, t1, pay - cost

def agg_xgb_orig(model):  # v4 or v5 ORIGINAL (in-sample) backtest
    cost = sum(orig_by_slate[s][model]['cost'] for s in slates_common)
    pay = sum(orig_by_slate[s][model]['payout'] for s in slates_common)
    prof = sum(1 for s in slates_common if orig_by_slate[s][model]['roi'] > 0)
    t1 = sum(orig_by_slate[s][model]['top1'] for s in slates_common)
    return (pay/cost - 1)*100 if cost > 0 else 0, prof, t1, pay - cost

print(f"\n{'='*82}")
print(f"HEAD-TO-HEAD on {len(slates_common)} common slates ($3000/slate, 150 lineups Atlas/BB25, 500 lineups XGB)")
print(f"{'='*82}")
print(f"{'Method':<32} {'ROI':>10} {'NET':>12} {'Profitable':>12} {'top-1%':>8}")
print('-'*82)

# Original in-sample XGB
r,p,t,n = agg_xgb_orig('v4'); print(f"{'XGB v4 (in-sample backtest)':<32} {r:>+9.2f}% ${n:>+10.0f} {p:>4}/{len(slates_common):<3}  {t:>8}")
r,p,t,n = agg_xgb_orig('v5'); print(f"{'XGB v5 (in-sample backtest)':<32} {r:>+9.2f}% ${n:>+10.0f} {p:>4}/{len(slates_common):<3}  {t:>8}")
print()
# Retrain LOO XGB
r,p,t,n = agg_xgb_loo('v4'); print(f"{'XGB v4 (retrain-LOO)':<32} {r:>+9.2f}% ${n:>+10.0f} {p:>4}/{len(slates_common):<3}  {t:>8}")
r,p,t,n = agg_xgb_loo('v5'); print(f"{'XGB v5 (retrain-LOO)':<32} {r:>+9.2f}% ${n:>+10.0f} {p:>4}/{len(slates_common):<3}  {t:>8}")
print()
# Non-ML baselines
r,p,t,n = agg_mm('Atlas'); print(f"{'Atlas (no ML)':<32} {r:>+9.2f}% ${n:>+10.0f} {p:>4}/{len(slates_common):<3}  {t:>8}")
r,p,t,n = agg_mm('BB25');  print(f"{'BB25 (no ML)':<32} {r:>+9.2f}% ${n:>+10.0f} {p:>4}/{len(slates_common):<3}  {t:>8}")

# Per-slate detail across the four
print(f"\n{'='*100}")
print(f"PER-SLATE ROI: Atlas vs BB25 vs v4-LOO vs v5-LOO")
print(f"{'='*100}")
print(f"{'slate':<22} {'Atlas':>10} {'BB25':>10} {'v4-LOO':>10} {'v5-LOO':>10} {'best':>8}")
for s in slates_common:
    a = mm_by_slate[s]['Atlas']['roi']
    b = mm_by_slate[s]['BB25']['roi']
    v4 = loo_by_slate[s]['v4']['roi']
    v5 = loo_by_slate[s]['v5']['roi']
    vals = [('Atlas',a), ('BB25',b), ('v4',v4), ('v5',v5)]
    best = max(vals, key=lambda x: x[1])[0]
    print(f"  {s:<20} {a:>+9.1f}% {b:>+9.1f}% {v4:>+9.1f}% {v5:>+9.1f}%    {best:>8}")

# Wins
print(f"\n{'='*82}")
print(f"WIN COUNT PER METHOD (highest ROI on each slate)")
print(f"{'='*82}")
wins = {'Atlas':0, 'BB25':0, 'v4':0, 'v5':0}
for s in slates_common:
    a = mm_by_slate[s]['Atlas']['roi']
    b = mm_by_slate[s]['BB25']['roi']
    v4 = loo_by_slate[s]['v4']['roi']
    v5 = loo_by_slate[s]['v5']['roi']
    best = max([('Atlas',a), ('BB25',b), ('v4',v4), ('v5',v5)], key=lambda x: x[1])[0]
    wins[best] += 1
for m, w in sorted(wins.items(), key=lambda x: -x[1]):
    print(f"  {m:<10} {w}/{len(slates_common)} ({w/len(slates_common)*100:.0f}%)")

# Save
out = {'common_slates': slates_common, 'wins': wins,
       'aggregates': {
           'XGB_v4_orig': agg_xgb_orig('v4')[0],
           'XGB_v5_orig': agg_xgb_orig('v5')[0],
           'XGB_v4_LOO':  agg_xgb_loo('v4')[0],
           'XGB_v5_LOO':  agg_xgb_loo('v5')[0],
           'Atlas':       agg_mm('Atlas')[0],
           'BB25':        agg_mm('BB25')[0],
       }}
json.dump(out, open(os.path.join(LIVE_AUDIT, 'paired_comparison_results.json'), 'w'), indent=2)
print(f"\nSaved to paired_comparison_results.json")
