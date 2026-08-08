# pi-dev-workbench

<p align="center">
  <img src="assets/banner.svg" alt="pi-dev-workbench v0.9.0 — Pi-native workbench: AUDIT / DEV / VERIFY modes, recipes, gates and evidence" width="661" />
</p>

**pi-dev-workbench** is a [Pi Package](https://pi.dev) that turns Pi into a
development workbench for quantitative research and general software
engineering: a strict **AUDIT / DEV / VERIFY** mode policy, declarative
recipes with auditable run records, **evidence-backed validation gates**,
deterministic action caching, and a **worker-first delegation workflow** with
actual-diff review. It runs entirely on Pi's native mechanisms — extensions,
custom tools, custom commands, skills, prompt templates, and TUI
status/widget slots. **It is not a standalone agent framework, daemon,
background service, or sandbox.**

## Quick start

```bash
npm install --ignore-scripts   # devDependencies (TS, tsx, Pi types) + yaml runtime dep
pi install -l .                # register this package in project settings
pi -a -p "/q-status"           # non-interactive smoke test (print mode)
```

Inside a Pi session:

```
/q-init generic                        # or: /q-init quant-research/stock-selection
                                       #     /q-init quant-research/market-timing
/q-status                              # mode, cwd, project trust, active tools
/q-mode-verify                         # switch to VERIFY after implementation
```

`/q-init` shows every file it will write before writing anything, never
overwrites existing files (per-file confirmation otherwise), and writes a
profile-specific `AGENTS.md` for the project. After initialization:
**exit Pi, re-enter the project, and approve project trust** — workbench
config is only read under trust. The `hft`, `market-making`, `lob` and
`execution-engine` profiles are rejected by design.

## Highlights

| Capability | What you get |
| --- | --- |
| **Pi-native integration** | Built on Pi's own extension surface — no standalone/companion framework, daemon, background service, or separate runtime |
| **Mode policy** | AUDIT (read-only) / DEV (implement) / VERIFY (re-verify), enforced by active-tool sets **and** a hard `tool_call` guard |
| **Declarative recipes** | Named, schema-parameterized commands from `recipes.yaml`; argv-only (no shell strings), path-contained, redacted run records |
| **Evidence-backed gates** | b0–b6 base + q0–q5 quant gates; statuses exactly PASS / FAIL / BLOCKED / NOT_RUN; machine evidence only — model prose can never masquerade as verification |
| **Worker-first delegation** | Bounded, budgeted workers with parent-approved write paths; every diff reviewed against the real git state before the next delegation or VERIFY |
| **Deterministic action cache** | Opt-in, result-only caching of declared recipes with content-addressed keys (`/q-cache-*`); never caches LLM answers or arbitrary bash |
| **Quant research contracts** | Q0–Q5 validation ladder, `quant-result.json` output schema, and versioned DATA_SNAPSHOT / FEATURE_SET / BACKTEST_RESULT cache contracts |
| **Run records & comparison** | Per-run manifests, bounded/redacted logs, artifact snapshots, `/q-report` and `/q-compare` |
| **Native read/grep overrides** | `read` preview and `grep` count mode keep large tool results out of the session context (frozen-cohort results below) |
| **Pi-native TUI** | Status line (mode · profile · gates · latest run), auto-hiding widget, compact tool renderers |

**Native read-preview / grep-count benchmark (frozen cohort).** In the
frozen protocol-v2 cohort — 20 control + 20 treatment sessions, fixed ABBA×10
interleave, pinned environment — the treatment arm measured medians of
**46,108 gross tokens vs 198,064 control (−76.72%)**, **23,320 successful
inline bytes vs 221,201 (−89.46%)**, and **7 requests vs 10 (−30%)**; gross
p90 was 55,082 vs 246,618. These are arithmetic facts on that frozen cohort
only — no causal claim and no statistical significance are claimed (n = 20
per arm). See
[docs/baselines/commander-native-tool-benchmark-v2.md](docs/baselines/commander-native-tool-benchmark-v2.md).

## Mode policy

| Mode | Purpose | Model tools |
| --- | --- | --- |
| AUDIT | Read-only inspection | read, grep, find, ls + read-only workbench tools — never `bash`/`edit`/`write`, never `workbench_run_recipe` |
| DEV | Implementing features | strict commander: fixed 15-tool allowlist, no `bash`/`edit`/`write` (a user-issued lease may add exactly those two); workers: bounded parent-approved paths |
| VERIFY | Re-verifying completed work | declared recipes and gates only — no free `bash`, no `edit`/`write`, no delegation |

- `/q-mode-audit`, `/q-mode-dev`, `/q-mode-verify` switch modes; `/q-status`
  reports the current mode, cwd, project trust, and active tools.
- The mode persists in a Pi custom session entry and is restored on
  `session_start`; `/resume`, `/fork`, `/clone` and `/reload` restore it.
  A fresh `/new` starts clean — only the user-only `/q-milestone-handoff`
  command carries bounded state into a new session.
- Enforcement is two-layered: `pi.setActiveTools()` **and** a hard
  `tool_call` guard that blocks restricted tools even if other logic
  re-enables them. This is a **discipline boundary, not a sandbox** (see
  [Security model](#security-model)).

## Worker-first workflow

Approved GPT-5.6 Sol (the commander) owns requirements, architecture, scope,
actual-diff review, final gates, and the verdict — but does **not** write
directly by default:

- **Strict Sol DEV allowlist.** Sol always resolves to the fixed
  `worker-first-strict` policy: exactly the canonical 15-tool allowlist
  (read, grep, find, ls + the 11 `workbench_*` tools) — no `bash`/`edit`/
  `write`, no foreign tools. AUDIT/VERIFY are strict for every actor.
- **Bounded workers.** `workbench_delegate_worker` spawns one short-lived,
  pinned, non-recursive worker for a bounded implementation task: coherent
  source + tests + docs slices inside parent-approved paths, a per-message
  context budget (1M window, 80% soft steer / 90% fail-closed) and a
  cumulative spend budget (`low` / `standard` / `extended` profiles).
  Workers own routine local implementation decisions; they can never use
  free bash, recurse, or run final gates.
- **Actual-diff review.** Every delegation — success **and** failure — is
  recorded in a bounded ledger (`.pi/workbench/delegations/<id>/`) and
  starts `PENDING_REVIEW`. `workbench_review_worker_diff` checks the real
  git diff against the recorded before-snapshot, scope-checks every changed
  path, and binds the reviewed diff hash; a pending or stale review
  **blocks the next delegation and VERIFY** until the commander reviews the
  actual diff. Worker reports are never acceptance evidence.
- **Temporary commander write lease (user-only).** The explicit exception
  is a human-issued lease through the user-only slash commands
  (`/q-commander-write-unlock`, `/q-commander-write-lock`,
  `/q-write-policy`): bounded calls (≤ 10), time (≤ 30 min) and
  project-relative paths; `edit`/`write` only, never `bash`; revoked on
  expiry, exhaustion, leaving DEV, model/provider change, or session end.

Details: [docs/worker-delegation.md](docs/worker-delegation.md).

## Recipes and run records

Recipes are fully declarative in `.pi/workbench/recipes.yaml`:

- `command` is an **argv array, never a shell string**; parameters come only
  from the recipe's declared `params` schema.
- `cwd`, `writes` and `artifacts` are containment-checked (lexical +
  symlink-aware realpath); `../`, absolute paths and symlink escapes are
  rejected.
- Every recipe declares `mutation` (`none` | `artifacts` | `source`);
  strict Sol runs only `none`/`artifacts` recipes, workers only `none`
  (write-free) recipes.
- Each run persists a manifest, bounded logs, redacted environment facts,
  and artifact snapshots under `.pi/workbench/runs/<run-id>/` — never API
  keys, tokens, or full environment values.
- Output truncation uses Pi's official helpers (2000 lines / ~50 KB);
  `workbench_read_run` returns bounded tails.

Commands: `/q-run <recipe> [key=value ...]`, `/q-runs [limit]`,
`/q-run-show <run-id>`, `/q-evidence <run-id>`. Tools:
`workbench_run_recipe`, `workbench_read_run`, `workbench_compare_runs`.

## Validation gates

A gate is a named validation stage with checks and optional prerequisites.
The built-in catalog provides base gates **b0–b6** (project readiness,
static quality, unit correctness, integration correctness, output contract,
reproducibility/handoff, worker-first compliance) and quant gates **q0–q5**
(research contract, market-data integrity, backtest semantics, experiment
integrity, out-of-sample robustness, strategy reporting). Key rules:

- Statuses are exactly `PASS`, `FAIL`, `BLOCKED`, `NOT_RUN`; a required
  `NOT_RUN` check can never make a gate PASS.
- Checks verify configs, recipe runs, artifacts, files, JSON fields,
  numeric ranges, and schema conformance — or record explicit `manual`
  evidence. Model prose can never masquerade as machine verification.
- **b6 is machine-backed**: the runtime injects worker-first facts (strict
  policy active, zero unauthorized commander writes, no pending/stale
  review, reviewed diff hash matches the current diff) into every gate run.
- Gate runs persist `gates.json` + `evidence.json` artifacts per run.

Commands: `/q-gate <id|base|quant|all>`, `/q-gates`, `/q-gate-show`,
`/q-report`, `/q-compare`. Tools: `workbench_run_gate`,
`workbench_read_gate`, `workbench_list_gates`.

## Caching (deterministic action cache)

- Opt-in per recipe, **result-only** and **success-only**; the action key
  is a content fingerprint of the declared inputs (never git state, mtime
  or file sizes). Never caches LLM answers or arbitrary bash.
- `/q-cache-explain`, `/q-cache-prune`, `/q-cache-clear` manage the
  project-local cache; `--no-cache` / `--refresh-cache` bypass it.
- Quant cache contracts: versioned DATA_SNAPSHOT / FEATURE_SET /
  BACKTEST_RESULT manifests with immutable-reference resolution; cache hits
  never bypass Q0–Q5 validation.
- Offline health tooling: `npm run cache:report`, `npm run cache:doctor`
  (never a model call, no hardcoded provider prices).

Docs: [action cache](docs/cache/action-cache.md),
[quant cache](docs/cache/quant-cache.md),
[cache telemetry](docs/cache/cache-telemetry.md),
[stable-prefix contract](docs/cache/stable-prefix-contract.md),
[cache benchmark](docs/cache/cache-benchmark.md).

## Quant research scope

In scope (mid/low-frequency only): stock-selection strategies, market
timing, ordinary backtesting, data analysis, parameter experiments,
walk-forward, out-of-sample validation, and general software engineering.
The workbench **validates declared outputs — it never computes strategy
metrics** (output contract:
`extensions/workbench-runtime/schemas/quant-result.schema.json`).

**Explicitly out of scope (never implemented):** HFT, L2/LOB order books,
market making, queue position, matching engines, millisecond/microsecond
latency work, exchange order routing, live high-frequency execution, and
colocation. The `hft` / `market-making` / `lob` / `execution-engine` init
profiles are rejected by design.

Docs: [docs/quant-research-profile.md](docs/quant-research-profile.md).

## Security model

- **No fake sandbox.** Pi has no built-in sandbox; extensions inherit the
  permissions of the launching user. The recipe runner, mode restrictions,
  and write-authority policy are **guardrails and process discipline, not
  isolation** — a recipe runs with your full permissions, and redaction
  hides secrets from records, not from processes.
- **Protected paths.** `.env`/`.env.*` (except `.env.example`/
  `.env.template`), `*.pem`, `*.key`, `id_rsa`/`id_ed25519`/`id_ecdsa`/
  `id_dsa`, `credentials.*`, `secrets.*`, `exchange-keys.*`, `auth.json`,
  `.netrc`, `*.token`, `*.p12`/`*.pfx`/`*.jks`: writes blocked in every
  mode; reads blocked in AUDIT/VERIFY (DEV may read `.env` — content enters
  the session transcript — but no mode may write one). Secret content never
  appears in logs, manifests, or reports.
- **Command guard.** Token-parsed, quote-aware blocks for destructive
  commands (`rm -rf /`, `git reset --hard`, force pushes, `sudo`, `npm
  publish`, ...); single-file restores and local reads stay allowed.
- **For untrusted repositories or unattended automation**, run Pi inside a
  container/VM per Pi's security documentation; only install packages you
  trust.

Full matrix: [docs/security.md](docs/security.md).

## Project trust

All workbench config reads and recipe execution are gated by
`ctx.isProjectTrusted()`. Untrusted projects are refused with an explicit
message; the workbench never silently reads or executes config without
trust. After `/q-init` (or when entering a new project): exit Pi, re-enter
the project directory, and approve trust when prompted.

## Reference

The deterministic surface — **29 commands, 11 workbench tools, 7 prompt
templates** — is pinned by the inventory test. The three lease commands and
`/q-milestone-handoff` are **user-only** slash commands, never model tools.

**Workbench tools:** `workbench_project_inspect`, `workbench_run_recipe`,
`workbench_read_run`, `workbench_run_gate`, `workbench_read_gate`,
`workbench_list_gates`, `workbench_compare_runs`,
`workbench_delegate_worker`, `workbench_review_worker_diff`,
`workbench_delegation_status`, `workbench_recover_tool_result`.

**Commands:**

```
/q-mode-audit | /q-mode-dev | /q-mode-verify | /q-status | /q-init <profile>
/q-run <recipe> [k=v ...] | /q-runs [n] | /q-run-show <run-id>
/q-gate <id|base|quant|all> | /q-gates | /q-gate-show <gate-id> | /q-evidence <run-id>
/q-report latest|<run-id> | /q-compare <run-a> <run-b> | /q-widget on|off
/q-cost-status | /q-delegation-status
/q-cache-status | /q-cache-report | /q-cache-doctor | /q-cache-explain
/q-cache-prune | /q-cache-clear | /q-cache-validate | /q-cache-lineage
/q-write-policy status | /q-commander-write-unlock ... | /q-commander-write-lock   (user-only)
/q-milestone-handoff <next step>                                                (user-only)
```

**Prompt templates:** `/q-audit`, `/q-plan`, `/q-build`, `/q-debug`,
`/q-verify`, `/q-optimize`, `/q-review`.

**Skills (14):** repository-orientation, repository-audit,
implementation-workflow, debugging-workflow, validation-ladder,
cli-product-development, handoff-and-release, quant-research-design,
market-data-integrity, stock-selection-research, market-timing-research,
backtest-integrity, experiment-validation, strategy-reporting. Each ships a
focused `SKILL.md` plus `references/*.md` checklists; the quant skills are
scoped to mid/low-frequency research only.

## Documentation

| Doc | Covers |
| --- | --- |
| [architecture.md](docs/architecture.md) | Extension layout, core services, event wiring |
| [worker-delegation.md](docs/worker-delegation.md) | Worker contract, budgets, review lifecycle |
| [security.md](docs/security.md) | Full protection matrix and boundaries |
| [project-onboarding.md](docs/project-onboarding.md) | Setting up a new project |
| [quant-research-profile.md](docs/quant-research-profile.md) | Quant scope, contracts, Q0–Q5 |
| [compatibility.md](docs/compatibility.md) | Tested environment matrix |
| [cache/](docs/cache/) | Telemetry, stable-prefix, action cache, quant contracts, benchmark |
| [baselines/](docs/baselines/) | Frozen benchmark protocols and verdict records |
| [CHANGELOG.md](CHANGELOG.md) | Release history |

## Compatibility

Tested environments (only claims backed by actual runs — see
[docs/compatibility.md](docs/compatibility.md) and
[compatibility/pi.json](compatibility/pi.json)): Pi **0.83.0** (TUI, print,
json modes), pi-tui 0.83.0, Node **v24.13.0**, npm **11.18.0**, CachyOS
Linux, typebox 1.3.7, yaml 2.9.x. Other versions are untested — no
compatibility is claimed for them.

## Development

```bash
npm install --ignore-scripts
npm run typecheck              # tsc --noEmit
npm test                       # node:test via tsx (mode policy, config, schema,
                               # path guard, runner, init, templates, gates,
                               # quant contract, package content)
npm run check                  # typecheck + tests + git diff --check
npm run cache:report           # offline cache benchmark (telemetry + runs + action cache)
npm run cache:doctor           # offline cache health checks (exits non-zero on FAIL)
node tools/make-banner.mjs     # regenerate assets/banner.svg (deterministic, version from package.json)
```
