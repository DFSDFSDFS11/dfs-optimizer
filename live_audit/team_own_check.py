"""Check team-stack ownership: are pros stacking lower-owned teams than Atlas?"""
import csv, os, re
from collections import Counter, defaultdict
from datetime import datetime, timedelta

LIVE_AUDIT = 'C:/Users/colin/Projects/dfs-optimizer/live_audit'
DFSOPTO = 'C:/Users/colin/dfs opto'
POS_RE = r'(?:P|C|1B|2B|3B|SS|OF|CPT|FLEX|UTIL|PG|SG|SF|PF|G|F)'

def parse_lineup(s):
    parts = re.split(r'\s+(?=' + POS_RE + r'\s+\w)', s.strip())
    out = []
    for p in parts:
        m = re.match(r'^(' + POS_RE + r')\s+(.+)$', p.strip())
        if m: out.append((m.group(1), m.group(2).strip()))
    return out

def norm(n): return re.sub(r'[^a-z0-9 ]+', '', n.lower()).strip()

def analyze_slate(slate_proj_file, slate_label, pro_lineups_for_slate):
    proj = {}
    team_hitters = defaultdict(list)
    with open(slate_proj_file, encoding='utf-8') as f:
        for r in csv.DictReader(f):
            nm = norm(r.get('Name',''))
            team = (r.get('Team') or '').strip().upper()
            try:
                own = float((r.get('Adj Own') or '0').replace('%','') or 0)
                proj_v = float(r.get('My Proj') or r.get('SS Proj') or 0)
            except ValueError:
                continue
            pos = (r.get('Pos') or '').strip()
            proj[nm] = {'team': team, 'own': own, 'proj': proj_v, 'pos': pos}
            if pos != 'P':
                team_hitters[team].append((proj_v, own))

    team_top5 = {}
    for t, ps in team_hitters.items():
        ps.sort(reverse=True)
        top5 = ps[:5]
        team_top5[t] = {
            'proj': sum(p for p, _ in top5),
            'own': sum(o for _, o in top5),
        }

    print(f"\n=== {slate_label} TOP-PROJECTION TEAMS ===")
    sorted_proj = sorted(team_top5.items(), key=lambda x: -x[1]['proj'])
    print(f"{'team':<5} {'top5_proj':>10} {'top5_own':>10}")
    for t, s in sorted_proj[:14]:
        print(f"{t:<5} {s['proj']:>10.1f} {s['own']:>10.1f}")

    # Pro stack choices
    print(f"\n=== {slate_label} PRO STACK CHOICES ===")
    by_pro = defaultdict(list)
    for r in pro_lineups_for_slate: by_pro[r['user']].append(r)
    for user, ls in sorted(by_pro.items()):
        stack_count = Counter()
        for r in ls:
            positions = parse_lineup(r['lineup'])
            teams = Counter()
            for pos, name in positions:
                rec = proj.get(norm(name))
                if rec and pos != 'P': teams[rec['team']] += 1
            for t, n in teams.items():
                if n >= 4: stack_count[t] += 1
        top = stack_count.most_common(6)
        s = ', '.join(f"{t}({n},own{team_top5.get(t,{}).get('own',0):.0f})" for t, n in top)
        print(f"  {user[:22]:<22}: {s}")

def main():
    pro_lineups = list(csv.DictReader(open(os.path.join(LIVE_AUDIT, 'pro_lineups.csv'), encoding='utf-8')))
    by_slate = defaultdict(list)
    for r in pro_lineups:
        mtime = float(r['mtime'])
        date_obj = datetime.fromtimestamp(mtime)
        slate_obj = date_obj - timedelta(days=1)
        slate = f'{slate_obj.month}-{slate_obj.day}-{slate_obj.year%100:02d}'
        by_slate[slate].append(r)

    # Focus on slates where we have data
    for slate in ['5-10-26', '5-9-26', '5-5-26', '5-3-26', '4-28-26']:
        proj_file = os.path.join(DFSOPTO, f'{slate}projections.csv')
        if not os.path.exists(proj_file): continue
        analyze_slate(proj_file, slate, by_slate.get(slate, []))

if __name__ == '__main__':
    main()
