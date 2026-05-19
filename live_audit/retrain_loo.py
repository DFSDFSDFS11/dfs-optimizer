"""
GOLD-STANDARD LEAVE-ONE-OUT RETRAINING.

For each of the 29 backtest slates S:
  1. Hold out S entirely from training data
  2. Retrain v4 (125 features) and v5 (201 features) with the already-selected
     Optuna hyperparameters on all-other-slates
  3. Predict on slate S's lineup pool
  4. Score lineups against contest actuals
  5. Aggregate across all 29 retrains

This is the honest measure of generalization. The original +358%/+159.56% had
the test slate inside the training set for some splits — this fixes that.

Uses xgb_top1_optuna.json's params for v4 retrains, xgb_top1_v5.json's params for v5.
"""
import csv, os, re, sys, json, time
from collections import Counter, defaultdict
import numpy as np
import pandas as pd
import xgboost as xgb

sys.path.insert(0, os.path.dirname(__file__))
from xgb_backtest import (LIVE_AUDIT, DFSOPTO, SLATES, FEE, N,
    STACKS_N_HIT_ANCHORS, STACKS_N_PIT_ANCHORS,
    norm, load_proj, load_pool, load_actuals, compute_features, compute_slate_stats,
    load_field_lineups, greedy_select, score_portfolio)
from factor_engine_v5_groupby import compute_groupby_features

LEAKY = {'pair_freq_sum','pair_freq_mean','pair_freq_max','pair_freq_top5_sum',
         'player_freq_sum','player_freq_max','player_freq_min','is_unique_lineup'}

def load_xgb_params(opt_json_path, model_path, pw_mult_key='pos_weight_mult'):
    """Load Optuna best params + feature names from saved model."""
    opt = json.load(open(opt_json_path))
    bp = dict(opt['best_params'])
    pw_mult = bp.pop(pw_mult_key, bp.pop('pw_mult', 1.0))
    params = {
        'objective':'binary:logistic','eval_metric':'auc','tree_method':'hist','verbosity':0,
        **bp,
    }
    n_rounds = int(opt['best_iter'])
    m = xgb.Booster(); m.load_model(model_path)
    feature_names = m.feature_names
    return params, n_rounds, feature_names, pw_mult

def train_model(X, y, sw, feature_names, params, n_rounds, pw_mult):
    p = dict(params)
    pos_w = (len(y) - y.sum()) / max(1, y.sum())
    p['scale_pos_weight'] = pos_w * pw_mult
    dtr = xgb.DMatrix(X, label=y, weight=sw, feature_names=feature_names)
    m = xgb.train(p, dtr, num_boost_round=n_rounds, verbose_eval=False)
    return m

def main():
    t0 = time.time()
    print("Loading params from Optuna results...", file=sys.stderr)
    v4_params, v4_rounds, v4_features, v4_pw = load_xgb_params(
        os.path.join(LIVE_AUDIT,'optuna_results.json'),
        os.path.join(LIVE_AUDIT,'xgb_top1_optuna.json'),
        pw_mult_key='pos_weight_mult')
    v5_params, v5_rounds, v5_features, v5_pw = load_xgb_params(
        os.path.join(LIVE_AUDIT,'optuna_v5_results.json'),
        os.path.join(LIVE_AUDIT,'xgb_top1_v5.json'),
        pw_mult_key='pw_mult')
    print(f"  v4: {len(v4_features)} feats, {v4_rounds} rounds, pw_mult={v4_pw:.3f}", file=sys.stderr)
    print(f"  v5: {len(v5_features)} feats, {v5_rounds} rounds, pw_mult={v5_pw:.3f}", file=sys.stderr)

    print("Loading factor frames (v4 base, v5 with groupby)...", file=sys.stderr)
    v4_df = pd.read_csv(os.path.join(LIVE_AUDIT,'factor_frame_v4.csv'))
    v5_df = pd.read_csv(os.path.join(LIVE_AUDIT,'factor_frame_v5.csv'))
    v4_df['is_top1'] = (v4_df['finish_pct'] >= 0.99).astype(int)
    v5_df['is_top1'] = (v5_df['finish_pct'] >= 0.99).astype(int)

    # Build slate->index mappings for fast lookup
    print(f"Available slates in v4_df: {sorted(v4_df['slate'].unique())[:5]}... ({v4_df['slate'].nunique()})", file=sys.stderr)
    print(f"Available slates in v5_df: {v5_df['slate'].nunique()}", file=sys.stderr)

    results = []
    for slate, proj_f, actuals_f, pool_f in SLATES:
        proj_path = os.path.join(DFSOPTO, proj_f)
        actuals_path = os.path.join(DFSOPTO, actuals_f)
        pool_path = os.path.join(DFSOPTO, pool_f)
        if not all(os.path.exists(p) for p in [proj_path, actuals_path, pool_path]):
            print(f"  {slate}: skip (files missing)", file=sys.stderr); continue

        ts = time.time()
        try:
            # Build LOO training set: all slates except this one
            v4_train = v4_df[v4_df['slate'] != slate].copy()
            v5_train = v5_df[v5_df['slate'] != slate].copy()

            v4_feat_cols = [c for c in v4_features if c in v4_train.columns]
            v5_feat_cols = [c for c in v5_features if c in v5_train.columns]

            # Sample weights (top-finisher boost)
            sw4 = np.ones(len(v4_train))
            sw4[v4_train['finish_pct'].values >= 0.99] = 10
            sw4[v4_train['finish_pct'].values >= 0.999] = 100
            sw5 = np.ones(len(v5_train))
            sw5[v5_train['finish_pct'].values >= 0.99] = 10
            sw5[v5_train['finish_pct'].values >= 0.999] = 100

            X4 = v4_train[v4_feat_cols].fillna(0).values.astype(np.float32)
            y4 = v4_train['is_top1'].values
            X5 = v5_train[v5_feat_cols].fillna(0).values.astype(np.float32)
            y5 = v5_train['is_top1'].values

            # Retrain
            m4 = train_model(X4, y4, sw4, v4_feat_cols, v4_params, v4_rounds, v4_pw)
            m5 = train_model(X5, y5, sw5, v5_feat_cols, v5_params, v5_rounds, v5_pw)

            # Score this slate's pool
            by_name, by_id = load_proj(proj_path)
            if not by_name: continue
            pool = load_pool(pool_path, by_id)
            if len(pool) < 100: continue
            entries_scores, player_fpts = load_actuals(actuals_path)
            if not entries_scores: continue
            field_norms = load_field_lineups(actuals_path)
            slate_stats = compute_slate_stats(by_name, field_norms)

            v4_feats = []; v5_feats_combined = []
            for lu in pool:
                f4 = compute_features(lu, by_name, slate_stats, slate_stats.get('pair_freq', {}))
                v4_feats.append(f4)
                positions = [(pos, r['name']) for pos, r in lu]
                gf = compute_groupby_features(positions, by_name)
                if f4 is not None and gf is not None:
                    v5_feats_combined.append({**f4, **gf})
                else:
                    v5_feats_combined.append(None)
            valid = [i for i, f in enumerate(v4_feats) if f is not None and v5_feats_combined[i] is not None]
            if len(valid) < 100: continue

            Xp4 = np.array([[v4_feats[i].get(c, 0) for c in v4_feat_cols] for i in valid], dtype=np.float32)
            Xp5 = np.array([[v5_feats_combined[i].get(c, 0) for c in v5_feat_cols] for i in valid], dtype=np.float32)
            d4 = xgb.DMatrix(Xp4, feature_names=v4_feat_cols)
            d5 = xgb.DMatrix(Xp5, feature_names=v5_feat_cols)
            pred_v4 = m4.predict(d4)
            pred_v5 = m5.predict(d5)

            # Anchors
            proj_in_pool = defaultdict(float)
            for lu in pool:
                for pos, r in lu:
                    nm = norm(r['name'])
                    if proj_in_pool[(pos, nm)] == 0: proj_in_pool[(pos, nm)] = r['proj']
            hitters = sorted([(nm, p) for (pos, nm), p in proj_in_pool.items() if pos != 'P'], key=lambda x: -x[1])
            pitchers = sorted([(nm, p) for (pos, nm), p in proj_in_pool.items() if pos == 'P'], key=lambda x: -x[1])
            anchor_ids = set([nm for nm,_ in hitters[:STACKS_N_HIT_ANCHORS]] + [nm for nm,_ in pitchers[:STACKS_N_PIT_ANCHORS]])

            def make_pool(pred):
                ps = []
                for j, i in enumerate(valid):
                    lu = pool[i]
                    tc = Counter(); team_opp = {}
                    for pos, r in lu:
                        if pos == 'P': continue
                        tc[r['team']] += 1; team_opp[r['team']] = r['opp']
                    primary = max(tc.items(), key=lambda x: x[1])[0] if tc else None
                    bb = tc.get(team_opp.get(primary), 0) if primary else 0
                    ps.append({'lu': lu, 'bringback': bb, 'score': float(pred[j])})
                return ps

            v4_port = greedy_select(make_pool(pred_v4), 'score', False, anchor_ids)
            v5_port = greedy_select(make_pool(pred_v5), 'score', False, anchor_ids)
            v4_score = score_portfolio(v4_port, entries_scores, player_fpts)
            v5_score = score_portfolio(v5_port, entries_scores, player_fpts)

            results.append({'slate': slate, 'v4': v4_score, 'v5': v5_score})
            print(f"  {slate} ({time.time()-ts:.1f}s): LOO v4 {v4_score['roi']:.0f}%/t1={v4_score['top1']} | LOO v5 {v5_score['roi']:.0f}%/t1={v5_score['top1']}", file=sys.stderr)

            # Incrementally save
            json.dump({'rows': results}, open(os.path.join(LIVE_AUDIT,'loo_retrain_results.json'),'w'), indent=2, default=str)
        except Exception as e:
            import traceback; traceback.print_exc(file=sys.stderr)
            print(f"  {slate}: {e}", file=sys.stderr)

    print(f"\n=== LOO RETRAIN AGGREGATE ({len(results)} slates) ===")
    for v in ['v4', 'v5']:
        cost = sum(r[v]['cost'] for r in results)
        pay = sum(r[v]['payout'] for r in results)
        roi = (pay/cost - 1) * 100 if cost > 0 else 0
        prof = sum(1 for r in results if r[v]['roi'] > 0)
        top1 = sum(r[v]['top1'] for r in results)
        print(f"  {v}: ROI {roi:.2f}% | Profitable {prof}/{len(results)} | top1 {top1}")
    print(f"\nTotal: {time.time()-t0:.1f}s")

if __name__ == '__main__':
    main()
