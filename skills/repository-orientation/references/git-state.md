# Git state investigation

Run these read-only commands and record their exact output.

```text
git status                 # branch + dirty/untracked state
git log --oneline -5       # recent history
git branch --show-current  # current branch (empty when detached)
```

## What to report

- Branch name (or "detached HEAD").
- Whether the work tree is dirty, and which files differ.
- Whether there are untracked files that matter (new modules, config).
- The most recent commit subject, for context.

## Rules

- Never run anything that mutates git state during orientation
  (`git reset`, `git clean`, `git checkout` are out).
- If the directory is not a git repo, say so — do not assume.
- `git log` in a repo with no commits prints an error; report "no commits"
  rather than treating it as a failure.
