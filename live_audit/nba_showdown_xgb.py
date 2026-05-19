"""
NBA Showdown XGBoost — end-to-end pipeline.

Pipeline:
  1. Load NBA showdown projection file (with percentile distributions)
  2. Load pool of candidate lineups (CPT + 5 UTIL format)
  3. Compute showdown-specific features per lineup
  4. Generate SYNTHETIC training labels via Monte Carlo:
     - Sample 1500 player-outcome worlds from percentile distributions
     - Compute lineup score in each world (with 1.5x CPT multiplier)
     - Sample 8000 random lineups as "field"
     - For each candidate, compute rank-percentile across worlds vs field
     - Top-1% in sim → label 1
  5. Train XGB binary classifier with sample weighting
  6. Optuna tune (50 trials)
  7. Predict per lineup → use as selection criterion
  8. Greedy select N with caps
  9. Output DK CSV (CPT + 5 UTIL columns)

Showdown format:
  - 6 players: 1 CPT (1.5x salary, 1.5x score) + 5 UTIL (1x)
  - $50,000 salary cap
  - Single game (only 2 teams)
  - DK upload: CPT col + 5 UTIL cols

Features (60+ showdown-specific):
  A. Basic: proj sum (with CPT 1.5x), own sum, sal sum, ceiling sum
  B. CPT-specific: CPT proj, CPT own, CPT salary, CPT is_top-N-by-proj
  C. Team composition: count team A, count team B (4-2/5-1/3-3 split)
  D. Distribution: proj std, own std, sal std, projection range
  E. Salary tiers: # players in each salary tier
  F. Star-and-scrubs: top-2 sal sum vs bot-2 sal sum, ratio
  G. Position diversity (in NBA: PG/SG/SF/PF/C counts)
  H. Percentile features: lineup p99 sum, p85 sum
"""
import csv, os, re, sys, json, time
from collections import Counter, defaultdict
import numpy as np
import pandas as pd
import xgboost as xgb
import optuna
optuna.logging.set_verbosity(optuna.logging.WARNING)

LIVE_AUDIT = "C:/Users/colin/Projects/dfs-optimizer/live_audit"
DFSOPTO = "C:/Users/colin/dfs opto"
SHOWDOWN_N_PLAYERS = 6
SALARY_CAP = 50000

def norm(n): return re.sub(r'[^a-z0-9 ]+', '', n.lower()).strip()

def load_showdown_proj(path):
    """Load NBA showdown projection. Returns by_name + by_id dicts with percentile distributions."""
    by_name = {}; by_id = {}
    with open(path, encoding='utf-8') as f:
        for r in csv.DictReader(f):
            nm = norm(r.get('Name', ''))
            pid = (r.get('DFS ID') or '').strip()
            if not nm or not pid: continue
            try:
                rec = {
                    'name': r.get('Name', ''),
                    'id': pid,
                    'team': (r.get('Team') or '').strip().upper(),
                    'opp': (r.get('Opp') or '').strip().upper(),
                    'salary': float(r.get('Salary', 0) or 0),
                    'own': float((r.get('Adj Own') or r.get('My Own') or '0').replace('%','') or 0),
                    'proj': float(r.get('My Proj') or r.get('SS Proj') or 0),
                    'p25': float(r.get('dk_25_percentile') or 0),
                    'p50': float(r.get('dk_50_percentile') or 0),
                    'p75': float(r.get('dk_75_percentile') or 0),
                    'p85': float(r.get('dk_85_percentile') or 0),
                    'p95': float(r.get('dk_95_percentile') or 0),
                    'p99': float(r.get('dk_99_percentile') or 0),
                    'std_dev': float(r.get('dk_std') or 0),
                    'pos': (r.get('Pos') or '').strip(),
                    'minutes': float(r.get('Min') or r.get('Minutes') or 0),
                }
                if rec['proj'] > 0:
                    by_name[nm] = rec
                    by_id[pid] = rec
            except (ValueError, TypeError): continue
    return by_name, by_id

def load_showdown_pool(path, by_id):
    """Load NBA showdown pool CSV. Returns list of lineups, each [(role, rec), ...]."""
    if not os.path.exists(path): return []
    lineups = []
    with open(path, encoding='utf-8') as f:
        reader = csv.reader(f)
        header = next(reader)
        # Showdown format: CPT, UTIL, UTIL, UTIL, UTIL, UTIL
        # Find CPT column and UTIL columns
        cpt_col = None; util_cols = []
        for i, h in enumerate(header):
            h_strip = h.strip()
            if h_strip == 'CPT': cpt_col = i
            elif h_strip in ('UTIL', 'FLEX'): util_cols.append(i)
        if cpt_col is None or len(util_cols) < 5:
            print(f"  Unexpected header: {header[:10]}", file=sys.stderr)
            return []
        for row in reader:
            if not row: continue
            cpt = by_id.get(row[cpt_col].strip()) if row[cpt_col].strip().isdigit() else None
            if not cpt: continue
            utils = []
            for i in util_cols[:5]:
                if i >= len(row): continue
                v = row[i].strip()
                if v.isdigit():
                    r = by_id.get(v)
                    if r: utils.append(r)
            if len(utils) == 5:
                lineups.append([('CPT', cpt)] + [('UTIL', r) for r in utils])
    # Dedupe
    seen = set()
    out = []
    for lu in lineups:
        key = (lu[0][1]['id'], tuple(sorted(r['id'] for _, r in lu[1:])))
        if key in seen: continue
        seen.add(key)
        out.append(lu)
    return out

def compute_showdown_features(lu, by_name):
    """Compute showdown-specific features for one lineup."""
    if len(lu) != 6: return None
    feats = {}
    cpt = lu[0][1]
    utils = [r for _, r in lu[1:]]
    all_recs = [cpt] + utils

    # A. Basic (with CPT 1.5x multiplier on proj/ceiling)
    cpt_proj = cpt['proj'] * 1.5
    cpt_own = cpt['own']  # ownership is for the CPT version
    cpt_sal = cpt['salary'] * 1.5

    util_projs = [r['proj'] for r in utils]
    util_owns = [r['own'] for r in utils]
    util_sals = [r['salary'] for r in utils]
    util_ceils = [r['p85'] for r in utils]
    util_p99s = [r['p99'] for r in utils]
    util_stds = [r['std_dev'] for r in utils]
    util_mins = [r['minutes'] for r in utils]

    feats['proj_sum'] = cpt_proj + sum(util_projs)
    feats['proj_mean'] = feats['proj_sum'] / 6
    feats['own_sum'] = cpt_own + sum(util_owns)
    feats['own_mean'] = feats['own_sum'] / 6
    feats['own_std'] = np.std([cpt_own] + util_owns)
    feats['own_max'] = max([cpt_own] + util_owns)
    feats['own_min'] = min([cpt_own] + util_owns)
    feats['sal_sum'] = cpt_sal + sum(util_sals)
    feats['sal_unused'] = SALARY_CAP - feats['sal_sum']
    feats['sal_std'] = np.std([cpt_sal] + util_sals)
    feats['ceil_85_sum'] = cpt['p85'] * 1.5 + sum(util_ceils)
    feats['ceil_99_sum'] = cpt['p99'] * 1.5 + sum(util_p99s)
    feats['var_sum'] = (cpt['std_dev'] * 1.5)**2 + sum(s**2 for s in util_stds)
    feats['std_sum'] = cpt['std_dev'] * 1.5 + sum(util_stds)
    feats['min_sum'] = cpt['minutes'] + sum(util_mins)
    feats['min_mean'] = feats['min_sum'] / 6

    # B. CPT-specific
    feats['cpt_proj'] = cpt_proj
    feats['cpt_proj_raw'] = cpt['proj']
    feats['cpt_own'] = cpt_own
    feats['cpt_salary'] = cpt_sal
    feats['cpt_ceil'] = cpt['p85'] * 1.5
    feats['cpt_p99'] = cpt['p99'] * 1.5
    feats['cpt_minutes'] = cpt['minutes']
    feats['cpt_std'] = cpt['std_dev']
    # Is CPT one of top-3 highest-projected players on the slate?
    all_slate_projs = sorted([r['proj'] for r in by_name.values()], reverse=True)
    feats['cpt_proj_rank_slate'] = next((i for i, p in enumerate(all_slate_projs) if cpt['proj'] >= p), 100)
    feats['cpt_is_top1_proj'] = 1.0 if feats['cpt_proj_rank_slate'] == 0 else 0.0
    feats['cpt_is_top3_proj'] = 1.0 if feats['cpt_proj_rank_slate'] < 3 else 0.0

    # C. Team composition
    teams = Counter(r['team'] for r in all_recs)
    counts = sorted(teams.values(), reverse=True)
    while len(counts) < 2: counts.append(0)
    feats['team_max_count'] = counts[0]
    feats['team_split_5_1'] = 1.0 if counts == [5, 1] else 0.0
    feats['team_split_4_2'] = 1.0 if counts == [4, 2] else 0.0
    feats['team_split_3_3'] = 1.0 if counts == [3, 3] else 0.0
    feats['cpt_team_count'] = teams[cpt['team']]
    feats['n_unique_teams'] = len(teams)

    # D. Distribution shape
    all_p = [cpt_proj] + util_projs
    all_o = [cpt_own] + util_owns
    feats['proj_std'] = np.std(all_p)
    feats['proj_max'] = max(all_p)
    feats['proj_min'] = min(all_p)
    feats['proj_range'] = max(all_p) - min(all_p)
    feats['proj_cv'] = np.std(all_p) / max(0.01, np.mean(all_p))

    # E. Salary tiers
    feats['n_sal_10k_plus'] = sum(1 for r in all_recs if r['salary'] >= 10000)
    feats['n_sal_8k_to_10k'] = sum(1 for r in all_recs if 8000 <= r['salary'] < 10000)
    feats['n_sal_6k_to_8k'] = sum(1 for r in all_recs if 6000 <= r['salary'] < 8000)
    feats['n_sal_under_6k'] = sum(1 for r in all_recs if r['salary'] < 6000)
    feats['n_sal_under_4k'] = sum(1 for r in all_recs if r['salary'] < 4000)

    # F. Star-and-scrubs
    sals_sorted = sorted([r['salary'] for r in all_recs], reverse=True)
    feats['sal_top2_sum'] = sum(sals_sorted[:2])
    feats['sal_bot2_sum'] = sum(sals_sorted[-2:])
    feats['sal_top_to_bot_ratio'] = feats['sal_top2_sum'] / max(1, feats['sal_bot2_sum'])

    # G. Position diversity (NBA: PG/SG/SF/PF/C)
    pos_counts = Counter()
    for r in all_recs:
        for p in r['pos'].split('/'):
            pos_counts[p.strip()] += 1
            break  # primary position only
    feats['n_pg'] = pos_counts.get('PG', 0)
    feats['n_sg'] = pos_counts.get('SG', 0)
    feats['n_sf'] = pos_counts.get('SF', 0)
    feats['n_pf'] = pos_counts.get('PF', 0)
    feats['n_c'] = pos_counts.get('C', 0)
    feats['n_g'] = pos_counts.get('PG', 0) + pos_counts.get('SG', 0)
    feats['n_f'] = pos_counts.get('SF', 0) + pos_counts.get('PF', 0)
    feats['n_unique_positions'] = len(pos_counts)

    # H. Top-3 sum patterns
    projs_sorted = sorted(all_p, reverse=True)
    owns_sorted = sorted(all_o, reverse=True)
    feats['proj_top3_sum'] = sum(projs_sorted[:3])
    feats['proj_bot3_sum'] = sum(projs_sorted[-3:])
    feats['own_top3_sum'] = sum(owns_sorted[:3])
    feats['own_bot3_sum'] = sum(owns_sorted[-3:])

    # Leverage ratios
    feats['proj_per_dollar'] = feats['proj_sum'] / max(1, feats['sal_sum'] / 1000)
    feats['proj_per_own'] = feats['proj_sum'] / max(0.001, feats['own_sum'])
    feats['ceil_per_own'] = feats['ceil_85_sum'] / max(0.001, feats['own_sum'])

    # Ownership shape
    feats['n_chalk_20plus'] = sum(1 for o in all_o if o >= 20)
    feats['n_chalk_30plus'] = sum(1 for o in all_o if o >= 30)
    feats['n_lev_5less'] = sum(1 for o in all_o if o < 5)
    feats['n_lev_10less'] = sum(1 for o in all_o if o < 10)

    return feats

def sample_player_outcomes(by_id, n_sims, seed=12345):
    """Sample fpts per player per sim from percentile distribution.
    Iterates by_id to include both CPT and UTIL IDs of same player.
    Returns dict {player_id: np.array of length n_sims}."""
    rng = np.random.default_rng(seed)
    outcomes = {}
    for pid, r in by_id.items():
        pcts = np.array([0.25, 0.50, 0.75, 0.85, 0.95, 0.99])
        vals = np.array([r['p25'], r['p50'], r['p75'], r['p85'], r['p95'], r['p99']])
        if vals.max() <= 0:
            outcomes[pid] = np.full(n_sims, r['proj'])
            continue
        u = rng.uniform(0, 1, n_sims)
        outcomes[pid] = np.interp(u, np.concatenate([[0], pcts, [1]]),
                                   np.concatenate([[max(0, vals[0] * 0.5)], vals, [vals[-1] * 1.2]]))
    return outcomes

def synth_training_labels(pool, by_id, n_sims=1500, field_size=8000):
    """Generate synthetic top-1% labels via Monte Carlo sim.
    Returns array of binary labels (1 = top-1% of sim ranks).
    """
    rng = np.random.default_rng(42)
    outcomes = sample_player_outcomes(by_id, n_sims)

    # Score every pool lineup in each sim
    P = len(pool)
    cand_scores = np.zeros((P, n_sims))
    for c, lu in enumerate(pool):
        # CPT 1.5x, UTIL 1x
        cpt_score = outcomes[lu[0][1]['id']] * 1.5
        util_score = sum(outcomes[r['id']] for _, r in lu[1:])
        cand_scores[c] = cpt_score + util_score

    # Sample field: 8000 random lineups from pool, repeated per sim
    field_ranks = np.zeros((P, n_sims))
    for s in range(n_sims):
        # Use uniform random sample with replacement as field
        field_idx = rng.integers(0, P, field_size)
        field_scores = cand_scores[field_idx, s]
        field_sorted = np.sort(field_scores)[::-1]
        # Find each candidate's rank in field
        for c in range(P):
            field_ranks[c, s] = np.searchsorted(-field_sorted, -cand_scores[c, s])

    # Per candidate: fraction of sims where it ranked in top-1% of field
    top1_threshold = int(field_size * 0.01)
    top1_rate = (field_ranks < top1_threshold).mean(axis=1)

    # Use top X% of pool by top1_rate as positive label
    n_pos = int(P * 0.05)  # top 5% of pool gets label 1
    sorted_idx = np.argsort(-top1_rate)
    labels = np.zeros(P, dtype=np.int32)
    labels[sorted_idx[:n_pos]] = 1
    # Also identify "super-positive" (top 0.5% of pool) for sample weight
    super_pos = np.zeros(P, dtype=np.int32)
    n_super = max(10, int(P * 0.005))
    super_pos[sorted_idx[:n_super]] = 1
    return labels, super_pos, top1_rate

def train_xgb_optuna(X, y, sample_weight, X_val, y_val, n_trials=30):
    """Train XGBoost with Optuna TPE on supplied train/val split."""
    feature_cols = [f'f{i}' for i in range(X.shape[1])] if not hasattr(X, 'columns') else list(X.columns)
    dtrain = xgb.DMatrix(X, label=y, weight=sample_weight, feature_names=feature_cols)
    dval = xgb.DMatrix(X_val, label=y_val, feature_names=feature_cols)

    def objective(trial):
        params = {
            'objective': 'binary:logistic', 'eval_metric': 'auc', 'tree_method': 'hist', 'verbosity': 0,
            'learning_rate': trial.suggest_float('learning_rate', 0.01, 0.1, log=True),
            'max_depth': trial.suggest_int('max_depth', 3, 8),
            'min_child_weight': trial.suggest_int('min_child_weight', 1, 100, log=True),
            'subsample': trial.suggest_float('subsample', 0.6, 1.0),
            'colsample_bytree': trial.suggest_float('colsample_bytree', 0.4, 1.0),
            'gamma': trial.suggest_float('gamma', 0.0, 1.0),
            'reg_alpha': trial.suggest_float('reg_alpha', 1e-3, 2.0, log=True),
            'reg_lambda': trial.suggest_float('reg_lambda', 1e-3, 2.0, log=True),
            'scale_pos_weight': (len(y) - y.sum()) / max(1, y.sum()) * trial.suggest_float('pw_mult', 0.5, 2.0),
        }
        model = xgb.train(params, dtrain, num_boost_round=500,
                          evals=[(dval, 'val')], early_stopping_rounds=30, verbose_eval=False)
        from sklearn.metrics import roc_auc_score
        return roc_auc_score(y_val, model.predict(dval))

    sampler = optuna.samplers.TPESampler(seed=42)
    study = optuna.create_study(direction='maximize', sampler=sampler)
    study.optimize(objective, n_trials=n_trials)

    # Retrain with best params
    best = dict(study.best_params)
    pw_mult = best.pop('pw_mult')
    best.update({'objective': 'binary:logistic', 'eval_metric': 'auc',
                 'tree_method': 'hist', 'verbosity': 0,
                 'scale_pos_weight': (len(y) - y.sum()) / max(1, y.sum()) * pw_mult})
    final = xgb.train(best, dtrain, num_boost_round=500,
                      evals=[(dval, 'val')], early_stopping_rounds=30, verbose_eval=False)
    return final, study.best_value, study.best_params, feature_cols

def main():
    t0 = time.time()
    proj_file = os.environ.get('NBASD_PROJ', 'nbaprojpre.csv')
    pool_files = os.environ.get('NBASD_POOLS', 'ssnbapool.csv,ssnbapool2.csv').split(',')
    N = int(os.environ.get('NBASD_TARGET', '150'))
    output_tag = os.environ.get('NBASD_TAG', 'nba_xgb')
    n_sims = int(os.environ.get('NBASD_NSIMS', '1500'))

    print(f"Loading projections {proj_file}...", file=sys.stderr)
    by_name, by_id = load_showdown_proj(os.path.join(DFSOPTO, proj_file))
    print(f"  {len(by_id)} players", file=sys.stderr)

    all_lineups = []
    seen = set()
    for pf in pool_files:
        lus = load_showdown_pool(os.path.join(DFSOPTO, pf.strip()), by_id)
        for lu in lus:
            key = (lu[0][1]['id'], tuple(sorted(r['id'] for _, r in lu[1:])))
            if key in seen: continue
            seen.add(key); all_lineups.append(lu)
        print(f"  {pf.strip()}: {len(lus)} lineups", file=sys.stderr)
    print(f"Merged pool: {len(all_lineups)} unique lineups", file=sys.stderr)
    if len(all_lineups) < 100:
        print("Pool too small", file=sys.stderr); sys.exit(1)

    # Compute features for all lineups
    print(f"Computing features...", file=sys.stderr)
    t1 = time.time()
    rows = []
    valid = []
    for i, lu in enumerate(all_lineups):
        f = compute_showdown_features(lu, by_name)
        if f is not None:
            rows.append(f); valid.append(i)
    df_feats = pd.DataFrame(rows)
    feature_cols = list(df_feats.columns)
    print(f"  {len(df_feats)} valid, {len(feature_cols)} features in {time.time()-t1:.1f}s", file=sys.stderr)

    # Generate synthetic labels via sim
    print(f"Generating synthetic training labels (sim with {n_sims} worlds)...", file=sys.stderr)
    t2 = time.time()
    pool_valid = [all_lineups[i] for i in valid]
    labels, super_pos, top1_rate = synth_training_labels(pool_valid, by_id, n_sims=n_sims)
    print(f"  {labels.sum()} positives ({labels.mean()*100:.1f}%), {super_pos.sum()} super-positives in {time.time()-t2:.1f}s", file=sys.stderr)
    print(f"  top1_rate range: {top1_rate.min():.4f} to {top1_rate.max():.4f}, mean {top1_rate.mean():.4f}", file=sys.stderr)

    # 80/20 split within pool for training
    np.random.seed(42)
    n_train = int(0.8 * len(df_feats))
    perm = np.random.permutation(len(df_feats))
    train_idx = perm[:n_train]; val_idx = perm[n_train:]
    X_train = df_feats.iloc[train_idx].fillna(0).values.astype(np.float32)
    X_val = df_feats.iloc[val_idx].fillna(0).values.astype(np.float32)
    y_train = labels[train_idx]; y_val = labels[val_idx]
    sw_train = np.ones(len(y_train)); sw_train[super_pos[train_idx] == 1] = 10
    sw_train[y_train == 1] *= 5  # also weight any positive

    print(f"\nTraining XGBoost binary top-X% with Optuna ({30} trials)...", file=sys.stderr)
    t3 = time.time()
    df_train = pd.DataFrame(X_train, columns=feature_cols)
    df_val = pd.DataFrame(X_val, columns=feature_cols)
    model, val_auc, best_params, _ = train_xgb_optuna(df_train, y_train, sw_train, df_val, y_val, n_trials=30)
    print(f"  Optuna done in {time.time()-t3:.1f}s, val AUC={val_auc:.4f}", file=sys.stderr)
    print(f"  Best params: {best_params}", file=sys.stderr)

    # Save model
    model.save_model(os.path.join(LIVE_AUDIT, f'nba_sd_xgb_{output_tag}.json'))

    # Feature importance
    imp = model.get_score(importance_type='gain')
    imp_df = pd.DataFrame([{'feature': f, 'gain': imp.get(f, 0)} for f in feature_cols]).sort_values('gain', ascending=False)
    print(f"\n=== TOP 20 FEATURES ===")
    print(imp_df.head(20).to_string(index=False))

    # Predict for ALL lineups
    print(f"\nPredicting per lineup...", file=sys.stderr)
    X_all = df_feats.fillna(0).values.astype(np.float32)
    dall = xgb.DMatrix(X_all, feature_names=feature_cols)
    pred = model.predict(dall)

    # Greedy selection
    print(f"\nGreedy select {N} lineups...", file=sys.stderr)
    sorted_idx = np.argsort(-pred)
    selected = []
    selected_set = set()
    cpt_count = defaultdict(int)
    player_count = defaultdict(int)
    max_cpt = float(os.environ.get('NBASD_MAX_CPT', '0.40'))
    max_player = float(os.environ.get('NBASD_MAX_PLAYER', '0.50'))

    for idx in sorted_idx:
        if len(selected) >= N: break
        if idx in selected_set: continue
        lu = pool_valid[idx]
        cpt_id = lu[0][1]['id']
        if cpt_count[cpt_id] >= int(np.ceil(max_cpt * N)): continue
        # Player exposure check (CPT or UTIL)
        ok = True
        for _, r in lu:
            if player_count[r['id']] >= int(np.ceil(max_player * N)): ok = False; break
        if not ok: continue
        selected.append((idx, pred[idx]))
        selected_set.add(idx)
        cpt_count[cpt_id] += 1
        for _, r in lu:
            player_count[r['id']] += 1

    print(f"\nSelected {len(selected)}/{N}", file=sys.stderr)

    # Stats
    sel_lineups = [pool_valid[i] for i, _ in selected]
    avg_proj = np.mean([df_feats.iloc[valid.index(i) if hasattr(valid, 'index') else i]['proj_sum'] for i, _ in selected])
    print(f"\nPORTFOLIO STATS:", file=sys.stderr)
    proj_sums = []; own_sums = []; sal_sums = []
    for i, _ in selected:
        f = rows[i]
        proj_sums.append(f['proj_sum']); own_sums.append(f['own_mean']); sal_sums.append(f['sal_sum'])
    print(f"  Avg proj: {np.mean(proj_sums):.1f}", file=sys.stderr)
    print(f"  Avg ownership (mean per lineup): {np.mean(own_sums):.2f}%", file=sys.stderr)
    print(f"  Avg salary: ${np.mean(sal_sums):.0f}", file=sys.stderr)

    print(f"\n  CPT distribution:", file=sys.stderr)
    cpt_counter = Counter(lu[0][1]['name'] for lu in sel_lineups)
    for nm, c in cpt_counter.most_common():
        r = [x for x in by_name.values() if x['name'] == nm][0]
        print(f"    {nm:<28} {r['team']:<4} {c/len(selected)*100:>5.1f}% ({c}/{len(selected)})  own={r['own']:>5.1f}% proj={r['proj']:>5.1f}", file=sys.stderr)

    # Top player exposures (UTIL+CPT)
    expo = Counter()
    for lu in sel_lineups:
        for role, r in lu:
            expo[(r['name'], role)] += 1
    print(f"\n  Top 15 player exposures (CPT/UTIL combined):", file=sys.stderr)
    for (nm, role), c in expo.most_common(15):
        r_obj = [x for x in by_name.values() if x['name'] == nm][0]
        print(f"    {nm:<28} {r_obj['team']:<4} {role:<5} {c/len(selected)*100:>5.1f}% ({c}/{len(selected)})  own={r_obj['own']:>5.1f}% proj={r_obj['proj']:>5.1f}", file=sys.stderr)

    # Write DK CSV
    out_path = os.path.join(DFSOPTO, f'theory_dfs_argus_nba_sd_xgb_{N}_{output_tag}.csv')
    with open(out_path, 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['CPT', 'UTIL', 'UTIL', 'UTIL', 'UTIL', 'UTIL'])
        for idx, _ in selected:
            lu = pool_valid[idx]
            row = [lu[0][1]['id']] + [r['id'] for _, r in lu[1:]]
            w.writerow(row)
    print(f"\nDK upload: {out_path}", file=sys.stderr)
    print(f"Total time: {time.time()-t0:.1f}s", file=sys.stderr)

if __name__ == '__main__':
    main()
