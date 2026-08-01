# Backtest audit checklist

Run every check that applies; record PASS/FAIL/NOT_RUN with evidence.

## Data flow

- [ ] Feature inputs carry the data-as-of timestamp; nothing later than the
      decision timestamp enters a decision.
- [ ] Filters (liquidity, price, universe) use point-in-time values.
- [ ] Cross-sectional statistics (means, quantiles, normalization) computed
      per date from that date's cross-section.
- [ ] No full-sample statistics anywhere in the signal path (scaling,
      z-scores, volatility estimates).

## Signal → execution

- [ ] Signal timestamp, execution timestamp, and price convention
      documented.
- [ ] Execution price is from a bar strictly after the signal bar (or the
      documented convention: next open / next close / delayed).
- [ ] No trade at the signal bar's own close unless the signal used data
      before that close (state the cutoff).
- [ ] Corporate-action adjustments applied at the correct effective date
      (ex-date), not retroactively across history.

## Instruments

- [ ] Suspension rule defined: signals during suspension, holdings during
      suspension, and resumption handling.
- [ ] Delisting: final price documented; no silent disappearance.
- [ ] Ticker/identifier changes mapped; no phantom duplicates after
      mergers.
- [ ] IPO/listing dates respected.

## Costs

- [ ] Fee model: rates, per-trade minimums, and the account they apply to.
- [ ] Slippage model: amount or % of price, and how it scales with trade
      size vs volume.
- [ ] Costs applied to entries AND exits, including forced exits
      (delisting, suspension resolution).
- [ ] Cost assumptions stated as assumptions (see
      references/costs-and-execution.md).

## Accounting

- [ ] Cash balances earn the stated rate; no negative cash without a
      documented borrowing cost.
- [ ] Positions marked at the stated price each period; returns computed
      from marks.
- [ ] Fractional shares or rounding rule documented.
- [ ] Capital fully accounted: sum of cash + position values = NAV at every
      point (reconciliation check).

## Benchmark and returns

- [ ] Benchmark uses the same dates/prices/conventions.
- [ ] Return computation matches its definition (simple vs log, daily vs
      period aggregation, compounding).
- [ ] Gross and net returns both reported; the difference equals the
      applied costs (reconciliation check).
- [ ] Rebalance trade list reproducible from inputs (a code review of the
      trade generation is part of the audit).
