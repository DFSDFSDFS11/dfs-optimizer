"""
LINEUP-LEVEL structural analysis — per Theory of DFS Ch.8 "Exposures don't matter, lineups do."

For each pro's 150-lineup portfolio:
  - Stack shape (primary + secondary team counts, e.g. '5-3', '5-2', '4-3')
  - Bring-back rate: lineups where pitcher's opposing team has 2+ hitters in the same lineup
  - Variance band classification: high-proj/high-own vs low-proj/low-own
  - Pair-frequency: top-15 most-used 2-player co-occurrences

Match player names to slate projection files for team data.
"""
import csv
import io
import os
import re
import glob
import json
from collections import Counter, defaultdict
from datetime import datetime

LIVE_AUDIT = "C:/Users/colin/Projects/dfs-optimizer/live_audit"
DFSOPTO = "C:/Users/colin/dfs opto"
POS_RE = r'(?:P|C|1B|2B|3B|SS|OF|CPT|FLEX|UTIL|PG|SG|SF|PF|G|F)'

def parse_lineup(s):
    if not s:
        return []
    s = s.strip()
    parts = re.split(r'\s+(?=' + POS_RE + r'\s+\w)', s)
    out = []
    for p in parts:
        m = re.match(r'^(' + POS_RE + r')\s+(.+)$', p.strip())
        if m:
            out.append((m.group(1), m.group(2).strip()))
    return out

def norm_name(n):
    return re.sub(r'[^a-z0-9 ]+', '', n.lower()).strip()

def load_proj_for_date(date_str):
    """Try several naming conventions for a slate date and load team+own data."""
    candidates = [
        f"{date_str}projections.csv",
        f"{date_str}-projections.csv",
        f"{date_str.replace('-26', '-26-')}projections.csv",
    ]
    for c in candidates:
        p = os.path.join(DFSOPTO, c)
        if os.path.exists(p):
            return load_proj_file(p)
    return None

def load_proj_file(path):
    """Read projection CSV, return TWO dicts: by_name and by_id."""
    by_name = {}
    by_id = {}
    with open(path, encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for r in reader:
            nm = norm_name(r.get('Name', ''))
            pid = (r.get('DFS ID') or r.get('ID') or '').strip()
            if not nm and not pid: continue
            try:
                team = (r.get('Team') or '').strip()
                opp = (r.get('Opp') or '').strip()
                sal = float(r.get('Salary', 0) or 0)
                own = float((r.get('Adj Own') or r.get('My Own') or '0').replace('%','') or 0)
                proj = float(r.get('My Proj') or r.get('SS Proj') or 0)
                pos = (r.get('Pos') or '').strip()
                rec = {'team': team, 'opp': opp, 'salary': sal, 'own': own, 'proj': proj, 'pos': pos, 'name': r.get('Name','')}
                if nm and nm not in by_name:
                    by_name[nm] = rec
                if pid:
                    by_id[pid] = rec
            except ValueError:
                continue
    # Attach by_id to by_name dict so we can pass one map around
    by_name['__by_id__'] = by_id
    return by_name

def classify_lineup(positions, player_map):
    """Compute stack shape and bring-back for a single lineup.
    positions = list of (pos, name) tuples.
    player_map = dict of norm_name → player data.
    Bring-back (MLB-standard): hitters on the OPPONENT of the primary stack team.
    """
    teams_hit = Counter()  # team → count of hitters
    team_opp = {}          # team → opp team
    pitcher_opps = []
    unmatched = 0
    for pos, name in positions:
        pdata = player_map.get(norm_name(name))
        if not pdata:
            unmatched += 1
            continue
        if pos == 'P':
            pitcher_opps.append(pdata['opp'])
        else:
            teams_hit[pdata['team']] += 1
            team_opp[pdata['team']] = pdata['opp']
    counts = sorted(teams_hit.values(), reverse=True)
    while len(counts) < 5:
        counts.append(0)
    shape = '-'.join(str(c) for c in counts[:5])

    primary_team = teams_hit.most_common(1)[0][0] if teams_hit else None
    primary_size = counts[0]
    secondary_size = counts[1]

    # Bring-back (MLB-standard): hitters from primary stack team's OPPONENT
    bringback = 0
    if primary_team and primary_team in team_opp:
        opp_team = team_opp[primary_team]
        bringback = teams_hit.get(opp_team, 0)

    # Per-lineup projection and ownership sums
    proj_sum = 0.0
    own_sum = 0.0
    sal_sum = 0.0
    for pos, name in positions:
        pdata = player_map.get(norm_name(name))
        if not pdata: continue
        proj_sum += pdata['proj']
        own_sum += pdata['own']
        sal_sum += pdata['salary']

    return {
        'shape': shape,
        'primary_size': primary_size,
        'secondary_size': secondary_size,
        'primary_team': primary_team,
        'shape_top2': f"{primary_size}-{secondary_size}",
        'bringback_count': bringback,
        'unmatched': unmatched,
        'proj_sum': proj_sum,
        'own_sum': own_sum,
        'sal_sum': sal_sum,
    }

def classify_atlas_csv(path, player_map):
    """Parse a DK upload CSV (Atlas's output) and classify each lineup."""
    if not os.path.exists(path): return []
    by_id = player_map.get('__by_id__', {})
    classified = []
    with open(path, encoding='utf-8') as f:
        reader = csv.reader(f)
        header = next(reader)
        pos_cols = []
        for i, h in enumerate(header):
            h_strip = h.strip()
            if h_strip in ('P', 'C', '1B', '2B', '3B', 'SS', 'OF'):
                pos_cols.append((i, h_strip))
        for row in reader:
            if not row: continue
            teams_hit = Counter()
            team_opp = {}
            pitcher_opps = []
            proj_sum = 0.0
            own_sum = 0.0
            sal_sum = 0.0
            unmatched = 0
            for i, pos in pos_cols:
                if i >= len(row): continue
                val = row[i].strip()
                if not val: continue
                pdata = None
                if val.isdigit():
                    pdata = by_id.get(val)
                else:
                    m = re.search(r'\((\d+)\)\s*$', val)
                    if m:
                        pdata = by_id.get(m.group(1))
                    if not pdata:
                        nm = norm_name(re.sub(r'\s*\(\d+\)\s*$', '', val))
                        pdata = player_map.get(nm)
                if not pdata:
                    unmatched += 1
                    continue
                if pos == 'P':
                    pitcher_opps.append(pdata['opp'])
                else:
                    teams_hit[pdata['team']] += 1
                    team_opp[pdata['team']] = pdata['opp']
                proj_sum += pdata['proj']
                own_sum += pdata['own']
                sal_sum += pdata['salary']
            counts = sorted(teams_hit.values(), reverse=True)
            while len(counts) < 5: counts.append(0)
            primary_team = teams_hit.most_common(1)[0][0] if teams_hit else None
            primary_size = counts[0]
            secondary_size = counts[1]
            # Bring-back: hitters from primary stack team's opponent
            bringback = 0
            if primary_team and primary_team in team_opp:
                bringback = teams_hit.get(team_opp[primary_team], 0)
            classified.append({
                'primary_size': primary_size,
                'secondary_size': secondary_size,
                'shape_top2': f"{primary_size}-{secondary_size}",
                'bringback_count': bringback,
                'unmatched': unmatched,
                'proj_sum': proj_sum,
                'own_sum': own_sum,
                'sal_sum': sal_sum,
            })
    return classified

def stack_shape_distribution(classified_lineups):
    """Return Counter of shape_top2."""
    return Counter(c['shape_top2'] for c in classified_lineups)

def main():
    pro_lineups = list(csv.DictReader(open(os.path.join(LIVE_AUDIT, 'pro_lineups.csv'), encoding='utf-8')))
    print(f"Loaded {len(pro_lineups)} pro lineups")

    # Group pro lineups by (contest, pro)
    by_pro = defaultdict(list)
    for r in pro_lineups:
        by_pro[(r['contest_id'], r['user'])].append(r)

    # Map contest_id to slate date (use mtime - 1 day = slate date approximation)
    contest_dates = {}
    for cid in {r['contest_id'] for r in pro_lineups}:
        mtime = float(next(r['mtime'] for r in pro_lineups if r['contest_id'] == cid))
        date = datetime.fromtimestamp(mtime)
        # mtime is download time; slate date is typically the day before
        from datetime import timedelta
        contest_dates[cid] = date

    # For each (contest, pro), try to find a matching slate projection
    print(f"\n=== Stack shape distributions per pro ===\n")
    all_pro_shapes = Counter()
    all_pro_bringbacks = []
    pro_summaries = []
    matched_contests = 0

    for (cid, user), ls in by_pro.items():
        mtime = float(ls[0]['mtime'])
        date_obj = datetime.fromtimestamp(mtime)
        # Try mtime date and mtime-1day
        candidates = []
        for offset in [0, -1]:
            from datetime import timedelta
            d = date_obj.timestamp() + offset*86400
            d_obj = datetime.fromtimestamp(d)
            # Format as M-D-YY (no leading zeros) — e.g. "5-10-26"
            m = d_obj.month
            day = d_obj.day
            yr = d_obj.year % 100
            candidates.append(f"{m}-{day}-{yr:02d}")
        proj = None
        slate_str = None
        for c in candidates:
            p = load_proj_for_date(c)
            if p:
                proj = p
                slate_str = c
                break
        if not proj:
            continue
        matched_contests += 1

        # Classify each lineup
        classified = []
        for r in ls:
            positions = parse_lineup(r['lineup'])
            c = classify_lineup(positions, proj)
            classified.append(c)

        shape_dist = stack_shape_distribution(classified)
        top_shapes = shape_dist.most_common(5)
        avg_bringback = sum(c['bringback_count'] for c in classified) / len(classified)
        bringback_zero = sum(1 for c in classified if c['bringback_count'] == 0)
        bringback_1plus = sum(1 for c in classified if c['bringback_count'] >= 1)
        bringback_2plus = sum(1 for c in classified if c['bringback_count'] >= 2)
        avg_proj = sum(c['proj_sum'] for c in classified) / len(classified)
        avg_own = sum(c['own_sum'] for c in classified) / len(classified)
        unmatched_avg = sum(c['unmatched'] for c in classified) / len(classified)

        pro_summaries.append({
            'contest_id': cid,
            'date': date_obj.strftime('%Y-%m-%d'),
            'slate': slate_str,
            'user': user,
            'n_lineups': len(classified),
            'unmatched_avg': f"{unmatched_avg:.1f}",
            'top_shape': top_shapes[0][0] if top_shapes else '',
            'top_shape_pct': f"{top_shapes[0][1]/len(classified)*100:.0f}%" if top_shapes else '',
            'top3_shapes': '; '.join(f"{s}({n})" for s, n in top_shapes[:3]),
            'bringback_0_pct': f"{bringback_zero/len(classified)*100:.0f}%",
            'bringback_1plus_pct': f"{bringback_1plus/len(classified)*100:.0f}%",
            'bringback_2plus_pct': f"{bringback_2plus/len(classified)*100:.0f}%",
            'avg_proj': f"{avg_proj:.1f}",
            'avg_own': f"{avg_own:.1f}",
        })
        for c in classified:
            all_pro_shapes[c['shape_top2']] += 1
            all_pro_bringbacks.append(c['bringback_count'])

    # Write per-pro summary
    with open(os.path.join(LIVE_AUDIT, 'lineup_structure_per_pro.csv'), 'w', newline='', encoding='utf-8') as f:
        if pro_summaries:
            w = csv.DictWriter(f, fieldnames=list(pro_summaries[0].keys()))
            w.writeheader()
            w.writerows(pro_summaries)

    print(f"Matched {matched_contests} (contest, pro) tuples with slate data")
    print(f"\n=== AGGREGATE PRO STACK SHAPE DISTRIBUTION ({sum(all_pro_shapes.values())} lineups) ===")
    total = sum(all_pro_shapes.values())
    for shape, n in all_pro_shapes.most_common(15):
        print(f"  {shape:<8} {n:>5} ({n/total*100:.1f}%)")

    # === PER-SLATE pros' lineup metrics (MLB main only — filter shape != 0-0, primary_size >= 4) ===
    print("\n=== PER-SLATE PROS' STRUCTURE (MLB main) ===\n")
    per_slate = defaultdict(list)
    for s in pro_summaries:
        per_slate[s['slate']].append(s)
    # Reload all classified-by-slate
    per_slate_classified = defaultdict(list)  # slate → list of (user, classified_list)
    for (cid, user), ls in by_pro.items():
        mtime = float(ls[0]['mtime'])
        date_obj = datetime.fromtimestamp(mtime)
        candidates = []
        from datetime import timedelta
        for offset in [0, -1]:
            d_obj = datetime.fromtimestamp(date_obj.timestamp() + offset*86400)
            candidates.append(f"{d_obj.month}-{d_obj.day}-{d_obj.year%100:02d}")
        proj = None
        slate_str = None
        for c in candidates:
            p = load_proj_for_date(c)
            if p:
                proj, slate_str = p, c
                break
        if not proj: continue
        classified = [classify_lineup(parse_lineup(r['lineup']), proj) for r in ls]
        # Filter MLB main: require avg primary_size >= 4 (heuristic)
        avg_primary = sum(c['primary_size'] for c in classified) / max(1, len(classified))
        if avg_primary < 3.5: continue  # exclude showdown / NBA
        per_slate_classified[slate_str].append((cid, user, classified))

    print(f"{'slate':<10} {'pro':<22} {'5-stacks%':>10} {'4-stacks%':>10} {'3-stack%':>9} {'bb1+%':>7} {'bb2+%':>7} {'avg_proj':>9} {'avg_own':>9}")
    print('-'*110)
    for slate, pros in sorted(per_slate_classified.items()):
        for cid, user, classified in pros:
            n = len(classified)
            five = sum(1 for c in classified if c['primary_size'] == 5) / n * 100
            four = sum(1 for c in classified if c['primary_size'] == 4) / n * 100
            three = sum(1 for c in classified if c['primary_size'] == 3) / n * 100
            bb1 = sum(1 for c in classified if c['bringback_count'] >= 1) / n * 100
            bb2 = sum(1 for c in classified if c['bringback_count'] >= 2) / n * 100
            avg_proj = sum(c['proj_sum'] for c in classified) / n
            avg_own = sum(c['own_sum'] for c in classified) / n
            print(f"{slate:<10} {user[:22]:<22} {five:>10.1f} {four:>10.1f} {three:>9.1f} {bb1:>7.1f} {bb2:>7.1f} {avg_proj:>9.1f} {avg_own:>9.1f}")

    # Aggregate cross-slate
    print(f"\n=== CROSS-SLATE PRO MEDIANS (MLB main only) ===")
    all_metrics = {'five_pct': [], 'four_pct': [], 'three_pct': [], 'bb1_pct': [], 'bb2_pct': [], 'avg_proj': [], 'avg_own': []}
    for slate, pros in per_slate_classified.items():
        for cid, user, classified in pros:
            n = len(classified)
            all_metrics['five_pct'].append(sum(1 for c in classified if c['primary_size']==5)/n*100)
            all_metrics['four_pct'].append(sum(1 for c in classified if c['primary_size']==4)/n*100)
            all_metrics['three_pct'].append(sum(1 for c in classified if c['primary_size']==3)/n*100)
            all_metrics['bb1_pct'].append(sum(1 for c in classified if c['bringback_count']>=1)/n*100)
            all_metrics['bb2_pct'].append(sum(1 for c in classified if c['bringback_count']>=2)/n*100)
            all_metrics['avg_proj'].append(sum(c['proj_sum'] for c in classified)/n)
            all_metrics['avg_own'].append(sum(c['own_sum'] for c in classified)/n)
    import statistics
    for k, v in all_metrics.items():
        if v:
            print(f"  {k:<10} median={statistics.median(v):.1f}  p25={sorted(v)[len(v)//4]:.1f}  p75={sorted(v)[3*len(v)//4]:.1f}  min={min(v):.1f}  max={max(v):.1f}")

    print(f"\n=== AGGREGATE BRING-BACK ({sum(all_pro_shapes.values())} lineups) ===")
    if all_pro_bringbacks:
        z = sum(1 for b in all_pro_bringbacks if b == 0)
        o = sum(1 for b in all_pro_bringbacks if b == 1)
        t = sum(1 for b in all_pro_bringbacks if b == 2)
        th = sum(1 for b in all_pro_bringbacks if b >= 3)
        N = len(all_pro_bringbacks)
        print(f"  0 opp hitters: {z} ({z/N*100:.1f}%)")
        print(f"  1 opp hitter:  {o} ({o/N*100:.1f}%)")
        print(f"  2 opp hitters: {t} ({t/N*100:.1f}%)")
        print(f"  3+ opp hitters: {th} ({th/N*100:.1f}%)")
        avg = sum(all_pro_bringbacks) / len(all_pro_bringbacks)
        print(f"  avg bringback count: {avg:.2f}")

    # === HISTORICAL 5-10 COMPARISON ===
    print(f"\n=== 5-10-26 HISTORICAL — Atlas vs Anchor vs Stacks vs winning pro (jmoore3903) ===")
    proj_510 = load_proj_for_date('5-10-26')
    if proj_510:
        for label, fname in [
            ('Atlas_5-10', 'theory_dfs_argus_anchor_preslate_150_anchor_5-10.csv'),  # we have anchor 5-10
            ('Stacks_5-10', 'theory_dfs_argus_stacks_preslate_150_stacks_5-10.csv'),
        ]:
            cls = classify_atlas_csv(os.path.join(DFSOPTO, fname), proj_510)
            if cls:
                dist = stack_shape_distribution(cls)
                avg_bb = sum(c['bringback_count'] for c in cls) / len(cls)
                bb0 = sum(1 for c in cls if c['bringback_count'] == 0) / len(cls) * 100
                bb1 = sum(1 for c in cls if c['bringback_count'] >= 1) / len(cls) * 100
                bb2 = sum(1 for c in cls if c['bringback_count'] >= 2) / len(cls) * 100
                five = sum(1 for c in cls if c['primary_size']==5)/len(cls)*100
                four = sum(1 for c in cls if c['primary_size']==4)/len(cls)*100
                print(f"\n{label} ({len(cls)}): 5-stack={five:.0f}% 4-stack={four:.0f}% BB1+={bb1:.0f}% BB2+={bb2:.0f}%")

    # === ATLAS STACK SHAPE for comparison ===
    print(f"\n=== ATLAS STACK SHAPE on 5-15 tonight's slate ===")
    proj_today = load_proj_for_date('5-15-26') or load_proj_for_date('mlbdkprojpre')
    if not proj_today:
        # Last resort — read mlbdkprojpre directly
        proj_today = load_proj_file(os.path.join(DFSOPTO, 'mlbdkprojpre.csv'))
    atlas_path = os.path.join(DFSOPTO, 'theory_dfs_argus_atlas_preslate_150_atlas.csv')
    anchor_path = os.path.join(DFSOPTO, 'theory_dfs_argus_anchor_preslate_150_anchor.csv')
    stacks_path = os.path.join(DFSOPTO, 'theory_dfs_argus_stacks_preslate_150_stacks.csv')
    for label, path in [('Atlas', atlas_path), ('Anchor', anchor_path), ('Stacks', stacks_path)]:
        cls = classify_atlas_csv(path, proj_today)
        if cls:
            dist = stack_shape_distribution(cls)
            print(f"\n{label} ({len(cls)} lineups):")
            for shape, n in dist.most_common(8):
                print(f"  {shape:<8} {n:>5} ({n/len(cls)*100:.1f}%)")
            # bring-back
            avg_bb = sum(c['bringback_count'] for c in cls) / len(cls)
            bb0 = sum(1 for c in cls if c['bringback_count'] == 0) / len(cls) * 100
            bb1 = sum(1 for c in cls if c['bringback_count'] >= 1) / len(cls) * 100
            bb2 = sum(1 for c in cls if c['bringback_count'] >= 2) / len(cls) * 100
            print(f"  bring-back avg={avg_bb:.2f}  0={bb0:.0f}%  1+={bb1:.0f}%  2+={bb2:.0f}%")
            avg_proj = sum(c['proj_sum'] for c in cls) / len(cls)
            avg_own = sum(c['own_sum'] for c in cls) / len(cls)
            print(f"  avg proj_sum: {avg_proj:.1f}  avg own_sum: {avg_own:.1f}")

if __name__ == '__main__':
    main()
