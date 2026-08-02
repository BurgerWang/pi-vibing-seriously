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
| `session_shutdown` | safe flush of the session state entry |

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
  confirmed in the installed Pi source AND all usage fields are finite,
  non-negative and `totalTokens` is consistent.
- `partial` — structure looks right but the api kind is not in the verified
  set: the ratio is `null`.
- `unverified` — missing/invalid usage or inconsistent totals: the ratio is
  `null`. The workbench never guesses.

`cacheWrite = 0` (DeepSeek reports no cache writes) does not affect the
semantic status.

## Invalidation reasons (inferred)

`FIRST_OBSERVED_REQUEST`, `NEW_SESSION`, `MODEL_CHANGED`,
`THINKING_LEVEL_CHANGED`, `MODE_CHANGED`, `UNEXPECTED_DRIFT`,
`PACKAGE_RELOADED`, `COMPACTION`, `CONTEXT_PREFIX_DIVERGED`,
`PROVIDER_BEST_EFFORT_MISS`, `UNKNOWN`.

P6-B: same-mode drift (system prompt / tool set / tool order / tool schema
changed without a lifecycle event) is recorded as **`UNEXPECTED_DRIFT`**
with the specific source in **`driftSource`**. The P6-A specific reasons
(`SYSTEM_PROMPT_CHANGED`, `TOOL_SET_CHANGED`, `TOOL_ORDER_CHANGED`,
`TOOL_SCHEMA_CHANGED`) are still recognized when reading schemaVersion 1.0
records but are no longer produced by new records.

Classification is a priority chain: explicit events (model/thinking/mode/
reload/compaction/new-session) > same-mode drift (`UNEXPECTED_DRIFT`) >
payload-shape divergence > provider-side best-effort miss (stable context
but zero cache read). Reports always label these `inferred`.

## Commands

- `/q-cache-status` — current session: provider/model, api kind, mode,
  thinking level, request count, input/cacheRead/output, reported cost
  (`usage.cost.total`), hit ratio or N/A, semantic status, last inferred
  invalidation.
- `/q-cache-report [session|project] [--save <name>]` — aggregation over the
  telemetry file (session-scoped by hashed session id, or whole project):
  request count, by-mode and by-model totals, tokens and cost, hit ratio,
  change counts (model/thinking/mode/reload/compaction), expected
  invalidations vs unexpected drifts, and estimated avoided cost (only when
  the model registry provides compatible cost metadata for every record).
- `/q-cache-doctor [json]` — health checks: usage validity, cost metadata,
  models.json/auth.json non-involvement, system prompt dynamics, current
  prefix hashes (`prefix_hashes`), same-mode drift (`same_mode_drift`),
  expected vs unexpected counts, churn (model/thinking/mode/reload/
  compaction), tool-metadata statics, forbidden telemetry fields, file size.

## Session state entry

A lightweight Pi custom entry (`customType: workbench-cache-state`) holds
only: `schemaVersion`, `hashedSessionId`, `requestCount`, aggregate usage,
last hashes, last invalidation reason, and the telemetry file reference.
It is restored on `session_start` so the request count and hash baselines
survive compaction, resume, fork, and reload. No message bodies and no large
arrays are ever stored in it.

## Footer status

When the data is valid the workbench footer appends a compact segment (the
Pi footer itself is never replaced):

```
CACHE 72% | read 184k | miss 71k
```

`CACHE N/A` is shown when the usage semantics are not verified. Nothing is
shown before the first request, in print/json modes, or when telemetry is
disabled.
