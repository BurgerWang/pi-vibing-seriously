# Cache correctness

## First principles

- **The Action Cache is not a sandbox.** It only decides whether a recipe's
  *result metadata* may be reused for an identical declared action. It does
  not constrain what a recipe can do when it actually executes.
- **A false hit is more dangerous than a miss.** Every design decision in
  this cache errs toward missing: undeclared dependencies, ambiguous
  recipes, malformed records, toolchain failures, and unknown environments
  all refuse the cache and execute normally.
- **Caching is explicit opt-in**, per recipe, and disabled by default.
- **Undeclared dependencies create false-hit risk.** The key can only bind
  what the recipe author declares (`inputs`, `environment`, `toolchain`,
  `upstream`). If a recipe reads a file that is not in `cache.inputs`, the
  cache will happily reuse a stale result when that file changes. Declare
  inputs completely, or don't enable the cache.
- **Recipes you cannot fully model stay uncached.** `check` in this
  repository is deliberately not cached because its outcome depends on git
  working-tree state, which is never part of an action key.
- **The cache cannot replace gates.** A cache hit produces a *new run
  record* that gates validate exactly like an executed run; the only
  difference is `executionSource: "cache"` and that the stdout/stderr logs
  are the cached truncated views. Gates never consult the cache and never
  treat the existence of a record as a pass.
- **LLM answers are never cached.** The Action Cache stores recipe result
  metadata only. Prompt-cache telemetry (P6-A) is a separate, hash-only
  observability feature and never mutates requests.

## Why the key is safe

- Content-addressed: SHA-256 over file *contents* (streamed), not mtime,
  size, git state, or dirty flags. `touch` keeps hitting; a one-byte edit
  misses.
- Every semantic input is bound: recipe definition, argv, cwd, mode,
  declared env values (hashed), toolchain versions, OS/arch, lockfiles,
  declared inputs (Merkle), workbench config, profile, gate schema, and
  upstream keys.
- Gate schema changes invalidate keys, so evidence is re-validated after
  any gate change.
- Missing inputs and glob no-matches are explicit key components: adding a
  previously-absent file changes the key.

## Failure behavior (always safe)

| condition | behavior |
|---|---|
| fingerprint limits exceeded | cache refused → normal execution |
| lockfile exceeds its hash byte bound | cache refused; no shared `too-large` key marker |
| any symlink is encountered | cache refused without following it → normal execution |
| protected secret input matched | never read; `{t:"protected"}` key marker |
| toolchain probe fails/times out | explicit `"unknown"` in the key → miss |
| action record corrupted | quarantine → miss → normal execution |
| CAS hash mismatch | quarantine → miss (restore is disabled anyway in v1) |
| index corrupted | rebuilt only from a complete bounded `actions/` scan |
| index rebuild entry/byte bound exceeded | rebuild refused; no partial index published |
| concurrent cache-index mutations | serialized by one cross-process mutex and exact write readback |
| lock owner crashes during publication | fixed name was never published; complete owner inode is fsynced before hard-link publication |
| stale lock races with replacement owner | token/inode owner claim while fixed remains occupied; replacement is never moved or unconditionally removed |
| owner PID was reused | boot ID + process start ticks distinguish the dead prior process from the current PID instance |
| process-instance identity cannot be read | fail closed; the lock is not removed or newly published |
| record exists without index membership | lookup miss; only an explicit bounded rebuild can recover it |
| clear/prune record deletion fails | operation reports failure and retains that index entry |
| lock wait times out | proceed without lock (best-effort write) |
| record write fails | run already succeeded → reported as `write-failed` |
| maxAge expired | miss → normal execution |

## Known limitations (documented, not silent)

1. **Undeclared runtime dependencies are invisible.** If the recipe reads
   `node_modules` files not pinned by a lockfile, or a file outside the
   declared inputs, the cache cannot detect changes. Declare broadly.
2. **Network heuristics are incomplete.** A script that calls an external
   API from inside `node script.js` is not detectable from argv. The rule
   "network recipes are not cacheable" is enforced for the obvious tokens;
   for everything else it is on the recipe author.
3. **Artifacts restore is disabled in v1** (`ARTIFACT_RESTORE_ENABLED =
   false`). CAS primitives exist and are tested (store, re-verify,
   quarantine) but no file is ever restored from the cache until restore
   passes its own security gate. Artifacts-mode recipes always execute.
4. **Hit runs have no full logs.** Only the truncated, redacted summary
   views are cached; `stdout.log`/`stderr.log` of a cached run contain those
   views, and `manifest.argv` is empty (an `argv_hash` is stored instead).
5. **Cached failures** (only with explicit `successOnly: false`) reproduce
   the failure — including for gates, which fail exactly as they would on a
   real failing run.
6. **Cache writes for the same key are last-writer-wins** when a lock
   times out; records are equivalent by construction (identical key ⇒
   identical declared semantics).
7. **`check`-style chained recipes** are not modeled in v1 (`upstream` keys
   use empty params); when in doubt, leave caching off.

## Verification

- `tests/p6-c-action-key.test.ts` — key components and input fingerprinting
  (27 tests)
- `tests/p6-c-action-cache.test.ts` — store + runner lifecycle, locking,
  corruption, LRU, gate evidence (28 tests)
- bootstrap verification: `typecheck --refresh-cache` → `typecheck` hit →
  touch stays hit → content edit misses → restore re-hits → `--no-cache`
  executes without writing
