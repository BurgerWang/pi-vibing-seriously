# Controlled Worker Delegation

pi-dev-workbench can delegate one bounded implementation or diagnosis task from a
GPT-5.6 Sol commander to a pinned GPT-5.6 Luna worker without introducing a
standalone agent framework, daemon, queue, or background service.

## Roles

| Role | Model | Authority |
| --- | --- | --- |
| Commander | `openai-codex/gpt-5.6-sol` or `openai/gpt-5.6-sol` | Requirements, cross-cutting architecture, bounded worker contracts, review, high-risk decisions, final verification |
| Worker | `openai-codex/gpt-5.6-luna:xhigh` | Routine local implementation decisions inside the approved contract: concrete design, naming, file structure within scope, production source changes, tests, docs, write-free recipe checks, in-scope repair |

The worker report is never acceptance evidence. Its Verification section
records only commands and observed results; it must not label an acceptance
criterion satisfied, met, passed, accepted, or complete. The caller maps
evidence to criteria and runs final verification when task or release risk
requires it.

### Responsibility split

| Owned by Sol | Owned by Luna (inside the approved contract) |
| --- | --- |
| Requirements and acceptance criteria | Concrete design and naming choices |
| Cross-cutting architecture and scope | File structure within the approved paths |
| Delegation contract, cross-cutting decisions, exceptional lease decision, and final verdict | Production source changes, tests, and docs in a bounded task |
| Risk-proportionate final verification and the verdict | Investigation, write-free recipe checks, in-scope repair |

The worker is expected to implement the complete delegated slice — relevant
investigation, production source changes, tests, docs, requested write-free
recipe checks when available, and repair of in-scope defects it finds —
rather than stopping after a narrow code edit. Everything outside the
approved contract, and every final judgment, belongs to Sol.

## Risk rubric

| Risk | Shape | Delegation |
| --- | --- | --- |
| Low | One contained change with a clear contract | One bounded Luna implementation plus focused tests |
| Medium | Touches several files or modules, but the contract is unambiguous | One coherent bounded Luna implementation; split only at a real contract boundary |
| High | Dependency, security/policy, deployment/migration, Pi control paths, destructive action, or release authority | Sol owns the decision and bounds Luna's writes; a user-issued lease is only an explicit Sol direct-write exception |

Ordinary work does not become high risk merely because it changes source,
tests, documentation, or repairs a defect. It is still implemented by Luna
inside one bounded contract. A partial result is repaired through one new
bounded Luna call only when recovery is actually needed; routine work does
not require a manual status call or separate review step. High-risk
classification must name the concrete permission, security, migration,
destructive, or release concern.

## Bounded worker continuation

Every delegation is a brand-new `--no-session` worker and cannot recurse. If
another delegation is required, Sol supplies a new bounded contract and the
current worktree is the source of truth. Continuation is used only for a real
remaining slice or recovery condition; it is not a mandatory ceremony after
a complete delivery. Worker prose is never durable authority.

## Worker execution discipline (prompt contract)

The worker system prompt (`extensions/workbench-runtime/worker/runner.ts`,
`WORKER_SYSTEM_PROMPT`) pins three mandatory execution disciplines on top
of the delegation contract: **EARLY CHECKPOINT**, **STOPPING HYGIENE**, and
**SHORT REPORT**. These disciplines improve worker efficiency and handoff
quality, but they are prompt-level behavior shaping only — mechanical scope
enforcement, actual-diff review, and final verification never depend on
prompt compliance and remain authoritative regardless of what the prompt
says or how the worker behaves:

- **Scope:** allowed-path checks, the write guard, and the real-diff review
  (`workbench_review_worker_diff`) are enforced in code, never by the
  prompt; a prompt violation can never expand the approved paths.
- **Review and gates:** Sol reviews the actual diff and runs the final
  recipes/gates; a worker report is never acceptance evidence.
- **Bounds:** report parsing caps, ledger redaction, and budget enforcement
  are mechanical; the prompt's own format rules sit on top as a
  worker-side discipline.

Changing the prompt text intentionally shifts the system-prompt hash once;
like the Phase 3 `budget_profile` transition, cache telemetry records it as
`UNEXPECTED_DRIFT` (expected, not a defect) and same-mode fingerprints
remain stable after reload.

### EARLY CHECKPOINT

After inspecting the relevant files and before the first write, the worker
privately compares its planned changed paths, acceptance criteria, and
verification against the exact contract and the remaining spend. If the
plan does not fit — scope drift, missing criteria coverage, or spend
pressure — the worker stops and reports to Sol instead of expanding. Spend
awareness comes from the profile line in the task text and the hidden
cumulative soft steer; hard enforcement stays in the runner.

### STOPPING HYGIENE

Before the final response, the worker re-reads every changed path and
confirms: no accidental out-of-scope writes, no stubs or TODO placeholders,
no accidental generated artifacts, and that every requested check is
reported truthfully. Hygiene is a verification step only — it must not
trigger unrelated cleanup, which would itself be an out-of-scope write.

### SHORT REPORT

The worker keeps exactly the four final headings (`## Completed`,
`## Files Changed`, `## Verification`, `## Remaining Risks`). The
four-bullet / 240-character cap applies only to the three prose sections:
`Completed`, `Verification`, and `Remaining Risks` each take at most 4
single-line bullets of at most 240 characters. `Files Changed` is
explicitly exempt from that cap: it must truthfully list EVERY actually
changed project-relative path, exactly one path per single-line bullet and
no prose, so a valid slice with more than 4 changed paths can still be
reported completely instead of forcing the worker to drop real paths and
create avoidable reported/actual divergence warnings. The list stays
mechanically bounded by the ledger's existing 500 changed-path fail-closed limit, and `- None.`
is used when nothing changed. `Verification` reports only the command and
its observed outcome — never logs; the task and acceptance criteria are
never repeated. The exemption preserves path auditability in the report
while the actual diff remains authoritative: mechanical scope enforcement,
the automatic real-diff review in the normal delegation call (with
`workbench_review_worker_diff` retained for incomplete/conflict recovery),
and final verification never depend on the prompt's format rules. These are
worker-side format rules; the mechanical report caps (≤ 8 parsed items per
section, ≤ 500 characters per item, byte-bounded rendering) still apply on
top.

### Repair semantics

A partial or defective delivery is repaired through a fresh bounded
`--no-session` Luna worker because worker sessions are intentionally not
resumed. The optional `repair_of` field records provenance for that repair;
it never adds a second governance step or expands scope. Mechanical scope
checks and risk-proportionate final verification remain authoritative.

### Repair provenance pointer (`repair_of`, Phase 4A)

The delegation tool exposes one optional public parameter, `repair_of`, for
repairs whose root cause is already known. It is a strict pointer —
provenance only, never a resume:

- **Public shape:** exactly 20 characters — `^\d{8}-\d{6}-[A-Za-z0-9]{4}$`
  — a prior delegation id such as `20260101-120000-abcd`. Omitted for
  ordinary delegations; any malformed value fails closed with a bounded
  error before any v2 transaction is prepared or any worker is launched.
- **Use:** only after Sol has fixed the known root cause and decided the
  scope. The parent task itself must carry the bounded root-cause/failure
  evidence; the pointer adds none.
- **Strict v2-first authority:** the runtime first strict-reads the prior
  delegation's committed v2 authority. Terminal v2 states `FAILED`,
  `FINISHED`, or `REVIEWED` are referenceable. There is one narrow recovery
  exception for an unpublished artifact-construction failure: the prior
  transaction must be exactly `RECOVERY_REQUIRED` with complete terminal and
  scope facts, `committed_proof=null`, an exact bounded artifact error reason,
  a strict complete `SEALED` write journal, and no published generation. An
  explicit `repair_of` may then start a fresh repair and supersede the blocking
  session mirror; it never marks the old delegation reviewed and never rewrites
  its transaction or journal. Other pending, corrupt, unknown-version, or
  invalid v2 authority fails closed and never falls back to v1. Only a strict
  v2 `not_found` result permits the historical read-only fallback, which
  accepts a finished v1 manifest with its `after` record. This check finishes
  BEFORE any new v2 transaction is prepared or any worker is launched.
- **What is not inherited:** the fresh worker inherits no prior report
  (`worker-report.md`), no prior summary, no prior session, no prior
  allowed paths/scope, and no prior contract fields. `repair_of` never
  expands path/scope/authority and never resumes the prior worker.
- **Unknown root causes** still follow bounded diagnosis → Sol
  architecture/scope decision → bounded implementation; `repair_of` is
  never a substitute for that path.

## One writing worker per worktree

The delegation tool executes sequentially and a worker can never delegate,
so at most one worker writes to a worktree at any time. Sol never starts a
second delegation that could write the same worktree before the first has
returned and its diff has been reviewed. `PENDING_REVIEW` remains a hard
block. A `STALE` mirror is also blocking unless strict v2 authority proves the
old transaction already has an immutable FINAL/PASS review; in that one case
an ordinary fresh successor may atomically adopt the current workspace as its
new baseline after live revalidation. Parallel reads are fine; parallel writes
are not supported and must never be attempted.

## Pi-native lifecycle

`workbench_delegate_worker` is a statically registered workbench tool. It is
part of the deterministic DEV tool matrix and absent from AUDIT and VERIFY.
One invocation:

1. checks project trust and the active commander provider/model;
2. validates the structured task contract and resolves the public
   `task_kind`: omission preserves compatibility by resolving to
   `implementation`; Stage 1 enables only `implementation` and `diagnosis`,
   while `mechanical` (or any unknown value) fails closed;
3. refreshes the delegation review state against its versioned binding and
   refuses to start while review authority is pending, invalid, unpublished,
   recovery-required, or non-final. If the exact latest mirror is `STALE` but
   strict v2 committed authority proves its old review is already FINAL/PASS,
   an ordinary fresh successor is allowed after a second pre-launch authority
   check and atomically adopts the current workspace as its new baseline. The
   old transaction and review remain immutable; VERIFY stays blocked until the
   successor is reviewed. A new tagged v2 generation uses the ChangeSet
   relevance binding described below, while historical untagged v2/v1
   authority retains the complete full-diff binding;
4. writes `PREPARED` to the single v2 transaction authority at
   `.pi/workbench/delegations/<id>/v2/transaction.json` BEFORE the child is
   launched, then advances it to `RUNNING` using revision-checked state
   transitions;
5. starts one short-lived `pi --mode json -p --no-session` child process and
   pins `--model openai-codex/gpt-5.6-luna:xhigh`;
6. streams bounded progress from Pi JSON events and verifies every assistant
   event reports the exact pinned `openai-codex/gpt-5.6-luna` identity;
7. tracks per-message context tokens against the pinned budget (soft
   handoff / hard stop, see below) and rejects any `compaction_start` event;
8. accumulates the cumulative delegation-spend state after every assistant
    message (pure `core/worker-spend.ts` policy — turns / total tokens /
    output tokens per the active profile) and terminates the child fail-closed
    when cumulative total/output reaches a hard limit; turn markers only steer
    and remain observable (see below);
9. terminates the child on completion, timeout, parent abort, hard-budget
    stop (context or cumulative total/output spend), or a compaction attempt;
10. advances to `COMMITTING`, evaluates fixed machine postconditions, and
    stages one immutable generation at
    `.pi/workbench/delegations/<id>/v2/generations/g########/` containing
    exactly eight records — `after.json`, `before.json`, `identity.json`,
    `review.json`, `scope.json`, `usage.json`, `worker-report.md`, and
    `worker-summary.json` — plus `commit-marker.json`; publication requires
    the exact record inventory and a full-byte content-hash/marker proof;
11. publishes a complete successful generation as `PENDING_REVIEW` for an
    implementation or `FINISHED` for a diagnosis. A fully evidenced worker
    or postcondition failure publishes `FAILED`; missing terminal,
    persistence, identity, or generation facts require
    `RECOVERY_REQUIRED`, never a business-success state;
12. returns a STRICTLY bounded structured summary to the parent session
    (delegation id, provider/model, status, actual changed paths, bounded
    parsed section items, usage/cache/budget facts, durable report path,
    parse/review warnings) — never the worker's report text, patch, or
    test logs.

There is no persistent worker process. The child inherits the user's OS
permissions and provider authentication, just like any other Pi process.

## Fixed Sol -> Luna write authority (current; legacy id P7)

Approved GPT-5.6 Sol in DEV receives the fixed 15-tool
read/control/delegation surface. `bash`, `edit`, `write`, and foreign tools
remain unavailable by default. The persisted policy id
`worker-first-strict` describes the active product behavior: routine source,
test, and documentation edits are delegated to Luna.
Actor identity comes only from the existing
`WORKBENCH_AGENT_ROLE=worker` env contract and the provider/model pair;
project config can never self-label a controller as Sol or as a worker.
Delegated workers and other controllers are outside the policy: the existing
worker guards remain authoritative for workers, and other controllers are not
newly denied.

Consequences for the commander workflow:

- `bash` is always blocked for strict Sol — project commands run through
  declared workbench recipes only.
- Sol does not receive ordinary `edit`/`write`; routine implementation is a
  bounded Luna delegation.
- Any direct Sol `edit`/`write` requires a **temporary write lease exception**, issued by the
  human through user-only slash commands (never by prompts or config):
  `/q-commander-write-unlock <reason> --paths <comma-list> --calls <N>
  --minutes <N>`, with fixed reasons `bootstrap-policy`,
  `worker-unavailable`, `security-emergency`, `user-directed`; project-
  relative exact paths or `/**` subtrees (absolute POSIX, Windows drive and
  backslash-root paths are rejected before normalization, `..` escapes
  refused); `edit`/`write` only, never `bash`; **max 10 calls / max 30
  minutes**, one call consumed per successful authorized write.
- Confirmation is mode-split: the real TUI requires an explicit human
  confirmation dialog (cancel leaves everything locked); non-TUI
  (print/json/RPC) issues a PENDING lease that displays two bounded distinct
  confirmation token parts exactly once, and a second invocation
  `/q-commander-write-unlock confirm <partA> <partB>` (optionally
  `confirm <lease-id> <partA> <partB>`) activates it — both exact parts are
  required and both are consumed on success. Token parts never appear in
  status or compact summaries.
- Expiry (30 min), exhaustion (10 calls) and revocation (leaving DEV, model/
  provider change, session end, or `/q-commander-write-lock`) restore the
  locked 15-tool Sol surface. The footer
  shows `WF:LEASE <used>/<max>` while an active confirmed lease exists and
  `WF:LOCKED` otherwise; `WF:REVIEW` is
  appended independently while a delegation review is pending or stale.
  `/q-write-policy status` (which accepts exactly the trimmed `status`
  subcommand) prints the actor, the fixed policy, the lock/lease status and a
  bounded lease summary — never any token part.
- Recipe mutation policy (P7): every recipe declares
  `mutation: none | artifacts | source`; strict Sol runs only
  `none`/`artifacts` recipes and delegated workers only `none` (write-free)
  recipes — `source`-mutating recipes are denied to both (legacy inference
  maps non-empty declared `writes` to `source`; other controllers are
  unaffected).

## Delegation transaction and review lifecycle (P7)

New public delegations have one write authority: delegation transaction v2.
The mutable CAS state is
`.pi/workbench/delegations/<id>/v2/transaction.json`; its successful terminal
facts bind exactly one immutable
`.pi/workbench/delegations/<id>/v2/generations/g########/` directory. That
generation is not authority unless all eight required records and its
`commit-marker.json` pass the strict full-byte inventory, content-hash,
delegation/task/generation/revision, contract, and pinned-identity proof.
Partial, foreign, or ambiguous generations never publish success.

The normal transaction paths are:

```
implementation: PREPARED → RUNNING → COMMITTING → PENDING_REVIEW → REVIEWED
diagnosis:      PREPARED → RUNNING → COMMITTING → FINISHED
```

An implementation can reach `PENDING_REVIEW` only with a nonempty actual
delta, complete scope facts with no out-of-scope changes, and a delta hash. A
diagnosis can reach `FINISHED` only with zero actual delta, zero successful
write attempts, zero denied write attempts, and a complete report. Both
successful paths also require provider success, exit code 0, a complete
report, complete terminal facts, and the exact pinned/observed worker
identity. Provider success, exit code 0, or reassuring worker prose cannot
bypass any other postcondition. A fully recorded worker/postcondition failure
becomes `FAILED`; incomplete terminal or generation facts become
`RECOVERY_REQUIRED`.

`PREPARED` and `RUNNING` also carry a separate bounded
`v2/execution-owner.json` while the owning Pi process is executing. The owner
binds the delegation, contract, worker identity, OS boot id, PID, and process
start identity; normal terminal paths remove only their exact owner token. On
session start, reconciliation may atomically convert an interrupted transaction
to `ABORTED` without review only when the owner is provably dead and the write
journal is either not yet created for PREPARED or is exactly empty OPEN
revision 0, with no generation, review, lock, temporary, or other artifact.
Historical transactions written before execution-owner support require the
transaction timestamp plus both transaction and journal file mtimes to predate
the current OS boot. A live/reused/unverifiable owner, any write evidence,
`COMMITTING`, corrupt data, or ambiguous inventory remains blocking and is
never cleared optimistically. A recovered `ABORTED` transaction is terminal
FAIL evidence; status instructs the parent to start a fresh delegation rather
than retry review.

Records are atomic, bounded, redacted, and never contain full worker
transcripts or secrets; the delegation directory is excluded from workspace
facts. New tagged v2 `before.json`/`after.json` records identify their
workspace binding as `workspace_guard_v2`: their compatibility-named
`diff_hash` fields bind the corresponding metadata-only workspace guards,
while full streaming identities already captured by the write journal and
ChangeSet finalizer bind the attributed worker delta. `after.json` carries
the attributed worker paths, the wider changed-since-before union (worker
delta, workspace drift, and conflicts), the split `worker_delta_hash` and
`workspace_guard_hash`, pinned identity, outcome, usage/budget facts, a
bounded redacted report summary, and the safe `reported_paths` parsed from
the worker's bounded `## Files Changed` section.

Implementation review authority is written only to
`.pi/workbench/delegations/<id>/v2/review.json`. Review is strict v2-first:
the immutable committed generation is validated before the mutable review
artifact is read. A segmented provisional PASS, incomplete coverage, or any
FAIL may persist bounded evidence but never grants authority and never moves
the transaction to `REVIEWED`. Only a complete `PASS` with complete path
coverage atomically publishes the final review and the `REVIEWED` transaction
state. For new tagged v2, the immutable review binds a schema-v2
`changeset-relevance-v2` projection over the closed relevance set: W is the
attributed worker delta, D is the explicit dependency closure (empty by
default), and S is the relevant control set (fixed workbench configuration,
applicable `AGENTS.md`, and managed policy/schema paths). Every W/D/S entry
uses a full streaming identity. Baseline unrelated dirty paths (B) and
recognized workbench artifacts are deliberately excluded; a Git HEAD change,
W/D/S drift, or a new unknown-origin dirty path (U) fails closed. Historical
untagged v2 and v1 reviews retain their complete full-diff binding.

Strict replay accepts a finalized artifact only while its versioned binding
still matches: its W/D/S relevance projection for new tagged v2, or the full
current diff for historical untagged v2/v1. A relevant/unknown-origin conflict
or a legacy full-diff change projects the session mirror to blocking `STALE`
without changing the immutable final artifact.

Session lifecycle (single latest-delegation mirror, persisted as the
`workbench-delegation-state` custom entry):

```
PENDING_REVIEW → REVIEWED → (versioned binding conflicts) → STALE
```

- **Default implementation delivery:** after a successful worker result, the
  same `workbench_delegate_worker` call reads the current workspace guard,
  automatically continues the bounded segmented review below over every
  attributed worker path, and publishes a complete PASS as `REVIEWED` in the
  same call. Ordinary development therefore continues without a manual
  `review` or `status` call. Explicit review recovery is required only for a
  review conflict, persistence failure, no-progress condition, or the fixed
  32-segment safety cap.
- **`workbench_review_worker_diff`** (DEV-only recovery path): reads the current
  workspace guard and strict v2 authority, scope-checks EVERY worker path
  against the parent-approved `allowed_paths` with a realpath/symlink-safe check
  (`include_paths` narrows only the patch output and can never hide a
  violation; unsafe or non-worker entries are refused), constructs the
  new-v2 W/D/S relevance projection (or the historical complete full-diff
  binding for untagged v2/v1), warns when the worker report's `## Files
  Changed` section is missing or does not match the attributed worker delta,
  and returns a globally bounded redacted patch
  (default 400 lines / 32 KiB over the whole rendered patch; per-path stats
  plus a segmented `include_paths` review instruction when truncated or
  omitted — scope checks always cover the complete worker delta, while the
  bound hash covers W/D/S relevance for new tagged v2 or the complete diff
  for legacy authority). Verdict `PASS` marks the delegation REVIEWED;
  `FAIL` (any out-of-scope path) keeps it PENDING_REVIEW. Large or incomplete
  coverage also stays pending and is the reason to call this recovery tool.
  The v2 review artifact binds
  the versioned current binding. The session mirror is prospective:
  `REVIEWED` unlocks only after its append succeeds. An append failure never
  unlocks memory or the compact mirror and is returned as a persistence
  failure; retry may replay the immutable final artifact. A failed blocking
  `STALE` append remains a hard in-memory/compact block and is never reported
  as durably persisted.
- **`workbench_delegation_status`** (and `/q-delegation-status`): actor,
  fixed policy, lease status (bounded summary — never token parts), latest
  delegation, review status, current/reviewed diff hashes, blocked write
  attempts, latest review verdict. The compatibility field names remain, but
  new tagged v2 refreshes the W/D/S relevance binding: B and recognized
  workbench artifacts do not stale it, while Git HEAD, W/D/S, or U conflicts
  fail closed. Historical untagged v2/v1 refreshes the complete full-diff
  binding, so any diff change there turns a reviewed delegation STALE.
- **Blocking:** a pending or stale review blocks VERIFY (`/q-mode-verify`
  refuses, and `/q-gate`/`workbench_run_gate` are refused in VERIFY) until
  the active delegation's versioned binding is reviewed. It also blocks the
  next delegation by default. The only successor exception is exact latest
  `STALE` plus strict committed v2 FINAL/PASS authority: the immutable old
  review is preserved, the authority is revalidated immediately before worker
  launch, and a fresh delegation replaces the stale session mirror with its
  current-workspace baseline. No `repair_of` is used. `PENDING_REVIEW`,
  corrupt, unpublished, recovery-required, non-final, v1, and untagged
  authority remain blocked. `reviewedDiffHash === currentDiffHash`
  remains the compact compatibility invariant: those fields hold the W/D/S
  projection hash for new tagged v2 and the complete diff hash for historical
  authority. A binding that returns to exactly the reviewed hash re-validates
  (back to REVIEWED). Blocked commander write attempts are counted while a
  review is outstanding.
- **B6 Development Safety (legacy P7 machine kind `worker-first`):** a
  machine-backed universal base gate. The runtime injects bounded safety facts
  into every gate run (development policy active, zero unauthorized high-risk writes, no
  pending/stale review, reviewed hash matches the applicable versioned
  binding, worker paths within the approved contracts, no active unexplained lease,
  Sol-initiated final verification). Missing facts are NOT_RUN (a required
  NOT_RUN never PASSes), a pending/stale review BLOCKs B6, and model prose
  can never satisfy B6.1-B6.8.

### Legacy read-only compatibility and rollback

The v1 `manifest.json`/ledger/review readers remain historical read-only
compatibility. New public delegations never write v1: they write only the v2
transaction, immutable generation, and v2 review paths above. Public reads,
status, gates, review, and `repair_of` resolve strict v2 authority first; only
a strict v2 `not_found` result may use the applicable finished v1 fallback.
Corrupt, pending, unsupported, storage-failed, or otherwise invalid v2 never
falls back. Rollback may stop using v2 but must not delete or rewrite v2
authority, and an unknown higher schema version always fails closed.

This document specifies the current runtime contract; it is not a progress
mirror and records no run ids or verification status. Current committed
transaction/run records and current test output determine observed state. A
worker report remains bounded presentation, never acceptance authority.

Operational diagnosis, explicit project-authority reconciliation, v1-only
rollback blocking, and stop conditions are documented in
[governance-recovery.md](governance-recovery.md). The rollback inventory is a
read-only pre-deploy check, not a required step in ordinary development.

## Bounded worker handoff (P7)

The delegation tool result is a STRICTLY BOUNDED structured summary, never a
transcript. The complete final worker report lives in the delegation
directory as a durable bounded artifact.

| Bound | Value |
| --- | --- |
| Parent toolResult content | ≤ 120 lines / 12288 UTF-8 bytes after rendering (target 4-8 KiB for a normal report) |
| `worker-report.md` | ≤ 512 KiB UTF-8 bytes, redacted FIRST then capped, mode 0600, atomic temp+rename, explicit truncation marker only when the REDACTED report exceeds the bound |
| Parsed section items | ≤ 8 items per section, ≤ 500 characters per item |
| Structured details | tightly bounded delegation id / report path / bounded changed paths / summary / verification observations / risks / turns / usage / cache ratio / budget / status / identity only — never `allowed_paths`, `output`, `full_report`, `transcript`, `patch`, or log content |

UTF-8 BYTES govern every byte cap (never JS characters); truncation is
code-point safe (never a lone surrogate, never a replacement character).
Configured secret values are redacted BEFORE any truncation: the runner
retains the COMPLETE final assistant text in process memory (bounded only
by the 2 MiB JSON-event input — never pre-truncated to the report bound),
and the v2 generation writes the ≤ 512 KiB `worker-report.md` with the explicit
marker only when the REDACTED report still exceeds the bound — post-secret
tail content survives when redaction makes the report fit.

Every fully evidenced terminal delegation — success **or** complete failure —
publishes the bounded handoff records inside the same immutable v2 generation.
They form part of the exact eight-record inventory described above, rather
than a second permissive v1 ledger writer:

- `worker-report.md` — the redacted complete final worker text (the runner
  retains the COMPLETE final assistant text in process memory, bounded by
  the 2 MiB JSON-event input; generation construction redacts FIRST, then caps to the
  512 KiB bound with the marker only when the redacted report still
  exceeds it); persisted only, never included in any parent tool result or
  details;
- `worker-summary.json` — bounded parsed section items (Completed /
  Verification commands and observations / Remaining Risks), the ACTUAL
  changed paths (`changed_since_before`, digest-based — never worker
  prose), report path, turns, context-budget facts, usage, cache hit ratio,
  the parse-reliability and item-truncation facts, a parse warning when
  the report sections are missing/unreliable or the Files Changed claims
  diverge from the actual diff, and (Phase 3) the canonical cumulative
  `spend` object; this record is the SINGLE summary derivation the parent
  handoff renders (the runtime never re-parses the report text for the
  parent);
- `usage.json` — bounded structured usage/cache/budget/turn facts with the
  nested worker usage shape preserved for cost accounting, plus (Phase 3)
  the SAME canonical cumulative `spend` object.

The canonical cumulative spend object (Phase 3 of the worker token-budget
repair) is `{ profile, turns, totalTokens, outputTokens, band,
softReached: {turns, totalTokens, outputTokens}, hardExceeded: {turns,
totalTokens, outputTokens}, reasons }` — `reasons` entries are exactly
`"turns" | "total_tokens" | "output_tokens"` in the fixed order. It is
persisted on the v2 generation's `schema_version: 2` `usage.json` and
`worker-summary.json` records. Historical v1 records without it — and
without the before contract's `budget_profile` — remain read-only and parse
unchanged, with no migration or rewrite. The object is deliberately NOT
duplicated into `after.json`, and the parent handoff renders the deterministic
spend summary line and nested spend details from the SAME persisted
worker-summary spend object.

The report parser scans the whole bounded report text for exactly the four
required final headings (`## Completed`, `## Files Changed`,
`## Verification`, `## Remaining Risks`). Missing required sections (or an
empty report) make parsing UNRELIABLE and safely degrade: the report is
still saved, and the parent output contains only the parse warning, the
report path, the actual changed paths, the usage/budget/identity/status
facts, and the review warning — NO partial parsed section items and never
a raw-text fallback. Item-cap hits alone (all sections present, overflow
items dropped) stay RELIABLE: the parent renders the bounded items plus an
explicit truncation fact. The distinction (missing → suppress all items;
caps → bounded items + fact) is persisted as `parse_reliable` /
`truncated_items` in worker-summary.json and rendered by the parent from
the same facts.

The parent toolResult content may show the delegation id, provider/model,
status, bounded ACTUAL changed paths (with an explicit omission count when
paths are not shown), up to 8 Completed items, up to 8 verification
observations, up to 8 remaining risks, the usage/cache/budget summary,
the deterministic spend summary line (`spend budget : turns N/M | total
X/Y | output A/B | profile P`, Phase 3 — hard limits as denominators), the
durable report path, the parse warning, and the explicit instruction that
Sol must inspect the actual diff. Rendering reserves every required fact
line (identity/status/turns, changed paths, usage/cache/budget/spend, the
report/summary/usage artifact paths, parse/review/failure facts) and drops
optional summary items only as WHOLE sanitized lines until both global
caps hold — a rendered line is never cut mid-item or mid-code-point. It
never contains the full report, patch, or test logs; `details` never carry
`allowed_paths`/`output`/`full_report`/`transcript`/`patch` fields and
never duplicate the report (the nested `spend` details are the exact
persisted canonical spend object — numbers and fixed literals only).
Top-level nested worker usage is preserved unchanged.

Progress callbacks (Phase 4 of the worker token-budget repair) expose
numeric-only cumulative spend counters — `turns`, `totalTokens`,
`outputTokens` and the fixed `spendBand` (`ok | soft | hard`), evaluated
after each processed assistant message — plus the pinned provider/model
identity. Progress never carries `lastText`, worker text, reasons, tool
arguments, patches, logs, or error prose, and the counters are always
finite normalized numbers (malformed usage contributes zero, never NaN).
The compact progress text keeps the exact
`Pinned worker: N turn(s), model provider/model` prefix and appends the
deterministic spend segment `| spend total X | output Y | band B`
(starting state included with zero counters and band `ok`); every progress
tuple matches the final ledger spend facts at the last event (soft and
hard outcomes included).

### Context-risk diagnostics (P7)

`worker/context-diagnostics.ts` provides pure defensive diagnostics that
inspect bounded session-entry-like facts and detect the problematic
latest delegation tool-result turn — the pre-fix shape where the handoff
was embedded in ONE toolResult that Pi cannot split and that could have no
compactable prefix when it was the only post-compaction turn:

- `estimateLatestTurnTokens` — Pi-compatible char/4 text estimate plus
  provider usage tokens over the latest turn;
- `compactablePrefixAvailable` — whether a Pi-style cut point exists before
  the latest turn inside the ACTIVE compaction boundary (the latest
  compaction's `firstKeptEntryId` on original entry indices, falling back
  to the entry after the compaction; historical entries before the
  boundary never count) — the single-huge-recent-turn shape has none;
- `detectSingleHugeRecentTurn` — true exactly when the latest turn carries
  a `workbench_delegate_worker` toolResult whose EMBEDDED TEXT is huge
  (defaults are defined relative to the centralized 12 KiB parent cap: ≥
  2× the cap = 24576 UTF-8 bytes or 6144 char/4 tokens — strictly above a
  valid new handoff, below the pre-fix ~50 KiB runner-bounded handoff) and
  no compactable prefix exists.

`/q-status` and `/q-delegation-status` visibly include exactly
`CONTEXT RISK: latest delegation handoff too large` when detected; the new
bounded handoff (≤ 12 KiB embedded text) never triggers it. Malformed input
fails safe (0/false), and the workbench never reimplements Pi compaction.

## Worker context-budget protection

The P0–P2 cache/history refinements in this section are Unreleased source
behavior. No deployment, tag, package publication, `/reload`, or live
qualification is claimed.

Before each worker provider request, the v0.10.0 output control plane also
validates assistant/tool-result pairing and projects complete historical
bundles to the 128 KiB worker active-history budget. A single worker tool batch
is reserved against a separate 48 KiB result budget before execution. The
numeric-only progress/status facts report shown/omitted bytes, truncations,
blocked calls and history collapse; raw worker/tool text is never telemetry.
These controls are independent of the per-message context and cumulative
spend limits below.

History projection is segmented and epoch-based. A worker stays raw until it
crosses the 131,072-byte or 128-bundle hard limit. Projection-state v3
reserves its full 49,152-byte raw turn plus sixteen 384-byte/one-bundle segment
slots, leaving a fixed anchor cap of
`max(0, 131,072 - 49,152 - 16 * 384) = 75,776` bytes (74 KiB) and 96
bundles. The active suffix target is 16 bundles when a hard-limit projection
is actually required.

At the initial checkpoint the worker keeps the largest latest raw suffix that
fits those turn limits and projects only the older prefix into the anchor.
Normal requests replay the exact anchor, immutable ordered segments, and raw
active suffix. Crossing the 49,152-byte or 16-bundle reserve alone does not
seal: while the complete reconstruction remains at or below 131,072 bytes and
128 bundles, the worker request stays byte-identical and emits no projection
event. Only a true hard crossing selects the protected suffix and lets seals
1–16 project aged material into one new segment (at most 384 tool-text bytes
and one complete bundle) while keeping the epoch, anchor, every older segment,
and their safe boundary markers byte-identical. This is an expected tail
rewrite, not an epoch invalidation. A later true hard crossing at the
16-segment ceiling performs the deterministic model-free checkpoint: rebuild
the anchor, clear the chain, and increment the epoch. Branching or completed
compaction resets the boundary.

Reload restores only an exact strict v3 numeric/hash state (at most 32 KiB),
reconstructing every contiguous slice from raw JSONL. Strict v1/v2 entries are
migration-only and carry monotonic epoch and pressure, never topology or old
hashes. An under-cap migration leaves raw worker history unchanged, emits one
`legacy_migration` boundary, and persists inactive v3 so reload cannot repeat
it. A fixed non-secret failure sentinel also survives JSONL restore: repeated
failure is de-duplicated and the first healthy request emits one recovery
boundary.

The cap change does not bump v3 or telemetry schema 1.3. A valid restored
worker v3 state created under the former 65,536-byte policy is accepted and
produces one deterministic `policy_changed` transition; subsequent replay uses
the 131,072-byte policy without repeating the transition. A raw history that
fits the expanded cap becomes inactive/raw, while a still-oversized history
uses the existing deterministic checkpoint path.

The 128 KiB cap is qualified against the pinned worker's Pi-advertised
272,000-token window, not arbitrary 64k/128k models. It is Unreleased source behavior until
the Pi 0.84.2 dependency tree is verified (the current tree resolves it), the
declared gates pass, and `/reload` activates it. Only a fresh exact-correlated
live worker cohort can establish a cache-read change.

The newest recognized malformed or structurally unsafe entry is authoritative;
a Proxy/revoked Proxy or `customType`/`data` accessor fails closed without
executing traps rather than falling back to older valid state. Worker history
identity hashes exact UTF-16 code units in JSON property enumeration order,
omits object `undefined`, and maps array holes/`undefined` to `null`. Bounded
array/depth/property/work budgets reject hostile, accessor, non-plain, cyclic,
or over-budget values. The hidden marker after the anchor and each segment
contains a safe ID derived only from projected/provider-visible structure,
never raw worker text.

The shared runtime writes a `workbench-context-pressure-v1` custom entry with
exactly nine numeric/fixed fields (`schema`, `role`, `epoch`, raw/projected
tool-text bytes, raw bundle count, both hard limits, and `timestampMs`). The
separate Commander auto-compaction companion accepts only strict Commander
entries as epoch/churn and raw-versus-projected diagnostics. Its automatic
trigger percentage comes solely from Pi 0.84.2 `getContextUsage()`, which already
measures raw session messages; it never adds a raw-minus-projected token delta.
Worker-role entries are deliberately ignored and never alter the worker's
independent 80% soft / 90% hard policy. This repository publishes the contract
but does not install or deploy the companion extension. Projection-state v3
does not change the nine-field pressure wire contract and requires no companion
code change.

The `openai-codex` Luna worker receives no explicit breakpoint fields because
Codex experimental breakpoint injection remains disabled. The
immutable segmented shape can still increase the exact reusable prefix, but
that is an architectural benefit rather than a measured cache-hit claim. Only
verified provider `cacheRead` usage can establish reuse; offline fake-provider
usage is zero by design.

Schema-1.3 telemetry attributes a row to the worker cohort only when one
worker `context` projection, one local `before_provider_request` observation,
and one assistant `message_end` correlate exactly. The local observation has
`finalityCode=0` and is not the final provider wire. Unwired,
multiple/stale/invalid, or missing correlation forces unknown actor and no
projection facts. Reports therefore keep Commander and worker read/write
shares in separate cohorts; they never pool an ambiguous row into the worker
numbers. Responses write status `2` means normalized absence-or-zero, not
presence-verified provider evidence. Event/cause/overflow/segment facts must
match the strict schema-1.3 semantic matrix, and aggregate status `7` forces
both shares to `null` when an exact sum exceeds the safe numeric publication
surface.

The same researched design rule applies to Commander and worker: immutable
fixed anchor, modular immutable segments, and rare checkpoints. Public OpenAI
GPT-5.6 Responses traffic is independently gated and requires an existing,
consistent `prompt_cache_key`; Codex remains disabled. OpenAI documents exact
static-first/variable-last prefixes, no more than four new writes per request,
the latest 50 breakpoint candidates for reads, and approximately 15
requests/minute per key, measured through `cached_tokens` and
`cache_write_tokens`. Thus 17 logical anchor/segment markers do not mean 17 new
writes. DeepSeek stays automatic/no-op at the field layer.

The [DeepSeek Harness audit at pinned commit
`47f943859bef60e4160492346772ded9b24f765a`](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a)
contributes append-only-prefix, stable-before-dynamic, and bounded-model-surface
principles only. Its MLA serving, scheduler, disk-KV ownership, and benchmark
numbers do not transfer to this Pi worker.

Warm-prefix auxiliary compaction is
`BLOCKED_BY_PI_0_84_2_PUBLIC_API`: the official
[Pi v0.84.2](https://github.com/earendil-works/pi/releases/tag/v0.84.2)
surface at [commit `914cf1472e715297caa30db4b9535d534a9eb718`](https://github.com/earendil-works/pi/commit/914cf1472e715297caa30db4b9535d534a9eb718)
still exposes no public post-summary payload transform or same-cache-domain
guarantee. The worker runtime does not duplicate private
auth/header/stream/retry behavior. Worker compaction cancellation remains
unchanged; Commander now preflights native summary capacity and otherwise
keeps Pi's native summarizer.

Pi advertises a 272,000-token context window for the pinned worker. The workbench
protects that budget with two thresholds that are model-specific and
independent of the Commander/project compaction reserve:

| Threshold | Tokens | Behavior |
| --- | --- | --- |
| Soft handoff | 217,600 (80%) | The worker role sends one hidden active-loop steer (`display: false`, `deliverAs: "steer"`): stop new implementation, finish a concise handoff, list the remaining work. |
| Hard stop | 244,800 (90%) | The runner terminates the child and the invocation fails closed. |

Context tokens use Pi's normalized usage semantics: a positive
`totalTokens` is authoritative; otherwise the sum of the non-negative
`input + output + cacheRead + cacheWrite`. Malformed, non-finite or
negative values contribute zero — never NaN.

Inside the worker process the extension also cancels
`session_before_compact` (`{ cancel: true }`) so a worker never silently
continues through lossy compaction. This return occurs before the handler reads
Pi's compaction preparation. Commander manual/threshold/overflow events instead
use the content-free allow/warn/block summary-capacity preflight: a conservative
envelope estimate at or above model capacity is cancelled before provider
invocation and directs `/q-milestone-handoff <next step>`, with no compaction
telemetry or supplement. The estimate is not a formal tokenizer-fit proof;
allow/warn/unknown keep Pi's native summary and existing supplement behavior.
Defense in depth: the runner independently parses
`compaction_start` events from the child JSON stream (count + distinct
reasons) and any compaction attempt fails the invocation closed — even if
the child would otherwise exit 0.

The final report exposes the facts: the text appends
`worker budget : max context N / 272000 (P%) | soft 217600 | hard 244800`
and the structured `details` carry `max_context_tokens`,
`max_context_ratio`, `soft_budget_reached`, `hard_budget_exceeded`,
`compaction_count`, and `compaction_reasons`.

## Worker cumulative spend-budget protection

Independent of the per-message context budget above, the approved worker
token-budget repair (`docs/plans/worker-token-budget-repair.md`) adds a
**cumulative delegation-spend policy** in
`extensions/workbench-runtime/core/worker-spend.ts` — pure logic, no Pi
imports, reusing `workerContextTokens` from `core/worker-budget.ts` for the
per-message total semantics. **Phases 2–4 status: runtime wiring, public profile selection,
v2 generation persistence, handoff rendering and numeric-only progress
landed; Phase 5 (task-contract profile wording and delegation-granularity
guidance) landed.** The runner accumulates the cumulative
spend state after every assistant message (same pure policy), records the
final profile/state/band/reasons facts on every run result, and terminates
the child fail-closed whenever cumulative total/output reaches a hard limit
(`>=`, deterministic hard-stop message). Turn thresholds remain persisted
steering/diagnostic markers and never terminate a healthy worker by themselves.
The worker-role lifecycle reads the
spend profile from the fixed child env contract
(`WORKBENCH_WORKER_SPEND_PROFILE` — the runner writes `standard` or
`extended`; retired `low` and malformed/missing child env fall back to
`extended` defensively), accumulates its own independent spend state
on assistant `message_end` events, and sends exactly one hidden cumulative
soft steer when the band first becomes soft or hard. **Phase 3 status:
public selection, contract validation, v2 generation persistence and handoff
rendering landed.** The optional `budget_profile` tool parameter (closed
literal union `standard | extended`, default `extended`; `standard` is
explicit for clearly small bounded slices) is resolved by the strict contract validation in
`core/worker-policy.ts` BEFORE any v2 transaction preparation or child launch, the
resolved profile is recorded in the before contract
(`before.json` → `contract.budget_profile`) and passed to the runner (the
same profile reaches the child env and every outcome's spend facts —
exception fallbacks included), and the canonical cumulative `spend` object
is persisted additively in `usage.json` / `worker-summary.json` on every
finished success and failure and rendered into the bounded parent handoff.
Per-message context safety (above) is unchanged.

| Profile | Soft turns | Soft total | Soft output | Turn marker | Hard total | Hard output |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `standard` (explicit small slice) | 32 | 5,440,000 | 160,000 | 64 | 10,880,000 | 320,000 |
| `extended` (safe default) | 64 | 10,880,000 | 320,000 | 96 | 17,408,000 | 512,000 |

These are the current `gpt-5.6-luna-xhigh-continuation-v1` limits. Total-token
thresholds are fixed multiples of Luna's Pi-advertised 272,000-token context
window: standard 20×/40×, extended 40×/64× (soft/hard).
The interval between soft and hard is an intentional continuation reserve:
soft does not terminate the worker and must not direct the user to open a new
Sol session. It asks the worker to finish the coherent change and hand back
remaining work for a bounded follow-up delegation in the current Sol session.
Hard total/output consumption remains a fail-closed runaway ceiling. The turn
marker is advisory because tool-heavy development can use many low-cost turns;
the independent timeout still bounds wall-clock execution.

- **Per-message totals** reuse the context-budget semantics: a positive
  `totalTokens` is authoritative; otherwise the non-negative
  `input + output + cacheRead + cacheWrite` sum; `cacheRead` counts
  (cache-hit input is billed, so it is real spend); malformed, non-finite
  or negative values contribute zero — never NaN, never a crash.
- **Output dimension** reads the per-message `output` component directly
  (non-negative finite; malformed → 0), independent of which path the
  per-message total took; a provider that omits `output` undercounts this
  dimension (accepted heuristic guard). `total_tokens` is the primary
  spend dimension.
- **Cumulative dimensions** per delegation run: `turns` (processed
  assistant messages), `total_tokens` (Σ per-message normalized total),
  `output_tokens` (Σ per-message output). Updates are immutable and
  deterministic.
- **Band evaluation** on every processed message: any hard dimension
  reached (`>=`) → `hard` (hard wins over soft, always); else any soft
  dimension reached → `soft`; else `ok`. Triggered reasons are listed in
  the fixed order `turns`, `total_tokens`, `output_tokens`. This persisted
  telemetry classification does not make the turn marker an enforcement path.
- **Soft steer (wired):** at most one hidden cumulative soft steer per
  delegation (`WORKER_SPEND_SOFT_STEER_MESSAGE_TYPE =
  "workbench-worker-spend-soft-steer"`, `display: false`,
  `deliverAs: "steer"`), sent by the worker-role lifecycle only — the
  commander session never receives it — with its OWN one-shot flag,
  independent of the context steer, naming the profile, the triggered
  dimension(s) in the fixed reason order, and current vs. limit values; a
  send failure is swallowed and never breaks a model request. The steer is
  a request, not an enforcement.
- **Hard stop (wired):** when cumulative total or output reaches a hard limit
  the runner terminates the child and the invocation fails closed
  (`assertWorkerSucceeded`), naming the winning dimension(s) and
  current/limit values via the deterministic hard-stop formatter; the
  outcome is committed as `FAILED` when its terminal facts and immutable
  generation are complete; incomplete persistence requires
  `RECOVERY_REQUIRED`. Crossing only the persisted turn marker does not
  terminate or fail an otherwise healthy worker. The 60-minute timeout remains
  an independent failure path.
- **Profiles:** `extended` is the deterministic safe default for every
  delegation without an explicit request; `standard` is selected explicitly
  only for a clearly small bounded slice. The public
  `budget_profile` tool parameter (optional, closed literal union
  `standard | extended`, default
  `extended`) is validated by the pure contract check in
  `core/worker-policy.ts` — omitted resolves to `extended`; unknown,
  empty, wrong-type and case-variant values fail closed with a bounded
  error before the v2 transaction is prepared or the child starts. The pure
  resolver defaults to `extended` only where a default is explicitly
  requested, while strict validation rejects unknown values.
- **Historical compatibility:** committed v1/v2 records carrying `low`
  remain strictly readable and hash-verifiable, but `low` is rejected for
  every new public contract and committed artifact. Direct/internal runner
  input and child env `low` resolve defensively to `extended`.
- **Child env contract (wired):** the runner passes the resolved profile to
  the worker child through the fixed `WORKBENCH_WORKER_SPEND_PROFILE` env
  variable; the worker-role lifecycle strictly validates it and falls back
  to `extended` on malformed/missing values (defensive — the runner always
  writes a valid value).
- **Deterministic summary** (rendered into the parent handoff and immutable generation):
  `spend budget : turns N/M | total X/Y | output A/B | profile P` with the
  profile's hard limits as denominators; the handoff derives the line and
  the nested `spend` details from the SAME canonical spend object the
  v2 generation persisted in worker-summary.json (never recomputed from runner
  internals or worker prose).

## Review patch bounds (P7)

`workbench_review_worker_diff` renders a redacted patch bounded by default
at 400 lines / 32 KiB, enforced GLOBALLY over the rendered patch content
(never independently per path). ANY per-path truncated entry also sets
`patch_truncated` — even when the (redaction-shrunk) entry fits the global
envelope — so the segmented-review instruction always renders when any
content was cut. Scope checks always use the COMPLETE attributed worker
delta. The bound hash uses W/D/S relevance for new tagged v2 and the complete
full diff for historical untagged v2/v1; truncation affects only the displayed
patch. Every patch path carries bounded path/stat information (source,
bytes, truncated/omitted), and when patch content is truncated or omitted
the review returns an explicit segmented-review instruction: drive
path-by-path `include_paths` re-reviews (max 50 paths per call).

## Task contract

```json
{
  "task_kind": "implementation",
  "task": "Implement the already-approved parser change",
  "allowed_paths": ["src/parser/**", "tests/parser.test.ts"],
  "acceptance_criteria": [
    "Invalid input returns a structured error",
    "Existing valid input remains compatible"
  ],
  "verification": ["Run the unit-test recipe"],
  "budget_profile": "extended",
  "repair_of": "20260101-120000-abcd",
  "timeout_seconds": 1800
}
```

`task_kind` is optional only for public compatibility: omission resolves to
`implementation`. Stage 1 accepts exactly `implementation | diagnosis`;
`mechanical`, case variants, unknown strings, and wrong types fail closed.

`budget_profile` is optional and selects the cumulative delegation-spend
profile (`standard | extended`; omitted resolves to `extended`). The profile
bounds cumulative spend only — it never expands the approved paths or scope.
`extended` is the deterministic safe default; `standard` is explicit only
for a clearly small bounded slice. The worker task text carries the resolved profile as one
informational line; enforcement is the runner's fixed child-env contract,
never task prose.

`repair_of` is optional and is the strict prior delegation-id provenance
pointer for a known-root-cause repair (see Repair provenance pointer
above): exactly the 20-character `^\d{8}-\d{6}-[A-Za-z0-9]{4}$` delegation
id shape, used only after Sol has fixed the known root cause and decided
the scope, with the bounded failure evidence carried in the task itself;
the runtime strict-reads v2 first and accepts only a referenced terminal
`FAILED`, `FINISHED`, or `REVIEWED` v2 authority. Only v2 `not_found` permits
the finished-v1 read-only fallback; corrupt, pending, or unknown v2 authority
never falls back. This check precedes any new v2 transaction or child launch,
and the fresh worker inherits no prior report/session/scope/contract — the
pointer adds no path/scope/authority. Ordinary delegations omit it entirely;
unknown root causes still use bounded diagnosis, then a Sol decision.

Path rules are deliberately simple:

- `README.md` permits exactly one path;
- `src/parser/` permits that subtree;
- `src/parser/**` permits that subtree;
- absolute paths and `..` escapes are refused;
- realpath checks reject symlink escapes and symlink hops outside the approved subtree;
- an empty or malformed path contract fails closed.

The worker can read project files, use structured `edit`/`write` inside the
approved paths, and invoke declared workbench recipes only when their
`writes` list is empty. Free-form `bash` is blocked for workers so source
modifications cannot bypass the structured path check. Recipe declarations
remain trusted-project discipline mechanisms, not a sandbox; a malicious
command can still write despite an empty declaration.

## Enforcement layers

1. **Mode policy:** delegation is advertised only in DEV and hard-denied in
   AUDIT/VERIFY even if another extension re-enables the tool.
2. **Commander identity:** the parent must report model id `gpt-5.6-sol` on
   provider `openai-codex` or `openai`.
3. **Pinned worker identity:** child CLI selection is fixed; provider/model
   drift in assistant events fails the invocation.
4. **Worker role matrix and guard:** `WORKBENCH_AGENT_ROLE=worker` removes
   recursive delegation, free bash, and `workbench_run_gate` from the active
   tool set; the hard guard still blocks them if another extension re-enables
   a denied tool.
5. **Write scope:** child `edit`/`write` calls are checked against the
   parent-approved path contract.
6. **Sequential execution:** the delegation tool uses Pi's sequential tool
   execution mode; parallel writes to one worktree are not supported.
7. **Existing command/path guards:** the normal workbench P5 protections
   still apply inside the child.
8. **Fixed Sol/Luna write authority:** approved Sol in DEV receives the
   locked read/control/delegation surface. The second-layer `tool_call` guard
   blocks bash and foreign tools; any direct edit/write requires an active
   human-issued lease within its exact scope.
9. **Review gating:** a pending or stale delegation review blocks VERIFY and
   normally blocks the next delegation. Exact latest `STALE` backed by strict
   committed v2 FINAL/PASS authority may start only a fresh successor after
   live revalidation; the old review stays immutable and all other authority
   remains blocked. New tagged v2 binds W/D/S relevance, so baseline
   unrelated dirty paths and recognized workbench artifacts do not stale it;
   Git HEAD, W/D/S, or new unknown-origin drift fails closed. Historical
   untagged v2/v1 binds the complete full diff, where any later diff change
   turns the delegation STALE.

These are guardrails, not an OS security boundary. Use a container or VM for
untrusted repositories or unattended automation.

## Recommended development workflow

1. Orient only enough to define the current task, its acceptance criteria,
   affected files, and concrete risk.
2. Give Luna one bounded contract for the coherent source, test, and
   documentation slice. Use focused recipes while the candidate is changing.
3. A normal successful implementation auto-reviews and closes; call explicit
   review/status only when the result says recovery is required.
4. Use the temporary Sol lease only for an explicit user-authorized exception;
   never turn it into the routine implementation path.
5. Once the candidate is stable, switch to VERIFY and run one final recipe or
   gate set proportionate to task or release risk. Base the verdict on current
   records and code, never worker prose or a historical handoff document.

## Stable-prefix and cache behavior

The tool name, description, schema, prompt snippet, and guidelines are static
and registered in `WORKBENCH_TOOL_NAMES` order. Dynamic task facts are sent
in the child user message, not injected into the parent system prompt.
Adding this tool intentionally changes the DEV tool-schema fingerprint once;
after reload, same-mode fingerprints remain stable. The Phase 3 additive
`budget_profile` parameter caused the second intentional one-time
fingerprint transition and the Phase 4A optional `repair_of` pointer the
third (and final, for this repair) — the cache telemetry records each as
`UNEXPECTED_DRIFT` (expected, not a defect); see
[docs/compatibility.md](compatibility.md). DeepSeek usage is
returned as nested tool usage and the child workbench can continue using the
existing content-free hash-and-numeric cache telemetry.

The later current-only safe-default and segmented-delivery update changes
the current static delegate schema/metadata fingerprint once more. Frozen v1
catalog/hash evidence remains unchanged; after reload, the new current-mode
fingerprint is deterministic and cache telemetry semantics are unchanged.

NRO N1/N2 (Commander Native Tool Optimization,
`docs/plans/commander-native-tool-optimization.md`) adds the three fixed
same-name `read`/`grep`/`find` overrides, registered statically BEFORE the
unchanged 11-tool catalog; names, order and every mode/write inventory are
unchanged, and the override metadata/schemas shift the tool-schema
fingerprint exactly once (the single combined N1/N2 transition), after
which same-mode fingerprints stay stable. In the worker child, a `read`
without `offset`/`limit` returns the complete content byte-for-byte plus
the deterministic `nro-read-facts:` trailer, or the deterministic preview
with facts on oversized text — the worker therefore has a **complete-read
continuation obligation**: when a read reports `complete=false` (or
`line_truncated=true`), the worker must continue via `offset`/`limit`
(following `next_offset`) until `complete=true` for every file whose
complete content is required (SKILL.md, AGENTS.md, Pi docs, plans,
baselines, run logs). `grep` adds the optional `output="count"` /
`count_kind` selectors (one exact uncapped count line; every other call —
omitted `output`, `output="matches"`, or `count_kind` without `output` —
stays byte-identical to the equivalent Pi 0.83.0 legacy call), and `find`
remains an exact legacy pass-through (find count/`max_depth` — staged N3 —
and grep `output=files` — staged N2b — are NOT exposed); NRO token
savings/adoption remain **NOT_MEASURED** (N4 is Commander-owned).

The tool result is a strictly bounded structured summary (see Bounded
worker handoff): the final text shows the delegation id, provider/model,
status, ACTUAL changed paths, up to 8 bounded items per parsed section,
the deterministic cache summary line
(`worker cache : uncached input 10 | cache read 20 | hit ratio 67%`), the
budget summary line, the durable report path, parse/review warnings, and
the commander action instruction; the structured `details` include the
aggregated `usage` and a nullable `cache_hit_ratio`
(`cacheRead / (input + cacheRead)` over the whole run); the top-level tool
`usage` is preserved unchanged; a worker that reports no input at all (zero
denominator) renders `hit ratio N/A` and `cache_hit_ratio: null` — never
NaN or a fabricated number. The complete final worker report is NEVER
embedded: it is the durable `worker-report.md` artifact.

That durable report is one of exactly six trusted recoverable-ingress sources,
alongside finalized recipe summaries, executed gate records, immutable
comparisons, finalized run pages, and run-id gate pages. The execution layer
opens an in-project regular source no larger than 4 MiB without following
symlinks and binds its content plus size/device/inode/`mtimeNs`/`ctimeNs`
snapshot. Text no larger than 4,096 UTF-8 bytes remains byte-exact with bounded
metadata; only larger text receives the deterministic recovery wrapper. If a
low turn allocation cannot preserve that wrapper, the ordinary envelope is
rebuilt from the original result and no stale wrapper metadata survives.
Later history collapse prefers the validated durable source path over a
receipt-summary pointer.

This ingress implementation has no worker-specific branch: Commander, worker,
and other use the same authority, byte threshold, content binding, receipt
ordering, and history-pointer validation. Role selection changes only the
outer turn/history caps. Gate-page cursors are also allocation-aware, so the
worker never loses an undisplayed semantic row when following a run-id gate
page.

On the commander side, GPT-5.6 Sol's own usage (`apiKind`
`openai-codex-responses`) is a verified Responses-style semantic in the
cache telemetry, so the Sol session footer shows a numeric `CACHE` segment
(ratio, read, miss) instead of `CACHE N/A` whenever Codex reports cache
reads.

## Split session-cost observability

The worker's nested usage is returned as `toolResult` usage on the
`workbench_delegate_worker` call, and the workbench cost observability
classifies exactly that tool name into a dedicated worker bucket, so the
commander can see the worker's cost separately from its own:

- `S` (commander): assistant-message usage, grouped per
  `provider/responseModel ?? model`;
- `W` (worker): `toolResult` usage whose `toolName` is
  `workbench_delegate_worker`;
- `O` (other): every other `toolResult` usage plus `branch_summary` and
  `compaction` usage.

The status line shows `COST S:$… W:$… O:$…` (O omitted when zero, S and W
always shown) and `/q-cost-status` prints the exact amounts and the
per-model commander breakdown — both are session-entry facts only. The
buckets reconcile exactly with Pi's own footer aggregation (malformed or
non-finite usage contributes zero, never NaN).

## Failure behavior

The tool fails rather than silently falling back when:

- the commander is not GPT-5.6 Sol;
- the child cannot start;
- the pinned model is unavailable;
- an assistant event reports another provider/model;
- an assistant event reaches the 244,800-token (90%) hard context budget;
- any cumulative spend dimension reaches its hard limit (turns / total
  tokens / output tokens per the active profile — `extended` by default,
  `standard` as the explicit small-slice selection via the optional `budget_profile`
  parameter);
- the child emits any `compaction_start` event (a compaction attempt);
- the child exits non-zero, times out, or is aborted;
- the child reports an error/aborted stop reason;
- no verified final text response is produced.

Stderr and model-visible output are bounded with Pi's standard limits. Full
child transcripts are never copied into workbench run records or parent
results; the durable source-change and validation evidence remains the
project diff plus the bounded delegation artifacts (`worker-report.md`,
`worker-summary.json`, `usage.json`) and existing recipe/gate run records.
