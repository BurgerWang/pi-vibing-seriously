# DeepSeek Cache Limitations (P6-B)

What the DeepSeek prompt cache can and cannot do, what the workbench
controls, and why no tool can honestly promise a 100% hit rate here.

## The cache is automatic, full-prefix, and best-effort

- DeepSeek's prompt cache is **enabled automatically** for exact-prefix
  reuse. There is nothing to enable, nothing to warm, nothing to pin.
- It is a **full-prefix cache**: only a byte-identical prefix (system
  prompt + tool definitions + message history up to the last cached token)
  is served from cache. Any change anywhere in the prefix — a timestamp in
  the system prompt, a reordered tool, a different thinking level — resets
  the cache for that request.
- It is **best-effort**: the provider decides what to cache, how long to
  keep it, and when to evict it. A cache miss is normal and carries no
  promise that the next identical request will hit.

## What the workbench does NOT do (by design)

The workbench deliberately does none of the following — not because it is
hard, but because each would violate the P5/P6 boundaries or promise
something the provider does not guarantee:

- ❌ No `cache_control`, `prompt_cache_key`, `prompt_cache_retention`,
  TTL or keepalive fields on any request.
- ❌ No warm-up / pre-heat requests.
- ❌ No payload or header mutation (`before_provider_request` is a
  read-only structural peek).
- ❌ No `search_tools`, no dynamic tool loader, no on-demand tool
  activation. DeepSeek is not a Pi-native deferred-tool-loading provider,
  and the workbench does not fake one.
- ❌ No `supportsToolSearch` / `supportsToolReferences` claims anywhere in
  the extension (tested by source scan).
- ❌ No dynamic tool set changes within a mode. Tools are swapped only on
  mode switches, in one `setActiveTools` call.
- ❌ No cache of model answers. Telemetry stores hashes and usage facts
  only; nothing is ever replayed into a prompt.
- ❌ No Recipe Action Cache: recipe results are never cached or reused.
- ❌ No 100% hit-rate guarantee. Anyone promising that is guessing.

## What the workbench DOES control

The workbench controls the **stability of its own side of the prefix**:

- The system prompt is never rewritten per turn (no timestamps, no
  cwd/mode/git/run/cache info appended).
- Tool metadata is static and registered in a fixed order
  (`core/tool-catalog.ts`).
- The active tool set is frozen per mode; mode switches happen once per
  phase (see `cache-efficient-workflow.md`).
- Dynamic facts (time, git, run/gate ids, cache stats) are confined to the
  allowed dynamic channels: TUI status/widget, custom entries, tool
  results, telemetry hashes, and normal chat messages.
- Telemetry measures what actually happened (`cacheRead` vs `input` per
  request) and classifies misses as expected lifecycle events or
  `UNEXPECTED_DRIFT` — it never guesses the provider's internal verdict.

## What the workbench cannot control

- Provider-side eviction, TTL expiry, load-based cache drops, or prefix
  normalization differences between DeepSeek's cache and Pi's request
  serialization.
- Cache behavior after a mode/model/thinking switch, a `/reload`, or a
  compaction — each legitimately starts a new prefix.
- The first request of a session (cold cache by definition).
- What other extensions or the user put into the prompt.

## Practical consequences

- Expect the first request after any lifecycle change to be a full-price
  miss — that is normal and cheap over a long session.
- `cacheWrite` is 0 for DeepSeek (it does not report cache writes); a zero
  `cacheWrite` does NOT mean the cache was not established.
- `/q-cache-report` distinguishes expected invalidations from
  same-mode `UNEXPECTED_DRIFT`; a growing drift count is a signal to fix
  prefix instability, not to add cache-control fields.
- When in doubt, `/q-cache-doctor` shows the current
  systemPromptHash / activeToolNamesHash / activeToolOrderHash /
  activeToolSchemaHash so prefix stability can be checked in seconds.
