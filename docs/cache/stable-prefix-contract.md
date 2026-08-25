# Stable Prefix Contract (P6-B)

DeepSeek's prompt cache is a **full-prefix cache**: reuse requires an identical
prefix starting at the first token. The workbench treats the rendered system
prompt, tool definitions, and message history through a boundary as exact
provider-visible structure. It therefore formalizes which request parts may
vary and which must stay identical, and enforces that split in code and tests.

This contract is the P6-B companion to the P6-A telemetry docs
(`cache-telemetry.md`) and the provider-facts doc
(`deepseek-prompt-cache.md`). Read `cache-efficient-workflow.md` for the
day-to-day workflow rules that follow from this contract.

The P0–P2 sections below describe Unreleased source behavior. No deployment,
tag, package publication, `/reload`, or live cache improvement is claimed.

## The two zones

### Stable zone — must hash identically within a mode

| Input | Source | Workbench guarantee |
| ----- | ------ | ------------------- |
| Pi's fixed system prompt | Pi itself | the workbench never rewrites it per turn (`before_agent_start` returns nothing) |
| Workbench static rules | AGENTS.md, project rules | loaded by Pi; never rewritten per turn |
| Extension registration order | `package.json` `pi` arrays | static file content |
| The current mode's fixed tool list | `core/mode-policy.ts` `MODE_TOOLS` | explicit constant arrays (tested) |
| Tool name/label/description/schema | `core/tool-catalog.ts` | single static catalog; registerTool spreads it (tested) |
| Native override metadata/schemas | `core/native-tool-policy.ts` | static `NATIVE_OVERRIDE_METADATA` / `NATIVE_OVERRIDE_PARAMETERS`; v0.10.0 `read` declares path plus optional integer offset/limit and cursor, `find` stays built-in-compatible, and `grep` appends exactly the two optional count selectors (`output`, `count_kind`); no dynamic facts (tested) |
| promptSnippet / promptGuidelines | `core/tool-catalog.ts` | static, audited for dynamic values (tested) |
| Skill name/description metadata | Pi discovery | names/descriptions static per install; ordering documented |
| Prompt template metadata | Pi discovery | static per install |

### Dynamic zone — must NEVER enter the stable zone

Time and date, git state (branch/commit/dirty), the mode's current value,
task id, run id, gate id/status, cache usage, token/cost numbers, run
progress, latest artifact, warnings.

**Dynamic information is forbidden in:** the system prompt, tool
descriptions, `promptSnippet`, and `promptGuidelines`. Adding any of these
re-hashes the prefix and silently defeats caching.

**Dynamic information may only flow through these channels:**

1. **TUI status / widget** — `ctx.ui.setStatus` / `ctx.ui.setWidget`
   (workbench footer `WB:VERIFY | ... | CACHE 72%`).
2. **Custom session entries** — `pi.appendEntry` (`workbench-mode`,
   `workbench-state`, `workbench-cache-state`).
3. **Tool results** — the `content`/`details` of `workbench_*` tool
   executions (run ids, gate statuses, paths).
4. **Telemetry hash/numeric metadata** — hashes plus bounded numeric event,
   correlation, usage, and projection facts; never their text.
5. **Normal chat messages** — the compaction supplement note
   (`workbench-compact-note`, bounded, redacted, display:false).
6. **Context projection** — a deterministic runtime transform may replace
   older complete assistant-tool bundles with bounded descriptors before a
   provider request. It never changes the system prompt or tool definitions.
   Projection state v3 freezes one anchor and up to 16 immutable segments;
   only the active raw tail grows between declared seals/checkpoints.

## What the workbench audited (and what it does not do)

Audited hooks: `before_agent_start`, `context`, system prompt hooks,
compaction hooks, AGENTS/context loading, skills discovery, prompt template
discovery.

- **No per-turn system prompt rewrites.** The workbench never returns a
  system prompt from `before_agent_start`. The `context` event now performs
  the v0.10.0 active-history projection: it validates exact tool-call/result
  pairing, protects the latest bundles, and replaces or removes only whole
  older bundles under the role budget. `ctx.getSystemPrompt()` remains
  read-only, for telemetry hashes and `/q-cache-doctor`.
- **No dynamic appends.** Nothing appends timestamps, cwd state, mode, git,
  run or cache info to the system prompt.
- **`ctx.getSystemPrompt()` is stable** within the same mode and unchanged
  resources — verified by `/q-cache-doctor` (`system_prompt_dynamics`,
  `prefix_hashes`) and the P6-B hash tests.
- **P6 telemetry never enters the model context.** Telemetry persists only
  as custom entries (`workbench-cache-state`) and JSONL files; it never
  sends messages. Tested: `tests/p6-b-stable-prefix.test.ts`
  ("telemetry never enters the model context").
- **Compaction writes no cache statistics.** The compaction supplement note
  carries task/mode/gates/runs/evidence pointers only (tested).
- **A blocked compact writes neither telemetry nor a supplement.** Commander
  summary-capacity preflight cancels only when its conservative envelope
  estimate is at or above model capacity and directs
  `/q-milestone-handoff <next step>`; workers cancel before reading the
  preparation. Allowed/warned Commander events keep native Pi compaction.
- **`before_provider_request` is copy-on-write and capability-gated.** For the
  proven public OpenAI GPT-5.6 Responses shape only, it may return a cloned
  payload with explicit breakpoints on exact marker blocks. Unsupported,
  uncertain, Codex-default, and DeepSeek paths return the original payload by
  identity. Headers are never changed. Telemetry hashes the payload observed
  locally at this hook with `finalityCode=0`; it does not claim the final
  provider wire.
- **The `context` event is enforcement, not cache observation.** Below the
  hard ceiling it returns raw history unchanged. At an initial checkpoint,
  projection-state v3 freezes a 122/74/10 KiB Commander/worker/other anchor
  and uses one 64/48/48 KiB raw turn plus a 16-bundle target to select the
  suffix only when a true 192/128/64 KiB or 128-bundle hard crossing occurs.
  Reserve-only crossing leaves the request byte-identical. Up to 16 immutable
  384-byte/one-bundle segments may be appended. Seals 1–16 preserve the epoch
  and every older boundary; a later hard crossing at the 16-segment safety
  ceiling performs a model-free checkpoint and increments the epoch.
  Ordinary appends are not `CONTEXT_PREFIX_DIVERGED`; tool/system stable-zone
  hashes are unaffected.

Old session JSONL remains readable but can carry large legacy details before
Pi clones it. Use `npm run session:sanitize -- ...` to create a separate
mode-0600, hash-manifested safe copy; the sanitizer never edits the source in
place. See `docs/context-output-control-plane.md`.

## Deterministic tool registration

- Registration order is the explicit constant
  `WORKBENCH_TOOL_NAMES` in `core/tool-catalog.ts`; `index.ts` registers in
  exactly that order (source-scanned by tests).
- NRO N1/N2 (Commander Native Tool Optimization, `docs/plans/commander-native-tool-optimization.md`):
  the three fixed same-name native overrides (`read` → `grep` → `find`) are
  registered statically BEFORE the unchanged 11-tool catalog — the
  registration surface is exactly `NATIVE_OVERRIDE_NAMES` +
  `WORKBENCH_TOOL_NAMES` (source-scanned by tests), and the catalog's names,
  order, mode matrices and write inventories are unchanged. Their static
  metadata and parameter schemas live in `core/native-tool-policy.ts`
  (`NATIVE_OVERRIDE_METADATA` / `NATIVE_OVERRIDE_PARAMETERS`). `read` v3
  intentionally declares its 12 KiB pager, integer-bounded compatibility
  selectors and opaque cursor; `grep` appends its two count selectors after
  the legacy property prefix; `find` keeps the built-in strings/schema.
  Guideline text remains static and contains no runtime facts.
- Tool metadata (name/label/description/promptSnippet/promptGuidelines/
  parameters) is static at runtime and centralized in the catalog.
- The current additive local-commit transition appends
  `workbench_commit_reviewed` after the frozen 11-tool governance-v1 prefix.
  It intentionally changes the tool-name/order/schema fingerprint once; after
  reload the new 12-tool catalog is stable in the same mode.
- Parameter JSON schemas are built in source order; `canonicalHash`
  on the schema is stable across runs (tested).
- No dependence on filesystem readdir order, YAML key order, glob return
  order, Set/Map external input order, profile-file order or git state:
  every directory read is sorted (`stableSortStrings`), gates sort by id,
  recipes and profiles sort by name, glob artifacts are sorted.
- DEV mode preserves non-managed custom tools from other extensions in
  deterministic (name-sorted) order — never in the order some other
  extension happened to report them.

## Fixed mode and worker-role tool matrices

| Mode | Tool set | Hard-denied (second layer) |
| ---- | -------- | -------------------------- |
| AUDIT | read, grep, find, ls, workbench_project_inspect, workbench_read_run, workbench_read_gate, workbench_list_gates, workbench_compare_runs, workbench_recover_tool_result | bash, edit, write, workbench_run_recipe, workbench_run_gate, workbench_delegate_worker |
| VERIFY | read, grep, find, ls + the 8 inspection/recipe/gate/comparison/recovery tools | bash, edit, write, workbench_delegate_worker |
| DEV commander | read, grep, find, ls, bash, edit, write + all 12 workbench tools | (none beyond the global guards) |
| DEV strict Sol (`worker-first-strict`) | read, grep, find, ls + all 12 workbench tools (exact canonical 16; an ACTIVE user lease adds edit/write → 18) | bash always; edit/write without an ACTIVE user-issued lease or outside its paths; any foreign tool |
| DEV worker child | DEV commander set minus bash, workbench_run_gate, workbench_commit_reviewed, workbench_delegate_worker | bash, workbench_run_gate, workbench_commit_reviewed, workbench_delegate_worker; edit/write also require approved paths |

The worker-role reduction is deterministic and applied inside the same single
`setActiveTools` call. It is fixed for the lifetime of the child process; no
per-turn tool loading occurs — tools are never loaded dynamically. Adding the
delegate tool changed the commander DEV schema fingerprint once on package
reload, after which the prefix remained stable; P8b appending the public
read-only `workbench_recover_tool_result` LAST was the second deliberate
one-time fingerprint transition (recorded as `UNEXPECTED_DRIFT` — expected,
not a defect; the schema is still static and registered in the same explicit
order), and same-mode fingerprints are stable again. P8b boundary: the
recovery tool is deliberately NOT added to the existing read-only batching
classifier — AUDIT is exactly the batch allowlist plus the recovery tool
(tested), and batching it remains a separate reviewed decision.

NRO N1/N2 (Commander Native Tool Optimization): the three fixed same-name
overrides (`read` → `grep` → `find`) replace the Pi built-ins under the
SAME names, so the resolved tool list (names and order) and every
mode/write inventory are unchanged. In v0.10.0, N1's preview is superseded
by read v3: every text path uses one quoted 12 KiB/240-file-line pager and a
strict stale-safe cursor; legacy offset/limit calls enter that same pager;
images still use Pi's attachment pipeline. N2 is the
grep count slice: `output=count` returns one exact uncapped
`count kind=<matches|lines> value=<n> files=<n>` line through the direct
abort-aware ripgrep adapter (managed rg first, then system rg;
`shell:false`), while omitted `output`, `output="matches"` and a
`count_kind` without `output` stay byte-identical to the equivalent
Pi 0.83.0 legacy call; the legacy `limit`/`context` never cap the count,
zero is exact, and malformed framing, execution failure, abort or an
unavailable rg fail explicitly — never a partial count. `find` remains an
exact legacy pass-through: `output=count` / `max_depth` (staged N3) and
grep `output=files` (staged N2b) are NOT exposed. The overrides shift the
DEV/AUDIT/VERIFY tool-schema fingerprint exactly ONCE (the combined
N1/N2 metadata/schema delta — recorded as `UNEXPECTED_DRIFT`, expected,
not a defect), after which same-mode fingerprints are stable again on
repeated builds (tested). Exact-name mode/path guards are unchanged, and
NRO token savings/adoption remain **NOT_MEASURED** (N4 is Commander-owned
measurement/verdict).

- Each mode switch applies the new set in **one** `setActiveTools` call;
  the set is then frozen until the next mode switch or session start.
- Slash commands (`/q-*`, including all `/q-cache-*` maintenance commands)
  are commands, never model-callable tools.
- If active tools change **within** the same mode, telemetry records
  `UNEXPECTED_DRIFT` and `/q-cache-doctor` reports a `same_mode_drift`
  warning.

## v0.10.0 intentional transition

Context Output Control Plane v1 intentionally changes the static tool surface
once. The native `read` schema adds the opaque cursor and integer-bounded
legacy offset/limit fields; `workbench_read_run`, diff review, and
`workbench_read_gate` expose their lower hard ceilings and paging selectors;
the independent-read guideline now conditions batching on runtime turn-budget
authorization. Unsafe legacy maxima are not retained for cache continuity.

The canonical public surface here is the ordered array of the three native
overrides followed by all workbench tools, each represented as
`{name,description,promptSnippet,parameters,promptGuidelines}`. It is separate
from a mode prefix because it intentionally excludes the system prompt and
mode-specific built-ins.

| Surface | Canonical SHA-256 |
| --- | --- |
| Baseline commit `8ec8c269c6a3ef699c7e8112e8fec75a73fb7c4c` | `1c82f913f7dc0fe6c999ca982db1d714df940dfa09a75165aca5b6a01cd1f8dd` |
| v0.10.0 final public surface | `b5938d64d2730119daa0f1b1c833aac09ff4923b52124a833bc2f1e0d5294b11` |

The hashes are pinned by `tests/p6-b-stable-prefix.test.ts`; the baseline is
derived read-only from the frozen commit, while the current hash is computed
from the registered static sources. Reloading v0.10.0 therefore produces one
expected `TOOL_SCHEMA` drift and cold cache prefix. Repeated builds in the same
mode must then be stable. Runtime history projection changes only a bounded
active tail at a declared seal, or resets the segmented topology at a declared
checkpoint. Neither a normal append nor exact replay is classified as prefix
divergence. These guarantees do not alter the stable-zone tool hashes.

## History-projection segmented epochs

The active-history hard ceilings are **196,608 bytes (192 KiB) for
Commander**, **131,072 bytes (128 KiB) for worker**, **65,536 bytes (64 KiB)
for other**, and **128 complete assistant/tool-result bundles**.
Projection-state v3 reserves the active turn and segment chain before sizing
the anchor:

```text
anchorByteCap = max(0, hardToolTextBytes - roleTurnBytes - 16 * 384)
anchorBundleCap = max(0, 128 - 16 segment bundles - 16 active bundles) = 96
```

| Role | Hard tool text | Raw turn reserve | Segment reserve | Anchor cap | Active bundles | Anchor bundles |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Commander | 196,608 B | 65,536 B | 16 × 384 B | 124,928 B (122 KiB) | 16 | 96 |
| Worker | 131,072 B | 49,152 B | 16 × 384 B | 75,776 B (74 KiB) | 16 | 96 |
| Other | 65,536 B | 49,152 B | 16 × 384 B | 10,240 B (10 KiB) | 16 | 96 |

At the initial checkpoint, the controller validates global tool-call/result
pairing and chooses the largest latest **raw** suffix that fits the role-turn
bytes and 16 bundles, with the split on a complete assistant-bundle boundary.
It projects `[0, split)` into the fixed anchor and leaves `[split, end)` raw.
On a same-state request it reconstructs the exact anchor, ordered segments, and
active raw suffix. Small suffix growth is therefore whole-payload append-only.

The role-turn bytes and 16 bundles are selection reserves, not independent
seal thresholds. If only either reserve is exceeded while the complete
reconstruction remains within both hard limits, the controller emits no event
and returns the exact same history. On a true hard byte/bundle crossing it
seals only aged active material into one new immutable segment, after keeping
the largest complete suffix that fits the reserves. A segment contains at most
384 total UTF-8 tool-text bytes and one complete bundle. Seals 1 through 16
append to the chain without changing the epoch hash; the anchor, all older
segments, and their markers remain exact. The separate `segmentSealed` signal
classifies this as an expected active-tail rewrite—not a full fixed-prefix
invalidation. A later true hard crossing at the 16-segment ceiling never seals
early: it performs the deterministic model-free checkpoint, rebuilds the
anchor, clears the segment chain, increments the epoch, and emits the separate
checkpoint/epoch signal.

The projected anchor and every immutable segment end with a deterministic,
bounded hidden custom marker. Its safe `boundaryId` is derived only from
projected/provider-visible structural content, never a raw secret hash. The
projection result exposes the exact bounded marker strings and IDs required by
the provider hook. Once sealed, a marker/message pair is immutable until the
next checkpoint.

The cap expansion does not bump projection state v3 or telemetry schema 1.3.
A valid v3 state created under an earlier role policy is accepted and emits
one `policy_changed` transition; the new state then replays deterministically.
The exact anchor and already sealed segments remain whole-item byte-identical
through an ordinary seal. The contract does not claim that the entire previous
request remains a prefix after a bounded active-tail replacement.

The `workbench-history-projection-state-v3` custom entry uses
`schemaVersion: 3`, persists only strict numeric/hash topology, and is bounded
to 32 KiB; it contains no message text. Frozen slices
must be contiguous raw boundaries, at most 16, and each must satisfy the exact
384-byte/one-bundle limits. Reload reconstructs every slice from raw JSONL and
compares exact hashes, counts, bytes, bundles, chain arithmetic, and hard
totals. Any mismatch fails closed as `prefix_changed`. The newest recognized
entry is authoritative: a malformed matching entry or a structurally unsafe
newer entry (including a Proxy, revoked Proxy, or `customType`/`data` accessor)
blocks fallback to an older valid state without executing its traps. A safely
unrelated ordinary-data entry may still be skipped.

Strict v1 and v2 are migration input only; monotonic epoch and the existing
pressure observation carry forward, but no prior topology or hash is reused.
This also holds below the hard cap: the first projection after restore returns
the raw history unchanged, emits one `legacy_migration` boundary, advances the
epoch once, and persists inactive v3 state. Restoring that v3 state does not
emit the migration boundary again.

Failure/recovery is similarly durable without adding a schema key. An inactive
v3 record may carry one fixed, non-secret failure sentinel in `epochHash`,
covered by `stateHash`. After JSONL restore, another failure reuses the sentinel
without another transition; the first healthy projection emits one fixed
recovery boundary and later healthy projections emit none. Neither identity is
derived from hostile/raw history. Branching, completed compaction, invalid
pairing, and invalid policy state retain these fixed fail-closed semantics.
Lowered test/policy caps clamp the formula; if the topology cannot be reserved, the
controller checkpoints or fails closed rather than weakening a hard limit.

## Recoverable ingress before history projection

The stable-prefix design starts at the first provider-visible tool result, not
only when old history is projected. Exactly six finalized durable authorities
are eligible: recipe summaries, executed gate records, immutable comparisons,
completed worker reports, finalized run pages, and run-id gate pages. The
authority is role-neutral and binds an in-project regular source of at most
4 MiB to its content hash and stable size/device/inode/`mtimeNs`/`ctimeNs`
snapshot. Commander, worker, and other roles share this mechanism; their only
difference is the surrounding byte budget.

Eligible text at or below 4,096 UTF-8 bytes is replayed byte-for-byte with
content-bound metadata. Only larger text receives the deterministic bounded
recovery wrapper. If the current allocation cannot preserve that wrapper, the
ordinary envelope is recomputed from the original result and recovery metadata
is removed. Gate-page rendering uses the call allocation before it mints the
next cursor, so a cursor cannot advance past a semantic row absent from final
content. When that result later ages into projected history, strict metadata
validation selects the durable source path before any receipt-summary
fallback. These controls reduce avoidable prefix rewriting; they do not prove
or promise a provider cache hit.

## Provider integration and research limits

- [OpenAI Prompt Caching](https://developers.openai.com/api/docs/guides/prompt-caching)
  documents exact-prefix matching: stable instructions, examples, tools, and
  schemas belong first, while user-specific values, timestamps, and other
  variable content belong after the reusable prefix. For GPT-5.6+, supported
  content blocks may carry explicit breakpoints via
  `prompt_cache_breakpoint: { "mode": "explicit" }`. The workbench may map a
  safe boundary marker only to the exact public `openai` +
  `openai-responses` + `gpt-5.6*` request shape; the marker is not injected
  into unsupported blocks. The helper requires and preserves Pi's existing
  `prompt_cache_key`, so related requests must keep that key and exact prefix
  consistent; it never invents a key, sets `prompt_cache_options`, or marks the
  active tail.

  OpenAI limits each request to at most four **new cache writes** (the latest
  four eligible breakpoints in explicit mode; in implicit mode the latest
  message consumes one slot), while cache reads consider up to the latest 50
  breakpoint candidates and choose the longest match. Therefore the
  workbench's maximum 17 logical boundaries (anchor plus 16 immutable
  segments) do **not** mean 17 new writes on one request. Keep aggregate
  traffic for one `prompt_cache_key` at approximately 15 requests per minute,
  partitioning higher-volume traffic with a stable mapping. Measure the result
  with provider `cached_tokens` and `cache_write_tokens`; marker count is not a
  hit metric.

  The [latest-model guide](https://developers.openai.com/api/docs/guides/latest-model)
  is the companion model-level source. `openai-codex` remains disabled by
  default until live SSE and WebSocket probes both prove field acceptance and
  no provider `400`.
- [DeepSeek context caching](https://api-docs.deepseek.com/guides/kv_cache)
  is automatic and matches identical prefixes starting at token zero. The
  DeepSeek hook is therefore a strict explicit-breakpoint no-op. Immutable
  segmentation can still preserve a longer matching prefix, but that is an
  architectural expectation, not a measured improvement.
- [DeepSeek Harness at pinned commit
  `47f943859bef60e4160492346772ded9b24f765a`](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a)
  reinforces three client-applicable principles: preserve an append-only
  reusable prefix, put changing material after stable material, and keep
  durable/cold evidence outside the bounded model-visible surface. Its MLA
  serving path, scheduler/eviction behavior, and disk-KV or block-cache
  ownership are provider-side mechanisms and do **not** transfer to this Pi
  client. Harness measurements are not workbench benchmark promises.
- [vLLM Automatic Prefix Caching](https://docs.vllm.ai/en/v0.9.1/design/automatic_prefix_caching.html)
  and [SGLang RadixAttention](https://arxiv.org/abs/2312.07104) support the
  exact-prefix/block-reuse rationale. They do not establish the internals or
  hit rate of either hosted provider used by Pi.
- The MLSys [Prompt Cache paper](https://proceedings.mlsys.org/paper_files/paper/2024/hash/a66caa1703fe34705a4368c3014c1966-Abstract-Conference.html)
  motivates reusable modular prompt segments at the serving layer. It is
  research inspiration only; a Pi client cannot assume hosted server-side
  module placement or eviction control.

The resulting client-side architecture is a synthesis, not a hosted-provider
implementation claim: keep one immutable fixed anchor, append modular immutable
segments, and rebuild them only at rare checkpoints. The same design applies
to Commander, worker, and other; only their byte caps differ. It follows the
common exact-prefix/block-reuse principle while preserving development quality
through strict pairing, bounded state, and fail-closed restoration.

### Warm-prefix auxiliary compaction boundary

Status: `BLOCKED_BY_PI_0_84_2_PUBLIC_API`.

The public surface was rechecked against the official
[Pi v0.84.2 release](https://github.com/earendil-works/pi/releases/tag/v0.84.2)
at [commit `914cf1472e715297caa30db4b9535d534a9eb718`](https://github.com/earendil-works/pi/commit/914cf1472e715297caa30db4b9535d534a9eb718).
Its pinned
[`session_before_compact` contract](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/docs/compaction.md)
can cancel compaction or provide a replacement compaction result. Its public
[extension types](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/core/extensions/types.ts)
do not expose a post-summary provider-payload transform. Pi's
[compaction implementation](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/core/compaction/compaction.ts)
also does not guarantee that a separate auxiliary summary call shares the
original request's cache domain; native summary calls are standalone with
`cacheRetention: "none"` and a fresh `sessionId`. A client implementation
would therefore have to duplicate private authentication, headers, streaming,
retry, and provider-call behavior. The workbench will not reimplement those
internals.
The new capacity preflight is not an auxiliary compactor: it estimates the
actual Pi preparation, blocks only when its conservative envelope estimate is
at or above model capacity, and never supplies a summary. The estimate is not a
formal tokenizer/context-fit proof. Allowed/warned Commander requests still use
native Pi compaction; no warm-prefix auxiliary compactor is claimed here.

This is a structural cache-cooperation contract, not evidence of recovered
provider cache reuse. Only verified provider usage mapped to `cacheRead` is
authoritative. The offline fake provider deliberately reports `cacheRead = 0`,
so offline tests and benchmarks cannot substantiate a hit-rate improvement.
Verify the Pi 0.84.2 repository dependencies (the current tree resolves them),
pass declared gates, deploy with `/reload`, start a new live session, and
measure subsequent Commander and worker provider usage before making any
recovery claim. Current size qualification is limited to Pi's advertised
272,000-token context window for both pinned GPT-5.6 Sol and GPT-5.6 Luna;
`other` and arbitrary 64k/128k model windows are not qualified by the cap
expansion.

## Canary evaluation targets (not guarantees)

These thresholds are go/no-go **evaluation targets**, not promised hit rates,
release evidence, or results already achieved. Evaluate only fresh-session
schema-1.3 rows with exact request correlation, verified usage semantics, a
complete/untruncated source, and no telemetry write gap. The percentage metric
is the cohort's disjoint `cacheReadShare = cacheRead / (input + cacheRead +
cacheWrite)`; do not substitute the older `cacheRead / (input + cacheRead)`
display ratio.

| Cohort | Minimum sample | Overall read-share target | Stable/no-event target | Segment-seal target |
| --- | ---: | ---: | ---: | ---: |
| Commander (`actorRoleCode=1`) | 300 requests | ≥ 82% | ≥ 94% | ≥ 80% |
| Worker (`actorRoleCode=2`) | 1,000 requests | ≥ 78% | ≥ 93% | ≥ 65% |

“Overall” uses the named actor cohort. The two subcohorts require strict-row
filters: “segment-seal” intersects that actor with
`historyProjection.segmentSealed=1`, while “stable/no-event” intersects it with
`historyProjection.eventCode=0`. The current report exposes actor and
projection cohorts separately; it does not fabricate their intersection.

For each actor separately, epoch-checkpoint requests should be no more than 5%
of exact rows, and unattributed stable-zone drift should be zero. A cohort with
non-exact correlation, unknown actor, mixed legacy rows, a non-available read
share, partial sources, or too few requests is **not evaluable**; it does not
pass by treating missing data as zero. Write-share conclusions separately
require write status `1`; unavailable/normalized-absence semantics are not
promoted to presence verification. Commander and worker totals must not be
pooled to hide a regression in either actor.

## Hashing rules

- Canonical hashing: `cache/canonical-hash.ts` — sorted object keys,
  preserved array order, explicit `undefined`, Date and non-JSON values
  rejected. Comparisons always use the canonical JSON form.
- Projection history hashing is a separate v3 JSONL/provider boundary:
  strings are framed losslessly by their exact UTF-16 code units, so a lone
  surrogate cannot collide with U+FFFD. Object properties follow JSON's
  enumeration order (array-index keys ascending, then other string keys in
  insertion order), object `undefined`/function/symbol values are omitted, and
  array holes or `undefined`/function/symbol entries become `null`. Only
  top-level message `timestamp`, `details`, `usage`, and `diagnostics` are
  ignored. Provider-visible roles/content, tool call ids/names/arguments,
  result text/images, error state, and added-tool fields remain hashed,
  including nested fields that happen to use a metadata name.
- Projection canonicalization is explicitly bounded: arrays are at most 32,768
  elements, nesting at most 128 levels, own descriptors at most 32,769 per
  container, and total work at most 262,144 units. Proxies, revoked proxies,
  accessors, custom `toJSON`, cycles, non-plain prototypes, symbols/extra array
  keys, and over-budget structures fail closed without invoking application
  code. These are safety bounds, not cache-hit heuristics.
- System prompt hash = `sha256Hex(prompt)` (same definition as telemetry).
- Tool fingerprint = names (set), order, and schema
  `{name, description, promptSnippet, parameters, promptGuidelines}` in
  active order.
- Mode prefix hash = canonical hash of `{mode, systemPromptHash,
  toolNamesHash, toolOrderHash, toolSchemaHash}` — identical across builds
  for the same mode and resources (tested).
- Resource discovery hash (`stableResourcesHash`) sorts every list
  (skills, prompt templates, gates, recipes, profiles, extensions) by
  normalized name/id before hashing.

## Enforcement points

- `tests/p6-b-stable-prefix.test.ts` — tests covering hash stability,
  order randomization (filesystem/YAML/glob), dynamic-fact isolation,
  per-mode hashes, invalidation classification, payload read-only,
  telemetry-out-of-context, no dynamic tool loader, no tool-search claims.
  The same file carries the historical NRO N1/N2 transition evidence and
  the v0.10.0 read-v3/public-surface transition: current
  read/grep/find tool info is built from the REGISTERED override metadata
  and schemas (`NATIVE_OVERRIDE_METADATA` / `NATIVE_OVERRIDE_PARAMETERS`),
  the current schema/mode fingerprints differ from the pre-NRO fixture with
  names/order unchanged; the separately pinned baseline/current public hashes
  identify the intentional 0.10.0 delta, and repeated same-mode builds are
  deterministic for DEV/AUDIT/VERIFY.
- `/q-cache-doctor` — `prefix_hashes` (current systemPromptHash /
  activeToolNamesHash / activeToolOrderHash / activeToolSchemaHash),
  `same_mode_drift` (same-mode mutation count), `expected_vs_unexpected`,
  `churn` (model/thinking/mode/reload/compaction counts),
  `tool_metadata_static` (dynamic values in tool metadata), plus the P6-A
  checks. Historical checks scan a bounded oldest-archive-to-current window
  across the telemetry rotation set. If a source is corrupt/unavailable or
  oldest records were omitted by the bound, source quality and absence-based
  checks warn; `same_mode_drift` cannot claim a clean stable history from that
  partial observation.
- `/q-cache-report` — `same-mode mutat.` line plus the existing
  expected/unexpected counts.
