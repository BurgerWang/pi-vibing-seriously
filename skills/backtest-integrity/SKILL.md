---
name: backtest-integrity
description: Explicit specialist for auditing a backtest result. Load from quant-research-design when leakage, execution alignment, costs, accounting, or rebalance correctness is the current question.
disable-model-invocation: true
---

# Backtest Integrity

Verify that the backtest measures the stated strategy rather than future
information or impossible execution.

## Focus

Check future leakage and look-ahead, signal/execution alignment, adjustments,
suspended trading, delisting, fees and slippage, cash and positions, benchmark
alignment, return computation, and rebalance semantics. State every trading
and accounting convention before accepting results.

If a required check cannot run, report it as NOT_RUN. A detected leak
invalidates affected results until the backtest is rerun.

This mid/low-frequency audit is out of scope for order book simulation, tick replay,
queue models, market making, colocation, microsecond latency, and
exchange execution engines.

## Conditional references

- Use [references/backtest-checklist.md](references/backtest-checklist.md) for
  a formal audit.
- Use [references/leakage-and-lookahead.md](references/leakage-and-lookahead.md)
  only for suspected information leakage.
- Use [references/costs-and-execution.md](references/costs-and-execution.md)
  only for cost, fill, or reconciliation questions.
