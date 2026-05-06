"""
T1: Per-lineup structural fingerprint comparison.

For each V1 lineup across 23 slates, find the closest matching pro lineup on the same
slate (Manhattan distance on standardized features). Plot distribution of nearest distances.

Question: does V1 have a long right tail of lineups that don't look like ANY pro lineup?
Or are V1 lineups consistently pro-shaped at varying distances?
"""
import json
import sys
import statistics
from collections import defaultdict

sys.stdout.reconfigure(encoding='utf-8')

DUMP = r'C:\Users\colin\dfs opto\theory_dfs_v2\v1_pros_lineup_dump.json'
OUT = r'C:\Users\colin\dfs opto\lineup_level\T1_fingerprint.md'

# Features that capture construction style
FEATURES = ['primarySize', 'secondarySize', 'bringBack', 'maxGameStack',
            'numGames', 'numTeamsUsed', 'geoMeanOwnHit', 'salaryStd',
            'salaryTopThree']


def vec(lu):
    return [float(lu.get(f) or 0) for f in FEATURES]


def manhattan(a, b, scales):
    return sum(abs(x - y) / s for x, y, s in zip(a, b, scales))


def main():
    print('Loading dump...')
    with open(DUMP, 'r', encoding='utf-8') as f:
        data = json.load(f)
    print(f'Slates: {len(data)}')

    all_v1_dists = []
    per_slate_stats = []
    long_tail_examples = []  # V1 lineups with very high min-distance

    for slate in data:
        v1s = slate['v1']
        pros = slate['pros']
        if not v1s or not pros:
            continue

        # Standardize features by std of (V1 + pros) combined per-slate, so distances
        # are slate-relative.
        all_lu = v1s + pros
        scales = []
        for fi, f in enumerate(FEATURES):
            vals = [lu.get(f) or 0 for lu in all_lu]
            sd = statistics.pstdev(vals) if len(vals) > 1 else 1.0
            scales.append(max(sd, 0.1))  # Avoid div-by-0

        pro_vecs = [vec(p) for p in pros]
        slate_dists = []
        for v1 in v1s:
            v1v = vec(v1)
            min_d = min(manhattan(v1v, pv, scales) for pv in pro_vecs)
            slate_dists.append((min_d, v1))
            all_v1_dists.append(min_d)

        slate_dists.sort(key=lambda x: -x[0])
        # Capture top-3 outlier V1 lineups per slate
        for d, lu in slate_dists[:3]:
            long_tail_examples.append({
                'slate': slate['slate'], 'distance': d,
                'primarySize': lu.get('primarySize'),
                'secondarySize': lu.get('secondarySize'),
                'bringBack': lu.get('bringBack'),
                'maxGameStack': lu.get('maxGameStack'),
                'numGames': lu.get('numGames'),
                'geoMeanOwnHit': round(lu.get('geoMeanOwnHit') or 0, 2),
                'projection': round(lu.get('projection') or 0, 2),
                'finishPct': round(lu.get('finishPct') or 0, 4),
                'primaryTeam': lu.get('primaryTeam'),
                'pitchers': lu.get('pitcherNames'),
            })

        ds_only = [d for d, _ in slate_dists]
        per_slate_stats.append({
            'slate': slate['slate'],
            'n_v1': len(v1s),
            'n_pros': len(pros),
            'median': statistics.median(ds_only),
            'p75': sorted(ds_only)[int(len(ds_only) * 0.75)],
            'p90': sorted(ds_only)[int(len(ds_only) * 0.90)],
            'max': max(ds_only),
        })

    # Aggregate distribution
    all_v1_dists.sort()
    n = len(all_v1_dists)

    def pct(p):
        idx = max(0, min(n - 1, int(n * p)))
        return all_v1_dists[idx]

    print('\nT1 — Per-lineup structural fingerprint')
    print('=' * 70)
    print(f'\nTotal V1 lineups analyzed: {n}')
    print(f'Total pro lineups: {sum(s["n_pros"] for s in per_slate_stats)}')
    print(f'\nManhattan-to-nearest-pro distance distribution:')
    print(f'  median:  {pct(0.50):.2f}')
    print(f'  p25:     {pct(0.25):.2f}')
    print(f'  p75:     {pct(0.75):.2f}')
    print(f'  p90:     {pct(0.90):.2f}')
    print(f'  p95:     {pct(0.95):.2f}')
    print(f'  max:     {all_v1_dists[-1]:.2f}')

    # Tail thickness
    median = pct(0.50)
    tail_thresh = median * 3
    n_tail = sum(1 for d in all_v1_dists if d > tail_thresh)
    print(f'\nLineups with distance > 3x median ({tail_thresh:.2f}): {n_tail} ({n_tail/n*100:.1f}%)')

    # Per-slate medians
    print(f'\nPer-slate medians (range across 23 slates):')
    medians = [s['median'] for s in per_slate_stats]
    print(f'  min slate median: {min(medians):.2f} (most pro-like)')
    print(f'  max slate median: {max(medians):.2f} (least pro-like)')
    print(f'  std of medians:   {statistics.pstdev(medians):.2f}')

    # Top outliers
    print(f'\nTop 10 V1 lineups farthest from any pro:')
    long_tail_examples.sort(key=lambda x: -x['distance'])
    for i, ex in enumerate(long_tail_examples[:10]):
        print(f'  #{i+1} slate={ex["slate"]} d={ex["distance"]:.2f} stack={ex["primarySize"]}-{ex["secondarySize"]} bb={ex["bringBack"]} game-stack={ex["maxGameStack"]} games-used={ex["numGames"]} geoOwn={ex["geoMeanOwnHit"]} fin={ex["finishPct"]:.4f} primary={ex["primaryTeam"]}')

    # Write summary
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write('# T1 — Per-lineup structural fingerprint\n\n')
        f.write(f'## Distance distribution (Manhattan, scale-normalized per slate)\n\n')
        f.write(f'V1 lineups: {n}, Pro lineups: {sum(s["n_pros"] for s in per_slate_stats)}\n\n')
        f.write(f'| Percentile | Distance |\n|---|---|\n')
        for p, label in [(0.25, 'p25'), (0.50, 'median'), (0.75, 'p75'), (0.90, 'p90'), (0.95, 'p95')]:
            f.write(f'| {label} | {pct(p):.2f} |\n')
        f.write(f'| max | {all_v1_dists[-1]:.2f} |\n\n')

        f.write(f'## Tail thickness\n\n')
        f.write(f'Lineups with distance > 3x median: {n_tail} ({n_tail/n*100:.1f}%)\n\n')

        f.write('## Per-slate medians\n\n')
        f.write('| Slate | n_v1 | n_pros | median | p75 | p90 | max |\n')
        f.write('|---|---|---|---|---|---|---|\n')
        for s in per_slate_stats:
            f.write(f'| {s["slate"]} | {s["n_v1"]} | {s["n_pros"]} | {s["median"]:.2f} | {s["p75"]:.2f} | {s["p90"]:.2f} | {s["max"]:.2f} |\n')

        f.write('\n## Top 15 farthest V1 lineups (potential outliers)\n\n')
        f.write('| Slate | Distance | Stack | BB | GameStack | Games | GeoOwn | Proj | FinishPct | PrimaryTeam | Pitchers |\n')
        f.write('|---|---|---|---|---|---|---|---|---|---|---|\n')
        for ex in long_tail_examples[:15]:
            f.write(f'| {ex["slate"]} | {ex["distance"]:.2f} | {ex["primarySize"]}-{ex["secondarySize"]} | {ex["bringBack"]} | {ex["maxGameStack"]} | {ex["numGames"]} | {ex["geoMeanOwnHit"]} | {ex["projection"]} | {ex["finishPct"]:.4f} | {ex["primaryTeam"]} | {", ".join(ex["pitchers"] or [])} |\n')

    print(f'\nSaved to {OUT}')


if __name__ == '__main__':
    main()
