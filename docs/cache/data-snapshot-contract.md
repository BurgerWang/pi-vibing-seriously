# DATA_SNAPSHOT contract

Schema version: **1** · `contractType: "data-snapshot"`

The manifest that makes one provider dataset revision cacheable. The
workbench validates the manifest; the **target project** produces the raw
data and this manifest.

## Fields

| Field | Required | Meaning |
|---|---|---|
| `schemaVersion` | yes | must be `1` |
| `contractType` | yes | must be `"data-snapshot"` |
| `snapshotId` | yes | **immutable** id (see rules 1–2) |
| `provider` | yes | data provider name |
| `dataset` | yes | dataset name |
| `providerDatasetVersion` | yes | provider's dataset version |
| `providerRevision` | yes | provider revision (`r3`, …) — bumping it changes the key |
| `acquiredAt` | yes | ISO timestamp of acquisition |
| `effectiveAsOf` | yes | **explicit** point-in-time the data is effective |
| `symbols` | yes | non-empty array, stably sorted (rule 5) |
| `pointInTimeUniverseId` | stock-selection | point-in-time universe id — **forced for stock-selection** (rule 7) |
| `startDate` / `endDate` | yes | coverage, ISO dates |
| `frequency` | yes | `daily`, `hourly`, … |
| `timezone` | yes | explicit timezone (rule 9) |
| `tradingCalendar` | yes | calendar name (NYSE, …) |
| `adjustmentPolicy` | semantics | split/dividend adjustment policy (rule 8) |
| `corporateActionVersion` | semantics | corporate-action table version (rule 8) |
| `delistingPolicy` | semantics | delisted-name handling (rule 8) |
| `schemaHash` | yes | hash of the schema/column layout |
| `rawDataHash` | yes | content-based hash of the raw data (rule 6) |
| `sourceArtifacts` | yes | project-relative raw-data paths (rule 10) |
| `warnings` | yes | array of strings — preserved verbatim |
| `logicalReference` / `resolvedReference` | no | resolution bookkeeping (see quant-cache.md §immutable references) |

## Rules

1. **`snapshotId` must be immutable.** `latest`, `current`, `now`, `today`
   (alone or as a prefix, case-insensitive) are rejected as final ids and
   can never key a cache.
2. **`effectiveAsOf` must be explicit** and parseable.
3. **Provider revision** of historical data must produce a new
   `providerRevision` and a new `rawDataHash`.
4. **`symbols` use a stable sort** — the content hash is computed over the
   sorted list, so symbol order never changes the key; unsorted lists get
   a warning.
5. **`rawDataHash` is content-based.** The workbench verifies it only when
   the declared source file is available and bounded in size (see
   `verifyDeclaredHash`); data files are never read into the model context.
6. **stock-selection forces `pointInTimeUniverseId`** — a snapshot without
   it parses but can never be `validated` for that profile.
7. **Missing adjustment/corporate-action/delisting semantics:** the
   contract still parses, but the validation status can never be
   `validated` — and therefore never cache-eligible.
8. **Time and timezone must be explicit** (`acquiredAt`, `effectiveAsOf`,
   `timezone`, `tradingCalendar`).
9. **`sourceArtifacts` are project-root restricted** — absolute paths and
   `..` escapes are rejected.

## Validation status

- `invalid` — required fields missing or malformed.
- `unresolved` — parses, but semantics missing (adjustment/corporate
  action/delisting, stock-selection PIT universe) → never cacheable.
- `validated` — structure + semantics + immutable id.

## Example

See `fixtures/quant/valid-data-snapshot.json` (valid),
`fixtures/quant/invalid-latest-snapshot.json` (mutable id),
`fixtures/quant/missing-point-in-time.json` and
`fixtures/quant/missing-corporate-action-policy.json` (parse but never
validated).
