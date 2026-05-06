"""
Stage 4 Development Validation for multi_bucket_research.

Computes 6 benchmarks across 16 dev slates, comparing the multi-bucket portfolio
to pro behavioral baselines. Holdout slates are NEVER touched.
"""

import csv
import json
import os
import sys
import math
import random
from collections import defaultdict, Counter

# ============================================================
# CONFIGURATION
# ============================================================
MLB_DIR = 'C:/Users/colin/dfs opto'
OUT_DIR = 'C:/Users/colin/dfs opto/multi_bucket_research'
DEV_RESULTS = os.path.join(OUT_DIR, 'development_results')
LINEUP_DUMP = 'C:/Users/colin/dfs opto/theory_dfs_v2/v1_pros_lineup_dump.json'

DEV_SLATES = [
    '4-8-26', '4-12-26', '4-17-26', '4-18-26',
    '4-21-26', '4-22-26', '4-23-26', '4-24-26',
    '4-25-26', '4-25-26-early', '4-26-26', '4-27-26',
    '4-28-26', '4-29-26', '5-2-26-main', '5-3-26',
]
HOLDOUT_SLATES = {'4-6-26', '4-14-26', '4-15-26', '4-19-26', '4-20-26', '5-1-26', '5-2-26', '5-2-26-night'}

# Per-slate filename patterns (mirror multi-bucket-portfolio-v1.ts)
SLATE_FILES = {
    '4-8-26':         {'proj': '4-8-26projections.csv',         'actuals': '4-8-26actuals.csv'},
    '4-12-26':        {'proj': '4-12-26projections.csv',        'actuals': '4-12-26actuals.csv'},
    '4-17-26':        {'proj': '4-17-26projections.csv',        'actuals': '4-17-26actuals.csv'},
    '4-18-26':        {'proj': '4-18-26projections.csv',        'actuals': '4-18-26actuals.csv'},
    '4-21-26':        {'proj': '4-21-26projections.csv',        'actuals': '4-21-26actuals.csv'},
    '4-22-26':        {'proj': '4-22-26projections.csv',        'actuals': '4-22-26actuals.csv'},
    '4-23-26':        {'proj': '4-23-26projections.csv',        'actuals': '4-23-26actuals.csv'},
    '4-24-26':        {'proj': '4-24-26projections.csv',        'actuals': '4-24-26actuals.csv'},
    '4-25-26':        {'proj': '4-25-26projections.csv',        'actuals': '4-25-26actuals.csv'},
    '4-25-26-early':  {'proj': '4-25-26projectionsearly.csv',   'actuals': '4-25-26actualsearly.csv'},
    '4-26-26':        {'proj': '4-26-26projections.csv',        'actuals': '4-26-26actuals.csv'},
    '4-27-26':        {'proj': '4-27-26projections.csv',        'actuals': '4-27-26actuals.csv'},
    '4-28-26':        {'proj': '4-28-26projections.csv',        'actuals': '4-28-26actuals.csv'},
    '4-29-26':        {'proj': '4-29-26projections.csv',        'actuals': '4-29-26actuals.csv'},
    '5-2-26-main':    {'proj': '5-2-26projectionsmain.csv',     'actuals': '5-2-26actualsmain.csv'},
    '5-3-26':         {'proj': '5-3-26projections.csv',         'actuals': '5-3-26actuals.csv'},
}

# Pro behavioral reference (from prompt)
PRO_BANDS = (38.7, 13.0, 15.2, 33.1)  # HP/HO, HP/LO, LP/HO, LP/LO

# ============================================================
# HOLDOUT SAFETY CHECK
# ============================================================
for s in DEV_SLATES:
    if s in HOLDOUT_SLATES:
        print(f"FATAL: dev slate {s} also in holdout — abort", file=sys.stderr)
        sys.exit(1)


# ============================================================
# UTILITIES
# ============================================================
def normalize_name(name):
    """Match multi-bucket-portfolio-v1.ts norm()."""
    n = (name or '').lower()
    out = []
    for ch in n:
        if ch.isalnum() or ch == ' ':
            out.append(ch)
        else:
            out.append(' ')
    return ' '.join(''.join(out).split())


def jaccard(a, b):
    inter = len(a & b)
    union = len(a) + len(b) - inter
    return inter / union if union > 0 else 0


def percentile(arr, p):
    if not arr:
        return 0.0
    s = sorted(arr)
    k = (len(s) - 1) * p
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return s[int(k)]
    return s[f] + (s[c] - s[f]) * (k - f)


def mean(arr):
    return sum(arr) / len(arr) if arr else 0.0


def stddev(arr):
    if len(arr) < 2:
        return 0.0
    m = mean(arr)
    return math.sqrt(sum((x - m) ** 2 for x in arr) / len(arr))


def bootstrap_ratio_ci(values_top, values_mid, values_bot, n_resamples=10000, ci=0.95):
    """Bootstrap CI for (mean(top) + mean(bot)) / 2 / mean(mid). values are per-slate per-quintile means."""
    rng = random.Random(42)
    n = len(values_top)
    ratios = []
    for _ in range(n_resamples):
        idx = [rng.randrange(n) for _ in range(n)]
        t = mean([values_top[i] for i in idx])
        m_ = mean([values_mid[i] for i in idx])
        b = mean([values_bot[i] for i in idx])
        if m_ <= 0:
            continue
        ratios.append((t + b) / 2 / m_)
    ratios.sort()
    lo = ratios[int((1 - ci) / 2 * len(ratios))]
    hi = ratios[int((1 + ci) / 2 * len(ratios))]
    return lo, hi


# ============================================================
# DATA LOADING
# ============================================================
def load_projections(slate):
    """Load player projections to derive ownership and projection.

    Returns dict: pid -> {name_norm, name, team, opponent, projection, ownership, ceiling, floor, actual}
    SaberSim CSV header: DFS ID,Name,Pos,Order,Team,Opp,Status,Salary,Actual,SS Proj,Live Proj,My Proj,Value,My Own,Adj Own,...
    """
    fp = os.path.join(MLB_DIR, SLATE_FILES[slate]['proj'])
    rows = {}
    with open(fp, 'r', encoding='utf-8-sig') as fh:
        reader = csv.DictReader(fh)
        for r in reader:
            pid = r.get('DFS ID') or r.get('PlayerId') or r.get('Player ID') or r.get('Id') or ''
            name = r.get('Name') or r.get('Player') or ''
            team = (r.get('Team') or '').upper()
            opp = (r.get('Opp') or r.get('Opponent') or '').upper()
            try:
                proj = float(r.get('SS Proj') or r.get('Projection') or r.get('Proj') or 0)
            except (ValueError, TypeError):
                proj = 0
            # Ownership: prefer 'My Own' (SS reported)
            try:
                own = float((r.get('My Own') or r.get('Ownership') or r.get('Own') or '0'))
            except (ValueError, TypeError):
                own = 0
            try:
                ceil = float(r.get('dk_85_percentile') or 0)
            except (ValueError, TypeError):
                ceil = proj * 1.15
            try:
                floor = float(r.get('dk_25_percentile') or 0)
            except (ValueError, TypeError):
                floor = proj * 0.85
            try:
                actual = float(r.get('Actual') or 0)
                has_actual = (r.get('Actual') or '').strip() not in ('', '-', 'N/A')
            except (ValueError, TypeError):
                actual = 0
                has_actual = False
            if not pid:
                continue
            rows[pid] = {
                'name': name,
                'name_norm': normalize_name(name),
                'team': team,
                'opp': opp,
                'projection': proj,
                'ownership': own,
                'ceiling': ceil,
                'floor': floor,
                'actual': actual,
                'has_actual': has_actual,
            }
    return rows


def load_actuals(slate, players_by_name_norm):
    """Load actuals: returns (sorted_actuals_desc, total_entries, player_actual_by_name_norm).

    Maps each player's actuals score from %Drafted+FPTS columns.
    """
    fp = os.path.join(MLB_DIR, SLATE_FILES[slate]['actuals'])
    actuals_lineups = []  # entry actual scores (from main row)
    player_actuals = {}  # name_norm -> fpts
    with open(fp, 'r', encoding='utf-8-sig') as fh:
        reader = csv.reader(fh)
        header = next(reader)
        # find indexes
        try:
            idx_pts = header.index('Points')
        except ValueError:
            idx_pts = 4
        try:
            idx_player = header.index('Player')
        except ValueError:
            idx_player = 7
        try:
            idx_fpts = header.index('FPTS')
        except ValueError:
            idx_fpts = 10
        for row in reader:
            if not row:
                continue
            # Lineup row
            if len(row) > idx_pts and row[idx_pts]:
                try:
                    pts = float(row[idx_pts])
                    actuals_lineups.append(pts)
                except ValueError:
                    pass
            # Player actuals row
            if len(row) > idx_fpts:
                pname = row[idx_player] if idx_player < len(row) else ''
                fpts_str = row[idx_fpts] if idx_fpts < len(row) else ''
                if pname and fpts_str:
                    try:
                        fpts = float(fpts_str)
                        player_actuals[normalize_name(pname)] = fpts
                    except ValueError:
                        pass
    actuals_lineups.sort(reverse=True)
    return actuals_lineups, len(actuals_lineups), player_actuals


def load_portfolio_dk(slate):
    """Load 75-lineup portfolio from <slate>_dk.csv. Returns list of lineups, each a list of (name, pid)."""
    fp = os.path.join(DEV_RESULTS, f'{slate}_dk.csv')
    lineups = []
    with open(fp, 'r', encoding='utf-8') as fh:
        reader = csv.reader(fh)
        next(reader)  # header
        for row in reader:
            lineup = []
            for cell in row:
                # Format: "Name (PID)"
                if '(' in cell and cell.endswith(')'):
                    nm = cell.rsplit(' (', 1)[0]
                    pid = cell.rsplit(' (', 1)[1].rstrip(')')
                    lineup.append({'name': nm, 'name_norm': normalize_name(nm), 'pid': pid})
                else:
                    lineup.append({'name': cell, 'name_norm': normalize_name(cell), 'pid': ''})
            if len(lineup) == 10:
                lineups.append(lineup)
    return lineups


def load_portfolio_detail(slate):
    """Load _detail.csv to get bucket tags and stack-mix info."""
    fp = os.path.join(DEV_RESULTS, f'{slate}_detail.csv')
    rows = []
    with open(fp, 'r', encoding='utf-8') as fh:
        reader = csv.DictReader(fh)
        for r in reader:
            rows.append(r)
    return rows


# ============================================================
# COMPUTE LINEUP-LEVEL STATS FROM DK FORMAT
# ============================================================
def lineup_features(lineup, players, actuals_map):
    """Compute lineup features from raw player data + actuals.

    Returns dict with: projection, ownership_avg, geoMeanOwnHit, primarySize, secondarySize,
    bringBack, numGames, numTeamsUsed, maxGameStack, salary*, actual.

    actuals_map is name_norm -> fpts (from actuals.csv).
    Falls back to projections csv 'Actual' field if pid present.
    """
    pitchers = []
    hitters = []
    proj_sum = 0
    own_sum = 0
    actual = 0
    miss = False
    for p in lineup:
        info = players.get(p['pid'])
        if not info:
            miss = True
            continue
        proj_sum += info['projection']
        own_sum += info['ownership']
        # Try actuals.csv first (player_actuals dict), fallback to projections 'Actual' field
        ap = actuals_map.get(p['name_norm'])
        if ap is None and info.get('has_actual'):
            ap = info['actual']
        if ap is None:
            miss = True
        else:
            actual += ap
    # First 2 columns of DK are P
    pitchers = lineup[:2]
    hitters = lineup[2:]
    # team counts (hitters only for stack)
    team_counts = Counter()
    for h in hitters:
        info = players.get(h['pid'])
        if info and info['team']:
            team_counts[info['team']] += 1
    primary_team, primary_size = team_counts.most_common(1)[0] if team_counts else ('', 0)
    secondary_size = team_counts.most_common(2)[1][1] if len(team_counts) >= 2 else 0
    # bring-back
    primary_opp = ''
    for h in hitters:
        info = players.get(h['pid'])
        if info and info['team'] == primary_team:
            primary_opp = info['opp']
            if primary_opp:
                break
    bring_back = team_counts.get(primary_opp, 0) if primary_opp else 0
    # game stack: count of any 2 teams in same game
    games = defaultdict(int)
    for p in lineup:
        info = players.get(p['pid'])
        if info and info['team']:
            t = info['team']
            o = info['opp']
            if t and o:
                key = '@'.join(sorted([t, o]))
                games[key] += 1
    max_game_stack = max(games.values()) if games else 0
    num_games = len(games)
    teams_used = set()
    for p in lineup:
        info = players.get(p['pid'])
        if info and info['team']:
            teams_used.add(info['team'])
    # geoMeanOwnHit
    hitter_owns = []
    for h in hitters:
        info = players.get(h['pid'])
        if info:
            hitter_owns.append(max(0.1, info['ownership']))
    if hitter_owns:
        log_sum = sum(math.log(o) for o in hitter_owns)
        geomean_own = math.exp(log_sum / len(hitter_owns))
    else:
        geomean_own = 0
    # Salaries
    sal_list = []
    for p in lineup:
        info = players.get(p['pid'])
        if info:
            sal_list.append(0)  # we don't have salary in projections csv... use SS pool would
    # We don't track salary here; not needed for B5 except salaryStd/salaryTopThree (skip if missing)
    own_avg = own_sum / max(1, len(lineup))
    return {
        'projection': proj_sum,
        'ownAvg': own_avg,
        'geoMeanOwnHit': geomean_own,
        'primarySize': primary_size,
        'secondarySize': secondary_size,
        'bringBack': bring_back,
        'numGames': num_games,
        'numTeamsUsed': len(teams_used),
        'maxGameStack': max_game_stack,
        'actual': actual if not miss else None,
        'pid_set': set(p['pid'] for p in lineup if p['pid']),
    }


# ============================================================
# MAIN ANALYSIS
# ============================================================
def main():
    # Holdout integrity check
    print(f"DEV slates: {len(DEV_SLATES)}; holdout sealed: {len(HOLDOUT_SLATES)}")
    # Load lineup dump and pro features (DEV ONLY)
    with open(LINEUP_DUMP, 'r', encoding='utf-8') as fh:
        dump = json.load(fh)
    pros_by_slate = {}
    for entry in dump:
        if entry['slate'] in HOLDOUT_SLATES:
            continue  # CRITICAL: skip holdout
        if entry['slate'] in DEV_SLATES:
            pros_by_slate[entry['slate']] = entry.get('pros', [])
    print(f"Loaded pros for {len(pros_by_slate)} dev slates")

    # =========================================================
    # B4 + B5 baseline: pro feature distribution (z-scoring per dev pool)
    # =========================================================
    # Aggregate pro features across all dev pros
    PRO_FEATURES = ['primarySize', 'secondarySize', 'bringBack', 'numGames', 'numTeamsUsed',
                    'maxGameStack', 'salaryStd', 'salaryTopThree', 'geoMeanOwnHit', 'ownAvg']
    pro_feat_arrays = {f: [] for f in PRO_FEATURES}
    for slate, pros in pros_by_slate.items():
        for p in pros:
            for f in PRO_FEATURES:
                if f in p:
                    pro_feat_arrays[f].append(p[f])
    pro_feat_stats = {f: {'mean': mean(pro_feat_arrays[f]), 'std': max(1e-6, stddev(pro_feat_arrays[f]))} for f in PRO_FEATURES}
    print('Pro feature stats (dev only):')
    for f, s in pro_feat_stats.items():
        print(f'  {f}: mean={s["mean"]:.3f} std={s["std"]:.3f}  n={len(pro_feat_arrays[f])}')

    # =========================================================
    # PER-SLATE PROCESSING
    # =========================================================
    per_slate = {}
    all_portfolio_lineups = []  # for aggregate B4/B5/B6
    quintile_means = {'top': [], 'mid': [], 'bot': []}
    b2_total_observed = 0
    b2_total_expected = 0
    b3_total_observed = 0
    b3_total_expected = 0
    b6_per_slate_mean = []
    b6_per_slate_max = []
    b4_aggregate = Counter()
    b4_total = 0

    for slate in DEV_SLATES:
        print(f"\n=== {slate} ===")
        try:
            players = load_projections(slate)
            actuals_lineups, total_entries, player_actuals = load_actuals(slate, {p['name_norm']: pid for pid, p in players.items()})
            portfolio_dk = load_portfolio_dk(slate)
            detail = load_portfolio_detail(slate)
        except FileNotFoundError as e:
            print(f"  SKIP: {e}")
            continue

        if not actuals_lineups:
            print(f"  SKIP: no actuals")
            continue

        F = total_entries
        # Sort actuals descending for rank lookup
        sorted_actuals = actuals_lineups  # already sorted desc

        # Compute thresholds for top-1% and top-0.1%
        top1_idx = max(0, int(F * 0.01) - 1)
        top01_idx = max(0, int(F * 0.001) - 1)
        top1_thr = sorted_actuals[top1_idx] if sorted_actuals else 0
        top01_thr = sorted_actuals[top01_idx] if sorted_actuals else 0

        # Build lineup features
        port_features = []
        for lineup in portfolio_dk:
            feat = lineup_features(lineup, players, player_actuals)
            port_features.append(feat)

        # Filter portfolio by valid actual
        scored_lineups = [f for f in port_features if f['actual'] is not None]
        print(f"  portfolio: {len(portfolio_dk)} lineups, {len(scored_lineups)} with valid actuals (F={F})")

        # B2/B3: top-1% / top-0.1% counts
        top1_count = sum(1 for f in scored_lineups if f['actual'] >= top1_thr)
        top01_count = sum(1 for f in scored_lineups if f['actual'] >= top01_thr)
        b2_total_observed += top1_count
        b3_total_observed += top01_count
        b2_total_expected += 0.01 * len(scored_lineups)
        b3_total_expected += 0.001 * len(scored_lineups)

        # Compute finishPct per lineup (1 - rank/(F-1))
        finishPcts = []
        for f in scored_lineups:
            actual = f['actual']
            # rank = number of entries with actual >= this
            lo, hi = 0, len(sorted_actuals)
            while lo < hi:
                mid = (lo + hi) // 2
                if sorted_actuals[mid] >= actual:
                    lo = mid + 1
                else:
                    hi = mid
            rank = max(1, lo)
            f['rank'] = rank
            f['finishPct'] = 1 - (rank - 1) / max(1, F - 1)
            finishPcts.append(f['finishPct'])

        # B1: quintile means by finishPct
        if scored_lineups:
            # Sort by finishPct ascending and bin into 5 quintiles
            sorted_lus = sorted(scored_lineups, key=lambda x: x['finishPct'])
            n_lus = len(sorted_lus)
            # quintile boundaries: 0..0.2, 0.2..0.4, ..., 0.8..1.0
            q_means = [0.0] * 5
            q_counts = [0] * 5
            for i, lu in enumerate(sorted_lus):
                qi = min(4, i * 5 // n_lus)
                q_means[qi] += lu['finishPct']
                q_counts[qi] += 1
            for qi in range(5):
                q_means[qi] = q_means[qi] / q_counts[qi] if q_counts[qi] > 0 else 0
            quintile_means['bot'].append(q_means[0])
            quintile_means['mid'].append(q_means[2])  # middle quintile
            quintile_means['top'].append(q_means[4])

        # B4: band assignment (slate-relative)
        # HP/LP = top half by lineup projection within the portfolio (or compare against a slate proj median)
        # Per spec: HP = top half by lineup projection within portfolio; HO = top half by lineup geoMeanOwnHit within portfolio
        if port_features:
            projs = sorted([f['projection'] for f in port_features])
            owns = sorted([f['geoMeanOwnHit'] for f in port_features])
            proj_med = percentile(projs, 0.5)
            own_med = percentile(owns, 0.5)
            for f in port_features:
                hp = f['projection'] >= proj_med
                ho = f['geoMeanOwnHit'] >= own_med
                key = ('HP' if hp else 'LP') + '/' + ('HO' if ho else 'LO')
                b4_aggregate[key] += 1
                b4_total += 1

        # B5: lineup-level fingerprint
        # Compare portfolio lineups (z-scored against pro feature stats) to nearest pro lineup on same slate
        pros_this_slate = pros_by_slate.get(slate, [])
        # We don't have salaryStd/salaryTopThree easily — skip those features (use ownership/stack/etc.)
        b5_features = ['primarySize', 'secondarySize', 'bringBack', 'numGames', 'numTeamsUsed',
                       'maxGameStack', 'geoMeanOwnHit', 'ownAvg']
        b5_distances = []
        if pros_this_slate:
            pro_z_vectors = []
            for pro in pros_this_slate:
                vec = []
                for f in b5_features:
                    v = pro.get(f)
                    if v is None:
                        vec.append(0.0)
                    else:
                        vec.append((v - pro_feat_stats[f]['mean']) / pro_feat_stats[f]['std'])
                pro_z_vectors.append(vec)
            for f in port_features:
                vec = []
                for fkey in b5_features:
                    v = f.get(fkey, 0.0)
                    vec.append((v - pro_feat_stats[fkey]['mean']) / pro_feat_stats[fkey]['std'])
                # Manhattan distance to nearest pro
                best = float('inf')
                for pv in pro_z_vectors:
                    d = sum(abs(vec[i] - pv[i]) for i in range(len(vec)))
                    if d < best:
                        best = d
                b5_distances.append(best)

        # B6: Jaccard stats per slate
        sets = [f['pid_set'] for f in port_features if f['pid_set']]
        all_jacs = []
        max_j = 0
        for i in range(len(sets)):
            for j in range(i + 1, len(sets)):
                jc = jaccard(sets[i], sets[j])
                all_jacs.append(jc)
                if jc > max_j:
                    max_j = jc
        slate_mean_j = mean(all_jacs)
        b6_per_slate_mean.append(slate_mean_j)
        b6_per_slate_max.append(max_j)

        per_slate[slate] = {
            'F': F,
            'portfolio_size': len(portfolio_dk),
            'scored_size': len(scored_lineups),
            'top1_count': top1_count,
            'top01_count': top01_count,
            'top1_thr': top1_thr,
            'top01_thr': top01_thr,
            'b5_distances_n': len(b5_distances),
            'b5_distances_median': percentile(b5_distances, 0.5) if b5_distances else None,
            'b5_distances_p90': percentile(b5_distances, 0.9) if b5_distances else None,
            'mean_pairwise_jaccard': slate_mean_j,
            'max_pairwise_jaccard': max_j,
            'avg_proj': mean([f['projection'] for f in port_features]),
            'avg_own_geomean': mean([f['geoMeanOwnHit'] for f in port_features]),
            'avg_finishPct': mean(finishPcts) if finishPcts else None,
        }
        all_portfolio_lineups.extend(port_features)

        # Record per-lineup b5 distances for aggregate
        per_slate[slate]['b5_distances'] = b5_distances

        print(f"  top1 {top1_count} (thr {top1_thr:.2f}), top01 {top01_count} (thr {top01_thr:.2f})")
        print(f"  meanJ={slate_mean_j:.3f} maxJ={max_j:.3f}")
        if b5_distances:
            print(f"  B5 median={percentile(b5_distances, 0.5):.3f} p90={percentile(b5_distances, 0.9):.3f}")

    # =========================================================
    # AGGREGATE BENCHMARKS
    # =========================================================
    print("\n\n========== AGGREGATE BENCHMARKS ==========\n")

    # B1: inverse-bell ratio
    if quintile_means['top']:
        agg_top = mean(quintile_means['top'])
        agg_mid = mean(quintile_means['mid'])
        agg_bot = mean(quintile_means['bot'])
        b1_ratio = (agg_top + agg_bot) / 2 / agg_mid if agg_mid > 0 else 0
        b1_lo, b1_hi = bootstrap_ratio_ci(quintile_means['top'], quintile_means['mid'], quintile_means['bot'])
        b1_pass = (b1_ratio > 1.4) and (b1_lo > 1.0)
    else:
        b1_ratio = 0; b1_lo = 0; b1_hi = 0; b1_pass = False
        agg_top = agg_mid = agg_bot = 0
    print(f"B1 inverse-bell: top={agg_top:.4f} mid={agg_mid:.4f} bot={agg_bot:.4f} ratio={b1_ratio:.3f} CI[{b1_lo:.3f},{b1_hi:.3f}]")
    print(f"  PASS={b1_pass} (need ratio>1.4 AND CI lo>1.0)")

    # B2: top-1% (binomial CI)
    n_lus = sum(per_slate[s]['scored_size'] for s in per_slate)
    obs2 = b2_total_observed
    exp2 = b2_total_expected
    rate2 = obs2 / n_lus if n_lus > 0 else 0
    p0 = exp2 / n_lus if n_lus > 0 else 0.01
    # Binomial 95% CI (Wald or Wilson)
    se2 = math.sqrt(rate2 * (1 - rate2) / n_lus) if n_lus > 0 else 0
    b2_lo_rate = max(0, rate2 - 1.96 * se2)
    b2_lo_count = b2_lo_rate * n_lus
    b2_obs_over_exp = obs2 / exp2 if exp2 > 0 else 0
    b2_lo_over_exp = b2_lo_count / exp2 if exp2 > 0 else 0
    b2_pass = (b2_obs_over_exp >= 1.0) and (b2_lo_over_exp >= 0.85)
    print(f"\nB2 top-1%: observed={obs2} expected={exp2:.1f} obs/exp={b2_obs_over_exp:.3f}")
    print(f"  CI lo (95%): {b2_lo_count:.1f} -> {b2_lo_over_exp:.3f}× expected")
    print(f"  PASS={b2_pass} (need obs/exp>=1.0 AND CI lo>=0.85)")

    # B3: top-0.1% (binomial CI)
    obs3 = b3_total_observed
    exp3 = b3_total_expected
    rate3 = obs3 / n_lus if n_lus > 0 else 0
    se3 = math.sqrt(rate3 * (1 - rate3) / n_lus) if n_lus > 0 else 0
    b3_lo_rate = max(0, rate3 - 1.96 * se3)
    b3_lo_count = b3_lo_rate * n_lus
    b3_obs_over_exp = obs3 / exp3 if exp3 > 0 else 0
    b3_lo_over_exp = b3_lo_count / exp3 if exp3 > 0 else 0
    b3_pass = (b3_obs_over_exp >= 1.0) and (b3_lo_over_exp >= 0.7)
    print(f"\nB3 top-0.1%: observed={obs3} expected={exp3:.2f} obs/exp={b3_obs_over_exp:.3f}")
    print(f"  CI lo (95%): {b3_lo_count:.2f} -> {b3_lo_over_exp:.3f}× expected")
    print(f"  PASS={b3_pass} (need obs/exp>=1.0 AND CI lo>=0.7)")

    # B4: band distribution
    band_pcts = {}
    for k in ['HP/HO', 'HP/LO', 'LP/HO', 'LP/LO']:
        band_pcts[k] = b4_aggregate.get(k, 0) / b4_total * 100 if b4_total > 0 else 0
    pro_keys = ['HP/HO', 'HP/LO', 'LP/HO', 'LP/LO']
    pro_vals = [38.7, 13.0, 15.2, 33.1]
    diffs = [abs(band_pcts[k] - pv) for k, pv in zip(pro_keys, pro_vals)]
    b4_within_10pp = all(d <= 10 for d in diffs)
    b4_no_band_over_50 = all(band_pcts[k] <= 50 for k in pro_keys)
    b4_pass = b4_within_10pp and b4_no_band_over_50
    print(f"\nB4 band distribution (vs pro 38.7/13.0/15.2/33.1):")
    for k, pv in zip(pro_keys, pro_vals):
        print(f"  {k}: {band_pcts[k]:.1f}% (pro {pv:.1f}, diff {band_pcts[k]-pv:+.1f}pp)")
    print(f"  PASS={b4_pass} (within 10pp AND no band >50%)")

    # B5: lineup-level fingerprint
    all_b5 = []
    for s in per_slate:
        all_b5.extend(per_slate[s].get('b5_distances', []))
    b5_median = percentile(all_b5, 0.5) if all_b5 else None
    b5_p90 = percentile(all_b5, 0.9) if all_b5 else None
    b5_pass = (b5_median is not None) and (b5_median < 1.3) and (b5_p90 < 3.5)
    print(f"\nB5 lineup-level fingerprint: median={b5_median:.3f} p90={b5_p90:.3f}" if b5_median is not None else "\nB5 lineup-level fingerprint: NO DATA")
    print(f"  PASS={b5_pass} (need median<1.3 AND p90<3.5)")

    # B6: portfolio decorrelation
    b6_mean = mean(b6_per_slate_mean) if b6_per_slate_mean else 0
    b6_max = mean(b6_per_slate_max) if b6_per_slate_max else 0
    b6_pass = (b6_mean < 0.5) and (b6_max < 0.7)
    print(f"\nB6 portfolio decorrelation: mean(mean_pairwise_jac)={b6_mean:.3f} mean(max_pairwise_jac)={b6_max:.3f}")
    print(f"  PASS={b6_pass} (need mean<0.5 AND max<0.7)")

    # SUMMARY
    results = {
        'B1': {'name': 'inverse-bell', 'pass': b1_pass, 'value': b1_ratio, 'ci_lo': b1_lo, 'ci_hi': b1_hi, 'top': agg_top, 'mid': agg_mid, 'bot': agg_bot},
        'B2': {'name': 'top-1%', 'pass': b2_pass, 'observed': obs2, 'expected': exp2, 'obs_over_exp': b2_obs_over_exp, 'ci_lo_count': b2_lo_count, 'ci_lo_over_exp': b2_lo_over_exp},
        'B3': {'name': 'top-0.1%', 'pass': b3_pass, 'observed': obs3, 'expected': exp3, 'obs_over_exp': b3_obs_over_exp, 'ci_lo_count': b3_lo_count, 'ci_lo_over_exp': b3_lo_over_exp},
        'B4': {'name': 'band-dist', 'pass': b4_pass, 'bands': band_pcts, 'diffs': dict(zip(pro_keys, diffs))},
        'B5': {'name': 'fingerprint', 'pass': b5_pass, 'median': b5_median, 'p90': b5_p90},
        'B6': {'name': 'decorrelation', 'pass': b6_pass, 'mean_pairwise': b6_mean, 'max_pairwise': b6_max},
    }
    n_pass = sum(1 for r in results.values() if r['pass'])
    print(f"\n========== SUMMARY: {n_pass} of 6 benchmarks PASSED ==========")
    for k, r in results.items():
        print(f"  {k} ({r['name']}): {'PASS' if r['pass'] else 'FAIL'}")

    # Save JSON results
    out = {
        'generated_at': '2026-05-03',
        'dev_slates': DEV_SLATES,
        'per_slate': {s: {k: v for k, v in d.items() if k != 'b5_distances'} for s, d in per_slate.items()},
        'aggregate': results,
        'n_passed': n_pass,
        'tier': 'strong' if n_pass >= 5 else ('moderate' if n_pass == 4 else 'fail'),
    }
    with open(os.path.join(OUT_DIR, 'validation_results.json'), 'w', encoding='utf-8') as fh:
        json.dump(out, fh, indent=2, default=str)
    print(f"\nValidation results written to {OUT_DIR}/validation_results.json")


if __name__ == '__main__':
    main()
