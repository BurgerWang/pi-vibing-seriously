# Compatibility

Historical released matrix for **pi-dev-workbench v0.10.0 (Context Output Control Plane)**
plus the narrower current unreleased source/test target.
Rows label those scopes separately; no untested compatibility is claimed. The
machine-readable copy lives in
[`compatibility/pi.json`](../compatibility/pi.json).

## Unreleased pinned-worker qualification

The active delegated-worker selector is
`openai-codex/gpt-5.6-luna:xhigh`. On 2026-08-21 the installed Pi catalog
advertised a 272,000-token context window for that route; a real no-tools
temporary-directory availability smoke verified the provider/model and exit
status without sending private repository content. Runner argument, identity,
budget, and lifecycle behavior are covered by the current integration suite.
This establishes availability, not development efficiency: Luna throughput,
first semantic-acceptance yield, repair depth, and defect rate remain
**NOT_MEASURED**. A claim requires strict v2 semantic-acceptance evidence,
at least 12 complete ABBA blocks (24 stratified tasks per arm), no incomplete
block, and complete identity/KPI facts; missing facts remain unknown. The same
installed Pi catalog advertised a 272,000-token
context window for the pinned Sol route; neither catalog size is a measured
quality or speed result.
DeepSeek rows below are retained only as historical v0.10.0/cache-provider
compatibility evidence and are not the active worker selector.

## Unreleased cache-prefix P0–P2 compatibility

These are Unreleased source compatibility statements. No deployment, tag,
package publication, `/reload`, or completed live Pi-version qualification is
claimed. The operator's global `pi --version` reports 0.84.2, repository package
specifications target 0.84.2, and the current dependency tree resolves
Pi/pi-tui 0.84.2. Public compaction types and implementation were
source-audited at the official
[Pi v0.84.2 release](https://github.com/earendil-works/pi/releases/tag/v0.84.2),
[commit `914cf1472e715297caa30db4b9535d534a9eb718`](https://github.com/earendil-works/pi/commit/914cf1472e715297caa30db4b9535d534a9eb718).
That audit and dependency resolution are narrower than the declared
typecheck/test/gate/live matrix.

- Telemetry writers move to strict schema 1.3 while strict 1.0–1.2 records
  remain readable. New rows add disjoint read/write shares, numeric quality
  codes, exact context/request/message correlation, whole-item LCP, actor
  cohorts, and content-free history-projection anatomy. A local
  `before_provider_request` observation has `finalityCode=0` and is not the
  final provider wire. Non-exact correlation is accepted only with unknown
  actor and `historyProjection: null`. Event/cause/overflow/segment facts are
  accepted only in the strict schema-1.3 semantic matrix. Aggregate status
  code `7` (`aggregate_overflow`) means the exact sum exceeds the safe numeric
  publication surface and both shares are `null`; it is not a saturated ratio.
- Trusted recoverable ingress is additive for exactly finalized recipe
  summaries, executed gate records, immutable comparisons, completed worker
  reports, finalized run pages, and run-id gate pages. Sources must be regular
  in-project files no larger than 4 MiB, content-hashed and bound to stable
  size/device/inode/`mtimeNs`/`ctimeNs`; any mismatch simply leaves the result
  on the ordinary bounded path. Text at or below 4 KiB remains byte-exact,
  larger text may use the deterministic recovery wrapper, and a low allocation
  removes that wrapper/metadata together before applying the ordinary
  envelope. Gate-page cursors advance only across complete rows visible in the
  final page; projected history prefers the validated durable source pointer.
  The implementation is shared by Commander, worker, and other roles.
- Commander/worker role hard caps expand to 192/128 KiB; other remains 64 KiB
  and all roles remain capped at 128 bundles. The 64/48/48 KiB turn and
  16-bundle values remain suffix-selection reserves only: crossing a reserve
  alone stays byte-identical. Sealing requires a true role hard byte/bundle
  crossing; a later true crossing at the 16-segment safety ceiling performs a
  deterministic model-free checkpoint. Anchors are 122/74/10 KiB. State v3
  and telemetry schema 1.3 do not change; an old valid state emits one
  `policy_changed` transition.
- Responses cache-write status `2` means normalized absence-or-zero and is not
  promoted to provider-presence verification. DeepSeek Completions write
  status remains unavailable. Legacy `cacheHitRatio` remains readable while
  schema-1.3 canaries use the separately labeled disjoint read share.
- Warm-prefix auxiliary compaction is
  `BLOCKED_BY_PI_0_84_2_PUBLIC_API`. The public Pi 0.84.2 surface has no
  post-summary transform or same-cache-domain guarantee, and the workbench does
  not reimplement private authentication, headers, streams, retries, or
  provider calls. Commander instead evaluates the actual prepared native
  summary request: allow/warn/unknown preserve Pi's summarizer, while a
  conservative envelope estimate at or above model capacity returns a block
  before provider invocation, telemetry, or supplement and directs
  `/q-milestone-handoff <next step>`. The estimate is not a formal tokenizer-fit
  proof. Workers still cancel before reading preparation.
- Cache doctor remains non-executing for hostile evidence: Proxy/accessor/
  symbol/exotic rows are uninspectable partial input, never a clean result.
  Pending request correlation is single-use and resets with session identity
  or restored state.

## v0.10.0 context-output compatibility

The control plane is implemented and tested against Pi 0.83.0's event order
and tool-result replacement surface. Legacy `read(path, offset, limit)` calls
remain valid, but use the bounded read-v3 pager; run manifests, review records,
receipts, and old session JSONL remain readable. The comparison artifact is
additive. A separate streaming sanitizer creates a safe legacy-session copy
and manifest; it never rewrites or activates the source.

Streaming interoperability is deliberately fail-closed. Pi 0.83's public
extension API cannot replace a foreign tool definition or replace a
`tool_execution_update`; an immutable/accessor/Proxy partial result therefore
cannot be safely bounded after execution starts. Before every call, the
workbench re-reads Pi's effective tool registry and permits only a tool wrapped
by this exact runtime entry or one of Pi 0.83's seven exact synthetic built-ins
(`bash`, `edit`, `find`, `grep`, `ls`, `read`, `write`). The runtime-entry proof
accepts explicit temporary local loading of
`extensions/workbench-runtime/index.ts` and Pi package loading in either
project or user scope. Package proof requires the exact runtime entry path,
exact resolved repository package root as `baseDir`, package origin, exactly
the five Pi `sourceInfo` keys, a registered wrapper with the requested tool
name, and a non-empty package-source string bounded to 4096 UTF-8 bytes. The
source spelling itself is not identity: both the checked-in project setting
`packages: [".."]` and the non-`..` relative value written to user settings by
`pi install -l .` resolve to the same trusted package tuple. No arbitrary
project/user package is trusted: a foreign base directory or entry path, a
name collision, an extra/missing metadata key, a non-package origin, or an
empty/oversized source is blocked before `execute` with one fixed bounded
reason.
Foreign tools can remain in the advertised inventory, so tool order/schema
fingerprints do not drift, but they are not executable while this control plane
is active. An absent name is left to Pi's non-executing unknown-tool path.
Nonstandard inline or aliased loading that does not preserve one of those exact
identity tuples is intentionally unsupported and also fails closed.

The continuation wire transition is explicit rather than an in-place v1
reinterpretation: newly minted real-file read/gate cursors use `wbcur2` with
payload v2 and an exact decimal `mtimeNs` identity. `wbcur1` keeps its exact
legacy field set and canonical decoding. Because a v1 file cursor lacks the
stronger identity, it is conservatively stale when replayed against a source
whose bigint stat exposes `mtimeNs`; clients should treat every cursor as
opaque and continue with the latest returned value. Run-log cursors keep the
`wbcur1` envelope while their hashed source state includes `mtimeNs`. This
changes no tool parameter schema, registration order, mode inventory, or
tool-schema fingerprint.

Active-history projection has an explicit state-wire transition too. New
entries use strict `workbench-history-projection-state-v3` with
`schemaVersion: 3`, a numeric/hash-only record capped at 32 KiB. The
Unreleased hard ceilings are Commander/worker/other 192/128/64 KiB and 128
bundles. After reserving the 64/48/48 KiB raw role turn and sixteen
384-byte/one-bundle immutable segments, the Commander/worker/other anchor caps
are 122/74/10 KiB and 96 bundles. These values select a protected suffix
only after a true hard crossing; reserve-only growth is unchanged. Seals 1–16
preserve the epoch and all existing markers/slices, while a later true hard
crossing at the 16-segment ceiling triggers a checkpoint and increments the
epoch.

A valid restored v3 state under an earlier cap remains accepted. The first
request emits one `policy_changed` transition and persists the current policy;
subsequent replay is stable. This is a policy migration within v3, not a new
wire schema.

An exact v3 entry reconstructs every contiguous slice from raw JSONL. The
newest recognized malformed or structurally unsafe entry is authoritative: a
Proxy/revoked Proxy or `customType`/`data` accessor fails closed without
executing traps instead of falling back to older valid state; safely unrelated
plain entries remain skippable. Strict v1 and v2 are migration input only:
monotonic epoch and pressure carry forward, but topology and old hashes never
do. Below the cap, migration preserves raw history and emits one
`legacy_migration` boundary; its inactive v3 replacement prevents repetition
after reload.

Inactive v3 also encodes a fixed non-secret failure sentinel inside the
existing signed fields. It de-duplicates a repeated failure across JSONL
restore and emits one recovery boundary on the first healthy projection. No
wire schema changes for interrupted calls: a missing-result batch followed by
a later user message is projected as one bounded custom recovery marker, while
ambiguous/live/mismatched pairings retain the fixed failure sentinel. This lets
existing append-only sessions recover after process or power loss without
accepting any partial tool result as authority. It introduces no new wire key.
Projection identity uses exact UTF-16 code units,
JSON property enumeration order, omitted object `undefined`, and array holes as
`null`; bounded array/depth/work checks reject Proxies, accessors, and hostile
or over-budget values without running application code. Boundary marker IDs
derive only from projected, provider-visible structure. No old session file is
rewritten, and the nine-field `workbench-context-pressure-v1` diagnostic
contract is unchanged.

Provider breakpoint fields are a separate capability surface. The public
OpenAI path is optional and limited to exact `openai-responses` GPT-5.6 traffic
with an existing `prompt_cache_key`;
`openai-codex` stays disabled pending successful live SSE and WebSocket probes.
DeepSeek injection is a strict no-op. OpenAI may create at most four new writes
per request and read from the latest 50 breakpoint candidates, so the 17
logical v3 boundaries do not alter the provider wire into 17 writes. Operators
must keep exact prefixes/cache keys stable, place static content before
variable content, keep traffic near 15 requests/minute per key, and inspect
`cached_tokens`/`cache_write_tokens`. These choices do not weaken the segmented
prefix contract and do not claim a measured provider cache improvement.

The public tool schema/metadata intentionally changes once in 0.10.0. Old
prompt-cache prefixes are cold after reload; repeated same-mode static
fingerprints remain deterministic. Internal full `record`, `report`, and
`gates_full` details are not a compatibility surface and are replaced by
bounded DTOs plus persisted artifact pointers. See
[`context-output-control-plane.md`](context-output-control-plane.md) and the
[stable-prefix transition](cache/stable-prefix-contract.md). No Pi version
other than the matrix below is newly claimed by this release.

## Tool-schema fingerprint transition (Phase 3, worker token-budget repair)

`workbench_delegate_worker` historically gained exactly ONE additive parameter in Phase 3
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
- after reload, same-mode fingerprints are stable again; the only further
  fingerprint change from this repair is the Phase 4A `repair_of` pointer
  transition documented below (Phases 5–6 do not touch the delegate
  parameter schema).

Ledger records written by the new code remain readable by old tooling and
by the new code alike: the before contract's `budget_profile` and the
canonical `spend` object in `usage.json` / `worker-summary.json` are
additive fields on the unchanged `schema_version: 1` records; pre-repair
records without them parse unchanged and are never rewritten (no
migration).

The current surface retires `low`: public JSON Schema exposes only
`standard | extended`, omission now defaults to the safe `extended` profile,
`standard` remains an explicit small-slice selection, and explicit
`low` fails closed before transaction persistence or worker launch. Runner
and child-env compatibility maps old/internal `low` input to `extended`.
Frozen governance-v1 catalog/schema/hash evidence is unchanged, and already
committed v1/v2 `low` records remain strict read/hash compatibility data;
new committed artifacts cannot carry `low`. This intentional current-schema
change produces a new static DEV fingerprint without rewriting historical
fingerprint records.

## Historical tool-schema transition (Phase 4A — pointer-only `repair_of`)

At the Phase 4A snapshot, `workbench_delegate_worker` gained exactly one
additive parameter in the worker token-budget repair: the optional `repair_of`
strict prior delegation-id provenance pointer. This section characterizes that
frozen historical surface; it does not describe the stronger current semantic
repair authority documented below. The historical pointer was exactly 20
characters,
`^\d{8}-\d{6}-[A-Za-z0-9]{4}$`, and was used only for known-root-cause repairs
whose bounded root-cause/failure evidence the parent task itself carried.

The Phase 4A change was additive and intentionally changed the DEV tool-schema
fingerprint exactly once; the following pins belong to that frozen snapshot:

- the pinned delegate parameter-schema hash moved from the historical
  final Phase 3 value
  `71707090d2da085b036c5879dd2fcb72558175ead8e596bf55406b65732b0c83` to the
  machine-derived final Phase 4A value
  `dc1db21e3590c7f57cfa88f042052964a92d495116966747918d72f2018176a7`
  (derived by a focused commander no-cache run `20260808-114550-j4gd`,
  pinned in `tests/p6-b-stable-prefix.test.ts`);
- every pre-Phase-4A call contract stays valid: ordinary delegations omit
  `repair_of` entirely (the key never appears in the resolved contract),
  legacy `schema_version: 1` ledger records without the field parse
  unchanged, and no migration or rewrite happens — the before contract
  carries `repair_of` only when the pointer was supplied;
- the cache telemetry records that one transition as `UNEXPECTED_DRIFT` —
  **expected, not a defect** (documented stable-prefix behavior; the
  schema is still static and registered in the same explicit order);
- after reload, same-mode fingerprints are stable again; Phase 5
  (task-contract wording / granularity) deliberately leaves the parameter
  schema byte-for-byte unchanged.

In that historical snapshot the pointer was provenance only: the runtime
verified the referenced prior
delegation ledger is finished (manifest status `finished` with a non-null
`after` record) before any new ledger is created or any worker is
launched, inspected only those id/status/after facts, and the fresh worker
inherited no prior report/session/scope/contract — `repair_of` added no
path/scope/authority.

## Tool-schema fingerprint transition (framework reliability — optional `plan_ref`)

The current `workbench_delegate_worker` surface adds one optional, strictly
nested `plan_ref` object to the existing delegation-v2 contract. Historical
calls and committed generations without it remain readable and are never
rewritten. When supplied, the runtime normalizes and hash-binds the exact plan
snapshot, resolves `plan_path` within the project realpath boundary, and checks
the bounded current file bytes against `plan_sha256` both before transaction
work and again immediately before worker launch. It adds no paths, worker
authority, review result, or Gate PASS authority.

Historical committed contracts and Gate validation targets with no
`plan_ref` remain strict-readable. For a live chain, however, once the latest
strict committed contract carries a plan, a successor omission is rejected
before transaction allocation; the caller must explicitly retain that plan or
provide another current strict reference. Gate validation adds an optional
nested target component containing the plan-reference hash, sorted required
Gate ids and `FULL`/`PARTIAL` selector coverage. `base`/`all` are the final
selectors and must cover all mappings (`base` fails closed for a mapped quant
Gate); focused runs remain readable development feedback but persist an
unsuccessful partial binding. Current-state assessment rechecks plan bytes and
coverage, so drift never reuses an older PASS. These are additive no-plan
reader semantics; no existing no-plan record is rewritten.

The additive `plan_ref` field changed the delegate schema fingerprint once at
that transition. Subsequent current contract/review additions documented
below yield the current delegate parameter-schema hash
`fc20b3d36eb2f43f78bb2012635eb1906d96845aeafdacd130a70630a2a8dffd` and
the combined current unreleased framework-reliability public tool-surface
hash (including semantic REPAIR, repair-lineage, and stricter Gate evidence
wording) is
`9b091d42735c61fdc9032ff84d0c06d92b6556cd077d1051b2fab1e2b7e5f76d`.
Repeated same-mode builds remain deterministic; the separately retained
governance-v1 schema hash does not change.

## Worker contract and semantic-review transition (current unreleased)

The current delegate surface keeps all historical fields readable and adds
only bounded current-call rules:

- new verification strings are exact `recipe:<declared-name>` references;
  preflight requires a valid write-free, parameter-free recipe before
  authority work and rechecks it immediately before launch;
- canonical contract bytes have a 12-KiB soft ceiling and 64-KiB absolute
  ceiling; crossing the soft ceiling requires explicit `extended` plus the
  optional additive `extended_reason`, which is included in v2 contract hashes;
- historical committed contracts without `extended_reason`, and historical
  free-text verification values read through the frozen strict readers and
  are never rewritten. They do not become valid inputs for a new call merely
  because they remain readable;
- current `repair_of` still starts a fresh process and grants no new write or
  Gate scope, but it is no longer pointer-only authority. A wrong current
  `PENDING_REVIEW` implementation becomes referenceable only after active Sol
  inspects the complete unchanged packet and publishes immutable, hash-bound
  `semantic_decision=REPAIR` negative authority. Every semantic-repair child
  carries a strict lineage with the root/immediate decision identities and
  cumulative rejected W/D closure; exact-file scope and root plan continuity
  are revalidated separately. The at-most-8-KiB capsule is derived only from
  these strict machine facts. Historical pointer-only records remain readable
  without fabricating missing lineage or capsule facts.

Review evolution is additive at the record boundary. Historical v1/v2
mechanical review records remain strict-readable, but their `REVIEWED` or
coverage fields are never inferred as semantic acceptance. Every new non-zero
delta first persists a provisional scope/integrity packet, then requires a
second Sol call carrying `semantic_decision=ACCEPT` or `REPAIR` plus the exact
bound hash. `ACCEPT` grants strict semantic review authority. `REPAIR` also
requires bounded `repair_reason`, writes a separate immutable
`v2/repair-decision.json` negative sidecar, leaves the transaction
`PENDING_REVIEW`, and grants only the exact
fresh `repair_of` continuation reported by status; it never grants review or
Gate authority. New accepted records include strict `semantic_review` and
`semantic_acceptance` provenance; legacy/finalized mechanical records cannot be
upgraded in place. Zero-delta records alone use `not_required`. Compact facts
for large regular SVG/JSON files are an additive presentation shape. Current
ordinary single-path reviews may additionally carry `patch[].page` and
`presentation_progress`: repeated calls resume a contiguous UTF-8 byte cursor
only under the same bound-diff and redacted-stream hashes, up to 4 MiB, and
only a fully visible page advances. Current writes use the additive O(paths)
`page_count` / `receipt_sha256` accumulator (the latter is the recomputable
SHA-256 of `[0,next_byte)`) and retain only the latest page range/hash.
Historical full segment arrays remain strict-read compatible and
are compacted on the next page. Either semantic decision rebuilds the current
redacted streams and checks the exact stream and current-page slice. Historical
records omit these fields and remain readable; unfinished paging, malformed cursors and
historical partial presentations remain non-acceptable. The existing tool name, registration
order, and mode placement are unchanged; `REPAIR` and `repair_reason` are
additive current parameter-schema evolution. None of these fields grants Gate
authority.

Semantic repair starts are serialized by a project start lock whose owner is
bound to OS boot id, PID, and process-start identity. Authority is reconciled
both before and inside the lock, and the lock is retained through durable
`PREPARED` publication, closing sibling-start and pre-owner crash windows.
Reload, status, read-only Gate projection, formal Gate runs, and delegation
startup scan the bounded whole-project repair graph. Missing or tampered
decisions, forks, hidden unresolved work, plan/scope drift, unsafe execution
owners/journals, or unknown artifacts remain blocking. A lineaged `ABORTED`
record is not permission for an unrelated fresh delegation: only the exact
reported `repair_of=<aborted-id>` may continue it, and only when a known
before-write runtime reason, absent owner, pristine/missing journal, and exact
v2 inventory are all proven. A non-lineaged recovered abort remains ordinary
terminal FAIL compatibility data.

When an upgrade-era finalized mechanical record is still mirrored as
`PENDING_REVIEW`, the runtime preserves that fail-closed state and returns the
structured `semantic_acceptance_required` recovery result. Compatibility uses
a two-step `workbench_review_worker_diff` migration review: active Sol first
requests the complete immutable packet and a freshly collected migration
binding without a decision, then makes a second call with
`semantic_decision=ACCEPT`, `expected_bound_diff_hash`, and
`expected_migration_binding_hash`. Eligibility is intentionally narrow: the
candidate HEAD must descend from the old HEAD, its raw committed delta may
contain exactly the historical W/checked paths, every current W path must be
clean, and current W/D/S content plus the non-W baseline guard must still
match. Extra paths, content or mode drift, and non-descendant history fail
closed. Acceptance is an additive, hash-bound
supplement; the historical review and transaction bytes are not rewritten. A
fresh exact `repair_of` is forbidden for this recovery because it would adopt
the old non-semantic delta as a new baseline. An ordinary successor and VERIFY
remain blocked until the explicit Sol acceptance is durable.

The current review parameter-schema hash, including optional latest-id
presentation, explicit-id `ACCEPT|REPAIR`, the bounded repair reason, paired
bound hash, and historical migration binding, is
`75e16f08badfe5762541904d242e34121214d86ded0454067c9c28f40c2dd087`.

## Commander Token Optimization Slice A (P0 + P1) — additive compatibility

Slice A of `docs/plans/commander-token-optimization.md` (P0 session
observability + P1 bounded parent-result summaries) is additive and
backward compatible:

- **P0 observability adds new numeric facts, never changes old ones.** The
  commander/worker/other cost+token buckets mirroring Pi's footer
  aggregation are byte-for-byte unchanged; `commanderRequests`,
  `compactions` and the per-tool inline TEXT byte attribution are
  additional fields of the in-memory breakdown, and `/q-cost-status` gains
  compact numeric rows (counts, tool names, UTF-8 byte totals only — tool
  arguments are not inspected, and textual toolResult content is read
  solely to compute its UTF-8 byte length; it is never persisted,
  retained, or rendered). No
  persisted session/run record format changes and no migration: old
  records read unchanged.
- **P1 changes only the parent presentation.** `workbench_run_recipe` /
  `workbench_run_gate` tool results and `/q-run` / `/q-gate` output are now
  bounded machine-derived summaries (≤ 4096 bytes/40 lines success, ≤
  12288 bytes/120 lines failure, failure-first precedence, full-log paths)
  instead of inlined run output. The tool **parameter schemas are
  unchanged** (no schema-fingerprint change, unlike the P7
  `workbench_delegate_worker` transition above); run/gate records on disk
  (`manifest.json`, `summary.json`, `stdout.log`, `stderr.log`, `gates.json`,
  `evidence.json`) keep their schema and stay byte-for-byte unchanged —
  full evidence remains readable by old tooling and by the new code alike.
- Old run/session records, worker budget profiles/defaults, and the
  review/gate responsibilities are unchanged. Slice A is PASS: the final
  full `check` run `20260805-141013-i4lx` passed 879/879 and the
  Commander gates run `20260805-141242-tyt8` passed b0-b6. The recorded
  95.35% P1 reduction is an observational recipe-inline-byte-only figure
  (docs/baselines/commander-token-p0.md) — not causal and not overall
  savings; no benchmark savings are claimed before P9 measurement.

## Commander Token Optimization Slice B1 (P2 + P3) — additive compatibility

Slice B1 of `docs/plans/commander-token-optimization.md` (P2 layered
`workbench_read_run` results + the P3 read-only batching guideline) is
additive and backward compatible:

- **The `workbench_read_run` runtime default changed from `all` to
  `summary` (presentation only).** An omitted `include` now renders the
  ordered Summary/Evidence/Persisted layers (≤ 4096 UTF-8 bytes / 40
  lines, sanitized, code-point safe, never raw stdout/stderr, per-test
  lines, or argv, durable project-relative run-dir/manifest/summary/
  stdout/stderr paths, and a REQUIRED Evidence-layer logs/argv guidance
  line with the exact `include=logs`/`include=all` opt-in instruction
  for bounded tails that survives adversarial fields/lists and the
  caps; dropped optional cache/quant lines and bounded/truncated
  metadata/path/list displays are recorded in the aggregate with
  durable sources — machine facts are never silently lost). Explicit
  includes keep their semantics:
  `manifest` shows bounded manifest metadata (incl. cwd/argv) without
  tails; `logs`/`all` append the same caller-bounded log tails as before
  (default 200 lines / 20 KB per stream; schema-bounded
  max_lines/max_bytes honored). Run records on disk
  (`manifest.json`, `summary.json`, `stdout.log`, `stderr.log`, …) keep
  their schema and stay byte-for-byte unchanged; legacy records without
  the P6-C/P6-D optional fields render identically; the structured
  `details` payload (`ReadRunToolDetails`) is unchanged.
- **One intentional tool-metadata/schema-wording transition.**
  `workbench_read_run`'s description, promptSnippet, one added static
  prompt guideline (the read-only batching guideline — exactly one
  occurrence in the catalog) and the `include` parameter description now
  declare the summary default. The parameter **shape is unchanged** (the
  same `run_id` + optional `include|max_lines|max_bytes` keys, same
  types, same `summary|manifest|logs|all` union order — no parameter
  added or removed), but the description text is part of the hashed
  tool-schema/metadata, so this intentionally shifts the DEV/AUDIT/VERIFY
  tool-schema fingerprint exactly **once**, mirroring the documented
  Phase 3 `workbench_delegate_worker` transition above: cache telemetry
  records that one transition as `UNEXPECTED_DRIFT` — **expected, not a
  defect** — and after reload same-mode fingerprints are stable again.
- **Additive batching surface, no tool/order/mode change.**
  `INDEPENDENT_READ_ONLY_ALLOWLIST` (pure classifier in
  `core/run-result.ts`) contains exactly `read`/`grep`/`find`/`ls` and
  `workbench_project_inspect` / `workbench_read_run` /
  `workbench_read_gate` / `workbench_list_gates` /
  `workbench_compare_runs` — at the Slice B1 time point this was the same
  set as the AUDIT mode matrix (consistency, not a mode change); after P8b
  the AUDIT read-only set additionally includes
  `workbench_recover_tool_result`, deliberately NOT in this classifier
  (see the P8b section below); `workbench_delegation_status` and
  every execution/review/delegation/write tool are excluded, and the
  classifier never infers independence. Tool registration order, mode
  matrices, and the tool inventory are unchanged.
- Worker budget profiles/defaults, delegation/review responsibilities,
  and the durable plan document are unchanged; no benchmark savings are
  claimed before P9 measurement.

## Commander Token Optimization Slice B2 (P2 coverage-gated segmented actual-diff review) — additive compatibility

The bullets in this subsection preserve the historical Slice B2 transition.
They are not the current write contract: the current unreleased transition
above adds schema-2 semantic markers, paired `ACCEPT|REPAIR`/hash parameters,
the bounded REPAIR reason, and presentation completeness while keeping
historical schema-1 records readable. In particular, historical mechanical
`REVIEWED` is not current semantic acceptance.

- **Additive review-record fields, unchanged `schema_version`.** The
  completed `review.json` records now carry the Slice B2 coverage facts
  (`displayed_paths`, `remaining_paths`, `coverage_complete`, `review_path`)
  as additive fields on the unchanged `schema_version: 1` record shape.
  Legacy schema_version-1 review records without those fields remain
  readable by the new code (and by old tooling) and are never rewritten
  unless a new review segment is run; when they are merged into a new
  segment's coverage, prior coverage is inferred ONLY from their persisted
  patch entries — never invented. Rendering likewise recomputes
  displayed/remaining from the record's valid checked worker paths, so
  absent or malformed persisted coverage arrays or a persisted
  `coverage_complete` flag never render a false COMPLETE. The finish-time
  PENDING_REVIEW
  placeholder and corrupt/foreign records still read as "no review yet".
- **No tool/order/mode/schema change.** `workbench_review_worker_diff`
  keeps its registration position, its parameter schema (byte-identical —
  `include_paths` max 50, `max_lines`/`max_bytes` bounds and defaults 400
  lines / 32 KiB unchanged), and its DEV-only mode placement; the tool
  inventory, registration order, and mode matrices are unchanged. The
  review writes stay `review.json` plus the existing
  `workbench-delegation-state` custom entry — no other artifact, no
  migration, no rewrite of old records. The tool description/prompt
  wording is static text (no dynamic values) and now documents the
  repeatable coverage-gated lifecycle.
- **Lifecycle semantics are additive and fail-closed.** REVIEWED now
  requires scope PASS AND complete displayed-path coverage (a same-hash
  complete PASS rerender keeps a valid REVIEWED binding; a hash change
  resets coverage — this call's rendered paths stay displayed; ANY
  re-review of the same current diff that is not PASS with complete
  coverage — a scope FAIL or an incomplete PASS, e.g. a legacy partial
  review record — demotes a prior REVIEWED state to PENDING_REVIEW
  fail-closed via the pure
  `demoteReviewedToPending` transition). PENDING_REVIEW and VERIFY blocking,
  the hash-binding invariants, and B6 Worker-First Compliance remain
  unchanged. Current v2 adds one delegation-only recovery seam: exact latest
  STALE plus strict committed FINAL/PASS carrying explicit Sol semantic
  acceptance may be replaced by a fresh successor after live revalidation;
  the old authority remains immutable and all other stale authority stays
  blocked.
- **Phase 5 compact/withheld entries: additive record surface,
  unchanged schema and tool.** Review `schema_version` stays `1`; the
  `patch[].source` literals `compact` and `withheld` (mirrored in the
  per-path `patch_paths` stats) and the optional `patch[].compact`
  structured facts (git_status, size_bytes, digest, digest_kind,
  digest_max_bytes, digest_matches_after, generator_equality, the
  head/tail previews and their byte/line/window fields) are additive —
  legacy schema_version-1 review records without compact facts remain
  readable and are never migrated, and are rewritten only when a new
  review segment runs (the rewrite then carries the additive facts).
  `workbench_review_worker_diff` keeps its name, registration order,
  DEV-only mode placement and byte-identical parameter schema
  (`delegation_id` + optional `include_paths`/`max_lines`/`max_bytes`
  only — no compact or generated parameter), and the review writes stay
  `review.json` plus the existing `workbench-delegation-state` custom
  entry.
- **Compact selection is deterministic and internal; caps unchanged.**
  Eligibility is decided automatically by the review — a current
  regular `.svg`/`.json` worker path strictly larger than the 32 KiB
  default global byte cap — and never depends on the caller's
  `max_bytes`: a larger caller bound does not disable the compact form.
  The historical caller bounds were max_lines 1–2000 and max_bytes
  1–512000. Version 0.10.0 intentionally lowers the public and whole-result
  maxima to 400 lines / 32 KiB (include_paths remains max 50); ordinary/
  small/deleted/unreadable/non-regular paths keep
  the existing git-diff/content/deleted presentation, and generator
  execution is deliberately absent (`generator_equality` is always
  `NOT_VERIFIED`, so independent current-state regeneration/byte
  comparison remains required).
- **Invariants are not weakened; no savings claim.** Worker-first
  duties, the full scope check over every worker path, the current
  complete diff-hash binding, coverage completion, later-change STALE
  semantics and Gate duties are unchanged; scope-violating paths are
  withheld fail-closed (fixed bounded marker) yet still fail the
  verdict, and whole-diff facts still cover the complete actual worker
  diff. No measured efficiency percentage or benchmark claim is made
  here.
- **Worker delegation semantics, budgets/defaults, and the worker
  token-budget repair plan are untouched**; the durable commander plan
  records Slice A PASS, Slice B1 targeted verification, and Slice B2
  implementation with its review/targeted/final evidence PENDING until
  Sol runs it; no benchmark savings are claimed before P9 measurement.

## Commander Token Optimization P8b (two-phase tool-result receipt lifecycle) — additive compatibility

- **New repository-owned directory; nothing existing changes.** P8a added
  `.pi/workbench/tool-results/<id>.started` + `<id>.json` (schema `wtr1` /
  version 1) under the config dir — a new additive storage location. No
  existing record format changes: legacy run/cache/delegation/domain
  records and review/state entries are never read, migrated, or rewritten;
  unknown-schema or malformed receipts fail closed as corrupt and are
  never touched. Foreign files and temp leftovers in the receipt directory
  are ignored. Receipts never touch run/cache/gate/delegation artifacts or
  execution counts.
- **P8b additive tool transition (recovery appended LAST).** P8b wires the
  reviewed P8a core into the runtime: BEGIN at the END of the `tool_call`
  guard (after every policy check, before execution) for side-effecting
  recipe/gate/delegation/review tools; replay-safe inspect/read/list/status/
  compare/recovery tools bypass receipts; exact toolCallId +
  tool-name dual-match FINALIZE in the `tool_result` handler; capacity
  pre-block at `MAX_IN_FLIGHT_RECEIPTS` (256) with no eviction; and the new
  public read-only `workbench_recover_tool_result`. The inventory becomes
  **11 custom tools** with recovery appended LAST in the
  `WORKBENCH_TOOL_NAMES`/registration order — existing registration
  positions and parameter schemas are unchanged; the strict Sol DEV
  allowlist moves **14 → 15** and an ACTIVE user lease **15 → 17**
  (edit/write); AUDIT and VERIFY gain the recovery tool in their read-only
  sets. The recovery tool is deliberately NOT added to the existing
  read-only batching classifier (P8b boundary, tested). Appending the tool
  LAST is an intentional, one-time tool-metadata/schema fingerprint
  transition: cache telemetry records it as `UNEXPECTED_DRIFT` —
  **expected, not a defect** (documented stable-prefix behavior) — and
  after reload same-mode fingerprints are stable again; nothing is loaded
  dynamically.
- **Determinism is session-identity-scoped.** Receipt ids are deterministic
  (`wtr1-` + SHA-256 of bounded native Pi session identity + toolCallId):
  the same result id is derived deterministically only when the input pair
  is identical — the SAME valid native Pi session identity AND the SAME
  toolCallId. There is no stability guarantee across different native
  session IDs: different session IDs do NOT guarantee the same id, even
  when the toolCallId is identical. Recovery by `result_id` is
  session-independent; recovery by `tool_call_id` is current-session only
  (the current native session identity AND the parameter are validated
  before any hash — absent/invalid fails closed with the fixed `invalid`
  code). Recovery is strictly read-only (repeated reads change no bytes or
  mtimes) and never re-executes the original call.
- **No migration/domain rewrite.** P8b adds one new public tool and the
  receipt lifecycle; no existing record format, domain behavior, or
  execution count changes, no migration, and no rewrite of legacy records.
  Persisted receipts are presentation, never acceptance evidence.
- **Platform notes.** POSIX permission modes (directory 0700, artifacts
  0600) and symlink-containment behavior are exercised on POSIX platforms;
  the permission/symlink assertions are skipped on Windows, where
  containment is enforced by the same strict path/id validation and
  lstat-based artifact checks.
- **No transport claim.** This repository implements no WebSocket (or any
  other) transport — receipts are plain local files with no network path;
  the workbench owns no transport.

## NRO N1/N2 (Commander Native Tool Optimization) — additive compatibility

Slices N1+N2 of `docs/plans/commander-native-tool-optimization.md` (the
`read` deterministic-preview slice and the `grep` exact-count slice of the
Commander Native Tool Optimization (NRO) effort) are additive and backward
compatible:

- **Registration inventory: unchanged 11-tool catalog plus three same-name
  native overrides.** `WORKBENCH_TOOL_NAMES` stays at exactly **11 catalog
  tools in the unchanged order**. N1/N2 additionally registers three fixed
  same-name overrides of the Pi built-in `read`/`grep`/`find` tools,
  statically, in the fixed `read → grep → find` order BEFORE the catalog —
  the registration surface is exactly `NATIVE_OVERRIDE_NAMES` +
  `WORKBENCH_TOOL_NAMES` (14 `registerTool` blocks, pinned by the
  native-tool-wiring / diff-review-wiring / p5-inventory tests). Because
  the overrides replace the built-ins under the SAME names, the resolved
  tool list the model sees (names and order) is unchanged; mode matrices
  (AUDIT/DEV/VERIFY), the strict-Sol canonical 15-tool allowlist, the
  write-authority/lease inventories and `WORKBENCH_TOOL_NAMES` are
  unchanged. The one intentional tool-schema/metadata fingerprint
  transition — the single combined N1/N2 delta (read adds exactly the one
  §6.4 continuation/count guideline bullet; grep mirrors the same bullet,
  appends the static count-mode description sentence and the two optional
  count selectors; find keeps the built-in strings verbatim) — is recorded
  as `UNEXPECTED_DRIFT` — **expected, not a defect** — and same-mode
  fingerprints are stable again after reload (pinned in
  tests/p6-b-stable-prefix.test.ts).
- **Legacy parameter compatibility: old shapes and resumed calls stay
  valid.** `read` and `find` parameter schemas are byte-identical to the
  Pi 0.83.0 built-in schemas (read: `path` + optional `offset`/`limit`;
  find: `pattern`/`path`/`limit`); the grep schema keeps the byte-identical
  built-in property prefix (`pattern`/`path`/`glob`/`ignoreCase`/`literal`/
  `context`/`limit`) and appends exactly the two optional count selectors
  `output` (`"matches" | "count"`) and `count_kind` (`"matches" |
  "lines"`), so every legacy parameter shape and every old-session resumed
  call remains valid; P8 recovery replay is unaffected (dual tool-name +
  call-id matching). **Additive grep semantics:** omitted `output`,
  `output="matches"` and a `count_kind` without `output` delegate to
  `createGrepToolDefinition(ctx.cwd)` byte-for-byte (matching lines with
  paths/line numbers, context/limit/glob/ignoreCase/literal, `.gitignore`
  respect, the 500-char line cap and the `matchLimitReached`/
  `linesTruncated` details); `output="count"` runs the dedicated
  abort-aware ripgrep adapter (`core/native-search-adapter.ts`) over the
  full scan and returns ONE exact uncapped
  `count kind=<matches|lines> value=<n> files=<n>` line with `details`
  undefined — `count_kind` defaults to `matches` (occurrences), `lines`
  counts matching lines, `files` counts distinct matching files, the
  legacy `limit`/`context` never apply, zero is an exact result, and
  malformed framing, execution failure, abort (pre-abort or mid-scan,
  including Pi's timeout abort) or an unavailable rg fail explicitly —
  never a partial count. The adapter executes rg directly with an explicit
  argument vector and `shell:false` (no shell, no `pi.exec`, no
  download/write), resolving the managed rg first (`PI_CODING_AGENT_DIR`
  or `~/.pi/agent/bin/rg[.exe]`) and then the system rg on PATH, and
  parses the strict `path\0count\n` framing (`--with-filename --null`).
  `find` remains an exact legacy pass-through — `output`/`max_depth`
  (find count/depth, staged N3) and grep `output="files"` (staged N2b)
  are **NOT implemented**: no such parameters exist.
- **read result-shape rules.** A **text** read WITHOUT `offset`/`limit`
  returns either the complete file content byte-for-byte (the built-in's
  content) plus the deterministic frozen nine-fact `nro-read-facts:`
  trailer (`complete`, `returned_lines`, `returned_bytes`, `total_lines`,
  `total_bytes`, `omitted_lines`, `omitted_bytes`, `next_offset`,
  `line_truncated` — fixed order, single spaces, the exact form frozen in
  the NRO benchmark protocol §8.4), or — when the content exceeds the fixed
  static caps (240 lines / 12 KiB, 2048-byte per-line representation,
  code-point-safe) — a deterministic preview of the first
  `min(240 lines, 12 KiB)` cut at line boundaries plus the same facts
  line. `details` is undefined when complete and otherwise carries exactly
  a valid built-in `ReadToolDetails.truncation` object (a `TruncationResult`
  derived from the same facts, so the inherited built-in renderer shows its
  standard truncation warning); no additive `details` keys are ever added.
  Determinism: same file bytes + same caps → identical preview text and
  identical facts, independent of cwd/session/date; UTF-8-exact and
  code-point-safe byte accounting on the built-in's own line-counting basis
  (including the trailing-newline phantom-line handling).
- **Legacy `read` delegation stays byte-identical to Pi 0.83.0.** Every
  call with explicit `offset` and/or `limit`, every image read (attachment
  content + note; also the text-only built-in image note from a failed
  decode/resize or an unprocessed BMP — validated against the source's
  magic bytes and passed through byte-identically), every error
  (missing/unreadable file, `offset` beyond end) and abort (`"Operation
  aborted"`) delegates to the captured built-in
  `createReadToolDefinition(ctx.cwd)` execution path — content, `details`
  and error text byte-for-byte.
- **Only read-only second reads.** Beyond the delegated built-in path, the
  `read` override performs exactly two additional reads of the target file,
  both read-only, both through the policy module's Pi-equivalent path
  normalization (unicode-space normalization, leading-`@` strip, tilde
  expansion, `file://` handling, macOS AM/PM / NFD / curly-quote fallbacks
  — so `@`/relative/absolute parity with the built-in is preserved): the
  >50KB-first-line re-read (the built-in cannot return that content; the
  deterministic preview is built from the full text) and the image-note
  magic-byte sniff (≤ 4100 bytes). No writes, no shell, no `pi.exec`, no
  model calls.
- **`sourceInfo` provenance.** Overridden tools report the extension as
  their source in `pi.getAllTools()` instead of `builtin` (expected,
  documented consequence of same-name overriding); the underlying built-ins
  remain available in any session where the extension is not loaded.
- **NRO savings/adoption are NOT_MEASURED.** No token-savings or adoption
  claim is made for the N1/N2 surface; the NRO benchmark's arms and
  thresholds are pre-registered but unmeasured, and N4 (Commander-owned
  measurement/verdict) has not run.

## Tested environments

| Component | Version | How it was exercised |
| --------- | ------- | -------------------- |
| Pi released live baseline (`@earendil-works/pi-coding-agent`) | **0.83.0** | Historical v0.10.0 live `pi -a -p` print-mode and `pi --mode json -a -p` JSON-mode smoke runs; extension direct-load tests; the historical controlled-worker smoke used `deepseek/deepseek-v4-flash:max`. This row is retained release evidence, not the current devDependency. |
| Pi current source/test target (`@earendil-works/pi-coding-agent`) | **0.84.2** | Pinned current devDependency; native TypeScript compatibility plus repository tests and source-level lifecycle/API checks. This does not inherit the 0.83.0 live TUI/print/json matrix. |
| Pi TUI released live baseline (`@earendil-works/pi-tui`) | **0.83.0** | Historical status/widget/renderer component qualification for v0.10.0; a full interactive TUI session was not automated. |
| Pi TUI current source/test target (`@earendil-works/pi-tui`) | **0.84.2** | Pinned current devDependency and current component/test compilation; no new automated interactive TUI qualification is claimed. |
| Node.js released live baseline | **v24.13.0** | Historical v0.10.0 tests and smoke runs. |
| Node.js current local source verification | **v26.7.0** | This unreleased repair's local typecheck/test execution; CI is configured for Node 24.x but configuration is not a CI PASS claim. |
| npm released/current local | **11.18.0 / 12.0.2** | Historical release execution / this unreleased repair's local execution. |
| OS / kernel released/current local | **CachyOS Linux, 7.1.5-1-cachyos / 7.1.8-1-cachyos, x86_64** | Historical release environment / current local source verification environment. |
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
guesses. A normalized DeepSeek `cacheWrite = 0` remains non-error data, but
schema 1.3 status `1` correctly describes its write semantics as unavailable
rather than presence-verified zero. Controlled worker
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
  runtime. The released v0.10.0 live qualification baseline remains Pi/pi-tui
  0.83.0. Current source pins Pi/pi-tui 0.84.2 and is verified by native
  typecheck/repository tests plus the explicitly listed source audits and
  worker availability smoke; it has not inherited the older release's full
  interactive TUI/print/json qualification.
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
- The only released live-mode baseline is 0.83.0. Pi 0.84.2 is the current
  source/test target; its full interactive TUI/print/json release matrix is
  still not claimed.
- The P6 benchmark corpus is single-provider/single-model/single-mode
  (DEV) development work; it is not evidence of long-term savings — see
  [docs/cache/P6_BENCHMARK_REPORT.md](../docs/cache/P6_BENCHMARK_REPORT.md)
  Limitations.
- Offline projection/cache checks cannot guarantee a real provider
  `cacheRead`; the fake provider deliberately reports zero. After deployment,
  a new live session and verified subsequent provider usage are required
  before claiming cache-hit recovery.
