"""
Test if a 50/50 BB25 + v5 ensemble outperforms either alone.

Per-slate ROI is taken from each backtest. The ensemble allocates half the entry
fee to BB25 and half to v5 (same number of slates), so its payout = 0.5*BB25 + 0.5*v5
and its cost = same total.

This is the "do BB25 and v5 catch DIFFERENT lotteries" question.
"""
import json, os
LIVE_AUDIT = "C:/Users/colin/Projects/dfs-optimizer/live_audit"
DFSOPTO = "C:/Users/colin/dfs opto"

mm = json.load(open(os.path.join(DFSOPTO, 'methods_multi_results.json')))
loo = json.load(open(os.path.join(LIVE_AUDIT, 'loo_retrain_results.json')))['rows']
mm_by_slate = {r['slate']: r['variants'] for r in mm['rows']}
loo_by_slate = {r['slate']: r for r in loo}
slates = sorted(set(mm_by_slate.keys()) & set(loo_by_slate.keys()))

# Ensemble payout = 0.5*(BB25 payout) + 0.5*(v5 payout); cost = (BB25 cost + v5 cost) / 2
results = []
for s in slates:
    b = mm_by_slate[s]['BB25']
    v = loo_by_slate[s]['v5']
    a = mm_by_slate[s]['Atlas']
    v4 = loo_by_slate[s]['v4']
    ens_50bb_50v5 = {
        'cost': 0.5*b['cost'] + 0.5*v['cost'],
        'payout': 0.5*b['payout'] + 0.5*v['payout'],
        'top1': b['top1'] + v['top1'],  # entries placed in top-1% in either pool
    }
    ens_50bb_50v5['roi'] = (ens_50bb_50v5['payout']/ens_50bb_50v5['cost'] - 1) * 100
    ens_70bb_30v5 = {
        'cost': 0.7*b['cost'] + 0.3*v['cost'],
        'payout': 0.7*b['payout'] + 0.3*v['payout'],
    }
    ens_70bb_30v5['roi'] = (ens_70bb_30v5['payout']/ens_70bb_30v5['cost'] - 1) * 100
    ens_50atlas_50v5 = {
        'cost': 0.5*a['cost'] + 0.5*v['cost'],
        'payout': 0.5*a['payout'] + 0.5*v['payout'],
    }
    ens_50atlas_50v5['roi'] = (ens_50atlas_50v5['payout']/ens_50atlas_50v5['cost'] - 1) * 100
    results.append({'slate': s, 'BB25': b, 'v5': v, 'Atlas': a, 'v4': v4,
                    '50/50_BB+v5': ens_50bb_50v5, '70/30_BB+v5': ens_70bb_30v5,
                    '50/50_Atlas+v5': ens_50atlas_50v5})

def agg(rows, key):
    cost = sum(r[key]['cost'] for r in rows)
    pay = sum(r[key]['payout'] for r in rows)
    prof = sum(1 for r in rows if r[key]['roi'] > 0)
    return (pay/cost - 1)*100 if cost > 0 else 0, prof, pay - cost

print(f"{'='*72}")
print(f"ENSEMBLE TEST: do BB25 and v5 catch different lotteries?")
print(f"{'='*72}")
print(f"{'Method':<22} {'ROI':>10} {'NET':>12} {'Profitable':>12}")
print('-'*72)
for k in ['Atlas','BB25','v4','v5','50/50_BB+v5','70/30_BB+v5','50/50_Atlas+v5']:
    r, p, n = agg(results, k)
    print(f"  {k:<20} {r:>+9.2f}% ${n:>+10.0f} {p:>4}/{len(results):<3}")

# Per-slate
print(f"\n{'='*72}")
print(f"PER-SLATE ENSEMBLE DETAIL (50/50 BB25 + v5)")
print(f"{'='*72}")
print(f"{'slate':<22} {'BB25':>10} {'v5':>10} {'50/50':>10} {'better':>8}")
for r in results:
    b = r['BB25']['roi']; v = r['v5']['roi']; e = r['50/50_BB+v5']['roi']
    bb = 'ensemble' if e > max(b, v) else ('BB25' if b > v else 'v5')
    print(f"  {r['slate']:<20} {b:>+9.1f}% {v:>+9.1f}% {e:>+9.1f}%  {bb:>8}")

# Save
json.dump({'rows': results, 'aggregates': {
    'Atlas': agg(results,'Atlas')[0],
    'BB25':  agg(results,'BB25')[0],
    'v4':    agg(results,'v4')[0],
    'v5':    agg(results,'v5')[0],
    'BB+v5_50/50': agg(results,'50/50_BB+v5')[0],
    'BB+v5_70/30': agg(results,'70/30_BB+v5')[0],
    'Atlas+v5_50/50': agg(results,'50/50_Atlas+v5')[0],
}}, open(os.path.join(LIVE_AUDIT,'ensemble_results.json'),'w'), indent=2)
