"""
Set Transformer for Sequential Portfolio Construction

Stages 1-9: data prep, model architecture, training, validation, comparison, ablations.
Output: report.md + saved model + decision verdict.

Run: python run_pipeline.py
"""

import os
import sys
import json
import math
import random
import numpy as np
import pandas as pd
from pathlib import Path

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import Dataset, DataLoader

# UTF-8 stdout for Windows
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')

ROOT = Path(__file__).parent
DEVICE = torch.device('cuda' if torch.cuda.is_available() else 'cpu')

# Reproducibility
SEED = 42
random.seed(SEED); np.random.seed(SEED); torch.manual_seed(SEED)
if DEVICE.type == 'cuda': torch.cuda.manual_seed_all(SEED)

HELD_OUT = {'4-8-26', '4-21-26', '4-19-26', '4-24-26'}

REPORT = []
def log(msg=''):
    print(msg)
    REPORT.append(str(msg))

log(f'# Set Transformer for Sequential Portfolio Construction')
log('')
log(f'Device: {DEVICE}, threads: {torch.get_num_threads()}')
log(f'Held-out slates: {sorted(HELD_OUT)}')
log('')

# ============================================================
# STAGE 1: Load + prepare data
# ============================================================
log('## Stage 1: Data Prep')
log('')

seq_df = pd.read_csv(ROOT / 'sequence_lineups.csv')
cand_df = pd.read_csv(ROOT / 'candidate_pool.csv')
slate_df = pd.read_csv(ROOT / 'slate_features.csv')
with open(ROOT / 'feature_names.json') as f:
    fn = json.load(f)
LU_FEATS = fn['lineup']
SLATE_FEATS = fn['slate']

log(f'Sequence rows: {len(seq_df):,} (pro lineups in their submission order)')
log(f'Candidate pool rows: {len(cand_df):,}')
log(f'Slates: {len(slate_df)}')
log(f'Lineup features: {len(LU_FEATS)}')
log(f'Slate features: {len(SLATE_FEATS)}')

# Standardize features (mean/std from training slates only)
train_seq = seq_df[~seq_df.is_holdout.astype(bool)]
train_cand = cand_df[cand_df.slate.isin(train_seq.slate.unique())]
mu_lu = train_cand[LU_FEATS].mean().values
sd_lu = train_cand[LU_FEATS].std().values + 1e-6
mu_slate = slate_df[~slate_df.is_holdout.astype(bool)][SLATE_FEATS].mean().values
sd_slate = slate_df[~slate_df.is_holdout.astype(bool)][SLATE_FEATS].std().values + 1e-6

def standardize_lu(x): return (x - mu_lu) / sd_lu
def standardize_slate(x): return (x - mu_slate) / sd_slate

# Build per-slate cand pool feature arrays + hash→index lookup
slate_cand_feats: dict = {}      # slate -> np.array (N, 33)
slate_cand_hashes: dict = {}     # slate -> list[hash]
slate_hash_to_idx: dict = {}     # slate -> {hash: idx}
slate_feat_vecs: dict = {}        # slate -> np.array (8,)
for sl in cand_df.slate.unique():
    sub = cand_df[cand_df.slate == sl]
    feats = standardize_lu(sub[LU_FEATS].values).astype(np.float32)
    hashes = sub['lineup_hash'].tolist()
    slate_cand_feats[sl] = feats
    slate_cand_hashes[sl] = hashes
    slate_hash_to_idx[sl] = {h: i for i, h in enumerate(hashes)}
    sf_row = slate_df[slate_df.slate == sl].iloc[0]
    slate_feat_vecs[sl] = standardize_slate(sf_row[SLATE_FEATS].values).astype(np.float32)

# Pro portfolios per slate (sorted by order_index)
pro_portfolios: dict = {}  # (slate, pro) -> list[(order_idx, hash, feats)]
for (sl, pro), grp in seq_df.groupby(['slate', 'pro']):
    grp = grp.sort_values('order_index')
    feats_arr = standardize_lu(grp[LU_FEATS].values).astype(np.float32)
    pro_portfolios[(sl, pro)] = {
        'hashes': grp['lineup_hash'].tolist(),
        'feats': feats_arr,
        'is_holdout': grp.iloc[0].is_holdout,
    }

# Inner validation slates: pick 2 from training (NOT held-out)
TRAIN_SLATES = sorted(set(seq_df.slate.unique()) - HELD_OUT)
INNER_VAL_SLATES = ['4-22-26', '4-26-26']  # picked deterministically; large+diverse
TRAIN_ONLY_SLATES = [s for s in TRAIN_SLATES if s not in INNER_VAL_SLATES]
log(f'Train-only slates: {len(TRAIN_ONLY_SLATES)} ({TRAIN_ONLY_SLATES})')
log(f'Inner-val slates: {INNER_VAL_SLATES}')
log(f'Held-out slates: {sorted(HELD_OUT)}')
log('')

# ============================================================
# STAGE 2: Model
# ============================================================
log('## Stage 2: Model Architecture')
log('')

class SetTransformerEncoder(nn.Module):
    """Simple Set Transformer encoder using multi-head attention + pooling.
    Lee et al 2019 ISAB simplified: SAB (Set Attention Block) followed by PMA (Pooling by Multi-head Attention)."""
    def __init__(self, in_dim, hidden_dim=64, num_heads=4, num_layers=2):
        super().__init__()
        self.proj = nn.Linear(in_dim, hidden_dim)
        self.layers = nn.ModuleList([
            nn.MultiheadAttention(hidden_dim, num_heads, dropout=0.3, batch_first=True)
            for _ in range(num_layers)
        ])
        self.norms = nn.ModuleList([nn.LayerNorm(hidden_dim) for _ in range(num_layers)])
        self.ffns = nn.ModuleList([
            nn.Sequential(nn.Linear(hidden_dim, hidden_dim*2), nn.ReLU(), nn.Dropout(0.3), nn.Linear(hidden_dim*2, hidden_dim))
            for _ in range(num_layers)
        ])
        self.norms2 = nn.ModuleList([nn.LayerNorm(hidden_dim) for _ in range(num_layers)])
        # PMA: pool to single vector via attention to a learned query
        self.pool_query = nn.Parameter(torch.randn(1, 1, hidden_dim))
        self.pool_attn = nn.MultiheadAttention(hidden_dim, num_heads, dropout=0.3, batch_first=True)
        self.pool_norm = nn.LayerNorm(hidden_dim)

    def forward(self, X, mask=None):
        # X: (B, S, in_dim), mask: (B, S) where True=padding
        h = self.proj(X)
        if X.size(1) == 0:
            return torch.zeros(X.size(0), h.size(-1), device=X.device)
        for attn, n1, ffn, n2 in zip(self.layers, self.norms, self.ffns, self.norms2):
            attn_out, _ = attn(h, h, h, key_padding_mask=mask)
            h = n1(h + attn_out)
            h = n2(h + ffn(h))
        # Pool
        B = h.size(0)
        q = self.pool_query.expand(B, -1, -1)
        pooled, _ = self.pool_attn(q, h, h, key_padding_mask=mask)
        pooled = self.pool_norm(pooled.squeeze(1))
        return pooled

class SlateContextEncoder(nn.Module):
    def __init__(self, in_dim, out_dim=32):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(in_dim, 64), nn.LayerNorm(64), nn.ReLU(), nn.Dropout(0.3),
            nn.Linear(64, out_dim),
        )
    def forward(self, x): return self.net(x)

class CandidateScorer(nn.Module):
    def __init__(self, lu_dim, port_dim, slate_dim, hidden=128):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(lu_dim + port_dim + slate_dim, hidden), nn.LayerNorm(hidden), nn.ReLU(), nn.Dropout(0.3),
            nn.Linear(hidden, hidden), nn.LayerNorm(hidden), nn.ReLU(), nn.Dropout(0.3),
            nn.Linear(hidden, 1),
        )
    def forward(self, lu_feat, port_emb, slate_emb):
        # lu_feat: (B, K, lu_dim)  K candidates per example
        # port_emb: (B, port_dim)
        # slate_emb: (B, slate_dim)
        B, K, _ = lu_feat.shape
        port_exp = port_emb.unsqueeze(1).expand(-1, K, -1)
        slate_exp = slate_emb.unsqueeze(1).expand(-1, K, -1)
        x = torch.cat([lu_feat, port_exp, slate_exp], dim=-1)
        return self.net(x).squeeze(-1)  # (B, K)

class SetTransformerModel(nn.Module):
    def __init__(self, lu_dim, slate_dim, port_dim=64, slate_emb_dim=32):
        super().__init__()
        self.portfolio_encoder = SetTransformerEncoder(lu_dim, hidden_dim=port_dim)
        self.slate_encoder = SlateContextEncoder(slate_dim, slate_emb_dim)
        self.scorer = CandidateScorer(lu_dim, port_dim, slate_emb_dim)
    def forward(self, port_lus, port_mask, slate_feat, cand_lus):
        port_emb = self.portfolio_encoder(port_lus, mask=port_mask)
        slate_emb = self.slate_encoder(slate_feat)
        return self.scorer(cand_lus, port_emb, slate_emb)

LU_DIM = len(LU_FEATS)
SLATE_DIM = len(SLATE_FEATS)
model = SetTransformerModel(LU_DIM, SLATE_DIM).to(DEVICE)
n_params = sum(p.numel() for p in model.parameters())
log(f'Model parameter count: {n_params:,}')
log('')

# ============================================================
# STAGE 3: Training
# ============================================================
log('## Stage 3: Training')
log('')

# Build training examples: for each (slate, pro), for each k in [0, 149], example is (port[:k], next=port[k])
# We'll batch by (slate, pro, k) triples.
def build_examples(slate_list):
    examples = []
    for (sl, pro), data in pro_portfolios.items():
        if sl not in slate_list: continue
        n = len(data['hashes'])
        for k in range(n):
            examples.append((sl, pro, k))
    return examples

train_examples = build_examples(TRAIN_ONLY_SLATES)
inner_val_examples = build_examples(INNER_VAL_SLATES)
log(f'Training examples (k=0..149 per pro-slate): {len(train_examples):,}')
log(f'Inner-val examples: {len(inner_val_examples):,}')
log('')

NEG_PER_EXAMPLE = 200

def make_batch(examples, batch_size, slate_data_map):
    """Yield batches of training examples. Each batch element: (port_feats, port_mask, slate_feat, cand_feats, target_idx).
    Per-batch padding to max-port-length within batch."""
    random.shuffle(examples)
    for start in range(0, len(examples), batch_size):
        batch = examples[start:start+batch_size]
        # Determine max k in this batch
        max_k = max(b[2] for b in batch) + 1  # +1 because PyTorch attn doesn't like S=0; we add a dummy
        port_arr = np.zeros((len(batch), max(1, max_k), LU_DIM), dtype=np.float32)
        port_mask = np.ones((len(batch), max(1, max_k)), dtype=bool)  # True = padding
        slate_arr = np.zeros((len(batch), SLATE_DIM), dtype=np.float32)
        cand_arr = np.zeros((len(batch), NEG_PER_EXAMPLE + 1, LU_DIM), dtype=np.float32)
        target_idx = np.zeros(len(batch), dtype=np.int64)
        for bi, (sl, pro, k) in enumerate(batch):
            data = pro_portfolios[(sl, pro)]
            # Portfolio = first k lineups
            if k > 0:
                port_arr[bi, :k] = data['feats'][:k]
                port_mask[bi, :k] = False
            else:
                # k=0: empty portfolio. Use single-zero token, mask the rest.
                # (no real lineups, model relies on slate context)
                port_arr[bi, 0] = 0.0
                port_mask[bi, 0] = False  # not a pad — a "start of sequence" token
            slate_arr[bi] = slate_feat_vecs[sl]
            # Positive: lineup at position k
            pos_hash = data['hashes'][k]
            pos_feat = data['feats'][k]
            # Negatives: lineups in this slate's pool that are NOT in this pro's full portfolio
            pro_hash_set = set(data['hashes'])
            pool = slate_cand_feats[sl]
            pool_hashes = slate_cand_hashes[sl]
            # Sample 200 negatives
            neg_indices = []
            attempts = 0
            while len(neg_indices) < NEG_PER_EXAMPLE and attempts < NEG_PER_EXAMPLE * 4:
                idx = random.randint(0, len(pool_hashes) - 1)
                if pool_hashes[idx] in pro_hash_set: attempts += 1; continue
                neg_indices.append(idx)
                attempts += 1
            # If pool too small, fill with random selections (may include prior duplicates)
            while len(neg_indices) < NEG_PER_EXAMPLE:
                neg_indices.append(random.randint(0, len(pool_hashes) - 1))
            # Place positive at index 0
            cand_arr[bi, 0] = pos_feat
            for ni, neg_idx in enumerate(neg_indices):
                cand_arr[bi, 1 + ni] = pool[neg_idx]
            target_idx[bi] = 0
        yield (
            torch.from_numpy(port_arr).to(DEVICE),
            torch.from_numpy(port_mask).to(DEVICE),
            torch.from_numpy(slate_arr).to(DEVICE),
            torch.from_numpy(cand_arr).to(DEVICE),
            torch.from_numpy(target_idx).to(DEVICE),
        )

def evaluate(model, examples, batch_size=32):
    model.eval()
    total_loss, n_batches, n_correct, n_total = 0, 0, 0, 0
    with torch.no_grad():
        for port, mask, slate, cand, tgt in make_batch(examples, batch_size, slate_cand_feats):
            scores = model(port, mask, slate, cand)
            loss = F.cross_entropy(scores, tgt)
            total_loss += loss.item(); n_batches += 1
            preds = scores.argmax(dim=-1)
            n_correct += (preds == tgt).sum().item()
            n_total += tgt.size(0)
    model.train()
    return total_loss / max(1, n_batches), n_correct / max(1, n_total)

# Adjust epochs for CPU budget — spec says reduce to 25 if no GPU
SMOKE = '--smoke' in sys.argv
EPOCHS = 2 if SMOKE else (25 if DEVICE.type == 'cpu' else 50)
LR = 5e-4
BATCH_SIZE = 16 if SMOKE else 32
log(f'Training: {EPOCHS} epochs, batch_size={BATCH_SIZE}, lr={LR}, device={DEVICE.type}')
log(f'Estimate: {len(train_examples) // BATCH_SIZE} steps/epoch × {EPOCHS} = {len(train_examples) // BATCH_SIZE * EPOCHS:,} total steps')
log('')

optimizer = torch.optim.Adam(model.parameters(), lr=LR, betas=(0.9, 0.98), weight_decay=1e-4)
scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=EPOCHS)

best_val_loss = float('inf')
patience = 5
no_improve_count = 0
best_state = None
import time
t_start = time.time()
for epoch in range(EPOCHS):
    model.train()
    epoch_loss, epoch_batches = 0, 0
    for port, mask, slate, cand, tgt in make_batch(train_examples, BATCH_SIZE, slate_cand_feats):
        optimizer.zero_grad()
        scores = model(port, mask, slate, cand)
        loss = F.cross_entropy(scores, tgt)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()
        epoch_loss += loss.item(); epoch_batches += 1
    scheduler.step()
    val_loss, val_acc = evaluate(model, inner_val_examples)
    elapsed = (time.time() - t_start) / 60
    log(f'  Epoch {epoch+1:2d}/{EPOCHS}  train_loss={epoch_loss/epoch_batches:.4f}  val_loss={val_loss:.4f}  val_acc={val_acc:.4f}  ({elapsed:.1f}m)')
    if val_loss < best_val_loss - 1e-4:
        best_val_loss = val_loss
        no_improve_count = 0
        best_state = {k: v.cpu().clone() for k, v in model.state_dict().items()}
    else:
        no_improve_count += 1
        if no_improve_count >= patience:
            log(f'  Early stopping at epoch {epoch+1} (no improvement for {patience} epochs)')
            break

if best_state is not None:
    model.load_state_dict(best_state)
log(f'')
log(f'Best inner val loss: {best_val_loss:.4f}')
torch.save(model.state_dict(), ROOT / 'set_transformer_best.pt')
log(f'Saved model to set_transformer_best.pt')
log('')

# ============================================================
# STAGE 4: Cross-pro generalization
# ============================================================
log('## Stage 4: Cross-Pro Generalization (precision-at-150 across pros, training slates)')
log('')

def predict_top150(slate, model_, fixed_portfolio=None, exclude_hashes=None):
    """Return top-150 lineup hashes from slate's pool by model score with empty portfolio.
    fixed_portfolio: list of hashes to seed the portfolio context (for sequential prediction).
    exclude_hashes: hashes to exclude from candidates."""
    model_.eval()
    pool_feats = slate_cand_feats[slate]
    pool_hashes = slate_cand_hashes[slate]
    slate_vec = slate_feat_vecs[slate]
    # Portfolio = empty (single zero token, unmasked)
    if fixed_portfolio:
        port_idx = [slate_hash_to_idx[slate][h] for h in fixed_portfolio if h in slate_hash_to_idx[slate]]
        port_feats = pool_feats[port_idx] if port_idx else np.zeros((1, LU_DIM), dtype=np.float32)
    else:
        port_feats = np.zeros((1, LU_DIM), dtype=np.float32)
    port_t = torch.from_numpy(port_feats).unsqueeze(0).to(DEVICE)
    port_mask_t = torch.zeros((1, port_feats.shape[0]), dtype=torch.bool).to(DEVICE)
    slate_t = torch.from_numpy(slate_vec).unsqueeze(0).to(DEVICE)
    # Score in chunks
    scores = []
    chunk = 1024
    with torch.no_grad():
        for i in range(0, len(pool_feats), chunk):
            cand_t = torch.from_numpy(pool_feats[i:i+chunk]).unsqueeze(0).to(DEVICE)
            s = model_(port_t, port_mask_t, slate_t, cand_t).squeeze(0).cpu().numpy()
            scores.extend(s.tolist())
    scores = np.array(scores)
    # Apply exclusion
    if exclude_hashes:
        ex = set(exclude_hashes)
        for i, h in enumerate(pool_hashes):
            if h in ex: scores[i] = -1e9
    # Top 150
    top_idx = np.argsort(-scores)[:150]
    return [pool_hashes[i] for i in top_idx], scores

# Cross-pro precision-at-150 on training slates
ALL_PROS = sorted(set(seq_df.pro.unique()))
cross_pro_precision = {}
for held_pro in ALL_PROS:
    precisions = []
    for sl in TRAIN_ONLY_SLATES:
        if (sl, held_pro) not in pro_portfolios: continue
        actual_hashes = set(pro_portfolios[(sl, held_pro)]['hashes'])
        if len(actual_hashes) < 30: continue
        top150, _ = predict_top150(sl, model)
        hits = len([h for h in top150 if h in actual_hashes])
        precisions.append(hits / 150)
    if precisions:
        cross_pro_precision[held_pro] = np.mean(precisions)
        log(f'  {held_pro:18s}  mean precision-at-150 across {len(precisions)} slates: {cross_pro_precision[held_pro]:.4f}')

cp = np.array(list(cross_pro_precision.values()))
log('')
log(f'**Mean cross-pro precision-at-150: {cp.mean():.4f} ± {cp.std():.4f}**')
gate_4_pass = cp.mean() >= 0.45 and cp.std() <= 0.10
gate_4_min = cp.mean() >= 0.40
log(f'Gate (mean ≥ 0.45 AND std ≤ 0.10): {"PASS" if gate_4_pass else "FAIL"}')
log(f'Sub-gate (mean ≥ 0.40): {"PASS" if gate_4_min else "FAIL"}')
log('')

# ============================================================
# STAGE 5: Held-out validation
# ============================================================
log('## Stage 5: Held-out slate validation')
log('')

held_out_precisions = []
for sl in sorted(HELD_OUT):
    for pro in ALL_PROS:
        if (sl, pro) not in pro_portfolios: continue
        actual_hashes = set(pro_portfolios[(sl, pro)]['hashes'])
        if len(actual_hashes) < 30: continue
        top150, _ = predict_top150(sl, model)
        hits = len([h for h in top150 if h in actual_hashes])
        prec = hits / 150
        held_out_precisions.append(prec)
        log(f'  {sl:15s}  {pro:18s}  precision-at-150 = {prec:.4f}  (hits={hits}/150)')

h = np.array(held_out_precisions)
log('')
log(f'**Mean held-out precision-at-150: {h.mean():.4f}**')
gate_5_pass = h.mean() >= 0.40
log(f'Gate (≥ 0.40): {"PASS" if gate_5_pass else "FAIL"}')
log('')

# ============================================================
# STAGE 6: Build portfolios on held-out slates (constrained construction)
# ============================================================
log('## Stage 6: Portfolio construction on held-out slates')
log('')

GAMMA = 5
TEAM_CAP = 0.26
N = 150
MAX_EXP_HITTER = 0.21
MAX_EXP_PITCHER = 0.41

# Need to know primary team / player position for constraints — load from candidate_pool feature engineering
# We saved hash + slate but not player metadata. Need a join with the full pool data.
# Workaround: re-export hash → metadata mapping
import csv

# Build hash → players info for each held-out slate from the original CSV
def load_holdout_metadata(slate, projections_csv, pool_csv):
    """Return {hash: {pids, primary_team, hitter_set, pitcher_set, salary}}."""
    # Use pandas to read pool — keep cols PG, SG, SF, PF, C, G, F, UTIL OR P,P,C,1B,2B,3B,SS,OF,OF,OF
    # MLB roster: P, P, C, 1B, 2B, 3B, SS, OF, OF, OF
    # Read raw CSV
    df = pd.read_csv(pool_csv)
    # Determine pid columns: first 10 columns are positions
    pos_cols = list(df.columns[:10])
    # Read projections CSV for player team/positions
    proj_df = pd.read_csv(projections_csv)
    # Find DK ID column
    id_col = next((c for c in proj_df.columns if 'DFS ID' in c.upper() or 'ID' == c.upper()), None)
    name_col = 'Name' if 'Name' in proj_df.columns else proj_df.columns[1]
    team_col = 'Team' if 'Team' in proj_df.columns else None
    pos_col = 'Pos' if 'Pos' in proj_df.columns else None
    if id_col is None or team_col is None or pos_col is None:
        return None
    # Build pid → (team, pos)
    pid_meta = {}
    for _, r in proj_df.iterrows():
        pid_meta[str(r[id_col])] = (r[team_col], str(r[pos_col]))
    # Parse each lineup
    out = {}
    for _, row in df.iterrows():
        pids = [str(int(row[c])) for c in pos_cols if pd.notna(row[c])]
        if len(pids) != 10: continue
        h = '|'.join(sorted(pids))
        team_counts = {}; pitcher_set = set(); hitter_set = set()
        for pid in pids:
            meta = pid_meta.get(pid)
            if not meta: continue
            team, pos = meta
            if 'P' in pos:
                pitcher_set.add(pid)
            else:
                hitter_set.add(pid)
                team_counts[team] = team_counts.get(team, 0) + 1
        primary = max(team_counts, key=team_counts.get) if team_counts else None
        out[h] = {'pids': pids, 'primary': primary, 'hitter_set': hitter_set, 'pitcher_set': pitcher_set}
    return out

DATA_DIR = Path('C:/Users/colin/dfs opto')
HELDOUT_FILES = {
    '4-8-26':  ('4-8-26projections.csv',  '4-8-26sspool.csv'),
    '4-21-26': ('4-21-26projections.csv', '4-21-26sspool.csv'),
    '4-19-26': ('4-19-26projections.csv', '4-19-26sspool.csv'),
    '4-24-26': ('4-24-26projections.csv', '4-24-26sspool.csv'),
}
holdout_meta = {}
for sl, (proj_f, pool_f) in HELDOUT_FILES.items():
    meta = load_holdout_metadata(sl, DATA_DIR / proj_f, DATA_DIR / pool_f)
    if meta is None:
        log(f'  WARNING: could not load metadata for {sl}'); continue
    holdout_meta[sl] = meta

def build_portfolio_seq(slate, model_):
    """Sequential greedy construction: at each step, score all candidates given current portfolio, pick best valid."""
    pool_feats = slate_cand_feats[slate]
    pool_hashes = slate_cand_hashes[slate]
    slate_vec = slate_feat_vecs[slate]
    meta = holdout_meta.get(slate, {})

    selected: list = []  # list of (hash, idx)
    selected_pid_sets: list = []
    player_count: dict = {}
    team_count: dict = {}
    max_per_team = max(1, int(N * TEAM_CAP))
    cap_h = int(MAX_EXP_HITTER * N) + 1
    cap_p = int(MAX_EXP_PITCHER * N) + 1

    model_.eval()
    slate_t = torch.from_numpy(slate_vec).unsqueeze(0).to(DEVICE)

    for step in range(N):
        # Build portfolio embedding once per step
        if selected:
            port_idx = [s[1] for s in selected]
            port_arr = pool_feats[port_idx]
        else:
            port_arr = np.zeros((1, LU_DIM), dtype=np.float32)
        port_t = torch.from_numpy(port_arr).unsqueeze(0).to(DEVICE)
        port_mask_t = torch.zeros((1, port_arr.shape[0]), dtype=torch.bool).to(DEVICE)
        # Score full pool in chunks
        scores = np.zeros(len(pool_feats), dtype=np.float32)
        chunk = 2048
        with torch.no_grad():
            for i in range(0, len(pool_feats), chunk):
                cand_t = torch.from_numpy(pool_feats[i:i+chunk]).unsqueeze(0).to(DEVICE)
                s = model_(port_t, port_mask_t, slate_t, cand_t).squeeze(0).cpu().numpy()
                scores[i:i+chunk] = s
        # Apply exclusion (already-selected) + sort
        sel_hashes = set(s[0] for s in selected)
        order = np.argsort(-scores)
        added = False
        for idx in order:
            h = pool_hashes[idx]
            if h in sel_hashes: continue
            m = meta.get(h)
            if not m: continue
            # Player exposure
            ok = True
            for pid in m['hitter_set']:
                if player_count.get(pid, 0) >= cap_h: ok = False; break
            if not ok: continue
            for pid in m['pitcher_set']:
                if player_count.get(pid, 0) >= cap_p: ok = False; break
            if not ok: continue
            # Team cap
            if m['primary'] and team_count.get(m['primary'], 0) >= max_per_team: continue
            # Pairwise overlap
            pid_set = set(m['pids'])
            ok2 = True
            for prev in selected_pid_sets:
                inter = len(pid_set & prev)
                if inter > GAMMA: ok2 = False; break
            if not ok2: continue
            # Add
            selected.append((h, idx))
            selected_pid_sets.append(pid_set)
            for pid in m['pids']: player_count[pid] = player_count.get(pid, 0) + 1
            if m['primary']: team_count[m['primary']] = team_count.get(m['primary'], 0) + 1
            added = True
            break
        if not added:
            log(f'    {slate} step {step}: no valid candidate; relaxing constraints')
            for relax_g in [6, 7, 8, 9]:
                for idx in order:
                    h = pool_hashes[idx]
                    if h in sel_hashes: continue
                    m = meta.get(h)
                    if not m: continue
                    pid_set = set(m['pids'])
                    ok = True
                    for prev in selected_pid_sets:
                        if len(pid_set & prev) > relax_g: ok = False; break
                    if not ok: continue
                    selected.append((h, idx))
                    selected_pid_sets.append(pid_set)
                    for pid in m['pids']: player_count[pid] = player_count.get(pid, 0) + 1
                    if m['primary']: team_count[m['primary']] = team_count.get(m['primary'], 0) + 1
                    added = True
                    break
                if added: break
            if not added:
                log(f'    {slate} could not extend at step {step} — stopping at {len(selected)} lineups')
                break
    return [s[0] for s in selected]

import time
st_portfolios = {}
for sl in sorted(HELD_OUT):
    if sl not in holdout_meta: continue
    t0 = time.time()
    log(f'  Building ST portfolio for {sl}...')
    portf = build_portfolio_seq(sl, model)
    st_portfolios[sl] = portf
    log(f'    {sl}: {len(portf)} lineups in {(time.time()-t0):.1f}s')

# Save
with open(ROOT / 'st_portfolios.json', 'w') as f:
    json.dump(st_portfolios, f)
log('')

# ============================================================
# STAGE 7 & 8 deferred to TS post-processor (for ROI + Mahalanobis comparison)
# ============================================================
log('## Stage 7-8: Hermes-A comparison + context-dependence')
log('')
log('Stages 7 + 8 (gate 5 context dependence) deferred to TS post-processor to compute ROI/Mahalanobis')
log('See ml_st_compare.ts')
log('')

# But we can compute context-dependence here (gate 5) since we have the model.
# Compare features of lineups selected at step ~50 vs step ~100 across held-out slates.

log('### Stage 8 Gate 5: context-dependence (KL div between step-50 and step-100 distributions)')
log('')

# Aggregate features at step 50 vs step 100 across all held-out slates
step50_feats, step100_feats = [], []
for sl, portf in st_portfolios.items():
    if len(portf) < 110: continue
    pool_h2i = slate_hash_to_idx[sl]
    pool = slate_cand_feats[sl]
    s50 = portf[40:60]; s100 = portf[90:110]
    for h in s50:
        if h in pool_h2i: step50_feats.append(pool[pool_h2i[h]])
    for h in s100:
        if h in pool_h2i: step100_feats.append(pool[pool_h2i[h]])

if step50_feats and step100_feats:
    s50 = np.array(step50_feats); s100 = np.array(step100_feats)
    # Per-feature symmetric KL approx using gaussian moments (mu, sd)
    # KL(N(m1,s1) || N(m2,s2)) = log(s2/s1) + (s1^2 + (m1-m2)^2) / (2*s2^2) - 0.5
    kls = []
    for i in range(s50.shape[1]):
        m1, sd1 = s50[:, i].mean(), s50[:, i].std() + 1e-3
        m2, sd2 = s100[:, i].mean(), s100[:, i].std() + 1e-3
        kl_12 = math.log(sd2/sd1) + (sd1**2 + (m1-m2)**2) / (2*sd2**2) - 0.5
        kl_21 = math.log(sd1/sd2) + (sd2**2 + (m1-m2)**2) / (2*sd1**2) - 0.5
        kls.append((kl_12 + kl_21) / 2)
    mean_kl = float(np.mean(np.abs(kls)))
    log(f'  Mean symmetric KL (per-feature avg, step50 vs step100): {mean_kl:.4f}')
    gate_8_pass = mean_kl > 0.15
    log(f'  Gate (KL > 0.15): {"PASS" if gate_8_pass else "FAIL"}')
else:
    log('  Insufficient data for KL computation')
    mean_kl = 0
    gate_8_pass = False
log('')

# ============================================================
# Save preliminary report (Stage 7 ROI/Mahalanobis pending)
# ============================================================
log('## Preliminary Decision (Stages 4, 5, 8 only — Stage 7 pending TS post-process)')
log('')
log(f'Stage 4 (cross-pro precision ≥ 0.45, std ≤ 0.10): {"PASS" if gate_4_pass else "FAIL"}')
log(f'Stage 5 (held-out precision ≥ 0.40): {"PASS" if gate_5_pass else "FAIL"}')
log(f'Stage 8 Gate 5 (context KL > 0.15): {"PASS" if gate_8_pass else "FAIL"}')
log('')

prelim_pass = gate_4_pass and gate_5_pass and gate_8_pass
log(f'**Preliminary: {"PROCEED to Stage 7" if prelim_pass else "FAIL — document and stop"}**')
log('')

# ============================================================
# STAGE 9: Ablations (only run if base model trained successfully)
# ============================================================
log('## Stage 9: Ablations')
log('')

class NoContextModel(nn.Module):
    """Ablation 1: portfolio context replaced with zeros."""
    def __init__(self, lu_dim, slate_dim, port_dim=64, slate_emb_dim=32):
        super().__init__()
        self.slate_encoder = SlateContextEncoder(slate_dim, slate_emb_dim)
        self.scorer = CandidateScorer(lu_dim, port_dim, slate_emb_dim)
        self.port_dim = port_dim
    def forward(self, port_lus, port_mask, slate_feat, cand_lus):
        B = cand_lus.size(0)
        port_emb = torch.zeros(B, self.port_dim, device=cand_lus.device)
        slate_emb = self.slate_encoder(slate_feat)
        return self.scorer(cand_lus, port_emb, slate_emb)

class NoSlateModel(nn.Module):
    """Ablation 2: slate context replaced with zeros."""
    def __init__(self, lu_dim, slate_dim, port_dim=64, slate_emb_dim=32):
        super().__init__()
        self.portfolio_encoder = SetTransformerEncoder(lu_dim, hidden_dim=port_dim)
        self.scorer = CandidateScorer(lu_dim, port_dim, slate_emb_dim)
        self.slate_emb_dim = slate_emb_dim
    def forward(self, port_lus, port_mask, slate_feat, cand_lus):
        port_emb = self.portfolio_encoder(port_lus, mask=port_mask)
        B = cand_lus.size(0)
        slate_emb = torch.zeros(B, self.slate_emb_dim, device=cand_lus.device)
        return self.scorer(cand_lus, port_emb, slate_emb)

def quick_train(model_class, epochs=10):
    m = model_class(LU_DIM, SLATE_DIM).to(DEVICE)
    opt = torch.optim.Adam(m.parameters(), lr=LR, weight_decay=1e-4)
    for e in range(epochs):
        m.train()
        for port, mask, slate, cand, tgt in make_batch(train_examples, BATCH_SIZE, slate_cand_feats):
            opt.zero_grad()
            scores = m(port, mask, slate, cand)
            loss = F.cross_entropy(scores, tgt)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(m.parameters(), 1.0)
            opt.step()
    val_loss, val_acc = evaluate(m, inner_val_examples)
    return val_loss, val_acc, m

# Skip ablations if main training was already long; do shorter (10 epoch) ablation runs
ABLATION_EPOCHS = 2 if SMOKE else 10
log(f'Ablation 1: No portfolio context ({ABLATION_EPOCHS}-epoch quick train)')
val_loss_1, val_acc_1, _ = quick_train(NoContextModel, epochs=ABLATION_EPOCHS)
log(f'  No-context val_loss={val_loss_1:.4f}  val_acc={val_acc_1:.4f}')
log('')

log(f'Ablation 2: No slate context ({ABLATION_EPOCHS}-epoch quick train)')
val_loss_2, val_acc_2, _ = quick_train(NoSlateModel, epochs=ABLATION_EPOCHS)
log(f'  No-slate val_loss={val_loss_2:.4f}  val_acc={val_acc_2:.4f}')
log('')

# Compare to baseline at same epoch count
log(f'Ablation 0: Full model ({ABLATION_EPOCHS}-epoch quick train, baseline)')
val_loss_0, val_acc_0, _ = quick_train(SetTransformerModel, epochs=ABLATION_EPOCHS)
log(f'  Full val_loss={val_loss_0:.4f}  val_acc={val_acc_0:.4f}')
log('')

log('### Ablation summary')
log('')
log('| Ablation | val_loss | val_acc | gap to full |')
log('|---|---|---|---|')
log(f'| Full model (10ep) | {val_loss_0:.4f} | {val_acc_0:.4f} | baseline |')
log(f'| No portfolio context | {val_loss_1:.4f} | {val_acc_1:.4f} | {val_acc_0-val_acc_1:+.4f} |')
log(f'| No slate context | {val_loss_2:.4f} | {val_acc_2:.4f} | {val_acc_0-val_acc_2:+.4f} |')
log('')

# Save report
with open(ROOT / 'report.md', 'w', encoding='utf-8') as f:
    f.write('\n'.join(REPORT))
log(f'Report saved to {ROOT}/report.md')
print('\n=== PIPELINE COMPLETE (Stages 1-6, 8, 9). Run ml-st-compare.ts for Stage 7 ROI comparison.')
