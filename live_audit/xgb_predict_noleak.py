"""
Retrain XGBoost WITHOUT field-derived features (pair_freq_*, player_freq_*, is_unique_lineup)
to eliminate data leakage from contest standings used for training.

Compare WFA AUC to leaky model to estimate signal degradation.
"""
import csv, os, sys, json, time
import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.metrics import roc_auc_score, mean_squared_error

LIVE_AUDIT = "C:/Users/colin/Projects/dfs-optimizer/live_audit"

def slate_to_date(s):
    parts = s.split('-')
    try: return pd.Timestamp(year=2000 + int(parts[2]), month=int(parts[0]), day=int(parts[1]))
    except Exception: return pd.NaT

def main():
    t0 = time.time()
    fdf = pd.read_csv(os.path.join(LIVE_AUDIT, 'factor_frame_v4.csv'))
    fdf['date'] = fdf['slate'].apply(slate_to_date)
    fdf = fdf.dropna(subset=['date']).sort_values('date').reset_index(drop=True)

    splits = json.load(open(os.path.join(LIVE_AUDIT, 'wfa_splits.json')))
    dev_set = set(splits['dev']); wfa_set = set(splits['wfa'])

    fdf['is_top1'] = (fdf['finish_pct'] >= 0.99).astype(int)

    # EXCLUDE field-derived features (LEAKAGE risk)
    LEAKY = {'pair_freq_sum', 'pair_freq_mean', 'pair_freq_max', 'pair_freq_top5_sum',
             'player_freq_sum', 'player_freq_max', 'player_freq_min', 'is_unique_lineup'}
    exclude = ('contest_id', 'slate', 'rank', 'finish_pct', 'date', 'is_top1') + tuple(LEAKY)
    feature_cols = [c for c in fdf.columns if c not in exclude]
    print(f"Features (leak-free): {len(feature_cols)} (excluded {len(LEAKY)} field-derived)", file=sys.stderr)

    dev_df = fdf[fdf['slate'].isin(dev_set)]
    wfa_df = fdf[fdf['slate'].isin(wfa_set)]

    X_dev = dev_df[feature_cols].fillna(0).values.astype(np.float32)
    X_wfa = wfa_df[feature_cols].fillna(0).values.astype(np.float32)
    y_dev_reg = dev_df['finish_pct'].values
    y_wfa_reg = wfa_df['finish_pct'].values
    y_dev_top1 = dev_df['is_top1'].values
    y_wfa_top1 = wfa_df['is_top1'].values

    # Regression
    print("Training regression (leak-free)...", file=sys.stderr)
    dtrain = xgb.DMatrix(X_dev, label=y_dev_reg, feature_names=feature_cols)
    dval = xgb.DMatrix(X_wfa, label=y_wfa_reg, feature_names=feature_cols)
    reg_params = {'objective': 'reg:squarederror', 'max_depth': 5, 'learning_rate': 0.05,
                  'subsample': 0.8, 'colsample_bytree': 0.7, 'min_child_weight': 50,
                  'tree_method': 'hist', 'verbosity': 0}
    reg_model = xgb.train(reg_params, dtrain, num_boost_round=500,
                          evals=[(dtrain, 'train'), (dval, 'wfa')],
                          early_stopping_rounds=20, verbose_eval=100)
    pred_reg_wfa = reg_model.predict(dval)
    mse_wfa = mean_squared_error(y_wfa_reg, pred_reg_wfa)
    print(f"Leak-free regression WFA MSE: {mse_wfa:.4f} (compare to leaky)", file=sys.stderr)

    # Classification
    print("Training classification (leak-free)...", file=sys.stderr)
    pos_weight = (len(y_dev_top1) - y_dev_top1.sum()) / max(1, y_dev_top1.sum())
    dtrain_c = xgb.DMatrix(X_dev, label=y_dev_top1, feature_names=feature_cols)
    dval_c = xgb.DMatrix(X_wfa, label=y_wfa_top1, feature_names=feature_cols)
    clf_params = {'objective': 'binary:logistic', 'max_depth': 4, 'learning_rate': 0.05,
                  'subsample': 0.8, 'colsample_bytree': 0.6, 'min_child_weight': 100,
                  'scale_pos_weight': pos_weight, 'tree_method': 'hist',
                  'eval_metric': 'auc', 'verbosity': 0}
    clf_model = xgb.train(clf_params, dtrain_c, num_boost_round=500,
                          evals=[(dtrain_c, 'train'), (dval_c, 'wfa')],
                          early_stopping_rounds=20, verbose_eval=100)
    pred_clf_wfa = clf_model.predict(dval_c)
    auc_wfa = roc_auc_score(y_wfa_top1, pred_clf_wfa)
    print(f"Leak-free classification WFA AUC: {auc_wfa:.4f} (leaky was 0.6122)", file=sys.stderr)

    # Save
    reg_model.save_model(os.path.join(LIVE_AUDIT, 'xgb_reg_noleak.json'))
    clf_model.save_model(os.path.join(LIVE_AUDIT, 'xgb_clf_noleak.json'))

    # Feature importance
    imp_reg = reg_model.get_score(importance_type='gain')
    imp_clf = clf_model.get_score(importance_type='gain')
    imp_df = pd.DataFrame([{'feature': f, 'reg_gain': imp_reg.get(f, 0), 'clf_gain': imp_clf.get(f, 0)} for f in feature_cols])
    imp_df = imp_df.sort_values('reg_gain', ascending=False)
    imp_df.to_csv(os.path.join(LIVE_AUDIT, 'xgb_feature_importance_noleak.csv'), index=False)

    print(f"\n=== TOP 20 FEATURES (leak-free regression) ===")
    print(imp_df.head(20).to_string(index=False))

if __name__ == '__main__':
    main()
