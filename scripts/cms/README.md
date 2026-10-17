# Staged CMS cutover audit

Run from the source checkout with Python 3 and curl. This makes public GETs;
redirects never send the CMS audit back to the production origin.

```sh
python3 scripts/cms/audit-cutover.py \
  --source https://www.example.com \
  --cms https://marketing.cms.example.com \
  --public-host www.example.com \
  --pages apps/landing/src/pages \
  --assets apps/landing/public \
  --output /tmp/cms-cutover-audit
```

The CMS must support `X-Tedix-Public-Host` for its configured canonical host.
`--source-ip` optionally pins the production origin's address while retaining
TLS hostname validation. No DNS or Worker routes are changed.

The audit inventories source page routes, every non-app sitemap URL, and a
repeatable sample of 200 app URLs from the union of both sitemaps. It checks
slashless variants too. It compares first-response status and Location,
canonical links, hreflang, robots and JSON-LD, and compares complete sitemap
XML trees. Assets are followed only through the configured origins to compare
final bytes. Deployment controls such as `_headers` are excluded from assets.
Warm latency samples alternate origins; both total TTFB and time after TLS are
recorded. HTML weights are decoded bytes, with decimal 250/400 KB budgets.

`audit.json` retains per-URL evidence, discrepancies, weights, asset hashes,
and timings. A finished audit can contain readiness failures; the process
exit code reports collection errors, not a cutover decision. API mutations,
form submissions, browser visual parity, and external schema validation are
outside this script. Keep installation-specific reports outside public Git.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/cms -p 'test_*.py'
```
