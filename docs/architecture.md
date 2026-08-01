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
   `CONFIG_DIR_NAME` and truncation helpers. There is no daemon, no second
   agent loop, no background service, no sandbox.
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
└── core/
    ├── mode-policy.ts       # AUDIT/DEV/VERIFY tool sets; combined tool_call check
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
  → if shouldSupplement(state):
      pi.appendEntry("workbench-state", state)        (durable across compaction
                                                       and session replacement)
      pi.sendMessage({customType: "workbench-compact-note",
                      display: false}, {deliverAs: "nextTurn"})
      → hidden, bounded ASCII note in the next turn's context
  → never cancels, never replaces Pi's own compaction summary
session_start → loadCompactStateFromEntries(entries)   (restore)
```

Custom entries (`workbench-mode`, `workbench-state`) do not participate in
LLM context; the hidden note is the only context addition, and it is bounded
(40 lines / 2.4 KB) and redacted — run logs never enter session context.

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
  supplements, compatibility docs (this milestone)
