"""
RIGHT-WAY XGBOOST RETRAIN (per ML bias-defense protocol).

Protocol:
  1. STRICT temporal split: first 70% slates = TRAIN+TUNE, last 30% = HOLDOUT.
     HOLDOUT is never seen during training or hyperparameter tuning.
  2. Optuna objective = purged k-fold CV AUC within TRAIN+TUNE (k=4, embargo=1).
     This is the López de Prado standard. NOT WFA AUC at small N.
  3. Train final model on full TRAIN+TUNE with best params.
  4. Headline ROI = score on HOLDOUT slates only. This is the honest number.
  5. Champion gate: compare headline vs BB25 ROI on the same HOLDOUT slates.

Args:
  --feature-set v4 | v5   (default v5)
  --trials N              (default 60)
"""
import argparse, csv, os, re, sys, json, time
from collections import Counter, defaultdict
import numpy as np
import pandas as pd
import xgboost as xgb
import optuna
from sklearn.metrics import roc_auc_score
optuna.logging.set_verbosity(optuna.logging.WARNING)

sys.path.insert(0, os.path.dirname(__file__))
from xgb_backtest import (LIVE_AUDIT, DFSOPTO, SLATES, FEE, N,
    STACKS_N_HIT_ANCHORS, STACKS_N_PIT_ANCHORS,
    norm, load_proj, load_pool, load_actuals, compute_features, compute_slate_stats,
    load_field_lineups, greedy_select, score_portfolio)
from factor_engine_v5_groupby import compute_groupby_features

LEAKY = {'pair_freq_sum','pair_freq_mean','pair_freq_max','pair_freq_top5_sum',
         'player_freq_sum','player_freq_max','player_freq_min','is_unique_lineup'}

def slate_to_date(s):
    parts = s.split('-')
    try: return pd.Timestamp(year=2000+int(parts[2]), month=int(parts[0]), day=int(parts[1]))
    except: return pd.NaT

def purged_cv_auc(X, y, sw, feat_cols, params, n_rounds, train_slate_ids, k=4, embargo=1):
    """Purged k-fold CV with embargo. Returns mean AUC."""
    unique = sorted(set(train_slate_ids), key=slate_to_date)
    n = len(unique)
    fold_size = max(1, n // k)
    aucs = []
    for fi in range(k):
        v_lo = fi * fold_size
        v_hi = (fi+1) * fold_size if fi < k-1 else n
        val_slates = set(unique[v_lo:v_hi])
        e_lo = max(0, v_lo - embargo); e_hi = min(n, v_hi + embargo)
        embargo_slates = set(unique[e_lo:e_hi])
        train_mask = np.array([s not in embargo_slates for s in train_slate_ids])
        val_mask   = np.array([s in val_slates for s in train_slate_ids])
        if val_mask.sum() < 2 or y[val_mask].sum() < 1: continue
        dtr = xgb.DMatrix(X[train_mask], label=y[train_mask], weight=sw[train_mask], feature_names=feat_cols)
        dva = xgb.DMatrix(X[val_mask], label=y[val_mask], feature_names=feat_cols)
        m = xgb.train(params, dtr, num_boost_round=n_rounds, verbose_eval=False)
        pred = m.predict(dva)
        aucs.append(roc_auc_score(y[val_mask], pred))
    return float(np.mean(aucs)) if aucs else 0.5

def evaluate_lineups(model, feat_cols, feat_fn, slate_set):
    """Score the model on a set of slates and return aggregate stats."""
    results = []
    for slate, proj_f, actuals_f, pool_f in SLATES:
        if slate not in slate_set: continue
        proj_path = os.path.join(DFSOPTO, proj_f)
        actuals_path = os.path.join(DFSOPTO, actuals_f)
        pool_path = os.path.join(DFSOPTO, pool_f)
        if not all(os.path.exists(p) for p in [proj_path, actuals_path, pool_path]): continue
        try:
            by_name, by_id = load_proj(proj_path)
            if not by_name: continue
            pool = load_pool(pool_path, by_id)
            if len(pool) < 100: continue
            entries_scores, player_fpts = load_actuals(actuals_path)
            if not entries_scores: continue
            field_norms = load_field_lineups(actuals_path)
            slate_stats = compute_slate_stats(by_name, field_norms)

            feats = []
            for lu in pool:
                f = feat_fn(lu, by_name, slate_stats)
                feats.append(f)
            valid = [i for i, f in enumerate(feats) if f is not None]
            if len(valid) < 100: continue
            X = np.array([[feats[i].get(c, 0) for c in feat_cols] for i in valid], dtype=np.float32)
            d = xgb.DMatrix(X, feature_names=feat_cols)
            pred = model.predict(d)

            proj_in_pool = defaultdict(float)
            for lu in pool:
                for pos, r in lu:
                    nm = norm(r['name'])
                    if proj_in_pool[(pos, nm)] == 0: proj_in_pool[(pos, nm)] = r['proj']
            hitters = sorted([(nm, p) for (pos, nm), p in proj_in_pool.items() if pos != 'P'], key=lambda x: -x[1])
            pitchers = sorted([(nm, p) for (pos, nm), p in proj_in_pool.items() if pos == 'P'], key=lambda x: -x[1])
            anchor_ids = set([nm for nm,_ in hitters[:STACKS_N_HIT_ANCHORS]] + [nm for nm,_ in pitchers[:STACKS_N_PIT_ANCHORS]])

            scored = []
            for j, i in enumerate(valid):
                lu = pool[i]; tc = Counter(); to = {}
                for pos, r in lu:
                    if pos == 'P': continue
                    tc[r['team']] += 1; to[r['team']] = r['opp']
                pri = max(tc.items(), key=lambda x: x[1])[0] if tc else None
                bb = tc.get(to.get(pri), 0) if pri else 0
                scored.append({'lu': lu, 'bringback': bb, 'score': float(pred[j])})
            port = greedy_select(scored, 'score', False, anchor_ids)
            sc = score_portfolio(port, entries_scores, player_fpts)
            results.append({'slate': slate, **sc})
        except Exception as e:
            print(f"  {slate}: {e}", file=sys.stderr)
    return results

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--feature-set', choices=['v4','v5'], default='v5')
    ap.add_argument('--trials', type=int, default=60)
    args = ap.parse_args()

    t0 = time.time()
    print(f"=== RIGHT-WAY RETRAIN: feature-set={args.feature_set}, trials={args.trials} ===", file=sys.stderr)

    # Load factor frame
    ff = pd.read_csv(os.path.join(LIVE_AUDIT, f'factor_frame_{args.feature_set}.csv'))
    ff['date'] = ff['slate'].apply(slate_to_date)
    ff = ff.dropna(subset=['date']).sort_values('date').reset_index(drop=True)
    ff['is_top1'] = (ff['finish_pct'] >= 0.99).astype(int)

    # Strict temporal split: first 70% slates = train+tune, last 30% = HOLDOUT
    unique_slates = sorted(ff['slate'].unique(), key=slate_to_date)
    n_total = len(unique_slates)
    split_idx = int(n_total * 0.70)
    TRAIN_SLATES = set(unique_slates[:split_idx])
    HOLDOUT_SLATES = set(unique_slates[split_idx:])
    print(f"TRAIN+TUNE slates ({len(TRAIN_SLATES)}): {sorted(TRAIN_SLATES, key=slate_to_date)}", file=sys.stderr)
    print(f"HOLDOUT slates  ({len(HOLDOUT_SLATES)}): {sorted(HOLDOUT_SLATES, key=slate_to_date)}", file=sys.stderr)

    # Features
    exclude = {'contest_id','slate','rank','finish_pct','date','is_top1'} | LEAKY
    feat_cols = [c for c in ff.columns if c not in exclude]
    print(f"Features: {len(feat_cols)}", file=sys.stderr)

    tt = ff[ff['slate'].isin(TRAIN_SLATES)].copy()
    X = tt[feat_cols].fillna(0).values.astype(np.float32)
    y = tt['is_top1'].values
    sw = np.ones(len(tt))
    sw[tt['finish_pct'].values >= 0.99] = 10
    sw[tt['finish_pct'].values >= 0.999] = 100
    train_slate_ids = tt['slate'].values
    pos_w_base = (len(y) - y.sum()) / max(1, y.sum())
    print(f"TRAIN+TUNE rows: {len(tt)}, positives: {y.sum()}, pos_w base: {pos_w_base:.2f}", file=sys.stderr)

    # Optuna with purged k-fold CV as objective
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
        pw_mult = trial.suggest_float('pw_mult', 0.5, 2.0)
        params['scale_pos_weight'] = pos_w_base * pw_mult
        n_rounds = trial.suggest_int('n_rounds', 100, 600)
        auc = purged_cv_auc(X, y, sw, feat_cols, params, n_rounds, train_slate_ids, k=4, embargo=1)
        return auc

    print(f"\nRunning Optuna with PURGED K-FOLD CV objective ({args.trials} trials)...", file=sys.stderr)
    sampler = optuna.samplers.TPESampler(seed=42)
    study = optuna.create_study(direction='maximize', sampler=sampler)
    def cb(s, t):
        if t.number % 10 == 0:
            print(f"  Trial {t.number}: AUC={t.value:.4f} | best={s.best_value:.4f}", file=sys.stderr)
    study.optimize(objective, n_trials=args.trials, callbacks=[cb])
    print(f"\nBest purged-CV AUC: {study.best_value:.4f}", file=sys.stderr)
    print(f"Best params: {study.best_params}", file=sys.stderr)

    # Train final model on full TRAIN+TUNE with best params
    best = dict(study.best_params)
    pw_mult = best.pop('pw_mult'); n_rounds = best.pop('n_rounds')
    best.update({'objective':'binary:logistic','eval_metric':'auc','tree_method':'hist','verbosity':0,
                 'scale_pos_weight': pos_w_base * pw_mult})
    dfull = xgb.DMatrix(X, label=y, weight=sw, feature_names=feat_cols)
    final = xgb.train(best, dfull, num_boost_round=n_rounds, verbose_eval=False)
    suffix = args.feature_set
    final.save_model(os.path.join(LIVE_AUDIT, f'xgb_right_{suffix}.json'))
    print(f"\nFinal model saved: xgb_right_{suffix}.json", file=sys.stderr)

    # Feature fn
    if args.feature_set == 'v4':
        def feat_fn(lu, by_name, slate_stats):
            return compute_features(lu, by_name, slate_stats, slate_stats.get('pair_freq', {}))
    else:
        def feat_fn(lu, by_name, slate_stats):
            f = compute_features(lu, by_name, slate_stats, slate_stats.get('pair_freq', {}))
            if f is None: return None
            positions = [(pos, r['name']) for pos, r in lu]
            gf = compute_groupby_features(positions, by_name)
            if gf is None: return None
            return {**f, **gf}

    # HOLDOUT eval (the headline number)
    print(f"\nEvaluating on HOLDOUT slates ({len(HOLDOUT_SLATES)})...", file=sys.stderr)
    holdout_res = evaluate_lineups(final, feat_cols, feat_fn, HOLDOUT_SLATES)
    h_cost = sum(r['cost'] for r in holdout_res)
    h_pay = sum(r['payout'] for r in holdout_res)
    h_roi = (h_pay/h_cost - 1)*100 if h_cost > 0 else 0
    h_prof = sum(1 for r in holdout_res if r['roi'] > 0)
    h_t1 = sum(r['top1'] for r in holdout_res)
    print(f"HOLDOUT result: ROI {h_roi:.2f}% | {h_prof}/{len(holdout_res)} profitable | top1 {h_t1}", file=sys.stderr)

    # Champion gate: compare to BB25 on same HOLDOUT slates
    mm = json.load(open(os.path.join(DFSOPTO, 'methods_multi_results.json')))
    mm_by_slate = {r['slate']: r['variants'] for r in mm['rows']}
    bb25_holdout = [(s, mm_by_slate[s]['BB25']) for s in HOLDOUT_SLATES if s in mm_by_slate]
    bb_cost = sum(v['cost'] for _, v in bb25_holdout)
    bb_pay = sum(v['payout'] for _, v in bb25_holdout)
    bb_roi = (bb_pay/bb_cost - 1)*100 if bb_cost > 0 else 0
    bb_prof = sum(1 for _, v in bb25_holdout if v['roi'] > 0)
    bb_t1 = sum(v['top1'] for _, v in bb25_holdout)
    print(f"BB25 same HOLDOUT: ROI {bb_roi:.2f}% | {bb_prof}/{len(bb25_holdout)} profitable | top1 {bb_t1}", file=sys.stderr)

    # Atlas comparison
    atlas_holdout = [(s, mm_by_slate[s]['Atlas']) for s in HOLDOUT_SLATES if s in mm_by_slate]
    a_cost = sum(v['cost'] for _, v in atlas_holdout)
    a_pay = sum(v['payout'] for _, v in atlas_holdout)
    a_roi = (a_pay/a_cost - 1)*100 if a_cost > 0 else 0

    # Per-slate detail
    print(f"\n=== PER-SLATE HOLDOUT DETAIL ===", file=sys.stderr)
    print(f"{'slate':<22} {'XGB-right':>12} {'BB25':>12} {'Atlas':>12} {'winner':>10}", file=sys.stderr)
    for r in holdout_res:
        xgr = r['roi']
        bbr = mm_by_slate.get(r['slate'], {}).get('BB25', {}).get('roi', None)
        atr = mm_by_slate.get(r['slate'], {}).get('Atlas', {}).get('roi', None)
        winner = 'XGB-right'
        if bbr is not None and bbr > xgr and (atr is None or bbr > atr): winner = 'BB25'
        elif atr is not None and atr > xgr and (bbr is None or atr > bbr): winner = 'Atlas'
        bbr_s = f"{bbr:+.1f}%" if bbr is not None else "n/a"
        atr_s = f"{atr:+.1f}%" if atr is not None else "n/a"
        print(f"  {r['slate']:<20} {xgr:>+11.1f}% {bbr_s:>12} {atr_s:>12} {winner:>10}", file=sys.stderr)

    # Final verdict
    print(f"\n{'='*72}", file=sys.stderr)
    print(f"RIGHT-WAY RETRAIN VERDICT ({args.feature_set} features)", file=sys.stderr)
    print(f"{'='*72}", file=sys.stderr)
    print(f"  XGB-right ({suffix}): {h_roi:+.2f}% on HOLDOUT ({len(holdout_res)} slates)", file=sys.stderr)
    print(f"  BB25 same slates:     {bb_roi:+.2f}%", file=sys.stderr)
    print(f"  Atlas same slates:    {a_roi:+.2f}%", file=sys.stderr)
    print(f"  Champion gate: {'XGB-right BEATS BB25' if h_roi > bb_roi else 'XGB-right LOSES to BB25'}", file=sys.stderr)

    # Save
    out = {
        'feature_set': args.feature_set,
        'n_trials': args.trials,
        'best_purged_cv_auc': float(study.best_value),
        'best_params': study.best_params,
        'train_slates': sorted(list(TRAIN_SLATES), key=slate_to_date),
        'holdout_slates': sorted(list(HOLDOUT_SLATES), key=slate_to_date),
        'holdout_results': [{'slate':r['slate'],'roi':r['roi'],'cost':r['cost'],'payout':r['payout'],'top1':r['top1']} for r in holdout_res],
        'xgb_right_holdout_roi': h_roi,
        'bb25_holdout_roi': bb_roi,
        'atlas_holdout_roi': a_roi,
        'champion_gate_passed': h_roi > bb_roi,
    }
    json.dump(out, open(os.path.join(LIVE_AUDIT, f'right_retrain_{suffix}_results.json'), 'w'), indent=2, default=str)
    print(f"\nResults saved to right_retrain_{suffix}_results.json", file=sys.stderr)
    print(f"Total: {time.time()-t0:.1f}s", file=sys.stderr)

if __name__ == '__main__':
    main()
