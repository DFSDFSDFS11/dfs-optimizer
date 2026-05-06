# T1 — Per-lineup structural fingerprint

## Distance distribution (Manhattan, scale-normalized per slate)

V1 lineups: 3300, Pro lineups: 16800

| Percentile | Distance |
|---|---|
| p25 | 0.58 |
| median | 0.99 |
| p75 | 1.64 |
| p90 | 2.48 |
| p95 | 3.17 |
| max | 9.41 |

## Tail thickness

Lineups with distance > 3x median: 200 (6.1%)

## Per-slate medians

| Slate | n_v1 | n_pros | median | p75 | p90 | max |
|---|---|---|---|---|---|---|
| 4-6-26 | 150 | 900 | 0.81 | 1.36 | 2.28 | 5.90 |
| 4-8-26 | 150 | 600 | 1.32 | 1.89 | 3.01 | 4.60 |
| 4-12-26 | 150 | 750 | 0.60 | 1.15 | 1.69 | 3.49 |
| 4-14-26 | 150 | 900 | 0.95 | 1.64 | 2.25 | 6.19 |
| 4-15-26 | 150 | 900 | 0.69 | 1.28 | 1.74 | 3.14 |
| 4-17-26 | 150 | 900 | 0.82 | 1.20 | 1.84 | 6.95 |
| 4-18-26 | 150 | 600 | 1.06 | 1.60 | 2.76 | 5.46 |
| 4-19-26 | 150 | 900 | 0.92 | 1.35 | 1.82 | 6.40 |
| 4-20-26 | 150 | 900 | 0.92 | 1.40 | 2.06 | 3.77 |
| 4-21-26 | 150 | 600 | 0.97 | 1.41 | 1.93 | 4.68 |
| 4-22-26 | 150 | 900 | 0.63 | 1.15 | 1.81 | 3.32 |
| 4-23-26 | 150 | 450 | 1.58 | 2.64 | 4.12 | 6.15 |
| 4-24-26 | 150 | 750 | 0.90 | 1.68 | 2.73 | 5.99 |
| 4-25-26 | 150 | 750 | 1.02 | 1.51 | 2.07 | 4.14 |
| 4-25-26-early | 150 | 600 | 1.29 | 2.04 | 2.52 | 5.48 |
| 4-26-26 | 150 | 900 | 0.82 | 1.31 | 2.35 | 7.11 |
| 4-27-26 | 150 | 900 | 0.85 | 1.38 | 1.71 | 5.67 |
| 4-28-26 | 150 | 900 | 0.97 | 1.54 | 2.09 | 3.35 |
| 4-29-26 | 150 | 900 | 1.01 | 1.85 | 2.50 | 5.25 |
| 5-1-26 | 150 | 750 | 1.38 | 1.95 | 2.91 | 9.41 |
| 5-2-26 | 150 | 450 | 2.05 | 3.03 | 3.68 | 4.95 |
| 5-2-26-main | 150 | 600 | 1.18 | 2.00 | 3.11 | 6.99 |

## Top 15 farthest V1 lineups (potential outliers)

| Slate | Distance | Stack | BB | GameStack | Games | GeoOwn | Proj | FinishPct | PrimaryTeam | Pitchers |
|---|---|---|---|---|---|---|---|---|---|---|
| 5-1-26 | 9.41 | 5-3 | 3 | 8 | 3 | 10.21 | 96.52 | 0.2838 | ATL | Christian Scott, German Marquez |
| 4-26-26 | 7.11 | 5-3 | 0 | 5 | 3 | 3.79 | 86.94 | 0.0667 | STL | Jose Quintana, Luis Gil |
| 5-2-26-main | 6.99 | 5-3 | 0 | 6 | 2 | 3.31 | 84.84 | 0.0186 | COL | Roki Sasaki, Chase Dollander |
| 4-17-26 | 6.95 | 5-2 | 0 | 6 | 4 | 1.88 | 86.76 | 0.3078 | CIN | Kyle Leahy, Brandon Williamson |
| 5-1-26 | 6.82 | 5-3 | 3 | 8 | 3 | 12.96 | 96.94 | 0.7774 | ATL | Eury Perez, Walbert Urena |
| 4-17-26 | 6.78 | 5-2 | 0 | 5 | 4 | 4.0 | 81.72 | 0.0152 | ATH | Brandon Williamson, Tomoyuki Sugano |
| 5-1-26 | 6.75 | 5-3 | 3 | 8 | 3 | 9.36 | 102.84 | 0.5857 | COL | German Marquez, Cole Ragans |
| 4-19-26 | 6.40 | 4-1 | 1 | 5 | 6 | 1.62 | 83.76 | 0.4721 | BAL | Robbie Ray, Cole Ragans |
| 4-26-26 | 6.36 | 4-3 | 0 | 4 | 4 | 3.25 | 91.79 | 0.0929 | ATH | Jose Quintana, Carmen Mlodzinski |
| 4-14-26 | 6.19 | 4-2 | 2 | 6 | 3 | 1.68 | 86.53 | 0.9048 | NYM | Reid Detmers, Mick Abel |
| 4-23-26 | 6.15 | 4-1 | 1 | 5 | 6 | 1.75 | 84.12 | 0.2116 | MIL | Ryan Feltner, Tyler Glasnow |
| 4-17-26 | 6.11 | 5-1 | 0 | 6 | 5 | 2.13 | 86.89 | 0.1579 | CIN | Coleman Crow, Brandon Williamson |
| 4-26-26 | 6.02 | 5-3 | 0 | 6 | 3 | 1.93 | 87.42 | 0.2181 | STL | Carmen Mlodzinski, Michael McGreevy |
| 4-24-26 | 5.99 | 5-3 | 3 | 8 | 3 | 8.62 | 99.91 | 0.5767 | WSH | Paul Skenes, Emmet Sheehan |
| 4-6-26 | 5.90 | 5-2 | 2 | 7 | 4 | 4.3 | 86.55 | 0.6714 | SF | Justin Wrobleski, Joe Ryan |
