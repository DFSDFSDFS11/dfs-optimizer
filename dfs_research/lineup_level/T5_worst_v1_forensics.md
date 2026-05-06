# T5 — Worst-V1-lineup forensics across 23 slates

V1 lineups analyzed: 3450, worst-bucket: 674, best-bucket: 674

## Feature comparison (worst vs best V1 lineups)

| Feature | Worst mean | Best mean | Δ (worst−best) |
|---|---|---|---|
| primarySize | 4.94 | 4.95 | -0.02 |
| secondarySize | 1.89 | 1.86 | +0.02 |
| bringBack | 0.98 | 1.04 | -0.06 |
| maxGameStack | 6.03 | 6.09 | -0.06 |
| numGames | 4.03 | 4.01 | +0.01 |
| numTeamsUsed | 5.17 | 5.18 | -0.01 |
| geoMeanOwnHit | 5.92 | 7.45 | -1.52 |
| salaryStd | 2050.92 | 2075.37 | -24.45 |
| salaryTopThree | 22715.28 | 22844.81 | -129.53 |
| projection | 92.81 | 97.11 | -4.30 |
| salaryTotal | 49443.47 | 49453.71 | -10.24 |

## Archetype distribution

| Archetype | Worst % | Best % | Δ pp |
|---|---|---|---|
| 4-stack/BB0 | 3.1% | 2.8% | +0.3 |
| 4-stack/BB1 | 1.6% | 1.2% | +0.4 |
| 4-stack/BB2 | 0.6% | 0.6% | +0.0 |
| 4-stack/BB3 | 1.0% | 0.1% | +0.9 |
| 5-stack/BB0 | 35.6% | 31.2% | +4.5 |
| 5-stack/BB1 | 29.8% | 31.9% | -2.1 |
| 5-stack/BB2 | 22.0% | 27.2% | -5.2 |
| 5-stack/BB3 | 6.2% | 5.0% | +1.2 |

## Pitcher attribution (top 10 disproportionate to WORST)

| Pitcher | in worst | in best | worst−best |
|---|---|---|---|
| Bryan Woo | 38 | 9 | +29 |
| Nolan McLean | 47 | 21 | +26 |
| Framber Valdez | 27 | 3 | +24 |
| Logan Gilbert | 59 | 37 | +22 |
| Cristopher Sanchez | 22 | 4 | +18 |
| Lance McCullers Jr. | 16 | 3 | +13 |
| Connelly Early | 14 | 1 | +13 |
| Nathan Eovaldi | 16 | 3 | +13 |
| Jack Flaherty | 11 | 0 | +11 |
| Taj Bradley | 11 | 3 | +8 |

## Pitcher attribution (top 10 disproportionate to BEST)

| Pitcher | in worst | in best | worst−best |
|---|---|---|---|
| Spencer Arrighetti | 8 | 23 | -15 |
| Tyler Glasnow | 4 | 20 | -16 |
| Chris Sale | 39 | 57 | -18 |
| Shohei Ohtani | 26 | 44 | -18 |
| Bailey Ober | 1 | 19 | -18 |
| Max Meyer | 4 | 22 | -18 |
| Jose Soriano | 42 | 61 | -19 |
| Freddy Peralta | 18 | 37 | -19 |
| Max Fried | 6 | 26 | -20 |
| Will Warren | 9 | 34 | -25 |

## Primary stack team attribution (top 10 to WORST)

| Team | in worst | in best | worst−best |
|---|---|---|---|
| SF | 28 | 6 | +22 |
| PHI | 40 | 19 | +21 |
| SD | 41 | 23 | +18 |
| COL | 54 | 38 | +16 |
| CWS | 35 | 21 | +14 |
| WSH | 33 | 20 | +13 |
| MIA | 23 | 12 | +11 |
| NYM | 20 | 12 | +8 |
| BOS | 17 | 10 | +7 |
| TEX | 15 | 9 | +6 |

## Forensic examples (worst V1 lineup per slate)

| Slate | finishPct | proj | actual | primary | stack | BB | geoOwn | pitchers |
|---|---|---|---|---|---|---|---|---|
| 4-6-26 | 0.0277 | 92.7 | 45.3 | SEA | 4 | 2 | 3.69 | Max Scherzer, Chris Sale |
| 4-8-26 | 0.0014 | 91.3 | 15.45 | NYY | 5 | 2 | 15.22 | Brady Singer, Framber Valdez |
| 4-12-26 | 0.0161 | 91.2 | 59.75 | ATH | 5 | 0 | 0.69 | Tarik Skubal, Andrew Abbott |
| 4-14-26 | 0.0075 | 97.5 | 33.45 | SEA | 5 | 1 | 3.60 | Ryan Weathers, Sonny Gray |
| 4-15-26 | 0.0102 | 102.9 | 63.5 | NYY | 5 | 1 | 10.29 | Dylan Cease, Sean Burke |
| 4-17-26 | 0.0030 | 84.3 | 44 | SD | 5 | 1 | 2.64 | Tomoyuki Sugano, Logan Gilbert |
| 4-18-26 | 0.0032 | 84.2 | 36.7 | COL | 5 | 0 | 1.37 | Lance McCullers Jr., Nathan Eovaldi |
| 4-19-26 | 0.0018 | 79.7 | 26.4 | WSH | 5 | 0 | 2.33 | Shane McClanahan, Trevor Rogers |
| 4-20-26 | 0.0033 | 101.2 | 45.65 | COL | 5 | 2 | 7.86 | Jesse Scholtens, Reid Detmers |
| 4-21-26 | 0.0311 | 94.0 | 44.2 | LAA | 5 | 2 | 9.34 | Michael Wacha, Logan Gilbert |
| 4-22-26 | 0.0022 | 107.7 | 36.4 | SD | 5 | 1 | 8.61 | Zack Littell, Ranger Suarez |
| 4-23-26 | 0.0041 | 84.7 | 31.1 | LAD | 4 | 1 | 1.77 | Matt Waldron, Michael Soroka |
| 4-24-26 | 0.0036 | 86.6 | 30.75 | MIL | 5 | 0 | 0.51 | Gavin Williams, Noah Cameron |
| 4-25-26 | 0.0026 | 86.1 | 36.2 | LAA | 5 | 0 | 3.82 | Jeffrey Springs, Colin Rea |
| 4-25-26-early | 0.0065 | 90.7 | 31.4 | CLE | 5 | 1 | 3.66 | Bryan Woo, Robbie Ray |
| 4-26-26 | 0.0070 | 88.5 | 40 | WSH | 5 | 0 | 2.42 | Aaron Nola, Emerson Hancock |
| 4-27-26 | 0.0195 | 99.2 | 37 | PIT | 5 | 1 | 3.98 | Dylan Cease, Yoshinobu Yamamoto |
| 4-28-26 | 0.0018 | 87.0 | 28.950000000000003 | WSH | 5 | 0 | 3.22 | Payton Tolle, Aaron Civale |
| 4-29-26 | 0.0011 | 93.3 | 24.4 | PIT | 5 | 0 | 15.57 | Brandon Williamson, David Peterson |
| 5-1-26 | 0.0067 | 83.2 | 42.7 | LAA | 5 | 0 | 1.67 | Mike Burrows, Joey Cantillo |
| 5-2-26 | 0.0082 | 94.7 | 24.3 | PHI | 5 | 1 | 12.84 | Rhett Lowder, Kyle Harrison |
| 5-2-26-main | 0.0048 | 91.1 | 30.25 | LAD | 5 | 2 | 6.65 | Chase Dollander, Reid Detmers |
| 5-2-26-night | 0.0230 | 97.4 | 53.650000000000006 | KC | 5 | 3 | 22.73 | Nolan McLean, Reid Detmers |
