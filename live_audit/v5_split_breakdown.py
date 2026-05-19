"""
Break v5 vs v4 backtest down by training-data split.

  DEV  = model was TRAINED on these slates           -> in-sample, optimistic
  WFA  = Optuna used these for hyperparameter choice -> mildly optimistic
  HOLD = never touched by training or tuning         -> honest signal
  OTHER = slates in backtest but not in splits       -> ambiguous

If v5's edge over v4 holds on HOLDOUT, it's real.
If v5 only wins on DEV, it's memorization.
"""
import json, os
LIVE_AUDIT = "C:/Users/colin/Projects/dfs-optimizer/live_audit"
res = json.load(open(os.path.join(LIVE_AUDIT,'v5_backtest_results.json')))['rows']
splits = json.load(open(os.path.join(LIVE_AUDIT,'wfa_splits.json')))
DEV = set(splits['dev']); WFA = set(splits['wfa']); HOLD = set(splits['holdout'])

def classify(s):
    if s in DEV: return 'DEV'
    if s in WFA: return 'WFA'
    if s in HOLD: return 'HOLDOUT'
    return 'OTHER'

groups = {'DEV':[], 'WFA':[], 'HOLDOUT':[], 'OTHER':[]}
for r in res:
    groups[classify(r['slate'])].append(r)

def agg(rows, key):
    c = sum(r[key]['cost'] for r in rows)
    p = sum(r[key]['payout'] for r in rows)
    prof = sum(1 for r in rows if r[key]['roi'] > 0)
    t1 = sum(r[key]['top1'] for r in rows)
    return ((p/c-1)*100 if c>0 else 0.0, prof, len(rows), t1)

print(f"{'SPLIT':<10} {'N':>3} {'v5 ROI':>10} {'v4 ROI':>10} {'v5-v4':>8} {'v5 prof':>8} {'v4 prof':>8} {'v5 t1':>6} {'v4 t1':>6}")
print("-"*82)
for g in ['DEV','WFA','HOLDOUT','OTHER']:
    if not groups[g]: continue
    v5_roi, v5_prof, n, v5_t1 = agg(groups[g],'v5')
    v4_roi, v4_prof, _, v4_t1 = agg(groups[g],'v4')
    print(f"{g:<10} {n:>3} {v5_roi:>+9.2f}% {v4_roi:>+9.2f}% {v5_roi-v4_roi:>+7.2f} {v5_prof:>3}/{n:<3}  {v4_prof:>3}/{n:<3}  {v5_t1:>6} {v4_t1:>6}")

print(f"\nGroup membership:")
for g in ['DEV','WFA','HOLDOUT','OTHER']:
    slates = [r['slate'] for r in groups[g]]
    print(f"  {g} ({len(slates)}): {slates}")

# Per-slate detail on HOLDOUT (most important)
print(f"\n=== HOLDOUT slate detail (honest signal) ===")
print(f"{'slate':<20} {'v5_ROI':>10} {'v4_ROI':>10} {'v5_net':>10} {'v4_net':>10}")
for r in groups['HOLDOUT']:
    v5n = r['v5']['payout'] - r['v5']['cost']
    v4n = r['v4']['payout'] - r['v4']['cost']
    print(f"  {r['slate']:<18} {r['v5']['roi']:>+9.1f}% {r['v4']['roi']:>+9.1f}% ${v5n:>+9.0f} ${v4n:>+9.0f}")

# Per-slate detail on DEV (where memorization risk is highest)
print(f"\n=== DEV slate detail (in-sample, memorization risk) ===")
print(f"{'slate':<20} {'v5_ROI':>10} {'v4_ROI':>10}")
for r in sorted(groups['DEV'], key=lambda x: -x['v5']['roi']):
    print(f"  {r['slate']:<18} {r['v5']['roi']:>+9.1f}% {r['v4']['roi']:>+9.1f}%")
