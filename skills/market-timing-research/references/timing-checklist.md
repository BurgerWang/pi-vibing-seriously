# Timing checklist

## Signal generation time

- [ ] Every signal has an explicit timestamp = the latest data it uses.
- [ ] Indicator lookback windows are point-in-time (rolling, not
      full-sample).
- [ ] No signal uses data restated after its timestamp (index revisions,
      revised statistics).

## Tradable time

- [ ] Execution price convention defined (next open, close of T+1, ...).
- [ ] The gap between signal timestamp and execution timestamp is
      documented and enforced in code.
- [ ] Non-trading days (holidays, market closures) handled: a signal on a
      closed day executes on the next open day.

## Entry and exit

- [ ] Entry rule: exact condition + exact execution price + position taken.
- [ ] Exit rule: exact condition (stop, target, signal reversal, time) +
      execution convention.
- [ ] Multiple consecutive signals: the rule says whether the second
      signal is ignored, adds, or reverses.
- [ ] No look-ahead in stops/targets (they are set from prior information
      only).

## Position sizing

- [ ] Sizing rule defined: fixed, signal-scaled, volatility-scaled, with
      the scaling formula.
- [ ] Maximum exposure and leverage limits defined (timing strategies
      commonly express exposure as a fraction of capital).
- [ ] Sizing uses only data available at decision time (e.g. trailing
      volatility, not full-period volatility).

## Market state

- [ ] States defined objectively (e.g. price vs moving average, realized
      volatility bands) with their parameters.
- [ ] State is computed point-in-time — the state at time T uses data up
      to T only.

## Segmentation and validation

- [ ] Time-series split: chronological train/validation/test with no
      overlap; no random shuffling.
- [ ] Walk-forward protocol defined (window sizes, step size).
- [ ] Parameter stability: results reported across windows, not one best
      window.
- [ ] Per-regime and per-sub-period performance reported.

## Benchmark

- [ ] Benchmark is buy-and-hold (or aligned index) on the same dates.
- [ ] Same return convention, costs, and period for strategy and benchmark.
