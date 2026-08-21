---
name: market-data-integrity
description: Explicit specialist for validating market data. Load from quant-research-design when point-in-time availability, survivorship, identifiers, adjustments, timestamps, or missing records affect the claim.
disable-model-invocation: true
---

# Market Data Integrity

Verify the dataset before trusting modeling or backtest output.

Check point-in-time availability, survivorship and delisting, corporate
actions and adjustments, missing or duplicate records, timestamps/calendars,
and stable identifier mappings. Record assumptions and the impact of anything
that cannot be validated; do not silently treat unknown data quality as clean.

## Conditional references

- Use [references/data-integrity-checklist.md](references/data-integrity-checklist.md)
  for a formal dataset audit.
- Use [references/adjustments-and-delisting.md](references/adjustments-and-delisting.md)
  only for corporate-action or delisting semantics.
- Route observed backtest consequences to `skill:backtest-integrity`.
