# OS first-load measurements — 17 October 2026

Baseline: `8dcb2206a582f8d00bf286a7294fedc67fde5256`.
Measured application source: `848a87e134aa584c8d07a4716bccfeb81ecd6696`.
The accompanying report commit changes only measurement artifacts.

Production Vite builds, served locally against the same deterministic fixture API.
Five fresh Chromium contexts per route, disabled cache, 4× CPU slowdown, 40 ms
latency, 10 Mbit/s download, 1440×1000 viewport. Runs were sequential, after tests.
“Useful paint” means the target content is visible, followed by two animation
frames: a Workspace description, an actionable Needs you question, or Card
review's **Not useful** button. It is a task-specific measure, not browser FCP.

JavaScript totals include every script response in the first eight seconds,
including shared dependencies and preloads. Sizes are decoded bytes and a
normalized gzip estimate, not actual compressed network transfer. The local
asset server does not compress responses. Values below use decimal kB and median
timings. [Sample results](first-load-performance.results.json) contain every timing.

| Route                      |       JS kB before → after |   Gzip kB before → after | Useful paint before → after | API attempts before → after |
| -------------------------- | -------------------------: | -----------------------: | --------------------------: | --------------------------: |
| Workspaces                 | 2,172.8 → 1,716.5 (−21.0%) |   712.7 → 571.7 (−19.8%) |     2.941 → 2.891 s (−1.7%) |                     15 → 15 |
| Work → Needs you           |  2,119.4 → 2,064.6 (−2.6%) |    694.6 → 680.4 (−2.0%) |    5.973 → 2.908 s (−51.3%) |            21 → 18 (−14.3%) |
| Workspace with Card review | 3,832.9 → 2,766.2 (−27.8%) | 1,216.8 → 896.3 (−26.3%) |    4.524 → 3.907 s (−13.6%) |                     21 → 21 |

## Retained changes

- Route splitting: move Work URL validators into a small library and the date
  helper into the existing time library. Importing them from page modules kept
  those pages in the eager graph despite automatic route splitting. The entry
  chunk drops from 684.72 to 343.53 kB (49.8%); Workspaces loads 21.0% less JS.
  Its useful-paint change is below 10% and is not counted as a timing win.
- Editor loading: defer document, sheet, slides and video implementations until
  their output type opens. The sheet/slides chunks are 59.37/57.07 kB before
  shared dependencies. Card review requests none of the three editor chunks.
  Separate Playwright checks open sheet and slides editing successfully; each
  requests its own editor and does not request the other editors.
- Shared query loading: apply the existing approval no-retry policy to prefetch
  as well as the mounted views, and prevent immediate retries on remount.
  Keep supplementary fleet pressure in flight while personal requests render,
  letting the page share that read. Needs you approval attempts drop 4 → 1;
  fleet attempts drop 5 → 3. Explicit invalidation still refetches failed data.

The fixture API lacks handlers for readiness, profile, Work approvals, fleet
pressure and session requests. These return 404 in both builds. The query counts
include these failed attempts: this proves retry-path savings, not a 14% reduction
for a healthy production API. No successful duplicate initial requests were
observed. The timing gain includes avoiding a failed fleet read's retry delay.
No new fixture data or API responses were fabricated for the measurement.

## Public live reference

Fresh, read-only Playwright contexts opened `https://tedix.os.tedix.dev`, which
redirected to the public launcher sign-in page. No saved profile, session or
`tedix login` was used. The initial and final checks loaded identical script
assets: 1,934.8 kB decoded / 632.0 kB normalized gzip. Median useful paint was
2.595 s initially and 2.628 s on recheck (noise, not an improvement).
There were no page errors or API failures in this journey.

These local improvements were not live-verified as deployed. Authenticated Cloud
Workspaces, Needs you and Card review were not accessed.

## Reproduce

Run from the repository root. Use another free port if 3010 is occupied, as it
was during this measurement (the fixture server used 3117).

```sh
bun run --cwd apps/os dev
```

In another terminal, build and measure the production SPA with fixture APIs:

```sh
TEDIX_BUILD_LOCAL_DEMO_ENABLED=true bun run --cwd apps/os build
PERF_ORIGIN=http://127.0.0.1:3120 \
PERF_FIXTURES_ORIGIN=http://127.0.0.1:3010 \
PERF_ASSETS_ROOT=apps/os/.cloudflare/output/v0/workers/default/assets \
PERF_OUTPUT=/tmp/os-first-load.json \
bun apps/os/browser-tests/first-load-performance.ts
bun apps/os/browser-tests/first-load-performance.ts --live
```

Omit `PERF_ASSETS_ROOT` to measure the fixture development server directly.
Rebuild each revision in an isolated checkout with its frozen lockfile. The
fixture API, server settings and browser conditions must match across revisions.

Validation on the measured source: `apps/os type-check`, `apps/os test:run`
(3,683 browser-side tests and 11 Worker tests), `lint:repo` (13 gates), production
build, changed-file formatting and Playwright editor smoke checks.
