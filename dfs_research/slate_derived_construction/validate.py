"""
Stage 3 validation: structural alignment of slate-derived-construction (SDC)
portfolios vs pros, with V1 as reference baseline.

Reads:
  - C:/Users/colin/dfs opto/theory_dfs_v2/v1_pros_lineup_dump.json
      Per-slate V1 lineups (150) + pros lineups (~50/slate) with rich features.
  - C:/Users/colin/dfs opto/slate_derived_construction/{slate}_detail.csv
      Per-slate SDC portfolio (75 lineups) with structural fields.
  - C:/Users/colin/dfs opto/{slate}projections.csv  (for projection ranges)

Computes structural metrics (NOT outcome ROI):
  1. Band distribution (HP/HO, HP/LO, LP/HO, LP/LO) using slate-relative median
     of projection and geoMeanOwn pooled across V1+pros+SDC.
  2. Stack distribution: top-(primary,secondary) patterns.
  3. Bring-back rate: avg, >=1, >=2.
  4. Mahalanobis distance to per-slate pro consensus on a 5-feature vector.
  5. Per-portfolio fingerprint distance: median lineup distance to nearest pro
     on standardized 9-feature Manhattan.

Writes:
  - C:/Users/colin/dfs opto/slate_derived_construction/validation_results.json
  - C:/Users/colin/dfs opto/slate_derived_construction/validation_table.txt
"""

import csv
import json
import math
import os
import statistics
import sys
from collections import Counter, defaultdict

sys.stdout.reconfigure(encoding='utf-8')

DUMP_PATH = r'C:\Users\colin\dfs opto\theory_dfs_v2\v1_pros_lineup_dump.json'
SDC_DIR = r'C:\Users\colin\dfs opto\slate_derived_construction'
RESULTS_PATH = os.path.join(SDC_DIR, 'validation_results.json')
TABLE_PATH = os.path.join(SDC_DIR, 'validation_table.txt')

# Fingerprint features (matches lineup_level/T1_fingerprint.py)
FINGERPRINT_FEATURES = [
    'primarySize', 'secondarySize', 'bringBack', 'maxGameStack',
    'numGames', 'numTeamsUsed', 'geoMeanOwnHit', 'salaryStd',
    'salaryTopThree',
]

# Universal Mahalanobis features — adapted for SDC where finishPct/ceilings
# aren't available. Use what's computable from both portfolios:
#   - primarySize, secondarySize, bringBack (correlation structure)
#   - geoMeanOwn (relative to slate avg)
#   - numGames, numTeamsUsed (diversification structure)
UNIVERSAL_METRICS = [
    'primarySize', 'secondarySize', 'bringBack',
    'numGames', 'numTeamsUsed', 'geoMeanOwn', 'avgProj',
]


def load_dump():
    with open(DUMP_PATH, 'r', encoding='utf-8') as f:
        return json.load(f)


def parse_sdc_detail(slate):
    path = os.path.join(SDC_DIR, f'{slate}_detail.csv')
    if not os.path.exists(path):
        return None
    rows = []
    with open(path, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append({
                'tier': row['tier'],
                'mode': row['mode'],
                'stackPattern': row['stackPattern'],
                'primarySize': int(row['primarySize']),
                'secondarySize': int(row['secondarySize']),
                'primaryTeam': row['primaryTeam'].upper(),
                'primaryOpp': row['primaryOpp'].upper(),
                'bringBack': int(row['bringBack']),
                'projection': float(row['proj']),
                'geoMeanOwnHit': float(row['geoMeanOwnHit']),
                'geoMeanOwn': float(row['geoMeanOwn']),
                'salaryTotal': int(row['salaryTotal']),
                'salaryStd': float(row['salaryStd']),
                'salaryTopThree': float(row['salaryTopThree']),
                'numGames': int(row['numGames']),
                'numTeamsUsed': int(row['numTeamsUsed']),
                'maxGameStack': int(row['maxGameStack']),
                'avgProj': float(row['proj']) / 10.0,
            })
    return rows


def safe_geo_own_hit(lu):
    # The dump's pros/v1 already have geoMeanOwnHit precomputed.
    return lu.get('geoMeanOwnHit') or 0


# ============================================================
# 1. BAND DISTRIBUTION
# ============================================================
def band(p, o, med_p, med_o):
    hp = p >= med_p
    ho = o >= med_o
    if hp and ho: return 'HP/HO'
    if hp and not ho: return 'HP/LO'
    if not hp and ho: return 'LP/HO'
    return 'LP/LO'


# ============================================================
# 2. STACK DISTRIBUTION (use top patterns from dump as "buckets")
# ============================================================
def stack_pattern(lu):
    return f"{lu['primarySize']}-{lu['secondarySize']}"


# ============================================================
# 4. MAHALANOBIS to per-slate pro consensus
# ============================================================
def lineup_metrics_vec(lu):
    return {
        'primarySize': lu['primarySize'],
        'secondarySize': lu['secondarySize'],
        'bringBack': lu['bringBack'],
        'numGames': lu.get('numGames') or 0,
        'numTeamsUsed': lu.get('numTeamsUsed') or 0,
        'geoMeanOwn': safe_geo_own_hit(lu),
        'avgProj': (lu.get('projection') or 0) / 10.0,
    }


def portfolio_consensus(pro_lus):
    # Compute mean and std of each Mahalanobis feature across pros, lineup-level.
    out = {}
    for k in UNIVERSAL_METRICS:
        vals = [lineup_metrics_vec(lu)[k] for lu in pro_lus]
        if not vals: continue
        m = statistics.mean(vals)
        s = statistics.pstdev(vals) if len(vals) > 1 else 0.01
        out[k] = (m, max(s, 1e-3))
    return out


def portfolio_to_consensus_distance(portfolio_lus, consensus):
    # Average Mahalanobis: sqrt( mean over features of ((mean(portfolio_feat) - mean_pros) / std_pros)^2 )
    # i.e., compare PORTFOLIO MEAN to PRO MEAN, normalized by pro std.
    if not portfolio_lus:
        return None
    sum_sq = 0.0; n = 0
    for k in UNIVERSAL_METRICS:
        if k not in consensus: continue
        m_pros, s_pros = consensus[k]
        port_vals = [lineup_metrics_vec(lu)[k] for lu in portfolio_lus]
        m_port = statistics.mean(port_vals)
        d = (m_port - m_pros) / s_pros
        sum_sq += d * d
        n += 1
    if n == 0: return None
    return math.sqrt(sum_sq / n)


# ============================================================
# 5. FINGERPRINT DISTANCE (per-pro nearest)
# ============================================================
def fingerprint_vec(lu):
    return [float(lu.get(f) or 0) for f in FINGERPRINT_FEATURES]


def manhattan(a, b, scales):
    return sum(abs(x - y) / s for x, y, s in zip(a, b, scales))


def median_fingerprint_dist(portfolio_lus, pros, all_lus_for_scaling):
    # Standardize by std across all_lus combined (V1+pros+SDC together)
    scales = []
    for fi, f in enumerate(FINGERPRINT_FEATURES):
        vals = [lu.get(f) or 0 for lu in all_lus_for_scaling]
        sd = statistics.pstdev(vals) if len(vals) > 1 else 1.0
        scales.append(max(sd, 0.1))
    pro_vecs = [fingerprint_vec(p) for p in pros]
    if not pro_vecs:
        return None
    distances = []
    for lu in portfolio_lus:
        v = fingerprint_vec(lu)
        d = min(manhattan(v, pv, scales) for pv in pro_vecs)
        distances.append(d)
    return statistics.median(distances) if distances else None


# ============================================================
# MAIN
# ============================================================
def main():
    dump = load_dump()
    print(f'Loaded dump: {len(dump)} slates')

    per_slate_results = []
    agg = {
        'v1':  {'bands': Counter(), 'stacks': Counter(), 'bb_geq1': 0, 'bb_geq2': 0, 'bb_sum': 0, 'n': 0,
                'mahal': [], 'fingerprint': []},
        'pros':{'bands': Counter(), 'stacks': Counter(), 'bb_geq1': 0, 'bb_geq2': 0, 'bb_sum': 0, 'n': 0,
                'mahal': [], 'fingerprint': []},
        'sdc': {'bands': Counter(), 'stacks': Counter(), 'bb_geq1': 0, 'bb_geq2': 0, 'bb_sum': 0, 'n': 0,
                'mahal': [], 'fingerprint': []},
    }

    for s in dump:
        slate = s['slate']
        v1 = s['v1']; pros = s['pros']
        sdc = parse_sdc_detail(slate)
        if not sdc:
            print(f'  [{slate}] SDC missing; skipped')
            continue
        if not v1 or not pros:
            print(f'  [{slate}] v1/pros missing; skipped')
            continue

        # Pooled medians for band classification (V1 + pros + SDC).
        all_lu = v1 + pros + sdc
        projs_sorted = sorted(lu['projection'] for lu in all_lu)
        owns_sorted  = sorted(safe_geo_own_hit(lu) for lu in all_lu)
        med_p = projs_sorted[len(projs_sorted) // 2]
        med_o = owns_sorted[len(owns_sorted) // 2]

        sys_results = {}
        for sysname, lus in (('v1', v1), ('pros', pros), ('sdc', sdc)):
            band_counts = Counter()
            stack_counts = Counter()
            bb_geq1 = 0; bb_geq2 = 0; bb_sum = 0
            for lu in lus:
                b = band(lu['projection'], safe_geo_own_hit(lu), med_p, med_o)
                band_counts[b] += 1
                stack_counts[stack_pattern(lu)] += 1
                if lu['bringBack'] >= 1: bb_geq1 += 1
                if lu['bringBack'] >= 2: bb_geq2 += 1
                bb_sum += lu['bringBack']
                # Aggregate
                agg[sysname]['bands'][b] += 1
                agg[sysname]['stacks'][stack_pattern(lu)] += 1
                if lu['bringBack'] >= 1: agg[sysname]['bb_geq1'] += 1
                if lu['bringBack'] >= 2: agg[sysname]['bb_geq2'] += 1
                agg[sysname]['bb_sum'] += lu['bringBack']
                agg[sysname]['n'] += 1

            sys_results[sysname] = {
                'n': len(lus),
                'bands_pct': {b: (band_counts[b] / max(1, len(lus))) * 100 for b in ('HP/HO','HP/LO','LP/HO','LP/LO')},
                'top_stacks': dict(stack_counts.most_common(5)),
                'bb_avg': bb_sum / max(1, len(lus)),
                'bb_geq1_pct': bb_geq1 / max(1, len(lus)) * 100,
                'bb_geq2_pct': bb_geq2 / max(1, len(lus)) * 100,
            }

        # Mahalanobis: V1 vs pros, SDC vs pros (consensus computed from pros)
        consensus = portfolio_consensus(pros)
        mahal_v1  = portfolio_to_consensus_distance(v1, consensus)
        mahal_sdc = portfolio_to_consensus_distance(sdc, consensus)
        sys_results['v1']['mahal']   = mahal_v1
        sys_results['sdc']['mahal']  = mahal_sdc
        sys_results['pros']['mahal'] = 0.0  # by definition

        if mahal_v1 is not None: agg['v1']['mahal'].append(mahal_v1)
        if mahal_sdc is not None: agg['sdc']['mahal'].append(mahal_sdc)

        # Fingerprint distance: median V1 lineup nearest-pro Manhattan; same for SDC.
        # Need a common scale set (use V1+pros+SDC to compute scales).
        fp_v1  = median_fingerprint_dist(v1, pros, all_lu)
        fp_sdc = median_fingerprint_dist(sdc, pros, all_lu)
        sys_results['v1']['fingerprint']  = fp_v1
        sys_results['sdc']['fingerprint'] = fp_sdc
        sys_results['pros']['fingerprint'] = None  # not meaningful (pros vs pros = mostly 0)

        if fp_v1 is not None: agg['v1']['fingerprint'].append(fp_v1)
        if fp_sdc is not None: agg['sdc']['fingerprint'].append(fp_sdc)

        per_slate_results.append({
            'slate': slate,
            'med_proj': med_p,
            'med_own': med_o,
            'systems': sys_results,
        })
        print(f'  [{slate}] med_p={med_p:.1f} med_o={med_o:.1f} '
              f'mahal v1={mahal_v1:.2f} sdc={mahal_sdc:.2f}  '
              f'fp v1={fp_v1:.2f} sdc={fp_sdc:.2f}')

    # ========================================================
    # AGGREGATE
    # ========================================================
    def agg_summary(d):
        bands = d['bands']; total = sum(bands.values())
        return {
            'bands_pct': {b: bands.get(b, 0) / max(1, total) * 100 for b in ('HP/HO','HP/LO','LP/HO','LP/LO')},
            'top_stacks_pct': {k: v / max(1, total) * 100 for k, v in bands.most_common()},  # placeholder
            'top_stack_patterns_pct': {k: v / max(1, sum(d['stacks'].values())) * 100 for k, v in d['stacks'].most_common(8)},
            'bb_avg': d['bb_sum'] / max(1, d['n']),
            'bb_geq1_pct': d['bb_geq1'] / max(1, d['n']) * 100,
            'bb_geq2_pct': d['bb_geq2'] / max(1, d['n']) * 100,
            'mahal_median': statistics.median(d['mahal']) if d['mahal'] else None,
            'mahal_mean':   statistics.mean(d['mahal']) if d['mahal'] else None,
            'fingerprint_median': statistics.median(d['fingerprint']) if d['fingerprint'] else None,
            'fingerprint_mean':   statistics.mean(d['fingerprint']) if d['fingerprint'] else None,
            'n_lineups': d['n'],
        }

    aggregate = {sys: agg_summary(d) for sys, d in agg.items()}

    # ========================================================
    # WRITE TABLE
    # ========================================================
    with open(TABLE_PATH, 'w', encoding='utf-8') as f:
        def line(s=''): print(s); f.write(s + '\n')
        line('=' * 80)
        line('STAGE 3 VALIDATION — Slate-Derived Construction (SDC) vs V1 vs Pros')
        line('=' * 80)
        line(f'\nLineups counted (across 24 slates):')
        for sys in ('v1', 'sdc', 'pros'):
            line(f'  {sys:5s}: {aggregate[sys]["n_lineups"]:>6d}')

        # Bands
        line('\n--- BAND DISTRIBUTION (slate-relative, pooled median) ---')
        line(f'{"Band":<8s} | {"V1 %":>8s} | {"SDC %":>8s} | {"Pros %":>8s} | {"V1 gap":>8s} | {"SDC gap":>8s}')
        line('-' * 70)
        for b in ('HP/HO','HP/LO','LP/HO','LP/LO'):
            v1p = aggregate['v1']['bands_pct'][b]
            sp  = aggregate['sdc']['bands_pct'][b]
            pp  = aggregate['pros']['bands_pct'][b]
            line(f'{b:<8s} | {v1p:>7.1f}% | {sp:>7.1f}% | {pp:>7.1f}% | {v1p-pp:>+7.1f} | {sp-pp:>+7.1f}')

        # Stacks
        line('\n--- STACK DISTRIBUTION (top patterns) ---')
        line(f'{"Pattern":<10s} | {"V1 %":>7s} | {"SDC %":>7s} | {"Pros %":>7s}')
        line('-' * 50)
        all_keys = set(aggregate['v1']['top_stack_patterns_pct'].keys()) | \
                   set(aggregate['sdc']['top_stack_patterns_pct'].keys()) | \
                   set(aggregate['pros']['top_stack_patterns_pct'].keys())
        # Sort by pros' share desc
        pros_pat = aggregate['pros']['top_stack_patterns_pct']
        for pat in sorted(all_keys, key=lambda k: -pros_pat.get(k, 0)):
            v1p = aggregate['v1']['top_stack_patterns_pct'].get(pat, 0)
            sp  = aggregate['sdc']['top_stack_patterns_pct'].get(pat, 0)
            pp  = aggregate['pros']['top_stack_patterns_pct'].get(pat, 0)
            line(f'{pat:<10s} | {v1p:>6.1f}% | {sp:>6.1f}% | {pp:>6.1f}%')

        # Bring-back
        line('\n--- BRING-BACK RATE ---')
        line(f'{"Metric":<12s} | {"V1":>8s} | {"SDC":>8s} | {"Pros":>8s}')
        line('-' * 50)
        for k, label in (('bb_avg','avg'), ('bb_geq1_pct','>=1 %'), ('bb_geq2_pct','>=2 %')):
            line(f'{label:<12s} | {aggregate["v1"][k]:>8.2f} | {aggregate["sdc"][k]:>8.2f} | {aggregate["pros"][k]:>8.2f}')

        # Mahalanobis
        line('\n--- MAHALANOBIS DISTANCE TO PER-SLATE PRO CONSENSUS ---')
        line(f'(7-feature vector, lower = closer to pros)')
        line(f'{"System":<8s} | {"median":>8s} | {"mean":>8s}')
        line('-' * 40)
        for sys in ('v1', 'sdc'):
            line(f'{sys:<8s} | {aggregate[sys]["mahal_median"] or 0:>8.2f} | {aggregate[sys]["mahal_mean"] or 0:>8.2f}')

        # Fingerprint
        line('\n--- FINGERPRINT DISTANCE (median lineup nearest-pro, 9-feature) ---')
        line(f'{"System":<8s} | {"median":>8s} | {"mean":>8s}')
        line('-' * 40)
        for sys in ('v1', 'sdc'):
            line(f'{sys:<8s} | {aggregate[sys]["fingerprint_median"] or 0:>8.2f} | {aggregate[sys]["fingerprint_mean"] or 0:>8.2f}')

        # Per-slate band table
        line('\n--- PER-SLATE BAND DISTRIBUTION ---')
        line(f'{"Slate":<14s} | {"HP/HO":^25s} | {"HP/LO":^25s} | {"LP/HO":^25s} | {"LP/LO":^25s}')
        line(f'{"":<14s} | {"V1 / SDC / Pros":^25s} | {"V1 / SDC / Pros":^25s} | {"V1 / SDC / Pros":^25s} | {"V1 / SDC / Pros":^25s}')
        line('-' * 130)
        for r in per_slate_results:
            sl = r['slate']
            cells = []
            for b in ('HP/HO','HP/LO','LP/HO','LP/LO'):
                v1p = r['systems']['v1']['bands_pct'][b]
                sp  = r['systems']['sdc']['bands_pct'][b]
                pp  = r['systems']['pros']['bands_pct'][b]
                cells.append(f'{v1p:>5.1f}/{sp:>5.1f}/{pp:>5.1f}')
            line(f'{sl:<14s} | {cells[0]:^25s} | {cells[1]:^25s} | {cells[2]:^25s} | {cells[3]:^25s}')

        # Per-slate Mahalanobis & fingerprint
        line('\n--- PER-SLATE MAHAL & FINGERPRINT ---')
        line(f'{"Slate":<14s} | {"V1 mahal":>9s} | {"SDC mahal":>9s} | {"V1 fp":>7s} | {"SDC fp":>7s}')
        line('-' * 65)
        for r in per_slate_results:
            line(f'{r["slate"]:<14s} | {r["systems"]["v1"]["mahal"]:>9.2f} | {r["systems"]["sdc"]["mahal"]:>9.2f} | '
                 f'{r["systems"]["v1"]["fingerprint"]:>7.2f} | {r["systems"]["sdc"]["fingerprint"]:>7.2f}')

        line('\n' + '=' * 80)

    # ========================================================
    # WRITE JSON
    # ========================================================
    with open(RESULTS_PATH, 'w', encoding='utf-8') as f:
        json.dump({
            'aggregate': aggregate,
            'per_slate': per_slate_results,
        }, f, indent=2, default=str)

    print(f'\nWrote {TABLE_PATH}')
    print(f'Wrote {RESULTS_PATH}')


if __name__ == '__main__':
    main()
