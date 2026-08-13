# Compatibility

Tested-environment matrix for **pi-dev-workbench v0.10.0 (Context Output Control Plane)**. Only
environments that were actually exercised are listed; no untested
compatibility is claimed. The machine-readable copy lives in
[`compatibility/pi.json`](../compatibility/pi.json).

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

The public tool schema/metadata intentionally changes once in 0.10.0. Old
prompt-cache prefixes are cold after reload; repeated same-mode static
fingerprints remain deterministic. Internal full `record`, `report`, and
`gates_full` details are not a compatibility surface and are replaced by
bounded DTOs plus persisted artifact pointers. See
[`context-output-control-plane.md`](context-output-control-plane.md) and the
[stable-prefix transition](cache/stable-prefix-contract.md). No Pi version
other than the matrix below is newly claimed by this release.

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

## Tool-schema fingerprint transition (Phase 4A, worker repair contract — `repair_of` pointer)

`workbench_delegate_worker` gained exactly ONE additive parameter in Phase
4A of the worker token-budget repair (public schema shape plus strict
runtime resolution and the finished-ledger guard): the optional `repair_of`
strict prior delegation-id provenance pointer — exactly 20 characters,
`^\d{8}-\d{6}-[A-Za-z0-9]{4}$` — used only for known-root-cause repairs
whose bounded root-cause/failure evidence the parent task itself carries.
The change is additive and intentionally changes the DEV tool-schema
fingerprint exactly **once**:

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

The pointer is provenance only: the runtime verifies the referenced prior
delegation ledger is finished (manifest status `finished` with a non-null
`after` record) before any new ledger is created or any worker is
launched, inspects only those id/status/after facts, and the fresh worker
inherits no prior report/session/scope/contract — `repair_of` adds no
path/scope/authority.

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
  `demoteReviewedToPending` transition). PENDING_REVIEW / STALE blocking
  semantics, the hash-binding invariants, delegation/VERIFY blocking and
  B6 Worker-First Compliance are unchanged for every reachable state.
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
  guard (after every policy check, before execution) for every registered
  workbench tool except the public recovery tool; exact toolCallId +
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
