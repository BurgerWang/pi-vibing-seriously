# Context Output Control Plane v1

Version 0.10.0 makes model-visible tool output a bounded control-plane
resource. Full domain evidence stays in project artifacts; returned text and
session details are bounded presentations and are never acceptance evidence.

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

The final result envelope applies after tool execution and receipt handling,
so a renderer, error, or finalize path cannot enlarge the result again. A
turn planner reserves the role budget deterministically before execution and
blocks calls beyond the fixed call/budget limits.

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

## Active history and legacy migration

Before provider requests, the runtime validates assistant tool calls and tool
results as complete bundles. Below the hard ceiling it returns raw history
unchanged. Projection-state v3 reserves one raw role turn and 16 one-bundle
segment slots before sizing the fixed anchor:

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
anchor, its ordered immutable segments, and the raw active suffix. When the
active suffix exceeds either its byte or bundle reserve, the controller seals
only aged active material into one new segment of at most 384 tool-text bytes
and one complete bundle. Seals 1–16 keep the epoch, anchor, all older segments,
and their deterministic boundary markers byte-identical; only the active tail
is rewritten, and `segmentSealed` reports that expected event separately from
`epochTransitioned`. An attempt to create segment 17 instead triggers a
checkpoint that rebuilds the anchor, clears segments, and increments the
epoch. Invalid pairing
still fails closed instead of producing orphan calls.

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
existing signed `epochHash`. After JSONL restore, a repeated failure is
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
hash; an attempted 17th segment produces the expected epoch transition. A
normal appended suffix is not prefix divergence.

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
