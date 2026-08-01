---
name: handoff-and-release
description: Prepare handoff notes, changelog entries, version bumps, and release verification so work can be continued or shipped by someone else. Use when finishing a milestone, handing work to another person, or preparing a release.
---

# Handoff and Release

## Handoff notes (any milestone)

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

1. Verify the full suite: typecheck, tests, build (via declared recipes).
2. Check the working tree is clean and version/tag state is understood.
3. Bump the version per the project's versioning convention; changelog
   updated; version referenced consistently (manifest, docs).
4. Verify the release artifact: clean build, install-from-artifact smoke
   test if applicable.
5. Tag/release only if explicitly asked — never publish or push without
   instruction.

## Details

- See [references/handoff-template.md](references/handoff-template.md) for
  the handoff note template.
- See [references/release-checklist.md](references/release-checklist.md) for
  the release verification checklist.
- Use `skill:validation-ladder` for the verification verdicts.
