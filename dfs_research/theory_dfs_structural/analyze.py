"""
Structural validation analyzer — 6 framework checks across all systems.

Reads all_systems_lineups.json and produces per-system structural scorecards.

Validations:
  V1 — Finishing-percentile distribution shape (inverse-bell vs bell)
  V2 — Top-tail concentration vs random baseline
  V3 — Mahalanobis to pro consensus (MLB only)
  V4 — Variance band distribution (Ch.8 — proj/own bands)
  V5 — Per-archetype adaptation (slate-size-driven shifts)
  V6 — Combinatorial uniqueness vs duplication
"""
import json
import sys
import statistics
from collections import defaultdict, Counter
from itertools import combinations

sys.stdout.reconfigure(encoding='utf-8')

with open(r'C:\Users\colin\dfs opto\theory_dfs_structural\all_systems_lineups.json', encoding='utf-8') as f:
    data = json.load(f)

# Group by system.
systems = defaultdict(list)
for r in data:
    systems[r['system']].append(r)

print('=' * 90)
print('STRUCTURAL VALIDATION — 6 framework checks')
print('=' * 90)
print(f'\nLoaded {len(data)} system-slate combinations across {len(systems)} systems:')
for sys_name, runs in systems.items():
    sport = runs[0]['sport']
    print(f'  {sys_name:20s}: {len(runs)} slates ({sport})')

# Random expected rates per slate.
N = 150
EXPECTED_T1_PER_SLATE = N * 0.01    # 1.5
EXPECTED_T01_PER_SLATE = N * 0.001  # 0.15

# ------------------------------------------------------------
# V1 — Finishing-percentile distribution shape
# ------------------------------------------------------------
def v1_finishing_distribution(runs):
    """Inverse-bell = top + bottom > middle. Returns (top_share, mid_share, bot_share, shape)."""
    all_pctiles = []
    for r in runs:
        for lu in r['lineups']:
            if lu['fp'] is not None:
                all_pctiles.append(lu['fp'])
    if not all_pctiles:
        return None
    deciles = [0] * 10
    for v in all_pctiles:
        idx = min(9, int((1 - v) * 10))
        deciles[idx] += 1
    total = len(all_pctiles)
    pcts = [c / total * 100 for c in deciles]
    top = pcts[0]              # top decile (best 10% finishes)
    mid = pcts[4] + pcts[5]    # middle two deciles
    bot = pcts[9]              # bottom decile (worst 10% finishes)
    # Inverse-bell: top + bot > mid. Bell: mid > top + bot.
    shape = 'inverse-bell' if (top + bot) > mid else 'bell'
    # Strength: how strongly inverse-bell?
    strength = (top + bot) - mid
    return {
        'deciles': pcts,
        'top_decile_pct': top,
        'mid_decile_pct': mid,
        'bot_decile_pct': bot,
        'shape': shape,
        'strength': strength,
        'pass': shape == 'inverse-bell' and top > 9.0,  # need real top concentration too (>9% in top decile = above random)
    }

# ------------------------------------------------------------
# V2 — Top-tail concentration vs random
# ------------------------------------------------------------
def v2_top_tail_concentration(runs):
    total_t1 = sum(r['t1'] for r in runs)
    total_t01 = sum(r['t01'] for r in runs)
    expected_t1 = EXPECTED_T1_PER_SLATE * len(runs)
    expected_t01 = EXPECTED_T01_PER_SLATE * len(runs)
    return {
        't1': total_t1, 't01': total_t01,
        'expected_t1': expected_t1, 'expected_t01': expected_t01,
        't1_x_random': total_t1 / expected_t1 if expected_t1 > 0 else 0,
        't01_x_random': total_t01 / expected_t01 if expected_t01 > 0 else 0,
        'slates_with_t01': sum(1 for r in runs if r['t01'] > 0),
        'pass_t1': (total_t1 / expected_t1) >= 1.5 if expected_t1 > 0 else False,
        'pass_t01': (total_t01 / expected_t01) >= 1.5 if expected_t01 > 0 else False,
        'pass': (total_t1 / expected_t1) >= 1.5 or (total_t01 / expected_t01) >= 1.5,
    }

# ------------------------------------------------------------
# V3 — Mahalanobis to pro consensus (MLB only)
# ------------------------------------------------------------
def v3_mahalanobis(runs):
    sport = runs[0]['sport']
    if sport == 'nba':
        return {'applicable': False, 'note': 'no NBA pro consensus data'}
    mahals = [r['mahal'] for r in runs if r['mahal'] is not None]
    if not mahals:
        return {'applicable': False}
    m = statistics.mean(mahals)
    return {
        'applicable': True,
        'mean_mahal': m,
        'std_mahal': statistics.stdev(mahals) if len(mahals) > 1 else 0,
        'min_mahal': min(mahals),
        'max_mahal': max(mahals),
        'pass': m <= 1.5,  # within d<2 zone; pros cluster d<1.3
    }

# ------------------------------------------------------------
# V4 — Variance band distribution (Ch.8: 20/60/20)
# ------------------------------------------------------------
def v4_variance_bands(runs):
    """For each lineup, classify into HIGH (high-proj+high-own), LOW (low+low), MID (other).
    Threshold: top/bottom 30% by combined proj+own percentile sum."""
    high_count = 0
    mid_count = 0
    low_count = 0
    total = 0
    for r in runs:
        for lu in r['lineups']:
            score = lu['pp'] + lu['op']  # 0..2 range; high = 2, low = 0
            if score >= 1.4:  # both proj and own > 0.7 percentile, roughly
                high_count += 1
            elif score <= 0.6:  # both < 0.3
                low_count += 1
            else:
                mid_count += 1
            total += 1
    if total == 0:
        return None
    high_pct = high_count / total * 100
    mid_pct = mid_count / total * 100
    low_pct = low_count / total * 100
    # Pass: each band has reasonable representation (5-50%); fail if all in one band.
    distributed = (high_pct >= 5 and high_pct <= 50 and low_pct >= 5 and low_pct <= 50 and mid_pct >= 30)
    return {
        'high_pct': high_pct,
        'mid_pct': mid_pct,
        'low_pct': low_pct,
        'pass': distributed,
        'note': f'target ≈ 20/60/20 per Ch.8 (illustrative, not strict)',
    }

# ------------------------------------------------------------
# V5 — Per-archetype adaptation
# ------------------------------------------------------------
def v5_archetype_adaptation(runs):
    """Classify each slate by size archetype, compute system metrics per archetype.
    Pass: metrics shift (avg own_pct, avg proj_pct) detectably between small and large slates."""
    sport = runs[0]['sport']
    archetypes = defaultdict(list)
    for r in runs:
        if sport == 'mlb':
            t = r['numTeams']
            arch = 'small' if t <= 4 else ('medium' if t <= 8 else 'large')
        else:
            g = r['numGames']
            arch = 'small' if g <= 4 else ('medium' if g <= 7 else 'large')
        archetypes[arch].append(r)
    # For each archetype, compute average lineup own_pct and proj_pct.
    arch_stats = {}
    for arch, arch_runs in archetypes.items():
        own_pcts = []
        proj_pcts = []
        for r in arch_runs:
            for lu in r['lineups']:
                own_pcts.append(lu['op'])
                proj_pcts.append(lu['pp'])
        if own_pcts:
            arch_stats[arch] = {
                'n_slates': len(arch_runs),
                'avg_own_pct': statistics.mean(own_pcts),
                'avg_proj_pct': statistics.mean(proj_pcts),
            }
    # Adaptation: does avg_own_pct shift across archetypes by more than 0.05?
    if len(arch_stats) < 2:
        return {'archetypes': arch_stats, 'pass': None, 'note': 'only 1 archetype represented'}
    own_values = [v['avg_own_pct'] for v in arch_stats.values()]
    proj_values = [v['avg_proj_pct'] for v in arch_stats.values()]
    own_spread = max(own_values) - min(own_values)
    proj_spread = max(proj_values) - min(proj_values)
    return {
        'archetypes': arch_stats,
        'own_spread': own_spread,
        'proj_spread': proj_spread,
        'pass': own_spread > 0.05 or proj_spread > 0.05,
        'note': 'pass = system metrics shift > 5pp between slate-size archetypes',
    }

# ------------------------------------------------------------
# V6 — Combinatorial uniqueness vs duplication
# ------------------------------------------------------------
def v6_combinatorial_uniqueness(runs):
    """Compute avg pair-frequency in portfolio vs random sample equilibrium.
    If portfolio over-uses certain pairs (high pair freq), score is high → bad.
    Pass: avg pair freq is similar to or below pool equilibrium (no over-duplication)."""
    # Aggregate across slates.
    all_pair_freqs = []
    over_duplicated_pairs = 0
    total_pairs = 0
    for r in runs:
        # Build pair counter for this slate's portfolio.
        portfolio_pairs = Counter()
        for lu in r['lineups']:
            ids = sorted(lu['pids'])
            for i, j in combinations(range(len(ids)), 2):
                portfolio_pairs[(ids[i], ids[j])] += 1
        # Top-decile pair frequency.
        if portfolio_pairs:
            counts = sorted(portfolio_pairs.values(), reverse=True)
            top_count = counts[0]
            top_pct = top_count / len(r['lineups'])
            avg_count = statistics.mean(counts)
            # Pairs that appear > 50% of lineups are highly over-duplicated.
            for k, c in portfolio_pairs.items():
                total_pairs += 1
                if c >= len(r['lineups']) * 0.50:
                    over_duplicated_pairs += 1
            all_pair_freqs.append({
                'slate': r['slate'],
                'top_pair_count': top_count,
                'top_pair_pct': top_pct,
                'avg_pair_count': avg_count,
            })
    if not all_pair_freqs:
        return None
    avg_top = statistics.mean(p['top_pair_pct'] for p in all_pair_freqs)
    over_dup_rate = over_duplicated_pairs / total_pairs * 100 if total_pairs else 0
    # Pass: top pair concentration < 80% (no extreme duplication).
    return {
        'avg_top_pair_pct': avg_top,
        'over_duplicated_pair_rate': over_dup_rate,
        'pass': avg_top < 0.85,
        'note': f'top pair appears in {avg_top*100:.0f}% of lineups on avg; >85% = over-duplication',
    }

# ------------------------------------------------------------
# Run all validations per system.
# ------------------------------------------------------------
results = {}
for sys_name, runs in systems.items():
    results[sys_name] = {
        'sport': runs[0]['sport'],
        'n_slates': len(runs),
        'V1_finishing_distribution': v1_finishing_distribution(runs),
        'V2_top_tail_concentration': v2_top_tail_concentration(runs),
        'V3_mahalanobis': v3_mahalanobis(runs),
        'V4_variance_bands': v4_variance_bands(runs),
        'V5_archetype_adaptation': v5_archetype_adaptation(runs),
        'V6_combinatorial_uniqueness': v6_combinatorial_uniqueness(runs),
    }

# ------------------------------------------------------------
# Print scorecards.
# ------------------------------------------------------------
print('\n' + '=' * 90)
print('STRUCTURAL SCORECARD PER SYSTEM')
print('=' * 90)
for sys_name, r in results.items():
    print(f'\n{"-" * 90}')
    print(f'{sys_name.upper()} ({r["sport"].upper()}, {r["n_slates"]} slates)')
    print(f'{"-" * 90}')

    v1 = r['V1_finishing_distribution']
    p = '✓ PASS' if v1['pass'] else '✗ fail'
    print(f'  V1 Finishing distribution:      {v1["shape"]:14s}  top={v1["top_decile_pct"]:.1f}% mid={v1["mid_decile_pct"]:.1f}% bot={v1["bot_decile_pct"]:.1f}%  [{p}]')

    v2 = r['V2_top_tail_concentration']
    p = '✓ PASS' if v2['pass'] else '✗ fail'
    print(f'  V2 Top-tail concentration:      t1={v2["t1_x_random"]:.2f}× random  t01={v2["t01_x_random"]:.2f}× random  [{p}]')

    v3 = r['V3_mahalanobis']
    if v3.get('applicable'):
        p = '✓ PASS' if v3['pass'] else '✗ fail'
        print(f'  V3 Mahalanobis to pros:         mean={v3["mean_mahal"]:.2f}  range=[{v3["min_mahal"]:.2f}..{v3["max_mahal"]:.2f}]  [{p}]')
    else:
        print(f'  V3 Mahalanobis to pros:         N/A ({v3.get("note", "no consensus data")})')

    v4 = r['V4_variance_bands']
    p = '✓ PASS' if v4['pass'] else '✗ fail'
    print(f'  V4 Variance bands:              high={v4["high_pct"]:.0f}% mid={v4["mid_pct"]:.0f}% low={v4["low_pct"]:.0f}%  [{p}]')

    v5 = r['V5_archetype_adaptation']
    if v5.get('pass') is None:
        print(f'  V5 Archetype adaptation:        {v5.get("note", "n/a")}')
    else:
        p = '✓ PASS' if v5['pass'] else '✗ fail'
        spread_str = f'own_spread={v5["own_spread"]:.3f} proj_spread={v5["proj_spread"]:.3f}'
        print(f'  V5 Archetype adaptation:        {spread_str}  [{p}]')
        for arch, stats in v5['archetypes'].items():
            print(f'      {arch:8s} ({stats["n_slates"]} slates): own_pct={stats["avg_own_pct"]:.3f}  proj_pct={stats["avg_proj_pct"]:.3f}')

    v6 = r['V6_combinatorial_uniqueness']
    p = '✓ PASS' if v6['pass'] else '✗ fail'
    print(f'  V6 Combinatorial uniqueness:    top pair {v6["avg_top_pair_pct"]*100:.0f}% of lineups  over-dup rate {v6["over_duplicated_pair_rate"]:.1f}%  [{p}]')

# ------------------------------------------------------------
# Cross-system summary table.
# ------------------------------------------------------------
print('\n' + '=' * 90)
print('CROSS-SYSTEM SUMMARY')
print('=' * 90)
print(f'\n{"System":<22s} | {"V1 shape":<14s} | {"V2 t1×":>6s} | {"V2 t01×":>7s} | {"V3 mahal":>8s} | {"V4":>3s} | {"V5":>3s} | {"V6":>3s} | {"Pass":>5s}')
print('-' * 90)
for sys_name, r in results.items():
    v1 = r['V1_finishing_distribution']
    v2 = r['V2_top_tail_concentration']
    v3 = r['V3_mahalanobis']
    v4 = r['V4_variance_bands']
    v5 = r['V5_archetype_adaptation']
    v6 = r['V6_combinatorial_uniqueness']
    p1 = 'P' if v1['pass'] else '.'
    p2 = 'P' if v2['pass'] else '.'
    p3 = 'P' if (v3.get('applicable') and v3['pass']) else ('.' if v3.get('applicable') else '/')
    p4 = 'P' if v4['pass'] else '.'
    p5 = 'P' if v5.get('pass') == True else ('.' if v5.get('pass') == False else '/')
    p6 = 'P' if v6['pass'] else '.'
    pass_count = sum(1 for x in [p1, p2, p3, p4, p5, p6] if x == 'P')
    applicable_count = sum(1 for x in [p1, p2, p3, p4, p5, p6] if x != '/')
    mahal_str = f'{v3["mean_mahal"]:.2f}' if v3.get('applicable') else 'n/a'
    print(f'{sys_name:<22s} | {v1["shape"]:<14s} | {v2["t1_x_random"]:>6.2f} | {v2["t01_x_random"]:>7.2f} | {mahal_str:>8s} | {p4:>3s} | {p5:>3s} | {p6:>3s} | {pass_count}/{applicable_count}')

# Save JSON.
out = {sys_name: r for sys_name, r in results.items()}
with open(r'C:\Users\colin\dfs opto\theory_dfs_structural\scorecards.json', 'w') as f:
    json.dump(out, f, indent=2, default=str)
print(f'\nSaved scorecards.json')
