# Experiment checklist

## Protocol (before running)

- [ ] Objective metric defined (and a secondary metric to catch gaming).
- [ ] Parameter space defined: ranges, steps, and the count of trials
      (know the number of experiments BEFORE running them).
- [ ] Segmentation defined: development vs validation windows, no overlap.
- [ ] Adoption rule defined: what evidence a candidate needs to be
      adopted (e.g. validation metric, stability across windows).
- [ ] The protocol is written down before the first run.

## Execution

- [ ] Every trial logged: parameters + all metrics (not just the objective).
- [ ] No mid-experiment rule changes without a new protocol entry.
- [ ] Runs are reproducible: seed/config/version recorded with each trial.

## Validation

- [ ] Validation segment used once per adopted candidate (see
      references/out-of-sample.md).
- [ ] Walk-forward used when parameters vary over time
      (`skill:market-timing-research`).
- [ ] Stability reported: metric surface around the chosen parameters
      (neighborhood, not just the optimum).
- [ ] Trials count reported with every claim of significance.

## Reporting

- [ ] Full trial table included or referenced (never "best trial only").
- [ ] In-sample vs out-of-sample metrics both shown.
- [ ] Failed trials summarized (how many, in which regions) — failures are
      evidence too.
- [ ] Claims state the number of trials and the selection rule.
