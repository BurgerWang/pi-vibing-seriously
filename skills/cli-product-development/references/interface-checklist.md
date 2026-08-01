# Interface checklist

## Flags and arguments

- Short and long forms documented; no ambiguous abbreviations.
- Required vs optional arguments are explicit; missing required arguments
  produce a usage error (message + usage text + non-zero exit), not a crash.
- `--help` exists and documents every flag, its default, and one example.
- `--version` exists when the project has versions.
- Unknown flags are rejected, not silently ignored.

## Streams

- stdout: only the primary output (data, results, rendered output).
- stderr: warnings, progress, diagnostics, errors.
- Never write interactive prompts or progress bars to stdout.
- When output is piped, formatting degrades gracefully (e.g. plain text, no
  control characters).

## Exit codes

- 0 = success. Non-zero = failure.
- Distinct codes for distinct failure classes if the project uses them
  (e.g. 2 = usage error, 1 = runtime failure) — declare the mapping in help
  or README.
- The last error message names the code's meaning in words too.

## Config

- Config sources (flags > env > config file > defaults) — pick one
  precedence, document it, and apply it consistently.
- Config errors are reported with the offending key and file.

## Environment

- No dependence on cwd unless documented; resolve paths relative to
  explicit bases.
- Timezone/locale-independent parsing and formatting unless the tool's
  purpose is locale-aware.
