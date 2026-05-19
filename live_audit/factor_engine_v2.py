"""
Factor Engine v2 — generates 100+ candidate features per lineup per Method 6 (Kaggle massive-factor approach).

Categories:
  A. Basic sums/means/extremes (40+ features)
  B. Per-position aggregations (per-position projection, ownership, ceiling)
  C. Cross-feature interactions (proj × own, ceil × sal, etc.)
  D. Stack composition (order spread, salary spread within stack)
  E. Pitcher-specific (P projection, P opponent stack, P-vs-pool-min)
  F. Field-derived (vs slate medians)
  G. GroupBy aggregations (top-K vs bottom-K within lineup)
  H. Field-deviation exploitation (Method 3: actual field own vs projection-implied)

Output: factor_frame_v2.csv with ~150 features.
"""
import csv, os, re, sys, json
from collections import Counter, defaultdict
import numpy as np
import pandas as pd

LIVE_AUDIT = "C:/Users/colin/Projects/dfs-optimizer/live_audit"
DFSOPTO = "C:/Users/colin/dfs opto"
POS_RE = r'(?:P|C|1B|2B|3B|SS|OF|CPT|FLEX|UTIL|PG|SG|SF|PF|G|F)'

def parse_lineup(s):
    if not s: return []
    s = s.strip()
    parts = re.split(r'\s+(?=' + POS_RE + r'\s+\w)', s)
    out = []
    for p in parts:
        m = re.match(r'^(' + POS_RE + r')\s+(.+)$', p.strip())
        if m: out.append((m.group(1), m.group(2).strip()))
    return out

def norm(n): return re.sub(r'[^a-z0-9 ]+', '', n.lower()).strip()

def load_proj(slate):
    candidates = [f"{slate}projections.csv", f"{slate}_projections.csv"]
    for c in candidates:
        p = os.path.join(DFSOPTO, c)
        if os.path.exists(p):
            by_name = {}
            with open(p, encoding='utf-8') as f:
                for r in csv.DictReader(f):
                    nm = norm(r.get('Name', ''))
                    if not nm: continue
                    try:
                        rec = {
                            'team': (r.get('Team') or '').strip().upper(),
                            'opp': (r.get('Opp') or '').strip().upper(),
                            'salary': float(r.get('Salary', 0) or 0),
                            'own': float((r.get('Adj Own') or r.get('My Own') or '0').replace('%','') or 0),
                            'proj': float(r.get('My Proj') or r.get('SS Proj') or 0),
                            'ceil_85': float(r.get('dk_85_percentile') or r.get('dk_85') or 0),
                            'ceil_95': float(r.get('dk_95_percentile') or 0),
                            'ceil_99': float(r.get('dk_99_percentile') or 0),
                            'std_dev': float(r.get('dk_std') or 0),
                            'pos': (r.get('Pos') or '').strip(),
                            'order': r.get('Order') or '',
                            'saber_team_total': float((r.get('Saber Team') or '0').replace('%','') or 0),
                            'saber_game_total': float((r.get('Saber Total') or '0').replace('%','') or 0),
                        }
                        if nm not in by_name:
                            by_name[nm] = rec
                    except (ValueError, TypeError):
                        continue
            return by_name
    return None

def compute_slate_stats(player_map):
    """Per-slate stats used for ratio features (field-relative)."""
    projs = [r['proj'] for r in player_map.values() if r['pos'] != 'P']
    owns = [r['own'] for r in player_map.values() if r['pos'] != 'P']
    pitcher_projs = [r['proj'] for r in player_map.values() if r['pos'] == 'P']
    pitcher_owns = [r['own'] for r in player_map.values() if r['pos'] == 'P']
    return {
        'slate_proj_p50': np.median(projs) if projs else 0,
        'slate_proj_p75': np.percentile(projs, 75) if projs else 0,
        'slate_proj_p90': np.percentile(projs, 90) if projs else 0,
        'slate_own_median': np.median(owns) if owns else 0,
        'slate_own_p75': np.percentile(owns, 75) if owns else 0,
        'pitcher_proj_max': max(pitcher_projs) if pitcher_projs else 0,
        'pitcher_own_max': max(pitcher_owns) if pitcher_owns else 0,
    }

def compute_factors_v2(positions, player_map, slate_stats=None):
    """Generate 100+ factors for one lineup."""
    factors = {}
    if not positions: return None
    matched = []
    for pos, name in positions:
        rec = player_map.get(norm(name))
        if rec:
            matched.append((pos, name, rec))
    if len(matched) < 7: return None

    projs = np.array([r['proj'] for p, n, r in matched])
    owns = np.array([r['own'] for p, n, r in matched])
    sals = np.array([r['salary'] for p, n, r in matched])
    ceils85 = np.array([r['ceil_85'] for p, n, r in matched])
    ceils95 = np.array([r['ceil_95'] for p, n, r in matched])
    ceils99 = np.array([r['ceil_99'] for p, n, r in matched])
    stds = np.array([r['std_dev'] for p, n, r in matched])
    saber_team = np.array([r['saber_team_total'] for p, n, r in matched])
    saber_game = np.array([r['saber_game_total'] for p, n, r in matched])

    is_pitcher = np.array([p == 'P' for p, n, r in matched])
    hitter_mask = ~is_pitcher

    # === A. Basic sums/means/extremes ===
    factors['proj_sum'] = projs.sum()
    factors['proj_mean'] = projs.mean()
    factors['proj_std'] = projs.std()
    factors['proj_max'] = projs.max()
    factors['proj_min'] = projs.min()
    factors['proj_range'] = projs.max() - projs.min()
    factors['proj_cv'] = projs.std() / max(0.01, projs.mean())

    factors['own_sum'] = owns.sum()
    factors['own_mean'] = owns.mean()
    factors['own_std'] = owns.std()
    factors['own_max'] = owns.max()
    factors['own_min'] = owns.min()
    factors['own_range'] = owns.max() - owns.min()
    factors['own_prod_log'] = np.log(np.maximum(0.001, owns/100)).sum()

    factors['sal_sum'] = sals.sum()
    factors['sal_mean'] = sals.mean()
    factors['sal_std'] = sals.std()
    factors['sal_unused'] = 50000 - sals.sum()

    factors['ceil85_sum'] = ceils85.sum()
    factors['ceil95_sum'] = ceils95.sum()
    factors['ceil99_sum'] = ceils99.sum()
    factors['ceil85_mean'] = ceils85.mean()
    factors['ceil85_max'] = ceils85.max()
    factors['ceil85_min'] = ceils85.min()
    factors['ceil_to_proj_ratio'] = ceils85.sum() / max(1, projs.sum())

    factors['std_sum'] = stds.sum()
    factors['std_mean'] = stds.mean()
    factors['var_sum'] = (stds**2).sum()

    factors['saber_team_sum'] = saber_team.sum()
    factors['saber_team_mean'] = saber_team.mean()
    factors['saber_game_sum'] = saber_game.sum()
    factors['saber_game_mean'] = saber_game.mean()

    # === B. Hitter-only aggregations ===
    if hitter_mask.sum() > 0:
        hprojs = projs[hitter_mask]
        howns = owns[hitter_mask]
        hsals = sals[hitter_mask]
        hceils = ceils85[hitter_mask]
        factors['h_proj_sum'] = hprojs.sum()
        factors['h_proj_mean'] = hprojs.mean()
        factors['h_proj_max'] = hprojs.max()
        factors['h_proj_min'] = hprojs.min()
        factors['h_proj_std'] = hprojs.std()
        factors['h_own_sum'] = howns.sum()
        factors['h_own_mean'] = howns.mean()
        factors['h_own_std'] = howns.std()
        factors['h_own_min'] = howns.min()
        factors['h_ceil85_sum'] = hceils.sum()
        factors['h_ceil85_max'] = hceils.max()
        factors['h_sal_mean'] = hsals.mean()
        factors['h_sal_std'] = hsals.std()
    # Pitcher-only
    if is_pitcher.sum() > 0:
        pprojs = projs[is_pitcher]
        powns = owns[is_pitcher]
        psals = sals[is_pitcher]
        factors['p_proj_sum'] = pprojs.sum()
        factors['p_proj_mean'] = pprojs.mean()
        factors['p_own_sum'] = powns.sum()
        factors['p_own_mean'] = powns.mean()
        factors['p_sal_sum'] = psals.sum()
        factors['p_n'] = len(pprojs)

    # === C. Cross-feature interactions ===
    factors['proj_per_dollar'] = factors['proj_sum'] / max(1, factors['sal_sum'] / 1000)
    factors['ceil85_per_dollar'] = factors['ceil85_sum'] / max(1, factors['sal_sum'] / 1000)
    factors['proj_x_own_inverse'] = factors['proj_sum'] / max(0.001, factors['own_sum'])
    factors['ceil_x_own_inverse'] = factors['ceil85_sum'] / max(0.001, factors['own_sum'])
    factors['var_per_proj'] = factors['var_sum'] / max(1, factors['proj_sum'])
    factors['ceil_minus_proj'] = factors['ceil85_sum'] - factors['proj_sum']

    # === D. Stack composition ===
    teams_hit = Counter()
    team_opp_map = {}
    pitcher_opps = []
    pitcher_teams = []
    orders_by_team = defaultdict(list)
    sals_by_team = defaultdict(list)
    projs_by_team = defaultdict(list)
    for pos, name, r in matched:
        if pos == 'P':
            pitcher_opps.append(r['opp'])
            pitcher_teams.append(r['team'])
        else:
            t = r['team']
            teams_hit[t] += 1
            team_opp_map[t] = r['opp']
            try:
                o = int(r['order'])
                if 1 <= o <= 9: orders_by_team[t].append(o)
            except (ValueError, TypeError):
                pass
            sals_by_team[t].append(r['salary'])
            projs_by_team[t].append(r['proj'])

    counts = sorted(teams_hit.values(), reverse=True) if teams_hit else [0]
    while len(counts) < 5: counts.append(0)
    factors['primary_stack_size'] = counts[0]
    factors['secondary_stack_size'] = counts[1]
    factors['tertiary_stack_size'] = counts[2]
    factors['has_5_stack'] = 1.0 if counts[0] >= 5 else 0.0
    factors['has_4_stack'] = 1.0 if counts[0] >= 4 else 0.0
    factors['has_3_stack'] = 1.0 if counts[0] >= 3 else 0.0
    factors['has_4_secondary'] = 1.0 if counts[1] >= 4 else 0.0
    factors['has_3_secondary'] = 1.0 if counts[1] >= 3 else 0.0
    factors['num_teams'] = len(teams_hit)
    factors['shape_5_3'] = 1.0 if counts[0] == 5 and counts[1] == 3 else 0.0
    factors['shape_5_2'] = 1.0 if counts[0] == 5 and counts[1] == 2 else 0.0
    factors['shape_4_4'] = 1.0 if counts[0] == 4 and counts[1] == 4 else 0.0
    factors['shape_4_3'] = 1.0 if counts[0] == 4 and counts[1] == 3 else 0.0

    # Primary stack salary/proj
    primary_team = teams_hit.most_common(1)[0][0] if teams_hit else None
    if primary_team:
        pteam_sals = sals_by_team.get(primary_team, [])
        pteam_projs = projs_by_team.get(primary_team, [])
        pteam_orders = orders_by_team.get(primary_team, [])
        factors['primary_stack_sal_sum'] = sum(pteam_sals)
        factors['primary_stack_proj_sum'] = sum(pteam_projs)
        factors['primary_stack_sal_std'] = np.std(pteam_sals) if len(pteam_sals) > 1 else 0
        factors['primary_stack_order_mean'] = np.mean(pteam_orders) if pteam_orders else 5.0
        factors['primary_stack_top4_orders'] = sum(1 for o in pteam_orders if o <= 4)
        factors['primary_stack_consecutive'] = 1.0 if (len(pteam_orders) >= 2 and len(set(pteam_orders)) >= 2 and (max(pteam_orders) - min(pteam_orders)) == len(pteam_orders) - 1) else 0.0

    # === E. Bring-back / game-stack / pitcher anti ===
    bringback = 0
    if primary_team and primary_team in team_opp_map:
        opp_team = team_opp_map[primary_team]
        bringback = teams_hit.get(opp_team, 0)
    factors['bringback_count'] = bringback
    factors['has_bringback'] = 1.0 if bringback >= 1 else 0.0
    factors['has_bringback_2plus'] = 1.0 if bringback >= 2 else 0.0
    factors['game_stack_size'] = counts[0] + bringback

    pitcher_anti = 0
    for pos, name, r in matched:
        if pos == 'P': continue
        for opp in pitcher_opps:
            if r['team'] == opp:
                pitcher_anti += 1
    factors['pitcher_anti_hitters'] = pitcher_anti

    # Pitcher team in lineup?
    pitcher_in_stack = 0
    for pt in pitcher_teams:
        if pt in teams_hit:
            pitcher_in_stack += teams_hit[pt]
    factors['pitcher_team_hitters'] = pitcher_in_stack

    # === F. Field-relative (vs slate medians) ===
    if slate_stats:
        factors['proj_vs_slate_p50'] = factors['proj_mean'] - slate_stats['slate_proj_p50']
        factors['proj_vs_slate_p90'] = factors['proj_max'] - slate_stats['slate_proj_p90']
        factors['own_vs_slate_median'] = factors['own_mean'] - slate_stats['slate_own_median']
        factors['own_vs_slate_p75'] = factors['own_max'] - slate_stats['slate_own_p75']

    # === G. Top-K / Bottom-K within lineup ===
    sorted_projs = sorted(projs, reverse=True)
    sorted_owns = sorted(owns, reverse=True)
    sorted_sals = sorted(sals, reverse=True)
    factors['proj_top3_sum'] = sum(sorted_projs[:3])
    factors['proj_bot3_sum'] = sum(sorted_projs[-3:])
    factors['own_top3_sum'] = sum(sorted_owns[:3])
    factors['own_bot3_sum'] = sum(sorted_owns[-3:])
    factors['sal_top3_sum'] = sum(sorted_sals[:3])
    factors['sal_bot3_sum'] = sum(sorted_sals[-3:])
    factors['stud_to_cheap_ratio'] = factors['sal_top3_sum'] / max(1, factors['sal_bot3_sum'])
    factors['proj_top3_ratio'] = factors['proj_top3_sum'] / max(1, factors['proj_sum'])

    # Anchor exposure: is the lineup's top projection player one of the top-3 slate projection players?
    if slate_stats:
        slate_top3_proj_names = sorted(
            [(nm, r['proj']) for nm, r in player_map.items() if isinstance(r, dict) and 'proj' in r],
            key=lambda x: -x[1]
        )[:3]
        slate_top3_set = set(nm for nm, _ in slate_top3_proj_names)
        lineup_names = set(norm(n) for p, n, r in matched)
        factors['has_top3_proj_anchor'] = 1.0 if lineup_names & slate_top3_set else 0.0

    # Counts of low/high owned
    factors['n_chalk_30plus'] = sum(1 for o in owns if o >= 30)
    factors['n_chalk_20plus'] = sum(1 for o in owns if o >= 20)
    factors['n_lev_5less'] = sum(1 for o in owns if o < 5)
    factors['n_lev_10less'] = sum(1 for o in owns if o < 10)
    factors['n_lev_15less'] = sum(1 for o in owns if o < 15)

    # === H. Field-deviation features (computed externally — placeholder slots) ===
    # These get filled in second pass with field-deviation data.

    return factors

def main():
    print("Loading lineups...", file=sys.stderr)
    df = pd.read_csv(os.path.join(LIVE_AUDIT, 'all_lineups.csv'))
    print(f"Total lineups: {len(df)}", file=sys.stderr)

    slates_in_data = df['slate'].unique()
    proj_cache = {}
    stats_cache = {}
    for s in slates_in_data:
        proj = load_proj(s)
        if proj:
            proj_cache[s] = proj
            stats_cache[s] = compute_slate_stats(proj)
            print(f"  Loaded proj for {s}: {len(proj)} players", file=sys.stderr)

    df_valid = df[df['slate'].isin(proj_cache.keys())].copy()
    print(f"Valid lineups: {len(df_valid)}", file=sys.stderr)

    print("Computing v2 factors...", file=sys.stderr)
    factor_rows = []
    for cid in sorted(df_valid['contest_id'].unique()):
        sub = df_valid[df_valid['contest_id'] == cid]
        slate = sub.iloc[0]['slate']
        proj = proj_cache[slate]
        stats = stats_cache[slate]
        n_entries = len(sub)
        for _, row in sub.iterrows():
            positions = parse_lineup(row['lineup'])
            factors = compute_factors_v2(positions, proj, stats)
            if factors is None: continue
            factors['contest_id'] = cid
            factors['slate'] = slate
            factors['rank'] = row['rank']
            factors['finish_pct'] = 1.0 - (row['rank'] - 1) / n_entries
            factor_rows.append(factors)
        print(f"  {slate}/{cid}: {n_entries}", file=sys.stderr)

    fdf = pd.DataFrame(factor_rows)
    print(f"Factor frame v2: {len(fdf)} rows × {len(fdf.columns)} cols", file=sys.stderr)
    fdf.to_csv(os.path.join(LIVE_AUDIT, 'factor_frame_v2.csv'), index=False)
    print(f"Saved factor_frame_v2.csv", file=sys.stderr)

if __name__ == '__main__':
    main()
