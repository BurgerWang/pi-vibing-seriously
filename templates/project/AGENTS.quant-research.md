# AGENTS — pi-dev-workbench quant-research profile

Guidance for AI agents working in this quantitative research project
(stock selection and/or market-timing research, mid/low frequency).

## Scope

- This project is research software: data preparation, signal/strategy
  research, backtesting, walk-forward and out-of-sample validation, metrics,
  and reporting.
- Backtesting and research code lives in THIS project. The workbench only
  orchestrates declared recipes (`.pi/workbench/recipes.yaml`) — it is not a
  backtesting engine.
- High-frequency execution infrastructure is out of scope by design.

## Mode discipline

- AUDIT (read-only), DEV (implement), VERIFY (re-verify only).
- Run project commands through declared recipes (e.g. `data:fetch`,
  `backtest:selection`, `backtest:timing`, `walkforward:validate`); never
  improvise shell commands in VERIFY.

## Validation ladder (P3)

- The workbench runs a gate ladder: base gates `b0`-`b5` (project readiness,
  static quality, unit/integration correctness, output contract,
  reproducibility) for every profile, plus quant gates `q0`-`q5` (research
  contract, market data integrity, backtest semantics, experiment
  integrity, out-of-sample robustness, strategy reporting) for
  quant-research profiles.
- Run gates with `/q-gate <gate-id|base|quant|all>` or the
  `workbench_run_gate` tool. Gates depend on each other in order — a gate
  whose prerequisite failed or never passed is BLOCKED.
- Statuses are only PASS / FAIL / BLOCKED / NOT_RUN. Required checks that
  are NOT_RUN can never pass a gate; manual evidence is recorded as type
  `manual` and can never masquerade as machine verification.

## Quant output contract

- The workbench **never computes strategy metrics**. It validates what this
  project declares. The backtest pipeline must write `results/quant-result.json`
  conforming to `quant-result.schema.json`:
  `schema_version`, `run_id`, `strategy_type`, `frequency`, `universe`,
  `data_range`, `split`, `benchmark`, `costs`, `metrics` (return, volatility,
  drawdown, a risk-adjusted metric, turnover, exposure, benchmark_delta),
  `folds` (full trial reporting — failed folds included, never filtered),
  `parameters`, `artifacts`, optional `warnings`/`semantics`.
- The Q0 research contract lives in `research/contract.json`:
  `strategy_type`, `universe`, `frequency`, `benchmark`, `signal`
  (generation and execution assumptions), `acceptance` criteria.
- Machine checks assert presence/finiteness of declared fields; audits that
  cannot be automated (look-ahead, survivorship, parameter stability, ...)
  are manual-evidence checks that must be backed by explicit evidence.

## Research workflow

1. **Design first.** State the hypothesis, universe, period, frequency,
   benchmark, and evaluation plan before writing backtest code. Write the
   plan down.
2. **Data integrity before modeling.** Verify point-in-time availability,
   survivorship handling (delisted names included), corporate actions and
   adjustments, missing/duplicate records, and timestamp alignment. Never
   assume the data is clean.
3. **No look-ahead.** A signal may only use information available at its
   timestamp. Signal generation time, execution time, and record timestamps
   must be explicit and checked.
4. **Backtest integrity.** Validate costs (fees, slippage), suspension and
   delisting handling, cash and position accounting, benchmark alignment,
   rebalance semantics, and return computation.
5. **Out-of-sample validation.** Parameter choices require out-of-sample or
   walk-forward validation. Report the full experiment (all trials), never
   only the best result. Do not chase parameters without validation.
6. **Report honestly.** Report performance versus the benchmark, drawdowns,
   turnover, regime sensitivity, parameter stability, limitations, and how to
   reproduce every result.

## Skills

- `skill:repository-orientation` — start of work in an unexplored repository
- `skill:quant-research-design` — research design and evaluation plans
- `skill:market-data-integrity` — data quality checks before modeling
- `skill:stock-selection-research` — cross-sectional strategy work
- `skill:market-timing-research` — time-series strategy work
- `skill:backtest-integrity` — backtest correctness audit
- `skill:experiment-validation` — parameter experiments and out-of-sample work
- `skill:strategy-reporting` — results, metrics, and limitations
- `skill:implementation-workflow` — implementation tasks
- `skill:validation-ladder` — verification verdicts

## Handoff

Before handing off: state what was changed, which recipes reproduce the
results, what is still unvalidated, and known limitations.
