"""
A4: Ownership-stratified construction analysis.

For V1 and pros across 18 slates, stratify lineups by ownership quartile within each
portfolio (slate). Within each ownership stratum, measure structural characteristics:
  - Mean primary stack size
  - 4-stack vs 5-stack rate
  - Mean salary
  - Mean range (ceiling-floor) — "variance budget"
  - Bring-back rate
  - Pitcher salary share

Question: do V1 contrarian lineups (low-ownership stratum) have the SAME structural
characteristics as pros' contrarian lineups, or are they built like high-ownership
lineups with low-owned players swapped in?

The failure mode this catches: a system might produce correct overall ownership
distribution but build the contrarian band poorly — using high-projection structure
with random low-owned hitters slotted in, rather than constructing genuinely high-
variance lineups.

If V1's bottom-quartile contrarian lineups have similar mean-primary-stack-size and
salary distribution as their TOP-quartile chalk lineups, that's a "swap-in" pattern.
If they shift toward more variance (smaller stacks, different salary patterns), that
matches pro construction.
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

def lineup_features(player_dicts):
    proj = sum(p.get('proj', 0) for p in player_dicts)
    own = statistics.mean(p.get('own', 0) for p in player_dicts) if player_dicts else 0
    salary = sum(p.get('salary', 0) for p in player_dicts)
    ceiling = sum(p.get('ceiling', p.get('proj', 0) * 1.3) for p in player_dicts)
    floor = sum(p.get('floor', p.get('proj', 0) * 0.85) for p in player_dicts)
    range_ = ceiling - floor
    pitcher_sal = sum(p.get('salary', 0) for p in player_dicts if 'P' in p.get('position', ''))
    pitcher_sal_share = pitcher_sal / salary if salary > 0 else 0
    teams = defaultdict(int)
    for p in player_dicts:
        if 'P' in p.get('position', ''):
            continue
        if p.get('team'):
            teams[p['team']] += 1
    primary_size = max(teams.values()) if teams else 0
    primary_team = max(teams, key=teams.get) if teams else None
    primary_opp = None
    if primary_team:
        for p in player_dicts:
            if p.get('team') == primary_team and 'P' not in p.get('position', ''):
                primary_opp = p.get('opp')
                if primary_opp:
                    break
    bring_back = teams.get(primary_opp, 0) if primary_opp else 0
    return {
        'proj': proj, 'own': own, 'salary': salary, 'range': range_,
        'primary_size': primary_size, 'bring_back': bring_back,
        'pitcher_sal_share': pitcher_sal_share,
    }

def main():
    print('Loading all_systems_lineups.json...')
    with open(os.path.join(DATA, 'theory_dfs_structural', 'all_systems_lineups.json'), encoding='utf-8') as f:
        all_systems = json.load(f)
    systems_by_slate = defaultdict(dict)
    for entry in all_systems:
        systems_by_slate[entry['slate']][entry['system']] = entry

    # Per source per slate: list of lineup feature dicts.
    portfolios = defaultdict(list)  # (source, slate) -> [features...]

    for slate_id, proj_file, actuals_file in SLATES:
        proj_path = os.path.join(DATA, proj_file)
        act_path = os.path.join(DATA, actuals_file)
        if not all(os.path.exists(p) for p in [proj_path, act_path]):
            continue

        # Load projections.
        name_to_p = {}
        id_to_p = {}
        with open(proj_path, encoding='utf-8-sig') as f:
            reader = csv.DictReader(f)
            for row in reader:
                pid = row.get('DFS ID', '')
                name = row.get('Name', '')
                try:
                    proj = float(row.get('My Proj') or 0) or 0
                    own = float(row.get('Adj Own') or 0) or 0
                    salary = float(row.get('Salary') or 0) or 0
                    ceiling = float(row.get('dk_85_percentile') or 0) or proj * 1.3
                    floor = float(row.get('dk_25_percentile') or 0) or proj * 0.85
                except (ValueError, TypeError):
                    continue
                pdat = {'id': pid, 'name': name, 'proj': proj, 'own': own, 'salary': salary,
                        'team': (row.get('Team') or '').upper(), 'opp': (row.get('Opp') or '').upper(),
                        'position': (row.get('Pos') or '').upper(), 'ceiling': ceiling, 'floor': floor}
                if name: name_to_p[norm(name)] = pdat
                if pid: id_to_p[pid] = pdat

        # Pro lineups by username (aggregate across 7 pros, treat as one source).
        pro_features = []
        with open(act_path, encoding='utf-8-sig') as f:
            reader = csv.DictReader(f)
            for row in reader:
                user = extract_username(row.get('EntryName') or '')
                if user not in PROS:
                    continue
                names = parse_lineup_string(row.get('Lineup', ''))
                if len(names) != 10: continue
                pls = [name_to_p.get(norm(nm)) for nm in names]
                if any(p is None for p in pls): continue
                pro_features.append(lineup_features(pls))
        portfolios[('pros', slate_id)] = pro_features

        # V1 lineups.
        v1_data = systems_by_slate[slate_id].get('theory-dfs-mlb')
        if v1_data:
            v1_features = []
            for sys_lu in v1_data['lineups']:
                pids = sys_lu.get('pids', [])
                pls = [id_to_p.get(pid) for pid in pids]
                if any(p is None for p in pls): continue
                v1_features.append(lineup_features(pls))
            portfolios[('v1', slate_id)] = v1_features

    # Stratify per (source, slate) by ownership quartile.
    # Compute structural metrics per quartile.
    quartile_stats = defaultdict(lambda: defaultdict(list))  # source -> quartile -> [features...]
    for (source, slate), features in portfolios.items():
        if len(features) < 30: continue
        sorted_by_own = sorted(features, key=lambda f: f['own'])
        n = len(sorted_by_own)
        q1 = sorted_by_own[:n//4]              # bottom 25% (lowest ownership = most contrarian)
        q4 = sorted_by_own[3*n//4:]            # top 25% (highest ownership = most chalk)
        for f in q1:
            for k, v in f.items():
                quartile_stats[source]['q1'][k].append(v) if False else quartile_stats[source][f'q1_{k}'].append(v)
        for f in q4:
            for k, v in f.items():
                quartile_stats[source][f'q4_{k}'].append(v)

    print('\nA4 — Ownership-stratified construction')
    print('=' * 95)
    print('Q1 = bottom-25% ownership (most contrarian); Q4 = top-25% ownership (most chalk)')
    print()
    print(f"{'Metric':<25s} | {'V1 Q1':>8s} | {'Pros Q1':>8s} | {'V1 Q4':>8s} | {'Pros Q4':>8s} | {'V1 Q4-Q1':>9s} | {'Pros Q4-Q1':>10s}")
    print('-' * 95)
    metrics = ['proj', 'own', 'salary', 'range', 'primary_size', 'bring_back', 'pitcher_sal_share']
    for m in metrics:
        v1_q1 = statistics.mean(quartile_stats['v1'][f'q1_{m}']) if quartile_stats['v1'][f'q1_{m}'] else 0
        pro_q1 = statistics.mean(quartile_stats['pros'][f'q1_{m}']) if quartile_stats['pros'][f'q1_{m}'] else 0
        v1_q4 = statistics.mean(quartile_stats['v1'][f'q4_{m}']) if quartile_stats['v1'][f'q4_{m}'] else 0
        pro_q4 = statistics.mean(quartile_stats['pros'][f'q4_{m}']) if quartile_stats['pros'][f'q4_{m}'] else 0
        v1_diff = v1_q4 - v1_q1
        pro_diff = pro_q4 - pro_q1
        if m in ('salary', 'range', 'proj'):
            print(f"{m:<25s} | {v1_q1:>8.0f} | {pro_q1:>8.0f} | {v1_q4:>8.0f} | {pro_q4:>8.0f} | {v1_diff:>+9.0f} | {pro_diff:>+10.0f}")
        elif m == 'pitcher_sal_share':
            print(f"{m:<25s} | {v1_q1*100:>7.1f}% | {pro_q1*100:>7.1f}% | {v1_q4*100:>7.1f}% | {pro_q4*100:>7.1f}% | {v1_diff*100:>+8.1f}pp | {pro_diff*100:>+9.1f}pp")
        else:
            print(f"{m:<25s} | {v1_q1:>8.2f} | {pro_q1:>8.2f} | {v1_q4:>8.2f} | {pro_q4:>8.2f} | {v1_diff:>+9.2f} | {pro_diff:>+10.2f}")

    # Specifically compare Q4-Q1 SHIFTS — does V1 shift the same direction/magnitude as pros?
    # If V1's contrarian lineups are "swap-ins" of high-chalk constructions, V1's Q4-Q1 will be
    # near-zero on structural metrics (only own differs). Pros' Q4-Q1 should show meaningful
    # shifts in stack size, salary, range.
    print()
    print('Interpretation: Q4-Q1 magnitude shows how much construction shifts between chalk and contrarian.')
    print('If V1 Q4-Q1 ≈ 0 on structural metrics but pros show meaningful shift, V1 is "swap-in" pattern.')
    print('If V1 Q4-Q1 directionally matches pros, V1 is genuinely band-adaptive.')

    # 4-stack vs 5-stack rate per quartile.
    print('\n4-stack and 5-stack rates per ownership quartile:')
    for source in ('v1', 'pros'):
        for q in ('q1', 'q4'):
            sizes = quartile_stats[source][f'{q}_primary_size']
            if not sizes: continue
            n = len(sizes)
            n4 = sum(1 for s in sizes if s == 4)
            n5 = sum(1 for s in sizes if s == 5)
            print(f'  {source.upper()} {q.upper()}: 4-stack {n4/n*100:.0f}%  5-stack {n5/n*100:.0f}%  (n={n})')

    out = {
        'quartile_stats': {k: {kk: list(vv) for kk, vv in v.items()} for k, v in quartile_stats.items()},
    }
    with open(os.path.join(OUT, 'A4_raw.json'), 'w') as f:
        json.dump(out, f, indent=2, default=str)
    print('\nSaved A4_raw.json')

if __name__ == '__main__':
    main()
