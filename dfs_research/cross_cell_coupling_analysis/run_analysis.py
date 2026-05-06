"""
Cross-Cell Coupling Analysis — Stages 2-6
Descriptive only. Methodology locked in METHODOLOGY.md.
"""
import json
import csv
import os
from collections import Counter, defaultdict
import numpy as np

DATA = "C:/Users/colin/dfs opto/theory_dfs_v2/v1_pros_lineup_dump.json"
OUT = "C:/Users/colin/dfs opto/cross_cell_coupling_analysis"

MIN_LINEUPS_PER_PRIMARY_TEAM = 10
BOOT_RESAMPLES = 10_000
SEED = 42

PROS = ["b_heals152", "bgreseth", "needlunchmoney", "nerdytenor",
        "shaidyadvice", "shipmymoney", "youdacao", "zroth2"]
ENTITIES = ["v1"] + PROS


# ---------------------------------------------------------------------------
# Cell extraction
# ---------------------------------------------------------------------------
def extract_cells(lu):
    """Return (cell1, cell2, cell3) for a lineup dict.

    cell1 = sorted tuple of primary-team hitter pids
    cell2 = sorted tuple of bring-back hitter pids, or "NO_BRINGBACK"
    cell3 = sorted tuple of pitcher pids
    """
    pids = lu["pids"]
    teams = lu["teams"]
    pitcher_ids = set(lu["pitcherIds"])
    primary = lu["primaryTeam"]
    bringback = lu["bringBack"]

    # Hitter ids per team (exclude pitchers)
    hitter_pids_by_team = defaultdict(list)
    for pid, team in zip(pids, teams):
        if pid in pitcher_ids:
            continue
        hitter_pids_by_team[team].append(pid)

    # Cell 1: primary stack hitters (top primarySize by team) -- but
    # primarySize is number of hitters from primary team in lineup; we use all
    # primary-team hitters in this lineup.
    cell1_pids = sorted(hitter_pids_by_team.get(primary, []))
    cell1 = tuple(cell1_pids)

    # Cell 2: bring-back set
    if bringback == 0 or bringback is None:
        cell2 = "NO_BRINGBACK"
    else:
        # Find the team (not primary) with exactly `bringback` hitters
        # (excluding pitcher teams). Tie-break: pick the team with the most
        # hitters, equal to bringback.
        candidates = []
        for tm, hpids in hitter_pids_by_team.items():
            if tm == primary:
                continue
            if len(hpids) == bringback:
                candidates.append((tm, sorted(hpids)))
        if len(candidates) == 1:
            cell2 = tuple(candidates[0][1])
        elif len(candidates) > 1:
            # Multiple teams with same hitter count; cannot disambiguate
            # without explicit opponent metadata. Use the team whose hitters
            # are the bring-back -- best heuristic: take the team whose pids
            # appear in the same matchup as primary. Without matchup data we
            # fall back to deterministic choice: lexicographic team id.
            candidates.sort(key=lambda x: x[0])
            cell2 = tuple(candidates[0][1])
        else:
            # No team matches exactly -> degraded; use any non-primary,
            # non-pitcher hitters of size = bringback if exists at all.
            cell2 = "NO_BRINGBACK_DEGRADED"

    # Cell 3
    cell3 = tuple(sorted(lu["pitcherIds"]))

    return cell1, cell2, cell3


# ---------------------------------------------------------------------------
# Per-entity-per-slate metrics
# ---------------------------------------------------------------------------
def compute_instance(lineups):
    """Compute marginal+joint metrics for one (entity, slate) instance.

    Returns dict or None if filter fails.
    """
    if not lineups:
        return None

    # Group by primary team
    by_primary = defaultdict(list)
    for lu in lineups:
        by_primary[lu["primaryTeam"]].append(lu)

    # ----- Cell 1 marginal (lineup-weighted across primary teams) -----
    total = len(lineups)
    cell1_top1_count = 0
    for pt, lus in by_primary.items():
        cell1_counter = Counter(extract_cells(lu)[0] for lu in lus)
        if cell1_counter:
            cell1_top1_count += cell1_counter.most_common(1)[0][1]
    cell1_marginal_top1 = cell1_top1_count / total

    # ----- Cell 2 marginal: condition on (primaryTeam, bringBackTeam) -----
    by_pt_bb = defaultdict(list)
    for lu in lineups:
        c1, c2, c3 = extract_cells(lu)
        # For grouping the bring-back team, compress c2 -> categorical key
        if isinstance(c2, str):
            bb_key = c2
        else:
            # Identify bb team via lookup of any pid back to its team
            # pid -> team
            pid_to_team = dict(zip(lu["pids"], lu["teams"]))
            bb_team = pid_to_team[c2[0]] if c2 else "NO_BRINGBACK"
            bb_key = bb_team
        by_pt_bb[(lu["primaryTeam"], bb_key)].append((lu, c2))

    cell2_top1_count = 0
    for key, group in by_pt_bb.items():
        c2_counter = Counter(c2 for (_, c2) in group)
        if c2_counter:
            cell2_top1_count += c2_counter.most_common(1)[0][1]
    cell2_marginal_top1 = cell2_top1_count / total

    # ----- Cell 3 marginal across all lineups -----
    c3_counter = Counter(extract_cells(lu)[2] for lu in lineups)
    if c3_counter:
        sorted_counts = c3_counter.most_common()
        cell3_top1 = sorted_counts[0][1] / total
        cell3_top2 = sum(c for _, c in sorted_counts[:2]) / total
        cell3_top3 = sum(c for _, c in sorted_counts[:3]) / total
    else:
        cell3_top1 = cell3_top2 = cell3_top3 = 0.0

    # ----- Filter: must have top-1 primary team with >=10 lineups -----
    primary_counter = Counter(lu["primaryTeam"] for lu in lineups)
    top_primary, top_primary_count = primary_counter.most_common(1)[0]
    if top_primary_count < MIN_LINEUPS_PER_PRIMARY_TEAM:
        return {
            "filter_passed": False,
            "top_primary": top_primary,
            "top_primary_count": top_primary_count,
            "cell1_marginal_top1": cell1_marginal_top1,
            "cell2_marginal_top1": cell2_marginal_top1,
            "cell3_marginal_top1": cell3_top1,
        }

    # Restrict joint analysis to top primaryTeam subset
    sub = [lu for lu in lineups if lu["primaryTeam"] == top_primary]
    n_sub = len(sub)

    cells = [extract_cells(lu) for lu in sub]
    c1_list = [c[0] for c in cells]
    c2_list = [c[1] for c in cells]
    c3_list = [c[2] for c in cells]

    c1_ctr = Counter(c1_list)
    c2_ctr = Counter(c2_list)
    c3_ctr = Counter(c3_list)
    c1_star, c1_count = c1_ctr.most_common(1)[0]
    c2_star, c2_count = c2_ctr.most_common(1)[0]
    c3_star, c3_count = c3_ctr.most_common(1)[0]
    p1 = c1_count / n_sub
    p2 = c2_count / n_sub
    p3 = c3_count / n_sub

    # Joint counts
    j12 = sum(1 for (a, b, _) in cells if a == c1_star and b == c2_star) / n_sub
    j13 = sum(1 for (a, _, c) in cells if a == c1_star and c == c3_star) / n_sub
    j23 = sum(1 for (_, b, c) in cells if b == c2_star and c == c3_star) / n_sub
    j123 = sum(1 for (a, b, c) in cells if a == c1_star and b == c2_star and c == c3_star) / n_sub

    def safe_div(num, den):
        return num / den if den > 0 else float("nan")

    coup12 = safe_div(j12, p1 * p2)
    coup13 = safe_div(j13, p1 * p3)
    coup23 = safe_div(j23, p2 * p3)
    coup123 = safe_div(j123, p1 * p2 * p3)

    # Herfindahl over joint (c1,c2,c3) on top-primary subset
    joint_ctr = Counter(zip(c1_list, c2_list, c3_list))
    joint_freqs = [c / n_sub for c in joint_ctr.values()]
    herfindahl_joint = sum(f * f for f in joint_freqs)

    return {
        "filter_passed": True,
        "n_lineups_total": total,
        "top_primary": top_primary,
        "n_top_primary": n_sub,
        "cell1_marginal_top1": cell1_marginal_top1,
        "cell2_marginal_top1": cell2_marginal_top1,
        "cell3_marginal_top1": cell3_top1,
        "cell3_marginal_top2": cell3_top2,
        "cell3_marginal_top3": cell3_top3,
        "p1_top": p1,
        "p2_top": p2,
        "p3_top": p3,
        "j12": j12,
        "j13": j13,
        "j23": j23,
        "j123": j123,
        "coup12": coup12,
        "coup13": coup13,
        "coup23": coup23,
        "coup123": coup123,
        "herfindahl_joint": herfindahl_joint,
        "p123_dominance_sq": j123 * j123,
    }


# ---------------------------------------------------------------------------
# Bootstrap utilities
# ---------------------------------------------------------------------------
def bootstrap_mean_ci(values, rng, n_resamples=BOOT_RESAMPLES, alpha=0.05):
    arr = np.array([v for v in values if not (isinstance(v, float) and np.isnan(v))])
    if len(arr) == 0:
        return float("nan"), float("nan"), float("nan")
    n = len(arr)
    means = np.empty(n_resamples)
    for i in range(n_resamples):
        idx = rng.integers(0, n, size=n)
        means[i] = arr[idx].mean()
    lo = np.percentile(means, 100 * alpha / 2)
    hi = np.percentile(means, 100 * (1 - alpha / 2))
    return float(arr.mean()), float(lo), float(hi)


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------
def main():
    print("Loading data...")
    with open(DATA) as f:
        slates = json.load(f)
    print(f"  {len(slates)} slates loaded")

    # ----- Stage 2 + 3: per-instance metrics -----
    instances = defaultdict(list)  # entity -> list of dicts
    instance_records = []  # full per-(entity,slate) rows for csv

    for s in slates:
        slate_id = s["slate"]
        # v1
        v1_inst = compute_instance(s["v1"])
        if v1_inst is not None:
            v1_inst["entity"] = "v1"
            v1_inst["slate"] = slate_id
            instance_records.append(v1_inst)
            if v1_inst["filter_passed"]:
                instances["v1"].append(v1_inst)
        # pros — group by user
        by_user = defaultdict(list)
        for lu in s["pros"]:
            by_user[lu["user"]].append(lu)
        for user, lus in by_user.items():
            inst = compute_instance(lus)
            if inst is not None:
                inst["entity"] = user
                inst["slate"] = slate_id
                instance_records.append(inst)
                if inst["filter_passed"]:
                    instances[user].append(inst)

    # ----- Save raw instance records -----
    fields = sorted({k for r in instance_records for k in r.keys()})
    with open(os.path.join(OUT, "instances_raw.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for r in instance_records:
            w.writerow(r)
    print("Wrote instances_raw.csv")

    # ----- Stage 4: aggregate coupling per entity, with bootstrap CIs -----
    rng = np.random.default_rng(SEED)
    metrics = ["coup12", "coup13", "coup23", "coup123",
               "cell1_marginal_top1", "cell2_marginal_top1", "cell3_marginal_top1",
               "p1_top", "p2_top", "p3_top",
               "j12", "j13", "j23", "j123",
               "herfindahl_joint", "p123_dominance_sq"]
    table = []
    for entity in ENTITIES:
        recs = instances.get(entity, [])
        n = len(recs)
        row = {"entity": entity, "n_slates_passing": n}
        for m in metrics:
            vals = [r[m] for r in recs if m in r]
            mean, lo, hi = bootstrap_mean_ci(vals, rng)
            row[f"{m}_mean"] = mean
            row[f"{m}_ci_lo"] = lo
            row[f"{m}_ci_hi"] = hi
        table.append(row)

    # ----- Pro avg: bootstrap over the 8 pros -----
    pro_means_by_metric = {}
    for m in metrics:
        per_pro = []
        for pro in PROS:
            recs = instances.get(pro, [])
            vals = [r[m] for r in recs if m in r]
            arr = np.array([v for v in vals if not (isinstance(v, float) and np.isnan(v))])
            per_pro.append(arr.mean() if len(arr) else float("nan"))
        per_pro = np.array(per_pro)
        valid = per_pro[~np.isnan(per_pro)]
        n = len(valid)
        if n == 0:
            pro_means_by_metric[m] = (float("nan"),) * 3
            continue
        boot_means = np.empty(BOOT_RESAMPLES)
        for i in range(BOOT_RESAMPLES):
            idx = rng.integers(0, n, size=n)
            boot_means[i] = valid[idx].mean()
        lo = float(np.percentile(boot_means, 2.5))
        hi = float(np.percentile(boot_means, 97.5))
        pro_means_by_metric[m] = (float(valid.mean()), lo, hi)

    pro_row = {"entity": "PRO_AVG", "n_slates_passing": sum(len(instances.get(p, [])) for p in PROS)}
    for m in metrics:
        mean, lo, hi = pro_means_by_metric[m]
        pro_row[f"{m}_mean"] = mean
        pro_row[f"{m}_ci_lo"] = lo
        pro_row[f"{m}_ci_hi"] = hi
    table.append(pro_row)

    # ----- Save coupling_coefficient_table.csv -----
    fields = ["entity", "n_slates_passing"] + [f"{m}_{s}" for m in metrics for s in ("mean", "ci_lo", "ci_hi")]
    with open(os.path.join(OUT, "coupling_coefficient_table.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for r in table:
            w.writerow(r)
    print("Wrote coupling_coefficient_table.csv")

    # ----- Stage 5: math reconciliation -----
    v1_row = next(r for r in table if r["entity"] == "v1")
    pro_row_dict = next(r for r in table if r["entity"] == "PRO_AVG")
    # Approach A (dominance): p_match ~ p123^2; ratio = pros/v1
    pros_p123_sq = pro_row_dict["p123_dominance_sq_mean"]
    v1_p123_sq = v1_row["p123_dominance_sq_mean"]
    ratio_dominance = pros_p123_sq / v1_p123_sq if v1_p123_sq > 0 else float("inf")
    # Approach B (Herfindahl): proper sum_v p(v)^2
    pros_herf = pro_row_dict["herfindahl_joint_mean"]
    v1_herf = v1_row["herfindahl_joint_mean"]
    ratio_herf = pros_herf / v1_herf if v1_herf > 0 else float("inf")

    recon = {
        "v1_p123_top1_freq_mean": v1_row["j123_mean"],
        "pros_p123_top1_freq_mean": pro_row_dict["j123_mean"],
        "v1_dominance_p_match": v1_p123_sq,
        "pros_dominance_p_match": pros_p123_sq,
        "ratio_dominance_pros_over_v1": ratio_dominance,
        "v1_herfindahl_joint": v1_herf,
        "pros_herfindahl_joint": pros_herf,
        "ratio_herfindahl_pros_over_v1": ratio_herf,
        "observed_pairwise_corr_gap_prior_research": 76.0,
    }

    # ----- Stage 6: per-pro coupling vs outcome -----
    # outcomes are computed across ALL the pro's lineups in dump (not just filter-passing slates)
    outcome_rows = []
    for pro in PROS:
        all_lus = []
        for s in slates:
            for lu in s["pros"]:
                if lu["user"] == pro:
                    all_lus.append(lu)
        finishes = np.array([lu["finishPct"] for lu in all_lus if lu.get("finishPct") is not None], dtype=float)
        top1pct = float((finishes >= 0.99).mean()) if len(finishes) else float("nan")
        top10pct = float((finishes >= 0.90).mean()) if len(finishes) else float("nan")
        recs = instances.get(pro, [])
        coup123_mean = float(np.nanmean([r["coup123"] for r in recs])) if recs else float("nan")
        coup12_mean = float(np.nanmean([r["coup12"] for r in recs])) if recs else float("nan")
        coup13_mean = float(np.nanmean([r["coup13"] for r in recs])) if recs else float("nan")
        coup23_mean = float(np.nanmean([r["coup23"] for r in recs])) if recs else float("nan")
        outcome_rows.append({
            "pro": pro,
            "n_slates_passing": len(recs),
            "n_lineups_total": len(all_lus),
            "coup12_mean": coup12_mean,
            "coup13_mean": coup13_mean,
            "coup23_mean": coup23_mean,
            "coup123_mean": coup123_mean,
            "top1pct_rate": top1pct,
            "top10pct_rate": top10pct,
        })
    # Add v1 row for reference
    v1_lus = []
    for s in slates:
        v1_lus.extend(s["v1"])
    v1_finishes = np.array([lu["finishPct"] for lu in v1_lus if lu.get("finishPct") is not None], dtype=float)
    v1_recs = instances.get("v1", [])
    outcome_rows.append({
        "pro": "v1",
        "n_slates_passing": len(v1_recs),
        "n_lineups_total": len(v1_lus),
        "coup12_mean": float(np.nanmean([r["coup12"] for r in v1_recs])) if v1_recs else float("nan"),
        "coup13_mean": float(np.nanmean([r["coup13"] for r in v1_recs])) if v1_recs else float("nan"),
        "coup23_mean": float(np.nanmean([r["coup23"] for r in v1_recs])) if v1_recs else float("nan"),
        "coup123_mean": float(np.nanmean([r["coup123"] for r in v1_recs])) if v1_recs else float("nan"),
        "top1pct_rate": float((v1_finishes >= 0.99).mean()) if len(v1_finishes) else float("nan"),
        "top10pct_rate": float((v1_finishes >= 0.90).mean()) if len(v1_finishes) else float("nan"),
    })

    fields = ["pro", "n_slates_passing", "n_lineups_total",
              "coup12_mean", "coup13_mean", "coup23_mean", "coup123_mean",
              "top1pct_rate", "top10pct_rate"]
    with open(os.path.join(OUT, "per_pro_coupling_variation.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for r in outcome_rows:
            w.writerow(r)
    print("Wrote per_pro_coupling_variation.csv")

    # Spearman rho between coup123 and top1pct, across 8 pros
    pro_outcomes = [r for r in outcome_rows if r["pro"] != "v1"]
    coup_arr = np.array([r["coup123_mean"] for r in pro_outcomes])
    top1_arr = np.array([r["top1pct_rate"] for r in pro_outcomes])
    # Spearman = pearson on ranks
    def rank(a):
        order = np.argsort(a)
        ranks = np.empty_like(order, dtype=float)
        ranks[order] = np.arange(len(a))
        return ranks
    if not np.any(np.isnan(coup_arr)) and not np.any(np.isnan(top1_arr)) and len(coup_arr) >= 3:
        ra, rb = rank(coup_arr), rank(top1_arr)
        if ra.std() > 0 and rb.std() > 0:
            rho = float(np.corrcoef(ra, rb)[0, 1])
        else:
            rho = float("nan")
    else:
        rho = float("nan")

    # ----- Save reconciliation md -----
    md = []
    md.append("# Stage 5 — Mathematical Reconciliation with 76x Pairwise-Correlation Finding\n")
    md.append("**Predicted ratio of within-portfolio pairwise lineup-similarity probability:**")
    md.append("```")
    md.append("Approach A (dominance approx, p_match ~= p_top1_joint^2):")
    md.append(f"  V1     joint-top1 freq = {recon['v1_p123_top1_freq_mean']:.4f}")
    md.append(f"  Pros   joint-top1 freq = {recon['pros_p123_top1_freq_mean']:.4f}")
    md.append(f"  V1     p_match (top1 sq) = {recon['v1_dominance_p_match']:.6f}")
    md.append(f"  Pros   p_match (top1 sq) = {recon['pros_dominance_p_match']:.6f}")
    md.append(f"  Ratio (pros / V1)        = {recon['ratio_dominance_pros_over_v1']:.2f}x")
    md.append("")
    md.append("Approach B (Herfindahl over full joint distribution, p_match = sum_v p(v)^2):")
    md.append(f"  V1     Herfindahl_joint = {recon['v1_herfindahl_joint']:.6f}")
    md.append(f"  Pros   Herfindahl_joint = {recon['pros_herfindahl_joint']:.6f}")
    md.append(f"  Ratio (pros / V1)       = {recon['ratio_herfindahl_pros_over_v1']:.2f}x")
    md.append("```")
    md.append("")
    md.append(f"**Observed pairwise-corr gap from prior research:** 76x")
    md.append("")
    md.append("**Comparison:**")
    rd = recon['ratio_dominance_pros_over_v1']
    rh = recon['ratio_herfindahl_pros_over_v1']
    if 76 / 3 <= rd <= 76 * 3:
        cmt_d = "MATCHES (within ~3x)"
    elif rd >= 76 * 3:
        cmt_d = "OVERSHOOTS"
    else:
        cmt_d = "UNDERSHOOTS"
    if 76 / 3 <= rh <= 76 * 3:
        cmt_h = "MATCHES (within ~3x)"
    elif rh >= 76 * 3:
        cmt_h = "OVERSHOOTS"
    else:
        cmt_h = "UNDERSHOOTS"
    md.append(f"- Dominance ratio   = {rd:.1f}x vs observed 76x -> {cmt_d}")
    md.append(f"- Herfindahl ratio  = {rh:.1f}x vs observed 76x -> {cmt_h}")
    md.append("")
    md.append("Notes: ratios are computed on the entity's top-1 primaryTeam subset (joint-cell space "
              "restricted to lineups using the entity's modal stack team). The pairwise-correlation "
              "gap from prior research applies to the full portfolio; restricting to top-primary is "
              "conservative for V1 (which is more diverse) and conservative for pros (whose effective "
              "joint concentration is even higher in the modal team than across all teams). The "
              "directional comparison is the load-bearing inference.")
    md.append("")
    with open(os.path.join(OUT, "mathematical_reconciliation.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(md))
    print("Wrote mathematical_reconciliation.md")

    return {
        "table": table,
        "recon": recon,
        "outcome_rows": outcome_rows,
        "spearman_rho_coup123_vs_top1pct": rho,
        "n_instances": {e: len(v) for e, v in instances.items()},
    }


if __name__ == "__main__":
    res = main()
    print("\n=== STAGE 4 SUMMARY ===")
    for r in res["table"]:
        print(f"{r['entity']:>14}  n_slates={r['n_slates_passing']:>2}  "
              f"coup12={r['coup12_mean']:.2f} [{r['coup12_ci_lo']:.2f},{r['coup12_ci_hi']:.2f}]  "
              f"coup13={r['coup13_mean']:.2f} [{r['coup13_ci_lo']:.2f},{r['coup13_ci_hi']:.2f}]  "
              f"coup23={r['coup23_mean']:.2f} [{r['coup23_ci_lo']:.2f},{r['coup23_ci_hi']:.2f}]  "
              f"coup123={r['coup123_mean']:.2f} [{r['coup123_ci_lo']:.2f},{r['coup123_ci_hi']:.2f}]")
    print("\n=== STAGE 5 RECON ===")
    print(json.dumps(res["recon"], indent=2))
    print("\n=== STAGE 6 OUTCOMES ===")
    for r in res["outcome_rows"]:
        print(f"{r['pro']:>14}  coup123={r['coup123_mean']:.2f}  top1pct={r['top1pct_rate']*100:.2f}%  top10pct={r['top10pct_rate']*100:.2f}%")
    print(f"\nSpearman rho(coup123, top1pct) across 8 pros = {res['spearman_rho_coup123_vs_top1pct']:.3f}")
