# Compatibility

Tested-environment matrix for **pi-dev-workbench v0.9.0 (P7)**. Only
environments that were actually exercised are listed; no untested
compatibility is claimed. The machine-readable copy lives in
[`compatibility/pi.json`](../compatibility/pi.json).

## Tool-schema fingerprint transition (Phase 3, worker token-budget repair)

`workbench_delegate_worker` gained exactly ONE additive parameter in Phase 3
of the worker token-budget repair
(`docs/plans/worker-token-budget-repair.md`): the optional `budget_profile`
closed literal union `low | standard | extended` (default `standard`). The
change is additive — every pre-repair call contract stays valid — and it
intentionally changes the DEV tool-schema fingerprint exactly **once**:

- the pinned delegate parameter-schema hash moved directly from
  `2cf1f563f78ffe2c85d142c1f40deea7bc658365345554db11c80b8af6b521d9`
  (pre-repair reviewed baseline) to
  `71707090d2da085b036c5879dd2fcb72558175ead8e596bf55406b65732b0c83`
  (final Phase 3 baseline — the additive `budget_profile` parameter with
  the nested JSON Schema `default: "standard"` annotation, pinned in
  `tests/p6-b-stable-prefix.test.ts`);
- the cache telemetry records that one transition as `UNEXPECTED_DRIFT` —
  **expected, not a defect** (documented stable-prefix behavior; the
  schema is still static and registered in the same explicit order);
- after reload, same-mode fingerprints are stable again; no further
  fingerprint change is expected from this repair (Phases 4–6 do not touch
  the delegate parameter schema).

Ledger records written by the new code remain readable by old tooling and
by the new code alike: the before contract's `budget_profile` and the
canonical `spend` object in `usage.json` / `worker-summary.json` are
additive fields on the unchanged `schema_version: 1` records; pre-repair
records without them parse unchanged and are never rewritten (no
migration).

## Tested environments

| Component | Version | How it was exercised |
| --------- | ------- | -------------------- |
| Pi (`@earendil-works/pi-coding-agent`) | **0.83.0** | `npm run typecheck`/`npm test` against the pinned devDependency; live `pi -a -p` print-mode smoke runs; `pi --mode json -a -p` JSON-mode smoke runs; extension direct-load tests (stub API); live controlled-worker smoke spawned `deepseek/deepseek-v4-flash:max`, verified the JSON-event provider/model, performed two read-only tool turns, returned nested usage, exited 0, and left git status unchanged. The P7 worker-first write authority, lease commands, delegation ledger and review lifecycle are exercised by the unit-test suite (write-authority, lease-command, delegation-ledger, delegation-state, diff-review, worker-policy, worker-runner, inventory, package-content tests — 717 tests total, full check `npm run check` passed 717/717); the P7 release slice adds the focused worker-first contract tests (q-build, the implementation-workflow skill, and both project AGENTS templates must encode the seven worker-first rules) and the release-asset version-consistency tests. No new live-smoke claim is made for P7. |
| Pi TUI (`@earendil-works/pi-tui`) | **0.83.0** | Status/widget/renderer components compiled and rendered through pi-tui's `Text` in unit tests (`tests/p4-*.test.ts`). A full interactive TUI session was not automated (see Limitations). |
| Node.js | **v24.13.0** | All test runs and smoke runs. |
| npm | **11.18.0** | `npm install`, `npm run typecheck/test/check`. |
| OS / kernel | **CachyOS Linux (Arch-based), kernel 7.1.5-1-cachyos, x86_64** | All runs above. |
| typebox | **1.3.7** (peer, pinned in devDependencies) | Tool parameter schemas at registration and typecheck. |
| yaml | **2.9.x** (runtime dependency) | Config loading (`project.yaml`, `recipes.yaml`, `gates.yaml`, `profiles.yaml`). |
| TypeScript / tsx | **5.9.x / 4.23.x** (dev) | `tsc --noEmit` and the `node:test` runner; `npm run cache:report` / `npm run cache:doctor` run the P6-E benchmark CLI through tsx. |

## Provider matrix (P6)

The prompt-cache layer (P6-A..E) is provider-agnostic observation: it only
reads Pi's normalized `usage` and the model metadata Pi provides. The usage
semantics were verified against the installed Pi 0.83.0 source for
`openai-completions` (tested live: deepseek / deepseek-v4-flash, thinking
max, DEV mode) and `openai-codex-responses` (tested live: openai-codex /
gpt-5.6-sol, thinking high, DEV mode), plus `openai-responses`,
`azure-openai-responses` and `anthropic-messages` (mapped, not live-tested).
Any other api kind is recorded `partial`/`unverified` — the workbench never
guesses. `cacheWrite = 0` is
normal for DeepSeek and never treated as an error. Controlled worker
execution was live-tested with `deepseek-v4-flash:max`: 2 turns, verified
provider/model, stop reason `stop`, exit 0, and no file modifications.

## Non-interactive modes

The extension is exercised in every output mode:

- **TUI** — status footer, widget, and tool renderers are Pi-native
  components; all `ctx.ui.*` calls are guarded by `ctx.mode`/`ctx.hasUI`.
- **print** (`pi -a -p ...`) — extension loads, commands respond on stdout,
  mode changes persist to the session, `setStatus`/`setWidget` are skipped.
- **json** (`pi --mode json -a -p ...`) — same degradation; output is
  machine-readable JSON.

The complex TUI pieces (widget, status, renderers) degrade to no-ops without
a TUI: `refreshStatus` returns early in print/json modes, `refreshWidget`
returns early without `ctx.hasUI`, `widgetAction(state, hasUI=false)` is
`"noop"`, and `pi.sendMessage`/`pi.appendEntry` are safe in non-interactive
contexts (both are bound by Pi in every mode; failures are caught).

## Session lifecycle

`session_start` reasons exercised/verified through the extension's restore
path (custom entries are read on every `session_start`):

| Reason | Behavior |
| ------ | -------- |
| `startup` | Restore persisted mode/state from the session file, else DEV. |
| `new` | Fresh session file → DEV default (verified by test). |
| `resume` | Session file carries the custom entries → mode/state restored. |
| `fork` (also `/clone`) | The session file (and its custom entries) is copied → restored. |
| `reload` | Same session file → restored. |

## Version policy

- `peerDependencies` declare `"*"` for Pi packages because Pi bundles them at
  runtime; the versions actually tested are pinned in `devDependencies`
  (0.83.0). This package is tested against 0.83.0 **only**.
- If you run a different Pi/Node/npm version and it works, that is a data
  point for a future release — update `compatibility/pi.json` and this file
  with the new tested row instead of silently widening claims.

## Known limitations

- A full interactive TUI session (real keypresses, real widget rendering)
  was not automated; the TUI surface is covered by component-level tests and
  the print/json smokes prove the shared line builders work end to end.
- The three P7 delegation tools (`workbench_delegate_worker`,
  `workbench_review_worker_diff`, `workbench_delegation_status`) have no
  compact TUI renderers — they render through Pi's default text fallback;
  the five P4 tools remain the only ones with compact renderers.
- The P7 lease confirmation flows (TUI dialog, non-TUI two-part token) are
  covered by pure parsing/renderer tests and command-handler unit tests, not
  by an automated interactive-terminal session.
- Windows and macOS are untested; the path policy uses POSIX path semantics.
- Older Pi releases are untested; 0.83.0 is the only verified baseline.
- The P6 benchmark corpus is single-provider/single-model/single-mode
  (DEV) development work; it is not evidence of long-term savings — see
  [docs/cache/P6_BENCHMARK_REPORT.md](../docs/cache/P6_BENCHMARK_REPORT.md)
  Limitations.
