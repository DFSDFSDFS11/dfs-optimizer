"""
Per-contest pro-anchor analysis.

For each contest where a 150-entry user finished top-10:
  - Compute that pro's top 15 exposures (player, exposure%, %drafted, FPTS)
  - Compute max exposure to a HITTER (Atlas caps hitter at 25%)
  - Compute max exposure to a PITCHER (Atlas caps pitcher at 45%)
  - Compute team-stack distribution

Output: report showing pro_max_hitter_exp distribution across slates — should
reveal whether pros routinely exceed Atlas's 25% hitter cap.
"""
import json
import os
import csv
from collections import Counter, defaultdict

LIVE_AUDIT = "C:/Users/colin/Projects/dfs-optimizer/live_audit"

def main():
    with open(os.path.join(LIVE_AUDIT, 'pro_portfolios_detailed.json')) as f:
        data = json.load(f)

    print(f"{'date':<12} {'contest':<10} {'pro':<22} {'#entries':>8} {'rank':>6} {'maxHit%':>8} {'maxPit%':>8} {'top5_hit_anchors':<50}")
    print('-'*140)

    summary = []
    for cid, c in sorted(data.items(), key=lambda x: x[1]['date']):
        date = c['date']
        meta = c['player_meta']

        # Pick top 1 best-ranked 150-entry pro
        top_pros = [p for p in c['top_pros'] if p['n_entries'] >= 100]
        if not top_pros:
            continue
        for pro in top_pros[:1]:
            n = pro['n_entries']
            exposures = pro['exposures']
            # Compute per-player exposure %
            expo_pct = {p: cnt/n*100 for p, cnt in exposures.items()}
            # Separate hitters from pitchers
            hitters = []
            pitchers = []
            for p, pct in expo_pct.items():
                m = meta.get(p, {})
                pos = m.get('pos', '')
                if pos == 'P':
                    pitchers.append((p, pct, m))
                elif pos:
                    hitters.append((p, pct, m))

            hitters.sort(key=lambda x: -x[1])
            pitchers.sort(key=lambda x: -x[1])

            max_hit = hitters[0][1] if hitters else 0
            max_pit = pitchers[0][1] if pitchers else 0

            top5_hit_str = ', '.join([f"{p[:14]}({pct:.0f}%)" for p, pct, _ in hitters[:5]])

            print(f"{date:<12} {cid[-6:]:<10} {pro['user'][:22]:<22} {n:>8} {pro['best_rank']:>6} {max_hit:>8.1f} {max_pit:>8.1f} {top5_hit_str:<50}")

            # Save detailed row
            summary.append({
                'date': date,
                'contest_id': cid,
                'user': pro['user'],
                'n_entries': n,
                'best_rank': pro['best_rank'],
                'best_pts': pro['best_pts'],
                'max_hit_exp': max_hit,
                'max_pit_exp': max_pit,
                'top10_hitters': '; '.join([f"{p}={pct:.0f}%(own={meta.get(p,{}).get('pct_drafted','?')},fpts={meta.get(p,{}).get('fpts','?')})" for p, pct, _ in hitters[:10]]),
                'top5_pitchers': '; '.join([f"{p}={pct:.0f}%(own={meta.get(p,{}).get('pct_drafted','?')},fpts={meta.get(p,{}).get('fpts','?')})" for p, pct, _ in pitchers[:5]]),
            })

    print()
    print(f"=== Distribution of pro MAX hitter exposure across {len(summary)} contests ===")
    max_hits = sorted([s['max_hit_exp'] for s in summary])
    print(f"  min:   {min(max_hits):.1f}%")
    print(f"  p25:   {max_hits[len(max_hits)//4]:.1f}%")
    print(f"  median:{max_hits[len(max_hits)//2]:.1f}%")
    print(f"  p75:   {max_hits[3*len(max_hits)//4]:.1f}%")
    print(f"  p90:   {max_hits[int(0.9*len(max_hits))]:.1f}%")
    print(f"  max:   {max(max_hits):.1f}%")

    print(f"\n=== Distribution of pro MAX pitcher exposure ===")
    max_pits = sorted([s['max_pit_exp'] for s in summary])
    print(f"  min:   {min(max_pits):.1f}%")
    print(f"  p25:   {max_pits[len(max_pits)//4]:.1f}%")
    print(f"  median:{max_pits[len(max_pits)//2]:.1f}%")
    print(f"  p75:   {max_pits[3*len(max_pits)//4]:.1f}%")
    print(f"  p90:   {max_pits[int(0.9*len(max_pits))]:.1f}%")
    print(f"  max:   {max(max_pits):.1f}%")

    # Write detailed CSV
    with open(os.path.join(LIVE_AUDIT, 'pro_anchor_exposures.csv'), 'w', newline='', encoding='utf-8') as f:
        if summary:
            w = csv.DictWriter(f, fieldnames=list(summary[0].keys()))
            w.writeheader()
            w.writerows(summary)

    # Count how many slates exceed Atlas's 25% hitter cap and 45% pitcher cap
    hit_exceed = sum(1 for s in summary if s['max_hit_exp'] > 25)
    pit_exceed = sum(1 for s in summary if s['max_pit_exp'] > 45)
    print(f"\n=== Atlas Cap Comparison ===")
    print(f"  Slates where pro max-hitter > 25% (Atlas cap): {hit_exceed}/{len(summary)} ({hit_exceed/len(summary)*100:.0f}%)")
    print(f"  Slates where pro max-pitcher > 45% (Atlas cap): {pit_exceed}/{len(summary)} ({pit_exceed/len(summary)*100:.0f}%)")
    if hit_exceed:
        print(f"\n  Pros routinely concentrate beyond Atlas's caps. Specific over-cap concentration:")
        over_cap = [(s['date'], s['max_hit_exp'], s['top10_hitters']) for s in summary if s['max_hit_exp'] > 25]
        over_cap.sort(key=lambda x: -x[1])
        for date, exp, top in over_cap[:10]:
            print(f"    {date}: max_hit={exp:.0f}%  top: {top[:150]}")

if __name__ == '__main__':
    main()
