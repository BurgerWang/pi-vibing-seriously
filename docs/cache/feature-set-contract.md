# FEATURE_SET contract

Schema version: **1** · `contractType: "feature-set"`

The manifest that makes one feature computation over one immutable data
snapshot cacheable. The workbench validates the manifest and connects it to
its source snapshot; the **target project** computes the features.

## Fields

| Field | Required | Meaning |
|---|---|---|
| `schemaVersion` | yes | must be `1` |
| `contractType` | yes | must be `"feature-set"` |
| `featureSetId` | yes | **immutable** id |
| `profile` | yes | `quant-research/stock-selection` \| `quant-research/market-timing` |
| `dataSnapshotKey` | yes | immutable reference key of the source snapshot |
| `universeSnapshotKey` | stock-selection | **point-in-time universe** snapshot key |
| `featureCodeHash` | yes | hash of the feature code |
| `featureDefinitionHash` | yes | hash of the feature definitions |
| `parameters` | yes | feature parameters object |
| `warmupPeriod` | yes | non-negative number of bars/periods |
| `missingValuePolicy` | yes | how missing values are handled |
| `winsorizationPolicy` | stock-selection | cross-sectional winsorization |
| `normalizationPolicy` | stock-selection | cross-sectional normalization |
| `industryClassificationVersion` | stock-selection | GICS-like version |
| `marketCapSourceVersion` | stock-selection | market-cap source version |
| `financialReleaseAlignmentPolicy` | stock-selection | publication-time alignment |
| `signalTimestampPolicy` | market-timing | signal generation vs bar time |
| `barOpenCloseSemantics` | market-timing | open/close semantics of the signal bar |
| `resamplingPolicy` | market-timing | resampling rules |
| `timezone` | market-timing | explicit timezone |
| `tradingCalendar` | market-timing | calendar |
| `outputSchemaHash` | yes | hash of the feature output schema |
| `featureArtifactHash` | yes | content hash of the feature artifact |
| `warnings` | yes | array of strings — preserved verbatim |

## Per-profile requirements

**stock-selection** (spec §三) — all of these are mandatory for the
manifest to ever be `validated`:

- point-in-time universe (`universeSnapshotKey`)
- industry classification version
- market-cap source version
- financial publication-time alignment
- cross-sectional normalization policy
- winsorization policy
- missing-value policy

**market-timing** (spec §三):

- signal timestamp policy
- bar open/close semantics
- resampling policy
- warmup period
- timezone/calendar
- source data snapshot (`dataSnapshotKey`)

A manifest missing any of its profile's requirements still **parses**, but
its validation status can never be `validated` and it is never
cache-eligible.

## Validation status

- `invalid` — required fields missing or malformed (`warmupPeriod` missing
  is structural: `invalid`).
- `unresolved` — parses, but profile requirements missing.
- `validated` — structure + semantics + immutable id.

## Example

See `fixtures/quant/valid-stock-selection-feature-set.json` and
`fixtures/quant/valid-market-timing-feature-set.json`.
