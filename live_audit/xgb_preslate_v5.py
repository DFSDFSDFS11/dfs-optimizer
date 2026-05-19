"""
XGB v5 PRESLATE — production lineup generator with groupby features.

Loads tonight's projections + pools, applies v5 Optuna model (201 features =
125 base + 76 groupby), greedy select N lineups. Outputs DK upload CSV.

Backtest: 358.40% ROI on 29 slates (vs v4 Optuna 159.56%).

Usage:
    PRESLATE_PROJ=mlbdkprojpre.csv PRESLATE_POOLS=sspool1pre.csv,sspool2pre.csv \\
    PRESLATE_N=500 python xgb_preslate_v5.py
"""
import csv, os, re, sys, json, time
from collections import Counter, defaultdict
import numpy as np
import xgboost as xgb

sys.path.insert(0, os.path.dirname(__file__))
from xgb_backtest import (
    LIVE_AUDIT, DFSOPTO,
    ATLAS_EXPOSURE_CAP_HITTER, ATLAS_EXPOSURE_CAP_PITCHER, ATLAS_TEAM_STACK_CAP,
    STACKS_ANCHOR_HIT_CAP, STACKS_ANCHOR_PIT_CAP, STACKS_N_HIT_ANCHORS, STACKS_N_PIT_ANCHORS,
    norm, load_proj, load_pool, compute_features, compute_slate_stats, greedy_select,
)
from factor_engine_v5_groupby import compute_groupby_features

def main():
    proj_file = os.environ.get('PRESLATE_PROJ', 'mlbdkprojpre.csv')
    pool_files = os.environ.get('PRESLATE_POOLS', 'sspool1pre.csv,sspool2pre.csv').split(',')
    N = int(os.environ.get('PRESLATE_N', '500'))
    output_tag = os.environ.get('PRESLATE_TAG', 'xgb_v5')

    import xgb_backtest as xbm
    if 'PRESLATE_MAX_PIT' in os.environ:
        cap = float(os.environ['PRESLATE_MAX_PIT'])
        xbm.ATLAS_EXPOSURE_CAP_PITCHER = cap
        xbm.STACKS_ANCHOR_PIT_CAP = cap
        print(f"Override: pitcher cap = {cap}", file=sys.stderr)
    if 'PRESLATE_MAX_HIT' in os.environ:
        cap = float(os.environ['PRESLATE_MAX_HIT'])
        xbm.ATLAS_EXPOSURE_CAP_HITTER = cap
        xbm.STACKS_ANCHOR_HIT_CAP = cap
        print(f"Override: hitter cap = {cap}", file=sys.stderr)
    if 'PRESLATE_MAX_TEAM' in os.environ:
        cap = float(os.environ['PRESLATE_MAX_TEAM'])
        xbm.ATLAS_TEAM_STACK_CAP = cap
        print(f"Override: team stack cap = {cap}", file=sys.stderr)

    t0 = time.time()
    print(f"Loading projections: {proj_file}", file=sys.stderr)
    proj_path = os.path.join(DFSOPTO, proj_file)
    by_name, by_id = load_proj(proj_path)
    if not by_name:
        print(f"ERROR: no projections at {proj_path}", file=sys.stderr); sys.exit(1)
    print(f"  {len(by_id)} players loaded", file=sys.stderr)

    all_lineups = []
    seen_keys = set()
    for pf in pool_files:
        pf = pf.strip()
        pp = os.path.join(DFSOPTO, pf)
        if not os.path.exists(pp):
            print(f"  Skip {pf}: not found", file=sys.stderr); continue
        lus = load_pool(pp, by_id)
        for lu in lus:
            key = tuple(sorted(r.get('name', '') for p, r in lu))
            if key in seen_keys: continue
            seen_keys.add(key); all_lineups.append(lu)
        print(f"  {pf}: {len(lus)} lineups", file=sys.stderr)
    print(f"Merged: {len(all_lineups)} unique lineups in {time.time()-t0:.1f}s", file=sys.stderr)

    slate_stats = compute_slate_stats(by_name, [])

    print("Loading v5 Optuna model (125 base + 76 groupby features)...", file=sys.stderr)
    clf = xgb.Booster(); clf.load_model(os.path.join(LIVE_AUDIT, 'xgb_top1_v5.json'))
    feature_cols = clf.feature_names
    print(f"  {len(feature_cols)} features", file=sys.stderr)

    print(f"Computing v5 features for {len(all_lineups)} lineups...", file=sys.stderr)
    feats_rows = []
    for lu in all_lineups:
        f4 = compute_features(lu, by_name, slate_stats, slate_stats.get('pair_freq', {}))
        if f4 is None:
            feats_rows.append(None); continue
        positions = [(pos, r['name']) for pos, r in lu]
        gf = compute_groupby_features(positions, by_name)
        if gf is None:
            feats_rows.append(None); continue
        feats_rows.append({**f4, **gf})
    valid_idx = [i for i, f in enumerate(feats_rows) if f is not None]
    print(f"  {len(valid_idx)} valid", file=sys.stderr)

    X = np.array([[feats_rows[i].get(c, 0) for c in feature_cols] for i in valid_idx], dtype=np.float32)
    dpool = xgb.DMatrix(X, feature_names=feature_cols)
    pred = clf.predict(dpool)
    print(f"  Predictions: min={pred.min():.4f} max={pred.max():.4f} mean={pred.mean():.4f}", file=sys.stderr)

    proj_in_pool = defaultdict(float)
    for lu in all_lineups:
        for pos, r in lu:
            nm = norm(r['name'])
            if proj_in_pool[(pos, nm)] == 0: proj_in_pool[(pos, nm)] = r['proj']
    hitters = sorted([(nm, p) for (pos, nm), p in proj_in_pool.items() if pos != 'P'], key=lambda x: -x[1])
    pitchers = sorted([(nm, p) for (pos, nm), p in proj_in_pool.items() if pos == 'P'], key=lambda x: -x[1])
    anchor_ids = set([nm for nm, _ in hitters[:STACKS_N_HIT_ANCHORS]] + [nm for nm, _ in pitchers[:STACKS_N_PIT_ANCHORS]])
    print(f"  Anchors: hitters={[nm for nm,_ in hitters[:STACKS_N_HIT_ANCHORS]]}, pitchers={[nm for nm,_ in pitchers[:STACKS_N_PIT_ANCHORS]]}", file=sys.stderr)

    pool_scored = []
    for j, i in enumerate(valid_idx):
        lu = all_lineups[i]
        tc = Counter(); team_opp_map = {}
        for pos, r in lu:
            if pos == 'P': continue
            tc[r['team']] += 1; team_opp_map[r['team']] = r['opp']
        primary = max(tc.items(), key=lambda x: x[1])[0] if tc else None
        bb = tc.get(team_opp_map.get(primary), 0) if primary else 0
        pool_scored.append({'lu': lu, 'bringback': bb, 'pred_top1': float(pred[j])})

    print(f"\nGreedy selecting {N} lineups (v5)...", file=sys.stderr)
    orig_N = xbm.N
    xbm.N = N
    try:
        selected = greedy_select(pool_scored, 'pred_top1', False, anchor_ids)
    finally:
        xbm.N = orig_N
    print(f"  Selected {len(selected)}/{N}", file=sys.stderr)

    avg_proj = np.mean([sum(r['proj'] for p, r in cand['lu']) for cand in selected])
    avg_own = np.mean([np.mean([r['own'] for p, r in cand['lu']]) for cand in selected])
    avg_sal = np.mean([sum(r['salary'] for p, r in cand['lu']) for cand in selected])
    bb1 = sum(1 for cand in selected if cand['bringback'] >= 1)
    bb2 = sum(1 for cand in selected if cand['bringback'] >= 2)
    bb3 = sum(1 for cand in selected if cand['bringback'] >= 3)
    print(f"\nPORTFOLIO STATS (v5):", file=sys.stderr)
    print(f"  Avg projection: {avg_proj:.1f}", file=sys.stderr)
    print(f"  Avg ownership:  {avg_own:.2f}%", file=sys.stderr)
    print(f"  Avg salary:     ${avg_sal:.0f}", file=sys.stderr)
    print(f"  Bring-back: >=1 {bb1}/{N} ({bb1/N*100:.0f}%), >=2 {bb2}/{N} ({bb2/N*100:.0f}%), >=3 {bb3}/{N} ({bb3/N*100:.0f}%)", file=sys.stderr)

    stack_counts = Counter()
    for cand in selected:
        tc = Counter()
        for pos, r in cand['lu']:
            if pos == 'P': continue
            tc[r['team']] += 1
        for t, c in tc.items():
            if c >= 4: stack_counts[t] += 1
    print(f"\n  Team stacks (4+):", file=sys.stderr)
    for t, c in stack_counts.most_common():
        print(f"    {t:<4} {c:>4} ({c/N*100:.0f}%)", file=sys.stderr)

    exposures = Counter()
    player_info = {}
    for cand in selected:
        for pos, r in cand['lu']:
            nm = r['name']
            exposures[nm] += 1
            if nm not in player_info: player_info[nm] = (r['team'], r['own'], r['proj'])
    print(f"\n  Top 15 player exposures:", file=sys.stderr)
    for nm, c in exposures.most_common(15):
        team, own, proj = player_info[nm]
        print(f"    {nm:<26} {team:<4} {c/N*100:>5.1f}% ({c}/{N})  own={own:>5.1f}%  proj={proj:>5.1f}", file=sys.stderr)

    out_path = os.path.join(DFSOPTO, f'theory_dfs_argus_xgb_preslate_{N}_{output_tag}.csv')
    print(f"\nWriting DK CSV to {out_path}", file=sys.stderr)
    with open(out_path, 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['P', 'P', 'C', '1B', '2B', '3B', 'SS', 'OF', 'OF', 'OF'])
        for cand in selected:
            slots = {'P': [], 'C': [], '1B': [], '2B': [], '3B': [], 'SS': [], 'OF': []}
            for pos, r in cand['lu']:
                if pos in slots: slots[pos].append(r)
            row = []
            for slot in ['P', 'P', 'C', '1B', '2B', '3B', 'SS', 'OF', 'OF', 'OF']:
                if slots[slot]:
                    r = slots[slot].pop(0)
                    dfs_id = next((pid for pid, prec in by_id.items() if prec['name'] == r['name']), '')
                    row.append(dfs_id)
                else:
                    row.append('')
            w.writerow(row)
    print(f"\nDONE. DK upload: {out_path}", file=sys.stderr)
    print(f"Total time: {time.time()-t0:.1f}s", file=sys.stderr)

if __name__ == '__main__':
    main()
