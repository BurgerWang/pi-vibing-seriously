---
name: stock-selection-research
description: Run stock-selection research end to end — point-in-time universe, cross-sectional features, ranking and grouping, exposure control, portfolio construction, rebalancing, turnover, benchmark, and return attribution. Use for cross-sectional equity strategy work.
---

# Stock Selection Research

Goal: a cross-sectional strategy that is defined, tested, and reported
without survivorship or look-ahead contamination, and evaluated against a
benchmark it can actually be compared to.

## Workflow

1. **Universe** — define it point-in-time: membership as of each rebalance
   date, including names that later delisted. A universe built from
   today's listings has survivorship bias; the bias flatters history.
2. **Data** — verify delisting handling and corporate actions first
   (`skill:market-data-integrity`); selection research is unforgiving of
   both.
3. **Features** — cross-sectional features computed from data available at
   the signal timestamp (see references for feature hygiene).
4. **Rank and group** — score each name, rank cross-sectionally, assign to
   groups (quantiles/deciles). Ranking is the core of selection; the
   grouping must be defined before looking at results.
5. **Control exposures** — industry and market-cap exposures of the
   portfolio vs the benchmark: neutralization is a choice, but the exposure
   must be measured and reported.
6. **Construct the portfolio** — weights (equal, score-weighted, cap-
   weighted), position caps, and the cash rule.
7. **Rebalance** — calendar or event driven; define the rebalance timestamp
   and the execution convention.
8. **Measure** — returns, turnover, and benchmark-relative metrics; then
   attribution.

## Rules

- The signal may only use information knowable at its timestamp
  (point-in-time features, no restated data).
- Every rebalance and every position is reproducible from the inputs; no
  hand-picked adjustments.
- Report the strategy against the benchmark on the same periods with the
  same cost and rebalance conventions.

## Details

- See [references/selection-checklist.md](references/selection-checklist.md)
  for the per-step checklist.
- See [references/portfolio-construction.md](references/portfolio-construction.md)
  for weighting, caps, rebalancing, and turnover.
- See [references/attribution.md](references/attribution.md) for benchmark
  comparison and return attribution.
- Backtest execution details (costs, suspensions) are covered by
  `skill:backtest-integrity`; parameter experiments by
  `skill:experiment-validation`.
