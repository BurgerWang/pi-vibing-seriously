# BACKTEST_RESULT contract

Schema version: **1** · `contractType: "backtest-result"`

The manifest that makes one backtest run cacheable: its data snapshot,
feature set, split/walk-forward definition, seed, engine, cost and
execution models, fold artifacts, metrics and parameters. The workbench
validates the manifest and verifies the declared result artifact hash on
every cache hit; the **target project** runs the backtest.

## Fields

| Field | Required | Meaning |
|---|---|---|
| `schemaVersion` | yes | must be `1` |
| `contractType` | yes | must be `"backtest-result"` |
| `backtestId` | yes | **immutable** id |
| `strategyType` | yes | `stock-selection` / `market-timing` / … |
| `sourceCodeHash` | yes | hash of the strategy source |
| `strategyConfigHash` | yes | hash of the strategy config |
| `dataSnapshotKey` | yes | immutable reference key of the data snapshot |
| `featureSetKey` | yes | immutable reference key of the feature set |
| `universeSnapshotKey` | yes | immutable reference key of the universe |
| `splitDefinitionHash` | yes | hash of the split definition |
| `walkForwardDefinitionHash` | walk-forward | hash of the walk-forward definition; when present, **folds are mandatory** |
| `seed` | yes | number or string |
| `engineVersion` | yes | backtest engine version |
| `tradingCalendar` | yes | calendar |
| `feeModelHash` | yes | hash of the fee model |
| `slippageModelHash` | yes | hash of the slippage model |
| `benchmarkDefinitionHash` | yes | hash of the benchmark definition |
| `rebalanceSemanticsHash` | yes | hash of the rebalance semantics |
| `positionConstraintHash` | yes | hash of position constraints |
| `corporateActionPolicyHash` | yes | hash of the corporate-action policy |
| `resultArtifactHash` | yes | content hash of the result artifact — **verified on every cache hit** |
| `metricsArtifact` | yes | project-relative metrics artifact path |
| `parametersArtifact` | yes | project-relative parameters artifact path |
| `foldArtifacts` | walk-forward | fold entries `{ id, status, artifact }` |
| `failedFolds` | no | ids of failed folds — **never filtered** |
| `parameterSearch` | no | `true` when a parameter search ran |
| `trialLineage` | parameter search | `{ retained: true }` or `{ digest: <hash> }` — full trial reporting |
| `bestTrialOnly` | no | `true` is **never valid** |
| `warnings` | yes | array of strings — preserved verbatim |

## Rules

1. **Any key field change → new `backtestId`/new content hash → new key.**
   Source, config, split, walk-forward, seed, engine, calendar, fee,
   slippage, benchmark, rebalance, position constraints and corporate
   action policy all bind the immutable key (see
   [quant-cache-invalidation.md](quant-cache-invalidation.md)).
2. **Failed folds are never filtered.** Every id in `failedFolds` must
   have a `foldArtifacts` entry; a fold reported as failed but missing
   from `foldArtifacts` is a validation error.
3. **Walk-forward declared, folds empty → never validated.** If
   `walkForwardDefinitionHash` is present, `foldArtifacts` must be
   non-empty.
4. **Best-trial-only caching is never valid.** `bestTrialOnly: true` (or
   silently dropping trials) makes the manifest unresolvable.
5. **Parameter searches must keep trial lineage or its immutable digest.**
   With `parameterSearch: true`, `trialLineage` must declare
   `{ retained: true }` or a `{ digest }` of the full trial table.
6. **Result artifact hash is verified on cache hits.** The declared
   `resultArtifactHash` is compared against the on-disk `metricsArtifact`
   (bounded streaming SHA-256). A mismatch is **corruption** — the hit is
   refused and the recipe re-executes.
7. All artifact paths are project-root restricted.

## Q gate implications

`backtest-result` manifests feed Q2 (semantics), Q3 (experiment
integrity), Q4 (out-of-sample robustness) and Q5 (strategy reporting).
The gate schema check (`schema: backtest-result`) only PASSES when the
manifest is fully `validated` — including fold completeness and failed-fold
retention.

## Examples

See `fixtures/quant/valid-stock-selection-backtest.json`,
`fixtures/quant/valid-market-timing-backtest.json` (valid),
`fixtures/quant/failed-fold-retained.json` (failures kept) and
`fixtures/quant/corrupted-artifact.json` (deliberately wrong
`resultArtifactHash` for corruption tests).
