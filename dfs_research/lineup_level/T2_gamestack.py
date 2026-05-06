"""
T2: Game stack rate analysis.

For each slate, what fraction of V1 lineups vs pro lineups use:
  - 2+ players from the same game (game-stack 2+)
  - 3+ players from the same game (game-stack 3+)
  - 4+ players from the same game (game-stack 4+)

Question: do pros vary game-stack rate by slate context (chalk-heavy vs wide-open)
while V1 stays flat? That's a slate-adaptation gap.
"""
import json
import sys
import statistics
from collections import defaultdict

sys.stdout.reconfigure(encoding='utf-8')

DUMP = r'C:\Users\colin\dfs opto\theory_dfs_v2\v1_pros_lineup_dump.json'
OUT = r'C:\Users\colin\dfs opto\lineup_level\T2_gamestack.md'


def main():
    with open(DUMP, 'r', encoding='utf-8') as f:
        data = json.load(f)

    print('T2 — Game stack rate analysis')
    print('=' * 70)
    rows = []
    aggV1 = {2: 0, 3: 0, 4: 0, 'n': 0}
    aggPros = {2: 0, 3: 0, 4: 0, 'n': 0}
    for slate in data:
        v1s = slate['v1']
        pros = slate['pros']
        if not v1s or not pros:
            continue

        def gs(lus, k):
            if not lus: return 0
            return sum(1 for lu in lus if (lu.get('maxGameStack') or 0) >= k) / len(lus)

        v1_2 = gs(v1s, 2); v1_3 = gs(v1s, 3); v1_4 = gs(v1s, 4)
        pro_2 = gs(pros, 2); pro_3 = gs(pros, 3); pro_4 = gs(pros, 4)

        for k, vv, pv in [(2, v1_2, pro_2), (3, v1_3, pro_3), (4, v1_4, pro_4)]:
            aggV1[k] += vv * len(v1s)
            aggPros[k] += pv * len(pros)
        aggV1['n'] += len(v1s)
        aggPros['n'] += len(pros)

        # Slate context: chalk anchor (max ownership of primary stack across pros)
        chalk_anchor = 0
        if pros:
            stack_owns = []
            for pro in pros:
                if pro.get('primarySize', 0) >= 4:
                    stack_owns.append(pro.get('geoMeanOwnHit') or 0)
            chalk_anchor = max(stack_owns) if stack_owns else 0

        rows.append({
            'slate': slate['slate'],
            'numTeams': slate.get('numTeams') or 0,
            'n_v1': len(v1s), 'n_pros': len(pros),
            'v1_2': v1_2, 'v1_3': v1_3, 'v1_4': v1_4,
            'pro_2': pro_2, 'pro_3': pro_3, 'pro_4': pro_4,
            'gap_2': v1_2 - pro_2, 'gap_3': v1_3 - pro_3, 'gap_4': v1_4 - pro_4,
            'chalk_anchor': chalk_anchor,
        })

    # Aggregate
    print(f'\nAggregate game-stack rates (across 23 slates):')
    print(f"{'k+':<5s} | {'V1 %':>6s} | {'Pros %':>7s} | {'gap':>6s}")
    for k in (2, 3, 4):
        v_pct = aggV1[k] / aggV1['n'] * 100 if aggV1['n'] else 0
        p_pct = aggPros[k] / aggPros['n'] * 100 if aggPros['n'] else 0
        print(f"  {k}+   | {v_pct:>5.1f}% | {p_pct:>6.1f}% | {(v_pct - p_pct):>+5.1f}pp")

    # Per-slate variance: do pros vary their game-stack rate slate-to-slate?
    pro_2_per_slate = [r['pro_2'] for r in rows]
    v1_2_per_slate = [r['v1_2'] for r in rows]
    print(f'\nGame-stack-2+ rate variance across slates:')
    print(f'  Pros:  mean={statistics.mean(pro_2_per_slate)*100:.1f}% std={statistics.pstdev(pro_2_per_slate)*100:.1f}pp range=[{min(pro_2_per_slate)*100:.1f}%, {max(pro_2_per_slate)*100:.1f}%]')
    print(f'  V1:    mean={statistics.mean(v1_2_per_slate)*100:.1f}% std={statistics.pstdev(v1_2_per_slate)*100:.1f}pp range=[{min(v1_2_per_slate)*100:.1f}%, {max(v1_2_per_slate)*100:.1f}%]')

    pro_3_per_slate = [r['pro_3'] for r in rows]
    v1_3_per_slate = [r['v1_3'] for r in rows]
    print(f'\nGame-stack-3+ rate variance across slates:')
    print(f'  Pros:  mean={statistics.mean(pro_3_per_slate)*100:.1f}% std={statistics.pstdev(pro_3_per_slate)*100:.1f}pp range=[{min(pro_3_per_slate)*100:.1f}%, {max(pro_3_per_slate)*100:.1f}%]')
    print(f'  V1:    mean={statistics.mean(v1_3_per_slate)*100:.1f}% std={statistics.pstdev(v1_3_per_slate)*100:.1f}pp range=[{min(v1_3_per_slate)*100:.1f}%, {max(v1_3_per_slate)*100:.1f}%]')

    # Per-slate breakdown
    print(f'\nPer-slate breakdown (game-stack 2+ rate):')
    print(f"{'Slate':<14s} | teams | V1 2+%  | Pro 2+% | gap 2+ | V1 3+%  | Pro 3+% | gap 3+")
    for r in rows:
        print(f"  {r['slate']:<14s} | {r['numTeams']:>3d}   | {r['v1_2']*100:>6.1f}% | {r['pro_2']*100:>6.1f}% | {r['gap_2']*100:>+5.1f}pp | {r['v1_3']*100:>6.1f}% | {r['pro_3']*100:>6.1f}% | {r['gap_3']*100:>+5.1f}pp")

    # Save markdown
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write('# T2 — Game stack rate analysis\n\n')
        f.write('## Aggregate rates\n\n')
        f.write('| k+ | V1 % | Pros % | gap |\n|---|---|---|---|\n')
        for k in (2, 3, 4):
            v_pct = aggV1[k] / aggV1['n'] * 100 if aggV1['n'] else 0
            p_pct = aggPros[k] / aggPros['n'] * 100 if aggPros['n'] else 0
            f.write(f'| {k}+ | {v_pct:.1f}% | {p_pct:.1f}% | {(v_pct - p_pct):+.1f}pp |\n')
        f.write('\n## Slate-to-slate variance\n\n')
        f.write('| Group | mean | std | min | max |\n|---|---|---|---|---|\n')
        f.write(f'| Pro game-stack 2+ | {statistics.mean(pro_2_per_slate)*100:.1f}% | {statistics.pstdev(pro_2_per_slate)*100:.1f}pp | {min(pro_2_per_slate)*100:.1f}% | {max(pro_2_per_slate)*100:.1f}% |\n')
        f.write(f'| V1 game-stack 2+  | {statistics.mean(v1_2_per_slate)*100:.1f}% | {statistics.pstdev(v1_2_per_slate)*100:.1f}pp | {min(v1_2_per_slate)*100:.1f}% | {max(v1_2_per_slate)*100:.1f}% |\n')
        f.write(f'| Pro game-stack 3+ | {statistics.mean(pro_3_per_slate)*100:.1f}% | {statistics.pstdev(pro_3_per_slate)*100:.1f}pp | {min(pro_3_per_slate)*100:.1f}% | {max(pro_3_per_slate)*100:.1f}% |\n')
        f.write(f'| V1 game-stack 3+  | {statistics.mean(v1_3_per_slate)*100:.1f}% | {statistics.pstdev(v1_3_per_slate)*100:.1f}pp | {min(v1_3_per_slate)*100:.1f}% | {max(v1_3_per_slate)*100:.1f}% |\n')

        f.write('\n## Per-slate detail\n\n')
        f.write('| Slate | teams | V1 2+ | Pro 2+ | gap 2+ | V1 3+ | Pro 3+ | gap 3+ | V1 4+ | Pro 4+ |\n')
        f.write('|---|---|---|---|---|---|---|---|---|---|\n')
        for r in rows:
            f.write(f'| {r["slate"]} | {r["numTeams"]} | {r["v1_2"]*100:.1f}% | {r["pro_2"]*100:.1f}% | {r["gap_2"]*100:+.1f}pp | {r["v1_3"]*100:.1f}% | {r["pro_3"]*100:.1f}% | {r["gap_3"]*100:+.1f}pp | {r["v1_4"]*100:.1f}% | {r["pro_4"]*100:.1f}% |\n')

    print(f'\nSaved to {OUT}')


if __name__ == '__main__':
    main()
