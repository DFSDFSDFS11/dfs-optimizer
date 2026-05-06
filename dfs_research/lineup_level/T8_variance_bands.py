"""
T8: Variance band distribution per portfolio (Chapter 8).

Classify each lineup into 4 bands using projection and ownership quartiles within
each portfolio's slate:
  - HighProj / HighOwn (chalk core, lower variance)
  - HighProj / LowOwn (leverage anchors, mid variance)
  - LowProj / HighOwn (chalk reach, low variance, generally suboptimal)
  - LowProj / LowOwn (deep contrarian, high variance)

Compute the distribution for V1 vs pros per slate. Identify whether V1 over-clumps
in any band or matches pro distribution.
"""
import json
import sys
import statistics
from collections import defaultdict, Counter

sys.stdout.reconfigure(encoding='utf-8')

DUMP = r'C:\Users\colin\dfs opto\theory_dfs_v2\v1_pros_lineup_dump.json'
OUT = r'C:\Users\colin\dfs opto\lineup_level\T8_variance_bands.md'


def main():
    with open(DUMP, 'r', encoding='utf-8') as f:
        data = json.load(f)

    print('T8 — Variance band distribution per portfolio')
    print('=' * 70)

    agg_v1 = Counter()
    agg_pros = Counter()
    per_slate = []

    for slate in data:
        v1s = slate['v1']; pros = slate['pros']
        if not v1s or not pros: continue

        # Compute slate-relative quartiles using V1+pros pooled
        all_lus = v1s + pros
        projs = sorted(lu['projection'] for lu in all_lus)
        owns = sorted(lu.get('geoMeanOwnHit') or 0 for lu in all_lus)
        med_proj = projs[len(projs) // 2]
        med_own = owns[len(owns) // 2]

        def band(lu):
            p = lu['projection']
            o = lu.get('geoMeanOwnHit') or 0
            hp = p >= med_proj
            ho = o >= med_own
            if hp and ho: return 'HighProj/HighOwn'
            if hp and not ho: return 'HighProj/LowOwn'
            if not hp and ho: return 'LowProj/HighOwn'
            return 'LowProj/LowOwn'

        v1_bands = Counter()
        pro_bands = Counter()
        for lu in v1s: v1_bands[band(lu)] += 1
        for lu in pros: pro_bands[band(lu)] += 1

        for k, v in v1_bands.items():
            agg_v1[k] += v
        for k, v in pro_bands.items():
            agg_pros[k] += v

        # Also compute finishing performance per V1 band
        v1_band_finish = defaultdict(list)
        for lu in v1s:
            if lu.get('finishPct') is not None:
                v1_band_finish[band(lu)].append(lu['finishPct'])

        per_slate.append({
            'slate': slate['slate'],
            'numTeams': slate.get('numTeams') or 0,
            'med_proj': med_proj,
            'med_own': med_own,
            'v1': dict(v1_bands),
            'pros': dict(pro_bands),
            'v1_n': len(v1s),
            'pros_n': len(pros),
            'v1_band_finish_median': {b: statistics.median(fs) if fs else 0 for b, fs in v1_band_finish.items()},
        })

    # Aggregate
    print('\nAGGREGATE BAND DISTRIBUTION (across 23 slates):')
    print(f"{'Band':<22s} | {'V1 %':>7s} | {'Pros %':>7s} | {'gap':>7s}")
    print('-' * 50)
    bands = ['HighProj/HighOwn', 'HighProj/LowOwn', 'LowProj/HighOwn', 'LowProj/LowOwn']
    v1_total = sum(agg_v1.values())
    pros_total = sum(agg_pros.values())
    for b in bands:
        v_pct = agg_v1[b] / v1_total * 100 if v1_total else 0
        p_pct = agg_pros[b] / pros_total * 100 if pros_total else 0
        gap = v_pct - p_pct
        print(f"  {b:<22s} | {v_pct:>6.1f}% | {p_pct:>6.1f}% | {gap:>+6.1f}pp")

    # Band finishing performance (V1 only)
    print('\nV1 BAND FINISHING PERFORMANCE (median finishPct per band, slate-aggregated):')
    print(f"{'Band':<22s} | {'V1 finish median':>17s}")
    band_finish_all = defaultdict(list)
    for s in per_slate:
        for b, m in s['v1_band_finish_median'].items():
            if m > 0: band_finish_all[b].append(m)
    for b in bands:
        meds = band_finish_all[b]
        if meds:
            print(f"  {b:<22s} | {statistics.median(meds):>17.4f}")

    # Per-slate band distribution
    print('\nPER-SLATE V1 vs PROS BAND DISTRIBUTION:')
    print(f"{'Slate':<14s} | {'HP/HO V1':>9s} | {'HP/HO Pro':>10s} | {'HP/LO V1':>9s} | {'HP/LO Pro':>10s} | {'LP/HO V1':>9s} | {'LP/HO Pro':>10s} | {'LP/LO V1':>9s} | {'LP/LO Pro':>10s}")
    for s in per_slate:
        v_total = s['v1_n']
        p_total = s['pros_n']

        def pct(d, b, total):
            return d.get(b, 0) / total * 100 if total else 0

        print(f"  {s['slate']:<14s} | {pct(s['v1'], 'HighProj/HighOwn', v_total):>8.1f}% | {pct(s['pros'], 'HighProj/HighOwn', p_total):>9.1f}% | {pct(s['v1'], 'HighProj/LowOwn', v_total):>8.1f}% | {pct(s['pros'], 'HighProj/LowOwn', p_total):>9.1f}% | {pct(s['v1'], 'LowProj/HighOwn', v_total):>8.1f}% | {pct(s['pros'], 'LowProj/HighOwn', p_total):>9.1f}% | {pct(s['v1'], 'LowProj/LowOwn', v_total):>8.1f}% | {pct(s['pros'], 'LowProj/LowOwn', p_total):>9.1f}%")

    # Save
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write('# T8 — Variance band distribution per portfolio\n\n')
        f.write('Bands: HighProj/HighOwn (chalk core), HighProj/LowOwn (leverage anchors), LowProj/HighOwn (chalk reach), LowProj/LowOwn (deep contrarian).\n\n')
        f.write('## Aggregate distribution\n\n')
        f.write('| Band | V1 % | Pros % | gap |\n|---|---|---|---|\n')
        for b in bands:
            v_pct = agg_v1[b] / v1_total * 100 if v1_total else 0
            p_pct = agg_pros[b] / pros_total * 100 if pros_total else 0
            f.write(f'| {b} | {v_pct:.1f}% | {p_pct:.1f}% | {v_pct - p_pct:+.1f}pp |\n')

        f.write('\n## V1 finishing performance per band (median finishPct, higher = better)\n\n')
        f.write('| Band | V1 finish median |\n|---|---|\n')
        for b in bands:
            meds = band_finish_all[b]
            if meds:
                f.write(f'| {b} | {statistics.median(meds):.4f} |\n')

        f.write('\n## Per-slate V1 vs Pros band shares\n\n')
        f.write('| Slate | HP/HO V1 | HP/HO Pro | HP/LO V1 | HP/LO Pro | LP/HO V1 | LP/HO Pro | LP/LO V1 | LP/LO Pro |\n')
        f.write('|---|---|---|---|---|---|---|---|---|\n')
        for s in per_slate:
            v_total = s['v1_n']
            p_total = s['pros_n']

            def pct(d, b, total):
                return d.get(b, 0) / total * 100 if total else 0

            f.write(f'| {s["slate"]} | {pct(s["v1"], "HighProj/HighOwn", v_total):.1f}% | {pct(s["pros"], "HighProj/HighOwn", p_total):.1f}% | {pct(s["v1"], "HighProj/LowOwn", v_total):.1f}% | {pct(s["pros"], "HighProj/LowOwn", p_total):.1f}% | {pct(s["v1"], "LowProj/HighOwn", v_total):.1f}% | {pct(s["pros"], "LowProj/HighOwn", p_total):.1f}% | {pct(s["v1"], "LowProj/LowOwn", v_total):.1f}% | {pct(s["pros"], "LowProj/LowOwn", p_total):.1f}% |\n')

    print(f'\nSaved to {OUT}')


if __name__ == '__main__':
    main()
