---
name: repository-audit
description: Primary read-only workflow for an audit or code review. Inspect the requested scope, report evidence-backed findings by severity and confidence, and do not apply fixes unless the user also requests implementation.
---

# Repository Audit

Goal: a concise, defensible findings report for the requested scope.

## Process

1. **Scope** — state what is audited (paths, commits, or claims) and what is
   out of scope. Audit only that scope.
2. **Collect evidence** — read the relevant code and run bounded read-only
   checks. Cite the strongest evidence for each finding; do not dump all
   command output.
3. **Classify** — every finding is one of:
   - **confirmed** — directly observed (code path, output, file content);
   - **probable** — strongly implied by evidence but not directly observed
     (say what evidence is missing);
   - **unknown** — cannot determine from available evidence (say what would
     resolve it).
4. **Assign severity** — high / medium / low, with a one-line justification
   (impact, likelihood, blast radius).
5. **Suggest fixes** — prose only for an audit-only request. If the user asks
   to audit and fix, finish the audit phase and then switch once to
   `skill:implementation-workflow` for confirmed findings.
6. **Report coverage** — list what was checked and what was NOT checked
   (NOT_RUN). An audit that does not state its coverage invites false trust.

## Rules

- Read-only: no edits, no writes, no mutating commands.
- A claim without evidence is not a finding — it is an open question.
- Do not mix edits into the evidence-collection phase.
- Distinguish "the code does X" (observed) from "the code should do Y"
  (judgment) — both are useful, but label them differently.

## Conditional references

- Read [references/audit-checklist.md](references/audit-checklist.md) only for
  a repository-wide or cross-cutting audit.
- Read [references/findings-report.md](references/findings-report.md) only
  when several findings need a formal report.
