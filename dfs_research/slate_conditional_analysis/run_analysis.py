"""Slate-conditional construction adaptation analysis.

Stages 2-6, executed sequentially per locked methodology.md.
Outputs to C:/Users/colin/dfs opto/slate_conditional_analysis/.
"""
from __future__ import annotations

import json
import os
import sys
import math
from collections import Counter, defaultdict
from itertools import combinations

import numpy as np
import pandas as pd

# scipy for hierarchical clustering
from scipy.cluster.hierarchy import linkage, fcluster

BASE = r"C:/Users/colin/dfs opto"
OUT = r"C:/Users/colin/dfs opto/slate_conditional_analysis"
DUMP = r"C:/Users/colin/dfs opto/theory_dfs_v2/v1_pros_lineup_dump.json"

PROS = ["zroth", "zroth2", "nerdytenor", "shipmymoney", "shaidyadvice",
        "needlunchmoney", "bgreseth", "youdacao", "b_heals152"]


def slate_to_proj_path(slate: str) -> str:
    """Map slate string to projections.csv path."""
    candidates = []
    if slate == "4-6-26":
        candidates.append("4-6-26_projections.csv")
    candidates.append(f"{slate}projections.csv")
    # variants
    for suffix in ("-early", "-main", "-night", "-late"):
        if slate.endswith(suffix):
            base = slate[: -len(suffix)]
            candidates.append(f"{base}projections{suffix.lstrip('-')}.csv")
    for c in candidates:
        p = os.path.join(BASE, c)
        if os.path.exists(p):
            return p
    raise FileNotFoundError(f"No projections file for slate {slate}; tried {candidates}")


def load_dump():
    with open(DUMP) as f:
        return json.load(f)


# ----------------------------- Stage 2: features -----------------------------

def gini(arr):
    a = np.asarray(arr, dtype=float)
    a = a[a >= 0]
    if a.size == 0:
        return float("nan")
    a = np.sort(a)
    n = a.size
    cum = np.cumsum(a)
    if cum[-1] == 0:
        return 0.0
    return float((n + 1 - 2 * np.sum(cum) / cum[-1]) / n)


def compute_slate_features(slate: str) -> dict:
    path = slate_to_proj_path(slate)
    df = pd.read_csv(path)

    # active filter: dk_50_percentile > 0; status non-OUT
    if "Status" in df.columns:
        df = df[df["Status"].astype(str).str.upper() != "OUT"]
    if "dk_50_percentile" in df.columns:
        df = df[pd.to_numeric(df["dk_50_percentile"], errors="coerce").fillna(0) > 0]

    # variance index
    p25 = pd.to_numeric(df["dk_25_percentile"], errors="coerce")
    p50 = pd.to_numeric(df["dk_50_percentile"], errors="coerce")
    p85 = pd.to_numeric(df["dk_85_percentile"], errors="coerce")
    rel = (p85 - p25) / p50.replace(0, np.nan)
    variance_idx = float(np.nanmean(rel))

    # scoring env
    if "Saber Total" in df.columns and "Team" in df.columns:
        team_tot = df.groupby("Team")["Saber Total"].first()
        team_tot = pd.to_numeric(team_tot, errors="coerce")
        if team_tot.notna().sum() >= 2:
            scoring_env = float(team_tot.dropna().sum())
        else:
            scoring_env = float(p50.sum())
    else:
        scoring_env = float(p50.sum())

    # anchor concentration
    own = pd.to_numeric(df["My Own"], errors="coerce").dropna().sort_values(ascending=False).values
    if len(own) >= 2 and own[1] > 0:
        anchor_conc = float(own[0] / own[1])
    else:
        anchor_conc = float("nan")

    pool_size = int(len(df))

    g = gini(p50.dropna().values)

    sal = pd.to_numeric(df["Salary"], errors="coerce")
    valid = sal.notna() & p50.notna()
    if valid.sum() >= 3:
        salary_eff = float(np.corrcoef(sal[valid], p50[valid])[0, 1])
    else:
        salary_eff = float("nan")

    return {
        "slate": slate,
        "variance_idx": variance_idx,
        "scoring_env": scoring_env,
        "anchor_conc": anchor_conc,
        "pool_size": pool_size,
        "gini": g,
        "salary_eff": salary_eff,
    }


# ----------------------------- Stage 3: cluster -----------------------------

def cluster_slates(features_df: pd.DataFrame):
    cols = ["variance_idx", "scoring_env", "anchor_conc", "pool_size", "gini", "salary_eff"]
    X = features_df[cols].copy()
    # z-score
    Z = (X - X.mean()) / X.std(ddof=0)
    # In case any NaNs (shouldn't be)
    Z = Z.fillna(0)
    L = linkage(Z.values, method="ward", metric="euclidean")
    res = features_df[["slate"]].copy()
    for k in (3, 4, 5):
        res[f"k{k}_cluster"] = fcluster(L, t=k, criterion="maxclust")
    # centroid labels at k=4
    centroids = {}
    for k in (3, 4, 5):
        c_lab = {}
        for cid in sorted(res[f"k{k}_cluster"].unique()):
            mask = res[f"k{k}_cluster"] == cid
            cz = Z[mask.values].mean()  # z-scored centroid
            # heuristic label: top abs feature(s)
            order = cz.abs().sort_values(ascending=False)
            top1, top2 = order.index[0], order.index[1]
            def sgn(v): return "high" if v > 0 else "low"
            label = f"{sgn(cz[top1])}-{top1}/{sgn(cz[top2])}-{top2}"
            c_lab[int(cid)] = {"label": label, "centroid_z": {k2: float(v) for k2, v in cz.to_dict().items()}, "n_slates": int(mask.sum())}
        centroids[k] = c_lab
    return res, Z, L, centroids


# ----------------------------- Stage 4: construction metrics -----------------------------

def lineup_band(lu, slate_med_proj, slate_med_own):
    hp = lu["projection"] >= slate_med_proj
    ho = lu["ownAvg"] >= slate_med_own
    if hp and ho:
        return "HP_HO"
    if hp and not ho:
        return "HP_LO"
    if not hp and ho:
        return "LP_HO"
    return "LP_LO"


def stack_bucket(lu):
    p = lu.get("primarySize", 0) or 0
    s = lu.get("secondarySize", 0) or 0
    if p >= 5:
        return "5stack"
    if p == 4:
        return "4stack"
    if p == 3 and s == 3:
        return "3_3stack"
    return "other_or_none"


def mean_pairwise_jaccard(lineups, max_lus=150):
    sets = [set(lu["pids"]) for lu in lineups[:max_lus]]
    if len(sets) < 2:
        return float("nan")
    total = 0.0
    n = 0
    for a, b in combinations(sets, 2):
        u = len(a | b)
        if u == 0:
            continue
        total += len(a & b) / u
        n += 1
    return total / n if n else float("nan")


def construction_metrics_for_slate(slate_dump, entity: str):
    """Return dict of construction metrics for entity on this slate."""
    if entity == "V1":
        lus = slate_dump["v1"]
    elif entity == "pro_avg":
        # not computed here; computed per pro then averaged
        return None
    else:
        # specific pro
        lus = [p for p in slate_dump["pros"] if p["user"] == entity]

    if not lus:
        return None

    # stack distribution
    buckets = Counter(stack_bucket(lu) for lu in lus)
    n = len(lus)

    # bring-back
    bb_rate = sum(1 for lu in lus if (lu.get("bringBack") or 0) >= 1) / n

    # bands -- need slate medians from pooled v1+pros
    pool = slate_dump["v1"] + slate_dump["pros"]
    proj_arr = np.array([lu["projection"] for lu in pool])
    own_arr = np.array([lu["ownAvg"] for lu in pool])
    med_proj = float(np.median(proj_arr))
    med_own = float(np.median(own_arr))
    band_counts = Counter(lineup_band(lu, med_proj, med_own) for lu in lus)

    jacc = mean_pairwise_jaccard(lus)

    sal_total_mean = float(np.mean([lu["salaryTotal"] for lu in lus]))
    sal_std_mean = float(np.mean([lu["salaryStd"] for lu in lus]))

    own_mean = float(np.mean([lu["ownAvg"] for lu in lus]))
    own_std = float(np.std([lu["ownAvg"] for lu in lus]))

    return {
        "pct_5stack": buckets.get("5stack", 0) / n,
        "pct_4stack": buckets.get("4stack", 0) / n,
        "pct_3_3stack": buckets.get("3_3stack", 0) / n,
        "pct_other_stack": buckets.get("other_or_none", 0) / n,
        "bring_back_rate": bb_rate,
        "pct_HP_HO": band_counts.get("HP_HO", 0) / n,
        "pct_HP_LO": band_counts.get("HP_LO", 0) / n,
        "pct_LP_HO": band_counts.get("LP_HO", 0) / n,
        "pct_LP_LO": band_counts.get("LP_LO", 0) / n,
        "mean_pairwise_jaccard": jacc,
        "salary_total_mean": sal_total_mean,
        "salary_std_mean": sal_std_mean,
        "own_mean": own_mean,
        "own_std": own_std,
        "n_lineups": n,
    }


METRIC_KEYS = [
    "pct_5stack", "pct_4stack", "pct_3_3stack", "pct_other_stack",
    "bring_back_rate",
    "pct_HP_HO", "pct_HP_LO", "pct_LP_HO", "pct_LP_LO",
    "mean_pairwise_jaccard",
    "salary_total_mean", "salary_std_mean",
    "own_mean", "own_std",
]


# ----------------------------- main -----------------------------

def main():
    os.makedirs(OUT, exist_ok=True)

    print("[Stage 2] Computing slate features...")
    dump = load_dump()
    slate_rows = []
    for s in dump:
        feat = compute_slate_features(s["slate"])
        feat["numTeams"] = s["numTeams"]
        feat["totalEntries"] = s["totalEntries"]
        slate_rows.append(feat)
    feat_df = pd.DataFrame(slate_rows)
    feat_df.to_csv(os.path.join(OUT, "slate_features.csv"), index=False)
    print(feat_df)

    print("\n[Stage 3] Clustering slates...")
    assignments, Z, L, centroids = cluster_slates(feat_df)
    assignments.to_csv(os.path.join(OUT, "archetype_assignments.csv"), index=False)
    # save centroids
    with open(os.path.join(OUT, "archetype_centroids.json"), "w") as f:
        json.dump(centroids, f, indent=2, default=str)
    print(assignments)
    print("\nk=4 centroid labels:")
    for cid, info in centroids[4].items():
        print(f"  cluster {cid} (n={info['n_slates']}): {info['label']}")

    print("\n[Stage 4] Per-slate construction metrics by entity...")
    rows = []  # one row per (slate, entity)
    for s in dump:
        slate = s["slate"]
        # V1
        v1m = construction_metrics_for_slate(s, "V1")
        if v1m:
            v1m.update({"slate": slate, "entity": "V1"})
            rows.append(v1m)
        # each pro present
        users_present = {p["user"] for p in s["pros"]}
        for u in PROS:
            if u not in users_present:
                continue
            pm = construction_metrics_for_slate(s, u)
            if pm:
                pm.update({"slate": slate, "entity": u})
                rows.append(pm)
    per_slate_df = pd.DataFrame(rows)
    per_slate_df.to_csv(os.path.join(OUT, "per_slate_entity_metrics.csv"), index=False)

    # merge archetype assignments
    per_slate_df = per_slate_df.merge(assignments, on="slate", how="left")

    # Aggregate per (entity, k4_cluster): mean of metrics across that entity's slates in cluster
    print("\n[Stage 4b] Aggregating to per-archetype construction metrics...")
    archetype_rows = []
    entities_all = ["V1"] + PROS
    for entity in entities_all:
        sub = per_slate_df[per_slate_df["entity"] == entity]
        if sub.empty:
            continue
        for k4 in sorted(per_slate_df["k4_cluster"].unique()):
            ssub = sub[sub["k4_cluster"] == k4]
            if ssub.empty:
                continue
            row = {"entity": entity, "k4_cluster": int(k4), "n_slates": len(ssub)}
            for m in METRIC_KEYS:
                row[m] = float(ssub[m].mean())
            archetype_rows.append(row)

    arch_df = pd.DataFrame(archetype_rows)

    # pro_avg row per cluster: mean over pro entities (per-cluster, equal weight per pro that has data there)
    pro_only = arch_df[arch_df["entity"].isin(PROS)]
    pro_avg_rows = []
    for k4 in sorted(arch_df["k4_cluster"].unique()):
        sub = pro_only[pro_only["k4_cluster"] == k4]
        if sub.empty:
            continue
        row = {"entity": "pro_avg", "k4_cluster": int(k4), "n_slates": int(sub["n_slates"].sum())}
        for m in METRIC_KEYS:
            row[m] = float(sub[m].mean())
        pro_avg_rows.append(row)
    arch_df = pd.concat([arch_df, pd.DataFrame(pro_avg_rows)], ignore_index=True)
    arch_df.to_csv(os.path.join(OUT, "per_archetype_construction_metrics.csv"), index=False)

    print("\n[Stage 5] Adaptation amplitude...")
    amp_rows = []
    for entity in entities_all + ["pro_avg"]:
        sub = arch_df[arch_df["entity"] == entity]
        if sub.empty:
            continue
        row = {"entity": entity}
        for m in METRIC_KEYS:
            row[f"amp_{m}"] = float(sub[m].std(ddof=0))
        amp_rows.append(row)
    amp_df = pd.DataFrame(amp_rows)
    amp_df.to_csv(os.path.join(OUT, "adaptation_amplitude_comparison.csv"), index=False)
    print(amp_df)

    print("\n[Stage 6] Per-archetype gap (V1 vs pro_avg) and V1 outcomes...")
    v1_arch = arch_df[arch_df["entity"] == "V1"].set_index("k4_cluster")
    pa_arch = arch_df[arch_df["entity"] == "pro_avg"].set_index("k4_cluster")
    gap_rows = []
    for k4 in sorted(arch_df["k4_cluster"].unique()):
        if k4 not in v1_arch.index or k4 not in pa_arch.index:
            continue
        row = {"k4_cluster": int(k4), "n_slates_v1": int(v1_arch.loc[k4, "n_slates"])}
        for m in METRIC_KEYS:
            row[f"gap_{m}"] = float(v1_arch.loc[k4, m] - pa_arch.loc[k4, m])
        gap_rows.append(row)
    gap_df = pd.DataFrame(gap_rows)
    gap_df.to_csv(os.path.join(OUT, "per_archetype_gap.csv"), index=False)

    # Aggregate "biggest divergence archetype" via mean abs z of gap across metrics
    metric_amps = amp_df[amp_df["entity"] == "pro_avg"].iloc[0]
    z_gaps = {}
    for k4 in gap_df["k4_cluster"]:
        zs = []
        for m in METRIC_KEYS:
            amp = metric_amps.get(f"amp_{m}", float("nan"))
            if amp and not math.isnan(amp) and amp > 0:
                g = gap_df[gap_df["k4_cluster"] == k4][f"gap_{m}"].iloc[0]
                zs.append(abs(g) / amp)
        z_gaps[int(k4)] = float(np.mean(zs)) if zs else float("nan")
    print("Per-archetype mean |gap_z| (V1 vs pro_avg):", z_gaps)
    with open(os.path.join(OUT, "per_archetype_gap_zscore_summary.json"), "w") as f:
        json.dump(z_gaps, f, indent=2)

    # V1 outcomes per archetype
    print("\nV1 outcome rates per archetype...")
    out_rows = []
    rng = np.random.default_rng(42)
    for k4 in sorted(assignments["k4_cluster"].unique()):
        slates_in = assignments[assignments["k4_cluster"] == k4]["slate"].tolist()
        # collect V1 lineup-level outcomes from dump
        v1_lus = []
        for s in dump:
            if s["slate"] in slates_in:
                v1_lus.extend(s["v1"])
        if not v1_lus:
            continue
        finish = np.array([lu["finishPct"] for lu in v1_lus if lu.get("finishPct") is not None], dtype=float)
        if finish.size == 0:
            continue
        top1 = float(np.mean(finish < 0.01))
        top01 = float(np.mean(finish < 0.001))
        mean_finish = float(np.mean(finish))

        # bootstrap CIs at slate level
        slate_to_v1 = {s["slate"]: [lu for lu in s["v1"] if lu.get("finishPct") is not None] for s in dump if s["slate"] in slates_in}
        slate_to_v1 = {k: v for k, v in slate_to_v1.items() if v}
        slates_arr = list(slate_to_v1.keys())
        boot_top1 = []
        boot_top01 = []
        for _ in range(2000):
            samp = rng.choice(slates_arr, size=len(slates_arr), replace=True)
            f = np.concatenate([np.array([lu["finishPct"] for lu in slate_to_v1[s]], dtype=float) for s in samp])
            boot_top1.append(np.mean(f < 0.01))
            boot_top01.append(np.mean(f < 0.001))
        ci_top1 = (float(np.percentile(boot_top1, 2.5)), float(np.percentile(boot_top1, 97.5)))
        ci_top01 = (float(np.percentile(boot_top01, 2.5)), float(np.percentile(boot_top01, 97.5)))

        out_rows.append({
            "k4_cluster": int(k4),
            "n_slates": len(slates_in),
            "n_v1_lineups": len(v1_lus),
            "v1_top1pct_rate": top1,
            "v1_top1pct_ci_lo": ci_top1[0],
            "v1_top1pct_ci_hi": ci_top1[1],
            "v1_top01pct_rate": top01,
            "v1_top01pct_ci_lo": ci_top01[0],
            "v1_top01pct_ci_hi": ci_top01[1],
            "v1_mean_finishPct": mean_finish,
            "slates": ";".join(slates_in),
        })

        # also pro_avg outcomes for comparison
    out_df = pd.DataFrame(out_rows)

    # add pro_avg outcomes
    pro_out_rows = []
    for k4 in sorted(assignments["k4_cluster"].unique()):
        slates_in = assignments[assignments["k4_cluster"] == k4]["slate"].tolist()
        pro_lus = []
        for s in dump:
            if s["slate"] in slates_in:
                pro_lus.extend(s["pros"])
        if not pro_lus:
            continue
        finish = np.array([lu["finishPct"] for lu in pro_lus if lu.get("finishPct") is not None], dtype=float)
        if finish.size == 0:
            continue
        pro_out_rows.append({
            "k4_cluster": int(k4),
            "pro_top1pct_rate": float(np.mean(finish < 0.01)),
            "pro_top01pct_rate": float(np.mean(finish < 0.001)),
            "pro_mean_finishPct": float(np.mean(finish)),
            "n_pro_lineups": len(pro_lus),
        })
    pro_out_df = pd.DataFrame(pro_out_rows)
    out_df = out_df.merge(pro_out_df, on="k4_cluster", how="left")
    out_df.to_csv(os.path.join(OUT, "per_archetype_outcomes.csv"), index=False)
    print(out_df)

    print("\nDone. All artifacts in", OUT)


if __name__ == "__main__":
    main()
