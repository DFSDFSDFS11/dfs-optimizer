"""Stage 4: Mann-Whitney U comparisons across outcome categories.

Runs the comparison TWICE:
  - Primary: locked top-0.1% classification (per methodology lock)
  - Sensitivity: top-1% classification (transparent supplementary; the locked top-0.1%
    classification yielded 3/1/20 imbalance which makes the U-test power-starved).
"""
import csv, math, statistics, random
from collections import defaultdict

CLASS_CSV = r"C:/Users/colin/dfs opto/outcome_conditional_analysis/per_slate_classification.csv"
METRICS_CSV = r"C:/Users/colin/dfs opto/outcome_conditional_analysis/construction_metrics_per_slate.csv"
OUT_PRIMARY = r"C:/Users/colin/dfs opto/outcome_conditional_analysis/outcome_comparison_table.csv"
OUT_SENSITIVITY = r"C:/Users/colin/dfs opto/outcome_conditional_analysis/outcome_comparison_table_top1.csv"

# Pre-specified metrics (29 tests per locked methodology)
METRIC_COLS = [
    "pct_5stack","pct_4stack","pct_33split","pct_nostack",
    "bb_rate",
    "bb_size1_pct","bb_size2plus_pct",
    "salary_mean","salary_std","salary_range",
    "own_mean","own_std","own_range",
    "proj_mean","proj_std","proj_range",
    "pct_HP_HO","pct_HP_LO","pct_LP_HO","pct_LP_LO",
    "mean_jaccard",
    "pct_arch_pitcher_tournament","pct_arch_chalk_anchor_BB",
    "pct_arch_mid_tier_5stack","pct_arch_contrarian_33","pct_arch_salary_spread",
    "pct_ace_pitcher","pct_mid_pitcher","pct_value_pitcher",
]
N_TESTS = len(METRIC_COLS)
BONFERRONI_STRICT = 0.05 / N_TESTS  # 0.001724
BONFERRONI_BRIEF = 0.003

# ---------- Mann-Whitney U (two-sided, with tie correction, normal approx) ----------
def rankdata_avg(values):
    """Average-rank assignment for ties."""
    sorted_vals = sorted(enumerate(values), key=lambda x: x[1])
    ranks = [0.0] * len(values)
    i = 0
    while i < len(sorted_vals):
        j = i
        while j+1 < len(sorted_vals) and sorted_vals[j+1][1] == sorted_vals[i][1]:
            j += 1
        avg_rank = (i + j) / 2.0 + 1  # 1-indexed average
        for k in range(i, j+1):
            ranks[sorted_vals[k][0]] = avg_rank
        i = j + 1
    return ranks

def mannwhitney_u(a, b):
    """Returns (U_a, p_value, n_a, n_b). Two-sided, normal approx with tie correction."""
    n_a, n_b = len(a), len(b)
    if n_a == 0 or n_b == 0:
        return (None, None, n_a, n_b)
    combined = list(a) + list(b)
    ranks = rankdata_avg(combined)
    R_a = sum(ranks[:n_a])
    U_a = R_a - n_a*(n_a+1)/2
    U_b = n_a*n_b - U_a
    U = min(U_a, U_b)
    mean_U = n_a * n_b / 2
    # Tie correction
    counts = defaultdict(int)
    for v in combined:
        counts[v] += 1
    N = n_a + n_b
    tie_term = sum(t**3 - t for t in counts.values() if t > 1)
    var_U = (n_a * n_b / 12) * ((N + 1) - tie_term / (N * (N - 1))) if N > 1 else 0
    if var_U <= 0:
        return (U_a, 1.0, n_a, n_b)
    z = (U - mean_U + 0.5) / math.sqrt(var_U)  # continuity correction toward mean
    if U > mean_U:
        z = (U - mean_U - 0.5) / math.sqrt(var_U)
    # two-sided p
    # use erfc
    p = math.erfc(abs(z) / math.sqrt(2))
    return (U_a, p, n_a, n_b)

def rank_biserial(a, b, U_a):
    n_a, n_b = len(a), len(b)
    if n_a == 0 or n_b == 0:
        return None
    return 1 - 2 * U_a / (n_a * n_b) * (-1)  # see derivation below

# Cleaner: r_rb = 1 - 2*U_min / (n1 * n2), but signed by direction.
# We want positive r_rb when group A (Outperformed) has higher values than group B.
def rank_biserial_signed(a, b):
    """Signed rank-biserial: f - u, where f = fraction of pairs (a > b), u = fraction (a < b)."""
    n_a, n_b = len(a), len(b)
    if n_a == 0 or n_b == 0:
        return None
    greater = 0
    less = 0
    eq = 0
    for x in a:
        for y in b:
            if x > y: greater += 1
            elif x < y: less += 1
            else: eq += 1
    total = n_a * n_b
    if total == 0: return None
    return (greater - less) / total

def bootstrap_ci_rb(a, b, B=1000, seed=42):
    rng = random.Random(seed)
    if not a or not b:
        return (None, None)
    rs = []
    for _ in range(B):
        sa = [rng.choice(a) for _ in a]
        sb = [rng.choice(b) for _ in b]
        rs.append(rank_biserial_signed(sa, sb))
    rs.sort()
    return (rs[int(0.025*B)], rs[int(0.975*B)-1])

# ---------- Main analysis ----------
def load_classification():
    rows = list(csv.DictReader(open(CLASS_CSV)))
    return rows

def load_metrics():
    rows = list(csv.DictReader(open(METRICS_CSV)))
    return rows

def run_comparison(class_field, out_path, label):
    cls_rows = load_classification()
    met_rows = load_metrics()
    cls_map = {r["slate"]: r[class_field] for r in cls_rows}

    groups = defaultdict(list)  # cls -> list of metric dicts
    for m in met_rows:
        c = cls_map.get(m["slate"], "Matched")
        groups[c].append(m)

    n_out = len(groups["Outperformed"])
    n_mat = len(groups["Matched"])
    n_und = len(groups["Underperformed"])

    print(f"\n=== {label} ===")
    print(f"Outperformed: {n_out}   Matched: {n_mat}   Underperformed: {n_und}")
    print(f"Bonferroni strict threshold: p<{BONFERRONI_STRICT:.5f}   Brief threshold: p<{BONFERRONI_BRIEF}")

    out_rows = []
    for metric in METRIC_COLS:
        a = [float(r[metric]) for r in groups["Outperformed"] if r[metric] not in ("", None)]
        b = [float(r[metric]) for r in groups["Underperformed"] if r[metric] not in ("", None)]
        m = [float(r[metric]) for r in groups["Matched"] if r[metric] not in ("", None)]
        mean_a = statistics.mean(a) if a else None
        mean_b = statistics.mean(b) if b else None
        mean_m = statistics.mean(m) if m else None

        # Skip degenerate (no variance combined)
        combined = a + b
        if not combined or (max(combined) == min(combined)):
            U_a = None; p = None; r_rb = None; ci_low=None; ci_high=None
        else:
            U_a, p, _, _ = mannwhitney_u(a, b)
            r_rb = rank_biserial_signed(a, b)
            ci_low, ci_high = bootstrap_ci_rb(a, b, B=1000)

        sig_strict = (p is not None and p < BONFERRONI_STRICT)
        sig_brief = (p is not None and p < BONFERRONI_BRIEF)

        out_rows.append({
            "metric": metric,
            "n_outperformed": n_out,
            "n_matched": n_mat,
            "n_underperformed": n_und,
            "mean_outperformed": round(mean_a, 6) if mean_a is not None else "",
            "mean_matched": round(mean_m, 6) if mean_m is not None else "",
            "mean_underperformed": round(mean_b, 6) if mean_b is not None else "",
            "U_statistic": round(U_a, 3) if U_a is not None else "",
            "p_value": round(p, 5) if p is not None else "",
            "effect_size_r_rb": round(r_rb, 4) if r_rb is not None else "",
            "ci_low": round(ci_low, 4) if ci_low is not None else "",
            "ci_high": round(ci_high, 4) if ci_high is not None else "",
            "bonferroni_significant_strict": sig_strict,
            "suggestive_p003": sig_brief,
        })

    cols = list(out_rows[0].keys())
    with open(out_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for r in out_rows:
            w.writerow(r)

    # Print sorted by p-value
    print(f"\nResults sorted by p-value (smallest first):")
    sortable = sorted(out_rows, key=lambda r: r["p_value"] if isinstance(r["p_value"], float) else 9.9)
    print(f"{'metric':<32} {'mean_O':>10} {'mean_U':>10} {'p':>8} {'r_rb':>7} {'95% CI':>20} {'sig':>6}")
    for r in sortable:
        ci = f"[{r['ci_low']},{r['ci_high']}]" if r['ci_low'] != "" else ""
        sig = "***" if r["bonferroni_significant_strict"] else ("**" if r["suggestive_p003"] else "")
        print(f"{r['metric']:<32} {str(r['mean_outperformed']):>10} {str(r['mean_underperformed']):>10} {str(r['p_value']):>8} {str(r['effect_size_r_rb']):>7} {ci:>20} {sig:>6}")
    return out_rows

def main():
    print("STAGE 4: Mann-Whitney U comparison")
    primary = run_comparison("classification", OUT_PRIMARY, "PRIMARY (top-0.1% classification, locked)")
    sensitivity = run_comparison("classification_top1", OUT_SENSITIVITY, "SENSITIVITY (top-1% classification, supplementary)")

if __name__ == "__main__":
    main()
