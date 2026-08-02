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

- `typecheck` — cached (result-only), inputs = package/lock/tsconfig +
  extensions/tests/prompts/skills/templates/assets/tools/compatibility/docs
- `unit-test` — cached (result-only), same input set (the test suite reads
  repo files, so the whole repo content is fingerprinted)
- `check` — **not cached by design**: it chains typecheck + unit tests +
  `git diff --check`, and git working-tree state is deliberately not part
  of any action key. Run the two cached recipes for the fast path.

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
