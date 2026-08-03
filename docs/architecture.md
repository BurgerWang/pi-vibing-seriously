# Architecture

How pi-dev-workbench is built, and why. Companion docs:
[compatibility.md](compatibility.md), [security.md](security.md),
[project-onboarding.md](project-onboarding.md),
[quant-research-profile.md](quant-research-profile.md).

## Design principles

1. **Pi-native only.** The workbench uses Pi's own mechanisms — extensions,
   custom commands, custom tools, skills, prompt templates, custom session
   entries (`pi.appendEntry`), `ctx.ui.setStatus`/`setWidget`, custom tool
   renderers, `pi.exec` (argv + `shell=false`), and Pi's official
   `CONFIG_DIR_NAME` and truncation helpers. There is no daemon, standalone
   agent framework, background service, or sandbox. DEV may explicitly spawn
   one short-lived, isolated Pi worker loop for a bounded implementation task;
   it is pinned, role-guarded, non-recursive, abortable, and torn down when the
   tool call finishes. See [worker-delegation.md](worker-delegation.md).
2. **Pure logic in `core/`, wiring in `index.ts`.** Everything decision-like
   (mode policy, path guard, command guard, redaction, containment, gate
   semantics, reports, comparisons, compaction notes) is a pure module with
   no Pi imports, so it is unit-testable with plain `node:test`. `index.ts`
   is the only file that touches the Pi API.
3. **Two enforcement layers.** Layer 1: `pi.setActiveTools()` per mode.
   Layer 2: the `pi.on("tool_call")` hard guard, which still blocks even if
   something re-enables a tool.
4. **Facts from records, never from live files.** Reports, comparisons and
   renderers read each run's own JSON records (`manifest.json`, `gates.json`,
   run-attributed `artifacts/*quant-result.json` snapshots). Renderers never
   recompute business metrics.

## Module map

```
extensions/workbench-runtime/
├── index.ts                 # the only Pi-touching file: commands, tools,
│                            # events, status/widget wiring, guard wiring
├── schemas/quant-result.schema.json   # quant output contract (validated, never computed)
├── ui/tool-renderers.ts     # P4 TUI renderers (theme-colored Text components)
├── worker/
│   ├── runner.ts            # short-lived pinned DeepSeek Pi child process + JSON event/usage capture
│   └── path-scope.ts        # realpath/symlink enforcement for parent-approved worker writes
└── cache/                   # P6-A prompt-cache telemetry (hash-only)
    ├── cache-types.ts       # record schema (1.1), usage semantics (verified api kinds)
    ├── canonical-hash.ts    # deterministic SHA-256 canonicalization
    ├── prompt-fingerprint.ts# system prompt / tool / payload digests (no text kept)
    ├── invalidation-classifier.ts  # inferred invalidation reasons (incl. UNEXPECTED_DRIFT)
    ├── stable-prefix.ts     # P6-B stable-prefix contract: stable sorts, mode prefix
    │                        #   fingerprint, stable resource hash, dynamic markers
    ├── cache-telemetry.ts   # session observer + state entry + status segment
    ├── cache-store.ts       # append-only JSONL, rotation, atomic reports, privacy filter
    ├── cache-report.ts      # aggregation + /q-cache-* text rendering
    ├── cache-doctor.ts      # hygiene checks (usage, drift, churn, forbidden fields, hashes)
    ├── quant-contracts.ts   # P6-D three contract schemas + immutable reference resolution
    ├── quant-files.ts       # P6-D manifest read/validate/resolve + bounded hash verification
    ├── quant-cache-validate.ts  # P6-D /q-cache-validate service + renderer
    └── quant-cache-lineage.ts   # P6-D /q-cache-lineage service + renderer
└── core/
    ├── mode-policy.ts       # AUDIT/DEV/VERIFY tool sets; combined tool_call check
    ├── worker-policy.ts     # commander/model/role/path contract for controlled delegation
    ├── worker-budget.ts     # pinned worker context budget: 1,000,000 window, 80% soft
    │                        #   handoff / 90% hard stop, Pi-compatible context tokens
    ├── tool-catalog.ts      # P6-B static tool metadata + WORKBENCH_TOOL_NAMES order
    ├── command-guard.ts     # P5 token-based destructive-command detection (11 rules)
    ├── path-policy.ts       # P5 protected credential paths + per-mode read/write rules
    ├── path-guard.ts        # lexical + realpath containment for recipe paths
    ├── redact.ts            # secret-name/value detection and redaction
    ├── compact.ts           # P5 compaction supplement state + bounded note builder
    ├── state.ts             # mode persistence via Pi custom session entries
    ├── config.ts            # project root detection, config loading, trust gate
    ├── recipe-schema.ts     # strict recipe validation, argv construction
    ├── recipe-runner.ts     # the single execution service (tools + commands)
    ├── runs.ts              # run ids, manifests, bounded log reads
    ├── gate-schema.ts       # gate/check schema, gates.yaml parsing, catalog merge
    ├── gate-catalog.ts      # built-in gates B0-B5 and Q0-Q5
    ├── gate-engine.ts       # gate runs, evidence, persistence
    ├── quant-result.ts      # quant output contract validation
    ├── format.ts            # P4 display formatting (duration, deltas, width fit)
    ├── status.ts            # P4 footer status line builder
    ├── cost-breakdown.ts    # Unreleased: split session cost (commander/worker/other)
    │                        #   — pure, mirrors Pi's footer aggregation, defensive
    ├── widget.ts            # P4 widget visibility + lines
    ├── report.ts            # P4 run reports, gate-run summaries, quant artifacts
    ├── compare.ts           # P4 run comparison (generic + quant deltas)
    ├── render.ts            # P4 pure renderer line builders + details payloads
    ├── templates.ts         # generic / stock-selection / market-timing templates
    ├── init.ts              # /q-init planning + application
    └── inspect.ts           # project inspection service
```

## Data flow

### Mode enforcement

```
/q-mode-*  →  setMode()  →  pi.appendEntry("workbench-mode")   (persist)
              →  applyModeTools()  →  pi.setActiveTools(...)   (layer 1)
session_start  →  loadModeFromEntries(entries)                 (restore)
every tool call  →  checkToolCall(mode, tool, input)           (layer 2)
                    ├─ mode hard-denial  (AUDIT/VERIFY tool sets)
                    ├─ command guard     (bash input, token-based)
                    └─ path policy       (protected files, per mode)
```

### Controlled worker delegation

```
GPT-5.6 Sol parent in DEV
  → workbench_delegate_worker(task, allowed_paths, acceptance_criteria)
  → trust + commander identity check
  → short-lived pi --mode json --no-session
       --model deepseek/deepseek-v4-flash:max
  → child role matrix + hard guard: no recursion, no bash, no final gates
  → edit/write limited to parent-approved paths
  → worker-role lifecycle: one hidden soft-budget steer at 80%, cancel
       session_before_compact (commander compaction unchanged)
  → bounded JSON event stream + verified model identity + nested usage
  → per-message context tracking (max tokens/ratio, 80% soft flag),
       compaction_start counting, 90% hard-stop termination, fail-closed
       rejection of any compaction attempt or hard-budget stop
  → untrusted report to Sol (budget/compaction facts in details + text)
  → Sol reads actual diff → VERIFY recipes/gates → final judgment
```

Responsibility split: Sol owns requirements, cross-cutting architecture,
scope, actual-diff review, final recipes/gates, and the verdict; the worker
owns routine local implementation decisions inside the approved contract and
delivers a complete source+tests+docs vertical slice (investigation,
production changes, tests, docs, write-free recipe checks, in-scope repair).
The DEV default is to delegate coherent bounded low/medium-risk vertical
slices after minimum repository orientation; high-risk work is Commander-led —
Sol owns requirements, cross-cutting architecture, and core safety decisions
and implements or repairs high-risk work directly by default, delegating at
most explicitly designed bounded support slices (helper code, tests, docs),
never the decision itself. See
[worker-delegation.md](worker-delegation.md) for the risk rubric,
fresh-worker continuation, and the one-writing-worker-per-worktree rule.

The delegate tool is static in the DEV prefix and absent from AUDIT/VERIFY.
No worker process survives its tool call. The pinned budget policy lives in
`core/worker-budget.ts` (pure): a 1,000,000-token window, 80% soft handoff
(800,000), 90% hard stop (900,000) — model-specific, independent of the
Commander/project compaction reserve. See
[worker-delegation.md](worker-delegation.md).

### Recipe execution

```
workbench_run_recipe / /q-run
  → runRecipe(): load config (trusted only) → parse recipe schema
  → build argv ({{name}} placeholders, argv-array only, shell=false)
  → path containment (lexical + realpath; writes/artifacts inside root)
  → pi.exec(command, argv, {cwd, timeout, signal})
  → capture stdout/stderr → redact → write run records
      .pi/workbench/runs/<run-id>/{manifest,command,environment,summary}.json
      {stdout,stderr}.log   + artifacts/ JSON snapshots (<= 1MB)
  → bounded summary back to the model (full logs stay on disk)
```

### Gates

```
/q-gate / workbench_run_gate
  → runGates(): resolve selector → load gates (built-in catalog + gates.yaml)
  → resolve prerequisites (current run first, then latest persisted run)
  → per check kind: config | recipe | artifact | file | json | numeric
                    | schema | manual
  → evidence.json per check (manual evidence is type "manual" only)
  → gates.json + summary.json per run; exit 0 iff PASS
```

### Compaction supplement (P5)

```
workbench events (task, phases, run/gate outcomes, edited files)
  → compactState (in-memory, bounded)
session_before_compact
  → if role == worker: return { cancel: true }   (worker never continues
       through lossy compaction; runner budget policy owns the outcome)
  → else (commander, unchanged):
      if shouldSupplement(state):
        pi.appendEntry("workbench-state", state)        (durable across compaction
                                                         and session replacement)
        pi.sendMessage({customType: "workbench-compact-note",
                        display: false}, {deliverAs: "nextTurn"})
        → hidden, bounded ASCII note in the next turn's context
      → never cancels, never replaces Pi's own compaction summary
session_start → loadCompactStateFromEntries(entries)   (restore)
```

Custom entries (`workbench-mode`, `workbench-state`, `workbench-cache-state`)
do not participate in LLM context; the hidden note is the only context
addition, and it is bounded (40 lines / 2.4 KB) and redacted — run logs never
enter session context.

## Prompt-cache telemetry (P6-A)

```
message_end (assistant only)  → normalized usage (Pi's usage object)
before_provider_request       → structural payload digest (read-only, in memory)
session_start / model_select / thinking_level_select / session_before_compact
  → lifecycle flags (reload/new/model/thinking/mode/compaction)
        ↓
observeMessageEnd: verify usage semantics → hash system prompt + tools
  + payload shape → classify invalidation (priority chain)
        ↓
append record: .pi/workbench/cache/telemetry.jsonl  (JSONL, 5MB rotation)
  + pi.appendEntry("workbench-cache-state", lightweight summary)
        ↓
footer segment: CACHE 72% | read 184k | miss 71k  (or CACHE N/A)
commands: /q-cache-status /q-cache-report [--save] /q-cache-doctor
```

Rules: hash-only (never text), `usage.cost.total` is the cost fact,
cacheHitRatio only for verified api kinds, telemetry never blocks or mutates
requests, opt-out via `project.yaml` `cache.telemetry: false`. See
docs/cache/ for details.

## Session cost breakdown (commander / worker / other)

`core/cost-breakdown.ts` is a pure, defensive mirror of Pi's default footer
cost aggregation over `ctx.sessionManager.getEntries()` (the same loop
footer.js runs for the native session cost):

- assistant message usage → **commander** bucket, grouped per
  `provider/responseModel ?? model` (the same key Pi's
  `getUsageCostBreakdown` uses);
- `toolResult` usage whose `toolName` is `workbench_delegate_worker` →
  **worker** bucket;
- every other `toolResult` usage plus `branch_summary`/`compaction` usage →
  **other** bucket (Pi's "Tools/summaries" bucket).

Token totals follow Pi's convention (`input + output + cacheRead +
cacheWrite`). The only deliberate differences from Pi are defensive:
malformed, non-finite or negative values contribute **zero** (never NaN,
never a crash), and `total` is computed as `commander + worker + other`, so
reconciliation holds exactly by construction. For valid data the totals are
identical to Pi's native footer numbers.

The status line appends a deterministic `COST S:$… W:$… O:$…` segment
(S and W always shown once the session has any usage facts, O omitted when
zero) through the existing `refreshStatus`/`ctx.ui.setStatus` flow — the Pi
footer is never replaced and no other TUI surface changes. `refreshStatus`
also runs after assistant and tool-result `message_end` events (in addition
to the existing session/tool refreshes). Pi 0.83 persists the finished
message after extension handlers, so the event message is included as a
pending fact exactly once; identity/timestamp deduplication prevents double
counting if persistence ordering changes in a future compatible Pi version.

`/q-cost-status` prints the exact commander, worker, other and total amounts
(plus token totals) and the per-model commander breakdown. It reads session
entries only — no project config, no trust gate — and works in TUI and
print/json modes through the shared `output()` helper.

## Stable prefix contract (P6-B)

DeepSeek caches the FULL prefix, so the workbench keeps its side of the
prefix byte-stable: the system prompt is never rewritten per turn,
tool metadata is static (`core/tool-catalog.ts`, registered in the explicit
`WORKBENCH_TOOL_NAMES` order), the active tool set is frozen per mode and
swapped only on mode switches (one `setActiveTools` call), and resource
discovery is deterministically sorted (gates by id, recipes/profiles by
name, readdir/glob results sorted, DEV foreign tools name-sorted). Dynamic
facts (time, git, mode, run/gate ids, cache stats) only flow through TUI
status/widget, custom entries, tool results, telemetry hashes, and normal
chat messages. Same-mode prefix changes are recorded as
`UNEXPECTED_DRIFT` (with `driftSource`) and surfaced by `/q-cache-doctor`
(`prefix_hashes`, `same_mode_drift`) and `/q-cache-report`
(`same-mode mutat.`). See docs/cache/stable-prefix-contract.md.

## Cache benchmark (P6-E)

The offline benchmark CLI (`scripts/cache-benchmark.ts`, `npm run
cache:report` / `npm run cache:doctor`) aggregates the SAME telemetry
records as `/q-cache-report` plus run manifests and action-cache records,
with no Pi session: it never calls a model, never reads `auth.json` or
`models.json`, never warms caches, and never hardcodes provider prices
(`estimatedAvoidedCost` requires an explicit `--cost-map`; otherwise
`null`). The doctor reuses `runDoctor` in an honest offline context —
Pi-dependent checks are skipped, never silently passed — and adds local
hygiene checks (action-cache integrity, index consistency, stale locks).
See docs/cache/cache-benchmark.md and P6_BENCHMARK_REPORT.md.

## Trust and identity

- Project root: `git rev-parse --show-toplevel`, else `ctx.cwd`.
- **No config is read or executed unless `ctx.isProjectTrusted()`.** Untrusted
  projects get an explicit refusal message from every workbench entry point.
- Run ids (`YYYYMMDD-HHMMSS-xxxx`) are strictly validated before any path is
  built from them (path-traversal guard for `/q-run-show` etc.).

## Non-interactive degradation

| TUI-only surface | Without TUI |
| ---------------- | ----------- |
| `ctx.ui.setStatus` | skipped (`refreshStatus` returns early in print/json) |
| `ctx.ui.setWidget` | skipped (`refreshWidget` early-returns without `ctx.hasUI`) |
| widget action | `widgetAction(..., hasUI=false)` → `"noop"` |
| `ctx.ui.confirm` (/q-init overwrites) | skipped — existing files never overwritten |
| command output | stdout fallback (`output()`/`setMode()`) |
| `pi.sendMessage` note | caught; durable custom entry remains |

## Versioned milestones

- P0 bootstrap (modes, commands, status, skills, templates, tests)
- P1 project config, `/q-init`, declarative recipes, run records + redaction,
  VERIFY without free bash
- P2 skills (7 general + 7 quant), prompt templates, project templates
- P3 gate engine (B0-B5/Q0-Q5), evidence artifacts, quant-result contract
- P4 TUI status/widget, run reports, run comparison, tool renderers, JSON
  artifact snapshots
- P5 path protection, token-based command guard, state recovery, compaction
  supplements, compatibility docs
- P6-A DeepSeek prompt-cache telemetry and baseline: hash-only usage/context
  observability, inferred invalidations, JSONL store with rotation,
  /q-cache-status /q-cache-report /q-cache-doctor, footer cache segment
  (observation only — no Recipe Action Cache yet)
- Unreleased: split session-cost observability — pure cost-breakdown module
  (commander/worker/other buckets mirroring Pi's footer aggregation), COST
  status segment, current assistant/tool-result message_end refresh,
  /q-cost-status
- Unreleased: worker context-budget protection — pure `core/worker-budget.ts`
  (1,000,000-token pinned window, 80% soft handoff / 90% hard stop,
  Pi-compatible context tokens), one-shot hidden soft-budget steer and
  compaction cancellation in the worker-role lifecycle only, runner
  budget/compaction tracking with fail-closed hard stop and compaction
  rejection, budget/compaction facts in the worker report
