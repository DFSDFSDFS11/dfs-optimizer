"""
T5: Worst-V1-lineup forensics across 23 slates.

For each slate, identify V1's worst-finishing lineups (bottom 20% by finishPct).
Aggregate their structural features. Compare to V1's best lineups (top 20%).

Question: do V1's worst lineups share recurring features that mark structural
failure modes? If so, those features are V1's blind spots.
"""
import json
import sys
import statistics
from collections import defaultdict, Counter

sys.stdout.reconfigure(encoding='utf-8')

DUMP = r'C:\Users\colin\dfs opto\theory_dfs_v2\v1_pros_lineup_dump.json'
OUT = r'C:\Users\colin\dfs opto\lineup_level\T5_worst_v1_forensics.md'

NUMERIC_FEATURES = ['primarySize', 'secondarySize', 'bringBack', 'maxGameStack',
                    'numGames', 'numTeamsUsed', 'geoMeanOwnHit', 'salaryStd',
                    'salaryTopThree', 'projection', 'salaryTotal']


def feature_stats(lus, key):
    vals = [lu.get(key) or 0 for lu in lus]
    if not vals: return (0, 0)
    return statistics.mean(vals), statistics.pstdev(vals) if len(vals) > 1 else 0


def main():
    with open(DUMP, 'r', encoding='utf-8') as f:
        data = json.load(f)

    print('T5 — Worst V1 lineup forensics')
    print('=' * 70)

    worst_all = []
    best_all = []
    pitcher_in_worst = Counter()
    pitcher_in_best = Counter()
    primary_team_worst = Counter()
    primary_team_best = Counter()
    archetype_worst = Counter()
    archetype_best = Counter()
    failure_examples = []

    for slate in data:
        v1s = [lu for lu in slate['v1'] if lu.get('finishPct') is not None]
        if len(v1s) < 10:
            continue
        v1s_sorted = sorted(v1s, key=lambda x: x['finishPct'])  # worst first
        n = len(v1s_sorted)
        worst_n = max(1, int(n * 0.20))
        best_n = max(1, int(n * 0.20))
        worst = v1s_sorted[:worst_n]
        best = v1s_sorted[-best_n:]

        worst_all.extend(worst)
        best_all.extend(best)

        # Pitcher attribution
        for lu in worst:
            for nm in (lu.get('pitcherNames') or []):
                pitcher_in_worst[nm] += 1
        for lu in best:
            for nm in (lu.get('pitcherNames') or []):
                pitcher_in_best[nm] += 1

        # Primary team attribution
        for lu in worst:
            primary_team_worst[lu.get('primaryTeam') or '?'] += 1
        for lu in best:
            primary_team_best[lu.get('primaryTeam') or '?'] += 1

        # Archetype = (primarySize, bringBack)
        for lu in worst:
            arch = f"{lu.get('primarySize') or 0}-stack/BB{lu.get('bringBack') or 0}"
            archetype_worst[arch] += 1
        for lu in best:
            arch = f"{lu.get('primarySize') or 0}-stack/BB{lu.get('bringBack') or 0}"
            archetype_best[arch] += 1

        # Capture worst lineup per slate as a forensic example
        worst_lu = worst[0]
        failure_examples.append({
            'slate': slate['slate'],
            'finishPct': worst_lu['finishPct'],
            'projection': worst_lu['projection'],
            'actual': worst_lu.get('actual'),
            'primaryTeam': worst_lu.get('primaryTeam'),
            'primarySize': worst_lu.get('primarySize'),
            'bringBack': worst_lu.get('bringBack'),
            'pitchers': worst_lu.get('pitcherNames'),
            'geoMeanOwnHit': worst_lu.get('geoMeanOwnHit'),
        })

    print(f'\nTotal V1 lineups analyzed: {sum(1 for s in data for _ in s["v1"])}')
    print(f'Worst-bucket size:        {len(worst_all)}')
    print(f'Best-bucket size:         {len(best_all)}')

    print('\nFEATURE COMPARISON (worst vs best V1 lineups):')
    print(f"{'Feature':<22s} | {'Worst mean':>11s} | {'Best mean':>10s} | {'Δ (worst-best)':>14s}")
    print('-' * 70)
    feature_summary = []
    for k in NUMERIC_FEATURES:
        w_mean, w_std = feature_stats(worst_all, k)
        b_mean, b_std = feature_stats(best_all, k)
        diff = w_mean - b_mean
        print(f"  {k:<22s} | {w_mean:>11.2f} | {b_mean:>10.2f} | {diff:>+13.2f}")
        feature_summary.append((k, w_mean, b_mean, diff))

    # Archetype distribution
    print('\nARCHETYPE DISTRIBUTION (worst vs best):')
    print(f"{'Archetype':<20s} | {'Worst %':>10s} | {'Best %':>10s} | {'Δ':>6s}")
    all_archetypes = sorted(set(list(archetype_worst.keys()) + list(archetype_best.keys())))
    for a in all_archetypes:
        w_pct = archetype_worst[a] / len(worst_all) * 100 if worst_all else 0
        b_pct = archetype_best[a] / len(best_all) * 100 if best_all else 0
        d = w_pct - b_pct
        if abs(d) > 1:  # Filter to meaningful gaps
            print(f"  {a:<20s} | {w_pct:>9.1f}% | {b_pct:>9.1f}% | {d:>+5.1f}pp")

    # Pitcher attribution
    print('\nPITCHERS APPEARING DISPROPORTIONATELY IN WORST:')
    p_score = []
    for nm in set(list(pitcher_in_worst.keys()) + list(pitcher_in_best.keys())):
        w = pitcher_in_worst.get(nm, 0)
        b = pitcher_in_best.get(nm, 0)
        if w + b < 5: continue  # Need enough data
        net = w - b
        p_score.append((nm, w, b, net))
    p_score.sort(key=lambda x: -x[3])
    print(f"  {'Pitcher':<25s} | {'in worst':>9s} | {'in best':>8s} | {'worst-best':>11s}")
    for nm, w, b, net in p_score[:10]:
        print(f"  {nm:<25s} | {w:>9d} | {b:>8d} | {net:>+10d}")
    print('\nPITCHERS APPEARING DISPROPORTIONATELY IN BEST:')
    for nm, w, b, net in p_score[-10:]:
        print(f"  {nm:<25s} | {w:>9d} | {b:>8d} | {net:>+10d}")

    # Stack team attribution
    print('\nSTACK TEAMS APPEARING DISPROPORTIONATELY IN WORST:')
    t_score = []
    for tm in set(list(primary_team_worst.keys()) + list(primary_team_best.keys())):
        w = primary_team_worst.get(tm, 0)
        b = primary_team_best.get(tm, 0)
        if w + b < 5: continue
        t_score.append((tm, w, b, w - b))
    t_score.sort(key=lambda x: -x[3])
    print(f"  {'Team':<6s} | {'in worst':>9s} | {'in best':>8s} | {'worst-best':>11s}")
    for tm, w, b, net in t_score[:10]:
        print(f"  {tm:<6s} | {w:>9d} | {b:>8d} | {net:>+10d}")

    # Save
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write('# T5 — Worst-V1-lineup forensics across 23 slates\n\n')
        f.write(f'V1 lineups analyzed: {sum(1 for s in data for _ in s["v1"])}, worst-bucket: {len(worst_all)}, best-bucket: {len(best_all)}\n\n')

        f.write('## Feature comparison (worst vs best V1 lineups)\n\n')
        f.write('| Feature | Worst mean | Best mean | Δ (worst−best) |\n|---|---|---|---|\n')
        for k, w, b, d in feature_summary:
            f.write(f'| {k} | {w:.2f} | {b:.2f} | {d:+.2f} |\n')

        f.write('\n## Archetype distribution\n\n')
        f.write('| Archetype | Worst % | Best % | Δ pp |\n|---|---|---|---|\n')
        for a in all_archetypes:
            w_pct = archetype_worst[a] / len(worst_all) * 100 if worst_all else 0
            b_pct = archetype_best[a] / len(best_all) * 100 if best_all else 0
            d = w_pct - b_pct
            f.write(f'| {a} | {w_pct:.1f}% | {b_pct:.1f}% | {d:+.1f} |\n')

        f.write('\n## Pitcher attribution (top 10 disproportionate to WORST)\n\n')
        f.write('| Pitcher | in worst | in best | worst−best |\n|---|---|---|---|\n')
        for nm, w, b, net in p_score[:10]:
            f.write(f'| {nm} | {w} | {b} | {net:+d} |\n')

        f.write('\n## Pitcher attribution (top 10 disproportionate to BEST)\n\n')
        f.write('| Pitcher | in worst | in best | worst−best |\n|---|---|---|---|\n')
        for nm, w, b, net in p_score[-10:]:
            f.write(f'| {nm} | {w} | {b} | {net:+d} |\n')

        f.write('\n## Primary stack team attribution (top 10 to WORST)\n\n')
        f.write('| Team | in worst | in best | worst−best |\n|---|---|---|---|\n')
        for tm, w, b, net in t_score[:10]:
            f.write(f'| {tm} | {w} | {b} | {net:+d} |\n')

        f.write('\n## Forensic examples (worst V1 lineup per slate)\n\n')
        f.write('| Slate | finishPct | proj | actual | primary | stack | BB | geoOwn | pitchers |\n')
        f.write('|---|---|---|---|---|---|---|---|---|\n')
        for ex in failure_examples:
            f.write(f'| {ex["slate"]} | {ex["finishPct"]:.4f} | {ex["projection"]:.1f} | {ex["actual"] or "?"} | {ex["primaryTeam"]} | {ex["primarySize"]} | {ex["bringBack"]} | {ex["geoMeanOwnHit"]:.2f} | {", ".join(ex["pitchers"] or [])} |\n')

    print(f'\nSaved to {OUT}')


if __name__ == '__main__':
    main()
