# Walk-forward and time-series validation

## Why time series cannot be shuffled

Random train/test splits of a time series leak future information into the
past (overlapping windows, serial correlation) and destroy the point of
validation: the model must be evaluated on data that came after the data it
was fit on. Chronological splits only.

## Walk-forward protocol

1. Choose window sizes: training window (e.g. N periods) and validation
   window (M periods), and a step size.
2. Fit on [0, N), validate on [N, N+M); fit on [step, step+N), validate on
   [step+N, step+N+M); repeat.
3. Parameters are chosen per training window from THAT window's data only.
4. The walk-forward result is the concatenation of validation-window
   outcomes — never the training-window outcomes.
5. Report the parameter path: how chosen parameters drifted across windows
   (parameter stability).

## Walk-forward vs out-of-sample

- Walk-forward: repeated rolling fit/validate — the standard for parameter
  stability over time.
- Out-of-sample: one (or few) held-out segments — the final confirmation
  for a strategy developed on the rest.
- Both are required for a credible parameter adoption; see
  `skill:experiment-validation`.

## Common failures

- Validation windows overlapping training windows.
- Choosing parameters once on the full history, then "walk-forward
  evaluating" the same parameters (that is in-sample dressing).
- Discarding bad walk-forward windows instead of reporting them.
- Embedding full-sample statistics (normalization, scaling) inside the
  signal without recomputing them per window.
