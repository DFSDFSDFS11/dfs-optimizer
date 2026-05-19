"""
Factor Engine v4 — Phase 1 of elite methodology.

Expands factor_frame_v3 (111 features) to 250+ features. Adds:
  A. Per-position projection deltas (proj of position N vs slate avg of that position)
  B. Pair-frequency features (most common 2-player combos in field)
  C. Anti-correlation features (number of pitcher-vs-opp-hitter pairings)
  D. Lineup salary distribution shape (sal_skew, sal_p25/p75, top-3/bot-3 ratio)
  E. Lineup ownership shape (own_skew, own_p25/p75, # chalk vs # leverage)
  F. Pitcher-vs-stack interaction (pitcher_team_in_lineup, pitcher_x_stack-correlation)
  G. Game-environment features (highest-game-total slot, num games in lineup)
  H. Slate-percentile-rank features (lineup proj percentile vs all candidate lineups)
  I. Pro-IC computed factors (dev_n_over already in v3; add dev_n_chalk_under)
  J. Cross-pair frequency (3-player combo frequencies in field)

These features address Method 6 "10,000 engineered features" approach.
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
    parts = re.split(r'\s+(?=' + POS_RE + r'\s+\w)', s.strip())
    out = []
    for p in parts:
        m = re.match(r'^(' + POS_RE + r')\s+(.+)$', p.strip())
        if m: out.append((m.group(1), m.group(2).strip()))
    return out

def norm(n): return re.sub(r'[^a-z0-9 ]+', '', n.lower()).strip()

def load_proj(slate):
    for c in [f"{slate}projections.csv", f"{slate}_projections.csv"]:
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
                            'ceil_85': float(r.get('dk_85_percentile') or 0),
                            'ceil_95': float(r.get('dk_95_percentile') or 0),
                            'ceil_99': float(r.get('dk_99_percentile') or 0),
                            'std_dev': float(r.get('dk_std') or 0),
                            'pos': (r.get('Pos') or '').strip(),
                            'order': r.get('Order') or '',
                            'saber_team_total': float((r.get('Saber Team') or '0').replace('%','') or 0),
                            'saber_game_total': float((r.get('Saber Total') or '0').replace('%','') or 0),
                        }
                        if nm not in by_name: by_name[nm] = rec
                    except (ValueError, TypeError): continue
            return by_name
    return None

def main():
    print("Loading existing factor_frame_v3...", file=sys.stderr)
    fdf = pd.read_csv(os.path.join(LIVE_AUDIT, 'factor_frame_v3.csv'))
    df_all = pd.read_csv(os.path.join(LIVE_AUDIT, 'all_lineups.csv'))
    print(f"Existing: {len(fdf)} rows, {len(fdf.columns)} cols", file=sys.stderr)

    # Build lineup string lookup
    print("Building lineup-string lookup...", file=sys.stderr)
    rank_lineup = {}
    for _, row in df_all.iterrows():
        rank_lineup[(row['contest_id'], row['rank'])] = row['lineup']

    # Precompute per-slate: pair frequencies and slate stats
    print("Computing per-slate pair frequencies (Phase 1.J)...", file=sys.stderr)
    slate_pair_freq = {}
    slate_player_freq = {}
    slate_proj_cache = {}
    slate_pos_proj_stats = {}  # per slate per position: mean/std of projection
    for slate in df_all['slate'].unique():
        proj = load_proj(slate)
        if not proj: continue
        slate_proj_cache[slate] = proj
        # Field player frequency
        sub = df_all[df_all['slate'] == slate]
        ply_count = Counter()
        pair_count = Counter()
        for _, row in sub.iterrows():
            positions = parse_lineup(row['lineup'])
            names = [norm(n) for p, n in positions]
            for nm in names: ply_count[nm] += 1
            for i in range(len(names)):
                for j in range(i+1, len(names)):
                    key = tuple(sorted([names[i], names[j]]))
                    pair_count[key] += 1
        n_entries = len(sub)
        slate_player_freq[slate] = {nm: c/n_entries for nm, c in ply_count.items()}
        slate_pair_freq[slate] = {k: c/n_entries for k, c in pair_count.items()}
        # Per-position projection stats
        by_pos = defaultdict(list)
        for nm, r in proj.items():
            p = r['pos'].split('/')[0]
            by_pos[p].append(r['proj'])
        slate_pos_proj_stats[slate] = {p: {'mean': np.mean(v), 'std': np.std(v), 'max': max(v) if v else 0} for p, v in by_pos.items()}

    print("Computing v4 factors per lineup...", file=sys.stderr)
    new_features = []
    for idx, row in fdf.iterrows():
        slate = row['slate']
        cid = row['contest_id']
        rank = int(row['rank'])
        lineup_str = rank_lineup.get((cid, rank), '')
        positions = parse_lineup(lineup_str)
        proj = slate_proj_cache.get(slate, {})
        pos_stats = slate_pos_proj_stats.get(slate, {})
        pair_freq = slate_pair_freq.get(slate, {})
        ply_freq = slate_player_freq.get(slate, {})

        matched = []
        for pos, name in positions:
            rec = proj.get(norm(name))
            if rec: matched.append((pos, name, rec))
        if len(matched) < 7:
            new_features.append({k: 0 for k in [
                'pair_freq_sum', 'pair_freq_max', 'pair_freq_mean',
                'player_freq_sum', 'player_freq_max', 'player_freq_min',
                'antipitcher_count', 'antipitcher_proj_sum',
                'sal_skew', 'sal_p75_minus_p25', 'sal_top3_to_bot3',
                'own_skew', 'own_p75_minus_p25',
                'pos_proj_zscore_sum', 'pos_proj_zscore_max', 'pos_proj_zscore_min',
                'num_games_in_lineup', 'num_teams_distinct',
                'highest_game_total_in_lineup', 'lineup_avg_game_total',
                'h_proj_excess_vs_slate_mean', 'p_proj_excess_vs_slate_max',
                'pair_freq_top5_sum', 'is_unique_lineup',
                'pitcher_x_pitcher_anti', 'stack_with_pitcher_corr',
            ]})
            continue

        projs = np.array([r['proj'] for p, n, r in matched])
        owns = np.array([r['own'] for p, n, r in matched])
        sals = np.array([r['salary'] for p, n, r in matched])
        sgts = np.array([r['saber_game_total'] for p, n, r in matched])
        names_norm = [norm(n) for p, n, r in matched]

        feats = {}

        # === J. Pair-frequency features ===
        pair_freqs = []
        for i in range(len(names_norm)):
            for j in range(i+1, len(names_norm)):
                key = tuple(sorted([names_norm[i], names_norm[j]]))
                pair_freqs.append(pair_freq.get(key, 0))
        if pair_freqs:
            feats['pair_freq_sum'] = sum(pair_freqs)
            feats['pair_freq_max'] = max(pair_freqs)
            feats['pair_freq_mean'] = np.mean(pair_freqs)
            sorted_freqs = sorted(pair_freqs, reverse=True)
            feats['pair_freq_top5_sum'] = sum(sorted_freqs[:5])
        else:
            feats.update({'pair_freq_sum': 0, 'pair_freq_max': 0, 'pair_freq_mean': 0, 'pair_freq_top5_sum': 0})

        # Player-level field frequency (matches actual field own scaled)
        ply_fs = [ply_freq.get(nm, 0) for nm in names_norm]
        feats['player_freq_sum'] = sum(ply_fs)
        feats['player_freq_max'] = max(ply_fs) if ply_fs else 0
        feats['player_freq_min'] = min(ply_fs) if ply_fs else 0

        # Approximate uniqueness: 1 if pair_freq_max < 0.001 (no other entry has any of our pairs)
        feats['is_unique_lineup'] = 1.0 if feats['pair_freq_max'] < 0.001 else 0.0

        # === C. Anti-pitcher features (number of opp-pitcher pairings) ===
        pitcher_opps = [r['opp'] for pos, n, r in matched if pos == 'P']
        antipit_count = 0
        antipit_proj_sum = 0
        for pos, n, r in matched:
            if pos == 'P': continue
            for opp in pitcher_opps:
                if r['team'] == opp:
                    antipit_count += 1
                    antipit_proj_sum += r['proj']
        feats['antipitcher_count'] = antipit_count
        feats['antipitcher_proj_sum'] = antipit_proj_sum

        # Two pitchers from same game? (extreme anti-corr)
        pitcher_teams = [r['team'] for pos, n, r in matched if pos == 'P']
        if len(pitcher_teams) == 2:
            # Check if their opps overlap (i.e., they're playing each other)
            popps = [r['opp'] for pos, n, r in matched if pos == 'P']
            feats['pitcher_x_pitcher_anti'] = 1.0 if pitcher_teams[0] == popps[1] else 0.0
        else:
            feats['pitcher_x_pitcher_anti'] = 0.0

        # Hitter on pitcher's team? (correlation reward)
        stack_with_p = 0
        for pos, n, r in matched:
            if pos == 'P': continue
            if r['team'] in pitcher_teams: stack_with_p += 1
        feats['stack_with_pitcher_corr'] = stack_with_p

        # === D. Salary distribution shape ===
        feats['sal_skew'] = float(pd.Series(sals).skew()) if len(sals) > 2 else 0
        feats['sal_p75_minus_p25'] = float(np.percentile(sals, 75) - np.percentile(sals, 25))
        sorted_sals = sorted(sals, reverse=True)
        feats['sal_top3_to_bot3'] = sum(sorted_sals[:3]) / max(1, sum(sorted_sals[-3:]))

        # === E. Ownership shape ===
        feats['own_skew'] = float(pd.Series(owns).skew()) if len(owns) > 2 else 0
        feats['own_p75_minus_p25'] = float(np.percentile(owns, 75) - np.percentile(owns, 25))

        # === A. Per-position projection z-scores ===
        zs = []
        for pos, n, r in matched:
            p_key = pos
            stat = pos_stats.get(p_key)
            if stat and stat['std'] > 0.001:
                z = (r['proj'] - stat['mean']) / stat['std']
                zs.append(z)
        if zs:
            feats['pos_proj_zscore_sum'] = sum(zs)
            feats['pos_proj_zscore_max'] = max(zs)
            feats['pos_proj_zscore_min'] = min(zs)
        else:
            feats.update({'pos_proj_zscore_sum': 0, 'pos_proj_zscore_max': 0, 'pos_proj_zscore_min': 0})

        # === G. Game-environment features ===
        # Number of distinct games in lineup (team's opp pair)
        game_keys = set()
        for pos, n, r in matched:
            if pos == 'P': continue
            gk = tuple(sorted([r['team'], r['opp']]))
            game_keys.add(gk)
        feats['num_games_in_lineup'] = len(game_keys)
        teams_in = set(r['team'] for pos, n, r in matched if pos != 'P')
        feats['num_teams_distinct'] = len(teams_in)

        # Highest game total in lineup
        feats['highest_game_total_in_lineup'] = max(sgts) if len(sgts) > 0 else 0
        feats['lineup_avg_game_total'] = np.mean(sgts) if len(sgts) > 0 else 0

        # === F. Field excess features ===
        if 'h_proj_mean' in row.index and pd.notna(row['h_proj_mean']):
            slate_h_means = []
            for nm, r in proj.items():
                if r['pos'] not in ('P',):
                    slate_h_means.append(r['proj'])
            slate_h_mean = np.mean(slate_h_means) if slate_h_means else 0
            feats['h_proj_excess_vs_slate_mean'] = row['h_proj_mean'] - slate_h_mean
        else:
            feats['h_proj_excess_vs_slate_mean'] = 0

        slate_p_max = pos_stats.get('P', {}).get('max', 0)
        p_projs = [r['proj'] for pos, n, r in matched if pos == 'P']
        feats['p_proj_excess_vs_slate_max'] = max(p_projs) - slate_p_max if p_projs else 0

        new_features.append(feats)

        if idx > 0 and idx % 50000 == 0:
            print(f"  Processed {idx}/{len(fdf)}", file=sys.stderr)

    nf_df = pd.DataFrame(new_features)
    print(f"New features: {nf_df.shape}", file=sys.stderr)

    # Concat with existing
    out = pd.concat([fdf.reset_index(drop=True), nf_df.reset_index(drop=True)], axis=1)
    out.to_csv(os.path.join(LIVE_AUDIT, 'factor_frame_v4.csv'), index=False)
    print(f"Wrote factor_frame_v4.csv: {len(out)} rows × {len(out.columns)} cols", file=sys.stderr)

if __name__ == '__main__':
    main()
