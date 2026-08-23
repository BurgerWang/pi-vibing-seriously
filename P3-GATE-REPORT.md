# P3 Gate Report — Gate Engine, Evidence Artifacts, Quant Research Validation Ladder

> **Historical, non-authoritative record.** This report describes v0.4.0 at
> its original candidate and does not establish current Gate freshness or
> release authority. Current runtime records and a validation assessment bound
> to the current commit/config take precedence.

Milestone: P3 of pi-dev-workbench (v0.4.0). This report documents what was
implemented and the verification evidence. **No commit was made** (per the
milestone instruction; the repository is left dirty for review).

## 1. Scope delivered

| Component | Location | Status |
| --------- | -------- | ------ |
| Base gates B0-B5 (project readiness → reproducibility/handoff) | `core/gate-catalog.ts` | PASS |
| Quant gates Q0-Q5 (contract → reporting), quant-profile only | `core/gate-catalog.ts` | PASS |
| Gate/check schema + `gates.yaml` parsing (strict) | `core/gate-schema.ts` | PASS |
| Gate engine: selectors, prerequisites, statuses, persistence | `core/gate-engine.ts` | PASS |
| Evidence artifacts per gate run (`manifest/gates/evidence/summary/stdout/stderr/artifacts/`) | `core/gate-engine.ts` | PASS |
| `quant-result.schema.json` contract + validator | `schemas/`, `core/quant-result.ts` | PASS |
| Commands `/q-gate /q-gates /q-gate-show /q-evidence` | `index.ts` | PASS |
| Tools `workbench_run_gate / workbench_read_gate / workbench_list_gates` | `index.ts` | PASS |
| Mode policy: AUDIT hard-denies `workbench_run_gate`; VERIFY allows gate runs | `core/mode-policy.ts` | PASS |
| Template `gates.yaml` + AGENTS quant contract documentation | `templates/project/` | PASS |

## 2. Status rules implemented

- Statuses are only `PASS | FAIL | BLOCKED | NOT_RUN`.
- Required check `NOT_RUN` → gate can never PASS.
- Blocking prerequisite `FAIL/BLOCKED/NOT_RUN` → dependent `BLOCKED`
  (resolved in-run first, then from the most recent persisted gate run).
- Warnings never upgrade a status.
- Numeric constraints evaluate only structured JSON artifacts.
- Manual evidence is recorded only as `type: "manual"` — model prose can
  never masquerade as machine verification.
- Every evidence path is containment-checked (lexical + symlink-aware
  realpath); escapes abort with `GateSetupError`.

## 3. Verification

### 3.1 `npm run check` (typecheck + full test suite + git diff --check)

```
143 tests, 143 pass, 0 fail
```

New P3 tests: `tests/gates.test.ts` (27), `tests/quant-result.test.ts` (12),
updated `tests/mode-policy.test.ts` — covering the required scenarios:

- [x] Gate 依赖顺序 (dependency order; reversed request still evaluates in order)
- [x] prerequisite FAIL -> BLOCKED (checks not evaluated, reason recorded)
- [x] required NOT_RUN 不得 PASS (manual check without evidence → NOT_RUN)
- [x] artifact 缺失 (file/glob no match → FAIL)
- [x] JSON 字段缺失 (field path missing → FAIL)
- [x] numeric constraint (min/max inclusive; `folds.length` paths)
- [x] 非数字和 NaN (`"abc"` and `1e999`→Infinity → FAIL)
- [x] quant profile 才加载 Q Gates (generic: b0-b5 only; quant: b0-b5+q0-q5)
- [x] generic 不强制 Q Gates (`all` on generic evaluates no q-gates; `q0`
      selector rejected with a setup error)
- [x] 失败 fold 不被过滤 (failed folds appear in `failed_folds` and in the
      schema-check evidence; never dropped)
- [x] evidence 路径越界 (`../`, absolute, symlink escapes → rejected)
- [x] Gate 结果持久化 (7 run files; gates.json carries id/status/
      prerequisites/checks/evidence paths/failure reason/blocked reason/
      timestamps)
- [x] 重复运行有独立 run_id
- [x] recipe check runs a declared recipe; fails when undeclared; failed
      recipe exit code recorded
- [x] manual evidence explicitly marked `type: manual`
- [x] non-blocking prerequisite FAIL does not block dependents
- [x] prerequisites resolve from prior persisted runs
- [x] gates.yaml replaces built-in gates by id

### 3.2 End-to-end ladder against this repository (temp clone, generic profile)

The engine was pointed at a copy of this repository (workbench config
written, `b1` overridden to the checks this repo declares, real `npm run
typecheck` / `npm test` recipes):

```
OVERALL: PASS (exit code 0)
  b0 PASS  Project Readiness            (4/4)  config + files, machine-verified
  b1 PASS  Static Quality               (1/1)  b1.3 recipe: npm run typecheck ran
  b2 PASS  Unit Correctness             (3/3)  b2.1 recipe: npm test (143 tests) ran
  b3 PASS  Integration Correctness      (3/3)  b3.1 recipe: npm test ran
  b4 PASS  Output Contract              (3/3)  manual evidence (recorded as manual)
  b5 PASS  Reproducibility and Handoff  (2/2)  manual evidence
```

Captured during the same session (before the integration recipe existed):
`b3 FAIL` → `b4 BLOCKED` → `b5 BLOCKED` — the ladder blocked downstream
gates exactly as specified.

### 3.3 Live Pi session smoke (this repository, print mode)

`pi -a -p` against the package itself: extension loads with all six
workbench tools; `/q-gates` lists the catalog; `/q-gate-show b0` renders the
definition; `/q-gate b0` ran and persisted a run — `b0.1`-`b0.3` machine
PASS, `b0.4` FAIL (this repo has no `.pi/workbench` init), and
`/q-evidence <run-id>` renders the per-check evidence records.

### 3.4 Quant ladder smoke (quant-research/stock-selection)

A full `all` run over the built-in catalog with a conforming
`research/contract.json` and `results/quant-result.json` (3 folds, one
failed): `b0..b5` and `q0..q5` all PASS; the q2.2 schema evidence reported
`failed folds reported: f2`. Run layout verified:
`manifest.json gates.json evidence.json summary.json stdout.log stderr.log
artifacts/`.

## 4. Artifacts per gate run (spec §5)

```
.pi/workbench/runs/<run-id>/
├── manifest.json     # same shape as recipe runs; recipe: "gate"; exit 0 iff PASS
├── gates.json        # gate id, status, prerequisites, prerequisite_status,
│                     # checks (id/status/kind/required/blocking), evidence paths,
│                     # failure_reason, blocked_reason, timestamps
├── evidence.json     # per-check evidence records (types: config/recipe_run/
│                     # artifact/file/json/numeric/manual/schema)
├── summary.json      # overall status, per-gate statuses, counts
├── stdout.log        # engine progress (full)
├── stderr.log
└── artifacts/        # copied evidence sources (artifacts, configs, recipe summaries)
```

## 5. Known limitations (P3)

- The `schema` check supports the built-in `quant-result` contract only;
  project-defined JSON schemas are not yet loadable.
- Built-in quant checks use convention paths (`research/contract.json`,
  `results/quant-result.json`) and convention recipe names (`check:*`,
  `test:*`, `data:fetch`, `backtest` with per-profile alternatives); projects
  using different names override the checks in `gates.yaml`.
- The workbench validates declared output only — it never computes strategy
  metrics, and audits that cannot be automated (look-ahead, survivorship,
  parameter stability) remain manual-evidence checks by design.

## 6. Git state

Repository left uncommitted on purpose: `git status` shows the P3 changes
(new core modules, schemas, tests, templates, docs, version bump 0.4.0).
Machine-generated gate/recipe runs are gitignored (`.pi/workbench/runs/`);
this report (`P3-GATE-REPORT.md`) is the milestone's verification artifact.
