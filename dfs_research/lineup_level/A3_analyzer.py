"""
A3: Stack size distribution analysis.

Across 18 slates, count how often V1 vs pros use:
  - 4-stacks (exactly 4 hitters from one team)
  - 5-stacks (5+ hitters from one team)
  - 3-3 splits (3 hitters from team A + 3 from team B; secondary stack >= 3)
  - 4-2 splits (primary 4-stack with secondary 2+ stack)
  - "naked" stacks (primary stack with NO bring-back)

Output: distribution of stack-construction archetypes for V1 vs pros.
"""
import json
import csv
import os
import re
import sys
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
            if started and current: players.append(' '.join(current))
            current = []; started = True
        elif started: current.append(t)
    if current: players.append(' '.join(current))
    return players

def stack_archetype(player_dicts):
    """Returns (primary_size, secondary_size, archetype_label)."""
    teams = defaultdict(int)
    for p in player_dicts:
        if 'P' in p.get('position', ''): continue
        if p.get('team'): teams[p['team']] += 1
    sorted_sizes = sorted(teams.values(), reverse=True)
    primary = sorted_sizes[0] if sorted_sizes else 0
    secondary = sorted_sizes[1] if len(sorted_sizes) > 1 else 0
    label = ''
    if primary >= 5:
        if secondary >= 2: label = '5-' + str(secondary)
        else: label = '5-naked'
    elif primary == 4:
        if secondary >= 3: label = '4-3'
        elif secondary == 2: label = '4-2'
        else: label = '4-naked'
    elif primary == 3:
        if secondary >= 3: label = '3-3'
        elif secondary == 2: label = '3-2'
        else: label = '3-1-1'
    else:
        label = 'spread'
    return primary, secondary, label

def main():
    print('Loading all_systems_lineups.json...')
    with open(os.path.join(DATA, 'theory_dfs_structural', 'all_systems_lineups.json'), encoding='utf-8') as f:
        all_systems = json.load(f)
    systems_by_slate = defaultdict(dict)
    for entry in all_systems:
        systems_by_slate[entry['slate']][entry['system']] = entry

    archetype_counts = defaultdict(Counter)  # source -> Counter(archetype label)
    primary_size_counts = defaultdict(Counter)
    total_lineups = defaultdict(int)

    for slate_id, proj_file, actuals_file in SLATES:
        proj_path = os.path.join(DATA, proj_file)
        act_path = os.path.join(DATA, actuals_file)
        if not all(os.path.exists(p) for p in [proj_path, act_path]): continue

        # Build name + id maps.
        name_to_p = {}
        id_to_p = {}
        with open(proj_path, encoding='utf-8-sig') as f:
            reader = csv.DictReader(f)
            for row in reader:
                pid = row.get('DFS ID', '')
                name = row.get('Name', '')
                pdat = {'team': (row.get('Team') or '').upper(), 'position': (row.get('Pos') or '').upper()}
                if name: name_to_p[norm(name)] = pdat
                if pid: id_to_p[pid] = pdat

        # Pro lineups.
        with open(act_path, encoding='utf-8-sig') as f:
            reader = csv.DictReader(f)
            for row in reader:
                user = extract_username(row.get('EntryName') or '')
                if user not in PROS: continue
                names = parse_lineup_string(row.get('Lineup', ''))
                if len(names) != 10: continue
                pls = [name_to_p.get(norm(nm)) for nm in names]
                if any(p is None for p in pls): continue
                primary, secondary, label = stack_archetype(pls)
                archetype_counts['pros'][label] += 1
                primary_size_counts['pros'][primary] += 1
                total_lineups['pros'] += 1

        # V1 lineups.
        v1_data = systems_by_slate[slate_id].get('theory-dfs-mlb')
        if v1_data:
            for sys_lu in v1_data['lineups']:
                pids = sys_lu.get('pids', [])
                pls = [id_to_p.get(pid) for pid in pids]
                if any(p is None for p in pls): continue
                primary, secondary, label = stack_archetype(pls)
                archetype_counts['v1'][label] += 1
                primary_size_counts['v1'][primary] += 1
                total_lineups['v1'] += 1

    # Print.
    print('\nA3 — Stack size distribution')
    print('=' * 60)
    print(f"\nTotal lineups: V1={total_lineups['v1']}, pros={total_lineups['pros']}")
    print()
    print('Primary stack size distribution:')
    print(f"{'Size':<6s} | {'V1 %':>6s} | {'Pros %':>7s} | {'Δ':>5s}")
    sizes = sorted(set(list(primary_size_counts['v1'].keys()) + list(primary_size_counts['pros'].keys())))
    for sz in sizes:
        v1_pct = primary_size_counts['v1'].get(sz, 0) / total_lineups['v1'] * 100 if total_lineups['v1'] else 0
        pro_pct = primary_size_counts['pros'].get(sz, 0) / total_lineups['pros'] * 100 if total_lineups['pros'] else 0
        diff = v1_pct - pro_pct
        print(f"  {sz:<3d}    | {v1_pct:>5.1f}% | {pro_pct:>6.1f}% | {diff:>+4.1f}pp")

    print()
    print('Stack archetype distribution:')
    print(f"{'Archetype':<10s} | {'V1 %':>6s} | {'Pros %':>7s} | {'Δ':>5s}")
    all_archetypes = sorted(set(list(archetype_counts['v1'].keys()) + list(archetype_counts['pros'].keys())))
    for arch in all_archetypes:
        v1_pct = archetype_counts['v1'].get(arch, 0) / total_lineups['v1'] * 100 if total_lineups['v1'] else 0
        pro_pct = archetype_counts['pros'].get(arch, 0) / total_lineups['pros'] * 100 if total_lineups['pros'] else 0
        diff = v1_pct - pro_pct
        print(f"  {arch:<8s} | {v1_pct:>5.1f}% | {pro_pct:>6.1f}% | {diff:>+4.1f}pp")

    out = {
        'total_lineups': dict(total_lineups),
        'primary_size_distribution': {k: dict(v) for k, v in primary_size_counts.items()},
        'archetype_distribution': {k: dict(v) for k, v in archetype_counts.items()},
    }
    with open(os.path.join(OUT, 'A3_raw.json'), 'w') as f:
        json.dump(out, f, indent=2, default=str)
    print('\nSaved A3_raw.json')

if __name__ == '__main__':
    main()
