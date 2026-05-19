"""
v5 bias diagnostics:
  (1) Per-slate ROI distribution + concentration (Gini, top-3 share)
  (2) Drop top-K lottery slates -> remaining ROI
  (3) Compare v5 vs v4 robustness (LOO-style: drop each slate, re-aggregate)

Reads v5_backtest_results.json (already computed) — no retraining required for (1)-(3).
A real retrain LOO is in a separate script (v5_loo_retrain.py).
"""
import json, os, sys
import numpy as np
from collections import defaultdict

LIVE_AUDIT = "C:/Users/colin/Projects/dfs-optimizer/live_audit"
res = json.load(open(os.path.join(LIVE_AUDIT, 'v5_backtest_results.json')))['rows']

def agg(rows, key):
    cost = sum(r[key]['cost'] for r in rows)
    pay  = sum(r[key]['payout'] for r in rows)
    return (pay/cost - 1)*100 if cost > 0 else 0.0

def slate_roi(r, key):
    c = r[key]['cost']; p = r[key]['payout']
    return (p/c - 1)*100 if c > 0 else 0.0

def slate_net(r, key):
    return r[key]['payout'] - r[key]['cost']

print("="*70)
print("v5 BIAS DIAGNOSTICS")
print("="*70)
print(f"Slates: {len(res)}")

# (1) Concentration
v5_nets = sorted([(r['slate'], slate_net(r,'v5'), slate_roi(r,'v5')) for r in res], key=lambda x: -x[1])
v4_nets = sorted([(r['slate'], slate_net(r,'v4'), slate_roi(r,'v4')) for r in res], key=lambda x: -x[1])

print(f"\n--- TOP 5 v5 slates by net ---")
for s, n, roi in v5_nets[:5]:
    print(f"  {s:<20} net=${n:>9.0f}  ROI={roi:>+8.1f}%")
print(f"\n--- BOTTOM 5 v5 slates by net ---")
for s, n, roi in v5_nets[-5:]:
    print(f"  {s:<20} net=${n:>9.0f}  ROI={roi:>+8.1f}%")

total_net_v5 = sum(n for _, n, _ in v5_nets)
total_net_v4 = sum(n for _, n, _ in v4_nets)
total_cost_v5 = sum(r['v5']['cost'] for r in res)
total_cost_v4 = sum(r['v4']['cost'] for r in res)
print(f"\nTotal v5 net: ${total_net_v5:.0f}  cost ${total_cost_v5:.0f}  ROI {total_net_v5/total_cost_v5*100:+.2f}%")
print(f"Total v4 net: ${total_net_v4:.0f}  cost ${total_cost_v4:.0f}  ROI {total_net_v4/total_cost_v4*100:+.2f}%")

# (2) Drop top-K lottery
print(f"\n--- DROP-TOP-K LOTTERY (v5 vs v4 robustness) ---")
print(f"{'K':>3} {'v5_ROI':>10} {'v4_ROI':>10} {'v5_share':>10} {'v4_share':>10}")
for K in [0, 1, 2, 3, 5, 7, 10]:
    drop_v5 = set(s for s, _, _ in v5_nets[:K])
    drop_v4 = set(s for s, _, _ in v4_nets[:K])
    keep_v5 = [r for r in res if r['slate'] not in drop_v5]
    keep_v4 = [r for r in res if r['slate'] not in drop_v4]
    v5_roi = agg(keep_v5, 'v5')
    v4_roi = agg(keep_v4, 'v4')
    # share = how much of total ROI came from dropped slates
    v5_share = sum(n for s, n, _ in v5_nets[:K]) / total_net_v5 * 100 if total_net_v5 else 0
    v4_share = sum(n for s, n, _ in v4_nets[:K]) / total_net_v4 * 100 if total_net_v4 else 0
    print(f"{K:>3} {v5_roi:>+9.2f}% {v4_roi:>+9.2f}% {v5_share:>+9.1f}% {v4_share:>+9.1f}%")

# (3) LOO worst-drop
print(f"\n--- LEAVE-ONE-SLATE-OUT (no retrain — just drop) ---")
v5_loo = []
v4_loo = []
for r in res:
    others = [x for x in res if x['slate'] != r['slate']]
    v5_loo.append((r['slate'], agg(others, 'v5')))
    v4_loo.append((r['slate'], agg(others, 'v4')))
v5_min = min(v5_loo, key=lambda x: x[1])
v5_max = max(v5_loo, key=lambda x: x[1])
v4_min = min(v4_loo, key=lambda x: x[1])
v4_max = max(v4_loo, key=lambda x: x[1])
print(f"v5 LOO range: min={v5_min[1]:+.2f}% (drop {v5_min[0]})  max={v5_max[1]:+.2f}% (drop {v5_max[0]})")
print(f"v4 LOO range: min={v4_min[1]:+.2f}% (drop {v4_min[0]})  max={v4_max[1]:+.2f}% (drop {v4_max[0]})")
v5_med = float(np.median([x[1] for x in v5_loo]))
v4_med = float(np.median([x[1] for x in v4_loo]))
print(f"v5 LOO median: {v5_med:+.2f}%   v4 LOO median: {v4_med:+.2f}%")

# (4) Sanity: hit/miss alignment
agree = sum(1 for r in res if (r['v5']['roi']>0)==(r['v4']['roi']>0))
v5_only = sum(1 for r in res if r['v5']['roi']>0 and r['v4']['roi']<=0)
v4_only = sum(1 for r in res if r['v4']['roi']>0 and r['v5']['roi']<=0)
print(f"\nHit/miss agreement: {agree}/{len(res)} slates agree on sign")
print(f"  v5 wins where v4 loses: {v5_only}")
print(f"  v4 wins where v5 loses: {v4_only}")
