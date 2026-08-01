# Report checklist

## Objective and methodology

- [ ] Hypothesis restated; the tested variant identified (if the strategy
      changed during research, say which version this report covers).
- [ ] Universe, period, frequency stated.
- [ ] Signal defined precisely enough to reimplement (formulas, lookbacks,
      timestamps).
- [ ] Portfolio rule: weights, caps, cash, rebalance calendar and price
      convention.
- [ ] Cost model: fees, slippage, and the assumed capacity/volume basis.

## Data

- [ ] Sources and versions cited; adjustment and delisting conventions
      stated.
- [ ] Known data limitations listed (missing segments, restatement risk).

## Results

- [ ] Strategy and benchmark on the same periods with the same
      conventions.
- [ ] Gross and net results both reported.
- [ ] Return, volatility, drawdown, turnover reported; each defined.
- [ ] Sub-period and per-regime results included (aggregate-only reports
      hide regime dependence).
- [ ] Attribution or exposure report included for selection strategies
      (`skill:stock-selection-research`).

## Robustness

- [ ] Out-of-sample / walk-forward results reported.
- [ ] Trials count and selection rule stated (`skill:experiment-validation`).
- [ ] Parameter stability evidence (neighborhood/window results).

## Reproducibility

- [ ] Every number traceable to a command/recipe or script + input files.
- [ ] Report states how to re-run (recipe names, not prose).
- [ ] Output artifacts referenced by path.
