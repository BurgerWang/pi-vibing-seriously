# Costs and execution conventions

## Cost model

State the model and treat its parameters as assumptions:

- **Fees**: rate per unit traded (e.g. basis points of notional), minimum
  per order, and any fixed costs per trade.
- **Slippage**: a per-trade price penalty — fixed amount, percentage, or
  scaled by trade size relative to the instrument's typical volume.
- Apply costs to every trade: entries, exits, rebalances, and forced exits
  (delisting, suspension resolution, stops).

## Execution convention

Choose one and apply it consistently:

- next-open execution (signal at close of T, fill at open of T+1);
- next-close execution;
- delayed execution (signal on T, fill on T+k);
- intraday convention only if the data actually supports it (the workbench
  data scope is bar-level, not tick-level).

## Reconciliation checks

- gross return − net return = applied costs, period by period.
- NAV(t) = cash(t) + Σ positions(t) at every mark date.
- Turnover × cost rate ≈ cost drag (order of magnitude check).
- If the strategy only works with zero costs and perfect fills, the report
  says so — that is a capacity/cost finding, not a strategy.

## Reporting

Every backtest report states: price convention, timing convention, fee
model, slippage model, and capital/leverage assumptions — before the
numbers (see `skill:strategy-reporting`).
