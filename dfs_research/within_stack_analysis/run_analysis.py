"""
Within-stack hitter-set analysis (Stages 2-7).
Run AFTER methodology lock. One pass.
"""
import json
import os
import csv
import math
import random
from collections import Counter, defaultdict
from itertools import combinations

random.seed(42)  # Reproducibility for bootstrap.

DUMP = "C:/Users/colin/dfs opto/theory_dfs_v2/v1_pros_lineup_dump.json"
OUT = "C:/Users/colin/dfs opto/within_stack_analysis"
DFS_DIR = "C:/Users/colin/dfs opto"

PRO_USERS = {
    "zroth", "zroth2", "nerdytenor", "shipmymoney", "shaidyadvice",
    "needlunchmoney", "bgreseth", "youdacao", "b_heals152"
}


def slate_to_actuals_path(slate):
    """Map slate name in dump to actuals csv filename."""
    # 4-6-26: there's no '4-6-26actuals.csv' — let's check.
    # Files in dir:
    # 4-6-26: only '4-6-26_projections.csv' exists, no '4-6-26actuals.csv' visible. Will check existence.
    candidates = [
        f"{slate}actuals.csv",
        f"{slate}_actuals.csv",
        f"{slate.replace('-early','')}actualsearly.csv" if slate.endswith('-early') else None,
        f"{slate.replace('-main','')}actualsmain.csv" if slate.endswith('-main') else None,
        f"{slate.replace('-night','')}actualsnight.csv" if slate.endswith('-night') else None,
        f"{slate.replace('-late','')}actualslate.csv" if slate.endswith('-late') else None,
        f"dkactuals {slate}.csv",
    ]
    for c in candidates:
        if c is None:
            continue
        p = os.path.join(DFS_DIR, c)
        if os.path.exists(p):
            return p
    return None


def slate_to_projections_path(slate):
    candidates = [
        f"{slate}projections.csv",
        f"{slate}_projections.csv",
        f"{slate.replace('-early','')}projectionsearly.csv" if slate.endswith('-early') else None,
        f"{slate.replace('-main','')}projectionsmain.csv" if slate.endswith('-main') else None,
        f"{slate.replace('-night','')}projectionsnight.csv" if slate.endswith('-night') else None,
        f"{slate.replace('-late','')}projectionslate.csv" if slate.endswith('-late') else None,
    ]
    for c in candidates:
        if c is None:
            continue
        p = os.path.join(DFS_DIR, c)
        if os.path.exists(p):
            return p
    return None


def load_player_csv(path):
    """Return dict: pid -> {Name, Pos, Order, Team, Status, SS Proj, Adj Own, Actual, Salary}."""
    out = {}
    with open(path, encoding='utf-8-sig') as f:
        r = csv.DictReader(f)
        for row in r:
            pid = row.get('DFS ID') or row.get('﻿DFS ID')
            if not pid:
                continue
            out[pid] = row
    return out


def primary_set(ln):
    pt = ln['primaryTeam']
    pids = [pid for pid, t in zip(ln['pids'], ln['teams']) if t == pt and pid not in ln['pitcherIds']]
    return tuple(sorted(pids))


def shannon_entropy(counts):
    n = sum(counts)
    if n == 0:
        return 0.0
    return -sum((c / n) * math.log(c / n) for c in counts if c > 0)


def build_cells(dump):
    """For each (entity, slate, team, stackSize), collect list of primary-set tuples."""
    cells = defaultdict(list)  # (entity, slate, team, ssize) -> list of sets
    entity_lineup_counts = defaultdict(int)
    entity_stacksize_counts = defaultdict(Counter)  # entity -> Counter(ssize)

    for slate_obj in dump:
        slate = slate_obj['slate']

        # V1
        for ln in slate_obj.get('v1', []):
            pset = primary_set(ln)
            if len(pset) != ln['primarySize']:
                continue
            ssize = ln['primarySize']
            cells[('V1', slate, ln['primaryTeam'], ssize)].append(pset)
            entity_lineup_counts['V1'] += 1
            entity_stacksize_counts['V1'][ssize] += 1

        # Pros (group by user within slate)
        for ln in slate_obj.get('pros', []):
            user = ln['user']
            pset = primary_set(ln)
            if len(pset) != ln['primarySize']:
                continue
            ssize = ln['primarySize']
            cells[(user, slate, ln['primaryTeam'], ssize)].append(pset)
            entity_lineup_counts[user] += 1
            entity_stacksize_counts[user][ssize] += 1

    return cells, entity_lineup_counts, entity_stacksize_counts


def cell_metrics(sets_list):
    counts = Counter(sets_list)
    n = sum(counts.values())
    sorted_counts = sorted(counts.values(), reverse=True)
    top1 = sorted_counts[0] if sorted_counts else 0
    top3 = sum(sorted_counts[:3])
    return {
        'lineups_n': n,
        'unique_sets': len(counts),
        'top1_set_share': top1 / n if n else 0.0,
        'top3_set_share': top3 / n if n else 0.0,
        'entropy': shannon_entropy(sorted_counts),
        'top1_set': list(counts.most_common(1)[0][0]) if counts else [],
    }


def stage2_build(cells):
    """Compute metrics for every cell, but mark which pass the >= 5 filter."""
    out = {}
    for key, sets_list in cells.items():
        m = cell_metrics(sets_list)
        m['qualifies'] = m['lineups_n'] >= 5
        entity, slate, team, ssize = key
        out[f"{entity}|{slate}|{team}|{ssize}"] = {
            'entity': entity,
            'slate': slate,
            'team': team,
            'stackSize': ssize,
            **m,
        }
    return out


def stage3_aggregate(per_cell):
    """Aggregate cell metrics by entity + stackSize, filtered to qualifies==True."""
    agg = defaultdict(lambda: defaultdict(list))  # entity -> ssize -> list of dicts
    for cell in per_cell.values():
        if not cell['qualifies']:
            continue
        agg[cell['entity']][cell['stackSize']].append(cell)
    return agg


def mean(xs):
    return sum(xs) / len(xs) if xs else float('nan')


def fmt_row(entity, agg_e, total_lineups, ssize_mix):
    def stats_for(ssize):
        cells = agg_e.get(ssize, [])
        if not cells:
            return None
        return {
            'n_cells': len(cells),
            'mean_unique': mean([c['unique_sets'] for c in cells]),
            'mean_top1': mean([c['top1_set_share'] for c in cells]),
            'mean_top3': mean([c['top3_set_share'] for c in cells]),
            'mean_entropy': mean([c['entropy'] for c in cells]),
            'mean_lineups': mean([c['lineups_n'] for c in cells]),
        }

    s4 = stats_for(4)
    s5 = stats_for(5)
    return {
        'entity': entity,
        'total_lineups': total_lineups,
        'pct_4stack': ssize_mix.get(4, 0) / max(total_lineups, 1),
        'pct_5stack': ssize_mix.get(5, 0) / max(total_lineups, 1),
        '4stack': s4,
        '5stack': s5,
    }


def write_stage2_3_4(per_cell, agg, lineup_counts, ssize_counts):
    # Stage 2 dump
    with open(os.path.join(OUT, 'per_team_per_slate_comparisons.json'), 'w') as f:
        json.dump(per_cell, f, indent=1)

    # Stages 3-4 distribution comparison
    entities_order = ['V1'] + sorted([u for u in lineup_counts if u != 'V1'])
    rows = []
    for ent in entities_order:
        rows.append(fmt_row(ent, agg.get(ent, {}), lineup_counts[ent], ssize_counts[ent]))

    # CSV
    with open(os.path.join(OUT, 'distribution_comparison.csv'), 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow([
            'entity', 'total_lineups', 'pct_4stack', 'pct_5stack',
            '4s_n_cells', '4s_mean_unique', '4s_top1_share', '4s_top3_share', '4s_mean_entropy', '4s_mean_lineups',
            '5s_n_cells', '5s_mean_unique', '5s_top1_share', '5s_top3_share', '5s_mean_entropy', '5s_mean_lineups',
        ])
        for r in rows:
            s4 = r['4stack'] or {}
            s5 = r['5stack'] or {}
            w.writerow([
                r['entity'], r['total_lineups'],
                f"{r['pct_4stack']:.3f}", f"{r['pct_5stack']:.3f}",
                s4.get('n_cells', ''),
                f"{s4.get('mean_unique', float('nan')):.2f}" if s4 else '',
                f"{s4.get('mean_top1', float('nan')):.3f}" if s4 else '',
                f"{s4.get('mean_top3', float('nan')):.3f}" if s4 else '',
                f"{s4.get('mean_entropy', float('nan')):.3f}" if s4 else '',
                f"{s4.get('mean_lineups', float('nan')):.1f}" if s4 else '',
                s5.get('n_cells', ''),
                f"{s5.get('mean_unique', float('nan')):.2f}" if s5 else '',
                f"{s5.get('mean_top1', float('nan')):.3f}" if s5 else '',
                f"{s5.get('mean_top3', float('nan')):.3f}" if s5 else '',
                f"{s5.get('mean_entropy', float('nan')):.3f}" if s5 else '',
                f"{s5.get('mean_lineups', float('nan')):.1f}" if s5 else '',
            ])

        # Pro avg row
        pros_rows = [r for r in rows if r['entity'] != 'V1']
        def pro_mean(getter):
            vs = [getter(r) for r in pros_rows if getter(r) is not None and not (isinstance(getter(r), float) and math.isnan(getter(r)))]
            return mean(vs) if vs else float('nan')

        def field(r, ssize_key, k):
            s = r[ssize_key]
            if not s:
                return None
            return s.get(k)

        w.writerow([
            'PRO_AVG', '', '',
            f"{pro_mean(lambda r: r['pct_4stack']):.3f}",
            '',
            f"{pro_mean(lambda r: field(r, '4stack', 'mean_unique')):.2f}",
            f"{pro_mean(lambda r: field(r, '4stack', 'mean_top1')):.3f}",
            f"{pro_mean(lambda r: field(r, '4stack', 'mean_top3')):.3f}",
            f"{pro_mean(lambda r: field(r, '4stack', 'mean_entropy')):.3f}",
            f"{pro_mean(lambda r: field(r, '4stack', 'mean_lineups')):.1f}",
            '',
            f"{pro_mean(lambda r: field(r, '5stack', 'mean_unique')):.2f}",
            f"{pro_mean(lambda r: field(r, '5stack', 'mean_top1')):.3f}",
            f"{pro_mean(lambda r: field(r, '5stack', 'mean_top3')):.3f}",
            f"{pro_mean(lambda r: field(r, '5stack', 'mean_entropy')):.3f}",
            f"{pro_mean(lambda r: field(r, '5stack', 'mean_lineups')):.1f}",
        ])

    return rows


def stage5_patterns(per_cell, dump):
    """For each qualifying cell's top-1 set, check pattern matches.
    Returns: pattern frequency dict per entity, plus per-cell records.
    """
    # Pre-load projections for each slate
    slate_proj = {}
    for slate_obj in dump:
        slate = slate_obj['slate']
        path = slate_to_projections_path(slate)
        if path:
            slate_proj[slate] = load_player_csv(path)

    records = []
    for cell in per_cell.values():
        if not cell['qualifies']:
            continue
        slate = cell['slate']
        team = cell['team']
        ssize = cell['stackSize']
        proj = slate_proj.get(slate)
        if not proj:
            continue
        # Active hitters for team: position != P, status == Confirmed (or any), team match
        active = []
        for pid, row in proj.items():
            if row.get('Team') != team:
                continue
            if row.get('Pos') == 'P':
                continue
            # Use 'Confirmed' status when available
            status = row.get('Status', '')
            if status and status != 'Confirmed':
                continue
            try:
                proj_val = float(row.get('SS Proj') or 0)
            except ValueError:
                proj_val = 0.0
            try:
                own = float(row.get('Adj Own') or row.get('My Own') or 0)
            except ValueError:
                own = 0.0
            try:
                order = int(row.get('Order') or 99)
            except ValueError:
                order = 99
            active.append({
                'pid': pid,
                'proj': proj_val,
                'own': own,
                'order': order,
            })

        if len(active) < ssize:
            # Pool too small (perhaps not all confirmed): skip pattern check.
            continue

        top1 = set(cell['top1_set'])

        # Top-N by SS Proj
        by_proj = sorted(active, key=lambda p: -p['proj'])[:ssize]
        match_proj = set(p['pid'] for p in by_proj) == top1

        # Top-N by anti-ownership (lowest own)
        by_anti_own = sorted(active, key=lambda p: p['own'])[:ssize]
        match_anti_own = set(p['pid'] for p in by_anti_own) == top1

        # Top-N by leverage (proj / max(own,1))
        by_lev = sorted(active, key=lambda p: -(p['proj'] / max(p['own'], 1.0)))[:ssize]
        match_lev = set(p['pid'] for p in by_lev) == top1

        # Contiguous batting order: do top1's players have orders forming a run?
        ord_map = {p['pid']: p['order'] for p in active}
        top1_orders = sorted([ord_map.get(pid, 99) for pid in top1])
        # Contiguous if max-min == ssize-1 and all <= 8
        if all(o <= 8 for o in top1_orders) and (max(top1_orders) - min(top1_orders)) == ssize - 1 and len(set(top1_orders)) == ssize:
            match_contig = True
        else:
            match_contig = False

        match_other = not (match_proj or match_anti_own or match_lev or match_contig)

        records.append({
            'entity': cell['entity'],
            'slate': slate,
            'team': team,
            'stackSize': ssize,
            'top1_share': cell['top1_set_share'],
            'lineups_n': cell['lineups_n'],
            'match_top_proj': match_proj,
            'match_anti_own': match_anti_own,
            'match_leverage': match_lev,
            'match_contig_order': match_contig,
            'match_other': match_other,
        })

    return records


def stage6_outcome(per_cell, dump):
    """For each qualifying cell, compute actual fantasy points of the top-1 hitter set.
    Compare V1, each pro, random baseline. Bootstrap 95% CIs.

    NOTE: The per-slate '<slate>actuals.csv' is contest-results dump (lineup-level), not
    player-level actuals. Per-player Actual data lives in the projections csv ('Actual' column),
    which is filled with realized scores post-slate. We use projections csv as the actuals source.
    """
    # Player-level actuals come from the projections CSV (Actual column).
    slate_proj = {}
    for slate_obj in dump:
        slate = slate_obj['slate']
        path = slate_to_projections_path(slate)
        if path:
            slate_proj[slate] = load_player_csv(path)
    slate_act = slate_proj  # Same source.

    records_per_entity = defaultdict(list)  # entity -> list of (top1_actual, random_baseline_mean)
    skipped = 0

    for cell in per_cell.values():
        if not cell['qualifies']:
            continue
        slate = cell['slate']
        team = cell['team']
        ssize = cell['stackSize']
        actuals = slate_act.get(slate)
        proj = slate_proj.get(slate)
        if actuals is None or proj is None:
            skipped += 1
            continue

        # Score top-1 set using actuals
        top1 = cell['top1_set']
        score_terms = []
        for pid in top1:
            row = actuals.get(pid)
            if row is None:
                row = proj.get(pid)
            if row is None:
                score_terms.append(None)
                continue
            try:
                a = float(row.get('Actual') or 0)
            except ValueError:
                a = 0.0
            score_terms.append(a)
        if any(t is None for t in score_terms):
            skipped += 1
            continue
        top1_actual = sum(score_terms)

        # Random baseline: from team's confirmed active hitters in projections, random ssize-subsets
        # For consistency use projections csv (Status=Confirmed) — fall back to all non-P if none Confirmed.
        candidates = []
        for pid, row in proj.items():
            if row.get('Team') != team:
                continue
            if row.get('Pos') == 'P':
                continue
            status = row.get('Status', '')
            if status and status != 'Confirmed':
                continue
            arow = actuals.get(pid)
            if arow is None:
                continue
            try:
                a = float(arow.get('Actual') or 0)
            except ValueError:
                a = 0.0
            candidates.append((pid, a))

        if len(candidates) < ssize:
            skipped += 1
            continue

        # Random baseline: all C(N, ssize) combos averaged (cheap when N<=10)
        all_combos = list(combinations([c[1] for c in candidates], ssize))
        rand_mean = sum(sum(c) for c in all_combos) / len(all_combos)

        records_per_entity[cell['entity']].append({
            'slate': slate, 'team': team, 'ssize': ssize,
            'top1_actual': top1_actual, 'rand_mean': rand_mean,
            'pool_size': len(candidates),
        })

    # Aggregate + bootstrap
    def bootstrap_mean(values, n_boot=10000):
        if not values:
            return float('nan'), float('nan'), float('nan')
        means = []
        N = len(values)
        for _ in range(n_boot):
            sample = [values[random.randrange(N)] for _ in range(N)]
            means.append(sum(sample) / N)
        means.sort()
        return (sum(values) / N, means[int(0.025 * n_boot)], means[int(0.975 * n_boot)])

    summary = {}
    for ent, recs in records_per_entity.items():
        top1_vals = [r['top1_actual'] for r in recs]
        rand_vals = [r['rand_mean'] for r in recs]
        diffs = [r['top1_actual'] - r['rand_mean'] for r in recs]
        m_top, lo_top, hi_top = bootstrap_mean(top1_vals)
        m_rand, lo_rand, hi_rand = bootstrap_mean(rand_vals)
        m_diff, lo_diff, hi_diff = bootstrap_mean(diffs)
        summary[ent] = {
            'n_cells': len(recs),
            'mean_top1_actual': m_top, 'top1_lo95': lo_top, 'top1_hi95': hi_top,
            'mean_random_actual': m_rand, 'rand_lo95': lo_rand, 'rand_hi95': hi_rand,
            'mean_top1_minus_random': m_diff, 'diff_lo95': lo_diff, 'diff_hi95': hi_diff,
        }

    return summary, skipped


def main():
    print("Loading dump...")
    with open(DUMP) as f:
        dump = json.load(f)
    print(f"  {len(dump)} slates")

    print("Stage 2: building cells...")
    cells, lineup_counts, ssize_counts = build_cells(dump)
    print(f"  {len(cells)} cells total")
    print(f"  Entities: {sorted(lineup_counts.keys())}")

    print("Stage 2: computing per-cell metrics...")
    per_cell = stage2_build(cells)
    qualifying = sum(1 for c in per_cell.values() if c['qualifies'])
    print(f"  {qualifying} cells pass >=5 filter")

    print("Stages 3-4: aggregating distributions...")
    agg = stage3_aggregate(per_cell)
    rows = write_stage2_3_4(per_cell, agg, lineup_counts, ssize_counts)

    print("Stage 6: outcome correlation (loading actuals/projections per slate)...")
    outcome, skipped = stage6_outcome(per_cell, dump)
    print(f"  skipped {skipped} cells (missing actuals/projections)")

    # Save outcome csv
    with open(os.path.join(OUT, 'outcome_correlation.csv'), 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow([
            'entity', 'n_cells',
            'mean_top1_actual', 'top1_lo95', 'top1_hi95',
            'mean_random_actual', 'rand_lo95', 'rand_hi95',
            'mean_top1_minus_random', 'diff_lo95', 'diff_hi95'
        ])
        for ent in ['V1'] + sorted([k for k in outcome if k != 'V1']):
            s = outcome[ent]
            w.writerow([
                ent, s['n_cells'],
                f"{s['mean_top1_actual']:.2f}", f"{s['top1_lo95']:.2f}", f"{s['top1_hi95']:.2f}",
                f"{s['mean_random_actual']:.2f}", f"{s['rand_lo95']:.2f}", f"{s['rand_hi95']:.2f}",
                f"{s['mean_top1_minus_random']:+.2f}", f"{s['diff_lo95']:+.2f}", f"{s['diff_hi95']:+.2f}",
            ])

    # Stage 5: pattern check (run regardless; we'll decide whether to feature based on Stage 3-4)
    print("Stage 5: pattern checks...")
    patterns = stage5_patterns(per_cell, dump)
    # Aggregate per entity
    pat_agg = defaultdict(lambda: Counter())
    pat_total = defaultdict(int)
    for r in patterns:
        ent = r['entity']
        pat_total[ent] += 1
        for k in ('match_top_proj', 'match_anti_own', 'match_leverage', 'match_contig_order', 'match_other'):
            if r[k]:
                pat_agg[ent][k] += 1

    with open(os.path.join(OUT, 'hitter_set_patterns_raw.csv'), 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow([
            'entity', 'n_cells_checked',
            'pct_top_proj', 'pct_anti_own', 'pct_leverage', 'pct_contig_order', 'pct_other'
        ])
        for ent in ['V1'] + sorted([k for k in pat_total if k != 'V1']):
            n = pat_total[ent]
            c = pat_agg[ent]
            w.writerow([
                ent, n,
                f"{c['match_top_proj']/n:.3f}",
                f"{c['match_anti_own']/n:.3f}",
                f"{c['match_leverage']/n:.3f}",
                f"{c['match_contig_order']/n:.3f}",
                f"{c['match_other']/n:.3f}",
            ])

    # Print main summary table
    print("\n" + "=" * 100)
    print("STAGE 3-4 DISTRIBUTION TABLE")
    print("=" * 100)
    print(f"{'Entity':<18} {'TotL':>5} {'%4s':>6} {'%5s':>6} | "
          f"{'4s_cells':>8} {'4s_uniq':>7} {'4s_top1':>7} {'4s_ent':>7} | "
          f"{'5s_cells':>8} {'5s_uniq':>7} {'5s_top1':>7} {'5s_ent':>7}")
    for r in rows:
        s4 = r['4stack'] or {}
        s5 = r['5stack'] or {}
        def f(d, k, fmt='{:.2f}'):
            return fmt.format(d[k]) if d and k in d else '-'
        print(f"{r['entity']:<18} {r['total_lineups']:>5} "
              f"{r['pct_4stack']:>6.2f} {r['pct_5stack']:>6.2f} | "
              f"{s4.get('n_cells', '-'):>8} {f(s4,'mean_unique'):>7} {f(s4,'mean_top1','{:.3f}'):>7} {f(s4,'mean_entropy','{:.3f}'):>7} | "
              f"{s5.get('n_cells', '-'):>8} {f(s5,'mean_unique'):>7} {f(s5,'mean_top1','{:.3f}'):>7} {f(s5,'mean_entropy','{:.3f}'):>7}")

    print("\n" + "=" * 100)
    print("STAGE 6 OUTCOME CORRELATION (with bootstrap 95% CIs)")
    print("=" * 100)
    print(f"{'Entity':<18} {'cells':>5} {'top1_actual (CI)':>30} {'random (CI)':>30} {'diff (CI)':>22}")
    for ent in ['V1'] + sorted([k for k in outcome if k != 'V1']):
        s = outcome[ent]
        print(f"{ent:<18} {s['n_cells']:>5} "
              f"{s['mean_top1_actual']:>8.2f} ({s['top1_lo95']:>6.2f}, {s['top1_hi95']:>6.2f})  "
              f"{s['mean_random_actual']:>8.2f} ({s['rand_lo95']:>6.2f}, {s['rand_hi95']:>6.2f})  "
              f"{s['mean_top1_minus_random']:>+7.2f} ({s['diff_lo95']:>+5.2f}, {s['diff_hi95']:>+5.2f})")

    print("\n" + "=" * 100)
    print("STAGE 5 SELECTION PATTERN CHECK")
    print("=" * 100)
    print(f"{'Entity':<18} {'n':>5} {'top_proj':>8} {'anti_own':>8} {'leverage':>8} {'contig_ord':>10} {'other':>6}")
    for ent in ['V1'] + sorted([k for k in pat_total if k != 'V1']):
        n = pat_total[ent]
        c = pat_agg[ent]
        if n == 0:
            continue
        print(f"{ent:<18} {n:>5} "
              f"{c['match_top_proj']/n:>8.3f} {c['match_anti_own']/n:>8.3f} "
              f"{c['match_leverage']/n:>8.3f} {c['match_contig_order']/n:>10.3f} "
              f"{c['match_other']/n:>6.3f}")

    return rows, outcome, patterns, per_cell, lineup_counts


if __name__ == '__main__':
    main()
