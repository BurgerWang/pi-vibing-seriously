---
name: validation-ladder
description: Structured verification with verdicts PASS, FAIL, BLOCKED, or NOT_RUN. Never report unrun checks as passed and never treat agent self-reports as evidence. Use when reviewing or verifying completed work.
---

# Validation Ladder

## Verdicts

- **PASS** — observable evidence satisfies the check: exact command output,
  file content, or test result.
- **FAIL** — observable evidence contradicts the check.
- **BLOCKED** — the check cannot run; name the missing prerequisite
  (dependency, access, environment).
- **NOT_RUN** — not executed. Never described as passed.

## Rules

1. Every verdict requires evidence: exact command + output, or file path +
   content.
2. Agent self-reports are hypotheses, not evidence.
3. An unrun check is NOT_RUN, never PASS.
4. Produce at least one verdict per requirement or claim.
5. A BLOCKED verdict must name the missing prerequisite.
6. In VERIFY mode, run checks only through declared recipes or read-only
   tools — never modify source to make a check pass.

## Output Format

| Check | Verdict | Evidence |
| ----- | ------- | -------- |

Add a short evidence block after the table: the exact command, its key
output, or the file path + excerpt that supports each verdict.

## Details

- See [references/verdict-evidence.md](references/verdict-evidence.md) for
  what counts as evidence per verdict class, with examples.
- See [references/verification-practice.md](references/verification-practice.md)
  for running verifications against completed work and writing the final
  report.
