# Leakage and look-ahead taxonomy

## Future leakage (direct)

Information from after the decision time reaches the decision:

- **Bar-level**: signal at close of T uses close of T to trade at close
  of T.
- **Row-level**: a row join brings in a later date's value.
- **Sort-level**: a cross-sectional sort computed over the full panel,
  then "lagged" — the lag does not repair the contamination.
- **Universe-level**: universe membership from the end of the sample.

## Look-ahead bias (indirect)

Information that did not exist at the time, even though it is "historical":

- **Restated data**: fundamentals/index values revised after the fact.
- **Survivor lists**: today's constituents applied to the past
  (`skill:market-data-integrity`).
- **Corporate actions**: adjustments applied backward without the
  point-in-time price history.
- **Full-sample statistics**: normalization, scaling, or volatility
  estimated over the whole sample.
- **Event hindsight**: "avoid names that later crashed" filters written
  after seeing the outcome.

## Detection patterns

- Rebuild one decision date by hand from raw inputs and compare with the
  backtest's decision.
- Search for full-sample calls in the signal path (mean/quantile over the
  whole panel, global normalization).
- Deliberately shuffle the outcome column: if results barely change, the
  signal may not be using what you think.
- Perturb the execution price convention (trade at T+1 instead of T): a
  strategy whose edge collapses is likely trading on the signal price.
- Audit joins for row-count blowups (duplication is often leakage in
  disguise).

## Handling

- A confirmed leak invalidates affected results; re-run after the fix.
- Report the leak class, the fix, and the before/after numbers.
