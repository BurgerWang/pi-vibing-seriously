# Parameter experiments

## Grid vs search

- **Grid**: evaluate a declared set of parameter combinations; easy to
  report fully; the standard default.
- **Search/optimization**: iterative methods (gradient-free, heuristics).
  They explore many more points — report the search path and the total
  number of evaluations; an optimizer's "best" is a selection artifact
  until validated like any other trial.

## Reporting

Report for every experiment:

- parameter space (ranges, steps, count of combinations);
- objective metric and secondary metrics;
- all trials (table or file reference) — never only the best;
- in-sample AND out-of-sample/walk-forward metrics;
- the selection rule that picked the reported parameters;
- the metric surface around the chosen parameters (stability).

## Stability analysis

- Neighbor check: do nearby parameter values give similar results? A
  lone spike is noise.
- Window check: does the parameter rank consistently across walk-forward
  windows? (see references/out-of-sample.md)
- Robustness statements are about the neighborhood, not the optimum.

## Selection bias

Every trial is a draw; the best of 10,000 draws is expected to look great
by chance. Any claim must state the number of trials. Adjustments and
corrections are available in the statistics literature — but the honest
minimum, and the workbench requirement, is disclosure: trials count,
selection rule, and both in-sample and out-of-sample numbers.
