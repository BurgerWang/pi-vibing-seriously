# pi-dev-workbench

<p align="center">
  <img src="assets/banner.svg" alt="pi-dev-workbench v0.8.0 — a Pi-native development workbench" width="586" />
</p>

A **Pi Package** (v0.8.0, P6) that adds a native development workbench to
[Pi](https://pi.dev): a mode policy (AUDIT / DEV / VERIFY), project
configuration, a declarative Recipe Runner, a **Gate Engine with evidence
artifacts and a quant research validation ladder**, Pi-native TUI status,
run reports and run comparison, workbench skills, `q-*` prompt templates,
project templates, and **prompt-cache telemetry for the DeepSeek provider**
(P6-A: hash-only usage/context observability, inferred invalidations, and
`/q-cache-*` commands) with a **stable-prefix contract** (P6-B: static tool
registration and per-mode tool matrices, deterministic resource discovery,
`UNEXPECTED_DRIFT` same-mode drift detection) and a **Deterministic Recipe
Action Cache** (P6-C: opt-in, project-local, result-only caching of
declared recipes — content-addressed action keys, `/q-cache-explain`,
`/q-cache-prune`, `/q-cache-clear`, `--no-cache`/`--refresh-cache`; never
caches LLM answers or arbitrary bash) and a **Quant Research Cache
Contract layer** (P6-D: versioned DATA_SNAPSHOT / FEATURE_SET /
BACKTEST_RESULT manifest contracts, immutable-reference resolution,
`domain: quant` recipe caching, `/q-cache-validate`, `/q-cache-lineage`;
cache hits never bypass Q0–Q5) and an **offline Cache Benchmark** (P6-E:
`scripts/cache-benchmark.ts`, `npm run cache:report` / `npm run
cache:doctor` — telemetry + run-manifest + action-cache analysis with
JSON/human output, never a model call, never a warmup request, no
hardcoded provider prices). It runs entirely on Pi's native
mechanisms —
extensions, custom commands, custom tools, skills, prompt templates,
session custom entries, `ctx.ui.setStatus`/`setWidget`, and custom tool
renderers. **It is not a standalone agent framework, daemon, background
service, or sandbox.** In DEV, GPT-5.6 Sol may explicitly create one
short-lived, pinned, non-recursive DeepSeek Pi worker for a bounded
implementation task; the process ends with the tool call and never owns final
verification.

Documentation: [docs/architecture.md](docs/architecture.md) ·
[docs/worker-delegation.md](docs/worker-delegation.md) ·
[docs/security.md](docs/security.md) ·
[docs/compatibility.md](docs/compatibility.md) ·
[docs/project-onboarding.md](docs/project-onboarding.md) ·
[docs/quant-research-profile.md](docs/quant-research-profile.md) ·
[docs/cache/deepseek-prompt-cache.md](docs/cache/deepseek-prompt-cache.md) ·
[docs/cache/cache-telemetry.md](docs/cache/cache-telemetry.md) ·
[docs/cache/cache-privacy.md](docs/cache/cache-privacy.md) ·
[docs/cache/stable-prefix-contract.md](docs/cache/stable-prefix-contract.md) ·
[docs/cache/deepseek-cache-limitations.md](docs/cache/deepseek-cache-limitations.md) ·
[docs/cache/cache-efficient-workflow.md](docs/cache/cache-efficient-workflow.md) ·
[docs/cache/action-cache.md](docs/cache/action-cache.md) ·
[docs/cache/recipe-cache-schema.md](docs/cache/recipe-cache-schema.md) ·
[docs/cache/cache-maintenance.md](docs/cache/cache-maintenance.md) ·
[docs/cache/cache-correctness.md](docs/cache/cache-correctness.md) ·
[docs/cache/quant-cache.md](docs/cache/quant-cache.md) ·
[docs/cache/data-snapshot-contract.md](docs/cache/data-snapshot-contract.md) ·
[docs/cache/feature-set-contract.md](docs/cache/feature-set-contract.md) ·
[docs/cache/backtest-result-contract.md](docs/cache/backtest-result-contract.md) ·
[docs/cache/quant-cache-invalidation.md](docs/cache/quant-cache-invalidation.md) ·
[docs/cache/cache-benchmark.md](docs/cache/cache-benchmark.md) (statistical definitions, `cache:report`/`cache:doctor`) ·
[docs/cache/P6_BENCHMARK_REPORT.md](docs/cache/P6_BENCHMARK_REPORT.md) (before/after, P6-A→P6-C) ·
[docs/cache/P6_RELEASE_REPORT.md](docs/cache/P6_RELEASE_REPORT.md) (P6-E release evidence, rollback, cleanup) ·
[compatibility/pi.json](compatibility/pi.json) (tested-environment matrix).

## Scope

Quantitative research scope (mid/low-frequency only) and general software engineering:

- Stock selection strategies and timing strategies
- Ordinary mid/low-frequency backtesting
- Data analysis, parameter experiments, walk-forward, out-of-sample validation
- General software engineering projects

**Explicitly out of scope (never implemented):** HFT, L2/LOB order books, market
making, queue position, matching engines, millisecond/microsecond latency work,
exchange order routing, live high-frequency execution, and colocation.

## P1 mode model

| Mode   | Active tools                                                                 | Hard-blocked at tool_call          | Use case                        |
| ------ | ---------------------------------------------------------------------------- | ---------------------------------- | ------------------------------- |
| AUDIT  | read, grep, find, ls, workbench_project_inspect, workbench_read_run, workbench_read_gate, workbench_list_gates, workbench_compare_runs | bash, edit, write, workbench_run_recipe, workbench_run_gate, workbench_delegate_worker | Read-only inspection       |
| DEV    | read, grep, find, ls, bash, edit, write, all `workbench_*` tools (including controlled worker delegation) | — | Implementing features and fixes |
| VERIFY | read, grep, find, ls, workbench_project_inspect, workbench_run_recipe, workbench_read_run, workbench_run_gate, workbench_read_gate, workbench_list_gates, workbench_compare_runs | bash, edit, write, workbench_delegate_worker | Re-verifying completed work |

- `/q-mode-audit` — switch to AUDIT
- `/q-mode-dev` — switch to DEV (default)
- `/q-mode-verify` — switch to VERIFY
- `/q-status` — current mode, cwd, project trust, active tools, registered workbench tools

The mode is stored in a Pi custom session entry (`workbench-mode`) and restored
from the current session on `session_start`. All UI calls degrade safely in
print/json/RPC modes.

**P4 UI** — the TUI footer shows a workbench status line (a `setStatus` slot;
the Pi footer itself is never replaced):

```
WB:VERIFY | quant-research/stock-selection | Q3:FAIL | run:20260801-004
```

- `WB:<MODE>` — current mode; `profile` — the selected workbench profile;
  `<gate>:<status>` — the most relevant gate of the latest gate run;
  `run:<id>` — the latest run (`:FAILED`/`:TIMED OUT` appended when not OK).
- A compact **widget** (via `ctx.ui.setWidget`, above the editor) shows while a
task is active, when the latest gate run is not a PASS, or when forced with
`/q-widget on`; it auto-clears otherwise. Content: task, phase, gate, last
run, blocking reason. Plain ASCII, width-fitted for narrow terminals.
- **Run reports**: `/q-report latest | <run-id>` — manifest facts, gates and
failed checks for gate runs, declared quant facts for quant runs.
- **Run comparison**: `/q-compare <run-id-a> <run-id-b>` (or the
`workbench_compare_runs` tool) — exit code, duration, artifact changes, gate
delta, test counts, and (for quant runs) benchmark/return/drawdown/turnover/
cost/fold deltas and parameter changes. Deltas are descriptive: **a higher
return is never automatically interpreted as a better strategy**.
- The five workbench tools have compact TUI renderers (partial/error/expanded
states included); expanded shows recipe, duration, exit code, artifacts,
failed checks and log paths. Facts come only from the runs' own JSON records
(manifest/gates/result) — renderers never recompute business metrics.

**P1 change:** VERIFY no longer includes free `bash`. The model runs project
commands only through `workbench_run_recipe`, which executes *declared*
recipes — explicit, auditable steps the model can request but not improvise.
This is a discipline boundary, not a sandbox (see Security model).

### Two enforcement layers

1. **Active tool sets** via `pi.setActiveTools()`.
2. **Hard `tool_call` guard** via `pi.on("tool_call")` — even if some other
   logic re-enables a tool, the guard still blocks `bash`/`edit`/`write` in
   AUDIT and VERIFY and `workbench_run_recipe` in AUDIT.

### Protected paths (P5)

Default protected set (basename matching, case-insensitive, any depth):
`.env` and `.env.*` — **except `.env.example` and `.env.template`**, which
are explicitly allowed — plus `*.pem`, `*.key`, `id_rsa`, `id_ed25519`,
`id_ecdsa`, `id_dsa`, `credentials.*`, `secrets.*`, `exchange-keys.*`,
`auth.json`, `.netrc`, `*.token` and keystores (`*.p12`, `*.pfx`, `*.jks`).

| Operation | DEV | AUDIT | VERIFY |
| --------- | --- | ----- | ------ |
| `edit`/`write` on a protected path | blocked | blocked | blocked |
| `read`/`ls`/`find`/`grep` on a protected path | allowed | blocked | blocked |
| bash display-reads (`cat .env`, ...) | allowed | blocked | blocked |

Secret content never appears in logs, manifests, error messages, the status
bar, the widget, or reports — every surface consumes redacted or structural
data. See [docs/security.md](docs/security.md) for the full matrix and
boundaries.

### Command guard (P5)

Blocked (token-parsed, quote-aware — no substring false positives):
`rm -rf /`, `rm -rf ~`/`$HOME`, `rm` of any `.git`, `git reset --hard`,
`git clean -fd` or stronger, `git push -f`/`--force`/`--force-with-lease`,
`git checkout -- .`, `git restore .`, `git remote`
add/remove/set-url/rename, `git config --global`/`--system` writes, `sudo`,
and `npm|yarn|pnpm|bun publish|unpublish` (`--dry-run` stays allowed).
Single-file restores (`git restore src/main.ts`), local `git config`, reads
like `git config --global --list`, and quoted text like
`git commit -m "rm -rf /"` are correctly allowed.

## Project configuration

Config lives in `<project-root>/<CONFIG_DIR_NAME>/workbench/` where
`CONFIG_DIR_NAME` is Pi's official export (`.pi` by default — never hardcoded):

- `project.yaml` — `name`, `description`, `profile`
- `recipes.yaml` — declarative recipes
- `gates.yaml` — gate declarations (enforced since P3; empty `gates: []` uses the built-in catalog)
- `profiles.yaml` — profile definitions

Project root detection: `git rev-parse --show-toplevel` first, `ctx.cwd` for
non-git projects. **No project configuration is read or executed unless
`ctx.isProjectTrusted()` is true.**

### /q-init

```
/q-init generic
/q-init quant-research/stock-selection
/q-init quant-research/market-timing
```

- Shows the files it is about to write **before** writing anything.
- Existing files are **never overwritten by default**; overwrites require
  per-file confirmation (skipped entirely in print/json modes).
- Each profile also writes an `AGENTS.md` at the project root, selected by
  profile: `generic` → `AGENTS.generic.md`, the quant profiles →
  `AGENTS.quant-research.md`. An existing `AGENTS.md` is **never overwritten
  by default**.
- `generic` contains no quantitative content. The quant profiles only describe
  how the project invokes its own existing scripts — the workbench implements
  no backtesting engine.
- `hft`, `market-making`, `lob` and `execution-engine` profiles are rejected by
  design.
- After initialization: **exit Pi, re-enter the project, and approve project
  trust** — config is only read under trust.

### Project templates

Template files live in `templates/project/` (the single source of truth
loaded by `/q-init`):

```
templates/project/
├── AGENTS.generic.md          # AGENTS.md for the generic profile
├── AGENTS.quant-research.md   # AGENTS.md for both quant profiles
├── generic/                   # project.yaml, recipes.yaml, gates.yaml, profiles.yaml
├── stock-selection/           # config for quant-research/stock-selection
└── market-timing/             # config for quant-research/market-timing
```

## Recipes

Each recipe in `recipes.yaml` is fully declarative. The model can only request
a recipe by name plus parameters declared in the recipe's `params` schema — it
can never inject an arbitrary command or shell string.

```yaml
recipes:
  - name: backtest
    description: Run the stock-selection backtest
    command: ["python", "scripts/backtest.py", "--symbol", "{{symbol}}"]  # argv array, NEVER a shell string
    cwd: "."                      # relative to the project root
    timeout_ms: 600000
    allowed_modes: [DEV, VERIFY]  # AUDIT can never run recipes
    expected_exit_codes: [0]      # anything else is a failure
    writes: ["data/", "results/"] # declared write paths, containment-checked
    artifacts: ["results/**/*.csv", "results/**/*.json"]
    environment: []               # only explicitly declared env vars are passed
    output_strategy: tail         # head | tail (default tail)
    max_lines: 2000               # Pi's official default
    max_bytes: 51200              # Pi's official default (~50 KB)
    params:
      - { name: symbol, type: string, required: true }
```

Security invariants:

1. `command` must be an argv array; a shell string is rejected at parse time.
2. The model passes only the recipe name and schema-approved `params`.
3. `shell=false` always; commands are spawned directly, never through a shell.
4. No shell strings are assembled from parameters — `{{name}}` placeholders are
   substituted into argv entries.
5. Every argv entry goes to `pi.exec` individually.
6. `cwd` is normalized and must stay inside the project root.
7. `writes` and `artifacts` must stay inside the project root.
8. `../`, absolute paths and **symlink escapes** are rejected (lexical +
   realpath containment).
9. `timeout_ms` and the session `AbortSignal` are forwarded to the process.
10. Exit codes outside `expected_exit_codes` (and timeouts/cancellations) are
    failures.

## Running recipes

Custom tools (callable by the model):

| Tool | Purpose |
| ---- | ------- |
| `workbench_project_inspect` | Project root, git state, detected language/package manager, profile, recipes, config errors. Never outputs secrets. |
| `workbench_run_recipe` | Run a declared recipe only. Streams short progress; returns a structured summary; full output lands on disk. |
| `workbench_read_run` | Read a run record by `run_id`: manifest, summary, bounded log tails. Never sends full large logs inline. |
| `workbench_run_gate` | Run the validation ladder (gate id, comma list, `base`, `quant`, `all`). |
| `workbench_read_gate` | Read a gate run record by `run_id`, or a gate definition by `gate_id` (with latest status). |
| `workbench_list_gates` | List the gates available for the current profile with their latest status. |
| `workbench_compare_runs` | Compare two run records by `run_id`: exit code, duration, artifact changes, gate delta, quant metrics (read-only; also available in AUDIT). |
| `workbench_delegate_worker` | DEV only: GPT-5.6 Sol delegates one scoped task to pinned `deepseek-v4-flash:max`; worker cannot recurse, use free bash, run final gates, or write outside approved paths. |

Commands (same services, no duplicated logic):

```
/q-run <recipe> [key=value ...]   # run a declared recipe
/q-runs [limit]                   # list recent runs
/q-run-show <run-id>              # manifest + bounded log tails
/q-gate <id|base|quant|all>       # run gates (manual:<check-id>=<note> adds manual evidence)
/q-gates                          # list gates for this profile with latest status
/q-gate-show <gate-id>            # show a gate definition
/q-evidence <run-id>              # bounded evidence of a gate run
/q-report latest|<run-id>         # run report: manifest, gates, quant facts
/q-compare <run-id-a> <run-id-b>  # diff two run records
/q-widget on|off                  # force the widget on/off (it auto-shows during tasks and gate failures)
```

### Run artifacts

Each run writes `<project-root>/.pi/workbench/runs/<run-id>/`:

```
manifest.json      # schema_version, run_id, recipe, profile, started/finished_at,
                   # duration_ms, cwd, argv, exit_code, timed_out, cancelled,
                   # git_commit, git_dirty, artifact_paths, stdout/stderr_truncated
command.json       # final argv, cwd, timeout, strategy, limits, env names
environment.json   # env actually passed to the process (values redacted when secret)
stdout.log         # full stdout (redacted)
stderr.log         # full stderr (redacted)
summary.json       # bounded summary for tools/commands
artifacts/         # JSON artifact snapshots (recipe runs, <= 1MB) and gate evidence copies
```

**Never written to records:** API keys, tokens, full environment, auth
material. Env values whose names look like secrets (`*API_KEY*`, `*TOKEN*`,
`*SECRET*`, `*PASSWORD*`, `*AUTH*`, ...) and well-known credential shapes are
redacted from every artifact.

**P4 snapshots:** declared JSON artifacts (<= 1MB) are copied into
`artifacts/` at run time so later runs overwriting the same project file can
never corrupt earlier records — `/q-compare` and quant reports read only
run-attributed copies (a live-file fallback exists only for runs recorded
before P4).

### Output limits

Truncation uses Pi's official helpers (`truncateHead`/`truncateTail` with
`DEFAULT_MAX_LINES` = 2000 lines and `DEFAULT_MAX_BYTES` ≈ 50 KB). Command logs
default to tail-first. Full content always goes to the log files, and every
result returned to the model states the full log paths. `workbench_read_run`
returns bounded tails (200 lines / 20 KB by default).

## Validation gates (P3)

A gate is a named validation stage with a list of checks. Gates form a
ladder: each gate may declare `prerequisites`, and a non-PASS outcome of a
blocking prerequisite BLOCKs its dependents. The built-in catalog provides:

| Base gates (every profile) | Quant gates (quant-research profiles only) |
| -------------------------- | ------------------------------------------ |
| `b0` Project Readiness | `q0` Research Contract |
| `b1` Static Quality | `q1` Market Data Integrity |
| `b2` Unit Correctness | `q2` Backtest Semantics |
| `b3` Integration Correctness | `q3` Experiment Integrity |
| `b4` Output Contract | `q4` Out-of-Sample Robustness |
| `b5` Reproducibility and Handoff | `q5` Strategy Reporting |

### Gate and check schema

Declared in `.pi/workbench/gates.yaml` (a project gate with a built-in id
replaces the built-in; empty `gates: []` means "use the built-in catalog",
so existing projects keep working). Each gate supports: `id`, `title`,
`description`, `profiles`, `prerequisites`, `required`, `blocking`,
`evidence` (declared evidence globs), `acceptance`, `checks`.

Each check supports one of these kinds:

| Kind | Verifies |
| ---- | -------- |
| `config` | workbench config (project/recipes/gates/profiles) parses with zero issues |
| `recipe` | a declared recipe runs with the expected exit code (`recipes:` lists alternatives; the first declared one runs) |
| `artifact` | the most recent persisted run of a recipe produced artifacts (optional `glob` filter) |
| `file` | a project file exists (`path` or `any_of` globs) |
| `json` | a JSON artifact field exists (`path`), equals a value (`equals`), or one of several exists (`any_of_paths`) |
| `numeric` | a JSON artifact number is finite and within `min`/`max` (paths support array `.length`, e.g. `folds.length`) |
| `schema` | an artifact conforms to the built-in `quant-result` contract |
| `manual` | explicit manual evidence (prompt describes what is required) |

```yaml
# .pi/workbench/gates.yaml
gates:
  - id: q4
    title: Out-of-Sample Robustness
    prerequisites: [q3]
    checks:
      - { id: q4.1, title: OOS range, kind: json, file: results/quant-result.json, path: split.test }
      - { id: q4.2, title: Multi-fold, kind: numeric, file: results/quant-result.json, path: folds.length, min: 2 }
      - { id: q4.3, title: Parameter stability, kind: manual, prompt: "Evidence that neighboring parameter values give similar results." }
```

### Status rules

Statuses are exactly `PASS`, `FAIL`, `BLOCKED`, `NOT_RUN`:

- A **required** check that is `NOT_RUN` can never make a gate PASS.
- A `FAIL`/`BLOCKED`/`NOT_RUN` outcome of a **blocking** prerequisite BLOCKs
  dependents (prerequisite status resolves from the current run first, then
  from the most recent persisted gate run).
- Warnings never upgrade a status; a check with no verified assertion is
  `NOT_RUN` or `FAIL`, never PASS.
- Numeric constraints are only evaluated against structured artifacts.
- Manual evidence is only ever recorded as type `manual` in evidence.json —
  model prose can never masquerade as machine verification.
- Every evidence path is containment-checked (lexical + symlink-aware
  realpath); escaping paths abort the run with a setup error.

### Gate run artifacts

Each gate run writes `.pi/workbench/runs/<run-id>/`:

```
manifest.json   # same shape as recipe runs (recipe: "gate", exit 0 iff PASS)
gates.json      # per-gate: id, status, prerequisites + prerequisite_status,
                # checks (id/status/kind/required/blocking), evidence paths,
                # failure_reason, blocked_reason, timestamps
evidence.json   # per-check evidence records (types: config/recipe_run/
                # artifact/file/json/numeric/manual/schema)
summary.json    # overall status, per-gate statuses, counts, bounded stdout
stdout.log      # engine progress log (full)
stderr.log      # (empty on success)
artifacts/      # copied evidence sources (artifacts, configs, recipe summaries)
```

## Quant output contract (P3)

`schemas/quant-result.schema.json` defines the output contract for quant
research artifacts (`results/quant-result.json` by convention). The workbench
**never computes strategy metrics** — it only validates what the target
project declares:

- `schema_version`, `run_id`, `strategy_type`, `frequency`, `universe`,
  `data_range`, `split` (method: walk-forward / train-validation-test /
  time-series / custom), `benchmark`, `costs`
- `metrics`: `return`, `volatility`, `drawdown`, `turnover`, `exposure`,
  `benchmark_delta`, plus at least one risk-adjusted metric
  (`sharpe`/`sortino`/`calmar`/`information_ratio`)
- `folds`: full trial reporting — every fold is recorded, **failed folds are
  never filtered**; a `passed` fold must carry metrics
- `parameters`, `artifacts`; optional `warnings`, `semantics`
- profile-specific optional fields: stock-selection
  (`universe.point_in_time`, `exposure`, `rebalance`), market-timing
  (`regime`, `position_sizing`)

All numbers must be finite (`1e999` parses to Infinity and is rejected). The
Q0 research contract lives in `research/contract.json` (strategy type,
universe, frequency, benchmark, signal/execution assumptions, acceptance
criteria). Audits that cannot be machine-verified (look-ahead, survivorship,
parameter stability, ...) are manual-evidence checks.

## Package installation (local)

```bash
npm install --ignore-scripts   # devDependencies (TS, tsx, pi types) + yaml runtime dep
pi install -l .                # register this package in project settings
pi -a -p "/q-status"           # non-interactive smoke test (print mode)
```

## Project trust flow

1. `ctx.isProjectTrusted()` gates **all** workbench config reads and recipe
   execution. Untrusted projects are refused with an explicit message.
2. After `/q-init` (or when entering a new project): exit Pi, re-enter the
   project directory, and approve project trust when prompted.
3. Workbench never silently reads or executes config without trust.

## Security model (no fake sandbox)

- **Pi has no built-in sandbox.** Pi, extensions, and this package inherit the
  system permissions of the user account that launches them. There is no
  sandbox here, and this README makes no sandbox claim.
- **The Recipe Runner is not an OS sandbox.** Recipe restrictions (argv-only
  commands, path containment, env allow-list, redaction) are process-level
  discipline and guardrails. A recipe still runs with the full permissions of
  your user: it can read anything you can read and modify anything inside the
  project root. Redaction hides secrets from *records*; it does not stop a
  process from *using* them.
- **Mode restrictions are guardrails, not a security boundary.** The
  `tool_call` guard is a second layer of discipline, not an isolation
  mechanism. It blocks destructive commands (P5 token-based list above),
  blocks writes to protected credential paths in every mode, and blocks
  reads of them in AUDIT/VERIFY.
- **Protected paths (P5)** are matched by basename — a file named
  `credentials/anything` is only protected if the *file* name matches
  (`credentials.*`, ...). DEV may read `.env` (content enters the session
  transcript); no mode may write one. `.env.example`/`.env.template` are
  always readable.
- For untrusted repositories or unattended automation, run Pi in a
  container/VM per Pi's security documentation.
- Only install this package from sources you trust; review its source before
  use (extensions execute arbitrary code in your Pi session).

## Skills

| Skill | Purpose |
| ----- | ------- |
| `repository-orientation` | Map an unexplored repo: git, entry points, deps, tests, config |
| `repository-audit` | Read-only audit; findings classified confirmed / probable / unknown |
| `implementation-workflow` | Contract → implement → test → verify → evidence → risk |
| `debugging-workflow` | Reproduce → preserve error → root cause → regression verify |
| `validation-ladder` | PASS / FAIL / BLOCKED / NOT_RUN verdicts with evidence |
| `cli-product-development` | CLI/script product quality: interface, streams, exit codes, tests |
| `handoff-and-release` | Handoff notes, changelog, versioning, release verification |
| `quant-research-design` | Hypothesis, universe, benchmark, evaluation plan before coding |
| `market-data-integrity` | Point-in-time, survivorship, delisting, adjustments, timestamps |
| `stock-selection-research` | Cross-sectional selection: universe, ranking, construction, attribution |
| `market-timing-research` | Timing: signal/execution timing, entry/exit, sizing, walk-forward |
| `backtest-integrity` | Leakage, look-ahead, costs, suspensions, delisting, benchmark alignment |
| `experiment-validation` | Out-of-sample discipline, full trial reporting, stability |
| `strategy-reporting` | Results vs benchmark, risk, robustness, limitations, reproducibility |

Each skill ships a focused `SKILL.md` plus detailed checklists in
`references/*.md` (loaded on demand). The quant skills are scoped to
mid/low-frequency research: no order-book, tick-replay, queue-model,
market-making, colocation, latency, or exchange-execution content.

## Prompt templates

| Template | Purpose |
| -------- | ------- |
| `/q-audit` | Read-only audit; findings classified confirmed / probable / unknown |
| `/q-plan` | Goal → phased plan, every phase with a verifiable Gate; no code changes |
| `/q-build` | Real implementation; contract first; tests in sync; no stubs/TODOs |
| `/q-debug` | Reproduce first, preserve the original error, fix root cause, regression-verify |
| `/q-verify` | No source changes; declared recipes/gates only; PASS/FAIL/BLOCKED/NOT_RUN |
| `/q-optimize` | Engineering optimization or parameter experiments; full trial reporting; OOS required |
| `/q-review` | Review diff/commit/implementation: logic, tests, compatibility, omissions |

All templates accept `argument-hint` args and `$ARGUMENTS`. No template name
collides with an extension command (`q-mode-*`, `q-status`, `q-init`, `q-run*`).

## Package manifest

`package.json` declares the Pi manifest (`pi` key): `./extensions`, `./skills`,
`./prompts`. Pi core packages are `peerDependencies` (`"*"` — Pi bundles them
at runtime); the same packages are pinned in `devDependencies` for local
typecheck and tests. **`yaml` is a runtime `dependency`** (used by the config
loader); it is not a peer dependency.

Tested environments (only claims backed by actual runs — see
[docs/compatibility.md](docs/compatibility.md) and
[compatibility/pi.json](compatibility/pi.json)): Pi **0.83.0** (TUI, `-p`
print, `--mode json`), pi-tui 0.83.0, Node **v24.13.0**, npm **11.18.0**,
CachyOS Linux (kernel 7.1.5-1-cachyos, x86_64), typebox 1.3.7, yaml 2.9.x.
Other versions are untested — no compatibility is claimed for them.

## State recovery and compaction (P5)

- The mode and key task state are stored in Pi **custom session entries**
  (`workbench-mode`, `workbench-state`) and restored on every
  `session_start` — `/new`, `/resume`, `/fork`, `/clone` and `/reload` all
  reach that handler; a fresh `/new` session falls back to DEV.
- On `session_before_compact` the workbench only **supplements** Pi's own
  compaction (it never cancels it and never replaces its summary): when
  there is meaningful state it persists a bounded entry and injects a
  hidden (`display: false`) next-turn note with task, mode, passed/failed
  gates, modified files, evidence paths, next step, and repeated-failure
  do-not-retry warnings. Notes are capped (40 lines / 2.4 KB), redacted,
  deduplicated, and contain only pointers — **run logs never enter the
  session context**.

## Development

```bash
npm install --ignore-scripts
npm run typecheck              # tsc --noEmit
npm test                       # node:test via tsx (mode policy, config, schema,
                               # path guard, runner, init, templates, gates,
                               # quant-result contract, package content)
npm run check                  # typecheck + tests + git diff --check
npm run cache:report           # offline cache benchmark (telemetry + runs + action cache)
npm run cache:doctor           # offline cache health checks (exits non-zero on FAIL)
```

## Roadmap

- **P0 (previous):** bootstrap — modes, commands, status, skills, templates, tests.
- **P1 (previous):** project config, `/q-init`, declarative recipes,
  controlled Recipe Runner (`workbench_*` tools + `/q-run` family), run
  records with redaction, output truncation, VERIFY without free bash.
- **P2 (previous):** full general-development skills (7) and
  quantitative-research skills (7) with `references/*.md` checklists; seven
  `q-*` prompt templates; project templates under `templates/project/`
  (AGENTS + per-profile configs); `/q-init` writes `AGENTS.md` by profile
  without overwriting existing ones; package-content tests.
- **P3 (previous):** gate enforcement (`gates.yaml`), built-in base
  gates B0-B5 and quant gates Q0-Q5, gate runs with evidence artifacts,
  `quant-result.schema.json` output contract (the workbench validates
  declared output — it never computes strategy metrics), `/q-gate` command
  family, `workbench_run_gate` / `workbench_read_gate` /
  `workbench_list_gates` tools.
- **P4 (previous):** Pi-native TUI status (`setStatus` slot, footer
  never replaced), auto-hiding widget (`setWidget`), `/q-report`,
  `/q-compare`, `/q-widget`, `workbench_compare_runs`, compact tool
  renderers for the five workbench tools, JSON artifact snapshots per run.
- **P5 (previous):** protected-path policy, token-based command guard,
  state recovery via custom entries, compaction supplements
  (`session_before_compact`), compatibility matrix + docs, final
  release-readiness audit.
- **P6 (this release):** DeepSeek prompt-cache observability (P6-A,
  hash-only telemetry + `/q-cache-*`), stable-prefix contract (P6-B),
  deterministic recipe action cache (P6-C), quant cache contracts (P6-D),
  and the offline cache benchmark + release gate (P6-E, this file's
  `cache:report`/`cache:doctor`). See
  [docs/cache/P6_RELEASE_REPORT.md](docs/cache/P6_RELEASE_REPORT.md).
- **Later:** walk-forward and parameter-experiment tooling as Pi custom
  tools, project-defined JSON schemas for `schema` checks, all within the
  quantitative scope above.

## Layout

```
extensions/workbench-runtime/   # Pi extension
├── index.ts                    # commands, custom tools, renderers, status/widget wiring
├── cache/                      # P6: telemetry, stable-prefix, action cache, quant contracts,
│                               #     cache-report/doctor (P6-A..D) — see docs/cache/
├── schemas/
│   └── quant-result.schema.json # quant output contract (validated, never computed)
├── ui/
│   └── tool-renderers.ts       # P4 TUI renderers (theme-colored Text components)
└── core/
    ├── mode-policy.ts          # AUDIT/DEV/VERIFY tool sets + hard guard logic
    ├── state.ts                # mode persistence (session entries)
    ├── config.ts               # project root detection, config loading, trust gate
    ├── recipe-schema.ts        # strict recipe validation, argv construction
    ├── recipe-runner.ts        # the single execution service (tools + commands)
    ├── runs.ts                 # run ids, manifests, bounded log reads
    ├── path-guard.ts           # lexical + realpath containment
    ├── redact.ts               # secret detection/redaction for run records
    ├── gate-schema.ts          # gate/check schema, gates.yaml parsing, catalog merge
    ├── gate-catalog.ts         # built-in gates B0-B5 and Q0-Q5
    ├── gate-engine.ts          # gate runs, evidence, persistence
    ├── quant-result.ts         # quant output contract validation
    ├── format.ts               # P4 display formatting (duration, deltas, width fit)
    ├── status.ts               # P4 footer status line builder
    ├── widget.ts               # P4 widget visibility + lines
    ├── report.ts               # P4 run reports, gate-run summaries, quant artifacts
    ├── compare.ts              # P4 run comparison (generic + quant deltas)
    ├── render.ts               # P4 pure renderer line builders + details payloads
    ├── templates.ts            # generic / stock-selection / market-timing templates
    ├── init.ts                 # q-init planning + application
    └── inspect.ts              # project inspection service
skills/                         # fourteen SKILL.md skill packages (7 general + 7 quant)
prompts/                        # q-audit/q-plan/q-build/q-debug/q-verify/q-optimize/q-review
templates/project/               # AGENTS templates + per-profile config templates (loaded by /q-init)
tests/                          # unit + integration tests (node:test)
scripts/cache-benchmark.ts      # P6-E offline benchmark CLI (cache:report / cache:doctor)
```
