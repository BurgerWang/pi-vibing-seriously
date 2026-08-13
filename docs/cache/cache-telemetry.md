# Cache Telemetry (P6-A)

Observability for DeepSeek's prompt cache in the workbench. P6-A records
hash-only telemetry of usage and context stability and infers why the cache
missed — it does not change any request, does not control the cache, and
does not cache anything itself.

## Scope and non-goals

- **Observation only.** No cache warming, no TTL control, no
  `cache_control`/`prompt_cache_key`/keepalive, no provider payload
  mutation, no headers mutation.
- **No Recipe Action Cache in P6-A.** Recipe results are never cached.
- **No new Agent, daemon, gateway, or background service.** Everything runs
  inside the existing Pi extension on Pi-native events.

## Events used (all Pi-native)

| Event | Workbench behavior |
| ----- | ------------------ |
| `session_start` | restore the session cache summary (custom entry `workbench-cache-state`); classify `reload`/`new` reasons |
| `model_select` | remember the model; the next request is inferred `MODEL_CHANGED` |
| `thinking_level_select` | remember the level; next request is inferred `THINKING_LEVEL_CHANGED` |
| `before_provider_request` | read-only structural digest of the payload (roles, lengths, per-segment SHA-256, tool names) — payload and headers are never changed |
| `message_end` | **assistant messages only**: read normalized usage, hash system prompt + tools + payload shape, classify the invalidation, append one JSONL record |
| `session_before_compact` | the next request is inferred `COMPACTION` |
| `session_tree` | after Pi completes tree navigation, the next request is inferred `SESSION_TREE_CHANGED` exactly once |
| `session_shutdown` | safe flush of the session state entry |

The context-output projector separately reports a stable epoch hash only when
it crosses an active-history epoch boundary. That one request is inferred as
`HISTORY_PROJECTION_EPOCH_CHANGED`; replaying the same projected prefix with
an appended raw suffix does not create another epoch event.

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

## Record schema (`schemaVersion: "1.1"`)

```jsonc
{
  "schemaVersion": "1.1",
  "timestamp": "2026-01-15T09:30:00.000Z",
  "extensionVersion": "0.6.1",
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
`HISTORY_PROJECTION_EPOCH_CHANGED`, `CONTEXT_PREFIX_DIVERGED`,
`PROVIDER_BEST_EFFORT_MISS`, `UNKNOWN`.

P6-B: same-mode drift (system prompt / tool set / tool order / tool schema
changed without a lifecycle event) is recorded as **`UNEXPECTED_DRIFT`**
with the specific source in **`driftSource`**. The P6-A specific reasons
(`SYSTEM_PROMPT_CHANGED`, `TOOL_SET_CHANGED`, `TOOL_ORDER_CHANGED`,
`TOOL_SCHEMA_CHANGED`) are still recognized when reading schemaVersion 1.0
records but are no longer produced by new records.

Classification is a priority chain: explicit events (model/thinking/mode/
reload/compaction/session-tree/history-projection epoch/new-session) >
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
  partial total as complete; intentional bounded-window truncation is labeled
  separately.
- `/q-cache-doctor [json]` — health checks: usage validity, cost metadata,
  models.json/auth.json non-involvement, system prompt dynamics, current
  prefix hashes (`prefix_hashes`), same-mode drift (`same_mode_drift`),
  expected vs unexpected counts, churn (model/thinking/mode/reload/
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
