---
description: Optimize engineering performance or run selection/timing parameter experiments — full trial reporting, no parameter chasing without out-of-sample validation, never only the best trial.
argument-hint: "<target-or-experiment>"
---

# Optimize

Target: $ARGUMENTS

## Mode A — engineering optimization

1. **Baseline first** — measure the current state with an exact command;
   record the numbers before changing anything.
2. **Change one thing at a time** — each change is measured with the same
   command; record before/after.
3. **Verify correctness** — the optimized version passes the same tests as
   the original (same behavior, faster/better). A speedup that breaks
   correctness is a bug.
4. **Report** — baseline, each change, each measurement, and the final
   comparison with exact commands.

## Mode B — parameter experiment (selection/timing)

1. **Protocol before results** — state the parameter space, objective
   metric, data segmentation, and the adoption rule BEFORE running.
2. **Run the full experiment** — every trial logged: parameters + all
   metrics.
3. **Report every trial** — the full table or file reference. Reporting
   only the best trial is selection bias and is not acceptable.
4. **Out-of-sample required** — no parameter is adopted without
   out-of-sample or walk-forward evidence; report in-sample AND
   out-of-sample numbers.
5. **Stability** — report results around the chosen parameters and across
   walk-forward windows; prefer robust parameters over sharp optima.

## Constraints

- Do not chase parameters on in-sample performance alone.
- Never present the best trial as the result; present the experiment.

## Process

- Use the skill:experiment-validation rules and checklist.
- Time-series validation details: skill:market-timing-research.
- Backtest correctness: skill:backtest-integrity.
