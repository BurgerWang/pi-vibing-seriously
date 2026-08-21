---
name: handoff-and-release
description: Explicit specialist for a requested handoff or release. Produce concise continuation notes, changelog/version updates, and release-only verification; do not invoke after every ordinary implementation slice.
disable-model-invocation: true
---

# Handoff and Release

## Handoff notes

Write down, in one place:

1. **What changed** — the user-visible and structural changes, with file
   paths.
2. **How to verify** — the exact commands (or declared recipes) that prove
   the work, and what output means success.
3. **What was deliberately not done** — open items, deferred work, known
   limitations.
4. **Assumptions and risks** — decisions made under ambiguity and what could
   break.
5. **How to continue** — the next logical step for the next person.

## Changelog discipline

- Update the changelog in the same change that ships the behavior, not at
  release time from memory.
- User-facing changes only: added/changed/fixed/removed, one line each,
  plain language.
- Note breaking changes explicitly with the migration path.

## Release process

1. Run the declared release gate or full suite because this section applies
   only to an actual release candidate.
2. Check the working tree is clean and version/tag state is understood.
3. Bump the version per the project's versioning convention; changelog
   updated; version referenced consistently (manifest, docs).
4. Verify the release artifact: clean build, install-from-artifact smoke
   test if applicable.
5. Tag/release only if explicitly asked — never publish or push without
   instruction.

## Conditional references

- Read [references/handoff-template.md](references/handoff-template.md) only
  when another session or person must continue the work.
- Read [references/release-checklist.md](references/release-checklist.md) only
  for a real release candidate.
