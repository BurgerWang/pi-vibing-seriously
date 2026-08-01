# Project onboarding

How to install, initialize, and use pi-dev-workbench in a project — the
short path from zero to a gated workbench project.

## 1. Install the package

Requirements: Node.js and npm (tested: Node v24.13.0 / npm 11.18.0), Pi
(tested: 0.83.0). See [compatibility.md](compatibility.md).

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

**Then exit Pi, re-enter the project, and approve project trust.** Config is
only read and recipes only run under trust.

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
    artifacts: ["results/**/*.json"]
    params:
      - { name: symbol, type: string, required: true }
```

## 4. Run the validation ladder

```
/q-gates             # what gates exist for this profile
/q-gate b0           # run the project-readiness gate
/q-gate base         # all base gates
/q-gate quant        # all quant gates (quant profiles)
/q-gate q1,q2        # a chain; prerequisites resolve first
```

Gates form a ladder: B0-B5 (every profile) and Q0-Q5 (quant-research
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
| Widget | `/q-widget on\|off` (auto-shows during tasks and gate failures) |

## 6. Modes

| Mode | Tools | Blocked |
| ---- | ----- | ------- |
| AUDIT | read, grep, find, ls + read-only workbench tools | bash, edit, write, workbench_run_recipe, workbench_run_gate |
| DEV | full local dev tool set + all workbench tools | destructive commands (see below), protected-path writes |
| VERIFY | read, grep, find, ls + all workbench tools | bash, edit, write (recipes only) |

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
