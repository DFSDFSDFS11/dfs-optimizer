"""Stage 5: Slate-level features and their relation to V1 outcomes."""
import json, csv, math, statistics, random
from collections import Counter, defaultdict

DUMP = r"C:/Users/colin/dfs opto/theory_dfs_v2/v1_pros_lineup_dump.json"
CLASS_CSV = r"C:/Users/colin/dfs opto/outcome_conditional_analysis/per_slate_classification.csv"
OUT = r"C:/Users/colin/dfs opto/outcome_conditional_analysis/slate_features.csv"
OUT_STATS = r"C:/Users/colin/dfs opto/outcome_conditional_analysis/slate_features_stats.csv"

# ---------- helpers (re-imported from stage4) ----------
def rankdata_avg(values):
    sorted_vals = sorted(enumerate(values), key=lambda x: x[1])
    ranks = [0.0] * len(values)
    i = 0
    while i < len(sorted_vals):
        j = i
        while j+1 < len(sorted_vals) and sorted_vals[j+1][1] == sorted_vals[i][1]:
            j += 1
        avg_rank = (i + j) / 2.0 + 1
        for k in range(i, j+1):
            ranks[sorted_vals[k][0]] = avg_rank
        i = j + 1
    return ranks

def mannwhitney_u(a, b):
    n_a, n_b = len(a), len(b)
    if n_a == 0 or n_b == 0:
        return (None, None, n_a, n_b)
    combined = list(a) + list(b)
    ranks = rankdata_avg(combined)
    R_a = sum(ranks[:n_a])
    U_a = R_a - n_a*(n_a+1)/2
    U = min(U_a, n_a*n_b - U_a)
    mean_U = n_a * n_b / 2
    counts = defaultdict(int)
    for v in combined:
        counts[v] += 1
    N = n_a + n_b
    tie_term = sum(t**3 - t for t in counts.values() if t > 1)
    var_U = (n_a * n_b / 12) * ((N + 1) - tie_term / (N * (N - 1))) if N > 1 else 0
    if var_U <= 0:
        return (U_a, 1.0, n_a, n_b)
    if U > mean_U:
        z = (U - mean_U - 0.5) / math.sqrt(var_U)
    else:
        z = (U - mean_U + 0.5) / math.sqrt(var_U)
    p = math.erfc(abs(z) / math.sqrt(2))
    return (U_a, p, n_a, n_b)

def rank_biserial_signed(a, b):
    if not a or not b: return None
    g = l = 0
    for x in a:
        for y in b:
            if x > y: g += 1
            elif x < y: l += 1
    return (g - l) / (len(a) * len(b))

def spearman(x, y):
    if len(x) < 2: return (None, None)
    rx = rankdata_avg(x); ry = rankdata_avg(y)
    n = len(x)
    mx = statistics.mean(rx); my = statistics.mean(ry)
    num = sum((rx[i]-mx)*(ry[i]-my) for i in range(n))
    dx = math.sqrt(sum((rx[i]-mx)**2 for i in range(n)))
    dy = math.sqrt(sum((ry[i]-my)**2 for i in range(n)))
    if dx == 0 or dy == 0: return (0.0, 1.0)
    rho = num / (dx*dy)
    # t-test approx
    if abs(rho) >= 1: return (rho, 0.0)
    t = rho * math.sqrt((n-2)/(1-rho*rho))
    # 2-sided p via t-dist approx using normal for n>=10 (rough)
    # Better: use Student t survival. Simple approx with normal:
    p = math.erfc(abs(t)/math.sqrt(2)) if n > 10 else None
    return (rho, p)

def gini(values):
    vs = sorted(v for v in values if v is not None)
    n = len(vs)
    if n == 0 or sum(vs) == 0: return 0.0
    cum = 0.0
    for i, v in enumerate(vs, 1):
        cum += i * v
    return (2 * cum) / (n * sum(vs)) - (n + 1) / n

# ---------- slate features ----------
def compute_slate_features(slate):
    v1 = slate["v1"]
    pros = slate["pros"]
    all_lineups = list(v1) + list(pros)

    # 1. Slate variance index — proxy: mean lineup-projection coefficient of variation across V1+pros
    projs = [l.get("projection") for l in all_lineups if l.get("projection") is not None]
    if projs and statistics.mean(projs) > 0:
        sv_index = statistics.stdev(projs) / statistics.mean(projs) if len(projs) > 1 else 0.0
    else:
        sv_index = 0.0

    # 2. Scoring environment — mean V1 lineup projection × 9 (per locked spec; loose proxy)
    v1_projs = [l.get("projection") for l in v1 if l.get("projection") is not None]
    scoring_env = (statistics.mean(v1_projs) * 9 / 10) if v1_projs else 0.0
    # Actually per locked spec: "mean projection × 9" — mean lineup proj ~ 100; treat that as raw.
    # But that's a 10-player lineup not 9. Let's just use mean lineup projection as proxy for total slate scoring environment.
    scoring_env = statistics.mean(v1_projs) if v1_projs else 0.0

    # 3. Anchor ownership — max single-player ownership in V1
    max_own = 0
    for l in v1:
        for o in (l.get("owns") or []):
            if o is not None and o > max_own:
                max_own = o
    # 4. Player pool size — unique pids in V1
    pids = set()
    for l in v1:
        for pid in (l.get("pids") or []):
            pids.add(pid)
    pool_size = len(pids)
    # 5. Projection concentration Gini — usage counts across pids in V1
    counts = Counter()
    for l in v1:
        for pid in (l.get("pids") or []):
            counts[pid] += 1
    gini_v = gini(list(counts.values()))
    return {
        "slate": slate["slate"],
        "slate_variance_index": sv_index,
        "scoring_environment": scoring_env,
        "anchor_ownership": max_own,
        "player_pool_size": pool_size,
        "projection_concentration_gini": gini_v,
    }

def main():
    slates = json.load(open(DUMP))
    feats = [compute_slate_features(s) for s in slates]

    cols = list(feats[0].keys())
    with open(OUT, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for r in feats:
            w.writerow(r)
    print(f"Wrote {OUT}")

    # Read classifications
    cls_rows = list(csv.DictReader(open(CLASS_CSV)))
    cls_map_top01 = {r["slate"]: r["classification"] for r in cls_rows}
    cls_map_top1 = {r["slate"]: r["classification_top1"] for r in cls_rows}
    ratio_top01 = {}
    ratio_top1 = {}
    for r in cls_rows:
        v = r["ratio_top01"]
        ratio_top01[r["slate"]] = (1e6 if v == "inf" else (float(v) if v not in ("", None) else None))
        v = r["ratio_top1"]
        ratio_top1[r["slate"]] = (1e6 if v == "inf" else (float(v) if v not in ("", None) else None))

    feature_cols = ["slate_variance_index","scoring_environment","anchor_ownership","player_pool_size","projection_concentration_gini"]
    BONFERRONI_FEATURE = 0.05 / len(feature_cols)  # 0.01

    out_rows = []
    print("\nSlate-feature comparison:\n")
    for label, cls_map in [("top01_primary", cls_map_top01), ("top1_sensitivity", cls_map_top1)]:
        # Group features
        groups = defaultdict(list)
        for f in feats:
            cls = cls_map.get(f["slate"], "Matched")
            groups[cls].append(f)
        n_o = len(groups["Outperformed"])
        n_u = len(groups["Underperformed"])
        print(f"--- Classification: {label}  (Out={n_o}, Under={n_u}) ---")
        print(f"{'feature':<32} {'mean_O':>14} {'mean_U':>14} {'p':>8} {'r_rb':>7} {'rho_top01':>10} {'rho_top1':>10}")
        ratio_field = ratio_top01 if label == "top01_primary" else ratio_top1
        # Spearman with ratio (continuous)
        for fc in feature_cols:
            a = [float(r[fc]) for r in groups["Outperformed"]]
            b = [float(r[fc]) for r in groups["Underperformed"]]
            mean_a = statistics.mean(a) if a else None
            mean_b = statistics.mean(b) if b else None
            U_a, p, _, _ = mannwhitney_u(a, b) if a and b else (None, None, 0, 0)
            r_rb = rank_biserial_signed(a, b) if a and b else None

            # Spearman across all 24 slates between feature and ratio_top01 / ratio_top1
            x_all = []; y01 = []; y1 = []
            for f in feats:
                if ratio_top01.get(f["slate"]) is not None and ratio_top1.get(f["slate"]) is not None:
                    x_all.append(float(f[fc]))
                    y01.append(min(ratio_top01[f["slate"]], 1e3))  # cap inf
                    y1.append(min(ratio_top1[f["slate"]], 1e3))
            rho01, p01 = spearman(x_all, y01)
            rho1, p1 = spearman(x_all, y1)

            sig = (p is not None and p < BONFERRONI_FEATURE)
            print(f"{fc:<32} {mean_a if mean_a is None else round(mean_a,3):>14} {mean_b if mean_b is None else round(mean_b,3):>14} {('' if p is None else round(p,4)):>8} {('' if r_rb is None else round(r_rb,3)):>7} {('' if rho01 is None else round(rho01,3)):>10} {('' if rho1 is None else round(rho1,3)):>10} {'***' if sig else ''}")
            if label == "top01_primary":
                out_rows.append({
                    "feature": fc,
                    "mean_outperformed_top01": round(mean_a,4) if mean_a is not None else "",
                    "mean_underperformed_top01": round(mean_b,4) if mean_b is not None else "",
                    "U_p_top01": round(p,4) if p is not None else "",
                    "r_rb_top01": round(r_rb,4) if r_rb is not None else "",
                    "spearman_rho_vs_ratio_top01": round(rho01,4) if rho01 is not None else "",
                    "spearman_p_vs_ratio_top01": round(p01,4) if p01 is not None else "",
                    "spearman_rho_vs_ratio_top1": round(rho1,4) if rho1 is not None else "",
                    "spearman_p_vs_ratio_top1": round(p1,4) if p1 is not None else "",
                    "bonferroni_feature_threshold": BONFERRONI_FEATURE,
                    "bonferroni_significant": sig,
                })
            elif label == "top1_sensitivity":
                # update existing row with sensitivity
                for r in out_rows:
                    if r["feature"] == fc:
                        r["mean_outperformed_top1"] = round(mean_a,4) if mean_a is not None else ""
                        r["mean_underperformed_top1"] = round(mean_b,4) if mean_b is not None else ""
                        r["U_p_top1"] = round(p,4) if p is not None else ""
                        r["r_rb_top1"] = round(r_rb,4) if r_rb is not None else ""
                        r["bonferroni_significant_top1"] = sig
                        break
        print()

    # Reorder cols
    final_cols = ["feature",
                  "mean_outperformed_top01","mean_underperformed_top01","U_p_top01","r_rb_top01",
                  "mean_outperformed_top1","mean_underperformed_top1","U_p_top1","r_rb_top1",
                  "spearman_rho_vs_ratio_top01","spearman_p_vs_ratio_top01",
                  "spearman_rho_vs_ratio_top1","spearman_p_vs_ratio_top1",
                  "bonferroni_feature_threshold","bonferroni_significant","bonferroni_significant_top1"]
    with open(OUT_STATS, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=final_cols)
        w.writeheader()
        for r in out_rows:
            w.writerow({k: r.get(k, "") for k in final_cols})
    print(f"Wrote {OUT_STATS}")

if __name__ == "__main__":
    main()
