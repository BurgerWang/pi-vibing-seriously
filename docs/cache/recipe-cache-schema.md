# Recipe cache schema (`recipes.yaml` `cache:` block)

```yaml
recipes:
  - name: typecheck
    command: [npm, run, typecheck]
    cache:
      enabled: true        # default false — caching is explicit opt-in
      version: 1           # user-managed schema version
      mode: result-only    # "result-only" | "artifacts"
      successOnly: true    # default true — failures are not cached
      inputs:              # content-fingerprinted into the action key
        - package.json
        - package-lock.json
        - tsconfig.json
        - extensions/**/*.ts
      outputs: []          # artifacts mode ONLY; empty = restore forbidden
      environment: []      # extra env names whose values hash into the key
      toolchain: [node, npm]   # built-ins: node npm python uv rustc cargo
      maxAgeSeconds: null  # TTL; null = never expire
      upstream: []         # recipe names whose action keys chain into this key
```

## Rules

1. **Default `enabled: false`.** A missing `cache:` block, or any problem in
   it, leaves the recipe fully executable and uncached. Cache problems are
   recorded as config warnings — they never drop the recipe.
2. **`result-only` restores no files.** Only execution-result metadata is
   stored and reused.
3. **`artifacts` requires declared `outputs`.** `outputs` empty + artifacts
   mode = parse warning + cache disabled. Even with outputs declared,
   artifact **restore is disabled in this version**
   (`ARTIFACT_RESTORE_ENABLED = false`) until it passes its own security
   gate — artifacts-mode recipes always execute and only result metadata is
   stored.
4. **Failures are not cached** unless `successOnly: false` is declared
   explicitly (risky: a cached failure reproduces a failure; gates still
   fail on it).
5. **Network / time / random / external-API recipes cannot be cached.**
   Denied at parse time (with a warning + cache disabled) when the command
   contains network tools (`curl`, `wget`, `ssh`, `docker`, `kubectl`,
   package install/ci/sync/fetch/update verbs, …) or non-determinism tools
   (`date`, `sleep`, `uuidgen`, …). The heuristic cannot be complete — a
   script that fetches an API is invisible; treat anything network-bound as
   uncacheable yourself.
6. **Source-mutating recipes cannot be cached.** Declared `writes` under
   source paths (`src/`, `extensions/`, `tests/`, `*.ts`, `*.py`, …) or git
   mutation verbs (`apply`, `checkout`, `reset`, `clean`, `restore`, …) deny
   caching.
7. **`command` must remain an argv array.** Shell strings are rejected by
   the recipe schema (unchanged); the cache never changes that.
8. **Environment:** only declared names are observed. `recipe.environment`
   (passed to the process) and `cache.environment` (additional names) both
   hash into the key; raw values are **never persisted**.
9. **Secrets:** env values enter keys/records only as SHA-256 hashes, and
   protected secret files are never read as cache inputs.

## Toolchain declarations

Built-ins (fixed, safe version queries, `shell=false`, timeout 5 s,
truncated output):

```
node npm python uv rustc cargo
```

Custom safe version commands:

```yaml
toolchain:
  - name: my_tool
    command: [my-tool, --version]   # argv only, no shell strings
    timeoutMs: 5000                 # optional, 1..15000
```

A failed/timed-out version query enters the key as the explicit string
`unknown` — never silently dropped.

## `upstream`

```yaml
cache:
  upstream: [typecheck]   # key includes typecheck's action key
```

Upstream keys are computed with empty params; an upstream recipe with
required params (or a missing/cyclic upstream) **refuses the cache** for the
parent. v1 does not model params passed from parent to upstream.

## Bootstrap recipes in this repository

`.pi/workbench/recipes.yaml`:

- `typecheck` — cached (result-only), inputs EXACTLY package.json +
  package-lock.json + tsconfig.json + `extensions/**/*.ts` +
  `tests/**/*.ts` — the only content that can change tsc's outcome.
  Unrelated repo content (docs, assets, skills, prompts, templates,
  tools, compatibility) is deliberately outside the action key: a
  docs-only or asset-only change never invalidates the cached typecheck
  result.
- `unit-test` — cached (result-only), same input set (the test suite reads
  repo files, so the whole repo content is fingerprinted)
- `release-assets-test` — cached (result-only), focused inputs = the
  release-asset closure (package/lock/tsconfig, the test file itself,
  LICENSE, README.md, assets/banner.svg, tools/make-banner.mjs,
  extensions/workbench-runtime/cache/cache-types.ts)
- `runtime-core-test` — cached (result-only), focused isolation suite for
  the runtime core: recipe schema, recipe runner, action cache, inspect,
  P4 render, execution-efficiency and commander-native-tool-benchmark-v2
  wiring (tests/recipe-schema.test.ts, recipe-runner.test.ts,
  p6-c-action-cache.test.ts, inspect.test.ts, p4-render.test.ts,
  execution-efficiency.test.ts,
  commander-native-tool-benchmark-v2-wiring.test.ts), inputs = the exact
  runtime-core closure (package/lock/tsconfig,
  `.pi/workbench/recipes.yaml`, `extensions/**/*.ts`, `tests/helpers.ts`,
  the seven test files themselves). It declares NO validation component —
  it is a focused development suite, not the full `unit-test` component.
- `typecheck-feedback` — **uncached self-hosting alias** (dev-only
  feedback for the old in-memory recipe parser): directly runs
  `npm run typecheck`, intentionally has NO cache block (never cached),
  and declares no `validation_components` (the old parser has no such
  field; the new parser defaults it to `[]`). DEVELOPMENT-ONLY feedback —
  it never claims a component and is never final check/Gate evidence.
- `gate-preflight-test` — cached (result-only), Phase 3 gate preflight
  test suite: runs the three Phase 3 test files (gates, p4-render,
  result-summary wiring) via `test:gate-preflight`. Exact summarized
  closure (10 inputs) = shared config (package/lock/tsconfig), the
  recipe and gate definitions the tests parse
  (`.pi/workbench/recipes.yaml`, `.pi/workbench/gates.yaml`), all
  extension TypeScript, the shared test helper and the three test files
  themselves. No validation component — a focused feedback recipe, never
  check/Gate evidence.
- `worker-efficiency-test` — cached (result-only), focused
  worker-efficiency test suite: runs the four worker test files (worker
  policy, worker runner, delegation ledger, P6-B stable prefix) via
  `test:worker-efficiency`. Exact summarized closure (11 inputs) = shared
  config (package/lock/tsconfig), the recipe definitions the tests parse
  (`.pi/workbench/recipes.yaml`), all extension TypeScript, the shared
  test helper, the four test files themselves, and
  `docs/worker-delegation.md` (the delegation contract the tests pin
  against). No validation component — focused development feedback only,
  never final check/Gate evidence.
- `check` — **not cached by design**: it chains typecheck + unit tests +
  `git diff --check`, and git working-tree state is deliberately not part
  of any action key. Run the cached recipes for the fast path.

## Validation components and the final aggregate check

**Recipe-level `validation_components` (closed set).** Every recipe may
declare `validation_components` from exactly `typecheck`, `unit-test`,
`whitespace` (`extensions/workbench-runtime/core/recipe-schema.ts`,
`VALIDATION_COMPONENTS`). Unknown entries, non-strings and duplicates are
schema errors; an omitted field defaults to `[]`; declaration order is
preserved. The declared array is part of the recipe definition hash — a
`validation_components`-only change invalidates cached results.

**Persisted machine facts.** Only final run manifests persist the recipe's
exact declared `validation_components` and the caller's `cache_request_mode`
(`default` | `no-cache` | `refresh-cache`). Action records key the recipe
definition (including its declared components) but do not directly persist
`cache_request_mode` as a field. Executed runs keep the exact request mode;
materialized cache-hit manifests always record
`cache_request_mode: "default"`. The persisted manifest is
the machine-readable source of truth for what a run executed and what the
caller requested.

**Aggregate final check evidence — a single no-cache run.** Focused and
component cached recipes (`typecheck`, `unit-test`, `release-assets-test`,
`runtime-core-test`, `gate-preflight-test`, `worker-efficiency-test`) are
**development/isolation feedback only**. The only
aggregate final check evidence is a successful Commander-owned **no-cache
`check`** run whose persisted manifest records exactly
`validation_components: [typecheck, unit-test, whitespace]`. Once that
final aggregate run executes, the final workflow does not separately rerun
the full component recipes — the aggregate already covers them. No old run
and no cache hit auto-skips execution: formal gates always execute, and
manual gate evidence remains manual — caching never converts manual
evidence into machine evidence.

## Gate preflight (`workbench_run_gate` `preflight: true`)

`preflight: true` turns `workbench_run_gate` into a READ-ONLY
config/gate-selector/manual-readiness operation (`/q-gate <selector>
--preflight` is the slash-command equivalent):

1. **Same selection, zero side effects.** It resolves the SAME selection a
   formal run applies — project config + effective gate catalog, selector
   expansion, unknown/profile validation and prerequisite ordering — then
   reports exactly which required (`kind: manual` && required) checks the
   supplied `manual_evidence` satisfies: provided/missing ids and the
   single readiness flag `manual_evidence_ready`.
2. **No run, no recipe, no status.** Preflight creates NO run id, executes
   NO recipe, assigns NO gate status and never returns
   PASS/FAIL/BLOCKED/NOT_RUN — `manual_evidence_ready` is the only
   readiness signal. It reads config/gates.yaml only (no run records, no
   git/exec, no persistence).
3. **Raw notes are never returned.** The payload carries only check
   ids/prompts and provided/not-provided facts — never the raw
   manual-evidence notes.
4. **Formal semantics unchanged.** Omitting `preflight` (or passing
   `false`) runs the gate formally; manual evidence supplied to a formal
   run is still recorded with type `"manual"` and can never masquerade as
   machine verification. Preflight never converts manual evidence into
   machine evidence.

## P6-D: `domain: quant` and `quantContract` (Quant Research Cache)

```yaml
cache:
  enabled: true            # the quant domain is STILL opt-in — domain alone never enables
  domain: quant            # "default" (P6-C) | "quant" (P6-D quant contracts)
  mode: result-only
  quantContract:
    type: data-snapshot    # data-snapshot | feature-set | backtest-result
    manifest: artifacts/data-snapshot.json   # project-relative manifest path
```

Rules (documented in [quant-cache.md](quant-cache.md) and
[quant-cache-invalidation.md](quant-cache-invalidation.md)):

1. **`domain: quant` requires `quantContract`** and vice versa; violations
   disable caching with a warning, never the recipe.
2. **The manifest must exist.** Missing/invalid/unreadable → the quant
   cache is refused (the recipe still executes normally).
3. **Schema-invalid manifests refuse the cache** at key computation time
   AND at write time.
4. **The resolved immutable key joins the action key.** The key is built
   from the resolved snapshotId/revision/content hash — `latest` must
   resolve to an immutable revision or the cache is refused.
5. **`backtest-result` hits verify `resultArtifactHash`** against the
   on-disk artifact — mismatch is corruption (never a hit).
6. **Manifest `warnings` are preserved verbatim** in the action record
   (`quantContractInfo.warnings`).
7. **Failed folds are never filtered; walk-forward with empty folds is
   never validated; best-trial-only caching is never valid; parameter
   searches keep trial lineage or an immutable digest.**
8. **Cache hits never bypass Q0–Q5** — gates re-validate every run; the
   three contract schemas are available as gate schema checks
   (`schema: data-snapshot|feature-set|backtest-result`).

The `.pi/workbench/recipes.yaml` bootstrap recipes stay in the default
domain (no quant contracts).
