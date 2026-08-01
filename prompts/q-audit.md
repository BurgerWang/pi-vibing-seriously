---
description: Audit-only review of code or repository state — inspect and report with evidence, make no changes. Findings classified as confirmed / probable / unknown.
argument-hint: "[scope]"
---

# Audit

Audit only. Do NOT modify any file, stage changes, run destructive commands,
or commit/push.

Scope: $ARGUMENTS — or the whole repository if no scope is given.

## Deliverables

1. **Findings** — each with evidence: exact file paths, line numbers, and
   relevant command output.
2. **Classification** — for every finding, one of:
   - **confirmed** — directly observed (code path, output, file content);
   - **probable** — strongly implied but not directly observed (name the
     missing evidence);
   - **unknown** — cannot determine from available evidence (name what
     would resolve it).
3. **Severity** — high / medium / low, each with a one-line justification.
4. **Suggested fixes** — described in prose, never applied.
5. **Coverage** — what was checked and what was NOT checked (mark as
   NOT_RUN).

## Constraints

- Read-only tools only. No edits, no writes, no bash that mutates anything.
- If a claim cannot be evidenced, say so explicitly — a claim without
  evidence is an open question, not a finding.

## Process

- Use the skill:repository-audit workflow and checklist.
- Report verdicts per the skill:validation-ladder format for anything you
  verified.
