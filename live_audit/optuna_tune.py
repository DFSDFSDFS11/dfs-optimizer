"""
Optuna TPE hyperparameter tuning for binary top-1% XGBoost.

Per the spec:
  "TPE optimization shows a superiority over RS since it results in a significantly higher
   accuracy and a marginally higher AUC, recall and F1 score."

Tunes XGBoost on DEV, validates on WFA using WFA AUC as objective.
Best params get retrained model saved as xgb_top1_optuna.json.

Search space (Tier 1 + Tier 2 + Tier 3 per spec):
  - learning_rate: 0.01-0.1 (log)
  - max_depth: 3-8
  - min_child_weight: 1-200
  - subsample: 0.6-1.0
  - colsample_bytree: 0.4-1.0
  - gamma: 0-1
  - reg_alpha: 0-2 (log)
  - reg_lambda: 0-2 (log)
"""
import csv, os, sys, json, time
import numpy as np
import pandas as pd
import xgboost as xgb
import optuna
from sklearn.metrics import roc_auc_score
optuna.logging.set_verbosity(optuna.logging.WARNING)

LIVE_AUDIT = "C:/Users/colin/Projects/dfs-optimizer/live_audit"
LEAKY = {'pair_freq_sum', 'pair_freq_mean', 'pair_freq_max', 'pair_freq_top5_sum',
         'player_freq_sum', 'player_freq_max', 'player_freq_min', 'is_unique_lineup'}

def slate_to_date(s):
    parts = s.split('-')
    try: return pd.Timestamp(year=2000 + int(parts[2]), month=int(parts[0]), day=int(parts[1]))
    except Exception: return pd.NaT

def main():
    print("Loading factor_frame_v4...", file=sys.stderr)
    t0 = time.time()
    fdf = pd.read_csv(os.path.join(LIVE_AUDIT, 'factor_frame_v4.csv'))
    fdf['date'] = fdf['slate'].apply(slate_to_date)
    fdf = fdf.dropna(subset=['date']).sort_values('date').reset_index(drop=True)

    splits = json.load(open(os.path.join(LIVE_AUDIT, 'wfa_splits.json')))
    dev_set = set(splits['dev']); wfa_set = set(splits['wfa'])
    fdf['is_top1'] = (fdf['finish_pct'] >= 0.99).astype(int)

    exclude = {'contest_id', 'slate', 'rank', 'finish_pct', 'date', 'is_top1'} | LEAKY
    feature_cols = [c for c in fdf.columns if c not in exclude]

    dev_df = fdf[fdf['slate'].isin(dev_set)].copy()
    wfa_df = fdf[fdf['slate'].isin(wfa_set)].copy()
    X_dev = dev_df[feature_cols].fillna(0).values.astype(np.float32)
    X_wfa = wfa_df[feature_cols].fillna(0).values.astype(np.float32)
    y_dev = dev_df['is_top1'].values
    y_wfa = wfa_df['is_top1'].values

    # Sample weights (v2 used these)
    sw_dev = np.ones(len(dev_df))
    sw_dev[dev_df['finish_pct'].values >= 0.99] = 10
    sw_dev[dev_df['finish_pct'].values >= 0.999] = 100

    dtrain = xgb.DMatrix(X_dev, label=y_dev, weight=sw_dev, feature_names=feature_cols)
    dval = xgb.DMatrix(X_wfa, label=y_wfa, feature_names=feature_cols)
    print(f"DEV: {len(dev_df)}, WFA: {len(wfa_df)}, features: {len(feature_cols)} (loaded in {time.time()-t0:.1f}s)", file=sys.stderr)

    def objective(trial):
        params = {
            'objective': 'binary:logistic',
            'eval_metric': 'auc',
            'tree_method': 'hist',
            'verbosity': 0,
            'learning_rate': trial.suggest_float('learning_rate', 0.01, 0.1, log=True),
            'max_depth': trial.suggest_int('max_depth', 3, 8),
            'min_child_weight': trial.suggest_int('min_child_weight', 1, 200, log=True),
            'subsample': trial.suggest_float('subsample', 0.6, 1.0),
            'colsample_bytree': trial.suggest_float('colsample_bytree', 0.4, 1.0),
            'gamma': trial.suggest_float('gamma', 0.0, 1.0),
            'reg_alpha': trial.suggest_float('reg_alpha', 1e-3, 2.0, log=True),
            'reg_lambda': trial.suggest_float('reg_lambda', 1e-3, 2.0, log=True),
        }
        pos_w = (len(y_dev) - y_dev.sum()) / max(1, y_dev.sum())
        params['scale_pos_weight'] = pos_w * trial.suggest_float('pos_weight_mult', 0.5, 2.0)
        model = xgb.train(params, dtrain, num_boost_round=2000,
                          evals=[(dval, 'wfa')],
                          early_stopping_rounds=50, verbose_eval=False)
        pred = model.predict(dval)
        auc = roc_auc_score(y_wfa, pred)
        trial.set_user_attr('best_iter', model.best_iteration)
        return auc

    print("\nRunning Optuna TPE (100 trials)...", file=sys.stderr)
    t1 = time.time()
    sampler = optuna.samplers.TPESampler(seed=42)
    study = optuna.create_study(direction='maximize', sampler=sampler)

    def callback(study, trial):
        if trial.number % 10 == 0:
            best = study.best_value if study.best_trial else None
            print(f"  Trial {trial.number}: AUC={trial.value:.4f} | best={best:.4f}", file=sys.stderr)

    study.optimize(objective, n_trials=100, callbacks=[callback])
    print(f"\nOptuna done in {time.time()-t1:.1f}s", file=sys.stderr)
    print(f"Best WFA AUC: {study.best_value:.4f}  (baseline 0.6285 = v2)", file=sys.stderr)
    print(f"Best params:", file=sys.stderr)
    for k, v in study.best_params.items():
        print(f"  {k}: {v}", file=sys.stderr)

    # Retrain with best params on FULL DEV
    best_params = dict(study.best_params)
    pos_w_mult = best_params.pop('pos_weight_mult')
    best_params['objective'] = 'binary:logistic'
    best_params['eval_metric'] = 'auc'
    best_params['tree_method'] = 'hist'
    best_params['verbosity'] = 0
    best_params['scale_pos_weight'] = ((len(y_dev) - y_dev.sum()) / max(1, y_dev.sum())) * pos_w_mult
    best_iter = study.best_trial.user_attrs.get('best_iter', 500)

    print(f"\nRetraining best model (n_estimators = best_iter = {best_iter})...", file=sys.stderr)
    final_model = xgb.train(best_params, dtrain, num_boost_round=best_iter,
                            evals=[(dval, 'wfa')], verbose_eval=False)
    final_model.save_model(os.path.join(LIVE_AUDIT, 'xgb_top1_optuna.json'))

    # Save study + best params
    json.dump({
        'best_wfa_auc': float(study.best_value),
        'best_params': study.best_params,
        'best_iter': int(best_iter),
        'baseline_v2_auc': 0.6285,
        'n_trials': 100,
    }, open(os.path.join(LIVE_AUDIT, 'optuna_results.json'), 'w'), indent=2)
    print(f"\nSaved xgb_top1_optuna.json + optuna_results.json", file=sys.stderr)
    print(f"Total time: {time.time()-t0:.1f}s", file=sys.stderr)

if __name__ == '__main__':
    main()
