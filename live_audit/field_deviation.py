"""
Method 3: GTO + Exploitative Deviation.

For each player on each slate, compute:
  - actual_field_ownership: from contest standings (% of contest entries that rostered the player)
  - projection_rank: 1-based rank by projection within position group
  - projection_implied_ownership: what ownership would be optimal given projection ranking

Field-deviation = actual − projection-implied.
  Players where actual > implied: OVER-OWNED → avoid
  Players where actual < implied: UNDER-OWNED → lever toward

Per-lineup features:
  - sum of field deviations
  - max positive deviation (most over-owned player exposure)
  - sum of negative deviations (under-owned player exposure)
  - count of under-owned players (<-5pp)
  - count of over-owned players (>+5pp)
"""
import csv, os, re, sys, json
from collections import Counter, defaultdict
import numpy as np
import pandas as pd

LIVE_AUDIT = "C:/Users/colin/Projects/dfs-optimizer/live_audit"
DFSOPTO = "C:/Users/colin/dfs opto"
POS_RE = r'(?:P|C|1B|2B|3B|SS|OF|CPT|FLEX|UTIL|PG|SG|SF|PF|G|F)'

def parse_lineup(s):
    if not s: return []
    parts = re.split(r'\s+(?=' + POS_RE + r'\s+\w)', s.strip())
    out = []
    for p in parts:
        m = re.match(r'^(' + POS_RE + r')\s+(.+)$', p.strip())
        if m: out.append((m.group(1), m.group(2).strip()))
    return out

def norm(n): return re.sub(r'[^a-z0-9 ]+', '', n.lower()).strip()

def main():
    print("Loading all_lineups + projections...", file=sys.stderr)
    df = pd.read_csv(os.path.join(LIVE_AUDIT, 'all_lineups.csv'))

    # Group by slate, compute actual field ownership for each player
    print("Computing field ownership per slate...", file=sys.stderr)
    slate_field_own = {}  # slate -> {norm_name: actual_field_own_pct}
    for slate in df['slate'].unique():
        sub = df[df['slate'] == slate]
        n_entries = len(sub)
        if n_entries < 50: continue
        player_counts = Counter()
        for _, row in sub.iterrows():
            positions = parse_lineup(row['lineup'])
            for pos, name in positions:
                player_counts[norm(name)] += 1
        # Actual field ownership = count / total entries
        slate_field_own[slate] = {nm: cnt / n_entries * 100 for nm, cnt in player_counts.items()}

    # Load projection files to get projection rank
    print("Computing projection-implied ownership per slate...", file=sys.stderr)
    slate_implied_own = {}
    slate_deviations = {}
    for slate, field_own in slate_field_own.items():
        proj_path = None
        for cand in [f"{slate}projections.csv", f"{slate}_projections.csv"]:
            p = os.path.join(DFSOPTO, cand)
            if os.path.exists(p):
                proj_path = p; break
        if not proj_path: continue
        # Load projections per player
        proj_data = {}
        with open(proj_path, encoding='utf-8') as f:
            for r in csv.DictReader(f):
                nm = norm(r.get('Name', ''))
                if not nm: continue
                try:
                    proj_data[nm] = {
                        'proj': float(r.get('My Proj') or r.get('SS Proj') or 0),
                        'salary': float(r.get('Salary', 0) or 0),
                        'pos': (r.get('Pos') or '').strip(),
                        'team': (r.get('Team') or '').strip().upper(),
                    }
                except (ValueError, TypeError):
                    continue
        # Compute projection-implied ownership: rank players by proj/$, then assign expected own.
        # Heuristic: total expected ownership across slate is constant (e.g., 9 players per lineup × N% avg own).
        # We assume implied_own ∝ proj/salary × position scarcity adjustment.
        # Simplified: rank players by (proj/salary), assign implied_own that's monotonic in rank but constrained.
        # The cleanest implied-own derivation: for each position, assign own proportional to softmax(proj × 0.5).
        # But pragmatically: implied_own = actual relative ranking matches what the field SHOULD do.
        # Use proj_per_dollar × 10 as raw signal, then normalize per position to sum 100% × (rosters_per_lineup).
        # For DK MLB: 2P + 8H per lineup × 100 lineups = 200P slots + 800H slots = total contest ownership.
        # Per-position implied: rank players by proj/$, allocate slots proportional to rank-weighted projection.

        # Simplified version: for each position, implied_own ∝ rank softmax with temperature.
        by_pos = defaultdict(list)
        for nm, d in proj_data.items():
            p = d['pos'].split('/')[0] if '/' in d['pos'] else d['pos']
            # Map to single position
            by_pos[p].append((nm, d['proj'], d['salary']))
        # For each position, compute implied own
        implied = {}
        # Total ownership budget per position (assume 9 lineup slots for hitters per contest entry)
        # Simplified: implied_own ∝ proj/salary, scaled so position-wise total = N players × 100%
        for pos, players in by_pos.items():
            if not players: continue
            # rank by proj
            players.sort(key=lambda x: -x[1])
            # Use proj_squared as "demand" signal
            demands = [max(0.01, p) ** 1.5 for _, p, _ in players]
            total_demand = sum(demands)
            # Each position needs ~1-3 lineup slots filled. Total ownership per position ≈ 200% × (slots/lineup)
            # For MLB: 1 C, 1 1B, etc. Total own per position ≈ 100% (1 player chosen per lineup).
            # OF has 3 slots → total OF own ≈ 300%
            # P has 2 slots → total P own ≈ 200%
            pos_slot_total = {
                'P': 200, 'C': 100, '1B': 100, '2B': 100, '3B': 100,
                'SS': 100, 'OF': 300, 'UTIL': 100,
            }.get(pos, 100)
            for (nm, p, s), d in zip(players, demands):
                implied[nm] = (d / total_demand) * pos_slot_total
        slate_implied_own[slate] = implied
        # Compute deviation
        devs = {}
        for nm, actual in field_own.items():
            imp = implied.get(nm, actual)  # if no implied, deviation = 0
            devs[nm] = actual - imp
        slate_deviations[slate] = devs

    print(f"Computed deviations for {len(slate_deviations)} slates", file=sys.stderr)

    # Now augment factor_frame_v2.csv with field-deviation features per lineup
    print("Augmenting factor frame with deviation features...", file=sys.stderr)
    fdf = pd.read_csv(os.path.join(LIVE_AUDIT, 'factor_frame_v2.csv'))
    df_all = pd.read_csv(os.path.join(LIVE_AUDIT, 'all_lineups.csv'))
    df_all['_idx'] = df_all.index

    # Build a quick lookup: (contest_id, rank) -> lineup string
    print(f"Joining {len(fdf)} factor rows with lineup strings...", file=sys.stderr)
    rank_to_lineup = {}
    for _, row in df_all.iterrows():
        rank_to_lineup[(row['contest_id'], row['rank'])] = row['lineup']

    dev_features = []
    for _, row in fdf.iterrows():
        slate = row['slate']
        devs = slate_deviations.get(slate, {})
        cid = row['contest_id']
        rank = row['rank']
        lineup_str = rank_to_lineup.get((cid, rank))
        if not lineup_str:
            dev_features.append({k: 0 for k in ['dev_sum', 'dev_max_over', 'dev_sum_under', 'dev_n_over', 'dev_n_under', 'dev_mean', 'dev_abs_sum']})
            continue
        positions = parse_lineup(lineup_str)
        lineup_devs = []
        for pos, name in positions:
            d = devs.get(norm(name))
            if d is not None: lineup_devs.append(d)
        if not lineup_devs:
            dev_features.append({k: 0 for k in ['dev_sum', 'dev_max_over', 'dev_sum_under', 'dev_n_over', 'dev_n_under', 'dev_mean', 'dev_abs_sum']})
            continue
        arr = np.array(lineup_devs)
        dev_features.append({
            'dev_sum': arr.sum(),
            'dev_max_over': arr.max(),
            'dev_sum_under': arr[arr < 0].sum() if (arr < 0).any() else 0,
            'dev_n_over': int((arr > 5).sum()),
            'dev_n_under': int((arr < -5).sum()),
            'dev_mean': arr.mean(),
            'dev_abs_sum': np.abs(arr).sum(),
        })

    dev_df = pd.DataFrame(dev_features)
    print(f"Dev features: {dev_df.shape}", file=sys.stderr)
    # Concat
    out = pd.concat([fdf.reset_index(drop=True), dev_df.reset_index(drop=True)], axis=1)
    out.to_csv(os.path.join(LIVE_AUDIT, 'factor_frame_v3.csv'), index=False)
    print(f"Wrote factor_frame_v3.csv: {len(out)} rows × {len(out.columns)} cols", file=sys.stderr)

if __name__ == '__main__':
    main()
