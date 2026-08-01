# P5 Gate Report — Hardening, Compatibility, Documentation, Release Readiness

Milestone: P5 of pi-dev-workbench (v0.6.0). This report documents what was
implemented, the audit findings, and the verification evidence. **No commit
was made** (per the milestone instruction; the repository is left dirty for
review).

## 1. Complete feature list

| Feature | Where | Status |
| ------- | ----- | ------ |
| Protected-path policy: `.env`/`.env.*` (except `.env.example`/`.env.template`), `*.pem`, `*.key`, `id_rsa`, `id_ed25519`, `id_ecdsa`, `id_dsa`, `credentials.*`, `secrets.*`, `exchange-keys.*`, `auth.json`, `.netrc`, `*.token`, `*.p12`/`*.pfx`/`*.jks` | `core/path-policy.ts` | PASS |
| Per-mode path policy: `edit`/`write` on protected paths blocked in ALL modes; `read`/`ls`/`find`/`grep` blocked in AUDIT/VERIFY, allowed in DEV; bash display-reads (`cat .env`) blocked in AUDIT/VERIFY | `core/mode-policy.ts` `checkToolCall` | PASS |
| Token-based command guard (quote-aware scanner, 11 rules) — no substring false positives | `core/command-guard.ts` | PASS |
| Command rules: `rm -rf /`, `rm -rf ~`/`$HOME`, `rm` of `.git`, `git reset --hard`, `git clean -fd`+, `git push -f`/`--force`/`--force-with-lease`, `git checkout -- .`, `git restore .`, `git remote` add/remove/rm/set-url/rename, `git config --global/--system` writes, `sudo`, `npm|yarn|pnpm|bun publish|unpublish` (`--dry-run` allowed) | `core/command-guard.ts` | PASS |
| State recovery: mode + key task state persisted as Pi custom entries (`workbench-mode`, `workbench-state`), restored on every `session_start` (/new /resume /fork /clone /reload; /new falls back to DEV) | `core/state.ts`, `core/compact.ts`, `index.ts` | PASS (unit tests + live cross-process smoke) |
| Compaction supplement: `session_before_compact` persists bounded state and injects a hidden (`display:false`) next-turn note (task, mode, gates, last run, evidence paths, next step, do-not-retry); never cancels, never replaces Pi compaction; deduplicated; no run logs in session context | `core/compact.ts`, `index.ts` | PASS |
| Modified-file tracking (edit/write inputs, bounded 20) and repeated-failure do-not-retry notes | `index.ts`, `core/compact.ts` | PASS |
| argv redaction hardening: `--key=value` credential carriers redacted in run records with word-boundary parsing | `core/redact.ts` `redactArgvEntry` | PASS |
| `/q-status` reports the active path policy and command guard | `index.ts` | PASS |
| Compatibility matrix: `compatibility/pi.json` + `docs/compatibility.md` (only tested versions claimed) | `compatibility/`, `docs/` | PASS |
| Docs: `architecture.md`, `security.md`, `project-onboarding.md`, `quant-research-profile.md` | `docs/` | PASS |
| Command/prompt inventory enforced by test (exact 15 commands, 7 tools, 7 prompts, no conflicts) | `tests/p5-inventory.test.ts` | PASS |
| Non-interactive degradation: TUI / `pi -p` / `--mode json` all load and run; widget/status degrade to no-ops without TUI | `index.ts` + smoke runs | PASS |

## 2. Complete command list

Deterministic extension commands (15 — verified by test to be exactly this set):

```
/q-mode-audit  /q-mode-dev  /q-mode-verify  /q-status
/q-init <profile>
/q-run <recipe> [key=value ...]   /q-runs [limit]   /q-run-show <run-id>
/q-gate <id|base|quant|all> [manual:<check>=<note>]
/q-gates   /q-gate-show <gate-id>   /q-evidence <run-id>
/q-report latest|<run-id>   /q-compare <a> <b>   /q-widget on|off
```

Workbench tools (7):

```
workbench_project_inspect  workbench_run_recipe  workbench_read_run
workbench_run_gate  workbench_read_gate  workbench_list_gates
workbench_compare_runs
```

Prompt templates (7): `/q-audit /q-plan /q-build /q-debug /q-verify
/q-optimize /q-review` — no name collides with any command or skill.

## 3. Complete test statistics

`npm run check` = typecheck + tests + `git diff --check`:

```
259 tests, 259 pass, 0 fail, 0 skipped
```

| Suite | Tests | Covers |
| ----- | ----- | ------ |
| mode-policy | 21 | tool sets, hard denial, guard integration, state fallback |
| p5-command-guard | 17 | tokenizer, segment split, all 11 rules, false-positive battery |
| p5-path-policy | 13 | protected matching incl. `.env.example` allowlist, per-mode matrix |
| p5-compact | 11 | state sanitization/caps, do-not-retry, bounded redacted notes |
| p5-state-recovery | 7 | real extension wiring via stub API: session_start restore, /new fallback, supplement/dedupe/never-cancel |
| p5-inventory | 6 | direct-load smoke, exact command/tool/prompt inventory, no conflicts |
| p5-redact | 5 | argv `key=value` redaction, boundary parsing |
| recipe-runner | 17 | execution, redaction, containment, truncation |
| gates | 28 | ladder semantics, evidence, containment |
| p4-status/p4-report/p4-compare/p4-render | 57 | TUI status/widget, reports, comparisons, renderers |
| package-content / templates / init / config / recipe-schema / path-guard / quant-result | 77 | package surface, skills, prompts, schemas, contracts |

## 4. Tested environments (only claims backed by runs)

| Component | Version | Evidence |
| --------- | ------- | -------- |
| Pi (`@earendil-works/pi-coding-agent`) | 0.83.0 | typecheck/tests vs pinned devDependency; live smokes below |
| Pi TUI | 0.83.0 | TUI startup smoke (extension loaded, status bar + widget rendered, no crash) |
| Node.js | v24.13.0 | all runs |
| npm | 11.18.0 | all installs/runs |
| OS | CachyOS Linux, kernel 7.1.5-1-cachyos, x86_64 | all runs |
| typebox / yaml / tsx / typescript | 1.3.7 / 2.9.x / 4.23.x / 5.9.x | typecheck + tests |

Live smokes executed this milestone:

- **print mode**: `pi -a -p "/q-status"` (repo and installed-package temp projects) — extension loads, commands respond, path policy + command guard shown.
- **json mode**: `pi --mode json -a -p "/q-status"` — loads and responds.
- **TUI**: `script -qec "pi"` — starts, extension panel shows `workbench-runtime`, status/widget render, runs until timeout without crash.
- **Package discovery**: temp project + `npm install` + `pi install -l` — extension, 7 tools, prompt templates (verified via `/q-verify` resolution) discovered from the installed package.
- **Extension direct-load**: `npx tsx` stub-API load — 15 commands / 7 tools / 7 events registered.
- **State recovery**: same session id across processes — `/q-mode-audit` persisted, `/q-status` in a new process reports AUDIT; agent `write` attempt in AUDIT was blocked (no file created).
- **Path policy live**: in DEV, agent attempt to `write .env` was blocked by the guard; `.env` not created.
- **Full quant flow**: temp project `/q-init quant-research/stock-selection` → 12 gates listed → `/q-run backtest:selection` (exit 0, OK) → `/q-report latest` — all working.

## 5. Known limitations

- Path matching is **basename-based** (a directory named `credentials/` does
  not protect its ordinary files) and POSIX-oriented; Windows/macOS untested.
- The bash path check covers display readers (`cat`, `head`, `tail`, `less`,
  `sed`, `xxd`, `base64`, `strings`, editors); arbitrary bash is not parsed —
  the structured tools are the enforcement point.
- `npm publish --dry-run` is allowed by design; `unpublish` is blocked.
- Plain `node` cannot direct-load the extension (TS parameter properties are
  unsupported by Node's strip-only loader) — Pi loads it through its own
  loader, which is the supported path; the direct-load smoke uses tsx.
- In print mode, Pi itself only materializes a session file once an assistant
  run exists — command-only `pi -p` invocations do not persist custom entries
  (Pi's session-manager semantics, not a workbench bug); TUI sessions persist
  normally.
- Full interactive TUI session automation remains out of scope (component
  tests + live TUI startup smoke cover the surface).
- Run records are retained indefinitely (no retention/GC policy — unchanged
  since P1).
- argv redaction covers `key=value` credential carriers, env-derived secret
  values and known token shapes; a plain positional value
  (`--password hunter2` as two argv entries) is not distinguishable from an
  ordinary argument — recipes should pass secrets via the env allow-list.

## 6. Security boundaries

- **No sandbox.** Pi, extensions and recipes run with the user's full
  permissions. Mode restrictions, the command guard and the path policy are
  discipline layers, not isolation.
- **Path policy**: writes to protected credential files are blocked in every
  mode; reads are blocked in AUDIT/VERIFY; DEV may read (content enters the
  transcript — documented). `.env.example`/`.env.template` always readable.
- **Command guard**: 11 token-parsed rules; quote-aware; no substring false
  positives; `git restore src/file.ts`, `git config --global --list`, local
  `git config`, `--dry-run` publish, quoted text all stay allowed.
- **Records**: env secret values, known token shapes, and argv `key=value`
  credential carriers are redacted from all run records; summaries and the
  compaction note are bounded; full logs stay on disk at run paths.
- **Containment**: recipe cwd/writes/artifacts and gate evidence paths are
  lexically + realpath (symlink-aware) checked; run ids are strictly
  validated before path construction.
- **Compaction**: Pi's own compaction is never cancelled or replaced; the
  supplement is bounded (40 lines / 2.4 KB), redacted, deduplicated, and
  never contains run log content.
- **Out of scope**: HFT/LOB/market-making/matching/execution code — none
  present (audit grep clean); no standalone agent or service ships in the
  package.

## 7. P0–P5 gate master table

| Milestone | Scope | Verification | Status |
| --------- | ----- | ------------ | ------ |
| P0 | Modes (AUDIT/DEV/VERIFY), commands, status, 3 skills, tests | test suite + smoke | PASS (P0 report) |
| P1 | Project config, `/q-init`, declarative recipes, run records + redaction, VERIFY without bash | 82 tests + smoke | PASS (P1 report) |
| P2 | 14 skills, 7 prompt templates, project templates, package-content tests | tests + smoke | PASS (P2 report) |
| P3 | Gate engine B0-B5/Q0-Q5, evidence artifacts, quant-result contract | tests + smoke | PASS (P3 report) |
| P4 | TUI status/widget, `/q-report`, `/q-compare`, tool renderers, JSON snapshots | 200 tests + smoke | PASS (P4 report) |
| P5 | Path protection, command guard, state recovery, compaction supplements, compatibility docs, release audit | 259 tests + 8 live smokes + audit | **PASS (this report)** |
| Built-in ladder | This repo is a Pi package (not `/q-init`-ed): `b0` fails `b0.4` exactly as recorded in P3 — expected, unchanged | — | unchanged |

## 8. Release GO / NO-GO

**GO** (conditionally):

- All gates green: typecheck, 259/259 tests, `git diff --check`, package
  discovery, extension direct-load, print mode, json mode, TUI startup,
  state recovery, guard behavior, full quant flow.
- Final audit clean: no empty dirs, no TODO/stub code, no unreferenced
  modules, no HFT/LOB/market-making/matching code, no standalone agent or
  service, no secret shapes in the tree, no shell-string execution, path
  traversal and symlink bypass covered by tests, logs bounded, UI degrades
  without TUI, docs consistent with implementation.
- Version bumped to 0.6.0; CHANGELOG and docs written; compatibility matrix
  records only tested environments.
- **No commit and no publish were made** — the repository is left dirty for
  human review, per the milestone instruction. GO is conditional on the
  human reviewing the diff and committing (and publishing) deliberately.

## Git state

Uncommitted on purpose. New in P5: `core/command-guard.ts`,
`core/path-policy.ts`, `core/compact.ts`; modified `core/mode-policy.ts`
(guard integration), `core/redact.ts` (argv redaction), `index.ts` (wiring),
`package.json` (0.6.0), README/CHANGELOG, `compatibility/pi.json`,
`docs/*.md` (5 files), 6 new test files. Machine-generated gate/recipe runs
remain gitignored (`.pi/workbench/runs/`).
