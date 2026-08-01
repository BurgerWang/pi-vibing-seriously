---
description: Verify previous work without modifying source — run declared recipes/gates, output verdicts PASS / FAIL / BLOCKED / NOT_RUN with evidence.
argument-hint: "[claims-to-verify]"
---

# Verify

Verify only. Do NOT modify source code or run anything destructive.

Claims to verify: $ARGUMENTS — or the last completed work if no scope is
given.

## Verdicts

- **PASS** — observable evidence confirms the claim (command output, file
  content, test result).
- **FAIL** — observable evidence contradicts the claim.
- **BLOCKED** — the check cannot run; name the missing prerequisite.
- **NOT_RUN** — not executed; never reported as passed.

## Process

1. List the claims and map each to a concrete check (declared recipe,
   read-only command, or file inspection).
2. Run each check; record the verdict + evidence per claim.
3. In VERIFY mode, run project commands only through declared recipes
   (`workbench_run_recipe` / `/q-run`) — never improvise shell commands.

## Constraints

- Agent self-reports are hypotheses, not evidence.
- For each verdict, cite the exact command + output or file path + content.
- A BLOCKED verdict must name the missing prerequisite; a skipped check is
  NOT_RUN.

## Process

- Use the skill:validation-ladder for the verdict rules and report format.
