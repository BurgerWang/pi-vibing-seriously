# Context Output Control Plane v1

Version 0.10.0 makes model-visible tool output a bounded control-plane
resource. Full domain evidence stays in project artifacts; returned text and
session details are bounded presentations and are never acceptance evidence.

The P0–P2 refinements below are Unreleased working-tree behavior. Their
presence here does not claim a commit, installation, or deployment.

## Fixed limits

| Surface | Limit |
| --- | --- |
| Native text `read` page | 12,288 UTF-8 bytes, 240 file lines, 252 total lines |
| `workbench_read_run` logs/all | 32,768 bytes and 400 lines shared by stdout + stderr |
| Diff review / compare | 32,768 bytes and 400 lines |
| Gate read | 24 KiB and 320 lines |
| Project inspect / gate list / recipe result | 16 KiB defense-in-depth |
| One new-session details value | 8 KiB |
| Commander / worker tool-result batch | 64 KiB / 48 KiB |
| Commander / worker active tool-result history | 96 KiB / 64 KiB |
| Active-history bundle count (all roles) | 128 complete bundles |

The final result envelope applies after tool execution and before receipt
finalization, so the receipt sees only final bounded content and a renderer,
error, or later details path cannot enlarge it again. A turn planner reserves
the role budget deterministically before execution and blocks calls beyond the
fixed call/budget limits.

## Paging and durable evidence

`read` v3 and log/gate readers return opaque, kind-specific continuation
cursors. A cursor binds the logical source, source snapshot, page position,
and view selectors; a changed source is stale and a cursor for another source
or kind is rejected. Treat cursor text as opaque and follow the returned
cursor. Legacy `read(path, offset, limit)` remains accepted, but uses the same
bounded pager and integer limits.

Real-file read and gate cursors minted by 0.10.0 use `wbcur2` / payload v2.
They retain the bounded v1 stat facts and add the exact bigint-stat `mtimeNs`
as a canonical decimal string, so a same-inode, same-size rewrite inside one
millisecond is stale. The old `wbcur1` / payload-v1 field set and canonical
decoder remain strict and unchanged. A v1 file cursor cannot prove the newer
high-resolution identity and therefore fails stale against a source for which
`mtimeNs` is available; callers should always use the newest opaque cursor
returned by the tool. Run-log cursors remain `wbcur1` but their opaque source
state hash now commits to each stream's `mtimeNs` when available.

Large logs are read by seek, not loaded as whole files. Compare persists a
complete content-bound record under `.pi/workbench/comparisons/`; review,
run, gate, and sanitizer artifacts remain the authoritative evidence. DTO
details contain counts, bounded paths, artifact pointers, output-envelope
facts, and receipt facts—never full reports, patches, logs, or gate arrays.

### Trusted recoverable ingress

Exactly six finalized sources can receive private recovery authority:

- `finalized_recipe_run` → a recipe run's `summary.json`;
- `executed_gate_run` → an executed gate run's `gates.json`;
- `immutable_comparison` → the immutable `comparison.json`;
- `completed_worker_report` → the durable `worker-report.md`;
- `finalized_run_page` → the selected run `manifest.json`, `stdout.log`, or
  `stderr.log`;
- `run_id_gate_page` → a run-id gate page backed by `gates.json`.

The source must be a regular in-project file no larger than 4 MiB. Authority
streams a SHA-256 from one no-follow descriptor, requires stable pre/post and
namespace stats, and binds content plus size/device/inode/`mtimeNs`/`ctimeNs`.
A symlink, path escape, missing/oversized source, or concurrent mutation gets
no authority and stays on the ordinary bounded path.

At or below 4,096 UTF-8 bytes, the exact provider text blocks are unchanged
and metadata records zero omission. Above 4,096 bytes, a deterministic wrapper
contains required facts, a bounded head/tail body, and the durable source
pointer. If the call allocation or generic envelope cannot preserve the
candidate, the final envelope is rebuilt from the original result and the
wrapper/metadata are removed together. Accounting consumes only that final
result. `workbench_read_gate` renders within its real per-call allocation
before advancing the cursor, so its complete semantic rows are lossless across
pages. Receipt finalization follows the envelope, and details projection then
adds only trusted side-channel metadata. Historical collapse strictly
validates that metadata and prefers the durable source path before a receipt or
legacy pointer. The implementation is identical for Commander, worker, and
other roles; only outer budgets differ.

## Active history and legacy migration

Before provider requests, the runtime validates assistant tool calls and tool
results as complete bundles. Below the hard ceiling it returns raw history
unchanged. Projection-state v3 uses one role turn and 16 one-bundle segment
slots to size the fixed anchor:

```text
anchorByteCap = max(0, hardToolTextBytes - roleTurnBytes - 16 * 384)
anchorBundleCap = max(0, 128 - 16 segments - 16 active bundles) = 96
```

Commander uses a 98,304-byte hard ceiling and 65,536-byte turn reserve, so its
anchor cap is 26,624 bytes. Worker/other uses 65,536 and 49,152 bytes, so its
anchor cap is 10,240 bytes. At the initial checkpoint the controller chooses
the largest latest raw suffix that fits the role turn and 16 bundles at a
complete-bundle boundary, projects the preceding history into the anchor, and
leaves that suffix raw.

Every later request in the same state reconstructs the exact provider-visible
anchor, its ordered immutable segments, and the raw active suffix. The
role-turn and 16-bundle values are suffix-selection reserves, not independent
seal thresholds: crossing either alone while the complete reconstruction is
still under both hard limits returns byte-identical history and event `none`.
Only a true hard byte/bundle crossing seals aged active material into one new
segment of at most 384 tool-text bytes and one complete bundle. Seals 1–16 keep
the epoch, anchor, all older segments, and their deterministic boundary markers
byte-identical; only the active tail is rewritten, and `segmentSealed` reports
that expected event separately from `epochTransitioned`. A later true hard
crossing that would create segment 17 performs the deterministic, model-free
safety checkpoint: rebuild the anchor, clear segments, and increment the epoch.
Invalid pairing still fails closed instead of producing orphan calls.

The anchor and each immutable segment end in a bounded hidden marker with a
safe `boundaryId` derived only from projected/provider-visible structure, never
raw secret text. The exact marker strings and IDs are exposed to the provider
hook; old markers cannot change before a checkpoint.

Reload/resume restores only an exact, strict numeric/hash-only
`workbench-history-projection-state-v3` record, bounded to 32 KiB. Every slice
is reconstructed from raw JSONL and checked against its exact counts, bytes,
bundles, hashes, chain, and contiguous boundaries. The newest recognized state
entry or structurally unsafe newer candidate is authoritative: a malformed
matching state, Proxy/revoked Proxy, or `customType`/`data` accessor fails closed
without executing traps rather than falling back to an older valid entry. A
safely unrelated plain entry may still be skipped. Strict v1 and v2 records are
accepted only as migration sources for monotonic epoch and pressure; their
topology and hashes are never reused. If current history is under the cap, the
first post-restore request remains raw but emits one `legacy_migration`
boundary, then persists inactive v3 so a reload cannot repeat it. Branch
changes and completed compaction reset the boundary.

An inactive v3 state also carries a fixed non-secret failure sentinel in its
existing `epochHash`; the unkeyed `stateHash` integrity coverage includes that
value. After JSONL restore, a repeated failure is
de-duplicated; the first healthy projection emits one fixed recovery boundary,
and later healthy projections emit none. Neither boundary derives from raw
hostile content and no schema key is added.

History hashes follow the Pi JSONL/provider boundary: undefined object members
are omitted, array holes or undefined entries hash as `null`, and object keys
follow JSON property enumeration order. Strings are lossless exact UTF-16 code
units, so lone surrogates cannot collide with U+FFFD. Only direct message
metadata (`timestamp`, `details`, `usage`, `diagnostics`) is ignored.
Provider-visible roles, content, tool call ids/names/arguments, result text and
images, error state, and added-tool fields remain in the hash; an identically
named nested field is not ignored. Canonical work is bounded to 32,768 array
elements, 128 nesting levels, 32,769 descriptors per container, and 262,144
work units. Proxy/accessor/custom-`toJSON`/cyclic/non-plain or over-budget input
fails closed without invoking application code.

Cache telemetry distinguishes the initial/checkpoint epoch transition from a
segment seal. Seals 1–16 are expected active-tail rewrites with a stable epoch
hash; the later hard crossing at the 16-segment safety ceiling produces the
expected epoch transition. A normal appended suffix—including reserve-only
growth—is not prefix divergence.

### Strict cache observability (schema 1.3)

Each eligible request is correlated as the exact sequence of one `context`
projection, one local `before_provider_request` observation, and one assistant
`message_end`. `requestCorrelationCode` is `1` only for that exact sequence;
`0` means unwired, `2` means multiple/stale/invalid, and `3` means missing.
Codes `0`/`2`/`3` must carry `actorRoleCode: 0` and
`historyProjection: null`. Exact rows may identify Commander (`1`) or worker
(`2`), with `0` retained only when the exact actor is genuinely unknown.

The `wireObservation` is content-free and local. Its `finalityCode` is always
`0`, so it is **not** evidence of the final actual provider wire. It records a
bounded structural digest status, API-shape code, relationship code, item
count, and longest common prefix measured only in complete payload items plus
their UTF-8 bytes. It never claims a partial-item or token-level match.

Projection anatomy is numeric-only. Core event names map in order to codes:
`none` (0), `initial_hard_projection` (1), `segment_seal` (2),
`epoch_checkpoint` (3), `inactive_boundary` (4), `fixed_failure` (5), and
`recovery_boundary` (6). Causes map to `none` (0), `initial_hard_limit` (1),
`hard_bytes` (2), `hard_bundles` (3), `segment_sealed` (4),
`prefix_changed` (5), `policy_changed` (6), `legacy_migration` (7),
`failure` (8), and `recovery` (9). The record also carries exact hard caps,
byte/bundle overflow at the decision, segments before/after, raw/projected
totals, stable and active slices before the decision, aged raw/projected
material, retained raw suffix, epoch transition, and seal flags. A slice field
is zero only when structurally inapplicable.

The numeric enums are semantically strict. Allowed event/cause pairs are
`0:0`, `1:1`, `2:4`, `3:{2,3,5,6,7}`, `4:{5,6,7}`, `5:8`, and `6:9`, with
matching overflow, epoch, seal, and segment-transition invariants. Impossible
anatomy fails correlation closed instead of becoming actor evidence.

Usage shares use the disjoint denominator
`promptInputTokens = input + cacheRead + cacheWrite`:
`cacheReadShare = cacheRead / promptInputTokens`, while
`cacheWriteShare = cacheWrite / promptInputTokens` is available separately
only when write semantics allow it. `cacheWriteStatusCode` is `0` unverified,
`1` unavailable for DeepSeek Completions, `2` normalized absence-or-zero for
Responses, and `3` reserved for presence-verified evidence; current emitters do
not fabricate code `3`. Report quality codes are `0` empty, `1` complete
verified all-1.3 evidence, `2` mixed legacy/1.3, `3` partial or schema-invalid,
`4` bounded/truncated, `5` usage semantics unverified, and `6` write semantics
unavailable/unverified. Code `7` (`aggregate_overflow`) means an exact
aggregate exceeds the safe numeric publication surface and forces both shares
to `null`. Reports separate Commander and worker cohorts plus
segment-seal and epoch-transition cohorts; ambiguous rows stay in `unknown`.

Request observations are one-shot: one context plus one local payload is
consumed by one assistant `message_end`; extras become ambiguous, missing
events become missing, and session restore/identity change clears pending
state. Doctor inspection never invokes Proxy traps or accessors; hostile or
exotic rows make the evidence partial and suppress clean conclusions.

At turn end the runtime also publishes one strict numeric custom entry for
companion diagnostics. Its custom type and `schema` are both
`workbench-context-pressure-v1`, and its data has exactly these nine fields:
`schema`, `role`, `epoch`, `rawToolTextBytes`, `projectedToolTextBytes`,
`rawBundleCount`, `hardHistoryBytes`, `hardBundleCount`, and `timestampMs`.
It contains no message text. Pi 0.83 `getContextUsage()` already estimates the
raw session messages before provider-view projection, so this entry is only an
epoch/churn and raw-versus-projected diagnostic. A companion must not convert
`rawToolTextBytes - projectedToolTextBytes` into supplemental tokens or add it
to Pi's usage; automatic thresholds depend on Pi's raw-session usage alone.
This workbench only publishes the facts; the companion `pi-auto-compact` source
is maintained in a separate repository and must apply its own strict parsing,
post-compaction staleness, and model thresholds. Updating this repository does
**not** deploy that companion source into a live Pi configuration. Projection
state v3 does not add a tenth field or change this diagnostic wire contract.

Provider-visible boundary markers are not themselves proof of cache reuse.
Public OpenAI explicit breakpoint fields are inserted only for exact public
`openai` / `openai-responses` / `gpt-5.6*` traffic with an existing
`prompt_cache_key`. The `openai-codex` path remains disabled until live SSE and
WebSocket probes both establish acceptance without a provider 400; DeepSeek
remains a strict injection no-op while still receiving the stable segmented
prompt.

OpenAI's documented practice is an exact prefix with static content first and
variable content last, a consistent cache key, at most four new cache writes
per request, reads from up to the latest 50 breakpoint candidates, and roughly
15 requests/minute per key. Measure `cached_tokens` and
`cache_write_tokens`; the 17 logical anchor/segment markers are not 17 writes
per request. The primary-source synthesis for both Commander and worker is an
immutable fixed anchor, modular immutable segments, and rare checkpoints. Only
verified provider `cacheRead` usage is authoritative, and the offline fake
provider intentionally reports zero. See the
[stable-prefix contract](cache/stable-prefix-contract.md) for primary sources.

The [DeepSeek Harness audit at pinned commit
`47f943859bef60e4160492346772ded9b24f765a`](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a)
supports the client-side principles of append-only reusable prefixes,
deterministic bounded summaries, and keeping durable evidence outside the
model-visible surface. Its MLA-serving behavior, scheduler, and disk-KV/block
ownership are not transferable to this Pi extension and none of its measured
numbers is a workbench benchmark promise.

Warm-prefix auxiliary compaction is
`BLOCKED_BY_PI_0_83_PUBLIC_API`. Pi 0.83's public
[`session_before_compact` surface](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md)
allows cancellation or replacement of the compaction result, but no
post-summary payload transform and no same-cache-domain guarantee are exposed.
Implementing a separate summarizer would require duplicating private
authentication, headers, streaming, retry, and provider-call behavior, which
this workbench deliberately does not do. Built-in/native Pi compaction remains
unchanged.

Pi clones legacy entries before a runtime context hook can shrink their clone
peak. Create a separate safe session copy first:

```text
npm run session:sanitize -- --input <session.jsonl> --output <new-session.jsonl> [--collapse-content]
```

The command streams the source, refuses non-regular/changed/oversized input,
uses exclusive mode-0600 output and manifest files, preserves the session
tree, records before/after hashes, and never edits or activates the source.

## Operations and evidence

Use `/q-context-output-status` for the current numeric-only enforcement
snapshot (bytes shown/omitted, truncations, blocked calls, history collapse,
and worker facts). Telemetry custom entries contain numbers and bounded reason
codes only; they never persist raw tool text.

Release verification uses these declared recipes:

- `context-output-core-test` and `context-output-integration-test` for focused
  feedback (cached results are not final evidence);
- `context-output-stress` for uncached hard-cap, RSS, history, worker, and
  sanitizer evidence at
  `.pi/workbench/runs/context-output-stress/context-output-evidence.json`;
- `context-output-benchmark` for the nine-scenario offline report at
  `.pi/workbench/runs/context-output-benchmark/context-output-benchmark.json`.

Run the final tree's `base` or `all` gate first so b1/b2/b3 are current, then
run `ctx1`; do not use an earlier standalone `ctx1` run as prerequisite
evidence. The benchmark summary is observational, not acceptance evidence.
Offline projection tests, stress evidence, and cache reports can prove the
structural contract but cannot guarantee a provider-issued `cacheRead`. After
deploying the runtime, use a new session and observe subsequent live requests;
only verified provider usage can establish whether cache reuse recovered.
The stable-prefix transition and canonical old/new hashes are recorded in
[the stable-prefix contract](cache/stable-prefix-contract.md).

The formal stress session uses a temporary trusted project and temporary
telemetry sink. Its test verifies that repository current/rotated telemetry
hashes do not change. The repair does not delete the 300 pre-existing fake
historical records found during audit; destructive retention cleanup remains a
separate, explicitly authorized operation.

## Compatibility

Old run manifests, review records, receipts, and session JSONL remain
readable. The compare artifact is additive. Internal details fields such as
full `record`, `report`, and `gates_full` are intentionally removed; consumers
must use bounded DTOs and artifact pointers. Reloading 0.10.0 intentionally
invalidates the old tool-schema cache prefix once, after which same-mode
static fingerprints remain deterministic.
