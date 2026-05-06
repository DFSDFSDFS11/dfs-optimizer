"""
Stack Selection Concentration Analysis (Stages 1-7)

Descriptive measurement of where pros' stack concentration sits relative to
the field — chalk-stack territory or contrarian territory? — and how that
compares to V1.

Outputs:
- methodology.json
- field_stack_concentration.json
- v1_stack_patterns.json
- pro_stack_patterns.json
- field_relative_classification.csv
- winning_stack_hit_rates.csv
- jaccard_overlap.csv
- per_slate_diagnostics.csv
- FINDINGS.md (Stage 8)
"""

import os, json, csv, math, random, datetime
from collections import defaultdict, Counter

BASE = 'C:/Users/colin/dfs opto/'
DUMP = BASE + 'theory_dfs_v2/v1_pros_lineup_dump.json'
OUT = BASE + 'stack_selection_analysis/'
os.makedirs(OUT, exist_ok=True)

SLATES = [
    {'slate':'4-6-26','proj':'4-6-26_projections.csv','actuals':'dkactuals 4-6-26.csv'},
    {'slate':'4-8-26','proj':'4-8-26projections.csv','actuals':'4-8-26actuals.csv'},
    {'slate':'4-12-26','proj':'4-12-26projections.csv','actuals':'4-12-26actuals.csv'},
    {'slate':'4-14-26','proj':'4-14-26projections.csv','actuals':'4-14-26actuals.csv'},
    {'slate':'4-15-26','proj':'4-15-26projections.csv','actuals':'4-15-26actuals.csv'},
    {'slate':'4-17-26','proj':'4-17-26projections.csv','actuals':'4-17-26actuals.csv'},
    {'slate':'4-18-26','proj':'4-18-26projections.csv','actuals':'4-18-26actuals.csv'},
    {'slate':'4-19-26','proj':'4-19-26projections.csv','actuals':'4-19-26actuals.csv'},
    {'slate':'4-20-26','proj':'4-20-26projections.csv','actuals':'4-20-26actuals.csv'},
    {'slate':'4-21-26','proj':'4-21-26projections.csv','actuals':'4-21-26actuals.csv'},
    {'slate':'4-22-26','proj':'4-22-26projections.csv','actuals':'4-22-26actuals.csv'},
    {'slate':'4-23-26','proj':'4-23-26projections.csv','actuals':'4-23-26actuals.csv'},
    {'slate':'4-24-26','proj':'4-24-26projections.csv','actuals':'4-24-26actuals.csv'},
    {'slate':'4-25-26','proj':'4-25-26projections.csv','actuals':'4-25-26actuals.csv'},
    {'slate':'4-25-26-early','proj':'4-25-26projectionsearly.csv','actuals':'4-25-26actualsearly.csv'},
    {'slate':'4-26-26','proj':'4-26-26projections.csv','actuals':'4-26-26actuals.csv'},
    {'slate':'4-27-26','proj':'4-27-26projections.csv','actuals':'4-27-26actuals.csv'},
    {'slate':'4-28-26','proj':'4-28-26projections.csv','actuals':'4-28-26actuals.csv'},
    {'slate':'4-29-26','proj':'4-29-26projections.csv','actuals':'4-29-26actuals.csv'},
    {'slate':'5-1-26','proj':'5-1-26projections.csv','actuals':'5-1-26actuals.csv'},
    {'slate':'5-2-26','proj':'5-2-26projections.csv','actuals':'5-2-26actuals.csv'},
    {'slate':'5-2-26-main','proj':'5-2-26projectionsmain.csv','actuals':'5-2-26actualsmain.csv'},
    {'slate':'5-2-26-night','proj':'5-2-26projectionsnight.csv','actuals':'5-2-26actualsnight.csv'},
    {'slate':'5-3-26','proj':'5-3-26projections.csv','actuals':'5-3-26actuals.csv'},
]


# ---------------------------------------------------------------------------
# Load lineup dump
# ---------------------------------------------------------------------------
print('Loading lineup dump...')
with open(DUMP, 'r') as f:
    DUMP_DATA = json.load(f)
DUMP_BY_SLATE = {s['slate']: s for s in DUMP_DATA}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def safe_float(x, d=0.0):
    if x is None: return d
    s = str(x).strip().replace('%','')
    if s == '' or s.lower() in ('na','nan'): return d
    try: return float(s)
    except: return d


def is_pitcher(pos):
    p = (pos or '').upper()
    return 'P' in p and 'PH' not in p  # rough


def load_projections(path):
    """Returns {name: {'team', 'pos', 'own'}}. Hitters only matter for stacks
    but we still keep pitchers for completeness.
    Use 'Adj Own' if present, else 'My Own'."""
    rows = []
    with open(path, 'r', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        rows = list(reader)
    out = {}
    for r in rows:
        name = (r.get('Name') or '').strip()
        if not name: continue
        team = (r.get('Team') or '').strip().upper()
        pos = (r.get('Pos') or '').strip().upper()
        own_str = r.get('Adj Own')
        if own_str is None or own_str == '':
            own_str = r.get('My Own', '')
        own = safe_float(own_str, 0.0)
        out[name] = {'team': team, 'pos': pos, 'own': own}
    return out


def load_actuals(path):
    """Returns {name: fpts}. DK actuals embed Player + FPTS columns alongside
    rank/lineup data; many rows duplicate the same player. We dedupe by name."""
    out = {}
    with open(path, 'r', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        for r in reader:
            name = (r.get('Player') or '').strip()
            if not name: continue
            if name in out: continue  # first occurrence wins
            fpts = safe_float(r.get('FPTS', 0))
            out[name] = fpts
    return out


# ---------------------------------------------------------------------------
# Stage 1: field stack concentration from ownership
# ---------------------------------------------------------------------------
def compute_field_stack_share(projs):
    """For each team, take top-6 hitters by individual ownership, mean it,
    then ^4 to approximate probability the field randomly draws 4."""
    by_team = defaultdict(list)
    for name, p in projs.items():
        if not p['team']: continue
        if is_pitcher(p['pos']): continue
        by_team[p['team']].append(p['own'])
    out = {}
    for team, owns in by_team.items():
        if len(owns) < 4: continue  # not enough hitters
        owns_sorted = sorted(owns, reverse=True)[:6]
        mean_own = sum(owns_sorted) / len(owns_sorted)
        # interpret ownership as % (0-100); convert to 0-1
        share = (mean_own / 100.0) ** 4
        out[team] = {
            'mean_top6_own_pct': mean_own,
            'field_stack_share': share,
            'n_hitters_in_top6': len(owns_sorted),
        }
    return out


print('\n=== Stage 1: Field stack concentration ===')
field_concentration = {}
for s in SLATES:
    proj_path = BASE + s['proj']
    projs = load_projections(proj_path)
    fc = compute_field_stack_share(projs)
    if not fc:
        print(f"  {s['slate']}: NO TEAMS (proj missing?)")
        continue
    teams_ranked = sorted(fc.items(), key=lambda x: -x[1]['field_stack_share'])
    n = len(teams_ranked)
    top3 = [t for t,_ in teams_ranked[:3]]
    bottom_half = [t for t,_ in teams_ranked[n//2:]]
    field_concentration[s['slate']] = {
        'n_teams': n,
        'team_ranking': [
            {'rank': i+1, 'team': t, 'field_stack_share': v['field_stack_share'],
             'mean_top6_own_pct': v['mean_top6_own_pct']}
            for i,(t,v) in enumerate(teams_ranked)
        ],
        'chalk_top3': top3,
        'bottom_half': bottom_half,
    }
    print(f"  {s['slate']:18s} n_teams={n:2d}  chalk top3: {top3}")

with open(OUT + 'field_stack_concentration.json', 'w') as f:
    json.dump(field_concentration, f, indent=2)
print(f'\nSaved {OUT}field_stack_concentration.json')


# ---------------------------------------------------------------------------
# Stages 2 & 3: V1 + per-pro stack patterns
# ---------------------------------------------------------------------------
def stack_concentration_metrics(lineups):
    """Given a list of lineups (each has primaryTeam), compute top-N share
    and total unique teams used."""
    teams = [l.get('primaryTeam') or '__none__' for l in lineups]
    counts = Counter(teams)
    total = len(teams)
    if total == 0:
        return {'top1': 0, 'top2': 0, 'top3': 0, 'unique_teams': 0,
                'team_counts': {}, 'total_lineups': 0}
    most = counts.most_common()
    top1 = most[0][1] / total
    top2 = sum(c for _,c in most[:2]) / total
    top3 = sum(c for _,c in most[:3]) / total
    return {
        'top1': top1, 'top2': top2, 'top3': top3,
        'unique_teams': len([t for t,c in counts.items() if c > 0]),
        'team_counts': dict(counts),
        'total_lineups': total,
    }


print('\n=== Stage 2: V1 stack patterns ===')
v1_per_slate = {}
for s in SLATES:
    sname = s['slate']
    if sname not in DUMP_BY_SLATE: continue
    v1 = DUMP_BY_SLATE[sname].get('v1', [])
    m = stack_concentration_metrics(v1)
    v1_per_slate[sname] = m
    print(f"  {sname:18s} top1={m['top1']:.3f} top3={m['top3']:.3f} unique={m['unique_teams']:2d} N={m['total_lineups']}")

# Aggregate V1 across slates: macro-mean (mean of per-slate metrics)
def macro_mean(per_slate, key):
    vals = [v[key] for v in per_slate.values() if v['total_lineups'] > 0]
    if not vals: return 0.0
    return sum(vals)/len(vals)

v1_agg = {
    'avg_top1_share': macro_mean(v1_per_slate, 'top1'),
    'avg_top2_share': macro_mean(v1_per_slate, 'top2'),
    'avg_top3_share': macro_mean(v1_per_slate, 'top3'),
    'avg_unique_teams': macro_mean(v1_per_slate, 'unique_teams'),
    'n_slates': len([v for v in v1_per_slate.values() if v['total_lineups']>0]),
}
print(f"  V1 agg: top1={v1_agg['avg_top1_share']:.3f} top3={v1_agg['avg_top3_share']:.3f} unique_avg={v1_agg['avg_unique_teams']:.1f}")
with open(OUT + 'v1_stack_patterns.json', 'w') as f:
    json.dump({'per_slate': v1_per_slate, 'aggregate': v1_agg}, f, indent=2)


print('\n=== Stage 3: Per-pro stack patterns ===')
pro_per_slate = defaultdict(dict)  # pro -> slate -> metrics
for s in SLATES:
    sname = s['slate']
    if sname not in DUMP_BY_SLATE: continue
    pros = DUMP_BY_SLATE[sname].get('pros', [])
    by_user = defaultdict(list)
    for ln in pros:
        by_user[ln['user']].append(ln)
    for user, lns in by_user.items():
        if len(lns) < 5: continue
        m = stack_concentration_metrics(lns)
        pro_per_slate[user][sname] = m

pros_agg = {}
for user, slate_map in pro_per_slate.items():
    pros_agg[user] = {
        'avg_top1_share': macro_mean(slate_map, 'top1'),
        'avg_top2_share': macro_mean(slate_map, 'top2'),
        'avg_top3_share': macro_mean(slate_map, 'top3'),
        'avg_unique_teams': macro_mean(slate_map, 'unique_teams'),
        'n_slates': len(slate_map),
    }
    a = pros_agg[user]
    print(f"  {user:18s} top1={a['avg_top1_share']:.3f} top3={a['avg_top3_share']:.3f} unique_avg={a['avg_unique_teams']:.1f} slates={a['n_slates']}")

# "Average pro" = mean across pros (each pro weighted equally)
def avg_across_pros(metric):
    vals = [pros_agg[u][metric] for u in pros_agg]
    return sum(vals)/len(vals) if vals else 0

pros_avg = {
    'avg_top1_share': avg_across_pros('avg_top1_share'),
    'avg_top2_share': avg_across_pros('avg_top2_share'),
    'avg_top3_share': avg_across_pros('avg_top3_share'),
    'avg_unique_teams': avg_across_pros('avg_unique_teams'),
}
print(f"  AVERAGE PRO: top1={pros_avg['avg_top1_share']:.3f} top3={pros_avg['avg_top3_share']:.3f} unique_avg={pros_avg['avg_unique_teams']:.1f}")

with open(OUT + 'pro_stack_patterns.json', 'w') as f:
    json.dump({
        'per_pro_per_slate': dict(pro_per_slate),
        'per_pro_aggregate': pros_agg,
        'average_pro_aggregate': pros_avg,
    }, f, indent=2)


# ---------------------------------------------------------------------------
# Stage 4: Field-relative classification per lineup
# ---------------------------------------------------------------------------
print('\n=== Stage 4: Field-relative classification ===')


def classify_lineups_against_field(lineups, slate_field):
    """For each lineup, classify primaryTeam stack as:
       field-aligned (in top-3), mixed, or field-contrarian (bottom 50%).
    Returns counts dict + percentages."""
    if not slate_field:
        return None
    n = slate_field['n_teams']
    top3 = set(slate_field['chalk_top3'])
    bottom_set = set(slate_field['bottom_half'])
    counts = {'aligned': 0, 'mixed': 0, 'contrarian': 0, 'no_team': 0, 'unknown': 0}
    for l in lineups:
        t = l.get('primaryTeam')
        if not t:
            counts['no_team'] += 1
            continue
        if t in top3:
            counts['aligned'] += 1
        elif t in bottom_set:
            counts['contrarian'] += 1
        else:
            counts['mixed'] += 1
    total = sum(counts.values())
    if total == 0: return None
    return {
        'counts': counts,
        'pct_aligned': counts['aligned']/total,
        'pct_mixed': counts['mixed']/total,
        'pct_contrarian': counts['contrarian']/total,
        'total': total,
    }


# entity -> slate -> classification
v1_classifications = {}
pro_classifications = defaultdict(dict)

for s in SLATES:
    sname = s['slate']
    if sname not in DUMP_BY_SLATE: continue
    fc = field_concentration.get(sname)
    if not fc: continue

    v1 = DUMP_BY_SLATE[sname].get('v1', [])
    if v1:
        v1_classifications[sname] = classify_lineups_against_field(v1, fc)

    pros = DUMP_BY_SLATE[sname].get('pros', [])
    by_user = defaultdict(list)
    for ln in pros:
        by_user[ln['user']].append(ln)
    for user, lns in by_user.items():
        if len(lns) < 5: continue
        c = classify_lineups_against_field(lns, fc)
        if c is not None:
            pro_classifications[user][sname] = c


def aggregate_classification(slate_classifications):
    """Aggregate via macro-mean across slates."""
    if not slate_classifications: return None
    aligned = sum(c['pct_aligned'] for c in slate_classifications.values()) / len(slate_classifications)
    mixed = sum(c['pct_mixed'] for c in slate_classifications.values()) / len(slate_classifications)
    contra = sum(c['pct_contrarian'] for c in slate_classifications.values()) / len(slate_classifications)
    total_lns = sum(c['total'] for c in slate_classifications.values())
    return {
        'pct_aligned': aligned, 'pct_mixed': mixed, 'pct_contrarian': contra,
        'n_slates': len(slate_classifications), 'total_lineups': total_lns,
    }


v1_agg_class = aggregate_classification(v1_classifications)
pro_agg_class = {u: aggregate_classification(d) for u,d in pro_classifications.items()}

# Average pro = mean across pros
def avg_class_across_pros(key):
    vals = [pro_agg_class[u][key] for u in pro_agg_class if pro_agg_class[u]]
    return sum(vals)/len(vals) if vals else 0

avg_pro_class = {
    'pct_aligned': avg_class_across_pros('pct_aligned'),
    'pct_mixed': avg_class_across_pros('pct_mixed'),
    'pct_contrarian': avg_class_across_pros('pct_contrarian'),
}

# Save table
with open(OUT + 'field_relative_classification.csv', 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['Entity','pct_field_aligned','pct_mixed','pct_field_contrarian','avg_unique_stack_teams','n_slates'])
    if v1_agg_class:
        w.writerow(['V1', f"{v1_agg_class['pct_aligned']:.4f}",
                    f"{v1_agg_class['pct_mixed']:.4f}",
                    f"{v1_agg_class['pct_contrarian']:.4f}",
                    f"{v1_agg['avg_unique_teams']:.2f}",
                    v1_agg_class['n_slates']])
    for u in sorted(pro_agg_class.keys()):
        ac = pro_agg_class[u]
        if ac is None: continue
        w.writerow([u, f"{ac['pct_aligned']:.4f}",
                    f"{ac['pct_mixed']:.4f}",
                    f"{ac['pct_contrarian']:.4f}",
                    f"{pros_agg[u]['avg_unique_teams']:.2f}",
                    ac['n_slates']])
    w.writerow(['PRO_AVG', f"{avg_pro_class['pct_aligned']:.4f}",
                f"{avg_pro_class['pct_mixed']:.4f}",
                f"{avg_pro_class['pct_contrarian']:.4f}",
                f"{pros_avg['avg_unique_teams']:.2f}", ''])

print('\nClassification (entity / aligned / mixed / contrarian):')
if v1_agg_class:
    print(f"  V1            aligned={v1_agg_class['pct_aligned']:.3f} mixed={v1_agg_class['pct_mixed']:.3f} contra={v1_agg_class['pct_contrarian']:.3f}")
for u in sorted(pro_agg_class.keys()):
    ac = pro_agg_class[u]
    if ac is None: continue
    print(f"  {u:14s} aligned={ac['pct_aligned']:.3f} mixed={ac['pct_mixed']:.3f} contra={ac['pct_contrarian']:.3f}")
print(f"  PRO_AVG       aligned={avg_pro_class['pct_aligned']:.3f} mixed={avg_pro_class['pct_mixed']:.3f} contra={avg_pro_class['pct_contrarian']:.3f}")


# ---------------------------------------------------------------------------
# Stage 5: Winning stack hit rate
# ---------------------------------------------------------------------------
print('\n=== Stage 5: Winning stack identification + hit rates ===')


def compute_winning_stack(projs, actuals):
    """Winning stack = team whose 4 highest-scoring hitters (from actuals)
    summed highest. Ties: first by score, then alphabetical team."""
    by_team_scores = defaultdict(list)
    for name, p in projs.items():
        if is_pitcher(p['pos']): continue
        if not p['team']: continue
        s = actuals.get(name)
        if s is None: continue
        by_team_scores[p['team']].append(s)
    best_team = None; best_sum = -1e18
    team_sums = {}
    for team, scores in by_team_scores.items():
        if len(scores) < 4: continue
        top4 = sorted(scores, reverse=True)[:4]
        ts = sum(top4)
        team_sums[team] = ts
        if ts > best_sum:
            best_sum = ts; best_team = team
    return best_team, best_sum, team_sums


winning_stacks = {}
slate_n_teams = {}
for s in SLATES:
    sname = s['slate']
    proj_path = BASE + s['proj']
    act_path = BASE + s['actuals']
    if not (os.path.exists(proj_path) and os.path.exists(act_path)): continue
    projs = load_projections(proj_path)
    actuals = load_actuals(act_path)
    win_team, win_sum, team_sums = compute_winning_stack(projs, actuals)
    if win_team:
        winning_stacks[sname] = {'winning_team': win_team, 'winning_top4_sum': win_sum, 'team_sums': team_sums}
        n = len(field_concentration.get(sname,{}).get('team_ranking',[]))
        slate_n_teams[sname] = n
        print(f"  {sname:18s} winning stack: {win_team} ({win_sum:.1f}) [{n} teams]")
    else:
        print(f"  {sname:18s} no winning stack (insufficient data)")


def top1_team(lineups):
    if not lineups: return None
    counts = Counter(l.get('primaryTeam') for l in lineups if l.get('primaryTeam'))
    if not counts: return None
    return counts.most_common(1)[0][0]


# entity per-slate hit array: 1 if entity's top-1 stack matches winning, 0 else
entity_hits = {}  # name -> list of (slate, hit, n_teams)
v1_hits = []
for s in SLATES:
    sname = s['slate']
    if sname not in winning_stacks or sname not in DUMP_BY_SLATE: continue
    winT = winning_stacks[sname]['winning_team']
    v1 = DUMP_BY_SLATE[sname].get('v1', [])
    if not v1: continue
    t1 = top1_team(v1)
    n = slate_n_teams.get(sname, 0) or len(field_concentration.get(sname,{}).get('team_ranking',[]))
    v1_hits.append({'slate': sname, 'top1': t1, 'win': winT, 'hit': int(t1==winT), 'n_teams': n})
entity_hits['V1'] = v1_hits

for user in pro_per_slate:
    arr = []
    for s in SLATES:
        sname = s['slate']
        if sname not in winning_stacks or sname not in DUMP_BY_SLATE: continue
        winT = winning_stacks[sname]['winning_team']
        pros = [p for p in DUMP_BY_SLATE[sname].get('pros', []) if p['user']==user]
        if len(pros) < 5: continue
        t1 = top1_team(pros)
        n = slate_n_teams.get(sname, 0) or len(field_concentration.get(sname,{}).get('team_ranking',[]))
        arr.append({'slate': sname, 'top1': t1, 'win': winT, 'hit': int(t1==winT), 'n_teams': n})
    entity_hits[user] = arr


# Bootstrap CI: for hit rate. Resample slates with replacement N times,
# compute mean each time, take 2.5/97.5 percentiles.
def bootstrap_ci(hits_list, n_boot=10000, seed=42):
    if not hits_list: return (0.0, 0.0, 0.0)
    rng = random.Random(seed)
    n = len(hits_list)
    means = []
    for _ in range(n_boot):
        sample = [hits_list[rng.randint(0, n-1)] for _ in range(n)]
        means.append(sum(sample)/n)
    means.sort()
    lo = means[int(0.025*n_boot)]
    hi = means[int(0.975*n_boot)]
    return (sum(hits_list)/n, lo, hi)


# random baseline = 1 / mean(n_teams) across slates
n_teams_list = []
for s in SLATES:
    sname = s['slate']
    fc = field_concentration.get(sname)
    if fc and fc.get('n_teams'):
        n_teams_list.append(fc['n_teams'])
mean_n_teams = sum(n_teams_list)/len(n_teams_list) if n_teams_list else 1
random_baseline = 1.0 / mean_n_teams

# Average pro: per-slate, mean of pros' hit rate (each pro contributes 0/1 -> mean across pros for that slate)
pro_avg_hits = []
slates_with_winners = [s for s in winning_stacks]
# Build pro per-slate hit map first
for sname in slates_with_winners:
    if sname not in DUMP_BY_SLATE: continue
    by_user = defaultdict(list)
    for ln in DUMP_BY_SLATE[sname].get('pros', []):
        by_user[ln['user']].append(ln)
    if not by_user: continue
    winT = winning_stacks[sname]['winning_team']
    hits_for_slate = []
    for user, lns in by_user.items():
        if len(lns) < 5: continue
        hits_for_slate.append(int(top1_team(lns)==winT))
    if hits_for_slate:
        pro_avg_hits.append(sum(hits_for_slate)/len(hits_for_slate))


# Save winning_stack_hit_rates.csv
with open(OUT + 'winning_stack_hit_rates.csv', 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['Entity','hit_rate','ci_lo_95','ci_hi_95','n_slates','random_baseline'])
    for ent, arr in entity_hits.items():
        hits = [a['hit'] for a in arr]
        rate, lo, hi = bootstrap_ci(hits)
        w.writerow([ent, f"{rate:.4f}", f"{lo:.4f}", f"{hi:.4f}", len(arr), f"{random_baseline:.4f}"])
    rate, lo, hi = bootstrap_ci(pro_avg_hits)
    w.writerow(['PRO_AVG', f"{rate:.4f}", f"{lo:.4f}", f"{hi:.4f}", len(pro_avg_hits), f"{random_baseline:.4f}"])

print(f'\nRandom baseline hit rate (1/mean_n_teams = 1/{mean_n_teams:.1f}): {random_baseline:.3f}')
for ent, arr in entity_hits.items():
    hits = [a['hit'] for a in arr]
    rate, lo, hi = bootstrap_ci(hits)
    print(f"  {ent:14s} hit={rate:.3f} CI95=[{lo:.3f},{hi:.3f}] n={len(arr)}")
rate, lo, hi = bootstrap_ci(pro_avg_hits)
print(f"  {'PRO_AVG':14s} hit={rate:.3f} CI95=[{lo:.3f},{hi:.3f}] n={len(pro_avg_hits)}")


# ---------------------------------------------------------------------------
# Stage 6: Field/entity Jaccard
# ---------------------------------------------------------------------------
print('\n=== Stage 6: Field-entity Jaccard overlap ===')


def jaccard(a, b):
    A = set(a); B = set(b)
    if not A and not B: return 1.0
    if not (A | B): return 0.0
    return len(A & B) / len(A | B)


def entity_top_n_teams(lineups, n):
    counts = Counter(l.get('primaryTeam') for l in lineups if l.get('primaryTeam'))
    return [t for t,_ in counts.most_common(n)]


def field_top_n(slate_field, n):
    return [r['team'] for r in slate_field['team_ranking'][:n]]


jaccards = {}  # entity -> {top_n -> [per-slate jaccards]}
for ent in ['V1'] + list(pro_per_slate.keys()):
    jaccards[ent] = {2: [], 3: [], 5: []}
    for s in SLATES:
        sname = s['slate']
        if sname not in field_concentration: continue
        if ent == 'V1':
            lns = DUMP_BY_SLATE.get(sname,{}).get('v1', [])
        else:
            lns = [p for p in DUMP_BY_SLATE.get(sname,{}).get('pros', []) if p['user']==ent]
        if len(lns) < 5: continue
        for n in [2,3,5]:
            jaccards[ent][n].append(jaccard(entity_top_n_teams(lns, n), field_top_n(field_concentration[sname], n)))


def jmean(ent, n):
    arr = jaccards[ent][n]
    return sum(arr)/len(arr) if arr else 0


with open(OUT + 'jaccard_overlap.csv', 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['Entity','jaccard_top2','jaccard_top3','jaccard_top5','n_slates'])
    for ent in ['V1'] + sorted(pro_per_slate.keys()):
        if ent not in jaccards: continue
        w.writerow([ent, f"{jmean(ent,2):.4f}", f"{jmean(ent,3):.4f}", f"{jmean(ent,5):.4f}", len(jaccards[ent][3])])
    # Pro average
    pros_only = [u for u in pro_per_slate.keys() if u in jaccards]
    if pros_only:
        avg2 = sum(jmean(u,2) for u in pros_only) / len(pros_only)
        avg3 = sum(jmean(u,3) for u in pros_only) / len(pros_only)
        avg5 = sum(jmean(u,5) for u in pros_only) / len(pros_only)
        w.writerow(['PRO_AVG', f"{avg2:.4f}", f"{avg3:.4f}", f"{avg5:.4f}", ''])

for ent in ['V1'] + sorted(pro_per_slate.keys()):
    if ent not in jaccards: continue
    print(f"  {ent:14s} J@2={jmean(ent,2):.3f}  J@3={jmean(ent,3):.3f}  J@5={jmean(ent,5):.3f}")
pros_only = [u for u in pro_per_slate.keys() if u in jaccards]
if pros_only:
    print(f"  {'PRO_AVG':14s} J@2={sum(jmean(u,2) for u in pros_only)/len(pros_only):.3f}  J@3={sum(jmean(u,3) for u in pros_only)/len(pros_only):.3f}  J@5={sum(jmean(u,5) for u in pros_only)/len(pros_only):.3f}")


# ---------------------------------------------------------------------------
# Stage 7: Per-slate diagnostics + archetype patterns + conviction signal
# ---------------------------------------------------------------------------
print('\n=== Stage 7: Per-slate diagnostics ===')

per_slate_diag = []
for s in SLATES:
    sname = s['slate']
    if sname not in field_concentration or sname not in DUMP_BY_SLATE: continue
    fc = field_concentration[sname]
    fc_top3 = fc['chalk_top3']
    win = winning_stacks.get(sname, {}).get('winning_team')

    v1 = DUMP_BY_SLATE[sname].get('v1', [])
    v1_top1 = top1_team(v1)
    v1_top3 = entity_top_n_teams(v1, 3)

    pros_by_user = defaultdict(list)
    for ln in DUMP_BY_SLATE[sname].get('pros', []):
        pros_by_user[ln['user']].append(ln)
    pro_top1s = []
    pro_top1_set = []  # collect each pro's top-1
    for u, lns in pros_by_user.items():
        if len(lns) < 5: continue
        t = top1_team(lns)
        pro_top1s.append((u, t))
        if t: pro_top1_set.append(t)
    pro_top1_counts = Counter(pro_top1_set)
    pros_consensus_team = pro_top1_counts.most_common(1)[0][0] if pro_top1_counts else None
    pros_consensus_count = pro_top1_counts.most_common(1)[0][1] if pro_top1_counts else 0
    n_pros = len(pro_top1s)

    # Pros agreed but V1 missed?
    pros_agreed_v1_missed = (pros_consensus_count >= max(2, n_pros*0.5)) and (pros_consensus_team != v1_top1)

    # Pros concentrated heavily but V1 spread? (proxy: pros' avg top1 share - V1 top1 share)
    pros_avg_top1_share_slate = 0.0
    if pros_by_user:
        shares = []
        for u, lns in pros_by_user.items():
            if len(lns) < 5: continue
            counts = Counter(l.get('primaryTeam') for l in lns)
            shares.append(counts.most_common(1)[0][1]/len(lns))
        pros_avg_top1_share_slate = sum(shares)/len(shares) if shares else 0
    v1_top1_share_slate = v1_per_slate.get(sname, {}).get('top1', 0)
    concentration_gap = pros_avg_top1_share_slate - v1_top1_share_slate

    # Was winning stack neither V1 nor pros heavy?
    pro_top3_union = set()
    for u, lns in pros_by_user.items():
        if len(lns) < 5: continue
        for t in entity_top_n_teams(lns, 3): pro_top3_union.add(t)
    win_neither = (win is not None) and (win not in v1_top3) and (win not in pro_top3_union)

    # Was winning stack a chalk team or bottom-half?
    win_rank = None
    if win:
        for r in fc['team_ranking']:
            if r['team'] == win:
                win_rank = r['rank']; break
    win_pctile_inv = win_rank / fc['n_teams'] if win_rank and fc['n_teams'] else None  # 0=chalk, 1=contrarian

    # Conviction signal: pros' consensus team -> what was its rank in field?
    consensus_field_rank = None
    if pros_consensus_team:
        for r in fc['team_ranking']:
            if r['team'] == pros_consensus_team:
                consensus_field_rank = r['rank']; break

    per_slate_diag.append({
        'slate': sname,
        'n_teams': fc['n_teams'],
        'field_chalk_top3': fc_top3,
        'v1_top1': v1_top1,
        'v1_top3': v1_top3,
        'pros_consensus_team': pros_consensus_team,
        'pros_consensus_count_of_n': f"{pros_consensus_count}/{n_pros}",
        'pros_avg_top1_share': pros_avg_top1_share_slate,
        'v1_top1_share': v1_top1_share_slate,
        'concentration_gap': concentration_gap,
        'winning_team': win,
        'winning_team_field_rank': win_rank,
        'winning_team_field_rank_pctile': win_pctile_inv,
        'pros_consensus_field_rank': consensus_field_rank,
        'pros_agreed_v1_missed': pros_agreed_v1_missed,
        'winning_neither_heavy': win_neither,
    })

# Save
with open(OUT + 'per_slate_diagnostics.csv', 'w', newline='') as f:
    w = csv.DictWriter(f, fieldnames=list(per_slate_diag[0].keys()) if per_slate_diag else [])
    if per_slate_diag:
        w.writeheader()
        for r in per_slate_diag:
            row = dict(r)
            row['field_chalk_top3'] = '|'.join(row['field_chalk_top3'] or [])
            row['v1_top3'] = '|'.join(row['v1_top3'] or [])
            w.writerow(row)

# Top 3 most-divergent slates: rank by abs(concentration_gap) desc
divergent = sorted(per_slate_diag, key=lambda r: -abs(r['concentration_gap']))[:3]
print('Top 3 divergence slates (by |pros_top1 - v1_top1|):')
for r in divergent:
    print(f"  {r['slate']:18s} pros_top1_share={r['pros_avg_top1_share']:.3f} v1_top1_share={r['v1_top1_share']:.3f} gap={r['concentration_gap']:+.3f}")
    print(f"     pros_consensus={r['pros_consensus_team']} ({r['pros_consensus_count_of_n']})  v1_top1={r['v1_top1']}  win={r['winning_team']} (rank {r['winning_team_field_rank']})")

# Slates where pros agreed and V1 missed
pros_v1_misses = [r for r in per_slate_diag if r['pros_agreed_v1_missed']]
print(f'\nSlates where pros agreed but V1 missed: {len(pros_v1_misses)} / {len(per_slate_diag)}')
for r in pros_v1_misses[:5]:
    print(f"  {r['slate']:18s} pros_consensus={r['pros_consensus_team']} ({r['pros_consensus_count_of_n']}) vs v1_top1={r['v1_top1']}  win={r['winning_team']}")

# Slates where winning was neither V1 nor pros heavy
neither_heavy = [r for r in per_slate_diag if r['winning_neither_heavy']]
print(f'\nSlates where winning team was neither V1 nor pros heavy: {len(neither_heavy)} / {len(per_slate_diag)}')
for r in neither_heavy[:5]:
    print(f"  {r['slate']:18s} win={r['winning_team']} (rank {r['winning_team_field_rank']})")

# ---------------------------------------------------------------------------
# Conviction signal: features of pros' top-1 stack team
# (highest implied total / highest projection / lowest field-weighted projection?)
# We use Saber Total + projection from projections
# ---------------------------------------------------------------------------
print('\n=== Stage 7B: Conviction signal features ===')


def saber_total_by_team(projs, projs_full):
    out = {}
    for r in projs_full:
        t = (r.get('Team') or '').strip().upper()
        if not t: continue
        try:
            st = float(r.get('Saber Total','') or 0)
        except: st = 0
        if t not in out: out[t] = st
    return out


def projection_by_team(projs):
    """Sum of top-4 hitter projections per team (proxy for stack ceiling)."""
    by_team = defaultdict(list)
    for n, p in projs.items():
        if is_pitcher(p['pos']): continue
        if not p['team']: continue
    return None  # not used directly


def load_projs_full(path):
    with open(path,'r',encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        return list(reader)


# For each (slate, pro), measure whether pro's top-1 stack was the highest
# implied total team / highest projection-sum team / lowest field-stack-share team
conviction_records = []
for s in SLATES:
    sname = s['slate']
    if sname not in field_concentration or sname not in DUMP_BY_SLATE: continue
    proj_path = BASE + s['proj']
    if not os.path.exists(proj_path): continue
    rows = load_projs_full(proj_path)
    projs = load_projections(proj_path)
    saber_totals = {}
    for r in rows:
        t = (r.get('Team') or '').strip().upper()
        if not t or t in saber_totals: continue
        st = safe_float(r.get('Saber Total',''), 0)
        saber_totals[t] = st
    # team-wise top-4 hitter projection sum
    by_team_proj = defaultdict(list)
    proj_col = None
    for r in rows:
        if proj_col is None:
            for cand in ['My Proj','Live Proj','SS Proj']:
                if r.get(cand) not in (None,''):
                    proj_col = cand; break
        t = (r.get('Team') or '').strip().upper()
        pos = (r.get('Pos') or '').upper()
        if 'P' in pos and 'PH' not in pos: continue
        try: prj = float(r.get(proj_col,'') or 0)
        except: prj = 0
        by_team_proj[t].append(prj)
    team_top4_proj = {t: sum(sorted(v, reverse=True)[:4]) for t,v in by_team_proj.items() if len(v)>=4}

    fc = field_concentration[sname]
    field_share = {r['team']: r['field_stack_share'] for r in fc['team_ranking']}

    # Best in each metric
    best_saber = max(saber_totals.items(), key=lambda x: x[1])[0] if saber_totals else None
    best_proj = max(team_top4_proj.items(), key=lambda x: x[1])[0] if team_top4_proj else None
    best_value_team = None
    # "lowest field-ownership-weighted-projection" -> team with high projection AND low field share
    if team_top4_proj and field_share:
        # rank teams by (top4_proj rank) - (field_share rank), highest = best value
        team_proj_rank = sorted(team_top4_proj.keys(), key=lambda t: -team_top4_proj[t])
        team_share_rank = sorted([t for t in team_top4_proj if t in field_share], key=lambda t: field_share.get(t, 0))
        rank_proj = {t: i for i,t in enumerate(team_proj_rank)}
        rank_share = {t: i for i,t in enumerate(team_share_rank)}
        scores = {t: rank_share[t] - rank_proj[t] for t in team_proj_rank if t in rank_share}
        if scores:
            best_value_team = max(scores.items(), key=lambda x: x[1])[0]

    # For each pro
    by_user = defaultdict(list)
    for ln in DUMP_BY_SLATE[sname].get('pros', []):
        by_user[ln['user']].append(ln)
    for u, lns in by_user.items():
        if len(lns) < 5: continue
        t1 = top1_team(lns)
        if not t1: continue
        conviction_records.append({
            'slate': sname,
            'pro': u,
            'top1_team': t1,
            'matched_highest_implied_total': int(t1 == best_saber),
            'matched_highest_top4_proj': int(t1 == best_proj),
            'matched_best_value_team': int(t1 == best_value_team),
            'top1_field_share': field_share.get(t1, 0),
            'best_saber': best_saber,
            'best_proj': best_proj,
            'best_value': best_value_team,
        })

# V1 too
for s in SLATES:
    sname = s['slate']
    if sname not in field_concentration or sname not in DUMP_BY_SLATE: continue
    proj_path = BASE + s['proj']
    if not os.path.exists(proj_path): continue
    rows = load_projs_full(proj_path)
    saber_totals = {}
    for r in rows:
        t = (r.get('Team') or '').strip().upper()
        if not t or t in saber_totals: continue
        st = safe_float(r.get('Saber Total',''), 0)
        saber_totals[t] = st
    by_team_proj = defaultdict(list)
    proj_col = None
    for r in rows:
        if proj_col is None:
            for cand in ['My Proj','Live Proj','SS Proj']:
                if r.get(cand) not in (None,''):
                    proj_col = cand; break
        t = (r.get('Team') or '').strip().upper()
        pos = (r.get('Pos') or '').upper()
        if 'P' in pos and 'PH' not in pos: continue
        try: prj = float(r.get(proj_col,'') or 0)
        except: prj = 0
        by_team_proj[t].append(prj)
    team_top4_proj = {t: sum(sorted(v, reverse=True)[:4]) for t,v in by_team_proj.items() if len(v)>=4}
    fc = field_concentration[sname]
    field_share = {r['team']: r['field_stack_share'] for r in fc['team_ranking']}
    best_saber = max(saber_totals.items(), key=lambda x: x[1])[0] if saber_totals else None
    best_proj = max(team_top4_proj.items(), key=lambda x: x[1])[0] if team_top4_proj else None
    best_value_team = None
    if team_top4_proj and field_share:
        team_proj_rank = sorted(team_top4_proj.keys(), key=lambda t: -team_top4_proj[t])
        team_share_rank = sorted([t for t in team_top4_proj if t in field_share], key=lambda t: field_share.get(t, 0))
        rank_proj = {t: i for i,t in enumerate(team_proj_rank)}
        rank_share = {t: i for i,t in enumerate(team_share_rank)}
        scores = {t: rank_share[t] - rank_proj[t] for t in team_proj_rank if t in rank_share}
        if scores:
            best_value_team = max(scores.items(), key=lambda x: x[1])[0]
    v1 = DUMP_BY_SLATE[sname].get('v1', [])
    if not v1: continue
    t1 = top1_team(v1)
    if not t1: continue
    conviction_records.append({
        'slate': sname,
        'pro': 'V1',
        'top1_team': t1,
        'matched_highest_implied_total': int(t1 == best_saber),
        'matched_highest_top4_proj': int(t1 == best_proj),
        'matched_best_value_team': int(t1 == best_value_team),
        'top1_field_share': field_share.get(t1, 0),
        'best_saber': best_saber,
        'best_proj': best_proj,
        'best_value': best_value_team,
    })


# Aggregate conviction by entity
conv_by_ent = defaultdict(list)
for r in conviction_records:
    conv_by_ent[r['pro']].append(r)

with open(OUT + 'conviction_signal.csv', 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['Entity','pct_top1_was_highest_implied_total','pct_top1_was_highest_top4_proj','pct_top1_was_best_value_team','avg_top1_field_share','n_slates'])
    for ent, recs in conv_by_ent.items():
        if not recs: continue
        n = len(recs)
        a = sum(r['matched_highest_implied_total'] for r in recs)/n
        b = sum(r['matched_highest_top4_proj'] for r in recs)/n
        c = sum(r['matched_best_value_team'] for r in recs)/n
        d = sum(r['top1_field_share'] for r in recs)/n
        w.writerow([ent, f"{a:.4f}", f"{b:.4f}", f"{c:.4f}", f"{d:.6f}", n])

print('Conviction signal (% of times entity top-1 stack matched the team-level "best" by metric):')
for ent in sorted(conv_by_ent.keys()):
    recs = conv_by_ent[ent]
    if not recs: continue
    n = len(recs)
    a = sum(r['matched_highest_implied_total'] for r in recs)/n
    b = sum(r['matched_highest_top4_proj'] for r in recs)/n
    c = sum(r['matched_best_value_team'] for r in recs)/n
    d = sum(r['top1_field_share'] for r in recs)/n
    print(f"  {ent:14s} highest_implied_total={a:.3f}  highest_top4_proj={b:.3f}  best_value={c:.3f}  avg_top1_field_share={d:.5f}  n={n}")


# ---------------------------------------------------------------------------
# Save methodology + intermediate state for Stage 8
# ---------------------------------------------------------------------------
methodology = {
    'timestamp': datetime.datetime.now().isoformat(),
    'description': 'Stack selection concentration analysis: pros vs V1 vs field, descriptive only.',
    'slates': [s['slate'] for s in SLATES],
    'pros_in_dump': sorted({u for s in DUMP_DATA for u in {p['user'] for p in s['pros']}}),
    'min_lineups_per_pro_per_slate': 5,
    'field_stack_share_formula': '(mean ownership of top-6 hitters by individual ownership)^4, where ownership is in percent units (0-100) divided by 100 then ^4',
    'field_classification_buckets': {
        'aligned': 'primaryTeam in field-top-3 by field_stack_share',
        'contrarian': 'primaryTeam in field bottom-50% by field_stack_share',
        'mixed': 'else (between top-3 and bottom-half)',
    },
    'winning_stack_definition': "Team whose 4 highest-scoring hitters (from DK actuals) sum highest. Pitchers excluded.",
    'random_baseline_hit_rate': random_baseline,
    'mean_n_teams_per_slate': mean_n_teams,
    'bootstrap_n': 10000,
    'bootstrap_seed': 42,
    'jaccard_top_n': [2, 3, 5],
    'limitations': [
        'field_stack_share is approximated from individual ownership^4. Real field stack frequencies depend on covariance and stacking conventions; this overestimates concentration for high-own teams and underestimates noise.',
        'pro lineup pool may be biased: only 8 pros, all relatively concentrated portfolios.',
        '24 slates is a small sample for outcome metrics; bootstrap CIs reflect this.',
        'primaryTeam attribution comes from the dump; lineups without a 4+ stack may have noisy primaryTeam.',
        '4-25-26-early treated as a separate slate from 4-25-26 main; both contribute independently.',
        '5-2-26-night had no pro lineups in the dump.',
    ],
}
with open(OUT + 'methodology.json', 'w') as f:
    json.dump(methodology, f, indent=2)
print(f'\nSaved methodology to {OUT}methodology.json')


# ---------------------------------------------------------------------------
# Stage 8: FINDINGS.md
# ---------------------------------------------------------------------------
print('\n=== Stage 8: Producing FINDINGS.md ===')


def fmt_pct(x): return f"{x*100:.1f}%"


# For Stage 8C bootstrap
v1_rate, v1_lo, v1_hi = bootstrap_ci([a['hit'] for a in entity_hits.get('V1',[])])
pro_rate_avg, pro_lo_avg, pro_hi_avg = bootstrap_ci(pro_avg_hits)


# Construct FINDINGS body
lines = []
lines.append('# Stack Selection Concentration: Pros vs V1 vs Field')
lines.append('')
lines.append(f"_Analysis run: {methodology['timestamp']}_")
lines.append('')
lines.append('Descriptive measurement research: where does pros\' stack concentration sit relative to the field, and how does V1 differ?')
lines.append('')
lines.append('## Methodology Summary')
lines.append('- Slates: 24 MLB slates (4-6-26 through 5-3-26).')
lines.append(f"- Pros: {', '.join(methodology['pros_in_dump'])}.")
lines.append(f"- field_stack_share(T) = (mean(top-6 hitter ownership_T) / 100)^4. Approximation of probability the field stacks 4 from T.")
lines.append('- Field-aligned = primary stack is in field-top-3. Field-contrarian = primary stack in field bottom-50%. Else mixed.')
lines.append('- Winning stack: team whose 4 highest-scoring hitters (DK actuals) sum highest.')
lines.append('- Bootstrap CIs: 10,000 resamples over slates.')
lines.append('')

# 8A
lines.append('## 8A. Stack concentration (top-N share + unique stack teams used)')
lines.append('')
lines.append('| Entity | top-1 share | top-2 share | top-3 share | unique teams (avg/slate) | n_slates |')
lines.append('|---|---|---|---|---|---|')
lines.append(f"| **V1** | {fmt_pct(v1_agg['avg_top1_share'])} | {fmt_pct(v1_agg['avg_top2_share'])} | {fmt_pct(v1_agg['avg_top3_share'])} | {v1_agg['avg_unique_teams']:.1f} | {v1_agg['n_slates']} |")
for u in sorted(pros_agg.keys()):
    a = pros_agg[u]
    lines.append(f"| {u} | {fmt_pct(a['avg_top1_share'])} | {fmt_pct(a['avg_top2_share'])} | {fmt_pct(a['avg_top3_share'])} | {a['avg_unique_teams']:.1f} | {a['n_slates']} |")
lines.append(f"| **PRO_AVG** | {fmt_pct(pros_avg['avg_top1_share'])} | {fmt_pct(pros_avg['avg_top2_share'])} | {fmt_pct(pros_avg['avg_top3_share'])} | {pros_avg['avg_unique_teams']:.1f} | — |")
lines.append('')

# 8B
lines.append('## 8B. Field-relative classification')
lines.append('')
lines.append('| Entity | % field-aligned | % mixed | % field-contrarian | unique stack teams (avg/slate) | n_slates |')
lines.append('|---|---|---|---|---|---|')
if v1_agg_class:
    lines.append(f"| **V1** | {fmt_pct(v1_agg_class['pct_aligned'])} | {fmt_pct(v1_agg_class['pct_mixed'])} | {fmt_pct(v1_agg_class['pct_contrarian'])} | {v1_agg['avg_unique_teams']:.1f} | {v1_agg_class['n_slates']} |")
for u in sorted(pro_agg_class.keys()):
    ac = pro_agg_class[u]
    if ac is None: continue
    lines.append(f"| {u} | {fmt_pct(ac['pct_aligned'])} | {fmt_pct(ac['pct_mixed'])} | {fmt_pct(ac['pct_contrarian'])} | {pros_agg[u]['avg_unique_teams']:.1f} | {ac['n_slates']} |")
lines.append(f"| **PRO_AVG** | {fmt_pct(avg_pro_class['pct_aligned'])} | {fmt_pct(avg_pro_class['pct_mixed'])} | {fmt_pct(avg_pro_class['pct_contrarian'])} | {pros_avg['avg_unique_teams']:.1f} | — |")
lines.append('')

# 8C
lines.append('## 8C. Winning-stack hit rates (bootstrap 95% CIs)')
lines.append('')
lines.append('| Entity | hit rate | 95% CI | n slates |')
lines.append('|---|---|---|---|')
for ent in ['V1'] + sorted(pro_per_slate.keys()):
    arr = entity_hits.get(ent, [])
    hits = [a['hit'] for a in arr]
    rate, lo, hi = bootstrap_ci(hits)
    lines.append(f"| {ent} | {fmt_pct(rate)} | [{fmt_pct(lo)}, {fmt_pct(hi)}] | {len(arr)} |")
lines.append(f"| **PRO_AVG** | {fmt_pct(pro_rate_avg)} | [{fmt_pct(pro_lo_avg)}, {fmt_pct(pro_hi_avg)}] | {len(pro_avg_hits)} |")
lines.append(f"| Random baseline (1/{mean_n_teams:.1f}) | {fmt_pct(random_baseline)} | — | — |")
lines.append('')

# 8D
lines.append('## 8D. Field-entity Jaccard overlap')
lines.append('')
lines.append('| Entity | J@2 | J@3 | J@5 | n_slates |')
lines.append('|---|---|---|---|---|')
for ent in ['V1'] + sorted(pro_per_slate.keys()):
    if ent not in jaccards: continue
    lines.append(f"| {ent} | {jmean(ent,2):.3f} | {jmean(ent,3):.3f} | {jmean(ent,5):.3f} | {len(jaccards[ent][3])} |")
if pros_only:
    lines.append(f"| **PRO_AVG** | {sum(jmean(u,2) for u in pros_only)/len(pros_only):.3f} | {sum(jmean(u,3) for u in pros_only)/len(pros_only):.3f} | {sum(jmean(u,5) for u in pros_only)/len(pros_only):.3f} | — |")
lines.append('')
lines.append('Interpretation thresholds: J@3 > 0.7 → field-aligned (exploit not at stack selection). J@3 < 0.3 → field-contrarian (exploit IS stack selection).')
lines.append('')

# 8E
lines.append('## 8E. Specific patterns')
lines.append('')
lines.append('### Top 3 most-divergent slates (|pros_top1_share - V1_top1_share|)')
lines.append('')
lines.append('| Slate | pros_top1_share | V1_top1_share | gap | pros_consensus | V1_top1 | winner | winner_field_rank |')
lines.append('|---|---|---|---|---|---|---|---|')
for r in divergent:
    lines.append(f"| {r['slate']} | {r['pros_avg_top1_share']:.3f} | {r['v1_top1_share']:.3f} | {r['concentration_gap']:+.3f} | {r['pros_consensus_team']} ({r['pros_consensus_count_of_n']}) | {r['v1_top1']} | {r['winning_team']} | {r['winning_team_field_rank']} |")
lines.append('')
lines.append(f"### Slates where pros agreed and V1 missed: {len(pros_v1_misses)} / {len(per_slate_diag)}")
if pros_v1_misses:
    lines.append('')
    lines.append('| Slate | pros_consensus | (count) | V1_top1 | winner |')
    lines.append('|---|---|---|---|---|')
    for r in pros_v1_misses:
        lines.append(f"| {r['slate']} | {r['pros_consensus_team']} | {r['pros_consensus_count_of_n']} | {r['v1_top1']} | {r['winning_team']} |")
lines.append('')
lines.append(f"### Slates where winner was neither V1 nor pros heavy: {len(neither_heavy)} / {len(per_slate_diag)}")
if neither_heavy:
    lines.append('')
    lines.append('| Slate | winner | winner_field_rank | n_teams |')
    lines.append('|---|---|---|---|')
    for r in neither_heavy:
        lines.append(f"| {r['slate']} | {r['winning_team']} | {r['winning_team_field_rank']} | {r['n_teams']} |")
lines.append('')

# Conviction signal
lines.append('### Conviction signal: what features did each entity\'s top-1 stack team have?')
lines.append('')
lines.append('| Entity | % top-1 = highest implied total | % top-1 = highest top-4 projection sum | % top-1 = best value (high proj × low field share) | avg top-1 field_stack_share | n |')
lines.append('|---|---|---|---|---|---|')
for ent in sorted(conv_by_ent.keys(), key=lambda e: ('A' if e=='V1' else 'B'+e)):
    recs = conv_by_ent[ent]
    if not recs: continue
    n = len(recs)
    a = sum(r['matched_highest_implied_total'] for r in recs)/n
    b = sum(r['matched_highest_top4_proj'] for r in recs)/n
    c = sum(r['matched_best_value_team'] for r in recs)/n
    d = sum(r['top1_field_share'] for r in recs)/n
    lines.append(f"| {ent} | {fmt_pct(a)} | {fmt_pct(b)} | {fmt_pct(c)} | {d:.5f} | {n} |")
lines.append('')

# 8F: Verdict
v1_pct_aligned = v1_agg_class['pct_aligned'] if v1_agg_class else 0
pro_pct_aligned = avg_pro_class['pct_aligned']
pro_jaccard3 = sum(jmean(u,3) for u in pros_only)/len(pros_only) if pros_only else 0
v1_jaccard3 = jmean('V1',3)
pro_pct_contra = avg_pro_class['pct_contrarian']

# Decision rules
verdict = None
verdict_reason = []
if pro_jaccard3 > 0.7 and pro_pct_aligned > 0.5:
    verdict = '**Pros stack field-aligned.** Exploit is elsewhere — within-stack execution, salary efficiency, lineup construction, etc.'
    verdict_reason.append(f"PRO_AVG J@3 = {pro_jaccard3:.3f} (> 0.7 threshold) and {fmt_pct(pro_pct_aligned)} of pro stacks are in field top-3.")
elif pro_jaccard3 < 0.3 and pro_pct_contra > 0.4:
    verdict = '**Pros stack field-contrarian.** Pros\' edge IS at stack-selection level. Exploit identified.'
    verdict_reason.append(f"PRO_AVG J@3 = {pro_jaccard3:.3f} (< 0.3 threshold) and {fmt_pct(pro_pct_contra)} of pro stacks are field-contrarian.")
elif v1_rate > pro_rate_avg + 0.05:
    verdict = '**V1 outperforms pros on outcome metrics despite different patterns.** V1\'s spreading is a feature, not a bug.'
    verdict_reason.append(f"V1 hit rate {fmt_pct(v1_rate)} > PRO_AVG {fmt_pct(pro_rate_avg)} by 5+ pct points.")
else:
    # Check for slate-conditional pattern
    pro_share_var = 0
    if pros_only and len(pros_only) > 1:
        per_slate_concentration = []
        for sname in [sl for sl in v1_per_slate if sl in DUMP_BY_SLATE]:
            shares = []
            for u in pros_only:
                pross = [p for p in DUMP_BY_SLATE.get(sname,{}).get('pros',[]) if p['user']==u]
                if len(pross) >= 5:
                    counts = Counter(l.get('primaryTeam') for l in pross)
                    if counts:
                        shares.append(counts.most_common(1)[0][1]/len(pross))
            if shares:
                per_slate_concentration.append(sum(shares)/len(shares))
        # var
        if len(per_slate_concentration) > 1:
            mean_c = sum(per_slate_concentration)/len(per_slate_concentration)
            pro_share_var = sum((x-mean_c)**2 for x in per_slate_concentration)/len(per_slate_concentration)
    if pro_share_var > 0.02:  # pros' top-1 share varies a lot
        verdict = '**Pros\' concentration varies by slate archetype.** Slate-conditional logic is the exploit pattern.'
        verdict_reason.append(f"Pros\' per-slate top-1 share variance = {pro_share_var:.4f} (high cross-slate variability).")
    else:
        verdict = f'**Mixed/intermediate.** PRO_AVG J@3 = {pro_jaccard3:.3f}, % aligned = {fmt_pct(pro_pct_aligned)}, % contrarian = {fmt_pct(pro_pct_contra)}. Pros lean modestly chalk but with notable contrarian tail; not a clean exploit-IS-here verdict.'
        verdict_reason.append(f"PRO_AVG J@3 ({pro_jaccard3:.3f}) sits between 0.3 and 0.7. % aligned ({fmt_pct(pro_pct_aligned)}) below 0.5 and % contrarian ({fmt_pct(pro_pct_contra)}) below 0.4.")

lines.append('## 8F. Verdict')
lines.append('')
lines.append(verdict)
lines.append('')
lines.append('**Reasoning:**')
for r in verdict_reason: lines.append(f"- {r}")
lines.append('')
lines.append('**Supporting numbers:**')
lines.append(f"- V1: {fmt_pct(v1_pct_aligned)} aligned / {fmt_pct(v1_agg_class['pct_mixed'])} mixed / {fmt_pct(v1_agg_class['pct_contrarian'])} contrarian. Avg unique stacks/slate = {v1_agg['avg_unique_teams']:.1f}. Hit rate {fmt_pct(v1_rate)}.")
lines.append(f"- PRO_AVG: {fmt_pct(pro_pct_aligned)} aligned / {fmt_pct(avg_pro_class['pct_mixed'])} mixed / {fmt_pct(pro_pct_contra)} contrarian. Avg unique stacks/slate = {pros_avg['avg_unique_teams']:.1f}. Hit rate {fmt_pct(pro_rate_avg)}.")
lines.append(f"- V1 J@3 = {v1_jaccard3:.3f}, PRO_AVG J@3 = {pro_jaccard3:.3f}. (Higher = more overlap with field's chalkiest 3 stacks.)")
lines.append(f"- Random hit-rate baseline = {fmt_pct(random_baseline)}.")
lines.append('')

# 8G: Implications
lines.append('## 8G. Implications for V1 (research direction notes only)')
lines.append('')
if 'field-aligned' in verdict:
    lines.append('Pros stack the same chalk teams as the field. The exploit is NOT at stack-selection level. Future research direction: investigate within-stack player choice (which 4 of 8 hitters), salary allocation efficiency, pitcher-vs-stack pairing, and bring-back construction. V1\'s current spread-across-many-teams behavior is the PROBLEM relative to pros, but copying pros\' chalk-stack selection is not the answer either — the structural difference must be that pros pick the right hitter combination within a chalk stack while V1 dilutes across teams.')
elif 'field-contrarian' in verdict:
    lines.append('Pros consistently pick stacks the field misses. The exploit IS at stack-selection level. Future research direction: build a stack-selection layer that scores teams on (high projection × low field_stack_share) and forces V1 to concentrate primary stacks on top 1-2 of those teams. Validate against the conviction signal characteristics found in this analysis.')
elif 'V1 outperforms' in verdict:
    lines.append('V1\'s spreading actually wins on outcome metrics. Future research direction: do not change stack-selection logic. Investigate whether V1\'s edge is in lineup-level diversity, pitcher selection, or projection model accuracy. The pro pool may be biased toward concentrated portfolios that are theoretically optimal for ROI tail but suboptimal for hit-rate measurement.')
elif 'Mixed' in verdict or 'slate archetype' in verdict:
    lines.append('Pros\' stack-selection pattern is not uniformly chalky or contrarian. Future research direction: examine whether pros are slate-conditional (concentrate on chalk when implied totals are extreme; spread when slate is flat). Cluster slates by features (number of teams, ownership variance, top-team implied total spread) and look for distinct concentration regimes. V1 may benefit from a slate-conditional concentration policy rather than a fixed posture.')
else:
    lines.append('Findings are intermediate. Inspect per-slate diagnostics to see whether a slate-conditional pattern explains the spread.')
lines.append('')
lines.append('## Limitations')
for lim in methodology['limitations']:
    lines.append(f"- {lim}")
lines.append('')

with open(OUT + 'FINDINGS.md', 'w', encoding='utf-8') as f:
    f.write('\n'.join(lines))

print(f'\nSaved FINDINGS.md to {OUT}FINDINGS.md')
print('\n=== DONE ===')
