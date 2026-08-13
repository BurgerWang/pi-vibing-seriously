# Stable Prefix Contract (P6-B)

DeepSeek's prompt cache is a **full-prefix cache**: a request is only billed
cache reads when the entire prefix — system prompt, tool definitions, and
message history — is byte-identical to a previously cached prefix. The
workbench therefore formalizes which parts of the model-request input may
vary and which must stay byte-identical, and enforces that split in code and
tests.

This contract is the P6-B companion to the P6-A telemetry docs
(`cache-telemetry.md`) and the provider-facts doc
(`deepseek-prompt-cache.md`). Read `cache-efficient-workflow.md` for the
day-to-day workflow rules that follow from this contract.

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
4. **Telemetry hash metadata** — hashes of dynamic facts in telemetry
   records, never their text.
5. **Normal chat messages** — the compaction supplement note
   (`workbench-compact-note`, bounded, redacted, display:false).
6. **Context projection** — a deterministic runtime transform may replace
   older complete assistant-tool bundles with bounded descriptors before a
   provider request. It never changes the system prompt or tool definitions.
   The projection is frozen into a discrete epoch: inside that epoch the
   provider-visible history is append-only.

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
- **`before_provider_request` stays read-only.** It produces a structural
  digest in memory; the payload and headers are never mutated (tested).
- **The `context` event is enforcement, not cache observation.** Below the
  hard ceiling it returns the raw history unchanged. A hard-ceiling crossing
  starts one projection epoch at the 75% tool-text / 96-bundle low watermark;
  later requests replay that exact frozen projection and append the untouched
  raw suffix. A new epoch begins only when the combined projected prefix and
  suffix reaches a hard ceiling, or when a branch/compaction/policy mismatch
  invalidates the frozen boundary. The epoch transition is one expected cache
  invalidation (`HISTORY_PROJECTION_EPOCH_CHANGED`); ordinary append-only
  turns inside it are not `CONTEXT_PREFIX_DIVERGED`. Tool/system stable-zone
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
| DEV commander | read, grep, find, ls, bash, edit, write + all 11 workbench tools | (none beyond the global guards) |
| DEV strict Sol (`worker-first-strict`) | read, grep, find, ls + all 11 workbench tools (exact canonical 15; an ACTIVE user lease adds edit/write → 17) | bash always; edit/write without an ACTIVE user-issued lease or outside its paths; any foreign tool |
| DEV worker child | DEV commander set minus bash, workbench_run_gate, workbench_delegate_worker | bash, workbench_run_gate, workbench_delegate_worker; edit/write also require approved paths |

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
mode must then be stable. Runtime history projection changes the normal
message-history prefix only at a discrete epoch transition. Within that epoch
the provider-visible prefix is append-only; neither a normal appended message
nor replaying the frozen projection is classified as prefix divergence. These
guarantees do not alter the stable-zone tool hashes.

## History-projection epochs

The active-history hard ceilings remain **96 KiB for Commander**, **64 KiB
for worker/other roles**, and **128 complete assistant/tool-result bundles**.
The projection controller adds hysteresis without weakening those limits:

| Role | Hard tool text | Epoch low-water tool text | Hard bundles | Epoch low-water bundles |
| --- | ---: | ---: | ---: | ---: |
| Commander | 96 KiB | 72 KiB (75%) | 128 | 96 |
| Worker / other | 64 KiB | 48 KiB (75%) | 128 | 96 |

When raw history first exceeds a hard ceiling, the complete current prefix is
projected once to the low watermark and its numeric/hash-only epoch state is
stored as `workbench-history-projection-state-v1`. The runtime deterministically
recreates that same prefix and appends new raw messages until another hard
crossing. Reload/resume restores a strict state entry; branching and completed
compaction reset it. Invalid call/result pairing still fails closed and never
emits an orphaned tool message.

This is a structural cache-cooperation contract, not evidence of a recovered
provider hit rate. Provider cache reuse remains best-effort and must be
measured from subsequent real requests.

## Hashing rules

- Canonical hashing: `cache/canonical-hash.ts` — sorted object keys,
  preserved array order, explicit `undefined`, Date and non-JSON values
  rejected. Comparisons always use the canonical JSON form.
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
