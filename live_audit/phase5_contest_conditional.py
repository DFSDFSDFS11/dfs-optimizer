"""
Phase 5: Contest-conditional IC + ensemble weights.

For each contest size bucket (small <5k, medium 5k-20k, large 20k+):
  - Compute IC per factor restricted to that bucket
  - Identify which factors have positive IC in that bucket only
  - Output per-bucket ensemble weight recommendation

This enables building DIFFERENT portfolios per contest type (Method 8 node-locking).
"""
import csv, os, sys, json
import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from collections import defaultdict

LIVE_AUDIT = "C:/Users/colin/Projects/dfs-optimizer/live_audit"

def main():
    fdf = pd.read_csv(os.path.join(LIVE_AUDIT, 'factor_frame_v4.csv'))
    info = json.load(open(os.path.join(LIVE_AUDIT, 'contests_info.json')))
    info_map = {x['contest_id']: x for x in info}
    fdf['n_entries'] = fdf['contest_id'].astype(str).map(lambda c: info_map.get(c, {}).get('n_entries', 0))
    fdf['size_bucket'] = pd.cut(fdf['n_entries'], bins=[0, 5000, 20000, 100000], labels=['small', 'medium', 'large'])

    # Restrict to DEV+WFA (not HOLDOUT)
    splits = json.load(open(os.path.join(LIVE_AUDIT, 'wfa_splits.json')))
    devwfa = set(splits['dev'] + splits['wfa'])
    fdf = fdf[fdf['slate'].isin(devwfa)].copy()

    selected = json.load(open(os.path.join(LIVE_AUDIT, 'pipeline_selected_factors.json')))
    factors = [f['factor'] for f in selected['final_factors']][:20]
    print(f"Computing per-bucket IC for {len(factors)} factors", file=sys.stderr)

    per_bucket = {}
    for bucket in ['small', 'medium', 'large']:
        sub_all = fdf[fdf['size_bucket'] == bucket]
        if len(sub_all) == 0: continue
        ics_per_factor = defaultdict(list)
        for cid in sub_all['contest_id'].unique():
            sub = sub_all[sub_all['contest_id'] == cid]
            if len(sub) < 50: continue
            for f in factors:
                vals = sub[f].values
                if np.std(vals) < 1e-9: continue
                try:
                    ic, _ = spearmanr(vals, sub['finish_pct'].values)
                    if not np.isnan(ic): ics_per_factor[f].append(ic)
                except Exception: pass
        per_bucket[bucket] = {f: {'mean_ic': float(np.mean(v)), 'n': len(v)} for f, v in ics_per_factor.items()}

    # Print comparison
    print(f"\n=== PER-BUCKET IC for selected factors ===")
    print(f"{'factor':<35} {'small':>10} {'medium':>10} {'large':>10}")
    for f in factors:
        s = per_bucket.get('small', {}).get(f, {}).get('mean_ic', None)
        m = per_bucket.get('medium', {}).get(f, {}).get('mean_ic', None)
        l = per_bucket.get('large', {}).get(f, {}).get('mean_ic', None)
        s_str = f"{s:.4f}" if s is not None else "—"
        m_str = f"{m:.4f}" if m is not None else "—"
        l_str = f"{l:.4f}" if l is not None else "—"
        print(f"{f:<35} {s_str:>10} {m_str:>10} {l_str:>10}")

    json.dump(per_bucket, open(os.path.join(LIVE_AUDIT, 'phase5_contest_conditional_ic.json'), 'w'), indent=2, default=str)
    print(f"\nSaved phase5_contest_conditional_ic.json", file=sys.stderr)

if __name__ == '__main__':
    main()
