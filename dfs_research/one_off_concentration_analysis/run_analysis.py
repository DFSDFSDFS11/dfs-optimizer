"""
One-off Hitter Slot Concentration Analysis
Stage 2-7 of methodology in METHODOLOGY.md (locked).
Descriptive only. No system built.
"""
import json
import math
import csv
import random
import os
from collections import Counter, defaultdict

# ---------- CONFIG ----------
DUMP = r"C:/Users/colin/dfs opto/theory_dfs_v2/v1_pros_lineup_dump.json"
OUT_DIR = r"C:/Users/colin/dfs opto/one_off_concentration_analysis"
MIN_LINEUPS_PER_GROUP = 5
BOOTSTRAP_N = 10000
SEED = 42

# Within-stack metrics from analysis 3 (for Method A)
# Take 5-stack top1 share since pros 75-90% 5-stack
WITHIN_STACK_TOP1_V1 = 0.172
WITHIN_STACK_TOP1_PRO = 0.220

OBSERVED_FULL_LINEUP_RATIO = 76.0  # from analysis 1


# ---------- HELPERS ----------
def load_dump():
    with open(DUMP, "r", encoding="utf-8") as f:
        return json.load(f)


def slate_game_pairs(slate):
    """Build team -> opponent map from pitcher pairs."""
    games = {}
    for entity_key in ("v1", "pros"):
        for lu in slate.get(entity_key, []):
            for pt, opp in zip(lu["pitcherTeams"], lu["pitcherOpps"]):
                games[pt] = opp
                games[opp] = pt
    return games


def categorize_lineup(lu, opp_map):
    """
    Returns dict with:
      stack_set: tuple of pids (primary stack hitters)
      bring_back_team: str or None
      bring_back_set: tuple of pids
      pitcher_set: tuple of pids (sorted)
      one_off_set: tuple of pids (sorted)
      one_off_count: int
    """
    primary_team = lu["primaryTeam"]
    primary_size = lu["primarySize"]
    bring_back_flag = lu.get("bringBack", 0)

    pids = lu["pids"]
    teams = lu["teams"]
    pitcher_ids = set(lu["pitcherIds"])

    # Build hitters list (pid, team) - excluding pitchers
    hitters = [(pid, team) for pid, team in zip(pids, teams) if pid not in pitcher_ids]

    # Primary stack hitters
    stack_hitters = [pid for pid, team in hitters if team == primary_team]
    # Bring-back team is primary_team's opponent
    bring_back_team = opp_map.get(primary_team) if bring_back_flag else None
    if bring_back_team is not None:
        bring_back_hitters = [pid for pid, team in hitters if team == bring_back_team]
    else:
        bring_back_hitters = []

    stack_set = set(stack_hitters)
    bb_set = set(bring_back_hitters)
    one_off_hitters = [pid for pid, team in hitters if pid not in stack_set and pid not in bb_set]

    return {
        "primary_team": primary_team,
        "primary_size": primary_size,
        "stack_set": tuple(sorted(stack_hitters)),
        "bring_back_team": bring_back_team,
        "bring_back_set": tuple(sorted(bring_back_hitters)),
        "pitcher_set": tuple(sorted(pitcher_ids)),
        "one_off_set": tuple(sorted(one_off_hitters)),
        "one_off_count": len(one_off_hitters),
    }


def shannon_entropy(counts_iter):
    counts = list(counts_iter)
    total = sum(counts)
    if total == 0:
        return 0.0
    return -sum((c / total) * math.log(c / total) for c in counts if c > 0)


def group_metrics(lineups):
    """
    For a list of (lineup_dict, categorized_dict), produce concentration metrics on one_off_set.
    """
    n = len(lineups)
    one_off_sets = [c["one_off_set"] for _lu, c in lineups]
    counter = Counter(one_off_sets)
    counts = sorted(counter.values(), reverse=True)
    unique = len(counter)
    top1 = counts[0] / n
    top3 = sum(counts[:3]) / n
    ent = shannon_entropy(counts)
    return {
        "n_lineups": n,
        "unique_one_offs": unique,
        "top1_share": top1,
        "top3_share": top3,
        "entropy": ent,
        "one_off_counts_by_lineup": [c["one_off_count"] for _lu, c in lineups],
    }


def bootstrap_mean(values, n_resamples=BOOTSTRAP_N, seed=SEED):
    """Returns (mean, ci_low, ci_high)."""
    if not values:
        return (float("nan"), float("nan"), float("nan"))
    rng = random.Random(seed)
    means = []
    n = len(values)
    for _ in range(n_resamples):
        sample = [values[rng.randrange(n)] for _ in range(n)]
        means.append(sum(sample) / n)
    means.sort()
    return (
        sum(values) / len(values),
        means[int(0.025 * n_resamples)],
        means[int(0.975 * n_resamples)],
    )


# ---------- STAGE 2 + 3 ----------
def stage2_3_per_group(data):
    """
    Returns:
      per_entity_groups: {entity: [group_metric_dict, ...]}
      slot_count_dist:   {entity: Counter of one_off_count per lineup}
      per_entity_lineups: {entity: [(slate, lineup, categorized), ...]} (for Stage 5/6)
    """
    per_entity_groups = defaultdict(list)
    slot_count_dist = defaultdict(Counter)
    per_entity_lineups = defaultdict(list)

    for slate in data:
        slate_label = slate["slate"]
        opp_map = slate_game_pairs(slate)

        # Group lineups by entity
        by_entity = defaultdict(list)
        for lu in slate.get("v1", []):
            cat = categorize_lineup(lu, opp_map)
            by_entity["V1"].append((lu, cat))
            slot_count_dist["V1"][cat["one_off_count"]] += 1
            per_entity_lineups["V1"].append((slate_label, lu, cat))
        for lu in slate.get("pros", []):
            user = lu.get("user")
            if not user:
                continue
            cat = categorize_lineup(lu, opp_map)
            by_entity[user].append((lu, cat))
            slot_count_dist[user][cat["one_off_count"]] += 1
            per_entity_lineups[user].append((slate_label, lu, cat))

        # Per-entity, group by structured context
        for entity, ents in by_entity.items():
            ctx = defaultdict(list)
            for lu, cat in ents:
                key = (cat["primary_team"], cat["bring_back_team"], cat["pitcher_set"])
                ctx[key].append((lu, cat))
            for key, group_lineups in ctx.items():
                if len(group_lineups) < MIN_LINEUPS_PER_GROUP:
                    continue
                m = group_metrics(group_lineups)
                m["slate"] = slate_label
                m["entity"] = entity
                m["primary_team"] = key[0]
                m["bring_back_team"] = key[1]
                m["pitcher_set"] = list(key[2])
                per_entity_groups[entity].append(m)

    return per_entity_groups, slot_count_dist, per_entity_lineups


# ---------- STAGE 4 ----------
def stage4_aggregate(per_entity_groups):
    rows = []
    for entity, groups in per_entity_groups.items():
        if not groups:
            rows.append({
                "entity": entity, "n_qualifying_groups": 0,
                "mean_unique": None, "mean_top1": None, "mean_top3": None,
                "mean_entropy": None,
                "ci_top1": (None, None), "ci_unique": (None, None),
                "ci_entropy": (None, None),
            })
            continue
        unique_vals = [g["unique_one_offs"] for g in groups]
        top1_vals = [g["top1_share"] for g in groups]
        top3_vals = [g["top3_share"] for g in groups]
        ent_vals = [g["entropy"] for g in groups]

        mean_unique, ulo, uhi = bootstrap_mean(unique_vals)
        mean_top1, t1lo, t1hi = bootstrap_mean(top1_vals)
        mean_top3, t3lo, t3hi = bootstrap_mean(top3_vals)
        mean_ent, elo, ehi = bootstrap_mean(ent_vals)

        rows.append({
            "entity": entity,
            "n_qualifying_groups": len(groups),
            "mean_unique": mean_unique,
            "mean_top1": mean_top1,
            "mean_top3": mean_top3,
            "mean_entropy": mean_ent,
            "ci_top1": (t1lo, t1hi),
            "ci_unique": (ulo, uhi),
            "ci_entropy": (elo, ehi),
            "ci_top3": (t3lo, t3hi),
        })
    return rows


# ---------- STAGE 5 ----------
def method_a_prediction(v1_top1, pro_top1):
    ws_factor = (WITHIN_STACK_TOP1_PRO / WITHIN_STACK_TOP1_V1) ** 2
    oo_factor = (pro_top1 / v1_top1) ** 2
    return ws_factor * oo_factor, ws_factor, oo_factor


def method_b_prediction(per_entity_lineups):
    """
    For each slate compute Herfindahl on (stack_set, bring_back_set, pitcher_set, one_off_set).
    Per-pro Herfindahl computed individually (each pro has ~150 lineups, matching V1)
    so sample-size effects are matched. Pro Herfindahl = mean over pros in slate.
    Returns dict with per-slate ratios + mean ratio.
    Also returns pooled-pro version for completeness.
    """
    # Reorganize by slate, by entity
    by_slate = defaultdict(lambda: defaultdict(list))
    for entity, items in per_entity_lineups.items():
        for slate_label, lu, cat in items:
            key = (cat["stack_set"], cat["bring_back_set"], cat["pitcher_set"], cat["one_off_set"])
            by_slate[slate_label][entity].append(key)

    def herfindahl(keys):
        if not keys:
            return float("nan")
        c = Counter(keys)
        n = sum(c.values())
        return sum((v / n) ** 2 for v in c.values())

    rows_per_pro_avg = []  # Method B fair: average per-pro herfindahl
    rows_pooled = []        # Method B pooled (sensitive to N)
    ratios_per_pro_avg = []
    ratios_pooled = []
    for slate, ent_keys in sorted(by_slate.items()):
        v1_keys = ent_keys.get("V1", [])
        if not v1_keys:
            continue
        h_v1 = herfindahl(v1_keys)

        # Per-pro: compute each pro's herfindahl separately, then mean
        pro_h_list = []
        for ent, keys in ent_keys.items():
            if ent == "V1":
                continue
            if len(keys) >= 50:  # need enough lineups for stable herfindahl
                pro_h_list.append(herfindahl(keys))
        if not pro_h_list:
            continue
        h_pro_avg = sum(pro_h_list) / len(pro_h_list)
        ratio_per_pro = h_pro_avg / h_v1 if h_v1 > 0 else float("inf")
        ratios_per_pro_avg.append(ratio_per_pro)
        rows_per_pro_avg.append({"slate": slate, "h_v1": h_v1,
                                  "h_pro_per_pro_avg": h_pro_avg,
                                  "n_pros": len(pro_h_list),
                                  "ratio": ratio_per_pro,
                                  "v1_n": len(v1_keys)})

        # Pooled
        pro_keys_pooled = []
        for ent, keys in ent_keys.items():
            if ent == "V1":
                continue
            pro_keys_pooled.extend(keys)
        h_pro_pooled = herfindahl(pro_keys_pooled)
        ratio_pooled = h_pro_pooled / h_v1 if h_v1 > 0 else float("inf")
        ratios_pooled.append(ratio_pooled)
        rows_pooled.append({"slate": slate, "h_v1": h_v1,
                            "h_pro_pooled": h_pro_pooled,
                            "ratio": ratio_pooled,
                            "v1_n": len(v1_keys),
                            "pro_n": len(pro_keys_pooled)})

    def stats(rs):
        if not rs:
            return float("nan"), float("nan")
        m = sum(rs) / len(rs)
        gm = math.exp(sum(math.log(r) for r in rs) / len(rs))
        return m, gm

    mean_pp, gm_pp = stats(ratios_per_pro_avg)
    mean_pl, gm_pl = stats(ratios_pooled)
    return {
        "per_slate_per_pro_avg": rows_per_pro_avg,
        "per_slate_pooled": rows_pooled,
        "mean_ratio_per_pro_avg": mean_pp,
        "geo_mean_ratio_per_pro_avg": gm_pp,
        "mean_ratio_pooled": mean_pl,
        "geo_mean_ratio_pooled": gm_pl,
    }


# ---------- STAGE 6 ----------
def stage6_selection_patterns(per_entity_groups, per_entity_lineups, slate_data):
    """
    For each entity, find top-1 one-off combo per qualifying group and pull metadata.
    """
    # Build per-slate pid -> {projection, ownership, salary, position, team}
    pid_meta = {}
    for slate in slate_data:
        slate_label = slate["slate"]
        # Pull from any lineup since per-pid info is consistent
        for lu in slate.get("v1", []) + slate.get("pros", []):
            for i, pid in enumerate(lu["pids"]):
                if (slate_label, pid) in pid_meta:
                    continue
                pid_meta[(slate_label, pid)] = {
                    "name": lu["names"][i],
                    "team": lu["teams"][i],
                    "position": lu["positions"][i],
                    "salary": lu["salaries"][i],
                    "ownership": lu["owns"][i],
                    # projection per-pid not stored; can't recover without proj file
                }

    summary = {}
    for entity, groups in per_entity_groups.items():
        records = []
        for g in groups:
            slate_label = g["slate"]
            primary = g["primary_team"]
            # Find the most-frequent one-off set for this group
            # Re-derive by going back to per_entity_lineups filtered
            ctx_lineups = [
                (lu, cat) for sl, lu, cat in per_entity_lineups[entity]
                if sl == slate_label and cat["primary_team"] == primary
                and cat["bring_back_team"] == g["bring_back_team"]
                and cat["pitcher_set"] == tuple(g["pitcher_set"])
            ]
            counter = Counter(cat["one_off_set"] for _lu, cat in ctx_lineups)
            if not counter:
                continue
            top_set, top_count = counter.most_common(1)[0]
            # Metadata for one-offs
            for pid in top_set:
                meta = pid_meta.get((slate_label, pid))
                if meta:
                    # Game environment vs primary
                    same_game_as_primary = False  # need game pairs
                    records.append({
                        "entity": entity, "slate": slate_label, "primary": primary,
                        "bring_back": g["bring_back_team"],
                        "pid": pid, "name": meta["name"], "team": meta["team"],
                        "position": meta["position"], "salary": meta["salary"],
                        "ownership": meta["ownership"], "top_count": top_count,
                        "group_n": g["n_lineups"],
                    })
        summary[entity] = records
    return summary


# ---------- STAGE 7 ----------
def stage7_per_pro(per_entity_groups, slate_data):
    """
    Per-pro aggregate concentration + outcome metrics (top-1%, top-0.1%).
    """
    # Outcome metrics from finishPct (lower is better; finishPct = rank/totalEntries)
    outcomes = defaultdict(lambda: {"n_lineups": 0, "top1pct": 0, "top01pct": 0})
    for slate in slate_data:
        for lu in slate.get("pros", []):
            user = lu.get("user")
            if not user:
                continue
            outcomes[user]["n_lineups"] += 1
            fp = lu.get("finishPct")
            if fp is None:
                continue
            if fp <= 0.01:
                outcomes[user]["top1pct"] += 1
            if fp <= 0.001:
                outcomes[user]["top01pct"] += 1
        for lu in slate.get("v1", []):
            outcomes["V1"]["n_lineups"] += 1
            fp = lu.get("finishPct")
            if fp is None:
                continue
            if fp <= 0.01:
                outcomes["V1"]["top1pct"] += 1
            if fp <= 0.001:
                outcomes["V1"]["top01pct"] += 1

    rows = []
    for entity, groups in per_entity_groups.items():
        if not groups:
            continue
        top1_vals = [g["top1_share"] for g in groups]
        ent_vals = [g["entropy"] for g in groups]
        mean_top1 = sum(top1_vals) / len(top1_vals)
        mean_ent = sum(ent_vals) / len(ent_vals)
        out = outcomes[entity]
        rows.append({
            "entity": entity,
            "n_qualifying_groups": len(groups),
            "mean_top1": mean_top1,
            "mean_entropy": mean_ent,
            "n_lineups": out["n_lineups"],
            "top1pct_count": out["top1pct"],
            "top1pct_rate": out["top1pct"] / out["n_lineups"] if out["n_lineups"] else 0,
            "top01pct_count": out["top01pct"],
            "top01pct_rate": out["top01pct"] / out["n_lineups"] if out["n_lineups"] else 0,
        })
    return rows


def spearman(x, y):
    """Spearman rank correlation (small n)."""
    if len(x) != len(y) or len(x) < 2:
        return float("nan")
    def rank(arr):
        sorted_idx = sorted(range(len(arr)), key=lambda i: arr[i])
        ranks = [0.0] * len(arr)
        i = 0
        while i < len(arr):
            j = i
            while j + 1 < len(arr) and arr[sorted_idx[j+1]] == arr[sorted_idx[i]]:
                j += 1
            avg_rank = (i + j) / 2.0 + 1
            for k in range(i, j+1):
                ranks[sorted_idx[k]] = avg_rank
            i = j + 1
        return ranks
    rx, ry = rank(x), rank(y)
    n = len(x)
    mean_rx = sum(rx) / n
    mean_ry = sum(ry) / n
    num = sum((rx[i]-mean_rx)*(ry[i]-mean_ry) for i in range(n))
    den_x = math.sqrt(sum((rx[i]-mean_rx)**2 for i in range(n)))
    den_y = math.sqrt(sum((ry[i]-mean_ry)**2 for i in range(n)))
    if den_x == 0 or den_y == 0:
        return float("nan")
    return num / (den_x * den_y)


# ---------- MAIN ----------
def main():
    print("Loading dump...")
    data = load_dump()
    print(f"Loaded {len(data)} slates")

    print("\n=== STAGE 2 + 3: per-group metrics ===")
    per_entity_groups, slot_dist, per_entity_lineups = stage2_3_per_group(data)
    for entity, groups in sorted(per_entity_groups.items()):
        print(f"  {entity}: {len(groups)} qualifying groups")
    print("\nOne-off slot count distribution per entity:")
    for entity in sorted(slot_dist.keys()):
        c = slot_dist[entity]
        total = sum(c.values())
        dist_str = ", ".join(f"{k}:{v} ({v/total:.1%})" for k, v in sorted(c.items()))
        print(f"  {entity}: {dist_str}")

    # Save per_group_metrics
    out_pg = []
    for entity, groups in per_entity_groups.items():
        for g in groups:
            row = {k: v for k, v in g.items() if k != "one_off_counts_by_lineup"}
            row["one_off_count_dist"] = dict(Counter(g["one_off_counts_by_lineup"]))
            out_pg.append(row)
    with open(os.path.join(OUT_DIR, "per_group_metrics.json"), "w") as f:
        json.dump(out_pg, f, indent=2, default=str)

    print("\n=== STAGE 4: per-entity aggregation w/ bootstrap CIs ===")
    rows = stage4_aggregate(per_entity_groups)
    rows.sort(key=lambda r: (r["entity"] != "V1", r["entity"]))

    # Save CSV
    with open(os.path.join(OUT_DIR, "per_entity_concentration_metrics.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow([
            "entity", "n_qualifying_groups",
            "mean_unique_one_offs", "ci_unique_low", "ci_unique_high",
            "mean_top1_share", "ci_top1_low", "ci_top1_high",
            "mean_top3_share", "ci_top3_low", "ci_top3_high",
            "mean_entropy", "ci_entropy_low", "ci_entropy_high",
        ])
        for r in rows:
            w.writerow([
                r["entity"], r["n_qualifying_groups"],
                r["mean_unique"], r["ci_unique"][0], r["ci_unique"][1],
                r["mean_top1"], r["ci_top1"][0], r["ci_top1"][1],
                r["mean_top3"], r["ci_top3"][0], r["ci_top3"][1],
                r["mean_entropy"], r["ci_entropy"][0], r["ci_entropy"][1],
            ])

    # Print table
    print(f"\n{'Entity':<18} {'#grp':>5} {'unique':>8} {'top1':>8} {'top3':>8} {'ent':>7}")
    for r in rows:
        if r["mean_top1"] is None:
            print(f"{r['entity']:<18} {r['n_qualifying_groups']:>5}  (no qualifying groups)")
            continue
        ci = r["ci_top1"]
        print(f"{r['entity']:<18} {r['n_qualifying_groups']:>5} {r['mean_unique']:>8.2f} "
              f"{r['mean_top1']:>8.3f} [{ci[0]:.3f},{ci[1]:.3f}] "
              f"{r['mean_top3']:>8.3f} {r['mean_entropy']:>7.3f}")

    # Pro avg
    pro_rows = [r for r in rows if r["entity"] not in ("V1",) and r["mean_top1"] is not None]
    if pro_rows:
        # Use unweighted mean across pros
        pro_avg_top1 = sum(r["mean_top1"] for r in pro_rows) / len(pro_rows)
        pro_avg_unique = sum(r["mean_unique"] for r in pro_rows) / len(pro_rows)
        pro_avg_ent = sum(r["mean_entropy"] for r in pro_rows) / len(pro_rows)
        pro_avg_top3 = sum(r["mean_top3"] for r in pro_rows) / len(pro_rows)
        print(f"\n{'PRO_AVG':<18} {'':>5} {pro_avg_unique:>8.2f} {pro_avg_top1:>8.3f} "
              f"{pro_avg_top3:>8.3f} {pro_avg_ent:>7.3f}")

    v1_row = next((r for r in rows if r["entity"] == "V1"), None)
    v1_top1 = v1_row["mean_top1"] if v1_row and v1_row["mean_top1"] is not None else None

    print("\n=== STAGE 5: math reconciliation ===")
    if v1_top1 is not None and pro_rows:
        ratio_a, ws_factor, oo_factor = method_a_prediction(v1_top1, pro_avg_top1)
        print(f"Method A: within_stack factor = {ws_factor:.3f}, one_off factor = {oo_factor:.3f}, "
              f"product = {ratio_a:.3f}")
    else:
        ratio_a, ws_factor, oo_factor = float("nan"), float("nan"), float("nan")
        print("Method A: insufficient data")

    method_b = method_b_prediction(per_entity_lineups)
    print(f"Method B (per-pro avg, fair sample-size): n_slates={len(method_b['per_slate_per_pro_avg'])}")
    print(f"  arithmetic mean ratio = {method_b['mean_ratio_per_pro_avg']:.3f}")
    print(f"  geometric mean ratio  = {method_b['geo_mean_ratio_per_pro_avg']:.3f}")
    print(f"Method B (pooled, biased toward V1 by N): n_slates={len(method_b['per_slate_pooled'])}")
    print(f"  arithmetic mean ratio = {method_b['mean_ratio_pooled']:.3f}")
    print(f"  geometric mean ratio  = {method_b['geo_mean_ratio_pooled']:.3f}")
    print(f"  per-slate sample (first 5):")
    for r in method_b["per_slate_per_pro_avg"][:5]:
        print(f"    {r['slate']}: h_v1={r['h_v1']:.4f} "
              f"h_pro_avg={r['h_pro_per_pro_avg']:.4f} ratio={r['ratio']:.2f}")

    # Stage 6 conditional
    if v1_top1 is not None and pro_rows:
        if pro_avg_top1 / v1_top1 >= 1.5:
            print("\n=== STAGE 6: selection patterns (hypothesis met threshold for top1 ratio) ===")
            sel = stage6_selection_patterns(per_entity_groups, per_entity_lineups, data)
            with open(os.path.join(OUT_DIR, "selection_patterns_raw.json"), "w") as f:
                json.dump(sel, f, indent=2, default=str)
            # Aggregate stats
            for entity in sorted(sel.keys()):
                recs = sel[entity]
                if not recs:
                    continue
                mean_own = sum(r["ownership"] for r in recs) / len(recs)
                mean_sal = sum(r["salary"] for r in recs) / len(recs)
                pos_dist = Counter(r["position"].split("/")[0] for r in recs)
                print(f"  {entity}: n={len(recs)} "
                      f"mean_own={mean_own:.2f} mean_sal={mean_sal:.0f} "
                      f"pos={dict(pos_dist)}")
        else:
            print(f"\n=== STAGE 6: SKIPPED (top1 ratio {pro_avg_top1/v1_top1:.2f}× < 1.5×) ===")

    # Stage 7
    print("\n=== STAGE 7: per-pro variation + outcome ===")
    pro_rows7 = stage7_per_pro(per_entity_groups, data)
    pro_only = [r for r in pro_rows7 if r["entity"] != "V1"]
    pro_only.sort(key=lambda r: -r["mean_top1"])

    with open(os.path.join(OUT_DIR, "per_pro_variation.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["entity", "n_qualifying_groups", "mean_top1", "mean_entropy",
                    "n_lineups", "top1pct_count", "top1pct_rate",
                    "top01pct_count", "top01pct_rate"])
        for r in pro_rows7:
            w.writerow([r["entity"], r["n_qualifying_groups"], r["mean_top1"],
                        r["mean_entropy"], r["n_lineups"],
                        r["top1pct_count"], r["top1pct_rate"],
                        r["top01pct_count"], r["top01pct_rate"]])

    print(f"\n{'Pro':<18} {'top1':>7} {'ent':>6} {'top1%':>7} {'top0.1%':>9}")
    for r in pro_only:
        print(f"{r['entity']:<18} {r['mean_top1']:>7.3f} {r['mean_entropy']:>6.3f} "
              f"{r['top1pct_rate']:>7.4f} {r['top01pct_rate']:>9.5f}")
    if v1_row:
        v1_o = next((r for r in pro_rows7 if r["entity"] == "V1"), None)
        if v1_o:
            print(f"{'V1':<18} {v1_o['mean_top1']:>7.3f} {v1_o['mean_entropy']:>6.3f} "
                  f"{v1_o['top1pct_rate']:>7.4f} {v1_o['top01pct_rate']:>9.5f}")

    if len(pro_only) >= 2:
        sp_t1 = spearman([r["mean_top1"] for r in pro_only], [r["top1pct_rate"] for r in pro_only])
        sp_t01 = spearman([r["mean_top1"] for r in pro_only], [r["top01pct_rate"] for r in pro_only])
        print(f"\nSpearman(concentration top1, outcome top1%) = {sp_t1:.3f} (n={len(pro_only)})")
        print(f"Spearman(concentration top1, outcome top0.1%) = {sp_t01:.3f} (n={len(pro_only)})")

    # Save reconciliation
    return {
        "v1_top1": v1_top1,
        "pro_avg_top1": pro_avg_top1 if pro_rows else None,
        "ratio_top1": (pro_avg_top1 / v1_top1) if (v1_top1 and pro_rows) else None,
        "method_a": {"ratio": ratio_a, "ws_factor": ws_factor, "oo_factor": oo_factor},
        "method_b": method_b,
        "stage4_rows": rows,
        "pro_avg_metrics": {
            "top1": pro_avg_top1 if pro_rows else None,
            "unique": pro_avg_unique if pro_rows else None,
            "entropy": pro_avg_ent if pro_rows else None,
            "top3": pro_avg_top3 if pro_rows else None,
        },
        "per_pro_outcome": pro_only,
        "v1_outcome": next((r for r in pro_rows7 if r["entity"] == "V1"), None),
        "spearman_top1_top1pct": sp_t1 if len(pro_only) >= 2 else None,
        "spearman_top1_top01pct": sp_t01 if len(pro_only) >= 2 else None,
        "slot_dist": {k: dict(v) for k, v in slot_dist.items()},
    }


if __name__ == "__main__":
    result = main()
    with open(os.path.join(OUT_DIR, "_run_summary.json"), "w") as f:
        json.dump(result, f, indent=2, default=str)
    print("\nDone.")
