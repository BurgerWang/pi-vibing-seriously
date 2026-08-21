# Worker Token-Budget Repair — Durable Implementation Plan

> **Historical calibration notice (2026-08-21):** this plan records the
> original DeepSeek-era diagnosis and implementation. The active worker is
> now `openai-codex/gpt-5.6-luna:xhigh`; current cumulative limits and
> continuation-reserve behavior are defined by
> `core/worker-spend.ts` and `docs/worker-delegation.md`. The historical
> baseline and old thresholds below are retained as audit evidence, not as
> current runtime configuration.

| Field | Value |
| --- | --- |
| Status | **APPROVED — Phases 1–5 IMPLEMENTED and FINAL-VALIDATED; Phase 6 deferred / NOT_SCHEDULED pending provider capability evidence** |
| Plan date | 2026-08-05 |
| Repository | pi-dev-workbench (`/home/hanbaoji/Projects/pi-vibing-seriously`) |
| Git baseline | `main` @ `819b7291963e` |
| Owner | GPT-5.6 Sol commander (requirements, architecture, review, gates, verdict) |
| Executor | Fresh bounded DeepSeek workers, one bounded phase per delegation |
| Scope | Commander/worker delegation spend budgets; Phases 1–5 implemented and final-validated (pure policy, runtime wiring, schema/ledger/handoff, numeric-only progress, task-contract wording/granularity guidance); Phase 6 decision gate deferred / not scheduled pending provider capability evidence |

This document is the durable contract for the already-approved commander/worker
Token-budget repair. It is self-contained: a brand-new Pi session can execute
it without access to any earlier conversation. It records the confirmed audit
baseline, the root cause, the approved architecture (exact limits and
semantics), the phased implementation slices with likely files, acceptance
criteria, test matrix, validation ladder, rollout/backward-compatibility
requirements, observability fields, failure/ledger semantics, non-goals,
risks, rollback, and the execution checklist. Phases 1–5 (pure policy +
tests + docs; runner accumulation + worker-child steer; tool schema / ledger /
handoff backward compatibility; numeric-only progress; task-contract wording
and granularity guidance) are implemented and final-validated — the
validation ladder (§10) was run after all phases were implemented and
reviewed, and the exact recipe/gate evidence is recorded in §10.1. Phase 6
remains deferred / `NOT_SCHEDULED` pending provider capability evidence;
no adaptive-reasoning support is claimed.

---

## 1. Problem

The workbench delegates bounded implementation tasks from a GPT-5.6 Sol
commander to pinned `deepseek/deepseek-v4-flash:max` Pi worker children
(see `docs/worker-delegation.md`). The only token protection today is
**per-message context safety**: a 1,000,000-token context window with an
800,000 (80%) soft handoff and a 900,000 (90%) hard stop
(`extensions/workbench-runtime/core/worker-budget.ts`). That protection
bounds how large any single message's context may grow; it places **no bound
on cumulative spend** — turns, cumulative total tokens, or cumulative output
tokens — across a delegation. Because DeepSeek prompt caching serves most
context as `cacheRead` (~97.4% of the audited sample), a worker can run
dozens or hundreds of turns and consume tens of millions of billed tokens
while no single message ever approaches the 800k context soft limit.

## 2. Confirmed audit baseline

Source of truth: the delegation ledger of the SCALPER project,
`/home/hanbaoji/code/SCALPER-p0-p1-completion/.pi/workbench/delegations/<id>/usage.json`
(17 finished delegations, verified 2026-08-05). The totals below are the
confirmed baseline and were re-derived from those records.

| Metric | Value |
| --- | --- |
| Finished delegations in baseline | 17 |
| Cumulative turns | 895 |
| Cumulative total tokens | 176,233,313 |
| Median turns per delegation | 49 |
| Median total tokens per delegation | 7,577,942 |
| Delegations over 5M total tokens | 10 / 17 |
| Delegations over 10M total tokens | 7 / 17 |
| Cumulative cacheRead | 171,677,952 (~97.4%) |
| Cumulative input | 3,023,927 |
| Cumulative output | 1,531,434 |
| Ledger cost (Σ `usage.cost.total`) | ≈ $1.33 |

Per-delegation records (baseline; `turns`, `totalTokens`, `maxContextTokens`,
`softBudgetReached`, `status` from each `usage.json`):

| Delegation id | Turns | Total tokens | Max context | Context soft | Status |
| --- | ---: | ---: | ---: | --- | --- |
| 20260804-180256-t1rd | 109 | 19,427,073 | 333,337 | no | success |
| 20260804-182145-8wrv | 31 | 1,667,988 | 80,524 | no | success |
| 20260804-182626-21cf | 13 | 789,239 | 90,070 | no | success |
| 20260804-182943-0n4y | 11 | 481,029 | 63,591 | no | success |
| 20260804-183251-7ip9 | 9 | 329,442 | 47,352 | no | success |
| 20260804-183534-0gys | 21 | 1,301,910 | 134,878 | no | success |
| 20260804-183931-axom | 9 | 312,187 | 46,198 | no | success |
| 20260804-184225-rk0f | 10 | 411,430 | 55,270 | no | success |
| 20260804-190302-nulo | 70 | 13,676,291 | 403,873 | no | success |
| 20260804-194211-2m0s | 56 | 7,577,942 | 254,762 | no | failure |
| 20260804-195733-hyou | 74 | 13,836,909 | 323,651 | no | success |
| 20260804-201526-zegk | 49 | 7,848,377 | 254,596 | no | success |
| 20260804-204126-exm6 | 92 | 33,996,212 | 831,083 | **yes** | failure (timeout) |
| 20260804-214758-efnk | 71 | 11,977,424 | 330,972 | no | success |
| 20260804-221545-1oi4 | 95 | 20,099,595 | 359,365 | no | success |
| 20260804-224356-3jal | 43 | 5,199,324 | 172,335 | no | success |
| 20260805-073945-agdo | 132 | 37,300,941 | 432,136 | no | success |

Note: the ledger directory now also contains an 18th finished record,
`20260805-085409-m7t4` (77 turns, 13,386,322 total tokens), which
**post-dates the baseline and is excluded from it**. Re-deriving the
baseline sums requires excluding that record.

### 2.1 Concrete delegation evidence

**`20260805-073945-agdo` (the poster child).** 132 turns, 37,300,941 total
tokens, max context 432,136 (43.2% of the window), context soft budget
**never** reached, status success, stop reason `stop`. The largest
delegation in the audit ran to natural completion under the existing
protection because no single message approached 800k context tokens — 132
turns of mostly cached re-reads accumulated 37.3M billed tokens silently.

**`20260804-204126-exm6` (soft reached, then timeout).** 92 turns,
33,996,212 total tokens, max context 831,083 (83.1%), context soft budget
**reached** (the one-shot context steer fired), then the run was killed by
the unrelated 60-minute timeout (`status: failure`, `error_message:
"DeepSeek worker timed out"`, exit 143). The context steer did not and
cannot bound spend: the delegation still consumed 34M tokens, and the
timeout is a wall-clock guard, not a spend guard.

## 3. Root cause

The existing 800k/900k protection is **per-message context safety**: it
bounds the context window at any single message and is silent about
cumulative consumption. **No cumulative turns, total-token, or output-token
budget exists** for a delegation. With prompt caching, cumulative billed
tokens grow roughly linearly with turns while per-message context stays
small, so long delegations are invisible to the only budget that exists
until (a) they finish naturally, (b) the 60-minute timeout fires, or (c) a
single message approaches 900k context. The repair adds an independent
cumulative delegation-spend budget; it does not modify context safety.

## 4. Approved architecture

### 4.1 Unchanged: per-message context safety

The existing context-budget protection is retained **unchanged**:

- 1,000,000-token pinned window; soft handoff 800,000 (80%); hard stop
  900,000 (90%) — `WORKER_SOFT_BUDGET` / `WORKER_HARD_BUDGET` in
  `extensions/workbench-runtime/core/worker-budget.ts`.
- Per-message context tokens via `workerContextTokens`: positive
  `totalTokens` authoritative, else sum of non-negative
  `input + output + cacheRead + cacheWrite`; malformed/non-finite/negative
  values contribute zero, never NaN.
- One-shot hidden context steer at/above 800k; runner terminates fail-closed
  at/above 900k; any `compaction_start` event fails the invocation;
  `session_before_compact` is cancelled in the worker role.

### 4.2 New: independent cumulative delegation-spend accounting

A new pure spend-budget policy operates **independently** of context safety
and accumulates over **all assistant messages** of the delegation run. The
runner already processes every assistant `message_end` event; the cumulative
state is derived from the same events, never from worker prose.

Per-message normalization (identical semantics to `workerContextTokens`,
reused from `core/worker-budget.ts`):

- A positive `totalTokens` is authoritative for the per-message total;
- otherwise the sum of the non-negative `input + output + cacheRead +
  cacheWrite` components;
- **`cacheRead` counts** (cache-hit input is billed at the cache-hit rate,
  so it is real spend);
- malformed, non-finite, or negative values normalize to zero — never NaN,
  never a crash; a malformed message simply contributes 0 to the cumulative.

Cumulative dimensions (one per delegation run):

| Dimension | Identifier | Definition |
| --- | --- | --- |
| Turns | `turns` | Count of processed assistant messages |
| Total tokens | `total_tokens` | Σ per-message normalized total (semantics above) |
| Output tokens | `output_tokens` | Σ per-message `output` component (non-negative finite; malformed → 0) |

The output dimension reads the per-message `output` field directly
(independent of which path the per-message total took); if a provider omits
`output`, the dimension undercounts — accepted, documented heuristic guard.
`total_tokens` is the primary spend dimension.

### 4.3 Budget profiles (exact limits)

Three fixed profiles; **`standard` is the default** for every delegation
that does not explicitly request another. `low` and `extended` are explicit
opt-ins via the delegation task contract; `extended` must never be inferred
or defaulted. Per profile, **soft** = one hidden steer, **hard** = runner
terminates and the invocation fails closed:

| Profile | Soft turns | Soft total | Soft output | Hard turns | Hard total | Hard output |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `low` | 8 | 750,000 | 40,000 | 12 | 1,250,000 | 75,000 |
| `standard` (default) | 24 | 3,000,000 | 120,000 | 36 | 5,000,000 | 200,000 |
| `extended` (explicit) | 48 | 8,000,000 | 200,000 | 64 | 12,000,000 | 300,000 |

All six numbers per profile are fixed constants; "reached" means **at or
above** the limit (`>=`), mirroring the existing `workerBudgetBand`
convention.

### 4.4 Band evaluation and precedence

Evaluate all three dimensions against the active profile on every assistant
message:

1. **Any hard dimension reached → `hard`** (hard wins over soft, always).
2. Else **any soft dimension reached → `soft`**.
3. Else `ok`.

The triggered-reasons list is the subset of dimensions at/above their
threshold, in the **fixed order `turns`, `total_tokens`, `output_tokens`** —
never alphabetical, never insertion order, never provider order.

### 4.5 Soft steer semantics

- At most **one hidden cumulative soft steer per delegation** (independent
  of the context steer, which remains at most one per process).
- Delivered exactly like the existing steer: `display: false`,
  `deliverAs: "steer"`, sent by the worker-role lifecycle only — the
  commander session never receives it; wrapped so a send failure can never
  break a model request.
- Steer content: stop starting new implementation, finish only the change in
  flight, write the concise handoff, list remaining work; names the profile,
  the triggered dimension(s) in the fixed reason order, and current vs.
  limit values.
- The steer is a **request, not an enforcement**: if the run continues, the
  hard stop still applies when a hard dimension is reached.

### 4.6 Hard-stop semantics

- When any hard dimension is reached, the runner terminates the child and
  the invocation **fails closed** (mirroring the existing 900k path).
- The failure message names the winning dimension(s) in the fixed reason
  order with current vs. limit values.
- The ledger is finished on **every** outcome (success and failure), exactly
  as today: `after.json`, `worker-summary.json`, `worker-report.md`,
  `usage.json`, `review.json` PENDING_REVIEW placeholder.
- The 60-minute default timeout remains an independent failure path
  (evidence: exm6 soft-steered and still timed out); budgets never extend
  or replace the timeout.

### 4.7 Cost observation

Cost is **observed but not enforced initially**: ledger cost fields
(`usage.cost.*`, ≈ $1.33 for the audited 176M tokens) continue to be
recorded and reported, but no profile has a cost dimension and no cost limit
is enforced. Cost enforcement is a deliberate non-goal (see §13).

## 5. Preserved invariants (safety and trust boundaries)

The repair must preserve, byte-for-byte in behavior, all of the following:

1. **Fresh `--no-session` worker child** per delegation; never resumed; no
   worker memory across delegations; a worker can never delegate.
2. **Model-drift checks**: every assistant event must report
   `deepseek/deepseek-v4-flash:max`; any other provider/model fails the
   invocation.
3. **Compaction fail-closed**: worker-role `session_before_compact` cancel
   unchanged; runner parses `compaction_start` events (count + distinct
   reasons) and any compaction attempt fails the invocation closed.
4. **Parent handoff bounds**: parent toolResult content ≤ 120 lines /
   12,288 UTF-8 bytes (`MAX_PARENT_HANDOFF_LINES` /
   `MAX_PARENT_HANDOFF_BYTES` in `worker/handoff.ts`); `worker-report.md`
   ≤ 512 KiB, redacted first then capped, mode 0600, atomic, code-point-safe
   truncation; UTF-8 bytes govern every cap; the new budget facts must fit
   inside these bounds.
5. **Worker report trust boundary**: the report is never acceptance
   evidence; `## Verification` records only commands and observed results;
   only Sol maps evidence to criteria and gives the verdict.
6. **Worker-first review lifecycle**: bounded ledger on every outcome;
   PENDING_REVIEW → REVIEWED → STALE with diff-hash binding; a pending or
   stale review blocks the next delegation and VERIFY;
   `workbench_review_worker_diff` scope-checks every changed path against
   parent-approved `allowed_paths`; B6 (Worker-First Compliance) stays
   machine-backed and never satisfiable by model prose.
7. **One writing worker per worktree**; sequential tool execution; workers
   run only write-free declared recipes (`writes: []`); free `bash` remains
   blocked for workers; `edit`/`write` only inside parent-approved paths.
8. **Per-message context safety unchanged** (§4.1): thresholds, steer text,
   fail-closed behavior, and all existing `worker-budget` tests.

## 6. Phased implementation slices

Each phase is one bounded delegation with its own explicit allowed paths and
acceptance criteria (see §7). Phases land in order; Phase 6 is a decision
gate, not a scheduled implementation. "Likely files" are the expected exact
paths; a phase's delegation may adjust only file placement within the
approved subtree, never the semantics.

### Phase 1 — Pure spend-budget policy + unit tests + docs (no runtime wiring)

Pure logic only; nothing is invoked by the runtime yet.

- **Likely files**
  - New `extensions/workbench-runtime/core/worker-spend.ts` — profile
    constants (exact numbers from §4.3), per-message total normalization
    (reuse `workerContextTokens` from `core/worker-budget.ts`), per-message
    output extraction, cumulative accumulator (turns / total_tokens /
    output_tokens), band evaluation + fixed reason ordering (§4.4), steer
    constants (`WORKER_SPEND_SOFT_STEER_MESSAGE_TYPE` =
    `"workbench-worker-spend-soft-steer"`, `WORKER_SPEND_SOFT_STEER_TEXT`),
    deterministic summary formatting helpers. No Pi imports.
  - New `tests/worker-spend.test.ts` — §8 matrix, including the
    audit-replay test (§6.1 note).
  - Docs: `docs/worker-delegation.md` (new "Worker cumulative spend-budget
    protection" section beside "Worker context-budget protection"),
    `docs/security.md` (budget bullets), `docs/architecture.md` (module map
    entry + data-flow paragraph).
- **Out of scope**: runner wiring, index.ts wiring, tool schema, ledger.

> **Audit-replay test (recommended, pure):** hard-code the 17-record
> baseline table (§2) as `(turns, total_tokens, output_tokens)` tuples and
> assert, under the `standard` profile, exactly the verified facts: 10/17
> reach hard (the same 10 for turns and total_tokens; none for output —
> max observed output 193,852 < 200,000), 11/17 reach soft on turns,
> 10/17 on total_tokens, 7/17 on output_tokens (nulo 172,385, hyou
> 129,163, zegk 154,002, exm6 193,852, efnk 122,567, 1oi4 185,279, agdo
> 177,413), and the reason lists
> follow the fixed order. This locks the policy to observed reality.

### Phase 2 — Runner accumulation + worker-child steer

- **Likely files**
  - `extensions/workbench-runtime/worker/runner.ts` — per assistant
    `message_end`: update cumulative spend state; evaluate band; on `hard`,
    terminate the child fail-closed with a dimension-named error (parallel
    to the existing 900k path); result object gains spend facts. Per-message
    context tracking untouched.
  - `extensions/workbench-runtime/index.ts` — worker-role lifecycle:
    one-shot hidden cumulative soft steer (its own flag, independent of the
    context steer flag), `try/catch` so a steer never breaks a model
    request; render spend facts into the worker budget summary line path.
  - Tests: extend `tests/worker-runner.test.ts` (accumulation, hard-stop
    failure, dimension-named errors) and `tests/p5-state-recovery.test.ts`
    (steer wiring, one-shot, independence from the context steer).
- **Out of scope**: tool schema, ledger fields, progress shape.

### Phase 3 — Tool schema / ledger / handoff backward compatibility

- **Likely files**
  - `extensions/workbench-runtime/core/tool-catalog.ts` —
    `workbench_delegate_worker` schema gains **optional** `budget_profile`
    (`Type.Union` of `low | standard | extended`, default `standard`;
    description documents the profiles and that standard is the default).
    Additive only — existing contracts stay valid.
  - `extensions/workbench-runtime/core/worker-policy.ts` — validate
    `budget_profile` in the task contract; unknown/malformed value fails
    closed.
  - `extensions/workbench-runtime/core/delegation-ledger.ts` — `usage.json`
    / `worker-summary.json` gain **additive** spend fields (profile, turns,
    totalTokens, outputTokens, band, per-dimension soft/hard flags, ordered
    reasons). `schema_version` stays 1 unless a breaking shape change is
    required (not expected); old readers ignore new fields.
  - `extensions/workbench-runtime/worker/handoff.ts` — extend the budget
    fact lines and structured `details` with the spend facts, inside the
    existing 120-line / 12,288-byte parent caps; keep the single-derivation
    rule (parent renders the same facts the ledger persists).
  - Tests: `tests/worker-policy.test.ts` (contract validation),
    `tests/delegation-ledger.test.ts` (additive fields, backward-compatible
    read of pre-repair records), `tests/worker-handoff.test.ts` (caps hold
    with the new fact lines, UTF-8 byte semantics).
- **Out of scope**: progress shape (Phase 4), contract wording (Phase 5).

### Phase 4 — Numeric-only progress

- **Likely files**
  - `extensions/workbench-runtime/worker/runner.ts` — `WorkerProgress`
    gains numeric-only spend fields (turns, cumulative total/output tokens,
    band). Progress never carries text: no `lastText`, no worker text, no
    reason prose.
  - `extensions/workbench-runtime/index.ts` — compact progress shape
    extended with the spend numbers while preserving the existing
    `DeepSeek worker: N turn(s), model provider/model` shape and its
    numeric-only property.
  - Tests: `tests/worker-runner.test.ts` (progress shape and counts;
    progress never contains worker text).
- **Out of scope**: any change to what the parent toolResult carries
  (that stays bounded by handoff.ts).

> **Done (Phase 4):** `WorkerProgress` now carries exactly
> `turns`, `totalTokens`, `outputTokens`, `spendBand`
> (`ok | soft | hard`) plus the pinned provider/model identity, emitted
> after each processed assistant message is accumulated/evaluated so every
> tuple matches the final ledger counters at the last event (soft and hard
> outcomes included — the callback still runs after a hard-stop
> terminate). The starting/running onUpdate keeps the exact
> `DeepSeek worker: N turn(s), model provider/model` text prefix and
> appends the deterministic spend segment (`| spend total X | output Y |
> band B`); details add only the bounded numeric counters and the fixed
> band alongside the existing identity fields. Progress never carries
> worker text, reasons, report content, tool arguments, patches, logs, or
> error prose; malformed usage keeps every counter finite (zeros
> accumulate). Runner tests assert exact progress keys/values over
> multiple messages including cacheRead fallback, malformed usage, a soft
> transition, and a hard boundary, and that the final progress tuple
> equals the final `WorkerRunResult` spend facts. Implemented and
> final-validated.

### Phase 5 — Task-contract wording / granularity

Wording and docs only; no behavior change beyond Phase 3.

- **Likely files**
  - `docs/worker-delegation.md` — task-contract JSON example gains
    `budget_profile`; the required-commander-workflow wording instructs Sol
    to size each delegation as one coherent vertical slice with ample
    headroom under the default `standard` profile, and to use `extended`
    only for explicitly approved larger slices (never by default).
  - `extensions/workbench-runtime/core/tool-catalog.ts` — promptSnippet /
    guidelines wording for profile choice and slice granularity.
  - `extensions/workbench-runtime/core/worker-policy.ts` — validation error
    text referencing the profile names.
- **Out of scope**: any change to slice-size enforcement — granularity
  remains a commander decision; budgets only bound runaway runs.

> **Done (Phase 5):** `formatWorkerTask` in `core/worker-policy.ts` now
> appends one short deterministic spend-profile line naming the resolved
> `budgetProfile` (omitted → `standard`; explicit `low`/`extended` named
> when supplied) and stating the profile bounds cumulative spend only —
> it never expands the parent-approved path/scope authority. The static
> `workbench_delegate_worker` metadata (description / promptSnippet /
> promptGuidelines in `core/tool-catalog.ts`) now makes profile choice and
> bounded slicing operational: `standard` is the deterministic default,
> `low` is an explicit tighter opt-in, `extended` is explicit Sol-approved
> only and is never inferred/auto-promoted; every delegation stays one
> coherent source+tests+docs vertical slice with ample headroom BELOW its
> soft thresholds (soft is a handoff reserve, hard is failure — neither is
> a planning target); unknown-root-cause work splits into bounded
> diagnosis → Sol architecture/scope decision → bounded implementation,
> never one open-ended worker task. `docs/worker-delegation.md` gained the
> `budget_profile` task-contract example and the sizing/diagnosis
> commander-workflow rules. The TypeBox parameter schema, thresholds,
> ledger, runner accounting, progress, handoff, model selector and
> reasoning args are unchanged (schema hash still
> `71707090d2da085b036c5879dd2fcb72558175ead8e596bf55406b65732b0c83`).
> Implemented and final-validated.

### Phase 6 — Adaptive reasoning (decision gate; deferred / NOT scheduled)

Deferred by architecture decision. **No implementation happens until Sol
verifies provider capability**: DeepSeek reasoning-effort control exists,
is observable through the pinned `pi --mode json` child events, does not
regress prefix/cache stability or model identity checks, and shows measured
cost/benefit on real delegations. If and only if that verification passes
and Sol approves a design, likely files would be `worker/runner.ts` (child
argv) and `core/worker-spend.ts` (profile semantics); a fresh plan section
is required. Until then this phase stays deferred / `NOT_SCHEDULED` and is a
non-goal.

## 7. Acceptance criteria

### 7.1 Overall (final, commander-judged)

1. The three profiles' soft and hard numbers match §4.3 **exactly**
   (six numbers per profile, `>=` semantics, soft < hard per dimension,
   low < standard < extended per dimension).
2. `standard` is the default; `low`/`extended` are explicit opt-ins only;
   `extended` is never inferred; unknown profile values fail closed.
3. Cumulative accounting follows §4.2 exactly: positive per-message
   `totalTokens` authoritative; fallback = non-negative
   `input + output + cacheRead + cacheWrite`; `cacheRead` counts; malformed
   values contribute zero; NaN never appears in any cumulative value.
4. Band evaluation and precedence follow §4.4: any hard dimension wins over
   soft; reasons are the triggered dimensions in the fixed order `turns`,
   `total_tokens`, `output_tokens`.
5. Exactly **one** hidden cumulative soft steer per delegation; independent
   of the context steer; never sent to the commander session; a send
   failure never breaks a model request.
6. Any hard dimension reached → runner terminates the child, invocation
   fails closed, failure message names the winning dimension(s); the
   ledger is finished on that failure exactly as on success.
7. Per-message context safety (§4.1) is behavior-identical: all existing
   `worker-budget` tests and steer/compaction tests pass unchanged.
8. All §5 invariants hold (fresh `--no-session`, model-drift checks,
   compaction fail-closed, 120-line/12,288-byte parent handoff, worker
   report trust boundary, worker-first review lifecycle, one writer).
9. Backward compatibility: pre-repair ledger records parse with the new
   code; new fields are additive; parent handoff stays within the caps.
10. Docs updated: `docs/worker-delegation.md`, `docs/security.md`,
    `docs/architecture.md` (and `docs/compatibility.md` for the schema
    fingerprint note, §11).
11. Validation ladder (§10) passes: `typecheck`, `unit-test`, `check`
    recipes, base gates b1/b2/b3, and B6 with no required NOT_RUN left
    unaddressed.

### 7.2 Per phase

Each phase's delegation states its own observable criteria; the minimal
contract for every phase is: listed likely files changed (or explicitly
documented deviation), §8-relevant tests added and passing via the
`unit-test` recipe, `typecheck` clean, docs consistent, no out-of-scope
paths touched, and §5 invariants unaffected (verified by diff review, not
by worker prose).

## 8. Test matrix (boundary cases)

| Area | Cases |
| --- | --- |
| Per-message total normalization | positive `totalTokens` wins; `totalTokens` 0 / negative / NaN / Infinity / string → fallback; fallback sums non-negative components; negative / NaN / Infinity / string components → 0; `cacheRead` counts; `{}` / null / undefined / non-object / array → 0; fractional values accepted; empty usage → 0 |
| Output component | non-negative finite `output` accumulates; missing / negative / NaN / Infinity / string `output` → 0; independent of which total path was taken |
| Profile constants | exact equality of all 18 numbers; soft < hard per dimension; low < standard < extended per dimension; `standard` is the exported default |
| Band evaluation | single-dimension triggers (turns only, total only, output only); multi-dimension triggers; hard+soft mix → hard; hard+hard → hard; exact equality at a limit = triggered; one below = not triggered; zero state → ok; malformed state → ok |
| Reason ordering | always `turns`, `total_tokens`, `output_tokens` regardless of which dimensions triggered |
| Steer | one-shot (second soft event does not re-steer); independent flag from the context steer; steer text names profile + triggered dimensions + current/limit values; commander session never receives it; `pi.sendMessage` throw is swallowed |
| Hard stop | runner terminates on any hard dimension; failure message names dimension with values; child exit non-zero; ledger written (status failure, error_message set, review PENDING_REVIEW); hard applies even after soft fired |
| Profile selection | omitted → standard; `low`/`extended` accepted; unknown / empty / wrong type → fail closed before the child starts |
| Ledger / handoff | new fields present and additive; pre-repair `usage.json` records parse unchanged; parent handoff with new fact lines ≤ 120 lines / 12,288 UTF-8 bytes; caps hold with multibyte content (never split code points); worker-summary single-derivation preserved |
| Progress | numeric-only (turns, totals, band); never `lastText` or any worker text; counts agree with the ledger facts at the end |
| Audit replay (§6.1) | the 17-record baseline under `standard` yields exactly the verified §6.1 counts; reason lists follow fixed order |
| Regression | entire existing `worker-budget.test.ts`, `worker-runner.test.ts`, `p5-state-recovery.test.ts`, `worker-handoff.test.ts`, `delegation-ledger.test.ts`, `worker-policy.test.ts` suites pass unchanged (context safety byte-identical) |

## 9. Failure and ledger semantics

- **Hard budget stop** behaves like the existing hard-context stop: child
  terminated, invocation fails closed, `error_message` names the winning
  dimension(s) and values; `status: "failure"`, non-zero exit; the full
  ledger is still finished (`after.json`, `worker-summary.json`,
  `worker-report.md`, `usage.json`, `review.json` PENDING_REVIEW — never
  falls back).
- **Soft steer** is not a failure: the run may continue; facts record that
  the steer fired.
- **Timeout** (default 60 minutes) remains an independent failure path;
  budget facts are still recorded on a timeout (evidence: exm6).
- **Compaction attempt** still fails the invocation closed, unchanged.
- **Malformed usage** never produces NaN; zeros accumulate; the run's other
  dimensions keep counting.
- **Review lifecycle** is unaffected: every finished delegation — success,
  hard stop, timeout, abort, compaction rejection — enters
  PENDING_REVIEW; a pending/stale review blocks the next delegation and
  VERIFY; B6 remains machine-backed.

## 10. Validation ladder

Ordered; earlier steps gate later ones. Workers (DEV) may run only the
write-free declared recipes; Sol runs the final ladder in VERIFY after all
phases are implemented and reviewed.

1. **`typecheck` recipe** (`npm run typecheck`, `tsc --noEmit`) — clean.
2. **`unit-test` recipe** (`npm test`, `tsx --test tests/*.test.ts`) —
   full suite green, including new spend tests and unchanged regression
   suites.
3. **`check` recipe** (`npm run typecheck && npm test && git diff
   --check`) — the combined gate, intentionally uncached.
4. **Base gates** (`/q-gate` / `workbench_run_gate` in VERIFY): b1
   (typecheck recipe check), b2 (unit correctness — b2.2 boundary and b2.3
   error-path evidence are `manual` checks requiring commander evidence),
   b3 (integration — b3.2/b3.3 smoke evidence manual), plus B6
   Worker-First Compliance (machine-backed; missing facts NOT_RUN, and a
   required NOT_RUN never passes).

Final recipes/gates run **only after all phases are implemented and
reviewed** — never mid-stream, never on worker prose.

### 10.1 Final evidence (recorded 2026-08-05)

| Step | Run ID | Recorded result |
| --- | --- | --- |
| `typecheck` recipe | `20260805-105338-fb72` | exit 0 |
| `unit-test` recipe | `20260805-105344-52gk` | 825/825 tests passed, exit 0 |
| `check` recipe (typecheck + unit-test + `git diff --check`) | `20260805-105728-44kj` | exit 0 |
| All-gate `/q-gate all` | `20260805-110041-nr88` | PASS b0–b6; required manual checks (b2.2, b2.3, b3.2, b3.3, b4.1–b4.3, b5.1, b5.2) recorded as `manual` evidence in `gates.json` |

Note: the preceding all-gate run `20260805-105947-4foo` was BLOCKED (exit
1) only because the required manual checks (b2.2, b2.3, b3.2, b3.3) were
NOT_RUN, which in turn blocked b4/b5 on prerequisites; the machine-backed
checks (b0, b1, b2.1, b3.1, b6) passed. It was superseded by the PASS run
`20260805-110041-nr88` and was not a failure of the implementation.

## 11. Rollout and backward compatibility

- **Additive-only data**: new ledger/handoff fields are optional additions;
  pre-repair records remain readable by the new code and by old tooling;
  no migration, no rewrite of existing records.
- **Default profile = `standard`**: delegations without `budget_profile`
  keep working but now carry cumulative limits — that is the intended
  behavior change. Verified against the baseline: under `standard` hard
  limits, 10/17 audited delegations (the same 10 for turns ≥ 36 and total
  ≥ 5,000,000; none for output ≥ 200,000) would have been hard-stopped.
- **Tool-schema fingerprint change** at Phase 3: the DEV tool-schema
  fingerprint changes exactly **once** within Phase 3, intentional
  (documented stable-prefix behavior; the cache telemetry will record
  `UNEXPECTED_DRIFT` for that single transition — expected, not a defect;
  after reload, same-mode fingerprints are stable again). **Done:** the
  delegate parameter-schema hash moved directly from
  `2cf1f563f78ffe2c85d142c1f40deea7bc658365345554db11c80b8af6b521d9`
  (pre-repair baseline) to
  `71707090d2da085b036c5879dd2fcb72558175ead8e596bf55406b65732b0c83`
  (final Phase 3 baseline — the additive `budget_profile` parameter with
  the nested JSON Schema `default: "standard"` annotation, pinned in
  tests/p6-b-stable-prefix.test.ts); the note
  is recorded in `docs/compatibility.md`.
- **Sequencing**: Phase 1 → 5 in order, one reviewed delegation per phase;
  Phase 6 only after Sol's provider-capability verification.
- **No version bump, no CHANGELOG entry** without Sol's release decision;
  release notes are Sol's, not the worker's.

## 12. Observability fields

New facts (camelCase in code/JSON; snake_case identifiers for dimensions and
reasons):

- `usage.json` / `worker-summary.json`: additive `spend` object —
  `{ profile, turns, totalTokens, outputTokens, band, softReached: {
  turns, totalTokens, outputTokens }, hardExceeded: { turns, totalTokens,
  outputTokens }, reasons: string[] }` where `reasons` entries are exactly
  `"turns" | "total_tokens" | "output_tokens"` in fixed order. Existing
  `budget` object (context facts) unchanged.
- Parent toolResult: extended deterministic budget summary line (e.g.
  `spend budget : turns N/M | total X/Y | output A/B | profile standard`)
  plus bounded `details` fields — inside the 120-line / 12,288-byte caps.
- Worker report text: the appended budget facts line extended with the
  spend summary; facts come from the runner result, never from the report.
- Progress events (Phase 4): numeric-only spend counters (turns, cumulative
  total/output tokens, band) plus the pinned provider/model identity; never
  text.
- Cost: unchanged (`usage.cost.*`, COST status segment, `/q-cost-status`);
  spend limits never alter cost accounting.

## 13. Non-goals

- **Cost enforcement**: cost is observed only; no cost dimension in any
  profile (§4.7).
- **Adaptive reasoning / reasoning-effort control**: deferred behind Phase
  6's provider-capability verification; not implemented in this repair.
- **Context-safety changes**: thresholds, steer, compaction handling, and
  1,000,000-token window are untouched.
- **Timeout changes**: the 60-minute default and its failure semantics stay.
- **Per-project / per-user / per-task-configurable budgets**: profiles are
  fixed constants; the closed enum is the only choice surface.
- **Automatic profile selection**: `extended` is never inferred from task
  length, history, or cost.
- **Slice-size enforcement**: granularity remains a commander decision
  (Phase 5 wording only).
- **Ledger migration or rewrite**: existing records are never modified.
- **New background processes, daemons, queues, or sandboxes**: unchanged
  pi-native architecture.

## 14. Risks

| Risk | Mitigation |
| --- | --- |
| Default `standard` stops delegations that previously ran to completion (10/17 of the audit would have hit hard limits) | Intended; explicit `extended` opt-in for approved larger slices; Phase 5 granularity wording; hard-stop failure is bounded, ledgered, reviewable |
| `total_tokens` is the binding dimension for most runs (~97.4% cacheRead) | Accepted; the audit-replay test pins the expected distribution; monitor `reasons` distribution after rollout |
| Tool-schema fingerprint drift at Phase 3 (one intentional change) | Documented expected `UNEXPECTED_DRIFT`; verify fingerprint stability after reload; note in `docs/compatibility.md` |
| Steer delivery disturbing an in-flight model request | Existing guard pattern reused (hidden steer, `try/catch`, `deliverAs: "steer"`); steer send failure is swallowed |
| Boundary off-by-one at thresholds | `>=` semantics pinned in §4.3 and tested at exact equality (one below vs. at) |
| Provider usage variance between `totalTokens` and component sums | Pi-compatible normalization is deterministic; malformed → 0; output undercount documented as heuristic |
| Hard stop mid-edit leaves a partial worktree | Ledger + actual-diff review capture the true changed paths; PENDING_REVIEW blocks follow-on work until Sol reviews; rollback is the phase diff |
| False economy: costs are low (~$1.33 / 176M tokens) so limits look unnecessary | Limits target runaway turns/behavioral waste (132-turn delegations), not raw cost; evidence: agdo and exm6 |
| Manual gate checks (b2.2/b2.3/b3.2/b3.3) need commander evidence | Sol provides evidence from the actual diff and recipe runs; a required NOT_RUN never passes |

## 15. Rollback

- Every phase lands as its own reviewed delegation, so rollback is the
  **phase's git diff reverted** and re-reviewed; no data migration exists
  (records are additive and remain valid before/after).
- **Context safety is the load-bearing invariant**: if any phase regresses
  §4.1 behavior, revert that phase immediately — Phase 1's policy is an
  isolated pure module, so reverting it is a single-file removal plus its
  test/doc reversions.
- Reverting Phase 3's schema addition restores the pre-repair tool
  fingerprint; ledger records written with spend fields remain readable.
- Rollback never requires touching existing delegation records, and never
  changes commander/worker identity or review semantics.

## 16. Execution checklist (final status)

| # | Item | Status |
| --- | --- | --- |
| 1 | Phase 1 — pure spend-budget policy + tests + docs | IMPLEMENTED + FINAL-VALIDATED |
| 2 | Phase 2 — runner accumulation + worker-child steer | IMPLEMENTED + FINAL-VALIDATED |
| 3 | Phase 3 — tool schema / ledger / handoff backward compatibility | IMPLEMENTED + FINAL-VALIDATED |
| 4 | Phase 4 — numeric-only progress | IMPLEMENTED + FINAL-VALIDATED |
| 5 | Phase 5 — task-contract wording / granularity | IMPLEMENTED + FINAL-VALIDATED |
| 6 | Phase 6 — adaptive reasoning (decision gate, after provider capability verification) | DEFERRED — NOT_SCHEDULED (pending provider capability evidence) |
| 7 | Validation ladder — typecheck → unit-test → check → base gates + B6 | PASS — `20260805-105338-fb72` (typecheck, exit 0), `20260805-105344-52gk` (unit-test 825/825, exit 0), `20260805-105728-44kj` (check incl. `git diff --check`, exit 0), `20260805-110041-nr88` (all-gate PASS b0–b6; required manual evidence recorded as manual) |
| 8 | Rollout review, compatibility note, Sol verdict | COMPLETE — rollout/backward-compatibility review done; compatibility note recorded; READY FOR SOL VERDICT |

## 17. Session-resume instructions (completed repair — maintenance/handoff)

1. **Inspect state first**: run `workbench_project_inspect`; check
   `.pi/workbench/delegations/` and `workbench_delegation_status` for the
   latest delegation and review state; check `git status` and `git log`
   against the header-table Git baseline (`main` @ `819b7291963e`). The
   implementation is complete: query `workbench_delegation_status` and
   require the reported latest delegation to be REVIEWED with its current
   diff hash equal to its reviewed hash; a pending or stale review, or a
   current/reviewed hash mismatch, must be resolved before any further
   work.
2. **Preserve reviewed hashes and recorded evidence**: do not amend the
   reviewed Phase 1–5 diffs or re-run/replace the recorded final recipe
   and gate runs (§10.1) without cause; preserve the per-delegation
   review records (each delegation's reviewed diff hash in its
   `review.json`) and the run IDs `20260805-105338-fb72`,
   `20260805-105344-52gk`, `20260805-105728-44kj`, `20260805-110041-nr88`
   are the durable validation evidence.
3. **Do not schedule Phase 6**: adaptive reasoning stays DEFERRED /
   NOT_SCHEDULED until Sol verifies provider capability (reasoning-effort
   control observable through the pinned child events, no cache-stability
   or model-identity regression, measured cost/benefit on real
   delegations) and approves a fresh plan section; no adaptive-reasoning
   support is claimed by this repair.
4. **Re-run validation after any future change**: any change to
   production code, tests, or this plan's technical content requires
   re-running the §10 ladder (`typecheck`, `unit-test`, `check`, then the
   base gates and B6) and re-reviewing the actual diff before any status
   update; the worker report is never acceptance — only the real diff and
   recipe/gate records are evidence.
5. Do not resume any worker session; do not accept worker prose as
   evidence; keep the §5 invariants as the binding constraints; the final
   verdict belongs to Sol, not the worker.
