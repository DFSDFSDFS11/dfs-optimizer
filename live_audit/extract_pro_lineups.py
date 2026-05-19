"""
Extract EACH lineup (not just exposures) for top-finishing pros per contest.

Output: pro_lineups.csv with one row per (contest, pro, lineup_index, lineup_string)
"""
import csv
import glob
import io
import os
import re
import zipfile
from collections import defaultdict

DOWNLOADS = "C:/Users/colin/Downloads"
LIVE_AUDIT = "C:/Users/colin/Projects/dfs-optimizer/live_audit"

def parse_entry_name(name):
    m = re.match(r'^(.+?)\s*(?:\((\d+)/(\d+)\))?$', name.strip())
    if not m:
        return name, None, None
    return m.group(1).strip(), int(m.group(2)) if m.group(2) else None, int(m.group(3)) if m.group(3) else None

def main():
    zips = sorted(glob.glob(os.path.join(DOWNLOADS, "contest-standings-*.zip")))
    seen = set()
    out_rows = []
    for z in zips:
        m = re.search(r'contest-standings-(\d+)', os.path.basename(z))
        if not m: continue
        cid = m.group(1)
        if cid in seen: continue
        seen.add(cid)
        with zipfile.ZipFile(z) as zf:
            names = [n for n in zf.namelist() if n.endswith('.csv')]
            if not names: continue
            with zf.open(names[0]) as f:
                content = f.read().decode('utf-8-sig', errors='replace')
        reader = csv.reader(io.StringIO(content))
        rows = list(reader)
        # collect all entries grouped by user
        by_user = defaultdict(list)
        for r in rows[1:]:
            while len(r) < 11: r.append('')
            rank, eid, name, tr, pts, lineup = r[:6]
            if not (rank and name and lineup): continue
            try:
                rank_i = int(rank)
                pts_f = float(pts) if pts else None
            except ValueError:
                continue
            user, idx, total = parse_entry_name(name)
            by_user[user].append({'rank': rank_i, 'pts': pts_f, 'lineup': lineup, 'idx': idx, 'total': total, 'eid': eid})

        # Find top 5 multi-entry users (n_entries >= 100)
        candidates = []
        for user, es in by_user.items():
            if len(es) >= 100:
                best_rank = min((e['rank'] for e in es if e['rank']), default=None)
                candidates.append((best_rank or 999999, user, es))
        candidates.sort()
        # Take top 3 pros per contest
        mtime = os.path.getmtime(z)
        for best_rank, user, es in candidates[:3]:
            for e in es:
                out_rows.append({
                    'contest_id': cid,
                    'mtime': mtime,
                    'user': user,
                    'pro_best_rank': best_rank,
                    'rank': e['rank'],
                    'points': e['pts'],
                    'lineup': e['lineup'],
                    'idx': e['idx'],
                    'total_entries': e['total'],
                })

    # Write
    with open(os.path.join(LIVE_AUDIT, 'pro_lineups.csv'), 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=list(out_rows[0].keys()))
        w.writeheader()
        w.writerows(out_rows)

    print(f"Wrote {len(out_rows)} pro lineups to pro_lineups.csv")
    # Summary per pro
    by_pro = defaultdict(int)
    for r in out_rows:
        by_pro[(r['contest_id'], r['user'])] += 1
    print(f"\n{len(by_pro)} (contest, pro) tuples")
    for (cid, user), n in sorted(by_pro.items(), key=lambda x: -x[1])[:10]:
        print(f"  {cid} {user}: {n} lineups")

if __name__ == '__main__':
    main()
