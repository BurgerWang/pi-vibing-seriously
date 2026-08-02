# Compatibility

Tested-environment matrix for **pi-dev-workbench v0.8.0 (P6-E)**. Only
environments that were actually exercised are listed; no untested
compatibility is claimed. The machine-readable copy lives in
[`compatibility/pi.json`](../compatibility/pi.json).

## Tested environments

| Component | Version | How it was exercised |
| --------- | ------- | -------------------- |
| Pi (`@earendil-works/pi-coding-agent`) | **0.83.0** | `npm run typecheck`/`npm test` against the pinned devDependency; live `pi -a -p` print-mode smoke runs; `pi --mode json -a -p` JSON-mode smoke runs; extension direct-load tests (stub API); live provider sessions (deepseek / deepseek-v4-flash, `openai-completions`) recorded hash-only telemetry for the P6 benchmark corpus. |
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
max, DEV mode), plus `openai-responses`, `azure-openai-responses` and
`anthropic-messages` (mapped, not live-tested). Any other api kind is
recorded `unverified` — the workbench never guesses. `cacheWrite = 0` is
normal for DeepSeek and never treated as an error.

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
- Windows and macOS are untested; the path policy uses POSIX path semantics.
- Older Pi releases are untested; 0.83.0 is the only verified baseline.
- The P6 benchmark corpus is single-provider/single-model/single-mode
  (DEV) development work; it is not evidence of long-term savings — see
  [docs/cache/P6_BENCHMARK_REPORT.md](../docs/cache/P6_BENCHMARK_REPORT.md)
  Limitations.
