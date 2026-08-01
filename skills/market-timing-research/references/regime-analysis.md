# Market states and regime analysis

## Defining states

Market states are objective, computable conditions — for example:

- trend state: price relative to a moving average (with lookback);
- volatility state: realized volatility bands (with window and thresholds);
- liquidity/volume state: volume or spread regimes where data allows.

Each definition includes its parameters and is computed point-in-time.
State definitions are part of the research plan, not an after-the-fact
partition that flatters results.

## Per-regime reporting

For each state, report:

- time coverage (share of periods);
- strategy return/risk in that state;
- benchmark return/risk in that state;
- number of entry/exit events (a state with one event proves nothing).

## Reading regime results

- A strategy whose entire edge comes from one state is a regime bet:
  report it as such and show what happens when the state does not occur.
- Regime definitions whose parameters were chosen to maximize the
  strategy's apparent edge are overfitting — the definitions must precede
  the results (see `skill:experiment-validation`).
- Parameter stability across regimes is a separate question from overall
  stability: a parameter that works in every state is more credible than
  one that only works in the state it was tuned in.
