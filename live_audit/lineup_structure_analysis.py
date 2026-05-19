"""
Lineup-level structural analysis (per Ch.8 of theory doc: 'Exposures don't matter. Lineups do.')

For each pro's reconstructed 150-lineup portfolio, classify lineups by:
  - Stack shape: primary team stack size + secondary stack size (e.g. "5-3", "5-2", "4-4")
  - Bring-back: pitcher + opposing-team hitter count (the "I have P, also stacked vs P's team")
  - Cheap-stud pattern: 1+ players at top-3 salary + 1+ players at bottom-3 salary

Then aggregate per pro and across pros to identify:
  - Most-used STACK SHAPES (the lineup-structure archetype)
  - PAIR co-occurrences in winning lineups
  - VARIANCE BAND distribution (proj-sum × own-sum scatter)

Compare to a sample Atlas portfolio (from theory_dfs_argus_atlas_preslate_*_detailed.csv).
"""
import csv
import json
import os
import re
from collections import Counter, defaultdict
import statistics

LIVE_AUDIT = "C:/Users/colin/Projects/dfs-optimizer/live_audit"

POS_RE = r'(?:P|C|1B|2B|3B|SS|OF|CPT|FLEX|UTIL|PG|SG|SF|PF|G|F)'

def parse_lineup(s):
    if not s:
        return []
    s = s.strip()
    parts = re.split(r'\s+(?=' + POS_RE + r'\s+\w)', s)
    out = []
    for p in parts:
        m = re.match(r'^(' + POS_RE + r')\s+(.+)$', p.strip())
        if m:
            out.append((m.group(1), m.group(2).strip()))
    return out

def classify_stack_shape(positions):
    """Given list of (pos, name), classify the lineup's stack shape.
    Returns string like '5-3' or '5-2' or '4-4'. Pitchers excluded from team count."""
    # We don't have team data in lineup strings — we'd need to look up players by name.
    # For now, just count distinct names (proxy: assume pos+name unique). Actually need team data.
    # Defer — return None and add team lookup later
    return None

def main():
    # Load reconstructed pro portfolios
    data = json.load(open(os.path.join(LIVE_AUDIT, 'pro_portfolios_detailed.json')))

    # We don't have player team data in the JSON. Need to add it from the player_meta.
    # But player_meta only has %drafted/fpts/pos — no team. Need to merge from projection files.

    # First, let's just count lineup-level pair frequencies — that's the cleanest "exposures don't matter, lineups do" check.

    # For each pro, build pair-frequency distribution
    print("=== TOP PAIRS per pro (winning portfolios) ===\n")
    per_pro_pairs = {}
    for cid, c in sorted(data.items(), key=lambda x: x[1]['date'])[-12:]:  # last 12 contests
        date = c['date']
        top_pros = [p for p in c['top_pros'] if p['n_entries'] >= 100]
        if not top_pros:
            continue
        pro = top_pros[0]
        # We have exposures (single-player), but need to reconstruct PAIRS from the original lineups.
        # exposures dict isn't enough — we need each individual lineup.
        # The pro_portfolios.py only saved single-player exposures, not lineup contents.
        # Need to re-extract from contest standings.
        pass

    print("Need to re-extract pro lineups with full lineup contents (not just exposures).")
    print("Run extract_pro_lineups.py to build this data.")

if __name__ == '__main__':
    main()
