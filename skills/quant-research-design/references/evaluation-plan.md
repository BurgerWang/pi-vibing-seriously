# Evaluation plan

## Benchmark choice

A benchmark should be:

- **Comparable** — same universe/scope as the strategy (a selection strategy
  restricted to a segment should compare to a benchmark of that segment, or
  show segment exposures).
- **Replicable** — constructed from the same point-in-time data.
- **Aligned** — same frequency and rebalance timing, so return differences
  are attributable to the strategy, not to timing gaps.

There is no single "correct" benchmark; state the choice and its limits.

## Metrics

Define each metric before running anything. Common choices (choose and
justify; conventions vary by project):

- Total/compounded return, annualized return.
- Volatility and downside deviation.
- Sharpe/Sortino-style ratios and maximum drawdown.
- Turnover, exposure, capacity (how much capital the strategy can absorb
  before costs dominate).
- Hit rate and per-period distribution, not just averages.

Report the benchmark's values for the same metrics on the same periods —
"annualized 18%" means nothing without the benchmark's number.

## Data segmentation

- **In-sample** — used to develop and fit.
- **Out-of-sample (OOS)** — held out during development, evaluated once (or
  few times); see `skill:experiment-validation`.
- **Walk-forward** — repeated fit/validate windows over time; the standard
  for parameter stability and regime sensitivity.
- Never tune on the segment you will report as validation.

## Statistical standards

Statistical thresholds (significance levels, minimum sample sizes, minimum
OOS windows) are conventions, not laws: choose them for the project, state
them, and apply them consistently. What IS a hard rule is the discipline of
deciding the evaluation protocol before seeing results — otherwise every
"finding" is a selection artifact.
