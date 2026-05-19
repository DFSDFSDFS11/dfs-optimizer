"""
Re-run IC analysis but for TOP-1% finishing (binary), not full finishing percentile.
Most GPP equity sits in top-1%; full-percentile IC may diverge from top-1% IC.
"""
import os, sys, numpy as np, pandas as pd
from scipy.stats import spearmanr, pointbiserialr
LIVE_AUDIT = "C:/Users/colin/Projects/dfs-optimizer/live_audit"

fdf = pd.read_csv(os.path.join(LIVE_AUDIT, 'factor_frame.csv'))
factor_cols = [c for c in fdf.columns if c not in ('contest_id', 'slate', 'rank', 'finish_pct')]
fdf['is_top1'] = (fdf['finish_pct'] >= 0.99).astype(int)
fdf['is_top01'] = (fdf['finish_pct'] >= 0.999).astype(int)

for target_col, label in [('is_top1', 'TOP-1%'), ('is_top01', 'TOP-0.1%')]:
    print(f"\n=== IC for {label} BINARY OUTCOME ===")
    summary = []
    for f in factor_cols:
        ics = []
        for cid in fdf['contest_id'].unique():
            sub = fdf[fdf['contest_id'] == cid]
            if len(sub) < 100: continue
            if sub[target_col].sum() < 2: continue  # need at least 2 positive cases
            vals = sub[f].values
            if np.std(vals) < 1e-9: continue
            try:
                ic, _ = pointbiserialr(sub[target_col].values, vals)
                if not np.isnan(ic): ics.append(ic)
            except Exception: continue
        if not ics: continue
        summary.append({
            'factor': f,
            'mean_ic': np.mean(ics),
            'std_ic': np.std(ics),
            'sign_stable_pct': np.mean(np.sign(ics) == np.sign(np.mean(ics))) if abs(np.mean(ics)) > 0.001 else 0,
            'n_contests': len(ics),
        })
    sdf = pd.DataFrame(summary).sort_values('mean_ic', key=lambda x: x.abs(), ascending=False)
    sdf['abs_mean_ic'] = sdf['mean_ic'].abs()
    sdf.to_csv(os.path.join(LIVE_AUDIT, f'ic_{target_col}.csv'), index=False)
    print(f"{'factor':<28} {'mean_IC':>9} {'std_IC':>8} {'sign%':>7} {'n':>4}")
    print('-' * 65)
    for _, r in sdf.head(20).iterrows():
        print(f"{r['factor']:<28} {r['mean_ic']:>9.4f} {r['std_ic']:>8.4f} {r['sign_stable_pct']*100:>6.1f}% {r['n_contests']:>4}")
