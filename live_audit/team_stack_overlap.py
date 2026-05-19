"""
Per-slate: do Atlas's team stacks match pros' team stacks? Do players overlap?

For each slate where we have:
  - Pro's reconstructed 150-lineup portfolio
  - Atlas/Stacks portfolio generated against the same slate's pool

Compute:
  1. Team-stack overlap: which teams does Atlas stack 4+ vs which does pro stack 4+?
  2. Player-level Jaccard similarity per lineup pair
  3. Pair-frequency overlap (top 10 most-used 2-player combos)
"""
import csv
import os
import re
import json
from collections import Counter, defaultdict
from datetime import datetime, timedelta

LIVE_AUDIT = "C:/Users/colin/Projects/dfs-optimizer/live_audit"
DFSOPTO = "C:/Users/colin/dfs opto"
POS_RE = r'(?:P|C|1B|2B|3B|SS|OF|CPT|FLEX|UTIL|PG|SG|SF|PF|G|F)'

def parse_lineup(s):
    if not s: return []
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

def load_proj(date_str):
    candidates = [f"{date_str}projections.csv"]
    for c in candidates:
        p = os.path.join(DFSOPTO, c)
        if os.path.exists(p):
            by_name = {}
            by_id = {}
            with open(p, encoding='utf-8') as f:
                reader = csv.DictReader(f)
                for r in reader:
                    nm = norm_name(r.get('Name', ''))
                    pid = (r.get('DFS ID') or '').strip()
                    try:
                        rec = {
                            'team': (r.get('Team') or '').strip().upper(),
                            'opp': (r.get('Opp') or '').strip().upper(),
                            'salary': float(r.get('Salary', 0) or 0),
                            'own': float((r.get('Adj Own') or '0').replace('%','') or 0),
                            'proj': float(r.get('My Proj') or r.get('SS Proj') or 0),
                            'pos': (r.get('Pos') or '').strip(),
                            'name': r.get('Name', ''),
                        }
                        if nm and nm not in by_name:
                            by_name[nm] = rec
                        if pid:
                            by_id[pid] = rec
                    except ValueError:
                        pass
            return by_name, by_id
    return None, None

def classify_pro_lineup_teams(positions, by_name):
    """Return team stack distribution + primary team."""
    teams_hit = Counter()
    pitcher_teams = []
    for pos, name in positions:
        rec = by_name.get(norm_name(name))
        if not rec: continue
        if pos == 'P':
            pitcher_teams.append(rec['team'])
        else:
            teams_hit[rec['team']] += 1
    return teams_hit, pitcher_teams

def classify_atlas_csv(path, by_name, by_id):
    """Parse Atlas CSV (player IDs) and return list of (team_counts, pitcher_teams, player_names_set) per lineup."""
    if not os.path.exists(path): return []
    lineups = []
    with open(path, encoding='utf-8') as f:
        reader = csv.reader(f)
        header = next(reader)
        pos_cols = [(i, h.strip()) for i, h in enumerate(header) if h.strip() in ('P','C','1B','2B','3B','SS','OF')]
        for row in reader:
            if not row: continue
            teams_hit = Counter()
            pitcher_teams = []
            names = set()
            for i, pos in pos_cols:
                if i >= len(row): continue
                val = row[i].strip()
                if not val: continue
                rec = None
                if val.isdigit():
                    rec = by_id.get(val)
                else:
                    m = re.search(r'\((\d+)\)\s*$', val)
                    if m:
                        rec = by_id.get(m.group(1))
                    if not rec:
                        nm = norm_name(re.sub(r'\s*\(\d+\)\s*$', '', val))
                        rec = by_name.get(nm)
                if not rec: continue
                names.add(norm_name(rec['name']))
                if pos == 'P':
                    pitcher_teams.append(rec['team'])
                else:
                    teams_hit[rec['team']] += 1
            lineups.append((teams_hit, pitcher_teams, names))
    return lineups

def main():
    # Load pro lineups
    pro_lineups = list(csv.DictReader(open(os.path.join(LIVE_AUDIT, 'pro_lineups.csv'), encoding='utf-8')))
    by_contest_pro = defaultdict(list)
    for r in pro_lineups:
        by_contest_pro[(r['contest_id'], r['user'])].append(r)

    print("=== TEAM-STACK OVERLAP per slate ===")
    print(f"{'slate':<10} {'pro':<22} {'pro_stack_teams (top 6)':<60} {'atlas_stack_teams (top 6)':<60} {'overlap%':>8}")
    print('-' * 170)

    matches = []
    for (cid, user), ls in by_contest_pro.items():
        mtime = float(ls[0]['mtime'])
        date_obj = datetime.fromtimestamp(mtime)
        # Try mtime and mtime-1 day
        for offset in [0, -1]:
            d_obj = datetime.fromtimestamp(date_obj.timestamp() + offset*86400)
            slate = f"{d_obj.month}-{d_obj.day}-{d_obj.year%100:02d}"
            by_name, by_id = load_proj(slate)
            if by_name: break
        if not by_name: continue

        # Pro: count 4+ stacks per team
        pro_stack_counts = Counter()
        primary_teams_per_lineup = []
        for r in ls:
            positions = parse_lineup(r['lineup'])
            teams_hit, _ = classify_pro_lineup_teams(positions, by_name)
            for t, n in teams_hit.items():
                if n >= 4:
                    pro_stack_counts[t] += 1
            if teams_hit:
                primary_teams_per_lineup.append(teams_hit.most_common(1)[0][0])
        n_lineups = len(ls)
        # Filter MLB main slate (>3.5 avg primary stack size — we don't have here, use lineups with team data)
        if not pro_stack_counts: continue

        # Find Atlas/Stacks output for this slate
        atlas_candidates = [
            f"theory_dfs_argus_anchor_preslate_150_anchor_{slate}.csv",
            f"theory_dfs_argus_stacks_preslate_150_stacks_{slate}.csv",
        ]
        atlas_stacks = None
        atlas_file = None
        for af in atlas_candidates:
            p = os.path.join(DFSOPTO, af)
            if os.path.exists(p):
                atlas_stacks = classify_atlas_csv(p, by_name, by_id)
                atlas_file = af
                break
        if not atlas_stacks: continue

        # Atlas: count 4+ stacks per team
        atlas_stack_counts = Counter()
        for teams_hit, _, _ in atlas_stacks:
            for t, n in teams_hit.items():
                if n >= 4:
                    atlas_stack_counts[t] += 1

        # Top 6 stack teams for each
        pro_top = pro_stack_counts.most_common(6)
        atlas_top = atlas_stack_counts.most_common(6)

        # Overlap of top-N
        top_n = 6
        pro_top_teams = set(t for t, _ in pro_top[:top_n])
        atlas_top_teams = set(t for t, _ in atlas_top[:top_n])
        overlap = len(pro_top_teams & atlas_top_teams) / max(1, len(pro_top_teams)) * 100

        pro_str = ', '.join(f"{t}({n})" for t, n in pro_top[:6])
        atlas_str = ', '.join(f"{t}({n})" for t, n in atlas_top[:6])
        print(f"{slate:<10} {user[:22]:<22} {pro_str:<60} {atlas_str:<60} {overlap:>7.0f}%")

        matches.append({
            'slate': slate, 'pro': user, 'pro_top': pro_top, 'atlas_top': atlas_top,
            'overlap_pct': overlap, 'atlas_file': atlas_file,
        })

    # Player-level Jaccard analysis for the matched slates
    print(f"\n=== LINEUP-LEVEL JACCARD SIMILARITY ===")
    for m in matches:
        slate = m['slate']
        pro = m['pro']
        atlas_file = m['atlas_file']
        # Re-extract pro lineups for this slate
        pro_set_list = []
        for (cid, u), ls in by_contest_pro.items():
            if u != pro: continue
            mtime = float(ls[0]['mtime'])
            date_obj = datetime.fromtimestamp(mtime)
            for offset in [0, -1]:
                d_obj = datetime.fromtimestamp(date_obj.timestamp() + offset*86400)
                if f"{d_obj.month}-{d_obj.day}-{d_obj.year%100:02d}" == slate:
                    for r in ls:
                        positions = parse_lineup(r['lineup'])
                        pro_set_list.append({norm_name(name) for pos, name in positions})
                    break
        if not pro_set_list: continue
        by_name, by_id = load_proj(slate)
        atlas_lineups = classify_atlas_csv(os.path.join(DFSOPTO, atlas_file), by_name, by_id)
        # For each Atlas lineup, find the best-matching pro lineup (max Jaccard)
        max_jaccards = []
        for _, _, atlas_names in atlas_lineups:
            best = 0
            for pro_names in pro_set_list:
                inter = len(atlas_names & pro_names)
                union = len(atlas_names | pro_names)
                if union:
                    j = inter / union
                    if j > best: best = j
            max_jaccards.append(best)
        avg_jac = sum(max_jaccards) / max(1, len(max_jaccards))
        # also: average per-lineup overlap
        print(f"  {slate} (pro={pro}): atlas-vs-pro avg max-Jaccard = {avg_jac:.2f}")

if __name__ == '__main__':
    main()
