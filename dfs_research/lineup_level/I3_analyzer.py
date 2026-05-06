"""
I3: Conditional player co-occurrence — pro vs field vs V1.

For each slate, find top-N most-frequently used players (by lineup appearance
in pro+field combined). For each ordered pair (A, B): compute P(B in lineup | A in lineup)
for three sources:
  - pros (the 7 pros, ~14K lineups across 18 slates)
  - field (full DK contest entries, ~150K lineups across 18 slates capped at 10K/slate)
  - V1 (Theory-DFS-V1 portfolios, 2700 lineups)

Aggregate findings across slates:
  - Per-pair: pro_lift = P(B|A)_pro - P(B|A)_field. Positive = pros over-pair, negative = under-pair.
  - Per-pair: v1_lift = P(B|A)_v1 - P(B|A)_field. Same interpretation.
  - Per-pair: pro_v1_gap = pro_lift - v1_lift. Where pros pair MORE than V1 does (relative to field) =
    specific pairings V1 misses.

Output: top-50 pairs by |pro_v1_gap|, with both pro and V1 conditional probabilities, plus
the marginal (P(A) and P(B)) so we can interpret.
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
TOP_N = 30  # players per slate
FIELD_CAP = 10000  # cap field lineups per slate

def norm(s):
    return re.sub(r'\s+', ' ', re.sub(r'[^a-z0-9 ]+', ' ', (s or '').lower())).strip()

def extract_username(entry_name):
    return re.sub(r'\s*\([^)]*\)\s*$', '', entry_name or '').strip().lower()

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

def slate_analysis(proj_path, actuals_path, system_lineups_v1):
    """Returns per-slate co-occurrence stats:
      {top_players_ids: [...],
       player_names: {pid: name},
       pro_lineups_count, field_lineups_count, v1_lineups_count,
       p_pro: {pid: P(player in pro lineup)},
       p_field: {...}, p_v1: {...},
       p_pair_pro: {(pidA,pidB): P(both in pro lineup)},
       p_pair_field: {...}, p_pair_v1: {...} }
    """
    # Build name -> id from projections.
    name_to_id = {}
    id_to_name = {}
    with open(proj_path, encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        for row in reader:
            pid = row.get('DFS ID', '')
            name = row.get('Name', '')
            if pid and name:
                name_to_id[norm(name)] = pid
                id_to_name[pid] = name

    # Walk actuals; bucket by source.
    pro_lineups = []  # list of set(pid)
    field_lineups = []
    pro_count = 0
    field_count = 0
    with open(actuals_path, encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        for row in reader:
            user = extract_username(row.get('EntryName') or '')
            names = parse_lineup_string(row.get('Lineup', ''))
            if len(names) != 10:
                continue
            pids = []
            ok = True
            for nm in names:
                pid = name_to_id.get(norm(nm))
                if not pid:
                    ok = False
                    break
                pids.append(pid)
            if not ok:
                continue
            pid_set = frozenset(pids)
            if user in PROS:
                pro_lineups.append(pid_set)
                pro_count += 1
            else:
                if field_count < FIELD_CAP:
                    field_lineups.append(pid_set)
                    field_count += 1

    # V1 lineups for this slate.
    v1_lineups = [frozenset(lu['pids']) for lu in system_lineups_v1]

    # Identify top N players (by combined pro+field+v1 appearances).
    appearance = Counter()
    for src in (pro_lineups, field_lineups, v1_lineups):
        for lu in src:
            for pid in lu:
                appearance[pid] += 1
    top_players = [pid for pid, _ in appearance.most_common(TOP_N)]

    def compute(lineups, top_set):
        n = len(lineups)
        if n == 0:
            return {}, {}
        marginal = {pid: 0 for pid in top_set}
        pair_count = defaultdict(int)
        for lu in lineups:
            present = top_set & lu
            for pid in present:
                marginal[pid] += 1
            present_list = sorted(present)
            for i in range(len(present_list)):
                for j in range(i+1, len(present_list)):
                    pair_count[(present_list[i], present_list[j])] += 1
        p_marginal = {pid: marginal[pid] / n for pid in top_set}
        p_pair = {pair: count / n for pair, count in pair_count.items()}
        return p_marginal, p_pair

    top_set = set(top_players)
    p_pro, p_pair_pro = compute(pro_lineups, top_set)
    p_field, p_pair_field = compute(field_lineups, top_set)
    p_v1, p_pair_v1 = compute(v1_lineups, top_set)

    return {
        'top_players_ids': top_players,
        'id_to_name': id_to_name,
        'pro_n': pro_count, 'field_n': field_count, 'v1_n': len(v1_lineups),
        'p_pro': p_pro, 'p_field': p_field, 'p_v1': p_v1,
        'p_pair_pro': dict(p_pair_pro), 'p_pair_field': dict(p_pair_field), 'p_pair_v1': dict(p_pair_v1),
    }

def main():
    # Load V1 system lineups by slate.
    print('Loading all_systems_lineups.json...')
    with open(os.path.join(DATA, 'theory_dfs_structural', 'all_systems_lineups.json'), encoding='utf-8') as f:
        all_systems = json.load(f)
    v1_by_slate = {}
    for entry in all_systems:
        if entry['system'] == 'theory-dfs-mlb':
            v1_by_slate[entry['slate']] = entry['lineups']

    # Per-slate analysis.
    print('Analyzing slates...')
    per_slate = []
    for slate_id, proj_file, actuals_file in SLATES:
        proj_path = os.path.join(DATA, proj_file)
        act_path = os.path.join(DATA, actuals_file)
        if not all(os.path.exists(p) for p in [proj_path, act_path]):
            continue
        v1_lineups = v1_by_slate.get(slate_id, [])
        if not v1_lineups:
            continue
        stats = slate_analysis(proj_path, act_path, v1_lineups)
        stats['slate'] = slate_id
        per_slate.append(stats)
        print(f'  {slate_id}: pro={stats["pro_n"]} field={stats["field_n"]} v1={stats["v1_n"]} top={len(stats["top_players_ids"])}')

    # Aggregate: for each player pair (across slates), compute conditional probabilities.
    # Per-slate: P(B|A)_pro = P(both in pro lineup) / P(A in pro lineup)
    # Then aggregate by averaging across slates (only slates where both A and B are in top-N AND P(A) > min threshold).
    pair_records = []  # list of dicts with pro_lift, v1_lift, pro_v1_gap, etc.
    pair_aggregator = defaultdict(lambda: {
        'pro_cond': [], 'field_cond': [], 'v1_cond': [],
        'p_a_pro': [], 'p_a_field': [], 'p_a_v1': [],
        'p_b_pro': [], 'p_b_field': [], 'p_b_v1': [],
        'name_a': '', 'name_b': '',
        'slates': [],
    })
    MIN_MARGINAL = 0.05  # only consider players appearing in at least 5% of source's lineups

    for stats in per_slate:
        top = stats['top_players_ids']
        names = stats['id_to_name']
        # Switch to name-based aggregation so same player across slates accumulates.
        for i in range(len(top)):
            a = top[i]
            name_a = norm(names.get(a, a))
            for j in range(len(top)):
                if i == j:
                    continue
                b = top[j]
                name_b = norm(names.get(b, b))
                # Conditional P(B|A) per source.
                pa_pro = stats['p_pro'].get(a, 0)
                pb_pro = stats['p_pro'].get(b, 0)
                pa_field = stats['p_field'].get(a, 0)
                pb_field = stats['p_field'].get(b, 0)
                pa_v1 = stats['p_v1'].get(a, 0)
                pb_v1 = stats['p_v1'].get(b, 0)
                # Pair lookup uses sorted ids.
                key = tuple(sorted([a, b]))
                p_ab_pro = stats['p_pair_pro'].get(key, 0)
                p_ab_field = stats['p_pair_field'].get(key, 0)
                p_ab_v1 = stats['p_pair_v1'].get(key, 0)
                if pa_pro < MIN_MARGINAL or pa_field < MIN_MARGINAL:
                    continue
                cond_pro = p_ab_pro / pa_pro if pa_pro > 0 else 0
                cond_field = p_ab_field / pa_field if pa_field > 0 else 0
                cond_v1 = p_ab_v1 / pa_v1 if pa_v1 > 0 else 0
                # Aggregate by NAME (works across slates with different player IDs).
                pa_rec = pair_aggregator[(name_a, name_b)]
                pa_rec['pro_cond'].append(cond_pro)
                pa_rec['field_cond'].append(cond_field)
                pa_rec['v1_cond'].append(cond_v1)
                pa_rec['p_a_pro'].append(pa_pro)
                pa_rec['p_a_field'].append(pa_field)
                pa_rec['p_a_v1'].append(pa_v1)
                pa_rec['p_b_pro'].append(pb_pro)
                pa_rec['p_b_field'].append(pb_field)
                pa_rec['p_b_v1'].append(pb_v1)
                pa_rec['name_a'] = names.get(a, a)
                pa_rec['name_b'] = names.get(b, b)
                pa_rec['slates'].append(stats['slate'])

    # Aggregate per pair.
    final = []
    for (a, b), rec in pair_aggregator.items():
        if len(rec['pro_cond']) < 2:
            continue  # require at least 2 slates (rosters change daily, hard to get more)
        pro_avg = statistics.mean(rec['pro_cond'])
        field_avg = statistics.mean(rec['field_cond'])
        v1_avg = statistics.mean(rec['v1_cond'])
        pro_lift = pro_avg - field_avg
        v1_lift = v1_avg - field_avg
        pro_v1_gap = pro_lift - v1_lift
        final.append({
            'a_name': rec['name_a'], 'b_name': rec['name_b'],
            'pro_cond': pro_avg, 'field_cond': field_avg, 'v1_cond': v1_avg,
            'pro_lift': pro_lift, 'v1_lift': v1_lift, 'pro_v1_gap': pro_v1_gap,
            'p_a_pro_avg': statistics.mean(rec['p_a_pro']),
            'p_a_field_avg': statistics.mean(rec['p_a_field']),
            'n_slates': len(rec['pro_cond']),
        })

    # Sort by pro_v1_gap (positive = pros pair MORE than V1 does relative to field).
    final.sort(key=lambda r: -r['pro_v1_gap'])

    # Save.
    print(f'\nFound {len(final)} pairs with >= 3 slates of data')
    print('\nTop 30 pairs where pros pair MORE than V1 (positive pro-v1 gap):')
    print(f"{'A name':<22s} | {'B name':<22s} | {'pro c|':>6s} | {'field':>6s} | {'v1 c|':>6s} | {'pro lift':>8s} | {'v1 lift':>7s} | {'gap':>6s} | n")
    for r in final[:30]:
        print(f"{r['a_name'][:22]:<22s} | {r['b_name'][:22]:<22s} | {r['pro_cond']:>6.2f} | {r['field_cond']:>6.2f} | {r['v1_cond']:>6.2f} | {r['pro_lift']:>+7.2f} | {r['v1_lift']:>+6.2f} | {r['pro_v1_gap']:>+5.2f} | {r['n_slates']}")

    print('\nTop 30 pairs where pros pair LESS than V1 (negative pro-v1 gap):')
    print(f"{'A name':<22s} | {'B name':<22s} | {'pro c|':>6s} | {'field':>6s} | {'v1 c|':>6s} | {'pro lift':>8s} | {'v1 lift':>7s} | {'gap':>6s} | n")
    for r in final[-30:]:
        print(f"{r['a_name'][:22]:<22s} | {r['b_name'][:22]:<22s} | {r['pro_cond']:>6.2f} | {r['field_cond']:>6.2f} | {r['v1_cond']:>6.2f} | {r['pro_lift']:>+7.2f} | {r['v1_lift']:>+6.2f} | {r['pro_v1_gap']:>+5.2f} | {r['n_slates']}")

    # Aggregate stats.
    pos_count = sum(1 for r in final if r['pro_v1_gap'] > 0.05)
    neg_count = sum(1 for r in final if r['pro_v1_gap'] < -0.05)
    print(f'\nDirectional summary (across {len(final)} pairs):')
    print(f'  Pros pair MORE than V1 (gap > +5pp): {pos_count}')
    print(f'  Pros pair LESS than V1 (gap < -5pp): {neg_count}')
    print(f'  Mean |gap|: {statistics.mean(abs(r["pro_v1_gap"]) for r in final):.3f}')
    print(f'  Mean pro_lift: {statistics.mean(r["pro_lift"] for r in final):+.3f}')
    print(f'  Mean v1_lift: {statistics.mean(r["v1_lift"] for r in final):+.3f}')

    out = {
        'pair_count': len(final),
        'top_30_pros_pair_more': final[:30],
        'top_30_pros_pair_less': final[-30:],
        'all_pairs': final,
    }
    with open(os.path.join(OUT, 'I3_raw.json'), 'w') as f:
        json.dump(out, f, indent=2, default=str)
    print(f'\nSaved I3_raw.json')

if __name__ == '__main__':
    main()
