"""
I2: Pro lineup clusters.

K-means on pro lineup features. Are pros in 2-3 clusters or spread out?
For each V1 (and Hermes-A, random) lineup, assign to nearest cluster centroid.
Measure cluster occupancy gap: where do systems over- or under-represent vs pros?

Features (slate-relative percentile or normalized):
  - proj_pct  (lineup projection rank within pool)
  - own_pct   (lineup ownership rank within pool)
  - range_pct (ceiling-floor rank within pool)
  - primary_stack (size of largest hitter stack, integer 0-7, normalized to 0-1)
  - bring_back  (count of opposing-team hitters from primary, 0-5, normalized to 0-1)
  - salary_pct (lineup total salary rank within pool)

Method:
  - Aggregate all pro lineups across all slates into one feature matrix.
  - K-means (k=3 default; also try k=2 and k=4 for robustness).
  - Report cluster centroids, sizes, defining feature.
  - For each system, assign each lineup to nearest centroid.
  - Compare cluster occupancy: what fraction of pros vs V1 in each cluster?
"""
import json
import csv
import os
import re
import sys
import random
import statistics
from collections import defaultdict, Counter

sys.stdout.reconfigure(encoding='utf-8')

OUT = r'C:\Users\colin\dfs opto\lineup_level'
DATA = r'C:\Users\colin\dfs opto'
PROS = {'zroth', 'nerdytenor', 'shipmymoney', 'shaidyadvice', 'needlunchmoney', 'bgreseth', 'youdacao'}

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
]

POSITIONS = {'P', 'C', '1B', '2B', '3B', 'SS', 'OF'}

def norm(s):
    return re.sub(r'\s+', ' ', re.sub(r'[^a-z0-9 ]+', ' ', (s or '').lower())).strip()

def extract_username(entry_name):
    return re.sub(r'\s*\([^)]*\)\s*$', '', entry_name or '').strip().lower()

def load_projections(path):
    out = {}
    with open(path, encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        for row in reader:
            name = row.get('Name', '')
            try:
                proj = float(row.get('My Proj') or row.get('Proj') or 0) or 0
                own = float(row.get('Adj Own') or row.get('My Own') or 0) or 0
                salary = float(row.get('Salary') or 0) or 0
                ceiling = float(row.get('dk_85_percentile') or 0) or proj * 1.3
                floor = float(row.get('dk_25_percentile') or 0) or proj * 0.85
            except (ValueError, TypeError):
                continue
            team = (row.get('Team') or '').upper()
            opp = (row.get('Opp') or '').upper()
            pos = (row.get('Pos') or '').upper()
            n = norm(name)
            if n:
                out[n] = {'proj': proj, 'own': own, 'salary': salary, 'team': team,
                          'opp': opp, 'position': pos, 'ceiling': ceiling, 'floor': floor,
                          'name': name, 'id': row.get('DFS ID', '')}
    return out

def parse_lineup_string(lineup_str):
    tokens = (lineup_str or '').split()
    players = []
    current = []
    started = False
    for t in tokens:
        if t.upper() in POSITIONS:
            if started and current:
                players.append(' '.join(current))
            current = []
            started = True
        elif started:
            current.append(t)
    if current:
        players.append(' '.join(current))
    return players

def lineup_features(players):
    """Compute (proj, own, range, primary_stack, bring_back, salary) for a list of player dicts."""
    proj = sum(p['proj'] for p in players)
    own = statistics.mean(p['own'] for p in players)
    salary = sum(p['salary'] for p in players)
    ceiling = sum(p.get('ceiling', p['proj'] * 1.3) for p in players)
    floor = sum(p.get('floor', p['proj'] * 0.85) for p in players)
    range_ = ceiling - floor
    # Primary stack and bring-back.
    team_counts = defaultdict(int)
    for p in players:
        if 'P' in p.get('position', ''):
            continue
        if p.get('team'):
            team_counts[p['team']] += 1
    primary_stack = max(team_counts.values()) if team_counts else 0
    primary_team = max(team_counts, key=team_counts.get) if team_counts else None
    primary_opp = None
    if primary_team:
        for p in players:
            if p.get('team') == primary_team and 'P' not in p.get('position', ''):
                primary_opp = p.get('opp')
                if primary_opp:
                    break
    bring_back = team_counts.get(primary_opp, 0) if primary_opp else 0
    return {'proj': proj, 'own': own, 'salary': salary, 'range': range_,
            'primary_stack': primary_stack, 'bring_back': bring_back}

def percentile_rank(value, sorted_values):
    if not sorted_values:
        return 0.5
    lo, hi = 0, len(sorted_values)
    while lo < hi:
        mid = (lo + hi) // 2
        if sorted_values[mid] < value:
            lo = mid + 1
        else:
            hi = mid
    return lo / max(1, len(sorted_values) - 1)

def load_pool_lineups(pool_path, projections):
    """Returns list of (proj, own, salary) — used for percentile rank reference."""
    pool_features = []
    with open(pool_path, encoding='utf-8-sig') as f:
        reader = csv.reader(f)
        try:
            header = next(reader)
        except StopIteration:
            return []
        proj_idx = next((i for i, h in enumerate(header) if h.strip().lower() == 'proj score'), -1)
        own_idx = next((i for i, h in enumerate(header) if h.strip().lower() == 'ownership'), -1)
        salary_idx = next((i for i, h in enumerate(header) if h.strip().lower() == 'salary'), -1)
        # ceiling = 85th column
        ceil_idx = next((i for i, h in enumerate(header) if h.strip().lower() in ('85th', 'dk_85_percentile', '85')), -1)
        floor_idx = next((i for i, h in enumerate(header) if h.strip().lower() in ('25th', 'dk_25_percentile', '25')), -1)
        if proj_idx < 0:
            return []
        for row in reader:
            try:
                proj = float(row[proj_idx]) if proj_idx >= 0 else 0
                own = float(row[own_idx]) if own_idx >= 0 else 0
                salary = float(row[salary_idx]) if salary_idx >= 0 else 0
                ceiling = float(row[ceil_idx]) if ceil_idx >= 0 and row[ceil_idx] else proj * 1.3
                floor_v = float(row[floor_idx]) if floor_idx >= 0 and row[floor_idx] else proj * 0.85
                pool_features.append({'proj': proj, 'own': own, 'salary': salary,
                                      'ceiling': ceiling, 'floor': floor_v, 'range': ceiling - floor_v})
            except (ValueError, IndexError):
                continue
    return pool_features

def feature_vector(features, sorted_pool):
    """Convert raw features to a 6-d normalized vector using slate-pool reference distributions."""
    proj_pct = percentile_rank(features['proj'], sorted_pool['proj'])
    own_pct = percentile_rank(features['own'], sorted_pool['own'])
    range_pct = percentile_rank(features['range'], sorted_pool['range']) if sorted_pool.get('range') else 0.5
    salary_pct = percentile_rank(features['salary'], sorted_pool['salary']) if sorted_pool.get('salary') else 0.5
    # Primary stack: 0-7 → 0-1.
    stack_norm = min(1.0, features['primary_stack'] / 7.0)
    # Bring-back: 0-5 → 0-1.
    bb_norm = min(1.0, features['bring_back'] / 5.0)
    return (proj_pct, own_pct, range_pct, salary_pct, stack_norm, bb_norm)

def euclidean(a, b):
    return sum((x - y) ** 2 for x, y in zip(a, b)) ** 0.5

def kmeans(points, k, max_iter=100, seed=42):
    """Simple k-means. Returns (centroids, assignments)."""
    rng = random.Random(seed)
    centroids = rng.sample(points, k)
    for _ in range(max_iter):
        # Assign.
        assignments = []
        for p in points:
            best, best_d = 0, float('inf')
            for i, c in enumerate(centroids):
                d = euclidean(p, c)
                if d < best_d:
                    best, best_d = i, d
            assignments.append(best)
        # Recompute centroids.
        new_centroids = []
        for i in range(k):
            members = [points[j] for j in range(len(points)) if assignments[j] == i]
            if not members:
                new_centroids.append(centroids[i])
            else:
                new_centroids.append(tuple(sum(m[d] for m in members) / len(members) for d in range(len(members[0]))))
        # Check convergence.
        moved = max(euclidean(c1, c2) for c1, c2 in zip(centroids, new_centroids))
        centroids = new_centroids
        if moved < 1e-4:
            break
    return centroids, assignments

def main():
    print('Loading all_systems_lineups.json...')
    with open(os.path.join(DATA, 'theory_dfs_structural', 'all_systems_lineups.json'), encoding='utf-8') as f:
        all_systems = json.load(f)
    systems_by_slate = defaultdict(dict)
    for entry in all_systems:
        systems_by_slate[entry['slate']][entry['system']] = entry

    # Collect ALL lineups (pros + systems) with feature vectors.
    pro_features = []
    system_features = defaultdict(list)  # {system_name: [(slate, fv), ...]}

    print('\nProcessing slates and extracting features...')
    for slate_id, proj_file, actuals_file, pool_file in SLATES:
        proj_path = os.path.join(DATA, proj_file)
        act_path = os.path.join(DATA, actuals_file)
        pool_path = os.path.join(DATA, pool_file)
        if not all(os.path.exists(p) for p in [proj_path, act_path, pool_path]):
            continue

        projections = load_projections(proj_path)
        pool_lineups = load_pool_lineups(pool_path, projections)
        if not pool_lineups:
            continue
        sorted_pool = {
            'proj': sorted(p['proj'] for p in pool_lineups),
            'own': sorted(p['own'] for p in pool_lineups),
            'range': sorted(p.get('range', 0) for p in pool_lineups),
            'salary': sorted(p['salary'] for p in pool_lineups),
        }

        # Pro lineups.
        with open(act_path, encoding='utf-8-sig') as f:
            reader = csv.DictReader(f)
            for row in reader:
                user = extract_username(row.get('EntryName') or '')
                if user not in PROS:
                    continue
                names = parse_lineup_string(row.get('Lineup', ''))
                if len(names) != 10:
                    continue
                players = []
                ok = True
                for nm in names:
                    p = projections.get(norm(nm))
                    if not p:
                        ok = False
                        break
                    players.append(p)
                if not ok:
                    continue
                feat = lineup_features(players)
                fv = feature_vector(feat, sorted_pool)
                pro_features.append(fv)

        # System lineups.
        for system_name in ['hermes-a', 'theory-dfs-mlb', 'theory-dfs-mlb-hcombo', 'random-mlb']:
            sys_data = systems_by_slate[slate_id].get(system_name)
            if not sys_data:
                continue
            for sys_lu in sys_data['lineups']:
                # Use precomputed pp/op from JSON, plus pri (primary), salary.
                # We have pp, op already. Need range_pct, salary_pct, bring_back from raw lineup.
                # Reconstruct from pids.
                player_dicts = []
                ok = True
                # We need projections lookup by id, but I loaded by name. Build id-map.
                # For simplicity: skip system lineups that need this (use hosted aggregates).
                # Actually we can rebuild with projection dict by id:
                # build proj-by-id dict once per slate.
                pass

    # The system-features extraction above is incomplete; let me redo by building proj-by-id.
    # Simpler: re-process system lineups by joining via player IDs.

    print(f'\nCollected {len(pro_features)} pro lineup feature vectors.')

    # Re-process system lineups with proper feature extraction (need id->player map per slate).
    print('Re-processing system lineups...')
    for slate_id, proj_file, actuals_file, pool_file in SLATES:
        proj_path = os.path.join(DATA, proj_file)
        pool_path = os.path.join(DATA, pool_file)
        if not all(os.path.exists(p) for p in [proj_path, pool_path]):
            continue
        # Build id -> player map.
        id_map = {}
        with open(proj_path, encoding='utf-8-sig') as f:
            reader = csv.DictReader(f)
            for row in reader:
                pid = row.get('DFS ID', '')
                try:
                    proj = float(row.get('My Proj') or row.get('Proj') or 0) or 0
                    own = float(row.get('Adj Own') or row.get('My Own') or 0) or 0
                    salary = float(row.get('Salary') or 0) or 0
                    ceiling = float(row.get('dk_85_percentile') or 0) or proj * 1.3
                    floor = float(row.get('dk_25_percentile') or 0) or proj * 0.85
                except (ValueError, TypeError):
                    continue
                if pid:
                    id_map[pid] = {'proj': proj, 'own': own, 'salary': salary,
                                   'team': (row.get('Team') or '').upper(),
                                   'opp': (row.get('Opp') or '').upper(),
                                   'position': (row.get('Pos') or '').upper(),
                                   'ceiling': ceiling, 'floor': floor}
        pool_lineups = load_pool_lineups(pool_path, None)
        if not pool_lineups:
            continue
        sorted_pool = {
            'proj': sorted(p['proj'] for p in pool_lineups),
            'own': sorted(p['own'] for p in pool_lineups),
            'range': sorted(p.get('range', 0) for p in pool_lineups),
            'salary': sorted(p['salary'] for p in pool_lineups),
        }
        for system_name in ['hermes-a', 'theory-dfs-mlb', 'theory-dfs-mlb-hcombo', 'random-mlb']:
            sys_data = systems_by_slate[slate_id].get(system_name)
            if not sys_data:
                continue
            for sys_lu in sys_data['lineups']:
                pids = sys_lu.get('pids', [])
                if not pids:
                    continue
                players = [id_map.get(pid) for pid in pids]
                if any(p is None for p in players):
                    continue
                feat = lineup_features(players)
                fv = feature_vector(feat, sorted_pool)
                system_features[system_name].append(fv)

    print(f'\nSystem feature vectors:')
    for s, fvs in system_features.items():
        print(f'  {s}: {len(fvs)}')

    # K-means on pro lineups.
    print('\nRunning k-means on pro lineups (k=3)...')
    centroids, pro_assignments = kmeans(pro_features, k=3, seed=42)
    pro_cluster_sizes = Counter(pro_assignments)

    print('\nPro cluster summary (k=3):')
    feature_names = ['proj_pct', 'own_pct', 'range_pct', 'salary_pct', 'stack_norm', 'bring_back_norm']
    for ci, c in enumerate(centroids):
        size = pro_cluster_sizes[ci]
        share = size / len(pro_features) * 100
        cstr = ', '.join(f'{n}={v:.2f}' for n, v in zip(feature_names, c))
        print(f'  Cluster {ci} ({size}, {share:.0f}%): {cstr}')

    # Assign system lineups to pro clusters.
    print('\nSystem cluster occupancy (vs pros):')
    print(f"{'System':<25s} | {'C0 %':>5s} | {'C1 %':>5s} | {'C2 %':>5s} | n")
    pro_dist = [pro_cluster_sizes[i] / len(pro_features) for i in range(3)]
    print(f"{'PROS':<25s} | {pro_dist[0]*100:>4.0f}% | {pro_dist[1]*100:>4.0f}% | {pro_dist[2]*100:>4.0f}% | {len(pro_features)}")
    cluster_gaps = {}  # system -> [gap per cluster]
    for sys_name, fvs in system_features.items():
        sys_assignments = []
        for fv in fvs:
            best, best_d = 0, float('inf')
            for i, c in enumerate(centroids):
                d = euclidean(fv, c)
                if d < best_d:
                    best, best_d = i, d
            sys_assignments.append(best)
        sys_dist = [Counter(sys_assignments)[i] / len(fvs) if fvs else 0 for i in range(3)]
        gaps = [sys_dist[i] - pro_dist[i] for i in range(3)]
        cluster_gaps[sys_name] = gaps
        print(f"{sys_name:<25s} | {sys_dist[0]*100:>4.0f}% | {sys_dist[1]*100:>4.0f}% | {sys_dist[2]*100:>4.0f}% | {len(fvs)}")

    print('\nCluster occupancy gaps (system - pro, in pp):')
    print(f"{'System':<25s} | {'C0 gap':>6s} | {'C1 gap':>6s} | {'C2 gap':>6s}")
    for sys_name, gaps in cluster_gaps.items():
        print(f"{sys_name:<25s} | {gaps[0]*100:>+5.1f}pp | {gaps[1]*100:>+5.1f}pp | {gaps[2]*100:>+5.1f}pp")

    # Save.
    out = {
        'k': 3,
        'pro_n': len(pro_features),
        'centroids': [list(c) for c in centroids],
        'feature_names': feature_names,
        'pro_distribution': pro_dist,
        'system_distributions': {s: [Counter(
            [
                min(range(3), key=lambda i: euclidean(fv, centroids[i]))
                for fv in fvs
            ])[i] / max(1, len(fvs)) for i in range(3)] for s, fvs in system_features.items()},
        'system_n': {s: len(fvs) for s, fvs in system_features.items()},
        'cluster_gaps': cluster_gaps,
    }
    with open(os.path.join(OUT, 'I2_raw.json'), 'w') as f:
        json.dump(out, f, indent=2, default=str)
    print(f'\nSaved I2_raw.json')

if __name__ == '__main__':
    main()
