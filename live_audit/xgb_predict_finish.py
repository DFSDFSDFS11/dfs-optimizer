"""
Option 1 (corrected Phase 4): Train XGBoost model to predict finishing percentile from lineup features.

Per the methodology document's corrected Phase 4:
  "Train a predictive model directly (XGBoost on lineup features → predicted finishing percentile)
   and use predicted percentile as selection criterion"

Training discipline:
  - DEV set (11 slates) for training
  - WFA set (6 slates) for hyperparameter validation (early stopping)
  - HOLDOUT set (5 slates) for final ROI test — touched ONCE at end

Two targets tested:
  (a) Continuous finishing_pct (regression) - models the WHOLE distribution
  (b) Binary is_top1 (classification) - GPP-focused, target top-1%

For each, train, predict per lineup, then output predictions for use in TS backtest.

Output:
  xgb_predictions.csv: contest_id, rank, finish_pct, pred_finish, pred_top1
  xgb_feature_importance.csv: which features the model uses most
  xgb_validation_metrics.json: AUC, MSE, etc on WFA
"""
import csv, os, sys, json, time
from collections import defaultdict
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
    print("Loading factor_frame_v4...", file=sys.stderr)
    fdf = pd.read_csv(os.path.join(LIVE_AUDIT, 'factor_frame_v4.csv'))
    print(f"Loaded {len(fdf)} rows × {len(fdf.columns)} cols in {time.time()-t0:.1f}s", file=sys.stderr)

    fdf['date'] = fdf['slate'].apply(slate_to_date)
    fdf = fdf.dropna(subset=['date']).sort_values('date').reset_index(drop=True)

    splits = json.load(open(os.path.join(LIVE_AUDIT, 'wfa_splits.json')))
    dev_set = set(splits['dev'])
    wfa_set = set(splits['wfa'])
    holdout_set = set(splits['holdout'])

    # Target variables
    fdf['is_top1'] = (fdf['finish_pct'] >= 0.99).astype(int)

    # Feature columns
    exclude = ('contest_id', 'slate', 'rank', 'finish_pct', 'date', 'is_top1')
    feature_cols = [c for c in fdf.columns if c not in exclude]
    print(f"Features: {len(feature_cols)}", file=sys.stderr)

    # Split data
    dev_df = fdf[fdf['slate'].isin(dev_set)]
    wfa_df = fdf[fdf['slate'].isin(wfa_set)]
    hold_df = fdf[fdf['slate'].isin(holdout_set)]
    print(f"DEV: {len(dev_df)} | WFA: {len(wfa_df)} | HOLDOUT: {len(hold_df)}", file=sys.stderr)

    # Handle NaNs
    X_dev = dev_df[feature_cols].fillna(0).values.astype(np.float32)
    X_wfa = wfa_df[feature_cols].fillna(0).values.astype(np.float32)
    X_hold = hold_df[feature_cols].fillna(0).values.astype(np.float32)

    y_dev_reg = dev_df['finish_pct'].values
    y_wfa_reg = wfa_df['finish_pct'].values
    y_dev_top1 = dev_df['is_top1'].values
    y_wfa_top1 = wfa_df['is_top1'].values

    # === REGRESSION MODEL: predict finish_pct ===
    print("\nTraining XGBoost regression (target: finish_pct)...", file=sys.stderr)
    t1 = time.time()
    dtrain = xgb.DMatrix(X_dev, label=y_dev_reg, feature_names=feature_cols)
    dval = xgb.DMatrix(X_wfa, label=y_wfa_reg, feature_names=feature_cols)
    reg_params = {
        'objective': 'reg:squarederror',
        'max_depth': 5,
        'learning_rate': 0.05,
        'subsample': 0.8,
        'colsample_bytree': 0.7,
        'min_child_weight': 50,
        'tree_method': 'hist',
        'verbosity': 0,
    }
    reg_model = xgb.train(reg_params, dtrain, num_boost_round=500,
                          evals=[(dtrain, 'train'), (dval, 'wfa')],
                          early_stopping_rounds=20, verbose_eval=50)
    print(f"Regression trained in {time.time()-t1:.1f}s, best iter={reg_model.best_iteration}", file=sys.stderr)
    pred_reg_wfa = reg_model.predict(dval)
    mse_wfa = mean_squared_error(y_wfa_reg, pred_reg_wfa)
    print(f"WFA MSE: {mse_wfa:.4f}", file=sys.stderr)

    # === CLASSIFICATION MODEL: predict is_top1 ===
    print("\nTraining XGBoost classification (target: is_top1)...", file=sys.stderr)
    t2 = time.time()
    pos_weight = (len(y_dev_top1) - y_dev_top1.sum()) / max(1, y_dev_top1.sum())
    dtrain_c = xgb.DMatrix(X_dev, label=y_dev_top1, feature_names=feature_cols)
    dval_c = xgb.DMatrix(X_wfa, label=y_wfa_top1, feature_names=feature_cols)
    clf_params = {
        'objective': 'binary:logistic',
        'max_depth': 4,
        'learning_rate': 0.05,
        'subsample': 0.8,
        'colsample_bytree': 0.6,
        'min_child_weight': 100,
        'scale_pos_weight': pos_weight,
        'tree_method': 'hist',
        'eval_metric': 'auc',
        'verbosity': 0,
    }
    clf_model = xgb.train(clf_params, dtrain_c, num_boost_round=500,
                          evals=[(dtrain_c, 'train'), (dval_c, 'wfa')],
                          early_stopping_rounds=20, verbose_eval=50)
    pred_clf_wfa = clf_model.predict(dval_c)
    auc_wfa = roc_auc_score(y_wfa_top1, pred_clf_wfa)
    print(f"Classification trained in {time.time()-t2:.1f}s, best iter={clf_model.best_iteration}, WFA AUC: {auc_wfa:.4f}", file=sys.stderr)

    # === Predict for ALL data (DEV + WFA + HOLDOUT) and save ===
    print("\nGenerating predictions for ALL lineups...", file=sys.stderr)
    X_all = fdf[feature_cols].fillna(0).values.astype(np.float32)
    dall = xgb.DMatrix(X_all, feature_names=feature_cols)
    pred_reg_all = reg_model.predict(dall)
    pred_clf_all = clf_model.predict(dall)
    fdf['pred_finish'] = pred_reg_all
    fdf['pred_top1'] = pred_clf_all
    fdf[['contest_id', 'slate', 'rank', 'finish_pct', 'is_top1', 'pred_finish', 'pred_top1']].to_csv(
        os.path.join(LIVE_AUDIT, 'xgb_predictions.csv'), index=False
    )

    # Feature importance
    imp_reg = reg_model.get_score(importance_type='gain')
    imp_clf = clf_model.get_score(importance_type='gain')
    imp_df = pd.DataFrame([
        {'feature': f, 'reg_gain': imp_reg.get(f, 0), 'clf_gain': imp_clf.get(f, 0)}
        for f in feature_cols
    ]).sort_values('reg_gain', ascending=False)
    imp_df.to_csv(os.path.join(LIVE_AUDIT, 'xgb_feature_importance.csv'), index=False)

    print("\n=== TOP 20 FEATURES BY REGRESSION GAIN ===")
    print(imp_df.head(20).to_string(index=False))
    print("\n=== TOP 20 FEATURES BY CLASSIFICATION GAIN ===")
    print(imp_df.sort_values('clf_gain', ascending=False).head(20)[['feature', 'clf_gain']].to_string(index=False))

    # Save metrics
    metrics = {
        'wfa_mse_reg': float(mse_wfa),
        'wfa_auc_clf': float(auc_wfa),
        'reg_best_iter': int(reg_model.best_iteration),
        'clf_best_iter': int(clf_model.best_iteration),
        'n_dev': int(len(dev_df)),
        'n_wfa': int(len(wfa_df)),
        'n_hold': int(len(hold_df)),
    }
    json.dump(metrics, open(os.path.join(LIVE_AUDIT, 'xgb_validation_metrics.json'), 'w'), indent=2)
    print(f"\nFiles saved. Total time: {time.time()-t0:.1f}s", file=sys.stderr)

    # Save models for backtest use
    reg_model.save_model(os.path.join(LIVE_AUDIT, 'xgb_reg_model.json'))
    clf_model.save_model(os.path.join(LIVE_AUDIT, 'xgb_clf_model.json'))

if __name__ == '__main__':
    main()
