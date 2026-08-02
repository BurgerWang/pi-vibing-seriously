# Quant cache invalidation

The immutable key of a quant manifest is

```
quant:<contract-type>:<id>:<revision>:<content-hash-16>
```

computed from the **resolved** manifest. The recipe action key includes
this upstream key, so any change below changes the action key → a miss.
The safe direction is always a miss.

## Key / invalidation matrix

| Change | Component | Invalidation |
|---|---|---|
| `snapshotId` / `featureSetId` / `backtestId` | id | new key |
| `providerRevision` | revision | new key |
| any manifest content (policies, hashes, dates, parameters, folds, warnings, …) | content hash | new key |
| `symbols` order | content hash | **no change** (stably sorted before hashing) |
| `logicalReference` / `resolvedReference` bookkeeping | — | no change (excluded from the content hash) |
| data snapshot `symbols` / universe | content hash | new key |
| timezone / tradingCalendar | content hash | new key |
| adjustmentPolicy / corporateActionVersion / delistingPolicy | content hash | new key (and status may drop below `validated`) |
| feature code / definitions | content hash | new key |
| normalization / winsorization / industry version / market-cap source / financial publication policy | content hash | new key |
| signal timestamp / bar open-close / resampling / warmup | content hash | new key |
| fee / slippage / benchmark / rebalance / position constraints / corporate action policy hashes | content hash | new key |
| split / walk-forward / seed / engine version | content hash | new key |
| result artifact **content** (without manifest change) | — | **corruption** on the next hit (resultArtifactHash mismatch) |
| result artifact file missing | — | miss (unverifiable, never a hit) |
| `latest`/`current`/`now`/`today` id, unresolved | — | cache refused (never keyed) |
| manifest missing / schema-invalid | — | cache refused at key time and write time |
| recipe definition / argv / inputs / env / toolchain / OS / lockfiles / config / profile / gate schema | action key | new key (unchanged P6-C rules) |

## Logical reference lifecycle

1. The manifest declares `snapshotId: "latest"` (or an unresolved
   `logicalReference`).
2. The workbench resolves it against the registry (same-directory
   manifests, `artifacts/**/*.json`, `.pi/workbench/quant/registry/**`)
   and picks the newest **immutable** revision matching
   kind/provider/dataset.
3. The action key is built from the resolved id/revision/content hash.
4. Both `logicalReference` and `resolvedReference` are recorded in the
   action record (`quantContractInfo`).
5. Unresolvable → cache refused, no old cache used, normal execution.

The id `latest` in the registry is never a candidate — only immutable
revisions are.

## Corruption vs miss

- **corruption**: the action record says the manifest hash, but the
  on-disk result artifact no longer matches `resultArtifactHash` (or the
  action JSON itself is damaged). Never a hit; the recipe re-executes and
  rewrites.
- **miss**: everything else (missing file, unverifiable size, schema
  change, manifest change, key change).

## Q Gate implications of invalidation

Invalidation never changes what the gates check: on every run — executed
or cache hit — Q1–Q5 re-validate the manifests and result artifacts. A
contract schema check only PASSES for fully `validated` manifests; a
manifest that is merely parseable (missing adjustment/corporate-action/
delisting semantics, mutable id, unresolved logical reference,
walk-forward without folds, best-trial-only, no trial lineage) FAILS.

## What the cache proves

Same inputs → same result. Nothing more: strategy design, effectiveness
and profitability are validated by the Q ladder and the project's own
research, never by the cache.
