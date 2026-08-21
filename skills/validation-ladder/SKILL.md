---
name: validation-ladder
description: Formal verification workflow for explicit acceptance, gate, release, or audit verdicts. Use PASS, FAIL, BLOCKED, and NOT_RUN with direct evidence; do not invoke for ordinary development feedback.
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
4. Group related claims when one check proves the same boundary; do not create
   ceremonial verdict rows for every sentence.
5. A BLOCKED verdict must name the missing prerequisite.
6. In VERIFY mode, run checks only through declared recipes or read-only
   tools — never modify source to make a check pass.

## Proportionate execution

- Verify the narrow affected boundary first.
- Run a full suite only when the requested verdict covers the whole product,
  the change is cross-cutting, or a declared gate/release requires it.
- A focused PASS proves only its stated scope.

## Output format

| Check | Verdict | Evidence |
| ----- | ------- | -------- |

Use the table only when multiple verdicts improve clarity. A single concise
verdict with its exact evidence is sufficient for one claim.

## Conditional references

- Read [references/verdict-evidence.md](references/verdict-evidence.md) when
  evidence provenance is ambiguous.
- Read [references/verification-practice.md](references/verification-practice.md)
  for a multi-check formal verification or release report.
