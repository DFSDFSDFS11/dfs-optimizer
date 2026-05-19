"""
Factor Engine v5 — Massive groupby feature generation per Kaggle methodology.

Per the spec:
  "The most powerful feature engineering technique is groupby aggregations.
   Per-lineup groupby team: For each team, compute mean projection, max projection, sum.
   Per-lineup groupby salary tier: Bucket players by salary tier. Count, mean, sum.
   Per-lineup groupby position: Pitcher/infielder/outfielder/utility aggregates."

Reads factor_frame_v4 + all_lineups (for the actual player breakdowns).
Adds 50+ groupby features. Outputs factor_frame_v5.csv.
"""
import csv, os, re, sys, json, time
from collections import Counter, defaultdict
import numpy as np
import pandas as pd

LIVE_AUDIT = "C:/Users/colin/Projects/dfs-optimizer/live_audit"
DFSOPTO = "C:/Users/colin/dfs opto"
POS_RE = r'(?:P|C|1B|2B|3B|SS|OF|CPT|FLEX|UTIL)'

def parse_lineup(s):
    if not s: return []
    parts = re.split(r'\s+(?=' + POS_RE + r'\s+\w)', s.strip())
    out = []
    for p in parts:
        m = re.match(r'^(' + POS_RE + r')\s+(.+)$', p.strip())
        if m: out.append((m.group(1), m.group(2).strip()))
    return out

def norm(n): return re.sub(r'[^a-z0-9 ]+', '', n.lower()).strip()

def load_proj(slate):
    for c in [f"{slate}projections.csv", f"{slate}_projections.csv"]:
        p = os.path.join(DFSOPTO, c)
        if os.path.exists(p):
            by_name = {}
            with open(p, encoding='utf-8') as f:
                for r in csv.DictReader(f):
                    nm = norm(r.get('Name',''))
                    if not nm: continue
                    try:
                        rec = {
                            'team': (r.get('Team') or '').strip().upper(),
                            'opp': (r.get('Opp') or '').strip().upper(),
                            'salary': float(r.get('Salary', 0) or 0),
                            'own': float((r.get('Adj Own') or '0').replace('%','') or 0),
                            'proj': float(r.get('My Proj') or r.get('SS Proj') or 0),
                            'ceil_85': float(r.get('dk_85_percentile') or 0),
                            'ceil_99': float(r.get('dk_99_percentile') or 0),
                            'pos': (r.get('Pos') or '').strip(),
                        }
                        if nm not in by_name: by_name[nm] = rec
                    except (ValueError, TypeError): continue
            return by_name
    return None

def compute_groupby_features(positions, proj):
    """Compute massive groupby features for one lineup."""
    feats = {}
    matched = []
    for pos, name in positions:
        rec = proj.get(norm(name))
        if rec: matched.append((pos, name, rec))
    if len(matched) < 7: return None

    # ============ GROUPBY TEAM ============
    by_team = defaultdict(list)
    for pos, n, r in matched:
        if pos == 'P': continue
        by_team[r['team']].append(r)

    team_projs = []; team_owns = []; team_sals = []; team_ceils = []
    team_sizes = []
    for t, players in by_team.items():
        t_proj = sum(p['proj'] for p in players)
        t_own = sum(p['own'] for p in players)
        t_sal = sum(p['salary'] for p in players)
        t_ceil = sum(p['ceil_85'] for p in players)
        team_projs.append(t_proj)
        team_owns.append(t_own)
        team_sals.append(t_sal)
        team_ceils.append(t_ceil)
        team_sizes.append(len(players))

    if team_projs:
        feats['team_proj_max'] = max(team_projs)
        feats['team_proj_min'] = min(team_projs)
        feats['team_proj_mean'] = np.mean(team_projs)
        feats['team_proj_std'] = np.std(team_projs)
        feats['team_proj_range'] = max(team_projs) - min(team_projs)
        feats['team_own_max'] = max(team_owns)
        feats['team_own_min'] = min(team_owns)
        feats['team_own_mean'] = np.mean(team_owns)
        feats['team_own_std'] = np.std(team_owns)
        feats['team_sal_max'] = max(team_sals)
        feats['team_ceil_max'] = max(team_ceils)
        feats['team_ceil_sum'] = sum(team_ceils)
        feats['n_teams_in_lineup'] = len(by_team)
        # Top-team metrics
        idx_top = np.argmax(team_projs)
        feats['top_team_proj'] = team_projs[idx_top]
        feats['top_team_own'] = team_owns[idx_top]
        feats['top_team_size'] = team_sizes[idx_top]
        feats['top_team_proj_per_player'] = team_projs[idx_top] / max(1, team_sizes[idx_top])
        # Top-team is biggest stack ratio
        feats['top_team_size_frac'] = team_sizes[idx_top] / sum(team_sizes)
    else:
        for k in ['team_proj_max','team_proj_min','team_proj_mean','team_proj_std','team_proj_range',
                  'team_own_max','team_own_min','team_own_mean','team_own_std','team_sal_max',
                  'team_ceil_max','team_ceil_sum','n_teams_in_lineup','top_team_proj','top_team_own',
                  'top_team_size','top_team_proj_per_player','top_team_size_frac']:
            feats[k] = 0

    # ============ GROUPBY SALARY TIER ============
    sals = [r['salary'] for p, n, r in matched]
    projs = [r['proj'] for p, n, r in matched]
    owns = [r['own'] for p, n, r in matched]
    ceils = [r['ceil_85'] for p, n, r in matched]
    tiers = [
        ('under_3k', lambda s: s < 3000),
        ('3k_to_4k', lambda s: 3000 <= s < 4000),
        ('4k_to_5k', lambda s: 4000 <= s < 5000),
        ('5k_to_6k', lambda s: 5000 <= s < 6000),
        ('6k_to_7k', lambda s: 6000 <= s < 7000),
        ('7k_to_8k', lambda s: 7000 <= s < 8000),
        ('8k_to_9k', lambda s: 8000 <= s < 9000),
        ('9k_plus', lambda s: s >= 9000),
    ]
    for tier_name, tier_func in tiers:
        mask = [tier_func(s) for s in sals]
        n_tier = sum(mask)
        feats[f'tier_{tier_name}_count'] = n_tier
        if n_tier > 0:
            tier_projs = [p for p, m in zip(projs, mask) if m]
            tier_owns = [o for o, m in zip(owns, mask) if m]
            feats[f'tier_{tier_name}_proj_sum'] = sum(tier_projs)
            feats[f'tier_{tier_name}_own_sum'] = sum(tier_owns)
            feats[f'tier_{tier_name}_proj_mean'] = np.mean(tier_projs)
        else:
            feats[f'tier_{tier_name}_proj_sum'] = 0
            feats[f'tier_{tier_name}_own_sum'] = 0
            feats[f'tier_{tier_name}_proj_mean'] = 0

    # ============ GROUPBY POSITION (HITTER vs PITCHER) ============
    p_data = [(r['proj'], r['own'], r['salary'], r['ceil_85']) for pos, n, r in matched if pos == 'P']
    h_data = [(r['proj'], r['own'], r['salary'], r['ceil_85']) for pos, n, r in matched if pos != 'P']
    if p_data:
        p_proj = [x[0] for x in p_data]; p_own = [x[1] for x in p_data]
        p_sal = [x[2] for x in p_data]; p_ceil = [x[3] for x in p_data]
        feats['p_proj_max'] = max(p_proj); feats['p_proj_min'] = min(p_proj)
        feats['p_proj_diff'] = max(p_proj) - min(p_proj)
        feats['p_own_max'] = max(p_own); feats['p_own_min'] = min(p_own)
        feats['p_own_diff'] = max(p_own) - min(p_own)
        feats['p_sal_max'] = max(p_sal); feats['p_sal_diff'] = max(p_sal) - min(p_sal)
        feats['p_ceil_max'] = max(p_ceil); feats['p_ceil_min'] = min(p_ceil)
        # P-to-H ratios
        if h_data:
            h_proj_mean = np.mean([x[0] for x in h_data])
            feats['p_to_h_proj_ratio'] = np.mean(p_proj) / max(0.01, h_proj_mean)
            feats['p_to_h_sal_ratio'] = np.mean(p_sal) / max(1, np.mean([x[2] for x in h_data]))

    # ============ INTERACTION FEATURES ============
    proj_sum = sum(projs); own_sum = sum(owns); sal_sum = sum(sals); ceil_sum = sum(ceils)
    proj_max = max(projs); own_max = max(owns)
    feats['proj_x_own_max'] = proj_sum * own_max
    feats['proj_max_x_own_max'] = proj_max * own_max
    feats['ceil_x_sal'] = ceil_sum * (sal_sum / 1000)
    feats['proj_x_inverse_own'] = proj_sum / max(0.001, own_sum)
    feats['ceil_x_inverse_own'] = ceil_sum / max(0.001, own_sum)
    feats['proj_sq_per_own'] = (proj_sum ** 2) / max(0.001, own_sum)
    feats['ceil_minus_proj_per_own'] = (ceil_sum - proj_sum) / max(0.001, own_sum)
    # Cross-position interactions
    if p_data and h_data:
        p_max = max([x[0] for x in p_data])
        h_max = max([x[0] for x in h_data])
        feats['p_max_x_h_max_proj'] = p_max * h_max
        feats['p_max_x_top_team_proj'] = p_max * feats.get('top_team_proj', 0)

    # ============ STACK-DEPTH FEATURES ============
    # How "deep" is the primary stack? (top 5 projs in team vs all team projs)
    if by_team:
        primary_team = max(by_team.items(), key=lambda kv: len(kv[1]))
        primary_projs = sorted([p['proj'] for p in primary_team[1]], reverse=True)
        feats['primary_stack_proj_top1'] = primary_projs[0] if primary_projs else 0
        feats['primary_stack_proj_top3_sum'] = sum(primary_projs[:3])
        feats['primary_stack_own_top3_sum'] = sum(sorted([p['own'] for p in primary_team[1]], reverse=True)[:3])
        feats['primary_stack_balance'] = np.std(primary_projs) if len(primary_projs) > 1 else 0
        feats['primary_stack_top1_share'] = primary_projs[0] / max(0.01, sum(primary_projs)) if primary_projs else 0

    return feats

def main():
    t0 = time.time()
    print("Loading factor_frame_v4...", file=sys.stderr)
    fdf = pd.read_csv(os.path.join(LIVE_AUDIT, 'factor_frame_v4.csv'))
    df_all = pd.read_csv(os.path.join(LIVE_AUDIT, 'all_lineups.csv'))
    print(f"  {len(fdf)} factor rows, {len(df_all)} lineups in {time.time()-t0:.1f}s", file=sys.stderr)

    rank_lineup = {(int(row['contest_id']), int(row['rank'])): row['lineup'] for _, row in df_all.iterrows()}

    print("Loading projections per slate...", file=sys.stderr)
    slates = fdf['slate'].unique()
    proj_cache = {}
    for s in slates:
        p = load_proj(s)
        if p: proj_cache[s] = p
    print(f"  {len(proj_cache)} slates with proj data", file=sys.stderr)

    print("Computing groupby features...", file=sys.stderr)
    t1 = time.time()
    new_rows = []
    for idx, row in fdf.iterrows():
        slate = row['slate']
        if slate not in proj_cache:
            new_rows.append({}); continue
        cid = int(row['contest_id']); rank = int(row['rank'])
        lineup_str = rank_lineup.get((cid, rank), '')
        positions = parse_lineup(lineup_str)
        f = compute_groupby_features(positions, proj_cache[slate])
        new_rows.append(f if f else {})
        if idx > 0 and idx % 50000 == 0:
            print(f"  {idx}/{len(fdf)} in {time.time()-t1:.0f}s", file=sys.stderr)

    nf = pd.DataFrame(new_rows)
    # Fill missing
    for c in nf.columns: nf[c] = nf[c].fillna(0)
    print(f"\nNew groupby features: {nf.shape[1]}", file=sys.stderr)

    out = pd.concat([fdf.reset_index(drop=True), nf.reset_index(drop=True)], axis=1)
    out.to_csv(os.path.join(LIVE_AUDIT, 'factor_frame_v5.csv'), index=False)
    print(f"\nWrote factor_frame_v5.csv: {len(out)} rows x {len(out.columns)} cols (added {nf.shape[1]} groupby features)", file=sys.stderr)
    print(f"Total time: {time.time()-t0:.1f}s", file=sys.stderr)

if __name__ == '__main__':
    main()
