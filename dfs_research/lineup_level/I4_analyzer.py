"""
I4: Within-pro lineup variance.

For each pro × slate combination (e.g., nerdytenor's 150 lineups on 4-22-26),
compute within-portfolio variance on key features:
  - lineup projection (sum)
  - lineup ownership (avg)
  - primary stack team identity (entropy / mode-share)
  - primary stack composition (Jaccard similarity between any two of pro's lineups)
  - primary stack size

Hypothesis (from I3): pros have LOW within-portfolio variance on stack composition.
They use the SAME stack core repeatedly. V1 cycles through different combinations.

If true:
  - Pro mode-share (% of pro's lineups using the most-frequent primary stack team) should be high (e.g., 60-80%).
  - Pro Jaccard similarity within stack = high (same 4-5 players appear in 60%+ of pro stacks).
  - V1 Jaccard similarity within stack = low (different player combinations each lineup).

Computes per (pro, slate) and (system, slate) summary stats, aggregates across slates.
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

def lineup_signature(player_dicts):
    """Returns (proj_sum, own_avg, primary_stack_team, primary_stack_size, frozenset(primary_stack_pids))"""
    proj = sum(p.get('proj', 0) for p in player_dicts)
    own = statistics.mean(p.get('own', 0) for p in player_dicts) if player_dicts else 0
    team_pids = defaultdict(list)
    for p in player_dicts:
        if 'P' in p.get('position', ''):
            continue
        t = p.get('team', '')
        if t:
            team_pids[t].append(p.get('id', p.get('name', '')))
    if not team_pids:
        return proj, own, '', 0, frozenset()
    primary_team = max(team_pids, key=lambda t: len(team_pids[t]))
    primary_pids = frozenset(team_pids[primary_team])
    return proj, own, primary_team, len(primary_pids), primary_pids

def jaccard(a, b):
    if not a and not b: return 1.0
    if not a or not b: return 0.0
    return len(a & b) / len(a | b)

def avg_pairwise_jaccard(stack_sets):
    """Mean Jaccard similarity across all pairs of stack-sets."""
    n = len(stack_sets)
    if n < 2:
        return 1.0
    total = 0
    count = 0
    # Sample pairs if n is large (cap at 1000 pairs).
    import itertools
    pairs = list(itertools.combinations(range(n), 2))
    if len(pairs) > 1000:
        import random
        random.Random(42).shuffle(pairs)
        pairs = pairs[:1000]
    for i, j in pairs:
        total += jaccard(stack_sets[i], stack_sets[j])
        count += 1
    return total / count if count else 1.0

def main():
    print('Loading all_systems_lineups.json...')
    with open(os.path.join(DATA, 'theory_dfs_structural', 'all_systems_lineups.json'), encoding='utf-8') as f:
        all_systems = json.load(f)

    systems_by_slate = defaultdict(dict)
    for entry in all_systems:
        systems_by_slate[entry['slate']][entry['system']] = entry

    # Collect per (source, slate) lineup signatures.
    # source = pro username OR system name
    # signatures: list of (proj, own, primary_team, primary_stack_size, primary_stack_pids)
    portfolio_data = defaultdict(list)  # (source, slate) -> list of signatures

    print('Processing slates...')
    for slate_id, proj_file, actuals_file in SLATES:
        proj_path = os.path.join(DATA, proj_file)
        act_path = os.path.join(DATA, actuals_file)
        if not all(os.path.exists(p) for p in [proj_path, act_path]):
            continue

        # Build name -> player dict, id -> player dict.
        name_to_player = {}
        id_to_player = {}
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
                        'team': team, 'position': pos}
                if name:
                    name_to_player[norm(name)] = pdat
                if pid:
                    id_to_player[pid] = pdat

        # Pro lineups by username.
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
                    p = name_to_player.get(norm(nm))
                    if not p:
                        ok = False
                        break
                    player_dicts.append(p)
                if not ok:
                    continue
                sig = lineup_signature(player_dicts)
                portfolio_data[(user, slate_id)].append(sig)

        # System lineups.
        for system_name in ['theory-dfs-mlb', 'hermes-a', 'theory-dfs-mlb-hcombo', 'random-mlb']:
            sys_data = systems_by_slate[slate_id].get(system_name)
            if not sys_data:
                continue
            for sys_lu in sys_data['lineups']:
                pids = sys_lu.get('pids', [])
                player_dicts = [id_to_player.get(pid) for pid in pids]
                if any(p is None for p in player_dicts):
                    continue
                sig = lineup_signature(player_dicts)
                portfolio_data[(system_name, slate_id)].append(sig)

    # Per (source, slate), compute variance metrics.
    print(f'\n{len(portfolio_data)} (source, slate) portfolios collected.')

    summary_per_source = defaultdict(list)  # source -> list of per-slate dicts
    for (source, slate), sigs in portfolio_data.items():
        if len(sigs) < 30:
            continue
        projs = [s[0] for s in sigs]
        owns = [s[1] for s in sigs]
        teams = [s[2] for s in sigs]
        stack_sizes = [s[3] for s in sigs]
        stack_pids = [s[4] for s in sigs]
        proj_std = statistics.stdev(projs) if len(projs) > 1 else 0
        own_std = statistics.stdev(owns) if len(owns) > 1 else 0
        size_std = statistics.stdev(stack_sizes) if len(stack_sizes) > 1 else 0
        team_counter = Counter(teams)
        unique_teams = len([t for t in team_counter if t])
        mode_team_share = team_counter.most_common(1)[0][1] / len(teams) if teams else 0
        # Within-team Jaccard: among lineups using mode team, how similar are stack pids?
        mode_team = team_counter.most_common(1)[0][0] if team_counter else ''
        mode_team_stacks = [stack_pids[i] for i in range(len(sigs)) if teams[i] == mode_team]
        mode_team_jaccard = avg_pairwise_jaccard(mode_team_stacks)
        # All-lineup pairwise stack Jaccard (regardless of team) — measures overall stack diversity.
        overall_jaccard = avg_pairwise_jaccard(stack_pids)
        rec = {
            'slate': slate, 'n_lineups': len(sigs),
            'proj_std': proj_std, 'own_std': own_std, 'size_std': size_std,
            'unique_teams': unique_teams, 'mode_team_share': mode_team_share,
            'mode_team': mode_team, 'mode_team_jaccard': mode_team_jaccard,
            'overall_jaccard': overall_jaccard,
        }
        summary_per_source[source].append(rec)

    # Aggregate per source.
    print('\n' + '=' * 100)
    print('I4 RESULTS — Within-portfolio variance by source')
    print('=' * 100)
    print(f"\n{'Source':<25s} | {'proj_std':>8s} | {'own_std':>7s} | {'unique_teams':>12s} | {'mode_share':>10s} | {'mode_jacc':>9s} | {'overall_jacc':>12s} | n_slates")
    print('-' * 110)

    aggregated = {}
    for source, recs in sorted(summary_per_source.items()):
        if len(recs) < 3:
            continue
        agg = {
            'proj_std_mean': statistics.mean(r['proj_std'] for r in recs),
            'own_std_mean': statistics.mean(r['own_std'] for r in recs),
            'unique_teams_mean': statistics.mean(r['unique_teams'] for r in recs),
            'mode_team_share_mean': statistics.mean(r['mode_team_share'] for r in recs),
            'mode_team_jaccard_mean': statistics.mean(r['mode_team_jaccard'] for r in recs),
            'overall_jaccard_mean': statistics.mean(r['overall_jaccard'] for r in recs),
            'n_slates': len(recs),
        }
        aggregated[source] = agg
        print(f"{source:<25s} | {agg['proj_std_mean']:>8.2f} | {agg['own_std_mean']:>7.2f} | {agg['unique_teams_mean']:>11.1f}  | {agg['mode_team_share_mean']*100:>9.0f}% | {agg['mode_team_jaccard_mean']:>9.3f} | {agg['overall_jaccard_mean']:>12.3f} | {agg['n_slates']}")

    # Direct comparison: pros aggregate vs systems.
    pro_keys = [k for k in aggregated if k in PROS]
    pros_combined = {
        'proj_std_mean': statistics.mean(aggregated[k]['proj_std_mean'] for k in pro_keys) if pro_keys else 0,
        'own_std_mean': statistics.mean(aggregated[k]['own_std_mean'] for k in pro_keys) if pro_keys else 0,
        'unique_teams_mean': statistics.mean(aggregated[k]['unique_teams_mean'] for k in pro_keys) if pro_keys else 0,
        'mode_team_share_mean': statistics.mean(aggregated[k]['mode_team_share_mean'] for k in pro_keys) if pro_keys else 0,
        'mode_team_jaccard_mean': statistics.mean(aggregated[k]['mode_team_jaccard_mean'] for k in pro_keys) if pro_keys else 0,
        'overall_jaccard_mean': statistics.mean(aggregated[k]['overall_jaccard_mean'] for k in pro_keys) if pro_keys else 0,
    }
    print(f"\nPROS combined (mean of {len(pro_keys)} pros):")
    print(f"  proj_std_mean = {pros_combined['proj_std_mean']:.2f}")
    print(f"  own_std_mean = {pros_combined['own_std_mean']:.2f}")
    print(f"  unique_teams_mean = {pros_combined['unique_teams_mean']:.1f}")
    print(f"  mode_team_share_mean = {pros_combined['mode_team_share_mean']*100:.0f}%")
    print(f"  mode_team_jaccard_mean = {pros_combined['mode_team_jaccard_mean']:.3f}")
    print(f"  overall_jaccard_mean = {pros_combined['overall_jaccard_mean']:.3f}")

    print('\nKey comparison (pros vs systems):')
    for sys_name in ['theory-dfs-mlb', 'hermes-a', 'theory-dfs-mlb-hcombo', 'random-mlb']:
        if sys_name not in aggregated:
            continue
        a = aggregated[sys_name]
        gap_unique_teams = a['unique_teams_mean'] - pros_combined['unique_teams_mean']
        gap_mode_share = a['mode_team_share_mean'] - pros_combined['mode_team_share_mean']
        gap_mode_jacc = a['mode_team_jaccard_mean'] - pros_combined['mode_team_jaccard_mean']
        print(f"  {sys_name:<25s} | unique_teams: {a['unique_teams_mean']:>4.1f} (vs pros {pros_combined['unique_teams_mean']:>4.1f}, diff {gap_unique_teams:+.1f})  | mode_share: {a['mode_team_share_mean']*100:>3.0f}% (vs {pros_combined['mode_team_share_mean']*100:>3.0f}%, diff {gap_mode_share*100:+.0f}pp)  | mode_jaccard: {a['mode_team_jaccard_mean']:.3f} (vs {pros_combined['mode_team_jaccard_mean']:.3f}, diff {gap_mode_jacc:+.3f})")

    # Save.
    out = {'pros_combined': pros_combined, 'aggregated': aggregated}
    with open(os.path.join(OUT, 'I4_raw.json'), 'w') as f:
        json.dump(out, f, indent=2, default=str)
    print('\nSaved I4_raw.json')

if __name__ == '__main__':
    main()
