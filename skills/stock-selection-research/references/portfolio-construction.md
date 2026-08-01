# Portfolio construction, rebalancing, and turnover

## Weighting

Common schemes (choose, document, and justify for the project):

- **Equal weight** — simple, high turnover at rebalance, no implicit
  tilts.
- **Score-weighted** — weights proportional to the score; define the
  transformation (linear, rank-based) and its sensitivity to outliers.
- **Cap-weighted within selection** — weights proportional to market cap
  among selected names; mixes a size tilt into the selection.

Position caps: a maximum weight per name limits single-name risk; a
minimum-liquidity filter (point-in-time volume) keeps the portfolio
executable at the assumed cost level.

## Rebalance semantics

- **Calendar rebalance** — fixed dates (weekly/monthly); define the exact
  decision timestamp and execution timestamp.
- **Event rebalance** — triggered by data events; define the trigger and
  the delay between event, decision, and execution.
- At each rebalance: new weights computed from data available at the
  decision time; trades executed at the defined price (next open, close,
  VWAP-style assumption — state which).

## Turnover

- Measure turnover per rebalance and annualized: sum of absolute weight
  changes / 2, plus entries/exits.
- Turnover is the bridge between gross and net returns: apply the cost
  model (see `skill:backtest-integrity`) and report net-of-cost results.
- High turnover with no corresponding return is the classic selection
  failure mode — report it, do not hide it.
