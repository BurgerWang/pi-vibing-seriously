# Findings report format

## Classification

| Class | Meaning | Evidence required |
| ----- | ------- | ----------------- |
| confirmed | Directly observed: code path, output, file content | Exact path(s) + line numbers or verbatim output |
| probable | Strongly implied, not directly observed | The evidence you have + what is missing |
| unknown | Cannot determine from available evidence | What would resolve it |

Classification is about evidence, not certainty of judgment. "The code
contains X" is confirmed when you read X. "X causes a production failure" is
probably confirmed only when you observed the failure path.

## Severity

- **high** — breaks core function, data loss, security exposure, or blocks
  the documented use case.
- **medium** — degrades function, affects edge cases, or will bite soon.
- **low** — style, maintainability, minor drift.

Severity is judgment; the classification above it is evidence. Keep the two
separate in the report.

## Report template

```text
Scope     : <paths/commits/claims audited>
Coverage  : <areas checked; areas NOT_RUN>

Findings
--------
[F1] <path>:<line> — <what you observed>
     class    : confirmed | probable | unknown
     severity : high | medium | low
     why      : <one-line justification>
     fix      : <prose suggestion, not applied>

Open questions
--------------
- <question that evidence could not resolve> — <what evidence would resolve it>

Coverage
--------
checked   : <list>
NOT_RUN   : <list with reason>
```
