"""Stage 3: Construction metrics per V1 portfolio per slate."""
import json, csv, statistics, itertools
from collections import Counter, defaultdict

DUMP = r"C:/Users/colin/dfs opto/theory_dfs_v2/v1_pros_lineup_dump.json"
OUT = r"C:/Users/colin/dfs opto/outcome_conditional_analysis/construction_metrics_per_slate.csv"

def jaccard(a, b):
    sa, sb = set(a), set(b)
    u = sa | sb
    if not u: return 0.0
    return len(sa & sb) / len(u)

def mean_pairwise_jaccard(lineups):
    """Mean pairwise Jaccard over hitter-pid sets."""
    if len(lineups) < 2:
        return 0.0
    hitter_sets = []
    for ln in lineups:
        pitcher_ids = set(ln.get("pitcherIds") or [])
        hitters = [pid for pid in ln.get("pids", []) if pid not in pitcher_ids]
        hitter_sets.append(hitters)
    n = len(hitter_sets)
    total = 0.0
    cnt = 0
    # For efficiency, sample if large; here n=150 -> ~11k pairs, fine.
    for i in range(n):
        for j in range(i+1, n):
            total += jaccard(hitter_sets[i], hitter_sets[j])
            cnt += 1
    return total / cnt if cnt else 0.0

def gini(values):
    """Gini coefficient of a list of nonneg values."""
    vs = sorted(v for v in values if v is not None)
    n = len(vs)
    if n == 0 or sum(vs) == 0:
        return 0.0
    cum = 0.0
    for i, v in enumerate(vs, 1):
        cum += i * v
    return (2 * cum) / (n * sum(vs)) - (n + 1) / n

def own_for_lineup(ln):
    """Use geoMeanOwnHit if present, else ownAvg."""
    v = ln.get("geoMeanOwnHit")
    if v is None or (isinstance(v, float) and (v != v)):  # NaN
        v = ln.get("ownAvg")
    return v

def safe_stats(values):
    vs = [v for v in values if v is not None]
    if not vs:
        return (None, None, None)
    m = statistics.mean(vs)
    sd = statistics.stdev(vs) if len(vs) > 1 else 0.0
    rng = max(vs) - min(vs)
    return (m, sd, rng)

def slate_pitcher_ranks(slate):
    """Rank pitchers by max projection observed across V1 + pros lineups (slate-wide)."""
    # Aggregate per pitcher: max projection of any lineup it appeared in (proxy for talent;
    # ace pitchers tend to anchor higher-proj lineups). Use ALL lineups (V1 + pros) for slate context.
    all_lineups = list(slate.get("v1") or []) + list(slate.get("pros") or [])
    # For each lineup, attribute the lineup projection to each of its pitchers
    pitcher_max = defaultdict(float)
    pitcher_count = Counter()
    pitcher_salary = {}
    for ln in all_lineups:
        proj = ln.get("projection") or 0
        pids = ln.get("pitcherIds") or []
        sals = ln.get("salaries") or []
        names = ln.get("pids") or []
        # Map pid -> salary
        sal_map = dict(zip(names, sals)) if len(names) == len(sals) else {}
        for pid in pids:
            if proj > pitcher_max[pid]:
                pitcher_max[pid] = proj
            pitcher_count[pid] += 1
            if pid in sal_map and pid not in pitcher_salary:
                pitcher_salary[pid] = sal_map[pid]
    # Rank by (max projection, salary) descending
    ranked = sorted(pitcher_max.keys(), key=lambda pid: (pitcher_max[pid], pitcher_salary.get(pid, 0)), reverse=True)
    rank_map = {pid: i+1 for i, pid in enumerate(ranked)}
    return rank_map

def archetype_for_lineup(ln, slate_ace_pitchers, own_median_slate):
    """Assign one of 5 archetypes per locked rules."""
    pitcher_ids = ln.get("pitcherIds") or []
    primary = ln.get("primarySize") or 0
    secondary = ln.get("secondarySize") or 0
    bb = ln.get("bringBack") or 0
    owns = ln.get("owns") or []
    pids = ln.get("pids") or []
    pitcher_set = set(pitcher_ids)
    # Hitter owns
    hitter_owns = [o for pid, o in zip(pids, owns) if pid not in pitcher_set]
    max_hitter_own = max(hitter_owns) if hitter_owns else 0
    mean_hitter_own = statistics.mean(hitter_owns) if hitter_owns else 0

    # Rule 1: pitcher-tournament — both pitchers are slate aces
    if all(pid in slate_ace_pitchers for pid in pitcher_ids) and len(pitcher_ids) >= 2:
        return "pitcher_tournament"
    # Rule 2: chalk-anchor-with-BB — primarySize>=5, BB>=1, any hitter own>=30
    if primary >= 5 and bb >= 1 and max_hitter_own >= 30:
        return "chalk_anchor_with_BB"
    # Rule 3: mid-tier-5-stack — primary==5, no hitter own>=30, mean hitter own < slate-median
    if primary == 5 and max_hitter_own < 30 and mean_hitter_own < own_median_slate:
        return "mid_tier_5_stack"
    # Rule 4: contrarian-3-3 split
    if primary == 3 and secondary == 3:
        return "contrarian_33_split"
    # Rule 5: residual
    return "salary_spread_balanced"

def compute_metrics(slate):
    v1 = slate["v1"]
    n = len(v1)

    # Stack-size dist
    pct_5stack = sum(1 for l in v1 if (l.get("primarySize") or 0) == 5) / n
    pct_4stack = sum(1 for l in v1 if (l.get("primarySize") or 0) == 4) / n
    pct_33split = sum(1 for l in v1 if (l.get("primarySize") or 0) == 3 and (l.get("secondarySize") or 0) == 3) / n
    pct_nostack = sum(1 for l in v1 if (l.get("primarySize") or 0) <= 2) / n

    # BB rate
    bb_rate = sum(1 for l in v1 if (l.get("bringBack") or 0) >= 1) / n
    bb_lineups = [l for l in v1 if (l.get("bringBack") or 0) >= 1]
    if bb_lineups:
        bb_size1_pct = sum(1 for l in bb_lineups if (l.get("bringBack") or 0) == 1) / len(bb_lineups)
        bb_size2plus_pct = sum(1 for l in bb_lineups if (l.get("bringBack") or 0) >= 2) / len(bb_lineups)
    else:
        bb_size1_pct = 0.0
        bb_size2plus_pct = 0.0

    # Salary
    sal = [l.get("salaryTotal") for l in v1]
    sal_mean, sal_std, sal_range = safe_stats(sal)
    # Own
    own = [own_for_lineup(l) for l in v1]
    own_mean, own_std, own_range = safe_stats(own)
    # Proj
    proj = [l.get("projection") for l in v1]
    proj_mean, proj_std, proj_range = safe_stats(proj)

    # Bands (slate-relative median, from V1 portfolio per locked spec)
    proj_vals = [p for p in proj if p is not None]
    own_vals = [o for o in own if o is not None]
    proj_med = statistics.median(proj_vals) if proj_vals else 0
    own_med = statistics.median(own_vals) if own_vals else 0
    bands = Counter()
    for l in v1:
        p = l.get("projection")
        o = own_for_lineup(l)
        if p is None or o is None:
            continue
        hp = p >= proj_med
        ho = o >= own_med
        if hp and ho: bands["HP_HO"] += 1
        elif hp and not ho: bands["HP_LO"] += 1
        elif (not hp) and ho: bands["LP_HO"] += 1
        else: bands["LP_LO"] += 1
    pct_HP_HO = bands["HP_HO"] / n
    pct_HP_LO = bands["HP_LO"] / n
    pct_LP_HO = bands["LP_HO"] / n
    pct_LP_LO = bands["LP_LO"] / n

    # Within-portfolio Jaccard
    mean_jac = mean_pairwise_jaccard(v1)

    # Pitcher archetype
    pitcher_rank = slate_pitcher_ranks(slate)
    ace_pids = {pid for pid, r in pitcher_rank.items() if r <= 3}
    mid_pids = {pid for pid, r in pitcher_rank.items() if 4 <= r <= 10}
    val_pids = {pid for pid, r in pitcher_rank.items() if r >= 11}
    total_p_slots = 0
    ace_slots = mid_slots = val_slots = 0
    for l in v1:
        for pid in (l.get("pitcherIds") or []):
            total_p_slots += 1
            if pid in ace_pids: ace_slots += 1
            elif pid in mid_pids: mid_slots += 1
            elif pid in val_pids: val_slots += 1
    pct_ace_p = ace_slots / total_p_slots if total_p_slots else 0
    pct_mid_p = mid_slots / total_p_slots if total_p_slots else 0
    pct_val_p = val_slots / total_p_slots if total_p_slots else 0

    # Construction archetype (lineup-level)
    arches = Counter()
    for l in v1:
        a = archetype_for_lineup(l, ace_pids, own_med)
        arches[a] += 1
    pct_pt = arches["pitcher_tournament"] / n
    pct_ca = arches["chalk_anchor_with_BB"] / n
    pct_m5 = arches["mid_tier_5_stack"] / n
    pct_33 = arches["contrarian_33_split"] / n
    pct_ssb = arches["salary_spread_balanced"] / n

    return {
        "slate": slate["slate"],
        "v1_n": n,
        # 1. Stack
        "pct_5stack": pct_5stack,
        "pct_4stack": pct_4stack,
        "pct_33split": pct_33split,
        "pct_nostack": pct_nostack,
        # 2-3. BB
        "bb_rate": bb_rate,
        "bb_size1_pct": bb_size1_pct,
        "bb_size2plus_pct": bb_size2plus_pct,
        # 4. Salary
        "salary_mean": sal_mean,
        "salary_std": sal_std,
        "salary_range": sal_range,
        # 5. Own
        "own_mean": own_mean,
        "own_std": own_std,
        "own_range": own_range,
        # 6. Proj
        "proj_mean": proj_mean,
        "proj_std": proj_std,
        "proj_range": proj_range,
        # 7. Bands
        "pct_HP_HO": pct_HP_HO,
        "pct_HP_LO": pct_HP_LO,
        "pct_LP_HO": pct_LP_HO,
        "pct_LP_LO": pct_LP_LO,
        # 8. Jaccard
        "mean_jaccard": mean_jac,
        # 9. Archetypes
        "pct_arch_pitcher_tournament": pct_pt,
        "pct_arch_chalk_anchor_BB": pct_ca,
        "pct_arch_mid_tier_5stack": pct_m5,
        "pct_arch_contrarian_33": pct_33,
        "pct_arch_salary_spread": pct_ssb,
        # 10. Pitcher archetype
        "pct_ace_pitcher": pct_ace_p,
        "pct_mid_pitcher": pct_mid_p,
        "pct_value_pitcher": pct_val_p,
    }

def main():
    slates = json.load(open(DUMP))
    rows = [compute_metrics(s) for s in slates]
    cols = list(rows[0].keys())
    with open(OUT, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for r in rows:
            w.writerow(r)
    print(f"Wrote {len(rows)} rows -> {OUT}")
    # Print summary
    print(f"\n{'slate':<18} {'5stk':>5} {'4stk':>5} {'33sp':>5} {'bb':>5} {'jac':>6} {'aceP':>6}")
    for r in rows:
        print(f"{r['slate']:<18} {r['pct_5stack']:>5.2f} {r['pct_4stack']:>5.2f} {r['pct_33split']:>5.2f} {r['bb_rate']:>5.2f} {r['mean_jaccard']:>6.3f} {r['pct_ace_pitcher']:>6.2f}")

if __name__ == "__main__":
    main()
