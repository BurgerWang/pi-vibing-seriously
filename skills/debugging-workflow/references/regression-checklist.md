# Regression checklist

After a root-cause fix, verify in this order:

1. **Original repro** — the exact failing command now passes; keep the
   output as evidence.
2. **Minimal repro** — the reduced case still passes (guards against
   over-fitting the fix to one scenario).
3. **Adjacent behavior** — tests covering the module/area around the fix.
4. **Risk-proportionate boundary** — add typecheck, integration tests, or the
   full suite only when the changed boundary or requested gate requires it.
5. **New regression test** — if the fix has no test that failed before the
   fix, add one. A fix without a failing-test artifact is unproven.

## Anti-regression rules

- Do not delete or disable the test that caught the bug.
- Do not silence the error (empty catch, `# noqa`, suppressed warning)
  unless the root cause is fixed and the suppression is documented.
- If the fix changes public behavior, update the contract and docs in the
  same change.

## Evidence format

```text
repro before : <command> → <original error>          (saved)
repro after  : <command> → exit 0                    (saved)
new test     : <test name> fails before fix / passes after
final scope  : <focused/typecheck/integration/full gate> → <counts>
```
