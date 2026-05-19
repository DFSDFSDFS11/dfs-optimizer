"""
Per-contest gap analysis: what players did the top winners use that Colin's entries missed?

Output:
  - per_contest_gaps.csv: top 20 'misses' per contest (high win-rate, low colin-rate)
  - systematic_gaps.md: aggregated patterns across all contests

Categorization of misses:
  - chalk_pitcher_hit: %drafted >= 20, fpts >= 20, position == 'P'
  - chalk_bat_hit: %drafted >= 20, fpts >= 20 (>=15 for non-pitcher pos like C, SS)
  - mid_own_breakout: 5 <= %drafted < 20, fpts >= 25 (>= 20 for non-pitchers)
  - low_own_breakout: %drafted < 5, fpts >= 25
"""
import csv
import os
import re
from collections import Counter, defaultdict
from datetime import datetime

LIVE_AUDIT = "C:/Users/colin/Projects/dfs-optimizer/live_audit"

def parse_lineup(s):
    """Parse 'P Strider P Ashcraft 1B Olson ...' into [name, ...]"""
    if not s:
        return []
    s = s.strip()
    # split on position tokens followed by space
    # patterns: P, C, 1B, 2B, 3B, SS, OF, CPT, FLEX, UTIL, G, F, PG, SG, SF, PF
    parts = re.split(r'\s+(?=(?:P|C|1B|2B|3B|SS|OF|CPT|FLEX|UTIL|PG|SG|SF|PF|G|F)\s+\w)', s)
    out = []
    for p in parts:
        # strip the leading position token
        m = re.match(r'^(P|C|1B|2B|3B|SS|OF|CPT|FLEX|UTIL|PG|SG|SF|PF|G|F)\s+(.+)$', p.strip())
        if m:
            out.append(m.group(2).strip())
    return out

def main():
    # Load all data
    top_lineups = list(csv.DictReader(open(os.path.join(LIVE_AUDIT, 'top_lineups.csv'), encoding='utf-8')))
    colin_entries = list(csv.DictReader(open(os.path.join(LIVE_AUDIT, 'colin_entries.csv'), encoding='utf-8')))
    players_meta = list(csv.DictReader(open(os.path.join(LIVE_AUDIT, 'players_meta.csv'), encoding='utf-8')))

    # Index by contest
    top_by_contest = defaultdict(list)
    for r in top_lineups:
        top_by_contest[r['contest_id']].append(r)
    colin_by_contest = defaultdict(list)
    for r in colin_entries:
        colin_by_contest[r['contest_id']].append(r)
    meta_by_contest = defaultdict(dict)
    for r in players_meta:
        meta_by_contest[r['contest_id']][r['player']] = r

    print(f"Contests: {len(top_by_contest)}")

    # per-contest gap analysis
    gap_rows = []
    summary_rows = []
    for cid in sorted(top_by_contest.keys()):
        # Skip contests with no colin entries
        if cid not in colin_by_contest:
            continue
        tops = top_by_contest[cid]
        colins = colin_by_contest[cid]
        meta = meta_by_contest.get(cid, {})

        # Use top-100 winners (or all if fewer)
        tops_sorted = sorted([r for r in tops if r['rank'] and r['points']], key=lambda r: int(r['rank']))[:100]
        n_tops = len(tops_sorted)
        n_colin = len(colins)
        if n_tops == 0 or n_colin == 0:
            continue

        # Frequency in top winners
        win_count = Counter()
        for r in tops_sorted:
            for p in parse_lineup(r['lineup']):
                win_count[p] += 1
        # Frequency in colin's entries
        colin_count = Counter()
        for r in colins:
            for p in parse_lineup(r['lineup']):
                colin_count[p] += 1

        try:
            mtime = float(colins[0]['mtime'])
            date = datetime.fromtimestamp(mtime).strftime('%Y-%m-%d')
        except Exception:
            date = '?'
        total_entries = colins[0].get('total_entries_in_contest', '?')

        # Find big misses: high win_count, 0 colin_count
        gaps = []
        for player, wc in win_count.items():
            cc = colin_count.get(player, 0)
            wc_pct = wc / n_tops
            cc_pct = cc / n_colin
            differential = wc_pct - cc_pct  # how much more winners had this player
            if wc_pct >= 0.20 and cc_pct < wc_pct - 0.10:  # at least 10pp underweight, and >=20% of winners
                m = meta.get(player, {})
                gaps.append({
                    'contest_id': cid,
                    'date': date,
                    'player': player,
                    'roster_position': m.get('roster_position', ''),
                    'pct_drafted': m.get('pct_drafted', ''),
                    'fpts': m.get('fpts', ''),
                    'win_pct': wc_pct,
                    'colin_pct': cc_pct,
                    'differential': differential,
                })
        gaps.sort(key=lambda g: -g['differential'])
        for g in gaps[:20]:
            gap_rows.append(g)

        # Summary line per contest
        n_misses = sum(1 for g in gaps if g['differential'] >= 0.30)
        ranks_pct = sorted([int(r['rank']) / int(total_entries) * 100 for r in colins if r['rank']])
        best_pct = ranks_pct[0] if ranks_pct else None
        summary_rows.append({
            'contest_id': cid,
            'date': date,
            'colin_entries': n_colin,
            'total_entries': total_entries,
            'best_rank_pct': f"{best_pct:.3f}" if best_pct is not None else '',
            'big_misses': n_misses,
            'top_miss_1': f"{gaps[0]['player']} ({gaps[0]['win_pct']*100:.0f}%w vs {gaps[0]['colin_pct']*100:.0f}%c, {gaps[0]['fpts']} fpts)" if gaps else '',
            'top_miss_2': f"{gaps[1]['player']} ({gaps[1]['win_pct']*100:.0f}%w vs {gaps[1]['colin_pct']*100:.0f}%c, {gaps[1]['fpts']} fpts)" if len(gaps) > 1 else '',
            'top_miss_3': f"{gaps[2]['player']} ({gaps[2]['win_pct']*100:.0f}%w vs {gaps[2]['colin_pct']*100:.0f}%c, {gaps[2]['fpts']} fpts)" if len(gaps) > 2 else '',
        })

    # Write outputs
    with open(os.path.join(LIVE_AUDIT, 'per_contest_gaps.csv'), 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=['contest_id', 'date', 'player', 'roster_position', 'pct_drafted', 'fpts', 'win_pct', 'colin_pct', 'differential'])
        w.writeheader()
        w.writerows(gap_rows)

    with open(os.path.join(LIVE_AUDIT, 'per_contest_summary.csv'), 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=['contest_id', 'date', 'colin_entries', 'total_entries', 'best_rank_pct', 'big_misses', 'top_miss_1', 'top_miss_2', 'top_miss_3'])
        w.writeheader()
        w.writerows(summary_rows)

    # Aggregate categorization
    cat_counter = Counter()
    cat_total_diff = defaultdict(float)
    cat_examples = defaultdict(list)
    for g in gap_rows:
        try:
            d = float(g['pct_drafted']) if g['pct_drafted'] else 0
            f = float(g['fpts']) if g['fpts'] else 0
            pos = g['roster_position']
        except Exception:
            continue
        diff = g['differential']
        cat = None
        if pos == 'P':
            if d >= 20 and f >= 20:
                cat = 'chalk_pitcher_hit'
            elif d < 20 and f >= 20:
                cat = 'low_own_pitcher_hit'
        else:
            if d >= 20 and f >= 15:
                cat = 'chalk_bat_hit'
            elif 5 <= d < 20 and f >= 15:
                cat = 'mid_own_bat_breakout'
            elif d < 5 and f >= 15:
                cat = 'low_own_bat_breakout'
        if cat:
            cat_counter[cat] += 1
            cat_total_diff[cat] += diff
            cat_examples[cat].append(f"{g['player']} ({g['date']}, {d:.1f}% own, {f:.1f} fpts, +{diff*100:.0f}pp gap)")

    # Write summary report
    with open(os.path.join(LIVE_AUDIT, 'systematic_gaps.md'), 'w', encoding='utf-8') as f:
        f.write("# Systematic Gap Analysis — Live Contest Data\n\n")
        f.write(f"**Contests analyzed:** {len(summary_rows)}\n")
        f.write(f"**Total gap-events flagged:** {len(gap_rows)} (win_pct >= 20%, colin under by >= 10pp)\n\n")

        f.write("## Gap categories (by frequency)\n\n")
        f.write("| Category | Count | Avg gap (pp) | Top examples |\n")
        f.write("|---|---|---|---|\n")
        for cat in sorted(cat_counter.keys(), key=lambda c: -cat_counter[c]):
            n = cat_counter[cat]
            avg = cat_total_diff[cat] / n * 100
            top_ex = '; '.join(cat_examples[cat][:3])
            f.write(f"| {cat} | {n} | {avg:.1f}pp | {top_ex} |\n")

        f.write("\n## Per-contest summary\n\n")
        f.write("| Date | Contest | Entries | Total | Best% | Big misses | Top miss #1 | #2 | #3 |\n")
        f.write("|---|---|---|---|---|---|---|---|---|\n")
        for r in summary_rows:
            f.write(f"| {r['date']} | {r['contest_id'][-6:]} | {r['colin_entries']} | {r['total_entries']} | {r['best_rank_pct']} | {r['big_misses']} | {r['top_miss_1']} | {r['top_miss_2']} | {r['top_miss_3']} |\n")

    print(f"Wrote per_contest_gaps.csv ({len(gap_rows)} rows)")
    print(f"Wrote per_contest_summary.csv ({len(summary_rows)} rows)")
    print(f"Wrote systematic_gaps.md")
    print()
    print("=== CATEGORY SUMMARY ===")
    for cat in sorted(cat_counter.keys(), key=lambda c: -cat_counter[c]):
        n = cat_counter[cat]
        avg = cat_total_diff[cat] / n * 100
        print(f"  {cat:<28} count={n:>3} avg_gap={avg:.1f}pp")

if __name__ == '__main__':
    main()
