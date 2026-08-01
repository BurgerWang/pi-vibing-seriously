---
name: repository-audit
description: Systematic read-only audit of code or repository state — collect evidence, classify findings as confirmed/probable/unknown, assign severity, and suggest fixes without applying them. Use when reviewing an existing codebase, a merge request, or a claim that code "looks fine".
---

# Repository Audit

Goal: a defensible findings report. Everything is evidence-backed, nothing is
changed. This skill is for review; use `skill:implementation-workflow` when
the task is to change code, and `skill:validation-ladder` when the task is to
verify specific claims.

## Process

1. **Scope** — state what is audited (paths, commits, or claims) and what is
   out of scope. Audit only that scope.
2. **Collect evidence** — read the code and run read-only commands. Record
   exact file paths, line numbers, and command output for every finding.
3. **Classify** — every finding is one of:
   - **confirmed** — directly observed (code path, output, file content);
   - **probable** — strongly implied by evidence but not directly observed
     (say what evidence is missing);
   - **unknown** — cannot determine from available evidence (say what would
     resolve it).
4. **Assign severity** — high / medium / low, with a one-line justification
   (impact, likelihood, blast radius).
5. **Suggest fixes** — prose only. Never apply them during the audit.
6. **Report coverage** — list what was checked and what was NOT checked
   (NOT_RUN). An audit that does not state its coverage invites false trust.

## Rules

- Read-only: no edits, no writes, no mutating commands.
- A claim without evidence is not a finding — it is an open question.
- Do not fix while auditing; fixing changes the thing under review.
- Distinguish "the code does X" (observed) from "the code should do Y"
  (judgment) — both are useful, but label them differently.

## Details

- See [references/audit-checklist.md](references/audit-checklist.md) for the
  systematic checklist (build, tests, config, dependencies, error handling,
  dead code, documentation drift).
- See [references/findings-report.md](references/findings-report.md) for the
  report format and classification rules.
