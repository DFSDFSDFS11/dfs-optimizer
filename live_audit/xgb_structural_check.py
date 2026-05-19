"""
Check XGB-Top1 structural similarity to pros via the 5-principle Mahalanobis framework.
Same metrics used to validate Atlas / BB25 / etc.

Re-runs xgb_backtest but computes:
  - projRatioToOptimal
  - ceilingRatioToOptimal
  - avgPlayerOwnPctile
  - ownStdRatio
  - ownDeltaFromAnchor
  - Mahalanobis distance to 7-pro consensus

Compare XGB-Top1 vs BB25 vs Atlas baseline.
"""
import csv, os, re, sys, json
from collections import Counter, defaultdict
import numpy as np
import pandas as pd
import xgboost as xgb

# Reuse logic from xgb_backtest
sys.path.insert(0, os.path.dirname(__file__))
from xgb_backtest import (
    LIVE_AUDIT, DFSOPTO, SLATES, FEE, N,
    ATLAS_EXPOSURE_CAP_HITTER, ATLAS_EXPOSURE_CAP_PITCHER, ATLAS_TEAM_STACK_CAP,
    STACKS_ANCHOR_HIT_CAP, STACKS_ANCHOR_PIT_CAP, STACKS_N_HIT_ANCHORS, STACKS_N_PIT_ANCHORS,
    BB25_TARGET, BB25_2_TARGET, BB25_3_TARGET,
    norm, load_proj, load_pool, load_actuals, compute_features, compute_slate_stats,
    load_field_lineups, greedy_select, score_portfolio,
)

UNIVERSAL_METRICS = ['projRatioToOptimal', 'ceilingRatioToOptimal', 'avgPlayerOwnPctile', 'ownStdRatio', 'ownDeltaFromAnchor']

def compute_slate_pro_stats(by_name, field_norms):
    """Compute optimal lineup proj/ceiling + chalk anchor own + per-player own percentile."""
    players = list(by_name.values())
    # Optimal: use field-best as proxy (any actually-played lineup)
    optProj = optCeil = 0
    lineup_avg_owns = []
    for names in field_norms:
        proj_sum = own_sum = ceil_sum = 0
        for nm in names:
            r = by_name.get(nm)
            if not r: continue
            proj_sum += r['proj']
            own_sum += r['own']
            ceil_sum += r['ceil_85'] or (r['proj'] * 1.4)
        if proj_sum > optProj: optProj = proj_sum
        if ceil_sum > optCeil: optCeil = ceil_sum
        lineup_avg_owns.append({'meanOwn': own_sum / max(1, len(names))})
    lineup_avg_owns.sort(key=lambda x: -x['meanOwn'])
    chalk_anchor = np.mean([x['meanOwn'] for x in lineup_avg_owns[:100]]) if lineup_avg_owns else 0
    slate_avg_own = np.mean([r['own'] for r in players]) if players else 0
    # Per-player own percentile
    sorted_by_own = sorted(players, key=lambda r: r['own'])
    own_pctile = {}
    for i, r in enumerate(sorted_by_own):
        own_pctile[norm(r['name'])] = i / max(1, len(sorted_by_own) - 1)
    return {'optProj': optProj, 'optCeil': optCeil, 'chalk_anchor': chalk_anchor,
            'slate_avg_own': slate_avg_own, 'own_pctile': own_pctile}

def compute_universal(lineups, stats):
    """Compute 5-principle Universal Metrics matching atlas-vs-stacks-backtest."""
    if not lineups: return {k: 0 for k in UNIVERSAL_METRICS}
    luProj = []; luCeil = []; luOwn = []; luOwnStd = []; pctileSum = []
    for cand in lineups:
        lu = cand['lu']
        owns = [r['own'] for pos, r in lu]
        luOwn.append(np.mean(owns))
        luProj.append(sum(r['proj'] for pos, r in lu))
        luCeil.append(sum((r['ceil_85'] or (r['proj'] * 1.4)) for pos, r in lu))
        luOwnStd.append(np.std(owns))
        pSum = sum(stats['own_pctile'].get(norm(r['name']), 0) for pos, r in lu)
        pctileSum.append(pSum / max(1, len(lu)))
    return {
        'projRatioToOptimal': np.mean(luProj) / stats['optProj'] if stats['optProj'] > 0 else 0,
        'ceilingRatioToOptimal': np.mean(luCeil) / stats['optCeil'] if stats['optCeil'] > 0 else 0,
        'avgPlayerOwnPctile': np.mean(pctileSum),
        'ownStdRatio': np.mean(luOwnStd) / stats['slate_avg_own'] if stats['slate_avg_own'] > 0 else 0,
        'ownDeltaFromAnchor': np.mean(luOwn) - stats['chalk_anchor'],
    }

def main():
    # Load consensus
    cons_path = os.path.join(DFSOPTO, 'pro_consensus_slate_relative.json')
    if not os.path.exists(cons_path):
        print(f"No consensus file at {cons_path}, skipping mahal", file=sys.stderr)
        cons = None
    else:
        consRaw = json.load(open(cons_path))
        cons = {}
        for k in UNIVERSAL_METRICS:
            for entry in consRaw['metrics'].get(k, []):
                if entry['slate'] not in cons: cons[entry['slate']] = {}
                cons[entry['slate']][k] = {'mean': entry['mean'], 'std': entry['std']}

    def mahal(metrics, slate):
        if not cons or slate not in cons: return None
        c = cons[slate]
        sum_sq = 0; n = 0
        for k in UNIVERSAL_METRICS:
            cc = c.get(k)
            if not cc or cc['std'] < 1e-9: continue
            d = (metrics[k] - cc['mean']) / cc['std']
            sum_sq += d * d; n += 1
        return np.sqrt(sum_sq / n) if n > 0 else None

    # Load XGB model (leak-free)
    reg_model = xgb.Booster(); reg_model.load_model(os.path.join(LIVE_AUDIT, 'xgb_reg_noleak.json'))
    clf_model = xgb.Booster(); clf_model.load_model(os.path.join(LIVE_AUDIT, 'xgb_clf_noleak.json'))
    feature_cols = reg_model.feature_names

    # Per-slate
    structural_rows = []
    for slate, proj_f, actuals_f, pool_f in SLATES:
        proj_path = os.path.join(DFSOPTO, proj_f); actuals_path = os.path.join(DFSOPTO, actuals_f); pool_path = os.path.join(DFSOPTO, pool_f)
        if not all(os.path.exists(p) for p in [proj_path, actuals_path, pool_path]): continue
        by_name, by_id = load_proj(proj_path)
        if not by_name: continue
        pool = load_pool(pool_path, by_id)
        if len(pool) < 100: continue
        entries_scores, player_fpts = load_actuals(actuals_path)
        field_norms = load_field_lineups(actuals_path)
        slate_stats = compute_slate_stats(by_name, field_norms)
        pro_stats = compute_slate_pro_stats(by_name, field_norms)

        # Compute features
        feats_rows = []
        for lu in pool:
            f = compute_features(lu, by_name, slate_stats, slate_stats.get('pair_freq', {}))
            feats_rows.append(f)
        valid_idx = [i for i, f in enumerate(feats_rows) if f is not None]
        if len(valid_idx) < 100: continue
        X = np.array([[feats_rows[i].get(c, 0) for c in feature_cols] for i in valid_idx], dtype=np.float32)
        dpool = xgb.DMatrix(X, feature_names=feature_cols)
        pred_top1 = clf_model.predict(dpool)

        # Anchors
        proj_in_pool = defaultdict(float)
        for lu in pool:
            for pos, r in lu:
                nm = norm(r['name'])
                if proj_in_pool[(pos, nm)] == 0: proj_in_pool[(pos, nm)] = r['proj']
        hitters = sorted([(nm, p) for (pos, nm), p in proj_in_pool.items() if pos != 'P'], key=lambda x: -x[1])
        pitchers = sorted([(nm, p) for (pos, nm), p in proj_in_pool.items() if pos == 'P'], key=lambda x: -x[1])
        anchor_ids = set([nm for nm, _ in hitters[:STACKS_N_HIT_ANCHORS]] + [nm for nm, _ in pitchers[:STACKS_N_PIT_ANCHORS]])

        # Pool with scores + bringback
        pool_scored = []
        for j, i in enumerate(valid_idx):
            lu = pool[i]
            tc = Counter(); team_opp_map = {}
            for pos, r in lu:
                if pos == 'P': continue
                tc[r['team']] += 1; team_opp_map[r['team']] = r['opp']
            primary = max(tc.items(), key=lambda x: x[1])[0] if tc else None
            bb = tc.get(team_opp_map.get(primary), 0) if primary else 0
            pool_scored.append({'lu': lu, 'bringback': bb, 'pred_top1': float(pred_top1[j])})

        # Select XGB-Top1 portfolio
        selected = greedy_select(pool_scored, 'pred_top1', False, anchor_ids)
        metrics = compute_universal(selected, pro_stats)
        m_dist = mahal(metrics, slate)
        structural_rows.append({'slate': slate, **metrics, 'mahal': m_dist, 'n_lineups': len(selected)})
        print(f"  {slate}: " + " ".join(f"{k[:20]}={v:.3f}" for k, v in metrics.items()) + f" mahal={m_dist if m_dist else 'NA'}", file=sys.stderr)

    # Aggregate
    sdf = pd.DataFrame(structural_rows)
    print(f"\n=== XGB-Top1 5-principle structural fit (29 slates) ===")
    print(f"{'metric':<28} {'pro_target':>10} {'XGB-Top1_mean':>14} {'CV':>6}")
    targets = {'projRatioToOptimal': 0.88, 'ceilingRatioToOptimal': 0.92, 'avgPlayerOwnPctile': 0.94, 'ownStdRatio': 7.1, 'ownDeltaFromAnchor': -7.2}
    for k in UNIVERSAL_METRICS:
        m = sdf[k].mean(); s = sdf[k].std()
        cv = abs(s/m) if m != 0 else 0
        print(f"  {k:<28} {targets[k]:>10.3f} {m:>14.3f} {cv:>6.3f}")
    mahal_clean = sdf['mahal'].dropna()
    if len(mahal_clean) > 0:
        print(f"\n  Mean Mahalanobis distance: {mahal_clean.mean():.3f}  (target <1.5)")
        print(f"  Slates d<1.5: {(mahal_clean < 1.5).sum()}/{len(mahal_clean)}")
        print(f"  Slates d<2.0: {(mahal_clean < 2.0).sum()}/{len(mahal_clean)}")

    sdf.to_csv(os.path.join(LIVE_AUDIT, 'xgb_structural_metrics.csv'), index=False)

if __name__ == '__main__':
    main()
