# P6-C: Deterministic Recipe Action Cache

The Action Cache is an **opt-in, project-local, result-only** cache for
**declared Workbench Recipes**. It maps

```
actionKey -> execution result metadata
```

and (optionally, disabled in this version) `contentHash -> declared output
artifact` in a Content Addressable Store (CAS).

## Hard boundaries

1. Lives entirely inside the existing Pi extension — no daemon, server,
   worker, or standalone CLI.
2. Caches **only declared recipes** — never model answers, patches, audit
   conclusions, planning, natural-language output, or arbitrary bash
   commands.
3. **Disabled by default**. A recipe must explicitly declare
   `cache.enabled: true` in `recipes.yaml`.
4. By default only **successful** results are cached (`successOnly: true`).
5. Never bypasses gate evidence — a cache hit still creates a full run
   record with `executionSource: cache`, and gates re-validate every run
   record exactly as before. A cache record can never make a gate PASS by
   itself.
6. Cache failures **degrade to normal execution** — they never block a task.

## What is cached (result-only mode)

- exit code, duration, expected exit codes, success flag
- the already-redacted **truncated** stdout/stderr views (the same views a
  real run's summary contains; hit runs have no full logs)
- artifact path list, outcome flags (timed out / cancelled)
- key components: hashes only — env values, argv values, and per-file
  content hashes are stored as SHA-256, never as raw values

## What is never cached

- LLM output, patches, audit conclusions, plans, natural-language text
- arbitrary bash commands
- recipe failures (unless `successOnly: false` is declared explicitly)
- network / time / random / external-API recipes (parse-time denial)
- recipes whose declared writes modify source code (parse-time denial)
- raw secret env values (only hashes) and protected secret files (never read)

## The action key

The key is SHA-256 over the canonical form of:

| component | meaning |
|---|---|
| `cacheSchemaVersion` | action-cache schema version |
| `cachePolicyVersion` | policy semantics version |
| `packageVersion` | workbench extension version |
| `recipeName` | the recipe's name |
| `recipeDefinitionHash` | command, cwd, timeout, allowed modes, expected exit codes, writes, artifacts, env names, output strategy, truncation, params |
| `cachePolicyHash` | the recipe's `cache:` block (mode, inputs, outputs, env, toolchain, maxAge, upstream) |
| `argvHash` | normalized argv after parameter substitution |
| `normalizedCwd` | project-relative POSIX cwd |
| `allowedMode` | DEV / VERIFY at run time |
| `environmentHash` | declared env names + SHA-256 of their values ("unset" explicit) |
| `toolchainVersions` | allow-listed version queries; failed probes are the explicit value `"unknown"` |
| `operatingSystem` / `architecture` | platform@release / arch |
| `lockfileHashes` | SHA-256 of the well-known lockfile set at the project root ("missing" explicit) |
| `inputMerkleHash` | recursive Merkle hash of the declared input globs |
| `workbenchConfigHash` | content hash of the workbench config files |
| `profileHash` | the selected profile ("none" explicit) |
| `gateSchemaHash` | the effective gate schema (catalog + gates.yaml, profile-filtered) — gate changes force evidence re-validation |
| `upstreamActionKeys` | action keys of `cache.upstream` recipes |
| `cachePolicyVersion` | cached in every record for validation |

The key **never** depends on git commit, git branch, mtime, file size,
dirty/clean state, or the recipe name alone.

## Input fingerprinting

- paths are project-relative POSIX form; patterns are stable-sorted
- regular files: streaming SHA-256 + executable bit (mtime is never used —
  `touch` keeps the key); size, hash, and final identity come from one
  `O_NOFOLLOW` file descriptor and the pathname must still name that inode
- directories: recursive Merkle hash over sorted children
- symlinks: **every symlink refuses the cache**, including project-local
  links and links in ancestor path components; targets are never followed
  or read by the fingerprint scanner; glob discovery uses the same bounded
  `lstat`/`opendir` walker rather than a symlink-following filesystem glob
- a pattern with **no matches is an explicit key component**
- protected secret paths (`.env`, `*.pem`, `*.key`, `credentials.*`,
  `auth.json`, …) are **never read** — they enter the key as
  `{t: "protected", h: "refused"}` markers
- limits: 5000 total discovered entries (files, directories, protected
  markers, symlink encounters, and missing patterns), 512 MB total regular
  file content, 64 MB per file, depth 64 — overflows fail closed (cache
  refused, normal execution)

## Hit lifecycle

A cache hit **still creates a new run manifest** in `runs/`:

```
runId, recipe, executionSource: "cache", actionKey, reusedFromRunId,
cacheCreatedAt, cacheValidatedAt, exitCode, evidencePaths,
artifactValidation { mode, artifacts_restored, hash_verified, status }
```

plus `execution.json` in the run directory as an explicit cache-source
evidence marker. Gate statuses remain exactly `PASS | FAIL | BLOCKED |
NOT_RUN` — there is no `PASS_CACHED`.

## Concurrency and corruption

- double-checked per-key file lock (owner PID + boot ID + process start
  ticks + createdAt); same-key
  concurrent runs execute once or wait safely
- lock owner JSON is completed and fsynced under a unique name before a
  hard-link atomically publishes the fixed lock name; empty/truncated
  legacy crash residue is recovered only after a stable stale observation
- stale dead owners are removed through a token/inode owner claim while the
  fixed name remains occupied, so a replacement owner is never moved aside;
  PID reuse cannot make a dead owner look live because liveness requires the
  same boot and process-start identity, and unavailable identity fails closed
- action record publication and index commit are one index-mutex transaction;
  lookup holds the same mutex and requires strict index membership, so an
  orphan record from a crash cannot become a hit
- every cache-index RMW (write, touch, prune, clear, rebuild) holds one
  cross-process mutex; the committed index must pass an exact bounded
  readback before acceptance. Dead owners are recovered only by stable
  token+inode claim, while live owners are never removed based on age.
- corrupted action JSON → quarantine + miss
- corrupted index → rebuilt from `actions/` only when the entry/byte-bounded
  scan is complete; overflow refuses the rebuild and never publishes a
  partial index
- CAS reads re-verify the SHA-256; mismatch → quarantine + miss
- prune skips in-use entries and never touches `runs/` or evidence
- clear/prune retain index authority and report failure when a selected
  record cannot be deleted; they never silently claim removal

See `docs/cache/cache-maintenance.md` for the on-disk layout and commands.
