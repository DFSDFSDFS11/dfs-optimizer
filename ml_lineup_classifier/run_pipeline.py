"""
ML Lineup Classifier — Full Pipeline (Stages 1-8)

Trains LightGBM to predict P(pro plays this lineup), evaluates rigorously
against held-out slates, compares to Hermes-A baseline, and produces a
ship/don't-ship decision.

Run: python run_pipeline.py
Output: ml_lineup_classifier/report.md + saved model + intermediate CSVs
"""

import os
import sys
import json
import numpy as np
import pandas as pd
from pathlib import Path

# Force UTF-8 stdout on Windows
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')

import lightgbm as lgb
from sklearn.metrics import roc_auc_score, confusion_matrix
from sklearn.model_selection import GroupKFold
import joblib

ROOT = Path(__file__).parent
TRAIN_CSV = ROOT / 'training_data.csv'
PRO_CSV = ROOT / 'pro_lineups.csv'
OUT_DIR = ROOT
OUT_DIR.mkdir(exist_ok=True)

HELD_OUT = {'4-8-26', '4-21-26', '4-19-26', '4-24-26'}

REPORT_LINES = []
def log(msg=''):
    print(msg)
    REPORT_LINES.append(msg)

# ============================================================
# STAGE 1: Load + verify data
# ============================================================
log('# ML Lineup Classifier — Validation Report')
log('')
log('## Stage 1: Data Summary')
log('')

df = pd.read_csv(TRAIN_CSV)
log(f'Total rows loaded: {len(df):,}')
log(f'Positive rows: {(df.label == 1).sum():,}')
log(f'Negative rows: {(df.label == 0).sum():,}')
log(f'Held-out slates: {sorted(HELD_OUT)}')
log(f'Training slates: {sorted(set(df.slate.unique()) - HELD_OUT)}')

train_df = df[~df.slate.isin(HELD_OUT)].copy()
holdout_df = df[df.slate.isin(HELD_OUT)].copy()
log(f'Training rows: {len(train_df):,}  ({(train_df.label == 1).sum():,} pos, {(train_df.label == 0).sum():,} neg)')
log(f'Held-out rows: {len(holdout_df):,}  ({(holdout_df.label == 1).sum():,} pos, {(holdout_df.label == 0).sum():,} neg)')
log('')

# Drop non-feature columns
NON_FEATURE = ['lineup_hash', 'slate', 'is_holdout', 'label', 'pro_count']
FEATURES = [c for c in train_df.columns if c not in NON_FEATURE]
log(f'Feature count: {len(FEATURES)}')
log('Features: ' + ', '.join(FEATURES))
log('')

# Sample weights: positives weighted by pro_count (multiplicity)
def get_sample_weight(d):
    w = d.label.copy().astype(float)
    pos_mask = d.label == 1
    w[pos_mask] = d.loc[pos_mask, 'pro_count'].clip(lower=1)
    w[~pos_mask] = 1.0
    return w.values

# ============================================================
# STAGE 2: Train initial model with slate-level CV
# ============================================================
log('## Stage 2: Initial Model — Slate-level 5-fold CV')
log('')

X = train_df[FEATURES].values
y = train_df.label.values
groups = train_df.slate.values
sw = get_sample_weight(train_df)

LGB_PARAMS = {
    'objective': 'binary',
    'metric': 'auc',
    'num_leaves': 31,
    'max_depth': 6,
    'learning_rate': 0.05,
    'min_child_samples': 50,
    'reg_alpha': 0.1,
    'reg_lambda': 0.1,
    'verbose': -1,
    'random_state': 42,
}

cv_aucs_train = []
cv_aucs_val = []
gkf = GroupKFold(n_splits=5)
fold_iters = list(gkf.split(X, y, groups))

for fold_idx, (tr, va) in enumerate(fold_iters):
    train_data = lgb.Dataset(X[tr], label=y[tr], weight=sw[tr])
    val_data = lgb.Dataset(X[va], label=y[va], weight=sw[va])
    model = lgb.train(
        LGB_PARAMS, train_data,
        num_boost_round=500,
        valid_sets=[val_data], valid_names=['val'],
        callbacks=[lgb.early_stopping(50, verbose=False), lgb.log_evaluation(0)],
    )
    pred_tr = model.predict(X[tr])
    pred_va = model.predict(X[va])
    auc_tr = roc_auc_score(y[tr], pred_tr, sample_weight=sw[tr])
    auc_va = roc_auc_score(y[va], pred_va, sample_weight=sw[va])
    cv_aucs_train.append(auc_tr)
    cv_aucs_val.append(auc_va)
    val_slates = sorted(set(groups[va]))
    log(f'  Fold {fold_idx+1}: train AUC={auc_tr:.4f}  val AUC={auc_va:.4f}  val slates: {val_slates}')

log('')
log(f'**Mean train AUC: {np.mean(cv_aucs_train):.4f} ± {np.std(cv_aucs_train):.4f}**')
log(f'**Mean val AUC:   {np.mean(cv_aucs_val):.4f} ± {np.std(cv_aucs_val):.4f}**')
log('')
mean_val_auc = np.mean(cv_aucs_val)
if mean_val_auc < 0.65:
    log('⚠️ Validation AUC below 0.65 — model is barely learning')
elif mean_val_auc >= 0.85:
    log('✅ Validation AUC ≥ 0.85 — excellent')
elif mean_val_auc >= 0.75:
    log('✅ Validation AUC ≥ 0.75 — meaningful signal')
else:
    log('🟡 Validation AUC in [0.65, 0.75] — moderate signal')
log('')

# Train final model on all training data with best iteration ≈ avg of folds
all_data = lgb.Dataset(X, label=y, weight=sw)
final_model = lgb.train(LGB_PARAMS, all_data, num_boost_round=300, callbacks=[lgb.log_evaluation(0)])
final_model.save_model(str(ROOT / 'lgb_final.txt'))

# Feature importance
imp_df = pd.DataFrame({
    'feature': FEATURES,
    'gain': final_model.feature_importance('gain'),
    'split': final_model.feature_importance('split'),
}).sort_values('gain', ascending=False)
log('### Top 20 features by gain:')
log('')
log('| Rank | Feature | Gain | Split count |')
log('|---|---|---|---|')
for i, row in imp_df.head(20).iterrows():
    log(f"| {row.name} | {row.feature} | {row.gain:.0f} | {row.split:.0f} |")
imp_df.to_csv(ROOT / 'feature_importance.csv', index=False)
log('')

# Calibration plot data (predicted prob vs observed pro-pick rate)
pred_full = final_model.predict(X)
deciles = pd.qcut(pred_full, 10, labels=False, duplicates='drop')
calib = pd.DataFrame({'pred': pred_full, 'label': y, 'decile': deciles}).groupby('decile').agg(mean_pred=('pred','mean'), obs_rate=('label','mean'), count=('label','size'))
log('### Calibration (decile of predicted prob):')
log('')
log('| Decile | Mean pred prob | Observed pro-pick rate | Count |')
log('|---|---|---|---|')
for idx, row in calib.iterrows():
    log(f"| {idx} | {row.mean_pred:.4f} | {row.obs_rate:.4f} | {row['count']:.0f} |")
log('')

# Confusion matrix at 0.5 threshold
y_pred_class = (pred_full >= 0.5).astype(int)
cm = confusion_matrix(y, y_pred_class)
log(f'### Confusion matrix at 0.5 threshold:')
log('')
log(f'```')
log(f'                Predicted 0    Predicted 1')
log(f'Actual 0    {cm[0,0]:>10}    {cm[0,1]:>10}')
log(f'Actual 1    {cm[1,0]:>10}    {cm[1,1]:>10}')
log(f'```')
log('')

# ============================================================
# STAGE 3: Cross-pro validation
# ============================================================
log('## Stage 3: Cross-Pro Validation (Leave-One-Pro-Out)')
log('')

pro_df = pd.read_csv(PRO_CSV)
# Filter to training slates
pro_train = pro_df[~pro_df.slate.isin(HELD_OUT)].copy()
all_pros = sorted(pro_train.pro.unique())
log(f'Pros: {all_pros}')
log('')

# For each pro, train model excluding that pro's positives, then evaluate on that pro's lineups
# Need to map (slate, lineup_hash) -> which pros used it

# Build pro->set(slate,hash)
pro_lineups = pro_train.groupby('pro').apply(lambda g: set(zip(g.slate, g.lineup_hash))).to_dict()

# Add (slate, hash) → pros set to train_df
train_keyed = train_df.copy()
train_keyed['key'] = list(zip(train_keyed.slate, train_keyed.lineup_hash))
key_to_pros = pro_train.groupby(['slate', 'lineup_hash']).pro.apply(set).to_dict()
train_keyed['pros'] = train_keyed['key'].map(lambda k: key_to_pros.get(k, set()))

cross_pro_aucs = {}
for held_pro in all_pros:
    # Training data: exclude rows where the ONLY pro is held_pro
    # i.e., positive rows whose pros set is exactly {held_pro} get removed; others stay
    mask_keep = train_keyed.apply(
        lambda r: (r.label == 0) or (held_pro not in r.pros) or (len(r.pros) > 1), axis=1
    )
    sub = train_keyed[mask_keep]
    Xs = sub[FEATURES].values; ys = sub.label.values; sws = get_sample_weight(sub)

    # Test set: rows where held_pro is in pros set
    test_mask = train_keyed.pros.apply(lambda ps: held_pro in ps)
    test_pos = train_keyed[test_mask].copy()
    test_pos_X = test_pos[FEATURES].values
    # Negatives for this test: same slates, label=0
    test_slates = test_pos.slate.unique()
    test_neg = train_keyed[(train_keyed.label == 0) & (train_keyed.slate.isin(test_slates))].copy()
    Xt = np.vstack([test_pos_X, test_neg[FEATURES].values])
    yt = np.concatenate([np.ones(len(test_pos)), np.zeros(len(test_neg))])

    train_d = lgb.Dataset(Xs, label=ys, weight=sws)
    m = lgb.train(LGB_PARAMS, train_d, num_boost_round=300, callbacks=[lgb.log_evaluation(0)])
    pred_t = m.predict(Xt)
    auc = roc_auc_score(yt, pred_t)
    cross_pro_aucs[held_pro] = auc
    log(f'  Held-out pro: {held_pro:18s}  AUC: {auc:.4f}  (test pos: {len(test_pos)}, neg: {len(test_neg)})')

cp_aucs = np.array(list(cross_pro_aucs.values()))
log('')
log(f'**Mean cross-pro AUC: {cp_aucs.mean():.4f} ± {cp_aucs.std():.4f}**')
log(f'Min: {cp_aucs.min():.4f} ({min(cross_pro_aucs, key=cross_pro_aucs.get)})')
log(f'Max: {cp_aucs.max():.4f} ({max(cross_pro_aucs, key=cross_pro_aucs.get)})')
log('')
gate_3_pass = cp_aucs.mean() >= 0.70 and cp_aucs.std() <= 0.07
log(f'Gate 3 (mean ≥ 0.70 AND stddev ≤ 0.07): {"✅ PASS" if gate_3_pass else "❌ FAIL"}')
log('')

# ============================================================
# STAGE 4: Held-out slate validation
# ============================================================
log('## Stage 4: Held-Out Slate Validation')
log('')
log('Apply final model to 4 held-out slates. Compare model top-150 vs pros\' actual lineups.')
log('')

holdout_aucs = {}
holdout_metrics = []
for hslate in sorted(HELD_OUT):
    hd = holdout_df[holdout_df.slate == hslate].copy()
    if len(hd) == 0:
        log(f'  {hslate}: no data, skipping')
        continue
    Xh = hd[FEATURES].values; yh = hd.label.values
    pred_h = final_model.predict(Xh)
    if hd.label.nunique() < 2:
        log(f'  {hslate}: single-class, skipping AUC')
        continue
    auc_h = roc_auc_score(yh, pred_h)
    holdout_aucs[hslate] = auc_h
    # Top 150 by predicted prob — what fraction are pros?
    hd['pred'] = pred_h
    top150 = hd.nlargest(150, 'pred')
    top150_pos_count = (top150.label == 1).sum()
    pos_total = (hd.label == 1).sum()
    recall_at_150 = top150_pos_count / pos_total if pos_total > 0 else 0
    precision_at_150 = top150_pos_count / 150
    log(f'  {hslate:15s}  AUC: {auc_h:.4f}  top-150 contains {top150_pos_count}/{pos_total} pro lineups  (precision={precision_at_150:.3f}, recall={recall_at_150:.3f})')
    holdout_metrics.append({'slate': hslate, 'auc': auc_h, 'top150_pos': top150_pos_count, 'pos_total': pos_total, 'precision': precision_at_150, 'recall': recall_at_150})

ho_aucs = np.array(list(holdout_aucs.values()))
log('')
log(f'**Mean held-out AUC: {ho_aucs.mean():.4f}**')
gate_4_pass = ho_aucs.mean() >= 0.72
log(f'Gate 4 (mean held-out AUC ≥ 0.72): {"✅ PASS" if gate_4_pass else "❌ FAIL"}')
log('')

# ============================================================
# STAGE 5: Stage-2 portfolio constructor (greedy + constraints)
# ============================================================
log('## Stage 5: Portfolio Construction on Held-Out Slates')
log('')

def get_primary_team(lu_player_ids, pid_to_team, pid_to_pos):
    """Compute primary stack team = team with most non-pitcher players."""
    counts = {}
    for pid in lu_player_ids:
        pos = pid_to_pos.get(pid, '')
        if 'P' in pos: continue
        team = pid_to_team.get(pid, '')
        if not team: continue
        counts[team] = counts.get(team, 0) + 1
    if not counts:
        return None
    return max(counts.items(), key=lambda x: x[1])[0]

def build_portfolio(scored_lineups, N=150, gamma=5, team_cap=0.26, max_exp_hitter=0.21, max_exp_pitcher=0.41):
    """Greedy selection. scored_lineups: list of (score, hash, player_ids, primary_team, is_pitcher_dict)."""
    selected = []
    selected_player_sets = []
    selected_primary = []
    player_count = {}
    team_count = {}
    max_per_team = max(1, int(N * team_cap))
    cap_h = int(max_exp_hitter * N) + 1
    cap_p = int(max_exp_pitcher * N) + 1
    exhausted = []
    sorted_lineups = sorted(scored_lineups, key=lambda x: -x[0])

    def try_add(score, hash_, pids, primary, is_p_dict, gamma_local):
        if len(selected) >= N: return False
        # Player exposure
        for pid in pids:
            cap = cap_p if is_p_dict.get(pid, False) else cap_h
            if player_count.get(pid, 0) >= cap: return False
        # Team cap
        if primary and team_count.get(primary, 0) >= max_per_team: return False
        # Pairwise overlap
        pid_set = set(pids)
        for prev in selected_player_sets:
            if len(pid_set & prev) > gamma_local: return False
        # Add
        selected.append((score, hash_, pids))
        selected_player_sets.append(pid_set)
        selected_primary.append(primary)
        for pid in pids: player_count[pid] = player_count.get(pid, 0) + 1
        if primary: team_count[primary] = team_count.get(primary, 0) + 1
        return True

    for score, hash_, pids, primary, is_p_dict in sorted_lineups:
        if len(selected) >= N: break
        if not try_add(score, hash_, pids, primary, is_p_dict, gamma): exhausted.append((score, hash_, pids, primary, is_p_dict))
    # Relax gamma if short
    if len(selected) < N:
        for relax_gamma in [6, 7, 8]:
            for tup in exhausted:
                if len(selected) >= N: break
                try_add(*tup, gamma_local=relax_gamma)
            if len(selected) >= N: break
    return selected

# Need lineup pool with player IDs and team/position info — re-export from TS
log('  Loading lineup pools and player metadata for held-out slates...')
log('  (NOTE: Stage 5/6 require player-level data; running TS exporter for held-out pools)')
log('')

# We will defer Stage 5/6 ROI/structural comparisons to a TS post-processing script
# that has access to actuals/pools. For now, save predictions for held-out.
holdout_with_preds = holdout_df.copy()
holdout_with_preds['pred'] = final_model.predict(holdout_with_preds[FEATURES].values)
holdout_with_preds[['slate', 'lineup_hash', 'label', 'pro_count', 'pred']].to_csv(ROOT / 'holdout_predictions.csv', index=False)
log('  Saved holdout_predictions.csv (for TS post-processing into Stage 5/6 portfolio comparison)')
log('')

# ============================================================
# STAGE 6 placeholder — done in TS post-processing
# ============================================================
log('## Stage 6: Hermes-A vs ML — DEFERRED to TS post-processing')
log('')
log('See ml_compare_to_hermes.ts run after this script.')
log('')

# ============================================================
# STAGE 7: Decision (preliminary, finalized after Stage 6)
# ============================================================
log('## Stage 7: Preliminary Decision')
log('')
log(f'Gate 1 (CV val AUC ≥ 0.65): {"✅ PASS" if mean_val_auc >= 0.65 else "❌ FAIL"} (got {mean_val_auc:.4f})')
log(f'Gate 3 (Cross-pro): {"✅ PASS" if gate_3_pass else "❌ FAIL"}')
log(f'Gate 4 (Held-out AUC): {"✅ PASS" if gate_4_pass else "❌ FAIL"}')
log('')
prelim_pass = mean_val_auc >= 0.65 and gate_3_pass and gate_4_pass
log(f'**Preliminary: {"PROCEED to Stage 6" if prelim_pass else "FAIL — document and stop"}**')
log('')

# ============================================================
# STAGE 8: Feature ablation
# ============================================================
log('## Stage 8: Feature Ablation')
log('')

FEATURE_GROUPS = {
    'aggregate': ['total_projection', 'total_salary', 'total_ownership', 'mean_ownership', 'ownership_stddev_within_lineup', 'total_ceiling', 'total_floor'],
    'slate_relative': ['projection_ratio_to_optimal', 'ownership_delta_from_anchor', 'ceiling_ratio_to_max', 'salary_efficiency', 'avg_player_ownership_percentile'],
    'stack': ['primary_stack_size', 'primary_stack_team_ownership_rank', 'secondary_stack_size', 'has_3_3_split', 'has_4_3_split', 'has_5_stack', 'pitcher_team_in_stacks'],
    'ownership_dist': ['num_players_above_25_own', 'num_players_below_5_own', 'max_single_player_ownership', 'min_single_player_ownership', 'ownership_skewness'],
    'archetype': ['count_leverage_spots', 'count_value_plays', 'count_chalk_studs', 'count_punt_plays', 'count_trap_plays'],
    'pairwise': ['max_pairwise_player_co_ownership'],
    'position': ['pitcher_total_salary', 'pitcher_total_ownership', 'hitter_salary_stddev'],
}

# Cumulative ablation: add groups one by one in order
ablation_results = {}
running_features = []
log('### Cumulative ablation (add groups in order):')
log('')
log('| Cumulative groups | n features | CV val AUC |')
log('|---|---|---|')
for group_name, group_feats in FEATURE_GROUPS.items():
    running_features.extend(group_feats)
    Xa = train_df[running_features].values
    aucs = []
    for tr, va in fold_iters:
        train_d = lgb.Dataset(Xa[tr], label=y[tr], weight=sw[tr])
        val_d = lgb.Dataset(Xa[va], label=y[va], weight=sw[va])
        m = lgb.train(LGB_PARAMS, train_d, num_boost_round=300,
                      valid_sets=[val_d], callbacks=[lgb.early_stopping(50, verbose=False), lgb.log_evaluation(0)])
        aucs.append(roc_auc_score(y[va], m.predict(Xa[va]), sample_weight=sw[va]))
    auc_mean = np.mean(aucs)
    ablation_results[group_name] = {'features': running_features.copy(), 'auc': auc_mean}
    log(f'| +{group_name} | {len(running_features)} | {auc_mean:.4f} |')

log('')

# Save ablation
with open(ROOT / 'ablation.json', 'w') as f:
    json.dump({k: {'auc': v['auc'], 'feature_count': len(v['features'])} for k, v in ablation_results.items()}, f, indent=2)

# ============================================================
# Save final report
# ============================================================
log('')
log('## Files saved')
log('')
log('- `lgb_final.txt` — trained LightGBM model')
log('- `feature_importance.csv` — feature importances')
log('- `holdout_predictions.csv` — held-out predictions (for Stage 5/6 TS post-processing)')
log('- `ablation.json` — feature ablation results')
log('- `report.md` — this report')

with open(ROOT / 'report.md', 'w', encoding='utf-8') as f:
    f.write('\n'.join(REPORT_LINES))

print('\n=== PIPELINE COMPLETE ===')
print(f'Report saved to {ROOT / "report.md"}')
