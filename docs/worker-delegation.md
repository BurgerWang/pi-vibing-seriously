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
10. terminates the child on completion, timeout, parent abort, hard-budget
    stop, or a compaction attempt;
11. finishes the ledger on EVERY outcome (success and failure —
    `after.json`, `worker-summary.json`, `review.json` placeholder, the
    bounded `worker-report.md` and `usage.json`, review_status
    PENDING_REVIEW);
12. returns a STRICTLY bounded structured summary to the parent session
    (delegation id, provider/model, status, actual changed paths, bounded
    parsed section items, usage/cache/budget facts, durable report path,
    parse/review warnings) — never the worker's report text, patch, or
    test logs.

There is no persistent worker process. The child inherits the user's OS
permissions and provider authentication, just like any other Pi process.

## Worker-first write authority (P7)

Approved GPT-5.6 Sol resolves to the fixed `worker-first-strict` write policy
in DEV: the active tool set is exactly the canonical 14-tool allowlist
(`read`, `grep`, `find`, `ls` plus all ten `workbench_*` tools) — no
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
  exact canonical 14 tools. The footer shows `WF:LEASE <used>/<max>` while an
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
  the parse-reliability and item-truncation facts, and a parse warning
  when the report sections are missing/unreliable or the Files Changed
  claims diverge from the actual diff; this record is the SINGLE summary
  derivation the parent handoff renders (the runtime never re-parses the
  report text for the parent);
- `usage.json` — bounded structured usage/cache/budget/turn facts with the
  nested worker usage shape preserved for cost accounting.

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
observations, up to 8 remaining risks, the usage/cache/budget summary, the
durable report path, the parse warning, and the explicit instruction that
Sol must inspect the actual diff. Rendering reserves every required fact
line (identity/status/turns, changed paths, usage/cache/budget, the
report/summary/usage artifact paths, parse/review/failure facts) and drops
optional summary items only as WHOLE sanitized lines until both global
caps hold — a rendered line is never cut mid-item or mid-code-point. It
never contains the full report, patch, or test logs; `details` never carry
`allowed_paths`/`output`/`full_report`/`transcript`/`patch` fields and
never duplicate the report. Top-level nested worker usage is preserved
unchanged.

Progress callbacks expose only the turn count and provider/model — never
`lastText` and never intermediate/final worker text. The compact progress
shape is exactly `DeepSeek worker: N turn(s), model provider/model`
(starting state included).

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
  "timeout_seconds": 1800
}
```

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
   canonical 14-tool allowlist (no bash/edit/write, no foreign tools); the
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
3. Delegate bounded low/medium-risk vertical slices while in DEV; high-risk
   decisions remain Commander-led — Sol never delegates the decision itself,
   and only explicitly designed bounded support/implementation scopes are
   delegated after the architecture is fixed. Sol does not directly write by
   default: implementation and repair writes go to a fresh bounded worker;
   a temporary commander direct write requires an explicit human-issued
   write lease (`/q-commander-write-unlock`).
4. Avoid duplicating the worker's routine investigation, but read the actual
   files and diff after the worker returns — the report is never acceptance.
5. Correct defects by issuing another bounded delegation to a fresh worker,
   or — only with an explicit human-issued temporary write lease — repair
   directly (see Worker-first write authority).
6. Switch to VERIFY.
7. Run declared recipes and the project validation gates.
8. Make the final verdict from persisted evidence, not worker prose.

## Stable-prefix and cache behavior

The tool name, description, schema, prompt snippet, and guidelines are static
and registered in `WORKBENCH_TOOL_NAMES` order. Dynamic task facts are sent
in the child user message, not injected into the parent system prompt.
Adding this tool intentionally changes the DEV tool-schema fingerprint once;
after reload, same-mode fingerprints remain stable. DeepSeek usage is
returned as nested tool usage and the child workbench can continue using the
existing hash-only cache telemetry.

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
- the child emits any `compaction_start` event (a compaction attempt);
- the child exits non-zero, times out, or is aborted;
- the child reports an error/aborted stop reason;
- no verified final text response is produced.

Stderr and model-visible output are bounded with Pi's standard limits. Full
child transcripts are never copied into workbench run records or parent
results; the durable source-change and validation evidence remains the
project diff plus the bounded delegation artifacts (`worker-report.md`,
`worker-summary.json`, `usage.json`) and existing recipe/gate run records.
