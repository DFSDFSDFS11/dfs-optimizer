"""
Method 8: Contest-conditional selection — node-locking by contest type.

Hypothesis: small contests have different field behavior than large contests.
  - Small contests: less sharp field → optimal lineup may win more often
  - Large contests: sharper field → more uniqueness/leverage needed

For each contest, classify:
  - SMALL: entries < 5000
  - MEDIUM: 5000 ≤ entries < 20000
  - LARGE: 20000+

Per group, run IC analysis on factors. Compare top-ranked factors between groups.
If factors differ significantly between groups → contest-conditional selection has value.
"""
import csv, os, sys, json
import numpy as np
import pandas as pd
from scipy.stats import spearmanr, pointbiserialr
from collections import defaultdict

LIVE_AUDIT = "C:/Users/colin/Projects/dfs-optimizer/live_audit"

def main():
    fdf = pd.read_csv(os.path.join(LIVE_AUDIT, 'factor_frame_v3.csv'))
    info = json.load(open(os.path.join(LIVE_AUDIT, 'contests_info.json')))
    info_map = {x['contest_id']: x for x in info}

    # Tag each factor row with contest size bucket
    fdf['n_entries'] = fdf['contest_id'].map(lambda c: info_map.get(int(c) if str(c).isdigit() else c, {}).get('n_entries', 0))
    # Actually contest_id stored as int in factor frame
    def get_size(c):
        rec = info_map.get(str(c))
        return rec['n_entries'] if rec else 0
    fdf['n_entries'] = fdf['contest_id'].astype(str).map(lambda c: info_map.get(c, {}).get('n_entries', 0))
    fdf['size_bucket'] = pd.cut(fdf['n_entries'], bins=[0, 5000, 20000, 100000], labels=['small', 'medium', 'large'])
    print(f"Bucket distribution by lineups:")
    print(fdf['size_bucket'].value_counts())
    print(f"\nBucket distribution by contests:")
    print(fdf.groupby('size_bucket', observed=False)['contest_id'].nunique())

    fdf['is_top1'] = (fdf['finish_pct'] >= 0.99).astype(int)
    factor_cols = [c for c in fdf.columns if c not in ('contest_id', 'slate', 'rank', 'finish_pct', 'date', 'n_entries', 'size_bucket', 'is_top1')]

    # Per-bucket IC
    results = {}
    for bucket in ['small', 'medium', 'large']:
        sub_all = fdf[fdf['size_bucket'] == bucket]
        if len(sub_all) == 0: continue
        ic_rows = []
        for cid in sorted(sub_all['contest_id'].unique()):
            sub = sub_all[sub_all['contest_id'] == cid]
            if len(sub) < 50: continue
            for f in factor_cols:
                vals = sub[f].values
                if np.std(vals) < 1e-9: continue
                try:
                    ic, _ = spearmanr(vals, sub['finish_pct'].values)
                    ic_rows.append({'factor': f, 'contest_id': cid, 'ic_full': ic, 'ic_top1': np.nan})
                except Exception: pass
                if sub['is_top1'].sum() >= 2:
                    try:
                        ic, _ = pointbiserialr(sub['is_top1'].values, vals)
                        ic_rows[-1]['ic_top1'] = ic
                    except Exception: pass
        ic_df = pd.DataFrame(ic_rows)
        # Aggregate per factor
        agg = ic_df.groupby('factor').agg(
            mean_ic_full=('ic_full', 'mean'),
            mean_ic_top1=('ic_top1', 'mean'),
            n=('contest_id', 'count'),
        ).reset_index()
        results[bucket] = agg
        print(f"\n=== TOP 15 FACTORS for {bucket.upper()} contests (by abs ic_full) ===")
        print(agg.assign(abs_ic=agg['mean_ic_full'].abs()).sort_values('abs_ic', ascending=False).head(15)[['factor', 'mean_ic_full', 'mean_ic_top1', 'n']].to_string(index=False))

    # Side-by-side: how do top-10 factors differ across buckets?
    print(f"\n\n=== TOP-10 FACTOR DIVERGENCE ACROSS BUCKETS (by ic_full) ===")
    cols = ['factor']
    top_by_bucket = {}
    for b, df in results.items():
        top_by_bucket[b] = set(df.assign(abs_ic=df['mean_ic_full'].abs()).sort_values('abs_ic', ascending=False).head(10)['factor'].values)
    if 'small' in top_by_bucket and 'large' in top_by_bucket:
        intersect = top_by_bucket['small'] & top_by_bucket['large']
        only_small = top_by_bucket['small'] - top_by_bucket['large']
        only_large = top_by_bucket['large'] - top_by_bucket['small']
        print(f"Common top-10 (small ∩ large): {sorted(intersect)}")
        print(f"Only in SMALL top-10: {sorted(only_small)}")
        print(f"Only in LARGE top-10: {sorted(only_large)}")

    json.dump({b: df.to_dict('records') for b, df in results.items()}, open(os.path.join(LIVE_AUDIT, 'contest_conditional_ic.json'), 'w'), indent=2, default=str)

if __name__ == '__main__':
    main()
