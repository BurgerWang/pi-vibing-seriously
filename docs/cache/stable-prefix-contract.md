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
| AUDIT | read, grep, find, ls, workbench_project_inspect, workbench_read_run, workbench_read_gate, workbench_list_gates, workbench_compare_runs | bash, edit, write, workbench_run_recipe, workbench_run_gate, workbench_delegate_worker |
| VERIFY | read, grep, find, ls + the 7 inspection/recipe/gate/comparison tools | bash, edit, write, workbench_delegate_worker |
| DEV commander | read, grep, find, ls, bash, edit, write + all 8 workbench tools | (none beyond the global guards) |
| DEV worker child | DEV commander set minus bash, workbench_run_gate, workbench_delegate_worker | bash, workbench_run_gate, workbench_delegate_worker; edit/write also require approved paths |

The worker-role reduction is deterministic and applied inside the same single
`setActiveTools` call. It is fixed for the lifetime of the child process; no
per-turn tool loading occurs. Adding the delegate tool changes the commander
DEV schema fingerprint once on package reload, after which the prefix remains
stable.

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
- `/q-cache-doctor` — `prefix_hashes` (current systemPromptHash /
  activeToolNamesHash / activeToolOrderHash / activeToolSchemaHash),
  `same_mode_drift` (same-mode mutation count), `expected_vs_unexpected`,
  `churn` (model/thinking/mode/reload/compaction counts),
  `tool_metadata_static` (dynamic values in tool metadata), plus the P6-A
  checks.
- `/q-cache-report` — `same-mode mutat.` line plus the existing
  expected/unexpected counts.
