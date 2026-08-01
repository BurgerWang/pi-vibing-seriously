---
description: Turn a goal into an executable phased plan — each phase has a verifiable Gate, sequencing, risks, and open questions. Analysis and planning only; do not modify code.
argument-hint: "<goal>"
---

# Plan

Goal: $ARGUMENTS

Plan only. Do NOT modify any file, stage changes, or run commands that
mutate anything.

## Deliverables

1. **Goal restatement** — the acceptance criteria the plan leads to.
2. **Phases** — executable stages in dependency order. Each phase:
   - has a single purpose and a concrete deliverable;
   - names the files/commands/recipes it touches (no code changes now);
   - ends with a **Gate**: a verifiable check (command, test, or artifact)
     that must pass before the next phase starts.
3. **Sequencing rationale** — why this order; what blocks what.
4. **Risks and open questions** — per phase, what could go wrong and what
   information is still missing.
5. **Verification plan** — how each Gate will be run (declared recipes
   preferred) and what output means the Gate passed.

## Constraints

- This is a plan, not an implementation. No code, no edits, no writes.
- Every Gate must be checkable by a concrete command or artifact — a Gate
  you cannot verify is a wish, not a gate.
- State assumptions explicitly; do not guess silently.

## Process

- Use the skill:implementation-workflow contract and scope discipline for
  the phase design.
- Use the skill:validation-ladder verdicts to define what each Gate
  requires to pass.
