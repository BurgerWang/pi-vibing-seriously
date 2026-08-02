# Cache maintenance

## On-disk layout

```
<project-root>/.pi/workbench/cache/
├── actions/            action records — one JSON file per action key
├── cas/                content-addressable artifacts (v1: restore disabled)
│   └── quarantine/     CAS content that failed hash verification
├── locks/              per-key execution locks (owner PID + createdAt)
├── tmp/                staging for atomic writes + quarantined corrupt records
└── cache-index.json    LRU/space accounting (rebuildable from actions/)
```

- project-trusted and project-local — never shared across projects
- runtime cache is gitignored (`.pi/workbench/cache/`)
- `runs/` and evidence are **never** deleted by any maintenance command

## Commands

### `/q-run <recipe> [key=value ...] [--no-cache|--refresh-cache]`

- default: compute the action key → try the cache → hit: validate and
  reuse (new run manifest, `executionSource: cache`); miss: execute, write
  on success
- `--no-cache`: neither read nor write
- `--refresh-cache`: never read; execute and (re)write on success

The same modes are available on the `workbench_run_recipe` tool via the
`cache` parameter (`default | no-cache | refresh-cache`).

### `/q-cache-explain <recipe>`

Shows:

- the current action key and hit/miss state
- the key component summary (definition, argv, cwd, mode, environment
  names, toolchain versions, OS/arch, lockfiles, declared-input Merkle hash
  + counts, config, profile, gate schema, upstream keys)
- change classification against the newest stored record for the recipe
  (changed/added/removed inputs with up to 10 file names; toolchain/config/
  env/gate-schema differences)

Never prints secrets, argv values, or per-file hashes by default.

### `/q-cache-prune [--apply]`

- dry-run by default: shows reclaimable space and the LRU candidates
- `--apply` requires confirmation (dialog, or the literal `yes` in
  print/json mode)
- removes oldest-by-`lastUsedAt` records until the configured budget is
  met; entries with a fresh lock are skipped (in use)
- never deletes `runs/`, evidence, telemetry or reports

Budget: `project.yaml` → `cache: { actionCache: { maxBytes: N } }`
(default 256 MB).

### `/q-cache-clear <recipe|all>`

- one recipe: confirmation; `all`: double confirmation
- removes action records + their locks and index entries — run history is
  untouched

## Locks and recovery

- lock files carry `{key, token, ownerPid, createdAt}`
- a lock whose owner process is alive is never considered stale (breaking
  it would double-execute a running recipe)
- a dead/unknown-owner lock older than `LOCK_STALE_MS` (60 s) is broken;
  waiters poll every 100 ms up to 120 s, then proceed without the lock
  (cache writes become best-effort — never a task blocker)
- interrupted temp writes never produce a valid record (tmp + atomic
  rename)

## Corruption handling

| symptom | behavior |
|---|---|
| action JSON unparseable / key mismatch | quarantine to `tmp/corrupt-*`, treated as a miss |
| `cache-index.json` corrupted | rebuilt by scanning `actions/` |
| CAS content hash mismatch on read | moved to `cas/quarantine/`, treated as a miss |
| prune during a run | in-use keys (fresh lock) are skipped |

## Diagnostics

- `/q-cache-explain` — per-recipe key + hit/miss + change classification
- `cache-index.json` + the `actions/` directory — full inventory
- action records carry `schemaVersion`, `actionKey`, `sourceRunId`,
  `createdAt`, all key components and the cached summary; run manifests of
  hits carry `execution_source: "cache"` and `reused_from_run_id`
