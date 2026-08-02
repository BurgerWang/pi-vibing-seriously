# Quant Research Cache Contracts (P6-D)

Versioned manifest contracts that make quantitative research caching safe:
the workbench defines, validates and **connects** cache contracts; it never
downloads market data, never computes features, never runs a backtest
engine. The target project produces the data, features, backtest results
and the manifest JSON files that describe them.

Scope: stock selection, market timing, daily/hourly and ordinary
mid/low-frequency backtests, data snapshots, feature computation, parameter
experiments, walk-forward and out-of-sample validation.

Explicitly out of scope (no schema, no module, no plan): HFT, L2/LOB, tick
replay, queue models, market making, matching engines, colocation,
millisecond/microsecond latency, exchange order routing, live high-frequency
execution.

## The three contracts

| Contract | Manifest | What it makes cacheable | Q gates it feeds |
|---|---|---|---|
| `data-snapshot` | `DATA_SNAPSHOT` | a provider dataset revision | Q1 |
| `feature-set` | `FEATURE_SET` | one feature computation over a snapshot | Q1, Q2 |
| `backtest-result` | `BACKTEST_RESULT` | one backtest run (folds, metrics, parameters) | Q2–Q5 |

Each contract is a JSON manifest with `schemaVersion: 1`, `contractType`,
an **immutable id**, content hashes and upstream reference keys. Detailed
field tables and rules:

- [data-snapshot-contract.md](data-snapshot-contract.md)
- [feature-set-contract.md](feature-set-contract.md)
- [backtest-result-contract.md](backtest-result-contract.md)
- [quant-cache-invalidation.md](quant-cache-invalidation.md)

## Architecture boundaries

1. The workbench only defines, validates and connects cache contracts.
2. The workbench never downloads market data.
3. The workbench never computes strategy features.
4. The workbench never implements a backtest engine.
5. The target project remains responsible for data, features and backtest
   artifacts.
6. A cache hit can never bypass Q0–Q5 — gates re-validate every run record,
   cached or not (see below).
7. `latest`/`current`/`now`/`today` can never be a final manifest id or a
   cache fact source.

## Immutable reference resolution

Recipes may receive logical references (e.g. a data config that says
`latest`). The controlled flow:

1. The recipe's `cache.quantContract.manifest` points at a manifest file.
2. Before execution the manifest is read and validated.
3. If the manifest's id is a mutable reference (`latest`/`current`/`now`/
   `today`) or carries an unresolved `logicalReference`, it is resolved
   against the registry: same-directory manifests, `artifacts/**/*.json`
   and `.pi/workbench/quant/registry/**/*.json`. The **newest immutable
   revision** matching kind/provider/dataset wins.
4. The action key uses the **resolved** `snapshotId`, `revision` and
   content hash; both `logicalReference` and `resolvedReference` are
   recorded in the action record.
5. If nothing resolves: the quant cache is **refused** (nothing read,
   nothing written) and the recipe executes normally per the project's
   policy.
6. `latest.parquet` as a cache key is forbidden — identity always comes
   from an immutable manifest, never from a mutable filename.

## Recipe cache integration

```yaml
recipes:
  - name: data:fetch
    command: [python, scripts/fetch_data.py]
    cache:
      enabled: true          # quant domain is still opt-in (default off)
      domain: quant
      mode: result-only
      quantContract:
        type: data-snapshot
        manifest: artifacts/data-snapshot.json
```

Rules enforced by the workbench:

- `domain: quant` alone never enables the cache.
- the declared manifest **must exist** — otherwise the cache is refused.
- a schema-invalid manifest refuses the cache at key time AND at write time.
- the resolved immutable key joins the action key — any manifest change
  (provider revision, symbols, policies, hashes, …) invalidates.
- a `backtest-result` hit re-verifies `resultArtifactHash` against the
  on-disk artifact — a mismatch is **corruption** (never a hit).
- manifest `warnings` are preserved verbatim in the action record.
- failed folds are never filtered; a walk-forward declared with empty
  folds is never "validated"; best-trial-only caching is never valid;
  parameter searches must keep trial lineage or its immutable digest.

## Q Gate revalidation on cache hits

A cache hit materializes a **new full run record**
(`execution_source: "cache"`, `action_key`, `reused_from_run_id`) and the
gates re-validate it exactly like an executed run. The three contract
schemas are available as built-in gate schema checks:

```yaml
checks:
  - { id: q1.x, kind: schema, file: artifacts/data-snapshot.json, schema: data-snapshot }
  - { id: q2.x, kind: schema, file: artifacts/feature-set.json, schema: feature-set }
  - { id: q2.y, kind: schema, file: artifacts/backtest-result.json, schema: backtest-result }
```

A contract schema check only **PASSES** when the manifest is fully
`validated` (structure + semantics + immutable). Manifests that merely
parse — missing adjustment/corporate-action/delisting semantics, mutable
ids, unresolved logical references, walk-forward without folds,
best-trial-only, missing trial lineage — **FAIL**.

The cache proves only:

> The same inputs produced the same result before.

The cache never proves:

> The strategy is well-designed, effective or profitable.

## Commands

```
/q-cache-validate <manifest-path>      contract type, schema version,
                                       immutable/mutable status, content
                                       hash, upstream keys, missing fields,
                                       warnings, cache eligibility,
                                       Q gate implications
/q-cache-lineage <run-id|action-key>   data snapshot -> feature set ->
                                       backtest result, upstream
                                       relationships, action keys,
                                       artifact hashes, reused runs,
                                       invalidation reason
```

Both commands read only run records, action records and small JSON
manifests — **data files are never read into the model context**. Artifact
hash verification streams files with a bounded size cap.

## Fixtures

Real-structure, conclusion-free fixtures live in
`fixtures/quant/` (no strategy performance numbers):

```
valid-data-snapshot.json                valid-stock-selection-backtest.json
invalid-latest-snapshot.json            valid-market-timing-backtest.json
valid-stock-selection-feature-set.json  missing-point-in-time.json
valid-market-timing-feature-set.json    missing-corporate-action-policy.json
failed-fold-retained.json               corrupted-artifact.json
```
