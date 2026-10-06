# Judge calibration fixtures

`judge-gold.json` is a diagnostic fixture for the judge runners in this directory.
It does not establish current model quality.

The `source: production_derived` cases preserve the shape of failures observed in
production. Their claims are clipped historical fragments. Their passages were
rewritten in September 2026 as fictional text to remove third-party scraped
content, while the legacy `goldLabel` values were retained. Those labels have
not been independently re-reviewed against the replacement passages. The
`source: control` cases are synthetic controls.

Use this set to exercise the runner and inspect individual verdicts. For a
quality comparison, collect complete claims and publication-safe passages, have
a human label each exact pair, and keep that reviewed set separate from these
diagnostic cases.
