# P4 Gate Report — Pi-native TUI Status, Run Reports, and Run Comparison

Milestone: P4 of pi-dev-workbench (v0.5.0). This report documents what was
implemented and the verification evidence. **No commit was made** (per the
milestone instruction; the repository is left dirty for review).

## 1. Scope delivered

| Component | Location | Status |
| --------- | -------- | ------ |
| Footer status slot via `ctx.ui.setStatus` (Pi footer never replaced): `WB:<MODE> \| <profile> \| <gate>:<status> \| run:<id>` | `core/status.ts` + `index.ts` | PASS |
| Auto-hiding widget via `ctx.ui.setWidget` (task active / gate failing / forced only) | `core/widget.ts` + `index.ts` | PASS |
| `/q-report latest \| <run-id>` (manifest, gates, failed checks, quant facts) | `core/report.ts` + `index.ts` | PASS |
| `/q-compare <run-id-a> <run-id-b>` + `workbench_compare_runs` tool | `core/compare.ts` + `index.ts` | PASS |
| Generic deltas: exit code, duration, artifact changes, gate delta, test counts | `core/compare.ts` | PASS |
| Quant deltas: benchmark/return/drawdown/turnover/cost impact/fold pass-fail/parameters | `core/compare.ts` | PASS |
| Neutrality rule — higher return is never auto-interpreted as better (fixed note) | `core/compare.ts` `QUANT_NEUTRALITY_NOTE` | PASS |
| Compact `renderCall`/`renderResult` for the 5 tools (partial/expanded/error states) | `core/render.ts` + `ui/tool-renderers.ts` | PASS |
| Expanded view: recipe, duration, exit code, artifacts, failed checks, log path | `core/render.ts` | PASS |
| `/q-widget on \| off` | `index.ts` | PASS |
| Run-attributed JSON artifact snapshots (facts from run records, never live files) | `core/recipe-runner.ts` | PASS |
| Narrow-terminal degradation (`fitToWidth` + Pi Text wrapping) | `core/format.ts`, `core/render.ts` | PASS |
| No-color/ASCII semantics; print/json never call TUI-only APIs (`widgetAction` noop, `hasUI` guards) | `core/widget.ts`, `index.ts` | PASS |
| `workbench_compare_runs` read-only → available in AUDIT | `core/mode-policy.ts` | PASS |

## 2. Design rules honored

- **Status**: `ctx.ui.setStatus` only (a footer slot); `setFooter` is never
  used. The status line degrades to mode-only when config/runs are absent
  and is width-fitted for narrow terminals.
- **Widget**: shown only while a task is active, when the latest gate run is
  not a PASS, or when forced (`/q-widget on`); auto-clears otherwise so it
  never permanently occupies terminal space. Content: task, phase, gate,
  last run, blocking reason — plain ASCII.
- **Renderers** render only the structured `details` payloads the tools
  build (compact by default, expanded on demand); they never re-read run
  files and never recompute business metrics. Errors and partial/streaming
  states are handled (`isError`, `isPartial`). Every line is also present in
  the tool `content` used by print/json modes.
- **Comparison** reads only each run's own JSON records (manifest.json,
  gates.json, summary-derived counts, run-attributed quant-result.json
  snapshots). Incompatible schemas (recipe vs gate, quant vs non-quant) are
  reported with notes and `compatible: false`, never silently. Deltas are
  descriptive — the report always carries the neutrality statement.
- **Terminal compatibility**: no emoji carries semantics, colors are an
  overlay on ASCII text, narrow widths wrap/truncate, and all
  `ctx.ui.*` calls are guarded by `ctx.mode`/`ctx.hasUI`.

## 3. Verification

### 3.1 `npm run check` (typecheck + full test suite + git diff --check)

```
200 tests, 200 pass, 0 fail
```

New P4 tests:

- `tests/p4-status.test.ts` (12) — the exact P4 example status line,
  non-OK run suffix, mode-only degradation, missing parts, profile
  width-fit; widget visibility rules (task/gate-failure/forced), widget
  auto-hide, `widgetAction` noop without UI, widget content labels, ASCII
  only, narrow-width fitting, `fitToWidth`.
- `tests/p4-report.test.ts` (10) — report latest resolves the newest run;
  explicit run id; unknown/malformed targets → null; recipe report facts
  (recipe/exit/duration/artifacts/log paths); gate report with per-gate
  statuses and failed checks; quant report with declared quant facts; latest
  gate summary (worst gate, counts, blocking reason); JSON artifact snapshot
  isolation (later runs cannot corrupt earlier records).
- `tests/p4-compare.test.ts` (11) — unknown/malformed run ids; generic
  exit-code/duration/artifact deltas; numeric leaves of shared JSON artifact
  snapshots; artifact additions/removals; self-comparison zero deltas;
  gate-vs-recipe incompatibility with notes; quant-vs-non-quant
  incompatibility; full quant comparison (benchmark/return/drawdown/
  turnover/costs/folds/parameters); rendering neutrality (no better/worse
  verdicts); per-gate status delta + test counts.
- `tests/p4-render.test.ts` (19) — compact renderers (single line, all
  facts), expanded renderers (recipe, duration, exit code, artifacts,
  failed checks, log paths), compare renderer with quant section and
  neutrality note, partial/error/call lines, missing-fields survival,
  narrow-width compare lines, Pi `Text` wrapping at width 30 without token
  loss, TUI wrapper with fake theme (success/error/warning colors, partial
  progress, error content, call header, incompatible warning), UI-disabled
  noop, and the "renderers render details verbatim" check.
- Updated `tests/mode-policy.test.ts` for the AUDIT/VERIFY inclusion of
  `workbench_compare_runs`.

### 3.2 Live Pi session smoke (print mode — TUI-only APIs proven untouched)

`pi -a -p` against this repository and against a fresh temp project
(`/q-init quant-research/stock-selection`):

- Extension loads with all seven tools, including `workbench_compare_runs`;
  `/q-status` lists it in active tools and mode tool sets.
- `/q-widget on` / `/q-widget off` respond in print mode without touching
  the TUI (`refreshWidget` returns early without `hasUI`).
- `/q-report latest` and `/q-report <run-id>` render the gate run report
  (per-gate statuses, failed checks, artifacts, log paths).
- Full quant flow in the temp project: two `/q-run backtest:run ret=0.12 |
  ret=0.15` runs → `/q-compare` reports
  `return: 0.12 -> 0.15 (+0.03)` from the run-attributed artifact snapshots,
  with the neutrality note; `/q-compare` between a recipe run and a gate run
  reports `compatible: no` with the schema-mismatch notes; `/q-gate q1,q2`
  blocks along the prerequisite chain and `/q-report latest` shows the
  BLOCKED chain.

### 3.3 Behavior of the validation ladder in this repository

This repository is intentionally not `/q-init`-ed (it is a Pi package, not a
workbench project); the built-in `b0` gate therefore fails `b0.4` exactly as
recorded in P3 (`20260801-182029-3tyu`: `b0 FAIL — check(s) failed: b0.4`,
no `.pi/workbench` init). The P4 milestone gate is the test suite +
typecheck + smoke above plus this report.

## 4. Facts-only audit points

- The comparator/report read only `manifest.json`, `gates.json`,
  `summary.json` (counts), and run-attributed `artifacts/*quant-result.json`
  snapshots; recipe runs snapshot declared JSON artifacts (<= 1MB) into the
  run dir at run time, so later runs overwriting the same project file
  cannot corrupt earlier records (verified by test).
- Renderers never read files: they consume the tool `details` payloads
  (types in `core/render.ts`) and are covered by "render details verbatim"
  tests.
- No emoji anywhere in status/widget/renderer output; all semantics are
  ASCII (verified by test for widget lines).
- `widgetAction(state, hasUI=false)` is `"noop"`; `refreshStatus` skips
  print/json; `refreshWidget` returns early without `hasUI` (verified by
  test and by the print-mode smoke run).

## 5. Known limitations (P4)

- Tool renderers only run in interactive TUI mode; the print-mode smoke
  exercises the same line builders through the tool `content`, and the TUI
  components are exercised through Pi's real `Text` renderer in tests (a
  full interactive TUI session was not automated).
- Generic "test counts" for recipe runs are reported as `n/a` — run records
  contain no structured test counts for arbitrary recipes; gate runs do
  carry counts, and shared JSON artifact snapshots give numeric deltas when
  the project writes structured reports.
- Quant metrics are compared only when BOTH runs carry a valid
  quant-result artifact; otherwise the section is skipped with a note.
- Live-file fallback for quant artifacts exists only for runs recorded
  before P4 snapshots (documented in `core/report.ts`).

## 6. Git state

Repository left uncommitted on purpose: `git status` shows the P4 changes
(new core modules `format/status/widget/report/compare/render`, `ui/`
renderers, `index.ts` wiring, recipe-runner snapshots, mode-policy tool set,
tests, docs, version bump 0.5.0). Machine-generated gate/recipe runs are
gitignored (`.pi/workbench/runs/`); this report (`P4-GATE-REPORT.md`) is the
milestone's verification artifact.
