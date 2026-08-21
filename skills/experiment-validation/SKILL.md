---
name: experiment-validation
description: Explicit specialist for parameter experiments and research claims. Load from quant-research-design when tuning, comparing strategies, or deciding whether backtest evidence generalizes.
disable-model-invocation: true
---

# Experiment Validation

Freeze the objective, parameter space, data segmentation, and adoption rule
before inspecting results. Preserve every trial, not only the winner.

Require out-of-sample or walk-forward evidence for adoption, disclose the
number of trials, consider multiple-testing risk, and prefer stable regions
over sharp optima. Touch the reserved validation segment only according to the
frozen protocol.

## Conditional references

- Use [references/experiment-checklist.md](references/experiment-checklist.md)
  for a formal experiment review.
- Use [references/out-of-sample.md](references/out-of-sample.md) when the split
  or once-only rule is in question.
- Use [references/parameter-experiments.md](references/parameter-experiments.md)
  for search-space and stability reporting.
