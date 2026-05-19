"""
Extract structured live data from every DK contest-standings ZIP.

For each contest, write:
  - colin_entries.csv: Colin's per-entry rank/points/lineup (per contest)
  - all_top_lineups.csv: top-N=200 lineups for each contest
  - players_meta.csv: per-player FPTS + %Drafted from each contest

Pair contests with slate-dates by inspecting lineup contents against per-date
projection files in dfs opto.
"""
import csv
import io
import re
import sys
import zipfile
import os
import glob
from collections import Counter, defaultdict

DOWNLOADS = "C:/Users/colin/Downloads"
OUT_DIR = "C:/Users/colin/Projects/dfs-optimizer/live_audit"

# Build a player->slate-date map from historical actuals files
def build_date_lookup():
    """Map first-place winning player tuples to dates by checking actuals files."""
    pass

def parse_lineup_str(s):
    """Parse 'P Spencer Strider P Braxton Ashcraft 1B Matt Olson ...' into list[(pos,name)]."""
    s = s.strip()
    tokens = re.split(r'\s+(P|1B|2B|3B|C|SS|OF|UTIL|G|F|PG|SG|SF|PF|CPT|FLEX)\s+', ' ' + s)
    out = []
    i = 1
    while i < len(tokens):
        pos = tokens[i]
        if i+1 < len(tokens):
            name = tokens[i+1].strip()
            out.append((pos, name))
        i += 2
    return out

def process_contest(zip_path):
    contest_id = os.path.basename(zip_path).replace('.zip','').replace(' (1)','')
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
    header = rows[0]
    # cols: Rank,EntryId,EntryName,TimeRemaining,Points,Lineup,(blank),Player,RosterPosition,%Drafted,FPTS

    entries = []
    players = []
    for r in rows[1:]:
        # Pad row to 11 columns to handle trailing empty columns dropped by CSV writer
        while len(r) < 11:
            r.append('')
        rank, eid, name, tr, pts, lineup = r[0], r[1], r[2], r[3], r[4], r[5]
        if rank and name:
            try:
                pts_f = float(pts) if pts else None
                rank_i = int(rank) if rank else None
                entries.append({
                    'contest_id': contest_id,
                    'rank': rank_i,
                    'entry_id': eid,
                    'entry_name': name,
                    'points': pts_f,
                    'lineup': lineup,
                })
            except ValueError:
                pass
        player, rpos, drafted, fpts = r[7], r[8], r[9], r[10]
        if player:
            try:
                d_f = float(drafted.rstrip('%')) if drafted else None
                f_f = float(fpts) if fpts else None
                players.append({
                    'contest_id': contest_id,
                    'player': player,
                    'roster_position': rpos,
                    'pct_drafted': d_f,
                    'fpts': f_f,
                })
            except ValueError:
                pass

    total_entries = len(entries)

    return {
        'contest_id': contest_id,
        'total_entries': total_entries,
        'entries': entries,
        'players': players,
    }

def main():
    zips = sorted(glob.glob(os.path.join(DOWNLOADS, "contest-standings-*.zip")))
    # de-dup (1) suffixed ones
    seen_ids = set()
    contests = []
    for z in zips:
        m = re.search(r'contest-standings-(\d+)', os.path.basename(z))
        if not m:
            continue
        cid = m.group(1)
        if cid in seen_ids:
            continue
        seen_ids.add(cid)
        try:
            mtime = os.path.getmtime(z)
        except OSError:
            mtime = None
        result = process_contest(z)
        if result:
            result['source_file'] = os.path.basename(z)
            result['mtime'] = mtime
            contests.append(result)
            print(f"  {cid}: {result['total_entries']} entries, {len(result['players'])} players", file=sys.stderr)

    # Find Colin's entries across all contests
    all_colin = []
    all_top = []
    all_players = []
    for c in contests:
        for e in c['entries']:
            if 'colinmccort' in e['entry_name'].lower():
                e2 = dict(e)
                e2['total_entries_in_contest'] = c['total_entries']
                e2['mtime'] = c['mtime']
                e2['source_file'] = c['source_file']
                all_colin.append(e2)
            if e['rank'] is not None and e['rank'] <= 200:
                e2 = dict(e)
                e2['total_entries_in_contest'] = c['total_entries']
                e2['mtime'] = c['mtime']
                all_top.append(e2)
        for p in c['players']:
            p2 = dict(p)
            p2['mtime'] = c['mtime']
            all_players.append(p2)

    # write
    os.makedirs(OUT_DIR, exist_ok=True)

    with open(os.path.join(OUT_DIR, 'colin_entries.csv'), 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=['contest_id', 'rank', 'entry_id', 'entry_name', 'points', 'lineup', 'total_entries_in_contest', 'mtime', 'source_file'])
        w.writeheader()
        w.writerows(all_colin)

    with open(os.path.join(OUT_DIR, 'top_lineups.csv'), 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=['contest_id', 'rank', 'entry_id', 'entry_name', 'points', 'lineup', 'total_entries_in_contest', 'mtime'])
        w.writeheader()
        w.writerows(all_top)

    with open(os.path.join(OUT_DIR, 'players_meta.csv'), 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=['contest_id', 'player', 'roster_position', 'pct_drafted', 'fpts', 'mtime'])
        w.writeheader()
        w.writerows(all_players)

    # Summary
    print(f"\n{len(contests)} unique contests processed")
    print(f"{len(all_colin)} of colin's entries")
    print(f"{len(all_top)} top-200 lineups")
    print(f"{len(all_players)} player rows")

if __name__ == '__main__':
    main()
