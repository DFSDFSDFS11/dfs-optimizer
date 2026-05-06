"""
Stage 3-6: Compute structural metrics on V1-NoCorr lineups.

Reads:
  - 24-slate baseline: theory_dfs_v2/v1_pros_lineup_dump.json (uses vNoCorr arrays)
  - 4 new slates: baseline_update/new_slates_v1nocorr_dump.json

Computes per slate:
  - Stack distribution (% 5+ / % 4 / % 3-3 / % naked)
  - Bring-back rate, BB size dist (1, 2)
  - Mean salary, mean ownership_sum, mean projection_sum
  - Std of ownership across lineups, std of projection
  - Band distribution (HP/HO, HP/LO, LP/HO, LP/LO) using slate medians
  - Mean/max pairwise Jaccard within portfolio
  - Unique players used
  - Outcome metrics: top-1% hit rate vs random, top-0.1% hit rate vs random,
    inverse-bell ratio, ROI per slate (using same payout table as v2-validation)

Outputs:
  - per_slate_metrics.csv (Stage 3)
  - baseline_comparison.csv (Stage 4)
  - per_slate_context.md (Stage 5)
  - v1_28_slate_baseline.csv (Stage 6)
"""

import json
import math
import os
import statistics
from collections import defaultdict
from pathlib import Path

OUT = Path("C:/Users/colin/dfs opto/baseline_update")
OLD_DUMP = Path("C:/Users/colin/dfs opto/theory_dfs_v2/v1_pros_lineup_dump.json")
NEW_DUMP = OUT / "new_slates_v1nocorr_dump.json"

FEE = 20

# -------------- payout table builder (matches v2-validation) --------------
def build_payout_table(F):
    F = max(F, 100)
    pool = F * FEE * 0.88
    cash_line = max(1, int(F * 0.22))
    raw = [pow(r + 1, -1.15) for r in range(cash_line)]
    raw_sum = sum(raw)
    table = [0.0] * F
    min_cash = FEE * 1.2
    for r in range(cash_line):
        table[r] = max(min_cash, (raw[r] / raw_sum) * pool)
    t_sum = sum(table[:cash_line])
    scale = pool / t_sum if t_sum > 0 else 1.0
    for r in range(cash_line):
        table[r] *= scale
    return table

# -------------- metrics per slate --------------
def stack_size_label(primary, secondary):
    if primary >= 5: return '5plus'
    if primary == 4: return '4'
    if primary == 3 and secondary >= 3: return '3_3'
    return 'other'

def jaccard(a_set, b_set):
    if not a_set and not b_set: return 0.0
    inter = len(a_set & b_set)
    uni = len(a_set | b_set)
    return inter / uni if uni > 0 else 0.0

def compute_slate_metrics(slate_entry, label_source="vNoCorr"):
    """Given a slate dump entry, compute structural metrics for V1-NoCorr lineups."""
    lineups = slate_entry[label_source]
    n = len(lineups)
    if n == 0:
        return None

    # Stack distribution
    stack_buckets = {'5plus': 0, '4': 0, '3_3': 0, 'other': 0}
    for lu in lineups:
        b = stack_size_label(lu['primarySize'], lu['secondarySize'])
        stack_buckets[b] += 1
    stack_pct = {k: v / n for k, v in stack_buckets.items()}

    # Bring-back
    bb_at_least_1 = sum(1 for lu in lineups if lu['bringBack'] >= 1)
    bb_eq_1 = sum(1 for lu in lineups if lu['bringBack'] == 1)
    bb_eq_2plus = sum(1 for lu in lineups if lu['bringBack'] >= 2)

    # Salary / ownership / projection stats
    sals = [lu['salaryTotal'] for lu in lineups]
    own_sums = [lu['ownAvg'] * 10 for lu in lineups]  # ownAvg is mean across 10 players; sum = ownAvg*10
    projs = [lu['projection'] for lu in lineups]
    geo_owns = [lu['geoMeanOwnHit'] for lu in lineups]

    # Pairwise Jaccard within portfolio — only if pids are present (24-slate baseline vNoCorr does NOT include pids)
    if 'pids' in lineups[0]:
        pid_sets = [set(lu['pids']) for lu in lineups]
        pair_jaccards = []
        max_jacc = 0.0
        for i in range(n):
            for j in range(i + 1, n):
                jc = jaccard(pid_sets[i], pid_sets[j])
                pair_jaccards.append(jc)
                if jc > max_jacc: max_jacc = jc
        mean_jacc = statistics.mean(pair_jaccards) if pair_jaccards else 0.0
        all_pids = set()
        for s in pid_sets: all_pids |= s
        unique_players = len(all_pids)
    else:
        mean_jacc = None
        max_jacc = None
        unique_players = None

    # Band distribution: split by slate median projection and median ownership (over portfolio)
    med_proj = statistics.median(projs)
    med_own = statistics.median(own_sums)
    bands = {'HP_HO': 0, 'HP_LO': 0, 'LP_HO': 0, 'LP_LO': 0}
    for lu, p, o in zip(lineups, projs, own_sums):
        hp = p >= med_proj
        ho = o >= med_own
        if hp and ho: bands['HP_HO'] += 1
        elif hp and not ho: bands['HP_LO'] += 1
        elif not hp and ho: bands['LP_HO'] += 1
        else: bands['LP_LO'] += 1
    band_pct = {k: v / n for k, v in bands.items()}

    # Outcome metrics — only if lineups have actual/rank
    actuals_have = [lu for lu in lineups if lu.get('actual') is not None and lu.get('rank', -1) > 0]
    finish_pcts = [lu['finishPct'] for lu in actuals_have]
    F = slate_entry.get('totalEntries', 0)
    if F > 0 and finish_pcts:
        # top-1% / top-0.1% hit rate
        t1 = sum(1 for fp in finish_pcts if fp >= 0.99) / len(finish_pcts)
        t01 = sum(1 for fp in finish_pcts if fp >= 0.999) / len(finish_pcts)
        # Random baselines: top-1% rate is 0.01 by definition; top-0.1% is 0.001
        t1_lift = t1 / 0.01 if 0.01 > 0 else 0.0
        t01_lift = t01 / 0.001 if 0.001 > 0 else 0.0
        # Inverse-bell ratio: (top quintile + bottom quintile) / middle quintile by finishPct
        # Using percentile bins (0-20, 20-40, 40-60, 60-80, 80-100)
        bins = [0]*5
        for fp in finish_pcts:
            idx = min(4, int(fp * 5))
            bins[idx] += 1
        mid = bins[2] if bins[2] > 0 else 1
        ib_ratio = (bins[0] + bins[4]) / mid
        # ROI
        payout = build_payout_table(F)
        # Approximation: from finishPct -> rank (rank = (1-finishPct)*(F-1) + 1)
        total_payout = 0.0
        for fp in finish_pcts:
            rank = max(1, int((1 - fp) * (F - 1)) + 1)
            if rank <= len(payout):
                total_payout += payout[rank - 1]
        cost = len(finish_pcts) * FEE
        roi = (total_payout - cost) / cost if cost > 0 else 0.0
    else:
        t1 = t01 = t1_lift = t01_lift = ib_ratio = roi = None

    return {
        'slate': slate_entry['slate'],
        'numTeams': slate_entry.get('numTeams', 0),
        'totalEntries': F,
        'lineups': n,
        'mean_proj': statistics.mean(projs),
        'std_proj': statistics.stdev(projs) if n > 1 else 0,
        'mean_salary': statistics.mean(sals),
        'mean_own_sum': statistics.mean(own_sums),
        'std_own_sum': statistics.stdev(own_sums) if n > 1 else 0,
        'mean_geo_own_hit': statistics.mean(geo_owns),
        'pct_5plus_stack': stack_pct['5plus'],
        'pct_4_stack': stack_pct['4'],
        'pct_3_3_stack': stack_pct['3_3'],
        'pct_naked_other': stack_pct['other'],
        'bb_rate_ge1': bb_at_least_1 / n,
        'bb_rate_eq1': bb_eq_1 / n,
        'bb_rate_ge2': bb_eq_2plus / n,
        'mean_pairwise_jaccard': mean_jacc,
        'max_pairwise_jaccard': max_jacc,
        'unique_players': unique_players,
        'band_HP_HO': band_pct['HP_HO'],
        'band_HP_LO': band_pct['HP_LO'],
        'band_LP_HO': band_pct['LP_HO'],
        'band_LP_LO': band_pct['LP_LO'],
        'outcome_top1_lift': t1_lift,
        'outcome_top01_lift': t01_lift,
        'outcome_inverse_bell_ratio': ib_ratio,
        'outcome_roi': roi,
    }


# -------------- main --------------
def main():
    old = json.load(OLD_DUMP.open())
    new = json.load(NEW_DUMP.open())

    print(f"Old dump: {len(old)} slates")
    print(f"New dump: {len(new)} slates")

    metrics_by_slate = []
    for entry in old:
        m = compute_slate_metrics(entry, "vNoCorr")
        if m: m['source'] = 'baseline_24'; metrics_by_slate.append(m)
    for entry in new:
        m = compute_slate_metrics(entry, "vNoCorr")
        if m: m['source'] = 'new_4'; metrics_by_slate.append(m)

    # Save per_slate_metrics.csv
    cols = list(metrics_by_slate[0].keys())
    with open(OUT / "per_slate_metrics.csv", "w", newline='') as f:
        import csv
        wtr = csv.DictWriter(f, fieldnames=cols)
        wtr.writeheader()
        for r in metrics_by_slate: wtr.writerow(r)
    print(f"Wrote per_slate_metrics.csv ({len(metrics_by_slate)} rows)")

    # ---- Stage 4: comparison ----
    METRIC_COLS = [
        'mean_proj','std_proj','mean_salary','mean_own_sum','std_own_sum','mean_geo_own_hit',
        'pct_5plus_stack','pct_4_stack','pct_3_3_stack','pct_naked_other',
        'bb_rate_ge1','bb_rate_eq1','bb_rate_ge2',
        'mean_pairwise_jaccard','max_pairwise_jaccard','unique_players',
        'band_HP_HO','band_HP_LO','band_LP_HO','band_LP_LO',
        'outcome_top1_lift','outcome_top01_lift','outcome_inverse_bell_ratio','outcome_roi',
    ]
    baseline = [m for m in metrics_by_slate if m['source'] == 'baseline_24']
    newset = [m for m in metrics_by_slate if m['source'] == 'new_4']

    comparison_rows = []
    for col in METRIC_COLS:
        bvals = [m[col] for m in baseline if m[col] is not None]
        nvals = [m[col] for m in newset if m[col] is not None]
        if not bvals or not nvals:
            continue
        bmean = statistics.mean(bvals)
        bstd = statistics.stdev(bvals) if len(bvals) > 1 else 0.0
        nmean = statistics.mean(nvals)
        z = (nmean - bmean) / bstd if bstd > 1e-9 else 0.0
        absz = abs(z)
        if absz <= 0.5: flag = "No drift"
        elif absz <= 1.5: flag = "Mild drift"
        else: flag = "Notable drift"
        per_slate_z = []
        for m in newset:
            if m[col] is None: continue
            zi = (m[col] - bmean) / bstd if bstd > 1e-9 else 0.0
            per_slate_z.append((m['slate'], m[col], zi))
        comparison_rows.append({
            'metric': col,
            'baseline_mean': bmean,
            'baseline_std': bstd,
            'new_mean': nmean,
            'aggregate_z': z,
            'flag': flag,
            'per_slate_z': "; ".join([f"{s}={v:.4f}(z={zi:+.2f})" for s, v, zi in per_slate_z]),
        })

    with open(OUT / "baseline_comparison.csv", "w", newline='') as f:
        import csv
        wtr = csv.DictWriter(f, fieldnames=list(comparison_rows[0].keys()))
        wtr.writeheader()
        for r in comparison_rows: wtr.writerow(r)
    print(f"Wrote baseline_comparison.csv ({len(comparison_rows)} metrics)")

    # ---- Stage 6: 28-slate baseline ----
    baseline_28 = []
    for col in METRIC_COLS:
        vals = [m[col] for m in metrics_by_slate if m[col] is not None]
        if not vals: continue
        baseline_28.append({
            'metric': col,
            'mean_28': statistics.mean(vals),
            'std_28': statistics.stdev(vals) if len(vals) > 1 else 0.0,
            'min_28': min(vals),
            'max_28': max(vals),
            'n': len(vals),
        })
    with open(OUT / "v1_28_slate_baseline.csv", "w", newline='') as f:
        import csv
        wtr = csv.DictWriter(f, fieldnames=list(baseline_28[0].keys()))
        wtr.writeheader()
        for r in baseline_28: wtr.writerow(r)
    print(f"Wrote v1_28_slate_baseline.csv ({len(baseline_28)} metrics)")

    # ---- Print top drift metrics ----
    sorted_drift = sorted(comparison_rows, key=lambda r: -abs(r['aggregate_z']))
    print("\nTop 10 drift metrics by |z|:")
    for r in sorted_drift[:10]:
        print(f"  {r['metric']:30s}  baseline={r['baseline_mean']:+.4f}+-{r['baseline_std']:.4f}  new={r['new_mean']:+.4f}  z={r['aggregate_z']:+.2f}  [{r['flag']}]")

    # Stage 5 — per-slate context
    print("\nStage 5 per-slate context:")
    new_metrics = {m['slate']: m for m in newset}
    base_metrics = {m['slate']: m for m in baseline}
    with open(OUT / "per_slate_context.md", "w") as f:
        f.write("# Stage 5 — Per-Slate Context for the 4 New Slates\n\n")
        for entry in new:
            slate = entry['slate']
            m = new_metrics[slate]
            f.write(f"## {slate}\n\n")
            f.write(f"- **Team count:** {entry['numTeams']}\n")
            f.write(f"- **Pool size:** {entry.get('poolSize', 'n/a')}\n")
            f.write(f"- **Field entries (DK contest):** {entry['totalEntries']}\n")
            f.write(f"- **Pool optimal projection:** {entry.get('optimalProj', 0):.1f}\n")
            f.write(f"- **V1-NoCorr fill:** {m['lineups']}/150\n\n")
            f.write(f"**Structural metrics:**\n\n")
            f.write(f"- Mean projection: {m['mean_proj']:.2f} (std {m['std_proj']:.2f})\n")
            f.write(f"- Mean salary: ${m['mean_salary']:.0f}\n")
            f.write(f"- Mean ownership sum: {m['mean_own_sum']:.1f}%\n")
            f.write(f"- Geo-mean ownership (hitters): {m['mean_geo_own_hit']:.1f}%\n")
            f.write(f"- Stack 5+: {m['pct_5plus_stack']*100:.1f}% / 4: {m['pct_4_stack']*100:.1f}% / 3-3: {m['pct_3_3_stack']*100:.1f}% / other: {m['pct_naked_other']*100:.1f}%\n")
            f.write(f"- Bring-back rate (>=1): {m['bb_rate_ge1']*100:.1f}% (=1: {m['bb_rate_eq1']*100:.1f}%, >=2: {m['bb_rate_ge2']*100:.1f}%)\n")
            f.write(f"- Mean pairwise Jaccard: {m['mean_pairwise_jaccard']:.3f} (max {m['max_pairwise_jaccard']:.3f})\n")
            f.write(f"- Unique players: {m['unique_players']}\n")
            f.write(f"- Bands HP/HO {m['band_HP_HO']*100:.0f}% HP/LO {m['band_HP_LO']*100:.0f}% LP/HO {m['band_LP_HO']*100:.0f}% LP/LO {m['band_LP_LO']*100:.0f}%\n")
            if m['outcome_top1_lift'] is not None:
                f.write(f"- **Outcome:** top-1% lift {m['outcome_top1_lift']:.2f}x, top-0.1% lift {m['outcome_top01_lift']:.2f}x, ROI {m['outcome_roi']*100:+.1f}%, inverse-bell {m['outcome_inverse_bell_ratio']:.2f}\n")
            # Find nearest baseline slate by team count
            same_team_count = [b for b in baseline if b['numTeams'] == entry['numTeams']]
            if same_team_count:
                f.write(f"\n**Most similar baseline slates (same team count = {entry['numTeams']}):** {', '.join(b['slate'] for b in same_team_count)}\n")
            f.write("\n")
        f.write("\n## Notes\n\n")
        f.write("- Sample is n=4. All comparisons descriptive only.\n")
        f.write("- 5-4-26-late and 5-3-26-late are small slates (3 and 4 games respectively); expect higher pairwise Jaccard, lower unique-player counts, and tighter ownership distribution.\n")
        f.write("- 5-5-26 is the largest of the new slates (10 games, 20 teams) — directly comparable to other 16-team slates in baseline.\n")
    print(f"Wrote per_slate_context.md")

    return metrics_by_slate, comparison_rows, baseline_28

if __name__ == '__main__':
    main()
