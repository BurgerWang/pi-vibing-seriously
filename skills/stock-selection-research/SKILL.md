---
name: stock-selection-research
description: Explicit specialist for mid/low-frequency cross-sectional equity research. Load from quant-research-design when universe, ranking, exposure, portfolio construction, or attribution is the current problem.
disable-model-invocation: true
---

# Stock Selection Research

Define a point-in-time universe, validate survivorship, delisting and
corporate actions, compute available-at-signal cross-sectional features, then
specify ranking and grouping, industry and market-cap exposure controls,
portfolio construction, rebalance timing, turnover, benchmark, and return
attribution.

Every position and rebalance must be reproducible from the stated inputs and
execution convention; do not hand-adjust results after inspection.

## Conditional references

- Use [references/selection-checklist.md](references/selection-checklist.md)
  for an end-to-end selection study.
- Use [references/portfolio-construction.md](references/portfolio-construction.md)
  only for weights, caps, rebalance, and turnover.
- Use [references/attribution.md](references/attribution.md) only for
  benchmark-relative attribution.
