---
name: experiment-validation
description: Validate parameter experiments and research claims — data segmentation, out-of-sample evaluation, walk-forward, full trial reporting, multiple-testing awareness, and stability checks. Use whenever parameters are tuned, strategies are compared, or a claim rests on backtest numbers.
---

# Experiment Validation

Goal: research claims that survive honest validation. The core discipline:
the evaluation protocol is decided before results are seen, every trial is
reported, and no parameter is adopted without out-of-sample evidence.

## Rules

1. **Segments before results** — split data into development and
   validation segments BEFORE running experiments; the validation segment
   is touched only for final evaluation (see `skill:market-timing-research`
   for time-series splits).
2. **No parameter chasing without out-of-sample validation** — tuning
   parameters on in-sample performance and reporting the best in-sample
   trial is fitting noise. Adoption requires out-of-sample or walk-forward
   evidence per the protocol in references.
3. **Report every trial** — the full experiment: parameter space, number
   of trials, objective, and ALL results (a scatter/table), not only the
   best trial. Cherry-picked trials are selection bias.
4. **Multiple-testing awareness** — the more trials you run, the more
   likely a good-looking result is luck. Report the number of trials
   alongside any "significant" finding; conventions like multiple-testing
   corrections exist, but the honest minimum is disclosure.
5. **Stability over best** — prefer parameters that are robust across
   windows/neighborhoods over a sharp global optimum (a sharp optimum is
   usually an artifact).

## Process

1. Write the protocol: objective metric, parameter grid, segmentation,
   and the adoption rule.
2. Run the experiment; save all trials with their parameters and metrics.
3. Evaluate on the validation segment exactly once per candidate adopted.
4. Report the full trial table, the selection rule, and validation
   results.

## Details

- See [references/experiment-checklist.md](references/experiment-checklist.md)
  for the executable checklist.
- See [references/out-of-sample.md](references/out-of-sample.md) for
  segmentation and the once-only rule.
- See [references/parameter-experiments.md](references/parameter-experiments.md)
  for grid/search reporting and stability analysis.
