"""
I5: Pro stack composition deep-dive — identifies SPECIFIC pro-core player pairs per team.

I3 hypothesis: V1 picks LEVERAGE-pair stacks (low-own alternates) while pros pick CHALK-pair
stacks (high-own stars).

I5 method:
- For each slate, group pro lineups by primary stack team.
- Per (slate, team) where 30+ pro lineups stack that team:
  - Identify top-2 most-FREQUENT players in the stack (i.e., the empirical pro-core pair).
  - Compute "top-2 by own × proj" (the V3 candidate proxy).
  - Compare: do these match? If yes, V3's proxy is valid.
- Per (slate, team), do same for V1's stacked lineups → V1's empirical core pair.
- Compare pro-empirical-core vs V1-empirical-core: are they DIFFERENT players?

Key output: a table of "pro stacks the chalk-pair X+Y, V1 stacks the leverage-pair Z+W" examples.
This grounds the V3 design in specific player-level evidence.
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
MIN_STACK_LINEUPS = 20  # require at least 20 pro lineups stacking a team to analyze it

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

def get_primary_stack(player_dicts):
    """Returns (primary_team, primary_pids_set, primary_pid_to_name)."""
    team_pids = defaultdict(list)
    pid_name = {}
    for p in player_dicts:
        if 'P' in p.get('position', ''):
            continue
        t = p.get('team', '')
        if t:
            pid = p.get('id', '')
            team_pids[t].append(pid)
            pid_name[pid] = p.get('name', pid)
    if not team_pids:
        return '', set(), {}
    primary = max(team_pids, key=lambda t: len(team_pids[t]))
    return primary, set(team_pids[primary]), pid_name

def main():
    print('Loading all_systems_lineups.json...')
    with open(os.path.join(DATA, 'theory_dfs_structural', 'all_systems_lineups.json'), encoding='utf-8') as f:
        all_systems = json.load(f)
    systems_by_slate = defaultdict(dict)
    for entry in all_systems:
        systems_by_slate[entry['slate']][entry['system']] = entry

    # Per (slate, team) accumulate: pro stack_pids appearances, V1 stack_pids appearances.
    # Plus per-team static info: own*proj rank for each player.

    examples = []  # list of dict: {slate, team, pro_top2, v1_top2, chalk_top2, n_pro, n_v1}
    aggregated_match = {  # cross-slate aggregation
        'pro_v1_top2_overlap': [],
        'pro_chalk_top2_overlap': [],
        'v1_chalk_top2_overlap': [],
        'pro_top2_avg_own': [],
        'v1_top2_avg_own': [],
        'chalk_top2_avg_own': [],
    }

    print('\nProcessing slates...')
    for slate_id, proj_file, actuals_file in SLATES:
        proj_path = os.path.join(DATA, proj_file)
        act_path = os.path.join(DATA, actuals_file)
        if not all(os.path.exists(p) for p in [proj_path, act_path]):
            continue

        # Load player dicts.
        name_to_p = {}
        id_to_p = {}
        with open(proj_path, encoding='utf-8-sig') as f:
            reader = csv.DictReader(f)
            for row in reader:
                pid = row.get('DFS ID', '')
                name = row.get('Name', '')
                try:
                    proj = float(row.get('My Proj') or row.get('Proj') or 0) or 0
                    own = float(row.get('Adj Own') or row.get('My Own') or 0) or 0
                except (ValueError, TypeError):
                    continue
                team = (row.get('Team') or '').upper()
                pos = (row.get('Pos') or '').upper()
                pdat = {'id': pid, 'name': name, 'proj': proj, 'own': own,
                        'team': team, 'position': pos, 'own_proj': own * proj}
                if name:
                    name_to_p[norm(name)] = pdat
                if pid:
                    id_to_p[pid] = pdat

        # Compute "chalk top-2" per team = top 2 hitters by own × proj.
        team_to_chalk_top2 = {}
        team_hitters = defaultdict(list)
        for p in id_to_p.values():
            if 'P' in p.get('position', ''):
                continue
            if p['team']:
                team_hitters[p['team']].append(p)
        for team, hitters in team_hitters.items():
            hitters.sort(key=lambda p: -p['own_proj'])
            team_to_chalk_top2[team] = [hitters[0], hitters[1]] if len(hitters) >= 2 else hitters

        # Pro stacks per team: count pid appearances in pro lineups stacked on team.
        pro_team_pid_count = defaultdict(Counter)  # team -> Counter(pid -> count)
        pro_team_lineup_count = Counter()
        with open(act_path, encoding='utf-8-sig') as f:
            reader = csv.DictReader(f)
            for row in reader:
                user = extract_username(row.get('EntryName') or '')
                if user not in PROS:
                    continue
                names = parse_lineup_string(row.get('Lineup', ''))
                if len(names) != 10:
                    continue
                player_dicts = []
                ok = True
                for nm in names:
                    p = name_to_p.get(norm(nm))
                    if not p:
                        ok = False
                        break
                    player_dicts.append(p)
                if not ok:
                    continue
                primary_team, primary_pids, _ = get_primary_stack(player_dicts)
                if primary_team and len(primary_pids) >= 4:
                    pro_team_lineup_count[primary_team] += 1
                    for pid in primary_pids:
                        pro_team_pid_count[primary_team][pid] += 1

        # V1 stacks per team.
        v1_team_pid_count = defaultdict(Counter)
        v1_team_lineup_count = Counter()
        v1_data = systems_by_slate[slate_id].get('theory-dfs-mlb')
        if v1_data:
            for sys_lu in v1_data['lineups']:
                pids = sys_lu.get('pids', [])
                player_dicts = [id_to_p.get(pid) for pid in pids]
                if any(p is None for p in player_dicts):
                    continue
                primary_team, primary_pids, _ = get_primary_stack(player_dicts)
                if primary_team and len(primary_pids) >= 4:
                    v1_team_lineup_count[primary_team] += 1
                    for pid in primary_pids:
                        v1_team_pid_count[primary_team][pid] += 1

        # For each team where pros stacked >= MIN_STACK_LINEUPS times, compute top-2 most-frequent pids.
        for team, n_pro in pro_team_lineup_count.items():
            if n_pro < MIN_STACK_LINEUPS:
                continue
            chalk_top2 = team_to_chalk_top2.get(team, [])
            if len(chalk_top2) < 2:
                continue
            # Pro most-used 2 in their stacks.
            pro_top2_pids = [pid for pid, _ in pro_team_pid_count[team].most_common(2)]
            # V1 most-used 2 in their stacks.
            n_v1 = v1_team_lineup_count.get(team, 0)
            if n_v1 < 5:
                continue  # need at least 5 V1 stacked lineups to have signal
            v1_top2_pids = [pid for pid, _ in v1_team_pid_count[team].most_common(2)]

            # Names + ownership.
            def names(pids):
                return [id_to_p.get(pid, {}).get('name', pid) for pid in pids]
            def avg_own(pids):
                vals = [id_to_p.get(pid, {}).get('own', 0) for pid in pids]
                return statistics.mean(vals) if vals else 0

            chalk_pids = [p['id'] for p in chalk_top2]
            example = {
                'slate': slate_id, 'team': team,
                'n_pro': n_pro, 'n_v1': n_v1,
                'pro_top2': names(pro_top2_pids), 'pro_top2_own': avg_own(pro_top2_pids),
                'v1_top2': names(v1_top2_pids), 'v1_top2_own': avg_own(v1_top2_pids),
                'chalk_top2': names(chalk_pids), 'chalk_top2_own': avg_own(chalk_pids),
                'pro_v1_overlap': len(set(pro_top2_pids) & set(v1_top2_pids)),
                'pro_chalk_overlap': len(set(pro_top2_pids) & set(chalk_pids)),
                'v1_chalk_overlap': len(set(v1_top2_pids) & set(chalk_pids)),
            }
            examples.append(example)
            aggregated_match['pro_v1_top2_overlap'].append(example['pro_v1_overlap'])
            aggregated_match['pro_chalk_top2_overlap'].append(example['pro_chalk_overlap'])
            aggregated_match['v1_chalk_top2_overlap'].append(example['v1_chalk_overlap'])
            aggregated_match['pro_top2_avg_own'].append(example['pro_top2_own'])
            aggregated_match['v1_top2_avg_own'].append(example['v1_top2_own'])
            aggregated_match['chalk_top2_avg_own'].append(example['chalk_top2_own'])

    print(f'\nAnalyzed {len(examples)} (slate, team) cores.')

    # Aggregate metrics.
    print('\n' + '=' * 100)
    print('I5 RESULTS — Pro vs V1 vs Chalk top-2 overlap')
    print('=' * 100)
    if not examples:
        print('NO data — exiting.')
        return

    print(f"\nMean overlap (out of 2 possible):")
    print(f"  pro_top2 ↔ v1_top2:    {statistics.mean(aggregated_match['pro_v1_top2_overlap']):.2f} of 2")
    print(f"  pro_top2 ↔ chalk_top2: {statistics.mean(aggregated_match['pro_chalk_top2_overlap']):.2f} of 2")
    print(f"  v1_top2 ↔ chalk_top2:  {statistics.mean(aggregated_match['v1_chalk_top2_overlap']):.2f} of 2")

    print(f"\nMean ownership of top-2 stack core:")
    print(f"  pro_top2_avg_own:   {statistics.mean(aggregated_match['pro_top2_avg_own']):.1f}%")
    print(f"  v1_top2_avg_own:    {statistics.mean(aggregated_match['v1_top2_avg_own']):.1f}%")
    print(f"  chalk_top2_avg_own: {statistics.mean(aggregated_match['chalk_top2_avg_own']):.1f}%")

    pro_chalk_match_pct = sum(1 for ex in examples if ex['pro_chalk_overlap'] == 2) / len(examples) * 100
    v1_chalk_match_pct = sum(1 for ex in examples if ex['v1_chalk_overlap'] == 2) / len(examples) * 100
    pro_v1_match_pct = sum(1 for ex in examples if ex['pro_v1_overlap'] == 2) / len(examples) * 100
    print(f"\nFull (2/2) overlap rates:")
    print(f"  Pro core EXACTLY = chalk-top2: {pro_chalk_match_pct:.0f}%")
    print(f"  V1 core EXACTLY = chalk-top2:  {v1_chalk_match_pct:.0f}%")
    print(f"  Pro core EXACTLY = V1 core:    {pro_v1_match_pct:.0f}%")

    # Show 15 example slate-team comparisons.
    print('\nSample (slate, team) comparisons (pro_chalk_overlap < 2):')
    print(f"{'slate':<14s} | {'team':<5s} | {'n_pro':>5s} | {'n_v1':>4s} | {'pro_top2':<35s} | {'v1_top2':<35s} | {'chalk_top2':<35s}")
    misaligned = [ex for ex in examples if ex['pro_chalk_overlap'] < 2 or ex['pro_v1_overlap'] < 2]
    for ex in misaligned[:15]:
        pro_str = ' + '.join(n[:16] for n in ex['pro_top2'])
        v1_str = ' + '.join(n[:16] for n in ex['v1_top2'])
        chalk_str = ' + '.join(n[:16] for n in ex['chalk_top2'])
        print(f"{ex['slate']:<14s} | {ex['team']:<5s} | {ex['n_pro']:>5d} | {ex['n_v1']:>4d} | {pro_str:<35s} | {v1_str:<35s} | {chalk_str:<35s}")

    # Save.
    out = {
        'examples': examples,
        'aggregate': {
            'n_cases': len(examples),
            'mean_pro_v1_overlap': statistics.mean(aggregated_match['pro_v1_top2_overlap']),
            'mean_pro_chalk_overlap': statistics.mean(aggregated_match['pro_chalk_top2_overlap']),
            'mean_v1_chalk_overlap': statistics.mean(aggregated_match['v1_chalk_top2_overlap']),
            'pro_top2_avg_own': statistics.mean(aggregated_match['pro_top2_avg_own']),
            'v1_top2_avg_own': statistics.mean(aggregated_match['v1_top2_avg_own']),
            'chalk_top2_avg_own': statistics.mean(aggregated_match['chalk_top2_avg_own']),
            'pro_chalk_full_match_pct': pro_chalk_match_pct,
            'v1_chalk_full_match_pct': v1_chalk_match_pct,
            'pro_v1_full_match_pct': pro_v1_match_pct,
        },
    }
    with open(os.path.join(OUT, 'I5_raw.json'), 'w') as f:
        json.dump(out, f, indent=2, default=str)
    print('\nSaved I5_raw.json')

if __name__ == '__main__':
    main()
