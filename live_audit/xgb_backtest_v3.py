"""
XGB Backtest v3 — uses Optuna-tuned model + tests ensemble.

Variants:
  - XGB-v2 (sample-weighted top-1%, baseline +127.47%)
  - XGB-Optuna (Optuna-tuned binary top-1%)
  - XGB-Ensemble (hill-climbed C+D blend)
"""
import csv, os, re, sys, json, time
from collections import Counter, defaultdict
import numpy as np
import xgboost as xgb

sys.path.insert(0, os.path.dirname(__file__))
from xgb_backtest import (
    LIVE_AUDIT, DFSOPTO, SLATES, FEE, N,
    ATLAS_EXPOSURE_CAP_HITTER, ATLAS_EXPOSURE_CAP_PITCHER, ATLAS_TEAM_STACK_CAP,
    STACKS_ANCHOR_HIT_CAP, STACKS_ANCHOR_PIT_CAP, STACKS_N_HIT_ANCHORS, STACKS_N_PIT_ANCHORS,
    norm, load_proj, load_pool, load_actuals, compute_features, compute_slate_stats,
    load_field_lineups, greedy_select, score_portfolio,
)

def main():
    print("Loading models...", file=sys.stderr)
    models = {}
    for name, path in [
        ('v2', 'xgb_top1_v2.json'),
        ('optuna', 'xgb_top1_optuna.json'),
        ('ens_C', 'xgb_ens_C_top1.json'),
        ('ens_D', 'xgb_ens_D_top5.json'),
    ]:
        p = os.path.join(LIVE_AUDIT, path)
        if not os.path.exists(p):
            print(f"  Skip {name}: {path} not found", file=sys.stderr); continue
        m = xgb.Booster(); m.load_model(p)
        models[name] = m
        print(f"  Loaded {name}", file=sys.stderr)

    if not models:
        print("No models found", file=sys.stderr); sys.exit(1)
    feature_cols = list(models.values())[0].feature_names

    # Ensemble weights
    ens_weights = None
    ens_path = os.path.join(LIVE_AUDIT, 'ensemble_weights.json')
    if os.path.exists(ens_path):
        ens_weights = json.load(open(ens_path))['best_weights']

    results = []
    for slate, proj_f, actuals_f, pool_f in SLATES:
        proj_path = os.path.join(DFSOPTO, proj_f); actuals_path = os.path.join(DFSOPTO, actuals_f); pool_path = os.path.join(DFSOPTO, pool_f)
        if not all(os.path.exists(p) for p in [proj_path, actuals_path, pool_path]): continue
        t0 = time.time()
        try:
            by_name, by_id = load_proj(proj_path)
            if not by_name: continue
            pool = load_pool(pool_path, by_id)
            if len(pool) < 100: continue
            entries_scores, player_fpts = load_actuals(actuals_path)
            if not entries_scores: continue
            field_norms = load_field_lineups(actuals_path)
            slate_stats = compute_slate_stats(by_name, field_norms)
            feats_rows = [compute_features(lu, by_name, slate_stats, slate_stats.get('pair_freq', {})) for lu in pool]
            valid_idx = [i for i, f in enumerate(feats_rows) if f is not None]
            if len(valid_idx) < 100: continue
            X = np.array([[feats_rows[i].get(c, 0) for c in feature_cols] for i in valid_idx], dtype=np.float32)
            dpool = xgb.DMatrix(X, feature_names=feature_cols)

            preds_per_model = {name: m.predict(dpool) for name, m in models.items()}

            # Ensemble blend (rank-based)
            ensemble_pred = None
            if ens_weights and 'ens_C' in preds_per_model and 'ens_D' in preds_per_model:
                from scipy.stats import rankdata
                rC = rankdata(preds_per_model['ens_C']) / len(preds_per_model['ens_C'])
                rD = rankdata(preds_per_model['ens_D']) / len(preds_per_model['ens_D'])
                ensemble_pred = ens_weights.get('C_top1', 0.4) * rC + ens_weights.get('D_top5', 0.6) * rD
                if 'B_top01' in ens_weights and 'B' in preds_per_model:
                    rB = rankdata(preds_per_model['B']) / len(preds_per_model['B'])
                    ensemble_pred += ens_weights['B_top01'] * rB

            # Anchors
            proj_in_pool = defaultdict(float)
            for lu in pool:
                for pos, r in lu:
                    nm = norm(r['name'])
                    if proj_in_pool[(pos, nm)] == 0: proj_in_pool[(pos, nm)] = r['proj']
            hitters = sorted([(nm, p) for (pos, nm), p in proj_in_pool.items() if pos != 'P'], key=lambda x: -x[1])
            pitchers = sorted([(nm, p) for (pos, nm), p in proj_in_pool.items() if pos == 'P'], key=lambda x: -x[1])
            anchor_ids = set([nm for nm, _ in hitters[:STACKS_N_HIT_ANCHORS]] + [nm for nm, _ in pitchers[:STACKS_N_PIT_ANCHORS]])

            # Build pool_scored per variant
            variant_results = {}

            def pool_for_score(score_arr):
                ps = []
                for j, i in enumerate(valid_idx):
                    lu = pool[i]
                    tc = Counter(); team_opp_map = {}
                    for pos, r in lu:
                        if pos == 'P': continue
                        tc[r['team']] += 1; team_opp_map[r['team']] = r['opp']
                    primary = max(tc.items(), key=lambda x: x[1])[0] if tc else None
                    bb = tc.get(team_opp_map.get(primary), 0) if primary else 0
                    ps.append({'lu': lu, 'bringback': bb, 'score': float(score_arr[j])})
                return ps

            # XGB-v2
            if 'v2' in preds_per_model:
                ps = pool_for_score(preds_per_model['v2'])
                selected = greedy_select(ps, 'score', False, anchor_ids)
                variant_results['v2'] = score_portfolio(selected, entries_scores, player_fpts)

            # XGB-Optuna
            if 'optuna' in preds_per_model:
                ps = pool_for_score(preds_per_model['optuna'])
                selected = greedy_select(ps, 'score', False, anchor_ids)
                variant_results['optuna'] = score_portfolio(selected, entries_scores, player_fpts)

            # XGB-Ensemble
            if ensemble_pred is not None:
                ps = pool_for_score(ensemble_pred)
                selected = greedy_select(ps, 'score', False, anchor_ids)
                variant_results['ensemble'] = score_portfolio(selected, entries_scores, player_fpts)

            results.append({'slate': slate, 'variants': variant_results})
            summary = " | ".join(f"{n}:{r['roi']:.0f}%/t1={r['top1']}" for n, r in variant_results.items())
            ts = (time.time() - t0)
            print(f"  {slate} ({ts:.1f}s): {summary}", file=sys.stderr)
        except Exception as e:
            print(f"  {slate}: error - {e}", file=sys.stderr)

    print(f"\n=== AGGREGATE 29-slate (v3 with Optuna + ensemble) ===")
    variants_seen = set()
    for r in results: variants_seen.update(r['variants'].keys())
    print(f"{'Variant':<14} {'ROI':>9} {'Profit':>8} {'top1':>6} {'top01':>6}")
    for v in sorted(variants_seen):
        cost = sum(r['variants'].get(v, {}).get('cost', 0) for r in results)
        pay = sum(r['variants'].get(v, {}).get('payout', 0) for r in results)
        roi = (pay/cost - 1) * 100 if cost > 0 else 0
        prof = sum(1 for r in results if r['variants'].get(v, {}).get('roi', 0) > 0)
        top1 = sum(r['variants'].get(v, {}).get('top1', 0) for r in results)
        top01 = sum(r['variants'].get(v, {}).get('top01', 0) for r in results)
        print(f"{v:<14} {roi:>8.2f}% {prof}/{len(results):<5} {top1:>6} {top01:>6}")

    json.dump({'rows': results}, open(os.path.join(LIVE_AUDIT, 'xgb_v3_results.json'), 'w'), indent=2, default=str)

if __name__ == '__main__':
    main()
