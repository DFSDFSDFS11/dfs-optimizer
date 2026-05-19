"""Backtest v5 Optuna model against v4 Optuna (+159.56%) baseline."""
import csv, os, re, sys, json, time
from collections import Counter, defaultdict
import numpy as np
import xgboost as xgb

sys.path.insert(0, os.path.dirname(__file__))
from xgb_backtest import (LIVE_AUDIT, DFSOPTO, SLATES, FEE, N,
    ATLAS_EXPOSURE_CAP_HITTER, ATLAS_EXPOSURE_CAP_PITCHER, ATLAS_TEAM_STACK_CAP,
    STACKS_ANCHOR_HIT_CAP, STACKS_ANCHOR_PIT_CAP, STACKS_N_HIT_ANCHORS, STACKS_N_PIT_ANCHORS,
    norm, load_proj, load_pool, load_actuals, compute_features, compute_slate_stats,
    load_field_lineups, greedy_select, score_portfolio)

# Add groupby feature computation for v5 backtest
sys.path.insert(0, os.path.dirname(__file__))
from factor_engine_v5_groupby import compute_groupby_features

def main():
    print("Loading v5 model...", file=sys.stderr)
    m_v4 = xgb.Booster(); m_v4.load_model(os.path.join(LIVE_AUDIT,'xgb_top1_optuna.json'))
    m_v5 = xgb.Booster(); m_v5.load_model(os.path.join(LIVE_AUDIT,'xgb_top1_v5.json'))
    v4_cols = m_v4.feature_names; v5_cols = m_v5.feature_names
    print(f"v4 features: {len(v4_cols)}, v5 features: {len(v5_cols)}", file=sys.stderr)

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

            # Compute v4 features (returns dict) AND groupby features for each lineup
            v4_feats = []; gb_feats = []
            for lu in pool:
                f4 = compute_features(lu, by_name, slate_stats, slate_stats.get('pair_freq', {}))
                v4_feats.append(f4)
                # For groupby: convert lu format from [(pos, rec)] to [(pos, name)] then call compute_groupby
                positions = [(pos, r['name']) for pos, r in lu]
                gf = compute_groupby_features(positions, by_name)
                gb_feats.append(gf)
            valid = [i for i, f in enumerate(v4_feats) if f is not None and gb_feats[i] is not None]
            if len(valid) < 100: continue

            # v4 prediction
            X4 = np.array([[v4_feats[i].get(c, 0) for c in v4_cols] for i in valid], dtype=np.float32)
            d4 = xgb.DMatrix(X4, feature_names=v4_cols)
            pred_v4 = m_v4.predict(d4)

            # v5 prediction (v4 features + groupby)
            X5_rows = []
            for i in valid:
                combined = {**v4_feats[i], **gb_feats[i]}
                X5_rows.append([combined.get(c, 0) for c in v5_cols])
            X5 = np.array(X5_rows, dtype=np.float32)
            d5 = xgb.DMatrix(X5, feature_names=v5_cols)
            pred_v5 = m_v5.predict(d5)

            # Anchors + pool_scored
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
            print(f"  {slate} ({time.time()-t0:.1f}s): v4 {v4_score['roi']:.0f}%/t1={v4_score['top1']} | v5 {v5_score['roi']:.0f}%/t1={v5_score['top1']}", file=sys.stderr)
        except Exception as e:
            print(f"  {slate}: {e}", file=sys.stderr)

    print(f"\n=== AGGREGATE v4 vs v5 ===")
    for v in ['v4', 'v5']:
        cost = sum(r[v]['cost'] for r in results)
        pay = sum(r[v]['payout'] for r in results)
        roi = (pay/cost - 1) * 100 if cost > 0 else 0
        prof = sum(1 for r in results if r[v]['roi'] > 0)
        top1 = sum(r[v]['top1'] for r in results)
        top01 = sum(r[v]['top01'] for r in results)
        print(f"  {v}: ROI {roi:.2f}% | Profitable {prof}/{len(results)} | top1 {top1} | top01 {top01}")

    json.dump({'rows': results}, open(os.path.join(LIVE_AUDIT,'v5_backtest_results.json'),'w'), indent=2, default=str)

if __name__ == '__main__':
    main()
