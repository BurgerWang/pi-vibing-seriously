---
name: quant-research-design
description: Route and design substantive mid/low-frequency quantitative research. Use for a research hypothesis, universe, benchmark, evaluation protocol, or selection/timing study; do not use for ordinary software changes.
---

# Quant Research Design

Create the smallest research contract that makes the claim testable before
writing or changing research code.

## Contract

Record the hypothesis, point-in-time universe, period and frequency, required
data, benchmark, metrics, segmentation, adoption rule, and reproducible output.
High-frequency execution infrastructure is out of scope.

## Route only the current phase

Load at most the specialist needed now; do not preload the whole research
stack:

- data trust → `skill:market-data-integrity`
- cross-sectional selection → `skill:stock-selection-research`
- time-series timing → `skill:market-timing-research`
- backtest correctness → `skill:backtest-integrity`
- tuning or research claims → `skill:experiment-validation`
- final research write-up → `skill:strategy-reporting`

Use ordinary `skill:implementation-workflow` for code changes after the
research contract is clear. Re-route only when the task actually enters a new
phase.

## Conditional references

- Open [references/research-plan.md](references/research-plan.md) only when a
  durable research plan is requested or missing.
- Open [references/evaluation-plan.md](references/evaluation-plan.md) only
  when the benchmark, metrics, segmentation, or adoption rule is unsettled.
