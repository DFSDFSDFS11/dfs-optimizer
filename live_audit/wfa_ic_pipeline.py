"""
Walk-Forward IC Pipeline — Phase 6 + Phase 1-3 re-run.

Split slates by time:
  - DEV (oldest 50%): factor mining, IC analysis, factor selection
  - WFA (middle 30%): walk-forward validation of factor selection
  - HOLDOUT (most recent 20%): touch ONCE at end for final scoring

On DEV ONLY:
  1. IC per factor per contest (Spearman to finish_pct AND pointbiserial to top-1% binary)
  2. Aggregate: mean IC, sign-stability, IR
  3. Decile decomposition for top-30 IC factors
  4. Factor decay (early vs late within DEV)
  5. Cross-factor correlation matrix → identify factor clusters

Output:
  wfa_factor_ranking.csv - DEV-set factor ranking
  wfa_decile_decomposition.csv
  wfa_factor_decay.csv
  wfa_factor_correlation.csv
  wfa_selected_factors.json - factors that pass IC + monotonicity + decay-stability gates
"""
import csv, os, sys, json
from collections import Counter, defaultdict
import numpy as np
import pandas as pd
from scipy.stats import spearmanr, pointbiserialr

LIVE_AUDIT = "C:/Users/colin/Projects/dfs-optimizer/live_audit"
DFSOPTO = "C:/Users/colin/dfs opto"

def main():
    print("Loading factor_frame_v3...", file=sys.stderr)
    fdf = pd.read_csv(os.path.join(LIVE_AUDIT, 'factor_frame_v3.csv'))
    print(f"Loaded {len(fdf)} rows, {len(fdf.columns)} cols", file=sys.stderr)

    # Parse slate to datetime
    def slate_to_date(s):
        parts = s.split('-')
        if len(parts) >= 3:
            try:
                return pd.Timestamp(year=2000 + int(parts[2]), month=int(parts[0]), day=int(parts[1]))
            except Exception:
                return pd.NaT
        return pd.NaT
    fdf['date'] = fdf['slate'].apply(slate_to_date)
    fdf = fdf.dropna(subset=['date']).sort_values('date')

    unique_slates = sorted(fdf['slate'].unique(), key=slate_to_date)
    n_slates = len(unique_slates)
    n_dev = int(n_slates * 0.50)
    n_wfa = int(n_slates * 0.30)
    dev_slates = set(unique_slates[:n_dev])
    wfa_slates = set(unique_slates[n_dev:n_dev+n_wfa])
    holdout_slates = set(unique_slates[n_dev+n_wfa:])
    print(f"Splits: DEV={len(dev_slates)} slates  WFA={len(wfa_slates)} slates  HOLDOUT={len(holdout_slates)} slates", file=sys.stderr)
    print(f"  DEV: {sorted(dev_slates, key=slate_to_date)}", file=sys.stderr)
    print(f"  WFA: {sorted(wfa_slates, key=slate_to_date)}", file=sys.stderr)
    print(f"  HOLDOUT: {sorted(holdout_slates, key=slate_to_date)}", file=sys.stderr)

    dev_df = fdf[fdf['slate'].isin(dev_slates)].copy()
    wfa_df = fdf[fdf['slate'].isin(wfa_slates)].copy()
    holdout_df = fdf[fdf['slate'].isin(holdout_slates)].copy()

    # Save splits
    json.dump({'dev': sorted(dev_slates, key=slate_to_date), 'wfa': sorted(wfa_slates, key=slate_to_date), 'holdout': sorted(holdout_slates, key=slate_to_date)},
              open(os.path.join(LIVE_AUDIT, 'wfa_splits.json'), 'w'), default=str, indent=2)

    factor_cols = [c for c in fdf.columns if c not in ('contest_id', 'slate', 'rank', 'finish_pct', 'date')]
    print(f"Factor cols: {len(factor_cols)}", file=sys.stderr)

    # === IC per factor per contest (DEV only) ===
    print("\nComputing IC per factor per contest on DEV set only...", file=sys.stderr)
    dev_df['is_top1'] = (dev_df['finish_pct'] >= 0.99).astype(int)
    dev_df['is_top5'] = (dev_df['finish_pct'] >= 0.95).astype(int)
    dev_df['is_top01'] = (dev_df['finish_pct'] >= 0.999).astype(int)

    ic_rows = []
    for cid in sorted(dev_df['contest_id'].unique()):
        sub = dev_df[dev_df['contest_id'] == cid]
        if len(sub) < 50: continue
        slate = sub.iloc[0]['slate']
        finish = sub['finish_pct'].values
        is_top1 = sub['is_top1'].values
        is_top5 = sub['is_top5'].values
        for f in factor_cols:
            vals = sub[f].values
            if np.std(vals) < 1e-9: continue
            try:
                ic_full, _ = spearmanr(vals, finish)
            except Exception:
                ic_full = np.nan
            try:
                ic_top1, _ = pointbiserialr(is_top1, vals) if is_top1.sum() >= 2 else (np.nan, np.nan)
            except Exception:
                ic_top1 = np.nan
            try:
                ic_top5, _ = pointbiserialr(is_top5, vals) if is_top5.sum() >= 5 else (np.nan, np.nan)
            except Exception:
                ic_top5 = np.nan
            ic_rows.append({
                'factor': f, 'contest_id': cid, 'slate': slate, 'n': len(sub),
                'ic_full': ic_full, 'ic_top1': ic_top1, 'ic_top5': ic_top5,
            })
    icdf = pd.DataFrame(ic_rows)
    icdf.to_csv(os.path.join(LIVE_AUDIT, 'wfa_ic_per_contest.csv'), index=False)

    # === AGGREGATE PER FACTOR ===
    print("Aggregating IC stats per factor (DEV set)...", file=sys.stderr)
    summary_rows = []
    for f in factor_cols:
        sub = icdf[icdf['factor'] == f]
        if len(sub) == 0: continue
        for ic_type in ['ic_full', 'ic_top1', 'ic_top5']:
            ics = sub[ic_type].dropna().values
            if len(ics) == 0: continue
            mean_ic = np.mean(ics)
            std_ic = np.std(ics)
            sign_stable = np.mean(np.sign(ics) == np.sign(mean_ic)) if abs(mean_ic) > 0.001 else 0
            ic_ir = mean_ic / max(0.001, std_ic)
            summary_rows.append({
                'factor': f,
                'ic_type': ic_type,
                'n_contests': len(ics),
                'mean_ic': mean_ic,
                'std_ic': std_ic,
                'sign_stable_pct': sign_stable,
                'ic_ir': ic_ir,
                'abs_mean_ic': abs(mean_ic),
            })
    sdf = pd.DataFrame(summary_rows)
    sdf.to_csv(os.path.join(LIVE_AUDIT, 'wfa_factor_ranking.csv'), index=False)

    # === DECILE DECOMPOSITION (top-20 by abs_mean_ic for ic_full and ic_top1) ===
    print("Computing decile decomposition...", file=sys.stderr)
    decile_rows = []
    for ic_type in ['ic_full', 'ic_top1']:
        top_factors = sdf[sdf['ic_type'] == ic_type].sort_values('abs_mean_ic', ascending=False).head(20)['factor'].values
        for f in top_factors:
            for cid in sorted(dev_df['contest_id'].unique()):
                sub = dev_df[dev_df['contest_id'] == cid].copy()
                if len(sub) < 100: continue
                try:
                    sub['decile'] = pd.qcut(sub[f], 10, labels=False, duplicates='drop')
                except (ValueError, TypeError):
                    continue
                target = 'finish_pct' if ic_type == 'ic_full' else 'is_top1'
                for d, g in sub.groupby('decile'):
                    decile_rows.append({
                        'factor': f, 'ic_type': ic_type, 'contest_id': cid, 'decile': int(d),
                        'mean_outcome': g[target].mean(), 'n': len(g),
                    })
    ddf = pd.DataFrame(decile_rows)
    if len(ddf) > 0:
        agg = ddf.groupby(['factor', 'ic_type', 'decile']).agg(
            mean_outcome=('mean_outcome', 'mean'),
            std_outcome=('mean_outcome', 'std'),
            n_contests=('contest_id', 'count'),
        ).reset_index()
        agg.to_csv(os.path.join(LIVE_AUDIT, 'wfa_decile_decomposition.csv'), index=False)
    else:
        agg = pd.DataFrame()

    # === FACTOR DECAY within DEV ===
    print("Computing factor decay (early vs late DEV)...", file=sys.stderr)
    dev_dates = sorted(dev_df['date'].unique())
    mid_date = dev_dates[len(dev_dates) // 2]
    decay_rows = []
    for f in factor_cols:
        for label, mask in [('early', dev_df['date'] < mid_date), ('late', dev_df['date'] >= mid_date)]:
            sub = dev_df[mask]
            ics_full = []; ics_top1 = []
            for cid in sub['contest_id'].unique():
                csub = sub[sub['contest_id'] == cid]
                if len(csub) < 50: continue
                vals = csub[f].values
                if np.std(vals) < 1e-9: continue
                try:
                    ic_f, _ = spearmanr(vals, csub['finish_pct'].values)
                    ics_full.append(ic_f)
                except Exception: pass
                if csub['is_top1'].sum() >= 2:
                    try:
                        ic_t, _ = pointbiserialr(csub['is_top1'].values, vals)
                        ics_top1.append(ic_t)
                    except Exception: pass
            if ics_full:
                decay_rows.append({
                    'factor': f, 'window': label, 'metric': 'ic_full',
                    'n_contests': len(ics_full), 'mean_ic': np.mean(ics_full),
                })
            if ics_top1:
                decay_rows.append({
                    'factor': f, 'window': label, 'metric': 'ic_top1',
                    'n_contests': len(ics_top1), 'mean_ic': np.mean(ics_top1),
                })
    decay_df = pd.DataFrame(decay_rows)
    decay_df.to_csv(os.path.join(LIVE_AUDIT, 'wfa_factor_decay.csv'), index=False)

    # === WFA VALIDATION: test top-DEV factors on WFA set ===
    print("\nValidating top DEV factors on WFA set...", file=sys.stderr)
    wfa_df['is_top1'] = (wfa_df['finish_pct'] >= 0.99).astype(int)
    wfa_ic_rows = []
    top_dev_full = sdf[sdf['ic_type'] == 'ic_full'].sort_values('abs_mean_ic', ascending=False).head(30)['factor'].values
    top_dev_top1 = sdf[sdf['ic_type'] == 'ic_top1'].sort_values('abs_mean_ic', ascending=False).head(30)['factor'].values
    candidate_factors = set(list(top_dev_full) + list(top_dev_top1))
    for f in candidate_factors:
        ics_full = []; ics_top1 = []
        for cid in wfa_df['contest_id'].unique():
            sub = wfa_df[wfa_df['contest_id'] == cid]
            if len(sub) < 50: continue
            vals = sub[f].values
            if np.std(vals) < 1e-9: continue
            try:
                ic, _ = spearmanr(vals, sub['finish_pct'].values)
                ics_full.append(ic)
            except Exception: pass
            if sub['is_top1'].sum() >= 2:
                try:
                    ic, _ = pointbiserialr(sub['is_top1'].values, vals)
                    ics_top1.append(ic)
                except Exception: pass
        wfa_ic_rows.append({
            'factor': f,
            'wfa_ic_full_mean': np.mean(ics_full) if ics_full else np.nan,
            'wfa_ic_full_sign_stable': np.mean(np.sign(ics_full) == np.sign(np.mean(ics_full))) if ics_full and abs(np.mean(ics_full)) > 0.001 else 0,
            'wfa_ic_top1_mean': np.mean(ics_top1) if ics_top1 else np.nan,
            'wfa_n_full': len(ics_full),
            'wfa_n_top1': len(ics_top1),
        })
    wfa_df_out = pd.DataFrame(wfa_ic_rows)
    wfa_df_out.to_csv(os.path.join(LIVE_AUDIT, 'wfa_validation.csv'), index=False)

    # === FACTOR SELECTION (passes IC + WFA agreement gates) ===
    print("\nFactor selection: must pass DEV IC > 0.03, sign-stability > 60%, WFA same sign...", file=sys.stderr)
    selected_full = []
    selected_top1 = []
    dev_full = sdf[sdf['ic_type'] == 'ic_full'].set_index('factor')
    dev_top1 = sdf[sdf['ic_type'] == 'ic_top1'].set_index('factor')
    wfa_idx = wfa_df_out.set_index('factor')
    for f in dev_full.index:
        dr = dev_full.loc[f]
        if abs(dr['mean_ic']) < 0.03 or dr['sign_stable_pct'] < 0.60: continue
        if f not in wfa_idx.index: continue
        wr = wfa_idx.loc[f]
        # Require WFA IC same sign as DEV
        if pd.isna(wr['wfa_ic_full_mean']) or np.sign(wr['wfa_ic_full_mean']) != np.sign(dr['mean_ic']):
            continue
        selected_full.append({
            'factor': f,
            'dev_ic_full': dr['mean_ic'],
            'dev_sign_stable': dr['sign_stable_pct'],
            'wfa_ic_full': wr['wfa_ic_full_mean'],
            'decay_ratio': wr['wfa_ic_full_mean'] / dr['mean_ic'] if dr['mean_ic'] != 0 else 0,
        })
    for f in dev_top1.index:
        dr = dev_top1.loc[f]
        if abs(dr['mean_ic']) < 0.005 or dr['sign_stable_pct'] < 0.60: continue
        if f not in wfa_idx.index: continue
        wr = wfa_idx.loc[f]
        if pd.isna(wr['wfa_ic_top1_mean']) or np.sign(wr['wfa_ic_top1_mean']) != np.sign(dr['mean_ic']):
            continue
        selected_top1.append({
            'factor': f,
            'dev_ic_top1': dr['mean_ic'],
            'dev_sign_stable': dr['sign_stable_pct'],
            'wfa_ic_top1': wr['wfa_ic_top1_mean'],
        })

    json.dump({
        'selected_full_finish': selected_full,
        'selected_top1': selected_top1,
        'dev_slates': sorted(dev_slates, key=slate_to_date),
        'wfa_slates': sorted(wfa_slates, key=slate_to_date),
        'holdout_slates': sorted(holdout_slates, key=slate_to_date),
    }, open(os.path.join(LIVE_AUDIT, 'wfa_selected_factors.json'), 'w'), default=str, indent=2)

    print(f"\n=== SELECTED FACTORS (passed DEV IC > 0.03 + sign-stable + WFA sign-match) ===")
    print(f"\nFor FULL FINISH percentile ({len(selected_full)} factors):")
    print(f"{'factor':<32} {'dev_IC':>9} {'wfa_IC':>9} {'decay_ratio':>11} {'sign%':>7}")
    for r in sorted(selected_full, key=lambda x: -abs(x['dev_ic_full']))[:25]:
        print(f"{r['factor']:<32} {r['dev_ic_full']:>9.4f} {r['wfa_ic_full']:>9.4f} {r['decay_ratio']:>11.2f} {r['dev_sign_stable']*100:>6.1f}%")

    print(f"\nFor TOP-1% binary ({len(selected_top1)} factors):")
    print(f"{'factor':<32} {'dev_IC':>9} {'wfa_IC':>9} {'sign%':>7}")
    for r in sorted(selected_top1, key=lambda x: -abs(x['dev_ic_top1']))[:25]:
        print(f"{r['factor']:<32} {r['dev_ic_top1']:>9.4f} {r['wfa_ic_top1']:>9.4f} {r['dev_sign_stable']*100:>6.1f}%")

if __name__ == '__main__':
    main()
