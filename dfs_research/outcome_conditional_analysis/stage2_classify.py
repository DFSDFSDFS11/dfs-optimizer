"""Stage 2: Outcome classification per slate."""
import json, csv
from collections import defaultdict

DUMP = r"C:/Users/colin/dfs opto/theory_dfs_v2/v1_pros_lineup_dump.json"
OUT = r"C:/Users/colin/dfs opto/outcome_conditional_analysis/per_slate_classification.csv"

def rate_above(lineups, threshold):
    if not lineups:
        return 0.0
    n = 0
    for l in lineups:
        fp = l.get("finishPct")
        if fp is None:
            continue
        if fp >= threshold:
            n += 1
    return n / len(lineups)

def classify_one(v1_rate, pro_rate):
    """Apply ratio-based classification rules."""
    if pro_rate > 0:
        r = v1_rate / pro_rate
        if r > 1.5: return "Outperformed", r
        if r < 0.5: return "Underperformed", r
        return "Matched", r
    # pro_rate == 0
    if v1_rate > 0:
        return "Outperformed", float("inf")
    return None, None  # both zero — caller decides

def classify(slates):
    rows = []
    for s in slates:
        slate_name = s["slate"]
        te = s["totalEntries"]
        v1 = s["v1"]
        pros = s["pros"]

        v1_top01 = rate_above(v1, 0.999)
        v1_top1 = rate_above(v1, 0.99)

        # Group pros by user
        by_user = defaultdict(list)
        for p in pros:
            by_user[p["user"]].append(p)
        pro_users = sorted(by_user.keys())

        pro_top01_rates = [rate_above(by_user[u], 0.999) for u in pro_users]
        pro_top1_rates = [rate_above(by_user[u], 0.99) for u in pro_users]

        pro_avg_top01 = sum(pro_top01_rates) / len(pro_top01_rates) if pro_top01_rates else 0
        pro_avg_top1 = sum(pro_top1_rates) / len(pro_top1_rates) if pro_top1_rates else 0

        # Primary classification: top-0.1% per locked methodology
        cls_primary, r01 = classify_one(v1_top01, pro_avg_top01)
        cls_top1, r1 = classify_one(v1_top1, pro_avg_top1)

        if cls_primary is None:
            # Both V1 and pros have 0 top-0.1% — fall through to top-1% per spec
            cls_primary = cls_top1 if cls_top1 is not None else "Matched"

        # Secondary (sensitivity) classification: top-1% as primary
        if cls_top1 is None:
            cls_top1 = "Matched"

        rows.append({
            "slate": slate_name,
            "totalEntries": te,
            "v1_n": len(v1),
            "pro_users_n": len(pro_users),
            "v1_top01_rate": round(v1_top01, 6),
            "pro_avg_top01_rate": round(pro_avg_top01, 6),
            "ratio_top01": "" if r01 is None else ("inf" if r01 == float("inf") else round(r01, 4)),
            "v1_top1_rate": round(v1_top1, 6),
            "pro_avg_top1_rate": round(pro_avg_top1, 6),
            "ratio_top1": "" if r1 is None else ("inf" if r1 == float("inf") else round(r1, 4)),
            "classification": cls_primary,
            "classification_top1": cls_top1,
        })
    return rows

def main():
    slates = json.load(open(DUMP))
    rows = classify(slates)
    # Save
    cols = list(rows[0].keys())
    with open(OUT, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for r in rows:
            w.writerow(r)
    # Summary
    for tag in ["classification", "classification_top1"]:
        cnt = defaultdict(int)
        for r in rows:
            cnt[r[tag]] += 1
        print(f"\n{tag} counts:")
        for k in ["Outperformed", "Matched", "Underperformed"]:
            print(f"  {k}: {cnt[k]}")
        print(f"  Total: {sum(cnt.values())}")
    # Print table
    print()
    print(f"{'slate':<18} {'v1_top01':>10} {'pro_top01':>10} {'r01':>8} {'v1_top1':>10} {'pro_top1':>10} {'r1':>8} {'pri':<14} {'sec_top1':<14}")
    for r in rows:
        print(f"{r['slate']:<18} {r['v1_top01_rate']:>10.6f} {r['pro_avg_top01_rate']:>10.6f} {str(r['ratio_top01']):>8} {r['v1_top1_rate']:>10.6f} {r['pro_avg_top1_rate']:>10.6f} {str(r['ratio_top1']):>8} {r['classification']:<14} {r['classification_top1']:<14}")

if __name__ == "__main__":
    main()
