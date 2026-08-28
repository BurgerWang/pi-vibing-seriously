# Project onboarding

How to install, initialize, and use pi-dev-workbench in a project — the
short path from zero to a gated workbench project.

## 1. Install the package

Requirements: Node.js, npm, and Pi. The released v0.10.0 live baseline used
Node v24.13.0 / npm 11.18.0 / Pi 0.83.0; current unreleased source and tests
pin Pi 0.84.2, while a new live TUI/print/JSON release matrix is still pending.
See [compatibility.md](compatibility.md) for the separated evidence scopes.

```bash
npm install --ignore-scripts   # devDependencies (TS, tsx, pi types) + yaml runtime dep
pi install -l .                # register this package in project settings
pi -a -p "/q-status"           # smoke: extension loads and responds
```

## 2. Initialize a project

Enter the project directory, start Pi, approve project trust, then:

```
/q-init generic
/q-init quant-research/stock-selection
/q-init quant-research/market-timing
```

`/q-init` shows the files it will write **before** writing anything. Existing
files — including an existing `AGENTS.md` — are never overwritten by default
(overwrites require per-file confirmation, skipped entirely in print/json
modes). The `hft`, `market-making`, `lob`, and `execution-engine` profiles
are rejected by design.

The apply step binds every overwrite confirmation to the same bounded regular
file identity and content digest, rejects leaf symlinks, and creates new files
exclusively. New bytes are written and fsynced in a no-follow sibling temporary
first; create publishes with a no-clobber hard link, overwrite revalidates the
confirmed bytes/inode/metadata and then atomically renames, and the parent
directory is synced. A failure therefore leaves no target/complete old bytes,
or a complete new target, never a partially truncated file. Parent directories
are revalidated as real in-project directories before and after the write.
Standard Node path APIs cannot provide Linux
`openat2(RESOLVE_BENEATH)` semantics against a privileged process that swaps an
ancestor directory concurrently, nor a portable compare-and-swap rename in the
last identity-check-to-rename interval; do not run `/q-init` while another
process is mutating the project directory tree.

For `generic`, initialization detects the repository's top-level stack and
only emits observable, project-declared entry points: Node recipes come from
scripts present in `package.json` and must still be reviewed before first use;
Go uses `-mod=readonly`; Rust requires a committed lockfile and uses `--locked`.
Conflicting Node lockfiles, unknown stacks, Python projects without a
project-declared test command, and Rust projects without a lockfile remain
explicitly `NOT_CONFIGURED` with `recipes: []`—edit that file rather than
inheriting fictional commands. The preview names the selected preset, and
apply writes that exact content snapshot.

**Then exit Pi, re-enter the project, and approve project trust.** Config is
only read and recipes only run under trust.

## 2b. Nested projects (`project_dir`)

A repository that hosts several research projects (or a repo whose
configuration lives in a subdirectory) can point the workbench at one
nested directory via `project.yaml`:

```yaml
name: stock-selection-research
profile: quant-research/stock-selection
project_dir: research/stock-selection
```

Boundaries:

- `project_dir` is **relative** to the repository root. POSIX absolute
  (`/x`) and Windows absolute (`C:\x`, `C:/x`, `\x`, `\\server\share`,
  `C:x`) values, `..` escapes, symlink escapes, missing paths and
  non-directories are rejected: each becomes a `project.yaml` config issue
  (visible in `workbench_project_inspect`) and the workbench falls back to
  the repository root. The effective root never points outside the
  repository and nothing outside it is ever read. Symlinks that stay inside
  the repository are accepted.
- The effective root only affects **stack detection** (top-level
  language/package-manager files) and **gate file-type content checks**
  (`kind: file` and the files read by `json` / `numeric` / `schema`
  checks; resolved relative to the effective root, symlink-checked). The
  one exception is the built-in b0.4 check ("Required workbench files
  present"): it anchors at the repository root via internal catalog-only
  metadata (gates.yaml cannot set `root` or `file_root`), because the
  workbench configuration always lives at the repository root — a nested
  `.pi/workbench` never satisfies it.
- Everything else stays at the repository root: `.pi/workbench` config,
  run records, git state, delegation, recipe execution and recipe `cwd`
  semantics. Omitted (or `"."`), the effective root is the repository
  root — existing projects keep their exact behavior.
- `workbench_project_inspect` shows both roots (`project root` and
  `effective root`) explicitly.

## 3. Declare recipes

Add argv-array recipes to `.pi/workbench/recipes.yaml`. The model can only
request recipes by name plus schema-declared parameters — never an arbitrary
command:

```yaml
recipes:
  - name: backtest
    description: Run the stock-selection backtest
    command: ["python", "scripts/backtest.py", "--symbol", "{{symbol}}"]
    cwd: "."
    timeout_ms: 600000
    allowed_modes: [DEV, VERIFY]
    expected_exit_codes: [0]
    writes: ["data/", "results/"]
    artifacts:
      - path: "results/**/*.json"
        required: true
        min_count: 1
        min_bytes: 1
        freshness: immutable-snapshot
        snapshot: true
    params:
      - { name: symbol, type: string, required: true }
```

Object entries are the v2 authority form. A successful process is still a
failed recipe when a required artifact is absent, outside its count/byte/hash
bounds, or cannot be identified safely. `freshness: current` rehashes the
project file whenever a gate consumes it; `immutable-snapshot` stores and
verifies a content-addressed copy in the committed run. Historical string
globs remain runnable as legacy optional output discovery, but cannot satisfy
an artifact gate.

External artifacts require both an explicit recipe contract and an explicit
trusted-project mapping:

```yaml
# .pi/workbench/project.yaml
artifact_external_roots:
  warehouse: /absolute/authorized/export/root

# one recipe artifact entry
artifacts:
  - { path: "exports/*.json", root: authorized-external, external_root: warehouse, required: true, freshness: current }
```

The runner resolves the configured root without symlinks and performs an
independent child-process identity probe before publishing the run. Gate
consumption repeats the current-state probe.

## 4. Run the validation ladder

```
/q-gates             # what gates exist for this profile
/q-gate b0           # run the project-readiness gate
/q-gate base         # all base gates
/q-gate quant        # all quant gates (quant profiles)
/q-gate q1,q2        # a chain; prerequisites resolve first
```

Gates form a ladder: B0-B6 (every profile) and Q0-Q5 (quant-research
profiles). A non-PASS blocking prerequisite BLOCKs its dependents. Manual
checks take evidence through `manual:<check-id>=<note>`; that evidence is
recorded as type `manual` only — model prose can never masquerade as machine
verification.

## 5. Workbench workflow

| Step | How |
| ---- | --- |
| Switch mode | `/q-mode-audit` / `/q-mode-dev` / `/q-mode-verify` |
| Inspect project | `/q-status`, `workbench_project_inspect` |
| Run a recipe | `/q-run <recipe> [key=value ...]` or `workbench_run_recipe` |
| List/show runs | `/q-runs`, `/q-run-show <run-id>`, `workbench_read_run` |
| Gates | `/q-gate`, `/q-gates`, `/q-gate-show <gate-id>`, `/q-evidence <run-id>` |
| Reports | `/q-report latest\|<run-id>` |
| Compare runs | `/q-compare <a> <b>`, `workbench_compare_runs` |
| Promote Candidate | `/q-promote research <candidate-id> <source-run-id>`; release additionally requires `--artifact-run <run-id> --authorize-release` |
| Widget | `/q-widget on\|off` (auto-shows during tasks and gate failures) |

## 6. Modes

| Mode | Tools | Blocked |
| ---- | ----- | ------- |
| AUDIT | read, grep, find, ls + read-only workbench tools | bash, edit, write, workbench_run_recipe, workbench_run_gate |
| DEV | Sol read/control/delegation tools; Luna writes only on parent-approved paths; a user lease may temporarily expose exact Sol edit/write tools | commander bash/foreign tools/unleased writes; worker free bash, recursive delegation, out-of-scope writes, final gates |
| VERIFY | read, grep, find, ls + all workbench tools | bash, edit, write (recipes only) |

In DEV, GPT-5.6 Sol defines the contract, architecture, scope, and verdict;
GPT-5.6 Luna performs routine source, test, and documentation writes. A
successful bounded implementation returns a provisional scope/integrity
packet in the same call and stays pending until Sol explicitly accepts its
complete unchanged hash; final recipes and Gates remain separate. A temporary commander
lease is an explicit exception bounded by calls, time, tools, and project-
relative paths; it never enables bash. Worker edit/write calls remain limited
to the parent-approved path contract.

The mode is stored in a Pi custom session entry and restored on every
session start — including `/resume`, `/fork`, `/clone`, `/reload`, and
compaction.

## 7. Guardrails you inherit (P5)

- **Protected paths**: the agent can never `edit`/`write` `.env`,
  `credentials.*`, `secrets.*`, `auth.json`, `id_rsa`, `*.pem`, `*.key` and
  friends (`.env.example`/`.env.template` stay readable); AUDIT/VERIFY can
  never even read them.
- **Destructive commands** are blocked token-wise: `rm -rf /` or `~`, `rm`
  of `.git`, `git reset --hard`, `git clean -fd`, `git push --force`,
  `git checkout -- .` / `git restore .`, git remote mutations,
  `git config --global` writes, `sudo`, package `publish`.
- **Records are redacted** (secret env names and well-known key shapes) and
  truncated (bounded summaries; full logs stay on disk).
- **Recipes are contained** lexically and via realpath (symlink escapes
  rejected), argv-only, `shell=false`, env allow-list.

See [security.md](security.md) for the exact boundaries — these are
guardrails, not a sandbox.

## 8. Quant projects

For `quant-research/stock-selection` and `quant-research/market-timing`
profiles, read [quant-research-profile.md](quant-research-profile.md): the
research contract (`research/contract.json`), the output contract
(`results/quant-result.json`), and the Q0-Q5 gates.

## Troubleshooting

- **"project is not trusted"** — exit Pi, re-enter the project directory,
  approve trust when prompted.
- **Gate BLOCKED** — run `/q-gate-show <gate-id>` and `/q-evidence <run-id>`
  to see which prerequisite failed and why; fix it, then re-run.
- **Recipe setup error** — the recipe violates a security invariant
  (containment, argv-only, env allow-list); fix `recipes.yaml`.
- **`/q-*` says nothing in print mode** — commands print to stdout in
  print/json modes by design.
