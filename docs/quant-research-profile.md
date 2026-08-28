# Quant-research profile

What the `quant-research/stock-selection` and `quant-research/market-timing`
profiles provide, and the validation ladder quant projects run against.

## Scope

Mid/low-frequency quantitative research only:

- stock-selection strategies (cross-sectional ranking/grouping) and
  market-timing strategies (time-series signals)
- ordinary mid/low-frequency backtesting
- data analysis, parameter experiments, walk-forward, out-of-sample
  validation
- general software engineering

**Explicitly out of scope (never implemented):** HFT, L2/LOB order books,
market making, queue position, matching engines,
millisecond/microsecond latency work, exchange order routing, live
high-frequency execution, colocation.

## What the profile writes

`/q-init quant-research/stock-selection` (or `market-timing`) writes
`.pi/workbench/{project,recipes,gates,profiles}.yaml` and an `AGENTS.md`
selected from `AGENTS.quant-research.md`. The quant profiles only describe
how the project invokes its **own existing scripts** — the workbench
implements no backtesting engine.

## Research contract (Q0)

`research/contract.json` declares, before any code:

- strategy type, universe, frequency, benchmark
- signal/execution assumptions (when the signal is observable, when the
  trade is filled)
- data assumptions (point-in-time, survivorship handling)
- acceptance criteria

The Q0 gate requires this contract to exist and parse.

## Output contract

The project declares its results in `results/quant-result.json` (schema:
`extensions/workbench-runtime/schemas/quant-result.schema.json`). The
workbench **validates** this contract — it never computes strategy metrics:

- `schema_version`, `run_id`, `strategy_type`, `frequency`, `universe`,
  `data_range`, `split`, `benchmark`, `costs`
- `metrics`: return, volatility, drawdown, turnover, exposure,
  benchmark_delta + at least one risk-adjusted metric
  (sharpe/sortino/calmar/information_ratio)
- `folds`: full trial reporting — failed folds are never filtered; a
  `passed` fold must carry metrics
- `parameters`, `artifacts`; profile-specific fields (stock-selection:
  point-in-time universe/exposure/rebalance; market-timing:
  regime/position-sizing)
- all numbers finite; `1e999` (Infinity) is rejected

## Validation ladder

| Gate | Verifies |
| ---- | -------- |
| B0-B6 (base, every profile) | project readiness → static quality → unit correctness → integration correctness → output contract → reproducibility/handoff → machine-backed development safety |
| Q0 | Research contract (`research/contract.json`) |
| Q1 | Market data integrity (point-in-time, survivorship, adjustments, timestamps) |
| Q2 | Backtest semantics (leakage, costs, benchmark alignment, rebalance semantics) |
| Q3 | Experiment integrity (full trial reporting, parameter experiments) |
| Q4 | Out-of-sample robustness (walk-forward, folds, parameter stability) |
| Q5 | Strategy reporting (results vs benchmark, risk, turnover, robustness, limitations, reproducibility) |

Gate mechanics: prerequisite resolution (current run first, then latest
persisted run), statuses exactly `PASS | FAIL | BLOCKED | NOT_RUN`, required
`NOT_RUN` checks can never PASS a gate, warnings never upgrade a status,
manual evidence is recorded as type `manual` only. Audit conclusions that
cannot be machine-verified (look-ahead, survivorship, substantive parameter
stability) remain manual-evidence checks with explicit prompts. Q4 also has a
machine check for chronological train/validation/test ranges, non-overlapping
fold tests, explicit gap/embargo applicability, retained failed folds, and
content-addressed parameter-stability evidence references.

## Quant tooling

- `/q-gate q0,q1,...` / `workbench_run_gate` — run gates
- `/q-evidence <run-id>` — per-check evidence
- `/q-compare <a> <b>` / `workbench_compare_runs` — descriptive deltas
  (benchmark/return/drawdown/turnover/cost/fold/parameters) from
  run-attributed artifact snapshots; **a higher return is never
  automatically interpreted as a better strategy** (the report always
  carries the neutrality statement)
- `/q-report latest|<run-id>` — manifest, gates, declared quant facts
- `/q-promote research <candidate-id> <source-run-id>` — user-only VERIFY
  promotion after one Candidate-bound full Gate run
- `/q-promote release <candidate-id> <source-run-id> --artifact-run <run-id>
  --authorize-release` — explicit user release authority with exact
  source/build/input/artifact provenance; it never pushes or publishes
- `/q-cache-validate <manifest-path>` — validate a quant cache contract
  manifest (data-snapshot / feature-set / backtest-result): schema
  version, immutable/mutable status, content hash, upstream keys, missing
  fields, warnings, cache eligibility, Q gate implications
- `/q-cache-lineage <run-id|action-key>` — trace the quant cache lineage
  (data snapshot → feature set → backtest result, artifact hashes, reused
  runs, invalidation reason)

## Quant cache contracts (P6-D)

Three versioned manifest contracts make research caching safe
(`docs/cache/quant-cache.md`): `DATA_SNAPSHOT`, `FEATURE_SET` and
`BACKTEST_RESULT`. The workbench only defines, validates and connects the
contracts — it never downloads data, computes features or runs a backtest
engine. `latest`/`current`/`now`/`today` can never be a final manifest id;
logical references resolve to an immutable revision or the cache is
refused. Cache hits never bypass Q0–Q5: gates re-validate every run, and
the three contracts are available as gate schema checks
(`schema: data-snapshot|feature-set|backtest-result`) that only PASS for
fully `validated` manifests.

## Skills for quant work

`quant-research-design`, `market-data-integrity`, `stock-selection-research`,
`market-timing-research`, `backtest-integrity`, `experiment-validation`,
`strategy-reporting` (each with `references/*.md` checklists). The quant
skills are scoped to mid/low-frequency research: no order-book, tick-replay,
queue-model, market-making, colocation, latency, or exchange-execution
content.
