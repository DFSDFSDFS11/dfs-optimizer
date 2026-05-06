"""
T9: Chalk fade rate + negative correlation leverage (Chapter 5).

Two analyses on the same dump:

A) Chalk fade rate. For each slate, identify the top-10 highest-owned players.
   For each, compute the fade rate (% of lineups that DON'T have the player) for
   V1 vs pros. Pros should fade more aggressively at the top of the ownership
   distribution.

B) Negative correlation leverage. For each lineup, check whether any pitcher's
   opponent team matches the primary stack team. If yes, the lineup is running
   the deliberate negative-correlation play (pitcher vs opposing stack). Compute
   rate for V1 vs pros.
"""
import json
import sys
import statistics
from collections import defaultdict, Counter

sys.stdout.reconfigure(encoding='utf-8')

DUMP = r'C:\Users\colin\dfs opto\theory_dfs_v2\v1_pros_lineup_dump.json'
OUT = r'C:\Users\colin\dfs opto\lineup_level\T9_chalk_fade_negcorr.md'


def main():
    with open(DUMP, 'r', encoding='utf-8') as f:
        data = json.load(f)

    print('T9 — Chalk fade + negative correlation leverage')
    print('=' * 70)

    # === A. CHALK FADE ===
    fade_rows = []
    agg_v1_fade = []
    agg_pro_fade = []
    for slate in data:
        v1s = slate['v1']; pros = slate['pros']
        if not v1s or not pros: continue

        # Aggregate per-player ownership across all lineups using owns array
        # Use the AVERAGE ownership of each player across pro lineups (where they appear)
        # plus their per-lineup ownership values.
        # Actually simpler: build a name -> ownership map by walking through all lineups.
        own_by_pid = {}
        for lu in v1s + pros:
            pids = lu['pids']
            owns = lu['owns']
            for pid, o in zip(pids, owns):
                if pid not in own_by_pid:
                    own_by_pid[pid] = (o, lu['names'][pids.index(pid)] if pid in pids else '?')

        # Find top-10 chalk players by ownership
        chalk = sorted(own_by_pid.items(), key=lambda x: -x[1][0])[:10]

        slate_v1_fade = []
        slate_pro_fade = []
        for pid, (own, name) in chalk:
            # Fade rate = % of lineups that DON'T have this player
            v1_has = sum(1 for lu in v1s if pid in lu['pids'])
            pro_has = sum(1 for lu in pros if pid in lu['pids'])
            v1_fade = 1 - (v1_has / len(v1s))
            pro_fade = 1 - (pro_has / len(pros))
            slate_v1_fade.append(v1_fade)
            slate_pro_fade.append(pro_fade)
            agg_v1_fade.append(v1_fade)
            agg_pro_fade.append(pro_fade)

        fade_rows.append({
            'slate': slate['slate'],
            'v1_avg_fade': statistics.mean(slate_v1_fade),
            'pro_avg_fade': statistics.mean(slate_pro_fade),
            'gap': statistics.mean(slate_v1_fade) - statistics.mean(slate_pro_fade),
            'top_chalk': chalk[0][1][1],
            'top_chalk_own': chalk[0][1][0],
            'v1_top1_fade': slate_v1_fade[0] if slate_v1_fade else 0,
            'pro_top1_fade': slate_pro_fade[0] if slate_pro_fade else 0,
        })

    print('\nA. CHALK FADE RATE on top-10 highest-owned players (per slate):')
    print(f'{"Slate":<14s} | {"top chalk":<22s} | {"chalk own":>9s} | {"V1 fade #1":>10s} | {"Pro fade #1":>11s} | {"V1 avg":>8s} | {"Pro avg":>8s} | {"gap":>6s}')
    for r in fade_rows:
        print(f"  {r['slate']:<14s} | {r['top_chalk'][:20]:<22s} | {r['top_chalk_own']:>8.1f}% | {r['v1_top1_fade']*100:>9.1f}% | {r['pro_top1_fade']*100:>10.1f}% | {r['v1_avg_fade']*100:>7.1f}% | {r['pro_avg_fade']*100:>7.1f}% | {r['gap']*100:>+5.1f}pp")

    print(f'\nAGGREGATE FADE RATE on top-10 chalk:')
    print(f'  V1:    {statistics.mean(agg_v1_fade)*100:.1f}% (median {statistics.median(agg_v1_fade)*100:.1f}%)')
    print(f'  Pros:  {statistics.mean(agg_pro_fade)*100:.1f}% (median {statistics.median(agg_pro_fade)*100:.1f}%)')
    print(f'  Gap:   {(statistics.mean(agg_v1_fade) - statistics.mean(agg_pro_fade))*100:+.1f}pp (positive = V1 fades more)')

    # === B. NEGATIVE CORRELATION (PITCHER vs STACK) ===
    print('\n' + '=' * 70)
    print('\nB. NEGATIVE CORRELATION LEVERAGE (pitcher vs primary stack team):')
    neg_corr_rows = []
    agg_v1_negcorr = 0; agg_v1_total = 0
    agg_pro_negcorr = 0; agg_pro_total = 0
    for slate in data:
        v1s = slate['v1']; pros = slate['pros']
        if not v1s or not pros: continue

        def neg_corr_count(lus):
            n = 0
            for lu in lus:
                pt = lu.get('primaryTeam') or ''
                pitcher_opps = lu.get('pitcherOpps') or []
                if pt and pt in pitcher_opps:
                    n += 1
            return n

        v1_n = neg_corr_count(v1s)
        pro_n = neg_corr_count(pros)
        v1_rate = v1_n / len(v1s) if v1s else 0
        pro_rate = pro_n / len(pros) if pros else 0
        agg_v1_negcorr += v1_n; agg_v1_total += len(v1s)
        agg_pro_negcorr += pro_n; agg_pro_total += len(pros)

        neg_corr_rows.append({
            'slate': slate['slate'],
            'v1_rate': v1_rate, 'pro_rate': pro_rate, 'gap': v1_rate - pro_rate,
        })

    print(f'{"Slate":<14s} | {"V1 rate":>9s} | {"Pro rate":>9s} | {"gap":>7s}')
    for r in neg_corr_rows:
        print(f"  {r['slate']:<14s} | {r['v1_rate']*100:>8.1f}% | {r['pro_rate']*100:>8.1f}% | {r['gap']*100:>+6.1f}pp")

    v1_agg = agg_v1_negcorr / agg_v1_total * 100 if agg_v1_total else 0
    pro_agg = agg_pro_negcorr / agg_pro_total * 100 if agg_pro_total else 0
    print(f'\nAGGREGATE NEG-CORR RATE: V1={v1_agg:.1f}%  Pros={pro_agg:.1f}%  gap={v1_agg-pro_agg:+.1f}pp')

    # Save
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write('# T9 — Chalk fade rate + negative correlation leverage\n\n')
        f.write('## A. Chalk fade rate (top-10 highest-owned players)\n\n')
        f.write(f'**Aggregate**: V1 fades {statistics.mean(agg_v1_fade)*100:.1f}%, Pros fade {statistics.mean(agg_pro_fade)*100:.1f}%. Gap {(statistics.mean(agg_v1_fade) - statistics.mean(agg_pro_fade))*100:+.1f}pp (positive = V1 fades MORE than pros).\n\n')
        f.write('| Slate | Top chalk | Chalk own | V1 fade #1 | Pro fade #1 | V1 avg | Pro avg | gap |\n')
        f.write('|---|---|---|---|---|---|---|---|\n')
        for r in fade_rows:
            f.write(f'| {r["slate"]} | {r["top_chalk"]} | {r["top_chalk_own"]:.1f}% | {r["v1_top1_fade"]*100:.1f}% | {r["pro_top1_fade"]*100:.1f}% | {r["v1_avg_fade"]*100:.1f}% | {r["pro_avg_fade"]*100:.1f}% | {r["gap"]*100:+.1f}pp |\n')

        f.write('\n## B. Negative correlation leverage (pitcher vs primary stack team)\n\n')
        f.write(f'**Aggregate**: V1={v1_agg:.1f}%, Pros={pro_agg:.1f}%, gap={v1_agg-pro_agg:+.1f}pp.\n\n')
        f.write('| Slate | V1 rate | Pro rate | gap |\n|---|---|---|---|\n')
        for r in neg_corr_rows:
            f.write(f'| {r["slate"]} | {r["v1_rate"]*100:.1f}% | {r["pro_rate"]*100:.1f}% | {r["gap"]*100:+.1f}pp |\n')

    print(f'\nSaved to {OUT}')


if __name__ == '__main__':
    main()
