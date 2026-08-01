# Orientation checklist

Work through these in order. Record each finding as `path — fact`, and mark
anything you could not check as NOT_CHECKED.

## 1. Git state

- `git status` — branch, staged/unstaged/untracked files.
- `git log --oneline -5` — recent history shape (conventional commits,
  squashes, merges).
- Is the work tree dirty? Note it in every later report — it changes what
  "the current state" means.

## 2. Project manifest and entry points

Look for a manifest and read it before anything else:

- Node/TS: `package.json` (`main`, `exports`, `bin`, `scripts`), plus
  `tsconfig.json` include/outDir.
- Rust: `Cargo.toml` (`[[bin]]`, `[lib]`, `[dependencies]`).
- Go: `go.mod`, `cmd/` layout, `main` packages.
- Java/Kotlin: `pom.xml` or `build.gradle`, main class / application plugin.
- C/C++: `CMakeLists.txt`, `Makefile`, `meson.build`.
- Anything else: look for README's "Getting started" section, then verify
  each claim against the actual manifest.

Record: the exact command to build and the exact command to run the program.

## 3. Dependencies

- Runtime vs development dependencies, and where they are declared.
- Any lockfile (`package-lock.json`, `Cargo.lock`, `go.sum`, ...) — its
  presence tells you installs are reproducible.
- Vendor/workspace structure (monorepo workspaces, submodules, crates).

## 4. Tests

- Which runner and which directory layout (co-located specs vs `tests/`).
- How to run the whole suite and how to run a single test file/case.
- Do the tests need fixtures, network, or credentials? Note it.

## 5. Configuration and tooling

- Build config, linters, formatters, pre-commit hooks, CI workflow files
  (`.github/workflows/`, `.gitlab-ci.yml`, ...).
- Workbench config if present: `.pi/workbench/{project,recipes,gates}.yaml`
  — declared recipes are the sanctioned project commands.

## 6. Layout

- Top-level directory tree (2 levels is usually enough).
- Module boundaries: what lives where, what depends on what (inferred from
  imports, not assumed).

## Output template

```text
git        : <branch> @ <short-sha> (dirty/clean)
build      : <command>   (from <manifest path>)
run        : <command>   (from <manifest path>)
tests      : <command>   (<layout>)
config     : <files>
layout     : <2-level tree summary>
not checked: <anything skipped or unverifiable>
```
