# Release checklist

## Before release

- [ ] Typecheck passes (exact command recorded).
- [ ] Full test suite passes (counts recorded).
- [ ] Build passes and the artifact is produced where documented.
- [ ] Working tree is clean or the dirty files are understood.
- [ ] Changelog updated with user-facing changes for this release.
- [ ] Version bumped per convention, consistently across manifest/docs.
- [ ] Breaking changes documented with migration notes.
- [ ] Help text / README examples match the released behavior.

## Artifact verification

- [ ] Clean build from a fresh checkout (or fresh install) succeeds.
- [ ] Install-from-artifact smoke test: the installed tool runs `--help` and
      one happy-path invocation.
- [ ] No secrets or local paths embedded in the artifact.

## Publishing (only when explicitly asked)

- [ ] Tag and/or publish command stated; nothing pushed without instruction.
- [ ] Post-release: record what was released and where.
