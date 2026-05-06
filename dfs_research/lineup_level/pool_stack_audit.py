"""
Diagnostic: what's the stack-size distribution of the SaberSim candidate pool itself?
If pool is 95% 5-stacks, V1 has no 4-stacks to select even with STACK_BONUS=0.
"""
import csv
import os
import sys
import re
from collections import defaultdict, Counter

sys.stdout.reconfigure(encoding='utf-8')

DATA = r'C:\Users\colin\dfs opto'
SLATES = [
    ('4-8-26', '4-8-26projections.csv', '4-8-26sspool.csv'),
    ('4-12-26', '4-12-26projections.csv', '4-12-26sspool.csv'),
    ('4-17-26', '4-17-26projections.csv', '4-17-26sspool.csv'),
    ('4-22-26', '4-22-26projections.csv', '4-22-26sspool.csv'),
    ('4-25-26', '4-25-26projections.csv', '4-25-26sspool.csv'),
    ('4-27-26', '4-27-26projections.csv', '4-27-26sspool.csv'),
    ('4-28-26', '4-28-26projections.csv', '4-28-26sspool.csv'),
    ('5-3-26', '5-3-26projections.csv', '5-3-26sspool.csv'),
]


def norm(s): return re.sub(r'\s+', ' ', re.sub(r'[^a-z0-9 ]+', ' ', (s or '').lower())).strip()


def parse_pool_lineup_ids(row_values, id_to_team):
    """SaberSim pool format: first 10 columns are P,P,C,1B,2B,3B,SS,OF,OF,OF (DFS IDs).
    Skip columns 0,1 (pitchers); use 2-9 (hitters)."""
    teams = []
    for i in range(2, 10):
        if i >= len(row_values): break
        pid = row_values[i].strip()
        if pid and pid in id_to_team:
            teams.append(id_to_team[pid])
    return teams


def primary_stack(teams):
    if not teams: return 0
    counts = Counter(teams)
    return max(counts.values())


def main():
    print(f"{'Slate':<14} | {'pool n':<7} | {'5+stk%':<7} | {'4-stk%':<7} | {'3-stk%':<7} | {'<3%':<5}")
    print('-' * 60)
    overall = Counter()
    overall_n = 0
    for slate, proj_f, pool_f in SLATES:
        proj_path = os.path.join(DATA, proj_f)
        pool_path = os.path.join(DATA, pool_f)
        if not (os.path.exists(proj_path) and os.path.exists(pool_path)):
            print(f'{slate}: skip (missing files)')
            continue
        # Build DFS ID -> team
        id_to_team = {}
        with open(proj_path, encoding='utf-8-sig') as f:
            r = csv.DictReader(f)
            for row in r:
                pid = (row.get('DFS ID') or '').strip()
                team = (row.get('Team') or '').upper()
                if pid: id_to_team[pid] = team
        # Walk pool — use raw csv reader since pool has duplicate column names
        sizes = Counter()
        with open(pool_path, encoding='utf-8-sig') as f:
            reader = csv.reader(f)
            header = next(reader, None)
            for row in reader:
                if len(row) < 10: continue
                teams = parse_pool_lineup_ids(row, id_to_team)
                if not teams: continue
                ps = primary_stack(teams)
                if ps >= 5: sizes['5+'] += 1
                elif ps == 4: sizes['4'] += 1
                elif ps == 3: sizes['3'] += 1
                else: sizes['<3'] += 1
        n = sum(sizes.values())
        if n == 0:
            print(f'{slate}: 0 lineups parsed')
            continue
        for k, v in sizes.items():
            overall[k] += v
        overall_n += n
        print(f'{slate:<14} | {n:<7} | {sizes["5+"]/n*100:>5.1f}% | {sizes["4"]/n*100:>5.1f}% | {sizes["3"]/n*100:>5.1f}% | {sizes["<3"]/n*100:>4.1f}%')

    print('-' * 60)
    if overall_n > 0:
        print(f'{"AGGREGATE":<14} | {overall_n:<7} | {overall["5+"]/overall_n*100:>5.1f}% | {overall["4"]/overall_n*100:>5.1f}% | {overall["3"]/overall_n*100:>5.1f}% | {overall["<3"]/overall_n*100:>4.1f}%')


if __name__ == '__main__':
    main()
