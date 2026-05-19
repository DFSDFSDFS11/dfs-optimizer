"""Leave-one-slate-out analysis: does BB25 beat BB17 EVERY way we remove one slate?
If BB25 only wins when 4-25-early is kept, it's overfit. If it wins on most LOO permutations, robust.
"""
import json, os
LIVE_AUDIT = "C:/Users/colin/Projects/dfs-optimizer/live_audit"
DFSOPTO = "C:/Users/colin/dfs opto"

data = json.load(open(os.path.join(DFSOPTO, 'methods_multi_results.json')))
rows = data['rows']
variants = [v['name'] for v in data['variants']]

def agg_roi(rows_, v):
    c = sum(r['variants'][v]['cost'] for r in rows_)
    p = sum(r['variants'][v]['payout'] for r in rows_)
    return (p/c - 1) * 100 if c > 0 else 0

# Full sample
print(f"=== Full sample ROI ===")
for v in variants:
    print(f"  {v}: {agg_roi(rows, v):.2f}%")

# LOO: remove each slate, see how BB25 vs BB17 differ
print(f"\n=== LOO BB25 vs BB17 advantage (BB25 - BB17) ===")
print(f"{'slate removed':<18} {'BB17':>8} {'BB25':>8} {'BB25-BB17':>11}")
deltas = []
for i, r in enumerate(rows):
    loo = rows[:i] + rows[i+1:]
    b17 = agg_roi(loo, 'BB17')
    b25 = agg_roi(loo, 'BB25')
    delta = b25 - b17
    deltas.append((r['slate'], b17, b25, delta))
    print(f"{r['slate']:<18} {b17:>7.2f}% {b25:>7.2f}% {delta:>+10.2f}pp")

print(f"\n=== LOO sensitivity sorted (most impact on BB25 advantage when removed) ===")
deltas.sort(key=lambda x: x[3])
for slate, b17, b25, delta in deltas[:5]:
    print(f"REMOVE {slate}: BB25 wins by {delta:.2f}pp (LOWEST advantage)")
for slate, b17, b25, delta in deltas[-5:]:
    print(f"REMOVE {slate}: BB25 wins by {delta:.2f}pp (HIGHEST advantage)")

print(f"\n=== BB25 wins LOO in {sum(1 for s,b17,b25,d in deltas if d > 0)}/{len(deltas)} permutations ===")

# Also: BB25 vs Atlas
print(f"\n=== BB25 vs Atlas (BB25 - Atlas) ===")
print(f"{'slate removed':<18} {'Atlas':>8} {'BB25':>8} {'BB25-Atlas':>11}")
deltas2 = []
for i, r in enumerate(rows):
    loo = rows[:i] + rows[i+1:]
    a = agg_roi(loo, 'Atlas')
    b = agg_roi(loo, 'BB25')
    delta = b - a
    deltas2.append((r['slate'], a, b, delta))
deltas2.sort(key=lambda x: x[3])
print("Lowest BB25 advantage when removed:")
for slate, a, b25, delta in deltas2[:5]:
    print(f"  REMOVE {slate}: Atlas {a:.0f}%, BB25 {b25:.0f}%, BB25 wins by {delta:.2f}pp")
print("Highest:")
for slate, a, b25, delta in deltas2[-5:]:
    print(f"  REMOVE {slate}: Atlas {a:.0f}%, BB25 {b25:.0f}%, BB25 wins by {delta:.2f}pp")
print(f"\nBB25 beats Atlas in {sum(1 for s,a,b,d in deltas2 if d > 0)}/{len(deltas2)} LOO permutations")
