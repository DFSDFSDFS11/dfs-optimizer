"""Optuna TPE on v5 (213 features). Same setup as v4 Optuna (best AUC 0.6507)."""
import csv, os, sys, json, time
import numpy as np
import pandas as pd
import xgboost as xgb
import optuna
from sklearn.metrics import roc_auc_score
optuna.logging.set_verbosity(optuna.logging.WARNING)

LIVE_AUDIT = "C:/Users/colin/Projects/dfs-optimizer/live_audit"
LEAKY = {'pair_freq_sum','pair_freq_mean','pair_freq_max','pair_freq_top5_sum',
         'player_freq_sum','player_freq_max','player_freq_min','is_unique_lineup'}

def slate_to_date(s):
    parts = s.split('-')
    try: return pd.Timestamp(year=2000+int(parts[2]), month=int(parts[0]), day=int(parts[1]))
    except: return pd.NaT

def main():
    t0 = time.time()
    fdf = pd.read_csv(os.path.join(LIVE_AUDIT,'factor_frame_v5.csv'))
    fdf['date'] = fdf['slate'].apply(slate_to_date)
    fdf = fdf.dropna(subset=['date']).sort_values('date').reset_index(drop=True)
    splits = json.load(open(os.path.join(LIVE_AUDIT,'wfa_splits.json')))
    dev_set = set(splits['dev']); wfa_set = set(splits['wfa'])
    fdf['is_top1'] = (fdf['finish_pct'] >= 0.99).astype(int)
    exclude = {'contest_id','slate','rank','finish_pct','date','is_top1'} | LEAKY
    feature_cols = [c for c in fdf.columns if c not in exclude]
    dev_df = fdf[fdf['slate'].isin(dev_set)].copy()
    wfa_df = fdf[fdf['slate'].isin(wfa_set)].copy()
    X_dev = dev_df[feature_cols].fillna(0).values.astype(np.float32)
    X_wfa = wfa_df[feature_cols].fillna(0).values.astype(np.float32)
    y_dev = dev_df['is_top1'].values; y_wfa = wfa_df['is_top1'].values
    sw_dev = np.ones(len(dev_df))
    sw_dev[dev_df['finish_pct'].values >= 0.99] = 10
    sw_dev[dev_df['finish_pct'].values >= 0.999] = 100
    dtrain = xgb.DMatrix(X_dev, label=y_dev, weight=sw_dev, feature_names=feature_cols)
    dval = xgb.DMatrix(X_wfa, label=y_wfa, feature_names=feature_cols)
    print(f"v5: DEV {len(dev_df)} WFA {len(wfa_df)} features {len(feature_cols)} (loaded {time.time()-t0:.1f}s)", file=sys.stderr)

    def objective(trial):
        params = {
            'objective':'binary:logistic','eval_metric':'auc','tree_method':'hist','verbosity':0,
            'learning_rate': trial.suggest_float('learning_rate', 0.01, 0.1, log=True),
            'max_depth': trial.suggest_int('max_depth', 3, 8),
            'min_child_weight': trial.suggest_int('min_child_weight', 1, 200, log=True),
            'subsample': trial.suggest_float('subsample', 0.6, 1.0),
            'colsample_bytree': trial.suggest_float('colsample_bytree', 0.4, 1.0),
            'gamma': trial.suggest_float('gamma', 0.0, 1.0),
            'reg_alpha': trial.suggest_float('reg_alpha', 1e-3, 2.0, log=True),
            'reg_lambda': trial.suggest_float('reg_lambda', 1e-3, 2.0, log=True),
        }
        pos_w = (len(y_dev)-y_dev.sum())/max(1,y_dev.sum())
        params['scale_pos_weight'] = pos_w * trial.suggest_float('pw_mult', 0.5, 2.0)
        m = xgb.train(params, dtrain, num_boost_round=2000,
                      evals=[(dval,'wfa')], early_stopping_rounds=50, verbose_eval=False)
        trial.set_user_attr('best_iter', m.best_iteration)
        return roc_auc_score(y_wfa, m.predict(dval))

    print("Running Optuna on v5 (100 trials)...", file=sys.stderr)
    sampler = optuna.samplers.TPESampler(seed=42)
    study = optuna.create_study(direction='maximize', sampler=sampler)
    def cb(s, t):
        if t.number % 10 == 0:
            print(f"  Trial {t.number}: AUC={t.value:.4f} | best={s.best_value:.4f}", file=sys.stderr)
    study.optimize(objective, n_trials=100, callbacks=[cb])
    print(f"\nv5 Best AUC: {study.best_value:.4f} (v4 was 0.6507)", file=sys.stderr)

    best = dict(study.best_params)
    pw = best.pop('pw_mult')
    best.update({'objective':'binary:logistic','eval_metric':'auc','tree_method':'hist','verbosity':0,
                 'scale_pos_weight': ((len(y_dev)-y_dev.sum())/max(1,y_dev.sum())) * pw})
    best_iter = study.best_trial.user_attrs.get('best_iter', 500)
    m = xgb.train(best, dtrain, num_boost_round=best_iter, evals=[(dval,'wfa')], verbose_eval=False)
    m.save_model(os.path.join(LIVE_AUDIT,'xgb_top1_v5.json'))

    imp = m.get_score(importance_type='gain')
    imp_df = pd.DataFrame([{'feature':f,'gain':imp.get(f,0)} for f in feature_cols]).sort_values('gain', ascending=False)
    imp_df.to_csv(os.path.join(LIVE_AUDIT,'xgb_v5_importance.csv'), index=False)
    print(f"\nTop 20 features (v5):", file=sys.stderr)
    print(imp_df.head(20).to_string(index=False), file=sys.stderr)

    json.dump({'best_wfa_auc':float(study.best_value),'best_params':study.best_params,
               'best_iter':int(best_iter),'v4_baseline_auc':0.6507,'n_features':len(feature_cols)},
              open(os.path.join(LIVE_AUDIT,'optuna_v5_results.json'),'w'), indent=2)
    print(f"Total: {time.time()-t0:.1f}s", file=sys.stderr)

if __name__ == '__main__':
    main()
