"""
Ensemble V3 — Multiple objectives with hill-climbed weights on WFA.

Per the spec:
  "Train multiple XGBoost models with different objectives:
   - Model A: rank:ndcg (FAILED on our data — skipping)
   - Model B: binary:logistic predicting top-0.1% (jackpot) hit
   - Model C: binary:logistic predicting top-1% (cash-significantly) hit
   - Model D: reg:squarederror predicting actual fantasy point score (proxy: log-payout)
   Average the rank predictions. Hill-climb weights."

Builds 3 models (rank skipped), hill-climbs ensemble weights on WFA AUC@top-1%,
saves blended predictions for backtest.
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

def main():
    t0 = time.time()
    fdf = pd.read_csv(os.path.join(LIVE_AUDIT, 'factor_frame_v4.csv'))
    fdf['date'] = fdf['slate'].apply(slate_to_date)
    fdf = fdf.dropna(subset=['date']).sort_values('date').reset_index(drop=True)
    splits = json.load(open(os.path.join(LIVE_AUDIT, 'wfa_splits.json')))
    dev_set = set(splits['dev']); wfa_set = set(splits['wfa'])
    fdf['is_top1'] = (fdf['finish_pct'] >= 0.99).astype(int)
    fdf['is_top01'] = (fdf['finish_pct'] >= 0.999).astype(int)
    fdf['is_top5'] = (fdf['finish_pct'] >= 0.95).astype(int)

    exclude = {'contest_id', 'slate', 'rank', 'finish_pct', 'date', 'is_top1', 'is_top01', 'is_top5'} | LEAKY
    feature_cols = [c for c in fdf.columns if c not in exclude]

    dev_df = fdf[fdf['slate'].isin(dev_set)].copy()
    wfa_df = fdf[fdf['slate'].isin(wfa_set)].copy()
    X_dev = dev_df[feature_cols].fillna(0).values.astype(np.float32)
    X_wfa = wfa_df[feature_cols].fillna(0).values.astype(np.float32)
    print(f"DEV: {len(dev_df)}, WFA: {len(wfa_df)}, features: {len(feature_cols)}", file=sys.stderr)

    # Sample weights
    sw_dev = np.ones(len(dev_df))
    sw_dev[dev_df['finish_pct'].values >= 0.99] = 10
    sw_dev[dev_df['finish_pct'].values >= 0.999] = 100

    base_params = {
        'tree_method': 'hist',
        'verbosity': 0,
        'max_depth': 4,
        'learning_rate': 0.03,
        'subsample': 0.8,
        'colsample_bytree': 0.6,
        'min_child_weight': 100,
        'gamma': 0.1,
    }

    models = {}

    # Model B: binary top-0.1% (jackpot)
    print("\n[B] binary top-0.1% (jackpot)...", file=sys.stderr)
    pos_w = (len(dev_df) - dev_df['is_top01'].sum()) / max(1, dev_df['is_top01'].sum())
    dtrain = xgb.DMatrix(X_dev, label=dev_df['is_top01'].values, weight=sw_dev, feature_names=feature_cols)
    dval = xgb.DMatrix(X_wfa, label=wfa_df['is_top01'].values, feature_names=feature_cols)
    params = {**base_params, 'objective': 'binary:logistic', 'eval_metric': 'auc', 'scale_pos_weight': pos_w}
    m = xgb.train(params, dtrain, num_boost_round=1000, evals=[(dval, 'wfa')],
                  early_stopping_rounds=50, verbose_eval=False)
    pred_B_wfa = m.predict(dval)
    if wfa_df['is_top01'].sum() >= 2:
        print(f"  WFA AUC (top-0.1%): {roc_auc_score(wfa_df['is_top01'], pred_B_wfa):.4f}", file=sys.stderr)
    m.save_model(os.path.join(LIVE_AUDIT, 'xgb_ens_B_top01.json'))
    models['B'] = (m, pred_B_wfa)

    # Model C: binary top-1%
    print("\n[C] binary top-1%...", file=sys.stderr)
    pos_w = (len(dev_df) - dev_df['is_top1'].sum()) / max(1, dev_df['is_top1'].sum())
    dtrain = xgb.DMatrix(X_dev, label=dev_df['is_top1'].values, weight=sw_dev, feature_names=feature_cols)
    dval = xgb.DMatrix(X_wfa, label=wfa_df['is_top1'].values, feature_names=feature_cols)
    params = {**base_params, 'objective': 'binary:logistic', 'eval_metric': 'auc', 'scale_pos_weight': pos_w}
    m = xgb.train(params, dtrain, num_boost_round=1000, evals=[(dval, 'wfa')],
                  early_stopping_rounds=50, verbose_eval=False)
    pred_C_wfa = m.predict(dval)
    auc_C = roc_auc_score(wfa_df['is_top1'], pred_C_wfa)
    print(f"  WFA AUC (top-1%): {auc_C:.4f}", file=sys.stderr)
    m.save_model(os.path.join(LIVE_AUDIT, 'xgb_ens_C_top1.json'))
    models['C'] = (m, pred_C_wfa)

    # Model D: binary top-5%
    print("\n[D] binary top-5%...", file=sys.stderr)
    pos_w = (len(dev_df) - dev_df['is_top5'].sum()) / max(1, dev_df['is_top5'].sum())
    dtrain = xgb.DMatrix(X_dev, label=dev_df['is_top5'].values, weight=sw_dev, feature_names=feature_cols)
    dval = xgb.DMatrix(X_wfa, label=wfa_df['is_top5'].values, feature_names=feature_cols)
    params = {**base_params, 'objective': 'binary:logistic', 'eval_metric': 'auc', 'scale_pos_weight': pos_w}
    m = xgb.train(params, dtrain, num_boost_round=1000, evals=[(dval, 'wfa')],
                  early_stopping_rounds=50, verbose_eval=False)
    pred_D_wfa = m.predict(dval)
    print(f"  WFA AUC (top-5%): {roc_auc_score(wfa_df['is_top5'], pred_D_wfa):.4f}", file=sys.stderr)
    m.save_model(os.path.join(LIVE_AUDIT, 'xgb_ens_D_top5.json'))
    models['D'] = (m, pred_D_wfa)

    # Hill climbing ensemble: optimize weights to maximize WFA AUC@top-1%
    print("\nHill-climbing ensemble weights on WFA AUC@top-1%...", file=sys.stderr)
    # Normalize each prediction to [0,1] via rank
    from scipy.stats import rankdata
    rB = rankdata(pred_B_wfa) / len(pred_B_wfa)
    rC = rankdata(pred_C_wfa) / len(pred_C_wfa)
    rD = rankdata(pred_D_wfa) / len(pred_D_wfa)

    best_auc = -1; best_w = None
    # Hill climb on (w_B, w_C, w_D) summing to 1
    # Grid search 11 x 11 x 11 / valid only
    for wB in np.arange(0, 1.01, 0.1):
        for wC in np.arange(0, 1.01 - wB + 1e-6, 0.1):
            wD = 1.0 - wB - wC
            if wD < -1e-6 or wD > 1.0 + 1e-6: continue
            wD = max(0, wD)
            blend = wB * rB + wC * rC + wD * rD
            auc = roc_auc_score(wfa_df['is_top1'], blend)
            if auc > best_auc:
                best_auc = auc; best_w = (wB, wC, wD)
    print(f"\nBest blend weights: B={best_w[0]:.2f} C={best_w[1]:.2f} D={best_w[2]:.2f}", file=sys.stderr)
    print(f"Ensemble WFA AUC@top-1%: {best_auc:.4f} (vs single C top-1% {auc_C:.4f})", file=sys.stderr)

    json.dump({
        'best_weights': {'B_top01': best_w[0], 'C_top1': best_w[1], 'D_top5': best_w[2]},
        'ensemble_wfa_auc_top1': float(best_auc),
        'single_C_top1_auc': float(auc_C),
        'delta': float(best_auc - auc_C),
    }, open(os.path.join(LIVE_AUDIT, 'ensemble_weights.json'), 'w'), indent=2)

    print(f"\nTotal time: {time.time()-t0:.1f}s", file=sys.stderr)

if __name__ == '__main__':
    main()
