# Risk reporting

Report remaining risk honestly and specifically:

- **Unverified claims** — anything claimed but not checked is listed as
  NOT_RUN with the reason, never as passed.
- **Assumptions** — every assumption you implemented (ambiguous requirement,
  platform behavior, data format) with the consequence if it is wrong.
- **Known limitations** — behavior deliberately not handled, with the
  trigger condition.
- **Environment dependence** — anything that depends on machine, network,
  credentials, or data availability.

Format: a short list, each item with `what / why it matters / what would
resolve it`. A change with zero listed risks is a sign the risk section was
skipped, not that risks do not exist.
