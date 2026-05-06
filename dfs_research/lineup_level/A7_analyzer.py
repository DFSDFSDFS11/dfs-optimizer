"""
A7: Specific player exposure differences (V1 vs pros).

Aggregate per-player exposure across 18 slates for V1 and pros. Find players where
V1's exposure differs from pros' by 10+ percentage points consistently.

Names key the aggregator (player IDs change daily; same player has different IDs
across slates). Compute total appearances / total possible appearances per source.

Output: top 30 players where V1 over-exposes vs pros, top 30 where V1 under-exposes.
For each, include slate-count and contextual data (avg own, avg proj, position).
"""
import json
import csv
import os
import re
import sys
import statistics
from collections import defaultdict, Counter

sys.stdout.reconfigure(encoding='utf-8')

OUT = r'C:\Users\colin\dfs opto\lineup_level'
DATA = r'C:\Users\colin\dfs opto'
PROS = {'zroth', 'nerdytenor', 'shipmymoney', 'shaidyadvice', 'needlunchmoney', 'bgreseth', 'youdacao'}

SLATES = [
    ('4-6-26', '4-6-26_projections.csv', 'dkactuals 4-6-26.csv'),
    ('4-8-26', '4-8-26projections.csv', '4-8-26actuals.csv'),
    ('4-12-26', '4-12-26projections.csv', '4-12-26actuals.csv'),
    ('4-14-26', '4-14-26projections.csv', '4-14-26actuals.csv'),
    ('4-15-26', '4-15-26projections.csv', '4-15-26actuals.csv'),
    ('4-17-26', '4-17-26projections.csv', '4-17-26actuals.csv'),
    ('4-18-26', '4-18-26projections.csv', '4-18-26actuals.csv'),
    ('4-19-26', '4-19-26projections.csv', '4-19-26actuals.csv'),
    ('4-20-26', '4-20-26projections.csv', '4-20-26actuals.csv'),
    ('4-21-26', '4-21-26projections.csv', '4-21-26actuals.csv'),
    ('4-22-26', '4-22-26projections.csv', '4-22-26actuals.csv'),
    ('4-23-26', '4-23-26projections.csv', '4-23-26actuals.csv'),
    ('4-24-26', '4-24-26projections.csv', '4-24-26actuals.csv'),
    ('4-25-26', '4-25-26projections.csv', '4-25-26actuals.csv'),
    ('4-25-26-early', '4-25-26projectionsearly.csv', '4-25-26actualsearly.csv'),
    ('4-26-26', '4-26-26projections.csv', '4-26-26actuals.csv'),
    ('4-27-26', '4-27-26projections.csv', '4-27-26actuals.csv'),
    ('4-28-26', '4-28-26projections.csv', '4-28-26actuals.csv'),
]

POSITIONS = {'P', 'C', '1B', '2B', '3B', 'SS', 'OF'}

def norm(s): return re.sub(r'\s+', ' ', re.sub(r'[^a-z0-9 ]+', ' ', (s or '').lower())).strip()
def extract_username(e): return re.sub(r'\s*\([^)]*\)\s*$', '', e or '').strip().lower()

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

def main():
    print('Loading all_systems_lineups.json...')
    with open(os.path.join(DATA, 'theory_dfs_structural', 'all_systems_lineups.json'), encoding='utf-8') as f:
        all_systems = json.load(f)
    systems_by_slate = defaultdict(dict)
    for entry in all_systems:
        systems_by_slate[entry['slate']][entry['system']] = entry

    # Per slate: for each player, count appearances in V1 vs pros (normalized).
    # Aggregate by NAME (not ID) since IDs change daily.
    # exposure = appearances / total_lineups_in_source_for_slate
    # Then average across slates where player appeared.
    player_stats = defaultdict(lambda: {
        'v1_total_appearances': 0, 'v1_total_lineups': 0,
        'pro_total_appearances': 0, 'pro_total_lineups': 0,
        'slates': set(), 'avg_own': [], 'avg_proj': [], 'position': '', 'team_seen': set(),
    })

    for slate_id, proj_file, actuals_file in SLATES:
        proj_path = os.path.join(DATA, proj_file)
        act_path = os.path.join(DATA, actuals_file)
        if not all(os.path.exists(p) for p in [proj_path, act_path]):
            continue

        # Build name and id maps.
        name_to_p = {}
        id_to_name = {}
        with open(proj_path, encoding='utf-8-sig') as f:
            reader = csv.DictReader(f)
            for row in reader:
                pid = row.get('DFS ID', '')
                name = row.get('Name', '')
                try:
                    proj = float(row.get('My Proj') or 0) or 0
                    own = float(row.get('Adj Own') or 0) or 0
                except (ValueError, TypeError):
                    continue
                if name:
                    n = norm(name)
                    name_to_p[n] = {'name': name, 'proj': proj, 'own': own,
                                    'team': (row.get('Team') or '').upper(),
                                    'position': (row.get('Pos') or '').upper()}
                if pid:
                    id_to_name[pid] = name

        # Pro lineups.
        pro_total = 0
        pro_appearances = Counter()
        with open(act_path, encoding='utf-8-sig') as f:
            reader = csv.DictReader(f)
            for row in reader:
                user = extract_username(row.get('EntryName') or '')
                if user not in PROS: continue
                names = parse_lineup_string(row.get('Lineup', ''))
                if len(names) != 10: continue
                resolved = [norm(nm) for nm in names if norm(nm) in name_to_p]
                if len(resolved) != 10: continue
                pro_total += 1
                for n in resolved:
                    pro_appearances[n] += 1

        # V1 lineups.
        v1_total = 0
        v1_appearances = Counter()
        v1_data = systems_by_slate[slate_id].get('theory-dfs-mlb')
        if v1_data:
            for sys_lu in v1_data['lineups']:
                pids = sys_lu.get('pids', [])
                pls = [id_to_name.get(pid, '') for pid in pids]
                resolved = [norm(nm) for nm in pls if norm(nm) in name_to_p]
                if len(resolved) != 10: continue
                v1_total += 1
                for n in resolved:
                    v1_appearances[n] += 1

        # Accumulate.
        all_names = set(pro_appearances.keys()) | set(v1_appearances.keys())
        for n in all_names:
            stat = player_stats[n]
            pro_count = pro_appearances.get(n, 0)
            v1_count = v1_appearances.get(n, 0)
            stat['pro_total_appearances'] += pro_count
            stat['pro_total_lineups'] += pro_total
            stat['v1_total_appearances'] += v1_count
            stat['v1_total_lineups'] += v1_total
            stat['slates'].add(slate_id)
            p = name_to_p.get(n, {})
            stat['avg_own'].append(p.get('own', 0))
            stat['avg_proj'].append(p.get('proj', 0))
            if not stat['position']:
                stat['position'] = p.get('position', '')
            if p.get('team'):
                stat['team_seen'].add(p['team'])

    # Compute exposure rates and gaps.
    rows = []
    for name, stat in player_stats.items():
        if len(stat['slates']) < 2: continue
        if stat['v1_total_lineups'] < 100 or stat['pro_total_lineups'] < 100: continue
        v1_exp = stat['v1_total_appearances'] / stat['v1_total_lineups']
        pro_exp = stat['pro_total_appearances'] / stat['pro_total_lineups']
        gap = v1_exp - pro_exp
        rows.append({
            'name': name,
            'v1_exp': v1_exp, 'pro_exp': pro_exp, 'gap_pp': gap * 100,
            'n_slates': len(stat['slates']),
            'avg_own': statistics.mean(stat['avg_own']) if stat['avg_own'] else 0,
            'avg_proj': statistics.mean(stat['avg_proj']) if stat['avg_proj'] else 0,
            'position': stat['position'],
        })

    rows.sort(key=lambda r: -r['gap_pp'])
    over = [r for r in rows if r['gap_pp'] > 5]
    under = [r for r in rows if r['gap_pp'] < -5]

    print('\nA7 — Specific player exposure differences (V1 vs pros)')
    print('=' * 100)
    print(f'\n{len(rows)} players with 2+ slates of data')
    print(f'V1 over-exposed by 5+pp: {len(over)} players')
    print(f'V1 under-exposed by 5+pp: {len(under)} players')
    print()
    print('TOP 25 V1 OVER-EXPOSED (V1 uses more than pros, 10+pp gap):')
    print(f"{'Player':<25s} | {'pos':<4s} | {'V1 exp':>7s} | {'Pro exp':>7s} | {'gap':>6s} | {'avg own':>8s} | {'avg proj':>8s} | n")
    over_sorted = [r for r in over if r['gap_pp'] >= 10]
    for r in over_sorted[:25]:
        nm = (r['name'] or '')[:23]
        print(f"{nm:<25s} | {r['position'][:3]:<4s} | {r['v1_exp']*100:>6.1f}% | {r['pro_exp']*100:>6.1f}% | {r['gap_pp']:>+5.1f}pp | {r['avg_own']:>7.1f}% | {r['avg_proj']:>8.1f} | {r['n_slates']}")

    print()
    print('TOP 25 V1 UNDER-EXPOSED (V1 uses less than pros, 10+pp gap):')
    print(f"{'Player':<25s} | {'pos':<4s} | {'V1 exp':>7s} | {'Pro exp':>7s} | {'gap':>6s} | {'avg own':>8s} | {'avg proj':>8s} | n")
    under_sorted = [r for r in under if r['gap_pp'] <= -10]
    for r in under_sorted[:25]:
        nm = (r['name'] or '')[:23]
        print(f"{nm:<25s} | {r['position'][:3]:<4s} | {r['v1_exp']*100:>6.1f}% | {r['pro_exp']*100:>6.1f}% | {r['gap_pp']:>+5.1f}pp | {r['avg_own']:>7.1f}% | {r['avg_proj']:>8.1f} | {r['n_slates']}")

    # Position-aggregated patterns.
    print('\nGap pattern by position:')
    by_pos = defaultdict(list)
    for r in rows:
        pos = r['position'][:1] if r['position'] else 'X'
        by_pos[pos].append(r['gap_pp'])
    for pos in ('P', '1', '2', '3', 'S', 'O', 'C'):
        gaps = by_pos.get(pos, [])
        if not gaps: continue
        print(f"  pos={pos}: n={len(gaps)} mean_gap={statistics.mean(gaps):+.1f}pp std={statistics.stdev(gaps) if len(gaps)>1 else 0:.1f}")

    # Save.
    with open(os.path.join(OUT, 'A7_raw.json'), 'w') as f:
        json.dump({
            'all_rows': rows, 'top_over_exposed': over_sorted[:50], 'top_under_exposed': under_sorted[:50],
        }, f, indent=2, default=str)
    print('\nSaved A7_raw.json')

if __name__ == '__main__':
    main()
