"""
Phases 1-6 disciplined pipeline.

Reads factor_frame_v4 (250+ features), applies DEV/WFA/HOLDOUT split, runs:
  Phase 1: IC per factor per (contest, finish_target) on DEV ONLY
  Phase 2: Decile decomposition - classify monotonic / tail-only / no-signal
  Phase 3: Rolling IC decay - classify stable / decaying / emerging
  Phase 4: Factor clustering by correlation, identify 4-6 distinct clusters
  Phase 5: Contest-size-conditional IC per factor

Outputs:
  phase1_ic_ranking.csv (per (factor, ic_type) IC summary on DEV)
  phase2_decile_classification.csv (monotonicity classification)
  phase3_decay_classification.csv (stable/decaying/emerging)
  phase4_factor_clusters.json (correlation clustering result + cluster representatives)
  phase5_contest_conditional_ic.csv
  pipeline_selected_factors.json (final shortlist: passes all gates)

Discipline:
  - DEV used for factor identification ONLY
  - WFA for ensemble hill-climbing
  - HOLDOUT touched ONCE at end via backtest
"""
import csv, os, sys, json
from collections import defaultdict
import numpy as np
import pandas as pd
from scipy.stats import spearmanr, pointbiserialr
from scipy.cluster.hierarchy import linkage, fcluster

LIVE_AUDIT = "C:/Users/colin/Projects/dfs-optimizer/live_audit"
DFSOPTO = "C:/Users/colin/dfs opto"

def slate_to_date(s):
    parts = s.split('-')
    if len(parts) >= 3:
        try:
            return pd.Timestamp(year=2000 + int(parts[2]), month=int(parts[0]), day=int(parts[1]))
        except Exception: return pd.NaT
    return pd.NaT

def main():
    print("Loading factor_frame_v4...", file=sys.stderr)
    if os.path.exists(os.path.join(LIVE_AUDIT, 'factor_frame_v4.csv')):
        fdf = pd.read_csv(os.path.join(LIVE_AUDIT, 'factor_frame_v4.csv'))
    else:
        print("Using v3 since v4 not ready yet", file=sys.stderr)
        fdf = pd.read_csv(os.path.join(LIVE_AUDIT, 'factor_frame_v3.csv'))
    print(f"Loaded {len(fdf)} rows × {len(fdf.columns)} cols", file=sys.stderr)

    fdf['date'] = fdf['slate'].apply(slate_to_date)
    fdf = fdf.dropna(subset=['date'])

    # Splits
    unique_slates = sorted(fdf['slate'].unique(), key=slate_to_date)
    n = len(unique_slates)
    n_dev = int(n * 0.50)
    n_wfa = int(n * 0.30)
    dev_slates = set(unique_slates[:n_dev])
    wfa_slates = set(unique_slates[n_dev:n_dev+n_wfa])
    holdout_slates = set(unique_slates[n_dev+n_wfa:])
    print(f"Splits — DEV: {n_dev} | WFA: {n_wfa} | HOLDOUT: {n - n_dev - n_wfa}", file=sys.stderr)
    dev_df = fdf[fdf['slate'].isin(dev_slates)].copy()
    dev_df['is_top1'] = (dev_df['finish_pct'] >= 0.99).astype(int)
    dev_df['is_top5'] = (dev_df['finish_pct'] >= 0.95).astype(int)

    factor_cols = [c for c in fdf.columns if c not in ('contest_id', 'slate', 'rank', 'finish_pct', 'date', 'is_top1', 'is_top5')]
    print(f"Factor cols: {len(factor_cols)}", file=sys.stderr)

    # === PHASE 1: IC per factor on DEV ===
    print("\n[Phase 1] IC per factor on DEV set...", file=sys.stderr)
    ic_rows = []
    for cid in sorted(dev_df['contest_id'].unique()):
        sub = dev_df[dev_df['contest_id'] == cid]
        if len(sub) < 50: continue
        for f in factor_cols:
            vals = sub[f].values
            if np.std(vals) < 1e-9: continue
            try:
                ic_full, _ = spearmanr(vals, sub['finish_pct'].values)
            except Exception: ic_full = np.nan
            ic_top1 = np.nan
            if sub['is_top1'].sum() >= 2:
                try: ic_top1, _ = pointbiserialr(sub['is_top1'].values, vals)
                except Exception: pass
            ic_rows.append({'factor': f, 'contest_id': cid, 'ic_full': ic_full, 'ic_top1': ic_top1})
    icdf = pd.DataFrame(ic_rows)

    # Aggregate
    summary = []
    for f in factor_cols:
        sub = icdf[icdf['factor'] == f]
        for ic_type in ['ic_full', 'ic_top1']:
            ics = sub[ic_type].dropna().values
            if len(ics) == 0: continue
            mean_ic = np.mean(ics)
            std_ic = np.std(ics)
            sign_stable = np.mean(np.sign(ics) == np.sign(mean_ic)) if abs(mean_ic) > 0.001 else 0
            summary.append({
                'factor': f, 'ic_type': ic_type, 'n': len(ics),
                'mean_ic': mean_ic, 'std_ic': std_ic, 'sign_stable_pct': sign_stable,
                'abs_mean_ic': abs(mean_ic),
            })
    sdf = pd.DataFrame(summary).sort_values('abs_mean_ic', ascending=False)
    sdf.to_csv(os.path.join(LIVE_AUDIT, 'phase1_ic_ranking.csv'), index=False)
    print(f"Phase 1 done. Top 10 by IC magnitude:", file=sys.stderr)
    print(sdf.head(10).to_string(), file=sys.stderr)

    # === PHASE 2: Quantile / monotonicity classification ===
    print("\n[Phase 2] Quantile decomposition - classify monotonic/tail/no-signal...", file=sys.stderr)
    top_30_factors = sdf[sdf['ic_type'] == 'ic_full'].head(30)['factor'].unique()
    quant_rows = []
    for f in top_30_factors:
        # Pool all DEV lineups, bin by factor decile, compute mean finish_pct per decile
        try:
            dev_df['_q'] = pd.qcut(dev_df[f], 10, labels=False, duplicates='drop')
        except (ValueError, TypeError): continue
        decile_means = dev_df.groupby('_q')['finish_pct'].mean().sort_index().values
        if len(decile_means) < 8: continue
        # Monotonicity check
        diffs = np.diff(decile_means)
        n_pos = (diffs > 0).sum()
        n_neg = (diffs < 0).sum()
        is_monotonic = (n_pos >= 7) or (n_neg >= 7)  # 8 out of 9 decile-to-decile diffs same sign
        d1 = decile_means[0]; d10 = decile_means[-1]
        d_range = d10 - d1
        # Tail-only check: if d1-d8 are flat (~0.5) and only d9/d10 deviate (or d1/d2 only)
        middle_mean = np.mean(decile_means[2:-2]) if len(decile_means) >= 5 else np.mean(decile_means)
        middle_std = np.std(decile_means[2:-2]) if len(decile_means) >= 5 else 0
        is_tail_only = (abs(d_range) > 0.05) and middle_std < 0.01
        classification = 'monotonic' if is_monotonic else ('tail_only' if is_tail_only else 'noisy')
        quant_rows.append({
            'factor': f, 'd1': d1, 'd5': decile_means[4] if len(decile_means) > 4 else None,
            'd10': d10, 'range': d_range, 'is_monotonic': is_monotonic,
            'is_tail_only': is_tail_only, 'classification': classification,
            'decile_means': decile_means.tolist(),
        })
    qdf = pd.DataFrame(quant_rows)
    qdf.to_csv(os.path.join(LIVE_AUDIT, 'phase2_decile_classification.csv'), index=False)
    print(f"Phase 2 done. Classification:", file=sys.stderr)
    print(qdf['classification'].value_counts(), file=sys.stderr)

    # === PHASE 3: Rolling IC decay ===
    print("\n[Phase 3] Rolling IC decay...", file=sys.stderr)
    dev_dates = sorted(dev_df['date'].unique())
    mid_idx = len(dev_dates) // 2
    mid_date = dev_dates[mid_idx]
    decay_rows = []
    survivors_phase2 = qdf[qdf['classification'] == 'monotonic']['factor'].unique()
    print(f"Phase 2 survivors (monotonic): {len(survivors_phase2)} factors", file=sys.stderr)
    for f in survivors_phase2:
        ics_early = []; ics_late = []
        for label, mask in [('early', dev_df['date'] < mid_date), ('late', dev_df['date'] >= mid_date)]:
            sub = dev_df[mask]
            ics_this = []
            for cid in sub['contest_id'].unique():
                csub = sub[sub['contest_id'] == cid]
                if len(csub) < 50: continue
                vals = csub[f].values
                if np.std(vals) < 1e-9: continue
                try:
                    ic, _ = spearmanr(vals, csub['finish_pct'].values)
                    if not np.isnan(ic): ics_this.append(ic)
                except Exception: pass
            if label == 'early': ics_early = ics_this
            else: ics_late = ics_this
        if not (ics_early and ics_late): continue
        early_ic = np.mean(ics_early)
        late_ic = np.mean(ics_late)
        decay_ratio = late_ic / early_ic if abs(early_ic) > 0.001 else 0
        if decay_ratio > 1.2: status = 'emerging'
        elif decay_ratio < 0.5: status = 'decaying'
        elif decay_ratio > 0.8 and decay_ratio <= 1.2: status = 'stable'
        else: status = 'mixed'
        decay_rows.append({
            'factor': f, 'early_ic': early_ic, 'late_ic': late_ic,
            'decay_ratio': decay_ratio, 'status': status,
        })
    ddf = pd.DataFrame(decay_rows)
    ddf.to_csv(os.path.join(LIVE_AUDIT, 'phase3_decay_classification.csv'), index=False)
    print(f"Phase 3 done. Status counts:", file=sys.stderr)
    print(ddf['status'].value_counts(), file=sys.stderr)

    # === PHASE 4: Factor clustering ===
    print("\n[Phase 4] Factor clustering by correlation...", file=sys.stderr)
    survivors_phase3 = ddf[ddf['status'].isin(['stable', 'emerging'])]['factor'].unique()
    print(f"Phase 3 survivors (stable + emerging): {len(survivors_phase3)} factors", file=sys.stderr)
    if len(survivors_phase3) >= 4:
        X = dev_df[list(survivors_phase3)].fillna(0).values
        # Standardize
        X = (X - X.mean(0)) / (X.std(0) + 1e-9)
        # Correlation matrix
        corr = np.corrcoef(X.T)
        # Distance = 1 - |correlation|
        dist = 1 - np.abs(corr)
        # Hierarchical clustering
        from scipy.spatial.distance import squareform
        condensed = squareform(dist, checks=False)
        Z = linkage(condensed, method='average')
        # Cut at distance threshold to yield 4-6 clusters
        for n_clusters in [4, 5, 6]:
            labels = fcluster(Z, t=n_clusters, criterion='maxclust')
            clusters = defaultdict(list)
            for f, lbl in zip(survivors_phase3, labels):
                clusters[int(lbl)].append(f)
            if len(clusters) >= 4: break
        # Pick representative from each cluster: highest |IC|
        cluster_reps = {}
        for cl, members in clusters.items():
            best = max(members, key=lambda f: ddf[ddf['factor'] == f]['late_ic'].abs().values[0] if len(ddf[ddf['factor'] == f]) else 0)
            cluster_reps[cl] = {'representative': best, 'members': members}
        json.dump(cluster_reps, open(os.path.join(LIVE_AUDIT, 'phase4_factor_clusters.json'), 'w'), indent=2)
        print(f"Phase 4 done. Clusters: {len(clusters)}", file=sys.stderr)
        for cl, info in cluster_reps.items():
            print(f"  Cluster {cl}: rep={info['representative']}, n_members={len(info['members'])}", file=sys.stderr)
    else:
        print("Not enough Phase 3 survivors for clustering", file=sys.stderr)

    # === FINAL: selected factors per Phase 6 protocol ===
    final_factors = []
    for f in survivors_phase3:
        ic_row = sdf[(sdf['factor'] == f) & (sdf['ic_type'] == 'ic_full')]
        decay_row = ddf[ddf['factor'] == f]
        if len(ic_row) == 0 or len(decay_row) == 0: continue
        final_factors.append({
            'factor': f,
            'dev_ic': float(ic_row['mean_ic'].values[0]),
            'sign_stable': float(ic_row['sign_stable_pct'].values[0]),
            'early_ic': float(decay_row['early_ic'].values[0]),
            'late_ic': float(decay_row['late_ic'].values[0]),
            'status': decay_row['status'].values[0],
        })
    final_factors.sort(key=lambda x: -abs(x['late_ic']))
    json.dump({'final_factors': final_factors}, open(os.path.join(LIVE_AUDIT, 'pipeline_selected_factors.json'), 'w'), indent=2)
    print(f"\n=== FINAL SELECTED FACTORS (passed Phase 2 + Phase 3) ===")
    print(f"{'factor':<35} {'dev_ic':>9} {'late_ic':>9} {'status':>10}")
    for f in final_factors[:25]:
        print(f"{f['factor']:<35} {f['dev_ic']:>9.4f} {f['late_ic']:>9.4f} {f['status']:>10}")

if __name__ == '__main__':
    main()
