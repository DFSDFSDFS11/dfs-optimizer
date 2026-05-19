"""
Purged k-fold CV (López de Prado) for v4 (125 feats) and v5 (201 feats).

Splits 27 unique slates into 5 folds chronologically.
For each fold:
  - Training set = all slates outside fold, EXCLUDING `embargo` slates adjacent to fold
  - Validation  = the fold's slates
  - Train v4/v5 with Optuna params + sample weighting on training set
  - Compute AUC on validation

Reports per-fold and mean AUC. A non-leaky model should have:
  mean_cv_auc ≈ 0.60 (matching pre-Optuna LightGBM CV val AUC 0.74 was suspicious)

If v5's mean CV AUC < v4's, v5 is overfitting via groupby features.
"""
import json, os, sys, time
import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.metrics import roc_auc_score

LIVE_AUDIT = "C:/Users/colin/Projects/dfs-optimizer/live_audit"
LEAKY = {'pair_freq_sum','pair_freq_mean','pair_freq_max','pair_freq_top5_sum',
         'player_freq_sum','player_freq_max','player_freq_min','is_unique_lineup'}
K_FOLDS = 5
EMBARGO = 1  # slates on each side of the fold to drop from training

def slate_to_date(s):
    parts = s.split('-')
    try: return pd.Timestamp(year=2000+int(parts[2]), month=int(parts[0]), day=int(parts[1]))
    except: return pd.NaT

def cv(df, feature_cols, params, n_rounds, pw_mult, model_name):
    df = df.copy()
    df['date'] = df['slate'].apply(slate_to_date)
    df = df.dropna(subset=['date']).sort_values('date').reset_index(drop=True)
    df['is_top1'] = (df['finish_pct'] >= 0.99).astype(int)
    unique_slates = sorted(df['slate'].unique(), key=lambda s: slate_to_date(s))
    n = len(unique_slates)
    fold_size = n // K_FOLDS
    print(f"\n=== {model_name} purged {K_FOLDS}-fold CV ({n} slates, fold_size={fold_size}, embargo={EMBARGO}) ===")
    fold_aucs = []
    for k in range(K_FOLDS):
        v_lo = k * fold_size
        v_hi = (k+1) * fold_size if k < K_FOLDS - 1 else n
        val_slates = unique_slates[v_lo:v_hi]
        embargo_lo = max(0, v_lo - EMBARGO)
        embargo_hi = min(n, v_hi + EMBARGO)
        train_slates = [s for i, s in enumerate(unique_slates)
                        if i < embargo_lo or i >= embargo_hi]
        train_df = df[df['slate'].isin(train_slates)]
        val_df = df[df['slate'].isin(val_slates)]
        if val_df['is_top1'].sum() < 2:
            print(f"  fold{k}: val has <2 positives, skip"); continue

        X_tr = train_df[feature_cols].fillna(0).values.astype(np.float32)
        X_va = val_df[feature_cols].fillna(0).values.astype(np.float32)
        y_tr = train_df['is_top1'].values
        y_va = val_df['is_top1'].values
        sw = np.ones(len(train_df))
        sw[train_df['finish_pct'].values >= 0.99] = 10
        sw[train_df['finish_pct'].values >= 0.999] = 100
        p = dict(params)
        pos_w = (len(y_tr) - y_tr.sum()) / max(1, y_tr.sum())
        p['scale_pos_weight'] = pos_w * pw_mult
        dtr = xgb.DMatrix(X_tr, label=y_tr, weight=sw, feature_names=feature_cols)
        dva = xgb.DMatrix(X_va, label=y_va, feature_names=feature_cols)
        m = xgb.train(p, dtr, num_boost_round=n_rounds, verbose_eval=False)
        pred = m.predict(dva)
        auc = roc_auc_score(y_va, pred)
        fold_aucs.append(auc)
        print(f"  fold{k} (val={val_slates[0]}..{val_slates[-1]}, train_n={len(train_df)}, val_n={len(val_df)}): AUC={auc:.4f}")
    print(f"  Mean CV AUC ({model_name}): {np.mean(fold_aucs):.4f}  std={np.std(fold_aucs):.4f}")
    return fold_aucs

def main():
    t0 = time.time()
    # v4
    v4_df = pd.read_csv(os.path.join(LIVE_AUDIT,'factor_frame_v4.csv'))
    v4_opt = json.load(open(os.path.join(LIVE_AUDIT,'optuna_results.json')))
    v4_params = dict(v4_opt['best_params'])
    v4_pw = v4_params.pop('pos_weight_mult')
    v4_params.update({'objective':'binary:logistic','eval_metric':'auc','tree_method':'hist','verbosity':0})
    v4_rounds = int(v4_opt['best_iter'])
    v4_exclude = {'contest_id','slate','rank','finish_pct','is_top1'} | LEAKY
    v4_feats = [c for c in v4_df.columns if c not in v4_exclude]
    v4_aucs = cv(v4_df, v4_feats, v4_params, v4_rounds, v4_pw, 'v4')

    # v5
    v5_df = pd.read_csv(os.path.join(LIVE_AUDIT,'factor_frame_v5.csv'))
    v5_opt = json.load(open(os.path.join(LIVE_AUDIT,'optuna_v5_results.json')))
    v5_params = dict(v5_opt['best_params'])
    v5_pw = v5_params.pop('pw_mult')
    v5_params.update({'objective':'binary:logistic','eval_metric':'auc','tree_method':'hist','verbosity':0})
    v5_rounds = int(v5_opt['best_iter'])
    v5_exclude = {'contest_id','slate','rank','finish_pct','is_top1'} | LEAKY
    v5_feats = [c for c in v5_df.columns if c not in v5_exclude]
    v5_aucs = cv(v5_df, v5_feats, v5_params, v5_rounds, v5_pw, 'v5')

    print(f"\n=== VERDICT ===")
    print(f"v4 mean CV AUC: {np.mean(v4_aucs):.4f}")
    print(f"v5 mean CV AUC: {np.mean(v5_aucs):.4f}")
    print(f"v5 - v4 delta : {np.mean(v5_aucs) - np.mean(v4_aucs):+.4f}")
    if np.mean(v5_aucs) > np.mean(v4_aucs) + 0.005:
        print("  -> v5 generalizes BETTER. Keep v5.")
    elif np.mean(v5_aucs) < np.mean(v4_aucs) - 0.005:
        print("  -> v5 GENERALIZES WORSE. v5 was overfit; revert to v4.")
    else:
        print("  -> v5 ~= v4. Choose v4 (simpler, fewer features).")
    json.dump({'v4_aucs':v4_aucs, 'v5_aucs':v5_aucs,
               'v4_mean':float(np.mean(v4_aucs)), 'v5_mean':float(np.mean(v5_aucs))},
              open(os.path.join(LIVE_AUDIT,'purged_kfold_results.json'),'w'), indent=2)
    print(f"Total: {time.time()-t0:.1f}s")

if __name__ == '__main__':
    main()
