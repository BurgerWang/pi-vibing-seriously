# Cache Benchmark (P6-E)

`scripts/cache-benchmark.ts` is the **offline** benchmark for the workbench's
prompt-cache and action-cache behavior. It turns local evidence into a
repeatable report so that "did caching help?" can be answered with the same
numbers every time.

## Commands

| Command | npm script | What it does |
| ------- | ---------- | ------------ |
| `tsx scripts/cache-benchmark.ts report [options]` | `npm run cache:report` | Full benchmark report (see fields below). |
| `tsx scripts/cache-benchmark.ts doctor [options]` | `npm run cache:doctor` | Offline health checks: telemetry hygiene + action-cache integrity. Exits non-zero when any check FAILs. |
| `tsx scripts/cache-benchmark.ts compare <report>...` | — | Side-by-side table of saved reports (`reports/*.json`), e.g. `p6a-baseline p6b-stable-dev p6c-action-cache`. |

Options: `--project <root>` (default: current directory), `--json`
(machine-readable), `--session <hashed-id>` (scope telemetry to one hashed
session), `--since <iso>` / `--until <iso>` (time-scope telemetry),
`--cost-map <file>` (explicit per-model rates), `--save <name>` (atomic
write into `reports/<name>.json`).

## Data sources (the ONLY things read)

1. **Workbench telemetry JSONL** — `.pi/workbench/cache/telemetry.jsonl` and
   rotated `telemetry.N.jsonl` (P6-A records, schema version 1.0/1.1).
2. **Pi normalized usage** — the `usage` object inside each telemetry
   record (input/output/cacheRead/cacheWrite/totalTokens/cost as Pi exposed
   them on the assistant message).
3. **Run manifests** — `.pi/workbench/runs/<run-id>/manifest.json`
   (`execution_source`, `action_key`, `reused_from_run_id`, `duration_ms`).
4. **Action cache records** — `.pi/workbench/cache/actions/*.json`,
   `cache-index.json`, `locks/*.lock`, `tmp/corrupt-*` quarantine copies.

## What the benchmark NEVER does

- No model calls, no HTTP requests, no provider traffic of any kind
  (including warmup/keepalive).
- No reads of `auth.json` or any credential file; no reads/writes of
  `models.json` / `models-store.json`; no dependence on `DEEPSEEK_API_KEY`
  or any provider environment variable.
- No `cache_control` / `prompt_cache_key` / `prompt_cache_retention`, no
  cache TTL configuration — the benchmark is observation-only.
- No modification of any provider, Pi session state, or telemetry records
  (the only write is an optional new file in `reports/` via `--save`).
- No hardcoded provider prices. `estimatedAvoidedCost` is computed **only**
  from an explicit `--cost-map` file (`{ "provider/model": { "cacheRead":
  <USD per 1M tokens> } }`); without one it is `null`.

## Statistical definitions

All telemetry-derived numbers use the **same aggregation as
`/q-cache-report`** (`buildCacheReport` in
`extensions/workbench-runtime/cache/cache-report.ts`), so CLI numbers always
equal in-Pi numbers.

| Field | Definition |
| ----- | ---------- |
| `requestCount` | Telemetry records in scope (after `--session`/`--since`/`--until` filters). |
| `uncachedInputTokens` | Σ `usage.input` — tokens billed as cache-miss input. |
| `cacheReadTokens` | Σ `usage.cacheRead` — tokens billed as cache-hit input. |
| `outputTokens` | Σ `usage.output`. |
| `cacheWriteTokens` | Σ `usage.cacheWrite` (0 for DeepSeek — it reports no cache writes; a zero is NOT an error). |
| `totalTokens` | Σ `usage.totalTokens` (input + output + cacheRead + cacheWrite per record). |
| `cacheHitRatio` | `cacheRead / (input + cacheRead)` over the scope totals; `null` when usage semantics are not verified or the denominator is 0. Only meaningful for api kinds whose semantics were confirmed in the installed Pi source (`openai-completions`, `openai-responses`, `azure-openai-responses`, `openai-codex-responses`, `anthropic-messages`). |
| `usageSemanticStatus` | Worst status across records: `verified` (api kind verified + internally consistent numbers), `partial` (structure ok, api kind unverified), `unverified` (invalid/missing usage). Never guessed. |
| `providerReportedCost` | Σ `usage.cost` — Pi's `usage.cost.total`, the cost fact from the provider's own billing fields. |
| `estimatedAvoidedCost` | Σ (`cacheRead` × `cacheRead` rate)/1M tokens using the **explicit `--cost-map`**; `null` if any record's provider/model has no rate in the map (strict — no partial estimates) or no map is given. |
| `expectedInvalidations` | Records whose `inferredInvalidationReason` classifies as expected: FIRST_OBSERVED_REQUEST, NEW_SESSION, MODEL_CHANGED, THINKING_LEVEL_CHANGED, MODE_CHANGED, PACKAGE_RELOADED, COMPACTION, PROVIDER_BEST_EFFORT_MISS. |
| `unexpectedDrifts` | Records classified as unexpected: UNEXPECTED_DRIFT (same-mode system-prompt/tool drift, with `driftSource` detail) and CONTEXT_PREFIX_DIVERGED (payload shape changed while stable-zone fingerprints stayed identical — the normal conversation-growth pattern; see the interpretation note below). |
| `modeChanges` / `modelChanges` / `thinkingChanges` | Adjacent-record transitions of `workbenchMode` / `model` / `thinkingLevel`. |
| `reloads` / `compactions` | Records with `inferredInvalidationReason` PACKAGE_RELOADED / COMPACTION. |
| `recipeExecutions` | Run manifests found under `.pi/workbench/runs/` (each manifest = one recipe invocation, exec or cache-hit materialization). |
| `recipeCacheHits` | Manifests with `execution_source: "cache"` (a validated action-cache hit that skipped execution). |
| `recipeCacheMisses` | Manifests with `execution_source: "exec"` (actually executed). |
| `recipeHitRatio` | `hits / (hits + misses)`; `null` when no runs exist. |
| `localExecutionTimeAvoided` | Σ, over cache-hit manifests, of the **original execution duration**: the action record's `durationMs` (matched by `action_key`), falling back to the exec manifest's `duration_ms` (matched by `reused_from_run_id`). In seconds. |
| `cacheStorageSize` | Total on-disk bytes of `.pi/workbench/cache/` (actions + cas + locks + tmp + cache-index + telemetry + reports) — bounded by rotation and prune rules. |
| `corruptionCount` | Quarantined action records (`tmp/corrupt-*`), action files with schema/key mismatches, CAS quarantine files, unparseable run manifests, and skipped telemetry lines. Corruption is always treated as a miss — never a wrong answer. |
| `fallbackCount` | Lock files whose owner PID is dead and whose age exceeds `LOCK_STALE_MS` (60 s) — evidence that execution proceeded without the lock (cache writes become best-effort). |
| `skippedTelemetryLines` | Corrupted JSONL lines skipped during reading (counted, never fatal). |

## Interpretation note (do not over-read `unexpectedDrifts`)

`CONTEXT_PREFIX_DIVERGED` is a **conservative** inference: it fires when the
payload *shape* changed while the stable-zone fingerprints
(`systemPromptHash`, `activeToolNamesHash`, `activeToolOrderHash`,
`activeToolSchemaHash`) stayed identical. In a normal conversation every
turn appends new segments, so most records carry this reason **even when the
cache is healthy** (the cached prefix covers the unchanged part; only the
newest segments are billed as input). The actionable signal is
`UNEXPECTED_DRIFT` **with a `driftSource`** (SYSTEM_PROMPT / TOOL_SET /
TOOL_ORDER / TOOL_SCHEMA): that is a stable-zone change that genuinely
invalidates the provider cache. The doctor distinguishes the two, and the
benchmark reports both counts verbatim — treat `unexpectedDrifts` as an
upper bound, not a failure count.

## Statistics, reproducibility

- Report files are written atomically (tmp + rename) into
  `.pi/workbench/cache/reports/`, names sanitized to `[A-Za-z0-9_-]`,
  modes `0o600`/`0o700`.
- The `compare` command reads saved reports in **either** the extension
  shape (`/q-cache-report --save`) **or** the benchmark shape — the two
  aggregate identically, so mixed sources are comparable.
- Bad lines, missing files and missing reports degrade to counted skips or
  explicit "no saved reports found" errors — never crashes.
- With no telemetry at all the CLI prints a friendly explanation and exits
  0 (a report with `requestCount: 0` in `--json` mode); the doctor prints
  "nothing to check" and exits 0.
