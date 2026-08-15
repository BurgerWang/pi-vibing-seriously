# Cache Benchmark (P6-E)

`scripts/cache-benchmark.ts` is the **offline** benchmark for the workbench's
prompt-cache and action-cache behavior. It turns local evidence into a
repeatable report so that "did caching help?" can be answered with the same
numbers every time.

Schema-1.3/P0–P2 fields described below are Unreleased source behavior. No
deployment, tag, package publication, `/reload`, live qualification, or
benchmark result is claimed.

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
   rotated `telemetry.N.jsonl` (strict P6-A records, schema version
   1.0/1.1/1.2/1.3).
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
| `cacheWriteTokens` | Σ `usage.cacheWrite`. Schema 1.3 keeps its provenance separate: DeepSeek Completions status `1` means write semantics unavailable; Responses status `2` means normalized absence-or-zero, not provider-presence verification. |
| `totalTokens` | Σ `usage.totalTokens` (input + output + cacheRead + cacheWrite per record). |
| `cacheHitRatio` | `cacheRead / (input + cacheRead)` over the retained scope totals; `null` when usage semantics are not verified, the source is incomplete/corrupt, or the denominator is 0. Intentional oldest-record truncation alone keeps this existing bounded-window ratio available and labels the scope as bounded; it is not a whole-history ratio. Only meaningful for api kinds whose semantics were confirmed in the installed Pi source (`openai-completions`, `openai-responses`, `azure-openai-responses`, `openai-codex-responses`, `anthropic-messages`). |
| `observability.retainedWindowUsage.cacheReadShare` | Schema-1.3 disjoint share `cacheRead / (input + cacheRead + cacheWrite)`, available only for a complete, verified, all-1.3 retained cohort. This—not `cacheHitRatio`—is the canary read-share metric. |
| `observability.retainedWindowUsage.cacheWriteShare` | Separate schema-1.3 share `cacheWrite / (input + cacheRead + cacheWrite)`; `null` when write semantics are unavailable/unverified. Read and write shares are never treated as complements. |
| `cacheReadShareStatusCode` / `cacheWriteShareStatusCode` | `0` empty, `1` complete verified all-1.3, `2` mixed legacy/1.3, `3` partial/schema-invalid, `4` bounded/truncated, `5` usage semantics unverified, `6` write semantics unavailable/unverified, `7` `aggregate_overflow` (the exact aggregate exceeds the safe numeric publication surface). Code `7` forces both shares to `null`; capped display totals are not used to fabricate a ratio. |
| `observability.correlationCounts` | Counts of `unwired`, `exact`, `multipleOrStale`, and `missing`. Non-exact rows are unknown-actor rows with no projection facts and cannot support actor/cohort conclusions. |
| `observability.wholeItemLcp` | Eligible exact-correlated local observations plus whole-item LCP item and UTF-8 byte totals. The local observation has `finalityCode=0`; no final-wire or partial-item/token claim is made. |
| `observability.actorCohorts` | Separate `unknown`, `commander`, and `worker` usage cohorts. Commander and worker must be evaluated separately. |
| `observability.projectionCohorts` | Separate `segmentSeal` and `epochTransition` usage cohorts with numeric event/cause and hard-overflow counts. |
| `usageSemanticStatus` | Worst status across records: `verified` (api kind verified + internally consistent numbers), `partial` (structure ok, api kind unverified), `unverified` (invalid/missing usage). Never guessed. |
| `providerReportedCost` | Σ `usage.cost` — Pi's `usage.cost.total`, the cost fact from the provider's own billing fields. |
| `estimatedAvoidedCost` | Σ (`cacheRead` × `cacheRead` rate)/1M tokens using the **explicit `--cost-map`**; `null` if any record's provider/model has no rate in the map (strict — no partial estimates) or no map is given. |
| `expectedInvalidations` | Records whose `inferredInvalidationReason` classifies as expected: FIRST_OBSERVED_REQUEST, NEW_SESSION, MODEL_CHANGED, THINKING_LEVEL_CHANGED, MODE_CHANGED, PACKAGE_RELOADED, COMPACTION, SESSION_TREE_CHANGED, HISTORY_PROJECTION_EPOCH_CHANGED, HISTORY_PROJECTION_SEGMENT_SEALED, PROVIDER_BEST_EFFORT_MISS. |
| `unexpectedDrifts` | Records classified as unexpected: UNEXPECTED_DRIFT (same-mode system-prompt/tool drift, with `driftSource` detail) and CONTEXT_PREFIX_DIVERGED (a previously observed payload prefix item was rewritten, deleted, or reordered without an attributable lifecycle event). Ordinary UNCHANGED and APPEND_ONLY payload relationships are healthy and are not counted as drift. |
| `historyProjectionSegmentSeals` | Count of retained records whose reason is exactly `HISTORY_PROJECTION_SEGMENT_SEALED`. |
| `historyProjectionEpochTransitions` | Count of retained records whose reason is exactly `HISTORY_PROJECTION_EPOCH_CHANGED`. |
| `explicitBreakpointAppliedRequests` | Count of retained records whose `precedingEvent` is exactly `explicit_prompt_cache_breakpoints_applied`. |
| `explicitBreakpointVerifiedUsage` | Numeric `{ requestCount, input, cacheRead, cacheWrite, hitRatio }` for the applied-request subset. Sums include only exact eligible public `openai` + `openai-responses` + `gpt-5.6*` records with `usageSemanticStatus === "verified"` **and** `messageStatus === "ok"`; an errored request remains in `explicitBreakpointAppliedRequests` but contributes no verified usage. `hitRatio` is `cacheRead / (input + cacheRead)` and is `null` when there is no verified applied request, the denominator is zero, or the observation is incomplete, including intentionally truncated bounded windows. This stricter subset does not change the overall bounded-window ratio above. |
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

## Interpretation note

Normal conversation growth is `APPEND_ONLY`: the provider-visible prefix is
unchanged and only new segments follow it. `UNCHANGED` and `APPEND_ONLY` are
healthy relationships and do not imply drift. `CONTEXT_PREFIX_DIVERGED` is
reserved for an unattributed rewrite, deletion, or reordering of an already
observed payload prefix item while the stable-zone fingerprints
(`systemPromptHash`, `activeToolNamesHash`, `activeToolOrderHash`,
`activeToolSchemaHash`) stayed identical. Known lifecycle rewrites win with
their explicit expected reason, including `SESSION_TREE_CHANGED` and
`HISTORY_PROJECTION_EPOCH_CHANGED`. `UNEXPECTED_DRIFT` with a `driftSource`
(SYSTEM_PROMPT / TOOL_SET / TOOL_ORDER / TOOL_SCHEMA) identifies a stable-zone
mutation. Both unexpected reasons are actionable evidence, while all reasons
remain workbench inferences rather than provider-issued miss verdicts.

Projection-state v3 preserves that relationship with a fixed anchor, ordered
immutable segments, and a raw active suffix. Commander uses a 196,608-byte
hard ceiling, 65,536-byte turn reserve, and 124,928-byte anchor; worker uses
131,072, 49,152, and 75,776 bytes; other uses 65,536, 49,152, and 10,240
bytes. All roles reserve sixteen segments of at most 384 tool-text bytes/one
complete bundle and cap the anchor at 96 bundles. The
turn/16-bundle values select the protected suffix only at a true hard crossing;
reserve-only growth under both hard limits remains byte-identical and produces
event `none`.

Seals 1–16 append one segment while leaving the epoch, anchor, older segments,
and safe boundary markers exact. The benchmark must classify that signal as an
expected active-tail rewrite rather than a full epoch invalidation. An
additional true hard crossing at the 16-segment ceiling triggers the
deterministic model-free checkpoint, rebuilds the anchor, clears the chain, and
produces the expected `HISTORY_PROJECTION_EPOCH_CHANGED`. Same-state suffix
appends—including reserve-only crossing—remain whole-payload append-only.
State stays v3 and telemetry stays schema 1.3; one `policy_changed` transition
adapts a valid restored state created under an earlier role cap.

This CLI is offline and observation-only. It can validate stored arithmetic
and structural relationships, but its fake provider deliberately reports
`cacheRead = 0`. Only verified provider usage is cache-hit authority. After
deployment, use a new live session and subsequent real `cacheRead` values to
measure reuse; do not claim improvement from the offline benchmark.

The offline doctor exposes the same retained-record facts through
`history_projection_events` and `explicit_breakpoint_usage`. A complete set of
verified applied records for eligible public OpenAI GPT-5.6 Responses traffic
can be `ok`; provider-reported `cacheRead = 0` remains a valid observation, not
an instrumentation failure. On complete evidence, no applied record for
default-disabled Codex or unsupported DeepSeek traffic is `skip`, not `fail`.
Doctor JSON also exposes numeric `erroredEligibleAppliedRequests`. If any
eligible applied request has `messageStatus = error`, the check is `warn`, its
usage is excluded from `explicitBreakpointVerifiedUsage`, and neither the text
nor JSON may describe that failed-request usage as authoritative or OK.
Partial, corrupt, unreadable, or intentionally truncated evidence makes both
checks `warn` and the applied-subset ratio `N/A` (`null` in JSON). These
summaries retain numeric counts and usage only; they do not retain request
content and cannot prove a cache-hit improvement.

Schema 1.3 adds `provider_wire_observation` and `request_correlation` doctor
checks. A local observation is always reported as nonfinal (`finalityCode=0`),
never as an OK final-wire proof. Correlation warns on any
unwired/multiple/stale/invalid/missing row, unverified semantics, or incomplete
window; only exact rows can enter Commander/worker projection cohorts. The
schema accepts only the defined event/cause pairs with matching overflow,
epoch, seal, and segment transitions; impossible numeric anatomy is invalid
rather than a new category. Doctor inspection is descriptor-only and treats
Proxy/accessor/symbol/exotic records as partial/uninspectable evidence without
executing traps or getters.

Provider-side operating guidance is documented, not exercised, by this offline
CLI. OpenAI requires exact prefixes, recommends static content first and
variable content last, and uses a consistent `prompt_cache_key` for reliable
GPT-5.6 matching. Each request creates at most four new cache writes, reads from
up to the latest 50 breakpoint candidates, and should keep traffic near 15
requests/minute per key; inspect `cached_tokens` and `cache_write_tokens` to
measure results. Consequently, the workbench's 17 logical anchor/segment
markers are not 17 new writes per request. See the
[stable-prefix contract](stable-prefix-contract.md) for primary sources and the
Commander/worker immutable-anchor, modular-segment, rare-checkpoint rationale.

The source synthesis also pins [DeepSeek Harness commit
`47f943859bef60e4160492346772ded9b24f765a`](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a).
Append-only-prefix and bounded-model-surface principles are borrowed; MLA,
server scheduling, disk-KV ownership, and harness measurements are not
transferable benchmark claims. Warm-prefix auxiliary compaction remains
`BLOCKED_BY_PI_0_84_2_PUBLIC_API`, rechecked against the official
[Pi v0.84.2 release](https://github.com/earendil-works/pi/releases/tag/v0.84.2)
at [commit `914cf1472e715297caa30db4b9535d534a9eb718`](https://github.com/earendil-works/pi/commit/914cf1472e715297caa30db4b9535d534a9eb718).
Commander capacity preflight does not replace summaries: block stops before
provider/telemetry/supplement and points to
`/q-milestone-handoff <next step>`; allow/warn/unknown retain native Pi
compaction, while workers still cancel.
The separate Commander and worker canary thresholds in the
[stable-prefix contract](stable-prefix-contract.md#canary-evaluation-targets-not-guarantees)
are evaluation targets only and cannot be satisfied by offline/fake-provider
data. The larger caps likewise make no cache-hit promise until repository
dependencies resolve (the current tree resolves Pi 0.84.2), declared gates
pass, `/reload` is applied, and a fresh live Commander/worker cohort is
measured. Current size qualification is
limited to the 272k Commander model and pinned 1M worker; `other` and arbitrary
64k/128k model windows remain unqualified.

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
