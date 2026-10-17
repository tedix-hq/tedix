# Needs you cold-load measurements — 17 October 2026

Baseline: `f011e9616e4b9ad4134e1698eac2e9566df624b6`.
Measured OS implementation: `e39e1327ccc0ff5d5b72109e611f9e5b3aa8e675`.
The final report update changes only these measurement artifacts.
[Samples and API timings](needs-you-performance.results.json) contain the receipts.

Five fresh Chromium contexts per gzip build, cache disabled, 4× CPU slowdown,
40 ms latency, 10 Mbit/s download, 1440×1000 viewport. Both production Vite
builds use the same fixture API. Tests finished before the measurement runs.

| Measure                                                  |          Before |           After |
| -------------------------------------------------------- | --------------: | --------------: |
| Browser useful paint, gzip assets, median                |         1.991 s |         1.188 s |
| Browser useful paint, gzip assets, range                 |   1.960–2.023 s |   1.181–1.268 s |
| Existing Playwright elapsed measure, gzip assets, median |         2.024 s |         1.508 s |
| Existing Playwright elapsed measure, raw assets, median  |         2.926 s |         2.067 s |
| Script requests within eight seconds                     |             179 |              71 |
| Decoded JavaScript                                       | 2,064,623 bytes | 1,577,955 bytes |
| Normalized gzip JavaScript                               |   680,440 bytes |   506,664 bytes |
| API attempts within eight seconds                        |              18 |              18 |

The 1.5 s useful-paint budget passes in all five gzip samples. The original
uncompressed fixture protocol remains above 1.5 s, at 2.067 s after the change
(three raw samples per revision). Compression and code improvements are separate:
the gzip comparison rebuilds **both** revisions with identical delivery settings.
Live OS asset responses advertise `Content-Encoding: gzip`.

Useful paint is the actionable question “Tests pass. Push the retry fix to main?”
being visible, followed by two animation frames. A browser MutationObserver
records this mark directly in both builds. The existing host-side locator wait
and two-frame elapsed measure is retained separately; it also includes the
host's polling and command delay. This is a task-specific measure, not browser FCP.

## API path

| Source                                             | Initial calls per cold page | Loading behavior                                                                    |
| -------------------------------------------------- | --------------------------: | ----------------------------------------------------------------------------------- |
| `workInteractions.listInbox`                       |                           1 | Starts in the loader; ready questions render independently.                         |
| `workApprovals.listInbox`                          |                           1 | Shares its generated key with the sidebar; pending decisions do not hide questions. |
| `tediApprovals.list`                               |                           1 | Shares the notification/sidebar read; ready approvals can render first.             |
| `workAgentSessions.listRequests` (“Your requests”) |                           1 | Starts alongside the inbox, using the page/sidebar key and shared retry policy.     |
| Work title lookups                                 |    0 separate browser calls | The inbox already returns Work titles and quoted references.                        |

The title enrichment in `apps/api/src/rpc/routers/work-interactions.ts` already
collects quoted short IDs and calls `listWorkItemTitlesByShortIds` once for the
page, in parallel with tedi display names. No browser title waterfall was found.
The D1 statements, authorization fences and result schemas are unchanged.

For the first gzip sample, inbox delivery moved from 543–1754 ms to 513–1033 ms.
The request ledger moved from 1974–2032 ms to 513–1029 ms. These are browser
resource timings, including client-side connection/transfer contention; they do
not measure isolated server or D1 execution time.

This uses incremental client rendering over the existing queries. It adds no
aggregate endpoint or second cache namespace. The loader starts independent
reads without awaiting every result; the page shows available rows while remaining
sources load. Loading and partial failures cannot report a fully empty inbox.

The fixture lacks Work approvals, request ledger, fleet, readiness and profile
handlers. Both revisions record 11 failed attempts within the eight-second
window. Healthy production API latency and ledger contents remain unmeasured.
The total API count is unchanged; the gain comes from earlier reads, incremental
rendering, smaller dependencies and fewer script-loading waves.

## Retained source changes

- Move display helpers out of the Office, Portfolio and Work operations page
  modules, so Needs you no longer loads those pages and their markdown/forms.
- Load the login form and search palette when opened, and register the Work
  browser tools from their own lazy component.
- Group bootstrap code and frequently reused Kumo/icon modules in the client
  build. Preserve lazy route/editor boundaries and strict execution order.
- Start the request ledger with the inbox; share its no-retry/remount policy
  between prefetch and mounted readers. Polling and invalidation still work.

Playwright also opened Workspaces and Card review, opened and closed the lazy
search palette, and opened sheet and slides editing. No page errors occurred.
Each editor requested its own implementation and the shared toolbar.

## Live read-only reference

Three fresh Playwright contexts opened the exact live `/work/needs-you` URL.
They reached public sign-in; median elapsed paint was 2.090 s, with zero API
attempts or page errors. `/health` reported deployed SHA
`f011e9616e4b9ad4134e1698eac2e9566df624b6` before the push. No login was run.
Authenticated Needs you timing and deployment of this change are unverified.

## Validation

- `bun run --cwd apps/os type-check`
- `bun run --cwd apps/os test:run`: 3,685 browser-side tests and 11 Worker tests passed.
- `bun run --cwd apps/api type-check`
- `bun run --cwd apps/api test:run`: 7,282 tests passed; two tests and one file skipped; lazy import boundary check passed.
- `bun run lint:repo`: all 13 gates passed.
- `bun run docs:public:check` and `bun run scan:secrets` passed.
- Changed-file formatting, production fixture build and Playwright checks passed.

## Reproduce

Use free ports and an isolated checkout for each revision, with its frozen lockfile.
Start the fixture server with `bun run --cwd apps/os dev:fixtures --port 3189 --host 127.0.0.1`.

```sh
TEDIX_BUILD_LOCAL_DEMO_ENABLED=true bun run --cwd apps/os build
PERF_TARGET='Needs you' PERF_COMPRESS=1 PERF_SAMPLES=5 \
PERF_ORIGIN=http://127.0.0.1:3204 \
PERF_FIXTURES_ORIGIN=http://127.0.0.1:3189 \
PERF_ASSETS_ROOT=apps/os/.cloudflare/output/v0/workers/default/assets \
PERF_OUTPUT=/tmp/needs-you.json \
bun apps/os/browser-tests/first-load-performance.ts
```

Omit `PERF_COMPRESS` to repeat the original raw-asset protocol. Use the same
updated harness against each revision's assets. For the public live reference:

```sh
PERF_LIVE_URL=https://tedix.os.tedix.dev/work/needs-you PERF_SAMPLES=3 \
bun apps/os/browser-tests/first-load-performance.ts --live
```
