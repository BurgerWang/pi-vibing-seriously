# Controlled Worker Delegation

pi-dev-workbench can delegate one bounded implementation task from a
GPT-5.6 Sol commander to a pinned DeepSeek worker without introducing a
standalone agent framework, daemon, queue, or background service.

## Roles

| Role | Model | Authority |
| --- | --- | --- |
| Commander | `openai-codex/gpt-5.6-sol` or `openai/gpt-5.6-sol` | Requirements, cross-cutting architecture, scope, plan, delegate, review the real diff, run gates, make the final judgment |
| Worker | `deepseek/deepseek-v4-flash:max` | Routine local implementation decisions inside the approved contract: concrete design, naming, file structure within scope, production source changes, tests, docs, write-free recipe checks, in-scope repair |

The worker report is never acceptance evidence. Its Verification section
records only commands and observed results; it must not label an acceptance
criterion satisfied, met, passed, accepted, or complete. Only the commander
maps evidence to criteria, runs final gates, and reports the final
PASS/FAIL/BLOCKED/NOT_RUN verdict.

### Responsibility split

| Owned by Sol (never delegated) | Owned by the Worker (inside the approved contract) |
| --- | --- |
| Requirements and acceptance criteria | Concrete design and naming choices |
| Cross-cutting architecture and scope | File structure within the approved paths |
| Plan, delegation, and the actual-diff review | Production source changes, tests, and docs |
| Final verification, recipes/gates, and the verdict | Investigation, write-free recipe checks, in-scope repair |

The worker is expected to implement the complete delegated slice — relevant
investigation, production source changes, tests, docs, requested write-free
recipe checks when available, and repair of in-scope defects it finds —
rather than stopping after a narrow code edit. Everything outside the
approved contract, and every final judgment, belongs to Sol.

## Risk rubric

| Risk | Shape | Delegation |
| --- | --- | --- |
| Low | One contained change with a clear contract (for example a pure helper plus its unit test and a doc line) | Default: delegate as a coherent source+tests+docs vertical slice after minimum repository orientation |
| Medium | Touches several files or modules, but the contract is unambiguous and the paths can be enumerated | Delegate after Sol approves the plan and supplies explicit source/tests/docs paths and observable acceptance criteria |
| High | Requirements are ambiguous or contested, cross-cutting architecture is at stake, policy/security/budget/model/path behavior changes, or the change defines the delegation mechanism itself | Commander-led: Sol owns the decision and implements or repairs directly by default; only explicitly designed bounded support slices (helper code, tests, docs) may be delegated, and it is never the DEV default |

High-risk work is Commander-led, not categorically impossible to delegate:
Sol owns requirements, cross-cutting architecture, and core safety decisions,
and by default implements or repairs high-risk work directly. Sol may still
delegate an explicitly designed bounded support slice of high-risk work — for
example helper code, tests, or docs whose shape Sol has already decided — but
that delegation is never the DEV default and never transfers the decision
itself. When a worker returns a partial or defective slice, Sol reviews the
actual diff and either repairs defects directly or issues another bounded
delegation — the verdict is always Sol's.

## Fresh-worker continuation

Every delegation is a brand-new `--no-session` worker: no worker session is
ever resumed and no worker has memory of any earlier worker's turns. A
worker cannot delegate, so continuation is always a Sol decision. To
continue work after a handoff or a partial slice, Sol:

1. inspects the actual diff and the worker report;
2. writes a new bounded contract whose task text states the current state of
   the worktree and the remaining work;
3. supplies fresh allowed paths, acceptance criteria, and requested
   verification;
4. delegates the next slice (or repairs directly).

The durable state between delegations is the project diff plus recipe/gate
run records — never worker memory and never worker prose.

## One writing worker per worktree

The delegation tool executes sequentially and a worker can never delegate,
so at most one worker writes to a worktree at any time. Sol never starts a
second delegation that could write the same worktree before the first has
returned and its diff has been inspected. Parallel reads are fine; parallel
writes are not supported and must never be attempted.

## Pi-native lifecycle

`workbench_delegate_worker` is a statically registered workbench tool. It is
part of the deterministic DEV tool matrix and absent from AUDIT and VERIFY.
One invocation:

1. checks project trust and the active commander provider/model;
2. validates the structured task contract;
3. starts one short-lived `pi --mode json -p --no-session` child process;
4. pins `--model deepseek/deepseek-v4-flash:max`;
5. streams bounded progress from Pi JSON events;
6. verifies every assistant event reports `deepseek/deepseek-v4-flash`;
7. tracks per-message context tokens against the pinned budget (soft
   handoff / hard stop, see below) and rejects any `compaction_start` event;
8. terminates the child on completion, timeout, parent abort, hard-budget
   stop, or a compaction attempt;
9. returns bounded output, nested model usage, and the budget/compaction
   facts to the parent session.

There is no persistent worker process. The child inherits the user's OS
permissions and provider authentication, just like any other Pi process.

## Worker context-budget protection

The pinned worker runs on a 1,000,000-token context window. The workbench
protects that budget with two thresholds that are model-specific and
independent of the Commander/project compaction reserve:

| Threshold | Tokens | Behavior |
| --- | --- | --- |
| Soft handoff | 800,000 (80%) | The worker role sends one hidden active-loop steer (`display: false`, `deliverAs: "steer"`): stop new implementation, finish a concise handoff, list the remaining work. |
| Hard stop | 900,000 (90%) | The runner terminates the child and the invocation fails closed. |

Context tokens use Pi's normalized usage semantics: a positive
`totalTokens` is authoritative; otherwise the sum of the non-negative
`input + output + cacheRead + cacheWrite`. Malformed, non-finite or
negative values contribute zero — never NaN.

Inside the worker process the extension also cancels
`session_before_compact` (`{ cancel: true }`) so a worker never silently
continues through lossy compaction; the Commander's compaction supplement
behavior is unchanged. Defense in depth: the runner independently parses
`compaction_start` events from the child JSON stream (count + distinct
reasons) and any compaction attempt fails the invocation closed — even if
the child would otherwise exit 0.

The final report exposes the facts: the text appends
`worker budget : max context N / 1000000 (P%) | soft 800000 | hard 900000`
and the structured `details` carry `max_context_tokens`,
`max_context_ratio`, `soft_budget_reached`, `hard_budget_exceeded`,
`compaction_count`, and `compaction_reasons`.

## Task contract

```json
{
  "task": "Implement the already-approved parser change",
  "allowed_paths": ["src/parser/**", "tests/parser.test.ts"],
  "acceptance_criteria": [
    "Invalid input returns a structured error",
    "Existing valid input remains compatible"
  ],
  "verification": ["Run the unit-test recipe"],
  "timeout_seconds": 1800
}
```

Path rules are deliberately simple:

- `README.md` permits exactly one path;
- `src/parser/` permits that subtree;
- `src/parser/**` permits that subtree;
- absolute paths and `..` escapes are refused;
- realpath checks reject symlink escapes and symlink hops outside the approved subtree;
- an empty or malformed path contract fails closed.

The worker can read project files, use structured `edit`/`write` inside the
approved paths, and invoke declared workbench recipes only when their
`writes` list is empty. Free-form `bash` is blocked for workers so source
modifications cannot bypass the structured path check. Recipe declarations
remain trusted-project discipline mechanisms, not a sandbox; a malicious
command can still write despite an empty declaration.

## Enforcement layers

1. **Mode policy:** delegation is advertised only in DEV and hard-denied in
   AUDIT/VERIFY even if another extension re-enables the tool.
2. **Commander identity:** the parent must report model id `gpt-5.6-sol` on
   provider `openai-codex` or `openai`.
3. **Pinned worker identity:** child CLI selection is fixed; provider/model
   drift in assistant events fails the invocation.
4. **Worker role matrix and guard:** `WORKBENCH_AGENT_ROLE=worker` removes
   recursive delegation, free bash, and `workbench_run_gate` from the active
   tool set; the hard guard still blocks them if another extension re-enables
   a denied tool.
5. **Write scope:** child `edit`/`write` calls are checked against the
   parent-approved path contract.
6. **Sequential execution:** the delegation tool uses Pi's sequential tool
   execution mode; parallel writes to one worktree are not supported.
7. **Existing command/path guards:** the normal workbench P5 protections
   still apply inside the child.

These are guardrails, not an OS security boundary. Use a container or VM for
untrusted repositories or unattended automation.

## Required commander workflow

1. Orient in the repository (minimum orientation — enough to define the
   slice) and inspect the current git state.
2. Define observable acceptance criteria and explicit allowed paths for the
   source, tests, and docs of one coherent vertical slice.
3. Delegate only bounded low/medium-risk vertical slices while in DEV;
   high-risk work is Commander-led — Sol implements or repairs it directly by
   default and delegates at most explicitly designed bounded support slices
   (helper code, tests, docs), never the decision itself.
4. Avoid duplicating the worker's routine investigation, but read the actual
   files and diff after the worker returns — the report is never acceptance.
5. Correct defects directly or issue another bounded delegation to a fresh
   worker (see Fresh-worker continuation).
6. Switch to VERIFY.
7. Run declared recipes and the project validation gates.
8. Make the final verdict from persisted evidence, not worker prose.

## Stable-prefix and cache behavior

The tool name, description, schema, prompt snippet, and guidelines are static
and registered in `WORKBENCH_TOOL_NAMES` order. Dynamic task facts are sent
in the child user message, not injected into the parent system prompt.
Adding this tool intentionally changes the DEV tool-schema fingerprint once;
after reload, same-mode fingerprints remain stable. DeepSeek usage is
returned as nested tool usage and the child workbench can continue using the
existing hash-only cache telemetry.

The tool result surfaces the worker's aggregated cache usage so the
commander can judge cache health without opening telemetry files:

- the final text appends a deterministic cache summary line
  (`worker cache : uncached input 10 | cache read 20 | hit ratio 67%`);
- the structured `details` include the aggregated `usage` and a nullable
  `cache_hit_ratio` (`cacheRead / (input + cacheRead)` over the whole run);
- the top-level tool `usage` is preserved unchanged;
- a worker that reports no input at all (zero denominator) renders
  `hit ratio N/A` and `cache_hit_ratio: null` — never NaN or a fabricated
  number.

On the commander side, GPT-5.6 Sol's own usage (`apiKind`
`openai-codex-responses`) is a verified Responses-style semantic in the
cache telemetry, so the Sol session footer shows a numeric `CACHE` segment
(ratio, read, miss) instead of `CACHE N/A` whenever Codex reports cache
reads.

## Split session-cost observability

The worker's nested usage is returned as `toolResult` usage on the
`workbench_delegate_worker` call, and the workbench cost observability
classifies exactly that tool name into a dedicated worker bucket, so the
commander can see the worker's cost separately from its own:

- `S` (commander): assistant-message usage, grouped per
  `provider/responseModel ?? model`;
- `W` (worker): `toolResult` usage whose `toolName` is
  `workbench_delegate_worker`;
- `O` (other): every other `toolResult` usage plus `branch_summary` and
  `compaction` usage.

The status line shows `COST S:$… W:$… O:$…` (O omitted when zero, S and W
always shown) and `/q-cost-status` prints the exact amounts and the
per-model commander breakdown — both are session-entry facts only. The
buckets reconcile exactly with Pi's own footer aggregation (malformed or
non-finite usage contributes zero, never NaN).

## Failure behavior

The tool fails rather than silently falling back when:

- the commander is not GPT-5.6 Sol;
- the child cannot start;
- the pinned model is unavailable;
- an assistant event reports another provider/model;
- an assistant event reaches the 900,000-token (90%) hard context budget;
- the child emits any `compaction_start` event (a compaction attempt);
- the child exits non-zero, times out, or is aborted;
- the child reports an error/aborted stop reason;
- no verified final text response is produced.

Stderr and model-visible output are bounded with Pi's standard limits. Full
child transcripts are not copied into workbench run records; the durable
source-change and validation evidence remains the project diff plus existing
recipe/gate run records.
