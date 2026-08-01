# Handoff note template

```markdown
# Handoff: <topic or milestone>

## What changed
- <change> — <file path>
- <change> — <file path>

## How to verify
- <exact command or recipe> → <expected output>
- <test name> — covers <behavior>

## Deliberately not done
- <item> — <why / when it should be done>

## Assumptions and risks
- <assumption> — <consequence if wrong>

## Next steps
- <the next logical step>
```

Rules:

- Write it so someone with no memory of the session can act on it.
- Every verification command must be reproducible (recipe names preferred).
- Keep it short; the changelog carries the public record, this carries the
  working record.
