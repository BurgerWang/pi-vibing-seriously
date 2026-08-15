# pi-dev-workbench

<p align="center">
  <img src="assets/banner.svg" alt="pi-dev-workbench v0.10.0 — Pi-native workbench: AUDIT / DEV / VERIFY modes, recipes, gates and evidence" width="679" />
</p>

**pi-dev-workbench** is a [Pi Package](https://pi.dev) that makes software and
quantitative-research work reviewable from plan to verdict. It combines an
enforced **AUDIT / DEV / VERIFY** workflow, declared recipes, durable run
evidence, machine-backed gates, bounded worker delegation, and strict context
output control — all through Pi's native extension, tool, command, skill,
prompt, and TUI surfaces. **It is not a standalone agent framework, daemon,
background service, or sandbox.**

**Navigate:** [Quick start](#quick-start) · [Core concepts](#core-concepts) ·
[Modes](#mode-policy) · [Recipes](#recipes-and-run-records) ·
[Context limits](#context-output-control) · [Command surface](#reference) ·
[Documentation](#documentation)

## Quick start

1. **Install this checkout and confirm that the extension loads:**

   ```bash
   npm install --ignore-scripts   # devDependencies (TS, tsx, Pi types) + yaml runtime dep
   pi install -l .                # register this package in project settings
   pi -a -p "/q-status"           # non-interactive smoke test (print mode)
   ```

2. **Initialize the target project.** Start Pi in that project, approve
   project trust, then choose one profile:

   ```text
   /q-init generic                        # or: /q-init quant-research/stock-selection
                                          #     /q-init quant-research/market-timing
   ```

   `/q-init` previews every planned file, creates the missing files, and asks
   for confirmation before each overwrite. It also writes a profile-specific
   `AGENTS.md`. The `hft`, `market-making`, `lob`, and `execution-engine`
   profiles are rejected by design.

3. **Reload the initialized project.** Exit Pi, re-enter the project, and
   approve project trust again. Workbench configuration and recipes are read
   only for trusted projects.

4. **Follow the mode → recipe → gate loop:**

   ```text
   /q-status              # mode, cwd, project trust, active tools
   /q-mode-audit          # inspect without writes
   /q-mode-dev            # implement through bounded worker slices
   /q-run typecheck       # run a declared recipe; use the names in recipes.yaml
   /q-mode-verify         # declared recipes and gates only
   /q-gate base           # run the base validation ladder
   ```

For onboarding details, nested projects, and recipe examples, see
[Project onboarding](docs/project-onboarding.md).

## Core concepts

| Capability | What you get |
| --- | --- |
| **Modes define authority** | AUDIT inspects, DEV implements, and VERIFY re-runs declared evidence; active-tool sets and a hard `tool_call` guard enforce the boundary |
| **Recipes produce evidence** | Named, schema-parameterized argv commands run without shell strings; path-contained, redacted run records keep the full evidence on disk |
| **Gates decide readiness** | b0–b6 base and q0–q5 quant gates return exactly PASS / FAIL / BLOCKED / NOT_RUN; model prose never substitutes for machine or recorded manual evidence |
| **Workers own routine writes** | Bounded workers implement parent-approved slices; the commander owns architecture, reviews the actual git diff, and runs final gates |
| **Output stays bounded** | Result envelopes, turn/history budgets, stale-safe cursors, bounded DTOs, numeric telemetry, and a legacy-session sanitizer control model-visible context |
| **Prompt prefixes stay cooperative** | Active-history projection freezes a bounded anchor plus immutable segments; ordinary turns append to a raw active tail, while seals and checkpoints are explicit |
| **Caching is explicit** | Opt-in, success-only recipe result caching uses declared content inputs; it never caches LLM answers or arbitrary bash |
| **Quant work has contracts** | Mid/low-frequency profiles add Q0–Q5 plus versioned DATA_SNAPSHOT / FEATURE_SET / BACKTEST_RESULT and `quant-result.json` contracts |
| **Everything stays Pi-native** | Extensions, 30 commands, 14 registered tools, 14 skills, 7 prompt templates, and compact status/widget renderers—no companion runtime |

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
- Model-visible recipe summaries are bounded independently from full run
  evidence. `workbench_read_run` uses seek-based log pages with one shared
  32 KiB/400-line ceiling and a stale-safe cursor; full logs remain on disk.

Commands: `/q-run <recipe> [key=value ...]`, `/q-runs [limit]`,
`/q-run-show <run-id>`, `/q-evidence <run-id>`. Tools:
`workbench_run_recipe`, `workbench_read_run`, `workbench_compare_runs`.

## Context output control

Version 0.10.0 treats model-visible tool output as a limited control-plane
resource. Complete logs, comparisons, reviews, and gate records remain in
project artifacts; tool results expose bounded summaries, opaque continuation
cursors, and artifact pointers. A changed source makes its cursor stale, and
invalid tool-call/result pairing fails closed instead of creating orphaned
history.

| Model-visible surface | Hard limit |
| --- | --- |
| Native `read` page | 12,288 UTF-8 bytes; 240 file lines (252 lines including framing) |
| Default result / error result | 16 KiB and 240 lines / 8 KiB |
| Run-log page; diff review; comparison | 32,768 bytes and 400 lines |
| Gate read | 24 KiB and 320 lines |
| One turn's tool-result batch | Commander 64 KiB; worker 48 KiB; at most 16 calls |
| Active tool-result history | Commander 192 KiB; worker 128 KiB; other 64 KiB |
| Active-history bundles | 128 complete assistant/tool-result bundles |
| Details value / streaming update | 8 KiB / 4 KiB |

The P0–P2 refinements below are **Unreleased source behavior**. No deployment,
tag, package publication, `/reload`, or live qualification is claimed.

Trusted tool-result ingress now applies to exactly six finalized durable
sources: recipe summaries, executed gate records, immutable comparisons,
completed worker reports, finalized run pages, and run-id gate pages. For a
trusted text result at or below 4,096 UTF-8 bytes, provider-visible content
stays byte-exact and only bounded recovery metadata is attached. Larger
results use one deterministic recovery wrapper capped at 4,096 bytes. If the
turn allocation or final envelope cannot preserve that candidate, the runtime
re-applies the ordinary bounded envelope to the original result and removes
both the wrapper and its metadata. Gate pages render against the call's real
allocation before advancing their cursor, so pagination never skips semantic
rows that were not shown.

Authority is role-neutral: Commander, worker, and other roles use the same
content-bound path and differ only in their outer turn/history budgets. A
durable source of at most 4 MiB is opened as a regular in-project file and
bound to its SHA-256 content plus size/device/inode/`mtimeNs`/`ctimeNs` stable
snapshot; symlinks, path escape, mutation, missing files, and oversized files
receive no trusted authority. Later history collapse strictly validates the
metadata and prefers the durable source path over a receipt-summary fallback.

Projection-state v3 uses one role turn and 16 one-bundle segment slots to size
the fixed anchor. Its anchor byte cap is
`max(0, hard tool text - role turn - 16 * 384)`: **122 KiB for Commander**
(`192 KiB - 64 KiB - 6 KiB`), **74 KiB for worker**
(`128 KiB - 48 KiB - 6 KiB`), and **10 KiB for other**
(`64 KiB - 48 KiB - 6 KiB`). The anchor holds at most 96 bundles; the active
suffix target is at most 16 bundles once a hard-limit projection is required.
Up to 16 immutable segments may follow the anchor, each projecting no more
than 384 UTF-8 tool-text bytes and one complete bundle. The v3 state and
telemetry schema 1.3 do not change; a restored state created under an earlier
role cap produces one deterministic `policy_changed` transition.

Normal requests replay the exact anchor, ordered segments, and raw active
suffix. Crossing only the turn or 16-bundle reserve does **not** seal or rewrite
an under-cap request. The controller acts only when the complete reconstructed
history crosses the role's 192/128/64 KiB or 128-bundle hard ceiling; at that
decision it keeps the largest complete raw suffix that fits the reserve and
seals aged material once. Seals 1–16 append a new immutable segment, keep the
epoch and every older boundary byte-identical, and are an expected tail
rewrite. A hard crossing that would create segment 17 instead triggers a
model-free deterministic checkpoint: rebuild the anchor, clear the segment
chain, and increment the epoch. Deterministic hidden boundary markers expose
safe IDs derived only from provider-visible structure, never raw secret
hashes. Invalid tool pairing still fails closed.

Strict v1/v2 records are migration input only: they carry forward monotonic
epoch and nine-field pressure diagnostics, never old topology or hashes. An
under-cap migration emits one boundary while preserving raw history, then
persists inactive v3 so reload cannot repeat it. A fixed, non-secret failure
sentinel likewise survives JSONL restore: repeated failure is de-duplicated and
the first healthy request emits one recovery boundary. The newest malformed or
hostile state entry is authoritative and fails closed; Proxies/accessors are
never executed.

History identity follows JSON semantics with lossless UTF-16 code units, JSON
property enumeration order, omitted object `undefined`, and array holes as
`null`. Array/depth/work limits bound hostile input, and Proxy/accessor/
non-plain structures fail closed.

This is a structural cache-cooperation guarantee, not proof of provider cache
reuse. Public OpenAI explicit breakpoints are optional and capability-gated;
only exact public `openai-responses` GPT-5.6 traffic is eligible. The Codex
backend path remains disabled until both live transports are probed, and
DeepSeek receives no breakpoint fields. OpenAI's operating guidance is exact
prefixes, static content first, variable content last, a consistent
`prompt_cache_key`, at most four new writes per request, the latest 50
breakpoints as read candidates, and about 15 requests/minute per key. The 17
logical anchor/segment markers therefore are not 17 new writes. Only verified
provider `cacheRead`/`cached_tokens` and `cacheWrite`/`cache_write_tokens` usage
is authoritative; the offline fake provider deliberately reports zero. See the
[stable-prefix contract](docs/cache/stable-prefix-contract.md) for the primary
sources and deployment caveats.

Cache visibility is explicit: the footer shows `CACHE last=… cum=…`,
`/q-cache-status` labels the last request and cumulative session ratios, and
`/q-cache-report` reads a bounded chronological window across rotated plus
current telemetry. Corrupt/unreadable sources make the aggregate ratio N/A.
`/q-cache-doctor` uses the same oldest-archive-to-current bounded window and
suppresses clean/no-drift conclusions whenever sources are partial, corrupt,
unavailable, or intentionally truncated.
Unreleased schema 1.3 adds strict request correlation and content-free
projection anatomy. Its `before_provider_request` digest is explicitly a local
`finalityCode=0` observation—not the final provider wire—and prefix comparison
uses whole-item LCP only. Reports keep cache-read and cache-write shares
disjoint, attach numeric quality/status codes, and split Commander and worker
cohorts; non-exact correlation is fail-closed to an unknown actor with no
projection facts. Event/cause/overflow/segment combinations are validated as
one strict semantic matrix rather than independent numbers. Aggregate status
code `7` means an exact token sum exceeded the safe numeric publication
surface; both shares are then `null`, never saturated into a ratio. Cache
doctor treats Proxy/accessor/symbol/exotic telemetry as uninspectable partial
evidence without invoking application code.

Commander compaction now has a content-free summary-capacity preflight over
Pi's actual prepared history and optional split-turn request. It conservatively
estimates each request envelope: estimates below the warning threshold continue,
near-capacity estimates warn and continue, and an estimate at or above the model
window blocks before any summary provider call. A block writes neither
compaction telemetry nor the workbench supplement and directs the operator to
`/q-milestone-handoff <next step>`; workers still cancel compaction before
reading its preparation. Unknown/malformed inputs preserve Pi's prior path.

Warm-prefix auxiliary compaction remains intentionally unimplemented and is
recorded as `BLOCKED_BY_PI_0_84_2_PUBLIC_API`. The public surface was rechecked
against [Pi v0.84.2](https://github.com/earendil-works/pi/releases/tag/v0.84.2)
at [commit `914cf1472e715297caa30db4b9535d534a9eb718`](https://github.com/earendil-works/pi/commit/914cf1472e715297caa30db4b9535d534a9eb718): it exposes pre-compaction
cancel/replacement control but no post-summary payload transform or
same-cache-domain guarantee; its native summary call is standalone with cache
retention disabled and a fresh session id. The workbench does not reimplement
private authentication, headers, streaming, or retries. Allowed/warned
requests still use Pi's native summarizer; the preflight never supplies a
replacement.

The formal stress recipe writes fake-provider telemetry only to its temporary
project and verifies repository telemetry hashes are unchanged.

`/q-context-output-status [json]` reports numeric-only observations such as
bytes shown or omitted, truncations, blocked calls, history collapse, and
worker facts. For a legacy session, create a separate bounded copy with:

```bash
npm run session:sanitize -- --input <session.jsonl> --output <new-session.jsonl> [--collapse-content]
```

The sanitizer never edits or activates the source session. See
[Context Output Control Plane v1](docs/context-output-control-plane.md) for
cursor semantics, durable evidence, compatibility, and release recipes.

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

The deterministic surface — **30 commands, 14 registered tools** (3 native
`read`/`grep`/`find` overrides followed by 11 `workbench_*` tools), and **7
prompt templates** — is pinned by the inventory test. The three lease
commands and `/q-milestone-handoff` are **user-only** slash commands, never
model tools.

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
/q-cost-status | /q-context-output-status [json] | /q-delegation-status
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
| [project-onboarding.md](docs/project-onboarding.md) | Install, initialize, trust, nested-project setup, first recipes and gates |
| [architecture.md](docs/architecture.md) | Extension layout, core services, event wiring |
| [context-output-control-plane.md](docs/context-output-control-plane.md) | Hard output limits, cursors, history projection, session sanitization and release evidence |
| [worker-delegation.md](docs/worker-delegation.md) | Worker contract, budgets, review lifecycle |
| [security.md](docs/security.md) | Full protection matrix and boundaries |
| [quant-research-profile.md](docs/quant-research-profile.md) | Quant scope, contracts, Q0–Q5 |
| [compatibility.md](docs/compatibility.md) | Tested environment matrix |
| [cache/](docs/cache/) | Telemetry, stable-prefix, action cache, quant contracts, benchmark |
| [baselines/](docs/baselines/) | Frozen benchmark protocols and verdict records |
| [CHANGELOG.md](CHANGELOG.md) | Release history |

## Compatibility

Released v0.10.0 tested environments (only claims backed by actual runs — see
[docs/compatibility.md](docs/compatibility.md) and
[compatibility/pi.json](compatibility/pi.json)): Pi **0.83.0** (TUI, print,
json modes), pi-tui 0.83.0, Node **v24.13.0**, npm **11.18.0**, CachyOS
Linux, typebox 1.3.7, yaml 2.9.x. The Unreleased source targets Pi **0.84.2**
and the repository dependency tree now resolves Pi/pi-tui 0.84.2. Its public
compaction surface has been source-audited, but deployment and updated
live/provider qualification still require the final declared gates, `/reload`,
and fresh Commander/worker canaries.

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
