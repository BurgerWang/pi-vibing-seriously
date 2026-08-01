# CLI testing

## End-to-end invocation tests

Test the real executable, not just the internal functions:

- Run the built tool with `spawn`-style execution (no shell) so argv is
  exact and output is captured separately.
- Assert three things per case: stdout content, stderr content, exit code.
- Include cases: happy path, `--help`, missing required argument, unknown
  flag, invalid input, empty input, failure path.

## Golden tests

- For deterministic output, keep expected-output fixtures and diff against
  them.
- When output contains volatile data (timestamps, paths), normalize it
  before comparing.

## Error path tests

- Each documented error must have a test that triggers it and asserts the
  message contains the operation and the offending input.
- Assert the non-zero exit code, not just the message.

## Property checks (where feasible)

- Idempotence: running the tool twice on the same input gives the same
  output.
- Round-trip: write → read → write is stable.
