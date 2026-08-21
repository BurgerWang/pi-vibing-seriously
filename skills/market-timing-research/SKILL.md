---
name: market-timing-research
description: Explicit specialist for mid/low-frequency time-series strategy research. Load from quant-research-design when signal timing, entries/exits, regimes, sizing, or walk-forward design is the current problem.
disable-model-invocation: true
---

# Market Timing Research

Define signal generation and tradable time separately, then specify entry,
exit, position sizing, exposure caps, market states, benchmark, time-series
split, walk-forward protocol, regime analysis, and parameter stability.

A signal using close-of-period data must execute later under the documented
convention. Do not adopt parameters on in-sample evidence alone, and report
performance by regime and sub-period as well as in aggregate.

## Conditional references

- Use [references/timing-checklist.md](references/timing-checklist.md) for an
  end-to-end timing study.
- Use [references/walk-forward.md](references/walk-forward.md) only for
  time-series validation design.
- Use [references/regime-analysis.md](references/regime-analysis.md) only for
  state definitions and regime reporting.
