---
name: strategy-reporting
description: Write a strategy research report — objective, data, methodology, results vs benchmark, risk, turnover, robustness, limitations, and reproducibility. Use when presenting research results or writing results into the project.
---

# Strategy Reporting

Goal: a report that lets a reader (including future you) judge the claim,
reproduce the numbers, and see the limitations — without needing to ask.

## Structure

1. **Objective** — the hypothesis and the decision rule from the research
   plan (`skill:quant-research-design`).
2. **Data** — sources, universe, period, frequency, adjustment and
   survivorship conventions (`skill:market-data-integrity`).
3. **Methodology** — signal, portfolio rule, rebalance semantics,
   execution and cost conventions (`skill:backtest-integrity`).
4. **Results** — strategy vs benchmark: returns, risk, drawdowns,
   turnover, net of costs, per sub-period and per regime.
5. **Robustness** — walk-forward/out-of-sample results, parameter
   stability, trials count and selection rule
   (`skill:experiment-validation`).
6. **Limitations** — what could invalidate the results: data gaps, cost
   assumptions, regime dependence, capacity.
7. **Reproducibility** — the exact commands/recipes (or a script path)
   that regenerate every number.

## Rules

- Report gross AND net (of costs) results.
- Report the benchmark's numbers next to the strategy's — a strategy
  number without its benchmark is a fragment.
- Every metric is defined (see references); no undefined jargon.
- Limitations are a required section, not an optional confession.

## Details

- See [references/report-checklist.md](references/report-checklist.md) for
  the report checklist.
- See [references/performance-metrics.md](references/performance-metrics.md)
  for metric definitions and comparison discipline.
