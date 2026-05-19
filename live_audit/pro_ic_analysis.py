"""
Pro-only IC Analysis — applies quant + GTO exploitation methodology to the PRO subset.

The framing (Method 3 GTO + Exploitative Deviation):
  Pros all start from approximately GTO baseline (projection-weighted, salary-efficient).
  The VARIATION among pros' lineups represents their exploitative decisions.
  Therefore: factors predicting finishing percentile WITHIN the pro subset = real exploit signal.

Three IC analyses:
  1. POOLED PRO IC: across all 15,660 pro lineups, IC of factor vs finishing percentile
  2. PER-PRO IC: for each (contest, pro) pair, IC of factor vs the pro's own 150-lineup ranking
     - Aggregate: mean IC across all pros
     - This isolates "what makes ONE pro's lineup beat their OTHER lineups" = pure exploit signal
  3. WINNING-PRO IC: filter to top-3 finishing pros per contest, run #1 and #2 on subset
     - Identifies what the BEST pros do differently from average pros

Output:
  pro_ic_pooled.csv - pooled IC ranking
  pro_ic_per_pro.csv - per-(contest,pro) IC aggregated
  pro_ic_winners.csv - top-3 pros only
  PRO_IC_FINDINGS.md - narrative synthesis
"""
import csv, os, sys
import numpy as np
import pandas as pd
from scipy.stats import spearmanr, pointbiserialr
from collections import defaultdict

LIVE_AUDIT = "C:/Users/colin/Projects/dfs-optimizer/live_audit"

def main():
    print("Loading data...", file=sys.stderr)
    fdf = pd.read_csv(os.path.join(LIVE_AUDIT, 'factor_frame_v3.csv'))
    pdf = pd.read_csv(os.path.join(LIVE_AUDIT, 'pro_lineups.csv'))
    print(f"Factor frame: {len(fdf)} rows", file=sys.stderr)
    print(f"Pro lineups: {len(pdf)} rows", file=sys.stderr)

    # Join: pro lineups are identified by (contest_id, rank). Filter factor frame to pro lineups.
    pro_keys = set(zip(pdf['contest_id'].astype(str), pdf['rank'].astype(int)))
    print(f"Pro key set: {len(pro_keys)} unique (contest, rank) pairs", file=sys.stderr)

    fdf['key'] = list(zip(fdf['contest_id'].astype(str), fdf['rank'].astype(int)))
    pro_factors = fdf[fdf['key'].isin(pro_keys)].copy()
    print(f"Pro-filtered factor rows: {len(pro_factors)}", file=sys.stderr)

    # Add pro user to pro_factors (join on contest_id+rank)
    pdf['key'] = list(zip(pdf['contest_id'].astype(str), pdf['rank'].astype(int)))
    pro_factors = pro_factors.merge(pdf[['key', 'user', 'pro_best_rank']].drop_duplicates('key'), on='key', how='left')
    print(f"After user merge: {len(pro_factors)} rows", file=sys.stderr)

    factor_cols = [c for c in pro_factors.columns if c not in ('contest_id', 'slate', 'rank', 'finish_pct', 'date', 'key', 'user', 'pro_best_rank')]
    print(f"Factor cols: {len(factor_cols)}", file=sys.stderr)

    pro_factors['is_top1'] = (pro_factors['finish_pct'] >= 0.99).astype(int)
    pro_factors['is_top01'] = (pro_factors['finish_pct'] >= 0.999).astype(int)

    # === 1. POOLED PRO IC ===
    print("\n[1/3] Pooled pro IC (all 15,660 pro lineups)...", file=sys.stderr)
    pooled_rows = []
    for f in factor_cols:
        ics_full, ics_top1 = [], []
        for cid in pro_factors['contest_id'].unique():
            sub = pro_factors[pro_factors['contest_id'] == cid]
            if len(sub) < 30: continue
            vals = sub[f].values
            if np.std(vals) < 1e-9: continue
            try:
                ic, _ = spearmanr(vals, sub['finish_pct'].values)
                if not np.isnan(ic): ics_full.append(ic)
            except Exception: pass
            if sub['is_top1'].sum() >= 2:
                try:
                    ic, _ = pointbiserialr(sub['is_top1'].values, vals)
                    if not np.isnan(ic): ics_top1.append(ic)
                except Exception: pass
        pooled_rows.append({
            'factor': f,
            'pool_ic_full_mean': np.mean(ics_full) if ics_full else np.nan,
            'pool_ic_full_std': np.std(ics_full) if ics_full else np.nan,
            'pool_ic_full_sign_stable': np.mean(np.sign(ics_full) == np.sign(np.mean(ics_full))) if ics_full and abs(np.mean(ics_full)) > 0.001 else 0,
            'pool_ic_top1_mean': np.mean(ics_top1) if ics_top1 else np.nan,
            'n_contests': len(ics_full),
        })
    pooled_df = pd.DataFrame(pooled_rows)
    pooled_df['abs_ic_full'] = pooled_df['pool_ic_full_mean'].abs()
    pooled_df = pooled_df.sort_values('abs_ic_full', ascending=False)
    pooled_df.to_csv(os.path.join(LIVE_AUDIT, 'pro_ic_pooled.csv'), index=False)

    # === 2. PER-PRO IC (intra-pro: rank within pro's own portfolio) ===
    print("[2/3] Per-pro IC (ranking within each pro's own 150-lineup portfolio)...", file=sys.stderr)
    per_pro_rows = []
    for f in factor_cols:
        all_ics = []
        for (cid, user), sub in pro_factors.groupby(['contest_id', 'user']):
            if len(sub) < 50: continue
            vals = sub[f].values
            if np.std(vals) < 1e-9: continue
            # finish_pct is the global contest finish; rank within the pro's portfolio is via finish_pct ordering
            try:
                ic, _ = spearmanr(vals, sub['finish_pct'].values)
                if not np.isnan(ic): all_ics.append(ic)
            except Exception: pass
        per_pro_rows.append({
            'factor': f,
            'per_pro_ic_mean': np.mean(all_ics) if all_ics else np.nan,
            'per_pro_ic_std': np.std(all_ics) if all_ics else np.nan,
            'per_pro_ic_sign_stable': np.mean(np.sign(all_ics) == np.sign(np.mean(all_ics))) if all_ics and abs(np.mean(all_ics)) > 0.001 else 0,
            'n_pros': len(all_ics),
        })
    per_pro_df = pd.DataFrame(per_pro_rows)
    per_pro_df['abs_ic'] = per_pro_df['per_pro_ic_mean'].abs()
    per_pro_df = per_pro_df.sort_values('abs_ic', ascending=False)
    per_pro_df.to_csv(os.path.join(LIVE_AUDIT, 'pro_ic_per_pro.csv'), index=False)

    # === 3. WINNING-PRO IC (top 1 pro per contest by best_rank) ===
    print("[3/3] Winning-pro IC (top-1 pro per contest by best_rank)...", file=sys.stderr)
    # Find the best-ranked pro per contest
    best_pro_per_contest = pro_factors.groupby('contest_id')['pro_best_rank'].min().reset_index()
    best_pro_per_contest['key'] = list(zip(best_pro_per_contest['contest_id'].astype(str), best_pro_per_contest['pro_best_rank'].astype(int)))
    winning_pros = pro_factors[
        pro_factors.apply(lambda r: r['pro_best_rank'] == best_pro_per_contest.set_index('contest_id').loc[r['contest_id'], 'pro_best_rank'], axis=1)
    ]
    print(f"Winning pros: {len(winning_pros)} lineups across {winning_pros['contest_id'].nunique()} contests", file=sys.stderr)

    winning_rows = []
    for f in factor_cols:
        ics_full = []
        for cid in winning_pros['contest_id'].unique():
            sub = winning_pros[winning_pros['contest_id'] == cid]
            if len(sub) < 30: continue
            vals = sub[f].values
            if np.std(vals) < 1e-9: continue
            try:
                ic, _ = spearmanr(vals, sub['finish_pct'].values)
                if not np.isnan(ic): ics_full.append(ic)
            except Exception: pass
        winning_rows.append({
            'factor': f,
            'win_ic_mean': np.mean(ics_full) if ics_full else np.nan,
            'win_ic_sign_stable': np.mean(np.sign(ics_full) == np.sign(np.mean(ics_full))) if ics_full and abs(np.mean(ics_full)) > 0.001 else 0,
            'n_contests': len(ics_full),
        })
    winning_df = pd.DataFrame(winning_rows)
    winning_df['abs_ic'] = winning_df['win_ic_mean'].abs()
    winning_df = winning_df.sort_values('abs_ic', ascending=False)
    winning_df.to_csv(os.path.join(LIVE_AUDIT, 'pro_ic_winners.csv'), index=False)

    # === Print top 25 from each ===
    print("\n========================================")
    print("POOLED PRO IC (all 15,660 pro lineups)")
    print("========================================")
    print(f"{'factor':<28} {'pool_IC':>9} {'sign%':>7} {'top1_IC':>9} {'n':>4}")
    for _, r in pooled_df.head(25).iterrows():
        print(f"{r['factor']:<28} {r['pool_ic_full_mean']:>9.4f} {r['pool_ic_full_sign_stable']*100:>6.1f}% {r['pool_ic_top1_mean']:>9.4f} {int(r['n_contests']):>4}")

    print("\n========================================")
    print("PER-PRO IC (within each pro's portfolio)")
    print("========================================")
    print(f"{'factor':<28} {'pro_IC':>9} {'sign%':>7} {'n_pros':>7}")
    for _, r in per_pro_df.head(25).iterrows():
        print(f"{r['factor']:<28} {r['per_pro_ic_mean']:>9.4f} {r['per_pro_ic_sign_stable']*100:>6.1f}% {int(r['n_pros']):>7}")

    print("\n========================================")
    print("WINNING-PRO IC (top-1 pro per contest)")
    print("========================================")
    print(f"{'factor':<28} {'win_IC':>9} {'sign%':>7} {'n':>4}")
    for _, r in winning_df.head(25).iterrows():
        print(f"{r['factor']:<28} {r['win_ic_mean']:>9.4f} {r['win_ic_sign_stable']*100:>6.1f}% {int(r['n_contests']):>4}")

if __name__ == '__main__':
    main()
