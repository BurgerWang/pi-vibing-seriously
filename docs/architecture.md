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
2. **Domain logic plus a thin controller/adapter layer.** Decision modules
   (mode policy, path guard, command guard, redaction, containment, Gate
   semantics, reports, comparisons and compaction state) remain plain,
   injected and directly testable. Pi-facing command/event/tool controllers
   also live under `core/`; they may import Pi types and APIs, but keep runtime
   registration and presentation out of the domain modules. `index.ts` is the
   composition root, not the only Pi-touching source file.
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
├── index.ts                 # composition root: constructs shared state and
│                            # connects Pi events to controllers/adapters
├── schemas/quant-result.schema.json   # quant output contract (validated, never computed)
├── ui/tool-renderers.ts     # P4 TUI renderers (theme-colored Text components)
├── worker/
│   ├── runner.ts            # short-lived pinned Pi worker child process + JSON event/usage capture
│   └── path-scope.ts        # realpath/symlink enforcement for parent-approved worker writes
└── cache/                   # P6-A prompt-cache telemetry (content-free hashes + numbers)
    ├── cache-types.ts       # current record schema 1.3 + strict legacy readers;
    │                        #   usage semantics and actor/projection quality facts
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
    ├── *-controller.ts      # Pi-facing command/tool/event adapters; injected
    │                        # services keep domain behavior independently testable
    ├── mode-policy.ts       # AUDIT/DEV/VERIFY tool sets; combined tool_call check
    ├── worker-policy.ts     # commander/model/role/path contract for controlled delegation;
    │                        #   Phase 3: fail-closed budget_profile validation/resolution
    ├── worker-budget.ts     # pinned worker context budget: 272,000 window, 80% soft
    │                        #   handoff / 90% hard stop, Pi-compatible context tokens
    ├── worker-spend.ts      # pinned worker cumulative delegation-spend policy (worker
    │                        #   token-budget repair; pure, no Pi imports): fixed
    │                        #   standard/extended active profiles, historical low read compatibility
    │                        #   workerContextTokens, immutable cumulative turns/total/output
    │                        #   accumulation, ok|soft|hard band + fixed reason ordering,
    │                        #   deterministic steer/hard-stop/summary formatters — wired
    │                        #   into the runtime since Phase 2 (runner accumulation + hard
    │                        #   stop; worker-role one-shot hidden soft steer via the fixed
    │                        #   WORKBENCH_WORKER_SPEND_PROFILE env contract; public profile
    │                        #   selection and ledger/handoff persistence: Phase 3;
    │                        #   numeric-only progress counters/band: Phase 4;
    │                        #   task-contract profile wording + granularity guidance: Phase 5)
    ├── write-authority.ts   # fixed Sol/Luna policy: actor identity, leased
    │                        #   ordinary writes, high-risk path guard, temporary
    │                        #   lease (legacy policy id retained for compatibility)
    ├── lease-command.ts     # P7 user-only lease slash commands: argument parsing,
    │                        #   bounded id/token generation, TUI/non-TUI renderers,
    │                        #   WF footer segment (pure)
    ├── delegation-ledger.ts # P7 bounded delegation records under
    │                        #   <CONFIG_DIR_NAME>/workbench/delegations/<id>/ —
    │                        #   manifest/before/after/worker-summary, atomic, redacted,
    │                        #   argv-only git facts (pure + injected exec); Phase 3:
    │                        #   resolved budget_profile in the before contract + canonical
    │                        #   cumulative spend object in usage.json/worker-summary.json
	├── delegation-state.ts  # P7 review lifecycle: PENDING_REVIEW → REVIEWED → STALE,
	│                        #   hash binding invariants, delegation/VERIFY blocking (pure)
	├── delegation-execution-owner.ts # v2 PREPARED/RUNNING owner identity +
	│                        #   fail-closed crash/reboot orphan reconciliation
    ├── diff-review.ts       # P7 workbench_review_worker_diff service: real-diff scope
    │                        #   check over EVERY worker path, bound hash vs recorded
    │                        #   after hash, drift, bounded redacted patch, displayed-
    │                        #   path coverage facts (same-hash segment merge, hash-
    │                        #   change reset, legacy patch-entry inference), Phase 5
    │                        #   compact .svg/.json entries + withheld markers,
    │                        #   review.json (pure + injected exec)
    ├── tool-catalog.ts      # P6-B static tool metadata + WORKBENCH_TOOL_NAMES order
    ├── command-guard.ts     # P5 token-based destructive-command detection (11 rules)
    ├── path-policy.ts       # P5 protected credential paths + per-mode read/write rules
    ├── path-guard.ts        # lexical + realpath containment for recipe paths
    ├── redact.ts            # secret-name/value detection and redaction
    ├── compact.ts           # P5 compaction supplement state + bounded note builder
    ├── compact-lifecycle.ts # append-only compact attempt lifecycle; eventual
    │                        #   reconciliation where Pi exposes no failure event
    ├── compact-overflow.ts  # narrow, single-shot overflow recovery decision
    ├── compact-preflight.ts # Unreleased: content-free Pi-preparation summary
    │                        #   capacity estimator (allow/warn/block/unknown)
    ├── milestone-handoff.ts # P5 user-only milestone session handoff: explicit
    │                        #   bounded next-step parser, normalized/redacted
    │                        #   schema-v1 lifecycle records (the explicit next
    │                        #   step is redacted once and mirrored into the
    │                        #   copied CompactState.nextStep; every record
    │                        #   string bounded/redacted by prepare), the
    │                        #   pointers/status-only hidden note (never the
    │                        #   source session path; every truncation mode
    │                        #   marked inside the caps) and the fail-closed
    │                        #   restore/load (pure)
    ├── state.ts             # mode persistence via Pi custom session entries
    ├── config.ts            # project root detection, config loading, trust gate,
    │                        #   safe project_dir → effective project root resolution (P8)
    ├── recipe-schema.ts     # strict recipe validation, argv construction
    ├── recipe-runner.ts     # the single execution service (tools + commands)
    ├── runs.ts              # run ids, manifests, bounded log reads, immutable
    │                        #   Gate-attempt markers + identity-checked catalog
    ├── plan-reference.ts    # strict bounded plan_ref schema, current-byte hash
    │                        #   verification and criterion-to-Gate coverage
    ├── delegation-plan-reference.ts # read-only projection from the existing
    │                        #   committed delegation authority into Gate facts
    ├── validation-evidence.ts # P4a durable validation binding: COMPLETE
    │                        #   content diff hashing (streamed, bounded
    │                        #   memory), strict lstat-based lock/config
    │                        #   collection, gate-state hashes, owner/
    │                        #   outcome/target facts, pure fail-closed
    │                        #   reuse comparison (capture + compare only)
    ├── validation-assessment.ts # P4b current-state reuse assessment for
    │                        #   workbench_read_run (read-only): strict
    │                        #   manifest argv_hash ↔ binding invocation
    │                        #   cross-check, strict persisted gate-artifact
    │                        #   reconstruction, fail-closed REUSABLE /
    │                        #   RERUN_REQUIRED with fixed reason codes
    ├── gate-schema.ts       # gate/check schema, gates.yaml parsing, catalog merge
    ├── gate-catalog.ts      # built-in gates B0-B6 and Q0-Q5
    ├── gate-engine.ts       # gate runs, evidence, persistence
    ├── quant-result.ts      # quant output contract validation
    ├── format.ts            # P4 display formatting (duration, deltas, width fit)
    ├── status.ts            # P4 footer status line builder
    ├── cost-breakdown.ts    # P7: split session cost (commander/worker/other)
    │                        #   — pure, mirrors Pi's footer aggregation, defensive
    ├── commander-advisory.ts # P7: observation-only advisory policy (pure, no
    │                         #   Pi imports) — five fixed dimensions with
    │                         #   inclusive >= soft/high defaults, HIGH-over-soft
    │                         #   precedence, fixed-order reasons, bounded config
    │                         #   fallback, defensive rendering
    ├── widget.ts            # P4 widget visibility + lines
    ├── report.ts            # P4 run reports, gate-run summaries, quant artifacts
    ├── compare.ts           # P4 run comparison (generic + quant deltas)
    ├── render.ts            # P4 pure renderer line builders + details payloads
    ├── run-result.ts        # Commander Slice B1: layered workbench_read_run renderer
    │                        #   (Summary/Evidence/Persisted layers, caller-bounded tails)
    │                        #   + the deterministic read-only batch allowlist (P3);
    │                        #   P4b: REQUIRED bounded validation line in every include mode
    ├── tool-result-recovery.ts # P8a receipt core (pure, no Pi imports) + P8b
    │                        #   lifecycle wiring: deterministic wtr1- ids from
    │                        #   bounded native Pi session identity + toolCallId,
    │                        #   canonical input hash only, redaction-first
    │                        #   bounded summaries, strict fail-closed two-phase
    │                        #   replay, .pi/workbench/tool-results/<id>.started
    │                        #   + <id>.json; P8b wires BEGIN (end of the
    │                        #   tool_call guard, pre-execute), exact toolCallId
    │                        #   + toolName FINALIZE, capacity pre-block with no
    │                        #   eviction, and the read-only recovery tool (no
    │                        #   WebSocket or any other transport)
    ├── templates.ts         # generic / stock-selection / market-timing templates
    ├── init.ts              # /q-init stack-aware planning + content snapshot
    ├── init-safe-write.ts   # durable sibling-temp publish; no-clobber create + identity-bound atomic overwrite
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
  → workbench_delegate_worker(task, allowed_paths, acceptance_criteria,
       verification[, task_kind, budget_profile, extended_reason, repair_of,
       plan_ref])
  → trust + commander identity check
  → canonical contract lint: preserve meaningful text layout, stable-deduplicate,
       12 KiB soft / 64 KiB absolute; above soft requires explicit extended+reason
  → recipe:<name> verification preflight: declared, mutation:none, no required
       params; run once before authority work and re-check immediately pre-launch
  → optional plan_ref: strict project-contained current-byte SHA-256 binding
  → P7: real-git diff refresh + review gate (PENDING_REVIEW blocks;
       STALE blocks unless exact strict v2 FINAL/PASS with explicit Sol
       semantic authority permits a fresh successor after live revalidation;
       VERIFY always stays blocked)
  → reconcile the bounded whole-project authority/repair graph
  → acquire the project start lock (OS boot + PID + process-start identity),
       re-reconcile inside it, and retain it through durable PREPARED + mirror
       publication so sibling starts and the pre-owner crash window fail closed
  → prepare the canonical delegation-v2 transaction at
       .pi/workbench/delegations/<id>/v2/transaction.json BEFORE child launch
  → short-lived pi --mode json --no-session
       --model openai-codex/gpt-5.6-luna:xhigh
       (known-root-cause repair receives only an <=8 KiB immutable machine-fact
       capsule; unresolved semantic repair also carries cumulative W/D scope,
       exact files, root plan, and root/latest decision hashes; never prior prose,
       logs, or session)
  → child role matrix + hard guard: no recursion, no bash, no final gates
  → edit/write limited to parent-approved paths
  → execution owner is durable before baseline collection/worker launch;
       restart ABORTS only a provably dead owner with no write evidence,
       while nonempty/COMMITTING/ambiguous authority remains blocked
  → worker-role lifecycle: one hidden soft-budget steer at 80%, cancel
       session_before_compact before reading its preparation
  → bounded JSON event stream + verified model identity + nested usage
  → per-message context tracking (max tokens/ratio, 80% soft flag),
       compaction_start counting, 90% hard-stop termination, fail-closed
       rejection of any compaction attempt or hard-budget stop
  → untrusted report to Sol (budget/compaction facts in details + text)
  → successful/final-failure output publishes one strictly inventoried immutable
       v2 generation; incomplete terminal or publication evidence becomes
       RECOVERY_REQUIRED rather than fabricated success
  → the same delegation call mechanically checks the ACTUAL diff and returns
       a provisional scope/integrity packet: whole-worker-diff scope check
       vs allowed_paths, current diff hash bound to the reviewed hash,
       mismatch/drift warnings, bounded redacted patch with displayed-path
       coverage facts — a path counts as displayed only when it appears in
       an actually rendered patch entry (globally omitted paths never
       count; bounded/per-path-truncated entries count), prior coverage
       merges only on the SAME bound hash (a hash change resets: only
       prior-hash coverage is dropped — this call's rendered paths stay
       displayed), and every segment re-runs the full scope check and the
       complete diff hash (include_paths narrows only the patch)
  → every non-zero delta remains PENDING_REVIEW; after inspecting the complete
       unchanged packet, Sol calls workbench_review_worker_diff with paired
       semantic_decision=ACCEPT + the exact expected_bound_diff_hash
  → if that complete packet is wrong, Sol instead supplies paired
       semantic_decision=REPAIR + the exact bound hash + repair_reason;
       immutable negative authority leaves PENDING_REVIEW/Gates blocked and
       enables one exact fresh repair_of lineage
  → strict compact facts may completely present a large regular SVG/JSON while
       keeping generator equality NOT_VERIFIED; an ordinary single-path source
       resumes through contiguous UTF-8 pages bound to the same diff and
       redacted-stream hash, while unfinished paging, omission, handoff clipping,
       first-call ACCEPT, legacy authority, or drift blocks ACCEPT
  → REVIEWED requires scope PASS, complete presentation, and durable hash-bound
       Sol semantic acceptance (zero delta alone is not_required); FAIL stays
       PENDING_REVIEW and ANY
       re-review of the same current diff that is not PASS with complete
       coverage (a scope FAIL or an incomplete PASS, e.g. a legacy partial
       review record) invalidates a prior REVIEWED state fail-closed
       (demoted to PENDING_REVIEW, reviewed hash cleared); pending/stale
       blocks VERIFY and normally blocks the next delegation. Exact latest
       STALE plus strict v2 FINAL/PASS with explicit Sol semantic authority
       may start a fresh successor without rewriting the old review; every
       other authority stays blocked; the project start lock and whole-lineage
       audit reject sibling starts, hidden active work, missing continuation
       decisions, unsafe recovery, and plan/scope drift; a lineaged ABORTED
       attempt remains blocking and can continue only via the exact reported
       repair_of under a proven before-write owner/journal envelope
  → Sol runs final VERIFY recipes/gates → final judgment
```

### Review-bound local commit

After a non-zero implementation has finalized semantic ACCEPT authority and
the relevant checks have run, Sol may call `workbench_commit_reviewed(message)`
in DEV. The controller reuses the project delegation-start lock, selects paths
only from the strict latest review record, confirms the live review binding,
rejects an unrelated Git index or in-progress Git operation, stages only that
set, and verifies the resulting commit tree. No path parameter or arbitrary
Git command exists, and the tool never pushes or rewrites history. Committing
changes HEAD, so verification should precede the checkpoint; subsequent work
continues from the accepted descendant commit through the existing finalized
STALE successor rule.

Responsibility split is fixed Sol -> Luna. Sol owns the contract,
cross-cutting architecture, scope, review, and verdict; Luna owns routine
source, test, and documentation implementation inside one bounded task. A
successful delegation owns its local implementation decisions; the same
public call scope-checks and presents the delivery, while Sol makes the
separate semantic ACCEPT/repair decision inside the same agent cycle.
Semantic review remains distinct from final recipes/Gates. The serialized
`worker-first-strict` policy name and
the gate check kind remain stable identifiers and describe the fixed product
workflow. Any direct Sol edit/write requires a user-issued temporary lease;
it is an explicit exception, not the routine path. See
[worker-delegation.md](worker-delegation.md) for the
transaction, risk, and recovery contracts.

The delegate tool is static in the DEV prefix and absent from AUDIT/VERIFY.
No worker process survives its tool call. The pinned budget policy lives in
`core/worker-budget.ts` (pure): a 272,000-token window, 80% soft handoff
(217,600), 90% hard stop (244,800) — model-specific, independent of the
Commander/project compaction reserve. See
[worker-delegation.md](worker-delegation.md).

The cumulative delegation-spend policy (approved worker token-budget
repair) lives in `core/worker-spend.ts` (pure, no Pi imports):
fixed active `standard`/`extended` profiles with exact soft/hard limits,
per-message total normalization reusing `workerContextTokens` (positive
`totalTokens` authoritative, else the non-negative
`input + output + cacheRead + cacheWrite` sum; `cacheRead` counts),
independent per-message output extraction, immutable cumulative
turns/total/output accumulation, `ok | soft | hard` band evaluation with
hard-over-soft precedence and the fixed reason order `turns`,
`total_tokens`, `output_tokens`, and deterministic soft-steer, hard-stop
and spend-summary formatters. The policy is **wired into the runtime
(Phases 2–4)**: the runner accumulates the cumulative spend state after
every assistant message, terminates the child fail-closed on any hard
spend dimension with the deterministic hard-stop message, and records the
final profile/state/band/reasons facts on every run result; the
worker-role lifecycle reads the profile from the fixed
`WORKBENCH_WORKER_SPEND_PROFILE` child env contract (retired `low` and
malformed/missing values fall back to `extended` defensively) and sends exactly one hidden
cumulative soft steer when the band first becomes soft/hard. Phase 3 adds
the public profile surface: the optional `budget_profile` tool parameter
(closed literal union `standard | extended`, default `extended`; `standard`
is explicit for clearly small bounded slices) is resolved fail-closed by the pure contract
check in `core/worker-policy.ts` before ledger creation/child launch, the
resolved profile travels into the before contract
(`before.json` → `contract.budget_profile`) and the runner (child env +
result facts, exception fallbacks included), and the canonical cumulative
`spend` object is persisted additively in `usage.json` /
`worker-summary.json` (schema_version stays 1; pre-repair records read
without migration) and rendered into the bounded parent handoff (the
deterministic `spend budget : …` line plus nested spend details, both
derived from the SAME persisted worker-summary spend object).

The retired `low` literal is historical-read-only: frozen v1 metadata and
already committed v1/v2 records remain readable and hash-verifiable, while
new public contracts and committed generations reject it. Direct/internal
runner input and child env `low` resolve to `extended`.

Development-efficiency policy stays advisory and reuses existing evidence.
The pure router recommends `standard` only for a fully evidenced, bounded,
low-risk implementation; missing evidence and diagnosis recommend `extended`,
while the explicit profile and compatible `extended` default remain effective.
The worker runtime may emit one session-scoped no-progress steer after three
consecutive implementation intervals with neither a successful write nor a
new successful recipe run id; it never loops, terminates, or changes authority,
and diagnosis is disabled. Safety-budget steering wins in the same interval
and permanently suppresses the lower-priority no-progress advisory for that
session. Model/reasoning cohorts come from existing strict
cache telemetry, while acceptance, review bytes/full-presentation facts, and
repair depth are aggregated offline from existing strict v2 delegation artifacts. Historical
mechanical `REVIEWED` is not semantic acceptance, and all missing facts remain
unknown. Sol/xhigh drift is status-only. The ABBA canary is descriptive and
cannot grant review, Gate, release, or production authority.

Phase 4 adds
the numeric-only progress surface: `WorkerProgress` exposes the cumulative
turns/total/output counters and the fixed `ok | soft | hard` band after
every processed assistant message (evaluated from the same cumulative
state the final result facts derive from — the last tuple matches the
final ledger counters, soft and hard outcomes included) plus the pinned
provider/model identity; progress never carries text, reasons, tool
arguments, patches, logs, or error prose. The index handler keeps the
exact `Pinned worker: N turn(s), model provider/model` onUpdate prefix
and appends the deterministic spend segment (`| spend total X | output Y |
band B`); the details add only bounded numeric counters and the fixed band
next to the existing identity fields. Phase 5 adds the
task-contract profile wording and delegation-granularity guidance (static
tool metadata, the worker task-text line, and docs) — no behavior, schema,
threshold, or enforcement change. Per-message
context safety is unchanged.

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
  → strict-read latest delegation-v2 plan_ref + re-verify current bounded bytes
    → blocked/drifted/unsafe/unreadable/mismatched facts: setup-fail before run allocation
    → base/all final selectors: every mapped Gate must exist and be selected
    → focused selector: development feedback only, validation coverage PARTIAL
  → resolve prerequisites (current run first, then latest persisted run)
  → per check kind: config | recipe | artifact | file | json | numeric
                    | schema | manual | worker-first (B6)
  → evidence.json per check (manual evidence is type "manual" only)
  → every mapped Gate must PASS for full plan authority
  → gates.json + summary.json per run; exit 0 iff selected Gate outcome PASS
```

B6 (Development Safety; legacy P7 machine kind `worker-first`) is
machine-backed: the runtime injects a bounded safety facts object into every
gate run (slash command AND model tool). Its compatibility-kind checks only PASS from those facts — missing
facts are NOT_RUN (a required NOT_RUN never PASSes), a pending/stale review
BLOCKs B6, negative compliance facts FAIL it, and model prose can never
satisfy B6.1-B6.8.

### Validation composition (Phase 2)

Validation is composed from declared recipe components, never assumed.
Each recipe may declare `validation_components` from the closed set
`typecheck` | `unit-test` | `whitespace` (default `[]`); the persisted run
manifest records the exact declared components and the caller's
`cache_request_mode` (`default` | `no-cache` | `refresh-cache`) as machine
facts. `check` is the single aggregate: uncached, declaring
`[typecheck, unit-test, whitespace]`. Focused cached recipes (`typecheck`,
`unit-test`, `release-assets-test`, `runtime-core-test`) are
development/isolation feedback only — they never substitute for the
Commander-owned final no-cache `check` run, whose persisted manifest with
exactly `[typecheck, unit-test, whitespace]` is the only aggregate final
check evidence. Once that run executes, the final workflow does not
separately rerun the full component recipes; no old run and no cache hit
auto-skips execution, formal gates always execute, and manual gate
evidence remains manual. See
[cache/recipe-cache-schema.md](cache/recipe-cache-schema.md).

### Gate preflight (Phase 3)

```
/q-gate <selector> --preflight / workbench_run_gate {preflight: true}
  → preflightGateManualEvidence(): load project config + effective gate
    catalog (trusted) → resolve the selector with the SAME fail-closed
    rules as a formal run (empty/unknown/profile-invalid selectors and
    prerequisite cycles refuse)
  → trim the supplied manual_evidence → match required (kind: manual &&
    required) check ids of the requested gates
  → return preflight facts ONLY: selector, requested ids, profile,
    required_manual_checks (gate_id/check_id/prompt/provided),
    provided/missing required ids, manual_evidence_ready
  → NO run id, NO recipe/exec, NO gate status, NO persisted record — and
    NO PASS/FAIL/BLOCKED/NOT_RUN assignment; manual_evidence_ready is the
    only readiness signal and raw evidence notes are never returned
```

Preflight is a pure read-only branch taken after trust/project resolution
and BEFORE any formal gate start update: it reads config/gates.yaml only
(no run records, no git/exec, no persistence). Formal gate semantics are
unchanged — `preflight` omitted or `false` runs the gate formally, and
manual evidence there is still recorded with type `"manual"`.

### Nested projects (P8)

`project.yaml` may declare an optional `project_dir` (default `"."`). After
config load, `config.ts` resolves the **safe effective project root** from
it:

```
project.yaml project_dir
  → isAbsoluteStyleProjectDir?  → reject (POSIX `/x`, Windows C:\x, C:/x,
                                   \x, \\server\share, C:x)
  → lexicalContain(projectRoot, project_dir)  → `..` escape rejected
  → stat() must succeed and be a directory (missing/non-dir rejected)
  → realpath containment vs the real repository root (symlink escape
    rejected; inside-repo symlinks accepted)
  → effectiveProjectRoot = realpath of the target (or repository root on
    any violation + a project.yaml ConfigIssue)
```

Every violation records a `project.yaml` ConfigIssue and falls back to the
repository root — the effective root never points outside the repository
and no outside content is ever accessed. Scope split:

- **Effective-root based:** stack detection in `inspect.ts` (top-level
  readdir only), and gate file-type content checks in `gate-engine.ts`
  (`kind: file` globs plus the files read by `json` / `numeric` / `schema`
  checks; resolved relative to the effective root and realpath-contained).
- **Repository-root based (unchanged):** `.pi/workbench` config location,
  run persistence, git state, delegation, recipe checks/execution and
  recipe `cwd` semantics, artifact run records, config-files-present —
  plus the built-in b0.4 workbench-config existence check, which carries
  internal catalog-only `file_root: "repository"` metadata (not settable
  from gates.yaml) so a nested `.pi/workbench` can never impersonate
  the repository configuration.

`workbench_project_inspect` exposes `effective_project_root` and its
renderer shows the effective root explicitly.

### Compaction supplement (P5)

```
workbench events (task, phases, run/gate outcomes, edited files)
  → compactState (in-memory, bounded)
session_before_compact
  → if role == worker: return { cancel: true }   (worker never continues
       through lossy compaction; runner budget policy owns the outcome)
  → else evaluate Pi's actual prepared history and optional split-turn
       request with numeric-only summary-capacity preflight facts
      → unknown/allow: continue
      → warn: bounded warning, then continue
      → block: bounded notice naming
           /q-milestone-handoff <next step>; return { cancel: true }
           before summary provider call, compaction telemetry, or supplement
  → for unknown/allow/warn Commander events:
      if shouldSupplement(state):
        pi.appendEntry("workbench-state", state)        (durable across compaction
                                                         and session replacement)
        pi.sendMessage({customType: "workbench-compact-note",
                        display: false}, {deliverAs: "nextTurn"})
        → hidden, bounded ASCII note in the next turn's context
      → never replaces Pi's own compaction summary
session_start → loadCompactStateFromEntries(entries)   (restore)
```

The estimator uses Pi 0.84.2's public `convertToLlm` and
`serializeConversation` over `messagesToSummarize` and
`turnPrefixMessages`, adds previous/custom instructions to the history-call
estimate, and checks the two provider requests independently. Its base is the
larger of `ceil(serializedChars/4)` and `ceil(serializedUtf8Bytes/3)`. It
reserves Pi's native 80% history-summary or 50% turn-prefix output budget, a
5% tokenizer headroom, 2,048 fixed input tokens, and a 5% context-window
safety margin.
This is a conservative engineering estimate, not a formal tokenizer/context-fit
proof. Only an envelope it estimates at or above the model context window
blocks; malformed or unmeasurable input is `unknown` and preserves the old path.

Custom entries (`workbench-mode`, `workbench-state`, `workbench-cache-state`,
and the P7 `workbench-delegation-state` / `workbench-write-lease`)
do not participate in LLM context; the hidden note is the only context
addition, and it is bounded (40 lines / 2.4 KB) and redacted — run logs never
enter session context.

### Milestone session handoff (P5)

The user-only `/q-milestone-handoff <next step>` command is the ONLY path
that carries workbench state into a fresh session. An ordinary `/new`
starts a fresh/DEV session that copies nothing; only the milestone handoff
starts a parent-linked replacement that resumes the source's mode, bounded
compact state and delegation state.

```
/q-milestone-handoff <next step>   (user-only; a delegated worker is refused
                                    before any state is touched)
  → parseNextStepArg: empty/overlong raw input rejected up front
      (no state touched, no entry appended)
  → await ctx.waitForIdle()          (a handoff never interrupts a running turn)
  → refreshCompactP7Facts()          (capture the current worker-first facts)
  → prepareMilestoneHandoff(...)     (pure): the explicit next step is trimmed,
       redacted against the collected env secrets and re-capped (code-point /
       UTF-8 safe); the SAME value is stored in `record.next_step` and
       `record.state.nextStep`, so a pre-existing snapshot nextStep (possibly
       stale or undefined) never reaches the record or the target. Every
       record string (milestone id, next step, session pointer, timestamp) is
       bounded/redacted by prepare, so a prepared record always passes its
       own fail-closed loader. The snapshot re-applies the compact caps,
       redacts every string field and normalizes the mode.
  → pi.appendEntry("workbench-milestone-handoff", prepared)
       (SOURCE session, persist-first)
  → ctx.newSession({ parentSession: <full source session file>, setup, withSession })
       Parent linkage uses the ORIGINAL full session file; only the persisted
       record pointer is bounded/redacted.
       setup appends to the TARGET session, in order:
         1. `resumed` milestone record (same milestone id / next step /
            session pointer / snapshot, new lifecycle + timestamp)
         2. hidden custom message (display:false, workbench-milestone-handoff-
            note): deterministic pointers/status-only note, bounded 40 lines /
            2400 chars / 4096 UTF-8 bytes with every truncation mode marked
            `[truncated]` INSIDE the caps; it never carries the absolute
            source session path — only the fixed fact `source session:
            parent-linked (pointer persisted outside model context)` — and
            never run logs
         3. copied MODE entry, copied bounded COMPACT state entry (nextStep =
            the redacted record next step), copied DELEGATION state entry
         DELIBERATELY NO write-lease entry: the target write authority stays
         locked even when the source held an active/pending lease.
       withSession runs against the REPLACEMENT context only: visible announce
       (may show the source path — a user notification, not model context),
       then replacementCtx.reload().
  → Pi ordering: session_start("new") fires BEFORE setup against the empty
       fresh target (which would reset the in-memory mode/compact/delegation
       state), so the reload re-fires session_start("reload") over the
       setup-appended target entries and restores mode/compact/delegation /
       note into the running session before the user continues.
  → cancelled replacement: the source session stays valid and an additive
       `cancelled` record (same milestone id / next step / session pointer) is
       appended to the source; nothing was replaced and no setup ran.
```

No model/provider call and no agent turn happen anywhere in the handoff; the
command never runs recipes or gates. Loading is fail-closed: unknown schema
versions, unknown lifecycles, empty/overlong required fields and malformed
snapshots are ignored; every other custom-entry type is never touched; there
is no legacy migration or rewrite. Restoration normalizes a present snapshot
so `state.nextStep` equals the validated `record.next_step`, so later
compaction/restoration retains the explicit handoff next step.

## Prompt-cache telemetry (P6-A)

The schema-1.3 and P0–P2 statements in this section describe Unreleased source
behavior. No deployment, tag, package publication, `/reload`, or live
qualification is claimed.

```
context                       → numeric projection anatomy + exact actor role
before_provider_request       → gated copy-on-write breakpoint transform
                              → local structural digest (finalityCode=0)
message_end (assistant only)  → normalized usage (Pi's usage object)
session_start / model_select / thinking_level_select / session_before_compact
  → lifecycle flags (reload/new/model/thinking/mode/compaction)
        ↓
schema 1.3: correlate exactly one context + one local payload + one message
  → verify usage semantics → hash system prompt + tools + payload shape
  → classify invalidation (priority chain)
        ↓
append record: .pi/workbench/cache/telemetry.jsonl  (JSONL, 5MB rotation)
  + pi.appendEntry("workbench-cache-state", lightweight summary)
        ↓
footer segment: CACHE last=72% cum=68% | read 184k | miss 71k
commands: /q-cache-status /q-cache-report [--save] /q-cache-doctor
```

Rules: content-free hashes/numbers only, `usage.cost.total` is the cost fact,
and the local provider-hook digest is explicitly **not** the final actual wire.
Prefix comparison is whole-item LCP; no partial item/token match is invented.
Correlation `1` is exact. Unwired, multiple/stale/invalid, and missing
correlation fail closed to unknown actor plus no projection anatomy.
The projection reader and writer also enforce the semantic event/cause matrix
and its overflow, epoch, seal, and segment-count invariants; a numerically
well-formed but impossible combination is invalid. Pending correlation is
single-use, is consumed at `message_end`, becomes ambiguous on extra
context/provider observations, and is cleared on a restored or changed
session identity.

Schema 1.3 computes disjoint shares over
`promptInputTokens = input + cacheRead + cacheWrite`. Read share is
`cacheRead / promptInputTokens`; write share is separately available only when
write semantics permit it. Responses status `2` is normalized absence-or-zero,
not provider-presence verification. Reports attach numeric source/semantic
quality codes and separate Commander from worker cohorts. Aggregate code `7`
means exact sums exceed the safe numeric publication surface and both shares
stay `null`; capped display totals never create a ratio. Cache doctor treats
Proxy/accessor/symbol/exotic records as uninspectable partial evidence without
executing application code. Telemetry never blocks or mutates requests; opt
out with `project.yaml`
`cache.telemetry: false`. See docs/cache/ for details.

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
to the existing session/tool refreshes). Pi 0.84.2 persists the finished
message after extension handlers, so the event message is included as a
pending fact exactly once; identity/timestamp deduplication prevents double
counting if persistence ordering changes in a future compatible Pi version.
The runtime wraps this pure reference reducer in a session-local append-only
cache: each footer refresh folds only newly appended entries, while a shorter
or identity-divergent tail triggers a full rebuild. Persisted message
identity/timestamp facts are indexed incrementally, so pending-message
deduplication stays equivalent to the reference full scan without making a
long session quadratic.

`/q-cost-status` prints the exact commander, worker, other and total amounts
(plus token totals) and the per-model commander breakdown. It reads session
entries only — no project config, no trust gate — and works in TUI and
print/json modes through the shared `output()` helper.

**P0 additions (commander-token-optimization plan §6) — additive and
backward compatible.** The cost/token buckets above are byte-for-byte
unchanged; the breakdown additionally carries exact, usage-independent
session observability facts, all numeric/structural only:

- `commanderRequests` — exact commander assistant-message (turn) count;
- `compactions` — exact `compaction` session-entry count;
- `toolTextBytes` — deterministic per-tool inline **TEXT** byte attribution
  over session toolResult entries (toolName-sorted, entry counts, UTF-8
  text bytes, total). Only textual content that actually enters context is
  counted (string `content` / `content[]` items of type `text`); malformed
  or non-text content contributes zero and never throws. Tool **arguments
  are never inspected**, and the inline text is counted as bytes only — it
  is never stored, rendered, or otherwise surfaced. The attribution is
  descriptive and never claims causal token savings.

`/q-cost-status` renders these session facts (commander requests,
compactions, total tool-result text bytes, bounded per-tool rows with an
exact omitted count, and the exact commander gross-token facts); it never
renders tool arguments or result text. The commander gross facts are
rendered additively and unabridged: full-digit gross (`input + output +
cacheRead + cacheWrite` — never k/M-compacted even when the compact bucket
row shows M), the exact component counts, and the deterministic cacheRead
share (`cacheRead / gross`, one-decimal percent, explicit `N/A` on a zero
gross). Rendering is defensive: malformed / non-finite / negative
hand-crafted counts normalize to zero, counts above
`MAX_COMMANDER_COUNT_DISPLAY` clamp with an explicit note, and rendered
lines are always finite, deterministic and bounded (never NaN/Infinity).
A fresh `/reload` + `/q-cost-status` capture remains required before any
later re-measurement. Slice A is PASS: the final full `check` run
`20260805-141013-i4lx` passed 879/879 and the Commander gates run
`20260805-141242-tyt8` passed b0-b6. The recorded 95.35% P1 reduction
remains an observational recipe-inline-byte-only figure
(docs/baselines/commander-token-p0.md) — not causal and not overall
savings.

## Commander advisory (P7)

`core/commander-advisory.ts` is a pure, observation-only policy module (no
Pi imports) that evaluates the five fixed commander observability
dimensions over the SAME current session breakdown as the COST segment
(`core/cost-breakdown.ts` — pending-message-aware with the existing dedup
semantics) and returns a deterministic `ok | soft | high` band with
per-dimension reasons.

**Documented defaults (five fixed dimensions, inclusive `>=` boundaries —
a dimension reaches `soft` at exactly its soft threshold and `high` at
exactly its high threshold):**

| dimension | soft | high |
| --------- | ---- | ---- |
| requests | 200 | 300 |
| gross_tokens | 25,000,000 | 40,000,000 |
| output_tokens | 125,000 | 200,000 |
| tool_text_bytes | 3,500,000 | 5,000,000 |
| compactions | 5 | 8 |

The overall band is the highest per-dimension band (HIGH over SOFT over
OK); reasons list the triggered dimensions in the fixed order `requests`,
`gross_tokens`, `output_tokens`, `tool_text_bytes`, `compactions`, each
with its own per-dimension band (a dimension at HIGH is a HIGH reason,
never also a SOFT reason).

**Configuration.** A trusted `project.yaml` may override individual
thresholds additively (missing fields inherit the documented defaults):

```yaml
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

Every value must be a positive safe integer; unknown keys, invalid values
and `high <= soft` ordering violations become bounded `project.yaml`
ConfigIssue records (`parseAdvisoryConfig` issue evidence is hard-capped
at `MAX_ADVISORY_CONFIG_ISSUES`), while the affected fields fall back to
the documented defaults (a `high <= soft` violation falls back to BOTH
defaults for that dimension). Malformed config never disables
observability and never throws.

**Presentation.** The footer (`refreshStatus` via `message_end`) appends a
compact `CMD:SOFT` / `CMD:HIGH` segment only when triggered — an OK
session adds no segment — driven by the same pending-message-aware session
breakdown as the COST segment. `/q-cost-status` appends the deterministic,
bounded advisory facts (band, the five current values with their effective
thresholds, and the fixed-order reasons) additively after the existing
cost output, in TUI (`ctx.ui.notify`) and print/json (stdout) modes.
Trusted thresholds are loaded best-effort; the command is **never
trust-gated** — untrusted, missing or error paths always fall back to the
documented defaults. Rendering is defensive: current values normalize to
finite non-negative integers clamped at `MAX_ADVISORY_COUNT_DISPLAY` with
an explicit note (display clamping never changes the verdict — the band is
evaluated on the normalized facts), unknown/malformed bands fail safe to
OK, absent/null subobjects render the documented defaults, and hand-crafted
malformed facts never produce NaN/Infinity, extra lines, or a throw.

**Advisory-only guarantees (P7).** The advisory path never steers (no
hidden or visible steering message), never cancels or terminates
`message_end` processing (a HIGH-band session completes normal
message_end/status processing unchanged), never changes tools, modes or
write authority, never blocks the workflow, and creates no hard-stop or
enforcement path. The write-authority, delegation/review and gate surfaces
are governed by their own P7 policies — never by the advisory band.

Only the P7 advisory portion described here is implemented; P5/full
Slice D and the Commander check/gates verification remain unclaimed.

## Bounded recipe/gate parent-result summaries (P1)

`core/result-summary.ts` is a pure, deterministic module that builds the
parent `toolResult` for `workbench_run_recipe` / `workbench_run_gate` and
the rendered output of `/q-run` / `/q-gate` (commander-token-optimization
plan §8). The parent result is a **bounded presentation summary**, never
the raw run output:

- success summaries are ≤ **4096 UTF-8 bytes / 40 lines** and inline NO raw
  stdout/stderr and NO per-test success lines;
- failure/timeout/cancelled summaries are ≤ **12288 UTF-8 bytes / 120
  lines** under the fixed failure-information precedence: (1) status/exit
  code + command, (2) failing test names/count (from Node TAP), (3) first
  root-cause line, (4) timeout/cancelled, (5) warning count (exit-0
  warnings stay visible), (6) full log paths and artifact paths, (7)
  omission facts; bounded raw excerpts may follow ONLY after the
  machine-summary disclaimer, into strictly remaining capacity, and are
  the first thing dropped under pressure;
- gate summaries pass through the same caps: status/exit, failing and
  blocked gate identifiers + reasons BEFORE passing-gate detail, the full
  persisted record path, and omission facts;
- caps are measured in UTF-8 bytes and lines (newline separators counted);
  truncation is code-point safe and deterministic; custom caps are
  configurable only within documented safe bounds (malformed/tiny/huge
  values resolve or clamp so the required facts always fit — `withinCaps`
  is always true);
- every untrusted display field (command, paths, test names, gate ids /
  titles / reasons, cache facts, …) is sanitized (control characters
  replaced — a field can never inject extra lines) and bounded with an
  explicit omission fact; bounded lists show a bounded number of items
  plus the EXACT omitted count.

The module never reads files, never claims acceptance, and never rewrites
persisted records — full logs/records stay on disk byte-for-byte unchanged
and are always referenced by path. A summary is presentation only and is
never acceptance evidence; `check`/gates remain commander-owned.

## Layered run-result presentation (Commander Slice B1, P2 + P3)

`core/run-result.ts` is a pure, deterministic module that builds the
`workbench_read_run` parent `toolResult` (commander-token-optimization
plan P2). The result is a **layered bounded presentation** of the persisted
run record, never the raw run output, in the fixed order:

1. **Summary layer** — machine-derived run facts (run id, recipe, profile,
   mode, status, exit code, duration, started/finished, timed out,
   cancelled, git, execution source);
2. **Evidence layer** — artifact / evidence / declared-write paths
   (bounded lists with the exact omitted count), truncation facts, the
   REQUIRED logs/argv opt-in guidance line (raw stdout/stderr/tails/argv
   omitted + the exact `include=logs`/`include=all` instruction — its
   own required line, never only a tail of the truncatable aggregate
   omissions line), P6-C cache and P6-D quant-contract facts, omission
   facts (machine facts only);
3. **Metadata layer** (explicit `manifest` / `logs` / `all` includes
   only) — bounded `cwd`/`argv` from the manifest, NEVER in the default
   summary;
4. **Persisted layer** — durable project-relative paths to the run
   directory, `manifest.json`, `summary.json`, `stdout.log` and
   `stderr.log`, plus the machine-derived disclaimer;
5. **Tail layer** (explicit `logs` / `all` includes only) — the existing
   caller-bounded stdout/stderr tails (`readLogSnippet`'s
   `max_lines`/`max_bytes`, schema-bounded), appended verbatim; the
   renderer never reads logs and never re-bounds them.

The omitted `include` now resolves to **`summary`** (registered default,
changed from `all`): the default output is ≤ **4096 UTF-8 bytes / 40
lines** and never inlines raw stdout/stderr, per-test lines, or argv.
`summary` and `manifest` outputs are capped (custom caps clamp to the
documented safe bounds `MIN_RUN_RESULT_CAPS` .. `MAX_RUN_RESULT_CAPS`);
`logs`/`all` have no global cap — the tails are already caller-bounded.
Every untrusted manifest field is sanitized (control characters replaced
— a field can never inject extra lines) and bounded code-point-safely
with explicit omission facts; lists render bounded items plus the exact
omitted count; malformed values render defensively and never throw.
Omission reporting never silently loses machine facts: optional
cache/quant lines that cannot fit the resolved caps are dropped
deterministically (lowest priority first) and recorded in the aggregate
(`MAX_OMISSIONS_CHARS` 480, same as the P1 module), and
bounded/truncated metadata/path/list displays carry an explicit
durable-source fact (manifest.json / run record / disk) that is
precomputed BEFORE the aggregate omissions line is emitted. The
guaranteed-fit policy holds: `withinCaps` is always true.

The structured `details` payload (`ReadRunToolDetails`) keeps its exact
legacy shape with one P4b additive field: `validation` (status +
`reasons` — the fixed reason codes only; never raw argv, manual evidence
text, unavailable-reason prose, secrets or worker-first facts). All disk
records are unchanged — legacy records (no cache/quant fields, no
`validation_evidence`) render identically with the fail-closed
`RERUN_REQUIRED — missing-binding` validation line. The tool
schema/metadata wording now declares the summary default.

**P4b required validation line.** Every include mode (`summary` /
`manifest` / `logs` / `all`) and the defensive minimal fallback emit the
REQUIRED `validation :` line: `REUSABLE` exactly when the current-state
P4a comparison accepted a valid, successful, complete, Sol-owned binding
with every component exactly equal; otherwise `RERUN_REQUIRED` with its
fixed reason codes. A payload claiming REUSABLE with reasons is a
contradiction and renders RERUN_REQUIRED with those reasons; an absent
payload renders `RERUN_REQUIRED — missing-binding`. The WHOLE line —
prefix, complete bounded codes and the exact omitted-count suffix
(`…(+N more)`) — always fits the exported `MAX_VALIDATION_LINE_BYTES`
(128 UTF-8 bytes); a code is shown complete or not at all, never
partial/overflowing. The verdict is observation only: it never
automatically skips recipe/gate execution and is never acceptance
evidence.

**Read-only batching (plan P3).** `INDEPENDENT_READ_ONLY_ALLOWLIST` is
the deterministic, explicit allowlist of tools that MAY be batched as
known-independent read-only calls in one host parallel turn: exactly
`read`/`grep`/`find`/`ls` plus `workbench_project_inspect` /
`workbench_read_run` / `workbench_read_gate` / `workbench_list_gates` /
`workbench_compare_runs` — the classifier keeps this original 9-tool set
unchanged; it is no longer the same set as the current AUDIT mode matrix,
because P8b added `workbench_recover_tool_result` to the AUDIT read-only
set — current AUDIT = this classifier set + `workbench_recover_tool_result`,
and recovery is not yet batch-classified (deliberately not added to the
classifier). `workbench_delegation_status` is excluded
even though it only reads (it refreshes persisted delegation state), as
are every execution/review/delegation/write tool. The classifier only
answers membership — it never infers independence for concrete calls; the
model decides which of its calls are known-independent. Exactly one
static prompt guideline in `core/tool-catalog.ts` mirrors the allowlist:
*“Batch 2+ known-independent read-only tool calls … in one host parallel
turn; dependent calls, writes, delegations, reviews and final
recipe/gate execution stay sequential.”* No tool, order, or mode changes.

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

### Active-history projection state v3

The history hard ceilings are Commander 196,608 bytes (192 KiB), worker
131,072 bytes (128 KiB), other 65,536 bytes (64 KiB), and 128 complete
assistant/tool-result bundles. One role turn—65,536 bytes for Commander or
49,152 bytes for worker/other—and a
16-bundle suffix target are used only after a true hard crossing to choose the
raw suffix protected from projection. Sixteen immutable segment slots each
reserve at most 384 tool-text bytes and one complete bundle. Therefore:

```text
anchorByteCap = max(0, hardToolTextBytes - roleTurnBytes - 16 * 384)
anchorBundleCap = max(0, 128 - 16 - 16) = 96
```

The resulting anchor caps are 124,928 bytes (122 KiB) for Commander, 75,776
bytes (74 KiB) for worker, and 10,240 bytes (10 KiB) for other. At the initial
checkpoint, the controller chooses the largest latest raw suffix that fits the
role-turn byte reserve and 16 bundles at a complete-bundle boundary; it
projects the preceding history into the anchor and leaves the suffix raw.

Inside an epoch, every request reconstructs the exact anchor, ordered immutable
segments, and active raw suffix. Crossing the role-turn or 16-bundle reserve
alone does nothing: while the complete reconstruction remains at or below both
hard limits, the request stays byte-identical and reports no projection event.
Only a true hard byte/bundle crossing projects aged active material into one
new segment (at most 384 bytes and one bundle) after choosing the protected
suffix. Seals 1–16 leave the epoch hash, anchor, older segments, and their
markers byte-identical; `segmentSealed` reports the expected tail rewrite
separately from `epochTransitioned`. A later true hard crossing that would
create segment 17 instead performs the deterministic, model-free safety
checkpoint: rebuild the anchor, clear the chain, and advance the epoch. If
lowered policy caps cannot reserve the topology, the controller checkpoints or
fails closed; pairing is verified on every branch.

A process interruption may leave one assistant tool batch without all of its
results in append-only JSONL. When—and only when—a later user message proves
that batch was abandoned, projection removes its call blocks and any partial
results, inserts a bounded content-free interruption marker, and then validates
the repaired history normally. The marker tells the model to follow the latest
complete persisted status immediately rather than wait for another user
confirmation. An incomplete live tail, orphan result, duplicate id, wrong tool
name, or any other ambiguous pairing still enters the fixed fail-closed
boundary. Healthy histories do not run the recovery scan.

The projected anchor and every segment end with a deterministic bounded hidden
marker. Its safe `boundaryId` derives only from projected/provider-visible
structural content—not a hash of raw secret text—and the exact marker/ID list is
exposed for a capability-gated provider hook. Old markers remain immutable
until checkpoint.

`workbench-history-projection-state-v3` is strict, numeric/hash-only, and
bounded to 32 KiB. Reload reconstructs every slice from raw JSONL and compares
exact counts, bytes, bundles, hashes, and chain arithmetic; a mismatch fails
closed as `prefix_changed`. The latest recognized or structurally unsafe entry
is authoritative, so a malformed v1/v2/v3 record, Proxy/revoked Proxy, or
`customType`/`data` accessor blocks fallback to an older valid state without
executing traps; a safely unrelated ordinary entry may be skipped. Strict v1/v2
entries are migration-only: only monotonic epoch and pressure carry forward,
never old topology or hashes. The schema remains v3; a valid state whose saved
role cap differs from the current policy is accepted and emits one
`policy_changed` transition, then replay is stable under the new policy. Even
when current history is below the cap, the
first post-restore request emits one `legacy_migration` boundary while returning
the raw history unchanged; inactive v3 persistence prevents a repeat after
reload.

Canonical history identity mirrors JSONL/provider-visible structure but hashes
strings losslessly by exact UTF-16 code units. Object keys follow JSON property
enumeration order, object `undefined` is omitted, and array holes/`undefined`
become `null`. Work is fail-closed and bounded to 32,768 array elements, 128
nesting levels, 32,769 own descriptors per container, and 262,144 work units;
Proxies, accessors, custom `toJSON`, cycles, non-plain values, and extra array
keys are rejected without running application code.

Failure state also survives reload without an extra schema key: an inactive v3
record stores a fixed non-secret failure sentinel in `epochHash`, covered by
`stateHash`. A repeated failure after JSONL restore is de-duplicated, the first
healthy projection emits one fixed recovery boundary, and later healthy
projections emit none. Raw hostile content never derives either identity.

The separate `workbench-context-pressure-v1` entry remains the exact same
nine-field diagnostic contract; v3 neither changes that wire shape nor changes
auto-compaction. Provider breakpoint injection is independently gated: public
OpenAI support is used only for exact `openai` / `openai-responses` /
`gpt-5.6*` traffic with an existing `prompt_cache_key`; `openai-codex` remains
disabled pending live SSE and WebSocket probes, and DeepSeek is an injection
no-op. OpenAI recommends exact prefixes with static content first, variable
content last, a consistent cache key, and measurement through `cached_tokens`
and `cache_write_tokens`. A request creates at most four new writes and reads
from at most the latest 50 breakpoint candidates; approximately 15 requests
per minute should share one key. Thus the 17 logical anchor/segment markers are
not 17 writes per request. The research-backed client conclusion is one
immutable fixed anchor plus modular immutable segments and rare checkpoints for
Commander, worker, and other. The segmented shape improves structural
exact-prefix stability, but offline evidence cannot prove a future provider
`cacheRead`. See the
[stable-prefix contract](cache/stable-prefix-contract.md) for primary sources
and measurement limits.

Warm-prefix auxiliary compaction remains
`BLOCKED_BY_PI_0_84_2_PUBLIC_API`. The surface was rechecked against the
official [Pi v0.84.2 release](https://github.com/earendil-works/pi/releases/tag/v0.84.2)
and [commit `914cf1472e715297caa30db4b9535d534a9eb718`](https://github.com/earendil-works/pi/commit/914cf1472e715297caa30db4b9535d534a9eb718).
Its public hook can cancel or replace a compaction result before persistence,
but exposes neither a post-summary payload transform nor a guarantee that a
separate summary call shares the original cache domain. Its native summary call
is standalone with `cacheRetention: "none"` and a fresh `sessionId`. This
runtime therefore does not reimplement private authentication, headers,
streaming, retries, or provider invocation. Allowed/warned Commander events
keep Pi's native summary; the capacity preflight only cancels an envelope
conservatively estimated at or above model context capacity.

These cap values are currently sized for Pi's advertised 272,000-token context
window for both pinned GPT-5.6 Sol and GPT-5.6 Luna. `other` and arbitrary
64k/128k model windows remain
unqualified. The source change is not a cache-hit result: verify the repository
Pi 0.84.2 dependencies (the current tree resolves them), pass declared gates,
`/reload`, and collect fresh exact-correlated Commander and worker provider
usage before judging it.

## Trusted recoverable tool-result ingress (P0)

The runtime mints private authority for exactly six finalized sources:

| Source kind | Tool | Durable source |
| --- | --- | --- |
| `finalized_recipe_run` | `workbench_run_recipe` | `.pi/workbench/runs/<run-id>/summary.json` |
| `executed_gate_run` | `workbench_run_gate` | `.pi/workbench/runs/<run-id>/gates.json` |
| `immutable_comparison` | `workbench_compare_runs` | `.pi/workbench/comparisons/<comparison-id>/comparison.json` |
| `completed_worker_report` | `workbench_delegate_worker` | `.pi/workbench/delegations/<delegation-id>/worker-report.md` |
| `finalized_run_page` | `workbench_read_run` | the selected `manifest.json`, `stdout.log`, or `stderr.log` |
| `run_id_gate_page` | `workbench_read_gate` | `.pi/workbench/runs/<run-id>/gates.json` |

Authority requires an in-project regular file no larger than 4 MiB. One
descriptor is opened without following symlinks; SHA-256 is streamed from that
descriptor, pre/post file stats must match, and the namespace is rechecked.
The snapshot identity commits to source path, content, size, device, inode,
`mtimeNs`, and `ctimeNs`. Missing, escaped, linked, mutated, or oversized
sources fail the trust check and continue through the ordinary bounded result
path without recovery authority.

The ingress projector is pure and role-neutral. Text at or below 4,096 UTF-8
bytes retains the exact original block sequence/reference and receives
content-bound metadata with zero omission. Only larger text receives the
deterministic 4,096-byte recovery wrapper. If the call allocation or final
envelope changes that candidate, the runtime discards it and re-runs the
ordinary envelope over the original result; a partial metadata-free recovery
wrapper can never reach the provider or receipt. Budget accounting consumes
the final result once. `workbench_read_gate` renders each page against this
call's actual reservation before cursor advancement, preserving every
semantic row across pages.

The middleware sequence is final envelope, receipt finalization over that
bounded content, then bounded details projection. Trusted
`ingress_projection` metadata is rebuilt from the private side channel, never
accepted from caller details. Historical collapse strictly validates the
exact metadata and tool/source contract, prefers its durable `sourcePath`, and
only then falls back to a receipt or legacy source pointer. Commander, worker,
and other roles share all of this code; role only selects the outer turn and
history caps.

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

## Validation evidence (P4a)

`core/validation-evidence.ts` persists a durable, privacy-safe capture of
the exact project state a run's validation claims rest on, as the additive
`validation_evidence` field on the run manifest (`RunRecord`). The module
is pure (no Pi imports) plus injected exec for git; it only captures and
compares.

**Schema and components.** The block is schema-versioned (`schema_version:
1`): either a full `binding` (capture succeeded) or a bounded
`unavailable_reason` (capture failed — the record is explicitly
non-reusable, never a fabricated binding). A binding carries:

- `commit` — exact git HEAD (null outside a repo / unborn HEAD)
- `diff_hash` — a COMPLETE SHA-256 of every changed regular project file,
  streamed in bounded memory, with path AND porcelain status preserved
  through the delegation ledger's `computeDiffHash` (the same derivation
  at capture and comparison time, so a status-only transition like `??` →
  `A ` changes the hash even when bytes are identical, and a same-size
  change beyond any prefix invalidates)
- `lockfiles` — every `KNOWN_LOCKFILES` full-content hash (markers
  `missing` / `not-a-file` / `too-large` preserved, P6-C compatible)
- `config_hash` — the relevant workbench config under
  `<root>/<CONFIG_DIR_NAME>/workbench` (`CONFIG_DIR_NAME` is Pi's official
  config dir name, never a hardcoded `.pi`)
- `gate_state_hash` — the effective gate schema for recipe bindings; for
  gate bindings the schema plus hashed manual evidence, bounded
  worker-first/actor facts and prerequisite statuses (gateId → status
  only — no timestamps, no run ids, no sources); optional plan facts in the
  worker-first projection are also hash-bound without changing historical
  no-plan hashes
- `profile`, `mode`, `owner` (source actor: `sol` | `worker` | `other` |
  `unknown`), `target` (recipe: name + definition hash + invocation hash
  + normalized cwd; gate: selector + sorted requested/effective gate ids,
  plus optional plan-reference hash + sorted mapped Gate ids +
  `FULL`/`PARTIAL` coverage)
  and terminal `outcome` facts (`successful`, `complete`, `source`)

**Exact invalidation.** Reuse (`evaluateValidationReuse`) is a pure exact
comparison: reusable ONLY for a valid, successful, complete, approved-Sol
binding with every component exactly equal. Refusal reasons accumulate in
a fixed order (missing → legacy → corrupt → unavailable → unsuccessful →
incomplete → non-Sol → commit → diff → dependencies → config → gate-state
→ profile → mode → target → collection-failure) with terminal
short-circuits for missing/legacy/corrupt/unavailable, source refusals and
collection failure. Safe misses are allowed; false reuse is forbidden.

**Strict fail-closed / unavailable behavior.** Absence is proven with
lstat: a genuine ENOENT is a deterministic `missing` marker only when the
path itself is genuinely absent. A dangling symlink or any other existing
path (symlink, directory, unreadable, ELOOP/EISDIR/I/O) aborts the capture
or the current-state collection — an existing-but-unreadable file can
never masquerade as missing. The diff identity is equally strict: a
changed path that is a symlink, directory/submodule, unreadable, escaping,
or otherwise not provable in full makes capture/current collection
unavailable; only a deletion WITH a deletion status binds the `missing`
marker. Any collection failure yields an `unavailable` block (capture) or
a `collection-failure` refusal (comparison) — never a partial binding.

**Privacy.** A binding persists ONLY bounded hashes, enums and ids: raw
source/config/lockfile content, environment/secret values, manual
evidence text, tool arguments and full worker-first facts never appear in
the block. Executed argv is hashed immediately (`executedArgvHash`,
identical to the P6-C action-key argv hash — exec and cache-hit runs bind
the SAME invocation hash for the same argv).

**Sol owner requirement.** Only an approved GPT-5.6 Sol commander source
(`owner: "sol"`) can produce a reusable binding; worker/other/unknown
sources are refused at comparison time (`non-sol-source`).

**Recipe/gate persistence paths.** `recipe-runner.ts` patches BOTH the
in-memory and the persisted manifest after every terminal recipe outcome
(exec success, exec failure, spawn failure, cache hit) via
`captureAndPatchRunManifest` — a capture failure persists bounded
unavailable state, and a patch-write failure returns the original record,
so the returned and persisted records can never disagree on a binding that
was not actually persisted. `gate-engine.ts` persists the block inline for
PASS and non-PASS gate runs. The field is additive on schema v1: legacy
manifests without it remain readable (comparison then refuses reuse with
`missing-binding`).

**Action-cache separation.** P4 evidence is observation only: the P6-C
action cache still decides execution (hit materialization, miss
execution, `--no-cache`/`--refresh-cache` semantics, execution counts and
statuses) exactly as before — evidence capture/patches never skip, block
or re-route the cache and never alter recipe/gate outcomes.

**P4b (implemented) — current-state reuse assessment and rendering.**
`core/validation-assessment.ts` assesses a read run's persisted P4a
evidence against the CURRENT trusted project/runtime state inside
`workbench_read_run`; `core/run-result.ts` renders the verdict as the
REQUIRED bounded `validation :` line in every include mode and the
additive `details.validation` field. Strictly READ-ONLY: the assessment
never rewrites run artifacts, never appends session/delegation entries,
never mutates the authoritative in-memory delegation state (gate-run
worker-first facts come from the caller's read-only projection — the
mutating refresh stays gate-execution-only), and never contacts or
alters the P6-C action cache. The verdict never skips recipe/gate
execution and is never acceptance evidence.

**Assessment inputs.** Recipe runs: the current target is rebuilt from
the CURRENTLY DECLARED recipe definition + normalized cwd plus the
persisted privacy-safe invocation identity, which is cross-checked
against the persisted manifest's `argv_hash` (must be a valid 64-hex
identity exactly equal to the binding's `invocation_hash` —
missing/malformed/mismatched identities refuse reuse deterministically
as `corrupt-binding`; raw argv is never read, re-derived, or rendered; a
removed recipe is `target-mismatch`). Gate runs: the current
selector/requested/effective target is reconstructed from the CURRENT
effective catalog (removed gates / selector drift are `target-mismatch`)
and, when the current latest strict delegation carries `plan_ref`, the
referenced bytes are freshly re-verified and the current mapped-Gate coverage
is reconstructed. Drift or unavailable/unsafe plan bytes is a
`collection-failure`; missing mapped Gates or changed final-selector coverage
fails closed; a focused target remains `PARTIAL` and its source outcome is
unsuccessful, so it can never assess `REUSABLE`. Historical targets without a
plan remain compatible only while there is no current delegation plan,
and the persisted source artifacts (gates.json + evidence.json) are
STRICTLY validated by `readPersistedGateRunFacts` — both must carry the
exact gate schema version and run id, agree with each other AND with the
manifest on the requested set, profile (optional) and mode, every gate
entry carries a bounded id + well-formed prerequisite statuses + a
bounded checks array, and the evidence check map must EXACTLY equal the
gate entries' check-id set (extra/foreign or missing checks are
contradictory). Only type-`manual` evidence entries are recovered (the
bounded, trimmed note is hashed and never rendered); missing/malformed/
foreign/contradictory source evidence fails closed as
`collection-failure`. Current prerequisite statuses are re-resolved from
the latest persisted gate runs; current actor/worker-first facts are
hashed in (worker-first facts come from the read-only projection).

**Fail-closed and legacy semantics.** Missing/legacy/foreign/corrupt/
unavailable bindings, failed/incomplete/non-Sol sources and collection
failures stay READABLE and refuse reuse with the deterministic P4a
reason codes (missing → legacy → corrupt → unavailable → unsuccessful →
incomplete → non-Sol → commit → diff → dependencies → config →
gate-state → profile → mode → target → collection-failure); a legacy
record without `validation_evidence` renders
`RERUN_REQUIRED — missing-binding`; a malformed `argv_hash` or a
contradictory invocation identity is `corrupt-binding`. Privacy: only
bounded status + fixed reason codes ever surface — raw argv, manual
evidence text, unavailable-reason prose, secrets and full worker-first
facts never leave the assessment or the renderer.

## Tool-result receipt recovery (P8a core + P8b lifecycle wiring)

`core/tool-result-recovery.ts` is the durable two-phase tool-result receipt
core for the commander-token-optimization persist-first slice: pure (no Pi
imports), repository-owned, session-level. The reviewed P8a core is the
storage/identity primitive; **P8b wires the full lifecycle into `index.ts`**
(BEGIN in the `tool_call` guard, FINALIZE in the `tool_result` handler, and
the public read-only recovery tool — see "P8b lifecycle wiring (landed)"
below).

**Native Pi session dependency.** A result id is `wtr1-` + 64 lowercase hex
= SHA-256 of the canonical binding of a bounded non-empty **native Pi
session identity** and a bounded non-empty **Pi toolCallId**
(`deriveResultId`, deterministic). The module never imports Pi: callers
supply the identity values, and the P8b wiring in `index.ts` collects them
from Pi session events (`ctx.sessionManager.getSessionId()` +
`event.toolCallId`). Identities are validated (non-empty,
length-bounded, no control characters) before any id derivation or path
construction; ids are path-safe by construction.

**Repository-owned two-phase storage.** Under the project config dir:

```
.pi/workbench/tool-results/<id>.started   phase 1 — exclusive create (tmp + hard link)
.pi/workbench/tool-results/<id>.json      phase 2 — atomic publish, no-overwrite
```

Both artifacts are schema `wtr1` / version 1 with exact field sets: started
carries id/tool/input_hash/nonce/status/created_at; finalized adds
status/error/summary/omission facts/finalized_at. Strict parsing enforces
the exact field set, caps, control-character and marker rules on every
read, and a finalized receipt can only exist AFTER a matching started
receipt (started-before-final is a parse-level invariant). Temp leftovers
and foreign files in the directory are ignored.

**Deterministic identity, privacy, bounds, permissions.**
- The exact tool name and a canonical privacy-safe SHA-256 of the raw input
  are persisted identity facts; raw input/arguments, session identity and
  toolCallId are NEVER persisted. Non-JSON inputs (Date, functions, bigint,
  Map, NaN) are rejected by `canonicalHash` and fail closed as
  `invalid_identity` before anything is written.
- Redaction (core/redact.ts) runs FIRST over the full result content, then
  explicit UTF-8 byte/line caps apply (summary ≤ 2048 bytes / 20 lines,
  error ≤ 512 bytes / 8 lines) with code-point-safe truncation and a
  `\n[truncated]` marker whose byte AND line space is reserved inside the
  caps; control characters are sanitized per line. Artifact reads are
  strictly bounded (≤ 64 KiB via bounded fd reads).
- The directory is created mode 0700, artifacts mode 0600; the directory is
  realpath-containment-checked BEFORE and AFTER mkdir, so an escaping
  symlink at `.pi`/`.pi/workbench`/`tool-results` can never redirect a
  write outside the project root.

**Fail-closed classification.** Existing receipts are strictly parsed and
cross-checked — no overwrite, no guessing, no best-effort success.
`begin` reports `completed_replay` ONLY when BOTH phases exist, strictly
parse and agree on id/tool/input_hash/created_at; finalized-only,
missing-started, malformed/unsafe/oversized and cross-phase-mismatched
state fails closed as `corrupt_receipt` (recover: `corrupt`/`conflict`)
and is NEVER reported completed. Missing → `missing`/`incomplete`,
foreign identity → `identity_conflict` on begin (recover carries no
requested identity facts beyond the id), environmental failures →
`storage_error`/`write_error`. Recovery is strictly read-only,
deterministic, and changes no bytes or mtimes.

**Legacy additive behavior.** P8a adds a NEW directory under
`.pi/workbench/`; legacy run/cache/delegation/domain records are never
read, migrated, or rewritten, and unknown-schema receipts fail closed as
corrupt. No existing record format changes; receipts never touch
run/cache/gate/delegation artifacts or execution counts.

**P8b lifecycle wiring (landed).** The P8b wiring in `index.ts`:

- **BEGIN (pre-execute, policy-gated).** At the END of the `tool_call`
  guard — after every worker/commander/mode/path/lease check has allowed —
  each side-effecting workbench tool (recipe/gate execution, delegation and
  review) begins an exclusive started receipt (native Pi session id +
  `event.toolCallId` +
  exact tool name + canonical input hash; the effective project root is
  resolved like each tool's own execute). BEGIN completes BEFORE the tool
  executes. A matching `completed_replay` and every incomplete/corrupt/
  conflict/invalid/storage outcome block fail-closed with a short fixed
  reason (carrying the durable result id and a recover instruction) and the
  tool never executes — exact same-toolCallId identity only; P4 validation
  evidence is never consulted.
- **Replay-safe reads bypass receipts.** Project inspect, run/gate read/list,
  run comparison, delegation status and receipt recovery execute without a
  started/finalized receipt, so current-state reads remain current and add no
  per-call receipt files.
- **Capacity blocks, never evicts.** When the in-memory handle map is
  already at `MAX_IN_FLIGHT_RECEIPTS` (256), a new registered workbench
  call is blocked BEFORE begin/execution with a fixed bounded reason;
  existing pending handles are never evicted and nothing is begun for the
  blocked call (no orphaned started receipt).
- **FINALIZE (exact dual match).** One `tool_result` handler finalizes ONLY
  a handle begun by this runtime with the EXACT same `toolCallId` AND the
  exact same tool name — a tool-name mismatch never finalizes (the started
  receipt stays incomplete, the in-memory handle is consumed, and only a
  bounded `tool_name_mismatch` fact is merged). Text blocks only, env
  secrets scrubbed, status success/error, bounded redacted summary —
  before Pi emits `tool_execution_end`/final result events. The handle is
  removed after the attempt; success merges safe structured recovery
  metadata (available, result id, project-relative receipt path/status)
  into object details without changing content/isError/caps; failure never
  claims availability, never rewrites/rolls back domain artifacts, and
  merges a bounded unavailable code. Replay-blocked and recovery-tool
  results never finalize anything.
- **Public read-only recovery tool.** `workbench_recover_tool_result` is
  appended LAST in the catalog/registration order (strict Sol DEV
  allowlist 14 → 15 = 11 workbench tools; an ACTIVE user lease adds
  edit/write → 17; AUDIT/VERIFY read-only sets) and is NOT receipted
  itself. It takes EXACTLY ONE of `result_id` (strict `wtr1-` shape) or
  `tool_call_id`; the `tool_call_id` path validates the CURRENT native Pi
  session identity AND the parameter BEFORE any hash (absent/invalid/
  control-character/over-bound identity fails closed with the fixed
  `invalid` code and hashes nothing), then derives the id. It calls only
  `recoverReceipt` + the bounded renderer; fixed fail-closed codes
  `invalid`/`missing`/`incomplete`/`corrupt`/`conflict`/`storage_error`;
  it reads no raw logs/domain records, runs no other tool, performs no
  refresh, never re-executes the original call, and labels persisted
  summaries non-acceptance evidence.
- **Isolation and repository hygiene.** `.pi/workbench/tool-results/` is
  gitignored, and the delegation ledger excludes the receipts subtree from
  the git facts it records exactly like its own records (sibling-safe
  prefix match, so `.pi/workbench/tool-results-extra/...` never matches).
  Legacy no-receipt sessions (absent/invalid native session identity) fail
  closed. This repository implements **NO WebSocket (or any other)
  transport** — receipts are plain files on disk with no network path;
  the workbench owns no transport.

## Trust and identity

- Project root: `git rev-parse --show-toplevel`, else `ctx.cwd`.
- P8: the **effective project root** (project.yaml `project_dir`, default
  the repository root) is resolved safely after config load — see
  [Nested projects (P8)](#nested-projects-p8).
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
- P2 skills (5 default workflow/router skills + 9 explicit specialists),
  concise prompt templates, project templates, and conditional references
- P3 gate engine (B0-B5/Q0-Q5), evidence artifacts, quant-result contract
- P4 TUI status/widget, run reports, run comparison, tool renderers, JSON
  artifact snapshots
- P5 path protection, token-based command guard, state recovery, compaction
  supplements, milestone session handoff, compatibility docs
- P6-A DeepSeek prompt-cache telemetry and baseline: content-free hash/numeric
  usage/context observability, inferred invalidations, JSONL store with rotation,
  /q-cache-status /q-cache-report /q-cache-doctor, footer cache segment
  (observation only — no Recipe Action Cache yet)
- P7: split session-cost observability — pure cost-breakdown module
  (commander/worker/other buckets mirroring Pi's footer aggregation), COST
  status segment, current assistant/tool-result message_end refresh,
  /q-cost-status
- Commander token optimization Slice A (P0+P1): additive session
  observability (exact commander request count, compactions, exact
  unabridged commander gross-token facts with a deterministic one-decimal
  cacheRead share — full digits, defensively normalized, never
  k/M-compacted; per-tool
  inline TEXT UTF-8 byte attribution — numeric/IDs/tool names only; tool
  arguments are never inspected; textual toolResult content is read solely
  to compute UTF-8 byte length and is never persisted, retained, or
  rendered) and the
  bounded recipe/gate parent-result summary policy
  (`core/result-summary.ts`: 4096-byte/40-line success and
  12288-byte/120-line failure summaries with failure-first precedence and
  full-log path references, wired into `workbench_run_recipe`,
  `workbench_run_gate`, `/q-run` and `/q-gate`); full logs/records stay
  persisted; a fresh `/reload` + `/q-cost-status` capture remains
  required before any later re-measurement. Slice A is PASS: the final
  full `check` run `20260805-141013-i4lx` passed 879/879 and the
  Commander gates run `20260805-141242-tyt8` passed b0-b6; the recorded
  95.35% P1 reduction remains an observational recipe-inline-byte-only
  figure (docs/baselines/commander-token-p0.md), never causal or overall
  savings; worker budgets/defaults and review/gate
  responsibilities unchanged
- P4b (validation-assessment slice): `workbench_read_run` reports the
  current-state reuse verdict (`REUSABLE` / `RERUN_REQUIRED` with fixed
  P4a reason codes) as the REQUIRED bounded `validation :` line in every
  include mode plus the additive `details.validation` — recipe targets
  are rebuilt from the current declaration + the persisted invocation
  identity cross-checked against the manifest `argv_hash`; gate targets
  from the current effective catalog + strictly validated
  gates.json/evidence.json source artifacts (`readPersistedGateRunFacts`
  rejects foreign schema versions, contradictory gates/evidence/manifest
  identity facts and malformed/extra source evidence); the read path is
  strictly read-only (no run-artifact/session/delegation writes, no
  in-memory delegation-state mutation, no P6-C action-cache contact —
  gate execution keeps its mutating refresh); verdicts never auto-skip
  recipe/gate execution and are never acceptance evidence
- Commander token optimization Slice B1 (P2 layered workbench_read_run
  results + P3 read-only batching guideline): `core/run-result.ts`
  (pure) renders the ordered Summary/Evidence/Persisted layers — the
  omitted `include` now defaults to `summary` (≤ 4096 UTF-8 bytes / 40
  lines, sanitized and code-point safe, never raw stdout/stderr,
  per-test lines, or argv, durable project-relative run-dir/manifest/
  summary/stdout/stderr paths, and a REQUIRED Evidence-layer
  logs/argv guidance line with the exact `include=logs`/`include=all`
  opt-in instruction that survives adversarial fields/lists and the
  caps; dropped optional cache/quant lines and bounded/truncated
  metadata/path/list displays are recorded in the aggregate with
  durable sources — machine facts are never silently lost; explicit
  `manifest` adds bounded cwd/argv metadata without tails; explicit
  `logs`/`all` append only the existing caller-bounded log tails); the
  tool schema/metadata wording declares the summary default; the
  deterministic
  `INDEPENDENT_READ_ONLY_ALLOWLIST` classifier (read/grep/find/ls +
  project_inspect/read_run/read_gate/list_gates/compare_runs only;
  delegation_status and every execution/review/delegation/write tool
  excluded; never infers independence) plus exactly one static batching
  prompt guideline; structured details and disk records unchanged
  (legacy records render identically); no tool/order/mode change;
  worker budgets/defaults and the durable plan unchanged
- Commander token optimization Slice B2 (P2 coverage-gated segmented
  actual-diff review): additive displayed-path coverage facts on review
  records (`core/diff-review.ts` displayed_paths / remaining_paths /
  coverage_complete plus presentation fields / review_path) — a worker path is displayed only
  when it appears in an ACTUALLY rendered patch entry (a globally
  omitted path never counts; an ordinary truncated source entry is visible
  but does not complete semantic presentation until repeated single-path calls
  cover its contiguous hash-bound byte pages); prior displayed coverage
  merges ONLY from the persisted review.json with the SAME
  bound_diff_hash and valid worker-path membership (legacy
  schema_version-1 records stay readable and infer prior coverage ONLY
  from their persisted patch entries; rendering recomputes
  displayed/remaining from valid checked worker paths, so absent or
  malformed persisted coverage arrays or coverage_complete flags never
  render a false COMPLETE); a hash change resets coverage (only
  prior-hash coverage is dropped — this call's rendered paths stay
  displayed); every review segment re-runs the full scope check over
  EVERY worker path and binds the complete current diff hash
  (include_paths narrows only the rendered patch; defaults 400 lines /
  32 KiB, max 50 include_paths, redaction and the worker scope
  unchanged);
  `workbench_review_worker_diff` is callable repeatedly on the latest
  delegation (PENDING_REVIEW / STALE / REVIEWED). Every non-zero delta
  first remains provisional/PENDING_REVIEW. REVIEWED requires scope PASS,
  complete presentation, and a second active-Sol call with paired
  semantic_decision=ACCEPT plus the exact previously presented bound hash;
  a complete but wrong packet instead requires semantic_decision=REPAIR,
  the same exact hash, and bounded repair_reason, which persists immutable
  negative authority and leaves review/Gates blocked while enabling only the
  exact fresh repair_of lineage;
  a same-hash accepted replay is idempotent, a changed hash resets coverage
  and acceptance, and ANY re-review that is not PASS with complete presentation (a scope FAIL or an
  incomplete PASS, e.g. a legacy partial review record) invalidates a
  prior same-hash REVIEWED state fail-closed via the
  pure `demoteReviewedToPending` transition
  (`core/delegation-state.ts`: REVIEWED → PENDING_REVIEW, reviewed hash
  cleared; pending/stale stay safely blocking); deterministic rendered
  displayed/remaining counts, bounded next include_paths guidance (max
  50 paths AND ≤ 1024 UTF-8 bytes, complete paths only with an exact
  omitted count), an additive per-path page cursor/stream SHA-256 plus an
  O(paths) recomputable prefix receipt and latest range/hash for ordinary sources up to 4 MiB (advanced
  only after the complete page is visible and rebuilt against current source
  authority before ACCEPT), the
  review-complete fact and the durable
  project-relative review.json path; details expose review_record +
  presentation facts; the explicit semantic API is Sol-only, hash-bound,
  unavailable to legacy/finalized mechanical records, and never Gate
  authority; review writes stay review.json + the
  existing state entry only. Phase 5 (Execution Efficiency
  Optimization) adds compact/withheld presentation, still internal to
  the same service: compact eligibility is automatic — a CURRENT
  REGULAR `.svg`/`.json` worker path strictly LARGER than the default
  global review byte cap (COMPACT_MIN_BYTES = DEFAULT_REVIEW_MAX_BYTES
  = 32 KiB, case-insensitive extension) — with no public opt-in/
  argument and no generated-marker inference; a compact entry is built
  only from stat + bounded 8 KiB head/tail window reads (no per-path git
  diff capture and no additional unbounded/full-file DISPLAY or preview
  capture — the preserved EXISTING bounded content digest may read the
  complete file through 4 MiB, with bounded prefix+size beyond), with
  redacted, UTF-8-safe
  previews bounded to ≤ 1 KiB / 12 complete lines each (head = bounded
  PREFIX, tail = bounded SUFFIX, JSON-escaped single lines that can
  never defeat the global line caps; a window holding no complete line
  falls back to its bounded partial-line text, and every byte/line/
  window field describes exactly the SHOWN preview), plus the path's
  current porcelain status, real size and the EXISTING content digest
  (full sha256 through 4 MiB; honestly labelled `sha256-prefix+size`
  beyond — MAX_DIGEST_BYTES semantics unchanged) with recorded-after
  equality; `generator_equality` is ALWAYS `NOT_VERIFIED` — the review
  executes/imports no repository generator, so independent
  current-state regeneration/byte comparison remains required; a
  scope-violating/realpath-escaping worker path is represented ONLY by
  the fixed bounded `withheld` marker, decided BEFORE any per-path git
  diff/open/read/digest/render, while the whole-diff scope check and
  the current complete diff-hash binding still cover the complete
  actual worker diff. A complete strict compact entry can satisfy
  presentation while remaining high risk and requiring final generator
  verification; withheld, malformed compact, omitted and ordinary truncated
  entries cannot. Full scope semantics, include_paths-as-display-filter and later-change
  STALE semantics are unchanged
- P7: worker context-budget protection — pure `core/worker-budget.ts`
  (272,000-token pinned window, 80% soft handoff / 90% hard stop,
  Pi-compatible context tokens), one-shot hidden soft-budget steer and
  compaction cancellation in the worker-role lifecycle only, runner
  budget/compaction tracking with fail-closed hard stop and compaction
  rejection, budget/compaction facts in the worker report
- Historical P7 introduced the serialized `worker-first-strict` policy id,
  bounded leases, delegation records, review state, and the B6 machine check
kind. Current DEV behavior is fixed Sol -> Luna: routine writes are delegated,
direct Sol edit/write requires the bounded temporary lease, a successful v2
  delegation returns a provisional scope/integrity packet and stays pending
  until explicit hash-bound Sol semantic acceptance, and B6 is presented as Development
  Safety. Historical records remain readable for compatibility. Generated
  project AGENTS files own the complete fixed Sol -> Luna policy; q-build and
  the implementation skill carry a mandatory pointer without duplicating the
  lease and review clauses in every prompt.
- P8 (this release): safe nested project support — optional `project.yaml`
  `project_dir` (default `.`) resolved after config load into the safe
  effective project root (`core/config.ts`: absolute-path, `..`-escape and
  symlink-escape rejection; target must exist and be a directory; any
  violation is a `project.yaml` ConfigIssue with a repository-root
  fallback); stack detection reads only the effective root's top level
  (`core/inspect.ts`) while git and config-files-present stay
  repository-root based; gate file/json/numeric/schema checks resolve
  against the effective root with realpath containment (`core/gate-engine.ts`;
  only the built-in b0.4 workbench-config check anchors at the repository
  root, via internal catalog-only `file_root` metadata — the public gate
  schema has no `root` option) while gate config, run persistence, recipe
  execution, artifact run
  records and git stay at the repository root (recipe `cwd` semantics
  unchanged); `workbench_project_inspect` exposes `effective_project_root`
  and the renderer shows the effective root; templates, README and
  onboarding docs updated.
- Commander token optimization P8a: durable two-phase tool-result receipt
  core (`core/tool-result-recovery.ts`, pure, no Pi imports) —
  deterministic `wtr1-` ids from bounded native Pi session identity +
  toolCallId, raw input canonical-hashed and never persisted,
  redaction-first bounded summaries, strict fail-closed two-phase replay
  (completed requires BOTH matching phases; corruption/symlink/missing/
  incomplete fail closed), repository-owned
  `.pi/workbench/tool-results/<id>.started` + `<id>.json` (0700/0600,
  atomic no-overwrite publish), legacy-additive; no wiring at the P8a
  milestone and no WebSocket transport.
- Commander token optimization P8b (landed): public wiring of the reviewed
  P8a core — BEGIN at the END of the `tool_call` guard (after every
  worker/commander/mode/path/lease check, pre-execute) for every registered
  workbench tool EXCEPT the public recovery tool, fail-closed
  replay/corrupt/conflict/invalid/storage blocking, and capacity pre-block
  at MAX_IN_FLIGHT_RECEIPTS (256) with no eviction; one `tool_result`
  handler FINALIZES only handles begun by this runtime with the EXACT same
  toolCallId AND tool name (mismatch never finalizes), redaction-first
  bounded summaries, atomic no-overwrite publish, safe structured receipt
  metadata merged into object details; public read-only
  `workbench_recover_tool_result` appended LAST (strict Sol DEV allowlist
  14 → 15 = 11 workbench tools; active lease 15 → 17; AUDIT/VERIFY
  read-only sets; NOT receipted itself) with exactly-one
  result_id/tool_call_id and current-session validation-before-derive;
  `.pi/workbench/tool-results/` gitignored and excluded from delegation
  git facts; no WebSocket (or any other) transport — receipts are plain
  local files.
