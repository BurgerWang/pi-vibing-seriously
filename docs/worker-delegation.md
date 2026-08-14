# Controlled Worker Delegation

pi-dev-workbench can delegate one bounded implementation task from a
GPT-5.6 Sol commander to a pinned DeepSeek worker without introducing a
standalone agent framework, daemon, queue, or background service.

## Roles

| Role | Model | Authority |
| --- | --- | --- |
| Commander | `openai-codex/gpt-5.6-sol` or `openai/gpt-5.6-sol` | Requirements, cross-cutting architecture, scope, plan, delegate, review the real diff, run gates, make the final judgment |
| Worker | `deepseek/deepseek-v4-flash:max` | Routine local implementation decisions inside the approved contract: concrete design, naming, file structure within scope, production source changes, tests, docs, write-free recipe checks, in-scope repair |

The worker report is never acceptance evidence. Its Verification section
records only commands and observed results; it must not label an acceptance
criterion satisfied, met, passed, accepted, or complete. Only the commander
maps evidence to criteria, runs final gates, and reports the final
PASS/FAIL/BLOCKED/NOT_RUN verdict.

### Responsibility split

| Owned by Sol (never delegated) | Owned by the Worker (inside the approved contract) |
| --- | --- |
| Requirements and acceptance criteria | Concrete design and naming choices |
| Cross-cutting architecture and scope | File structure within the approved paths |
| Plan, delegation, and the actual-diff review | Production source changes, tests, and docs |
| Final verification, recipes/gates, and the verdict | Investigation, write-free recipe checks, in-scope repair |

The worker is expected to implement the complete delegated slice — relevant
investigation, production source changes, tests, docs, requested write-free
recipe checks when available, and repair of in-scope defects it finds —
rather than stopping after a narrow code edit. Everything outside the
approved contract, and every final judgment, belongs to Sol.

## Risk rubric

| Risk | Shape | Delegation |
| --- | --- | --- |
| Low | One contained change with a clear contract (for example a pure helper plus its unit test and a doc line) | Default: delegate as a coherent source+tests+docs vertical slice after minimum repository orientation |
| Medium | Touches several files or modules, but the contract is unambiguous and the paths can be enumerated | Delegate after Sol approves the plan and supplies explicit source/tests/docs paths and observable acceptance criteria |
| High | Requirements are ambiguous or contested, cross-cutting architecture is at stake, policy/security/budget/model/path behavior changes, or the change defines the delegation mechanism itself | Commander-led: Sol owns the decision and never delegates the decision itself; implementation/repair writes go to a fresh bounded worker, and only explicitly designed bounded support/implementation scopes are delegated after the architecture is fixed. Temporary commander direct writes require an explicit user-issued write lease |

High-risk work is Commander-led, not categorically impossible to delegate:
Sol owns requirements, cross-cutting architecture, and core safety decisions,
and never transfers the decision itself. Under worker-first write authority
Sol does **not** directly write by default — implementation and repair writes
go to a fresh bounded worker, and Sol may delegate an explicitly designed
bounded support/implementation scope of high-risk work (for example helper
code, tests, or docs whose shape Sol has already decided) after the
architecture is fixed; that is never the DEV default and never transfers the
decision. When a worker returns a partial or defective slice, Sol reviews the
actual diff and either issues another bounded delegation to a fresh worker or
— only with an explicit human-issued temporary write lease — repairs defects
directly; the verdict is always Sol's.

## Fresh-worker continuation

Every delegation is a brand-new `--no-session` worker: no worker session is
ever resumed and no worker has memory of any earlier worker's turns. A
worker cannot delegate, so continuation is always a Sol decision. To
continue work after a handoff or a partial slice, Sol:

1. inspects the actual diff and the worker report;
2. writes a new bounded contract whose task text states the current state of
   the worktree and the remaining work;
3. supplies fresh allowed paths, acceptance criteria, and requested
   verification;
4. delegates the next slice to a fresh worker (worker-first: Sol does not
   directly write by default; a temporary commander direct repair requires an
   explicit human-issued write lease — see Worker-first write authority
   below).

The durable state between delegations is the project diff plus recipe/gate
run records — never worker memory and never worker prose.

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
the real-diff review (`workbench_review_worker_diff`), and final
verification never depend on the prompt's format rules. These are
worker-side format rules; the mechanical report caps (≤ 8 parsed items per
section, ≤ 500 characters per item, byte-bounded rendering) still apply on
top.

### Fresh repair semantics

A partial or defective slice is repaired by a fresh bounded delegation, not
by Sol writing directly (worker-first write authority) and not by the same
worker continuing (workers are `--no-session`, never resumed). When Sol
delegates a repair whose root cause is already known, the contract states
the known root cause and the decided fix; the fresh worker implements that
fix directly — the EARLY CHECKPOINT discipline forbids reopening broad
diagnosis. Prompt discipline improves efficiency, but mechanical scope
checks, diff review, and final gates remain authoritative either way.

### Repair provenance pointer (`repair_of`, Phase 4A)

The delegation tool exposes one optional public parameter, `repair_of`, for
repairs whose root cause is already known. It is a strict pointer —
provenance only, never a resume:

- **Public shape:** exactly 20 characters — `^\d{8}-\d{6}-[A-Za-z0-9]{4}$`
  — a prior delegation id such as `20260101-120000-abcd`. Omitted for
  ordinary delegations; any malformed value fails closed with a bounded
  error before any ledger is created or any worker is launched.
- **Use:** only after Sol has fixed the known root cause and decided the
  scope. The parent task itself must carry the bounded root-cause/failure
  evidence; the pointer adds none.
- **Finished-ledger requirement:** the runtime verifies that the referenced
  prior delegation's ledger is finished (manifest status `finished` with a
  non-null `after` record) BEFORE any new ledger is created or any worker
  is launched; only those id/status/after facts are inspected.
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
returned and its diff has been reviewed (a pending or stale review blocks the
next delegation in code as well). Parallel reads are fine; parallel writes
are not supported and must never be attempted.

## Pi-native lifecycle

`workbench_delegate_worker` is a statically registered workbench tool. It is
part of the deterministic DEV tool matrix and absent from AUDIT and VERIFY.
One invocation:

1. checks project trust and the active commander provider/model;
2. validates the structured task contract;
3. refreshes the delegation review state against the real git diff and
   refuses to start while a review is pending or stale;
4. records the bounded delegation ledger (`manifest.json`, `before.json`)
   BEFORE the worker starts;
5. starts one short-lived `pi --mode json -p --no-session` child process;
6. pins `--model deepseek/deepseek-v4-flash:max`;
7. streams bounded progress from Pi JSON events;
8. verifies every assistant event reports `deepseek/deepseek-v4-flash`;
9. tracks per-message context tokens against the pinned budget (soft
   handoff / hard stop, see below) and rejects any `compaction_start` event;
10. accumulates the cumulative delegation-spend state after every assistant
    message (pure `core/worker-spend.ts` policy — turns / total tokens /
    output tokens per the active profile) and terminates the child
    fail-closed when any hard spend dimension is reached (see below);
11. terminates the child on completion, timeout, parent abort, hard-budget
    stop (context or spend), or a compaction attempt;
12. finishes the ledger on EVERY outcome (success and failure —
    `after.json`, `worker-summary.json`, `review.json` placeholder, the
    bounded `worker-report.md` and `usage.json`, review_status
    PENDING_REVIEW);
13. returns a STRICTLY bounded structured summary to the parent session
    (delegation id, provider/model, status, actual changed paths, bounded
    parsed section items, usage/cache/budget facts, durable report path,
    parse/review warnings) — never the worker's report text, patch, or
    test logs.

There is no persistent worker process. The child inherits the user's OS
permissions and provider authentication, just like any other Pi process.

## Worker-first write authority (P7)

Approved GPT-5.6 Sol resolves to the fixed `worker-first-strict` write policy
in DEV: the active tool set is exactly the canonical 15-tool allowlist
(`read`, `grep`, `find`, `ls` plus all eleven `workbench_*` tools) — no
`bash`/`edit`/`write`, no foreign tools — and no persisted/prompt/config value
can weaken or opt out of it. Actor identity comes only from the existing
`WORKBENCH_AGENT_ROLE=worker` env contract and the provider/model pair;
project config can never self-label a controller as Sol or as a worker.
Delegated workers and other controllers are outside the policy: the existing
worker guards remain authoritative for workers, and other controllers are not
newly denied.

Consequences for the commander workflow:

- `bash` is always blocked for strict Sol — project commands run through
  declared workbench recipes only.
- `edit`/`write` are blocked by default. Implementation and repair writes go
  to a fresh bounded worker via `workbench_delegate_worker`.
- The only exception is a **temporary commander write lease**, issued by the
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
  exact canonical 15 tools. The footer shows `WF:LEASE <used>/<max>` while an
  active confirmed lease exists and `WF:LOCKED` otherwise; `WF:REVIEW` is
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

## Delegation ledger and review lifecycle (P7)

Every delegation — success **and** failure — is recorded in a bounded ledger
at `<project-root>/<CONFIG_DIR_NAME>/workbench/delegations/<id>/` before the
worker starts (`manifest.json`, `before.json`), finished when the worker
returns (`after.json`, `worker-summary.json`, a `review.json`
PENDING_REVIEW placeholder, plus the bounded handoff artifacts
`worker-report.md` and `usage.json` — see Bounded worker handoff), and
reviewed later. Records are atomic, bounded, redacted, and never contain
full worker transcripts or secrets; the ledger's own directory is excluded
from the git facts it records. The before snapshot carries the bounded
contract, git HEAD/dirty, a deterministic diff hash and per-path porcelain
status codes + bounded content digests; the after record carries the TRUE
changed paths since before (digest-based, including previously-dirty
paths), the after diff hash, pinned identity, outcome, usage/budget facts,
a bounded redacted report summary, and the safe `reported_paths` parsed
from the worker's bounded `## Files Changed` section.

Review lifecycle (single latest-delegation slot, persisted as the
`workbench-delegation-state` custom entry):

```
PENDING_REVIEW → REVIEWED → (current diff hash changes) → STALE
      ^                                            |
      +──────────────── re-review (workbench_review_worker_diff) ──┘
```

- **`workbench_review_worker_diff`** (DEV-only, Sol): reads the real git
  state and the ledger, scope-checks EVERY worker path against the
  parent-approved `allowed_paths` with a realpath/symlink-safe check
  (`include_paths` narrows only the patch output and can never hide a
  violation; unsafe or non-worker entries are refused), compares the current
  diff hash with the recorded after hash (mismatch/drift are warnings), warns
  when the worker report's `## Files Changed` section is missing or does not
  match the actual diff, and returns a globally bounded redacted patch
  (default 400 lines / 32 KiB over the whole rendered patch; per-path stats
  plus a segmented `include_paths` review instruction when truncated or
  omitted — the bound hash and scope checks always cover the complete actual
  diff). Verdict `PASS` marks the delegation REVIEWED; `FAIL` (any
  out-of-scope path) keeps it PENDING_REVIEW. The review record
  (`review.json`) binds the CURRENT diff hash.
- **`workbench_delegation_status`** (and `/q-delegation-status`): actor,
  fixed policy, lease status (bounded summary — never token parts), latest
  delegation, review status, current/reviewed diff hashes, blocked write
  attempts, latest review verdict; refreshes against the real git diff, so
  any change after REVIEWED turns the delegation STALE.
- **Blocking:** a pending or stale review blocks BOTH the next delegation
  (`workbench_delegate_worker` refuses to start) and VERIFY (`/q-mode-verify`
  refuses, and `/q-gate`/`workbench_run_gate` are refused in VERIFY) until
  the current diff is reviewed. REVIEWED binds `reviewedDiffHash ===
  currentDiffHash`; a diff that returns to exactly the reviewed hash
  re-validates (back to REVIEWED). Blocked commander write attempts are
  counted while a review is outstanding.
- **B6 Worker-First Compliance (P7):** a machine-backed universal base gate —
  the runtime injects bounded worker-first facts into every gate run
  (strict policy active, zero unauthorized commander writes, no
  pending/stale review, reviewed hash matches the current diff, worker
  paths within the approved contracts, no active unexplained lease,
  Sol-initiated final verification). Missing facts are NOT_RUN (a required
  NOT_RUN never PASSes), a pending/stale review BLOCKs B6, and model prose
  can never satisfy B6.1-B6.8.

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
and the ledger writes the ≤ 512 KiB `worker-report.md` with the explicit
marker only when the REDACTED report still exceeds the bound — post-secret
tail content survives when redaction makes the report fit.

Every finished delegation — success **and** failure — atomically writes,
alongside the existing `manifest.json` / `before.json` / `after.json` /
`review.json` records:

- `worker-report.md` — the redacted complete final worker text (the runner
  retains the COMPLETE final assistant text in process memory, bounded by
  the 2 MiB JSON-event input; the ledger redacts FIRST, then caps to the
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
persisted additively on `schema_version: 1` records (old records without
it — and without the before contract's `budget_profile` — parse
unchanged, no migration, no rewrite), deliberately NOT duplicated into
`after.json` (usage.json / worker-summary.json are its records), and the
parent handoff renders the deterministic spend summary line and nested
spend details from the SAME persisted worker-summary spend object.

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
`DeepSeek worker: N turn(s), model provider/model` prefix and appends the
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

The P0–P2 cache/history refinements in this section are Unreleased working-tree
behavior, not a claim that the runtime has been committed or deployed.

Before each worker provider request, the v0.10.0 output control plane also
validates assistant/tool-result pairing and projects complete historical
bundles to the 64 KiB worker active-history budget. A single worker tool batch
is reserved against a separate 48 KiB result budget before execution. The
numeric-only progress/status facts report shown/omitted bytes, truncations,
blocked calls and history collapse; raw worker/tool text is never telemetry.
These controls are independent of the per-message context and cumulative
spend limits below.

History projection is segmented and epoch-based. A worker stays raw until it
crosses the unchanged 65,536-byte or 128-bundle hard limit. Projection-state v3
reserves its full 49,152-byte raw turn plus sixteen 384-byte/one-bundle segment
slots, leaving a fixed anchor cap of
`max(0, 65,536 - 49,152 - 16 * 384) = 10,240` bytes and 96 bundles. The active
suffix target is 16 bundles when a hard-limit projection is actually required.

At the initial checkpoint the worker keeps the largest latest raw suffix that
fits those turn limits and projects only the older prefix into the anchor.
Normal requests replay the exact anchor, immutable ordered segments, and raw
active suffix. Crossing the 49,152-byte or 16-bundle reserve alone does not
seal: while the complete reconstruction remains at or below 65,536 bytes and
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
trigger percentage comes solely from Pi 0.83 `getContextUsage()`, which already
measures raw session messages; it never adds a raw-minus-projected token delta.
Worker-role entries are deliberately ignored and never alter the worker's
independent 80% soft / 90% hard policy. This repository publishes the contract
but does not install or deploy the companion extension. Projection-state v3
does not change the nine-field pressure wire contract and requires no companion
code change.

DeepSeek worker requests receive no OpenAI-specific breakpoint fields. The
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
`BLOCKED_BY_PI_0_83_PUBLIC_API`: there is no public post-summary payload
transform or same-cache-domain guarantee. The worker runtime does not duplicate
private auth/header/stream/retry behavior. Existing worker compaction
cancellation and Commander built-in/native compaction behavior are unchanged.

The pinned worker runs on a 1,000,000-token context window. The workbench
protects that budget with two thresholds that are model-specific and
independent of the Commander/project compaction reserve:

| Threshold | Tokens | Behavior |
| --- | --- | --- |
| Soft handoff | 800,000 (80%) | The worker role sends one hidden active-loop steer (`display: false`, `deliverAs: "steer"`): stop new implementation, finish a concise handoff, list the remaining work. |
| Hard stop | 900,000 (90%) | The runner terminates the child and the invocation fails closed. |

Context tokens use Pi's normalized usage semantics: a positive
`totalTokens` is authoritative; otherwise the sum of the non-negative
`input + output + cacheRead + cacheWrite`. Malformed, non-finite or
negative values contribute zero — never NaN.

Inside the worker process the extension also cancels
`session_before_compact` (`{ cancel: true }`) so a worker never silently
continues through lossy compaction; the Commander's compaction supplement
behavior is unchanged. Defense in depth: the runner independently parses
`compaction_start` events from the child JSON stream (count + distinct
reasons) and any compaction attempt fails the invocation closed — even if
the child would otherwise exit 0.

The final report exposes the facts: the text appends
`worker budget : max context N / 1000000 (P%) | soft 800000 | hard 900000`
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
ledger persistence, handoff rendering and numeric-only progress
landed; Phase 5 (task-contract profile wording and delegation-granularity
guidance) landed.** The runner accumulates the cumulative
spend state after every assistant message (same pure policy), records the
final profile/state/band/reasons facts on every run result, and terminates
the child fail-closed whenever any hard dimension is reached (`>=`,
deterministic hard-stop message). The worker-role lifecycle reads the
spend profile from the fixed child env contract
(`WORKBENCH_WORKER_SPEND_PROFILE` — the runner always writes a valid
`low`/`standard`/`extended` value; malformed/missing child env falls back
to `standard` defensively), accumulates its own independent spend state
on assistant `message_end` events, and sends exactly one hidden cumulative
soft steer when the band first becomes soft or hard. **Phase 3 status:
public selection, contract validation, ledger persistence and handoff
rendering landed.** The optional `budget_profile` tool parameter (closed
literal union `low | standard | extended`, default `standard`, `extended`
never inferred) is resolved by the strict contract validation in
`core/worker-policy.ts` BEFORE any ledger creation or child launch, the
resolved profile is recorded in the before contract
(`before.json` → `contract.budget_profile`) and passed to the runner (the
same profile reaches the child env and every outcome's spend facts —
exception fallbacks included), and the canonical cumulative `spend` object
is persisted additively in `usage.json` / `worker-summary.json` on every
finished success and failure and rendered into the bounded parent handoff.
Per-message context safety (above) is unchanged.

| Profile | Soft turns | Soft total | Soft output | Hard turns | Hard total | Hard output |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `low` | 8 | 750,000 | 40,000 | 12 | 1,250,000 | 75,000 |
| `standard` (default) | 24 | 3,000,000 | 120,000 | 36 | 5,000,000 | 200,000 |
| `extended` (explicit) | 48 | 8,000,000 | 200,000 | 64 | 12,000,000 | 300,000 |

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
  the fixed order `turns`, `total_tokens`, `output_tokens`.
- **Soft steer (wired):** at most one hidden cumulative soft steer per
  delegation (`WORKER_SPEND_SOFT_STEER_MESSAGE_TYPE =
  "workbench-worker-spend-soft-steer"`, `display: false`,
  `deliverAs: "steer"`), sent by the worker-role lifecycle only — the
  commander session never receives it — with its OWN one-shot flag,
  independent of the context steer, naming the profile, the triggered
  dimension(s) in the fixed reason order, and current vs. limit values; a
  send failure is swallowed and never breaks a model request. The steer is
  a request, not an enforcement.
- **Hard stop (wired):** when any hard dimension is reached the runner
  terminates the child and the invocation fails closed
  (`assertWorkerSucceeded`), naming the winning dimension(s) and
  current/limit values via the deterministic hard-stop formatter; the
  ledger is finished on every outcome (the spend facts enter the
  ledger/handoff as of Phase 3). The 60-minute timeout remains an
  independent failure path.
- **Profiles:** `standard` is the deterministic default for every
  delegation without an explicit request; `low` is an explicit tighter
  opt-in; `extended` is explicit Sol-approved only and is never inferred
  or auto-promoted. The public `budget_profile` tool parameter
  (optional, closed literal union `low | standard | extended`, default
  `standard`) is validated by the pure contract check in
  `core/worker-policy.ts` — omitted resolves to `standard`; unknown,
  empty, wrong-type and case-variant values fail closed with a bounded
  error before the ledger is created or the child starts. The pure
  resolver defaults to `standard` only where a default is explicitly
  requested, while strict validation rejects unknown values.
- **Child env contract (wired):** the runner passes the resolved profile to
  the worker child through the fixed `WORKBENCH_WORKER_SPEND_PROFILE` env
  variable; the worker-role lifecycle strictly validates it and falls back
  to `standard` on malformed/missing values (defensive — the runner always
  writes a valid value).
- **Deterministic summary** (rendered into the parent handoff and ledger):
  `spend budget : turns N/M | total X/Y | output A/B | profile P` with the
  profile's hard limits as denominators; the handoff derives the line and
  the nested `spend` details from the SAME canonical spend object the
  ledger persisted in worker-summary.json (never recomputed from runner
  internals or worker prose).

## Review patch bounds (P7)

`workbench_review_worker_diff` renders a redacted patch bounded by default
at 400 lines / 32 KiB, enforced GLOBALLY over the rendered patch content
(never independently per path). ANY per-path truncated entry also sets
`patch_truncated` — even when the (redaction-shrunk) entry fits the global
envelope — so the segmented-review instruction always renders when any
content was cut. Scope checks and the bound diff hash always use the
COMPLETE actual worker diff — truncation affects only the displayed
patch. Every patch path carries bounded path/stat information (source,
bytes, truncated/omitted), and when patch content is truncated or omitted
the review returns an explicit segmented-review instruction: drive
path-by-path `include_paths` re-reviews (max 50 paths per call).

## Task contract

```json
{
  "task": "Implement the already-approved parser change",
  "allowed_paths": ["src/parser/**", "tests/parser.test.ts"],
  "acceptance_criteria": [
    "Invalid input returns a structured error",
    "Existing valid input remains compatible"
  ],
  "verification": ["Run the unit-test recipe"],
  "budget_profile": "standard",
  "repair_of": "20260101-120000-abcd",
  "timeout_seconds": 1800
}
```

`budget_profile` is optional and selects the cumulative delegation-spend
profile (`low | standard | extended`; omitted resolves to `standard`). The
profile bounds cumulative spend only — it never expands the approved paths
or scope. `standard` is the deterministic default; `low` is an explicit
tighter opt-in for deliberately small slices; `extended` is explicit
Sol-approved only for an approved larger slice and is never inferred or
auto-promoted. The worker task text carries the resolved profile as one
informational line; enforcement is the runner's fixed child-env contract,
never task prose.

`repair_of` is optional and is the strict prior delegation-id provenance
pointer for a known-root-cause repair (see Repair provenance pointer
above): exactly the 20-character `^\d{8}-\d{6}-[A-Za-z0-9]{4}$` delegation
id shape, used only after Sol has fixed the known root cause and decided
the scope, with the bounded failure evidence carried in the task itself;
the runtime requires the referenced prior delegation ledger to be finished
before any new ledger is created or any worker is launched, and the fresh
worker inherits no prior report/session/scope/contract — the pointer adds
no path/scope/authority. Ordinary delegations omit it entirely; unknown
root causes still use bounded diagnosis, then a Sol decision.

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
8. **Worker-first write authority:** approved Sol in DEV gets exactly the
   canonical 15-tool allowlist (no bash/edit/write, no foreign tools); the
   second-layer `tool_call` guard blocks bash for Sol always, blocks
   edit/write without an active human-issued lease (and outside its paths),
   and blocks every tool outside the allowlist despite any re-enable.
9. **Review gating:** a pending or stale delegation review blocks the next
   delegation and VERIFY; the review binds the current diff hash and any
   later diff change turns the delegation STALE.

These are guardrails, not an OS security boundary. Use a container or VM for
untrusted repositories or unattended automation.

## Required commander workflow

1. Orient in the repository (minimum orientation — enough to define the
   slice) and inspect the current git state.
2. Define observable acceptance criteria and explicit allowed paths for the
   source, tests, and docs of one coherent vertical slice.
3. Size every delegation as ONE coherent source+tests+docs vertical slice
   with ample headroom BELOW its soft thresholds — soft is a handoff
   reserve and hard is failure; neither is a planning target. Never plan a
   delegation that expects to consume its budget, and never batch
   unrelated work into one task to amortize delegation overhead.
4. Choose the spend profile explicitly: `standard` is the deterministic
   default (omit `budget_profile`); pass `low` only when the slice is
   deliberately tighter; pass `extended` only with explicit Sol approval
   for an approved larger slice — it is never inferred or auto-promoted.
5. When the root cause of a problem is unknown, never delegate one
   open-ended "investigate and fix" task. Split the work into (a) a
   bounded diagnosis delegation, (b) a Sol architecture/scope decision
   from the diagnosis, and (c) a bounded implementation delegation for the
   decided slice.
6. Delegate bounded low/medium-risk vertical slices while in DEV; high-risk
   decisions remain Commander-led — Sol never delegates the decision itself,
   and only explicitly designed bounded support/implementation scopes are
   delegated after the architecture is fixed. Sol does not directly write by
   default: implementation and repair writes go to a fresh bounded worker;
   a temporary commander direct write requires an explicit human-issued
   write lease (`/q-commander-write-unlock`).
7. Avoid duplicating the worker's routine investigation, but read the actual
   files and diff after the worker returns — the report is never acceptance.
8. Correct defects by issuing another bounded delegation to a fresh worker,
   or — only with an explicit human-issued temporary write lease — repair
   directly (see Worker-first write authority).
9. Switch to VERIFY.
10. Run declared recipes and the project validation gates.
11. Make the final verdict from persisted evidence, not worker prose.

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
- an assistant event reaches the 900,000-token (90%) hard context budget;
- any cumulative spend dimension reaches its hard limit (turns / total
  tokens / output tokens per the active profile — `standard` by default,
  `low`/`extended` explicit opt-ins via the optional `budget_profile`
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
