"""
Stage 4 development validation for slate-derived-research.

For each of 3 formulations (A, B, C), compute 5 benchmarks against pros on the
16 development slates. Outputs:
  - DEVELOPMENT_VALIDATION.md (human-readable per-formulation pass/fail with CIs)
  - validation_results.json (machine-readable)

Bonferroni-corrected α = 0.05 / 15 = 0.0033 (15 tests = 3 formulations × 5 benchmarks).
Bootstrap 10,000 resamples for CIs.

HOLDOUT IS NOT TOUCHED. Only the 16 development slates are read.
"""

import csv
import json
import math
import os
import random
import statistics
import sys
from collections import Counter, defaultdict

sys.stdout.reconfigure(encoding='utf-8')

DEV_SLATES = [
    '4-8-26', '4-12-26', '4-17-26', '4-18-26', '4-21-26', '4-22-26', '4-23-26',
    '4-24-26', '4-25-26', '4-25-26-early', '4-26-26', '4-27-26', '4-28-26',
    '4-29-26', '5-2-26-main', '5-3-26',
]

DUMP_PATH = r'C:\Users\colin\dfs opto\theory_dfs_v2\v1_pros_lineup_dump.json'
ROOT_DIR = r'C:\Users\colin\dfs opto\slate_derived_research'
DEV_RESULTS_DIR = os.path.join(ROOT_DIR, 'development_results')
RESULTS_PATH = os.path.join(ROOT_DIR, 'validation_results.json')
TABLE_PATH = os.path.join(ROOT_DIR, 'DEVELOPMENT_VALIDATION.md')

# Pro reference numbers (from dump, computed in Stage 0 inspection):
PRO_BAND_PCT = {'HP/HO': 38.7, 'HP/LO': 13.0, 'LP/HO': 15.2, 'LP/LO': 33.1}
PRO_PRIMARY_MEAN = 4.58
PRO_PRIMARY_5PLUS_PCT = 67.1  # primary >=5
PRO_BB_GEQ1_PCT = 21.6

# Pass thresholds per Stage 2D
B1_DEV_BAND_GAP = 8.0
B1_DEV_TOTAL_GAP = 25.0
B2_DEV_PRIMARY_MEAN_TOL = 0.30
B2_DEV_PRIMARY_5PLUS_TOL = 12.0
B3_DEV_BB_TOL = 7.0
B4_DEV_MAHAL_THRESHOLD = 2.25
B4_DEV_MIN_SLATES_PASS = 13
B5_DEV_FINGERPRINT_THRESHOLD = 1.10
B5_DEV_MIN_SLATES_PASS = 13

FINGERPRINT_FEATURES = [
    'primarySize', 'secondarySize', 'bringBack', 'maxGameStack',
    'numGames', 'numTeamsUsed', 'geoMeanOwnHit', 'salaryStd', 'salaryTopThree',
]
UNIVERSAL_METRICS = [
    'primarySize', 'secondarySize', 'bringBack', 'numGames', 'numTeamsUsed', 'geoMeanOwn', 'avgProj',
]


def load_dump():
    with open(DUMP_PATH, 'r', encoding='utf-8') as f:
        return json.load(f)


def parse_formulation_detail(formulation: str, slate: str):
    path = os.path.join(DEV_RESULTS_DIR, formulation, f'{slate}_detail.csv')
    if not os.path.exists(path):
        return None
    rows = []
    with open(path, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append({
                'primarySize': int(row['primarySize']),
                'secondarySize': int(row['secondarySize']),
                'primaryTeam': row.get('primaryTeam', '').upper(),
                'primaryOpp': row.get('primaryOpp', '').upper(),
                'bringBack': int(row['bringBack']),
                'projection': float(row['proj']),
                'geoMeanOwnHit': float(row['geoMeanOwnHit']),
                'geoMeanOwn': float(row['geoMeanOwnHit']),  # use hit-only as the canonical own metric
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
    return lu.get('geoMeanOwnHit') or 0


def band(p, o, med_p, med_o):
    hp = p >= med_p
    ho = o >= med_o
    if hp and ho: return 'HP/HO'
    if hp and not ho: return 'HP/LO'
    if not hp and ho: return 'LP/HO'
    return 'LP/LO'


def fingerprint_vec(lu):
    return [float(lu.get(f, 0) or 0) for f in FINGERPRINT_FEATURES]


def median_fingerprint_dist(portfolio_lus, pros, all_lus_for_scaling):
    if not portfolio_lus or not pros:
        return None
    # Standardize per-feature using std across all_lus pooled.
    cols = [[float(lu.get(f, 0) or 0) for lu in all_lus_for_scaling] for f in FINGERPRINT_FEATURES]
    stds = [statistics.pstdev(c) if len(c) > 1 and statistics.pstdev(c) > 1e-9 else 1.0 for c in cols]
    pro_vecs = []
    for p in pros:
        v = fingerprint_vec(p)
        pro_vecs.append([v[i] / stds[i] for i in range(len(v))])
    dists = []
    for lu in portfolio_lus:
        v = fingerprint_vec(lu)
        v = [v[i] / stds[i] for i in range(len(v))]
        # Manhattan to nearest pro
        best = float('inf')
        for pv in pro_vecs:
            d = sum(abs(v[i] - pv[i]) for i in range(len(v)))
            if d < best:
                best = d
        dists.append(best)
    return statistics.median(dists)


def mahal_dist(portfolio_lus, pros):
    if not portfolio_lus or len(pros) < 5:
        return None
    # Build mean & shrunk diagonal cov from pros.
    feats = UNIVERSAL_METRICS
    mat = []
    for p in pros:
        mat.append([float(p.get(f, 0) or 0) for f in feats])
    n = len(mat)
    means = [sum(row[i] for row in mat) / n for i in range(len(feats))]
    var = []
    for i in range(len(feats)):
        v = sum((row[i] - means[i]) ** 2 for row in mat) / max(1, n - 1)
        var.append(max(v, 1e-3))
    # Per-lineup Mahalanobis (diagonal)
    dists = []
    for lu in portfolio_lus:
        x = [float(lu.get(f, 0) or 0) for f in feats]
        d = sum((x[i] - means[i]) ** 2 / var[i] for i in range(len(feats)))
        dists.append(math.sqrt(d))
    return statistics.median(dists)


def bootstrap_ci(values, n_resamples=10000, alpha=0.05):
    if len(values) < 2:
        return (None, None)
    rng = random.Random(42)
    boots = []
    n = len(values)
    for _ in range(n_resamples):
        sample = [values[rng.randrange(n)] for _ in range(n)]
        boots.append(sum(sample) / n)
    boots.sort()
    lo_idx = int((alpha / 2) * n_resamples)
    hi_idx = int((1 - alpha / 2) * n_resamples)
    return (boots[lo_idx], boots[hi_idx])


def main():
    dump = load_dump()
    dump_by_slate = {entry['slate']: entry for entry in dump if entry.get('slate') in DEV_SLATES}

    if len(dump_by_slate) != len(DEV_SLATES):
        missing = set(DEV_SLATES) - set(dump_by_slate.keys())
        print(f'WARNING: missing dump entries for: {missing}')

    formulations = ['A', 'B', 'C']
    per_slate_results = {f: [] for f in formulations}
    aggregate = {f: {
        'bands': Counter(),
        'primary_sizes': Counter(),
        'bb_geq1': 0,
        'bb_total': 0,
        'mahal_per_slate': [],
        'fingerprint_per_slate': [],
        'compute_ms_per_slate': [],
        'n_total': 0,
        'primary_sum': 0,
    } for f in formulations}

    pros_aggregate = {
        'bands': Counter(), 'primary_sizes': Counter(), 'bb_geq1': 0, 'bb_total': 0, 'n_total': 0, 'primary_sum': 0,
    }

    # Load run summaries for compute time
    for f in formulations:
        sp = os.path.join(DEV_RESULTS_DIR, f, 'run_summary.json')
        if os.path.exists(sp):
            with open(sp, 'r') as fp:
                summ = json.load(fp)
            for r in summ:
                aggregate[f]['compute_ms_per_slate'].append(r.get('elapsed', 0))

    # Per-slate processing
    for slate in DEV_SLATES:
        if slate not in dump_by_slate:
            continue
        e = dump_by_slate[slate]
        pros = e['pros']

        # Pooled medians for band classification: pool pros + all 3 formulations.
        pooled_proj = [lu['projection'] for lu in pros]
        pooled_own = [safe_geo_own_hit(lu) for lu in pros]

        formulation_data = {}
        for f in formulations:
            data = parse_formulation_detail(f, slate)
            if data is None:
                continue
            formulation_data[f] = data
            for d in data:
                pooled_proj.append(d['projection'])
                pooled_own.append(d['geoMeanOwnHit'])

        med_p = statistics.median(pooled_proj)
        med_o = statistics.median(pooled_own)

        # Process pros
        for lu in pros:
            b = band(lu['projection'], safe_geo_own_hit(lu), med_p, med_o)
            pros_aggregate['bands'][b] += 1
            pros_aggregate['primary_sizes'][lu['primarySize']] += 1
            pros_aggregate['primary_sum'] += lu['primarySize']
            if lu['bringBack'] >= 1:
                pros_aggregate['bb_geq1'] += 1
            pros_aggregate['bb_total'] += 1
            pros_aggregate['n_total'] += 1

        # Process each formulation
        slate_record = {'slate': slate, 'med_p': med_p, 'med_o': med_o, 'systems': {}}
        for f in formulations:
            if f not in formulation_data:
                slate_record['systems'][f] = None
                continue
            data = formulation_data[f]
            slate_band_counts = Counter()
            slate_primary_counts = Counter()
            slate_bb_geq1 = 0
            slate_primary_sum = 0
            for d in data:
                b = band(d['projection'], d['geoMeanOwnHit'], med_p, med_o)
                slate_band_counts[b] += 1
                aggregate[f]['bands'][b] += 1
                slate_primary_counts[d['primarySize']] += 1
                aggregate[f]['primary_sizes'][d['primarySize']] += 1
                slate_primary_sum += d['primarySize']
                aggregate[f]['primary_sum'] += d['primarySize']
                if d['bringBack'] >= 1:
                    slate_bb_geq1 += 1
                    aggregate[f]['bb_geq1'] += 1
                aggregate[f]['bb_total'] += 1
                aggregate[f]['n_total'] += 1

            # Build comparable pro view of slate (with computed geoMeanOwn = geoMeanOwnHit)
            pros_for_metrics = [{
                'primarySize': lu['primarySize'],
                'secondarySize': lu['secondarySize'],
                'bringBack': lu['bringBack'],
                'numGames': lu['numGames'],
                'numTeamsUsed': lu['numTeamsUsed'],
                'geoMeanOwn': safe_geo_own_hit(lu),
                'avgProj': lu['projection'] / 10.0,
                'maxGameStack': lu['maxGameStack'],
                'salaryStd': lu['salaryStd'],
                'salaryTopThree': lu['salaryTopThree'],
                'geoMeanOwnHit': safe_geo_own_hit(lu),
                'projection': lu['projection'],
            } for lu in pros]
            mahal = mahal_dist(data, pros_for_metrics)
            fp = median_fingerprint_dist(data, pros_for_metrics, data + pros_for_metrics)
            if mahal is not None:
                aggregate[f]['mahal_per_slate'].append(mahal)
            if fp is not None:
                aggregate[f]['fingerprint_per_slate'].append(fp)

            slate_record['systems'][f] = {
                'n': len(data),
                'bands_pct': {b: slate_band_counts.get(b, 0) / max(1, len(data)) * 100 for b in PRO_BAND_PCT},
                'primary_pct': {ps: slate_primary_counts.get(ps, 0) / max(1, len(data)) * 100 for ps in [2,3,4,5,6]},
                'primary_mean': slate_primary_sum / max(1, len(data)),
                'bb_geq1_pct': slate_bb_geq1 / max(1, len(data)) * 100,
                'mahal': mahal,
                'fingerprint': fp,
            }

        per_slate_results['__slate_records'] = per_slate_results.get('__slate_records', [])
        per_slate_results['__slate_records'].append(slate_record)

    # Compute aggregate benchmarks per formulation.
    benchmark_results = {}
    for f in formulations:
        agg = aggregate[f]
        n = agg['n_total']
        if n == 0:
            benchmark_results[f] = None
            continue
        bands_pct = {b: agg['bands'].get(b, 0) / n * 100 for b in PRO_BAND_PCT}
        primary_5plus_pct = (agg['primary_sizes'].get(5, 0) + agg['primary_sizes'].get(6, 0)) / n * 100
        primary_mean = agg['primary_sum'] / n
        bb_pct = agg['bb_geq1'] / max(1, agg['bb_total']) * 100
        mahal_med = statistics.median(agg['mahal_per_slate']) if agg['mahal_per_slate'] else None
        fp_med = statistics.median(agg['fingerprint_per_slate']) if agg['fingerprint_per_slate'] else None
        compute_ms_mean = statistics.mean(agg['compute_ms_per_slate']) if agg['compute_ms_per_slate'] else None

        # Bootstrap CIs on per-slate Mahal & FP
        mahal_ci = bootstrap_ci(agg['mahal_per_slate']) if agg['mahal_per_slate'] else (None, None)
        fp_ci = bootstrap_ci(agg['fingerprint_per_slate']) if agg['fingerprint_per_slate'] else (None, None)

        # Benchmark 1: bands
        b1_gaps = {b: bands_pct[b] - PRO_BAND_PCT[b] for b in PRO_BAND_PCT}
        b1_max_gap = max(abs(g) for g in b1_gaps.values())
        b1_total_dev = sum(abs(g) for g in b1_gaps.values())
        b1_pass = (b1_max_gap < B1_DEV_BAND_GAP) and (b1_total_dev < B1_DEV_TOTAL_GAP)

        # Benchmark 2: stack
        b2_mean_diff = abs(primary_mean - PRO_PRIMARY_MEAN)
        b2_5plus_diff = abs(primary_5plus_pct - PRO_PRIMARY_5PLUS_PCT)
        b2_pass = (b2_mean_diff < B2_DEV_PRIMARY_MEAN_TOL) and (b2_5plus_diff < B2_DEV_PRIMARY_5PLUS_TOL)

        # Benchmark 3: bring-back
        b3_diff = abs(bb_pct - PRO_BB_GEQ1_PCT)
        b3_pass = b3_diff < B3_DEV_BB_TOL

        # Benchmark 4: Mahal — count slates with Mahal <= 2.25
        slates_pass_mahal = sum(1 for x in agg['mahal_per_slate'] if x <= B4_DEV_MAHAL_THRESHOLD)
        b4_pass = slates_pass_mahal >= B4_DEV_MIN_SLATES_PASS

        # Benchmark 5: Fingerprint
        slates_pass_fp = sum(1 for x in agg['fingerprint_per_slate'] if x <= B5_DEV_FINGERPRINT_THRESHOLD)
        b5_pass = slates_pass_fp >= B5_DEV_MIN_SLATES_PASS

        passed = sum([b1_pass, b2_pass, b3_pass, b4_pass, b5_pass])

        benchmark_results[f] = {
            'n_lineups': n,
            'bands_pct': bands_pct,
            'b1_gaps': b1_gaps,
            'b1_max_gap': b1_max_gap,
            'b1_total_dev': b1_total_dev,
            'b1_pass': b1_pass,
            'primary_mean': primary_mean,
            'primary_5plus_pct': primary_5plus_pct,
            'b2_mean_diff': b2_mean_diff,
            'b2_5plus_diff': b2_5plus_diff,
            'b2_pass': b2_pass,
            'bb_pct': bb_pct,
            'b3_diff': b3_diff,
            'b3_pass': b3_pass,
            'mahal_median': mahal_med,
            'mahal_ci': mahal_ci,
            'slates_pass_mahal': slates_pass_mahal,
            'b4_pass': b4_pass,
            'fingerprint_median': fp_med,
            'fingerprint_ci': fp_ci,
            'slates_pass_fp': slates_pass_fp,
            'b5_pass': b5_pass,
            'passed_count': passed,
            'compute_ms_mean': compute_ms_mean,
            'mahal_per_slate': agg['mahal_per_slate'],
            'fingerprint_per_slate': agg['fingerprint_per_slate'],
        }

    # Pros aggregate (for reference)
    n_pros = pros_aggregate['n_total']
    pros_bands_pct = {b: pros_aggregate['bands'].get(b, 0) / max(1, n_pros) * 100 for b in PRO_BAND_PCT}
    pros_primary_5plus = (pros_aggregate['primary_sizes'].get(5, 0) + pros_aggregate['primary_sizes'].get(6, 0)) / max(1, n_pros) * 100
    pros_primary_mean = pros_aggregate['primary_sum'] / max(1, n_pros)
    pros_bb_pct = pros_aggregate['bb_geq1'] / max(1, pros_aggregate['bb_total']) * 100

    # Write results
    out = {
        'dev_slates': DEV_SLATES,
        'pros_dev_aggregate': {
            'n': n_pros,
            'bands_pct': pros_bands_pct,
            'primary_mean': pros_primary_mean,
            'primary_5plus_pct': pros_primary_5plus,
            'bb_geq1_pct': pros_bb_pct,
        },
        'formulations': benchmark_results,
        'per_slate': per_slate_results.get('__slate_records', []),
    }
    with open(RESULTS_PATH, 'w', encoding='utf-8') as f:
        json.dump(out, f, indent=2, default=str)

    # Write Markdown report
    write_md(out)
    print(f'\nWrote: {RESULTS_PATH}')
    print(f'Wrote: {TABLE_PATH}')


def write_md(out):
    lines = []
    lines.append('# DEVELOPMENT VALIDATION — Stage 4')
    lines.append('')
    lines.append('**Bonferroni-corrected α = 0.05 / 15 = 0.0033** (15 tests = 3 formulations × 5 benchmarks).')
    lines.append('Pass criteria are deterministic thresholds (Stage 2D), not p-values; CIs are reported for transparency.')
    lines.append('')
    lines.append('## Pro reference (16 dev slates only)')
    lines.append('')
    pa = out['pros_dev_aggregate']
    lines.append(f"  - N pros: {pa['n']}")
    lines.append(f"  - Bands: HP/HO {pa['bands_pct']['HP/HO']:.1f}% | HP/LO {pa['bands_pct']['HP/LO']:.1f}% | LP/HO {pa['bands_pct']['LP/HO']:.1f}% | LP/LO {pa['bands_pct']['LP/LO']:.1f}%")
    lines.append(f"  - Primary stack mean: {pa['primary_mean']:.2f}; %≥5: {pa['primary_5plus_pct']:.1f}%")
    lines.append(f"  - Bring-back ≥1 rate: {pa['bb_geq1_pct']:.1f}%")
    lines.append('')
    lines.append('## Per-formulation benchmark results')
    lines.append('')
    lines.append('| Formulation | B1 Bands | B2 Stack | B3 BringBack | B4 Mahal | B5 Fingerprint | # Passed |')
    lines.append('|-------------|----------|----------|--------------|----------|----------------|----------|')
    for f in ['A', 'B', 'C']:
        r = out['formulations'].get(f)
        if r is None:
            lines.append(f'| {f} | — | — | — | — | — | 0 |')
            continue
        b1 = 'PASS' if r['b1_pass'] else 'FAIL'
        b2 = 'PASS' if r['b2_pass'] else 'FAIL'
        b3 = 'PASS' if r['b3_pass'] else 'FAIL'
        b4 = 'PASS' if r['b4_pass'] else 'FAIL'
        b5 = 'PASS' if r['b5_pass'] else 'FAIL'
        lines.append(f'| {f} | {b1} | {b2} | {b3} | {b4} | {b5} | **{r["passed_count"]}/5** |')
    lines.append('')
    lines.append('### Detail per formulation')
    lines.append('')
    for f in ['A', 'B', 'C']:
        r = out['formulations'].get(f)
        if r is None:
            continue
        lines.append(f'#### Formulation {f}')
        lines.append('')
        lines.append(f'  - N lineups (all dev slates): {r["n_lineups"]}')
        lines.append('')
        lines.append('**Benchmark 1 (Band distribution):**')
        for b in ['HP/HO', 'HP/LO', 'LP/HO', 'LP/LO']:
            gap = r['b1_gaps'][b]
            lines.append(f'  - {b}: {r["bands_pct"][b]:.1f}% (pro {PRO_BAND_PCT[b]:.1f}%, gap {gap:+.1f}pp)')
        lines.append(f'  - Max gap: {r["b1_max_gap"]:.2f}pp (threshold <{B1_DEV_BAND_GAP}); total dev: {r["b1_total_dev"]:.1f}pp (threshold <{B1_DEV_TOTAL_GAP})')
        lines.append(f'  - **{("PASS" if r["b1_pass"] else "FAIL")}**')
        lines.append('')
        lines.append('**Benchmark 2 (Stack distribution):**')
        lines.append(f'  - Primary mean: {r["primary_mean"]:.3f} (pro {PRO_PRIMARY_MEAN:.2f}, diff {r["b2_mean_diff"]:+.3f}, threshold <{B2_DEV_PRIMARY_MEAN_TOL})')
        lines.append(f'  - %≥5: {r["primary_5plus_pct"]:.1f}% (pro {PRO_PRIMARY_5PLUS_PCT:.1f}%, diff {r["b2_5plus_diff"]:+.1f}pp, threshold <{B2_DEV_PRIMARY_5PLUS_TOL})')
        lines.append(f'  - **{("PASS" if r["b2_pass"] else "FAIL")}**')
        lines.append('')
        lines.append('**Benchmark 3 (Bring-back):**')
        lines.append(f'  - BB ≥1 rate: {r["bb_pct"]:.1f}% (pro {PRO_BB_GEQ1_PCT:.1f}%, diff {r["b3_diff"]:+.1f}pp, threshold <{B3_DEV_BB_TOL})')
        lines.append(f'  - **{("PASS" if r["b3_pass"] else "FAIL")}**')
        lines.append('')
        lines.append('**Benchmark 4 (Mahalanobis to pros):**')
        lines.append(f'  - Median across 16 dev slates: {r["mahal_median"]:.3f}')
        if r['mahal_ci'] != (None, None):
            lines.append(f'  - 95% bootstrap CI: [{r["mahal_ci"][0]:.3f}, {r["mahal_ci"][1]:.3f}]')
        lines.append(f'  - Slates with Mahal ≤ {B4_DEV_MAHAL_THRESHOLD}: {r["slates_pass_mahal"]}/{len(r["mahal_per_slate"])} (threshold ≥ {B4_DEV_MIN_SLATES_PASS})')
        lines.append(f'  - **{("PASS" if r["b4_pass"] else "FAIL")}**')
        lines.append('')
        lines.append('**Benchmark 5 (Fingerprint distance):**')
        lines.append(f'  - Median across 16 dev slates: {r["fingerprint_median"]:.3f}')
        if r['fingerprint_ci'] != (None, None):
            lines.append(f'  - 95% bootstrap CI: [{r["fingerprint_ci"][0]:.3f}, {r["fingerprint_ci"][1]:.3f}]')
        lines.append(f'  - Slates with fingerprint ≤ {B5_DEV_FINGERPRINT_THRESHOLD}: {r["slates_pass_fp"]}/{len(r["fingerprint_per_slate"])} (threshold ≥ {B5_DEV_MIN_SLATES_PASS})')
        lines.append(f'  - **{("PASS" if r["b5_pass"] else "FAIL")}**')
        lines.append('')
        if r['compute_ms_mean'] is not None:
            lines.append(f'  - Mean compute time per slate: {r["compute_ms_mean"]:.0f} ms')
        lines.append('')

    with open(TABLE_PATH, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines))


if __name__ == '__main__':
    main()
