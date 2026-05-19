"""
XGBoost backtest — Option 1 from corrected Phase 4 methodology.

For each slate in 29-slate set:
  1. Parse pool CSV (SaberSim format with player IDs)
  2. Compute the same 137 features per pool lineup
  3. Apply XGBoost models to predict pred_finish and pred_top1
  4. Run greedy selection with multiple objective options:
     - XGB-Top1: use pred_top1 ONLY
     - XGB-Finish: use pred_finish ONLY
     - XGB-Top1+BB25: pred_top1 + bring-back floors
  5. Score selected portfolio against actuals
  6. Compute ROI

vs baselines:
  - Atlas (from existing methods_multi_results.json)
  - BB25 (from existing methods_multi_results.json)
"""
import csv, os, re, sys, json, time
from collections import Counter, defaultdict
import numpy as np
import pandas as pd
import xgboost as xgb

LIVE_AUDIT = "C:/Users/colin/Projects/dfs-optimizer/live_audit"
DFSOPTO = "C:/Users/colin/dfs opto"
FEE = 20
N = 150
POS_RE = r'(?:P|C|1B|2B|3B|SS|OF|CPT|FLEX|UTIL|PG|SG|SF|PF|G|F)'

# Configs matching production
ATLAS_EXPOSURE_CAP_HITTER = 0.25
ATLAS_EXPOSURE_CAP_PITCHER = 0.45
ATLAS_TEAM_STACK_CAP = 0.20
STACKS_ANCHOR_HIT_CAP = 0.55
STACKS_ANCHOR_PIT_CAP = 0.70
STACKS_N_HIT_ANCHORS = 3
STACKS_N_PIT_ANCHORS = 1
BB25_TARGET = 0.25
BB25_2_TARGET = 0.12
BB25_3_TARGET = 0.05

SLATES = [
    ('4-6-26', '4-6-26_projections.csv', 'dkactuals 4-6-26.csv', 'sspool4-6-26.csv'),
    ('4-8-26', '4-8-26projections.csv', '4-8-26actuals.csv', '4-8-26sspool.csv'),
    ('4-12-26', '4-12-26projections.csv', '4-12-26actuals.csv', '4-12-26sspool.csv'),
    ('4-14-26', '4-14-26projections.csv', '4-14-26actuals.csv', '4-14-26sspool.csv'),
    ('4-15-26', '4-15-26projections.csv', '4-15-26actuals.csv', '4-15-26sspool.csv'),
    ('4-17-26', '4-17-26projections.csv', '4-17-26actuals.csv', '4-17-26sspool.csv'),
    ('4-18-26', '4-18-26projections.csv', '4-18-26actuals.csv', '4-18-26sspool.csv'),
    ('4-19-26', '4-19-26projections.csv', '4-19-26actuals.csv', '4-19-26sspool.csv'),
    ('4-20-26', '4-20-26projections.csv', '4-20-26actuals.csv', '4-20-26sspool.csv'),
    ('4-21-26', '4-21-26projections.csv', '4-21-26actuals.csv', '4-21-26sspool.csv'),
    ('4-22-26', '4-22-26projections.csv', '4-22-26actuals.csv', '4-22-26sspool.csv'),
    ('4-23-26', '4-23-26projections.csv', '4-23-26actuals.csv', '4-23-26sspool.csv'),
    ('4-24-26', '4-24-26projections.csv', '4-24-26actuals.csv', '4-24-26sspool.csv'),
    ('4-25-26', '4-25-26projections.csv', '4-25-26actuals.csv', '4-25-26sspool.csv'),
    ('4-25-26-early', '4-25-26projectionsearly.csv', '4-25-26actualsearly.csv', '4-25-26sspoolearly.csv'),
    ('4-26-26', '4-26-26projections.csv', '4-26-26actuals.csv', '4-26-26sspool.csv'),
    ('4-27-26', '4-27-26projections.csv', '4-27-26actuals.csv', '4-27-26sspool.csv'),
    ('4-28-26', '4-28-26projections.csv', '4-28-26actuals.csv', '4-28-26sspool.csv'),
    ('4-29-26', '4-29-26projections.csv', '4-29-26actuals.csv', '4-29-26sspool.csv'),
    ('5-1-26', '5-1-26projections.csv', '5-1-26actuals.csv', '5-1-26sspool.csv'),
    ('5-2-26', '5-2-26projections.csv', '5-2-26actuals.csv', '5-2-26sspool.csv'),
    ('5-2-26-main', '5-2-26projectionsmain.csv', '5-2-26actualsmain.csv', '5-2-26sspoolmain.csv'),
    ('5-2-26-night', '5-2-26projectionsnight.csv', '5-2-26actualsnight.csv', '5-2-26sspoolnight.csv'),
    ('5-3-26', '5-3-26projections.csv', '5-3-26actuals.csv', '5-3-26sspool.csv'),
    ('5-3-26-late', '5-3-26projectionslate.csv', '5-3-26actualslate.csv', '5-3-26sspoollate.csv'),
    ('5-4-26', '5-4-26projections.csv', '5-4-26actuals.csv', '5-4-26sspool.csv'),
    ('5-4-26-late', '5-4-26projectionslate.csv', '5-4-26actualslate.csv', '5-4-26sspoollate.csv'),
    ('5-5-26', '5-5-26projections.csv', '5-5-26actuals.csv', '5-5-26sspool.csv'),
    ('5-6-26', '5-6-26projections.csv', '5-6-26actuals.csv', '5-6-26sspool.csv'),
]

def norm(n): return re.sub(r'[^a-z0-9 ]+', '', n.lower()).strip()

def load_proj(path):
    if not os.path.exists(path): return None, None
    by_name = {}
    by_id = {}
    with open(path, encoding='utf-8') as f:
        for r in csv.DictReader(f):
            nm = norm(r.get('Name', ''))
            pid = (r.get('DFS ID') or '').strip()
            if not nm and not pid: continue
            try:
                rec = {
                    'name': r.get('Name', ''),
                    'team': (r.get('Team') or '').strip().upper(),
                    'opp': (r.get('Opp') or '').strip().upper(),
                    'salary': float(r.get('Salary', 0) or 0),
                    'own': float((r.get('Adj Own') or r.get('My Own') or '0').replace('%','') or 0),
                    'proj': float(r.get('My Proj') or r.get('SS Proj') or 0),
                    'ceil_85': float(r.get('dk_85_percentile') or 0),
                    'ceil_95': float(r.get('dk_95_percentile') or 0),
                    'ceil_99': float(r.get('dk_99_percentile') or 0),
                    'std_dev': float(r.get('dk_std') or 0),
                    'pos': (r.get('Pos') or '').strip(),
                    'saber_team_total': float((r.get('Saber Team') or '0').replace('%','') or 0),
                    'saber_game_total': float((r.get('Saber Total') or '0').replace('%','') or 0),
                }
                if nm and nm not in by_name: by_name[nm] = rec
                if pid: by_id[pid] = rec
            except (ValueError, TypeError): pass
    return by_name, by_id

def load_pool(path, by_id):
    """Parse SaberSim pool CSV. Returns list of [(pos, rec), ...] per lineup."""
    if not os.path.exists(path): return []
    lineups = []
    with open(path, encoding='utf-8') as f:
        reader = csv.reader(f)
        header = next(reader)
        pos_cols = [(i, h.strip()) for i, h in enumerate(header) if h.strip() in ('P','C','1B','2B','3B','SS','OF')]
        for row in reader:
            if not row: continue
            lu = []
            for i, pos in pos_cols:
                if i >= len(row): continue
                val = row[i].strip()
                if not val: continue
                rec = None
                if val.isdigit():
                    rec = by_id.get(val)
                else:
                    m = re.search(r'\((\d+)\)\s*$', val)
                    if m: rec = by_id.get(m.group(1))
                if not rec: continue
                lu.append((pos, rec))
            if len(lu) >= 7: lineups.append(lu)
    # Dedupe by sorted player ids
    seen = set()
    out = []
    for lu in lineups:
        key = tuple(sorted(r.get('name', '') for p, r in lu))
        if key in seen: continue
        seen.add(key)
        out.append(lu)
    return out

def load_actuals(path):
    """Parse contest standings actuals. Returns (entries_scores, player_fpts_by_name)."""
    if not os.path.exists(path): return [], {}
    entries = []
    fpts = {}
    with open(path, encoding='utf-8') as f:
        reader = csv.reader(f)
        header = next(reader)
        for r in reader:
            while len(r) < 11: r.append('')
            try:
                pts = float(r[4]) if r[4] else None
                if pts is not None: entries.append(pts)
            except ValueError: pass
            player_nm = r[7]
            try:
                f_pts = float(r[10]) if r[10] else None
                if player_nm and f_pts is not None:
                    fpts[norm(player_nm)] = f_pts
            except ValueError: pass
    return entries, fpts

def compute_features(lu, proj_data, slate_stats, pair_freq_field):
    """Compute the 137 features that match factor_engine_v4 for a pool lineup."""
    # lu = [(pos, rec), ...]
    if len(lu) < 7: return None
    matched = lu  # already matched
    projs = np.array([r['proj'] for p, r in matched])
    owns = np.array([r['own'] for p, r in matched])
    sals = np.array([r['salary'] for p, r in matched])
    ceils85 = np.array([r['ceil_85'] for p, r in matched])
    ceils95 = np.array([r['ceil_95'] for p, r in matched])
    ceils99 = np.array([r['ceil_99'] for p, r in matched])
    stds = np.array([r['std_dev'] for p, r in matched])
    sgts = np.array([r['saber_game_total'] for p, r in matched])
    sgms = np.array([r['saber_team_total'] for p, r in matched])
    is_p = np.array([p == 'P' for p, r in matched])
    hitter_mask = ~is_p
    teams_hit = Counter()
    team_opp = {}
    pitcher_opps = []
    pitcher_teams = []
    orders_by_team = defaultdict(list)
    sals_by_team = defaultdict(list)
    projs_by_team = defaultdict(list)
    names_norm = [norm(r['name']) for p, r in matched]
    for (pos, r), nm in zip(matched, names_norm):
        if pos == 'P':
            pitcher_opps.append(r['opp']); pitcher_teams.append(r['team'])
        else:
            t = r['team']; teams_hit[t] += 1; team_opp[t] = r['opp']
            sals_by_team[t].append(r['salary']); projs_by_team[t].append(r['proj'])

    feats = {}
    # Basic
    feats['proj_sum'] = float(projs.sum()); feats['proj_mean'] = float(projs.mean())
    feats['proj_std'] = float(projs.std()); feats['proj_max'] = float(projs.max())
    feats['proj_min'] = float(projs.min()); feats['proj_range'] = float(projs.max() - projs.min())
    feats['proj_cv'] = float(projs.std() / max(0.01, projs.mean()))
    feats['own_sum'] = float(owns.sum()); feats['own_mean'] = float(owns.mean())
    feats['own_std'] = float(owns.std()); feats['own_max'] = float(owns.max())
    feats['own_min'] = float(owns.min()); feats['own_range'] = float(owns.max() - owns.min())
    feats['own_prod_log'] = float(np.log(np.maximum(0.001, owns/100)).sum())
    feats['sal_sum'] = float(sals.sum()); feats['sal_mean'] = float(sals.mean())
    feats['sal_std'] = float(sals.std()); feats['sal_unused'] = float(50000 - sals.sum())
    feats['ceil85_sum'] = float(ceils85.sum()); feats['ceil95_sum'] = float(ceils95.sum())
    feats['ceil99_sum'] = float(ceils99.sum()); feats['ceil85_mean'] = float(ceils85.mean())
    feats['ceil85_max'] = float(ceils85.max()); feats['ceil85_min'] = float(ceils85.min())
    feats['ceil_to_proj_ratio'] = float(ceils85.sum() / max(1, projs.sum()))
    feats['std_sum'] = float(stds.sum()); feats['std_mean'] = float(stds.mean())
    feats['var_sum'] = float((stds**2).sum())
    feats['saber_team_sum'] = float(sgms.sum()); feats['saber_team_mean'] = float(sgms.mean())
    feats['saber_game_sum'] = float(sgts.sum()); feats['saber_game_mean'] = float(sgts.mean())

    # Hitter/Pitcher
    if hitter_mask.sum() > 0:
        hprojs = projs[hitter_mask]; howns = owns[hitter_mask]; hsals = sals[hitter_mask]; hceils = ceils85[hitter_mask]
        feats['h_proj_sum'] = float(hprojs.sum()); feats['h_proj_mean'] = float(hprojs.mean())
        feats['h_proj_max'] = float(hprojs.max()); feats['h_proj_min'] = float(hprojs.min())
        feats['h_proj_std'] = float(hprojs.std()); feats['h_own_sum'] = float(howns.sum())
        feats['h_own_mean'] = float(howns.mean()); feats['h_own_std'] = float(howns.std())
        feats['h_own_min'] = float(howns.min()); feats['h_ceil85_sum'] = float(hceils.sum())
        feats['h_ceil85_max'] = float(hceils.max()); feats['h_sal_mean'] = float(hsals.mean())
        feats['h_sal_std'] = float(hsals.std())
    if is_p.sum() > 0:
        pprojs = projs[is_p]; powns = owns[is_p]; psals = sals[is_p]
        feats['p_proj_sum'] = float(pprojs.sum()); feats['p_proj_mean'] = float(pprojs.mean())
        feats['p_own_sum'] = float(powns.sum()); feats['p_own_mean'] = float(powns.mean())
        feats['p_sal_sum'] = float(psals.sum()); feats['p_n'] = int(len(pprojs))

    feats['proj_per_dollar'] = float(feats['proj_sum'] / max(1, feats['sal_sum'] / 1000))
    feats['ceil85_per_dollar'] = float(feats['ceil85_sum'] / max(1, feats['sal_sum'] / 1000))
    feats['proj_x_own_inverse'] = float(feats['proj_sum'] / max(0.001, feats['own_sum']))
    feats['ceil_x_own_inverse'] = float(feats['ceil85_sum'] / max(0.001, feats['own_sum']))
    feats['var_per_proj'] = float(feats['var_sum'] / max(1, feats['proj_sum']))
    feats['ceil_minus_proj'] = float(feats['ceil85_sum'] - feats['proj_sum'])

    # Stack
    counts = sorted(teams_hit.values(), reverse=True) if teams_hit else [0]
    while len(counts) < 5: counts.append(0)
    feats['primary_stack_size'] = int(counts[0])
    feats['secondary_stack_size'] = int(counts[1])
    feats['tertiary_stack_size'] = int(counts[2])
    feats['has_5_stack'] = 1.0 if counts[0] >= 5 else 0.0
    feats['has_4_stack'] = 1.0 if counts[0] >= 4 else 0.0
    feats['has_3_stack'] = 1.0 if counts[0] >= 3 else 0.0
    feats['has_4_secondary'] = 1.0 if counts[1] >= 4 else 0.0
    feats['has_3_secondary'] = 1.0 if counts[1] >= 3 else 0.0
    feats['num_teams'] = len(teams_hit)
    feats['shape_5_3'] = 1.0 if counts[0] == 5 and counts[1] == 3 else 0.0
    feats['shape_5_2'] = 1.0 if counts[0] == 5 and counts[1] == 2 else 0.0
    feats['shape_4_4'] = 1.0 if counts[0] == 4 and counts[1] == 4 else 0.0
    feats['shape_4_3'] = 1.0 if counts[0] == 4 and counts[1] == 3 else 0.0

    primary_team = teams_hit.most_common(1)[0][0] if teams_hit else None
    if primary_team:
        pteam_sals = sals_by_team.get(primary_team, [])
        pteam_projs = projs_by_team.get(primary_team, [])
        feats['primary_stack_sal_sum'] = float(sum(pteam_sals))
        feats['primary_stack_proj_sum'] = float(sum(pteam_projs))
        feats['primary_stack_sal_std'] = float(np.std(pteam_sals)) if len(pteam_sals) > 1 else 0
        feats['primary_stack_order_mean'] = 5.0  # not computed for pool
        feats['primary_stack_top4_orders'] = 0
        feats['primary_stack_consecutive'] = 0.0

    bringback = 0
    if primary_team and primary_team in team_opp:
        bringback = teams_hit.get(team_opp[primary_team], 0)
    feats['bringback_count'] = int(bringback)
    feats['has_bringback'] = 1.0 if bringback >= 1 else 0.0
    feats['has_bringback_2plus'] = 1.0 if bringback >= 2 else 0.0
    feats['game_stack_size'] = int(counts[0] + bringback)

    pitcher_anti = sum(1 for (pos, r) in matched if pos != 'P' and r['team'] in pitcher_opps)
    feats['pitcher_anti_hitters'] = int(pitcher_anti)
    pitcher_in_stack = sum(teams_hit.get(pt, 0) for pt in pitcher_teams)
    feats['pitcher_team_hitters'] = int(pitcher_in_stack)

    feats['saber_team_total_sum'] = float(sgms.sum())
    feats['saber_team_total_mean'] = float(sgms.mean())
    feats['saber_game_total_sum'] = float(sgts.sum())

    sorted_sals = sorted(sals, reverse=True)
    feats['cheap_3_sum'] = float(sum(sorted_sals[-3:]))
    feats['stud_3_sum'] = float(sum(sorted_sals[:3]))
    feats['stud_to_cheap_ratio'] = float(feats['stud_3_sum'] / max(1, feats['cheap_3_sum']))

    feats['order_mean'] = 5.0
    feats['order_top4_count'] = 0

    feats['n_chalk_30plus'] = int((owns >= 30).sum())
    feats['n_chalk_20plus'] = int((owns >= 20).sum())
    feats['n_lev_5less'] = int((owns < 5).sum())
    feats['n_lev_10less'] = int((owns < 10).sum())
    feats['n_lev_15less'] = int((owns < 15).sum())

    feats['has_top3_proj_anchor'] = 0  # not computed

    # Dev features
    impliedOwn = slate_stats.get('implied_own', {})
    dev_sum_under = 0
    dev_sum = 0
    dev_n_over = 0
    dev_max_over = 0
    devs = []
    for (pos, r), nm in zip(matched, names_norm):
        imp = impliedOwn.get(nm, r['own'])
        dev = r['own'] - imp
        devs.append(dev)
        dev_sum += dev
        if dev < 0: dev_sum_under += dev
        if dev > 5: dev_n_over += 1
        if dev > dev_max_over: dev_max_over = dev
    feats['dev_sum'] = float(dev_sum)
    feats['dev_max_over'] = float(dev_max_over)
    feats['dev_sum_under'] = float(dev_sum_under)
    feats['dev_n_over'] = int(dev_n_over)
    feats['dev_n_under'] = int(sum(1 for d in devs if d < -5))
    feats['dev_mean'] = float(np.mean(devs))
    feats['dev_abs_sum'] = float(np.abs(devs).sum())

    # v4 features
    pair_freqs = []
    for i in range(len(names_norm)):
        for j in range(i+1, len(names_norm)):
            key = tuple(sorted([names_norm[i], names_norm[j]]))
            pair_freqs.append(pair_freq_field.get(key, 0))
    if pair_freqs:
        feats['pair_freq_sum'] = float(sum(pair_freqs))
        feats['pair_freq_max'] = float(max(pair_freqs))
        feats['pair_freq_mean'] = float(np.mean(pair_freqs))
        feats['pair_freq_top5_sum'] = float(sum(sorted(pair_freqs, reverse=True)[:5]))
    else:
        feats['pair_freq_sum'] = 0; feats['pair_freq_max'] = 0
        feats['pair_freq_mean'] = 0; feats['pair_freq_top5_sum'] = 0

    ply_freq = slate_stats.get('player_freq', {})
    ply_fs = [ply_freq.get(nm, 0) for nm in names_norm]
    feats['player_freq_sum'] = float(sum(ply_fs))
    feats['player_freq_max'] = float(max(ply_fs)) if ply_fs else 0
    feats['player_freq_min'] = float(min(ply_fs)) if ply_fs else 0
    feats['is_unique_lineup'] = 1.0 if feats['pair_freq_max'] < 0.001 else 0.0

    feats['antipitcher_count'] = int(pitcher_anti)
    feats['antipitcher_proj_sum'] = float(sum(r['proj'] for (pos, r), nm in zip(matched, names_norm) if pos != 'P' and r['team'] in pitcher_opps))

    feats['pitcher_x_pitcher_anti'] = 0.0
    if len(pitcher_teams) == 2:
        popps = [r['opp'] for pos, r in matched if pos == 'P']
        feats['pitcher_x_pitcher_anti'] = 1.0 if pitcher_teams[0] == popps[1] else 0.0
    feats['stack_with_pitcher_corr'] = int(pitcher_in_stack)

    feats['sal_skew'] = float(pd.Series(sals).skew()) if len(sals) > 2 else 0
    feats['sal_p75_minus_p25'] = float(np.percentile(sals, 75) - np.percentile(sals, 25))
    feats['sal_top3_to_bot3'] = float(sum(sorted_sals[:3]) / max(1, sum(sorted_sals[-3:])))
    feats['own_skew'] = float(pd.Series(owns).skew()) if len(owns) > 2 else 0
    feats['own_p75_minus_p25'] = float(np.percentile(owns, 75) - np.percentile(owns, 25))

    pos_stats = slate_stats.get('pos_proj_stats', {})
    zs = []
    for pos, r in matched:
        stat = pos_stats.get(pos)
        if stat and stat['std'] > 0.001:
            zs.append((r['proj'] - stat['mean']) / stat['std'])
    feats['pos_proj_zscore_sum'] = float(sum(zs)) if zs else 0
    feats['pos_proj_zscore_max'] = float(max(zs)) if zs else 0
    feats['pos_proj_zscore_min'] = float(min(zs)) if zs else 0

    game_keys = set()
    for pos, r in matched:
        if pos == 'P': continue
        gk = tuple(sorted([r['team'], r['opp']]))
        game_keys.add(gk)
    feats['num_games_in_lineup'] = len(game_keys)
    teams_in = set(r['team'] for pos, r in matched if pos != 'P')
    feats['num_teams_distinct'] = len(teams_in)
    feats['highest_game_total_in_lineup'] = float(max(sgts)) if len(sgts) > 0 else 0
    feats['lineup_avg_game_total'] = float(np.mean(sgts)) if len(sgts) > 0 else 0

    slate_h_mean = slate_stats.get('slate_h_mean', 0)
    feats['h_proj_excess_vs_slate_mean'] = feats.get('h_proj_mean', 0) - slate_h_mean
    slate_p_max = pos_stats.get('P', {}).get('max', 0)
    p_projs = [r['proj'] for pos, r in matched if pos == 'P']
    feats['p_proj_excess_vs_slate_max'] = max(p_projs) - slate_p_max if p_projs else 0

    # Also proj_vs_slate_p50 / p90
    feats['proj_vs_slate_p50'] = feats['proj_mean'] - slate_stats.get('slate_proj_p50', 0)
    feats['proj_vs_slate_p90'] = feats['proj_max'] - slate_stats.get('slate_proj_p90', 0)
    feats['own_vs_slate_median'] = feats['own_mean'] - slate_stats.get('slate_own_median', 0)
    feats['own_vs_slate_p75'] = feats['own_max'] - slate_stats.get('slate_own_p75', 0)

    sorted_owns = sorted(owns, reverse=True); sorted_projs = sorted(projs, reverse=True)
    feats['proj_top3_sum'] = float(sum(sorted_projs[:3]))
    feats['proj_bot3_sum'] = float(sum(sorted_projs[-3:]))
    feats['own_top3_sum'] = float(sum(sorted_owns[:3]))
    feats['own_bot3_sum'] = float(sum(sorted_owns[-3:]))
    feats['sal_top3_sum'] = float(sum(sorted_sals[:3]))
    feats['sal_bot3_sum'] = float(sum(sorted_sals[-3:]))
    feats['proj_top3_ratio'] = float(feats['proj_top3_sum'] / max(1, feats['proj_sum']))
    return feats

def compute_slate_stats(by_name, field_lineups_norms):
    """Slate-level stats needed for feature computation."""
    projs = [r['proj'] for r in by_name.values() if r['pos'] != 'P']
    owns = [r['own'] for r in by_name.values() if r['pos'] != 'P']
    pitcher_projs = [r['proj'] for r in by_name.values() if r['pos'] == 'P']

    # implied own per player (per-position normalized)
    by_pos = defaultdict(list)
    for nm, r in by_name.items():
        p = r['pos'].split('/')[0]
        by_pos[p].append((nm, r['proj']))
    implied = {}
    for pos, players in by_pos.items():
        demands = [max(0.01, p) ** 1.5 for nm, p in players]
        total = sum(demands)
        slot_total = {'P': 200, 'C': 100, '1B': 100, '2B': 100, '3B': 100, 'SS': 100, 'OF': 300, 'UTIL': 100}.get(pos, 100)
        for (nm, _), d in zip(players, demands):
            implied[nm] = (d / total) * slot_total if total > 0 else 0

    # per-position projection stats
    pos_stats = {}
    by_pos_proj = defaultdict(list)
    for nm, r in by_name.items():
        p = r['pos'].split('/')[0]
        by_pos_proj[p].append(r['proj'])
    for p, v in by_pos_proj.items():
        pos_stats[p] = {'mean': np.mean(v), 'std': np.std(v), 'max': max(v) if v else 0}

    # Per-slate player and pair frequencies (from contest standings field if available)
    player_freq = {}
    pair_freq = {}
    if field_lineups_norms:
        n = len(field_lineups_norms)
        ply_count = Counter(); pair_count = Counter()
        for names in field_lineups_norms:
            for nm in names: ply_count[nm] += 1
            for i in range(len(names)):
                for j in range(i+1, len(names)):
                    k = tuple(sorted([names[i], names[j]]))
                    pair_count[k] += 1
        player_freq = {nm: c/n for nm, c in ply_count.items()}
        pair_freq = {k: c/n for k, c in pair_count.items()}

    return {
        'slate_proj_p50': np.median(projs) if projs else 0,
        'slate_proj_p75': np.percentile(projs, 75) if projs else 0,
        'slate_proj_p90': np.percentile(projs, 90) if projs else 0,
        'slate_own_median': np.median(owns) if owns else 0,
        'slate_own_p75': np.percentile(owns, 75) if owns else 0,
        'pitcher_proj_max': max(pitcher_projs) if pitcher_projs else 0,
        'slate_h_mean': np.mean(projs) if projs else 0,
        'implied_own': implied,
        'pos_proj_stats': pos_stats,
        'player_freq': player_freq,
        'pair_freq': pair_freq,
    }

def load_field_lineups(actuals_path):
    """Parse actuals/standings file. Returns list of [norm_name, ...] per entry."""
    if not os.path.exists(actuals_path): return []
    lineups = []
    POS_REGEX = re.compile(r'\s+(?=' + POS_RE + r'\s+\w)')
    with open(actuals_path, encoding='utf-8') as f:
        reader = csv.reader(f)
        header = next(reader)
        for r in reader:
            while len(r) < 11: r.append('')
            lineup = r[5]
            if not lineup: continue
            parts = POS_REGEX.split(lineup.strip())
            names = []
            for p in parts:
                m = re.match(r'^(' + POS_RE + r')\s+(.+)$', p.strip())
                if m: names.append(norm(m.group(2).strip()))
            if names: lineups.append(names)
    return lineups

def greedy_select(pool_with_scores, score_key, bb_active, anchor_ids):
    """Greedy with caps, anchor caps, BB25 floors."""
    N_pool = len(pool_with_scores)
    sorted_idx = sorted(range(N_pool), key=lambda i: -pool_with_scores[i][score_key])

    selected = []
    selected_set = set()
    exposure = defaultdict(int)
    team_stack_count = defaultdict(int)
    bb1 = bb2 = bb3 = 0

    for step in range(N):
        req_bb1 = int(np.ceil(BB25_TARGET * (step+1))) if bb_active else 0
        req_bb2 = int(np.ceil(BB25_2_TARGET * (step+1))) if bb_active else 0
        req_bb3 = int(np.ceil(BB25_3_TARGET * (step+1))) if bb_active else 0
        need_bb1 = bb1 < req_bb1
        need_bb2 = bb2 < req_bb2
        need_bb3 = bb3 < req_bb3

        best = None
        for ii in sorted_idx:
            if ii in selected_set: continue
            cand = pool_with_scores[ii]
            if need_bb3 and cand['bringback'] < 3: continue
            elif need_bb2 and not need_bb3 and cand['bringback'] < 2: continue
            elif need_bb1 and not need_bb2 and not need_bb3 and cand['bringback'] < 1: continue

            ok = True
            for pos, r in cand['lu']:
                nm = norm(r['name'])
                is_p = pos == 'P'
                is_anchor = nm in anchor_ids
                cap = (STACKS_ANCHOR_PIT_CAP if is_anchor else ATLAS_EXPOSURE_CAP_PITCHER) if is_p else (STACKS_ANCHOR_HIT_CAP if is_anchor else ATLAS_EXPOSURE_CAP_HITTER)
                if exposure[nm] >= int(np.ceil(cap * N)): ok = False; break
            if not ok: continue
            tc = Counter()
            for pos, r in cand['lu']:
                if pos == 'P': continue
                tc[r['team']] += 1
            stack_ok = True
            for t, cnt in tc.items():
                if cnt >= 4 and team_stack_count[t] >= int(np.ceil(ATLAS_TEAM_STACK_CAP * N)):
                    stack_ok = False; break
            if not stack_ok: continue
            best = ii; break  # already sorted by score, take first valid

        if best is None:
            # fallback: ignore BB floors
            for ii in sorted_idx:
                if ii in selected_set: continue
                cand = pool_with_scores[ii]
                ok = True
                for pos, r in cand['lu']:
                    nm = norm(r['name'])
                    is_p = pos == 'P'
                    is_anchor = nm in anchor_ids
                    cap = (STACKS_ANCHOR_PIT_CAP if is_anchor else ATLAS_EXPOSURE_CAP_PITCHER) if is_p else (STACKS_ANCHOR_HIT_CAP if is_anchor else ATLAS_EXPOSURE_CAP_HITTER)
                    if exposure[nm] >= int(np.ceil(cap * N)): ok = False; break
                if not ok: continue
                tc = Counter()
                for pos, r in cand['lu']:
                    if pos == 'P': continue
                    tc[r['team']] += 1
                stack_ok = True
                for t, cnt in tc.items():
                    if cnt >= 4 and team_stack_count[t] >= int(np.ceil(ATLAS_TEAM_STACK_CAP * N)):
                        stack_ok = False; break
                if not stack_ok: continue
                best = ii; break
            if best is None: break

        cand = pool_with_scores[best]
        selected.append(cand)
        selected_set.add(best)
        if cand['bringback'] >= 1: bb1 += 1
        if cand['bringback'] >= 2: bb2 += 1
        if cand['bringback'] >= 3: bb3 += 1
        for pos, r in cand['lu']:
            nm = norm(r['name'])
            exposure[nm] += 1
        tc = Counter()
        for pos, r in cand['lu']:
            if pos == 'P': continue
            tc[r['team']] += 1
        for t, cnt in tc.items():
            if cnt >= 4: team_stack_count[t] += 1

    return selected

def score_portfolio(selected, entries_scores, player_fpts):
    """Score portfolio against actuals contest."""
    cost = len(selected) * FEE
    entries_sorted = sorted(entries_scores, reverse=True)
    F = len(entries_sorted) + len(selected)
    pool = F * FEE * 0.88
    cash_line = int(F * 0.22)
    raw = np.array([np.power(r+1, -1.15) for r in range(cash_line)])
    raw_sum = raw.sum()
    payout_table = np.maximum(FEE * 1.2, (raw / raw_sum) * pool)
    payout_table = (payout_table / payout_table.sum()) * pool

    payout = 0; top1 = 0; top01 = 0
    for cand in selected:
        s = 0
        for pos, r in cand['lu']:
            s += player_fpts.get(norm(r['name']), 0)
        # rank
        lo, hi = 0, len(entries_sorted)
        while lo < hi:
            m = (lo + hi) >> 1
            if entries_sorted[m] > s: lo = m+1
            else: hi = m
        rank = lo
        if rank < len(payout_table): payout += payout_table[rank]
        if rank < F * 0.01: top1 += 1
        if rank < F * 0.001: top01 += 1
    roi = (payout / cost - 1) * 100 if cost > 0 else 0
    return {'cost': cost, 'payout': payout, 'roi': roi, 'top1': top1, 'top01': top01}

def main():
    print("Loading XGBoost models (LEAK-FREE)...", file=sys.stderr)
    reg_model = xgb.Booster(); reg_model.load_model(os.path.join(LIVE_AUDIT, 'xgb_top1_v2.json'))
    clf_model = xgb.Booster(); clf_model.load_model(os.path.join(LIVE_AUDIT, 'xgb_top1_v2.json'))
    # Get feature names IN ORDER from the model itself
    feature_cols = reg_model.feature_names
    print(f"Models loaded. Features expected (in training order): {len(feature_cols)}", file=sys.stderr)

    results = []
    for slate, proj_f, actuals_f, pool_f in SLATES:
        proj_path = os.path.join(DFSOPTO, proj_f)
        actuals_path = os.path.join(DFSOPTO, actuals_f)
        pool_path = os.path.join(DFSOPTO, pool_f)
        if not all(os.path.exists(p) for p in [proj_path, actuals_path, pool_path]):
            continue
        t0 = time.time()
        by_name, by_id = load_proj(proj_path)
        if not by_name: continue
        pool = load_pool(pool_path, by_id)
        if len(pool) < 100: continue
        entries_scores, player_fpts = load_actuals(actuals_path)
        if not entries_scores: continue

        # Field lineups for pair frequency
        field_norms = load_field_lineups(actuals_path)
        slate_stats = compute_slate_stats(by_name, field_norms)

        # Compute features for every pool lineup
        feats_rows = []
        for lu in pool:
            f = compute_features(lu, by_name, slate_stats, slate_stats.get('pair_freq', {}))
            if f is not None:
                feats_rows.append(f)
            else:
                feats_rows.append(None)
        # Build matrix
        valid_indices = [i for i, f in enumerate(feats_rows) if f is not None]
        if len(valid_indices) < 100:
            print(f"  {slate}: too few valid pool lineups", file=sys.stderr); continue
        X_rows = []
        for i in valid_indices:
            row = [feats_rows[i].get(c, 0) for c in feature_cols]
            X_rows.append(row)
        X = np.array(X_rows, dtype=np.float32)
        dpool = xgb.DMatrix(X, feature_names=feature_cols)
        pred_finish = reg_model.predict(dpool)
        pred_top1 = clf_model.predict(dpool)

        # Bring-back per candidate
        bringbacks = []
        anchor_ids = set()
        # Anchor IDs: top-N projection hitters/pitchers in pool
        proj_in_pool = defaultdict(float)
        for lu in pool:
            for pos, r in lu:
                nm = norm(r['name'])
                if proj_in_pool[(pos, nm)] == 0: proj_in_pool[(pos, nm)] = r['proj']
        # rank
        hitters = sorted([(nm, p) for (pos, nm), p in proj_in_pool.items() if pos != 'P'], key=lambda x: -x[1])
        pitchers = sorted([(nm, p) for (pos, nm), p in proj_in_pool.items() if pos == 'P'], key=lambda x: -x[1])
        anchor_ids = set([nm for nm, _ in hitters[:STACKS_N_HIT_ANCHORS]] + [nm for nm, _ in pitchers[:STACKS_N_PIT_ANCHORS]])

        pool_with_scores = []
        for j, i in enumerate(valid_indices):
            lu = pool[i]
            tc = Counter(); team_opp_map = {}
            for pos, r in lu:
                if pos == 'P': continue
                tc[r['team']] += 1; team_opp_map[r['team']] = r['opp']
            primary = max(tc.items(), key=lambda x: x[1])[0] if tc else None
            bb = tc.get(team_opp_map.get(primary), 0) if primary else 0
            pool_with_scores.append({
                'lu': lu, 'bringback': bb,
                'pred_finish': float(pred_finish[j]),
                'pred_top1': float(pred_top1[j]),
            })

        # Variants
        variant_results = {}
        for variant_name, score_key, bb_active in [
            ('XGB-Finish', 'pred_finish', False),
            ('XGB-Top1', 'pred_top1', False),
            ('XGB-Top1+BB25', 'pred_top1', True),
            ('XGB-Finish+BB25', 'pred_finish', True),
        ]:
            selected = greedy_select(pool_with_scores, score_key, bb_active, anchor_ids)
            score = score_portfolio(selected, entries_scores, player_fpts)
            variant_results[variant_name] = score

        results.append({'slate': slate, 'variants': variant_results})
        print(f"  {slate} ({time.time()-t0:.1f}s): " +
              " | ".join(f"{n}:{r['roi']:.0f}%/t1={r['top1']}" for n, r in variant_results.items()),
              file=sys.stderr)

    # Aggregate
    print(f"\n=== AGGREGATE 29-slate XGBoost backtest ===")
    print(f"{'Variant':<20} {'ROI':>9} {'Profitable':>11} {'top1':>6} {'top01':>6} {'cost':>10} {'payout':>10}")
    variants_seen = set()
    for r in results:
        variants_seen.update(r['variants'].keys())
    for v in sorted(variants_seen):
        cost = sum(r['variants'].get(v, {}).get('cost', 0) for r in results)
        pay = sum(r['variants'].get(v, {}).get('payout', 0) for r in results)
        roi = (pay/cost - 1) * 100 if cost > 0 else 0
        prof = sum(1 for r in results if r['variants'].get(v, {}).get('roi', 0) > 0)
        top1 = sum(r['variants'].get(v, {}).get('top1', 0) for r in results)
        top01 = sum(r['variants'].get(v, {}).get('top01', 0) for r in results)
        print(f"{v:<20} {roi:>8.2f}% {prof}/{len(results):<7} {top1:>6} {top01:>6} ${cost:>9.0f} ${pay:>9.0f}")

    json.dump({'rows': results}, open(os.path.join(LIVE_AUDIT, 'xgb_backtest_results.json'), 'w'), indent=2, default=str)

if __name__ == '__main__':
    main()
