"""
IC Analysis Pipeline — applies quant-finance Information Coefficient methodology to DFS.

For every lineup in every contest:
  1. Parse lineup → list of player names
  2. Compute ~30 candidate factors using slate projection file
  3. Compute finishing percentile within contest (1 = best, 0 = worst)
  4. Per contest, compute Spearman IC between each factor and finishing percentile
  5. Aggregate per factor: mean IC, std IC, sign-stability (% contests with same sign), decile decomposition
  6. Factor decay: IC time-window vs full sample
  7. Cross-factor correlation matrix (orthogonality check)

Output:
  ic_results.csv - per (factor, contest) IC
  ic_summary.csv - per-factor aggregate stats
  decile_decomposition.csv - per (factor, decile) mean finishing percentile
  factor_decay.csv - per-factor IC by time slice
  ic_report.md - human-readable synthesis
"""
import csv
import os
import re
import json
import sys
from collections import Counter, defaultdict
import numpy as np
import pandas as pd
from scipy.stats import spearmanr

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
        if m: out.append((m.group(1), m.group(2).strip()))
    return out

def norm(n): return re.sub(r'[^a-z0-9 ]+', '', n.lower()).strip()

def load_proj(slate):
    """Try a few naming conventions."""
    candidates = [f"{slate}projections.csv", f"{slate}_projections.csv"]
    for c in candidates:
        p = os.path.join(DFSOPTO, c)
        if os.path.exists(p):
            by_name = {}
            with open(p, encoding='utf-8') as f:
                for r in csv.DictReader(f):
                    nm = norm(r.get('Name', ''))
                    if not nm: continue
                    try:
                        rec = {
                            'team': (r.get('Team') or '').strip().upper(),
                            'opp': (r.get('Opp') or '').strip().upper(),
                            'salary': float(r.get('Salary', 0) or 0),
                            'own': float((r.get('Adj Own') or r.get('My Own') or '0').replace('%','') or 0),
                            'proj': float(r.get('My Proj') or r.get('SS Proj') or 0),
                            'ceil_85': float(r.get('dk_85_percentile') or r.get('dk_85') or 0),
                            'ceil_95': float(r.get('dk_95_percentile') or 0),
                            'ceil_99': float(r.get('dk_99_percentile') or 0),
                            'std_dev': float(r.get('dk_std') or 0),
                            'pos': (r.get('Pos') or '').strip(),
                            'order': r.get('Order') or '',
                            'saber_team_total': float((r.get('Saber Team') or '0').replace('%','') or 0),
                            'saber_game_total': float((r.get('Saber Total') or '0').replace('%','') or 0),
                        }
                        if nm not in by_name:
                            by_name[nm] = rec
                    except (ValueError, TypeError):
                        continue
            return by_name
    return None

def compute_factors(positions, player_map):
    """Compute ~30 candidate factors for one lineup."""
    factors = {}
    if not positions:
        return None
    matched = []
    for pos, name in positions:
        rec = player_map.get(norm(name))
        if rec:
            matched.append((pos, name, rec))
    if len(matched) < 7:
        return None

    projs = [r['proj'] for p, n, r in matched]
    owns = [r['own'] for p, n, r in matched]
    sals = [r['salary'] for p, n, r in matched]
    ceils85 = [r['ceil_85'] for p, n, r in matched]
    ceils95 = [r['ceil_95'] for p, n, r in matched]
    ceils99 = [r['ceil_99'] for p, n, r in matched]
    stds = [r['std_dev'] for p, n, r in matched]
    saber_team = [r['saber_team_total'] for p, n, r in matched]
    saber_game = [r['saber_game_total'] for p, n, r in matched]

    # Basic sums
    factors['proj_sum'] = sum(projs)
    factors['own_sum'] = sum(owns)
    factors['own_prod_log'] = sum(np.log(max(0.001, o/100)) for o in owns)
    factors['sal_sum'] = sum(sals)
    factors['ceil85_sum'] = sum(ceils85)
    factors['ceil95_sum'] = sum(ceils95)
    factors['ceil99_sum'] = sum(ceils99)
    factors['std_sum'] = sum(stds)
    factors['var_sum'] = sum(s*s for s in stds)

    # Means
    factors['proj_mean'] = np.mean(projs)
    factors['own_mean'] = np.mean(owns)
    factors['ceil85_mean'] = np.mean(ceils85)

    # Spread / shape
    factors['proj_std'] = np.std(projs)
    factors['own_std'] = np.std(owns)
    factors['proj_max'] = np.max(projs)
    factors['proj_min'] = np.min(projs)
    factors['own_max'] = np.max(owns)
    factors['own_min'] = np.min(owns)

    # Salary efficiency / leverage
    factors['proj_per_dollar'] = factors['proj_sum'] / max(1, factors['sal_sum'] / 1000)
    factors['ceil95_per_dollar'] = factors['ceil95_sum'] / max(1, factors['sal_sum'] / 1000)
    factors['leverage_proj_own'] = factors['proj_sum'] / max(0.001, factors['own_sum'])
    factors['leverage_ceil95_own'] = factors['ceil95_sum'] / max(0.001, factors['own_sum'])

    # Stack composition (hitters only)
    teams_hit = Counter()
    team_opp_map = {}
    pitcher_opps = []
    for pos, name, r in matched:
        if pos == 'P':
            pitcher_opps.append(r['opp'])
        else:
            t = r['team']
            teams_hit[t] += 1
            team_opp_map[t] = r['opp']
    counts = sorted(teams_hit.values(), reverse=True) if teams_hit else [0]
    while len(counts) < 5: counts.append(0)
    factors['primary_stack_size'] = counts[0]
    factors['secondary_stack_size'] = counts[1]
    factors['has_5_stack'] = 1.0 if counts[0] >= 5 else 0.0
    factors['has_4_stack'] = 1.0 if counts[0] >= 4 else 0.0
    factors['has_3_stack'] = 1.0 if counts[0] >= 3 else 0.0
    factors['has_secondary_3plus'] = 1.0 if counts[1] >= 3 else 0.0
    factors['num_teams'] = len(teams_hit)

    # Bring-back (hitters on primary stack opp)
    primary_team = teams_hit.most_common(1)[0][0] if teams_hit else None
    bringback = 0
    if primary_team and primary_team in team_opp_map:
        opp_team = team_opp_map[primary_team]
        bringback = teams_hit.get(opp_team, 0)
    factors['bringback_count'] = bringback
    factors['has_bringback'] = 1.0 if bringback >= 1 else 0.0
    factors['has_bringback_2plus'] = 1.0 if bringback >= 2 else 0.0

    # Game-stack total (primary + bringback)
    factors['game_stack_size'] = counts[0] + bringback

    # Pitcher-vs-stack: count of hitters in lineup that play AGAINST the lineup's pitcher
    pitcher_anti = 0
    for pos, name, r in matched:
        if pos == 'P': continue
        for opp in pitcher_opps:
            if r['team'] == opp:
                pitcher_anti += 1
    factors['pitcher_anti_hitters'] = pitcher_anti  # negative correlation if > 0

    # Saber team / game totals
    factors['saber_team_total_sum'] = sum(saber_team)
    factors['saber_team_total_mean'] = np.mean(saber_team)
    factors['saber_game_total_sum'] = sum(saber_game)

    # Anchor exposure (lineup contains top-projection player on slate?)
    # (computed at contest level externally — skip here)

    # Cheap-stud + min-priced (Ch.9 #4 exploit)
    sals_sorted = sorted(sals)
    factors['cheap_3_sum'] = sum(sals_sorted[:3])
    factors['stud_3_sum'] = sum(sals_sorted[-3:])
    factors['stud_to_cheap_ratio'] = factors['stud_3_sum'] / max(1, factors['cheap_3_sum'])

    # Order (batting order — only hitters)
    orders = []
    for pos, name, r in matched:
        if pos == 'P': continue
        try:
            o = int(r['order'])
            if 1 <= o <= 9: orders.append(o)
        except (ValueError, TypeError):
            pass
    if orders:
        factors['order_mean'] = np.mean(orders)
        factors['order_top4_count'] = sum(1 for o in orders if o <= 4)
    else:
        factors['order_mean'] = 5.0
        factors['order_top4_count'] = 0

    return factors

def main():
    print("Loading lineups...", file=sys.stderr)
    df = pd.read_csv(os.path.join(LIVE_AUDIT, 'all_lineups.csv'))
    print(f"Total lineups: {len(df)}", file=sys.stderr)

    # Group by slate to load each projection file once
    slates_in_data = df['slate'].unique()

    proj_cache = {}
    for s in slates_in_data:
        proj = load_proj(s)
        if proj:
            proj_cache[s] = proj
            print(f"  Loaded proj for {s}: {len(proj)} players", file=sys.stderr)

    # Skip contests without proj file
    df_valid = df[df['slate'].isin(proj_cache.keys())].copy()
    print(f"Lineups with projection match: {len(df_valid)} ({len(df_valid['contest_id'].unique())} contests)", file=sys.stderr)

    # Compute factors per lineup
    print("Computing factors (this takes a few minutes)...", file=sys.stderr)
    factor_rows = []
    for cid in sorted(df_valid['contest_id'].unique()):
        sub = df_valid[df_valid['contest_id'] == cid]
        slate = sub.iloc[0]['slate']
        proj = proj_cache.get(slate)
        if not proj: continue
        n_entries = len(sub)
        for _, row in sub.iterrows():
            positions = parse_lineup(row['lineup'])
            factors = compute_factors(positions, proj)
            if factors is None: continue
            factors['contest_id'] = cid
            factors['slate'] = slate
            factors['rank'] = row['rank']
            factors['finish_pct'] = 1.0 - (row['rank'] - 1) / n_entries  # 1 = best, 0 = worst
            factor_rows.append(factors)
        print(f"  {slate}/{cid}: {n_entries} processed", file=sys.stderr)

    fdf = pd.DataFrame(factor_rows)
    print(f"Factor frame: {len(fdf)} rows, {len(fdf.columns)} cols", file=sys.stderr)
    factor_cols = [c for c in fdf.columns if c not in ('contest_id', 'slate', 'rank', 'finish_pct')]
    fdf.to_csv(os.path.join(LIVE_AUDIT, 'factor_frame.csv'), index=False)
    print(f"Wrote factor_frame.csv ({len(fdf)} rows × {len(fdf.columns)} cols)", file=sys.stderr)

    # === IC PER CONTEST PER FACTOR ===
    print("\nComputing IC per contest per factor...", file=sys.stderr)
    ic_rows = []
    for cid in sorted(fdf['contest_id'].unique()):
        sub = fdf[fdf['contest_id'] == cid]
        if len(sub) < 50: continue
        slate = sub.iloc[0]['slate']
        for f in factor_cols:
            vals = sub[f].values
            if np.std(vals) < 1e-9: continue
            ic, _ = spearmanr(vals, sub['finish_pct'].values)
            ic_rows.append({'factor': f, 'contest_id': cid, 'slate': slate, 'n': len(sub), 'ic': ic})
    icdf = pd.DataFrame(ic_rows)
    icdf.to_csv(os.path.join(LIVE_AUDIT, 'ic_per_contest.csv'), index=False)

    # === AGGREGATE PER FACTOR ===
    print("Aggregating IC stats per factor...", file=sys.stderr)
    summary_rows = []
    for f in factor_cols:
        sub = icdf[icdf['factor'] == f]
        if len(sub) == 0: continue
        ics = sub['ic'].values
        mean_ic = np.mean(ics)
        std_ic = np.std(ics)
        sign_stable = np.mean(np.sign(ics) == np.sign(mean_ic)) if abs(mean_ic) > 0.001 else 0
        ic_ir = mean_ic / max(0.001, std_ic)  # information ratio
        summary_rows.append({
            'factor': f,
            'n_contests': len(sub),
            'mean_ic': mean_ic,
            'std_ic': std_ic,
            'min_ic': np.min(ics),
            'max_ic': np.max(ics),
            'median_ic': np.median(ics),
            'sign_stable_pct': sign_stable,
            'ic_ir': ic_ir,
            'abs_mean_ic': abs(mean_ic),
        })
    sdf = pd.DataFrame(summary_rows).sort_values('abs_mean_ic', ascending=False)
    sdf.to_csv(os.path.join(LIVE_AUDIT, 'ic_summary.csv'), index=False)

    # === DECILE DECOMPOSITION ===
    print("Computing decile decomposition for top-20 factors...", file=sys.stderr)
    decile_rows = []
    top_factors = sdf.head(20)['factor'].values
    for f in top_factors:
        # Pool all lineups, compute deciles by factor within each contest, get mean finish_pct
        for cid in sorted(fdf['contest_id'].unique()):
            sub = fdf[fdf['contest_id'] == cid].copy()
            if len(sub) < 100: continue
            try:
                sub['decile'] = pd.qcut(sub[f], 10, labels=False, duplicates='drop')
            except (ValueError, TypeError):
                continue
            for d, g in sub.groupby('decile'):
                decile_rows.append({
                    'factor': f, 'contest_id': cid, 'decile': int(d),
                    'mean_finish_pct': g['finish_pct'].mean(),
                    'n': len(g),
                })
    ddf = pd.DataFrame(decile_rows)
    # Aggregate: mean finish_pct per (factor, decile) across contests
    if len(ddf) > 0:
        decile_agg = ddf.groupby(['factor', 'decile']).agg(
            mean_finish_pct=('mean_finish_pct', 'mean'),
            std_finish_pct=('mean_finish_pct', 'std'),
            n_contests=('contest_id', 'count'),
        ).reset_index()
        decile_agg.to_csv(os.path.join(LIVE_AUDIT, 'decile_decomposition.csv'), index=False)
    else:
        decile_agg = pd.DataFrame()

    # === FACTOR DECAY (IC over time slices) ===
    print("Computing factor decay (IC by time slice)...", file=sys.stderr)
    # Slice by slate date
    fdf['date'] = pd.to_datetime(fdf['slate'].apply(lambda s: f"2026-{s.split('-')[0]:0>2}-{s.split('-')[1]:0>2}"), errors='coerce')
    fdf = fdf.dropna(subset=['date']).sort_values('date')
    dates_sorted = fdf['date'].sort_values().unique()
    if len(dates_sorted) > 0:
        mid_date = dates_sorted[len(dates_sorted) // 2]
        decay_rows = []
        for f in factor_cols:
            for label, mask in [('early', fdf['date'] < mid_date), ('late', fdf['date'] >= mid_date)]:
                sub = fdf[mask]
                ics_this = []
                for cid in sub['contest_id'].unique():
                    csub = sub[sub['contest_id'] == cid]
                    if len(csub) < 50: continue
                    vals = csub[f].values
                    if np.std(vals) < 1e-9: continue
                    ic, _ = spearmanr(vals, csub['finish_pct'].values)
                    ics_this.append(ic)
                if ics_this:
                    decay_rows.append({
                        'factor': f, 'window': label, 'n_contests': len(ics_this),
                        'mean_ic': np.mean(ics_this),
                        'std_ic': np.std(ics_this),
                    })
        decay_df = pd.DataFrame(decay_rows)
        decay_df.to_csv(os.path.join(LIVE_AUDIT, 'factor_decay.csv'), index=False)
    else:
        decay_df = pd.DataFrame()

    # === REPORT ===
    print("\n=== TOP 25 FACTORS BY |MEAN_IC| (sign-stable) ===")
    print(f"{'factor':<28} {'mean_IC':>9} {'std_IC':>8} {'IR':>7} {'sign%':>7} {'n':>4}")
    print('-' * 75)
    for _, r in sdf.head(25).iterrows():
        print(f"{r['factor']:<28} {r['mean_ic']:>9.4f} {r['std_ic']:>8.4f} {r['ic_ir']:>7.3f} {r['sign_stable_pct']*100:>6.1f}% {r['n_contests']:>4}")

    print(f"\n=== TOP 10 FACTORS DECILE MONOTONICITY ===")
    print(f"{'factor':<28} {'D1':>6} {'D5':>6} {'D10':>6}  range")
    print('-' * 65)
    for f in sdf.head(10)['factor'].values:
        if len(decile_agg) == 0: continue
        sub = decile_agg[decile_agg['factor'] == f].sort_values('decile')
        if len(sub) < 5: continue
        d1 = sub.iloc[0]['mean_finish_pct']
        d5 = sub[sub['decile'] == 4]['mean_finish_pct'].values[0] if len(sub[sub['decile'] == 4]) else None
        d10 = sub.iloc[-1]['mean_finish_pct']
        r = d10 - d1
        print(f"{f:<28} {d1:>6.3f} {d5 if d5 is None else f'{d5:>6.3f}'} {d10:>6.3f}  {r:>+.3f}")

    print(f"\n=== FACTOR DECAY (early vs late) — TOP 15 BY |MEAN_IC| ===")
    if len(decay_df) > 0:
        print(f"{'factor':<28} {'early_IC':>9} {'late_IC':>9} {'decay':>9}")
        print('-' * 65)
        for f in sdf.head(15)['factor'].values:
            sub = decay_df[decay_df['factor'] == f]
            early = sub[sub['window'] == 'early']
            late = sub[sub['window'] == 'late']
            if len(early) == 0 or len(late) == 0: continue
            e_ic = early.iloc[0]['mean_ic']
            l_ic = late.iloc[0]['mean_ic']
            print(f"{f:<28} {e_ic:>9.4f} {l_ic:>9.4f} {l_ic - e_ic:>+9.4f}")

if __name__ == '__main__':
    main()
