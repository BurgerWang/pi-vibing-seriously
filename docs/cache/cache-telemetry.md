# Cache Telemetry (P6-A)

Observability for DeepSeek's prompt cache in the workbench. P6-A records
hash-only telemetry of usage and context stability and infers why the cache
missed. The telemetry component does not change requests, control the cache, or
cache anything itself; the independently gated provider hook runs before the
telemetry digest described below.

## Scope and non-goals

- **Telemetry remains observation-only.** No cache warming, TTL control,
  `cache_control`/`prompt_cache_key`/keepalive, or headers mutation. The
  separate v3 provider hook may return a copy-on-write payload containing only
  exact explicit-breakpoint fields on the proven public OpenAI GPT-5.6
  Responses shape; every unsupported or uncertain path is identity-exact.
- **No Recipe Action Cache in P6-A.** Recipe results are never cached.
- **No new Agent, daemon, gateway, or background service.** Everything runs
  inside the existing Pi extension on Pi-native events.

## Events used (all Pi-native)

| Event | Workbench behavior |
| ----- | ------------------ |
| `session_start` | restore the session cache summary (custom entry `workbench-cache-state`); classify `reload`/`new` reasons |
| `model_select` | remember the model; the next request is inferred `MODEL_CHANGED` |
| `thinking_level_select` | remember the level; next request is inferred `THINKING_LEVEL_CHANGED` |
| `before_provider_request` | capability-gated copy-on-write breakpoint transform, then a structural digest of the actual outgoing payload (roles, lengths, per-segment SHA-256, tool names); headers remain unchanged |
| `message_end` | **assistant messages only**: read normalized usage, hash system prompt + tools + payload shape, classify the invalidation, append one JSONL record |
| `session_before_compact` | the next request is inferred `COMPACTION` |
| `session_tree` | after Pi completes tree navigation, the next request is inferred `SESSION_TREE_CHANGED` exactly once |
| `session_shutdown` | safe flush of the session state entry |

The context-output projector reports v3 epoch/checkpoint and segment-seal
signals separately. Commander reserves a 65,536-byte raw turn inside its
98,304-byte hard ceiling; worker/other reserves 49,152 inside 65,536. After
also reserving sixteen 384-byte/one-bundle segments, their anchor caps are
26,624/10,240 bytes and 96 bundles; the active raw suffix is capped at 16
bundles.

The initial checkpoint establishes the anchor and epoch. Seals 1–16 append one
immutable segment while leaving the epoch hash, anchor, older segments, and
safe boundary markers unchanged; telemetry treats `segmentSealed` /
`segment_sealed` as an expected active-tail rewrite, not
`HISTORY_PROJECTION_EPOCH_CHANGED`. An attempt to create segment 17 triggers a
checkpoint that rebuilds the anchor, clears the chain, and increments the
epoch. Replaying the
same topology with an appended raw suffix creates neither event.

The companion pressure signal is unchanged by projection-state v3. Its custom
type and `data.schema` are `workbench-context-pressure-v1`, and its data object
still has exactly nine fields: `schema`, `role`, `epoch`,
`rawToolTextBytes`, `projectedToolTextBytes`, `rawBundleCount`,
`hardHistoryBytes`, `hardBundleCount`, and `timestampMs`. It is numeric
diagnostic evidence only; it neither changes provider usage nor establishes a
cache hit. This workbench update requires no auto-compaction code change and
does not install or deploy the separate companion.

Provider breakpoint integration is independent of P6-A's read-only digest.
Public OpenAI explicit breakpoints are optional and capability-gated to a
documented supported request shape: exact public `openai` /
`openai-responses` / `gpt-5.6*` traffic with an existing
`prompt_cache_key`. `openai-codex` remains disabled pending successful live SSE
and WebSocket probes; DeepSeek injection is a strict no-op while still
receiving the stable segmented prompt.

Telemetry failures are caught everywhere: they can never block, delay, or
modify a model request, and they never throw into Pi.

## Storage

Project-scoped, under `CONFIG_DIR_NAME` (Pi's official export — never
hardcoded):

```
<project-root>/.pi/workbench/cache/telemetry.jsonl   (append-only, rotated)
<project-root>/.pi/workbench/cache/telemetry.N.jsonl (rotated archives)
<project-root>/.pi/workbench/cache/reports/          (/q-cache-report --save)
```

- Append-only JSONL, one record per line.
- Rotation: when `telemetry.jsonl` exceeds 5 MB it becomes
  `telemetry.1.jsonl` and older archives shift; at most 5 archives are kept
  (oldest dropped) — the directory never grows without bound.
- Corrupted lines are skipped and counted on read, never fatal.
- Report files are written atomically (tmp + rename) and names are
  sanitized; the resolved path is verified to stay inside `reports/`.
- Files are created with user-only modes (`0o600`/`0o700`).
- `.pi/workbench/cache/` is gitignored (like `runs/`) and existing
  `.gitignore` rules are never overwritten.
- **Opt-out**: `cache: { telemetry: false }` in `project.yaml` disables
  recording (default: enabled).

## Record schema (`schemaVersion: "1.2"`)

```jsonc
{
  "schemaVersion": "1.2",
  "timestamp": "2026-01-15T09:30:00.000Z",
  "extensionVersion": "0.10.0",
  "hashedSessionId": "e3b0c44298fc1c14",       // SHA-256(session id), first 16 hex
  "provider": "deepseek",
  "model": "deepseek-v4-flash",
  "apiKind": "openai-completions",             // from model metadata when available
  "thinkingLevel": "high",
  "workbenchMode": "VERIFY",
  "messageStatus": "ok",                        // ok | error
  "usage": {
    "input": 10000,                             // un-cached input tokens
    "output": 500,
    "cacheRead": 40000,
    "cacheWrite": 0,
    "totalTokens": 50500,
    "cost": 0.001234                            // Pi usage.cost.total — the cost fact
  },
  "usageSemanticStatus": "verified",            // verified | partial | unverified
  "cacheHitRatio": 0.8,                         // cacheRead/(input+cacheRead); null if unverified or zero denominator
  "systemPromptHash": "…",                      // SHA-256 of the system prompt string
  "activeToolNamesHash": "…",                   // hash of active tool names (set)
  "activeToolOrderHash": "…",                   // hash of active tool names (order)
  "activeToolSchemaHash": "…",                  // hash of {name, description, parameters, promptGuidelines}
  "contextShapeHash": "…",                      // hash of the payload structure digest
  "precedingEvent": "before_provider_request",
  "inferredInvalidationReason": "UNEXPECTED_DRIFT",
  "inferenceConfidence": "medium",   // high | medium | low
  "driftSource": "TOOL_SET"          // SYSTEM_PROMPT | TOOL_SET | TOOL_ORDER | TOOL_SCHEMA | null
}
```

`usageSemanticStatus` rules:

- `verified` — api kind is one of the kinds whose normalized semantics are
  confirmed in the installed Pi source (`openai-completions`,
  `openai-responses`, `azure-openai-responses`, `openai-codex-responses`,
  `anthropic-messages`) AND all usage fields are finite, non-negative and
  `totalTokens` is consistent. `openai-codex-responses` (Pi's Codex
  provider, e.g. GPT-5.6 Sol) streams through the same
  `openai-responses-shared` normalization as the other Responses kinds, so
  `usage.input` is the un-cached input there too.
- `partial` — structure looks right but the api kind is not in the verified
  set: the ratio is `null`.
- `unverified` — missing/invalid usage, inconsistent totals, or a durable
  `precedingEvent: "telemetry_write_gap"` marker after one or more failed
  JSONL appends: the ratio is `null`. The workbench never guesses.

`cacheWrite = 0` (DeepSeek reports no cache writes) does not affect the
semantic status.

## Invalidation reasons (inferred)

`FIRST_OBSERVED_REQUEST`, `NEW_SESSION`, `MODEL_CHANGED`,
`THINKING_LEVEL_CHANGED`, `MODE_CHANGED`, `UNEXPECTED_DRIFT`,
`PACKAGE_RELOADED`, `COMPACTION`, `SESSION_TREE_CHANGED`,
`HISTORY_PROJECTION_EPOCH_CHANGED`, `HISTORY_PROJECTION_SEGMENT_SEALED`,
`CONTEXT_PREFIX_DIVERGED`,
`PROVIDER_BEST_EFFORT_MISS`, `UNKNOWN`.

P6-B: same-mode drift (system prompt / tool set / tool order / tool schema
changed without a lifecycle event) is recorded as **`UNEXPECTED_DRIFT`**
with the specific source in **`driftSource`**. The P6-A specific reasons
(`SYSTEM_PROMPT_CHANGED`, `TOOL_SET_CHANGED`, `TOOL_ORDER_CHANGED`,
`TOOL_SCHEMA_CHANGED`) are still recognized when reading schemaVersion 1.0
records but are no longer produced by new records.

Classification is a priority chain: explicit events (model/thinking/mode/
reload/compaction/session-tree/history-projection epoch or segment/new-session) >
same-mode drift (`UNEXPECTED_DRIFT`) > payload-prefix rewrite > provider-side
best-effort miss (stable context but zero cache read). An exact unchanged
payload and a payload that only appends messages are distinct from a prefix
rewrite, so a normal chat/tool continuation is not labeled
`CONTEXT_PREFIX_DIVERGED`. A completed tree navigation consumes its explicit
marker on the next recorded request; later unattributed rewrites still report
`CONTEXT_PREFIX_DIVERGED`. Reports always label these reasons `inferred`.

## Commands

- `/q-cache-status` — current session: provider/model, api kind, mode,
  thinking level, request count, input/cacheRead/output, reported cost
  (`usage.cost.total`), the **last-request ratio** and **cumulative session
  ratio** as separate labels (each N/A when its semantics are not verified),
  and the last inferred invalidation.
- `/q-cache-report [session|project] [--save <name>]` — aggregation over the
  bounded chronological telemetry window (rotated archives oldest-first,
  then the current file; newest 100,000 valid records retained), optionally
  filtered by hashed session id: request count, by-mode and by-model totals,
  tokens and cost, hit ratio, change counts, expected invalidations vs
  unexpected drifts, and estimated avoided cost (only when the model registry
  provides compatible cost metadata for every record). The report prints
  data quality and intentionally omitted oldest-record counts. A corrupt or
  unreadable source makes the aggregate ratio N/A instead of presenting a
  partial total as complete. Intentional bounded-window truncation is labeled
  separately and, by itself, retains the existing overall `hitRatio` over the
  retained records; that value is explicitly a bounded-window ratio, not a
  whole-history claim.

  The report and its saved JSON expose four record-derived projection and
  breakpoint facts:

  - `historyProjectionSegmentSeals` — count of retained records whose reason
    is exactly `HISTORY_PROJECTION_SEGMENT_SEALED`.
  - `historyProjectionEpochTransitions` — count whose reason is exactly
    `HISTORY_PROJECTION_EPOCH_CHANGED`.
  - `explicitBreakpointAppliedRequests` — count whose `precedingEvent` is
    exactly `explicit_prompt_cache_breakpoints_applied`.
  - `explicitBreakpointVerifiedUsage` — numeric-only
    `{ requestCount, input, cacheRead, cacheWrite, hitRatio }` over that
    applied-request subset. Usage is included only for the exact eligible
    public `openai` + `openai-responses` + `gpt-5.6*` shape with
    `usageSemanticStatus === "verified"` and `messageStatus === "ok"`. An
    errored applied request remains counted by
    `explicitBreakpointAppliedRequests` but contributes no verified usage. The
    subset ratio is `cacheRead / (input + cacheRead)` and is `null` when there
    is no verified applied request, the denominator is zero, or the observation
    is incomplete, including intentionally truncated bounded windows. This
    stricter subset does not change the overall bounded-window ratio above.

  These are retained-record observations only. They never persist or render
  boundary material or request content, and they do not establish a measured
  cache improvement.
- `/q-cache-doctor [json]` — health checks: usage validity, cost metadata,
  models.json/auth.json non-involvement, system prompt dynamics, current
  prefix hashes (`prefix_hashes`), same-mode drift (`same_mode_drift`),
  expected vs unexpected counts, projection lifecycle counts
  (`history_projection_events`), explicit-breakpoint usage
  (`explicit_breakpoint_usage`), churn (model/thinking/mode/reload/
  compaction), tool-metadata statics, forbidden telemetry fields, and the
  total size of the current-plus-rotated telemetry set. The doctor uses the
  same bounded chronological read as the report: oldest rotated archive to
  current file, retaining the newest 100,000 valid records. Text and JSON
  output expose files read, skipped/corrupt records, bounded oldest records
  omitted, any unavailable source, and durable telemetry-write-gap markers.
  Corrupt, unreadable, truncated, or write-gapped evidence is
  `PARTIAL`/warning evidence: retained defects can still be reported, but the
  doctor must not emit a clean whole-history or no-drift conclusion from an
  incomplete window.

  `history_projection_events` reports segment-seal and epoch-transition
  counts. `explicit_breakpoint_usage` derives eligibility and usage only from
  actual records: complete, verified public OpenAI GPT-5.6 Responses applied
  records can be `ok`, including the valid observation `cacheRead = 0`. With
  complete evidence but no applied record, default-disabled Codex or
  unsupported DeepSeek traffic is `skip`, not a failure. Partial, corrupt,
  unreadable, write-gapped, or intentionally truncated evidence makes both
  checks `warn`; the applied subset ratio is `N/A` in text and `null` in doctor
  JSON. Doctor JSON includes numeric `erroredEligibleAppliedRequests`; any
  eligible applied record with `messageStatus = "error"` makes the check warn,
  excludes its usage from the verified subset, and cannot produce an OK or
  authoritative-usage statement. The JSON adds only numeric
  `history_projection` and `explicit_breakpoints` summaries.

  OpenAI's documented operating guidance is exact-prefix matching, static
  content first and variable content last, a consistent `prompt_cache_key`, at
  most four new cache writes per request, reads from up to the latest 50
  breakpoint candidates, and approximately 15 requests/minute per cache key.
  Inspect `cached_tokens` and `cache_write_tokens` to distinguish reuse from
  repeated writes. The workbench's maximum 17 logical anchor/segment markers
  therefore do not imply 17 writes on one request. See the
  [stable-prefix contract](stable-prefix-contract.md) for primary sources and
  the immutable-anchor/modular-segment/rare-checkpoint design shared by
  Commander and worker.

## Session state entry

A lightweight Pi custom entry (`customType: workbench-cache-state`) holds
only: `schemaVersion`, `hashedSessionId`, `requestCount`, aggregate usage and
its semantic status, a strict `telemetryWriteGapPending` 0/1 flag, last hashes,
last invalidation reason, and the telemetry file reference. The bounded flag
survives restart and is cleared only after the next JSONL record durably marks
`precedingEvent: "telemetry_write_gap"`. Legacy 1.0/1.1 state without the flag
restores it as 0; a general `unverified` status never fabricates a write gap.
State is restored on `session_start` so request accounting, hash baselines, and
pending gap honesty survive compaction, resume, fork, and reload. No message
bodies and no large arrays are ever stored in it.

## Footer status

When the data is valid the workbench footer appends a compact segment (the
Pi footer itself is never replaced). It labels the latest request separately
from the cumulative session totals:

```
CACHE last=72% cum=68% | read 184k | miss 71k
```

Either ratio is `N/A` when its usage semantics are not verified or its
input-plus-cache-read denominator is zero. In particular, a restored legacy
aggregate without verified semantic provenance never receives a fabricated
cumulative ratio. Nothing is shown before the first request, in print/json
modes, or when telemetry is disabled.

## Formal-stress isolation and existing history

The context-output formal stress recipe now runs its real `AgentSession` in a
temporary trusted project and writes all deterministic fake-provider telemetry
there. The stress test fingerprints the repository's current and rotated
telemetry files before and after the run and requires them to be unchanged.

This prevention is deliberately non-destructive. The **300 deterministic fake
historical records** identified in this checkout during the repair are not
deleted or rewritten. Any cleanup is a separate operator action that requires
an explicit retention decision; reports continue to expose data-quality and
scope so old data is not silently hidden.

`cacheRead` mapped from verified provider usage is the cache-hit authority;
structural hashes and inferred invalidation reasons are diagnostics, not a
substitute. The offline fake provider deliberately reports `cacheRead = 0`, so
offline telemetry and projection tests cannot prove reuse or a hit-rate gain.
After deploying the runtime, start a new session and inspect subsequent live
requests with `/q-cache-status` or `/q-cache-report` before drawing a recovery
conclusion.
