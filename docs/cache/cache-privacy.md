# Cache Telemetry Privacy (P6-A)

What the prompt-cache telemetry stores, what it never stores, and how the
boundary is enforced and audited.

## Stored data (complete list)

Each record in `telemetry.jsonl` contains exactly the fields of the schema
in `cache-telemetry.md`:

- **Metadata**: schema version, timestamp, extension version, hashed session
  id (SHA-256, first 16 hex chars), provider, model, api kind, thinking
  level, workbench mode, message status.
- **Usage numbers**: input, output, cacheRead, cacheWrite, totalTokens and
  `cost` (= Pi `usage.cost.total`). Numbers only.
- **Hashes**: SHA-256 of the system prompt string; hashes of active tool
  names (set and order); a hash of `{name, description, parameters,
  promptGuidelines}` of the active tools; a hash of the provider payload's
  structural digest (sorted top-level field names, role/type sequence,
  per-text-segment lengths and SHA-256s, tool names).
- **Inference fields**: preceding event, inferred invalidation reason,
  inference confidence.

## Never stored

- system prompt **text**
- provider payload **text** (any part of any message)
- user/assistant/tool message **text**
- tool schema **text** (`parameters`, `description`, `promptGuidelines`
  bodies — only a canonical hash is kept)
- tool arguments / tool results / tool inputs
- file contents, project file lists, absolute paths
- API keys, auth material, `auth.json` contents or references
- full session ids (only the truncated SHA-256)
- environment variable values

## How the boundary is enforced

1. **By construction**: the telemetry modules only ever call `sha256Hex`,
   `canonicalHash` and length functions on text; the payload digest
   (`summarizePayload`) reduces every text segment to `(length, sha256)`
   before anything else happens and keeps the digest in memory only — it is
   never written to disk.
2. **Defense in depth**: `CacheStore.appendRecord` runs a deep
   field-name scan before writing. Records containing any forbidden key
   (`content`, `text`, `message`, `prompt`, `payload`, `apiKey`, `auth`,
   `secret`, `token`, `sessionId`, `cwd`, `env`, `parameters`,
   `toolArguments`, `toolResult`, ...) are **refused** with an error and
   never touch disk. Matching is exact, so `systemPromptHash` is allowed
   while `systemPrompt` is not.
3. **Audited**: `/q-cache-doctor` re-scans every persisted record for
   forbidden fields and reports a `fail` if any are found, and checks the
   current system prompt for dynamic markers (timestamps, run-id,
   current-status) so accidental context instability is visible.

## Interaction with Pi's own storage

- The workbench never reads, writes, or overwrites Pi's `models.json`,
  `models-store.json`, or `auth.json`. Provider configuration and
  credentials remain entirely Pi's.
- The session state entry (`workbench-cache-state`) holds only counts,
  aggregates, hashes and one file reference — no text, no arrays of
  messages.

## Trust and opt-out

- Telemetry is written only for **trusted** projects, after the project
  trust check; untrusted projects are never touched.
- `cache: { telemetry: false }` in `project.yaml` disables recording.
- `telemetry.jsonl` and its archives are gitignored; existing user
  `.gitignore` rules are never overwritten.
- Files are created with user-only permissions (`0o600`/`0o700`).

## Threat model note

Hashes are one-way digests, but a SHA-256 of a short, guessable string
(e.g. a system prompt fragment) is in principle subject to dictionary
attacks. The telemetry stores hashes of the full system prompt and full
segments, not fragments, and the records live on the user's own disk with
user-only permissions. If this residual risk is unacceptable for a
project, disable telemetry with `cache.telemetry: false`.
