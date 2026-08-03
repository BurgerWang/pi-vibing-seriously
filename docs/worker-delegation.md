# Controlled Worker Delegation

pi-dev-workbench can delegate one bounded implementation task from a
GPT-5.6 Sol commander to a pinned DeepSeek worker without introducing a
standalone agent framework, daemon, queue, or background service.

## Roles

| Role | Model | Authority |
| --- | --- | --- |
| Commander | `openai-codex/gpt-5.6-sol` or `openai/gpt-5.6-sol` | Inspect, plan, define scope, delegate, review the real diff, run gates, make the final judgment |
| Worker | `deepseek/deepseek-v4-flash:max` | Implement one approved task and run declared development recipes |

The worker report is never acceptance evidence. Only the commander may run
final gates and report the final PASS/FAIL/BLOCKED/NOT_RUN verdict.

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
7. terminates the child on completion, timeout, or parent abort;
8. returns bounded output and nested model usage to the parent session.

There is no persistent worker process. The child inherits the user's OS
permissions and provider authentication, just like any other Pi process.

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

1. Orient in the repository and inspect the current git state.
2. Define acceptance criteria and explicit allowed paths.
3. Delegate only the implementation step while in DEV.
4. Read the actual files and diff after the worker returns.
5. Correct defects directly or issue another bounded delegation.
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

## Failure behavior

The tool fails rather than silently falling back when:

- the commander is not GPT-5.6 Sol;
- the child cannot start;
- the pinned model is unavailable;
- an assistant event reports another provider/model;
- the child exits non-zero, times out, or is aborted;
- the child reports an error/aborted stop reason;
- no verified final text response is produced.

Stderr and model-visible output are bounded with Pi's standard limits. Full
child transcripts are not copied into workbench run records; the durable
source-change and validation evidence remains the project diff plus existing
recipe/gate run records.
