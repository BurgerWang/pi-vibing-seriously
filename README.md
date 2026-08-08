# pi-dev-workbench

<p align="center">
  <img src="assets/banner.svg" alt="pi-dev-workbench v0.9.0 — a Pi-native development workbench" width="586" />
</p>

A **Pi Package** (v0.9.0, P7) that adds a native development workbench to
[Pi](https://pi.dev): a mode policy (AUDIT / DEV / VERIFY), project
configuration, a declarative Recipe Runner, a **Gate Engine with evidence
artifacts and a quant research validation ladder**, Pi-native TUI status,
run reports and run comparison, workbench skills, `q-*` prompt templates,
project templates, and **provider prompt-cache telemetry for DeepSeek and OpenAI Codex**
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
verification. The default is **worker-first write authority**: approved
GPT-5.6 Sol resolves to the fixed `worker-first-strict` policy in DEV, which
advertises exactly the canonical 15-tool allowlist — no `bash`/`edit`/`write`
and no foreign tools — so implementation and repair writes go to a fresh
bounded worker by default (coherent source+tests+docs vertical slices for
bounded low/medium-risk work after minimum repository orientation: the worker
owns routine local implementation decisions inside the approved contract,
while Sol owns requirements, cross-cutting architecture, scope, actual-diff
review, final gates, and the verdict). Temporary commander direct writes are
the explicit exception: the human issues a bounded lease through user-only
slash commands (`/q-commander-write-unlock`), and only an active confirmed
lease adds `edit`/`write` to Sol's strict set. Every delegation is recorded
in a bounded before/after ledger that starts `PENDING_REVIEW`; a pending or
stale review blocks the next delegation and VERIFY until Sol reviews the
actual diff (`workbench_review_worker_diff`). The worker's context is
budget-protected — per-message context safety, unchanged: 1,000,000-token
window, one hidden steer at 80% (800k), fail-closed termination at 90%
(900k), worker compaction cancelled, commander compaction unchanged. Every
delegation additionally runs under a fixed **cumulative spend budget**
(turns / total tokens / output tokens across the whole run; optional
`budget_profile` — see
[Worker cumulative spend budget](#worker-cumulative-spend-budget)).

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
| AUDIT  | read, grep, find, ls, workbench_project_inspect, workbench_read_run, workbench_read_gate, workbench_list_gates, workbench_compare_runs, workbench_recover_tool_result | bash, edit, write, workbench_run_recipe, workbench_run_gate, workbench_delegate_worker | Read-only inspection       |
| DEV    | For approved GPT-5.6 Sol (`worker-first-strict`): the exact canonical 15-tool allowlist (read, grep, find, ls + all 11 `workbench_*` tools) — no bash/edit/write, no foreign tools; an ACTIVE user-issued lease additionally enables exactly its edit/write tools (15 → 17 active tools). Other controllers: read, grep, find, ls, bash, edit, write, all `workbench_*` tools. | For strict Sol: bash always; edit/write without an active lease or outside its paths; any tool outside the allowlist. | Implementing features and fixes |
| VERIFY | read, grep, find, ls, workbench_project_inspect, workbench_run_recipe, workbench_read_run, workbench_run_gate, workbench_read_gate, workbench_list_gates, workbench_compare_runs, workbench_recover_tool_result | bash, edit, write, workbench_delegate_worker | Re-verifying completed work |

- `/q-mode-audit` — switch to AUDIT
- `/q-mode-dev` — switch to DEV (default)
- `/q-mode-verify` — switch to VERIFY (refused while a worker review is
  pending or stale: `PENDING_REVIEW`/`STALE` blocks final gate verification
  until the current diff is reviewed)
- `/q-status` — current mode, cwd, project trust, active tools, registered workbench tools

The mode is stored in a Pi custom session entry (`workbench-mode`) and restored
from the current session on `session_start`. All UI calls degrade safely in
print/json/RPC modes.

**P7 worker-first write authority:** the strict Sol DEV tool set is fixed and
policy-bound — approved GPT-5.6 Sol always resolves to `worker-first-strict`
(a persisted/prompt/config value can neither weaken nor opt out of it), and
`detectActorRole` derives identity only from the existing
`WORKBENCH_AGENT_ROLE=worker` env contract and the provider/model pair, never
from project config. Delegated workers keep the existing worker guards
(no recursion, no free bash, no final gates, parent-approved write paths), and
other controllers are outside the policy — they are not newly denied. `bash`
is always blocked for strict Sol; `edit`/`write` require a valid user-issued
temporary write lease (see [Worker-first workflow](#worker-first-workflow)).
AUDIT/VERIFY remain strict for every actor.

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
- **Split-cost segment** in the status line — `COST S:$19.195 W:$0.063
O:$0.424` (O omitted when zero, S and W always shown) — splits session cost
from session entries into commander (assistant usage), worker
(`workbench_delegate_worker` tool results) and other (other tool results,
branch summaries, compaction). The Pi footer itself is never replaced;
`/q-cost-status` prints the exact amounts plus the per-model commander
breakdown in TUI and print/json modes.
- **Commander advisory segment** in the status line — `CMD:SOFT` or
`CMD:HIGH` — appended only when the observation-only advisory band is
triggered (an OK session adds no advisory segment). It is derived from the
SAME current session breakdown as the COST segment (pending-message-aware,
with the existing dedup semantics) against the documented defaults or the
trusted project.yaml thresholds (see
[Commander advisory](#commander-advisory-p7--observation-only-no-hard-stop)).
- **Run reports**: `/q-report latest | <run-id>` — manifest facts, gates and
failed checks for gate runs, declared quant facts for quant runs.
- **Run comparison**: `/q-compare <run-id-a> <run-id-b>` (or the
`workbench_compare_runs` tool) — exit code, duration, artifact changes, gate
delta, test counts, and (for quant runs) benchmark/return/drawdown/turnover/
cost/fold deltas and parameter changes. Deltas are descriptive: **a higher
return is never automatically interpreted as a better strategy**.
- The five P4 workbench tools have compact TUI renderers (partial/error/expanded
states included); expanded shows recipe, duration, exit code, artifacts,
failed checks and log paths. Facts come only from the runs' own JSON records
(manifest/gates/result) — renderers never recompute business metrics. The
three P7 delegation tools (`workbench_delegate_worker`,
`workbench_review_worker_diff`, `workbench_delegation_status`) have **no**
compact renderers — they render through Pi's default text fallback; no more
renderers exist than the P4 five.
- **P7 write-authority segments** in the status line — `WF:LEASE 2/10` for an
ACTIVE confirmed strict-Sol lease, `WF:LOCKED` for every other lease state
(locked/pending/expired/exhausted/revoked), and `WF:REVIEW` (appended
independently) while a delegation review is pending or stale. Workers and
other controllers render no WF segment. Confirmation token parts never
appear in any status summary.

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

- `project.yaml` — `name`, `description`, `profile`, optional `project_dir`,
  optional `cache.telemetry`, optional `cache.actionCache.maxBytes`, optional
  `commander.advisory` (see [Commander advisory](#commander-advisory-p7--observation-only-no-hard-stop))
- `recipes.yaml` — declarative recipes
- `gates.yaml` — gate declarations (enforced since P3; empty `gates: []` uses the built-in catalog)
- `profiles.yaml` — profile definitions

Project root detection: `git rev-parse --show-toplevel` first, `ctx.cwd` for
non-git projects. **No project configuration is read or executed unless
`ctx.isProjectTrusted()` is true.**

### Nested projects (`project_dir`, P8)

`project.yaml` accepts an optional `project_dir` — a **relative** path to a
directory inside the repository that acts as the *effective project root*:

```yaml
name: monorepo-research
profile: quant-research/stock-selection
project_dir: research/stock-selection
```

Boundaries (P8):

- **Repository root vs effective root.** Every service still receives the
  repository root: `.pi/workbench` config, run records, git state and
  delegation stay at the repository root, and recipe `cwd` semantics are
  unchanged. The effective root only changes **stack detection** (top-level
  language/package-manager files are read from the effective root) and the
  **gate file-type content checks** (`kind: file` and the files read by
  `json` / `numeric` / `schema` checks; resolved relative to the effective
  root with realpath containment). The one built-in exception is b0.4
  "Required workbench files present": the workbench configuration always
  lives at the repository root, so b0.4 anchors at the repository root via
  internal catalog-only metadata (never settable from gates.yaml — the
  public gate schema has no `root`/`file_root` option) and a nested
  `.pi/workbench` can never satisfy it. Gate config, recipe
  checks/execution, artifact run records and git stay repository-root
  based.
- **Safety.** POSIX absolute (`/x`) and Windows absolute (`C:\x`, `C:/x`,
  `\x`, `\\server\share`, `C:x`) values, paths that resolve outside the
  repository via `..`, and symlink escapes are rejected; the target must
  exist and be a directory. An invalid `project_dir` is recorded as a
  `project.yaml` config issue and falls back to the repository root — the
  effective root never points outside the repository and nothing outside it
  is ever read. Symlinks inside the repository are fine.
- **Default / compatibility.** Omitted (or `"."`), the effective root is
  the repository root — existing projects keep their exact behavior.
  `workbench_project_inspect` shows the effective root explicitly.

### Commander advisory (P7 — observation-only, no hard stop)

The workbench evaluates five **cumulative commander-session observability
facts** from the existing session cost breakdown (the same facts the COST
segment uses) against configurable soft/high advisory thresholds
(`core/commander-advisory.ts`, pure — commander-token-optimization plan §6
P7):

| Dimension | Soft (default) | High (default) |
| --------- | -------------- | -------------- |
| `requests` (commander assistant turns) | 200 | 300 |
| `gross_tokens` (input + output + cacheRead + cacheWrite) | 25,000,000 | 40,000,000 |
| `output_tokens` (commander output) | 125,000 | 200,000 |
| `tool_text_bytes` (inline TEXT bytes over tool results) | 3,500,000 | 5,000,000 |
| `compactions` | 5 | 8 |

Boundaries are **inclusive `>=`** (a dimension reaches `soft` exactly at its
soft threshold and `high` exactly at its high threshold), and the overall
band is the **highest per-dimension band** (HIGH overrides SOFT). Reasons
are the triggered dimensions in the fixed order above, each carrying its own
band.

Optional thresholds come from trusted `project.yaml` (values inherit the
documented defaults additively):

```yaml
# .pi/workbench/project.yaml
name: research
profile: quant-research/stock-selection
commander:
  advisory:
    soft:
      requests: 200
      gross_tokens: 25000000
      output_tokens: 125000
      tool_text_bytes: 3500000
      compactions: 5
    high:
      requests: 300
      gross_tokens: 40000000
      output_tokens: 200000
      tool_text_bytes: 5000000
      compactions: 8
```

Every value must be a **positive safe integer** and every `high` value must
be **greater than** its `soft` value. Invalid values, unknown keys, and
`high <= soft` ordering violations are recorded as bounded `project.yaml`
ConfigIssue evidence (visible through `workbench_project_inspect`) and fall
back safely to the documented defaults — a malformed config **never disables
observability and never crashes the runtime**.

**Display behavior.** When the band is not `ok`, the TUI footer appends
`CMD:SOFT` or `CMD:HIGH` after the existing segments (an OK session adds
nothing). `/q-cost-status` renders the full advisory facts — band, all five
current values, effective soft/high thresholds, and the triggered reasons —
after its existing cost output, in TUI and print/json modes alike; the
trusted thresholds are loaded best-effort and the command is **never
trust-gated** (defaults apply on untrusted/unavailable/error paths).

**Advisory only — no hard stop.** This is pure observability: advisory
paths never send steering messages, never cancel or terminate anything,
never change active tools, modes, or write authority, never block recipes,
reviews, gates, handoffs, or user responses, and create **no hard-stop
path**. Malformed, non-finite, negative, or absurdly large session facts
normalize defensively (never NaN/Infinity, bounded rendering).

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
    mutation: artifacts          # none | artifacts | source (P7)
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
11. Every recipe declares `mutation` (`none` | `artifacts` | `source`); under
    worker-first write authority, strict Sol runs only `none`/`artifacts`
    recipes and workers only `none` (write-free) recipes — `source`-mutating
    recipes are denied to both (other controllers are unaffected).

## Running recipes

Custom tools (callable by the model):

| Tool | Purpose |
| ---- | ------- |
| `workbench_project_inspect` | Project root + effective project root (`project_dir`), git state, detected language/package manager (effective root only), profile, recipes, config errors. Never outputs secrets. |
| `workbench_run_recipe` | Run a declared recipe only. Streams short progress; returns a structured summary; full output lands on disk. |
| `workbench_read_run` | Read a run record by `run_id`: manifest, summary, bounded log tails. Never sends full large logs inline. |
| `workbench_run_gate` | Run the validation ladder (gate id, comma list, `base`, `quant`, `all`). |
| `workbench_read_gate` | Read a gate run record by `run_id`, or a gate definition by `gate_id` (with latest status). |
| `workbench_list_gates` | List the gates available for the current profile with their latest status. |
| `workbench_compare_runs` | Compare two run records by `run_id`: exit code, duration, artifact changes, gate delta, quant metrics (read-only; also available in AUDIT). |
| `workbench_delegate_worker` | DEV only: GPT-5.6 Sol delegates one scoped task to pinned `deepseek-v4-flash:max`; default is coherent source+tests+docs vertical slices for bounded low/medium-risk work after minimum repository orientation. The worker owns routine local implementation decisions inside the approved contract; Sol owns requirements, cross-cutting architecture, scope, actual-diff review, final gates, and the verdict — worker prose is never acceptance. Worker cannot recurse, use free bash, run final gates, or write outside approved paths. Worker context safety (unchanged): hidden one-shot steer at 80% (800k/1M), fail-closed termination at 90% (900k), compaction cancelled in the worker role and any `compaction_start` event rejects the result. Cumulative spend budget: optional `budget_profile` (`low`/`standard`/`extended`; omitted → `standard`; `extended` explicit Sol-approved only, never inferred or auto-promoted) bounds turns/total/output tokens across the run — one hidden soft handoff steer, fail-closed hard stop, numeric-only progress. Every outcome (success **and** failure) is recorded in the delegation ledger (`.pi/workbench/delegations/<id>/`) and starts `PENDING_REVIEW`; a pending or stale review blocks the next delegation and VERIFY. |
| `workbench_review_worker_diff` | Sol reviews one delegation's actual diff: real git state vs the recorded before snapshot, every worker path scope-checked against the parent-approved `allowed_paths` (realpath/symlink-safe — `include_paths` narrows only the patch and can never hide a violation), current vs recorded after diff hash (mismatch/drift are warnings), bounded redacted patch, notes on the worker's `## Files Changed` section vs the actual diff. Verdict `PASS` marks the delegation REVIEWED (bound to the reviewed hash); `FAIL` keeps it PENDING_REVIEW. |
| `workbench_delegation_status` | Write authority + delegation review status: actor, fixed policy, lease status (bounded summary — never token parts), latest delegation, review status, current/reviewed diff hashes, blocked write attempts, latest review verdict. Refreshes against the real git diff — any change after REVIEWED turns the delegation STALE. |
| `workbench_recover_tool_result` | Read-only tool-result receipt recovery (P8b): recover a persisted two-phase receipt (schema `wtr1`) with EXACTLY ONE of `result_id` (strict `wtr1-` shape) or `tool_call_id` — the `tool_call_id` path validates the CURRENT native Pi session identity AND the parameter before deriving the id (absent/invalid/control-character/over-bound fails closed with the fixed `invalid` code). Returns only the bounded persisted receipt facts (id, tool, status, project-relative path, redacted summary, omission facts) with a fixed disclaimer; never re-executes the original call, never reads raw logs/domain records, never refreshes state, and is never acceptance evidence. Available in AUDIT/VERIFY and the strict Sol DEV allowlist; not receipted itself. |

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
/q-cost-status                    # split session cost: commander / worker / other + per-model commander
                                 #   + P7 advisory facts (band, values, thresholds, reasons — observation-only)
/q-delegation-status              # write authority + delegation review status (real git diff refresh)
/q-write-policy status            # actor, fixed worker-first-strict policy, lease lock status (user-only)
/q-commander-write-unlock ...     # user-only temporary commander write lease (issue/confirm, see below)
/q-commander-write-lock           # user-only revoke/lock of the commander write lease
/q-milestone-handoff <next step>  # USER-ONLY milestone handoff: fresh parent-linked session resuming
                                  #   mode/compact/delegation state with a hidden note (leases never carried)
```

The deterministic inventory is **29 commands, 11 workbench tools, 7 prompt
templates** (pinned by the inventory test). The three lease commands
(`/q-write-policy`, `/q-commander-write-unlock`, `/q-commander-write-lock`)
and the milestone handoff (`/q-milestone-handoff`) are **user-only**: slash
commands that are never registered as model tools.

### Worker-first workflow

Approved GPT-5.6 Sol owns requirements, cross-cutting architecture, scope,
actual-diff review, final gates, and the verdict — but **does not directly
write by default**. In DEV, Sol's strict 15-tool allowlist has no
`bash`/`edit`/`write`; implementation and repair writes go to a fresh bounded
worker via `workbench_delegate_worker`. High-risk decisions remain
commander-led — Sol keeps the decision itself and delegates only bounded
support/implementation scopes after the architecture is fixed. The explicit
exception is a **temporary commander write lease**, issued only by the human
(user-only commands, never by prompts or config):

- `/q-commander-write-unlock <reason> --paths <comma-list> --calls <N> --minutes <N>`
  — fixed reasons: `bootstrap-policy`, `worker-unavailable`,
  `security-emergency`, `user-directed`; paths are project-relative exact
  paths or `/**` subtrees (absolute POSIX, Windows drive and backslash-root
  paths are rejected before normalization, `..` escapes refused); `edit`/`write`
  only, never `bash`; **max 10 calls / max 30 minutes** (one call consumed per
  successful authorized write).
- Confirmation is mode-split: in the real **TUI** an explicit human
  confirmation dialog is required (cancel leaves everything locked); in
  **non-TUI** (print/json/RPC) the lease is issued PENDING with two bounded
  distinct confirmation token parts displayed once, and a second invocation
  `/q-commander-write-unlock confirm <partA> <partB>` (optionally
  `confirm <lease-id> <partA> <partB>`) activates it — both exact parts are
  required and both are consumed on success. Token parts never appear in
  status/compact summaries.
- Expiry (30 min), exhaustion (10 calls) and revocation (leaving DEV, model/
  provider change, session end, or `/q-commander-write-lock`) restore the
  exact canonical 15 tools; the footer shows `WF:LEASE <used>/<max>` while
  active and `WF:LOCKED` otherwise. `/q-write-policy status` accepts exactly
  the trimmed `status` subcommand and prints actor, fixed policy, lock status
  and a bounded lease summary — never any token part.

### Worker cumulative spend budget

Beyond the unchanged per-message context safety (1,000,000-token window,
800k soft steer, 900k hard stop), every delegation run is also bounded by a
**cumulative spend budget** (`core/worker-spend.ts`): turns, cumulative
total tokens, and cumulative output tokens accumulated across the whole
run. The profile is fixed per delegation — never switched mid-run:

| Profile | Soft — one hidden handoff steer (turns / total / output) | Hard — fail-closed stop (turns / total / output) |
| ------- | ------------------------------------------------------- | ------------------------------------------------ |
| `low` (explicit opt-in) | 8 / 750,000 / 40,000 | 12 / 1,250,000 / 75,000 |
| `standard` (default) | 24 / 3,000,000 / 120,000 | 36 / 5,000,000 / 200,000 |
| `extended` (explicit Sol-approved only) | 48 / 8,000,000 / 200,000 | 64 / 12,000,000 / 300,000 |

Semantics:

- **Counting.** `cacheRead` tokens count in the cumulative total (cache-hit
  input is billed, so it is real spend); malformed, non-finite or negative
  usage and state normalize defensively to zero — never NaN, never a throw.
  "Reached" means at or above the limit (`>=`).
- **Band.** Any hard dimension reached → `hard` (hard always wins over
  soft); else any soft dimension → `soft`; else `ok`. Triggered reasons are
  listed in the fixed order `turns`, `total_tokens`, `output_tokens`.
- **Soft.** The first time the band is soft, the worker-role lifecycle
  sends exactly one hidden worker-only handoff steer (`display: false`,
  `deliverAs: "steer"`): stop new implementation, finish the change in
  flight, write the concise handoff, and list the remaining work. The steer
  is a request, not enforcement.
- **Hard.** Any hard dimension → the runner terminates the child
  fail-closed. The outcome is recorded in the delegation ledger and starts
  `PENDING_REVIEW` exactly like every other outcome — the ledger/review
  workflow is preserved; a hard stop never bypasses review.
- **Selection.** `budget_profile` is an optional tool parameter (`low` |
  `standard` | `extended`); omitted resolves deterministically to
  `standard`. `low` is an explicit tighter opt-in; `extended` is explicit
  Sol-approved only and is never inferred or auto-promoted. The profile
  bounds cumulative spend only — it never expands parent-approved
  path/scope authority:

```json
{
  "task": "Implement the documented slice with source, tests and docs",
  "allowed_paths": ["src/", "tests/", "README.md"],
  "acceptance_criteria": ["Declared check recipe passes"],
  "budget_profile": "low"
}
```

- **Progress and records.** Progress callbacks carry numeric-only
  cumulative spend facts (turns / totalTokens / outputTokens / band, plus
  provider and model identity) — never worker text, reasons, report
  content, patches, or logs. Final delegation records gain additive,
  backward-compatible spend facts (resolved profile, final state, band,
  triggered reasons) on every outcome; pre-repair records without them
  still parse and are never rewritten.
- **Collaboration guidance.** Size every delegation as ONE coherent
  source+tests+docs vertical slice with ample headroom BELOW its soft
  thresholds — soft is a handoff reserve, hard is failure; neither is a
  planning target. Unknown-root-cause work is split into bounded diagnosis,
  a Sol architecture/scope decision, then bounded implementation — never
  one open-ended worker task. Budgets never expand approved paths or scope.
- **Activation.** For an existing historical Commander session in this
  project, run `/reload` while idle so future delegations use the new code;
  completed or in-flight old delegations are not retroactively budgeted.
  Workers remain fresh `--no-session` processes on every delegation.
- **Deferred.** Adaptive reasoning (provider reasoning-effort control)
  remains deferred and not scheduled pending provider capability evidence;
  budget profiles remain fixed per delegation. Session
  cost stays observational (the `COST S:…` status segment and
  `/q-cost-status`) rather than enforced — the spend budget enforces
  token/turn counters only.

### Tool-result receipt recovery (P8b)

Every registered workbench tool — the public recovery tool itself excepted —
writes a durable two-phase **tool-result receipt** under the gitignored
`.pi/workbench/tool-results/` directory (schema `wtr1`; 0700/0600, atomic
no-overwrite publish), wired into Pi's native tool lifecycle:

- **BEGIN (pre-execute).** At the END of the `tool_call` guard — after every
  worker/commander/mode/path/lease policy check has allowed — the call
  begins an exclusive `<id>.started` receipt and only then executes. The
  result id is deterministic: `wtr1-` + SHA-256 of the canonical binding of
  the CURRENT native Pi session identity and the exact Pi `toolCallId`; the
  exact tool name and a canonical hash of the raw input are persisted
  identity facts — raw arguments, session identity and toolCallId are never
  persisted. A matching completed replay, an incomplete/corrupt/conflicting
  receipt, an invalid identity, or a storage failure blocks the call
  fail-closed with a short fixed reason and a recover instruction — the
  tool never re-executes (exact same-toolCallId identity only).
- **Capacity blocks, never evicts.** When the in-memory receipt handle map
  is already at `MAX_IN_FLIGHT_RECEIPTS` (256), a new registered workbench
  call is blocked BEFORE BEGIN/execution with a fixed bounded reason;
  existing pending handles are never evicted and nothing is begun for the
  blocked call, so no orphaned started receipt is left behind.
- **FINALIZE (exact dual match).** One `tool_result` handler finalizes ONLY
  a handle begun by this runtime with the EXACT same `toolCallId` AND the
  exact same tool name — a mismatch never finalizes (the started receipt
  stays incomplete on disk and only a bounded `tool_name_mismatch` fact is
  reported). Text blocks only, env-secret values scrubbed, status
  success/error, and a redaction-first bounded summary (≤ 2048 bytes / 20
  lines; error ≤ 512 bytes / 8 lines) published atomically as `<id>.json`
  with no-overwrite semantics before Pi emits the final result events. On
  success, safe structured recovery metadata (available, result id,
  project-relative receipt path/status) is merged into object details
  without changing content/isError/caps; a finalize failure never claims
  availability and never rewrites or rolls back the domain artifact.
- **Public recovery tool.** `workbench_recover_tool_result` is read-only
  and deterministic, present in AUDIT/VERIFY and the strict Sol DEV
  allowlist, appended LAST in the registration order, and NOT receipted
  itself. It takes EXACTLY ONE of `result_id` (strict `wtr1-` shape) or
  `tool_call_id`; the `tool_call_id` path validates the CURRENT native Pi
  session identity AND the parameter (absent/invalid/control-character/
  over-bound fails closed with the fixed `invalid` code and hashes
  nothing) BEFORE deriving the id. Fixed fail-closed codes: `invalid`,
  `missing`, `incomplete`, `corrupt`, `conflict`, `storage_error`.
  Recovery returns only the bounded persisted receipt facts (id, tool,
  status, project-relative path, redacted summary, omission facts) with a
  fixed disclaimer — it never re-executes the original call, never reads
  raw logs/domain records, never refreshes state, and is never acceptance
  evidence.
- **Isolation.** Receipts never touch run/cache/gate/delegation artifacts
  or execution counts; `.pi/workbench/tool-results/` is gitignored and the
  delegation ledger excludes the receipts subtree from its git facts
  exactly like its own records. Legacy no-receipt sessions (absent/invalid
  native session identity) fail closed. This repository implements **NO
  WebSocket or any other transport** — receipts are plain local files with
  no network path.

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

### Delegation records (P7)

Every worker delegation writes a bounded ledger under
`<project-root>/<CONFIG_DIR_NAME>/workbench/delegations/<id>/` (same
`run-id`-shaped id, strictly validated):

```
manifest.json        # schema_version, delegation_id, created/finished_at, status
                     # (running|finished), review_status, git head before/after,
                     # diff hashes before/after, changed-path counts
before.json          # bounded contract (task, allowed paths, acceptance criteria,
                     # verification, timeout), git HEAD/dirty, before diff hash,
                     # per-path porcelain status codes + bounded content digests
after.json           # outcome (success|failure), exit code, pinned identity,
                     # TRUE changed paths since before (digest-based, incl.
                     # previously-dirty paths), after diff hash, usage/budget
                     # facts, cumulative spend facts (resolved profile, final
                     # state, band, triggered reasons — bounded structured
                     # additive facts: no worker text, tool arguments,
                     # patches, or logs; on every outcome), bounded redacted
                     # report summary, safe reported_paths parsed from the
                     # worker's ## Files Changed section, review_status:
                     # PENDING_REVIEW
worker-summary.json  # bounded redacted worker facts (provider/model, status,
                     # exit, turns, stop reason, error, usage, budget, spend,
                     # summary)
review.json          # PENDING_REVIEW placeholder at finish; replaced by
                     # workbench_review_worker_diff with the completed record
```

Records are written atomically (tmp + rename), bounded, redacted, and never
contain full worker transcripts or secrets; the ledger's own directory is
excluded from the git facts it records. **Every delegation — success and
failure — is recorded and starts `PENDING_REVIEW`**; there is no fallback.
`PENDING_REVIEW`/`STALE` blocks the next delegation and VERIFY until the
current diff is reviewed; any diff change after REVIEWED turns the delegation
STALE. The review binds the CURRENT diff hash and warns on mismatch/drift.

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
| `b6` Worker-First Compliance (P7) |  |

**B6 is machine-backed** (P7): the runtime injects bounded worker-first
facts into every gate run — strict policy active, zero unauthorized
commander writes (or hard denial active), no pending/stale worker review,
reviewed diff hash matches the current diff, all worker paths within the
approved contracts, no active unexplained write lease, and final
verification initiated by the Sol commander. Missing facts are `NOT_RUN`
(and a required `NOT_RUN` never PASSes), a pending/stale review BLOCKs B6,
and model prose can never satisfy its checks.

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
- **Worker-first write authority is a discipline layer, not a sandbox.** The
  strict Sol DEV allowlist and the lease guard reduce the blast radius of
  commander mistakes (bash always blocked; edit/write only under an active
  human-issued lease with bounded calls, time and project-relative paths), but
  a confirmed lease still executes with the user's full permissions. Lease
  confirmation tokens are shown once at issuance, never persisted in
  summaries, and leases are revoked on leaving DEV, model change, or session
  end. The delegation ledger and review lifecycle bind every worker diff to a
  reviewed hash and block the next delegation/VERIFY while a review is
  outstanding — process discipline, not isolation.
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
  (`workbench-mode`, `workbench-state`). `/resume`, `/fork`, `/clone` and
  `/reload` reach the `session_start` restore handler with the session's
  existing entries; an ordinary `/new` starts a **fresh/DEV** session that
  copies nothing — only the explicit user-only `/q-milestone-handoff`
  command carries bounded approved state into a new session (see below).
- **P7:** the delegation review lifecycle (`workbench-delegation-state`) and
  the temporary commander write lease (`workbench-write-lease`) are persisted
  as custom entries — durable across compaction and session replacement — and
  restored on `session_start`; a restored lease is
  revoked when the mode or actor no longer qualifies (leaving DEV, model/
  provider change), and a corrupt entry restores fail-closed (locked/no
  delegation).
- On `session_before_compact` the workbench only **supplements** Pi's own
  compaction (it never cancels it and never replaces its summary): when
  there is meaningful state it persists a bounded entry and injects a
  hidden (`display: false`) next-turn note with task, mode, passed/failed
  gates, modified files, evidence paths, next step, and repeated-failure
  do-not-retry warnings. Notes are capped (40 lines / 2.4 KB), redacted,
  deduplicated, and contain only pointers — **run logs never enter the
  session context**.
- **Milestone handoff (user-only):** `/q-milestone-handoff <next step>` is
  the ONLY path that carries workbench state into a fresh session. It waits
  for idle, persists a bounded/redacted `prepared` milestone record
  (`workbench-milestone-handoff`, additive schema v1) in the current
  (source) session, then starts a fresh **parent-linked** session whose
  setup appends a `resumed` record, a hidden pointer-only milestone note
  (`workbench-milestone-handoff-note`, `display: false`, no trigger turn),
  and copies of the mode, the bounded compact state and the delegation
  state — **never** the commander write lease (the target write authority
  stays locked even if the source held an active/pending lease). The next
  step is explicitly bounded (240 chars / 1024 UTF-8 bytes; empty and
  overlong values are rejected); records and the note are bounded, redacted
  and fail-closed on restore (unknown schema/malformed records are
  ignored, legacy entries untouched, no migration/rewrite). Because Pi's
  `session_start` for the new session fires BEFORE setup, the handoff
  announces via the replacement context and then reloads it so the copied
  entries are active before the user continues. No model/provider call and
  no agent turn; a cancelled replacement records an additive `cancelled`
  record in the still-valid source. There is **no automation**: the
  command never runs on its own, has no threshold trigger, and the
  handoff is not a hard stop.
- Inside a delegated worker process the same event is **cancelled** so a
  worker never silently continues through lossy compaction; the runner
  also fails closed on any `compaction_start` event, on the pinned 90%
  hard context budget, and on any hard cumulative spend dimension (see
  [Worker cumulative spend budget](#worker-cumulative-spend-budget)).
  Commander compaction behavior is unchanged.

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
- **P6 (previous):** DeepSeek prompt-cache observability (P6-A,
  hash-only telemetry + `/q-cache-*`), stable-prefix contract (P6-B),
  deterministic recipe action cache (P6-C), quant cache contracts (P6-D),
  and the offline cache benchmark + release gate (P6-E, this file's
  `cache:report`/`cache:doctor`). See
  [docs/cache/P6_RELEASE_REPORT.md](docs/cache/P6_RELEASE_REPORT.md).
- **P7 (this release):** worker-first write authority — approved GPT-5.6 Sol
  resolves to the fixed `worker-first-strict` policy in DEV (at the P7
  milestone / before P8b: exact canonical 14-tool allowlist, no
  bash/edit/write or foreign tools); user-only
  temporary commander write leases (`/q-write-policy status`,
  `/q-commander-write-unlock`, `/q-commander-write-lock`; TUI explicit
  confirmation vs non-TUI two-part token confirmation; fixed reasons,
  project-relative exact/subtree scope, edit/write only, max 10 calls / 30
  minutes, expiry/exhaustion/revocation, `WF:LEASE`/`WF:LOCKED`/`WF:REVIEW`
  footer segments); bounded delegation ledger
  (`.pi/workbench/delegations/<id>/` — before/after/worker-summary/review
  records, every success/failure PENDING_REVIEW); review lifecycle
  (`workbench_review_worker_diff` actual-diff/scope/hash binding,
  `workbench_delegation_status`, PENDING_REVIEW/STALE blocking the next
  delegation and VERIFY, STALE after any diff change); command inventory
  24 → 28, tool inventory 8 → 10. The three P7 delegation tools have no
  compact TUI renderers (the P4 five remain the only ones).
- **P8 (this release):** safe nested project support — optional
  `project.yaml` `project_dir` (default `.`) resolves a safe effective
  project root (absolute paths, `..` escapes and symlink escapes rejected;
  target must exist and be a directory; violations become config issues
  with a repository-root fallback); stack detection reads only the
  effective root's top level while git and config-files-present stay
  repository-root based; gate file/json/numeric/schema checks resolve
  against the effective root with realpath containment (the built-in b0.4
  workbench-config check anchors at the repository root via internal
  catalog-only metadata — the public gate schema has no `root` option)
  while gate config, run persistence, recipe execution, artifact run
  records and git
  stay at the repository root; `workbench_project_inspect` and its
  renderer show the effective root.
- **Later:** walk-forward and parameter-experiment tooling as Pi custom
  tools, project-defined JSON schemas for `schema` checks, all within the
  quantitative scope above.

**Commander token optimization Slice D (P7 advisory portion):** the
observation-only commander advisory is implemented in this worktree
(defaults above, trusted `project.yaml` overrides with bounded ConfigIssue
fallback, `CMD:SOFT`/`CMD:HIGH` footer segment, advisory facts in
`/q-cost-status`, no hard-stop semantics). The P5 milestone session/handoff
vertical slice (user-only `/q-milestone-handoff`, lifecycle records,
hidden note, no lease transfer) is implemented in this worktree; the full
Slice D exit, the Commander final check/gates and the P9 verdict remain
**Commander-owned and are NOT claimed here**.

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
    ├── worker-policy.ts        # commander/model/role/path contract for delegation
    ├── worker-budget.ts        # pinned per-message worker context budget: 1M window,
    │                           #   80% soft / 90% hard
    ├── worker-spend.ts         # cumulative delegation spend budget: low/standard/extended
    │                           #   profiles, soft steer / hard fail-closed (pure)
    ├── write-authority.ts      # P7 worker-first-strict policy, 15-tool Sol allowlist,
    │                           #   commander guard + temporary write lease (pure)
    ├── lease-command.ts        # P7 user-only lease commands: parsing, token generation,
    │                           #   TUI/non-TUI renderers, WF footer segment (pure)
    ├── delegation-ledger.ts    # P7 bounded before/after delegation records under
    │                           #   <CONFIG_DIR_NAME>/workbench/delegations/<id>/ (pure + exec)
    ├── delegation-state.ts     # P7 review lifecycle: PENDING_REVIEW → REVIEWED → STALE,
    │                           #   hash binding, delegation/VERIFY blocking (pure)
    ├── milestone-handoff.ts    # P5 user-only milestone handoff: schema-v1 lifecycle records,
    │                           #   bounded next-step parser, bounded/redacted snapshot,
    │                           #   pointer-only hidden note, fail-closed restore (pure)
    ├── diff-review.ts          # P7 workbench_review_worker_diff: real-diff scope check,
    │                           #   hash binding, bounded redacted patch, review.json (pure + exec)
    ├── state.ts                # mode persistence (session entries)
    ├── config.ts               # project root detection, config loading, trust gate
    ├── recipe-schema.ts        # strict recipe validation, argv construction
    ├── recipe-runner.ts        # the single execution service (tools + commands)
    ├── runs.ts                 # run ids, manifests, bounded log reads
    ├── path-guard.ts           # lexical + realpath containment
    ├── redact.ts               # secret detection/redaction for run records
    ├── gate-schema.ts          # gate/check schema, gates.yaml parsing, catalog merge
    ├── gate-catalog.ts         # built-in gates B0-B6 and Q0-Q5
    ├── gate-engine.ts          # gate runs, evidence, persistence
    ├── quant-result.ts         # quant output contract validation
    ├── format.ts               # P4 display formatting (duration, deltas, width fit)
    ├── status.ts               # P4 footer status line builder
    ├── cost-breakdown.ts       # split session cost (commander/worker/other) — pure, mirrors Pi footer
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
