# Out-of-sample validation

## The once-only rule

The validation segment evaluates candidates that were developed without it.
Every use of the validation segment to change the strategy (choose a
parameter, drop a feature, extend a window) consumes it. After enough
consumption it is no longer out-of-sample — it is a second training set.

Consequences:

- Decide the number of candidates you will validate BEFORE development.
- A "validation failure → adjust → re-validate" loop is in-sample fitting
  dressed as validation; report it as such.
- Final claims should cite how many times the validation segment was used.

## Segmentation

- Time series: chronological splits (see
  `skill:market-timing-research/references/walk-forward.md`); random
  shuffling is invalid for time series.
- Cross-sections: split by time AND by instrument groups when the
  strategy could be overfit to either dimension.
- Guard bands between segments prevent overlap contamination.

## Walk-forward as the workhorse

For parameter adoption, walk-forward (rolling fit/validate over time) is
stronger than a single split: it shows parameter drift and per-window
consistency. Report the parameter path across windows; parameters that
jump between windows are not stable, regardless of average performance.
