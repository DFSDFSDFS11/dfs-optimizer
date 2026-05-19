"""
Reconstruct pro portfolios: for each contest, group entries by user, find
multi-entry users (likely 150-entry-max-GPP players), compute their full
portfolio exposure to each player. Rank users by their PORTFOLIO PEAK
(best-finishing entry).

This reveals what TRULY winning portfolios look like — not just one lucky
lineup but the structural exposures of someone who entered 150 lineups
and finished top-1%.
"""
import csv
import io
import os
import re
import glob
import zipfile
import json
from collections import Counter, defaultdict

DOWNLOADS = "C:/Users/colin/Downloads"
LIVE_AUDIT = "C:/Users/colin/Projects/dfs-optimizer/live_audit"

POSITIONS_RE = r'(?:P|C|1B|2B|3B|SS|OF|CPT|FLEX|UTIL|PG|SG|SF|PF|G|F)'

def parse_lineup(s):
    if not s:
        return []
    s = s.strip()
    parts = re.split(r'\s+(?=' + POSITIONS_RE + r'\s+\w)', s)
    out = []
    for p in parts:
        m = re.match(r'^' + POSITIONS_RE + r'\s+(.+)$', p.strip())
        if m:
            out.append(m.group(1).strip())
    return out

def parse_entry_name(name):
    m = re.match(r'^(.+?)\s*(?:\((\d+)/(\d+)\))?$', name.strip())
    if not m:
        return name, None, None
    user = m.group(1).strip()
    idx = int(m.group(2)) if m.group(2) else None
    total = int(m.group(3)) if m.group(3) else None
    return user, idx, total

def process_contest(zip_path):
    with zipfile.ZipFile(zip_path) as zf:
        names = [n for n in zf.namelist() if n.endswith('.csv')]
        if not names:
            return None
        with zf.open(names[0]) as f:
            content = f.read().decode('utf-8-sig', errors='replace')

    reader = csv.reader(io.StringIO(content))
    rows = list(reader)
    if not rows:
        return None

    # Collect all entries and players
    entries = []
    player_meta = {}
    for r in rows[1:]:
        while len(r) < 11:
            r.append('')
        rank, eid, name, tr, pts, lineup = r[:6]
        if rank and name and lineup:
            try:
                rank_i = int(rank)
                pts_f = float(pts) if pts else None
                user, idx, total = parse_entry_name(name)
                entries.append({
                    'rank': rank_i,
                    'entry_id': eid,
                    'user': user,
                    'idx': idx,
                    'total_entries': total,
                    'points': pts_f,
                    'lineup': lineup,
                })
            except ValueError:
                continue
        player, rpos, drafted, fpts = r[7], r[8], r[9], r[10]
        if player and player not in player_meta:
            try:
                d_f = float(drafted.rstrip('%')) if drafted else None
                f_f = float(fpts) if fpts else None
                player_meta[player] = {'pos': rpos, 'pct_drafted': d_f, 'fpts': f_f}
            except ValueError:
                pass

    return entries, player_meta

def main():
    zips = sorted(glob.glob(os.path.join(DOWNLOADS, "contest-standings-*.zip")))
    seen_ids = set()
    contests = {}

    for z in zips:
        m = re.search(r'contest-standings-(\d+)', os.path.basename(z))
        if not m:
            continue
        cid = m.group(1)
        if cid in seen_ids:
            continue
        seen_ids.add(cid)
        result = process_contest(z)
        if result is None:
            continue
        entries, player_meta = result
        contests[cid] = {
            'entries': entries,
            'player_meta': player_meta,
            'mtime': os.path.getmtime(z),
        }

    print(f"Processed {len(contests)} contests")

    # For each contest: group entries by user, find big multi-entry users (>= 50 entries)
    pro_summary = []
    contest_pro_details = {}  # contest_id -> [{user, n_entries, best_rank, best_pts, exposures: {player: count}}]

    for cid, c in contests.items():
        total_entries = len(c['entries'])
        # group by user
        by_user = defaultdict(list)
        for e in c['entries']:
            by_user[e['user']].append(e)

        # Find users with at least 50 entries (likely pros)
        candidates = []
        for user, es in by_user.items():
            if len(es) >= 50:
                ranks = [e['rank'] for e in es if e['rank']]
                pts = [e['points'] for e in es if e['points'] is not None]
                best_rank = min(ranks) if ranks else None
                best_pts = max(pts) if pts else None
                median_pts = sorted(pts)[len(pts)//2] if pts else None
                # Compute per-player exposure
                expo = Counter()
                for e in es:
                    for p in parse_lineup(e['lineup']):
                        expo[p] += 1
                candidates.append({
                    'user': user,
                    'n_entries': len(es),
                    'best_rank': best_rank,
                    'best_rank_pct': best_rank / total_entries * 100 if best_rank else None,
                    'best_pts': best_pts,
                    'median_pts': median_pts,
                    'exposures': expo,
                })

        # Rank by best_rank (top finishers first)
        candidates.sort(key=lambda x: x['best_rank'] or 999999)
        contest_pro_details[cid] = candidates[:20]  # top 20 multi-entry users per contest

        for c2 in candidates[:5]:
            pro_summary.append({
                'contest_id': cid,
                'date_mtime': c['mtime'],
                'total_entries': total_entries,
                'user': c2['user'],
                'n_entries': c2['n_entries'],
                'best_rank': c2['best_rank'],
                'best_rank_pct': f"{c2['best_rank_pct']:.3f}" if c2['best_rank_pct'] else '',
                'best_pts': c2['best_pts'],
                'median_pts': c2['median_pts'],
            })

    # Write pro summary
    with open(os.path.join(LIVE_AUDIT, 'pro_summary.csv'), 'w', newline='', encoding='utf-8') as f:
        if pro_summary:
            w = csv.DictWriter(f, fieldnames=list(pro_summary[0].keys()))
            w.writeheader()
            w.writerows(pro_summary)

    # For each contest, compute top-pro portfolio exposure and compare to overall winner-frequency
    print("\n=== Top 3 multi-entry pros per contest, by best rank ===\n")
    sample_rows = []
    for cid, candidates in sorted(contest_pro_details.items(), key=lambda x: contests[x[0]]['mtime']):
        c = contests[cid]
        from datetime import datetime
        date = datetime.fromtimestamp(c['mtime']).strftime('%Y-%m-%d')
        n_total = len(c['entries'])
        # Top 3 multi-entry users
        for cand in candidates[:3]:
            sample_rows.append((cid, date, cand['user'], cand['n_entries'], cand['best_rank'], cand['best_rank_pct'], cand['best_pts']))

    # Detailed: for each contest, dump top-3 multi-entry pros' portfolio exposures
    with open(os.path.join(LIVE_AUDIT, 'pro_portfolios_detailed.json'), 'w', encoding='utf-8') as f:
        out = {}
        for cid, candidates in contest_pro_details.items():
            c = contests[cid]
            from datetime import datetime
            date = datetime.fromtimestamp(c['mtime']).strftime('%Y-%m-%d')
            out[cid] = {
                'date': date,
                'total_entries': len(c['entries']),
                'player_meta': c['player_meta'],
                'top_pros': [
                    {
                        'user': cand['user'],
                        'n_entries': cand['n_entries'],
                        'best_rank': cand['best_rank'],
                        'best_rank_pct': cand['best_rank_pct'],
                        'best_pts': cand['best_pts'],
                        'median_pts': cand['median_pts'],
                        'exposures': dict(cand['exposures']),
                    }
                    for cand in candidates[:5]
                ]
            }
        json.dump(out, f, indent=1)

    # Print summary
    print(f"{'date':<12} {'contest':<10} {'user':<25} {'#entries':>9} {'best_rank':>10} {'best_pct':>10} {'best_pts':>10}")
    for row in sample_rows[-30:]:  # last 30 contests
        cid, date, user, n, br, brp, bp = row
        print(f"{date:<12} {cid[-6:]:<10} {user[:25]:<25} {n:>9} {br!s:>10} {brp!s:>10} {bp!s:>10}")

    print(f"\nWrote pro_summary.csv ({len(pro_summary)} rows)")
    print(f"Wrote pro_portfolios_detailed.json")

if __name__ == '__main__':
    main()
