"""
Extract EVERY lineup from EVERY contest with rank, points, and pairing to slate date.

This is the IC analysis input — needs full contest population, not just top-N.
"""
import csv, glob, io, os, re, zipfile, json
from collections import defaultdict
from datetime import datetime, timedelta

DOWNLOADS = "C:/Users/colin/Downloads"
LIVE_AUDIT = "C:/Users/colin/Projects/dfs-optimizer/live_audit"
DFSOPTO = "C:/Users/colin/dfs opto"

def main():
    zips = sorted(glob.glob(os.path.join(DOWNLOADS, "contest-standings-*.zip")))
    seen = set()
    all_rows = []
    contests_info = []

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
        if not rows: continue
        mtime = os.path.getmtime(z)
        date_obj = datetime.fromtimestamp(mtime)
        slate_obj = date_obj - timedelta(days=1)
        slate = f"{slate_obj.month}-{slate_obj.day}-{slate_obj.year%100:02d}"

        n_entries = 0
        for r in rows[1:]:
            while len(r) < 11: r.append('')
            rank, eid, name, tr, pts, lineup = r[:6]
            if not (rank and name and lineup): continue
            try:
                rank_i = int(rank)
                pts_f = float(pts) if pts else None
            except ValueError:
                continue
            n_entries += 1
            all_rows.append({
                'contest_id': cid,
                'slate': slate,
                'rank': rank_i,
                'points': pts_f,
                'lineup': lineup,
            })
        contests_info.append({'contest_id': cid, 'slate': slate, 'n_entries': n_entries})

    # Write
    with open(os.path.join(LIVE_AUDIT, 'all_lineups.csv'), 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=['contest_id', 'slate', 'rank', 'points', 'lineup'])
        w.writeheader()
        w.writerows(all_rows)
    with open(os.path.join(LIVE_AUDIT, 'contests_info.json'), 'w', encoding='utf-8') as f:
        json.dump(contests_info, f, indent=2)
    print(f"Wrote {len(all_rows)} lineups across {len(contests_info)} contests to all_lineups.csv")
    # contests per slate
    from collections import Counter
    sc = Counter(c['slate'] for c in contests_info)
    print(f"\nSlates with data:")
    for s, n in sorted(sc.items()):
        print(f"  {s}: {n} contests")

if __name__ == '__main__':
    main()
