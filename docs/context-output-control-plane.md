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

Before provider requests, the runtime validates assistant tool calls and
tool results as complete bundles. It protects the newest bundles, collapses
older complete bundles to bounded descriptors, and removes only whole bundles
when needed. Invalid pairing fails closed instead of producing orphan calls.
Worker requests pass through the same protection with the worker limits.

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
The stable-prefix transition and canonical old/new hashes are recorded in
[the stable-prefix contract](cache/stable-prefix-contract.md).

## Compatibility

Old run manifests, review records, receipts, and session JSONL remain
readable. The compare artifact is additive. Internal details fields such as
full `record`, `report`, and `gates_full` are intentionally removed; consumers
must use bounded DTOs and artifact pointers. Reloading 0.10.0 intentionally
invalidates the old tool-schema cache prefix once, after which same-mode
static fingerprints remain deterministic.
