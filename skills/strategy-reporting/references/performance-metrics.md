# Performance metrics

## Definitions

Define every metric in the report; conventions vary, so state yours:

- **Return**: simple or log; period length; annualization method
  (compounding vs scaling — scaling is an approximation, state it).
- **Volatility**: standard deviation of which return series, over which
  window, annualized how.
- **Drawdown**: peak-to-trough on the equity curve; maximum and average;
  recovery time.
- **Risk-adjusted ratios**: define numerator and denominator exactly
  (e.g. excess return over what rate, divided by what volatility).
- **Turnover**: absolute weight change per rebalance and annualized
  (see `skill:stock-selection-research`).
- **Hit rate / win rate**: fraction of positive periods or winning trades,
  with the count of events (a win rate over 5 events is a factoid, not a
  statistic).

## Comparison discipline

- Always show the benchmark's value for the same metric, same periods.
- Show the number of periods/events behind each statistic.
- Prefer distributions over averages: period-by-period returns, drawdown
  path, per-regime tables.
- Net-of-cost numbers are the reported numbers; gross is context.

## Statistical honesty

- Report uncertainty where the sample is small (few regimes, few trades);
  a point estimate without its sample size is misleading.
- Thresholds (significance levels, drawdown limits) are project
  conventions — state them; do not dress preferences as laws.
- If results are not statistically distinguishable from the benchmark,
  say so. A report that only ever concludes "edge found" is not a report.
