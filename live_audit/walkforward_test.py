"""
Walk-forward validation — expanding vs rolling window per spec.

Per the spec:
  "Run both expanding and rolling walk-forward analyses. If expanding-window performance
   is similar to rolling-window, your patterns are stable and you can use all historical data.
   If rolling beats expanding, you have factor decay and should train on more recent data."

Procedure:
  Walk-forward expanding: train on slates 1..k, validate on slate k+1. k increases.
  Walk-forward rolling: train on slates (k-W)..k where W=fixed window, validate on k+1.

Compare WFA AUC across each window. If rolling consistently > expanding → factor decay.
"""
import csv, os, sys, json, time
import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.metrics import roc_auc_score

LIVE_AUDIT = "C:/Users/colin/Projects/dfs-optimizer/live_audit"
LEAKY = {'pair_freq_sum', 'pair_freq_mean', 'pair_freq_max', 'pair_freq_top5_sum',
         'player_freq_sum', 'player_freq_max', 'player_freq_min', 'is_unique_lineup'}

def slate_to_date(s):
    parts = s.split('-')
    try: return pd.Timestamp(year=2000 + int(parts[2]), month=int(parts[0]), day=int(parts[1]))
    except Exception: return pd.NaT

def train_and_validate(train_df, val_df, feature_cols):
    """Train binary top-1% model with v2 sample weighting; return WFA AUC."""
    X_tr = train_df[feature_cols].fillna(0).values.astype(np.float32)
    X_va = val_df[feature_cols].fillna(0).values.astype(np.float32)
    y_tr = train_df['is_top1'].values
    y_va = val_df['is_top1'].values
    if y_va.sum() < 2: return None  # need positives in val
    sw = np.ones(len(train_df))
    sw[train_df['finish_pct'].values >= 0.99] = 10
    sw[train_df['finish_pct'].values >= 0.999] = 100
    dtr = xgb.DMatrix(X_tr, label=y_tr, weight=sw, feature_names=feature_cols)
    dva = xgb.DMatrix(X_va, label=y_va, feature_names=feature_cols)
    pos_w = (len(y_tr) - y_tr.sum()) / max(1, y_tr.sum())
    params = {'objective':'binary:logistic','eval_metric':'auc','tree_method':'hist','verbosity':0,
              'max_depth':4,'learning_rate':0.03,'subsample':0.8,'colsample_bytree':0.6,
              'min_child_weight':100,'gamma':0.1,'scale_pos_weight':pos_w}
    m = xgb.train(params, dtr, num_boost_round=500, evals=[(dva,'val')],
                  early_stopping_rounds=30, verbose_eval=False)
    pred = m.predict(dva)
    return roc_auc_score(y_va, pred)

def main():
    t0 = time.time()
    print("Loading factor_frame_v4...", file=sys.stderr)
    fdf = pd.read_csv(os.path.join(LIVE_AUDIT, 'factor_frame_v4.csv'))
    fdf['date'] = fdf['slate'].apply(slate_to_date)
    fdf = fdf.dropna(subset=['date']).sort_values('date').reset_index(drop=True)
    fdf['is_top1'] = (fdf['finish_pct'] >= 0.99).astype(int)
    exclude = {'contest_id','slate','rank','finish_pct','date','is_top1'} | LEAKY
    feature_cols = [c for c in fdf.columns if c not in exclude]
    unique_slates = sorted(fdf['slate'].unique(), key=slate_to_date)
    n = len(unique_slates)
    print(f"{n} slates, {len(feature_cols)} features", file=sys.stderr)

    # Walk-forward: validate slate k+1 using either all slates 1..k (expanding) or last W slates (rolling)
    WINDOW_ROLLING = 8
    MIN_TRAIN = 5  # need at least 5 slates for training

    rows = []
    for k in range(MIN_TRAIN, n-1):
        val_slate = unique_slates[k]
        val_df = fdf[fdf['slate'] == val_slate]
        if val_df['is_top1'].sum() < 2: continue

        # Expanding: train on 0..k-1
        exp_train_slates = unique_slates[:k]
        exp_train = fdf[fdf['slate'].isin(exp_train_slates)]
        # Rolling: train on max(0, k-W)..k-1
        roll_start = max(0, k - WINDOW_ROLLING)
        roll_train_slates = unique_slates[roll_start:k]
        roll_train = fdf[fdf['slate'].isin(roll_train_slates)]

        auc_exp = train_and_validate(exp_train, val_df, feature_cols)
        auc_roll = train_and_validate(roll_train, val_df, feature_cols)

        rows.append({
            'val_slate': val_slate, 'k': k,
            'exp_train_size': len(exp_train), 'roll_train_size': len(roll_train),
            'auc_expanding': auc_exp, 'auc_rolling': auc_roll,
            'rolling_advantage': (auc_roll - auc_exp) if (auc_exp and auc_roll) else None,
        })
        print(f"  k={k} val={val_slate} | exp_n={len(exp_train)}/{auc_exp:.4f} | roll_n={len(roll_train)}/{auc_roll:.4f} | delta={rows[-1]['rolling_advantage']:+.4f}",
              file=sys.stderr)

    rdf = pd.DataFrame(rows)
    rdf.to_csv(os.path.join(LIVE_AUDIT, 'walkforward_results.csv'), index=False)

    print(f"\n=== Walk-Forward Summary (N={len(rdf)} val slates) ===", file=sys.stderr)
    print(f"Mean expanding AUC: {rdf['auc_expanding'].mean():.4f}", file=sys.stderr)
    print(f"Mean rolling AUC:   {rdf['auc_rolling'].mean():.4f}", file=sys.stderr)
    print(f"Mean rolling advantage: {rdf['rolling_advantage'].mean():+.4f}", file=sys.stderr)
    print(f"Rolling > Expanding in: {(rdf['rolling_advantage'] > 0).sum()}/{len(rdf)} slates", file=sys.stderr)

    # Interpretation
    avg_adv = rdf['rolling_advantage'].mean()
    if avg_adv > 0.005:
        print(f"\n>>> ROLLING wins by {avg_adv:+.4f} — FACTOR DECAY detected; train on recent data", file=sys.stderr)
    elif avg_adv < -0.005:
        print(f"\n>>> EXPANDING wins by {-avg_adv:+.4f} — patterns stable; use all history", file=sys.stderr)
    else:
        print(f"\n>>> No clear winner (delta {avg_adv:+.4f}) — patterns roughly stable", file=sys.stderr)

    json.dump({
        'mean_exp_auc': float(rdf['auc_expanding'].mean()),
        'mean_roll_auc': float(rdf['auc_rolling'].mean()),
        'mean_rolling_advantage': float(rdf['rolling_advantage'].mean()),
        'rolling_wins': int((rdf['rolling_advantage'] > 0).sum()),
        'n_val_slates': len(rdf),
        'window_size': WINDOW_ROLLING,
    }, open(os.path.join(LIVE_AUDIT, 'walkforward_summary.json'), 'w'), indent=2)

    print(f"\nTotal time: {time.time()-t0:.1f}s", file=sys.stderr)

if __name__ == '__main__':
    main()
