"""
I1: Lineup-level pairing distance.

For each Theory-DFS-V1 (and Hermes-A) lineup, find the nearest pro lineup in
standardized feature space (proj_pct, own_pct, primary_stack_size). Compute
mean nearest-distance. Hypothesis: V1 lineups are individually farther from
any specific pro lineup than Hermes-A lineups are.

Approach:
- Load all_systems_lineups.json (per-lineup features for hermes-a, theory-dfs-mlb, etc.)
- For each of 18 slates:
  * Load projections CSV (player ID -> proj, own, team, opp)
  * Load actuals CSV; filter to pro entries (zroth, nerdytenor, etc.)
  * For each pro lineup: compute (proj, own, primaryStackSize)
  * Compute proj_pct and own_pct of each pro lineup vs the slate's pool projection/ownership distribution
- For each system lineup, find nearest pro lineup (Euclidean in standardized space)
- Aggregate per system: mean distance, median, p90.
"""
import json
import csv
import sys
import os
import re
import statistics
from collections import defaultdict

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
    """Returns dict: name_norm -> {proj, own, salary, team, opp, position}"""
    out = {}
    with open(path, encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        for row in reader:
            name = row.get('Name', '')
            proj = float(row.get('My Proj') or row.get('Proj') or 0) or 0
            own = float(row.get('Adj Own') or row.get('My Own') or 0) or 0
            salary = float(row.get('Salary') or 0) or 0
            team = (row.get('Team') or '').upper()
            opp = (row.get('Opp') or '').upper()
            pos = (row.get('Pos') or '').upper()
            n = norm(name)
            if n:
                out[n] = {'proj': proj, 'own': own, 'salary': salary, 'team': team, 'opp': opp, 'position': pos, 'name': name}
    return out

def parse_lineup_string(lineup_str):
    """Parse 'P deGrom P Sale C Bailey 1B Olson...' into player names."""
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

def load_pro_lineups_for_slate(actuals_path, projections):
    """Returns list of pro lineups: each is dict with player_features list + summary."""
    pro_lineups = []
    with open(actuals_path, encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        for row in reader:
            entry_name = row.get('EntryName') or row.get('Entry Name') or ''
            user = extract_username(entry_name)
            if user not in PROS:
                continue
            lineup_str = row.get('Lineup', '')
            names = parse_lineup_string(lineup_str)
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
            # Compute lineup features.
            proj_sum = sum(p['proj'] for p in players)
            own_avg = sum(p['own'] for p in players) / len(players)
            salary_sum = sum(p['salary'] for p in players)
            # Primary stack: count hitters per team.
            team_counts = defaultdict(int)
            for p in players:
                if 'P' in p['position']:
                    continue
                if p['team']:
                    team_counts[p['team']] += 1
            primary_stack = max(team_counts.values()) if team_counts else 0
            pro_lineups.append({
                'username': user, 'rank': int(row.get('Rank') or 0),
                'proj': proj_sum, 'own': own_avg, 'salary': salary_sum, 'primary_stack': primary_stack,
            })
    return pro_lineups

def load_pool_features(pool_path, projections):
    """Returns list of (proj, own) tuples for the pool's lineups, used to compute percentile ranks."""
    pool_features = []
    with open(pool_path, encoding='utf-8-sig') as f:
        reader = csv.reader(f)
        header = next(reader)
        # Position columns: first 10 cols for MLB classic
        proj_idx = next((i for i, h in enumerate(header) if h.strip().lower() == 'proj score'), -1)
        own_idx = next((i for i, h in enumerate(header) if h.strip().lower() == 'ownership'), -1)
        if proj_idx < 0 or own_idx < 0:
            return []
        for row in reader:
            try:
                proj = float(row[proj_idx])
                own = float(row[own_idx])
                pool_features.append((proj, own))
            except (ValueError, IndexError):
                continue
    return pool_features

def percentile_rank(value, sorted_values):
    """Returns rank percentile of value in sorted_values (0..1)."""
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

def main():
    # Load all_systems_lineups.json (has system per-lineup features).
    print('Loading all_systems_lineups.json...')
    with open(os.path.join(DATA, 'theory_dfs_structural', 'all_systems_lineups.json'), encoding='utf-8') as f:
        all_systems = json.load(f)

    # Index systems by slate.
    systems_by_slate = defaultdict(dict)
    for entry in all_systems:
        systems_by_slate[entry['slate']][entry['system']] = entry

    print(f'\nLoaded {len(all_systems)} system-slate combinations across {len(systems_by_slate)} slates')

    # For each system, accumulate lineup-level distances.
    system_distances = defaultdict(list)  # {system_name: [distances]}
    slate_summary = []

    for slate_id, proj_file, actuals_file, pool_file in SLATES:
        print(f'\nProcessing slate {slate_id}...')
        proj_path = os.path.join(DATA, proj_file)
        act_path = os.path.join(DATA, actuals_file)
        pool_path = os.path.join(DATA, pool_file)
        if not all(os.path.exists(p) for p in [proj_path, act_path, pool_path]):
            print(f'  skip: files missing')
            continue

        projections = load_projections(proj_path)
        pool_features = load_pool_features(pool_path, projections)
        if not pool_features:
            print('  skip: no pool features')
            continue
        proj_sorted = sorted(p[0] for p in pool_features)
        own_sorted = sorted(p[1] for p in pool_features)

        pro_lineups = load_pro_lineups_for_slate(act_path, projections)
        if len(pro_lineups) < 50:
            print(f'  skip: only {len(pro_lineups)} pro lineups')
            continue

        # Compute features for each pro lineup (pp, op, primary_stack).
        for plr in pro_lineups:
            plr['pp'] = percentile_rank(plr['proj'], proj_sorted)
            plr['op'] = percentile_rank(plr['own'], own_sorted)

        # For each system on this slate, compute distance to nearest pro lineup.
        slate_results = {}
        for system_name in ['hermes-a', 'theory-dfs-mlb', 'theory-dfs-mlb-hcombo', 'random-mlb']:
            sys_data = systems_by_slate[slate_id].get(system_name)
            if not sys_data:
                continue
            system_lineup_distances = []
            for sys_lu in sys_data['lineups']:
                # System features: pp, op, pri (primary stack/game size).
                sys_pp = sys_lu['pp']
                sys_op = sys_lu['op']
                sys_pri = sys_lu['pri']
                # Find nearest pro lineup by Euclidean distance in (pp, op, primary_stack/10).
                best_dist = float('inf')
                for plr in pro_lineups:
                    d_pp = sys_pp - plr['pp']
                    d_op = sys_op - plr['op']
                    d_pri = (sys_pri - plr['primary_stack']) / 10.0  # downweight
                    dist = (d_pp**2 + d_op**2 + d_pri**2) ** 0.5
                    if dist < best_dist:
                        best_dist = dist
                system_lineup_distances.append(best_dist)
                system_distances[system_name].append(best_dist)
            if system_lineup_distances:
                slate_results[system_name] = {
                    'mean': statistics.mean(system_lineup_distances),
                    'median': statistics.median(system_lineup_distances),
                    'p90': sorted(system_lineup_distances)[int(0.9 * len(system_lineup_distances))],
                    'n': len(system_lineup_distances),
                }
        slate_summary.append({'slate': slate_id, 'n_pros': len(pro_lineups), 'systems': slate_results})
        sys_str = ' | '.join(f'{s}={r["mean"]:.3f}' for s, r in slate_results.items())
        print(f'  {len(pro_lineups)} pros. Mean nearest dist: {sys_str}')

    # Aggregate.
    print('\n' + '=' * 90)
    print('I1 RESULTS — Lineup-level distance to nearest pro')
    print('=' * 90)
    print(f"\n{'System':<25s} | {'Mean':>7s} | {'Median':>7s} | {'p90':>7s} | {'p10':>7s} | {'n_lineups':>9s}")
    print('-' * 80)
    for sys_name in ['hermes-a', 'theory-dfs-mlb', 'theory-dfs-mlb-hcombo', 'random-mlb']:
        ds = system_distances.get(sys_name, [])
        if not ds:
            continue
        ds_sorted = sorted(ds)
        m = statistics.mean(ds)
        med = statistics.median(ds)
        p90 = ds_sorted[int(0.9 * len(ds))]
        p10 = ds_sorted[int(0.1 * len(ds))]
        print(f"{sys_name:<25s} | {m:7.3f} | {med:7.3f} | {p90:7.3f} | {p10:7.3f} | {len(ds):>9d}")

    # Save raw output.
    out = {
        'aggregate': {sys_name: {
            'mean': statistics.mean(system_distances[sys_name]),
            'median': statistics.median(system_distances[sys_name]),
            'p90': sorted(system_distances[sys_name])[int(0.9 * len(system_distances[sys_name]))],
            'p10': sorted(system_distances[sys_name])[int(0.1 * len(system_distances[sys_name]))],
            'n': len(system_distances[sys_name]),
        } for sys_name in system_distances},
        'per_slate': slate_summary,
    }
    with open(os.path.join(OUT, 'I1_raw.json'), 'w') as f:
        json.dump(out, f, indent=2, default=str)
    print(f'\nSaved I1_raw.json')

if __name__ == '__main__':
    main()
