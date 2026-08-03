# DeepSeek Prompt Caching and Pi

How prompt caching behaves in this setup, what the workbench observes, and
what it deliberately does not control. Read this before interpreting any
cache number from `/q-cache-status`, `/q-cache-report`, or the footer.

## Environment (confirmed)

- Provider: Pi's built-in **deepseek** provider (no custom `models.json`).
- Model: `deepseek-v4-flash` (and `deepseek-v4-pro` in the same catalog).
- Credentials: managed by Pi's `auth.json` — the workbench never reads,
  modifies, or records it, and it does not depend on a `DEEPSEEK_API_KEY`
  environment variable.
- API kind: Pi 0.83.0 registers deepseek as `openai-completions` (Chat
  Completions compatible, `https://api.deepseek.com`).

## DeepSeek's cache is automatic

DeepSeek's prompt cache is **enabled automatically by the provider** for
exact-prefix context reuse. There is nothing to enable:

- The workbench does **not** add `cache_control`, `prompt_cache_key`,
  `prompt_cache_retention`, TTL, or keepalive fields to any request.
- The workbench does **not** send warm-up (pre-heat) requests.
- The workbench does **not** modify the provider payload or request headers
  (`before_provider_request` is a read-only structural peek).
- Caching is **best-effort**: a cache miss is normal and carries no promise
  that the next identical request will hit. DeepSeek decides what to cache,
  for how long, and when to evict.

The workbench therefore **does not control the TTL** and does not claim to.

## How DeepSeek reports usage (Chat Completions)

DeepSeek's Chat Completions usage reports cache hits and misses separately:

```jsonc
{
  "prompt_tokens": 50000,            // hit + miss
  "prompt_cache_hit_tokens": 40000,  // served from cache
  "prompt_cache_miss_tokens": 10000, // billed at the uncached input rate
  "completion_tokens": 2000
}
```

Pi's `openai-completions` adapter normalizes this to its standard usage
shape (verified in the installed Pi 0.83.0 source):

| Pi normalized field | Meaning for DeepSeek |
| ------------------- | -------------------- |
| `usage.input`       | un-cached input = `prompt_cache_miss_tokens` |
| `usage.cacheRead`   | cache-hit input = `prompt_cache_hit_tokens` |
| `usage.cacheWrite`  | 0 — DeepSeek does not report cache writes |
| `usage.output`      | `completion_tokens` |
| `usage.totalTokens` | `input + output + cacheRead + cacheWrite` |
| `usage.cost.*`      | computed by Pi from the model registry rates (USD per 1M tokens) |

**`cacheWrite = 0` is not an error and does not mean the cache was not
established.** DeepSeek simply does not bill cache writes.

## The workbench's usage mapping conclusion (P6-A)

- The workbench reads the **normalized** usage on the assistant message at
  `message_end` — it never parses the raw HTTP response.
- For the api kinds verified in the installed Pi source
  (`openai-completions`, `openai-responses`, `azure-openai-responses`,
  `openai-codex-responses`, `anthropic-messages`), `usage.input` is
  confirmed to be the **un-cached** portion of the input, so the hit ratio
  is:

  ```
  cacheHitRatio = cacheRead / (input + cacheRead)
  ```

  `openai-codex-responses` (Pi's Codex provider — the GPT-5.6 Sol
  commander) streams through the same `openai-responses-shared`
  `finalizeResponse` normalization as `openai-responses`, so its
  `usage.input`/`usage.cacheRead` semantics are identical and the Sol
  session gets a numeric `CACHE` footer instead of `CACHE N/A`.

- For any other api kind the normalized usage is kept, `cacheHitRatio` is
  `null`, and the record's `usageSemanticStatus` is `unverified`/`partial`
  — the workbench never guesses.
- **Actual cost is `usage.cost.total`** as computed by Pi from the model
  registry — the workbench stores that number as the cost fact and never
  hardcodes DeepSeek prices.
- Estimated avoided cost (`/q-cache-report`) is computed only when the model
  registry provides a compatible `cacheRead` rate for every record involved
  (same USD-per-1M-token rates Pi itself uses); otherwise it is `null`.

## What the workbench infers

Invalidations (`inferredInvalidationReason`) are **workbench inferences**
about why the cache likely missed — never DeepSeek's internal verdict, which
is not exposed. Classification uses explicit Pi events (model/thinking/mode
changes, reload, compaction, new session) and hash diffs (system prompt,
tool set/order/schema, payload shape).

- Expected invalidations: mode switch, model switch, thinking-level switch,
  package reload, new session, compaction, provider-side best-effort miss.
- Unexpected drift: system prompt, tool set/order/schema, or context prefix
  changed within the same mode — a sign the context is not stable enough
  for caching.

## Status and limits (P6-A / P6-B)

- P6-A adds **observability only**. P6-B adds the **stable-prefix contract**
  (docs/cache/stable-prefix-contract.md): deterministic tool registration,
  fixed per-mode tool matrices, sorted resource discovery, and the
  `UNEXPECTED_DRIFT` classification for same-mode drift. There is **no
  Recipe Action Cache**: recipe results are never cached or reused from a
  cache.
- Provider-side limits are documented in
  docs/cache/deepseek-cache-limitations.md (automatic, full-prefix,
  best-effort — no cache_control/TTL/warm-up, no 100% hit guarantee);
  workflow rules in docs/cache/cache-efficient-workflow.md.
- Telemetry is per-project, append-only, hash-only, and can be disabled with
  `cache.telemetry: false` in `project.yaml`.
- See `cache-telemetry.md` for the record schema and `cache-privacy.md` for
  what is never stored.
