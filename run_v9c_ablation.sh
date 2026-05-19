#!/bin/bash
# Run 6 v9-C ablation configs sequentially.

cd "$(dirname "$0")"
mkdir -p /tmp/argus_ablation

# Config 1: BASELINE — full v9-C
echo "=== ABLATION 1/6: full v9-C baseline ==="
ARGUS_RUN_TAG="abl_full" NODE_OPTIONS="--max-old-space-size=12288" \
  npx ts-node --transpile-only src/scripts/_argus_v9_research.ts \
  > /tmp/argus_ablation/abl_full.log 2>&1

# Config 2: NO ρ penalty
echo "=== ABLATION 2/6: no ρ penalty ==="
ARGUS_RUN_TAG="abl_no_rho" ARGUS_RHO_LAMBDA=0 NODE_OPTIONS="--max-old-space-size=12288" \
  npx ts-node --transpile-only src/scripts/_argus_v9_research.ts \
  > /tmp/argus_ablation/abl_no_rho.log 2>&1

# Config 3: NO combo prior
echo "=== ABLATION 3/6: no combo prior ==="
ARGUS_RUN_TAG="abl_no_combo" ARGUS_W_MULTI_BLEND=0 NODE_OPTIONS="--max-old-space-size=12288" \
  npx ts-node --transpile-only src/scripts/_argus_v9_research.ts \
  > /tmp/argus_ablation/abl_no_combo.log 2>&1

# Config 4: NO Mahal penalty
echo "=== ABLATION 4/6: no Mahal penalty ==="
ARGUS_RUN_TAG="abl_no_mahal" ARGUS_MAHAL_LAMBDA=0 NODE_OPTIONS="--max-old-space-size=12288" \
  npx ts-node --transpile-only src/scripts/_argus_v9_research.ts \
  > /tmp/argus_ablation/abl_no_mahal.log 2>&1

# Config 5: UNIFORM field (not GBM-weighted)
echo "=== ABLATION 5/6: uniform field ==="
ARGUS_RUN_TAG="abl_uniform_field" ARGUS_FIELD_MODE=uniform NODE_OPTIONS="--max-old-space-size=12288" \
  npx ts-node --transpile-only src/scripts/_argus_v9_research.ts \
  > /tmp/argus_ablation/abl_uniform_field.log 2>&1

# Config 6: PROJECTION-EV (replace sim with projection ranking)
echo "=== ABLATION 6/6: projection-EV ==="
ARGUS_RUN_TAG="abl_proj_ev" ARGUS_EV_MODE=proj NODE_OPTIONS="--max-old-space-size=12288" \
  npx ts-node --transpile-only src/scripts/_argus_v9_research.ts \
  > /tmp/argus_ablation/abl_proj_ev.log 2>&1

# Summary
echo ""
echo "================================================================"
echo "ABLATION SUMMARY (29-slate aggregate ROI)"
echo "================================================================"
for f in /tmp/argus_ablation/abl_*.log; do
  name=$(basename "$f" .log)
  roi=$(grep "Aggregate ROI:" "$f" | head -1 | sed 's/.*ROI: //')
  mahal=$(grep "Median Mahalanobis:" "$f" | head -1 | sed 's/.*Mahalanobis: //')
  prof=$(grep "Profitable slates:" "$f" | head -1 | sed 's/.*slates: //')
  echo "$name: ROI=$roi | mahal=$mahal | profitable=$prof"
done
