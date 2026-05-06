# Stage 5 — Hitter-Set Selection Patterns

We checked, for each qualifying (entity, slate, team, stackSize) cell, whether the entity's
single most-frequently-used hitter set matched one of four mechanical selection rules:

1. **Top-N by SS Proj**: the top-`N` highest-projection confirmed hitters from the team's pool
2. **Top-N by anti-ownership** (lowest `Adj Own` `N`)
3. **Top-N by leverage** (`SS Proj / max(Adj Own, 1)`)
4. **Contiguous batting order**: top-1 set's batting orders form a run (e.g., orders {2,3,4,5})

(Categories may overlap.)

## Pattern frequencies (proportion of qualifying cells where top-1 set matches the rule)

| Entity | n | top_proj | anti_own | leverage | contig_order | other |
|---|---:|---:|---:|---:|---:|---:|
| V1 | 266 | 6.0% | 0.0% | 0.8% | 12.0% | 85.0% |
| b_heals152 | 228 | 9.6% | 0.0% | 0.4% | 17.5% | 78.9% |
| bgreseth | 175 | 12.0% | 0.0% | 1.1% | 14.3% | 82.3% |
| needlunchmoney | 250 | 7.2% | 0.0% | 0.4% | 13.6% | 84.0% |
| nerdytenor | 251 | 8.4% | 0.0% | 0.4% | 14.7% | 81.7% |
| shaidyadvice | 182 | 4.4% | 0.0% | 0.0% | 7.7% | 90.1% |
| shipmymoney | 222 | 8.6% | 0.0% | 0.0% | 18.5% | 78.8% |
| youdacao | 142 | 3.5% | 0.0% | 0.0% | 7.7% | 90.8% |
| zroth2 | 242 | 7.0% | 0.0% | 0.0% | 16.9% | 80.2% |

## Interpretation

None of the four mechanical rules captures more than ~18% of pro top-1 picks. The dominant
category for every entity is "other" (78-91%). Specifically:

- **No one is anti-own raw.** Lowest-owned-N matches 0.0% across all entities; pros are not
  picking primary stacks by lowest ownership.
- **Pure top-projection N is rare** (3-12%). Pros pick the chalk-est set somewhat more than V1
  (median pro ~8% vs V1 6%), but it's a small fraction of cases.
- **Contiguous batting order** is the most common matched rule. Pros match it ~14% (median),
  V1 matches it 12% — a small gap, but in the same direction as the concentration finding.
- The pattern is mostly idiosyncratic to slate / matchup / pro-specific reads, not reducible
  to simple ranked-list rules.

## What this means for the within-stack hypothesis

The concentration gap exists at the hitter-set level (Stage 3-4), but the **mechanism** of
which 4-or-5-set pros pick is not a clean projection / ownership / leverage / batting-order
rule. It is presumably driven by per-slate, per-team factors — pitcher matchup, park, lineup
order specifics, weather, news — that pros internalize qualitatively.

## Caveats

- "Top-N by SS Proj" uses SaberSim projections; pros may use different projection sources, so
  a pro's actual top-N-by-their-projection might match more often than this measurement shows.
- "Active hitter pool" was defined as `Status == Confirmed`. Some teams may have late
  confirmations or scratches not reflected here.
- Small per-cell N (~5-15 lineups typical) means top-1 sets are noisily defined; with more
  lineups per team the patterns might tighten.
