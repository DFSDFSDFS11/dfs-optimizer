# DFS Optimizer CLI

Professional-grade Daily Fantasy Sports lineup optimizer with game theory selection.

## Features

- **True Mathematical Optimization**: Branch-and-bound algorithm guarantees finding the maximum projection lineup
- **Game Theory Selection**: Leverage scoring, ownership analysis, and diversity optimization
- **SaberSim Compatible**: Reads SaberSim CSV exports and outputs SaberSim-ready CSV files
- **Multi-Site Support**: DraftKings NBA Classic, DraftKings NFL Showdown, FanDuel NBA
- **Always 5,000 Lineups**: Outputs exactly 5,000 optimized lineups for mass multi-entry

## Installation

```bash
npm install
npm run build
```

## Usage

```bash
# Basic usage (DraftKings NBA Classic)
node dist/run.js --input ./sabersim_export.csv

# Full options
node dist/run.js \
  --site dk \
  --sport nba \
  --contest classic \
  --input ./sabersim.csv \
  --pool 20000 \
  --output ./final_lineups.csv \
  --max-exposure 0.6 \
  --min-salary 48000
```

## CLI Options

| Option | Description | Default |
|--------|-------------|---------|
| `-i, --input <file>` | Input CSV file (SaberSim export) | Required |
| `-o, --output <file>` | Output CSV file | `./exported_lineups_5000.csv` |
| `-s, --site <site>` | DFS site (dk, fd) | `dk` |
| `-p, --sport <sport>` | Sport (nba, nfl) | `nba` |
| `-c, --contest <type>` | Contest type (classic, showdown) | `classic` |
| `--pool <size>` | Pool size to generate | `20000` |
| `--max-exposure <pct>` | Max player exposure (0-1) | `0.6` |
| `--min-salary <amount>` | Minimum salary to use | Site default |
| `--projection-drop <pts>` | Max drop from optimal | `5` |

## Input CSV Format

The optimizer expects SaberSim CSV exports with these columns:
- `DFS ID` or `ID` - Player identifier
- `Name` - Player name
- `Roster Position` or `Pos` - Position eligibility (e.g., PG/SG)
- `Team` - Team abbreviation
- `Salary` - Player salary
- `My Proj` or `SS Proj` - Fantasy point projection
- `My Own` or `Adj Own` - Projected ownership percentage

## Output Format

The output CSV is formatted for direct SaberSim import:
- One row per lineup
- Player IDs in position order
- Includes lineup projection and ownership totals

## Algorithm Overview

### Phase 1: Pool Generation
1. Parse player projections and ownership from CSV
2. Build constraint matrices for position eligibility
3. Run branch-and-bound optimization to find true maximum
4. Generate pool of top lineups within projection threshold

### Phase 2: Game Theory Selection
1. Analyze pool for player/combo exposures
2. Score each lineup on:
   - Projection (normalized to max)
   - Leverage (rarity of combinations)
   - Ownership (lower is better for GPP)
   - Diversity (difference from selected)
3. Iteratively select 5,000 lineups with dynamic weighting
4. Enforce exposure constraints throughout

## Contest Rules

### DraftKings NBA Classic
- Salary Cap: $50,000
- Roster: PG, SG, SF, PF, C, G, F, UTIL (8 players)
- G slot: PG or SG eligible
- F slot: SF or PF eligible
- UTIL slot: Any position

### DraftKings NFL Showdown
- Salary Cap: $50,000
- Roster: 1 CPT + 5 FLEX (6 players)
- Captain: 1.5x salary and projection
- Same player cannot be both CPT and FLEX

### FanDuel NBA
- Salary Cap: $60,000
- Roster: PG, PG, SG, SG, SF, SF, PF, PF, C (9 players)

## License

MIT
