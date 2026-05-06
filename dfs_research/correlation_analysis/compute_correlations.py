"""
Stages 2-4: compute pairwise lineup correlations (full + simple methods)
for V1 and per-pro portfolios across 24 slates. Save:
  - v1_pairwise_correlations.json (per-slate distribution stats + raw arrays)
  - pro_pairwise_correlations.json (per-slate per-pro distribution stats + raw arrays)
  - distribution_comparison.csv
  - per_slate_correlation_comparison.csv

Methodology is locked in METHODOLOGY.md (timestamp 2026-05-05T14:00:08Z).
No parameter fitting; framework R-values used as-is.
"""

import json
import os
import sys
import time
from collections import defaultdict

import numpy as np

DUMP_PATH = r"C:/Users/colin/dfs opto/theory_dfs_v2/v1_pros_lineup_dump.json"
OUT_DIR = r"C:/Users/colin/dfs opto/correlation_analysis"

# Framework R-values (LOCKED in METHODOLOGY.md)
R_SHARED = 1.00
R_PVH = -0.30  # pitcher vs opp hitter (per matched-pitcher, each direction)
R_SAMETEAM = 0.10  # same-team hitter cross-pair, excl. shared
NORMALIZE = 10.0
SIMPLE_PENALTY = 0.5  # per pitcher-vs-opp-primary direction

# Distribution thresholds (LOCKED)
THRESH_NEG = 0.0
THRESH_STRONG_NEG = -0.30
THRESH_WEAK_LO = -0.10
THRESH_WEAK_HI = +0.10
THRESH_STRONG_POS = +0.50

MIN_LINEUPS_FOR_PRO_SLATE = 5  # need >= 10 pairs


def encode_lineup(L):
    """Return precomputed lineup features for fast pair computation.

    Returns dict with:
      pid_set: frozenset of pids (str)
      hitter_pids: frozenset (pids minus pitcher pids)
      hitter_team_pids: list of (team, pid) for hitters
      hitter_teams_set: set of teams that have hitters
      pitcher_opps: list of opp teams (the teams pitchers in this lineup face)
      primary_team: str or None
    """
    pids = list(L["pids"])
    pitcher_ids = list(L.get("pitcherIds", []))
    pitcher_set = set(pitcher_ids)
    teams = list(L["teams"])
    pitcher_opps = list(L.get("pitcherOpps", []))
    primary = L.get("primaryTeam")

    # hitters = pids that are NOT pitchers, with their team
    hitter_team_pids = []
    for pid, t in zip(pids, teams):
        if pid not in pitcher_set:
            hitter_team_pids.append((t, pid))
    return {
        "pid_set": frozenset(pids),
        "pitcher_set": pitcher_set,
        "hitter_team_pids": hitter_team_pids,
        "pitcher_opps": pitcher_opps,
        "primary_team": primary,
    }


def pair_correlation(A, B):
    """Return (full_normalized, simple) for an encoded pair (A,B)."""
    # 1) shared player ids
    shared = A["pid_set"] & B["pid_set"]
    n_shared = len(shared)

    # 2) pitcher-vs-opp-hitter, both directions
    # Direction A->B: count pitchers in A whose opp team has hitters in B
    B_hitter_teams = {t for (t, _) in B["hitter_team_pids"]}
    A_hitter_teams = {t for (t, _) in A["hitter_team_pids"]}

    n_pvh_a_to_b = sum(1 for opp in A["pitcher_opps"] if opp in B_hitter_teams)
    n_pvh_b_to_a = sum(1 for opp in B["pitcher_opps"] if opp in A_hitter_teams)

    # 3) same-team hitter cross-pairs, excluding shared pids
    # iterate hitters of A x hitters of B; count if same team and pids differ
    # exclude shared pids: a hitter pid that appears in BOTH lineups should not contribute
    # (matches the "NOT already counted as shared" rule).
    A_hitters = [(t, p) for (t, p) in A["hitter_team_pids"] if p not in shared]
    B_hitters = [(t, p) for (t, p) in B["hitter_team_pids"] if p not in shared]
    # group B hitters by team for efficiency
    B_by_team = defaultdict(list)
    for (t, p) in B_hitters:
        B_by_team[t].append(p)
    n_sameteam = 0
    for (t, pa) in A_hitters:
        if t in B_by_team:
            for pb in B_by_team[t]:
                if pa != pb:
                    n_sameteam += 1

    raw = (
        R_SHARED * n_shared
        + R_PVH * n_pvh_a_to_b
        + R_PVH * n_pvh_b_to_a
        + R_SAMETEAM * n_sameteam
    )
    full_norm = raw / NORMALIZE

    # Simple method
    union = A["pid_set"] | B["pid_set"]
    jaccard = n_shared / len(union) if union else 0.0
    penalty = 0.0
    primB = B["primary_team"]
    primA = A["primary_team"]
    if primB is not None and primB in A["pitcher_opps"]:
        penalty += SIMPLE_PENALTY
    if primA is not None and primA in B["pitcher_opps"]:
        penalty += SIMPLE_PENALTY
    simple = jaccard - penalty
    return full_norm, simple


def portfolio_pair_corrs(lineups):
    """Compute all pair correlations for a list of lineup dicts.
    Returns (full_array, simple_array) numpy arrays of length N*(N-1)/2.
    """
    encoded = [encode_lineup(L) for L in lineups]
    N = len(encoded)
    n_pairs = N * (N - 1) // 2
    full = np.empty(n_pairs, dtype=np.float32)
    simple = np.empty(n_pairs, dtype=np.float32)
    idx = 0
    for i in range(N):
        Ai = encoded[i]
        for j in range(i + 1, N):
            f, s = pair_correlation(Ai, encoded[j])
            full[idx] = f
            simple[idx] = s
            idx += 1
    return full, simple


def distribution_stats(arr):
    """Compute summary stats. arr is numpy float32 array."""
    if len(arr) == 0:
        return {
            "n_pairs": 0,
            "mean": None, "std": None,
            "q25": None, "q50": None, "q75": None,
            "min": None, "max": None,
            "frac_neg": None, "frac_strong_neg": None,
            "frac_weak": None, "frac_strong_pos": None,
        }
    return {
        "n_pairs": int(len(arr)),
        "mean": float(np.mean(arr)),
        "std": float(np.std(arr)),
        "q25": float(np.quantile(arr, 0.25)),
        "q50": float(np.quantile(arr, 0.50)),
        "q75": float(np.quantile(arr, 0.75)),
        "min": float(np.min(arr)),
        "max": float(np.max(arr)),
        "frac_neg": float(np.mean(arr < THRESH_NEG)),
        "frac_strong_neg": float(np.mean(arr < THRESH_STRONG_NEG)),
        "frac_weak": float(np.mean((arr > THRESH_WEAK_LO) & (arr < THRESH_WEAK_HI))),
        "frac_strong_pos": float(np.mean(arr > THRESH_STRONG_POS)),
    }


def topk_negative_indices(arr, k=10):
    """Return indices of the k smallest (most negative) values."""
    if len(arr) <= k:
        return list(np.argsort(arr))
    return list(np.argsort(arr)[:k])


def main():
    print("Loading dump...", flush=True)
    t0 = time.time()
    with open(DUMP_PATH, "r") as f:
        data = json.load(f)
    print(f"Loaded {len(data)} slates in {time.time()-t0:.1f}s", flush=True)

    v1_results = {}  # slate -> {full_stats, simple_stats, top10_full_idx, top10_simple_idx, full_arr_summary}
    pro_results = {}  # slate -> {pro -> stats}

    # For cross-method consistency check: per portfolio, top-10 overlap
    crossmethod_overlap = []  # (label, slate, pro, overlap_count)

    grand_v1_pairs = 0
    grand_pro_pairs = 0

    for s_idx, slate in enumerate(data):
        sl_name = slate["slate"]
        print(f"\n=== Slate {s_idx+1}/{len(data)}: {sl_name} ===", flush=True)
        # --- V1 ---
        v1 = slate.get("v1", [])
        print(f"  V1: {len(v1)} lineups", flush=True)
        ts = time.time()
        full_v1, simple_v1 = portfolio_pair_corrs(v1)
        grand_v1_pairs += len(full_v1)
        v1_full_stats = distribution_stats(full_v1)
        v1_simple_stats = distribution_stats(simple_v1)
        # cross-method overlap
        top_full = set(topk_negative_indices(full_v1, 10))
        top_simple = set(topk_negative_indices(simple_v1, 10))
        overlap_v1 = len(top_full & top_simple)
        crossmethod_overlap.append(("V1", sl_name, "-", overlap_v1))
        v1_results[sl_name] = {
            "n_lineups": len(v1),
            "full": v1_full_stats,
            "simple": v1_simple_stats,
            "top10_overlap": overlap_v1,
        }
        print(f"    V1 full mean={v1_full_stats['mean']:.4f} frac_neg={v1_full_stats['frac_neg']:.3f}  simple mean={v1_simple_stats['mean']:.4f} frac_neg={v1_simple_stats['frac_neg']:.3f}  ({time.time()-ts:.1f}s)", flush=True)

        # --- Pros (per user) ---
        pros = slate.get("pros", [])
        by_user = defaultdict(list)
        for p in pros:
            by_user[p.get("user")].append(p)
        pro_results[sl_name] = {}
        for user, lineups in by_user.items():
            if user is None:
                continue
            if len(lineups) < MIN_LINEUPS_FOR_PRO_SLATE:
                continue
            ts = time.time()
            full_p, simple_p = portfolio_pair_corrs(lineups)
            grand_pro_pairs += len(full_p)
            full_stats = distribution_stats(full_p)
            simple_stats = distribution_stats(simple_p)
            top_full_p = set(topk_negative_indices(full_p, 10))
            top_simple_p = set(topk_negative_indices(simple_p, 10))
            overlap_p = len(top_full_p & top_simple_p)
            crossmethod_overlap.append(("Pro", sl_name, user, overlap_p))
            pro_results[sl_name][user] = {
                "n_lineups": len(lineups),
                "full": full_stats,
                "simple": simple_stats,
                "top10_overlap": overlap_p,
            }
            print(f"    {user}: {len(lineups)} lineups  full mean={full_stats['mean']:.4f} frac_neg={full_stats['frac_neg']:.3f}  simple mean={simple_stats['mean']:.4f} frac_neg={simple_stats['frac_neg']:.3f}  ({time.time()-ts:.1f}s)", flush=True)

    print(f"\nTotal V1 pairs: {grand_v1_pairs}", flush=True)
    print(f"Total Pro pairs: {grand_pro_pairs}", flush=True)

    # --- Save JSON outputs ---
    with open(os.path.join(OUT_DIR, "v1_pairwise_correlations.json"), "w") as f:
        json.dump({
            "methodology_locked_utc": "2026-05-05T14:00:08Z",
            "total_pairs": grand_v1_pairs,
            "per_slate": v1_results,
        }, f, indent=2)

    with open(os.path.join(OUT_DIR, "pro_pairwise_correlations.json"), "w") as f:
        json.dump({
            "methodology_locked_utc": "2026-05-05T14:00:08Z",
            "total_pairs": grand_pro_pairs,
            "per_slate_per_pro": pro_results,
        }, f, indent=2)

    # --- Stage 4: distribution comparison CSV ---
    # Aggregate per "portfolio name": V1, each pro
    # For V1: average each statistic across all 24 slates (equal-weighted)
    # For each pro: average across slates where the pro has >= MIN_LINEUPS_FOR_PRO_SLATE

    def agg_stats(per_slate_stats_list, key):
        """Average a key across a list of per-slate stat dicts."""
        vals = [s[key] for s in per_slate_stats_list if s.get(key) is not None]
        return float(np.mean(vals)) if vals else None

    keys = ["mean", "std", "q25", "q50", "q75",
            "frac_neg", "frac_strong_neg", "frac_weak", "frac_strong_pos"]

    portfolios = {}  # name -> {method -> stats per slate list}
    portfolios["V1"] = {"full": [], "simple": []}
    for sl in v1_results:
        portfolios["V1"]["full"].append(v1_results[sl]["full"])
        portfolios["V1"]["simple"].append(v1_results[sl]["simple"])

    all_pros = set()
    for sl in pro_results:
        for u in pro_results[sl]:
            all_pros.add(u)
    for u in sorted(all_pros):
        portfolios[u] = {"full": [], "simple": []}
        for sl in pro_results:
            if u in pro_results[sl]:
                portfolios[u]["full"].append(pro_results[sl][u]["full"])
                portfolios[u]["simple"].append(pro_results[sl][u]["simple"])

    # Pro-average: mean of per-slate stats across all pro-slates (each pro-slate weighted equal)
    pro_avg_full = []
    pro_avg_simple = []
    for sl in pro_results:
        for u in pro_results[sl]:
            pro_avg_full.append(pro_results[sl][u]["full"])
            pro_avg_simple.append(pro_results[sl][u]["simple"])

    # Write CSV
    csv_path = os.path.join(OUT_DIR, "distribution_comparison.csv")
    with open(csv_path, "w") as f:
        # header
        cols = ["portfolio", "method", "n_slates"]
        for k in keys:
            cols.append(k)
        f.write(",".join(cols) + "\n")

        def write_row(name, method, stats_list):
            n = len(stats_list)
            row = [name, method, str(n)]
            for k in keys:
                v = agg_stats(stats_list, k)
                row.append("" if v is None else f"{v:.6f}")
            f.write(",".join(row) + "\n")

        # V1
        write_row("V1", "full", portfolios["V1"]["full"])
        write_row("V1", "simple", portfolios["V1"]["simple"])
        # Each pro
        for u in sorted(all_pros):
            write_row(u, "full", portfolios[u]["full"])
            write_row(u, "simple", portfolios[u]["simple"])
        # Pro average
        write_row("PRO_AVERAGE", "full", pro_avg_full)
        write_row("PRO_AVERAGE", "simple", pro_avg_simple)
    print(f"Wrote {csv_path}", flush=True)

    # --- Stage 5: per-slate comparison CSV ---
    per_slate_csv = os.path.join(OUT_DIR, "per_slate_correlation_comparison.csv")
    with open(per_slate_csv, "w") as f:
        cols = ["slate", "method",
                "v1_mean", "v1_frac_neg", "v1_frac_strong_neg", "v1_frac_strong_pos",
                "proavg_mean", "proavg_frac_neg", "proavg_frac_strong_neg", "proavg_frac_strong_pos",
                "n_pros_in_slate",
                "gap_frac_neg",      # proavg - v1
                "gap_frac_strong_neg",  # proavg - v1
                ]
        f.write(",".join(cols) + "\n")
        for sl in v1_results:
            for method in ("full", "simple"):
                v1s = v1_results[sl][method]
                pros_in_slate = list(pro_results.get(sl, {}).values())
                n_pros = len(pros_in_slate)
                if n_pros == 0:
                    proavg = {k: None for k in keys}
                else:
                    pa_stats_list = [p[method] for p in pros_in_slate]
                    proavg = {k: agg_stats(pa_stats_list, k) for k in keys}
                row = [sl, method,
                       f"{v1s['mean']:.6f}",
                       f"{v1s['frac_neg']:.6f}",
                       f"{v1s['frac_strong_neg']:.6f}",
                       f"{v1s['frac_strong_pos']:.6f}",
                       "" if proavg["mean"] is None else f"{proavg['mean']:.6f}",
                       "" if proavg["frac_neg"] is None else f"{proavg['frac_neg']:.6f}",
                       "" if proavg["frac_strong_neg"] is None else f"{proavg['frac_strong_neg']:.6f}",
                       "" if proavg["frac_strong_pos"] is None else f"{proavg['frac_strong_pos']:.6f}",
                       str(n_pros),
                       "" if proavg["frac_neg"] is None else f"{proavg['frac_neg'] - v1s['frac_neg']:.6f}",
                       "" if proavg["frac_strong_neg"] is None else f"{proavg['frac_strong_neg'] - v1s['frac_strong_neg']:.6f}",
                       ]
                f.write(",".join(row) + "\n")
    print(f"Wrote {per_slate_csv}", flush=True)

    # --- Cross-method overlap summary ---
    overlap_path = os.path.join(OUT_DIR, "cross_method_overlap.csv")
    with open(overlap_path, "w") as f:
        f.write("portfolio_type,slate,user,top10_overlap\n")
        for label, sl, user, ov in crossmethod_overlap:
            f.write(f"{label},{sl},{user},{ov}\n")
    print(f"Wrote {overlap_path}", flush=True)

    # Print summary stats
    print("\n=== AGGREGATE RESULTS ===")
    print("V1 (full method):")
    for k in keys:
        v = agg_stats(portfolios["V1"]["full"], k)
        print(f"  {k}: {v}")
    print("V1 (simple method):")
    for k in keys:
        v = agg_stats(portfolios["V1"]["simple"], k)
        print(f"  {k}: {v}")
    print("PRO_AVERAGE (full method):")
    for k in keys:
        v = agg_stats(pro_avg_full, k)
        print(f"  {k}: {v}")
    print("PRO_AVERAGE (simple method):")
    for k in keys:
        v = agg_stats(pro_avg_simple, k)
        print(f"  {k}: {v}")

    # Cross-method overlap
    overlaps = [ov for (_, _, _, ov) in crossmethod_overlap]
    print(f"\nCross-method top10 overlap: mean={np.mean(overlaps):.2f} median={np.median(overlaps):.2f} min={np.min(overlaps)} max={np.max(overlaps)}")

    print("\nDone.")
    return v1_results, pro_results


if __name__ == "__main__":
    main()
