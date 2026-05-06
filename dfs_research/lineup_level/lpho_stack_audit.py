"""
Descriptive audit: of V1's lineups classified as LP/HO (by V1+pros median, on dev only),
what are their stack-size compositions and what are pros' LP/HO compositions?
This tests whether V1's LP/HO selections are mostly 4-stacks (which the prior NoLPHO
filter was effectively also excluding from V1's selection space).
"""
import json
import sys
import statistics
from collections import Counter

sys.stdout.reconfigure(encoding='utf-8')

DUMP = r'C:\Users\colin\dfs opto\theory_dfs_v2\v1_pros_lineup_dump.json'
HOLDOUT = {'4-6-26', '4-14-26', '4-15-26', '4-19-26', '4-20-26', '5-1-26', '5-2-26', '5-2-26-night'}


def main():
    with open(DUMP, 'r', encoding='utf-8') as f:
        data = json.load(f)
    dev = [s for s in data if s['slate'] not in HOLDOUT]
    print(f'Dev slates: {len(dev)}')

    v1_by_band = {b: [] for b in ['HP/HO', 'HP/LO', 'LP/HO', 'LP/LO']}
    pro_by_band = {b: [] for b in ['HP/HO', 'HP/LO', 'LP/HO', 'LP/LO']}

    for slate in dev:
        v1s = slate['v1']; pros = slate['pros']
        if not v1s or not pros: continue
        all_lus = v1s + pros
        projs = sorted(lu['projection'] for lu in all_lus)
        owns = sorted((lu.get('geoMeanOwnHit') or 0) for lu in all_lus)
        med_proj = projs[len(projs) // 2]
        med_own = owns[len(owns) // 2]

        def band(lu):
            hp = lu['projection'] >= med_proj
            ho = (lu.get('geoMeanOwnHit') or 0) >= med_own
            return ('HP/' if hp else 'LP/') + ('HO' if ho else 'LO')

        for lu in v1s:
            v1_by_band[band(lu)].append(lu)
        for lu in pros:
            pro_by_band[band(lu)].append(lu)

    print('\n=== Stack-size composition by band ===')
    print(f'{"Band":<8} | {"src":<5} | {"n":<5} | 5-stack% | 4-stack% | 3-stack% | other%')
    for b in ['HP/HO', 'HP/LO', 'LP/HO', 'LP/LO']:
        for src, lus in [('V1', v1_by_band[b]), ('Pros', pro_by_band[b])]:
            n = len(lus)
            if n == 0: continue
            sizes = Counter()
            for lu in lus:
                ps = lu.get('primarySize') or 0
                if ps >= 5: sizes['5+'] += 1
                elif ps == 4: sizes['4'] += 1
                elif ps == 3: sizes['3'] += 1
                else: sizes['other'] += 1
            print(f'{b:<8} | {src:<5} | {n:<5} | {sizes["5+"]/n*100:>6.1f}% | {sizes["4"]/n*100:>6.1f}% | {sizes["3"]/n*100:>6.1f}% | {sizes["other"]/n*100:>5.1f}%')

    print('\n=== Bring-back composition by band ===')
    print(f'{"Band":<8} | {"src":<5} | {"n":<5} | BB=0% | BB=1% | BB=2+%')
    for b in ['HP/HO', 'HP/LO', 'LP/HO', 'LP/LO']:
        for src, lus in [('V1', v1_by_band[b]), ('Pros', pro_by_band[b])]:
            n = len(lus)
            if n == 0: continue
            bb = Counter()
            for lu in lus:
                v = lu.get('bringBack') or 0
                if v == 0: bb['0'] += 1
                elif v == 1: bb['1'] += 1
                else: bb['2+'] += 1
            print(f'{b:<8} | {src:<5} | {n:<5} | {bb["0"]/n*100:>4.1f}% | {bb["1"]/n*100:>4.1f}% | {bb["2+"]/n*100:>5.1f}%')

    # V1's LP/HO finishing performance
    print('\n=== V1 LP/HO finish performance ===')
    lpho_lus = v1_by_band['LP/HO']
    if lpho_lus:
        finishes = [lu['finishPct'] for lu in lpho_lus if lu.get('finishPct') is not None]
        if finishes:
            top1 = sum(1 for f in finishes if f >= 0.99)
            top01 = sum(1 for f in finishes if f >= 0.999)
            print(f'  V1 LP/HO lineups: {len(lpho_lus)}')
            print(f'  Finish median:  {statistics.median(finishes):.4f}')
            print(f'  Finish mean:    {statistics.mean(finishes):.4f}')
            print(f'  Top-1% hits:    {top1} of {len(finishes)} ({top1/len(finishes)*100:.2f}%)')
            print(f'  Top-0.1% hits:  {top01} of {len(finishes)} ({top01/len(finishes)*100:.3f}%)')
    # Compare to other V1 bands
    print('\n  V1 finish median by band:')
    for b in ['HP/HO', 'HP/LO', 'LP/HO', 'LP/LO']:
        lus = v1_by_band[b]
        if not lus: continue
        finishes = [lu['finishPct'] for lu in lus if lu.get('finishPct') is not None]
        if finishes:
            top1_rate = sum(1 for f in finishes if f >= 0.99) / len(finishes) * 100
            top01_rate = sum(1 for f in finishes if f >= 0.999) / len(finishes) * 100
            print(f'    {b:<6} median={statistics.median(finishes):.4f} top1={top1_rate:.2f}% top0.1={top01_rate:.3f}%')


if __name__ == '__main__':
    main()
