# Selection checklist

## Universe (point-in-time)

- [ ] Universe membership is recorded per date (a table of
      membership-as-of, not today's list).
- [ ] IPO/listing dates respected: a name is only tradable after its
      listing.
- [ ] Delisted names stay in the history with a final record; delisting
      return rule applied (see `skill:market-data-integrity`).
- [ ] Filter rules (liquidity, price, size) are point-in-time and documented.

## Survivorship and corporate actions

- [ ] No survivorship bias: today's constituents must not be the only
      history.
- [ ] Corporate actions (splits, dividends, spinoffs) handled consistently
      in prices and shares (see `skill:market-data-integrity`).
- [ ] Suspended names: trading rule defined (skip, carry, force-exit).

## Cross-sectional features

- [ ] Every feature defined with its exact computation and its data-as-of
      timestamp.
- [ ] Features use only point-in-time data (no restated fundamentals, no
      future values).
- [ ] Winsorization/outlier handling documented; look-ahead-free by
      construction (cross-sectional stats computed per date from that
      date's data).
- [ ] Missing feature values: imputation or exclusion rule defined and
      applied identically in research and production logic.

## Ranking and grouping

- [ ] Rank direction defined (higher score = higher rank?) and stable.
- [ ] Group count and membership defined before results are seen.
- [ ] Ties and equal scores: deterministic ordering rule.
- [ ] Group sizes reported (a collapsing top group signals data issues).

## Exposure control

- [ ] Industry and market-cap exposure of portfolio vs benchmark measured
      at every rebalance.
- [ ] Neutralization (or its absence) is a documented choice, not an
      accident.
- [ ] Factor correlations reported for multi-feature scores.

## Portfolio and rebalance

- [ ] Weighting rule defined (equal / score-weighted / cap-weighted).
- [ ] Position caps (max weight per name) and the cash rule defined.
- [ ] Rebalance calendar defined; the rebalance executes at the defined
      timestamp with the defined price convention.
- [ ] Turnover measured per rebalance and cumulatively, with cost impact.

## Benchmark

- [ ] Benchmark defined, investable at the same frequency, and aligned to
      the same periods.
- [ ] Strategy and benchmark use the same return convention (total return
      vs price return) and cost treatment where applicable.

## Attribution

- [ ] Return attribution separates selection effect, exposure effect
      (industry/size), and timing effect (see references/attribution.md).
- [ ] Attribution sums to the reported excess return (reconciliation
      check).
