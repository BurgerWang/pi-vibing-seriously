# P6 Benchmark Report — Before / After (P6-A → P6-B → P6-C)

Generated: 2026-08-02 (local evidence only; no model calls, no warmup, no
provider modification). Tool: `scripts/cache-benchmark.ts` (`npm run
cache:report`); statistical definitions: [cache-benchmark.md](cache-benchmark.md).

## Sample

| | P6-A baseline | P6-B stable-dev | P6-C action-cache | P6-D quant | P6-E (this session) | Whole corpus |
| --- | --- | --- | --- | --- | --- | --- |
| Scope | session | session | session¹ | session | session | project |
| Requests | 10 | 135 | 218 | 170 | 65 | 602 |
| Time range (UTC) | 01:57:35–01:58:11 | 02:03:35–02:31:15 | 02:36:07–03:31:24 | 03:58:21–04:36:04 | 04:47:11–04:58:08 | 01:57:35–04:58:08 |
| Provider | deepseek | deepseek | deepseek | deepseek | deepseek | deepseek |
| Model | deepseek-v4-flash | deepseek-v4-flash | deepseek-v4-flash | deepseek-v4-flash | deepseek-v4-flash | deepseek-v4-flash |
| API kind | openai-completions | openai-completions | openai-completions | openai-completions | openai-completions | openai-completions |
| Thinking level | max | max | max | max | max | max |
| Workbench mode | DEV | DEV | DEV | DEV | DEV | DEV |

¹ The saved `p6c-action-cache.json` (created 03:43:06) is **project scope
(363 requests)** because the action-cache work spanned sessions; the table
shows the P6-C session subset (218) for comparability with the other rows.
Both numbers appear in the report below.

## Prompt-cache usage (provider-billed facts)

| Metric | P6-A | P6-B | P6-C (session) | P6-C (saved, project) | P6-D | Whole corpus |
| --- | --- | --- | --- | --- | --- | --- |
| uncached input tokens | 696 | 120,503 | 114,558 | 235,757 | 134,736 | 447,923 |
| cacheRead tokens | 2,249,344 | 18,888,704 | 41,404,800 | 62,542,848 | 31,078,912 | 99,332,864 |
| output tokens | 393 | 108,563 | 191,249 | 300,205 | 133,811 | 489,173 |
| cacheWrite tokens | 0 | 0 | 0 | 0 | 0 | 0 |
| total tokens | 2,250,433 | 19,117,770 | 41,710,607 | 63,078,810 | 31,347,459 | 100,269,960 |
| cache hit ratio | 99.97% | 99.37% | 99.72% | 99.62% | 99.57% | 99.55% |
| usage semantics | verified | verified | verified | verified | verified | verified |
| reported cost (Pi usage.cost.total) | $0.006506 | $0.100156 | $0.185521 | $0.292183 | $0.143351 | $0.477810 |

`cacheWrite = 0` everywhere: DeepSeek does not report cache writes — a zero
is **not** an error and does **not** mean the cache was not established
(documented in `cache-types.ts`).

`estimatedAvoidedCost` is not stated here: it requires explicit per-model
rates (`--cost-map`) and this workbench **never hardcodes provider
prices**. With the extension's registry-derived estimate, the P6-A report
carried $0.0063 avoided on 2.25M cache-read tokens and the P6-C project
report $0.1751 on 62.5M tokens — those are estimates, not bills.

## Stability (P6-B stable-prefix contract)

Across **all 602 records**, the stable-zone fingerprints:

| Fingerprint | Distinct values |
| --- | --- |
| systemPromptHash | 1 (constant) |
| activeToolNamesHash | 1 (constant) |
| activeToolOrderHash | 1 (constant) |
| activeToolSchemaHash | 3 (changed twice, see below) |

The two schema-hash changes happened at 02:30:42 (end of the P6-B session,
workbench tool set still growing) and 03:58:21 (start of the P6-D session,
quant tools/contracts added). Both are **development-time additions of new
tools**, not runtime instability: within each installed version the tool set
was stable, and the mode never switched during the corpus.

Invalidation inference (workbench-side, conservative):

| | P6-A | P6-B | P6-C | P6-D | Corpus |
| --- | --- | --- | --- | --- | --- |
| expected invalidations | 1 | 2 | 1 | 1 | 6 |
| unexpected drifts (all) | 9 | 133 | 217 | 169 | 596 |
| — of which UNEXPECTED_DRIFT with driftSource | 0 | 0 | 0 | 0 | 0 |
| — of which CONTEXT_PREFIX_DIVERGED | 9 | 133 | 217 | 169 | 596 |
| mode changes / model changes / thinking changes | 0/0/0 | 0/0/0 | 0/0/0 | 0/0/0 | 0/0/0 |
| reloads / compactions | 0/0 | 0/0 | 1/0 | 0/0 | 1/0 |

Interpretation (see [cache-benchmark.md](cache-benchmark.md)): every
unexpected drift is `CONTEXT_PREFIX_DIVERGED` — the payload *shape* grew
(normal conversation growth) while the stable zone stayed byte-identical.
**Zero** `UNEXPECTED_DRIFT` with a driftSource means the system prompt and
tool metadata never changed within a running version — the P6-B contract
held. 99.4–99.97% provider-billed cache reads confirm it empirically.

## Recipe action cache (P6-C)

From run manifests + action records (12 manifests total):

| Metric | Value |
| --- | --- |
| recipe executions (manifests) | 12 |
| recipe cache hits (`execution_source: cache`) | 5 |
| recipe cache misses (`execution_source: exec`) | 7 |
| recipe hit ratio | 41.7% |
| local execution time avoided | 138.4 s (~2.3 min) |
| action records on disk | 4 |
| cache storage size | 739.5 KB |
| corruption count | 0 |
| lock fallback count | 0 |
| corrupted telemetry lines | 0 |

The 5 hits are all `typecheck` runs against unchanged inputs; `check` is
deliberately uncached (its outcome depends on git working-tree state, which
is never part of an action key). Hit ratios are per-recipe facts, not
savings guarantees.

## Limitations

- **Small, single-context sample.** 602 requests across ~3.5 hours of one
  developer's session: one provider, one model, one thinking level, one
  mode (DEV). This is **not** evidence of a stable long-term saving ratio.
  Do not extrapolate percentages to other models, modes, or workloads.
- **No cross-mode comparison.** AUDIT/VERIFY sessions were not part of the
  corpus; the P5 permission isolation on mode switches was verified by
  tests and smokes, not by this benchmark.
- **Hit ratios are provider-billed input-side facts** (`cacheRead /
  (input + cacheRead)`), not end-to-end latency or cost measurements.
  Latency was not measured.
- **`unexpectedDrifts` is an upper bound**, dominated by
  CONTEXT_PREFIX_DIVERGED (payload growth). The actionable count
  (driftSource non-null) is zero.
- **Cost facts come from Pi's `usage.cost.total`** (provider billing
  fields). Estimated avoided cost is explicitly rate-dependent and left
  out of this report rather than guessed.
- Telemetry is DEV-only, hash-only, and rotated at 5 MB — rotated archives
  were not present during this period; very long-running projects may lose
  the oldest records (rotation drops `telemetry.5.jsonl` first).
- The recipe-cache sample (12 runs) is dominated by one recipe; the 41.7%
  figure is descriptive of this period only.

## Reproducibility

```bash
npm run cache:report                      # whole corpus
npm run cache:report -- --session 723b6b123f53d69f   # P6-B session
npm run cache:doctor                      # offline health checks
npm run cache:report -- --save p6b-stable-dev
npm run cache:report -- compare p6a-baseline p6b-stable-dev p6c-action-cache
```

Saved reports: `.pi/workbench/cache/reports/{p6a-baseline,p6b-stable-dev,
p6c-action-cache}.json`.
