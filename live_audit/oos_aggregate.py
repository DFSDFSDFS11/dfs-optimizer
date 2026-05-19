"""Combined truly-out-of-sample (HOLDOUT + OTHER) ROI for v5 vs v4."""
import json, os
LIVE_AUDIT = "C:/Users/colin/Projects/dfs-optimizer/live_audit"
res = json.load(open(os.path.join(LIVE_AUDIT,'v5_backtest_results.json')))['rows']
splits = json.load(open(os.path.join(LIVE_AUDIT,'wfa_splits.json')))
TRAINED = set(splits['dev']) | set(splits['wfa'])  # both seen by model/tuning

oos = [r for r in res if r['slate'] not in TRAINED]
ins = [r for r in res if r['slate'] in TRAINED]

def agg(rows, key):
    c = sum(r[key]['cost'] for r in rows)
    p = sum(r[key]['payout'] for r in rows)
    prof = sum(1 for r in rows if r[key]['roi'] > 0)
    t1 = sum(r[key]['top1'] for r in rows)
    return (p/c-1)*100 if c>0 else 0.0, prof, t1, p-c

print(f"\n=== TRUE OOS (HOLDOUT + OTHER, n={len(oos)}) vs IN-SAMPLE (DEV + WFA, n={len(ins)}) ===")
print(f"{'BUCKET':<14} {'MODEL':<6} {'ROI':>10} {'NET':>10} {'prof':>6} {'top1':>6}")
print("-"*60)
for label, rows in [('IN-SAMPLE', ins), ('TRUE OOS', oos)]:
    for m in ['v4','v5']:
        roi, prof, t1, net = agg(rows, m)
        print(f"{label:<14} {m:<6} {roi:>+9.2f}% ${net:>+9.0f} {prof:>3}/{len(rows):<3} {t1:>6}")
    print()

# Per-slate OOS detail (sorted by v5 net descending)
print(f"=== Per-slate TRUE OOS detail ===")
print(f"{'slate':<22} {'v5_ROI':>10} {'v4_ROI':>10} {'v5_net':>10} {'v4_net':>10} {'win':>4}")
oos_sorted = sorted(oos, key=lambda r: -(r['v5']['payout']-r['v5']['cost']))
for r in oos_sorted:
    v5n = r['v5']['payout'] - r['v5']['cost']
    v4n = r['v4']['payout'] - r['v4']['cost']
    win = 'v5' if v5n > v4n else 'v4' if v4n > v5n else '='
    print(f"  {r['slate']:<20} {r['v5']['roi']:>+9.1f}% {r['v4']['roi']:>+9.1f}% ${v5n:>+9.0f} ${v4n:>+9.0f}  {win}")

# Concentration on OOS
v5_nets_oos = sorted([(r['slate'], r['v5']['payout']-r['v5']['cost']) for r in oos], key=lambda x: -x[1])
v4_nets_oos = sorted([(r['slate'], r['v4']['payout']-r['v4']['cost']) for r in oos], key=lambda x: -x[1])
total_v5 = sum(n for _,n in v5_nets_oos)
total_v4 = sum(n for _,n in v4_nets_oos)
print(f"\n=== OOS lottery concentration ===")
for K in [1, 2, 3, 5]:
    v5_top = sum(n for _,n in v5_nets_oos[:K])
    v4_top = sum(n for _,n in v4_nets_oos[:K])
    print(f"  Top-{K} share: v5={v5_top/total_v5*100:>+6.1f}% (${v5_top:.0f}/${total_v5:.0f})  v4={v4_top/total_v4*100:>+6.1f}% (${v4_top:.0f}/${total_v4:.0f})")
