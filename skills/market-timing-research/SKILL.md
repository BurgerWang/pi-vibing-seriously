---
name: market-timing-research
description: Run market-timing research end to end — signal generation vs tradable time, entry and exit rules, position sizing, market states and regimes, time-series segmentation, benchmark, walk-forward and parameter stability. Use for time-series strategy work on a market or index.
---

# Market Timing Research

Goal: a time-series strategy whose signals are honestly timed (generated
before they are tradable), whose entries/exits and position sizes are
defined, and whose performance is reported per market state with
walk-forward validation.

## Workflow

1. **Timing discipline** — separate signal generation time from tradable
   time. A signal computed from close-of-T data is only tradable at T+1
   (or later); the backtest must use the tradable price, never the signal
   price.
2. **Market state** — define the states the strategy lives in (trending,
   ranging, high/low volatility, ...) with objective definitions.
3. **Entry and exit** — define the rules fully: what triggers entry, what
   triggers exit, and what the position is between events.
4. **Position sizing** — the rule that maps signal strength/state to
   position size (fixed, scaled, capped), and the maximum exposure rule.
5. **Benchmark** — buy-and-hold of the traded instrument (or an aligned
   index) on the same periods; timing strategies are measured by
   risk-adjusted excess over holding, plus drawdown reduction.
6. **Segment** — time-series splits for development and validation
   (walk-forward), never random shuffles of a time series.
7. **Validate** — parameter stability across windows and per-regime
   performance; see `skill:experiment-validation`.

## Rules

- A timing signal must be tradable by construction: signal timestamp <
  execution timestamp, with the gap documented.
- No parameter is adopted on in-sample performance alone.
- Report performance per regime and per sub-period, not only the aggregate
  — a strategy that works in one state and fails in another is a regime
  bet, and must be labeled as such.

## Details

- See [references/timing-checklist.md](references/timing-checklist.md) for
  the per-step checklist.
- See [references/walk-forward.md](references/walk-forward.md) for
  time-series validation, including the walk-forward protocol.
- See [references/regime-analysis.md](references/regime-analysis.md) for
  market states and per-regime performance reporting.
- Data and backtest execution details live in `skill:market-data-integrity`
  and `skill:backtest-integrity`.
