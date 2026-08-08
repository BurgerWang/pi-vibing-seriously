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
| Pi's fixed system prompt | Pi itself | the workbench never modifies it (`before_agent_start`/`context` return nothing) |
| Workbench static rules | AGENTS.md, project rules | loaded by Pi; never rewritten per turn |
| Extension registration order | `package.json` `pi` arrays | static file content |
| The current mode's fixed tool list | `core/mode-policy.ts` `MODE_TOOLS` | explicit constant arrays (tested) |
| Tool name/label/description/schema | `core/tool-catalog.ts` | single static catalog; registerTool spreads it (tested) |
| Native override metadata/schemas | `core/native-tool-policy.ts` | static `NATIVE_OVERRIDE_METADATA` / `NATIVE_OVERRIDE_PARAMETERS`; `read`/`find` schemas byte-identical to the Pi 0.83.0 built-ins, `grep` appends exactly the two optional count selectors (`output`, `count_kind`); metadata is the built-in strings verbatim plus the §6.4 guideline bullets (`read`'s one and its grep mirror) and the grep count-mode description sentence; no dynamic facts (tested) |
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

## What the workbench audited (and what it does not do)

Audited hooks: `before_agent_start`, `context`, system prompt hooks,
compaction hooks, AGENTS/context loading, skills discovery, prompt template
discovery.

- **No per-turn system prompt rewrites.** The workbench never returns a
  system prompt from `before_agent_start` and never listens to context
  mutation events. `ctx.getSystemPrompt()` is only ever READ, for telemetry
  hashes and `/q-cache-doctor`.
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
- **The `context` event is not used** for cache observation.

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
  (`NATIVE_OVERRIDE_METADATA` / `NATIVE_OVERRIDE_PARAMETERS`): `read` and
  `find` schemas are byte-identical to the Pi 0.83.0 built-ins, `grep`
  appends exactly the two optional count selectors (`output`, `count_kind`)
  after its byte-identical legacy property prefix; the metadata is the
  built-in strings verbatim plus exactly the two §6.4 guideline bullets (the
  ONE on `read` — `READ_PREVIEW_GUIDELINE` — and its grep mirror —
  `GREP_COUNT_GUIDELINE`) and the grep count-mode description sentence;
  `find` keeps the built-in strings verbatim; no dynamic facts ever appear
  (the same static-metadata audit as the catalog tools).
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
mode/write inventory are unchanged. N1 is the read-preview slice: a text
`read` WITHOUT `offset`/`limit` returns the complete content byte-for-byte
plus the deterministic frozen nine-fact `nro-read-facts:` trailer, or a
deterministic preview at the fixed caps (240 lines / 12 KiB / 2048-byte
per-line representation) with the facts; legacy `offset`/`limit` reads,
images (attachment or the built-in text-only note), errors and abort stay
byte-identical to the built-in; `details` is undefined when complete and
exactly a valid `TruncationResult`-only object when truncated. N2 is the
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
  The same file carries the NRO N1/N2 transition evidence: current
  read/grep/find tool info is built from the REGISTERED override metadata
  and schemas (`NATIVE_OVERRIDE_METADATA` / `NATIVE_OVERRIDE_PARAMETERS`),
  the current schema/mode fingerprints differ from the pre-NRO
  pristine-built-in fixture exactly once (the combined N1/N2 transition)
  with names/order unchanged, and repeated same-mode builds are
  deterministic for DEV/AUDIT/VERIFY.
- `/q-cache-doctor` — `prefix_hashes` (current systemPromptHash /
  activeToolNamesHash / activeToolOrderHash / activeToolSchemaHash),
  `same_mode_drift` (same-mode mutation count), `expected_vs_unexpected`,
  `churn` (model/thinking/mode/reload/compaction counts),
  `tool_metadata_static` (dynamic values in tool metadata), plus the P6-A
  checks.
- `/q-cache-report` — `same-mode mutat.` line plus the existing
  expected/unexpected counts.
